# High-Level Design: Observatory

**Date:** 2026-03-23
**Status:** Draft
**Feature Spec:** `docs/features/observatory.md`
**Test Spec:** `docs/testing/observatory.md`

---

## 1. Overview

Observatory is the unified observability system for the ABL Platform, providing agent trace debugging, cross-session analytics, and system health monitoring. It spans three runtime layers (in-memory TraceStore, ClickHouse persistent store, Prometheus metrics) and two UI surfaces (Studio debug panel for live sessions, session explorer for historical analysis).

### Current State

- **Runtime**: 18 API endpoints in `apps/runtime/src/routes/sessions.ts` (2504 LOC), trace emitter with WebSocket broadcast, three-tier trace storage (memory -> ClickHouse `platform_events`), OTEL SDK with HTTP/Express auto-instrumentation
- **Studio UI**: 13 observatory components in `apps/studio/src/components/observatory/`, Zustand observatory-store with spans/events/metrics, 8 debug tabs
- **Storage**: ClickHouse `platform_events` (canonical traces), `llm_metrics` + hourly/daily materialized views, `messages`, `logs`, `audit_events`
- **Package**: `packages/observatory` with 30+ trace event types (core, extended, attachment, suspension)
- **Tests**: 28 E2E tests passing for core session/trace APIs

### What This Design Adds

1. Observatory UI completion (Phase 3 from FIXES.md): SpanTree + WaterfallPanel + NodeDetailPanel wiring
2. Session explorer enhancements: filters, CSV export, column customizer
3. Cross-session analytics API backed by ClickHouse materialized views
4. System observability: Prometheus `/metrics` endpoint, health readiness improvements, trace gap fixes

---

## 2. Architecture

### 2.1 System Context

```
                      ┌────────────────────────────────────────────┐
                      │              Studio (Next.js 15)            │
                      │                                            │
                      │  ┌──────────────┐  ┌───────────────────┐   │
                      │  │ Observatory   │  │ Session Explorer  │   │
                      │  │ Store (Zustand│  │ (filters, export) │   │
                      │  │ spans, events)│  │                   │   │
                      │  └──────┬───────┘  └────────┬──────────┘   │
                      │         │                    │              │
                      │         │ WebSocket          │ REST API     │
                      └─────────┼────────────────────┼──────────────┘
                                │                    │
                      ┌─────────┴────────────────────┴──────────────┐
                      │              Runtime (Express + WS)         │
                      │                                             │
                      │  ┌──────────┐  ┌───────────┐  ┌──────────┐ │
                      │  │ Sessions  │  │ Analytics │  │ /metrics │ │
                      │  │ Router    │  │ Router    │  │ (Prom)   │ │
                      │  │ (18 APIs) │  │ (NEW)     │  │ (NEW)    │ │
                      │  └────┬─────┘  └─────┬─────┘  └──────────┘ │
                      │       │              │                      │
                      │  ┌────┴──────────────┴─────────────┐       │
                      │  │       Service Layer              │       │
                      │  │  TraceEmitter  │ TestSessionSvc  │       │
                      │  │  TraceStore    │ RuntimeExecutor  │       │
                      │  └────┬───────────┬────────────────┘       │
                      └───────┼───────────┼─────────────────────────┘
                              │           │
           ┌──────────────────┤           ├──────────────────┐
           │                  │           │                  │
    ┌──────┴──────┐   ┌──────┴──────┐  ┌─┴──────────┐  ┌───┴─────┐
    │  ClickHouse  │   │   MongoDB   │  │   Redis    │  │  OTEL   │
    │  platform_   │   │   sessions  │  │  TraceStore│  │Collector│
    │  events      │   │   messages  │  │  (hot)     │  │         │
    │  llm_metrics │   │   projects  │  │            │  │         │
    │  (hourly/    │   │             │  │            │  │         │
    │   daily MVs) │   │             │  │            │  │         │
    └──────────────┘   └─────────────┘  └────────────┘  └─────────┘
```

### 2.2 Data Flow: Trace Event Lifecycle

```
Agent Execution
    │
    ▼
TraceEmitter.emit(event)
    │
    ├──► WebSocket broadcast to subscribed clients (real-time)
    │         │
    │         ▼
    │    observatory-store.addEvent() → spans Map → SpanTree render
    │
    ├──► In-Memory TraceStore (ring buffer: 500/session, 120min TTL)
    │
    ├──► ClickHouse BufferedWriter (batch: 10K rows / 5s flush)
    │         │
    │         ▼
    │    platform_events table (canonical, tenant-scoped)
    │    llm_metrics table (via dual-write in trace-emitter)
    │         │
    │         ▼
    │    Materialized Views: llm_metrics_hourly_dest, llm_metrics_daily_dest
    │
    └──► EventStore (PlatformEvent analytics dual-write)
```

### 2.3 Read Path: Trace Fallback Chain

```
GET /sessions/:id/traces
    │
    ▼
1. RuntimeExecutor.getSessionDetail().traceEvents  (active session, in-memory)
    │ empty?
    ▼
2. In-Memory TraceStore.getEvents(runtimeSessionId)  (hot cache, 120min)
    │ empty?
    ▼
3. ClickHouse platform_events WHERE session_id = ? AND tenant_id = ?  (canonical)
    │ empty?
    ▼
4. Return empty array with _meta.source = 'none'
```

### 2.4 New: Analytics Read Path

```
GET /analytics/metrics?from=...&to=...&granularity=daily
    │
    ▼
1. Parse time range, validate granularity (hourly|daily)
    │
    ▼
2. Query ClickHouse:
   - hourly → llm_metrics_hourly_dest (pre-aggregated)
   - daily → llm_metrics_daily_dest (pre-aggregated)
   - Filter: tenant_id, project_id, time range
    │
    ▼
3. Return time series: { timestamp, totalCost, totalTokens, callCount, errorCount }
```

---

## 3. Component Architecture

### 3.1 Runtime — New Analytics Router

**Location:** `apps/runtime/src/routes/analytics.ts` (NEW)

```
analytics.ts
├── GET /api/projects/:projectId/analytics/metrics
│   Query: from, to, granularity (hourly|daily)
│   Source: llm_metrics_hourly_dest or llm_metrics_daily_dest
│
├── GET /api/projects/:projectId/analytics/agents
│   Query: from, to
│   Source: platform_events GROUP BY agent_name
│
└── GET /api/projects/:projectId/analytics/models
    Query: from, to
    Source: llm_metrics_daily_dest GROUP BY model_id, provider
```

**Auth:** Same middleware chain as sessions — `authMiddleware`, `tenantRateLimit`, `requireProjectScope('projectId')`

**Tenant Isolation:** Every ClickHouse query includes `tenant_id = ?` and `project_id = ?` in WHERE clause

### 3.2 Runtime — Prometheus Metrics Endpoint

**Location:** `apps/runtime/src/routes/metrics.ts` (NEW)

Uses `prom-client` library to expose Prometheus exposition format on `GET /metrics`. Collects from the existing OTEL metrics instruments in `apps/runtime/src/observability/metrics.ts`:

| Metric                                     | Type      | Labels                     |
| ------------------------------------------ | --------- | -------------------------- |
| `http_request_duration_seconds`            | Histogram | method, route, status_code |
| `llm_calls_total`                          | Counter   | model, provider, status    |
| `tool_calls_total`                         | Counter   | tool_name, status          |
| `active_sessions`                          | Gauge     | channel                    |
| `circuit_breaker_state`                    | Gauge     | name, state                |
| `trace_store_events`                       | Gauge     | store_type (memory/redis)  |
| `clickhouse_writer_buffer_utilization`     | Gauge     | table                      |
| `clickhouse_writer_flush_duration_seconds` | Histogram | table                      |

**Note:** Labels use bounded cardinality only (no session IDs, user IDs, or unbounded strings).

### 3.3 Studio — Observatory UI Components

#### SpanTree (Enhancement)

**File:** `apps/studio/src/components/observatory/SpanTree.tsx`

Currently exports `SpanTree` component. Enhancement:

- Inline cost display per span (from `event.data.cost`)
- Decision events rendered via existing `DecisionCard` component
- Duration column showing elapsed time
- Status indicators (completed, error, pending)
- Click handler dispatches `selectSpan()` to observatory-store

#### WaterfallPanel (Wiring)

**File:** `apps/studio/src/components/observatory/WaterfallPanel.tsx`

Already exported from index. Wire into DebugTabs as the primary visualization:

- Horizontal bars proportional to span duration
- Start offset calculated from session start time
- Color-coded by event type (existing `event-colors.ts`)
- Zoom and pan support via Framer Motion

#### NodeDetailPanel (Wiring)

**File:** `apps/studio/src/components/observatory/NodeDetailPanel.tsx`

Already exported. Wire as right sidebar:

- Shows all fields of selected span/event
- LLM events: model, message count, token breakdown, cost
- Tool events: tool name, input/output (redacted if scrubPII)
- Decision events: kind, reason, candidates, selected
- Error events: error type, message, stack trace

#### DebugTabs (Enhancement)

**File:** `apps/studio/src/components/observatory/DebugTabs.tsx`

Replace separate Decisions tab with unified Traces tab containing:

- SpanTree (left panel, tree view)
- WaterfallPanel (center, timeline view)
- NodeDetailPanel (right sidebar, on span select)

### 3.4 Studio — Session Explorer Enhancements

#### Session List Filters

Add filter UI to session list using existing query params (`status`, `channel`, `from`, `to`):

- Filter chips with clear button
- Date range picker using `TimeRangeSelector` component (new)
- Status dropdown (active, ended, completed, escalated, abandoned)
- Channel dropdown (web_debug, slack, whatsapp, voice)

#### CSV Export

Button in Traces tab that:

1. Fetches all trace events for current session via `GET /sessions/:id/traces`
2. Transforms to CSV with columns: timestamp, event_type, agent_name, span_id, parent_span_id, duration_ms, data, error_message
3. Triggers browser download

---

## 4. Data Model

### 4.1 Existing ClickHouse Tables (No Schema Changes Required)

| Table                     | Purpose                              | Key Columns                                                                                                      |
| ------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `platform_events`         | Canonical trace storage              | tenant_id, project_id, session_id, event_type, span_id, parent_span_id, agent_name, data, duration_ms, has_error |
| `llm_metrics`             | Per-call LLM metrics                 | tenant_id, project_id, session_id, model_id, provider, input_tokens, output_tokens, estimated_cost, latency_ms   |
| `llm_metrics_hourly_dest` | Hourly rollup (AggregatingMergeTree) | tenant_id, project_id, model_id, provider, agent_name, hour, total_cost, call_count                              |
| `llm_metrics_daily_dest`  | Daily rollup (AggregatingMergeTree)  | tenant_id, project_id, model_id, provider, day, total_cost, call_count                                           |

### 4.2 Existing MongoDB Collections (No Schema Changes Required)

| Collection | Purpose               | Key Fields                                                                                    |
| ---------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `sessions` | Session metadata      | tenantId, projectId, runtimeSessionId, agentId, status, tokenCount, estimatedCost, errorCount |
| `messages` | Conversation messages | sessionId, role, content (string or ContentBlock[]), timestamp                                |

### 4.3 Analytics API Response Shapes

```typescript
// GET /analytics/metrics response
interface AnalyticsMetricsResponse {
  success: true;
  granularity: 'hourly' | 'daily';
  from: string; // ISO timestamp
  to: string;
  series: Array<{
    timestamp: string;
    totalCost: number;
    totalTokens: number;
    callCount: number;
    errorCount: number;
    avgLatencyMs: number;
  }>;
}

// GET /analytics/agents response
interface AnalyticsAgentsResponse {
  success: true;
  from: string;
  to: string;
  agents: Array<{
    agentName: string;
    sessionCount: number;
    totalCost: number;
    avgCostPerSession: number;
    totalTokens: number;
    avgLatencyMs: number;
    errorRate: number;
    handoffCount: number;
  }>;
}

// GET /analytics/models response
interface AnalyticsModelsResponse {
  success: true;
  from: string;
  to: string;
  models: Array<{
    modelId: string;
    provider: string;
    totalCost: number;
    callCount: number;
    totalTokens: number;
    avgLatencyMs: number;
    errorRate: number;
  }>;
}
```

---

## 5. Twelve Architectural Concerns

### 5.1 Tenant Isolation

- **API layer**: All routes use `authMiddleware` + `requireProjectScope('projectId')` + `tenantRateLimit`
- **ClickHouse queries**: Every query includes `WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String}`
- **Cross-tenant access**: Returns 404 (not 403) to avoid leaking existence
- **Analytics queries**: Same isolation — `llm_metrics_hourly_dest` and `llm_metrics_daily_dest` both have `tenant_id` and `project_id` columns in ORDER BY

### 5.2 Authentication & Authorization

- Existing `authMiddleware` from `apps/runtime/src/middleware/auth.ts` handles JWT + SDK session token + API key
- `requireProjectPermission` gates per-action access
- Prometheus `/metrics` endpoint is NOT behind auth (standard for scraping) but exposed on a separate port or path with IP allowlist

### 5.3 Performance

- **ClickHouse query efficiency**: All trace reads use partition pruning on `toDate(timestamp)` with `ORDER BY (tenant_id, category, event_type, timestamp)`
- **Analytics queries**: Use pre-aggregated materialized views (hourly/daily), not raw event scans. Worst case: 365 rows for daily over 1 year
- **Session list**: MongoDB query with indexed fields (tenantId, projectId, status, createdAt). Limit default 50, max 200
- **CSV export**: Streaming response with Node.js `Transform` stream to avoid buffering entire dataset in memory
- **Buffer safety**: ClickHouse `BufferedWriter` batches 10K rows / 5s flush; backpressure at 90% buffer utilization

### 5.4 Scalability

- **Horizontal**: All state in MongoDB/Redis/ClickHouse. Runtime pods are stateless (in-memory TraceStore is cache only, not source of truth)
- **ClickHouse**: Daily partitions for `platform_events` (high volume), monthly for `llm_metrics` — well within 1000 partition limit
- **Materialized views**: Aggregation happens on write (AggregatingMergeTree), reads are O(partitions) not O(events)

### 5.5 Reliability

- **Three-tier trace storage**: Memory (fast, lossy) -> ClickHouse (canonical, durable) -> EventStore (analytics fallback)
- **Fallback chain**: Read path tries memory, then ClickHouse, then returns empty with metadata
- **BufferedWriter**: Drops oldest events at 100% buffer (data loss acceptable for observability data)
- **Health checks**: Enhanced readiness to include MongoDB + ClickHouse connectivity

### 5.6 Observability (Self-Monitoring)

- **Prometheus metrics**: Exposes runtime health metrics for Grafana/alerting
- **ClickHouse observability**: `ClickHouseObservability` class queries system tables for slow queries, errors, replication health
- **Buffer health**: `writer.getMetrics()` returns pending count, utilization, consecutive failures
- **Structured logging**: All observatory code uses `createLogger('module')`, not console.log

### 5.7 Security

- **PII scrubbing**: Trace emitter applies `scrubToolCallData`, `redactPII`, `scrubSecrets` before persistence
- **Encryption at rest**: ClickHouse `platform_events` supports AES-256-GCM via `_enc` column
- **No session IDs in metrics labels**: Prevents unbounded cardinality (addresses Gap G5)
- **CSRF**: All mutating endpoints require auth token
- **Rate limiting**: `tenantRateLimit('request')` on all session/analytics routes

### 5.8 Data Integrity

- **Idempotent writes**: ClickHouse `event_id` provides deduplication
- **Ordered events**: `sequence` field (HLC) ensures cross-pod ordering
- **Schema validation**: `packages/observatory` defines `TraceEventType` union covering all 30+ event types
- **ContentBlock[] handling**: Defensive serialization — `JSON.stringify` for complex content, string passthrough for plain text

### 5.9 Backward Compatibility

- **No breaking API changes**: All new endpoints are additive (new `/analytics/*` routes)
- **Existing UI**: DebugTabs enhancement adds Traces tab but preserves existing tab order
- **Observatory store**: `addEvent()` interface unchanged; `startSpan` already has optional `timestamp` parameter

### 5.10 Deployment

- **Feature flags**: Not required — all changes are additive
- **Database migrations**: None required — all ClickHouse tables and materialized views already exist
- **Rollback**: New routes can be removed without affecting existing functionality
- **Prometheus endpoint**: Optional — enabled by default, disabled via `METRICS_ENABLED=false`

### 5.11 Error Handling

- **API errors**: Standard envelope `{ success: false, error: { code, message } }`
- **ClickHouse query failures**: Log error, return partial data with `_meta.source = 'partial'`
- **Analytics timeout**: 30s query timeout, returns 504 with explanation
- **CSV export errors**: Stream error handler sends error chunk and closes connection

### 5.12 Testing Strategy

- **E2E**: 20 scenarios testing real HTTP APIs with full middleware chain (see test spec)
- **Integration**: 10 scenarios testing component interactions (store, UI, trace pipeline)
- **Unit**: 8 scenarios for pure logic (normalization, bounded collections, query builders)
- **No mocks of codebase components in E2E**: Only external LLM client may be mocked

---

## 6. Alternatives Considered

### 6.1 Separate Analytics Service vs. Runtime Inline

**Chosen: Runtime inline.** The analytics queries hit ClickHouse materialized views that are pre-aggregated — the query cost is minimal (reading 365 rows for a year of daily data). A separate service would add deployment complexity, network hops, and auth synchronization for negligible performance benefit. If query volume grows, extract later.

### 6.2 Grafana Embedded Dashboards vs. Custom Analytics UI

**Chosen: Custom analytics API + Studio UI.** Grafana embedding requires Grafana deployment, authentication bridging, and iframe integration. The ABL Studio design system (Tailwind + Framer Motion) already has chart primitives. Custom API gives full control over tenant isolation and data formatting.

### 6.3 prom-client vs. OTEL Prometheus Exporter

**Chosen: prom-client.** The OTEL SDK already exports to OTEL Collector via gRPC. Adding a Prometheus exporter would require either (a) running a second exporter pipeline or (b) configuring OTEL Collector to expose Prometheus endpoints. `prom-client` is simpler, widely adopted, and gives direct control over the `/metrics` endpoint format. The two systems (OTEL for distributed tracing, Prometheus for metrics scraping) serve different consumers.

### 6.4 Real-Time Analytics via WebSocket vs. Polling API

**Chosen: Polling API with configurable time range.** Real-time analytics adds WebSocket channel management, incremental aggregation, and client-side state complexity for a use case (cost trends, performance dashboards) where minute-level freshness is acceptable. The polling API with hourly/daily granularity is simpler and more cacheable.

---

## 7. Open Questions

| #   | Question                                                                             | Status   | Decision Path                                                                                  |
| --- | ------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------- |
| 1   | Should Prometheus `/metrics` be on a separate port (e.g., 9090) or same port as API? | DECIDED  | Same port, `/metrics` path — standard for Express apps scraped by Prometheus                   |
| 2   | Should analytics API support tenant-level aggregation (across projects)?             | DEFERRED | Start with project-scoped. Tenant-level requires admin role check and is an enterprise feature |
| 3   | Should CSV export support custom column selection?                                   | DEFERRED | Start with all columns. Column customizer UI can filter client-side before download            |
| 4   | Should we add ClickHouse query caching (e.g., Redis cache for analytics)?            | DEFERRED | Pre-aggregated MVs are fast enough. Add caching if p95 > 500ms in production                   |
