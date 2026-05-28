# MongoDB Cleanup Audit — agents-dev (abl-platform)

**Date:** 2026-04-15
**Database:** abl-platform on abl-platform-dev-mongodb (agents-dev cluster)
**Operator:** saikumar.shetty@kore.com
**Script:** `benchmarks/scripts/cleanup-bench-projects.js`

## Summary

Removed ~16M stale documents (~7.3 GB logical data) from the `abl-platform` database on agents-dev. The cleanup targeted two categories of waste:

1. **Benchmark/stress-test project data** — 153 projects created by k6 saturation tests (`bench-sat*`, `stress-test*`) with their sessions, messages, and child resources.
2. **Auth audit log spam** — 12.8M auth event logs (99.9% of audit_logs) that recorded every token validation, failed login, and WebSocket reconnect.

## Pre-Cleanup State

| Metric             | Value      |
| ------------------ | ---------- |
| Total documents    | 18,913,953 |
| Total data size    | 11,252 MB  |
| Total storage size | 10,078 MB  |
| Total index size   | 7,262 MB   |
| Collections        | 188        |

### Top 5 collections by data size

| Collection           | Docs       | Data MB | Storage MB | Index MB |
| -------------------- | ---------- | ------- | ---------- | -------- |
| audit_logs           | 12,810,870 | 4,464   | 1,275      | 2,878    |
| pipeline_run_records | 2,567,870  | 3,005   | 629        | 661      |
| messages             | 2,712,545  | 1,825   | 1,097      | 1,684    |
| session_states       | 467,304    | 1,597   | 6,791      | 869      |
| sessions             | 336,853    | 326     | 259        | 1,150    |

### Notable anomaly

`session_states` had a 4.3x storage bloat ratio (1,597 MB data → 6,791 MB storage), indicating heavy in-place updates and WiredTiger fragmentation.

## What Was Deleted

### Part A — Benchmark/Stress-Test Projects

153 projects matching `^bench-sat` or `^stress-test` name prefixes, created between 2026-04-01 and 2026-04-15 across these tenants:

- `tenant-dev-001`
- `019d6254-577f-7f33-ba4b-0ebb768ab20c`
- `019d6259-92e6-724f-aec8-0b4807519445`
- `019d6259-b711-7c96-a293-f5bf87ad86eb`
- `019d6259-bb36-772f-bf15-6008512cc194`
- `019d6259-bf77-7fae-bb7c-645248231c0d`
- `019d6259-c346-7550-86bd-4a50d5cf7027`

| Collection          | Docs Deleted  |
| ------------------- | ------------- |
| messages            | 2,695,476     |
| session_states      | 294,090       |
| sessions            | 294,108       |
| project_agents      | 23            |
| project_members     | 48            |
| variable_namespaces | 153           |
| model_configs       | 146           |
| agent_model_configs | 152           |
| dek_registry        | 154           |
| eval_runs           | 1             |
| eval_evaluators     | 3             |
| eval_scenarios      | 3             |
| eval_sets           | 1             |
| eval_personas       | 3             |
| projects            | 153           |
| **Part A Total**    | **3,284,514** |

**Deletion order:** messages → session_states → sessions → child collections → projects (dependency-safe).

**Runtime:** 2.9 minutes.

### Part B — Auth Audit Log Spam

Deleted ONLY 3 action types from `audit_logs` where `collectionName: null`:

| Action               | Docs Deleted   | Description                                           |
| -------------------- | -------------- | ----------------------------------------------------- |
| auth.user.success    | 10,940,912     | Every successful token validation (~250K/day)         |
| authorization:denied | 1,090,831      | Expired WebSocket reconnect attempts from cluster IPs |
| auth.user.failure    | 752,762        | Failed login/auth attempts                            |
| **Part B Total**     | **12,784,505** |                                                       |

**Preserved (verified before and after):**

| Category                                              | Before | After  | Status                            |
| ----------------------------------------------------- | ------ | ------ | --------------------------------- |
| CRUD audit docs (collectionName != null)              | 10,016 | 10,017 | OK (+1 new write during cleanup)  |
| Non-auth action docs (tool calls, project CRUD, etc.) | 19,069 | 19,076 | OK (+7 new writes during cleanup) |

**Safety measures executed:**

1. Pre-delete cross-check: keep + delete = total (drift: 15 docs, tolerance: 1000)
2. Chunked deletes in 200K batches to avoid replica set oplog pressure
3. Post-delete verification confirmed zero preserved docs were lost

**Runtime:** 8.7 minutes.

### Audit Log Composition (pre-cleanup)

The 12.8M audit_logs with `collectionName: null` were 99.9% auth event spam:

| Action               | Count      | %     |
| -------------------- | ---------- | ----- |
| auth.user.success    | 10,940,016 | 85.5% |
| authorization:denied | 1,089,455  | 8.5%  |
| auth.user.failure    | 752,762    | 5.9%  |
| All other actions    | ~19,000    | 0.1%  |

Date range: 2026-02-24 → 2026-04-15 (50 days).

## Post-Cleanup State

| Metric             | Before     | After     | Freed                |
| ------------------ | ---------- | --------- | -------------------- |
| Total documents    | 18,913,953 | 3,079,790 | **15,834,163 (84%)** |
| Total data size    | 11,252 MB  | 3,987 MB  | **7,265 MB (64%)**   |
| Total storage size | 10,078 MB  | 10,788 MB | Not reclaimed\*      |
| Total index size   | 7,262 MB   | 9,049 MB  | Not reclaimed\*      |

\*WiredTiger does not release disk space after deletes. `compact` must be run per collection.

### Collections with significant waste (post-cleanup)

| Collection     | Data MB | Storage MB | Index MB | Waste % |
| -------------- | ------- | ---------- | -------- | ------- |
| messages       | 15      | 1,910      | 2,111    | 99.2%   |
| audit_logs     | 11      | 1,499      | 4,397    | 99.8%   |
| session_states | 622     | 6,420      | 823      | 90.3%   |
| sessions       | 42      | 248        | 1,022    | 83.0%   |

## Remaining Large Collection

`pipeline_run_records` (2.8M docs, 3,261 MB) was **not touched** — it has no `projectId` or `sessionId` field. Records are keyed by `pipelineId` (builtin analyzers: sentiment, friction, guardrail, hallucination). Cleanup requires a different strategy (e.g., TTL-based or date-range deletion).

## Script Details

- **Location:** `benchmarks/scripts/cleanup-bench-projects.js`
- **Mode:** Dry-run by default (`DRY_RUN=true`), pass `--eval 'var DRY_RUN=false'` for live execution
- **Strategy:**
  - Part A: Single `deleteMany` calls (all `$in` arrays fit under 16MB BSON limit)
  - Part B: 200K-doc chunked deletes (500K was tried but hit BSON `RangeError`)
- **Reusable:** Script dynamically queries project names at runtime — can be re-run when new benchmark projects accumulate

## Compact — Disk Space Reclamation (All 3 Replica Set Members)

WiredTiger does not release disk space after `deleteMany`. We ran `compact` on all 3 replica set members to reclaim disk across the entire set. Compact was run using `root` credentials (`abl-app` lacks the `compact` privilege).

**Replica set topology:**

- `mongodb-0` — PRIMARY (compact with `force: true`)
- `mongodb-1` — SECONDARY
- `mongodb-2` — SECONDARY

### mongodb-0 (PRIMARY)

| Collection     | Storage Before | Storage After | Index Before | Index After | Total Freed  | Time  |
| -------------- | -------------- | ------------- | ------------ | ----------- | ------------ | ----- |
| audit_logs     | 1,499 MB       | 20 MB         | 4,389 MB     | 83 MB       | **5,785 MB** | 21.8m |
| messages       | 1,910 MB       | 12 MB         | 2,111 MB     | 108 MB      | **3,901 MB** | 20.1m |
| sessions       | 248 MB         | 8 MB          | 1,022 MB     | 73 MB       | **1,189 MB** | 24.6m |
| session_states | 6,420 MB       | 727 MB        | 823 MB       | 107 MB      | **6,409 MB** | 6.1m  |

### mongodb-1 (SECONDARY)

| Collection     | Storage Before | Storage After | Index Before | Index After | Total Freed  | Time  |
| -------------- | -------------- | ------------- | ------------ | ----------- | ------------ | ----- |
| audit_logs     | 1,520 MB       | 25 MB         | 4,118 MB     | 91 MB       | **5,522 MB** | 16.6m |
| messages       | 2,005 MB       | 17 MB         | 2,020 MB     | 142 MB      | **3,866 MB** | \*    |
| sessions       | 261 MB         | 9 MB          | 1,102 MB     | 77 MB       | **1,277 MB** | 21.9m |
| session_states | 6,770 MB       | 719 MB        | 945 MB       | 316 MB      | **6,680 MB** | 4.9m  |

\*messages compact completed server-side during kubectl timeout; timing unavailable.

### mongodb-2 (SECONDARY)

| Collection     | Storage Before | Storage After | Index Before | Index After | Total Freed  | Time  |
| -------------- | -------------- | ------------- | ------------ | ----------- | ------------ | ----- |
| audit_logs     | 1,480 MB       | 21 MB         | 3,992 MB     | 81 MB       | **5,370 MB** | 17.2m |
| messages       | 17 MB\*        | 17 MB         | 628 MB       | 111 MB      | **517 MB**   | 3.8m  |
| sessions       | 242 MB         | 8 MB          | 1,066 MB     | 74 MB       | **1,226 MB** | 27.9m |
| session_states | 6,957 MB       | 757 MB        | 1,054 MB     | 120 MB      | **7,134 MB** | 22.4m |

\*messages data was already compacted from first run; only indexes needed rebuilding.

### Compact Totals

| Node      | Freed (Storage + Indexes) |
| --------- | ------------------------- |
| mongodb-0 | **16.9 GB**               |
| mongodb-1 | **17.3 GB**               |
| mongodb-2 | **14.2 GB**               |
| **Total** | **~48.4 GB across set**   |

### Issues Encountered

1. **kubectl TCP timeout** — Both secondary compacts timed out during long-running collections (i/o timeout after ~20 min idle). The `compact` command completed server-side despite the client disconnect. Workaround: reconnect and resume remaining collections.
2. **IOPS contention** — Running compact on both secondaries simultaneously doubled wall-clock time per collection due to shared E10 SSD (500 IOPS). Sessions compact took 28 min on mongodb-2 vs 25 min on the primary running alone.

## Final State (post-compact, all nodes)

| Metric                   | Pre-Cleanup  | Post-Delete  | Post-Compact (per node) |
| ------------------------ | ------------ | ------------ | ----------------------- |
| Documents                | 18,913,953   | 3,079,790    | ~3,079,790              |
| Data                     | 11,252 MB    | 3,987 MB     | ~3,987 MB               |
| Storage (per node)       | ~10,000 MB   | ~10,800 MB   | **~800 MB**             |
| Indexes (per node)       | ~8,300 MB    | ~9,000 MB    | **~400 MB**             |
| **Total on disk (each)** | **~18.3 GB** | **~19.8 GB** | **~3.5 GB**             |
| **Replica set total**    | **~55 GB**   | **~59 GB**   | **~10 GB**              |

The entire replica set shrank from **~55 GB to ~10 GB** — an **82% reduction**.

## Recommendations

1. **Add TTL index on `audit_logs`** — auth events have no forensic value beyond 7-14 days at this volume. A TTL index on `createdAt` would prevent re-accumulation (~250K auth events/day = 4.5 GB/50 days).
2. **Add TTL index on `pipeline_run_records`** — 2.8M records with 3.3 GB is the next largest collection. Consider a 30-day retention policy.
3. **Benchmark cleanup automation** — k6 saturation scripts should clean up their projects after each run, or the cleanup script should be scheduled periodically.
4. **Grant `compact` privilege to `abl-app`** — or create a maintenance user with `compact` rights so future compacts don't require root credentials.
5. **Compact secondaries sequentially** — running parallel compacts on members sharing the same storage tier causes IOPS contention and doubles wall-clock time. Compact one secondary at a time.
6. **Increase kubectl exec timeout** — the default TCP idle timeout caused disconnects during long compacts. Consider `--request-timeout=0` or running compact via a mongo shell script on the pod directly.
