/**
 * Migration: Fix verifyTokenHash unique index on channel_connections
 *
 * The existing index uses `sparse: true`, which only excludes documents where
 * the field is missing entirely. Since the schema defaults verifyTokenHash to
 * null, every document has an explicit null value, causing duplicate key errors
 * for docs with { channelType: "slack", verifyTokenHash: null }.
 *
 * Fix: Replace `sparse: true` with a `partialFilterExpression` that excludes
 * null values, so uniqueness is only enforced when verifyTokenHash is set.
 *
 * Date: 2026-03-04
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { findIndex, validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

const COLLECTION = 'channel_connections';
const OLD_INDEX_NAME = 'channelType_1_verifyTokenHash_1';

export const migration: Migration = {
  version: '20260304_008',
  description: 'Fix verifyTokenHash unique index to use partialFilterExpression instead of sparse',

  async up(db: Db) {
    const col = db.collection(COLLECTION);

    // Step 1: Drop the old sparse unique index
    try {
      await col.dropIndex(OLD_INDEX_NAME);
      console.log(`[migration] Dropped old index: ${OLD_INDEX_NAME}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Index may not exist — safe to continue
      console.log(`[migration] Index ${OLD_INDEX_NAME} not found (${message}), continuing`);
    }

    // Step 2: Create new index with partialFilterExpression excluding nulls
    await col.createIndex(
      { channelType: 1, verifyTokenHash: 1 },
      {
        unique: true,
        partialFilterExpression: {
          verifyTokenHash: { $type: 'string' },
        },
      },
    );
    console.log('[migration] Created new index with partialFilterExpression');
  },

  async down(db: Db) {
    const col = db.collection(COLLECTION);

    // Drop the new partial index
    // The name will be the same since the key spec is identical
    try {
      await col.dropIndex(OLD_INDEX_NAME);
      console.log(`[migration] Dropped partial index: ${OLD_INDEX_NAME}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[migration] Index ${OLD_INDEX_NAME} not found (${message}), continuing`);
    }

    // Restore original sparse unique index
    await col.createIndex({ channelType: 1, verifyTokenHash: 1 }, { unique: true, sparse: true });
    console.log('[migration] Restored sparse unique index');
  },

  async validate(db: Db) {
    const fixedIndex = await findIndex(
      db,
      COLLECTION,
      { channelType: 1, verifyTokenHash: 1 },
      { unique: true },
    );

    const isFixed =
      fixedIndex !== null &&
      fixedIndex.sparse !== true &&
      JSON.stringify(fixedIndex.partialFilterExpression ?? null) ===
        JSON.stringify({ verifyTokenHash: { $type: 'string' } });

    if (!isFixed) {
      return validationFailed('verifyTokenHash index is not using the expected partial filter', {
        fixedIndex,
      });
    }

    return validationPassed('verifyTokenHash index uses a partial filter instead of sparse', {
      indexName: fixedIndex.name ?? OLD_INDEX_NAME,
    });
  },
};

export default migration;
