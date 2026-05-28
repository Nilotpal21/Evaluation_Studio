/**
 * Session Repository (Studio — read-only)
 *
 * Direct MongoDB queries for session listing and detail.
 * Replaces the proxy-to-Runtime pattern for read operations that
 * only need persisted session metadata (not in-memory trace data).
 *
 * Write operations (close, reset, delete) still proxy to Runtime
 * because they require pod-local RuntimeExecutor state.
 */

import { ensureDb } from '@/lib/ensure-db';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeId(doc: any): any {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { ...rest, id: _id };
}

// =============================================================================
// LIST
// =============================================================================

export interface SessionListFilters {
  status?: string;
  channel?: string;
}

export async function listSessionsForProject(
  projectId: string,
  tenantId: string,
  filters: SessionListFilters = {},
  opts: { limit?: number; offset?: number } = {},
) {
  await ensureDb();
  const { Session } = await import('@agent-platform/database/models');

  const limit = Math.min(opts.limit || 50, 200);
  const offset = opts.offset || 0;

  const where: Record<string, unknown> = { tenantId, projectId };
  if (filters.status) where.status = filters.status;
  if (filters.channel) where.channel = filters.channel;

  const [docs, total] = await Promise.all([
    Session.find(where)
      .select(
        '_id currentAgent channel status messageCount tokenCount estimatedCost errorCount handoffCount traceEventCount callDuration disposition dispositionCode startedAt lastActivityAt endedAt projectId environment',
      )
      .sort({ startedAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean(),
    Session.countDocuments(where),
  ]);

  // Filter out ghost sessions (0 messages, 0 traces)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const liveSessions = docs.filter((s: any) => {
    const msgCount = s.messageCount || 0;
    const traceCount = s.traceEventCount || 0;
    return msgCount > 0 || traceCount > 0;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessions = liveSessions.map((s: any) => {
    const endedAt = s.endedAt as Date | null;
    const messageCount = s.messageCount || 0;
    let durationMs = 0;
    if (s.callDuration && s.callDuration > 0) {
      durationMs = s.callDuration * 1000;
    } else if (endedAt) {
      durationMs = new Date(endedAt).getTime() - new Date(s.startedAt).getTime();
    } else if (messageCount > 0 && s.lastActivityAt) {
      durationMs = new Date(s.lastActivityAt).getTime() - new Date(s.startedAt).getTime();
    }

    return {
      id: s._id,
      agentId: s.currentAgent,
      agentName: s.currentAgent,
      durationMs: Math.max(0, durationMs),
      messageCount,
      traceEventCount: s.traceEventCount || 0,
      tokenCount: s.tokenCount || 0,
      estimatedCost: s.estimatedCost || 0,
      errorCount: s.errorCount || 0,
      disposition: s.disposition || null,
      createdAt: s.startedAt ? new Date(s.startedAt).toISOString() : new Date().toISOString(),
      lastActivityAt: s.lastActivityAt
        ? new Date(s.lastActivityAt).toISOString()
        : new Date().toISOString(),
      status: s.status,
      channel: s.channel,
      projectId: s.projectId,
      environment: s.environment,
    };
  });

  return { sessions, total, offset, limit };
}

// =============================================================================
// COUNT
// =============================================================================

export async function countSessionsForProject(
  projectId: string,
  tenantId: string,
): Promise<number> {
  await ensureDb();
  const { Session } = await import('@agent-platform/database/models');
  return Session.countDocuments({ tenantId, projectId });
}

// =============================================================================
// FIND BY ID
// =============================================================================

export async function findSessionById(sessionId: string, tenantId: string) {
  await ensureDb();
  const { Session } = await import('@agent-platform/database/models');
  const doc = await Session.findOne({ _id: sessionId, tenantId })
    .select('-context -metadata')
    .lean();
  return doc ? normalizeId(doc) : null;
}

// =============================================================================
// MESSAGES FOR SESSION
// =============================================================================

export async function findMessagesForSession(
  sessionId: string,
  tenantId: string,
  limit = 200,
): Promise<Array<{ id: string; role: string; content: string; timestamp: Date }>> {
  await ensureDb();
  const { Message } = await import('@agent-platform/database/models');
  // Do NOT use .lean() — Mongoose post-hooks handle decryption of encrypted fields
  const docs = await Message.find({ sessionId, tenantId })
    .sort({ timestamp: 1 })
    .limit(limit)
    .select({ _id: 1, role: 1, content: 1, timestamp: 1, tenantId: 1, ire: 1 });
  return docs.map((d: any) => ({
    id: d._id,
    role: d.role,
    content: d.content || '',
    timestamp: d.timestamp,
  }));
}
