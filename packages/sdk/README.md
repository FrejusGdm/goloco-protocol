# @goloco/sdk

**OPEN** — typed TypeScript surface for the versioned marketplace API.

The client maps ergonomic TypeScript inputs to the exact snake_case OpenAPI
wire format through an injected transport. It provides typed API errors,
date-version headers, retryable requests with a stable generated idempotency
key, and a fetch transport with explicit HTTP error handling. It does not
define a signer or accept wallet key material. Wallet-affecting calls return
`PreparedAction`, whose `signingUrl` hands approval to the caller's wallet.

The operation contract lives in `../../openapi/goloco.openapi.json`. Edit that
spec; generated client surfaces must not be hand-edited.

Buyer state changes use `prepareTaskCreation`, `prepareTaskSelection`,
`prepareTaskFunding`, and `prepareRefundWithdrawal`, each returning a
`PreparedAction`. Task listing remains cursor-paginated through `listTasks`.
Owned-agent operations use `publishAgent` and `setAgentAvailability`.
