/**
 * @agent-platform/shared
 *
 * Shared middleware and types for Agent Platform apps (Studio + Runtime).
 */

// Middleware
export {
  requestIdMiddleware,
  getCurrentRequestId,
  runWithTenantContext,
  getCurrentTenantId,
  getCurrentUserId,
  isSuperAdminContext,
  getTenantContextData,
  createAuthMiddleware,
  createOptionalAuthMiddleware,
  verifyToken,
  extractUserIdFromToken,
  createServiceToken,
  verifyServiceToken,
  createObservabilityMiddleware,
  requirePermission,
  requireAllPermissions,
  requireAnyPermission,
  requireAuthType,
  requireProjectScope,
  requireEnvironmentScope,
  requirePlatformAdmin,
  requirePlatformAdminIp,
  isIpAllowed,
  createUnifiedAuthMiddleware,
  requireAuth,
  requireTenantContext,
  requireAuthWithTenant,
  createAccessDeniedReporter,
  attachAccessDeniedReporter,
  getRequestAccessDeniedReporter,
  requireTenantContextValue,
  PLATFORM_ADMIN_TENANT_ID,
  matchesSessionOwner,
  isElevatedPlatformRole,
  matchesPlatformMemberSessionOwner,
  buildSessionListFilter,
  evaluateSessionOwnershipAccess,
  createRequireSessionOwnership,
  toAuthContext,
  toLegacyTenantContext,
  createExpressErrorHandler,
  normalizeExpressError,
} from './middleware/index.js';

// Types - Middleware & Auth
export type {
  TenantContextData,
  AuthMiddlewareConfig,
  ServiceTokenPayload,
  ObservabilityContext,
  ObservabilityMiddlewareConfig,
  SessionOwnershipConfig,
  SessionOwnershipSubject,
  SessionOwnershipEvaluation,
  ExpressErrorHandlerOptions,
  NormalizedHttpError,
} from './middleware/index.js';

export type {
  JWTPayload,
  SDKSessionTokenPayload,
  SDKInitData,
  AuthUser,
  AuthType,
  CallerContext,
  ChannelArtifactType,
  IdentityTier,
  VerificationMethod,
  HMACEnforcementMode,
  SessionResolutionStrategy,
  SessionResolutionConfig,
  CallerIdentity,
  AuthContext,
  PlatformMemberContext,
  ChannelUserContext,
  ApiKeyContext,
  // Project Tool Form Types
  ProjectToolFormData,
  HttpToolFormData,
  SandboxToolFormData,
  McpToolFormData,
  ToolFormParameter,
  RuntimeNumericValue,
  HttpAuthType,
  HttpAuthConfig,
  HttpConsentMode,
  HttpConnectionMode,
} from './types/index.js';
export { isPlatformMember, isChannelUser, isApiKey } from './types/index.js';

// Types - Tools
export type { ToolType } from './types/tools.js';
export { TOOL_TYPES } from './types/tools.js';

// Types - Generic normalize utility
export type { Normalized } from './types/normalize.js';

// Types - MCP Server Config
export type { NormalizedMCPServerConfig, ApiMCPServerConfig } from './types/mcp-server.js';

// Types - MCP Auth
export type { McpAuthConfig, McpAuthType } from './types/mcp-auth.js';
export { MCP_AUTH_TYPES } from './types/mcp-auth.js';

// Types - Security (secrets, proxies, OAuth tokens)
export type {
  NormalizedToolSecret,
  NormalizedOrgProxyConfig,
  NormalizedEndUserOAuthToken,
} from './types/security.js';

export type { PaginatedResponse, ErrorResult, Result } from './types/repo-types.js';

// Email services
export {
  createEmailService,
  ConsoleEmailService,
  SESEmailService,
  ResendEmailService,
  SmtpEmailService,
} from './services/email-service.js';
export type { EmailService } from './services/email-service.js';
export {
  verificationEmail,
  passwordResetEmail,
  workspaceInvitationEmail,
} from './services/email-templates.js';

// S3 Storage service
export { S3StorageService, uploadBase64ToS3, downloadFromS3Url } from './services/s3-storage.js';
export type { S3StorageConfig, UploadOptions, UploadResult } from './services/s3-storage.js';

// Encryption
export {
  EncryptionService,
  getEncryptionService,
  isEncryptionAvailable,
} from './encryption/index.js';

// Distributed lock service — re-exported from @agent-platform/shared-observability for backwards compat
export {
  DistributedLockManager,
  type Lock,
  type LockOptions,
} from '@agent-platform/shared-observability';
// ID generation utilities
export { generateId, prefixedId, ids, otelTraceId, otelSpanId } from './id.js';

// Slug & naming utilities
export { slugify, AGENT_NAME_PATTERN, AGENT_NAME_MAX_LENGTH, validateAgentName } from './slug.js';
export { buildProjectAgentPath } from './project-agent-path.js';

// Errors
export {
  AppError,
  ValidationError,
  ErrorCodes,
  toErrorResponse,
  errorToResponse,
  type ErrorCode,
  type ErrorCodeEntry,
} from './errors.js';

// Error handling utilities
export {
  getErrorMessage,
  getErrorStack,
  toErrorResult,
  ToolExecutionError,
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  OAUTH_TOKEN_TIMEOUT_MS,
  MCP_RETRY_DELAY_BASE_MS,
} from './utils/errors.js';
export type { ToolErrorCode } from './utils/errors.js';

// Normalization utilities
export { normalizeDocument } from './utils/normalize.js';

// Type guard utilities
export { safeJsonParse, isRecord } from './utils/type-guards.js';

// Hashing utilities
export { computeSourceHash } from './utils/hash.js';

// Project Tool persistence guard
export {
  PROJECT_TOOL_TYPES,
  isProjectToolType,
  prepareProjectToolDslForPersistence,
  rewriteToolDslSignatureName,
  validateProjectToolDslForPersistence,
  validateToolDslConsistency,
} from './tools/project-tool-persistence.js';
export type {
  PreparedProjectToolDslPersistence,
  ProjectToolDslPersistenceInput,
  ProjectToolDslValidationResult,
} from './tools/project-tool-persistence.js';

// SDK bootstrap artifacts
export {
  SDK_BOOTSTRAP_ARTIFACT_TYPE_VALUES,
  SDK_BOOTSTRAP_PERMISSION_VALUES,
  isSdkBootstrapArtifactPayload,
  signSdkBootstrapArtifact,
  verifySdkBootstrapArtifact,
} from './sdk-bootstrap-artifact.js';
export type {
  SDKBootstrapArtifactType,
  SDKBootstrapPermission,
  SDKBootstrapArtifactPayload,
  SDKPreviewBootstrapArtifact,
  SDKShareBootstrapArtifact,
  SDKCustomerBootstrapArtifact,
} from './sdk-bootstrap-artifact.js';

// Browser-hosted SDK route matching
export { isBrowserSdkRoute } from './sdk-browser-routes.js';

// Pipeline observability contract
export {
  PIPELINE_OBSERVABILITY_CONTRACT,
  PIPELINE_OBSERVABILITY_DEFERRED_CAPABILITIES,
  PIPELINE_OBSERVABILITY_SUPPORTED_SURFACES,
} from './pipeline-observability-contract.js';
export type {
  PipelineObservabilityContract,
  PipelineObservabilityDeferredCapability,
  PipelineObservabilityResponseMeta,
  PipelineObservabilitySupportedSurface,
} from './pipeline-observability-contract.js';

// Model pricing — canonical LLM pricing table for cost estimation
export { MODEL_PRICING, DEFAULT_PRICING, estimateCost } from './model-pricing.js';
export type { ModelPricing } from './model-pricing.js';

// Model routing — canonical operation-to-tier routing contract
export {
  DEFAULT_OPERATION_TIERS,
  MODEL_ROUTING_OPERATIONS,
  MODEL_ROUTING_TIERS,
  TEXT_MODEL_ROUTING_TIERS,
  formatOperationTierOverrideError,
  getDefaultOperationTier,
  isModelRoutingOperation,
  isModelRoutingTier,
  isTextModelRoutingTier,
  normalizeOperationTierOverrides,
} from '@agent-platform/shared-kernel';
export type {
  ModelRoutingOperation,
  ModelRoutingTier,
  OperationTierOverrideValidationResult,
  OperationTierOverrides,
  TextModelRoutingTier,
} from '@agent-platform/shared-kernel';

// Security utilities
export {
  isPrivateIP,
  isMetadataEndpoint,
  isLocalhost,
  validateUrlForSSRF,
} from './security/index.js';

// Attachment types & interfaces
export type {
  AttachmentCategory,
  ScanStatus,
  ProcessingStatus,
  EmbeddingStatus,
  AttachmentInput,
  AttachmentConfig,
  StorageProvider,
  ScanProvider,
  DocumentParser,
  TranscriptionProvider,
  VideoProcessor,
} from './attachments/index.js';

// Project Tool Validation Schemas
export {
  CreateProjectToolSchema,
  CreateHttpToolSchema,
  CreateSandboxToolSchema,
  CreateMcpToolSchema,
  UpdateProjectToolSchema,
} from './validation/project-tool-schemas.js';
export type {
  CreateProjectToolInput,
  UpdateProjectToolInput,
} from './validation/project-tool-schemas.js';

// Project Tool - DSL serialization, validation, resolution
export {
  serializeToolFormToDsl,
  extractSignatureFromDsl,
  normalizeHttpAuthConfig,
  validateToolDsl,
  parseDslProperties,
  buildWorkflowBindingFromProps,
  validateWorkflowToolBinding,
} from './tools/index.js';
export type {
  ValidationResult,
  ValidateToolDslContext,
  ProjectToolDiagnostic,
  DiagnosticSeverity,
  ResolveToolImplInput,
  ResolveToolImplResult,
  ResolvedToolImpl,
  ToolSnapshotEntry,
  ResolutionTimings,
  ResolveToolImplDeps,
  WorkflowBindingLocal,
} from './tools/index.js';

// Guardrail Rule Validation (shared by Studio + Runtime)
export { validateRule } from './validation/guardrail-rule-validation.js';
export type {
  GuardrailRuleInput,
  ValidatedRule,
  ValidateRuleResult,
} from './validation/guardrail-rule-validation.js';

// Database model re-exports (type-only) for project tools
export type { IProjectTool, ProjectToolType } from '@agent-platform/database/models';
