import type {
  DeliveryInput,
  ListOptions,
  MarketplaceApi,
  Money,
  QuoteInput,
  RequestOptions,
  TaskInput,
} from '../../sdk/src/index.js';

export interface StandardSchema<Input = unknown> {
  '~standard': {
    version: 1;
    vendor: string;
    validate(value: unknown): { value: Input } | { issues: readonly StandardSchemaIssue[] };
  };
}

export interface StandardSchemaIssue {
  message: string;
  path?: readonly PropertyKey[];
}

export interface McpTool {
  name: McpToolName;
  description: string;
  inputSchema: StandardSchema;
  jsonSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
  kind: 'resource' | 'prepared_action';
}

export type McpToolName =
  | 'post_task'
  | 'list_tasks'
  | 'get_task'
  | 'get_task_matches'
  | 'get_agent_nodes'
  | 'hire_agent'
  | 'fund_task'
  | 'submit_quote'
  | 'submit_delivery'
  | 'resolve_task'
  | 'reject_task'
  | 'abandon_node'
  | 'claim_non_delivery'
  | 'get_earnings'
  | 'withdraw_earnings'
  | 'withdraw_refund'
  | 'publish_agent'
  | 'set_agent_availability';

export interface McpDependencies {
  client: MarketplaceApi;
}

export interface McpToolResult {
  kind: 'resource' | 'prepared_action';
  value: unknown;
}

export class McpToolInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'McpToolInputError';
  }
}

export class McpToolNotFoundError extends Error {
  public constructor(name: string) {
    super(`Unknown MCP tool: ${name}.`);
    this.name = 'McpToolNotFoundError';
  }
}

type InputParser = (value: unknown) => Record<string, unknown>;

const allowedFields: Record<McpToolName, readonly string[]> = {
  post_task: ['brief', 'budget', 'selectionMode', 'title', 'criteria', 'acceptWindowSeconds', 'deliveryWindowSeconds', 'tier', 'deadline', 'idempotencyKey'],
  list_tasks: ['cursor', 'limit'],
  get_task: ['taskId'],
  get_task_matches: ['taskId', 'cursor', 'limit'],
  get_agent_nodes: ['agentId', 'cursor', 'limit', 'role', 'state'],
  hire_agent: ['taskId', 'mode', 'agentId', 'idempotencyKey'],
  fund_task: ['taskId', 'idempotencyKey'],
  submit_quote: ['taskId', 'price', 'deadline', 'termsHash', 'idempotencyKey'],
  submit_delivery: ['taskId', 'artifactHash', 'custodyReceipt', 'idempotencyKey'],
  resolve_task: ['taskId', 'resolution', 'idempotencyKey'],
  reject_task: ['taskId', 'idempotencyKey'],
  abandon_node: ['taskId', 'nodeId', 'idempotencyKey'],
  claim_non_delivery: ['taskId', 'nodeId', 'idempotencyKey'],
  get_earnings: [],
  withdraw_earnings: ['destination', 'idempotencyKey'],
  withdraw_refund: ['taskId', 'destination', 'idempotencyKey'],
  publish_agent: ['name', 'agentCardUrl', 'capabilities', 'idempotencyKey'],
  set_agent_availability: ['agentId', 'available', 'until', 'idempotencyKey'],
};

const parsers: Record<McpToolName, InputParser> = {
  post_task: parseTaskInput,
  list_tasks: parseListInput,
  get_task: (value) => ({ taskId: requiredString(value, 'taskId') }),
  get_task_matches: parseTaskListInput,
  get_agent_nodes: parseAgentNodeListInput,
  hire_agent: parseSelectionInput,
  fund_task: (value) => ({ taskId: requiredString(value, 'taskId'), ...mutationOptions(value) }),
  submit_quote: parseQuoteInput,
  submit_delivery: parseDeliveryInput,
  resolve_task: parseResolutionInput,
  reject_task: (value) => ({ taskId: requiredString(value, 'taskId'), ...mutationOptions(value) }),
  abandon_node: parseNodeActionInput,
  claim_non_delivery: parseNodeActionInput,
  get_earnings: parseEmptyInput,
  withdraw_earnings: (value) => ({
    destination: requiredString(value, 'destination'),
    ...mutationOptions(value),
  }),
  withdraw_refund: (value) => ({
    taskId: requiredString(value, 'taskId'), destination: requiredString(value, 'destination'), ...mutationOptions(value),
  }),
  publish_agent: parsePublishAgentInput,
  set_agent_availability: parseAvailabilityInput,
};

function schemaFor(name: McpToolName): StandardSchema {
  return {
    '~standard': {
      version: 1,
      vendor: 'goloco',
      validate(value) {
        try {
          rejectUnknownFields(name, value);
          return { value: parsers[name](value) };
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : 'Invalid input.' }] };
        }
      },
    },
  };
}

function tool(
  name: McpToolName,
  description: string,
  kind: McpTool['kind'],
  readOnlyHint: boolean,
  jsonSchema: Record<string, unknown>,
): McpTool {
  return {
    name,
    description,
    inputSchema: schemaFor(name),
    jsonSchema,
    annotations: { readOnlyHint, destructiveHint: false, idempotentHint: true },
    kind,
  };
}

const identifier = { type: 'string', minLength: 1 };
const idempotency = { type: 'string', minLength: 1, description: 'Stable key supplied by the agent for this logical mutation.' };
const money = {
  type: 'object',
  required: ['amount', 'currency'],
  additionalProperties: false,
  properties: { amount: { type: 'string' }, currency: { const: 'USDC' } },
};

/**
 * Coarse, composable tools registered from the OpenAPI-backed client surface.
 * Any wallet-affecting operation returns a prepared action for external approval.
 */
export const MCP_TOOLS: readonly McpTool[] = [
  tool('post_task', 'Prepare a buyer task creation approval; never signs it.', 'prepared_action', false, {
    type: 'object', required: ['brief', 'budget', 'selectionMode', 'idempotencyKey'],
    additionalProperties: false,
    properties: {
      brief: { type: 'string' }, budget: money, selectionMode: { enum: ['manual', 'auto'] },
      title: { type: 'string' }, criteria: { type: 'array', items: { type: 'string' } },
      acceptWindowSeconds: { type: 'integer', minimum: 172800 }, deliveryWindowSeconds: { type: 'integer', minimum: 86400 },
      tier: { enum: ['public', 'private_curated'] }, deadline: { type: 'string' }, idempotencyKey: idempotency,
    },
  }),
  tool('list_tasks', 'List visible tasks.', 'resource', true, {
    type: 'object', additionalProperties: false,
    properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
  }),
  tool('get_task', 'Get a task and its tree status.', 'resource', true, {
    type: 'object', required: ['taskId'], additionalProperties: false, properties: { taskId: identifier },
  }),
  tool('get_task_matches', 'List ranked agents for a task.', 'resource', true, {
    type: 'object', required: ['taskId'], additionalProperties: false,
    properties: { taskId: identifier, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
  }),
  tool('get_agent_nodes', 'List an agent\'s escrow-node inbox.', 'resource', true, {
    type: 'object', required: ['agentId'], additionalProperties: false,
    properties: { agentId: identifier, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, role: { enum: ['worker', 'hirer'] }, state: { enum: ['funded', 'delivered', 'released', 'refunded'] } },
  }),
  tool('hire_agent', 'Prepare an agent selection approval; never signs it.', 'prepared_action', false, {
    type: 'object', required: ['taskId', 'mode', 'idempotencyKey'], additionalProperties: false,
    properties: { taskId: identifier, mode: { enum: ['manual', 'auto'] }, agentId: identifier, idempotencyKey: idempotency },
    oneOf: [{ properties: { mode: { const: 'manual' } }, required: ['mode', 'agentId'] }, { properties: { mode: { const: 'auto' } }, not: { required: ['agentId'] } }],
  }),
  tool('fund_task', 'Prepare a task funding approval; never signs it.', 'prepared_action', false, {
    type: 'object', required: ['taskId', 'idempotencyKey'], additionalProperties: false,
    properties: { taskId: identifier, idempotencyKey: idempotency },
  }),
  tool('submit_quote', 'Prepare a quote approval; never signs it.', 'prepared_action', false, {
    type: 'object', required: ['taskId', 'price', 'deadline', 'termsHash', 'idempotencyKey'], additionalProperties: false,
    properties: { taskId: identifier, price: money, deadline: { type: 'string' }, termsHash: { type: 'string' }, idempotencyKey: idempotency },
  }),
  tool('submit_delivery', 'Submit a completed delivery receipt.', 'resource', false, {
    type: 'object', required: ['taskId', 'artifactHash', 'custodyReceipt', 'idempotencyKey'], additionalProperties: false,
    properties: { taskId: identifier, artifactHash: { type: 'string' }, custodyReceipt: { type: 'string' }, idempotencyKey: idempotency },
  }),
  tool('resolve_task', 'Prepare the buyer\'s delivery-acceptance approval; never signs it.', 'prepared_action', false, {
    type: 'object', required: ['taskId', 'resolution', 'idempotencyKey'], additionalProperties: false,
    properties: { taskId: identifier, resolution: { const: 'accept' }, idempotencyKey: idempotency },
  }),
  tool('reject_task', 'Prepare the buyer\'s post-delivery rejection approval; never signs it.', 'prepared_action', false, {
    type: 'object', required: ['taskId', 'idempotencyKey'], additionalProperties: false,
    properties: { taskId: identifier, idempotencyKey: idempotency },
  }),
  tool('abandon_node', 'Prepare a node worker\'s abandonment approval; never signs it.', 'prepared_action', false, {
    type: 'object', required: ['taskId', 'nodeId', 'idempotencyKey'], additionalProperties: false,
    properties: { taskId: identifier, nodeId: identifier, idempotencyKey: idempotency },
  }),
  tool('claim_non_delivery', 'Prepare an anyone-callable expired non-delivery claim; never signs it.', 'prepared_action', false, {
    type: 'object', required: ['taskId', 'nodeId', 'idempotencyKey'], additionalProperties: false,
    properties: { taskId: identifier, nodeId: identifier, idempotencyKey: idempotency },
  }),
  tool('get_earnings', 'Get pending and claimable earnings.', 'resource', true, {
    type: 'object', additionalProperties: false, properties: {},
  }),
  tool('withdraw_earnings', 'Prepare an earnings withdrawal approval; never signs it.', 'prepared_action', false, {
    type: 'object', required: ['destination', 'idempotencyKey'], additionalProperties: false,
    properties: { destination: { type: 'string' }, idempotencyKey: idempotency },
  }),
  tool('withdraw_refund', 'Prepare a buyer refund withdrawal approval; never signs it.', 'prepared_action', false, {
    type: 'object', required: ['taskId', 'destination', 'idempotencyKey'], additionalProperties: false,
    properties: { taskId: identifier, destination: { type: 'string' }, idempotencyKey: idempotency },
  }),
  tool('publish_agent', 'Publish an owned agent profile.', 'resource', false, {
    type: 'object', required: ['name', 'agentCardUrl', 'idempotencyKey'], additionalProperties: false,
    properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, agentCardUrl: { type: 'string' }, capabilities: { type: 'array', items: { type: 'string' } }, idempotencyKey: idempotency },
  }),
  tool('set_agent_availability', 'Set an owned agent availability state.', 'resource', false, {
    type: 'object', required: ['agentId', 'available', 'idempotencyKey'], additionalProperties: false,
    properties: { agentId: identifier, available: { type: 'boolean' }, until: { type: 'string' }, idempotencyKey: idempotency },
  }),
] as const;

export async function invokeMcpTool(
  name: string,
  input: unknown,
  dependencies: McpDependencies,
): Promise<McpToolResult> {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new McpToolNotFoundError(name);

  const validated = tool.inputSchema['~standard'].validate(input);
  if ('issues' in validated) throw new McpToolInputError(validated.issues[0]?.message ?? 'Invalid tool input.');
  const value = validated.value as Record<string, unknown>;
  const client = dependencies.client;

  switch (tool.name) {
    case 'post_task':
      return preparedAction(await client.prepareTaskCreation(taskInput(value), requestOptions(value)));
    case 'list_tasks':
      return resource(await client.listTasks(listOptions(value)));
    case 'get_task':
      return resource(await client.getTask(value.taskId as string));
    case 'get_task_matches':
      return resource(await client.listTaskMatches(value.taskId as string, listOptions(value)));
    case 'get_agent_nodes':
      return resource(await client.listAgentNodes(value.agentId as string, agentNodeListOptions(value)));
    case 'hire_agent':
      return preparedAction(await client.prepareTaskSelection(
        value.taskId as string,
        value.mode === 'manual' ? { mode: 'manual', agentId: value.agentId as string } : { mode: 'auto' },
        requestOptions(value),
      ));
    case 'fund_task':
      return preparedAction(await client.prepareTaskFunding(value.taskId as string, requestOptions(value)));
    case 'submit_quote':
      return preparedAction(await client.prepareQuote(quoteInput(value), requestOptions(value)));
    case 'submit_delivery':
      return resource(await client.submitDelivery(deliveryInput(value), requestOptions(value)));
    case 'resolve_task':
      return preparedAction(await client.prepareTaskResolution(
        value.taskId as string,
        value.resolution as 'accept',
        requestOptions(value),
      ));
    case 'reject_task':
      return preparedAction(await client.prepareTaskRejection(value.taskId as string, requestOptions(value)));
    case 'abandon_node':
      return preparedAction(await client.prepareNodeAbandonment(
        value.taskId as string, value.nodeId as string, requestOptions(value),
      ));
    case 'claim_non_delivery':
      return preparedAction(await client.prepareNodeNonDeliveryClaim(
        value.taskId as string, value.nodeId as string, requestOptions(value),
      ));
    case 'get_earnings':
      return resource(await client.getEarnings());
    case 'withdraw_earnings':
      return preparedAction(await client.prepareEarningsWithdrawal(value.destination as string, requestOptions(value)));
    case 'withdraw_refund':
      return preparedAction(await client.prepareRefundWithdrawal(
        value.taskId as string, value.destination as string, requestOptions(value),
      ));
    case 'publish_agent':
      return resource(await client.publishAgent(publishAgentInput(value), requestOptions(value)));
    case 'set_agent_availability':
      return resource(await client.setAgentAvailability(
        value.agentId as string, availabilityInput(value), requestOptions(value),
      ));
  }
}

function resource(value: unknown): McpToolResult {
  return { kind: 'resource', value };
}

function preparedAction(value: unknown): McpToolResult {
  return { kind: 'prepared_action', value };
}

function parseTaskInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  const selectionMode = requiredString(input, 'selectionMode');
  if (selectionMode !== 'manual' && selectionMode !== 'auto') {
    throw new McpToolInputError('selectionMode must be manual or auto.');
  }
  const parsed: Record<string, unknown> = {
    brief: requiredString(input, 'brief'),
    budget: moneyInput(input.budget),
    selectionMode,
    ...mutationOptions(input),
  };
  const title = optionalString(input, 'title');
  if (title !== undefined) parsed.title = title;
  if (input.criteria !== undefined) parsed.criteria = stringList(input.criteria, 'criteria');
  if (input.acceptWindowSeconds !== undefined) {
    parsed.acceptWindowSeconds = integer(input.acceptWindowSeconds, 'acceptWindowSeconds', 172800, Number.MAX_SAFE_INTEGER);
  }
  if (input.deliveryWindowSeconds !== undefined) {
    parsed.deliveryWindowSeconds = integer(input.deliveryWindowSeconds, 'deliveryWindowSeconds', 86400, Number.MAX_SAFE_INTEGER);
  }
  const tier = optionalString(input, 'tier');
  if (tier !== undefined) {
    if (tier !== 'public' && tier !== 'private_curated') {
      throw new McpToolInputError('tier must be public or private_curated.');
    }
    parsed.tier = tier;
  }
  const deadline = optionalString(input, 'deadline');
  if (deadline !== undefined) parsed.deadline = deadline;
  return parsed;
}

function parseListInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  return { ...listOptions(input) };
}

function parseTaskListInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  return { taskId: requiredString(input, 'taskId'), ...listOptions(input) };
}

function parseAgentNodeListInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  const role = optionalString(input, 'role');
  if (role !== undefined && role !== 'worker' && role !== 'hirer') {
    throw new McpToolInputError('role must be worker or hirer.');
  }
  const state = optionalString(input, 'state');
  if (state !== undefined && !['funded', 'delivered', 'released', 'refunded'].includes(state)) {
    throw new McpToolInputError('state must be funded, delivered, released, or refunded.');
  }
  return { agentId: requiredString(input, 'agentId'), ...listOptions(input), ...(role === undefined ? {} : { role }), ...(state === undefined ? {} : { state }) };
}

function parseSelectionInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  const mode = requiredString(input, 'mode');
  if (mode === 'manual') {
    return { taskId: requiredString(input, 'taskId'), mode, agentId: requiredString(input, 'agentId'), ...mutationOptions(input) };
  }
  if (mode === 'auto') {
    if (input.agentId !== undefined) throw new McpToolInputError('agentId must be omitted for automatic selection.');
    return { taskId: requiredString(input, 'taskId'), mode, ...mutationOptions(input) };
  }
  throw new McpToolInputError('mode must be manual or auto.');
}

function parsePublishAgentInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  const capabilities = input.capabilities === undefined ? undefined : stringList(input.capabilities, 'capabilities');
  return {
    name: requiredString(input, 'name'),
    agentCardUrl: requiredString(input, 'agentCardUrl'),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...mutationOptions(input),
  };
}

function parseAvailabilityInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  if (typeof input.available !== 'boolean') throw new McpToolInputError('available must be a boolean.');
  const until = optionalString(input, 'until');
  return {
    agentId: requiredString(input, 'agentId'), available: input.available,
    ...(until === undefined ? {} : { until }), ...mutationOptions(input),
  };
}

function parseNodeActionInput(value: unknown): Record<string, unknown> {
  return { taskId: requiredString(value, 'taskId'), nodeId: requiredString(value, 'nodeId'), ...mutationOptions(value) };
}

function parseQuoteInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  return {
    taskId: requiredString(input, 'taskId'),
    price: moneyInput(input.price),
    deadline: requiredString(input, 'deadline'),
    termsHash: requiredString(input, 'termsHash'),
    ...mutationOptions(input),
  };
}

function parseDeliveryInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  return {
    taskId: requiredString(input, 'taskId'),
    artifactHash: requiredString(input, 'artifactHash'),
    custodyReceipt: requiredString(input, 'custodyReceipt'),
    ...mutationOptions(input),
  };
}

function parseResolutionInput(value: unknown): Record<string, unknown> {
  const input = record(value);
  const resolution = requiredString(input, 'resolution');
  if (resolution !== 'accept') {
    throw new McpToolInputError('resolution must be accept; use reject_task for post-delivery rejection.');
  }
  return { taskId: requiredString(input, 'taskId'), resolution, ...mutationOptions(input) };
}

function parseEmptyInput(value: unknown): Record<string, never> {
  record(value);
  return {};
}

function taskInput(value: Record<string, unknown>): TaskInput {
  const { idempotencyKey: _idempotencyKey, ...input } = value;
  return input as unknown as TaskInput;
}

function publishAgentInput(value: Record<string, unknown>) {
  const { idempotencyKey: _idempotencyKey, ...input } = value;
  return input as { name: string; agentCardUrl: string; capabilities?: string[] };
}

function availabilityInput(value: Record<string, unknown>) {
  const { agentId: _agentId, idempotencyKey: _idempotencyKey, ...input } = value;
  return input as { available: boolean; until?: string };
}

function quoteInput(value: Record<string, unknown>): QuoteInput {
  const { idempotencyKey: _idempotencyKey, ...input } = value;
  return input as unknown as QuoteInput;
}

function deliveryInput(value: Record<string, unknown>): DeliveryInput {
  const { idempotencyKey: _idempotencyKey, ...input } = value;
  return input as unknown as DeliveryInput;
}

function listOptions(value: Record<string, unknown>): ListOptions {
  const cursor = optionalString(value, 'cursor');
  const limit = value.limit === undefined ? undefined : integer(value.limit, 'limit', 1, 100);
  return { ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) };
}

function agentNodeListOptions(value: Record<string, unknown>) {
  const { agentId: _agentId, ...options } = value;
  return options;
}

function requestOptions(value: Record<string, unknown>): RequestOptions {
  return { idempotencyKey: requiredString(value, 'idempotencyKey') };
}

function mutationOptions(value: unknown): Record<string, string> {
  return { idempotencyKey: requiredString(record(value), 'idempotencyKey') };
}

function moneyInput(value: unknown): Money {
  const input = record(value);
  rejectExtraFields(input, ['amount', 'currency'], 'Money');
  const amount = requiredString(input, 'amount');
  if (!/^[0-9]+(?:\.[0-9]{1,6})?$/.test(amount)) {
    throw new McpToolInputError('budget amount must be a decimal USDC amount.');
  }
  if (input.currency !== 'USDC') throw new McpToolInputError('budget currency must be USDC.');
  return { amount, currency: 'USDC' };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpToolInputError('Tool input must be an object.');
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(name: McpToolName, value: unknown): void {
  const input = record(value);
  rejectExtraFields(input, allowedFields[name], name);
}

function rejectExtraFields(
  input: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const permitted = new Set(allowed);
  for (const field of Object.keys(input)) {
    if (!permitted.has(field)) {
      throw new McpToolInputError(`${field} is not accepted by ${location}.`);
    }
  }
}

function requiredString(value: unknown, name: string): string {
  const candidate = record(value)[name];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new McpToolInputError(`${name} is required.`);
  }
  return candidate;
}

function optionalString(value: unknown, name: string): string | undefined {
  const candidate = record(value)[name];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new McpToolInputError(`${name} must be a non-empty string.`);
  }
  return candidate;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < minimum || value > maximum) {
    throw new McpToolInputError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new McpToolInputError(`${name} must be a list of non-empty strings.`);
  }
  return value;
}
