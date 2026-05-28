/**
 * Session Service — CRUD + lifecycle operations for Arch AI sessions.
 *
 * Contract: session-state-machine.md, api-index.md, S1-F04
 *
 * All queries include tenantId + userId (never findById).
 * State transitions are atomic (findOneAndUpdate with state precondition).
 * One non-terminal session per (tenantId, userId) at any time.
 */

import type { Model } from 'mongoose';
import type { IArchSessionRecord } from '../models/index.js';
import { createLogger } from '@agent-platform/shared-observability';
import type {
  ArchSession,
  SessionState,
  ArchPhase,
  HistorySummary,
  PendingInteraction,
  PendingMutation,
  PendingPlan,
  StoredMessage,
  StoredMessageMetadata,
} from '../types/session.js';
import type { PageContext } from '../types/page-context.js';
import type { Specification } from '../types/specification.js';
import { createDefaultSpecification } from '../types/specification.js';
import {
  validateStateTransition,
  RESUMABLE_STATES,
  ARCHIVABLE_STATES,
} from '../coordinator/session-state-machine.js';
import { resolveMode } from '../coordinator/phase-machine.js';
import {
  InvalidTransitionError,
  SessionNotFoundError,
  SessionArchivedError,
  SessionAlreadyExistsError,
} from '../types/errors.js';
import {
  CURRENT_IN_PROJECT_SESSION_CONTRACT_VERSION,
  DEFAULT_SESSION_THREAD_ID,
  hasSupportedInProjectSessionContract,
} from './session-contract.js';

const log = createLogger('arch-ai:session-service');

/** IDLE sessions older than this are auto-archived on getOrCreate. Default: 24h. */
const IDLE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** ACTIVE sessions older than this are considered stuck and auto-archived on getOrCreate. Default: 10min. */
const STUCK_ACTIVE_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_CURRENT_SESSION_CANDIDATES = 10;

const COMPATIBLE_STATE_VALUES: Record<SessionState, string[]> = {
  IDLE: ['IDLE', 'idle'],
  ACTIVE: ['ACTIVE', 'active'],
  GATE_PENDING: ['GATE_PENDING', 'gate_pending'],
  COMPLETE: ['COMPLETE', 'complete'],
  ARCHIVED: ['ARCHIVED', 'archived'],
};

interface SessionContext {
  tenantId: string;
  userId: string;
}

interface SessionJournalService {
  append(
    ctx: SessionContext,
    params: {
      sessionId: string;
      type: 'analysis';
      content: {
        type: 'analysis';
        question: string;
        rootCause: string;
        specialist: string;
        fixApplied?: boolean;
        fixDetails?: string;
        regressionTestAdded?: boolean;
      };
      specialist: string;
      phase: string;
    },
  ): Promise<unknown>;
  archiveSession(ctx: SessionContext, sessionId: string): Promise<void>;
}

type UnknownRecord = Record<string, unknown>;
type SessionSurface = 'project' | 'agent-editor';
interface SessionScopeOptions {
  surface?: SessionSurface;
  agentName?: string | null;
  threadId?: string | null;
}

const PROJECT_SESSION_AGENT_KEY = '__project__';

type LooseToolCall = UnknownRecord & {
  toolCallId?: string;
  toolName?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  args?: Record<string, unknown>;
  result?: unknown;
};

const PENDING_PLAN_STATUSES = new Set([
  'proposed',
  'approved',
  'refining',
  'cancelled',
  'invalidated',
]);

function normalizeAgentName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function buildAgentNameKey(agentName: string): string {
  return Buffer.from(normalizeAgentName(agentName).toLowerCase(), 'utf8').toString('base64url');
}

function normalizeThreadId(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    return DEFAULT_SESSION_THREAD_ID;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_SESSION_THREAD_ID;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecordArray(value: unknown): value is UnknownRecord[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'object' && item !== null);
}

function normalizePendingPlan(value: unknown): PendingPlan | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const plan = value as UnknownRecord;
  const status = plan.status;
  const hasRequiredStrings =
    typeof plan.id === 'string' &&
    typeof plan.projectId === 'string' &&
    typeof plan.title === 'string' &&
    typeof plan.summary === 'string' &&
    typeof plan.goal === 'string' &&
    typeof plan.architecturalPattern === 'string' &&
    typeof plan.createdAt === 'string' &&
    typeof plan.updatedAt === 'string';

  if (
    !hasRequiredStrings ||
    typeof status !== 'string' ||
    !PENDING_PLAN_STATUSES.has(status) ||
    !isStringArray(plan.evidence) ||
    !isStringArray(plan.affectedAgents) ||
    !isRecordArray(plan.sectionsToChange) ||
    !isRecordArray(plan.plannedMutations) ||
    !isRecordArray(plan.risks) ||
    !isStringArray(plan.validationNotes) ||
    typeof plan.dependentsAnalysis !== 'object' ||
    plan.dependentsAnalysis === null ||
    !isRecordArray(plan.alternativesConsidered) ||
    !isRecordArray(plan.citations)
  ) {
    log.warn('Dropping invalid pending Arch plan from session metadata', {
      planId: typeof plan.id === 'string' ? plan.id : undefined,
      status: typeof status === 'string' ? status : undefined,
    });
    return undefined;
  }

  return plan as unknown as PendingPlan;
}

function resolveSessionScope(
  mode: 'ONBOARDING' | 'IN_PROJECT',
  options?: SessionScopeOptions,
): {
  surface: SessionSurface;
  agentName: string | null;
  agentNameKey: string;
  threadId: string;
} {
  const surface = options?.surface ?? 'project';
  const threadId = normalizeThreadId(options?.threadId);

  if (surface === 'project') {
    if (options?.agentName != null && normalizeAgentName(options.agentName).length > 0) {
      throw new Error('INVALID_SESSION_SCOPE');
    }
    return {
      surface: 'project',
      agentName: null,
      agentNameKey: PROJECT_SESSION_AGENT_KEY,
      threadId,
    };
  }

  if (mode !== 'IN_PROJECT') {
    throw new Error('INVALID_SESSION_SCOPE');
  }

  const agentName =
    typeof options?.agentName === 'string' ? normalizeAgentName(options.agentName) : '';
  if (agentName.length === 0) {
    throw new Error('INVALID_SESSION_SCOPE');
  }

  return {
    surface: 'agent-editor',
    agentName,
    agentNameKey: buildAgentNameKey(agentName),
    threadId,
  };
}

function buildSessionScopeFilter(
  ctx: SessionContext,
  mode: 'ONBOARDING' | 'IN_PROJECT',
  projectId?: string,
  options?: SessionScopeOptions,
): Record<string, unknown> {
  const scope = resolveSessionScope(mode, options);
  const filter: Record<string, unknown> = {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    'metadata.mode': mode,
    'metadata.projectId': mode === 'IN_PROJECT' ? (projectId ?? null) : null,
    'metadata.threadId': scope.threadId,
  };

  if (mode === 'IN_PROJECT') {
    filter['metadata.surface'] = scope.surface;
    filter['metadata.agentNameKey'] = scope.agentNameKey;
  }

  return filter;
}

function buildContractArchiveScopeFilter(
  ctx: SessionContext,
  mode: 'ONBOARDING' | 'IN_PROJECT',
  projectId?: string,
): Record<string, unknown> {
  return {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    'metadata.mode': mode,
    'metadata.projectId': mode === 'IN_PROJECT' ? (projectId ?? null) : null,
  };
}

function hasValidSessionSurfaceInvariant(metadata: UnknownRecord): boolean {
  const surface = metadata.surface ?? 'project';
  const agentName = metadata.agentName;
  const agentNameKey = metadata.agentNameKey ?? PROJECT_SESSION_AGENT_KEY;
  const threadId = metadata.threadId ?? DEFAULT_SESSION_THREAD_ID;

  if (typeof threadId !== 'string' || threadId.trim().length === 0) {
    return false;
  }

  if (surface === 'project') {
    return (agentName == null || agentName === '') && agentNameKey === PROJECT_SESSION_AGENT_KEY;
  }

  if (surface === 'agent-editor') {
    return (
      typeof agentName === 'string' &&
      normalizeAgentName(agentName).length > 0 &&
      agentNameKey === buildAgentNameKey(agentName)
    );
  }

  return false;
}

function toCompatibleStateValues(states: readonly string[]): string[] {
  const values = new Set<string>();
  for (const state of states) {
    const compatible =
      COMPATIBLE_STATE_VALUES[state as SessionState] ??
      (typeof state === 'string' ? [state, state.toLowerCase()] : []);
    for (const value of compatible) {
      values.add(value);
    }
  }
  return Array.from(values);
}

function buildCompatibleStateFilter(states: readonly string[]): Record<string, unknown> {
  return { $in: toCompatibleStateValues(states) };
}

function normalizeSessionStateValue(rawState: unknown): SessionState {
  if (typeof rawState === 'string') {
    switch (rawState) {
      case 'idle':
      case 'IDLE':
        return 'IDLE';
      case 'active':
      case 'ACTIVE':
      case 'gate_pending':
      case 'GATE_PENDING':
        return 'ACTIVE';
      case 'complete':
      case 'COMPLETE':
        return 'COMPLETE';
      case 'archived':
      case 'ARCHIVED':
        return 'ARCHIVED';
      default: {
        const upper = rawState.toUpperCase();
        if (
          upper === 'IDLE' ||
          upper === 'ACTIVE' ||
          upper === 'COMPLETE' ||
          upper === 'ARCHIVED'
        ) {
          return upper as SessionState;
        }
      }
    }
  }
  return 'IDLE';
}

function getSessionTimestamp(value: Date | string | number | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function asUnknownRecord(value: unknown): UnknownRecord {
  return value as UnknownRecord;
}

function normalizeStoredMessageMetadata(value: unknown): StoredMessageMetadata | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as UnknownRecord;
  const normalized: StoredMessageMetadata = {};

  if (
    record.source === 'deterministic_tool_answer' ||
    record.source === 'deterministic_mutation_resolution'
  ) {
    normalized.source = record.source;
  }

  if (typeof record.toolCallId === 'string' && record.toolCallId.length > 0) {
    normalized.toolCallId = record.toolCallId;
  }

  if (record.action === 'applied' || record.action === 'rejected') {
    normalized.action = record.action;
  }

  if (typeof record.targetAgent === 'string' && record.targetAgent.length > 0) {
    normalized.targetAgent = record.targetAgent;
  }

  if (typeof record.changeSummary === 'string' && record.changeSummary.length > 0) {
    normalized.changeSummary = record.changeSummary;
  }

  if (typeof record.artifactsClosed === 'boolean') {
    normalized.artifactsClosed = record.artifactsClosed;
  }

  if (typeof record.planCleared === 'boolean') {
    normalized.planCleared = record.planCleared;
  }

  if (typeof record.topologyRefreshed === 'boolean') {
    normalized.topologyRefreshed = record.topologyRefreshed;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeStoredMessages(
  doc: IArchSessionRecord,
  fallbackTimestamp: string,
): StoredMessage[] {
  const rawMessages = Array.isArray(doc.metadata.messages)
    ? (doc.metadata.messages as UnknownRecord[])
    : [];

  return rawMessages.flatMap((message, index) => {
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') {
      return [];
    }

    const streamedPresentation = message.streamedPresentation as
      | {
          specialist?: string;
          toolCalls?: Array<{
            id?: string;
            name?: string;
            args?: Record<string, unknown>;
            result?: unknown;
          }>;
        }
      | undefined;
    const rawToolCalls = Array.isArray(message.toolCalls)
      ? (message.toolCalls as LooseToolCall[])
      : Array.isArray(streamedPresentation?.toolCalls)
        ? (streamedPresentation.toolCalls as LooseToolCall[])
        : [];
    const messageCreatedAt = message.createdAt as Date | string | number | null | undefined;

    return [
      {
        id:
          typeof message.id === 'string' && message.id.length > 0
            ? message.id
            : `${doc._id}-message-${index}`,
        role,
        content: message.content as StoredMessage['content'],
        timestamp:
          typeof message.timestamp === 'string'
            ? message.timestamp
            : new Date(
                getSessionTimestamp(messageCreatedAt) ||
                  getSessionTimestamp(doc.updatedAt) ||
                  Date.parse(fallbackTimestamp),
              ).toISOString(),
        specialist:
          typeof message.specialist === 'string'
            ? message.specialist
            : streamedPresentation?.specialist,
        toolCalls: rawToolCalls
          .map((toolCall) => {
            const toolCallRecord = asUnknownRecord(toolCall);
            const toolCallId =
              typeof toolCallRecord.toolCallId === 'string'
                ? toolCallRecord.toolCallId
                : typeof toolCallRecord.id === 'string'
                  ? toolCallRecord.id
                  : null;
            const toolName =
              typeof toolCallRecord.toolName === 'string'
                ? toolCallRecord.toolName
                : typeof toolCallRecord.name === 'string'
                  ? toolCallRecord.name
                  : null;
            if (!toolCallId || !toolName) {
              return null;
            }
            return {
              toolCallId,
              toolName,
              input: (toolCallRecord.input ?? toolCallRecord.args ?? {}) as Record<string, unknown>,
              result: toolCallRecord.result,
            };
          })
          .filter((toolCall): toolCall is NonNullable<typeof toolCall> => toolCall !== null),
        messageMetadata: normalizeStoredMessageMetadata(message.messageMetadata),
        phase:
          typeof message.phase === 'string' && message.phase.length > 0
            ? message.phase
            : doc.metadata.phase,
      } satisfies StoredMessage,
    ];
  });
}

function scoreSessionCandidate(doc: IArchSessionRecord): number {
  const metadata = doc.metadata as Record<string, unknown>;
  let score = 0;

  if (metadata.pendingInteraction) score += 1_000;
  if (metadata.pendingMutation) score += 900;
  if (metadata.pendingPlan) score += 800;
  if (metadata.activeIntegrationDraftId) score += 850;
  if (Array.isArray(doc.metadata.messages) && doc.metadata.messages.length > 0) {
    score += 700 + Math.min(doc.metadata.messages.length, 50);
  }
  if (normalizeSessionStateValue(doc.state) === 'ACTIVE') score += 200;

  return score;
}

/**
 * Converts a Mongoose document to the typed ArchSession interface.
 */
function toArchSession(doc: IArchSessionRecord): ArchSession {
  const docRecord = doc as unknown as UnknownRecord;
  const normalizedState = normalizeSessionStateValue(docRecord.state);
  const messages = normalizeStoredMessages(doc, doc.updatedAt.toISOString());

  return {
    id: doc._id,
    tenantId: doc.tenantId,
    userId: doc.userId,
    state: normalizedState,
    metadata: {
      phase: doc.metadata.phase as ArchPhase,
      mode: doc.metadata.mode as 'ONBOARDING' | 'IN_PROJECT',
      contractVersion:
        ((doc.metadata as UnknownRecord).contractVersion as number | undefined) ?? undefined,
      surface: (((doc.metadata as UnknownRecord).surface as SessionSurface | undefined) ??
        'project') as 'project' | 'agent-editor',
      agentName: (((doc.metadata as UnknownRecord).agentName as string | null | undefined) ??
        null) as string | null,
      agentNameKey: (((doc.metadata as UnknownRecord).agentNameKey as string | undefined) ??
        PROJECT_SESSION_AGENT_KEY) as string,
      threadId: normalizeThreadId((doc.metadata as UnknownRecord).threadId as string | undefined),
      specification: doc.metadata.specification as unknown as Specification,
      pendingInteraction: (doc.metadata.pendingInteraction as PendingInteraction | null) ?? null,
      messages,
      historySummary:
        ((doc.metadata as UnknownRecord).historySummary as HistorySummary | null | undefined) ??
        null,
      projectId: doc.metadata.projectId ?? undefined,
      lastUserPageContext: ((doc.metadata as UnknownRecord).lastUserPageContext ?? undefined) as
        | PageContext
        | undefined,
      activeSpecialist: (doc.metadata as UnknownRecord).activeSpecialist as string | undefined,
      pendingMutation: (doc.metadata as UnknownRecord).pendingMutation as
        | PendingMutation
        | undefined,
      pendingPlan: normalizePendingPlan((doc.metadata as UnknownRecord).pendingPlan),
      activeIntegrationDraftId: (doc.metadata as UnknownRecord).activeIntegrationDraftId as
        | string
        | undefined,
      blueprintStage: (doc.metadata as UnknownRecord).blueprintStage as
        | import('../types/session.js').BlueprintStage
        | undefined,
      topology: (doc.metadata as UnknownRecord).topology as Record<string, unknown> | undefined,
      draftTopology: (doc.metadata as UnknownRecord).draftTopology as
        | Record<string, unknown>
        | undefined,
      lockedTopology: (doc.metadata as UnknownRecord).lockedTopology as
        | Record<string, unknown>
        | undefined,
      blueprintOutput: (doc.metadata as UnknownRecord).blueprintOutput as
        | Record<string, unknown>
        | undefined,
      blueprintContextSummary:
        ((doc.metadata as UnknownRecord).blueprintContextSummary as string | null | undefined) ??
        undefined,
      topologyApproved: doc.metadata.topologyApproved ?? false,
      files: doc.metadata.files as Record<string, unknown> | undefined,
      toolDsls:
        ((doc.metadata as UnknownRecord).toolDsls as Record<string, string> | undefined) ?? {},
      // Gate-free: durable build progress replaces buildSubPhase/selectedTools
      buildProgress: (doc.metadata as UnknownRecord).buildProgress as
        | import('../types/session.js').BuildProgress
        | undefined,
      // approvedAgents MUST be mapped — pickNextGate and the agent_review
      // accept handler read it from the DTO. Dropping it silently causes the
      // gate queue to loop on the same agent forever (regression 2026-04-12).
      approvedAgents:
        ((doc.metadata as UnknownRecord).approvedAgents as string[] | undefined) ?? [],
      mockServer: doc.metadata.mockServer as
        | {
            projectName: string;
            endpointCount: number;
            files: Array<{ path: string; content: string }>;
          }
        | null
        | undefined,
    },
    archivedAt: doc.archivedAt?.toISOString(),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export class SessionService {
  constructor(
    private readonly model: Model<IArchSessionRecord>,
    private readonly journalService?: SessionJournalService,
  ) {}

  private async normalizeSessionDocument(
    ctx: SessionContext,
    doc: IArchSessionRecord | null,
  ): Promise<IArchSessionRecord | null> {
    if (!doc) {
      return null;
    }

    const patch: Record<string, unknown> = {};
    const rawDocRecord = doc as unknown as UnknownRecord;
    const normalizedState = normalizeSessionStateValue(rawDocRecord.state);
    if (rawDocRecord.state !== normalizedState) {
      patch.state = normalizedState;
    }
    if (normalizedState === 'ACTIVE' && !doc.lastActiveAt) {
      patch.lastActiveAt = doc.updatedAt ?? new Date();
    }

    const docRecord = doc as IArchSessionRecord & UnknownRecord;
    if (typeof docRecord.cancelRequested !== 'boolean') {
      patch.cancelRequested = false;
    }
    if (typeof docRecord.lastCommittedSeq !== 'number') {
      patch.lastCommittedSeq = 0;
    }
    if (typeof docRecord.seq !== 'number') {
      patch.seq = 0;
    }
    if (typeof docRecord.fencingToken !== 'number') {
      patch.fencingToken = 0;
    }
    if (doc.metadata.pendingInteraction === undefined) {
      patch['metadata.pendingInteraction'] = null;
    }
    if ((doc.metadata as UnknownRecord).historySummary === undefined) {
      patch['metadata.historySummary'] = null;
    }
    if ((doc.metadata as UnknownRecord).surface === undefined) {
      patch['metadata.surface'] = 'project';
    }
    if ((doc.metadata as UnknownRecord).agentName === undefined) {
      patch['metadata.agentName'] = null;
    }
    if ((doc.metadata as UnknownRecord).agentNameKey === undefined) {
      patch['metadata.agentNameKey'] = PROJECT_SESSION_AGENT_KEY;
    }
    if ((doc.metadata as UnknownRecord).threadId === undefined) {
      patch['metadata.threadId'] = DEFAULT_SESSION_THREAD_ID;
    }
    if (!Array.isArray(doc.metadata.messages)) {
      patch['metadata.messages'] = [];
    }
    if ((doc.metadata as UnknownRecord).blueprintStage === undefined) {
      patch['metadata.blueprintStage'] = 'concept_ready';
    }

    if (Object.keys(patch).length === 0) {
      return doc;
    }

    await this.model.updateOne(
      {
        _id: doc._id,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      },
      { $set: patch },
    );

    docRecord.state = normalizedState;
    if (patch.lastActiveAt instanceof Date) {
      doc.lastActiveAt = patch.lastActiveAt;
    }
    if ('cancelRequested' in patch) {
      docRecord.cancelRequested = false;
    }
    if ('lastCommittedSeq' in patch) {
      docRecord.lastCommittedSeq = 0;
    }
    if ('seq' in patch) {
      docRecord.seq = 0;
    }
    if ('fencingToken' in patch) {
      docRecord.fencingToken = 0;
    }
    if ('metadata.pendingInteraction' in patch) {
      doc.metadata.pendingInteraction = null;
    }
    if ('metadata.historySummary' in patch) {
      (doc.metadata as UnknownRecord).historySummary = null;
    }
    if ('metadata.messages' in patch) {
      doc.metadata.messages = [];
    }
    if ('metadata.threadId' in patch) {
      (doc.metadata as UnknownRecord).threadId = DEFAULT_SESSION_THREAD_ID;
    }

    return doc;
  }

  private async archiveUnsupportedInProjectSessions(
    ctx: SessionContext,
    scopeFilter: Record<string, unknown>,
    reason: string,
  ): Promise<number> {
    const archivedAt = new Date();
    const result = await this.model.updateMany(
      {
        ...scopeFilter,
        'metadata.mode': 'IN_PROJECT',
        state: buildCompatibleStateFilter(ARCHIVABLE_STATES),
        $or: [
          { 'metadata.contractVersion': { $exists: false } },
          { 'metadata.contractVersion': { $ne: CURRENT_IN_PROJECT_SESSION_CONTRACT_VERSION } },
          { 'metadata.surface': { $exists: false } },
          { 'metadata.agentNameKey': { $exists: false } },
        ],
      },
      {
        $set: {
          state: 'ARCHIVED',
          archivedAt,
        },
      },
    );

    const archivedCount = result.modifiedCount ?? 0;
    if (archivedCount > 0) {
      log.warn('arch_ai.session_contract_archived', {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        reason,
        archivedCount,
        contractVersion: CURRENT_IN_PROJECT_SESSION_CONTRACT_VERSION,
        projectId: (scopeFilter['metadata.projectId'] as string | null | undefined) ?? null,
      });
    }

    return archivedCount;
  }

  private async archiveUnsupportedInProjectSession(
    ctx: SessionContext,
    doc: IArchSessionRecord,
    reason: string,
  ): Promise<boolean> {
    const metadata = doc.metadata as UnknownRecord;
    if (
      hasSupportedInProjectSessionContract(metadata) &&
      hasValidSessionSurfaceInvariant(metadata)
    ) {
      return false;
    }

    const result = await this.model.updateOne(
      {
        _id: doc._id,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        state: buildCompatibleStateFilter(ARCHIVABLE_STATES),
      },
      {
        $set: {
          state: 'ARCHIVED',
          archivedAt: new Date(),
        },
      },
    );

    if ((result.modifiedCount ?? 0) > 0) {
      log.warn('arch_ai.session_contract_archived', {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        sessionId: doc._id,
        reason,
        contractVersion: CURRENT_IN_PROJECT_SESSION_CONTRACT_VERSION,
        projectId: doc.metadata.projectId ?? null,
      });
      return true;
    }

    return false;
  }

  private async findBestCurrentSession(
    filter: Record<string, unknown>,
    ctx: SessionContext,
  ): Promise<IArchSessionRecord | null> {
    const docs = await this.model
      .find(filter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(MAX_CURRENT_SESSION_CANDIDATES);

    if (docs.length === 0) {
      return null;
    }

    const normalizedDocs = await Promise.all(
      docs.map((doc) => this.normalizeSessionDocument(ctx, doc)),
    );

    const candidates = normalizedDocs.filter((doc): doc is IArchSessionRecord => doc !== null);
    candidates.sort((left, right) => {
      const scoreDelta = scoreSessionCandidate(right) - scoreSessionCandidate(left);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      const updatedDelta =
        getSessionTimestamp(right.lastActiveAt ?? right.updatedAt ?? right.createdAt) -
        getSessionTimestamp(left.lastActiveAt ?? left.updatedAt ?? left.createdAt);
      if (updatedDelta !== 0) {
        return updatedDelta;
      }

      return getSessionTimestamp(right.createdAt) - getSessionTimestamp(left.createdAt);
    });

    return candidates[0] ?? null;
  }

  /**
   * Create a new session.
   * Contract: api-index.md — POST /api/arch-ai/sessions
   * Contract 13 (execution-model): "One active session per user per mode."
   *
   * Relies on the partial unique index on (tenantId, userId, mode) for
   * non-terminal states to prevent duplicates at the database level.
   */
  async create(
    ctx: SessionContext,
    projectId?: string,
    options?: SessionScopeOptions,
  ): Promise<ArchSession> {
    const mode = resolveMode(projectId);
    const scopeFilter = buildSessionScopeFilter(ctx, mode, projectId, options);
    const sessionScope = resolveSessionScope(mode, options);

    if (mode === 'IN_PROJECT') {
      await this.archiveUnsupportedInProjectSessions(
        ctx,
        buildContractArchiveScopeFilter(ctx, mode, projectId),
        'create',
      );
    }

    try {
      const doc = await this.model.create({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        state: 'IDLE',
        cancelRequested: false,
        lastCommittedSeq: 0,
        seq: 0,
        fencingToken: 0,
        metadata: {
          phase: 'INTERVIEW',
          mode,
          contractVersion: CURRENT_IN_PROJECT_SESSION_CONTRACT_VERSION,
          surface: sessionScope.surface,
          agentName: sessionScope.agentName,
          agentNameKey: sessionScope.agentNameKey,
          threadId: sessionScope.threadId,
          specification: createDefaultSpecification(),
          pendingInteraction: null,
          historySummary: null,
          messages: [],
          projectId: projectId ?? null,
          blueprintStage: 'concept_ready',
          draftTopology: null,
          lockedTopology: null,
          blueprintContextSummary: null,
        },
      });

      return toArchSession(doc);
    } catch (err: unknown) {
      // Duplicate key error from partial unique index = concurrent create race.
      // Another request won the race. Return the winning session.
      if (err instanceof Error && 'code' in err && (err as { code: number }).code === 11000) {
        const existing = await this.findBestCurrentSession(
          {
            ...scopeFilter,
            state: buildCompatibleStateFilter(RESUMABLE_STATES),
          },
          ctx,
        );
        if (existing) {
          return toArchSession(existing);
        }
        const legacyExisting = await this.findBestCurrentSession(
          {
            ...scopeFilter,
            state: buildCompatibleStateFilter(['GATE_PENDING']),
          },
          ctx,
        );
        if (legacyExisting) {
          return toArchSession(legacyExisting);
        }
        throw new SessionAlreadyExistsError(ctx.tenantId, ctx.userId);
      }
      throw err;
    }
  }

  /**
   * Get or create a session.
   * Contract 13 (execution-model): "getOrCreate returns the ACTIVE session
   * for (tenantId, userId, mode)."
   *
   * 1. Resolve mode from projectId
   * 2. Find session where { tenantId, userId, mode, state in RESUMABLE }
   * 3. If found and IDLE past TTL: auto-archive and create fresh session
   * 4. If found and within TTL (or ACTIVE): return it (resume)
   * 5. If not found: create new session with state = 'IDLE'
   */
  async getOrCreate(
    ctx: SessionContext,
    projectId?: string,
    options?: SessionScopeOptions,
  ): Promise<ArchSession> {
    const mode = resolveMode(projectId);
    const scopeFilter = buildSessionScopeFilter(ctx, mode, projectId, options);

    if (mode === 'IN_PROJECT') {
      await this.archiveUnsupportedInProjectSessions(
        ctx,
        buildContractArchiveScopeFilter(ctx, mode, projectId),
        'getOrCreate',
      );
    }

    const existing = await this.findBestCurrentSession(
      {
        ...scopeFilter,
        state: buildCompatibleStateFilter([...RESUMABLE_STATES, 'GATE_PENDING']),
      },
      ctx,
    );

    if (existing) {
      // Auto-archive IDLE sessions past TTL to prevent resume loop
      if (normalizeSessionStateValue(existing.state) === 'IDLE') {
        const updatedAt = existing.updatedAt ?? existing.createdAt;
        const idleAge = Date.now() - new Date(updatedAt).getTime();
        if (idleAge > IDLE_SESSION_TTL_MS) {
          log.info('Auto-archiving expired IDLE session', {
            sessionId: existing._id,
            idleMinutes: Math.round(idleAge / 1000 / 60),
          });
          await this.model.findOneAndUpdate(
            { _id: existing._id, state: buildCompatibleStateFilter(['IDLE']) },
            { $set: { state: 'ARCHIVED', archivedAt: new Date() } },
          );
          return this.create(ctx, projectId, options);
        }
      }

      // Auto-archive ACTIVE sessions stuck beyond threshold to prevent lockout
      if (normalizeSessionStateValue(existing.state) === 'ACTIVE') {
        const updatedAt = existing.lastActiveAt ?? existing.updatedAt ?? existing.createdAt;
        const activeAge = Date.now() - new Date(updatedAt).getTime();
        if (activeAge > STUCK_ACTIVE_SESSION_TTL_MS) {
          const activeMinutes = Math.round(activeAge / 1000 / 60);
          log.warn('arch_ai.session_auto_archived', {
            sessionId: existing._id,
            activeMinutes,
            reason: 'stuck_active',
          });
          await this.model.findOneAndUpdate(
            {
              _id: existing._id,
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              state: buildCompatibleStateFilter(['ACTIVE']),
            },
            { $set: { state: 'ARCHIVED', archivedAt: new Date() } },
          );
          return this.create(ctx, projectId, options);
        }
      }

      return toArchSession(existing);
    }

    return this.create(ctx, projectId, options);
  }

  /**
   * Force-archive stale non-terminal sessions before creating a replacement.
   *
   * P0 reliability guard: users should not be locked out by abandoned ACTIVE or
   * GATE_PENDING sessions. Recovery is scoped to the exact (tenantId, userId,
   * mode, projectId) tuple enforced by the database uniqueness constraint.
   */
  async forceArchiveStuck(
    ctx: SessionContext,
    projectId: string | undefined,
    thresholdMs: number,
    options?: SessionScopeOptions,
  ): Promise<number> {
    if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
      return 0;
    }

    const mode = resolveMode(projectId);
    const scopeFilter = buildSessionScopeFilter(ctx, mode, projectId, options);
    const archivalTime = new Date();
    const staleBefore = new Date(archivalTime.getTime() - thresholdMs);
    const staleSessions = await this.model.find({
      ...scopeFilter,
      state: buildCompatibleStateFilter(['ACTIVE', 'GATE_PENDING']),
      updatedAt: { $lte: staleBefore },
    });

    let archivedCount = 0;

    for (const session of staleSessions) {
      if (this.journalService) {
        try {
          await this.journalService.append(ctx, {
            sessionId: session._id,
            type: 'analysis',
            content: {
              type: 'analysis',
              question: 'Why was this session automatically archived before creating a new one?',
              rootCause:
                `Session remained ${session.state} without activity since ` +
                `${session.updatedAt.toISOString()}, exceeding the stuck-session threshold.`,
              specialist: 'coordinator',
              fixApplied: true,
              fixDetails: `Archived the stale ${session.state} session to unblock fresh session creation.`,
            },
            specialist: 'coordinator',
            phase: session.metadata.phase,
          });
        } catch (err: unknown) {
          log.warn('Failed to append stale-session recovery journal entry', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: session._id,
          });
        }
      }

      const archived = await this.model.findOneAndUpdate(
        {
          _id: session._id,
          ...scopeFilter,
          state: buildCompatibleStateFilter(['ACTIVE', 'GATE_PENDING']),
          updatedAt: { $lte: staleBefore },
        },
        { $set: { state: 'ARCHIVED', archivedAt: archivalTime } },
        { new: true },
      );

      if (!archived) {
        continue;
      }

      archivedCount++;

      if (this.journalService) {
        try {
          await this.journalService.archiveSession(ctx, session._id);
        } catch (err: unknown) {
          log.warn('Failed to archive journal entries for stale session recovery', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: session._id,
          });
        }
      }
    }

    return archivedCount;
  }

  /**
   * Archive every Arch session that can collide with a fresh create under the
   * legacy database uniqueness scope.
   *
   * Some deployed MongoDBs still have the older unique index on
   * (tenantId, userId, mode, projectId), or the intermediate surface-only index
   * without threadId. A forced "start new session" only calls this after such a
   * stale-index collision, otherwise hidden threads can coexist normally.
   */
  async forceArchiveForFreshStart(ctx: SessionContext, projectId?: string): Promise<number> {
    const mode = resolveMode(projectId);
    const archivedAt = new Date();
    const legacyScopeFilter = buildContractArchiveScopeFilter(ctx, mode, projectId);

    const result = await this.model.updateMany(
      {
        ...legacyScopeFilter,
        state: buildCompatibleStateFilter(ARCHIVABLE_STATES),
      },
      {
        $set: {
          state: 'ARCHIVED',
          archivedAt,
        },
      },
    );

    const archivedCount = result.modifiedCount ?? 0;
    if (archivedCount > 0) {
      log.warn('arch_ai.session_force_archived_for_fresh_start', {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        projectId: projectId ?? null,
        mode,
        archivedCount,
      });
    }

    return archivedCount;
  }

  /**
   * Archive the exact scoped Arch thread before creating a replacement.
   *
   * This is used when a caller explicitly asks to force-create a known thread id
   * (for example CLI-based session creation). Without this, create() can resolve
   * a duplicate-key race by returning the existing session, which is correct for
   * get-or-create but surprising for a forced fresh start.
   */
  async forceArchiveScopedFreshStart(
    ctx: SessionContext,
    projectId: string | undefined,
    options?: SessionScopeOptions,
  ): Promise<number> {
    const mode = resolveMode(projectId);
    const scopeFilter = buildSessionScopeFilter(ctx, mode, projectId, options);
    const archivedAt = new Date();

    const result = await this.model.updateMany(
      {
        ...scopeFilter,
        state: buildCompatibleStateFilter(ARCHIVABLE_STATES),
      },
      {
        $set: {
          state: 'ARCHIVED',
          archivedAt,
        },
      },
    );

    const archivedCount = result.modifiedCount ?? 0;
    if (archivedCount > 0) {
      log.warn('arch_ai.session_scope_force_archived_for_fresh_start', {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        projectId: projectId ?? null,
        mode,
        archivedCount,
      });
    }

    return archivedCount;
  }

  /**
   * Get a specific session by ID, scoped to tenant + user.
   * Returns null if not found (404, not 403 — don't leak existence).
   */
  async getById(ctx: SessionContext, sessionId: string): Promise<ArchSession | null> {
    const doc = await this.normalizeSessionDocument(
      ctx,
      await this.model.findOne({
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      }),
    );

    if (doc && (await this.archiveUnsupportedInProjectSession(ctx, doc, 'getById'))) {
      return null;
    }

    return doc ? toArchSession(doc) : null;
  }

  /**
   * Get the current active session for a user in a given mode.
   * Contract: api-index.md — GET /sessions/current
   * Contract 13: scoped by (tenantId, userId, mode)
   *
   * If mode is omitted, returns any resumable session.
   * If projectId is provided (with mode=IN_PROJECT), further scopes by project.
   */
  async getCurrent(
    ctx: SessionContext,
    mode?: 'ONBOARDING' | 'IN_PROJECT',
    projectId?: string,
    options?: SessionScopeOptions,
  ): Promise<ArchSession | null> {
    if (mode === 'IN_PROJECT') {
      await this.archiveUnsupportedInProjectSessions(
        ctx,
        projectId
          ? buildContractArchiveScopeFilter(ctx, mode, projectId)
          : {
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              'metadata.mode': 'IN_PROJECT',
            },
        'getCurrent',
      );
    }

    const filter: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      state: buildCompatibleStateFilter([...RESUMABLE_STATES, 'GATE_PENDING']),
    };

    if (mode) {
      filter['metadata.mode'] = mode;
    }

    if (projectId && mode === 'IN_PROJECT') {
      filter['metadata.projectId'] = projectId;
    }

    if (mode === 'IN_PROJECT') {
      const scope = resolveSessionScope(mode, options);
      filter['metadata.surface'] = scope.surface;
      filter['metadata.agentNameKey'] = scope.agentNameKey;
    }

    if (options?.threadId !== undefined) {
      const scope = resolveSessionScope(mode ?? 'ONBOARDING', options);
      filter['metadata.threadId'] = scope.threadId;
    }

    const doc = await this.findBestCurrentSession(filter, ctx);
    return doc ? toArchSession(doc) : null;
  }

  /**
   * Atomic state transition.
   * Contract: session-state-machine.md — Atomic Transition Pattern
   *
   * Uses findOneAndUpdate with state precondition in the filter.
   * Throws InvalidTransitionError if the transition is invalid or
   * the session has been modified concurrently.
   */
  async transitionState(
    ctx: SessionContext,
    sessionId: string,
    from: SessionState,
    to: SessionState,
  ): Promise<ArchSession> {
    validateStateTransition(from, to);

    const update: Record<string, unknown> = { state: to };
    if (to === 'ARCHIVED') {
      update.archivedAt = new Date();
    }
    if (to === 'ACTIVE') {
      update.lastActiveAt = new Date();
    }

    const doc = await this.model.findOneAndUpdate(
      {
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        state: buildCompatibleStateFilter([from]),
      },
      { $set: update },
      { new: true },
    );

    if (!doc) {
      throw new InvalidTransitionError(from, to);
    }

    return toArchSession(doc);
  }

  /**
   * Atomically reset a session from an interactive-tool pause back to ACTIVE
   * and clear the pending interaction. Handles both the gate-free design path
   * (session stayed ACTIVE with pendingInteraction.kind='widget') and the
   * legacy/engine path where the TurnBuffer patches state to 'gate_pending'
   * (lowercase) via buffer.patchSession({ state: 'gate_pending' }).
   *
   * Uses a broad state filter { $in: ['ACTIVE', 'GATE_PENDING', 'gate_pending'] }
   * so it works regardless of which path was taken. Single atomic write prevents
   * the race between clearing pendingInteraction and resetting state.
   *
   * Safe to call for tool_answer and gate_response on sessions that are already
   * ACTIVE (no pendingInteraction) — the $set is a no-op for state in that case.
   *
   * Returns null if the session was not found or was ARCHIVED.
   */
  async resumeFromInteractiveTool(
    ctx: SessionContext,
    sessionId: string,
  ): Promise<ArchSession | null> {
    const doc = await this.model.findOneAndUpdate(
      {
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        // Accept ACTIVE (gate-free widget path) and both casings of GATE_PENDING
        // (legacy TurnBuffer patch path). Exclude ARCHIVED — those are terminal.
        state: buildCompatibleStateFilter(['ACTIVE', 'GATE_PENDING']),
      },
      {
        $set: {
          state: 'ACTIVE',
          'metadata.pendingInteraction': null,
          lastActiveAt: new Date(),
        },
      },
      { new: true },
    );

    return doc ? toArchSession(doc) : null;
  }

  /**
   * Atomically transition state AND clear any pending interaction in a single
   * DB write. Used when a user bypasses a widget_pending prompt by sending
   * a new message — we must transition back to ACTIVE and drop the stale
   * interaction payload so the UI stops rendering the widget on reload.
   *
   * This is the atomic equivalent of:
   *   await transitionState(ctx, id, from, to);
   *   await setPendingInteraction(ctx, id, null);
   * with the critical difference that a partial write is impossible. If the
   * precondition fails (state mismatch from concurrent modification), throws
   * InvalidTransitionError — callers should surface this as HTTP 409 Conflict.
   */
  async transitionStateAndClearPendingInteraction(
    ctx: SessionContext,
    sessionId: string,
    from: SessionState,
    to: SessionState,
  ): Promise<ArchSession> {
    validateStateTransition(from, to);

    const update: Record<string, unknown> = {
      state: to,
      'metadata.pendingInteraction': null,
    };
    if (to === 'ARCHIVED') {
      update.archivedAt = new Date();
    }
    if (to === 'ACTIVE') {
      update.lastActiveAt = new Date();
    }

    const doc = await this.model.findOneAndUpdate(
      {
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        state: buildCompatibleStateFilter([from]),
      },
      { $set: update },
      { new: true },
    );

    if (!doc) {
      throw new InvalidTransitionError(from, to);
    }

    return toArchSession(doc);
  }

  /**
   * Update session phase atomically.
   * Only the coordinator calls this — specialists never mutate phase.
   */
  async updatePhase(
    ctx: SessionContext,
    sessionId: string,
    phase: ArchPhase,
  ): Promise<ArchSession> {
    const doc = await this.model.findOneAndUpdate(
      {
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        state: { $ne: 'ARCHIVED' },
      },
      { $set: { 'metadata.phase': phase } },
      { new: true },
    );

    if (!doc) {
      throw new SessionNotFoundError(sessionId);
    }

    return toArchSession(doc);
  }

  /**
   * Update specification fields atomically.
   * Contract: S1-F04 — "metadata.specification can be updated without
   * overwriting other metadata fields (atomic field updates via $set)"
   */
  async updateSpecification(
    ctx: SessionContext,
    sessionId: string,
    fields: Partial<Specification>,
  ): Promise<ArchSession> {
    const setFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      setFields[`metadata.specification.${key}`] = value;
    }

    const doc = await this.model.findOneAndUpdate(
      {
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        state: { $ne: 'ARCHIVED' },
      },
      { $set: setFields },
      { new: true },
    );

    if (!doc) {
      throw new SessionNotFoundError(sessionId);
    }

    return toArchSession(doc);
  }

  /**
   * Append a message to the session.
   * Contract: conversation-persistence.md — messages are append-only within
   * a sliding window (oldest beyond MAX_STORED_MESSAGES are discarded via $slice).
   */
  async appendMessage(
    ctx: SessionContext,
    sessionId: string,
    message: StoredMessage,
  ): Promise<void> {
    // Guard against oversized messages that could exceed MongoDB 16MB BSON limit
    const messageBytes = JSON.stringify(message).length;
    const MAX_MESSAGE_BYTES = 512 * 1024; // 512KB per message
    if (messageBytes > MAX_MESSAGE_BYTES) {
      log.warn('Message too large, truncating tool results', {
        sessionId,
        bytes: messageBytes,
        limit: MAX_MESSAGE_BYTES,
      });
      // Truncate tool call results to fit
      if (message.toolCalls) {
        for (const tc of message.toolCalls) {
          if (tc.result && JSON.stringify(tc.result).length > 10_000) {
            tc.result = {
              truncated: true,
              summary: 'Tool result truncated (too large for session storage)',
            };
          }
        }
      }
    }

    const result = await this.model.updateOne(
      {
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        state: { $ne: 'ARCHIVED' },
      },
      { $push: { 'metadata.messages': { $each: [message], $slice: -200 } } },
    );

    if (result.matchedCount === 0) {
      throw new SessionNotFoundError(sessionId);
    }
  }

  /**
   * Set the result on a stored tool call after the user answers.
   * Updates the last message that has a matching toolCallId.
   * This enables the frontend to render answered widgets on resume.
   */
  async setToolResult(
    ctx: SessionContext,
    sessionId: string,
    toolCallId: string,
    result: unknown,
  ): Promise<void> {
    // Use positional operator to update the matching toolCall's result
    const updateResult = await this.model.updateOne(
      {
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        'metadata.messages.toolCalls.toolCallId': toolCallId,
      },
      {
        $set: { 'metadata.messages.$[msg].toolCalls.$[tc].result': result },
      },
      {
        arrayFilters: [{ 'msg.toolCalls.toolCallId': toolCallId }, { 'tc.toolCallId': toolCallId }],
      },
    );

    // matchedCount === 0 means toolCallId not found in any stored message.
    // Non-fatal: widget still works in current session, just won't persist for resume.
    // No throw — consistent with best-effort persistence pattern.
  }

  async setLastCollectFileContent(
    ctx: SessionContext,
    sessionId: string,
    fileContent: unknown,
  ): Promise<void> {
    await this.model.updateOne(
      { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId },
      { $set: { 'metadata.lastCollectFileContent': fileContent } },
    );
  }

  async getLastCollectFileContent(
    ctx: SessionContext,
    sessionId: string,
  ): Promise<Array<{ name: string; type: string; content: string; size: number }> | null> {
    const session = await this.model
      .findOne({ _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId })
      .select('metadata.lastCollectFileContent')
      .lean();
    return (session?.metadata as any)?.lastCollectFileContent ?? null;
  }

  /**
   * Set or clear the pending interaction.
   * Contract: session-state-machine.md — Pending Interaction Persistence
   *
   * SET when coordinator emits tool_call (ask_user widget).
   * CLEARED when coordinator receives tool_answer.
   */
  async setPendingInteraction(
    ctx: SessionContext,
    sessionId: string,
    interaction: PendingInteraction | null,
  ): Promise<void> {
    const result = await this.model.updateOne(
      {
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        state: { $ne: 'ARCHIVED' },
      },
      { $set: { 'metadata.pendingInteraction': interaction } },
    );

    if (result.matchedCount === 0) {
      throw new SessionNotFoundError(sessionId);
    }
  }

  /**
   * Set or clear the pending mutation awaiting explicit user review/apply.
   */
  async setPendingMutation(
    ctx: SessionContext,
    sessionId: string,
    mutation: PendingMutation | null,
  ): Promise<void> {
    const result = await this.model.updateOne(
      {
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        state: { $ne: 'ARCHIVED' },
      },
      { $set: { 'metadata.pendingMutation': mutation } },
    );

    if (result.matchedCount === 0) {
      throw new SessionNotFoundError(sessionId);
    }
  }

  /**
   * Set or clear the pending/approved plan that gates IN_PROJECT mutations.
   */
  async setPendingPlan(
    ctx: SessionContext,
    sessionId: string,
    plan: PendingPlan | null,
  ): Promise<void> {
    const result = await this.model.updateOne(
      {
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        state: { $ne: 'ARCHIVED' },
      },
      { $set: { 'metadata.pendingPlan': plan } },
    );

    if (result.matchedCount === 0) {
      throw new SessionNotFoundError(sessionId);
    }
  }

  /**
   * Persist the active specialist for specialist pinning on tool_answer resume.
   * When a tool_answer arrives, the router uses this instead of content-based routing
   * so the original specialist's tool set and system prompt are preserved.
   */
  async setActiveSpecialist(
    ctx: SessionContext,
    sessionId: string,
    specialist: string,
  ): Promise<void> {
    await this.model.updateOne(
      {
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        state: { $ne: 'ARCHIVED' },
      },
      { $set: { 'metadata.activeSpecialist': specialist } },
    );
  }

  /**
   * Archive a session atomically.
   * Contract: session-state-machine.md — IDLE/ACTIVE/GATE_PENDING/COMPLETE -> ARCHIVED
   *
   * Tries each valid source state in one atomic findOneAndUpdate
   * (no read-then-write race condition).
   */
  async archive(ctx: SessionContext, sessionId: string): Promise<ArchSession> {
    const doc = await this.model.findOneAndUpdate(
      {
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        state: buildCompatibleStateFilter(ARCHIVABLE_STATES),
      },
      { $set: { state: 'ARCHIVED', archivedAt: new Date() } },
      { new: true },
    );

    if (!doc) {
      // Distinguish "not found" from "already archived"
      const exists = await this.model.findOne({
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      });

      if (!exists) {
        throw new SessionNotFoundError(sessionId);
      }
      if (exists.state === 'ARCHIVED') {
        throw new SessionArchivedError(sessionId);
      }
      // Another request changed the state between our filter and fallback lookup.
      throw new InvalidTransitionError(exists.state, 'ARCHIVED');
    }

    return toArchSession(doc);
  }

  /**
   * Archive agent-editor sessions when their bound agent is renamed/deleted.
   *
   * Agent-editor sessions are scoped to a concrete agent name via agentNameKey.
   * Once that agent disappears, resuming the session would point Arch at a stale
   * editing boundary, so every non-terminal editor session for that tenant/project
   * and agent is archived across users. Project-level sessions are intentionally
   * left alone.
   */
  async archiveAgentEditorSessionsForAgent(
    ctx: SessionContext,
    projectId: string,
    agentName: string,
    reason: 'agent_renamed' | 'agent_deleted',
  ): Promise<number> {
    const normalizedProjectId = typeof projectId === 'string' ? projectId.trim() : '';
    const normalizedAgentName = typeof agentName === 'string' ? normalizeAgentName(agentName) : '';
    if (normalizedProjectId.length === 0 || normalizedAgentName.length === 0) {
      throw new Error('INVALID_SESSION_SCOPE');
    }

    const result = await this.model.updateMany(
      {
        tenantId: ctx.tenantId,
        'metadata.mode': 'IN_PROJECT',
        'metadata.projectId': normalizedProjectId,
        'metadata.surface': 'agent-editor',
        'metadata.agentNameKey': buildAgentNameKey(normalizedAgentName),
        state: buildCompatibleStateFilter(ARCHIVABLE_STATES),
      },
      { $set: { state: 'ARCHIVED', archivedAt: new Date() } },
    );

    const archivedCount = result.modifiedCount ?? result.matchedCount ?? 0;
    if (archivedCount > 0) {
      log.info('Archived agent-editor sessions for stale agent scope', {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        projectId: normalizedProjectId,
        agentName: normalizedAgentName,
        reason,
        archivedCount,
      });
    }

    return archivedCount;
  }

  /**
   * Atomically backtrack a BUILD session to BLUEPRINT for topology rework.
   *
   * Used when the scope classifier detects a LARGE mutation during BUILD phase —
   * the user wants to change the topology, so we revert to BLUEPRINT phase while
   * preserving specification and approvedAgents.
   *
   * Side effects:
   *   - metadata.phase → 'BLUEPRINT'
   *   - metadata.topologyApproved → false
   *   - metadata.buildProgress → null (cleared so BUILD re-entry initializes fresh)
   *   - specification + approvedAgents are preserved
   *
   * DONE_WITH_CONCERNS: This is a direct DB update that sidesteps the outbox-commit
   * model. The current (v1) design uses the same pattern (process-message.ts:220-236).
   * Kept for parity; a future M3 pass should integrate backtrack with the turn buffer.
   *
   * Returns the updated session, or null if the session was not found / not in BUILD.
   */
  async backtrackToBlueprintForRework(
    ctx: SessionContext,
    sessionId: string,
  ): Promise<ArchSession | null> {
    const doc = await this.model.findOneAndUpdate(
      {
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        'metadata.phase': 'BUILD',
        state: { $ne: 'ARCHIVED' },
      },
      {
        $set: {
          'metadata.phase': 'BLUEPRINT',
          'metadata.topologyApproved': false,
          'metadata.buildProgress': null,
        },
      },
      { new: true },
    );

    if (!doc) {
      return null;
    }

    log.info('Session backtracked BUILD → BLUEPRINT for topology rework', {
      sessionId,
      tenantId: ctx.tenantId,
    });

    return toArchSession(doc);
  }

  /**
   * Set or clear the cancelRequested flag for a session.
   *
   * Called by POST /api/arch-ai/sessions/:id/cancel to signal the TurnEngine
   * to abort the current generation pass. The engine polls this flag at every
   * tool boundary via cancelRequestedRead (engine-factory.ts) and emits
   * turn_ended with reason:'canceled' when it detects the flag set.
   *
   * Scoped to tenantId + userId so a caller cannot cancel another user's session.
   * No-op (non-throwing) if the session is already ARCHIVED — the turn has ended.
   */
  async setCancelRequested(ctx: SessionContext, sessionId: string, value: boolean): Promise<void> {
    await this.model.updateOne(
      {
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        state: { $ne: 'ARCHIVED' },
      },
      { $set: { cancelRequested: value } },
    );
  }

  /**
   * Delete a session with cascade.
   * Contract: api-index.md — DELETE /sessions/:id
   * Deletes the session document. Journal entries are embedded in metadata
   * so they cascade automatically.
   */
  async delete(ctx: SessionContext, sessionId: string): Promise<void> {
    const result = await this.model.deleteOne({
      _id: sessionId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    });

    if (result.deletedCount === 0) {
      throw new SessionNotFoundError(sessionId);
    }
  }
}
