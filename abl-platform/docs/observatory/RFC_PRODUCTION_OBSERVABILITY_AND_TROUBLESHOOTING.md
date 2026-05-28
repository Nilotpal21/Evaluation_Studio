# RFC: Production Observability and Troubleshooting Architecture

**Status:** Draft
**Author:** Platform Engineering
**Date:** 2026-03-08
**Target Start Date:** 2026-03-09
**Related Docs:**

- `docs/plans/2026-03-08-production-observability-implementation-plan.md`

---

## 1. Executive Summary

This RFC defines a production-grade observability architecture for the agent platform. The platform already has substantial observability building blocks — OTEL SDKs in runtime and workflow-engine, a unified `PlatformEvent` schema with Zod validation, ClickHouse persistence with tiered TTLs, a `BufferedClickHouseWriter`, and `requestIdMiddleware` via AsyncLocalStorage. However, production troubleshooting remains inconsistent due to propagation gaps, flush inefficiencies, cardinality issues, and uneven instrumentation across services.

This RFC explicitly separates two domains:

1. **Agent Observability:** Why an agent made a decision, what user/session context drove it, and how to debug behavior outcomes.
2. **System Observability:** Whether the platform components and dependencies are healthy, performant, and reliable in production.

---

## 2. Problem Statement

### 2.1 What Works Today

| Component                  | Location                                                        | Status                                                                     |
| -------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| OTEL SDK (runtime)         | `apps/runtime/src/observability/otel-setup.ts`                  | Active — HTTP/Express auto-instrumentation, OTLP gRPC export               |
| OTEL SDK (workflow-engine) | `apps/workflow-engine/src/observability/otel-setup.ts`          | Active — includes MongoDB and Redis instrumentation                        |
| Request ID middleware      | `packages/shared-observability/src/middleware/request-id.ts`    | Mounted in runtime and search-ai (AsyncLocalStorage)                       |
| W3C traceparent parsing    | `packages/shared-observability/src/middleware/observability.ts` | Defined (lines 47-62), generates traceId/spanId                            |
| PlatformEvent schema       | `packages/eventstore/src/schema/platform-event.ts`              | 16 event categories, Zod-validated via EventRegistry                       |
| ClickHouse traces table    | `packages/database/src/clickhouse-schemas/init.ts`              | `abl_platform.traces` — tenant-scoped, encrypted, 7/30/90d TTL             |
| ClickHouse platform_events | Same file                                                       | `abl_platform.platform_events` — 6 materialized views for aggregation      |
| BufferedClickHouseWriter   | `packages/database/src/clickhouse.ts`                           | 10,000 rows or 5s interval, backpressure at 90%                            |
| Memory/Redis TraceStore    | `apps/runtime/src/services/trace-store.ts`                      | 500-event ring buffer per session, 120min TTL, WebSocket replay            |
| Runtime metrics            | `apps/runtime/src/observability/metrics.ts`                     | 8 instruments: HTTP duration, LLM calls, tool calls, circuit breakers      |
| Dead letter writer         | `apps/runtime/src/services/event-bus/dead-letter-writer.ts`     | `abl_platform.dead_letter_events`, 30d TTL                                 |
| Health endpoints (runtime) | `apps/runtime/src/server.ts` (lines 246-342)                    | `/health` checks Mongo+Redis+ClickHouse; `/health/ready` checks heap+Redis |
| Logger with PII redaction  | `packages/compiler/src/platform/logger.ts`                      | Auto-redacts 15 sensitive field names, SSN/CC/email regex patterns         |

### 2.2 Verified Gaps

| #   | Gap                                                                     | Evidence                                                                                                                                       | Impact                                                                               |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| G1  | `OtelTraceStore.getTrace()` and `queryTraces()` return null/empty       | `otel-trace-bridge.ts` lines 102-110                                                                                                           | OTEL spans exported but not queryable locally — trace trees incomplete for RCA       |
| G2  | Workflow-engine proxy does not forward `traceparent`/`tracestate`       | `workflow-engine-proxy.ts` lines 76-82 forward `x-request-id` and `x-tenant-id` only                                                           | Cross-service traces break at runtime→workflow-engine boundary                       |
| G3  | Session trace API falls back to `platform_events` with type translation | `sessions.ts` lines 1295-1312, type mapping at 1413-1444                                                                                       | Fallback maps `llm.call.completed`→`llm_call` etc., losing original schema fidelity  |
| G4  | `ClickHouseTraceStore.appendEvent()` calls `flush()` on every event     | Immediate flush per trace event, bypassing `BufferedWriter` batching                                                                           | Write amplification in hot path — defeats the 10K/5s batch policy                    |
| G5  | `session.id` used as metric label in voice metrics                      | `voice-metrics.ts` lines 113, 115, 120, 124, 129, 192                                                                                          | Unbounded cardinality — one metric series per session per counter                    |
| G6  | Kafka event bus has no trace context in headers or envelope             | `kafka-subscriber.ts` lines 212-216 set only `event-type`, `tenant-id`, `event-id`; `PlatformEvent` interface has no `traceId`/`spanId` fields | Events consumed by other services have no correlation to originating request spans   |
| G7  | search-ai-runtime metrics router defined but not mounted                | `routes/metrics.ts` exists (77 lines); `server.ts` has no `app.use` for it                                                                     | Prometheus scrape endpoint unreachable                                               |
| G8  | search-ai-runtime has no requestIdMiddleware                            | Server.ts has no observability middleware                                                                                                      | Orphan requests with no correlation ID                                               |
| G9  | Observability config flags defined but not consumed                     | `packages/config/src/schemas/observability.schema.ts` defines `OTEL_ENABLED`, `METRICS_ENABLED`                                                | OTEL SDK initializes unconditionally — flags have no effect                          |
| G10 | `/health/ready` (runtime) checks only heap pressure and Redis           | `server.ts` lines 305-342                                                                                                                      | Mongo and ClickHouse outages do not fail readiness — traffic routes to degraded pods |

---

## 3. Goals and Non-Goals

### 3.1 Goals

1. Fix the 10 verified gaps above with minimal blast radius.
2. Separate Agent Observability and System Observability data models, dashboards, SLOs, and ownership.
3. Make trace retrieval deterministic: canonical `abl_platform.traces` first, schema-compatible fallback only.
4. Introduce consistent readiness semantics with dependency-aware gates across all services.
5. Improve telemetry efficiency: batch trace writes, remove unbounded metric labels.
6. Establish alerting and dashboards aligned to troubleshooting workflows for each domain.

### 3.2 Non-Goals

1. Replacing ClickHouse as the telemetry analytics backend.
2. Full UI redesign of existing Studio observability views.
3. Replacing the `createLogger` framework or PII redaction approach.
4. Building a new incident management product.

### 3.3 Domain Separation

| Domain               | Primary Question           | Primary Consumers                           | Typical Signals                                                                                                                                 |
| -------------------- | -------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Observability  | Why did the agent do this? | Agent engineers, product engineers, support | Decision traces (`TraceEvent` types: `llm_call`, `tool_call`, `decision`, `constraint_check`, `handoff`), session timelines, guardrail outcomes |
| System Observability | Is the platform healthy?   | SRE, platform engineers, service owners     | HTTP latency/error SLOs, dependency health, queue lag, DLQ growth (`abl_platform.dead_letter_events`), writer backpressure, readiness flaps     |

---

## 4. Terminology

1. **Canonical trace record:** Row in `abl_platform.traces` (columns: `tenant_id`, `session_id`, `trace_id`, `span_id`, `parent_span_id`, `event_type`, `agent_name`, `data`, `duration_ms`, `has_error`, `error_message`, `sequence`).
2. **PlatformEvent:** Unified event envelope (`packages/eventstore/src/schema/platform-event.ts`) with Zod-validated `data` payload per `event_type`. Persisted to `abl_platform.platform_events`.
3. **TraceContext:** Runtime struct (`packages/compiler/src/platform/core/types.ts` lines 253-266) with `traceId`, `spanId`, `parentSpanId`, `sessionId`, `agentName`, `events[]`, `sequence` (HLC for cross-pod ordering).
4. **BufferedWriter:** `packages/database/src/clickhouse.ts` lines 91-227 — batches rows (10K or 5s), backpressure at 90%, drops oldest at 100%.
5. **Hop:** A cross-process boundary (HTTP call, Kafka publish/consume, BullMQ worker handoff).

---

## 5. Current Architecture Detail

### 5.1 Trace Storage (Three-Tier)

```text
Active sessions:
  MemoryTraceStore (500-event ring buffer per session, 120min TTL)
  ├─ WebSocket replay on subscribe (trace-store.ts lines 176-198)
  ├─ Optional Redis fallback (RedisTraceStore, lines 449-456)
  └─ Fire-and-forget forward to OtelTraceStore (lines 150-162)

Persistent:
  ClickHouseTraceStore → abl_platform.traces
  ├─ Encrypted at rest (_enc column, key_version rotation)
  ├─ Partitioned by toYYYYMMDD(timestamp)
  ├─ TTL: 7d warm → 30d cold → 90d delete
  └─ Indices: bloom_filter(trace_id), set(event_type), set(has_error)

Fallback (session trace API):
  abl_platform.platform_events
  ├─ Filtered by category IN (voice, session, llm, tool, agent)
  ├─ Type-translated (llm.call.completed → llm_call, agent.delegated → delegate_start, etc.)
  └─ TTL: 30d warm → 90d cold → 730d delete
```

### 5.2 Existing Telemetry Contract

The `PlatformEvent` interface already defines the core contract (16 categories, Zod-validated):

| Field                                        | Required   | Present Today                                                        |
| -------------------------------------------- | ---------- | -------------------------------------------------------------------- |
| `event_id` (ULID)                            | Yes        | Yes                                                                  |
| `event_type` (dotted: `session.started`)     | Yes        | Yes                                                                  |
| `category` (16 values)                       | Yes        | Yes                                                                  |
| `tenant_id`                                  | Yes        | Yes                                                                  |
| `project_id`                                 | Yes        | Yes                                                                  |
| `timestamp` (UTC)                            | Yes        | Yes                                                                  |
| `session_id`                                 | Contextual | Yes (default `''`)                                                   |
| `trace_id`                                   | Contextual | Yes (default `''`)                                                   |
| `agent_name`                                 | Contextual | Yes (default `''`)                                                   |
| `duration_ms`                                | Contextual | Yes (default 0)                                                      |
| `has_error` / `error_message` / `error_type` | On error   | Yes                                                                  |
| `data` (Zod-validated JSON)                  | Yes        | Yes                                                                  |
| `custom_dimensions` (Map)                    | Optional   | Yes (ngram index)                                                    |
| `span_id` / `parent_span_id`                 | Missing    | Only in `abl_platform.traces`, not in `platform_events`              |
| `request_id`                                 | Missing    | Only in HTTP middleware (AsyncLocalStorage), not persisted to events |
| `service` / `component`                      | Missing    | Not in event schema                                                  |

### 5.3 Health and Readiness

| Service           | `/health` Checks                                             | `/health/ready` Checks                      | Gap                                         |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------- |
| Runtime           | Mongo ping, Redis ping (3s timeout), ClickHouse cached probe | Heap < 1.5GB, Redis liveness, shutdown flag | No Mongo/ClickHouse in readiness            |
| Workflow-engine   | OTEL early bootstrap, Mongo (via instrumentation)            | Not documented                              | Readiness behavior unclear                  |
| Search-AI         | requestIdMiddleware mounted                                  | Health endpoints exist                      | No dependency-aware checks                  |
| Search-AI-Runtime | Health endpoints exist (lines 73-85)                         | Basic liveness                              | No requestIdMiddleware, metrics not mounted |

### 5.4 Metrics Instruments (Runtime)

Defined in `apps/runtime/src/observability/metrics.ts`:

| Instrument                      | Type          | Labels                                                           | Cardinality Issue?                 |
| ------------------------------- | ------------- | ---------------------------------------------------------------- | ---------------------------------- |
| `http_request_duration_seconds` | Histogram     | `http.route`, `http.response.status_code`, `http.request.method` | OK — bounded                       |
| `http_active_requests`          | UpDownCounter | none                                                             | OK                                 |
| `llm_call_duration_seconds`     | Histogram     | `llm.provider`, `llm.model`, `tool.success`                      | OK — bounded                       |
| `llm_tokens_total`              | Counter       | `llm.provider`, `llm.model`, `token.type`                        | OK                                 |
| `tool_call_duration_seconds`    | Histogram     | `tool.name`, `tool.success`                                      | OK                                 |
| `agent_active_sessions`         | UpDownCounter | none                                                             | OK                                 |
| `rate_limit_rejections_total`   | Counter       | `tenant_id`                                                      | Moderate — bounded by tenant count |
| `circuit_breaker_state`         | Gauge         | `breaker.name`, `breaker.state`                                  | OK                                 |

Voice metrics (`voice-metrics.ts`) — **ALL use `session.id` label:**

| Instrument                          | Cardinality Issue        |
| ----------------------------------- | ------------------------ |
| `voice_realtime_turn_latency`       | `session.id` — UNBOUNDED |
| `voice_realtime_tool_call_duration` | `session.id` — UNBOUNDED |
| `voice_realtime_active_sessions`    | `session.id` — UNBOUNDED |
| `voice_realtime_interruptions`      | `session.id` — UNBOUNDED |
| `voice_silence_threshold_hits`      | `session.id` — UNBOUNDED |

---

## 6. Target Architecture

### 6.1 Gap Fixes

| Gap                                            | Fix                                                                                                                                                                 | Approach                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| G1 OTEL query returns null                     | Not a bug — OTEL exports to external collector. Document that local query is not supported; canonical read path is ClickHouse.                                      | Documentation + canonical read path fix |
| G2 No traceparent to workflow-engine           | Add `traceparent` and `tracestate` header forwarding in `workflow-engine-proxy.ts` fetch call                                                                       | 2-line header addition                  |
| G3 Session trace fallback translation          | Route `/sessions/:id/traces` to `abl_platform.traces` first; fall back to `platform_events` only with `source` metadata in response                                 | Read path reorder + response metadata   |
| G4 Per-event flush in trace store              | Remove `await flush()` after each `writer.insert()` in ClickHouseTraceStore; rely on BufferedWriter's 10K/5s policy                                                 | Remove 1 line per method                |
| G5 session.id in voice metrics                 | Replace `session.id` with bounded labels: `channel`, `agent_name`, `voice_provider`                                                                                 | Label swap in 6 locations               |
| G6 No trace context in Kafka                   | Add `traceparent` and `tracestate` to Kafka message headers in `kafka-subscriber.ts`; add `trace_id` field to `PlatformEvent` envelope (already optional in schema) | 3 header additions + interface field    |
| G7 Metrics router not mounted                  | Add `app.use('/metrics', metricsRouter)` in search-ai-runtime `server.ts`                                                                                           | 1-line mount                            |
| G8 No requestIdMiddleware in search-ai-runtime | Import and mount `requestIdMiddleware` from `@agent-platform/shared-observability`                                                                                  | 2-line addition                         |
| G9 Config flags not consumed                   | Gate OTEL SDK init on `OTEL_ENABLED` env var; gate metrics recording on `METRICS_ENABLED`                                                                           | Conditional init wrapper                |
| G10 Readiness missing Mongo/CH                 | Add Mongo readyState check and optional ClickHouse probe to `/health/ready`                                                                                         | 10-15 lines in server.ts                |

### 6.2 Propagation Model (Target)

```text
HTTP boundaries:
  Forward traceparent, tracestate, x-request-id, x-tenant-id, x-session-id

Kafka boundaries:
  Message headers: traceparent, tracestate, event-type, tenant-id, event-id, session-id
  PlatformEvent.trace_id populated from current trace context

Async workers (BullMQ):
  Job data includes trace_id and parent_span_id
  Worker creates span link (not parent-child) to originating span
```

### 6.3 Readiness Model (Target)

Each service readiness endpoint gates on:

| Service           | Critical Dependencies                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Runtime           | Mongo readyState === 1, Redis ping (3s timeout), heap < configurable limit, shutdown flag |
| Workflow-engine   | Mongo readyState === 1                                                                    |
| Search-AI         | Mongo readyState === 1                                                                    |
| Search-AI-Runtime | Mongo readyState === 1, optional ClickHouse probe when analytics enabled                  |

ClickHouse failures degrade telemetry persistence but should NOT fail readiness (telemetry is async, not in request path). Feature flag `OBS_STRICT_READINESS_GATES` controls whether ClickHouse outage fails readiness.

---

## 7. Data Model Changes

### 7.1 Trace API Response Enhancement

Current: `/sessions/:id/traces` returns `{ events: TraceEvent[] }`.

Target: Add metadata to response:

```typescript
{
  events: TraceEvent[];
  _meta: {
    source: 'memory' | 'clickhouse_traces' | 'clickhouse_platform_events';
    event_count: number;
    is_truncated: boolean;
    query_window_ms: number;
  }
}
```

### 7.2 PlatformEvent Envelope Addition

Add optional `request_id` field to `PlatformEvent` interface:

```typescript
interface PlatformEvent<T, P> {
  // ... existing fields ...
  request_id?: string; // NEW: from AsyncLocalStorage request context
}
```

No ClickHouse schema change needed — `request_id` goes into `custom_dimensions` Map column (already indexed).

---

## 8. Feature Flags

| Flag                          | Purpose                                                 | Default | Scope        |
| ----------------------------- | ------------------------------------------------------- | ------- | ------------ |
| `OBS_TRACE_CANONICAL_READ`    | Route session trace API to `abl_platform.traces` first  | `false` | Runtime      |
| `OBS_STRICT_READINESS_GATES`  | Include Mongo in readiness check                        | `false` | All services |
| `OBS_METRIC_LABEL_GUARDRAILS` | Warn/reject high-cardinality metric labels at runtime   | `false` | Runtime      |
| `OBS_EVENTBUS_TRACE_HEADERS`  | Include traceparent/tracestate in Kafka message headers | `false` | Runtime      |

All flags gate via `process.env` checks. No config service dependency.

---

## 9. Security and Compliance

1. Tenant scoping: All telemetry queries include `tenant_id` in WHERE clause — enforced by ClickHouse table ORDER BY.
2. PII redaction: `createLogger` auto-redacts 15 sensitive field names + SSN/CC/email regex patterns (`packages/compiler/src/platform/logger.ts` lines 43-68).
3. Encryption at rest: `abl_platform.traces` has `encrypted` (UInt8) and `key_version` (UInt16) columns with `_enc` marker. KMS audit in `abl_platform.kms_audit_log`.
4. Event PII flags: EventRegistry tracks `containsPII` per event type (e.g. `gather.field.extracted`, `voice.session.started`). Used for GDPR scrubbing queries.
5. Debugging endpoints: Platform admin health at `/api/platform/admin/system-health` requires auth + IP whitelist.

---

## 10. Testing Strategy

1. **Unit tests:** Middleware propagation (traceparent forwarding), writer batching behavior (no per-event flush), label policy rejection.
2. **Integration tests:** Runtime→workflow-engine trace continuity via traceparent header, Kafka publish/consume trace linkage.
3. **Contract tests:** Session trace API returns `_meta.source` field, EventRegistry validates all registered event types.
4. **Load tests:** Trace write throughput with batched vs per-event flush (measure improvement), metric series count before/after cardinality fix.

---

## 11. SLOs

### 11.1 Agent Observability

1. Session trace retrieval p95: < 2s (measures canonical read path performance).
2. Decision trace completeness: >= 95% of sampled debug sessions have full chain (`llm_call` → `decision` → `tool_call` → `handoff`).
3. Trace correlation: >= 95% of incident sessions include valid `trace_id` + `session_id`.

### 11.2 System Observability

1. Runtime request success rate: 99.9% rolling 30d.
2. Runtime p95 latency: < 900ms text path.
3. Telemetry write success: >= 99.9% (BufferedWriter drop rate < 0.1%).
4. Readiness stability: < 1% readiness flap rate during steady state.

---

## 12. Risks and Mitigations

1. **Risk:** Readiness strictness reduces available capacity during transition.
   **Mitigation:** `OBS_STRICT_READINESS_GATES` flag; enable per-service, per-dependency.

2. **Risk:** Kafka header addition breaks existing consumers.
   **Mitigation:** `OBS_EVENTBUS_TRACE_HEADERS` flag; consumers ignore unknown headers by default.

3. **Risk:** Removing per-event flush increases trace loss window on crash.
   **Mitigation:** BufferedWriter already flushes every 5s; 5s loss window acceptable. Graceful shutdown drain preserved.

4. **Risk:** Voice metrics label change breaks existing dashboards.
   **Mitigation:** Emit both old and new labels for one release window behind `OBS_METRIC_LABEL_GUARDRAILS` flag.

---

## 13. Decision Log

1. **D1:** Canonical trace retrieval source is `abl_platform.traces`. Fallback to `platform_events` with `_meta.source` transparency.
2. **D2:** W3C trace headers mandatory on HTTP hops. Kafka headers added behind feature flag.
3. **D3:** Metric labels must be bounded. `session.id` prohibited in all metric instruments.
4. **D4:** ClickHouse failures do NOT fail readiness by default (telemetry is async). Strict mode behind flag.
5. **D5:** BufferedWriter batch policy (10K rows / 5s) is the default. Per-event `flush()` calls removed from ClickHouseTraceStore.

---

## 14. Open Questions

1. Should OTEL sampling rate differ between production (lower) and debugging sessions (100%)?
2. Should `request_id` be a first-class ClickHouse column or remain in `custom_dimensions` Map?
3. Should the runtime OTEL SDK include MongoDB/Redis auto-instrumentation (like workflow-engine does) or keep it lean?

---

## 15. Approval Checklist

1. [ ] Runtime engineering approves trace lifecycle and API changes.
2. [ ] Workflow-engine engineering approves propagation and span semantics.
3. [ ] Search platform engineering approves search-ai-runtime instrumentation.
4. [ ] SRE approves readiness policy and rollout gates.
5. [ ] Data platform approves ClickHouse schema compatibility.
