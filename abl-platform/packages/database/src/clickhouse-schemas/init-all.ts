/**
 * Unified ClickHouse Schema Initialization
 *
 * Single entry point for ALL ClickHouse DDL across core, analytics, eval,
 * experiment, and workflow table families.
 *
 * Usage:
 *   import { initAllClickHouseSchemas } from '@agent-platform/database/clickhouse-schemas/init-all';
 *   await initAllClickHouseSchemas(client);
 */

import { createHash } from 'node:crypto';

import type { ClickHouseClient } from '@clickhouse/client';

import { detectClusterName, applyOnCluster } from './cluster.js';
import { resolveClickHouseDatabaseName } from './database.js';
import { resolveDDLTransformOptions, transformDDL } from './ddl-transform.js';
import { initClickHouseSchema, MATERIALIZED_VIEWS, TABLES } from './init.js';
import { assertPreflightPassed, runPreflightChecks } from './preflight.js';
import {
  ANALYTICS_MIGRATIONS,
  ANALYTICS_MV_DDL,
  ANALYTICS_MVS,
  ANALYTICS_SKIP_INDICES,
  ANALYTICS_TABLE_DDL,
  ANALYTICS_TABLES,
} from './tables/analytics.js';
import {
  EVAL_MV_DDL,
  EVAL_MVS,
  EVAL_TABLE_ALTER_DDL,
  EVAL_TABLE_DDL,
  EVAL_TABLES,
} from './tables/eval.js';
import { EXPERIMENT_TABLE_DDL, EXPERIMENT_TABLES } from './tables/experiment.js';
import {
  HUMAN_TASK_EVENTS_TABLE_DDL,
  HUMAN_TASKS_LATEST_MV_DDL,
  HUMAN_TASKS_LATEST_TABLE_DDL,
  WORKFLOW_EXECUTIONS_LATEST_MV_DDL,
  WORKFLOW_EXECUTIONS_LATEST_TABLE_DDL,
  WORKFLOW_EXECUTION_EVENTS_TABLE_DDL,
  WORKFLOW_MVS,
  WORKFLOW_TABLES,
} from './tables/workflow.js';

export interface SchemaInventory {
  tables: string[];
  materializedViews: string[];
}

export interface InitResult {
  durationMs: number;
  tablesCreated: number;
  viewsCreated: number;
  viewsSkipped: number;
  viewsRecreated: number;
  errors: string[];
}

/**
 * Returns the full inventory of managed ClickHouse table and MV names,
 * derived from DDL module exports (not hand-maintained).
 */
export function getSchemaInventory(): SchemaInventory {
  const tables = [
    ...TABLES.map((t) => t.name),
    ...ANALYTICS_TABLES,
    ...EVAL_TABLES,
    ...EXPERIMENT_TABLES,
    ...WORKFLOW_TABLES,
  ];

  const materializedViews = [
    ...MATERIALIZED_VIEWS.map((v) => v.name),
    ...ANALYTICS_MVS,
    ...EVAL_MVS,
    ...WORKFLOW_MVS,
  ];

  return { tables, materializedViews };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getStatementPreview(query: string): string {
  return query.replace(/\s+/g, ' ').trim().slice(0, 240);
}

// ---------------------------------------------------------------------------
// Materialized view helper
// ---------------------------------------------------------------------------

/**
 * Extract the MV name from a CREATE MATERIALIZED VIEW DDL statement.
 */
function extractMVName(ddl: string): string | undefined {
  const match = ddl.match(
    /CREATE\s+MATERIALIZED\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?(\w+)/i,
  );
  return match ? match[1] : undefined;
}

/**
 * Extract the destination table name from a TO <database>.<table> clause.
 */
function extractMVDestTable(ddl: string): string | undefined {
  const match = ddl.match(/\bTO\s+(?:\w+\.)?(\w+)/i);
  return match ? match[1] : undefined;
}

/**
 * Ensures a materialized view is created/updated with DDL hash tracking.
 *
 * Behavior:
 * - If the MV does not exist: CREATE it (always allowed).
 * - If the MV exists and DDL hash matches: skip (unchanged).
 * - If the MV exists and DDL hash differs:
 *   - If allowRecreate=true: DROP + CREATE.
 *   - Otherwise: log warning and skip.
 */
async function ensureMaterializedView(
  client: ClickHouseClient,
  database: string,
  name: string,
  ddl: string,
  options: { allowRecreate: boolean },
): Promise<'created' | 'skipped_unchanged' | 'skipped_no_flag' | 'recreated'> {
  const currentHash = createHash('sha256').update(ddl).digest('hex').slice(0, 16);
  const destTable = extractMVDestTable(ddl);

  // Check if MV already exists
  const existsResult = await client.query({
    query: `SELECT name FROM system.tables WHERE database = '${database}' AND name = '${name}' AND engine = 'MaterializedView'`,
    format: 'JSONEachRow',
  });
  const rows = (await existsResult.json()) as Array<{ name: string }>;

  if (rows.length > 0) {
    // MV exists — check stored hash on the destination table (not the MV itself)
    // MVs without a TO clause use inline .inner_id.* tables — no hash tracking possible.
    // For those, treat as always-unchanged (CREATE MATERIALIZED VIEW IF NOT EXISTS is idempotent).
    if (!destTable) {
      return 'skipped_unchanged';
    }

    const destCommentResult = await client.query({
      query: `SELECT comment FROM system.tables WHERE database = '${database}' AND name = '${destTable}'`,
      format: 'JSONEachRow',
    });
    const destRows = (await destCommentResult.json()) as Array<{ comment: string }>;
    const storedHash = destRows[0]?.comment?.match(/ddl_hash:(\w+)/)?.[1] ?? '';

    if (storedHash === currentHash) {
      return 'skipped_unchanged';
    }

    // No hash stored yet (pre-existing MV from before hash tracking) — store hash now
    if (!storedHash) {
      try {
        await client.command({
          query: `ALTER TABLE ${database}.${destTable} MODIFY COMMENT 'ddl_hash:${currentHash}'`,
        });
      } catch {
        // Best-effort
      }
      return 'skipped_unchanged';
    }

    // DDL changed
    if (!options.allowRecreate) {
      console.warn(
        `[CH Schema] MV '${name}' DDL changed but CLICKHOUSE_ALLOW_MV_RECREATE is not set. Skipping.`,
      );
      return 'skipped_no_flag';
    }

    // DROP + CREATE
    await client.command({ query: `DROP VIEW IF EXISTS ${database}.${name}` });
    await client.command({ query: ddl });

    // Store hash in destination table comment (if there's a TO clause)
    if (destTable) {
      try {
        await client.command({
          query: `ALTER TABLE ${database}.${destTable} MODIFY COMMENT 'ddl_hash:${currentHash}'`,
        });
      } catch {
        // Best-effort: some MVs may not have a dest table we can comment on
      }
    }

    return 'recreated';
  }

  // MV doesn't exist — create it
  await client.command({ query: ddl });

  // Store hash in destination table comment
  if (destTable) {
    try {
      await client.command({
        query: `ALTER TABLE ${database}.${destTable} MODIFY COMMENT 'ddl_hash:${currentHash}'`,
      });
    } catch {
      // Best-effort
    }
  }

  return 'created';
}

// ---------------------------------------------------------------------------
// Schema audit log
// ---------------------------------------------------------------------------

async function createAuditLogTable(client: ClickHouseClient, database: string): Promise<void> {
  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${database}._schema_audit_log (
        version      String DEFAULT '1.0',
        command      LowCardinality(String),
        timestamp    DateTime64(3) DEFAULT now64(3),
        duration_ms  UInt32,
        summary      String CODEC(ZSTD(3)),
        host         String DEFAULT hostName()
      ) ENGINE = MergeTree()
      ORDER BY timestamp
      TTL toDateTime(timestamp) + INTERVAL 365 DAY DELETE
      SETTINGS index_granularity = 8192
    `,
  });
}

async function insertAuditLogRow(
  client: ClickHouseClient,
  database: string,
  command: string,
  durationMs: number,
  summary: Record<string, unknown>,
): Promise<void> {
  await client.insert({
    table: `${database}._schema_audit_log`,
    values: [{ command, duration_ms: durationMs, summary: JSON.stringify(summary) }],
    format: 'JSONEachRow',
  });
}

// ---------------------------------------------------------------------------
// Main init
// ---------------------------------------------------------------------------

/**
 * Single entry point for ALL ClickHouse DDL initialization.
 *
 * Execution order:
 * 0. Preflight checks (Keeper, DB engine, version) when replicated
 * 1. Core tables + ALTERs + core MVs (via initClickHouseSchema)
 * 2. Analytics tables
 * 3. Analytics skip indices
 * 4. Analytics migrations
 * 5. Analytics MVs
 * 6. Eval tables
 * 7. Eval ALTER DDL
 * 8. Eval MVs
 * 9. Experiment tables
 * 10. Workflow tables (event streams -> projections -> MVs)
 * 11. Audit log
 */
/**
 * Lightweight boot-time safety check. Verifies ClickHouse tables exist.
 * If tables are missing (PreSync hook hasn't run), runs init as fallback.
 * This is a transitional safety net — remove after Helm hook is deployed.
 */
export async function ensureClickHouseSchemaReady(client: ClickHouseClient): Promise<void> {
  const database = resolveClickHouseDatabaseName();
  try {
    // Probe both a core table AND a satellite table to catch partial init
    // (e.g., core tables created but satellite tables missing)
    await client.query({
      query: `SELECT 1 FROM ${database}.platform_events LIMIT 0 SETTINGS max_execution_time = 3`,
      format: 'JSONEachRow',
    });
    await client.query({
      query: `SELECT 1 FROM ${database}.eval_conversations LIMIT 0 SETTINGS max_execution_time = 3`,
      format: 'JSONEachRow',
    });
    // Tables exist — PreSync hook ran successfully
  } catch {
    // Tables don't exist — run init as fallback
    console.warn(
      '[CH Schema] ClickHouse tables not found. Running init as fallback. ' +
        'This should be handled by the PreSync hook — verify Helm configuration.',
    );
    console.warn('[CH Schema] Running init as fallback...');
    await initAllClickHouseSchemas(client);
    console.warn('[CH Schema] Fallback init complete');
  }
}

export async function initAllClickHouseSchemas(client: ClickHouseClient): Promise<InitResult> {
  const options = resolveDDLTransformOptions();
  const database = resolveClickHouseDatabaseName();
  const allowMvRecreate = process.env.CLICKHOUSE_ALLOW_MV_RECREATE === 'true';

  const start = Date.now();

  const counters = {
    tablesCreated: 0,
    viewsCreated: 0,
    viewsSkipped: 0,
    viewsRecreated: 0,
    errors: [] as string[],
  };

  // --- Feature 1 & 2: Preflight checks when replicated ---
  if (options.useReplicated) {
    const preflightResult = await runPreflightChecks(client, database);
    assertPreflightPassed(preflightResult, database);
  }

  // --- Auto-detect cluster name from ClickHouse ---
  const cluster = options.useReplicated ? await detectClusterName(client) : undefined;

  const runCommand = async (operation: string, query: string): Promise<void> => {
    let transformed = transformDDL(query, options);
    transformed = applyOnCluster(transformed, cluster);
    try {
      await client.command({ query: transformed });
      if (operation.startsWith('create-table:')) {
        counters.tablesCreated++;
      }
    } catch (error) {
      throw new Error(
        `ClickHouse schema command failed (${operation}): ${getErrorMessage(error)}; statement="${getStatementPreview(transformed)}"`,
      );
    }
  };

  const runMV = async (name: string, ddl: string): Promise<void> => {
    let transformed = transformDDL(ddl, options);
    transformed = applyOnCluster(transformed, cluster);
    const mvName = extractMVName(transformed) ?? name;
    try {
      const result = await ensureMaterializedView(client, database, mvName, transformed, {
        allowRecreate: allowMvRecreate,
      });
      switch (result) {
        case 'created':
          counters.viewsCreated++;
          console.log(`[CH Schema] MV '${mvName}': created`);
          break;
        case 'skipped_unchanged':
        case 'skipped_no_flag':
          counters.viewsSkipped++;
          break;
        case 'recreated':
          counters.viewsRecreated++;
          console.log(`[CH Schema] MV '${mvName}': recreated`);
          break;
      }
    } catch (error) {
      throw new Error(
        `ClickHouse schema command failed (create-materialized-view:${name}): ${getErrorMessage(error)}; statement="${getStatementPreview(transformed)}"`,
      );
    }
  };

  // 1. Core tables + ALTERs + core MVs
  // TODO: refactor initClickHouseSchema to accept DDLTransformOptions parameter
  // Currently resolves its own options internally. Safe because env vars don't change mid-process.
  console.log(`[CH Schema] Running core table init (${TABLES.length} tables)...`);
  await initClickHouseSchema(client);
  console.log('[CH Schema] Core tables initialized');

  // Ensure the database exists for satellite tables too
  // (runCommand applies ON CLUSTER automatically via applyOnCluster)
  await runCommand('create-database', `CREATE DATABASE IF NOT EXISTS ${database}`);

  // Create audit log table
  await createAuditLogTable(client, database);

  // 2. Analytics tables
  console.log(`[CH Schema] Creating analytics tables (${ANALYTICS_TABLE_DDL.length} tables)...`);
  for (const { name, ddl } of ANALYTICS_TABLE_DDL) {
    await runCommand(`create-table:${name}`, ddl);
  }

  // 3. Analytics skip indices
  for (const ddl of ANALYTICS_SKIP_INDICES) {
    await runCommand('analytics-skip-index', ddl);
  }

  // 4. Analytics migrations
  console.log(
    `[CH Schema] Applying analytics migrations (${ANALYTICS_MIGRATIONS.length} ALTERs)...`,
  );
  for (const ddl of ANALYTICS_MIGRATIONS) {
    await runCommand('analytics-migration', ddl);
  }

  // 5. Analytics MVs
  console.log('[CH Schema] Processing materialized views...');
  for (const { name, ddl } of ANALYTICS_MV_DDL) {
    await runMV(name, ddl);
  }

  // 6. Eval tables
  console.log(`[CH Schema] Creating eval tables (${EVAL_TABLE_DDL.length} tables)...`);
  for (const { name, ddl } of EVAL_TABLE_DDL) {
    await runCommand(`create-table:${name}`, ddl);
  }

  // 7. Eval ALTER DDL
  console.log(`[CH Schema] Applying eval migrations (${EVAL_TABLE_ALTER_DDL.length} ALTERs)...`);
  for (const { name, ddl } of EVAL_TABLE_ALTER_DDL) {
    await runCommand(`alter-table:${name}`, ddl);
  }

  // 8. Eval MVs
  for (const { name, ddl } of EVAL_MV_DDL) {
    await runMV(name, ddl);
  }

  // 9. Experiment tables
  console.log(`[CH Schema] Creating experiment tables (${EXPERIMENT_TABLE_DDL.length} tables)...`);
  for (const { name, ddl } of EXPERIMENT_TABLE_DDL) {
    await runCommand(`create-table:${name}`, ddl);
  }

  // 10. Workflow tables — event streams -> projections -> MVs
  console.log(`[CH Schema] Creating workflow tables (${WORKFLOW_TABLES.length} tables)...`);
  await runCommand('create-table:workflow_execution_events', WORKFLOW_EXECUTION_EVENTS_TABLE_DDL);
  await runCommand('create-table:workflow_executions_latest', WORKFLOW_EXECUTIONS_LATEST_TABLE_DDL);
  await runMV('workflow_executions_latest_mv', WORKFLOW_EXECUTIONS_LATEST_MV_DDL);
  await runCommand('create-table:human_task_events', HUMAN_TASK_EVENTS_TABLE_DDL);
  await runCommand('create-table:human_tasks_latest', HUMAN_TASKS_LATEST_TABLE_DDL);
  await runMV('human_tasks_latest_mv', HUMAN_TASKS_LATEST_MV_DDL);

  // 11. Insert audit log row
  const durationMs = Date.now() - start;
  try {
    await insertAuditLogRow(client, database, 'init', durationMs, {
      tables_created: counters.tablesCreated,
      views_created: counters.viewsCreated,
      views_skipped: counters.viewsSkipped,
      views_recreated: counters.viewsRecreated,
      errors: counters.errors,
    });
  } catch {
    // Best-effort: don't fail init if audit log insert fails
  }

  return {
    durationMs,
    tablesCreated: counters.tablesCreated,
    viewsCreated: counters.viewsCreated,
    viewsSkipped: counters.viewsSkipped,
    viewsRecreated: counters.viewsRecreated,
    errors: counters.errors,
  };
}
