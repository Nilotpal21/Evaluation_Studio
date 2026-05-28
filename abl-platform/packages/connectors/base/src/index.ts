/**
 * @agent-platform/connectors-base
 *
 * Shared connector infrastructure for enterprise data sources.
 * Provides OAuth, rate limiting, sync coordination, and filtering.
 */

// ─── Interfaces ──────────────────────────────────────────────────────────

export type {
  IConnector,
  ValidationResult,
  ConnectionTestResult,
  SyncResult,
  PermissionCrawlResult,
  WebhookSubscription,
  ISyncCoordinator,
  SourceDocument,
  SyncProgressCallback,
  IFilterEngine,
  FilterConfig,
  StandardFilterConfig,
  FilterEvaluationResult,
  FilterValidationResult,
  FilterValidationError,
  FilterStatistics,
  IPermissionCrawler,
  NormalizedPermission,
  PermissionCrawlOptions,
  PermissionCrawlStats,
  IOAuthProvider,
  OAuthMethod,
  DeviceCodeResponse,
  AuthorizationCodeRequest,
  AuthorizationCodeExchange,
  OAuthTokens,
  TokenRefreshResult,
  IResourceDiscovery,
  DiscoveredResource,
  ContentProfile,
  DiscoveryProgress,
  DiscoveryProgressCallback,
  ResourceDiscoveryResult,
  ResourceScore,
  ResourceScoreFactors,
  SyncStrategyRecommendation,
  PermissionRecommendation,
  FilterRecommendation,
  CostEstimate,
  ConnectorRecommendation,
  ISchemaIntrospection,
  IntrospectedField,
} from './interfaces/index.js';

// ─── Authentication ──────────────────────────────────────────────────────

export { DeviceCodeFlowAuthenticator, DeviceCodeFlowError } from './auth/device-code-flow.js';
export { TokenManager, TokenManagerError } from './auth/token-manager.js';

// ─── HTTP Client ─────────────────────────────────────────────────────────

export { RateLimiter } from './client/rate-limiter.js';
export {
  RetryHandler,
  DEFAULT_RETRY_OPTIONS,
  type RetryOptions,
  type RetryContext,
} from './client/retry-handler.js';
export {
  HttpClient,
  HttpError,
  type HttpClientConfig,
  type RequestOptions,
  type HttpResponse,
} from './client/http-client.js';
export {
  ConnectorCircuitBreaker,
  CircuitBreakerError,
  type CircuitBreakerOptions,
  type CircuitState,
} from './client/circuit-breaker.js';

// ─── Sync ────────────────────────────────────────────────────────────────

export { BaseSyncCoordinator } from './sync/base-sync-coordinator.js';
export type { SyncCoordinatorModels } from './sync/base-sync-coordinator.js';

// ─── Cancellation ────────────────────────────────────────────────────────

export { CancellationChecker, type CancellationCheckerOptions } from './cancellation/index.js';

// ─── Discovery ──────────────────────────────────────────────────────────

export { BaseResourceDiscovery } from './discovery/base-resource-discovery.js';

// ─── Security ────────────────────────────────────────────────────────

export type {
  PermissionManifest,
  ScopeJustification,
  NotRequestedScope,
  DataHandlingInfo,
  RetentionEntry,
  ComplianceMapping,
  RevocationInfo,
  KnownLimitation,
  BlastRadiusTier,
} from './security/permission-manifest.js';

export { resolveEffectiveScopes } from './security/permission-manifest.js';

// ─── Filters ─────────────────────────────────────────────────────────────

export { BaseFilterEngine } from './filters/base-filter-engine.js';
export {
  FileExtensionRegistry,
  type FileExtensionConfig,
  type FileExtensionCheckResult,
} from './filters/file-extension-registry.js';
export {
  FolderPathMatcher,
  type FolderPathConfig,
  type FolderPathMatchResult,
} from './filters/folder-path-matcher.js';
export {
  AdvancedFilterEvaluator,
  type AdvancedFilterConfig,
  type FilterCondition,
  type FilterGroup,
  type FilterOperator,
} from './filters/advanced-filter-evaluator.js';
export {
  FILTER_TEMPLATES,
  getTemplatesForConnector,
  getTemplateById,
  resolveRelativeDate,
  type FilterTemplate,
} from './filters/filter-templates.js';
