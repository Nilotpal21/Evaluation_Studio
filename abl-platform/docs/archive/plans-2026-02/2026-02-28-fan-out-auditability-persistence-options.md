# Fan-Out Child Session Auditability, Tracing & Persistence

**Date:** 2026-02-28
**Status:** Analysis
**Context:** Phase 1 execution model redesign is complete. Fan-out child sessions are ephemeral (in-memory only, never written to Redis). This document evaluates options for proper auditability, tracing, and optional persistence — and how each option maps to the Restate Phase 3 roadmap.

---

## Current State

### What child sessions have today

| Capability                             | Status                                                      | How                                                                           |
| -------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Trace events from child LLM/tool calls | Stored under **parent** session ID                          | R3 fix: `createCentralizedTraceHandler` uses `parentSessionId` as storage key |
| `executionId` correlation              | All fan-out events share one `executionId`                  | `fanOutTraceEvent` wrapper injects into all events                            |
| `childSessionId` in trace data         | Present in event `data` payload                             | R3: `childSessionId` field added when storage key differs                     |
| ClickHouse persistence                 | Events stored under parent session ID                       | R3: `store.appendEvent(storageKey, ...)` uses parent ID                       |
| Redis session persistence              | **None** — explicitly blocked                               | `debouncedPersist` skips `__fanout__` IDs                                     |
| MongoDB session persistence            | **None**                                                    | Session service never called for children                                     |
| Audit log entries                      | **None** for child sessions                                 | No session lifecycle audit events emitted                                     |
| Tool call attribution                  | Logs parent session ID (wrong)                              | C4: shared `toolExecutor` has parent's `sessionContext.sessionId`             |
| WebSocket trace forwarding             | Works via `fanOutTraceEvent` → `originalOnTraceEvent` chain | R4: unified wrapper routes through centralized handler                        |
| Post-crash recovery                    | **None** — child sessions exist only in RAM                 | By design: ephemeral                                                          |

### What's missing for full auditability

1. **Child session lifecycle audit events** — no `session.created` / `session.completed` / `session.failed` events for child sessions
2. **Tool call attribution** — tool audit logs attribute to parent session, not child
3. **Queryable child session records** — no way to query "show me all child sessions spawned by parent X"
4. **Child session persistence** — if we ever need crash recovery or cross-pod resumption of fan-out
5. **Individual child session trace isolation** — currently all traces are merged under parent, no way to view just one child's trace stream in Observatory

---

## Options

### Option A: Enhanced Tracing Only (No Persistence)

Keep child sessions ephemeral. Improve tracing to provide full auditability without persistence.

**Changes:**

1. **Emit child session lifecycle trace events:**

   ```
   fan_out_child_session_created  — {childSessionId, agentName, executionId, parentSessionId}
   fan_out_child_session_completed — {childSessionId, agentName, status, durationMs, executionId}
   ```

   These go through `fanOutTraceEvent` so they're stored under parent session ID with full correlation.

2. **Fix C4: Wire `toolExecutor` per child** (~10 lines in `handleFanOut`):

   ```typescript
   this.llmWiring.wireToolExecutor(childSession, session.compilationOutput, ...);
   ```

   Each child gets its own `ToolBindingExecutor` with correct `sessionContext.sessionId`.

3. **Add ClickHouse query support for `executionId`:**
   Today ClickHouse queries are keyed by `session_id`. Add a secondary index on `data.executionId` (already in the `data` JSON column) or promote `executionId` to a top-level column. This enables: "show me all trace events for fan-out execution X."

4. **Observatory UI: fan-out execution tree view:**
   Query trace events by `executionId`, group by `childSessionId`, render as tree under the parent session's trace stream.

**Pros:**

- Minimal code changes (~50 lines)
- No persistence overhead for ephemeral children
- No Redis/MongoDB writes for short-lived sessions
- Full audit trail via trace events
- Aligns with Phase 1 "ephemeral by design" principle

**Cons:**

- No crash recovery — pod failure during fan-out loses all child progress
- No cross-pod visibility of in-flight children
- Cannot inspect child session state post-hoc (only trace events survive)
- No "replay" capability for failed children

**Restate alignment:** This is the correct Phase 1 approach. When Restate is added (Phase 3), Restate's journal provides crash recovery and the `ExecutionRuntime` interface swap handles persistence. No throwaway work.

---

### Option B: Lightweight Child Session Records (Metadata Only)

Store a lightweight record for each child session — metadata only, no full session state.

**Changes:**

1. Everything from Option A, plus:

2. **New `ChildExecutionRecord` model:**

   ```typescript
   interface ChildExecutionRecord {
     childSessionId: string;
     parentSessionId: string;
     executionId: string;
     agentName: string;
     intent: string;
     status: 'running' | 'completed' | 'error' | 'timeout';
     startedAt: Date;
     completedAt?: Date;
     durationMs?: number;
     error?: string;
     response?: string; // truncated to 1KB
     gatheredData?: Record<string, unknown>;
   }
   ```

3. **Storage:** Write to MongoDB (not Redis) via a new `ChildExecutionStore`. Fire-and-forget write at child completion. No read on the hot path.

4. **Query API:** `GET /api/projects/:projectId/sessions/:sessionId/executions` — returns all child execution records for a parent session.

5. **TTL:** Same retention as parent session traces (configurable, default 90 days).

**Pros:**

- Queryable child session history
- Lightweight — only metadata, not full session state
- Enables "what happened in this fan-out?" debugging
- Decoupled from hot path (fire-and-forget writes)

**Cons:**

- New MongoDB collection and model
- Still no crash recovery (metadata written at completion, not start)
- More storage for high-fan-out workloads

**Restate alignment:** This is orthogonal to Restate. Restate's journal replaces the need for metadata records (Restate tracks activity status natively). But this metadata store could serve as an audit trail even with Restate, since Restate journals are not designed for long-term query.

---

### Option C: Full Child Session Persistence (Durable Fan-Out)

Persist child sessions to Redis like regular sessions, enabling crash recovery.

**Changes:**

1. Everything from Options A and B, plus:

2. **Remove the `__fanout__` guard in `debouncedPersist`** — allow child sessions to persist.

3. **Add `parentSessionId` field to session schema** — both Redis and MongoDB. Enables parent-child session queries.

4. **Session rehydration for children:** On pod restart, detect in-flight fan-out children (sessions with `__fanout__` in ID or `parentSessionId` set), resume or fail gracefully.

5. **Cleanup on fan-out completion:** Delete child sessions from Redis after results are merged into parent (current behavior, but now after a persist-then-delete cycle).

6. **Orphan detection:** Background job to detect child sessions whose parent is no longer executing (process crash scenario). Mark as `failed`, emit trace events.

**Pros:**

- Full crash recovery for fan-out
- Cross-pod visibility of in-flight children
- Complete session state available for debugging
- Enables "resume failed fan-out" feature

**Cons:**

- Significant complexity — session lifecycle, orphan detection, cleanup
- Redis write amplification (N child sessions × per-turn persist)
- `debouncedPersist` skip was added specifically to prevent this overhead
- Partially duplicates what Restate provides natively
- Risk of orphaned Redis keys on incomplete cleanup

**Restate alignment:** This is **the wrong approach** if Restate is on the roadmap. Restate's journal replay provides crash recovery without custom persistence. Building this would create throwaway work that Restate replaces entirely. The only reason to build Option C is if Restate is not happening within 6 months.

---

### Option D: Restate Phase 3 (Durable Execution Runtime)

Skip custom persistence. Wait for Restate integration, which provides crash recovery, audit trail, and suspension natively.

**Changes:**

1. **Implement `RestateExecutionRuntime`** — plugs into the existing `ExecutionRuntime` interface.

2. **Each fan-out child becomes a Restate activity:**

   ```typescript
   class RestateExecutionRuntime implements ExecutionRuntime {
     async execute(plan, executeUnit, parentSignal) {
       const ctx = restate.useContext();
       const results = await ctx.run('fan-out', async () => {
         return Promise.allSettled(
           plan.units.map((unit) =>
             ctx.activity('execute-agent', { unit }, { timeout: unit.timeout }),
           ),
         );
       });
       return results;
     }
   }
   ```

3. **Agent execution HTTP endpoint:** `POST /api/v1/agents/:name/execute` — Restate calls this to execute a single agent. This is the same `executeMessage` logic, wrapped in an HTTP handler.

4. **Event relay:** Restate handler emits `ExecutionEvent`s to Redis Pub/Sub. `ExecutionEventBus` subscribes and delivers to WebSocket/SSE.

5. **Awakeable callback:** `POST /api/v1/executions/:executionId/callback` — resolves Restate awakeables for async tools / human-in-the-loop.

**What Restate provides for free:**

- Journal replay on crash — fan-out children resume where they left off
- Activity timeout and retry policies
- Distributed tracing via OpenTelemetry (Restate is OTEL-native)
- Exactly-once execution semantics
- Audit trail via Restate admin API
- Cancellation propagation

**What we still need (even with Restate):**

- Option A's tracing enhancements (lifecycle events, C4 fix) — Restate doesn't write to our ClickHouse
- Option B's metadata records (optional) — for long-term audit beyond Restate journal retention

**Pros:**

- No custom crash recovery code
- No Redis write amplification for children
- Suspension/HITL/async tools come for free
- Clean architectural boundary (already designed)

**Cons:**

- Infrastructure dependency (Restate service must be deployed)
- Not available until Phase 3 timeline
- Requires event relay for WebSocket streaming
- Operational complexity of Restate cluster

---

## Recommendation

**Do Option A now. Plan for Option D (Restate).**

Option A gives full auditability with minimal effort (~50 lines of code, zero new infrastructure). It aligns perfectly with the Phase 1 "ephemeral by design" principle and creates zero throwaway work for when Restate arrives.

Option B is worth considering after Option A if customers need queryable child session history before Restate ships. It's additive and doesn't conflict with the Restate path.

Option C should be avoided — it duplicates Restate's value proposition with significantly more custom code and operational risk.

---

## Restate TODOs

These are the items from the design document (`2026-02-28-execution-model-redesign-design.md`) that remain for the Restate integration path, organized by dependency order:

### Phase 2 Prerequisites (before Restate)

| #    | TODO                                                  | File(s)                                                                        | Notes                                                                                                                                                                                 |
| ---- | ----------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1 | Implement `ExecutionEventBus` (Redis Pub/Sub variant) | `packages/execution/src/event-bus.ts` (new)                                    | Phase 1 deferred this — uses direct `onTraceEvent` callbacks. Restate needs Pub/Sub to relay events cross-process.                                                                    |
| P2-2 | Migrate delegate to `ExecutionRuntime.execute()`      | `routing-executor.ts` `handleDelegate`                                         | Currently delegate uses raw `executeMessage`. Must go through `ExecutionRuntime` so Restate can intercept.                                                                            |
| P2-3 | Migrate handoff to `ExecutionRuntime.execute()`       | `routing-executor.ts` `handleHandoff`                                          | Same as delegate — handoff must use the pluggable runtime.                                                                                                                            |
| P2-4 | WebSocket/SSE subscribe to `ExecutionEventBus`        | `websocket/handler.ts`, `routes/chat.ts`                                       | Currently events flow via callback chain. Must subscribe to bus so Pub/Sub works.                                                                                                     |
| P2-5 | `ExecutionContext` wrapper over `RuntimeSession`      | `packages/execution/src/types.ts`, `services/session/session-context.ts` (new) | Design doc defines `ExecutionContext` and `SessionContext` interfaces. Phase 1 skipped this — executors still take `RuntimeSession` directly. Restate needs the controlled interface. |
| P2-6 | Per-child text streaming via `ExecutionEventBus`      | `routing-executor.ts` `executeUnit`                                            | Currently `onChunk` is `undefined` for children. Bus enables labeled per-agent streaming.                                                                                             |

### Phase 3: Restate Integration

| #     | TODO                                                          | File(s)                                                               | Notes                                                                                                                     |
| ----- | ------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| P3-1  | Implement `RestateExecutionRuntime`                           | `packages/execution/src/restate-runtime.ts` (new)                     | Implements `ExecutionRuntime` interface. Maps `ExecutionPlan` to Restate activities.                                      |
| P3-2  | Agent execution HTTP endpoint                                 | `apps/runtime/src/routes/execution.ts` (new)                          | `POST /api/v1/agents/:name/execute` — Restate calls this per activity. Wraps `executeMessage` with HTTP request/response. |
| P3-3  | Awakeable callback endpoint                                   | `apps/runtime/src/routes/execution.ts`                                | `POST /api/v1/executions/:executionId/callback` — resolves awakeables for async tools, HITL, remote handoff.              |
| P3-4  | Implement `SuspensionReason` → awakeable mapping              | `packages/execution/src/restate-runtime.ts`                           | `suspend()` on `ExecutionContext` maps to `ctx.awakeable()` in Restate handler.                                           |
| P3-5  | Project-level `executionMode` DB schema + resolution          | `apps/runtime/src/services/deployment-resolver.ts`, Prisma schema     | Config: `{ executionMode: 'in-process'                                                                                    | 'durable', durableRuntime: { provider: 'restate', endpoint: '...' } }` |
| P3-6  | `ExecutionRuntime` factory — select runtime by project config | `apps/runtime/src/services/execution/routing-executor.ts` constructor | Currently hardcodes `new InProcessExecutionRuntime()`. Must read project config and instantiate appropriate runtime.      |
| P3-7  | Restate event relay → Redis Pub/Sub                           | `packages/execution/src/restate-runtime.ts`                           | Restate handler publishes `ExecutionEvent`s to Redis channel. `ExecutionEventBus` subscribes.                             |
| P3-8  | Session state access from Restate handler                     | `apps/runtime/src/routes/execution.ts`                                | Restate activity handler loads session from Redis, executes agent, writes back. Same `SessionService` used by runtime.    |
| P3-9  | Cancellation mapping                                          | `packages/execution/src/restate-runtime.ts`                           | Map `AbortSignal` cancellation to Restate cancel API. Parent cancel → cancel all child activities.                        |
| P3-10 | OpenTelemetry span integration                                | `apps/runtime/src/observability/otel-trace-bridge.ts`                 | Restate is OTEL-native. Wire Restate spans as parents of our trace events.                                                |

### Dependency Graph

```
P2-5 (ExecutionContext) ← P2-1 (EventBus) ← P2-4 (WS/SSE subscribe)
                                            ← P2-6 (child streaming)
                        ← P2-2 (delegate migration)
                        ← P2-3 (handoff migration)

P2-1 (EventBus) ← P3-7 (Restate event relay)
P2-2 + P2-3 ← P3-1 (RestateExecutionRuntime)
P3-1 ← P3-2 (HTTP endpoint)
     ← P3-4 (suspension/awakeables)
     ← P3-6 (runtime factory)
     ← P3-9 (cancellation)
P3-2 ← P3-3 (callback endpoint)
     ← P3-8 (session access)
P3-5 ← P3-6 (runtime factory)
```

---

## Immediate Next Steps (Option A Implementation)

### A1: Emit child session lifecycle trace events ✅ DONE

**File:** `apps/runtime/src/services/execution/routing-executor.ts`

In `executeUnit`, after `createChildSession` and before `executeMessage`:

```typescript
fanOutTraceEvent?.({
  type: 'fan_out_child_session_created',
  data: {
    childSessionId,
    agentName: unit.agentName,
    intent: unit.message,
  },
});
```

In `executeUnit`, in the `finally` block before `sessions.delete`:

```typescript
fanOutTraceEvent?.({
  type: 'fan_out_child_session_completed',
  data: {
    childSessionId,
    agentName: unit.agentName,
    status: childThread.status,
    durationMs: childThread.endedAt
      ? childThread.endedAt - (childThread.startedAt || 0)
      : undefined,
  },
});
```

**File:** `apps/runtime/src/types/index.ts` — add `fan_out_child_session_created` and `fan_out_child_session_completed` to `TraceEventType`.

### A2: Fix C4 — wire `toolExecutor` per child ✅ DONE

**File:** `apps/runtime/src/services/execution/routing-executor.ts`

In `executeUnit`, after `wireLLMClient`:

```typescript
if (session.compilationOutput) {
  this.llmWiring.wireToolExecutor(
    childSession,
    session.compilationOutput,
    session.tenantId,
    session.projectId,
  );
}
```

**Requires:** Verify `wireToolExecutor` signature accepts these args. May need `ExecutorContext` to expose `llmWiring.wireToolExecutor`.

### A3: Add `clearCooldown` for child sessions (Gap 10) ✅ DONE

**File:** `apps/runtime/src/services/execution/routing-executor.ts`

In `executeUnit` `finally` block, add:

```typescript
this.llmWiring.clearCooldown(childSessionId);
```

**Requires:** `llmWiring` accessible from `RoutingExecutor` (already is via constructor).

### A4: Fix Gap 7 — concurrent fan-out guard ✅ DONE

**File:** `apps/runtime/src/services/execution/routing-executor.ts`

Add instance field:

```typescript
private _activeFanOutSessions = new Set<string>();
```

At start of `handleFanOut`:

```typescript
if (this._activeFanOutSessions.has(session.id)) {
  return {
    success: false,
    results: [],
    failedCount: 0,
    error: 'Fan-out already in progress for this session',
  };
}
this._activeFanOutSessions.add(session.id);
```

In `finally` (wrap the post-execution code):

```typescript
this._activeFanOutSessions.delete(session.id);
```

### A5: Fix Gap 4 — conversation history role ✅ DONE

**File:** `apps/runtime/src/services/execution/routing-executor.ts`

Removed the `currentThread.conversationHistory.push` calls. The results are already returned to the LLM via `formatFanOutToolResult` as a tool result. Adding them as `role: 'assistant'` created duplicates — the LLM's synthesized response becomes the authoritative assistant message in history. Raw per-agent results remain accessible via `_last_fan_out` and `_fan_out_result_{target}` context values.
