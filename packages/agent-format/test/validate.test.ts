import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import {
  LABOR_TERMS_EXTENSION_URI,
  agentCardSchema,
  laborTermsSchema,
  parseAgentDefinition,
  readLaborTerms,
  validate,
  validateAgainstSchema,
  validateAgentCard,
  validateAgentDefinition,
  type AgentCard,
} from '../src/index.ts';

const fixture = (relative: string): string =>
  readFileSync(new URL(`./fixtures/${relative}`, import.meta.url), 'utf8');

const listFixtures = (relative: string): string[] =>
  readdirSync(new URL(`./fixtures/${relative}`, import.meta.url)).sort();

const codes = (issues: { code: string }[]): string[] => issues.map((issue) => issue.code);

// ---------------------------------------------------------------------------
// goloco.agent.md — parsing
// ---------------------------------------------------------------------------

test('parses frontmatter shapes: scalars, flow lists, block lists, inline comments', () => {
  const def = parseAgentDefinition(fixture('agent-md/valid/full.md'));
  assert.equal(def.frontmatter.name, 'research-analyst');
  assert.equal(def.frontmatter.model, 'claude-sonnet');
  assert.deepEqual(def.frontmatter.tools, ['web.search', 'web.fetch']);
  assert.deepEqual(def.frontmatter.mcpServers, ['notion']);
  assert.deepEqual(def.frontmatter.skills, ['./skills/citation-discipline']);
  assert.match(def.body, /You are a research analyst/);
});

test('strips inline comments from the canonical example without dropping quoted content', () => {
  const def = parseAgentDefinition(fixture('../../examples/goloco.agent.md'));
  assert.equal(def.frontmatter.model, 'any');
  assert.deepEqual(def.frontmatter.tools, ['web.search', 'image.generate']);
  assert.deepEqual(def.frontmatter.mcpServers, []);
});

// ---------------------------------------------------------------------------
// goloco.agent.md — validation
// ---------------------------------------------------------------------------

test('accepts every valid goloco.agent.md fixture and the canonical example', () => {
  for (const name of listFixtures('agent-md/valid')) {
    const res = validateAgentDefinition(fixture(`agent-md/valid/${name}`));
    assert.equal(res.valid, true, `${name} should be valid but got: ${JSON.stringify(res.errors)}`);
  }
  assert.equal(validateAgentDefinition(fixture('../../examples/goloco.agent.md')).valid, true);
});

test('a harness-specific unknown key is a warning, not an error', () => {
  const res = validateAgentDefinition(fixture('agent-md/valid/full.md'));
  assert.equal(res.valid, true);
  assert.deepEqual(codes(res.warnings), ['unknown_field']); // disallowedTools
  assert.match(res.warnings[0]!.path, /disallowedTools/);
});

test('rejects each invalid goloco.agent.md with the expected reason', () => {
  const cases: Record<string, string> = {
    'missing-name.md': 'required',
    'bad-name.md': 'pattern',
    'empty-body.md': 'required',
    'secret-in-frontmatter.md': 'secret_material',
    'card-only-key.md': 'misplaced_field',
    'no-frontmatter.md': 'parse_error',
  };
  for (const [name, expectedCode] of Object.entries(cases)) {
    const res = validateAgentDefinition(fixture(`agent-md/invalid/${name}`));
    assert.equal(res.valid, false, `${name} should be invalid`);
    assert.ok(
      codes(res.errors).includes(expectedCode),
      `${name} should report "${expectedCode}" but got ${JSON.stringify(codes(res.errors))}`,
    );
  }
});

test('the secret rule catches both the env list and the apiKey scalar', () => {
  const res = validateAgentDefinition(fixture('agent-md/invalid/secret-in-frontmatter.md'));
  const secretPaths = res.errors.filter((e) => e.code === 'secret_material').map((e) => e.path);
  assert.ok(secretPaths.some((p) => p.includes('env')));
  assert.ok(secretPaths.some((p) => p.includes('apiKey')));
});

// ---------------------------------------------------------------------------
// Agent Card — validation
// ---------------------------------------------------------------------------

test('accepts every valid Agent Card fixture and the canonical example', () => {
  for (const name of listFixtures('agent-card/valid')) {
    const card = JSON.parse(fixture(`agent-card/valid/${name}`));
    const res = validateAgentCard(card);
    assert.equal(res.valid, true, `${name} should be valid but got: ${JSON.stringify(res.errors)}`);
  }
  const example = JSON.parse(fixture('../../examples/agent-card.json'));
  assert.equal(validateAgentCard(example).valid, true);
});

test('rejects each invalid Agent Card with the expected reason', () => {
  const cases: Record<string, string> = {
    'missing-labor-terms.json': 'labor_terms_required',
    'no-oasf-tag.json': 'oasf_tag_required',
    'bad-wallet.json': 'pattern',
    'bad-amount.json': 'pattern',
    'quote-without-floor.json': 'required',
    'webhook-without-endpoint.json': 'required',
    'secret-in-card.json': 'secret_material',
    'missing-required.json': 'required',
  };
  for (const [name, expectedCode] of Object.entries(cases)) {
    const card = JSON.parse(fixture(`agent-card/invalid/${name}`));
    const res = validateAgentCard(card);
    assert.equal(res.valid, false, `${name} should be invalid`);
    assert.ok(
      codes(res.errors).includes(expectedCode),
      `${name} should report "${expectedCode}" but got ${JSON.stringify(codes(res.errors))}`,
    );
  }
});

test('errors carry a human-readable message and an input path', () => {
  const card = JSON.parse(fixture('agent-card/invalid/bad-wallet.json'));
  const res = validateAgentCard(card);
  const walletError = res.errors.find((e) => e.path.includes('wallet'));
  assert.ok(walletError, 'expected a wallet-anchored error');
  assert.match(walletError!.message, /match/i);
});

test('missing-required reports both version and url', () => {
  const card = JSON.parse(fixture('agent-card/invalid/missing-required.json'));
  const res = validateAgentCard(card);
  const messages = res.errors.map((e) => e.message).join(' ');
  assert.match(messages, /version/);
  assert.match(messages, /url/);
});

// ---------------------------------------------------------------------------
// Dispatch + helpers + schema-as-source-of-truth
// ---------------------------------------------------------------------------

test('validate() dispatches a string to the .md validator and an object to the card validator', () => {
  const mdResult = validate(fixture('agent-md/valid/minimal.md'));
  assert.equal(mdResult.valid, true);

  const card = JSON.parse(fixture('agent-card/valid/canonical.json'));
  assert.equal(validate(card).valid, true);
  assert.equal(validate(card, 'agent-card').valid, true);
});

test('readLaborTerms returns the extension params from a card', () => {
  const card = JSON.parse(fixture('agent-card/valid/canonical.json')) as AgentCard;
  const terms = readLaborTerms(card);
  assert.equal(terms?.pricing.model, 'fixed');
  assert.equal(terms?.payout.wallet, '0x2222222222222222222222222222222222222222');
});

test('the shipped schema files are valid JSON Schema documents the evaluator can run', () => {
  assert.equal((agentCardSchema as { $id: string }).$id, 'https://goloco.xyz/schema/goloco-agent-card.schema.json');
  assert.equal((laborTermsSchema as { $id: string }).$id, LABOR_TERMS_EXTENSION_URI);
  // Evaluator runs the card schema against a known-good instance with no issues.
  const card = JSON.parse(fixture('agent-card/valid/canonical.json'));
  assert.equal(validateAgainstSchema(agentCardSchema, card).length, 0);
});
