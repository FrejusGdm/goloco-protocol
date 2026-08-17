import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  FetchTransport,
  GolocoClient,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
  sanitizeUntrusted,
  stripUnsafeText,
  type DeliveryInput,
  type Earnings,
  type MarketplaceApi,
  type PreparedAction,
  type QuoteInput,
  type RequestOptions,
  type PublishAgentInput,
  type SetAvailabilityInput,
  type TaskInput,
} from '../../sdk/src/index.js';

export const EXIT_CODE = {
  ok: 0,
  user: 1,
  network: 2,
  auth: 3,
  other: 4,
} as const;

type CliClient = Partial<MarketplaceApi>;
type Write = (line: string) => void;

export interface CliDependencies {
  client?: CliClient;
  environment?: Record<string, string | undefined>;
  stdout?: Write;
  stderr?: Write;
}

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string[]>;
}

interface CommandSpec {
  positionalCount: number;
  positionalDescription?: string;
  allowedOptions: readonly string[];
}

const commandSpecs: Record<string, CommandSpec> = {
  'task create': { positionalCount: 0, allowedOptions: ['brief', 'budget', 'selection-mode', 'title', 'criteria', 'tier', 'accept-window-seconds', 'delivery-window-seconds', 'deadline', 'idempotency-key', 'api-version'] },
  'task list': { positionalCount: 0, allowedOptions: ['cursor', 'limit', 'api-version'] },
  'task get': { positionalCount: 1, positionalDescription: 'task ID', allowedOptions: ['api-version'] },
  'task fund': { positionalCount: 1, positionalDescription: 'task ID', allowedOptions: ['idempotency-key', 'api-version'] },
  'task select': { positionalCount: 1, positionalDescription: 'task ID', allowedOptions: ['mode', 'agent-id', 'idempotency-key', 'api-version'] },
  'task accept': { positionalCount: 1, positionalDescription: 'task ID', allowedOptions: ['idempotency-key', 'api-version'] },
  'task reject': { positionalCount: 1, positionalDescription: 'task ID', allowedOptions: ['idempotency-key', 'api-version'] },
  'task abandon': { positionalCount: 2, positionalDescription: 'task ID and node ID', allowedOptions: ['idempotency-key', 'api-version'] },
  'task claim-non-delivery': { positionalCount: 2, positionalDescription: 'task ID and node ID', allowedOptions: ['idempotency-key', 'api-version'] },
  'task withdraw-refund': { positionalCount: 1, positionalDescription: 'task ID', allowedOptions: ['destination', 'idempotency-key', 'api-version'] },
  'quote create': { positionalCount: 0, allowedOptions: ['task-id', 'price', 'deadline', 'terms-hash', 'idempotency-key', 'api-version'] },
  'jobs quote': { positionalCount: 0, allowedOptions: ['task-id', 'price', 'deadline', 'terms-hash', 'idempotency-key', 'api-version'] },
  'deliver create': { positionalCount: 0, allowedOptions: ['task-id', 'artifact-hash', 'custody-receipt', 'idempotency-key', 'api-version'] },
  'jobs deliver': { positionalCount: 0, allowedOptions: ['task-id', 'artifact-hash', 'custody-receipt', 'idempotency-key', 'api-version'] },
  'earnings get': { positionalCount: 0, allowedOptions: ['api-version'] },
  'earnings list': { positionalCount: 0, allowedOptions: ['api-version'] },
  'earnings withdrawal-intent': { positionalCount: 0, allowedOptions: ['destination', 'idempotency-key', 'api-version'] },
  'earnings withdraw': { positionalCount: 0, allowedOptions: ['destination', 'idempotency-key', 'api-version'] },
  'agent nodes': { positionalCount: 1, positionalDescription: 'agent ID', allowedOptions: ['cursor', 'limit', 'role', 'state', 'api-version'] },
  'agent publish': { positionalCount: 0, allowedOptions: ['name', 'agent-card-url', 'capability', 'idempotency-key', 'api-version'] },
  'agent availability': { positionalCount: 1, positionalDescription: 'agent ID', allowedOptions: ['available', 'until', 'idempotency-key', 'api-version'] },
};

/**
 * Runs the goloco command without holding signing material. Money commands
 * print prepared wallet actions returned by the SDK for the caller to approve.
 */
export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;

  try {
    const parsed = parseArguments(argv);
    const command = parsed.positionals.slice(0, 2).join(' ');

    if (argv.length === 0) {
      stdout(helpText());
      return EXIT_CODE.ok;
    }
    if (command === 'help') {
      if (parsed.positionals.length !== 1 || parsed.options.size !== 0) {
        throw new UsageError('help accepts no arguments or options.');
      }
      stdout(helpText());
      return EXIT_CODE.ok;
    }

    validateInvocation(command, parsed);
    const client = dependencies.client ?? clientFromEnvironment(dependencies.environment ?? process.env);

    switch (command) {
      case 'task create':
        return printPreparedAction(await requireMethod(client, 'prepareTaskCreation')(
          taskInput(parsed), mutationOptions(parsed),
        ), stdout);
      case 'task list': {
        const page = await requireMethod(client, 'listTasks')({
          ...readOptions(parsed),
          cursor: optional(parsed, 'cursor'),
          limit: pageLimit(parsed),
        });
        return print({ data: page.data, next_page: page.nextPage }, stdout);
      }
      case 'task get':
        return print(await requireMethod(client, 'getTask')(
          requiredPositional(parsed, 2, 'task ID'), readOptions(parsed),
        ), stdout);
      case 'task fund':
        return printPreparedAction(await requireMethod(client, 'prepareTaskFunding')(
          requiredPositional(parsed, 2, 'task ID'), mutationOptions(parsed),
        ), stdout);
      case 'task select':
        return printPreparedAction(await requireMethod(client, 'prepareTaskSelection')(
          requiredPositional(parsed, 2, 'task ID'), selectionInput(parsed), mutationOptions(parsed),
        ), stdout);
      case 'task accept':
        return printPreparedAction(await requireMethod(client, 'prepareTaskResolution')(
          requiredPositional(parsed, 2, 'task ID'), 'accept', mutationOptions(parsed),
        ), stdout);
      case 'task reject':
        return printPreparedAction(await requireMethod(client, 'prepareTaskRejection')(
          requiredPositional(parsed, 2, 'task ID'), mutationOptions(parsed),
        ), stdout);
      case 'task abandon':
        return printPreparedAction(await requireMethod(client, 'prepareNodeAbandonment')(
          requiredPositional(parsed, 2, 'task ID'), requiredPositional(parsed, 3, 'node ID'), mutationOptions(parsed),
        ), stdout);
      case 'task claim-non-delivery':
        return printPreparedAction(await requireMethod(client, 'prepareNodeNonDeliveryClaim')(
          requiredPositional(parsed, 2, 'task ID'), requiredPositional(parsed, 3, 'node ID'), mutationOptions(parsed),
        ), stdout);
      case 'task withdraw-refund':
        return printPreparedAction(await requireMethod(client, 'prepareRefundWithdrawal')(
          requiredPositional(parsed, 2, 'task ID'), required(parsed, 'destination'), mutationOptions(parsed),
        ), stdout);
      case 'quote create':
      case 'jobs quote':
        return printPreparedAction(await requireMethod(client, 'prepareQuote')(
          quoteInput(parsed), mutationOptions(parsed),
        ), stdout);
      case 'deliver create':
      case 'jobs deliver':
        return print(await requireMethod(client, 'submitDelivery')(
          deliveryInput(parsed), mutationOptions(parsed),
        ), stdout);
      case 'earnings get':
      case 'earnings list':
        return print(await requireMethod(client, 'getEarnings')(readOptions(parsed)), stdout);
      case 'earnings withdrawal-intent':
      case 'earnings withdraw':
        return printPreparedAction(await requireMethod(client, 'prepareEarningsWithdrawal')(
          required(parsed, 'destination'), mutationOptions(parsed),
        ), stdout);
      case 'agent nodes': {
        const page = await requireMethod(client, 'listAgentNodes')(
          requiredPositional(parsed, 2, 'agent ID'), agentNodeOptions(parsed),
        );
        return print({ data: page.data, next_page: page.nextPage }, stdout);
      }
      case 'agent publish':
        return print(await requireMethod(client, 'publishAgent')(
          publishAgentInput(parsed), mutationOptions(parsed),
        ), stdout);
      case 'agent availability':
        return print(await requireMethod(client, 'setAgentAvailability')(
          requiredPositional(parsed, 2, 'agent ID'), availabilityInput(parsed), mutationOptions(parsed),
        ), stdout);
      default:
        throw new UsageError(`Unknown command: ${command || '(none)'}. Run \`goloco help\` for usage.`);
    }
  } catch (error) {
    // Upstream/marketplace text may be attacker-controlled; strip terminal
    // control/bidi/zero-width sequences before writing to the terminal.
    stderr(stripUnsafeText(error instanceof Error ? error.message : 'Unexpected command failure.'));
    return exitCodeFor(error);
  }
}

export function helpText(): string {
  return [
    'Usage: goloco <command> [options]',
    '',
    'Tasks:',
    '  task create --brief <text> --budget <USDC> --selection-mode <manual|auto> --idempotency-key <key>',
    '  task list [--cursor <cursor>] [--limit <1-100>]',
    '  task get <task-id>',
    '  task fund <task-id> --idempotency-key <key>',
    '  task select <task-id> --mode <manual|auto> [--agent-id <id>] --idempotency-key <key>',
    '  task accept|reject <task-id> --idempotency-key <key>',
    '  task abandon|claim-non-delivery <task-id> <node-id> --idempotency-key <key>',
    '  task withdraw-refund <task-id> --destination <address> --idempotency-key <key>',
    '  agent nodes <agent-id> [--cursor <cursor>] [--limit <1-100>] [--role <worker|hirer>] [--state <funded|delivered|released|refunded>]',
    '  agent publish --name <name> --agent-card-url <url> [--capability <value>] --idempotency-key <key>',
    '  agent availability <agent-id> --available <true|false> [--until <ISO-8601>] --idempotency-key <key>',
    '',
    'Work:',
    '  quote create --task-id <id> --price <USDC> --deadline <ISO-8601> --terms-hash <hash> --idempotency-key <key>',
    '  deliver create --task-id <id> --artifact-hash <hash> --custody-receipt <receipt> --idempotency-key <key>',
    '',
    'Earnings:',
    '  earnings get',
    '  earnings withdrawal-intent --destination <address> --idempotency-key <key>',
    '',
    'Environment: GOLOCO_API_KEY is required; GOLOCO_API_URL defaults to https://api.goloco.xyz.',
  ].join('\n');
}

function clientFromEnvironment(environment: Record<string, string | undefined>): GolocoClient {
  const apiKey = environment.GOLOCO_API_KEY;
  if (!apiKey) throw new AuthenticationError({ message: 'GOLOCO_API_KEY is required.' });
  return new GolocoClient(new FetchTransport(environment.GOLOCO_API_URL ?? 'https://api.goloco.xyz', apiKey));
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!name || value === undefined || value.startsWith('--')) {
      throw new UsageError(`Option --${name || '?'} requires a value.`);
    }
    options.set(name, [...(options.get(name) ?? []), value]);
    index += 1;
  }
  return { positionals, options };
}

function validateInvocation(command: string, parsed: ParsedArguments): void {
  const spec = commandSpecs[command];
  if (spec === undefined) {
    throw new UsageError(`Unknown command: ${command || '(none)'}. Run \`goloco help\` for usage.`);
  }
  const providedPositionals = parsed.positionals.length - 2;
  if (providedPositionals < spec.positionalCount && spec.positionalDescription !== undefined) {
    missing(spec.positionalDescription);
  }
  if (providedPositionals !== spec.positionalCount) {
    const noun = spec.positionalCount === 1 ? 'argument' : 'arguments';
    throw new UsageError(`${command} accepts exactly ${spec.positionalCount} positional ${noun} after the command.`);
  }
  const allowedOptions = new Set(spec.allowedOptions);
  for (const option of parsed.options.keys()) {
    if (!allowedOptions.has(option)) {
      throw new UsageError(`--${option} is not accepted by ${command}.`);
    }
  }

  switch (command) {
    case 'task create':
      taskInput(parsed);
      mutationOptions(parsed);
      return;
    case 'task list':
      pageLimit(parsed);
      optional(parsed, 'cursor');
      readOptions(parsed);
      return;
    case 'task get':
      requiredPositional(parsed, 2, 'task ID');
      readOptions(parsed);
      return;
    case 'task fund':
    case 'task select':
    case 'task accept':
    case 'task reject':
      requiredPositional(parsed, 2, 'task ID');
      if (command === 'task select') selectionInput(parsed);
      mutationOptions(parsed);
      return;
    case 'task withdraw-refund':
      requiredPositional(parsed, 2, 'task ID');
      required(parsed, 'destination');
      mutationOptions(parsed);
      return;
    case 'task abandon':
    case 'task claim-non-delivery':
      requiredPositional(parsed, 2, 'task ID');
      requiredPositional(parsed, 3, 'node ID');
      mutationOptions(parsed);
      return;
    case 'quote create':
    case 'jobs quote':
      quoteInput(parsed);
      mutationOptions(parsed);
      return;
    case 'deliver create':
    case 'jobs deliver':
      deliveryInput(parsed);
      mutationOptions(parsed);
      return;
    case 'earnings get':
    case 'earnings list':
      readOptions(parsed);
      return;
    case 'earnings withdrawal-intent':
    case 'earnings withdraw':
      required(parsed, 'destination');
      mutationOptions(parsed);
      return;
    case 'agent nodes':
      requiredPositional(parsed, 2, 'agent ID');
      agentNodeOptions(parsed);
      return;
    case 'agent publish':
      publishAgentInput(parsed);
      mutationOptions(parsed);
      return;
    case 'agent availability':
      requiredPositional(parsed, 2, 'agent ID');
      availabilityInput(parsed);
      mutationOptions(parsed);
      return;
  }
}

function taskInput(parsed: ParsedArguments): TaskInput {
  const title = optional(parsed, 'title');
  const acceptWindowSeconds = minimumDuration(parsed, 'accept-window-seconds', 172800);
  const deliveryWindowSeconds = minimumDuration(parsed, 'delivery-window-seconds', 86400);
  const taskTier = optional(parsed, 'tier');
  const deadline = optional(parsed, 'deadline');
  return {
    brief: required(parsed, 'brief'),
    budget: money(required(parsed, 'budget'), 'budget'),
    selectionMode: selectionMode(required(parsed, 'selection-mode')),
    ...(title === undefined ? {} : { title }),
    ...(parsed.options.has('criteria') ? { criteria: parsed.options.get('criteria') } : {}),
    ...(acceptWindowSeconds === undefined ? {} : { acceptWindowSeconds }),
    ...(deliveryWindowSeconds === undefined ? {} : { deliveryWindowSeconds }),
    ...(taskTier === undefined ? {} : { tier: tier(taskTier) }),
    ...(deadline === undefined ? {} : { deadline }),
  };
}

function quoteInput(parsed: ParsedArguments): QuoteInput {
  return {
    taskId: required(parsed, 'task-id'),
    price: money(required(parsed, 'price'), 'price'),
    deadline: required(parsed, 'deadline'),
    termsHash: required(parsed, 'terms-hash'),
  };
}

function deliveryInput(parsed: ParsedArguments): DeliveryInput {
  return {
    taskId: required(parsed, 'task-id'),
    artifactHash: required(parsed, 'artifact-hash'),
    custodyReceipt: required(parsed, 'custody-receipt'),
  };
}

function readOptions(parsed: ParsedArguments): Pick<RequestOptions, 'apiVersion'> {
  return optional(parsed, 'api-version') === undefined ? {} : { apiVersion: optional(parsed, 'api-version') };
}

function mutationOptions(parsed: ParsedArguments): RequestOptions {
  return {
    ...readOptions(parsed),
    idempotencyKey: required(parsed, 'idempotency-key'),
  };
}

function money(amount: string, option: string): TaskInput['budget'] {
  if (!/^[0-9]+(?:\.[0-9]{1,6})?$/.test(amount)) {
    throw new UsageError(`--${option} must be a decimal USDC amount.`);
  }
  return { amount, currency: 'USDC' };
}

function selectionMode(value: string): TaskInput['selectionMode'] {
  if (value === 'manual' || value === 'auto') return value;
  throw new UsageError('--selection-mode must be manual or auto.');
}

function selectionInput(parsed: ParsedArguments): { mode: 'manual'; agentId: string } | { mode: 'auto' } {
  const mode = required(parsed, 'mode');
  if (mode === 'manual') return { mode, agentId: required(parsed, 'agent-id') };
  if (mode === 'auto') {
    if (optional(parsed, 'agent-id') !== undefined) {
      throw new UsageError('--agent-id must be omitted when --mode is auto.');
    }
    return { mode };
  }
  throw new UsageError('--mode must be manual or auto.');
}

function publishAgentInput(parsed: ParsedArguments): PublishAgentInput {
  const capabilities = parsed.options.get('capability');
  return {
    name: required(parsed, 'name'),
    agentCardUrl: required(parsed, 'agent-card-url'),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

function availabilityInput(parsed: ParsedArguments): SetAvailabilityInput {
  const available = required(parsed, 'available');
  if (available !== 'true' && available !== 'false') {
    throw new UsageError('--available must be true or false.');
  }
  const until = optional(parsed, 'until');
  return { available: available === 'true', ...(until === undefined ? {} : { until }) };
}

function agentNodeOptions(parsed: ParsedArguments): { cursor?: string; limit?: number; role?: 'worker' | 'hirer'; state?: 'funded' | 'delivered' | 'released' | 'refunded' } {
  const role = optional(parsed, 'role');
  if (role !== undefined && role !== 'worker' && role !== 'hirer') {
    throw new UsageError('--role must be worker or hirer.');
  }
  const stateValue = optional(parsed, 'state');
  if (stateValue !== undefined && !['funded', 'delivered', 'released', 'refunded'].includes(stateValue)) {
    throw new UsageError('--state must be funded, delivered, released, or refunded.');
  }
  const state = stateValue as 'funded' | 'delivered' | 'released' | 'refunded' | undefined;
  return {
    ...(optional(parsed, 'cursor') === undefined ? {} : { cursor: optional(parsed, 'cursor') }),
    ...(pageLimit(parsed) === undefined ? {} : { limit: pageLimit(parsed) }),
    ...(role === undefined ? {} : { role }),
    ...(state === undefined ? {} : { state }),
  };
}

function tier(value: string): NonNullable<TaskInput['tier']> {
  if (value === 'public' || value === 'private_curated') return value;
  throw new UsageError('--tier must be public or private_curated in V1.');
}

function optionalInteger(parsed: ParsedArguments, name: string): number | undefined {
  const value = optional(parsed, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} must be an integer.`);
  return Number(value);
}

function pageLimit(parsed: ParsedArguments): number | undefined {
  const limit = optionalInteger(parsed, 'limit');
  if (limit !== undefined && (limit < 1 || limit > 100)) {
    throw new UsageError('--limit must be between 1 and 100.');
  }
  return limit;
}

function minimumDuration(parsed: ParsedArguments, name: string, minimum: number): number | undefined {
  const value = optionalInteger(parsed, name);
  if (value !== undefined && value < minimum) {
    throw new UsageError(`--${name} must be at least ${minimum}.`);
  }
  return value;
}

function optional(parsed: ParsedArguments, name: string): string | undefined {
  const values = parsed.options.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new UsageError(`Option --${name} may be supplied once.`);
  return values[0];
}

function required(parsed: ParsedArguments, name: string): string {
  return optional(parsed, name) ?? missing(`--${name}`);
}

function requiredPositional(parsed: ParsedArguments, index: number, description: string): string {
  return parsed.positionals[index] ?? missing(description);
}

function missing(description: string): never {
  throw new UsageError(`Missing required ${description}.`);
}

function requireMethod<Method extends keyof MarketplaceApi>(
  client: CliClient,
  method: Method,
): MarketplaceApi[Method] {
  const candidate = client[method];
  if (!candidate) throw new Error(`CLI client does not implement ${method}.`);
  return candidate;
}

function print(value: unknown, stdout: Write): number {
  // Marketplace resource text is attacker-controlled; strip terminal control /
  // bidi / zero-width sequences from every string before printing (red-team #9).
  stdout(JSON.stringify(sanitizeUntrusted(value), null, 2));
  return EXIT_CODE.ok;
}

function printPreparedAction(action: PreparedAction, stdout: Write): number {
  return print(action, stdout);
}

function exitCodeFor(error: unknown): number {
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) return EXIT_CODE.auth;
  if (error instanceof APIConnectionError || error instanceof RateLimitError) return EXIT_CODE.network;
  if (
    error instanceof UsageError ||
    error instanceof BadRequestError ||
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof UnprocessableEntityError
  ) return EXIT_CODE.user;
  if (error instanceof APIError && error.status !== undefined && error.status >= 400 && error.status < 500) {
    return EXIT_CODE.user;
  }
  return EXIT_CODE.other;
}

class UsageError extends Error {}

export type { Earnings };
