# Multi-Agent Session Management

- **Feature ID**: F025
- **Status**: PLANNED
- **Priority**: P0
- **Owner**: Runtime Team
- **Created**: 2026-03-23
- **Last Updated**: 2026-03-23

## 1. Introduction / Overview

### Problem Statement

The ABL Platform supports multi-agent conversations through handoffs, delegates, and fan-out patterns. However, session management for these multi-agent scenarios has several architectural gaps:

1. **Thread-level isolation is incomplete**: When Agent A hands off to Agent B, Agent B's thread shares the parent session's Redis key space. There is no per-thread execution lock, meaning concurrent messages during a handoff transition can corrupt thread state.

2. **Cross-agent data leakage**: The `dataValues` store on `SessionData` (defined in `apps/runtime/src/services/session/types.ts`) is a flat `Record<string, unknown>` shared across all threads. Agent B can read and overwrite Agent A's gathered data without namespace separation.

3. **Fan-out session lifecycle is fragile**: The `FanOutBarrier` in `packages/execution/src/fan-out-barrier.ts` tracks branch completion but has no mechanism for partial result recovery if the parent session expires mid-fan-out. Child sessions created via `createChildSession` in `packages/execution/src/child-session.ts` share thread array references, creating mutation hazards.

4. **No session-level agent topology awareness**: The `Session` model in `packages/database/src/models/session.model.ts` tracks `currentAgent` and `handoffCount` but does not record the agent participation graph (which agents were active, in what order, with what data flow).

5. **Cold storage thread fidelity gaps**: The `SessionStateRepo` in `apps/runtime/src/services/session/session-state-repo.ts` compresses per-thread data independently but loses inter-thread relationships (handoff context, data flow edges) during cold restore.

### Goal Statement

Deliver a robust multi-agent session management layer that provides:

- Thread-level execution isolation with per-thread locking
- Namespaced data stores preventing cross-agent data leakage
- Resilient fan-out lifecycle with partial result recovery
- Agent participation graph tracking for observability
- Full-fidelity cold storage that preserves inter-thread relationships

### Summary

This feature enhances the existing threaded session model (`SessionData.threads[]`, `AgentThreadData`, `RuntimeSession`) to support production-grade multi-agent conversations. It introduces per-thread execution locks, namespaced data stores, a participation graph, fan-out recovery, and cold storage improvements. The changes span `apps/runtime` (session service, execution coordinator, routing executor), `packages/execution` (fan-out barrier, child session), `packages/database` (session models), and `apps/studio` (session detail UI).

## 2. Scope

### Goals

- **G1**: Per-thread execution locks preventing concurrent mutation of a single agent thread during handoff transitions
- **G2**: Namespaced data store (`ThreadDataNamespace`) isolating each agent's gathered data within the session
- **G3**: Controlled data sharing via explicit `SHARE` declarations in handoff config (already partially modeled in `HandoffConfig.data_mapping`)
- **G4**: Fan-out partial result recovery — when a parent session expires or a subset of branches fail, completed results are preserved and actionable
- **G5**: Agent participation graph recorded per-session for observability (which agents participated, transitions, durations, outcomes)
- **G6**: Cold storage fidelity — `SessionStateRepo` preserves inter-thread edges, handoff context, and data flow during MongoDB persistence
- **G7**: Studio session detail page shows multi-agent timeline with thread transitions and data flow

### Non-Goals

- **NG1**: Cross-session agent coordination (e.g., Agent A in Session 1 talking to Agent B in Session 2) — handled by A2A protocol (RFC-014)
- **NG2**: Agent-to-human transfer session management — handled by `@agent-platform/agent-transfer` package
- **NG3**: DSL/IR changes to the HANDOFF/DELEGATE syntax — compiler changes are out of scope; we consume existing IR
- **NG4**: Durable execution runtime (Restate/Temporal) — Phase 3 concern per `packages/execution/src/types.ts`
- **NG5**: Real-time collaborative multi-agent (two agents processing the same message simultaneously) — not a supported pattern

## 3. User Stories

### US-1: Platform Developer — Thread-Safe Handoffs

As a platform developer, I want handoff transitions to be atomic so that when Agent A hands off to Agent B, no concurrent message can corrupt the thread state during the transition window.

**Acceptance Criteria:**

- Per-thread lock acquired before thread mutation (handoff, delegate, complete)
- Concurrent messages to the same session during handoff are queued, not dropped
- Lock contention emits a trace event for observability

### US-2: Agent Developer — Data Isolation Between Agents

As an agent developer, I want each agent in a multi-agent conversation to have its own data namespace so that Agent B cannot accidentally overwrite Agent A's gathered fields.

**Acceptance Criteria:**

- Each `AgentThread` has an isolated `dataValues` namespace
- Explicit `data_mapping` in handoff config controls which fields are shared
- Session-level `dataValues` is a merged view (read-only) of all thread namespaces

### US-3: Operations Engineer — Fan-Out Recovery

As an operations engineer, I want fan-out executions to recover gracefully when some branches fail or the parent session expires, so that completed work is not lost.

**Acceptance Criteria:**

- Completed branch results persist in the barrier store beyond parent session TTL
- Parent resumption uses whatever results are available after timeout
- Failed branches emit structured error trace events with branch context

### US-4: Studio User — Multi-Agent Session Timeline

As a Studio user viewing a session detail page, I want to see a timeline of which agents participated, when handoffs occurred, and what data flowed between agents.

**Acceptance Criteria:**

- Session detail page shows agent participation graph as a visual timeline
- Each agent node shows duration, status, and key data exchanged
- Handoff/delegate transitions are visually distinct

### US-5: Platform Engineer — Cold Storage Fidelity

As a platform engineer, I want cold-restored sessions to preserve the full multi-agent context (thread relationships, handoff edges, data flow) so that resumed sessions behave identically to hot sessions.

**Acceptance Criteria:**

- `SessionStateRepo.upsert()` persists inter-thread edges (handoffFrom, handoffContext, data mappings)
- `SessionStateRepo.loadInternal()` restores edges faithfully
- Round-trip test: save → restore → compare produces identical session topology

## 4. Functional Requirements

### FR-1: Per-Thread Execution Lock

The system MUST acquire a per-thread lock (Redis `SET NX PX`) before mutating thread state during handoff, delegate, fan-out, or complete operations. The lock key format MUST be `session:{sessionId}:thread:{threadIndex}:lock`. Lock TTL MUST default to `SessionConfig.lockTtlMs` (currently 5000ms in `apps/runtime/src/services/session/types.ts`).

### FR-2: Thread Data Namespace

Each `AgentThreadData` MUST have its own `dataValues: Record<string, unknown>` that is isolated from other threads. The session-level `dataValues` on `SessionData` MUST be computed as a merged read-only view of all active thread namespaces, with the active thread's values taking precedence on key conflicts.

### FR-3: Explicit Data Sharing via Handoff Config

When a handoff occurs, data MUST flow from parent thread to child thread only through explicit `data_mapping` entries in the `HandoffConfig` IR. The existing `HandoffConfig.data_mapping` field (defined in `@abl/compiler`) MUST be the sole mechanism for cross-thread data transfer.

### FR-4: Fan-Out Partial Result Recovery

The `FanOutBarrierStore` MUST persist completed branch results with a TTL that exceeds the parent session's TTL by at least 2x. When the parent resumes (via `resumption-service.ts`), it MUST use all available results, treating missing/timed-out branches as errors rather than blocking indefinitely.

### FR-5: Agent Participation Graph

The system MUST record an `AgentParticipationGraph` on each session, containing:

- Nodes: `{ agentName, threadIndex, startedAt, endedAt, status, outcome }`
- Edges: `{ from, to, type: 'handoff' | 'delegate' | 'fan_out' | 'return', timestamp, dataKeys: string[] }`

This graph MUST be persisted to the `Session` model (MongoDB) and available via the session detail API.

### FR-6: Cold Storage Thread Edge Preservation

`SessionStateRepo.upsert()` MUST persist per-thread `handoffFrom`, `handoffContext`, `parentThreadId`, and `forkPoint` fields. The existing `ISessionStateThread` schema (in `packages/database/src/models/session-state.model.ts`) already has `handoffFrom`, `parentThreadId`, and `forkPoint` — these MUST be populated during cold writes.

### FR-7: Session Detail API — Participation Graph Endpoint

A new API endpoint `GET /api/runtime/sessions/:id/participation-graph` MUST return the agent participation graph for a session. The endpoint MUST enforce tenant and project isolation (query by `{ _id, tenantId }`).

### FR-8: Thread-Level Conversation Isolation

Each agent thread MUST maintain its own `conversationHistory` (already the case in `AgentThreadData`). The session-level `conversationHistory` on `SessionData` MUST be the active thread's history, not a merged history. This is already the architectural intent — FR-8 codifies it as a testable requirement.

### FR-9: Handoff Transition Atomicity

The sequence `[acquire thread lock → create child thread → switch activeThreadIndex → release thread lock]` MUST be atomic with respect to concurrent message processing. If the lock cannot be acquired within `lockTtlMs`, the operation MUST fail with a structured error (not silently drop the handoff).

### FR-10: Fan-Out Branch Timeout Independence

Each fan-out branch MUST have its own timeout (from `ExecutionUnit.timeout`), independent of other branches. A slow branch MUST NOT block faster branches from completing and having their results recorded.

## 5. Feature Classification & Integration Matrix

| Dimension          | Value                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| Type               | Enhancement (extends existing threaded session model)                    |
| Complexity         | High — cross-cutting across runtime, execution, database, studio         |
| Breaking Changes   | None — additive schema changes, backward-compatible session format       |
| Migration Required | Yes — MongoDB schema migration for participation graph on Session model  |
| Feature Flag       | `MULTI_AGENT_SESSION_V2` — guards new thread locking and namespace logic |

### Integration Matrix

| Related Feature                      | Integration Point                                                    |
| ------------------------------------ | -------------------------------------------------------------------- |
| Threaded Sessions (RFC-003)          | Foundation — this feature extends the thread model                   |
| Agent Transfer & A2A (RFC-014)       | Remote agents in fan-out use A2A protocol; session stays local       |
| Guardrails (RFC-009)                 | Per-thread guardrail policy scoping (future extension)               |
| Agent Observability (RFC-015)        | Participation graph feeds into session-level observability           |
| Runtime Core Orchestration (RFC-002) | ExecutionCoordinator, RoutingExecutor are primary integration points |

## 6. How to Consume

### Runtime API

- **WebSocket**: No protocol changes. Multi-agent sessions are transparent to the client — the same `send_message` / `agent_response` flow applies.
- **REST**: New endpoint `GET /api/runtime/sessions/:id/participation-graph` returns the agent participation graph.
- **Existing endpoints**: `GET /api/runtime/sessions/:id` response includes a new `participationGraph` field (additive, nullable).

### Studio UI

- **Session Detail Page** (`apps/studio/src/components/session/SessionDetailPage.tsx`): Enhanced with an "Agent Timeline" tab showing the participation graph as a horizontal swimlane visualization.
- **Agent Conversation Tree** (`apps/studio/src/components/session/AgentConversationTree.tsx`): Thread nodes annotated with data flow indicators.

### Admin

- No admin surface changes. Participation graph data is queryable via standard session APIs.

### DSL / IR

- No DSL changes. Existing `HANDOFF`, `DELEGATE`, `FAN_OUT` constructs produce the same IR. The runtime consumes `HandoffConfig.data_mapping` for namespace data flow.

## 7. Data Model

### SessionData (Redis — `apps/runtime/src/services/session/types.ts`)

```typescript
// EXISTING — no changes needed to the SessionData interface
// Thread-level data isolation is already structural (each AgentThreadData has its own dataValues)
// The session-level dataValues becomes a computed merge (behavioral change, not schema change)
```

### AgentThreadData — Enhanced Fields

```typescript
// EXISTING fields preserved; new fields marked
interface AgentThreadData {
  // ... existing fields ...
  /** Thread-scoped data namespace — replaces shared session dataValues for this thread */
  dataValues: Record<string, unknown>; // EXISTING — now the authoritative per-thread store
  /** Keys explicitly shared from parent thread via data_mapping */
  sharedFromParent?: string[]; // NEW
  /** Keys explicitly shared to child threads via data_mapping */
  sharedToChildren?: string[]; // NEW
}
```

### Session Model (MongoDB — `packages/database/src/models/session.model.ts`)

```typescript
// NEW embedded subdocument
interface IParticipationNode {
  agentName: string;
  threadIndex: number;
  startedAt: Date;
  endedAt: Date | null;
  status: string;
  outcome: string | null;
}

interface IParticipationEdge {
  fromAgent: string;
  toAgent: string;
  type: 'handoff' | 'delegate' | 'fan_out' | 'return';
  timestamp: Date;
  dataKeys: string[];
}

// Added to ISession:
interface ISession {
  // ... existing fields ...
  participationGraph?: {
    nodes: IParticipationNode[];
    edges: IParticipationEdge[];
  };
}
```

### SessionState Model (MongoDB Cold Store — `packages/database/src/models/session-state.model.ts`)

No schema changes needed. The existing `ISessionStateThread` already has `handoffFrom`, `parentThreadId`, `forkPoint`. The change is behavioral: ensure these fields are populated during `SessionStateRepo.upsert()`.

### Indexes

- `Session`: Add compound index `{ tenantId: 1, 'participationGraph.nodes.agentName': 1, startedAt: -1 }` for agent-scoped session queries
- Thread lock keys in Redis: `session:{sessionId}:thread:{threadIndex}:lock` (ephemeral, no index needed)

## 8. Key Implementation Files

| File                                                           | Role                                        |
| -------------------------------------------------------------- | ------------------------------------------- |
| `apps/runtime/src/services/session/types.ts`                   | SessionData, AgentThreadData definitions    |
| `apps/runtime/src/services/session/session-service.ts`         | Session CRUD, IR cache, lifecycle           |
| `apps/runtime/src/services/session/session-store.ts`           | SessionStore interface (Redis/Memory)       |
| `apps/runtime/src/services/session/redis-session-store.ts`     | Redis implementation of SessionStore        |
| `apps/runtime/src/services/session/tiered-session-store.ts`    | Hot/cold tiered storage                     |
| `apps/runtime/src/services/session/session-state-repo.ts`      | MongoDB cold storage persistence            |
| `apps/runtime/src/services/session/session-operations.ts`      | Fork, bulk ops                              |
| `apps/runtime/src/services/execution/types.ts`                 | RuntimeSession, AgentThread, thread helpers |
| `apps/runtime/src/services/execution/routing-executor.ts`      | Handoff, delegate, fan-out orchestration    |
| `apps/runtime/src/services/execution/execution-coordinator.ts` | Concurrency strategy, execution queue       |
| `packages/execution/src/child-session.ts`                      | Child session creation for fan-out          |
| `packages/execution/src/fan-out-barrier.ts`                    | Distributed fan-out coordination            |
| `packages/database/src/models/session.model.ts`                | MongoDB Session schema                      |
| `packages/database/src/models/session-state.model.ts`          | MongoDB cold store schema                   |
| `apps/studio/src/components/session/SessionDetailPage.tsx`     | Session detail UI                           |
| `apps/studio/src/components/session/AgentConversationTree.tsx` | Agent conversation tree UI                  |

## 9. Configuration

### Environment Variables

| Variable                       | Default | Description                                               |
| ------------------------------ | ------- | --------------------------------------------------------- |
| `THREAD_LOCK_TTL_MS`           | `5000`  | Per-thread execution lock TTL in milliseconds             |
| `FANOUT_RESULT_TTL_MULTIPLIER` | `2`     | Multiplier for fan-out result TTL relative to session TTL |
| `MULTI_AGENT_SESSION_V2`       | `false` | Feature flag to enable new thread locking and namespaces  |
| `PARTICIPATION_GRAPH_ENABLED`  | `true`  | Whether to record participation graph on sessions         |

### Runtime Config (SessionConfig)

The existing `SessionConfig` in `apps/runtime/src/services/session/types.ts` gains:

```typescript
interface SessionConfig {
  // ... existing fields ...
  /** Per-thread lock TTL (default: lockTtlMs) */
  threadLockTtlMs: number;
  /** Whether thread data namespacing is enabled */
  threadNamespacingEnabled: boolean;
}
```

## 10. Non-Functional Concerns

### Tenant Isolation

- All session queries include `tenantId` (enforced by `tenantIsolationPlugin` on Session and SessionState models)
- Thread locks are scoped to session ID, which is tenant-unique (UUIDv7)
- Participation graph API enforces `findOne({ _id, tenantId })` — cross-tenant access returns 404

### Project Isolation

- Session creation binds to `projectId`; all subsequent operations verify `projectId` matches
- The participation graph endpoint is under `/api/projects/:projectId/sessions/:id/participation-graph` to enforce project scoping

### User Isolation

- Sessions are scoped to end-users via `callerContext` (set at creation from edge layer)
- The participation graph contains no user-identifiable data (only agent names and metadata)

### Security

- Thread lock keys use session ID (not predictable) — no lock enumeration risk
- Handoff data_mapping is defined in compiled IR, not user input — no injection vector
- PII vault integration (`piiVaultData` on SessionData) applies per-thread — each thread's data is subject to the session's PII redaction config

### Performance

- Per-thread locks add 1 Redis round-trip per handoff (SET NX PX) — ~1ms latency
- Participation graph writes are append-only (one MongoDB `$push` per handoff) — ~2ms
- Fan-out result TTL extension adds no runtime cost (set at barrier creation)
- Thread data namespace merge is O(n) where n = active threads (typically 1-3)

### Reliability

- Thread locks have TTL — no deadlocks from crashed pods
- Fan-out barrier uses atomic Lua scripts — no race conditions on branch completion
- Cold storage preserves all thread edges — session restore is lossless

### Observability

- New trace events: `thread_lock_acquired`, `thread_lock_released`, `thread_lock_contention`
- Participation graph available via API for debugging multi-agent flows
- Existing `handoff`, `delegate_start`, `fan_out_start` events enriched with thread index

### Data Lifecycle

- Thread lock TTL: configurable, default 5000ms (matches existing session lock)
- Participation graph: persists with session (same retention as Session model — plan-based, up to 365 days)
- Fan-out results: `session_ttl * FANOUT_RESULT_TTL_MULTIPLIER` (default 2x)
- Cold storage: existing 90-day TTL applies to enhanced thread data

## 11. Delivery Plan / Work Breakdown

### Phase 1: Thread-Level Locking (FR-1, FR-9)

1. Add `acquireThreadLock(sessionId, threadIndex)` and `releaseThreadLock()` to `SessionStore` interface
2. Implement in `RedisSessionStore` using `SET session:{sid}:thread:{idx}:lock NX PX {ttl}`
3. Implement in `MemorySessionStore` using in-memory Map with TTL
4. Wire thread lock acquisition into `RoutingExecutor.handleHandoff()` and `handleDelegate()`
5. Add lock contention trace events to `trace-helpers.ts`
6. Unit tests for lock acquire/release/contention/expiry

### Phase 2: Thread Data Namespacing (FR-2, FR-3, FR-8)

1. Refactor `SessionData.dataValues` merge logic to compute from thread namespaces
2. Add `sharedFromParent` / `sharedToChildren` tracking to `AgentThreadData`
3. Wire `HandoffConfig.data_mapping` into thread creation in `createThread()` (execution types)
4. Update `syncThreadToSession()` to respect namespace boundaries
5. Update `tryThreadReturn()` to merge only explicitly shared data back to parent
6. Integration tests for data isolation and controlled sharing

### Phase 3: Fan-Out Recovery (FR-4, FR-10)

1. Extend `FanOutBarrierStore.create()` to accept `resultTtlMs` parameter
2. Modify `RedisFanOutBarrier` to set per-result TTL independent of barrier TTL
3. Update `ResumptionService` to handle partial results (some branches complete, others timed out)
4. Add per-branch timeout tracking in `InProcessExecutionRuntime`
5. Integration tests for partial failure recovery

### Phase 4: Participation Graph (FR-5, FR-7)

1. Define `IParticipationNode` and `IParticipationEdge` schemas in session model
2. Add `participationGraph` field to `Session` schema with embedded subdocuments
3. Record participation events in `RoutingExecutor` (handoff, delegate, fan-out, return, complete)
4. Create `GET /api/runtime/sessions/:id/participation-graph` endpoint
5. Add MongoDB index for agent-scoped participation queries
6. E2E tests for graph recording and retrieval

### Phase 5: Cold Storage Enhancement (FR-6)

1. Audit `SessionStateRepo.upsert()` to ensure `handoffFrom`, `parentThreadId`, `forkPoint` are populated
2. Add inter-thread edge data to cold storage (handoffContext serialization)
3. Verify round-trip fidelity: hot → cold → restore → compare
4. Integration tests for cold storage thread edge preservation

### Phase 6: Studio UI (US-4)

1. Create `AgentTimeline` component showing participation graph as swimlane
2. Integrate into `SessionDetailPage` as a new tab
3. Add data flow indicators to `AgentConversationTree`
4. Manual testing with multi-agent test scenarios

## 12. Success Metrics

| Metric                                  | Target                                |
| --------------------------------------- | ------------------------------------- |
| Thread lock contention rate             | < 0.1% of handoff operations          |
| Cross-agent data leakage incidents      | 0 (verified by E2E tests)             |
| Fan-out partial recovery success rate   | > 95% of partial-failure scenarios    |
| Cold storage round-trip fidelity        | 100% (bit-for-bit on thread topology) |
| Session detail page load time           | < 500ms for sessions with 10+ agents  |
| Participation graph query latency (p99) | < 50ms                                |

## 13. Open Questions

1. **Thread lock granularity**: Should we lock at the thread level or the session level? Thread-level is more granular but adds complexity. Current session-level locking (`acquireLock` in `SessionStore`) may be sufficient if handoff transitions are fast enough.

2. **Data namespace migration**: Existing sessions have flat `dataValues`. How do we handle in-flight sessions when the feature flag is enabled? Options: (a) migrate on next load, (b) leave existing sessions on old behavior, (c) dual-write period.

3. **Participation graph cardinality**: For long-running sessions with many handoffs (e.g., customer service with 10+ agent transitions), should we cap the graph size? MongoDB document size limit is 16MB, but large embedded arrays have query performance implications.

4. **Fan-out result persistence location**: Should completed branch results stay in Redis (current `FanOutBarrierStore`) or be persisted to MongoDB for durability? Redis provides speed but loses data on restart; MongoDB provides durability but adds latency.

## 14. Gaps, Known Issues & Limitations

| Gap                              | Severity | Description                                                                                                                                                                                       |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No per-thread guardrail scoping  | MEDIUM   | Guardrails are session-level, not thread-level. Future extension needed for per-agent policies                                                                                                    |
| A2A remote agent thread tracking | MEDIUM   | Remote agents (via A2A) execute outside the local session. Participation graph records the edge but not internal state                                                                            |
| Voice channel handoff continuity | LOW      | Voice sessions have additional state (SIP, media streams) that thread transitions must preserve. Covered by existing `voice-session-resolver.ts` but not formally tested in multi-agent scenarios |
| Memory/RECALL across threads     | MEDIUM   | FactStore is session-scoped, not thread-scoped. REMEMBER in Agent A is visible to Agent B. This may be desired behavior but is not explicitly documented                                          |

## 15. Testing & Validation

### E2E Test Scenarios (minimum 5)

**E2E-1: Handoff with thread data isolation**

- Start session with Agent A via `POST /api/runtime/chat`
- Agent A gathers field `customerName` → Agent A's thread dataValues has `customerName`
- Trigger handoff to Agent B
- Verify Agent B's thread does NOT have `customerName` unless `data_mapping` is configured
- Verify session-level API returns merged view

**E2E-2: Concurrent messages during handoff**

- Start session, trigger Agent A → Agent B handoff
- Send message during handoff transition window
- Verify message is queued (not dropped or corrupted)
- Verify Agent B eventually processes the queued message

**E2E-3: Fan-out with partial failure**

- Start session, trigger fan-out to 3 agents
- One agent times out, two complete successfully
- Verify parent session resumes with 2 successful results
- Verify timed-out branch is recorded as error in barrier store

**E2E-4: Participation graph recording**

- Execute a session with A → B → C → return to B → return to A flow
- Call `GET /sessions/:id/participation-graph`
- Verify 3 nodes (A, B, C) and 4 edges (handoff A→B, handoff B→C, return C→B, return B→A)

**E2E-5: Cold storage round-trip fidelity**

- Create multi-agent session with handoffs
- Force cold storage persist (via `SessionStateRepo.upsert()`)
- Expire Redis session (delete from primary store)
- Load session (triggers cold restore via `TieredSessionStore`)
- Verify thread topology, handoff edges, and data namespaces are preserved

### Integration Test Scenarios (minimum 5)

**INT-1: Thread lock acquire/release/timeout**

- Test `RedisSessionStore.acquireThreadLock()` succeeds on first call
- Test second acquire on same thread fails (returns false)
- Test acquire succeeds after TTL expiry
- Test release allows immediate re-acquire

**INT-2: Data namespace merge computation**

- Create session with 3 threads, each with overlapping keys
- Verify merged `dataValues` uses active thread's values on conflict
- Verify non-conflicting keys from all threads are present

**INT-3: Fan-out barrier with independent branch timeouts**

- Create barrier with 3 branches, each with different timeouts
- Complete branch 1 after 100ms, branch 2 after 500ms
- Verify branch 3 timeout does not affect completed results
- Verify `completeBranch` returns `allComplete: false` until all branches resolve

**INT-4: Participation graph persistence and query**

- Create Session document with participation graph
- Query by agent name in participation nodes
- Verify tenant isolation (cross-tenant query returns no results)

**INT-5: SessionStateRepo thread edge preservation**

- Create SessionData with 3 threads, handoff relationships, and context
- Call `SessionStateRepo.upsert()`
- Call `SessionStateRepo.loadInternal()`
- Verify all thread edges (handoffFrom, parentThreadId, handoffContext) match original
