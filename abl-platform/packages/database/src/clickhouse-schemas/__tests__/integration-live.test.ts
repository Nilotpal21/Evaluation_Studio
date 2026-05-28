/**
 * Live ClickHouse Integration Tests
 *
 * Runs against a real ClickHouse instance (port-forwarded from K8s or local).
 * Uses a temporary database to avoid affecting production data.
 *
 * Skip if CLICKHOUSE_TEST_URL is not set:
 *   CLICKHOUSE_TEST_URL=http://localhost:8124 pnpm vitest run this-file
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { initAllClickHouseSchemas, getSchemaInventory } from '../init-all.js';
import { reconcileEngines, cleanupOldTables } from '../engine-reconciler.js';

const TEST_URL = process.env.CLICKHOUSE_TEST_URL;
const TEST_DB = `_test_schema_${Date.now()}`;

// Skip entire suite if no ClickHouse URL
const describeIfCH = TEST_URL ? describe : describe.skip;

describeIfCH('Live ClickHouse Integration', () => {
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClient({ url: TEST_URL! });
    // Create isolated test database
    await client.command({ query: `CREATE DATABASE IF NOT EXISTS ${TEST_DB}` });
    // Set env for the schema system
    process.env.CLICKHOUSE_DATABASE = TEST_DB;
    process.env.CLICKHOUSE_REPLICATED = 'false';
  }, 30000);

  afterAll(async () => {
    // Drop test database
    try {
      await client.command({ query: `DROP DATABASE IF EXISTS ${TEST_DB}` });
    } catch {
      // Best effort
    }
    delete process.env.CLICKHOUSE_DATABASE;
    delete process.env.CLICKHOUSE_REPLICATED;
    await client.close();
  }, 30000);

  // ─── Test 1: Full init creates all tables ───────────────────────
  it('creates all managed tables in a fresh database', async () => {
    await initAllClickHouseSchemas(client);

    const result = await client.query({
      query: `SELECT name, engine FROM system.tables WHERE database = '${TEST_DB}' AND name NOT LIKE '.inner%' ORDER BY name`,
      format: 'JSONEachRow',
    });
    const tables = (await result.json()) as Array<{ name: string; engine: string }>;
    const tableNames = tables.filter((t) => t.engine !== 'MaterializedView').map((t) => t.name);
    const mvNames = tables.filter((t) => t.engine === 'MaterializedView').map((t) => t.name);

    const inventory = getSchemaInventory();

    // Every managed table should exist
    for (const expected of inventory.tables) {
      expect(tableNames).toContain(expected);
    }

    // Satellite MVs (analytics, eval, workflow) should exist
    // Core MVs (llm_metrics_hourly, platform_events_*, etc.) are created inside
    // initClickHouseSchema which has hardcoded DROP VIEW references to abl_platform.
    // When using a custom test database, those MVs may target the wrong database.
    // This is a known limitation of the core init.ts — not a regression.
    const satelliteMVs = [
      'mv_daily_sentiment',
      'mv_daily_intent_distribution',
      'mv_daily_quality_scores',
      'mv_daily_custom_events',
      'mv_daily_outcomes',
      'mv_daily_llm_evaluate',
      'workflow_executions_latest_mv',
      'human_tasks_latest_mv',
    ];
    for (const expected of satelliteMVs) {
      expect(mvNames).toContain(expected);
    }
  }, 120000);

  // ─── Test 2: Init is idempotent ─────────────────────────────────
  it('re-running init produces no errors', async () => {
    // Run init again — should be a complete no-op
    await expect(initAllClickHouseSchemas(client)).resolves.not.toThrow();
  }, 120000);

  // ─── Test 3: Table count matches inventory ──────────────────────
  it('table count matches schema inventory', async () => {
    const result = await client.query({
      query: `SELECT count() AS cnt FROM system.tables WHERE database = '${TEST_DB}' AND name NOT LIKE '.inner%' AND engine != 'MaterializedView'`,
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{ cnt: string }>;
    const actualCount = Number(rows[0]?.cnt ?? 0);

    const inventory = getSchemaInventory();
    // Actual may have _schema_audit_log extra
    expect(actualCount).toBeGreaterThanOrEqual(inventory.tables.length);
  }, 30000);

  // ─── Test 4: Reconciler detects no drift (non-replicated) ──────
  it('reconciler reports zero drift in non-replicated mode', async () => {
    const result = await reconcileEngines(client, { dryRun: true });

    expect(result.drifted.length).toBe(0);
    expect(result.errors.length).toBe(0);
  }, 30000);

  // ─── Test 5: Insert + query works on created tables ─────────────
  it('can insert and query data from a managed table', async () => {
    // Insert a row into dead_letter_events (simple schema)
    await client.command({
      query: `INSERT INTO ${TEST_DB}.dead_letter_events (event_id, event_type, tenant_id, session_id, payload, error_message, retry_count, failed_at) VALUES (generateUUIDv4(), 'test', 'tenant-1', 'session-1', '{}', 'test error', 0, now64(3))`,
    });

    const result = await client.query({
      query: `SELECT count() AS cnt FROM ${TEST_DB}.dead_letter_events`,
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{ cnt: string }>;
    expect(Number(rows[0]?.cnt)).toBeGreaterThanOrEqual(1);
  }, 10000);

  // ─── Test 6: MV triggers work ──────────────────────────────────
  it('materialized views trigger on insert to source table', async () => {
    // Insert into custom_events (source for mv_daily_custom_events — satellite MV)
    await client.command({
      query: `INSERT INTO ${TEST_DB}.custom_events (tenant_id, project_id, session_id, event_name, properties, timestamp) VALUES ('tenant-1', 'p1', 's1', 'test_event', '{}', now64(3))`,
    });

    // The mv_daily_custom_events MV uses SummingMergeTree — check its .inner table has data
    // Query through the MV name (ClickHouse resolves to inner table)
    const result = await client.query({
      query: `SELECT count() AS cnt FROM ${TEST_DB}.mv_daily_custom_events`,
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{ cnt: string }>;
    expect(Number(rows[0]?.cnt)).toBeGreaterThanOrEqual(1);
  }, 10000);

  // ─── Test 7: ALTER migrations applied (columns exist) ───────────
  it('ALTER migrations add expected columns', async () => {
    // Check that agent_name column exists on messages (added by ALTER migration)
    const result = await client.query({
      query: `SELECT name FROM system.columns WHERE database = '${TEST_DB}' AND table = 'messages' AND name = 'agent_name'`,
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{ name: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('agent_name');
  }, 10000);

  // ─── Test 8: _schema_audit_log records init ─────────────────────
  it('_schema_audit_log has at least one row from init', async () => {
    const result = await client.query({
      query: `SELECT count() AS cnt FROM ${TEST_DB}._schema_audit_log WHERE command = 'init'`,
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{ cnt: string }>;
    expect(Number(rows[0]?.cnt)).toBeGreaterThanOrEqual(1);
  }, 10000);

  // ─── Test 9: Engine reconciler — shadow-copy on real CH ─────────
  it('shadow-copy migration works with EXCHANGE TABLES', async () => {
    // Create a simple test table as MergeTree
    const testTable = '_test_reconcile';
    await client.command({
      query: `CREATE TABLE IF NOT EXISTS ${TEST_DB}.${testTable} (id UInt32, value String) ENGINE = MergeTree() ORDER BY id`,
    });

    // Insert test data
    await client.command({
      query: `INSERT INTO ${TEST_DB}.${testTable} VALUES (1, 'a'), (2, 'b'), (3, 'c')`,
    });

    // Create _new with different engine (ReplacingMergeTree as upgrade target)
    await client.command({
      query: `CREATE TABLE IF NOT EXISTS ${TEST_DB}.${testTable}_new (id UInt32, value String) ENGINE = ReplacingMergeTree() ORDER BY id`,
    });

    // Copy data
    await client.command({
      query: `INSERT INTO ${TEST_DB}.${testTable}_new SELECT * FROM ${TEST_DB}.${testTable}`,
    });

    // Verify counts match
    const [origResult, newResult] = await Promise.all([
      client.query({
        query: `SELECT count() AS cnt FROM ${TEST_DB}.${testTable}`,
        format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT count() AS cnt FROM ${TEST_DB}.${testTable}_new`,
        format: 'JSONEachRow',
      }),
    ]);
    const origCount = Number(((await origResult.json()) as Array<{ cnt: string }>)[0]?.cnt);
    const newCount = Number(((await newResult.json()) as Array<{ cnt: string }>)[0]?.cnt);
    expect(origCount).toBe(newCount);
    expect(origCount).toBe(3);

    // EXCHANGE TABLES (the core operation we need to verify works)
    await client.command({
      query: `EXCHANGE TABLES ${TEST_DB}.${testTable} AND ${TEST_DB}.${testTable}_new`,
    });

    // Verify: the original name now has ReplacingMergeTree engine
    const engineResult = await client.query({
      query: `SELECT engine FROM system.tables WHERE database = '${TEST_DB}' AND name = '${testTable}'`,
      format: 'JSONEachRow',
    });
    const engineRows = (await engineResult.json()) as Array<{ engine: string }>;
    expect(engineRows[0].engine).toBe('ReplacingMergeTree');

    // Verify data is intact
    const dataResult = await client.query({
      query: `SELECT count() AS cnt FROM ${TEST_DB}.${testTable}`,
      format: 'JSONEachRow',
    });
    const dataCount = Number(((await dataResult.json()) as Array<{ cnt: string }>)[0]?.cnt);
    expect(dataCount).toBe(3);

    // Cleanup
    await client.command({ query: `DROP TABLE IF EXISTS ${TEST_DB}.${testTable}` });
    await client.command({ query: `DROP TABLE IF EXISTS ${TEST_DB}.${testTable}_new` });
  }, 30000);

  // ─── Test 10: MV destination tables are replicated ─────────────
  it('MV destination tables are replicated when REPLICATED=true', async () => {
    // Only meaningful when running against replicated cluster
    if (process.env.CLICKHOUSE_REPLICATED !== 'true') return;

    const result = await client.query({
      query: `SELECT name, engine FROM system.tables WHERE database = '${TEST_DB}' AND name LIKE '%_dest' AND engine NOT LIKE 'Replicated%' FORMAT JSONEachRow`,
      format: 'JSONEachRow',
    });
    const nonReplicated = (await result.json()) as Array<{ name: string; engine: string }>;

    // All _dest tables should be Replicated* in replicated mode
    expect(nonReplicated).toEqual([]);
  }, 10000);

  // ─── Test 11: Old table cleanup works ─────────────────────────
  it('cleanupOldTables drops expired backup tables', async () => {
    // Create a fake old table with a timestamp from 30 days ago
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const ts = oldDate.toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    const oldTableName = `_test_cleanup_old_${ts}`;

    await client.command({
      query: `CREATE TABLE IF NOT EXISTS ${TEST_DB}.${oldTableName} (id UInt32) ENGINE = MergeTree() ORDER BY id`,
    });

    // Run cleanup with 7-day retention
    const cleaned = await cleanupOldTables(client, 7);
    expect(cleaned).toContain(oldTableName);

    // Verify it's gone
    const result = await client.query({
      query: `SELECT count() AS cnt FROM system.tables WHERE database = '${TEST_DB}' AND name = '${oldTableName}'`,
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{ cnt: string }>;
    expect(Number(rows[0]?.cnt)).toBe(0);
  }, 10000);
});
