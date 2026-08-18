import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  FetchTransport,
  GolocoClient,
  PreparedActionKindError,
  type ApiTransport,
  type TransportRequest,
} from '../src/index.ts';

class SpyTransport implements ApiTransport {
  public readonly requests: TransportRequest[] = [];
  private failuresRemaining = 0;
  private response: unknown = {};

  public failNextRequests(count: number): void {
    this.failuresRemaining = count;
  }

  public respondWith(response: unknown): void {
    this.response = response;
  }

  public async request<Response>(request: TransportRequest): Promise<Response> {
    this.requests.push(request);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new APIConnectionError({ message: 'offline' });
    }
    return this.response as Response;
  }
}

test('maps public task, quote, and delivery inputs to strict OpenAPI wire bodies', async () => {
  const transport = new SpyTransport();
  const client = new GolocoClient(transport, {
    idempotencyKeyFactory: () => 'idem-fixed',
    maxRetries: 0,
  });

  transport.respondWith({
    kind: 'create_task', payload: {}, signing_url: 'https://wallet.example/approve', expires_at: '2026-08-18T00:00:00Z',
  });
  await client.prepareTaskCreation({
    brief: 'Design a package.',
    title: 'Brand system',
    criteria: ['Use the approved color palette.'],
    budget: { amount: '400.00', currency: 'USDC' },
    selectionMode: 'auto',
    acceptWindowSeconds: 172800,
    deliveryWindowSeconds: 86400,
    tier: 'private_curated',
    deadline: '2026-08-18T00:00:00Z',
  });
  assert.deepEqual(transport.requests[0].body, {
    brief: 'Design a package.',
    title: 'Brand system',
    criteria: ['Use the approved color palette.'],
    budget: { amount: '400.00', currency: 'USDC' },
    selection_mode: 'auto',
    accept_window_seconds: 172800,
    delivery_window_seconds: 86400,
    tier: 'private_curated',
    deadline: '2026-08-18T00:00:00Z',
  });
  assert.equal(transport.requests[0].path, '/v1/task-creation-intents');

  transport.respondWith({
    kind: 'submit_quote', payload: {}, signing_url: 'https://wallet.example/approve', expires_at: '2026-08-18T00:00:00Z',
  });
  await client.prepareQuote({
    taskId: 'task_1',
    price: { amount: '120.00', currency: 'USDC' },
    deadline: '2026-08-18T00:00:00Z',
    termsHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.deepEqual(transport.requests[1].body, {
    task_id: 'task_1',
    price: { amount: '120.00', currency: 'USDC' },
    deadline: '2026-08-18T00:00:00Z',
    terms_hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });

  transport.respondWith({ id: 'delivery_1' });
  await client.submitDelivery({
    taskId: 'task_1',
    artifactHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    custodyReceipt: 'receipt_1',
  });
  assert.deepEqual(transport.requests[2].body, {
    task_id: 'task_1',
    artifact_hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    custody_receipt: 'receipt_1',
  });
  assert.equal(transport.requests[0].headers['Idempotency-Key'], 'idem-fixed');
  assert.equal(transport.requests[0].headers['Goloco-Version'], '2026-08-16');
});

test('rejects a prepared action whose kind does not match the requested intent', async () => {
  const transport = new SpyTransport();
  transport.respondWith({
    kind: 'withdraw_earnings',
    payload: { request: 'opaque' },
    signing_url: 'https://wallet.example/approve',
    expires_at: '2026-08-18T00:00:00Z',
  });
  const client = new GolocoClient(transport, { idempotencyKeyFactory: () => 'idem-mismatch', maxRetries: 0 });

  await assert.rejects(
    () => client.prepareTaskFunding('task_1'),
    (error: unknown) => {
      assert.ok(error instanceof PreparedActionKindError);
      assert.equal(error.expected, 'fund_task');
      assert.equal(error.received, 'withdraw_earnings');
      return true;
    },
  );
});

test('decodes the verifiable PreparedAction envelope from the wire', async () => {
  const transport = new SpyTransport();
  transport.respondWith({
    kind: 'fund_task',
    payload: { request: 'opaque' },
    signing_url: 'https://wallet.example/approve',
    expires_at: '2026-08-18T00:00:00Z',
    action_id: 'action_1',
    principal: 'principal_1',
    wallet_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    task_id: 'task_1',
    chain_id: 8453,
    escrow_address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    nonce: 'nonce_1',
    request_digest: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  });
  const client = new GolocoClient(transport, { idempotencyKeyFactory: () => 'idem-envelope', maxRetries: 0 });

  const action = await client.prepareTaskFunding('task_1');
  assert.equal(action.kind, 'fund_task');
  assert.equal(action.actionId, 'action_1');
  assert.equal(action.principal, 'principal_1');
  assert.equal(action.taskId, 'task_1');
  assert.equal(action.chainId, 8453);
  assert.equal(action.escrowAddress, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(action.nonce, 'nonce_1');
  assert.equal(action.requestDigest, '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
});

test('prepares a quote-bound subcontract intent', async () => {
  const transport = new SpyTransport();
  transport.respondWith({
    kind: 'subcontract', payload: { request: 'opaque' },
    signing_url: 'https://wallet.example/approve', expires_at: '2026-08-18T00:00:00Z',
  });
  const client = new GolocoClient(transport, { idempotencyKeyFactory: () => 'idem-subcontract', maxRetries: 0 });

  const action = await client.prepareSubcontract('task_1', 'node_1', { quoteId: 'quote_1', acceptWindowSeconds: 172800 });
  assert.equal(action.kind, 'subcontract');
  assert.equal(transport.requests[0].path, '/v1/tasks/task_1/nodes/node_1/subcontract-intents');
  assert.deepEqual(transport.requests[0].body, { quote_id: 'quote_1', accept_window_seconds: 172800 });
});

test('maps a prepared-action response from the OpenAPI wire format', async () => {
  const transport = new SpyTransport();
  transport.respondWith({
    kind: 'fund_task',
    payload: { request: 'opaque' },
    signing_url: 'https://wallet.example/approve',
    expires_at: '2026-08-18T00:00:00Z',
  });
  const client = new GolocoClient(transport, { idempotencyKeyFactory: () => 'idem-response' });

  const action = await client.prepareTaskFunding('task_1');

  assert.deepEqual(action, {
    kind: 'fund_task',
    payload: { request: 'opaque' },
    signingUrl: 'https://wallet.example/approve',
    expiresAt: '2026-08-18T00:00:00Z',
  });
});

test('reuses one generated idempotency key over a retryable logical money request', async () => {
  const transport = new SpyTransport();
  transport.respondWith({
    kind: 'fund_task', payload: {}, signing_url: 'https://wallet.example/approve', expires_at: '2026-08-18T00:00:00Z',
  });
  transport.failNextRequests(1);
  const client = new GolocoClient(transport, {
    idempotencyKeyFactory: () => 'idem-replayed',
    maxRetries: 1,
  });

  await client.prepareTaskFunding('task_1');

  assert.equal(transport.requests.length, 2);
  assert.equal(transport.requests[0].headers['Idempotency-Key'], 'idem-replayed');
  assert.equal(transport.requests[1].headers['Idempotency-Key'], 'idem-replayed');
});

test('allows a per-request API version without altering the request body', async () => {
  const transport = new SpyTransport();
  transport.respondWith({
    kind: 'resolve_task', payload: {}, signing_url: 'https://wallet.example/approve', expires_at: '2026-08-18T00:00:00Z',
  });
  const client = new GolocoClient(transport, { idempotencyKeyFactory: () => 'idem-version' });

  await client.prepareTaskResolution('task_1', 'accept', { apiVersion: '2026-09-01' });

  assert.deepEqual(transport.requests[0].body, { resolution: 'accept' });
  assert.equal(transport.requests[0].headers['Goloco-Version'], '2026-09-01');
});

test('rejects unsafe non-accept resolution input before dispatching transport', async () => {
  const transport = new SpyTransport();
  const client = new GolocoClient(transport);
  const unsafeResolution = client.prepareTaskResolution.bind(client) as unknown as (
    taskId: string,
    resolution: string,
  ) => Promise<unknown>;

  assert.throws(
    () => unsafeResolution('task_1', 'reject'),
    /only supports accept/i,
  );
  assert.equal(transport.requests.length, 0);
});

test('maps an HTTP 408 response to APIConnectionTimeoutError', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 'request_timeout', reason: 'The request timed out.' },
  }), { status: 408, headers: { 'content-type': 'application/json' } });

  try {
    const transport = new FetchTransport('https://api.example.test');
    await assert.rejects(
      transport.request({ method: 'GET', path: '/v1/tasks', headers: {} }),
      APIConnectionTimeoutError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uses typed SDK helpers for task reads, cursor pages, earnings, and withdrawal intents', async () => {
  const transport = new SpyTransport();
  transport.respondWith({
    data: [{
      id: 'task_1',
      brief: 'Design a brand system.',
      budget: { amount: '400.00', currency: 'USDC' },
      selection_mode: 'auto',
      status: 'open',
      created_at: '2026-08-16T00:00:00Z',
    }],
    next_page: 'cursor_2',
  });
  const client = new GolocoClient(transport, { maxRetries: 0 });

  const page = await client.listTasks({ cursor: 'cursor_1' });
  assert.deepEqual(page, {
    data: [{
      id: 'task_1',
      brief: 'Design a brand system.',
      budget: { amount: '400.00', currency: 'USDC' },
      selectionMode: 'auto',
      status: 'open',
      createdAt: '2026-08-16T00:00:00Z',
    }],
    nextPage: 'cursor_2',
  });
  assert.equal(transport.requests[0].path, '/v1/tasks?cursor=cursor_1');
  assert.equal(transport.requests[0].headers['Idempotency-Key'], undefined);

  transport.respondWith({ pending: '5.00', claimable: '4.00', currency: 'USDC' });
  assert.deepEqual(await client.getEarnings(), { pending: '5.00', claimable: '4.00', currency: 'USDC' });
  assert.equal(transport.requests[1].path, '/v1/earnings');

  transport.respondWith({
    kind: 'withdraw_earnings',
    payload: { request: 'opaque' },
    signing_url: 'https://wallet.example/approve',
    expires_at: '2026-08-18T00:00:00Z',
  });
  await client.prepareEarningsWithdrawal('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.deepEqual(transport.requests[2], {
    method: 'POST',
    path: '/v1/earnings/withdrawal-intents',
    headers: {
      'Goloco-Version': '2026-08-16',
      'Idempotency-Key': transport.requests[2].headers['Idempotency-Key'],
    },
    body: { destination: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  });
});

test('prepares buyer state-changing actions and exposes agent owner mutations', async () => {
  const transport = new SpyTransport();
  const client = new GolocoClient(transport, {
    idempotencyKeyFactory: () => 'idem-sdk-gaps',
    maxRetries: 0,
  });
  transport.respondWith({
    kind: 'create_task', payload: { request: 'opaque' },
    signing_url: 'https://wallet.example/approve', expires_at: '2026-08-18T00:00:00Z',
  });
  await client.prepareTaskCreation({
    brief: 'Design a package.', budget: { amount: '400.00', currency: 'USDC' }, selectionMode: 'auto',
  });
  assert.equal(transport.requests.at(-1)?.path, '/v1/task-creation-intents');
  assert.equal(transport.requests.at(-1)?.headers['Idempotency-Key'], 'idem-sdk-gaps');

  transport.respondWith({
    kind: 'select_agent', payload: { request: 'opaque' },
    signing_url: 'https://wallet.example/approve', expires_at: '2026-08-18T00:00:00Z',
  });
  await client.prepareTaskSelection('task_1', { mode: 'manual', agentId: 'agent_1' });
  assert.deepEqual(transport.requests.at(-1)?.body, { mode: 'manual', agent_id: 'agent_1' });
  assert.equal(transport.requests.at(-1)?.path, '/v1/tasks/task_1/selection-intents');

  transport.respondWith({
    kind: 'withdraw_refund', payload: { request: 'opaque' },
    signing_url: 'https://wallet.example/approve', expires_at: '2026-08-18T00:00:00Z',
  });
  await client.prepareRefundWithdrawal('task_1', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.deepEqual(transport.requests.at(-1)?.body, { destination: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.equal(transport.requests.at(-1)?.path, '/v1/tasks/task_1/refund-withdrawal-intents');

  transport.respondWith({
    id: 'agent_1', name: 'Design Studio', status: 'active', capabilities: ['design'], available: true,
    created_at: '2026-08-16T00:00:00Z',
  });
  assert.equal((await client.publishAgent({ name: 'Design Studio', agentCardUrl: 'https://example.test/card' })).id, 'agent_1');
  assert.deepEqual(transport.requests.at(-1)?.body, { name: 'Design Studio', agent_card_url: 'https://example.test/card' });
  await client.setAgentAvailability('agent_1', { available: false, until: '2026-08-18T00:00:00Z' });
  assert.equal(transport.requests.at(-1)?.path, '/v1/agents/agent_1/availability');
  assert.deepEqual(transport.requests.at(-1)?.body, { available: false, until: '2026-08-18T00:00:00Z' });
});

test('uses spec-aligned helpers for task matches and manual selection', async () => {
  const transport = new SpyTransport();
  const client = new GolocoClient(transport, {
    idempotencyKeyFactory: () => 'idem-selection',
    maxRetries: 0,
  });

  transport.respondWith({
    data: [{
      agent: {
        id: 'agent_1',
        name: 'Brand Studio',
        status: 'active',
        capabilities: ['brand'],
        created_at: '2026-08-16T00:00:00Z',
      },
      score: 0.9,
      rank: 1,
      reputation: { score: 0.8, independence_confidence: 0.7 },
    }],
    next_page: 'cursor_2',
  });

  assert.deepEqual(await client.listTaskMatches('task_1', { cursor: 'cursor_1' }), {
    data: [{
      agent: {
        id: 'agent_1',
        name: 'Brand Studio',
        status: 'active',
        capabilities: ['brand'],
        createdAt: '2026-08-16T00:00:00Z',
      },
      score: 0.9,
      rank: 1,
      reputation: { score: 0.8, independenceConfidence: 0.7 },
    }],
    nextPage: 'cursor_2',
  });
  assert.equal(transport.requests[0].path, '/v1/tasks/task_1/matches?cursor=cursor_1');

  transport.respondWith({
    kind: 'select_agent', payload: { request: 'opaque' },
    signing_url: 'https://wallet.example/approve', expires_at: '2026-08-18T00:00:00Z',
  });
  assert.equal((await client.prepareTaskSelection('task_1', { mode: 'manual', agentId: 'agent_1' })).kind, 'select_agent');
  assert.equal(transport.requests[1].path, '/v1/tasks/task_1/selection-intents');
  assert.deepEqual(transport.requests[1].body, { mode: 'manual', agent_id: 'agent_1' });
  assert.equal(transport.requests[1].headers['Idempotency-Key'], 'idem-selection');
});

test('prepares contract-aligned settlement actions and reads an agent node inbox', async () => {
  const transport = new SpyTransport();
  const client = new GolocoClient(transport, {
    idempotencyKeyFactory: () => 'idem-settlement',
    maxRetries: 0,
  });

  for (const [call, path, kind] of [
    [() => client.prepareTaskRejection('task_1'), '/v1/tasks/task_1/reject-intents', 'reject_task'],
    [() => client.prepareNodeAbandonment('task_1', 'node_1'), '/v1/tasks/task_1/nodes/node_1/abandon-intents', 'abandon_node'],
    [() => client.prepareNodeNonDeliveryClaim('task_1', 'node_1'), '/v1/tasks/task_1/nodes/node_1/non-delivery-claim-intents', 'claim_non_delivery'],
  ] as const) {
    transport.respondWith({
      kind, payload: { request: 'opaque' },
      signing_url: 'https://wallet.example/approve', expires_at: '2026-08-18T00:00:00Z',
    });
    await call();
    assert.equal(transport.requests.at(-1)?.path, path);
    assert.equal(transport.requests.at(-1)?.headers['Idempotency-Key'], 'idem-settlement');
  }

  transport.respondWith({ data: [{
    id: 'node_1', task_id: 'task_1', parent_node_id: null, hirer_agent_id: 'buyer_1', worker_agent_id: 'agent_1',
    amount: { amount: '20.00', currency: 'USDC' }, state: 'delivered', delivery_deadline: '2026-08-18T00:00:00Z', accept_window_seconds: 172800,
  }], next_page: null });
  assert.equal((await client.listAgentNodes('agent_1', { role: 'worker', state: 'delivered' })).data[0]?.workerAgentId, 'agent_1');
  assert.equal(transport.requests.at(-1)?.path, '/v1/agents/agent_1/nodes?role=worker&state=delivered');

  transport.respondWith({
    kind: 'select_agent', payload: { request: 'opaque' },
    signing_url: 'https://wallet.example/approve', expires_at: '2026-08-18T00:00:00Z',
  });
  await client.prepareTaskSelection('task_1', { mode: 'auto' });
  assert.deepEqual(transport.requests.at(-1)?.body, { mode: 'auto' });
});
