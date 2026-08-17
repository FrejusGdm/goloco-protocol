import assert from 'node:assert/strict';
import test from 'node:test';
import spec from '../goloco.openapi.json' with { type: 'json' };

function resolve(reference) {
  if (!reference?.$ref) return reference;
  const [, , componentType, name] = reference.$ref.split('/');
  return spec.components[componentType][name];
}

test('binds every list operation to a resource-specific cursor page', () => {
  const listOperations = [
    ['/v1/tasks', 'TaskPage'],
    ['/v1/tasks/{task_id}/matches', 'MatchPage'],
    ['/v1/tasks/{task_id}/nodes', 'NodePage'],
    ['/v1/agents', 'AgentPage'],
    ['/v1/quotes', 'QuotePage'],
    ['/v1/deliveries', 'DeliveryPage'],
    ['/v1/receipts', 'SettlementReceiptPage'],
    ['/v1/reputation', 'ReputationPage'],
  ];

  for (const [path, pageSchema] of listOperations) {
    const response = resolve(spec.paths[path]?.get?.responses?.['200']);
    assert.equal(
      response?.content?.['application/json']?.schema?.$ref,
      `#/components/schemas/${pageSchema}`,
      `GET ${path} returns ${pageSchema}`,
    );
  }

  assert.equal(spec.components.schemas.Page, undefined);
});

test('requires idempotency for every mutation and permits OAuth authentication', () => {
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of ['post', 'put', 'patch', 'delete']) {
      const operation = pathItem[method];
      if (!operation) continue;
      assert.ok(
        operation.parameters?.some((parameter) => {
          const value = resolve(parameter);
          return value.in === 'header' && value.name === 'Idempotency-Key' && value.required;
        }),
        `${method.toUpperCase()} ${path} requires Idempotency-Key`,
      );
    }
  }

  assert.ok(spec.security.some((requirement) => Array.isArray(requirement.OAuth2)));
  assert.ok(spec.paths['/.well-known/oauth-protected-resource']);
  assert.ok(spec.paths['/v1/earnings']);
  assert.ok(spec.paths['/v1/earnings/withdrawal-intents']);
  assert.ok(spec.paths['/v1/tasks/{task_id}/nodes/{node_id}/subcontract-intents']);
});

test('models buyer task inputs and match reputation without expanding v1 tier access', () => {
  const { Task, CreateTaskRequest, Match, TaskTier, V1TaskTier, AcceptWindowSeconds, DeliveryWindowSeconds } =
    spec.components.schemas;

  for (const schema of [Task, CreateTaskRequest]) {
    assert.equal(schema.properties.title.type, 'string');
    assert.equal(schema.properties.criteria.type, 'array');
    assert.equal(schema.properties.accept_window_seconds.$ref, '#/components/schemas/AcceptWindowSeconds');
    assert.equal(schema.properties.delivery_window_seconds.$ref, '#/components/schemas/DeliveryWindowSeconds');
  }

  assert.equal(Task.properties.tier.$ref, '#/components/schemas/TaskTier');
  assert.equal(CreateTaskRequest.properties.tier.$ref, '#/components/schemas/V1TaskTier');
  assert.deepEqual(TaskTier.enum, ['public', 'private_curated', 'confidential_hosted']);
  assert.deepEqual(V1TaskTier.enum, ['public', 'private_curated']);
  assert.equal(AcceptWindowSeconds.minimum, 48 * 60 * 60);
  assert.equal(DeliveryWindowSeconds.minimum, 24 * 60 * 60);
  assert.equal(Match.properties.reputation.$ref, '#/components/schemas/ReputationSummary');
});

test('models contract-aligned settlement preparation, selection, withdrawal, and agent-node reads', () => {
  const { paths } = spec;
  for (const [path, operationId] of [
    ['/v1/tasks/{task_id}/reject-intents', 'prepareTaskRejection'],
    ['/v1/tasks/{task_id}/nodes/{node_id}/abandon-intents', 'prepareNodeAbandonment'],
    ['/v1/tasks/{task_id}/nodes/{node_id}/non-delivery-claim-intents', 'prepareNodeNonDeliveryClaim'],
  ]) {
    const operation = paths[path]?.post;
    assert.equal(operation?.operationId, operationId);
    assert.equal(resolve(operation?.responses?.['200'])?.content?.['application/json']?.schema?.$ref, '#/components/schemas/PreparedAction');
    assert.ok(operation?.parameters?.some((parameter) => resolve(parameter).name === 'Idempotency-Key'));
  }

  const selection = spec.components.schemas.SelectAgentRequest;
  assert.deepEqual(selection.required, ['mode']);
  assert.equal(selection.properties.mode.enum.includes('manual'), true);
  assert.equal(selection.properties.mode.enum.includes('auto'), true);
  assert.equal(selection.oneOf.length, 2);
  assert.deepEqual(selection.oneOf[0].required, ['mode', 'agent_id']);
  assert.deepEqual(selection.oneOf[1].not.required, ['agent_id']);

  const withdrawal = spec.components.schemas.PrepareWithdrawalRequest;
  assert.match(withdrawal.properties.destination.description, /claim holder.*chosen address/i);

  const agentNodes = paths['/v1/agents/{agent_id}/nodes']?.get;
  assert.equal(agentNodes?.operationId, 'listAgentNodes');
  assert.equal(resolve(agentNodes?.responses?.['200'])?.content?.['application/json']?.schema?.$ref, '#/components/schemas/NodePage');
  assert.deepEqual(
    agentNodes?.parameters?.map((parameter) => parameter.name ?? resolve(parameter).name),
    ['agent_id', 'cursor', 'limit', 'role', 'state'],
  );
});

test('states exact contract preconditions for settlement prepared actions', () => {
  const { paths } = spec;
  assert.match(paths['/v1/tasks/{task_id}/reject-intents'].post.description, /Delivered.*within.*accept.window/i);
  assert.match(paths['/v1/tasks/{task_id}/nodes/{node_id}/abandon-intents'].post.description, /Funded.*node worker/i);
  assert.match(paths['/v1/tasks/{task_id}/nodes/{node_id}/non-delivery-claim-intents'].post.description, /Funded.*past.*delivery deadline/i);
});

function visitResponseSchema(schema, path, visited = new Set()) {
  if (schema.$ref) {
    if (visited.has(schema.$ref)) return;
    visited.add(schema.$ref);
    visitResponseSchema(resolve(schema), schema.$ref, visited);
    return;
  }

  if (schema.type === 'object') {
    assert.notEqual(schema.additionalProperties, false, `${path} permits additive response fields`);
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      visitResponseSchema(property, `${path}.${name}`, visited);
    }
  }
  if (schema.type === 'array') visitResponseSchema(schema.items, `${path}[]`, visited);
}

test('keeps every response shape forward-compatible while request bodies remain strict', () => {
  for (const [name, response] of Object.entries(spec.components.responses)) {
    for (const mediaType of Object.values(response.content ?? {})) {
      visitResponseSchema(mediaType.schema, `response:${name}`);
    }
  }

  assert.equal(spec.components.schemas.CreateTaskRequest.additionalProperties, false);
  assert.equal(spec.components.schemas.MoneyInput.additionalProperties, false);

  const priorTaskShape = {
    id: 'task_1',
    brief: 'Original task response.',
    budget: { amount: '10.00', currency: 'USDC' },
    selection_mode: 'manual',
    status: 'open',
    created_at: '2026-08-16T00:00:00Z',
  };
  for (const required of spec.components.schemas.Task.required) {
    assert.ok(required in priorTaskShape, `prior task response includes ${required}`);
  }
});
