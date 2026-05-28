# HLD: Multi-Agent Session Management

**Feature Spec**: `docs/features/multi-agent-session-management.md`
**Test Spec**: `docs/testing/multi-agent-session-management.md`
**Status**: DRAFT
**Author**: Runtime Team
**Date**: 2026-03-23

---

## 1. Problem Statement

The ABL Platform's threaded session model (`SessionData.threads[]`, `AgentThreadData`) supports multi-agent conversations via handoff, delegate, and fan-out constructs. However, five architectural gaps prevent production-grade operation:

1. **No per-thread execution locking** — concurrent messages during handoff transitions can corrupt thread state because the existing `lock:exec:{tenantId}:{sessionId}` lock in `RedisSessionStore` is session-scoped, not thread-scoped.

2. **Flat data namespace** — `SessionData.dataValues` is a single `Record<string, unknown>` shared across all threads, allowing Agent B to read/overwrite Agent A's gathered fields without explicit sharing.

3. **Fragile fan-out lifecycle** — `RedisFanOutBarrierStore` result TTL matches the barrier TTL. If the parent session expires mid-fan-out, completed branch results are lost. `createChildSession()` in `packages/execution/src/child-session.ts` shares thread array references (shallow copy), creating mutation hazards.

4. **No agent topology tracking** — `Session` model tracks `currentAgent` and `handoffCount` but not the full participation graph (which agents were active, transition order, data flow edges).

5. **Cold storage fidelity gaps** — `SessionStateRepo.upsert()` has fields for `handoffFrom`, `parentThreadId`, and `forkPoint` in the schema, but they are not always populated during writes. Inter-thread relationships are lost on cold restore.

## 2. Alternatives Considered

### Option A: Session-Per-Agent (New Session on Handoff)

- **Description**: Each handoff creates a new session. Parent-child sessions linked via `parentId`. Each session has its own Redis key space, lock, and data.
- **Pros**: Natural isolation (separate sessions cannot interfere). Existing session infrastructure works unchanged. Simple mental model.
- **Cons**: Session sprawl (a 5-agent conversation creates 5 sessions). Cross-session data sharing requires explicit API calls. Studio UI must stitch sessions together for unified view. Existing WebSocket connections are session-bound — handoff would require reconnection. `parentId` field exists on `Session` model but is not wired for session-chaining. Breaks existing thread model (all `threads[]`, `activeThreadIndex`, `threadStack` become unused).
- **Effort**: L (large — rearchitecture of session model)

### Option B: Enhanced Thread Model with Per-Thread Isolation (Recommended)

- **Description**: Keep the existing `SessionData.threads[]` model. Add per-thread execution locks, enforce data namespace isolation at the thread level, and make the merge to session-level `dataValues` a computed read-only view. Extend the `Session` MongoDB model with a participation graph. Fix cold storage to populate existing schema fields.
- **Pros**: Minimal schema changes (thread-level data is already structural in `AgentThreadData`). No session sprawl. WebSocket connection stays bound to one session. Studio UI already has `AgentConversationTree` component that understands threads. Backward compatible — existing sessions work unchanged (V2 behavior behind feature flag). Leverages existing infrastructure (`RedisSessionStore` Lua scripts, `SessionStateRepo` compress/decompress, `FanOutBarrierStore` atomic operations).
- **Cons**: Thread-level locking adds 1 Redis round-trip per handoff (~1ms). Merge computation adds CPU overhead on session read. Feature flag adds code paths to maintain.
- **Effort**: M (medium — additive changes to existing infrastructure)

### Option C: Event-Sourced Session State

- **Description**: Replace the mutable session store with an event log. Each thread mutation (create, handoff, data write, complete) becomes an immutable event. Session state is reconstructed by replaying events. Per-thread isolation is inherent because events are scoped to their thread.
- **Pros**: Perfect auditability. Natural conflict resolution (last-writer-wins with event ordering). Cold storage is trivially the event log itself. Participation graph is a projection of events.
- **Cons**: Massive rearchitecture — `SessionStore` interface, `RedisSessionStore`, `MemorySessionStore`, `TieredSessionStore`, `SessionService`, and every caller would need rewriting. Event replay latency for long sessions. No existing event-sourcing infrastructure in the codebase. Incompatible with the existing Lua-script-based atomic operations (`LUA_SAVE`, `LUA_APPEND_CONV`).
- **Effort**: XL (extra-large — ground-up rewrite)

### Recommendation: Option B — Enhanced Thread Model

**Rationale**: Option B delivers all five gap fixes with the smallest blast radius. The `AgentThreadData` interface already has per-thread `dataValues`, `conversationHistory`, and `state` — the isolation is structurally present but not enforced. The changes are additive (new lock keys, new merge logic, new participation graph field) rather than architectural (no new services, no new stores, no new event models). The feature flag `MULTI_AGENT_SESSION_V2` allows safe rollout. Option A creates session sprawl and breaks the WebSocket binding model. Option C is architecturally pure but has prohibitive migration cost.

## 3. Architecture

### System Context Diagram

```
                                 ┌─────────────────────────────────┐
                                 │         Client (Browser)         │
                                 │   WebSocket / REST / SDK         │
                                 └────────────┬────────────────────┘
                                              │
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RUNTIME SERVICE                                    │
│                                                                              │
│  ┌───────────────┐   ┌──────────────────────┐   ┌────────────────────────┐ │
│  │  WS Handler / │──▶│ ExecutionCoordinator  │──▶│   RuntimeExecutor      │ │
│  │  HTTP Chat    │   │ (serial/parallel/     │   │   (agentic loop)       │ │
│  │               │   │  preemptive queue)    │   │                        │ │
│  └───────────────┘   └──────────────────────┘   └───────────┬────────────┘ │
│                                                              │              │
│                                                              ▼              │
│                      ┌──────────────────────────────────────────────┐       │
│                      │          RoutingExecutor                      │       │
│                      │                                              │       │
│                      │  handleHandoff()  ◄── NEW: acquireThreadLock │       │
│                      │  handleDelegate()     releaseThreadLock      │       │
│                      │  handleFanOut()       participationGraph     │       │
│                      │  handleComplete()     data namespace merge   │       │
│                      └──────────────────┬───────────────────────────┘       │
│                                         │                                   │
│            ┌────────────────────────────┼──────────────────────┐            │
│            ▼                            ▼                      ▼            │
│  ┌──────────────────┐   ┌──────────────────────┐  ┌────────────────────┐   │
│  │  SessionService  │   │  FanOutBarrierStore   │  │  SessionStateRepo  │   │
│  │  (thread locks,  │   │  (branch results,     │  │  (cold storage,    │   │
│  │   namespace      │   │   partial recovery)   │  │   thread edges)    │   │
│  │   merge, CRUD)   │   │                       │  │                    │   │
│  └────────┬─────────┘   └──────────┬────────────┘  └────────┬───────────┘   │
│           │                        │                         │              │
└───────────┼────────────────────────┼─────────────────────────┼──────────────┘
            │                        │                         │
            ▼                        ▼                         ▼
   ┌─────────────────┐     ┌─────────────────┐      ┌─────────────────┐
   │      Redis      │     │      Redis      │      │     MongoDB     │
   │  sess:{tid}:{id}│     │  barrier:{bid}  │      │  session_states │
   │  thread locks   │     │  branch results │      │  sessions       │
   └─────────────────┘     └─────────────────┘      └─────────────────┘
```

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    SessionStore Interface                     │
│  acquireLock()          ◄── existing                        │
│  acquireThreadLock()    ◄── NEW (FR-1)                      │
│  releaseThreadLock()    ◄── NEW (FR-1)                      │
│  create/load/save       ◄── existing                        │
│  setAgentRegistry       ◄── existing                        │
└────────────┬────────────────────────┬───────────────────────┘
             │                        │
    ┌────────▼───────────┐   ┌───────▼──────────────┐
    │ RedisSessionStore  │   │ MemorySessionStore    │
    │                    │   │                       │
    │ Redis key layout:  │   │ In-memory Map with    │
    │ lock:thread:{tid}: │   │ per-thread TTL-based  │
    │   {sid}:{idx}      │   │ lock entries           │
    └────────────────────┘   └───────────────────────┘

┌────────────────────────────────────────────────────────────┐
│              Thread Data Namespace Layer (FR-2/3)           │
│                                                            │
│  mergeThreadDataValues(session) → Record<string, unknown>  │
│    - Iterates all threads, merges dataValues               │
│    - Active thread takes precedence on key conflicts       │
│    - Pure function, no side effects                        │
│                                                            │
│  applyDataMapping(parentThread, childThread, mapping)      │
│    - Copies only mapped keys from parent to child          │
│    - Records sharedFromParent / sharedToChildren           │
│                                                            │
│  restrictReturnData(childThread, parentThread)             │
│    - On return, merges only shared keys back to parent     │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│            Participation Graph Recorder (FR-5)              │
│                                                            │
│  addNode(session, agentName, threadIndex)                  │
│  addEdge(session, from, to, type, dataKeys)                │
│  getGraph(session) → { nodes, edges }                      │
│                                                            │
│  Persisted via:                                            │
│    MongoDB Session.participationGraph (embedded doc)        │
│    $push for append-only writes                            │
└────────────────────────────────────────────────────────────┘
```

### Data Flow

#### Handoff with Thread Locking and Data Namespace (FR-1, FR-2, FR-3, FR-9)

```
1. User sends message → ExecutionCoordinator queues execution
2. RuntimeExecutor enters agentic loop → LLM decides HANDOFF to Agent B
3. RoutingExecutor.handleHandoff() invoked:
   a. acquireThreadLock(sessionId, activeThreadIndex) → Redis SET NX PX
   b. If lock fails → structured error, message re-queued
   c. Read HandoffConfig.data_mapping from Agent A's IR
   d. Create child thread (Agent B) via createThread():
      - Copy only mapped keys from parent thread's dataValues
      - Record sharedFromParent on child thread
      - Record sharedToChildren on parent thread
   e. Push parent threadIndex onto threadStack
   f. Set activeThreadIndex to new child thread
   g. Record participation graph edge: { from: "A", to: "B", type: "handoff" }
   h. Record participation graph node for Agent B
   i. releaseThreadLock(sessionId, previousActiveThreadIndex)
4. SessionService.save(session) → Redis atomic save via LUA_SAVE
5. TieredSessionStore persists to cold storage (fire-and-forget)
6. RuntimeExecutor continues agentic loop with Agent B's IR
```

#### Fan-Out with Partial Recovery (FR-4, FR-10)

```
1. Supervisor agent's LLM calls fan_out tool with tasks
2. RoutingExecutor.handleFanOut():
   a. Create FanOutBarrier with resultTtlMs = sessionTtl * FANOUT_RESULT_TTL_MULTIPLIER
   b. For each task: create child thread, spawn InProcessExecutionRuntime
   c. Each child executes independently with its own timeout
3. As branches complete:
   a. FanOutBarrierStore.completeBranch() — atomic Lua: store result, increment counter
   b. Branch result TTL set independently of barrier TTL (2x session TTL)
4. When all branches complete (or parent timeout):
   a. RoutingExecutor collects available results from barrier
   b. Missing branches treated as { status: "timeout" } errors
   c. Parent thread resumes with partial results
   d. Participation graph records fan_out edges for each branch
5. If parent session expires before all branches:
   a. Completed branch results persist in Redis (extended TTL)
   b. On session restore (cold → hot), barrier results still retrievable
```

### Sequence Diagram — Handoff with Thread Lock

```
Client          ExecutionCoordinator    RoutingExecutor      RedisSessionStore    Redis
  │                    │                     │                      │               │
  │  send_message      │                     │                      │               │
  │───────────────────▶│                     │                      │               │
  │                    │  executeMessage()    │                      │               │
  │                    │────────────────────▶ │                      │               │
  │                    │                     │ LLM → HANDOFF         │               │
  │                    │                     │                      │               │
  │                    │                     │ acquireThreadLock(    │               │
  │                    │                     │   sid, threadIdx)     │               │
  │                    │                     │─────────────────────▶│               │
  │                    │                     │                      │ SET NX PX     │
  │                    │                     │                      │──────────────▶│
  │                    │                     │                      │     OK        │
  │                    │                     │                      │◀──────────────│
  │                    │                     │  lock acquired        │               │
  │                    │                     │◀─────────────────────│               │
  │                    │                     │                      │               │
  │                    │                     │ createThread(B)       │               │
  │                    │                     │ applyDataMapping()    │               │
  │                    │                     │ recordGraphEdge()     │               │
  │                    │                     │ switchActiveThread()  │               │
  │                    │                     │                      │               │
  │                    │                     │ releaseThreadLock(    │               │
  │                    │                     │   sid, threadIdx)     │               │
  │                    │                     │─────────────────────▶│               │
  │                    │                     │                      │ DEL lock key  │
  │                    │                     │                      │──────────────▶│
  │                    │                     │                      │               │
  │                    │                     │ continue with B's IR  │               │
  │                    │◀────────────────────│                      │               │
  │  agent_response    │                     │                      │               │
  │◀───────────────────│                     │                      │               │
```

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern              | Design Decision                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation** | Thread lock keys include `tenantId` via the session key prefix: `lock:thread:{tenantId}:{sessionId}:{threadIndex}`. All MongoDB queries for participation graph include `tenantId` in the filter (`findOne({ _id, tenantId })`). Cross-tenant access returns 404 via `tenantIsolationPlugin`. No tenant data leaks through thread boundaries.        |
| 2   | **Data Access**      | Thread locks: direct Redis `SET NX PX` (no repository layer — simple atomic primitive). Session data: existing `SessionStore` interface + `SessionService` layer. Participation graph: embedded subdocument on `Session` model (append-only via `$push`). Cold storage: existing `SessionStateRepo` with behavioral fix to populate existing fields. |
| 3   | **API Contract**     | New endpoint: `GET /api/runtime/sessions/:id/participation-graph` returns `{ nodes: IParticipationNode[], edges: IParticipationEdge[] }`. Error envelope: `{ success: false, error: { code: "SESSION_NOT_FOUND", message: "..." } }`. No breaking changes to existing session APIs — `participationGraph` is an additive nullable field.             |
| 4   | **Security Surface** | Thread lock keys use UUIDv7 session IDs (not enumerable). Data mapping is defined in compiled IR (not user input) — no injection risk. Participation graph contains no PII (agent names and metadata only). New API endpoint uses existing `requireAuth` + `tenantIsolationPlugin`. Input validation via Zod: `sessionId: z.string().min(1)`.        |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Thread lock acquisition failure: returns structured `AppError` with code `THREAD_LOCK_CONTENTION`, HTTP 409 Conflict. Fan-out partial failure: parent receives `{ results: [...], failedCount: N }` — not an error, a partial success. Cold restore failure: log warning, return null (session is lost — same as current behavior).            |
| 6   | **Failure Modes** | Redis down: thread lock acquisition throws (not silently succeeds) — `RoutingExecutor` catches and falls back to session-level lock. MongoDB down: participation graph write fails silently (fire-and-forget, logged). Fan-out branch timeout: branch result set to `{ status: "timeout" }`, does not block other branches.                    |
| 7   | **Idempotency**   | Thread lock is naturally idempotent (SET NX — second call returns false). Participation graph `$push` is not idempotent — guard with an edge `id` or `timestamp` dedup window. Fan-out barrier `completeBranch` Lua script is idempotent (incrementing past totalBranches is harmless; result key overwrite is safe).                          |
| 8   | **Observability** | New trace events: `thread_lock_acquired`, `thread_lock_released`, `thread_lock_contention`, `thread_data_mapped`, `participation_graph_updated`. Existing events enriched with `threadIndex`. Participation graph queryable via new API for debugging. All events emitted via `emitDecisionEvent()` in `trace-helpers.ts` — no ad-hoc logging. |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Thread lock: <2ms p99 (1 Redis SET NX PX round-trip). Data namespace merge: <1ms for 10 threads x 100 keys (O(n\*k) where n=threads, k=keys). Participation graph `$push`: <5ms p99 (single MongoDB atomic update). Cold storage: <100ms for 5-thread session (existing gzip/gunzip + network). Total overhead per handoff: <10ms added latency.                                                |
| 10  | **Migration Path**     | Phase 1: Feature flag `MULTI_AGENT_SESSION_V2=false` (default). Existing sessions work unchanged. Phase 2: Enable flag in staging. New sessions use thread locks and namespaces. Existing sessions continue with session-level lock (no migration needed — flag checked at handoff time). Phase 3: Enable in production. Phase 4: Remove flag after validation period (code cleanup).           |
| 11  | **Rollback Plan**      | Disable `MULTI_AGENT_SESSION_V2` flag → reverts to session-level locking and flat dataValues. Thread lock Redis keys expire naturally (5s TTL). Participation graph field is nullable — existing code ignores it. No MongoDB migration to rollback. Fan-out result TTL extension is harmless — results expire naturally. Total rollback time: config change + restart (0 data migration).       |
| 12  | **Test Strategy**      | Unit: 8 scenarios covering lock key format, merge computation, graph node/edge creation, feature flag guard. Integration: 7 scenarios against real Redis and MongoDB (lock lifecycle, barrier timeouts, graph persistence, cold storage edges). E2E: 7 scenarios via HTTP API against real runtime server (handoff isolation, concurrent handoff, fan-out recovery, graph API, cold roundtrip). |

## 5. Data Model

### New Fields on Existing Collections

#### Session (MongoDB — `packages/database/src/models/session.model.ts`)

```typescript
// New embedded subdocuments added to Session schema
const ParticipationNodeSchema = new Schema(
  {
    agentName: { type: String, required: true },
    threadIndex: { type: Number, required: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    status: {
      type: String,
      required: true,
      enum: ["active", "waiting", "completed", "escalated"],
    },
    outcome: { type: String, default: null },
  },
  { _id: false },
);

const ParticipationEdgeSchema = new Schema(
  {
    fromAgent: { type: String, required: true },
    toAgent: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ["handoff", "delegate", "fan_out", "return"],
    },
    timestamp: { type: Date, required: true },
    dataKeys: { type: [String], default: [] },
  },
  { _id: false },
);

// Added to SessionSchema:
participationGraph: {
  type: {
    nodes: { type: [ParticipationNodeSchema], default: [] },
    edges: { type: [ParticipationEdgeSchema], default: [] },
  },
  default: null, // nullable — existing sessions have no graph
}
```

**New Index**:

```javascript
SessionSchema.index({
  tenantId: 1,
  'participationGraph.nodes.agentName': 1,
  startedAt: -1,
});
```

#### AgentThreadData (Redis — `apps/runtime/src/services/session/types.ts`)

```typescript
// Two new optional fields:
sharedFromParent?: string[];  // Keys received from parent thread via data_mapping
sharedToChildren?: string[];  // Keys shared to child threads via data_mapping
```

### New Redis Keys

```
lock:thread:{tenantId}:{sessionId}:{threadIndex}   STRING   Per-thread execution lock (configurable TTL, default 5s)
```

### Modified Behavior (No Schema Changes)

- `SessionStateRepo.upsert()`: Now populates `handoffFrom`, `parentThreadId`, `forkPoint` fields on `ISessionStateThread` (fields already exist in schema but were not always written)
- `FanOutBarrierStore.create()`: Accepts new `resultTtlMs` parameter; branch result keys use `resultTtlMs` instead of barrier TTL
- `SessionData.dataValues`: Becomes a computed merge of all thread namespaces (behavioral change only)

### Key Relationships

```
Session (MongoDB)
  └── participationGraph (embedded)
       ├── nodes[] ──ref──▶ AgentThreadData.agentName
       └── edges[] ──ref──▶ node pairs (fromAgent, toAgent)

SessionData (Redis)
  ├── threads[]
  │    ├── dataValues (isolated per thread)
  │    ├── sharedFromParent → parent thread's sharedToChildren
  │    └── handoffFrom → parent thread's agentName
  └── dataValues (computed merge of all threads)

FanOutBarrier (Redis)
  ├── barrier:{barrierId} → parentSessionId
  └── barrier:{barrierId}:result:{agent} → BranchResult (extended TTL)
```

## 6. API Design

### New Endpoints

| Method | Path                                            | Purpose                            | Auth                                    |
| ------ | ----------------------------------------------- | ---------------------------------- | --------------------------------------- |
| GET    | `/api/runtime/sessions/:id/participation-graph` | Retrieve agent participation graph | `requireAuth` + `tenantIsolationPlugin` |

### Request/Response

**GET /api/runtime/sessions/:id/participation-graph**

Request:

```
GET /api/runtime/sessions/01912345-abcd-7000-8000-000000000001/participation-graph
Authorization: Bearer <token>
```

Success Response (200):

```json
{
  "success": true,
  "data": {
    "nodes": [
      {
        "agentName": "Entry_Agent",
        "threadIndex": 0,
        "startedAt": "2026-03-23T10:00:00.000Z",
        "endedAt": null,
        "status": "active",
        "outcome": null
      },
      {
        "agentName": "Billing_Agent",
        "threadIndex": 1,
        "startedAt": "2026-03-23T10:00:05.000Z",
        "endedAt": "2026-03-23T10:01:00.000Z",
        "status": "completed",
        "outcome": "success"
      }
    ],
    "edges": [
      {
        "fromAgent": "Entry_Agent",
        "toAgent": "Billing_Agent",
        "type": "handoff",
        "timestamp": "2026-03-23T10:00:05.000Z",
        "dataKeys": ["orderNumber"]
      }
    ]
  }
}
```

Error Responses:

| Status | Code                | Message                                       |
| ------ | ------------------- | --------------------------------------------- |
| 401    | `UNAUTHORIZED`      | Missing or invalid auth token                 |
| 404    | `SESSION_NOT_FOUND` | Session not found (or cross-tenant)           |
| 404    | `NO_GRAPH`          | Session exists but has no participation graph |

### Modified Endpoints

**GET /api/runtime/sessions/:id** — Additive change: response now includes `participationGraph` field (nullable). Existing consumers that do not read this field are unaffected.

### Error Responses (Thread Lock)

When a handoff fails due to thread lock contention (WebSocket/REST):

```json
{
  "type": "error",
  "data": {
    "code": "THREAD_LOCK_CONTENTION",
    "message": "Another operation is modifying this thread. Message has been queued.",
    "retryable": true
  }
}
```

## 7. Cross-Cutting Concerns

- **Audit Logging**: Handoff transitions emit `handoff` trace event (existing). New events: `thread_lock_acquired`, `thread_lock_released`, `thread_lock_contention`, `thread_data_mapped`, `participation_graph_updated`. All events include `tenantId`, `sessionId`, `threadIndex`.

- **Rate Limiting**: No new rate limits. Thread lock TTL (default 5s) acts as a natural backpressure mechanism — at most 1 handoff per 5s per thread. The `ExecutionCoordinator` already rate-limits per-session message processing.

- **Caching**: Thread lock keys are not cached (ephemeral by design). Participation graph is embedded in Session (no separate cache). Session data caching unchanged (Redis L1, pod-local L2 for IR).

- **Encryption**: Thread `dataValues` are encrypted at rest via the existing `SessionStateRepo` `encryptionPlugin` on `stateData` Buffer. Redis session data uses the existing `EncryptionService` integration in `RedisSessionStore`. Thread lock keys contain no sensitive data (only session ID and index).

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                    | Type    | Risk                                                               |
| ----------------------------- | ------- | ------------------------------------------------------------------ |
| Redis 7.2+                    | Infra   | LOW — already deployed for session store                           |
| MongoDB 7.0+                  | Infra   | LOW — already deployed for Session model                           |
| `@abl/compiler` HandoffConfig | Package | LOW — consuming existing `data_mapping` field, no changes needed   |
| `@agent-platform/execution`   | Package | MEDIUM — modifying `createChildSession()` and `FanOutBarrierStore` |
| `@agent-platform/shared-auth` | Package | LOW — reusing existing `requireAuth` middleware                    |

### Downstream (depends on this feature)

| Consumer                      | Impact                                                      |
| ----------------------------- | ----------------------------------------------------------- |
| Studio Session Detail Page    | New "Agent Timeline" tab consumes participation graph API   |
| Agent Observability (RFC-015) | Participation graph data feeds session-level metrics        |
| A2A Protocol (RFC-014)        | Remote fan-out branches record edges in local session graph |
| Analytics Pipeline            | Custom dimensions can reference agent participation data    |

## 9. Open Questions & Decisions Needed

1. **Thread lock vs session lock**: The current `lock:exec:{tenantId}:{sessionId}` session-level lock may be sufficient if handoff transitions are fast (<5ms). Thread-level locks add granularity at the cost of complexity. **Recommendation**: Implement thread-level locks but measure actual contention rates in staging before deciding to keep them.

2. **Participation graph storage limit**: With embedded subdocuments, a session with 100+ handoffs could have a large graph. Options: (a) cap at 100 nodes with LRU eviction, (b) move to a separate collection when graph exceeds threshold, (c) compress graph data. **Recommendation**: Cap at 100 nodes (document this limit) and log a warning if exceeded.

3. **Data namespace migration for existing sessions**: When `MULTI_AGENT_SESSION_V2` is enabled, existing sessions have flat `dataValues`. Three options: (a) treat existing sessions as single-thread namespace (no migration), (b) split on next load based on thread boundaries, (c) dual-mode until session ends. **Recommendation**: Option (a) — existing sessions treated as single-thread namespace, new sessions get per-thread namespaces.

4. **Fan-out result TTL vs durability**: Extended Redis TTL (2x session TTL) still loses data on Redis restart. Should we also write branch results to MongoDB? **Recommendation**: Keep Redis-only for Phase 1 (simplicity), add MongoDB backup in Phase 2 if Redis reliability is insufficient.

5. **Participation graph write consistency**: Should graph writes be synchronous (blocking handoff until MongoDB write succeeds) or fire-and-forget? **Recommendation**: Fire-and-forget with retry queue (same pattern as `SessionStateRepo` cold writes). Graph is observability data, not execution-critical.

## 10. References

- Feature spec: `docs/features/multi-agent-session-management.md`
- Test spec: `docs/testing/multi-agent-session-management.md`
- RFC-003: Threaded Sessions and Memory — `docs/rfcs/RFC-003-threaded-sessions-memory.md`
- RFC-014: Agent Transfer and A2A — `docs/rfcs/RFC-014-agent-transfer-a2a.md`
- Runtime Architecture: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Session types: `apps/runtime/src/services/session/types.ts`
- Session store interface: `apps/runtime/src/services/session/session-store.ts`
- Redis session store: `apps/runtime/src/services/session/redis-session-store.ts`
- Routing executor: `apps/runtime/src/services/execution/routing-executor.ts`
- Execution types: `apps/runtime/src/services/execution/types.ts`
- Fan-out barrier: `packages/execution/src/fan-out-barrier.ts`
- Redis fan-out barrier: `packages/execution/src/redis-fan-out-barrier.ts`
- Child session: `packages/execution/src/child-session.ts`
- Session model: `packages/database/src/models/session.model.ts`
- Session state model: `packages/database/src/models/session-state.model.ts`
