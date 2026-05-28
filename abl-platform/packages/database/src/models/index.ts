/**
 * Models barrel export
 *
 * Re-exports all Mongoose model definitions and their document interfaces.
 */

import mongoose from 'mongoose';

// NOTE: Do NOT call mongoose.deleteModel() here. ESM evaluates dependency
// modules (model files) BEFORE this barrel's body code runs. So model files
// register via mongoose.model() first, then this body would delete them —
// leaving zero registered models and causing buffering timeouts on every query.
//
// HMR re-evaluation (tsx watch / Turbopack) may trigger OverwriteModelError.
// Individual model files should guard against this with try/catch or
// mongoose.models[name] checks instead of a blanket deleteModel here.

// NOTE: leanIdPlugin is registered globally in mongo/base-document.ts
// (imported by every model file via uuidv7). ESM evaluates dependencies
// before the importing module, so the plugin is active before any model()
// calls — unlike this barrel file where re-exports hoist before body code.

// ─── Connection helper ──────────────────────────────────────────────────
// Uses the SAME mongoose instance as the models below, guaranteeing that
// queries run on the connected instance (avoids buffering timeouts in Next.js
// where webpack may bundle a separate mongoose for route handlers).

let _connectPromise: Promise<void> | null = null;
let _autoConnectSuppressed = false;

async function ensureSharedAuditTTLIndexOnConnectedMongoose(): Promise<void> {
  const { ensureAuditLogTTLIndex } = await import('./audit-log.model.js');
  await ensureAuditLogTTLIndex();
}

/**
 * Suppress the auto-connect that fires when this barrel is first imported.
 * Call this BEFORE importing any models if your app manages its own MongoDB
 * connection (e.g. via MongoConnectionManager with a different connection string).
 */
export function suppressAutoConnect(): void {
  _autoConnectSuppressed = true;
}

export async function ensureConnected(url?: string): Promise<void> {
  // App opted out of auto-connect (manages its own connection).
  // _autoConnectSuppressed: runtime flag set before importing models
  // MONGODB_MANAGED=true: service uses MongoConnectionManager with proper replica set options
  // SEARCH_AI_MONGO_URL: search-ai services use a separate connection string
  if (
    _autoConnectSuppressed ||
    process.env.MONGODB_MANAGED === 'true' ||
    process.env.SEARCH_AI_MONGO_URL
  )
    return;
  // Already connected
  if (mongoose.connection.readyState === 1) {
    await ensureSharedAuditTTLIndexOnConnectedMongoose();
    return;
  }
  // Connection in progress
  if (_connectPromise) return _connectPromise;

  const mongoUrl =
    url ||
    process.env.MONGODB_URL ||
    process.env.MONGODB_URI ||
    'mongodb://localhost:27018/abl_platform';

  _connectPromise = mongoose
    .connect(mongoUrl)
    .then(async () => {
      await ensureSharedAuditTTLIndexOnConnectedMongoose();
      _connectPromise = null;
    })
    .catch((err) => {
      _connectPromise = null;
      throw err;
    });

  return _connectPromise;
}

// ─── Users & Auth ────────────────────────────────────────────────────────

export { User, type IUser } from './user.model.js';
export { PlatformAdmin, type IPlatformAdmin } from './platform-admin.model.js';
export {
  PlatformAllowedDomain,
  type IPlatformAllowedDomain,
} from './platform-allowed-domain.model.js';
export {
  PlatformAllowedEmail,
  type IPlatformAllowedEmail,
  type PlatformAllowedEmailStatus,
} from './platform-allowed-email.model.js';
export {
  PlatformAccessRequest,
  type IPlatformAccessRequest,
} from './platform-access-request.model.js';
export { RefreshToken, type IRefreshToken } from './refresh-token.model.js';
export {
  EmailVerificationToken,
  type IEmailVerificationToken,
} from './email-verification-token.model.js';
export { PasswordResetToken, type IPasswordResetToken } from './password-reset-token.model.js';

// ─── Organizations ───────────────────────────────────────────────────────

export { Organization, type IOrganization } from './organization.model.js';
export { OrgMember, type IOrgMember } from './org-member.model.js';
export { TenantTransfer, type ITenantTransfer } from './tenant-transfer.model.js';

// ─── Tenants ─────────────────────────────────────────────────────────────

export { Tenant, type ITenant } from './tenant.model.js';
export { TenantMember, type ITenantMember } from './tenant-member.model.js';
export { WorkspaceInvitation, type IWorkspaceInvitation } from './workspace-invitation.model.js';

// ─── Arch AI ────────────────────────────────────────────────────────────

export { ArchSession, type IArchSession } from './arch-session.model.js';
export {
  ArchBlueprint,
  type IArchBlueprint,
  type ArchBlueprintState,
} from './arch-blueprint.model.js';
export {
  ArchIntegrationDraft,
  type IArchIntegrationDraft,
  type ArchIntegrationDraftSource,
  type ArchIntegrationDraftStatus,
  ARCH_INTEGRATION_DRAFT_SOURCES,
  ARCH_INTEGRATION_DRAFT_STATUSES,
} from './arch-integration-draft.model.js';
export { ArchJournal, type IArchJournal } from './arch-journal.model.js';
export { ArchSpecDocument, type IArchSpecDocument } from './arch-spec-document.model.js';
export {
  ArchSessionAttachment,
  type IArchSessionAttachment,
  type IArchSessionAttachmentModel,
} from './arch-session-attachment.model.js';
export { SessionFile, type ISessionFile, type ISessionFileModel } from './session-file.model.js';

// ─── User Preferences ───────────────────────────────────────────────────

export { UserPreferences, type IUserPreferences } from './user-preferences.model.js';

// ─── Projects ────────────────────────────────────────────────────────────

export { Project, type IProject } from './project.model.js';
export { ProjectAgent, type IProjectAgent } from './project-agent.model.js';
export { AgentVersion, type IAgentVersion } from './agent-version.model.js';
export { ProjectMember, type IProjectMember } from './project-member.model.js';
export { ModelConfig, type IModelConfig } from './model-config.model.js';
export { AgentModelConfig, type IAgentModelConfig } from './agent-model-config.model.js';
export { ProjectLLMConfig, type IProjectLLMConfig } from './project-llm-config.model.js';
export {
  ProjectSettings,
  type IProjectSettings,
  type IProjectMemorySettings,
  type IProjectSdkDefaults,
  type IPublicApiAccessSettings,
  type IPublicApiAccessScopeConfig,
  type IPublicApiAccessRateLimits,
} from './project-settings.model.js';
export {
  ProjectSettingsVersion,
  type IProjectSettingsVersion,
  type IProjectSettingsVersionSettings,
} from './project-settings-version.model.js';
export {
  ProjectRuntimeConfig,
  type IProjectRuntimeConfig,
  type IExtractionConfig,
  type IMultiIntentConfig,
  type IInferenceConfig,
  type IConversionConfig,
  type ILookupTableEntry,
} from './project-runtime-config.model.js';
export { LookupEntry, type ILookupEntry } from './lookup-entry.model.js';
export { ServiceNode, type IServiceNode } from './service-node.model.js';

// ─── Ownership & Teams ──────────────────────────────────────────────────

export {
  AgentOwnership,
  type IAgentOwnership,
  type IPermissionGrant,
} from './agent-ownership.model.js';
export { Team, type ITeam, type ITeamMember } from './team.model.js';
export { AgentLock, type IAgentLock } from './agent-lock.model.js';

// ─── Git Integration ────────────────────────────────────────────────────

export {
  GitIntegration,
  type IGitIntegration,
  type IGitSyncConfig,
} from './git-integration.model.js';
export {
  GitSyncHistory,
  type IGitSyncHistory,
  type IChangesSummary,
  type IConflictDetail,
} from './git-sync-history.model.js';
export {
  GitWebhookCleanupJob,
  type IGitWebhookCleanupJob,
  type GitWebhookCleanupOperation,
  type GitWebhookCleanupStatus,
} from './git-webhook-cleanup-job.model.js';

// ─── Modules ────────────────────────────────────────────────────────────

export {
  ModuleRelease,
  type IModuleRelease,
  type ModuleReleaseArtifact,
  type ModuleReleaseContract,
} from './module-release.model.js';
export {
  ModuleEnvironmentPointer,
  type IModuleEnvironmentPointer,
} from './module-environment-pointer.model.js';
export {
  ProjectModuleDependency,
  type IProjectModuleDependency,
  type ModuleDependencySelector,
} from './project-module-dependency.model.js';
export {
  DeploymentModuleSnapshot,
  type IDeploymentModuleSnapshot,
} from './deployment-module-snapshot.model.js';

// ─── Deployments ─────────────────────────────────────────────────────────

export { Deployment, type IDeployment } from './deployment.model.js';

// ─── RBAC ────────────────────────────────────────────────────────────────

export { RoleDefinition, type IRoleDefinition } from './role-definition.model.js';
export { ResourcePermission, type IResourcePermission } from './resource-permission.model.js';
export { ResourceType, type IResourceType } from './resource-type.model.js';

// ─── Conversations ───────────────────────────────────────────────────────

export {
  Session,
  type ISession,
  type ISessionSdkPrincipal,
  type ISessionVerifiedIdentity,
  type ISessionAttachedParticipant,
  type ISessionLiveSyncState,
  type KnownSessionSource,
} from './session.model.js';
export { Message, type IMessage } from './message.model.js';
export {
  SDKBootstrapArtifactNonce,
  type ISDKBootstrapArtifactNonce,
} from './sdk-bootstrap-artifact-nonce.model.js';
export {
  SessionState,
  type ISessionState,
  type ISessionStateThread,
  type ISessionStateResolutionKey,
} from './session-state.model.js';

// ─── Attachments ────────────────────────────────────────────────────────

export { Attachment, type IAttachment } from './attachment.model.js';
export {
  TenantAttachmentConfig,
  type ITenantAttachmentConfig,
} from './tenant-attachment-config.model.js';
export { DemoVisionConfig, type IDemoVisionConfig } from './demo-vision-config.model.js';

// ─── Contacts & Workflows ────────────────────────────────────────────────

export {
  Contact,
  type IContact,
  type IContactIdentity,
  type IChannelHistoryEntry,
  type ISourceIdentity,
  type IAclDirectGroup,
  type IContactAcl,
} from './contact.model.js';
export { AclGroupHierarchy, type IAclGroupHierarchy } from './acl-group-hierarchy.model.js';
export {
  AclDocumentPermissions,
  type IAclDocumentPermissions,
  type IAllowedUser,
  type IAllowedGroup,
} from './acl-document-permissions.model.js';
export {
  MergeSuggestion,
  type IMergeSuggestion,
  type IOverlapIdentity,
} from './merge-suggestion.model.js';
export {
  ContactCapabilityConsent,
  type IContactCapabilityConsent,
} from './contact-capability-consent.model.js';
export {
  OmnichannelProjectSettings,
  type IOmnichannelProjectSettings,
} from './omnichannel-project-settings.model.js';
export {
  Workflow,
  type IWorkflow,
  type IWorkflowNode,
  type IWorkflowEdge,
  type IWorkflowDeployment,
  type IWorkflowNodePosition,
  type IAsyncPushConfig,
  type WorkflowNodeType,
  type WorkflowStatus,
  type WorkflowDeploymentMode,
  WORKFLOW_NODE_TYPES,
  WORKFLOW_STATUSES,
  WORKFLOW_DEPLOYMENT_MODES,
} from './workflow.model.js';
export {
  WorkflowVersion,
  type IWorkflowVersion,
  type IWorkflowVersionDefinition,
  type IWorkflowVersionTrigger,
  type WorkflowVersionState,
} from './workflow-version.model.js';
export {
  HumanTask,
  type IHumanTask,
  type IHumanTaskFieldDef,
  type IHumanTaskSource,
  type IHumanTaskResponse,
  type HumanTaskType,
  type HumanTaskMailbox,
  type HumanTaskStatus,
  type HumanTaskPriority,
} from './human-task.model.js';

// ─── Connectors & Workflow Integrations ──────────────────────────────────

export { ConnectorConnection, type IConnectorConnection } from './connector-connection.model.js';
export { ConnectorConfig, type IConnectorConfig } from './connector-config.model.js';
export { ConnectorDiscovery, type IConnectorDiscovery } from './connector-discovery.model.js';
export {
  ConnectorRecommendation,
  type IConnectorRecommendation,
} from './connector-recommendation.model.js';
export { TriggerRegistration, type ITriggerRegistration } from './trigger-registration.model.js';
export { ConnectorKVStore, type IConnectorKVStore } from './connector-kv-store.model.js';
export {
  WorkflowExecution,
  type IWorkflowExecution,
  type ExecutionStatus,
  EXECUTION_STATUSES,
} from './workflow-execution.model.js';
export {
  WorkflowEventOutboxModel,
  type WorkflowEventOutboxDoc,
} from './workflow-event-outbox.model.js';
// ─── API Keys ────────────────────────────────────────────────────────────

export { ApiKey, type IApiKey } from './api-key.model.js';
export {
  PublicApiKey,
  normalizePublicApiKeyAllowedOrigins,
  normalizePublicApiKeyPermissions,
  type IPublicApiKey,
  type PublicApiKeyPermissions,
} from './public-api-key.model.js';

// ─── SDK ─────────────────────────────────────────────────────────────────

export { SDKChannel, type ISDKChannel, type SDKChannelAuthMode } from './sdk-channel.model.js';
export { WidgetConfig, type IWidgetConfig } from './widget-config.model.js';
export { DebugToken, type IDebugToken } from './debug-token.model.js';
export { DeviceAuthRequest, type IDeviceAuthRequest } from './device-auth-request.model.js';

// ─── Channels ────────────────────────────────────────────────────────────

export { ChannelConnection, type IChannelConnection } from './channel-connection.model.js';
export { ChannelSession, type IChannelSession } from './channel-session.model.js';
export { WebhookSubscription, type IWebhookSubscription } from './webhook-subscription.model.js';
export {
  WebhookSubscriptionConnector,
  type IWebhookSubscriptionConnector,
} from './webhook-subscription-connector.model.js';
export { WebhookDelivery, type IWebhookDelivery } from './webhook-delivery.model.js';

// ─── Suspensions ─────────────────────────────────────────────────────────

export { Suspension, type ISuspension } from './suspension.model.js';

// ─── LLM Config ──────────────────────────────────────────────────────────

export { LLMCredential, type ILLMCredential } from './llm-credential.model.js';
export { TenantLLMPolicy, type ITenantLLMPolicy } from './tenant-llm-policy.model.js';
export { TenantModel, type ITenantModel } from './tenant-model.model.js';
export {
  TenantServiceInstance,
  type ITenantServiceInstance,
} from './tenant-service-instance.model.js';

// ─── Guardrails ─────────────────────────────────────────────────────────

export {
  GuardrailPolicy,
  type IGuardrailPolicy,
  type IGuardrailPolicyScope,
  type IGuardrailProviderOverride,
  type IGuardrailRule,
  type IConstitutionPrinciple,
  type IGuardrailStreamingSettings,
  type IGuardrailSettings,
  type IGuardrailCaching,
  type IGuardrailBudget,
} from './guardrail-policy.model.js';
export {
  TenantGuardrailProviderConfig,
  GUARDRAIL_ADAPTER_TYPES,
  IMPLEMENTED_GUARDRAIL_ADAPTER_TYPES,
  type GuardrailAdapterType,
  type ImplementedGuardrailAdapterType,
  type ITenantGuardrailProviderConfig,
  type ISelfHostedConfig,
  type ICustomMapping,
  type ICircuitBreakerConfig,
  type IRetryConfig,
  type ILastHealthCheck,
} from './guardrail-provider-config.model.js';

// ─── Auth Profiles ──────────────────────────────────────────────────────

export {
  AuthProfile,
  type IAuthProfile,
  type AuthProfileAuthType,
  type AuthProfileStatus,
  type AuthProfileScope,
  type AuthProfileVisibility,
  type AuthProfileConnectionMode,
  type AuthProfileProfileType,
  AUTH_PROFILE_AUTH_TYPES,
  AUTH_PROFILE_STATUSES,
  AUTH_PROFILE_SCOPES,
  AUTH_PROFILE_VISIBILITIES,
  AUTH_PROFILE_CONNECTION_MODES,
  AUTH_PROFILE_PROFILE_TYPES,
} from './auth-profile.model.js';

export {
  AuthProfileAuditEvent,
  type IAuthProfileAuditEvent,
  type IActorContext,
  type AuthProfileAuditEventType,
  AUTH_PROFILE_AUDIT_EVENT_TYPES,
} from './auth-profile-audit-event.model.js';

// ─── Security ────────────────────────────────────────────────────────────

export { EndUserOAuthToken, type IEndUserOAuthToken } from './end-user-oauth-token.model.js';
export {
  SessionOAuthArtifact,
  type ISessionOAuthArtifact,
} from './session-oauth-artifact.model.js';
export { OrgProxyConfig, type IOrgProxyConfig } from './org-proxy-config.model.js';
export { KeyVersion, type IKeyVersion } from './key-version.model.js';

// ─── Environment Variables ──────────────────────────────────────────────

export { EnvironmentVariable, type IEnvironmentVariable } from './environment-variable.model.js';

// ─── Prompt Templates ───────────────────────────────────────────────────

export { PromptTemplate, type IPromptTemplate } from './prompt-template.model.js';

// ─── Project Config Variables ───────────────────────────────────────────

export {
  ProjectConfigVariable,
  type IProjectConfigVariable,
} from './project-config-variable.model.js';

// ─── Tool Secrets (Legacy — being migrated to AuthProfile) ──────────────
export { ToolSecret, type IToolSecret } from './tool-secret.model.js';

// ─── Variable Namespaces ────────────────────────────────────────────────

export { VariableNamespace, type IVariableNamespace } from './variable-namespace.model.js';
export {
  VariableNamespaceMembership,
  type IVariableNamespaceMembership,
} from './variable-namespace-membership.model.js';
export {
  DeploymentVariableSnapshot,
  type IDeploymentVariableSnapshot,
  type ISnapshotEnvVar,
  type ISnapshotConfigVar,
} from './deployment-variable-snapshot.model.js';

// ─── KMS ────────────────────────────────────────────────────────────────

export {
  TenantKMSConfig,
  type ITenantKMSConfig,
  type IKMSProviderRef,
  type IKMSEnvironmentOverride,
  type IKMSProjectOverride,
} from './tenant-kms-config.model.js';
export {
  MaterializedKMSConfig,
  type IMaterializedKMSConfig,
  type IResolvedProviderRef,
} from './materialized-kms-config.model.js';
export { DEKEntry, generateDekId, type IDEKEntry } from './dek-registry.model.js';

// ─── Compliance ──────────────────────────────────────────────────────────

export { DeletionRequest, type IDeletionRequest } from './deletion-request.model.js';
export { ArchiveManifest, type IArchiveManifest } from './archive-manifest.model.js';

// ─── Billing ─────────────────────────────────────────────────────────────

export {
  Subscription,
  type ISubscription,
  type IBillingUnitPolicy,
  type IBillingUnitPolicyOverrides,
  type IBillingInteractionThreshold,
  type IBillingAddonPolicy,
  type IBillingMaterializationPolicy,
  type BillingMaterializationBasis,
  type BillingAddonMode,
} from './subscription.model.js';
export {
  BillingReplayRun,
  type IBillingReplayChannelBreakdown,
  type IBillingReplayProjectBreakdown,
  type IBillingReplayRequest,
  type IBillingReplayRun,
  type IBillingReplayScope,
  type IBillingReplaySummary,
} from './billing-replay-run.model.js';
export {
  BillingReplaySessionResult,
  type BillingReplayMetricsSource,
  type IBillingReplaySessionResult,
} from './billing-replay-session-result.model.js';
export {
  BillingMaterializationBatch,
  type IBillingMaterializationBatch,
  type IBillingMaterializationChannelBreakdown,
  type IBillingMaterializationProjectBreakdown,
  type IBillingMaterializationRequest,
  type IBillingMaterializationScope,
  type IBillingMaterializationSummary,
} from './billing-materialization-batch.model.js';
export {
  BillingMaterializationApplication,
  type BillingMaterializationApplicationStatus,
  type BillingMaterializationApplicationTriggerSource,
  type BillingMaterializationApplicationDealMatchType,
  type BillingMaterializationProjectionStatus,
  type IBillingMaterializationApplication,
  type IBillingMaterializationApplicationDealResolution,
  type IBillingMaterializationApplicationAccountingPeriod,
  type IBillingMaterializationApplicationProjectionTarget,
  type IBillingMaterializationApplicationProjection,
} from './billing-materialization-application.model.js';
export {
  BillingMaterializationSessionResult,
  type BillingMaterializationSessionMetricsSource,
  type BillingMaterializationTriggerSource,
  type IBillingMaterializationSessionResult,
} from './billing-materialization-session-result.model.js';
export {
  BillingMaterializationCheckpoint,
  type IBillingMaterializationCheckpoint,
  type IBillingMaterializationCheckpointCursor,
} from './billing-materialization-checkpoint.model.js';
export {
  BillingUsagePublishedSession,
  type IBillingUsagePublishedSession,
} from './billing-usage-published-session.model.js';
export { Deal, type IDeal } from './deal.model.js';
export { CreditLedger, type ICreditLedger } from './credit-ledger.model.js';
export { BillingLineItem, type IBillingLineItem } from './billing-line-item.model.js';

// ─── Alerts ──────────────────────────────────────────────────────────────

export { AlertConfig, type IAlertConfig } from './alert-config.model.js';

// ─── Knowledge ───────────────────────────────────────────────────────────

export { KnowledgeBase, type IKnowledgeBase } from './knowledge-base.model.js';
export { ResourceGroup, type IResourceGroup } from './resource-group.model.js';
export { Fact, type IFact } from './fact.model.js';

// ─── Tools ──────────────────────────────────────────────────────────

export {
  ProjectTool,
  type IProjectTool,
  type ProjectToolType,
  PROJECT_TOOL_TYPES,
} from './project-tool.model.js';
export {
  ToolTestEndpoint,
  type IToolTestEndpoint,
  type ToolTestEndpointStatus,
  type ToolTestResponseMode,
  TOOL_TEST_ENDPOINT_STATUSES,
  TOOL_TEST_RESPONSE_MODES,
} from './tool-test-endpoint.model.js';

// ─── MCP Servers ────────────────────────────────────────────────────

export { MCPServerConfig, type IMCPServerConfig } from './mcp-server-config.model.js';

// ─── External Agents ────────────────────────────────────────────────

export { ExternalAgentConfig, type IExternalAgentConfig } from './external-agent-config.model.js';

// ─── Search AI ───────────────────────────────────────────────────────

export { SearchIndex, type ISearchIndex, type ICitationConfig } from './search-index.model.js';
export {
  SearchSource,
  type ISearchSource,
  type ICrawlConfig,
  type ICrawlConfigProfile,
  type ICrawlConfigSection,
  type ICrawlConfigSettings,
  type ICrawlConfigAuth,
  type ICrawlConfigGroupStrategy,
  type CrawlConfigWizardStep,
  type CrawlConfigStrategy,
  type CrawlConfigAuthMethod,
} from './search-source.model.js';
export { SearchDocument, type ISearchDocument } from './search-document.model.js';
export { DocumentPage, type IDocumentPage } from './document-page.model.js';
// KG extended types
export {
  SearchChunk,
  type ISearchChunk,
  type IEntityExtraction,
  type IKGState,
  type IChunkClassification,
} from './search-chunk.model.js';
export { ChunkHierarchy, type IChunkHierarchy } from './chunk-hierarchy.model.js';
export { ChunkQuestion, type IChunkQuestion } from './chunk-question.model.js';
export { ChunkScope, type IChunkScope } from './chunk-scope.model.js';
export {
  ConnectorSchema,
  type IConnectorSchema,
  type IConnectorSchemaField,
} from './connector-schema.model.js';
export { SchemaChangeLog, type ISchemaChangeLog } from './schema-change-log.model.js';
export {
  CanonicalSchema,
  type ICanonicalSchema,
  type ICanonicalField,
} from './canonical-schema.model.js';
export { FieldMapping, type IFieldMapping, type IFieldTransform } from './field-mapping.model.js';
export {
  DomainVocabulary,
  type IDomainVocabulary,
  type IVocabularyEntry,
} from './domain-vocabulary.model.js';
export {
  DiscoveredSchema,
  type IDiscoveredSchema,
  type IDiscoveredSchemaField,
} from './discovered-schema.model.js';
export { CapabilityRegistry, type ICapability } from './capability-registry.model.js';
export {
  KnowledgeGraphTaxonomy,
  type IKnowledgeGraphTaxonomy,
  type IKGDomain,
  type IKGCategory,
  type IKGProduct,
  type IKGAttribute,
  type IKGDepartmentBoundary,
} from './knowledge-graph-taxonomy.model.js';
export {
  KnowledgeGraphDomain,
  type IKnowledgeGraphDomain,
} from './knowledge-graph-domain.model.js';
export {
  AttributeRegistry,
  type IAttributeRegistry,
  type AttributeTier,
} from './attribute-registry.model.js';
export { AttributeMergeEvent, type IAttributeMergeEvent } from './attribute-merge-event.model.js';
export {
  VocabularyCandidates,
  type IVocabularyCandidates,
  type ITermCandidate,
} from './vocabulary-candidates.model.js';
export {
  SearchPipelineDefinition,
  type ISearchPipelineDefinition,
  type ISearchPipelineFlow,
  type IActiveEmbeddingConfig,
  type ISearchPipelineStage,
  type ISearchRuleCondition,
  type ISearchValidationError,
  type SearchPipelineStageType,
  type SearchRuleConditionType,
  type EmbeddingProviderType,
} from './search-pipeline-definition.model.js';
export {
  JobExecution,
  type IJobExecution,
  type IJobExecutionError,
  type WorkerStage,
  type JobExecutionStatus,
} from './job-execution.model.js';

// ─── Crawler (Web Crawl) ────────────────────────────────────────────────────

export { CrawlJob, type ICrawlJob } from './crawl-job.model.js';
export { CrawlError, type ICrawlError, type CrawlErrorType } from './crawl-error.model.js';
export { CrawlHistory, type ICrawlHistory } from './crawl-history.model.js';
export type { ICrawlAuditEvent } from '../types/crawl-audit-event.js';
export {
  CrawlPattern,
  type ICrawlPattern,
  type ICrawlPatternInput,
  type ICrawlPatternCrawlUpdate,
} from './crawl-pattern.model.js';
export { TenantCrawlPolicy, type ITenantCrawlPolicy } from './tenant-crawl-policy.model.js';
export { UserCrawlPreference, type IUserCrawlPreference } from './user-crawl-preference.model.js';
export {
  HandlerTemplate,
  type IHandlerTemplate,
  type IHandlerTemplateHandler,
  type IHandlerTemplateStep,
  type IHandlerTemplateExtractionSelectors,
} from './handler-template.model.js';

// ─── Source Config State & URL Buckets (Draft Elimination) ───────────────

export {
  SourceConfigState,
  type ISourceConfigState,
  type DiscoveryStatusValue,
} from './source-config-state.model.js';
export {
  SourceUrlBucket,
  SOURCE_URL_BUCKET_SIZE,
  type ISourceUrlBucket,
  type ISourceBucketUrl,
} from './source-url-bucket.model.js';

// ─── Discovery (Web Crawl) ──────────────────────────────────────────────

export {
  SiteDiscovery,
  siteDiscoverySchema,
  type ISiteDiscovery,
  type IDiscoveredPage,
  type ITreeNode,
  type ISiteProfile,
} from './site-discovery.model.js';

export {
  TenantDiscovery,
  tenantDiscoverySchema,
  type ITenantDiscovery,
} from './tenant-discovery.model.js';

// ─── Arch AI ────────────────────────────────────────────────────────

export {
  ArchConversation,
  type IArchConversation,
  type IArchMessage,
} from './arch-conversation.model.js';

export { ArchWorkspaceConfig, type IArchWorkspaceConfig } from './arch-workspace-config.model.js';

export {
  ArchProjectMemory,
  type IArchProjectMemory,
  type IProjectMemoryEntry,
  type ProjectMemoryType,
  type ProjectMemorySource,
} from './arch-project-memory.model.js';

export {
  ArchLearningMemory,
  type IArchLearningMemory,
  type LearningMemoryType,
} from './arch-learning-memory.model.js';

// ─── Import Operations ──────────────────────────────────────────────────

export {
  ImportOperation,
  type IImportOperation,
  type ImportPhase,
  type LayerImportStatus,
  type IImportOperationLayer,
  type IImportOperationError,
  STUCK_OPERATION_THRESHOLD_MS,
  COMPLETED_OPERATION_TTL_SECONDS,
} from './import-operation.model.js';

// ─── Evaluations ────────────────────────────────────────────────────────

export { EvalPersona, type IEvalPersona } from './eval-persona.model.js';
export { EvalScenario, type IEvalScenario } from './eval-scenario.model.js';
export {
  EvalEvaluator,
  type IEvalEvaluator,
  type IScoringRubric,
  type IScoringRubricPoint,
  type IBiasSettings,
} from './eval-evaluator.model.js';
export { EvalSet, type IEvalSet } from './eval-set.model.js';
export {
  EvalRun,
  type IEvalRun,
  type IEvalRunSummary,
  type IEvalRegressionDetail,
} from './eval-run.model.js';
export { EvalHumanReview, type IEvalHumanReview } from './eval-human-review.model.js';

// ─── Metrics & Audit ─────────────────────────────────────────────────────

export { LLMUsageMetric, type ILLMUsageMetric } from './llm-usage-metric.model.js';
export { OrgProfileMetric, type IOrgProfileMetric } from './org-profile-metric.model.js';
export { AuditLog, type IAuditLog } from './audit-log.model.js';

// ─── PII Audit ──────────────────────────────────────────────────────────

export { PIIAuditLog, type IPIIAuditLog } from './pii-audit-log.model.js';
export {
  PIITokenVault,
  DEFAULT_PII_TOKEN_VAULT_RETENTION_DAYS,
  PII_TOKEN_SOURCE_SURFACES,
  type IPIITokenVault,
  type PIITokenSourceSurface,
} from './pii-token-vault.model.js';
export {
  PIIPattern,
  type IPIIPattern,
  type IPIIPatternRedaction,
  type IPIIPatternMaskConfig,
  type IPIIPatternRandomConfig,
  type IPIIPatternConsumerAccess,
} from './pii-pattern.model.js';

// ─── Template Store ────────────────────────────────────────────────────

export {
  Template,
  type ITemplate,
  type ITemplateMedia,
  type ITemplatePrerequisites,
  type IDemoConversationMessage,
} from './template.model.js';
export { TemplateVersion, type ITemplateVersion } from './template-version.model.js';
export {
  TemplateAnalyticsEvent,
  type ITemplateAnalyticsEvent,
} from './template-analytics-event.model.js';

// ─── Encryption ─────────────────────────────────────────────────────────
// Re-export setMasterKey from the SAME module context as the models.
// This ensures the encryption plugin's masterKeyBuffer is set on the
// same copy that the model schemas use (critical for Next.js webpack
// dual-instance scenarios where route handlers get a separate bundle).
export {
  setMasterKey,
  setEncryptionFacade,
  isFacadeEncryptionAvailable,
  _resetEncryptionStateForTesting,
} from '../mongo/plugins/encryption.plugin.js';

// ─── Prompt Library ──────────────────────────────────────────────────────

export {
  PromptLibraryItem,
  type IPromptLibraryItem,
  type PromptLibraryItemStatus,
} from './prompt-library-item.model.js';
export {
  PromptLibraryVersion,
  computeSourceHash,
  type IPromptLibraryVersion,
  type PromptLibraryVersionStatus,
} from './prompt-library-version.model.js';

// ─── Governance ──────────────────────────────────────────────────────────

export {
  GovernancePolicy,
  METRIC_REGISTRY,
  METRIC_SUMMARY_ALIAS,
  type IGovernancePolicy,
  type IGovernancePolicyRule,
} from './governance-policy.model.js';
export { GovernanceOverride, type IGovernanceOverride } from './governance-override.model.js';
export {
  GovernancePolicyVersion,
  type IGovernancePolicyVersion,
} from './governance-policy-version.model.js';

// ─── Agentic Compat ────────────────────────────────────────────────────

export { AgentAssistBinding, type IAgentAssistBinding } from './agent-assist-binding.model.js';

export {
  ProjectAgentAssistSettings,
  type IProjectAgentAssistSettings,
} from './project-agent-assist-settings.model.js';

// ─── Auto-connect ───────────────────────────────────────────────────────
// When this barrel is loaded, kick off a connection on the SAME mongoose
// instance that compiled the models above.  Queries issued before the
// connection completes are buffered by mongoose (default 10 s timeout).
// This handles the Next.js webpack dual-instance problem: each bundled
// copy gets its own mongoose connected automatically.
//
// Skip auto-connect in test environments where tests use mocked models
// or explicitly call ensureConnected() with test database URLs.
if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
  ensureConnected().catch(() => {});
}
