/**
 * Migration: Rename `conversations` collection to `sessions`
 *
 * The Session model historically used collection name 'conversations' but the
 * domain concept is 'sessions'. This rename aligns the collection name with the
 * model and all query references.
 *
 * Idempotent — skips if the source collection does not exist.
 *
 * Date: 2026-03-06
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';

type Db = mongoose.mongo.Db;

export const migration: Migration = {
  version: '20260306_011',
  description: 'Rename conversations collection to sessions',

  async up(db: Db) {
    const collections = await db.listCollections({ name: 'conversations' }).toArray();
    if (collections.length > 0) {
      await db.renameCollection('conversations', 'sessions');
    }
  },

  async down(db: Db) {
    const collections = await db.listCollections({ name: 'sessions' }).toArray();
    if (collections.length > 0) {
      await db.renameCollection('sessions', 'conversations');
    }
  },
};

export default migration;
