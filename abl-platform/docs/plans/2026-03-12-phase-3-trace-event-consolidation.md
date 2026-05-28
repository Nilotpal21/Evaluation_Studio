# Phase 3: Trace Event Consolidation — Consolidated Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the `abl_platform.traces` table and the `trace-bridge.ts` translation layer. All persistent events go to `platform_events` via the EventStore. Memory TraceStore exists only for real-time WebSocket broadcast.

**Status:** Phase 3 of 4. Depends on Phase 1 (Trace Readiness) and Phase 2 (Span Model Fix).

**Source document:** `docs/plans/2026-03-11-trace-event-consolidation.md` (17 tasks across 4 sub-phases)

**Dependencies from Phase 1:**

- `getCurrentTraceId()` / `getCurrentSpanId()` available in all async code paths
- `createObservabilityMiddleware` mounted on all Express servers

**Dependencies from Phase 2:**

- `tracer.emit()` auto-attaches span context — trace-emitter refactor uses this
- Trace-forwarder already rewritten to use Tracer (Phase 2 Task 7 supersedes Phase 3 Task 7c)

**Architecture:** The trace-emitter emits events in the platform event vocabulary (dotted names like `llm.call.completed`) directly. The EventStore writes to `platform_events` in ClickHouse — the single persistent store. `span_id` and `parent_span_id` columns serve Observatory debugging. The `traces` table, `ClickHouseTraceStore`, `trace-bridge.ts`, and all reverse-mapping code are removed.

> **Post-Phase-2 Status (2026-03-12 review):** Many tasks in this plan were completed during Phase 2 implementation or earlier work. Tasks marked **DONE** below require no further action. The remaining work is concentrated in Task 3 (decisionKind alignment), Task 3b (EventRegistry schemas), Task 5 (remaining logDecision migration), Task 7 (Observatory UI normalization), and Tasks 12-14 (testing).

---

## Review Decisions (from source doc)

1. **ClickHouse is mandatory infrastructure** — like MongoDB and Redis. Only remove trace-specific gates; leave `USE_MONGO_CLICKHOUSE` for non-trace features.
2. **Kill `logDecision()`, keep only `emitDecision()`** — migrate 2 compiler runtime callers
3. **Canonical decision field name: `decisionKind`** — 11 values from `trace-helpers.ts`
4. **Decision metadata: `Record<string, unknown>`** with `outcome` + `reasoning` (no typed interfaces per kind)
5. **No backward compatibility** — no backfill, no dual-emit, no feature flags
6. **Fix EventRegistry silent drops** — permissive fallback for unregistered types
7. **Fix Zod schema rejection** — drop snake_case normalization, accept camelCase throughout
8. **Wire trace-forwarder through trace-emitter** — (superseded by Phase 2 Task 7)

---

## Sub-Phase 1: Add span columns + fix field-name mismatch (non-breaking)

### Task 1: Add `span_id` and `parent_span_id` to `platform_events` schema — **DONE**

> **Already completed.** `span_id` and `parent_span_id` columns exist in `init.ts` (lines 292-293), `01-init.sql`, and `platform-events-table.ts`. Bloom filter index `idx_span` is present (line 318). ALTER TABLE migration is idempotent (line 877+). No action needed.

**Files:**

- ~~Modify:~~ `packages/database/src/clickhouse-schemas/init.ts` — already has span columns
- ~~Modify:~~ `scripts/clickhouse-init/01-init.sql` — already has span columns

---

### Task 2: Propagate span_id/parent_span_id through EventStore write path — **DONE**

> **Already completed.** `PlatformEvent` has `span_id` and `parent_span_id` (lines 32-36). `ClickHouseEventRow` maps them (lines 25-26). `toRow()`/`fromRow()` handle the fields (lines 57-58). trace-emitter already imports `TRACE_TO_PLATFORM_TYPE` and writes span context. No action needed.

**Files:**

- ~~Modify:~~ `packages/eventstore/src/schema/platform-event.ts` — already has span fields
- ~~Modify:~~ `packages/eventstore/src/stores/clickhouse/clickhouse-row-mapper.ts` — already maps span fields
- ~~Modify:~~ `packages/eventstore/src/stores/clickhouse/platform-events-table.ts` — already has span columns
- ~~Modify:~~ `apps/runtime/src/services/trace-emitter.ts` — already passes span context

---

### Task 3: Fix decision field-name mismatch

Align `data.kind`, `data.decisionType`, `data.decision_type` → `data.decisionKind` everywhere.

**Files:**

- Modify: `apps/studio/src/components/observatory/SpanTree.tsx:364,482`
- Modify: `apps/studio/src/components/observatory/NodeDetailPanel.tsx:170,352`
- ~~Modify:~~ `apps/studio/src/components/observatory/EventTimeline.tsx:311` — **FILE MOVED** to `_archived/EventTimeline.tsx`; skip unless un-archived
- Modify: `apps/studio/src/components/analytics/TracesExplorerTab.tsx:1661-1662`
- Modify: `apps/studio/src/hooks/useSessionDetail.ts:514`
- Modify: `packages/compiler/src/platform/core/types.ts:319-327`
- Modify: `packages/compiler/src/platform/stores/trace-store.ts:79`
- Modify: `packages/compiler/src/platform/runtimes/digital-runtime.ts:337`
- Modify: `packages/compiler/src/platform/runtimes/workflow-runtime.ts:391`
- Modify: `packages/observatory/src/schema/trace-events.ts:240`
- Modify: `apps/runtime/src/services/execution/trace-forwarder.ts:47-52`

**Steps:**

1. Fix all UI consumers: `data?.kind` → `data?.decisionKind`, `data.decisionType` → `data.decisionKind`, `data.decision_type` → `data.decisionKind`
2. Fix compiler types: `DecisionEvent.data.decisionType` → `decisionKind`, `LogDecisionParams.decisionType` → `decisionKind`
3. Fix compiler runtimes: `logDecision({decisionType: 'routing'})` → `logDecision({decisionKind: 'handoff'})`
4. Build: `pnpm build --filter=studio --filter=@abl/eventstore --filter=@abl/compiler --filter=@abl/observatory`
5. Commit: `fix(observatory): align decision field name to decisionKind across all consumers`

---

### Task 3b: Fix EventRegistry + Zod schemas

**Files:**

- Modify: `packages/eventstore/src/emitter/event-emitter.ts` — permissive fallback
- Modify: 14 schema files in `packages/eventstore/src/schema/events/` — camelCase + `.passthrough()`
- ~~Create:~~ `packages/eventstore/src/schema/events/system-events.ts` — **ALREADY EXISTS** with `system.error` registered (SystemErrorDataSchema + `.passthrough()`)
- Modify: `packages/eventstore/src/schema/events/agent-events.ts` — add `agent.delegate.completed`, fix `AgentDecisionDataSchema`

**Steps:**

1. Make EventEmitter permissive: unregistered types pass through (log debug, don't drop); registered types warn on validation failure but don't drop
2. Verify existing schemas (`system.error` already exists); create `agent.delegate.completed` if missing
3. Update all 14 schema files: snake_case → camelCase field names, add `.passthrough()`
4. **Do NOT add duplicate `register()` calls** — existing schema files self-register as side-effects
5. Build and test: `pnpm build --filter=@abl/eventstore && pnpm test --filter=@abl/eventstore`
6. Commit: `feat(eventstore): update schemas to camelCase, permissive EventEmitter, register missing types`

---

## Sub-Phase 2: Emit dotted event types at source, eliminate trace-bridge

### Task 4: Create canonical event-type mapping module — **DONE**

> **Already completed.** `apps/runtime/src/services/trace-event-types.ts` exists with `TRACE_TO_PLATFORM_TYPE` and `inferCategory()`. trace-emitter already imports from it. No action needed.

---

### Task 5: Refactor trace-emitter to emit platform events directly — **PARTIALLY DONE**

> **Mostly completed.** Bridge loader is gone. trace-emitter already imports `getEventStore`, `TRACE_TO_PLATFORM_TYPE`, `inferCategory` and writes directly to EventStore with span context. The `emitTraceEventAsAnalytics` pattern is gone.
>
> **Remaining work:** `logDecision()` still exists in the compiler package (`trace-store.ts`, `digital-runtime.ts`, `workflow-runtime.ts`). The 8 files referencing `logDecision` need migration to `emitDecision()`. This overlaps with Task 3's field-name alignment.

**Files:**

- ~~Modify:~~ `apps/runtime/src/services/trace-emitter.ts` — already refactored
- Modify: `packages/compiler/src/platform/stores/trace-store.ts` — migrate `logDecision()` callers
- Modify: `packages/compiler/src/platform/runtimes/digital-runtime.ts` — `logDecision` → `emitDecision`
- Modify: `packages/compiler/src/platform/runtimes/workflow-runtime.ts` — `logDecision` → `emitDecision`
- Verify: test files in `packages/compiler/src/__tests__/` that reference `logDecision`

**Steps:**

1. ~~Remove lazy bridge loader~~ — already done
2. ~~Import `getEventStore`, `TRACE_TO_PLATFORM_TYPE`, `inferCategory`~~ — already done
3. ~~Rewrite dual-write section~~ — already done
4. ~~Handle error → `.failed` mapping~~ — already done
5. Migrate remaining `logDecision()` callers in compiler package to `emitDecision()` with `decisionKind`
6. Update test mocks referencing `logDecision`
7. Build and test: `pnpm build --filter=runtime --filter=@abl/compiler && pnpm test --filter=runtime --filter=@abl/compiler`
8. Commit: `refactor(compiler): migrate logDecision callers to emitDecision with decisionKind`

---

### Task 6: Update sessions.ts query layer — single ClickHouse source — **MOSTLY DONE**

> **Largely completed.** `queryClickHouseCanonicalTraces()` is gone. All call sites use `queryClickHousePlatformEvents()` (5 call sites found at lines 732, 870, 1063, 1541, 1688). `isClickHouseTraceEnabled` is gone. `TraceSource` is already `'memory' | 'clickhouse_platform_events'`. `TABLES_NEEDING_ENC_COLUMN` does not include `'traces'`. `ALLOWED_TABLES` in analytics.ts only has `platform_events` and `llm_metrics`.
>
> **Remaining work:** Verify `span_id`/`parent_span_id` are included in SELECT, verify category filter includes `'flow'` and `'system'`, verify LIMIT is appropriate, and verify encryption parity.

**Files:**

- Verify: `apps/runtime/src/routes/sessions.ts` — confirm span columns in SELECT, category filter completeness

**Steps:**

1. ~~Delete `queryClickHouseCanonicalTraces()`~~ — already gone
2. ~~Update call sites~~ — already use `queryClickHousePlatformEvents()`
3. ~~Remove `isClickHouseTraceEnabled`~~ — already gone
4. Verify `span_id`, `parent_span_id` in SELECT clause of `queryClickHousePlatformEvents()`
5. Verify category filter includes `'flow'` and `'system'`
6. Verify LIMIT and encryption parity
7. Build: `pnpm build --filter=runtime`
8. Commit (if changes needed): `fix(runtime): ensure span columns and category filter completeness in sessions queries`

---

### Task 7: Recreate Studio Observatory UI for dotted event types + DecisionCard — **PARTIALLY DONE**

> **Partially completed.** `event-types.ts` and `DecisionCard.tsx` already exist. However, `decisionKind` alignment across UI files is still needed (Task 3 overlap). Several files listed in the original plan do not exist or have moved.
>
> **File corrections:**
>
> - `SessionTimeline.tsx` — **DOES NOT EXIST** (removed or never created)
> - `EventTimeline.tsx` — **ARCHIVED** at `_archived/EventTimeline.tsx` (skip)
> - `SessionSummaryPanel.tsx` — **DOES NOT EXIST** (removed or never created)

**Files:**

- ~~Create:~~ `apps/studio/src/lib/event-types.ts` — **ALREADY EXISTS**
- ~~Create:~~ `apps/studio/src/components/observatory/DecisionCard.tsx` — **ALREADY EXISTS**
- Modify: `apps/studio/src/store/observatory-store.ts` — normalize at ingestion edge
- Modify: `apps/studio/src/components/observatory/SpanTree.tsx`
- Modify: `apps/studio/src/components/observatory/NodeDetailPanel.tsx`
- ~~Modify:~~ ~~`apps/studio/src/components/observatory/SessionTimeline.tsx`~~ — does not exist
- ~~Modify:~~ ~~`apps/studio/src/components/observatory/EventTimeline.tsx`~~ — archived
- Modify: `apps/studio/src/hooks/useSessionDetail.ts` — normalization points
- Modify: `apps/studio/src/components/analytics/TracesExplorerTab.tsx`
- ~~Modify:~~ ~~`apps/studio/src/components/session/SessionSummaryPanel.tsx:519`~~ — does not exist
- Modify: `apps/studio/src/components/observatory/event-colors.ts`
- Modify: `apps/studio/src/utils/replay-trace-events.ts`
- Also check: `apps/studio/src/components/session/OverviewTab.tsx` (has `decisionType` references)
- Also check: `apps/studio/src/lib/label-utils.ts` (has `decisionKind` references — verify correct)

**Steps:**

1. ~~Create `normalizeEventType(type)`~~ — already exists in `event-types.ts`
2. ~~Create `DECISION_KIND_META`~~ — verify exists in `event-types.ts` or `DecisionCard.tsx`
3. ~~Create unified `DecisionCard` component~~ — already exists
4. Normalize at ingestion in `observatory-store.ts addEvent()` — verify MUST store normalized event
5. Normalize in `useSessionDetail.ts` — verify normalization points
6. Update `replay-trace-events.ts formatTraceEventLog()` — normalize before the switch
7. Align `decisionKind` in remaining UI consumers (overlaps with Task 3)
8. Build: `pnpm build --filter=studio`
9. Commit: `feat(studio): complete Observatory UI normalization for dotted event types`

---

### Task 7b: Update pipeline-engine queries to use platform_events — **LIKELY DONE**

> **No `abl_platform.traces` references found** in any pipeline-engine file. Either already migrated to `platform_events` or these services never queried the traces table directly. Verify by reading each file to confirm queries target `platform_events` with dotted event types.

**Files:**

- Verify: `packages/pipeline-engine/src/pipeline/services/conversation-reader.ts`
- Verify: `packages/pipeline-engine/src/pipeline/services/read-message-window.service.ts`
- Verify: `packages/pipeline-engine/src/pipeline/services/compute-tool-effectiveness.service.ts`

**Steps:**

1. Read each file and confirm no traces table references remain
2. Verify event types use dotted notation
3. Verify `JSONExtract*()` usage for camelCase data column fields
4. Build and test: `pnpm build --filter=@abl/pipeline-engine && pnpm test --filter=@abl/pipeline-engine`
5. Commit (if changes needed): `refactor(pipeline-engine): verify platform_events queries use dotted event types`

---

### Task 7c: Wire trace-forwarder through trace-emitter

> **NOTE:** If Phase 2 is complete, this task is already done (Phase 2 Task 7 rewrites trace-forwarder to use Tracer). Skip this task if Phase 2 landed first. If Phase 2 is not yet complete, implement this as a stepping stone.

**Files:**

- Modify: `apps/runtime/src/services/execution/trace-forwarder.ts`

**Steps:**

1. Wire all TraceForwarder methods through `trace-emitter.emit()` instead of direct TraceStore writes
2. Remove `logDecision()` from TraceForwarder (callers use `trace-emitter.emitDecision()`)
3. Rename `decisionType` → `decisionKind` in compiler's `TraceContextManager.logDecision()`
4. Update all test mocks
5. Build and test
6. Commit: `refactor(runtime): wire trace-forwarder through trace-emitter for ClickHouse persistence`

---

## Sub-Phase 3: Remove dead code

### Task 8: Delete ClickHouseTraceStore, singleton, and trace-specific gates — **DONE**

> **Already completed.** `clickhouse-trace-store.ts` and `clickhouse-trace-singleton.ts` do not exist. No references to `isClickHouseTraceEnabled` or `getClickHouseTraceStore` found anywhere in the codebase. `docs/MONGO_CLICKHOUSE_SETUP.md` still exists — consider removing it as a minor cleanup.

**Remaining minor cleanup:**

- Consider deleting `docs/MONGO_CLICKHOUSE_SETUP.md` if it only documents the now-removed traces-specific ClickHouse setup

---

### Task 9: Delete trace-bridge.ts — **DONE**

> **Already completed.** `packages/eventstore/src/migration/trace-bridge.ts` does not exist. The migration `index.ts` only exports `llm-metrics-bridge`. No references to `emitTraceEventAsAnalytics` or `mapTraceEventToPlatformEvent` found.
>
> **Note:** `otel-trace-bridge.ts` files exist in `apps/runtime/` and `apps/workflow-engine/` — these are OpenTelemetry bridges, NOT the EventStore trace-bridge. They are unrelated and should NOT be deleted.

---

### Task 10: Simplify eventstore-singleton — **DONE**

> **Already completed.** `eventstore-singleton.ts` has no `EVENTSTORE_ENABLED` check, no memory backend fallback. It already hardcodes `mode: 'embedded'`, `backend: 'clickhouse'`. WAL recovery and GDPR hooks are present. No action needed.

---

### Task 11: Drop `abl_platform.traces` table from schema — **DONE**

> **Already completed.** No `traces` table DDL exists in `init.ts` or `01-init.sql`. `TABLES_NEEDING_ENC_COLUMN` does not include `'traces'`. `ALLOWED_TABLES` in analytics.ts only contains `['abl_platform.platform_events', 'abl_platform.llm_metrics']`. No `abl_platform.traces` references found in any `.ts` or `.sql` file. No action needed.

---

## Sub-Phase 4: Integration & Real-Data Testing

### Task 12: Trace-emitter direct-emit unit tests

**Files:**

- Modify: `apps/runtime/src/__tests__/trace-emitter.test.ts`

**Steps:**

1. Remove `logDecision()` test blocks and bridge mocks
2. Add `emitDecision()` tests with `decisionKind`
3. Add direct EventStore emit tests: type mapping, error → `.failed`, span context propagation
4. Run: `pnpm test --filter=runtime`
5. Commit: `test(runtime): update trace-emitter tests for direct EventStore emit`

---

### Task 13: Integration tests

**New test files:**

- Trace-forwarder → EventStore integration test
- Observatory rendering from platform_events E2E test
- Materialized views after schema changes test

**Steps:**

1. Write integration test: events emitted via trace-forwarder land in platform_events
2. Write E2E test: Observatory renders correctly from ClickHouse platform_events data
3. Test materialized views with new span columns
4. Run full suite: `pnpm test`
5. Commit: `test: add integration tests for trace event consolidation`

---

### Task 14: Final verification

**Steps:**

1. Build everything: `pnpm build`
2. Run all tests: `pnpm test`
3. Verify no references remain to deleted code:
   - `grep -r "trace-bridge\|ClickHouseTraceStore\|isClickHouseTraceEnabled\|queryClickHouseCanonicalTraces"`
   - `grep -r "data\.kind\b\|data\.decisionType\|data\.decision_type" apps/studio/`
4. Verify `abl_platform.traces` not referenced in any DDL or query

---

## Dependency Graph (Updated)

```
Sub-Phase 1 (non-breaking):
  Task 1 (span columns) ── DONE
  Task 2 (EventStore write path) ── DONE
  Task 3 (decisionKind alignment) ── REMAINING
  Task 3b (EventRegistry + Zod schemas) ── REMAINING (system-events.ts exists, rest TBD)

Sub-Phase 2 (breaking changes):
  Task 4 (type mapping) ── DONE
  Task 5 (trace-emitter refactor) ── PARTIALLY DONE (logDecision migration remaining)
  Task 6 (sessions.ts queries) ── MOSTLY DONE (verify span columns + category filter)
  Task 7 (Studio UI) ── PARTIALLY DONE (DecisionCard + event-types exist, normalization TBD)
  Task 7b (pipeline-engine queries) ── LIKELY DONE (no traces table refs found)
  Task 7c (trace-forwarder) ── SKIP (Phase 2 completed)

Sub-Phase 3 (cleanup):
  Task 8 (delete ClickHouseTraceStore) ── DONE
  Task 9 (delete trace-bridge) ── DONE
  Task 10 (simplify singleton) ── DONE
  Task 11 (drop traces DDL) ── DONE

Sub-Phase 4 (testing):
  Tasks 12-14 ── REMAINING
```

**Revised estimated scope: ~200 lines modified across ~20 files (down from original ~1100 deleted, ~400 added, ~40 files)**

---

## Relationship to Other Phases

- **Phase 1 (Trace Readiness)**: Provides `getCurrentTraceId()` / `getCurrentSpanId()` that Task 5 reads from ALS
- **Phase 2 (Span Model Fix)**: Task 7c is superseded. Task 5's trace-emitter refactor uses `tracer.emit()` if Phase 2 is complete. `buildSpanTree()` from Phase 2 Task 11 replaces the Observatory heuristics before this phase's UI rewrite (Task 7) runs.
- **Phase 4 (STI)**: Depends on `platform_events` being the single source (this phase) so STI can query span trees from one table

---

## Plan Review Notes (2026-03-12)

### Pass 1: Accuracy Verification

| Finding                                     | Severity | Detail                                                                                                                                                                                       |
| ------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task 1 already done                         | High     | `span_id`, `parent_span_id` columns + bloom filter already in `init.ts` (lines 292-293, 318) and `01-init.sql`. ALTER TABLE migration present at line 877+.                                  |
| Task 2 already done                         | High     | `PlatformEvent` has span fields (lines 32-36). `ClickHouseEventRow` + `toRow()`/`fromRow()` already map them. trace-emitter already uses `TRACE_TO_PLATFORM_TYPE`.                           |
| Task 3 EventTimeline.tsx path wrong         | Medium   | Listed as `observatory/EventTimeline.tsx` but file is archived at `observatory/_archived/EventTimeline.tsx`.                                                                                 |
| Task 3b system-events.ts already exists     | Medium   | Plan says "Create" but `system-events.ts` exists with `system.error` registered and `.passthrough()`.                                                                                        |
| Task 4 already done                         | High     | `trace-event-types.ts` already exists and is imported by trace-emitter.                                                                                                                      |
| Task 5 bridge loader gone                   | High     | `loadEventStoreBridge()`/`_eventStoreBridge` no longer exist. trace-emitter directly imports `getEventStore`, `TRACE_TO_PLATFORM_TYPE`, `inferCategory`.                                     |
| Task 5 logDecision still exists             | Medium   | 8 files still reference `logDecision` in compiler package — migration to `emitDecision` is remaining work.                                                                                   |
| Task 6 already migrated                     | High     | `queryClickHouseCanonicalTraces`, `isClickHouseTraceEnabled` do not exist. `TraceSource` is already `'memory' \| 'clickhouse_platform_events'`.                                              |
| Task 7 DecisionCard/event-types exist       | Medium   | Both files already created. `SessionTimeline.tsx` and `SessionSummaryPanel.tsx` do not exist.                                                                                                |
| Task 7b no traces refs in pipeline-engine   | Medium   | No `abl_platform.traces` references found — may already be migrated.                                                                                                                         |
| Task 8 files already deleted                | High     | `clickhouse-trace-store.ts` and `clickhouse-trace-singleton.ts` do not exist. No `isClickHouseTraceEnabled`/`getClickHouseTraceStore` refs.                                                  |
| Task 9 trace-bridge.ts already deleted      | High     | File does not exist. Migration index only exports `llm-metrics-bridge`.                                                                                                                      |
| Task 10 singleton already simplified        | High     | No `EVENTSTORE_ENABLED`, already hardcodes embedded/clickhouse.                                                                                                                              |
| Task 11 traces DDL already gone             | High     | No traces table in `init.ts` or `01-init.sql`. `ALLOWED_TABLES` and `TABLES_NEEDING_ENC_COLUMN` clean.                                                                                       |
| `otel-trace-bridge.ts` != `trace-bridge.ts` | Low      | grep for "trace-bridge" hits `otel-trace-bridge.ts` in runtime and workflow-engine — these are OTel bridges, unrelated to the EventStore trace-bridge that was deleted. Plan should clarify. |

### Pass 2: Completeness and Correctness

| Finding                                                | Detail                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 2 completed most cleanup tasks                   | Tasks 1, 2, 4, 8, 9, 10, 11 are fully done. Task 5 is partially done. Task 6 is mostly done. The plan was written before Phase 2 implementation completed these items.                                                                                                                                                                       |
| `decisionKind` alignment is the primary remaining work | 26 files still reference `decisionType`, `decision_type`, or `data.kind`. This spans compiler types, runtimes, runtime services, studio UI, tests, and mcp-debug. Task 3 is the critical remaining task.                                                                                                                                     |
| Missing files in Task 3 and Task 7                     | `SessionTimeline.tsx`, `SessionSummaryPanel.tsx` do not exist. `EventTimeline.tsx` is archived. Additional files need `decisionKind` fixes: `apps/studio/src/components/session/OverviewTab.tsx`, `apps/studio/src/lib/label-utils.ts`, `apps/runtime/src/services/execution/trace-helpers.ts`, `packages/mcp-debug/src/tools/decisions.ts`. |
| Additional `decisionType` consumers not in plan        | Files missed by the original plan: `apps/runtime/src/types/index.ts`, `apps/studio/src/types/index.ts`, `apps/runtime/src/__tests__/decision-events.test.ts`, `apps/runtime/src/__tests__/guardrails/*.test.ts`, `apps/runtime/src/__tests__/e2e/observatory-api-e2e.test.ts`, `docs/observatory-spec/generate-spec.ts`.                     |
| ClickHouse schema migration is safe                    | The ALTER TABLE ADD COLUMN IF NOT EXISTS pattern is idempotent. Since span columns already exist, no migration concern.                                                                                                                                                                                                                      |
| No risky deletions remain                              | All targeted deletions (trace-bridge, ClickHouseTraceStore, traces DDL) are already done. No further file deletions planned.                                                                                                                                                                                                                 |
| `docs/MONGO_CLICKHOUSE_SETUP.md` still exists          | Task 8 mentioned removing it but it's still present. Minor cleanup item.                                                                                                                                                                                                                                                                     |
| Scope dramatically reduced                             | Original estimate was ~1100 lines deleted, ~400 added, ~40 files. Actual remaining scope is ~200 lines modified across ~20 files, focused on `decisionKind` alignment, schema validation updates, and testing.                                                                                                                               |
