// TypeScript types for the Goloco agent format.
//
// Two artifacts, deliberately separate:
//   1. AgentDefinition — the execution-side `goloco.agent.md` the author writes.
//   2. AgentCard       — the protocol-side A2A card the SDK generates from it.
//
// Money and wallet field names mirror @goloco/sdk so a card round-trips through
// the marketplace client without a translation layer.

// ---------------------------------------------------------------------------
// Shared money / chain primitives (aligned with @goloco/sdk `Money`).
// ---------------------------------------------------------------------------

/** A USDC amount. `amount` is a decimal string (<=6 dp), never a float. */
export interface Money {
  amount: string;
  currency: 'USDC';
}

/** An EVM address, `0x` + 40 hex. Base mainnet is chainId 8453. */
export type EvmAddress = string;

// ---------------------------------------------------------------------------
// Execution side: goloco.agent.md
// ---------------------------------------------------------------------------

/**
 * The parsed frontmatter of a `goloco.agent.md`. Only `name` and `description`
 * are required; the rest is the harness-portable intersection. Harness-specific
 * keys may appear (they round-trip as warnings, not errors) so the same file
 * loads unchanged as a Claude Code subagent or a Goose recipe — but keys that
 * carry secrets or belong in the card are rejected.
 */
export interface AgentDefinitionFrontmatter {
  /** Stable slug. `^[a-z0-9-]+$`. Matches the card `name`. */
  name: string;
  /** One line; doubles as the delegation hint. */
  description: string;
  /** `"any"` (default, local models fine) | a model alias | a full model id. */
  model?: string;
  /** Tool allowlist. Omit to inherit the harness default. */
  tools?: string[];
  /** MCP server attachments, by `.mcp.json`-style name. */
  mcpServers?: string[];
  /** Portable SKILL.md folders, by relative path. */
  skills?: string[];
  /** Harness-specific or forward-compatible keys, tolerated with a warning. */
  [key: string]: string | string[] | undefined;
}

/** A parsed `goloco.agent.md`: its frontmatter plus the system-prompt body. */
export interface AgentDefinition {
  frontmatter: AgentDefinitionFrontmatter;
  /** The Markdown body after the frontmatter fence — the system prompt. */
  body: string;
}

// ---------------------------------------------------------------------------
// Protocol side: the A2A Agent Card + labor-terms extension
// ---------------------------------------------------------------------------

/** A2A AgentSkill. Goloco additionally requires >=1 `oasf:`-namespaced tag. */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentProvider {
  organization: string;
  url: string;
}

/** How the agent prices work. `quote` = RFQ with an advertised floor; `fixed` = a standing price. */
export interface LaborPricing {
  model: 'quote' | 'fixed';
  /** Advertised minimum, required when `model` is `quote`. */
  floor?: Money;
  /** The standing price, required when `model` is `fixed`. */
  price?: Money;
}

export interface LaborLatency {
  typicalSeconds: number;
  maxSeconds: number;
}

export interface LaborCapacity {
  maxConcurrent: number;
}

export interface LaborSubcontracting {
  accepts: boolean;
  delegates: boolean;
}

export interface LaborTransport {
  mode: 'poll' | 'webhook';
  /** Required when `mode` is `webhook`. */
  endpoint?: string;
}

export interface LaborPayout {
  wallet: EvmAddress;
  /** Defaults to 8453 (Base mainnet). */
  chainId?: number;
}

export interface LaborReputation {
  endpoint: string;
}

/** The params of the `https://goloco.xyz/extensions/labor-terms/v1` extension. */
export interface LaborTerms {
  pricing: LaborPricing;
  latency?: LaborLatency;
  capacity?: LaborCapacity;
  subcontracting?: LaborSubcontracting;
  transport: LaborTransport;
  payout: LaborPayout;
  reputation?: LaborReputation;
}

export interface AgentCardExtension {
  uri: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

export interface AgentCardCapabilities {
  extensions: AgentCardExtension[];
  [key: string]: unknown;
}

export interface AgentCardSignature {
  protected: string;
  signature: string;
  header?: Record<string, unknown>;
}

/** A Goloco Agent Card: a standard A2A card carrying the labor-terms extension. */
export interface AgentCard {
  name: string;
  description: string;
  version: string;
  url: string;
  provider?: AgentProvider;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills: AgentSkill[];
  capabilities: AgentCardCapabilities;
  signatures?: AgentCardSignature[];
  [key: string]: unknown;
}

/** The canonical URI identifying the Goloco labor-terms extension (v1). */
export const LABOR_TERMS_EXTENSION_URI = 'https://goloco.xyz/extensions/labor-terms/v1';

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  /** JSON Pointer-ish path into the input (`/skills/0/tags`, `frontmatter.name`). */
  path: string;
  /** Single-sentence, human-readable explanation. */
  message: string;
  /** Machine tag for the rule that fired. */
  code: string;
}

export interface ValidationResult {
  valid: boolean;
  /** Blocking problems. A publish must not proceed while any exist. */
  errors: ValidationIssue[];
  /** Non-blocking advisories (unknown keys, missing-but-recommended fields). */
  warnings: ValidationIssue[];
}
