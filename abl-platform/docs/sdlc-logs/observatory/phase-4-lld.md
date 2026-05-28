# Observatory — Phase 4: LLD Log

**Date:** 2026-03-23
**Phase:** Low-Level Design + Implementation Plan
**Status:** COMPLETE

## Clarifying Questions & Decisions

| #   | Question                                                           | Classification | Resolution                                                                                                                            |
| --- | ------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Are SpanTree, WaterfallPanel, NodeDetailPanel already implemented? | ANSWERED       | YES — all three components exist and are wired into TracesTab (DebugTabs.tsx lines 402-473). FIXES.md Phase 3 items are mostly done.  |
| 2   | What UI work actually remains?                                     | ANSWERED       | ContentBlock[] handling, session list filters, CSV export button. The trace UI visualization is further along than FIXES.md suggests. |
| 3   | Should analytics routes be in a separate service?                  | DECIDED        | NO — same Runtime service. Queries hit pre-aggregated MVs (max 365 rows), minimal cost. Extract if query volume grows.                |
| 4   | Which ClickHouse client should analytics use?                      | ANSWERED       | Existing `@clickhouse/client` via `packages/database`. BufferedWriter for writes, direct client for reads.                            |
| 5   | Should prom-client metrics duplicate OTEL metrics?                 | DECIDED        | Separate systems serving different consumers. prom-client has its own counters. Document in runbook.                                  |

## Key Codebase Findings

### TracesTab is Already Wired (FIXES.md Phase 3 Overstatement)

Reading `DebugTabs.tsx` lines 402-473 reveals TracesTab already:

- Reads spans from observatory store
- Computes span summaries (cost, tokens)
- Renders `WaterfallPanel` with span summaries in live mode
- Renders `NodeDetailPanel` in bottom split when span is selected
- `SpanTree.tsx` already has cost columns, decision rendering via DecisionCard, token tooltips

**Impact:** FIXES.md items UI-NEW-2 (WaterfallPanel), UI-NEW-3 (NodeDetailPanel), UI-NEW-13 (SpanTree) are ALREADY IMPLEMENTED. The LLD focuses on the remaining gaps.

### No traces Table in ClickHouse DDL

The `01-init.sql` has no `abl_platform.traces` table. All trace data goes to `abl_platform.platform_events`. The SPEC.md and some docs reference a `traces` table that does not exist in the DDL. The trace fallback chain in `sessions.ts` queries `platform_events`.

### Analytics MVs are Ready

`llm_metrics_hourly_dest` and `llm_metrics_daily_dest` materialized views are deployed with correct tenant/project isolation (ORDER BY includes both). No new tables needed.

## Audit Findings

### Round 1 (Self-Audit)

- CRITICAL: None
- HIGH: FIXES.md Phase 3 items are already implemented — LLD must not propose re-implementing them
- HIGH: Must verify exact ClickHouse client API in packages/database before writing analytics queries
- MEDIUM: prom-client route must be mounted BEFORE auth middleware (Prometheus scrapers don't authenticate)

### Resolution

- Phase 3 items verified as implemented; LLD focuses on remaining gaps (ContentBlock[], filters, CSV, analytics API, Prometheus, health, trace fixes)
- ClickHouse client verified via `packages/database/src/clickhouse.ts`
- Prometheus route mount order documented in Task 5.3

### Round 2 (Architecture Review)

- HIGH: Express route ordering — analytics routes must be registered BEFORE `/:id` parameterized routes to avoid capturing `/analytics` as an ID
- MEDIUM: CSV export should handle large datasets without OOM — consider streaming or pagination

### Resolution

- Task 4.3 explicitly notes route ordering (register before parameterized routes)
- Task 3.1 CSV export is client-side (browser download), data limited to single session events (bounded by TraceStore 500 event cap and CH query limit)

## Artifacts

- `docs/plans/2026-03-23-observatory-impl-plan.md` — Implementation plan with 8 phases, 20+ tasks

## Codebase Verification

- `apps/studio/src/components/observatory/DebugTabs.tsx` lines 402-473: TracesTab already wires WaterfallPanel + NodeDetailPanel
- `apps/studio/src/components/observatory/SpanTree.tsx` lines 1-80: Cost columns, decision rendering, token tooltips all implemented
- `apps/studio/src/components/observatory/WaterfallPanel.tsx` lines 1-60: Summary bar, totals, SpanTree rendering implemented
- `apps/studio/src/components/observatory/NodeDetailPanel.tsx` lines 1-60: Events list, raw JSON, LLM metrics implemented
- `scripts/clickhouse-init/01-init.sql` lines 102-144: llm_metrics_hourly MV with correct tenant/project isolation
- `scripts/clickhouse-init/01-init.sql` lines 276-331: platform_events table (canonical trace storage)
- `apps/runtime/src/observability/metrics.ts`: 8 OTEL metric instruments already defined
- `apps/runtime/src/routes/sessions.ts` lines 1-68: Auth middleware chain pattern to reuse
