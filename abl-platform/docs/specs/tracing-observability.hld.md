# High-Level Design: Tracing & Observability

**Feature:** tracing-observability
**Status:** ALPHA
**Created:** 2026-03-22
**Last Updated:** 2026-03-22
**Inputs:** Feature Spec (`docs/features/tracing-observability.md`), Test Spec (`docs/testing/tracing-observability.md`)

---

## 1. Overview

The Tracing & Observability system provides end-to-end visibility into agent execution through a multi-tier, hierarchical tracing pipeline. Every agent decision, LLM call, tool invocation, handoff, and flow transition is captured as a structured trace event with OpenTelemetry-compatible span/trace IDs. Events flow through a three-tier storage chain (hot in-memory, warm Redis, cold ClickHouse) and are delivered in real-time via WebSocket to the Studio Observatory UI. A dedicated debug protocol enables programmatic breakpoints, step-through execution, and state inspection.

## 2. Architecture

### 2.1 Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        STUDIO (Next.js)                             │
│  ┌──────────────┐  ┌────────────────┐  ┌───────────────────────┐   │
│  │  trace-store  │  │ observatory-   │  │  useWebSocket /       │   │
│  │  (Zustand)    │  │ store (Zustand)│  │  useSessionTraces     │   │
│  │  1000 events  │  │ spans, flow,   │  │  hooks                │   │
│  │  type filter  │  │ metrics, debug │  │                       │   │
│  └──────┬───────┘  └──────┬─────────┘  └───────────┬───────────┘   │
│         └──────────────────┼──────────────────────┬─┘               │
│                            │                      │                 │
│                    REST API proxy         WebSocket client           │
└────────────────────────────┼──────────────────────┼─────────────────┘
                             │ HTTP                  │ WS
┌────────────────────────────▼──────────────────────▼─────────────────┐
│                       RUNTIME (Express)                             │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Execution Pipeline                        │   │
│  │  RuntimeExecutor → ReasoningExecutor / FlowStepExecutor     │   │
│  │  → GatherExecutor → ConstraintChecker → HandoffExecutor     │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
│                              │ onTraceEvent callback                │
│  ┌──────────────────────────▼───────────────────────────────────┐   │
│  │                    TraceEmitter                               │   │
│  │  - emit(event) → unified pipeline                            │   │
│  │  - logLLMCall / logToolCall / emitDecision / logHandoff     │   │
│  │  - verbosity gating (minimal/standard/verbose/debug)        │   │
│  │  - PII scrubbing (scrubToolCallData, redactPII, scrubSecrets)│  │
│  │  - span stack management (spanId/parentSpanId)              │   │
│  └──────┬──────────┬──────────┬──────────┬─────────────────────┘   │
│         │          │          │          │                           │
│  ┌──────▼──────┐   │  ┌──────▼──────┐   │                          │
│  │ TraceStore  │   │  │ EventStore  │   │                           │
│  │ Interface   │   │  │ → ClickHouse│   │                           │
│  │ ┌─────────┐ │   │  │ BufferedWr. │   │                           │
│  │ │ Memory  │ │   │  │ WAL recover │   │                           │
│  │ │ 500/sess│ │   │  └─────────────┘   │                           │
│  │ │ 50K sess│ │   │                    │                           │
│  │ └─────────┘ │   │           ┌────────▼────────┐                  │
│  │ ┌─────────┐ │   │           │ OtelTraceStore  │                  │
│  │ │ Redis   │ │   │           │ → OTLP gRPC     │                  │
│  │ │ Streams │ │   │           │ Jaeger/Tempo    │                  │
│  │ │ Pub/Sub │ │   │           └─────────────────┘                  │
│  │ └─────────┘ │   │                                                │
│  └─────────────┘   │                                                │
│                     │ WS broadcast                                   │
│  ┌──────────────────▼──────────────────────────────────────────┐    │
│  │                 WebSocket Handler                            │    │
│  │  trace_event / trace_replay / session_ended messages        │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │           Debug Server (:9229)                              │    │
│  │  BreakpointManager, SessionManager, Pause/Resume           │    │
│  │  16 commands, 15 event types                                │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │           OTEL Metrics (api-level)                          │    │
│  │  http.server.request.duration, llm.call.duration,           │    │
│  │  tool.call.duration, agent.active_sessions, etc.            │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow: Trace Event Lifecycle

```
1. Execution Pipeline emits event
       │
2. TraceEmitter.emit()
       │
       ├─── Verbosity check (shouldEmitTrace) → drop if below threshold
       │
       ├─── PII scrubbing (if scrubPII enabled)
       │
       ├──► TraceStore.addEvent()
       │      ├── Memory: ring buffer push (drop oldest at 500)
       │      │     └── WS broadcast to subscribers
       │      └── Redis: XADD stream + PUBLISH channel
       │            └── Pub/Sub → other pods → WS broadcast
       │
       ├──► WebSocket direct send (session WS)
       │
       ├──► EventStore.emitter.emit() (fire-and-forget)
       │      ├── TRACE_TO_PLATFORM_TYPE mapping
       │      ├── category inference
       │      └── ClickHouse BufferedWriter (10K/5s batch)
       │
       └──► OtelTraceStore.appendEvent() (if OTEL enabled)
              └── OTLP gRPC → Collector → Jaeger/Tempo
```

### 2.3 Data Flow: Trace Retrieval Fallback Chain

```
GET /sessions/:id/traces
       │
1. In-memory TraceStore.getEvents(sessionId)
       │ found? → return
       │ empty? ↓
2. ClickHouse trace_events table query
       │ found? → return
       │ empty? ↓
3. EventStore platform_events table query
       │ found? → return
       │ empty? → return []
```

## 3. The 12 Architectural Concerns

### 3.1 Resource Isolation

**Tenant Isolation:**

- Every trace query includes `tenantId` in the filter.
- Redis keys are tenant-scoped: `trace:stream:{tenantId}:{sessionId}`, `trace:channel:{tenantId}:{sessionId}`.
- RedisTraceStore maintains a bounded tenant cache (`MAX_TENANT_CACHE = 10,000`) to resolve tenant IDs without repeated Redis lookups.
- ClickHouse queries always include `tenant_id` in the WHERE clause.
- Cross-tenant trace access returns 404 (not 403).

**Project Isolation:**

- All session/trace REST endpoints are under `/api/projects/:projectId/...`.
- Session queries include `projectId` in the filter.
- `requireProjectPermission(req, res, 'session:read')` guards all trace read endpoints.

**User Isolation:**

- Debug sessions track `createdBy` for ownership.
- Session list can be filtered by user for personal session views.

### 3.2 Centralized Auth

- All trace REST endpoints use `createUnifiedAuthMiddleware` / `requireAuth`.
- Debug server supports optional auth token via `DebugServerConfig.authToken`.
- WebSocket connections use the existing session token / JWT auth flow.
- No custom token verification anywhere in the trace pipeline.

### 3.3 Stateless Distributed

- **No pod-local state as truth.** In-memory TraceStore is a hot cache only -- ClickHouse is the canonical store.
- **Redis for cross-pod delivery.** RedisTraceStore uses Streams (durable buffer) + Pub/Sub (real-time fan-out) so any pod can serve any session's traces.
- **Anti-duplicate logic.** Each pod has a unique `POD_ID`. Events received via Pub/Sub from the same pod are skipped (already broadcast locally).
- **Stateless REST endpoints.** Session/trace endpoints query Redis/ClickHouse -- no reliance on in-memory state.

### 3.4 Traceability

This IS the traceability system. Every execution path emits `TraceEvent`s via the shared `TraceEmitter`:

- **30+ event types** covering session lifecycle, agent lifecycle, flow execution, LLM calls, tool calls, decisions, constraints, handoffs, escalations, errors, delegation, and suspension.
- **Hierarchical spans** with W3C Trace Context compatible IDs (spanId: 16 hex chars, traceId: 32 hex chars).
- **Verbosity-gated emission** prevents noise while ensuring critical events always flow.
- No ad-hoc logging as a substitute for trace events.

### 3.5 Compliance

- **PII Scrubbing:** Tool call data scrubbed via `scrubToolCallData`, LLM messages redacted via `redactPII`, secrets removed via `scrubSecrets`. Handoff/escalation context trimmed to key names only. Context field names replaced with generic placeholders when `scrubPII` is enabled.
- **Encryption at Rest:** ClickHouse encryption for persistent traces. Redis TLS for warm tier.
- **Data Minimization:** Ring buffer (500/session) and TTL (120 min) limit hot tier retention. ClickHouse retention policies manage cold tier.
- **Right to Erasure:** EventStore provides `gdpr.deleteBySessionIds(tenantId, sessionIds)` and `gdpr.deleteTenant(tenantId)`. These cascade from session/tenant deletion hooks registered at startup.
- **Audit Logging:** Trace access is logged via the platform audit log.

### 3.6 Performance

- **Ring Buffer:** Memory TraceStore uses a fixed-size array per session (500 events). Oldest dropped via `shift()` when full -- O(1) amortized.
- **Bounded Session Map:** Memory TraceStore capped at 50,000 sessions. LRU eviction on new session creation.
- **Redis Batching:** RedisTraceStore uses `pipeline()` for atomic stream write + TTL set + publish -- single round-trip (~0.5ms).
- **Memory Pressure Circuit Breaker:** RedisTraceStore monitors `INFO memory` every 30s. At threshold (default 80%), stream writes are shed (Pub/Sub continues for real-time delivery).
- **ClickHouse Buffered Writes:** EventStore uses BufferedWriter (10K rows, 5s flush interval). WAL provides durability during ClickHouse downtime.
- **Verbosity Gating:** `shouldEmitTrace()` short-circuits immediately for low verbosity -- zero overhead for suppressed events.
- **Fire-and-Forget Persistence:** EventStore writes are non-blocking. OTEL bridge writes are fire-and-forget. Neither blocks session execution.
- **OTEL Batch Export:** BatchSpanProcessor, PeriodicExportingMetricReader (15s interval), BatchLogRecordProcessor -- all batch exports to minimize network overhead.

### 3.7 Error Handling

- **TraceStore unavailable:** `try/catch` in `emit()` -- logs warning, continues execution. No session impact.
- **EventStore write failure:** `try/catch` in `emit()` -- logs warning via `createLogger`. WAL buffers events for later recovery.
- **OTEL collector unreachable:** BatchSpanProcessor handles retries and drops -- no session impact.
- **Redis disconnection:** RedisTraceStore subscriber reconnection. Local subscribers continue to receive events from the local memory buffer.
- **WebSocket dead sockets:** Broadcast loop detects `readyState !== OPEN`, removes dead sockets from subscriber set.
- **Malformed Pub/Sub messages:** `try/catch` in `handlePubSubMessage()` ignores malformed JSON.
- **All errors logged:** Using `createLogger('module')` from `@abl/compiler/platform`, never `console.log` in production paths (though some legacy `console.log` calls remain in TraceStore).

### 3.8 Extensibility

- **TraceStoreInterface:** Abstract interface (`addEvent`, `subscribe`, `unsubscribe`, `getEvents`, etc.) enables new storage backends (e.g., Kafka, DynamoDB) without changing the emission pipeline.
- **Event Type Taxonomy:** Discriminated union of string literal types. New event types added by extending the union -- existing consumers ignore unknown types.
- **TRACE_TO_PLATFORM_TYPE mapping:** New event types can be mapped to platform analytics types by adding entries to the mapping object.
- **Verbosity Configuration:** New event types added to `EVENT_VERBOSITY` map with their required verbosity level.
- **Debug Protocol:** `DebugCommand` union type is extensible with new command types.
- **MCP Debug Tools:** 13 tools registered in `packages/mcp-debug` -- new tools added by extending the registration.

### 3.9 Observability (Self-Monitoring)

- **TraceStore Stats:** `getStats()` returns sessionCount, totalEvents, totalSubscribers, config.
- **Redis Memory Monitoring:** `refreshMemoryPressure()` logs warnings on pressure transitions.
- **OTEL Self-Diagnostics:** `OTEL_DEBUG=true` enables `DiagConsoleLogger` at INFO level.
- **Cleanup Job Logging:** Periodic cleanup logs sessions and events removed.
- **Shed Counting:** RedisTraceStore tracks and periodically logs shed event counts during memory pressure.
- **OtelTraceStore activeSpanCount:** Property for monitoring active span count.

### 3.10 Testing

- **Existing Coverage:** 28 E2E tests in `observatory-api-e2e.test.ts`, all passing.
- **Test Spec:** 23 new scenarios (8 E2E, 10 integration, 5 unit) documented in `docs/testing/tracing-observability.md`.
- **Key Integration Points:** TraceStore ring buffer, Redis cross-pod delivery, memory pressure circuit breaker, OTEL bridge, verbosity gating, PII scrubbing, trace forwarder.
- **No Mocking Codebase Components:** E2E tests use real Express server with full middleware chain.

### 3.11 Deployment

- **OTEL Collector:** External dependency. Configured via `OTEL_EXPORTER_OTLP_ENDPOINT` env var. Optional -- system works without it.
- **Redis:** Required for multi-pod deployments. Singleton factory falls back to memory store when unavailable.
- **ClickHouse:** Required for persistent trace storage and analytics. EventStore initialization gated on `clickhouseReady` flag.
- **Debug Server:** Optional. Runs on configurable port (default 9229). Separate from main HTTP server.
- **Feature Flags:** `OTEL_ENABLED` (default true), `METRICS_ENABLED` (default true). `OTEL_ENABLED=false` completely disables OTEL SDK.
- **Graceful Shutdown:** OTEL SDK registers SIGTERM/SIGINT handlers for flush. Redis subscriber quit on stop. Cleanup intervals use `unref()` to not hold the event loop.

### 3.12 Migration

- **ClickHouse Schema:** The `trace_events` table already exists with the necessary columns. No schema migration required for current functionality.
- **Decision Log Merge:** The separate decision log system (`decision-log.ts`) was merged into the trace event pipeline. Decision entries now flow as `type: 'decision'` trace events with `decisionKind` field. This was a breaking change for clients that consumed the separate `decisions` WebSocket message type -- they now consume `trace_event` messages with `type === 'decision'`.
- **Feature Flag Removal:** `OBS_TRACE_CANONICAL_READ` feature flag was removed -- ClickHouse is now always the canonical read path for historical data.

## 4. Key Design Decisions

| ID  | Decision                                         | Rationale                                                               | Alternatives Considered                                                                                                    |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| D1  | Three-tier storage (Memory → Redis → ClickHouse) | Hot cache for real-time, warm for cross-pod, cold for analytics         | Single-tier (ClickHouse only) -- too slow for real-time. Two-tier (Memory + ClickHouse) -- no cross-pod support.           |
| D2  | Merge decisions into trace events                | Single pipeline, single UI, single persistence layer                    | Keep separate decision log -- adds complexity, two systems to maintain, decisions not in ClickHouse                        |
| D3  | W3C Trace Context compatible IDs                 | OTEL interoperability, standard tooling support                         | Custom ID format -- no interop with Jaeger/Tempo                                                                           |
| D4  | Redis Streams + Pub/Sub (not just Pub/Sub)       | Streams provide durable replay buffer; Pub/Sub alone is fire-and-forget | Pub/Sub only -- no replay on late subscriber. Kafka -- overkill for trace delivery.                                        |
| D5  | Memory pressure circuit breaker                  | Prevents Redis OOM while preserving real-time delivery via Pub/Sub      | Fixed-rate limiting -- doesn't adapt to actual memory. No protection -- risk of Redis crash.                               |
| D6  | Fire-and-forget persistence                      | Trace persistence must NEVER block agent execution                      | Synchronous write -- would add latency to every agent response. Async with backpressure -- complex, trace loss acceptable. |
| D7  | Verbosity gating at emission site                | Zero-cost suppression for unwanted events                               | Post-hoc filtering -- wastes bandwidth/storage. Always emit everything -- too noisy.                                       |
| D8  | PII scrubbing at emission site                   | PII never enters the persistence pipeline                               | Post-storage redaction -- PII briefly in transit/storage. No scrubbing -- compliance risk.                                 |

## 5. Risks and Mitigations

| Risk                                                        | Probability | Impact                  | Mitigation                                                                                               |
| ----------------------------------------------------------- | ----------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| Memory TraceStore grows unbounded if cleanup job is delayed | Low         | Medium (OOM)            | `maxSessions: 50000` hard cap + LRU eviction + 60s cleanup interval with `unref()`                       |
| Redis memory exhaustion from trace streams                  | Medium      | High (Redis crash)      | Memory pressure circuit breaker + `MAXLEN ~500` on streams + TTL expiry                                  |
| ClickHouse write lag during high-throughput sessions        | Medium      | Low (delayed analytics) | BufferedWriter batching + WAL recovery. Hot/warm tiers serve real-time needs.                            |
| OTEL `activeSpans` Map leak in OtelTraceStore               | Medium      | Medium (memory leak)    | `cleanupOrphanedSpans()` method available. Periodic cleanup not yet automated -- documented as gap Q7.   |
| Debug server port conflict with Node.js inspector           | Low         | Low                     | Configurable via `DebugServerConfig.port`. Default 9229 matches Node inspector convention intentionally. |
| Tenant cache exhaustion in RedisTraceStore                  | Low         | Low (performance)       | Bounded to 10K entries with LRU eviction. Documented as gap Q5 for large deployments.                    |

## 6. API Contract Summary

### REST API

All endpoints under `/api/projects/:projectId/sessions/...`. See Feature Spec Section 11 for complete endpoint list.

**Key Response Envelope:**

```json
{
  "success": true,
  "data": { ... }
}
```

Error:

```json
{
  "success": false,
  "error": { "code": "NOT_FOUND", "message": "Session not found" }
}
```

### WebSocket Protocol

**Client → Server:**

```json
{ "type": "subscribe_traces", "sessionId": "..." }
{ "type": "unsubscribe_traces", "sessionId": "..." }
```

**Server → Client:**

```json
{ "type": "trace_event", "sessionId": "...", "event": { ... } }
{ "type": "trace_replay", "sessionId": "...", "events": [...], "totalBuffered": 42 }
{ "type": "session_ended", "sessionId": "..." }
{ "type": "session_expired", "sessionId": "...", "reason": "inactive" }
```

### Debug Protocol (port 9229)

16 command types (connect, sessions, attach, detach, break, unbreak, breaks, pause, resume, step, state, trace, stack, explain, evaluate, follow).
15 event types (connected, sessions, attached, detached, session_created, session_ended, breakpoint_hit, paused, resumed, trace, state, stack, breaks, explain, evaluate_result, error).

## 7. Package Dependencies

```
@agent-platform/observatory (schema + protocol)
  ├── No external dependencies (pure TypeScript)
  └── Exports: TraceEvent types, Span/SpanManager, DebugServer, protocol types

apps/runtime (trace pipeline)
  ├── @agent-platform/observatory (types)
  ├── @abl/compiler/platform (TraceStore base, createLogger)
  ├── @abl/eventstore (ClickHouse persistence)
  ├── @opentelemetry/* (OTEL SDK)
  ├── ws (WebSocket)
  └── ioredis (Redis)

apps/studio (client stores)
  ├── zustand (state management)
  └── @agent-platform/observatory (types, re-exported)

packages/mcp-debug (debug tools)
  ├── @agent-platform/observatory (types)
  └── ws (WebSocket client)
```
