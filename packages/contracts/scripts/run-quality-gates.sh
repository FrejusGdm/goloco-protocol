#!/usr/bin/env bash
set -euo pipefail

# Requires Halmos 0.3.3, Gambit 1.0.6, Solc 0.8.28, Foundry, git, and shasum.
# The caller supplies exact binary paths so no ambient tool on PATH can change
# the proof or mutation campaign.

REPO_ROOT="$(git rev-parse --show-toplevel)"
REVISION="${QUALITY_REVISION:-HEAD}"
RESOLVED_REVISION="$(git -C "$REPO_ROOT" rev-parse "$REVISION^{commit}")"
RESULTS_DIR="${QUALITY_RESULTS_DIR:?set QUALITY_RESULTS_DIR to an external output directory}"
HALMOS_BIN="${HALMOS_BIN:?set HALMOS_BIN to Halmos 0.3.3}"
GAMBIT_BIN="${GAMBIT_BIN:?set GAMBIT_BIN to Gambit 1.0.6}"
SOLC_BIN="${SOLC_BIN:?set SOLC_BIN to Solc 0.8.28}"
HALMOS_SHA256="${HALMOS_SHA256:-b1fa1bc9b0309e2b91973ac85037db7cc7bc433fb2532b956921a9f97d0007b1}"
GAMBIT_SHA256="${GAMBIT_SHA256:-cf8b48e9dad8d10fa2ea7c5a4497fa3eda17eac2d77c653c2699872484aa1a01}"
SOLC_SHA256="${SOLC_SHA256:-81515b0e53deaa266d549545ccaac0a5a96e6d4e8201c77f673b2c710976d9ea}"
WORKERS="${MUTATION_WORKERS:-4}"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/goloco-mutation.XXXXXX")"
TARGET_WORKTREE="$SCRATCH/target"

cleanup() {
  if [[ -d "$TARGET_WORKTREE" ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$TARGET_WORKTREE" >/dev/null 2>&1 || true
  fi
  git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

verify_sha256() {
  local binary="$1"
  local expected="$2"
  local actual
  actual="$(shasum -a 256 "$binary" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    printf 'tool checksum mismatch for %s: expected %s, got %s\n' "$binary" "$expected" "$actual" >&2
    exit 1
  fi
}

verify_sha256 "$HALMOS_BIN" "$HALMOS_SHA256"
verify_sha256 "$GAMBIT_BIN" "$GAMBIT_SHA256"
verify_sha256 "$SOLC_BIN" "$SOLC_SHA256"
[[ "$($HALMOS_BIN --version)" == "halmos 0.3.3" ]]
"$SOLC_BIN" --version | grep -Fq 'Version: 0.8.28+commit.7893614a'

mkdir -p "$RESULTS_DIR" "$SCRATCH/mutants" "$SCRATCH/results"
git -C "$REPO_ROOT" worktree add --detach "$TARGET_WORKTREE" "$RESOLVED_REVISION" >/dev/null

(
  cd "$TARGET_WORKTREE/packages/contracts"
  "$HALMOS_BIN" --match-contract '.*Halmos.*' --solver z3 \
    --solver-timeout-assertion 120s --statistics --verbose
) | tee "$RESULTS_DIR/halmos.txt"

mutate_source() {
  local label="$1"
  local source="$2"
  (
    cd "$TARGET_WORKTREE"
    "$GAMBIT_BIN" mutate --filename "$source" --sourceroot "$TARGET_WORKTREE" \
    --outdir "$SCRATCH/mutants/$label" --solc "$SOLC_BIN" --skip_validate
  )
}

run_shard() {
  local label="$1"
  local source="$2"
  local start="$3"
  local end="$4"
  local shard="$5"
  local worktree="$SCRATCH/worktree-$label-$shard"
  local original="$TARGET_WORKTREE/$source"
  local output="$SCRATCH/results/$label-$shard.tsv"

  git -C "$REPO_ROOT" worktree add --detach "$worktree" "$RESOLVED_REVISION" >/dev/null
  : > "$output"
  for ((id = start; id <= end; id += 1)); do
    local mutant="$SCRATCH/mutants/$label/mutants/$id/$source"
    [[ -f "$mutant" ]] || continue
    cp "$mutant" "$worktree/$source"
    if (cd "$worktree/packages/contracts" && forge test -q) >/dev/null 2>&1; then
      printf '%s\t%s\tsurvived\n' "$label" "$id" >> "$output"
    else
      printf '%s\t%s\tkilled\n' "$label" "$id" >> "$output"
    fi
    cp "$original" "$worktree/$source"
  done
  git -C "$REPO_ROOT" worktree remove --force "$worktree" >/dev/null
}

test_mutants() {
  local label="$1"
  local source="$2"
  local total
  total="$(find "$SCRATCH/mutants/$label/mutants" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  local shard_size=$(((total + WORKERS - 1) / WORKERS))
  local shard
  for ((shard = 0; shard < WORKERS; shard += 1)); do
    local start=$((shard * shard_size + 1))
    local end=$(((shard + 1) * shard_size))
    ((end > total)) && end="$total"
    ((start > total)) && break
    run_shard "$label" "$source" "$start" "$end" "$shard" &
  done
  wait
}

mutate_source tree packages/contracts/src/EscrowTree.sol
mutate_source factory packages/contracts/src/EscrowTreeFactory.sol
test_mutants tree packages/contracts/src/EscrowTree.sol
test_mutants factory packages/contracts/src/EscrowTreeFactory.sol

cat "$SCRATCH"/results/*.tsv | sort -t $'\t' -k1,1 -k2,2n > "$RESULTS_DIR/mutation-results.tsv"
total="$(wc -l < "$RESULTS_DIR/mutation-results.tsv" | tr -d ' ')"
killed="$(awk -F $'\t' '$3 == "killed" { count += 1 } END { print count + 0 }' "$RESULTS_DIR/mutation-results.tsv")"
survived="$((total - killed))"
score="$(awk -v killed="$killed" -v total="$total" 'BEGIN { printf "%.2f", 100 * killed / total }')"
printf 'revision=%s\ntotal=%s\nkilled=%s\nsurvived=%s\nmutation_score=%s%%\n' \
  "$(git -C "$TARGET_WORKTREE" rev-parse HEAD)" "$total" "$killed" "$survived" "$score" \
  | tee "$RESULTS_DIR/mutation-summary.txt"
