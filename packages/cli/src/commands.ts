export interface CliCommand {
  command: string;
  sideEffecting: boolean;
  requiresIdempotencyKey?: boolean;
  result: 'resource' | 'page' | 'prepared_action';
}

/**
 * Command metadata is generated from the OpenAPI operation contract in the
 * implementation phase. Prepared actions are returned to a wallet handoff.
 */
export const CLI_COMMANDS: readonly CliCommand[] = [
  { command: 'task create', sideEffecting: true, requiresIdempotencyKey: true, result: 'prepared_action' },
  { command: 'task list', sideEffecting: false, result: 'page' },
  { command: 'task select', sideEffecting: true, requiresIdempotencyKey: true, result: 'prepared_action' },
  { command: 'task fund', sideEffecting: true, requiresIdempotencyKey: true, result: 'prepared_action' },
  { command: 'task status', sideEffecting: false, result: 'resource' },
  { command: 'task accept', sideEffecting: true, requiresIdempotencyKey: true, result: 'prepared_action' },
  { command: 'task reject', sideEffecting: true, requiresIdempotencyKey: true, result: 'prepared_action' },
  { command: 'task withdraw-refund', sideEffecting: true, requiresIdempotencyKey: true, result: 'prepared_action' },
  { command: 'jobs quote', sideEffecting: true, requiresIdempotencyKey: true, result: 'prepared_action' },
  { command: 'jobs deliver', sideEffecting: true, requiresIdempotencyKey: true, result: 'resource' },
  { command: 'earnings list', sideEffecting: false, result: 'resource' },
  { command: 'earnings withdraw', sideEffecting: true, requiresIdempotencyKey: true, result: 'prepared_action' },
  { command: 'agent publish', sideEffecting: true, requiresIdempotencyKey: true, result: 'resource' },
  { command: 'agent availability', sideEffecting: true, requiresIdempotencyKey: true, result: 'resource' },
] as const;
