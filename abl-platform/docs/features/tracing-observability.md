# Feature Spec: Tracing & Observability

**Slug:** tracing-observability
**Status:** BETA
**Owner:** Platform team
**Created:** 2026-03-22
**Last Updated:** 2026-04-15

---

## 1. Problem Statement

Agent platform executions involve multi-step, multi-agent workflows with LLM calls, tool invocations, handoffs, flow transitions, and constraint checks. Without comprehensive tracing:

- Developers cannot diagnose why an agent made a specific decision or produced an unexpected response.
- There is no end-to-end visibility into execution latency, token costs, or error propagation across agent handoff chains.
- Production debugging requires manual log correlation across Runtime, Redis, and ClickHouse.
- No programmatic debugging (breakpoints, step-through, state inspection) exists for agent DSL execution.

## 2. Goal

Provide a unified, hierarchical, OpenTelemetry-compatible tracing pipeline that captures every execution decision from session start to completion, persists traces durably in ClickHouse, delivers them in real-time via WebSocket, and exposes them through a visual Observatory UI with debugging capabilities.

## 3. Non-Goals

- Full APM replacement (Datadog/New Relic-style infrastructure monitoring is handled by Coroot).
- Custom ClickHouse deployment management (ClickHouse is pre-provisioned infrastructure).
- Trace-based automated agent optimization or self-healing (future roadmap).
- Cross-tenant trace correlation (traces are strictly tenant-isolated).

## 4. Target Users

| Persona           | Use Case                                                     |
| ----------------- | ------------------------------------------------------------ |
| Agent Developer   | Debug scripted/reasoning agent flows in Studio               |
| Platform Engineer | Diagnose production session failures, latency spikes         |
| QA/Test Engineer  | Validate agent behavior via trace inspection                 |
| Product Manager   | Review session analytics (cost, duration, error rates)       |
| SRE/Ops           | Monitor agent health, set up alerts on trace-derived metrics |

## 5. User Stories

### US-1: Real-time Trace Streaming

**As an** agent developer, **I want** to see trace events appear in real-time as I test my agent in Studio, **so that** I can immediately understand what the agent is doing at each step.

**Acceptance Criteria:**

- Trace events stream via WebSocket within 100ms of emission
- Events include agent name, span hierarchy, timestamps, and duration
- Filtering by event type is available in the UI

### US-2: Hierarchical Span Visualization

**As an** agent developer, **I want** to see a waterfall/tree view of spans showing parent-child relationships, **so that** I can understand the execution hierarchy (session > agent > flow step > LLM call > tool call).

**Acceptance Criteria:**

- Spans rendered in a tree/waterfall with nesting up to 5 levels deep
- Critical path highlighted
- Duration bars proportional to execution time

### US-3: Decision Trace Inspection

**As an** agent developer, **I want** to inspect decision trace events (handoff reasoning, field validation, flow transitions), **so that** I can understand why the agent chose a particular path.

**Acceptance Criteria:**

- Decision events include `decisionKind`, `reason`, `candidates`, `selected`
- Verbosity-gated: standard shows handoff/flow; verbose shows extraction/correction
- Decision events are persisted to ClickHouse alongside other trace events

### US-4: Historical Session Trace Retrieval

**As a** platform engineer, **I want** to retrieve traces for sessions that completed hours or days ago, **so that** I can debug production incidents without needing an active session.

**Acceptance Criteria:**

- ClickHouse serves as canonical persistent store
- Fallback chain: in-memory TraceStore -> ClickHouse trace_events -> EventStore platform_events
- Traces queryable by session ID, time range, event type, agent name

### US-5: Programmatic Debugging

**As an** agent developer, **I want** to set breakpoints on agent entry, flow steps, and event types, **so that** I can pause execution, inspect state, and step through the agent logic.

**Acceptance Criteria:**

- Breakpoint types: agent (entry/exit), step, event type, conditional expression
- Pause/resume/step-over/step-into/step-out controls
- State snapshot available at breakpoint (session context, agent stack, gathered data)
- Debug protocol accessible via WebSocket on port 9229

### US-6: OpenTelemetry Export

**As an** SRE, **I want** trace data exported to our OpenTelemetry collector, **so that** I can correlate agent traces with infrastructure traces in Jaeger/Tempo.

**Acceptance Criteria:**

- OTEL SDK initialized at runtime startup (NodeTracerProvider, BatchSpanProcessor)
- TraceStore events bridged to OTEL spans with proper parent context
- W3C Trace Context compatible span/trace IDs
- Configurable via `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable

### US-7: Trace-Derived Metrics

**As an** SRE, **I want** application-level metrics (LLM call duration, token counts, tool call duration, active sessions) exported to the OTEL Metrics collector, **so that** I can build dashboards and set up alerts.

**Acceptance Criteria:**

- Histograms: `http.server.request.duration`, `llm.call.duration`, `tool.call.duration`
- Counters: `llm.call.tokens`, `rate_limit.rejections`
- Gauges: `agent.active_sessions`, `circuit_breaker.state`
- All metrics include relevant labels (provider, model, tool name, tenant)

### US-8: Multi-Pod Trace Delivery

**As a** platform engineer, **I want** traces from any Runtime pod to be visible in Studio, **so that** I can debug sessions regardless of which pod handles them.

**Acceptance Criteria:**

- Redis Streams + Pub/Sub for cross-pod trace delivery
- Anti-duplicate logic (skip events from same pod on Pub/Sub receive)
- Stream replay on subscriber connect
- Memory pressure circuit breaker (shed stream writes at 80% Redis maxmemory)

### US-9: PII Scrubbing in Traces

**As a** compliance officer, **I want** PII automatically redacted from trace data before persistence, **so that** trace storage complies with data protection regulations.

**Acceptance Criteria:**

- Tool call inputs/outputs scrubbed via `scrubToolCallData`
- LLM messages redacted via `redactPII`
- Secrets scrubbed via `scrubSecrets`
- Handoff/escalation context trimmed to key names only (no PII in trace data)
- Context field names replaced with generic placeholders when scrubPII is enabled

### US-10: Session Analytics Dashboard

**As a** product manager, **I want** to see aggregate session metrics (duration, message count, token usage, cost, error rate) across all sessions, **so that** I can track agent performance over time.

**Acceptance Criteria:**

- Session list with filtering (status, channel, time range)
- Per-session metrics: duration, messageCount, traceEventCount, tokenCount, estimatedCost, errorCount
- Generations view (LLM calls with model, tokens, latency)
- Export to CSV

## 6. Scope

### In Scope

- Trace event emission from Runtime execution pipeline
- In-memory TraceStore (ring buffer, per-session, bounded)
- Redis TraceStore (cross-pod, Streams + Pub/Sub)
- ClickHouse persistence via EventStore (buffered writes, WAL recovery)
- OpenTelemetry bridge (traces, metrics, logs)
- Observatory package (schema: trace events, spans; protocol: debug server, breakpoints)
- Studio trace store and observatory store (Zustand)
- Debug protocol (WebSocket, breakpoints, pause/resume, state inspection)
- Trace emitter with verbosity gating and PII scrubbing
- Trace forwarder (construct-layer to runtime TraceStore bridge)
- Session/trace REST API endpoints
- MCP debug tools (13 tools for programmatic debugging)

### Out of Scope

- ClickHouse cluster management and schema migrations (infrastructure concern)
- Coroot deployment and eBPF probe configuration (separate ops concern)
- Cross-tenant trace correlation
- Automated anomaly detection on traces (future feature)
- Studio Observatory UI layout and components (separate feature: observatory-ui)

## 7. Architecture Overview

```
                         ┌──────────────────────────────┐
                         │         Studio (UI)           │
                         │  trace-store (Zustand)        │
                         │  observatory-store (Zustand)  │
                         │  WebSocket client             │
                         └───────────┬──────────────────┘
                                     │ WS / REST
                         ┌───────────▼──────────────────┐
                         │      Runtime (Express)        │
                         │                               │
                         │  ┌─────────────────────────┐  │
                         │  │ TraceEmitter             │  │
                         │  │  - emit()                │  │
                         │  │  - logLLMCall()          │  │
                         │  │  - logToolCall()         │  │
                         │  │  - emitDecision()        │  │
                         │  │  - verbosity gating      │  │
                         │  │  - PII scrubbing         │  │
                         │  └──────┬──────────────────┘  │
                         │         │                      │
                         │  ┌──────▼──────────────────┐  │
                         │  │ TraceStore (Interface)   │  │
                         │  │  Memory impl (ring buf)  │  │
                         │  │  Redis impl (Streams)    │  │
                         │  └──────┬──────────────────┘  │
                         │         │                      │
                         │  ┌──────▼──────────────────┐  │
                         │  │ EventStore -> ClickHouse │  │
                         │  │  BufferedWriter          │  │
                         │  │  WAL recovery            │  │
                         │  └──────┬──────────────────┘  │
                         │         │                      │
                         │  ┌──────▼──────────────────┐  │
                         │  │ OtelTraceStore bridge    │  │
                         │  │  -> OTLP gRPC exporter   │  │
                         │  └─────────────────────────┘  │
                         │                               │
                         │  ┌─────────────────────────┐  │
                         │  │ Debug Server (:9229)     │  │
                         │  │  Breakpoints, Pause,     │  │
                         │  │  Step, State, Explain    │  │
                         │  └─────────────────────────┘  │
                         └───────────────────────────────┘
```

## 8. Data Model

### 8.1 TraceEvent (Runtime)

| Field        | Type                    | Description                           |
| ------------ | ----------------------- | ------------------------------------- |
| id           | string (UUID)           | Unique event identifier               |
| sessionId    | string                  | Session this event belongs to         |
| type         | string                  | Event type (30+ types defined)        |
| timestamp    | Date                    | When the event occurred               |
| data         | Record<string, unknown> | Event-specific payload                |
| agentName    | string?                 | Current agent name                    |
| spanId       | string?                 | W3C-compatible span ID (16 hex chars) |
| parentSpanId | string?                 | Parent span for hierarchy             |
| durationMs   | number?                 | Duration for timed events             |
| tenantId     | string?                 | Tenant isolation                      |

### 8.2 ExtendedTraceEvent (Observatory)

Extends TraceEvent with:
| Field | Type | Description |
|-------|------|-------------|
| traceId | string | W3C trace ID (32 hex chars) |
| stepName | string? | Current flow step |
| metadata | TraceEventMetadata? | Severity, tags, source location |

### 8.3 Span (Observatory)

| Field               | Type                    | Description                 |
| ------------------- | ----------------------- | --------------------------- |
| spanId              | string                  | Unique span ID              |
| traceId             | string                  | Parent trace ID             |
| parentSpanId        | string?                 | Parent span for nesting     |
| name                | string                  | Human-readable span name    |
| startTime / endTime | Date                    | Timing                      |
| durationMs          | number?                 | Computed duration           |
| status              | SpanStatus              | running / completed / error |
| agentName           | string                  | Associated agent            |
| sessionId           | string                  | Session reference           |
| events              | ExtendedTraceEvent[]    | Events within this span     |
| attributes          | Record<string, unknown> | Key-value metadata          |

### 8.4 Event Types Taxonomy (30+ types)

**Core (7):** llm_call, tool_call, decision, constraint_check, handoff, escalation, error

**Extended (10):** session_start, session_end, agent_enter, agent_exit, flow_step_enter, flow_step_exit, flow_transition, entity_extraction, delegate_start, delegate_complete

**Attachment Lifecycle (5):** attachment_upload, attachment_scan, attachment_process, attachment_index, attachment_delete

**Suspension Lifecycle (8):** execution_suspended, execution_resumed, execution_resume_failed, callback_received, callback_claimed, callback_expired, barrier_branch_completed, barrier_all_complete

**ABL Constructs (6):** dsl_collect, dsl_prompt, dsl_respond, dsl_set, dsl_on_input, dsl_call

**Engine/Runtime (12):** completion_check, engine_decision, handoff_condition_check, thread_return, data_stored, digression, sub_intent, correction, constraint_violation, warning, user_message, tool_thought

**Voice (8):** voice_session_start, voice_session_end, voice_turn, voice_stt, voice_tts, voice_barge_in, voice_asr_quality, voice_asr_cascade

## 9. Trace Verbosity Levels

| Level    | Included                                                    | Use Case                 |
| -------- | ----------------------------------------------------------- | ------------------------ |
| minimal  | errors, escalations, completion                             | Production high-volume   |
| standard | above + step transitions, tool calls, constraints, handoffs | Default for Studio debug |
| verbose  | above + all decisions (extraction, memory, corrections)     | Deep debugging           |
| debug    | above + LLM prompts/responses, raw data                     | Full diagnosis           |

## 10. Storage Tiers

| Tier    | Store                        | Capacity                             | TTL                          | Use                                      |
| ------- | ---------------------------- | ------------------------------------ | ---------------------------- | ---------------------------------------- |
| Hot     | Memory TraceStore            | 500 events/session, 50K sessions max | 120 min                      | Real-time streaming, WebSocket broadcast |
| Warm    | Redis TraceStore             | 500 events/session (MAXLEN ~500)     | Configurable (maxAgeMinutes) | Cross-pod delivery, replay on subscribe  |
| Cold    | ClickHouse (trace_events)    | Unlimited                            | Retention policy             | Historical queries, analytics, export    |
| Archive | EventStore (platform_events) | Unlimited                            | Configurable retention       | Cross-session analytics, GDPR cascades   |

## 11. API Surface

### REST Endpoints (18 endpoints)

| Method | Path                                                          | Purpose                    |
| ------ | ------------------------------------------------------------- | -------------------------- |
| POST   | /api/projects/:projectId/sessions                             | Create test session        |
| GET    | /api/projects/:projectId/sessions                             | List sessions with filters |
| GET    | /api/projects/:projectId/sessions/:id                         | Full session detail        |
| DELETE | /api/projects/:projectId/sessions/:id                         | Delete session             |
| POST   | /api/projects/:projectId/sessions/:id/close                   | Close session              |
| POST   | /api/projects/:projectId/sessions/:id/reset                   | Reset session              |
| GET    | /api/projects/:projectId/sessions/:id/traces                  | Get trace events           |
| GET    | /api/projects/:projectId/sessions/:id/traces/:spanId/children | Get span children          |
| GET    | /api/projects/:projectId/sessions/:id/metrics                 | Session metrics            |
| GET    | /api/projects/:projectId/sessions/:id/agent-spec              | Agent spec for session     |
| GET    | /api/projects/:projectId/sessions/:id/analysis                | Session analysis           |
| GET    | /api/projects/:projectId/sessions/export                      | CSV export                 |
| GET    | /api/projects/:projectId/sessions/generations                 | LLM generations list       |
| POST   | /api/projects/:projectId/sessions/bulk-close                  | Bulk close sessions        |
| POST   | /api/projects/:projectId/sessions/cleanup-orphans             | Cleanup orphaned sessions  |

### WebSocket Protocol

- Main WS: `/ws` -- trace event streaming, session lifecycle
- Debug WS: `:9229` -- breakpoints, pause/resume, state inspection

### MCP Debug Tools (13 tools)

connect, diagnose, inspect, list_agents, load_agent, list_active_sessions, session, analyze_session, get_errors, get_flow_graph, get_span_tree, send_message, traces

## 12. Configuration

| Env Variable                  | Default               | Description                     |
| ----------------------------- | --------------------- | ------------------------------- |
| TRACE_MAX_AGE_MINUTES         | 120                   | In-memory trace TTL             |
| TRACE_SESSION_TIMEOUT_MINUTES | 120                   | Inactive session purge timeout  |
| OTEL_EXPORTER_OTLP_ENDPOINT   | http://localhost:4317 | OTEL collector endpoint         |
| OTEL_SERVICE_NAME             | agent-platform        | Service name for OTEL           |
| OTEL_ENABLED                  | true                  | Enable/disable OTEL SDK         |
| METRICS_ENABLED               | true                  | Enable/disable OTEL metrics     |
| OTEL_DEBUG                    | false                 | Enable OTEL diagnostic logging  |
| REDIS_TRACE_MEMORY_THRESHOLD  | 0.8                   | Redis memory pressure threshold |
| EVENTSTORE_RESILIENCE_ENABLED | true                  | Enable WAL for EventStore       |
| EVENTSTORE_WAL_DIR            | /tmp/eventstore-wal   | WAL directory path              |

## 13. Security Considerations

- **Tenant Isolation:** All trace queries include tenantId. Redis keys are tenant-scoped (`trace:stream:{tenantId}:{sessionId}`).
- **PII Scrubbing:** configurable per-session via `scrubPII` flag. Tool call data scrubbed via `scrubToolCallData`, LLM content via `redactPII`, secrets via `scrubSecrets`.
- **Debug Server Auth:** Optional auth token for debug WebSocket connections.
- **Trace Data Encryption:** ClickHouse encryption at rest. In-transit via TLS.
- **GDPR Compliance:** EventStore provides `deleteBySessionIds` and `deleteTenant` for right-to-erasure cascades.

## 14. Performance Considerations

- **Ring Buffer:** In-memory TraceStore uses fixed-size ring buffer (500 events/session), oldest dropped when full.
- **Bounded Maps:** Memory TraceStore capped at 50K sessions with LRU eviction.
- **Redis Memory Pressure:** Circuit breaker sheds stream writes at configurable threshold (default 80%), continues Pub/Sub for real-time delivery.
- **Buffered ClickHouse Writes:** EventStore uses BufferedWriter (10K rows, 5s flush) with WAL recovery.
- **OTEL Batch Processing:** BatchSpanProcessor batches OTEL span exports.
- **Verbosity Gating:** Zero-cost gate via `shouldEmitTrace` -- returns false immediately for low verbosity.
- **Fire-and-Forget:** EventStore writes are non-blocking; failures logged but don't affect session execution.

## 15. Failure Modes

| Failure                    | Impact                          | Mitigation                                              |
| -------------------------- | ------------------------------- | ------------------------------------------------------- |
| Redis unavailable          | No cross-pod trace delivery     | Falls back to Memory TraceStore                         |
| ClickHouse down            | No historical trace persistence | WAL buffers events; periodic recovery retries           |
| OTEL collector unreachable | No OTEL span export             | BatchSpanProcessor drops after retry; no session impact |
| Memory pressure            | Risk of OOM                     | Ring buffer + session cap + cleanup job                 |
| WebSocket disconnect       | Client misses events            | Replay on reconnect from TraceStore buffer              |

## 16. Dependencies

| Package/Service               | Role                                                               |
| ----------------------------- | ------------------------------------------------------------------ |
| `@agent-platform/observatory` | Schema (trace events, spans), protocol (debug server, breakpoints) |
| `@abl/eventstore`             | ClickHouse persistence, WAL, GDPR, retention                       |
| `@abl/compiler/platform`      | TraceStore base class, TraceContextManager, createLogger           |
| `@opentelemetry/*`            | OTEL SDK, exporters, auto-instrumentations                         |
| Redis (ioredis)               | Cross-pod trace delivery (Streams + Pub/Sub)                       |
| ClickHouse                    | Persistent trace storage                                           |
| MongoDB                       | Session metadata storage                                           |

## 17. Open Questions / Gaps

| ID  | Question                                                                                             | Status                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Should trace sampling be configurable per-tenant for high-volume production?                         | DECIDED: Verbosity levels serve this purpose; per-tenant sampling TBD                                                                                                   |
| Q2  | Observatory SpanTree component exists but is never rendered in production -- when will it ship?      | OPEN                                                                                                                                                                    |
| Q3  | No dedicated Prometheus `/metrics` endpoint on Runtime for scraping                                  | DECIDED: OTEL PeriodicExportingMetricReader handles export                                                                                                              |
| Q4  | In-memory TraceStore has no bounded eviction by memory pressure (only by count)                      | OPEN: Memory-based eviction TBD                                                                                                                                         |
| Q5  | RedisTraceStore tenant cache (`MAX_TENANT_CACHE = 10,000`) may be insufficient for large deployments | OPEN                                                                                                                                                                    |
| Q6  | No trace sampling or tail-based sampling for high-cardinality production workloads                   | OPEN                                                                                                                                                                    |
| Q7  | OtelTraceStore `activeSpans` Map has `cleanupOrphanedSpans` but no automatic periodic cleanup        | OPEN                                                                                                                                                                    |
| Q8  | Debug server port (9229) hardcoded; conflicts with Node.js inspector protocol                        | OPEN: Configurable via DebugServerConfig.port                                                                                                                           |
| Q9  | agent_enter/agent_exit emitted only from WS handler, leaving 11+ other channels without lifecycle    | MITIGATED: Centralized in `executeMessage()` with `channelMetadata`. All 14 call sites now emit lifecycle events. See `docs/plans/session-observability-gaps.lld.md`.   |
| Q10 | Message persistence silently drops messages when `isDatabaseAvailable()` returns false               | MITIGATED: Removed guard, always enqueue to BullMQ. Circuit breaker prevents retry storms. See `docs/plans/session-observability-gaps.lld.md`.                          |
| Q11 | Studio shows incomplete session data when MongoDB writes fail (messages lost)                        | MITIGATED: Synthesizes assistant responses from `llm_call`/`dsl_respond` trace events in `useSessionDetail.ts`. Content-based dedup with 5s window prevents duplicates. |
| Q12 | Span waterfall is all-or-nothing — partial lifecycle data shows no spans                             | MITIGATED: Per-turn span synthesis in `replay-trace-events.ts`. Only missing turns get synthetic spans; real spans preserved.                                           |

### 17.1 Session Observability Gaps — Sub-feature

Addresses Q9-Q12 above. Implementation details in `docs/plans/session-observability-gaps.lld.md`. Test coverage in `docs/testing/session-observability-gaps.md`.

**Test coverage**: 105 tests (105 passing, 0 todo) across 6 test files:

- Unit: 62 tests (agent lifecycle, circuit breaker, message synthesis, span synthesis)
- E2E: 14 tests (lifecycle events, channel metadata, multi-turn, isolation, auth)
- Integration/Boundary: 29 tests (executor→TraceStore, persistence queue, circuit breaker, channel handlers, WS dedup, callback resilience)

## 18. References

- `packages/observatory/` -- trace event schema, span hierarchy, debug protocol
- `apps/runtime/src/services/trace-store.ts` -- Memory TraceStore implementation
- `apps/runtime/src/services/trace/redis-trace-store.ts` -- Redis TraceStore implementation
- `apps/runtime/src/services/trace-emitter.ts` -- Trace emission with PII scrubbing
- `apps/runtime/src/services/execution/trace-helpers.ts` -- Verbosity gating
- `apps/runtime/src/services/execution/trace-forwarder.ts` -- Construct-layer bridge
- `apps/runtime/src/observability/otel-setup.ts` -- OTEL SDK initialization
- `apps/runtime/src/observability/otel-trace-bridge.ts` -- TraceStore -> OTEL bridge
- `apps/runtime/src/observability/metrics.ts` -- OTEL application metrics
- `apps/runtime/src/services/eventstore-singleton.ts` -- ClickHouse EventStore
- `apps/runtime/src/services/debug-integration.ts` -- Debug runtime wrapper
- `apps/runtime/src/services/trace-event-types.ts` -- Event type -> platform type mapping
- `apps/studio/src/store/trace-store.ts` -- Client-side trace store (Zustand)
- `apps/studio/src/store/observatory-store.ts` -- Client-side observatory store (Zustand)
- `docs/observatory/` -- Observatory spec, roadmap, gap analysis
- `docs/plans/2026-03-10-unified-observability-design.md` -- Decision log merge design
