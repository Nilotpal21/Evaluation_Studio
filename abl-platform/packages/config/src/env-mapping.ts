/**
 * Declarative Environment Variable Mapping
 *
 * Maps flat env var names to nested config paths with type coercion.
 */

export type EnvMapping = Record<string, string>;

/**
 * Base env var -> config path mapping shared by all apps.
 */
export const BASE_ENV_MAPPING: EnvMapping = {
  // Environment
  NODE_ENV: 'env',

  // Database
  DATABASE_URL: 'database.url',

  // JWT
  JWT_SECRET: 'jwt.secret',
  JWT_ACCESS_EXPIRY: 'jwt.accessExpiry',
  JWT_REFRESH_EXPIRY: 'jwt.refreshExpiry',

  // OAuth
  GOOGLE_CLIENT_ID: 'oauth.google.clientId',
  GOOGLE_CLIENT_SECRET: 'oauth.google.clientSecret',
  MICROSOFT_CLIENT_ID: 'oauth.microsoft.clientId',
  MICROSOFT_CLIENT_SECRET: 'oauth.microsoft.clientSecret',
  MICROSOFT_TENANT_ID: 'oauth.microsoft.tenantId',
  LINKEDIN_CLIENT_ID: 'oauth.linkedin.clientId',
  LINKEDIN_CLIENT_SECRET: 'oauth.linkedin.clientSecret',

  // Server
  PORT: 'server.port',
  HOST: 'server.host',
  API_URL: 'server.apiUrl',
  FRONTEND_URL: 'server.frontendUrl',

  // LLM
  ANTHROPIC_API_KEY: 'llm.anthropicApiKey',
  ANTHROPIC_BASE_URL: 'llm.anthropicBaseUrl',
  ANTHROPIC_VERSION: 'llm.anthropicVersion',
  OPENAI_API_KEY: 'llm.openaiApiKey',
  LLM_MODEL: 'llm.defaultModel',
  ANTHROPIC_DEFAULT_MODEL: 'llm.defaultModel',
  LLM_FAST_MODEL: 'llm.fastModel',
  LLM_VOICE_MODEL: 'llm.voiceModel',
  LLM_MAX_TOKENS: 'llm.maxTokens',
  LLM_TEMPERATURE: 'llm.temperature',
  LLM_TIMEOUT_MS: 'llm.timeoutMs',
  LLM_PROVIDER: 'llm.provider',

  // LLM Cache
  LLM_CACHE_ENABLED: 'llm.cacheEnabled',
  LLM_CACHE_DIR: 'llm.cacheDir',
  LLM_CACHE_TTL_MS: 'llm.cacheTtlMs',

  // Encryption
  ENCRYPTION_ENABLED: 'encryption.enabled',
  ENCRYPTION_MASTER_KEY: 'encryption.masterKey',

  // Rate Limiting
  RATE_LIMIT_AUTH_WINDOW_MS: 'rateLimit.authWindowMs',
  RATE_LIMIT_AUTH_MAX: 'rateLimit.authMax',
  RATE_LIMIT_API_WINDOW_MS: 'rateLimit.apiWindowMs',
  RATE_LIMIT_API_MAX: 'rateLimit.apiMax',

  // CORS
  CORS_ORIGINS: 'cors.origins',
  CORS_CREDENTIALS: 'cors.credentials',
  CORS_METHODS: 'cors.methods',
  CORS_ALLOWED_HEADERS: 'cors.allowedHeaders',

  // Redis
  REDIS_URL: 'redis.url',
  REDIS_PASSWORD: 'redis.password',
  REDIS_ENABLED: 'redis.enabled',
  REDIS_TLS: 'redis.tls',
  REDIS_TLS_ENABLED: 'redis.tls',
  REDIS_CLUSTER: 'redis.cluster',

  // A2A / Async Callbacks
  CALLBACK_BASE_URL: 'callbackBaseUrl',

  // Jambonz (Voice Gateway)
  JAMBONZ_BASE_API_URL: 'voice.jambonz.baseApiUrl',
  JAMBONZ_ACCOUNT_SID: 'voice.jambonz.accountSid',
  JAMBONZ_API_KEY: 'voice.jambonz.apiKey',
  JAMBONZ_VOIP_CARRIER_SID: 'voice.jambonz.voipCarrierSid',
  JAMBONZ_SERVICE_PROVIDER_ID: 'voice.jambonz.serviceProviderId',
  JAMBONZ_SERVICE_PROVIDER_API_KEY: 'voice.jambonz.serviceProviderApiKey',
  JAMBONZ_SBC_ADDRESS: 'voice.jambonz.sbcAddress',
  JAMBONZ_SBC_WS_ADDRESS: 'voice.jambonz.sbcWsAddress',

  // Scheduler
  SCHEDULER_RETENTION_CRON: 'scheduler.retentionCron',
  SCHEDULER_GDPR_CHECK_CRON: 'scheduler.gdprCheckCron',
  SCHEDULER_ENABLED: 'scheduler.enabled',

  // Archive
  ARCHIVE_PROVIDER: 'archive.provider',
  ARCHIVE_S3_BUCKET: 'archive.s3.defaultBucket',
  ARCHIVE_S3_REGION_BUCKETS: 'archive.s3.regionBuckets',
  ARCHIVE_S3_ENCRYPTION: 'archive.s3.encryption',
  ARCHIVE_S3_KMS_KEY_ID: 'archive.s3.kmsKeyId',
  ARCHIVE_LOCAL_DIR: 'archive.localDir',

  // Observability
  // NOTE: OTEL vars are also read directly in apps/runtime/src/observability/otel-setup.ts
  // (intentional — otel-setup.ts must run before config system initializes)
  OTEL_ENABLED: 'observability.enabled',
  OTEL_TRACE_SAMPLING_RATE: 'observability.traceSamplingRate',
  METRICS_ENABLED: 'observability.metricsEnabled',
  LOG_LEVEL: 'observability.loggingLevel',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'observability.otlpEndpoint',
  OTEL_SERVICE_NAME: 'observability.serviceName',
  OTEL_SERVICE_VERSION: 'observability.serviceVersion',
  OTEL_DEBUG: 'observability.debug',
  ALERTING_ENABLED: 'observability.alerting.enabled',
  ALERTING_WEBHOOK_URL: 'observability.alerting.webhookUrl',
  OBS_TRACE_CANONICAL_READ: 'observability.traceCanonicalRead',
  OBS_STRICT_READINESS_GATES: 'observability.strictReadinessGates',
  OBS_METRIC_LABEL_GUARDRAILS: 'observability.metricLabelGuardrails',
  OBS_EVENTBUS_TRACE_HEADERS: 'observability.eventbusTraceHeaders',

  // Security
  PII_DETECTION: 'security.piiDetection',
  PII_REDACTION: 'security.piiRedaction',
  RATE_LIMIT_ENABLED: 'security.rateLimiting.enabled',
  RATE_LIMIT_RPM: 'security.rateLimiting.requestsPerMinute',
  RATE_LIMIT_TPM: 'security.rateLimiting.tokensPerMinute',

  // Auth
  AUTH_BCRYPT_COST: 'auth.password.bcryptCost',
  AUTH_PASSWORD_MIN_LENGTH: 'auth.password.minLength',
  AUTH_PASSWORD_HISTORY_COUNT: 'auth.password.historyCount',
  AUTH_LOCKOUT_MAX_ATTEMPTS: 'auth.lockout.maxFailedAttempts',
  AUTH_LOCKOUT_DURATION_MS: 'auth.lockout.lockDurationMs',
  AUTH_MFA_LOCK_THRESHOLD: 'auth.mfa.lockThreshold',
  AUTH_MFA_LOCK_DURATION_MS: 'auth.mfa.lockDurationMs',
  AUTH_MFA_PARTIAL_TTL: 'auth.mfa.partialTokenTtlSeconds',
  AUTH_TOTP_ISSUER: 'auth.mfa.issuer',
  AUTH_SDK_SESSION_TTL: 'auth.tokens.sdkSessionTtlSeconds',
  FEEDBACK_JWT_SECRET: 'auth.purposeTokens.feedbackSigningSecret',
  AUTH_FEEDBACK_SIGNING_SECRET: 'auth.purposeTokens.feedbackSigningSecret',
  GUPSHUP_WEBHOOK_JWT_SECRET: 'auth.purposeTokens.gupshupWebhookSigningSecret',
  AUTH_GUPSHUP_WEBHOOK_SIGNING_SECRET: 'auth.purposeTokens.gupshupWebhookSigningSecret',
  AUTH_SDK_SESSION_SIGNING_SECRET: 'auth.sdk.sessionSigningSecret',
  AUTH_SDK_BOOTSTRAP_SIGNING_SECRET: 'auth.sdk.bootstrapSigningSecret',
  AUTH_SDK_REQUIRE_DISTRIBUTED_STATE: 'auth.sdk.requireDistributedState',
  AUTH_DEVICE_AUTH_TTL_MS: 'auth.tokens.deviceAuthTtlMs',

  // Region
  AWS_REGION: 'region.current',
  REGION_IS_PRIMARY: 'region.isPrimary',
  REGION_DATA_RESIDENCY: 'region.dataResidency',

  // Sandbox / Tool Pod (gVisor execution)
  TOOLSERVICE_URL: 'sandbox.podHost',
  TOOLSERVICE_PORT: 'sandbox.podPort',
  TOOL_POD_PATH: 'sandbox.podPath',
  NODE_VM_TIMEOUT: 'sandbox.timeoutMs',
};

/**
 * Env keys whose value must NEVER be split on commas. These are scalar strings
 * that legitimately contain commas (e.g. cluster seed lists, replica-set URIs).
 * Without this guard, a `REDIS_URL=redis://h1:6379,redis://h2:6379` (cluster
 * mode) would be split into a string[] and rejected by the Zod string schema.
 */
const STRING_VALUED_ENV_KEYS = new Set<string>(['REDIS_URL', 'MONGODB_URI']);

/**
 * Coerce a string value to the appropriate type based on conventions.
 *
 * @param value  Raw env-var value
 * @param envKey Optional env-var name; used to suppress comma-splitting for
 *               keys that legitimately carry comma-separated scalars (URL
 *               seed lists, MongoDB replica-set URIs).
 */
function coerceValue(value: string, envKey?: string): string | number | boolean | string[] {
  // Boolean
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Comma-separated arrays (CORS_ORIGINS, etc.) — but NOT for keys that
  // intentionally contain commas in a single scalar (REDIS_URL cluster seed
  // lists, MONGODB_URI replica-set lists).
  if (
    value.includes(',') &&
    !value.startsWith('{') &&
    !(envKey && STRING_VALUED_ENV_KEYS.has(envKey))
  ) {
    return value.split(',').map((s) => s.trim());
  }

  return value;
}

/**
 * Set a nested property on an object using a dot-separated path.
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

/**
 * Map flat env vars to a nested config object using the provided mapping.
 */
export function mapEnvToConfig(
  envValues: Record<string, string>,
  mapping: EnvMapping = BASE_ENV_MAPPING,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  for (const [envKey, configPath] of Object.entries(mapping)) {
    const rawValue = envValues[envKey];
    if (rawValue === undefined) continue;
    setNestedValue(config, configPath, coerceValue(rawValue, envKey));
  }

  return config;
}

/**
 * Merge additional app-specific mappings with the base mapping.
 */
export function mergeEnvMappings(...mappings: EnvMapping[]): EnvMapping {
  return Object.assign({}, BASE_ENV_MAPPING, ...mappings);
}
