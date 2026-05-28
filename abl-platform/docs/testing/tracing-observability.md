# Test Spec: Tracing & Observability

**Feature:** tracing-observability
**Status:** PLANNED
**Created:** 2026-03-22
**Last Updated:** 2026-03-22

---

## 1. Test Strategy

The tracing & observability feature spans multiple packages and services: `packages/observatory` (schema + protocol), `apps/runtime` (TraceStore, TraceEmitter, OTEL bridge, EventStore, debug integration), and `apps/studio` (Zustand stores). Testing requires:

- **E2E tests:** Exercise the full trace pipeline through HTTP API -- create session, send messages, retrieve traces, verify persistence.
- **Integration tests:** Test real service boundaries -- TraceStore with Redis, EventStore with ClickHouse, OTEL bridge with collector mock.
- **Unit tests:** Observatory schema utilities, verbosity gating, PII scrubbing, span hierarchy building.

No mocking of codebase components in E2E tests. Only external third-party services (ClickHouse, Redis, OTEL collector) may be stubbed via dependency injection.

---

## 2. E2E Test Scenarios

### E2E-1: Full Trace Pipeline -- Session Create to Trace Retrieval

**Objective:** Verify that creating a session, sending messages, and retrieving traces produces a complete trace event chain persisted in the trace store.

**Steps:**

1. POST `/api/projects/:projectId/sessions` to create a session
2. Send a user message via WebSocket
3. Wait for agent response
4. GET `/api/projects/:projectId/sessions/:id/traces` to retrieve traces
5. Verify trace events include: `agent_enter`, `llm_call`, `agent_exit` at minimum
6. Verify each event has `sessionId`, `timestamp`, `type`, `data`
7. Verify span hierarchy: `agent_enter` event has `spanId`, child events reference it as `parentSpanId`

**Expected Result:** At least 3 trace events returned. Events have proper W3C-compatible span IDs and parent-child relationships.

**No Mocks:** Real Express server on random port, real middleware chain (auth, rate limiting, tenant isolation).

### E2E-2: WebSocket Real-Time Trace Streaming

**Objective:** Verify trace events stream in real-time via WebSocket to subscribed clients.

**Steps:**

1. Create a session via REST API
2. Connect a WebSocket client to `/ws`
3. Subscribe to session traces (send `{ type: 'subscribe_traces', sessionId }`)
4. Send a user message via a second WebSocket connection
5. Collect trace events received on the subscriber WS
6. Verify `trace_event` messages arrive within 500ms of session activity
7. Verify `trace_replay` message was sent on initial subscribe with any buffered events

**Expected Result:** Subscriber receives live `trace_event` messages. Initial `trace_replay` includes any events that occurred before subscription.

### E2E-3: Historical Trace Retrieval (ClickHouse Fallback)

**Objective:** Verify that traces for completed/expired sessions are retrievable from persistent storage even after the in-memory buffer has been cleared.

**Steps:**

1. Create a session, send messages, close the session
2. Clear the in-memory TraceStore (or wait for TTL expiry in a fast-forwarded test)
3. GET `/api/projects/:projectId/sessions/:id/traces`
4. Verify traces are returned from the ClickHouse fallback
5. Verify trace count matches what was emitted during the session

**Expected Result:** Traces returned even after in-memory eviction, from ClickHouse cold storage.

**Note:** Requires ClickHouse test instance or MongoMemoryServer-style setup for the EventStore.

### E2E-4: Session Metrics Endpoint

**Objective:** Verify the metrics endpoint returns aggregated session metrics (token count, LLM calls, duration, cost).

**Steps:**

1. Create a session and send multiple messages (triggering multiple LLM calls)
2. GET `/api/projects/:projectId/sessions/:id/metrics`
3. Verify response includes: `totalTokensIn`, `totalTokensOut`, `totalLLMCalls`, `totalToolCalls`, `estimatedCost`, `durationMs`
4. Verify token counts are non-zero and consistent with the number of messages sent

**Expected Result:** Metrics endpoint returns accurate aggregated values.

### E2E-5: Session List with Filters

**Objective:** Verify session list endpoint supports filtering by status and returns correct aggregate data per session.

**Steps:**

1. Create 3 sessions: one active (keep WS open), one completed (close it), one with errors
2. GET `/api/projects/:projectId/sessions?status=active` -- verify only active session returned
3. GET `/api/projects/:projectId/sessions?status=completed` -- verify only completed session returned
4. GET `/api/projects/:projectId/sessions` -- verify all 3 returned
5. Verify each session has: `traceEventCount`, `tokenCount`, `errorCount`, `durationMs`

**Expected Result:** Filtering works correctly. Session metadata is accurate.

### E2E-6: Trace Event Type Filtering

**Objective:** Verify that trace retrieval supports filtering by event type.

**Steps:**

1. Create a session with activity that generates multiple event types (llm_call, tool_call, decision, agent_enter, agent_exit)
2. GET `/api/projects/:projectId/sessions/:id/traces?type=llm_call`
3. Verify only llm_call events are returned
4. GET `/api/projects/:projectId/sessions/:id/traces?type=tool_call`
5. Verify only tool_call events are returned

**Expected Result:** Type filter correctly narrows results.

### E2E-7: PII Scrubbing in Trace Data

**Objective:** Verify that PII is scrubbed from trace events when scrubPII is enabled.

**Steps:**

1. Create a session with `scrubPII: true` configuration
2. Send a message containing PII (e.g., "My SSN is 123-45-6789")
3. Retrieve traces via GET `/api/projects/:projectId/sessions/:id/traces`
4. Verify LLM call trace events have redacted content (no raw SSN in data)
5. Verify tool call events have scrubbed inputs/outputs
6. Verify handoff context shows only key names, not values

**Expected Result:** No raw PII present in any trace event data field.

### E2E-8: Span Children Endpoint

**Objective:** Verify the span children endpoint returns child spans of a given parent span.

**Steps:**

1. Create a session with a multi-agent handoff (generates nested spans)
2. GET `/api/projects/:projectId/sessions/:id/traces` to find root span IDs
3. GET `/api/projects/:projectId/sessions/:id/traces/:spanId/children`
4. Verify child spans are returned with correct `parentSpanId` matching the requested `spanId`

**Expected Result:** Child spans correctly linked to parent. Empty array for leaf spans.

---

## 3. Integration Test Scenarios

### INT-1: Memory TraceStore -- Ring Buffer and TTL

**Objective:** Verify the in-memory TraceStore correctly implements ring buffer eviction and time-based cleanup.

**Setup:** Create a TraceStore with `maxEventsPerSession: 5, maxAgeMinutes: 1`.

**Steps:**

1. Add 7 events to a session
2. Verify only the last 5 are retained (ring buffer eviction)
3. Verify the oldest 2 were dropped
4. Add an event with timestamp 2 minutes in the past
5. Call `getEvents()` and verify the old event is filtered out by TTL
6. Verify cleanup job purges inactive sessions after timeout

**Expected Result:** Ring buffer drops oldest events at capacity. TTL-based filtering works on read path.

### INT-2: Memory TraceStore -- WebSocket Subscriber Broadcast

**Objective:** Verify that adding events broadcasts to all subscribed WebSocket clients.

**Setup:** Create a TraceStore and mock WebSocket objects.

**Steps:**

1. Subscribe 2 WS clients to a session
2. Add a trace event
3. Verify both clients received the event via `ws.send()`
4. Verify `trace_replay` was sent to each client on subscribe with buffered events
5. Unsubscribe one client, add another event
6. Verify only the remaining client receives it
7. Simulate a dead socket (readyState !== OPEN), verify it's cleaned up

**Expected Result:** Events broadcast to all live subscribers. Dead sockets cleaned up automatically.

### INT-3: RedisTraceStore -- Cross-Pod Delivery

**Objective:** Verify Redis Streams + Pub/Sub delivers traces across simulated pods.

**Setup:** Two RedisTraceStore instances sharing the same Redis connection.

**Steps:**

1. Instance A subscribes a WS client to a session
2. Instance B adds a trace event for the same session
3. Verify Instance A's WS client receives the event via Pub/Sub
4. Verify anti-duplicate: Instance B's own WS subscribers do NOT receive the event twice (POD_ID check)
5. Verify replay: Instance A's WS client received `trace_replay` from the Redis Stream on subscribe

**Expected Result:** Cross-pod trace delivery works. No duplicates.

### INT-4: RedisTraceStore -- Memory Pressure Circuit Breaker

**Objective:** Verify that stream writes are shed when Redis memory exceeds the configured threshold.

**Setup:** RedisTraceStore with `REDIS_TRACE_MEMORY_THRESHOLD=0.1` (low threshold to trigger easily).

**Steps:**

1. Mock Redis `INFO memory` to return `used_memory:900` / `maxmemory:1000` (90%)
2. Add a trace event
3. Verify the event is NOT written to the Redis Stream (XADD not called)
4. Verify the event IS published via Pub/Sub (real-time delivery still works)
5. Verify shed count is incremented and warning logged

**Expected Result:** Stream writes shed under memory pressure. Pub/Sub delivery continues.

### INT-5: TraceEmitter -- Verbosity Gating

**Objective:** Verify that trace events are gated by the configured verbosity level.

**Setup:** Create TraceEmitter instances at each verbosity level.

**Steps:**

1. At `minimal`: emit error, escalation (should pass), emit tool_call, decision (should be suppressed)
2. At `standard`: emit tool_call, decision, handoff (should pass), emit llm_call (should be suppressed)
3. At `verbose`: emit gather_extraction, correction (should pass)
4. At `debug`: emit llm_call with full prompt (should pass)
5. Verify emitDecision() respects decision-kind-specific gating

**Expected Result:** Each verbosity level correctly gates event types.

### INT-6: TraceEmitter -- EventStore Dual-Write

**Objective:** Verify that trace events are simultaneously written to TraceStore AND EventStore (ClickHouse).

**Setup:** TraceEmitter with both TraceStore and EventStore configured.

**Steps:**

1. Emit an llm_call trace event
2. Verify TraceStore.addEvent() was called with the event
3. Verify EventStore.emitter.emit() was called with a platform event containing:
   - `event_type: 'llm.call.completed'` (from TRACE_TO_PLATFORM_TYPE mapping)
   - `category: 'llm'` (inferred from first segment)
   - `tenant_id`, `project_id`, `session_id` set correctly
4. Emit an llm_call with error data
5. Verify EventStore receives `event_type: 'llm.call.failed'`

**Expected Result:** Dual-write works with correct platform event type mapping.

### INT-7: OtelTraceStore -- Span Bridge

**Objective:** Verify the OTEL trace bridge correctly creates OTEL spans from TraceStore events.

**Setup:** OtelTraceStore with a mock tracer.

**Steps:**

1. Call `startTrace()` -- verify an OTEL span is created with correct attributes (agent.name, agent.version)
2. Call `appendEvent()` with an llm_call -- verify a child span is created under the parent
3. Call `appendEvent()` with an error -- verify child span status is set to ERROR
4. Call `endTrace()` -- verify the root span is ended
5. Verify `cleanupOrphanedSpans()` ends and removes stale spans

**Expected Result:** OTEL spans correctly mirror TraceStore events with proper hierarchy and error status.

### INT-8: TraceForwarder -- Construct-Layer Bridge

**Objective:** Verify the trace forwarder bridges construct-layer events to the runtime TraceStore.

**Setup:** Create a TraceForwarder with a TraceEmitter.

**Steps:**

1. Call `logLLMCall()` on the forwarder
2. Verify the event reaches the TraceEmitter's `emit()` method
3. Verify the event data includes `source: 'construct-layer'`
4. Call `startSpan()` and `end()` on the forwarder
5. Verify a `span_end` event is emitted with duration
6. Test fallback: create a forwarder without TraceEmitter, verify events go directly to TraceStore

**Expected Result:** Construct-layer events flow through the unified pipeline. Fallback to direct TraceStore write works.

### INT-9: Observatory Schema -- TraceTree Building

**Objective:** Verify the TraceTree correctly builds hierarchical trees from flat span arrays.

**Steps:**

1. Create spans with parent-child relationships (root -> agent -> llm_call -> tool_call)
2. Build a TraceTree
3. Verify root nodes are correct
4. Verify children are properly nested
5. Verify `getCriticalPath()` returns the longest duration chain
6. Verify `findSpansByEventType()` filters correctly
7. Verify `toAscii()` produces readable output
8. Test orphaned spans (parentSpanId references non-existent span) -- should become root nodes

**Expected Result:** Tree correctly represents span hierarchy. Orphaned spans handled gracefully.

### INT-10: Observatory Schema -- SpanManager Lifecycle

**Objective:** Verify the SpanManager correctly manages span lifecycle (start, end, stack).

**Steps:**

1. Start a root span for a session
2. Start a child span (verify parent auto-set from active span stack)
3. Start a grandchild span
4. End the grandchild -- verify active span returns to child
5. End the child -- verify active span returns to root
6. End the root
7. Verify all spans have correct duration, status, and parent relationships
8. Call `clearSession()` and verify all spans removed

**Expected Result:** Span stack maintains correct active span hierarchy.

---

## 4. Unit Test Scenarios

### UNIT-1: Trace Event Type Mapping

Verify `TRACE_TO_PLATFORM_TYPE` correctly maps all trace event types to platform event types. Verify `inferCategory()` extracts the first dotted segment.

### UNIT-2: Verbosity Gating Functions

Verify `shouldEmitTrace()` and `shouldEmitDecision()` return correct boolean for all verbosity x event-type combinations.

### UNIT-3: W3C Trace Context ID Generation

Verify `generateSpanId()` produces 16 hex chars. Verify `generateTraceId()` produces 32 hex chars. Verify uniqueness across 1000 generations.

### UNIT-4: TraceEvent Factory

Verify `createTraceEvent()` correctly merges defaults (id, timestamp, spanId) with provided fields.

### UNIT-5: Debug Protocol Parsing

Verify `parseDebugCommand()` correctly parses valid JSON commands and returns null for invalid input. Verify `parseBreakpointSpec()` parses agent, step, event, and condition breakpoint strings.

---

## 5. Coverage Matrix

| Component                                   | E2E   | Integration | Unit           | Status  |
| ------------------------------------------- | ----- | ----------- | -------------- | ------- |
| Trace pipeline (create -> emit -> retrieve) | E2E-1 | --          | --             | PLANNED |
| WebSocket trace streaming                   | E2E-2 | INT-2       | --             | PLANNED |
| ClickHouse fallback                         | E2E-3 | --          | --             | PLANNED |
| Session metrics                             | E2E-4 | --          | --             | PLANNED |
| Session list + filters                      | E2E-5 | --          | --             | PLANNED |
| Event type filtering                        | E2E-6 | --          | --             | PLANNED |
| PII scrubbing                               | E2E-7 | --          | --             | PLANNED |
| Span children                               | E2E-8 | --          | --             | PLANNED |
| Memory TraceStore ring buffer               | --    | INT-1       | --             | PLANNED |
| Memory TraceStore WS broadcast              | --    | INT-2       | --             | PLANNED |
| Redis cross-pod delivery                    | --    | INT-3       | --             | PLANNED |
| Redis memory pressure                       | --    | INT-4       | --             | PLANNED |
| Verbosity gating                            | --    | INT-5       | UNIT-2         | PLANNED |
| EventStore dual-write                       | --    | INT-6       | UNIT-1         | PLANNED |
| OTEL span bridge                            | --    | INT-7       | --             | PLANNED |
| Trace forwarder                             | --    | INT-8       | --             | PLANNED |
| TraceTree hierarchy                         | --    | INT-9       | UNIT-3, UNIT-4 | PLANNED |
| SpanManager lifecycle                       | --    | INT-10      | --             | PLANNED |
| Debug protocol parsing                      | --    | --          | UNIT-5         | PLANNED |

---

## 6. Test Infrastructure Requirements

- **Express server:** Start on random port (`{ port: 0 }`) with full middleware chain
- **WebSocket:** Real WS connections to the test server
- **Redis:** Real Redis instance (or testcontainers) for INT-3, INT-4
- **ClickHouse:** Real or mock ClickHouse for E2E-3, INT-6
- **Auth:** Valid tenant context (JWT or test token) for all API calls
- **Cleanup:** Each test creates and tears down its own sessions

---

## 7. Existing Test Coverage

Known existing tests:

- `apps/runtime/src/__tests__/e2e/observatory-api-e2e.test.ts` -- 28 E2E tests (all pass)
- `apps/studio/src/__tests__/trace-store.test.ts` -- Studio trace store unit tests
- `apps/studio/src/__tests__/session-hooks.test.ts` -- Session hooks tests
- `packages/observatory/src/__tests__/trace-events-attachments.test.ts` -- Attachment trace events
- `apps/studio/src/store/__tests__/observatory-span-lifecycle.test.ts` -- Span lifecycle tests

These tests form the existing baseline. New tests should not duplicate but should extend coverage for gaps identified in the coverage matrix above.
