// A small, dependency-free JSON Schema evaluator.
//
// It supports the subset of draft 2020-12 the Goloco schemas use, and — unlike a
// generic library — returns instance-path-anchored messages tuned for humans
// publishing an agent. The shipped schema/*.json files are the normative,
// portable artifacts (validate them with any conformant validator you like);
// this evaluator is the reference implementation the SDK uses so `goloco publish`
// gives the same errors everywhere.
//
// Supported keywords: type, const, enum, required, properties,
// additionalProperties, items, minItems, maxItems, minLength, maxLength,
// minimum, maximum, exclusiveMinimum, exclusiveMaximum, pattern, format
// (uri | date-time | email, asserted), allOf, anyOf, oneOf, not, if/then/else,
// $ref (local JSON pointer), $defs. Unknown keywords are ignored, as the spec
// requires.

export interface SchemaIssue {
  /** JSON Pointer-ish path to the offending instance location (e.g. `/skills/0/tags`). */
  path: string;
  /** Human-readable, single-sentence explanation. */
  message: string;
  /** The schema keyword that failed, for programmatic handling. */
  keyword: string;
}

export type JsonSchema = boolean | { [key: string]: unknown };

interface EvalContext {
  root: { [key: string]: unknown };
}

const JSON_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'] as const;
type JsonTypeName = (typeof JSON_TYPES)[number];

function jsonTypeOf(value: unknown): JsonTypeName {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  const t = typeof value;
  if (t === 'boolean' || t === 'string' || t === 'object') return t as JsonTypeName;
  // functions, undefined, symbol, bigint — not JSON; report as their typeof.
  return t as JsonTypeName;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = jsonTypeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

// Deliberately conservative format assertions: only reject values that are
// clearly not the claimed format, so we never block a legitimate publish over a
// format edge case. `uri` requires a scheme; `date-time` requires an ISO-8601
// instant; `email` requires a single `@` with text on both sides.
const FORMAT_CHECKS: Record<string, (value: string) => boolean> = {
  uri: (value) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value),
  'date-time': (value) => !Number.isNaN(Date.parse(value)) && /\d{4}-\d{2}-\d{2}[Tt]/.test(value),
  email: (value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value),
};

function resolveRef(ref: string, root: { [key: string]: unknown }): JsonSchema | undefined {
  if (!ref.startsWith('#')) return undefined; // only local refs are supported
  const pointer = ref.slice(1);
  if (pointer === '') return root;
  const segments = pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = root;
  for (const segment of segments) {
    if (current && typeof current === 'object' && segment in (current as object)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current as JsonSchema;
}

function push(issues: SchemaIssue[], path: string, keyword: string, message: string): void {
  issues.push({ path: path === '' ? '/' : path, keyword, message });
}

function evaluate(
  schema: JsonSchema,
  value: unknown,
  path: string,
  ctx: EvalContext,
  issues: SchemaIssue[],
): void {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    push(issues, path, 'false', 'No value is allowed here.');
    return;
  }
  const s = schema as Record<string, unknown>;

  if (typeof s.$ref === 'string') {
    const resolved = resolveRef(s.$ref, ctx.root);
    if (resolved === undefined) {
      push(issues, path, '$ref', `Unresolved schema reference "${s.$ref}".`);
    } else {
      evaluate(resolved, value, path, ctx, issues);
    }
    // A $ref alongside sibling keywords still applies the siblings in 2020-12.
  }

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((type) => matchesType(value, type))) {
      push(
        issues,
        path,
        'type',
        `Expected ${types.join(' or ')} but got ${jsonTypeOf(value)}.`,
      );
      // Type mismatch makes most other keyword checks noise; stop here.
      return;
    }
  }

  if ('const' in s && !deepEqual(value, s.const)) {
    push(issues, path, 'const', `Must equal ${JSON.stringify(s.const)}.`);
  }

  if (Array.isArray(s.enum) && !s.enum.some((option) => deepEqual(value, option))) {
    push(issues, path, 'enum', `Must be one of ${s.enum.map((o) => JSON.stringify(o)).join(', ')}.`);
  }

  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) {
      push(issues, path, 'minLength', `Must be at least ${s.minLength} character(s).`);
    }
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) {
      push(issues, path, 'maxLength', `Must be at most ${s.maxLength} character(s).`);
    }
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(value)) {
      push(issues, path, 'pattern', `Must match ${s.pattern}.`);
    }
    if (typeof s.format === 'string') {
      const check = FORMAT_CHECKS[s.format];
      if (check && !check(value)) {
        push(issues, path, 'format', `Must be a valid ${s.format}.`);
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) {
      push(issues, path, 'minimum', `Must be >= ${s.minimum}.`);
    }
    if (typeof s.maximum === 'number' && value > s.maximum) {
      push(issues, path, 'maximum', `Must be <= ${s.maximum}.`);
    }
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) {
      push(issues, path, 'exclusiveMinimum', `Must be > ${s.exclusiveMinimum}.`);
    }
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) {
      push(issues, path, 'exclusiveMaximum', `Must be < ${s.exclusiveMaximum}.`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) {
      push(issues, path, 'minItems', `Must have at least ${s.minItems} item(s).`);
    }
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) {
      push(issues, path, 'maxItems', `Must have at most ${s.maxItems} item(s).`);
    }
    if (s.items !== undefined) {
      value.forEach((item, index) => {
        evaluate(s.items as JsonSchema, item, `${path}/${index}`, ctx, issues);
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const properties = (s.properties as Record<string, JsonSchema>) ?? {};

    if (Array.isArray(s.required)) {
      for (const key of s.required as string[]) {
        if (!(key in obj)) {
          push(issues, path, 'required', `Missing required property "${key}".`);
        }
      }
    }

    for (const [key, sub] of Object.entries(properties)) {
      if (key in obj) evaluate(sub, obj[key], `${path}/${key}`, ctx, issues);
    }

    if (s.additionalProperties !== undefined && s.additionalProperties !== true) {
      const known = new Set(Object.keys(properties));
      for (const key of Object.keys(obj)) {
        if (known.has(key)) continue;
        if (s.additionalProperties === false) {
          push(issues, `${path}/${key}`, 'additionalProperties', `Unknown property "${key}" is not allowed.`);
        } else {
          evaluate(s.additionalProperties as JsonSchema, obj[key], `${path}/${key}`, ctx, issues);
        }
      }
    }
  }

  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf as JsonSchema[]) evaluate(sub, value, path, ctx, issues);
  }

  if (Array.isArray(s.anyOf)) {
    const anyOf = s.anyOf as JsonSchema[];
    if (!anyOf.some((sub) => localValid(sub, value, path, ctx))) {
      push(issues, path, 'anyOf', 'Does not match any of the allowed schemas.');
    }
  }

  if (Array.isArray(s.oneOf)) {
    const oneOf = s.oneOf as JsonSchema[];
    const matched = oneOf.filter((sub) => localValid(sub, value, path, ctx)).length;
    if (matched !== 1) {
      push(issues, path, 'oneOf', `Must match exactly one of the allowed schemas (matched ${matched}).`);
    }
  }

  if (s.not !== undefined && localValid(s.not as JsonSchema, value, path, ctx)) {
    push(issues, path, 'not', 'Must not match the forbidden schema.');
  }

  if (s.if !== undefined) {
    if (localValid(s.if as JsonSchema, value, path, ctx)) {
      if (s.then !== undefined) evaluate(s.then as JsonSchema, value, path, ctx, issues);
    } else if (s.else !== undefined) {
      evaluate(s.else as JsonSchema, value, path, ctx, issues);
    }
  }
}

function localValid(schema: JsonSchema, value: unknown, path: string, ctx: EvalContext): boolean {
  const probe: SchemaIssue[] = [];
  evaluate(schema, value, path, ctx, probe);
  return probe.length === 0;
}

/** Validate `value` against `schema`, returning every issue found (empty = valid). */
export function validateAgainstSchema(schema: JsonSchema, value: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const root = typeof schema === 'object' && schema !== null ? (schema as Record<string, unknown>) : {};
  evaluate(schema, value, '', { root }, issues);
  return issues;
}
