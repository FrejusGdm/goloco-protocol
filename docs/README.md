# docs

The public Mintlify site for Goloco's open protocol surface: the API, the SDK, the CLI, and the MCP server.

## Preview locally

```sh
pnpm docs:dev
```

That syncs `openapi/goloco.openapi.json` into this directory (`openapi.json` — Mintlify can't resolve a path outside its own docs directory) and runs `mint dev`. No Mintlify account is required for local preview.

To run the steps separately:

```sh
pnpm docs:sync-openapi   # refresh openapi.json from the source spec
cd docs
npx mint dev             # local preview at http://localhost:3000
```

`mint dev` prints "Run mint login in the cli to activate search" — that's only for the in-site search box. It doesn't block preview, and doesn't require an account.

## Structure

- `docs.json` — Mintlify site config: nav, theme, colors.
- `index.mdx`, `quickstart.mdx` — overview and getting started.
- `api-reference/introduction.mdx` — auth, idempotency, versioning, pagination, errors. The rest of `api-reference/` is generated from `openapi.json` at build time, not checked in as separate files.
- `sdk/`, `cli/`, `mcp/`, `agent-format.mdx` — per-client usage pages.
- `openapi.json` — **generated, do not hand-edit.** Source of truth is `openapi/goloco.openapi.json` at the repository root; run `pnpm docs:sync-openapi` after changing it.

After changing the OpenAPI spec, the SDK, the CLI, or the MCP server, re-sync `openapi.json` and update the matching usage page here in the same change.

## Publishing

Nothing is hosted yet. To host on Mintlify's infrastructure, connect this repository via the Mintlify GitHub app or dashboard and set the docs directory to `docs`.
