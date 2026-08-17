#!/usr/bin/env bash
set -euo pipefail

RUNNER="$(cd "$(dirname "$0")" && pwd)/run-quality-gates.sh"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/quality-gate-binding.XXXXXX")"
REPO="$TEMP_ROOT/repo"
MOCK_BIN="$TEMP_ROOT/bin"
RESULTS="$TEMP_ROOT/results"
RECORDS="$TEMP_ROOT/records"

cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

mkdir -p "$REPO/packages/contracts/src" "$REPO/packages/contracts/test" "$MOCK_BIN" "$RECORDS"
git -C "$REPO" init -q
git -C "$REPO" config user.name test
git -C "$REPO" config user.email test@example.invalid

printf 'old tree\n' > "$REPO/packages/contracts/src/EscrowTree.sol"
printf 'old factory\n' > "$REPO/packages/contracts/src/EscrowTreeFactory.sol"
printf 'placeholder\n' > "$REPO/packages/contracts/test/EscrowTreeHalmos.t.sol"
git -C "$REPO" add packages
git -C "$REPO" commit -qm old
TARGET_REVISION="$(git -C "$REPO" rev-parse HEAD)"

printf 'new tree\n' > "$REPO/packages/contracts/src/EscrowTree.sol"
printf 'new factory\n' > "$REPO/packages/contracts/src/EscrowTreeFactory.sol"
git -C "$REPO" add packages
git -C "$REPO" commit -qm new

cat > "$MOCK_BIN/halmos" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  printf 'halmos 0.3.3\n'
  exit 0
fi
pwd > "$MOCK_RECORDS/halmos-pwd"
cat src/EscrowTree.sol > "$MOCK_RECORDS/halmos-source"
printf 'mock halmos pass\n'
EOF

cat > "$MOCK_BIN/gambit" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
filename=""
outdir=""
while (($#)); do
  case "$1" in
    --filename) filename="$2"; shift 2 ;;
    --outdir) outdir="$2"; shift 2 ;;
    *) shift ;;
  esac
done
basename="$(basename "$filename")"
cat "$filename" > "$MOCK_RECORDS/gambit-$basename"
mkdir -p "$outdir/mutants/1/$(dirname "$filename")"
cp "$filename" "$outdir/mutants/1/$filename"
EOF

cat > "$MOCK_BIN/solc" <<'EOF'
#!/usr/bin/env bash
printf 'Version: 0.8.28+commit.7893614a\n'
EOF

cat > "$MOCK_BIN/forge" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$MOCK_BIN/halmos" "$MOCK_BIN/gambit" "$MOCK_BIN/solc" "$MOCK_BIN/forge"

halmos_sha="$(shasum -a 256 "$MOCK_BIN/halmos" | awk '{print $1}')"
gambit_sha="$(shasum -a 256 "$MOCK_BIN/gambit" | awk '{print $1}')"
solc_sha="$(shasum -a 256 "$MOCK_BIN/solc" | awk '{print $1}')"

(
  cd "$REPO"
  MOCK_RECORDS="$RECORDS" \
    PATH="$MOCK_BIN:$PATH" \
    HALMOS_BIN="$MOCK_BIN/halmos" \
    GAMBIT_BIN="$MOCK_BIN/gambit" \
    SOLC_BIN="$MOCK_BIN/solc" \
    HALMOS_SHA256="$halmos_sha" \
    GAMBIT_SHA256="$gambit_sha" \
    SOLC_SHA256="$solc_sha" \
    QUALITY_RESULTS_DIR="$RESULTS" \
    QUALITY_REVISION="$TARGET_REVISION" \
    MUTATION_WORKERS=1 \
    "$RUNNER"
)

[[ "$(cat "$RECORDS/halmos-source")" == "old tree" ]] || exit 1
[[ "$(cat "$RECORDS/gambit-EscrowTree.sol")" == "old tree" ]] || exit 1
[[ "$(cat "$RECORDS/gambit-EscrowTreeFactory.sol")" == "old factory" ]] || exit 1
grep -Fxq "revision=$TARGET_REVISION" "$RESULTS/mutation-summary.txt" || exit 1
