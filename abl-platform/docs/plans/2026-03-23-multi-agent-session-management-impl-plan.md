# LLD: Multi-Agent Session Management

**Feature Spec**: `docs/features/multi-agent-session-management.md`
**HLD**: `docs/specs/multi-agent-session-management.hld.md`
**Test Spec**: `docs/testing/multi-agent-session-management.md`
**Status**: DRAFT
**Date**: 2026-03-23

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                   | Rationale                                                                                                  | Alternatives Rejected                                 |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| D-1 | Thread lock via Redis `SET NX PX`          | Matches existing session lock pattern in `RedisSessionStore`. 1 round-trip. Atomic. TTL prevents deadlock. | Lua-script lock (over-engineered for simple mutex)    |
| D-2 | Data namespace merge as pure function      | No side effects, testable in isolation, called on session read. Active thread wins on key conflicts.       | Write-time merge (hard to undo, couples write path)   |
| D-3 | Participation graph as embedded subdoc     | Append-only via `$push`, no joins, single-document read. Capped at 100 nodes.                              | Separate collection (adds joins, complicates queries) |
| D-4 | Feature flag `MULTI_AGENT_SESSION_V2`      | Zero-downtime rollout, existing sessions unaffected. Checked at handoff time, not session creation.        | DB-backed feature flag (adds latency per handoff)     |
| D-5 | Fan-out result TTL = 2x session TTL        | Ensures results survive parent session expiry. No MongoDB backup in Phase 1.                               | MongoDB backup (adds latency, complexity)             |
| D-6 | Cold storage fix is behavioral, not schema | `ISessionStateThread` already has `handoffFrom`, `parentThreadId`, `forkPoint` fields. Just populate them. | Schema migration (unnecessary — fields exist)         |

### Key Interfaces & Types

```typescript
// NEW: Thread lock methods added to SessionStore interface
// File: apps/runtime/src/services/session/session-store.ts
interface SessionStore {
  // ... existing methods ...
  acquireThreadLock(sessionId: string, threadIndex: number, ttlMs?: number): Promise<boolean>;
  releaseThreadLock(sessionId: string, threadIndex: number): Promise<void>;
}

// NEW: Data namespace merge function
// File: apps/runtime/src/services/session/thread-data-namespace.ts
function mergeThreadDataValues(
  threads: AgentThreadData[],
  activeThreadIndex: number,
): Record<string, unknown>;

function applyDataMapping(
  parentThread: AgentThreadData,
  childThread: AgentThreadData,
  mapping: Record<string, string>,
): void;

// NEW: Participation graph types
// File: apps/runtime/src/services/session/participation-graph.ts
interface ParticipationNode {
  agentName: string;
  threadIndex: number;
  startedAt: number;
  endedAt: number | null;
  status: 'active' | 'waiting' | 'completed' | 'escalated';
  outcome: string | null;
}

interface ParticipationEdge {
  fromAgent: string;
  toAgent: string;
  type: 'handoff' | 'delegate' | 'fan_out' | 'return';
  timestamp: number;
  dataKeys: string[];
}

interface ParticipationGraph {
  nodes: ParticipationNode[];
  edges: ParticipationEdge[];
}

// MODIFIED: AgentThreadData gains optional tracking fields
// File: apps/runtime/src/services/session/types.ts
interface AgentThreadData {
  // ... existing fields ...
  sharedFromParent?: string[];
  sharedToChildren?: string[];
}
```

### Module Boundaries

| Module                     | Responsibility                                        | Depends On                                                               |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `thread-data-namespace.ts` | Pure merge/mapping functions for thread data          | `types.ts` (AgentThreadData)                                             |
| `participation-graph.ts`   | Graph construction helpers + MongoDB persistence      | `types.ts`, `session.model.ts`                                           |
| `session-store.ts`         | Interface extension for thread locks                  | None (interface only)                                                    |
| `redis-session-store.ts`   | Redis implementation of thread locks                  | `ioredis`                                                                |
| `memory-session-store.ts`  | In-memory implementation of thread locks              | None                                                                     |
| `routing-executor.ts`      | Wires thread locks into handoff/delegate/fan-out      | `session-store.ts`, `thread-data-namespace.ts`, `participation-graph.ts` |
| `session-state-repo.ts`    | Behavioral fix: populate existing cold storage fields | `session-state.model.ts`                                                 |
| `sessions.ts` (route)      | New participation graph API endpoint                  | `session.model.ts`, `participation-graph.ts`                             |

## 2. File-Level Change Map

### New Files

| File                                                                           | Purpose                                      | LOC Estimate |
| ------------------------------------------------------------------------------ | -------------------------------------------- | ------------ |
| `apps/runtime/src/services/session/thread-data-namespace.ts`                   | Pure functions for data merge/mapping        | ~120         |
| `apps/runtime/src/services/session/participation-graph.ts`                     | Graph builder + MongoDB persistence          | ~150         |
| `apps/runtime/src/__tests__/multi-agent-thread-lock.test.ts`                   | Unit tests for lock key format/guards        | ~100         |
| `apps/runtime/src/__tests__/multi-agent-data-namespace.test.ts`                | Unit tests for merge/mapping logic           | ~150         |
| `apps/runtime/src/__tests__/multi-agent-participation-graph.test.ts`           | Unit tests for graph node/edge creation      | ~80          |
| `apps/runtime/src/__tests__/multi-agent-thread-lock-redis.integration.test.ts` | Integration tests for Redis locks            | ~120         |
| `apps/runtime/src/__tests__/multi-agent-cold-storage.integration.test.ts`      | Integration tests for cold edge preservation | ~100         |

### Modified Files

| File                                                        | Change Description                                                | Risk |
| ----------------------------------------------------------- | ----------------------------------------------------------------- | ---- |
| `apps/runtime/src/services/session/session-store.ts`        | Add `acquireThreadLock`, `releaseThreadLock` to interface         | Low  |
| `apps/runtime/src/services/session/redis-session-store.ts`  | Implement thread lock with `SET NX PX`, `DEL`                     | Low  |
| `apps/runtime/src/services/session/memory-session-store.ts` | Implement thread lock with in-memory Map + TTL                    | Low  |
| `apps/runtime/src/services/session/types.ts`                | Add `sharedFromParent`, `sharedToChildren` to `AgentThreadData`   | Low  |
| `apps/runtime/src/services/execution/types.ts`              | Wire `applyDataMapping` into `createThread()` options             | Med  |
| `apps/runtime/src/services/execution/routing-executor.ts`   | Add thread lock acquire/release in handoff/delegate/fan-out paths | High |
| `apps/runtime/src/services/session/session-state-repo.ts`   | Populate `handoffFrom`, `parentThreadId`, `forkPoint` on upsert   | Low  |
| `packages/execution/src/fan-out-barrier.ts`                 | Add `resultTtlMs` to `create()` params                            | Low  |
| `packages/execution/src/redis-fan-out-barrier.ts`           | Use `resultTtlMs` for branch result key TTL                       | Low  |
| `packages/database/src/models/session.model.ts`             | Add `participationGraph` embedded subdocument + index             | Med  |
| `apps/runtime/src/routes/sessions.ts`                       | Add `GET /:id/participation-graph` route                          | Low  |
| `apps/runtime/src/services/session/tiered-session-store.ts` | Delegate thread lock methods to primary store                     | Low  |

## 3. Implementation Phases

### Phase 1: Thread-Level Locking Infrastructure (FR-1, FR-9)

**Goal**: Add per-thread execution locks to the SessionStore interface and both implementations.

**Tasks**:

1.1. Add `acquireThreadLock(sessionId: string, threadIndex: number, ttlMs?: number): Promise<boolean>` and `releaseThreadLock(sessionId: string, threadIndex: number): Promise<void>` to the `SessionStore` interface in `apps/runtime/src/services/session/session-store.ts`.

1.2. Implement `acquireThreadLock` in `RedisSessionStore`: Redis `SET lock:thread:{tenantId}:{sessionId}:{threadIndex} NX PX {ttlMs}`. Implement `releaseThreadLock`: Redis `DEL lock:thread:{tenantId}:{sessionId}:{threadIndex}`. Use the existing `tenantId` resolution pattern from `acquireLock()`.

1.3. Implement `acquireThreadLock` in `MemorySessionStore`: Use an in-memory `Map<string, { expiresAt: number }>` with key format `${sessionId}:${threadIndex}`. Check TTL expiry on acquire. Implement `releaseThreadLock`: Delete from map.

1.4. Delegate `acquireThreadLock` / `releaseThreadLock` in `TieredSessionStore` to `this.primary` (same pattern as existing `acquireLock` delegation).

1.5. Add `threadLockTtlMs` to `SessionConfig` with default equal to `lockTtlMs` (5000ms). Add `THREAD_LOCK_TTL_MS` env var to config loader.

1.6. Write unit tests in `multi-agent-thread-lock.test.ts`: lock key format verification, feature flag guard (V2 disabled = no thread lock), TTL expiry behavior for MemorySessionStore.

1.7. Write integration tests in `multi-agent-thread-lock-redis.integration.test.ts`: acquire/release/contention/expiry against real Redis.

**Files Touched**:

- `apps/runtime/src/services/session/session-store.ts` — Add 2 methods to interface
- `apps/runtime/src/services/session/redis-session-store.ts` — Implement 2 methods (~30 LOC)
- `apps/runtime/src/services/session/memory-session-store.ts` — Implement 2 methods (~40 LOC)
- `apps/runtime/src/services/session/tiered-session-store.ts` — Delegate 2 methods (~10 LOC)
- `apps/runtime/src/services/session/types.ts` — Add `threadLockTtlMs` to `SessionConfig`
- `apps/runtime/src/__tests__/multi-agent-thread-lock.test.ts` — New test file
- `apps/runtime/src/__tests__/multi-agent-thread-lock-redis.integration.test.ts` — New test file

**Exit Criteria**:

- [ ] `SessionStore` interface has `acquireThreadLock` and `releaseThreadLock` methods
- [ ] `RedisSessionStore` implementation passes: acquire returns true, second acquire returns false, release enables re-acquire, TTL expiry enables re-acquire
- [ ] `MemorySessionStore` has identical behavior
- [ ] `TieredSessionStore` delegates correctly
- [ ] `pnpm build --filter=@abl/runtime` succeeds with 0 type errors
- [ ] All unit tests in `multi-agent-thread-lock.test.ts` pass
- [ ] All integration tests in `multi-agent-thread-lock-redis.integration.test.ts` pass (requires Redis)

**Test Strategy**:

- Unit: Lock key format, feature flag guard, MemorySessionStore lock lifecycle
- Integration: RedisSessionStore lock acquire/release/contention/expiry against real Redis

**Rollback**: Remove `acquireThreadLock`/`releaseThreadLock` from interface and implementations. No callers yet (wired in Phase 2).

---

### Phase 2: Thread Data Namespacing (FR-2, FR-3, FR-8)

**Goal**: Enforce per-thread data isolation and explicit data sharing via handoff config.

**Tasks**:

2.1. Create `apps/runtime/src/services/session/thread-data-namespace.ts` with:

- `mergeThreadDataValues(threads: AgentThreadData[], activeThreadIndex: number): Record<string, unknown>` — iterates all threads, merges `dataValues`, active thread wins on conflict.
- `applyDataMapping(parentData: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown>` — returns a new object with only the mapped keys from parentData.
- `restrictReturnData(childThread: AgentThreadData, parentThread: AgentThreadData, handoffConfig?: HandoffConfig): void` — on thread return, copies only shared keys back to parent.

  2.2. Add `sharedFromParent?: string[]` and `sharedToChildren?: string[]` to `AgentThreadData` in `apps/runtime/src/services/session/types.ts`.

  2.3. Modify `createThread()` in `apps/runtime/src/services/execution/types.ts`:

- Add optional `dataMapping?: Record<string, string>` to options parameter.
- When `dataMapping` is provided and feature flag is enabled: use `applyDataMapping()` to populate child thread's `initialData` with only mapped keys. Set `sharedFromParent` on child thread. Set `sharedToChildren` on parent thread.
- When feature flag is disabled: maintain existing behavior (copy all parent data).

  2.4. Modify `syncThreadToSession()` in `apps/runtime/src/services/execution/types.ts`:

- When feature flag is enabled: compute session-level `dataValues` via `mergeThreadDataValues()` instead of copying from active thread.
- When feature flag is disabled: maintain existing behavior.

  2.5. Modify `tryThreadReturn()` in `apps/runtime/src/services/execution/types.ts`:

- When feature flag is enabled: use `restrictReturnData()` to merge only explicitly shared data back to parent thread.
- When feature flag is disabled: maintain existing behavior.

  2.6. Write unit tests in `multi-agent-data-namespace.test.ts`: empty threads merge, single thread merge, multi-thread merge with conflict resolution, data mapping application, return data restriction.

**Files Touched**:

- `apps/runtime/src/services/session/thread-data-namespace.ts` — New file (~120 LOC)
- `apps/runtime/src/services/session/types.ts` — Add 2 fields to `AgentThreadData`
- `apps/runtime/src/services/execution/types.ts` — Modify `createThread()`, `syncThreadToSession()`, `tryThreadReturn()`
- `apps/runtime/src/__tests__/multi-agent-data-namespace.test.ts` — New test file

**Exit Criteria**:

- [ ] `mergeThreadDataValues()` returns correct merge with active thread precedence
- [ ] `applyDataMapping()` copies only mapped keys
- [ ] `createThread()` with `dataMapping` option populates child thread with only mapped keys
- [ ] `syncThreadToSession()` uses merge function when V2 enabled
- [ ] `tryThreadReturn()` restricts returned data when V2 enabled
- [ ] Existing tests in `apps/runtime` continue to pass (backward compatible when V2 disabled)
- [ ] `pnpm build --filter=@abl/runtime` succeeds with 0 type errors
- [ ] All unit tests in `multi-agent-data-namespace.test.ts` pass

**Test Strategy**:

- Unit: All merge/mapping/restrict functions. Feature flag on/off paths. Edge cases (empty threads, 0 keys, overlapping keys).

**Rollback**: Revert `createThread()`, `syncThreadToSession()`, `tryThreadReturn()` changes. Delete `thread-data-namespace.ts`. Feature flag disabled = no behavioral change.

---

### Phase 3: Wire Thread Locks into Routing Executor (FR-1, FR-9)

**Goal**: RoutingExecutor acquires/releases thread locks during handoff, delegate, and fan-out operations.

**Tasks**:

3.1. In `RoutingExecutor.handleHandoff()` (line ~1600 in `routing-executor.ts`):

- Before creating child thread: `await store.acquireThreadLock(session.id, session.activeThreadIndex, config.threadLockTtlMs)`.
- If lock fails: throw `AppError` with code `THREAD_LOCK_CONTENTION`.
- After switching `activeThreadIndex` and calling `syncThreadToSession()`: `await store.releaseThreadLock(session.id, previousThreadIndex)`.
- Wrap in try/finally to ensure lock release on error.

  3.2. In `RoutingExecutor.handleDelegate()` (line ~1932):

- Same lock acquisition pattern as handoff.
- Lock released after delegate completes and `tryThreadReturn()` is called.

  3.3. In `RoutingExecutor.handleFanOut()` (line ~2507):

- Acquire lock on parent thread before creating child threads.
- Release after all child threads created and fan-out dispatched.
- Child threads do not need their own locks (they execute in parallel isolation via `InProcessExecutionRuntime`).

  3.4. Add lock-related trace events via `emitDecisionEvent()`:

- `thread_lock_acquired`: `{ sessionId, threadIndex, agentName }`
- `thread_lock_released`: `{ sessionId, threadIndex, agentName }`
- `thread_lock_contention`: `{ sessionId, threadIndex, agentName, waitMs }`

  3.5. Wire `HandoffConfig.data_mapping` into the `createThread()` call in `handleHandoff()`: pass `dataMapping: handoffConfig.data_mapping` as option.

  3.6. Guard all new logic with feature flag check: `if (process.env.MULTI_AGENT_SESSION_V2 === 'true')`. When disabled, maintain existing session-level lock behavior.

**Files Touched**:

- `apps/runtime/src/services/execution/routing-executor.ts` — Modify `handleHandoff()`, `handleDelegate()`, `handleFanOut()` (~80 LOC added)
- `apps/runtime/src/services/execution/trace-helpers.ts` — Add 3 trace event types

**Exit Criteria**:

- [ ] `handleHandoff()` acquires thread lock before mutation, releases after
- [ ] `handleDelegate()` acquires thread lock before mutation, releases after
- [ ] `handleFanOut()` acquires parent thread lock during child creation
- [ ] Lock failure throws `AppError` with code `THREAD_LOCK_CONTENTION`
- [ ] Trace events emitted for lock acquire/release/contention
- [ ] `data_mapping` from `HandoffConfig` wired to `createThread()` options
- [ ] Feature flag guard: V2 disabled uses session-level lock only
- [ ] Existing handoff/delegate/fan-out tests continue to pass
- [ ] `pnpm build --filter=@abl/runtime` succeeds with 0 type errors

**Test Strategy**:

- Unit: Mock `SessionStore` to verify lock method calls in `handleHandoff()`, `handleDelegate()`, `handleFanOut()`
- Integration: Tested in Phase 6 E2E tests

**Rollback**: Revert routing-executor changes. Thread lock infrastructure (Phase 1) remains but is unused.

---

### Phase 4: Participation Graph (FR-5, FR-7)

**Goal**: Record agent participation graph per session and expose via API.

**Tasks**:

4.1. Create `apps/runtime/src/services/session/participation-graph.ts`:

- `createNode(agentName, threadIndex): ParticipationNode`
- `createEdge(from, to, type, dataKeys): ParticipationEdge`
- `appendNodeToSession(sessionId, tenantId, node): Promise<void>` — MongoDB `Session.updateOne({ _id, tenantId }, { $push: { 'participationGraph.nodes': node } })`
- `appendEdgeToSession(sessionId, tenantId, edge): Promise<void>` — MongoDB `$push` for edges
- `getGraph(sessionId, tenantId): Promise<ParticipationGraph | null>` — MongoDB `findOne` + project `participationGraph` field

  4.2. Add `participationGraph` field to `SessionSchema` in `packages/database/src/models/session.model.ts`:

- Embedded `ParticipationNodeSchema` and `ParticipationEdgeSchema` (as defined in HLD)
- Default: `null` (nullable, backward compatible)
- Add compound index: `{ tenantId: 1, 'participationGraph.nodes.agentName': 1, startedAt: -1 }`

  4.3. Wire graph recording into `RoutingExecutor`:

- In `handleHandoff()`: after creating child thread, call `appendNodeToSession()` and `appendEdgeToSession()` (fire-and-forget, catch + log errors)
- In `handleDelegate()`: same pattern
- In `handleFanOut()`: create edge for each fan-out branch
- In `tryThreadReturn()` (via callback): create `return` edge

  4.4. Add route `GET /:id/participation-graph` to `apps/runtime/src/routes/sessions.ts`:

- Use existing auth middleware: `requireAuth`
- Query: `Session.findOne({ _id: id, tenantId }, { participationGraph: 1 })`
- If session not found or no graph: return 404
- Return: `{ success: true, data: participationGraph }`
- Input validation: `z.object({ id: z.string().min(1) })`

  4.5. Initialize participation graph on session creation: in `handleLoadAgent()` or session factory, create initial node for the entry agent.

  4.6. Write unit tests for graph node/edge creation. Write integration test for MongoDB `$push` and tenant isolation.

**Files Touched**:

- `apps/runtime/src/services/session/participation-graph.ts` — New file (~150 LOC)
- `packages/database/src/models/session.model.ts` — Add embedded schemas + field + index (~50 LOC)
- `apps/runtime/src/services/execution/routing-executor.ts` — Add graph recording calls (~30 LOC)
- `apps/runtime/src/routes/sessions.ts` — Add GET route (~40 LOC)
- `apps/runtime/src/__tests__/multi-agent-participation-graph.test.ts` — New test file

**Exit Criteria**:

- [ ] `ParticipationNodeSchema` and `ParticipationEdgeSchema` defined in session model
- [ ] `participationGraph` field added to `SessionSchema` with default `null`
- [ ] Index created for agent-name queries
- [ ] `appendNodeToSession()` and `appendEdgeToSession()` write to MongoDB
- [ ] `GET /:id/participation-graph` returns graph for valid session
- [ ] `GET /:id/participation-graph` returns 404 for cross-tenant access
- [ ] Graph recording wired into `handleHandoff()`, `handleDelegate()`, `handleFanOut()`
- [ ] `pnpm build --filter=@abl/runtime --filter=@agent-platform/database` succeeds
- [ ] Unit and integration tests pass

**Test Strategy**:

- Unit: Graph node/edge creation helpers
- Integration: MongoDB `$push` operations, tenant isolation, index utilization

**Rollback**: Remove `participationGraph` field from schema (nullable — no data migration needed). Remove graph recording from routing executor. Remove API route.

---

### Phase 5: Fan-Out Recovery Enhancement (FR-4, FR-10)

**Goal**: Fan-out branch results survive parent session expiry; branches have independent timeouts.

**Tasks**:

5.1. Add `resultTtlMs?: number` parameter to `FanOutBarrierStore.create()` in `packages/execution/src/fan-out-barrier.ts`.

5.2. In `RedisFanOutBarrierStore.create()` (`packages/execution/src/redis-fan-out-barrier.ts`): use `resultTtlMs` (default: `timeoutMs * 2`) for branch result key TTL in the `LUA_COMPLETE_BRANCH` script ARGV[2].

5.3. In `RedisFanOutBarrierStore.completeBranch()`: pass `resultTtlMs` as EXPIRE duration for branch result keys instead of barrier TTL.

5.4. In `RoutingExecutor.handleFanOut()`: compute `resultTtlMs = sessionTtlMinutes * 60 * 1000 * FANOUT_RESULT_TTL_MULTIPLIER` and pass to `store.create()`.

5.5. Add `FANOUT_RESULT_TTL_MULTIPLIER` env var (default: 2) to config loader.

5.6. In `ResumptionService` (`apps/runtime/src/services/execution/resumption-service.ts`): when resuming a fan-out parent, call `barrier.getResults()` to collect all available results. Treat missing branches as `{ status: "timeout", error: "Branch did not complete within timeout" }`.

**Files Touched**:

- `packages/execution/src/fan-out-barrier.ts` — Add `resultTtlMs` parameter
- `packages/execution/src/redis-fan-out-barrier.ts` — Use `resultTtlMs` for branch result TTL
- `apps/runtime/src/services/execution/routing-executor.ts` — Pass `resultTtlMs` to barrier creation
- `apps/runtime/src/services/execution/resumption-service.ts` — Handle partial results on resume

**Exit Criteria**:

- [ ] `FanOutBarrierStore.create()` accepts `resultTtlMs` parameter
- [ ] Branch result keys have TTL independent of barrier key
- [ ] Branch results persist 2x longer than the barrier by default
- [ ] Resumption service collects partial results without blocking
- [ ] Missing branches treated as timeout errors (not infinite wait)
- [ ] `pnpm build --filter=@agent-platform/execution --filter=@abl/runtime` succeeds
- [ ] Existing fan-out tests continue to pass

**Test Strategy**:

- Unit: Verify `create()` passes correct TTL to Redis
- Integration: Create barrier, complete 2/3 branches, verify results persist after barrier TTL expiry

**Rollback**: Revert `resultTtlMs` parameter. Branch results revert to barrier TTL. No data loss risk.

---

### Phase 6: Cold Storage Thread Edge Fix (FR-6)

**Goal**: SessionStateRepo populates all inter-thread edge fields during cold writes.

**Tasks**:

6.1. Audit `SessionStateRepo.upsert()` in `apps/runtime/src/services/session/session-state-repo.ts`:

- Verify `handoffFrom` is mapped from `AgentThreadData.handoffFrom` in the thread snapshot builder (line ~76).
- Verify `parentThreadId` is computed: if thread `i` has `handoffFrom`, its `parentThreadId` is the index of the previous thread with that `agentName`.
- Verify `forkPoint` is set for fork operations.

  6.2. Fix any missing mappings found in the audit. Expected fix: add `handoffContext` serialization (currently `AgentThreadData.handoffContext` is not persisted to `ISessionStateThread`).

  6.3. In `SessionStateRepo.loadInternal()`: verify `handoffFrom`, `parentThreadId`, `forkPoint` are mapped back from cold storage to `SessionData` thread data.

  6.4. Write integration test: create SessionData with 3 threads with handoff relationships, upsert to cold storage, load back, verify all edge fields match.

**Files Touched**:

- `apps/runtime/src/services/session/session-state-repo.ts` — Fix thread snapshot builder and restore logic (~20 LOC changes)
- `apps/runtime/src/__tests__/multi-agent-cold-storage.integration.test.ts` — New test file

**Exit Criteria**:

- [ ] `upsert()` persists `handoffFrom` for every thread that has it set
- [ ] `upsert()` persists `parentThreadId` where applicable
- [ ] `upsert()` persists `forkPoint` where applicable
- [ ] `loadInternal()` restores all three fields faithfully
- [ ] Round-trip test: upsert → load → compare thread edges passes
- [ ] `pnpm build --filter=@abl/runtime` succeeds

**Test Strategy**:

- Integration: Real MongoDB (MongoMemoryServer). 3-thread session with handoff chain. Upsert → load → deep compare.

**Rollback**: Revert field mapping changes. Cold storage reverts to not populating optional fields (graceful degradation).

## 4. Wiring Checklist

- [ ] `acquireThreadLock` / `releaseThreadLock` added to `SessionStore` interface
- [ ] `RedisSessionStore` implements thread lock methods
- [ ] `MemorySessionStore` implements thread lock methods
- [ ] `TieredSessionStore` delegates thread lock methods to `this.primary`
- [ ] `thread-data-namespace.ts` functions imported in `execution/types.ts`
- [ ] `applyDataMapping()` called from `createThread()` when V2 flag enabled
- [ ] `mergeThreadDataValues()` called from `syncThreadToSession()` when V2 flag enabled
- [ ] `restrictReturnData()` called from `tryThreadReturn()` when V2 flag enabled
- [ ] Thread lock acquire/release called in `RoutingExecutor.handleHandoff()`
- [ ] Thread lock acquire/release called in `RoutingExecutor.handleDelegate()`
- [ ] Thread lock acquire/release called in `RoutingExecutor.handleFanOut()`
- [ ] `participation-graph.ts` functions called from `RoutingExecutor` (fire-and-forget)
- [ ] `ParticipationNodeSchema` and `ParticipationEdgeSchema` registered in `session.model.ts`
- [ ] `GET /:id/participation-graph` route registered in `routes/sessions.ts`
- [ ] Route registered BEFORE parameterized `/:id` routes (Express matching order)
- [ ] `resultTtlMs` parameter added to `FanOutBarrierStore.create()` interface
- [ ] `RedisFanOutBarrierStore` uses `resultTtlMs` for branch result TTL
- [ ] `MULTI_AGENT_SESSION_V2` env var checked in routing executor
- [ ] `THREAD_LOCK_TTL_MS` env var loaded in config
- [ ] `FANOUT_RESULT_TTL_MULTIPLIER` env var loaded in config
- [ ] `PARTICIPATION_GRAPH_ENABLED` env var checked before graph writes

## 5. Cross-Phase Concerns

### Database Migrations

No formal migration scripts needed. All changes are additive:

- `participationGraph` field on Session model has `default: null` — existing documents are unaffected
- `sharedFromParent` / `sharedToChildren` on `AgentThreadData` are optional — existing sessions work unchanged
- New MongoDB index is additive and created at application startup

### Feature Flags

| Flag                           | Default | Phase Introduced | Purpose                                    |
| ------------------------------ | ------- | ---------------- | ------------------------------------------ |
| `MULTI_AGENT_SESSION_V2`       | `false` | Phase 1          | Guards thread locking and data namespacing |
| `PARTICIPATION_GRAPH_ENABLED`  | `true`  | Phase 4          | Guards participation graph recording       |
| `FANOUT_RESULT_TTL_MULTIPLIER` | `2`     | Phase 5          | Controls fan-out result durability         |

### Configuration Changes

| Variable                       | Default | Config File                         | Phase |
| ------------------------------ | ------- | ----------------------------------- | ----- |
| `THREAD_LOCK_TTL_MS`           | `5000`  | `apps/runtime/src/config/loader.ts` | 1     |
| `MULTI_AGENT_SESSION_V2`       | `false` | env var (no config file)            | 1     |
| `PARTICIPATION_GRAPH_ENABLED`  | `true`  | env var                             | 4     |
| `FANOUT_RESULT_TTL_MULTIPLIER` | `2`     | env var                             | 5     |

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 6 phases complete with individual exit criteria met
- [ ] All 10 functional requirements (FR-1 through FR-10) covered by at least one test
- [ ] Unit tests pass: `pnpm test --filter=@abl/runtime` (existing + new)
- [ ] Integration tests pass: thread lock Redis, data namespace, fan-out barrier, participation graph, cold storage
- [ ] No regressions in existing runtime tests (8,861 passing as of last baseline)
- [ ] `pnpm build` succeeds across all packages with 0 type errors
- [ ] Feature flag `MULTI_AGENT_SESSION_V2=false` leaves all behavior unchanged (backward compatibility)
- [ ] Feature flag `MULTI_AGENT_SESSION_V2=true` enables all new behavior
- [ ] Feature spec updated with implementation status
- [ ] Test spec coverage matrix updated with actual test results

## 7. Open Questions

1. **RoutingExecutor handleHandoff line numbers**: The routing executor is ~2800 LOC. Exact insertion points for thread lock calls need to be verified at implementation time by reading the current `handleHandoff()` flow (look for the `createThread()` call and wrap it).

2. **Session-level dataValues backward compatibility**: When V2 is enabled, `syncThreadToSession()` changes the computation of session-level `dataValues`. Need to verify that no code path reads `session.data.values` directly (vs. through the active thread) — grep for all reads of `session.data.values` and `session.dataValues` to confirm.

3. **Participation graph write ordering**: In fan-out scenarios, multiple branches may try to `$push` edges concurrently. MongoDB `$push` is atomic per-document, but the ordering of edges in the array is non-deterministic under concurrency. Tests should verify set membership, not ordering.

4. **Express route ordering for participation-graph**: The `/:id/participation-graph` path must be registered BEFORE `/:id` in the sessions router. Need to verify the route registration order in `routes/sessions.ts` at implementation time.
