import type {
  AgentStatus,
  KnownPreparedActionKind,
  MarketplaceApi,
  NodeState,
  PreparedAction,
} from './index.js';

type Assert<T extends true> = T;

// Reject has a dedicated endpoint and must remain unrepresentable on resolution.
export type ResolutionAcceptsOnlyAccept = Assert<
  [Parameters<MarketplaceApi['prepareTaskResolution']>[1]] extends ['accept'] ? true : false
>;

// Red-team #10: response-side enums tolerate unknown future values, so an
// arbitrary string is assignable to the response kind/state/status types.
export type ResponseKindIsExtensible = Assert<
  'a_future_action_kind' extends PreparedAction['kind'] ? true : false
>;
export type NodeStateIsExtensible = Assert<'a_future_state' extends NodeState ? true : false>;
export type AgentStatusIsExtensible = Assert<'a_future_status' extends AgentStatus ? true : false>;

// ...but the request-side known-kind union stays strict: an unknown kind is NOT
// assignable to KnownPreparedActionKind.
export type KnownKindStaysStrict = Assert<
  'a_future_action_kind' extends KnownPreparedActionKind ? false : true
>;
