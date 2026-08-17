# M1 local quality gates

The M1 quality gate is intentionally reproducible from the checkout. Run it
only on a clean, committed contract revision; it creates disposable git
worktrees under the operating system temporary directory and never deploys.

## Pinned tools

| Tool | Version | Binary SHA-256 used for the recorded campaign |
| --- | --- | --- |
| Halmos | 0.3.3 | `b1fa1bc9b0309e2b91973ac85037db7cc7bc433fb2532b956921a9f97d0007b1` |
| Gambit | 1.0.6 | `cf8b48e9dad8d10fa2ea7c5a4497fa3eda17eac2d77c653c2699872484aa1a01` |
| solc | 0.8.28+commit.7893614a | `81515b0e53deaa266d549545ccaac0a5a96e6d4e8201c77f673b2c710976d9ea` |

The checksums identify the macOS binaries used for the campaign. Set the
three binary paths explicitly when running on another host; preserve the
listed tool versions and record that host's checksums with its report.

## Commands

From the repository root, provide the pinned binaries and select an output
directory outside the source tree:

```sh
HALMOS_BIN=/path/to/halmos \
GAMBIT_BIN=/path/to/gambit \
SOLC_BIN=/path/to/solc-0.8.28 \
QUALITY_RESULTS_DIR=/private/tmp/goloco-m1-quality \
packages/contracts/scripts/run-quality-gates.sh
```

The script resolves `QUALITY_REVISION` once, creates one detached worktree at
that exact commit, and runs the bounded Halmos I13/I16 proof plus Gambit mutant
generation from that worktree. It then tests each generated mutant in a
separate worktree at the same resolved commit. The recorded revision therefore
comes from the same source tree as every stage, rather than from the caller's
checkout. It writes `halmos.txt`, `mutation-results.tsv`, and
`mutation-summary.txt` beneath `QUALITY_RESULTS_DIR`.

Gambit uses `--skip_validate`, intentionally including source mutations that do
not compile; Foundry kills those mutations. A mutation survives only when the
entire Foundry suite passes with that source replacement. The SHA-binding
regression is executable locally with:

```sh
bash packages/contracts/scripts/test-run-quality-gates.sh
```

The recorded campaign's in-repository survivor ledger is
[`test/MUTATION_SURVIVORS.md`](test/MUTATION_SURVIVORS.md). Every survivor must
be either killed or listed there with a semantic-equivalence rationale.
