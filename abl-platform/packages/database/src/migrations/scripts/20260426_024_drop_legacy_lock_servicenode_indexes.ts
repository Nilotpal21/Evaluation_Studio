/**
 * Migration: Drop the legacy non-tenant-scoped unique indexes on
 *            agent_locks and service_nodes.
 *
 * ABLP-574 added new tenant-scoped unique indexes to both collections
 * (`{tenantId, projectId, agentId, lockType}` on agent_locks and
 * `{tenantId, projectId, name}` on service_nodes). MongoDB does not
 * automatically remove the prior unique indexes on a schema change, so the
 * deployed databases still carry:
 *
 *   - agent_locks: legacy unique index on `{projectId, agentId, lockType}`
 *   - service_nodes: legacy unique index on `{projectId, name}`
 *
 * Those legacy indexes still reject cross-tenant rows that share the same
 * project/agent/name id, which negates the tenant hardening. This migration
 * drops them so the new tenant-scoped indexes become the sole uniqueness
 * constraint.
 *
 * Idempotent: skip-and-log when the legacy index is not found (already
 * dropped in a prior run, or never deployed). Only logs a warning if a
 * different unexpected index turns out to be the conflicting one — never
 * blocks the migration.
 *
 * Reversibility: rollback intentionally does NOT recreate the legacy
 * indexes. They were the bug we are removing; bringing them back would
 * re-introduce the cross-tenant uniqueness collision risk.
 *
 * Date: 2026-04-26
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';

type Db = mongoose.mongo.Db;

const log = {
  info: (msg: string) => process.stdout.write(`[migration] ${msg}\n`),
  warn: (msg: string) => process.stdout.write(`[migration] WARN ${msg}\n`),
};

interface LegacyIndexSpec {
  collection: string;
  /** Field map of the legacy index that must be dropped. */
  key: Record<string, 1 | -1>;
}

const LEGACY_INDEXES: readonly LegacyIndexSpec[] = [
  {
    collection: 'agent_locks',
    key: { projectId: 1, agentId: 1, lockType: 1 },
  },
  {
    collection: 'service_nodes',
    key: { projectId: 1, name: 1 },
  },
];

function keysEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  if (aKeys.some((k) => !(k in b))) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

async function dropLegacyIndex(db: Db, spec: LegacyIndexSpec): Promise<void> {
  const collection = db.collection(spec.collection);
  const indexes = await collection.indexes();

  // Match the LEGACY index by key shape AND uniqueness — exclude the new
  // tenant-scoped index (which starts with `tenantId`) so we never drop the
  // intended replacement.
  const legacy = indexes.find(
    (idx) =>
      keysEqual(idx.key as Record<string, unknown>, spec.key) &&
      (idx as { unique?: boolean }).unique === true,
  );

  if (!legacy) {
    log.info(
      `${spec.collection}: legacy unique index ${JSON.stringify(spec.key)} not found — skipped (idempotent)`,
    );
    return;
  }

  if (!legacy.name) {
    log.warn(
      `${spec.collection}: matched legacy index has no name; refusing to drop. Inspect with db.${spec.collection}.getIndexes() and drop manually.`,
    );
    return;
  }

  await collection.dropIndex(legacy.name);
  log.info(
    `${spec.collection}: dropped legacy unique index ${legacy.name} (${JSON.stringify(spec.key)})`,
  );
}

export const migration: Migration = {
  version: '20260426_024',
  description: 'Drop legacy non-tenant-scoped unique indexes on agent_locks and service_nodes',

  // Index DDL must run outside transactions on most MongoDB topologies.
  transactionMode: 'none',

  async up(db: Db) {
    for (const spec of LEGACY_INDEXES) {
      await dropLegacyIndex(db, spec);
    }
  },

  async down() {
    // Rollback is intentionally a no-op: the legacy indexes were the bug
    // (cross-tenant uniqueness collisions); recreating them would
    // re-introduce the security gap that ABLP-574 closed.
  },
};
