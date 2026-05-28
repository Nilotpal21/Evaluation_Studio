# Async Execution Architecture

> Suspension/resumption engine for long-running agentic operations.

---

## Overview

When execution encounters an async boundary (remote agent with push notifications, async tool, human approval), it **suspends** — persisting the exact continuation point to MongoDB and registering a callback in Redis. When the external system calls back, execution **resumes** on any pod, delivering the result to the original channel.

All state is externalized (Redis + MongoDB). Suspended executions survive pod restarts.

---

## Execution State Machine

```
queued → running → completed | failed | cancelled | preempted
                 → suspended → resuming → completed | failed
                            → expired (timeout, no callback)
                            → cancelled (user/admin)
```

---

## Core Data Model

### SuspendedExecution (`packages/execution/src/suspension.ts`)

```typescript
interface SuspendedExecution {
  suspensionId: string; // Unique suspension ID
  executionId: string; // Original execution ID
  sessionId: string; // Session to resume
  tenantId: string; // Tenant isolation
  reason: SuspensionReason; // Why suspended
  continuation: SuspendedContinuation; // WHERE to resume
  channelBinding: ChannelBinding; // HOW to deliver result
  callbackId: string; // Callback lookup key
  callbackSecret: string; // HMAC auth secret (encrypted)
  barrierId?: string; // Fan-out barrier reference
  status: SuspensionStatus; // Lifecycle state
  expiresAt: Date; // Auto-expiry deadline
}
```

### SuspendedContinuation — the "program counter"

| Type                    | When                             | Resume Action                                 |
| ----------------------- | -------------------------------- | --------------------------------------------- |
| `tool_result`           | Async webhook tool               | Inject tool result, continue reasoning loop   |
| `remote_handoff_result` | A2A push notification (outbound) | Inject handoff result, restore parent thread  |
| `fan_out_branch`        | Async branch in fan-out          | Record in barrier; if all done, resume parent |
| `human_input`           | Human approval or input needed   | Inject human response, continue flow          |
| `human_agent_transfer`  | Transfer to real human agent     | Future: bidirectional relay                   |

### ChannelBinding — how to deliver the result

Captures the original channel (WebSocket connection ID, push notification URL, async channel connection ID) so the result can be delivered when execution resumes.

---

## Callback Flow

```
1. Execution encounters async boundary
2. SuspendedExecution created in MongoDB
3. Callback registered in Redis (callbackId → suspensionId)
4. Callback URL given to external system
5. External system calls POST /api/v1/callbacks/:callbackId
6. Callback claimed atomically (Redis Lua: GET + DEL)
7. Resume job enqueued to BullMQ 'execution-resume' queue
8. ResumptionWorker processes job
9. Session loaded from Redis, non-serializable fields re-wired
10. Execution resumed at continuation point
11. Result delivered via ChannelDispatcher
```

---

## Fan-Out Barrier (`packages/execution/src/fan-out-barrier.ts`)

For mixed sync/async fan-out (e.g., 2 local + 1 remote agent):

1. Barrier created with `totalBranches`
2. Local branches execute inline, each calls `completeBranch()`
3. Remote branches get suspensions with per-branch callbacks
4. `completeBranch()` uses atomic Redis Lua (HINCRBY) — exactly one caller detects completion
5. When all branches done → parent suspension resumed with aggregated results

---

## Channel Dispatcher (`apps/runtime/src/services/execution/channel-dispatcher.ts`)

Three-tier delivery:

1. **Direct**: WebSocket on same pod, A2A push notification, async channel webhook
2. **Cross-pod**: Redis Pub/Sub `ws:deliver:{sessionId}` — any pod with the client's WS receives it
3. **Persistent**: `PendingDeliveryStore` (Redis LIST, TTL 24h) — delivered when client reconnects

---

## Redis Key Layout

```
callback:{callbackId}                         STRING  TTL: suspension timeout
callback:payload:{callbackId}                 STRING  TTL: 300s (race condition safety)
barrier:{barrierId}                           HASH    TTL: barrier timeout
barrier:{barrierId}:result:{agentName}        STRING  TTL: barrier timeout
a2a:task:{taskId}                             STRING  TTL: 24h
a2a:push:{taskId}                             STRING  TTL: 24h
pending:delivery:{sessionId}                  LIST    TTL: 24h
ws:deliver:{sessionId}                        PUBSUB  (ephemeral)
```

---

## MongoDB Schema

Collection: `suspended_executions`

Indexes: `{suspensionId}` (unique), `{tenantId, status, expiresAt}`, `{sessionId, status}`, `{barrierId}` (sparse), `{callbackId}`. TTL index on `completedAt` (7 day cleanup).

---

## Security

- **HMAC callback auth**: Per-suspension `callbackSecret` with SHA-256 signature verification
- **SSRF protection**: All outbound URLs validated before fetch
- **Rate limiting**: 100 req/min per IP on callback endpoints
- **Tenant isolation**: Every query includes `tenantId`

---

## Trace Events

| Event                      | Severity | When                            |
| -------------------------- | -------- | ------------------------------- |
| `execution_suspended`      | info     | Execution suspended             |
| `execution_resumed`        | info     | Execution resumed               |
| `execution_resume_failed`  | error    | Resume attempt failed           |
| `callback_received`        | info     | External callback received      |
| `callback_claimed`         | debug    | Callback claimed for processing |
| `callback_expired`         | warn     | Callback expired without claim  |
| `barrier_branch_completed` | info     | Fan-out branch completed        |
| `barrier_all_complete`     | info     | All fan-out branches done       |

---

## Key Files

| File                                                            | Purpose                      |
| --------------------------------------------------------------- | ---------------------------- |
| `packages/execution/src/suspension.ts`                          | Core types                   |
| `packages/execution/src/suspension-store.ts`                    | MongoDB store interface      |
| `packages/execution/src/callback-registry.ts`                   | Redis callback lookup        |
| `packages/execution/src/redis-callback-registry.ts`             | Redis implementation         |
| `packages/execution/src/fan-out-barrier.ts`                     | Distributed barrier          |
| `packages/execution/src/redis-fan-out-barrier.ts`               | Redis barrier implementation |
| `apps/runtime/src/services/execution/resumption-service.ts`     | Resume orchestrator          |
| `apps/runtime/src/services/execution/channel-dispatcher.ts`     | Multi-tier delivery          |
| `apps/runtime/src/routes/callbacks.ts`                          | Callback HTTP endpoint       |
| `apps/runtime/src/services/queues/resumption-worker.ts`         | BullMQ resume worker         |
| `apps/runtime/src/services/queues/suspension-timeout-worker.ts` | Expiry cleanup               |
