// Parsing and validation for the execution-side artifact, `goloco.agent.md`.
//
// The frontmatter is a deliberately small YAML subset — the intersection the
// harness field agrees on (name, description, model, tools, mcpServers, skills)
// plus a Markdown body that is the system prompt. Rather than pull in a full
// YAML parser (and its surface area), this reads exactly the shapes the format
// permits and reports a clear line-anchored error on anything else. That
// strictness is a feature: it keeps published agents portable.

import type { AgentDefinition, AgentDefinitionFrontmatter } from './types.js';

export class AgentDefinitionParseError extends Error {
  public readonly line: number;
  public constructor(message: string, line: number) {
    super(line > 0 ? `${message} (line ${line})` : message);
    this.name = 'AgentDefinitionParseError';
    this.line = line;
  }
}

type Scalar = string;
type FrontmatterValue = Scalar | Scalar[];

/** Strip a YAML inline comment (` # ...`) that is not inside quotes. */
function stripInlineComment(input: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(input[i - 1]!))) {
      return input.slice(0, i);
    }
  }
  return input;
}

function unquote(raw: string, line: number): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.includes(': ') || /:\s*$/.test(value)) {
    // A bare scalar that looks like it holds an unquoted mapping is almost
    // always a formatting mistake; flag it rather than swallow it.
    throw new AgentDefinitionParseError(`Ambiguous unquoted value "${value}"; wrap it in quotes`, line);
  }
  return value;
}

function parseFlowSequence(raw: string, line: number): Scalar[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((item) => {
    const trimmed = item.trim();
    if (trimmed === '') throw new AgentDefinitionParseError('Empty item in inline list', line);
    return unquote(trimmed, line);
  });
}

/**
 * Split a `goloco.agent.md` into its parsed frontmatter and its body (the system
 * prompt). Throws {@link AgentDefinitionParseError} on malformed structure. This
 * is structural parsing only; semantic rules are applied by {@link validateAgentDefinition}.
 */
export function parseAgentDefinition(source: string): AgentDefinition {
  const normalized = source.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  if (lines[0]?.trim() !== '---') {
    throw new AgentDefinitionParseError('A goloco.agent.md must open with a "---" frontmatter fence', 1);
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === '---') {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) {
    throw new AgentDefinitionParseError('Frontmatter is never closed with a matching "---"', 1);
  }

  const frontmatter: Record<string, FrontmatterValue> = {};
  let pendingKey: string | null = null;
  let pendingList: Scalar[] | null = null;

  for (let i = 1; i < closingIndex; i += 1) {
    const lineNumber = i + 1;
    const rawLine = stripInlineComment(lines[i]!);
    if (rawLine.trim() === '') continue;

    const blockItem = /^\s*-\s+(.*)$/.exec(rawLine);
    if (blockItem) {
      if (pendingList === null || pendingKey === null) {
        throw new AgentDefinitionParseError('List item "-" without a preceding key', lineNumber);
      }
      pendingList.push(unquote(blockItem[1]!, lineNumber));
      continue;
    }

    // A new mapping key closes any open block list.
    if (pendingKey !== null && pendingList !== null) {
      frontmatter[pendingKey] = pendingList;
      pendingKey = null;
      pendingList = null;
    }

    const mapping = /^([A-Za-z0-9_-]+):(.*)$/.exec(rawLine.trimStart());
    if (!mapping) {
      throw new AgentDefinitionParseError(`Cannot parse frontmatter line "${lines[i]!.trim()}"`, lineNumber);
    }
    const key = mapping[1]!;
    const rest = mapping[2]!.trim();
    if (key in frontmatter) {
      throw new AgentDefinitionParseError(`Duplicate frontmatter key "${key}"`, lineNumber);
    }

    if (rest === '') {
      // Value continues as a block sequence on following lines.
      pendingKey = key;
      pendingList = [];
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      frontmatter[key] = parseFlowSequence(rest, lineNumber);
    } else {
      frontmatter[key] = unquote(rest, lineNumber);
    }
  }
  if (pendingKey !== null && pendingList !== null) {
    frontmatter[pendingKey] = pendingList;
  }

  const body = lines.slice(closingIndex + 1).join('\n').trim();
  return { frontmatter: frontmatter as AgentDefinitionFrontmatter, body };
}
