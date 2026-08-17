// @goloco/agent-format — the Goloco agent-definition format: types, the A2A
// Agent Card schema, and a validator.
//
// Two artifacts:
//   - goloco.agent.md : execution side, what the author writes (Goose-simple).
//   - Agent Card      : protocol side, a standard A2A card + one Goloco
//                       extension (labor-terms/v1), what the SDK generates.
//
// This package is OPEN and self-contained: it imports nothing from CLOSED
// services and holds no keys. It validates structure and Goloco's semantic
// rules, and rejects any artifact carrying secrets (the publish-time rule).

import { readFileSync } from 'node:fs';

import { parseAgentDefinition, AgentDefinitionParseError } from './agent-md.js';
import { validateAgainstSchema, type JsonSchema, type SchemaIssue } from './json-schema.js';
import {
  LABOR_TERMS_EXTENSION_URI,
  type AgentCard,
  type AgentDefinition,
  type LaborTerms,
  type ValidationIssue,
  type ValidationResult,
} from './types.js';

export * from './types.js';
export { parseAgentDefinition, AgentDefinitionParseError } from './agent-md.js';
export { validateAgainstSchema, type SchemaIssue, type JsonSchema } from './json-schema.js';

// ---------------------------------------------------------------------------
// Normative schemas, loaded from the shipped JSON so there is one source of truth.
// ---------------------------------------------------------------------------

function loadSchema(relativePath: string): JsonSchema {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as JsonSchema;
}

export const agentCardSchema: JsonSchema = loadSchema('../schema/goloco-agent-card.schema.json');
export const laborTermsSchema: JsonSchema = loadSchema('../schema/labor-terms-v1.schema.json');

// ---------------------------------------------------------------------------
// Secret-rejection rule: no artifact may carry secret material.
// ---------------------------------------------------------------------------

const SECRET_KEY = /^(env|env_?vars|secrets?|api_?keys?|private_?key|mnemonic|seed_?phrase|nsec|passphrase|password)$/i;

function scanForSecrets(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForSecrets(item, `${path}/${index}`, issues));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) {
        issues.push({
          path: `${path}/${key}`,
          code: 'secret_material',
          message: `Field "${key}" looks like a secret; secrets must never appear in a published agent artifact.`,
        });
      }
      scanForSecrets(child, `${path}/${key}`, issues);
    }
  }
}

// Marketplace terms belong in the card, not the execution-side .md.
const CARD_ONLY_KEYS = new Set([
  'pricing', 'payout', 'wallet', 'reputation', 'capacity', 'latency',
  'subcontracting', 'transport', 'capabilities', 'skills_pricing', 'price',
]);

const KNOWN_MD_KEYS = new Set(['name', 'description', 'model', 'tools', 'mcpServers', 'skills']);

function schemaIssuesToValidation(issues: SchemaIssue[], base: string): ValidationIssue[] {
  return issues.map((issue) => ({
    path: `${base}${issue.path === '/' ? '' : issue.path}`,
    code: issue.keyword,
    message: issue.message,
  }));
}

function result(errors: ValidationIssue[], warnings: ValidationIssue[]): ValidationResult {
  return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Execution side: validate a goloco.agent.md (source text or parsed object).
// ---------------------------------------------------------------------------

const AGENT_NAME_PATTERN = /^[a-z0-9-]+$/;

export function validateAgentDefinition(input: string | AgentDefinition): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  let def: AgentDefinition;
  if (typeof input === 'string') {
    try {
      def = parseAgentDefinition(input);
    } catch (error) {
      const message = error instanceof AgentDefinitionParseError ? error.message : String(error);
      return result([{ path: 'frontmatter', code: 'parse_error', message }], warnings);
    }
  } else {
    def = input;
  }

  const fm = def.frontmatter ?? {};

  // Required: name (slug), description, non-empty body.
  if (typeof fm.name !== 'string' || fm.name.trim() === '') {
    errors.push({ path: 'frontmatter/name', code: 'required', message: 'A goloco.agent.md requires a "name".' });
  } else if (!AGENT_NAME_PATTERN.test(fm.name)) {
    errors.push({ path: 'frontmatter/name', code: 'pattern', message: 'The "name" must be a slug matching ^[a-z0-9-]+$.' });
  }
  if (typeof fm.description !== 'string' || fm.description.trim() === '') {
    errors.push({ path: 'frontmatter/description', code: 'required', message: 'A goloco.agent.md requires a one-line "description".' });
  }
  if (typeof def.body !== 'string' || def.body.trim() === '') {
    errors.push({ path: 'body', code: 'required', message: 'The Markdown body (the system prompt) must not be empty.' });
  }

  // Type checks for the optional fields.
  if ('model' in fm && typeof fm.model !== 'string') {
    errors.push({ path: 'frontmatter/model', code: 'type', message: 'The "model" must be a string.' });
  }
  for (const listKey of ['tools', 'mcpServers', 'skills'] as const) {
    if (listKey in fm && fm[listKey] !== undefined) {
      const list = fm[listKey];
      if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
        errors.push({ path: `frontmatter/${listKey}`, code: 'type', message: `The "${listKey}" must be a list of strings.` });
      }
    }
  }

  // Card-only keys in the .md are a common, correctable mistake.
  for (const key of Object.keys(fm)) {
    if (CARD_ONLY_KEYS.has(key)) {
      errors.push({
        path: `frontmatter/${key}`,
        code: 'misplaced_field',
        message: `"${key}" is a marketplace term; it belongs in the generated Agent Card, not in goloco.agent.md.`,
      });
    } else if (!KNOWN_MD_KEYS.has(key)) {
      warnings.push({
        path: `frontmatter/${key}`,
        code: 'unknown_field',
        message: `"${key}" is not a Goloco frontmatter field; it is preserved but ignored by the marketplace.`,
      });
    }
  }

  // No secrets anywhere in the frontmatter (publish-time rule).
  scanForSecrets(fm, 'frontmatter', errors);

  return result(errors, warnings);
}

// ---------------------------------------------------------------------------
// Protocol side: validate an Agent Card.
// ---------------------------------------------------------------------------

const OASF_TAG = /^oasf:[a-z0-9_]+(\/[a-z0-9_]+)*$/;

export function validateAgentCard(card: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (card === null || typeof card !== 'object' || Array.isArray(card)) {
    return result([{ path: '', code: 'type', message: 'An Agent Card must be a JSON object.' }], warnings);
  }

  // 1. Structural validation against the A2A card schema.
  errors.push(...schemaIssuesToValidation(validateAgainstSchema(agentCardSchema, card), 'card'));

  const typed = card as Partial<AgentCard>;

  // 2. Every skill needs at least one OASF-namespaced tag so coverage matching
  //    (the μ term in the matching engine) is computable across agents.
  if (Array.isArray(typed.skills)) {
    typed.skills.forEach((skill, index) => {
      const tags = Array.isArray(skill?.tags) ? skill.tags : [];
      if (!tags.some((tag) => typeof tag === 'string' && OASF_TAG.test(tag))) {
        errors.push({
          path: `card/skills/${index}/tags`,
          code: 'oasf_tag_required',
          message: 'Each skill needs at least one OASF tag (e.g. "oasf:design/brand_identity") so the matching engine can score coverage.',
        });
      }
    });
  }

  // 3. The labor-terms extension must be present and its params must validate.
  const extensions = typed.capabilities?.extensions;
  if (Array.isArray(extensions)) {
    const laborExt = extensions.find((ext) => ext?.uri === LABOR_TERMS_EXTENSION_URI);
    if (!laborExt) {
      errors.push({
        path: 'card/capabilities/extensions',
        code: 'labor_terms_required',
        message: `A Goloco card must include the ${LABOR_TERMS_EXTENSION_URI} extension.`,
      });
    } else if (laborExt.params === undefined || typeof laborExt.params !== 'object') {
      errors.push({
        path: 'card/capabilities/extensions/labor-terms/params',
        code: 'required',
        message: 'The labor-terms extension must carry a "params" object.',
      });
    } else {
      const laborIssues = validateAgainstSchema(laborTermsSchema, laborExt.params);
      errors.push(...schemaIssuesToValidation(laborIssues, 'card/labor-terms'));
    }
  }

  // 4. No secrets anywhere in the card (publish-time rule).
  scanForSecrets(card, 'card', errors);

  return result(errors, warnings);
}

/** Read the labor-terms params from a card, if present and well-formed enough to return. */
export function readLaborTerms(card: AgentCard): LaborTerms | undefined {
  const ext = card.capabilities?.extensions?.find((e) => e.uri === LABOR_TERMS_EXTENSION_URI);
  return ext?.params as LaborTerms | undefined;
}

// ---------------------------------------------------------------------------
// One-call dispatch: a string is a goloco.agent.md; an object is an Agent Card.
// ---------------------------------------------------------------------------

export type ValidatableKind = 'agent-md' | 'agent-card';

/**
 * Validate either artifact. A string (or `{ frontmatter, body }`) is treated as
 * a `goloco.agent.md`; any other object is treated as an Agent Card. Pass `kind`
 * to force the interpretation.
 */
export function validate(input: unknown, kind?: ValidatableKind): ValidationResult {
  if (kind === 'agent-md') return validateAgentDefinition(input as string | AgentDefinition);
  if (kind === 'agent-card') return validateAgentCard(input);
  if (typeof input === 'string') return validateAgentDefinition(input);
  if (input !== null && typeof input === 'object' && 'frontmatter' in (input as object) && 'body' in (input as object)) {
    return validateAgentDefinition(input as AgentDefinition);
  }
  return validateAgentCard(input);
}
