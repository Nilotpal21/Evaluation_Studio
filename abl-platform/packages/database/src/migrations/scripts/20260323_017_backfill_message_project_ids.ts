/**
 * Migration: Backfill projectId on messages from their session's projectId
 *
 * Messages written before project scoping have `projectId: ''` or missing.
 * This one-time migration iterates all sessions with a non-null, non-empty
 * projectId and backfills their messages.
 *
 * - Batch size: 100 sessions per iteration (prevents memory pressure)
 * - Idempotent: re-running skips already-backfilled messages
 * - Skips legacy pre-project sessions (null/empty projectId)
 *
 * Date: 2026-03-23
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

// Migration scripts run in a standalone Node.js CLI context without the full
// platform runtime. createLogger requires the platform DI container which is
// not initialized here, so we use a lightweight shim backed by process.stdout.
const log = {
  info: (msg: string) => process.stdout.write(`[migration] ${msg}\n`),
};

const SESSIONS_COLLECTION = 'sessions';
const MESSAGES_COLLECTION = 'messages';
const BATCH_SIZE = 100;

export const migration: Migration = {
  version: '20260323_017',
  description: 'Backfill projectId on messages from their session projectId',

  async up(db: Db) {
    const sessions = db.collection(SESSIONS_COLLECTION);
    const messages = db.collection(MESSAGES_COLLECTION);

    let totalSessionsProcessed = 0;
    let totalMessagesUpdated = 0;
    let lastId: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Paginate through sessions with projectId set, using _id cursor.
      // Skip sessions with null or empty projectId (legacy pre-project sessions).
      const filter: Record<string, unknown> = {
        projectId: { $nin: [null, ''] },
      };
      if (lastId) {
        filter._id = { $gt: lastId };
      }

      const batch = await sessions
        .find(filter, {
          projection: { _id: 1, tenantId: 1, projectId: 1 },
          sort: { _id: 1 },
          limit: BATCH_SIZE,
        })
        .toArray();

      if (batch.length === 0) break;

      for (const session of batch) {
        const result = await messages.updateMany(
          {
            sessionId: String(session._id),
            tenantId: session.tenantId,
            $or: [{ projectId: '' }, { projectId: { $exists: false } }],
          },
          { $set: { projectId: session.projectId } },
        );

        if (result.modifiedCount > 0) {
          totalMessagesUpdated += result.modifiedCount;
        }
      }

      totalSessionsProcessed += batch.length;
      lastId = String(batch[batch.length - 1]._id);

      if (totalSessionsProcessed % 1000 === 0) {
        log.info(
          `Backfill progress: ${totalSessionsProcessed} sessions processed, ${totalMessagesUpdated} messages updated`,
        );
      }
    }

    log.info(
      `Backfill complete: ${totalSessionsProcessed} sessions processed, ${totalMessagesUpdated} messages updated`,
    );
  },

  async down(_db: Db) {
    // Down migration is a no-op: we cannot distinguish messages that were
    // backfilled from ones that had projectId set at creation time.
    // This is safe because the projectId values are correct regardless.
    log.info('Rollback is a no-op — cannot distinguish backfilled projectId from original');
  },

  async validate(db: Db) {
    const messages = db.collection(MESSAGES_COLLECTION);

    const [remainingGap] = await messages
      .aggregate<{ count: number }>([
        {
          $match: {
            $or: [{ projectId: '' }, { projectId: { $exists: false } }],
          },
        },
        {
          $lookup: {
            from: SESSIONS_COLLECTION,
            localField: 'sessionId',
            foreignField: '_id',
            as: 'sessionDocs',
          },
        },
        { $unwind: '$sessionDocs' },
        {
          $match: {
            'sessionDocs.projectId': { $nin: [null, ''] },
            $expr: { $eq: ['$tenantId', '$sessionDocs.tenantId'] },
          },
        },
        { $count: 'count' },
      ])
      .toArray();

    const remaining = remainingGap?.count ?? 0;
    if (remaining > 0) {
      return validationFailed(
        'Some messages are still missing projectId despite their session having one',
        {
          remaining,
        },
      );
    }

    return validationPassed('All eligible messages have projectId backfilled from their session', {
      remaining,
    });
  },
};

export default migration;
