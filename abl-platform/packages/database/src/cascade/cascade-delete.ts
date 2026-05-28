/**
 * Cascade Delete Helpers
 *
 * Application-level cascade delete functions for MongoDB.
 * Deletes deepest children first, working upward to the parent.
 * Returns per-model deletion counts for audit trail.
 *
 * IMPORTANT: AuditLog records are ANONYMIZED, never deleted (GDPR compliance).
 * PIIAuditLog leaf records are deleted during tenant/project erasure.
 *
 * NOTE: PlatformAccessRequest, PlatformAdmin, PlatformAllowedDomain are platform-level
 * (not tenant-scoped) and are intentionally excluded from tenant cascade. PlatformAccessRequest
 * records expire automatically via TTL (90 days after notification). For user-level right-to-erasure
 * requests, PlatformAccessRequest records keyed by email must also be deleted by the erasure handler.
 */

import { getEventCascadeHook } from './event-cascade-hooks.js';

export interface CascadeDeleteResult {
  /** Per-model deletion counts */
  counts: Record<string, number>;
  /** Total documents deleted */
  total: number;
  /** Models that were anonymized instead of deleted */
  anonymized: Record<string, number>;
}

/**
 * Error thrown when a module project cannot be deleted because active
 * consumer dependencies exist. Callers should map this to HTTP 409.
 */
export class CascadeDeleteBlockedError extends Error {
  public readonly code = 'MODULE_DELETE_BLOCKED';
  /**
   * Internal-only: IDs of consumer projects blocking deletion.
   * WARNING: Do NOT serialize this to HTTP responses — it leaks other projects' IDs.
   * Route handlers should return only the count, not the IDs.
   */
  public readonly consumerProjectIds: string[];

  constructor(consumerProjectIds: string[]) {
    super(
      `Cannot delete module project: ${consumerProjectIds.length} consumer project(s) depend on it`,
    );
    this.name = 'CascadeDeleteBlockedError';
    this.consumerProjectIds = consumerProjectIds;
  }
}

/**
 * Delete a tenant and all its children.
 * Deepest-first: Messages → Sessions → AgentVersions → ProjectAgents → etc.
 */
export async function deleteTenant(tenantId: string): Promise<CascadeDeleteResult> {
  const {
    Session,
    Message,
    Project,
    ProjectAgent,
    AgentVersion,
    Deployment,
    Contact,
    TenantMember,
    ApiKey,
    Workflow,
    LLMUsageMetric,
    DeletionRequest,
    SDKChannel,
    LLMCredential,
    PublicApiKey,
    WidgetConfig,
    Fact,
    AuditLog,
    PIIAuditLog,
    PIITokenVault,
    Tenant,
    ProjectMember,
    Attachment,
    ConnectorConnection,
    AuthProfile,
    AuthProfileAuditEvent,
    EndUserOAuthToken,
    DeploymentModuleSnapshot,
    ProjectModuleDependency,
    ModuleEnvironmentPointer,
    ModuleRelease,
    ContactCapabilityConsent,
    OmnichannelProjectSettings,
    WorkflowExecution,
    HumanTask,
    WorkflowEventOutboxModel,
    PromptLibraryVersion,
    PromptLibraryItem,
    ExternalAgentConfig,
    MCPServerConfig,
    ProjectRuntimeConfig,
    ProjectLLMConfig,
    ModelConfig,
    AgentModelConfig,
    TriggerRegistration,
  } = await import('../models/index.js');
  const { GovernancePolicyVersion, GovernanceOverride, GovernancePolicy } =
    await import('../models/index.js');

  const counts: Record<string, number> = {};
  const anonymized: Record<string, number> = {};

  // Find all projects for this tenant
  const projects = await Project.find({ tenantId }, { _id: 1 }).lean();
  const projectIds = projects.map((p: any) => p._id);

  // Find all project agents
  const agents = await ProjectAgent.find({ projectId: { $in: projectIds } }, { _id: 1 }).lean();
  const agentIds = agents.map((a: any) => a._id);

  // Find all sessions
  const sessions = await Session.find({ tenantId }, { _id: 1 }).lean();
  const sessionIds = sessions.map((s: any) => s._id);

  // Level 3: deepest children
  counts.Attachment = (
    await Attachment.deleteMany({ sessionId: { $in: sessionIds } })
  ).deletedCount;
  counts.Message = (await Message.deleteMany({ sessionId: { $in: sessionIds } })).deletedCount;
  counts.LLMUsageMetric = (
    await LLMUsageMetric.deleteMany({ sessionId: { $in: sessionIds } })
  ).deletedCount;
  counts.Fact = (await Fact.deleteMany({ tenantId })).deletedCount;
  counts.PIIAuditLog = (await PIIAuditLog.deleteMany({ tenantId })).deletedCount;
  counts.PIITokenVault = (await PIITokenVault.deleteMany({ tenantId })).deletedCount;

  // Level 2: agent versions, deployments, sessions
  counts.AgentVersion = (
    await AgentVersion.deleteMany({ agentId: { $in: agentIds } })
  ).deletedCount;
  counts.Session = (await Session.deleteMany({ tenantId })).deletedCount;

  // Module entities: delete in dependency order (snapshots → deps → pointers → releases)
  counts.DeploymentModuleSnapshot = (
    await DeploymentModuleSnapshot.deleteMany({ tenantId })
  ).deletedCount;
  counts.ProjectModuleDependency = (
    await ProjectModuleDependency.deleteMany({ tenantId })
  ).deletedCount;
  counts.ModuleEnvironmentPointer = (
    await ModuleEnvironmentPointer.deleteMany({ tenantId })
  ).deletedCount;
  counts.ModuleRelease = (await ModuleRelease.deleteMany({ tenantId })).deletedCount;

  counts.Deployment = (await Deployment.deleteMany({ tenantId })).deletedCount;

  // Prompt Library: versions before items (versions reference promptId as FK)
  counts.PromptLibraryVersion = (await PromptLibraryVersion.deleteMany({ tenantId })).deletedCount;
  counts.PromptLibraryItem = (await PromptLibraryItem.deleteMany({ tenantId })).deletedCount;

  // Level 1: direct tenant children
  counts.ProjectAgent = (
    await ProjectAgent.deleteMany({ projectId: { $in: projectIds } })
  ).deletedCount;
  counts.ProjectMember = (
    await ProjectMember.deleteMany({ projectId: { $in: projectIds } })
  ).deletedCount;
  counts.PublicApiKey = (
    await PublicApiKey.deleteMany({ projectId: { $in: projectIds } })
  ).deletedCount;
  counts.WidgetConfig = (
    await WidgetConfig.deleteMany({ projectId: { $in: projectIds } })
  ).deletedCount;
  counts.SDKChannel = (await SDKChannel.deleteMany({ tenantId })).deletedCount;
  // Erase trigger registrations BEFORE workflows so right-to-erasure removes
  // the user-supplied webhook callback display token and any connector
  // `triggerParams` payload before the parent workflow row is gone (the
  // workflow doc also carries a denormalized copy of these fields under
  // `Workflow.triggers[].config` — handled by the Workflow.deleteMany below).
  counts.TriggerRegistration = (await TriggerRegistration.deleteMany({ tenantId })).deletedCount;
  counts.Workflow = (await Workflow.deleteMany({ tenantId })).deletedCount;
  counts.Contact = (await Contact.deleteMany({ tenantId })).deletedCount;
  counts.TenantMember = (await TenantMember.deleteMany({ tenantId })).deletedCount;
  counts.ApiKey = (await ApiKey.deleteMany({ tenantId })).deletedCount;
  counts.ConnectorConnection = (await ConnectorConnection.deleteMany({ tenantId })).deletedCount;
  counts.LLMCredential = (await LLMCredential.deleteMany({ tenantId })).deletedCount;
  counts.AuthProfileAuditEvent = (
    await AuthProfileAuditEvent.deleteMany({ tenantId })
  ).deletedCount;
  counts.AuthProfile = (await AuthProfile.deleteMany({ tenantId })).deletedCount;
  counts.EndUserOAuthToken = (await EndUserOAuthToken.deleteMany({ tenantId })).deletedCount;
  counts.ExternalAgentConfig = (await ExternalAgentConfig.deleteMany({ tenantId })).deletedCount;
  counts.MCPServerConfig = (await MCPServerConfig.deleteMany({ tenantId })).deletedCount;
  counts.ProjectRuntimeConfig = (await ProjectRuntimeConfig.deleteMany({ tenantId })).deletedCount;
  counts.ProjectLLMConfig = (await ProjectLLMConfig.deleteMany({ tenantId })).deletedCount;
  counts.ModelConfig = (await ModelConfig.deleteMany({ tenantId })).deletedCount;
  counts.AgentModelConfig = (await AgentModelConfig.deleteMany({ tenantId })).deletedCount;
  counts.DeletionRequest = (await DeletionRequest.deleteMany({ tenantId })).deletedCount;
  counts.Project = (await Project.deleteMany({ tenantId })).deletedCount;

  // Governance: config data — delete deepest first (versions → overrides → policies)
  counts.GovernancePolicyVersion = (
    await GovernancePolicyVersion.deleteMany({ tenantId })
  ).deletedCount;
  counts.GovernanceOverride = (await GovernanceOverride.deleteMany({ tenantId })).deletedCount;
  counts.GovernancePolicy = (await GovernancePolicy.deleteMany({ tenantId })).deletedCount;

  // AuditLog: anonymize, not delete (GDPR compliance)
  const auditResult = await AuditLog.updateMany(
    { tenantId },
    { $set: { userId: null, ip: null, metadata: { anonymized: true, anonymizedAt: new Date() } } },
  );
  anonymized.AuditLog = auditResult.modifiedCount;

  // Omnichannel: delete consent records and project settings
  counts.ContactCapabilityConsent = (
    await ContactCapabilityConsent.deleteMany({ tenantId })
  ).deletedCount;
  counts.OmnichannelProjectSettings = (
    await OmnichannelProjectSettings.deleteMany({ tenantId })
  ).deletedCount;

  // Workflow event-sourcing Mongo collections (LLD §4.7 — Phase 4).
  // Dropped here so tenant deletion is atomic across the 3 workflow
  // collections. CH-side workflow events are reaped by the eventstore
  // hook below (which the runtime wires to hit both raw + _latest tables).
  counts.WorkflowExecution = (await WorkflowExecution.deleteMany({ tenantId })).deletedCount;
  counts.HumanTaskWorkflow = (
    await HumanTask.deleteMany({ tenantId, mailbox: 'workflow' })
  ).deletedCount;
  counts.WorkflowEventOutbox = (
    await WorkflowEventOutboxModel.deleteMany({ tenantId })
  ).deletedCount;

  // EventStore: delete all events for this tenant
  const eventHook = getEventCascadeHook();
  if (eventHook) {
    try {
      await eventHook.deleteTenant(tenantId);
    } catch {
      // EventStore cleanup failure is non-fatal — MongoDB cascade still succeeds
    }
  }

  // Finally: the tenant itself
  counts.Tenant = (await Tenant.deleteMany({ _id: tenantId })).deletedCount;

  const total = Object.values(counts).reduce((sum, c) => sum + c, 0);
  return { counts, total, anonymized };
}

/**
 * Delete a project and all its children.
 * Handles two-path cascade logic for module projects vs consumer projects:
 *
 * Path A (module project): Blocks if active consumer dependencies exist (throws
 * CascadeDeleteBlockedError → 409). If zero consumers, deletes pointers and releases
 * before standard cascade. Does NOT delete consumer DeploymentModuleSnapshots.
 *
 * Path B (consumer project): Deletes ProjectModuleDependency and
 * DeploymentModuleSnapshot for this project before standard cascade.
 *
 * @param projectId - The project to delete
 * @param tenantId - Optional; resolved from Project doc if not provided (backward compatible)
 */
export async function deleteProject(
  projectId: string,
  tenantId?: string,
): Promise<CascadeDeleteResult> {
  const {
    Session,
    Message,
    ProjectAgent,
    AgentVersion,
    Deployment,
    Workflow,
    PublicApiKey,
    WidgetConfig,
    SDKChannel,
    Project,
    LLMUsageMetric,
    ProjectMember,
    Attachment,
    ConnectorConnection,
    AuthProfile,
    AuthProfileAuditEvent,
    EndUserOAuthToken,
    Fact,
    PIIAuditLog,
    PIITokenVault,
    VariableNamespaceMembership,
    VariableNamespace,
    DeploymentVariableSnapshot,
    EnvironmentVariable,
    ProjectConfigVariable,
    ModuleRelease,
    ModuleEnvironmentPointer,
    ProjectModuleDependency,
    DeploymentModuleSnapshot,
    AgentAssistBinding,
    ProjectAgentAssistSettings,
    ContactCapabilityConsent,
    OmnichannelProjectSettings,
    PromptLibraryVersion,
    PromptLibraryItem,
    ExternalAgentConfig,
    MCPServerConfig,
    ApiKey,
    ProjectRuntimeConfig,
    ProjectLLMConfig,
    ModelConfig,
    AgentModelConfig,
    ProjectSettings,
    ProjectSettingsVersion,
    TriggerRegistration,
  } = await import('../models/index.js');
  const { GovernancePolicyVersion, GovernanceOverride, GovernancePolicy } =
    await import('../models/index.js');
  const { WorkflowExecution, HumanTask, WorkflowEventOutboxModel } =
    await import('../models/index.js');

  const counts: Record<string, number> = {};

  // Find project's tenant and kind (needed for event cascade and module paths)
  // When tenantId is provided, scope the lookup to prevent cross-tenant access.
  const projectQuery = tenantId ? { _id: projectId, tenantId } : { _id: projectId };
  const projectDocs = await Project.find(projectQuery, { tenantId: 1, kind: 1 }).lean();
  const projectDoc = projectDocs[0] as any;
  const projectTenantId = tenantId ?? projectDoc?.tenantId;
  const projectKind: string | undefined = projectDoc?.kind;

  // ── Path A: Module project ──────────────────────────────────────────
  if (projectKind === 'module' && projectTenantId) {
    // Block if active consumer dependencies exist
    const consumerDepCount = await ProjectModuleDependency.countDocuments({
      tenantId: projectTenantId,
      moduleProjectId: projectId,
    });
    if (consumerDepCount > 0) {
      // Limit to first 100 IDs to prevent unbounded memory usage.
      // Route handlers should only expose the count, not IDs.
      const consumerDeps = await ProjectModuleDependency.find(
        { tenantId: projectTenantId, moduleProjectId: projectId },
        { projectId: 1 },
      )
        .limit(100)
        .lean();
      const consumerProjectIds = consumerDeps.map((d: any) => d.projectId);
      throw new CascadeDeleteBlockedError(consumerProjectIds);
    }

    // Safe to delete — no consumer deps. Delete pointers then releases.
    counts.ModuleEnvironmentPointer = (
      await ModuleEnvironmentPointer.deleteMany({
        tenantId: projectTenantId,
        moduleProjectId: projectId,
      })
    ).deletedCount;
    counts.ModuleRelease = (
      await ModuleRelease.deleteMany({
        tenantId: projectTenantId,
        moduleProjectId: projectId,
      })
    ).deletedCount;
    // Note: Consumer DeploymentModuleSnapshots are NOT deleted here.
    // They belong to consumer projects and are cleaned up via Path B.
  }

  // ── Path B: Consumer project (or any project) ───────────────────────
  // Clean up this project's module dependencies and deployment snapshots.
  if (projectTenantId) {
    counts.ProjectModuleDependency = (
      await ProjectModuleDependency.deleteMany({
        tenantId: projectTenantId,
        projectId,
      })
    ).deletedCount;
    counts.DeploymentModuleSnapshot = (
      await DeploymentModuleSnapshot.deleteMany({
        tenantId: projectTenantId,
        projectId,
      })
    ).deletedCount;
  }

  // ── Standard cascade (unchanged) ────────────────────────────────────

  // Find agents and sessions
  const agents = await ProjectAgent.find({ projectId }, { _id: 1 }).lean();
  const agentIds = agents.map((a: any) => a._id);
  const sessions = await Session.find({ projectId }, { _id: 1 }).lean();
  const sessionIds = sessions.map((s: any) => s._id);
  const agentAssistFilter = projectTenantId
    ? { tenantId: projectTenantId, projectId }
    : { projectId };
  const agentAssistBindings = await AgentAssistBinding.find(agentAssistFilter, {
    apiKeyId: 1,
  }).lean();
  const agentAssistApiKeyIds = [
    ...new Set(
      agentAssistBindings
        .map((binding: any) => binding.apiKeyId)
        .filter((apiKeyId: unknown): apiKeyId is string => typeof apiKeyId === 'string'),
    ),
  ];

  // Deepest first
  counts.Attachment = (
    await Attachment.deleteMany({ sessionId: { $in: sessionIds } })
  ).deletedCount;
  counts.Message = (await Message.deleteMany({ sessionId: { $in: sessionIds } })).deletedCount;
  counts.LLMUsageMetric = (
    await LLMUsageMetric.deleteMany({ sessionId: { $in: sessionIds } })
  ).deletedCount;
  counts.PIIAuditLog = projectTenantId
    ? (await PIIAuditLog.deleteMany({ tenantId: projectTenantId, projectId })).deletedCount
    : 0;
  counts.PIITokenVault = projectTenantId
    ? (await PIITokenVault.deleteMany({ tenantId: projectTenantId, projectId })).deletedCount
    : 0;
  // Prompt Library: versions before items (versions reference promptId as FK)
  if (projectTenantId) {
    counts.PromptLibraryVersion = (
      await PromptLibraryVersion.deleteMany({ tenantId: projectTenantId, projectId })
    ).deletedCount;
    counts.PromptLibraryItem = (
      await PromptLibraryItem.deleteMany({ tenantId: projectTenantId, projectId })
    ).deletedCount;
  }
  counts.AgentVersion = (
    await AgentVersion.deleteMany({ agentId: { $in: agentIds } })
  ).deletedCount;
  counts.Session = (await Session.deleteMany({ projectId })).deletedCount;
  // Variable namespace system (memberships before parents)
  counts.VariableNamespaceMembership = (
    await VariableNamespaceMembership.deleteMany({ projectId })
  ).deletedCount;
  counts.EnvironmentVariable = (await EnvironmentVariable.deleteMany({ projectId })).deletedCount;
  counts.ProjectConfigVariable = (
    await ProjectConfigVariable.deleteMany({ projectId })
  ).deletedCount;
  counts.VariableNamespace = (await VariableNamespace.deleteMany({ projectId })).deletedCount;
  // Snapshots BEFORE deployments (snapshots reference deploymentId as FK)
  counts.DeploymentVariableSnapshot = (
    await DeploymentVariableSnapshot.deleteMany({ projectId })
  ).deletedCount;
  counts.Deployment = (await Deployment.deleteMany({ projectId })).deletedCount;
  counts.ProjectAgent = (await ProjectAgent.deleteMany({ projectId })).deletedCount;
  counts.ProjectMember = (await ProjectMember.deleteMany({ projectId })).deletedCount;
  // Erase trigger registrations BEFORE workflows so right-to-erasure removes
  // user-supplied webhook display tokens and connector triggerParams payloads
  // before the parent workflow rows are gone. Workflow.deleteMany drops the
  // denormalized `triggers[]` array via the parent doc.
  counts.TriggerRegistration = (await TriggerRegistration.deleteMany({ projectId })).deletedCount;
  counts.Workflow = (await Workflow.deleteMany({ projectId })).deletedCount;
  counts.PublicApiKey = (await PublicApiKey.deleteMany({ projectId })).deletedCount;
  counts.WidgetConfig = (await WidgetConfig.deleteMany({ projectId })).deletedCount;
  counts.SDKChannel = (await SDKChannel.deleteMany({ projectId })).deletedCount;
  const projectConfigFilter = projectTenantId ? { tenantId: projectTenantId, projectId } : null;
  counts.ProjectRuntimeConfig = projectConfigFilter
    ? (await ProjectRuntimeConfig.deleteMany(projectConfigFilter)).deletedCount
    : 0;
  counts.ProjectLLMConfig = projectConfigFilter
    ? (await ProjectLLMConfig.deleteMany(projectConfigFilter)).deletedCount
    : 0;
  counts.ModelConfig = projectConfigFilter
    ? (await ModelConfig.deleteMany(projectConfigFilter)).deletedCount
    : 0;
  counts.AgentModelConfig = projectConfigFilter
    ? (await AgentModelConfig.deleteMany(projectConfigFilter)).deletedCount
    : 0;
  counts.ProjectSettingsVersion = (
    await ProjectSettingsVersion.deleteMany({ projectId })
  ).deletedCount;
  counts.ProjectSettings = (await ProjectSettings.deleteMany({ projectId })).deletedCount;
  counts.ConnectorConnection = (await ConnectorConnection.deleteMany({ projectId })).deletedCount;
  counts.AuthProfileAuditEvent = (
    await AuthProfileAuditEvent.deleteMany({ projectId })
  ).deletedCount;
  counts.AuthProfile = (await AuthProfile.deleteMany({ projectId })).deletedCount;
  counts.EndUserOAuthToken = (await EndUserOAuthToken.deleteMany({ projectId })).deletedCount;
  counts.ExternalAgentConfig = (await ExternalAgentConfig.deleteMany({ projectId })).deletedCount;
  counts.MCPServerConfig = (await MCPServerConfig.deleteMany({ projectId })).deletedCount;
  counts.Fact = (await Fact.deleteMany({ projectId })).deletedCount;
  counts.AgentAssistApiKey =
    projectTenantId && agentAssistApiKeyIds.length > 0
      ? (
          await ApiKey.deleteMany({
            tenantId: projectTenantId,
            _id: { $in: agentAssistApiKeyIds },
          })
        ).deletedCount
      : 0;
  counts.AgentAssistBinding = (await AgentAssistBinding.deleteMany(agentAssistFilter)).deletedCount;
  counts.ProjectAgentAssistSettings = (
    await ProjectAgentAssistSettings.deleteMany(agentAssistFilter)
  ).deletedCount;

  // Governance: config data — delete deepest first (versions → overrides → policies)
  if (projectTenantId) {
    counts.GovernancePolicyVersion = (
      await GovernancePolicyVersion.deleteMany({ tenantId: projectTenantId, projectId })
    ).deletedCount;
    counts.GovernanceOverride = (
      await GovernanceOverride.deleteMany({ tenantId: projectTenantId, projectId })
    ).deletedCount;
    counts.GovernancePolicy = (
      await GovernancePolicy.deleteMany({ tenantId: projectTenantId, projectId })
    ).deletedCount;
  }

  // Omnichannel: delete consent records and project settings
  counts.ContactCapabilityConsent = (
    await ContactCapabilityConsent.deleteMany(
      projectTenantId ? { tenantId: projectTenantId, projectId } : { projectId },
    )
  ).deletedCount;
  counts.OmnichannelProjectSettings = (
    await OmnichannelProjectSettings.deleteMany(
      projectTenantId ? { tenantId: projectTenantId, projectId } : { projectId },
    )
  ).deletedCount;

  // Workflow event-sourcing collections: cascade by projectId so project deletion
  // honours right-to-erasure for inputSnapshot, context (callbackSecret), and
  // triggerMetadata (encryptedAccessToken). Mirrors deleteTenant() lines for
  // WorkflowExecution/HumanTask/WorkflowEventOutbox but scoped to this project.
  if (projectTenantId) {
    counts.WorkflowExecution = (
      await WorkflowExecution.deleteMany({ tenantId: projectTenantId, projectId })
    ).deletedCount;
    counts.HumanTaskWorkflow = (
      await HumanTask.deleteMany({ tenantId: projectTenantId, projectId, mailbox: 'workflow' })
    ).deletedCount;
    counts.WorkflowEventOutbox = (
      await WorkflowEventOutboxModel.deleteMany({ tenantId: projectTenantId, projectId })
    ).deletedCount;
  }

  // EventStore: delete events for all sessions in this project
  if (projectTenantId && sessionIds.length > 0) {
    const eventHook = getEventCascadeHook();
    if (eventHook) {
      try {
        await eventHook.deleteBySessionIds(
          projectTenantId,
          sessionIds.map((id: any) => String(id)),
        );
      } catch {
        // EventStore cleanup failure is non-fatal
      }
    }
  }
  const projectDeleteFilter = projectTenantId
    ? { _id: projectId, tenantId: projectTenantId }
    : { _id: projectId };
  counts.Project = (await Project.deleteMany(projectDeleteFilter)).deletedCount;

  const total = Object.values(counts).reduce((sum, c) => sum + c, 0);
  return { counts, total, anonymized: {} };
}

/**
 * Soft-delete (archive) a module project and its releases.
 * Used when a module project has active consumers and cannot be hard-deleted.
 * Archived releases remain resolvable for existing deployment snapshots
 * but cannot be used for new imports.
 *
 * @param moduleProjectId - The module project to archive
 * @param tenantId - The tenant that owns the project
 * @param userId - The user performing the archive
 */
export async function softDeleteModuleProject(
  moduleProjectId: string,
  tenantId: string,
  userId: string,
): Promise<{ archivedReleases: number }> {
  const { Project, ModuleRelease } = await import('../models/index.js');

  const now = new Date();

  await Project.findOneAndUpdate(
    { _id: moduleProjectId, tenantId, kind: 'module' },
    { $set: { archivedAt: now, archivedBy: userId } },
  );

  const releaseResult = await ModuleRelease.updateMany(
    { tenantId, moduleProjectId },
    { $set: { archivedAt: now, archivedBy: userId } },
  );

  return { archivedReleases: releaseResult.modifiedCount };
}

/**
 * Delete a user and all their tokens/memberships.
 * RecoveryCode is embedded in User.mfa, no separate deletion needed.
 */
export async function deleteUser(userId: string): Promise<CascadeDeleteResult> {
  const {
    User,
    OrgMember,
    TenantMember,
    ProjectMember,
    RefreshToken,
    DebugToken,
    LLMCredential,
    AuthProfile,
    EndUserOAuthToken,
    EmailVerificationToken,
    PasswordResetToken,
    AuditLog,
    PlatformAccessRequest,
    PlatformAdmin,
  } = await import('../models/index.js');

  const counts: Record<string, number> = {};
  const anonymized: Record<string, number> = {};

  // Look up email before deleting the User document — needed for platform-level erasure below.
  const userDoc = await User.findOne({ _id: userId }).select('email').lean();

  // Tokens and memberships
  counts.RefreshToken = (await RefreshToken.deleteMany({ userId })).deletedCount;
  counts.DebugToken = (await DebugToken.deleteMany({ userId })).deletedCount;
  counts.EmailVerificationToken = (
    await EmailVerificationToken.deleteMany({ userId })
  ).deletedCount;
  counts.PasswordResetToken = (await PasswordResetToken.deleteMany({ userId })).deletedCount;
  counts.LLMCredential = (
    await LLMCredential.deleteMany({ credentialScope: 'user', ownerId: userId })
  ).deletedCount;

  // AuthProfile: delete personal, anonymize shared
  counts.AuthProfile = (
    await AuthProfile.deleteMany({ createdBy: userId, visibility: 'personal' })
  ).deletedCount;
  await AuthProfile.updateMany(
    { createdBy: userId, visibility: { $ne: 'personal' } },
    { $set: { createdBy: '[SYSTEM:gdpr-erasure]' } },
  );

  // GDPR: delete all end-user OAuth tokens for this user
  counts.EndUserOAuthToken = (await EndUserOAuthToken.deleteMany({ userId })).deletedCount;

  counts.OrgMember = (await OrgMember.deleteMany({ userId })).deletedCount;
  counts.TenantMember = (await TenantMember.deleteMany({ userId })).deletedCount;
  counts.ProjectMember = (await ProjectMember.deleteMany({ userId })).deletedCount;

  // Anonymize audit logs (GDPR)
  const auditResult = await AuditLog.updateMany({ userId }, { $set: { userId: null, ip: null } });
  anonymized.AuditLog = auditResult.modifiedCount;

  // Platform-level PII erasure: PlatformAccessRequest and PlatformAdmin are keyed by email,
  // not tenantId, so they are excluded from tenant cascade and must be handled here.
  if (userDoc?.email) {
    counts.PlatformAccessRequest = (
      await PlatformAccessRequest.deleteMany({ email: userDoc.email })
    ).deletedCount;
    counts.PlatformAdmin = (await PlatformAdmin.deleteMany({ email: userDoc.email })).deletedCount;
  }

  // User itself (RecoveryCode is embedded via mfa subdoc)
  counts.User = (await User.deleteMany({ _id: userId })).deletedCount;

  const total = Object.values(counts).reduce((sum, c) => sum + c, 0);
  return { counts, total, anonymized };
}

/**
 * Delete a session and its messages.
 * High-cardinality operation — messages can number in the thousands.
 */
export async function deleteSession(sessionId: string): Promise<CascadeDeleteResult> {
  const { Session, Message, LLMUsageMetric, Attachment, PIITokenVault } =
    await import('../models/index.js');

  // Look up tenantId before deletion (needed for event cascade)
  const sessionDocs = await Session.find({ _id: sessionId }, { tenantId: 1 }).lean();
  const sessionTenantId = (sessionDocs[0] as any)?.tenantId;

  const counts: Record<string, number> = {};
  counts.Attachment = (await Attachment.deleteMany({ sessionId })).deletedCount;
  counts.Message = (await Message.deleteMany({ sessionId })).deletedCount;
  counts.LLMUsageMetric = (await LLMUsageMetric.deleteMany({ sessionId })).deletedCount;
  counts.PIITokenVault = sessionTenantId
    ? (await PIITokenVault.deleteMany({ tenantId: sessionTenantId, sessionId })).deletedCount
    : (await PIITokenVault.deleteMany({ sessionId })).deletedCount;
  counts.Session = (await Session.deleteMany({ _id: sessionId })).deletedCount;

  // EventStore: delete events for this session
  if (sessionTenantId) {
    const eventHook = getEventCascadeHook();
    if (eventHook) {
      try {
        await eventHook.deleteBySessionIds(sessionTenantId, [sessionId]);
      } catch {
        // EventStore cleanup failure is non-fatal
      }
    }
  }

  const total = Object.values(counts).reduce((sum, c) => sum + c, 0);
  return { counts, total, anonymized: {} };
}

/**
 * Delete a subscription and its quota references.
 * Quotas are embedded in Subscription document (no separate model).
 */
export async function deleteSubscription(subscriptionId: string): Promise<CascadeDeleteResult> {
  const { Subscription } = await import('../models/index.js');

  const counts: Record<string, number> = {};
  counts.Subscription = (await Subscription.deleteMany({ _id: subscriptionId })).deletedCount;

  const total = Object.values(counts).reduce((sum, c) => sum + c, 0);
  return { counts, total, anonymized: {} };
}
