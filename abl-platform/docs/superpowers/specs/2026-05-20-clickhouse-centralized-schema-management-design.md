# Centralized ClickHouse Schema Management with Self-Healing Engine Reconciliation

**Date:** 2026-05-20
**Status:** Approved
**Scope:** `packages/database`, `packages/pipeline-engine`, `packages/eventstore`, `apps/runtime`, `abl-platform-deploy`

---

## Problem

### Current State — DDL Scattered Across 5 Init Files

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CURRENT: Fragmented Init                             │
│                                                                             │
│  packages/database/                                                         │
│  └── clickhouse-schemas/init.ts ──── 27 core tables (Replicated* + regex)  │
│                                                                             │
│  packages/pipeline-engine/                                                  │
│  └── pipeline/schemas/                                                      │
│      ├── init-analytics-tables.ts ── 21 tables (hardcoded ReplacingMergeTree)│
│      ├── init-eval-tables.ts ─────── 3 tables  (hardcoded MergeTree)       │
│      └── init-experiment-tables.ts ─ 1 table   (hardcoded MergeTree)       │
│                                                                             │
│  packages/eventstore/                                                       │
│  └── stores/clickhouse/                                                     │
│      ├── workflow-execution-events-table.ts ─┐                              │
│      ├── human-task-events-table.ts ─────────┤ 4 tables (hardcoded MergeTree│
│      └── init-workflow-event-tables.ts ──────┘  /ReplacingMergeTree)        │
└─────────────────────────────────────────────────────────────────────────────┘
```

| Init File                       | Package           | Tables       | Engine                                     |
| ------------------------------- | ----------------- | ------------ | ------------------------------------------ |
| `init.ts`                       | `database`        | 27 core      | `Replicated*` with regex strip             |
| `init-analytics-tables.ts`      | `pipeline-engine` | 21 analytics | Hardcoded `ReplacingMergeTree`             |
| `init-eval-tables.ts`           | `pipeline-engine` | 3 eval       | Hardcoded `MergeTree`                      |
| `init-experiment-tables.ts`     | `pipeline-engine` | 1 experiment | Hardcoded `MergeTree`                      |
| `init-workflow-event-tables.ts` | `eventstore`      | 4 workflow   | Hardcoded `MergeTree`/`ReplacingMergeTree` |

### Current Execution — Dual Init Paths

```
                    ┌─────────────────────────┐
                    │     ArgoCD Deploy        │
                    └────────┬────────────────┘
                             │
              ┌──────────────┼──────────────────┐
              ▼              ▼                   ▼
    ┌─────────────────┐ ┌──────────┐    ┌───────────────┐
    │ PreSync Hook    │ │ Pod      │    │ Pod           │
    │ seed-migrate-ops│ │ pipeline │    │ runtime       │
    │                 │ │ -engine  │    │               │
    │ • MongoDB       │ │          │    │               │
    │   migrations    │ │ Startup: │    │ Startup:      │
    │ • MongoDB seed  │ │ • initCH │    │ • initCH      │
    │ • initCH        │ │   Schema │    │   Schema      │
    │   Schema ←──────┤ │ • initA  │    │ • initWorkflow│
    │   (core 27 only)│ │   nalytics    │   EventTables │
    │                 │ │ • initEval    │               │
    │  ❌ No satellite│ │ • initExp │    │               │
    │     tables!     │ │          │    │               │
    └─────────────────┘ │ • eval   │    └───────────────┘
                        │   preflight
                        │   ↓
                        │ ❌ FAILS!
                        │ "Unknown table│
                        │  eval_conver- │
                        │  sations"     │
                        └──────────────┘
```

### Problems

1. **Race conditions** — satellite tables created at pod startup, not during PreSync. Eval preflight fails with `Unknown table expression identifier 'abl_platform.eval_conversations'`.
2. **No replication support** — satellite init files hardcode non-replicated engines. Even staging (2 replicas + 3 Keeper nodes) runs `CLICKHOUSE_REPLICATED=false` with 0 replicated tables.
3. **Database name inconsistency** — `init.ts` hardcodes `abl_platform`. Satellite files use `resolveClickHouseDatabaseName()`.
4. **No engine drift detection** — flipping `CLICKHOUSE_REPLICATED=true` leaves existing `MergeTree` tables unchanged.

### Live Cluster Evidence

```
Environment   CH Pods          Keeper   REPLICATED    Target State
────────────────────────────────────────────────────────────────────────────
Dev           1×1 replica      3 nodes  false         stay non-replicated
QA            1×1 replica      3 nodes  false         stay non-replicated
SIT           replicated       3 nodes  true          already replicated
Staging       1×2 replicas     3 nodes  false         migrate to true
Production    replicated       3 nodes  true          already replicated
```

### Live Kubernetes Validation — 2026-05-20

Read-only validation was performed against the active Kubernetes contexts:

```
Context                     Namespace               ClickHouse Pods   Keeper Pods   Cluster Name
───────────────────────────────────────────────────────────────────────────────────────────────
aks-abl-dev-centralus       abl-platform-dev        1 replica         3 nodes       default_cluster
aks-abl-staging-centralus   abl-platform-staging    2 replicas        3 nodes       default_cluster
```

Observed configuration:

- Staging ClickHouse config defines `remote_servers.default_cluster` with two replicas and `distributed_ddl` at `/clickhouse/task_queue/ddl`.
- Staging macros define `<cluster>default_cluster</cluster>` and `<shard>1</shard>`.
- Runtime config in both dev and staging currently has `CLICKHOUSE_REPLICATED=false`.
- Current app tables in dev and staging are non-replicated (`MergeTree`, `ReplacingMergeTree`, `AggregatingMergeTree`, `SummingMergeTree`) even though staging has two ClickHouse replicas and Keeper.
- Operator input: SIT and production already run with `CLICKHOUSE_REPLICATED=true`; dev and QA should remain `false`; staging is the environment that must be moved from `false` to `true`.

Staging engine inventory from `system.tables`:

```
Host                                      Aggregating  MV   MergeTree  Replacing  Summing
─────────────────────────────────────────────────────────────────────────────────────────
clickhouse-shard-0-0                     10           22   31         28         9
clickhouse-shard-0-1                     10           28   36         28         15
```

The raw per-replica inventory differs because of unmanaged/dynamic objects:

- `.inner_id.*` internal MV target tables
- `structured_data_*` tables owned by search-ai
- historical `*_backup_*` materialized views

After excluding those unmanaged patterns, managed table names and engines are consistent across both staging replicas. The design therefore requires a **managed inventory preflight** before any replicated migration, but it must ignore unmanaged objects by the same rules used by `cli.ts status`.

### Deploy Repository Configuration Source of Truth

Environment configuration must be driven from `abl-platform-deploy`, not inferred only
from live ConfigMaps. Live ConfigMaps are validation output; deploy repo values are the
desired state source.

Current deploy-repo state:

```
File                                      Setting                                  Value
────────────────────────────────────────────────────────────────────────────────────────────
helm/abl-platform/values.yaml             runtime.configMap.CLICKHOUSE_REPLICATED false
helm/abl-platform-stack/values.yaml       clickhouse.clusterName                  default_cluster
environments/dev/values.yaml              clickhouse.replicas                     1
environments/qa/values.yaml               clickhouse.replicas                     1
environments/staging/values.yaml          runtime CLICKHOUSE_REPLICATED override  absent → false
environments/staging/values.yaml          clickhouse.replicas                     2
environments/staging/values.yaml          clickhouse.clusterName                  inherited default_cluster
environments/sit/values.yaml              runtime.configMap.CLICKHOUSE_REPLICATED true
environments/sit/values.yaml              clickhouse.operator.enabled             true
environments/sit/values.yaml              clickhouse.clusterName                  main
environments/prod/values.yaml             runtime.configMap.CLICKHOUSE_REPLICATED true
environments/prod/values.yaml             clickhouse.operator.enabled             true
environments/prod/values.yaml             clickhouse.clusterName                  main
```

Required deploy-repo target state for this design:

```
Environment   CLICKHOUSE_REPLICATED   CLICKHOUSE_CLUSTER   ENGINE_MIGRATION
────────────────────────────────────────────────────────────────────────────
dev           false                   unset                unset
qa            false                   unset                unset
staging       true                    default_cluster      unset for dry-run, execute for approved migration
sit           true                    main                 unset by default; execute only after status review
prod          true                    main                 unset by default; execute only after approved change
```

Implications:

- Add `CLICKHOUSE_REPLICATED: "true"` to `environments/staging/values.yaml` under runtime config.
- Add `CLICKHOUSE_CLUSTER` to every replicated environment once the centralized CLI depends on it:
  - staging: `default_cluster`
  - sit: `main`
  - prod: `main`
- Do not add `CLICKHOUSE_CLUSTER` to dev/QA unless those environments are intentionally moved to replicated ClickHouse.
- `CLICKHOUSE_ENGINE_MIGRATION=execute` must not be committed as the steady-state default. It is a rollout-time gate enabled only for the approved migration window.

---

## Non-Goals

- **`structured_data_*` tables** — dynamically created by search-ai at runtime per search index. Cannot be pre-created or managed by this system.
- **`traces` / `table_metadata` tables** — created by search-ai's ClickHouse client for structured data tracking. Owned by search-ai, not the platform schema.
- **Coroot/monitoring ClickHouse tables** — separate cluster (`coroot` namespace), not part of abl-platform.

## Solution

Centralize all ClickHouse DDL into `packages/database/src/clickhouse-schemas/`, with a single CLI entrypoint, shared DDL transformer, and self-healing engine reconciler.

---

## Architecture

### Target File Structure

```
packages/database/src/clickhouse-schemas/
│
├── cli.ts                          ← NEW   CLI entrypoint (init, status)
├── init-all.ts                     ← NEW   Orchestrator function
├── ddl-transform.ts                ← NEW   Replicated/tiered/database transformer
├── engine-reconciler.ts            ← NEW   Drift detection + shadow-copy migration
│
├── database.ts                     ← EXISTS resolveClickHouseDatabaseName()
├── init.ts                         ← MODIFY Core 27 tables (use transformer)
│
├── tables/
│   ├── analytics.ts                ← NEW   21 tables + 6 MVs + migrations
│   │                                        (from pipeline-engine/schemas/init-analytics-tables.ts)
│   ├── eval.ts                     ← NEW   3 tables + 4 MVs + migrations
│   │                                        (from pipeline-engine/schemas/init-eval-tables.ts)
│   ├── experiment.ts               ← NEW   1 table
│   │                                        (from pipeline-engine/schemas/init-experiment-tables.ts)
│   └── workflow.ts                 ← NEW   4 tables + 2 MVs
│                                            (from eventstore/stores/clickhouse/*.ts)
│
└── migrations/                     ← EXISTS ClickHouse ALTER migrations
    ├── eval-retention-ttl-columns.ts
    └── add-cost-breakdown-to-eval-conversations.ts
```

### Target Execution — Single Init Path

```
                    ┌─────────────────────────┐
                    │     ArgoCD Deploy        │
                    └────────┬────────────────┘
                             │
              ┌──────────────┼──────────────────┐
              ▼              ▼                   ▼
    ┌─────────────────┐ ┌──────────┐    ┌───────────────┐
    │ PreSync Hook    │ │ Pod      │    │ Pod           │
    │ seed-migrate-ops│ │ pipeline │    │ runtime       │
    │                 │ │ -engine  │    │               │
    │ hookWeight -20: │ │          │    │               │
    │   MongoDB       │ │ Startup: │    │ Startup:      │
    │   migrations    │ │  No CH   │    │  No CH        │
    │                 │ │  init ✓  │    │  init ✓       │
    │ hookWeight -15: │ │          │    │               │
    │   ClickHouse ←──┤ │ • eval   │    │               │
    │   init (ALL     │ │   preflight   │               │
    │   56 tables) ✓  │ │   ↓      │    │               │
    │                 │ │ ✅ PASS!  │    │               │
    │ hookWeight -10: │ │ Tables   │    │               │
    │   MongoDB seed  │ │ exist    │    │               │
    └─────────────────┘ └──────────┘    └───────────────┘
```

---

## Execution Flow

### `cli.ts init` — Step by Step

```
tsx packages/database/src/clickhouse-schemas/cli.ts init

  ┌──────────────────────────────────────────────────────────────┐
  │ Step 1: CONNECT                                              │
  │   Connect to ClickHouse using CLICKHOUSE_URL                 │
  ├──────────────────────────────────────────────────────────────┤
  │ Step 2: CREATE DATABASE                                      │
  │   If REPLICATED=true and CLICKHOUSE_CLUSTER is set:          │
  │     CREATE DATABASE IF NOT EXISTS abl_platform               │
  │       ON CLUSTER '<cluster>'                                 │
  │   Else:                                                      │
  │     CREATE DATABASE IF NOT EXISTS abl_platform               │
  ├──────────────────────────────────────────────────────────────┤
  │ Step 3: RESOLVE TRANSFORM OPTIONS                            │
  │   Read env vars:                                             │
  │   ┌────────────────────────┬──────────┬─────────────────┐    │
  │   │ Env Var                │ Value    │ Effect           │    │
  │   ├────────────────────────┼──────────┼─────────────────┤    │
  │   │ CLICKHOUSE_REPLICATED  │ true     │ Keep Replicated* │    │
  │   │ CLICKHOUSE_REPLICATED  │ false    │ Strip Replicated*│    │
  │   │ CLICKHOUSE_TIERED_     │ true     │ Keep TO VOLUME   │    │
  │   │ STORAGE                │ false    │ Strip TO VOLUME  │    │
  │   │ CLICKHOUSE_DATABASE    │ custom   │ Replace db name  │    │
  │   │ CLICKHOUSE_CLUSTER     │ name     │ ON CLUSTER DDL   │    │
  │   └────────────────────────┴──────────┴─────────────────┘    │
  │                                                              │
  │   If REPLICATED=true:                                        │
  │     1. Verify Keeper is reachable                            │
  │        FAIL → ABORT with "Keeper not reachable" error        │
  │     2. Require CLICKHOUSE_CLUSTER is set                     │
  │        FAIL → ABORT with "CLICKHOUSE_CLUSTER required        │
  │        when REPLICATED=true" error                           │
  ├──────────────────────────────────────────────────────────────┤
  │ Step 3b: PREFLIGHT CHECKS (when REPLICATED=true)             │
  │                                                              │
  │ Database engine check:                                       │
  │   SELECT engine FROM system.databases                        │
  │   WHERE name = '<database>'                                  │
  │   → Must be 'Atomic' or 'Replicated'                        │
  │   → ABORT if 'Ordinary' or 'Lazy' (EXCHANGE not supported)  │
  │                                                              │
  │ ClickHouse version check:                                    │
  │   SELECT version() → require ≥ 21.8 (EXCHANGE TABLES)       │
  │                                                              │
  │ distributed_ddl_output_mode check:                           │
  │   Log current setting for operator awareness.                │
  │   Recommend 'throw' or 'throw_only_active' for fail-fast.   │
  ├──────────────────────────────────────────────────────────────┤
  │ Step 4: CREATE TABLES                                        │
  │   For each domain (core → analytics → eval → experiment →    │
  │   workflow):                                                 │
  │     1. Transform DDL (apply Replicated/tiered/db rules)      │
  │     2. If CLICKHOUSE_CLUSTER set:                            │
  │          CREATE TABLE IF NOT EXISTS ... ON CLUSTER '<cluster>'│
  │        Else:                                                 │
  │          CREATE TABLE IF NOT EXISTS                           │
  │   ON CLUSTER propagates DDL to all replicas via              │
  │   distributed_ddl queue (Keeper-coordinated).                │
  │   NOT atomic across hosts — eventually consistent.           │
  │   Order: data tables → projection targets (before MVs)       │
  │   Total: ~56 tables                                          │
  │                                                              │
  │   Post-create verification (when CLICKHOUSE_CLUSTER set):    │
  │   For each table, verify it exists on all replicas:          │
  │     SELECT hostName(), count()                               │
  │     FROM clusterAllReplicas('<cluster>', system.tables)       │
  │     WHERE database='<db>' AND name='<table>'                 │
  │     GROUP BY hostName()                                      │
  │   Retry up to 3x with 10s delay if any replica is missing.  │
  │   ABORT if verification fails after retries.                 │
  ├──────────────────────────────────────────────────────────────┤
  │ Step 5: ALTER MIGRATIONS (BEFORE engine reconciliation)      │
  │   ADD COLUMN IF NOT EXISTS  (missing columns)                │
  │   ADD INDEX IF NOT EXISTS   (missing indexes)                │
  │   (ON CLUSTER if set)                                        │
  │                                                              │
  │   CRITICAL: ALTERs run BEFORE engine reconciliation so that  │
  │   the INSERT INTO _new SELECT <explicit column list> has     │
  │   all columns available on the source table. Without this,   │
  │   older envs with missing columns would fail the copy.       │
  ├──────────────────────────────────────────────────────────────┤
  │ Step 6: RECONCILE ENGINES (requires lock)                    │
  │   Query system.tables for actual engines                     │
  │   Compare against desired (post-transform) engines           │
  │   (normalize engine strings: ReplacingMergeTree() == bare)   │
  │   For each drift (UPGRADE only, never downgrade):            │
  │     ┌─────────────────────────────────────────────┐          │
  │     │ Shadow-Copy Migration                       │          │
  │     │                                             │          │
  │     │ 0. Drop stale <table>_new if exists          │          │
  │     │ 1. Check size — skip if > 10 GiB (log warn) │          │
  │     │ 2. CREATE <table>_new (correct engine)      │          │
  │     │ 3. INSERT INTO _new                         │          │
  │     │    SELECT <explicit column list>             │          │
  │     │    FROM <table>                              │          │
  │     │    (explicit columns, NOT SELECT *)          │          │
  │     │ 4. Verify (see Verification section below)  │          │
  │     │ 5a. Match →                                 │          │
  │     │     EXCHANGE TABLES <table> AND <table>_new  │          │
  │     │     Then: RENAME TABLE <table>_new           │          │
  │     │           TO <table>_old_YYYYMMDD            │          │
  │     │ 5b. Mismatch → DROP _new, log error         │          │
  │     │     (active writes detected, needs manual)  │          │
  │     └─────────────────────────────────────────────┘          │
  │   Clean up _old tables > 7 days                              │
  │   Skip: unmanaged tables (structured_data_*, traces, etc.)   │
  │   Skip: downgrades (Replicated* → non-replicated)            │
  │                                                              │
  │   ON CLUSTER behavior for distributed DDL:                   │
  │   - ON CLUSTER is NOT atomically applied across hosts.       │
  │     It enqueues DDL into Keeper's distributed_ddl queue      │
  │     and each host executes independently.                    │
  │   - After each ON CLUSTER DDL, verify convergence on all     │
  │     replicas before proceeding to the next step.             │
  │   - If any host fails to converge within timeout (60s),      │
  │     ABORT the migration for that table.                      │
  │                                                              │
  │   Post-EXCHANGE verification (when CLICKHOUSE_CLUSTER set):  │
  │   Verify the swapped table exists with correct engine on     │
  │   all replicas via clusterAllReplicas(system.tables).        │
  ├──────────────────────────────────────────────────────────────┤
  │ Step 7: MATERIALIZED VIEWS (requires lock)                   │
  │   For each MV:                                               │
  │     1. Hash desired DDL vs current definition                │
  │        (from SHOW CREATE VIEW)                               │
  │     2. If unchanged AND source table engine unchanged        │
  │        → skip (no drop/recreate needed)                      │
  │     3. If missing → CREATE MATERIALIZED VIEW                 │
  │        (ON CLUSTER if set, no drop needed)                   │
  │     4. If changed OR source table was engine-migrated:       │
  │        ┌────────────────────────────────────────────┐        │
  │        │ CLICKHOUSE_ALLOW_MV_RECREATE=true set?    │        │
  │        │   YES → DROP VIEW + CREATE MATERIALIZED    │        │
  │        │         VIEW (ON CLUSTER if set)            │        │
  │        │         Log: "MV <name> recreated"          │        │
  │        │   NO  → Log WARNING: "MV <name> requires   │        │
  │        │         recreation (definition changed or   │        │
  │        │         source table engine migrated) but   │        │
  │        │         ALLOW_MV_RECREATE not set. Set it   │        │
  │        │         =true during maintenance window."   │        │
  │        └────────────────────────────────────────────┘        │
  │                                                              │
  │   WHY MVs must be recreated after engine migration:          │
  │   ClickHouse MVs are insert triggers attached to the         │
  │   source table's internal object. EXCHANGE TABLES swaps      │
  │   the table object — the MV may remain attached to the       │
  │   old (now _old) object. Recreating the MV re-attaches       │
  │   it to the new table object. This must be tested against    │
  │   the deployed ClickHouse version during Phase 3 rollout.    │
  │                                                              │
  │   MV drop+create has a brief gap where inserts miss MV       │
  │   processing. For production, set ALLOW_MV_RECREATE=true     │
  │   only during maintenance window with writers paused.        │
  │   Unchanged MVs with unchanged source tables are never       │
  │   touched — zero risk.                                       │
  ├──────────────────────────────────────────────────────────────┤
  │ Step 8: LOG SUMMARY                                          │
  │   Tables created, drifts detected, migrations applied        │
  └──────────────────────────────────────────────────────────────┘
```

---

## DDL Transformer

### Canonical Form

All DDL is authored with `Replicated*` engines as the source of truth:

```sql
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.<table>', '{replica}')
```

### Transformation Rules

```
                   DDL authored with Replicated*
                              │
                  ┌───────────┴───────────┐
                  ▼                       ▼
         REPLICATED=true          REPLICATED=false
                  │                       │
                  ▼                       ▼
    ┌─────────────────────────┐  ┌──────────────────────────┐
    │ Keep as-is:             │  │ Transform:                │
    │ ReplicatedMergeTree     │  │ → MergeTree()             │
    │ ReplicatedReplacing     │  │ → ReplacingMergeTree(ver) │
    │   MergeTree(ver)        │  │   (version arg preserved) │
    │ ReplicatedAggregating   │  │ → AggregatingMergeTree()  │
    │   MergeTree()           │  │                           │
    │ ReplicatedSumming       │  │ → SummingMergeTree()      │
    │   MergeTree()           │  │                           │
    └─────────────────────────┘  └──────────────────────────┘

    Never transformed (always kept as-is):
    ┌─────────────────────────────────────┐
    │ ReplacingMergeTree    (no Replicated│
    │   (ver)                prefix = by  │
    │                        design)      │
    └─────────────────────────────────────┘

    NOTE: MV destination tables (AggregatingMergeTree, SummingMergeTree)
    ARE replicated when REPLICATED=true. In a multi-replica cluster,
    MVs trigger only on the insert-receiving replica. Non-replicated
    MV destinations would diverge between replicas. Using Replicated*
    variants ensures consistent aggregate data for HA query routing.
```

| Condition                         | Transformation                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `CLICKHOUSE_REPLICATED=false`     | `ReplicatedMergeTree(...)` → `MergeTree()`                                              |
| `CLICKHOUSE_REPLICATED=false`     | `ReplicatedReplacingMergeTree(...)` → `ReplacingMergeTree(...)` (preserves version arg) |
| `CLICKHOUSE_TIERED_STORAGE=false` | Strip `TO VOLUME` clauses and `storage_policy` setting                                  |
| Custom database name              | Replace `abl_platform.` with resolved name                                              |

---

## Engine Reconciler

### Drift Direction Awareness

The reconciler distinguishes between **upgrades** (non-replicated → replicated) and **downgrades** (replicated → non-replicated):

```
                CLICKHOUSE_REPLICATED=true
                ┌──────────────────────────────────────┐
                │ Actual: MergeTree                    │
                │ Desired: ReplicatedMergeTree         │
                │ Direction: UPGRADE ✓                 │
                │ Action: shadow-copy migrate          │
                └──────────────────────────────────────┘

                CLICKHOUSE_REPLICATED=false
                ┌──────────────────────────────────────┐
                │ Actual: ReplicatedMergeTree          │
                │ Desired: MergeTree                   │
                │ Direction: DOWNGRADE ⚠️               │
                │ Action: LOG WARNING ONLY, never auto │
                │                                      │
                │ ⚠️  IMPORTANT: ReplicatedMergeTree    │
                │ tables REQUIRE Keeper to remain       │
                │ configured and reachable, even when   │
                │ CLICKHOUSE_REPLICATED=false. Keeper   │
                │ is used for replication logs, block   │
                │ numbers, merges, and mutations —      │
                │ not just data replication.            │
                │                                      │
                │ If Keeper is removed/unreachable,     │
                │ existing Replicated* tables will fail │
                │ on inserts. This requires manual      │
                │ downgrade (recreate as non-replicated)│
                │ BEFORE removing Keeper.               │
                └──────────────────────────────────────┘
```

**Rule: The reconciler only performs upgrades, never downgrades.** Downgrading from `Replicated*` to non-replicated removes HA protection and is never automatic. If the flag is flipped back to `false`, existing `Replicated*` tables continue to work — they just don't replicate to other nodes (which don't exist in a non-replicated setup anyway). The reconciler logs a warning so operators are aware of the mismatch.

### Keeper Availability Check

Before attempting any `Replicated*` table creation or engine migration, the reconciler verifies Keeper is reachable:

```
CLICKHOUSE_REPLICATED=true
        │
        ▼
  ┌─────────────────────────────┐
  │ SELECT count() FROM         │
  │ system.zookeeper            │
  │ WHERE path = '/'            │
  │ SETTINGS max_execution_time │
  │ = 3                         │
  └──────────┬──────────────────┘
             │
     ┌───────┴───────┐
     ▼               ▼
   SUCCESS         FAILURE
     │               │
     ▼               ▼
  Proceed      ┌──────────────────────┐
  with         │ ABORT with clear     │
  Replicated*  │ error:               │
  tables       │ "CLICKHOUSE_REPLICATED│
               │ =true but Keeper is   │
               │ not reachable. Cannot │
               │ create/migrate to     │
               │ Replicated* engines.  │
               │ Fix Keeper or set     │
               │ CLICKHOUSE_REPLICATED │
               │ =false."              │
               └──────────────────────┘
```

This prevents partial failures where some tables are created as `Replicated*` and others fail mid-init.

### Drift Detection Flow

```
┌────────────────────────┐     ┌────────────────────────┐
│   Desired State        │     │   Actual State         │
│   (from DDL after      │     │   (from system.tables) │
│    transform)          │     │                        │
│                        │     │                        │
│ messages:              │     │ messages:              │
│   ReplicatedMergeTree  │     │   MergeTree            │ ← DRIFT!
│ platform_events:       │     │ platform_events:       │
│   ReplicatedMergeTree  │     │   MergeTree            │ ← DRIFT!
│ eval_conversations:    │     │ eval_conversations:    │
│   ReplicatedMergeTree  │     │   MergeTree            │ ← DRIFT!
│ llm_metrics_hourly_    │     │ llm_metrics_hourly_    │
│   dest:                │     │   dest:                │
│   ReplicatedAggregating│     │   AggregatingMergeTree │ ← DRIFT!
│     MergeTree          │     │                        │
│ facts:                 │     │ facts:                 │
│   ReplacingMergeTree   │     │   ReplacingMergeTree   │ ← SKIP (non-replicated by design)
└────────────────────────┘     └────────────────────────┘
```

### Shadow-Copy Migration (Per Drifted Table)

```
Step 0: PRE-FLIGHT
  ┌─────────────────────────────────────────────────────────┐
  │ Is this a DOWNGRADE (Replicated* → non-replicated)?     │
  │   YES → LOG WARNING, skip this table                    │
  │   NO  → continue                                       │
  ├─────────────────────────────────────────────────────────┤
  │ Does <table>_new already exist (stale from prev run)?   │
  │   YES → DROP TABLE <table>_new (ON CLUSTER if set)      │
  ├─────────────────────────────────────────────────────────┤
  │ Is table > 10 GiB?                                      │
  │   YES → LOG WARNING "too large for auto-migration,      │
  │          schedule maintenance window", skip              │
  │   NO  → continue                                       │
  ├─────────────────────────────────────────────────────────┤
  │ MANAGED INVENTORY CHECK                                 │
  │ (once per init run when CLICKHOUSE_CLUSTER is set)       │
  │                                                         │
  │ Query every replica's managed table inventory:           │
  │   SELECT name, groupArray(hostName()) AS hosts,          │
  │          groupArray(engine) AS engines                   │
  │   FROM clusterAllReplicas('<cluster>', system.tables)    │
  │   WHERE database = '<db>'                                │
  │     AND name IN (<managed table + MV names>)             │
  │   GROUP BY name                                          │
  │   HAVING length(hosts) != <replica_count>                │
  │      OR length(arrayDistinct(engines)) != 1              │
  │                                                         │
  │ Any rows returned?                                       │
  │   YES → ABORT all engine migration. Table/MV inventory   │
  │         is inconsistent across replicas. Run init/status │
  │         in dry-run, repair missing managed objects, then │
  │         retry migration.                                 │
  │   NO  → proceed to per-table checks.                     │
  │                                                         │
  │ Ignore unmanaged objects: structured_data_*, traces,     │
  │ table_metadata, .inner_id.*, and *_backup_* artifacts.   │
  ├─────────────────────────────────────────────────────────┤
  │ MULTI-REPLICA DIVERGENCE CHECK                          │
  │ (only when CLICKHOUSE_CLUSTER is set AND table is       │
  │  currently non-replicated)                              │
  │                                                         │
  │ Part metadata consistency check across replicas:         │
  │   SELECT                                                │
  │     hostName() AS host,                                 │
  │     sum(rows) AS row_count,                             │
  │     sum(bytes_on_disk) AS bytes,                        │
  │     groupArraySorted(partition_id) AS partitions        │
  │   FROM clusterAllReplicas('<cluster>',                   │
  │     system.parts)                                       │
  │   WHERE database = '<db>'                               │
  │     AND table = '<table>'                               │
  │     AND active = 1                                      │
  │   GROUP BY host                                         │
  │                                                         │
  │ All replicas have same row_count, bytes, partitions?    │
  │   YES → safe to migrate from any replica                │
  │   NO  → ABORT this table with error:                    │
  │     "Table <table> has divergent part metadata across   │
  │      replicas:                                          │
  │      replica-0: N rows, X bytes, P partitions           │
  │      replica-1: M rows, Y bytes, Q partitions           │
  │      Manual consolidation required before migration.    │
  │      See docs for consolidation procedure."             │
  └─────────────────────────────────────────────────────────┘

REPLICATION PATH STRATEGY:
  The _new table is created with the FINAL table's intended
  Keeper path, NOT a _new-suffixed path:

    CREATE TABLE messages_new ON CLUSTER ...
    ENGINE = ReplicatedMergeTree(
      '/clickhouse/tables/{shard}/abl_platform.messages',
      '{replica}'          ← uses "messages" path, not "messages_new"
    )

  This works because the old non-replicated "messages" table
  has no Keeper path (it's plain MergeTree). So the final
  path is available for _new immediately. After EXCHANGE,
  the logical "messages" table has the correct Keeper path.

  If the old table IS already Replicated (rare — indicates a
  previous migration was only partially completed):
    → SKIP this table entirely
    → Log ERROR: "Table <table> is already Replicated* but
      doesn't match desired engine. This indicates a partial
      previous migration. Manual recovery required:
      1. Identify the correct table version (_old backup or current)
      2. DROP the incorrect version
      3. If needed, recreate with correct Keeper path:
         CREATE TABLE <table> ...
         ENGINE = ReplicatedMergeTree(
           '/clickhouse/tables/{shard}/abl_platform.<table>',
           '{replica}')
      4. Re-insert data from backup if necessary
      5. Re-run cli.ts init"
    → Do NOT attempt automated path manipulation.
      Keeper path conflicts can cause data loss if
      mishandled. This is an operator-level recovery.

Step 1                    Step 1b                   Step 2
CREATE TABLE              VERIFY _new EXISTS        INSERT INTO
messages_new              ON ALL REPLICAS           messages_new
  ON CLUSTER (if set)                               SELECT * FROM
ENGINE=Replicated         SELECT hostName(),        messages
MergeTree(                  count()
  '.../messages',         FROM clusterAllReplicas(  (runs LOCAL, not
  '{replica}')              '<cluster>',             ON CLUSTER — data
  ← uses final path,       system.tables)           copy runs once on the
    not _new path!        WHERE database='<db>'     executing node. The
                            AND name='messages_new' Replicated* engine
                          GROUP BY hostName()       handles replication
                                                   to other nodes)
                          All replicas show 1?
                            YES → proceed
                            NO → wait 10s, retry
                              3x, then ABORT

                                                   Step 3: VERIFY
                                                   Multi-level check:
                                                   a) count() match
                                                   b) per-partition
                                                      row count match
                                                   c) no active
                                                      mutations/merges
                                                      on source
                                                   d) no TTL deletes
                                                      in progress

Step 3b: SYNC REPLICATION (when CLICKHOUSE_CLUSTER set)
  ┌─────────────────────────────────────────────────────────┐
  │ For each replica in the cluster, run:                    │
  │   SELECT hostName()                                     │
  │   FROM clusterAllReplicas('<cluster>',                   │
  │     system.one)                                         │
  │ → get list of replica hosts.                            │
  │                                                         │
  │ Then on EACH replica (via direct sequential connection    │
  │ to each replica host):                                  │
  │   SYSTEM SYNC REPLICA <db>.messages_new                 │
  │                                                         │
  │ This ensures every replica has finished applying the    │
  │ replication queue for _new. SYSTEM SYNC REPLICA is a    │
  │ local-only command — it must run on each node.          │
  │                                                         │
  │ Timeout: 300 seconds per replica. If any timeout:       │
  │   → ABORT, DROP _new ON CLUSTER, log error:             │
  │   "Replication sync timed out on <hostname> for          │
  │    messages_new. Check Keeper and replica health."       │
  │                                                         │
  │ Then verify row count on ALL replicas:                   │
  │   SELECT hostName(), count()                            │
  │   FROM clusterAllReplicas('<cluster>',                   │
  │     '<db>.messages_new')                                │
  │   GROUP BY hostName()                                   │
  │                                                         │
  │ All counts match source count? → proceed to EXCHANGE    │
  │ Mismatch? → ABORT, DROP _new ON CLUSTER                 │
  └─────────────────────────────────────────────────────────┘

                                              ┌────────────┐
                                              │            │
                                           MATCH       MISMATCH
                                              │            │
                                              ▼            ▼
                                        ┌──────────┐ ┌──────────┐
Step 4: EXCHANGE                        │ EXCHANGE │ │ DROP     │
                                        │ TABLES   │ │ _new     │
  EXCHANGE TABLES                       │ ON CLSTR │ │ ON CLSTR │
    messages AND messages_new           │ (atomic) │ │ Log error│
    ON CLUSTER (if set)                 └──────────┘ │ Original │
  (truly atomic — single operation,                  │ untouched│
   propagated to all replicas via DDL queue)         └──────────┘

  Then rename the displaced old table:
    RENAME TABLE messages_new
      TO messages_old_20260520
      ON CLUSTER (if set)

CLUSTER-WIDE DDL RULES:
  • CREATE TABLE _new        → ON CLUSTER (metadata on all replicas)
  • INSERT INTO _new         → LOCAL ONLY (Replicated* engine handles
                                cross-replica replication via Keeper)
  • SYSTEM SYNC REPLICA _new → wait for replication to all replicas
  • verify count on all replicas via clusterAllReplicas()
  • EXCHANGE TABLES          → ON CLUSTER (atomic swap on all replicas)
  • RENAME TABLE _old        → ON CLUSTER (metadata rename on all replicas)
  • DROP TABLE _new (abort)  → ON CLUSTER (cleanup on all replicas)

Step 5: CLEANUP (separate pass)

  Find _old tables > 7 days → DROP ... ON CLUSTER (if set)

NOTE: Row count mismatch during active writes is expected
and safe — the verification catches it, aborts cleanly,
and the table stays unchanged. Large or actively-written
tables should be migrated during a maintenance window
with writer pods scaled to 0.
```

### Reconciler Exclusions

```
Tables reconciled (engine drift → shadow-copy):
  ✓ MergeTree              → ReplicatedMergeTree
  ✓ ReplacingMergeTree     → ReplicatedReplacingMergeTree
  ✓ AggregatingMergeTree   → ReplicatedAggregatingMergeTree
  ✓ SummingMergeTree       → ReplicatedSummingMergeTree

Tables always skipped:
  ✗ structured_data_*      — dynamic, created by search-ai
  ✗ traces / table_metadata — created by search-ai
  ✗ facts                  — intentionally non-replicated (no Replicated prefix in DDL)
```

---

## Helm Hook Changes

### Before

```
PreSync Hook Order:
──────────────────────────────────────────────────────────────────
hookWeight -20 │ tsx packages/database/src/migrations/cli.ts migrate
               │   → MongoDB migrations
               │
hookWeight -10 │ tsx packages/database/seed-mongo.ts
               │   → MongoDB seed + maybeInitClickHouseSchema()
               │     (only core 27 tables!)
──────────────────────────────────────────────────────────────────
```

### After

```
PreSync Hook Order:
──────────────────────────────────────────────────────────────────
hookWeight -20 │ tsx packages/database/src/migrations/cli.ts migrate
               │   → MongoDB migrations
               │
hookWeight -15 │ tsx packages/database/src/clickhouse-schemas/cli.ts init    ← NEW
               │   → ALL ClickHouse tables (56 tables, all domains)
               │   → Engine reconciliation
               │   → Column/index migrations
               │   → Materialized views
               │
hookWeight -10 │ tsx packages/database/seed-mongo.ts
               │   → MongoDB seed only (no more ClickHouse!)
──────────────────────────────────────────────────────────────────
```

---

## Code Changes

### Files Deleted (DDL moves to `packages/database`)

```
DELETED                                                    MOVED TO
─────────────────────────────────────────────────────────────────────────────
pipeline-engine/src/pipeline/schemas/                      database/src/clickhouse-schemas/
  init-analytics-tables.ts  ─────────────────────────────→   tables/analytics.ts
  init-eval-tables.ts  ──────────────────────────────────→   tables/eval.ts
  init-experiment-tables.ts  ────────────────────────────→   tables/experiment.ts

eventstore/src/stores/clickhouse/
  init-workflow-event-tables.ts  ────────────────────────→   tables/workflow.ts
  workflow-execution-events-table.ts  ───────────────────→   tables/workflow.ts
  human-task-events-table.ts  ──────────────────────────→   tables/workflow.ts
```

### Files Modified

```
MODIFIED                                          CHANGE
───────────────────────────────────────────────────────────────────────
pipeline-engine/src/pipeline/server.ts            Remove: initClickHouseSchema()
                                                          initAnalyticsTables()
                                                          initEvalTables()
                                                          initExperimentTables()

runtime/src/server.ts                             Remove: initClickHouseSchema()
                                                          initWorkflowEventTables()

database/seed-mongo.ts                            Remove: maybeInitClickHouseSchema()

ADDITIONAL DDL CALLERS TO AUDIT AND REMOVE/REPLACE:
  (These files call ClickHouse schema init or create tables
   outside the centralized init path. Each must be either
   removed or replaced with a read-only readiness check.)

apps/search-ai/src/server.ts                      Audit: CH init at startup
apps/search-ai-runtime/src/server.ts              Audit: CH init at startup
apps/runtime/src/services/voice/                   Audit: lazy CH table creation
  voice-turn-coordinator.ts
apps/runtime/src/websocket/sdk-handler.ts          Audit: lazy CH metrics init
packages/database/seed-pipelines.ts                Audit: CH schema calls

database/src/clickhouse-schemas/init.ts           Refactor: use ddl-transform.ts
                                                           use resolveClickHouseDatabaseName()

pipeline-engine/src/pipeline/services/            Change probe query:
  eval/eval-preflight.ts                            FROM: SELECT 1 FROM abl_platform.eval_conversations
                                                    TO:   SELECT 1

eventstore/src/stores/clickhouse/index.ts         Remove: initWorkflowEventTables re-export
```

### Files Created

```
NEW FILE                                          PURPOSE
───────────────────────────────────────────────────────────────────────
database/src/clickhouse-schemas/cli.ts            CLI entrypoint (init, status)
database/src/clickhouse-schemas/init-all.ts       Orchestrator function
database/src/clickhouse-schemas/ddl-transform.ts  DDL transformer
database/src/clickhouse-schemas/engine-reconciler.ts  Drift detection + migration
database/src/clickhouse-schemas/tables/analytics.ts   Analytics DDL (21 tables)
database/src/clickhouse-schemas/tables/eval.ts        Eval DDL (3 tables)
database/src/clickhouse-schemas/tables/experiment.ts  Experiment DDL (1 table)
database/src/clickhouse-schemas/tables/workflow.ts    Workflow DDL (4 tables)
```

### Imports That Need Updating

After moving DDL files, update imports in:

- `pipeline-engine/src/__tests__/init-eval-tables-retention.test.ts`
- `pipeline-engine/src/pipeline/services/eval/eval-retention-cleanup.ts`
- Any test importing DDL constants from old locations
- `eventstore/src/stores/clickhouse/index.ts` — remove `initWorkflowEventTables` re-export

---

## Replication Rules

### Engine Decision Matrix

```
DDL Engine                              REPLICATED=true         REPLICATED=false
──────────────────────────────────────────────────────────────────────────────
ReplicatedMergeTree(path, replica)      Kept as-is              → MergeTree()
ReplicatedReplacingMergeTree(           Kept as-is              → ReplacingMergeTree(ver)
  path, replica, ver)                                             (version arg preserved)
ReplicatedAggregatingMergeTree()        Kept as-is              → AggregatingMergeTree()
ReplicatedSummingMergeTree()           Kept as-is              → SummingMergeTree()
ReplacingMergeTree(ver)                 Kept (intentionally     Kept
  (no Replicated prefix)                 non-replicated)
```

### Table Inventory by Engine Type

```
REPLICATED (when CLICKHOUSE_REPLICATED=true):

  ReplicatedMergeTree (27 core + 8 satellite = 35 tables):
    Core:     messages, llm_metrics, logs, platform_events, search_queries,
              search_ingestion_events, dead_letter_events, audit_events,
              kms_audit_log, pii_audit_log, connector_audit_log,
              crawl_audit_events, arch_audit_log, arch_audit_payloads,
              omnichannel_audit_log, custom_pipeline_results,
              spatial_trace_records, insight_results, feedback,
              facet_interactions
    Eval:     eval_conversations, eval_scores, eval_production_scores
    Workflow: workflow_execution_events, human_task_events

  ReplicatedReplacingMergeTree (4 core + 23 satellite = 27 tables):
    Core:     platform_events_by_session, entity_instances
    Experiment: experiment_assignments
    Analytics: message_sentiment, conversation_sentiment,
              intent_classifications, quality_evaluations, custom_events,
              conversation_tags, external_events, hallucination_evaluations,
              knowledge_gap_evaluations, guardrail_evaluations,
              context_evaluations, friction_detections, anomaly_detections,
              drift_detections, customer_predictive_features,
              churn_risk_scores, conversation_mentions,
              conversation_outcomes, goal_completions, toxicity_evaluations,
              message_toxicity, llm_evaluate
    Workflow: workflow_executions_latest, human_tasks_latest

  ReplicatedAggregatingMergeTree (6 MV destination tables):
    llm_metrics_hourly_dest, llm_metrics_daily_dest,
    platform_events_agent_hourly_dest, platform_events_tool_daily_dest,
    platform_events_error_hourly_dest, platform_events_voice_hourly_dest

  ReplicatedSummingMergeTree (6 MV destination tables):
    mv_daily_sentiment, mv_daily_intent_distribution,
    mv_daily_quality_scores, mv_daily_custom_events,
    mv_daily_outcomes, mv_daily_llm_evaluate

INTENTIONALLY NON-REPLICATED:

  ReplacingMergeTree (1 table):
    facts (global key-value store, no Replicated prefix in DDL)

NOT MANAGED (dynamic/external):
    structured_data_* (search-ai runtime), traces, table_metadata
```

---

## Safety Guarantees

```
┌────────────────────────────────────────────────────────────────────┐
│ SAFETY INVARIANTS                                                  │
│                                                                    │
│ 1. DATA INTEGRITY VERIFICATION                                    │
│    Shadow-copy verifies partition-level row count + byte size      │
│    + active mutation/TTL state before cutover. Writer pause is     │
│    mandatory for tables with active writes (row count mismatch     │
│    = abort). _old backup retained 7 days for manual recovery.     │
│    Failed verification = _new dropped, original untouched.         │
│                                                                    │
│ 2. IDEMPOTENT                                                      │
│    Running `init` N times is always safe.                          │
│    No drift = no action. CREATE TABLE IF NOT EXISTS = no-op.       │
│                                                                    │
│ 3. BACKWARD COMPATIBLE                                             │
│    Existing non-replicated tables continue to work.                │
│    Engine migration only when REPLICATED=true AND drift exists.    │
│                                                                    │
│ 4. BACKUP RETENTION                                                │
│    _old_YYYYMMDD tables kept 7 days for manual recovery.           │
│                                                                    │
│ 5. ATOMIC CUTOVER (per-host)                                       │
│    EXCHANGE TABLES = atomic name swap per host.                    │
│    ON CLUSTER = eventually consistent across hosts.                │
│    Post-DDL verification confirms convergence on all replicas.     │
│                                                                    │
│ 6. NO SERVICE-LEVEL INIT                                           │
│    pipeline-engine and runtime never run DDL.                      │
│    PreSync hook is the single source of truth.                     │
│    Local dev: same CLI command, run manually.                      │
└────────────────────────────────────────────────────────────────────┘
```

---

## Environment Configuration

| Env Var                        | Values           | Default        | Purpose                                                                                                                                                                                     |
| ------------------------------ | ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLICKHOUSE_URL`               | URL              | —              | ClickHouse connection                                                                                                                                                                       |
| `CLICKHOUSE_DATABASE`          | identifier       | `abl_platform` | Database name                                                                                                                                                                               |
| `CLICKHOUSE_REPLICATED`        | `true`/`false`   | `false`        | Use `Replicated*` engines                                                                                                                                                                   |
| `CLICKHOUSE_CLUSTER`           | cluster name     | —              | Required when `REPLICATED=true`. Used for `ON CLUSTER` DDL propagation. Must match `remote_servers` cluster name in ClickHouse config (`default_cluster` for staging, `main` for SIT/prod). |
| `CLICKHOUSE_TIERED_STORAGE`    | `true`/`false`   | `false`        | Use warm/cold volume TTL                                                                                                                                                                    |
| `CLICKHOUSE_ENGINE_MIGRATION`  | `execute`/absent | absent         | Gate for engine drift migration                                                                                                                                                             |
| `CLICKHOUSE_ALLOW_MV_RECREATE` | `true`/absent    | absent         | Gate for MV definition recreation. Required when MV DDL changes. Set during maintenance window with writers paused.                                                                         |

### Recommended Configurations

```yaml
# ── Non-replicated (dev, QA, local docker-compose) ──
CLICKHOUSE_REPLICATED: "false"
# CLICKHOUSE_CLUSTER: not set
# CLICKHOUSE_ENGINE_MIGRATION: not set

# ── Replicated, staging dry-run target ──
CLICKHOUSE_REPLICATED: "true"
CLICKHOUSE_CLUSTER: "default_cluster"
CLICKHOUSE_ENGINE_MIGRATION: not set
# ON CLUSTER propagates DDL to all replicas via Keeper.

# ── Replicated, staging approved migration window only ──
CLICKHOUSE_REPLICATED: "true"
CLICKHOUSE_CLUSTER: "default_cluster"
CLICKHOUSE_ENGINE_MIGRATION: "execute"

# ── Already replicated (SIT, production; operator-managed ClickHouse) ──
CLICKHOUSE_REPLICATED: "true"
CLICKHOUSE_CLUSTER: "main"
CLICKHOUSE_ENGINE_MIGRATION: not set    # default; use status first

# ── Replicated with tiered storage (production only if configured) ──
CLICKHOUSE_REPLICATED: "true"
CLICKHOUSE_CLUSTER: "main"
CLICKHOUSE_TIERED_STORAGE: "true"
CLICKHOUSE_ENGINE_MIGRATION: not set
```

---

## CLI Commands

```bash
# Initialize all tables, apply ALTERs, reconcile engines, recreate MVs
# This is the WRITE path — it creates tables and runs ALTERs.
# Engine migration only runs when CLICKHOUSE_ENGINE_MIGRATION=execute.
# MV recreation only runs when CLICKHOUSE_ALLOW_MV_RECREATE=true.
tsx packages/database/src/clickhouse-schemas/cli.ts init

# Read-only drift report — NO DDL executed, safe to run anytime
# Queries system.tables and compares against desired state.
tsx packages/database/src/clickhouse-schemas/cli.ts status
```

### Example `status` Output

```
ClickHouse Schema Status (abl_platform)
═══════════════════════════════════════
Environment:
  CLICKHOUSE_REPLICATED:      true
  CLICKHOUSE_TIERED_STORAGE:  false
  CLICKHOUSE_ENGINE_MIGRATION: execute

Tables: 56 managed, 23 dynamic (structured_data_*)

Engine Drift Report:
  ✓ messages                    ReplicatedMergeTree  (matches)
  ✗ eval_conversations          MergeTree → ReplicatedMergeTree  (DRIFT)
  ✗ message_sentiment           ReplacingMergeTree → ReplicatedReplacingMergeTree  (DRIFT)
  ✗ llm_metrics_hourly_dest     AggregatingMergeTree → ReplicatedAggregatingMergeTree  (DRIFT)
  ─ structured_data_abc123      MergeTree  (unmanaged)
  · facts                       ReplacingMergeTree  (intentionally non-replicated)

Summary: 42 OK, 14 drifted, 1 non-replicated by design, 23 unmanaged
```

---

## Edge Cases and Production Considerations

### 1. Schema Drift on Existing Tables

`CREATE TABLE IF NOT EXISTS` is a no-op when the table already exists — even if the DDL has new columns. This is the expected ClickHouse behavior. The solution is the existing ALTER migration pattern (`ADD COLUMN IF NOT EXISTS`).

**Action required during DDL centralization:** When moving satellite DDL into `tables/*.ts`, audit each table's current live schema against the DDL. Any columns present in the DDL but missing from older environments must have corresponding `ALTER TABLE ADD COLUMN IF NOT EXISTS` entries in the migrations section. The eval and experiment DDL files currently lack ALTER migration sections — these must be added.

```
Example: experiment_assignments
  DDL defines:      agent_version_id, assignment_mode, deployment_id
  Live table has:   (missing — created before those columns were added)
  Fix:              ADD COLUMN IF NOT EXISTS for each missing column
```

### 2. `ReplacingMergeTree` Version Arg Variations

Live tables show two forms:

- `ReplacingMergeTree(processed_at)` — with version column
- `ReplacingMergeTree` — bare, no version column

When the transformer strips `Replicated` from `ReplicatedReplacingMergeTree('/path', '{replica}')`, it produces `ReplacingMergeTree()` (empty parens). ClickHouse treats `ReplacingMergeTree()` and `ReplacingMergeTree` as identical, but the reconciler's engine comparison must normalize both forms when checking for drift.

```
Reconciler engine comparison (normalized):
  actual: "ReplacingMergeTree"      → normalized: "ReplacingMergeTree"
  actual: "ReplacingMergeTree()"    → normalized: "ReplacingMergeTree"
  desired: "ReplacingMergeTree()"   → normalized: "ReplacingMergeTree"
  Result: MATCH (no drift)
```

For `ReplicatedReplacingMergeTree('/path', '{replica}', processed_at)`, the regex must extract the version arg and produce `ReplacingMergeTree(processed_at)`.

### 3. Large Table Migration — Timeout and Active Writes

Tables like `platform_events` (2.5 GiB / 47M rows in dev, will be larger in production) require significant time for `INSERT INTO _new SELECT * FROM old`.

**Handling:**

```
Before migration, check table size:
  ┌─────────────────────────────────────────────────────────┐
  │ SELECT total_bytes FROM system.tables                   │
  │ WHERE database = '<db>' AND name = '<table>'            │
  └────────────────┬────────────────────────────────────────┘
                   │
           ┌───────┴───────┐
           ▼               ▼
     ≤ 10 GiB          > 10 GiB
           │               │
           ▼               ▼
     Proceed with    Log WARNING:
     shadow-copy     "Table X is Y GiB. Skipping
                      auto-migration. Run manual
                      migration during maintenance
                      window."
```

**Active writes during migration:** If the source table receives inserts during the `INSERT INTO _new SELECT * FROM old`, the row count verification will detect the mismatch (`_new` has fewer rows than `old`) and abort safely. This is the correct behavior — it means the table is too active for online migration.

**For actively-written large tables**, the recommended approach is:

1. Run `cli.ts status` to identify drifted tables
2. Schedule a maintenance window
3. Temporarily stop writer pods (scale pipeline-engine/runtime to 0)
4. Run `cli.ts init` (migration proceeds with no active writes)
5. Scale pods back up

**Stale `_new` cleanup:** If a previous migration attempt left a dangling `_new` table (from timeout/crash), the reconciler detects it before starting:

```
Before migration of table X:
  1. Check if X_new already exists
  2. If yes: DROP TABLE X_new (leftover from failed previous attempt)
  3. Proceed with fresh shadow-copy
```

### 4. DDL vs Live Engine Mismatches (Stale DDL)

Some tables in live clusters have different engines than their DDL source files:

- `experiment_assignments`: DDL says `MergeTree`, live is `ReplacingMergeTree`
- Various tables may have been manually altered

**Rule:** When centralizing DDL, the **live table schema is the source of truth** for existing deployments. The DDL must match what's deployed. If the DDL has diverged from live, update the DDL to match the live schema, then add any desired changes as ALTER migrations.

### 5. MV Recreation After Engine Migration

Materialized views reference source tables by name. After a shadow-copy migration (the table name doesn't change, only the engine), MVs continue to work because:

- The MV references `FROM abl_platform.platform_events` by name
- The `EXCHANGE TABLES` swaps the underlying table atomically
- New inserts to the (now-replicated) table flow through the MV normally

However, MVs must still be dropped and recreated to ensure their internal metadata is consistent with the new engine. The init flow handles this in Step 7 (after engine reconciliation).

### 6. Rollback Procedure (Manual)

If a migrated table has issues after cutover, the `_old_YYYYMMDD` backup enables immediate manual rollback via ClickHouse client:

**Single-node (non-replicated):**

```sql
-- 1. Find the backup
SELECT name FROM system.tables
WHERE database = 'abl_platform' AND name LIKE 'messages_old_%';
-- → messages_old_20260520

-- 2. Atomic swap back
EXCHANGE TABLES
    abl_platform.messages AND abl_platform.messages_old_20260520;

-- 3. Verify
SELECT count() FROM abl_platform.messages;

-- 4. Clean up failed version when ready
RENAME TABLE abl_platform.messages_old_20260520
    TO abl_platform.messages_failed_20260520;
-- DROP TABLE abl_platform.messages_failed_20260520;
```

**Multi-replica (replicated) — use ON CLUSTER:**

```sql
-- 1. Find the backup
SELECT name FROM system.tables
WHERE database = 'abl_platform' AND name LIKE 'messages_old_%';
-- → messages_old_20260520

-- 2. Atomic swap back ON CLUSTER (propagates to all replicas)
-- Replace <cluster> with the env-specific value:
--   staging: default_cluster
--   sit/prod: main
EXCHANGE TABLES
    abl_platform.messages AND abl_platform.messages_old_20260520
    ON CLUSTER '<cluster>';

-- 3. Verify on all replicas
SELECT hostName(), count()
FROM clusterAllReplicas('<cluster>', 'abl_platform.messages')
GROUP BY hostName();

-- 4. Clean up failed version when ready
RENAME TABLE abl_platform.messages_old_20260520
    TO abl_platform.messages_failed_20260520
    ON CLUSTER '<cluster>';
-- DROP TABLE abl_platform.messages_failed_20260520
--     ON CLUSTER '<cluster>';
```

The 7-day `_old` retention gives a week to detect issues before backups are auto-cleaned.

### 7. Concurrency Protection

Multiple PreSync jobs or parallel pod restarts could run `cli.ts init` concurrently. The engine reconciler must be single-writer to prevent conflicts (two processes trying to shadow-copy the same table simultaneously).

**Implementation: Redis `SET NX PX` distributed lock** (the platform's MongoDB migration runner uses a Mongo-backed change lease at `packages/database/src/migrations/lock.ts`; this uses Redis instead because the CH init doesn't have a Mongo connection. The lock semantics are equivalent: acquire with TTL, holder-checked extend/release via Lua).

```
┌──────────────────────────────────────────────────────────────┐
│ Before engine reconciliation (Step 5):                        │
│                                                              │
│ 1. Acquire lock (atomic, non-blocking):                      │
│    SET clickhouse:schema:reconcile:lock <holder>             │
│        NX                      ← only if not exists          │
│        PX 600000               ← 10 minute TTL               │
│                                                              │
│    holder = "<pod-hostname>:<pid>:<timestamp>"                │
│                                                              │
│    Result?                                                   │
│    ├─ OK    → we hold the lock, proceed                      │
│    └─ null  → another process holds it                       │
│              log "Schema reconciliation lock held by another  │
│              process, skipping engine migration"              │
│              (table creation + ALTERs still run — idempotent) │
│                                                              │
│ 2. After reconciliation (success or failure):                │
│    Lua script: delete key only if value matches our holder   │
│    (standard Redis lock release pattern)                     │
│                                                              │
│ 3. Lock TTL and holder-checked heartbeat:                    │
│    Initial TTL: PX 600000 (10 minutes).                      │
│    For large table migrations that exceed 10 minutes,        │
│    the reconciler extends the lock TTL every 60 seconds      │
│    using a Lua script that checks holder ownership:          │
│                                                              │
│      -- Lua: extend only if we still own the lock            │
│      if redis.call('GET', KEYS[1]) == ARGV[1] then           │
│        return redis.call('PEXPIRE', KEYS[1], ARGV[2])        │
│      else                                                    │
│        return 0                                              │
│      end                                                     │
│      -- KEYS[1] = lock key, ARGV[1] = holder, ARGV[2] = TTL │
│                                                              │
│    Release also uses holder-checked Lua (standard pattern):  │
│      if redis.call('GET', KEYS[1]) == ARGV[1] then           │
│        return redis.call('DEL', KEYS[1])                     │
│      else                                                    │
│        return 0                                              │
│      end                                                     │
│                                                              │
│    If process crashes, lock expires after 10 min and         │
│    next run proceeds automatically.                          │
│                                                              │
│ 4. Redis unavailable — fail-closed for execute mode:         │
│    ┌──────────────────────────────────────────────────┐      │
│    │ CLICKHOUSE_ENGINE_MIGRATION=execute                │      │
│    │   AND Redis unavailable?                          │      │
│    │   → ABORT: "Cannot run engine migration without   │      │
│    │     distributed lock. Set REDIS_URL or disable    │      │
│    │     ENGINE_MIGRATION."                            │      │
│    │                                                   │      │
│    │ ENGINE_MIGRATION not set (no migration)?          │      │
│    │   → Proceed without lock (table creation + ALTERs │      │
│    │     are idempotent, safe without lock)            │      │
│    │   → Log: "Redis unavailable, skipping engine      │      │
│    │     reconciliation lock"                          │      │
│    └──────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────┘
```

**What runs concurrently (safe — all idempotent):**

- `CREATE TABLE IF NOT EXISTS`
- `ALTER TABLE ADD COLUMN IF NOT EXISTS`
- `ALTER TABLE ADD INDEX IF NOT EXISTS`

**What requires the lock (single-writer):**

- Engine reconciliation (shadow-copy migration)
- MV recreation (DROP + CREATE has a brief gap — runs under lock)
- `_old` table cleanup

### 8. Phased Rollout Plan

Don't big-bang. Run old and new init paths in parallel for the first deploy cycle, then cut over.

```
┌──────────────────────────────────────────────────────────────────────┐
│ PHASE 1: PARALLEL RUN (1-2 deploy cycles)                           │
│ ──────────────────────────────────────────                           │
│ Environment: Dev                                                     │
│ CLICKHOUSE_REPLICATED: false                                         │
│                                                                      │
│ PreSync hook: NEW cli.ts init (creates all 56 tables)                │
│ Service startup: OLD init calls STILL PRESENT (safety net)           │
│                                                                      │
│ Validation:                                                          │
│   • All 56 tables created by PreSync ✓                               │
│   • Services start without errors ✓                                  │
│   • Eval preflight passes ✓                                          │
│   • No duplicate DDL warnings in logs ✓                              │
│                                                                      │
│ Risk: Zero — both paths are idempotent, old path is a no-op          │
├──────────────────────────────────────────────────────────────────────┤
│ PHASE 2: CUT OVER (after Phase 1 validated)                         │
│ ──────────────────────────────────────────                           │
│ Environment: Dev → QA                                                │
│ CLICKHOUSE_REPLICATED: false                                         │
│                                                                      │
│ Changes:                                                             │
│   • Remove old init calls from pipeline-engine/server.ts             │
│   • Remove old init calls from runtime/server.ts                     │
│   • Remove maybeInitClickHouseSchema() from seed-mongo.ts            │
│   • Delete satellite init files from pipeline-engine + eventstore    │
│                                                                      │
│ Validation:                                                          │
│   • Services start — no "table not found" errors ✓                   │
│   • cli.ts status shows 0 drifts, 0 unmanaged ✓                     │
│   • Full test suite passes ✓                                         │
│                                                                      │
│ Risk: Low — tables were already created by Phase 1's PreSync         │
├──────────────────────────────────────────────────────────────────────┤
│ PHASE 3: STAGING REPLICATION ASSESSMENT (after Phase 2 stable)      │
│ ──────────────────────────────────────────                           │
│ Environment: Staging (2 replicas + Keeper)                           │
│ CLICKHOUSE_REPLICATED: false (unchanged for now)                     │
│ CLICKHOUSE_CLUSTER: not set                                          │
│ CLICKHOUSE_ENGINE_MIGRATION: not set                                 │
│                                                                      │
│ This phase is assessment only — NO config changes deployed.          │
│ Use cli.ts status to generate the drift report WITHOUT               │
│ deploying any config changes:                                        │
│                                                                      │
│ Steps:                                                               │
│   1. Run: CLICKHOUSE_REPLICATED=true CLICKHOUSE_CLUSTER=             │
│      default_cluster tsx cli.ts status                               │
│      (env vars passed to CLI only, not deployed)                     │
│   2. Review drift report — which tables need migration               │
│   3. Verify Keeper connectivity and distributed_ddl config           │
│   4. Confirm managed inventory matches across both replicas          │
│   5. Review table sizes and active-writer risk                       │
│   6. Plan maintenance window for large/active tables                 │
│                                                                      │
│ Risk: Zero — read-only status command, no DDL executed               │
│                                                                      │
│ Note: cli.ts status is a true read-only command. It queries          │
│ system.tables and compares against desired DDL. It does NOT          │
│ create tables, run ALTERs, or modify anything. cli.ts init           │
│ is the write path — it creates tables and runs ALTERs even           │
│ without ENGINE_MIGRATION set.                                        │
├──────────────────────────────────────────────────────────────────────┤
│ PHASE 4: EXECUTE STAGING MIGRATION (after dry-run approved)         │
│ ──────────────────────────────────────────                           │
│ Environment: Staging                                                 │
│ CLICKHOUSE_REPLICATED: true                                          │
│ CLICKHOUSE_CLUSTER: default_cluster                                  │
│ CLICKHOUSE_ENGINE_MIGRATION: execute                                 │
│                                                                      │
│ Steps:                                                               │
│   1. For tables > 10 GiB: schedule maintenance window               │
│   2. Pause writers for active/high-write tables if needed            │
│   3. Deploy — reconciler migrates small/idle tables                  │
│   4. Verify via cli.ts status — confirm 0 managed drifts             │
│   5. Confirm no replication queue backlog and no read errors         │
│   6. Monitor for 1 week                                              │
│                                                                      │
│ Rollback: manual EXCHANGE TABLES using _old backups (see §6)         │
│   Use ON CLUSTER for replicated envs                                 │
│                                                                      │
│ Risk: Medium — this is the first false→true environment migration.   │
│        _old backups provide rollback. Lock prevents conflicts.       │
├──────────────────────────────────────────────────────────────────────┤
│ PHASE 5: SIT / PRODUCTION VALIDATION                                │
│ ──────────────────────────────────────────                           │
│ Environment: SIT + Production                                        │
│ CLICKHOUSE_REPLICATED: true                                          │
│ CLICKHOUSE_CLUSTER: main                                             │
│ CLICKHOUSE_ENGINE_MIGRATION: (not set initially)                     │
│                                                                      │
│ Steps:                                                               │
│   1. Run cli.ts status only                                          │
│   2. Confirm no unexpected managed engine drift                      │
│   3. Confirm managed inventory is consistent across replicas         │
│   4. If drift exists, review manually before enabling execute        │
│                                                                      │
│ Risk: Low — these environments are already configured replicated.     │
├──────────────────────────────────────────────────────────────────────┤
│ PHASE 6: PRODUCTION EXECUTION ONLY IF DRIFT IS FOUND                │
│ ──────────────────────────────────────────                           │
│ Environment: Production                                              │
│ CLICKHOUSE_REPLICATED: true                                          │
│ CLICKHOUSE_CLUSTER: main                                             │
│ CLICKHOUSE_TIERED_STORAGE: true only if storage policy exists        │
│ CLICKHOUSE_ENGINE_MIGRATION: execute only with approved change       │
│                                                                      │
│ Same safety process as staging. Large or active tables require       │
│ explicit maintenance windows and writer pause.                       │
└──────────────────────────────────────────────────────────────────────┘
```

**Environment policy:** dev and QA remain non-replicated. SIT and production are already
replicated and should be validated with `status` before any execute-mode reconciliation.
Staging is the only planned false→true migration target in this design.

---

## Scenario Matrix — `CLICKHOUSE_REPLICATED` Flag Behavior

Every combination of flag value × environment state, with expected behavior:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Scenario 1: REPLICATED=false, Fresh Deploy (dev, local)                     │
│ ────────────────────────────────────────────────────────────────             │
│ DDL: ReplicatedMergeTree → transformer → MergeTree                          │
│ CREATE TABLE: creates MergeTree tables                                      │
│ Reconciler: desired=MergeTree, actual=MergeTree → no drift                  │
│ Result: all tables non-replicated ✓                                         │
├──────────────────────────────────────────────────────────────────────────────┤
│ Scenario 2: REPLICATED=true, Fresh Deploy (new replicated environment)      │
│ ────────────────────────────────────────────────────────────────             │
│ Keeper check: verifies Keeper is reachable                                  │
│ DDL: ReplicatedMergeTree → kept as-is                                       │
│ CREATE TABLE: creates ReplicatedMergeTree tables                            │
│ Reconciler: desired=ReplicatedMergeTree, actual=ReplicatedMergeTree → OK    │
│ Result: all tables replicated from day one ✓                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ Scenario 3: REPLICATED=false → true (enabling replication on existing env)  │
│ ────────────────────────────────────────────────────────────────             │
│ Keeper check: verifies Keeper is reachable                                  │
│ DDL: ReplicatedMergeTree → kept as-is                                       │
│ CREATE TABLE IF NOT EXISTS: no-op (tables already exist as MergeTree)       │
│ Reconciler: desired=ReplicatedMergeTree, actual=MergeTree → DRIFT (upgrade) │
│   With ENGINE_MIGRATION=execute: shadow-copy migrate each drifted table     │
│   Without ENGINE_MIGRATION: log drift report only, no action                │
│ Result: tables migrated to replicated (or drift logged) ✓                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ Scenario 4: REPLICATED=true → false (disabling replication — rare)          │
│ ────────────────────────────────────────────────────────────────             │
│ DDL: ReplicatedMergeTree → transformer → MergeTree                          │
│ CREATE TABLE IF NOT EXISTS: no-op (tables exist as ReplicatedMergeTree)     │
│ Reconciler: desired=MergeTree, actual=ReplicatedMergeTree → DOWNGRADE       │
│   Action: LOG WARNING ONLY, never auto-downgrade                            │
│ Result: tables remain ReplicatedMergeTree, warning logged ✓                 │
│                                                                              │
│ ⚠️  CRITICAL: Keeper MUST remain running even with REPLICATED=false.         │
│ ReplicatedMergeTree uses Keeper for coordination metadata (replication       │
│ logs, block numbers, merges, mutations) — not just data replication.        │
│ If Keeper is also being removed, tables must be manually downgraded         │
│ BEFORE Keeper shutdown.                                                      │
├──────────────────────────────────────────────────────────────────────────────┤
│ Scenario 5: REPLICATED=true, Keeper unavailable                             │
│ ────────────────────────────────────────────────────────────────             │
│ Keeper check: FAILS                                                         │
│ Action: ABORT init with clear error message                                 │
│   "CLICKHOUSE_REPLICATED=true but Keeper is not reachable."                 │
│ Result: no tables created/modified, PreSync hook fails, deploy blocked ✓    │
├──────────────────────────────────────────────────────────────────────────────┤
│ Scenario 6: REPLICATED=false, Steady State (repeated runs)                  │
│ ────────────────────────────────────────────────────────────────             │
│ DDL: MergeTree (after transform)                                            │
│ CREATE TABLE IF NOT EXISTS: no-op                                           │
│ Reconciler: no drift                                                        │
│ ALTER migrations: ADD COLUMN/INDEX IF NOT EXISTS → no-op                    │
│ MVs: hash check → unchanged → skip (no drop/recreate)                       │
│ Result: fast no-op, ~seconds ✓                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ Scenario 7: REPLICATED=true, ENGINE_MIGRATION=execute, Steady State         │
│ ────────────────────────────────────────────────────────────────             │
│ Keeper check: passes                                                        │
│ DDL: ReplicatedMergeTree (kept as-is)                                       │
│ CREATE TABLE IF NOT EXISTS: no-op                                           │
│ Reconciler: desired=Replicated*, actual=Replicated* → no drift              │
│ _old cleanup: drops any _old tables > 7 days                                │
│ Result: fast no-op + cleanup, ~seconds ✓                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│ Scenario 8: REPLICATED=true, Manual table drop + recreation                 │
│ ────────────────────────────────────────────────────────────────             │
│ Someone accidentally drops a table and recreates it as MergeTree            │
│ CREATE TABLE IF NOT EXISTS: no-op (table exists, wrong engine)              │
│ Reconciler: desired=ReplicatedMergeTree, actual=MergeTree → DRIFT           │
│   With ENGINE_MIGRATION=execute: auto-heals via shadow-copy                 │
│ Result: self-healing restores correct engine ✓                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ Scenario 9: New table added to codebase, all envs                           │
│ ────────────────────────────────────────────────────────────────             │
│ REPLICATED=false: DDL transformed → CREATE TABLE as MergeTree               │
│ REPLICATED=true:  DDL kept → CREATE TABLE as ReplicatedMergeTree            │
│ Reconciler: new table just created with correct engine → no drift           │
│ Result: new tables always get the right engine ✓                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Dockerfile Impact

`apps/runtime/Dockerfile.seed-migrate-ops` already copies:

- `packages/database/` — primary package (DDL moves here)
- `packages/pipeline-engine/src/` — no longer needed for DDL (but kept for seed-pipelines)
- `packages/eventstore/` — no longer needed for DDL

**No Dockerfile changes required.** All DDL is now in `packages/database/`, which is the primary package in the image.

---

## Tables Not Managed by This System

- `structured_data_*` — dynamically created by search-ai at runtime per index. Cannot be pre-created.
- `traces` — created by search-ai (`apps/search-ai/src/services/structured-data/clickhouse-client.ts`).
- `table_metadata` — created by search-ai for structured data index tracking.
- Coroot/monitoring ClickHouse tables — separate cluster, not part of abl-platform.

---

## Review Responses — Rakshak Kundarapu Feedback (2026-05-20)

### §1. Cross-Namespace ClickHouse

**Status: Accepted — design updated.**

SIT/prod use `clickhouse.operator.enabled=true` with Altinity operator. The ClickHouseInstallation CRD is deployed in the same namespace today (`abl-platform-sit`, `abl-platform-prod`), but operator-managed CH could move to a dedicated namespace.

**Fixes applied:**

**1a. FQDN for `CLICKHOUSE_URL`:**
Mandated in all environments. The `CLICKHOUSE_URL` env var must use FQDN format:

```
http://<release>-clickhouse.<namespace>.svc.cluster.local:8123
```

For operator-managed: `http://chi-<inst>-<cluster>-<shard>-<replica>.<namespace>.svc.cluster.local:8123`
This works whether same-namespace or cross-namespace.

**1b. Per-replica connectivity for `SYSTEM SYNC REPLICA`:**
Step 3b requires direct connection to each replica. No additional env vars needed — replica FQDNs are derived from ClickHouse's own cluster metadata:

```sql
SELECT host_name, host_address, port
FROM system.clusters
WHERE cluster = '<CLICKHOUSE_CLUSTER>'
```

The `host_name` field contains the FQDN as configured in `remote_servers` (e.g., `chi-main-main-0-0.abl-platform-sit.svc.cluster.local`). This resolves from any namespace — same-ns or cross-ns. The `host_address` field provides the pod IP as fallback.

The CLI connects to replicas using `host_name:port` from `system.clusters`. If the FQDN doesn't resolve, `host_address:port` is tried. If both fail, the step aborts with a clear error listing unreachable hosts.

**1c. NetworkPolicy:**
Add to deploy repo: egress rule from PreSync Job namespace → CH namespace on ports 8123 (HTTP) and 9000 (native). Template snippet:

```yaml
# In abl-platform chart, pre-sync-clickhouse-init hook:
egress:
  - to:
      - namespaceSelector:
          matchLabels:
            app.kubernetes.io/part-of: abl-platform
      - podSelector:
          matchLabels:
            app.kubernetes.io/name: clickhouse
    ports:
      - port: 8123
      - port: 9000
```

**1d. Secret strategy:**
CH credentials are in `<release>-db-secrets` (ESO → Key Vault). For cross-namespace: ESO `ExternalSecret` in the Job's namespace references the same Key Vault secret. Already the pattern for `shared-secrets`.

**1e. Pre-flight replica reachability check:**
Added to `cli.ts status` and `cli.ts init` Step 3b: query `system.clusters` for replica `host_name` + `port`, test TCP reachability before any migration. Fail fast with unreachable host list. Falls back to `host_address` (pod IP) if FQDN doesn't resolve.

**1f. SIT/prod status-only until connectivity proven:**
Phase 5 already treats SIT/prod as status-only. Engine migration (`execute`) is gated behind explicit approval AND proven replica connectivity.

### §2. Production Readiness Gaps

**2a. `_old_YYYYMMDD` name collision:**
**Fixed.** Use full timestamp: `_old_20260520T143022Z`. Two runs same day get different names.

**2b. MV diff normalization:**
**Fixed.** Instead of hashing `SHOW CREATE VIEW` output (which varies by CH version/formatting), store the DDL source hash as a table comment on the MV destination table:

```sql
ALTER TABLE <mv_dest> MODIFY COMMENT 'ddl_hash:<sha256>'
```

Comparison checks the stored hash against the current DDL source hash. If no hash stored (first run), treat as "needs creation". This avoids all whitespace/quoting/formatting normalization issues.

**2c. Validate `CLICKHOUSE_CLUSTER` against `system.clusters`:**
**Fixed.** Added to Step 3b preflights:

```sql
SELECT count() FROM system.clusters WHERE cluster = '<CLICKHOUSE_CLUSTER>'
```

Zero rows → ABORT: "Cluster '<name>' not found in system.clusters. Available: ..."

**2d. Long-running migration vs. Helm hook timeout:**
**Fixed.** Design change:

| Mode               | Runs as             | Scope                                                    |
| ------------------ | ------------------- | -------------------------------------------------------- |
| `cli.ts init`      | PreSync hook (fast) | CREATE TABLE + ALTER + MV creation (no engine migration) |
| `cli.ts reconcile` | Separate manual Job | Engine migration only (potentially long-running)         |

The `init` command no longer performs engine migration — it only creates tables, applies ALTERs, and creates missing MVs. This is fast and deterministic (seconds).

Engine reconciliation is a separate command (`cli.ts reconcile`) that must be run manually (via `kubectl create job` or Argo `Sync` with a separate hook). This decouples deploy availability from migration duration.

Helm hook spec:

```yaml
activeDeadlineSeconds: 300 # 5 min max for init (table creation + ALTERs)
backoffLimit: 0 # Do not retry mid-init — lock + _new cleanup handle re-runs
ttlSecondsAfterFinished: 600 # Clean up Job pod after 10 min
```

**Updated CLI commands:**

```bash
# PreSync hook — fast, deterministic (CREATE + ALTER + MV)
tsx cli.ts init

# Manual Job — engine migration (potentially long, requires lock)
tsx cli.ts reconcile

# Read-only — no DDL
tsx cli.ts status
```

**2e. Managed inventory list derivation:**
**Fixed.** The managed table inventory is derived from DDL module exports at runtime — not a hand-maintained list. Each `tables/*.ts` file exports its table names. `init-all.ts` collects them. Unit test validates that every table identifier in DDL appears in the collected inventory.

**2f. `EXCHANGE TABLES` partial-replica failure recovery:**
**Fixed.** Documented: if `EXCHANGE TABLES ON CLUSTER` applies to some replicas but fails on others (DDL queue blip), next run sees:

- `messages` is `Replicated*` on some replicas (matches desired) → no drift
- `messages_new` still exists → stale cleanup drops it (Step 0 pre-flight)

The reconciler's pre-flight `DROP stale _new if exists` handles this. The \_new table is always safe to drop because it was never the "live" table on any replica where EXCHANGE succeeded — EXCHANGE is a swap, so on successful replicas, the old table is now at `_new` name.

**2g. Observability:**
**Fixed.** End-of-run emits structured JSON:

```json
{
  "version": "1.0",
  "command": "init",
  "timestamp": "2026-05-20T14:30:22Z",
  "duration_ms": 4523,
  "database": "abl_platform",
  "replicated": true,
  "cluster": "default_cluster",
  "tables_created": 3,
  "alters_applied": 12,
  "mvs_created": 2,
  "mvs_skipped_unchanged": 11,
  "drift_detected": 5,
  "migrated": 0,
  "skipped_too_large": 1,
  "skipped_downgrade": 0,
  "lock_holder": "seed-migrate-ops-xyz:1:1716216622",
  "errors": []
}
```

Persisted to ClickHouse `_schema_audit_log` table (created during init):

```sql
CREATE TABLE IF NOT EXISTS <db>._schema_audit_log (
    version      String,
    command      LowCardinality(String),
    timestamp    DateTime64(3) DEFAULT now64(3),
    duration_ms  UInt32,
    summary      String CODEC(ZSTD(3)),
    host         String
) ENGINE = MergeTree()
ORDER BY timestamp
TTL timestamp + INTERVAL 365 DAY DELETE
```

**2h. Schema-version table:**
**Addressed by 2g.** The `_schema_audit_log` table serves as the audit trail. Each successful run inserts a row with the full summary JSON. "What's the live schema baseline?" → `SELECT * FROM _schema_audit_log ORDER BY timestamp DESC LIMIT 1`.

**2i. Job spec details:**
**Fixed.** Added to Helm hook section:

```yaml
spec:
  activeDeadlineSeconds: 300
  backoffLimit: 0
  ttlSecondsAfterFinished: 600
  template:
    spec:
      serviceAccountName: default # No special RBAC needed — CH access via CLICKHOUSE_URL
      resources:
        requests:
          cpu: 250m
          memory: 256Mi
        limits:
          cpu: '1'
          memory: 1Gi # ENGINE_MIGRATION=execute may need more for INSERT SELECT
      restartPolicy: Never
```

**2j. MV source-table reference after EXCHANGE:**
**Fixed.** Added invariant: ClickHouse MVs reference source tables by **name** (not by internal UUID/`inner_id`). After EXCHANGE, the table at name `messages` is the new Replicated table — the MV's `FROM abl_platform.messages` resolves to it. However, MVs may cache internal table references. The MV must be verified after EXCHANGE during Phase 3 integration testing. If the MV stops triggering, it must be recreated (controlled by `ALLOW_MV_RECREATE`).

**2k. Test plan:**
**Fixed.** Integration test scenarios (minimum):

| Scenario                            | What it validates                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| Idempotent re-run                   | `init` twice → second run is no-op, zero errors                               |
| Stale `_new` cleanup                | Create fake `_new` table → `reconcile` drops it before migration              |
| Divergent-replica abort             | Two replicas with different row counts → abort with error                     |
| Lock collision                      | Two concurrent `reconcile` runs → second skips with "lock held"               |
| Downgrade warning                   | `REPLICATED=false` with existing `Replicated*` tables → warn, no action       |
| MV hash unchanged → skip            | Unchanged MV DDL → skip, no drop/recreate                                     |
| MV hash changed without flag → warn | Changed MV DDL without `ALLOW_MV_RECREATE` → warn only                        |
| Shadow-copy upgrade                 | `MergeTree` → `ReplicatedMergeTree` on 2-replica test CH stack                |
| ALTER before reconcile              | Missing columns on old table → ALTER adds them → reconcile copies all columns |
| Keeper unreachable                  | `REPLICATED=true` but Keeper down → abort with clear error                    |
| Cluster name invalid                | Wrong `CLICKHOUSE_CLUSTER` → abort with "not found in system.clusters"        |
| Database engine check               | `Ordinary` database engine → abort with "EXCHANGE not supported"              |

E2E test: 2-replica ClickHouse stack (docker-compose with Keeper) for full shadow-copy upgrade path.

### §3. Seed Script

**Confirmed.** MongoDB seed (`seed-mongo.ts`, hookWeight -10) runs after ClickHouse init (hookWeight -15) which runs after MongoDB migrations (hookWeight -20). The ordering `-20 → -15 → -10` is correct. `seed-mongo.ts` does NOT read from ClickHouse — it only reads/writes MongoDB. Removing `maybeInitClickHouseSchema()` has no side effects on seed behavior.

### §4. Minor Items

**4a. `ENGINE_MIGRATION=execute` as one-off override:**
**Fixed.** The env var should be passed as a one-off Argo parameter or `kubectl` env override, NOT baked into `values.yaml`. Added to recommended config:

```yaml
# DO NOT add to values.yaml:
# CLICKHOUSE_ENGINE_MIGRATION: "execute"    ← WRONG, will auto-migrate on every deploy

# Instead, pass as one-off override:
# kubectl create job ch-reconcile --from=cronjob/... -- env CLICKHOUSE_ENGINE_MIGRATION=execute
# OR: argocd app sync ... --parameter runtime.configMap.CLICKHOUSE_ENGINE_MIGRATION=execute
```

**4b. `--format=json` for CLI:**
**Fixed.** Both `status` and `init` support `--format=json` for CI consumption. Default is human-readable.

**4c. Rollback Keeper path cleanup:**
**Fixed.** Added to rollback procedure: after swapping back to a `MergeTree` backup, the now-stale `Replicated*` Keeper path from the failed migration must be cleaned. Step added:

```sql
-- 5. Clean up stale Keeper path (prevents collision on re-migration)
SYSTEM DROP REPLICA '<replica>' FROM ZKPATH
    '/clickhouse/tables/{shard}/abl_platform.messages';
```

---

## Updated CLI Commands

After §2d review feedback, the CLI is now three commands with distinct scopes:

```bash
# PreSync hook — fast, deterministic, always safe
# Creates tables, applies ALTERs, creates missing MVs
# Does NOT perform engine migration
tsx packages/database/src/clickhouse-schemas/cli.ts init [--format=json]

# Manual Job — engine migration (potentially long-running)
# Requires CLICKHOUSE_ENGINE_MIGRATION=execute
# Requires Redis lock
# Run separately from deploy, during maintenance window if needed
tsx packages/database/src/clickhouse-schemas/cli.ts reconcile [--format=json]

# Read-only — no DDL executed, safe to run anytime
# Reports table inventory, engine drift, MV drift, replica health
tsx packages/database/src/clickhouse-schemas/cli.ts status [--format=json]
```

### Updated Helm Hook

```yaml
# PreSync hook — init only (fast)
hookWeight: -15
command: ['tsx', 'packages/database/src/clickhouse-schemas/cli.ts', 'init']
activeDeadlineSeconds: 300
backoffLimit: 0
ttlSecondsAfterFinished: 600
resources:
  requests: { cpu: 250m, memory: 256Mi }
  limits: { cpu: '1', memory: 1Gi }

# Engine reconciliation — separate manual Job (NOT a PreSync hook)
# Created and triggered manually during approved migration windows
```
