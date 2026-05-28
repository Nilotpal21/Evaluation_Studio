# Test Spec: Workflow Execution — Direct WebSocket Push

**Feature**: [workflows-websocket-direct](../../features/sub-features/workflows-websocket-direct.md)
**Status**: IN PROGRESS
**Last Updated**: 2026-04-28
**Packages**: `apps/workflow-engine`, `apps/studio`

---

## Current State

- **Unit tests**: 49 (execution-merge: 19, ws-bridge: 17, ws-registry: 13) — ✅
- **Integration tests**: 0 — ❌
- **E2E tests**: 0 — ❌
- **`WF_WS_ENABLED`**: `false` in dev — polling is source of truth until integration tests pass

---

## Coverage Matrix

| FR    | Description                                           | Unit | Integration | E2E |
| ----- | ----------------------------------------------------- | ---- | ----------- | --- |
| FR-1  | `/ws` WebSocket endpoint with JWT subprotocol auth    | ❌   | ❌          | ❌  |
| FR-2  | `subscribe_execution` with tenant + project isolation | ✅   | ❌          | ❌  |
| FR-3  | `workflow_execution_snapshot` pushed on subscribe     | ✅   | ❌          | ❌  |
| FR-4  | `workflow_step_status` deltas per step transition     | ✅   | ❌          | ❌  |
| FR-5  | `workflow_execution_status` lifecycle events          | ✅   | ❌          | ❌  |
| FR-6  | Redis Pub/Sub cross-pod fan-out                       | ✅   | ❌          | ❌  |
| FR-7  | Subscription registry bounded, TTL-evicted            | ✅   | ❌          | ❌  |
| FR-8  | Backpressure guard (`bufferedAmount` drop)            | ✅   | ❌          | ❌  |
| FR-9  | Polling fallback on WS connect failure                | ❌   | ❌          | ❌  |
| FR-10 | `unsubscribe_execution` + implicit cleanup on close   | ✅   | ❌          | ❌  |

**Notes:**

- FR-1 JWT auth tested manually; unit tests use fake WebSocket without auth middleware.
- FR-9 fallback logic lives in `useExecutionWebSocket.ts`; no automated test yet.

---

## Unit Test Files

| File                                                                  | Tests | What is Covered                                                             |
| --------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/execution-merge.test.ts`                   | 19    | `applySnapshot`, `mergeStepDelta`, `mergeExecutionDelta` pure functions     |
| `apps/workflow-engine/src/__tests__/ws-bridge.test.ts`                | 17    | `WsBridge` snapshot delivery, Redis event routing, terminal marking, errors |
| `apps/workflow-engine/src/__tests__/ws-subscription-registry.test.ts` | 13    | `WsSubscriptionRegistry` register/unregister/sweep/eviction/removeWebSocket |

---

## Integration Test Scenarios (Planned — 0 shipped)

> All require a real Redis instance and a running workflow-engine process.

| ID   | Scenario                                                                                 | Status  |
| ---- | ---------------------------------------------------------------------------------------- | ------- |
| IT-1 | Subscribe to a running execution → receive snapshot immediately                          | ❌ TODO |
| IT-2 | Step transitions in workflow-handler publish Redis events → connected WS receives deltas | ❌ TODO |
| IT-3 | Tenant isolation — subscribe with mismatched tenantId → `execution_not_found`            | ❌ TODO |
| IT-4 | Project isolation — subscriber lacks `workflow:read` → `execution_not_found`             | ❌ TODO |
| IT-5 | Terminal event marks registry entry; entry evicted after `WF_WS_TERMINAL_GRACE_MS`       | ❌ TODO |
| IT-6 | Two pods: workflow executes on Pod A, subscriber on Pod B → events flow via Redis        | ❌ TODO |
| IT-7 | Registry at max capacity → `subscription_limit_reached` error                            | ❌ TODO |
| IT-8 | WebSocket close while running → subscription removed; no further messages                | ❌ TODO |

---

## E2E Test Scenarios (Planned — 0 shipped)

> Must exercise the real system via HTTP + WebSocket API. No mocks of codebase components.
> Lives in `apps/studio/e2e/workflows/`.

| ID    | Scenario                                                                                     | Status  |
| ----- | -------------------------------------------------------------------------------------------- | ------- |
| E2E-1 | Run workflow → Studio WS receives snapshot with `status: running` within 500 ms              | ❌ TODO |
| E2E-2 | Each step transition → Studio WS receives `workflow_step_status` delta with correct stepName | ❌ TODO |
| E2E-3 | Workflow completes → Studio WS receives `workflow_execution_status` with `status: completed` | ❌ TODO |
| E2E-4 | `WF_WS_ENABLED=false` → Studio falls back to polling and panel still works                   | ❌ TODO |
| E2E-5 | WS connect failure (wrong URL) → polling fallback activates within 1.5 s                     | ❌ TODO |
| E2E-6 | Human-task workflow paused → WS stays connected; resumes and delivers remaining deltas       | ❌ TODO |
| E2E-7 | Two concurrent debug panels for different executions → each receives only its own deltas     | ❌ TODO |

---

## Known Testing Gaps

| Gap     | Description                                                                        |
| ------- | ---------------------------------------------------------------------------------- |
| GAP-004 | No integration tests. Required before BETA. Needs real Redis in test harness.      |
| GAP-005 | No E2E tests. Required before BETA. Studio Playwright suite needs WS interception. |
| GAP-003 | Long-running HITL E2E (> 5 min) — time-accelerated harness or staging soak needed. |
