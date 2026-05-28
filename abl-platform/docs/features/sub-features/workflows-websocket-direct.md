# Feature: Workflow Execution — Direct WebSocket Push

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Workflows & Human Tasks](../workflows.md)
**Status**: ALPHA
**Feature Area(s)**: `observability`, `agent lifecycle`
**Package(s)**: `apps/workflow-engine`, `apps/studio`
**Last Updated**: 2026-04-28

---

## 1. Introduction / Overview

### Problem Statement

The Studio workflow debug panel polls `GET /api/projects/:id/workflows/:wfId/executions/:execId`
every 2 seconds via `useExecutionPolling`. Three concrete problems:

1. **Wasted work at rest** — full execution document returned every tick even when nothing changed.
2. **Up-to-2 s latency** on every step transition.
3. **Hard 5-minute ceiling** (`MAX_POLL_DURATION_MS`) silently stops updates on long-running
   human-task workflows.

### Goal Statement

Replace polling with push-based WebSocket streaming from workflow-engine directly to Studio.
The WebSocket server lives in workflow-engine; Studio connects to it without routing through
runtime. Redis Pub/Sub is used internally within workflow-engine only for cross-pod fan-out.
Polling is retained as an automatic fallback.

### Summary

workflow-engine gains a WebSocket endpoint (`/ws`). Studio opens one WebSocket connection per
active debug panel, sends `subscribe_execution`, and receives an immediate snapshot followed by
per-step deltas and lifecycle events as the execution progresses. A new `useExecutionWebSocket`
hook replaces `useExecutionPolling` as the primary source, with transparent polling fallback.

---

## 2. Scope

### Goals

- workflow-engine exposes a `/ws` WebSocket endpoint with JWT subprotocol auth.
- Studio connects directly to workflow-engine `/ws` — no runtime involvement in the WS hot path.
- Execution snapshot pushed on subscribe; per-step deltas pushed as steps transition.
- Lifecycle events (started / completed / failed / cancelled / rejected) pushed over WS.
- Polling retained as fallback when WebSocket is unavailable.
- Tenant + project isolation enforced at the workflow-engine subscribe handler.

### Non-Goals (Out of Scope)

- Approval-pending live badge (separate follow-on sub-feature).
- Admin Portal workflow monitoring.
- Redis Streams / durable event replay.
- Changes to the HTTP snapshot endpoint (retained as fallback, unchanged).
- Cross-tenant or cross-project monitoring.

---

## 3. User Stories

1. As a **workflow author** clicking **Run**, I want each node to update within milliseconds of
   transition so I can debug fast-chained steps without a 2 s lag.
2. As a **workflow author** with a long-running human-task workflow, I want the debug panel to
   stay connected indefinitely so updates don't silently stop after 5 minutes.
3. As an **operations engineer**, I want real-time step detail without each open panel adding
   load to the system.
4. As a **workflow author** behind a restrictive proxy, I want the panel to fall back to polling
   transparently so the feature still works.
5. As a **platform operator**, I want tenant and project isolation enforced on every subscribe so
   one tenant's WebSocket can never receive another's execution events.

---

## 4. Functional Requirements

1. **FR-1**: workflow-engine MUST expose a WebSocket upgrade path at `/ws`. Auth via JWT
   subprotocol validated by `createUnifiedAuthMiddleware` from `@agent-platform/shared`.
2. **FR-2**: workflow-engine MUST accept `subscribe_execution { type, projectId, workflowId, executionId }`.
   Reject with `execution_not_found` (WS close code 4404) for tenant mismatch, project permission
   denied (`workflow:read`), or missing execution — identical shape for all three (CLAUDE.md
   Core Invariant #1, cross-scope access returns 404).
3. **FR-3**: On successful subscribe, push a `workflow_execution_snapshot` server message
   containing the full normalized execution document immediately — no HTTP round-trip in the
   happy path.
4. **FR-4**: Push `workflow_step_status` deltas carrying `stepId`, `stepType`, `status`, `input`,
   `output`, `durationMs`, `consoleLogs`, `metrics`, and `timestamp` as each step transitions.
5. **FR-5**: Push `workflow_execution_status` lifecycle events (`started` / `completed` /
   `failed` / `cancelled` / `rejected`) carrying `startedAt`, `completedAt`, `output`, `error`,
   and `timestamp`.
6. **FR-6**: Cross-pod fan-out via Redis Pub/Sub within workflow-engine (`workflow:{tenantId}:execution:{executionId}:status`). The pod serving the WebSocket subscriber subscribes to this channel internally; it need not be the pod executing the workflow.
7. **FR-7**: Subscription registry bounded at `WF_WS_MAX_SUBSCRIPTIONS` (default 10 000) per pod.
   TTL eviction 30 s after terminal status (`WF_WS_TERMINAL_GRACE_MS`). Immediate removal on
   close. (CLAUDE.md: every in-memory Map needs max size, TTL, and eviction.)
8. **FR-8**: Per-socket backpressure guard — drop forward if `ws.bufferedAmount >
WF_WS_BUFFERED_AMOUNT_MAX` (default 512 KiB); client reconciles via HTTP snapshot fallback.
9. **FR-9**: Studio MUST fall back to `useExecutionPolling` if the WebSocket fails to connect
   within 1.5 s, subscribe is rejected with an unrecognized-type error, or the socket closes
   unexpectedly without reconnect within 5 s.
10. **FR-10**: Accept `unsubscribe_execution { type, executionId }` and implicit cleanup on
    WebSocket close.

---

## 5. Feature Classification & Integration Matrix

| Area                    | Impact    | Notes                                                 |
| ----------------------- | --------- | ----------------------------------------------------- |
| Observability / tracing | PRIMARY   | Replaces polling; adds WS metrics to workflow-engine. |
| Governance / controls   | SECONDARY | Enforces `workflow:read` at subscribe time.           |
| Agent lifecycle         | NONE      | No agent session impact.                              |
| Customer experience     | NONE      | Internal Studio tool.                                 |

| Related Feature                            | Relationship | Touchpoints                                                               |
| ------------------------------------------ | ------------ | ------------------------------------------------------------------------- |
| [Workflows & Human Tasks](../workflows.md) | extends      | FR-21 publisher side already exists; this completes subscriber.           |
| [Memory & Sessions](../memory-sessions.md) | parallel     | Studio opens a separate WS to workflow-engine alongside `/ws` to runtime. |

---

## 6. Architecture

```
Studio (browser)
  │
  │  ws://<workflow-engine>/ws
  │  subprotocol: JWT token
  │
  ▼
workflow-engine /ws handler
  │  - validates JWT (createUnifiedAuthMiddleware)
  │  - validates workflow:read on projectId
  │  - pushes snapshot
  │  - registers in subscription registry
  │
  ├──────────────────────────────────────────────────────┐
  │  If this pod owns the execution: push deltas directly │
  │  If another pod executes: subscribe Redis internally  │
  └──────────────────────────────────────────────────────┘
  │
  ▼
Redis Pub/Sub  (internal to workflow-engine, cross-pod only)
workflow:{tenantId}:execution:{executionId}:status
```

Runtime is **not involved** in the WebSocket path. Studio still uses runtime HTTP proxy for all
REST calls (execution snapshot via HTTP, fallback polling).

---

## 7. How to Consume

### Studio UI

The debug panel (`WorkflowCanvasPage.tsx` → `WorkflowDebugPanel.tsx`) is the only consumer.
A new `useExecutionWebSocket` hook drop-in replaces `useExecutionPolling` at `WorkflowCanvasPage.tsx`
L102. A new `WorkflowDebugPanelLive` wrapper lazily mounts a `WorkflowEngineSocketProvider` only
while the panel is visible — no WS held open on other tabs.

### API (workflow-engine WebSocket)

| Message direction | Type                          | Shape                                                                                                              |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Client → Server   | `subscribe_execution`         | `{ type, projectId, workflowId, executionId }`                                                                     |
| Client → Server   | `unsubscribe_execution`       | `{ type, executionId }`                                                                                            |
| Server → Client   | `workflow_execution_snapshot` | full normalized execution doc                                                                                      |
| Server → Client   | `workflow_step_status`        | `{ type, executionId, stepId, stepType, status, input?, output?, durationMs?, consoleLogs?, metrics?, timestamp }` |
| Server → Client   | `workflow_execution_status`   | `{ type, executionId, status, startedAt?, completedAt?, output?, error?, timestamp }`                              |
| Server → Client   | `execution_not_found`         | `{ type, executionId }`                                                                                            |

### API (HTTP — unchanged)

`GET /api/projects/:id/workflows/:wfId/executions/:execId` via runtime proxy — retained for
initial fallback and history view.

---

## 8. Data Model

No new collections. Reads existing `workflow_executions` for snapshot. No schema changes.

### In-Memory State (workflow-engine)

- `Map<executionId, { tenantId, projectId, connections: Set<WebSocket>, expiresAt: number|null }>`
  — subscription registry per pod. Bounded, TTL-evicted.
- `Map<redisChannel, refCount>` — Redis channel reference count; SUBSCRIBE / UNSUBSCRIBE once
  per channel per pod regardless of subscriber count.

### Redis Channels (existing, from workflow-engine)

- `workflow:{tenantId}:execution:{executionId}:status` — step + lifecycle events (already
  published by `workflow-handler.ts` via `StatusPublisher`).

---

## 9. Key Implementation Files

| File                                                                        | Status   | Notes                                                                                                                 |
| --------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/websocket/ws-server.ts`                           | SHIPPED  | WebSocket server bootstrap; JWT auth; upgrade handler                                                                 |
| `apps/workflow-engine/src/websocket/ws-handler.ts`                          | SHIPPED  | `subscribe_execution` / `unsubscribe_execution` message dispatch                                                      |
| `apps/workflow-engine/src/websocket/ws-subscription-registry.ts`            | SHIPPED  | Bounded subscription registry with TTL + eviction                                                                     |
| `apps/workflow-engine/src/websocket/ws-bridge.ts`                           | SHIPPED  | Redis subscriber; dispatch to registry; forward with backpressure; reads `WF_WS_*` env vars                           |
| `apps/workflow-engine/src/websocket/ws-events.ts`                           | SHIPPED  | Zod schemas for client + server messages                                                                              |
| `apps/workflow-engine/src/index.ts`                                         | EXTENDED | Attach WebSocket upgrade handler; guarded by `WF_WS_ENABLED !== 'false'`                                              |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`                     | EXTENDED | Inline `StatusPublisher.publish()` calls at started / completed / failed / rejected / cancelled. No separate file.    |
| `apps/studio/src/components/workflows/canvas/useExecutionWebSocket.ts`      | SHIPPED  | Drop-in hook; manages WS connection directly; merges snapshot + deltas; polling fallback                              |
| `apps/studio/src/components/workflows/canvas/execution-merge.ts`            | SHIPPED  | Pure `applySnapshot` / `mergeStepDelta` / `mergeExecutionDelta` helpers                                               |
| `apps/studio/src/components/workflows/canvas/WorkflowCanvasPage.tsx`        | EXTENDED | Calls `useExecutionWebSocket` directly (no lazy wrapper); renders `WorkflowDebugPanel` with the live execution object |
| `apps/studio/src/components/workflows/canvas/panels/WorkflowDebugPanel.tsx` | EXTENDED | Raw JSON viewer shows `execution.context` only (not full execution doc)                                               |
| `apps/studio/src/contexts/RuntimeConfigContext.tsx`                         | EXTENDED | Added `workflowEngineWsUrl` field                                                                                     |
| `apps/studio/src/app/layout.tsx`                                            | EXTENDED | Populates `workflowEngineWsUrl` from `WORKFLOW_ENGINE_WS_URL` env var                                                 |
| `apps/studio/src/proxy.ts`                                                  | EXTENDED | WebSocket proxy route for `WORKFLOW_ENGINE_WS_URL`                                                                    |
| `apps/workflow-engine/src/__tests__/ws-bridge.test.ts`                      | NEW      | 17 unit tests — snapshot, not_found, limit, closed WS, Redis message routing, terminal marking, error handling        |
| `apps/workflow-engine/src/__tests__/ws-subscription-registry.test.ts`       | NEW      | 13 unit tests — register, unregister, removeWebSocket, sweep, get                                                     |
| `apps/studio/src/__tests__/execution-merge.test.ts`                         | NEW      | 19 unit tests — applySnapshot field mapping, mergeStepDelta key resolution, mergeExecutionDelta all fields            |

**Not implemented (deviations from plan):**

- `apps/workflow-engine/src/pubsub/redis-publisher.ts` — NOT created. Redis publishing is done inline in `workflow-handler.ts` via the existing `StatusPublisher` interface. No separate file was needed.
- `apps/studio/src/components/workflows/canvas/WorkflowDebugPanelLive.tsx` — NOT created. Hook is wired directly in `WorkflowCanvasPage.tsx`, which proved simpler.
- `apps/studio/src/contexts/WorkflowEngineSocketContext.tsx` — NOT created. `useExecutionWebSocket` manages its own WebSocket connection directly, avoiding an extra context layer.

---

## 10. Configuration

| Variable                    | Service         | Default  | Description                                                                                                                              |
| --------------------------- | --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `WF_WS_ENABLED`             | workflow-engine | `true`   | Kill switch; Studio falls back to polling if false.                                                                                      |
| `WF_WS_MAX_SUBSCRIPTIONS`   | workflow-engine | `10000`  | Max concurrent subscription buckets per pod.                                                                                             |
| `WF_WS_TERMINAL_GRACE_MS`   | workflow-engine | `30000`  | Grace before Redis unsubscribe after terminal status.                                                                                    |
| `WF_WS_BUFFERED_AMOUNT_MAX` | workflow-engine | `524288` | Backpressure drop threshold in bytes.                                                                                                    |
| `WORKFLOW_ENGINE_WS_URL`    | studio          | derived  | WebSocket URL for workflow-engine (e.g. `ws://localhost:9080`). Falls back to replacing `http(s)` with `ws(s)` in `WORKFLOW_ENGINE_URL`. |

---

## 11. Non-Functional Concerns

### Isolation & Multitenancy

- `subscribe_execution` resolves via `findOne({ _id: executionId, tenantId })`. Mismatch → uniform `execution_not_found`.
- `workflow:read` required on the execution's `projectId`. Missing → same `execution_not_found`.
- All three failure modes (tenant, project, missing) return identical shape (Core Invariant #1).

### Security

- JWT validated by `createUnifiedAuthMiddleware` at WebSocket upgrade (no custom token parsing).
- No new PII crosses WS — status, stepId, durationMs, error strings only. Full outputs in HTTP snapshot.

### Performance

- Delta payload ≤ 300 B per step transition vs full execution doc (~5–50 KB) on each poll tick.
- Redis fan-out O(subscribers), not O(polls × viewers).
- p99 publish → Studio render target: < 200 ms intra-datacenter.

### Reliability

- Redis unavailable: subscribe fails; Studio falls back to polling. Execution continues.
- Pod restart: WS drops → client reconnects → re-subscribes → snapshot re-hydrates state.
- Kill switch `WF_WS_ENABLED=false`: Studio automatically falls back to polling.

### Observability

- Metrics: `workflow_ws_subscriptions` (gauge), `workflow_ws_events_forwarded_total`,
  `workflow_ws_subscribe_rejected_total`, `workflow_ws_backpressure_drops_total`.
- Structured logs at subscribe / unsubscribe / reject via `createLogger('workflow-engine:ws')`.

---

## 12. Delivery Plan

1. **workflow-engine WebSocket server** — `ws-server.ts`, upgrade handler in `index.ts`, JWT auth.
2. **Subscription registry + bridge** — `ws-subscription-registry.ts`, `ws-bridge.ts` (Redis subscriber, dispatch, backpressure).
3. **Message schemas + handler** — `ws-events.ts` Zod schemas, `ws-handler.ts` dispatch.
4. **Publisher** — ~~`redis-publisher.ts` with `publishStepStatus` + `publishWorkflowLifecycle`~~ **Not created.** Publishing done inline in `workflow-handler.ts` via the existing `StatusPublisher` interface. No separate file was needed.
5. **Studio hook + context** — ~~`WorkflowEngineSocketContext.tsx`~~, `useExecutionWebSocket.ts`, `execution-merge.ts`, ~~`WorkflowDebugPanelLive.tsx`~~, `WorkflowCanvasPage.tsx` swap. **Note:** No context wrapper or lazy-provider file was created — the hook is wired directly in `WorkflowCanvasPage.tsx`.
6. **Config wiring** — `RuntimeConfigContext.tsx` + `layout.tsx` env var; `studio/.env.local` dev default.
7. **Tests** — unit (registry, Zod schemas, merge logic), integration (subscribe → publish → receive round-trip, isolation matrix), Studio E2E (0 WS pre-Run, 1 per Run, snapshot + deltas).

---

## 13. Success Metrics

| Metric                                | Baseline       | Target                |
| ------------------------------------- | -------------- | --------------------- |
| Step transition latency p99           | ~2 s           | < 200 ms              |
| Execution GET QPS reduction           | N/A            | ≥ 70% when WS healthy |
| Polling fallback rate                 | 100%           | < 5% in healthy prod  |
| Long-running panel updates past 5 min | Stops silently | Indefinite            |

---

## 14. Open Questions

1. ~~Should `WorkflowEngineSocketContext` be a standalone context or can the existing `WebSocketContext` (runtime `/ws`) be extended with a second socket domain?~~ **RESOLVED**: `useExecutionWebSocket` manages the WS connection inline — no context wrapper created.
2. ~~Should the WebSocket upgrade live on the same port as the workflow-engine HTTP API (port 9080), or a dedicated port?~~ **RESOLVED**: Same port (port 9080). WebSocket upgrade is attached to the existing HTTP server.
3. ~~For dev: should `WORKFLOW_ENGINE_WS_URL` auto-derive from `WORKFLOW_ENGINE_URL` by replacing `http` → `ws`, or require explicit config?~~ **RESOLVED**: Auto-derive as fallback (`ws://` replacement); explicit `WORKFLOW_ENGINE_WS_URL` override supported in both Studio and the proxy layer.

---

## 15. Gaps & Known Issues

| ID      | Description                                                                                                                                                               | Severity                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| GAP-001 | Approval-pending relay not in scope for v1.                                                                                                                               | LOW — tracked separately.                                          |
| GAP-002 | CORS configuration needed in production where Studio and workflow-engine are on different origins. Currently WS goes through Studio's proxy at `/api/ws/workflow-engine`. | MEDIUM — must be addressed before prod rollout.                    |
| GAP-003 | Long-running HITL E2E test (> 5 min) requires time-accelerated harness or staging soak.                                                                                   | LOW — deferred post-ALPHA.                                         |
| GAP-004 | No integration tests. Subscribe → publish → receive round-trip is not covered by automated tests. Only unit tests exist (49 total across merge, bridge, registry).        | HIGH — required before BETA. Integration harness needs real Redis. |
| GAP-005 | No E2E tests. Studio WebSocket connect → subscribe → receive snapshot → receive deltas is not exercised end-to-end.                                                       | HIGH — required before BETA.                                       |
| GAP-006 | `WF_WS_ENABLED=false` is the current dev/staging default. WebSocket path is disabled; polling is source of truth. Not battle-tested in hot path.                          | MEDIUM — enable after integration tests pass.                      |
| GAP-007 | Prometheus metrics (`workflow_ws_subscriptions`, `workflow_ws_events_forwarded_total`, etc.) are documented in the spec but not yet emitted in code.                      | LOW — add before production rollout for observability.             |

## 16. Testing & Validation

### Current Coverage (ALPHA)

| Test Type   | Count | Files                                                                                                                                                                                             |
| ----------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | 49    | `apps/studio/src/__tests__/execution-merge.test.ts` (19), `apps/workflow-engine/src/__tests__/ws-bridge.test.ts` (17), `apps/workflow-engine/src/__tests__/ws-subscription-registry.test.ts` (13) |
| Integration | 0     | None — see GAP-004                                                                                                                                                                                |
| E2E         | 0     | None — see GAP-005                                                                                                                                                                                |

### Unit Test Scope

- **execution-merge.ts**: `applySnapshot` (field mapping, defaults, id resolution), `mergeStepDelta` (status update by display name, stepId key preference, stepData merge, immutability), `mergeExecutionDelta` (status, durationMs, output, error wrapping, completedAt preservation, immutability).
- **WsBridge**: snapshot delivery, execution_not_found, subscription_limit_reached, closed-WS no-send, Redis message routing (step.started / step.completed / workflow.completed / workflow.failed), terminal marking, unknown-exec ignore, malformed-channel ignore, unknown-event ignore, malformed-JSON no-throw.
- **WsSubscriptionRegistry**: register (firstSubscriberForChannel), multi-connection, size limit rejection, unregister (lastSubscriberForChannel), removeWebSocket (channelsDropped), sweep (grace period, eviction, non-terminal preserved), get.

### Manual Walkthrough (completed 2026-04-28)

Core happy path exercised in dev with `WF_WS_ENABLED=false` (polling fallback). WebSocket path verified locally via direct connection test.
