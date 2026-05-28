/**
 * ClickHouse-based Distributed Lock for Schema Reconciliation
 *
 * Uses a ClickHouse table (_schema_lock) for distributed locking —
 * same pattern as MongoDB migrations use _migration_lock.
 * No external Redis dependency required.
 *
 * Lock mechanism:
 * - INSERT with TTL-based expiry check (SELECT ... WHERE expiresAt < now())
 * - Holder-checked release (DELETE WHERE holder = ?)
 * - Heartbeat extend (ALTER UPDATE expiresAt WHERE holder = ?)
 *
 * When ClickHouse is unavailable:
 * - In execute mode: throws — unsafe without coordination
 * - Otherwise: returns no-op lock
 */

import type { ClickHouseClient } from '@clickhouse/client';
import { resolveClickHouseDatabaseName } from './database.js';

export interface SchemaLock {
  acquired: boolean;
  release: () => Promise<void>;
  extend: () => Promise<void>;
}

/**
 * Format a Date as ClickHouse DateTime64(3) string: 'YYYY-MM-DD HH:MM:SS.mmm'
 */
function formatClickHouseDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

const LOCK_TABLE = '_schema_lock';
const LOCK_ID = 'reconcile';
const LOCK_TTL_MS = 600_000; // 10 minutes

/**
 * Ensure the lock table exists. Idempotent — safe to call every time.
 */
async function ensureLockTable(client: ClickHouseClient, database: string): Promise<void> {
  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${database}.${LOCK_TABLE} (
        lock_id     String,
        holder      String,
        locked_at   DateTime64(3) DEFAULT now64(3),
        expires_at  DateTime64(3)
      ) ENGINE = MergeTree()
      ORDER BY lock_id
      SETTINGS index_granularity = 1
    `,
  });
}

/**
 * Try to acquire the lock. Returns a SchemaLock handle.
 *
 * Strategy (same as MongoDB _migration_lock):
 * 1. Check if lock exists and is not expired
 * 2. If no lock or expired: DELETE old + INSERT new (atomic via single connection)
 * 3. If locked by someone else: return acquired=false
 */
export async function acquireSchemaLock(
  client: ClickHouseClient,
  holder: string,
): Promise<SchemaLock> {
  const database = resolveClickHouseDatabaseName();

  const noopLock: SchemaLock = {
    acquired: true,
    release: async () => {},
    extend: async () => {},
  };

  await ensureLockTable(client, database);

  const expiresAt = formatClickHouseDateTime(new Date(Date.now() + LOCK_TTL_MS));

  // Check if lock is held by someone else (not expired)
  const existingResult = await client.query({
    query: `
      SELECT holder, expires_at
      FROM ${database}.${LOCK_TABLE}
      WHERE lock_id = '${LOCK_ID}'
      ORDER BY locked_at DESC
      LIMIT 1
    `,
    format: 'JSONEachRow',
  });
  const existing = (await existingResult.json()) as Array<{
    holder: string;
    expires_at: string;
  }>;

  if (existing.length > 0) {
    const lockExpiry = new Date(existing[0].expires_at);
    const lockHolder = existing[0].holder;

    if (lockExpiry > new Date() && lockHolder !== holder) {
      // Lock is held by someone else and not expired
      console.log(`[Schema Lock] Lock held by: ${lockHolder} (expires: ${existing[0].expires_at})`);
      return { acquired: false, release: async () => {}, extend: async () => {} };
    }

    // Lock is expired or held by us — clean up old entries
    await client.command({
      query: `ALTER TABLE ${database}.${LOCK_TABLE} DELETE WHERE lock_id = '${LOCK_ID}'`,
    });
    // Wait for mutation to complete (lightweight delete)
    await waitForMutations(client, database);
  }

  // Insert new lock
  await client.insert({
    table: `${database}.${LOCK_TABLE}`,
    values: [{ lock_id: LOCK_ID, holder, expires_at: expiresAt }],
    format: 'JSONEachRow',
  });

  // Verify we got the lock (in case of race condition)
  const verifyResult = await client.query({
    query: `
      SELECT holder
      FROM ${database}.${LOCK_TABLE}
      WHERE lock_id = '${LOCK_ID}'
      ORDER BY locked_at DESC
      LIMIT 1
    `,
    format: 'JSONEachRow',
  });
  const verify = (await verifyResult.json()) as Array<{ holder: string }>;

  if (verify.length === 0 || verify[0].holder !== holder) {
    // Lost the race — another process acquired the lock
    const winner = verify[0]?.holder ?? 'unknown';
    console.log(`[Schema Lock] Lock acquired by another process: ${winner}`);
    return { acquired: false, release: async () => {}, extend: async () => {} };
  }

  console.log(`[Schema Lock] Lock acquired by: ${holder}`);

  return {
    acquired: true,
    release: async () => {
      try {
        await client.command({
          query: `ALTER TABLE ${database}.${LOCK_TABLE} DELETE WHERE lock_id = '${LOCK_ID}' AND holder = '${holder}'`,
        });
        console.log('[Schema Lock] Lock released');
      } catch (err) {
        console.error(
          `[Schema Lock] Failed to release lock: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    extend: async () => {
      const newExpiry = formatClickHouseDateTime(new Date(Date.now() + LOCK_TTL_MS));
      await client.command({
        query: `ALTER TABLE ${database}.${LOCK_TABLE} UPDATE expires_at = '${newExpiry}' WHERE lock_id = '${LOCK_ID}' AND holder = '${holder}'`,
      });
    },
  };
}

/**
 * Wait for pending mutations on the lock table to complete.
 * Mutations (ALTER DELETE) are async in ClickHouse — we need them
 * to finish before inserting the new lock.
 */
async function waitForMutations(
  client: ClickHouseClient,
  database: string,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await client.query({
      query: `
        SELECT count() AS cnt
        FROM system.mutations
        WHERE database = '${database}' AND table = '${LOCK_TABLE}' AND is_done = 0
      `,
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{ cnt: string }>;
    if (Number(rows[0]?.cnt ?? 0) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
