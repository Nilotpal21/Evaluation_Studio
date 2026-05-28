/**
 * MCP Tool Executor
 *
 * Dispatches tool calls to external MCP servers with resilience:
 * - Circuit breaker (trips after repeated failures, auto-resets)
 * - Single retry for transient errors (ECONNRESET, timeout)
 * - Configurable timeout per call
 */

import type { ToolDefinition } from '../../ir/schema.js';
import type { SecretsProvider } from './secrets-provider.js';
import type { ICircuitBreaker, ResilienceFactory } from './resilience-interfaces.js';
import { createLogger } from '../../logger.js';
import {
  ToolExecutionError,
  DEFAULT_TOOL_TIMEOUT_MS,
  MCP_RETRY_DELAY_BASE_MS,
} from '@agent-platform/shared';
import { resolveSessionPlaceholders } from './session-placeholder-utils.js';

const log = createLogger('mcp-tool-executor');

/**
 * Interface for MCP client management.
 * Platform provides the implementation.
 */
export interface McpClientProvider {
  /** Get an MCP client connected to the named server */
  getClient(serverName: string, projectId?: string): Promise<McpClient | undefined>;
}

/**
 * Minimal MCP client interface for tool execution
 */
export interface McpClient {
  callTool(
    toolName: string,
    params: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<unknown>;
}

/** Max breaker map entries (evict oldest when exceeded) */
const MAX_BREAKER_MAP_ENTRIES = 2000;

/** Maximum characters for MCP tool result text (~25K tokens) */
export const MAX_MCP_RESULT_CHARS = 100_000;

/** No-op breaker when no resilience factory is provided */
const NOOP_BREAKER: ICircuitBreaker = {
  isOpen: () => false,
  recordSuccess: () => {},
  recordFailure: () => {},
  getState: () => 'closed' as const,
};

function isTransient(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : '';
  return (
    msg.includes('ECONNRESET') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('timed out')
  );
}

interface AuthRefreshReconnectEnvelope {
  code: 'AUTH_REFRESH_RECONNECT';
  reconnectAfterMs: number;
  message?: string;
}

function parseAuthRefreshReconnectEnvelope(error: unknown): AuthRefreshReconnectEnvelope | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message) {
    return null;
  }

  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    if (parsed.code !== 'AUTH_REFRESH_RECONNECT') {
      return null;
    }
    if (typeof parsed.reconnectAfterMs !== 'number' || !Number.isFinite(parsed.reconnectAfterMs)) {
      return null;
    }

    return {
      code: 'AUTH_REFRESH_RECONNECT',
      reconnectAfterMs: parsed.reconnectAfterMs,
      ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
    };
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Short-circuit recursive check for {{ placeholders — avoids JSON.stringify */
function hasPlaceholderDeep(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{');
  if (Array.isArray(value)) return value.some(hasPlaceholderDeep);
  if (typeof value === 'object' && value !== null)
    return Object.values(value).some(hasPlaceholderDeep);
  return false;
}

/** Resolve {{secrets.X}}, {{env.X}}, and {{config.X}} in a string via SecretsProvider. */
async function resolveStringPlaceholders(
  value: string,
  secrets: SecretsProvider,
  toolName?: string,
): Promise<string> {
  const secretRefs = [...value.matchAll(/\{\{secrets\.(\w+)\}\}/g)];
  const envRefs = secrets.getEnvVar ? [...value.matchAll(/\{\{env\.(\w+)\}\}/g)] : [];
  const configRefs = secrets.getConfigVar ? [...value.matchAll(/\{\{config\.(\w+)\}\}/g)] : [];

  if (secretRefs.length === 0 && envRefs.length === 0 && configRefs.length === 0) return value;

  // Resolve all lookups in parallel
  const [secretValues, envValues, configValues] = await Promise.all([
    Promise.all(
      secretRefs.map((m) => secrets.getSecret(m[1], toolName ? { toolName } : undefined)),
    ),
    Promise.all(envRefs.map((m) => secrets.getEnvVar!(m[1]))),
    Promise.all(configRefs.map((m) => secrets.getConfigVar!(m[1]))),
  ]);

  let result = value;
  for (let i = 0; i < secretRefs.length; i++) {
    result = result.split(secretRefs[i][0]).join(secretValues[i] ?? '');
  }
  for (let i = 0; i < envRefs.length; i++) {
    result = result.split(envRefs[i][0]).join(envValues[i] ?? '');
  }
  for (let i = 0; i < configRefs.length; i++) {
    result = result.split(configRefs[i][0]).join(configValues[i] ?? '');
  }
  return result;
}

/** Keys blocked during dot-path traversal to prevent prototype pollution. */
const DENIED_CONTEXT_TRAVERSAL_KEYS: Record<string, boolean> = {
  __proto__: true,
  constructor: true,
  prototype: true,
};

/**
 * Resolve {{_context.path}} placeholders using dot-path traversal.
 * Supports nested access: {{_context.session.token}} resolves session.token from contextVars.
 */
function resolveContextPlaceholders(
  value: string,
  contextVars: Record<string, unknown> | undefined,
): string {
  if (!contextVars) return value;
  return value.replace(/\{\{_context\.([\w.]+)\}\}/g, (_, dotPath: string) => {
    const parts = dotPath.split('.');
    let current: unknown = contextVars;
    for (const part of parts) {
      if (DENIED_CONTEXT_TRAVERSAL_KEYS[part]) return '';
      if (current == null || typeof current !== 'object') return '';
      current = (current as Record<string, unknown>)[part];
    }
    return current !== undefined ? String(current) : '';
  });
}

// resolveSessionPlaceholders is imported from ./session-placeholder-utils.js

/** Sanitize a header value by stripping CRLF sequences to prevent header injection. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

export class McpToolExecutor {
  private mcpTools: Map<string, ToolDefinition>;
  private mcpClients: McpClientProvider;
  private projectId?: string;
  private resilienceFactory?: ResilienceFactory;
  private tenantId?: string;
  private secrets?: SecretsProvider;
  private breakers = new Map<string, ICircuitBreaker>();

  constructor(config: {
    tools: ToolDefinition[];
    mcpClients: McpClientProvider;
    projectId?: string;
    resilienceFactory?: ResilienceFactory;
    /** Tenant ID for tenant-scoped circuit breakers */
    tenantId?: string;
    secrets?: SecretsProvider;
  }) {
    this.mcpClients = config.mcpClients;
    this.projectId = config.projectId;
    this.resilienceFactory = config.resilienceFactory;
    this.tenantId = config.tenantId;
    this.secrets = config.secrets;
    this.mcpTools = new Map();
    for (const tool of config.tools) {
      if (tool.tool_type === 'mcp' && tool.mcp_binding) {
        this.mcpTools.set(tool.name, tool);
      }
    }
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const tool = this.mcpTools.get(toolName);
    if (!tool?.mcp_binding) {
      throw new ToolExecutionError({
        code: 'TOOL_NOT_FOUND',
        message: `MCP tool not found: ${toolName}`,
        toolName,
        toolType: 'mcp',
      });
    }

    const binding = tool.mcp_binding;
    const start = Date.now();

    // Wrap getClient in try/catch — connection failures should be typed
    let client: McpClient | undefined;
    try {
      client = await this.mcpClients.getClient(binding.server, this.projectId);
    } catch (err) {
      throw new ToolExecutionError({
        code: 'TOOL_MCP_SERVER_UNAVAILABLE',
        message: `Failed to connect to MCP server "${binding.server}": ${err instanceof Error ? err.message : String(err)}`,
        toolName,
        toolType: 'mcp',
        retryable: true,
        cause: err,
      });
    }
    if (!client) {
      log.error('MCP server not available', { server: binding.server, tool: toolName });
      throw new ToolExecutionError({
        code: 'TOOL_MCP_SERVER_UNAVAILABLE',
        message: `MCP server not available: ${binding.server}`,
        toolName,
        toolType: 'mcp',
        retryable: true,
      });
    }

    // Circuit breaker check
    const breaker = this.getOrCreateCircuitBreaker(toolName);
    if (await breaker.isOpen()) {
      log.warn('MCP tool circuit breaker open', { tool: toolName, server: binding.server });
      throw new ToolExecutionError({
        code: 'TOOL_CIRCUIT_OPEN',
        message: `MCP tool ${toolName} temporarily unavailable (circuit breaker open)`,
        toolName,
        toolType: 'mcp',
        retryable: true,
      });
    }

    log.debug('MCP tool call', { tool: toolName, server: binding.server, mcpTool: binding.tool });

    // Extract injected context vars (from CONTEXT_ACCESS) and session metadata before processing
    const { _context, _session, ...regularParams } = params;
    const contextVars =
      typeof _context === 'object' && _context !== null
        ? (_context as Record<string, unknown>)
        : undefined;
    const sessionVars =
      typeof _session === 'object' && _session !== null
        ? (_session as Record<string, unknown>)
        : undefined;

    // Resolve {{secrets.X}}, {{env.X}}, {{config.X}}, {{_context.X}}, {{session.X}} in param values
    const resolvedParams = await this.resolveParamPlaceholders(regularParams, toolName);

    // Resolve per-call headers from mcp_binding.headers with template placeholders
    const resolvedHeaders = await this.resolveHeaders(
      binding.headers,
      contextVars,
      sessionVars,
      toolName,
    );

    const effectiveTimeout = timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const maxAttempts = 2; // 1 initial + 1 retry for transient failures
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const rawResult = await Promise.race([
          client.callTool(binding.tool, resolvedParams, resolvedHeaders),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new ToolExecutionError({
                    code: 'TOOL_TIMEOUT',
                    message: `MCP tool ${toolName} timed out after ${effectiveTimeout}ms`,
                    toolName,
                    toolType: 'mcp',
                    retryable: true,
                    durationMs: effectiveTimeout,
                  }),
                ),
              effectiveTimeout,
            );
          }),
        ]);

        try {
          await breaker.recordSuccess();
        } catch (breakerErr) {
          log.warn('Circuit breaker recordSuccess failed', {
            tool: toolName,
            error: breakerErr instanceof Error ? breakerErr.message : String(breakerErr),
          });
        }
        log.debug('MCP tool response', {
          tool: toolName,
          server: binding.server,
          latencyMs: Date.now() - start,
        });

        // MCP results can include non-text content types (images, resources).
        // Normalize to structured result extracting text and noting other content types.
        return normalizeMcpResult(rawResult);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const reconnectEnvelope = parseAuthRefreshReconnectEnvelope(error);

        if (reconnectEnvelope) {
          if (attempt < maxAttempts) {
            const reconnectDelayMs = Math.max(0, reconnectEnvelope.reconnectAfterMs);
            log.debug('MCP tool waiting for auth-refresh reconnect', {
              tool: toolName,
              server: binding.server,
              attempt,
              reconnectAfterMs: reconnectEnvelope.reconnectAfterMs,
            });
            await delay(reconnectDelayMs);
            continue;
          }

          throw new ToolExecutionError({
            code: 'TOOL_NETWORK_ERROR',
            message: JSON.stringify({
              code: reconnectEnvelope.code,
              reconnectAfterMs: reconnectEnvelope.reconnectAfterMs,
              message:
                reconnectEnvelope.message ??
                'MCP auth refresh in progress; reconnect and retry this tool call.',
              toolName,
            }),
            toolName,
            toolType: 'mcp',
            retryable: true,
            durationMs: Date.now() - start,
            cause: lastError,
          });
        }

        if (attempt < maxAttempts && isTransient(error)) {
          log.debug('MCP tool retrying', {
            tool: toolName,
            server: binding.server,
            attempt,
            error: lastError.message,
          });
          await delay(MCP_RETRY_DELAY_BASE_MS * attempt);
          continue;
        }

        try {
          await breaker.recordFailure();
        } catch (breakerErr) {
          log.warn('Circuit breaker recordFailure failed', {
            tool: toolName,
            error: breakerErr instanceof Error ? breakerErr.message : String(breakerErr),
          });
        }
        log.error('MCP tool execution failed', {
          tool: toolName,
          server: binding.server,
          mcpTool: binding.tool,
          projectId: this.projectId,
          tenantId: this.tenantId,
          error: lastError.message,
          attempt,
          isTransient: isTransient(error),
        });
        // Preserve ToolExecutionError if already classified (e.g. timeout)
        if (lastError instanceof ToolExecutionError) throw lastError;
        throw new ToolExecutionError({
          code: isTransient(error) ? 'TOOL_NETWORK_ERROR' : 'TOOL_EXECUTION_ERROR',
          message: lastError.message,
          toolName,
          toolType: 'mcp',
          retryable: isTransient(error),
          durationMs: Date.now() - start,
          cause: lastError,
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    // Unreachable, but TypeScript needs it
    throw (
      lastError ??
      new ToolExecutionError({
        code: 'TOOL_EXECUTION_ERROR',
        message: `MCP tool ${toolName} failed`,
        toolName,
        toolType: 'mcp',
      })
    );
  }

  /**
   * Resolve template placeholders in mcp_binding.headers.
   * Supports {{secrets.X}}, {{env.X}}, {{config.X}}, {{_context.path}}, {{session.path}}.
   * Returns undefined if no headers are configured.
   */
  private async resolveHeaders(
    headers: Record<string, string> | undefined,
    contextVars: Record<string, unknown> | undefined,
    sessionVars: Record<string, unknown> | undefined,
    toolName: string,
  ): Promise<Record<string, string> | undefined> {
    if (!headers || Object.keys(headers).length === 0) return undefined;

    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      let resolvedValue = value;
      // Resolve {{secrets.X}}, {{env.X}}, and {{config.X}} if secrets provider available
      if (this.secrets && resolvedValue.includes('{{')) {
        resolvedValue = await resolveStringPlaceholders(resolvedValue, this.secrets, toolName);
      }
      // Resolve {{_context.path}} from injected context vars
      resolvedValue = resolveContextPlaceholders(resolvedValue, contextVars);
      // Resolve {{session.path}} from injected session metadata
      resolvedValue = resolveSessionPlaceholders(resolvedValue, sessionVars);
      // CRLF sanitization to prevent header injection
      resolved[sanitizeHeaderValue(key)] = sanitizeHeaderValue(resolvedValue);
    }
    return resolved;
  }

  /**
   * Resolve {{secrets.X}}, {{env.X}}, and {{config.X}} placeholders in string param values.
   * Non-string values and nested objects are traversed recursively.
   */
  private async resolveParamPlaceholders(
    params: Record<string, unknown>,
    toolName: string,
  ): Promise<Record<string, unknown>> {
    if (!this.secrets || !hasPlaceholderDeep(params)) return params;

    const entries = Object.entries(params);
    const resolved = await Promise.all(entries.map(([, v]) => this.resolveValue(v, toolName)));
    return Object.fromEntries(entries.map(([k], i) => [k, resolved[i]]));
  }

  private async resolveValue(value: unknown, toolName: string): Promise<unknown> {
    if (typeof value === 'string') {
      return resolveStringPlaceholders(value, this.secrets!, toolName);
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((v) => this.resolveValue(v, toolName)));
    }
    if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value as Record<string, unknown>);
      const resolved = await Promise.all(entries.map(([, v]) => this.resolveValue(v, toolName)));
      return Object.fromEntries(entries.map(([k], i) => [k, resolved[i]]));
    }
    return value;
  }

  private breakerKey(toolName: string): string {
    if (!this.tenantId) {
      log.warn('MCP circuit breaker without tenantId — breakers are shared across tenants', {
        tool: toolName,
      });
    }
    return this.tenantId ? `${this.tenantId}:${toolName}` : `_no_tenant_:${toolName}`;
  }

  private getOrCreateCircuitBreaker(toolName: string): ICircuitBreaker {
    const key = this.breakerKey(toolName);
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = this.resilienceFactory
        ? this.resilienceFactory.createCircuitBreaker(toolName, { threshold: 3, resetMs: 30_000 })
        : NOOP_BREAKER;
      this.breakers.set(key, breaker);
      if (this.breakers.size > MAX_BREAKER_MAP_ENTRIES) {
        const first = this.breakers.keys().next().value;
        if (first) this.breakers.delete(first);
      }
    }
    return breaker;
  }
}

/**
 * Normalize MCP tool results that may contain mixed content types.
 * MCP results can be: plain values, or arrays of `{ type, text?, data?, uri?, mimeType? }` blocks.
 * Extracts text content, notes non-text content types for structured return.
 */
function normalizeMcpResult(result: unknown): unknown {
  // Not an MCP content array — return as-is
  if (!Array.isArray(result)) return result;

  // Check if this looks like an MCP content array (objects with 'type' field)
  const contentBlocks = result as Array<Record<string, unknown>>;
  if (contentBlocks.length === 0 || typeof contentBlocks[0]?.type !== 'string') {
    return result;
  }

  const textParts: string[] = [];
  const nonTextTypes: string[] = [];

  for (const block of contentBlocks) {
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') {
          textParts.push(block.text);
        }
        break;
      case 'image':
        nonTextTypes.push(`image(${block.mimeType || 'unknown'})`);
        break;
      case 'resource': {
        // Extract text content from embedded resources if available
        const resource =
          typeof block.resource === 'object' && block.resource !== null
            ? (block.resource as Record<string, unknown>)
            : undefined;
        if (resource && typeof resource.text === 'string') {
          textParts.push(resource.text);
        } else {
          nonTextTypes.push(`resource(${resource?.uri || 'embedded'})`);
        }
        break;
      }
      default:
        nonTextTypes.push(`${block.type}`);
    }
  }

  // If all content was text, return concatenated text (with size cap)
  if (nonTextTypes.length === 0) {
    const joined = textParts.join('\n');
    return truncateMcpText(joined);
  }

  // Mixed content — return structured result with truncation
  const joinedText = textParts.join('\n');
  return {
    text: truncateMcpText(joinedText),
    nonTextContent: nonTextTypes,
  };
}

/**
 * Truncate MCP text result to MAX_MCP_RESULT_CHARS with a notice suffix.
 * Non-string values are returned as-is.
 */
function truncateMcpText(text: string): string {
  if (text.length <= MAX_MCP_RESULT_CHARS) return text;
  log.warn('MCP tool result truncated', {
    originalLength: text.length,
    maxLength: MAX_MCP_RESULT_CHARS,
  });
  return text.slice(0, MAX_MCP_RESULT_CHARS) + '\n[truncated -- result exceeded size limit]';
}

/**
 * Exported for testing — normalize MCP result content array.
 */
export { normalizeMcpResult as _normalizeMcpResultForTest };

/**
 * Exported for testing — context/session placeholder resolution.
 */
export { resolveContextPlaceholders as _resolveContextPlaceholdersForTest };
export { resolveSessionPlaceholders as _resolveSessionPlaceholdersForTest } from './session-placeholder-utils.js';
