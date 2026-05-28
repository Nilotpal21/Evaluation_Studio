# ClickHouse Schema Operations Playbook

**Last updated:** 2026-05-21
**Owners:** Platform Engineering
**Related:** `packages/database/src/clickhouse-schemas/`

---

## Overview

All ClickHouse DDL is managed by a centralized CLI at `packages/database/src/clickhouse-schemas/cli.ts`. It runs as a PreSync hook before every ArgoCD deploy and handles table creation, schema migrations, and drift detection automatically.

### CLI Commands

```bash
# PreSync hook — creates tables, applies ALTERs, creates MVs (runs every deploy)
tsx packages/database/src/clickhouse-schemas/cli.ts init

# Read-only drift report — engine, column, and table inventory
tsx packages/database/src/clickhouse-schemas/cli.ts status

# Engine migration — shadow-copy MergeTree → ReplicatedMergeTree (manual job)
tsx packages/database/src/clickhouse-schemas/cli.ts reconcile
```

### Environment Variables

| Env Var                        | Values             | Default        | Source            |
| ------------------------------ | ------------------ | -------------- | ----------------- |
| `CLICKHOUSE_URL`               | Connection URL     | —              | db-secrets        |
| `CLICKHOUSE_DATABASE`          | Database name      | `abl_platform` | runtime-config    |
| `CLICKHOUSE_REPLICATED`        | `true` / `false`   | `false`        | runtime-config    |
| `CLICKHOUSE_ENGINE_MIGRATION`  | `execute` / absent | absent         | One-time override |
| `CLICKHOUSE_ALLOW_MV_RECREATE` | `true` / absent    | absent         | One-time override |
| `REDIS_URL`                    | Redis connection   | —              | db-secrets        |

`CLICKHOUSE_CLUSTER` is **not needed** — auto-detected from ClickHouse's `system.clusters`.

---

## Playbook 1: Day-to-Day Deploys (Fully Autonomous)

**When:** Every ArgoCD sync (dev, QA, staging, SIT, prod)
**Effort:** Zero — fully automated
**Risk:** None

### What Happens

```
ArgoCD sync triggers PreSync hooks in order:

  hookWeight -20: tsx packages/database/src/migrations/cli.ts migrate
                  → MongoDB migrations

  hookWeight -15: tsx packages/database/src/clickhouse-schemas/cli.ts init
                  → Creates all 59 ClickHouse tables (IF NOT EXISTS — no-op if exist)
                  → Applies ALTER migrations (ADD COLUMN/INDEX IF NOT EXISTS)
                  → Creates materialized views (IF NOT EXISTS)
                  → Updates TTL retention
                  → Records run in _schema_audit_log

  hookWeight -10: tsx packages/database/seed-mongo.ts
                  → MongoDB seed data

Services start:
  → ensureClickHouseSchemaReady() probes platform_events + eval_conversations
  → Tables exist → skip (normal path)
  → Tables missing → runs init as fallback (safety net)
```

### What to Check If Something Fails

```bash
# 1. Check the PreSync Job logs in ArgoCD
kubectl logs job/<release>-clickhouse-init -n <namespace>

# 2. Run status to see current state
CLICKHOUSE_URL=<url> tsx cli.ts status

# 3. Common issues:
#    - "Keeper not reachable" → ClickHouse Keeper pods are down
#    - "Database engine Ordinary" → Need Atomic database engine
#    - "TTL expression" → DateTime64 column needs toDateTime() wrapping
```

---

## Playbook 2: Adding a New Table

**When:** Developer adds a new ClickHouse table
**Effort:** ~30 minutes
**Risk:** None — `CREATE TABLE IF NOT EXISTS` is idempotent

### Steps

1. **Choose the right domain file:**

   | Domain                               | File                                      |
   | ------------------------------------ | ----------------------------------------- |
   | Core (events, metrics, audit)        | `clickhouse-schemas/init.ts`              |
   | Analytics (sentiment, quality, etc.) | `clickhouse-schemas/tables/analytics.ts`  |
   | Eval (eval runs, scores)             | `clickhouse-schemas/tables/eval.ts`       |
   | Experiments                          | `clickhouse-schemas/tables/experiment.ts` |
   | Workflow (event sourcing)            | `clickhouse-schemas/tables/workflow.ts`   |

2. **Write the DDL using `Replicated*` as canonical engine:**

   ```sql
   CREATE TABLE IF NOT EXISTS ${DATABASE}.my_new_table
   (
       tenant_id     String               CODEC(ZSTD(1)),
       timestamp     DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
       -- ... columns ...

       INDEX idx_tenant tenant_id TYPE bloom_filter GRANULARITY 4
   )
   ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.my_new_table', '{replica}')
   PARTITION BY toYYYYMM(timestamp)
   ORDER BY (tenant_id, timestamp)
   TTL toDateTime(timestamp) + INTERVAL 730 DAY DELETE
   SETTINGS index_granularity = 8192
   ```

   The DDL transform automatically strips `Replicated*` for non-replicated environments.

3. **Add to the DDL array in the domain file:**

   ```typescript
   export const MY_DOMAIN_TABLE_DDL: { name: string; ddl: string }[] = [
     // ... existing tables ...
     { name: 'my_new_table', ddl: `CREATE TABLE IF NOT EXISTS ...` },
   ];
   ```

4. **Update `init-all.ts`** to include the new DDL in the orchestrator.

5. **Run tests:**

   ```bash
   pnpm vitest run packages/database/src/clickhouse-schemas/__tests__/
   ```

   The `schema-integrity.test.ts` automatically validates:
   - DDL has `CREATE TABLE IF NOT EXISTS`
   - DDL has `ENGINE` clause with `Replicated*`
   - DDL has `ORDER BY`
   - Columns are extractable

6. **Commit, PR, merge** → next deploy auto-creates the table.

---

## Playbook 3: Adding a New Column

**When:** Developer adds a column to an existing table
**Effort:** ~15 minutes
**Risk:** None — `ADD COLUMN IF NOT EXISTS` is idempotent. Existing rows get the default value.

### Steps

1. **Add the ALTER migration to the appropriate migration array:**

   For analytics tables (`tables/analytics.ts`):

   ```typescript
   export const ANALYTICS_MIGRATIONS: string[] = [
     // ... existing migrations ...
     `ALTER TABLE ${DATABASE}.conversation_sentiment ADD COLUMN IF NOT EXISTS new_field String DEFAULT ''`,
   ];
   ```

   For core tables (`init.ts`): add to the ALTER section inside `initClickHouseSchema()`.

2. **Optionally update the CREATE TABLE DDL** to include the new column (for fresh deploys).

3. **Update `coreAlterColumns` in `engine-reconciler.ts`** if adding to a core table (for column drift detection accuracy).

4. **Commit, PR, merge** → next deploy auto-adds the column.

### What Happens to Existing Data

- Existing rows get the `DEFAULT` value (e.g., empty string, 0)
- No data is modified or deleted
- New inserts use the new column normally

---

## Playbook 4: Adding a New Materialized View

**When:** Developer adds an MV for analytics rollups
**Effort:** ~20 minutes
**Risk:** None for new MVs. Changed MVs require `ALLOW_MV_RECREATE`.

### Steps

1. **Add the MV DDL to the domain file:**

   ```typescript
   export const MY_DOMAIN_MV_DDL: { name: string; ddl: string }[] = [
     {
       name: 'mv_daily_my_metric',
       ddl: `
   CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.mv_daily_my_metric
   ENGINE = ReplicatedSummingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.mv_daily_my_metric', '{replica}')
   ORDER BY (tenant_id, project_id, day)
   AS SELECT
       tenant_id, project_id,
       toDate(timestamp) AS day,
       count() AS event_count
   FROM ${DATABASE}.source_table
   GROUP BY tenant_id, project_id, day
   `,
     },
   ];
   ```

2. **Update `init-all.ts`** to include the MV in the orchestrator.

3. **Commit, PR, merge** → next deploy auto-creates the MV.

### Changing an Existing MV Definition

MV definition changes require explicit opt-in because DROP+CREATE has a brief insert gap:

```bash
# Deploy with ALLOW_MV_RECREATE=true (one-time env override)
# ArgoCD: set as a parameter override for one sync
CLICKHOUSE_ALLOW_MV_RECREATE=true

# After sync completes, remove the override
# Future deploys skip unchanged MVs automatically (hash tracking)
```

For production, schedule during a maintenance window with writer pods scaled to 0.

---

## Playbook 5: Enabling Replication on an Environment

**When:** Migrating an environment from non-replicated to replicated ClickHouse
**Effort:** ~1-2 hours (including maintenance window)
**Risk:** Medium — engine migration. Zero data loss guaranteed by shadow-copy + verification.

### Prerequisites

- ClickHouse cluster has 2+ replicas configured
- ClickHouse Keeper (or ZooKeeper) is running and healthy
- Redis is available (for distributed lock during reconcile)
- Maintenance window scheduled (services will be scaled to 0 during migration)
- Stakeholders notified

### Phase 1: Infrastructure Pre-Checks (No Changes)

```bash
# Set context
kubectl config use-context <cluster-context>
NAMESPACE=<namespace>
RELEASE=<release-name>

# 1. Verify ClickHouse replicas are running
kubectl get pods -n $NAMESPACE | grep clickhouse
# Expected: 2+ clickhouse pods in Running state

# 2. Verify Keeper is healthy
kubectl port-forward svc/$RELEASE-clickhouse 8124:8123 -n $NAMESPACE &
sleep 3

curl -s "http://localhost:8124/" --data "SELECT count() FROM system.zookeeper WHERE path='/'"
# Expected: non-zero number (Keeper is reachable)

# 3. Verify cluster topology
curl -s "http://localhost:8124/" --data \
  "SELECT cluster, shard_num, replica_num, host_name FROM system.clusters WHERE cluster != 'default' FORMAT PrettyCompact"
# Expected: 2+ replicas in the cluster

# 4. Verify database engine supports EXCHANGE TABLES
curl -s "http://localhost:8124/" --data \
  "SELECT engine FROM system.databases WHERE name='abl_platform'"
# Expected: Atomic (NOT Ordinary)

# 5. Verify ClickHouse version
curl -s "http://localhost:8124/" --data "SELECT version()"
# Expected: >= 21.8

# 6. Check current table sizes (identify tables > 10 GiB)
curl -s "http://localhost:8124/" --data \
  "SELECT name, formatReadableSize(total_bytes) AS size, total_rows
   FROM system.tables
   WHERE database='abl_platform' AND name NOT LIKE '.inner%' AND engine != 'MaterializedView'
   ORDER BY total_bytes DESC LIMIT 10 FORMAT PrettyCompact"

# 7. Check current engine distribution
curl -s "http://localhost:8124/" --data \
  "SELECT engine, count() cnt FROM system.tables
   WHERE database='abl_platform' AND name NOT LIKE '.inner%' AND engine != 'MaterializedView'
   GROUP BY engine ORDER BY cnt DESC FORMAT PrettyCompact"
# Expected: all MergeTree/ReplacingMergeTree/AggregatingMergeTree (non-replicated)

kill %1  # cleanup port-forward
```

### Phase 2: Dry-Run Assessment

```bash
# Run status with REPLICATED=true (env var only — NOT deployed yet)
kubectl port-forward svc/$RELEASE-clickhouse 8124:8123 -n $NAMESPACE &
sleep 3

CLICKHOUSE_URL=http://localhost:8124 CLICKHOUSE_REPLICATED=true \
  npx tsx packages/database/src/clickhouse-schemas/cli.ts status

# Expected output:
# Summary: 59 OK, 0 missing, X unmanaged, 58 engine drift, 0 column drift
#
# Review:
# - How many tables have engine drift? (should be ~58, all except facts)
# - Any column drift? (should be 0)
# - Any missing tables? (should be 0)
# - Note which tables are > 10 GiB (will be skipped by auto-migration)

kill %1
```

**Decision gate:** If everything looks clean, proceed. If column drift or missing tables exist, fix those first with a normal deploy before enabling replication.

### Phase 3: Enable Replicated Mode (Deploy Repo Change)

```yaml
# In abl-platform-deploy/environments/<env>/values.yaml, add:
abl-platform-stack:
  abl-platform:
    runtime:
      configMap:
        CLICKHOUSE_REPLICATED: 'true'
```

```bash
# Commit and push
git add environments/<env>/values.yaml
git commit -m "feat(<env>): enable ClickHouse replicated mode"
git push
```

Deploy this change via ArgoCD. The `init` hook will:

- Create database ON CLUSTER (available on all replicas)
- Existing tables remain as `MergeTree` (no-op — `CREATE TABLE IF NOT EXISTS`)
- ALTER migrations run with ON CLUSTER
- New tables created as `Replicated*`

**No migration happens at this step. Tables are still non-replicated.**

### Phase 4: Engine Migration (Maintenance Window)

```bash
# ========================================
# MAINTENANCE WINDOW START
# ========================================

# 1. Notify stakeholders
echo "Starting ClickHouse replication migration for <env>"

# 2. Scale ALL writer services to 0
kubectl scale deployment/$RELEASE-runtime --replicas=0 -n $NAMESPACE
kubectl scale deployment/$RELEASE-pipeline-engine --replicas=0 -n $NAMESPACE
kubectl scale deployment/$RELEASE-search-ai --replicas=0 -n $NAMESPACE
kubectl scale deployment/$RELEASE-search-ai-runtime --replicas=0 -n $NAMESPACE
kubectl scale deployment/$RELEASE-workflow-engine --replicas=0 -n $NAMESPACE

# 3. Wait for all pods to terminate
echo "Waiting for pods to terminate..."
kubectl wait --for=delete pod \
  -l app.kubernetes.io/instance=$RELEASE \
  -n $NAMESPACE --timeout=120s 2>/dev/null || true
sleep 10

# 4. Verify no writers are running
kubectl get pods -n $NAMESPACE | grep -E "runtime|pipeline|search-ai|workflow"
# Expected: no pods (or Terminating)

# 5. Run reconcile (dry-run first)
kubectl run ch-reconcile-dry --rm -it -n $NAMESPACE \
  --image=<registry>/abl-seed-migrate-ops:<tag> \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "ch-reconcile",
        "image": "<registry>/abl-seed-migrate-ops:<tag>",
        "command": ["tsx", "packages/database/src/clickhouse-schemas/cli.ts", "reconcile"],
        "envFrom": [
          {"secretRef": {"name": "'$RELEASE'-db-secrets", "optional": true}},
          {"configMapRef": {"name": "'$RELEASE'-runtime-config", "optional": true}}
        ]
      }]
    }
  }'
# Expected: "Dry run — 58 drifted table(s) detected"
# Review the list — all tables should show MergeTree → ReplicatedMergeTree

# 6. Run reconcile (EXECUTE)
kubectl run ch-reconcile --rm -it -n $NAMESPACE \
  --image=<registry>/abl-seed-migrate-ops:<tag> \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "ch-reconcile",
        "image": "<registry>/abl-seed-migrate-ops:<tag>",
        "command": ["tsx", "packages/database/src/clickhouse-schemas/cli.ts", "reconcile"],
        "env": [
          {"name": "CLICKHOUSE_ENGINE_MIGRATION", "value": "execute"}
        ],
        "envFrom": [
          {"secretRef": {"name": "'$RELEASE'-db-secrets", "optional": true}},
          {"configMapRef": {"name": "'$RELEASE'-runtime-config", "optional": true}}
        ]
      }]
    }
  }'
# Expected: "checked: 59, drifted: 58, migrated: 58, errors: 0"
# This takes ~30 seconds for small tables, longer for large ones
```

### Phase 5: Post-Migration Verification

```bash
# 1. Run status — should show 0 drift
kubectl run ch-status --rm -it -n $NAMESPACE \
  --image=<registry>/abl-seed-migrate-ops:<tag> \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "ch-status",
        "image": "<registry>/abl-seed-migrate-ops:<tag>",
        "command": ["tsx", "packages/database/src/clickhouse-schemas/cli.ts", "status"],
        "envFrom": [
          {"secretRef": {"name": "'$RELEASE'-db-secrets", "optional": true}},
          {"configMapRef": {"name": "'$RELEASE'-runtime-config", "optional": true}}
        ]
      }]
    }
  }'
# Expected: "59 OK, 0 missing, X unmanaged, 0 engine drift, 0 column drift"

# 2. Verify engines on BOTH replicas
kubectl port-forward pod/$RELEASE-clickhouse-shard-0-0 8124:8123 -n $NAMESPACE &
kubectl port-forward pod/$RELEASE-clickhouse-shard-0-1 8125:8123 -n $NAMESPACE &
sleep 3

echo "=== Replica 0 ==="
curl -s "http://localhost:8124/" --data \
  "SELECT engine, count() cnt FROM system.tables
   WHERE database='abl_platform' AND name NOT LIKE '.inner%' AND engine != 'MaterializedView'
   AND name NOT LIKE '%_old_%'
   GROUP BY engine ORDER BY engine FORMAT PrettyCompact"

echo "=== Replica 1 ==="
curl -s "http://localhost:8125/" --data \
  "SELECT engine, count() cnt FROM system.tables
   WHERE database='abl_platform' AND name NOT LIKE '.inner%' AND engine != 'MaterializedView'
   AND name NOT LIKE '%_old_%'
   GROUP BY engine ORDER BY engine FORMAT PrettyCompact"
# Expected: identical engine distribution on both replicas
# ReplicatedMergeTree, ReplicatedReplacingMergeTree, ReplicatedAggregatingMergeTree

echo "=== Non-replicated tables (should only be facts + _schema_audit_log) ==="
curl -s "http://localhost:8124/" --data \
  "SELECT name, engine FROM system.tables
   WHERE database='abl_platform' AND name NOT LIKE '.inner%'
   AND engine NOT IN ('MaterializedView') AND engine NOT LIKE 'Replicated%'
   AND name NOT LIKE '%_old_%' ORDER BY name FORMAT PrettyCompact"

# 3. Verify system.replicas count
curl -s "http://localhost:8124/" --data \
  "SELECT count() AS replicated_tables FROM system.replicas WHERE database='abl_platform'"
# Expected: ~58 (all tables except facts)

# 4. Verify data replication works
curl -s "http://localhost:8124/" --data \
  "INSERT INTO abl_platform.dead_letter_events
   (event_id, event_type, tenant_id, session_id, payload, error_message, retry_count, failed_at)
   VALUES (generateUUIDv4(), 'repl_test', 'test', 'test', '{}', 'test', 0, now64(3))"
sleep 3

echo "R0: $(curl -s "http://localhost:8124/" --data "SELECT count() FROM abl_platform.dead_letter_events WHERE event_type='repl_test'")"
echo "R1: $(curl -s "http://localhost:8125/" --data "SELECT count() FROM abl_platform.dead_letter_events WHERE event_type='repl_test'")"
# Expected: both show 1

# 5. Verify MV triggers work on both replicas
curl -s "http://localhost:8124/" --data \
  "INSERT INTO abl_platform.llm_metrics
   (tenant_id, timestamp, model_id, provider, session_id, project_id,
    input_tokens, output_tokens, total_tokens, latency_ms)
   VALUES ('test', now64(3), 'test-model', 'test', 's1', 'p1', 100, 50, 150, 500)"
sleep 3

echo "MV dest R0: $(curl -s "http://localhost:8124/" --data "SELECT count() FROM abl_platform.llm_metrics_hourly_dest WHERE tenant_id='test'")"
echo "MV dest R1: $(curl -s "http://localhost:8125/" --data "SELECT count() FROM abl_platform.llm_metrics_hourly_dest WHERE tenant_id='test'")"
# Expected: both show 1

# 6. Clean up test data
curl -s "http://localhost:8124/" --data \
  "ALTER TABLE abl_platform.dead_letter_events DELETE WHERE event_type='repl_test'"
curl -s "http://localhost:8124/" --data \
  "ALTER TABLE abl_platform.llm_metrics DELETE WHERE tenant_id='test'"

kill %1 %2  # cleanup port-forwards
```

### Phase 6: Resume Services

```bash
# Scale services back up
kubectl scale deployment/$RELEASE-runtime --replicas=2 -n $NAMESPACE
kubectl scale deployment/$RELEASE-pipeline-engine --replicas=2 -n $NAMESPACE
kubectl scale deployment/$RELEASE-search-ai --replicas=1 -n $NAMESPACE
kubectl scale deployment/$RELEASE-search-ai-runtime --replicas=1 -n $NAMESPACE
kubectl scale deployment/$RELEASE-workflow-engine --replicas=1 -n $NAMESPACE

# Wait for pods to be ready
kubectl wait --for=condition=Ready pod \
  -l app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=runtime \
  -n $NAMESPACE --timeout=300s

# Verify services are healthy
kubectl get pods -n $NAMESPACE | grep -E "runtime|pipeline|search-ai|workflow"
# Expected: all pods Running

# ========================================
# MAINTENANCE WINDOW END
# ========================================
echo "ClickHouse replication migration complete for <env>"
```

### If Something Goes Wrong

#### Reconcile Partially Failed (Some Tables Migrated, Some Errored)

```bash
# 1. Check which tables migrated and which failed
kubectl run ch-status --rm -it -n $NAMESPACE \
  --image=<registry>/abl-seed-migrate-ops:<tag> \
  --overrides='{...same as above...}'
# Look at engine drift — failed tables still show as drifted

# 2. Re-run reconcile — it's idempotent
# Already-migrated tables show 0 drift, only failed ones retry
kubectl run ch-reconcile --rm -it -n $NAMESPACE \
  --overrides='{...same as above with ENGINE_MIGRATION=execute...}'

# 3. If a specific table keeps failing, check _old and _new remnants
kubectl port-forward svc/$RELEASE-clickhouse 8124:8123 -n $NAMESPACE &
curl -s "http://localhost:8124/" --data \
  "SELECT name, engine FROM system.tables
   WHERE database='abl_platform' AND (name LIKE '%_new' OR name LIKE '%_old_%')
   FORMAT PrettyCompact"
# Drop stale _new tables manually if needed:
# curl -s "http://localhost:8124/" --data "DROP TABLE abl_platform.<table>_new ON CLUSTER '<cluster>'"
```

#### Need to Rollback Entirely

```bash
# 1. Scale services to 0 (same as maintenance window)

# 2. Rollback each migrated table using _old backups
kubectl port-forward svc/$RELEASE-clickhouse 8124:8123 -n $NAMESPACE &

# Find backups
curl -s "http://localhost:8124/" --data \
  "SELECT name FROM system.tables WHERE database='abl_platform' AND name LIKE '%_old_%' ORDER BY name FORMAT TabSeparated"

# Swap each one back (repeat for each table)
curl -s "http://localhost:8124/" --data \
  "EXCHANGE TABLES abl_platform.messages AND abl_platform.messages_old_20260521T120000 ON CLUSTER '<cluster>'"

# 3. Set CLICKHOUSE_REPLICATED back to false
# In deploy repo: revert the values.yaml change
# Deploy

# 4. Scale services back up

# 5. Verify: status should show 0 drift with REPLICATED=false
```

#### Rollback Not Possible (Backups Already Cleaned Up)

If `_old` backups have been cleaned up (after 7 days) and you need to revert:

```bash
# The tables are already Replicated* — they work fine.
# Just set CLICKHOUSE_REPLICATED=false in values.yaml.
# The Replicated* tables continue to function normally
# (they just don't replicate since there's only one node in non-replicated mode).
# The status command will show "downgrade" warnings — these are informational only.
# IMPORTANT: Do NOT remove Keeper if tables are still Replicated*.
# Replicated* tables REQUIRE Keeper for metadata coordination.
```

---

## Playbook 6: Reviewing Drift

**When:** Before any reconciliation, or as part of regular health checks
**Effort:** 5 minutes
**Risk:** None — read-only

### Run Status

```bash
CLICKHOUSE_URL=<url> CLICKHOUSE_REPLICATED=<true|false> \
  tsx packages/database/src/clickhouse-schemas/cli.ts status

# Or with JSON output for automation:
tsx cli.ts status --format=json
```

### Reading the Output

```
Table Inventory:
  + messages                    ReplicatedMergeTree          ← OK, managed
  ! eval_conversations          MergeTree (drift: ...)       ← Engine drift
  - structured_data_abc123      MergeTree (unmanaged)        ← Not our table
  ✗ new_table                   MISSING                      ← Table doesn't exist

Column Drift:
  ✗ messages: missing columns: new_field                     ← Column not added yet
  ℹ audit_events: extra columns: legacy_col                  ← Column not in DDL

Summary: 59 OK, 0 missing, 25 unmanaged, 0 engine drift, 0 column drift
```

| Symbol | Meaning                          |
| ------ | -------------------------------- |
| `+`    | Table exists with correct engine |
| `!`    | Engine drift detected            |
| `-`    | Unmanaged table (not in our DDL) |
| `✗`    | Missing table or missing columns |
| `ℹ`    | Informational (extra columns)    |

---

## Playbook 7: Emergency Rollback

**When:** Engine migration caused issues, need to revert a table
**Effort:** 5 minutes per table
**Risk:** Low — atomic swap using backup tables

### Rollback a Single Table

After engine reconciliation, each migrated table has a backup: `<table>_old_<timestamp>`.

**Single-node:**

```sql
-- 1. Find the backup
SELECT name FROM system.tables
WHERE database = 'abl_platform' AND name LIKE 'messages_old_%';
-- → messages_old_20260521T120000

-- 2. Atomic swap back
EXCHANGE TABLES
    abl_platform.messages AND abl_platform.messages_old_20260521T120000;

-- 3. Verify
SELECT count() FROM abl_platform.messages;
```

**Replicated (ON CLUSTER):**

```sql
EXCHANGE TABLES
    abl_platform.messages AND abl_platform.messages_old_20260521T120000
    ON CLUSTER 'test_cluster';

-- Verify on all replicas
SELECT hostName(), count()
FROM clusterAllReplicas('test_cluster', 'abl_platform.messages')
GROUP BY hostName();
```

### Backup Retention

`_old` backup tables are automatically cleaned up after 7 days during `reconcile` runs. To keep a backup longer, rename it:

```sql
RENAME TABLE abl_platform.messages_old_20260521T120000
    TO abl_platform.messages_backup_permanent;
```

---

## Playbook 8: Troubleshooting

### Init Fails with "Keeper not reachable"

```
CLICKHOUSE_REPLICATED=true but Keeper is not reachable.
Fix Keeper or set CLICKHOUSE_REPLICATED=false.
```

**Cause:** `CLICKHOUSE_REPLICATED=true` but ClickHouse Keeper pods are down or unreachable.

**Fix:**

1. Check Keeper pods: `kubectl get pods | grep keeper`
2. If Keeper is intentionally disabled, set `CLICKHOUSE_REPLICATED=false`
3. If Keeper should be running, restart Keeper pods

### Init Fails with "Database engine Ordinary"

```
Database 'abl_platform' uses engine 'Ordinary'.
EXCHANGE TABLES requires Atomic or Replicated database engine.
```

**Cause:** Old ClickHouse installation with `Ordinary` database engine.

**Fix:** Migrate to Atomic engine (requires ClickHouse admin intervention):

```sql
-- Check current engine
SELECT engine FROM system.databases WHERE name = 'abl_platform';

-- Migration requires creating new Atomic database and moving tables
-- Consult ClickHouse documentation for RENAME DATABASE
```

### Reconcile Fails with "Lock held by another process"

```
Schema reconciliation lock held by another process, skipping.
```

**Cause:** Another reconcile process is running, or a previous process crashed and the lock hasn't expired (10 min TTL).

**Fix:**

1. Wait 10 minutes for lock to expire, then retry
2. Or manually clear the lock: `redis-cli DEL clickhouse:schema:reconcile:lock`

### Reconcile Fails with "Row count mismatch"

```
Row count mismatch: original=1000, new=995
```

**Cause:** Active writes during shadow-copy migration. The source table received new inserts between INSERT SELECT and verification.

**Fix:** Scale writer pods to 0 before running reconcile (see Playbook 5, Phase 3).

### Reconcile Skips Table with "Table size exceeds max"

```
Table size 15000000000 bytes exceeds max 10737418240 bytes
```

**Cause:** Table is larger than 10 GiB. Auto-migration is skipped to prevent long-running jobs.

**Fix:** Run reconcile during an extended maintenance window, or increase the size limit:

```bash
# The maxTableSizeBytes is configurable in code
# Default: 10 GiB (10737418240)
```

### Status Shows "column drift" After Deploy

```
✗ messages: missing columns: new_field
```

**Cause:** A new column was added to the DDL but the ALTER migration hasn't run yet.

**Fix:** Re-run `cli.ts init` — it applies all ALTER migrations automatically:

```bash
CLICKHOUSE_URL=<url> tsx cli.ts init
```

---

## Quick Reference

### File Locations

```
packages/database/src/clickhouse-schemas/
├── cli.ts                 ← CLI entrypoint
├── init-all.ts            ← Orchestrator (calls all inits)
├── init.ts                ← Core 27 tables
├── ddl-transform.ts       ← Replicated/tiered/database transform
├── engine-reconciler.ts   ← Drift detection + shadow-copy migration
├── cluster.ts             ← Auto-detect cluster + ON CLUSTER helpers
├── preflight.ts           ← Keeper/DB engine/version checks
├── redis-lock.ts          ← Distributed lock
├── database.ts            ← Database name resolution
├── tables/
│   ├── analytics.ts       ← 21 analytics tables + MVs
│   ├── eval.ts            ← 3 eval tables + MVs
│   ├── experiment.ts      ← 1 experiment table
│   └── workflow.ts        ← 4 workflow tables + MVs
└── __tests__/
    ├── docker-compose.replicated.yml  ← Local 2-replica test cluster
    └── *.test.ts                      ← 599 tests
```

### Helm Hook

```yaml
# abl-platform-deploy/helm/abl-platform/values.yaml
runtime:
  seedMigrateOps:
    clickhouseInit:
      enabled: true
      hookWeight: '-15' # Between migrate (-20) and seed (-10)
      activeDeadlineSeconds: 300
      command:
        - tsx
        - packages/database/src/clickhouse-schemas/cli.ts
        - init
```

### Safety Guarantees

- `CREATE TABLE IF NOT EXISTS` → never drops existing tables
- `ALTER TABLE ADD COLUMN IF NOT EXISTS` → never modifies existing columns
- `EXCHANGE TABLES` → atomic swap, no moment where table is missing
- Shadow-copy verification → row count must match before swap
- `_old` backups → 7-day retention for rollback
- Redis lock → prevents concurrent reconcile runs
- Downgrade protection → never auto-downgrades Replicated → non-replicated

---

## Kubernetes Commands Reference

### View PreSync Job Status

```bash
# List all PreSync jobs
kubectl get jobs -n <namespace> | grep -E "migrate|clickhouse-init|seed"

# Watch the ClickHouse init job
kubectl get jobs -n <namespace> -w | grep clickhouse-init

# View init job logs
kubectl logs job/<release>-clickhouse-init -n <namespace>

# View failed job logs (if hook failed)
kubectl logs job/<release>-clickhouse-init -n <namespace> --previous
```

### Run CLI Commands Ad-Hoc

```bash
# --- Status (read-only, safe to run anytime) ---
kubectl run ch-status --rm -it -n <namespace> \
  --image=<registry>/abl-seed-migrate-ops:<tag> \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "ch-status",
        "image": "<registry>/abl-seed-migrate-ops:<tag>",
        "command": ["tsx", "packages/database/src/clickhouse-schemas/cli.ts", "status"],
        "envFrom": [
          {"secretRef": {"name": "<release>-db-secrets", "optional": true}},
          {"configMapRef": {"name": "<release>-runtime-config", "optional": true}}
        ]
      }]
    }
  }'

# --- Status (simpler — if you have port-forward) ---
kubectl port-forward svc/<release>-clickhouse 8124:8123 -n <namespace> &
CLICKHOUSE_URL=http://localhost:8124 CLICKHOUSE_DATABASE=abl_platform \
  npx tsx packages/database/src/clickhouse-schemas/cli.ts status
kill %1  # cleanup port-forward

# --- Init (create tables — safe, idempotent) ---
kubectl run ch-init --rm -it -n <namespace> \
  --image=<registry>/abl-seed-migrate-ops:<tag> \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "ch-init",
        "image": "<registry>/abl-seed-migrate-ops:<tag>",
        "command": ["tsx", "packages/database/src/clickhouse-schemas/cli.ts", "init"],
        "envFrom": [
          {"secretRef": {"name": "<release>-db-secrets", "optional": true}},
          {"configMapRef": {"name": "<release>-runtime-config", "optional": true}}
        ]
      }]
    }
  }'

# --- Reconcile (engine migration — requires maintenance window) ---
kubectl run ch-reconcile --rm -it -n <namespace> \
  --image=<registry>/abl-seed-migrate-ops:<tag> \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "ch-reconcile",
        "image": "<registry>/abl-seed-migrate-ops:<tag>",
        "command": ["tsx", "packages/database/src/clickhouse-schemas/cli.ts", "reconcile"],
        "env": [
          {"name": "CLICKHOUSE_ENGINE_MIGRATION", "value": "execute"}
        ],
        "envFrom": [
          {"secretRef": {"name": "<release>-db-secrets", "optional": true}},
          {"configMapRef": {"name": "<release>-runtime-config", "optional": true}}
        ]
      }]
    }
  }'
```

### Maintenance Window Commands

```bash
# Scale down writer pods before reconcile
kubectl scale deployment/<release>-runtime --replicas=0 -n <namespace>
kubectl scale deployment/<release>-pipeline-engine --replicas=0 -n <namespace>
kubectl scale deployment/<release>-search-ai --replicas=0 -n <namespace>
kubectl scale deployment/<release>-search-ai-runtime --replicas=0 -n <namespace>
kubectl scale deployment/<release>-workflow-engine --replicas=0 -n <namespace>

# Wait for pods to terminate
kubectl wait --for=delete pod -l app.kubernetes.io/name=abl-platform,app.kubernetes.io/component=runtime -n <namespace> --timeout=120s

# ... run reconcile ...

# Scale back up
kubectl scale deployment/<release>-runtime --replicas=2 -n <namespace>
kubectl scale deployment/<release>-pipeline-engine --replicas=2 -n <namespace>
kubectl scale deployment/<release>-search-ai --replicas=1 -n <namespace>
kubectl scale deployment/<release>-search-ai-runtime --replicas=1 -n <namespace>
kubectl scale deployment/<release>-workflow-engine --replicas=1 -n <namespace>
```

### ClickHouse Direct Access

```bash
# Port-forward to ClickHouse
kubectl port-forward svc/<release>-clickhouse 8124:8123 -n <namespace>

# Query via curl
curl -s "http://localhost:8124/" --data "SELECT name, engine FROM system.tables WHERE database='abl_platform' AND name NOT LIKE '.inner%' ORDER BY name FORMAT PrettyCompact"

# Check replication status
curl -s "http://localhost:8124/" --data "SELECT count() FROM system.replicas WHERE database='abl_platform'"

# Check table row counts
curl -s "http://localhost:8124/" --data "SELECT name, total_rows, formatReadableSize(total_bytes) AS size FROM system.tables WHERE database='abl_platform' AND name NOT LIKE '.inner%' AND engine != 'MaterializedView' ORDER BY total_bytes DESC LIMIT 10 FORMAT PrettyCompact"

# Check cluster topology
curl -s "http://localhost:8124/" --data "SELECT * FROM system.clusters WHERE cluster != 'default' FORMAT PrettyCompact"

# Check Keeper health
curl -s "http://localhost:8124/" --data "SELECT count() FROM system.zookeeper WHERE path='/'"

# Check _schema_audit_log
curl -s "http://localhost:8124/" --data "SELECT command, timestamp, duration_ms FROM abl_platform._schema_audit_log ORDER BY timestamp DESC LIMIT 10 FORMAT PrettyCompact"
```

### Debugging Replicated Environments

```bash
# Check tables on both replicas (port-forward to each)
kubectl port-forward pod/<release>-clickhouse-shard-0-0 8124:8123 -n <namespace> &
kubectl port-forward pod/<release>-clickhouse-shard-0-1 8125:8123 -n <namespace> &

# Compare table counts
echo "R0: $(curl -s "http://localhost:8124/" --data "SELECT count() FROM system.tables WHERE database='abl_platform' AND name NOT LIKE '.inner%'")"
echo "R1: $(curl -s "http://localhost:8125/" --data "SELECT count() FROM system.tables WHERE database='abl_platform' AND name NOT LIKE '.inner%'")"

# Compare engines
curl -s "http://localhost:8124/" --data "SELECT engine, count() cnt FROM system.tables WHERE database='abl_platform' AND name NOT LIKE '.inner%' AND engine != 'MaterializedView' GROUP BY engine ORDER BY engine FORMAT TabSeparated"
curl -s "http://localhost:8125/" --data "SELECT engine, count() cnt FROM system.tables WHERE database='abl_platform' AND name NOT LIKE '.inner%' AND engine != 'MaterializedView' GROUP BY engine ORDER BY engine FORMAT TabSeparated"

# Check replication lag
curl -s "http://localhost:8124/" --data "SELECT table, is_leader, queue_size, inserts_in_queue, merges_in_queue FROM system.replicas WHERE database='abl_platform' AND queue_size > 0 FORMAT PrettyCompact"

# Cleanup port-forwards
kill %1 %2
```

### Redis Lock Management

```bash
# Port-forward to Redis
kubectl port-forward svc/<release>-redis-master 6379:6379 -n <namespace>

# Check if lock exists
redis-cli GET clickhouse:schema:reconcile:lock

# Clear stale lock (if process crashed)
redis-cli DEL clickhouse:schema:reconcile:lock

# Check lock TTL
redis-cli TTL clickhouse:schema:reconcile:lock
```

### Local Development

```bash
# Start replicated test cluster (for testing reconcile flow)
cd packages/database/src/clickhouse-schemas/__tests__
docker compose -f docker-compose.replicated.yml up -d
# Replicas: localhost:18123 (R1), localhost:28123 (R2)

# Start Redis (for lock testing)
docker run -d --name ch-test-redis -p 6379:6379 redis:7-alpine

# Run CLI against local cluster
CLICKHOUSE_URL=http://localhost:18123 CLICKHOUSE_DATABASE=abl_platform \
  CLICKHOUSE_REPLICATED=true \
  npx tsx packages/database/src/clickhouse-schemas/cli.ts status

# Tear down
docker compose -f docker-compose.replicated.yml down -v
docker rm -f ch-test-redis
```
