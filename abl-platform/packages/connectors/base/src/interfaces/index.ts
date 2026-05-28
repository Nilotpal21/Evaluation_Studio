/**
 * Base Connector Interfaces
 *
 * Core interfaces that all connector implementations must follow.
 */

export type {
  IConnector,
  ValidationResult,
  ConnectionTestResult,
  SyncResult,
  PermissionCrawlResult,
  WebhookSubscription,
} from './connector.interface.js';

export type {
  ISyncCoordinator,
  SourceDocument,
  SyncProgressCallback,
} from './sync-coordinator.interface.js';

export type {
  IFilterEngine,
  FilterConfig,
  StandardFilterConfig,
  FilterEvaluationResult,
  FilterValidationResult,
  FilterValidationError,
  FilterStatistics,
  FileExtensionConfig,
  FolderPathConfig,
  AdvancedFilterConfig,
  FilterCondition,
  FilterGroup,
  FilterOperator,
} from './filter-engine.interface.js';

export type {
  IPermissionCrawler,
  NormalizedPermission,
  PermissionCrawlOptions,
  PermissionCrawlStats,
} from './permission-crawler.interface.js';

export type {
  IOAuthProvider,
  OAuthMethod,
  DeviceCodeResponse,
  AuthorizationCodeRequest,
  AuthorizationCodeExchange,
  OAuthTokens,
  TokenRefreshResult,
} from './oauth-provider.interface.js';

export type {
  IResourceDiscovery,
  DiscoveredResource,
  ContentProfile,
  DiscoveryProgress,
  DiscoveryProgressCallback,
  ResourceDiscoveryResult,
} from './resource-discovery.interface.js';

export type {
  ResourceScore,
  ResourceScoreFactors,
  SyncStrategyRecommendation,
  PermissionRecommendation,
  FilterRecommendation,
  CostEstimate,
  ConnectorRecommendation,
} from './recommendation.interface.js';

export type { ISchemaIntrospection, IntrospectedField } from './schema-introspection.interface.js';
