/**
 * Failure-scenario integration tests for the ClickHouse centralized schema system.
 *
 * Uses a mock ClickHouse client to simulate real failure modes:
 * - Keeper unreachable
 * - Wrong database engine
 * - Invalid cluster name
 * - Engine reconciler: row count mismatch, size guard, downgrade protection,
 *   stale _new cleanup, dry run
 * - ensureClickHouseSchemaReady fallback
 * - Old table cleanup retention
 * - SQL identifier validation
 * - CLI CLICKHOUSE_URL guard
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock ClickHouse Client
// ---------------------------------------------------------------------------

interface MockQueryResult {
  json: () => Promise<unknown[]>;
}

function createMockClient(options?: {
  commandErrors?: Map<string, Error>;
  queryResults?: Map<string, unknown[]>;
  commandLog?: string[];
}) {
  const commandLog = options?.commandLog ?? [];
  const commandErrors = options?.commandErrors ?? new Map();
  const queryResults = options?.queryResults ?? new Map();

  return {
    command: vi.fn(async ({ query }: { query: string }) => {
      commandLog.push(query.replace(/\s+/g, ' ').trim().slice(0, 200));
      for (const [pattern, error] of commandErrors) {
        if (query.includes(pattern)) throw error;
      }
    }),
    query: vi.fn(async ({ query }: { query: string }): Promise<MockQueryResult> => {
      for (const [pattern, result] of queryResults) {
        if (query.includes(pattern)) {
          return { json: async () => result };
        }
      }
      return { json: async () => [] };
    }),
    insert: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Env var helpers
// ---------------------------------------------------------------------------

const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string>) {
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Clear saved so next test starts fresh
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
}

// ---------------------------------------------------------------------------
// Module reset helper — env vars are read at import time so we need fresh
// modules for each test that changes env vars.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  restoreEnv();
});

// =========================================================================
// 1. Keeper Unreachable When REPLICATED=true
// =========================================================================

describe('Keeper unreachable', () => {
  it('aborts init when REPLICATED=true and Keeper is down', async () => {
    setEnv({
      CLICKHOUSE_REPLICATED: 'true',
    });

    const client = createMockClient();

    // Keeper probe throws
    client.query.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('system.zookeeper')) {
        throw new Error('Connection refused to Keeper');
      }
      return { json: async () => [] };
    });

    const { initAllClickHouseSchemas } = await import('../init-all.js');
    await expect(initAllClickHouseSchemas(client as any)).rejects.toThrow('Keeper');
  });
});

// =========================================================================
// 2. Wrong Database Engine
// =========================================================================

describe('database engine validation', () => {
  it('aborts when database engine is Ordinary', async () => {
    setEnv({
      CLICKHOUSE_REPLICATED: 'true',
    });

    const client = createMockClient();

    client.query.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('system.zookeeper')) {
        // Keeper OK
        return { json: async () => [{ 'count()': 1 }] };
      }
      if (query.includes('system.databases')) {
        return { json: async () => [{ engine: 'Ordinary' }] };
      }
      if (query.includes('version()')) {
        return { json: async () => [{ 'version()': '24.8.6.70' }] };
      }
      return { json: async () => [] };
    });

    const { initAllClickHouseSchemas } = await import('../init-all.js');
    await expect(initAllClickHouseSchemas(client as any)).rejects.toThrow('Ordinary');
  });
});

// =========================================================================
// 3. Cluster Auto-Detection
// =========================================================================

describe('cluster auto-detection', () => {
  it('proceeds without cluster when system.clusters returns no rows', async () => {
    setEnv({
      CLICKHOUSE_REPLICATED: 'true',
    });

    const commandLog: string[] = [];
    const client = createMockClient({ commandLog });

    client.query.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('system.zookeeper')) {
        return { json: async () => [{ 'count()': 1 }] };
      }
      if (query.includes('system.databases')) {
        return { json: async () => [{ engine: 'Atomic' }] };
      }
      if (query.includes('version()')) {
        return { json: async () => [{ 'version()': '24.8.6.70' }] };
      }
      if (query.includes('system.clusters')) {
        // No cluster found
        return { json: async () => [] };
      }
      return { json: async () => [] };
    });

    const { initAllClickHouseSchemas } = await import('../init-all.js');
    // Should not throw — proceeds without cluster
    await initAllClickHouseSchemas(client as any);
    // Should have created a database without ON CLUSTER
    expect(commandLog.some((q) => q.includes('CREATE DATABASE'))).toBe(true);
    expect(commandLog.some((q) => q.includes('ON CLUSTER'))).toBe(false);
  });
});

// =========================================================================
// 4. Engine Reconciler — Row Count Mismatch (Active Writes)
// =========================================================================

describe('engine reconciler — row count mismatch', () => {
  it('reports error and drops _new table when counts differ', async () => {
    setEnv({
      CLICKHOUSE_REPLICATED: 'true',
    });

    // We need to mock redis-lock to return a noop lock (no REDIS_URL set)
    // Since REDIS_URL is not set and ENGINE_MIGRATION is not 'execute',
    // acquireSchemaLock will return a noop lock — that's fine.

    const commandLog: string[] = [];
    const client = createMockClient({ commandLog });

    const { collectDesiredTables } = await import('../engine-reconciler.js');
    const desiredTables = collectDesiredTables();
    // Pick a table that has DDL we can use
    const sampleTable = desiredTables.find((t) => t.name === 'messages') ?? desiredTables[0];

    let countCallIndex = 0;
    client.query.mockImplementation(async ({ query }: { query: string }) => {
      // Preflight: Keeper OK
      if (query.includes('system.zookeeper')) {
        return { json: async () => [{ 'count()': 1 }] };
      }
      // Preflight: DB engine OK
      if (query.includes('system.databases')) {
        return { json: async () => [{ engine: 'Atomic' }] };
      }
      // Preflight: version OK
      if (query.includes('version()')) {
        return { json: async () => [{ 'version()': '24.8.6.70' }] };
      }
      // Return the sample table with non-replicated engine so drift is detected
      if (query.includes('system.tables') && query.includes('engine')) {
        return {
          json: async () => [{ name: sampleTable.name, engine: 'MergeTree' }],
        };
      }
      // Table size — small enough to proceed
      if (query.includes('total_bytes')) {
        return { json: async () => [{ total_bytes: '1000' }] };
      }
      // Row counts — simulate mismatch
      if (query.includes('count()') && !query.includes('system.')) {
        countCallIndex++;
        if (countCallIndex === 1) return { json: async () => [{ cnt: '100' }] };
        if (countCallIndex === 2) return { json: async () => [{ cnt: '95' }] };
        return { json: async () => [{ cnt: '100' }] };
      }
      return { json: async () => [] };
    });

    const { reconcileEngines } = await import('../engine-reconciler.js');
    const result = await reconcileEngines(client as any, { dryRun: false });

    // Should have error about row count mismatch
    expect(result.errors.some((e) => e.error.includes('Row count mismatch'))).toBe(true);
    // Should have dropped _new table
    expect(commandLog.some((q) => q.includes('DROP') && q.includes('_new'))).toBe(true);
    // Should NOT have EXCHANGE TABLES
    expect(commandLog.some((q) => q.includes('EXCHANGE'))).toBe(false);
  });
});

// =========================================================================
// 5. Engine Reconciler — Table Too Large (>10 GiB)
// =========================================================================

describe('engine reconciler — size guard', () => {
  it('skips tables larger than maxTableSizeBytes', async () => {
    setEnv({
      CLICKHOUSE_REPLICATED: 'true',
    });

    const client = createMockClient();

    const { collectDesiredTables } = await import('../engine-reconciler.js');
    const desiredTables = collectDesiredTables();
    const sampleTable = desiredTables[0];

    client.query.mockImplementation(async ({ query }: { query: string }) => {
      // Preflight checks
      if (query.includes('system.zookeeper')) {
        return { json: async () => [{ 'count()': 1 }] };
      }
      if (query.includes('system.databases')) {
        return { json: async () => [{ engine: 'Atomic' }] };
      }
      if (query.includes('version()')) {
        return { json: async () => [{ 'version()': '24.8.6.70' }] };
      }
      // Table with non-replicated engine
      if (query.includes('system.tables') && query.includes('engine')) {
        return {
          json: async () => [{ name: sampleTable.name, engine: 'MergeTree' }],
        };
      }
      // Table is very large — 20 GiB
      if (query.includes('total_bytes')) {
        return { json: async () => [{ total_bytes: '20000000000' }] };
      }
      return { json: async () => [] };
    });

    const { reconcileEngines } = await import('../engine-reconciler.js');
    const result = await reconcileEngines(client as any, { dryRun: false });

    expect(result.skipped.some((s) => s.table === sampleTable.name)).toBe(true);
    expect(result.migrated.length).toBe(0);
  });
});

// =========================================================================
// 6. Engine Reconciler — Downgrade Protection
// =========================================================================

describe('engine reconciler — downgrade protection', () => {
  it('never downgrades from ReplicatedMergeTree to MergeTree', async () => {
    setEnv({
      CLICKHOUSE_REPLICATED: 'false',
    });

    const commandLog: string[] = [];
    const client = createMockClient({ commandLog });

    const { collectDesiredTables } = await import('../engine-reconciler.js');
    const desiredTables = collectDesiredTables();
    const sampleTable = desiredTables[0];

    client.query.mockImplementation(async ({ query }: { query: string }) => {
      // Drift detection: table already has Replicated engine
      if (query.includes('system.tables') && query.includes('engine')) {
        return {
          json: async () => [{ name: sampleTable.name, engine: 'ReplicatedMergeTree' }],
        };
      }
      return { json: async () => [] };
    });

    const { reconcileEngines } = await import('../engine-reconciler.js');
    const result = await reconcileEngines(client as any);

    // Should NOT migrate (no downgrade)
    expect(result.migrated.length).toBe(0);
    // No DDL commands issued (no CREATE TABLE, no EXCHANGE)
    expect(commandLog.some((q) => q.includes('EXCHANGE'))).toBe(false);
    expect(commandLog.some((q) => q.includes('CREATE TABLE'))).toBe(false);
  });
});

// =========================================================================
// 7. Engine Reconciler — Stale _new Cleanup
// =========================================================================

describe('engine reconciler — stale _new cleanup', () => {
  it('drops stale _new table before migration', async () => {
    setEnv({
      CLICKHOUSE_REPLICATED: 'true',
    });

    const commandLog: string[] = [];
    const client = createMockClient({ commandLog });

    const { collectDesiredTables } = await import('../engine-reconciler.js');
    const desiredTables = collectDesiredTables();
    const sampleTable = desiredTables.find((t) => t.name === 'messages') ?? desiredTables[0];

    client.query.mockImplementation(async ({ query }: { query: string }) => {
      // Preflight
      if (query.includes('system.zookeeper')) {
        return { json: async () => [{ 'count()': 1 }] };
      }
      if (query.includes('system.databases')) {
        return { json: async () => [{ engine: 'Atomic' }] };
      }
      if (query.includes('version()')) {
        return { json: async () => [{ 'version()': '24.8.6.70' }] };
      }
      // Both the real table and a stale _new table exist
      if (query.includes('system.tables') && query.includes('engine')) {
        return {
          json: async () => [
            { name: sampleTable.name, engine: 'MergeTree' },
            { name: `${sampleTable.name}_new`, engine: 'MergeTree' },
          ],
        };
      }
      // Small table
      if (query.includes('total_bytes')) {
        return { json: async () => [{ total_bytes: '1000' }] };
      }
      // Row counts match (for successful migration)
      if (query.includes('count()') && !query.includes('system.')) {
        return { json: async () => [{ cnt: '100' }] };
      }
      return { json: async () => [] };
    });

    const { reconcileEngines } = await import('../engine-reconciler.js');
    const result = await reconcileEngines(client as any, { dryRun: false });

    // Should have issued a DROP for _new table (stale cleanup)
    const dropNewIdx = commandLog.findIndex(
      (q) => q.includes('DROP') && q.includes(`${sampleTable.name}_new`),
    );
    expect(dropNewIdx).toBeGreaterThanOrEqual(0);

    // If a CREATE TABLE for _new was issued, the DROP should come first
    const createNewIdx = commandLog.findIndex(
      (q) => q.includes('CREATE TABLE') && q.includes(`${sampleTable.name}_new`),
    );
    if (createNewIdx >= 0) {
      expect(dropNewIdx).toBeLessThan(createNewIdx);
    }
  });
});

// =========================================================================
// 8. Dry Run — No Mutations
// =========================================================================

describe('engine reconciler — dry run', () => {
  it('detects drift but makes no DDL changes in dry-run mode', async () => {
    setEnv({
      CLICKHOUSE_REPLICATED: 'true',
    });

    const commandLog: string[] = [];
    const client = createMockClient({ commandLog });

    const { collectDesiredTables } = await import('../engine-reconciler.js');
    const desiredTables = collectDesiredTables();
    const sampleTable = desiredTables[0];

    client.query.mockImplementation(async ({ query }: { query: string }) => {
      // Preflight
      if (query.includes('system.zookeeper')) {
        return { json: async () => [{ 'count()': 1 }] };
      }
      if (query.includes('system.databases')) {
        return { json: async () => [{ engine: 'Atomic' }] };
      }
      if (query.includes('version()')) {
        return { json: async () => [{ 'version()': '24.8.6.70' }] };
      }
      // Table with drift
      if (query.includes('system.tables') && query.includes('engine')) {
        return {
          json: async () => [{ name: sampleTable.name, engine: 'MergeTree' }],
        };
      }
      return { json: async () => [] };
    });

    const { reconcileEngines } = await import('../engine-reconciler.js');
    const result = await reconcileEngines(client as any, { dryRun: true });

    expect(result.drifted.length).toBeGreaterThan(0);
    expect(result.migrated.length).toBe(0);
    // No DDL commands should have been issued (queries for detection are OK)
    expect(commandLog.length).toBe(0);
  });
});

// =========================================================================
// 9. ensureClickHouseSchemaReady — Fallback Trigger
// =========================================================================

describe('ensureClickHouseSchemaReady', () => {
  it('calls init when probe table does not exist', async () => {
    setEnv({
      CLICKHOUSE_REPLICATED: 'false',
    });

    const commandLog: string[] = [];
    const client = createMockClient({ commandLog });

    // Probe query fails — table doesn't exist
    client.query.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('platform_events') && query.includes('LIMIT 0')) {
        throw new Error('Unknown table');
      }
      // All other queries succeed (for init path)
      if (query.includes('system.tables')) {
        return { json: async () => [] };
      }
      return { json: async () => [] };
    });

    const { ensureClickHouseSchemaReady } = await import('../init-all.js');
    await ensureClickHouseSchemaReady(client as any);

    // Should have called init (CREATE DATABASE at minimum)
    expect(commandLog.some((q) => q.includes('CREATE DATABASE'))).toBe(true);
  });

  it('skips init when probe table exists', async () => {
    setEnv({
      CLICKHOUSE_REPLICATED: 'false',
    });

    const commandLog: string[] = [];
    const client = createMockClient({ commandLog });

    // Probe query succeeds — tables exist
    client.query.mockImplementation(async () => {
      return { json: async () => [{ '1': 1 }] };
    });

    const { ensureClickHouseSchemaReady } = await import('../init-all.js');
    await ensureClickHouseSchemaReady(client as any);

    // Should NOT have called init
    expect(commandLog.some((q) => q.includes('CREATE DATABASE'))).toBe(false);
  });
});

// =========================================================================
// 10. Old Table Cleanup — Retention
// =========================================================================

describe('cleanupOldTables', () => {
  it('drops tables older than retention period', async () => {
    const commandLog: string[] = [];
    const client = createMockClient({ commandLog });

    const oldDate = '20260501T000000'; // Old enough to clean (>7 days before 2026-05-19)
    // Build a recent date in the format used by engine-reconciler
    const now = new Date();
    const recentDate =
      now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') +
      'T' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');

    client.query.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('_old_')) {
        return {
          json: async () => [
            { name: `messages_old_${oldDate}` },
            { name: `audit_events_old_${recentDate}` },
          ],
        };
      }
      return { json: async () => [] };
    });

    const { cleanupOldTables } = await import('../engine-reconciler.js');
    const cleaned = await cleanupOldTables(client as any, 7);

    // Should drop old one, keep recent one
    expect(cleaned).toContain(`messages_old_${oldDate}`);
    expect(cleaned).not.toContain(`audit_events_old_${recentDate}`);
  });

  it('returns empty array when no old tables exist', async () => {
    const client = createMockClient();
    client.query.mockImplementation(async () => {
      return { json: async () => [] };
    });

    const { cleanupOldTables } = await import('../engine-reconciler.js');
    const cleaned = await cleanupOldTables(client as any, 7);

    expect(cleaned).toEqual([]);
  });

  it('skips tables with unparseable timestamp suffixes', async () => {
    const commandLog: string[] = [];
    const client = createMockClient({ commandLog });

    client.query.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('_old_')) {
        return {
          json: async () => [
            { name: 'messages_old_invalidtimestamp' },
            { name: 'messages_old_notadate' },
          ],
        };
      }
      return { json: async () => [] };
    });

    const { cleanupOldTables } = await import('../engine-reconciler.js');
    const cleaned = await cleanupOldTables(client as any, 7);

    expect(cleaned).toEqual([]);
    // No DROP commands issued
    expect(commandLog.some((q) => q.includes('DROP'))).toBe(false);
  });
});

// =========================================================================
// 11. SQL Identifier Validation
// =========================================================================

describe('identifier validation', () => {
  it('rejects database names with special characters', async () => {
    const { assertValidIdentifier } = await import('../database.js');
    expect(() => assertValidIdentifier("my'db", 'database')).toThrow();
    expect(() => assertValidIdentifier('my;db', 'database')).toThrow();
    expect(() => assertValidIdentifier('my db', 'database')).toThrow();
    expect(() => assertValidIdentifier('123db', 'database')).toThrow();
  });

  it('rejects empty string', async () => {
    const { assertValidIdentifier } = await import('../database.js');
    expect(() => assertValidIdentifier('', 'database')).toThrow();
  });

  it('rejects identifiers with SQL injection patterns', async () => {
    const { assertValidIdentifier } = await import('../database.js');
    expect(() => assertValidIdentifier('db; DROP TABLE users', 'database')).toThrow();
    expect(() => assertValidIdentifier("db' OR '1'='1", 'database')).toThrow();
    expect(() => assertValidIdentifier('db--comment', 'database')).toThrow();
  });

  it('accepts valid identifiers', async () => {
    const { assertValidIdentifier } = await import('../database.js');
    expect(() => assertValidIdentifier('abl_platform', 'database')).not.toThrow();
    expect(() => assertValidIdentifier('default_cluster', 'cluster')).not.toThrow();
    expect(() => assertValidIdentifier('_private', 'table')).not.toThrow();
    expect(() => assertValidIdentifier('A_Z_0_9', 'column')).not.toThrow();
  });
});

// =========================================================================
// 12. CLI — getClickHouseUrl guard
// =========================================================================

describe('CLI — missing CLICKHOUSE_URL', () => {
  it('CLI source uses throw new Error for missing CLICKHOUSE_URL (not process.exit)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const cliPath = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'cli.ts',
    );
    const content = fs.readFileSync(cliPath, 'utf-8');
    // Verify getClickHouseUrl throws an Error, not process.exit
    expect(content).toContain("throw new Error('CLICKHOUSE_URL is not set')");
  });
});

// =========================================================================
// Column Drift Detection
// =========================================================================

describe('column drift detection', () => {
  it('detects missing columns', async () => {
    setEnv({
      CLICKHOUSE_REPLICATED: 'false',
    });

    const client = createMockClient();

    const { detectColumnDrift } = await import('../engine-reconciler.js');
    const { resolveDDLTransformOptions } = await import('../ddl-transform.js');
    const options = resolveDDLTransformOptions();

    // Use dead_letter_events — simple table, no ALTER migrations
    // Return only first 3 columns, omitting the rest
    const partialColumns = ['event_id', 'event_type', 'tenant_id'];

    client.query.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('system.columns') && query.includes('dead_letter_events')) {
        return {
          json: async () => partialColumns.map((name: string) => ({ name })),
        };
      }
      if (query.includes('system.columns')) {
        return { json: async () => [] }; // No columns for other tables
      }
      return { json: async () => [] };
    });

    const drifts = await detectColumnDrift(client as any, options);
    const tableDrift = drifts.find((d: any) => d.table === 'dead_letter_events');
    expect(tableDrift).toBeDefined();
    expect(tableDrift!.missingColumns.length).toBeGreaterThan(0);
    expect(tableDrift!.missingColumns).toContain('session_id');
    expect(tableDrift!.missingColumns).toContain('payload');
  });

  it('detects extra columns', async () => {
    setEnv({
      CLICKHOUSE_REPLICATED: 'false',
    });

    const client = createMockClient();

    const { detectColumnDrift } = await import('../engine-reconciler.js');
    const { resolveDDLTransformOptions } = await import('../ddl-transform.js');
    const options = resolveDDLTransformOptions();

    // Return all expected dead_letter_events columns plus two extra
    const allColumns = [
      'event_id',
      'event_type',
      'tenant_id',
      'session_id',
      'payload',
      'error_message',
      'retry_count',
      'failed_at',
      'replayed',
      'extra_col_a',
      'extra_col_b',
    ];

    client.query.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('system.columns') && query.includes('dead_letter_events')) {
        return {
          json: async () => allColumns.map((name: string) => ({ name })),
        };
      }
      if (query.includes('system.columns')) {
        return { json: async () => [] };
      }
      return { json: async () => [] };
    });

    const drifts = await detectColumnDrift(client as any, options);
    const tableDrift = drifts.find((d: any) => d.table === 'dead_letter_events');
    expect(tableDrift).toBeDefined();
    expect(tableDrift!.missingColumns).toEqual([]);
    expect(tableDrift!.extraColumns).toEqual(['extra_col_a', 'extra_col_b']);
  });

  it('returns empty when columns match', async () => {
    setEnv({
      CLICKHOUSE_REPLICATED: 'false',
    });

    const client = createMockClient();

    const { detectColumnDrift } = await import('../engine-reconciler.js');
    const { resolveDDLTransformOptions } = await import('../ddl-transform.js');
    const options = resolveDDLTransformOptions();

    // Return exact columns for dead_letter_events (no ALTER migrations for this table)
    const exactColumns = [
      'event_id',
      'event_type',
      'tenant_id',
      'session_id',
      'payload',
      'error_message',
      'retry_count',
      'failed_at',
      'replayed',
    ];

    client.query.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('system.columns') && query.includes('dead_letter_events')) {
        return {
          json: async () => exactColumns.map((name: string) => ({ name })),
        };
      }
      if (query.includes('system.columns')) {
        return { json: async () => [] };
      }
      return { json: async () => [] };
    });

    const drifts = await detectColumnDrift(client as any, options);
    const tableDrift = drifts.find((d: any) => d.table === 'dead_letter_events');
    expect(tableDrift).toBeUndefined();
  });
});

// =========================================================================
// 13. Preflight — ClickHouse version too old
// =========================================================================

describe('preflight — version check', () => {
  it('rejects ClickHouse version < 21.8', async () => {
    const { runPreflightChecks, assertPreflightPassed } = await import('../preflight.js');

    const client = createMockClient();
    client.query.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('system.zookeeper')) {
        return { json: async () => [{ 'count()': 1 }] };
      }
      if (query.includes('system.databases')) {
        return { json: async () => [{ engine: 'Atomic' }] };
      }
      if (query.includes('version()')) {
        return { json: async () => [{ 'version()': '21.3.15.4' }] };
      }
      return { json: async () => [] };
    });

    const result = await runPreflightChecks(client as any, 'abl_platform');
    expect(() => assertPreflightPassed(result, 'abl_platform')).toThrow('21.3.15.4');
  });

  it('accepts ClickHouse version >= 21.8', async () => {
    const { runPreflightChecks, assertPreflightPassed } = await import('../preflight.js');

    const client = createMockClient();
    client.query.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('system.zookeeper')) {
        return { json: async () => [{ 'count()': 1 }] };
      }
      if (query.includes('system.databases')) {
        return { json: async () => [{ engine: 'Atomic' }] };
      }
      if (query.includes('version()')) {
        return { json: async () => [{ 'version()': '24.8.6.70' }] };
      }
      return { json: async () => [] };
    });

    const result = await runPreflightChecks(client as any, 'abl_platform');
    expect(() => assertPreflightPassed(result, 'abl_platform')).not.toThrow();
  });
});

// =========================================================================
// 14. Database name resolution
// =========================================================================

describe('resolveClickHouseDatabaseName', () => {
  it('uses CLICKHOUSE_DATABASE env var when set', async () => {
    setEnv({ CLICKHOUSE_DATABASE: 'custom_db' });
    const { resolveClickHouseDatabaseName } = await import('../database.js');
    expect(resolveClickHouseDatabaseName()).toBe('custom_db');
  });

  it('falls back to default when env var is not set', async () => {
    // Ensure CLICKHOUSE_DATABASE is unset
    delete process.env.CLICKHOUSE_DATABASE;
    const { resolveClickHouseDatabaseName } = await import('../database.js');
    expect(resolveClickHouseDatabaseName()).toBe('abl_platform');
  });

  it('rejects invalid database names from env', async () => {
    const { resolveClickHouseDatabaseName } = await import('../database.js');
    expect(() => resolveClickHouseDatabaseName('invalid name')).toThrow();
    expect(() => resolveClickHouseDatabaseName('123bad')).toThrow();
  });
});
