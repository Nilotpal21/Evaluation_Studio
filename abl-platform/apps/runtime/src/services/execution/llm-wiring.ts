/**
 * LLM Wiring Service
 *
 * Manages per-session LLM client creation and tool executor wiring.
 * Owns all lazy-init singleton services (ModelResolution, ProxyConfig,
 * ToolSecretStore, SecretDecryptor, OAuthTokenResolver).
 */

import { getConfig, isConfigLoaded } from '../../config/loader.js';
import {
  ToolBindingExecutor,
  loggingMiddleware,
  createAuditMiddleware,
  createSecretScrubberMiddleware,
  createSecretValidationMiddleware,
  createSandboxRunner,
  createIdentityTierGateMiddleware,
} from '@abl/compiler';
import type {
  ToolMiddleware,
  ToolDefinition,
  ToolExecutor,
  AgentIR,
  CompilationOutput,
  McpClientProvider,
  SandboxRunner,
  JwtSigner,
  LambdaDeploymentStore,
} from '@abl/compiler';
import { InlineMcpClientProvider } from '../mcp/inline-mcp-provider.js';
import { createLogger } from '@abl/compiler/platform';
import { SessionLLMClient } from '../llm/session-llm-client.js';
import { ModelResolutionService } from '../llm/model-resolution.js';
import { RuntimeSecretsProvider } from '../secrets-provider.js';
import type {
  ToolSecretStore,
  SecretDecryptor,
  OAuthTokenResolver,
  EnvVarStore,
  ConfigVarStore,
} from '../secrets-provider.js';
import { NoOpToolExecutor } from './noop-tool-executor.js';
import { SearchAIAwareToolExecutor, isSearchAITool } from '../search-ai/index.js';
import {
  SearchAIKBToolExecutor,
  type SearchAIKBToolExecutorConfig,
} from '../search-ai/searchai-kb-tool-executor.js';
import { isTransferTool, TransferToolExecutor } from './transfer-tool-executor.js';
import {
  getAdapterRegistry,
  getSmartAssistClient,
  getTransferTraceEmitter,
} from '../agent-transfer/index.js';
import {
  isAttachmentTool,
  AttachmentToolExecutor,
  type AttachmentToolContext,
} from '../../tools/attachment-tool-executor.js';
import { enrichSearchAIParamDescriptions } from '../../tools/load-project-tools-as-ir.js';
import { MultimodalServiceClient } from '../../attachments/multimodal-service-client.js';
import { createToolResilienceFactory } from '../resilience/tool-resilience-factory.js';
import { createToolJsonlTraceMiddleware } from './tool-jsonl-trace.js';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';
import { ProxyConfigService, type ProxyConfigStore } from '../proxy-config-service.js';
import { ToolAuditLoggerImpl } from '../tool-audit-logger.js';
import { getAuditStore } from '../audit-store-singleton.js';
import { isTenantEncryptionReady, decryptForTenantAuto } from '@agent-platform/shared/encryption';
import { isDatabaseAvailable } from '../../db/index.js';
import { getToolOAuthService } from '../tool-oauth-service-singleton.js';
import { getRuntimeMcpProvider } from '../mcp/runtime-mcp-provider.js';
import { signPlatformAccessToken } from '@agent-platform/shared-auth';
import { mintWorkflowAuthToken } from './workflow-auth-token.js';
import type { RuntimeSession, RuntimeExecutorConfig, SessionHealthEntry } from './types.js';
import { createToolMemoryBridge } from './tool-memory-bridge.js';
import { getMemoryBridgeRegistry } from './memory-bridge-registry.js';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { RedisLambdaDeploymentStore } from '@agent-platform/shared/services/lambda';
import { getRedisClient } from '../redis/redis-client.js';
import { createAuthProfileToolMiddleware } from '../auth-profile/auth-profile-tool-middleware.js';
import { buildReasoningSettingsCacheKey } from '../llm/model-resolution-versioning.js';
import { getModelResolutionConfigurationFailure } from '../llm/model-resolution-errors.js';
import { WorkflowToolExecutor } from '../workflow/workflow-tool-executor.js';
import { WorkflowStatusTool } from '../workflow/workflow-status-tool.js';
import { resolveWorkflowToolVersionMetadata } from '../workflow/workflow-tool-version-metadata.js';
import { resolveAgentSessionProjection } from '../workflow/agent-session-resolver.js';
import {
  buildRuntimeTransferEnvelope,
  setRuntimeTransferActiveState,
} from '../agent-transfer/transfer-routing-context.js';
import { resolveCallerContextSessionPrincipalId } from '../session/execution-owners.js';

const log = createLogger('llm-wiring');
const WIRED_TOOL_EXECUTOR_MARKER = Symbol('abl.runtime.wiredToolExecutor');

function markWiredToolExecutor<T extends RuntimeSession['toolExecutor']>(executor: T): T {
  if (executor && typeof executor === 'object') {
    Object.defineProperty(executor, WIRED_TOOL_EXECUTOR_MARKER, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }
  return executor;
}

function isWiredToolExecutor(
  executor: RuntimeSession['toolExecutor'],
): executor is NonNullable<RuntimeSession['toolExecutor']> {
  return !!(executor && typeof executor === 'object' && WIRED_TOOL_EXECUTOR_MARKER in executor);
}

function rememberExternalToolExecutor(
  session: RuntimeSession,
): RuntimeSession['_externalToolExecutor'] {
  const current = session.toolExecutor;
  if (current && !isWiredToolExecutor(current)) {
    session._externalToolExecutor = current;
  }
  return session._externalToolExecutor;
}

const TRANSFER_SUMMARY_MAX_CHARS = 2000;

function buildTransferSummaryFromHistory(
  history: Array<{ role: string; content: string }>,
): string | undefined {
  if (history.length === 0) return undefined;
  const lines = history
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Agent'}: ${m.content.trim()}`)
    .join('\n');
  return lines.length > TRANSFER_SUMMARY_MAX_CHARS
    ? `${lines.slice(0, TRANSFER_SUMMARY_MAX_CHARS)}...`
    : lines;
}

/**
 * LLMWiringService — manages LLM client and tool executor lifecycle.
 *
 * Singleton services are lazily initialized and cached for the lifetime
 * of the RuntimeExecutor (one per pod).
 */
export class LLMWiringService {
  // LLM resolution (lazy-init)
  private _modelResolution: ModelResolutionService | null = null;

  // Shared ProxyConfigService (lazy-init)
  private _proxyConfigService: ProxyConfigService | null = null;

  // D5/SC2: Cached singleton adapters — avoid recreating per session
  private _toolSecretStore?: ToolSecretStore | null;
  private _secretDecryptor?: SecretDecryptor | null;
  private _oauthTokenResolver?: OAuthTokenResolver | null;
  private _envVarStore?: EnvVarStore | null;
  private _configVarStore?: ConfigVarStore | null;

  // Lambda sandbox singletons — avoid per-session Redis store and AWS SDK client creation
  private _lambdaDeploymentStore?: LambdaDeploymentStore | null;
  private _lambdaClient?: LambdaClient | null;

  // Tool collection cache — avoids re-iterating/deduplicating CompilationOutput.agents
  // per session when the same agent is created repeatedly (high-concurrency scenarios).
  // Keyed by CompilationOutput (WeakMap for GC) → activeAgentName → deduplicated+enriched tools.
  private _toolCollectionCache = new WeakMap<CompilationOutput, Map<string, ToolDefinition[]>>();

  // Thinking resolution cache — avoids redundant settings-only reasoning
  // resolution when concurrent sessions share the same reasoning snapshot.
  // Keyed with the shared reasoning-settings versioning policy so it stays in
  // sync with `ModelResolutionService.resolveReasoningSettings()`.
  private _thinkingResolutionCache = new Map<
    string,
    {
      result: {
        enableThinking?: boolean;
        thinkingBudget?: number;
        thoughtDescription?: string;
        compactionThreshold?: number;
        modelId?: string;
      };
      cachedAt: number;
    }
  >();
  private static THINKING_CACHE_TTL_MS = 5_000; // 5 seconds — short TTL for config freshness
  private static THINKING_CACHE_MAX = 500;

  // Project settings cache — avoids redundant DB lookups when concurrent sessions
  // share the same project. Key: "projectId::tenantId"
  private _projectSettingsCache = new Map<
    string,
    {
      result: {
        promptOverrides?: Record<string, string>;
        traceDimensionKeys?: string[];
      };
      cachedAt: number;
    }
  >();
  private static PROJECT_SETTINGS_CACHE_TTL_MS = 10_000; // 10 seconds
  private static PROJECT_SETTINGS_CACHE_MAX = 200;

  // ensureSessionLLMClient cooldown
  private static DEFAULT_LLM_COOLDOWN_MS = 30_000; // 30s default
  private static COOLDOWN_MAP_MAX = 10_000;
  private _llmResolutionFailedSessions: Map<string, number> = new Map();
  private _llmCooldownMs: number | null = null;

  constructor(private config: RuntimeExecutorConfig) {}

  /**
   * Get or create the ModelResolutionService (lazy-init).
   */
  private async getModelResolutionService(): Promise<ModelResolutionService> {
    if (this._modelResolution) return this._modelResolution;

    // Check if a database backend is available
    let dbAvailable = false;
    try {
      const { isResolutionDatabaseAvailable } = await import('../../repos/llm-resolution-repo.js');
      dbAvailable = isResolutionDatabaseAvailable();
    } catch (err) {
      log.debug('DB resolution module not available', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!dbAvailable) {
      log.warn(
        'ModelResolutionService: no database available — DB-backed model resolution disabled (Levels 2-5)',
      );
    }
    if (!isTenantEncryptionReady()) {
      log.warn(
        'ModelResolutionService: tenant DEK encryption not ready — encrypted credential resolution disabled',
      );
    }

    this._modelResolution = new ModelResolutionService(dbAvailable, isTenantEncryptionReady);
    return this._modelResolution;
  }

  /**
   * Get or create the shared ProxyConfigService singleton.
   * Returns null if encryption or database is not available.
   */
  private getProxyConfigService(): ProxyConfigService | null {
    if (this._proxyConfigService) return this._proxyConfigService;
    if (!isDatabaseAvailable() || !isTenantEncryptionReady()) return null;

    const store: ProxyConfigStore = {
      async findConfigs(params) {
        const { findOrgProxyConfigs } = await import('@agent-platform/shared/repos');
        return findOrgProxyConfigs({
          tenantId: params.tenantId,
          environment: params.environment,
          enabled: true,
        });
      },
    };

    this._proxyConfigService = new ProxyConfigService(store, (encrypted, tid) =>
      decryptForTenantAuto(encrypted, tid),
    );
    return this._proxyConfigService;
  }

  /**
   * Get or create a ToolSecretStore backed by MongoDB (singleton per RuntimeExecutor).
   * Returns undefined if database is not available.
   */
  private getOrCreateToolSecretStore(): ToolSecretStore | undefined {
    if (this._toolSecretStore !== undefined) return this._toolSecretStore ?? undefined;

    if (!isDatabaseAvailable()) {
      this._toolSecretStore = null;
      return undefined;
    }

    this._toolSecretStore = {
      async findSecret(params) {
        const { ToolSecret } = await import('@agent-platform/database/models');
        const record = await ToolSecret.findOne({
          tenantId: params.tenantId,
          projectId: params.projectId,
          toolName: params.toolName,
          secretKey: params.secretKey,
          environment: params.environment,
        })
          .sort({ version: -1 })
          .select('encryptedValue expiresAt version')
          .lean();
        return record ?? null;
      },
    };
    return this._toolSecretStore;
  }

  /**
   * Get or create a SecretDecryptor backed by EncryptionService (singleton).
   * Returns undefined if tenant DEK encryption is not ready.
   */
  private getOrCreateSecretDecryptor(): SecretDecryptor | undefined {
    if (this._secretDecryptor !== undefined) return this._secretDecryptor ?? undefined;

    if (!isTenantEncryptionReady()) {
      this._secretDecryptor = null;
      return undefined;
    }
    this._secretDecryptor = {
      decryptForTenant: (encrypted: string, tid: string, context) =>
        decryptForTenantAuto(encrypted, tid, context),
    };
    return this._secretDecryptor;
  }

  /**
   * Get or create an OAuthTokenResolver backed by ToolOAuthService singleton.
   * Returns undefined if the service is not initialized (encryption/DB not available).
   */
  private getOrCreateOAuthTokenResolver(): OAuthTokenResolver | undefined {
    if (this._oauthTokenResolver !== undefined) return this._oauthTokenResolver ?? undefined;

    const oauthService = getToolOAuthService();
    if (!oauthService) {
      this._oauthTokenResolver = null;
      return undefined;
    }
    this._oauthTokenResolver = {
      getAccessToken: (tid, uid, provider) => oauthService.getAccessToken(tid, uid, provider),
    };
    return this._oauthTokenResolver;
  }

  /**
   * Get or create an EnvVarStore backed by MongoDB (singleton per RuntimeExecutor).
   * Returns undefined if database is not available.
   */
  private getOrCreateEnvVarStore(): EnvVarStore | undefined {
    if (this._envVarStore !== undefined) return this._envVarStore ?? undefined;

    if (!isDatabaseAvailable()) {
      this._envVarStore = null;
      return undefined;
    }

    // Include encryption metadata fields so the Mongoose encryption plugin can
    // transparently decrypt in its post-find hook. Without these fields (ire,
    // tenantId, cek, iv, kmsKeyId, fieldsToEncrypt), the plugin skips decryption
    // and returns raw ciphertext, causing downstream decryption mismatches.
    const ENV_VAR_SELECT = '_id key encryptedValue ire tenantId cek iv kmsKeyId fieldsToEncrypt';

    this._envVarStore = {
      async findEnvVar(params) {
        const { EnvironmentVariable } = await import('@agent-platform/database/models');

        // When namespace IDs are provided, filter env vars by namespace membership
        if (params.variableNamespaceIds && params.variableNamespaceIds.length > 0) {
          const { VariableNamespaceMembership } = await import('@agent-platform/database/models');

          // Find the env var first (exact environment match)
          let envVar = await EnvironmentVariable.findOne({
            tenantId: params.tenantId,
            projectId: params.projectId,
            environment: params.environment,
            key: params.key,
          }).select(ENV_VAR_SELECT);

          // Global fallback: if no env-specific match, try environment: 'global'
          if (!envVar && params.environment !== 'global') {
            envVar = await EnvironmentVariable.findOne({
              tenantId: params.tenantId,
              projectId: params.projectId,
              environment: 'global',
              key: params.key,
            }).select(ENV_VAR_SELECT);
          }

          if (!envVar) return null;

          // Check if this variable belongs to any of the allowed namespaces
          const membership = await VariableNamespaceMembership.findOne({
            tenantId: params.tenantId,
            projectId: params.projectId,
            variableId: envVar._id,
            variableType: 'env',
            namespaceId: { $in: params.variableNamespaceIds },
          }).lean();

          if (!membership) return null;

          // Plugin has already decrypted encryptedValue — return as-is
          return { encryptedValue: envVar.encryptedValue };
        }

        // Non-namespace path: exact environment match first
        const record = await EnvironmentVariable.findOne({
          tenantId: params.tenantId,
          projectId: params.projectId,
          environment: params.environment,
          key: params.key,
        }).select(ENV_VAR_SELECT);

        if (record) return { encryptedValue: record.encryptedValue };

        // Global fallback: try environment: 'global'
        if (params.environment !== 'global') {
          const baseRecord = await EnvironmentVariable.findOne({
            tenantId: params.tenantId,
            projectId: params.projectId,
            environment: 'global',
            key: params.key,
          }).select(ENV_VAR_SELECT);
          return baseRecord ? { encryptedValue: baseRecord.encryptedValue } : null;
        }

        return null;
      },
    };
    return this._envVarStore;
  }

  /**
   * Get or create a ConfigVarStore backed by MongoDB (singleton per RuntimeExecutor).
   * Returns undefined if database is not available.
   */
  private getOrCreateConfigVarStore(): ConfigVarStore | undefined {
    if (this._configVarStore !== undefined) return this._configVarStore ?? undefined;

    if (!isDatabaseAvailable()) {
      this._configVarStore = null;
      return undefined;
    }

    this._configVarStore = {
      async findConfigVar(params) {
        const { ProjectConfigVariable } = await import('@agent-platform/database/models');

        // When namespace IDs are provided, filter config vars by namespace membership
        if (params.variableNamespaceIds && params.variableNamespaceIds.length > 0) {
          const { VariableNamespaceMembership } = await import('@agent-platform/database/models');

          const configVar = await ProjectConfigVariable.findOne({
            tenantId: params.tenantId,
            projectId: params.projectId,
            key: params.key,
          })
            .select('_id value')
            .lean();

          if (!configVar) return null;

          // Check if this variable belongs to any of the allowed namespaces
          const membership = await VariableNamespaceMembership.findOne({
            tenantId: params.tenantId,
            projectId: params.projectId,
            variableId: configVar._id,
            variableType: 'config',
            namespaceId: { $in: params.variableNamespaceIds },
          }).lean();

          if (!membership) return null;

          return { value: configVar.value };
        }

        const record = await ProjectConfigVariable.findOne({
          tenantId: params.tenantId,
          projectId: params.projectId,
          key: params.key,
        })
          .select('value')
          .lean();
        return record ?? null;
      },
    };
    return this._configVarStore;
  }

  /**
   * Get or create a RedisLambdaDeploymentStore backed by Redis (singleton per RuntimeExecutor).
   * Returns undefined if Redis is not available.
   */
  private getOrCreateLambdaDeploymentStore(): LambdaDeploymentStore | undefined {
    if (this._lambdaDeploymentStore !== undefined) return this._lambdaDeploymentStore ?? undefined;

    const redis = getRedisClient();
    if (!redis) {
      this._lambdaDeploymentStore = null;
      return undefined;
    }
    this._lambdaDeploymentStore = new RedisLambdaDeploymentStore(redis);
    return this._lambdaDeploymentStore;
  }

  /**
   * Get or create a shared LambdaClient (singleton per RuntimeExecutor).
   * AWS SDK clients are designed for long-lived reuse with connection pooling.
   */
  private getOrCreateLambdaClient(): LambdaClient | undefined {
    if (this._lambdaClient !== undefined) return this._lambdaClient ?? undefined;
    const region = process.env.LAMBDA_RUNNER_REGION || 'us-east-1';
    this._lambdaClient = new LambdaClient({ region });
    return this._lambdaClient;
  }

  /**
   * Wire up ToolBindingExecutor for a session with all tool types (HTTP, MCP, Sandbox).
   *
   * All tool config is already in the IR (baked at compile time):
   * - HTTP: endpoint, headers, auth from http_binding
   * - MCP: full server config from mcp_binding.server_config (encrypted env decrypted at call time)
   * - Sandbox: code_content from sandbox_binding
   *
   * Zero DB/Redis lookups. Session creation stays SYNC.
   */
  wireToolExecutor(
    session: RuntimeSession,
    compilationOutput: CompilationOutput | null,
    authToken?: string,
    tenantId?: string,
    projectId?: string,
    trace?: import('@abl/compiler/platform').TraceContextManager,
  ): void {
    // Always persist tenant/auth context on the session
    if (tenantId) session.tenantId = tenantId;
    if (authToken) session.authToken = authToken;

    const externalFallbackExecutor = rememberExternalToolExecutor(session);

    if (!compilationOutput) {
      session.toolExecutor = markWiredToolExecutor(
        externalFallbackExecutor ?? new NoOpToolExecutor(),
      );
      return;
    }

    // Collect all tools from agents, with caching per (CompilationOutput, activeAgentName).
    // This avoids re-iterating and deduplicating agents on every session creation when the
    // same agent is created repeatedly (e.g., 300 concurrent sessions for the same agent).
    const activeAgentName = session.agentName;
    const allTools = this._collectToolsCached(compilationOutput, activeAgentName);

    if (allTools.length === 0) {
      // Even with no compiled tools, wire attachment executor so built-in
      // attachment tool calls (upload_attachment, get_attachment, etc.) are handled.
      const multimodalClient = new MultimodalServiceClient();
      const attExecutor = new AttachmentToolExecutor({
        serviceClient: multimodalClient,
        destinations: session.agentIR?.destinations?.map((d) => ({
          ...d,
          method: d.method ?? 'POST',
        })),
      });
      const attCtx: AttachmentToolContext = {
        tenantId: tenantId || session.tenantId || '',
        sessionId: session.id,
        projectId: projectId || session.projectId || '',
      };
      const fallbackExecutor = externalFallbackExecutor ?? new NoOpToolExecutor();
      session.toolExecutor = {
        execute: async (toolName: string, params: Record<string, unknown>, timeoutMs: number) => {
          if (isAttachmentTool(toolName)) {
            return attExecutor.execute(toolName, params, attCtx);
          }
          return fallbackExecutor.execute(toolName, params, timeoutMs);
        },
        executeParallel: async (
          calls: Array<{ name: string; params: Record<string, unknown> }>,
          timeoutMs: number,
        ) => {
          const attCalls = calls.filter((c) => isAttachmentTool(c.name));
          const otherCalls = calls.filter((c) => !isAttachmentTool(c.name));
          const [attResults, otherResults] = await Promise.all([
            Promise.all(
              attCalls.map(async (c) => {
                try {
                  const result = await attExecutor.execute(c.name, c.params, attCtx);
                  return { name: c.name, result };
                } catch (err) {
                  return {
                    name: c.name,
                    error: err instanceof Error ? err.message : String(err),
                  };
                }
              }),
            ),
            otherCalls.length > 0
              ? fallbackExecutor.executeParallel(otherCalls, timeoutMs)
              : Promise.resolve([]),
          ]);
          return [...attResults, ...otherResults];
        },
      } as any;
      session.toolExecutor = markWiredToolExecutor(session.toolExecutor);
      return;
    }

    // SearchAI enrichment is performed inside _collectToolsCached (runs once per cache miss).

    this._wireExecutor(
      session,
      allTools,
      authToken,
      tenantId,
      trace,
      projectId,
      externalFallbackExecutor,
    );
  }

  /**
   * Collect, deduplicate, and enrich tools from a CompilationOutput, with caching.
   * The result is cached per (CompilationOutput, activeAgentName) since dedup
   * priority depends on which agent is currently active.
   */
  private _collectToolsCached(
    compilationOutput: CompilationOutput,
    activeAgentName: string,
  ): ToolDefinition[] {
    let agentMap = this._toolCollectionCache.get(compilationOutput);
    if (!agentMap) {
      agentMap = new Map();
      this._toolCollectionCache.set(compilationOutput, agentMap);
    }

    const cached = agentMap.get(activeAgentName);
    if (cached) return cached;

    // Collect all tools from agents. When duplicate tool names exist across agents,
    // prefer the currently active agent's definition so auth bindings, MCP configs,
    // and parameter schemas stay aligned with the agent that's actually taking the turn.
    const orderedAgentEntries = Object.entries(compilationOutput.agents).sort(([left], [right]) => {
      if (left === activeAgentName && right !== activeAgentName) return -1;
      if (right === activeAgentName && left !== activeAgentName) return 1;
      return 0;
    });

    const seen = new Map<string, string>();
    const allTools = orderedAgentEntries.flatMap(([agentName, ir]) =>
      (ir.tools || []).filter((tool) => {
        const keptAgentName = seen.get(tool.name);
        if (keptAgentName) {
          log.warn(
            'Duplicate tool name encountered during dedup — keeping prioritized definition',
            {
              toolName: tool.name,
              toolType: tool.tool_type,
              description: tool.description?.slice(0, 80),
              activeAgentName,
              keptAgentName,
              skippedAgentName: agentName,
            },
          );
          return false;
        }
        seen.set(tool.name, agentName);
        return true;
      }),
    );

    // Enrich SearchAI tool param descriptions (idempotent — only writes if empty).
    // These are the FULL descriptions. buildTools() will strip params at
    // prompt-build time based on the KB tier (stored on session by discovery callback).
    // Before discovery completes, buildTools() defaults to 'simple' tier
    // stripping — keeping schema lean for the critical first LLM call.
    for (const tool of allTools) {
      if (tool.tool_type === 'searchai') {
        enrichSearchAIParamDescriptions(tool);
      }
    }

    agentMap.set(activeAgentName, allTools);
    return allTools;
  }

  /**
   * Get cached thinking resolution result if still within TTL.
   */
  private _getCachedThinkingResolution(key: string):
    | {
        enableThinking?: boolean;
        thinkingBudget?: number;
        thoughtDescription?: string;
        compactionThreshold?: number;
        modelId?: string;
      }
    | undefined {
    const entry = this._thinkingResolutionCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > LLMWiringService.THINKING_CACHE_TTL_MS) {
      this._thinkingResolutionCache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  /**
   * Store thinking resolution result in cache with TTL.
   */
  private _setCachedThinkingResolution(
    key: string,
    result: {
      enableThinking?: boolean;
      thinkingBudget?: number;
      thoughtDescription?: string;
      compactionThreshold?: number;
      modelId?: string;
    },
  ): void {
    if (this._thinkingResolutionCache.size >= LLMWiringService.THINKING_CACHE_MAX) {
      const firstKey = this._thinkingResolutionCache.keys().next().value;
      if (firstKey) this._thinkingResolutionCache.delete(firstKey);
    }
    this._thinkingResolutionCache.set(key, { result, cachedAt: Date.now() });
  }

  /**
   * Get cached project settings if still within TTL.
   */
  private _getCachedProjectSettings(key: string):
    | {
        promptOverrides?: Record<string, string>;
        traceDimensionKeys?: string[];
      }
    | undefined {
    const entry = this._projectSettingsCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > LLMWiringService.PROJECT_SETTINGS_CACHE_TTL_MS) {
      this._projectSettingsCache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  /**
   * Store project settings result in cache with TTL.
   */
  private _setCachedProjectSettings(
    key: string,
    result: {
      promptOverrides?: Record<string, string>;
      traceDimensionKeys?: string[];
    },
  ): void {
    if (this._projectSettingsCache.size >= LLMWiringService.PROJECT_SETTINGS_CACHE_MAX) {
      const firstKey = this._projectSettingsCache.keys().next().value;
      if (firstKey) this._projectSettingsCache.delete(firstKey);
    }
    this._projectSettingsCache.set(key, { result, cachedAt: Date.now() });
  }

  /**
   * Core wiring: create ToolBindingExecutor with all required context.
   * Includes InlineMcpClientProvider (IR-baked), SandboxRunner (gVisor or Lambda
   * via createSandboxRunner factory), secret scrubber/validation middleware,
   * and callerContext propagation.
   */
  private _wireExecutor(
    session: RuntimeSession,
    allTools: ToolDefinition[],
    authToken?: string,
    tenantId?: string,
    trace?: import('@abl/compiler/platform').TraceContextManager,
    projectId?: string,
    fallbackExecutor?: ToolExecutor,
  ): void {
    const activationAuthContext = session._activationAuthContext;
    const resolvedTenantId = tenantId || activationAuthContext?.tenantId || session.tenantId;
    const resolvedProjectId = projectId || activationAuthContext?.projectId || session.projectId;
    const resolvedUserId = activationAuthContext?.userId ?? session.userId;
    const resolvedAuthToken = authToken ?? activationAuthContext?.authToken ?? session.authToken;
    const resolvedCallerContext = activationAuthContext?.callerContext ?? session.callerContext;
    const resolvedAuthScope = activationAuthContext?.authScope ?? session.callerContext?.authScope;
    const resolvedSessionPrincipalId =
      resolveCallerContextSessionPrincipalId(resolvedCallerContext);
    const resolvedEnvironment = session.versionInfo?.environment ?? 'dev';
    const toolSessionSource =
      resolvedEnvironment === 'production' || resolvedEnvironment === 'staging'
        ? resolvedEnvironment
        : 'test';

    const secrets = new RuntimeSecretsProvider({
      tenantId: resolvedTenantId,
      authToken: resolvedAuthToken,
      userId: resolvedUserId,
      agentIR: session.agentIR,
      projectId: resolvedProjectId,
      environment: resolvedEnvironment,
      secretStore: this.getOrCreateToolSecretStore(),
      decryptor: this.getOrCreateSecretDecryptor(),
      oauthResolver: this.getOrCreateOAuthTokenResolver(),
      envVarStore: this.getOrCreateEnvVarStore(),
      configVarStore: this.getOrCreateConfigVarStore(),
    });
    const resilienceFactory = createToolResilienceFactory(resolvedTenantId);

    // Middleware chain — logging, JSONL trace, PII scrubbing, audit, secret scrubbing/validation
    const middleware: ToolMiddleware[] = [];
    middleware.push(loggingMiddleware(trace));
    middleware.push(createToolJsonlTraceMiddleware());

    // Audit middleware — use the shared audit store when it is available
    try {
      const auditStore = getAuditStore();
      if (auditStore) {
        const auditLogger = new ToolAuditLoggerImpl(auditStore);
        middleware.push(createAuditMiddleware(auditLogger));
      }
    } catch (err) {
      log.warn('Audit logger init failed — session will proceed without audit trail', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Identity tier gate — block tool execution when caller's tier is below tool's required tier
    middleware.push(createIdentityTierGateMiddleware());

    // Secret scrubber — strip leaked tokens/keys from tool results before LLM exposure
    middleware.push(createSecretScrubberMiddleware());

    if (resolvedTenantId) {
      middleware.push(
        createAuthProfileToolMiddleware({
          tenantId: resolvedTenantId,
          environment: resolvedEnvironment,
          projectId: resolvedProjectId,
          userId: resolvedUserId,
          sessionPrincipalId: resolvedSessionPrincipalId,
          authScope: resolvedAuthScope,
          configVarStore: this.getOrCreateConfigVarStore(),
          sessionId: session.id,
          sendAuthChallenge: session.sendAuthChallenge,
          initiateJitOAuth: session.initiateJitOAuth,
          agentName: session.agentName,
          onToolAuthResolved: (params) => {
            try {
              const { getTraceStore } = require('../trace-store.js');
              const store = getTraceStore();
              store.addEvent(session.id, {
                id: require('crypto').randomUUID(),
                sessionId: session.id,
                type: 'tool_auth_resolved',
                timestamp: new Date(),
                data: {
                  toolName: params.toolName,
                  profileName: params.profileName,
                  scope: params.scope,
                  ...(params.moduleAlias ? { moduleAlias: params.moduleAlias } : {}),
                },
                agentName: params.agentName,
              });
            } catch {
              // Non-fatal — trace emission failure must not break tool auth
            }
          },
        }),
      );
    }

    // Secret validation — reject tools with unresolved auth placeholders before sending
    middleware.push(createSecretValidationMiddleware());

    // Proxy config (async patch for HTTP tools and MCP SSE transport)
    const proxyConfigService = this.getProxyConfigService();

    // Wire MCP (reads config from IR — no DB lookups for inline tools)
    let mcpClients: McpClientProvider | undefined;
    const mcpTools = allTools.filter((t) => t.tool_type === 'mcp' && t.mcp_binding?.server_config);
    let inlineMcp: InlineMcpClientProvider | null = null;
    if (mcpTools.length > 0 && resolvedTenantId) {
      inlineMcp = new InlineMcpClientProvider(
        mcpTools,
        this.getOrCreateSecretDecryptor(),
        resolvedTenantId,
      );
    }

    // Check registry-based RuntimeMcpProvider
    const runtimeMcp = getRuntimeMcpProvider();
    const hasRegistry = runtimeMcp.hasRegistry();

    // Composite: try inline first, fall back to registry
    if (inlineMcp && hasRegistry) {
      mcpClients = {
        async getClient(serverName: string, projectId?: string) {
          const client = await inlineMcp!.getClient(serverName, projectId);
          if (client) return client;
          return runtimeMcp.getClient(serverName, projectId);
        },
      };
    } else if (inlineMcp) {
      mcpClients = inlineMcp;
    } else if (hasRegistry) {
      mcpClients = runtimeMcp;
    }

    // Proxy config: capture the service ref; the actual async resolution is deferred
    // until after the executor is constructed (see setProxyReadyPromise below).
    // This keeps _wireExecutor and wireToolExecutor fully synchronous.

    // Wire Sandbox (code from IR — no DB lookups)
    const sandboxTools = allTools.filter((t) => t.tool_type === 'sandbox');
    const sandboxRunner =
      sandboxTools.length > 0
        ? this._buildSandboxRunner(session, resolvedTenantId, resolvedProjectId)
        : undefined;

    // Wire ConnectorToolExecutor for connector-bound tools
    let connectorToolExecutor: ToolExecutor | undefined;
    const connectorTools = allTools.filter((t) => t.tool_type === 'connector');
    if (connectorTools.length > 0 && resolvedTenantId && resolvedProjectId) {
      // Create a lazy-initializing wrapper: the actual ConnectorToolExecutor is
      // created on first call (async) to avoid blocking synchronous wiring.
      let innerExecutor: ToolExecutor | null | undefined;
      connectorToolExecutor = {
        async execute(toolName: string, params: Record<string, unknown>, timeoutMs: number) {
          if (innerExecutor === undefined) {
            const { createConnectorToolExecutorAdapter } =
              await import('../connector-registry-singleton.js');
            innerExecutor = await createConnectorToolExecutorAdapter(
              resolvedTenantId!,
              resolvedProjectId!,
              resolvedUserId,
            );
          }
          if (!innerExecutor) {
            throw new Error(
              `Connector tool executor not available — ensure connector registry is initialized: ${toolName}`,
            );
          }
          return innerExecutor.execute(toolName, params, timeoutMs);
        },
        async executeParallel(
          calls: Array<{ name: string; params: Record<string, unknown> }>,
          timeoutMs: number,
        ) {
          if (innerExecutor === undefined) {
            const { createConnectorToolExecutorAdapter } =
              await import('../connector-registry-singleton.js');
            innerExecutor = await createConnectorToolExecutorAdapter(
              resolvedTenantId!,
              resolvedProjectId!,
              resolvedUserId,
            );
          }
          if (!innerExecutor) {
            return calls.map((c) => ({
              name: c.name,
              error: 'Connector tool executor not available',
            }));
          }
          return innerExecutor.executeParallel(calls, timeoutMs);
        },
      };
    }

    // Mint an internal service JWT for Runtime → SearchAI calls (KB tools
    // AND direct search tools). This token:
    // - Uses the same JWT_SECRET both services share
    // - Includes tenantId so SearchAI Runtime can scope queries correctly
    // - Has a 1-hour expiry (covers the entire agent session)
    // - Uses type:'access' so the unified auth middleware accepts it
    // - Uses a stable 'service:runtime' sub so SearchAI's getUserById()
    //   can recognize internal calls without requiring a real User record.
    //   Previously used resolvedUserId which, for SDK sessions, is a synthetic
    //   session principal (e.g., sdkp_xxx) that doesn't exist in the User
    //   collection, causing 401 "User not found" on every KB tool call via WebSDK.
    let searchAuthToken = resolvedAuthToken; // fallback to caller token
    try {
      const jwtSecret = getConfig().jwt.secret;
      if (jwtSecret && resolvedTenantId) {
        searchAuthToken = signPlatformAccessToken(
          {
            sub: 'service:runtime',
            email: 'runtime-internal@service.local',
            type: 'access',
            tokenClass: 'user',
            tenantId: resolvedTenantId,
            ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
            role: 'OWNER',
            internal: true,
          },
          jwtSecret,
          { expiresIn: 3600 },
        );
      }
    } catch (err) {
      log.warn('Failed to mint internal SearchAI token, falling back to user token', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Extract user identity from session for RACL permission filtering.
    // Used by BOTH the KB-as-tool executor (searchai type) and legacy search tool executor.
    // Only forwarded when identityTier >= 2 (Contact-eligible, verified users)
    // so SearchAI can apply per-user content access filters (allowedUsers,
    // allowedGroups, allowedDomains clauses).
    let searchUserIdentity: SearchAIKBToolExecutorConfig['userIdentity'] | undefined;
    const identityTier = resolvedCallerContext?.identityTier;
    if (identityTier !== undefined && identityTier >= 2) {
      const contactCtx = resolvedCallerContext?.contactContext as
        | Record<string, unknown>
        | undefined;
      const email = contactCtx?.email as string | undefined;
      if (email) {
        searchUserIdentity = {
          email,
          name: (contactCtx?.name as string) ?? undefined,
          domain: email.split('@')[1],
          groups: Array.isArray(contactCtx?.groups) ? (contactCtx.groups as string[]) : undefined,
        };
      }
    }

    // Build RACL headers for SearchAI service calls (reused by both executors)
    const searchUserHeaders: Record<string, string> = {};
    if (searchUserIdentity?.email) {
      searchUserHeaders['X-Auth-Mode'] = 'user';
      searchUserHeaders['X-User-Identity'] = JSON.stringify({
        email: searchUserIdentity.email,
        name: searchUserIdentity.name,
        domain: searchUserIdentity.domain ?? searchUserIdentity.email.split('@')[1],
        groups: searchUserIdentity.groups,
        idpProvider: 'platform',
        idpUserId: searchUserIdentity.email,
      });
    }

    // Wire SearchAI KB tool executor for tools with type: 'searchai'
    let searchaiToolExecutor: SearchAIKBToolExecutor | undefined;
    const searchaiTools = allTools.filter((t) => t.tool_type === 'searchai');
    if (searchaiTools.length > 0) {
      const runtimeUrl = process.env.SEARCH_AI_RUNTIME_URL || '';

      searchaiToolExecutor = new SearchAIKBToolExecutor({
        runtimeUrl,
        authToken: searchAuthToken,
        searchTimeoutMs: 30000,
        discoveryTimeoutMs: 5000,
        userIdentity: searchUserIdentity,
      });

      // Register bindings for each searchai tool
      for (const tool of searchaiTools) {
        if (tool.searchai_binding) {
          searchaiToolExecutor.registerBinding(tool.name, tool.searchai_binding);
        }
      }

      // Trigger eager discovery for all SearchAI tools so the LLM has
      // rich context (filter fields, vocabulary, query examples) on the
      // FIRST call, not just the second. Promises are collected and stored
      // on session._searchaiDiscoveryReady so the WS handler can await
      // them before sending agent_loaded — guaranteeing the enriched
      // description + correct tier are ready for the very first user message.
      const discoveryPromises: Promise<void>[] = [];
      for (const tool of searchaiTools) {
        if (tool.searchai_binding) {
          discoveryPromises.push(
            searchaiToolExecutor.triggerEagerDiscovery(tool.name).catch(() => {
              // Non-fatal — fallback description will be used
            }),
          );
        }
      }
      if (discoveryPromises.length > 0) {
        // Combine all discovery promises with a 4s safety timeout so a slow
        // SearchAI Runtime doesn't block session open indefinitely.
        session._searchaiDiscoveryReady = Promise.race([
          Promise.all(discoveryPromises).then(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 4000)),
        ]);
      }

      // Store executor reference on session for speculative parallel search
      session._searchaiToolExecutor = searchaiToolExecutor;

      // Set callback to update tool description + tier when discovery completes.
      // Store the tier on the session so buildTools() can apply tier-aware
      // param stripping at prompt-build time (works for both first and subsequent calls).
      searchaiToolExecutor.setDescriptionCallback((toolName, description, tier) => {
        if (!session._effectiveConfig) {
          session._effectiveConfig = {
            additionalInstructions: [],
            tools: [...(session.agentIR?.tools ?? allTools)],
            additionalConstraints: [],
            activeProfileNames: [],
          };
        }
        const tool = session._effectiveConfig.tools.find((t) => t.name === toolName);
        if (tool) {
          tool.description = description;
        }

        // Store tier so buildTools() can do param stripping at prompt-build time
        if (!session._searchaiToolTiers) {
          session._searchaiToolTiers = new Map();
        }
        session._searchaiToolTiers.set(toolName, tier);
      });

      // Wire context-aware search: pass conversation context and LLM function.
      // The executor uses these as a safety net for query enrichment when the LLM
      // loses context due to conversation compaction, and for result summarization.
      if (session.llmClient) {
        searchaiToolExecutor.setLLMChat(async (systemPrompt, userContent) => {
          const result = await session.llmClient!.chatWithToolUse(
            systemPrompt,
            [{ role: 'user' as const, content: userContent }],
            [], // No tools — plain text generation
            'response_gen',
            { maxTokens: 600 },
          );
          return result.text || '';
        });
      }

      // Provide conversation history snapshot to executor.
      // Updated on each execution via a getter that reads session state.
      const execRef = searchaiToolExecutor;
      const origExecute = searchaiToolExecutor.execute.bind(searchaiToolExecutor);
      searchaiToolExecutor.execute = async (toolName, params, timeoutMs) => {
        const turns = (session.conversationHistory || [])
          .filter(
            (m) =>
              (m.role === 'user' || m.role === 'assistant') &&
              typeof m.content === 'string' &&
              m.content.trim() !== '',
          )
          .slice(-6)
          .map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: String(m.content),
          }));
        execRef.setConversationContext(turns);
        return origExecute(toolName, params, timeoutMs);
      };
    }

    // Wire WorkflowToolExecutor for tools with type: 'workflow'
    let workflowToolExecutor: WorkflowToolExecutor | undefined;
    let workflowAuthToken = resolvedAuthToken;
    const workflowTools = allTools.filter((t) => t.tool_type === 'workflow');
    const workflowToolVersions: Awaited<ReturnType<typeof resolveWorkflowToolVersionMetadata>> = {};
    const workflowToolVersionsReady =
      workflowTools.length > 0 && resolvedTenantId && resolvedProjectId
        ? resolveWorkflowToolVersionMetadata({
            tenantId: resolvedTenantId,
            projectId: resolvedProjectId,
            tools: workflowTools,
            workflowVersionManifest: session.versionInfo?.workflowVersionManifest,
          }).then((resolvedVersions) => {
            Object.assign(workflowToolVersions, resolvedVersions);
            return resolvedVersions;
          })
        : undefined;
    if (workflowTools.length > 0 && resolvedTenantId && resolvedProjectId) {
      // Mint internal JWT using same pattern as SearchAI block
      try {
        const jwtSecret = getConfig().jwt.secret;
        if (jwtSecret && resolvedTenantId) {
          workflowAuthToken = mintWorkflowAuthToken({
            secret: jwtSecret,
            tenantId: resolvedTenantId,
            ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
          });
        }
      } catch (err) {
        log.warn('Failed to mint internal workflow token, falling back to user token', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Phase 3: project session metadata for the workflow's agentSession /
      // agentContext globals. resolveAgentSessionProjection translates
      // Session.source into the workflow enum (studio→studio-debug) and
      // derives endUserId from CallerContext via the existing helper.
      const nowIso = new Date().toISOString();
      const localeFromCallerData = ((): string | undefined => {
        const value = session.callerData?.locale;
        return typeof value === 'string' ? value : undefined;
      })();
      const agentSessionProjection = resolveAgentSessionProjection({
        sessionId: session.id,
        agentName: session.agentName,
        ...(session.callerContext ? { callerContext: session.callerContext } : {}),
        ...(session.channelType ? { channelType: session.channelType } : {}),
        ...(localeFromCallerData ? { locale: localeFromCallerData } : {}),
        startedAt: nowIso,
        lastActivityAt: nowIso,
      });

      workflowToolExecutor = new WorkflowToolExecutor({
        workflowEngineUrl: process.env.WORKFLOW_ENGINE_URL ?? '',
        authToken: workflowAuthToken ?? '',
        projectId: resolvedProjectId!,
        tenantId: resolvedTenantId!,
        sessionId: session.id,
        agentName: session.agentName,
        defaultTimeoutMs: 60_000,
        callbackBaseUrl: process.env.RUNTIME_URL,
        resolvedWorkflowVersions: workflowToolVersions,
        resolvedWorkflowVersionsReady: workflowToolVersionsReady,
        ...(agentSessionProjection ? { agentSessionProjection } : {}),
        // agentContext: caller derived from session, attachments empty for
        // now (Phase 6 wiring item — surface attachment IDs from the active
        // turn). messageMetadata pulled from per-call params at the executor.
        agentContextProjection: {
          caller: { type: 'agent', id: session.agentName },
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
    } else if (workflowTools.length > 0) {
      log.warn(
        'Workflow tools present but tenant/project context missing — skipping executor wiring',
      );
    }

    // Wire WorkflowStatusTool for async workflow polling companion
    let workflowStatusTool: WorkflowStatusTool | undefined;
    if (workflowToolExecutor) {
      const hasAsyncWorkflowTools = workflowTools.some((t) => t.workflow_binding?.mode === 'async');
      if (hasAsyncWorkflowTools) {
        const redis = getRedisClient();
        if (redis) {
          workflowStatusTool = new WorkflowStatusTool({
            workflowEngineUrl: process.env.WORKFLOW_ENGINE_URL ?? '',
            authToken: workflowAuthToken ?? '',
            projectId: resolvedProjectId!,
            tenantId: resolvedTenantId!,
            sessionId: session.id,
            redis,
            getAsyncExecutionIds: () => workflowToolExecutor!.getAsyncExecutionIds(),
          });
          session._workflowStatusToolActive = true;
        } else {
          log.warn('Redis not available — skipping WorkflowStatusTool wiring');
        }
      }
    }

    // Factory for creating namespace-scoped secrets providers (per-tool env var filtering)
    const namespaceScopedSecretsFactory = (variableNamespaceIds: string[]) =>
      secrets.withNamespaceScope(variableNamespaceIds);

    const baseExecutor = new ToolBindingExecutor({
      tools: allTools,
      secrets,
      mcpClients,
      sandboxRunner,
      searchaiToolExecutor,
      connectorToolExecutor,
      workflowToolExecutor,
      workflowStatusTool,
      projectId: resolvedProjectId,
      sessionContext: {
        sessionId: session.id,
        tenantId: resolvedTenantId,
        userId: resolvedUserId,
        source: toolSessionSource,
        workflowToolVersions: workflowTools.length > 0 ? workflowToolVersions : undefined,
        ...(resolvedCallerContext && { callerContext: resolvedCallerContext }),
      },
      workflowToolVersionsReady: workflowToolVersionsReady,
      fallbackExecutor:
        fallbackExecutor ??
        (process.env.NODE_ENV !== 'production' ? new NoOpToolExecutor() : undefined),
      defaultTimeoutMs: 30000,
      allowLocalhost: !!getDevSSRFOptions().allowLocalhost,
      middleware,
      resilienceFactory,
      namespaceScopedSecretsFactory,
      featureChecker: async () => {
        if (!resolvedTenantId) return false; // fail-closed: no tenant → disabled
        const { getTenantConfigService } = await import('../tenant-config.js');
        const cfg = await getTenantConfigService().getConfigAsync(resolvedTenantId);
        return cfg.features.codeToolsEnabled;
      },
    });

    // Build attachment tool executor — always available so any attachment tool
    // call from the LLM (upload_attachment, get_attachment, etc.) gets handled.
    // Cost is trivial (just sets a URL string); only activates on actual calls.
    const multimodalClient = new MultimodalServiceClient();
    const attachmentToolExecutor = new AttachmentToolExecutor({
      serviceClient: multimodalClient,
      destinations: session.agentIR?.destinations?.map((d) => ({
        ...d,
        method: d.method ?? 'POST',
      })),
    });
    const attachmentContext: AttachmentToolContext = {
      tenantId: resolvedTenantId || '',
      sessionId: session.id,
      projectId: resolvedProjectId || '',
    };

    // Wrap with SearchAIAwareToolExecutor if any tool is a SearchAI tool.
    // Use searchAuthToken (internal service JWT) when available so that SDK
    // sessions don't send an SDK session token (wrong signing key) or a
    // synthetic session principal sub that SearchAI can't resolve.
    // Also passes searchUserHeaders for RACL user identity propagation.
    const hasSearchTool = allTools.some((t) => isSearchAITool(t.name));
    if (hasSearchTool) {
      session.toolExecutor = new SearchAIAwareToolExecutor(
        baseExecutor,
        {
          runtimeUrl: process.env.SEARCH_AI_RUNTIME_URL || '',
          engineUrl: process.env.SEARCH_AI_ENGINE_URL || '',
          authToken: searchAuthToken,
          headers: searchUserHeaders,
        },
        {
          tenantId: resolvedTenantId,
          attachmentToolExecutor,
          attachmentContext,
        },
      );
    } else {
      // Wrap base executor with attachment tool interception
      const innerExecutor = baseExecutor;
      session.toolExecutor = {
        execute: async (toolName: string, params: Record<string, unknown>, timeoutMs: number) => {
          if (isAttachmentTool(toolName)) {
            return attachmentToolExecutor.execute(toolName, params, attachmentContext);
          }
          return innerExecutor.execute(toolName, params, timeoutMs);
        },
        executeParallel: async (
          calls: Array<{ name: string; params: Record<string, unknown> }>,
          timeoutMs: number,
        ) => {
          const attCalls = calls.filter((c) => isAttachmentTool(c.name));
          const otherCalls = calls.filter((c) => !isAttachmentTool(c.name));
          const [attResults, otherResults] = await Promise.all([
            Promise.all(
              attCalls.map(async (c) => {
                try {
                  const result = await attachmentToolExecutor.execute(
                    c.name,
                    c.params,
                    attachmentContext,
                  );
                  return { name: c.name, result };
                } catch (err) {
                  return {
                    name: c.name,
                    error: err instanceof Error ? err.message : String(err),
                  };
                }
              }),
            ),
            otherCalls.length > 0
              ? innerExecutor.executeParallel(otherCalls, timeoutMs)
              : Promise.resolve([]),
          ]);
          return [...attResults, ...otherResults];
        },
      } as any;
    }

    // Wrap with TransferToolExecutor if any tool is an agent-transfer tool.
    // The wrapper is installed even when agent-transfer has not finished booting so
    // transfer tools fail with the dedicated structured contract instead of falling
    // through to the generic ToolBindingExecutor path.
    {
      const hasTransferTool = allTools.some((t) => isTransferTool(t.name));

      if (hasTransferTool) {
        const innerExecutor = session.toolExecutor || baseExecutor;
        const transferExecutor = new TransferToolExecutor({
          getAdapterRegistry,
          getSmartAssistClient,
          getTraceEmitter: getTransferTraceEmitter,
          getContext: async () => {
            const transferHistory = (session.conversationHistory || [])
              .filter(
                (m) =>
                  (m.role === 'user' || m.role === 'assistant') &&
                  typeof m.content === 'string' &&
                  m.content.length > 0,
              )
              .slice(-20)
              .map((m) => ({ role: m.role, content: String(m.content) }));
            const conversationSummaryForAgentTransfer =
              buildTransferSummaryFromHistory(transferHistory);
            const transferEnvelope = await buildRuntimeTransferEnvelope({ session });

            log.debug('Built transfer tool context', {
              sessionId: session.id,
              contactId: transferEnvelope.contactId,
              normalizedTransferChannel: transferEnvelope.routing.normalizedTransferChannel,
              sourceChannelType: transferEnvelope.routing.sourceChannelType,
              hasVoiceData: !!transferEnvelope.voiceData,
              hasContextSnapshot: !!transferEnvelope.contextSnapshot,
              hasSummary: !!conversationSummaryForAgentTransfer,
            });

            return {
              tenantId: resolvedTenantId || '',
              projectId: resolvedProjectId || '',
              agentId: session.agentName || '',
              contactId: transferEnvelope.contactId,
              channel: transferEnvelope.routing.normalizedTransferChannel,
              language: transferEnvelope.language,
              routing: transferEnvelope.routing,
              contextSnapshot: transferEnvelope.contextSnapshot,
              sessionId: session.id,
              conversationSessionId: transferEnvelope.conversationSessionId,
              sourceChannelType: transferEnvelope.routing.sourceChannelType,
              channelConnectionId: transferEnvelope.channelConnectionId,
              externalSessionKey: transferEnvelope.externalSessionKey,
              voiceData: transferEnvelope.voiceData,
              conversationHistory: transferHistory.length > 0 ? transferHistory : undefined,
              conversationSummaryForAgentTransfer,
              contact: transferEnvelope.contact,
            };
          },
          onTransferResult: ({ success }) => {
            setRuntimeTransferActiveState(session, success);
          },
          redis: getRedisClient() ?? undefined,
        });
        // Create a composite executor: transfer tools → transferExecutor, rest → inner
        session.toolExecutor = {
          execute: async (toolName: string, params: Record<string, unknown>, timeoutMs: number) => {
            if (isTransferTool(toolName)) {
              return transferExecutor.execute(toolName, params, timeoutMs);
            }
            return innerExecutor.execute(toolName, params, timeoutMs);
          },
          executeParallel: async (
            calls: Array<{ name: string; params: Record<string, unknown> }>,
            timeoutMs: number,
          ) => {
            const transferCalls = calls.filter((c) => isTransferTool(c.name));
            const otherCalls = calls.filter((c) => !isTransferTool(c.name));
            const [transferResults, otherResults] = await Promise.all([
              transferCalls.length > 0
                ? transferExecutor.executeParallel(transferCalls, timeoutMs)
                : [],
              otherCalls.length > 0 ? innerExecutor.executeParallel(otherCalls, timeoutMs) : [],
            ]);
            return [...transferResults, ...otherResults];
          },
        } as any;
      }
    }

    // Proxy config resolution: store promise on the executor so the first execute() awaits it,
    // eliminating the race where a tool call fires before the proxy resolver is set.
    if (proxyConfigService && resolvedTenantId && baseExecutor) {
      const executor = baseExecutor;
      const proxyPromise = proxyConfigService
        .getResolver(resolvedTenantId, resolvedEnvironment)
        .then((resolver) => {
          if (resolver) {
            executor.setProxyResolver(resolver);
          }
          // Also patch MCP provider for HTTP/SSE transport proxy routing
          if (resolver && inlineMcp) {
            inlineMcp.proxyResolver = resolver;
          }
        })
        .catch((err) => {
          log.error('Failed to load proxy config', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      executor.setProxyReadyPromise(proxyPromise);
    }

    // Wire memory API for sandbox/lambda tools (always available for code tools)
    if (sandboxTools.length > 0 && session.agentIR?.memory) {
      try {
        const memoryBridge = createToolMemoryBridge({
          memory: session.agentIR.memory,
          sessionValues: session.data.values,
          userFactStore: session.factStore,
          projectFactStore: session.projectFactStore,
          agentName: session.agentName,
          sessionId: session.id,
        });
        baseExecutor.setMemoryAPI(memoryBridge);

        // Register bridge so the HTTP memory-api route can look it up for sandbox callbacks
        getMemoryBridgeRegistry().register(session.id, memoryBridge, resolvedTenantId);
      } catch (err) {
        log.warn('Failed to wire memory API for sandbox tools', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    session.toolExecutor = markWiredToolExecutor(session.toolExecutor);

    log.info('ToolBindingExecutor wired for session', {
      sessionId: session.id,
      totalTools: allTools.length,
      httpTools: allTools.filter((t) => t.tool_type === 'http').length,
      mcpTools: mcpTools.length,
      sandboxTools: sandboxTools.length,
      workflowTools: workflowTools.length,
      middlewareCount: middleware.length,
    });
  }

  /**
   * Build a SandboxRunner for sandbox-type tools.
   *
   * Reads SANDBOX_BACKEND env var to select gvisor or lambda backend,
   * builds only the config for the selected backend, validates prerequisites,
   * and returns the runner or undefined (with toolWarnings on the session).
   */
  private _buildSandboxRunner(
    session: RuntimeSession,
    resolvedTenantId?: string,
    resolvedProjectId?: string,
  ): SandboxRunner | undefined {
    const sandboxBackend = (process.env.SANDBOX_BACKEND || 'gvisor') as
      | 'gvisor'
      | 'lambda'
      | 'mock';

    log.debug('Building sandbox runner', {
      backend: sandboxBackend,
      sessionId: session.id,
      tenantId: resolvedTenantId,
      projectId: resolvedProjectId,
    });

    // Build JWT signer for sandbox auth (signs per-invocation short-lived tokens)
    let sandboxJwtSigner: JwtSigner | undefined;
    if (isConfigLoaded()) {
      const sandboxCfg = getConfig().sandbox;
      if (sandboxCfg?.jwtSecret) {
        const secret = sandboxCfg.jwtSecret;
        const expiresInSec = sandboxCfg.jwtExpirySeconds ?? 300;
        sandboxJwtSigner = async (claims) => {
          const { signAccessToken } = await import('../../utils/jwt-utils.js');
          return signAccessToken(claims, secret, expiresInSec);
        };
      }
    }

    const sessionCtx = {
      tenantId: resolvedTenantId,
      sessionId: session.id,
      userId: session.userId,
      projectId: resolvedProjectId,
    };

    // Build config and create runner for the selected backend
    try {
      if (sandboxBackend === 'mock') {
        log.debug('Creating mock sandbox runner — no infrastructure required', {
          sessionId: session.id,
          tenantId: resolvedTenantId,
        });
        return createSandboxRunner(
          'mock',
          {
            gvisor: { pythonPodUrl: '', javascriptPodUrl: '', podPath: '' },
            lambda: { region: '', memoryApiBaseUrl: '', healthTtlMs: 0 },
          },
          sessionCtx,
        );
      }

      if (sandboxBackend === 'gvisor') {
        const pythonPodUrl = process.env.SANDBOX_PYTHON_POD_URL;
        const javascriptPodUrl = process.env.SANDBOX_JAVASCRIPT_POD_URL;

        if (!pythonPodUrl && !javascriptPodUrl) {
          session.toolWarnings = [
            ...(session.toolWarnings || []),
            'Sandbox pod URLs not configured — sandbox tools unavailable',
          ];
          return undefined;
        }

        const memoryApiBaseUrl = process.env.SANDBOX_MEMORY_API_BASE_URL || '';

        return createSandboxRunner(
          'gvisor',
          {
            gvisor: {
              pythonPodUrl: pythonPodUrl || '',
              javascriptPodUrl: javascriptPodUrl || '',
              podPath: process.env.SANDBOX_POD_PATH || '/execute-script',
              memoryApiBaseUrl,
            },
            lambda: { region: '', memoryApiBaseUrl: '', healthTtlMs: 0 },
          },
          sessionCtx,
          sandboxJwtSigner,
        );
      }

      // lambda backend — use cached singletons (one per pod, not per session)
      const deploymentStore = this.getOrCreateLambdaDeploymentStore();
      if (!deploymentStore) {
        log.error('Redis unavailable — Lambda sandbox backend requires Redis for deployment state');
        session.toolWarnings = [
          ...(session.toolWarnings || []),
          'Redis unavailable — Lambda sandbox backend requires Redis for deployment state',
        ];
        return undefined;
      }

      const lambdaClient = this.getOrCreateLambdaClient();
      if (!lambdaClient) {
        log.error('Failed to create LambdaClient for sandbox backend');
        session.toolWarnings = [
          ...(session.toolWarnings || []),
          'Failed to create LambdaClient for sandbox backend',
        ];
        return undefined;
      }

      return createSandboxRunner(
        'lambda',
        {
          gvisor: { pythonPodUrl: '', javascriptPodUrl: '', podPath: '' },
          lambda: {
            region: process.env.LAMBDA_RUNNER_REGION || 'us-east-1',
            memoryApiBaseUrl: process.env.LAMBDA_RUNNER_MEMORY_API_URL || '',
            healthTtlMs: parseInt(process.env.LAMBDA_RUNNER_HEALTH_TTL_MS || '300000', 10),
          },
          deploymentStore,
          lambdaClient,
        },
        sessionCtx,
        sandboxJwtSigner,
      );
    } catch (err) {
      log.error('Failed to create sandbox runner', {
        backend: sandboxBackend,
        error: err instanceof Error ? err.message : String(err),
      });
      session.toolWarnings = [
        ...(session.toolWarnings || []),
        `Failed to create sandbox runner: ${err instanceof Error ? err.message : String(err)}`,
      ];
      return undefined;
    }
  }

  /**
   * Wire up the per-session LLM client using ModelResolutionService.
   * Falls back to direct env-based config if no DB is available.
   */
  async wireLLMClient(
    session: RuntimeSession,
    agentIR: AgentIR,
    tenantId?: string,
    projectId?: string,
    userId?: string,
  ): Promise<void> {
    // Collect health entries for subsystem availability issues
    const pushHealth = (entry: SessionHealthEntry): void => {
      session.sessionHealth ??= [];
      session.sessionHealth.push(entry);
    };

    // Check infrastructure availability and record health warnings/errors
    if (!isDatabaseAvailable()) {
      pushHealth({
        category: 'database',
        severity: 'warning',
        code: 'DB_RESOLUTION_UNAVAILABLE',
        message: 'Database not available — DB-backed model resolution disabled (Levels 2-5)',
        timestamp: Date.now(),
      });
    }
    if (!isTenantEncryptionReady()) {
      pushHealth({
        category: 'encryption',
        severity: 'error',
        code: 'ENCRYPTION_UNAVAILABLE',
        message: 'Tenant DEK encryption not initialized — encrypted credential resolution disabled',
        timestamp: Date.now(),
      });
    }

    try {
      const resolution = await this.getModelResolutionService();
      const client = new SessionLLMClient(resolution, {
        tenantId,
        projectId,
        agentName: agentIR.metadata.name,
        agentIR,
        userId,
        sessionId: session.id,
        settingsVersionId: session.settingsVersionId,
      });
      session.llmClient = client;

      // Pre-warm config cache for extraction and response_gen operation types.
      // This resolves model + tenant policy + budget ONCE during session creation
      // so the first chatWithToolUse call (KB classify) doesn't pay ~500-1000ms
      // for model resolution + DB calls. Fire-and-forget — fully isolated so a
      // sync or async error here can NEVER abort the rest of wireLLMClient.
      try {
        client.prewarmConfig('extraction').catch((err) => {
          log.debug('Config prewarm failed for extraction', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } catch {
        // Sync throw (e.g. method missing) — non-fatal, main flow continues
      }
      try {
        client.prewarmConfig('response_gen').catch((err) => {
          log.debug('Config prewarm failed for response_gen', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } catch {
        // Sync throw — non-fatal, main flow continues
      }

      // Pre-resolve enableThinking + thinkingBudget so prompt-builder has the
      // merged reasoning settings (Agent IR → Agent DB → Project DB) before the
      // first LLM call. This uses the settings-only reasoning contract, so the
      // cache is keyed by the reasoning snapshot and intentionally excludes userId.
      const thinkingCacheKey = buildReasoningSettingsCacheKey({
        tenantId,
        projectId,
        agentName: agentIR.metadata.name,
        agentIR,
        settingsVersionId: session.settingsVersionId,
      });
      try {
        const cachedThinking = this._getCachedThinkingResolution(thinkingCacheKey);
        const resolved = cachedThinking ?? (await client.resolveEnableThinking());
        if (resolved != null) {
          if (!cachedThinking) {
            this._setCachedThinkingResolution(thinkingCacheKey, resolved);
          }
          if (resolved.enableThinking != null) {
            session.resolvedEnableThinking = resolved.enableThinking;
          }
          if (resolved.thinkingBudget != null) {
            session.resolvedThinkingBudget = resolved.thinkingBudget;
          }
          if (resolved.thoughtDescription != null) {
            session.resolvedThoughtDescription = resolved.thoughtDescription;
          }
          if (resolved.compactionThreshold != null) {
            session.resolvedCompactionThreshold = resolved.compactionThreshold;
          }
          if (resolved.modelId) {
            session.resolvedModelId = resolved.modelId;
          }
        }
      } catch (resolveErr) {
        // Settings-only reasoning resolution failures are non-critical here —
        // prompt-builder falls back to IR values and the first real LLM call
        // still runs the full credential-bearing resolution path.
        const configurationFailure = getModelResolutionConfigurationFailure(resolveErr);
        if (configurationFailure) {
          pushHealth({
            category: 'llm',
            severity: 'warning',
            code: configurationFailure.code,
            message: configurationFailure.message,
            timestamp: Date.now(),
          });
        }
      }

      // Load project-level prompt overrides from ProjectSettings.
      // Cache to avoid redundant DB lookups when concurrent sessions share a project.
      if (projectId && tenantId && !session.promptOverrides) {
        const settingsCacheKey = `${projectId}::${tenantId}`;
        const cachedSettings = this._getCachedProjectSettings(settingsCacheKey);
        if (cachedSettings) {
          if (cachedSettings.promptOverrides) {
            session.promptOverrides = cachedSettings.promptOverrides;
          }
          if (cachedSettings.traceDimensionKeys) {
            session.traceDimensionKeys = cachedSettings.traceDimensionKeys;
          }
        } else {
          try {
            const { findProjectSettings } = await import('../../repos/project-settings-repo.js');
            const settings = await findProjectSettings(projectId, tenantId);
            let promptOverrides: Record<string, string> | undefined;
            let traceDimensionKeys: string[] | undefined;

            if (settings?.promptOverrides && typeof settings.promptOverrides === 'object') {
              const overrides: Record<string, string> = {};
              for (const [k, v] of Object.entries(settings.promptOverrides)) {
                if (typeof v === 'string' && v.length > 0) overrides[k] = v;
              }
              if (Object.keys(overrides).length > 0) {
                promptOverrides = overrides;
                session.promptOverrides = overrides;
              }
            }

            const traceDims = settings?.traceDimensions as string[] | undefined;
            if (traceDims?.length) {
              traceDimensionKeys = traceDims;
              session.traceDimensionKeys = traceDims;
            }

            this._setCachedProjectSettings(settingsCacheKey, {
              promptOverrides,
              traceDimensionKeys,
            });
          } catch {
            // Non-critical — call sites fall back to loader/catalog
          }
        }
      }
    } catch (err) {
      log.error('wireLLMClient failed — session will have no LLM client', {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
        projectId,
        agentName: agentIR.metadata.name,
      });
      pushHealth({
        category: 'llm',
        severity: 'error',
        code: 'LLM_WIRING_FAILED',
        message: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
      // Don't assign — session starts without LLM, error surfaces on first message
    }

    // Log session health summary if any issues were detected during wiring
    if (session.sessionHealth && session.sessionHealth.length > 0) {
      const errors = session.sessionHealth.filter((e) => e.severity === 'error').length;
      const warnings = session.sessionHealth.filter((e) => e.severity === 'warning').length;
      log.warn('Session health issues detected during LLM wiring', {
        sessionId: session.id,
        agentName: agentIR.metadata.name,
        errorCount: errors,
        warningCount: warnings,
        codes: session.sessionHealth.map((e) => e.code),
      });
    }
  }

  /**
   * Ensure session has an LLM client wired. Used when the async wireLLMClient
   * may not have completed yet (race with first message).
   *
   * Includes a per-session cooldown after resolution failure to avoid
   * hammering a broken resolution path on every turn without affecting
   * other sessions/tenants.
   *
   * Pod-safe: the cooldown map is per-pod, scoped to session IDs that
   * exist on this pod. Bounded to prevent memory leaks from abandoned sessions.
   */
  private getLlmCooldownMs(): number {
    if (this._llmCooldownMs != null) return this._llmCooldownMs;
    try {
      if (isConfigLoaded()) {
        this._llmCooldownMs = getConfig().llmCache.resolutionCooldownSeconds * 1000;
        return this._llmCooldownMs;
      }
    } catch (err) {
      log.debug('Config not available for LLM cooldown, using default', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return LLMWiringService.DEFAULT_LLM_COOLDOWN_MS;
  }

  async ensureSessionLLMClient(session: RuntimeSession): Promise<void> {
    if (session.llmClient) return;

    // Skip full resolution if it recently failed for THIS session
    const cooldownMs = this.getLlmCooldownMs();
    const failedAt = this._llmResolutionFailedSessions.get(session.id);
    if (failedAt && Date.now() - failedAt < cooldownMs) {
      return; // Wait for cooldown — resolution failed recently
    }

    // Try full resolution via ModelResolutionService
    if (!session.agentIR) {
      log.warn('ensureSessionLLMClient: cannot wire LLM — agentIR is null', {
        sessionId: session.id,
        agentName: session.agentName,
      });
      return;
    }

    if (session.agentIR) {
      try {
        if (session.compilationOutput) {
          this.wireToolExecutor(
            session,
            session.compilationOutput,
            session.authToken,
            session.tenantId,
            session.projectId,
          );
        }

        await this.wireLLMClient(
          session,
          session.agentIR,
          session.tenantId,
          session.projectId,
          session.userId,
        );
        // Clear cooldown on success
        this._llmResolutionFailedSessions.delete(session.id);
      } catch (err) {
        log.warn('LLM client resolution failed', {
          sessionId: session.id,
          agentName: session.agentName,
          error: err instanceof Error ? err.message : String(err),
        });
        // Bound the map: evict expired entries if at capacity
        if (this._llmResolutionFailedSessions.size >= LLMWiringService.COOLDOWN_MAP_MAX) {
          const now = Date.now();
          for (const [id, ts] of this._llmResolutionFailedSessions) {
            if (now - ts >= cooldownMs) this._llmResolutionFailedSessions.delete(id);
          }
          // If still over limit after purge, drop oldest
          if (this._llmResolutionFailedSessions.size >= LLMWiringService.COOLDOWN_MAP_MAX) {
            const oldest = this._llmResolutionFailedSessions.keys().next().value;
            if (oldest) this._llmResolutionFailedSessions.delete(oldest);
          }
        }
        this._llmResolutionFailedSessions.set(session.id, Date.now());
      }
    }
  }

  /** Maximum env vars loaded per session to prevent abuse */
  private static MAX_ENV_VARS_PER_SESSION = 200;

  /**
   * Bulk-load and decrypt all environment variables for a deployment context.
   * Returns a flat Record<string, string> of decrypted key-value pairs.
   * Returns an empty object when DB-backed env vars are unavailable.
   * Throws when tenant DEK encryption is not initialized.
   */
  async loadEnvironmentVariables(
    tenantId: string,
    projectId: string,
    environment: string,
  ): Promise<Record<string, string>> {
    if (!this.getOrCreateEnvVarStore()) return {};

    const decryptor = this.getOrCreateSecretDecryptor();
    if (!decryptor) {
      throw new Error('Tenant DEK encryption is not initialized for environment variables.');
    }

    try {
      const { EnvironmentVariable } = await import('@agent-platform/database/models');
      // Include encryption metadata so the Mongoose encryption plugin can
      // transparently decrypt in its post-find hook
      const query = EnvironmentVariable.find({
        tenantId,
        projectId,
        environment,
      })
        .select('key encryptedValue ire tenantId cek iv kmsKeyId fieldsToEncrypt')
        .limit(LLMWiringService.MAX_ENV_VARS_PER_SESSION);
      const usedLeanFallback =
        typeof (query as { then?: unknown }).then !== 'function' &&
        typeof (query as { lean?: unknown }).lean === 'function';
      const rawRecords = usedLeanFallback
        ? await (query as { lean: () => Promise<unknown[]> }).lean()
        : await query;
      const records = Array.isArray(rawRecords) ? rawRecords : [];

      const resolved: Record<string, string> = {};
      for (const rec of records) {
        if (!rec || typeof rec !== 'object') continue;
        const key = 'key' in rec && typeof rec.key === 'string' ? rec.key : undefined;
        const encryptedValue =
          'encryptedValue' in rec && typeof rec.encryptedValue === 'string'
            ? rec.encryptedValue
            : null;

        if (!key || encryptedValue == null) {
          log.warn('Env var decryption returned null (plugin decryption failed?)', {
            key,
          });
          continue;
        }

        try {
          resolved[key] = usedLeanFallback
            ? await decryptor.decryptForTenant(encryptedValue, tenantId)
            : encryptedValue;
        } catch (err) {
          log.warn('Failed to decrypt environment variable', {
            key,
            tenantId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return resolved;
    } catch (err) {
      log.warn('Failed to load environment variables', {
        tenantId,
        projectId,
        environment,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  /**
   * Clear the cooldown entry for a session (e.g., when session is ended).
   */
  clearCooldown(sessionId: string): void {
    this._llmResolutionFailedSessions.delete(sessionId);
  }

  clearModelResolutionCache(tenantId?: string): void {
    this._modelResolution?.clearCache(tenantId);
  }
}
