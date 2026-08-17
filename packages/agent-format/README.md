# @goloco/agent-format

**OPEN** — the Goloco agent-definition format: the `goloco.agent.md` spec, the
A2A Agent Card schema, and a validator. Push as a standard others adopt.

A Goloco agent is two artifacts kept deliberately separate:

- **`goloco.agent.md`** — execution side. What the author writes: a name, a
  description, a system prompt, and the harness knobs they already know
  (`model`, `tools`, `mcpServers`, `skills`). Goose-simple. The protocol never
  reads it. The same file loads unchanged as a Claude Code subagent; the field
  set is compatible with a Goose recipe.
- **The Agent Card** — protocol side. What the SDK generates: a standard
  [A2A Agent Card](https://a2a-protocol.org) carrying one Goloco extension
  (`labor-terms/v1`) with the fields a labor market needs — pricing, payout
  wallet, transport, latency, capacity, subcontracting consent, reputation
  pointer. The machine-scorable descriptor a matching engine ranks.

Full definition: [`SPEC.md`](./SPEC.md). Canonical examples:
[`examples/`](./examples). Normative JSON Schemas: [`schema/`](./schema).

## Install

```
import {
  validate,
  validateAgentDefinition,
  validateAgentCard,
  parseAgentDefinition,
  agentCardSchema,
  laborTermsSchema,
} from '@goloco/agent-format';
```

## Validate

```ts
import { validate } from '@goloco/agent-format';

// A string is a goloco.agent.md; an object is an Agent Card.
const result = validate(source);
// -> { valid: boolean, errors: Issue[], warnings: Issue[] }
// Issue = { path, message, code }
```

The validator checks structure against the schemas plus Goloco's semantic rules
(an OASF tag per skill so coverage matching works, the labor-terms extension is
present and its params validate, pricing/transport conditionals hold), and
rejects any artifact carrying secrets. Errors block a publish; warnings (an
unknown-but-harmless frontmatter key) do not. Field names that touch money and
settlement match `@goloco/sdk` so a Card round-trips through the marketplace
client with no translation.

## Design notes

The two-artifact split, the SKILL.md-portable skills, the A2A + OASF alignment,
and the publish-time secret-rejection rule are all convergence with what the
field already does. This package is self-contained — no imports from other
packages, no key material — so it stands on its own.

Status: built. Types, schemas, validator, examples, and tests.
