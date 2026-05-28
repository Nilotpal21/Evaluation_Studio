# LLD: Workflow Execution — Direct WebSocket Push

**Feature Spec**: `docs/features/sub-features/workflows-websocket-direct.md`
**Status**: DONE
**Date**: 2026-04-27
**Branch**: `feat/workflows/context-cleanup`

---

## 1. Design Decisions

| #   | Decision                                                                    | Rationale                                                                                       |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| D-1 | WebSocket server lives in workflow-engine, not runtime                      | Removes runtime from the hot path; aligns with "workflow-engine ↔ Studio directly" requirement. |
| D-2 | Same HTTP port for WebSocket upgrade (9080)                                 | Simpler infra — one port, one ingress rule, no sticky-session complexity.                       |
| D-3 | Standalone `WorkflowEngineSocketContext` in Studio                          | Keeps runtime `/ws` and workflow-engine `/ws` fully decoupled; no cross-domain extension risk.  |
| D-4 | JWT subprotocol auth at upgrade time                                        | Matches existing runtime `/ws` pattern; `createUnifiedAuthMiddleware` already supports this.    |
| D-5 | Redis Pub/Sub within workflow-engine for cross-pod fan-out                  | Already used by workflow-handler via `StatusPublisher`; no new infrastructure needed.           |
| D-6 | `WORKFLOW_ENGINE_WS_URL` auto-derived from `WORKFLOW_ENGINE_URL` if not set | Zero-config for single-origin dev; explicit override for cross-origin prod.                     |
| D-7 | `workflow_execution_snapshot` pushed on subscribe                           | Eliminates HTTP GET in the happy path; single round-trip from subscribe to live panel.          |
| D-8 | Polling retained as fallback                                                | Forward-compat rollout; Studio degrades gracefully on connect failure or kill switch.           |

---

## 2. Key Interfaces

```ts
// apps/workflow-engine/src/websocket/ws-events.ts
import { z } from 'zod';

export const SubscribeExecutionMsg = z.object({
  type: z.literal('subscribe_execution'),
  projectId: z.string().min(1),
  workflowId: z.string().min(1),
  executionId: z.string().min(1),
});
export const UnsubscribeExecutionMsg = z.object({
  type: z.literal('unsubscribe_execution'),
  executionId: z.string().min(1),
});
export const WsClientMessage = z.discriminatedUnion('type', [
  SubscribeExecutionMsg,
  UnsubscribeExecutionMsg,
]);
export type WsClientMessage = z.infer<typeof WsClientMessage>;

export const WorkflowStepStatusMsg = z.object({
  type: z.literal('workflow_step_status'),
  executionId: z.string(),
  stepId: z.string(),
  stepType: z.string(),
  status: z.string(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  durationMs: z.number().optional(),
  consoleLogs: z.array(z.unknown()).optional(),
  metrics: z.record(z.unknown()).optional(),
  timestamp: z.string(),
});
export const WorkflowExecutionStatusMsg = z.object({
  type: z.literal('workflow_execution_status'),
  executionId: z.string(),
  status: z.enum(['started', 'completed', 'failed', 'cancelled', 'rejected']),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  output: z.record(z.unknown()).optional(),
  error: z.string().optional(),
  timestamp: z.string(),
});
export const WorkflowSnapshotMsg = z.object({
  type: z.literal('workflow_execution_snapshot'),
  execution: z.record(z.unknown()),
});
export const ExecutionNotFoundMsg = z.object({
  type: z.literal('execution_not_found'),
  executionId: z.string(),
});
```

```ts
// apps/workflow-engine/src/websocket/ws-subscription-registry.ts
export type RegistryEntry = {
  tenantId: string;
  projectId: string;
  connections: Set<WebSocket>;
  expiresAt: number | null;
};
export type RegisterResult =
  | { ok: true; firstSubscriberForChannel: boolean }
  | { ok: false; reason: 'limit' | 'already_terminal' };

export class WsSubscriptionRegistry {
  constructor(maxSize: number);
  register(
    executionId: string,
    meta: { tenantId: string; projectId: string },
    ws: WebSocket,
  ): RegisterResult;
  unregister(executionId: string, ws: WebSocket): { lastSubscriberForChannel: boolean };
  get(executionId: string): RegistryEntry | undefined;
  markTerminal(executionId: string, graceMs: number): void;
  sweep(now: number): { evicted: string[] };
  removeWebSocket(ws: WebSocket): { channelsDropped: string[] };
  size(): number;
}
```

```ts
// apps/workflow-engine/src/pubsub/redis-publisher.ts
export interface WorkflowStatusEvent {
  kind?: 'step' | 'workflow'; // absence = 'step' (back-compat)
  executionId: string;
  stepId?: string;
  stepType?: string;
  status: string;
  timestamp: string;
  input?: unknown;
  output?: unknown;
  durationMs?: number;
  consoleLogs?: unknown[];
  metrics?: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export class WorkflowRedisPublisher implements StatusPublisher {
  publish(channel: string, message: string): Promise<void>;
  publishStepStatus(
    tenantId: string,
    executionId: string,
    event: WorkflowStatusEvent,
  ): Promise<void>;
  publishWorkflowLifecycle(
    tenantId: string,
    executionId: string,
    event: {
      status: string;
      timestamp: string;
      startedAt?: string;
      completedAt?: string;
      error?: string;
    },
  ): Promise<void>;
}
```

---

## 3. File-Level Change Map

### New Files — workflow-engine

| File                                                             | Purpose                                                                | LOC est. |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| `apps/workflow-engine/src/websocket/ws-events.ts`                | Zod schemas for all client + server messages                           | ~80      |
| `apps/workflow-engine/src/websocket/ws-subscription-registry.ts` | Bounded registry: cap, TTL, eviction, removeWebSocket                  | ~130     |
| `apps/workflow-engine/src/websocket/ws-bridge.ts`                | Redis subscriber, dispatch to registry, snapshot-push, backpressure    | ~250     |
| `apps/workflow-engine/src/websocket/ws-handler.ts`               | `subscribe_execution` / `unsubscribe_execution` dispatch               | ~100     |
| `apps/workflow-engine/src/websocket/ws-server.ts`                | WebSocket server bootstrap, JWT upgrade auth, `ws.on('close')` cleanup | ~80      |
| `apps/workflow-engine/src/pubsub/redis-publisher.ts`             | `WorkflowRedisPublisher` implementing `StatusPublisher` + lifecycle    | ~100     |

### Modified Files — workflow-engine

| File                                                     | Change                                                                                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/index.ts`                      | Attach `ws-server` upgrade handler to `server` after `app.listen`; initialize bridge on startup                                                    |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`  | Call `publishWorkflowLifecycle` at started / completed / failed / rejected; enrich step events with `input` / `output` / `consoleLogs` / `metrics` |
| `apps/workflow-engine/src/routes/workflow-executions.ts` | Call `publishWorkflowLifecycle` for cancelled                                                                                                      |

### New Files — Studio

| File                                                                     | Purpose                                                         | LOC est. |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- | -------- |
| `apps/studio/src/contexts/WorkflowEngineSocketContext.tsx`               | Dedicated WS context for workflow-engine connection             | ~150     |
| `apps/studio/src/components/workflows/canvas/useExecutionWebSocket.ts`   | Drop-in hook; snapshot + delta merge; polling fallback          | ~180     |
| `apps/studio/src/components/workflows/canvas/execution-merge.ts`         | Pure `applySnapshot` / `mergeStepDelta` / `mergeExecutionDelta` | ~120     |
| `apps/studio/src/components/workflows/canvas/WorkflowDebugPanelLive.tsx` | Lazy `WorkflowEngineSocketProvider` wrapper                     | ~60      |

### Modified Files — Studio

| File                                                                 | Change                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/studio/src/contexts/RuntimeConfigContext.tsx`                  | Add `workflowEngineWsUrl: string`                                                |
| `apps/studio/src/app/layout.tsx`                                     | Populate `workflowEngineWsUrl` from `WORKFLOW_ENGINE_WS_URL` env or auto-derive  |
| `apps/studio/src/components/workflows/canvas/WorkflowCanvasPage.tsx` | Render `<WorkflowDebugPanelLive>` instead of `useExecutionPolling` at page level |

---

## 4. Implementation Phases

### Phase 1 — workflow-engine WebSocket server + registry

**Tasks**:

1.1 Create `ws-events.ts` with Zod schemas for all client and server message types.

1.2 Create `ws-subscription-registry.ts` — `WsSubscriptionRegistry` class with:

- `register(executionId, meta, ws)` — rejects at cap (`WF_WS_MAX_SUBSCRIPTIONS`) or if already terminal.
- `unregister(executionId, ws)` — returns `lastSubscriberForChannel`.
- `markTerminal(executionId, graceMs)` — sets `expiresAt = Date.now() + graceMs`.
- `sweep(now)` — evicts entries where `expiresAt !== null && expiresAt <= now`.
- `removeWebSocket(ws)` — removes `ws` from all entries; returns channels that dropped to 0.

  1.3 Create `ws-server.ts`:

- Import `WebSocketServer` from `ws`.
- Export `createWsServer(httpServer, bridge)` that attaches to `httpServer` on upgrade at path `/ws`.
- Validate JWT subprotocol via `createUnifiedAuthMiddleware` (extract token from `req.headers['sec-websocket-protocol']`).
- On connection: attach `{ tenantId, userId }` to `ws` as properties.
- On close: call `bridge.handleClose(ws)`.

  1.4 Extend `apps/workflow-engine/src/index.ts`:

- After `server = app.listen(PORT, ...)`, call `createWsServer(server, getWsBridge())`.
- On graceful shutdown: call `bridge.close()`.

**Exit criteria**:

- `pnpm build --filter=@agent-platform/workflow-engine` passes.
- WebSocket upgrade on `/ws` accepts and rejects connections by JWT validity.

---

### Phase 2 — Redis bridge + snapshot push

**Tasks**:

2.1 Create `ws-bridge.ts` — `WsBridge` singleton:

- Constructor reads `WF_WS_ENABLED`, `WF_WS_MAX_SUBSCRIPTIONS`, `WF_WS_TERMINAL_GRACE_MS`, `WF_WS_BUFFERED_AMOUNT_MAX` from `process.env`.
- `ensureSubscriber()` — lazy Redis `duplicate()` for subscription (mirrors `RedisTraceStore` pattern). Logger: `createLogger('workflow-engine:ws')`.
- `handleSubscribeExecution(ws, authCtx, msg)`:
  1. Validate: `findOne({ _id: msg.executionId, tenantId: authCtx.tenantId, projectId: msg.projectId })` — respond `execution_not_found` on any failure.
  2. Check `workflow:read` via `requireProjectPermission`.
  3. `registry.register(executionId, { tenantId, projectId }, ws)` — on `limit`, respond with `{ type: 'error', code: 'subscription_limit_reached' }`.
  4. If `firstSubscriberForChannel`: `subscriber.subscribe(channel)`.
  5. Fetch full execution doc and push `workflow_execution_snapshot` immediately.
- `handleUnsubscribeExecution(ws, msg)`: `registry.unregister`; if `lastSubscriberForChannel`, `subscriber.unsubscribe(channel)`.
- `handleClose(ws)`: `registry.removeWebSocket(ws)`; unsubscribe any channels that dropped to 0.
- `onRedisMessage(channel, raw)`: JSON.parse; dispatch to all `connections` in registry entry; apply backpressure guard before each `ws.send`.
- `forward(ws, payload)`: check `ws.bufferedAmount`; drop + log if over threshold.
- 30s sweep `setInterval`: `registry.sweep(Date.now())`; for each evicted channel, unsubscribe Redis.

  2.2 Create `ws-handler.ts` — `handleWsMessage(ws, authCtx, raw, bridge)`:

- Parse with `WsClientMessage.safeParse(JSON.parse(raw))`.
- Dispatch to `bridge.handleSubscribeExecution` or `bridge.handleUnsubscribeExecution`.
- Unknown type: respond `{ type: 'error', code: 'unknown_message_type' }`.

  2.3 Create `redis-publisher.ts` — `WorkflowRedisPublisher implements StatusPublisher`:

- `publish(channel, message)` — raw pass-through (implements `StatusPublisher`).
- `publishStepStatus(tenantId, executionId, event)` — publishes `{ kind: 'step', ...event }` to `workflow:{tenantId}:execution:{executionId}:status`.
- `publishWorkflowLifecycle(tenantId, executionId, event)` — publishes `{ kind: 'workflow', ...event }`.

**Exit criteria**:

- Subscribe → push snapshot → receive Redis publish → forward to WS client round-trip works end-to-end in dev.
- `pnpm build --filter=@agent-platform/workflow-engine` passes.

---

### Phase 3 — Lifecycle publish call sites

**Tasks**:

3.1 Wire `WorkflowRedisPublisher` as the concrete `StatusPublisher` in `index.ts` (injected into `runWorkflow` via `WorkflowHandlerDeps`).

3.2 Extend `workflow-handler.ts`:

- After `createExecution`: call `publishWorkflowLifecycle(..., { status: 'started', startedAt, timestamp })`.
- On `completed`: call `publishWorkflowLifecycle(..., { status: 'completed', completedAt, timestamp })`.
- On `failed`: call `publishWorkflowLifecycle(..., { status: 'failed', error, timestamp })`.
- On `rejected` (approval denied): call `publishWorkflowLifecycle(..., { status: 'rejected', timestamp })`.
- Enrich existing step publishes: add `input`, `output`, `consoleLogs`, `metrics` to the `WorkflowStatusEvent` so Studio receives full step data over WS without an HTTP fetch.

  3.3 Extend `workflow-executions.ts`:

- Cancel route: replace raw `publisher.publish(...)` with `publisher.publishWorkflowLifecycle(..., { status: 'cancelled', timestamp })`.

**Exit criteria**:

- A full workflow run in dev produces ordered `workflow_execution_status started` → step deltas → `workflow_execution_status completed` over WS.
- `pnpm build --filter=@agent-platform/workflow-engine` passes.

---

### Phase 4 — Studio hook + context

**Tasks**:

4.1 Create `WorkflowEngineSocketContext.tsx`:

- `WorkflowEngineSocketProvider` — manages one WebSocket to `workflowEngineWsUrl/ws` per mounted panel.
- JWT subprotocol: read from `useAuthStore` (same source as `WebSocketContext.tsx`).
- Reconnect with 1.5 s initial timeout; fallback flag after 5 s no reconnect.
- Exposes `send(msg)`, `subscribeMessage(handler) => unsubscribe`, `connected`, `fallback`.

  4.2 Create `execution-merge.ts` — pure functions (zero side effects, zero imports from platform):

- `applySnapshot(snapshot): WorkflowExecution` — normalize raw doc to `WorkflowExecution`.
- `mergeStepDelta(execution, delta): WorkflowExecution` — merge `workflow_step_status` into `context.steps`.
- `mergeExecutionDelta(execution, delta): WorkflowExecution` — merge `workflow_execution_status` (status, completedAt, output).

  4.3 Create `useExecutionWebSocket.ts`:

- On mount: send `subscribe_execution`.
- On `workflow_execution_snapshot`: `applySnapshot` → set state.
- On `workflow_step_status` / `workflow_execution_status`: apply merge helpers.
- Fallback triggers: `execution_not_found`, `error` with `unknown_message_type`, `fallback === true` from context.
- On unmount: send `unsubscribe_execution`.
- Returns same `WorkflowExecution | null` as `useExecutionPolling`.

  4.4 Create `WorkflowDebugPanelLive.tsx` — renders `<WorkflowEngineSocketProvider wsUrl={workflowEngineWsUrl}>` + `<WorkflowDebugPanel execution={execution} />` using `useExecutionWebSocket` internally. Unmount closes WS.

  4.5 Edit `WorkflowCanvasPage.tsx`:

- Remove `useExecutionPolling` import.
- Render `<WorkflowDebugPanelLive executionId={currentExecutionId} />` instead.

  4.6 Extend `RuntimeConfigContext.tsx` — add `workflowEngineWsUrl: string` (default `''`).

  4.7 Extend `apps/studio/src/app/layout.tsx` — populate `workflowEngineWsUrl`:

```ts
workflowEngineWsUrl:
  process.env.WORKFLOW_ENGINE_WS_URL ??
  (process.env.WORKFLOW_ENGINE_URL
    ? process.env.WORKFLOW_ENGINE_URL.replace(/^http/, 'ws')
    : ''),
```

4.8 Add `WORKFLOW_ENGINE_WS_URL=ws://localhost:9080` to `apps/studio/.env.local.example` and `apps/workflow-engine/.env.example`.

**Exit criteria**:

- `pnpm build --filter=@abl/studio` passes.
- Opening a workflow debug panel in dev: 0 WS connections before Run, 1 after Run; snapshot + step deltas visible in browser DevTools WS inspector.
- Chat WS (`/ws` to runtime) unaffected.

---

### Phase 5 — Tests

**Tasks**:

5.1 Unit — `ws-subscription-registry.test.ts`:

- Cap rejection, TTL eviction, `removeWebSocket` channel cleanup.

  5.2 Unit — `ws-events.test.ts`:

- Zod discriminated union parses valid messages; rejects unknown types.

  5.3 Unit — `execution-merge.test.ts` (Studio):

- `applySnapshot` / `mergeStepDelta` / `mergeExecutionDelta` parity with `useExecutionPolling` overlay logic.

  5.4 Unit — `redis-publisher.test.ts`:

- `publishStepStatus` emits `kind: 'step'`; `publishWorkflowLifecycle` emits `kind: 'workflow'` for all 5 terminal kinds.

  5.5 Integration — `ws-execution-subscribe.integration.test.ts`:

- Start workflow-engine Express server + WebSocket on random port.
- Subscribe → mock Redis publish → assert WS client receives delta.
- Cross-tenant subscribe → assert `execution_not_found`.
- Missing `workflow:read` → assert `execution_not_found`.

  5.6 E2E (Playwright) — `debug-panel-websocket.spec.ts`:

- 0 WS connections before clicking Run.
- 1 WS connection after Run; receives snapshot frame.
- Live step events update the panel without HTTP polling.

**Exit criteria**:

- All unit tests pass.
- Integration subscribe round-trip passes.
- Playwright smoke passes.

---

## 5. Wiring Checklist

- [x] `ws-server.ts` attached to `server` in `index.ts` after `app.listen` (index.ts L1562–1573, guarded by `WF_WS_ENABLED !== 'false'`).
- [x] `WsBridge` singleton initialized and passed to `ws-server.ts` (index.ts L1563–1573).
- [N/A] ~~`WorkflowRedisPublisher` injected as `StatusPublisher` into `WorkflowHandlerDeps`.~~ Not created — inline `deps.publisher.publish()` calls in `workflow-handler.ts` via the existing `StatusPublisher` interface.
- [x] `publishWorkflowLifecycle` called at all 5 lifecycle points via `deps.publisher.publish(channel, message)` in `workflow-handler.ts`.
- [x] Step events enriched with `input` / `output` / `consoleLogs` / `metrics`.
- [N/A] ~~`WorkflowDebugPanelLive` renders in `WorkflowCanvasPage.tsx`~~ — not created. `useExecutionWebSocket` called directly at `WorkflowCanvasPage.tsx` L101; `useExecutionPolling` no longer called at the page level.
- [x] `workflowEngineWsUrl` flows from env → `layout.tsx` → `RuntimeConfigContext` → `useExecutionWebSocket` (proxy.ts + layout.tsx L58 + RuntimeConfigContext.tsx L30).
- [x] Fallback to `useExecutionPolling` engages on connect timeout, unknown-type error, reconnect failure (implemented in `useExecutionWebSocket.ts`).
- [x] `WF_WS_ENABLED=false` causes Studio to skip WS and use polling directly (index.ts L1562).

---

## 6. Open Questions

1. In production, Studio and workflow-engine may be on different origins — does CORS need to be configured on the WebSocket upgrade? Answer: `ws` package does not apply CORS automatically; the upgrade handler must check `Origin` header in production.
2. Should the debug panel show a "Live" / "Polling" indicator so operators know which mode is active? Deferred — product decision.

---

## 7. Post-Implementation Notes (2026-04-28)

### Wiring Checklist Corrections

- `WorkflowRedisPublisher` was NOT created as a separate file. Redis publishing is done inline in `workflow-handler.ts` via the existing `StatusPublisher` interface — no new module was needed.
- `WorkflowDebugPanelLive` was NOT created. `useExecutionWebSocket` is called directly in `WorkflowCanvasPage.tsx` (line 101). No lazy provider wrapper was needed because the hook self-manages its WS lifecycle.
- `WorkflowEngineSocketContext.tsx` was NOT created. Hook manages its own connection, eliminating the extra context layer.
- All 5 lifecycle publish points are wired in `workflow-handler.ts` via `deps.publisher.publish(channel, message)`.
- `workflowEngineWsUrl` flows correctly: env → `layout.tsx` → `RuntimeConfigContext` → `useExecutionWebSocket`.
- `WF_WS_ENABLED=false` kill switch is active in dev; Studio uses polling as source of truth.
- Raw JSON panel in debug panel (`WorkflowDebugPanel.tsx`) now shows `execution.context` only, not the full execution document.

### Additional work on this branch

- **context.steps as single source of truth** (commit `244c98073`): All step state consolidated into `context.steps`. Studio debug panel and monitor tab derive flow-log and output views from `context.steps` rather than the old denormalised `nodeExecutions` mirror.
- **MCPClient crash fix** (commit `7fd43d360`): `handleTransportError` in `packages/compiler/src/platform/mcp/client.ts` now guards `emit('error')` with `listenerCount('error') > 0`. `inline-mcp-provider.ts` adds an `error` listener before `connect()` to prevent ENETUNREACH from crashing the Node.js process.

### Outstanding gaps before BETA

- GAP-004: Integration tests (subscribe → publish → receive) — requires real Redis
- GAP-005: E2E tests in Studio Playwright suite
- GAP-007: Prometheus metrics not yet emitted
