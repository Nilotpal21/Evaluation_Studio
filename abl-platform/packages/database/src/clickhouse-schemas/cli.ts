#!/usr/bin/env node
// packages/database/src/clickhouse-schemas/cli.ts
/**
 * ClickHouse Schema CLI
 *
 * Usage:
 *   tsx packages/database/src/clickhouse-schemas/cli.ts init      -- Create all tables + ALTERs + MVs
 *   tsx packages/database/src/clickhouse-schemas/cli.ts status    -- Read-only drift report
 *   tsx packages/database/src/clickhouse-schemas/cli.ts reconcile -- Detect engine drift and migrate
 *
 * Flags:
 *   --format=json   Output structured JSON instead of human-readable text
 */

import { pathToFileURL } from 'node:url';
import { createClient } from '@clickhouse/client';
import { resolveClickHouseDatabaseName } from './database.js';
import { resolveDDLTransformOptions, transformDDL } from './ddl-transform.js';
import {
  reconcileEngines,
  cleanupOldTables,
  getDesiredEngine,
  normalizeEngine,
  DEFAULT_RETENTION_DAYS,
  collectDesiredTables,
  detectColumnDrift,
  type ColumnDrift,
} from './engine-reconciler.js';
import { initAllClickHouseSchemas, getSchemaInventory } from './init-all.js';
import type { InitResult } from './init-all.js';

const formatJson = process.argv.includes('--format=json');

function getClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL;
  if (!url) {
    throw new Error('CLICKHOUSE_URL is not set');
  }
  return url;
}

interface InitJsonResult {
  command: 'init';
  database: string;
  replicated: boolean;
  tieredStorage: boolean;
  durationMs: number;
  tables: number;
  views: number;
  viewsSkipped: number;
  viewsRecreated: number;
  errors: string[];
}

async function runInit(): Promise<void> {
  const url = getClickHouseUrl();
  const options = resolveDDLTransformOptions();
  const database = resolveClickHouseDatabaseName();

  if (!formatJson) {
    console.log('[CH Schema] Initializing ClickHouse schema');
    console.log(`  database:       ${database}`);
    console.log(`  replicated:     ${options.useReplicated}`);
    console.log(`  tieredStorage:  ${options.useTieredStorage}`);
  }

  const client = createClient({ url });

  try {
    const initResult: InitResult = await initAllClickHouseSchemas(client);
    const inventory = getSchemaInventory();

    if (formatJson) {
      const jsonResult: InitJsonResult = {
        command: 'init',
        database,
        replicated: options.useReplicated,
        tieredStorage: options.useTieredStorage,
        durationMs: initResult.durationMs,
        tables: inventory.tables.length,
        views: inventory.materializedViews.length,
        viewsSkipped: initResult.viewsSkipped,
        viewsRecreated: initResult.viewsRecreated,
        errors: initResult.errors,
      };
      console.log(JSON.stringify(jsonResult, null, 2));
    } else {
      console.log(`[CH Schema] Init complete in ${initResult.durationMs}ms`);
      console.log(`  tables:   ${inventory.tables.length}`);
      console.log(`  views:    ${inventory.materializedViews.length}`);
      if (initResult.viewsSkipped > 0) {
        console.log(`  views skipped (unchanged): ${initResult.viewsSkipped}`);
      }
      if (initResult.viewsRecreated > 0) {
        console.log(`  views recreated: ${initResult.viewsRecreated}`);
      }
    }
  } finally {
    await client.close();
  }
}

interface StatusJsonResult {
  command: 'status';
  database: string;
  replicated: boolean;
  tieredStorage: boolean;
  tables: Array<{
    name: string;
    engine: string;
    status: 'ok' | 'drift' | 'missing' | 'unmanaged' | 'mv_managed';
    drift?: { actual: string; desired: string };
  }>;
  columnDrifts: ColumnDrift[];
  summary: {
    ok: number;
    missing: number;
    unmanaged: number;
    drift: number;
    columnDrift: number;
  };
}

async function runStatus(): Promise<void> {
  const url = getClickHouseUrl();
  const options = resolveDDLTransformOptions();
  const database = resolveClickHouseDatabaseName();

  if (!formatJson) {
    console.log(`ClickHouse Schema Status (${database})`);
    console.log('='.repeat(50));
    console.log('Environment:');
    console.log(`  CLICKHOUSE_REPLICATED:      ${options.useReplicated}`);
    console.log(`  CLICKHOUSE_TIERED_STORAGE:  ${options.useTieredStorage}`);
  }

  const client = createClient({ url });
  try {
    const inventory = getSchemaInventory();

    // Query actual tables
    const result = await client.query({
      query: `SELECT name, engine FROM system.tables WHERE database = '${database}' AND name NOT LIKE '.inner%' ORDER BY name`,
      format: 'JSONEachRow',
    });
    const actualTables = (await result.json()) as Array<{ name: string; engine: string }>;

    const managedNames = new Set(inventory.tables);
    const managedMVNames = new Set(inventory.materializedViews);

    // Build desired engine map from DDL sources (shared with engine-reconciler)
    const desiredTables = collectDesiredTables();
    const desiredDDLMap = new Map<string, string>();
    for (const t of desiredTables) {
      desiredDDLMap.set(t.name, t.ddl);
    }

    let okCount = 0;
    let unmanagedCount = 0;
    let driftCount = 0;

    const jsonTables: StatusJsonResult['tables'] = [];

    if (!formatJson) {
      console.log('\nTable Inventory:');
    }

    for (const actual of actualTables) {
      if (actual.engine === 'MaterializedView') {
        if (managedMVNames.has(actual.name)) {
          if (!formatJson) {
            console.log(`  + ${actual.name.padEnd(40)} MaterializedView (managed)`);
          }
          jsonTables.push({
            name: actual.name,
            engine: actual.engine,
            status: 'mv_managed',
          });
        }
        continue;
      }
      if (managedNames.has(actual.name)) {
        // Check engine drift
        const rawDDL = desiredDDLMap.get(actual.name);
        let engineInfo = '';
        let driftInfo: { actual: string; desired: string } | undefined;
        if (rawDDL) {
          const transformed = transformDDL(rawDDL, options);
          const desired = getDesiredEngine(transformed);
          if (desired && normalizeEngine(actual.engine) !== normalizeEngine(desired)) {
            engineInfo = ` (drift: actual=${actual.engine}, desired=${desired})`;
            driftInfo = { actual: actual.engine, desired };
            driftCount++;
          }
        }
        if (engineInfo) {
          if (!formatJson) {
            console.log(`  ! ${actual.name.padEnd(40)} ${actual.engine}${engineInfo}`);
          }
          jsonTables.push({
            name: actual.name,
            engine: actual.engine,
            status: 'drift',
            drift: driftInfo,
          });
        } else {
          if (!formatJson) {
            console.log(`  + ${actual.name.padEnd(40)} ${actual.engine}`);
          }
          jsonTables.push({
            name: actual.name,
            engine: actual.engine,
            status: 'ok',
          });
        }
        okCount++;
      } else {
        if (!formatJson) {
          console.log(`  - ${actual.name.padEnd(40)} ${actual.engine} (unmanaged)`);
        }
        jsonTables.push({
          name: actual.name,
          engine: actual.engine,
          status: 'unmanaged',
        });
        unmanagedCount++;
      }
    }

    // Check for managed tables that don't exist
    const actualNameSet = new Set(actualTables.map((t) => t.name));
    const missingManaged = inventory.tables.filter((t) => !actualNameSet.has(t));
    for (const name of missingManaged) {
      if (!formatJson) {
        console.log(`  x ${name.padEnd(40)} MISSING`);
      }
      jsonTables.push({
        name,
        engine: '',
        status: 'missing',
      });
    }

    // Column drift detection
    if (!formatJson) {
      console.log('\nChecking column drift...');
    }
    const columnDrifts = await detectColumnDrift(client, options);
    if (!formatJson && columnDrifts.length > 0) {
      console.log('\nColumn Drift:');
      for (const drift of columnDrifts) {
        if (drift.missingColumns.length > 0) {
          console.log(
            `  \u2717 ${drift.table}: missing columns: ${drift.missingColumns.join(', ')}`,
          );
        }
        if (drift.extraColumns.length > 0) {
          console.log(`  \u2139 ${drift.table}: extra columns: ${drift.extraColumns.join(', ')}`);
        }
      }
    }

    if (formatJson) {
      const jsonResult: StatusJsonResult = {
        command: 'status',
        database,
        replicated: options.useReplicated,
        tieredStorage: options.useTieredStorage,
        tables: jsonTables,
        columnDrifts,
        summary: {
          ok: okCount,
          missing: missingManaged.length,
          unmanaged: unmanagedCount,
          drift: driftCount,
          columnDrift: columnDrifts.length,
        },
      };
      console.log(JSON.stringify(jsonResult, null, 2));
    } else {
      console.log(
        `\nSummary: ${okCount} OK, ${missingManaged.length} missing, ${unmanagedCount} unmanaged, ${driftCount} engine drift, ${columnDrifts.length} column drift`,
      );
    }
  } finally {
    await client.close();
  }
}

interface ReconcileJsonResult {
  command: 'reconcile';
  mode: 'dry-run' | 'execute';
  checked: number;
  drifted: Array<{ table: string; actualEngine: string; desiredEngine: string }>;
  migrated: Array<{
    table: string;
    fromEngine: string;
    toEngine: string;
    rows: number;
    durationMs: number;
  }>;
  skipped: Array<{ table: string; reason: string }>;
  errors: Array<{ table: string; error: string }>;
  cleanedUp: string[];
}

async function runReconcile(): Promise<void> {
  const url = getClickHouseUrl();
  const engineMigration = process.env.CLICKHOUSE_ENGINE_MIGRATION;
  const dryRun = engineMigration !== 'execute';

  if (!formatJson) {
    console.log('[CH Schema] Engine reconciliation');
    console.log(
      `  mode:  ${dryRun ? 'dry-run (set CLICKHOUSE_ENGINE_MIGRATION=execute to migrate)' : 'EXECUTE'}`,
    );
  }

  const client = createClient({ url });
  try {
    const result = await reconcileEngines(client, { dryRun });

    let cleanedUp: string[] = [];

    if (!formatJson) {
      console.log(`\n[CH Schema] Reconcile results:`);
      console.log(`  checked:  ${result.checked}`);
      console.log(`  drifted:  ${result.drifted.length}`);
      console.log(`  migrated: ${result.migrated.length}`);
      console.log(`  skipped:  ${result.skipped.length}`);
      console.log(`  errors:   ${result.errors.length}`);

      if (result.drifted.length > 0) {
        console.log('\nDrifted tables:');
        for (const d of result.drifted) {
          console.log(`  ${d.table}: ${d.actualEngine} -> ${d.desiredEngine}`);
        }
      }

      if (result.migrated.length > 0) {
        console.log('\nMigrated tables:');
        for (const m of result.migrated) {
          console.log(
            `  ${m.table}: ${m.fromEngine} -> ${m.toEngine} (${m.rows} rows, ${m.durationMs}ms)`,
          );
        }
      }

      if (result.skipped.length > 0) {
        console.log('\nSkipped tables:');
        for (const s of result.skipped) {
          console.log(`  ${s.table}: ${s.reason}`);
        }
      }

      if (result.errors.length > 0) {
        console.log('\nErrors:');
        for (const e of result.errors) {
          console.log(`  ${e.table}: ${e.error}`);
        }
      }
    }

    // Cleanup old tables from previous migrations
    if (!dryRun) {
      cleanedUp = await cleanupOldTables(client, DEFAULT_RETENTION_DAYS);
      if (!formatJson && cleanedUp.length > 0) {
        console.log(`\nCleaned up ${cleanedUp.length} old table(s):`);
        for (const name of cleanedUp) {
          console.log(`  ${name}`);
        }
      }
    }

    if (formatJson) {
      const jsonResult: ReconcileJsonResult = {
        command: 'reconcile',
        mode: dryRun ? 'dry-run' : 'execute',
        checked: result.checked,
        drifted: result.drifted,
        migrated: result.migrated,
        skipped: result.skipped,
        errors: result.errors,
        cleanedUp,
      };
      console.log(JSON.stringify(jsonResult, null, 2));
    }

    if (result.errors.length > 0) {
      process.exit(1);
    }
    if (result.skipped.length > 0) {
      console.error(
        `[CH Schema] ${result.skipped.length} table(s) skipped (too large or divergent). ` +
          'Run during maintenance window with writer pods scaled to 0.',
      );
      process.exit(2); // Distinct exit code for incomplete reconciliation
    }
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] || 'init';

  switch (command) {
    case 'init':
      await runInit();
      break;
    case 'status':
      await runStatus();
      break;
    case 'reconcile':
      await runReconcile();
      break;
    default:
      if (formatJson) {
        console.log(JSON.stringify({ error: `Unknown command: ${command}` }, null, 2));
      } else {
        console.error(`Unknown command: ${command}`);
        console.error('Usage: cli.ts init | status | reconcile [--format=json]');
      }
      process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (formatJson) {
      console.log(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2),
      );
    } else {
      console.error(
        '[CH Schema] Fatal error:',
        error instanceof Error ? error.message : String(error),
      );
    }
    process.exit(1);
  });
}
