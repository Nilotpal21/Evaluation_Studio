/**
 * Schema Integrity Tests
 *
 * Validates DDL integrity and consistency WITHOUT needing a ClickHouse
 * connection. All tests are pure — they import DDL arrays and validate
 * their content. This ensures the centralized schema system won't break
 * the seed-migrate-ops image at runtime.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { TABLES } from '../init.js';
import {
  ANALYTICS_TABLE_DDL,
  ANALYTICS_MV_DDL,
  ANALYTICS_SKIP_INDICES,
  ANALYTICS_MIGRATIONS,
} from '../tables/analytics.js';
import { EVAL_TABLE_DDL, EVAL_TABLE_ALTER_DDL, EVAL_MV_DDL } from '../tables/eval.js';
import { EXPERIMENT_TABLE_DDL } from '../tables/experiment.js';
import {
  WORKFLOW_EXECUTION_EVENTS_TABLE_DDL,
  WORKFLOW_EXECUTIONS_LATEST_TABLE_DDL,
  WORKFLOW_EXECUTIONS_LATEST_MV_DDL,
  HUMAN_TASK_EVENTS_TABLE_DDL,
  HUMAN_TASKS_LATEST_TABLE_DDL,
  HUMAN_TASKS_LATEST_MV_DDL,
} from '../tables/workflow.js';
import { transformDDL } from '../ddl-transform.js';
import type { DDLTransformOptions } from '../ddl-transform.js';
import {
  getDesiredEngine,
  extractColumnsFromDDL,
  collectDesiredTables,
} from '../engine-reconciler.js';
import { getSchemaInventory } from '../init-all.js';

// ---------------------------------------------------------------------------
// Shared DDL collection
// ---------------------------------------------------------------------------

const allTableDDLs = [
  ...TABLES.filter((t) => t.ddl.trim()).map((t) => ({ name: t.name, ddl: t.ddl, source: 'core' })),
  ...ANALYTICS_TABLE_DDL.map((t) => ({ name: t.name, ddl: t.ddl, source: 'analytics' })),
  ...EVAL_TABLE_DDL.map((t) => ({ name: t.name, ddl: t.ddl, source: 'eval' })),
  ...EXPERIMENT_TABLE_DDL.map((t) => ({ name: t.name, ddl: t.ddl, source: 'experiment' })),
  {
    name: 'workflow_execution_events',
    ddl: WORKFLOW_EXECUTION_EVENTS_TABLE_DDL,
    source: 'workflow',
  },
  {
    name: 'workflow_executions_latest',
    ddl: WORKFLOW_EXECUTIONS_LATEST_TABLE_DDL,
    source: 'workflow',
  },
  { name: 'human_task_events', ddl: HUMAN_TASK_EVENTS_TABLE_DDL, source: 'workflow' },
  { name: 'human_tasks_latest', ddl: HUMAN_TASKS_LATEST_TABLE_DDL, source: 'workflow' },
];

// ---------------------------------------------------------------------------
// 1. DDL Validity
// ---------------------------------------------------------------------------

describe('DDL validity', () => {
  it.each(allTableDDLs)('$source/$name DDL contains CREATE TABLE IF NOT EXISTS', ({ ddl }) => {
    expect(ddl).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i);
  });

  it.each(allTableDDLs)('$source/$name DDL contains ENGINE clause', ({ ddl }) => {
    expect(ddl).toMatch(/ENGINE\s*=/i);
  });

  it.each(allTableDDLs)('$source/$name DDL contains ORDER BY', ({ ddl }) => {
    expect(ddl).toMatch(/ORDER\s+BY/i);
  });

  it.each(allTableDDLs)('$source/$name DDL references abl_platform database', ({ ddl }) => {
    expect(ddl).toContain('abl_platform.');
  });
});

// ---------------------------------------------------------------------------
// 2. DDL Transform Roundtrip
// ---------------------------------------------------------------------------

describe('DDL transform roundtrip', () => {
  const replicatedOpts: DDLTransformOptions = {
    useReplicated: true,
    useTieredStorage: true,
    database: 'abl_platform',
  };
  const nonReplicatedOpts: DDLTransformOptions = {
    useReplicated: false,
    useTieredStorage: false,
    database: 'abl_platform',
  };

  it.each(allTableDDLs)('$source/$name survives replicated transform without error', ({ ddl }) => {
    const result = transformDDL(ddl, replicatedOpts);
    expect(result).toContain('ENGINE');
    expect(result).toContain('abl_platform.');
  });

  it.each(allTableDDLs)(
    '$source/$name survives non-replicated transform without error',
    ({ ddl }) => {
      const result = transformDDL(ddl, nonReplicatedOpts);
      expect(result).toContain('ENGINE');
      expect(result).not.toMatch(/Replicated\w*MergeTree/);
    },
  );

  it.each(allTableDDLs)(
    '$source/$name has no Replicated* engine after non-replicated transform',
    ({ ddl }) => {
      const result = transformDDL(ddl, nonReplicatedOpts);
      expect(result).not.toMatch(/Replicated\w*MergeTree/);
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Column Extraction
// ---------------------------------------------------------------------------

describe('column extraction', () => {
  it.each(allTableDDLs)('$source/$name has extractable columns', ({ ddl }) => {
    const columns = extractColumnsFromDDL(ddl);
    expect(columns.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Engine Detection
// ---------------------------------------------------------------------------

describe('engine detection', () => {
  it.each(allTableDDLs)('$source/$name has a detectable engine', ({ ddl }) => {
    const engine = getDesiredEngine(ddl);
    expect(engine).toBeDefined();
    expect(engine).toMatch(/MergeTree/);
  });
});

// ---------------------------------------------------------------------------
// 5. Replicated Engine Canonical Form Audit
// ---------------------------------------------------------------------------

describe('Replicated engine canonical form audit', () => {
  const INTENTIONALLY_NON_REPLICATED = new Set(['facts']);

  it('all managed tables use Replicated* canonical form (except facts)', () => {
    const nonReplicated: string[] = [];
    for (const { name, ddl } of allTableDDLs) {
      if (INTENTIONALLY_NON_REPLICATED.has(name)) continue;
      if (!ddl.match(/Replicated\w*MergeTree/)) {
        nonReplicated.push(name);
      }
    }
    expect(nonReplicated).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. Schema Inventory Completeness
// ---------------------------------------------------------------------------

describe('schema inventory completeness', () => {
  it('every collectDesiredTables entry is in the getSchemaInventory tables list', () => {
    const desired = collectDesiredTables();
    const inventory = getSchemaInventory();
    for (const t of desired) {
      expect(inventory.tables).toContain(t.name);
    }
  });

  it('every MV DDL contains CREATE MATERIALIZED VIEW IF NOT EXISTS', () => {
    const allMVDDLs = [
      ...ANALYTICS_MV_DDL,
      ...EVAL_MV_DDL,
      {
        name: 'workflow_executions_latest_mv',
        ddl: WORKFLOW_EXECUTIONS_LATEST_MV_DDL,
      },
      { name: 'human_tasks_latest_mv', ddl: HUMAN_TASKS_LATEST_MV_DDL },
    ];
    for (const mv of allMVDDLs) {
      expect(mv.ddl).toMatch(/CREATE\s+MATERIALIZED\s+VIEW\s+IF\s+NOT\s+EXISTS/i);
    }
  });

  it('every ALTER migration uses IF NOT EXISTS or IF EXISTS', () => {
    const allAlters = [
      ...ANALYTICS_SKIP_INDICES,
      ...ANALYTICS_MIGRATIONS,
      ...EVAL_TABLE_ALTER_DDL.map((a) => a.ddl),
    ];
    for (const alter of allAlters) {
      // Some ALTER statements use MODIFY TTL which doesn't need IF NOT EXISTS
      if (/MODIFY\s+TTL/i.test(alter)) continue;
      expect(alter).toMatch(/IF\s+NOT\s+EXISTS|IF\s+EXISTS/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Seed Script Compatibility
// ---------------------------------------------------------------------------

describe('seed script compatibility', () => {
  it('init-all exports initAllClickHouseSchemas as a function', async () => {
    const mod = await import('../init-all.js');
    expect(typeof mod.initAllClickHouseSchemas).toBe('function');
  });

  it('seed-mongo does NOT import or call any ClickHouse init functions', () => {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const seedMongoPath = path.resolve(thisDir, '../../..', 'seed-mongo.ts');
    const content = fs.readFileSync(seedMongoPath, 'utf-8');
    // seed-mongo may reference ClickHouse for analytics init, but should NOT
    // import the deprecated initClickHouseSchema (singular) directly
    expect(content).not.toContain('initClickHouseSchema(');
    expect(content).not.toContain('maybeInitClickHouseSchema');
  });
});

// ---------------------------------------------------------------------------
// 8. CLI Module
// ---------------------------------------------------------------------------

describe('CLI module', () => {
  it('cli.ts has the main guard preventing side effects on import', () => {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const cliPath = path.resolve(thisDir, '../cli.ts');
    const content = fs.readFileSync(cliPath, 'utf-8');
    expect(content).toContain('import.meta.url');
    expect(content).toContain('pathToFileURL');
  });
});

// ---------------------------------------------------------------------------
// 9. No Duplicate Table Names
// ---------------------------------------------------------------------------

describe('no duplicate table names', () => {
  it('all table names across all sources are unique', () => {
    const names = allTableDDLs.map((t) => t.name);
    const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
    expect(duplicates).toEqual([]);
  });

  it('inventory table names are unique', () => {
    const inventory = getSchemaInventory();
    const duplicates = inventory.tables.filter((name, i) => inventory.tables.indexOf(name) !== i);
    expect(duplicates).toEqual([]);
  });

  it('inventory MV names are unique', () => {
    const inventory = getSchemaInventory();
    const duplicates = inventory.materializedViews.filter(
      (name, i) => inventory.materializedViews.indexOf(name) !== i,
    );
    expect(duplicates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10. DDL Database Name Transform
// ---------------------------------------------------------------------------

describe('DDL database name transform', () => {
  const customDbOpts: DDLTransformOptions = {
    useReplicated: true,
    useTieredStorage: true,
    database: 'custom_db',
  };

  it.each(allTableDDLs)('$source/$name correctly substitutes custom database name', ({ ddl }) => {
    const result = transformDDL(ddl, customDbOpts);
    expect(result).toContain('custom_db.');
    expect(result).not.toContain('abl_platform.');
  });
});
