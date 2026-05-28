/**
 * Tool Binding Executor
 *
 * Composite executor that routes tool calls to type-specific executors
 * based on the tool's binding type (http, mcp, lambda, sandbox).
 * Falls back to a custom executor for contract-only tools.
 *
 * SECURITY:
 * - Input validation against ToolParameter schema before dispatch
 * - Concurrency-limited parallel execution (prevents resource exhaustion)
 */

import type { ToolDefinition, ToolParameter } from '../../ir/schema.js';
import type { ToolExecutor, ToolMemoryAPI } from '../types.js';
import type { SecretsProvider } from './secrets-provider.js';
import type { McpClientProvider } from './mcp-tool-executor.js';
import type { SandboxRunner } from './sandbox-tool-executor.js';
import type { TraceContextManager } from '../../stores/trace-store.js';
import type {
  ToolMiddleware,
  ToolCallContext,
  ToolCallResult,
  ToolExecutionOptions,
} from './tool-middleware.js';
import { composeMiddleware } from './tool-middleware.js';
import { HttpToolExecutor } from './http-tool-executor.js';
import { McpToolExecutor } from './mcp-tool-executor.js';
import { SandboxToolExecutor } from './sandbox-tool-executor.js';
import {
  resolveRuntimeNumericValue,
  resolveToolRuntimeNumericFields,
} from './runtime-numeric-values.js';
import { ToolExecutionError } from '@agent-platform/shared';
import { TOOL_SESSION_CONTEXT_PARAM_MAP } from '../../contracts/contract-source-data.js';
import { createLogger } from '../../logger.js';

const log = createLogger('tool-binding-executor');

/** Maximum concurrent tool executions in parallel mode */
const DEFAULT_MAX_CONCURRENCY = 10;

/** Maximum serialized size of tool params (DoS protection) */
const MAX_TOOL_PARAMS_BYTES = 512 * 1024;

/**
 * Caller identity context propagated from the edge layer (WebSocket auth, SDK auth, REST auth).
 * Structural mirror of `CallerContext` from `@agent-platform/shared/types` —
 * kept as a standalone interface to avoid adding a shared dependency to the compiler package.
 */
export interface ToolCallerContext {
  channel?: string;
  channelId?: string;
  identityTier?: number;
  verificationMethod?: string;
  contactId?: string;
  customerId?: string;
  sourceIp?: string;
  userAgent?: string;
}

/** Session-level metadata attached to every tool call for audit and tracing. */
export interface ToolSessionContext {
  sessionId?: string;
  tenantId?: string;
  userId?: string;
  callerContext?: ToolCallerContext;
  /** Execution source tag for audit — 'test' (Studio), 'production', 'staging' */
  source?: 'test' | 'production' | 'staging';
  /** Resolved workflow versions keyed by tool name for workflow trace/audit metadata. */
  workflowToolVersions?: Record<
    string,
    {
      workflowId?: string;
      workflowVersionId?: string;
      workflowVersion?: string;
    }
  >;
}

/**
 * Factory that creates a namespace-scoped SecretsProvider for a specific tool.
 * Used to filter env var resolution by the tool's linked variable namespace IDs.
 */
export type NamespaceScopedSecretsFactory = (variableNamespaceIds: string[]) => SecretsProvider;

export interface ToolBindingExecutorConfig {
  tools: ToolDefinition[];
  secrets: SecretsProvider;
  mcpClients?: McpClientProvider;
  sandboxRunner?: SandboxRunner;
  fallbackExecutor?: ToolExecutor;
  defaultTimeoutMs?: number;
  trace?: TraceContextManager;
  /** Maximum concurrent tool calls in executeParallel (default: 10) */
  maxConcurrency?: number;
  /** Composable middleware chain for cross-cutting concerns (logging, PII, audit) */
  middleware?: ToolMiddleware[];
  /** Allow localhost/127.0.0.1 targets for HTTP tools (development only) */
  allowLocalhost?: boolean;
  /** Custom resilience factory for circuit breakers and rate limiters */
  resilienceFactory?: import('./resilience-interfaces.js').ResilienceFactory;
  /** Organization-level proxy resolver for routing HTTP tools through a gateway */
  proxyResolver?: import('./proxy-resolver.js').ProxyResolver;
  /** Project ID for project-scoped MCP server resolution */
  projectId?: string;
  /** Session context for audit trail correlation and caller identity propagation */
  sessionContext?: ToolSessionContext;
  /** Promise that resolves once deployment-derived workflow metadata is ready. */
  workflowToolVersionsReady?: Promise<NonNullable<ToolSessionContext['workflowToolVersions']>>;
  /** Connector tool executor for connector-bound tools */
  connectorToolExecutor?: ToolExecutor;
  /** Workflow tool executor for workflow-bound tools */
  workflowToolExecutor?: ToolExecutor;
  /** SearchAI KB tool executor for searchai-bound tools */
  searchaiToolExecutor?: ToolExecutor;
  /** Companion tool for polling async workflow execution status */
  workflowStatusTool?: ToolExecutor;
  /** Factory to create namespace-scoped secrets providers for per-tool env var filtering */
  namespaceScopedSecretsFactory?: NamespaceScopedSecretsFactory;
  /** Optional feature gate for sandbox tool execution — blocks when it returns false */
  featureChecker?: () => Promise<boolean>;
}

export class ToolBindingExecutor implements ToolExecutor {
  private tools: Map<string, ToolDefinition>;
  private httpExecutor?: HttpToolExecutor;
  private mcpExecutor?: McpToolExecutor;
  private mcpClientProvider?: McpClientProvider;
  private sandboxExecutor?: SandboxToolExecutor;
  private fallback?: ToolExecutor;
  private trace?: TraceContextManager;
  private maxConcurrency: number;
  private middleware: ToolMiddleware[];
  private composedMiddlewareFn?: (ctx: ToolCallContext) => Promise<ToolCallResult>;
  private sessionContext?: ToolSessionContext;
  private workflowToolVersionsReady?: Promise<
    NonNullable<ToolSessionContext['workflowToolVersions']>
  >;
  private connectorToolExecutor?: ToolExecutor;
  private workflowToolExecutor?: ToolExecutor;
  private searchaiToolExecutor?: ToolExecutor;
  private workflowStatusTool?: ToolExecutor;
  private secrets: SecretsProvider;
  /** Optional feature gate for sandbox tool execution */
  private featureChecker?: () => Promise<boolean>;
  /** Per-tool namespace-scoped HTTP executors (only for tools with variable_namespace_ids) */
  private namespaceScopedHttpExecutors = new Map<string, HttpToolExecutor>();
  /** Per-tool namespace-scoped MCP executors (only for tools with variable_namespace_ids) */
  private namespaceScopedMcpExecutors = new Map<string, McpToolExecutor>();
  /** Per-tool namespace-scoped Sandbox executors (only for tools with variable_namespace_ids) */
  private namespaceScopedSandboxExecutors = new Map<string, SandboxToolExecutor>();
  /** Per-tool namespace-scoped secrets providers for runtime config placeholder resolution */
  private namespaceScopedSecretsProviders = new Map<string, SecretsProvider>();
  /** Promise that resolves when async proxy config is ready. Awaited on first execute(). */
  private _proxyReadyPromise?: Promise<void>;

  private buildToolMetadata(toolName: string, tool?: ToolDefinition): Record<string, unknown> {
    const resolvedWorkflowVersion = this.sessionContext?.workflowToolVersions?.[toolName];

    return {
      tool_type: tool?.tool_type,
      auth_type: tool?.http_binding?.auth?.type,
      endpoint: tool?.http_binding?.endpoint,
      mcp_server: tool?.mcp_binding?.server,
      sandbox_runtime: tool?.sandbox_binding?.runtime,
      sessionId: this.sessionContext?.sessionId,
      tenantId: this.sessionContext?.tenantId,
      userId: this.sessionContext?.userId,
      source: this.sessionContext?.source,
      callerContext: this.sessionContext?.callerContext,
      ...(tool?.workflow_binding?.workflowId
        ? { workflow_id: tool.workflow_binding.workflowId }
        : {}),
      ...(resolvedWorkflowVersion?.workflowVersionId || tool?.workflow_binding?.workflowVersionId
        ? {
            workflow_version_id:
              resolvedWorkflowVersion?.workflowVersionId ??
              tool?.workflow_binding?.workflowVersionId,
          }
        : {}),
      ...(resolvedWorkflowVersion?.workflowVersion || tool?.workflow_binding?.workflowVersion
        ? {
            workflow_version:
              resolvedWorkflowVersion?.workflowVersion ?? tool?.workflow_binding?.workflowVersion,
          }
        : {}),
    };
  }

  /**
   * Update the proxy resolver after construction (e.g. when config resolves asynchronously).
   * Propagates to the internal HttpToolExecutor if present.
   */
  setProxyResolver(resolver: import('./proxy-resolver.js').ProxyResolver): void {
    if (this.httpExecutor) {
      this.httpExecutor.proxyResolver = resolver;
    }
    // Propagate to namespace-scoped HTTP executors
    for (const exec of this.namespaceScopedHttpExecutors.values()) {
      exec.proxyResolver = resolver;
    }
    // Also patch MCP client provider if it supports proxy
    if (this.mcpClientProvider && 'proxyResolver' in this.mcpClientProvider) {
      (this.mcpClientProvider as { proxyResolver: unknown }).proxyResolver = resolver;
    }
  }

  /**
   * Store an async proxy resolution promise. The first `execute()` call will
   * await it, ensuring the proxy resolver is set before any tool dispatch.
   * This keeps wiring code synchronous while eliminating the race window.
   */
  setProxyReadyPromise(promise: Promise<void>): void {
    this._proxyReadyPromise = promise;
  }

  /**
   * Set the memory API on the internal sandbox executor.
   * Called after session initialization to inject the ToolMemoryBridge.
   */
  setMemoryAPI(memoryAPI: ToolMemoryAPI): void {
    if (this.sandboxExecutor) {
      this.sandboxExecutor.memoryAPI = memoryAPI;
    }
    for (const exec of this.namespaceScopedSandboxExecutors.values()) {
      exec.memoryAPI = memoryAPI;
    }
  }

  constructor(config: ToolBindingExecutorConfig) {
    this.tools = new Map();
    this.fallback = config.fallbackExecutor;
    this.trace = config.trace;
    this.maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.middleware = config.middleware || [];
    this.sessionContext = config.sessionContext;
    this.workflowToolVersionsReady = config.workflowToolVersionsReady;
    this.featureChecker = config.featureChecker;
    this.secrets = config.secrets;

    for (const tool of config.tools) {
      this.tools.set(tool.name, tool);
    }

    // Initialize type-specific executors (pass sessionContext for tenant isolation)
    const tenantId = config.sessionContext?.tenantId;
    const httpTools = config.tools.filter((t) => t.tool_type === 'http');
    if (httpTools.length > 0) {
      this.httpExecutor = new HttpToolExecutor({
        tools: httpTools,
        secrets: config.secrets,
        defaultTimeoutMs: config.defaultTimeoutMs,
        allowLocalhost: config.allowLocalhost,
        resilienceFactory: config.resilienceFactory,
        proxyResolver: config.proxyResolver,
        tenantId,
      });
    }

    const mcpTools = config.tools.filter((t) => t.tool_type === 'mcp');
    if (mcpTools.length > 0 && config.mcpClients) {
      this.mcpClientProvider = config.mcpClients;
      this.mcpExecutor = new McpToolExecutor({
        tools: mcpTools,
        mcpClients: config.mcpClients,
        projectId: config.projectId,
        resilienceFactory: config.resilienceFactory,
        tenantId,
        secrets: config.secrets,
      });
      log.debug('MCP executor initialized', {
        toolCount: mcpTools.length,
        projectId: config.projectId,
      });
    }

    const sandboxTools = config.tools.filter((t) => t.tool_type === 'sandbox');
    if (sandboxTools.length > 0 && config.sandboxRunner) {
      this.sandboxExecutor = new SandboxToolExecutor({
        tools: sandboxTools,
        runner: config.sandboxRunner,
        sessionContext: config.sessionContext,
        secrets: config.secrets,
        featureChecker: this.featureChecker,
      });
    }

    if (config.connectorToolExecutor) {
      this.connectorToolExecutor = config.connectorToolExecutor;
    }
    if (config.workflowToolExecutor) {
      this.workflowToolExecutor = config.workflowToolExecutor;
    }
    if (config.searchaiToolExecutor) {
      this.searchaiToolExecutor = config.searchaiToolExecutor;
    }
    if (config.workflowStatusTool) {
      this.workflowStatusTool = config.workflowStatusTool;
    }
    if (config.namespaceScopedSecretsFactory) {
      // Create per-tool namespace-scoped executors for tools with variable_namespace_ids
      for (const tool of config.tools) {
        if (!tool.variable_namespace_ids || tool.variable_namespace_ids.length === 0) continue;
        const scopedSecrets = config.namespaceScopedSecretsFactory(tool.variable_namespace_ids);
        this.namespaceScopedSecretsProviders.set(tool.name, scopedSecrets);

        if (tool.tool_type === 'http' && tool.http_binding) {
          this.namespaceScopedHttpExecutors.set(
            tool.name,
            new HttpToolExecutor({
              tools: [tool],
              secrets: scopedSecrets,
              defaultTimeoutMs: config.defaultTimeoutMs,
              allowLocalhost: config.allowLocalhost,
              resilienceFactory: config.resilienceFactory,
              proxyResolver: config.proxyResolver,
              tenantId,
            }),
          );
        } else if (tool.tool_type === 'mcp' && config.mcpClients) {
          this.namespaceScopedMcpExecutors.set(
            tool.name,
            new McpToolExecutor({
              tools: [tool],
              mcpClients: config.mcpClients,
              projectId: config.projectId,
              resilienceFactory: config.resilienceFactory,
              tenantId,
              secrets: scopedSecrets,
            }),
          );
        } else if (tool.tool_type === 'sandbox' && config.sandboxRunner) {
          this.namespaceScopedSandboxExecutors.set(
            tool.name,
            new SandboxToolExecutor({
              tools: [tool],
              runner: config.sandboxRunner,
              sessionContext: config.sessionContext,
              secrets: scopedSecrets,
              featureChecker: this.featureChecker,
            }),
          );
        }
      }
    }

    // Pre-compose middleware chain once (avoids repeated composition per call)
    if (this.middleware.length > 0) {
      this.composedMiddlewareFn = composeMiddleware(this.middleware, async (ctx) => {
        const res = await this.dispatch(
          ctx.toolName,
          ctx.tool ?? this.tools.get(ctx.toolName),
          ctx.params,
          ctx.timeoutMs,
          ctx.executionOptions,
        );
        return { result: res };
      });
    }
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    executionOptions?: ToolExecutionOptions,
  ): Promise<unknown> {
    // Await async proxy resolution (set during sync wiring) before first dispatch
    if (this._proxyReadyPromise) {
      await this._proxyReadyPromise;
      this._proxyReadyPromise = undefined; // Only await once
    }

    const tool = this.tools.get(toolName);
    const start = Date.now();
    const hasMiddleware = this.middleware.length > 0;

    log.debug('Tool execute start', {
      toolName,
      toolType: tool?.tool_type,
      paramCount: Object.keys(params).length,
    });

    try {
      const workflowVersionsReady =
        tool?.tool_type === 'workflow' ? this.workflowToolVersionsReady : undefined;
      if (workflowVersionsReady) {
        await workflowVersionsReady;
        if (this.workflowToolVersionsReady === workflowVersionsReady) {
          this.workflowToolVersionsReady = undefined;
        }
      }

      const paramsSize = new TextEncoder().encode(JSON.stringify(params)).length;
      if (paramsSize > MAX_TOOL_PARAMS_BYTES) {
        throw new Error(
          `Tool params too large (${paramsSize} bytes, max ${MAX_TOOL_PARAMS_BYTES})`,
        );
      }
      // Auto-inject session context variables (session_id, tenant_id, user_id)
      // into tool params when declared in schema but not provided by the LLM.
      // These are system-level parameters that agents shouldn't need to supply.
      if (this.sessionContext && tool?.parameters) {
        for (const param of tool.parameters) {
          const contextKey = (
            TOOL_SESSION_CONTEXT_PARAM_MAP as Record<string, keyof ToolSessionContext>
          )[param.name];
          if (contextKey && !(param.name in params) && this.sessionContext[contextKey]) {
            params[param.name] = this.sessionContext[contextKey];
            log.debug('Injected session context param', { toolName, param: param.name });
          }
        }
      }

      // Validate inputs against parameter schema before dispatch
      if (tool?.parameters) {
        validateToolInputs(toolName, params, tool.parameters);
      }

      let result: unknown;

      // When middleware is configured, wrap dispatch in the pre-composed middleware chain.
      // Middleware (e.g. loggingMiddleware) handles trace logging — skip inline trace to prevent duplicates.
      if (hasMiddleware && this.composedMiddlewareFn) {
        const ctx = {
          toolName,
          params,
          timeoutMs,
          tool,
          metadata: this.buildToolMetadata(toolName, tool),
          ...(executionOptions ? { executionOptions } : {}),
        };
        const mwResult = await this.composedMiddlewareFn(ctx);
        result = mwResult.result;
      } else {
        result = await this.dispatch(toolName, tool, params, timeoutMs, executionOptions);
      }

      // Only log inline trace when no middleware is configured (middleware chain handles its own logging)
      if (!hasMiddleware && this.trace) {
        try {
          await this.trace.logToolCall({
            toolName,
            input: params,
            output: result,
            latencyMs: Date.now() - start,
            success: true,
            metadata: this.buildToolMetadata(toolName, tool),
          });
        } catch (traceErr) {
          log.warn('Failed to log tool call trace', {
            toolName,
            error: traceErr instanceof Error ? traceErr.message : String(traceErr),
          });
        }
      }

      const latencyMs = Date.now() - start;

      // Mandatory audit trail — always logged regardless of trace configuration
      log.info('tool.execution', {
        event: 'tool_call',
        toolName,
        toolType: tool?.tool_type,
        success: true,
        latencyMs,
        tenantId: this.sessionContext?.tenantId,
        sessionId: this.sessionContext?.sessionId,
        userId: this.sessionContext?.userId,
        workflowId: tool?.workflow_binding?.workflowId,
        workflowVersionId:
          this.sessionContext?.workflowToolVersions?.[toolName]?.workflowVersionId ??
          tool?.workflow_binding?.workflowVersionId,
        workflowVersion:
          this.sessionContext?.workflowToolVersions?.[toolName]?.workflowVersion ??
          tool?.workflow_binding?.workflowVersion,
        timestamp: new Date().toISOString(),
      });

      log.debug('Tool execute complete', { toolName, latencyMs });
      return result;
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : 'Unknown error';
      // Sanitize error: strip stack traces, file paths, and internal details before they reach the LLM
      const sanitizedMsg = rawMsg
        .split('\n')
        .filter(
          (line) =>
            !/^\s*at\s+/.test(line) && // JS stack trace lines
            !/^\s*File\s+"\//.test(line) && // Python traceback lines
            !/^\s*\/[\w./:-]+\.(js|ts|py):\d+/.test(line), // bare file-path lines
        )
        .join(' ')
        .replace(/\/[\w./:-]+\.(js|ts|py)(:\d+)?/g, '[redacted]')
        .replace(/File\s+"[^"]*"/g, '[redacted]')
        .replace(/\bat\s+\S+\.(js|ts):\d+/g, '[redacted]')
        .replace(/Module\._compile/g, '[redacted]')
        .replace(/at process\.emit/g, '[redacted]')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .substring(0, 500);
      const failLatencyMs = Date.now() - start;

      // Mandatory audit trail for failures
      log.info('tool.execution', {
        event: 'tool_call',
        toolName,
        toolType: tool?.tool_type,
        success: false,
        latencyMs: failLatencyMs,
        error: sanitizedMsg,
        tenantId: this.sessionContext?.tenantId,
        sessionId: this.sessionContext?.sessionId,
        userId: this.sessionContext?.userId,
        workflowId: tool?.workflow_binding?.workflowId,
        workflowVersionId:
          this.sessionContext?.workflowToolVersions?.[toolName]?.workflowVersionId ??
          tool?.workflow_binding?.workflowVersionId,
        workflowVersion:
          this.sessionContext?.workflowToolVersions?.[toolName]?.workflowVersion ??
          tool?.workflow_binding?.workflowVersion,
        timestamp: new Date().toISOString(),
      });

      log.debug('Tool execute failed', { toolName, latencyMs: failLatencyMs, error: rawMsg });
      if (!hasMiddleware && this.trace) {
        try {
          await this.trace.logToolCall({
            toolName,
            input: params,
            output: null,
            latencyMs: Date.now() - start,
            success: false,
            error: rawMsg,
            metadata: this.buildToolMetadata(toolName, tool),
          });
        } catch (traceErr) {
          log.warn('Failed to log tool call failure trace', {
            toolName,
            error: traceErr instanceof Error ? traceErr.message : String(traceErr),
          });
        }
      }
      // Preserve ToolExecutionError (carries typed code + retryable hint for LLM) but sanitize its message
      if (error instanceof ToolExecutionError) {
        (error as ToolExecutionError).message = sanitizedMsg.includes(toolName)
          ? sanitizedMsg
          : `Tool ${toolName} failed: ${sanitizedMsg}`;
        throw error;
      }
      // Re-throw with sanitized message (no stack traces or internal paths leaked to LLM)
      throw new ToolExecutionError({
        code: 'TOOL_EXECUTION_ERROR',
        message: `Tool ${toolName} failed: ${sanitizedMsg}`,
        toolName,
        toolType: tool?.tool_type,
        durationMs: failLatencyMs,
        cause: error,
      });
    }
  }

  async executeParallel(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
    timeoutMs: number,
  ): Promise<Array<{ name: string; result?: unknown; error?: string }>> {
    // Concurrency-limited execution to prevent resource exhaustion
    const results: Array<{ name: string; result?: unknown; error?: string }> = [];
    const maxConcurrency = this.maxConcurrency;

    log.debug('Executing parallel tools', { totalCalls: calls.length, maxConcurrency });

    for (let i = 0; i < calls.length; i += maxConcurrency) {
      const batch = calls.slice(i, i + maxConcurrency);
      const batchResults = await Promise.all(
        batch.map(async ({ name, params }) => {
          try {
            const result = await this.execute(name, params, timeoutMs);
            return { name, result };
          } catch (error) {
            return {
              name,
              error: error instanceof Error ? error.message : 'Unknown error',
            };
          }
        }),
      );
      results.push(...batchResults);
    }

    return results;
  }

  private async dispatch(
    toolName: string,
    tool: ToolDefinition | undefined,
    params: Record<string, unknown>,
    timeoutMs: number,
    executionOptions?: ToolExecutionOptions,
  ): Promise<unknown> {
    // System tool dispatch — check_workflow_status is not in the tools Map (system-injected).
    // Intercept before the !tool guard to avoid hitting the fallback/throw path.
    if (toolName === 'check_workflow_status' && this.workflowStatusTool) {
      return this.workflowStatusTool.execute(toolName, params, timeoutMs);
    }

    if (!tool) {
      // Unknown tool — try fallback
      if (this.fallback) {
        return this.fallback.execute(toolName, params, timeoutMs);
      }
      throw new Error(`Tool not found: ${toolName}`);
    }

    const secretsForTool = this.namespaceScopedSecretsProviders.get(toolName) ?? this.secrets;
    const resolvedTool = await resolveToolRuntimeNumericFields(tool, secretsForTool);
    const hintTimeout = await resolveRuntimeNumericValue(
      resolvedTool.hints?.timeout,
      secretsForTool,
      {
        toolName,
        toolType: resolvedTool.tool_type,
        path: 'hints.timeout',
      },
    );
    const workflowBindingTimeout =
      resolvedTool.tool_type === 'workflow'
        ? await resolveRuntimeNumericValue(
            resolvedTool.workflow_binding?.timeoutMs,
            secretsForTool,
            {
              toolName,
              toolType: 'workflow',
              path: 'workflow_binding.timeoutMs',
            },
          )
        : undefined;

    // Per-tool timeout: use configured timeout when it is shorter than the caller/global timeout.
    const configuredTimeout = hintTimeout ?? workflowBindingTimeout ?? timeoutMs;
    const effectiveTimeout = Math.min(timeoutMs, configuredTimeout);
    log.debug('Dispatching tool', {
      toolName,
      toolType: resolvedTool.tool_type,
      timeoutMs: effectiveTimeout,
    });

    switch (resolvedTool.tool_type) {
      case 'http': {
        // Use namespace-scoped executor if available, otherwise default
        const httpExec = this.namespaceScopedHttpExecutors.get(toolName) || this.httpExecutor;
        if (!httpExec) throw new Error(`No HTTP executor configured for tool: ${toolName}`);
        return httpExec.execute(toolName, params, effectiveTimeout, resolvedTool, executionOptions);
      }
      case 'mcp': {
        const mcpExec = this.namespaceScopedMcpExecutors.get(toolName) || this.mcpExecutor;
        if (!mcpExec) throw new Error(`No MCP executor configured for tool: ${toolName}`);
        return mcpExec.execute(toolName, params, effectiveTimeout);
      }
      case 'sandbox': {
        const sandboxExec =
          this.namespaceScopedSandboxExecutors.get(toolName) || this.sandboxExecutor;
        if (!sandboxExec) throw new Error(`No Sandbox executor configured for tool: ${toolName}`);
        return sandboxExec.execute(toolName, params, effectiveTimeout);
      }
      case 'connector':
        if (!this.connectorToolExecutor) {
          throw new ToolExecutionError({
            code: 'TOOL_EXECUTION_ERROR',
            message: `ConnectorToolExecutor not initialized — connector tools require a ConnectorRegistry and ConnectionResolver: ${toolName}`,
            toolName,
            toolType: 'connector',
          });
        }
        return this.connectorToolExecutor.execute(toolName, params, effectiveTimeout);
      case 'workflow':
        if (!this.workflowToolExecutor) {
          throw new ToolExecutionError({
            code: 'TOOL_EXECUTION_ERROR',
            message: `WorkflowToolExecutor not initialized — workflow tools require a Restate client: ${toolName}`,
            toolName,
            toolType: 'workflow',
          });
        }
        return this.workflowToolExecutor.execute(toolName, params, effectiveTimeout);
      case 'searchai':
        if (!this.searchaiToolExecutor) {
          throw new ToolExecutionError({
            code: 'TOOL_EXECUTION_ERROR',
            message: `SearchAI tool executor not initialized: ${toolName}. Ensure SearchAI KB tools are wired in session.`,
            toolName,
            toolType: 'searchai',
          });
        }
        return this.searchaiToolExecutor.execute(toolName, params, effectiveTimeout);
      case 'lambda':
        throw new ToolExecutionError({
          code: 'TOOL_EXECUTION_ERROR',
          message: `Lambda tool execution not yet implemented: ${toolName}. Use HTTP, MCP, or Sandbox tool types.`,
          toolName,
          toolType: 'lambda',
        });
      default:
        // Contract-only tool — use fallback
        if (this.fallback) {
          return this.fallback.execute(toolName, params, effectiveTimeout);
        }
        throw new Error(
          `No executor for contract-only tool: ${toolName}. Provide a fallbackExecutor.`,
        );
    }
  }
}

/**
 * Factory function to create a ToolBindingExecutor from agent IR
 */
export function createToolBindingExecutor(
  agentIR: { tools: ToolDefinition[] },
  options: {
    secrets: SecretsProvider;
    mcpClients?: McpClientProvider;
    sandboxRunner?: SandboxRunner;
    fallbackExecutor?: ToolExecutor;
    defaultTimeoutMs?: number;
    trace?: TraceContextManager;
    maxConcurrency?: number;
    middleware?: ToolMiddleware[];
  },
): ToolBindingExecutor {
  return new ToolBindingExecutor({
    tools: agentIR.tools,
    ...options,
  });
}

// =============================================================================
// INPUT VALIDATION
// =============================================================================

/**
 * Validate tool input parameters against the tool's parameter schema.
 * Checks required fields, injects defaults, validates types and enum constraints,
 * and warns about unknown parameters.
 */
export function validateToolInputs(
  toolName: string,
  params: Record<string, unknown>,
  schema: ToolParameter[],
): void {
  const schemaNames = new Set(schema.map((p) => p.name));

  // Inject default values for missing parameters before required-check.
  // This ensures optional params with defaults reach downstream executors
  // and that required params with defaults don't fail validation.
  for (const param of schema) {
    const isMissing =
      !(param.name in params) || params[param.name] === null || params[param.name] === undefined;
    if (isMissing && param.default !== undefined) {
      params[param.name] = param.default;
      log.debug('Injected default value', {
        toolName,
        param: param.name,
        default: param.default,
      });
    }
  }

  // Check required parameters (after defaults injected)
  for (const param of schema) {
    const isMissing =
      !(param.name in params) || params[param.name] === null || params[param.name] === undefined;
    if (param.required && isMissing) {
      throw new Error(`Tool ${toolName}: missing required parameter '${param.name}'`);
    }
  }

  // Coerce + validate types of provided parameters
  // LLMs frequently return numbers/booleans as strings — coerce before rejecting
  for (const param of schema) {
    const value = params[param.name];
    if (value === undefined || value === null) continue;

    const coerced = coerceParam(value, param.type);
    if (coerced !== undefined) {
      log.debug('Coerced parameter type', {
        toolName,
        param: param.name,
        from: typeof value,
        to: typeof coerced,
      });
      params[param.name] = coerced;
    } else if (!validateParamType(value, param.type, param)) {
      throw new Error(
        `Tool ${toolName}: parameter '${param.name}' expected type '${param.type}', got '${typeof value}'`,
      );
    }
  }

  // Enforce enum constraints on all typed parameters (not just type 'enum').
  // A string param with enum: ['a', 'b'] should reject 'c'.
  for (const param of schema) {
    const value = params[param.name];
    if (value === undefined || value === null) continue;
    if (!param.enum || param.enum.length === 0) continue;

    // Type 'enum' is already validated in validateParamType — skip to avoid double-check
    if (param.type.toLowerCase() === 'enum') continue;

    const stringValue = String(value);
    const allowed = param.enum.map(String);
    if (!allowed.includes(stringValue)) {
      throw new Error(
        `Tool ${toolName}: parameter '${param.name}' value '${stringValue}' is not in allowed values [${allowed.join(', ')}]`,
      );
    }
  }

  // Warn about unexpected parameters (don't strip — downstream executors may use them)
  // _context and _session are runtime-injected metadata, not LLM params — skip them
  const runtimeInjectedKeys = new Set(['_context', '_session']);
  for (const key of Object.keys(params)) {
    if (!schemaNames.has(key) && !runtimeInjectedKeys.has(key)) {
      log.warn('Unexpected parameter for tool', { toolName, param: key });
    }
  }
}

/**
 * Attempt to coerce a string value to the expected type.
 * Returns the coerced value, or undefined if coercion is not applicable.
 * LLMs frequently send numbers as strings (e.g., "17.38" instead of 17.38)
 * and JSON objects/arrays as strings (e.g., "[1,2,3]" instead of [1,2,3]).
 */
function coerceParam(value: unknown, expectedType: string): unknown | undefined {
  if (typeof value !== 'string') return undefined;
  const type = expectedType.toLowerCase();

  switch (type) {
    case 'number': {
      const n = Number(value);
      if (value.trim() !== '' && !isNaN(n)) return n;
      return undefined;
    }
    case 'integer': {
      const n = Number(value);
      if (value.trim() !== '' && !isNaN(n) && Number.isInteger(n)) return n;
      return undefined;
    }
    case 'boolean': {
      if (value === 'true') return true;
      if (value === 'false') return false;
      return undefined;
    }
    case 'array': {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* not valid JSON */
      }
      return undefined;
    }
    case 'object': {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
      } catch {
        /* not valid JSON */
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Check if a value matches the expected parameter type.
 */
function validateParamType(value: unknown, expectedType: string, param?: ToolParameter): boolean {
  const type = expectedType.toLowerCase();

  switch (type) {
    case 'string':
    case 'date':
    case 'datetime':
    case 'email':
    case 'url':
      return typeof value === 'string';
    case 'enum':
      // Enum: must be a string and, if allowed values are defined, must be in the list
      if (typeof value !== 'string') return false;
      if (param?.enum && param.enum.length > 0) {
        return param.enum.some((v) => String(v) === value);
      }
      return true; // No enum values defined — allow any string
    case 'number':
      return typeof value === 'number' && !isNaN(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && !Array.isArray(value) && value !== null;
    default:
      // Unknown type — allow through (don't block on schema mismatches)
      return true;
  }
}
