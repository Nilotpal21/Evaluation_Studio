import { createLogger } from '@abl/compiler/platform/logger.js';
import { parseDslToToolForm } from '@agent-platform/shared/tools';
import { ensureDb } from '@/lib/ensure-db';

const log = createLogger('arch-ai:integration-draft-service');

const ACTIVE_DRAFT_STATUSES = new Set([
  'draft',
  'needs_input',
  'ready_to_test',
  'ready_to_apply',
  'failed',
]);

type DraftStatus =
  | 'draft'
  | 'needs_input'
  | 'ready_to_test'
  | 'ready_to_apply'
  | 'complete'
  | 'archived'
  | 'failed';

type DraftSource = 'onboarding' | 'in_project';

type DraftTestStatus = 'pass' | 'fail' | 'pending' | null;

interface DraftTestHistoryEntry {
  at: Date;
  status: 'pass' | 'fail';
  error?: string;
  sanitizedSampleInput?: string;
}

interface DraftDocument {
  _id: string;
  tenantId: string;
  projectId: string;
  sessionId: string | null;
  source: DraftSource;
  status: DraftStatus;
  title: string;
  providerKey: string | null;
  toolIds: string[];
  authProfileIds: string[];
  envVarKeys: string[];
  configVarKeys: string[];
  variableNamespaceIds: string[];
  targetAgentNames: string[];
  pendingSteps: string[];
  lastIntentSummary: string | null;
  createdBy: string;
  lastEditedBy: string | null;
  connectionIds: string[];
  lastTestStatus: DraftTestStatus;
  lastTestAt: Date | null;
  lastTestError: string | null;
  testHistory: DraftTestHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

interface MergeDraftInput {
  tenantId: string;
  projectId: string;
  userId: string;
  sessionId?: string;
  draftId?: string;
  source?: DraftSource;
  title?: string;
  providerKey?: string | null;
  toolIds?: string[];
  authProfileIds?: string[];
  envVarKeys?: string[];
  configVarKeys?: string[];
  variableNamespaceIds?: string[];
  targetAgentNames?: string[];
  pendingSteps?: string[];
  addPendingSteps?: string[];
  removePendingSteps?: string[];
  lastIntentSummary?: string | null;
  status?: DraftStatus;
  connectionIds?: string[];
}

export interface IntegrationDraftSummary {
  id: string;
  title: string;
  status: DraftStatus;
  source: DraftSource;
  providerKey: string | null;
  toolIds: string[];
  authProfileIds: string[];
  envVarKeys: string[];
  configVarKeys: string[];
  variableNamespaceIds: string[];
  targetAgentNames: string[];
  pendingSteps: string[];
  lastIntentSummary: string | null;
  connectionIds: string[];
  lastTestStatus: DraftTestStatus;
  lastTestAt: string | null;
  lastTestError: string | null;
  testHistory: Array<{
    at: string;
    status: 'pass' | 'fail';
    error?: string;
    sanitizedSampleInput?: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

interface DraftToolRecord {
  id: string;
  name: string;
  toolType: string;
  dslContent: string;
  variableNamespaceIds?: string[];
}

interface ToolRequirementSummary {
  envVarKeys: string[];
  configVarKeys: string[];
  authProfileRef: string | null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeVariableKeys(values: Array<string | null | undefined>): string[] {
  return uniqueStrings(
    values.map((value) => (typeof value === 'string' ? value.toUpperCase() : value)),
  );
}

export function normalizeDraft(doc: DraftDocument | null): IntegrationDraftSummary | null {
  if (!doc) {
    return null;
  }

  return {
    id: doc._id,
    title: doc.title,
    status: doc.status,
    source: doc.source,
    providerKey: doc.providerKey,
    toolIds: uniqueStrings(doc.toolIds),
    authProfileIds: uniqueStrings(doc.authProfileIds),
    envVarKeys: normalizeVariableKeys(doc.envVarKeys),
    configVarKeys: normalizeVariableKeys(doc.configVarKeys),
    variableNamespaceIds: uniqueStrings(doc.variableNamespaceIds),
    targetAgentNames: uniqueStrings(doc.targetAgentNames),
    pendingSteps: uniqueStrings(doc.pendingSteps),
    lastIntentSummary: doc.lastIntentSummary,
    connectionIds: uniqueStrings(doc.connectionIds ?? []),
    lastTestStatus: doc.lastTestStatus ?? null,
    lastTestAt: doc.lastTestAt ? doc.lastTestAt.toISOString() : null,
    lastTestError: doc.lastTestError ?? null,
    testHistory: (doc.testHistory ?? []).map((entry) => ({
      at: entry.at.toISOString(),
      status: entry.status,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      ...(entry.sanitizedSampleInput !== undefined
        ? { sanitizedSampleInput: entry.sanitizedSampleInput }
        : {}),
    })),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function extractTemplateKeys(text: string, prefix: 'env' | 'config'): string[] {
  const pattern = new RegExp(`\\{\\{${prefix}\\.([A-Za-z][A-Za-z0-9_]*)\\}\\}`, 'g');
  const keys: string[] = [];
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    keys.push(match[1]?.toUpperCase() ?? '');
    match = pattern.exec(text);
  }
  return normalizeVariableKeys(keys);
}

export function summarizeToolRequirements(tool: DraftToolRecord): ToolRequirementSummary {
  const envVarKeys = extractTemplateKeys(tool.dslContent, 'env');
  const configVarKeys = extractTemplateKeys(tool.dslContent, 'config');

  if (tool.toolType !== 'http') {
    return { envVarKeys, configVarKeys, authProfileRef: null };
  }

  let parsed: ReturnType<typeof parseDslToToolForm> | null = null;
  try {
    parsed = parseDslToToolForm(tool.dslContent, 'http');
  } catch (err: unknown) {
    log.warn('Failed to parse tool DSL while summarizing integration draft requirements', {
      toolId: tool.id,
      toolName: tool.name,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    envVarKeys,
    configVarKeys,
    authProfileRef: parsed?.toolType === 'http' ? (parsed.authProfileRef ?? null) : null,
  };
}

export function deriveDraftStatus(params: {
  explicitStatus?: DraftStatus;
  pendingSteps: string[];
  existingStatus?: DraftStatus;
  toolIds: string[];
  authProfileIds: string[];
  envVarKeys: string[];
  configVarKeys: string[];
  connectionIds: string[];
}): DraftStatus {
  if (params.explicitStatus) {
    return params.explicitStatus;
  }

  if (params.pendingSteps.length > 0) {
    return 'needs_input';
  }

  if (params.existingStatus === 'ready_to_apply') {
    return 'ready_to_apply';
  }

  if (params.existingStatus === 'complete' || params.existingStatus === 'archived') {
    return params.existingStatus;
  }

  if (
    params.toolIds.length > 0 ||
    params.authProfileIds.length > 0 ||
    params.connectionIds.length > 0 ||
    params.envVarKeys.length > 0 ||
    params.configVarKeys.length > 0
  ) {
    return 'ready_to_test';
  }

  return params.existingStatus === 'failed' ? 'failed' : 'draft';
}

async function getDraftModel() {
  await ensureDb();
  const { ArchIntegrationDraft } = await import('@agent-platform/database/models');
  return ArchIntegrationDraft;
}

export async function setSessionDraftPointer(params: {
  tenantId: string;
  projectId: string;
  userId: string;
  sessionId?: string;
  draftId: string | null;
}): Promise<void> {
  if (!params.sessionId) {
    return;
  }

  await ensureDb();
  const { ArchSession } = await import('@agent-platform/database/models');
  const result = await ArchSession.updateOne(
    {
      _id: params.sessionId,
      tenantId: params.tenantId,
      userId: params.userId,
      'metadata.projectId': params.projectId,
      state: { $ne: 'ARCHIVED' },
    },
    { $set: { 'metadata.activeIntegrationDraftId': params.draftId } },
  );

  if (result.matchedCount === 0) {
    log.warn('Failed to update active integration draft pointer on session', {
      sessionId: params.sessionId,
      projectId: params.projectId,
      draftId: params.draftId,
    });
  }
}

async function findDraftBySessionPointer(params: {
  tenantId: string;
  projectId: string;
  sessionId: string;
}): Promise<DraftDocument | null> {
  await ensureDb();
  const { ArchSession } = await import('@agent-platform/database/models');
  const session = (await ArchSession.findOne(
    {
      _id: params.sessionId,
      tenantId: params.tenantId,
      'metadata.projectId': params.projectId,
      state: { $ne: 'ARCHIVED' },
    },
    { 'metadata.activeIntegrationDraftId': 1 },
  ).lean()) as { metadata?: { activeIntegrationDraftId?: string | null } } | null;

  const activeDraftId = session?.metadata?.activeIntegrationDraftId;
  if (!activeDraftId) {
    return null;
  }

  const DraftModel = await getDraftModel();
  return (await DraftModel.findOne({
    _id: activeDraftId,
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
  }).lean()) as DraftDocument | null;
}

function buildResumeSessionFilter(params: {
  tenantId: string;
  projectId: string;
  sessionId: string;
  providerKey?: string | null;
  title?: string;
}): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
    status: { $in: Array.from(ACTIVE_DRAFT_STATUSES) },
  };

  if (params.providerKey !== undefined) {
    filter.providerKey = params.providerKey;
    return filter;
  }

  if (params.title !== undefined) {
    filter.title = params.title;
  }

  return filter;
}

async function findResumableDraftForSession(params: {
  tenantId: string;
  projectId: string;
  sessionId: string;
  providerKey?: string | null;
  title?: string;
}): Promise<DraftDocument | null> {
  const pointedDraft =
    params.providerKey === undefined && params.title === undefined
      ? await findDraftBySessionPointer(params)
      : null;
  if (pointedDraft && ACTIVE_DRAFT_STATUSES.has(pointedDraft.status)) {
    return pointedDraft;
  }

  const DraftModel = await getDraftModel();
  return (await DraftModel.findOne(buildResumeSessionFilter(params))
    .sort({ updatedAt: -1 })
    .lean()) as DraftDocument | null;
}

export async function getIntegrationDraftById(params: {
  tenantId: string;
  projectId: string;
  draftId: string;
}): Promise<IntegrationDraftSummary | null> {
  const DraftModel = await getDraftModel();
  const draft = (await DraftModel.findOne({
    _id: params.draftId,
    tenantId: params.tenantId,
    projectId: params.projectId,
  }).lean()) as DraftDocument | null;
  return normalizeDraft(draft);
}

export async function getActiveIntegrationDraftForSession(params: {
  tenantId: string;
  projectId: string;
  sessionId: string;
}): Promise<IntegrationDraftSummary | null> {
  const draft = await findResumableDraftForSession({
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
  });
  return normalizeDraft(draft);
}

export async function listIntegrationDrafts(params: {
  tenantId: string;
  projectId: string;
  includeCompleted?: boolean;
}): Promise<IntegrationDraftSummary[]> {
  const DraftModel = await getDraftModel();
  const statuses = params.includeCompleted ? undefined : { $in: Array.from(ACTIVE_DRAFT_STATUSES) };
  const drafts = (await DraftModel.find({
    tenantId: params.tenantId,
    projectId: params.projectId,
    ...(statuses ? { status: statuses } : {}),
  })
    .sort({ updatedAt: -1 })
    .limit(20)
    .lean()) as unknown as DraftDocument[];
  return drafts
    .map((draft) => normalizeDraft(draft))
    .filter((draft): draft is IntegrationDraftSummary => draft !== null);
}

/**
 * List all integration drafts for a project except archived ones. Used by the
 * project-scoped GET route that powers the Integrations panel — it must show
 * `complete` drafts (which `listIntegrationDrafts` hides) so the panel can
 * render finished integrations alongside in-progress ones.
 */
export async function listNonArchivedIntegrationDrafts(params: {
  tenantId: string;
  projectId: string;
  limit?: number;
}): Promise<IntegrationDraftSummary[]> {
  const DraftModel = await getDraftModel();
  const drafts = (await DraftModel.find({
    tenantId: params.tenantId,
    projectId: params.projectId,
    status: { $ne: 'archived' },
  })
    .sort({ updatedAt: -1 })
    .limit(params.limit ?? 50)
    .lean()) as unknown as DraftDocument[];
  return drafts
    .map((draft) => normalizeDraft(draft))
    .filter((draft): draft is IntegrationDraftSummary => draft !== null);
}

export async function createOrResumeIntegrationDraft(params: {
  tenantId: string;
  projectId: string;
  userId: string;
  sessionId?: string;
  source?: DraftSource;
  title: string;
  providerKey?: string | null;
  targetAgentNames?: string[];
  pendingSteps?: string[];
  lastIntentSummary?: string | null;
}): Promise<IntegrationDraftSummary> {
  const existing = params.sessionId
    ? await findResumableDraftForSession({
        tenantId: params.tenantId,
        projectId: params.projectId,
        sessionId: params.sessionId,
        providerKey: params.providerKey,
        title: params.title,
      })
    : null;

  if (existing) {
    return (await mergeIntoIntegrationDraft({
      tenantId: params.tenantId,
      projectId: params.projectId,
      userId: params.userId,
      sessionId: params.sessionId,
      draftId: existing._id,
      source: params.source,
      title: params.title,
      providerKey: params.providerKey,
      targetAgentNames: params.targetAgentNames,
      pendingSteps: params.pendingSteps,
      ...(params.lastIntentSummary !== undefined
        ? { lastIntentSummary: params.lastIntentSummary }
        : {}),
    })) as IntegrationDraftSummary;
  }

  const DraftModel = await getDraftModel();
  const createdDoc = await DraftModel.create({
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId ?? null,
    source: params.source ?? 'in_project',
    status: params.pendingSteps && params.pendingSteps.length > 0 ? 'needs_input' : 'draft',
    title: params.title,
    providerKey: params.providerKey ?? null,
    toolIds: [],
    authProfileIds: [],
    envVarKeys: [],
    configVarKeys: [],
    variableNamespaceIds: [],
    targetAgentNames: uniqueStrings(params.targetAgentNames ?? []),
    pendingSteps: uniqueStrings(params.pendingSteps ?? []),
    lastIntentSummary: params.lastIntentSummary ?? null,
    createdBy: params.userId,
    lastEditedBy: params.userId,
  });
  const created = createdDoc.toObject() as unknown as DraftDocument;

  await setSessionDraftPointer({
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.userId,
    sessionId: params.sessionId,
    draftId: created._id,
  });

  return normalizeDraft(created) as IntegrationDraftSummary;
}

export async function mergeIntoIntegrationDraft(
  params: MergeDraftInput,
): Promise<IntegrationDraftSummary | null> {
  const DraftModel = await getDraftModel();
  const target = params.draftId
    ? ((await DraftModel.findOne({
        _id: params.draftId,
        tenantId: params.tenantId,
        projectId: params.projectId,
      }).lean()) as DraftDocument | null)
    : params.sessionId
      ? await findResumableDraftForSession({
          tenantId: params.tenantId,
          projectId: params.projectId,
          sessionId: params.sessionId,
        })
      : null;

  if (!target) {
    return null;
  }

  const toolIds = uniqueStrings([...(target.toolIds ?? []), ...(params.toolIds ?? [])]);
  const authProfileIds = uniqueStrings([
    ...(target.authProfileIds ?? []),
    ...(params.authProfileIds ?? []),
  ]);
  const envVarKeys = normalizeVariableKeys([
    ...(target.envVarKeys ?? []),
    ...(params.envVarKeys ?? []),
  ]);
  const configVarKeys = normalizeVariableKeys([
    ...(target.configVarKeys ?? []),
    ...(params.configVarKeys ?? []),
  ]);
  const variableNamespaceIds = uniqueStrings([
    ...(target.variableNamespaceIds ?? []),
    ...(params.variableNamespaceIds ?? []),
  ]);
  const targetAgentNames = uniqueStrings([
    ...(target.targetAgentNames ?? []),
    ...(params.targetAgentNames ?? []),
  ]);
  const connectionIds = uniqueStrings([
    ...(target.connectionIds ?? []),
    ...(params.connectionIds ?? []),
  ]);

  const basePendingSteps =
    params.pendingSteps !== undefined
      ? uniqueStrings(params.pendingSteps)
      : uniqueStrings(target.pendingSteps ?? []);
  const pendingSteps = uniqueStrings([
    ...basePendingSteps,
    ...(params.addPendingSteps ?? []),
  ]).filter((step) => !new Set(uniqueStrings(params.removePendingSteps ?? [])).has(step));

  const status = deriveDraftStatus({
    explicitStatus: params.status,
    existingStatus: target.status,
    pendingSteps,
    toolIds,
    authProfileIds,
    envVarKeys,
    configVarKeys,
    connectionIds,
  });

  const updated = (await DraftModel.findOneAndUpdate(
    {
      _id: target._id,
      tenantId: params.tenantId,
      projectId: params.projectId,
    },
    {
      $set: {
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.providerKey !== undefined ? { providerKey: params.providerKey } : {}),
        ...(params.source !== undefined ? { source: params.source } : {}),
        ...(params.lastIntentSummary !== undefined
          ? { lastIntentSummary: params.lastIntentSummary }
          : {}),
        ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
        toolIds,
        authProfileIds,
        envVarKeys,
        configVarKeys,
        variableNamespaceIds,
        targetAgentNames,
        pendingSteps,
        connectionIds,
        status,
        lastEditedBy: params.userId,
      },
    },
    { new: true },
  ).lean()) as DraftDocument | null;

  if (!updated) {
    return null;
  }

  await setSessionDraftPointer({
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.userId,
    sessionId: params.sessionId ?? updated.sessionId ?? undefined,
    draftId: updated._id,
  });

  return normalizeDraft(updated);
}

export async function completeIntegrationDraft(params: {
  tenantId: string;
  projectId: string;
  userId: string;
  draftId: string;
  sessionId?: string;
}): Promise<IntegrationDraftSummary | null> {
  const summary = await mergeIntoIntegrationDraft({
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.userId,
    sessionId: params.sessionId,
    draftId: params.draftId,
    status: 'complete',
    pendingSteps: [],
  });

  await setSessionDraftPointer({
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.userId,
    sessionId: params.sessionId,
    draftId: null,
  });

  return summary;
}

export async function archiveIntegrationDraft(params: {
  tenantId: string;
  projectId: string;
  userId: string;
  draftId: string;
  sessionId?: string;
}): Promise<IntegrationDraftSummary | null> {
  const summary = await mergeIntoIntegrationDraft({
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.userId,
    sessionId: params.sessionId,
    draftId: params.draftId,
    status: 'archived',
  });

  await setSessionDraftPointer({
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.userId,
    sessionId: params.sessionId,
    draftId: null,
  });

  return summary;
}

export async function syncActiveDraftFromTool(params: {
  tenantId: string;
  projectId: string;
  userId: string;
  sessionId?: string;
  tool: DraftToolRecord;
}): Promise<IntegrationDraftSummary | null> {
  if (!params.sessionId) {
    return null;
  }

  const requirements = summarizeToolRequirements(params.tool);
  return mergeIntoIntegrationDraft({
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.userId,
    sessionId: params.sessionId,
    toolIds: [params.tool.id],
    envVarKeys: requirements.envVarKeys,
    configVarKeys: requirements.configVarKeys,
    variableNamespaceIds: params.tool.variableNamespaceIds ?? [],
  });
}

export async function syncActiveDraftFromAuthProfile(params: {
  tenantId: string;
  projectId: string;
  userId: string;
  sessionId?: string;
  authProfileId: string;
}): Promise<IntegrationDraftSummary | null> {
  if (!params.sessionId) {
    return null;
  }

  return mergeIntoIntegrationDraft({
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.userId,
    sessionId: params.sessionId,
    authProfileIds: [params.authProfileId],
  });
}

export async function syncActiveDraftFromConnection(params: {
  tenantId: string;
  projectId: string;
  userId: string;
  sessionId?: string;
  connectionId: string;
}): Promise<IntegrationDraftSummary | null> {
  if (!params.sessionId) {
    return null;
  }

  return mergeIntoIntegrationDraft({
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.userId,
    sessionId: params.sessionId,
    connectionIds: [params.connectionId],
  });
}

export async function syncActiveDraftFromVariable(params: {
  tenantId: string;
  projectId: string;
  userId: string;
  sessionId?: string;
  variableType: 'env' | 'config';
  key: string;
  variableNamespaceIds?: string[];
}): Promise<IntegrationDraftSummary | null> {
  if (!params.sessionId) {
    return null;
  }

  return mergeIntoIntegrationDraft({
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.userId,
    sessionId: params.sessionId,
    ...(params.variableType === 'env'
      ? { envVarKeys: [params.key] }
      : { configVarKeys: [params.key] }),
    variableNamespaceIds: params.variableNamespaceIds ?? [],
  });
}

export async function removeActiveDraftVariable(params: {
  tenantId: string;
  projectId: string;
  userId: string;
  sessionId?: string;
  variableType: 'env' | 'config';
  key: string;
}): Promise<IntegrationDraftSummary | null> {
  if (!params.sessionId) {
    return null;
  }

  const activeDraft = await getActiveIntegrationDraftForSession({
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
  });
  if (!activeDraft) {
    return null;
  }

  return mergeIntoIntegrationDraft({
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.userId,
    sessionId: params.sessionId,
    draftId: activeDraft.id,
    ...(params.variableType === 'env'
      ? {
          envVarKeys: activeDraft.envVarKeys.filter((key) => key !== params.key.toUpperCase()),
        }
      : {
          configVarKeys: activeDraft.configVarKeys.filter(
            (key) => key !== params.key.toUpperCase(),
          ),
        }),
  });
}

export async function removeActiveDraftTool(params: {
  tenantId: string;
  projectId: string;
  userId: string;
  sessionId?: string;
  toolId: string;
}): Promise<IntegrationDraftSummary | null> {
  if (!params.sessionId) {
    return null;
  }

  const activeDraft = await getActiveIntegrationDraftForSession({
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
  });
  if (!activeDraft) {
    return null;
  }

  return mergeIntoIntegrationDraft({
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.userId,
    sessionId: params.sessionId,
    draftId: activeDraft.id,
    toolIds: activeDraft.toolIds.filter((toolId) => toolId !== params.toolId),
  });
}

export async function removeActiveDraftAuthProfile(params: {
  tenantId: string;
  projectId: string;
  userId: string;
  sessionId?: string;
  authProfileId: string;
}): Promise<IntegrationDraftSummary | null> {
  if (!params.sessionId) {
    return null;
  }

  const activeDraft = await getActiveIntegrationDraftForSession({
    tenantId: params.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
  });
  if (!activeDraft) {
    return null;
  }

  return mergeIntoIntegrationDraft({
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.userId,
    sessionId: params.sessionId,
    draftId: activeDraft.id,
    authProfileIds: activeDraft.authProfileIds.filter((id) => id !== params.authProfileId),
  });
}
