import assert from 'node:assert/strict';
import test from 'node:test';
import spec from '../goloco.openapi.json' with { type: 'json' };

const moneyOperations = [
  ['/v1/task-creation-intents', 'post'],
  ['/v1/tasks/{task_id}/selection-intents', 'post'],
  ['/v1/tasks/{task_id}/nodes/{node_id}/subcontract-intents', 'post'],
  ['/v1/tasks/{task_id}/funding-intents', 'post'],
  ['/v1/tasks/{task_id}/refund-withdrawal-intents', 'post'],
  ['/v1/quotes', 'post'],
  ['/v1/deliveries', 'post'],
  ['/v1/tasks/{task_id}/resolution', 'post'],
];

function resolveComponent(reference) {
  if (!reference?.$ref) return reference;
  const [, , componentType, name] = reference.$ref.split('/');
  return spec.components[componentType][name];
}

function resolveParameter(parameter) {
  return resolveComponent(parameter);
}

function resolveResponse(response) {
  return resolveComponent(response);
}

test('publishes the v1 marketplace resources and standard safety contract', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/v1/tasks']);
  assert.ok(spec.paths['/v1/agents']);
  assert.ok(spec.paths['/v1/quotes']);
  assert.ok(spec.paths['/v1/deliveries']);
  assert.ok(spec.paths['/v1/receipts']);
  assert.ok(spec.paths['/v1/reputation']);

  for (const [path, method] of moneyOperations) {
    const operation = spec.paths[path]?.[method];
    assert.ok(operation, `${method.toUpperCase()} ${path} is present`);
    assert.ok(
      operation.parameters?.some(
        (parameter) => {
          const resolved = resolveParameter(parameter);
          return (
            resolved.in === 'header' &&
            resolved.name === 'Idempotency-Key' &&
            resolved.required === true
          );
        },
      ),
      `${method.toUpperCase()} ${path} requires an Idempotency-Key`,
    );
    assert.equal(
      resolveResponse(operation.responses['200'])?.headers?.['X-Limit-Remaining']?.$ref,
      '#/components/headers/XLimitRemaining',
      `${method.toUpperCase()} ${path} reports remaining rate limit`,
    );
    assert.equal(
      resolveResponse(operation.responses['429'])?.headers?.['Retry-After']?.$ref,
      '#/components/headers/RetryAfter',
      `${method.toUpperCase()} ${path} tells clients when to retry`,
    );
  }
});

test('uses cursor pages and prepared wallet actions for money-moving flows', () => {
  for (const path of [
    '/v1/tasks',
    '/v1/agents',
    '/v1/quotes',
    '/v1/deliveries',
    '/v1/receipts',
    '/v1/reputation',
  ]) {
    const operation = spec.paths[path].get;
    assert.ok(
      operation.parameters.some(
        (parameter) => {
          const resolved = resolveParameter(parameter);
          return resolved.in === 'query' && resolved.name === 'cursor';
        },
      ),
      `GET ${path} accepts a cursor`,
    );
    assert.equal(
      resolveResponse(operation.responses['200']).content['application/json'].schema.$ref.endsWith('Page'),
      true,
      `GET ${path} returns a typed cursor page`,
    );
  }

  const preparedAction = spec.components.schemas.PreparedAction;
  assert.equal(preparedAction.required.includes('signing_url'), true);
  assert.equal(preparedAction.properties.signing_url.format, 'uri');
  assert.equal(preparedAction.properties.transaction, undefined);
  assert.deepEqual(
    ['create_task', 'select_agent', 'withdraw_refund'].every((kind) => preparedAction.properties.kind.enum.includes(kind)),
    true,
  );
});

test('exposes non-custodial buyer/worker intent endpoints returning only PreparedAction', () => {
  const createIntent = spec.paths['/v1/task-creation-intents']?.post;
  const selectIntent = spec.paths['/v1/tasks/{task_id}/selection-intents']?.post;
  const subcontractIntent = spec.paths['/v1/tasks/{task_id}/nodes/{node_id}/subcontract-intents']?.post;
  const refundIntent = spec.paths['/v1/tasks/{task_id}/refund-withdrawal-intents']?.post;

  for (const [path, operation, requestSchema] of [
    ['/v1/task-creation-intents', createIntent, '#/components/schemas/CreateTaskRequest'],
    ['/v1/tasks/{task_id}/selection-intents', selectIntent, '#/components/schemas/SelectAgentRequest'],
    ['/v1/tasks/{task_id}/nodes/{node_id}/subcontract-intents', subcontractIntent, '#/components/schemas/PrepareSubcontractRequest'],
    ['/v1/tasks/{task_id}/refund-withdrawal-intents', refundIntent, '#/components/schemas/PrepareWithdrawalRequest'],
  ]) {
    assert.ok(operation, `${path} is present`);
    assert.equal(operation.requestBody.content['application/json'].schema.$ref, requestSchema);
    assert.equal(resolveResponse(operation.responses['200']).content['application/json'].schema.$ref, '#/components/schemas/PreparedAction');
  }
});

test('removes the legacy direct-commit routes that bypassed the prepared-action boundary', () => {
  // POST /v1/tasks, POST /v1/tasks/{id}/selection, and the direct subcontract
  // route committed a resource without a wallet-reviewable action. They are gone.
  assert.equal(spec.paths['/v1/tasks'].post, undefined, 'no direct task-commit route');
  assert.equal(spec.paths['/v1/tasks/{task_id}/selection'], undefined, 'no direct selection-commit route');
  assert.equal(spec.paths['/v1/tasks/{task_id}/nodes/{node_id}/subcontracts'], undefined, 'no direct subcontract-commit route');

  // GET /v1/tasks (read) is preserved; only the POST was removed.
  assert.ok(spec.paths['/v1/tasks'].get, 'listTasks read is preserved');

  // No remaining operation returns a committed Task/Node from a mutation; the
  // subcontract route is now an intent that binds a signed quote.
  const subcontractIntent = spec.paths['/v1/tasks/{task_id}/nodes/{node_id}/subcontract-intents'].post;
  const request = spec.components.schemas.PrepareSubcontractRequest;
  assert.deepEqual(request.required, ['quote_id', 'accept_window_seconds']);
  assert.equal(request.additionalProperties, false);
  assert.equal(request.properties.accept_window_seconds.$ref, '#/components/schemas/AcceptWindowSeconds');
  assert.equal(resolveResponse(subcontractIntent.responses['200']).content['application/json'].schema.$ref, '#/components/schemas/PreparedAction');
});

test('binds a verifiable outer envelope on PreparedAction', () => {
  const action = spec.components.schemas.PreparedAction;
  for (const field of ['action_id', 'kind', 'principal', 'chain_id', 'escrow_address', 'nonce', 'request_digest', 'payload', 'signing_url', 'expires_at']) {
    assert.ok(action.required.includes(field), `PreparedAction requires ${field}`);
  }
  assert.ok(action.properties.task_id, 'binds an optional task id');
  assert.ok(action.properties.node_id, 'binds an optional node id');
  assert.ok(action.properties.kind.enum.includes('subcontract'), 'adds the subcontract kind');
  // payload stays opaque and additive.
  assert.equal(action.properties.payload.additionalProperties, true);
});

test('models operation-level OAuth scopes for least privilege', () => {
  const scopes = spec.components.securitySchemes.OAuth2.flows.authorizationCode.scopes;
  assert.deepEqual(Object.keys(scopes).sort(), ['agent-owner', 'buyer', 'read', 'worker']);

  const scopeOf = (operation) => operation.security.find((requirement) => requirement.OAuth2)?.OAuth2 ?? [];
  assert.deepEqual(scopeOf(spec.paths['/v1/tasks'].get), ['read']);
  assert.deepEqual(scopeOf(spec.paths['/v1/task-creation-intents'].post), ['buyer']);
  assert.deepEqual(scopeOf(spec.paths['/v1/tasks/{task_id}/funding-intents'].post), ['buyer']);
  assert.deepEqual(scopeOf(spec.paths['/v1/quotes'].post), ['worker']);
  assert.deepEqual(scopeOf(spec.paths['/v1/tasks/{task_id}/nodes/{node_id}/subcontract-intents'].post), ['worker']);
  assert.deepEqual(scopeOf(spec.paths['/v1/agents'].post), ['agent-owner']);
  assert.deepEqual(scopeOf(spec.paths['/v1/agents/{agent_id}/nodes'].get), ['agent-owner']);

  // No operation requires an unconstrained read+write pair anymore.
  for (const pathItem of Object.values(spec.paths)) {
    for (const operation of Object.values(pathItem)) {
      if (!operation.security) continue;
      const oauth = operation.security.find((requirement) => requirement.OAuth2)?.OAuth2;
      if (oauth) assert.equal(oauth.length, 1, `${operation.operationId} requires exactly one scope`);
    }
  }
});

test('documents the idempotency-key namespace and >=128-bit entropy', () => {
  const description = spec.components.parameters.IdempotencyKey.description;
  assert.match(description, /authenticated principal/i);
  assert.match(description, /operation id/i);
  assert.match(description, /digest/i);
  assert.match(description, /409/);
  assert.match(description, /128/);
});

test('tightens MoneyInput and subcontract/quote constraints to protocol constants', () => {
  const moneyInput = spec.components.schemas.MoneyInput;
  const positive = new RegExp(moneyInput.properties.amount.pattern);
  assert.equal(positive.test('0'), false, 'zero is rejected');
  assert.equal(positive.test('0.000000'), false, 'zero with decimals is rejected');
  assert.equal(positive.test('0.000001'), true, 'a positive fraction is accepted');
  assert.equal(positive.test('1.000000'), true, 'a positive amount is accepted');

  assert.equal(spec.components.schemas.AcceptWindowSeconds.minimum, 48 * 60 * 60);
  assert.equal(spec.components.schemas.DeliveryWindowSeconds.minimum, 24 * 60 * 60);
  assert.equal(spec.components.schemas.CreateQuoteRequest.properties.price.$ref, '#/components/schemas/MoneyInput');
  // Relational protocol constants (min node amount, child<=parent deadline) are documented.
  assert.match(spec.paths['/v1/tasks/{task_id}/nodes/{node_id}/subcontract-intents'].post.description, /MIN_NODE_AMOUNT/);
  assert.match(spec.paths['/v1/tasks/{task_id}/nodes/{node_id}/subcontract-intents'].post.description, /parent\.delivery_deadline/);
});
