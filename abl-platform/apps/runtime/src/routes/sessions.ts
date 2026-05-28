/**
 * Sessions API Routes (Project-Scoped)
 *
 * POST /api/projects/:projectId/sessions - Create a new test session
 * GET /api/projects/:projectId/sessions - List all sessions
 * GET /api/projects/:projectId/sessions/export - Export traces as CSV
 * GET /api/projects/:projectId/sessions/generations - List LLM call events across sessions
 * GET /api/projects/:projectId/sessions/:id - Get session details
 * POST /api/projects/:projectId/sessions/:id/pii/reveal - Reveal selected PII tokens with audit
 * DELETE /api/projects/:projectId/sessions/:id - Delete a session
 * GET /api/projects/:projectId/sessions/:id/traces - Get session traces (supports eventType, decisionKind, spanId, include=metrics)
 * GET /api/projects/:projectId/sessions/:id/traces/:spanId/children - Get child events for a span
 * GET /api/projects/:projectId/sessions/:id/metrics - Get aggregated session metrics
 * GET /api/projects/:projectId/sessions/:id/agent-spec - Get agent specification for session
 * GET /api/projects/:projectId/sessions/:id/analysis - Get trace analysis and diagnostics
 */

import { Router, type Request, type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import type { ContentBlock } from '@abl/compiler/platform/llm/types.js';
import { TestSessionService } from '../services/test-session.js';
import { getRuntimeExecutor } from '../services/runtime-executor.js';
import { buildAgentDetails } from '../services/dsl-utils.js';
import { getTraceStore, type TraceEvent as TraceStoreEvent } from '../services/trace-store.js';
import { authMiddleware } from '../middleware/auth.js';
import { isDatabaseAvailable } from '../db/index.js';
import {
  findAgentVersion,
  findProjectAgentByPath,
  findProjectAgentByName,
} from '../repos/project-repo.js';
import {
  listSessions,
  countSessions,
  findStoredSessionByAnyId,
  findMessagesForSession,
  findMessagesByIdsForSession,
  findMessagesForSessionCursor,
  listStoredSessionCleanupIds,
  resolveStoredSessionCompatibilityId,
  updateSession,
} from '../repos/session-repo.js';
import {
  requireProjectScope,
  createRequireSessionOwnership,
  buildSessionListFilter,
  toAuthContext,
  evaluateSessionOwnershipAccess,
  isElevatedPlatformRole,
} from '@agent-platform/shared-auth';
import type { CallerContext, TenantContextData } from '@agent-platform/shared-auth';
import type { CallDisposition } from '@abl/compiler/platform/core/types';
import type { TraceEvent, AgentDetails, AgentState } from '../types/index.js';
import { auditSessionModified } from '../services/audit-helpers.js';
import { requireProjectPermission, requireSensitiveProjectPermission } from '../middleware/rbac.js';
import { mergeSessionDimensions } from '../services/metadata/custom-dimensions.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { buildStoredSessionAccessSource } from '../services/identity/stored-session-access-source.js';
import { buildStoredSessionCallerContext } from '../services/identity/stored-session-caller-context.js';
import { createLogger, PIIVault } from '@abl/compiler/platform';
import {
  dedupeTraceEventsBySemanticResponse,
  mapClickHouseSessionEventRowsToTraceEvents,
  type ClickHouseSessionEventRow,
} from '../services/trace/clickhouse-session-trace-events.js';
import {
  PLATFORM_TO_TRACE_TYPE,
  RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
  RUNTIME_TRACE_TYPE_DATA_KEY,
  TRACE_TO_PLATFORM_TYPE,
} from '../services/trace-event-types.js';
import type { RuntimeSession } from '../services/execution/types.js';
import {
  isSessionTerminalizationEnabled,
  SessionTerminalizationService,
} from '../services/session-lifecycle/terminalization-service.js';
import { cleanupClosedSessionArtifacts } from '../services/session-lifecycle/artifact-cleanup.js';
import { buildLiveSessionVisibilityFilter } from '../services/session-activity.js';
import { SessionStateRepo } from '../services/session/session-state-repo.js';
import { buildProductionSessionLocator } from '../services/session/execution-scope.js';
import { getSessionWebSocket } from '../services/agent-transfer/message-bridge.js';
import { finalizeSessionReset } from '../services/session-reset.js';
import {
  renderSessionMessagesForUserSurface as scrubSessionMessagesForResponse,
  renderTraceEventsForReadSurface as scrubTraceEventsForResponse,
  type PIIReadSurfaceContext,
} from '../services/pii/runtime-pii-boundary-service.js';
import {
  MAX_PII_REVEAL_SELECTOR_COUNT,
  revealPIITokens,
  type PIITokenRevealActor,
} from '../services/pii/pii-token-vault-service.js';
import {
  buildStoredPIIReadSurfaceContext,
  refreshSessionPIIContext,
} from '../services/pii/session-pii-context.js';
import type { PersistedStructuredMessageEnvelopeV2 } from '../services/session/persisted-message-content.js';

const log = createLogger('sessions-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/sessions',
  tags: ['Sessions'],
});
const router: RouterType = openapi.router;
const terminalizationService = new SessionTerminalizationService();
let sessionStateRepo: SessionStateRepo | null = null;

function getSessionStateRepo(): SessionStateRepo {
  sessionStateRepo ??= new SessionStateRepo();
  return sessionStateRepo;
}

async function buildPIIReadSurfaceContext(
  runtimeSession?: RuntimeSession | null,
): Promise<PIIReadSurfaceContext | undefined> {
  if (runtimeSession) {
    await refreshSessionPIIContext(runtimeSession);
  }

  if (!runtimeSession?.piiRedactionConfig?.enabled) {
    return undefined;
  }

  if (!runtimeSession.piiVault) {
    runtimeSession.piiVault = new PIIVault({
      recognizerRegistry: runtimeSession.piiRecognizerRegistry,
    });
  } else {
    runtimeSession.piiVault.setRecognizerRegistry(runtimeSession.piiRecognizerRegistry);
  }

  return {
    piiRedactionConfig: runtimeSession.piiRedactionConfig,
    piiVault: runtimeSession.piiVault,
    piiPatternConfigs: runtimeSession.piiPatternConfigs,
  };
}

async function buildPIIReadSurfaceContextFromSessionState(params: {
  sessionId: string;
  tenantId: string;
  projectId: string;
}): Promise<PIIReadSurfaceContext | undefined> {
  let state: Awaited<ReturnType<SessionStateRepo['load']>> | null = null;
  try {
    state = await getSessionStateRepo().load(params.sessionId, params.tenantId, params.projectId);
  } catch (err) {
    log.debug('PII read context state load failed', {
      sessionId: params.sessionId,
      tenantId: params.tenantId,
      projectId: params.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }

  return buildStoredPIIReadSurfaceContext({
    tenantId: params.tenantId,
    projectId: params.projectId,
    piiVaultData: state?.piiVaultData,
    fallbackPIIRedactionConfig: state?.piiRedactionConfig ?? undefined,
  });
}

async function resolvePIIReadSurfaceContextForSessionIds(params: {
  sessionIds: string[];
  tenantId: string;
  projectId: string;
  allowRuntimeRehydrate?: boolean;
}): Promise<PIIReadSurfaceContext | undefined> {
  const executor = getRuntimeExecutor();
  const seen = new Set<string>();
  const sessionIds = params.sessionIds.filter((sessionId) => {
    const normalized = sessionId.trim();
    if (!normalized || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });

  for (const sessionId of sessionIds) {
    try {
      const runtimeSession =
        executor.getSession(sessionId) ??
        (params.allowRuntimeRehydrate === false
          ? null
          : await executor.rehydrateSession(sessionId));
      if (
        runtimeSession?.tenantId === params.tenantId &&
        runtimeSession.projectId === params.projectId
      ) {
        const context = await buildPIIReadSurfaceContext(runtimeSession);
        if (context) {
          return context;
        }
      }
    } catch (err) {
      log.debug('PII read context runtime lookup failed', {
        sessionId,
        tenantId: params.tenantId,
        projectId: params.projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const sessionId of sessionIds) {
    const context = await buildPIIReadSurfaceContextFromSessionState({
      sessionId,
      tenantId: params.tenantId,
      projectId: params.projectId,
    });
    if (context) {
      return context;
    }
  }

  return undefined;
}

// All session routes require authentication + rate limiting + project scope validation
router.use(authMiddleware);
router.use(tenantRateLimit('request'));
router.use(requireProjectScope('projectId'));

// Session ownership: SDK users can only access their own sessions.
// Loads session by :id param, checks identity match. User JWT and API key pass through.
const requireSessionOwnership = createRequireSessionOwnership({
  findSession: async (sessionId: string, tenantId: string) => {
    const session = await findStoredSessionByAnyId(sessionId, tenantId);
    if (!session) return null;
    const callerContext: CallerContext | undefined = buildStoredSessionCallerContext(
      session,
      tenantId,
    );
    return {
      callerContext,
      ownerUserId: session.initiatedById ?? undefined,
      source: buildStoredSessionAccessSource(session),
    };
  },
});
// Apply ownership check when any route with :id is matched.
// router.param triggers only for actual route matches (not bulk-close/cleanup-orphans).
router.param('id', (req, res, next, _id) => {
  (req as SessionIdAwareRequest).sessionRouteId = _id;
  // Express does not await promises returned from router.param handlers, so
  // rejected async ownership checks must be forwarded manually.
  void Promise.resolve(requireSessionOwnership(req, res, next)).catch(next);
});

type SessionIdAwareRequest = Request & {
  sessionRouteId?: string;
};

const PII_REVEAL_REASON_MAX_LENGTH = 1000;
const PII_REVEAL_TICKET_MAX_LENGTH = 200;
const PII_TOKEN_MARKER_REGEX = /\{\{PII:([^:}]+):([a-f0-9-]+)\}\}/gi;

const piiRevealSourceRefSchema = z
  .object({
    sourceMessageId: z.string().trim().min(1).optional(),
    sourceTraceId: z.string().trim().min(1).optional(),
    sourceSpanId: z.string().trim().min(1).optional(),
    sourceFieldPath: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => typeof field === 'string'), {
    message: 'sourceRefs entries must include at least one source identifier',
  });

const piiRevealRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(PII_REVEAL_REASON_MAX_LENGTH),
    ticketId: z.string().trim().min(1).max(PII_REVEAL_TICKET_MAX_LENGTH).optional(),
    tokenIds: z.array(z.string().trim().min(1)).max(MAX_PII_REVEAL_SELECTOR_COUNT).optional(),
    sourceRefs: z.array(piiRevealSourceRefSchema).max(MAX_PII_REVEAL_SELECTOR_COUNT).optional(),
  })
  .strict()
  .refine((value) => (value.tokenIds?.length ?? 0) + (value.sourceRefs?.length ?? 0) > 0, {
    message: 'tokenIds or sourceRefs are required',
    path: ['tokenIds'],
  })
  .refine(
    (value) =>
      (value.tokenIds?.length ?? 0) + (value.sourceRefs?.length ?? 0) <=
      MAX_PII_REVEAL_SELECTOR_COUNT,
    {
      message: `At most ${MAX_PII_REVEAL_SELECTOR_COUNT} tokenIds/sourceRefs can be revealed at once`,
      path: ['tokenIds'],
    },
  );

function getSessionRouteId(req: SessionIdAwareRequest): string {
  return req.params.id ?? req.sessionRouteId ?? '';
}

function collectPIITokenIds(value: unknown, tokenIds: Set<string>, seen = new WeakSet<object>()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PII_TOKEN_MARKER_REGEX)) {
      const tokenId = match[2]?.trim();
      if (tokenId) {
        tokenIds.add(tokenId);
      }
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPIITokenIds(item, tokenIds, seen);
    }
    return;
  }

  for (const nestedValue of Object.values(value as Record<string, unknown>)) {
    collectPIITokenIds(nestedValue, tokenIds, seen);
  }
}

async function expandMessageScopedPIIRevealTokenIds(params: {
  tenantId: string;
  projectId: string;
  sessionId: string;
  sourceRefs?: Array<z.infer<typeof piiRevealSourceRefSchema>>;
}): Promise<{ tokenIds: string[]; resolvedMessageIds: string[] }> {
  const messageIds = [
    ...new Set(
      (params.sourceRefs ?? [])
        .map((sourceRef) => sourceRef.sourceMessageId?.trim())
        .filter((messageId): messageId is string => Boolean(messageId)),
    ),
  ];
  if (messageIds.length === 0) {
    return { tokenIds: [], resolvedMessageIds: [] };
  }

  const messages = await findMessagesByIdsForSession(
    params.sessionId,
    messageIds,
    params.tenantId,
    params.projectId,
  );
  const tokenIds = new Set<string>();
  const tokenizedMessageIds = new Set<string>();
  for (const message of messages) {
    const beforeCount = tokenIds.size;
    collectPIITokenIds(message.content, tokenIds);
    collectPIITokenIds(message.rawContent, tokenIds);
    collectPIITokenIds(message.contentEnvelope, tokenIds);
    if (tokenIds.size > beforeCount) {
      tokenizedMessageIds.add(message.id);
    }
  }

  return {
    tokenIds: [...tokenIds],
    resolvedMessageIds: [...tokenizedMessageIds],
  };
}

function mergePIIRevealTokenIds(...groups: Array<string[] | undefined>): string[] {
  const tokenIds = new Set<string>();
  for (const group of groups) {
    for (const tokenId of group ?? []) {
      const normalized = tokenId.trim();
      if (normalized) {
        tokenIds.add(normalized);
      }
    }
  }
  return [...tokenIds];
}

function buildPIIRevealActor(ctx: TenantContextData): PIITokenRevealActor {
  return {
    actorId: ctx.apiKeyId ?? ctx.clientId ?? ctx.userId,
    authType: ctx.authType,
    role: ctx.role,
    ...(ctx.apiKeyId ? { apiKeyId: ctx.apiKeyId } : {}),
    ...(ctx.clientId ? { clientId: ctx.clientId } : {}),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const TERMINAL_SESSION_STATUSES = new Set([
  'ended',
  'completed',
  'escalated',
  'abandoned',
  'archived',
]);

function isTerminalSessionStatus(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_SESSION_STATUSES.has(status);
}

async function loadBufferedTraceEvents(
  sessionId: string,
  tenantId: string,
  diagnostics?: TraceReadDiagnostic[],
): Promise<TraceStoreEvent[]> {
  try {
    const store = getTraceStore();
    const storeEvents = await Promise.resolve(store.getEvents(sessionId, { tenantId }));
    return storeEvents;
  } catch (error) {
    log.warn('Distributed trace lookup failed', {
      sessionId,
      tenantId,
      error: getErrorMessage(error),
    });
    diagnostics?.push({
      source: 'memory',
      code: 'TRACE_BUFFER_LOOKUP_FAILED',
      message: 'Live trace buffer lookup failed; durable trace history will be used if available.',
    });
    return [];
  }
}

async function loadBufferedTraceEventsForCandidates(
  sessionIds: string[],
  tenantId: string,
  diagnostics?: TraceReadDiagnostic[],
): Promise<TraceStoreEvent[]> {
  for (const sessionId of sessionIds) {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) {
      continue;
    }

    const storeEvents = await loadBufferedTraceEvents(trimmedSessionId, tenantId, diagnostics);
    if (storeEvents.length > 0) {
      return storeEvents;
    }
  }

  return [];
}

type SessionAgentSpecPayload = {
  id: string;
  name: string;
  type?: string;
  mode?: string;
  dsl?: string;
  ir?: unknown;
  toolCount?: number;
  gatherFieldCount?: number;
  isSupervisor?: boolean;
};

function normalizeAgentLookupName(agentRef: string): string {
  if (!agentRef.includes('/')) {
    return agentRef;
  }

  return agentRef.split('/').pop() ?? agentRef;
}

function resolvePersistedSessionAgentName(session: {
  currentAgent: string;
  entryAgentName?: string | null;
}): string {
  if (typeof session.entryAgentName === 'string' && session.entryAgentName.trim().length > 0) {
    return session.entryAgentName;
  }

  return normalizeAgentLookupName(session.currentAgent);
}

function extractSessionAgentIR(irContent: string, fallbackName: string): unknown | undefined {
  try {
    const parsed = JSON.parse(irContent);
    const parsedRecord = asObjectRecord(parsed);
    if (!parsedRecord) {
      return parsed;
    }

    const agents = asObjectRecord(parsedRecord.agents);
    if (!agents) {
      return parsed;
    }

    const entryAgentName =
      (typeof parsedRecord.entry_agent === 'string' && parsedRecord.entry_agent) ||
      (typeof parsedRecord.entryAgent === 'string' && parsedRecord.entryAgent) ||
      fallbackName;

    return agents[entryAgentName] ?? agents[fallbackName] ?? Object.values(agents)[0] ?? parsed;
  } catch {
    return undefined;
  }
}

/**
 * Fetch full AgentDetails (DSL + compiled IR) from the database for a given
 * agent name scoped to a project. Returns null when the DB is unavailable or
 * the agent is not found. Used to enrich session detail responses so the Studio
 * debug panel IR tab is populated for both active and historical sessions.
 */
async function fetchAgentDetailsForSession(
  agentName: string,
  projectId: string,
  tenantId: string,
): Promise<AgentDetails | null> {
  if (!isDatabaseAvailable() || !agentName || !projectId) return null;
  try {
    let record = await findProjectAgentByPath(agentName, tenantId, { projectId });
    if (!record) {
      const name = agentName.includes('/') ? agentName.split('/').pop()! : agentName;
      record = await findProjectAgentByName(name, { tenantId, projectId });
    }
    if (!record?.dslContent) return null;
    return buildAgentDetails(record.dslContent, record.name);
  } catch {
    return null;
  }
}

function toSessionAgentSpecPayload(
  agentDetails: AgentDetails | null,
  name: string,
  options?: { dslContent?: string; irContent?: string },
): SessionAgentSpecPayload {
  const persistedIR =
    typeof options?.irContent === 'string'
      ? extractSessionAgentIR(options.irContent, name)
      : undefined;

  if (agentDetails) {
    return {
      id: agentDetails.id,
      name: agentDetails.name,
      type: agentDetails.type,
      mode: agentDetails.mode,
      dsl: agentDetails.dsl,
      ir: persistedIR ?? agentDetails.ir,
      toolCount: agentDetails.toolCount,
      gatherFieldCount: agentDetails.gatherFieldCount,
      isSupervisor: agentDetails.isSupervisor,
    };
  }

  return {
    id: name,
    name,
    ...(typeof options?.dslContent === 'string' ? { dsl: options.dslContent } : {}),
    ...(persistedIR !== undefined ? { ir: persistedIR } : {}),
  };
}

type RuntimeSessionListRecord = RuntimeSession & {
  metadata?: Record<string, unknown>;
  channel?: string;
};

type RuntimeSessionListSnapshot = {
  agentName: string;
  messageCount: number;
  createdAt: string;
  createdAtMs: number;
  lastActivityAt: string;
  lastActivityAtMs: number;
  channel?: string;
  activeAgent?: string;
  threadCount?: number;
  environment?: string;
};

type DbSessionListRecord = {
  id: string;
  currentAgent: string;
  entryAgentName?: string | null;
  channel?: string | null;
  status: string;
  messageCount?: number | null;
  tokenCount?: number | null;
  estimatedCost?: number | null;
  errorCount?: number | null;
  handoffCount?: number | null;
  traceEventCount?: number | null;
  callDuration?: number | null;
  disposition?: string | null;
  startedAt: Date;
  lastActivityAt: Date;
  endedAt?: Date | null;
  projectId: string;
  environment?: string | null;
  metadata?: Record<string, unknown> | null;
};

type SessionListEntry = {
  id: string;
  agentId: string;
  agentName: string;
  durationMs: number;
  messageCount: number;
  traceEventCount: number;
  tokenCount: number;
  estimatedCost: number;
  errorCount: number;
  disposition: string | null;
  createdAt: string;
  lastActivityAt: string;
  lastActivityAtMs: number;
  activeAgent?: string;
  threadCount?: number;
  status: string;
  channel?: string;
  projectId?: string;
  environment?: string;
};

type SessionDetailMessagePayload = {
  id: string;
  role: string;
  content: string;
  rawContent?: ContentBlock[];
  metadata?: Record<string, unknown>;
  contentEnvelope?: PersistedStructuredMessageEnvelopeV2;
  timestamp: string;
};

const MAX_SESSION_MESSAGES_ROUTE_PAGE_SIZE = 200;
const DEFAULT_SESSION_MESSAGES_ROUTE_PAGE_SIZE = 50;

function rawSessionMessageContentToString(rawContent: unknown[] | undefined): string {
  if (!Array.isArray(rawContent)) {
    return '';
  }

  return rawContent
    .map((block) => {
      if (
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
      ) {
        return block.text;
      }
      return '';
    })
    .join('')
    .trim();
}

function getComparableSessionMessageContent(message: SessionDetailMessagePayload): string {
  const directContent = message.content.trim();
  if (directContent.length > 0) {
    return directContent;
  }

  const envelopeText =
    typeof message.contentEnvelope?.text === 'string' ? message.contentEnvelope.text.trim() : '';
  if (envelopeText.length > 0) {
    return envelopeText;
  }

  return rawSessionMessageContentToString(message.rawContent);
}

function sessionDetailMessagesAreEquivalent(
  left: SessionDetailMessagePayload,
  right: SessionDetailMessagePayload,
): boolean {
  if (left.role !== right.role) {
    return false;
  }

  const leftContent = getComparableSessionMessageContent(left);
  const rightContent = getComparableSessionMessageContent(right);
  if (leftContent.length > 0 || rightContent.length > 0) {
    return leftContent === rightContent;
  }

  return JSON.stringify(left.rawContent ?? null) === JSON.stringify(right.rawContent ?? null);
}

function getSessionDetailMessageRichnessScore(message: SessionDetailMessagePayload): number {
  let score = 0;
  const envelope = message.contentEnvelope;

  if (envelope) {
    score += 4;
    if (envelope.blocks && envelope.blocks.length > 0) score += 2;
    if (envelope.richContent && Object.keys(envelope.richContent).length > 0) score += 2;
    if (envelope.actions?.elements && envelope.actions.elements.length > 0) score += 2;
    if (envelope.voiceConfig && Object.keys(envelope.voiceConfig).length > 0) score += 2;
    if (envelope.localization) score += 1;
  }

  if (message.rawContent && message.rawContent.length > 0) {
    score += 2;
  }
  if (message.metadata && Object.keys(message.metadata).length > 0) {
    score += 1;
  }

  return score;
}

function isSessionMessageMetadataRecord(metadata: unknown): metadata is Record<string, unknown> {
  return metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata);
}

function isInternalCoordinationMessage(message: SessionDetailMessagePayload): boolean {
  const metadata = message.metadata as unknown;
  if (!isSessionMessageMetadataRecord(metadata)) {
    return false;
  }

  if (metadata.responseVisibility === 'internal') {
    return true;
  }

  const coordination = metadata.coordination;
  return (
    coordination !== null &&
    typeof coordination === 'object' &&
    !Array.isArray(coordination) &&
    (coordination as Record<string, unknown>).visibility === 'internal'
  );
}

function filterCustomerVisibleSessionMessages(
  messages: SessionDetailMessagePayload[],
): SessionDetailMessagePayload[] {
  return messages.filter((message) => !isInternalCoordinationMessage(message));
}

function preferRicherEquivalentSessionMessage(
  persistedMessage: SessionDetailMessagePayload,
  runtimeMessage: SessionDetailMessagePayload,
): SessionDetailMessagePayload {
  const persistedRichness = getSessionDetailMessageRichnessScore(persistedMessage);
  const runtimeRichness = getSessionDetailMessageRichnessScore(runtimeMessage);

  if (runtimeRichness > persistedRichness) {
    return runtimeMessage;
  }

  if (
    runtimeRichness === persistedRichness &&
    runtimeMessage.role === 'assistant' &&
    JSON.stringify(runtimeMessage.contentEnvelope ?? null) !==
      JSON.stringify(persistedMessage.contentEnvelope ?? null)
  ) {
    return runtimeMessage;
  }

  return persistedMessage;
}

function mergeEquivalentSessionMessagePrefix(
  persistedMessages: SessionDetailMessagePayload[],
  runtimeMessages: SessionDetailMessagePayload[],
  length: number,
): SessionDetailMessagePayload[] {
  return Array.from({ length }, (_, index) =>
    preferRicherEquivalentSessionMessage(persistedMessages[index], runtimeMessages[index]),
  );
}

function getSessionMessageCommonPrefixLength(
  persistedMessages: SessionDetailMessagePayload[],
  runtimeMessages: SessionDetailMessagePayload[],
): number {
  const maxLength = Math.min(persistedMessages.length, runtimeMessages.length);
  let prefixLength = 0;

  while (
    prefixLength < maxLength &&
    sessionDetailMessagesAreEquivalent(
      persistedMessages[prefixLength],
      runtimeMessages[prefixLength],
    )
  ) {
    prefixLength += 1;
  }

  return prefixLength;
}

function getPersistedRuntimeOverlapLength(
  persistedMessages: SessionDetailMessagePayload[],
  runtimeMessages: SessionDetailMessagePayload[],
): number {
  const maxOverlap = Math.min(persistedMessages.length, runtimeMessages.length);

  for (let overlapLength = maxOverlap; overlapLength > 0; overlapLength -= 1) {
    let matches = true;

    for (let index = 0; index < overlapLength; index += 1) {
      const persistedIndex = persistedMessages.length - overlapLength + index;
      if (
        !sessionDetailMessagesAreEquivalent(
          persistedMessages[persistedIndex],
          runtimeMessages[index],
        )
      ) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return overlapLength;
    }
  }

  return 0;
}

export function mergeActiveSessionMessages(params: {
  runtimeMessages: SessionDetailMessagePayload[];
  persistedMessages: SessionDetailMessagePayload[];
}): SessionDetailMessagePayload[] {
  const { runtimeMessages, persistedMessages } = params;

  if (persistedMessages.length === 0) {
    return runtimeMessages;
  }

  if (runtimeMessages.length === 0) {
    return persistedMessages;
  }

  const commonPrefixLength = getSessionMessageCommonPrefixLength(
    persistedMessages,
    runtimeMessages,
  );
  if (
    commonPrefixLength === persistedMessages.length &&
    runtimeMessages.length >= persistedMessages.length
  ) {
    return [
      ...mergeEquivalentSessionMessagePrefix(
        persistedMessages,
        runtimeMessages,
        commonPrefixLength,
      ),
      ...runtimeMessages.slice(commonPrefixLength),
    ];
  }

  if (
    commonPrefixLength === runtimeMessages.length &&
    persistedMessages.length >= runtimeMessages.length
  ) {
    return [
      ...mergeEquivalentSessionMessagePrefix(
        persistedMessages,
        runtimeMessages,
        commonPrefixLength,
      ),
      ...persistedMessages.slice(commonPrefixLength),
    ];
  }

  const overlapLength = getPersistedRuntimeOverlapLength(persistedMessages, runtimeMessages);
  if (overlapLength > 0) {
    const persistedPrefix = persistedMessages.slice(0, persistedMessages.length - overlapLength);
    const persistedOverlap = persistedMessages.slice(persistedMessages.length - overlapLength);
    return [
      ...persistedPrefix,
      ...mergeEquivalentSessionMessagePrefix(persistedOverlap, runtimeMessages, overlapLength),
      ...runtimeMessages.slice(overlapLength),
    ];
  }

  return runtimeMessages.length > persistedMessages.length ? runtimeMessages : persistedMessages;
}

function mapPersistedMessagesToSessionDetailPayload(
  messages: Array<{
    id: string;
    role: string;
    content: string;
    rawContent?: ContentBlock[];
    metadata?: Record<string, unknown>;
    contentEnvelope?: PersistedStructuredMessageEnvelopeV2;
    timestamp: Date;
  }>,
): SessionDetailMessagePayload[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    ...(message.rawContent ? { rawContent: message.rawContent } : {}),
    ...(message.metadata ? { metadata: message.metadata } : {}),
    ...(message.contentEnvelope ? { contentEnvelope: message.contentEnvelope } : {}),
    timestamp: message.timestamp.toISOString(),
  }));
}

function normalizeSessionMessagesRouteLimit(limit?: number): number {
  return Math.min(
    limit ?? DEFAULT_SESSION_MESSAGES_ROUTE_PAGE_SIZE,
    MAX_SESSION_MESSAGES_ROUTE_PAGE_SIZE,
  );
}

function paginateMergedSessionMessages(
  messages: SessionDetailMessagePayload[],
  options: {
    cursor?: string;
    limit?: number;
    direction?: 'asc' | 'desc';
  } = {},
): {
  messages: SessionDetailMessagePayload[];
  nextCursor: string | null;
  hasMore: boolean;
} {
  const direction = options.direction ?? 'desc';
  const limit = normalizeSessionMessagesRouteLimit(options.limit);
  const cursor = options.cursor?.trim();

  if (messages.length === 0) {
    return { messages: [], nextCursor: null, hasMore: false };
  }

  const cursorIndex =
    cursor && cursor.length > 0 ? messages.findIndex((message) => message.id === cursor) : -1;
  const baseWindow =
    direction === 'asc'
      ? cursorIndex >= 0
        ? messages.slice(cursorIndex + 1)
        : messages
      : cursorIndex >= 0
        ? messages.slice(0, cursorIndex)
        : messages;
  const orderedWindow = direction === 'desc' ? [...baseWindow].reverse() : baseWindow;
  const hasMore = orderedWindow.length > limit;
  const page = hasMore ? orderedWindow.slice(0, limit) : orderedWindow;
  const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : null;

  return {
    messages: page,
    nextCursor,
    hasMore,
  };
}

async function loadProjectScopedRuntimeMessageSnapshot(params: {
  requestedSessionId: string;
  tenantId: string;
  projectId: string;
  candidateIds: string[];
}): Promise<SessionDetailMessagePayload[] | null> {
  const executor = getRuntimeExecutor();

  for (const candidateId of params.candidateIds) {
    const trimmedCandidate = candidateId.trim();
    if (!trimmedCandidate) {
      continue;
    }

    const liveSession =
      executor.getSession(trimmedCandidate) ?? (await executor.rehydrateSession(trimmedCandidate));
    if (!liveSession) {
      continue;
    }

    if (liveSession.tenantId !== params.tenantId || liveSession.projectId !== params.projectId) {
      continue;
    }

    const detail = executor.getSessionDetail(liveSession.id);
    if (!detail) {
      continue;
    }

    return detail.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      ...(message.rawContent ? { rawContent: message.rawContent } : {}),
      ...(message.metadata ? { metadata: message.metadata } : {}),
      ...('contentEnvelope' in message &&
      (message as { contentEnvelope?: PersistedStructuredMessageEnvelopeV2 }).contentEnvelope
        ? {
            contentEnvelope: (message as { contentEnvelope: PersistedStructuredMessageEnvelopeV2 })
              .contentEnvelope,
          }
        : {}),
      timestamp: message.timestamp,
    }));
  }

  return null;
}

function getLiveTraceEventCount(
  traceStore: ReturnType<typeof getTraceStore> | undefined,
  sessionId: string,
  persistedCount = 0,
): number {
  if (!traceStore?.getSessionInfo) {
    return persistedCount;
  }

  try {
    const info = traceStore.getSessionInfo(sessionId);
    if (!info || info.eventCount <= 0) {
      return persistedCount;
    }

    return Math.max(persistedCount, info.eventCount);
  } catch (error) {
    log.debug('Failed to read trace-store session info for session list', {
      sessionId,
      error: getErrorMessage(error),
    });
    return persistedCount;
  }
}

function getTraceStoreSafely(reason: string): ReturnType<typeof getTraceStore> | undefined {
  try {
    return getTraceStore();
  } catch (error) {
    log.debug(reason, {
      error: getErrorMessage(error),
    });
    return undefined;
  }
}

const SESSION_LIST_RANGE_PATTERN = /^(\d+)d$/i;
const TRUE_QUERY_VALUES = new Set(['1', 'true', 'yes']);
const FALSE_QUERY_VALUES = new Set(['0', 'false', 'no']);
type SessionListSortDir = 'asc' | 'desc';
type SessionNumberRange = { min?: number; max?: number };

function parseSessionListDate(value: unknown): Date | undefined | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseSessionListBoolean(value: unknown): boolean | undefined | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (TRUE_QUERY_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_QUERY_VALUES.has(normalized)) {
    return false;
  }

  return null;
}

function parseSessionListNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSessionListPaginationInt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function readSessionListNumberRange(minValue: unknown, maxValue: unknown): SessionNumberRange {
  return {
    min: parseSessionListNumber(minValue),
    max: parseSessionListNumber(maxValue),
  };
}

function readSessionListStringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      values
        .flatMap((item) => (typeof item === 'string' ? item.split(',') : []))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function addSessionNumericWhere(
  whereClauses: Record<string, unknown>[],
  field: string,
  range: SessionNumberRange,
): void {
  if (range.min === undefined && range.max === undefined) return;

  const condition: Record<string, number> = {};
  if (range.min !== undefined) condition.$gte = range.min;
  if (range.max !== undefined) condition.$lte = range.max;
  whereClauses.push({ [field]: condition });
}

function buildSessionListOrderBy(
  sortBy: string,
  sortDir: SessionListSortDir,
): Record<string, string> {
  switch (sortBy) {
    case 'id':
      return { _id: sortDir };
    case 'agentName':
      return { entryAgentName: sortDir, currentAgent: sortDir };
    case 'createdAt':
      return { startedAt: sortDir };
    case 'messageCount':
    case 'traceEventCount':
    case 'errorCount':
    case 'tokenCount':
    case 'estimatedCost':
    case 'status':
    case 'environment':
    case 'channel':
      return { [sortBy]: sortDir };
    default:
      return { lastActivityAt: sortDir };
  }
}

function resolveSessionListTimeRange(params: {
  from?: unknown;
  to?: unknown;
  range?: unknown;
}): { from?: Date; to?: Date } | { error: string } {
  const from = parseSessionListDate(params.from);
  if (from === null) {
    return { error: 'from must be a valid ISO 8601 timestamp' };
  }

  const to = parseSessionListDate(params.to);
  if (to === null) {
    return { error: 'to must be a valid ISO 8601 timestamp' };
  }

  if (typeof params.range === 'string' && params.range.trim().length > 0) {
    const match = params.range.trim().match(SESSION_LIST_RANGE_PATTERN);
    if (!match) {
      return { error: 'range must be in Nd format (for example 7d or 90d)' };
    }

    const days = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(days) || days < 1) {
      return { error: 'range must be a positive number of days' };
    }

    const rangeTo = to ?? new Date();
    const rangeFrom = new Date(rangeTo.getTime() - days * 24 * 60 * 60 * 1000);
    if (rangeFrom.getTime() > rangeTo.getTime()) {
      return { error: 'from must be before or equal to to' };
    }
    return { from: rangeFrom, to: rangeTo };
  }

  if (from && to && from.getTime() > to.getTime()) {
    return { error: 'from must be before or equal to to' };
  }

  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

function isRuntimeSessionOwnedByUser(session: RuntimeSession, userId: string): boolean {
  if (typeof session.userId === 'string' && session.userId === userId) {
    return true;
  }

  return session.callerContext?.initiatedById === userId;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildAgentNameSearchPattern(filter: string): string | null {
  const normalized = filter
    .trim()
    .toLowerCase()
    .replace(/[_\s-]/g, '');
  if (normalized.length === 0) {
    return null;
  }

  // Treat underscores, spaces, and hyphens as equivalent separators so
  // persisted and runtime-only sessions resolve agent filters the same way.
  return normalized
    .split('')
    .map((char) => escapeRegex(char))
    .join('[_\\s-]*');
}

function environmentMatches(actual: string | null | undefined, filter: string): boolean {
  return typeof actual === 'string' && actual.trim().toLowerCase() === filter.trim().toLowerCase();
}

function buildRuntimeOnlySessions(
  runtimeSessions: ReadonlyMap<string, RuntimeSessionListSnapshot>,
  options: {
    traceStore?: ReturnType<typeof getTraceStore>;
    projectId: string;
    excludeIds?: ReadonlySet<string>;
    nowMs: number;
  },
): SessionListEntry[] {
  const excludeIds = options.excludeIds ?? new Set<string>();

  return Array.from(runtimeSessions.entries())
    .filter(([sessionId]) => !excludeIds.has(sessionId))
    .map(([sessionId, runtimeInfo]) => ({
      id: sessionId,
      agentId: runtimeInfo.agentName,
      agentName: runtimeInfo.agentName,
      durationMs: Math.max(0, options.nowMs - runtimeInfo.createdAtMs),
      messageCount: runtimeInfo.messageCount,
      traceEventCount: getLiveTraceEventCount(options.traceStore, sessionId),
      tokenCount: 0,
      estimatedCost: 0,
      errorCount: 0,
      disposition: null,
      createdAt: runtimeInfo.createdAt,
      lastActivityAt: runtimeInfo.lastActivityAt,
      lastActivityAtMs: runtimeInfo.lastActivityAtMs,
      activeAgent: runtimeInfo.activeAgent,
      threadCount: runtimeInfo.threadCount,
      status: 'active',
      channel: runtimeInfo.channel,
      projectId: options.projectId,
      environment: runtimeInfo.environment,
    }));
}

function sortSessionList(
  entries: SessionListEntry[],
  sortBy = 'lastActivityAt',
  sortDir: SessionListSortDir = 'desc',
): SessionListEntry[] {
  return [...entries].sort((a, b) => {
    let comparison = 0;
    switch (sortBy) {
      case 'id':
        comparison = a.id.localeCompare(b.id);
        break;
      case 'agentName':
        comparison = a.agentName.localeCompare(b.agentName);
        break;
      case 'status':
        comparison = a.status.localeCompare(b.status);
        break;
      case 'environment':
        comparison = (a.environment ?? '').localeCompare(b.environment ?? '');
        break;
      case 'channel':
        comparison = (a.channel ?? '').localeCompare(b.channel ?? '');
        break;
      case 'createdAt':
        comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        break;
      case 'durationMs':
        comparison = a.durationMs - b.durationMs;
        break;
      case 'messageCount':
        comparison = a.messageCount - b.messageCount;
        break;
      case 'traceEventCount':
        comparison = a.traceEventCount - b.traceEventCount;
        break;
      case 'errorCount':
        comparison = a.errorCount - b.errorCount;
        break;
      case 'tokenCount':
        comparison = a.tokenCount - b.tokenCount;
        break;
      case 'estimatedCost':
        comparison = a.estimatedCost - b.estimatedCost;
        break;
      default:
        comparison = a.lastActivityAtMs - b.lastActivityAtMs;
        break;
    }
    return sortDir === 'asc' ? comparison : -comparison;
  });
}

function sessionListEntryMatchesNumericFilters(
  entry: SessionListEntry,
  filters: Record<string, SessionNumberRange>,
): boolean {
  return Object.entries(filters).every(([field, range]) => {
    const value = entry[field as keyof SessionListEntry];
    if (typeof value !== 'number') return true;
    if (range.min !== undefined && value < range.min) return false;
    if (range.max !== undefined && value > range.max) return false;
    return true;
  });
}

function hasSessionPostFilters(filters: Record<string, SessionNumberRange>): boolean {
  const durationRange = filters.durationMs;
  return durationRange?.min !== undefined || durationRange?.max !== undefined;
}

function toSessionListResponse(
  entries: SessionListEntry[],
): Array<Omit<SessionListEntry, 'lastActivityAtMs'>> {
  return entries.map(({ lastActivityAtMs, ...session }) => session);
}

function toClickHouseSessionEventRowRecord(
  row: ClickHouseSessionEventRow,
): Record<string, unknown> {
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    category: row.category,
    span_id: row.span_id,
    parent_span_id: row.parent_span_id,
    turn_id: row.turn_id,
    execution_id: row.execution_id,
    parent_execution_id: row.parent_execution_id,
    agent_run_id: row.agent_run_id,
    decision_id: row.decision_id,
    parent_decision_id: row.parent_decision_id,
    cause_event_id: row.cause_event_id,
    phase: row.phase,
    reason_code: row.reason_code,
    agent_name: row.agent_name,
    timestamp: row.timestamp,
    duration_ms: row.duration_ms,
    has_error: row.has_error,
    data: row.data,
    _enc: row._enc,
  };
}

function fromClickHouseSessionEventRowRecord(
  row: Record<string, unknown>,
): ClickHouseSessionEventRow {
  return {
    event_id: typeof row.event_id === 'string' ? row.event_id : '',
    event_type: typeof row.event_type === 'string' ? row.event_type : '',
    category: typeof row.category === 'string' ? row.category : '',
    span_id: typeof row.span_id === 'string' ? row.span_id : '',
    parent_span_id: typeof row.parent_span_id === 'string' ? row.parent_span_id : '',
    turn_id: typeof row.turn_id === 'string' ? row.turn_id : '',
    execution_id: typeof row.execution_id === 'string' ? row.execution_id : '',
    parent_execution_id: typeof row.parent_execution_id === 'string' ? row.parent_execution_id : '',
    agent_run_id: typeof row.agent_run_id === 'string' ? row.agent_run_id : '',
    decision_id: typeof row.decision_id === 'string' ? row.decision_id : '',
    parent_decision_id: typeof row.parent_decision_id === 'string' ? row.parent_decision_id : '',
    cause_event_id: typeof row.cause_event_id === 'string' ? row.cause_event_id : '',
    phase: typeof row.phase === 'string' ? row.phase : '',
    reason_code: typeof row.reason_code === 'string' ? row.reason_code : '',
    agent_name: typeof row.agent_name === 'string' ? row.agent_name : '',
    timestamp: typeof row.timestamp === 'string' ? row.timestamp : '',
    duration_ms: typeof row.duration_ms === 'number' ? row.duration_ms : 0,
    has_error: typeof row.has_error === 'number' ? row.has_error : 0,
    data: typeof row.data === 'string' ? row.data : (asObjectRecord(row.data) ?? {}),
    _enc: typeof row._enc === 'string' ? row._enc : '',
  };
}

type ProjectScopedTraceSessionResolution =
  | { kind: 'authorized'; traceQuerySessionId: string; liveTraceSessionIds: string[] }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

type StoredSessionOwnershipSource = Parameters<typeof buildStoredSessionCallerContext>[0] & {
  initiatedById?: unknown;
};

interface RuntimeSessionOwnershipSource {
  callerContext?: CallerContext;
  userId?: unknown;
  channelType?: unknown;
}

function hasProjectScopedStoredSessionAccess(
  session: { projectId?: unknown },
  projectId: string,
): boolean {
  return typeof session.projectId === 'string' && session.projectId === projectId;
}

function buildLiveTraceSessionIds(
  requestedSessionId: string,
  session: { id?: unknown; _id?: unknown; runtimeSessionId?: unknown },
): string[] {
  const candidates = [requestedSessionId, session.runtimeSessionId, session.id, session._id];
  const uniqueCandidates = new Set<string>();

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmedCandidate = candidate.trim();
    if (trimmedCandidate.length === 0) {
      continue;
    }
    uniqueCandidates.add(trimmedCandidate);
  }

  return Array.from(uniqueCandidates);
}

function resolveAuthorizedRuntimeTraceSession(
  sessionId: string,
  tenantId: string,
  projectId: string,
): ProjectScopedTraceSessionResolution {
  try {
    const executor = getRuntimeExecutor();
    const session = executor.getSession(sessionId);
    if (!session) {
      return { kind: 'not_found' };
    }

    const sessionTenant = session.tenantId || null;
    const sessionProjectId = typeof session.projectId === 'string' ? session.projectId : null;
    if (sessionTenant !== tenantId || sessionProjectId !== projectId) {
      return { kind: 'not_found' };
    }

    return {
      kind: 'authorized',
      traceQuerySessionId: sessionId,
      liveTraceSessionIds: [sessionId],
    };
  } catch {
    return { kind: 'not_found' };
  }
}

function hasStoredSessionOwnershipAccess(
  tenantCtx: TenantContextData | undefined,
  session: StoredSessionOwnershipSource,
): boolean {
  const tenantId =
    tenantCtx?.tenantId || (typeof session.tenantId === 'string' ? session.tenantId : '');
  const access = evaluateSessionOwnershipAccess(tenantCtx, {
    callerContext: buildStoredSessionCallerContext(session, tenantId),
    ownerUserId: typeof session.initiatedById === 'string' ? session.initiatedById : undefined,
    source: buildStoredSessionAccessSource(session),
  });
  return access.allowed;
}

function hasRuntimeSessionOwnershipAccess(
  tenantCtx: TenantContextData | undefined,
  session: RuntimeSessionOwnershipSource,
): boolean {
  const ownerUserId =
    typeof session.userId === 'string'
      ? session.userId
      : typeof session.callerContext?.initiatedById === 'string'
        ? session.callerContext.initiatedById
        : undefined;
  const access = evaluateSessionOwnershipAccess(tenantCtx, {
    callerContext: session.callerContext,
    ownerUserId,
    source:
      session.channelType === 'web_debug'
        ? { type: 'studio', workspaceUserId: ownerUserId }
        : undefined,
  });
  return access.allowed;
}

async function resolveProjectScopedTraceSession(
  sessionId: string,
  tenantCtx: TenantContextData | undefined,
  projectId: string,
): Promise<ProjectScopedTraceSessionResolution> {
  const tenantId = tenantCtx?.tenantId;
  if (!tenantId) {
    return { kind: 'not_found' };
  }

  let dbUnavailable = false;

  try {
    const dbSession = await findStoredSessionByAnyId(sessionId, tenantId);
    if (dbSession) {
      if (!hasProjectScopedStoredSessionAccess(dbSession, projectId)) {
        return { kind: 'not_found' };
      }
      if (!hasStoredSessionOwnershipAccess(tenantCtx, dbSession)) {
        return { kind: 'not_found' };
      }

      return {
        kind: 'authorized',
        traceQuerySessionId: resolveStoredSessionCompatibilityId(dbSession, sessionId),
        liveTraceSessionIds: buildLiveTraceSessionIds(sessionId, dbSession),
      };
    }
  } catch {
    dbUnavailable = true;
  }

  const runtimeResolution = resolveAuthorizedRuntimeTraceSession(sessionId, tenantId, projectId);
  if (runtimeResolution.kind === 'authorized') {
    if (
      tenantCtx?.authType === 'sdk_session' ||
      (tenantCtx?.authType === 'user' && !isElevatedPlatformRole(tenantCtx.role))
    ) {
      return dbUnavailable ? { kind: 'unavailable' } : { kind: 'not_found' };
    }
    return {
      ...runtimeResolution,
      liveTraceSessionIds: [sessionId],
    };
  }

  return dbUnavailable ? { kind: 'unavailable' } : { kind: 'not_found' };
}

type CurrentDeveloperSessionSource = 'runtime' | 'cold_state' | 'persisted_summary';

type CurrentDeveloperSessionCandidate = {
  sessionId: string;
  source: CurrentDeveloperSessionSource;
  lastActivityAtMs: number;
};

type CurrentDeveloperSessionPayload = {
  identitySession: {
    tenantId: string;
    projectId: string;
    userId: string;
    authType?: string;
  };
  clientAttachment: {
    kind: 'studio_websocket';
    status: 'attached' | 'detached';
    channel: 'web_debug';
    resumable: true;
  };
  executionSession: {
    sessionId: string;
    projectId: string;
    tenantId: string;
    agentName: string;
    channel: 'web_debug';
    source: CurrentDeveloperSessionSource;
    state: 'running' | 'waiting_for_user' | 'completed' | 'escalated';
    createdAt: string;
    lastActivityAt: string;
  };
  resume: {
    sessionId: string;
    canResume: true;
    agent: AgentDetails;
    messageCount: number;
    lastActivityAt: string;
  };
};

type ResumeAgentIrLike = {
  flow?: unknown;
  tools?: unknown[];
  gather?: { fields?: unknown[] };
  coordination?: { handoffs?: unknown[] };
  routing?: { rules?: unknown[] };
};

function normalizeDeveloperSessionChannel(channel: string | null | undefined): string | null {
  if (!channel) {
    return null;
  }

  if (channel === 'debug_websocket') {
    return 'web_debug';
  }

  return channel;
}

function resolveRuntimeSessionChannel(session: RuntimeSession): string | null {
  const sessionNamespace = asObjectRecord(session.data?.values?.session);
  const sessionChannel =
    typeof sessionNamespace?.channel === 'string' ? sessionNamespace.channel : undefined;

  return normalizeDeveloperSessionChannel(
    session.callerContext?.channel ?? sessionChannel ?? session.channelType ?? null,
  );
}

function classifyExecutionSessionState(
  session: RuntimeSession,
): CurrentDeveloperSessionPayload['executionSession']['state'] {
  if (session.isComplete) {
    return 'completed';
  }

  if (session.isEscalated) {
    return 'escalated';
  }

  const activeThread = session.threads[session.activeThreadIndex];
  if (
    (Array.isArray(session.waitingForInput) && session.waitingForInput.length > 0) ||
    activeThread?.status === 'waiting'
  ) {
    return 'waiting_for_user';
  }

  return 'running';
}

function countRuntimeSessionMessages(session: RuntimeSession): number {
  const threadMessages = session.threads.reduce((total, thread) => {
    return (
      total +
      thread.conversationHistory.filter(
        (message) => message.role === 'user' || message.role === 'assistant',
      ).length
    );
  }, 0);

  if (threadMessages > 0) {
    return threadMessages;
  }

  return session.conversationHistory.filter(
    (message) => message.role === 'user' || message.role === 'assistant',
  ).length;
}

function buildCurrentDeveloperResumeAgent(session: RuntimeSession): AgentDetails {
  const entryAgentName = session.threads[0]?.agentName ?? session.agentName;
  const compilationAgents = session.compilationOutput?.agents as
    | Record<string, ResumeAgentIrLike>
    | undefined;
  const entryAgentIr = compilationAgents?.[entryAgentName];
  const agentIr = entryAgentIr ?? (session.agentIR as ResumeAgentIrLike | null) ?? null;
  const toolCount = Array.isArray(agentIr?.tools) ? agentIr.tools.length : 0;
  const gatherFieldCount = Array.isArray(agentIr?.gather?.fields)
    ? agentIr.gather.fields.length
    : 0;
  const isSupervisor =
    (Array.isArray(agentIr?.coordination?.handoffs) && agentIr.coordination.handoffs.length > 0) ||
    (Array.isArray(agentIr?.routing?.rules) && agentIr.routing.rules.length > 0);

  return {
    id: entryAgentName,
    name: entryAgentName,
    filePath: '',
    type: isSupervisor ? 'supervisor' : 'agent',
    mode: agentIr?.flow ? 'scripted' : 'reasoning',
    toolCount,
    gatherFieldCount,
    isSupervisor,
    dsl: '',
  };
}

function buildCurrentDeveloperSessionPayload(params: {
  tenantContext: TenantContextData;
  projectId: string;
  requestedUserId: string;
  source: CurrentDeveloperSessionSource;
  session: RuntimeSession;
}): CurrentDeveloperSessionPayload {
  const entryAgentName = params.session.threads[0]?.agentName ?? params.session.agentName;
  const channel = normalizeDeveloperSessionChannel(resolveRuntimeSessionChannel(params.session));
  const lastActivityAt = params.session.lastActivityAt.toISOString();
  const createdAt = params.session.createdAt.toISOString();
  const isAttached = Boolean(getSessionWebSocket(params.session.id));

  return {
    identitySession: {
      tenantId: params.tenantContext.tenantId,
      projectId: params.projectId,
      userId: params.requestedUserId,
      ...(params.tenantContext.authType ? { authType: params.tenantContext.authType } : {}),
    },
    clientAttachment: {
      kind: 'studio_websocket',
      status: isAttached ? 'attached' : 'detached',
      channel: (channel ?? 'web_debug') as 'web_debug',
      resumable: true,
    },
    executionSession: {
      sessionId: params.session.id,
      projectId: params.session.projectId ?? params.projectId,
      tenantId: params.session.tenantId ?? params.tenantContext.tenantId,
      agentName: entryAgentName,
      channel: (channel ?? 'web_debug') as 'web_debug',
      source: params.source,
      state: classifyExecutionSessionState(params.session),
      createdAt,
      lastActivityAt,
    },
    resume: {
      sessionId: params.session.id,
      canResume: true,
      agent: buildCurrentDeveloperResumeAgent(params.session),
      messageCount: countRuntimeSessionMessages(params.session),
      lastActivityAt,
    },
  };
}

async function resolveDeveloperExecutionSessionById(params: {
  sessionId: string;
  source: CurrentDeveloperSessionSource;
  tenantContext: TenantContextData;
  projectId: string;
  requestedUserId: string;
  channel: 'web_debug';
  agentName?: string;
}): Promise<CurrentDeveloperSessionPayload | null> {
  const executor = getRuntimeExecutor();
  const locator = buildProductionSessionLocator({
    tenantId: params.tenantContext.tenantId,
    projectId: params.projectId,
    sessionId: params.sessionId,
  });

  const inMemorySession = executor.getSession(params.sessionId);
  let runtimeSession = inMemorySession;
  if (!runtimeSession) {
    const rehydratedSession = await executor.rehydrateSession(
      params.sessionId,
      locator ? { locator } : undefined,
    );
    if (!rehydratedSession) {
      return null;
    }
    runtimeSession = rehydratedSession;
  }

  if (!runtimeSession) {
    return null;
  }

  if (
    runtimeSession.tenantId !== params.tenantContext.tenantId ||
    runtimeSession.projectId !== params.projectId
  ) {
    return null;
  }

  if (!hasRuntimeSessionOwnershipAccess(params.tenantContext, runtimeSession)) {
    return null;
  }

  if (resolveRuntimeSessionChannel(runtimeSession) !== params.channel) {
    return null;
  }

  const entryAgentName = runtimeSession.threads[0]?.agentName ?? runtimeSession.agentName;
  if (
    params.agentName &&
    !agentNameMatches(entryAgentName, params.agentName) &&
    !agentNameMatches(runtimeSession.agentName, params.agentName)
  ) {
    return null;
  }

  return buildCurrentDeveloperSessionPayload({
    tenantContext: params.tenantContext,
    projectId: params.projectId,
    requestedUserId: params.requestedUserId,
    source: inMemorySession ? 'runtime' : params.source,
    session: runtimeSession,
  });
}

async function findCurrentDeveloperExecutionSession(params: {
  tenantContext: TenantContextData;
  projectId: string;
  requestedUserId: string;
  channel: 'web_debug';
  agentName?: string;
}): Promise<CurrentDeveloperSessionPayload | null> {
  const candidateBySessionId = new Map<string, CurrentDeveloperSessionCandidate>();
  const executor = getRuntimeExecutor();

  try {
    for (const summary of executor.listSessions()) {
      const runtimeSession = executor.getSession(summary.id);
      if (!runtimeSession) {
        continue;
      }

      if (
        runtimeSession.tenantId !== params.tenantContext.tenantId ||
        runtimeSession.projectId !== params.projectId
      ) {
        continue;
      }

      if (!hasRuntimeSessionOwnershipAccess(params.tenantContext, runtimeSession)) {
        continue;
      }

      if (resolveRuntimeSessionChannel(runtimeSession) !== params.channel) {
        continue;
      }

      const entryAgentName = runtimeSession.threads[0]?.agentName ?? runtimeSession.agentName;
      if (
        params.agentName &&
        !agentNameMatches(entryAgentName, params.agentName) &&
        !agentNameMatches(runtimeSession.agentName, params.agentName)
      ) {
        continue;
      }

      candidateBySessionId.set(runtimeSession.id, {
        sessionId: runtimeSession.id,
        source: 'runtime',
        lastActivityAtMs: runtimeSession.lastActivityAt.getTime(),
      });
    }
  } catch (error) {
    log.debug('Runtime executor unavailable while resolving current developer session', {
      projectId: params.projectId,
      tenantId: params.tenantContext.tenantId,
      error: getErrorMessage(error),
    });
  }

  try {
    const coldCandidates = await getSessionStateRepo().findLatestOwnedSessionSummaries({
      tenantId: params.tenantContext.tenantId,
      projectId: params.projectId,
      userId: params.requestedUserId,
      channel: params.channel,
      agentName: params.agentName,
      limit: 5,
    });

    for (const candidate of coldCandidates) {
      if (!candidateBySessionId.has(candidate.id)) {
        candidateBySessionId.set(candidate.id, {
          sessionId: candidate.id,
          source: 'cold_state',
          lastActivityAtMs: candidate.lastActivityAt.getTime(),
        });
      }
    }
  } catch (error) {
    log.warn('Cold execution-session lookup failed while resolving current developer session', {
      projectId: params.projectId,
      tenantId: params.tenantContext.tenantId,
      userId: params.requestedUserId,
      error: getErrorMessage(error),
    });
  }

  if (isDatabaseAvailable()) {
    try {
      const { Session } = await import('@agent-platform/database/models');
      const dbCandidates = (await Session.find(
        {
          tenantId: params.tenantContext.tenantId,
          projectId: params.projectId,
          initiatedById: params.requestedUserId,
          channel: params.channel,
          status: { $in: ['active', 'idle'] },
          ...(params.agentName
            ? {
                $or: [
                  { entryAgentName: { $regex: escapeRegex(params.agentName), $options: 'i' } },
                  { currentAgent: { $regex: escapeRegex(params.agentName), $options: 'i' } },
                ],
              }
            : {}),
        },
        {
          _id: 1,
          entryAgentName: 1,
          currentAgent: 1,
          lastActivityAt: 1,
        },
      )
        .sort({ lastActivityAt: -1 })
        .limit(5)
        .lean()) as Array<{
        _id?: string;
        entryAgentName?: string | null;
        currentAgent?: string | null;
        lastActivityAt?: Date | null;
      }>;

      for (const candidate of dbCandidates) {
        const sessionId = typeof candidate._id === 'string' ? candidate._id : '';
        if (!sessionId || candidateBySessionId.has(sessionId)) {
          continue;
        }

        candidateBySessionId.set(sessionId, {
          sessionId,
          source: 'persisted_summary',
          lastActivityAtMs:
            candidate.lastActivityAt instanceof Date
              ? candidate.lastActivityAt.getTime()
              : Date.now(),
        });
      }
    } catch (error) {
      log.warn('Persisted summary lookup failed while resolving current developer session', {
        projectId: params.projectId,
        tenantId: params.tenantContext.tenantId,
        userId: params.requestedUserId,
        error: getErrorMessage(error),
      });
    }
  }

  const sortedCandidates = [...candidateBySessionId.values()].sort(
    (left, right) => right.lastActivityAtMs - left.lastActivityAtMs,
  );

  for (const candidate of sortedCandidates) {
    const resolved = await resolveDeveloperExecutionSessionById({
      sessionId: candidate.sessionId,
      source: candidate.source,
      tenantContext: params.tenantContext,
      projectId: params.projectId,
      requestedUserId: params.requestedUserId,
      channel: params.channel,
      agentName: params.agentName,
    });
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

// =============================================================================
// CURRENT / ATTACH — must be registered BEFORE /:id to avoid Express param collision
// =============================================================================

router.get('/current', async (req, res) => {
  const projectId = String((req.params as Record<string, string | undefined>).projectId ?? '');

  try {
    if (!(await requireProjectPermission(req, res, 'session:read'))) return;

    const tenantContext = req.tenantContext;
    const requestedUserId = tenantContext?.userId;

    if (!tenantContext?.tenantId || !requestedUserId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'USER_CONTEXT_REQUIRED',
          message: 'Current developer session lookup requires a user context',
        },
      });
      return;
    }

    const channel =
      typeof req.query.channel === 'string' && req.query.channel === 'web_debug'
        ? 'web_debug'
        : 'web_debug';
    const agentName =
      typeof req.query.agentName === 'string' && req.query.agentName.trim().length > 0
        ? req.query.agentName.trim()
        : undefined;

    const data = await findCurrentDeveloperExecutionSession({
      tenantContext,
      projectId,
      requestedUserId,
      channel,
      agentName,
    });

    res.json({ success: true, data });
  } catch (error) {
    log.error('Failed to resolve current developer session', {
      projectId,
      error: getErrorMessage(error),
    });
    res.status(500).json({
      success: false,
      error: {
        code: 'CURRENT_SESSION_LOOKUP_FAILED',
        message: 'Failed to resolve current developer session',
      },
    });
  }
});

router.post('/attach', async (req, res) => {
  const projectId = String((req.params as Record<string, string | undefined>).projectId ?? '');

  try {
    if (!(await requireProjectPermission(req, res, 'session:read'))) return;

    const tenantContext = req.tenantContext;
    const requestedUserId = tenantContext?.userId;

    if (!tenantContext?.tenantId || !requestedUserId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'USER_CONTEXT_REQUIRED',
          message: 'Developer session attachment requires a user context',
        },
      });
      return;
    }

    const body = z
      .object({
        sessionId: z.string().min(1),
        channel: z.literal('web_debug').optional(),
        agentName: z.string().min(1).optional(),
      })
      .strict()
      .safeParse(req.body);

    if (!body.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_BODY',
          message: 'Invalid attach request body',
          details: body.error.flatten(),
        },
      });
      return;
    }

    const data = await resolveDeveloperExecutionSessionById({
      sessionId: body.data.sessionId,
      source: 'runtime',
      tenantContext,
      projectId,
      requestedUserId,
      channel: body.data.channel ?? 'web_debug',
      agentName: body.data.agentName,
    });

    if (!data) {
      res.status(404).json({
        success: false,
        error: {
          code: 'SESSION_NOT_FOUND',
          message: 'Session not found or no longer resumable',
        },
      });
      return;
    }

    res.json({ success: true, data });
  } catch (error) {
    log.error('Failed to validate developer session attachment', {
      projectId,
      error: getErrorMessage(error),
    });
    res.status(500).json({
      success: false,
      error: {
        code: 'ATTACH_VALIDATION_FAILED',
        message: 'Failed to validate developer session attachment',
      },
    });
  }
});

/**
 * POST /api/projects/:projectId/sessions
 * Create a new test session for an agent
 */
openapi.route(
  'post',
  '/',
  {
    summary: 'Create a new session',
    description: 'Create a new test session for an agent',
    body: z.object({
      agentId: z.string().describe('Agent ID or path (e.g., "domain/agent-name")'),
    }),
    response: z.object({
      success: z.boolean(),
      session: z.object({
        id: z.string(),
        agentId: z.string(),
        agentName: z.string(),
        createdAt: z.string(),
      }),
    }),
    successStatus: 201,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:execute'))) return;

      const { agentId } = req.body;
      const projectId = req.params.projectId;

      if (!agentId) {
        res.status(400).json({
          success: false,
          error: 'Missing required field: agentId',
        });
        return;
      }

      // Load agent from database, scoped to this project
      let agent = null;
      if (isDatabaseAvailable()) {
        // Try by agentPath first, then by name
        const tenantId = req.tenantContext!.tenantId;
        let record = await findProjectAgentByPath(agentId, tenantId, { projectId });
        if (!record) {
          const name = agentId.includes('/') ? agentId.split('/').pop()! : agentId;
          record = await findProjectAgentByName(name, {
            tenantId,
            projectId,
          });
        }
        if (record?.dslContent) {
          agent = buildAgentDetails(record.dslContent, record.name);
        }
      }

      if (!agent) {
        res.status(404).json({
          success: false,
          error: `Agent not found in database: ${agentId}`,
        });
        return;
      }

      const session = TestSessionService.createSession(agent);

      res.status(201).json({
        success: true,
        session: {
          id: session.id,
          agentId: session.agent.id,
          agentName: session.agent.name,
          createdAt: session.createdAt,
        },
      });
    } catch (error) {
      log.error('Error creating session', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to create session',
      });
    }
  },
);

/**
 * GET /api/projects/:projectId/sessions
 * List sessions from DB (enterprise persistence) + RuntimeExecutor (active sessions).
 * DB is the primary source for historical sessions; RuntimeExecutor augments with live status.
 * Query params: ?limit=50&offset=0&status=active&channel=web_debug
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'List sessions',
    description:
      'List all sessions with pagination and filtering (query params: limit, offset, status, channel, agentName, disposition, environment, mine, from, to, range)',
    response: z.object({
      success: z.boolean(),
      sessions: z.array(
        z.object({
          id: z.string(),
          agentPath: z.string(),
          channel: z.string().optional(),
          environment: z.string().optional(),
          status: z.string(),
          createdAt: z.string(),
        }),
      ),
      pagination: z
        .object({
          total: z.number(),
          limit: z.number(),
          offset: z.number(),
        })
        .optional(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const limit = Math.min(parseSessionListPaginationInt(req.query.limit) ?? 50, 200);
      const offset = parseSessionListPaginationInt(req.query.offset) ?? 0;
      const statusFilters = readSessionListStringList(req.query.status);
      const channelFilters = readSessionListStringList(req.query.channel);
      const agentNameFilters = readSessionListStringList(req.query.agentName);
      const environmentFilters = readSessionListStringList(req.query.environment);
      const dispositionFilter =
        typeof req.query.disposition === 'string' && req.query.disposition.trim().length > 0
          ? req.query.disposition.trim()
          : undefined;
      const outcomeFilter =
        typeof req.query.outcome === 'string' && req.query.outcome.trim().length > 0
          ? req.query.outcome.trim()
          : undefined;
      const searchQuery =
        typeof req.query.q === 'string' && req.query.q.trim().length > 0
          ? req.query.q.trim()
          : undefined;
      const sortBy =
        typeof req.query.sortBy === 'string' && req.query.sortBy.trim().length > 0
          ? req.query.sortBy.trim()
          : 'lastActivityAt';
      const sortDir = req.query.sortDir === 'asc' ? 'asc' : 'desc';
      const numericFilters = {
        durationMs: readSessionListNumberRange(req.query.minDurationMs, req.query.maxDurationMs),
        messageCount: readSessionListNumberRange(
          req.query.minMessageCount,
          req.query.maxMessageCount,
        ),
        traceEventCount: readSessionListNumberRange(
          req.query.minTraceEventCount,
          req.query.maxTraceEventCount,
        ),
        errorCount: readSessionListNumberRange(req.query.minErrorCount, req.query.maxErrorCount),
        tokenCount: readSessionListNumberRange(req.query.minTokenCount, req.query.maxTokenCount),
        estimatedCost: readSessionListNumberRange(req.query.minCost, req.query.maxCost),
      };
      const mineFilter = parseSessionListBoolean(req.query.mine);
      if (mineFilter === null) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_QUERY', message: 'mine must be a boolean query value' },
        });
        return;
      }

      const timeRange = resolveSessionListTimeRange({
        from: req.query.from,
        to: req.query.to,
        range: req.query.range,
      });
      if ('error' in timeRange) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_QUERY', message: timeRange.error },
        });
        return;
      }

      if (
        mineFilter === true &&
        req.tenantContext?.authType !== 'sdk_session' &&
        !req.tenantContext?.userId
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_QUERY',
            message: 'mine can only be used when the caller is associated with a user',
          },
        });
        return;
      }

      const projectId = req.params.projectId;
      const nowMs = Date.now();

      // Build a map of active runtime sessions for status augmentation of
      // persisted rows and for the RuntimeExecutor-only fallback below.
      const runtimeSessionMap = new Map<string, RuntimeSessionListSnapshot>();
      let traceStore: ReturnType<typeof getTraceStore> | undefined;
      try {
        const executor = getRuntimeExecutor();
        traceStore = getTraceStoreSafely('TraceStore unavailable while listing sessions');
        const callerTenant = req.tenantContext!.tenantId;
        for (const s of executor.listSessions()) {
          const fullSession = executor.getSession(s.id);
          if (!fullSession) continue;
          if (fullSession.tenantId !== callerTenant) continue;
          if (fullSession.projectId !== projectId) continue;
          if (!hasRuntimeSessionOwnershipAccess(req.tenantContext, fullSession)) continue;
          if (mineFilter === true) {
            const callerUserId = req.tenantContext?.userId;
            if (!callerUserId || !isRuntimeSessionOwnedByUser(fullSession, callerUserId)) {
              continue;
            }
          }

          const runtimeSession = fullSession as RuntimeSessionListRecord;
          const runtimeMetadata = asObjectRecord(runtimeSession.metadata);
          const runtimeChannelType =
            typeof runtimeMetadata?.channelType === 'string'
              ? runtimeMetadata.channelType
              : undefined;
          const runtimeChannel =
            typeof runtimeSession.channel === 'string' ? runtimeSession.channel : undefined;
          const resolvedRuntimeChannel =
            runtimeChannelType || runtimeSession.channelType || runtimeChannel;

          if (channelFilters.length > 0 && !channelFilters.includes(resolvedRuntimeChannel ?? '')) {
            continue;
          }

          const runtimeEnvironment = fullSession.versionInfo?.environment;
          if (
            environmentFilters.length > 0 &&
            !environmentFilters.some((environment) =>
              environmentMatches(runtimeEnvironment, environment),
            )
          ) {
            continue;
          }

          if (statusFilters.length > 0 && !statusFilters.includes('active')) {
            continue;
          }

          if (
            agentNameFilters.length > 0 &&
            !agentNameFilters.some((agentName) => agentNameMatches(s.agentName, agentName))
          ) {
            continue;
          }

          if (dispositionFilter) {
            continue;
          }

          const runtimeLastActivityAtMs = new Date(s.lastActivityAt).getTime();
          if (timeRange.from && runtimeLastActivityAtMs < timeRange.from.getTime()) {
            continue;
          }
          if (timeRange.to && runtimeLastActivityAtMs > timeRange.to.getTime()) {
            continue;
          }

          runtimeSessionMap.set(s.id, {
            agentName: s.agentName,
            messageCount: s.messageCount,
            createdAt: s.createdAt,
            createdAtMs: new Date(s.createdAt).getTime(),
            lastActivityAt: s.lastActivityAt,
            lastActivityAtMs: new Date(s.lastActivityAt).getTime(),
            channel: resolvedRuntimeChannel,
            activeAgent: s.activeAgent,
            threadCount: s.threadCount,
            environment: runtimeEnvironment,
          });
        }
      } catch (error) {
        log.debug('RuntimeExecutor unavailable while listing sessions', {
          error: getErrorMessage(error),
        });
      }

      // Query DB for sessions (primary source)
      if (isDatabaseAvailable()) {
        try {
          // Build base filter: for SDK auth, scope to caller's own sessions;
          // for platform members / API keys, scope to project only.
          let where: Record<string, unknown>;
          const tenantCtx = req.tenantContext;
          if (tenantCtx?.authType === 'sdk_session') {
            const authCtx = toAuthContext(tenantCtx);
            where = buildSessionListFilter(authCtx, projectId);
          } else {
            where = {};
            where.tenantId = req.tenantContext!.tenantId;
            where.projectId = projectId;
          }

          if (
            mineFilter === true &&
            tenantCtx?.authType !== 'sdk_session' &&
            req.tenantContext?.userId
          ) {
            where.initiatedById = req.tenantContext.userId;
          }

          const whereClauses: Record<string, unknown>[] = [where];
          if (statusFilters.length > 0) {
            whereClauses.push({ status: { $in: statusFilters } });
          }
          if (channelFilters.length > 0) {
            whereClauses.push({
              $or: [
                { channel: { $in: channelFilters } },
                { 'metadata.channelType': { $in: channelFilters } },
              ],
            });
          }
          if (agentNameFilters.length > 0) {
            const agentNamePatterns = agentNameFilters
              .map((agentName) => buildAgentNameSearchPattern(agentName))
              .filter((pattern): pattern is string => Boolean(pattern));
            if (agentNamePatterns.length > 0) {
              whereClauses.push({
                $or: agentNamePatterns.flatMap((agentNamePattern) => [
                  { currentAgent: { $regex: agentNamePattern, $options: 'i' } },
                  { entryAgentName: { $regex: agentNamePattern, $options: 'i' } },
                ]),
              });
            }
          }
          if (environmentFilters.length > 0) {
            whereClauses.push({
              $or: environmentFilters.map((environment) => ({
                environment: { $regex: `^${escapeRegex(environment)}$`, $options: 'i' },
              })),
            });
          }
          if (dispositionFilter) {
            whereClauses.push({ disposition: dispositionFilter });
          }
          if (outcomeFilter) {
            whereClauses.push({ outcome: outcomeFilter });
          }
          if (searchQuery) {
            const searchPattern = escapeRegex(searchQuery);
            const agentNamePattern = buildAgentNameSearchPattern(searchQuery);
            whereClauses.push({
              $or: [
                { _id: { $regex: searchPattern, $options: 'i' } },
                { currentAgent: { $regex: agentNamePattern ?? searchPattern, $options: 'i' } },
                { entryAgentName: { $regex: agentNamePattern ?? searchPattern, $options: 'i' } },
              ],
            });
          }
          addSessionNumericWhere(whereClauses, 'messageCount', numericFilters.messageCount);
          addSessionNumericWhere(whereClauses, 'traceEventCount', numericFilters.traceEventCount);
          addSessionNumericWhere(whereClauses, 'errorCount', numericFilters.errorCount);
          addSessionNumericWhere(whereClauses, 'tokenCount', numericFilters.tokenCount);
          addSessionNumericWhere(whereClauses, 'estimatedCost', numericFilters.estimatedCost);
          if (timeRange.from || timeRange.to) {
            const lastActivityAt: Record<string, Date> = {};
            if (timeRange.from) {
              lastActivityAt.$gte = timeRange.from;
            }
            if (timeRange.to) {
              lastActivityAt.$lte = timeRange.to;
            }
            whereClauses.push({ lastActivityAt });
          }

          const scopedWhere = whereClauses.length === 1 ? whereClauses[0]! : { $and: whereClauses };
          const liveWhere: Record<string, unknown> = {
            $and: [scopedWhere, buildLiveSessionVisibilityFilter(nowMs)],
          };

          // Do not include runtime-only (in-memory, not-yet-persisted) sessions in
          // the list. In a multipod deployment each pod's executor holds only its
          // own in-memory sessions, so including them causes the list to flicker
          // between different session sets on every poll as requests land on
          // different pods. DB-persisted sessions (the source below) are shared
          // and stable across all pods.
          // Run both MongoDB queries in parallel:
          // 1. countSessions — total for pagination
          // 2. main listSessions — the actual page of results
          const needsPostFilterPagination = hasSessionPostFilters(numericFilters);
          const dbPageOffset = needsPostFilterPagination ? 0 : offset;
          const dbPageLimit = needsPostFilterPagination
            ? Math.min(offset + limit + 200, 1000)
            : limit;

          const [dbTotal, dbSessions] = (await Promise.all([
            countSessions(liveWhere),
            listSessions(liveWhere, {
              orderBy: buildSessionListOrderBy(sortBy, sortDir),
              skip: dbPageOffset,
              take: dbPageLimit,
              select: {
                id: true,
                currentAgent: true,
                entryAgentName: true,
                channel: true,
                status: true,
                messageCount: true,
                tokenCount: true,
                estimatedCost: true,
                errorCount: true,
                handoffCount: true,
                traceEventCount: true,
                callDuration: true,
                disposition: true,
                outcome: true,
                dispositionCode: true,
                startedAt: true,
                lastActivityAt: true,
                endedAt: true,
                projectId: true,
                environment: true,
                metadata: true,
              },
            }),
          ])) as [number, DbSessionListRecord[]];

          const traceStoreForList =
            traceStore ?? getTraceStoreSafely('TraceStore unavailable while listing sessions');
          let durableTraceCounts = new Map<string, number>();
          try {
            durableTraceCounts = await countClickHousePlatformEventsBySession(
              dbSessions.map((session) => session.id),
              req.tenantContext!.tenantId,
              { projectId },
            );
          } catch (error) {
            log.debug('ClickHouse trace count lookup failed for session list', {
              tenantId: req.tenantContext!.tenantId,
              error: getErrorMessage(error),
            });
          }

          const mergedSessions: SessionListEntry[] = dbSessions.map((s) => {
            // Session._id is the canonical runtime session identifier.
            const runtimeInfo = runtimeSessionMap.get(s.id);
            const isActive = Boolean(runtimeInfo);
            const persistedAgentName = resolvePersistedSessionAgentName(s);
            const metadata = asObjectRecord(s.metadata);
            const exactChannelType =
              typeof metadata?.channelType === 'string' ? metadata.channelType : undefined;
            const messageCount = runtimeInfo?.messageCount || s.messageCount || 0;
            let durationMs = 0;
            if (typeof s.callDuration === 'number' && s.callDuration > 0) {
              durationMs = s.callDuration * 1000;
            } else if (s.endedAt) {
              durationMs = s.endedAt.getTime() - s.startedAt.getTime();
            } else if (isActive) {
              durationMs = nowMs - s.startedAt.getTime();
            } else if (messageCount > 0) {
              durationMs = s.lastActivityAt.getTime() - s.startedAt.getTime();
            }
            const persistedTraceEventCount = s.traceEventCount || 0;
            const liveTraceEventCount = getLiveTraceEventCount(
              traceStoreForList,
              s.id,
              persistedTraceEventCount,
            );
            const durableTraceEventCount = durableTraceCounts.get(s.id) || 0;

            return {
              id: s.id,
              agentId: s.currentAgent,
              agentName: runtimeInfo?.agentName || persistedAgentName,
              durationMs: Math.max(0, durationMs),
              messageCount,
              traceEventCount: Math.max(
                persistedTraceEventCount,
                liveTraceEventCount,
                durableTraceEventCount,
              ),
              tokenCount: s.tokenCount || 0,
              estimatedCost: s.estimatedCost || 0,
              errorCount: s.errorCount || 0,
              disposition: s.disposition || null,
              createdAt: s.startedAt.toISOString(),
              lastActivityAt: s.lastActivityAt.toISOString(),
              lastActivityAtMs: s.lastActivityAt.getTime(),
              activeAgent: runtimeInfo?.activeAgent,
              threadCount: runtimeInfo?.threadCount,
              status: isActive ? 'active' : s.status,
              channel: exactChannelType || s.channel || undefined,
              projectId: s.projectId,
              environment: runtimeInfo?.environment || s.environment || undefined,
            };
          });

          const allSessions = sortSessionList(
            mergedSessions.filter((session) =>
              sessionListEntryMatchesNumericFilters(session, numericFilters),
            ),
            sortBy,
            sortDir,
          );
          const paginatedSessions = toSessionListResponse(
            needsPostFilterPagination ? allSessions.slice(offset, offset + limit) : allSessions,
          );

          res.set('Cache-Control', 'private, max-age=5, stale-while-revalidate=10');
          res.json({
            success: true,
            total: hasSessionPostFilters(numericFilters) ? allSessions.length : dbTotal,
            offset,
            limit,
            sessions: paginatedSessions,
          });
          return;
        } catch (err) {
          log.warn('DB session listing failed, falling back to RuntimeExecutor', {
            error: getErrorMessage(err),
          });
        }
      }

      // Fallback: RuntimeExecutor only (no DB available)
      const allSessions = sortSessionList(
        buildRuntimeOnlySessions(runtimeSessionMap, {
          traceStore,
          projectId,
          nowMs,
        }),
      );

      res.json({
        success: true,
        total: allSessions.length,
        offset,
        limit,
        sessions: toSessionListResponse(allSessions.slice(offset, offset + limit)),
      });
    } catch (error) {
      log.error('Error listing sessions', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to list sessions',
      });
    }
  },
);

// =============================================================================
// BULK CLOSE — must be registered BEFORE /:id to avoid Express param collision
// =============================================================================

/**
 * Match a project agent slug (e.g. "authentication") against a DSL agent name
 * (e.g. "Authentication_Agent"). Normalises both by lowercasing and stripping
 * underscores / spaces / hyphens, then checks whether the DSL name contains the slug.
 */
function agentNameMatches(sessionAgentName: string, projectSlug: string): boolean {
  const pattern = buildAgentNameSearchPattern(projectSlug);
  return pattern ? new RegExp(pattern, 'i').test(sessionAgentName) : false;
}

/**
 * Map a CallDisposition to a SessionStatus.
 */
function dispositionToStatus(disposition: CallDisposition): string {
  if (disposition === 'completed') return 'completed';
  if (disposition === 'transferred') return 'escalated';
  return 'abandoned';
}

const VALID_DISPOSITIONS: CallDisposition[] = [
  'completed',
  'abandoned',
  'agent_hangup',
  'transferred',
  'failed',
  'timeout',
];
const ORPHAN_CLEANUP_MIN_AGE_MS = 5 * 60_000;

/**
 * GET /api/projects/:projectId/sessions/search?q=<text>&limit=20
 * Search message content across all sessions in a project.
 */
router.get('/search', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'session:read'))) return;

    const projectId = (req.params as Record<string, string>).projectId;
    const tenantId = (req as any).tenantContext?.tenantId;
    const userId = (req as any).tenantContext?.userId;
    const isAdmin = isElevatedPlatformRole((req as any).tenantContext?.role);

    if (!tenantId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_TENANT', message: 'Tenant context required' },
      });
      return;
    }

    const query = String(req.query.q || '').trim();
    if (!query || query.length < 2) {
      res.json({ success: true, results: [] });
      return;
    }

    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 50);

    if (!isDatabaseAvailable()) {
      res.json({ success: true, results: [] });
      return;
    }

    const { Message, Session: SessionModel } = await import('@agent-platform/database/models');

    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const messageFilter: Record<string, unknown> = {
      tenantId,
      projectId,
      role: { $in: ['user', 'assistant'] },
      content: { $regex: escapedQuery, $options: 'i' },
    };

    if (!isAdmin && userId) {
      const ownedSessions = await SessionModel.find(
        { tenantId, projectId, initiatedById: userId },
        { _id: 1 },
      ).lean();
      const ownedSessionIds = ownedSessions.map((s: any) => s._id as string);
      if (ownedSessionIds.length === 0) {
        res.json({ success: true, results: [] });
        return;
      }
      messageFilter.sessionId = { $in: ownedSessionIds };
    }

    const matchingMessages = await Message.aggregate([
      { $match: messageFilter },
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: '$sessionId',
          snippet: { $first: '$content' },
          role: { $first: '$role' },
          matchedAt: { $first: '$timestamp' },
          messageCount: { $sum: 1 },
        },
      },
      { $sort: { matchedAt: -1 } },
      { $limit: limit },
    ]).exec();

    const sessionIds = matchingMessages.map((m: any) => m._id);
    const sessions = await SessionModel.find(
      { _id: { $in: sessionIds }, tenantId },
      {
        _id: 1,
        agentName: 1,
        entryAgentName: 1,
        status: 1,
        createdAt: 1,
        lastActivityAt: 1,
        messageCount: 1,
        runtimeSessionId: 1,
      },
    ).lean();

    const sessionMap = new Map<string, any>(sessions.map((s: any) => [s._id as string, s]));

    const results = matchingMessages.map((m: any) => {
      const session: any = sessionMap.get(m._id);
      const rawSnippet = typeof m.snippet === 'string' ? m.snippet : JSON.stringify(m.snippet);
      const snippet = rawSnippet.length > 120 ? rawSnippet.slice(0, 120) + '...' : rawSnippet;

      return {
        sessionId: m._id,
        snippet,
        snippetRole: m.role,
        matchedAt: m.matchedAt,
        matchCount: m.messageCount,
        agentName: session?.entryAgentName || session?.agentName || 'unknown',
        status: session?.status || 'unknown',
        messageCount: session?.messageCount || 0,
        lastActivityAt: session?.lastActivityAt || m.matchedAt,
        runtimeSessionId: session?.runtimeSessionId,
      };
    });

    res.json({ success: true, results });
  } catch (err) {
    log.error('Session search failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'SEARCH_FAILED', message: 'Failed to search sessions' },
    });
  }
});

/**
 * POST /api/projects/:projectId/sessions/bulk-close
 * Close all matching sessions for a project/agent.
 * Body: { agentName?: string, disposition?: CallDisposition }
 */
router.post('/bulk-close', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'session:execute'))) return;

    const projectId = (req.params as Record<string, string>).projectId;
    const { agentName, disposition: rawDisposition } = req.body;
    const disposition: CallDisposition = VALID_DISPOSITIONS.includes(rawDisposition)
      ? rawDisposition
      : 'abandoned';

    const tenantId = req.tenantContext!.tenantId;
    let closedRuntime = 0;
    let closedDb = 0;
    const cleanupSessionIds = new Set<string>();

    if (isSessionTerminalizationEnabled()) {
      const candidateSessionIds = new Set<string>();

      try {
        const executor = getRuntimeExecutor();
        const candidates = executor.listSessions();
        for (const sessionSummary of candidates) {
          if (agentName && !agentNameMatches(sessionSummary.agentName, agentName)) continue;
          const session = executor.getSession(sessionSummary.id);
          if (!session) continue;
          const sessionTenant = session.tenantId || null;
          if (sessionTenant !== tenantId || session.projectId !== projectId) continue;
          candidateSessionIds.add(sessionSummary.id);
        }
      } catch {
        /* RuntimeExecutor not initialized */
      }

      if (isDatabaseAvailable()) {
        const { Session } = await import('@agent-platform/database/models');
        const where: Record<string, unknown> = {
          projectId,
          status: { $in: ['active', 'idle', 'ended'] },
          tenantId,
        };

        if (agentName) {
          where.currentAgent = { $regex: agentName, $options: 'i' };
        }

        const dbCandidates = (await Session.find(where, {
          _id: 1,
          runtimeSessionId: 1,
        }).lean()) as Array<{
          _id?: string;
          runtimeSessionId?: string | null;
        }>;

        for (const candidate of dbCandidates) {
          const candidateId = candidate.runtimeSessionId ?? candidate._id ?? '';
          if (candidateId) {
            candidateSessionIds.add(candidateId);
          }
        }
      }

      for (const candidateSessionId of candidateSessionIds) {
        const result = await terminalizationService.terminateConversationSession({
          tenantId,
          projectId,
          sessionId: candidateSessionId,
          disposition,
          source: 'bulk_close',
        });

        if (!result) {
          continue;
        }

        if (result.runtimeEnded) {
          closedRuntime++;
        }
        if (result.dbUpdated) {
          closedDb++;
        }
        for (const cleanupSessionId of result.artifactSessionIds) {
          cleanupSessionIds.add(cleanupSessionId);
        }
      }

      await cleanupClosedSessionArtifacts(cleanupSessionIds);

      res.json({
        success: true,
        closedRuntime,
        closedDb,
      });
      return;
    }

    // 1. Close matching RuntimeExecutor sessions (with tenant isolation)
    try {
      const executor = getRuntimeExecutor();
      // Snapshot IDs first to avoid mutating the map during iteration
      const candidates = executor.listSessions();
      for (const s of candidates) {
        if (agentName && !agentNameMatches(s.agentName, agentName)) continue;
        // Tenant isolation: verify session belongs to caller's tenant
        const session = executor.getSession(s.id);
        if (session) {
          const sessionTenant = session.tenantId || null;
          if (sessionTenant !== tenantId || session.projectId !== projectId) continue;
        }
        executor.endSession(s.id);
        try {
          getTraceStore().removeSession(s.id);
        } catch {
          /* ignore */
        }
        cleanupSessionIds.add(s.id);
        closedRuntime++;
      }
    } catch {
      /* RuntimeExecutor not initialized */
    }

    // 2. Bulk update DB sessions (only those still alive)
    if (isDatabaseAvailable()) {
      const { Session } = await import('@agent-platform/database/models');
      const where: Record<string, unknown> = {
        projectId,
        status: { $in: ['active', 'idle', 'ended'] },
        tenantId,
      };

      // If agentName provided, filter by regex match (case-insensitive)
      if (agentName) {
        where.currentAgent = { $regex: agentName, $options: 'i' };
      }

      const cleanupCandidates = await listStoredSessionCleanupIds(where);
      for (const cleanupSessionId of cleanupCandidates) {
        cleanupSessionIds.add(cleanupSessionId);
      }

      const result = await Session.updateMany(where, {
        $set: {
          status: dispositionToStatus(disposition),
          disposition,
          endedAt: new Date(),
          lastActivityAt: new Date(),
        },
      });
      closedDb = result.modifiedCount;
    }

    await cleanupClosedSessionArtifacts(cleanupSessionIds);

    res.json({
      success: true,
      closedRuntime,
      closedDb,
    });
  } catch (error) {
    log.error('Error in bulk-close', { error: getErrorMessage(error) });
    res.status(500).json({ success: false, error: 'Failed to bulk close sessions' });
  }
});

/**
 * POST /api/projects/:projectId/sessions/cleanup-orphans
 * Delete orphaned/phantom sessions that were never fully initialized.
 *
 * An orphan must match ALL of:
 *   - messageCount === 0 (no user interaction ever happened)
 *   - not currently active in the runtime executor
 *   - status is still 'active' or 'idle' (not legitimately ended/abandoned by user)
 *
 * This is conservative by design — it only deletes sessions that clearly
 * never received any traffic.
 */
router.post('/cleanup-orphans', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'session:delete'))) return;

    if (!isDatabaseAvailable()) {
      res.status(503).json({ success: false, error: 'Database not available' });
      return;
    }

    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;
    const { Session } = await import('@agent-platform/database/models');
    const orphanCutoff = new Date(Date.now() - ORPHAN_CLEANUP_MIN_AGE_MS);

    // All conditions must match (AND) — conservative orphan detection
    const orphanFilter: Record<string, unknown> = {
      // Never received any messages
      $or: [{ messageCount: 0 }, { messageCount: { $exists: false } }],
      // Still marked active (not legitimately ended/abandoned by a user)
      status: { $in: ['active', 'idle'] },
      // Scope to caller's tenant
      tenantId,
      // Scope to this project
      projectId,
      // Give async persistence a grace window before declaring a session orphaned.
      startedAt: { $lt: orphanCutoff },
    };

    const dryRun = req.query.dryRun === 'true';

    const resolveOrphanCandidateId = (candidate: Record<string, unknown>): string => {
      const runtimeSessionId = candidate.runtimeSessionId;
      if (typeof runtimeSessionId === 'string' && runtimeSessionId.length > 0) {
        return runtimeSessionId;
      }

      const id = candidate.id;
      if (typeof id === 'string' && id.length > 0) {
        return id;
      }

      const rawId = candidate._id;
      return typeof rawId === 'string' && rawId.length > 0 ? rawId : '';
    };

    const filterOrphanCandidates = async (
      candidates: Array<Record<string, unknown>>,
    ): Promise<Array<Record<string, unknown>>> => {
      const candidateIds = candidates
        .map(resolveOrphanCandidateId)
        .filter((candidateId) => candidateId.length > 0);
      if (candidateIds.length === 0) {
        return [];
      }

      const { Message, Attachment } = await import('@agent-platform/database/models');
      const [messageSessionIds, attachmentSessionIds] = await Promise.all([
        Message.distinct('sessionId', {
          tenantId,
          projectId,
          sessionId: { $in: candidateIds },
        }),
        Attachment.distinct('sessionId', {
          tenantId,
          projectId,
          sessionId: { $in: candidateIds },
        }),
      ]);

      const protectedSessionIds = new Set(
        [...messageSessionIds, ...attachmentSessionIds]
          .filter((value) => typeof value === 'string' && value.length > 0)
          .map((value) => String(value)),
      );

      return candidates.filter((candidate) => {
        const candidateId = resolveOrphanCandidateId(candidate);
        return candidateId.length > 0 && !protectedSessionIds.has(candidateId);
      });
    };

    if (dryRun) {
      const orphanCandidates = (await Session.find(orphanFilter)
        .select({ _id: 1, currentAgent: 1, startedAt: 1, status: 1 })
        .lean()) as Array<Record<string, unknown>>;
      const orphans = await filterOrphanCandidates(orphanCandidates);
      res.json({
        success: true,
        dryRun: true,
        orphanCount: orphans.length,
        orphans: orphans.map((o: any) => ({
          id: o._id,
          agent: o.currentAgent,
          startedAt: o.startedAt,
          status: o.status,
        })),
      });
      return;
    }

    const orphanCandidates = (await Session.find(orphanFilter)
      .select({ _id: 1, id: 1, runtimeSessionId: 1 })
      .lean()) as Array<Record<string, unknown>>;
    const orphanIds = (await filterOrphanCandidates(orphanCandidates)).map(
      resolveOrphanCandidateId,
    );

    let deletedDb = 0;
    if (orphanIds.length > 0) {
      const { deleteSession: cascadeDeleteSession } =
        await import('@agent-platform/database/cascade');
      for (const id of orphanIds) {
        const result = await cascadeDeleteSession(id);
        deletedDb += result.total;
      }
    }

    res.json({
      success: true,
      deletedDb,
    });
  } catch (error) {
    log.error('Error cleaning up orphans', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to clean up orphan sessions' });
  }
});

/**
 * GET /api/projects/:projectId/sessions/export
 * Export session traces as CSV.
 * Query params: sessionIds (comma-separated), eventType, decisionKind
 */
router.get('/export', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'session:read'))) return;

    const MAX_EXPORT_SESSIONS = 20;
    const sessionIds = req.query.sessionIds ? (req.query.sessionIds as string).split(',') : [];
    const eventType = req.query.eventType as string | undefined;
    const decisionKind = req.query.decisionKind as string | undefined;
    const tenantId = req.tenantContext!.tenantId;

    if (sessionIds.length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_SESSION_IDS', message: 'sessionIds query parameter is required' },
      });
      return;
    }

    if (sessionIds.length > MAX_EXPORT_SESSIONS) {
      res.status(400).json({
        success: false,
        error: {
          code: 'TOO_MANY_SESSIONS',
          message: `Maximum ${MAX_EXPORT_SESSIONS} sessions per export`,
        },
      });
      return;
    }

    const allEvents: TraceStoreEvent[] = [];

    const projectId = (req.params as Record<string, string>).projectId;

    for (const sid of sessionIds) {
      const resolution = await resolveProjectScopedTraceSession(sid, req.tenantContext, projectId);
      if (resolution.kind === 'unavailable') {
        log.warn('Authorization unavailable for session export; skipping session', { sid });
        continue;
      }
      if (resolution.kind !== 'authorized') {
        continue;
      }
      let piiReadContext: PIIReadSurfaceContext | undefined;
      const getPIIReadContext = async () => {
        piiReadContext ??= await resolvePIIReadSurfaceContextForSessionIds({
          sessionIds: resolution.liveTraceSessionIds,
          tenantId,
          projectId,
          allowRuntimeRehydrate: false,
        });
        return piiReadContext;
      };

      // Single query path: ClickHouse only
      let events: TraceStoreEvent[] = [];
      try {
        const chEvents = await queryClickHousePlatformEvents(
          resolution.traceQuerySessionId,
          tenantId,
          { projectId },
        );
        if (chEvents.length > 0) {
          events = chEvents;
        }
      } catch (err) {
        log.warn('ClickHouse query failed for export', {
          sessionId: sid,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (events.length === 0) continue;

      let filtered = events;
      if (eventType) {
        filtered = filtered.filter((e) => e.type === eventType);
      }
      if (decisionKind) {
        filtered = filtered.filter((e) => e.type === 'decision' && e.decisionKind === decisionKind);
      }
      allEvents.push(...scrubTraceEventsForResponse(filtered, await getPIIReadContext()));
    }

    allEvents.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const headers = [
      'id',
      'sessionId',
      'type',
      'decisionKind',
      'spanId',
      'parentSpanId',
      'agentName',
      'timestamp',
      'data',
    ];
    const csvRows = [headers.join(',')];

    for (const event of allEvents) {
      const row = [
        csvEscape(event.id),
        csvEscape(event.sessionId),
        csvEscape(event.type),
        csvEscape(event.decisionKind || ''),
        csvEscape(event.spanId || ''),
        csvEscape(event.parentSpanId || ''),
        csvEscape(event.agentName || ''),
        csvEscape(new Date(event.timestamp).toISOString()),
        csvEscape(JSON.stringify(event.data)),
      ];
      csvRows.push(row.join(','));
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=traces-export-${dateStr}.csv`);
    res.send(csvRows.join('\n'));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Export failed', { error: msg });
    res.status(500).json({
      success: false,
      error: { code: 'EXPORT_FAILED', message: msg },
    });
  }
});

/**
 * GET /api/projects/:projectId/sessions/generations
 * List all LLM call (generation) events across sessions.
 * Query params: sessionId (optional filter), limit, offset
 */
router.get('/generations', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'session:read'))) return;

    const MAX_LIMIT = 500;
    const MAX_SCAN_SESSIONS = 100;
    const sessionIdFilter = req.query.sessionId as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, MAX_LIMIT);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const tenantId = req.tenantContext!.tenantId;
    // For generations, we need session IDs to scan.
    // When a specific sessionId is provided, use it directly.
    // Otherwise, use active sessions from the trace store (live sessions on this pod).
    const traceStore = getTraceStore();
    const allSessionIds = sessionIdFilter ? [sessionIdFilter] : traceStore.getActiveSessions();
    const sessionIds = allSessionIds.slice(0, MAX_SCAN_SESSIONS);

    const allGenerations: Array<{
      id: string;
      sessionId: string;
      model: string;
      tokensIn: number;
      tokensOut: number;
      latencyMs: number;
      cost: number;
      timestamp: string;
      spanId?: string;
    }> = [];

    const projectId = (req.params as Record<string, string>).projectId;

    for (const sid of sessionIds) {
      const resolution = await resolveProjectScopedTraceSession(sid, req.tenantContext, projectId);

      if (resolution.kind === 'unavailable') {
        log.warn('DB unavailable for tenant verification in generations', { sid });
        if (sessionIdFilter) {
          res.status(503).json({
            success: false,
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'Database unavailable for authorization',
            },
          });
          return;
        }
        continue;
      }

      if (resolution.kind !== 'authorized') {
        if (sessionIdFilter) {
          res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Session not found in this project' },
          });
          return;
        }
        continue;
      }

      // Single query path: ClickHouse only
      try {
        const chEvents = await queryClickHousePlatformEvents(
          resolution.traceQuerySessionId,
          tenantId,
          { projectId },
        );
        for (const event of chEvents) {
          if (event.type !== 'llm_call') continue;
          const d = event.data as Record<string, unknown>;
          allGenerations.push({
            id: event.id || event.spanId || '',
            sessionId: resolution.traceQuerySessionId,
            model: (d.model as string) || 'unknown',
            tokensIn: (d.tokensIn as number) || 0,
            tokensOut: (d.tokensOut as number) || 0,
            latencyMs: (d.latencyMs as number) || 0,
            cost: (d.cost as number) || 0,
            timestamp: new Date(event.timestamp).toISOString(),
            spanId: event.spanId,
          });
        }
      } catch (err) {
        log.warn('ClickHouse query failed for generations', {
          sessionId: sid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    allGenerations.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    const total = allGenerations.length;
    const paged = allGenerations.slice(offset, offset + limit);

    res.json({ success: true, total, offset, limit, generations: paged });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Generations query failed', { error: msg });
    res.status(500).json({
      success: false,
      error: { code: 'GENERATIONS_FAILED', message: msg },
    });
  }
});

/**
 * POST /api/projects/:projectId/sessions/:id/pii/reveal
 * Reveal selected durable PII token originals for admin/compliance workflows.
 * This is the only raw-value route; normal session and trace APIs remain redacted.
 */
router.post('/:id/pii/reveal', async (req, res) => {
  try {
    const projectId = (req.params as Record<string, string>).projectId;
    if (!(await requireSensitiveProjectPermission(req, res, 'pii:reveal', projectId))) {
      return;
    }

    const parsed = piiRevealRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_PII_REVEAL_REQUEST',
          message: 'reason and tokenIds or sourceRefs are required',
          details: parsed.error.flatten(),
        },
      });
      return;
    }

    const tenantId = req.tenantContext!.tenantId;
    const sessionId = getSessionRouteId(req as SessionIdAwareRequest);
    const dbSession = await findStoredSessionByAnyId(sessionId, tenantId);
    if (!dbSession || dbSession.projectId !== projectId) {
      res.status(404).json({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
      });
      return;
    }

    const messageScope = await expandMessageScopedPIIRevealTokenIds({
      tenantId,
      projectId,
      sessionId: dbSession.id,
      sourceRefs: parsed.data.sourceRefs,
    });
    const tokenIds = mergePIIRevealTokenIds(parsed.data.tokenIds, messageScope.tokenIds);
    const resolvedMessageIds = new Set(messageScope.resolvedMessageIds);
    const sourceRefs =
      messageScope.tokenIds.length > 0
        ? parsed.data.sourceRefs?.filter(
            (sourceRef) =>
              !sourceRef.sourceMessageId || !resolvedMessageIds.has(sourceRef.sourceMessageId),
          )
        : parsed.data.sourceRefs;
    if (tokenIds.length + (sourceRefs?.length ?? 0) > MAX_PII_REVEAL_SELECTOR_COUNT) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_PII_REVEAL_REQUEST',
          message: `At most ${MAX_PII_REVEAL_SELECTOR_COUNT} tokenIds/sourceRefs can be revealed at once`,
        },
      });
      return;
    }

    const result = await revealPIITokens({
      tenantId,
      projectId,
      sessionId: dbSession.id,
      tokenIds,
      sourceRefs,
      reason: parsed.data.reason,
      ticketId: parsed.data.ticketId,
      actor: buildPIIRevealActor(req.tenantContext!),
    });

    res.json({
      success: true,
      sessionId: dbSession.id,
      revealed: result.revealed,
      unavailable: result.unavailable,
      auditLogCount: result.auditLogCount,
    });
  } catch (error) {
    log.error('PII reveal failed', {
      sessionId: getSessionRouteId(req as SessionIdAwareRequest),
      projectId: (req.params as Record<string, string>).projectId,
      error: getErrorMessage(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'PII_REVEAL_FAILED', message: 'Failed to reveal PII' },
    });
  }
});

/**
 * GET /api/projects/:projectId/sessions/:id
 * Get full session details including messages and state.
 * Tries RuntimeExecutor first (active sessions), falls back to DB (historical sessions).
 * The :id can be either a runtime session ID or a DB session ID.
 */
openapi.route(
  'get',
  '/:id',
  {
    summary: 'Get session detail',
    description: 'Get full session details including messages, state, and trace events',
    response: z.object({
      success: z.boolean(),
      session: z.object({
        id: z.string(),
        agent: z.object({ name: z.string() }).passthrough(),
        agentName: z.string(),
        state: z.record(z.unknown()).optional(),
        messages: z.array(
          z.object({
            id: z.string(),
            role: z.string(),
            content: z.string(),
            rawContent: z.array(z.unknown()).optional(),
            metadata: z.record(z.unknown()).optional(),
            contentEnvelope: z
              .object({
                version: z.number(),
                format: z.string(),
                text: z.string(),
              })
              .passthrough()
              .optional(),
            timestamp: z.string(),
          }),
        ),
        traceEvents: z.array(z.unknown()),
        threads: z.array(z.unknown()).optional(),
        activeThreadIndex: z.number().optional(),
        channel: z.string().optional(),
        status: z.string().optional(),
        createdAt: z.string(),
        lastActivityAt: z.string(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const tenantContext = req.tenantContext;
      if (!tenantContext) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Missing tenant context' },
        });
        return;
      }

      const sessionId = getSessionRouteId(req as SessionIdAwareRequest);
      const includeTraces = req.query.includeTraces !== 'false';
      const callerTenant = tenantContext.tenantId;
      const projectId = (req.params as Record<string, string>).projectId;

      // 1. Try RuntimeExecutor first (active in-memory sessions)
      const executor = getRuntimeExecutor();
      const respondWithActiveSessionDetail = async (
        detail: NonNullable<ReturnType<typeof executor.getSessionDetail>>,
        runtimeSession: NonNullable<ReturnType<typeof executor.getSession>>,
        options?: {
          persistedSession?: Awaited<ReturnType<typeof findStoredSessionByAnyId>> | null;
        },
      ): Promise<boolean> => {
        const sessionTenant = runtimeSession.tenantId || null;
        if (sessionTenant !== callerTenant || runtimeSession.projectId !== projectId) {
          res.status(404).json({ success: false, error: `Session not found: ${sessionId}` });
          return true;
        }

        let messages: SessionDetailMessagePayload[] = detail.messages;
        const persistedSession = options?.persistedSession;
        const shouldLoadPersistedMessages =
          isDatabaseAvailable() && (!persistedSession || persistedSession.projectId === projectId);
        if (shouldLoadPersistedMessages) {
          try {
            const storedSession =
              persistedSession ?? (await findStoredSessionByAnyId(sessionId, callerTenant));
            if (storedSession?.projectId === projectId) {
              const persistedMessages = await findMessagesForSession(
                storedSession.id,
                200,
                callerTenant,
              );
              if (persistedMessages.length > 0) {
                const persistedMessagePayloads = persistedMessages.map((message) => ({
                  id: message.id,
                  role: message.role,
                  content: message.content,
                  ...(message.rawContent ? { rawContent: message.rawContent } : {}),
                  ...(message.contentEnvelope ? { contentEnvelope: message.contentEnvelope } : {}),
                  ...(message.metadata ? { metadata: message.metadata } : {}),
                  timestamp: message.timestamp.toISOString(),
                }));
                messages = mergeActiveSessionMessages({
                  runtimeMessages: messages,
                  persistedMessages: persistedMessagePayloads,
                });
              }
            }
          } catch (err) {
            log.warn('Failed to load persisted messages for active session detail', {
              sessionId: runtimeSession.id,
              tenantId: callerTenant,
              error: getErrorMessage(err),
            });
          }
        }

        // Historical Studio pages can opt out of inline trace hydration and
        // fetch traces separately so the detail payload returns quickly.
        let traceEvents = includeTraces ? detail.traceEvents : [];
        if (includeTraces && traceEvents.length === 0) {
          const storeEvents = await loadBufferedTraceEvents(runtimeSession.id, callerTenant);
          if (storeEvents.length > 0) {
            traceEvents = storeEvents;
          }
        }

        // Active sessions are mutable — don't cache
        res.set('Cache-Control', 'private, no-cache');
        // Fetch full agent details so the Studio debug panel IR tab is populated.
        const agentDetails = await fetchAgentDetailsForSession(
          detail.agentName,
          projectId,
          callerTenant,
        );
        const agentPayload = agentDetails
          ? {
              name: agentDetails.name,
              id: agentDetails.id,
              type: agentDetails.type,
              mode: agentDetails.mode,
              dsl: agentDetails.dsl,
              ir: agentDetails.ir,
              toolCount: agentDetails.toolCount,
              gatherFieldCount: agentDetails.gatherFieldCount,
              isSupervisor: agentDetails.isSupervisor,
            }
          : { name: detail.agentName };
        const piiReadContext = await buildPIIReadSurfaceContext(runtimeSession);

        res.json({
          success: true,
          session: {
            id: detail.id,
            agent: agentPayload,
            agentName: detail.agentName,
            state: detail.state,
            messages: scrubSessionMessagesForResponse(
              filterCustomerVisibleSessionMessages(messages),
              piiReadContext,
            ),
            traceEvents: scrubTraceEventsForResponse(
              traceEvents as TraceStoreEvent[],
              piiReadContext,
            ),
            threads: detail.threads,
            activeThreadIndex: detail.activeThreadIndex,
            createdAt: detail.createdAt,
            lastActivityAt: detail.lastActivityAt,
          },
        });
        return true;
      };

      const detail = executor.getSessionDetail(sessionId);

      if (detail) {
        const session = executor.getSession(sessionId);
        if (session && (await respondWithActiveSessionDetail(detail, session))) {
          return;
        }
      }

      // 2. Fall back to DB for historical sessions
      if (isDatabaseAvailable()) {
        try {
          const tenantId = callerTenant;

          const dbSession = await findStoredSessionByAnyId(sessionId, tenantId);

          if (dbSession) {
            // Cross-project validation: verify session belongs to this project
            if (dbSession.projectId !== projectId) {
              res.status(404).json({ success: false, error: `Session not found: ${sessionId}` });
              return;
            }
            const traceSessionId = resolveStoredSessionCompatibilityId(dbSession, sessionId);
            const liveTraceSessionIds = buildLiveTraceSessionIds(sessionId, dbSession);

            try {
              let liveSession: ReturnType<typeof executor.getSession> | null = null;
              let liveDetail: ReturnType<typeof executor.getSessionDetail> | null = null;

              for (const liveTraceSessionId of liveTraceSessionIds) {
                liveSession =
                  executor.getSession(liveTraceSessionId) ??
                  (await executor.rehydrateSession(liveTraceSessionId));
                if (!liveSession) {
                  continue;
                }

                liveDetail = executor.getSessionDetail(liveSession.id);
                if (liveDetail) {
                  break;
                }
              }

              if (liveSession && liveDetail) {
                if (
                  await respondWithActiveSessionDetail(liveDetail, liveSession, {
                    persistedSession: dbSession,
                  })
                ) {
                  return;
                }
              }
            } catch (rehydrateErr) {
              log.warn('Cross-pod session detail rehydrate failed', {
                sessionId: traceSessionId,
                tenantId,
                error: getErrorMessage(rehydrateErr),
              });
            }

            // Load messages from DB
            const dbMessages = await findMessagesForSession(dbSession.id, 200, tenantId);
            const messages = dbMessages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              ...(m.rawContent ? { rawContent: m.rawContent } : {}),
              ...(m.contentEnvelope ? { contentEnvelope: m.contentEnvelope } : {}),
              ...(m.metadata ? { metadata: m.metadata } : {}),
              timestamp: m.timestamp.toISOString(),
            }));

            // Merge the distributed trace buffer with durable ClickHouse history so
            // recently terminalized sessions keep fresh live events without hiding
            // older durable voice traces.
            let traceEvents: unknown[] = [];

            if (tenantId && includeTraces) {
              const liveTraceEvents = await loadBufferedTraceEventsForCandidates(
                liveTraceSessionIds,
                tenantId,
              );
              traceEvents = liveTraceEvents;

              try {
                const chEvents = await queryClickHousePlatformEvents(traceSessionId, tenantId, {
                  projectId,
                });
                if (chEvents.length > 0) {
                  traceEvents =
                    liveTraceEvents.length > 0
                      ? mergeTraceEventSources(liveTraceEvents as TraceStoreEvent[], chEvents)
                      : chEvents;
                }
              } catch (chErr) {
                log.warn('ClickHouse query failed for session detail', {
                  sessionId,
                  error: chErr instanceof Error ? chErr.message : String(chErr),
                });
              }
            }

            // Parse context from JSON
            let state: Record<string, unknown> = {};
            try {
              state = JSON.parse(dbSession.context);
            } catch {
              /* ignore */
            }

            const dbAny = dbSession as Record<string, unknown>;
            const persistedAgentName = resolvePersistedSessionAgentName({
              currentAgent: dbSession.currentAgent,
              entryAgentName:
                typeof dbAny.entryAgentName === 'string' ? dbAny.entryAgentName : null,
            });

            // Fetch full agent details so the Studio debug panel IR tab is populated.
            const dbAgentDetails = await fetchAgentDetailsForSession(
              persistedAgentName,
              projectId,
              callerTenant,
            );
            const dbAgentPayload = dbAgentDetails
              ? {
                  name: dbAgentDetails.name,
                  id: dbAgentDetails.id,
                  type: dbAgentDetails.type,
                  mode: dbAgentDetails.mode,
                  dsl: dbAgentDetails.dsl,
                  ir: dbAgentDetails.ir,
                  toolCount: dbAgentDetails.toolCount,
                  gatherFieldCount: dbAgentDetails.gatherFieldCount,
                  isSupervisor: dbAgentDetails.isSupervisor,
                }
              : { name: persistedAgentName };
            const piiReadContext =
              messages.length > 0 || traceEvents.length > 0
                ? await resolvePIIReadSurfaceContextForSessionIds({
                    sessionIds: liveTraceSessionIds,
                    tenantId: callerTenant,
                    projectId,
                    allowRuntimeRehydrate: false,
                  })
                : undefined;

            // Closed/completed sessions are immutable — cache longer
            const isTerminal = isTerminalSessionStatus(dbSession.status);
            res.set('Cache-Control', isTerminal ? 'private, max-age=300' : 'private, no-cache');
            res.json({
              success: true,
              session: {
                id: dbSession.id,
                agent: dbAgentPayload,
                agentName: persistedAgentName,
                state,
                messages: scrubSessionMessagesForResponse(
                  filterCustomerVisibleSessionMessages(messages),
                  piiReadContext,
                ),
                traceEvents: scrubTraceEventsForResponse(
                  traceEvents as TraceStoreEvent[],
                  piiReadContext,
                ),
                tokenCount: (dbAny.tokenCount as number) || 0,
                estimatedCost: (dbAny.estimatedCost as number) || 0,
                messageCount: dbSession.messageCount || 0,
                channel: dbSession.channel,
                status: dbSession.status,
                createdAt: dbSession.startedAt.toISOString(),
                lastActivityAt: dbSession.lastActivityAt.toISOString(),
              },
            });
            return;
          }
        } catch (err) {
          log.warn('DB session lookup failed', { error: getErrorMessage(err) });
        }
      }

      // Not found in either source
      res.status(404).json({
        success: false,
        error: `Session not found: ${sessionId}`,
      });
    } catch (error) {
      log.error('Error getting session', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to get session',
      });
    }
  },
);

/**
 * DELETE /api/projects/:projectId/sessions/:id
 * Soft-delete a session. Cleans up RuntimeExecutor AND updates DB.
 * Sets status='abandoned', disposition='abandoned', endedAt=now().
 */
openapi.route(
  'delete',
  '/:id',
  {
    summary: 'Delete session',
    description: 'Delete a session and clean up its traces',
    response: z.object({
      success: z.boolean(),
      message: z.string(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:delete'))) return;

      const sessionId = getSessionRouteId(req as SessionIdAwareRequest);
      const tenantId = req.tenantContext!.tenantId;
      const projectId = (req.params as Record<string, string>).projectId;
      let found = false;
      const cleanupSessionIds = new Set<string>();

      // 1. Try RuntimeExecutor (in-memory sessions)
      try {
        const executor = getRuntimeExecutor();
        const session = executor.getSession(sessionId);
        if (session) {
          // Tenant + project isolation for in-memory sessions
          const sessionTenant = session.tenantId || null;
          if (sessionTenant !== tenantId || session.projectId !== projectId) {
            res.status(404).json({ success: false, error: `Session not found: ${sessionId}` });
            return;
          }
          executor.endSession(sessionId);
          try {
            getTraceStore().removeSession(sessionId);
          } catch {
            /* ignore */
          }
          cleanupSessionIds.add(sessionId);
          found = true;
        }
      } catch {
        /* RuntimeExecutor not initialized */
      }

      // 2. ALSO update DB (session typically exists in both memory and DB)
      if (isDatabaseAvailable()) {
        const dbSession = await findStoredSessionByAnyId(sessionId, tenantId);

        if (dbSession) {
          // Cross-project validation
          if (dbSession.projectId !== projectId) {
            if (!found) {
              res.status(404).json({ success: false, error: `Session not found: ${sessionId}` });
              return;
            }
          } else {
            // Also clean up RuntimeExecutor if not already found
            if (!found) {
              try {
                const executor = getRuntimeExecutor();
                const storedSessionId = resolveStoredSessionCompatibilityId(dbSession, sessionId);
                executor.endSession(storedSessionId);
                try {
                  getTraceStore().removeSession(storedSessionId);
                } catch {
                  /* ignore */
                }
                found = true;
              } catch {
                /* RuntimeExecutor not initialized */
              }
            }

            // Decrement session counter only if executor didn't handle it
            // (executor.endSession already decrements)
            if (!found && tenantId) {
              import('../middleware/rate-limiter.js')
                .then(({ releaseSessionSlot }) => releaseSessionSlot(tenantId, sessionId))
                .catch((err) => {
                  log.warn('Session slot release failed', {
                    error: err instanceof Error ? err.message : String(err),
                  });
                });
            }

            // Full cascade delete: session + messages + usage metrics + attachments + events
            const { deleteSession: cascadeDeleteSession } =
              await import('@agent-platform/database/cascade');
            await cascadeDeleteSession(dbSession.id);
            cleanupSessionIds.add(resolveStoredSessionCompatibilityId(dbSession, sessionId));
            found = true;
          }
        }
      }

      if (!found) {
        res.status(404).json({ success: false, error: `Session not found: ${sessionId}` });
        return;
      }

      await cleanupClosedSessionArtifacts(cleanupSessionIds);

      auditSessionModified(sessionId, 'deleted', tenantId, tenantId).catch((err) =>
        log.warn('audit session deleted failed', {
          error: getErrorMessage(err),
        }),
      );
      res.json({ success: true, message: 'Session deleted' });
    } catch (error) {
      log.error('Error deleting session', { error: getErrorMessage(error) });
      res.status(500).json({ success: false, error: 'Failed to delete session' });
    }
  },
);

/**
 * POST /api/projects/:projectId/sessions/:id/close
 * Close a session with an explicit disposition.
 * Body: { disposition: CallDisposition }
 */
router.post('/:id/close', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'session:execute'))) return;

    const sessionId = getSessionRouteId(req as SessionIdAwareRequest);
    const { disposition: rawDisposition } = req.body || {};

    if (!rawDisposition || !VALID_DISPOSITIONS.includes(rawDisposition)) {
      res.status(400).json({
        success: false,
        error: `Invalid disposition. Must be one of: ${VALID_DISPOSITIONS.join(', ')}`,
      });
      return;
    }

    const disposition = rawDisposition as CallDisposition;
    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;
    const status = dispositionToStatus(disposition);

    if (isSessionTerminalizationEnabled()) {
      const result = await terminalizationService.terminateConversationSession({
        tenantId,
        projectId,
        sessionId,
        disposition,
        source: 'close_api',
      });

      if (!result) {
        res.status(404).json({ success: false, error: `Session not found: ${sessionId}` });
        return;
      }

      await cleanupClosedSessionArtifacts(result.artifactSessionIds);

      auditSessionModified(sessionId, 'closed', tenantId, tenantId).catch((err) =>
        log.warn('audit session closed failed', {
          error: getErrorMessage(err),
        }),
      );
      res.json({
        success: true,
        message: `Session closed with disposition: ${result.disposition}`,
        status: result.status,
        disposition: result.disposition,
      });
      return;
    }

    let found = false;
    const cleanupSessionIds = new Set<string>();

    // 1. End in RuntimeExecutor if active
    try {
      const executor = getRuntimeExecutor();
      const session = executor.getSession(sessionId);
      if (session) {
        // Tenant + project isolation for in-memory sessions
        const sessionTenant = session.tenantId || null;
        if (sessionTenant !== tenantId || session.projectId !== projectId) {
          res.status(404).json({ success: false, error: `Session not found: ${sessionId}` });
          return;
        }
        executor.endSession(sessionId);
        try {
          getTraceStore().removeSession(sessionId);
        } catch {
          /* ignore */
        }
        cleanupSessionIds.add(sessionId);
        found = true;
      }
    } catch {
      /* RuntimeExecutor not initialized */
    }

    // 2. Update DB session (tenant-scoped at query level)
    if (isDatabaseAvailable()) {
      const dbSession = await findStoredSessionByAnyId(sessionId, tenantId);

      if (dbSession) {
        // Cross-project validation
        if (dbSession.projectId !== projectId) {
          if (!found) {
            res.status(404).json({ success: false, error: `Session not found: ${sessionId}` });
            return;
          }
        } else {
          // Also clean up RuntimeExecutor if not already found
          if (!found) {
            try {
              const executor = getRuntimeExecutor();
              const storedSessionId = resolveStoredSessionCompatibilityId(dbSession, sessionId);
              executor.endSession(storedSessionId);
              try {
                getTraceStore().removeSession(storedSessionId);
              } catch {
                /* ignore */
              }
              cleanupSessionIds.add(storedSessionId);
              found = true;
            } catch {
              /* RuntimeExecutor not initialized */
            }
          }

          // Decrement session counter only if executor didn't handle it
          // (executor.endSession already decrements)
          if (!found && tenantId) {
            import('../middleware/rate-limiter.js')
              .then(({ releaseSessionSlot }) => releaseSessionSlot(tenantId, sessionId))
              .catch((err) => {
                log.warn('Session slot release failed', {
                  error: err instanceof Error ? err.message : String(err),
                });
              });
          }

          await updateSession(
            dbSession.id,
            {
              status,
              disposition,
              endedAt: new Date(),
              lastActivityAt: new Date(),
            },
            tenantId,
          );
          cleanupSessionIds.add(resolveStoredSessionCompatibilityId(dbSession, sessionId));
          found = true;
        }
      }
    }

    if (!found) {
      res.status(404).json({ success: false, error: `Session not found: ${sessionId}` });
      return;
    }

    await cleanupClosedSessionArtifacts(cleanupSessionIds);

    auditSessionModified(sessionId, 'closed', tenantId, tenantId).catch((err) =>
      log.warn('audit session closed failed', {
        error: getErrorMessage(err),
      }),
    );
    res.json({
      success: true,
      message: `Session closed with disposition: ${disposition}`,
      status,
      disposition,
    });
  } catch (error) {
    log.error('Error closing session', { error: getErrorMessage(error) });
    res.status(500).json({ success: false, error: 'Failed to close session' });
  }
});

// =============================================================================
// ESCALATION ROUTES
// =============================================================================

/**
 * Build a LockPort adapter from DistributedLockManager for the EscalationResolutionHandler.
 * Adapts the Lock { key, value } interface to the LockPort { key, owner } interface.
 */
async function buildEscalationLockPort() {
  const { DistributedLockManager } = await import('@agent-platform/shared');
  const { getRedisClient } = await import('../services/redis/redis-client.js');

  const redis = getRedisClient();
  if (!redis) return null;

  const lockManager = new DistributedLockManager(redis);

  return {
    acquire: async (
      key: string,
      options: { keyPrefix: string; ttlMs: number; retryAttempts: number; retryDelayMs: number },
    ) => {
      const lock = await lockManager.acquire(key, options);
      return lock ? { key: lock.key, owner: lock.value } : null;
    },
    release: async (lock: { key: string; owner: string }) => {
      await lockManager.release({ key: lock.key, value: lock.owner, expiresAt: new Date() });
    },
    extend: async (lock: { key: string; owner: string }, ttlMs: number) => {
      return lockManager.extend({ key: lock.key, value: lock.owner, expiresAt: new Date() }, ttlMs);
    },
  };
}

/**
 * POST /api/projects/:projectId/sessions/:id/escalation/resolve
 * Resolve an escalated session by providing a human decision.
 */
router.post('/:id/escalation/resolve', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'session:execute'))) return;

    const sessionId = getSessionRouteId(req as SessionIdAwareRequest);
    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;

    // Validate request body
    const bodySchema = z.object({
      resolution: z.object({
        decision: z.string().min(1),
        notes: z.string().optional(),
        fields: z.record(z.unknown()).optional(),
        respondedBy: z.string().min(1),
      }),
    });

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        success: false,
        error: {
          code: 'INVALID_RESOLUTION',
          message: 'Invalid resolution payload',
        },
      });
      return;
    }

    const { EscalationResolutionHandler } =
      await import('../services/escalation/resolution-handler.js');
    const { MongoSuspensionStore } =
      await import('../services/execution/mongo-suspension-store.js');
    const { HumanTask } = await import('@agent-platform/database/models');

    const lockPort = await buildEscalationLockPort();
    if (!lockPort) {
      res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Lock manager not available — Redis may be down',
        },
      });
      return;
    }

    const handler = new EscalationResolutionHandler({
      humanTaskModel: HumanTask,
      suspensionStore: new MongoSuspensionStore(),
      lockManager: lockPort,
    });

    const result = await handler.handleResolution(
      sessionId,
      tenantId,
      projectId,
      parsed.data.resolution,
    );

    if (!result.success && result.error) {
      const statusMap: Record<string, number> = {
        ESCALATION_NOT_FOUND: 404,
        ESCALATION_ALREADY_RESOLVED: 409,
        ESCALATION_NOT_RESOLVABLE: 400,
        LOCK_ACQUISITION_FAILED: 503,
        RESOLUTION_FAILED: 500,
      };
      const status = statusMap[result.error.code] ?? 500;
      res.status(status).json({ success: false, error: result.error });
      return;
    }

    res.json({
      success: true,
      data: {
        action: result.action,
        humanTaskId: result.humanTaskId,
      },
    });
  } catch (error) {
    log.error('Error resolving escalation', {
      error: error instanceof Error ? error.message : String(error),
      sessionId: getSessionRouteId(req as SessionIdAwareRequest),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve escalation' },
    });
  }
});

/**
 * GET /api/projects/:projectId/sessions/:id/escalation
 * Get the escalation status for a session.
 */
router.get('/:id/escalation', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'session:read'))) return;

    const sessionId = getSessionRouteId(req as SessionIdAwareRequest);
    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;

    const { EscalationResolutionHandler } =
      await import('../services/escalation/resolution-handler.js');
    const { MongoSuspensionStore } =
      await import('../services/execution/mongo-suspension-store.js');
    const { HumanTask } = await import('@agent-platform/database/models');

    const lockPort = await buildEscalationLockPort();
    if (!lockPort) {
      res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Lock manager not available — Redis may be down',
        },
      });
      return;
    }

    const handler = new EscalationResolutionHandler({
      humanTaskModel: HumanTask,
      suspensionStore: new MongoSuspensionStore(),
      lockManager: lockPort,
    });

    const result = await handler.getStatus(sessionId, tenantId, projectId);

    if (!result.success && result.error) {
      const status = result.error.code === 'ESCALATION_NOT_FOUND' ? 404 : 500;
      res.status(status).json({ success: false, error: result.error });
      return;
    }

    res.json({ success: true, data: result.data });
  } catch (error) {
    log.error('Error getting escalation status', {
      error: error instanceof Error ? error.message : String(error),
      sessionId: getSessionRouteId(req as SessionIdAwareRequest),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get escalation status' },
    });
  }
});

/**
 * POST /api/projects/:projectId/sessions/:id/reset
 * Reset session state and messages
 */
openapi.route(
  'post',
  '/:id/reset',
  {
    summary: 'Reset session',
    description: 'Reset session state, messages, and traces',
    response: z.object({
      success: z.boolean(),
      message: z.string(),
      state: z.record(z.unknown()),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:execute'))) return;

      const executor = getRuntimeExecutor();

      // Tenant + project isolation: verify session belongs to caller before resetting
      const sessionId = getSessionRouteId(req as SessionIdAwareRequest);
      const existingSession = executor.getSession(sessionId);
      if (existingSession) {
        const callerTenant = req.tenantContext!.tenantId;
        const sessionTenant = existingSession.tenantId || null;
        const projectId = (req.params as Record<string, string>).projectId;
        if (sessionTenant !== callerTenant || existingSession.projectId !== projectId) {
          res.status(404).json({ success: false, error: `Session not found: ${sessionId}` });
          return;
        }
      }

      const session = executor.resetSession(sessionId);

      if (!session) {
        res.status(404).json({
          success: false,
          error: `Session not found: ${sessionId}`,
        });
        return;
      }

      const tenantId = req.tenantContext!.tenantId;
      await finalizeSessionReset({
        sessionId,
        tenantId,
        resetAt: new Date(),
        persistRuntimeSession: () => executor.persistSession(session),
      });

      auditSessionModified(sessionId, 'reset', tenantId, tenantId).catch((err) =>
        log.warn('audit session reset failed', {
          error: getErrorMessage(err),
        }),
      );
      res.json({
        success: true,
        message: 'Session reset',
        state: session.state,
      });
    } catch (error) {
      log.error('Error resetting session', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to reset session',
      });
    }
  },
);

/**
 * GET /api/projects/:projectId/sessions/:id/traces
 * Get session traces with optional limit
 */
openapi.route(
  'get',
  '/:id/traces',
  {
    summary: 'Get session traces',
    description:
      'Get trace events for a session with optional pagination and type filtering (query params: limit, offset, types)',
    response: z.object({
      success: z.boolean(),
      total: z.number(),
      offset: z.number(),
      limit: z.number(),
      traces: z.array(z.unknown()),
      _meta: z.object({
        source: z.enum(['memory', 'clickhouse_platform_events', 'combined']),
        event_count: z.number(),
        loaded_count: z.number().optional(),
        available_count: z.number().optional(),
        is_truncated: z.boolean(),
        source_chain: z.array(z.string()).optional(),
        warnings: z
          .array(
            z.object({
              source: z.string(),
              code: z.string(),
              message: z.string(),
            }),
          )
          .optional(),
        errors: z
          .array(
            z.object({
              source: z.string(),
              code: z.string(),
              message: z.string(),
            }),
          )
          .optional(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const sessionId = getSessionRouteId(req as SessionIdAwareRequest);
      const tenantId = req.tenantContext!.tenantId;
      const requestedLimit = parseOptionalPositiveInt(req.query.limit);
      const offset = parseOptionalNonNegativeInt(req.query.offset) ?? 0;
      const types = req.query.types ? String(req.query.types).split(',') : [];
      const eventType = typeof req.query.eventType === 'string' ? req.query.eventType : undefined;
      const decisionKind =
        typeof req.query.decisionKind === 'string' ? req.query.decisionKind : undefined;
      const spanId = typeof req.query.spanId === 'string' ? req.query.spanId : undefined;
      const includeMetrics = req.query.include === 'metrics';
      const requestedTraceTypes = normalizeRequestedTraceTypes(
        eventType ? [...types, eventType] : types,
      );
      const traceWarnings: TraceReadDiagnostic[] = [];
      const traceErrors: TraceReadDiagnostic[] = [];

      const projectId = (req.params as Record<string, string>).projectId;
      const resolution = await resolveProjectScopedTraceSession(
        sessionId,
        req.tenantContext,
        projectId,
      );
      if (resolution.kind === 'unavailable') {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database unavailable for authorization' },
        });
        return;
      }
      if (resolution.kind !== 'authorized') {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
        return;
      }
      let piiReadContext: PIIReadSurfaceContext | undefined;
      const getPIIReadContext = async () => {
        piiReadContext ??= await resolvePIIReadSurfaceContextForSessionIds({
          sessionIds: resolution.liveTraceSessionIds,
          tenantId,
          projectId,
          allowRuntimeRehydrate: false,
        });
        return piiReadContext;
      };

      try {
        const storeEvents = await loadBufferedTraceEventsForCandidates(
          resolution.liveTraceSessionIds,
          tenantId,
          traceWarnings,
        );
        if (storeEvents.length > 0) {
          let traces = storeEvents;
          let source: TraceSource = 'memory';
          try {
            const durableEvents = await queryClickHousePlatformEvents(
              resolution.traceQuerySessionId,
              tenantId,
              {
                projectId,
                traceTypes: requestedTraceTypes,
                spanId,
              },
            );
            if (durableEvents.length > 0) {
              traces = mergeTraceEventSources(storeEvents, durableEvents);
              source = 'combined';
            }
          } catch (durableErr) {
            log.warn('ClickHouse query failed while merging live session traces', {
              sessionId,
              error: getErrorMessage(durableErr),
            });
            traceWarnings.push({
              source: 'clickhouse_platform_events',
              code: 'CLICKHOUSE_TRACE_QUERY_FAILED',
              message: 'Durable trace history could not be merged; live trace buffer was returned.',
            });
          }

          sendTracesResponse(res, req, traces, source, await getPIIReadContext(), {
            sourceChain:
              source === 'combined' ? ['memory', 'clickhouse_platform_events'] : [source],
            warnings: traceWarnings,
          });
          return;
        }
      } catch (bufferErr) {
        log.warn('Distributed trace lookup failed for session traces route', {
          sessionId: resolution.traceQuerySessionId,
          tenantId,
          error: getErrorMessage(bufferErr),
        });
        traceWarnings.push({
          source: 'memory',
          code: 'TRACE_BUFFER_LOOKUP_FAILED',
          message:
            'Live trace buffer lookup failed; durable trace history will be used if available.',
        });
      }

      // Historical sessions fall back to ClickHouse once the distributed buffer is unavailable.
      try {
        if (!decisionKind && !includeMetrics) {
          const [total, chEvents] = await Promise.all([
            countClickHousePlatformEvents(resolution.traceQuerySessionId, tenantId, {
              projectId,
              traceTypes: requestedTraceTypes,
              spanId,
            }),
            queryClickHousePlatformEventPage(resolution.traceQuerySessionId, tenantId, {
              projectId,
              traceTypes: requestedTraceTypes,
              spanId,
              limit: requestedLimit,
              offset,
            }),
          ]);
          sendPrePaginatedTraceResponse(res, req, chEvents, {
            total,
            source: 'clickhouse_platform_events',
            offset,
            requestedLimit,
            piiReadContext: chEvents.length > 0 ? await getPIIReadContext() : undefined,
            sourceChain: ['memory', 'clickhouse_platform_events'],
            warnings: traceWarnings,
          });
          return;
        }

        const chEvents = await queryClickHousePlatformEvents(
          resolution.traceQuerySessionId,
          tenantId,
          { projectId },
        );
        if (chEvents.length > 0) {
          sendTracesResponse(
            res,
            req,
            chEvents,
            'clickhouse_platform_events',
            await getPIIReadContext(),
            {
              sourceChain: ['memory', 'clickhouse_platform_events'],
              warnings: traceWarnings,
            },
          );
          return;
        }
      } catch (err) {
        log.warn('ClickHouse query failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        traceErrors.push({
          source: 'clickhouse_platform_events',
          code: 'CLICKHOUSE_TRACE_QUERY_FAILED',
          message: 'Historical trace store query failed.',
        });
      }

      sendTracesResponse(res, req, [], 'clickhouse_platform_events', undefined, {
        sourceChain: ['memory', 'clickhouse_platform_events'],
        warnings: traceWarnings,
        errors: traceErrors,
      });
    } catch (error) {
      log.error('Error getting traces', { error: getErrorMessage(error) });
      if (res.headersSent) {
        return;
      }
      res.status(500).json({
        success: false,
        error: 'Failed to get traces',
      });
    }
  },
);

type TraceSource = 'memory' | 'clickhouse_platform_events' | 'combined';

interface TraceReadDiagnostic {
  source: TraceSource | 'trace_api' | 'studio_proxy';
  code: string;
  message: string;
}

interface TraceResponseMetaOptions {
  sourceChain?: string[];
  warnings?: TraceReadDiagnostic[];
  errors?: TraceReadDiagnostic[];
}

const CLICKHOUSE_SESSION_TRACE_CATEGORIES_SQL =
  "('voice', 'session', 'message', 'llm', 'tool', 'agent', 'flow', 'system', 'attachment', 'channel')";
const CLICKHOUSE_FULL_TRACE_FETCH_LIMIT = 1000;
const CLICKHOUSE_TRACE_PAGE_SIZE_LIMIT = 1000;
const CLICKHOUSE_PLATFORM_TO_TRACE_TYPE_MAP: Readonly<Record<string, string>> =
  PLATFORM_TO_TRACE_TYPE;

interface ClickHousePlatformEventQueryOptions {
  projectId?: string;
  lookbackDays?: number;
  traceTypes?: string[];
  spanId?: string;
  parentSpanId?: string;
  limit?: number;
  offset?: number;
}

let clickHouseTraceModulePromise:
  | Promise<typeof import('@agent-platform/database/clickhouse')>
  | undefined;

function loadClickHouseTraceModule() {
  if (!clickHouseTraceModulePromise) {
    clickHouseTraceModulePromise = import('@agent-platform/database/clickhouse');
  }
  return clickHouseTraceModulePromise;
}

function parseOptionalNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOptionalPositiveInt(value: unknown): number | undefined {
  const parsed = parseOptionalNonNegativeInt(value);
  return typeof parsed === 'number' && parsed > 0 ? parsed : undefined;
}

function normalizeRequestedTraceTypes(traceTypes: string[]): string[] {
  return Array.from(
    new Set(
      traceTypes.map((traceType) => traceType.trim()).filter((traceType) => traceType.length > 0),
    ),
  );
}

function resolveTraceTypeClickHouseFilters(traceTypes?: string[]):
  | {
      platformEventTypes: string[];
      runtimeAtomicTraceTypes: string[];
    }
  | undefined {
  if (!traceTypes || traceTypes.length === 0) return undefined;

  const normalizedTraceTypes = normalizeRequestedTraceTypes(traceTypes);
  if (normalizedTraceTypes.length === 0) return undefined;

  const platformEventTypes = new Set<string>(normalizedTraceTypes);
  const runtimeAtomicTraceTypes = new Set<string>(normalizedTraceTypes);
  for (const [platformEventType, traceType] of Object.entries(
    CLICKHOUSE_PLATFORM_TO_TRACE_TYPE_MAP,
  )) {
    if (normalizedTraceTypes.includes(traceType)) {
      platformEventTypes.add(platformEventType);
    }
  }

  for (const traceType of normalizedTraceTypes) {
    const mappedPlatformType = TRACE_TO_PLATFORM_TYPE[traceType];
    if (mappedPlatformType) {
      platformEventTypes.add(mappedPlatformType);
    }
  }

  platformEventTypes.delete(RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE);

  return {
    platformEventTypes: Array.from(platformEventTypes),
    runtimeAtomicTraceTypes: Array.from(runtimeAtomicTraceTypes),
  };
}

function buildTraceTypeFilterCondition(traceTypes?: string[]): {
  condition?: string;
  queryParams: Record<string, unknown>;
} {
  const filters = resolveTraceTypeClickHouseFilters(traceTypes);
  if (!filters) {
    return { queryParams: {} };
  }

  const conditions: string[] = [];
  const queryParams: Record<string, unknown> = {};

  if (filters.platformEventTypes.length > 0) {
    conditions.push('event_type IN ({eventTypes:Array(String)})');
    queryParams.eventTypes = filters.platformEventTypes;
  }

  if (filters.runtimeAtomicTraceTypes.length > 0) {
    conditions.push(
      `(event_type = {runtimeAtomicPlatformEventType:String} AND JSONExtractString(data, '${RUNTIME_TRACE_TYPE_DATA_KEY}') IN ({runtimeAtomicTraceTypes:Array(String)}))`,
    );
    queryParams.runtimeAtomicPlatformEventType = RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE;
    queryParams.runtimeAtomicTraceTypes = filters.runtimeAtomicTraceTypes;
  }

  return {
    condition: conditions.length > 0 ? `(${conditions.join(' OR ')})` : undefined,
    queryParams,
  };
}

function mergeTraceEventSources(
  memoryEvents: TraceStoreEvent[],
  durableEvents: TraceStoreEvent[],
): TraceStoreEvent[] {
  const byId = new Map<string, TraceStoreEvent>();

  for (const event of durableEvents) {
    byId.set(event.id, event);
  }
  for (const event of memoryEvents) {
    byId.set(event.id, event);
  }

  const merged = Array.from(byId.values()).sort((left, right) => {
    const leftTime = new Date(left.timestamp).getTime();
    const rightTime = new Date(right.timestamp).getTime();
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.id.localeCompare(right.id);
  });

  return dedupeTraceEventsBySemanticResponse(merged);
}

function buildClickHousePlatformEventWhereClause(
  sessionId: string,
  tenantId: string,
  options: ClickHousePlatformEventQueryOptions = {},
): {
  whereClause: string;
  queryParams: Record<string, unknown>;
} {
  const lookbackDays = options.lookbackDays ?? 90;
  const conditions = [
    'session_id = {sessionId:String}',
    'tenant_id = {tenantId:String}',
    `timestamp >= now() - INTERVAL ${lookbackDays} DAY`,
    `category IN ${CLICKHOUSE_SESSION_TRACE_CATEGORIES_SQL}`,
  ];
  const queryParams: Record<string, unknown> = { sessionId, tenantId };

  if (typeof options.projectId === 'string' && options.projectId.trim().length > 0) {
    conditions.push('project_id = {projectId:String}');
    queryParams.projectId = options.projectId;
  }

  if (typeof options.spanId === 'string' && options.spanId.trim().length > 0) {
    conditions.push('span_id = {spanId:String}');
    queryParams.spanId = options.spanId;
  }

  if (typeof options.parentSpanId === 'string' && options.parentSpanId.trim().length > 0) {
    conditions.push('parent_span_id = {parentSpanId:String}');
    queryParams.parentSpanId = options.parentSpanId;
  }

  const traceTypeFilter = buildTraceTypeFilterCondition(options.traceTypes);
  if (traceTypeFilter.condition) {
    conditions.push(traceTypeFilter.condition);
    Object.assign(queryParams, traceTypeFilter.queryParams);
  }

  return {
    whereClause: conditions.join('\n        AND '),
    queryParams,
  };
}

function sendPrePaginatedTraceResponse(
  res: import('express').Response,
  req: import('express').Request,
  traces: TraceStoreEvent[],
  options: {
    total: number;
    source: TraceSource;
    offset: number;
    requestedLimit?: number;
    piiReadContext?: PIIReadSurfaceContext;
    sourceChain?: string[];
    warnings?: TraceReadDiagnostic[];
    errors?: TraceReadDiagnostic[];
  },
): void {
  res.set('Cache-Control', 'private, max-age=10');
  const scrubbedTraces = scrubTraceEventsForResponse(traces, options.piiReadContext);

  res.json({
    success: true,
    total: options.total,
    offset: options.offset,
    limit: options.requestedLimit || scrubbedTraces.length,
    traces: scrubbedTraces,
    _meta: {
      source: options.source,
      event_count: options.total,
      loaded_count: scrubbedTraces.length,
      available_count: options.total,
      is_truncated: options.offset + scrubbedTraces.length < options.total,
      source_chain: options.sourceChain ?? [options.source],
      ...(options.warnings?.length ? { warnings: options.warnings } : {}),
      ...(options.errors?.length ? { errors: options.errors } : {}),
    },
  });
}

function sendTracesResponse(
  res: import('express').Response,
  req: import('express').Request,
  allTraces: TraceStoreEvent[],
  source: TraceSource,
  piiReadContext?: PIIReadSurfaceContext,
  metaOptions: TraceResponseMetaOptions = {},
): void {
  const limit = parseOptionalPositiveInt(req.query.limit);
  const offset = parseOptionalNonNegativeInt(req.query.offset) ?? 0;
  const types = req.query.types ? (req.query.types as string).split(',') : undefined;
  const eventType = req.query.eventType as string | undefined;
  const decisionKind = req.query.decisionKind as string | undefined;
  const spanId = req.query.spanId as string | undefined;
  const includeMetrics = req.query.include === 'metrics';

  let traces = allTraces;

  // Filter by types (legacy multi-type filter)
  if (types && types.length > 0) {
    traces = traces.filter((t) => types.includes(t.type));
  }

  // Filter by eventType (single type filter)
  if (eventType) {
    traces = traces.filter((t) => t.type === eventType);
  }

  // Filter by decisionKind (only applies to decision events)
  if (decisionKind) {
    traces = traces.filter((t) => t.type === 'decision' && t.decisionKind === decisionKind);
  }

  // Filter by spanId
  if (spanId) {
    traces = traces.filter((t) => t.spanId === spanId);
  }

  // Apply pagination
  const total = traces.length;
  const isTruncated = source === 'clickhouse_platform_events' && allTraces.length === 1000;
  if (offset > 0) {
    traces = traces.slice(offset);
  }
  if (limit) {
    traces = traces.slice(0, limit);
  }
  const scrubbedTraces = scrubTraceEventsForResponse(traces, piiReadContext);

  res.set('Cache-Control', 'private, max-age=10');
  const response: Record<string, unknown> = {
    success: true,
    total,
    offset,
    limit: limit || total,
    traces: scrubbedTraces,
    _meta: {
      source,
      event_count: allTraces.length,
      loaded_count: scrubbedTraces.length,
      available_count: total,
      is_truncated: isTruncated,
      source_chain: metaOptions.sourceChain ?? [source],
      ...(metaOptions.warnings?.length ? { warnings: metaOptions.warnings } : {}),
      ...(metaOptions.errors?.length ? { errors: metaOptions.errors } : {}),
    },
  };

  if (includeMetrics) {
    response.metrics = computeSpanMetrics(allTraces);
  }

  res.json(response);
}

/**
 * Compute aggregated metrics per span from trace events.
 */
function computeSpanMetrics(
  traces: TraceStoreEvent[],
): Record<string, { eventCount: number; durationMs: number; types: Record<string, number> }> {
  const spans: Record<
    string,
    { eventCount: number; durationMs: number; types: Record<string, number> }
  > = {};

  for (const t of traces) {
    const sid = t.spanId || '__root__';
    if (!spans[sid]) {
      spans[sid] = { eventCount: 0, durationMs: 0, types: {} };
    }
    spans[sid].eventCount++;
    spans[sid].types[t.type] = (spans[sid].types[t.type] || 0) + 1;
    if (t.data?.durationMs && typeof t.data.durationMs === 'number') {
      spans[sid].durationMs += t.data.durationMs;
    }
  }

  return spans;
}

/**
 * Escape a value for CSV output.
 */
function csvEscape(value: string): string {
  let sanitized = value;
  // Prevent CSV formula injection (Excel/Sheets auto-execute =, +, -, @, |, \t)
  if (/^[=+\-@|\t]/.test(sanitized)) {
    sanitized = "'" + sanitized;
  }
  if (sanitized.includes(',') || sanitized.includes('"') || sanitized.includes('\n')) {
    return `"${sanitized.replace(/"/g, '""')}"`;
  }
  return sanitized;
}

/**
 * Query ClickHouse platform_events table as the single persistent source for trace events.
 * Maps platform event types to trace event types for UI compatibility.
 * Decrypts fields via the encryption interceptor if rows were encrypted.
 */
async function queryClickHousePlatformEvents(
  sessionId: string,
  tenantId: string,
  options: ClickHousePlatformEventQueryOptions = {},
): Promise<TraceStoreEvent[]> {
  return queryClickHousePlatformEventPage(sessionId, tenantId, {
    ...options,
    offset: 0,
    limit: CLICKHOUSE_FULL_TRACE_FETCH_LIMIT,
  });
}

async function countClickHousePlatformEvents(
  sessionId: string,
  tenantId: string,
  options: ClickHousePlatformEventQueryOptions = {},
): Promise<number> {
  const { getClickHouseClient } = await loadClickHouseTraceModule();
  const client = getClickHouseClient();
  if (!client) return 0;

  const sessionTable = 'abl_platform.platform_events_by_session';
  const { whereClause, queryParams } = buildClickHousePlatformEventWhereClause(
    sessionId,
    tenantId,
    options,
  );

  const result = await client.query({
    query: `
      SELECT count() AS total
      FROM ${sessionTable}
      WHERE ${whereClause}
      SETTINGS max_execution_time = 10, max_memory_usage = 536870912
    `,
    query_params: queryParams,
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ total: number | string }>();
  const total = rows[0]?.total;
  return typeof total === 'number' ? total : Number.parseInt(String(total ?? 0), 10) || 0;
}

async function countClickHousePlatformEventsBySession(
  sessionIds: string[],
  tenantId: string,
  options: ClickHousePlatformEventQueryOptions = {},
): Promise<Map<string, number>> {
  const uniqueSessionIds = Array.from(
    new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)),
  );
  const counts = new Map<string, number>();
  if (uniqueSessionIds.length === 0) {
    return counts;
  }

  const { getClickHouseClient } = await loadClickHouseTraceModule();
  const client = getClickHouseClient();
  if (!client) return counts;

  const sessionTable = 'abl_platform.platform_events_by_session';
  const lookbackDays = options.lookbackDays ?? 90;
  const conditions = [
    'session_id IN ({sessionIds:Array(String)})',
    'tenant_id = {tenantId:String}',
    `timestamp >= now() - INTERVAL ${lookbackDays} DAY`,
    `category IN ${CLICKHOUSE_SESSION_TRACE_CATEGORIES_SQL}`,
  ];
  const queryParams: Record<string, unknown> = {
    sessionIds: uniqueSessionIds,
    tenantId,
  };

  if (typeof options.projectId === 'string' && options.projectId.trim().length > 0) {
    conditions.push('project_id = {projectId:String}');
    queryParams.projectId = options.projectId;
  }

  const traceTypeFilter = buildTraceTypeFilterCondition(options.traceTypes);
  if (traceTypeFilter.condition) {
    conditions.push(traceTypeFilter.condition);
    Object.assign(queryParams, traceTypeFilter.queryParams);
  }

  const result = await client.query({
    query: `
      SELECT session_id, count() AS total
      FROM ${sessionTable}
      WHERE ${conditions.join('\n        AND ')}
      GROUP BY session_id
      SETTINGS max_execution_time = 10, max_memory_usage = 536870912
    `,
    query_params: queryParams,
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ session_id: string; total: number | string }>();
  for (const row of rows) {
    const total =
      typeof row.total === 'number' ? row.total : Number.parseInt(String(row.total ?? 0), 10) || 0;
    if (row.session_id && total > 0) {
      counts.set(row.session_id, total);
    }
  }
  return counts;
}

async function queryClickHousePlatformEventPage(
  sessionId: string,
  tenantId: string,
  options: ClickHousePlatformEventQueryOptions = {},
): Promise<TraceStoreEvent[]> {
  const { getClickHouseClient, parseClickHouseTimestamp } = await loadClickHouseTraceModule();
  const client = getClickHouseClient();
  if (!client) return [];

  // Use the session-optimized materialized view target table which is
  // ORDER BY (tenant_id, session_id, timestamp, event_id) for direct key lookup.
  // The base table's ORDER BY (tenant_id, category, event_type, timestamp) forces
  // full granule scanning via bloom_filter which degrades at 500M+ events/day.
  const sessionTable = 'abl_platform.platform_events_by_session';
  const { whereClause, queryParams } = buildClickHousePlatformEventWhereClause(
    sessionId,
    tenantId,
    options,
  );
  const limit = Math.max(
    1,
    Math.min(options.limit ?? CLICKHOUSE_FULL_TRACE_FETCH_LIMIT, CLICKHOUSE_TRACE_PAGE_SIZE_LIMIT),
  );
  const offset = Math.max(0, options.offset ?? 0);

  // Partition pruning: the table is PARTITION BY toDate(timestamp).
  // Adding a timestamp lower bound lets ClickHouse skip old date partitions entirely,
  // dramatically reducing I/O on tables with months of historical data.
  // Default 90 days covers most use cases; callers with known session dates can pass tighter bounds.
  const result = await client.query({
    query: `
      SELECT
        event_id,
        event_type,
        category,
        span_id,
        parent_span_id,
        turn_id,
        execution_id,
        parent_execution_id,
        agent_run_id,
        decision_id,
        parent_decision_id,
        cause_event_id,
        phase,
        reason_code,
        agent_name,
        timestamp,
        duration_ms,
        has_error,
        data,
        _enc
      FROM ${sessionTable}
      WHERE ${whereClause}
      ORDER BY timestamp ASC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
      SETTINGS max_execution_time = 10, max_memory_usage = 536870912
    `,
    query_params: {
      ...queryParams,
      limit,
      offset,
    },
    format: 'JSONEachRow',
  });

  let rows = await result.json<ClickHouseSessionEventRow>();

  // Decrypt fields via interceptor if rows were encrypted
  if (rows.length > 0 && rows[0]._enc) {
    try {
      const { getClickHouseEncryptionInterceptor } =
        await import('../services/stores/clickhouse-encryption-singleton.js');
      const encInterceptor = getClickHouseEncryptionInterceptor();
      if (encInterceptor) {
        const decryptedRows = await encInterceptor.afterQuery(
          'platform_events',
          rows.map((row) => toClickHouseSessionEventRowRecord(row)),
        );
        rows = decryptedRows.map((row) => fromClickHouseSessionEventRowRecord(row));
      }
    } catch (error) {
      log.debug('Failed to decrypt ClickHouse session trace rows', {
        sessionId,
        error: getErrorMessage(error),
      });
    }
  }

  return mapClickHouseSessionEventRowsToTraceEvents({
    rows,
    sessionId,
    typeMap: CLICKHOUSE_PLATFORM_TO_TRACE_TYPE_MAP,
    parseClickHouseTimestamp,
  });
}

/**
 * GET /api/projects/:projectId/sessions/:id/agent-spec
 * Get the full agent specification for a session
 */
openapi.route(
  'get',
  '/:id/agent-spec',
  {
    summary: 'Get agent specification',
    description: 'Get the full agent specification (DSL, IR, metadata) for a session',
    response: z.object({
      success: z.boolean(),
      agent: z.object({
        id: z.string(),
        name: z.string(),
        type: z.string().optional(),
        mode: z.string().optional(),
        dsl: z.string().optional(),
        ir: z.unknown().optional(),
        toolCount: z.number().optional(),
        gatherFieldCount: z.number().optional(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const sessionId = getSessionRouteId(req as SessionIdAwareRequest);
      const tenantContext = req.tenantContext;
      if (!tenantContext?.tenantId) {
        res.status(403).json({
          success: false,
          error: 'Tenant context required',
        });
        return;
      }

      const callerTenant = tenantContext.tenantId;
      const projectId = (req.params as Record<string, string>).projectId;
      const executor = getRuntimeExecutor();
      const session = executor.getSession(sessionId);

      if (session) {
        const sessionTenant = session.tenantId || null;
        if (sessionTenant !== callerTenant || session.projectId !== projectId) {
          res.status(404).json({ success: false, error: `Session not found: ${sessionId}` });
          return;
        }

        const sessionAgentRef = session.threads[0]?.agentName ?? session.agentName ?? '';
        const agentLookupName = normalizeAgentLookupName(sessionAgentRef);

        if (isDatabaseAvailable() && agentLookupName) {
          const record = await findProjectAgentByName(agentLookupName, {
            tenantId: callerTenant,
            projectId,
          });
          if (record?.dslContent) {
            const agentDetails = buildAgentDetails(record.dslContent, record.name);
            res.json({
              success: true,
              agent: toSessionAgentSpecPayload(agentDetails, record.name, {
                dslContent: record.dslContent,
              }),
            });
            return;
          }
        }

        res.json({
          success: true,
          agent: {
            id: agentLookupName || sessionAgentRef,
            name: agentLookupName || sessionAgentRef,
            ir: session.agentIR,
          },
        });
        return;
      }

      if (isDatabaseAvailable()) {
        const dbSession = await findStoredSessionByAnyId(sessionId, callerTenant);
        if (dbSession) {
          if (dbSession.projectId !== projectId) {
            res.status(404).json({ success: false, error: `Session not found: ${sessionId}` });
            return;
          }

          const sessionAgentRef =
            typeof dbSession.currentAgent === 'string' ? dbSession.currentAgent : '';
          const agentLookupName = normalizeAgentLookupName(sessionAgentRef);
          let agentPayload: SessionAgentSpecPayload | null = null;
          const requestedVersion =
            typeof dbSession.agentVersion === 'string' && dbSession.agentVersion.length > 0
              ? dbSession.agentVersion
              : undefined;

          if (agentLookupName && requestedVersion) {
            const record = await findProjectAgentByName(agentLookupName, {
              tenantId: callerTenant,
              projectId,
            });

            if (record) {
              const recordAny = record as Record<string, unknown>;
              const recordId =
                typeof recordAny.id === 'string'
                  ? recordAny.id
                  : typeof recordAny._id === 'string'
                    ? recordAny._id
                    : undefined;

              if (recordId) {
                const versionRecord = await findAgentVersion(
                  recordId,
                  requestedVersion,
                  callerTenant,
                );
                if (versionRecord?.dslContent) {
                  const versionAgentDetails = buildAgentDetails(
                    versionRecord.dslContent,
                    record.name,
                  );
                  agentPayload = toSessionAgentSpecPayload(versionAgentDetails, record.name, {
                    dslContent: versionRecord.dslContent,
                    irContent: versionRecord.irContent,
                  });
                }
              }
            }
          }

          res.json({
            success: true,
            agent:
              agentPayload ??
              ({
                id: agentLookupName || sessionAgentRef || sessionId,
                name: agentLookupName || sessionAgentRef || 'Unknown',
              } satisfies SessionAgentSpecPayload),
          });
          return;
        }
      }

      res.status(404).json({
        success: false,
        error: `Session not found: ${sessionId}`,
      });
    } catch (error) {
      log.error('Error getting agent spec', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to get agent spec',
      });
    }
  },
);

/**
 * GET /api/projects/:projectId/sessions/:id/analysis
 * Get trace analysis and diagnostics for a session
 */
openapi.route(
  'get',
  '/:id/analysis',
  {
    summary: 'Analyze session traces',
    description:
      'Get automated trace analysis with issue detection, suggestions, and flow path analysis',
    response: z.object({
      success: z.boolean(),
      analysis: z.object({
        summary: z.object({
          totalEvents: z.number(),
          eventCounts: z.record(z.number()),
          duration: z.number().nullable(),
          llmCalls: z.number(),
          toolCalls: z.number(),
          errors: z.number(),
        }),
        currentState: z.object({
          step: z.string().nullable(),
          phase: z.string(),
          collectedFields: z.array(z.string()),
          missingFields: z.array(z.string()),
        }),
        issues: z.array(
          z.object({
            type: z.enum(['warning', 'error', 'info']),
            title: z.string(),
            description: z.string(),
            eventIndex: z.number().optional(),
          }),
        ),
        suggestions: z.array(z.string()),
        flowPath: z
          .object({
            expectedSteps: z.array(z.string()),
            visitedSteps: z.array(z.string()),
            skippedSteps: z.array(z.string()),
            completionSource: z.string().optional(),
            completedAtStep: z.string().optional(),
          })
          .optional(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const sessionId = getSessionRouteId(req as SessionIdAwareRequest);
      const executor = getRuntimeExecutor();
      const session = executor.getSession(sessionId);

      if (!session) {
        res.status(404).json({
          success: false,
          error: `Session not found: ${sessionId}`,
        });
        return;
      }

      // Tenant + project isolation: verify session belongs to caller
      const callerTenant = req.tenantContext!.tenantId;
      const sessionTenant = session.tenantId || null;
      const projectId = (req.params as Record<string, string>).projectId;
      if (sessionTenant !== callerTenant || session.projectId !== projectId) {
        res.status(404).json({ success: false, error: `Session not found: ${sessionId}` });
        return;
      }

      // Get traces from TraceStore
      const traceStore = getTraceStore();
      const storeEvents = traceStore.getEvents(sessionId);

      if (storeEvents instanceof Promise) {
        storeEvents
          .then((events) => {
            const analysis = analyzeTraces(
              events as unknown as TraceEvent[],
              session.state as AgentState,
              session.agentIR as unknown as Record<string, unknown> | undefined,
            );
            res.json({ success: true, analysis });
          })
          .catch((error) => {
            log.error('Error analyzing session', { error: getErrorMessage(error) });
            res.status(500).json({ success: false, error: 'Failed to analyze session' });
          });
        return;
      }

      const analysis = analyzeTraces(
        storeEvents as unknown as TraceEvent[],
        session.state as AgentState,
        session.agentIR as unknown as Record<string, unknown> | undefined,
      );

      res.json({
        success: true,
        analysis,
      });
    } catch (error) {
      log.error('Error analyzing session', { error: getErrorMessage(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to analyze session',
      });
    }
  },
);

// =============================================================================
// TRACE ANALYSIS HELPERS
// =============================================================================

interface TraceAnalysis {
  summary: {
    totalEvents: number;
    eventCounts: Record<string, number>;
    duration: number | null;
    llmCalls: number;
    toolCalls: number;
    errors: number;
  };
  currentState: {
    step: string | null;
    phase: string;
    collectedFields: string[];
    missingFields: string[];
  };
  issues: Array<{
    type: 'warning' | 'error' | 'info';
    title: string;
    description: string;
    eventIndex?: number;
  }>;
  suggestions: string[];
  flowPath?: {
    expectedSteps: string[];
    visitedSteps: string[];
    skippedSteps: string[];
    completionSource?: string;
    completedAtStep?: string;
  };
}

function analyzeTraces(
  traces: TraceEvent[],
  state: AgentState,
  agentIR?: Record<string, unknown>,
): TraceAnalysis {
  const analysis: TraceAnalysis = {
    summary: {
      totalEvents: traces.length,
      eventCounts: {},
      duration: null,
      llmCalls: 0,
      toolCalls: 0,
      errors: 0,
    },
    currentState: {
      step: null,
      phase: state.conversationPhase || 'unknown',
      collectedFields: [],
      missingFields: [],
    },
    issues: [],
    suggestions: [],
  };

  // Count event types
  for (const trace of traces) {
    analysis.summary.eventCounts[trace.type] = (analysis.summary.eventCounts[trace.type] || 0) + 1;

    if (trace.type === 'llm_call') analysis.summary.llmCalls++;
    if (trace.type === 'tool_call') analysis.summary.toolCalls++;
    if (trace.type === 'error') analysis.summary.errors++;
  }

  // Calculate duration
  if (traces.length >= 2) {
    const first = new Date(traces[0].timestamp).getTime();
    const last = new Date(traces[traces.length - 1].timestamp).getTime();
    analysis.summary.duration = last - first;
  }

  // Find current step from flow events
  const flowSteps = traces.filter((t) => t.type === 'flow_step_enter');
  if (flowSteps.length > 0) {
    const lastStep = flowSteps[flowSteps.length - 1];
    analysis.currentState.step = (lastStep.data as { stepName?: string })?.stepName || null;
  }

  // Extract collected fields from dsl_set events
  const setEvents = traces.filter((t) => t.type === 'dsl_set');
  for (const event of setEvents) {
    const field = (event.data as { field?: string })?.field;
    if (field && !analysis.currentState.collectedFields.includes(field)) {
      analysis.currentState.collectedFields.push(field);
    }
  }

  // Find missing fields from collect events
  const collectEvents = traces.filter((t) => t.type === 'dsl_collect');
  for (const event of collectEvents) {
    const field = (event.data as { field?: string })?.field;
    const collected = (event.data as { collected?: boolean })?.collected;
    if (field && !collected && !analysis.currentState.missingFields.includes(field)) {
      analysis.currentState.missingFields.push(field);
    }
  }

  // Detect issues

  // Issue: Repeated step entry (potential loop)
  const stepCounts: Record<string, number> = {};
  for (const step of flowSteps) {
    const stepName = (step.data as { stepName?: string })?.stepName || 'unknown';
    stepCounts[stepName] = (stepCounts[stepName] || 0) + 1;
  }
  for (const [step, count] of Object.entries(stepCounts)) {
    if (count > 3) {
      analysis.issues.push({
        type: 'warning',
        title: 'Potential loop detected',
        description: `Step "${step}" was entered ${count} times. This may indicate a loop condition.`,
      });
      analysis.suggestions.push(
        `Check transition conditions for step "${step}". Ensure required fields are being collected.`,
      );
    }
  }

  // Issue: Errors present
  const errorEvents = traces.filter((t) => t.type === 'error');
  for (let i = 0; i < errorEvents.length; i++) {
    const error = errorEvents[i];
    const errorMsg = (error.data as { message?: string })?.message || 'Unknown error';
    analysis.issues.push({
      type: 'error',
      title: 'Error occurred',
      description: errorMsg,
      eventIndex: traces.indexOf(error),
    });
  }

  // Issue: Constraint violations
  const constraintFailures = traces.filter(
    (t) => t.type === 'constraint_check' && !(t.data as { passed?: boolean })?.passed,
  );
  for (const failure of constraintFailures) {
    const constraint = (failure.data as { constraint?: string })?.constraint || 'unknown';
    analysis.issues.push({
      type: 'warning',
      title: 'Constraint violation',
      description: `Constraint "${constraint}" was violated.`,
      eventIndex: traces.indexOf(failure),
    });
    analysis.suggestions.push(
      `Review the "${constraint}" constraint condition and current context values.`,
    );
  }

  // Issue: Tool failures
  const toolFailures = traces.filter(
    (t) => t.type === 'tool_call' && (t.data as { success?: boolean })?.success === false,
  );
  for (const failure of toolFailures) {
    const toolName = (failure.data as { tool?: string })?.tool || 'unknown';
    analysis.issues.push({
      type: 'error',
      title: 'Tool call failed',
      description: `Tool "${toolName}" returned an error.`,
      eventIndex: traces.indexOf(failure),
    });
    analysis.suggestions.push(`Check the "${toolName}" tool implementation and input parameters.`);
  }

  // Issue: Missing required fields
  if (analysis.currentState.missingFields.length > 0) {
    analysis.issues.push({
      type: 'info',
      title: 'Missing required fields',
      description: `The following fields are not yet collected: ${analysis.currentState.missingFields.join(', ')}`,
    });
    analysis.suggestions.push('The agent is waiting for user to provide the missing information.');
  }

  // Issue: Many LLM calls (potential inefficiency)
  if (analysis.summary.llmCalls > 10) {
    analysis.issues.push({
      type: 'info',
      title: 'High LLM call count',
      description: `${analysis.summary.llmCalls} LLM calls made. Consider optimizing prompts or caching.`,
    });
  }

  // Issue: Escalation without resolution
  const escalations = traces.filter((t) => t.type === 'escalation');
  if (escalations.length > 1) {
    analysis.issues.push({
      type: 'warning',
      title: 'Multiple escalations',
      description: `${escalations.length} escalations occurred. Ensure agents can handle the request.`,
    });
    analysis.suggestions.push(
      'Review escalation conditions and ensure at least one agent can resolve the request.',
    );
  }

  // Flow path analysis (requires agentIR with flow definitions)
  if (agentIR) {
    const flow = agentIR.flow as
      | { steps?: Array<{ name: string }>; definitions?: Record<string, unknown> }
      | undefined;
    if (flow) {
      const expectedSteps: string[] = flow.steps
        ? flow.steps.map((s: { name: string }) => s.name)
        : flow.definitions
          ? Object.keys(flow.definitions)
          : [];

      if (expectedSteps.length > 0) {
        const visitedSteps: string[] = [];
        for (const step of flowSteps) {
          const name = (step.data as { stepName?: string })?.stepName;
          if (name && !visitedSteps.includes(name)) {
            visitedSteps.push(name);
          }
        }

        const skippedSteps = expectedSteps.filter((s) => !visitedSteps.includes(s));

        // Find completion events that resolved to true
        const completionEvents = traces.filter(
          (t) => t.type === 'completion_check' && (t.data as { result?: boolean })?.result === true,
        );
        const firstCompletion = completionEvents[0];
        const completionSource = firstCompletion
          ? (firstCompletion.data as { source?: string })?.source
          : undefined;
        const completedAtStep = firstCompletion
          ? (firstCompletion.data as { currentStep?: string })?.currentStep
          : undefined;

        analysis.flowPath = {
          expectedSteps,
          visitedSteps,
          skippedSteps,
          completionSource,
          completedAtStep,
        };

        // Premature completion detection: if skipped steps come AFTER completedAtStep in flow order
        if (completedAtStep && skippedSteps.length > 0) {
          const completedIndex = expectedSteps.indexOf(completedAtStep);
          const skippedAfterCompletion = skippedSteps.filter(
            (s) => expectedSteps.indexOf(s) > completedIndex,
          );

          if (skippedAfterCompletion.length > 0) {
            analysis.issues.push({
              type: 'warning',
              title: 'Premature completion',
              description: `Completed at step "${completedAtStep}" (source: ${completionSource || 'unknown'}) but steps [${skippedAfterCompletion.join(', ')}] never executed.`,
            });
            analysis.suggestions.push(
              'Review COMPLETE condition — if it contains "OR true" or checks early-set variables, it may fire before later steps execute.',
            );
          }
        }
      }
    }
  }

  return analysis;
}

// =============================================================================
// METADATA INJECTION
// =============================================================================

/**
 * PATCH /:id/metadata — Inject custom dimensions into an active session.
 *
 * NOTE: This endpoint only works if the session is active on the current pod.
 * In a distributed deployment with multiple runtime pods, the request must be
 * routed to the pod owning the session (via session-sticky routing or a
 * service mesh). Returns 404 if the session is not found locally.
 */
openapi.route(
  'patch',
  '/:id/metadata',
  {
    summary: 'Inject custom dimensions into a session',
    description:
      'Push custom business metadata (order ID, customer tier, etc.) into an active runtime session. ' +
      'Values are merged — new keys are added, existing keys overwritten. Set a value to empty string to clear.',
    body: z.object({
      dimensions: z.record(z.string(), z.unknown()).describe('Key-value pairs to add/update'),
    }),
    response: z.object({
      success: z.boolean(),
      dimensions: z.record(z.string(), z.string()),
      errors: z.array(z.string()).optional(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:execute'))) return;

      const { projectId, id: sessionId } = req.params;
      const tenantId = req.tenantContext?.tenantId;

      if (!tenantId) {
        res
          .status(403)
          .json({ success: false, error: { code: 'FORBIDDEN', message: 'Tenant access denied' } });
        return;
      }

      const executor = getRuntimeExecutor();
      const session = executor.getSession(sessionId);

      if (!session) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Active session not found' },
        });
        return;
      }

      // Tenant isolation — session must belong to this tenant
      if (session.tenantId && session.tenantId !== tenantId) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Active session not found' },
        });
        return;
      }

      // Project isolation — session must belong to this project
      if (session.projectId !== projectId) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Active session not found' },
        });
        return;
      }

      const { dimensions: incoming } = req.body;
      const result = mergeSessionDimensions(session, incoming);

      log.info('Custom dimensions injected via REST', {
        sessionId,
        projectId,
        keysUpdated: Object.keys(incoming),
      });

      res.json({
        success: result.valid,
        dimensions: Object.fromEntries(result.dimensions),
        ...(result.errors.length > 0 && { errors: result.errors }),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to inject custom dimensions', { error: message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL', message: 'Failed to inject dimensions' },
      });
    }
  },
);

/**
 * GET /api/projects/:projectId/sessions/:id/messages
 * Cursor-paginated message history for a session.
 * Query: cursor (messageId), limit (default 50, max 200), direction (asc|desc, default desc)
 */
router.get('/:id/messages', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'session:read'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const sessionId = getSessionRouteId(req as SessionIdAwareRequest);
    const projectId = (req.params as Record<string, string>).projectId;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const direction =
      req.query.direction === 'asc' || req.query.direction === 'desc'
        ? req.query.direction
        : undefined;

    if (limit !== undefined && (isNaN(limit) || limit < 1)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_LIMIT', message: 'limit must be a positive integer' },
      });
      return;
    }

    // Verify session exists and belongs to this project (anti-enumeration: 404, not 403)
    const dbSession = await findStoredSessionByAnyId(sessionId, tenantId);
    if (dbSession && dbSession.projectId !== projectId) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    const liveTraceSessionIds = buildLiveTraceSessionIds(
      sessionId,
      dbSession ?? { id: sessionId, runtimeSessionId: sessionId },
    );
    const liveRuntimeMessages = await loadProjectScopedRuntimeMessageSnapshot({
      requestedSessionId: sessionId,
      tenantId,
      projectId,
      candidateIds: liveTraceSessionIds,
    });

    if (!dbSession) {
      if (!liveRuntimeMessages) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }

      const runtimePage = paginateMergedSessionMessages(
        filterCustomerVisibleSessionMessages(liveRuntimeMessages),
        {
          cursor,
          limit,
          direction,
        },
      );
      const piiReadContext = await resolvePIIReadSurfaceContextForSessionIds({
        sessionIds: liveTraceSessionIds,
        tenantId,
        projectId,
        allowRuntimeRehydrate: false,
      });

      res.json({
        success: true,
        messages: scrubSessionMessagesForResponse(runtimePage.messages, piiReadContext),
        nextCursor: runtimePage.nextCursor,
        hasMore: runtimePage.hasMore,
      });
      return;
    }

    let result: {
      messages: SessionDetailMessagePayload[];
      nextCursor: string | null;
      hasMore: boolean;
    };

    if (liveRuntimeMessages && liveRuntimeMessages.length > 0) {
      const persistedMessagesForMerge = mapPersistedMessagesToSessionDetailPayload(
        await findMessagesForSession(dbSession.id, MAX_SESSION_MESSAGES_ROUTE_PAGE_SIZE, tenantId),
      );
      const mergedMessages = filterCustomerVisibleSessionMessages(
        mergeActiveSessionMessages({
          runtimeMessages: liveRuntimeMessages,
          persistedMessages: persistedMessagesForMerge,
        }),
      );
      const trimmedCursor = cursor?.trim();
      const cursorIsInActiveWindow =
        !trimmedCursor || mergedMessages.some((message) => message.id === trimmedCursor);

      if (cursorIsInActiveWindow) {
        result = paginateMergedSessionMessages(mergedMessages, {
          cursor,
          limit,
          direction,
        });
      } else {
        const persistedPage = await findMessagesForSessionCursor(dbSession.id, tenantId, {
          cursor,
          limit,
          direction,
          excludeInternalCoordination: true,
        });
        result = {
          messages: filterCustomerVisibleSessionMessages(
            mapPersistedMessagesToSessionDetailPayload(persistedPage.messages),
          ),
          nextCursor: persistedPage.nextCursor,
          hasMore: persistedPage.hasMore,
        };
      }
    } else {
      const persistedPage = await findMessagesForSessionCursor(dbSession.id, tenantId, {
        cursor,
        limit,
        direction,
        excludeInternalCoordination: true,
      });
      result = {
        messages: filterCustomerVisibleSessionMessages(
          mapPersistedMessagesToSessionDetailPayload(persistedPage.messages),
        ),
        nextCursor: persistedPage.nextCursor,
        hasMore: persistedPage.hasMore,
      };
    }
    const piiReadContext = await resolvePIIReadSurfaceContextForSessionIds({
      sessionIds: liveTraceSessionIds,
      tenantId,
      projectId,
      allowRuntimeRehydrate: false,
    });

    res.json({
      success: true,
      messages: scrubSessionMessagesForResponse(
        filterCustomerVisibleSessionMessages(result.messages),
        piiReadContext,
      ),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to fetch session messages', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL', message: 'Failed to fetch messages' },
    });
  }
});

/**
 * GET /api/projects/:projectId/sessions/:id/traces/:spanId/children
 * Get child trace events for a specific span (progressive loading).
 */
router.get('/:id/traces/:spanId/children', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'session:read'))) return;

    const sessionId = getSessionRouteId(req as SessionIdAwareRequest);
    const { spanId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;
    const resolution = await resolveProjectScopedTraceSession(
      sessionId,
      req.tenantContext,
      projectId,
    );
    if (resolution.kind === 'unavailable') {
      log.warn('DB unavailable for tenant verification in span children', { sessionId });
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Database unavailable for authorization' },
      });
      return;
    }
    if (resolution.kind !== 'authorized') {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
      return;
    }
    const piiReadContext = await resolvePIIReadSurfaceContextForSessionIds({
      sessionIds: resolution.liveTraceSessionIds,
      tenantId,
      projectId,
      allowRuntimeRehydrate: false,
    });

    // Single query path: ClickHouse only
    let children: TraceStoreEvent[] = [];
    try {
      children = await queryClickHousePlatformEventPage(resolution.traceQuerySessionId, tenantId, {
        projectId,
        parentSpanId: spanId,
        limit: CLICKHOUSE_FULL_TRACE_FETCH_LIMIT,
      });
    } catch (err) {
      log.warn('ClickHouse query failed for span children', {
        sessionId,
        spanId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const scrubbedChildren = scrubTraceEventsForResponse(children, piiReadContext);
    res.json({ success: true, spanId, total: scrubbedChildren.length, children: scrubbedChildren });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Span children query failed', { error: msg });
    res.status(500).json({
      success: false,
      error: { code: 'TRACE_FETCH_FAILED', message: msg },
    });
  }
});

/**
 * GET /api/projects/:projectId/sessions/:id/metrics
 * Get aggregated cost, tokens, and duration metrics for a session.
 * Queries ClickHouse only (no TraceStore waterfall).
 */
router.get('/:id/metrics', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'session:read'))) return;

    const sessionId = getSessionRouteId(req as SessionIdAwareRequest);
    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;
    const resolution = await resolveProjectScopedTraceSession(
      sessionId,
      req.tenantContext,
      projectId,
    );
    if (resolution.kind === 'unavailable') {
      log.warn('DB unavailable for tenant verification in metrics', { sessionId });
      res.status(503).json({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Database unavailable for authorization' },
      });
      return;
    }
    if (resolution.kind !== 'authorized') {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
      return;
    }
    const source: TraceSource = 'clickhouse_platform_events';

    // Single query path: ClickHouse only
    let events: TraceStoreEvent[] = [];
    let totalEvents = 0;
    try {
      [totalEvents, events] = await Promise.all([
        countClickHousePlatformEvents(resolution.traceQuerySessionId, tenantId, { projectId }),
        queryClickHousePlatformEventPage(resolution.traceQuerySessionId, tenantId, {
          projectId,
          traceTypes: ['llm_call', 'tool_call', 'error'],
          limit: CLICKHOUSE_FULL_TRACE_FETCH_LIMIT,
        }),
      ]);
    } catch (err) {
      log.warn('ClickHouse query failed for metrics', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalCost = 0;
    let totalDurationMs = 0;
    let llmCallCount = 0;
    let toolCallCount = 0;
    let errorCount = 0;

    for (const event of events) {
      if (event.type === 'llm_call') {
        llmCallCount++;
        const d = event.data as Record<string, unknown>;
        if (typeof d.tokensIn === 'number') totalTokensIn += d.tokensIn;
        if (typeof d.tokensOut === 'number') totalTokensOut += d.tokensOut;
        if (typeof d.cost === 'number') totalCost += d.cost;
        if (typeof d.latencyMs === 'number') totalDurationMs += d.latencyMs;
      }
      if (event.type === 'tool_call') {
        toolCallCount++;
        const d = event.data as Record<string, unknown>;
        if (typeof d.latencyMs === 'number') totalDurationMs += d.latencyMs;
      }
      if (event.type === 'error') {
        errorCount++;
      }
    }

    res.json({
      success: true,
      metrics: {
        totalEvents,
        // Observatory-spec canonical field names
        totalLLMCalls: llmCallCount,
        totalToolCalls: toolCallCount,
        totalTokensIn,
        totalTokensOut,
        totalTokens: totalTokensIn + totalTokensOut,
        totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
        totalDurationMs,
        errorCount,
        source,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Metrics query failed', { error: msg });
    res.status(500).json({
      success: false,
      error: { code: 'METRICS_FAILED', message: msg },
    });
  }
});

export default router;
