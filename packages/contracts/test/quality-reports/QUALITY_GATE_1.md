# Bound quality-gate report

Revision: the audited contract revision.

The runner resolved this revision once, created its detached target worktree,
and ran Halmos, Gambit generation, and all mutation test worktrees from that
source. The caller checkout was not an input to any proof or mutation result.

## Captured results

| Check | Result |
| --- | --- |
| Halmos 0.3.3 I13 — bounded buyer gross recovery | pass, 18 paths |
| Halmos 0.3.3 I16 — bounded absence of privileged sweep path | pass, 16 paths |
| Gambit 1.0.6 (`--skip_validate`) | 1,218 / 1,224 killed, 99.51% |

The six survivors are the semantic equivalents in
[`../MUTATION_SURVIVORS.md`](../MUTATION_SURVIVORS.md): EscrowTree 547, 610,
747; EscrowTreeFactory 123, 285, 312.

Tool versions, checksums, and the replay command are in
[`../../QUALITY_GATES.md`](../../QUALITY_GATES.md). The runner writes its raw
`halmos.txt`, `mutation-results.tsv`, and `mutation-summary.txt` to the
explicit external results directory selected by `QUALITY_RESULTS_DIR`.
