# Test Spec: Observatory

**Date:** 2026-03-23
**Status:** PLANNED
**Feature Spec:** `docs/features/observatory.md`
**HLD:** `docs/specs/observatory.hld.md`

---

## 1. Test Coverage Matrix

### 1.1 E2E Tests (API-Only, No Mocks of Codebase Components)

| ID     | Scenario                                                              | FR Ref | HTTP Method | Endpoint                                                                       | Assertions                                                                                             |
| ------ | --------------------------------------------------------------------- | ------ | ----------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| E2E-1  | Session list returns paginated results with correct metadata          | FR-4   | GET         | `/api/projects/:projectId/sessions?limit=10&offset=0`                          | Response has `total`, `sessions[]` with `id`, `agentName`, `tokenCount`, `estimatedCost`, `status`     |
| E2E-2  | Session list filters by status                                        | FR-4   | GET         | `/api/projects/:projectId/sessions?status=completed`                           | Only completed sessions returned; total matches filter                                                 |
| E2E-3  | Session list filters by channel                                       | FR-4   | GET         | `/api/projects/:projectId/sessions?channel=web_debug`                          | Only web_debug sessions returned                                                                       |
| E2E-4  | Session list filters by date range                                    | FR-4   | GET         | `/api/projects/:projectId/sessions?from=...&to=...`                            | Only sessions within range returned                                                                    |
| E2E-5  | Session detail returns messages with ContentBlock[]                   | FR-5   | GET         | `/api/projects/:projectId/sessions/:id`                                        | `messages[].content` can be string or ContentBlock[], both render in response                          |
| E2E-6  | Traces endpoint returns span hierarchy from ClickHouse                | FR-1   | GET         | `/api/projects/:projectId/sessions/:id/traces`                                 | Response has events with real `spanId`, `parentSpanId`, `agentName`; parent-child relationships valid  |
| E2E-7  | Traces endpoint filters by eventType                                  | FR-1   | GET         | `/api/projects/:projectId/sessions/:id/traces?eventType=llm_call`              | Only llm_call events returned                                                                          |
| E2E-8  | Traces endpoint filters by decisionKind                               | FR-3   | GET         | `/api/projects/:projectId/sessions/:id/traces?decisionKind=handoff`            | Only decision events with handoff kind returned                                                        |
| E2E-9  | Span children endpoint returns child events                           | FR-2   | GET         | `/api/projects/:projectId/sessions/:id/traces/:spanId/children`                | Returns events whose `parentSpanId` matches the requested `spanId`                                     |
| E2E-10 | Metrics endpoint returns aggregated session metrics                   | FR-1   | GET         | `/api/projects/:projectId/sessions/:id/metrics`                                | Response has `totalLLMCalls`, `totalToolCalls`, `totalTokensIn`, `totalTokensOut`, `estimatedCost`     |
| E2E-11 | Generations endpoint returns LLM call events with ClickHouse fallback | FR-1   | GET         | `/api/projects/:projectId/sessions/generations`                                | Returns events with `type: llm_call`, includes model, tokens, cost; works for historical sessions      |
| E2E-12 | Export endpoint returns CSV-compatible trace data                     | FR-6   | GET         | `/api/projects/:projectId/sessions/export?sessionId=...`                       | Response is CSV or JSON array with all trace fields                                                    |
| E2E-13 | Cross-session aggregate metrics API                                   | FR-7   | GET         | `/api/projects/:projectId/analytics/metrics?from=...&to=...&granularity=daily` | Returns time series of cost, tokens, error rates; data matches ClickHouse materialized views           |
| E2E-14 | Agent performance comparison API                                      | FR-8   | GET         | `/api/projects/:projectId/analytics/agents?from=...&to=...`                    | Returns per-agent metrics: avgLatency, totalCost, errorRate, sessionCount                              |
| E2E-15 | Model cost breakdown API                                              | FR-9   | GET         | `/api/projects/:projectId/analytics/models?from=...&to=...`                    | Returns per-model breakdown: totalCost, tokenCount, callCount from llm_metrics_daily                   |
| E2E-16 | Prometheus metrics endpoint returns valid exposition format           | FR-10  | GET         | `/metrics`                                                                     | Response content-type is `text/plain`, contains `http_request_duration_seconds`, `llm_calls_total`     |
| E2E-17 | Health readiness checks all dependencies                              | FR-13  | GET         | `/health/ready`                                                                | Checks MongoDB, Redis, ClickHouse; returns 503 if any dependency is down                               |
| E2E-18 | Tenant isolation: cross-tenant session access returns 404             | NFR-7  | GET         | `/api/projects/:projectId/sessions/:id`                                        | Request with different tenantId returns 404, not 403                                                   |
| E2E-19 | Session detail with structured ContentBlock[] messages round-trip     | FR-5   | POST+GET    | `/api/projects/:projectId/sessions`                                            | Create session, send message with ContentBlock[], retrieve session, verify content structure preserved |
| E2E-20 | Analytics API respects project scope isolation                        | NFR-7  | GET         | `/api/projects/:projectId/analytics/metrics`                                   | Returns only metrics for the requested project; no cross-project leakage                               |

### 1.2 Integration Tests

| ID     | Scenario                                                          | FR Ref | Components Under Test                                     | Assertions                                                                                              |
| ------ | ----------------------------------------------------------------- | ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| INT-1  | Observatory store addEvent builds correct span hierarchy          | FR-1   | `observatory-store.ts` addEvent + startSpan + endSpan     | Adding `agent_enter` followed by `llm_call` with matching spanId creates parent-child span relationship |
| INT-2  | Observatory store handles historical replay with real timestamps  | FR-1   | `observatory-store.ts` startSpan with timestamp parameter | Replayed spans have original timestamps, not replay time                                                |
| INT-3  | SpanTree component renders decision events via DecisionCard       | FR-3   | `SpanTree.tsx` + `DecisionCard.tsx`                       | Decision events in span show kind, reason, candidates via DecisionCard component                        |
| INT-4  | WaterfallPanel computes correct timing offsets                    | FR-14  | `WaterfallPanel.tsx`                                      | Span bars start at correct offset from session start, width proportional to duration                    |
| INT-5  | NodeDetailPanel displays full event data for selected span        | FR-2   | `NodeDetailPanel.tsx`                                     | Selecting a span shows all event fields; LLM events show model, messages, tokens                        |
| INT-6  | Trace emitter writes events to ClickHouse via BufferedWriter      | FR-1   | `trace-emitter.ts` + `BufferedClickHouseWriter`           | Events written in batch (not per-event), all fields preserved including spanId, agentName, cost         |
| INT-7  | ClickHouse fallback provides events when in-memory store is empty | FR-1   | `sessions.ts` trace fallback chain                        | Historical session (past 120min TTL) returns events from ClickHouse with correct structure              |
| INT-8  | Session list filter builds correct MongoDB query                  | FR-4   | `buildSessionListFilter()` + `listSessions()`             | Status, channel, date range filters produce correct MongoDB filter predicates                           |
| INT-9  | CSV export formats all event types correctly                      | FR-6   | Export route handler                                      | CSV output has correct headers; all 30+ event types map to correct columns                              |
| INT-10 | Prometheus metrics collector tracks runtime metrics               | FR-10  | Metrics middleware + `/metrics` endpoint                  | After HTTP requests and LLM calls, metric counters increment correctly                                  |

### 1.3 Unit Tests

| ID   | Scenario                                                   | Component                          |
| ---- | ---------------------------------------------------------- | ---------------------------------- |
| UT-1 | `normalizeEventType()` maps all event types correctly      | `lib/event-types.ts`               |
| UT-2 | `boundedPush()` evicts oldest when capacity reached        | `lib/bounded-collection.ts`        |
| UT-3 | `boundedMapSet()` evicts when map exceeds max size         | `lib/bounded-collection.ts`        |
| UT-4 | SpanTreeNode builder creates correct tree from flat events | `observatory-store.ts` getSpanTree |
| UT-5 | Time range selector computes correct query params          | TimeRangeSelector component        |
| UT-6 | CSV serializer handles special characters and newlines     | Export utility                     |
| UT-7 | ClickHouse query builder includes all filter predicates    | Analytics query functions          |
| UT-8 | Health check returns 503 when any dependency fails         | Health endpoint logic              |

---

## 2. Test Environment Requirements

### 2.1 E2E Test Infrastructure

- **Real Express server** started on random port (`{ port: 0 }`)
- **Full middleware chain**: auth, rate limiting, tenant isolation, project scope validation
- **ClickHouse**: Real ClickHouse instance (or ClickHouse mock server for CI) with `platform_events` and `llm_metrics` tables
- **MongoDB**: Real MongoDB (or in-memory via MongoMemoryServer for isolation)
- **Redis**: Real Redis for trace store and session state
- **No mocks of codebase components**: Only LLM client responses may be mocked (external third-party)

### 2.2 Test Data Setup

```typescript
// Seed via API, not direct DB access
// 1. Create 3 test sessions via POST /api/projects/:projectId/sessions
// 2. Send messages via WebSocket to generate trace events
// 3. Wait for ClickHouse BufferedWriter flush (5s interval)
// 4. Assert via GET endpoints
```

### 2.3 Tenant Isolation Verification

Every E2E test that reads data MUST also verify:

- Cross-tenant access returns 404 (not 403)
- Cross-project access returns 404
- Session IDs from one tenant cannot be retrieved by another

---

## 3. Existing Test Baseline

### 3.1 Passing Tests

| Test File                                                            | Tests  | Status  |
| -------------------------------------------------------------------- | ------ | ------- |
| `apps/runtime/src/__tests__/e2e/observatory-api-e2e.test.ts`         | 28     | PASSING |
| `apps/studio/src/store/__tests__/observatory-span-lifecycle.test.ts` | varies | PASSING |
| `apps/studio/src/__tests__/session-hooks.test.ts`                    | varies | PASSING |
| `apps/studio/src/__tests__/session-store-endstreaming.test.ts`       | varies | PASSING |

### 3.2 Known Gaps in Existing Tests

| Gap                                                                              | Impact                                       | Priority                                    |
| -------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| Existing E2E test mocks DB models (`vi.mock('@agent-platform/database/models')`) | Does not exercise real auth/tenant isolation | P0 — new E2E tests MUST use real middleware |
| No E2E test for ClickHouse analytics queries                                     | Cross-session analytics untested             | P1                                          |
| No E2E test for ContentBlock[] round-trip                                        | Structured content handling untested         | P0                                          |
| No integration test for trace emitter batch writes                               | Write amplification bug (G4) could regress   | P1                                          |
| No Prometheus endpoint test                                                      | Metrics exposure untested                    | P1                                          |

---

## 4. Test Execution Plan

### Phase 1: E2E — Core Observatory APIs (E2E-1 through E2E-12)

**File:** `apps/runtime/src/__tests__/e2e/observatory-enhanced-e2e.test.ts`

**Setup:** Real Express server, auth middleware, project scope, ClickHouse + MongoDB connections

**Teardown:** Delete test sessions, clean up ClickHouse test data by tenant_id

### Phase 2: E2E — Analytics APIs (E2E-13 through E2E-15)

**File:** `apps/runtime/src/__tests__/e2e/observatory-analytics-e2e.test.ts`

**Setup:** Seed ClickHouse `llm_metrics` table with 30 days of test data

**Teardown:** Delete test metrics data

### Phase 3: E2E — System Observability (E2E-16 through E2E-20)

**File:** `apps/runtime/src/__tests__/e2e/observatory-system-e2e.test.ts`

**Setup:** Real Runtime server with Prometheus metrics enabled

### Phase 4: Integration — UI Components (INT-1 through INT-5)

**File:** `apps/studio/src/__tests__/observatory-ui-integration.test.ts`

**Setup:** Vitest + React Testing Library, real Zustand store (no mocks)

### Phase 5: Integration — Backend Services (INT-6 through INT-10)

**File:** `apps/runtime/src/__tests__/integration/observatory-services.test.ts`

**Setup:** Real trace emitter, real BufferedWriter (test ClickHouse), real MongoDB

---

## 5. Current State

**Iteration 0 — Baseline (2026-03-23)**

- 28 existing E2E tests pass for core session/trace APIs
- Observatory store span lifecycle tests pass
- No tests for analytics, Prometheus, ContentBlock[], or UI integration
- Existing E2E tests mock DB models (not ideal but functional)

### Health Dashboard

| Area                          | Tests  | Passing | Coverage |
| ----------------------------- | ------ | ------- | -------- |
| Session CRUD API              | 8      | 8       | 100%     |
| Traces API (single session)   | 6      | 6       | 100%     |
| Generations API               | 4      | 4       | 100%     |
| Metrics API                   | 3      | 3       | 100%     |
| Export API                    | 2      | 2       | 100%     |
| Analytics API (cross-session) | 0      | 0       | 0%       |
| Prometheus metrics            | 0      | 0       | 0%       |
| Health readiness              | 0      | 0       | 0%       |
| ContentBlock[] handling       | 0      | 0       | 0%       |
| Tenant isolation (real auth)  | 0      | 0       | 0%       |
| Observatory UI components     | 0      | 0       | 0%       |
| **TOTAL**                     | **23** | **23**  | **55%**  |

### Iteration Log

| Iteration | Date       | Tests Added  | Tests Passing | Gaps Closed | Gaps Opened |
| --------- | ---------- | ------------ | ------------- | ----------- | ----------- |
| 0         | 2026-03-23 | 0 (baseline) | 23            | 0           | 15          |
