# LLD + Implementation Plan: Tracing & Observability

**Feature:** tracing-observability
**Status:** ALPHA
**Created:** 2026-03-22
**Last Updated:** 2026-03-22
**Inputs:** Feature Spec, Test Spec, HLD

---

## 1. Implementation Overview

The tracing & observability system is largely implemented. This LLD documents the existing implementation structure and identifies gaps that require additional work to reach BETA/STABLE status. The plan is organized into 5 phases, each with clear exit criteria.

## 2. Current Implementation Status

### 2.1 Implemented Components

| Component                | Location                                                 | Status   | Notes                                                             |
| ------------------------ | -------------------------------------------------------- | -------- | ----------------------------------------------------------------- |
| TraceEvent types (30+)   | `packages/observatory/src/schema/trace-events.ts`        | Complete | 7 core + 10 extended + 5 attachment + 8 suspension                |
| Span hierarchy           | `packages/observatory/src/schema/spans.ts`               | Complete | SpanBuilder, SpanManager, TraceTree, TraceContext                 |
| Debug protocol           | `packages/observatory/src/protocol/`                     | Complete | 16 commands, 15 events, breakpoint manager                        |
| Memory TraceStore        | `apps/runtime/src/services/trace-store.ts`               | Complete | Ring buffer, TTL, subscribers, cleanup, OTEL bridge               |
| Redis TraceStore         | `apps/runtime/src/services/trace/redis-trace-store.ts`   | Complete | Streams + Pub/Sub, memory pressure CB, tenant scoping             |
| TraceEmitter             | `apps/runtime/src/services/trace-emitter.ts`             | Complete | Unified pipeline, PII scrubbing, verbosity, EventStore dual-write |
| Trace helpers            | `apps/runtime/src/services/execution/trace-helpers.ts`   | Complete | 4-tier verbosity, decision kind gating                            |
| Trace forwarder          | `apps/runtime/src/services/execution/trace-forwarder.ts` | Complete | Construct-layer bridge                                            |
| OTEL SDK setup           | `apps/runtime/src/observability/otel-setup.ts`           | Complete | Traces, metrics, logs exporters                                   |
| OTEL trace bridge        | `apps/runtime/src/observability/otel-trace-bridge.ts`    | Complete | TraceStore -> OTEL spans                                          |
| OTEL metrics             | `apps/runtime/src/observability/metrics.ts`              | Complete | 12 metric instruments                                             |
| EventStore singleton     | `apps/runtime/src/services/eventstore-singleton.ts`      | Complete | ClickHouse backend, WAL, GDPR hooks                               |
| Event type mapping       | `apps/runtime/src/services/trace-event-types.ts`         | Complete | 35 trace -> platform type mappings                                |
| Debug integration        | `apps/runtime/src/services/debug-integration.ts`         | Complete | DebugRuntimeExecutor wrapper                                      |
| Studio trace store       | `apps/studio/src/store/trace-store.ts`                   | Complete | Zustand, 1000 event cap, type filters                             |
| Studio observatory store | `apps/studio/src/store/observatory-store.ts`             | Complete | Spans, flow graph, metrics, debug state                           |
| Session/trace REST API   | Runtime session routes                                   | Complete | 18 endpoints (see observatory README)                             |
| MCP debug tools          | `packages/mcp-debug/src/tools/`                          | Complete | 13+ tools                                                         |

### 2.2 Identified Gaps

| ID  | Gap                                                            | Severity | Current State                                             | Target                                           |
| --- | -------------------------------------------------------------- | -------- | --------------------------------------------------------- | ------------------------------------------------ |
| G1  | OtelTraceStore `activeSpans` has no automatic periodic cleanup | Medium   | Manual `cleanupOrphanedSpans()` available                 | Add periodic timer (60s) to clean orphaned spans |
| G2  | Memory TraceStore uses `console.log` instead of `createLogger` | Low      | 6+ console.log calls in trace-store.ts                    | Replace with `createLogger('trace-store')`       |
| G3  | No trace sampling for high-cardinality production              | Medium   | Verbosity gating only                                     | Add configurable per-tenant head/tail sampling   |
| G4  | SpanTree component not rendered in Observatory UI              | Medium   | Component exists in codebase but never mounted            | Wire SpanTree into Observatory debug panel       |
| G5  | No Prometheus scrape endpoint (/metrics)                       | Low      | OTEL push-based export only                               | Add Express route for Prometheus scrape          |
| G6  | RedisTraceStore tenant cache unbounded at 10K                  | Low      | LRU eviction at 10K                                       | Make configurable via env var                    |
| G7  | No automated E2E tests for PII scrubbing                       | Medium   | PII scrubbing implemented but untested E2E                | Add E2E-7 from test spec                         |
| G8  | No automated tests for Redis cross-pod delivery                | Medium   | Redis store implemented but no cross-pod integration test | Add INT-3 from test spec                         |
| G9  | No automated tests for OTEL bridge                             | Medium   | Bridge implemented but no integration test                | Add INT-7 from test spec                         |
| G10 | Session export (CSV) not connected to ClickHouse               | Low      | Export reads from memory only for some paths              | Verify CH fallback on all export paths           |

## 3. Phased Implementation Plan

### Phase 1: Hardening & Code Quality (Priority: P0)

**Objective:** Fix code quality issues and add protective measures to existing implementation.

#### 1.1 Replace console.log with createLogger in trace-store.ts

**File:** `apps/runtime/src/services/trace-store.ts`

**Changes:**

- Add `import { createLogger } from '@abl/compiler/platform';`
- Create `const log = createLogger('trace-store');`
- Replace all `console.log('[TraceStore]...')` with `log.info('...')`
- Replace `console.error('[TraceStore]...')` with `log.error('...')`

**Lines affected:** ~8 console.log/console.error calls (lines 124-125, 196-197, 210, 238, 288, 397-398, 439-441)

#### 1.2 Add periodic cleanup to OtelTraceStore activeSpans

**File:** `apps/runtime/src/observability/otel-trace-bridge.ts`

**Changes:**

- Add a `cleanupTimer` field
- In constructor, start a 60-second periodic timer that calls `cleanupOrphanedSpans()`
- The cleanup checks each activeSpan: if the span has been open for > 10 minutes, end it and remove it
- Add `stop()` method to clear the timer
- Use `timer.unref()` to not hold the event loop

```typescript
private cleanupTimer: ReturnType<typeof setInterval> | null = null;
private static readonly ORPHAN_CLEANUP_INTERVAL_MS = 60_000;
private static readonly MAX_SPAN_AGE_MS = 10 * 60_000; // 10 minutes
```

#### 1.3 Make RedisTraceStore tenant cache size configurable

**File:** `apps/runtime/src/services/trace/redis-trace-store.ts`

**Changes:**

- Read `MAX_TENANT_CACHE` from `process.env.REDIS_TRACE_TENANT_CACHE_SIZE` with default 10,000
- Document in configuration section

**Exit Criteria:**

- [ ] Zero `console.log` calls in trace-store.ts
- [ ] OtelTraceStore has periodic orphan cleanup (60s)
- [ ] Tenant cache size configurable via env var
- [ ] `pnpm build --filter=runtime` passes
- [ ] Existing 28 E2E tests still pass

---

### Phase 2: Test Coverage (Priority: P0)

**Objective:** Implement the highest-priority test scenarios from the test spec.

#### 2.1 Integration Test: Memory TraceStore Ring Buffer (INT-1)

**File:** `apps/runtime/src/__tests__/integration/trace-store-ring-buffer.test.ts`

**Test cases:**

- Ring buffer drops oldest events at capacity (maxEventsPerSession: 5, add 7)
- TTL-based filtering on read path
- Cleanup job purges inactive sessions
- Session cap evicts oldest session

#### 2.2 Integration Test: Memory TraceStore WebSocket Broadcast (INT-2)

**File:** `apps/runtime/src/__tests__/integration/trace-store-ws-broadcast.test.ts`

**Test cases:**

- Events broadcast to all subscribers
- trace_replay sent on subscribe
- Unsubscribe stops delivery
- Dead socket cleanup

#### 2.3 Integration Test: Verbosity Gating (INT-5)

**File:** `apps/runtime/src/__tests__/integration/trace-verbosity.test.ts`

**Test cases:**

- minimal: only errors/escalations pass
- standard: tool_call, handoff pass; llm_call suppressed
- verbose: gather_extraction, correction pass
- debug: llm_call with full prompt passes
- Decision kind gating (emitDecision respects kind-level verbosity)

#### 2.4 Unit Tests: Schema Utilities (UNIT-1 through UNIT-5)

**File:** `packages/observatory/src/__tests__/schema-utilities.test.ts`

**Test cases:**

- TRACE_TO_PLATFORM_TYPE mapping coverage
- inferCategory extracts first segment
- generateSpanId produces 16 hex chars
- generateTraceId produces 32 hex chars
- createTraceEvent merges defaults
- parseDebugCommand parses valid JSON, returns null for invalid
- parseBreakpointSpec parses all 4 breakpoint types

#### 2.5 Integration Test: TraceTree Building (INT-9)

**File:** `packages/observatory/src/__tests__/trace-tree.test.ts`

**Test cases:**

- Parent-child hierarchy (3 levels)
- Orphaned spans become root nodes
- getCriticalPath returns longest chain
- findSpansByEventType filters correctly
- toAscii produces readable output
- getTotalDuration correct

#### 2.6 Integration Test: SpanManager Lifecycle (INT-10)

**File:** `packages/observatory/src/__tests__/span-manager.test.ts`

**Test cases:**

- Start root span, child auto-parented from stack
- End span pops from stack
- clearSession removes all spans
- getActiveSpanId returns top of stack

**Exit Criteria:**

- [ ] INT-1, INT-2, INT-5, INT-9, INT-10 pass
- [ ] UNIT-1 through UNIT-5 pass
- [ ] All new tests use real implementations (no mocks of codebase components)
- [ ] `pnpm test --filter=runtime` passes
- [ ] `pnpm test --filter=observatory` passes

---

### Phase 3: Advanced Integration Tests (Priority: P1)

**Objective:** Test cross-service boundaries that require external dependencies.

#### 3.1 Integration Test: TraceEmitter EventStore Dual-Write (INT-6)

**File:** `apps/runtime/src/__tests__/integration/trace-emitter-dual-write.test.ts`

**Setup:** TraceEmitter with mock WebSocket and spied EventStore emitter.

**Test cases:**

- llm_call maps to `llm.call.completed` in EventStore
- llm_call with error maps to `llm.call.failed`
- Category inference from platform type
- tenant_id, project_id, session_id propagated
- Custom dimensions attached when present

#### 3.2 Integration Test: TraceForwarder (INT-8)

**File:** `apps/runtime/src/__tests__/integration/trace-forwarder.test.ts`

**Test cases:**

- logLLMCall flows through TraceEmitter.emit
- Event data includes `source: 'construct-layer'`
- startSpan/end emits span_end with duration
- Fallback to direct TraceStore write when no TraceEmitter

#### 3.3 Integration Test: OTEL Trace Bridge (INT-7)

**File:** `apps/runtime/src/__tests__/integration/otel-trace-bridge.test.ts`

**Setup:** OtelTraceStore with in-memory exporter.

**Test cases:**

- startTrace creates root span with attributes
- appendEvent creates child span
- Error events set span status to ERROR
- endTrace ends root span
- cleanupOrphanedSpans ends stale spans

**Exit Criteria:**

- [ ] INT-6, INT-7, INT-8 pass
- [ ] No mocking of codebase components (only mock WS readyState, spy on EventStore)
- [ ] `pnpm test --filter=runtime` passes

---

### Phase 4: E2E Tests (Priority: P1)

**Objective:** Implement E2E test scenarios that exercise the full system through HTTP API.

#### 4.1 E2E Test: Full Trace Pipeline (E2E-1)

**File:** `apps/runtime/src/__tests__/e2e/trace-pipeline-e2e.test.ts`

**Setup:** Real Express server on random port with full middleware.

**Test flow:**

1. Create session via POST
2. Send message via WS
3. Wait for response
4. GET traces
5. Verify agent_enter, llm_call, agent_exit events present
6. Verify span hierarchy

#### 4.2 E2E Test: WebSocket Trace Streaming (E2E-2)

**File:** `apps/runtime/src/__tests__/e2e/trace-ws-streaming-e2e.test.ts`

**Test flow:**

1. Create session
2. Subscribe WS to traces
3. Send message on separate WS
4. Verify trace_event messages received
5. Verify trace_replay on subscribe

#### 4.3 E2E Test: Session Metrics (E2E-4)

**File:** `apps/runtime/src/__tests__/e2e/session-metrics-e2e.test.ts`

**Test flow:**

1. Create session, send messages
2. GET /metrics endpoint
3. Verify aggregated metrics (tokens, calls, cost)

#### 4.4 E2E Test: Trace Type Filtering (E2E-6)

**File:** `apps/runtime/src/__tests__/e2e/trace-type-filter-e2e.test.ts`

**Test flow:**

1. Create session with varied activity
2. GET traces with type filter
3. Verify only matching types returned

**Exit Criteria:**

- [ ] E2E-1, E2E-2, E2E-4, E2E-6 pass
- [ ] All tests use real Express server with full middleware
- [ ] No mocks of codebase components
- [ ] `pnpm test --filter=runtime` passes

---

### Phase 5: Production Readiness (Priority: P2)

**Objective:** Address remaining gaps for BETA promotion.

#### 5.1 Add trace sampling support

**Files:**

- `apps/runtime/src/services/execution/trace-helpers.ts` -- add `TraceSamplingConfig`
- `apps/runtime/src/services/trace-emitter.ts` -- add sampling check in `emit()`

**Design:**

```typescript
interface TraceSamplingConfig {
  /** Probability 0-1 for head-based sampling. 1.0 = sample everything. */
  headSampleRate: number;
  /** Always sample sessions with errors (tail-based) */
  alwaysSampleErrors: boolean;
  /** Always sample sessions exceeding duration threshold (ms) */
  slowSessionThresholdMs?: number;
}
```

#### 5.2 Wire SpanTree into Observatory UI

**Files:**

- `apps/studio/src/components/observatory/SpanTree.tsx` (exists but not rendered)
- Wire into the Observatory debug panel traces tab

#### 5.3 Add Prometheus scrape endpoint

**Files:**

- `apps/runtime/src/routes/metrics.ts` -- new Express route
- Return OTEL metrics in Prometheus exposition format

**Exit Criteria:**

- [ ] Trace sampling configurable per session
- [ ] SpanTree renders in Observatory UI
- [ ] Prometheus `/metrics` endpoint available
- [ ] All 28 existing E2E + new E2E tests pass
- [ ] Feature status promoted to BETA in feature spec

---

## 4. Implementation Checklist (Wiring Verification)

| #   | Wiring Point                                                                    | Status      | Verified By        |
| --- | ------------------------------------------------------------------------------- | ----------- | ------------------ |
| W1  | TraceEmitter created in runtime-executor with deployment context                | Implemented | Source read        |
| W2  | TraceEmitter.emit writes to TraceStore + EventStore + OTEL bridge               | Implemented | Source read        |
| W3  | TraceStore singleton factory selects Memory or Redis based on availability      | Implemented | Source read        |
| W4  | Redis Pub/Sub message handler calls broadcastLocal (not addEvent to avoid loop) | Implemented | Source read        |
| W5  | EventStore initialized at server startup after ClickHouse init                  | Implemented | Source read        |
| W6  | OTEL SDK imported as first module (before HTTP/Express)                         | Implemented | Source read        |
| W7  | Session/trace REST endpoints registered under project-scoped routes             | Implemented | Observatory README |
| W8  | WebSocket handler sends trace_event messages to connected clients               | Implemented | Source read        |
| W9  | Debug server BreakpointManager wired to DebugRuntimeExecutor                    | Implemented | Source read        |
| W10 | TraceForwarder bridges construct-layer events to TraceEmitter or TraceStore     | Implemented | Source read        |
| W11 | GDPR cascade hooks registered in EventStore singleton                           | Implemented | Source read        |
| W12 | Graceful shutdown handlers registered for OTEL SDK                              | Implemented | Source read        |

## 5. File Change Summary by Phase

### Phase 1 (3 files)

- `apps/runtime/src/services/trace-store.ts` -- replace console.log with createLogger
- `apps/runtime/src/observability/otel-trace-bridge.ts` -- add periodic orphan cleanup
- `apps/runtime/src/services/trace/redis-trace-store.ts` -- configurable tenant cache size

### Phase 2 (6 new test files)

- `apps/runtime/src/__tests__/integration/trace-store-ring-buffer.test.ts`
- `apps/runtime/src/__tests__/integration/trace-store-ws-broadcast.test.ts`
- `apps/runtime/src/__tests__/integration/trace-verbosity.test.ts`
- `packages/observatory/src/__tests__/schema-utilities.test.ts`
- `packages/observatory/src/__tests__/trace-tree.test.ts`
- `packages/observatory/src/__tests__/span-manager.test.ts`

### Phase 3 (3 new test files)

- `apps/runtime/src/__tests__/integration/trace-emitter-dual-write.test.ts`
- `apps/runtime/src/__tests__/integration/trace-forwarder.test.ts`
- `apps/runtime/src/__tests__/integration/otel-trace-bridge.test.ts`

### Phase 4 (4 new test files)

- `apps/runtime/src/__tests__/e2e/trace-pipeline-e2e.test.ts`
- `apps/runtime/src/__tests__/e2e/trace-ws-streaming-e2e.test.ts`
- `apps/runtime/src/__tests__/e2e/session-metrics-e2e.test.ts`
- `apps/runtime/src/__tests__/e2e/trace-type-filter-e2e.test.ts`

### Phase 5 (3-4 files)

- `apps/runtime/src/services/execution/trace-helpers.ts` -- sampling config
- `apps/runtime/src/services/trace-emitter.ts` -- sampling check
- `apps/studio/src/components/observatory/SpanTree.tsx` -- wire to UI
- `apps/runtime/src/routes/metrics.ts` -- new Prometheus endpoint

## 6. Risk Assessment per Phase

| Phase | Risk                                                        | Mitigation                                                                 |
| ----- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1     | console.log replacement could affect log parsing pipelines  | Keep same message format, just switch transport                            |
| 1     | Periodic cleanup timer could end spans prematurely          | Use generous timeout (10 min) + only clean spans without recent activity   |
| 2     | Observatory tests need the package to build first           | Turbo build order: `pnpm build` before `pnpm test`                         |
| 3     | OTEL tests require SDK initialization                       | Use in-memory exporter for test isolation                                  |
| 4     | E2E tests need full runtime infrastructure (MongoDB, Redis) | Use existing test infrastructure patterns from observatory-api-e2e.test.ts |
| 5     | Sampling could mask production issues                       | alwaysSampleErrors flag ensures error traces are never dropped             |

## 7. Definition of Done

- [ ] All Phase 1 code quality fixes applied and building
- [ ] All Phase 2 tests passing (6 new test files, 30+ test cases)
- [ ] All Phase 3 tests passing (3 new test files, 15+ test cases)
- [ ] All Phase 4 E2E tests passing (4 new test files, 10+ test cases)
- [ ] All 28 existing observatory E2E tests still passing
- [ ] Zero TypeScript build errors across runtime + observatory
- [ ] Feature spec updated to BETA status
- [ ] Test spec coverage matrix updated with PASS statuses
