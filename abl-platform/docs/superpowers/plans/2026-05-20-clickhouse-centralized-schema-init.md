# ClickHouse Centralized Schema Init — Implementation Plan (Part A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize all ClickHouse DDL into `packages/database/src/clickhouse-schemas/`, create a single CLI entrypoint (`cli.ts init/status`), remove all service-level init calls, and add a new Helm PreSync hook. This fixes the `eval_conversations` table-not-found race condition and unifies DDL management.

**Architecture:** All ClickHouse DDL is authored with `Replicated*` engines as canonical form. A shared transformer strips replication when `CLICKHOUSE_REPLICATED=false`. A single `initAllClickHouseSchemas()` orchestrator creates all ~56 tables in the correct order. Services no longer run DDL at startup — the PreSync hook is the single source of truth.

**Tech Stack:** TypeScript, ClickHouse `@clickhouse/client`, Node.js CLI (`tsx`), Helm templates

**Spec:** `docs/superpowers/specs/2026-05-20-clickhouse-centralized-schema-management-design.md`

**Scope:** This plan covers `cli.ts init` and `cli.ts status`. Engine reconciliation (`cli.ts reconcile`) with shadow-copy migration is **Plan B** (separate follow-up).

---

## File Map

### New Files

| File                                                                       | Responsibility                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------- |
| `packages/database/src/clickhouse-schemas/ddl-transform.ts`                | DDL transformer (Replicated/tiered/database name) |
| `packages/database/src/clickhouse-schemas/tables/analytics.ts`             | 21 analytics table DDL + 6 MVs + ALTER migrations |
| `packages/database/src/clickhouse-schemas/tables/eval.ts`                  | 3 eval table DDL + 4 MVs + ALTER migrations       |
| `packages/database/src/clickhouse-schemas/tables/experiment.ts`            | 1 experiment table DDL                            |
| `packages/database/src/clickhouse-schemas/tables/workflow.ts`              | 4 workflow table DDL + 2 MVs                      |
| `packages/database/src/clickhouse-schemas/init-all.ts`                     | Orchestrator: calls all domain inits in order     |
| `packages/database/src/clickhouse-schemas/cli.ts`                          | CLI entrypoint: `init`, `status` commands         |
| `packages/database/src/clickhouse-schemas/__tests__/ddl-transform.test.ts` | Tests for DDL transformer                         |
| `packages/database/src/clickhouse-schemas/__tests__/init-all.test.ts`      | Tests for orchestrator                            |

### Modified Files

| File                                                                        | Change                                                                  |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/database/src/clickhouse-schemas/init.ts`                          | Refactor: use `ddl-transform.ts`, use `resolveClickHouseDatabaseName()` |
| `packages/database/package.json`                                            | Add subpath exports for new modules                                     |
| `packages/database/seed-mongo.ts`                                           | Remove `maybeInitClickHouseSchema()`                                    |
| `packages/database/seed-pipelines.ts`                                       | Update import path for `initAnalyticsTables`                            |
| `packages/pipeline-engine/src/pipeline/server.ts`                           | Remove CH init calls                                                    |
| `apps/runtime/src/server.ts`                                                | Remove CH init calls                                                    |
| `apps/search-ai/src/server.ts`                                              | Remove `initClickHouseSchema()` call                                    |
| `apps/search-ai-runtime/src/server.ts`                                      | Remove `initClickHouseSchema()` call                                    |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-preflight.ts`     | Change probe to `SELECT 1`                                              |
| `packages/eventstore/src/stores/clickhouse/index.ts`                        | Remove `initWorkflowEventTables` re-export                              |
| `packages/pipeline-engine/src/__tests__/init-eval-tables-retention.test.ts` | Update imports                                                          |
| `packages/pipeline-engine/src/__tests__/init-analytics-tables.test.ts`      | Update imports                                                          |

### Deleted Files (after DDL is moved)

| File                                                                      | Moved to                                           |
| ------------------------------------------------------------------------- | -------------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts`  | `database/clickhouse-schemas/tables/analytics.ts`  |
| `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts`       | `database/clickhouse-schemas/tables/eval.ts`       |
| `packages/pipeline-engine/src/pipeline/schemas/init-experiment-tables.ts` | `database/clickhouse-schemas/tables/experiment.ts` |
| `packages/eventstore/src/stores/clickhouse/init-workflow-event-tables.ts` | `database/clickhouse-schemas/tables/workflow.ts`   |

**Note:** `workflow-execution-events-table.ts` and `human-task-events-table.ts` in eventstore are NOT deleted — they contain DDL constants still imported by the eventstore clickhouse store. The DDL strings are copied into `tables/workflow.ts` and the eventstore files are kept as-is (they don't call init, they just define constants used by the ClickHouse event store reader/writer).

---

## Task 1: DDL Transformer

**Files:**

- Create: `packages/database/src/clickhouse-schemas/ddl-transform.ts`
- Create: `packages/database/src/clickhouse-schemas/__tests__/ddl-transform.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// packages/database/src/clickhouse-schemas/__tests__/ddl-transform.test.ts
import { describe, it, expect } from 'vitest';
import { transformDDL, resolveDDLTransformOptions } from '../ddl-transform.js';

describe('transformDDL', () => {
  const replicatedDDL = `
CREATE TABLE IF NOT EXISTS abl_platform.messages
(
    tenant_id String CODEC(ZSTD(1))
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.messages', '{replica}')
PARTITION BY toYYYYMMDD(created_at)
ORDER BY (tenant_id, session_id, created_at)
TTL
    toDateTime(created_at) + INTERVAL 30 DAY TO VOLUME 'warm',
    toDateTime(created_at) + INTERVAL 90 DAY TO VOLUME 'cold',
    toDateTime(created_at) + INTERVAL 730 DAY DELETE
SETTINGS
    storage_policy = 'tiered',
    index_granularity = 8192
`;

  it('keeps Replicated engines when useReplicated=true', () => {
    const result = transformDDL(replicatedDDL, {
      useReplicated: true,
      useTieredStorage: true,
      database: 'abl_platform',
    });
    expect(result).toContain('ReplicatedMergeTree(');
    expect(result).toContain("TO VOLUME 'warm'");
    expect(result).toContain("storage_policy = 'tiered'");
  });

  it('strips Replicated prefix when useReplicated=false', () => {
    const result = transformDDL(replicatedDDL, {
      useReplicated: false,
      useTieredStorage: true,
      database: 'abl_platform',
    });
    expect(result).toContain('MergeTree()');
    expect(result).not.toContain('ReplicatedMergeTree');
  });

  it('strips tiered storage when useTieredStorage=false', () => {
    const result = transformDDL(replicatedDDL, {
      useReplicated: true,
      useTieredStorage: false,
      database: 'abl_platform',
    });
    expect(result).not.toContain("TO VOLUME 'warm'");
    expect(result).not.toContain("TO VOLUME 'cold'");
    expect(result).not.toContain('storage_policy');
    // DELETE TTL should remain
    expect(result).toContain('730 DAY DELETE');
  });

  it('strips both Replicated and tiered storage', () => {
    const result = transformDDL(replicatedDDL, {
      useReplicated: false,
      useTieredStorage: false,
      database: 'abl_platform',
    });
    expect(result).toContain('MergeTree()');
    expect(result).not.toContain('TO VOLUME');
    expect(result).not.toContain('storage_policy');
  });

  it('preserves ReplacingMergeTree version arg', () => {
    const ddl = `ENGINE = ReplicatedReplacingMergeTree('/path', '{replica}', processed_at)`;
    const result = transformDDL(ddl, {
      useReplicated: false,
      useTieredStorage: false,
      database: 'abl_platform',
    });
    expect(result).toContain('ReplacingMergeTree(processed_at)');
  });

  it('handles ReplicatedReplacingMergeTree without version arg', () => {
    const ddl = `ENGINE = ReplicatedReplacingMergeTree('/path', '{replica}')`;
    const result = transformDDL(ddl, {
      useReplicated: false,
      useTieredStorage: false,
      database: 'abl_platform',
    });
    expect(result).toContain('ReplacingMergeTree()');
  });

  it('handles ReplicatedAggregatingMergeTree', () => {
    const ddl = `ENGINE = ReplicatedAggregatingMergeTree('/path', '{replica}')`;
    const result = transformDDL(ddl, {
      useReplicated: false,
      useTieredStorage: false,
      database: 'abl_platform',
    });
    expect(result).toContain('AggregatingMergeTree()');
  });

  it('handles ReplicatedSummingMergeTree', () => {
    const ddl = `ENGINE = ReplicatedSummingMergeTree('/path', '{replica}')`;
    const result = transformDDL(ddl, {
      useReplicated: false,
      useTieredStorage: false,
      database: 'abl_platform',
    });
    expect(result).toContain('SummingMergeTree()');
  });

  it('does not touch non-Replicated ReplacingMergeTree', () => {
    const ddl = `ENGINE = ReplacingMergeTree(updated_at)`;
    const result = transformDDL(ddl, {
      useReplicated: false,
      useTieredStorage: false,
      database: 'abl_platform',
    });
    expect(result).toContain('ReplacingMergeTree(updated_at)');
  });

  it('replaces database name', () => {
    const result = transformDDL(replicatedDDL, {
      useReplicated: true,
      useTieredStorage: true,
      database: 'custom_db',
    });
    expect(result).toContain('custom_db.messages');
    expect(result).not.toContain('abl_platform.messages');
  });

  it('does not produce empty TTL block', () => {
    const ddl = `
CREATE TABLE IF NOT EXISTS abl_platform.logs
(tenant_id String)
ENGINE = ReplicatedMergeTree('/path', '{replica}')
ORDER BY (tenant_id)
TTL
    timestamp + INTERVAL 3 DAY TO VOLUME 'warm',
    timestamp + INTERVAL 14 DAY TO VOLUME 'cold',
    timestamp + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192
`;
    const result = transformDDL(ddl, {
      useReplicated: false,
      useTieredStorage: false,
      database: 'abl_platform',
    });
    expect(result).toContain('30 DAY DELETE');
    expect(result).not.toMatch(/TTL\s+SETTINGS/);
  });
});

describe('resolveDDLTransformOptions', () => {
  it('reads from env vars', () => {
    const opts = resolveDDLTransformOptions({
      CLICKHOUSE_REPLICATED: 'true',
      CLICKHOUSE_TIERED_STORAGE: 'true',
      CLICKHOUSE_DATABASE: 'my_db',
    });
    expect(opts.useReplicated).toBe(true);
    expect(opts.useTieredStorage).toBe(true);
    expect(opts.database).toBe('my_db');
  });

  it('defaults to non-replicated', () => {
    const opts = resolveDDLTransformOptions({});
    expect(opts.useReplicated).toBe(false);
    expect(opts.useTieredStorage).toBe(false);
    expect(opts.database).toBe('abl_platform');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/SaiKumar.Shetty/Documents/abl/abl-platform
pnpm build --filter=@agent-platform/database
pnpm vitest run packages/database/src/clickhouse-schemas/__tests__/ddl-transform.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Write the transformer implementation**

```typescript
// packages/database/src/clickhouse-schemas/ddl-transform.ts
import { resolveClickHouseDatabaseName } from './database.js';

const DEFAULT_DATABASE = 'abl_platform';

export interface DDLTransformOptions {
  useReplicated: boolean;
  useTieredStorage: boolean;
  database: string;
}

/**
 * Resolve DDL transform options from environment variables.
 */
export function resolveDDLTransformOptions(
  env: Record<string, string | undefined> = process.env,
): DDLTransformOptions {
  return {
    useReplicated: env.CLICKHOUSE_REPLICATED === 'true',
    useTieredStorage: env.CLICKHOUSE_TIERED_STORAGE === 'true',
    database: resolveClickHouseDatabaseName(env.CLICKHOUSE_DATABASE),
  };
}

/**
 * Transform DDL from canonical Replicated* form to the target environment's
 * engine configuration.
 *
 * All DDL is authored with Replicated* engines. This function strips the
 * Replicated prefix when useReplicated=false, removes tiered storage clauses
 * when useTieredStorage=false, and replaces the database name.
 */
export function transformDDL(ddl: string, options: DDLTransformOptions): string {
  let result = ddl;

  // Replace database name (must run first — before engine regex which may reference db in paths)
  if (options.database !== DEFAULT_DATABASE) {
    result = result.replace(new RegExp(`${DEFAULT_DATABASE}\\.`, 'g'), `${options.database}.`);
  }

  // Strip Replicated prefix when not in replicated mode.
  // Handles all variants:
  //   ReplicatedMergeTree('/path', '{replica}') → MergeTree()
  //   ReplicatedReplacingMergeTree('/path', '{replica}', ver) → ReplacingMergeTree(ver)
  //   ReplicatedReplacingMergeTree('/path', '{replica}') → ReplacingMergeTree()
  //   ReplicatedAggregatingMergeTree('/path', '{replica}') → AggregatingMergeTree()
  //   ReplicatedSummingMergeTree('/path', '{replica}') → SummingMergeTree()
  if (!options.useReplicated) {
    // Match: Replicated<Variant>MergeTree('/path', '{replica}') or with 3rd arg
    // Group 1: engine variant (e.g., "Replacing", "Aggregating", "Summing", or "")
    // Group 2: optional 3rd argument after the two replication args (version column)
    result = result.replace(
      /Replicated(\w*MergeTree)\(\s*'[^']*'\s*,\s*'\{replica\}'\s*(?:,\s*([^)]+))?\)/g,
      (_, variant: string, versionArg?: string) => {
        if (versionArg) {
          return `${variant}(${versionArg.trim()})`;
        }
        return `${variant}()`;
      },
    );
  }

  // Strip tiered storage when not available
  if (!options.useTieredStorage) {
    // Strip all TTL TO VOLUME lines
    // Matches: toDateTime(col) + INTERVAL N DAY TO VOLUME 'name'
    // Matches: col + INTERVAL N DAY TO VOLUME 'name'
    result = result.replace(
      /,?\s*(?:toDateTime\(\w+\)|\w+)\s*\+\s*INTERVAL\s+\d+\s+DAY\s+TO\s+VOLUME\s+'[^']+'/g,
      '',
    );
    // Strip storage_policy setting (handle both trailing and leading comma)
    result = result.replace(/\s*storage_policy\s*=\s*'[^']+'\s*,?/g, '');
  }

  // Cleanup (when either was stripped)
  if (!options.useReplicated || !options.useTieredStorage) {
    // Strip SQL comments
    result = result.replace(/--[^\n]*/g, '');
    // Clean up stray comma after TTL (e.g., "TTL\n," → "TTL\n")
    result = result.replace(/TTL\s*,/g, 'TTL\n');
    // Clean up empty TTL block when all rules were stripped
    result = result.replace(/TTL\s+SETTINGS/g, 'SETTINGS');
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm build --filter=@agent-platform/database
pnpm vitest run packages/database/src/clickhouse-schemas/__tests__/ddl-transform.test.ts
```

Expected: all tests PASS

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/database/src/clickhouse-schemas/ddl-transform.ts packages/database/src/clickhouse-schemas/__tests__/ddl-transform.test.ts
```

---

## Task 2: Move Analytics DDL

**Files:**

- Create: `packages/database/src/clickhouse-schemas/tables/analytics.ts`
- Read: `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` (source)

- [ ] **Step 1: Create the analytics DDL file**

Copy the DDL definitions, table names, MV DDL, skip indices, and ALTER migrations from `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` into the new file. Keep the exact same DDL strings — do NOT modify them yet (Replicated engine conversion is Task 8).

```typescript
// packages/database/src/clickhouse-schemas/tables/analytics.ts
/**
 * Analytics ClickHouse Table & MV DDL
 *
 * Moved from packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
 * All DDL is centralized here for the unified init path.
 */

const DATABASE = 'abl_platform';

// =============================================================================
// TABLE DDL — copy ANALYTICS_TABLE_DDL array from init-analytics-tables.ts
// =============================================================================
// (21 tables: message_sentiment, conversation_sentiment, intent_classifications,
//  quality_evaluations, custom_events, conversation_tags, external_events,
//  hallucination_evaluations, knowledge_gap_evaluations, guardrail_evaluations,
//  context_evaluations, friction_detections, anomaly_detections, drift_detections,
//  customer_predictive_features, churn_risk_scores, conversation_mentions,
//  conversation_outcomes, goal_completions, toxicity_evaluations, message_toxicity,
//  llm_evaluate)

export const ANALYTICS_TABLE_DDL: { name: string; ddl: string }[] = [
  // COPY ENTIRE ARRAY FROM init-analytics-tables.ts lines 39-667
  // Preserve every DDL string exactly as-is
];

// =============================================================================
// SKIP INDICES — copy ANALYTICS_SKIP_INDICES from init-analytics-tables.ts
// =============================================================================

export const ANALYTICS_SKIP_INDICES: string[] = [
  // COPY FROM init-analytics-tables.ts lines 671-684
];

// =============================================================================
// SCHEMA MIGRATIONS — copy ANALYTICS_MIGRATIONS from init-analytics-tables.ts
// =============================================================================

export const ANALYTICS_MIGRATIONS: string[] = [
  // COPY FROM init-analytics-tables.ts lines 694-770
];

// =============================================================================
// MATERIALIZED VIEW DDL — copy ANALYTICS_MV_DDL from init-analytics-tables.ts
// =============================================================================

export const ANALYTICS_MV_DDL: { name: string; ddl: string }[] = [
  // COPY FROM init-analytics-tables.ts lines 776-903
];

// =============================================================================
// PUBLIC CONSTANTS
// =============================================================================

export const ANALYTICS_TABLES = ANALYTICS_TABLE_DDL.map((t) => t.name);
export const ANALYTICS_MVS = ANALYTICS_MV_DDL.map((v) => v.name);
```

**IMPORTANT:** This is a copy, not a move. The original file stays until Task 10 (removal). Copy every DDL string verbatim — character for character.

- [ ] **Step 2: Build to verify no syntax errors**

```bash
pnpm build --filter=@agent-platform/database
```

Expected: BUILD SUCCESS

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write packages/database/src/clickhouse-schemas/tables/analytics.ts
```

---

## Task 3: Move Eval DDL

**Files:**

- Create: `packages/database/src/clickhouse-schemas/tables/eval.ts`
- Read: `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts` (source)

- [ ] **Step 1: Create the eval DDL file**

Copy DDL from `init-eval-tables.ts`. Include the eval retention TTL migration imports and cost breakdown migration imports — these already live in `packages/database/src/clickhouse-schemas/migrations/` so the imports become local.

```typescript
// packages/database/src/clickhouse-schemas/tables/eval.ts
/**
 * Eval ClickHouse Table & MV DDL
 *
 * Moved from packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts
 */

import {
  CH_EVAL_DATA_TTL_DAYS,
  CH_PRODUCTION_SCORES_TTL_DAYS,
} from '../../constants/eval-limits.js';
import { buildEvalRetentionTtlColumnsMigrationQueries } from '../migrations/eval-retention-ttl-columns.js';
import { buildCostBreakdownMigrationQueries } from '../migrations/add-cost-breakdown-to-eval-conversations.js';

const DATABASE = 'abl_platform';

// =============================================================================
// TABLE DDL — copy EVAL_TABLE_DDL from init-eval-tables.ts lines 48-201
// =============================================================================

export const EVAL_TABLE_DDL: { name: string; ddl: string }[] = [
  // COPY ENTIRE ARRAY — 3 tables: eval_conversations, eval_scores, eval_production_scores
];

// =============================================================================
// ALTER DDL — retention + cost breakdown migrations
// =============================================================================

const DEFAULT_EVAL_RETENTION_TTL_QUERIES = buildEvalRetentionTtlColumnsMigrationQueries({
  database: DATABASE,
});

const EVAL_RETENTION_TTL_ALTER_NAMES = [
  'eval_conversations_retention_columns',
  'eval_scores_retention_columns',
  'eval_production_scores_retention_columns',
] as const;

const DEFAULT_COST_BREAKDOWN_QUERIES = buildCostBreakdownMigrationQueries({
  database: DATABASE,
});

const COST_BREAKDOWN_ALTER_NAMES = [
  'eval_conversations_customer_visible_cost',
  'eval_conversations_cost_by_model',
] as const;

export const EVAL_TABLE_ALTER_DDL: { name: string; ddl: string }[] = [
  ...EVAL_RETENTION_TTL_ALTER_NAMES.map((name, index) => {
    const ddl = DEFAULT_EVAL_RETENTION_TTL_QUERIES[index];
    if (!ddl) {
      throw new Error(`Missing eval retention TTL migration query for ${name}`);
    }
    return { name, ddl };
  }),
  ...COST_BREAKDOWN_ALTER_NAMES.map((name, index) => {
    const ddl = DEFAULT_COST_BREAKDOWN_QUERIES[index];
    if (!ddl) {
      throw new Error(`Missing cost-breakdown migration query for ${name}`);
    }
    return { name, ddl };
  }),
];

// =============================================================================
// MATERIALIZED VIEW DDL — copy EVAL_MV_DDL from init-eval-tables.ts lines 252-352
// =============================================================================

export const EVAL_MV_DDL: { name: string; ddl: string }[] = [
  // COPY ENTIRE ARRAY — 4 MVs
];

// =============================================================================
// PUBLIC CONSTANTS
// =============================================================================

export const EVAL_TABLES = EVAL_TABLE_DDL.map((t) => t.name);
export const EVAL_MVS = EVAL_MV_DDL.map((v) => v.name);
```

- [ ] **Step 2: Build to verify**

```bash
pnpm build --filter=@agent-platform/database
```

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write packages/database/src/clickhouse-schemas/tables/eval.ts
```

---

## Task 4: Move Experiment DDL

**Files:**

- Create: `packages/database/src/clickhouse-schemas/tables/experiment.ts`
- Read: `packages/pipeline-engine/src/pipeline/schemas/init-experiment-tables.ts` (source)

- [ ] **Step 1: Create the experiment DDL file**

```typescript
// packages/database/src/clickhouse-schemas/tables/experiment.ts
/**
 * Experiment ClickHouse Table DDL
 *
 * Moved from packages/pipeline-engine/src/pipeline/schemas/init-experiment-tables.ts
 */

const DATABASE = 'abl_platform';

export const EXPERIMENT_TABLE_DDL: { name: string; ddl: string }[] = [
  // COPY the experiment_assignments table DDL from init-experiment-tables.ts lines 25-49
];

export const EXPERIMENT_TABLES = EXPERIMENT_TABLE_DDL.map((t) => t.name);
```

- [ ] **Step 2: Build and format**

```bash
pnpm build --filter=@agent-platform/database
npx prettier --write packages/database/src/clickhouse-schemas/tables/experiment.ts
```

---

## Task 5: Move Workflow DDL

**Files:**

- Create: `packages/database/src/clickhouse-schemas/tables/workflow.ts`
- Read: `packages/eventstore/src/stores/clickhouse/workflow-execution-events-table.ts` (source)
- Read: `packages/eventstore/src/stores/clickhouse/human-task-events-table.ts` (source)

- [ ] **Step 1: Create the workflow DDL file**

```typescript
// packages/database/src/clickhouse-schemas/tables/workflow.ts
/**
 * Workflow Event-Sourcing ClickHouse Table DDL
 *
 * Moved from packages/eventstore/src/stores/clickhouse/
 *   - workflow-execution-events-table.ts
 *   - human-task-events-table.ts
 *
 * Note: The original files in eventstore are NOT deleted — they export
 * DDL constants used by the ClickHouse event store reader/writer.
 * This file is a copy for the centralized init path.
 */

const DATABASE = 'abl_platform';

// =============================================================================
// WORKFLOW EXECUTION EVENTS
// =============================================================================

export const WORKFLOW_EXECUTION_EVENTS_TABLE_DDL = `
// COPY FROM workflow-execution-events-table.ts lines 28-58
`;

export const WORKFLOW_EXECUTIONS_LATEST_TABLE_DDL = `
// COPY FROM workflow-execution-events-table.ts lines 60-80
`;

export const WORKFLOW_EXECUTIONS_LATEST_MV_DDL = `
// COPY FROM workflow-execution-events-table.ts lines 82-99
`;

// =============================================================================
// HUMAN TASK EVENTS
// =============================================================================

export const HUMAN_TASK_EVENTS_TABLE_DDL = `
// COPY FROM human-task-events-table.ts lines 20-52
`;

export const HUMAN_TASKS_LATEST_TABLE_DDL = `
// COPY FROM human-task-events-table.ts lines 54-79
`;

export const HUMAN_TASKS_LATEST_MV_DDL = `
// COPY FROM human-task-events-table.ts lines 81-104
`;

// =============================================================================
// PUBLIC CONSTANTS
// =============================================================================

export const WORKFLOW_TABLES = [
  'workflow_execution_events',
  'workflow_executions_latest',
  'human_task_events',
  'human_tasks_latest',
];

export const WORKFLOW_MVS = ['workflow_executions_latest_mv', 'human_tasks_latest_mv'];
```

- [ ] **Step 2: Build and format**

```bash
pnpm build --filter=@agent-platform/database
npx prettier --write packages/database/src/clickhouse-schemas/tables/workflow.ts
```

---

## Task 6: Orchestrator (`init-all.ts`)

**Files:**

- Create: `packages/database/src/clickhouse-schemas/init-all.ts`
- Create: `packages/database/src/clickhouse-schemas/__tests__/init-all.test.ts`

- [ ] **Step 1: Write the orchestrator test**

```typescript
// packages/database/src/clickhouse-schemas/__tests__/init-all.test.ts
import { describe, it, expect, vi } from 'vitest';
import { getSchemaInventory } from '../init-all.js';

describe('getSchemaInventory', () => {
  it('returns all managed table names', () => {
    const inventory = getSchemaInventory();
    // Core tables from init.ts
    expect(inventory.tables).toContain('messages');
    expect(inventory.tables).toContain('platform_events');
    expect(inventory.tables).toContain('audit_events');
    // Analytics tables
    expect(inventory.tables).toContain('message_sentiment');
    expect(inventory.tables).toContain('conversation_sentiment');
    // Eval tables
    expect(inventory.tables).toContain('eval_conversations');
    expect(inventory.tables).toContain('eval_scores');
    // Experiment tables
    expect(inventory.tables).toContain('experiment_assignments');
    // Workflow tables
    expect(inventory.tables).toContain('workflow_execution_events');
    expect(inventory.tables).toContain('human_tasks_latest');
  });

  it('returns all managed MV names', () => {
    const inventory = getSchemaInventory();
    expect(inventory.materializedViews).toContain('llm_metrics_hourly');
    expect(inventory.materializedViews).toContain('mv_daily_sentiment');
    expect(inventory.materializedViews).toContain('mv_eval_heatmap_dest');
    expect(inventory.materializedViews).toContain('workflow_executions_latest_mv');
  });

  it('does not include unmanaged tables', () => {
    const inventory = getSchemaInventory();
    for (const name of inventory.tables) {
      expect(name).not.toMatch(/^structured_data_/);
      expect(name).not.toBe('traces');
      expect(name).not.toBe('table_metadata');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm build --filter=@agent-platform/database
pnpm vitest run packages/database/src/clickhouse-schemas/__tests__/init-all.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Write the orchestrator**

```typescript
// packages/database/src/clickhouse-schemas/init-all.ts
/**
 * Unified ClickHouse Schema Orchestrator
 *
 * Single entry point for ALL ClickHouse DDL — core, analytics, eval,
 * experiment, workflow. Called by the CLI and seed scripts.
 *
 * Execution order:
 * 1. Create database
 * 2. Create all tables (data tables → projection targets)
 * 3. Apply ALTER migrations (ADD COLUMN/INDEX IF NOT EXISTS)
 * 4. Create materialized views
 */

import type { ClickHouseClient } from '@clickhouse/client';
import { resolveClickHouseDatabaseName } from './database.js';
import {
  transformDDL,
  resolveDDLTransformOptions,
  type DDLTransformOptions,
} from './ddl-transform.js';
import { initClickHouseSchema, TABLES, MATERIALIZED_VIEWS } from './init.js';
import {
  ANALYTICS_TABLE_DDL,
  ANALYTICS_SKIP_INDICES,
  ANALYTICS_MIGRATIONS,
  ANALYTICS_MV_DDL,
  ANALYTICS_TABLES,
  ANALYTICS_MVS,
} from './tables/analytics.js';
import {
  EVAL_TABLE_DDL,
  EVAL_TABLE_ALTER_DDL,
  EVAL_MV_DDL,
  EVAL_TABLES,
  EVAL_MVS,
} from './tables/eval.js';
import { EXPERIMENT_TABLE_DDL, EXPERIMENT_TABLES } from './tables/experiment.js';
import {
  WORKFLOW_EXECUTION_EVENTS_TABLE_DDL,
  WORKFLOW_EXECUTIONS_LATEST_TABLE_DDL,
  WORKFLOW_EXECUTIONS_LATEST_MV_DDL,
  HUMAN_TASK_EVENTS_TABLE_DDL,
  HUMAN_TASKS_LATEST_TABLE_DDL,
  HUMAN_TASKS_LATEST_MV_DDL,
  WORKFLOW_TABLES,
  WORKFLOW_MVS,
} from './tables/workflow.js';

export interface SchemaInventory {
  tables: string[];
  materializedViews: string[];
}

/**
 * Returns the complete managed inventory — all table and MV names
 * that this init system manages. Derived from DDL exports, not
 * a hand-maintained list.
 */
export function getSchemaInventory(): SchemaInventory {
  const coreTables = TABLES.map((t) => t.name);
  const coreMVs = MATERIALIZED_VIEWS.map((v) => v.name);

  return {
    tables: [
      ...coreTables,
      ...ANALYTICS_TABLES,
      ...EVAL_TABLES,
      ...EXPERIMENT_TABLES,
      ...WORKFLOW_TABLES,
    ],
    materializedViews: [...coreMVs, ...ANALYTICS_MVS, ...EVAL_MVS, ...WORKFLOW_MVS],
  };
}

/**
 * Initialize ALL ClickHouse schemas — core + analytics + eval + experiment + workflow.
 *
 * This is the single entry point. Services MUST NOT call individual domain inits.
 */
export async function initAllClickHouseSchemas(client: ClickHouseClient): Promise<void> {
  const database = resolveClickHouseDatabaseName();
  const options = resolveDDLTransformOptions();

  // Step 1: Create database
  await client.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });

  // Step 2: Core tables (init.ts handles its own DDL + ALTERs + MVs internally)
  await initClickHouseSchema(client);

  // Step 3: Satellite tables
  const runDDL = async (ddl: string): Promise<void> => {
    const transformed = transformDDL(ddl, options);
    await client.command({ query: transformed });
  };

  // Analytics tables
  for (const table of ANALYTICS_TABLE_DDL) {
    await runDDL(table.ddl);
  }
  for (const stmt of ANALYTICS_SKIP_INDICES) {
    await runDDL(stmt);
  }
  for (const stmt of ANALYTICS_MIGRATIONS) {
    await runDDL(stmt);
  }
  for (const view of ANALYTICS_MV_DDL) {
    await runDDL(view.ddl);
  }

  // Eval tables
  for (const table of EVAL_TABLE_DDL) {
    await runDDL(table.ddl);
  }
  for (const alter of EVAL_TABLE_ALTER_DDL) {
    await runDDL(alter.ddl);
  }
  for (const view of EVAL_MV_DDL) {
    await runDDL(view.ddl);
  }

  // Experiment tables
  for (const table of EXPERIMENT_TABLE_DDL) {
    await runDDL(table.ddl);
  }

  // Workflow tables (order matters: events → projections → MVs)
  await runDDL(WORKFLOW_EXECUTION_EVENTS_TABLE_DDL);
  await runDDL(HUMAN_TASK_EVENTS_TABLE_DDL);
  await runDDL(WORKFLOW_EXECUTIONS_LATEST_TABLE_DDL);
  await runDDL(HUMAN_TASKS_LATEST_TABLE_DDL);
  await runDDL(WORKFLOW_EXECUTIONS_LATEST_MV_DDL);
  await runDDL(HUMAN_TASKS_LATEST_MV_DDL);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm build --filter=@agent-platform/database
pnpm vitest run packages/database/src/clickhouse-schemas/__tests__/init-all.test.ts
```

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/database/src/clickhouse-schemas/init-all.ts packages/database/src/clickhouse-schemas/__tests__/init-all.test.ts
```

---

## Task 7: CLI Entrypoint

**Files:**

- Create: `packages/database/src/clickhouse-schemas/cli.ts`

- [ ] **Step 1: Create the CLI**

```typescript
#!/usr/bin/env node
// packages/database/src/clickhouse-schemas/cli.ts
/**
 * ClickHouse Schema CLI
 *
 * Usage:
 *   tsx packages/database/src/clickhouse-schemas/cli.ts init     — Create all tables + ALTERs + MVs
 *   tsx packages/database/src/clickhouse-schemas/cli.ts status   — Read-only drift report
 */

import { pathToFileURL } from 'node:url';
import { createClient } from '@clickhouse/client';
import { resolveClickHouseDatabaseName } from './database.js';
import { resolveDDLTransformOptions } from './ddl-transform.js';
import { initAllClickHouseSchemas, getSchemaInventory } from './init-all.js';

function getClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL;
  if (!url) {
    console.error('ERROR: CLICKHOUSE_URL is not set');
    process.exit(1);
  }
  return url;
}

async function runInit(): Promise<void> {
  const url = getClickHouseUrl();
  const options = resolveDDLTransformOptions();
  const database = resolveClickHouseDatabaseName();

  console.log(`[CH Schema] Initializing ClickHouse schema`);
  console.log(`  database:       ${database}`);
  console.log(`  replicated:     ${options.useReplicated}`);
  console.log(`  tieredStorage:  ${options.useTieredStorage}`);

  const client = createClient({ url });
  const start = Date.now();

  try {
    await initAllClickHouseSchemas(client);
    const inventory = getSchemaInventory();
    const durationMs = Date.now() - start;

    console.log(`[CH Schema] Init complete in ${durationMs}ms`);
    console.log(`  tables:   ${inventory.tables.length}`);
    console.log(`  views:    ${inventory.materializedViews.length}`);
  } finally {
    await client.close();
  }
}

async function runStatus(): Promise<void> {
  const url = getClickHouseUrl();
  const options = resolveDDLTransformOptions();
  const database = resolveClickHouseDatabaseName();

  console.log(`ClickHouse Schema Status (${database})`);
  console.log(`${'═'.repeat(50)}`);
  console.log(`Environment:`);
  console.log(`  CLICKHOUSE_REPLICATED:      ${options.useReplicated}`);
  console.log(`  CLICKHOUSE_TIERED_STORAGE:  ${options.useTieredStorage}`);

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

    let okCount = 0;
    let unmanagedCount = 0;

    console.log(`\nTable Inventory:`);
    for (const actual of actualTables) {
      if (actual.engine === 'MaterializedView') {
        if (managedMVNames.has(actual.name)) {
          console.log(`  ✓ ${actual.name.padEnd(40)} MaterializedView (managed)`);
        }
        continue;
      }
      if (managedNames.has(actual.name)) {
        console.log(`  ✓ ${actual.name.padEnd(40)} ${actual.engine}`);
        okCount++;
      } else {
        console.log(`  ─ ${actual.name.padEnd(40)} ${actual.engine} (unmanaged)`);
        unmanagedCount++;
      }
    }

    // Check for managed tables that don't exist
    const actualNameSet = new Set(actualTables.map((t) => t.name));
    const missingManaged = inventory.tables.filter((t) => !actualNameSet.has(t));
    for (const name of missingManaged) {
      console.log(`  ✗ ${name.padEnd(40)} MISSING`);
    }

    console.log(
      `\nSummary: ${okCount} OK, ${missingManaged.length} missing, ${unmanagedCount} unmanaged`,
    );
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
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: cli.ts init | status');
      process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      '[CH Schema] Fatal error:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
```

- [ ] **Step 2: Build to verify**

```bash
pnpm build --filter=@agent-platform/database
```

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write packages/database/src/clickhouse-schemas/cli.ts
```

---

## Task 8: Update package.json Exports

**Files:**

- Modify: `packages/database/package.json`

- [ ] **Step 1: Add subpath exports for new modules**

Add these entries to the `"exports"` field in `packages/database/package.json`:

```json
"./clickhouse-schemas/init-all": {
  "import": "./src/clickhouse-schemas/init-all.ts"
},
"./clickhouse-schemas/ddl-transform": {
  "import": "./src/clickhouse-schemas/ddl-transform.ts"
},
"./clickhouse-schemas/tables/analytics": {
  "import": "./src/clickhouse-schemas/tables/analytics.ts"
},
"./clickhouse-schemas/tables/eval": {
  "import": "./src/clickhouse-schemas/tables/eval.ts"
},
"./clickhouse-schemas/tables/experiment": {
  "import": "./src/clickhouse-schemas/tables/experiment.ts"
},
"./clickhouse-schemas/tables/workflow": {
  "import": "./src/clickhouse-schemas/tables/workflow.ts"
}
```

- [ ] **Step 2: Build to verify exports resolve**

```bash
pnpm build --filter=@agent-platform/database
```

- [ ] **Step 3: Commit**

---

## Task 9: Remove Service-Level Init Calls

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/server.ts` (lines 42-47, 488-497)
- Modify: `apps/runtime/src/server.ts` (lines 262, 2911, 3166-3168)
- Modify: `apps/search-ai/src/server.ts` (line 100, 487)
- Modify: `apps/search-ai-runtime/src/server.ts` (lines 350-351, 361)
- Modify: `packages/database/seed-mongo.ts` (line 993, lines 1180-1198)
- Modify: `packages/database/seed-pipelines.ts` (lines 18-20)
- Modify: `packages/pipeline-engine/src/pipeline/services/eval/eval-preflight.ts` (line 340)
- Modify: `packages/eventstore/src/stores/clickhouse/index.ts` (lines 32-35)

- [ ] **Step 1: Remove from pipeline-engine/server.ts**

Remove imports:

```typescript
// DELETE these imports (lines ~42-47):
import { initClickHouseSchema } from '@agent-platform/database/clickhouse-schemas/init';
import { initAnalyticsTables } from './schemas/init-analytics-tables.js';
import { initEvalTables } from './schemas/init-eval-tables.js';
import { initExperimentTables } from './schemas/init-experiment-tables.js';
```

Remove calls (lines ~488-497):

```typescript
// DELETE these lines:
await initClickHouseSchema(chClient);
// ...
await initAnalyticsTables(chClient);
await initEvalTables(chClient);
await initExperimentTables(chClient);
```

Keep the `getClickHouseClient()` call and the preflight — just remove the init calls.

- [ ] **Step 2: Remove from runtime/server.ts**

Remove import (line 262):

```typescript
// DELETE:
import { initClickHouseSchema } from '@agent-platform/database/clickhouse-schemas/init';
```

Remove call (line 2911):

```typescript
// DELETE:
await initClickHouseSchema(chClient);
```

Remove workflow init (lines 3166-3168):

```typescript
// DELETE:
const { initWorkflowEventTables } = await import('@abl/eventstore');
await initWorkflowEventTables(getClickHouseClient());
```

- [ ] **Step 3: Remove from search-ai/server.ts**

Remove import (line 100) and call (line 487) of `initClickHouseSchema`.

- [ ] **Step 4: Remove from search-ai-runtime/server.ts**

Remove async import (lines 350-351) and call (line 361) of `initClickHouseSchema`.

- [ ] **Step 5: Remove maybeInitClickHouseSchema from seed-mongo.ts**

Remove the call (line ~993) and the entire function definition (lines 1180-1198).

- [ ] **Step 6: Update seed-pipelines.ts import**

Change the import path from pipeline-engine to the new location:

```typescript
// BEFORE (line 18-19):
const { initAnalyticsTables } =
  await import('../pipeline-engine/src/pipeline/schemas/init-analytics-tables.js');

// AFTER:
const { initAnalyticsTables } = await import('./src/clickhouse-schemas/tables/analytics.js');
// Note: initAnalyticsTables is no longer needed here — the CLI handles it.
// But seed-pipelines.ts may need analytics tables to exist for seeding.
// If so, import and call initAllClickHouseSchemas instead.
```

Actually, check if `seed-pipelines.ts` needs to create tables or just insert data. Read the file to determine.

- [ ] **Step 7: Fix eval-preflight.ts probe**

Change line 340:

```typescript
// BEFORE:
query: 'SELECT 1 FROM abl_platform.eval_conversations LIMIT 0 SETTINGS max_execution_time = 5',

// AFTER:
query: 'SELECT 1 SETTINGS max_execution_time = 5',
```

- [ ] **Step 8: Remove initWorkflowEventTables from eventstore index.ts**

Remove from `packages/eventstore/src/stores/clickhouse/index.ts` lines 32-35:

```typescript
// DELETE:
export {
  initWorkflowEventTables,
  type ClickHouseCommandClient,
} from './init-workflow-event-tables.js';
```

- [ ] **Step 9: Build all affected packages**

```bash
pnpm build --filter=@agent-platform/database --filter=pipeline-engine --filter=runtime --filter=search-ai --filter=search-ai-runtime --filter=@abl/eventstore
```

- [ ] **Step 10: Format and commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/server.ts apps/runtime/src/server.ts apps/search-ai/src/server.ts apps/search-ai-runtime/src/server.ts packages/database/seed-mongo.ts packages/database/seed-pipelines.ts packages/pipeline-engine/src/pipeline/services/eval/eval-preflight.ts packages/eventstore/src/stores/clickhouse/index.ts
```

---

## Task 10: Update Tests and Delete Old Files

**Files:**

- Modify: `packages/pipeline-engine/src/__tests__/init-eval-tables-retention.test.ts`
- Modify: `packages/pipeline-engine/src/__tests__/init-analytics-tables.test.ts`
- Delete: `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts`
- Delete: `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts`
- Delete: `packages/pipeline-engine/src/pipeline/schemas/init-experiment-tables.ts`
- Delete: `packages/eventstore/src/stores/clickhouse/init-workflow-event-tables.ts`

- [ ] **Step 1: Update eval retention test imports**

In `packages/pipeline-engine/src/__tests__/init-eval-tables-retention.test.ts`, change:

```typescript
// BEFORE:
import { initEvalTables, EVAL_TABLE_DDL } from '../pipeline/schemas/init-eval-tables.js';

// AFTER:
import { EVAL_TABLE_DDL } from '@agent-platform/database/clickhouse-schemas/tables/eval';
```

Remove any calls to `initEvalTables` in the test — the test should only validate DDL content, not run init.

- [ ] **Step 2: Update analytics test imports**

In `packages/pipeline-engine/src/__tests__/init-analytics-tables.test.ts`, change:

```typescript
// BEFORE:
import { ... } from '../pipeline/schemas/init-analytics-tables.js';

// AFTER:
import { ... } from '@agent-platform/database/clickhouse-schemas/tables/analytics';
```

- [ ] **Step 3: Delete old satellite init files**

```bash
rm packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
rm packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts
rm packages/pipeline-engine/src/pipeline/schemas/init-experiment-tables.ts
rm packages/eventstore/src/stores/clickhouse/init-workflow-event-tables.ts
```

- [ ] **Step 4: Also remove the init-logger.ts if it was only used by deleted files**

Check if `packages/pipeline-engine/src/pipeline/schemas/init-logger.ts` is used by anything else. If not, delete it.

- [ ] **Step 5: Build everything**

```bash
pnpm build
```

- [ ] **Step 6: Run all tests**

```bash
pnpm test
```

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write packages/pipeline-engine/src/__tests__/init-eval-tables-retention.test.ts packages/pipeline-engine/src/__tests__/init-analytics-tables.test.ts
```

---

## Task 11: Refactor `init.ts` to Use Transformer

**Files:**

- Modify: `packages/database/src/clickhouse-schemas/init.ts`

- [ ] **Step 1: Import and use the shared transformer**

In `packages/database/src/clickhouse-schemas/init.ts`, replace the inline regex logic with the shared transformer. The key changes:

1. Import `transformDDL` and `resolveDDLTransformOptions` from `./ddl-transform.js`
2. Import `resolveClickHouseDatabaseName` from `./database.js`
3. Replace the inline `useReplicated` / `useTieredStorage` variables and regex logic (lines 1602-1687) with calls to `transformDDL()`
4. Replace hardcoded `DATABASE` constant with `resolveClickHouseDatabaseName()`

The existing `initClickHouseSchema()` function signature and behavior stays the same — only the internal implementation changes.

- [ ] **Step 2: Build and run existing tests**

```bash
pnpm build --filter=@agent-platform/database
pnpm vitest run packages/database/src/clickhouse-schemas/__tests__/
```

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write packages/database/src/clickhouse-schemas/init.ts
```

---

## Task 12: Verify End-to-End (Local)

- [ ] **Step 1: Start local ClickHouse**

```bash
cd /Users/SaiKumar.Shetty/Documents/abl/abl-platform
docker compose up -d clickhouse clickhouse-keeper
```

- [ ] **Step 2: Run the CLI init command**

```bash
CLICKHOUSE_URL=http://localhost:8124 tsx packages/database/src/clickhouse-schemas/cli.ts init
```

Expected: all tables created, zero errors

- [ ] **Step 3: Run the CLI status command**

```bash
CLICKHOUSE_URL=http://localhost:8124 tsx packages/database/src/clickhouse-schemas/cli.ts status
```

Expected: all managed tables show as ✓, zero missing

- [ ] **Step 4: Run status a second time (idempotent)**

```bash
CLICKHOUSE_URL=http://localhost:8124 tsx packages/database/src/clickhouse-schemas/cli.ts init
CLICKHOUSE_URL=http://localhost:8124 tsx packages/database/src/clickhouse-schemas/cli.ts status
```

Expected: no errors, no new tables created

- [ ] **Step 5: Run the full test suite**

```bash
pnpm build
pnpm test
```

---

## Post-Implementation Checklist

- [ ] All 56 managed tables created by `cli.ts init`
- [ ] `cli.ts status` shows zero missing managed tables
- [ ] `cli.ts init` is idempotent (run twice = no errors)
- [ ] No service calls `initClickHouseSchema`, `initAnalyticsTables`, `initEvalTables`, `initExperimentTables`, or `initWorkflowEventTables` at startup
- [ ] `seed-mongo.ts` does not call `maybeInitClickHouseSchema()`
- [ ] `eval-preflight.ts` uses `SELECT 1` probe
- [ ] `pnpm build` succeeds across all packages
- [ ] `pnpm test` passes
- [ ] DDL transformer tests pass (both replicated and non-replicated modes)
- [ ] Inventory test confirms all table names are accounted for

---

## Follow-Up: Plan B (Engine Reconciler)

Not included in this plan. Separate implementation:

- `cli.ts reconcile` command
- Shadow-copy migration with `EXCHANGE TABLES`
- `SYSTEM SYNC REPLICA` per-replica
- Redis distributed lock
- Multi-replica divergence check
- `_schema_audit_log` table
- Helm hook for `reconcile` (separate manual Job)
