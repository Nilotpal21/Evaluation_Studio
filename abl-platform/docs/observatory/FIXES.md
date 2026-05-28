# Observatory Fixes & Requirements

**Generated:** 2026-03-10
**Last Updated:** 2026-03-10 (Phase 1+2 complete)
**Source:** Cross-reference of observatory spec with 12 observability documents

## Summary

**52 total items** across 7 categories — **16 completed** on 2026-03-10:

| Category              | Count | Done |
| --------------------- | ----- | ---- |
| Existing API Fixes    | 13    | 8    |
| New API Requirements  | 7     | 2    |
| Runtime Fixes         | 8     | 4    |
| Search-AI Fixes       | 2     | 0    |
| Studio UI Fixes       | 2     | 1    |
| New UI Requirements   | 13    | 0    |
| Platform Requirements | 6     | 1    |

**By priority:** 2 critical, 12 high, 23 medium, 15 low

---

## Completed (2026-03-10)

| ID             | Fix                                                                      | Verified By                                     |
| -------------- | ------------------------------------------------------------------------ | ----------------------------------------------- |
| **FIX-1.3-A**  | ClickHouse: write real span_id/parent_span_id                            | observatory-api-e2e.test.ts (28/28)             |
| **FIX-1.3-B**  | ClickHouse: write real agent_name                                        | observatory-api-e2e.test.ts (28/28)             |
| **FIX-1.7-A**  | Remove OBS_TRACE_CANONICAL_READ gate — ClickHouse canonical always       | observatory-api-e2e.test.ts (28/28)             |
| **FIX-1.7-B**  | \_meta response metadata on traces endpoint (source, count, truncation)  | Code inspection: sessions.ts:1646-1651          |
| **FIX-1.7-C**  | Traces filter params (eventType, decisionKind, spanId)                   | Code inspection: sessions.ts:1602-1627          |
| **FIX-1.7-D**  | include=metrics span-level aggregation                                   | Code inspection: sessions.ts:1653-1655          |
| **FIX-1.12-A** | Export endpoint ClickHouse fallback                                      | Code change: sessions.ts export route           |
| **FIX-1.13-A** | Generations endpoint ClickHouse fallback                                 | observatory-api-e2e.test.ts (28/28)             |
| **FIX-1.16-A** | No separate 'decisions' WS type — decisions flow as trace_event          | Code inspection: no 'decisions' msg type exists |
| **RT-FIX-1**   | Fire-and-forget ClickHouse writes (no per-event flush)                   | observatory-api-e2e.test.ts (28/28)             |
| **RT-FIX-7**   | decision-log.ts deleted; emitDecision() unified in trace-emitter.ts      | Code inspection: decision-log.ts absent         |
| **RT-FIX-8**   | Cost field persists through ClickHouse write path                        | observatory-api-e2e.test.ts (28/28)             |
| **NEW-API-1**  | GET /sessions/:id/traces/:spanId/children endpoint                       | observatory-api-e2e.test.ts (28/28)             |
| **NEW-API-2**  | GET /sessions/:id/metrics endpoint (totalLLMCalls, totalToolCalls, etc.) | observatory-api-e2e.test.ts (28/28)             |
| **PLAT-1**     | OBS_TRACE_CANONICAL_READ removed entirely                                | observatory-api-e2e.test.ts (28/28)             |
| **UI-FIX-1**   | Replay uses real spanId/parentSpanId from eventData (not synthetic)      | Code inspection: replay-trace-events.ts:145-146 |

---

## Implementation Phases

### Phase 0: Data Foundation ✅ COMPLETE

| ID        | Fix                                           | Status  |
| --------- | --------------------------------------------- | ------- |
| FIX-1.3-A | ClickHouse: write real span_id/parent_span_id | ✅ Done |
| FIX-1.3-B | ClickHouse: write real agent_name             | ✅ Done |
| RT-FIX-1  | Fire-and-forget ClickHouse writes             | ✅ Done |
| UI-FIX-1  | Use real spanId in replay (not synthetic)     | ✅ Done |

### Phase 1: Runtime Unification ✅ COMPLETE

| ID         | Fix                                                 | Status  |
| ---------- | --------------------------------------------------- | ------- |
| RT-FIX-7   | Merge decision-log into trace events (emitDecision) | ✅ Done |
| FIX-1.16-A | Remove separate 'decisions' WebSocket message type  | ✅ Done |
| RT-FIX-8   | Ensure cost persists through ClickHouse write path  | ✅ Done |
| FIX-1.7-A  | ClickHouse canonical reads (no feature flag)        | ✅ Done |
| FIX-1.7-B  | Add \_meta response metadata to traces endpoint     | ✅ Done |

### Phase 2: API Enhancement ✅ COMPLETE

| ID         | API                                                    | Status  |
| ---------- | ------------------------------------------------------ | ------- |
| FIX-1.7-C  | Traces filter params (eventType, decisionKind, spanId) | ✅ Done |
| FIX-1.7-D  | include=metrics span aggregation                       | ✅ Done |
| NEW-API-1  | GET /sessions/:id/traces/:spanId/children              | ✅ Done |
| NEW-API-2  | GET /sessions/:id/metrics                              | ✅ Done |
| FIX-1.13-A | Generations ClickHouse fallback                        | ✅ Done |
| FIX-1.12-A | Export ClickHouse fallback                             | ✅ Done |

### Phase 3: UI Core Components

| ID        | Component                                             | Status  |
| --------- | ----------------------------------------------------- | ------- |
| UI-NEW-2  | WaterfallPanel.tsx (shared wrapper)                   | ⬜ Open |
| UI-NEW-3  | NodeDetailPanel.tsx (right sidebar detail)            | ⬜ Open |
| UI-NEW-13 | SpanTree.tsx (cost, decisions, status)                | ⬜ Open |
| UI-FIX-2  | useSessionDetail.ts (ContentBlock[] handling)         | ⬜ Open |
| FIX-1.3-C | useSessionDetail.ts (message.content in tree builder) | ⬜ Open |
| UI-NEW-1  | DebugTabs.tsx (Replace Decisions tab with Traces)     | ⬜ Open |

### Phase 4: UI Feature Parity (vs AgenticAI)

| ID        | Component                           | Status  |
| --------- | ----------------------------------- | ------- |
| UI-NEW-4  | TimeRangeSelector.tsx               | ⬜ Open |
| UI-NEW-5  | AdvancedFilterPanel.tsx             | ⬜ Open |
| UI-NEW-6  | ColumnCustomizer.tsx                | ⬜ Open |
| UI-NEW-7  | CsvExport.tsx                       | ⬜ Open |
| UI-NEW-8  | Session list filters                | ⬜ Open |
| UI-NEW-9  | Traces Explorer with real span tree | ⬜ Open |
| UI-NEW-12 | Performance tab ClickHouse fallback | ⬜ Open |

### Phase 5: System Health

| ID        | Fix                                               | Status  |
| --------- | ------------------------------------------------- | ------- |
| RT-FIX-2  | Add traceparent to workflow-engine proxy          | ⬜ Open |
| RT-FIX-3  | Add trace context to Kafka headers                | ⬜ Open |
| RT-FIX-4  | Replace session.id in voice metrics (6 locations) | ⬜ Open |
| RT-FIX-5  | Add Mongo to /health/ready                        | ⬜ Open |
| RT-FIX-6  | Gate OTEL SDK on config flags                     | ⬜ Open |
| SAI-FIX-1 | Mount metrics router in search-ai-runtime         | ⬜ Open |
| SAI-FIX-2 | Add requestIdMiddleware to search-ai-runtime      | ⬜ Open |

### Phase 6: Nice-to-Have

| ID         | Item                                         | Status                 |
| ---------- | -------------------------------------------- | ---------------------- |
| NEW-API-3  | GET /traces/:id/detail (full span tree)      | ⬜ Open                |
| NEW-API-4  | GET /traces (cross-session search)           | ⬜ Open                |
| NEW-API-5  | GET /traces/export (streaming CSV)           | ⬜ Open                |
| NEW-API-6  | GET /sessions/:id/messages (paginated)       | ⬜ Open                |
| NEW-API-7  | GET /sessions/traces?sessionIds=x,y,z (bulk) | ⬜ Open                |
| UI-NEW-10  | Analysis tab                                 | ⬜ Open                |
| UI-NEW-11  | Cost breakdown visualization                 | ⬜ Open                |
| FIX-1.10-A | Agent-spec DB fallback                       | ⬜ Open                |
| PLAT-1     | Graduate OBS_TRACE_CANONICAL_READ            | ✅ Done (flag removed) |
| PLAT-2     | Add request_id to PlatformEvent              | ⬜ Open                |
| PLAT-3     | Archive retrieval APIs (RFC-015)             | ⬜ Open                |
| PLAT-4     | Alert rule evaluation APIs (RFC-016)         | ⬜ Open                |
| PLAT-5     | Coroot infrastructure monitoring             | ⬜ Open                |
| PLAT-6     | Workspace concept within organizations       | ⬜ Open                |

---

## Feature Flags

| Flag                          | Purpose                                   | Status                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OBS_TRACE_CANONICAL_READ`    | Route traces to abl_platform.traces first | **REMOVED** from runtime code — canonical reads are default. Residual config mapping in `packages/config/src/env-mapping.ts:118` and `observability.schema.ts:23` (unused). |
| `OBS_STRICT_READINESS_GATES`  | Include Mongo in readiness check          | Not started                                                                                                                                                                 |
| `OBS_METRIC_LABEL_GUARDRAILS` | Parallel emit old+new voice metric labels | Not started                                                                                                                                                                 |
| `OBS_EVENTBUS_TRACE_HEADERS`  | Add traceparent to Kafka headers          | Not started                                                                                                                                                                 |

---

## Test Coverage

**Observatory E2E Test:** `apps/runtime/src/__tests__/e2e/observatory-api-e2e.test.ts`

| Area                                                               | Tests  | Status         |
| ------------------------------------------------------------------ | ------ | -------------- |
| Session CRUD (list, detail)                                        | 3      | ✅ Pass        |
| Traces (in-memory, filters, meta)                                  | 6      | ✅ Pass        |
| Generations (list, structure, CH fallback)                         | 3      | ✅ Pass        |
| ClickHouse correctness (span_id, parent_span_id, agent_name, cost) | 6      | ✅ Pass        |
| Trace event quality (fields, llm_call, tool_call)                  | 4      | ✅ Pass        |
| Cross-session isolation                                            | 3      | ✅ Pass        |
| NEW-API-1 span children                                            | 1      | ✅ Pass        |
| NEW-API-2 metrics                                                  | 1      | ✅ Pass        |
| Session execution (3 agents × 5 turns)                             | 1      | ✅ Pass        |
| **Total**                                                          | **28** | **28/28 pass** |
