# Observatory — Low-Level Design & Implementation Plan

**Date:** 2026-03-23
**Status:** Draft
**Feature Spec:** `docs/features/observatory.md`
**Test Spec:** `docs/testing/observatory.md`
**HLD:** `docs/specs/observatory.hld.md`

---

## Summary of Existing Implementation

Before detailing what needs to be built, here is what already exists (verified by reading source):

### Already Implemented

- **18 session API endpoints** in `apps/runtime/src/routes/sessions.ts` (2504 LOC) with full auth, rate limiting, project scope
- **TracesTab** in `DebugTabs.tsx` already renders `WaterfallPanel` + `NodeDetailPanel` with span selection (lines 402-473)
- **SpanTree** component with cost, duration, decision rendering via `DecisionCard`, token breakdown tooltips (fully implemented)
- **WaterfallPanel** component with summary bar, totals computation, SpanTree rendering (implemented)
- **NodeDetailPanel** with events list, raw JSON, LLM metrics aggregation (implemented)
- **Observatory store** with spans, events, metrics, client-side timing (implemented)
- **Trace emitter** with WebSocket broadcast, ClickHouse BufferedWriter, PII scrubbing, decision events (implemented)
- **ClickHouse tables**: `platform_events`, `llm_metrics`, `llm_metrics_hourly_dest`, `llm_metrics_daily_dest` (all deployed)
- **28 E2E tests** passing for core APIs

### Remaining Work (Grounded in Codebase Analysis)

| Area                        | Gap                                                                     | Evidence                                                                                        |
| --------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| ContentBlock[] handling     | `useSessionDetail` tree builder treats `message.content` as string      | `useSessionDetail.ts` line 77: `messages: SessionMessage[]` but no ContentBlock[] normalization |
| Session list filters UI     | Backend supports `status`, `channel` params but Studio has no filter UI | No filter component in session explorer pages                                                   |
| CSV export UI               | Export endpoint exists (`GET /sessions/export`) but no UI button        | No export button in TracesTab or session explorer                                               |
| Cross-session analytics API | No analytics routes exist                                               | No `analytics.ts` in `apps/runtime/src/routes/`                                                 |
| Prometheus metrics endpoint | OTEL metrics exist (`metrics.ts`) but no `/metrics` HTTP endpoint       | No prom-client dependency, no metrics route                                                     |
| Health readiness gaps       | `/health/ready` only checks heap + Redis                                | `server.ts` lines 305-342 (per RFC Gap G10)                                                     |
| OTEL trace queryability     | `OtelTraceStore.getTrace()` returns null                                | `otel-trace-bridge.ts` lines 102-110 (per RFC Gap G1)                                           |
| Traceparent forwarding      | Workflow-engine proxy misses headers                                    | `workflow-engine-proxy.ts` lines 76-82 (per RFC Gap G2)                                         |

---

## Phase 1: ContentBlock[] Handling (FR-5)

**Goal:** Session detail and trace replay correctly handle `message.content` as either `string` or `ContentBlock[]`.

### Task 1.1: Add ContentBlock type and normalizer utility

**Files:**

- Create: `apps/studio/src/lib/content-blocks.ts`

**Changes:**

```typescript
// Type definition (verify against runtime types first)
export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ImageBlock {
  type: 'image';
  url: string;
  alt?: string;
}
export interface ToolResultBlock {
  type: 'tool_result';
  toolName: string;
  result: unknown;
}
export type ContentBlock = TextBlock | ImageBlock | ToolResultBlock;

// Normalizer: always returns string for display
export function contentToString(content: string | ContentBlock[] | unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block?.type === 'text') return block.text;
        if (block?.type === 'image') return `[Image: ${block.alt ?? block.url}]`;
        if (block?.type === 'tool_result') return `[Tool Result: ${block.toolName}]`;
        return JSON.stringify(block);
      })
      .join('\n');
  }
  return String(content ?? '');
}

// Returns true if content has rich blocks (not just text)
export function hasRichContent(content: unknown): content is ContentBlock[] {
  return Array.isArray(content) && content.some((b) => typeof b === 'object' && b?.type);
}
```

### Task 1.2: Update useSessionDetail tree builder to use contentToString

**Files:**

- Modify: `apps/studio/src/hooks/useSessionDetail.ts`

**Changes:**

- Import `contentToString` from `../lib/content-blocks`
- In the tree node builder where `message.content` is used as label, wrap with `contentToString(message.content)`
- Read the actual tree builder code to find exact location before modifying

### Task 1.3: Update conversation display components

**Files:**

- Modify: Any component that renders `message.content` directly (identify by grepping for `message.content`)

**Exit Criteria:**

- Session detail renders messages with ContentBlock[] correctly (text blocks as text, image blocks as image indicators, tool results as expandable sections)
- Plain string messages continue to render identically
- E2E test E2E-5 and E2E-19 pass

---

## Phase 2: Session List Filters UI (FR-4)

**Goal:** Add filter UI to session explorer using existing backend query params.

### Task 2.1: Create SessionFilterBar component

**Files:**

- Create: `apps/studio/src/components/session/SessionFilterBar.tsx`

**Changes:**

- Status dropdown: active, ended, completed, escalated, abandoned
- Channel dropdown: web_debug, slack, whatsapp, voice
- Date range inputs (from, to) using native date input
- Agent name text filter
- Filter chips showing active filters with clear buttons
- Calls `onFilterChange` prop with updated query params

### Task 2.2: Wire SessionFilterBar into session explorer page

**Files:**

- Modify: Session list page that renders sessions (identify exact file path by searching for `useSessionList` hook usage)

**Changes:**

- Add `SessionFilterBar` above session list
- Pass filter params to `useSessionList` SWR hook as query params
- Clear filters resets to default view

### Task 2.3: Update useSessionList hook to accept filter params

**Files:**

- Modify: Session list hook (identify by searching for `useSessionList`)

**Changes:**

- Accept optional filter params object
- Include in SWR key and fetch URL query string
- Existing `status` and `channel` params already supported by backend

**Exit Criteria:**

- Session list can be filtered by status, channel, date range
- Filters persist across navigation
- E2E tests E2E-2, E2E-3, E2E-4 pass

---

## Phase 3: CSV Export (FR-6)

**Goal:** Add CSV export button for trace events.

### Task 3.1: Create CSV export utility

**Files:**

- Create: `apps/studio/src/lib/csv-export.ts`

**Changes:**

```typescript
export function tracesToCsv(events: TraceEvent[]): string {
  const headers = [
    'timestamp',
    'event_type',
    'agent_name',
    'span_id',
    'parent_span_id',
    'duration_ms',
    'data',
    'error_message',
  ];
  const rows = events.map((e) => [
    e.timestamp,
    e.type,
    e.agentName ?? '',
    e.spanId ?? '',
    e.parentSpanId ?? '',
    String(e.data?.durationMs ?? e.data?.latencyMs ?? ''),
    JSON.stringify(e.data ?? {}),
    e.data?.errorMessage ?? e.data?.error ?? '',
  ]);
  return [headers.join(','), ...rows.map((r) => r.map(escapeCsvField).join(','))].join('\n');
}

function escapeCsvField(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```

### Task 3.2: Add export button to TracesTab

**Files:**

- Modify: `apps/studio/src/components/observatory/DebugTabs.tsx` (TracesTab function)

**Changes:**

- Add "Export CSV" button in the TracesTab header area
- On click: collect all events from observatory store, call `tracesToCsv()`, call `downloadCsv()`
- Button shows download icon (Lucide `Download`)

**Exit Criteria:**

- CSV export button visible in Traces tab
- Downloaded CSV has correct headers and data
- Special characters in data fields are properly escaped
- E2E test E2E-12 passes (backend), unit test UT-6 passes (CSV serializer)

---

## Phase 4: Cross-Session Analytics API (FR-7, FR-8, FR-9)

**Goal:** Add analytics endpoints that query ClickHouse materialized views for cost trends, agent performance, and model breakdowns.

### Task 4.1: Create analytics route module

**Files:**

- Create: `apps/runtime/src/routes/analytics.ts`

**Changes:**

- `GET /api/projects/:projectId/analytics/metrics` — time series from `llm_metrics_hourly_dest` or `llm_metrics_daily_dest`
- `GET /api/projects/:projectId/analytics/agents` — per-agent metrics from `platform_events` GROUP BY agent_name
- `GET /api/projects/:projectId/analytics/models` — per-model breakdown from `llm_metrics_daily_dest` GROUP BY model_id, provider
- Auth: `authMiddleware`, `tenantRateLimit('request')`, `requireProjectScope('projectId')`
- Zod validation: `from` (z.string().datetime()), `to` (z.string().datetime()), `granularity` (z.enum(['hourly', 'daily'])), `projectId` (z.string().min(1))
- Response shape matches HLD Section 4.3

### Task 4.2: Create analytics service layer

**Files:**

- Create: `apps/runtime/src/services/analytics-service.ts`

**Changes:**

- `getMetricsTimeSeries(tenantId, projectId, from, to, granularity)` — queries appropriate ClickHouse MV
- `getAgentPerformance(tenantId, projectId, from, to)` — queries `platform_events` with aggregation
- `getModelBreakdown(tenantId, projectId, from, to)` — queries `llm_metrics_daily_dest`
- All queries include `tenant_id = {tenantId:String} AND project_id = {projectId:String}` for isolation
- Query timeout: 30 seconds
- Use `@clickhouse/client` via existing `packages/database` ClickHouse client

### Task 4.3: Register analytics routes in server

**Files:**

- Modify: `apps/runtime/src/server.ts` (or route registration file)

**Changes:**

- Import analytics router
- Mount at `/api/projects/:projectId/analytics`
- Register BEFORE parameterized session routes (Express route ordering)

### Task 4.4: Add Zod schemas for analytics requests/responses

**Files:**

- Modify: `apps/runtime/src/routes/analytics.ts` (inline) or create schema file

**Changes:**

- Request validation with Zod: `z.string().min(1)` for IDs, `z.string().datetime()` for timestamps
- Response typing matching HLD AnalyticsMetricsResponse, AnalyticsAgentsResponse, AnalyticsModelsResponse

**Exit Criteria:**

- Analytics endpoints return correct data from ClickHouse MVs
- Tenant isolation verified (cross-tenant returns empty, not 404 for analytics)
- Query response time p95 < 500ms for 30-day window
- E2E tests E2E-13, E2E-14, E2E-15, E2E-20 pass

---

## Phase 5: Prometheus Metrics Endpoint (FR-10)

**Goal:** Expose Runtime metrics in Prometheus exposition format.

### Task 5.1: Add prom-client dependency

**Files:**

- Modify: `apps/runtime/package.json`

**Changes:**

- Add `prom-client` to dependencies
- Run `pnpm install`

### Task 5.2: Create Prometheus metrics route

**Files:**

- Create: `apps/runtime/src/routes/prometheus-metrics.ts`

**Changes:**

```typescript
import { Router } from 'express';
import { register, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

collectDefaultMetrics();

// Custom metrics (bounded cardinality)
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const llmCallsTotal = new Counter({
  name: 'llm_calls_total',
  help: 'Total LLM API calls',
  labelNames: ['model', 'provider', 'status'],
});

export const toolCallsTotal = new Counter({
  name: 'tool_calls_total',
  help: 'Total tool calls',
  labelNames: ['tool_name', 'status'],
});

export const activeSessions = new Gauge({
  name: 'active_sessions',
  help: 'Number of active sessions',
  labelNames: ['channel'],
});

const router = Router();
router.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

export default router;
```

### Task 5.3: Mount metrics route and add request duration middleware

**Files:**

- Modify: `apps/runtime/src/server.ts`

**Changes:**

- Import prometheus-metrics router
- Mount at root level (before auth middleware — metrics endpoint is unauthenticated)
- Add middleware to record `httpRequestDuration` on every request

### Task 5.4: Wire prom-client counters to trace emitter events

**Files:**

- Modify: `apps/runtime/src/services/trace-emitter.ts`

**Changes:**

- Import `llmCallsTotal`, `toolCallsTotal` from prometheus-metrics
- In `emit()` for `llm_call` events: increment `llmCallsTotal` with model, provider labels
- In `emit()` for `tool_call` events: increment `toolCallsTotal` with tool_name label
- Labels are bounded cardinality (model names, tool names, not session IDs)

**Exit Criteria:**

- `GET /metrics` returns valid Prometheus exposition format
- Custom metrics increment correctly after HTTP requests and LLM/tool calls
- No session IDs or user IDs in metric labels
- E2E test E2E-16 passes

---

## Phase 6: Health Readiness Improvements (FR-13)

**Goal:** Fix Gap G10 — `/health/ready` checks all dependencies.

### Task 6.1: Enhance readiness check

**Files:**

- Modify: `apps/runtime/src/server.ts` (health endpoint section, lines 305-342)

**Changes:**

- Add MongoDB connectivity check: `mongoose.connection.readyState === 1`
- Add ClickHouse connectivity check: `clickhouseClient.ping()` or simple `SELECT 1`
- Return 503 if any dependency is unhealthy
- Response body includes per-dependency status: `{ mongo: 'ok', redis: 'ok', clickhouse: 'ok' }`

**Exit Criteria:**

- `/health/ready` returns 200 when all deps are healthy
- `/health/ready` returns 503 when any dep is down
- Response includes per-dependency status
- E2E test E2E-17 passes

---

## Phase 7: Trace Gap Fixes (FR-11, FR-12)

**Goal:** Fix RFC gaps G1 (OTEL trace queryability) and G2 (traceparent forwarding).

### Task 7.1: Fix OtelTraceStore.getTrace()

**Files:**

- Modify: `apps/runtime/src/observability/otel-trace-bridge.ts`

**Changes:**

- Implement `getTrace()` to query ClickHouse `platform_events` by `trace_id`
- Implement `queryTraces()` to query with filters
- Use existing ClickHouse client from `packages/database`

### Task 7.2: Forward traceparent in workflow-engine proxy

**Files:**

- Modify: `apps/runtime/src/services/workflow-engine-proxy.ts` (or similar)

**Changes:**

- Add `traceparent` and `tracestate` to forwarded headers
- Read from `req.headers['traceparent']` or generate new if absent

**Exit Criteria:**

- `OtelTraceStore.getTrace()` returns real spans from ClickHouse
- Workflow-engine proxy includes traceparent header
- Cross-service traces are correlatable

---

## Phase 8: E2E and Integration Tests

**Goal:** Implement test scenarios from test spec.

### Task 8.1: Enhanced E2E tests for observatory APIs

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/observatory-enhanced-e2e.test.ts`

**Changes:**

- E2E-1 through E2E-12 from test spec
- Real Express server with full middleware chain
- Only LLM client responses mocked (external third-party)

### Task 8.2: Analytics E2E tests

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/observatory-analytics-e2e.test.ts`

**Changes:**

- E2E-13 through E2E-15, E2E-20 from test spec
- Seed ClickHouse with test metrics data
- Verify tenant/project isolation

### Task 8.3: System observability E2E tests

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/observatory-system-e2e.test.ts`

**Changes:**

- E2E-16 (Prometheus), E2E-17 (health readiness), E2E-18 (tenant isolation)

### Task 8.4: UI integration tests

**Files:**

- Create: `apps/studio/src/__tests__/observatory-ui-integration.test.ts`

**Changes:**

- INT-1 through INT-5 from test spec
- Vitest + React Testing Library
- Real Zustand store (no mocks)

**Exit Criteria:**

- > = 20 E2E tests passing
- > = 10 integration tests passing
- All tests in CI pipeline (CH-dependent tests excluded from vitest.fast.config.ts)

---

## Implementation Order and Dependencies

```
Phase 1: ContentBlock[] ──────────────────────┐
Phase 2: Session Filters ─────────────────────┤
Phase 3: CSV Export ──────────────────────────┤── Can run in parallel
Phase 5: Prometheus Metrics ──────────────────┤
Phase 6: Health Readiness ────────────────────┤
Phase 7: Trace Gap Fixes ─────────────────────┘
                                               │
Phase 4: Analytics API ────────────────────────┤── Depends on ClickHouse verification
                                               │
Phase 8: E2E Tests ────────────────────────────┘── Depends on all above
```

---

## Wiring Checklist

| Component                | Wired Into                        | Verification                                   |
| ------------------------ | --------------------------------- | ---------------------------------------------- |
| ContentBlock normalizer  | useSessionDetail tree builder     | Tree renders ContentBlock[] messages correctly |
| SessionFilterBar         | Session explorer page             | Filters appear, query params update            |
| CSV export button        | TracesTab in DebugTabs            | Button visible, CSV downloads                  |
| Analytics router         | server.ts route registration      | `GET /analytics/metrics` returns data          |
| Prometheus metrics route | server.ts root-level mount        | `GET /metrics` returns Prometheus format       |
| prom-client counters     | trace-emitter emit()              | LLM/tool counters increment                    |
| Health readiness         | server.ts `/health/ready` handler | Returns 503 when dep down                      |
| OtelTraceStore fix       | otel-trace-bridge.ts              | getTrace() returns real spans                  |
| Traceparent forwarding   | workflow-engine-proxy.ts          | Header present in proxied requests             |

---

## Risk Log

| Risk                                       | Mitigation                                                                                                                                            | Owner        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| prom-client and OTEL metrics double-count  | They serve different consumers (Prometheus scraping vs OTEL Collector). prom-client has its own counters, not reading from OTEL. Document in runbook. | Platform Eng |
| Analytics queries timeout on large tenants | Use pre-aggregated MVs (max 365 rows for daily). Add 30s query timeout.                                                                               | Platform Eng |
| ContentBlock[] type varies across services | Defensive parsing with fallback to JSON.stringify. Never crash on unknown block types.                                                                | Studio Eng   |
| Session list filters add query complexity  | All filter fields are indexed in MongoDB (tenantId, projectId, status, createdAt).                                                                    | Platform Eng |
