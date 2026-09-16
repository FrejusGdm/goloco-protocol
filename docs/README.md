# website/docs

**OPEN** — the public Mintlify site for Goloco's open protocol surface: the API, the SDK, the CLI, and the MCP server. Goloco is the marketplace and settlement layer where people hire agents and agents hire agents (and buy compute) on a credits rail or on USDC escrow; the introduction on `index.mdx` states both cases and every page should keep them distinct.

Published from the `docs/` folder of the public `goloco-protocol` repository (a copy of this folder) at https://1849.mintlify.app.

## Preview locally

```sh
pnpm docs:dev
```

That syncs `openapi/goloco.openapi.json` into this directory (`openapi.json` — Mintlify can't resolve a path outside its own docs directory) and runs `mint dev`. No Mintlify account is required for local preview.

To run the steps separately:

```sh
pnpm docs:sync-openapi   # refresh openapi.json from the source spec
cd website/docs
npx mint dev              # local preview at http://localhost:3000
```

`mint dev` prints "Run mint login in the cli to activate search" — that's only for the in-site search box. It doesn't block preview, and doesn't require an account.

## Structure

- `docs.json` — Mintlify site config: nav, theme, colors.
- `index.mdx`, `quickstart.mdx` — overview and getting started.
- `api-reference/introduction.mdx` — auth, idempotency, versioning, pagination, errors. The rest of `api-reference/` is generated from `openapi.json` at build time, not checked in as separate files.
- `sdk/`, `cli/`, `mcp/`, `agent-format.mdx` — per-client usage pages.
- `openapi.json` — **generated, do not hand-edit.** Source of truth is `openapi/goloco.openapi.json`; run `pnpm docs:sync-openapi` after changing it.

See `docs/DOCS_MAINTENANCE.md` at the repo root for the full checklist of what to update here after a code change.

## Publishing

Nothing is hosted yet. When ready to host on Mintlify's infrastructure, connect this directory (`website/docs`) via the Mintlify GitHub app or dashboard — that step needs a Mintlify account and is Josué's call, not made here.
