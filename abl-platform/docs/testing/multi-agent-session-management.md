# Test Specification: Multi-Agent Session Management

**Feature Spec**: `docs/features/multi-agent-session-management.md`
**HLD**: `docs/specs/multi-agent-session-management.hld.md` (pending)
**LLD**: `docs/plans/multi-agent-session-management-impl-plan.md` (pending)
**Status**: PLANNED
**Last Updated**: 2026-03-23

---

## 1. Coverage Matrix

| FR    | Description                      | Unit    | Integration | E2E     | Manual | Status  |
| ----- | -------------------------------- | ------- | ----------- | ------- | ------ | ------- |
| FR-1  | Per-Thread Execution Lock        | PLANNED | PLANNED     | PLANNED | N/A    | PLANNED |
| FR-2  | Thread Data Namespace            | PLANNED | PLANNED     | PLANNED | N/A    | PLANNED |
| FR-3  | Explicit Data Sharing            | PLANNED | PLANNED     | PLANNED | N/A    | PLANNED |
| FR-4  | Fan-Out Partial Result Recovery  | PLANNED | PLANNED     | PLANNED | N/A    | PLANNED |
| FR-5  | Agent Participation Graph        | PLANNED | PLANNED     | PLANNED | N/A    | PLANNED |
| FR-6  | Cold Storage Thread Edges        | PLANNED | PLANNED     | PLANNED | N/A    | PLANNED |
| FR-7  | Participation Graph API Endpoint | PLANNED | PLANNED     | PLANNED | N/A    | PLANNED |
| FR-8  | Thread Conversation Isolation    | PLANNED | PLANNED     | PLANNED | N/A    | PLANNED |
| FR-9  | Handoff Transition Atomicity     | PLANNED | PLANNED     | PLANNED | N/A    | PLANNED |
| FR-10 | Branch Timeout Independence      | PLANNED | PLANNED     | PLANNED | N/A    | PLANNED |

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests exercise the real system through its HTTP API. No mocks, no direct DB access, no stubbed servers. All tests start real Express servers on random ports (`{ port: 0 }`) with the full middleware chain (auth, rate limiting, tenant isolation, validation).

### E2E-1: Handoff Data Isolation — Agent A Data Not Visible to Agent B

- **Preconditions**:
  - Runtime Express server started on random port with full middleware chain
  - Two agents deployed in project: `Agent_A` (gathers `customerName`, `orderNumber`) and `Agent_B` (gathers `issueType`)
  - `Agent_A` HANDOFF config to `Agent_B` with `data_mapping: { orderNumber: orderNumber }` (only `orderNumber` is shared)
  - Bearer token for tenant `t1`, project `p1`, user `u1`
- **Steps**:
  1. `POST /api/runtime/chat` with `{ sessionId: "<uuid>", agentName: "Agent_A", message: "John Doe", tenantId: "t1", projectId: "p1" }` — Agent A gathers `customerName = "John Doe"`
  2. `POST /api/runtime/chat` with `{ sessionId: "<uuid>", message: "ORD-12345" }` — Agent A gathers `orderNumber`, triggers handoff to Agent B
  3. `GET /api/runtime/sessions/<uuid>` with auth header — retrieve session state
  4. Assert: Active thread (Agent B) `dataValues` contains `orderNumber: "ORD-12345"` (shared via data_mapping)
  5. Assert: Active thread (Agent B) `dataValues` does NOT contain `customerName` (not in data_mapping)
  6. Assert: Agent A's thread `dataValues` still contains both `customerName` and `orderNumber`
  7. Assert: Session-level merged `dataValues` contains both (merged read-only view)
- **Expected Result**: Agent B sees only explicitly shared data; Agent A's private data is isolated
- **Auth Context**: Bearer `t1/p1/u1`
- **Isolation Check**: `GET /api/runtime/sessions/<uuid>` with tenant `t2` token returns 404

### E2E-2: Concurrent Messages During Handoff Transition

- **Preconditions**:
  - Runtime server with execution coordinator enabled
  - Agent A configured with HANDOFF to Agent B (slow handoff — agent B has large system prompt triggering multi-second LLM call)
  - Feature flag `MULTI_AGENT_SESSION_V2=true`
- **Steps**:
  1. `POST /api/runtime/chat` with `{ sessionId: "<uuid>", message: "start" }` — triggers Agent A → Agent B handoff
  2. Immediately (within 100ms) `POST /api/runtime/chat` with `{ sessionId: "<uuid>", message: "follow-up" }` — concurrent message during handoff
  3. Wait for both responses (poll `GET /api/runtime/sessions/<uuid>/messages`)
  4. Assert: First response is from Agent B (handoff completed)
  5. Assert: Second message was queued and processed by Agent B (not dropped, not corrupted)
  6. Assert: Session `threads` array has exactly 2 threads (A and B), both with clean state
  7. Assert: No thread state corruption — Agent B's `conversationHistory` contains both interactions in order
- **Expected Result**: Concurrent message during handoff is queued via ExecutionCoordinator's serial strategy, not dropped or corrupted
- **Auth Context**: Bearer `t1/p1/u1`

### E2E-3: Fan-Out with Partial Failure and Recovery

- **Preconditions**:
  - Runtime server with 3 agents: `Supervisor`, `Agent_Fast` (responds quickly), `Agent_Slow` (2s delay), `Agent_Failing` (always errors)
  - Supervisor configured with `FAN_OUT` to all three with per-branch timeout of 5s for Fast/Slow and 100ms for Failing
- **Steps**:
  1. `POST /api/runtime/chat` with `{ sessionId: "<uuid>", agentName: "Supervisor", message: "process all" }` — triggers fan-out
  2. Wait for supervisor response (may take up to 5s)
  3. `GET /api/runtime/sessions/<uuid>` — retrieve session
  4. Assert: Session `threads` contain child threads for all 3 agents
  5. Assert: Agent_Fast thread status is `completed`
  6. Assert: Agent_Failing thread status is `completed` with error outcome (timeout/error)
  7. Assert: Agent_Slow thread status is `completed` (finished within 5s timeout)
  8. Assert: Supervisor response includes results from Agent_Fast and Agent_Slow
  9. Assert: Supervisor response indicates Agent_Failing branch failed
  10. `GET /api/runtime/sessions/<uuid>/messages` — verify trace events include `fan_out_start` and per-branch `fan_out_complete`/`fan_out_error`
- **Expected Result**: Fan-out completes with partial results; failed branches are recorded as errors; parent resumes with available results
- **Auth Context**: Bearer `t1/p1/u1`

### E2E-4: Participation Graph Recording and API Retrieval

- **Preconditions**:
  - Runtime server with agents: `Entry_Agent`, `Billing_Agent`, `Support_Agent`
  - `Entry_Agent` hands off to `Billing_Agent`, which delegates to `Support_Agent`, which completes and returns
  - Feature flag `PARTICIPATION_GRAPH_ENABLED=true`
- **Steps**:
  1. `POST /api/runtime/chat` with `{ sessionId: "<uuid>", agentName: "Entry_Agent", message: "billing issue" }` — starts with Entry_Agent
  2. Entry_Agent routes to Billing_Agent (handoff)
  3. `POST /api/runtime/chat` with `{ sessionId: "<uuid>", message: "need support help" }` — Billing_Agent delegates to Support_Agent
  4. Support_Agent completes, returns to Billing_Agent
  5. `POST /api/runtime/chat` with `{ sessionId: "<uuid>", message: "done" }` — Billing_Agent completes, returns to Entry_Agent
  6. `GET /api/runtime/sessions/<uuid>/participation-graph` with auth header
  7. Assert response shape:
     ```json
     {
       "nodes": [
         { "agentName": "Entry_Agent", "threadIndex": 0, "status": "active" },
         { "agentName": "Billing_Agent", "threadIndex": 1, "status": "completed" },
         { "agentName": "Support_Agent", "threadIndex": 2, "status": "completed" }
       ],
       "edges": [
         { "fromAgent": "Entry_Agent", "toAgent": "Billing_Agent", "type": "handoff" },
         { "fromAgent": "Billing_Agent", "toAgent": "Support_Agent", "type": "delegate" },
         { "fromAgent": "Support_Agent", "toAgent": "Billing_Agent", "type": "return" },
         { "fromAgent": "Billing_Agent", "toAgent": "Entry_Agent", "type": "return" }
       ]
     }
     ```
  8. Assert: Each node has `startedAt` and `endedAt` (except active thread)
  9. Assert: Each edge has `timestamp` and `dataKeys` array
- **Expected Result**: Participation graph accurately reflects the agent flow with correct node/edge structure
- **Auth Context**: Bearer `t1/p1/u1`
- **Isolation Check**: `GET /api/runtime/sessions/<uuid>/participation-graph` with tenant `t2` returns 404

### E2E-5: Cold Storage Round-Trip Fidelity for Multi-Agent Session

- **Preconditions**:
  - Runtime server with Redis and MongoDB both available
  - TieredSessionStore enabled (`coldStorageEnabled: true`)
  - Two agents: `Agent_A` and `Agent_B`
- **Steps**:
  1. `POST /api/runtime/chat` with `{ sessionId: "<uuid>", agentName: "Agent_A", message: "hello" }` — creates session, Agent A responds
  2. `POST /api/runtime/chat` with `{ sessionId: "<uuid>", message: "transfer me" }` — triggers handoff to Agent B
  3. `POST /api/runtime/chat` with `{ sessionId: "<uuid>", message: "thanks" }` — Agent B responds
  4. Record session state snapshot: `GET /api/runtime/sessions/<uuid>` — save response as `before`
  5. Force cold storage persist by calling internal admin endpoint `POST /api/runtime/sessions/<uuid>/flush-cold` (admin auth)
  6. Delete Redis session key directly (admin operation via `POST /api/runtime/sessions/<uuid>/evict-hot`)
  7. `GET /api/runtime/sessions/<uuid>` — triggers cold restore via TieredSessionStore
  8. Save response as `after`
  9. Assert: `before.threads.length === after.threads.length`
  10. Assert: For each thread `i`: `before.threads[i].agentName === after.threads[i].agentName`
  11. Assert: For each thread `i`: `before.threads[i].handoffFrom === after.threads[i].handoffFrom`
  12. Assert: `before.activeThreadIndex === after.activeThreadIndex`
  13. Assert: `before.threadStack` deep-equals `after.threadStack`
  14. Assert: `before.handoffStack` deep-equals `after.handoffStack`
  15. Assert: Agent B's conversation history is preserved
- **Expected Result**: Cold-restored session is structurally identical to the hot session
- **Auth Context**: Bearer `t1/p1/u1` (admin for evict operations)

### E2E-6: Thread Lock Prevents Concurrent Handoff Corruption

- **Preconditions**:
  - Runtime server with `MULTI_AGENT_SESSION_V2=true`
  - Agent A with two handoff targets: Agent B and Agent C
  - Two concurrent requests designed to trigger simultaneous handoffs
- **Steps**:
  1. `POST /api/runtime/chat` with `{ sessionId: "<uuid>", agentName: "Agent_A", message: "setup" }`
  2. Simultaneously send two requests:
     - `POST /api/runtime/chat` with `{ sessionId: "<uuid>", message: "go to B" }`
     - `POST /api/runtime/chat` with `{ sessionId: "<uuid>", message: "go to C" }`
  3. Wait for both to complete
  4. `GET /api/runtime/sessions/<uuid>` — verify session integrity
  5. Assert: Session has a valid `activeThreadIndex` pointing to a real thread
  6. Assert: `threads` array has no duplicate agents at the same index
  7. Assert: One of the messages was processed first (handoff to B or C), the second was queued
  8. Assert: No `thread_lock_contention` trace event with `error` severity (contention is logged but not fatal)
- **Expected Result**: Thread lock serializes concurrent handoff attempts; session state remains consistent
- **Auth Context**: Bearer `t1/p1/u1`

### E2E-7: Data Namespace Merge — Session-Level Read-Only View

- **Preconditions**:
  - Runtime server, Agent A gathers `name`, `email`; Agent B gathers `plan`, `email` (overlapping key)
  - Handoff A → B with `data_mapping: {}` (no sharing)
- **Steps**:
  1. Agent A gathers `name: "Alice"`, `email: "alice@a.com"`
  2. Handoff to Agent B
  3. Agent B gathers `plan: "enterprise"`, `email: "alice@b.com"` (different value for overlapping key)
  4. `GET /api/runtime/sessions/<uuid>` — retrieve session
  5. Assert: Thread 0 (Agent A) `dataValues` = `{ name: "Alice", email: "alice@a.com" }`
  6. Assert: Thread 1 (Agent B) `dataValues` = `{ plan: "enterprise", email: "alice@b.com" }`
  7. Assert: Session-level merged `dataValues` has `email: "alice@b.com"` (active thread takes precedence)
  8. Assert: Session-level merged `dataValues` has `name: "Alice"` (from Thread 0, no conflict)
  9. Assert: Session-level merged `dataValues` has `plan: "enterprise"` (from Thread 1, no conflict)
- **Expected Result**: Active thread's values take precedence in the merged view; all thread data preserved independently
- **Auth Context**: Bearer `t1/p1/u1`

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Thread Lock — Acquire, Release, Timeout, Contention (RedisSessionStore)

- **Boundary**: `RedisSessionStore` → Redis
- **Setup**: Real Redis instance (Docker or CI Redis), `RedisSessionStore` instantiated with `threadLockTtlMs: 500`
- **Steps**:
  1. Call `store.acquireThreadLock("sess-1", 0)` — returns `true`
  2. Call `store.acquireThreadLock("sess-1", 0)` again — returns `false` (lock held)
  3. Call `store.acquireThreadLock("sess-1", 1)` — returns `true` (different thread index)
  4. Call `store.releaseThreadLock("sess-1", 0)` — succeeds
  5. Call `store.acquireThreadLock("sess-1", 0)` — returns `true` (lock released)
  6. Call `store.acquireThreadLock("sess-1", 2)` — returns `true`
  7. Wait 600ms (beyond 500ms TTL)
  8. Call `store.acquireThreadLock("sess-1", 2)` — returns `true` (lock expired)
- **Expected Result**: Thread locks are per-thread, mutually exclusive within a thread, expire after TTL
- **Failure Mode**: If Redis is down, `acquireThreadLock` throws (not silently succeeds)

### INT-2: Thread Lock — MemorySessionStore Parity

- **Boundary**: `MemorySessionStore` (in-process)
- **Setup**: `MemorySessionStore` instantiated
- **Steps**: Same as INT-1 but against MemorySessionStore
- **Expected Result**: Identical behavior to RedisSessionStore for lock semantics
- **Failure Mode**: N/A (in-memory, always available)

### INT-3: Data Namespace Merge Computation

- **Boundary**: Thread data merge logic (pure function)
- **Setup**: Create a `SessionData` with 3 threads:
  - Thread 0 (Agent A): `dataValues = { name: "Alice", shared: "from-A" }`
  - Thread 1 (Agent B): `dataValues = { plan: "pro", shared: "from-B" }`
  - Thread 2 (Agent C, active): `dataValues = { issue: "billing", shared: "from-C" }`
  - `activeThreadIndex = 2`
- **Steps**:
  1. Call the merge function to compute session-level `dataValues`
  2. Assert: Result contains `name: "Alice"` (from thread 0, no conflict)
  3. Assert: Result contains `plan: "pro"` (from thread 1, no conflict)
  4. Assert: Result contains `issue: "billing"` (from thread 2, no conflict)
  5. Assert: Result contains `shared: "from-C"` (active thread 2 wins on conflict)
  6. Verify: Changing `activeThreadIndex` to 0 changes merge result for `shared` key
- **Expected Result**: Active thread values take precedence; all non-conflicting keys from all threads included

### INT-4: Fan-Out Barrier — Independent Branch Timeouts

- **Boundary**: `RedisFanOutBarrierStore` → Redis
- **Setup**: Real Redis, create barrier with `totalBranches: 3`, `timeoutMs: 10000`
- **Steps**:
  1. Call `store.create({ parentSessionId: "s1", parentExecutionId: "e1", tenantId: "t1", totalBranches: 3, timeoutMs: 10000 })`
  2. Complete branch "Agent_Fast" after 50ms — call `store.completeBranch(barrierId, { branchAgent: "Agent_Fast", status: "completed", response: "fast result", completedAt: Date.now() })`
  3. Assert: returns `{ allComplete: false, completedCount: 1, totalCount: 3 }`
  4. Complete branch "Agent_Medium" after 500ms — same pattern
  5. Assert: returns `{ allComplete: false, completedCount: 2, totalCount: 3 }`
  6. Complete branch "Agent_Slow" after 2000ms with status `"timeout"`
  7. Assert: returns `{ allComplete: true, completedCount: 3, totalCount: 3 }`
  8. Call `store.getResults(barrierId)` — verify all 3 results present with correct statuses
  9. Verify Agent_Fast result was available immediately after step 2 (not blocked by other branches)
- **Expected Result**: Each branch completes independently; all results are available; allComplete triggers on last branch

### INT-5: Participation Graph MongoDB Persistence

- **Boundary**: MongoDB Session model → MongoDB
- **Setup**: Real MongoDB (MongoMemoryServer or Docker), Session model
- **Steps**:
  1. Create Session document with `participationGraph`:
     ```javascript
     {
       nodes: [
         { agentName: "A", threadIndex: 0, startedAt: new Date(), endedAt: null, status: "active", outcome: null },
         { agentName: "B", threadIndex: 1, startedAt: new Date(), endedAt: new Date(), status: "completed", outcome: "success" }
       ],
       edges: [
         { fromAgent: "A", toAgent: "B", type: "handoff", timestamp: new Date(), dataKeys: ["orderNumber"] }
       ]
     }
     ```
  2. Query: `Session.findOne({ _id, tenantId: "t1" })` — returns the session with graph
  3. Query: `Session.findOne({ _id, tenantId: "t2" })` — returns null (tenant isolation)
  4. Query with agent name filter: `Session.find({ tenantId: "t1", "participationGraph.nodes.agentName": "B" })` — returns session
  5. Verify: `$push` operation appends to `participationGraph.edges` without replacing
- **Expected Result**: Graph persists correctly; tenant isolation enforced; index supports agent-name queries

### INT-6: SessionStateRepo — Cold Storage Thread Edge Preservation

- **Boundary**: `SessionStateRepo` → MongoDB `session_states` collection
- **Setup**: Real MongoDB, `SessionStateRepo` instantiated
- **Steps**:
  1. Create `SessionData` with 3 threads:
     - Thread 0: `Agent_A`, `handoffFrom: undefined`, root thread
     - Thread 1: `Agent_B`, `handoffFrom: "Agent_A"`, `handoffContext: { reason: "billing" }`
     - Thread 2: `Agent_C`, `handoffFrom: "Agent_B"`, `handoffContext: { delegateFor: "lookup" }`
  2. Set `tenantId: "t1"`, `projectId: "p1"` on the session
  3. Call `sessionStateRepo.upsert(sessionData)`
  4. Call `sessionStateRepo.loadInternal(sessionData.id)`
  5. Assert: Restored session has 3 threads
  6. Assert: Thread 1 `handoffFrom === "Agent_A"`
  7. Assert: Thread 2 `handoffFrom === "Agent_B"`
  8. Assert: Thread relationships preserved (parentThreadId, forkPoint if set)
  9. Assert: Data values for each thread are independently decompressed and match originals
  10. Assert: `dataGatheredKeys` for each thread match originals
- **Expected Result**: Cold storage preserves all inter-thread relationships with byte-level fidelity

### INT-7: Handoff Data Mapping — Explicit Share via IR Config

- **Boundary**: `createThread()` in `execution/types.ts` → thread creation during handoff
- **Setup**: RuntimeSession with Agent A thread containing `dataValues: { secret: "abc", shared: "xyz" }`
- **Steps**:
  1. Call `createThread(session, { agentName: "Agent_B", agentIR: bIR, handoffConfig: { data_mapping: { shared: "shared" } } })`
  2. Assert: New thread `dataValues` contains `shared: "xyz"` (mapped)
  3. Assert: New thread `dataValues` does NOT contain `secret` (not mapped)
  4. Assert: New thread `sharedFromParent` contains `["shared"]`
  5. Assert: Original thread `sharedToChildren` contains `["shared"]`
  6. Call `createThread(session, { agentName: "Agent_C", agentIR: cIR, handoffConfig: { data_mapping: {} } })`
  7. Assert: Agent C thread `dataValues` is empty (no mapping)
- **Expected Result**: Only explicitly mapped keys transfer between threads

## 4. Unit Test Scenarios

### UT-1: Thread Lock Key Format

- **Module**: `RedisSessionStore.acquireThreadLock()`
- **Input**: `sessionId = "sess-abc"`, `threadIndex = 2`
- **Expected Output**: Redis SET called with key `session:sess-abc:thread:2:lock`, NX flag, PX = `threadLockTtlMs`

### UT-2: Data Namespace Merge — Empty Threads

- **Module**: `mergeThreadDataValues()` (new pure function)
- **Input**: Session with 0 threads, `activeThreadIndex = -1`
- **Expected Output**: Empty object `{}`

### UT-3: Data Namespace Merge — Single Thread

- **Module**: `mergeThreadDataValues()`
- **Input**: Session with 1 thread, `dataValues = { a: 1, b: 2 }`, `activeThreadIndex = 0`
- **Expected Output**: `{ a: 1, b: 2 }` (same as the single thread)

### UT-4: Participation Graph Node Creation

- **Module**: `createParticipationNode()`
- **Input**: `agentName = "Agent_A"`, `threadIndex = 0`, `startedAt = Date.now()`
- **Expected Output**: `{ agentName: "Agent_A", threadIndex: 0, startedAt: <Date>, endedAt: null, status: "active", outcome: null }`

### UT-5: Participation Graph Edge Creation

- **Module**: `createParticipationEdge()`
- **Input**: `from = "A"`, `to = "B"`, `type = "handoff"`, `dataKeys = ["orderNumber"]`
- **Expected Output**: `{ fromAgent: "A", toAgent: "B", type: "handoff", timestamp: <Date>, dataKeys: ["orderNumber"] }`

### UT-6: tryThreadReturn — Data Merge Respects Namespaces

- **Module**: `tryThreadReturn()` in `execution/types.ts`
- **Input**: Session where child thread (Agent B) has `dataValues: { secret_b: "hidden", shared: "exported" }` with `sharedToChildren: ["shared"]`
- **Expected Output**: Parent thread receives only `shared: "exported"`, not `secret_b`

### UT-7: createChildSession — Thread Array Isolation

- **Module**: `createChildSession()` in `packages/execution/src/child-session.ts`
- **Input**: Parent session with 2 threads
- **Expected Output**: Child session `threads` is a new array (mutations don't affect parent)

### UT-8: Feature Flag Guard — V2 Logic Disabled

- **Module**: Thread lock acquisition path
- **Input**: `MULTI_AGENT_SESSION_V2=false`
- **Expected Output**: `acquireThreadLock` is not called; falls back to session-level lock

## 5. Security & Isolation Tests

### SEC-1: Cross-Tenant Session Access Returns 404

- `GET /api/runtime/sessions/<session-owned-by-t1>` with bearer for tenant `t2`
- Expected: 404 (not 403, to avoid leaking existence)

### SEC-2: Cross-Tenant Participation Graph Returns 404

- `GET /api/runtime/sessions/<session-owned-by-t1>/participation-graph` with bearer for tenant `t2`
- Expected: 404

### SEC-3: Cross-Project Session Access Returns 404

- Session belongs to project `p1`; request from user with access to project `p2` only
- Expected: 404

### SEC-4: Missing Auth Returns 401

- `GET /api/runtime/sessions/<uuid>/participation-graph` with no Authorization header
- Expected: 401

### SEC-5: Insufficient Permissions Returns 403

- User has `session:read` but not `session:admin`; calls admin-only eviction endpoint
- Expected: 403

### SEC-6: Input Validation — Invalid Session ID Format

- `GET /api/runtime/sessions/../../etc/passwd/participation-graph`
- Expected: 400 (bad request) or 404 (not found after ID sanitization)

### SEC-7: Thread Lock Key Scoping — No Cross-Session Lock Interference

- Acquire lock for `session:sess-1:thread:0:lock`
- Verify `session:sess-2:thread:0:lock` is independently acquirable
- Verify lock key contains no user-controllable path traversal

### SEC-8: PII Vault Per-Thread Scope

- Create session with PII redaction enabled
- Agent A collects PII field `ssn`
- Handoff to Agent B (without `ssn` in data_mapping)
- Verify Agent B's thread does not contain `ssn` in `dataValues` or `piiVaultData`

## 6. Performance & Load Tests

### PERF-1: Thread Lock Acquisition Latency

- **Target**: < 2ms p99 for `acquireThreadLock` under 100 concurrent sessions
- **Setup**: 100 concurrent goroutines each acquiring/releasing thread locks
- **Measurement**: Histogram of lock acquisition duration

### PERF-2: Participation Graph Write Latency

- **Target**: < 5ms p99 for `$push` to participation graph
- **Setup**: Session with 50 existing graph nodes (stress test)
- **Measurement**: MongoDB operation duration

### PERF-3: Data Namespace Merge Throughput

- **Target**: < 1ms for merge with 10 threads, 100 keys each
- **Setup**: Synthetic session with 10 threads
- **Measurement**: Function execution duration

### PERF-4: Cold Storage Round-Trip Latency

- **Target**: < 100ms for session with 5 threads, each with 50 conversation messages
- **Setup**: Real Redis + MongoDB, full TieredSessionStore
- **Measurement**: End-to-end save → delete → restore duration

### PERF-5: Fan-Out Barrier — 10 Concurrent Branches

- **Target**: < 50ms total for 10 branches completing near-simultaneously
- **Setup**: Real Redis, `completeBranch` called 10 times with 1ms spacing
- **Measurement**: Time from first completeBranch to allComplete detection

## 7. Test Infrastructure

### Required Services

| Service | Version | Purpose                       | Docker Image              |
| ------- | ------- | ----------------------------- | ------------------------- |
| Redis   | 7.2+    | Thread locks, session store   | `redis:7.2-alpine`        |
| MongoDB | 7.0+    | Session model, cold storage   | `mongo:7.0`               |
| Runtime | Local   | Full Express middleware chain | Built from `apps/runtime` |

### Data Seeding

- **Agent DSL files**: Use test fixture agents in `apps/runtime/src/__tests__/fixtures/` or create minimal ABL agents inline (following pattern from `traveldesk-supervisor-ws-flow.e2e.test.ts`)
- **Tenant/Project**: Seed via `POST /api/admin/tenants` and `POST /api/admin/projects` (admin auth)
- **Agent deployment**: Deploy agents via `POST /api/projects/:projectId/agents`

### Environment Variables

```bash
REDIS_URL=redis://localhost:6379
MONGODB_URL=mongodb://localhost:27017/abl-test
MULTI_AGENT_SESSION_V2=true
PARTICIPATION_GRAPH_ENABLED=true
THREAD_LOCK_TTL_MS=5000
FANOUT_RESULT_TTL_MULTIPLIER=2
```

### CI Configuration

- E2E tests run in `apps/runtime` vitest suite with `--pool=forks` (isolated processes)
- Integration tests requiring Redis/MongoDB use Docker services in CI (already configured for existing session tests)
- Test timeout: 30s per E2E scenario (accounts for LLM calls if using real providers)
- Environment: `NODE_ENV=test`, `LLM_PROVIDER` defaulting to mock (set to `anthropic`/`openai` for real LLM E2E)

## 8. Test File Mapping

| Test File                                                                        | Type        | Covers                         |
| -------------------------------------------------------------------------------- | ----------- | ------------------------------ |
| `apps/runtime/src/__tests__/multi-agent-thread-lock.test.ts`                     | unit        | FR-1, UT-1, UT-8               |
| `apps/runtime/src/__tests__/multi-agent-data-namespace.test.ts`                  | unit        | FR-2, FR-3, UT-2-3, UT-6       |
| `apps/runtime/src/__tests__/multi-agent-participation-graph.test.ts`             | unit        | FR-5, UT-4-5                   |
| `apps/runtime/src/__tests__/multi-agent-thread-lock-redis.integration.test.ts`   | integration | FR-1, FR-9, INT-1-2            |
| `apps/runtime/src/__tests__/multi-agent-data-namespace.integration.test.ts`      | integration | FR-2, FR-3, INT-3, INT-7       |
| `apps/runtime/src/__tests__/multi-agent-fanout-barrier.integration.test.ts`      | integration | FR-4, FR-10, INT-4             |
| `apps/runtime/src/__tests__/multi-agent-participation-graph.integration.test.ts` | integration | FR-5, FR-7, INT-5              |
| `apps/runtime/src/__tests__/multi-agent-cold-storage.integration.test.ts`        | integration | FR-6, INT-6                    |
| `apps/runtime/src/__tests__/multi-agent-handoff-isolation.e2e.test.ts`           | e2e         | FR-2, FR-3, FR-8, E2E-1, E2E-7 |
| `apps/runtime/src/__tests__/multi-agent-concurrent-handoff.e2e.test.ts`          | e2e         | FR-1, FR-9, E2E-2, E2E-6       |
| `apps/runtime/src/__tests__/multi-agent-fanout-recovery.e2e.test.ts`             | e2e         | FR-4, FR-10, E2E-3             |
| `apps/runtime/src/__tests__/multi-agent-participation-graph.e2e.test.ts`         | e2e         | FR-5, FR-7, E2E-4              |
| `apps/runtime/src/__tests__/multi-agent-cold-storage-roundtrip.e2e.test.ts`      | e2e         | FR-6, E2E-5                    |
| `apps/runtime/src/__tests__/multi-agent-security-isolation.e2e.test.ts`          | e2e         | SEC-1 through SEC-8            |
| `packages/execution/src/__tests__/child-session-namespace.test.ts`               | unit        | FR-2, UT-7                     |

## 9. Open Testing Questions

1. **LLM dependency in E2E**: Should multi-agent E2E tests use real LLM calls or a deterministic mock LLM? Real calls make tests flaky but catch real integration issues. Recommendation: Use mock LLM for CI, real LLM for nightly runs (following existing pattern in `test-utils.ts` with `LLM_PROVIDER` env var).

2. **MongoMemoryServer vs Docker MongoDB**: Existing integration tests in `apps/runtime` use both patterns. Which should this feature standardize on? MongoMemoryServer is faster for CI but doesn't support all MongoDB features (e.g., change streams).

3. **Fan-out timing sensitivity**: E2E-3 depends on relative timing of agent responses. How do we make this deterministic without mocking the agents themselves? Recommendation: Use agents with configurable delay (sleep tool) rather than relying on natural LLM response times.

4. **Participation graph eventual consistency**: In a distributed deployment, the MongoDB `$push` for graph edges may arrive out of order. Should tests verify ordering? Recommendation: Verify set membership (all edges present) but not strict ordering.

5. **Cold storage eviction API**: E2E-5 needs admin endpoints for cache eviction that may not exist yet (`/flush-cold`, `/evict-hot`). These need to be part of the implementation or test infrastructure.
