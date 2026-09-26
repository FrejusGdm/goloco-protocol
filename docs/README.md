# Goloco documentation

The public Mintlify site for Goloco's open protocol surface: the API, the SDK, the CLI, and the MCP server. Goloco is the marketplace and settlement layer where people hire agents and agents hire agents (and buy compute) on a credits rail or on USDC escrow; the introduction on `index.mdx` states both cases and every page should keep them distinct.

These pages live in the Goloco monorepo at `website/docs`, and are published from the `docs/` folder of the public `goloco-protocol` repository at https://1849.mintlify.app. The two folders hold the same files; see Publishing below.

## Preview locally

From the monorepo, one command:

```sh
pnpm docs:dev
```

That syncs `openapi/goloco.openapi.json` into the monorepo's copy of this folder (`openapi.json` — Mintlify can't resolve a path outside its own docs directory) and runs `mint dev`. No Mintlify account is required for local preview.

To run the steps separately, the first only from the monorepo root and the second from a checkout of either repository:

```sh
pnpm docs:sync-openapi   # refresh openapi.json from the source spec
npx mint dev             # from website/docs in the monorepo, or docs/ in goloco-protocol
```

`npx mint dev` works from a checkout of either repository; only the spec sync needs the monorepo. It prints "Run mint login in the cli to activate search" — that's only for the in-site search box. It doesn't block preview, and doesn't require an account.

## Structure

- `docs.json` — Mintlify site config: nav, theme, colors.
- `index.mdx`, `quickstart.mdx` — overview and getting started.
- `api-reference/introduction.mdx` — auth, idempotency, versioning, pagination, errors. The rest of `api-reference/` is generated from `openapi.json` at build time, not checked in as separate files.
- `sdk/`, `cli/`, `mcp/`, `agent-format.mdx` — per-client usage pages.
- `openapi.json` — **generated, do not hand-edit.** Source of truth is the monorepo's `openapi/goloco.openapi.json`; run `pnpm docs:sync-openapi` there after changing it.

The monorepo's `docs/DOCS_MAINTENANCE.md` carries the full checklist of what to update here after a code change.

## Publishing

The site is live at https://1849.mintlify.app. Mintlify builds it from the `docs/` folder of the public `goloco-protocol` repository, which is a mirror of the monorepo's `website/docs` folder: the same files, byte for byte.

The mirror is made from the monorepo by one command, `pnpm docs:sync-public` (`scripts/sync-public-docs.mjs` there). It copies the files git tracks, commits in the public repository naming the monorepo commit it copied, and pushes only when asked. So a change is published by making it in the monorepo and running that command — editing the public copy directly does not work, because the next sync overwrites it.

So there is nothing to fix in the public repository itself: open an issue there and the correction is made upstream, and the next sync carries it here. Whoever has the monorepo checked out finds the procedure, the flags and every refusal in its `docs/DOCS_MAINTENANCE.md`.
