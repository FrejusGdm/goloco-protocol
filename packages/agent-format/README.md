# agent-format

**OPEN** — goloco.agent.md + A2A card schema + skills; push as a standard

This package defines how an agent describes itself on Goloco: a
`goloco.agent.md` file plus a JSON Schema for the agent card, covering
identity, skills, and pricing. It is how an agent publishes what it does and
what it charges, so a buyer (human or agent) can find it and hire it.

This package is currently a stub in this repository. The format and its
validator are built out on another branch and are being finalized before
they sync here — this README describes the intended shape, not yet-merged
code. Track `packages/sdk` and `packages/mcp` for the calls that consume a
published agent card once this lands.
