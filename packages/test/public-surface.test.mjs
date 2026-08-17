import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const sourceFiles = {
  sdk: new URL('../sdk/src/index.ts', import.meta.url),
  cli: new URL('../cli/src/index.ts', import.meta.url),
  mcp: new URL('../mcp/src/tools.ts', import.meta.url),
};

async function source(name) {
  return readFile(sourceFiles[name], 'utf8');
}

async function collectOpenPackageFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name === 'src') {
      files.push(...await collectOpenPackageFiles(file));
    } else if (entry.isDirectory() && directory.endsWith('/packages')) {
      files.push(...await collectOpenPackageFiles(file));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name === 'package.json')) {
      files.push(file);
    }
  }
  return files;
}

test('SDK exposes marketplace actions without a client-side signing capability', async () => {
  const sdk = await source('sdk');

  for (const method of [
    'prepareTaskCreation',
    'prepareTaskSelection',
    'prepareSubcontract',
    'prepareTaskFunding',
    'prepareTaskRejection',
    'prepareNodeAbandonment',
    'prepareNodeNonDeliveryClaim',
    'listAgentNodes',
    'prepareQuote',
    'submitDelivery',
    'prepareTaskResolution',
    'prepareTaskRejection',
    'prepareNodeAbandonment',
    'prepareNodeNonDeliveryClaim',
    'listAgentNodes',
    'prepareEarningsWithdrawal',
  ]) {
    assert.match(sdk, new RegExp(`\\b${method}\\b`));
  }

  assert.match(sdk, /export interface PreparedAction/);
  assert.match(sdk, /signingUrl: string/);
  assert.doesNotMatch(sdk, /privateKey|signTransaction|sendTransaction/i);
});

test('drops the legacy direct-commit SDK methods that bypassed the prepared-action boundary (red-team P0 #1)', async () => {
  const sdk = await source('sdk');

  // The direct mutations returning a committed Task/Node are gone from the SDK
  // surface; only the non-custodial prepare* intents remain.
  assert.doesNotMatch(sdk, /\bcreateTask\b/);
  assert.doesNotMatch(sdk, /\bselectTaskAgent\b/);
  // The direct selection-commit path template (ending in /selection, not
  // /selection-intents) must not appear.
  assert.equal(sdk.includes('}/selection`'), false, 'no direct /selection commit path remains');

  // The client-side kind guard for red-team #2 is present and throws.
  assert.match(sdk, /PreparedActionKindError/);
  assert.match(sdk, /preparedActionMapper/);
});

test('every OPEN package source and manifest preserves the custody and CLOSED boundary', async () => {
  const files = await collectOpenPackageFiles(path.resolve(new URL('..', import.meta.url).pathname));
  assert.ok(files.length > 0);
  const contents = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  const boundary = contents.join('\n');

  assert.doesNotMatch(boundary, /from\s+['"][^'"]*services\//);
  assert.doesNotMatch(boundary, /privateKey|signTransaction|sendTransaction/i);
});

test('CLI and MCP retain the coarse public verbs and wallet handoff', async () => {
  const [cli, mcp] = await Promise.all([source('cli'), source('mcp')]);

  for (const command of [
    'task create',
    'task list',
    'task get',
    'task fund',
    'task select',
    'task accept',
    'task reject',
    'task abandon',
    'task claim-non-delivery',
    'agent nodes',
    'quote create',
    'deliver create',
    'earnings get',
    'earnings withdrawal-intent',
  ]) {
    assert.match(cli, new RegExp(command.replace(' ', '\\s+')));
  }

  for (const tool of [
    'post_task',
    'list_tasks',
    'get_task',
    'get_task_matches',
    'get_agent_nodes',
    'hire_agent',
    'fund_task',
    'resolve_task',
    'reject_task',
    'abandon_node',
    'claim_non_delivery',
    'submit_quote',
    'submit_delivery',
    'get_earnings',
    'withdraw_earnings',
  ]) {
    assert.match(mcp, new RegExp(`'${tool}'`));
  }

  assert.match(mcp, /kind: 'prepared_action'/);
  assert.doesNotMatch(`${cli}\n${mcp}`, /privateKey|signTransaction|sendTransaction/i);
});
