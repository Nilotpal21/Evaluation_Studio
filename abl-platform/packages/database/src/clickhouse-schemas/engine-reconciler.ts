/**
 * ClickHouse Engine Reconciler
 *
 * Detects engine drift between desired (DDL-defined) and actual (running)
 * table engines. When drift is an upgrade (non-replicated → replicated),
 * performs shadow-copy migration: create _new table, INSERT SELECT,
 * EXCHANGE TABLES, rename old to _old_<timestamp>.
 */

import type { ClickHouseClient } from '@clickhouse/client';
import { detectClusterName, injectOnClusterForStatement, applyOnCluster } from './cluster.js';
import { resolveClickHouseDatabaseName, assertValidIdentifier } from './database.js';
import {
  transformDDL,
  resolveDDLTransformOptions,
  type DDLTransformOptions,
} from './ddl-transform.js';
import { assertPreflightPassed, runPreflightChecks } from './preflight.js';
import {
  TABLES,
  buildAuditEventsTableDDL,
  buildKmsAuditLogTableDDL,
  buildPiiAuditLogTableDDL,
  buildConnectorAuditLogTableDDL,
  buildCrawlAuditEventsTableDDL,
  buildArchAuditLogTableDDL,
  buildArchAuditPayloadsTableDDL,
  buildOmnichannelAuditLogTableDDL,
  resolveClickHouseAuditRetentionConfig,
} from './init.js';
import { acquireSchemaLock } from './schema-lock.js';
import {
  ANALYTICS_TABLE_DDL,
  ANALYTICS_MIGRATIONS,
  ANALYTICS_SKIP_INDICES,
} from './tables/analytics.js';
import { EVAL_TABLE_DDL, EVAL_TABLE_ALTER_DDL } from './tables/eval.js';
import { EXPERIMENT_TABLE_DDL } from './tables/experiment.js';
import {
  WORKFLOW_EXECUTION_EVENTS_TABLE_DDL,
  WORKFLOW_EXECUTIONS_LATEST_TABLE_DDL,
  HUMAN_TASK_EVENTS_TABLE_DDL,
  HUMAN_TASKS_LATEST_TABLE_DDL,
} from './tables/workflow.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EngineReconcileResult {
  checked: number;
  drifted: Array<{
    table: string;
    actualEngine: string;
    desiredEngine: string;
  }>;
  migrated: Array<{
    table: string;
    fromEngine: string;
    toEngine: string;
    rows: number;
    durationMs: number;
  }>;
  skipped: Array<{
    table: string;
    reason: string;
  }>;
  errors: Array<{
    table: string;
    error: string;
  }>;
}

export interface ReconcileOptions {
  /** If true, detect drift but don't migrate */
  dryRun?: boolean;
  /** Skip tables larger than this (default 10 GiB = 10737418240) */
  maxTableSizeBytes?: number;
}

interface DesiredTable {
  name: string;
  ddl: string;
}

interface DriftEntry {
  table: string;
  actualEngine: string;
  desiredEngine: string;
  ddl: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TABLE_SIZE_BYTES = 10_737_418_240; // 10 GiB
export const DEFAULT_RETENTION_DAYS = 7;

// Engine upgrade pairs: base engine → replicated variant
const REPLICATED_UPGRADE_MAP: Record<string, string> = {
  MergeTree: 'ReplicatedMergeTree',
  ReplacingMergeTree: 'ReplicatedReplacingMergeTree',
  SummingMergeTree: 'ReplicatedSummingMergeTree',
  AggregatingMergeTree: 'ReplicatedAggregatingMergeTree',
  CollapsingMergeTree: 'ReplicatedCollapsingMergeTree',
  VersionedCollapsingMergeTree: 'ReplicatedVersionedCollapsingMergeTree',
};

// Reverse map for downgrade detection
const NON_REPLICATED_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(REPLICATED_UPGRADE_MAP).map(([k, v]) => [v, k]),
);

// ---------------------------------------------------------------------------
// Public pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Normalize an engine string for comparison.
 * Strips empty parens and trims whitespace.
 * `ReplacingMergeTree()` → `ReplacingMergeTree`
 */
export function normalizeEngine(engine: string): string {
  return engine.trim().replace(/\(\s*\)$/, '');
}

/**
 * Extract the base engine name from a DDL string (after transform).
 * From `ENGINE = ReplacingMergeTree(processed_at)` → `ReplacingMergeTree`
 * From `ENGINE = MergeTree()` → `MergeTree`
 * From `ENGINE = MergeTree` → `MergeTree`
 */
export function getDesiredEngine(ddl: string): string | undefined {
  const match = ddl.match(/ENGINE\s*=\s*(\w+)/i);
  return match ? match[1] : undefined;
}

/**
 * Extract column names from a CREATE TABLE DDL.
 * Parses lines inside the outermost parentheses that start with a column
 * identifier followed by a type. Skips INDEX, PROJECTION, and comment lines.
 */
export function extractColumnsFromDDL(ddl: string): string[] {
  // Find the content inside the first pair of balanced parentheses after CREATE TABLE
  const createMatch = ddl.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s*\(/i);
  if (!createMatch) return [];

  const startIdx = ddl.indexOf('(', createMatch.index ?? 0);
  if (startIdx === -1) return [];

  // Find the matching closing paren
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < ddl.length; i++) {
    if (ddl[i] === '(') depth++;
    if (ddl[i] === ')') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) return [];

  const body = ddl.slice(startIdx + 1, endIdx);
  const columns: string[] = [];

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) continue;

    // Skip INDEX, PROJECTION, CONSTRAINT lines
    if (/^(INDEX|PROJECTION|CONSTRAINT)\b/i.test(trimmed)) continue;

    // Match column name: either backtick-quoted or plain identifier, followed by a type
    const colMatch = trimmed.match(/^`([^`]+)`\s+\w+|^([A-Za-z_]\w*)\s+\w+/);
    if (colMatch) {
      const colName = colMatch[1] ?? colMatch[2];
      // Filter out ClickHouse keywords that look like column starts
      if (!/^(ENGINE|PARTITION|ORDER|TTL|SETTINGS|PRIMARY)$/i.test(colName)) {
        columns.push(colName);
      }
    }
  }

  return columns;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collects all managed tables with their raw DDL from every DDL source.
 * Tables with empty DDL (built by runtime functions) are excluded since
 * we cannot determine the desired engine from them.
 */
export function collectDesiredTables(): DesiredTable[] {
  const result: DesiredTable[] = [];

  // Core tables from init.ts
  // Some tables have empty DDL — their DDL is built by runtime functions.
  // Build them now so drift detection covers all tables.
  const auditRetention = resolveClickHouseAuditRetentionConfig(process.env);
  const runtimeBuiltDDL: Record<string, string> = {
    audit_events: buildAuditEventsTableDDL(auditRetention, false),
    kms_audit_log: buildKmsAuditLogTableDDL(auditRetention, false),
    pii_audit_log: buildPiiAuditLogTableDDL(),
    connector_audit_log: buildConnectorAuditLogTableDDL(),
    crawl_audit_events: buildCrawlAuditEventsTableDDL(),
    arch_audit_log: buildArchAuditLogTableDDL(auditRetention),
    arch_audit_payloads: buildArchAuditPayloadsTableDDL(auditRetention),
    omnichannel_audit_log: buildOmnichannelAuditLogTableDDL(auditRetention),
  };

  for (const t of TABLES) {
    const ddl = t.ddl.trim() || runtimeBuiltDDL[t.name] || '';
    if (ddl) {
      result.push({ name: t.name, ddl });
    }
  }

  // Analytics tables
  for (const t of ANALYTICS_TABLE_DDL) {
    result.push({ name: t.name, ddl: t.ddl });
  }

  // Eval tables
  for (const t of EVAL_TABLE_DDL) {
    result.push({ name: t.name, ddl: t.ddl });
  }

  // Experiment tables
  for (const t of EXPERIMENT_TABLE_DDL) {
    result.push({ name: t.name, ddl: t.ddl });
  }

  // Workflow tables (individual DDL constants)
  result.push({ name: 'workflow_execution_events', ddl: WORKFLOW_EXECUTION_EVENTS_TABLE_DDL });
  result.push({ name: 'workflow_executions_latest', ddl: WORKFLOW_EXECUTIONS_LATEST_TABLE_DDL });
  result.push({ name: 'human_task_events', ddl: HUMAN_TASK_EVENTS_TABLE_DDL });
  result.push({ name: 'human_tasks_latest', ddl: HUMAN_TASKS_LATEST_TABLE_DDL });

  return result;
}

function isUpgrade(actualEngine: string, desiredEngine: string): boolean {
  const normalActual = normalizeEngine(actualEngine);
  const normalDesired = normalizeEngine(desiredEngine);

  // Check if desired is the replicated version of actual
  const expectedReplicated = REPLICATED_UPGRADE_MAP[normalActual];
  return expectedReplicated === normalDesired;
}

function isDowngrade(actualEngine: string, desiredEngine: string): boolean {
  const normalActual = normalizeEngine(actualEngine);
  const normalDesired = normalizeEngine(desiredEngine);

  // Check if desired is the non-replicated version of actual
  const expectedNonReplicated = NON_REPLICATED_MAP[normalActual];
  return expectedNonReplicated === normalDesired;
}

function generateTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
}

function rewriteTableName(ddl: string, originalName: string, newName: string): string {
  // Replace `<database>.<originalName>` with `<database>.<newName>`
  // Handle both backtick-quoted and unquoted names
  const escaped = originalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(\\b\\w+\\.)${escaped}\\b`, 'g');
  return ddl.replace(pattern, `$1${newName}`);
}

// ---------------------------------------------------------------------------
// Post-DDL replica verification
// ---------------------------------------------------------------------------

async function verifyTableOnAllReplicas(
  client: ClickHouseClient,
  cluster: string,
  database: string,
  tableName: string,
  maxRetries = 3,
  delayMs = 10000,
): Promise<void> {
  assertValidIdentifier(tableName, 'tableName');
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await client.query({
      query: `
        SELECT hostName() AS host, count() AS cnt
        FROM clusterAllReplicas('${cluster}', system.tables)
        WHERE database = '${database}' AND name = '${tableName}'
        GROUP BY host
      `,
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{ host: string; cnt: string }>;
    const allPresent = rows.every((r) => Number(r.cnt) > 0);

    // Get expected replica count
    const replicaCountResult = await client.query({
      query: `SELECT count() AS cnt FROM system.clusters WHERE cluster = '${cluster}'`,
      format: 'JSONEachRow',
    });
    const replicaCountRows = (await replicaCountResult.json()) as Array<{ cnt: string }>;
    const expectedReplicas = Number(replicaCountRows[0]?.cnt ?? 0);

    if (allPresent && rows.length >= expectedReplicas) {
      return;
    }

    if (attempt < maxRetries - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    `Table ${database}.${tableName} not converged on all replicas after ${maxRetries} retries`,
  );
}

// ---------------------------------------------------------------------------
// Core engine-drift detection
// ---------------------------------------------------------------------------

/**
 * Detects engine drift between desired DDL and actual running tables.
 * Only flags upgrades (non-replicated → replicated). Logs warnings for downgrades.
 */
export async function detectEngineDrift(
  client: ClickHouseClient,
  transformOptions: DDLTransformOptions,
): Promise<DriftEntry[]> {
  const database = transformOptions.database;
  const desiredTables = collectDesiredTables();

  // Query actual engines
  const result = await client.query({
    query: `SELECT name, engine FROM system.tables WHERE database = '${database}' AND name NOT LIKE '.inner%'`,
    format: 'JSONEachRow',
  });
  const actualTables = (await result.json()) as Array<{ name: string; engine: string }>;
  const actualMap = new Map(actualTables.map((t) => [t.name, t.engine]));

  const drifted: DriftEntry[] = [];

  for (const desired of desiredTables) {
    const transformedDDL = transformDDL(desired.ddl, transformOptions);
    const desiredEngine = getDesiredEngine(transformedDDL);
    if (!desiredEngine) continue;

    const actualEngine = actualMap.get(desired.name);
    if (!actualEngine) continue; // Table doesn't exist yet — not drift

    const normalActual = normalizeEngine(actualEngine);
    const normalDesired = normalizeEngine(desiredEngine);

    if (normalActual === normalDesired) continue; // No drift

    if (isDowngrade(normalActual, normalDesired)) {
      console.warn(
        `[Engine Reconciler] WARNING: Downgrade detected for ${desired.name}: ` +
          `${actualEngine} → ${desiredEngine}. Skipping — manual intervention required.`,
      );
      continue;
    }

    if (isUpgrade(normalActual, normalDesired)) {
      drifted.push({
        table: desired.name,
        actualEngine: normalActual,
        desiredEngine: normalDesired,
        ddl: transformedDDL,
      });
    } else {
      // Engine changed but not a recognized upgrade/downgrade pattern
      console.warn(
        `[Engine Reconciler] WARNING: Unrecognized engine change for ${desired.name}: ` +
          `${actualEngine} → ${desiredEngine}. Skipping.`,
      );
    }
  }

  return drifted;
}

// ---------------------------------------------------------------------------
// Shadow-copy migration
// ---------------------------------------------------------------------------

async function migrateTable(
  client: ClickHouseClient,
  drift: DriftEntry,
  database: string,
  maxTableSizeBytes: number,
  result: EngineReconcileResult,
  cluster: string | undefined,
): Promise<void> {
  const { table, actualEngine, desiredEngine, ddl } = drift;
  const start = Date.now();
  const onCluster = cluster ? ` ON CLUSTER '${cluster}'` : '';

  try {
    // Multi-replica divergence check (before migration)
    if (cluster) {
      const partResult = await client.query({
        query: `
          SELECT hostName() AS host, sum(rows) AS row_count, sum(bytes_on_disk) AS bytes
          FROM clusterAllReplicas('${cluster}', system.parts)
          WHERE database = '${database}' AND table = '${table}' AND active = 1
          GROUP BY host
        `,
        format: 'JSONEachRow',
      });
      const partRows = (await partResult.json()) as Array<{
        host: string;
        row_count: string;
        bytes: string;
      }>;

      if (partRows.length > 1) {
        const counts = partRows.map((r) => Number(r.row_count));
        if (new Set(counts).size > 1) {
          result.skipped.push({
            table,
            reason: `Divergent data across replicas: ${partRows.map((r) => `${r.host}=${r.row_count} rows`).join(', ')}. Manual consolidation required.`,
          });
          return;
        }
      }
    }

    // Check table size
    const sizeResult = await client.query({
      query: `SELECT total_bytes FROM system.tables WHERE database = '${database}' AND name = '${table}'`,
      format: 'JSONEachRow',
    });
    const sizeRows = (await sizeResult.json()) as Array<{ total_bytes: string | number }>;
    const totalBytes = Number(sizeRows[0]?.total_bytes ?? 0);

    if (totalBytes > maxTableSizeBytes) {
      result.skipped.push({
        table,
        reason: `Table size ${totalBytes} bytes exceeds max ${maxTableSizeBytes} bytes`,
      });
      return;
    }

    const newTableName = `${table}_new`;
    const newTableFQ = `${database}.${newTableName}`;

    // Ensure the original table exists on ALL replicas before EXCHANGE.
    // In non-replicated → replicated migration, tables only exist on the
    // init node (R1). EXCHANGE TABLES ON CLUSTER requires the table to
    // exist on every replica. Create it on missing replicas first.
    if (cluster) {
      let originalDDL = rewriteTableName(ddl, table, table);
      // Use the ORIGINAL non-replicated engine for this placeholder
      // (it will be swapped out by EXCHANGE anyway)
      originalDDL = originalDDL.replace(
        /ENGINE\s*=\s*Replicated(\w*MergeTree)\([^)]*(?:,\s*[^)]+)?\)/i,
        `ENGINE = $1()`,
      );
      originalDDL = injectOnClusterForStatement(originalDDL, cluster);
      try {
        await client.command({ query: originalDDL });
      } catch {
        // Ignore — table may already exist on all replicas (IF NOT EXISTS handles it)
      }
    }

    // Drop stale _new table from a previous failed run
    await client.command({ query: `DROP TABLE IF EXISTS ${newTableFQ}${onCluster}` });

    // Create the new table with the desired DDL, replacing the table name
    let newDDL = rewriteTableName(ddl, table, newTableName);
    if (cluster) {
      newDDL = injectOnClusterForStatement(newDDL, cluster);
    }
    await client.command({ query: newDDL });

    // Post-DDL verification: verify _new exists on all replicas
    if (cluster) {
      await verifyTableOnAllReplicas(client, cluster, database, newTableName);
    }

    // Build explicit column list from DDL
    const columns = extractColumnsFromDDL(ddl);
    if (columns.length === 0) {
      result.errors.push({ table, error: 'Could not extract columns from DDL' });
      await client.command({ query: `DROP TABLE IF EXISTS ${newTableFQ}${onCluster}` });
      return;
    }

    const columnList = columns.join(', ');

    // INSERT SELECT
    await client.command({
      query: `INSERT INTO ${newTableFQ} (${columnList}) SELECT ${columnList} FROM ${database}.${table}`,
    });

    // SYSTEM SYNC REPLICA (after INSERT, before EXCHANGE)
    if (cluster) {
      // Wait for replication to propagate to all replicas
      // SYSTEM SYNC REPLICA is a local-only command — run it on the connected node
      await client.command({
        query: `SYSTEM SYNC REPLICA ${database}.${newTableName}`,
      });

      // Verify row count on ALL replicas via clusterAllReplicas
      const allReplicaCounts = await client.query({
        query: `
          SELECT hostName() AS host, count() AS cnt
          FROM clusterAllReplicas('${cluster}', '${database}.${newTableName}')
          GROUP BY host
        `,
        format: 'JSONEachRow',
      });
      const replicaCounts = (await allReplicaCounts.json()) as Array<{
        host: string;
        cnt: string;
      }>;
      const uniqueCounts = new Set(replicaCounts.map((r) => Number(r.cnt)));
      if (uniqueCounts.size > 1) {
        await client.command({ query: `DROP TABLE IF EXISTS ${newTableFQ}${onCluster}` });
        result.errors.push({
          table,
          error: `Replication sync failed: counts differ across replicas: ${replicaCounts.map((r) => `${r.host}=${r.cnt}`).join(', ')}`,
        });
        return;
      }
    }

    // Verify row counts
    const [origCountResult, newCountResult] = await Promise.all([
      client.query({
        query: `SELECT count() AS cnt FROM ${database}.${table}`,
        format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT count() AS cnt FROM ${newTableFQ}`,
        format: 'JSONEachRow',
      }),
    ]);

    const origRows = (await origCountResult.json()) as Array<{ cnt: string | number }>;
    const newRows = (await newCountResult.json()) as Array<{ cnt: string | number }>;
    const origCount = Number(origRows[0]?.cnt ?? 0);
    const newCount = Number(newRows[0]?.cnt ?? 0);

    if (origCount !== newCount) {
      await client.command({ query: `DROP TABLE IF EXISTS ${newTableFQ}${onCluster}` });
      result.errors.push({
        table,
        error: `Row count mismatch: original=${origCount}, new=${newCount}`,
      });
      return;
    }

    // EXCHANGE TABLES
    await client.command({
      query: `EXCHANGE TABLES ${database}.${table} AND ${newTableFQ}${onCluster}`,
    });

    // Post-EXCHANGE verification: confirm the swapped table has the correct engine on all replicas
    if (cluster) {
      const postExchangeResult = await client.query({
        query: `
          SELECT hostName() AS host, engine
          FROM clusterAllReplicas('${cluster}', system.tables)
          WHERE database = '${database}' AND name = '${table}'
        `,
        format: 'JSONEachRow',
      });
      const postRows = (await postExchangeResult.json()) as Array<{
        host: string;
        engine: string;
      }>;
      const wrongEngine = postRows.filter(
        (r) => normalizeEngine(r.engine) !== normalizeEngine(desiredEngine),
      );
      if (wrongEngine.length > 0) {
        result.errors.push({
          table,
          error:
            `Post-EXCHANGE verification failed: engine mismatch on replicas: ` +
            wrongEngine.map((r) => `${r.host}=${r.engine}`).join(', ') +
            `. Expected ${desiredEngine}. Manual investigation required.`,
        });
        // Don't return — the EXCHANGE already happened. Log the error for operator attention.
        console.error(
          `[Engine Reconciler] WARNING: Post-EXCHANGE engine mismatch for ${table} on some replicas. ` +
            `This may indicate ON CLUSTER DDL queue lag. Verify manually.`,
        );
      }
    }

    // Rename old table (now in _new position) to _old_<timestamp>
    const timestamp = generateTimestamp();
    const oldTableName = `${table}_old_${timestamp}`;
    await client.command({
      query: `RENAME TABLE ${newTableFQ} TO ${database}.${oldTableName}${onCluster}`,
    });

    const durationMs = Date.now() - start;
    result.migrated.push({
      table,
      fromEngine: actualEngine,
      toEngine: desiredEngine,
      rows: origCount,
      durationMs,
    });

    console.log(
      `[Engine Reconciler] Migrated ${table}: ${actualEngine} → ${desiredEngine} ` +
        `(${origCount} rows, ${durationMs}ms)`,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    result.errors.push({ table, error: errorMsg });
    console.error(`[Engine Reconciler] Failed to migrate ${table}: ${errorMsg}`);

    // Best-effort cleanup of _new table on failure
    try {
      await client.command({
        query: `DROP TABLE IF EXISTS ${database}.${table}_new${onCluster}`,
      });
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// Main reconcile entry point
// ---------------------------------------------------------------------------

export async function reconcileEngines(
  client: ClickHouseClient,
  options: ReconcileOptions = {},
): Promise<EngineReconcileResult> {
  const { dryRun = false, maxTableSizeBytes = DEFAULT_MAX_TABLE_SIZE_BYTES } = options;
  const transformOptions = resolveDDLTransformOptions();
  const database = transformOptions.database;
  const cluster = transformOptions.useReplicated ? await detectClusterName(client) : undefined;

  // Preflight checks when replicated mode is enabled
  if (transformOptions.useReplicated) {
    const preflightResult = await runPreflightChecks(client, database);
    assertPreflightPassed(preflightResult, database);
  }

  const result: EngineReconcileResult = {
    checked: 0,
    drifted: [],
    migrated: [],
    skipped: [],
    errors: [],
  };

  const desiredTables = collectDesiredTables();
  result.checked = desiredTables.length;

  // Detect drift
  console.log(
    `[Engine Reconciler] Checking ${desiredTables.length} managed tables for engine drift...`,
  );
  const driftEntries = await detectEngineDrift(client, transformOptions);

  result.drifted = driftEntries.map((d) => ({
    table: d.table,
    actualEngine: d.actualEngine,
    desiredEngine: d.desiredEngine,
  }));

  console.log(
    `[Engine Reconciler] ${driftEntries.length} drifted, ${desiredTables.length - driftEntries.length} OK`,
  );

  if (dryRun) {
    console.log(`[Engine Reconciler] Dry run — ${driftEntries.length} drifted table(s) detected`);
    for (const d of driftEntries) {
      console.log(`  ${d.table}: ${d.actualEngine} → ${d.desiredEngine}`);
    }
    return result;
  }

  // Acquire distributed lock to prevent concurrent reconcile runs
  const holder = `${process.env.HOSTNAME ?? 'unknown'}:${process.pid}:${Date.now()}`;
  const lock = await acquireSchemaLock(client, holder);
  if (!lock.acquired) {
    console.log(
      '[Engine Reconciler] Schema reconciliation lock held by another process, skipping.',
    );
    return result;
  }

  try {
    // Ensure database exists on all replicas (required when migrating
    // from non-replicated → replicated mode — the database may only
    // exist on the node that originally ran init)
    if (cluster) {
      await client.command({
        query: `CREATE DATABASE IF NOT EXISTS ${database} ON CLUSTER '${cluster}'`,
      });
    }

    // Migrate drifted tables
    for (const drift of driftEntries) {
      await lock.extend();
      await migrateTable(client, drift, database, maxTableSizeBytes, result, cluster);
    }
  } finally {
    await lock.release();
  }

  return result;
}

// ---------------------------------------------------------------------------
// Cleanup old tables
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Column drift detection
// ---------------------------------------------------------------------------

export interface ColumnDrift {
  table: string;
  missingColumns: string[]; // In DDL but not in live
  extraColumns: string[]; // In live but not in DDL
}

/**
 * Extract column names added by ALTER TABLE ADD COLUMN statements from
 * all migration sources (analytics, eval, and core init.ts ALTERs).
 */
function extractAlterColumns(): Map<string, string[]> {
  // Collect all ALTER DDL strings from satellite migration arrays
  const allAlters: string[] = [
    ...ANALYTICS_MIGRATIONS,
    ...ANALYTICS_SKIP_INDICES,
    ...EVAL_TABLE_ALTER_DDL.map((a) => a.ddl),
  ];

  const result = new Map<string, string[]>();

  // Parse ALTER TABLE ... ADD COLUMN IF NOT EXISTS <col> from migration arrays
  for (const alter of allAlters) {
    const match = alter.match(
      /ALTER\s+TABLE\s+\w+\.(\w+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(\w+)/i,
    );
    if (match) {
      const table = match[1];
      const col = match[2];
      const existing = result.get(table) ?? [];
      if (!existing.includes(col)) {
        existing.push(col);
      }
      result.set(table, existing);
    }
  }

  // Core init.ts ALTER migrations — these use ${db} template vars so we
  // list the known column additions statically. These columns are added by
  // initClickHouseSchema() and are part of the expected schema.
  const coreAlterColumns: Record<string, string[]> = {
    messages: ['_enc', 'project_id', 'agent_name'],
    platform_events: [
      '_enc',
      'custom_dimensions',
      'known_source',
      'environment',
      'span_id',
      'parent_span_id',
      'turn_id',
      'execution_id',
      'parent_execution_id',
      'agent_run_id',
      'decision_id',
      'parent_decision_id',
      'cause_event_id',
      'phase',
      'reason_code',
    ],
    platform_events_by_session: [
      'known_source',
      'environment',
      'turn_id',
      'execution_id',
      'parent_execution_id',
      'agent_run_id',
      'decision_id',
      'parent_decision_id',
      'cause_event_id',
      'phase',
      'reason_code',
    ],
    audit_events: ['_enc'],
    insight_results: ['_enc'],
    custom_pipeline_results: ['_enc', 'score_name', 'score_path', 'score_value'],
    arch_audit_log: [
      'turn_id',
      'parent_event_id',
      'phase_label',
      'retry_of',
      'retry_index',
      'nesting_depth',
      'span_kind',
    ],
  };

  for (const [table, cols] of Object.entries(coreAlterColumns)) {
    const existing = result.get(table) ?? [];
    for (const col of cols) {
      if (!existing.includes(col)) {
        existing.push(col);
      }
    }
    result.set(table, existing);
  }

  return result;
}

export async function detectColumnDrift(
  client: ClickHouseClient,
  transformOptions: DDLTransformOptions,
): Promise<ColumnDrift[]> {
  const database = transformOptions.database;
  const desiredTables = collectDesiredTables();
  const alterColumns = extractAlterColumns();
  const drifts: ColumnDrift[] = [];

  for (const { name, ddl } of desiredTables) {
    const transformedDDL = transformDDL(ddl, transformOptions);
    const expectedColumns = extractColumnsFromDDL(transformedDDL);
    if (expectedColumns.length === 0) continue;

    // Include columns added by ALTER migrations
    const alterCols = alterColumns.get(name) ?? [];
    for (const col of alterCols) {
      if (!expectedColumns.includes(col)) {
        expectedColumns.push(col);
      }
    }

    // Query actual columns from system.columns
    const result = await client.query({
      query: `SELECT name FROM system.columns WHERE database = '${database}' AND table = '${name}' ORDER BY position`,
      format: 'JSONEachRow',
    });
    const actualRows = (await result.json()) as Array<{ name: string }>;
    const actualColumns = actualRows.map((r) => r.name);

    if (actualColumns.length === 0) continue; // Table doesn't exist yet

    const expectedSet = new Set(expectedColumns);
    const actualSet = new Set(actualColumns);

    const missingColumns = expectedColumns.filter((c) => !actualSet.has(c));
    const extraColumns = actualColumns.filter((c) => !expectedSet.has(c));

    if (missingColumns.length > 0 || extraColumns.length > 0) {
      drifts.push({ table: name, missingColumns, extraColumns });
    }
  }

  return drifts;
}

// ---------------------------------------------------------------------------
// Cleanup old tables
// ---------------------------------------------------------------------------

export async function cleanupOldTables(
  client: ClickHouseClient,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Promise<string[]> {
  const database = resolveClickHouseDatabaseName();
  const transformOptions = resolveDDLTransformOptions();
  const cluster = transformOptions.useReplicated ? await detectClusterName(client) : undefined;
  const onCluster = cluster ? ` ON CLUSTER '${cluster}'` : '';
  const cleaned: string[] = [];

  const result = await client.query({
    query: `SELECT name FROM system.tables WHERE database = '${database}' AND name LIKE '%_old_%'`,
    format: 'JSONEachRow',
  });
  const oldTables = (await result.json()) as Array<{ name: string }>;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  for (const { name } of oldTables) {
    // Parse timestamp suffix: <table>_old_<YYYYMMDDTHHMMSS>
    const tsMatch = name.match(/_old_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
    if (!tsMatch) continue;

    const [, year, month, day, hour, minute, second] = tsMatch;
    const tableDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);

    if (isNaN(tableDate.getTime())) continue;

    if (tableDate < cutoff) {
      try {
        await client.command({
          query: `DROP TABLE IF EXISTS ${database}.${name}${onCluster}`,
        });
        cleaned.push(name);
        console.log(`[Engine Reconciler] Cleaned up old table: ${name}`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Engine Reconciler] Failed to clean up ${name}: ${errorMsg}`);
      }
    }
  }

  return cleaned;
}
