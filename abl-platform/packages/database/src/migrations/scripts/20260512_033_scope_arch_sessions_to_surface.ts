/**
 * Migration: scope Arch session uniqueness to the active UI surface and thread.
 *
 * Agent-editor Arch sessions are intentionally independent from project-level
 * Arch sessions. Thread ID keeps future multi-tab/multi-thread sessions from
 * colliding inside the same surface. Older environments may still have a legacy
 * unique index on tenant/user/mode/project, which makes `/api/arch-ai/sessions`
 * return 409 when a second surface or thread tries to create its own session.
 */

import type mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { hasIndex, validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;
type Collection = mongoose.mongo.Collection;
type IndexDescription = mongoose.mongo.IndexDescriptionInfo;

const COLLECTION = 'arch_sessions';
const CURRENT_IN_PROJECT_SESSION_CONTRACT_VERSION = 3;
const PROJECT_SESSION_AGENT_KEY = '__project__';
const DEFAULT_SESSION_THREAD_ID = '__default__';

const LEGACY_LOOKUP_INDEX_KEY = {
  tenantId: 1,
  userId: 1,
  'metadata.mode': 1,
  'metadata.projectId': 1,
  state: 1,
} as const;

const LEGACY_UNIQUE_INDEX_KEY = {
  tenantId: 1,
  userId: 1,
  'metadata.mode': 1,
  'metadata.projectId': 1,
} as const;

const SURFACE_LOOKUP_INDEX_KEY = {
  tenantId: 1,
  userId: 1,
  'metadata.mode': 1,
  'metadata.projectId': 1,
  'metadata.surface': 1,
  'metadata.agentNameKey': 1,
  state: 1,
} as const;

const SURFACE_UNIQUE_INDEX_KEY = {
  tenantId: 1,
  userId: 1,
  'metadata.mode': 1,
  'metadata.projectId': 1,
  'metadata.surface': 1,
  'metadata.agentNameKey': 1,
} as const;

const CANONICAL_LOOKUP_INDEX_KEY = {
  tenantId: 1,
  userId: 1,
  'metadata.mode': 1,
  'metadata.projectId': 1,
  'metadata.surface': 1,
  'metadata.agentNameKey': 1,
  'metadata.threadId': 1,
  state: 1,
} as const;

const CANONICAL_UNIQUE_INDEX_KEY = {
  tenantId: 1,
  userId: 1,
  'metadata.mode': 1,
  'metadata.projectId': 1,
  'metadata.surface': 1,
  'metadata.agentNameKey': 1,
  'metadata.threadId': 1,
} as const;

const CANONICAL_LOOKUP_INDEX_NAME = 'arch_session_scope_thread_lookup_v1';
const CANONICAL_UNIQUE_INDEX_NAME = 'arch_session_scope_thread_unique_v1';

const NON_TERMINAL_STATES = ['IDLE', 'ACTIVE', 'GATE_PENDING'] as const;
const NON_TERMINAL_PARTIAL_FILTER = {
  state: { $in: [...NON_TERMINAL_STATES] },
} as const;

const CANONICAL_SCOPE_FIELDS = [
  'tenantId',
  'userId',
  'metadata.mode',
  'metadata.projectId',
  'metadata.surface',
  'metadata.agentNameKey',
  'metadata.threadId',
] as const;

const LEGACY_SCOPE_FIELDS = ['tenantId', 'userId', 'metadata.mode', 'metadata.projectId'] as const;

function sameIndexKey(left: IndexDescription['key'], right: Record<string, 1>): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right);
}

function isIndexNotFound(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : null;
  const codeName =
    typeof err === 'object' && err !== null ? (err as { codeName?: unknown }).codeName : null;
  return code === 27 || codeName === 'IndexNotFound';
}

function getPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function scopeKey(document: Record<string, unknown>, fields: readonly string[]): string {
  return JSON.stringify(fields.map((field) => getPath(document, field) ?? null));
}

async function dropIndexesByKey(
  collection: Collection,
  keys: ReadonlyArray<Record<string, 1>>,
): Promise<string[]> {
  const indexes = await collection.indexes();
  const dropped: string[] = [];

  for (const index of indexes) {
    if (!index.name || index.name === '_id_') {
      continue;
    }
    if (!keys.some((key) => sameIndexKey(index.key, key))) {
      continue;
    }

    try {
      await collection.dropIndex(index.name);
      dropped.push(index.name);
      console.log(`[migration] Dropped Arch session index: ${index.name}`);
    } catch (err: unknown) {
      if (!isIndexNotFound(err)) {
        throw err;
      }
    }
  }

  return dropped;
}

async function backfillSessionScopeDefaults(collection: Collection): Promise<void> {
  await collection.updateMany(
    { 'metadata.mode': 'IN_PROJECT', 'metadata.contractVersion': { $exists: false } },
    { $set: { 'metadata.contractVersion': CURRENT_IN_PROJECT_SESSION_CONTRACT_VERSION } },
  );
  await collection.updateMany(
    { 'metadata.surface': { $exists: false } },
    { $set: { 'metadata.surface': 'project' } },
  );
  await collection.updateMany(
    { 'metadata.agentName': { $exists: false } },
    { $set: { 'metadata.agentName': null } },
  );
  await collection.updateMany(
    { 'metadata.agentNameKey': { $exists: false } },
    { $set: { 'metadata.agentNameKey': PROJECT_SESSION_AGENT_KEY } },
  );
  await collection.updateMany(
    { 'metadata.threadId': { $exists: false } },
    { $set: { 'metadata.threadId': DEFAULT_SESSION_THREAD_ID } },
  );
}

async function archiveDuplicateNonTerminalSessions(
  collection: Collection,
  scopeFields: readonly string[],
): Promise<number> {
  const sessions = await collection
    .find({ state: { $in: [...NON_TERMINAL_STATES] } })
    .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
    .toArray();

  const seen = new Set<string>();
  const duplicateIds: unknown[] = [];

  for (const session of sessions) {
    const key = scopeKey(session, scopeFields);
    if (seen.has(key)) {
      duplicateIds.push(session._id);
      continue;
    }
    seen.add(key);
  }

  if (duplicateIds.length === 0) {
    return 0;
  }

  const duplicateFilter = { _id: { $in: duplicateIds } } as Parameters<Collection['updateMany']>[0];
  const result = await collection.updateMany(duplicateFilter, {
    $set: { state: 'ARCHIVED', archivedAt: new Date() },
  });
  const archivedCount = result.modifiedCount ?? 0;
  console.log(`[migration] Archived ${archivedCount} duplicate Arch sessions before index repair`);
  return archivedCount;
}

async function ensureCanonicalIndexes(collection: Collection): Promise<void> {
  await collection.createIndex(CANONICAL_LOOKUP_INDEX_KEY, {
    name: CANONICAL_LOOKUP_INDEX_NAME,
  });
  await collection.createIndex(CANONICAL_UNIQUE_INDEX_KEY, {
    name: CANONICAL_UNIQUE_INDEX_NAME,
    unique: true,
    partialFilterExpression: NON_TERMINAL_PARTIAL_FILTER,
  });
}

async function listUniqueIndexNamesByKey(
  collection: Collection,
  key: Record<string, 1>,
): Promise<string[]> {
  const indexes = await collection.indexes();
  return indexes
    .filter((index) => index.unique === true && sameIndexKey(index.key, key))
    .map((index) => index.name)
    .filter((name): name is string => typeof name === 'string');
}

export const migration: Migration = {
  version: '20260512_033',
  description: 'Scope Arch AI session uniqueness to project/agent surfaces and hidden threads',
  transactionMode: 'none',

  async up(db: Db) {
    const collection = db.collection(COLLECTION);

    await backfillSessionScopeDefaults(collection);
    await archiveDuplicateNonTerminalSessions(collection, CANONICAL_SCOPE_FIELDS);
    await dropIndexesByKey(collection, [
      LEGACY_LOOKUP_INDEX_KEY,
      LEGACY_UNIQUE_INDEX_KEY,
      SURFACE_LOOKUP_INDEX_KEY,
      SURFACE_UNIQUE_INDEX_KEY,
      CANONICAL_LOOKUP_INDEX_KEY,
      CANONICAL_UNIQUE_INDEX_KEY,
    ]);
    await ensureCanonicalIndexes(collection);
  },

  async down(db: Db) {
    const collection = db.collection(COLLECTION);

    await archiveDuplicateNonTerminalSessions(collection, LEGACY_SCOPE_FIELDS);
    await dropIndexesByKey(collection, [CANONICAL_LOOKUP_INDEX_KEY, CANONICAL_UNIQUE_INDEX_KEY]);
    await collection.createIndex(LEGACY_LOOKUP_INDEX_KEY, {
      name: 'tenantId_1_userId_1_metadata.mode_1_metadata.projectId_1_state_1',
    });
    await collection.createIndex(LEGACY_UNIQUE_INDEX_KEY, {
      name: 'tenantId_1_userId_1_metadata.mode_1_metadata.projectId_1',
      unique: true,
      partialFilterExpression: NON_TERMINAL_PARTIAL_FILTER,
    });
  },

  async validate(db: Db) {
    const collection = db.collection(COLLECTION);
    const [
      canonicalLookupPresent,
      canonicalUniquePresent,
      legacyUniqueIndexes,
      surfaceUniqueIndexes,
    ] = await Promise.all([
      hasIndex(db, COLLECTION, CANONICAL_LOOKUP_INDEX_KEY, {
        name: CANONICAL_LOOKUP_INDEX_NAME,
      }),
      hasIndex(db, COLLECTION, CANONICAL_UNIQUE_INDEX_KEY, {
        name: CANONICAL_UNIQUE_INDEX_NAME,
        unique: true,
        partialFilterExpression: NON_TERMINAL_PARTIAL_FILTER,
      }),
      listUniqueIndexNamesByKey(collection, LEGACY_UNIQUE_INDEX_KEY),
      listUniqueIndexNamesByKey(collection, SURFACE_UNIQUE_INDEX_KEY),
    ]);

    if (
      !canonicalLookupPresent ||
      !canonicalUniquePresent ||
      legacyUniqueIndexes.length > 0 ||
      surfaceUniqueIndexes.length > 0
    ) {
      return validationFailed(
        'Arch session uniqueness is not scoped to surface, agent, and thread',
        {
          canonicalLookupPresent,
          canonicalUniquePresent,
          legacyUniqueIndexes,
          surfaceUniqueIndexes,
        },
      );
    }

    return validationPassed('Arch session uniqueness is scoped to surface, agent, and thread', {
      canonicalLookupPresent,
      canonicalUniquePresent,
      legacyUniqueIndexes,
      surfaceUniqueIndexes,
    });
  },
};

export default migration;
