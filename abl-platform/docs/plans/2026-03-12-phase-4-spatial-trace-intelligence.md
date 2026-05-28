# Phase 4: Spatial Trace Intelligence (STI) — Consolidated Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a parallel, numerical tracing system for platform engineers that captures code path coordinates, resource vectors, and config hashes — enabling cross-tenant system diagnostics without exposing customer content.

**Status:** Phase 4 of 4. Depends on Phases 1-3 being complete.

**Source document:** `docs/plans/2026-03-11-spatial-trace-intelligence-design.md` (phases 0a-3, 20 investigation modes)

**Prerequisites:**

- **Phase 1**: `getCurrentTraceId()` available everywhere, `channel_response_sent` exit events
- **Phase 2**: `tracer.activeSpan()` for span-level coordinate attribution (optional enhancement)
- **Phase 3**: `platform_events` is the single ClickHouse source, span trees queryable

## Architecture

**Two-plane model:**

| Plane       | What                                                            | Data                                                                   |
| ----------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Application | Domain topology: channel → agent → workflow → tool/LLM/SearchAI | Integer coordinates, path strings                                      |
| System      | Infrastructure behavior: pod, queue latency, DB, Redis, HTTP    | Resource vectors `[latency_us, throughput, error_bit, saturation_pct]` |

**Three-layer data model:**

| Layer                   | When                             | Cost                  |
| ----------------------- | -------------------------------- | --------------------- |
| 1. Always-On Collection | Phase 0a-1 (inline, every trace) | Median <2KB per STR   |
| 2. Learned Embeddings   | Phase 2 (batch, 1-5% sampled)    | Periodic GPU/CPU job  |
| 3. Causal Model         | Future research (not committed)  | Dedicated ML capacity |

**Key design principle:** STI stores NO text/PII by construction — only numerical coordinates, resource vectors, and config hashes. This is structurally stronger than RBAC.

## Integration with `@agent-platform/shared-observability`

1. `tracePath()` reads `traceId` from `getCurrentTraceId()` — no parameter drilling
2. System plane hooks into `createObservabilityMiddleware`'s `recordMetrics` callback
3. Cross-service propagation reuses W3C `traceparent` header
4. BullMQ async boundaries carry `traceId` in job payloads
5. STR buffer keyed by `traceId` from ALS, flushed to ClickHouse

---

## STI Phase 0a: Foundation (Top 10 Hot Paths)

### Task 1: Create STI package and taxonomy

**New files:**

- `packages/sti/package.json` — new workspace package
- `packages/sti/src/taxonomy.json` — controlled vocabulary for path strings
- `packages/sti/src/taxonomy.ts` — type-safe taxonomy access
- `packages/sti/src/index.ts` — barrel export

**Steps:**

1. Create package with dependencies on `@agent-platform/shared-observability`, `@abl/compiler/platform`
2. Define initial taxonomy covering top 10 hot paths:
   ```
   runtime/executor/agent-enter
   runtime/executor/agent-exit
   runtime/executor/llm-call
   runtime/executor/tool-call
   runtime/executor/flow/step-entry
   runtime/executor/flow/step-exit
   runtime/executor/flow/transition
   runtime/executor/decision
   runtime/executor/handoff
   runtime/executor/delegate
   ```
3. Add `COPY packages/sti/package.json packages/sti/package.json` to these Dockerfiles (they use individual COPY lines):
   - `apps/runtime/Dockerfile`
   - `apps/studio/Dockerfile`
   - `apps/admin/Dockerfile`
   - `apps/search-ai/Dockerfile`
   - `apps/search-ai-runtime/Dockerfile`
   - `apps/multimodal-service/Dockerfile`
   - `packages/pipeline-engine/Dockerfile`
     Note: `apps/workflow-engine/Dockerfile` copies entire `packages/` dir; Go-based Dockerfiles don't need this.
4. Build: `pnpm build --filter=@agent-platform/sti`
5. Commit: `feat(sti): create STI package with initial taxonomy`

---

### Task 2: Implement `tracePath()` HOF wrapper

**New file:** `packages/sti/src/trace-path.ts`

**Steps:**

1. Implement the core HOF:

   ```typescript
   import { getCurrentTraceId } from '@abl/compiler/platform/observability';

   function tracePath<T extends (...args: any[]) => Promise<any>>(path: string, fn: T): T {
     if (!STI_ENABLED) return fn;
     const traced = async function (this: any, ...args: any[]) {
       const traceId = getCurrentTraceId();
       if (!traceId) return fn.apply(this, args); // no trace context — skip silently
       const entry = strBuffer.recordEntry(traceId, path);
       try {
         const result = await fn.apply(this, args);
         entry.markSuccess();
         return result;
       } catch (err) {
         entry.markError();
         throw err;
       }
     } as unknown as T;
     return traced;
   }
   ```

2. Performance constraint: `tracePath()` wrapper MUST complete in <10 microseconds
3. Kill switch: `STI_ENABLED` env var (default: `false` in Phase 0a)
4. Exception safety: wrapper MUST NOT propagate its own exceptions
5. Write benchmark tests
6. Commit: `feat(sti): implement tracePath() HOF wrapper with <10us overhead`

---

### Task 3: Implement STR ring buffer

**New file:** `packages/sti/src/str-buffer.ts`

**Steps:**

1. Implement per-trace ring buffer:
   - Key: `traceId`
   - Hard cap: 10,000 entries maximum (drop oldest when full)
   - TTL: entries older than 5 minutes are evictable
   - Never block the hot path
2. `recordEntry(traceId, path)` → returns entry handle with `markSuccess()` / `markError()` / `recordDuration()`
3. `flush(traceId)` → returns serialized STR for ClickHouse write
4. Circuit breaker: after N consecutive flush failures (default: 5), stop writes for M seconds (default: 30)
5. Emit metric `sti.flush.circuit_open` on circuit open
6. Write unit tests
7. Commit: `feat(sti): implement STR ring buffer with circuit breaker`

---

### Task 4: Create `spatial_trace_records` ClickHouse table

**Files:**

- Modify: `packages/database/src/clickhouse-schemas/init.ts`
- Modify: `scripts/clickhouse-init/01-init.sql`

**Steps:**

1. Create table DDL (must use `ReplicatedMergeTree` — `init.ts` downgrades to `MergeTree()` for dev):

   ```sql
   CREATE TABLE IF NOT EXISTS abl_platform.spatial_trace_records (
     trace_id          String               CODEC(ZSTD(1)),
     segment_id        String DEFAULT '0'   CODEC(ZSTD(1)),
     tenant_id         String               CODEC(ZSTD(1)),
     project_id        String               CODEC(ZSTD(1)),
     agent_id          String DEFAULT ''     CODEC(ZSTD(1)),
     config_hash       String               CODEC(ZSTD(1)),
     code_version      String               CODEC(ZSTD(1)),
     ir_schema_version UInt16               CODEC(T64, ZSTD(1)),
     deploy_id         String               CODEC(ZSTD(1)),
     application_plane Array(Tuple(
       depth UInt8,
       taxonomy_path String,
       timestamp DateTime64(3),
       duration_us UInt64,
       outcome String,
       metadata String
     ))                                     CODEC(ZSTD(3)),
     system_plane Array(Tuple(
       component String,
       latency_us UInt64,
       throughput Float32,
       error_bit UInt8,
       saturation_pct Float32
     ))                                     CODEC(ZSTD(3)),
     timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
     _enc              String DEFAULT ''     CODEC(ZSTD(1)),

     INDEX idx_trace       trace_id    TYPE bloom_filter GRANULARITY 4,
     INDEX idx_config_hash config_hash TYPE bloom_filter GRANULARITY 4
   ) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.spatial_trace_records', '{replica}')
   ORDER BY (tenant_id, project_id, trace_id, timestamp)
   TTL toDateTime(timestamp) + INTERVAL 90 DAY DELETE
   SETTINGS
     index_granularity = 8192,
     merge_with_ttl_timeout = 86400;
   ```

2. Add Buffer engine table in front for batch insert performance (optional optimization)
3. Bloom filter indexes on `trace_id` and `config_hash` are included in the DDL above
4. Build: `pnpm build --filter=@agent-platform/database`
5. Commit: `feat(database): add spatial_trace_records ClickHouse table`

---

### Task 5: Create config hash computation

**New file:** `packages/sti/src/config-hash.ts`

**Steps:**

1. Implement `computeConfigHash(agentDSL, tenantConfig?)`:
   - Phase 0a: single hash (`config_hash_full`) — SHA-256 of agent DSL + tenant config structure
   - Phase 1+: hierarchical (`config_hash_full` + `config_hash_tenant`)
2. Hash only structural configuration — NOT conversation content
3. Cache hash per deploy (config doesn't change mid-deploy)
4. Write unit tests
5. Commit: `feat(sti): implement config hash computation`

---

### Task 6: Instrument top 10 hot paths

**Files:**

- Modify: `apps/runtime/src/services/runtime-executor.ts` — wrap key methods with `tracePath()`
- Modify: `apps/runtime/src/services/trace-emitter.ts` — add STR entry for each emitted event

**Steps:**

1. Wrap the 10 taxonomy paths identified in Task 1 with `tracePath()`. Since `RuntimeExecutor` is a class, use `tracePath()` inside methods rather than wrapping at module level:
   ```typescript
   // Example: inside createSessionFromResolved or the agent execution path
   const result = await tracePath('runtime/executor/agent-enter', async () => {
     return this.runAgentLogic(session, ...args);
   })();
   ```
   Key methods to instrument in `runtime-executor.ts`: `createSessionFromResolved`, `initializeSession`, and the LLM/tool call paths. Also instrument `trace-emitter.ts` event emission points.
2. Wire STR flush to `channel_response_sent` event (from Phase 1 Task 11) — when the exit event fires, flush the STR buffer for that traceId
3. Verify kill switch works: `STI_ENABLED=false` → no STR recording
4. Build and test
5. Commit: `feat(runtime): instrument top 10 hot paths with tracePath()`

---

### Task 7: STR flush to ClickHouse

**New file:** `packages/sti/src/str-writer.ts`

**Steps:**

1. Implement flush handler that triggers on `channel_response_sent`
2. Read buffered STR entries for the completed trace
3. Serialize to ClickHouse row format
4. Write via existing `BufferedClickHouseWriter` pattern (fire-and-forget)
5. Handle flush failures via circuit breaker
6. Write integration test (mock ClickHouse)
7. Commit: `feat(sti): implement STR flush to ClickHouse`

---

### Task 8: Version vector stamping

**New file:** `packages/sti/src/version-vector.ts`

**Steps:**

1. Capture at startup: `{ code: process.env.GIT_SHA || pkg.version, ir_schema: IR_SCHEMA_VERSION, deploy_id: process.env.DEPLOY_ID }`
2. Stamp on every STR at flush time
3. Commit: `feat(sti): add version vector stamping to STR`

---

### Task 9: Verification

**Steps:**

1. Build everything: `pnpm build`
2. Run all tests: `pnpm test`
3. Manual verification with `STI_ENABLED=true`:
   - Run a session → query `spatial_trace_records` → verify STR exists with correct `trace_id`, coordinates
   - Verify <10us overhead: no observable latency increase
   - Verify kill switch: `STI_ENABLED=false` → no rows in `spatial_trace_records`
   - Verify circuit breaker: kill ClickHouse → verify STR recording continues (buffered), circuit opens after 5 failures

---

## STI Phase 1: Full Coverage + Integer Coordinates (future)

> Phase 1 ships only after Phase 0a proves value across 50+ deploys.

**Tasks (high-level):**

1. Build-time taxonomy scanner — assign sequential integer coordinates at compile time
2. Expand instrumentation from 10 → all executor/service/handler paths
3. Hierarchical config hashes (`config_hash_full` + `config_hash_tenant`)
4. System plane resource vectors from instrumented client wrappers (MongoDB, Redis, HTTP)
5. `config_snapshots` ClickHouse table — keyed by `config_hash`, structural config only
6. Basic CLI query tool for platform engineers

---

## STI Phase 2: Learned Embeddings (future)

> Ships only after Phase 1 proves value AND ML engineering capacity is available.

**Tasks (high-level):**

1. Behavioral embeddings per taxonomy node (batch computation on 1-5% sample)
2. Configuration embeddings (project config → vector space)
3. Baseline trajectory distributions per config hash
4. Cluster centroids for known execution patterns
5. Anomaly detection: distance from nearest cluster centroid
6. ClickHouse vector columns for cosineDistance queries

---

## STI Phase 3: Causal Model (future research)

> Listed for completeness. Not a committed phase.

- Causal Bayesian Network over system components
- Counterfactual simulation
- Root cause ranking with calibrated confidence scores
- Requires "known answer" test set and engineer feedback loop

---

## 20 Investigation Modes (from design doc)

STI supports 20 investigation modes across 4 categories, all queryable from `spatial_trace_records`:

**Single-trace (modes 1-5):** path visualization, resource profile, component breakdown, config context, version comparison

**Cross-trace patterns (modes 6-10):** config-hash cohort analysis, temporal regression detection, component hotspot identification, error correlation, performance distribution

**System-wide (modes 11-15):** component saturation ranking, cross-tenant impact analysis, deploy regression detection, capacity planning, SLO attribution

**Advanced (modes 16-20):** causal root cause (Phase 3), config optimization suggestions, predictive scaling, anomaly classification, fleet-wide health scoring

---

## Dependency Graph

```
Phase 0a:
  Task 1 (package + taxonomy) ── Task 2 (tracePath) ── Task 6 (instrument hot paths)
  Task 3 (STR buffer) ──────────────────────────────── Task 6
  Task 4 (ClickHouse table) ── Task 7 (STR flush)
  Task 5 (config hash) ─────── Task 8 (version vector) ── Task 7
  Task 9 (verification) ── depends on all

Phase 1: depends on Phase 0a proving value
Phase 2: depends on Phase 1 + ML capacity
Phase 3: future research
```

**Estimated scope for Phase 0a: ~8 new files, ~600 LOC, 9 tasks**

---

## Relationship to Other Phases

- **Phase 1 (Trace Readiness)**: STI reads `traceId` from the ALS that Phase 1 wires. `channel_response_sent` (Phase 1 Task 11) serves as the STR flush trigger.
- **Phase 2 (Span Model Fix)**: `tracePath()` can optionally read `tracer.activeSpan()` for span-level coordinate attribution (richer data, not required).
- **Phase 3 (Trace Event Consolidation)**: STI's `spatial_trace_records` is a separate table from `platform_events` — different audiences, different data model, different retention. But both share the same `trace_id` for cross-referencing.

## Operational Model

| Concern            | Approach                                                                             |
| ------------------ | ------------------------------------------------------------------------------------ |
| Kill switch        | `STI_ENABLED=false` env var — all `tracePath()` become no-ops                        |
| Performance budget | <10us per `tracePath()` call, benchmarked                                            |
| Storage cost       | Median <2KB per STR, 90-day TTL, $5-50/month estimated                               |
| Circuit breaker    | 5 consecutive flush failures → 30s pause → retry                                     |
| Monitoring         | `sti.flush.circuit_open`, `sti.str.buffer_full`, `sti.tracepath.overhead_us` metrics |
| Access control     | Platform-team-only — no tenant-scoped access needed (no PII in STR)                  |

---

## Plan Review Notes

**Reviewed:** 2026-03-12 (2 passes: accuracy verification + completeness/correctness)

### Issues Found and Fixed

1. **Wrong import path for `getCurrentTraceId`** (Task 2): Was `@abl/compiler/platform`, corrected to `@abl/compiler/platform/observability`. The function is exported from `packages/compiler/src/platform/observability/index.ts`.

2. **ClickHouse DDL did not match existing patterns** (Task 4):
   - Changed `MergeTree()` to `ReplicatedMergeTree(...)` with replication path — `init.ts` downgrades to `MergeTree()` for dev environments at runtime.
   - Added CODEC annotations on all columns to match existing table conventions (ZSTD(1) for strings, DoubleDelta+ZSTD(1) for timestamps, T64+ZSTD(1) for integers, ZSTD(3) for array/nested data).
   - Added `merge_with_ttl_timeout = 86400` SETTINGS to match existing tables.
   - Fixed TTL syntax: `toDateTime(timestamp) + INTERVAL 90 DAY DELETE` (needs `toDateTime()` wrapper and explicit `DELETE` action).
   - Moved bloom filter indexes into the CREATE TABLE DDL (inline, matching existing patterns).

3. **Dockerfile list was generic** (Task 1): Replaced "Add to Dockerfiles" with explicit list of 7 Dockerfiles that use individual `COPY packages/*/package.json` lines. Noted that `workflow-engine` copies entire `packages/` dir and Go-based Dockerfiles are not applicable.

4. **Non-existent method reference** (Task 6): `originalExecuteAgent` does not exist in `runtime-executor.ts`. Corrected to show class-method-compatible `tracePath()` usage pattern and listed actual methods to instrument: `createSessionFromResolved`, `initializeSession`, and LLM/tool call paths.

### Verification Notes

- **Taxonomy**: 10 paths listed, count is correct. Covers agent enter/exit, LLM call, tool call, flow step entry/exit/transition, decision, handoff, delegate.
- **STR buffer concurrency**: Design is sound — keyed by `traceId` from ALS, each request has its own traceId, so concurrent traces are naturally isolated.
- **ClickHouse query efficiency**: ORDER BY `(tenant_id, project_id, trace_id, timestamp)` supports primary query patterns (tenant-scoped listing, project filtering, trace lookup, time range).
- **`channel_response_sent` event**: Confirmed exists in `apps/runtime/src/types/index.ts` (line 125) and `apps/runtime/src/services/channel-trace-utils.ts`. STR flush trigger is valid.
- **`BufferedClickHouseWriter`**: Confirmed exists in `packages/database/src/clickhouse.ts` and used by multiple stores. Task 7 reference is valid.
- **`@agent-platform/shared-observability`**: Exports `Tracer`, `Span` from `/tracing` subpath. No new exports needed for STI.
