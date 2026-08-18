# Gambit survivor ledger

Campaign: Gambit 1.0.6, Solc 0.8.28, `packages/contracts/src/{EscrowTree,EscrowTreeFactory}.sol`.
All remaining survivors below were inspected after targeted tests killed every non-equivalent survivor. Each is semantically equivalent under the immutable deployment model; the mutation IDs refer to Gambit's generated source-mutant IDs.

| Source | Mutant | Classification | Why it is equivalent |
| --- | ---: | --- | --- |
| `EscrowTree.sol` | 547 | Equivalent | A newly created clone's zero-value `RootOutcome` is already `Unresolved`; explicitly storing that same enum value changes neither storage nor an event. |
| `EscrowTree.sol` | 610 | Equivalent | Replacing `if (feeReserve != 0)` with `if (true)` only adds zero when no fee exists; the nonzero-fee branch is identical. |
| `EscrowTree.sol` | 747 | Equivalent | `factory` is immutable and can only be the non-upgradeable factory that exposes canonical `MIN_NODE_AMOUNT()` ABI data, so the failed-staticcall branch is unreachable for a deployed tree. |
| `EscrowTreeFactory.sol` | 123 | Equivalent | Reusing a `FundingAuthorization` has identical `RootParams`, so the independently consumed root-acceptance digest stops the call before clone creation or token movement. |
| `EscrowTreeFactory.sol` | 285 | Equivalent | Reusing a root acceptance is independently stopped by consumed funding authorization (`createAndFundFrom`) or the deterministic clone/EIP-3009 nonce (`createAndFund`) before a second funded tree can exist. |
| `EscrowTreeFactory.sol` | 312 | Equivalent | The fixed EIP-1167 CREATE2 deployment can return zero only on an EVM deployment failure, which atomically reverts; no successful call can observe or use a zero clone address. |
