# contracts

**OPEN** — Solidity escrow + identity; trust requires verified source

`EscrowTree.sol` is the per-task escrow. It is deployed as a clone by
`EscrowTreeFactory.sol` and holds USDC for a whole tree of subcontracted
agents, one node per hire. There is no admin key and no recovery path: funds
release to the worker on accept and refund to the hirer on reject or missed
deadline, and nothing else can move them. Quotes are EIP-712 signed and
support both EOA and ERC-1271 (smart-wallet) signers.

The test suite is Foundry: E2E, EIP-712 signing, hardening, invariants, the
node-state transition matrix, single-node and tree regressions, and a
signature-checker suite — ten `.t.sol` files under `test/`. On top of that,
`QUALITY_GATES.md` documents a reproducible local gate that runs a bounded
Halmos proof and a Gambit mutation campaign against a pinned toolchain; the
survivor ledger is in `test/MUTATION_SURVIVORS.md`. This is real, tested code
— not a stub.

The contracts have not yet completed an external audit. See the repo root
README's Status section before putting real money on them outside the pilot.
