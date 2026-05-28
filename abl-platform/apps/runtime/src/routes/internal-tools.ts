/**
 * Internal Tools Execute Route
 *
 * POST /api/internal/tools/execute
 *
 * Called by the workflow-engine to execute project tools (HTTP, sandbox, MCP)
 * within workflow tool_call steps. Reuses the same ToolBindingExecutor and
 * loadProjectToolsAsIR pipeline that agent sessions use.
 *
 * Protected by service-to-service JWT auth — tenantId is extracted from
 * the verified token, never from raw request headers.
 */

import { Router, type Request, type Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import {
  ToolBindingExecutor,
  type AgentIR,
  type McpClientProvider,
  type ToolMiddleware,
} from '@abl/compiler';
import { createInternalUserToken, signPlatformAccessToken } from '@agent-platform/shared-auth';
import { loadProjectToolsAsIR } from '../tools/load-project-tools-as-ir.js';
import { RuntimeSecretsProvider } from '../services/secrets-provider.js';
import {
  rejectIfTokenMismatch,
  type InternalServiceRequest,
} from '../middleware/internal-service-auth.js';
import { InlineMcpClientProvider } from '../services/mcp/inline-mcp-provider.js';
import { getRuntimeMcpProvider } from '../services/mcp/runtime-mcp-provider.js';
import { SearchAIKBToolExecutor } from '../services/search-ai/searchai-kb-tool-executor.js';
import { WorkflowToolExecutor } from '../services/workflow/workflow-tool-executor.js';
import { resolveWorkflowToolVersionMetadata } from '../services/workflow/workflow-tool-version-metadata.js';
import { getConfig } from '../config/loader.js';
import { decryptForTenantAuto, isTenantEncryptionReady } from '@agent-platform/shared/encryption';
import { sanitizeAuthProfileError } from '@agent-platform/shared/services/auth-profile';
import { ToolExecutionError } from '@agent-platform/shared';
import { createAuthProfileToolMiddleware } from '../services/auth-profile/auth-profile-tool-middleware.js';
import { loadConfigVariablesMap } from '../repos/project-repo.js';
import { resolveRuntimeConfigKeysInAgentIR } from '../services/tool-runtime-config-resolution.js';
import {
  resolveProjectPIISnapshot,
  createPIIVaultForProjectSnapshot,
} from '../services/pii/session-pii-context.js';
import { restorePIITokensForToolExecution } from '../services/execution/pii-tool-execution.js';
import type { RuntimeSession } from '../services/execution/types.js';
import type { PIIVault } from '@abl/compiler/platform/security/pii-vault.js';

const log = createLogger('internal-tools');

/** Default timeout for tool execution (30 seconds) */
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const USER_SAFE_TOOL_EXECUTION_ERROR =
  'Tool execution failed. Check the tool configuration and try again.';

type InternalToolExecutionMode = 'sync' | 'async_continue' | 'async_wait';

interface InternalToolCallbackConfig {
  enabled: boolean;
  location: 'body' | 'query' | 'header';
  callbackUrlKey: string;
  callbackSecretKey: string;
}

interface InternalToolAsyncHttpSuccessConfig {
  acceptedStatusCodes?: number[];
  acceptedBodyPath?: string;
  acceptedBodyEquals?: string;
}

const VALID_HTTP_CALLBACK_LOCATIONS = new Set(['body', 'query', 'header']);
const DEFAULT_HTTP_CALLBACK_CONFIG: InternalToolCallbackConfig = {
  enabled: true,
  location: 'body',
  callbackUrlKey: 'callbackUrl',
  callbackSecretKey: 'callbackSecret',
};

function normalizeHttpCallbackConfig(
  callbackConfig: InternalToolCallbackConfig | undefined,
): InternalToolCallbackConfig {
  return {
    enabled: callbackConfig?.enabled ?? DEFAULT_HTTP_CALLBACK_CONFIG.enabled,
    location:
      callbackConfig?.location && VALID_HTTP_CALLBACK_LOCATIONS.has(callbackConfig.location)
        ? callbackConfig.location
        : DEFAULT_HTTP_CALLBACK_CONFIG.location,
    callbackUrlKey:
      typeof callbackConfig?.callbackUrlKey === 'string' && callbackConfig.callbackUrlKey.trim()
        ? callbackConfig.callbackUrlKey.trim()
        : DEFAULT_HTTP_CALLBACK_CONFIG.callbackUrlKey,
    callbackSecretKey:
      typeof callbackConfig?.callbackSecretKey === 'string' &&
      callbackConfig.callbackSecretKey.trim()
        ? callbackConfig.callbackSecretKey.trim()
        : DEFAULT_HTTP_CALLBACK_CONFIG.callbackSecretKey,
  };
}

function isAsyncHttpExecutionResult(value: unknown): value is {
  __toolExecutionStatus: 'completed' | 'accepted';
  output: unknown;
  responseStatus: number;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__toolExecutionStatus' in value &&
    ((value as { __toolExecutionStatus?: unknown }).__toolExecutionStatus === 'completed' ||
      (value as { __toolExecutionStatus?: unknown }).__toolExecutionStatus === 'accepted') &&
    'responseStatus' in value &&
    typeof (value as { responseStatus?: unknown }).responseStatus === 'number'
  );
}

/**
 * Workflow auth-profile middleware kill-switch (FR-9 §11.2).
 *
 * Default true — middleware is injected and tools with `auth_profile_ref`
 * resolve credentials before HTTP execution. Set `WORKFLOW_AUTH_PROFILE_ENABLED=false`
 * to fully restore the legacy unauth behavior (no middleware, no resolution).
 */
function isWorkflowAuthProfileEnabled(): boolean {
  return process.env.WORKFLOW_AUTH_PROFILE_ENABLED !== 'false';
}

function maybeSanitizeAuthProfileToolError(err: unknown): { code: string; message: string } | null {
  const code =
    err !== null && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : null;

  if (!code) {
    return null;
  }

  const isAuthProfileRelated =
    code.startsWith('AUTH_PROFILE_') ||
    code.startsWith('OAUTH_') ||
    code === 'JIT_AUTH_NOT_SUPPORTED' ||
    code === 'AUTH_TYPE_NOT_MCP_COMPATIBLE' ||
    code === 'MCP_TRANSPORT_NOT_TLS_CAPABLE';

  if (!isAuthProfileRelated) {
    return null;
  }

  if (code === 'JIT_AUTH_NOT_SUPPORTED') {
    return {
      code,
      message: 'JIT auth profiles are not supported for workflow tool calls.',
    };
  }

  const sanitized = sanitizeAuthProfileError(err);
  return {
    code,
    message: sanitized.userMessage,
  };
}

/**
 * Recursively tokenize every string leaf in an arbitrarily-nested value.
 * Objects and arrays are traversed; non-string scalars pass through unchanged.
 *
 * Uses a WeakMap<object, unknown> to cache tokenized results. This fixes two
 * issues over the previous WeakSet-based approach:
 *
 * F-3: Shared non-cyclic objects (e.g., `{ a: shared, b: shared }`) are
 * tokenized once and the cached clone is returned on re-visit. Previously
 * the second visit returned the original untokenized object.
 *
 * Cycles: When a cycle is detected, the partially-built clone (pre-registered
 * in the cache before recursion) is returned. The parent holds a reference to
 * it, so by the time the structure is fully built, the cycle property points
 * to the tokenized clone — not the original mutable object.
 *
 * Exported for testability (F-NIT).
 */
export function tokenizeStringLeavesDeep(
  value: unknown,
  piiVault: PIIVault,
  cache: WeakMap<object, unknown>,
): unknown {
  if (typeof value === 'string') {
    const { text } = piiVault.tokenize(value);
    return text;
  }

  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  // Cache hit — return previously tokenized clone (handles shared objects AND cycles)
  const cached = cache.get(value as object);
  if (cached !== undefined) {
    return cached;
  }

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    cache.set(value as object, result); // Pre-register for cycles
    for (const entry of value) {
      result.push(tokenizeStringLeavesDeep(entry, piiVault, cache));
    }
    return result;
  }

  const result: Record<string, unknown> = {};
  cache.set(value as object, result); // Pre-register for cycles
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = tokenizeStringLeavesDeep(entry, piiVault, cache);
  }
  return result;
}

const router: Router = Router();

router.post('/execute', async (req: Request, res: Response) => {
  const serviceToken = (req as InternalServiceRequest).serviceToken;
  const { tenantId } = serviceToken;
  const {
    toolName,
    params,
    projectId: bodyProjectId,
    actorUserId,
    executionMode,
    callback,
    callbackConfig,
    asyncHttpSuccess,
    environment,
    piiAccess,
  } = req.body as {
    toolName: string;
    params: Record<string, unknown>;
    projectId: string;
    actorUserId?: string;
    executionMode?: InternalToolExecutionMode;
    callback?: { url?: string; secret?: string };
    callbackConfig?: InternalToolCallbackConfig;
    asyncHttpSuccess?: InternalToolAsyncHttpSuccessConfig;
    environment?: string;
    /** PII access level for tool test parity (FR-7). */
    piiAccess?: 'original' | 'tools' | 'user' | 'logs' | 'llm';
  };
  const requestedExecutionMode = executionMode ?? 'sync';

  if (!toolName || !bodyProjectId) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'toolName and projectId are required' },
    });
    return;
  }

  const tokenError = rejectIfTokenMismatch(serviceToken, {
    tenantId,
    projectId: bodyProjectId,
  });
  if (tokenError) {
    res.status(403).json({
      success: false,
      error: tokenError,
    });
    return;
  }
  const projectId = bodyProjectId;

  try {
    // Load MCP server configs so mcp tools get their server_config baked into
    // the IR binding. Without this the inline provider sees no servers and the
    // registry-backed singleton may not be attached on this runtime pod.
    const { findMcpServerConfigsByProject } = await import('@agent-platform/shared/repos');
    const mcpConfigs = await findMcpServerConfigsByProject(tenantId, projectId);
    const mcpConfigMap = new Map(mcpConfigs.map((c) => [c.name, c]));

    // Load the tool definition from DB and convert to IR
    let { tools } = await loadProjectToolsAsIR(tenantId, projectId, new Set([toolName]), {
      mcpConfigMap,
    });

    if (tools.length === 0) {
      res.status(404).json({
        success: false,
        error: { code: 'TOOL_NOT_FOUND', message: `Tool "${toolName}" not found in project` },
      });
      return;
    }

    const configVars = await loadConfigVariablesMap(projectId, tenantId);
    const runtimeConfigResult = resolveRuntimeConfigKeysInAgentIR(
      { tools } as AgentIR,
      configVars,
      `internal tool "${toolName}"`,
    );
    if (runtimeConfigResult.errors.length > 0) {
      throw new Error(runtimeConfigResult.errors.join('; '));
    }
    tools = (runtimeConfigResult.ir.tools ?? []) as typeof tools;
    const selectedTool = tools.find((tool) => tool.name === toolName);
    const supportsAsync =
      selectedTool?.tool_type === 'workflow' || selectedTool?.tool_type === 'http';
    if (requestedExecutionMode !== 'sync' && !supportsAsync) {
      res.status(400).json({
        success: false,
        error: {
          code: 'TOOL_CALLBACK_UNSUPPORTED',
          message: 'Async tool execution is currently supported only for workflow and HTTP tools.',
        },
      });
      return;
    }
    if (selectedTool?.tool_type === 'http' && requestedExecutionMode === 'async_continue') {
      res.status(400).json({
        success: false,
        error: {
          code: 'TOOL_EXECUTION_MODE_UNSUPPORTED',
          message:
            'HTTP tools support sync and async_wait execution modes only. Use async_wait to have the tool call back on completion.',
        },
      });
      return;
    }
    const normalizedHttpCallbackConfig =
      selectedTool?.tool_type === 'http' && requestedExecutionMode === 'async_wait'
        ? normalizeHttpCallbackConfig(callbackConfig)
        : callbackConfig;
    if (selectedTool?.tool_type === 'http' && requestedExecutionMode === 'async_wait') {
      if (normalizedHttpCallbackConfig?.enabled === false) {
        res.status(400).json({
          success: false,
          error: {
            code: 'TOOL_CALLBACK_CONFIG_INVALID',
            message:
              'Async HTTP tool execution requires enabled callback injection with URL and secret keys.',
          },
        });
        return;
      }
    }
    if (
      selectedTool?.tool_type === 'http' &&
      requestedExecutionMode === 'async_wait' &&
      (!callback ||
        typeof callback.url !== 'string' ||
        callback.url.length === 0 ||
        typeof callback.secret !== 'string' ||
        callback.secret.length === 0)
    ) {
      res.status(400).json({
        success: false,
        error: {
          code: 'TOOL_CALLBACK_REQUIRED',
          message: 'Wait-for-completion requires callback URL and secret.',
        },
      });
      return;
    }

    // Create a minimal secrets provider for tool execution
    const secrets = new RuntimeSecretsProvider({
      tenantId,
      projectId,
    });

    // Wire MCP clients so mcp-typed tools can execute. Mirrors llm-wiring.ts —
    // an inline provider for tools carrying `mcp_binding.server_config`, plus the
    // registry-backed runtime provider for DB-managed servers. Without this,
    // ToolBindingExecutor throws "No MCP executor configured for tool: ...".
    let mcpClients: McpClientProvider | undefined;
    const mcpTools = tools.filter((t) => t.tool_type === 'mcp' && t.mcp_binding?.server_config);
    const decryptor = isTenantEncryptionReady()
      ? {
          decryptForTenant: (
            encrypted: string,
            tid: string,
            context?: import('@agent-platform/shared-encryption').TenantEncryptionAADContext,
          ) => decryptForTenantAuto(encrypted, tid, context),
        }
      : undefined;
    const inlineMcp =
      mcpTools.length > 0 ? new InlineMcpClientProvider(mcpTools, decryptor, tenantId) : undefined;
    const runtimeMcp = getRuntimeMcpProvider();
    const hasRegistry = runtimeMcp.hasRegistry();
    if (inlineMcp && hasRegistry) {
      mcpClients = {
        async getClient(serverName: string, scopedProjectId?: string) {
          const client = await inlineMcp.getClient(serverName, scopedProjectId);
          if (client) return client;
          return runtimeMcp.getClient(serverName, scopedProjectId);
        },
      };
    } else if (inlineMcp) {
      mcpClients = inlineMcp;
    } else if (hasRegistry) {
      mcpClients = runtimeMcp;
    }

    // Wire SearchAI KB tool executor for tools with type: 'searchai' (Knowledge
    // Base tools). Without this, ToolBindingExecutor throws
    // "No SearchAI executor configured for tool: ...".
    let searchaiToolExecutor: SearchAIKBToolExecutor | undefined;
    const searchaiTools = tools.filter((t) => t.tool_type === 'searchai');
    if (searchaiTools.length > 0) {
      const runtimeUrl = process.env.SEARCH_AI_RUNTIME_URL || '';
      let searchAuthToken = '';
      try {
        const jwtSecret = getConfig().jwt.secret;
        if (jwtSecret) {
          searchAuthToken = createInternalUserToken(jwtSecret, { tenantId, projectId });
        }
      } catch (err) {
        log.warn('Failed to mint SearchAI token for workflow tool call', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      searchaiToolExecutor = new SearchAIKBToolExecutor({
        runtimeUrl,
        authToken: searchAuthToken,
        searchTimeoutMs: 30000,
        discoveryTimeoutMs: 5000,
      });
      for (const tool of searchaiTools) {
        if (tool.searchai_binding) {
          searchaiToolExecutor.registerBinding(tool.name, tool.searchai_binding);
        }
      }
    }

    // FR-9: inject auth-profile middleware so tools with `auth_profile_ref`
    // resolve credentials before HTTP execution. Tools without the ref
    // continue through their service-token / inline-auth path unchanged.
    // Gated by WORKFLOW_AUTH_PROFILE_ENABLED so a single env-var flip
    // restores the legacy unauth path during incident response.
    const middleware: ToolMiddleware[] = isWorkflowAuthProfileEnabled()
      ? [
          createAuthProfileToolMiddleware({
            tenantId,
            projectId,
            environment,
            workflowContext: true,
          }),
        ]
      : [];

    let workflowToolExecutor: WorkflowToolExecutor | undefined;
    const workflowTools = tools.filter((t) => t.tool_type === 'workflow');
    if (workflowTools.length > 0) {
      let workflowAuthToken = '';
      try {
        const jwtSecret = getConfig().jwt.secret;
        if (jwtSecret) {
          workflowAuthToken = signPlatformAccessToken(
            {
              sub: actorUserId ?? 'studio-tool-test',
              email: actorUserId
                ? `${actorUserId}@internal.workflow-tool.local`
                : 'studio-tool-test@internal.service',
              type: 'access',
              tokenClass: 'user',
              tenantId,
              role: 'OWNER',
              internal: true,
            },
            jwtSecret,
            { expiresIn: 3600 },
          );
        }
      } catch (err) {
        log.warn('Failed to mint workflow token for internal tool call', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const resolvedWorkflowVersions = await resolveWorkflowToolVersionMetadata({
        tenantId,
        projectId,
        tools: workflowTools,
      });
      workflowToolExecutor = new WorkflowToolExecutor({
        workflowEngineUrl: process.env.WORKFLOW_ENGINE_URL ?? '',
        authToken: workflowAuthToken,
        projectId,
        tenantId,
        triggerType: 'workflow',
        sessionId: `internal-tool-${toolName}`,
        agentName: 'studio-tool-test',
        defaultTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
        callbackBaseUrl: process.env.RUNTIME_URL,
        completionCallback:
          callback &&
          typeof callback.url === 'string' &&
          callback.url.length > 0 &&
          typeof callback.secret === 'string' &&
          callback.secret.length > 0
            ? { url: callback.url, secret: callback.secret }
            : undefined,
        resolvedWorkflowVersions,
        agentContextProjection: {
          caller: { type: 'agent', id: 'studio-tool-test' },
        },
      });
      for (const tool of workflowTools) {
        if (tool.workflow_binding) {
          const inputVariables = (tool.parameters ?? []).map((p) => ({
            name: p.name,
            type: (p.type === 'object' ? 'json' : p.type) as
              | 'string'
              | 'number'
              | 'boolean'
              | 'json',
            required: p.required ?? false,
            ...(p.description ? { description: p.description } : {}),
          }));
          workflowToolExecutor.registerBinding(tool.name, tool.workflow_binding, {
            name: tool.name,
            description: tool.description,
            inputVariables,
            triggerMode: tool.workflow_binding.mode,
          });
        }
      }
    }

    // Create executor and run the tool
    const executor = new ToolBindingExecutor({
      tools,
      secrets,
      mcpClients,
      searchaiToolExecutor,
      middleware,
      workflowToolExecutor,
      namespaceScopedSecretsFactory: (variableNamespaceIds) =>
        secrets.withNamespaceScope(variableNamespaceIds),
      sessionContext: {
        tenantId,
        ...(actorUserId ? { userId: actorUserId } : {}),
        sessionId: `internal-tool-${toolName}`,
        source: 'production',
      },
    });

    // FR-7: Apply PII rendering to tool test params for parity with live execution.
    // When piiAccess is provided, tokenize params through a temporary PIIVault and
    // render them per the configured access level, matching the reasoning-executor path.
    let effectiveParams: Record<string, unknown> = params ?? {};
    if (piiAccess) {
      try {
        const snapshot = await resolveProjectPIISnapshot({
          tenantId,
          projectId,
        });
        const piiVault = createPIIVaultForProjectSnapshot(snapshot);
        if (piiVault) {
          // Create a minimal session-like object for restorePIITokensForToolExecution.
          const testSession = {
            piiVault,
            piiPatternConfigs: snapshot.piiPatternConfigs,
          } as unknown as RuntimeSession;
          // Tokenize all string leaves (including nested objects/arrays),
          // then render per piiAccess.
          effectiveParams = tokenizeStringLeavesDeep(
            effectiveParams,
            piiVault,
            new WeakMap(),
          ) as Record<string, unknown>;
          // F-1: pass auditContext so audit emission happens inside the function.
          // DFA-M1: wire onTraceEvent through a logger-backed sink so trace events
          // (pii_plaintext_dispensed, pii_pattern_override_suppressed_original) fire
          // for Tool Test invocations. The Studio Tool Test is fire-and-forget — there
          // is no live session or WebSocket to push events back to — so the logger sink
          // routes events into structured logging for compliance dashboard consumption
          // alongside the PIIAuditLogger path that already fires unconditionally.
          const toolTestTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
            log.info('tool-test-trace-event', {
              eventType: event.type,
              toolName,
              tenantId,
              projectId,
              ...event.data,
            });
          };
          const { value: restoredParams } = restorePIITokensForToolExecution(
            testSession,
            effectiveParams,
            {
              piiAccess,
              auditContext: {
                onTraceEvent: toolTestTraceEvent,
                toolName,
                agentId: 'studio-tool-test',
                sessionId: `internal-tool-${toolName}`,
                tenantId,
                projectId,
              },
            },
          );
          effectiveParams = restoredParams as Record<string, unknown>;
        }
      } catch (err) {
        log.warn('pii-tool-test-rendering-failed', {
          error: err instanceof Error ? err.message : String(err),
          toolName,
        });
      }
    }

    const result = await executor.execute(toolName, effectiveParams, DEFAULT_TOOL_TIMEOUT_MS, {
      executionMode: requestedExecutionMode,
      ...(callback &&
      typeof callback.url === 'string' &&
      callback.url.length > 0 &&
      typeof callback.secret === 'string' &&
      callback.secret.length > 0
        ? { callback: { url: callback.url, secret: callback.secret } }
        : {}),
      ...(normalizedHttpCallbackConfig ? { callbackConfig: normalizedHttpCallbackConfig } : {}),
      ...(asyncHttpSuccess ? { asyncHttpSuccess } : {}),
    });

    if (selectedTool?.tool_type === 'http' && isAsyncHttpExecutionResult(result)) {
      res.json({
        success: true,
        data: {
          success: true,
          status: result.__toolExecutionStatus,
          output: result.output,
        },
      });
      return;
    }

    const normalizedStatus =
      selectedTool?.tool_type === 'workflow' && requestedExecutionMode !== 'sync'
        ? 'accepted'
        : 'completed';
    res.json({
      success: true,
      data: {
        success: true,
        status: normalizedStatus,
        output: result,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const sanitizedAuthError = maybeSanitizeAuthProfileToolError(err);
    log.error('Tool execution failed', { toolName, projectId, error: message });
    // ToolExecutionError carries a structured code and a user-safe message from the
    // executor (e.g. HTTP status, timeout, network failure). Propagate it so the
    // workflow execution trace shows the actual error instead of a generic fallback.
    // Plain Error instances may contain internal hostnames/IDs and stay sanitized.
    const toolExecError =
      !sanitizedAuthError && err instanceof ToolExecutionError
        ? { code: err.code, message: err.message }
        : null;
    res.status(500).json({
      success: false,
      error: sanitizedAuthError ??
        toolExecError ?? {
          code: 'TOOL_EXECUTION_FAILED',
          message: USER_SAFE_TOOL_EXECUTION_ERROR,
        },
    });
  }
});

export default router;
