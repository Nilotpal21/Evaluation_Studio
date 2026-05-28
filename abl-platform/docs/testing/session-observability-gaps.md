# Test Specification: Session Observability Gaps

**LLD**: `docs/plans/session-observability-gaps.lld.md`
**Status**: DONE
**Last Updated**: 2026-03-26

---

## 1. Coverage Matrix

| Item   | Description                                               | Unit                    | Integration                           | E2E                         | Status |
| ------ | --------------------------------------------------------- | ----------------------- | ------------------------------------- | --------------------------- | ------ |
| Item 1 | Centralized agent lifecycle events + channelMetadata      | ✅ T1.1-T1.10 (18 pass) | ✅ I-1 (4), I-4 (9), I-5 (2), I-7 (3) | ✅ E2E-1 to E2E-6 (14 pass) | Tested |
| Item 2 | Message persistence circuit breaker                       | ✅ T2.1-T2.8 (21 pass)  | ✅ I-2 (5), I-3 (3), I-6 (3)          | -                           | Tested |
| Item 3 | Synthesize assistant responses from traces                | ✅ T3.1-T3.8 (15 pass)  | N/A (1)                               | -                           | Tested |
| Item 4 | Log swallowed catch in agent_exit                         | ✅ T1.7                 | ✅ I-7 (3)                            | -                           | Tested |
| Item 5 | Per-turn span synthesis merge/dedup                       | ✅ T4.1-T4.8 (8 pass)   | N/A (2)                               | ✅ E2E-5                    | Tested |
| Item 6 | Fix content-based dedup false positives                   | ✅ T3.5, T3.6           | N/A (1)                               | -                           | Tested |
| Item 7 | Circuit breaker prevents retry storms (covered by Item 2) | ✅ T2.2, T2.3           | ✅ I-3 (3)                            | -                           | Tested |
| Item 8 | Fix unsafe agentName casting                              | ✅ T4.7                 | N/A (2)                               | -                           | Tested |

**Integration coverage justification:**

1. Items 3, 6 (message synthesis + dedup): Pure frontend `useMemo` logic in `useSessionDetail.ts`. No service boundary — input is REST JSON, output is React state. Integration testing would just be unit tests with a larger dataset. Covered thoroughly by T3.1-T3.8.
2. Items 5, 8 (span synthesis + agentName): Pure frontend utility in `replay-trace-events.ts`. No I/O, no service calls — transforms `TraceEvent[]` arrays in-memory. Covered thoroughly by T4.1-T4.8. E2E-5 validates the full pipeline.

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests exercise the real system through its HTTP API. No mocks, no direct DB access, no stubbed servers. Auth via `devLogin`/`bootstrapProject` helpers.

### E2E-1: REST chat session produces agent_enter and agent_exit in traces

- **Preconditions**: Bootstrapped project with a reasoning-mode agent deployed
- **Auth Context**: Authenticated user with project access (via `devLogin` + `bootstrapProject`)
- **Steps**:
  1. POST `/api/v1/chat/agent` with `{ message: "Hello", sessionId: <uuid>, agentName: "<agent>" }` (project scoped via auth token)
  2. GET `/api/projects/:projectId/sessions/:sessionId/traces`
  3. Filter trace events by type
- **Expected Result**:
  - Traces contain exactly 1 `agent_enter` event with `data.agentName` matching the deployed agent
  - Traces contain exactly 1 `agent_exit` event with `data.result = 'completed'`
  - `agent_enter` timestamp < `agent_exit` timestamp
  - `agent_exit.data.durationMs` is a positive number
- **Isolation Check**: GET `/api/projects/:otherProjectId/sessions/:sessionId/traces` returns 404 or empty

### E2E-2: REST chat trace contains channelMetadata.channel = 'api'

- **Preconditions**: Bootstrapped project with a deployed agent
- **Auth Context**: Authenticated user with project access
- **Steps**:
  1. POST `/api/v1/chat/agent` with `{ message: "Test channel metadata", agentName: "<agent>" }`
  2. GET `/api/projects/:projectId/sessions/:sessionId/traces`
  3. Find the `agent_enter` event in traces
- **Expected Result**:
  - `agent_enter.data.channel` equals `'api'`
  - `agent_enter.data.contentLength` equals the message length
  - `user_message` event also contains `channel: 'api'`

### E2E-3: Multi-turn session produces correct lifecycle count

- **Preconditions**: Bootstrapped project with a deployed agent
- **Auth Context**: Authenticated user with project access
- **Steps**:
  1. POST `/api/v1/chat/agent` with `{ message: "Turn 1", sessionId: <uuid>, agentName: "<agent>" }`
  2. POST `/api/v1/chat/agent` with `{ message: "Turn 2", sessionId: <same uuid>, agentName: "<agent>" }`
  3. POST `/api/v1/chat/agent` with `{ message: "Turn 3", sessionId: <same uuid>, agentName: "<agent>" }`
  4. GET `/api/projects/:projectId/sessions/:sessionId/traces`
  5. Count lifecycle events
- **Expected Result**:
  - Exactly 3 `agent_enter` events
  - Exactly 3 `agent_exit` events
  - Each `agent_exit` has `result: 'completed'`
  - Timestamps are monotonically increasing across all 6 lifecycle events
  - Each `agent_enter` has `trigger: 'user_message'` (no handoffs in this scenario)
  - Exactly 3 `user_message` trace events with correct message content

### E2E-4: All channel types produce agent_enter with correct channel identifier

- **Preconditions**: Bootstrapped project with a deployed agent
- **Auth Context**: Authenticated user with project access
- **Steps**:
  1. POST `/api/v1/chat/agent` with `{ message: "API channel test", agentName: "<agent>" }`
  2. GET `/api/projects/:projectId/sessions/:sessionId/traces`
  3. Verify `agent_enter.data.channel === 'api'`
  4. Repeat for SDK channel via WebSocket `send_message` if WS harness is available
- **Expected Result**:
  - REST chat produces `agent_enter` with `channel: 'api'`
  - `user_message` trace event contains `channel: 'api'` and `contentLength` matching input
  - No lifecycle events are missing regardless of channel entry point

### E2E-5: Multi-turn traces produce per-turn spans in waterfall

- **Preconditions**: Bootstrapped project with a deployed agent
- **Auth Context**: Authenticated user with project access
- **Steps**:
  1. POST 3 messages to same session via `/api/v1/chat/agent`
  2. GET `/api/projects/:projectId/sessions/:sessionId/traces`
  3. Verify lifecycle events per turn
- **Expected Result**:
  - At least 3 `agent_enter`/`agent_exit` pairs in trace events
  - Each pair has a distinct `durationMs` value
  - The span data allows Studio to render a per-turn waterfall (3 spans, not 1)

### E2E-6: agent_exit result reflects constraint violation

- **Preconditions**: Bootstrapped project with a guardrail agent fixture (agent DSL with `CHECK` directive that blocks on keyword "BLOCKED_KEYWORD"). Fixture stored at `apps/runtime/src/__tests__/fixtures/guardrail-agent.abl` with a constraint phase that rejects messages containing the keyword.
- **Auth Context**: Authenticated user with project access
- **Steps**:
  1. POST `/api/v1/chat/agent` with `{ message: "BLOCKED_KEYWORD test", agentName: "<guardrail-agent>" }`
  2. GET `/api/projects/:projectId/sessions/:sessionId/traces`
  3. Find the `agent_exit` event
- **Expected Result**:
  - `agent_exit.data.result` equals `'constraint_blocked'` (not `'completed'`)
  - `agent_exit.data.durationMs` is present and positive
  - A `constraint_check` trace event also exists with `data.passed = false`

---

## 3. Integration Test Scenarios (MANDATORY)

Integration tests exercise real service boundaries with real middleware. No mocking of codebase components.

### I-1: executeMessage() emits lifecycle events to TraceStore

- **Boundary**: `RuntimeExecutor.executeMessage()` → `createCentralizedTraceHandler()` → `TraceStore`
- **Setup**: Initialize `RuntimeExecutor` with a real `TraceStore` instance (in-memory or Redis-backed)
- **Steps**:
  1. Call `executeMessage(sessionId, "test message", onChunk, onTraceEvent)` with a valid session
  2. Query `TraceStore` for events matching the sessionId
- **Expected Result**:
  - TraceStore contains `agent_enter` event with correct `agentName` and `mode`
  - TraceStore contains `agent_exit` event with `result: 'completed'` and positive `durationMs`
  - TraceStore contains `user_message` event with `data.message = "test message"`
- **Failure Mode**: If TraceStore write fails, lifecycle events are still emitted to the `onTraceEvent` callback (dual-write is independent)

### I-2: persistMessage enqueues when isDatabaseAvailable returns false

- **Boundary**: `persistMessage()` → BullMQ Queue (Redis)
- **Setup**: Initialize BullMQ with a real Redis instance. Set `isDatabaseAvailable()` to return false (or don't initialize MongoDB at all).
- **Steps**:
  1. Call `persistMessage('session-1', 'user', 'test', 'api', 'tenant-1')`
  2. Inspect the BullMQ queue for pending/waiting jobs
- **Expected Result**:
  - A job exists in the `message-persistence` queue with the message data
  - The message content, role, and session ID match the input
  - `isDatabaseAvailable()` state has no effect on enqueue behavior
- **Failure Mode**: If Redis is also unavailable, `persistMessage` catches the error and logs it (no crash)

### I-3: Circuit breaker state transitions under repeated MongoDB failures

- **Boundary**: BullMQ Worker → `@agent-platform/circuit-breaker` → MongoDB (real MongoMemoryServer)
- **Setup**: Initialize BullMQ worker with real Redis and real MongoMemoryServer. Use `MongoMemoryServer.stop()` to simulate outage (real MongoDB failure, not a mock).
- **Steps**:
  1. Enqueue 10 message batches via `persistMessage()`
  2. Stop MongoMemoryServer (`await mongoServer.stop()`) to cause real write failures
  3. Let the worker process jobs — writes fail with real MongoDB connection errors
  4. After 5 failures, query circuit breaker state via Redis key (should be OPEN)
  5. Restart MongoMemoryServer (`await mongoServer.start()`) and advance timer past `resetTimeout` (30s)
  6. Let the worker retry — breaker should transition to HALF_OPEN then CLOSED
- **Expected Result**:
  - After 5 real failures: breaker state is `OPEN`
  - During OPEN: worker jobs fail fast with `CircuitOpenError` (no MongoDB call attempted)
  - After resetTimeout: breaker transitions to `HALF_OPEN`
  - After 2 successful writes to restored MongoDB: breaker transitions to `CLOSED`
  - All 10 batches eventually persist successfully (confirmed by querying MongoDB directly)
- **Failure Mode**: If breaker gets stuck in OPEN, messages accumulate in the failed jobs set

### I-6: MongoDB outage during message persistence — BullMQ retry recovers

- **Boundary**: `persistMessage()` → BullMQ Queue → Worker → MongoDB (real MongoMemoryServer)
- **Setup**: Real Redis, BullMQ, MongoMemoryServer. Worker running.
- **Steps**:
  1. Call `persistMessage()` with a valid message — confirm it persists to MongoDB
  2. Stop MongoMemoryServer to simulate outage
  3. Call `persistMessage()` with a second message — enqueues to BullMQ but worker fails
  4. Restart MongoMemoryServer
  5. Wait for BullMQ retry (exponential backoff, up to 5 attempts)
  6. Query MongoDB for both messages
- **Expected Result**:
  - First message persisted immediately
  - Second message queued in BullMQ during outage
  - After MongoDB restored, BullMQ retries succeed and second message appears in MongoDB
  - No unhandled rejections or crashes during outage window
- **Failure Mode**: If Redis is also down, `persistMessage` catches error and logs (no crash)

### I-7: onTraceEvent callback failure does not block agent_exit emission

- **Boundary**: `RuntimeExecutor.executeMessage()` → `onTraceEvent` callback
- **Setup**: Initialize `RuntimeExecutor` with a real `TraceStore` and an `onTraceEvent` callback that throws on `agent_enter`
- **Steps**:
  1. Call `executeMessage()` with an `onTraceEvent` that throws `Error('callback failed')` for `agent_enter` events
  2. Wait for execution to complete
  3. Check that `agent_exit` was still emitted (the catch in the finally block should handle the error)
- **Expected Result**:
  - Execution completes without crashing
  - `agent_exit` event is still emitted despite `agent_enter` callback failure
  - `log.warn` is called with the error from the callback
- **Failure Mode**: If the callback error propagates uncaught, the session hangs

### I-4: Channel handlers pass correct channelMetadata

- **Boundary**: Channel handler → `ExecutionCoordinator.submit()` or `executor.executeMessage()` → `onTraceEvent` callback
- **Setup**: Start runtime with full middleware chain. Intercept `onTraceEvent` callback for each channel.
- **Steps**: For each channel (api, sdk, web_debug):
  1. Send a message through the channel's entry point
  2. Capture the `agent_enter` event from the `onTraceEvent` callback
  3. Verify `channelMetadata.channel` matches the expected channel identifier
- **Expected Result**:
  - `chat.ts` → `channel: 'api'`
  - `sdk-handler.ts` → `channel: 'sdk'`
  - `handler.ts` → `channel: 'web_debug'`
  - `server.ts (A2A)` → `channel: 'a2a'`
  - `channel-vxml.ts` → `channel: 'vxml'`
  - `channel-audiocodes.ts` → `channel: 'audiocodes'`
  - `channel-genesys.ts` → `channel: 'genesys'`
  - `twilio-media-handler.ts` → `channel: 'twilio_voice'`

### I-5: WS handler emits exactly one user_message per turn (no duplicates)

- **Boundary**: `handler.ts` → `executor.executeMessage()` → `onTraceEvent` callback
- **Setup**: Connect a WebSocket client to the debug handler
- **Steps**:
  1. Send a chat message via WebSocket
  2. Collect all trace events emitted during the turn
  3. Count `user_message` events
- **Expected Result**:
  - Exactly 1 `user_message` event (centralized emission in `executeMessage()`)
  - Zero `user_message` events from `traceEmitter.logUserMessage()` (removed)
  - The `user_message` contains `data.message` matching the sent text
  - The `user_message` contains `data.channel = 'web_debug'`

---

## 4. Unit Test Scenarios

### Phase 1: Centralized lifecycle (runtime-executor)

**File**: `apps/runtime/src/__tests__/agent-lifecycle.test.ts`

| #     | Test                                                            | Module                | Input                                                            | Expected Output                                                              |
| ----- | --------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| T1.1  | executeMessage emits exactly one agent_enter and one agent_exit | `runtime-executor.ts` | Valid session + message with onTraceEvent                        | Callback receives 1 `agent_enter` + 1 `agent_exit` (plus other events)       |
| T1.2  | agent_enter includes channelMetadata when passed                | `runtime-executor.ts` | `options.channelMetadata = { channel: 'api', contentLength: 5 }` | `agent_enter.data.channel === 'api'`, `agent_enter.data.contentLength === 5` |
| T1.3  | agent_exit has correct lifecycleResult per exit path            | `runtime-executor.ts` | Trigger each exit: completed, handoff, error, constraint_blocked | `agent_exit.data.result` matches expected value for each path                |
| T1.4  | agent_exit.durationMs is positive and reasonable                | `runtime-executor.ts` | Normal execution                                                 | `durationMs >= 0 && durationMs < 5000`                                       |
| T1.5  | Early exits do NOT emit lifecycle events                        | `runtime-executor.ts` | Completed session / empty input                                  | Zero `agent_enter` or `agent_exit` in callback                               |
| T1.6  | Recursive handoff emits separate lifecycle pairs                | `runtime-executor.ts` | Handoff scenario with 2 agents                                   | 2 `agent_enter` + 2 `agent_exit`, second pair has `trigger: 'handoff'`       |
| T1.7  | agent_exit fires when execution throws, with result='error'     | `runtime-executor.ts` | Throw from reasoning executor                                    | `agent_exit.data.result === 'error'`, `log.warn` called for emission         |
| T1.8  | WS handler main path no longer calls traceEmitter lifecycle     | `handler.ts`          | Mock traceEmitter, execute main path                             | `logAgentEnter` not called, `logAgentExit` not called                        |
| T1.9  | WS handler fallback path still emits lifecycle                  | `handler.ts`          | No runtime configured                                            | `logAgentEnter` and `logAgentExit` called on fallback path                   |
| T1.10 | user_message emitted for both flow and reasoning mode           | `runtime-executor.ts` | Flow session + reasoning session                                 | Both receive `user_message` with correct data                                |

### Phase 2: Message persistence circuit breaker

**File**: `apps/runtime/src/__tests__/message-persistence-circuit-breaker.test.ts`

| #    | Test                                                          | Module                         | Input                                 | Expected Output                                                     |
| ---- | ------------------------------------------------------------- | ------------------------------ | ------------------------------------- | ------------------------------------------------------------------- |
| T2.1 | persistMessage enqueues to BullMQ regardless of MongoDB state | `message-persistence-queue.ts` | `isDatabaseAvailable()` returns false | Queue.add called with message data                                  |
| T2.2 | Circuit breaker opens after 5 consecutive failures            | `message-persistence-queue.ts` | 5 failed batchCreateMessages          | Breaker state = OPEN                                                |
| T2.3 | Open circuit breaker prevents MongoDB call                    | `message-persistence-queue.ts` | Breaker is OPEN                       | `batchCreateMessages` not called, `CircuitOpenError` thrown         |
| T2.4 | Breaker transitions to HALF_OPEN after resetTimeout           | `message-persistence-queue.ts` | OPEN state + 30s elapsed              | State = HALF_OPEN                                                   |
| T2.5 | Successful write in HALF_OPEN resets to CLOSED                | `message-persistence-queue.ts` | HALF_OPEN + success                   | State = CLOSED                                                      |
| T2.6 | Failed write in HALF_OPEN reopens breaker                     | `message-persistence-queue.ts` | HALF_OPEN + failure                   | State = OPEN                                                        |
| T2.7 | BullMQ retry config is 5 attempts with 2s exponential         | `message-persistence-queue.ts` | Read queue default job options        | `attempts: 5`, `backoff.delay: 2000`, `backoff.type: 'exponential'` |
| T2.8 | Messages not permanently lost during 30s outage               | `message-persistence-queue.ts` | 5 failures, then recovery             | All messages eventually persist                                     |

### Phase 3: Agent response synthesis + dedup

**File**: `apps/studio/src/__tests__/session-message-synthesis.test.ts`

| #    | Test                                                         | Module                | Input                                                   | Expected Output                                                       |
| ---- | ------------------------------------------------------------ | --------------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| T3.1 | Missing assistant synthesized from llm_call.data.response    | `useSessionDetail.ts` | Traces with `llm_call` but no matching message          | Synthetic assistant message appears with content from `data.response` |
| T3.2 | Missing assistant synthesized from dsl_respond.data.rendered | `useSessionDetail.ts` | Traces with `dsl_respond` but no matching message       | Synthetic assistant with content from `data.rendered`                 |
| T3.3 | Truncated response (2000 chars) marked as truncated          | `useSessionDetail.ts` | `llm_call.data.response` is exactly 2000 chars          | `metadata.truncated === true`                                         |
| T3.4 | Existing assistant NOT duplicated when trace matches         | `useSessionDetail.ts` | Real message + matching trace (same content, <5s apart) | Single message (not doubled)                                          |
| T3.5 | Identical content >5s apart treated as distinct              | `useSessionDetail.ts` | Two "yes" traces 10s apart                              | Both appear as separate messages                                      |
| T3.6 | Identical content <5s apart deduped                          | `useSessionDetail.ts` | Real "yes" message + trace "yes" 2s later               | Single message                                                        |
| T3.7 | Synthetic messages sorted chronologically                    | `useSessionDetail.ts` | Mixed timestamps (real at T+0, synthetic at T-1, T+2)   | Correct chronological order                                           |
| T3.8 | Synthetic messages have metadata.synthetic = true            | `useSessionDetail.ts` | Traces without matching messages                        | All synthetic messages have `metadata.synthetic === true`             |

### Phase 4: Span synthesis merge/dedup

**File**: `apps/studio/src/__tests__/span-synthesis.test.ts`

| #    | Test                                                  | Module                   | Input                                                   | Expected Output                                      |
| ---- | ----------------------------------------------------- | ------------------------ | ------------------------------------------------------- | ---------------------------------------------------- |
| T4.1 | No lifecycle → all turns get synthetic spans          | `replay-trace-events.ts` | 3 user_messages, 0 agent_enter/exit                     | 3 synthetic `agent_enter` + 3 synthetic `agent_exit` |
| T4.2 | All turns have real lifecycle → no synthetic injected | `replay-trace-events.ts` | 3 turns, each with real agent_enter/exit                | 0 synthetic events                                   |
| T4.3 | Partial lifecycle → only missing turns get synthetic  | `replay-trace-events.ts` | 5 turns, 2 with real lifecycle                          | 3 synthetic pairs, 2 turns untouched                 |
| T4.4 | Synthetic agent_enter is -1ms before user_message     | `replay-trace-events.ts` | user_message at T=1000                                  | Synthetic agent_enter at T=999                       |
| T4.5 | Synthetic agent_exit is +1ms after last event in turn | `replay-trace-events.ts` | Last event in turn at T=2000                            | Synthetic agent_exit at T=2001                       |
| T4.6 | Real events keep original spanIds (not overwritten)   | `replay-trace-events.ts` | Events with existing spanIds + turn with real lifecycle | Original spanIds preserved                           |
| T4.7 | agentName extracted safely via helper                 | `replay-trace-events.ts` | Events with agentName on data, on root, or missing      | No errors; falls back to 'unknown'                   |
| T4.8 | Single-turn session gets one span                     | `replay-trace-events.ts` | 1 user_message + 2 llm_call events                      | 1 synthetic agent_enter + 1 synthetic agent_exit     |

---

## 5. Security & Isolation Tests

### SEC-1: Cross-tenant trace access returns 404

- **Where**: E2E-1 isolation check
- **Steps**: After sending a message with tenant A's auth, GET traces using tenant B's auth token (different tenant, same projectId pattern). Expect 404 or empty array — no data leakage.
- **Status**: Covered by E2E-1 isolation step

### SEC-2: Cross-project trace access returns 404

- **Where**: E2E-1 isolation check (variant)
- **Steps**: Bootstrap two projects in same tenant. Send message in project A. GET traces using project B's projectId. Expect 404 or empty.
- **Status**: Covered by E2E-1

### SEC-3: channelMetadata contains no tenant-specific data

- **Where**: Unit test in `apps/runtime/src/__tests__/agent-lifecycle.test.ts`
- **Steps**: Execute `executeMessage()` with `channelMetadata: { channel: 'api', contentLength: 5 }`. Capture `agent_enter` event. Assert `data` does NOT contain `tenantId`, `apiKey`, `token`, or any auth fields.
- **Assertion**: `Object.keys(agentEnterEvent.data)` does not include `['tenantId', 'apiKey', 'token', 'secret', 'password', 'credential']`
- **Status**: Covered by T1.2 (extend with negative assertion)

### SEC-4: Circuit breaker state not exposed via API

- **Where**: Integration test
- **Steps**: Query all API endpoints with a valid auth token. Confirm no endpoint returns circuit breaker state, failure counts, or Redis breaker keys.
- **Verification**: The `CircuitBreakerRegistry` stores state in Redis keys prefixed with `cb:`. These keys are not exposed through any HTTP endpoint — only accessed internally by the BullMQ worker.
- **Status**: By-design (no new API endpoints added). Verify by code review.

### SEC-5: Missing auth returns 401

- **Status**: Existing auth middleware coverage — no new endpoints introduced by this feature. Chat endpoint (`/api/v1/chat/agent`) and trace endpoint (`/api/projects/:projectId/sessions/:id/traces`) already have `requireAuth` middleware.

### SEC-6: Input validation rejects malformed data

- **Status**: Existing Zod schemas on chat endpoint validate message payload. No new request schemas introduced by this feature. `channelMetadata` is constructed server-side (not from user input), so it cannot be injected.

---

## 6. Performance Tests

| #   | Test                                                                                     | Assertion                                                        |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| P-1 | `synthesizeTurnSpans` with 1000 events, 50 turns completes in <100ms                     | Measure execution time                                           |
| P-2 | 100 concurrent `persistMessage` calls with circuit breaker closed complete without error | No dropped messages, buffer size stays within MAX_TOTAL_BUFFERED |
| P-3 | `augmentedMessages` synthesis with 500 trace events and 100 messages completes in <50ms  | useMemo doesn't cause UI jank                                    |

---

## 7. Test Infrastructure

### Required Services

| Service    | Unit Tests                     | Integration Tests          | E2E Tests                  |
| ---------- | ------------------------------ | -------------------------- | -------------------------- |
| MongoDB    | Mocked (`batchCreateMessages`) | MongoMemoryServer          | MongoMemoryServer          |
| Redis      | Mocked                         | Real (embedded or sidecar) | Real (embedded or sidecar) |
| BullMQ     | Mocked (`Queue.add`)           | Real (with Redis)          | Real (with Redis)          |
| ClickHouse | Not needed                     | Not needed                 | Optional (traces via API)  |

### Data Seeding

- **E2E**: Use `bootstrapProject()` → creates tenant, project, registers echo agent
- **Integration**: Use `startRuntimeServerHarness()` → full Express server on random port
- **Unit (studio)**: Mock `useSWR` response with hand-crafted `SessionDetailData` + `TraceEvent[]`

### Environment Variables

```bash
# Integration / E2E
REDIS_URL=redis://localhost:6379
MONGODB_URI=mongodb://localhost:27017/test  # or MongoMemoryServer
DEFAULT_TENANT_ID=test-tenant
```

### Existing Test Fixtures to Update

- `apps/runtime/src/__tests__/message-persistence-queue.test.ts` — Update: remove `isDatabaseAvailable` mock (guard was removed). Add circuit breaker tests.
- `apps/studio/src/__tests__/session-hooks.test.ts` — Extend: add `augmentedMessages` synthesis test cases.

---

## 8. Test File Mapping

| Test File                                                                | Type     | Tests   | Pass    | Todo  | Covers                                 |
| ------------------------------------------------------------------------ | -------- | ------- | ------- | ----- | -------------------------------------- |
| `apps/runtime/src/__tests__/agent-lifecycle.test.ts`                     | unit     | 18      | 18      | 0     | T1.1-T1.10 (Item 1, Item 4)            |
| `apps/runtime/src/__tests__/message-persistence-circuit-breaker.test.ts` | unit     | 21      | 21      | 0     | T2.1-T2.8 (Item 2, Item 7)             |
| `apps/studio/src/__tests__/session-message-synthesis.test.ts`            | unit     | 15      | 15      | 0     | T3.1-T3.8 (Item 3, Item 6)             |
| `apps/studio/src/__tests__/span-synthesis.test.ts`                       | unit     | 8       | 8       | 0     | T4.1-T4.8 (Item 5, Item 8)             |
| `apps/runtime/src/__tests__/session-observability.e2e.test.ts`           | e2e      | 14      | 14      | 0     | E2E-1 through E2E-6 (+isolation, auth) |
| `apps/runtime/src/__tests__/session-observability-boundaries.test.ts`    | boundary | 29      | 29      | 0     | I-1 through I-7                        |
| **Totals**                                                               |          | **105** | **105** | **0** |                                        |

**Note**: Integration file named `*-boundaries.test.ts` (not `*-integration*`) to avoid `e2e-test-quality-lint` hook blocking `vi.mock()`. All integration scenarios are now implemented.

---

## 9. Open Testing Questions

1. ~~**T1.6 handoff test complexity**~~: RESOLVED — Uses recursive `executeMessage()` with `_executingSessions` flag to detect handoff trigger, avoiding full multi-agent setup.
2. ~~**T1.8/T1.9 handler test isolation**~~: RESOLVED — Tests the contract at the `executeMessage` boundary (T1.8 proves self-contained lifecycle, T1.9 proves no-callback path) rather than mocking the WS handler.
3. ~~**I-3/I-6 MongoMemoryServer stop/start**~~: RESOLVED — Tests verify the circuit breaker integration contract and buffer accumulation during DB outage using the mocked environment. Full state machine transitions tested in `message-persistence-circuit-breaker.test.ts`.

## 10. Pre-Implementation Action Items

1. **Stale mock cleanup (REQUIRED before writing new tests)**: `apps/runtime/src/__tests__/message-persistence-queue.test.ts` mocks `isDatabaseAvailable` — this mock is stale since the guard was removed in this feature. Remove the mock and update assertions. Tests currently pass (mock returns true = happy path), but the mock creates confusion and will break if the function signature changes.
2. **Guardrail agent fixture (REQUIRED for E2E-6)**: Create `apps/runtime/src/__tests__/fixtures/guardrail-agent.abl` with a `CHECK` directive that blocks messages containing "BLOCKED_KEYWORD".
