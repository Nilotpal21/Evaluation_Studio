# Production Observability Implementation Plan

**Status:** Proposed
**Date:** 2026-03-08
**RFC:** `docs/RFC_PRODUCTION_OBSERVABILITY_AND_TROUBLESHOOTING.md`

---

## 1. Objective

Implement the 10 verified gap fixes from the RFC with a phased, low-risk rollout. Each fix targets a specific file and line range. No speculative work — every task maps to a confirmed gap with evidence.

### Domain Split

| Domain                    | Epics               | Focus                                                                      |
| ------------------------- | ------------------- | -------------------------------------------------------------------------- |
| Agent Observability (AO)  | AO-01 through AO-03 | Trace propagation, canonical read path, event bus correlation              |
| System Observability (SO) | SO-01 through SO-04 | Readiness, metrics cardinality, writer efficiency, service instrumentation |

---

## 2. Epic Breakdown

### Epic AO-01: Cross-Service Trace Propagation (Fixes G2, G6)

**Problem:** Workflow-engine proxy forwards `x-request-id` and `x-tenant-id` but NOT `traceparent`/`tracestate`. Kafka events carry no trace context.

**Tasks:**

1. **Add traceparent/tracestate to workflow-engine proxy**
   - File: `apps/runtime/src/middleware/workflow-engine-proxy.ts` (lines 76-82)
   - Change: Add `traceparent` and `tracestate` headers to the fetch call alongside existing `x-request-id`
   - Test: Integration test verifying downstream span parentage

2. **Add trace context to Kafka message headers**
   - File: `apps/runtime/src/services/event-bus/kafka-subscriber.ts` (lines 212-216)
   - Change: Add `traceparent`, `tracestate`, `session-id` to Kafka message headers
   - Gate: `OBS_EVENTBUS_TRACE_HEADERS` env flag
   - Test: Unit test that published messages include trace headers when flag is on

3. **Add trace_id to PlatformEvent interface**
   - File: `apps/runtime/src/services/event-bus/types.ts` (lines 17-27)
   - Change: `trace_id` is already in the ClickHouse schema as optional; populate it from current trace context during publish
   - Test: Existing event bus tests extended with trace_id assertions

**Acceptance:** Distributed traces show linked spans across runtime→workflow-engine in staging. Kafka consumers can correlate events to originating request.

---

### Epic AO-02: Canonical Trace Retrieval (Fixes G3)

**Problem:** `/sessions/:id/traces` reads from MemoryTraceStore first, falls back to `abl_platform.platform_events` with lossy type translation (`llm.call.completed`→`llm_call`).

**Tasks:**

1. **Reorder trace read path**
   - File: `apps/runtime/src/routes/sessions.ts` (lines 1223-1322)
   - Change: When memory store is empty, query `abl_platform.traces` (canonical) before falling back to `platform_events`
   - Gate: `OBS_TRACE_CANONICAL_READ` env flag (when off, preserves current behavior)

2. **Add response metadata**
   - Same file, response construction (lines 1337-1365)
   - Change: Include `_meta: { source, event_count, is_truncated }` in response body

3. **Add request_id to event context**
   - File: `packages/eventstore/src/schema/platform-event.ts`
   - Change: Add optional `request_id` field; populate from `getCurrentRequestId()` (AsyncLocalStorage) during event creation
   - Persists into `custom_dimensions` Map column (no ClickHouse ALTER needed)

**Acceptance:** Session trace endpoint returns `_meta.source = 'clickhouse_traces'` for >= 99% of recent sessions in staging.

---

### Epic AO-03: Trace Writer Efficiency (Fixes G4)

**Problem:** `ClickHouseTraceStore.appendEvent()` calls `await flush()` after every `writer.insert()`, defeating the BufferedWriter's 10K/5s batch policy.

**Tasks:**

1. **Remove per-event flush calls**
   - File: `apps/runtime/src/services/stores/clickhouse-trace-store.ts`
   - Change: Remove `await this.writer.flush()` after `insert()` in `appendEvent()`, `createTrace()`, `endTrace()`
   - Keep flush in `close()`/shutdown drain path
   - Test: Load test showing reduced flush frequency and improved throughput

**Acceptance:** Trace write throughput improves; flush count drops by > 90% under load.

---

### Epic SO-01: Readiness Standardization (Fixes G10)

**Problem:** Runtime `/health/ready` checks only heap pressure and Redis. Mongo and ClickHouse outages don't fail readiness.

**Tasks:**

1. **Add Mongo to runtime readiness**
   - File: `apps/runtime/src/server.ts` (lines 305-342)
   - Change: Add `mongoose.connection.readyState === 1` check to `/health/ready`
   - Gate: `OBS_STRICT_READINESS_GATES` env flag

2. **Document readiness matrix per service**
   - Capture current health check behavior for workflow-engine, search-ai, search-ai-runtime
   - Define target dependency matrix (from RFC section 6.3)

**Acceptance:** Readiness fails deterministically when Mongo is down (with flag enabled). No false positives during steady state.

---

### Epic SO-02: Metrics Cardinality Control (Fixes G5)

**Problem:** Voice metrics use `session.id` as a label in 6 locations, creating unbounded metric series (one per session per instrument).

**Tasks:**

1. **Replace session.id labels in voice-metrics.ts**
   - File: `apps/runtime/src/observability/voice-metrics.ts` (lines 113, 115, 120, 124, 129, 192)
   - Change: Replace `'session.id'` with bounded labels: `'channel'`, `'voice.provider'`, `'agent_name'`
   - Gate: `OBS_METRIC_LABEL_GUARDRAILS` — emit both old and new labels for one release, then remove old

2. **Remove session.id from otel-trace-bridge span attributes**
   - File: `apps/runtime/src/observability/otel-trace-bridge.ts` (line 50)
   - Change: Remove `session.id` from span attributes (keep in trace event data where it belongs)

**Acceptance:** Metric series growth rate drops by >= 80% for voice realtime metrics. No dashboard regression during parallel emission window.

---

### Epic SO-03: Search Service Instrumentation (Fixes G7, G8)

**Problem:** search-ai-runtime has a metrics router defined but not mounted, and no requestIdMiddleware.

**Tasks:**

1. **Mount metrics router in search-ai-runtime**
   - File: `apps/search-ai-runtime/src/server.ts`
   - Change: Import `metricsRouter` from `./routes/metrics.ts` and add `app.use('/metrics', metricsRouter)`
   - Test: HTTP GET `/metrics` returns Prometheus text format

2. **Add requestIdMiddleware to search-ai-runtime**
   - Same file
   - Change: Import `requestIdMiddleware` from `@agent-platform/shared-observability` and mount via `app.use(requestIdMiddleware())`
   - Test: Response includes `X-Request-ID` header

**Acceptance:** search-ai-runtime `/metrics` returns scrape-ready Prometheus output. All responses include `X-Request-ID`.

---

### Epic SO-04: Config Flag Wiring (Fixes G9)

**Problem:** `packages/config/src/schemas/observability.schema.ts` defines `OTEL_ENABLED` and `METRICS_ENABLED` but no code checks them.

**Tasks:**

1. **Gate OTEL SDK initialization**
   - File: `apps/runtime/src/observability/otel-setup.ts`
   - Change: Check `process.env.OTEL_ENABLED !== 'false'` before calling `sdk.start()` (default: enabled for backward compat)
   - Same change in `apps/workflow-engine/src/observability/otel-setup.ts`

2. **Gate metrics recording**
   - File: `apps/runtime/src/observability/metrics.ts`
   - Change: No-op instrument wrappers when `METRICS_ENABLED === 'false'`

**Acceptance:** Setting `OTEL_ENABLED=false` prevents OTEL SDK initialization. Setting `METRICS_ENABLED=false` stops metric recording.

---

## 3. Implementation Schedule

### Phase 1: Quick Wins (Week 1)

| Task                                           | Epic  | Effort | Risk                                  |
| ---------------------------------------------- | ----- | ------ | ------------------------------------- |
| Mount metrics router in search-ai-runtime      | SO-03 | 30min  | None                                  |
| Add requestIdMiddleware to search-ai-runtime   | SO-03 | 30min  | None                                  |
| Remove per-event flush in ClickHouseTraceStore | AO-03 | 1h     | Low — BufferedWriter handles batching |
| Create feature flags (4 env vars)              | All   | 1h     | None                                  |

### Phase 2: Propagation and Readiness (Week 2-3)

| Task                                                | Epic  | Effort | Risk                              |
| --------------------------------------------------- | ----- | ------ | --------------------------------- |
| Add traceparent/tracestate to workflow-engine proxy | AO-01 | 2h     | Low — additive headers            |
| Add trace context to Kafka headers (behind flag)    | AO-01 | 4h     | Low — flag-gated                  |
| Reorder trace read path (behind flag)               | AO-02 | 4h     | Medium — fallback behavior change |
| Add Mongo to runtime readiness (behind flag)        | SO-01 | 2h     | Medium — could reduce capacity    |
| Gate OTEL SDK on env flag                           | SO-04 | 2h     | Low                               |

### Phase 3: Cardinality and Polish (Week 3-4)

| Task                                                  | Epic  | Effort | Risk                         |
| ----------------------------------------------------- | ----- | ------ | ---------------------------- |
| Replace session.id in voice metrics (parallel labels) | SO-02 | 4h     | Medium — dashboard migration |
| Add response metadata to trace API                    | AO-02 | 2h     | Low                          |
| Add request_id to PlatformEvent flow                  | AO-02 | 2h     | Low                          |

### Phase 4: Rollout and Verification (Week 5-6)

| Task                                                    | Effort | Risk   |
| ------------------------------------------------------- | ------ | ------ |
| Enable `OBS_TRACE_CANONICAL_READ` in staging, verify    | 2h     | Low    |
| Enable `OBS_STRICT_READINESS_GATES` per service, verify | 4h     | Medium |
| Enable `OBS_EVENTBUS_TRACE_HEADERS`, verify consumers   | 2h     | Low    |
| Remove parallel voice metrics labels (old ones)         | 1h     | Low    |
| Remove `OBS_METRIC_LABEL_GUARDRAILS` parallel emission  | 1h     | Low    |

---

## 4. File Touchpoint Summary

| File                                                         | Epic  | Change                                     |
| ------------------------------------------------------------ | ----- | ------------------------------------------ |
| `apps/runtime/src/middleware/workflow-engine-proxy.ts`       | AO-01 | Add traceparent/tracestate headers         |
| `apps/runtime/src/services/event-bus/kafka-subscriber.ts`    | AO-01 | Add trace headers to Kafka messages        |
| `apps/runtime/src/services/event-bus/types.ts`               | AO-01 | Populate trace_id on publish               |
| `apps/runtime/src/routes/sessions.ts`                        | AO-02 | Reorder trace read path, add \_meta        |
| `packages/eventstore/src/schema/platform-event.ts`           | AO-02 | Add optional request_id                    |
| `apps/runtime/src/services/stores/clickhouse-trace-store.ts` | AO-03 | Remove per-event flush()                   |
| `apps/runtime/src/server.ts`                                 | SO-01 | Add Mongo to /health/ready                 |
| `apps/runtime/src/observability/voice-metrics.ts`            | SO-02 | Replace session.id labels (6 locations)    |
| `apps/runtime/src/observability/otel-trace-bridge.ts`        | SO-02 | Remove session.id from span attributes     |
| `apps/search-ai-runtime/src/server.ts`                       | SO-03 | Mount metrics router + requestIdMiddleware |
| `apps/runtime/src/observability/otel-setup.ts`               | SO-04 | Gate SDK on OTEL_ENABLED                   |
| `apps/workflow-engine/src/observability/otel-setup.ts`       | SO-04 | Gate SDK on OTEL_ENABLED                   |
| `apps/runtime/src/observability/metrics.ts`                  | SO-04 | No-op when METRICS_ENABLED=false           |

---

## 5. Test Plan

### 5.1 Unit Tests

1. `workflow-engine-proxy.test.ts`: Verify traceparent/tracestate forwarded in fetch headers.
2. `kafka-subscriber.test.ts`: Verify trace headers present when flag enabled, absent when disabled.
3. `voice-metrics.test.ts`: Verify no `session.id` label in any metric recording call.
4. `clickhouse-trace-store.test.ts`: Verify `flush()` not called after `appendEvent()`.

### 5.2 Integration Tests

1. Runtime→workflow-engine trace continuity: Send request, verify child span has correct parent from traceparent header.
2. Session trace API: Verify `_meta.source` reflects actual data source.
3. Readiness: Simulate Mongo disconnect, verify `/health/ready` returns 503 when flag enabled.

### 5.3 Load Tests

1. Before/after trace write throughput with batched vs per-event flush.
2. Metric series count before/after voice metrics cardinality fix.

---

## 6. Rollback

Each fix is independently reversible:

1. **Feature flags:** `OBS_TRACE_CANONICAL_READ`, `OBS_STRICT_READINESS_GATES`, `OBS_EVENTBUS_TRACE_HEADERS` — set to `false` to revert behavior.
2. **Parallel metrics:** Old voice metric labels emitted alongside new ones during transition; remove new ones to revert.
3. **Flush removal:** Re-add `await flush()` if trace loss window proves unacceptable (unlikely — 5s max).
4. **Search-ai-runtime mounts:** Remove `app.use` lines to unmount (zero behavior change for existing code).

---

## 7. Definition of Done

1. All 10 gaps (G1-G10) addressed — G1 documented as by-design, G2-G10 fixed in code.
2. Feature flags functional and documented.
3. No regression in existing test suites (compiler 4K+, runtime 7K+, search-ai 1K+, studio 3.4K+).
4. Voice metric series growth rate reduced by >= 80%.
5. Trace write flush count reduced by >= 90% under load.
6. All services return `X-Request-ID` in responses.
