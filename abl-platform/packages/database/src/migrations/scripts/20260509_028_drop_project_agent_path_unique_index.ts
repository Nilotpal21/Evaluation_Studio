/**
 * Migration: drop ProjectAgent agentPath uniqueness.
 *
 * ProjectAgent identity is `{ tenantId, projectId, name }`. `agentPath` is a
 * derived locator (`projectId/name`), so unique indexes on that field duplicate
 * the name constraint and can block stale-path repair/import flows. Keep a
 * non-unique lookup index for path-based reads.
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { hasIndex, validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;
type IndexDescription = mongoose.mongo.IndexDescriptionInfo;

const COLLECTION = 'project_agents';
const IDENTITY_INDEX_NAME = 'tenantId_1_projectId_1_name_1';
const AGENT_PATH_LOOKUP_INDEX_NAME = 'tenantId_1_projectId_1_agentPath_1';
const UNIQUE_AGENT_PATH_INDEX_KEYS = [
  { agentPath: 1 },
  { projectId: 1, agentPath: 1 },
  { tenantId: 1, projectId: 1, agentPath: 1 },
] as const;

function sameIndexKey(left: IndexDescription['key'], right: Record<string, 1>): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right);
}

async function dropUniqueAgentPathIndexes(db: Db): Promise<number> {
  const collection = db.collection(COLLECTION);
  const indexes = await collection.indexes();
  let dropped = 0;

  for (const index of indexes) {
    if (
      index.name &&
      index.unique === true &&
      UNIQUE_AGENT_PATH_INDEX_KEYS.some((key) => sameIndexKey(index.key, key))
    ) {
      await collection.dropIndex(index.name);
      dropped += 1;
      console.log(`[migration] Dropped unique ProjectAgent agentPath index ${index.name}`);
    }
  }

  return dropped;
}

export const migration: Migration = {
  version: '20260509_028',
  description: 'Drop ProjectAgent agentPath uniqueness and keep it as a lookup index',
  transactionMode: 'none',

  async up(db: Db) {
    const collection = db.collection(COLLECTION);
    const dropped = await dropUniqueAgentPathIndexes(db);

    await collection.createIndex(
      { tenantId: 1, projectId: 1, name: 1 },
      { unique: true, name: IDENTITY_INDEX_NAME },
    );
    console.log(`[migration] Ensured ${IDENTITY_INDEX_NAME}`);

    await collection.createIndex(
      { tenantId: 1, projectId: 1, agentPath: 1 },
      { name: AGENT_PATH_LOOKUP_INDEX_NAME },
    );
    console.log(
      `[migration] Ensured non-unique ${AGENT_PATH_LOOKUP_INDEX_NAME}; dropped ${dropped} unique agentPath index(es)`,
    );
  },

  async down(db: Db) {
    const collection = db.collection(COLLECTION);

    try {
      await collection.dropIndex(AGENT_PATH_LOOKUP_INDEX_NAME);
      console.log(`[migration] Dropped non-unique ${AGENT_PATH_LOOKUP_INDEX_NAME}`);
    } catch (err: unknown) {
      const code =
        typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : null;
      const codeName =
        typeof err === 'object' && err !== null ? (err as { codeName?: unknown }).codeName : null;
      if (code !== 27 && codeName !== 'IndexNotFound') {
        throw err;
      }
      console.log(`[migration] ${AGENT_PATH_LOOKUP_INDEX_NAME} not found; skipping drop`);
    }

    await collection.createIndex(
      { tenantId: 1, projectId: 1, agentPath: 1 },
      { unique: true, name: AGENT_PATH_LOOKUP_INDEX_NAME },
    );
    console.log(`[migration] Restored unique ${AGENT_PATH_LOOKUP_INDEX_NAME}`);
  },

  async validate(db: Db) {
    const [identityIndexPresent, lookupIndexPresent, uniqueAgentPathIndexes] = await Promise.all([
      hasIndex(
        db,
        COLLECTION,
        { tenantId: 1, projectId: 1, name: 1 },
        { unique: true, name: IDENTITY_INDEX_NAME },
      ),
      hasIndex(
        db,
        COLLECTION,
        { tenantId: 1, projectId: 1, agentPath: 1 },
        { name: AGENT_PATH_LOOKUP_INDEX_NAME },
      ),
      db
        .collection(COLLECTION)
        .indexes()
        .then((indexes) =>
          indexes
            .filter(
              (index) =>
                index.unique === true &&
                UNIQUE_AGENT_PATH_INDEX_KEYS.some((key) => sameIndexKey(index.key, key)),
            )
            .map((index) => index.name),
        ),
    ]);

    if (!identityIndexPresent || !lookupIndexPresent || uniqueAgentPathIndexes.length > 0) {
      return validationFailed(
        'project_agents agentPath uniqueness has not been fully replaced by the name identity index',
        {
          identityIndexPresent,
          lookupIndexPresent,
          uniqueAgentPathIndexes,
        },
      );
    }

    return validationPassed(
      'project_agents agentPath is indexed for lookup only; uniqueness is enforced by name identity',
      {
        identityIndexPresent,
        lookupIndexPresent,
        uniqueAgentPathIndexes,
      },
    );
  },
};

export default migration;
