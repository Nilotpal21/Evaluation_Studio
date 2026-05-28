# Test Specification: Workflow Async Completion (Polling + Push)

**Feature Spec**: `docs/features/sub-features/workflow-async-completion.md`
**HLD**: N/A (sub-feature of workflow-as-tool)
**LLD**: `docs/plans/2026-04-14-workflow-async-completion-impl-plan.md`
**Status**: IN PROGRESS
**Last Updated**: 2026-04-14

---

## 1. Coverage Matrix

| FR    | Description                                        | Unit | Integration | E2E | Manual | Status   |
| ----- | -------------------------------------------------- | ---- | ----------- | --- | ------ | -------- |
| FR-1  | Auto-inject `check_workflow_status` companion tool | ✅   | ❌          | ❌  | ❌     | PARTIAL  |
| FR-2  | Session-scoped execution ID validation             | ✅   | ❌          | ❌  | ❌     | PARTIAL  |
| FR-3  | Polling fallback chain (Redis → GET)               | ✅   | ❌          | ❌  | ❌     | PARTIAL  |
| FR-4  | callbackUrl set in triggerMetadata for async       | ✅   | ❌          | ❌  | ❌     | PARTIAL  |
| FR-5  | Internal callback endpoint with HMAC verification  | ✅   | ✅          | ✅  | ❌     | COVERED  |
| FR-6  | Push result persistence + session injection        | ✅   | ✅          | ✅  | ❌     | COVERED  |
| FR-7  | System message format for push results             | ✅   | ✅          | ❌  | ❌     | PARTIAL  |
| FR-8  | Async response enriched with polling instructions  | ✅   | ❌          | ❌  | ❌     | PARTIAL  |
| FR-9  | Internal signing key for agent-tool callbacks      | ✅   | ❌          | ✅  | ❌     | PARTIAL  |
| FR-10 | Telemetry for all completion paths                 | ❌   | ❌          | ❌  | ❌     | IMPLICIT |

## 2. E2E Test Scenarios (MANDATORY)

### E2E-1: Polling tool returns completed workflow output

- **Preconditions**: Runtime + workflow-engine running, active workflow with webhook trigger, async workflow tool registered
- **Steps**: 1. Start async workflow execution via agent tool call → get executionId 2. Wait for execution to complete 3. Agent calls `check_workflow_status(executionId)` 4. Assert response contains `{ status: 'completed', output: {...} }`
- **Expected Result**: Polling tool returns the completed execution output
- **Auth Context**: tenant + project + user session
- **Isolation Check**: Different session cannot poll the same executionId

### E2E-2: Push callback injects system message into active session

- **Preconditions**: Runtime + workflow-engine running, active WebSocket session, async workflow tool registered
- **Steps**: 1. Start async workflow execution → get executionId 2. Workflow completes → engine sends callback to runtime 3. Assert system message injected into conversation 4. Assert message format matches FR-7
- **Expected Result**: System message appears in conversation history with workflow output
- **Auth Context**: tenant + project + user session
- **Isolation Check**: Callback for different tenant is rejected

### E2E-3: Polling tool rejects cross-session executionId

- **Preconditions**: Two separate agent sessions in the same project
- **Steps**: 1. Session A starts async workflow → get executionId 2. Session B calls `check_workflow_status(executionId)` 3. Assert error response (not found / not authorized)
- **Expected Result**: Cross-session polling returns an error, not the execution data
- **Auth Context**: Same tenant + project, different user sessions
- **Isolation Check**: Core test — verifies session-level isolation

### E2E-4: Push callback persists to Redis when session inactive

- **Preconditions**: Runtime running, async workflow started, session ended (WebSocket disconnected)
- **Steps**: 1. Start async workflow execution → get executionId 2. End the session / disconnect 3. Workflow completes → engine sends callback 4. Assert Redis key `workflow:{tenantId}:async-result:{executionId}` exists with result 5. Resume/new session, call `check_workflow_status(executionId)` 6. Assert result retrieved from Redis
- **Expected Result**: Result persisted despite inactive session; retrievable via polling
- **Auth Context**: tenant + project + user
- **Isolation Check**: Redis key includes tenantId

### E2E-5: HMAC verification rejects tampered callback

- **Preconditions**: Runtime callback endpoint running
- **Steps**: 1. POST to `/api/internal/workflow-callback` with invalid HMAC signature 2. Assert 401 response 3. POST with correct HMAC 4. Assert 200 response and result processed
- **Expected Result**: Tampered callbacks rejected; valid callbacks accepted
- **Auth Context**: Internal service (HMAC, no tenant auth)
- **Isolation Check**: N/A — security test

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: CallbackDeliveryWorker resolves internal secret for agent-tool callbacks

- **Boundary**: workflow-engine CallbackDeliveryWorker → webhookSecret resolution
- **Setup**: Configure `INTERNAL_CALLBACK_SECRET` env var, create execution with `triggerMetadata.source: 'agent_tool'`
- **Steps**: Enqueue callback job → assert worker uses internal secret, not tenant secret
- **Expected Result**: HMAC signed with internal secret
- **Failure Mode**: Missing env var → callback delivery fails with clear error

### INT-2: Polling tool fallback chain (session cache → Redis → GET)

- **Boundary**: WorkflowStatusTool → Redis → workflow-engine API
- **Setup**: Start async execution, populate session cache
- **Steps**: 1. Poll with cache hit → assert fast response 2. Clear cache, set Redis key → poll again → assert Redis hit 3. Clear Redis → poll again → assert GET to engine
- **Expected Result**: Each fallback level works independently
- **Failure Mode**: All levels miss → return "execution not found"

### INT-3: Session message injection via conversation store

- **Boundary**: WorkflowCallbackHandler → ConversationStore → session
- **Setup**: Active session with conversation history
- **Steps**: Process push callback → assert system message appended to conversation
- **Expected Result**: Message appears in conversation history with correct format
- **Failure Mode**: Conversation store unavailable → log error, persist to Redis only

### INT-4: Async execution sets callbackUrl in triggerMetadata

- **Boundary**: WorkflowToolExecutor → workflow-engine execution API
- **Setup**: Async workflow tool binding registered
- **Steps**: Execute async tool → capture the POST body to workflow-engine
- **Expected Result**: `triggerMetadata.callbackUrl` = `{RUNTIME_URL}/api/internal/workflow-callback`
- **Failure Mode**: Missing `RUNTIME_URL` → no callbackUrl set, log warning

### INT-5: Redis async-result TTL enforcement

- **Boundary**: WorkflowCallbackHandler → Redis
- **Setup**: Process push callback → write Redis key
- **Steps**: Verify key exists → fast-forward TTL → verify key expired
- **Expected Result**: Key auto-expires after configured TTL
- **Failure Mode**: Redis down → result still in workflow-engine DB (polling fallback)

## 4. Unit Test Scenarios

### UT-1: Companion tool auto-registration logic

- **Module**: prompt-builder.ts `buildTools()`
- **Input**: IR with one async workflow tool, one sync workflow tool
- **Expected Output**: `check_workflow_status` tool present in tools list

### UT-2: Session-scoped executionId tracking

- **Module**: WorkflowToolExecutor
- **Input**: Two async executions → tracked IDs; query unknown ID
- **Expected Output**: Known IDs return true; unknown returns false

### UT-3: Async response enrichment

- **Module**: WorkflowToolExecutor async path
- **Input**: Async execution completes
- **Expected Output**: Response includes `message` field with polling instructions

### UT-4: System message formatting

- **Module**: WorkflowCallbackHandler
- **Input**: Completed execution result; failed execution result
- **Expected Output**: Message strings match FR-7 format

## 5. Security & Isolation Tests

- [ ] Cross-session polling returns error (not data) — E2E-3
- [ ] Cross-tenant callback payload rejected — HMAC mismatch
- [ ] Invalid HMAC signature returns 401 — E2E-5
- [ ] Missing HMAC headers return 401
- [ ] Replay protection (if x-callback-timestamp stale, reject)
- [ ] Internal callback endpoint not accessible via tenant auth (separate auth path)

## 6. Performance & Load Tests (if applicable)

Not required for v1. Push callback adds <100ms per execution. Polling is agent-driven (one call per LLM turn).

## 7. Test Infrastructure

- **Required services**: Runtime (port 3112), Workflow-Engine (port 9080), Redis, MongoDB
- **Data seeding**: Active workflow with webhook trigger, async mode
- **Environment variables**: `INTERNAL_CALLBACK_SECRET`, `RUNTIME_URL`, `ASYNC_RESULT_TTL_HOURS`
- **CI configuration**: Existing Playwright + Vitest setup

## 8. Test File Mapping

| Test File                                                                | Type        | Covers                                     | Tests |
| ------------------------------------------------------------------------ | ----------- | ------------------------------------------ | ----- |
| `apps/runtime/src/__tests__/workflow-status-tool.test.ts`                | unit        | FR-2, FR-3                                 | 9     |
| `apps/runtime/src/__tests__/workflow-callback-handler.test.ts`           | unit        | FR-5, FR-6, FR-7, GAP-005/6                | 17    |
| `apps/runtime/src/__tests__/workflow-async-callback.integration.test.ts` | integration | FR-5, FR-6, FR-7, GAP-005                  | 10    |
| `apps/runtime/src/__tests__/workflow-tool-executor.test.ts`              | unit        | FR-2, FR-4, FR-8                           | 11    |
| `apps/runtime/src/__tests__/routing/prompt-builder.test.ts`              | unit        | FR-1                                       | 2     |
| `apps/workflow-engine/src/__tests__/callback-delivery-internal.test.ts`  | unit        | FR-9                                       | 6     |
| `apps/runtime/src/__tests__/workflow-async-completion.e2e.test.ts`       | e2e         | FR-5, FR-6, FR-9, E2E-2/3/4/5, GAP-005/008 | 9     |

## 9. Open Testing Questions

1. ~~How to simulate session disconnect/reconnect reliably in E2E tests?~~ — Resolved: callback endpoint handles nonexistent sessions gracefully (returns 200 with injected=false)
2. ~~Should the push callback E2E test use the real `CallbackDeliveryWorker` or POST directly to the callback endpoint?~~ — Resolved: POST directly with HMAC signatures (same as production callback delivery)
3. FR-10 telemetry is implicitly covered — all code paths that emit telemetry events are exercised by existing tests, but dedicated assertions are not possible without mocking the platform logger (forbidden by CLAUDE.md)
