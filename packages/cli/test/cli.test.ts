import assert from 'node:assert/strict';
import { execFile as executeFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import { APIConnectionError, AuthenticationError } from '../../sdk/src/index.ts';
import { EXIT_CODE, runCli } from '../src/index.ts';

const execFile = promisify(executeFile);
const repoRoot = new URL('../../..', import.meta.url);

test('prepares task creation through the SDK with the supplied idempotency key', async () => {
  const calls: Array<{ input: unknown; idempotencyKey?: string }> = [];
  const output: string[] = [];

  const exitCode = await runCli(
    [
      'task',
      'create',
      '--brief',
      'Create a brand system.',
      '--budget',
      '400.00',
      '--selection-mode',
      'auto',
      '--idempotency-key',
      'create-task-1',
    ],
    {
      client: {
        prepareTaskCreation: async (input, options) => {
          calls.push({ input, idempotencyKey: options?.idempotencyKey });
          return { kind: 'create_task', payload: {}, signingUrl: 'https://wallet.example/approve', expiresAt: '2026-08-18T00:00:00Z' };
        },
      },
      stdout: (line) => output.push(line),
      stderr: () => undefined,
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    input: {
      brief: 'Create a brand system.',
      budget: { amount: '400.00', currency: 'USDC' },
      selectionMode: 'auto',
    },
    idempotencyKey: 'create-task-1',
  }]);
  assert.match(output[0] ?? '', /"kind": "create_task"/);
});

test('renders help without requiring API-key configuration', async () => {
  const output: string[] = [];
  const exitCode = await runCli(['help'], {
    environment: {},
    stdout: (line) => output.push(line),
    stderr: () => undefined,
  });

  assert.equal(exitCode, EXIT_CODE.ok);
  assert.match(output[0], /Usage: goloco/);
});

test('lists tasks using a cursor and prints the spec-shaped next_page token', async () => {
  const calls: unknown[] = [];
  const output: string[] = [];

  const exitCode = await runCli(['task', 'list', '--cursor', 'cursor_1', '--limit', '25'], {
    client: {
      listTasks: async (options) => {
        calls.push(options);
        return { data: [], nextPage: 'cursor_2' };
      },
    },
    stdout: (line) => output.push(line),
    stderr: () => undefined,
  });

  assert.equal(exitCode, EXIT_CODE.ok);
  assert.deepEqual(calls, [{ cursor: 'cursor_1', limit: 25 }]);
  assert.deepEqual(output, ['{\n  "data": [],\n  "next_page": "cursor_2"\n}']);
});

test('gets a task and earnings through the corresponding SDK resource methods', async () => {
  const calls: Array<{ name: string; arguments: unknown[] }> = [];
  const output: string[] = [];
  const client = {
    getTask: async (...arguments_: unknown[]) => {
      calls.push({ name: 'task', arguments: arguments_ });
      return { id: 'task_1' };
    },
    getEarnings: async (...arguments_: unknown[]) => {
      calls.push({ name: 'earnings', arguments: arguments_ });
      return { pending: '2.00', claimable: '1.00', currency: 'USDC' as const };
    },
  };

  assert.equal(await runCli(['task', 'get', 'task_1'], { client, stdout: (line) => output.push(line), stderr: () => undefined }), EXIT_CODE.ok);
  assert.equal(await runCli(['earnings', 'get'], { client, stdout: (line) => output.push(line), stderr: () => undefined }), EXIT_CODE.ok);
  assert.deepEqual(calls, [
    { name: 'task', arguments: ['task_1', {}] },
    { name: 'earnings', arguments: [{}] },
  ]);
  assert.deepEqual(output, [
    '{\n  "id": "task_1"\n}',
    '{\n  "pending": "2.00",\n  "claimable": "1.00",\n  "currency": "USDC"\n}',
  ]);
});

test('routes money verbs through prepared SDK actions with an idempotency key', async () => {
  const calls: Array<{ name: string; arguments: unknown[] }> = [];
  const output: string[] = [];
  const action = {
    kind: 'fund_task' as const,
    payload: { request: 'opaque' },
    signingUrl: 'https://wallet.example/approve',
    expiresAt: '2026-08-18T00:00:00Z',
  };
  const client = {
    prepareTaskFunding: async (...arguments_: unknown[]) => {
      calls.push({ name: 'fund', arguments: arguments_ });
      return action;
    },
    prepareTaskResolution: async (...arguments_: unknown[]) => {
      calls.push({ name: 'resolution', arguments: arguments_ });
      return action;
    },
    prepareTaskRejection: async (...arguments_: unknown[]) => {
      calls.push({ name: 'rejection', arguments: arguments_ });
      return { ...action, kind: 'reject_task' as const };
    },
    prepareQuote: async (...arguments_: unknown[]) => {
      calls.push({ name: 'quote', arguments: arguments_ });
      return action;
    },
    submitDelivery: async (...arguments_: unknown[]) => {
      calls.push({ name: 'delivery', arguments: arguments_ });
      return { id: 'delivery_1' };
    },
    prepareEarningsWithdrawal: async (...arguments_: unknown[]) => {
      calls.push({ name: 'withdrawal', arguments: arguments_ });
      return action;
    },
  };
  const key = 'money-action-1';

  for (const argv of [
    ['task', 'fund', 'task_1', '--idempotency-key', key],
    ['task', 'accept', 'task_1', '--idempotency-key', key],
    ['task', 'reject', 'task_1', '--idempotency-key', key],
    ['quote', 'create', '--task-id', 'task_1', '--price', '10.00', '--deadline', '2026-08-18T00:00:00Z', '--terms-hash', '0xabc', '--idempotency-key', key],
    ['deliver', 'create', '--task-id', 'task_1', '--artifact-hash', '0xdef', '--custody-receipt', 'receipt_1', '--idempotency-key', key],
    ['earnings', 'withdrawal-intent', '--destination', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '--idempotency-key', key],
  ]) {
    assert.equal(await runCli(argv, { client, stdout: (line) => output.push(line), stderr: () => undefined }), EXIT_CODE.ok);
  }

  assert.equal(calls.length, 6);
  for (const call of calls) {
    const options = call.arguments.at(-1) as { idempotencyKey?: string };
    assert.equal(options.idempotencyKey, key, `${call.name} forwards the idempotency key`);
  }
  assert.doesNotMatch(output.join('\n'), /privateKey|signTransaction|sendTransaction/i);
});

test('exposes regenerated prepared selection, settlement, and agent-node commands', async () => {
  const calls: Array<{ name: string; arguments: unknown[] }> = [];
  const action = {
    kind: 'reject_task' as const, payload: {}, signingUrl: 'https://wallet.example/approve', expiresAt: '2026-08-18T00:00:00Z',
  };
  const client = {
    prepareTaskSelection: async (...arguments_: unknown[]) => { calls.push({ name: 'select', arguments: arguments_ }); return { ...action, kind: 'select_agent' as const }; },
    prepareTaskRejection: async (...arguments_: unknown[]) => { calls.push({ name: 'reject', arguments: arguments_ }); return action; },
    prepareNodeAbandonment: async (...arguments_: unknown[]) => { calls.push({ name: 'abandon', arguments: arguments_ }); return { ...action, kind: 'abandon_node' as const }; },
    prepareNodeNonDeliveryClaim: async (...arguments_: unknown[]) => { calls.push({ name: 'claim', arguments: arguments_ }); return { ...action, kind: 'claim_non_delivery' as const }; },
    listAgentNodes: async (...arguments_: unknown[]) => { calls.push({ name: 'nodes', arguments: arguments_ }); return { data: [], nextPage: null }; },
  };
  const dependencies = { client, stdout: () => undefined, stderr: () => undefined };

  assert.equal(await runCli(['task', 'select', 'task_1', '--mode', 'auto', '--idempotency-key', 'idem-select'], dependencies), EXIT_CODE.ok);
  assert.equal(await runCli(['task', 'reject', 'task_1', '--idempotency-key', 'idem-reject'], dependencies), EXIT_CODE.ok);
  assert.equal(await runCli(['task', 'abandon', 'task_1', 'node_1', '--idempotency-key', 'idem-abandon'], dependencies), EXIT_CODE.ok);
  assert.equal(await runCli(['task', 'claim-non-delivery', 'task_1', 'node_1', '--idempotency-key', 'idem-claim'], dependencies), EXIT_CODE.ok);
  assert.equal(await runCli(['agent', 'nodes', 'agent_1', '--role', 'worker', '--state', 'delivered'], dependencies), EXIT_CODE.ok);

  assert.deepEqual(calls, [
    { name: 'select', arguments: ['task_1', { mode: 'auto' }, { idempotencyKey: 'idem-select' }] },
    { name: 'reject', arguments: ['task_1', { idempotencyKey: 'idem-reject' }] },
    { name: 'abandon', arguments: ['task_1', 'node_1', { idempotencyKey: 'idem-abandon' }] },
    { name: 'claim', arguments: ['task_1', 'node_1', { idempotencyKey: 'idem-claim' }] },
    { name: 'nodes', arguments: ['agent_1', { role: 'worker', state: 'delivered' }] },
  ]);
});

test('exposes buyer refund withdrawal and owned-agent management commands', async () => {
  const calls: Array<{ name: string; arguments: unknown[] }> = [];
  const client = {
    prepareRefundWithdrawal: async (...arguments_: unknown[]) => {
      calls.push({ name: 'refund', arguments: arguments_ });
      return { kind: 'withdraw_refund' as const, payload: {}, signingUrl: 'https://wallet.example/approve', expiresAt: '2026-08-18T00:00:00Z' };
    },
    publishAgent: async (...arguments_: unknown[]) => {
      calls.push({ name: 'publish', arguments: arguments_ });
      return { id: 'agent_1' };
    },
    setAgentAvailability: async (...arguments_: unknown[]) => {
      calls.push({ name: 'availability', arguments: arguments_ });
      return { id: 'agent_1' };
    },
  };
  const dependencies = { client, stdout: () => undefined, stderr: () => undefined };

  assert.equal(await runCli(['task', 'withdraw-refund', 'task_1', '--destination', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '--idempotency-key', 'idem-refund'], dependencies), EXIT_CODE.ok);
  assert.equal(await runCli(['agent', 'publish', '--name', 'Studio', '--agent-card-url', 'https://example.test/card', '--capability', 'design', '--capability', 'copy', '--idempotency-key', 'idem-publish'], dependencies), EXIT_CODE.ok);
  assert.equal(await runCli(['agent', 'availability', 'agent_1', '--available', 'false', '--until', '2026-08-18T00:00:00Z', '--idempotency-key', 'idem-availability'], dependencies), EXIT_CODE.ok);

  assert.deepEqual(calls, [
    { name: 'refund', arguments: ['task_1', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { idempotencyKey: 'idem-refund' }] },
    { name: 'publish', arguments: [{ name: 'Studio', agentCardUrl: 'https://example.test/card', capabilities: ['design', 'copy'] }, { idempotencyKey: 'idem-publish' }] },
    { name: 'availability', arguments: ['agent_1', { available: false, until: '2026-08-18T00:00:00Z' }, { idempotencyKey: 'idem-availability' }] },
  ]);
});

test('strips terminal control, bidi, and zero-width sequences from marketplace output', async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const ESC = String.fromCharCode(0x1b);
  const BIDI = String.fromCharCode(0x202e);
  const ZWSP = String.fromCharCode(0x200b);

  await runCli(['task', 'get', 'task_1'], {
    client: {
      getTask: async () => ({
        id: 'task_1',
        brief: `Do work${ESC}[31m${BIDI}${ZWSP} now`,
      }) as never,
    },
    stdout: (line) => output.push(line),
    stderr: () => undefined,
  });

  // A hostile upstream error reason is also sanitized before hitting the terminal.
  await runCli(['task', 'list'], {
    client: { listTasks: async () => { throw new AuthenticationError({ message: `bad${ESC}[2J key` }); } },
    stdout: () => undefined,
    stderr: (line) => errors.push(line),
  });

  const printed = output.join('\n');
  assert.equal(printed.includes(ESC), false);
  assert.equal(printed.includes(BIDI), false);
  assert.equal(printed.includes(ZWSP), false);
  assert.match(printed, /Do work now/);
  assert.equal(errors[0]?.includes(ESC), false);
  assert.equal(errors[0], 'bad key');
});

test('maps authentication and network SDK failures to stable CLI exit codes', async () => {
  const errors: string[] = [];
  const authExit = await runCli(['task', 'list'], {
    client: { listTasks: async () => { throw new AuthenticationError({ message: 'invalid key' }); } },
    stdout: () => undefined,
    stderr: (line) => errors.push(line),
  });
  const networkExit = await runCli(['task', 'list'], {
    client: { listTasks: async () => { throw new APIConnectionError({ message: 'offline' }); } },
    stdout: () => undefined,
    stderr: (line) => errors.push(line),
  });

  assert.equal(authExit, EXIT_CODE.auth);
  assert.equal(networkExit, EXIT_CODE.network);
  assert.deepEqual(errors, ['invalid key', 'offline']);
});

test('rejects pagination and tier values outside the published V1 contract before calling the SDK', async () => {
  const errors: string[] = [];
  const client = {
    listTasks: async () => ({ data: [], nextPage: null }),
    prepareTaskCreation: async () => ({ kind: 'create_task' as const, payload: {}, signingUrl: 'https://wallet.example', expiresAt: '2026-08-18T00:00:00Z' }),
  };

  const limitExit = await runCli(['task', 'list', '--limit', '0'], {
    client,
    stdout: () => undefined,
    stderr: (line) => errors.push(line),
  });
  const tierExit = await runCli([
    'task', 'create', '--brief', 'Private work.', '--budget', '10.00', '--selection-mode', 'manual', '--tier', 'confidential_hosted',
  ], {
    client,
    stdout: () => undefined,
    stderr: (line) => errors.push(line),
  });
  const windowExit = await runCli([
    'task', 'create', '--brief', 'Fast work.', '--budget', '10.00', '--selection-mode', 'manual', '--accept-window-seconds', '1',
  ], {
    client,
    stdout: () => undefined,
    stderr: (line) => errors.push(line),
  });

  assert.equal(limitExit, EXIT_CODE.user);
  assert.equal(tierExit, EXIT_CODE.user);
  assert.equal(windowExit, EXIT_CODE.user);
  assert.deepEqual(errors, [
    '--limit must be between 1 and 100.',
    '--tier must be public or private_curated in V1.',
    '--accept-window-seconds must be at least 172800.',
  ]);
});

test('validates commands and argument shape before loading API-key configuration or calling the SDK', async () => {
  const errors: string[] = [];
  const unknownCommandExit = await runCli(['unknown', 'command'], {
    environment: {}, stdout: () => undefined, stderr: (line) => errors.push(line),
  });
  const missingTaskIdExit = await runCli(['task', 'fund'], {
    environment: {}, stdout: () => undefined, stderr: (line) => errors.push(line),
  });

  let called = false;
  const unknownFlagExit = await runCli(['task', 'fund', 'task_1', '--typo', 'value'], {
    client: {
      prepareTaskFunding: async () => {
        called = true;
        return { kind: 'fund_task', payload: {}, signingUrl: 'https://wallet.example', expiresAt: '2026-08-18T00:00:00Z' };
      },
    },
    stdout: () => undefined,
    stderr: (line) => errors.push(line),
  });
  const surplusPositionalExit = await runCli(['task', 'fund', 'task_1', 'extra'], {
    client: {
      prepareTaskFunding: async () => {
        called = true;
        return { kind: 'fund_task', payload: {}, signingUrl: 'https://wallet.example', expiresAt: '2026-08-18T00:00:00Z' };
      },
    },
    stdout: () => undefined,
    stderr: (line) => errors.push(line),
  });

  assert.equal(unknownCommandExit, EXIT_CODE.user);
  assert.equal(missingTaskIdExit, EXIT_CODE.user);
  assert.equal(unknownFlagExit, EXIT_CODE.user);
  assert.equal(surplusPositionalExit, EXIT_CODE.user);
  assert.equal(called, false);
  assert.deepEqual(errors, [
    'Unknown command: unknown command. Run `goloco help` for usage.',
    'Missing required task ID.',
    '--typo is not accepted by task fund.',
    'task fund accepts exactly 1 positional argument after the command.',
  ]);
});

test('flag-only invocations reject invalid money input before attempting API authentication', async () => {
  const commonOptions = {
    cwd: repoRoot,
    env: { ...process.env, GOLOCO_API_KEY: '' },
  };

  await assert.rejects(
    execFile('pnpm', [
      'goloco', 'task', 'create',
      '--brief', 'Flag-only validation.',
      '--budget', '1.1234567',
      '--selection-mode', 'manual',
      '--idempotency-key', 'flag-only-invalid-amount',
    ], commonOptions),
    (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr ?? '', /--budget must be a decimal USDC amount\./);
      assert.doesNotMatch(error.stderr ?? '', /GOLOCO_API_KEY is required/);
      return true;
    },
  );

  await assert.rejects(
    execFile('pnpm', ['goloco', 'task', 'fund', 'task_1'], commonOptions),
    (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr ?? '', /Missing required --idempotency-key\./);
      assert.doesNotMatch(error.stderr ?? '', /GOLOCO_API_KEY is required/);
      return true;
    },
  );

  await assert.rejects(
    execFile('pnpm', ['goloco', '--typo', 'value'], commonOptions),
    (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr ?? '', /Unknown command: \(none\)\./);
      assert.doesNotMatch(error.stderr ?? '', /GOLOCO_API_KEY is required/);
      return true;
    },
  );

  await assert.rejects(
    execFile('pnpm', ['goloco', 'help', '--typo', 'value'], commonOptions),
    (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr ?? '', /help accepts no arguments or options\./);
      return true;
    },
  );
});
