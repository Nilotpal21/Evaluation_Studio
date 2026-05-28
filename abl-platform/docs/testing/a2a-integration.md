# Test Spec: A2A Integration (Agent-to-Agent Protocol)

**Feature**: A2A protocol integration -- inbound JSON-RPC, SSE streaming, multi-turn sessions, async execution, cross-tenant isolation
**Owner**: Platform team
**Related Feature Doc**: [docs/features/a2a-integration.md](../features/a2a-integration.md)
**Last Updated**: 2026-04-14
**Overall Status**: BETA (35 E2E tests passing, 3 major gaps open; per-message metadata parity unit-tested)

---

## Coverage Matrix

| FR    | Description                                       | Unit | Integration | E2E     | Manual | Status                                 |
| ----- | ------------------------------------------------- | ---- | ----------- | ------- | ------ | -------------------------------------- |
| FR-1  | Inbound A2A endpoints per connection              | Yes  | Yes         | Yes     | --     | PASS (agent card, JSON-RPC, SSE)       |
| FR-2  | Auto-generated agent cards with overrides         | Yes  | Yes         | Yes     | --     | PASS (5 E2E tests)                     |
| FR-3  | Outbound sync/streaming/async/poll/cancel         | Yes  | Partial     | Partial | --     | PASS (sync), NOT TESTED (cancel E2E)   |
| FR-4  | Multi-turn session continuity via contextId       | Yes  | Yes         | Yes     | --     | PASS (3+ E2E tests)                    |
| FR-5  | Per-connection inbound Bearer auth                | Yes  | Yes         | Yes     | --     | PASS (5 E2E tests)                     |
| FR-6  | Outbound SSRF endpoint validation                 | Yes  | --          | --      | --     | PASS (unit only)                       |
| FR-7  | Structured tracing for inbound/outbound/callback  | Yes  | --          | --      | --     | PASS (unit only)                       |
| FR-8  | Task state transitions (submitted->completed)     | Yes  | Yes         | Yes     | --     | PASS (adapter tests + E2E)             |
| FR-9  | Push notification callbacks with atomic claim     | Yes  | --          | --      | --     | PASS (unit), NOT TESTED (E2E)          |
| FR-10 | Content extraction (TextPart, DataPart, FilePart) | Yes  | --          | Yes     | --     | PASS (DataPart), NOT TESTED (FilePart) |
| FR-11 | Per-message metadata parity (A2A/REST/WS)         | Yes  | --          | --      | --     | PASS (unit: adapter + chat-routes)     |

---

## E2E Test Scenarios (MANDATORY -- minimum 5)

### E2E-1: Full Agent Card Discovery and JSON-RPC Message Lifecycle

**Preconditions**: Two A2A channel connections created for different projects/agents. Runtime running with real LLM credentials.

**Steps**:

1. `GET /a2a/:connectionIdA/.well-known/agent-card.json` -- retrieve agent card for connection A
2. Assert card has `name`, `url`, `capabilities.streaming`, `capabilities.pushNotifications`
3. `GET /a2a/:connectionIdB/.well-known/agent-card.json` -- retrieve agent card for connection B
4. Assert card B has different `name` from card A (connection-scoped identity)
5. `POST /a2a/:connectionIdA` with JSON-RPC `message/send` -- send "Hello, what can you do?"
6. Assert response contains `result` with `kind: 'message'`, `role: 'agent'`, and non-empty text parts
7. `POST /a2a/:connectionIdA` with JSON-RPC `tasks/get` and `taskId` from step 6, `historyLength: 10`
8. Assert task has `status.state: 'completed'` and `history` array with user+agent messages

**Expected Result**: Agent cards are connection-scoped; message lifecycle produces a valid response; task history is retrievable.

**Auth Context**: `tenantId: tenant-dev-001`, `projectId: proj-travel` (connection A), `projectId: proj-airlines` (connection B)

**Isolation Check**: `GET /a2a/nonexistent-connection-id/.well-known/agent-card.json` returns 404.

---

### E2E-2: Multi-Turn Session Continuity Across Sync and Streaming Modes

**Preconditions**: One A2A connection with LLM-backed agent.

**Steps**:

1. `POST /a2a/:connectionId` JSON-RPC `message/send` -- "I'm planning a trip to Tokyo" with `contextId: ctx-multi-1`
2. Assert response mentions Tokyo or travel planning
3. `POST /a2a/:connectionId` JSON-RPC `message/send` -- "What's the weather like there?" with same `contextId: ctx-multi-1`
4. Assert response references Tokyo (proving session continuity)
5. `GET /a2a/:connectionId/sse` with streaming `message/send` -- "Also recommend hotels" with same `contextId: ctx-multi-1`
6. Assert SSE events: `status-update(working)` -> N `artifact-update` -> `message`
7. Assert accumulated text references prior context (Tokyo, weather, hotels)
8. `POST /a2a/:connectionId` JSON-RPC `message/send` -- "Summarize the plan" with same `contextId: ctx-multi-1`
9. Assert summary references all previous turns
10. `POST /a2a/:connectionId` JSON-RPC `message/send` -- "Hello" with DIFFERENT `contextId: ctx-multi-2`
11. Assert response does NOT reference Tokyo (independent session)

**Expected Result**: Same contextId preserves conversation across sync and streaming turns; different contextId starts fresh.

**Auth Context**: `tenantId: tenant-dev-001`, `projectId: proj-travel`

**Isolation Check**: Different contextId on same connection yields independent session.

---

### E2E-3: Inbound Bearer Authentication and Key Lifecycle

**Preconditions**: One A2A connection with no initial API key.

**Steps**:

1. `POST /a2a/:connectionId` JSON-RPC `message/send` -- verify unauthenticated access works (200)
2. `PATCH /api/projects/:projectId/channel-connections/:connectionId` -- set `a2aApiKey: "secret-key-abc"`
3. `POST /a2a/:connectionId` JSON-RPC `message/send` WITHOUT Authorization header -- assert 401
4. `POST /a2a/:connectionId` JSON-RPC `message/send` with `Authorization: Bearer wrong-key` -- assert 401
5. `GET /a2a/:connectionId/.well-known/agent-card.json` WITHOUT Authorization -- assert 401
6. `POST /a2a/:connectionId` JSON-RPC `message/send` with `Authorization: Bearer secret-key-abc` -- assert 200
7. `PATCH /api/projects/:projectId/channel-connections/:connectionId` -- remove API key
8. `POST /a2a/:connectionId` JSON-RPC `message/send` WITHOUT Authorization header -- assert 200 (access restored)

**Expected Result**: API key enforcement is per-connection, immediate, and reversible.

**Auth Context**: `tenantId: tenant-dev-001`, `projectId: proj-travel`, project-level admin permissions for PATCH

**Isolation Check**: API key on connection A does not affect connection B.

---

### E2E-4: Rich Content Handling (DataPart, Mixed Parts, Streaming)

**Preconditions**: One A2A connection with LLM-backed agent.

**Steps**:

1. `POST /a2a/:connectionId` JSON-RPC `message/send` with message containing a DataPart: `{ kind: 'data', data: { departure: 'SFO', arrival: 'NRT', class: 'business' } }`
2. Assert agent response references the structured data (SFO, NRT, business class)
3. `POST /a2a/:connectionId` JSON-RPC `message/send` with mixed parts: TextPart "Book this flight" + DataPart `{ passengers: 2, date: '2026-04-15' }`
4. Assert agent processes both text and structured data
5. `GET /a2a/:connectionId/sse` with streaming `message/send` containing DataPart
6. Assert SSE event sequence is correct: working -> artifact-update(s) -> message
7. `POST /a2a/:connectionId` JSON-RPC `tasks/get` with `historyLength: 10` -- verify DataPart preserved in task history

**Expected Result**: DataPart and mixed parts are extracted, serialized as JSON, and passed to LLM. History preserves structured content.

**Auth Context**: `tenantId: tenant-dev-001`, `projectId: proj-travel`

**Isolation Check**: N/A (content handling, not isolation)

---

### E2E-5: Concurrent Request Handling and Session Atomicity

**Preconditions**: One A2A connection with LLM-backed agent.

**Steps**:

1. Fire 3 concurrent `POST /a2a/:connectionId` JSON-RPC `message/send` with SAME `contextId: ctx-race-1` and messages about different cities
2. Assert all 3 requests complete successfully (no 500s)
3. Assert all 3 responses reference the same session (confirmed via `tasks/get` showing shared history or runtime logs showing "Session race resolved")
4. Fire 2 concurrent `POST /a2a/:connectionId` JSON-RPC `message/send` with DIFFERENT contextIds
5. Assert both complete independently with different session context

**Expected Result**: Concurrent first-turn requests with same contextId converge to a single session via atomic session resolver. Different contextIds run independently.

**Auth Context**: `tenantId: tenant-dev-001`, `projectId: proj-travel`

**Isolation Check**: Session atomicity prevents forking into separate sessions.

---

### E2E-6: Cross-Tenant Data Isolation

**Preconditions**: Two tenants (tenant-A, tenant-B) each with their own project and A2A connection. Separate LLM credentials.

**Steps**:

1. Create A2A connection under tenant-A, project-A -- get connectionId-A
2. Create A2A connection under tenant-B, project-B -- get connectionId-B
3. `POST /a2a/:connectionIdA` `message/send` with contextId "shared-ctx" -- "My name is Alice"
4. Assert response
5. `POST /a2a/:connectionIdB` `message/send` with contextId "shared-ctx" -- "What is my name?"
6. Assert tenant-B response does NOT reference "Alice" (separate session due to tenant isolation in session resolver key)
7. `GET /a2a/:connectionIdA/.well-known/agent-card.json` from tenant-B auth context -- assert 404 (not 403)
8. `POST /a2a/:connectionIdA` `tasks/get` with task from tenant-B -- assert error or 404

**Expected Result**: Same contextId on different tenants maps to different sessions. Cross-tenant access returns 404.

**Auth Context**: Separate tenant credentials for tenant-A and tenant-B

**Isolation Check**: Cross-tenant returns 404 (not 403) to avoid leaking existence.

---

### E2E-7: Error Handling and Protocol Compliance

**Preconditions**: One active A2A connection, one that does not exist.

**Steps**:

1. `POST /a2a/:connectionId` with malformed JSON body -- assert error response with negative code
2. `POST /a2a/:connectionId` with JSON-RPC unknown method "tasks/unknown" -- assert error code -32601
3. `POST /a2a/:connectionId` with missing required params -- assert error
4. `POST /a2a/:connectionId` `tasks/get` with non-existent taskId -- assert "task not found" error
5. `POST /a2a/:connectionId` `message/send` with empty message text -- assert graceful handling (no 500)
6. `GET /a2a/../etc/passwd/.well-known/agent-card.json` -- assert 400 (path traversal rejected)
7. `POST /a2a/nonexistent-id` `message/send` -- assert 404

**Expected Result**: Protocol-compliant error responses for all invalid inputs. No 500 errors.

**Auth Context**: `tenantId: tenant-dev-001`

**Isolation Check**: Non-existent connectionId returns 404.

---

## Integration Test Scenarios (MANDATORY -- minimum 5)

### INT-1: AgentExecutorAdapter State Transitions

**Boundary**: `AgentExecutorAdapter` <-> `AgentExecutionPort` + `A2ATracingPort`

**Setup**: Mock execution port and tracing port. Real `AgentExecutorAdapter` with `RequestContext` and `ExecutionEventBus`.

**Steps**:

1. Execute a message that returns a normal response
2. Assert event sequence: `status-update(working)` -> `message` -> `status-update(completed, final=true)`
3. Assert tracing.traceInbound called with status 'success'
4. Execute a message where execution port throws an error
5. Assert event sequence: `status-update(working)` -> `status-update(failed, final=true)`
6. Assert tracing.traceInbound called with status 'error'
7. Execute a message that returns `action: { type: 'suspend', reason: { type: 'human_approval' } }`
8. Assert event: `status-update(input-required, final=true)` emitted
9. Execute a message that returns `action: { type: 'suspend', reason: { type: 'async_tool' } }`
10. Assert event: `status-update(working, final=true)` emitted (async, not human)

**Expected Result**: Adapter correctly maps platform execution results to A2A task states.

**Failure Mode**: If execution port throws, adapter catches and emits failed state; tracing records error.

---

### INT-2: RedisA2ATaskStore Persistence and Context Indexing

**Boundary**: `RedisA2ATaskStore` <-> Redis

**Setup**: Real or in-memory Redis instance. Real `RedisA2ATaskStore` with configurable TTL.

**Steps**:

1. Save a task with `contextId: ctx-1`, `tenantId: tenant-1`
2. Load task by taskId -- assert match
3. Save 3 more tasks for same context
4. `listByContext({ contextId: ctx-1, tenantId: tenant-1 })` -- assert 4 tasks returned
5. `listByContext({ contextId: ctx-1, tenantId: tenant-1, status: 'completed' })` -- assert only completed tasks
6. `listByContext({ contextId: ctx-1, tenantId: tenant-2 })` -- assert 0 tasks (tenant isolation)
7. Save push notification config for a task; load it back -- assert match
8. Verify TTL is set on all Redis keys

**Expected Result**: Tasks are persisted, indexed by context, and tenant-isolated. TTLs are applied.

**Failure Mode**: If Redis is down, save/load throw. Caller (LazyTaskStore) falls back to InMemory.

---

### INT-3: A2A Callback Handler Atomic Claim and Resume Enqueue

**Boundary**: `createA2ACallbackRouter` <-> `A2ACallbackRegistry` + `A2AResumptionQueue`

**Setup**: Mock callback registry and resumption queue. Real Express router with supertest.

**Steps**:

1. `POST /callbacks/:callbackId` with valid payload -- registry.claim returns entry
2. Assert resumption queue.add called with correct suspensionId and payload
3. Assert response 200 `{ ok: true }`
4. `POST /callbacks/:callbackId` again -- registry.claim returns null (already claimed)
5. Assert response 200 `{ ok: true, status: 'already_processed' }` (idempotent)
6. `POST /callbacks/:callbackId` with Bearer token -- suspension lookup verifies token
7. Assert 401 when token does not match encrypted secret
8. `POST /callbacks/:callbackId` when resume queue.add throws -- assert registry.register re-registers callback
9. Assert response 503

**Expected Result**: Callbacks are claimed atomically, enqueued reliably, and re-registered on failure.

**Failure Mode**: Queue failure triggers callback re-registration (not loss).

---

### INT-4: Outbound sendTask with SSRF Validation and Tracing

**Boundary**: `sendTask` <-> `TracedCallInterceptor` + `EndpointValidator` + `A2AClient`

**Setup**: Mock A2A client factory, real SSRF validator, mock tracing port.

**Steps**:

1. Call `sendTask` with valid public endpoint -- assert client.sendMessage called
2. Assert tracing.traceOutbound called with status 'success' and duration
3. Call `sendTask` with private endpoint `http://169.254.169.254/metadata` -- assert SSRF validation throws
4. Assert tracing.traceOutbound called with status 'error'
5. Call `sendTask` where client.sendMessage returns JSON-RPC error -- assert wrapped error thrown
6. Call `sendTask` where client.sendMessage throws network error -- assert error propagated with tracing

**Expected Result**: SSRF validation blocks private endpoints; tracing records all calls.

**Failure Mode**: SSRF violation throws before any HTTP call is made.

---

### INT-5: LazyTaskStore Upgrade from InMemory to Redis

**Boundary**: `LazyTaskStore` <-> `InMemoryTaskStore` <-> `RedisA2ATaskStore`

**Setup**: Create LazyTaskStore (starts with InMemory). Prepare mock Redis store.

**Steps**:

1. Save task to LazyTaskStore (goes to InMemory)
2. Load task -- assert found in InMemory
3. Upgrade LazyTaskStore to Redis store via `lazyTaskStore.upgrade(redisStore)`
4. Save new task -- assert goes to Redis store
5. Load new task -- assert found in Redis store
6. Load old task (from InMemory era) -- may not be found (expected: InMemory data is ephemeral)

**Expected Result**: LazyTaskStore transparently upgrades; new operations use Redis. Pre-upgrade data is ephemeral.

**Failure Mode**: If upgrade called twice, second call is ignored (idempotent).

---

### INT-6: Streaming Execution with Artifact Events

**Boundary**: `AgentExecutorAdapter` (streaming path) <-> `ExecutionEventBus`

**Setup**: Mock execution port with `executeMessageStreaming` that emits 3 chunks. Real adapter and event bus.

**Steps**:

1. Call adapter.execute with streaming-capable execution port
2. Assert onChunk callback fires 3 times, producing 3 `artifact-update` events
3. Assert first artifact has `append: false`, subsequent have `append: true`
4. Assert last artifact has `lastChunk: true`
5. Assert final `status-update(completed, final=true)` emitted
6. Call adapter.execute where execution suspends mid-stream (execution_suspended trace event)
7. Assert streaming stops after suspension
8. Assert `status-update(input-required)` or `status-update(working)` emitted based on reason

**Expected Result**: Streaming chunks map to artifact events correctly; suspension detection works via Promise.race.

**Failure Mode**: If execution port throws during streaming, adapter catches and emits failed state.

---

### INT-7: Push Notification Delivery Service

**Boundary**: `PushNotificationDeliveryService` <-> `EndpointValidator` + `fetch`

**Setup**: Mock fetch (external HTTP call), real SSRF validator.

**Steps**:

1. Call `deliverTaskUpdate` with valid URL, taskId, and state -- assert fetch called with correct JSON-RPC payload
2. Assert Authorization Bearer header included when token is configured
3. Assert tracing.traceOutbound called with success
4. Call `deliverTaskUpdate` with private/internal URL -- assert SSRF validation throws
5. Call `deliverTaskUpdate` where fetch returns 500 -- assert error thrown and tracing records error
6. Assert AbortSignal.timeout(10_000) is used on fetch call

**Expected Result**: Push notifications use JSON-RPC format, validate against SSRF, and trace all attempts.

**Failure Mode**: HTTP failure is thrown (not swallowed). Tracing records error.

---

## Unit Test Scenarios

### UNIT-1: Content Extraction from A2A Message Parts

**Module**: `extractContentFromParts` (in agent-executor-adapter.ts)

**Input**: Array of parts with TextPart, DataPart, FilePart

**Expected Output**: `{ text: "concatenated text\n{json}", attachments: [{ uri, bytes, mimeType, name }] }`

### UNIT-2: Terminal State Guard

**Module**: `AgentExecutorAdapter.execute`

**Input**: RequestContext with `task.status.state: 'completed'`

**Expected Output**: Throws `"Task X is in terminal state: completed"`

### UNIT-3: SSRF Interceptor Validation

**Module**: `SsrfEndpointValidator.validate`

**Input**: Various URLs (public, private, localhost, metadata endpoints)

**Expected Output**: Public URLs pass; private/metadata throw

### UNIT-4: SyncResponseForAsyncRequest Detection

**Module**: `sendTaskAsync`

**Input**: Remote agent returns a Message (not Task) for non-blocking request

**Expected Output**: Throws `SyncResponseForAsyncRequest` with the result

---

## Security & Isolation Tests

- [x] Cross-tenant access returns 404 -- session resolver keys include tenantId
- [ ] Cross-tenant E2E with separate tenant credentials -- GAP-001 (High)
- [x] Cross-project access returns 404 -- connections are project-scoped
- [ ] Cross-user access returns 404 -- N/A (A2A has no user-scoped resources)
- [x] Missing auth returns 401 -- when API key is configured, unauthenticated requests rejected
- [x] Input validation rejects malformed data -- malformed JSON, unknown methods, path traversal
- [x] SSRF validation blocks private endpoints -- unit tests for SsrfEndpointValidator
- [x] Callback claim is atomic (idempotent) -- Redis GET+DEL prevents duplicates
- [x] Callback Bearer token verification -- unit test for token mismatch handling

---

## Performance & Load Tests (if applicable)

- [ ] Concurrent A2A request throughput under load (100+ concurrent connections)
- [ ] SSE streaming latency under load (time-to-first-byte)
- [ ] Redis task store MGET performance with 1000+ tasks per context
- [ ] Session resolver contention under high concurrency (SET NX races)

---

## Test Infrastructure

- **Runtime**: Express server on `localhost:3112` (PM2 fork mode)
- **Studio**: Next.js dev on `localhost:5173`
- **MongoDB**: `localhost:27017/abl_platform` (local, no auth)
- **Redis**: Optional -- in-memory fallback used when Redis unavailable
- **LLM**: Real LLM credentials required for E2E tests (tenant-scoped)
- **A2A SDK**: `@a2a-js/sdk` v0.2.5+ with `Client` + `JsonRpcTransport` for absolute URLs
- **Data seeding**: Create A2A channel connections via `POST /api/projects/:projectId/channel-connections`

---

## Test File Mapping

| Test File                                                       | Type        | Covers                                   |
| --------------------------------------------------------------- | ----------- | ---------------------------------------- |
| `packages/a2a/src/__tests__/agent-executor-adapter.test.ts`     | unit        | FR-8, FR-10, FR-11 (INT-1)               |
| `packages/a2a/src/__tests__/express-handlers.test.ts`           | unit        | FR-1, FR-2                               |
| `packages/a2a/src/__tests__/send-task.test.ts`                  | unit        | FR-3, FR-6 (INT-4)                       |
| `packages/a2a/src/__tests__/send-task-async.test.ts`            | unit        | FR-3 (async path)                        |
| `packages/a2a/src/__tests__/discover-agent.test.ts`             | unit        | FR-3 (discovery)                         |
| `packages/a2a/src/__tests__/redis-task-store.test.ts`           | unit        | FR-4 (INT-2)                             |
| `packages/a2a/src/__tests__/lazy-task-store.test.ts`            | unit        | INT-5                                    |
| `packages/a2a/src/__tests__/push-notification-delivery.test.ts` | unit        | FR-9 (INT-7)                             |
| `packages/a2a/src/__tests__/streaming-integration.test.ts`      | integration | FR-1, FR-8 (INT-6)                       |
| `packages/a2a/src/__tests__/ssrf-interceptor.test.ts`           | unit        | FR-6                                     |
| `packages/a2a/src/__tests__/traced-client.test.ts`              | unit        | FR-7                                     |
| `packages/a2a/src/__tests__/ports.test.ts`                      | unit        | Domain port contracts                    |
| `packages/a2a/src/__tests__/outbound-capabilities.test.ts`      | unit        | FR-3 (streaming capabilities)            |
| `apps/runtime/src/__tests__/sessions/chat-routes.test.ts`       | unit        | FR-11 (metadata forwarding + validation) |
| Live E2E suite (manual/agent-driven)                            | e2e         | E2E-1 through E2E-7                      |

---

## Open Testing Questions

1. How should cross-tenant E2E tests be set up? A second tenant needs separate LLM credentials -- is there a test tenant provisioning flow?
2. Should `tasks/cancel` E2E tests simulate a long-running tool call that can be interrupted, or use a test agent with artificial delay?
3. Should push notification E2E tests use a real callback server or a mock endpoint?
4. What is the expected behavior when Redis is down mid-operation (task save after execution)? Should tests verify graceful degradation?
5. Should FilePart (binary attachment) E2E tests require a multimodal LLM or can they verify extraction/forwarding without LLM processing?
