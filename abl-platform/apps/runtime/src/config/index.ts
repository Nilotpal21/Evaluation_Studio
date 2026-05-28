/**
 * Runtime Configuration
 *
 * Thin wrapper around @agent-platform/config.
 * Composes the base config schema with runtime-specific extensions.
 */

import { z } from 'zod';
import {
  AuthConfigSchema,
  composeConfigSchema,
  createConfigLoader,
  VoiceConfigSchema,
  SandboxConfigSchema,
  validateProductionConfig,
  type BaseAppConfig,
} from '@agent-platform/config';
import { createLogger } from '@abl/compiler/platform';

const configLog = createLogger('runtime-config');

// =============================================================================
// URL REDACTION
// =============================================================================

/**
 * Redact credentials from a URL string for safe logging.
 * Masks username and password while preserving host, port, and path.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

// =============================================================================
// RUNTIME-SPECIFIC EXTENSIONS
// =============================================================================

const WebSocketConfigSchema = z.object({
  enabled: z.boolean().default(true),
  heartbeatIntervalMs: z.coerce.number().int().positive().default(30000),
  maxConnections: z.coerce.number().int().positive().default(1000),
});

const CheckpointConfigSchema = z.object({
  store: z.enum(['redis', 'postgres', 'memory']).default('memory'),
  enabled: z.boolean().default(false),
});

const FeatureFlagsSchema = z.object({
  voiceEnabled: z.boolean().default(false),
  livekitEnabled: z.boolean().default(false),
  streamingEnabled: z.boolean().default(true),
  toolSandboxing: z.boolean().default(true),
  multiAgent: z.boolean().default(true),
  debugTraces: z.boolean().default(false),
  mockLlmEnabled: z.boolean().default(false),
  enableLlmBudgetEnforcement: z.boolean().default(false),
  enableHealthChecks: z.boolean().default(false),
  healthCheckIntervalHours: z.coerce.number().int().positive().default(4),
  authProfileSessionScanEnabled: z.boolean().default(true),
  authProfileForceInvalidateEnabled: z.boolean().default(true),
});

const SessionConfigSchema = z.object({
  store: z.enum(['redis', 'memory']).default('memory'),
  conversationWindow: z.coerce.number().int().positive().default(40),
  irCacheMaxEntries: z.coerce.number().int().positive().default(200),
  lockTtlMs: z.coerce.number().int().positive().default(5000),
  sessionTtlMinutes: z.coerce.number().int().positive().default(1440), // 24 hours
  coldStorageEnabled: z.boolean().default(true),
  coldTtlDays: z.coerce.number().int().positive().default(90),
  coldPersistDebounceMs: z.coerce.number().int().min(500).default(2000),
  compactionEnabled: z.boolean().default(false),
  autoCompactThreshold: z.coerce.number().min(0).max(1).default(0.8),
  compactionModel: z.string().default('gpt-4o-mini'),
});

const CleanupConfigSchema = z.object({
  /** TTL in hours for completed sessions. Sessions older than this are purged. 0 = disabled. */
  sessionTtlHours: z.coerce.number().int().min(0).default(0), // 0 = disabled, plan retention governs
  /** TTL in hours for orphaned messages (no parent session). 0 = disabled. */
  messageTtlHours: z.coerce.number().int().min(0).default(720),
  /** How often the cleanup job runs, in minutes. */
  intervalMinutes: z.coerce.number().int().positive().default(60),
});

const SessionTimeoutSweepConfigSchema = z.object({
  /** Whether the idle/max-age timeout sweep is enabled. */
  enabled: z.boolean().default(true),
  /** How often the timeout sweep runs, in minutes. */
  intervalMinutes: z.coerce.number().int().positive().default(1),
});

const BillingMaterializationConfigSchema = z.object({
  /** Whether scheduled billing materialization is enabled. */
  enabled: z.boolean().default(false),
  /** How often the billing materializer checks for due tenant batches. */
  intervalMs: z.coerce.number().int().positive().default(300000),
  /** Cursor batch size when scanning active tenant subscriptions. */
  tenantBatchSize: z.coerce.number().int().positive().default(100),
});

const BillingPublicationConfigSchema = z.object({
  /** Whether low-frequency publication of completed billing batches is enabled. */
  enabled: z.boolean().default(false),
  /** How often the billing publisher checks for completed, unpublished batches. */
  intervalMs: z.coerce.number().int().positive().default(1800000),
  /** Cursor batch size when scanning active tenant subscriptions. */
  tenantBatchSize: z.coerce.number().int().positive().default(100),
  /** Maximum number of batches to publish in a single scheduler pass. */
  batchLimit: z.coerce.number().int().positive().default(10),
});

const LlmQueueConfigSchema = z.object({
  enabled: z.boolean().default(true),
  concurrency: z.coerce.number().int().positive().default(10),
  backpressureThreshold: z.coerce.number().int().positive().default(100),
  jobTimeoutMs: z.coerce.number().int().positive().default(60000),
});

const ChannelLifecycleEntrySchema = z.object({
  defaultDisposition: z
    .enum(['completed', 'abandoned', 'agent_hangup', 'transferred', 'failed', 'timeout'])
    .default('abandoned'),
  disconnectBehavior: z.enum(['end', 'detach']).default('detach'),
});

const ChannelLifecycleConfigSchema = z.object({
  voice: ChannelLifecycleEntrySchema.default({
    defaultDisposition: 'abandoned',
    disconnectBehavior: 'end',
  }),
  web_chat: ChannelLifecycleEntrySchema.default({
    defaultDisposition: 'abandoned',
    disconnectBehavior: 'detach',
  }),
  web_debug: ChannelLifecycleEntrySchema.default({
    defaultDisposition: 'completed',
    disconnectBehavior: 'detach',
  }),
  api: ChannelLifecycleEntrySchema.default({
    defaultDisposition: 'completed',
    disconnectBehavior: 'end',
  }),
  sms: ChannelLifecycleEntrySchema.default({
    defaultDisposition: 'abandoned',
    disconnectBehavior: 'detach',
  }),
  whatsapp: ChannelLifecycleEntrySchema.default({
    defaultDisposition: 'abandoned',
    disconnectBehavior: 'detach',
  }),
  email: ChannelLifecycleEntrySchema.default({
    defaultDisposition: 'abandoned',
    disconnectBehavior: 'detach',
  }),
});

const VoiceWorkerConfigSchema = z.object({
  mode: z.enum(['embedded', 'external']).default('embedded'),
  url: z.string().optional(),
  secret: z.string().optional(),
  port: z.coerce.number().int().positive().default(3003),
});

// KMS provider config is per-tenant in DB (TenantKMSConfig).
// This schema is kept empty as a placeholder for future operational settings.
const KmsConfigSchema = z.object({});

const EventStoreConfigSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(['embedded', 'remote', 'service']).default('embedded'),
  backend: z.enum(['clickhouse', 'memory']).default('clickhouse'),
  resilience: z
    .object({
      enabled: z.boolean().default(false),
      walDirectory: z.string().default('/tmp/eventstore-wal'),
    })
    .default({}),
});

const LlmCacheConfigSchema = z.object({
  /** Provider instance cache: max entries (keyed by providerType:apiKeyHash:baseUrl) */
  providerCacheMax: z.coerce.number().int().positive().default(500),
  /** Provider instance cache: TTL in seconds */
  providerCacheTtlSeconds: z.coerce.number().int().positive().default(1800), // 30 min
  /** Model resolution cache: TTL in seconds */
  resolutionCacheTtlSeconds: z.coerce.number().int().positive().default(300), // 5 min
  /** Per-session LLM resolution cooldown after failure, in seconds */
  resolutionCooldownSeconds: z.coerce.number().int().positive().default(30),
});

// =============================================================================
// COMPOSED SCHEMA
// =============================================================================

export const RuntimeConfigSchema = composeConfigSchema({
  auth: AuthConfigSchema.default({}),
  voice: VoiceConfigSchema.default({}),
  websocket: WebSocketConfigSchema.default({}),
  checkpoint: CheckpointConfigSchema.default({}),
  features: FeatureFlagsSchema.default({}),
  session: SessionConfigSchema.default({}),
  llmCache: LlmCacheConfigSchema.default({}),
  llmQueue: LlmQueueConfigSchema.default({}),
  sandbox: SandboxConfigSchema.default({}),
  cleanup: CleanupConfigSchema.default({}),
  sessionTimeoutSweep: SessionTimeoutSweepConfigSchema.default({}),
  billingMaterialization: BillingMaterializationConfigSchema.default({}),
  billingPublication: BillingPublicationConfigSchema.default({}),
  voiceWorker: VoiceWorkerConfigSchema.default({}),
  channelLifecycle: ChannelLifecycleConfigSchema.default({}),
  kms: KmsConfigSchema.default({}),
  eventstore: EventStoreConfigSchema.default({}),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export const SDK_DISTRIBUTED_STATE_REQUIRED_ERROR =
  'Distributed session storage is required for SDK session issuance and verified continuity in this environment. Configure Redis-backed session storage or explicitly disable AUTH_SDK_REQUIRE_DISTRIBUTED_STATE only if you intentionally accept single-node SDK state.';

export function isSdkDistributedStateRequired(
  config: Pick<RuntimeConfig, 'env' | 'auth'>,
): boolean {
  const configured = config.auth?.sdk?.requireDistributedState;
  if (typeof configured === 'boolean') {
    return configured;
  }

  return config.env === 'production';
}

// =============================================================================
// CONFIG LOADER
// =============================================================================

const RUNTIME_ENV_MAPPING = {
  // Voice
  TWILIO_ACCOUNT_SID: 'voice.twilio.accountSid',
  TWILIO_AUTH_TOKEN: 'voice.twilio.authToken',
  TWILIO_PHONE_NUMBER: 'voice.twilio.phoneNumber',
  TWILIO_API_KEY_SID: 'voice.twilio.apiKeySid',
  TWILIO_API_KEY: 'voice.twilio.apiKeySid',
  TWILIO_API_KEY_SECRET: 'voice.twilio.apiKeySecret',
  TWILIO_API_SECRET: 'voice.twilio.apiKeySecret',
  TWILIO_TWIML_APP_SID: 'voice.twilio.twimlAppSid',
  TWILIO_TRUNK_SID: 'voice.twilio.trunkSid',
  DEEPGRAM_API_KEY: 'voice.deepgram.apiKey',
  DEEPGRAM_MODEL: 'voice.deepgram.model',
  ELEVENLABS_API_KEY: 'voice.elevenLabs.apiKey',
  ELEVENLABS_VOICE_ID: 'voice.elevenLabs.voiceId',
  ELEVENLABS_MODEL: 'voice.elevenLabs.model',
  VOICE_LATENCY_TARGET_MS: 'voice.latencyTargetMs',
  VOICE_MAX_CONCURRENT_CALLS: 'voice.maxConcurrentCalls',
  FEATURE_VOICE_ENABLED: 'voice.enabled',
  LIVEKIT_URL: 'voice.livekit.url',
  LIVEKIT_API_KEY: 'voice.livekit.apiKey',
  LIVEKIT_API_SECRET: 'voice.livekit.apiSecret',
  LIVEKIT_TOKEN_TTL_SECONDS: 'voice.livekit.tokenTtlSeconds',
  LIVEKIT_MAX_CONCURRENT_ROOMS: 'voice.livekit.maxConcurrentRooms',
  FEATURE_LIVEKIT_ENABLED: 'features.livekitEnabled',

  // WebSocket
  WS_HEARTBEAT_INTERVAL_MS: 'websocket.heartbeatIntervalMs',
  WS_MAX_CONNECTIONS: 'websocket.maxConnections',

  // Checkpoint
  CHECKPOINT_STORE: 'checkpoint.store',
  CHECKPOINT_ENABLED: 'checkpoint.enabled',

  // Feature flags
  FEATURE_STREAMING_ENABLED: 'features.streamingEnabled',
  FEATURE_TOOL_SANDBOXING: 'features.toolSandboxing',
  FEATURE_MULTI_AGENT: 'features.multiAgent',
  FEATURE_DEBUG_TRACES: 'features.debugTraces',
  FEATURE_ENABLE_MOCK_LLM: 'features.mockLlmEnabled',
  FEATURE_ENABLE_LLM_BUDGET_ENFORCEMENT: 'features.enableLlmBudgetEnforcement',
  FEATURE_ENABLE_HEALTH_CHECKS: 'features.enableHealthChecks',
  FEATURE_HEALTH_CHECK_INTERVAL_HOURS: 'features.healthCheckIntervalHours',
  AUTH_PROFILE_SESSION_SCAN_ENABLED: 'features.authProfileSessionScanEnabled',

  // LLM provider keys
  GEMINI_API_KEY: 'llm.geminiApiKey',
  GOOGLE_API_KEY: 'llm.geminiApiKey',
  LITELLM_PROXY_URL: 'llm.litellmProxyUrl',

  // Security
  SUPER_ADMIN_USER_IDS: 'security.superAdminUserIds',
  OAUTH_ALLOWED_REDIRECT_ORIGINS: 'security.oauthAllowedRedirectOrigins',
  PLATFORM_ADMIN_ALLOWED_IPS: 'security.platformAdminAllowedIps',
  AUTH_SDK_JWE_ENABLED: 'auth.sdk.jwe.enabled',
  AUTH_SDK_JWE_MAX_ENCRYPTED_BOOTSTRAP_BYTES: 'auth.sdk.jwe.maxEncryptedBootstrapBytes',
  AUTH_SDK_JWE_MAX_ENCRYPTED_SESSION_BYTES: 'auth.sdk.jwe.maxEncryptedSessionBytes',

  // LLM cache tuning
  LLM_PROVIDER_CACHE_MAX: 'llmCache.providerCacheMax',
  LLM_PROVIDER_CACHE_TTL_SECONDS: 'llmCache.providerCacheTtlSeconds',
  LLM_RESOLUTION_CACHE_TTL_SECONDS: 'llmCache.resolutionCacheTtlSeconds',
  LLM_RESOLUTION_COOLDOWN_SECONDS: 'llmCache.resolutionCooldownSeconds',

  // LLM Queue
  LLM_QUEUE_ENABLED: 'llmQueue.enabled',
  LLM_QUEUE_CONCURRENCY: 'llmQueue.concurrency',
  LLM_QUEUE_BACKPRESSURE_THRESHOLD: 'llmQueue.backpressureThreshold',
  LLM_QUEUE_JOB_TIMEOUT_MS: 'llmQueue.jobTimeoutMs',

  // Cleanup
  SESSION_CLEANUP_TTL_HOURS: 'cleanup.sessionTtlHours',
  MESSAGE_CLEANUP_TTL_HOURS: 'cleanup.messageTtlHours',
  CLEANUP_INTERVAL_MINUTES: 'cleanup.intervalMinutes',
  SESSION_TIMEOUT_SWEEP_ENABLED: 'sessionTimeoutSweep.enabled',
  SESSION_TIMEOUT_SWEEP_INTERVAL_MINUTES: 'sessionTimeoutSweep.intervalMinutes',
  BILLING_MATERIALIZATION_ENABLED: 'billingMaterialization.enabled',
  BILLING_MATERIALIZATION_INTERVAL_MS: 'billingMaterialization.intervalMs',
  BILLING_MATERIALIZATION_TENANT_BATCH_SIZE: 'billingMaterialization.tenantBatchSize',
  BILLING_PUBLICATION_ENABLED: 'billingPublication.enabled',
  BILLING_PUBLICATION_INTERVAL_MS: 'billingPublication.intervalMs',
  BILLING_PUBLICATION_TENANT_BATCH_SIZE: 'billingPublication.tenantBatchSize',
  BILLING_PUBLICATION_BATCH_LIMIT: 'billingPublication.batchLimit',

  // Voice Worker
  VOICE_WORKER_MODE: 'voiceWorker.mode',
  VOICE_WORKER_URL: 'voiceWorker.url',
  VOICE_WORKER_SECRET: 'voiceWorker.secret',
  VOICE_WORKER_PORT: 'voiceWorker.port',

  // Channel lifecycle
  CHANNEL_VOICE_DEFAULT_DISPOSITION: 'channelLifecycle.voice.defaultDisposition',
  CHANNEL_VOICE_DISCONNECT_BEHAVIOR: 'channelLifecycle.voice.disconnectBehavior',
  CHANNEL_WEB_CHAT_DEFAULT_DISPOSITION: 'channelLifecycle.web_chat.defaultDisposition',
  CHANNEL_WEB_CHAT_DISCONNECT_BEHAVIOR: 'channelLifecycle.web_chat.disconnectBehavior',
  CHANNEL_WEB_DEBUG_DEFAULT_DISPOSITION: 'channelLifecycle.web_debug.defaultDisposition',
  CHANNEL_WEB_DEBUG_DISCONNECT_BEHAVIOR: 'channelLifecycle.web_debug.disconnectBehavior',
  CHANNEL_API_DEFAULT_DISPOSITION: 'channelLifecycle.api.defaultDisposition',
  CHANNEL_API_DISCONNECT_BEHAVIOR: 'channelLifecycle.api.disconnectBehavior',

  // KMS — operational settings only. Provider config is per-tenant in DB.
  // (KMS_PROVIDER, KMS_REGION, KMS_KEY_ID, KMS_VAULT_URL removed — these are per-tenant)

  // Session
  SESSION_STORE: 'session.store',
  SESSION_CONVERSATION_WINDOW: 'session.conversationWindow',
  SESSION_IR_CACHE_MAX_ENTRIES: 'session.irCacheMaxEntries',
  SESSION_LOCK_TTL_MS: 'session.lockTtlMs',
  SESSION_TTL_MINUTES: 'session.sessionTtlMinutes',
  SESSION_COLD_STORAGE_ENABLED: 'session.coldStorageEnabled',
  SESSION_COLD_TTL_DAYS: 'session.coldTtlDays',
  SESSION_COLD_PERSIST_DEBOUNCE_MS: 'session.coldPersistDebounceMs',
  SESSION_COMPACTION_ENABLED: 'session.compactionEnabled',
  SESSION_AUTO_COMPACT_THRESHOLD: 'session.autoCompactThreshold',
  SESSION_COMPACTION_MODEL: 'session.compactionModel',

  // EventStore
  EVENTSTORE_ENABLED: 'eventstore.enabled',
  EVENTSTORE_BACKEND: 'eventstore.backend',
  EVENTSTORE_RESILIENCE_ENABLED: 'eventstore.resilience.enabled',
  EVENTSTORE_WAL_DIR: 'eventstore.resilience.walDirectory',

  // Sandbox / Gvisor pods
  SANDBOX_PYTHON_POD_URL: 'sandbox.pythonPodUrl',
  SANDBOX_JAVASCRIPT_POD_URL: 'sandbox.javascriptPodUrl',
  SANDBOX_JWT_SECRET: 'sandbox.jwtSecret',
  SANDBOX_JWT_EXPIRY_SECONDS: 'sandbox.jwtExpirySeconds',
  SANDBOX_MEMORY_API_BASE_URL: 'sandbox.memoryApiBaseUrl',
};

export function logRuntimeConfigSummary(cfg: unknown): void {
  const c = cfg as RuntimeConfig;
  configLog.info('Runtime configuration loaded', {
    environment: c.env,
    server: `${c.server.host}:${c.server.port}`,
    database: c.database.url ? 'configured' : 'not configured',
    jwtSecret: c.jwt.secret.length >= 32 ? 'configured (secure)' : 'WARNING: using default',
    llmProvider: c.llm.provider,
    anthropicApi: c.llm.anthropicApiKey ? 'configured' : 'not configured',
    openaiApi: c.llm.openaiApiKey ? 'configured' : 'not configured',
    defaultModel: c.llm.defaultModel,
    encryption: c.encryption.masterKey ? 'configured' : 'not configured',
    redis: c.redis.enabled
      ? `enabled (${redactUrl(c.redis.url || 'redis://localhost')})`
      : 'disabled',
    voice: c.voice.enabled ? 'enabled' : 'disabled',
    liveKit: c.features.livekitEnabled
      ? `enabled (${c.voice.livekit.url || 'no url'})`
      : 'disabled',
    voiceWorker: `${c.voiceWorker.mode}${c.voiceWorker.mode === 'external' ? ` (${c.voiceWorker.url || 'no url'})` : ''}`,
    checkpoint: c.checkpoint.store,
    session: `${c.session.store} (window: ${c.session.conversationWindow})`,
    llmQueue: c.llmQueue.enabled ? `enabled (concurrency: ${c.llmQueue.concurrency})` : 'disabled',
    cleanup:
      c.cleanup.sessionTtlHours > 0 || c.cleanup.messageTtlHours > 0
        ? `sessions: ${c.cleanup.sessionTtlHours}h, messages: ${c.cleanup.messageTtlHours}h, interval: ${c.cleanup.intervalMinutes}m`
        : 'disabled',
    sessionTimeoutSweep: c.sessionTimeoutSweep.enabled
      ? `enabled (interval: ${c.sessionTimeoutSweep.intervalMinutes}m)`
      : 'disabled',
    billingMaterialization: c.billingMaterialization.enabled
      ? `enabled (interval: ${c.billingMaterialization.intervalMs}ms, tenantBatchSize: ${c.billingMaterialization.tenantBatchSize})`
      : 'disabled',
    billingPublication: c.billingPublication.enabled
      ? `enabled (interval: ${c.billingPublication.intervalMs}ms, tenantBatchSize: ${c.billingPublication.tenantBatchSize}, batchLimit: ${c.billingPublication.batchLimit})`
      : 'disabled',
    scheduler: c.scheduler.enabled ? 'enabled' : 'disabled',
    eventStore: c.eventstore.enabled
      ? `enabled (${c.eventstore.mode}/${c.eventstore.backend})`
      : 'disabled',
    gvisorPods: `Python: ${c.sandbox.pythonPodUrl} | JS: ${c.sandbox.javascriptPodUrl}`,
    gvisorJwt: c.sandbox.jwtSecret ? 'configured' : 'not configured',
    memoryApiUrl: c.sandbox.memoryApiBaseUrl || 'not configured',
  });
}

const loader = createConfigLoader(RuntimeConfigSchema, {
  envMapping: RUNTIME_ENV_MAPPING,
  productionChecks: (cfg) => validateProductionConfig(cfg as BaseAppConfig).map((w) => w.message),
  logSummary: logRuntimeConfigSummary,
});

export const loadConfig = loader.loadConfig;
export const getConfig = loader.getConfig;
export const isConfigLoaded = loader.isConfigLoaded;
export const reloadConfig = loader.reloadConfig;
export const getConfigMeta = loader.getConfigMeta;

// Re-export vault types for backward compatibility
export type { VaultType, VaultProvider } from '@agent-platform/config';
