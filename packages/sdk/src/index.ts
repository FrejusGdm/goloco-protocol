export type Identifier = string;

export const DEFAULT_API_VERSION = '2026-08-16';

export interface Money {
  amount: string;
  currency: 'USDC';
}

/**
 * The wallet actions this client can prepare. Kept as a named union so request
 * call sites stay strict while response typing can still tolerate unknown future
 * kinds (see {@link PreparedActionKind}).
 */
export type KnownPreparedActionKind =
  | 'create_task'
  | 'select_agent'
  | 'fund_task'
  | 'submit_quote'
  | 'subcontract'
  | 'resolve_task'
  | 'reject_task'
  | 'abandon_node'
  | 'claim_non_delivery'
  | 'withdraw_earnings'
  | 'withdraw_refund';

/**
 * Response-side kind: additive API versions may introduce new action kinds, so
 * a decoded PreparedAction tolerates unknown strings. The known members stay for
 * autocomplete. Request inputs remain strict on {@link KnownPreparedActionKind}.
 */
export type PreparedActionKind = KnownPreparedActionKind | (string & {});

export interface PreparedAction {
  kind: PreparedActionKind;
  payload: Record<string, unknown>;
  signingUrl: string;
  expiresAt: string;
  /** Server-assigned unique id; the escrow nonce is consumed once against it. */
  actionId?: string;
  /** The authenticated principal this action was prepared for. */
  principal?: string;
  /** The wallet expected to sign, when known. */
  walletAddress?: string;
  /** The bound task, when the action targets a task. */
  taskId?: Identifier;
  /** The bound node, when the action targets a node. */
  nodeId?: Identifier;
  /** EIP-155 chain id the action targets (Base mainnet is 8453). */
  chainId?: number;
  /** The escrow contract (per-tree clone) the signed action authorizes. */
  escrowAddress?: string;
  /** Single-use nonce the escrow consumes exactly once for this action. */
  nonce?: string;
  /** Digest of the originating request body, so the caller can confirm binding. */
  requestDigest?: string;
}

interface PreparedActionWire {
  kind: string;
  payload: Record<string, unknown>;
  signing_url: string;
  expires_at: string;
  action_id?: string;
  principal?: string;
  wallet_address?: string;
  task_id?: Identifier;
  node_id?: Identifier;
  chain_id?: number;
  escrow_address?: string;
  nonce?: string;
  request_digest?: string;
}

/**
 * Raised when a prepared action returned by the API does not match the intent
 * the SDK requested (for example a funding intent that resolves to a withdrawal
 * payload). Signing such an action would present an unexpected wallet approval,
 * so the SDK rejects it before it ever reaches a wallet.
 */
export class PreparedActionKindError extends Error {
  public readonly expected: KnownPreparedActionKind;
  public readonly received: string;

  public constructor(expected: KnownPreparedActionKind, received: string) {
    super(
      `Prepared action kind mismatch: requested "${expected}" but the API returned "${received}". Refusing to present an unexpected wallet action.`,
    );
    this.name = 'PreparedActionKindError';
    this.expected = expected;
    this.received = received;
  }
}

export interface TaskInput {
  brief: string;
  budget: Money;
  selectionMode: 'manual' | 'auto';
  title?: string;
  criteria?: string[];
  acceptWindowSeconds?: number;
  deliveryWindowSeconds?: number;
  tier?: 'public' | 'private_curated';
  deadline?: string;
}

export interface Task {
  id: Identifier;
  brief: string;
  budget: Money;
  selectionMode: 'manual' | 'auto';
  status: string;
  createdAt: string;
  title?: string;
  criteria?: string[];
  acceptWindowSeconds?: number;
  deliveryWindowSeconds?: number;
  tier?: 'public' | 'private_curated' | 'confidential_hosted';
  selectedAgentId?: Identifier;
}

interface TaskWire {
  id: Identifier;
  brief: string;
  budget: Money;
  selection_mode: Task['selectionMode'];
  status: string;
  created_at: string;
  title?: string;
  criteria?: string[];
  accept_window_seconds?: number;
  delivery_window_seconds?: number;
  tier?: Task['tier'];
  selected_agent_id?: Identifier;
}

interface AgentWire {
  id: Identifier;
  name: string;
  status: Agent['status'];
  capabilities: string[];
  available?: boolean;
  created_at: string;
}

interface ReputationSummaryWire {
  score: number;
  independence_confidence?: number;
  settled_value?: Money;
}

interface TaskMatchWire {
  agent: AgentWire;
  score: number;
  rank: number;
  reputation?: ReputationSummaryWire;
  reason?: string;
}

export interface CursorPage<Item> {
  data: Item[];
  nextPage: string | null;
}

interface CursorPageWire<Item> {
  data: Item[];
  next_page: string | null;
}

export interface Earnings {
  pending: string;
  claimable: string;
  currency: 'USDC';
}

/** Response-side agent lifecycle status. Extensible: unknown future values are tolerated. */
export type AgentStatus = 'active' | 'inactive' | 'retired' | (string & {});

export interface Agent {
  id: Identifier;
  name: string;
  status: AgentStatus;
  capabilities: string[];
  available?: boolean;
  createdAt: string;
}

export interface ReputationSummary {
  score: number;
  independenceConfidence?: number;
  settledValue?: Money;
}

export interface TaskMatch {
  agent: Agent;
  score: number;
  rank: number;
  reputation?: ReputationSummary;
  reason?: string;
}

export type SelectAgentInput =
  | { mode: 'manual'; agentId: Identifier }
  | { mode: 'auto' };

export interface PublishAgentInput {
  name: string;
  agentCardUrl: string;
  capabilities?: string[];
}

export interface SetAvailabilityInput {
  available: boolean;
  until?: string;
}

/** Response-side node lifecycle state. Extensible: unknown future values are tolerated. */
export type NodeState = 'funded' | 'delivered' | 'released' | 'refunded' | (string & {});

export interface Node {
  id: Identifier;
  taskId: Identifier;
  parentNodeId: Identifier | null;
  hirerAgentId: Identifier;
  workerAgentId: Identifier;
  amount: Money;
  state: NodeState;
  deliveryDeadline: string;
  acceptWindowSeconds: number;
  artifactHash?: string;
}

interface NodeWire {
  id: Identifier;
  task_id: Identifier;
  parent_node_id: Identifier | null;
  hirer_agent_id: Identifier;
  worker_agent_id: Identifier;
  amount: Money;
  state: Node['state'];
  delivery_deadline: string;
  accept_window_seconds: number;
  artifact_hash?: string;
}

export interface QuoteInput {
  taskId: Identifier;
  price: Money;
  deadline: string;
  termsHash: string;
}

export interface DeliveryInput {
  taskId: Identifier;
  artifactHash: string;
  custodyReceipt: string;
}

export interface SubcontractInput {
  /**
   * An accepted, unexpired, child-worker-signed quote. The child node's worker,
   * amount, delivery deadline, and terms are bound from this quote; they are not
   * caller-controlled fields.
   */
  quoteId: Identifier;
  /** Child-node acceptance window; V1 minimum is 48 hours (172800 seconds). */
  acceptWindowSeconds: number;
}

export interface RequestOptions {
  apiVersion?: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  maxRetries?: number;
}

export interface ListOptions {
  apiVersion?: string;
  headers?: Record<string, string>;
  maxRetries?: number;
  cursor?: string;
  limit?: number;
}

export interface NodeListOptions extends ListOptions {
  role?: 'worker' | 'hirer';
  // Request-side filter stays strict on the known node states.
  state?: 'funded' | 'delivered' | 'released' | 'refunded';
}

export interface TransportRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface ApiTransport {
  request<Response>(request: TransportRequest): Promise<Response>;
}

export interface APIErrorOptions {
  message: string;
  status?: number;
  code?: string;
  requestID?: string;
  response?: unknown;
}

export class APIError extends Error {
  public readonly status?: number;
  public readonly code?: string;
  public readonly requestID?: string;
  public readonly response?: unknown;

  public constructor(options: APIErrorOptions) {
    super(options.message);
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
    this.requestID = options.requestID;
    this.response = options.response;
  }
}

export class BadRequestError extends APIError {}
export class AuthenticationError extends APIError {}
export class PermissionDeniedError extends APIError {}
export class NotFoundError extends APIError {}
export class ConflictError extends APIError {}
export class UnprocessableEntityError extends APIError {}
export class RateLimitError extends APIError {}
export class InternalServerError extends APIError {}
export class APIConnectionError extends APIError {}
export class APIConnectionTimeoutError extends APIConnectionError {}

export interface GolocoClientOptions {
  apiVersion?: string;
  idempotencyKeyFactory?: () => string;
  maxRetries?: number;
}

export interface MarketplaceApi {
  prepareTaskCreation(input: TaskInput, options?: RequestOptions): Promise<PreparedAction>;
  listTasks(options?: ListOptions): Promise<CursorPage<Task>>;
  getTask(taskId: Identifier, options?: RequestOptions): Promise<Task>;
  listTaskMatches(taskId: Identifier, options?: ListOptions): Promise<CursorPage<TaskMatch>>;
  prepareTaskSelection(taskId: Identifier, selection: SelectAgentInput, options?: RequestOptions): Promise<PreparedAction>;
  prepareSubcontract(taskId: Identifier, nodeId: Identifier, input: SubcontractInput, options?: RequestOptions): Promise<PreparedAction>;
  listAgentNodes(agentId: Identifier, options?: NodeListOptions): Promise<CursorPage<Node>>;
  publishAgent(input: PublishAgentInput, options?: RequestOptions): Promise<Agent>;
  setAgentAvailability(agentId: Identifier, input: SetAvailabilityInput, options?: RequestOptions): Promise<Agent>;
  prepareTaskFunding(taskId: Identifier, options?: RequestOptions): Promise<PreparedAction>;
  prepareTaskRejection(taskId: Identifier, options?: RequestOptions): Promise<PreparedAction>;
  prepareNodeAbandonment(taskId: Identifier, nodeId: Identifier, options?: RequestOptions): Promise<PreparedAction>;
  prepareNodeNonDeliveryClaim(taskId: Identifier, nodeId: Identifier, options?: RequestOptions): Promise<PreparedAction>;
  prepareQuote(input: QuoteInput, options?: RequestOptions): Promise<PreparedAction>;
  submitDelivery(input: DeliveryInput, options?: RequestOptions): Promise<unknown>;
  getEarnings(options?: RequestOptions): Promise<Earnings>;
  prepareEarningsWithdrawal(destination: string, options?: RequestOptions): Promise<PreparedAction>;
  prepareRefundWithdrawal(taskId: Identifier, destination: string, options?: RequestOptions): Promise<PreparedAction>;
  prepareTaskResolution(
    taskId: Identifier,
    resolution: 'accept',
    options?: RequestOptions,
  ): Promise<PreparedAction>;
}

/**
 * Thin, generated-shape wrapper over the OpenAPI contract. Wallet-affecting
 * methods return a prepared action; wallet approval stays outside this client.
 */
export class GolocoClient implements MarketplaceApi {
  public readonly tasks: {
    prepareCreation: GolocoClient['prepareTaskCreation'];
    list: GolocoClient['listTasks'];
    get: GolocoClient['getTask'];
    listMatches: GolocoClient['listTaskMatches'];
    prepareSelection: GolocoClient['prepareTaskSelection'];
    prepareSubcontract: GolocoClient['prepareSubcontract'];
    prepareFunding: GolocoClient['prepareTaskFunding'];
    prepareResolution: GolocoClient['prepareTaskResolution'];
    prepareRejection: GolocoClient['prepareTaskRejection'];
    prepareNodeAbandonment: GolocoClient['prepareNodeAbandonment'];
    prepareNodeNonDeliveryClaim: GolocoClient['prepareNodeNonDeliveryClaim'];
  };
  public readonly agents: {
    listNodes: GolocoClient['listAgentNodes'];
    publish: GolocoClient['publishAgent'];
    setAvailability: GolocoClient['setAgentAvailability'];
  };
  public readonly quotes: { prepare: GolocoClient['prepareQuote'] };
  public readonly deliveries: { submit: GolocoClient['submitDelivery'] };
  public readonly earnings: {
    get: GolocoClient['getEarnings'];
    prepareWithdrawal: GolocoClient['prepareEarningsWithdrawal'];
    prepareRefundWithdrawal: GolocoClient['prepareRefundWithdrawal'];
  };
  private readonly apiVersion: string;
  private readonly idempotencyKeyFactory: () => string;
  private readonly maxRetries: number;

  public constructor(
    private readonly transport: ApiTransport,
    options: GolocoClientOptions = {},
  ) {
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.idempotencyKeyFactory = options.idempotencyKeyFactory ?? defaultIdempotencyKey;
    this.maxRetries = options.maxRetries ?? 2;
    this.tasks = {
      prepareCreation: this.prepareTaskCreation.bind(this),
      list: this.listTasks.bind(this),
      get: this.getTask.bind(this),
      listMatches: this.listTaskMatches.bind(this),
      prepareSelection: this.prepareTaskSelection.bind(this),
      prepareSubcontract: this.prepareSubcontract.bind(this),
      prepareFunding: this.prepareTaskFunding.bind(this),
      prepareResolution: this.prepareTaskResolution.bind(this),
      prepareRejection: this.prepareTaskRejection.bind(this),
      prepareNodeAbandonment: this.prepareNodeAbandonment.bind(this),
      prepareNodeNonDeliveryClaim: this.prepareNodeNonDeliveryClaim.bind(this),
    };
    this.agents = {
      listNodes: this.listAgentNodes.bind(this),
      publish: this.publishAgent.bind(this),
      setAvailability: this.setAgentAvailability.bind(this),
    };
    this.quotes = { prepare: this.prepareQuote.bind(this) };
    this.deliveries = { submit: this.submitDelivery.bind(this) };
    this.earnings = {
      get: this.getEarnings.bind(this),
      prepareWithdrawal: this.prepareEarningsWithdrawal.bind(this),
      prepareRefundWithdrawal: this.prepareRefundWithdrawal.bind(this),
    };
  }

  public prepareTaskCreation(
    input: TaskInput,
    options: RequestOptions = {},
  ): Promise<PreparedAction> {
    return this.mutate<PreparedActionWire>(
      { method: 'POST', path: '/v1/task-creation-intents', body: toCreateTaskWire(input) },
      options,
    ).then(preparedActionMapper('create_task'));
  }

  public listTasks(options: ListOptions = {}): Promise<CursorPage<Task>> {
    return this.read<CursorPageWire<TaskWire>>(
      { method: 'GET', path: withQuery('/v1/tasks', options), },
      options,
    ).then(fromTaskPageWire);
  }

  public getTask(taskId: Identifier, options: RequestOptions = {}): Promise<Task> {
    return this.read<TaskWire>({ method: 'GET', path: `/v1/tasks/${taskId}` }, options).then(fromTaskWire);
  }

  public listTaskMatches(
    taskId: Identifier,
    options: ListOptions = {},
  ): Promise<CursorPage<TaskMatch>> {
    return this.read<CursorPageWire<TaskMatchWire>>(
      { method: 'GET', path: withQuery(`/v1/tasks/${taskId}/matches`, options) },
      options,
    ).then(fromTaskMatchPageWire);
  }

  public prepareTaskSelection(
    taskId: Identifier,
    selection: SelectAgentInput,
    options: RequestOptions = {},
  ): Promise<PreparedAction> {
    return this.mutate<PreparedActionWire>(
      {
        method: 'POST', path: `/v1/tasks/${taskId}/selection-intents`, body: toSelectionWire(selection),
      },
      options,
    ).then(preparedActionMapper('select_agent'));
  }

  public prepareSubcontract(
    taskId: Identifier,
    nodeId: Identifier,
    input: SubcontractInput,
    options: RequestOptions = {},
  ): Promise<PreparedAction> {
    return this.mutate<PreparedActionWire>(
      {
        method: 'POST',
        path: `/v1/tasks/${taskId}/nodes/${nodeId}/subcontract-intents`,
        body: toSubcontractWire(input),
      },
      options,
    ).then(preparedActionMapper('subcontract'));
  }

  public listAgentNodes(
    agentId: Identifier,
    options: NodeListOptions = {},
  ): Promise<CursorPage<Node>> {
    return this.read<CursorPageWire<NodeWire>>(
      { method: 'GET', path: withNodeQuery(`/v1/agents/${agentId}/nodes`, options) },
      options,
    ).then(fromNodePageWire);
  }

  public publishAgent(
    input: PublishAgentInput,
    options: RequestOptions = {},
  ): Promise<Agent> {
    return this.mutate<AgentWire>(
      { method: 'POST', path: '/v1/agents', body: toPublishAgentWire(input) },
      options,
    ).then(fromAgentWire);
  }

  public setAgentAvailability(
    agentId: Identifier,
    input: SetAvailabilityInput,
    options: RequestOptions = {},
  ): Promise<Agent> {
    return this.mutate<AgentWire>(
      { method: 'PUT', path: `/v1/agents/${agentId}/availability`, body: toAvailabilityWire(input) },
      options,
    ).then(fromAgentWire);
  }

  public prepareTaskFunding(
    taskId: Identifier,
    options: RequestOptions = {},
  ): Promise<PreparedAction> {
    return this.mutate<PreparedActionWire>(
      { method: 'POST', path: `/v1/tasks/${taskId}/funding-intents` },
      options,
    ).then(preparedActionMapper('fund_task'));
  }

  public prepareTaskRejection(
    taskId: Identifier,
    options: RequestOptions = {},
  ): Promise<PreparedAction> {
    return this.mutate<PreparedActionWire>(
      { method: 'POST', path: `/v1/tasks/${taskId}/reject-intents` }, options,
    ).then(preparedActionMapper('reject_task'));
  }

  public prepareNodeAbandonment(
    taskId: Identifier,
    nodeId: Identifier,
    options: RequestOptions = {},
  ): Promise<PreparedAction> {
    return this.mutate<PreparedActionWire>(
      { method: 'POST', path: `/v1/tasks/${taskId}/nodes/${nodeId}/abandon-intents` }, options,
    ).then(preparedActionMapper('abandon_node'));
  }

  public prepareNodeNonDeliveryClaim(
    taskId: Identifier,
    nodeId: Identifier,
    options: RequestOptions = {},
  ): Promise<PreparedAction> {
    return this.mutate<PreparedActionWire>(
      { method: 'POST', path: `/v1/tasks/${taskId}/nodes/${nodeId}/non-delivery-claim-intents` }, options,
    ).then(preparedActionMapper('claim_non_delivery'));
  }

  public prepareQuote(input: QuoteInput, options: RequestOptions = {}): Promise<PreparedAction> {
    return this.mutate<PreparedActionWire>(
      { method: 'POST', path: '/v1/quotes', body: toQuoteWire(input) },
      options,
    ).then(preparedActionMapper('submit_quote'));
  }

  public submitDelivery(input: DeliveryInput, options: RequestOptions = {}): Promise<unknown> {
    return this.mutate({ method: 'POST', path: '/v1/deliveries', body: toDeliveryWire(input) }, options);
  }

  public getEarnings(options: RequestOptions = {}): Promise<Earnings> {
    return this.read<Earnings>({ method: 'GET', path: '/v1/earnings' }, options);
  }

  public prepareEarningsWithdrawal(
    destination: string,
    options: RequestOptions = {},
  ): Promise<PreparedAction> {
    return this.mutate<PreparedActionWire>(
      { method: 'POST', path: '/v1/earnings/withdrawal-intents', body: { destination } },
      options,
    ).then(preparedActionMapper('withdraw_earnings'));
  }

  public prepareRefundWithdrawal(
    taskId: Identifier,
    destination: string,
    options: RequestOptions = {},
  ): Promise<PreparedAction> {
    return this.mutate<PreparedActionWire>(
      { method: 'POST', path: `/v1/tasks/${taskId}/refund-withdrawal-intents`, body: { destination } },
      options,
    ).then(preparedActionMapper('withdraw_refund'));
  }

  public prepareTaskResolution(
    taskId: Identifier,
    resolution: 'accept',
    options: RequestOptions = {},
  ): Promise<PreparedAction> {
    if (resolution !== 'accept') {
      throw new TypeError('prepareTaskResolution only supports accept; use prepareTaskRejection instead.');
    }
    return this.mutate<PreparedActionWire>(
      {
        method: 'POST',
        path: `/v1/tasks/${taskId}/resolution`,
        body: { resolution: 'accept' },
      },
      options,
    ).then(preparedActionMapper('resolve_task'));
  }

  private async mutate<Response>(
    request: Omit<TransportRequest, 'headers'>,
    options: RequestOptions,
  ): Promise<Response> {
    const idempotencyKey = options.idempotencyKey ?? this.idempotencyKeyFactory();
    const transportRequest: TransportRequest = {
      ...request,
      headers: {
        'Goloco-Version': options.apiVersion ?? this.apiVersion,
        'Idempotency-Key': idempotencyKey,
        ...options.headers,
      },
    };
    const retries = options.maxRetries ?? this.maxRetries;
    let attempt = 0;
    while (true) {
      try {
        return await this.transport.request<Response>(transportRequest);
      } catch (error) {
        if (attempt >= retries || !isRetryable(error)) throw error;
        attempt += 1;
      }
    }
  }

  private async read<Response>(
    request: Omit<TransportRequest, 'headers'>,
    options: Pick<RequestOptions, 'apiVersion' | 'headers' | 'maxRetries'>,
  ): Promise<Response> {
    const transportRequest: TransportRequest = {
      ...request,
      headers: {
        'Goloco-Version': options.apiVersion ?? this.apiVersion,
        ...options.headers,
      },
    };
    const retries = options.maxRetries ?? this.maxRetries;
    let attempt = 0;
    while (true) {
      try {
        return await this.transport.request<Response>(transportRequest);
      } catch (error) {
        if (attempt >= retries || !isRetryable(error)) throw error;
        attempt += 1;
      }
    }
  }
}

export class FetchTransport implements ApiTransport {
  public constructor(
    private readonly baseURL: string,
    private readonly apiKey?: string,
    private readonly requestInit: RequestInit = {},
  ) {}

  public async request<Result>(request: TransportRequest): Promise<Result> {
    let response: Response;
    try {
      response = await fetch(new URL(request.path, this.baseURL), {
        ...this.requestInit,
        method: request.method,
        headers: {
          Accept: 'application/json',
          ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.apiKey === undefined ? {} : { 'X-Api-Key': this.apiKey }),
          ...request.headers,
          ...this.requestInit.headers,
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new APIConnectionTimeoutError({ message: cause.message });
      }
      throw new APIConnectionError({ message: cause instanceof Error ? cause.message : 'Network request failed.' });
    }

    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw errorFromResponse(response.status, payload, response.headers.get('x-request-id'));
    return payload as Result;
  }
}

function toCreateTaskWire(input: TaskInput) {
  return {
    brief: input.brief,
    budget: input.budget,
    selection_mode: input.selectionMode,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.criteria === undefined ? {} : { criteria: input.criteria }),
    ...(input.acceptWindowSeconds === undefined ? {} : { accept_window_seconds: input.acceptWindowSeconds }),
    ...(input.deliveryWindowSeconds === undefined ? {} : { delivery_window_seconds: input.deliveryWindowSeconds }),
    ...(input.tier === undefined ? {} : { tier: input.tier }),
    ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
  };
}

function toSelectionWire(input: SelectAgentInput) {
  return {
    mode: input.mode,
    ...(input.mode === 'manual' ? { agent_id: input.agentId } : {}),
  };
}

function toPublishAgentWire(input: PublishAgentInput) {
  return {
    name: input.name,
    agent_card_url: input.agentCardUrl,
    ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
  };
}

function toAvailabilityWire(input: SetAvailabilityInput) {
  return {
    available: input.available,
    ...(input.until === undefined ? {} : { until: input.until }),
  };
}

function fromTaskWire(response: TaskWire): Task {
  return {
    id: response.id,
    brief: response.brief,
    budget: response.budget,
    selectionMode: response.selection_mode,
    status: response.status,
    createdAt: response.created_at,
    ...(response.title === undefined ? {} : { title: response.title }),
    ...(response.criteria === undefined ? {} : { criteria: response.criteria }),
    ...(response.accept_window_seconds === undefined ? {} : { acceptWindowSeconds: response.accept_window_seconds }),
    ...(response.delivery_window_seconds === undefined ? {} : { deliveryWindowSeconds: response.delivery_window_seconds }),
    ...(response.tier === undefined ? {} : { tier: response.tier }),
    ...(response.selected_agent_id === undefined ? {} : { selectedAgentId: response.selected_agent_id }),
  };
}

function fromTaskPageWire(response: CursorPageWire<TaskWire>): CursorPage<Task> {
  return { data: response.data.map(fromTaskWire), nextPage: response.next_page };
}

function fromAgentWire(response: AgentWire): Agent {
  return {
    id: response.id,
    name: response.name,
    status: response.status,
    capabilities: response.capabilities,
    ...(response.available === undefined ? {} : { available: response.available }),
    createdAt: response.created_at,
  };
}

function fromTaskMatchWire(response: TaskMatchWire): TaskMatch {
  return {
    agent: fromAgentWire(response.agent),
    score: response.score,
    rank: response.rank,
    ...(response.reputation === undefined ? {} : {
      reputation: {
        score: response.reputation.score,
        ...(response.reputation.independence_confidence === undefined
          ? {}
          : { independenceConfidence: response.reputation.independence_confidence }),
        ...(response.reputation.settled_value === undefined
          ? {}
          : { settledValue: response.reputation.settled_value }),
      },
    }),
    ...(response.reason === undefined ? {} : { reason: response.reason }),
  };
}

function fromTaskMatchPageWire(response: CursorPageWire<TaskMatchWire>): CursorPage<TaskMatch> {
  return { data: response.data.map(fromTaskMatchWire), nextPage: response.next_page };
}

function fromNodeWire(response: NodeWire): Node {
  return {
    id: response.id,
    taskId: response.task_id,
    parentNodeId: response.parent_node_id,
    hirerAgentId: response.hirer_agent_id,
    workerAgentId: response.worker_agent_id,
    amount: response.amount,
    state: response.state,
    deliveryDeadline: response.delivery_deadline,
    acceptWindowSeconds: response.accept_window_seconds,
    ...(response.artifact_hash === undefined ? {} : { artifactHash: response.artifact_hash }),
  };
}

function fromNodePageWire(response: CursorPageWire<NodeWire>): CursorPage<Node> {
  return { data: response.data.map(fromNodeWire), nextPage: response.next_page };
}

function withQuery(path: string, options: Pick<ListOptions, 'cursor' | 'limit'>): string {
  const query = new URLSearchParams();
  if (options.cursor !== undefined) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.toString();
  return suffix === '' ? path : `${path}?${suffix}`;
}

function withNodeQuery(path: string, options: NodeListOptions): string {
  const query = new URLSearchParams();
  if (options.cursor !== undefined) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.role !== undefined) query.set('role', options.role);
  if (options.state !== undefined) query.set('state', options.state);
  const suffix = query.toString();
  return suffix === '' ? path : `${path}?${suffix}`;
}

function toQuoteWire(input: QuoteInput) {
  return {
    task_id: input.taskId,
    price: input.price,
    deadline: input.deadline,
    terms_hash: input.termsHash,
  };
}

function toDeliveryWire(input: DeliveryInput) {
  return {
    task_id: input.taskId,
    artifact_hash: input.artifactHash,
    custody_receipt: input.custodyReceipt,
  };
}

function toSubcontractWire(input: SubcontractInput) {
  return {
    quote_id: input.quoteId,
    accept_window_seconds: input.acceptWindowSeconds,
  };
}

/**
 * Returns a mapper that decodes the wire prepared action and rejects it unless
 * its kind matches the intent the caller invoked. This is the client-side guard
 * for a compromised or confused prepare service returning a different action.
 */
function preparedActionMapper(
  expected: KnownPreparedActionKind,
): (response: PreparedActionWire) => PreparedAction {
  return (response) => fromPreparedActionWire(response, expected);
}

function fromPreparedActionWire(
  response: PreparedActionWire,
  expected: KnownPreparedActionKind,
): PreparedAction {
  if (response.kind !== expected) {
    throw new PreparedActionKindError(expected, String(response.kind));
  }
  return {
    kind: response.kind,
    payload: response.payload,
    signingUrl: response.signing_url,
    expiresAt: response.expires_at,
    ...(response.action_id === undefined ? {} : { actionId: response.action_id }),
    ...(response.principal === undefined ? {} : { principal: response.principal }),
    ...(response.wallet_address === undefined ? {} : { walletAddress: response.wallet_address }),
    ...(response.task_id === undefined ? {} : { taskId: response.task_id }),
    ...(response.node_id === undefined ? {} : { nodeId: response.node_id }),
    ...(response.chain_id === undefined ? {} : { chainId: response.chain_id }),
    ...(response.escrow_address === undefined ? {} : { escrowAddress: response.escrow_address }),
    ...(response.nonce === undefined ? {} : { nonce: response.nonce }),
    ...(response.request_digest === undefined ? {} : { requestDigest: response.request_digest }),
  };
}

function defaultIdempotencyKey(): string {
  return crypto.randomUUID();
}

function isRetryable(error: unknown): boolean {
  return error instanceof APIConnectionError ||
    (error instanceof APIError && error.status !== undefined && [408, 409, 429].includes(error.status)) ||
    (error instanceof APIError && (error.status ?? 0) >= 500);
}

function errorFromResponse(status: number, body: unknown, requestID: string | null): APIError {
  const errorBody = body as { error?: { code?: string; reason?: string } } | undefined;
  const options: APIErrorOptions = {
    message: errorBody?.error?.reason ?? `Request failed with status ${status}.`,
    status,
    code: errorBody?.error?.code,
    requestID: requestID ?? undefined,
    response: body,
  };
  if (status === 400) return new BadRequestError(options);
  if (status === 401) return new AuthenticationError(options);
  if (status === 403) return new PermissionDeniedError(options);
  if (status === 404) return new NotFoundError(options);
  if (status === 408) return new APIConnectionTimeoutError(options);
  if (status === 409) return new ConflictError(options);
  if (status === 422) return new UnprocessableEntityError(options);
  if (status === 429) return new RateLimitError(options);
  if (status >= 500) return new InternalServerError(options);
  return new APIError(options);
}

// ---------------------------------------------------------------------------
// Untrusted-text hardening (shared by the CLI and MCP presentation layers).
//
// Marketplace text (task briefs, agent names, receipts) and reflected upstream
// error text are attacker-controlled. Before such text is written to a terminal
// or handed to another agent it must be stripped of terminal/agent control
// sequences and, for agent contexts, fenced as data. See API red-team #9.
// ---------------------------------------------------------------------------

// Full ANSI escape sequences: CSI, OSC (with terminator), and single-char escapes.
const ANSI_ESCAPE =
  /\u001b\[[0-9;?:]*[ -\/]*[@-~]|\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b[@-Z\\_]/g;
// Bidi overrides/isolates, directional marks, and zero-width/format characters.
const UNSAFE_FORMAT =
  /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u061c]/g;
// C0 control chars (tab \u0009 and newline \u000a preserved), DEL, and C1 controls.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Removes ANSI escape sequences, bidi/directional overrides, zero-width and
 * other format characters, and control characters from a single string. Tab and
 * newline are preserved. Safe to apply to any untrusted marketplace or error
 * string before display.
 */
export function stripUnsafeText(input: string): string {
  return input
    .replace(ANSI_ESCAPE, '')
    .replace(UNSAFE_FORMAT, '')
    .replace(CONTROL_CHARS, '');
}

/**
 * Recursively sanitizes every string in a JSON-like value (object keys and
 * values, array items, and standalone strings), leaving structure intact.
 */
export function sanitizeUntrusted<T>(value: T): T {
  if (typeof value === 'string') return stripUnsafeText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeUntrusted(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[stripUnsafeText(key)] = sanitizeUntrusted(item);
    }
    return result as unknown as T;
  }
  return value;
}

/**
 * Fences sanitized untrusted text as an inert data block so an agent host treats
 * it as data rather than instructions. Use for marketplace text surfaced to an
 * LLM/agent context (for example MCP tool text output).
 */
export function fenceUntrusted(text: string): string {
  return `<<UNTRUSTED_MARKETPLACE_DATA\n${stripUnsafeText(text)}\nUNTRUSTED_MARKETPLACE_DATA`;
}
