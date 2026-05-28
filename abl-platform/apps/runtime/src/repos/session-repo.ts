/**
 * Session Repository
 *
 * MongoDB session CRUD operations.
 * Used by: routes/sessions.ts, services/session-cleanup-job.ts,
 *          services/message-persistence-queue.ts
 */

import type { ContentBlock } from '@abl/compiler/platform/llm/types.js';
import type { ClientSession } from 'mongoose';
import {
  decodePersistedMessageContent,
  type PersistedStructuredMessageEnvelopeV2,
} from '../services/session/persisted-message-content.js';

export interface SessionRepoWriteOptions {
  session?: ClientSession | null;
}

export interface SessionTurnUpdateOptions extends SessionRepoWriteOptions {
  requireMatched?: boolean;
}

export interface BatchCreateMessagesOptions extends SessionRepoWriteOptions {
  tenantId?: string;
}

function mongooseWriteOptions(options?: SessionRepoWriteOptions): { session?: ClientSession } {
  return options?.session ? { session: options.session } : {};
}

function resolveMatchedCount(result: unknown): number | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  const updateResult = result as { matchedCount?: unknown; n?: unknown };
  if (typeof updateResult.matchedCount === 'number') {
    return updateResult.matchedCount;
  }
  if (typeof updateResult.n === 'number') {
    return updateResult.n;
  }

  return undefined;
}

function normalizeMessageMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function mergeMessageAgentMetadata(
  metadata: Record<string, unknown> | undefined,
  agentName: unknown,
): Record<string, unknown> | undefined {
  if (typeof agentName !== 'string' || agentName.trim().length === 0) {
    return metadata;
  }

  return {
    ...(metadata ?? {}),
    agentName,
  };
}

// ─── Find ─────────────────────────────────────────────────────────────────

export async function findSessionById(id: string, tenantId: string): Promise<any | null> {
  if (!tenantId) throw new Error('tenantId is required for tenant-scoped session queries');
  const { Session } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { _id: id, tenantId };
  const doc = await Session.findOne(filter).select('-context -metadata').lean();
  return doc ? { ...doc, id: (doc as any)._id } : null;
}

export async function findSessionByRuntimeId(
  sessionId: string,
  tenantId: string,
): Promise<any | null> {
  /**
   * Stored/public session IDs are unified on Session._id.
   * Keep this helper only as a compatibility alias for older callers that still
   * speak in terms of "runtime session id" even though the stored identifier is canonical.
   */
  return findSessionById(sessionId, tenantId);
}

/**
 * Compatibility shim for callers that have not fully migrated to canonical naming yet.
 * Stored/public session access is canonical-id-only.
 */
export async function findStoredSessionByAnyId(
  sessionId: string,
  tenantId: string,
): Promise<any | null> {
  return findSessionById(sessionId, tenantId);
}

export interface SessionPersistenceContext {
  id: string;
  tenantId?: string | null;
  projectId?: string | null;
}

// System-level backfill: not user-scoped (no userId/createdBy filter needed here).
// Callers pass tenantIds to enforce tenant isolation instead of userId/ownerId isolation.
export async function findSessionPersistenceContexts(
  sessionIds: string[],
  tenantIds?: string[],
): Promise<SessionPersistenceContext[]> {
  const uniqueSessionIds = [
    ...new Set(sessionIds.filter((sessionId) => sessionId.trim().length > 0)),
  ];
  if (uniqueSessionIds.length === 0) {
    return [];
  }

  // Scope query to callers' tenants (Core Invariant #1 — Resource Isolation).
  // A bare _id query allows cross-tenant ID collisions to return foreign projectIds.
  const filter: Record<string, unknown> = { _id: { $in: uniqueSessionIds } };
  const validTenantIds = (tenantIds ?? []).filter(Boolean);
  if (validTenantIds.length > 0) {
    filter.tenantId = { $in: [...new Set(validTenantIds)] };
  }

  const { Session } = await import('@agent-platform/database/models');
  const docs = (await Session.find(filter, { _id: 1, tenantId: 1, projectId: 1 }).lean()) as Array<{
    _id?: string;
    tenantId?: string | null;
    projectId?: string | null;
  }>;

  return docs
    .map((doc) => ({
      id: doc._id ?? '',
      tenantId: doc.tenantId ?? null,
      projectId: doc.projectId ?? null,
    }))
    .filter((doc) => doc.id.trim().length > 0);
}

/**
 * Canonical stored-session identity prefers the public/stored session id and
 * falls back to the legacy runtimeSessionId field only for older persisted rows.
 */
export function resolveStoredSessionCompatibilityId(
  session: { id?: unknown; _id?: unknown; runtimeSessionId?: unknown },
  fallbackId: string,
): string {
  if (typeof session.id === 'string' && session.id.trim().length > 0) {
    return session.id;
  }

  if (typeof session._id === 'string' && session._id.trim().length > 0) {
    return session._id;
  }

  if (typeof session.runtimeSessionId === 'string' && session.runtimeSessionId.trim().length > 0) {
    return session.runtimeSessionId;
  }

  return fallbackId;
}

export async function listStoredSessionCleanupIds(
  where: Record<string, unknown>,
): Promise<string[]> {
  const { Session } = await import('@agent-platform/database/models');
  const docs = (await Session.find(where, {
    _id: 1,
    runtimeSessionId: 1,
  }).lean()) as Array<{
    _id?: string;
    runtimeSessionId?: string | null;
  }>;

  return docs
    .map((session) => resolveStoredSessionCompatibilityId(session, ''))
    .filter((sessionId) => sessionId.trim().length > 0);
}

/**
 * Cross-tenant summary lookup for privileged admin/observability flows only.
 * Summary lookup is also canonical-id-only.
 */
export async function findSessionSummaryByAnyId(sessionId: string): Promise<any | null> {
  const { Session } = await import('@agent-platform/database/models');
  const session = await Session.findOne(
    { _id: sessionId },
    {
      context: 0,
      metadata: 0,
    },
  )
    .lean()
    .exec();

  return session ? { ...session, id: (session as any)._id } : null;
}

// ─── List ─────────────────────────────────────────────────────────────────

export async function listSessions(
  where: Record<string, unknown>,
  opts?: {
    orderBy?: Record<string, string>;
    skip?: number;
    take?: number;
    select?: Record<string, boolean>;
  },
): Promise<any[]> {
  const { Session } = await import('@agent-platform/database/models');
  const sort: Record<string, 1 | -1> = {};
  if (opts?.orderBy) {
    for (const [k, v] of Object.entries(opts.orderBy)) {
      sort[k] = v === 'desc' ? -1 : 1;
    }
  }
  let query = Session.find(where);
  if (Object.keys(sort).length) query = query.sort(sort);
  if (opts?.skip) query = query.skip(opts.skip);
  if (opts?.take) query = query.limit(opts.take);
  if (opts?.select) {
    const projection: Record<string, 1> = {};
    for (const k of Object.keys(opts.select)) {
      // Map 'id' to MongoDB's '_id'
      projection[k === 'id' ? '_id' : k] = 1;
    }
    query = query.select(projection);
  }
  const docs = await query.lean();
  // Normalize _id → id for compatibility
  return docs.map((d: any) => ({ ...d, id: d._id }));
}

export async function countSessions(where: Record<string, unknown>): Promise<number> {
  const { Session } = await import('@agent-platform/database/models');
  return Session.countDocuments(where);
}

// ─── Update ───────────────────────────────────────────────────────────────

export async function updateSession(
  id: string,
  data: Record<string, unknown>,
  tenantId: string,
): Promise<any> {
  if (!tenantId) throw new Error('tenantId is required for tenant-scoped session queries');
  const { Session } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { _id: id, tenantId };
  return Session.findOneAndUpdate(filter, { $set: data }, { new: true }).lean();
}

export async function updateSessionActivity(
  id: string,
  messageCountIncrement: number,
  tenantId: string,
): Promise<void> {
  if (!tenantId) throw new Error('tenantId is required for tenant-scoped session queries');
  const { Session } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { _id: id, tenantId };
  await Session.updateOne(filter, {
    $set: { lastActivityAt: new Date() },
    $inc: { messageCount: messageCountIncrement },
  });
}

export async function incrementSessionTokens(
  id: string,
  tokenCountIncrement: number,
  estimatedCostIncrement: number,
  tenantId: string,
): Promise<void> {
  if (!tenantId) throw new Error('tenantId is required for tenant-scoped session queries');
  const { Session } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { _id: id, tenantId };
  await Session.updateOne(filter, {
    $inc: { tokenCount: tokenCountIncrement, estimatedCost: estimatedCostIncrement },
  });
}

export async function incrementSessionMetrics(
  id: string,
  increments: { traceEventCount?: number; errorCount?: number; handoffCount?: number },
  tenantId: string,
): Promise<void> {
  if (!tenantId) throw new Error('tenantId is required for tenant-scoped session queries');
  const { Session } = await import('@agent-platform/database/models');
  const $inc: Record<string, number> = {};
  if (increments.traceEventCount) $inc.traceEventCount = increments.traceEventCount;
  if (increments.errorCount) $inc.errorCount = increments.errorCount;
  if (increments.handoffCount) $inc.handoffCount = increments.handoffCount;
  if (Object.keys($inc).length === 0) return;
  const filter: Record<string, unknown> = { _id: id, tenantId };
  await Session.updateOne(filter, { $inc });
}

/**
 * Atomic session turn update — single updateOne that combines:
 * - lastActivityAt ($set, when touchLastActivityAt is true)
 * - messageCount, tokenCount, estimatedCost, traceEventCount, errorCount, handoffCount ($inc)
 *
 * Prevents partial-update inconsistency where some counters advance but others don't.
 * Used by the message-persistence-queue worker to commit all turn metrics at once.
 */
export async function applySessionTurnUpdate(
  id: string,
  update: {
    messageCountIncrement?: number;
    tokenCountIncrement?: number;
    estimatedCostIncrement?: number;
    traceEventCountIncrement?: number;
    errorCountIncrement?: number;
    handoffCountIncrement?: number;
    touchLastActivityAt?: boolean;
  },
  tenantId: string,
  options: SessionTurnUpdateOptions = {},
): Promise<void> {
  if (!tenantId) throw new Error('tenantId is required for tenant-scoped session queries');
  const { Session } = await import('@agent-platform/database/models');

  const $inc: Record<string, number> = {};
  if (update.messageCountIncrement) $inc.messageCount = update.messageCountIncrement;
  if (update.tokenCountIncrement) $inc.tokenCount = update.tokenCountIncrement;
  if (update.estimatedCostIncrement) $inc.estimatedCost = update.estimatedCostIncrement;
  if (update.traceEventCountIncrement) $inc.traceEventCount = update.traceEventCountIncrement;
  if (update.errorCountIncrement) $inc.errorCount = update.errorCountIncrement;
  if (update.handoffCountIncrement) $inc.handoffCount = update.handoffCountIncrement;

  const mongoUpdate: Record<string, unknown> = {};
  if (update.touchLastActivityAt) {
    mongoUpdate.$set = { lastActivityAt: new Date() };
  }
  if (Object.keys($inc).length > 0) {
    mongoUpdate.$inc = $inc;
  }
  if (Object.keys(mongoUpdate).length === 0) {
    return;
  }

  const filter: Record<string, unknown> = { _id: id, tenantId };
  const result = await Session.updateOne(filter, mongoUpdate, mongooseWriteOptions(options));
  const matchedCount = resolveMatchedCount(result);
  if (options.requireMatched && matchedCount === 0) {
    throw new Error(`No tenant-scoped session matched turn update for session ${id}`);
  }
}

// ─── Bulk Updates ────────────────────────────────────────────────────────

export async function unlinkContactFromSessions(
  contactId: string,
  tenantId: string,
): Promise<void> {
  if (!tenantId) throw new Error('tenantId is required for tenant-scoped session queries');
  const { Session } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { contactId, tenantId };
  await Session.updateMany(filter, { $set: { contactId: null } });
}

// ─── Messages for Session ─────────────────────────────────────────────────

export async function findMessagesForSession(
  sessionId: string,
  limit = 200,
  tenantId?: string,
): Promise<
  Array<{
    id: string;
    role: string;
    content: string;
    rawContent?: ContentBlock[];
    contentEnvelope?: PersistedStructuredMessageEnvelopeV2;
    metadata?: Record<string, unknown>;
    agentName?: string;
    timestamp: Date;
  }>
> {
  // When tenantId is provided, verify the session belongs to the tenant before fetching messages
  if (tenantId) {
    const { Session } = await import('@agent-platform/database/models');
    const session = await Session.findOne({ _id: sessionId, tenantId }, { _id: 1 }).lean();
    if (!session) return [];
  }
  const { Message } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { sessionId };
  if (tenantId) filter.tenantId = tenantId;
  const docs = await Message.find(filter).sort({ timestamp: 1 }).limit(limit).select({
    _id: 1,
    role: 1,
    content: 1,
    contentEnvelope: 1,
    metadata: 1,
    agentName: 1,
    timestamp: 1,
    tenantId: 1,
    projectId: 1,
    ire: 1,
    cek: 1,
    iv: 1,
    kmsKeyId: 1,
  });
  return docs.map((d: any) => {
    const decoded = decodePersistedMessageContent(d.content, d.contentEnvelope ?? null);
    const metadata = mergeMessageAgentMetadata(normalizeMessageMetadata(d.metadata), d.agentName);
    return {
      id: d._id,
      role: d.role,
      content: decoded.content,
      ...(decoded.rawContent ? { rawContent: decoded.rawContent } : {}),
      ...(decoded.contentEnvelope ? { contentEnvelope: decoded.contentEnvelope } : {}),
      ...(metadata ? { metadata } : {}),
      ...(typeof d.agentName === 'string' && d.agentName.trim().length > 0
        ? { agentName: d.agentName }
        : {}),
      timestamp: d.timestamp,
    };
  });
}

export async function findMessagesByIdsForSession(
  sessionId: string,
  messageIds: string[],
  tenantId: string,
  projectId: string,
): Promise<
  Array<{
    id: string;
    content: string;
    rawContent?: ContentBlock[];
    contentEnvelope?: PersistedStructuredMessageEnvelopeV2;
  }>
> {
  if (!tenantId) throw new Error('tenantId is required for tenant-scoped message queries');
  if (!projectId) throw new Error('projectId is required for project-scoped message queries');

  const uniqueMessageIds = [
    ...new Set(messageIds.map((messageId) => messageId.trim()).filter(Boolean)),
  ];
  if (uniqueMessageIds.length === 0) {
    return [];
  }

  const { Message } = await import('@agent-platform/database/models');
  const docs = await Message.find({
    _id: { $in: uniqueMessageIds },
    sessionId,
    tenantId,
    projectId,
  }).select({
    _id: 1,
    content: 1,
    contentEnvelope: 1,
    tenantId: 1,
    projectId: 1,
    ire: 1,
    cek: 1,
    iv: 1,
    kmsKeyId: 1,
  });

  return docs.map((d: any) => {
    const decoded = decodePersistedMessageContent(d.content, d.contentEnvelope ?? null);
    return {
      id: d._id,
      content: decoded.content,
      ...(decoded.rawContent ? { rawContent: decoded.rawContent } : {}),
      ...(decoded.contentEnvelope ? { contentEnvelope: decoded.contentEnvelope } : {}),
    };
  });
}

export async function findLatestMessageForSession(
  sessionId: string,
  tenantId?: string,
): Promise<{
  id: string;
  role: string;
  content: string;
  rawContent?: ContentBlock[];
  contentEnvelope?: PersistedStructuredMessageEnvelopeV2;
  timestamp: Date;
  metadata?: Record<string, unknown>;
} | null> {
  if (tenantId) {
    const { Session } = await import('@agent-platform/database/models');
    const session = await Session.findOne({ _id: sessionId, tenantId }, { _id: 1 }).lean();
    if (!session) return null;
  }

  const { Message } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { sessionId };
  if (tenantId) filter.tenantId = tenantId;

  const doc = await Message.findOne(filter).sort({ timestamp: -1 }).select({
    _id: 1,
    role: 1,
    content: 1,
    contentEnvelope: 1,
    timestamp: 1,
    metadata: 1,
    tenantId: 1,
    projectId: 1,
    ire: 1,
    cek: 1,
    iv: 1,
    kmsKeyId: 1,
  });

  if (!doc) {
    return null;
  }

  const decoded = decodePersistedMessageContent(doc.content, doc.contentEnvelope ?? null);
  return {
    id: doc._id,
    role: doc.role,
    content: decoded.content,
    ...(decoded.rawContent ? { rawContent: decoded.rawContent } : {}),
    ...(decoded.contentEnvelope ? { contentEnvelope: decoded.contentEnvelope } : {}),
    timestamp: doc.timestamp,
    metadata: doc.metadata ?? {},
  };
}

/** Maximum allowed limit for cursor-paginated message queries */
const MAX_MESSAGE_PAGE_SIZE = 200;
/** Default page size for cursor-paginated message queries */
const DEFAULT_MESSAGE_PAGE_SIZE = 50;

/**
 * Cursor-paginated messages for a session.
 * Cursor is the `_id` (ObjectId/UUIDv7) of the last message from the previous page.
 */
export async function findMessagesForSessionCursor(
  sessionId: string,
  tenantId: string,
  options: {
    cursor?: string;
    limit?: number;
    direction?: 'asc' | 'desc';
    excludeInternalCoordination?: boolean;
  } = {},
): Promise<{
  messages: Array<{
    id: string;
    role: string;
    content: string;
    rawContent?: ContentBlock[];
    contentEnvelope?: PersistedStructuredMessageEnvelopeV2;
    metadata?: Record<string, unknown>;
    agentName?: string;
    timestamp: Date;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
}> {
  const { Session, Message } = await import('@agent-platform/database/models');

  // Verify session belongs to tenant
  const session = await Session.findOne({ _id: sessionId, tenantId }, { _id: 1 }).lean();
  if (!session) return { messages: [], nextCursor: null, hasMore: false };

  const direction = options.direction ?? 'desc';
  const limit = Math.min(options.limit ?? DEFAULT_MESSAGE_PAGE_SIZE, MAX_MESSAGE_PAGE_SIZE);

  const filter: Record<string, unknown> = { sessionId, tenantId };
  if (options.excludeInternalCoordination) {
    filter.$and = [
      {
        $or: [
          { 'metadata.responseVisibility': { $exists: false } },
          { 'metadata.responseVisibility': { $ne: 'internal' } },
        ],
      },
      {
        $or: [
          { 'metadata.coordination.visibility': { $exists: false } },
          { 'metadata.coordination.visibility': { $ne: 'internal' } },
        ],
      },
    ];
  }
  if (options.cursor) {
    filter._id = direction === 'desc' ? { $lt: options.cursor } : { $gt: options.cursor };
  }

  const sortOrder = direction === 'desc' ? -1 : 1;

  // Fetch limit + 1 to determine hasMore
  const docs = await Message.find(filter)
    .sort({ _id: sortOrder })
    .limit(limit + 1)
    .select({
      _id: 1,
      role: 1,
      content: 1,
      contentEnvelope: 1,
      metadata: 1,
      agentName: 1,
      timestamp: 1,
      tenantId: 1,
      projectId: 1,
      ire: 1,
      cek: 1,
      iv: 1,
      kmsKeyId: 1,
    });

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  const messages = page.map((d: any) => {
    const decoded = decodePersistedMessageContent(d.content, d.contentEnvelope ?? null);
    const metadata = mergeMessageAgentMetadata(normalizeMessageMetadata(d.metadata), d.agentName);
    return {
      id: d._id,
      role: d.role,
      content: decoded.content,
      ...(decoded.rawContent ? { rawContent: decoded.rawContent } : {}),
      ...(decoded.contentEnvelope ? { contentEnvelope: decoded.contentEnvelope } : {}),
      ...(metadata ? { metadata } : {}),
      ...(typeof d.agentName === 'string' && d.agentName.trim().length > 0
        ? { agentName: d.agentName }
        : {}),
      timestamp: d.timestamp,
    };
  });

  const nextCursor = hasMore && messages.length > 0 ? messages[messages.length - 1].id : null;

  return { messages, nextCursor, hasMore };
}

// ─── Batch Messages ───────────────────────────────────────────────────────
// CALLER RESPONSIBILITY: Callers must verify session tenant ownership before calling.
// Messages are keyed by sessionId; tenant isolation is enforced at the session level.

export interface BatchCreateMessageInput {
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  role: string;
  content: string;
  contentEnvelope?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
  tokenCount?: number;
  timestamp: Date;
  idempotencyKey?: string;
  contactId?: string;
  hasPII?: boolean;
  encrypted?: boolean;
  expiresAt?: Date;
  /** Explicit message id (ABLP-1068 — transport responseMessageId binding). */
  messageId?: string;
  /** Agent attribution (ABLP-1068). */
  agentName?: string;
}

export async function batchCreateMessages(
  messages: BatchCreateMessageInput[],
  options: BatchCreateMessagesOptions = {},
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  const expectedTenantId = options.tenantId ?? messages[0]?.tenantId;
  if (!expectedTenantId) {
    throw new Error('tenantId is required for tenant-scoped message writes');
  }

  let tenantMismatch = false;
  for (const message of messages) {
    if (!message.tenantId || message.tenantId !== expectedTenantId) {
      tenantMismatch = true;
      break;
    }
  }
  if (tenantMismatch) {
    throw new Error('All persisted messages must carry the same tenantId as the write scope');
  }

  // Map caller-provided messageId → Mongoose `_id` so explicit ids carry through
  // insertMany. The encryption plugin and tenant-isolation plugin both run on
  // pre('save')/pre('insertMany'); they don't touch `_id`, so this is safe.
  const docs = messages.map(({ messageId, ...rest }) =>
    messageId ? { _id: messageId, ...rest } : rest,
  );

  const { Message } = await import('@agent-platform/database/models');
  try {
    // ordered: false continues inserting remaining docs after duplicate key errors
    await Message.insertMany(docs, {
      ordered: false,
      ...mongooseWriteOptions(options),
    });
  } catch (err: any) {
    // Ignore duplicate key errors (code 11000) — means message already persisted
    if (err?.code === 11000 || err?.writeErrors?.every?.((e: any) => e.code === 11000)) {
      return;
    }
    throw err;
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────
// SYSTEM_CLEANUP: Cross-tenant batch operations — called only from scheduled retention job

export async function findOldSessions(
  cutoff: Date,
  statuses: string[],
  batchSize: number,
): Promise<Array<{ id: string }>> {
  const { Session } = await import('@agent-platform/database/models');
  const docs = await Session.find(
    { lastActivityAt: { $lt: cutoff }, status: { $in: statuses } },
    { _id: 1 },
  )
    .limit(batchSize)
    .lean();
  return docs.map((d: any) => ({ id: d._id as string }));
}

/**
 * Find old sessions scoped to a specific tenant.
 * Used by per-tenant retention cleanup to compute tenant-specific cutoff dates.
 */
export async function findOldSessionsByTenant(
  tenantId: string,
  cutoff: Date,
  statuses: string[],
  batchSize: number,
): Promise<Array<{ id: string }>> {
  const { Session } = await import('@agent-platform/database/models');
  const docs = await Session.find(
    { tenantId, lastActivityAt: { $lt: cutoff }, status: { $in: statuses } },
    { _id: 1 },
  )
    .limit(batchSize)
    .lean();
  return docs.map((d: any) => ({ id: d._id as string }));
}

/**
 * Get all distinct tenant IDs that have sessions in the database.
 * Used by per-tenant retention cleanup to iterate through tenants.
 */
export async function getDistinctTenantIds(): Promise<string[]> {
  const { Session } = await import('@agent-platform/database/models');
  return Session.distinct('tenantId').exec();
}

export async function deleteSessionsByIds(ids: string[], tenantId: string): Promise<number> {
  if (!tenantId) throw new Error('tenantId is required for tenant-scoped session queries');
  const { deleteSession: cascadeDeleteSession } = await import('@agent-platform/database/cascade');

  // Verify ownership before cascading
  const { Session } = await import('@agent-platform/database/models');
  const owned = await Session.find({ _id: { $in: ids }, tenantId }, { _id: 1 }).lean();
  const ownedIds = owned.map((d: any) => String(d._id));
  let total = 0;
  for (const id of ownedIds) {
    const result = await cascadeDeleteSession(id);
    total += result.counts.Session ?? 0;
  }
  return total;
}

/**
 * System-level variant for retention cleanup jobs that have no tenant context.
 * Operates across tenants — called only from scheduled retention jobs.
 */
export async function deleteSessionsByIdsSystem(ids: string[]): Promise<number> {
  const { deleteSession: cascadeDeleteSession } = await import('@agent-platform/database/cascade');
  let total = 0;
  for (const id of ids) {
    const result = await cascadeDeleteSession(id);
    total += result.counts.Session ?? 0;
  }
  return total;
}

export async function deleteOldMessages(cutoff: Date, terminalStatuses: string[]): Promise<number> {
  const { Message, Session } = await import('@agent-platform/database/models');
  // Find sessions that are in terminal status
  const sessionIds = await Session.find({ status: { $in: terminalStatuses } }, { _id: 1 })
    .lean()
    .then((docs: any[]) => docs.map((d: any) => d._id));
  if (sessionIds.length === 0) return 0;
  const result = await Message.deleteMany({
    timestamp: { $lt: cutoff },
    sessionId: { $in: sessionIds },
  });
  return result.deletedCount;
}
