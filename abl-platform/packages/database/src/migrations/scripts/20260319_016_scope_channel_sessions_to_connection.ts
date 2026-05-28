/**
 * Migration: scope channel session uniqueness to channel connection
 *
 * The legacy unique index keyed channel sessions by `{ tenantId, externalSessionKey }`,
 * which allowed unrelated channel connections inside the same tenant to collide on
 * identical external keys (for example shared call IDs, channel IDs, or thread IDs).
 *
 * Fix: replace the unique index with `{ tenantId, channelConnectionId, externalSessionKey }`.
 *
 * Date: 2026-03-19
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { hasIndex, validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

const COLLECTION = 'channel_sessions';
const OLD_INDEX_NAME = 'tenantId_1_externalSessionKey_1';
const NEW_INDEX_NAME = 'tenantId_1_channelConnectionId_1_externalSessionKey_1';

export const migration: Migration = {
  version: '20260319_016',
  description: 'Scope channel session uniqueness to tenant + connection + external session key',

  async up(db: Db) {
    const col = db.collection(COLLECTION);

    try {
      await col.dropIndex(OLD_INDEX_NAME);
      console.log(`[migration] Dropped old index: ${OLD_INDEX_NAME}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[migration] Index ${OLD_INDEX_NAME} not found (${message}), continuing`);
    }

    await col.createIndex(
      { tenantId: 1, channelConnectionId: 1, externalSessionKey: 1 },
      { unique: true, name: NEW_INDEX_NAME },
    );
    console.log(`[migration] Created new index: ${NEW_INDEX_NAME}`);
  },

  async down(db: Db) {
    const col = db.collection(COLLECTION);

    try {
      await col.dropIndex(NEW_INDEX_NAME);
      console.log(`[migration] Dropped new index: ${NEW_INDEX_NAME}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[migration] Index ${NEW_INDEX_NAME} not found (${message}), continuing`);
    }

    await col.createIndex({ tenantId: 1, externalSessionKey: 1 }, { unique: true });
    console.log(`[migration] Restored old index: ${OLD_INDEX_NAME}`);
  },

  async validate(db: Db) {
    const newIndexPresent = await hasIndex(
      db,
      COLLECTION,
      { tenantId: 1, channelConnectionId: 1, externalSessionKey: 1 },
      { unique: true, name: NEW_INDEX_NAME },
    );
    const oldIndexPresent = await hasIndex(
      db,
      COLLECTION,
      { tenantId: 1, externalSessionKey: 1 },
      { unique: true },
    );

    if (!newIndexPresent || oldIndexPresent) {
      return validationFailed(
        'channel_sessions index scoping does not match the expected post-migration state',
        {
          newIndexPresent,
          oldIndexPresent,
        },
      );
    }

    return validationPassed(
      'channel_sessions uniqueness is scoped to tenant + connection + external session key',
      {
        newIndexPresent,
        oldIndexPresent,
      },
    );
  },
};

export default migration;
