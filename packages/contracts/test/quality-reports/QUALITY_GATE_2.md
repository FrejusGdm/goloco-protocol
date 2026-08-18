# Local quality-gate report

Revision: the audited contract revision.
Scope: `EscrowTree.sol` and `EscrowTreeFactory.sol` only.
Execution: local only; no deployment, push, or external state change.

## Reproduction

Run from the repository root with the version- and checksum-pinned command in
[`../../QUALITY_GATES.md`](../../QUALITY_GATES.md):

```sh
HALMOS_BIN=/path/to/halmos \
GAMBIT_BIN=/path/to/gambit \
SOLC_BIN=/path/to/solc-0.8.28 \
QUALITY_RESULTS_DIR=/private/tmp/goloco-quality \
QUALITY_REVISION=<audited-contract-revision> \
packages/contracts/scripts/run-quality-gates.sh
```

The runner verifies the recorded macOS SHA-256 values before running Halmos
0.3.3 and Gambit 1.0.6. It writes the raw `halmos.txt`,
`mutation-results.tsv`, and `mutation-summary.txt` to the explicitly supplied
external results directory.

## Captured results

Halmos 0.3.3 with Solc 0.8.28 and Z3:

| Property | Result | Explored paths |
| --- | --- | ---: |
| I13 — bounded buyer gross recovery after every root refund cause | pass | 18 |
| I16 — bounded absence of privileged sweep path | pass | 16 |

Gambit 1.0.6 with `--skip_validate` (compile-invalid source mutations are
included and killed by Foundry):

| Generated | Killed | Survived | Mutation score |
| ---: | ---: | ---: | ---: |
| 1,224 | 1,218 | 6 | 99.51% |

The remaining six survivors are exactly the semantic equivalents documented in
[`../MUTATION_SURVIVORS.md`](../MUTATION_SURVIVORS.md): EscrowTree IDs 547,
610, and 747; EscrowTreeFactory IDs 123, 285, and 312.

The final run explicitly killed the two previously disputed EscrowTree
mutants: ID 235 (Released-node delivery state guard) and ID 703 (nearest
Released-ancestor refund routing).
