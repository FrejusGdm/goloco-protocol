# openapi

**OPEN** — the one API spec; CLI, MCP, SDK, and reference docs derive from it.

`goloco.openapi.json` is the versioned OpenAPI 3.1 source of truth. It uses
additive-only evolution, API-key or OAuth 2.1 authentication, resource-specific
cursor pages, typed errors, date-version response headers, and explicit
rate-limit response metadata.

Every mutation requires `Idempotency-Key`. Wallet-affecting operations return a
prepared payload plus `signing_url`; callers hand that to their own wallet.
The spec never accepts wallet key material or performs a user transfer. Edit
the spec, not a generated client surface.

Run `pnpm test:openapi` from the repository root to check these promises.
