import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import { sanitizeToolError } from '../sanitize-tool-error';
import { invalidateProjectCaches } from './cache-invalidation';

const log = createLogger('arch-ai:integration-ops');

type DraftStatus =
  | 'draft'
  | 'needs_input'
  | 'ready_to_test'
  | 'ready_to_apply'
  | 'complete'
  | 'archived'
  | 'failed';

interface IntegrationOpsInput {
  action:
    | 'start'
    | 'get_active'
    | 'list'
    | 'update'
    | 'run_tool_test'
    | 'complete'
    | 'archive'
    | 'revalidate';
  draftId?: string;
  title?: string;
  providerKey?: string | null;
  source?: 'onboarding' | 'in_project';
  targetAgentNames?: string[];
  pendingSteps?: string[];
  addPendingSteps?: string[];
  removePendingSteps?: string[];
  lastIntentSummary?: string | null;
  status?: DraftStatus;
  includeCompleted?: boolean;
  toolId?: string;
  testInput?: Record<string, unknown>;
  toolIds?: string[];
  authProfileIds?: string[];
  envVarKeys?: string[];
  configVarKeys?: string[];
  variableNamespaceIds?: string[];
}

type EntityChangeKind = 'unchanged' | 'updated_externally' | 'deleted_externally' | 'newly_invalid';

type EntityType = 'auth_profile' | 'tool' | 'connection' | 'agent' | 'variable_namespace';

interface EntityChange {
  entityType: EntityType;
  entityId: string;
  change: EntityChangeKind;
  summary: string;
}

interface PendingStep {
  id: string;
  description: string;
}

interface RevalidationResult {
  status: DraftStatus;
  changes: EntityChange[];
  pendingSteps: PendingStep[];
}

interface IntegrationOpsResult {
  success?: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

function missing(param: string, action: IntegrationOpsInput['action']): IntegrationOpsResult {
  return {
    success: false,
    error: { code: 'MISSING_PARAM', message: `${param} is required for ${action}` },
  };
}

async function resolveDraftForAction(
  input: IntegrationOpsInput,
  ctx: ToolPermissionContext,
): Promise<{
  id: string;
  pendingSteps: string[];
  toolIds: string[];
} | null> {
  const { getIntegrationDraftById, getActiveIntegrationDraftForSession } =
    await import('@/lib/arch-ai/integration-draft-service');

  if (input.draftId) {
    const draft = await getIntegrationDraftById({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      draftId: input.draftId,
    });
    return draft
      ? { id: draft.id, pendingSteps: draft.pendingSteps, toolIds: draft.toolIds }
      : null;
  }

  if (!ctx.sessionId) {
    return null;
  }

  const draft = await getActiveIntegrationDraftForSession({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
  });
  return draft ? { id: draft.id, pendingSteps: draft.pendingSteps, toolIds: draft.toolIds } : null;
}

async function startDraft(
  input: IntegrationOpsInput,
  ctx: ToolPermissionContext,
): Promise<IntegrationOpsResult> {
  if (!ctx.sessionId) {
    return {
      success: false,
      error: {
        code: 'SESSION_REQUIRED',
        message: 'An active Arch session is required to start an integration draft.',
      },
    };
  }

  const { createOrResumeIntegrationDraft } =
    await import('@/lib/arch-ai/integration-draft-service');
  const draft = await createOrResumeIntegrationDraft({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    userId: ctx.user.userId,
    sessionId: ctx.sessionId,
    source: input.source ?? 'in_project',
    title: input.title?.trim() || input.providerKey?.trim() || 'Integration Draft',
    ...(input.providerKey !== undefined ? { providerKey: input.providerKey } : {}),
    targetAgentNames: input.targetAgentNames,
    pendingSteps: input.pendingSteps,
    lastIntentSummary: input.lastIntentSummary ?? null,
  });

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);
  return { success: true, data: draft };
}

async function getActiveDraft(
  input: IntegrationOpsInput,
  ctx: ToolPermissionContext,
): Promise<IntegrationOpsResult> {
  const { getIntegrationDraftById, getActiveIntegrationDraftForSession } =
    await import('@/lib/arch-ai/integration-draft-service');

  let draft: { id: string } | null = null;
  if (input.draftId) {
    draft = await getIntegrationDraftById({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      draftId: input.draftId,
    });
  } else if (ctx.sessionId) {
    draft = await getActiveIntegrationDraftForSession({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
    });
  } else {
    return missing('draftId or sessionId', 'get_active');
  }

  if (!draft) {
    return { success: true, data: null };
  }

  // Auto-revalidate so callers see external drift before they act on the draft.
  // Failure of the revalidation pass should not break get_active.
  let revalidationData: unknown = null;
  try {
    const reval = await revalidate({ action: 'revalidate', draftId: draft.id }, ctx);
    if (reval.success) {
      revalidationData = reval.data ?? null;
    } else {
      log.warn('Auto-revalidation failed during get_active', {
        draftId: draft.id,
        projectId: ctx.projectId,
        error: reval.error?.code,
      });
    }
  } catch (err: unknown) {
    log.warn('Auto-revalidation threw during get_active', {
      draftId: draft.id,
      projectId: ctx.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { success: true, data: { ...draft, revalidation: revalidationData } };
}

async function listDrafts(
  input: IntegrationOpsInput,
  ctx: ToolPermissionContext,
): Promise<IntegrationOpsResult> {
  const { listIntegrationDrafts } = await import('@/lib/arch-ai/integration-draft-service');
  const drafts = await listIntegrationDrafts({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    includeCompleted: input.includeCompleted ?? false,
  });
  return { success: true, data: { drafts } };
}

async function updateDraft(
  input: IntegrationOpsInput,
  ctx: ToolPermissionContext,
): Promise<IntegrationOpsResult> {
  const { mergeIntoIntegrationDraft } = await import('@/lib/arch-ai/integration-draft-service');
  const updated = await mergeIntoIntegrationDraft({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    userId: ctx.user.userId,
    sessionId: ctx.sessionId,
    draftId: input.draftId,
    title: input.title,
    providerKey: input.providerKey,
    source: input.source,
    targetAgentNames: input.targetAgentNames,
    pendingSteps: input.pendingSteps,
    addPendingSteps: input.addPendingSteps,
    removePendingSteps: input.removePendingSteps,
    lastIntentSummary: input.lastIntentSummary,
    status: input.status,
    toolIds: input.toolIds,
    authProfileIds: input.authProfileIds,
    envVarKeys: input.envVarKeys,
    configVarKeys: input.configVarKeys,
    variableNamespaceIds: input.variableNamespaceIds,
  });

  if (!updated) {
    return {
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'No active integration draft was found for this update.',
      },
    };
  }

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);
  return { success: true, data: updated };
}

async function runToolTest(
  input: IntegrationOpsInput,
  ctx: ToolPermissionContext,
): Promise<IntegrationOpsResult> {
  const draft = await resolveDraftForAction(input, ctx);
  const toolId = input.toolId ?? (draft?.toolIds.length === 1 ? draft.toolIds[0] : undefined);
  if (!toolId) {
    return missing('toolId', 'run_tool_test');
  }

  const { executeToolsOps } = await import('@/lib/arch-ai/tools/tools-ops');
  const result = await executeToolsOps(
    {
      action: 'test',
      toolId,
      testInput: input.testInput,
    },
    ctx,
  );

  if (!draft || !result.success) {
    return result;
  }

  const remainingSteps = draft.pendingSteps.filter(
    (step) => step !== 'run_tool_test' && step !== 'test_tool',
  );
  const { mergeIntoIntegrationDraft } = await import('@/lib/arch-ai/integration-draft-service');
  const updatedDraft = await mergeIntoIntegrationDraft({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    userId: ctx.user.userId,
    sessionId: ctx.sessionId,
    draftId: draft.id,
    pendingSteps: remainingSteps,
    status: remainingSteps.length === 0 ? 'ready_to_apply' : undefined,
  });

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);
  return {
    success: true,
    data: {
      test: result.data ?? null,
      draft: updatedDraft,
    },
  };
}

async function completeDraft(
  input: IntegrationOpsInput,
  ctx: ToolPermissionContext,
): Promise<IntegrationOpsResult> {
  const draft = await resolveDraftForAction(input, ctx);
  if (!draft) {
    return missing('draftId or active draft', 'complete');
  }

  const { completeIntegrationDraft } = await import('@/lib/arch-ai/integration-draft-service');
  const completed = await completeIntegrationDraft({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    userId: ctx.user.userId,
    sessionId: ctx.sessionId,
    draftId: draft.id,
  });

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);
  return { success: true, data: completed };
}

async function archiveDraft(
  input: IntegrationOpsInput,
  ctx: ToolPermissionContext,
): Promise<IntegrationOpsResult> {
  const draft = await resolveDraftForAction(input, ctx);
  if (!draft) {
    return missing('draftId or active draft', 'archive');
  }

  const { archiveIntegrationDraft } = await import('@/lib/arch-ai/integration-draft-service');
  const archived = await archiveIntegrationDraft({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    userId: ctx.user.userId,
    sessionId: ctx.sessionId,
    draftId: draft.id,
  });

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);
  return { success: true, data: archived };
}

function computePendingStepsFromChanges(changes: EntityChange[]): PendingStep[] {
  const steps: PendingStep[] = [];
  for (const c of changes) {
    if (c.change === 'deleted_externally') {
      steps.push({
        id: `recreate_${c.entityType}_${c.entityId}`,
        description: `Recreate ${c.entityType}: ${c.summary}`,
      });
    } else if (c.change === 'newly_invalid') {
      steps.push({
        id: `fix_${c.entityType}_${c.entityId}`,
        description: c.summary,
      });
    }
  }
  return steps;
}

async function loadActiveDraftIdFromSession(ctx: ToolPermissionContext): Promise<string | null> {
  if (!ctx.sessionId) {
    return null;
  }
  const { getActiveIntegrationDraftForSession } =
    await import('@/lib/arch-ai/integration-draft-service');
  const draft = await getActiveIntegrationDraftForSession({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
  });
  return draft?.id ?? null;
}

async function revalidate(
  input: IntegrationOpsInput,
  ctx: ToolPermissionContext,
): Promise<IntegrationOpsResult> {
  const draftId = input.draftId ?? (await loadActiveDraftIdFromSession(ctx));
  if (!draftId) {
    return {
      success: false,
      error: {
        code: 'NO_ACTIVE_DRAFT',
        message: 'No active integration draft to revalidate.',
      },
    };
  }

  const {
    ArchIntegrationDraft,
    AuthProfile,
    ProjectTool,
    ConnectorConnection,
    ProjectAgent,
    VariableNamespace,
    EndUserOAuthToken,
  } = await import('@agent-platform/database/models');

  const draft = (await ArchIntegrationDraft.findOne({
    _id: draftId,
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
  })) as
    | (Record<string, unknown> & {
        _id: string;
        status: DraftStatus;
        toolIds: string[];
        authProfileIds: string[];
        envVarKeys: string[];
        configVarKeys: string[];
        connectionIds: string[];
        targetAgentNames: string[];
        variableNamespaceIds: string[];
        pendingSteps: string[] | PendingStep[];
        save: () => Promise<unknown>;
      })
    | null;

  if (!draft) {
    return {
      success: false,
      error: { code: 'DRAFT_NOT_FOUND', message: `Draft ${draftId} not found.` },
    };
  }

  const { buildAuthProfileOAuthProviderKey } =
    await import('@agent-platform/shared/services/auth-profile');

  const changes: EntityChange[] = [];

  // Auth profiles: check existence, plus oauth grant for oauth2_token.
  for (const id of draft.authProfileIds ?? []) {
    const profile = (await AuthProfile.findOne({
      _id: id,
      tenantId: ctx.user.tenantId,
    })) as
      | (Record<string, unknown> & {
          _id: string;
          name: string;
          authType: string;
        })
      | null;

    if (!profile) {
      changes.push({
        entityType: 'auth_profile',
        entityId: id,
        change: 'deleted_externally',
        summary: 'Profile no longer exists.',
      });
      continue;
    }

    if (profile.authType === 'oauth2_token') {
      const grant = (await EndUserOAuthToken.findOne({
        tenantId: ctx.user.tenantId,
        provider: buildAuthProfileOAuthProviderKey(String(profile._id)),
      })) as (Record<string, unknown> & { expiresAt?: Date | null }) | null;

      if (!grant) {
        changes.push({
          entityType: 'auth_profile',
          entityId: id,
          change: 'newly_invalid',
          summary: 'oauth_grant_missing_or_expired — re-authorization required.',
        });
        continue;
      }
      if (grant.expiresAt && grant.expiresAt < new Date()) {
        changes.push({
          entityType: 'auth_profile',
          entityId: id,
          change: 'newly_invalid',
          summary: 'oauth_grant_missing_or_expired — token expired.',
        });
        continue;
      }
    }

    changes.push({
      entityType: 'auth_profile',
      entityId: id,
      change: 'unchanged',
      summary: profile.name,
    });
  }

  // Project tools: tenant + project scoped.
  for (const id of draft.toolIds ?? []) {
    const tool = (await ProjectTool.findOne({
      _id: id,
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
    })) as (Record<string, unknown> & { name: string }) | null;

    changes.push(
      tool
        ? {
            entityType: 'tool',
            entityId: id,
            change: 'unchanged',
            summary: tool.name,
          }
        : {
            entityType: 'tool',
            entityId: id,
            change: 'deleted_externally',
            summary: 'Tool no longer exists.',
          },
    );
  }

  // Connector connections: tenant + project scoped.
  for (const id of draft.connectionIds ?? []) {
    const conn = (await ConnectorConnection.findOne({
      _id: id,
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
    })) as (Record<string, unknown> & { connectorName: string; displayName?: string }) | null;

    changes.push(
      conn
        ? {
            entityType: 'connection',
            entityId: id,
            change: 'unchanged',
            summary: conn.displayName ?? conn.connectorName,
          }
        : {
            entityType: 'connection',
            entityId: id,
            change: 'deleted_externally',
            summary: 'Connection no longer exists.',
          },
    );
  }

  // Target agents: keyed by name within tenant + project.
  for (const name of draft.targetAgentNames ?? []) {
    const agent = (await ProjectAgent.findOne({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      name,
    })) as (Record<string, unknown> & { name: string }) | null;

    changes.push(
      agent
        ? {
            entityType: 'agent',
            entityId: name,
            change: 'unchanged',
            summary: agent.name,
          }
        : {
            entityType: 'agent',
            entityId: name,
            change: 'deleted_externally',
            summary: 'Agent no longer exists.',
          },
    );
  }

  // Variable namespaces: tenant + project scoped.
  for (const id of draft.variableNamespaceIds ?? []) {
    const ns = (await VariableNamespace.findOne({
      _id: id,
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
    })) as (Record<string, unknown> & { name: string }) | null;

    changes.push(
      ns
        ? {
            entityType: 'variable_namespace',
            entityId: id,
            change: 'unchanged',
            summary: ns.name,
          }
        : {
            entityType: 'variable_namespace',
            entityId: id,
            change: 'deleted_externally',
            summary: 'Variable namespace no longer exists.',
          },
    );
  }

  // Compute the new pending steps and recompute the draft status.
  const newPendingSteps = computePendingStepsFromChanges(changes);
  const pendingStepIds = newPendingSteps.map((s) => s.id);

  const { deriveDraftStatus } = await import('@/lib/arch-ai/integration-draft-service');
  const nextStatus = deriveDraftStatus({
    existingStatus: draft.status,
    pendingSteps: pendingStepIds,
    toolIds: draft.toolIds ?? [],
    authProfileIds: draft.authProfileIds ?? [],
    envVarKeys: draft.envVarKeys ?? [],
    configVarKeys: draft.configVarKeys ?? [],
    connectionIds: draft.connectionIds ?? [],
  });

  draft.pendingSteps = pendingStepIds;
  draft.status = nextStatus;
  await draft.save();

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);

  const result: RevalidationResult = {
    status: nextStatus,
    changes,
    pendingSteps: newPendingSteps,
  };
  return { success: true, data: result };
}

export async function executeIntegrationOps(
  input: IntegrationOpsInput,
  ctx: ToolPermissionContext,
): Promise<IntegrationOpsResult> {
  const perm = await checkToolPermission('integration_ops', input.action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  try {
    switch (input.action) {
      case 'start':
        return startDraft(input, ctx);
      case 'get_active':
        return getActiveDraft(input, ctx);
      case 'list':
        return listDrafts(input, ctx);
      case 'update':
        return updateDraft(input, ctx);
      case 'run_tool_test':
        return runToolTest(input, ctx);
      case 'complete':
        return completeDraft(input, ctx);
      case 'archive':
        return archiveDraft(input, ctx);
      case 'revalidate':
        return revalidate(input, ctx);
      default:
        return {
          success: false,
          error: { code: 'INVALID_ACTION', message: `Unknown action: ${input.action}` },
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('integration_ops action failed', {
      action: input.action,
      projectId: ctx.projectId,
      error: message,
    });
    const sanitized = sanitizeToolError(err);
    return {
      success: false,
      error: { code: sanitized.code, message: sanitized.message },
    };
  }
}
