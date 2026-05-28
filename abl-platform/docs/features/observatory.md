# Feature Spec: Observatory

**Date:** 2026-03-23
**Status:** BETA
**Owner:** Platform Engineering
**Priority:** P0

---

## 1. Problem Statement

The ABL Platform Runtime emits rich trace events (30+ event types across core, extended, attachment, and suspension lifecycles) through a three-tier storage pipeline (in-memory ring buffer, Redis streams, ClickHouse `platform_events`). However, the current Observatory UI and API surface has significant gaps that prevent production debugging and cost analysis:

1. **Incomplete UI**: Phase 3 (UI Core Components: WaterfallPanel, NodeDetailPanel, SpanTree) and Phase 4 (UI Feature Parity: TimeRangeSelector, AdvancedFilterPanel, ColumnCustomizer, CsvExport) from `docs/observatory/FIXES.md` remain unimplemented (13 UI items open).
2. **No cross-session analytics**: The session list API (`GET /api/projects/:projectId/sessions`) provides per-session stats but no aggregate views — no cost trends, error rate dashboards, or agent performance comparisons across sessions.
3. **No infrastructure monitoring**: The platform lacks Prometheus `/metrics` endpoints, Coroot deployment, or SLO-based alerting (10 verified gaps in `docs/observatory/RFC_PRODUCTION_OBSERVABILITY_AND_TROUBLESHOOTING.md`).
4. **ContentBlock[] handling gap**: `message.content` can be `ContentBlock[]` (structured content with text, images, tool results) but the session detail UI and trace replay treat it as plain string, losing rich content display.
5. **No self-service debugging**: Platform operators have no dashboard for cross-tenant usage views, error budget tracking, or capacity planning.

### Who Is Affected

| Persona              | Pain Point                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Agent Engineers      | Cannot trace why an agent made a decision across historical sessions; live debugging only works during active sessions |
| Product Engineers    | No aggregate cost analysis or performance trends across agents/models                                                  |
| Support Teams        | No way to search sessions by error type, cost threshold, or agent behavior patterns                                    |
| Platform SREs        | No infrastructure health dashboard, no SLO alerting, no cross-service trace correlation                                |
| Enterprise Customers | No tenant-scoped analytics dashboards for self-service cost and usage monitoring                                       |

### Evidence

- `docs/observatory/FIXES.md`: 52 items total, 16 completed, 36 remaining (Phase 3 and 4 entirely open)
- `docs/observatory/gaps.json`: 19 gaps — 9 fixed, 2 mitigated, 8 open
- `docs/observatory/RFC_PRODUCTION_OBSERVABILITY_AND_TROUBLESHOOTING.md`: 10 verified gaps (G1-G10)
- `docs/observatory/PRODUCTION_READINESS_ANALYTICS.md`: 75% production-ready, critical gaps in monitoring, DR, query perf
- 28 E2E tests pass for existing API surface (`apps/runtime/src/__tests__/e2e/observatory-api-e2e.test.ts`)

---

## 2. Scope

### In Scope

1. **Observatory UI Completion** (Phase 3 from FIXES.md)
   - SpanTree with cost, decisions, status inline rendering
   - WaterfallPanel integration as shared wrapper
   - NodeDetailPanel right sidebar
   - DebugTabs replacement of Decisions tab with unified Traces tab
   - `ContentBlock[]` handling in `useSessionDetail` and tree builder

2. **Session Explorer Enhancements** (Phase 4 partial)
   - Session list filters in UI (status, channel, agent, date range)
   - Advanced filter panel (error count, cost threshold, duration)
   - CSV export for traces
   - Column customizer for session list

3. **Cross-Session Analytics API**
   - Aggregate metrics endpoint: cost trends, token usage, error rates over time
   - Agent performance comparison endpoint
   - Model cost breakdown endpoint
   - All backed by ClickHouse materialized views (`llm_metrics_hourly_dest`, `llm_metrics_daily_dest`)

4. **System Observability Foundation**
   - Prometheus `/metrics` endpoint on Runtime
   - Fix 5 critical gaps from RFC (G1: OTEL trace queryability, G2: traceparent forwarding, G4: batch writes, G5: cardinality fix, G7: search-ai metrics mount)
   - Health endpoint improvements (G10: readiness with Mongo + ClickHouse checks)

### Out of Scope

- Coroot deployment and infrastructure monitoring (separate ops workstream)
- Full platform admin cross-tenant dashboards (future sprint)
- Real-time alerting and SLO configuration UI
- Workspace concept within organizations
- Incident management product

### Dependencies

| Dependency                                                 | Status   | Impact                                                |
| ---------------------------------------------------------- | -------- | ----------------------------------------------------- |
| ClickHouse `platform_events` table                         | DEPLOYED | Canonical trace storage, required for all read paths  |
| ClickHouse `llm_metrics` + materialized views              | DEPLOYED | Hourly/daily rollups power aggregate analytics        |
| `packages/observatory` schema package                      | EXISTS   | Event types, protocol exports                         |
| In-memory TraceStore (ring buffer 500/session, 120min TTL) | EXISTS   | Hot cache for active sessions                         |
| WebSocket `trace_event` message type                       | EXISTS   | Real-time event streaming                             |
| `packages/shared-auth` project scope middleware            | EXISTS   | All routes require `requireProjectScope('projectId')` |
| `packages/eventstore` ClickHouse store                     | EXISTS   | Dual-write pipeline for analytics                     |

---

## 3. Requirements

### 3.1 Functional Requirements

| ID    | Requirement                                                                        | Priority | Acceptance Criteria                                                                                                           |
| ----- | ---------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | SpanTree renders real span hierarchy with cost, duration, and decision kind inline | P0       | SpanTree shows `agent_enter` > `llm_call` > `tool_call` hierarchy with per-span cost from ClickHouse `data.cost`              |
| FR-2  | NodeDetailPanel shows full event data when a span is selected                      | P0       | Clicking a span in SpanTree opens right sidebar with all event fields, LLM messages, tool inputs/outputs                      |
| FR-3  | DebugTabs replaces separate Decisions tab with unified Traces tab                  | P0       | Single tab showing span tree + waterfall + detail panel, decisions rendered via existing `DecisionCard`                       |
| FR-4  | Session list supports filtering by status, channel, agent, date range              | P1       | Filters passed as query params to `GET /sessions`, UI shows filter chips with clear button                                    |
| FR-5  | `useSessionDetail` handles `ContentBlock[]` in `message.content`                   | P0       | Structured content blocks (text, image, tool_result) render correctly in conversation tree                                    |
| FR-6  | CSV export for trace events                                                        | P2       | Button in Traces tab exports current session's trace events as CSV with all fields                                            |
| FR-7  | Cross-session aggregate metrics API                                                | P1       | `GET /api/projects/:projectId/analytics/metrics` returns cost trends, token usage, error rates over configurable time windows |
| FR-8  | Agent performance comparison API                                                   | P1       | `GET /api/projects/:projectId/analytics/agents` returns per-agent metrics (avg latency, cost, error rate, handoff count)      |
| FR-9  | Model cost breakdown API                                                           | P2       | `GET /api/projects/:projectId/analytics/models` returns per-model cost and token breakdown from `llm_metrics_daily_dest`      |
| FR-10 | Prometheus `/metrics` endpoint on Runtime                                          | P1       | Exposes HTTP duration histograms, LLM call counters, tool call counters, active session gauge, circuit breaker states         |
| FR-11 | Fix OTEL trace queryability (Gap G1)                                               | P1       | `OtelTraceStore.getTrace()` returns real spans instead of null/empty                                                          |
| FR-12 | Fix traceparent forwarding (Gap G2)                                                | P1       | Workflow-engine proxy forwards `traceparent` and `tracestate` headers                                                         |
| FR-13 | Fix health readiness (Gap G10)                                                     | P1       | `/health/ready` checks MongoDB and ClickHouse connectivity, not just heap + Redis                                             |
| FR-14 | WaterfallPanel visualizes span timing as horizontal bars                           | P1       | Spans rendered as horizontal bars proportional to duration, with start offset from session start                              |
| FR-15 | Advanced filter panel in session explorer                                          | P2       | Filter by error count > N, cost > threshold, duration > threshold, agent name pattern                                         |

### 3.2 Non-Functional Requirements

| ID    | Requirement                            | Target                                                                               |
| ----- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| NFR-1 | Trace query response time (ClickHouse) | p95 < 200ms for 10K events per session                                               |
| NFR-2 | Aggregate analytics response time      | p95 < 500ms for 30-day window across all sessions                                    |
| NFR-3 | Session list response time             | p95 < 300ms for 1000 sessions with filters                                           |
| NFR-4 | Prometheus `/metrics` scrape time      | < 50ms                                                                               |
| NFR-5 | WebSocket trace event delivery latency | p99 < 100ms from emit to UI render                                                   |
| NFR-6 | CSV export for 50K events              | < 5 seconds                                                                          |
| NFR-7 | Tenant isolation                       | Every query includes `tenantId`; cross-tenant returns 404                            |
| NFR-8 | Memory safety                          | Observatory store capped at 2K events, spans Map capped at 500 entries with eviction |

---

## 4. User Stories

### US-1: Agent Engineer Debugs Historical Session

**As an** agent engineer, **I want to** view the full span tree of a historical session with decision details, LLM call parameters, and tool results, **so that** I can understand why an agent made a specific decision 3 days ago.

**Acceptance:**

- Navigate to session explorer, filter by agent name and date range
- Click session to open detail view
- SpanTree shows `agent_enter` > `llm_call` (with model, token counts, cost) > `decision` (with DecisionCard showing reason, candidates, selected)
- Clicking a span opens NodeDetailPanel with full event JSON

### US-2: Product Manager Reviews Cost Trends

**As a** product manager, **I want to** see aggregate LLM cost trends grouped by model and agent over the past 30 days, **so that** I can make informed decisions about model selection and agent optimization.

**Acceptance:**

- Analytics dashboard shows daily cost trend chart
- Breakdown by model (claude-sonnet, gpt-4o, etc.) with stacked area visualization
- Breakdown by agent with table showing avg cost per session, total cost, session count
- Data sourced from `llm_metrics_daily_dest` materialized view

### US-3: Support Engineer Finds Error Sessions

**As a** support engineer, **I want to** filter sessions by error count > 0 and view the error trace events, **so that** I can quickly identify and diagnose failing sessions.

**Acceptance:**

- Session list filter for `errorCount > 0`
- Error sessions highlighted with red indicator
- Clicking opens trace view with errors pre-filtered
- Error events show full stack trace and context

### US-4: SRE Monitors Platform Health

**As an** SRE, **I want to** scrape Prometheus metrics from the Runtime service, **so that** I can set up Grafana dashboards and PagerDuty alerts for SLO breaches.

**Acceptance:**

- `GET /metrics` returns Prometheus text format
- Metrics include: `http_request_duration_seconds`, `llm_calls_total`, `tool_calls_total`, `active_sessions`, `circuit_breaker_state`
- Compatible with standard Prometheus scrape config

### US-5: Agent Engineer Exports Trace Data

**As an** agent engineer, **I want to** export a session's trace events as CSV, **so that** I can analyze them in a spreadsheet or share with colleagues for offline review.

**Acceptance:**

- CSV export button in Traces tab
- Columns: timestamp, event_type, agent_name, span_id, parent_span_id, duration_ms, data (JSON), error_message
- Includes all events (not just filtered view)

---

## 5. Success Metrics

| Metric                                    | Target                                                            | Measurement                              |
| ----------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| Phase 3 UI completion                     | 6/6 items from FIXES.md                                           | Item checklist in implementation log     |
| Cross-session analytics API response time | p95 < 500ms                                                       | Runtime logs + ClickHouse query analysis |
| Trace query reliability                   | 100% of historical sessions return traces via ClickHouse fallback | E2E test coverage                        |
| Prometheus metrics endpoint availability  | 100% uptime when Runtime is healthy                               | Health check monitoring                  |
| E2E test coverage                         | >= 15 new E2E tests (5 per major capability area)                 | Test count in CI                         |

---

## 6. Risks and Mitigations

| Risk                                                        | Likelihood | Impact | Mitigation                                                                                                              |
| ----------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| ClickHouse query performance degrades with large datasets   | Medium     | High   | Partition pruning on `toDate(timestamp)`, `ORDER BY (tenant_id, ...)` ensures efficient scans; benchmark with 1M events |
| ContentBlock[] handling breaks existing plain-text sessions | Low        | Medium | Defensive type check: `typeof content === 'string' ? content : renderContentBlocks(content)`                            |
| Prometheus metrics endpoint adds latency to Runtime         | Low        | Low    | Separate Express router, no middleware chain overlap; metrics collected in-process with minimal overhead                |
| WebSocket trace events overwhelm slow clients               | Medium     | Medium | Existing ring buffer (500/session) + client-side bounded store (2K events) provide backpressure                         |
| Cross-session analytics on large tenants timeout            | Medium     | High   | Use materialized views (pre-aggregated hourly/daily), add query timeouts, paginate results                              |

---

## 7. Feature Status

**Current: ALPHA**

| Criteria                                          | Status                                               |
| ------------------------------------------------- | ---------------------------------------------------- |
| Feature spec                                      | This document                                        |
| Test spec                                         | See `docs/testing/observatory.md`                    |
| HLD                                               | See `docs/specs/observatory.hld.md`                  |
| LLD                                               | See `docs/plans/2026-03-23-observatory-impl-plan.md` |
| Core API (sessions, traces, metrics, generations) | IMPLEMENTED (28 E2E tests pass)                      |
| UI Phase 3 (SpanTree, NodeDetailPanel, DebugTabs) | PLANNED                                              |
| UI Phase 4 (Filters, Export, Column Customizer)   | PLANNED                                              |
| Cross-session analytics API                       | PLANNED                                              |
| System observability (Prometheus, health fixes)   | PLANNED                                              |
| E2E tests for new capabilities                    | PLANNED                                              |
| Integration tests                                 | PLANNED                                              |

**Transition to BETA requires:** All Phase 3 UI items implemented, cross-session analytics API functional, >= 15 E2E tests passing, Prometheus endpoint deployed.

**Transition to STABLE requires:** Phase 4 UI items, production load testing, SLO dashboards, 30-day stability window with no P0 bugs.
