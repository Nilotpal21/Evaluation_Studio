/**
 * MongoDB Retention Store
 *
 * Concrete implementation of RetentionStore using Mongoose models.
 * Handles session archival, deletion, trace purging, and PII scrubbing
 * with batched operations for performance.
 */

import type { RetentionStore } from './retention-service';

const BATCH_SIZE = 100;

export class MongoRetentionStore implements RetentionStore {
  async findSessionsOlderThan(tenantId: string, date: Date): Promise<string[]> {
    const { Session } = await import('@agent-platform/database/models');
    const sessions = await Session.find({
      tenantId,
      status: { $ne: 'archived' },
      lastActivityAt: { $lt: date },
    })
      .select('_id')
      .limit(1000)
      .lean();
    return sessions.map((s: any) => s._id as string);
  }

  async findArchivedSessionsOlderThan(tenantId: string, date: Date): Promise<string[]> {
    const { Session } = await import('@agent-platform/database/models');
    const sessions = await Session.find({
      tenantId,
      status: 'archived',
      archivedAt: { $lt: date },
    })
      .select('_id')
      .limit(1000)
      .lean();
    return sessions.map((s: any) => s._id as string);
  }

  async findTracesOlderThan(_tenantId: string, _date: Date): Promise<string[]> {
    // Trace events are stored at the runtime level (eventstore), not in the
    // platform Message collection. Returning empty here prevents trace retention
    // from accidentally deleting Message rows — messages are only deleted via
    // session cascade or the message retention policy.
    // Event-level trace purging is handled by EventRetentionService.
    return [];
  }

  async findMessagesWithPIIOlderThan(tenantId: string, date: Date): Promise<string[]> {
    const { Message } = await import('@agent-platform/database/models');
    const messages = await Message.find({
      tenantId,
      hasPII: true,
      scrubbed: false,
      timestamp: { $lt: date },
    })
      .select('_id')
      .limit(1000)
      .lean();
    return messages.map((m: any) => m._id as string);
  }

  async archiveSessions(sessionIds: string[], tenantId: string): Promise<void> {
    const { Session } = await import('@agent-platform/database/models');
    await Session.updateMany(
      { _id: { $in: sessionIds }, tenantId },
      { $set: { status: 'archived', archivedAt: new Date() } },
    );
  }

  async deleteSession(sessionId: string, _tenantId: string): Promise<void> {
    // Note: cascadeDeleteSession operates by sessionId alone. Tenant verification
    // is performed by the caller (RetentionService.executeRetentionPlan) before
    // reaching this point. The cascade function does not support tenantId filtering.
    const { deleteSession: cascadeDeleteSession } =
      await import('@agent-platform/database/cascade');
    await cascadeDeleteSession(sessionId);
  }

  async deleteTraces(_traceIds: string[]): Promise<void> {
    // No-op: trace events live in the eventstore, not the Message collection.
    // Event-level trace purging is handled by EventRetentionService.
    // This prevents trace retention from prematurely deleting messages.
  }

  async scrubPIIBatch(messageIds: string[], tenantId: string): Promise<void> {
    const { Message } = await import('@agent-platform/database/models');
    for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
      const batch = messageIds.slice(i, i + BATCH_SIZE);
      await Message.updateMany(
        { _id: { $in: batch }, tenantId },
        { $set: { content: '[PII_SCRUBBED]', scrubbed: true } },
      );
    }
  }
}
