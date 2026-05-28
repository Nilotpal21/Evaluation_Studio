/**
 * @agent-platform/database
 *
 * MongoDB-based database layer for Agent Platform.
 * Re-exports from the mongo and models submodules.
 */

export { MongoConnectionManager } from './mongo/index.js';
export type { MongoDBConfig } from './mongo/index.js';
export { ModelRegistry } from './model-registry.js';
export type { DatabaseAffinity } from './model-registry.js';
export {
  resolveTenantPlaintextValue,
  type ResolveTenantPlaintextValueOptions,
} from './tenant-plaintext-value.js';
export {
  DEFAULT_EVAL_RETENTION,
  EVAL_KNOWN_SOURCES,
  assertDefaultSyntheticRetentionIsShorter,
  assertEvalRetentionTtlBounds,
  normalizeEvalKnownSource,
  resolveEvalConversationTtlDays,
  resolveEvalRetentionContract,
  resolveEvalScoreTtlDays,
} from './eval-retention.js';
export type {
  EvalKnownSource,
  EvalRetentionContract,
  EvalRetentionDefaults,
  TenantEvalRetentionConfig,
  TenantSettingsWithEvalRetention,
} from './eval-retention.js';
export {
  addAllowedDomain,
  addAllowedEmail,
  addPlatformAdmin,
  canUserCreateWorkspace,
  DEFAULT_ALLOWED_DOMAINS,
  getAllowedDomainValues,
  getEmailDomain,
  hasValidInvitationForEmail,
  isAllowlistedEmail,
  isEmailAllowedForAuth,
  isPlatformAdminEmail,
  isPlatformAdminUser,
  isValidAllowedDomain,
  isValidEmail,
  listAccessPolicy,
  listAllowedDomains,
  listAllowedEmails,
  listPlatformAdminEmails,
  listPlatformAdmins,
  listPendingAccessRequests,
  listPendingAccessRequestsForDomain,
  markAccessRequestsNotified,
  normalizeDomain,
  normalizeEmail,
  recordPlatformAccessRequest,
  revokeAllowedDomain,
  revokeAllowedEmail,
  revokePlatformAdmin,
} from './platform-access-policy.js';
export type {
  PlatformAccessPolicy,
  PlatformAccessRequestRecord,
  PlatformAdminPrincipal,
} from './platform-access-policy.js';

// ClickHouse client and utilities
export {
  createDedicatedClickHouseClient,
  getClickHouseClient,
  closeClickHouseClient,
  BufferedClickHouseWriter,
} from './clickhouse.js';
export type { ClickHouseConfig, BufferedWriterOptions } from './clickhouse.js';

// ClickHouse encryption interceptor
export { ClickHouseEncryptionInterceptor } from './clickhouse-encryption-interceptor.js';

// ClickHouse observability (system metrics and slow query logging)
export { ClickHouseObservability } from './clickhouse-observability.js';
export type {
  SlowQuery,
  QueryError,
  ReplicaHealth,
  DiskUsage,
  TablePartitionMetrics,
} from './clickhouse-observability.js';

// Attachment models (from develop)
export { Attachment, type IAttachment } from './models/attachment.model.js';
export {
  TenantAttachmentConfig,
  type ITenantAttachmentConfig,
} from './models/tenant-attachment-config.model.js';
export {
  ProjectAttachmentConfig,
  type IProjectAttachmentConfig,
} from './models/project-attachment-config.model.js';
export {
  ArchSessionAttachment,
  type IArchSessionAttachment,
} from './models/arch-session-attachment.model.js';
export { DemoVisionConfig, type IDemoVisionConfig } from './models/demo-vision-config.model.js';

// Search-AI models and types
export { SearchChunk } from './models/search-chunk.model.js';
// KG extended types
export type {
  ISearchChunk,
  IEntityExtraction,
  IKGState,
  IChunkClassification,
} from './models/search-chunk.model.js';
export { ChunkHierarchy } from './models/chunk-hierarchy.model.js';
export type { IChunkHierarchy } from './models/chunk-hierarchy.model.js';
export { KnowledgeGraphTaxonomy } from './models/knowledge-graph-taxonomy.model.js';
export type {
  IKnowledgeGraphTaxonomy,
  IKGDomain,
  IKGCategory,
  IKGProduct,
  IKGAttribute,
  IKGDepartmentBoundary,
} from './models/knowledge-graph-taxonomy.model.js';
export { KnowledgeGraphDomain } from './models/knowledge-graph-domain.model.js';
export type { IKnowledgeGraphDomain } from './models/knowledge-graph-domain.model.js';
export { ChunkQuestion } from './models/chunk-question.model.js';
export type { IChunkQuestion } from './models/chunk-question.model.js';
export { DocumentPage } from './models/document-page.model.js';
export type {
  IDocumentPage,
  BoundingBox,
  HeadingInfo,
  TableInfo,
  ImageInfo,
  PageLayout,
} from './models/document-page.model.js';
export { SearchDocument } from './models/search-document.model.js';
// KG extended types
export type {
  ISearchDocument,
  IDocumentClassification,
  IDocumentKGState,
} from './models/search-document.model.js';
export { SearchIndex } from './models/search-index.model.js';
export type { ISearchIndex } from './models/search-index.model.js';
export { SearchSource } from './models/search-source.model.js';
export type {
  ISearchSource,
  ICrawlConfig,
  ICrawlConfigProfile,
  ICrawlConfigSection,
  ICrawlConfigSettings,
  ICrawlConfigAuth,
  ICrawlConfigGroupStrategy,
  CrawlConfigWizardStep,
  CrawlConfigStrategy,
  CrawlConfigAuthMethod,
} from './models/search-source.model.js';
// KG field mapping
export { FieldMapping } from './models/field-mapping.model.js';
export type { IFieldMapping, IFieldTransform } from './models/field-mapping.model.js';
export { TenantLLMPolicy } from './models/tenant-llm-policy.model.js';
export type { ITenantLLMPolicy } from './models/tenant-llm-policy.model.js';
export { LLMCredential } from './models/llm-credential.model.js';
export type { ILLMCredential } from './models/llm-credential.model.js';
export { IndexRegistry } from './models/index-registry.model.js';
export type { IIndexRegistry, IndexStrategy, IndexStatus } from './models/index-registry.model.js';
export { SharedIndexTracker } from './models/shared-index-tracker.model.js';
export type {
  ISharedIndexTracker,
  SharedIndexStatus,
} from './models/shared-index-tracker.model.js';

// Phase 3: Visual enrichment types
export type {
  ImageDescription,
  ScreenshotAnalysis,
  VisualAnalysisMetadata,
  SearchChunkMetadata,
  ISearchChunkWithVisual,
  ChunkQuestionMetadata,
  IChunkQuestionWithVisual,
  VisualDocumentSummary,
  DocumentMetadata,
} from './models/visual-enrichment-types.js';
export {
  hasVisualEnrichment,
  isVisuallyEnrichedQuestion,
  getImageDescriptions,
  getProgressiveSummary,
  getDocumentSummary,
} from './models/visual-enrichment-types.js';

// Project models (agents, tools, settings, config)
export { Project } from './models/project.model.js';
export type { IProject } from './models/project.model.js';
export { ProjectAgent } from './models/project-agent.model.js';
export type { IProjectAgent } from './models/project-agent.model.js';
export { ModelConfig } from './models/model-config.model.js';
export type { IModelConfig } from './models/model-config.model.js';
export { ProjectTool, PROJECT_TOOL_TYPES } from './models/project-tool.model.js';
export type { IProjectTool, ProjectToolType } from './models/project-tool.model.js';
export {
  ToolTestEndpoint,
  TOOL_TEST_ENDPOINT_STATUSES,
  TOOL_TEST_RESPONSE_MODES,
} from './models/tool-test-endpoint.model.js';
export type {
  IToolTestEndpoint,
  ToolTestEndpointStatus,
  ToolTestResponseMode,
} from './models/tool-test-endpoint.model.js';
export { ProjectSettings } from './models/project-settings.model.js';
export type { IProjectSettings } from './models/project-settings.model.js';
export { ProjectLLMConfig } from './models/project-llm-config.model.js';
export type { IProjectLLMConfig } from './models/project-llm-config.model.js';
export { AgentModelConfig } from './models/agent-model-config.model.js';
export type { IAgentModelConfig } from './models/agent-model-config.model.js';
export { EnvironmentVariable } from './models/environment-variable.model.js';
export type { IEnvironmentVariable } from './models/environment-variable.model.js';
export { ProjectConfigVariable } from './models/project-config-variable.model.js';
export type { IProjectConfigVariable } from './models/project-config-variable.model.js';
export { MCPServerConfig } from './models/mcp-server-config.model.js';
export type { IMCPServerConfig } from './models/mcp-server-config.model.js';

// Connector models (from develop)
export { ConnectorConfig } from './models/connector-config.model.js';
export type { IConnectorConfig } from './models/connector-config.model.js';
export { ConnectorConnection } from './models/connector-connection.model.js';
export type { IConnectorConnection } from './models/connector-connection.model.js';
export { SyncCheckpoint } from './models/sync-checkpoint.model.js';
export type { ISyncCheckpoint } from './models/sync-checkpoint.model.js';
export { DriveDeltaToken } from './models/drive-delta-token.model.js';
export type { IDriveDeltaToken } from './models/drive-delta-token.model.js';
export { WebhookSubscriptionConnector } from './models/webhook-subscription-connector.model.js';
export type { IWebhookSubscriptionConnector } from './models/webhook-subscription-connector.model.js';

// Connector audit trail
export type { IConnectorAuditEntry } from './types/connector-audit-entry.js';
export type { ICrawlAuditEvent } from './types/crawl-audit-event.js';

// Connector config versioning
export { ConnectorConfigVersion } from './models/connector-config-version.model.js';
export type { IConnectorConfigVersion } from './models/connector-config-version.model.js';

// Connector templates
export { ConnectorTemplate } from './models/connector-template.model.js';
export type { IConnectorTemplate } from './models/connector-template.model.js';

// Notification subscriptions
export { NotificationSubscription } from './models/notification-subscription.model.js';
export type { INotificationSubscription } from './models/notification-subscription.model.js';

// Connector cleanup jobs (content purge)
export { ConnectorCleanupJob } from './models/connector-cleanup-job.model.js';
export type { IConnectorCleanupJob } from './models/connector-cleanup-job.model.js';
export { GitWebhookCleanupJob } from './models/git-webhook-cleanup-job.model.js';
export type {
  IGitWebhookCleanupJob,
  GitWebhookCleanupOperation,
  GitWebhookCleanupStatus,
} from './models/git-webhook-cleanup-job.model.js';

// Proposal state (setup flow)
export { ProposalState } from './models/proposal-state.model.js';
export type {
  IProposalState,
  ProposalStatus,
  GenerationStepStatus,
  SectionReviewStatus,
  IGenerationStep,
  ISectionData,
  IDecisionEntry,
} from './models/proposal-state.model.js';

// Discovery & Recommendation models
export { ConnectorDiscovery } from './models/connector-discovery.model.js';
export type { IConnectorDiscovery } from './models/connector-discovery.model.js';
export { ConnectorRecommendation } from './models/connector-recommendation.model.js';
export type { IConnectorRecommendation } from './models/connector-recommendation.model.js';

// OAuth model (already exists, re-export for convenience)
export { EndUserOAuthToken } from './models/end-user-oauth-token.model.js';
export type { IEndUserOAuthToken } from './models/end-user-oauth-token.model.js';

// Auth Profile Audit Events (ABLP-913)
export {
  AuthProfileAuditEvent,
  AUTH_PROFILE_AUDIT_EVENT_TYPES,
} from './models/auth-profile-audit-event.model.js';
export type {
  IAuthProfileAuditEvent,
  IActorContext,
  AuthProfileAuditEventType,
} from './models/auth-profile-audit-event.model.js';

// Lookup table models
export { LookupEntry } from './models/lookup-entry.model.js';
export type { ILookupEntry } from './models/lookup-entry.model.js';

// Project runtime config
export { ProjectRuntimeConfig } from './models/project-runtime-config.model.js';
export type { IProjectRuntimeConfig } from './models/project-runtime-config.model.js';

// Metrics & Audit
export { LLMUsageMetric } from './models/llm-usage-metric.model.js';
export type { ILLMUsageMetric } from './models/llm-usage-metric.model.js';
export { OrgProfileMetric } from './models/org-profile-metric.model.js';
export type { IOrgProfileMetric } from './models/org-profile-metric.model.js';
export {
  AuditLog,
  ensureAuditLogTTLIndex,
  isAuditLogTTLIndexEnabled,
} from './models/audit-log.model.js';
export type { IAuditLog } from './models/audit-log.model.js';

// Guardrail models
export { GuardrailPolicy } from './models/guardrail-policy.model.js';
export type { IGuardrailPolicy } from './models/guardrail-policy.model.js';

// Workflow models
export { Workflow } from './models/workflow.model.js';
export type { IWorkflow } from './models/workflow.model.js';

// RFC-SEARCHAI-001: Canonical Mapping models
export { DomainVocabulary } from './models/domain-vocabulary.model.js';
export type { IDomainVocabulary, IVocabularyEntry } from './models/domain-vocabulary.model.js';
export { CapabilityRegistry } from './models/capability-registry.model.js';
export type { ICapability } from './models/capability-registry.model.js';
export { CanonicalSchema } from './models/canonical-schema.model.js';
export type { ICanonicalSchema } from './models/canonical-schema.model.js';

// Knowledge base
export { KnowledgeBase, type IKnowledgeBase } from './models/knowledge-base.model.js';

// Pipeline configuration
export {
  SearchPipelineDefinition,
  type IActiveEmbeddingConfig,
  type ISearchPipelineDefinition,
  type ISearchPipelineFlow,
  type ISearchPipelineStage,
  type ISearchRuleCondition,
  type ISearchValidationError,
  type SearchPipelineStageType,
  type SearchRuleConditionType,
  type EmbeddingProviderType,
} from './models/search-pipeline-definition.model.js';
export {
  JobExecution,
  type IJobExecution,
  type IJobExecutionError,
  type WorkerStage,
  type JobExecutionStatus,
} from './models/job-execution.model.js';

// Source Config State & URL Buckets (Draft Elimination)
export { SourceConfigState } from './models/source-config-state.model.js';
export type {
  ISourceConfigState,
  DiscoveryStatusValue,
} from './models/source-config-state.model.js';
export { SourceUrlBucket, SOURCE_URL_BUCKET_SIZE } from './models/source-url-bucket.model.js';
export type { ISourceUrlBucket, ISourceBucketUrl } from './models/source-url-bucket.model.js';

// Seed helpers
export { upsertOne, type UpsertOptions } from './seed/upsert-helpers.js';
export {
  DEFAULT_TENANT_LLM_POLICY,
  seedTenantBootstrapDefaults,
  type SeedTenantBootstrapOptions,
  type SeedTenantBootstrapResult,
} from './seed/tenant-bootstrap.js';

// Change-management registry foundation
export {
  CHANGE_MANIFEST,
  CHANGE_RELEASE_EVIDENCE_CONTRACT,
  KNOWN_CHANGE_SURFACES,
  LEGACY_LEDGER_MAPPINGS,
  getChangeManifestEntry,
  getChangeManifestForEnvironment,
  validateChangeManifest,
} from './change-management/manifest.js';
export {
  CHANGE_HISTORY_COLLECTION,
  readChangeHistory,
  shadowWriteChangeHistory,
  writeChangeHistory,
} from './change-management/history.js';
export type { NormalizedChangeHistoryRecord } from './change-management/history.js';
export {
  CHANGE_LOCK_COLLECTION,
  DEFAULT_CHANGE_LOCK_HEARTBEAT_MS,
  DEFAULT_CHANGE_LEASE_TTL_MS,
  StaleLeaseFenceError,
  acquireChangeLease,
  assertLeaseFence,
  extendChangeLease,
  getChangeLease,
  isChangeLeaseHeld,
  releaseChangeLease,
  resolveChangeLockHeartbeatMs,
  resolveChangeLockTtlMs,
  startChangeLeaseHeartbeat,
} from './change-management/lease.js';
export {
  DEFAULT_CHANGE_ENFORCEMENT_MODE,
  evaluateServiceChangeCompatibility,
  loadServiceChangeCompatibility,
  resolveChangeEnforcementMode,
  resolveCurrentChangeEnvironment,
} from './change-management/version-gate.js';
export type {
  ChangeBlocking,
  ChangeEnforcementMode,
  ChangeEngine,
  ChangeEnvironment,
  ChangeHistoryEntry,
  ChangeHistoryStatus,
  ChangeKind,
  ChangeLifecycle,
  ChangeManifestEntry,
  ChangePhase,
  ChangeReleaseEvidenceField,
  ChangeReleaseEvidenceRefs,
  ChangeReversibility,
  ChangeScope,
  ChangeTrigger,
  ChangeValidationStatus,
  KnownChangeSurface,
  KnownChangeSurfaceDisposition,
  LegacyLedgerMapping,
  ManifestValidationIssue,
  ManifestValidationIssueCode,
  ManifestValidationResult,
  ServiceChangeRequirement,
} from './change-management/types.js';
export type { ChangeLeaseHeartbeatHandle, ChangeLeaseRecord } from './change-management/lease.js';
export type {
  ChangeCompatibilityIssue,
  ChangeGateOutcome,
  ServiceChangeCompatibilityResult,
} from './change-management/version-gate.js';

// ─── Governance ──────────────────────────────────────────────────────────────

export {
  GovernancePolicy,
  METRIC_REGISTRY,
  METRIC_SUMMARY_ALIAS,
} from './models/governance-policy.model.js';
export type { IGovernancePolicy, IGovernancePolicyRule } from './models/governance-policy.model.js';
export { GovernanceOverride } from './models/governance-override.model.js';
export type { IGovernanceOverride } from './models/governance-override.model.js';
export { GovernancePolicyVersion } from './models/governance-policy-version.model.js';
export type { IGovernancePolicyVersion } from './models/governance-policy-version.model.js';
