import {
  MCP_TOOLS,
  McpToolInputError,
  McpToolNotFoundError,
  invokeMcpTool,
} from './tools.js';
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  fenceUntrusted,
  sanitizeUntrusted,
  stripUnsafeText,
  type MarketplaceApi,
} from '../../sdk/src/index.js';

export const OAUTH_PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: readonly string[];
  scopes_supported: readonly string[];
}

export interface RequestScopedMcpServer {
  handle(request: Request): Promise<Response>;
}

export interface GolocoMcpHandlerOptions {
  /**
   * Called only for an MCP tool request. The host owns credential extraction,
   * OAuth issuer validation, and construction of the request-scoped SDK client.
   */
  createClient(request: Request): MarketplaceApi;
  protectedResourceMetadata: ProtectedResourceMetadata;
}

/**
 * Fresh server per request: no MCP session state is retained between requests,
 * so any stateless HTTP instance can serve any authenticated request.
 */
export function createMcpHandler(
  createServer: () => RequestScopedMcpServer,
): (request: Request) => Promise<Response> {
  return async (request) => createServer().handle(request);
}

export function protectedResourceMetadataResponse(
  metadata: ProtectedResourceMetadata,
): Response {
  return Response.json(metadata, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}

/**
 * A stateless Streamable-HTTP-compatible tool endpoint. Each tool request
 * creates a new SDK scope; no session or wallet material is retained here.
 */
export function createGolocoMcpHandler(
  options: GolocoMcpHandlerOptions,
): (request: Request) => Promise<Response> {
  return createMcpHandler(() => ({
    handle: async (request) => {
      const pathname = new URL(request.url).pathname;
      if (request.method === 'GET' && pathname === OAUTH_PROTECTED_RESOURCE_PATH) {
        return protectedResourceMetadataResponse(options.protectedResourceMetadata);
      }
      if (request.method !== 'POST' || pathname !== '/mcp') {
        return Response.json(jsonRpcError(null, -32601, 'MCP endpoint not found.'), { status: 404 });
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json(jsonRpcError(null, -32700, 'Invalid JSON request.'), { status: 400 });
      }
      return handleMcpRequest(body, request, options);
    },
  }));
}

async function handleMcpRequest(
  body: unknown,
  request: Request,
  options: GolocoMcpHandlerOptions,
): Promise<Response> {
  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return Response.json(jsonRpcError(null, -32600, 'Invalid JSON-RPC request.'), { status: 400 });
  }
  const id = jsonRpcId(body.id);
  if (body.method === 'tools/list') {
    return Response.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: MCP_TOOLS.map(({ name, description, jsonSchema, annotations }) => ({
          name,
          description,
          inputSchema: jsonSchema,
          annotations,
        })),
      },
    });
  }
  if (body.method !== 'tools/call' || !isRecord(body.params) || typeof body.params.name !== 'string') {
    return Response.json(jsonRpcError(id, -32601, 'Unsupported MCP method.'), { status: 400 });
  }

  try {
    const result = await invokeMcpTool(body.params.name, body.params.arguments ?? {}, {
      client: options.createClient(request),
    });
    // Marketplace text is attacker-controlled; strip terminal/agent control
    // sequences and fence the serialized text as inert data before it reaches
    // the calling agent's context.
    const safeValue = sanitizeUntrusted(result.value);
    return Response.json({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: fenceUntrusted(JSON.stringify(safeValue)) }],
        structuredContent: safeValue,
        _meta: { 'goloco/result-kind': result.kind },
      },
    });
  } catch (error) {
    const toolError = toolErrorFrom(error);
    return Response.json({
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: toolError.message }],
        structuredContent: { error: toolError },
      },
    });
  }
}

// Never reflect a raw upstream error body/reason into the agent context. Local
// validation errors carry safe, generated messages (sanitized); every
// upstream-derived error collapses to an allowlisted code and a fixed generic
// reason.
const UPSTREAM_ERROR_TEXT: Record<string, string> = {
  authentication_error: 'Authentication failed.',
  permission_denied: 'Permission denied.',
  connection_error: 'Upstream connection failed.',
  invalid_request: 'The request was rejected.',
  not_found: 'The requested resource was not found.',
  conflict: 'The request conflicts with the current state.',
  unprocessable: 'The request could not be processed.',
  rate_limited: 'Rate limit exceeded.',
  upstream_error: 'The upstream service failed.',
  api_error: 'The upstream request failed.',
};

function apiErrorCode(status: number | undefined): string {
  switch (status) {
    case 400: return 'invalid_request';
    case 404: return 'not_found';
    case 409: return 'conflict';
    case 422: return 'unprocessable';
    case 429: return 'rate_limited';
    default: return status !== undefined && status >= 500 ? 'upstream_error' : 'api_error';
  }
}

function toolErrorFrom(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof McpToolInputError) {
    return { code: 'invalid_input', message: stripUnsafeText(error.message), retryable: false };
  }
  if (error instanceof McpToolNotFoundError) {
    return { code: 'tool_not_found', message: stripUnsafeText(error.message), retryable: false };
  }
  if (error instanceof AuthenticationError) {
    return { code: 'authentication_error', message: UPSTREAM_ERROR_TEXT.authentication_error!, retryable: false };
  }
  if (error instanceof PermissionDeniedError) {
    return { code: 'permission_denied', message: UPSTREAM_ERROR_TEXT.permission_denied!, retryable: false };
  }
  if (error instanceof APIConnectionError) {
    return { code: 'connection_error', message: UPSTREAM_ERROR_TEXT.connection_error!, retryable: true };
  }
  if (error instanceof APIError) {
    const code = apiErrorCode(error.status);
    return {
      code,
      message: UPSTREAM_ERROR_TEXT[code] ?? UPSTREAM_ERROR_TEXT.api_error!,
      retryable: error.status === 408 || error.status === 409 || error.status === 429 || (error.status ?? 0) >= 500,
    };
  }
  return { code: 'internal_error', message: 'MCP tool request failed.', retryable: false };
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function jsonRpcId(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
