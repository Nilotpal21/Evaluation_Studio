/**
 * @agent-platform/config
 *
 * Shared configuration management for Agent Platform.
 * Provides schemas, vault providers, config loading, and validation.
 */

// Tenant config types (shared between runtime and studio)
export type {
  Plan,
  TenantLimits,
  TenantFeatures,
  TenantSecurityConfig,
  TenantConfig,
} from './tenant-config-types.js';

// Core types
export type { Environment } from './environment.js';
export {
  VALID_ENVIRONMENTS,
  VALID_ENVIRONMENTS_WITH_GLOBAL,
  VALID_ENVIRONMENTS_NULLABLE,
  normalizeEnvironment,
  isProduction,
  isDevelopment,
} from './environment.js';
export type {
  Region,
  DeploymentContext,
  ConfigMeta,
  ConfigChangeEvent,
  DeploymentIdentity,
  BuildManifest,
} from './types.js';

// Kafka auth
export {
  resolveKafkaAuth,
  type KafkaAuthConfig,
  type KafkaSaslConfig,
  type KafkaSaslMechanism,
} from './kafka-auth.js';

// Constants
export * from './constants.js';
export { SENSITIVE_PATHS } from './constants/sensitive-paths.js';
export {
  DEEPGRAM_STT_MODELS,
  DEFAULT_DEEPGRAM_STT_MODEL,
  FLUX_DEFAULTS,
  isFluxModel,
  type DeepgramModelOption,
} from './constants/deepgram-models.js';
export {
  CHANNEL_STT_PROVIDER_TYPES,
  CHANNEL_TTS_PROVIDER_TYPES,
  RUNTIME_VOICE_SERVICE_TYPES,
  S2S_PROVIDER_TYPES,
  TTS_PREVIEW_PROVIDER_TYPES,
  VOICE_PROVIDER_DEFINITIONS,
  describeRuntimeVoiceServiceTypes,
  getS2STelephonySupport,
  getS2STelephonySupportMessage,
  getSpeechProviderRole,
  getVoiceProviderDefinition,
  getVoiceProviderLabel,
  isChannelSttVoiceServiceType,
  isChannelTtsVoiceServiceType,
  isRuntimeVoiceServiceType,
  isS2SProviderType,
  isSpeechVoiceServiceType,
  isTtsPreviewProviderType,
  listAdminVoiceProviders,
  type S2SProviderType,
  type S2STelephonySupport,
  type SpeechProviderRole,
  type VoiceAdminSurface,
  type VoiceProviderCapabilities,
  type VoiceProviderDefinition,
  type VoiceServiceType,
} from './constants/voice-providers.js';

// Schemas
export * from './schemas/index.js';

// Vault
export type { VaultProvider, VaultType } from './vault/index.js';
export { createVaultProvider } from './vault/index.js';
export { EnvProvider } from './vault/env-provider.js';
export { FileProvider } from './vault/file-provider.js';
export { HashiCorpVaultProvider } from './vault/hashicorp-vault.js';
export { AWSSecretsProvider } from './vault/aws-secrets.js';
export { AzureKeyVaultProvider } from './vault/azure-keyvault.js';
export { K8sSecretProvider } from './vault/k8s-secret-provider.js';
export { CompositeVaultProvider } from './vault/composite-provider.js';

// Loader
export {
  createConfigLoader,
  type LoadConfigOptions,
  type ConfigLoaderResult,
  type CreateConfigLoaderOptions,
} from './loader.js';

// Env mapping
export {
  BASE_ENV_MAPPING,
  mapEnvToConfig,
  mergeEnvMappings,
  type EnvMapping,
} from './env-mapping.js';

// Composition
export { composeConfigSchema } from './compose.js';

// Sealing
export { deepFreeze, sealConfig } from './sealer.js';

// Watcher
export { ConfigWatcher, type WatcherOptions } from './watcher.js';

// Validation
export {
  validateProductionConfig,
  validateEncryptionKey,
  type ProductionWarning,
} from './validation/production-checks.js';
export { validateRegionConfig } from './validation/region-checks.js';
export { validateUrlSafety, redactUrlCredentials } from './validation/url-safety.js';
export { diffConfigs, type ConfigDiff, type DiffEntry } from './validation/config-diff.js';
export {
  validateCrossServiceConfig,
  type ServiceConfig,
  type CrossServiceIssue,
} from './validation/cross-service.js';
export { validateJsonLayerFields, type JsonLayerIssue } from './validation/json-layer-checks.js';
export {
  validateProductionPolicy,
  type PolicyIssue,
  type ProductionPolicyConfig,
} from './validation/production-policy.js';

// Version
export { computeConfigHash } from './version/config-hash.js';

// Health
export { DegradedModeManager, type DegradedModeListener } from './health/degraded-mode.js';

// Observability
export {
  CONFIG_METRICS,
  NoopMetricEmitter,
  type ConfigMetricEmitter,
} from './observability/metrics.js';

// Deployment Identity Schema
export {
  DeploymentIdentitySchema,
  BuildManifestSchema,
  loadDeploymentIdentity,
  resolveVaultBasePath,
  type DeploymentIdentityInput,
  type DeploymentIdentityParsed,
  type BuildManifestParsed,
} from './schemas/deployment-identity.schema.js';
