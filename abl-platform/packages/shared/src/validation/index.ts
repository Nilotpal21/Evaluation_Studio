/**
 * Shared Validation Barrel
 *
 * Re-exports all validation functions and Zod schemas.
 */

// Tool validation constants
export { MAX_DESCRIPTION_LENGTH, MAX_CODE_SIZE } from './tool-validation.js';

// Tool secret schemas
export {
  CreateToolSecretSchema,
  RotateToolSecretSchema,
  ToolSecretMetadataSchema,
  CreateToolSecretResponseSchema,
  ListToolSecretsResponseSchema,
  RotateToolSecretResponseSchema,
  DeleteToolSecretResponseSchema,
  MAX_SECRET_VALUE_LENGTH,
  MAX_SECRET_FIELD_LENGTH,
} from './tool-secret-schemas.js';

// Proxy config schemas
export {
  ProxyConfigMetadataSchema,
  ProxyConfigMetadataWithCertsSchema,
  CreateProxyConfigSchema,
  UpdateProxyConfigSchema,
  CreateProxyConfigResponseSchema,
  ListProxyConfigsResponseSchema,
  UpdateProxyConfigResponseSchema,
  DeleteProxyConfigResponseSchema,
  MAX_CERT_LENGTH,
  MAX_PROXY_FIELD_LENGTH,
} from './proxy-config-schemas.js';

// Generic parse helper
export { parseInput } from './parse.js';
export type { ParseResult, ParseSuccess, ParseFailure } from './parse.js';

// Auth type alias normalization (FR-16)
export { AUTH_TYPE_ALIASES, normalizeAuthType } from './auth-type-aliases.js';
export type { AuthTypeAlias } from './auth-type-aliases.js';

// PII recognizer pack canonical names
export { PACK_NAMES } from './pii-pack-names.js';
export type { PackName } from './pii-pack-names.js';

// Project tool schemas
export {
  CreateProjectToolSchema,
  CreateHttpToolSchema,
  CreateSandboxToolSchema,
  CreateMcpToolSchema,
  UpdateProjectToolSchema,
  validateHttpToolEndpoint,
  MAX_DSL_SIZE,
  TOOL_NAME_REGEX,
} from './project-tool-schemas.js';
export type { CreateProjectToolInput, UpdateProjectToolInput } from './project-tool-schemas.js';

// Project runtime config schemas
export {
  extractionConfigSchema,
  multiIntentConfigSchema,
  inferenceConfigSchema,
  conversionConfigSchema,
  piiRedactionConfigSchema,
  compactionConfigSchema,
  modelSourceSchema,
  promptOverrideRefSchema,
  pipelineConfigSchema,
  fillerConfigSchema,
  lookupTableEntrySchema,
  PROJECT_RUNTIME_CONFIG_DEFAULTS,
  runtimeConfigUpdateSchema,
  runtimeConfigResponseSchema,
} from './project-runtime-config.js';
export type { RuntimeConfigUpdateInput, RuntimeConfigResponse } from './project-runtime-config.js';

// Auth Profile schemas
export {
  CreateAuthProfileSchema,
  UpdateAuthProfileSchema,
  NoneConfigSchema,
  ApiKeyConfigSchema,
  BearerConfigSchema,
  OAuth2AppConfigSchema,
  OAuth2TokenConfigSchema,
  OAuth2ClientCredentialsConfigSchema,
  NoneSecretsSchema,
  ApiKeySecretsSchema,
  BearerSecretsSchema,
  OAuth2AppSecretsSchema,
  OAuth2TokenSecretsSchema,
  OAuth2ClientCredentialsSecretsSchema,
  PHASE1_SCHEMA_AUTH_TYPES,
  PHASE1_AUTH_TYPES,
  AUTH_PROFILE_USAGE_MODES,
  AUTH_TYPE_CONFIG_SCHEMAS,
  AUTH_TYPE_SECRETS_SCHEMAS,
  getAllowedConfigKeys,
  getAllowedAuthProfileUsageModes,
  getAuthProfileUsageModeValidationError,
  getMaterializedAuthProfileValidationErrors,
  mergeOAuth2AppConfig,
  normalizeOAuth2AppConfig,
  resolveAuthProfileUsageMode,
} from './auth-profile.schema.js';
export type {
  AuthProfileUsageMode,
  CreateAuthProfileInput,
  UpdateAuthProfileInput,
} from './auth-profile.schema.js';

// Auth Profile Phase 2 schemas
export {
  BasicConfigSchema,
  BasicSecretsSchema,
  CustomHeaderConfigSchema,
  CustomHeaderSecretsSchema,
  CustomHeaderCrossFieldValidator,
  AwsIamConfigSchema,
  AwsIamSecretsSchema,
  AzureAdConfigSchema,
  AzureAdSecretsSchema,
  MtlsConfigSchema,
  MtlsSecretsSchema,
  SshKeyConfigSchema,
  SshKeySecretsSchema,
} from './auth-profile-phase2.schema.js';

// Auth Profile support matrix (co-located with Phase 2 schemas)
export {
  PHASE2_CORE_AUTH_TYPES,
  AUTH_PROFILE_CONSUMER_KINDS,
  AUTH_PROFILE_SUPPORT_LEVELS,
  isPhase2CoreAuthType,
  getAuthProfileSupportDecision,
  listAuthProfileSupportDecisions,
  listSelectablePhase2CoreAuthTypes,
} from './auth-profile-phase2.schema.js';
export type {
  Phase2CoreAuthType,
  AuthProfileConsumerKind,
  AuthProfileSupportLevel,
  AuthProfileSupportReasonCode,
  AuthProfileSupportDecision,
} from './auth-profile-phase2.schema.js';

// Auth Profile Phase 3 schemas
export {
  DigestConfigSchema,
  DigestSecretsSchema,
  KerberosConfigSchema,
  KerberosSecretsSchema,
  SamlConfigSchema,
  SamlSecretsSchema,
  HawkConfigSchema,
  HawkSecretsSchema,
  WsSecurityConfigSchema,
  WsSecuritySecretsSchema,
} from './auth-profile-phase3.schema.js';

// Auth Profile Addon schemas
export {
  SigningAddonSchema,
  WebhookVerificationAddonSchema,
  ProxyAddonSchema,
  validateAddonCombination,
  validateAddonSecrets,
} from './auth-profile-addons.schema.js';

// Guardrail rule validation (shared by Studio + Runtime)
export { validateRule } from './guardrail-rule-validation.js';
export type {
  GuardrailRuleInput,
  ValidatedRule,
  ValidateRuleResult,
} from './guardrail-rule-validation.js';
