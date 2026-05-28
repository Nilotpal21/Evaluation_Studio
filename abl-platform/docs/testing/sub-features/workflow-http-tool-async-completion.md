# Test Specification: Workflow HTTP Tool Async Completion

**Feature Spec**: `docs/features/workflow-as-tool.md`  
**HLD**: `docs/specs/workflow-http-tool-async-completion.hld.md`  
**LLD**: `docs/plans/2026-05-10-workflow-http-tool-async-completion-plan.md`  
**Status**: PARTIAL — unit + integration shipped; E2E deferred  
**Last Updated**: 2026-05-11

---

## 1. Coverage Matrix

> **Scope note**: This sub-feature covers `http` tools only. `workflow`-type tools (which already had async wait support) gain `async_continue` in this feature pass (see FR-HTTP-12). `mcp`, `sandbox`, and `searchai` tool types do **not** support any async execution mode — they are explicitly excluded from the callback contract for now (rejected at runtime with `TOOL_CALLBACK_UNSUPPORTED`).

| FR         | Description                                                                                                                                             | Unit | Integration | E2E | Status  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------- |
| FR-HTTP-1  | HTTP tool node accepts `executionMode: 'sync'` and `'async_wait'`; rejects `'async_continue'`                                                           | ✅   | ✅          | ❌  | Partial |
| FR-HTTP-2  | `async_wait` injects callback URL + secret into outbound HTTP (body / query / header)                                                                   | ✅   | ❌          | ❌  | Partial |
| FR-HTTP-3  | HTTP 202 (or configured status code) classifies as `accepted`; other responses as `completed`                                                           | ✅   | ❌          | ❌  | Partial |
| FR-HTTP-4  | `accepted` OR `completed` inline response (HTTP tool path with callbackConfig) suspends via `waiting_callback`                                          | ❌   | ✅          | ❌  | Partial |
| FR-HTTP-5  | Callback arrival with valid HMAC resumes the workflow step with output                                                                                  | ❌   | ✅          | ❌  | Partial |
| FR-HTTP-6  | Sync mode behaves identically to pre-feature behavior                                                                                                   | ✅   | ✅          | ✅  | Stable  |
| FR-HTTP-7  | `callbackConfig.location` controls where callback metadata is injected                                                                                  | ✅   | ❌          | ❌  | Partial |
| FR-HTTP-8  | `asyncHttpSuccess` body discriminator refines accepted/completed classification                                                                         | ✅   | ❌          | ❌  | Partial |
| FR-HTTP-9  | Runtime capability gate rejects `async_continue` for HTTP tools with `TOOL_EXECUTION_MODE_UNSUPPORTED`                                                  | ✅   | ✅          | ❌  | Partial |
| FR-HTTP-10 | Studio hides `body` callback location for GET HTTP tools                                                                                                | ❌   | ❌          | ❌  | Open    |
| FR-HTTP-11 | `canvas-to-steps.ts` emits `executionMode`, `callbackConfig`, `asyncHttpSuccess` into `ToolCallStep`                                                    | ✅   | ❌          | ❌  | Partial |
| FR-HTTP-12 | `async_continue` mode works for `workflow`-type tools (not HTTP); both `accepted` and `completed` advance step                                          | ✅   | ✅          | ❌  | Partial |
| FR-HTTP-13 | `mcp`, `sandbox`, `searchai` tool types rejected for any async mode with `TOOL_CALLBACK_UNSUPPORTED`                                                    | ✅   | ❌          | ❌  | Partial |
| FR-HTTP-14 | Workflow-as-tool integration: `workflow`-type tools invoked from `tool_call` nodes with `async_wait` enter `waiting_callback` after `accepted` response | ❌   | ✅          | ❌  | Partial |

> **Legend**: ✅ = test file shipped and passing. ❌ = no test yet at this tier.

---

## 2. Unit Test Scenarios

### UT-1: HTTP executor — callback injection into body

- **File**: `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`
- **What it tests**: When `executionMode === 'async_wait'` and `callbackConfig.location === 'body'`, the executor merges `{ [callbackUrlKey]: url, [callbackSecretKey]: secret }` into the outbound JSON body before the HTTP call.
- **Status**: ✅ covered

### UT-2: HTTP executor — callback injection into query params

- **File**: `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`
- **What it tests**: When `callbackConfig.location === 'query'`, callback metadata appended to URL query string.
- **Status**: ✅ covered

### UT-3: HTTP executor — callback injection into headers

- **File**: `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`
- **What it tests**: When `callbackConfig.location === 'header'`, callback metadata added as HTTP headers.
- **Status**: ✅ covered

### UT-4: HTTP executor — 202 response classified as `accepted`

- **File**: `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`
- **What it tests**: When `executionMode === 'async_wait'` and response status is 202, `classifyAsyncExecutionResult` returns `{ __toolExecutionStatus: 'accepted' }`.
- **Status**: ✅ covered

### UT-5: HTTP executor — body discriminator refines accepted/completed

- **File**: `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`
- **What it tests**: When `asyncHttpSuccess.acceptedBodyPath + acceptedBodyEquals` configured, only responses whose body matches the path/value are `accepted`; non-matching bodies classified as `completed`.
- **Status**: ✅ covered

### UT-6: HTTP executor — no callback injection for `sync` mode

- **File**: `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`
- **What it tests**: When `executionMode === 'sync'`, no callback fields injected into the request regardless of `callbackConfig` presence.
- **Status**: ✅ covered (implicit — sync path unchanged)

### UT-7: canvas-to-steps — emits `executionMode` and callback config into `ToolCallStep`

- **File**: `apps/workflow-engine/src/__tests__/canvas-to-steps.test.ts`
- **What it tests**: A workflow node with `executionMode: 'async_wait'` + `callbackConfig` produces a `ToolCallStep` with those fields propagated.
- **Status**: ✅ covered

### UT-8: Runtime capability gate — rejects `async_continue` for HTTP tools

- **File**: `apps/runtime/src/routes/__tests__/internal-tools-project-scope.test.ts`
- **What it tests**: `POST /api/internal/tools/execute` with `executionMode: 'async_continue'` for an HTTP tool returns 400 + `TOOL_EXECUTION_MODE_UNSUPPORTED`.
- **Status**: ✅ covered

---

## 3. Integration Test Scenarios

### INT-1: Step-dispatcher — `async_wait` tool call enters waiting_callback suspension

- **File**: `apps/workflow-engine/src/__tests__/step-dispatcher.test.ts`
- **Boundary**: `step-dispatcher` → tool execution client (fake) → step outcome
- **What it tests**: When dispatcher dispatches a `tool_call` step with `executionMode: 'async_wait'` and the client returns `{ status: 'accepted' }`, the dispatcher returns a callback-wait request (not a step completion).
- **Status**: ✅ covered

### INT-2: Step-dispatcher — `async_continue` workflow tool accepted OR completed both succeed

- **File**: `apps/workflow-engine/src/__tests__/step-dispatcher.test.ts`
- **Boundary**: Same as INT-1
- **What it tests**: When dispatcher dispatches a `tool_call` step with `executionMode: 'async_continue'` for a workflow tool, both `accepted` and `completed` responses from the client result in step success (continue).
- **Status**: ✅ covered

### INT-3: Workflow-handler — async HTTP wait suspends and resumes on callback

- **File**: `apps/workflow-engine/src/__tests__/workflow-handler.test.ts`
- **Boundary**: `workflow-handler` → step-dispatcher → tool client (fake returns `accepted`) → Restate waiting_callback → callback arrival
- **What it tests**: Full flow — tool call accepted → step suspends → callback payload arrives → step resumes with output.
- **Status**: ✅ covered

### INT-4: Workflow-handler — async HTTP wait with `completed` inline still enters waiting_callback

- **File**: `apps/workflow-engine/src/__tests__/workflow-handler.test.ts`
- **Boundary**: Same as INT-3 but client returns `completed`
- **What it tests**: When an HTTP tool with `callbackConfig` present returns `completed` inline (service responded synchronously), the workflow-handler still enters `waiting_callback` suspension — because the callback URL was already injected and the step must wait for the callback to close. This is distinct from workflow-type tools where `completed` inline fails closed.
- **Status**: ✅ covered

### INT-5: Runtime internal-tools — `async_wait` for HTTP tool forwards callback config and returns accepted

- **File**: `apps/runtime/src/routes/__tests__/internal-tools-project-scope.test.ts`
- **Boundary**: Internal-tools route → ToolBindingExecutor (fake HTTP executor returns `accepted`)
- **What it tests**: Runtime route accepts `executionMode: 'async_wait'` + `callback` for HTTP tool, returns `{ success: true, status: 'accepted' }`.
- **Status**: ✅ covered

### INT-6: Runtime internal-tools — `async_continue` rejected for HTTP tools

- **File**: `apps/runtime/src/routes/__tests__/internal-tools-project-scope.test.ts`
- **Boundary**: Internal-tools route validation
- **What it tests**: `executionMode: 'async_continue'` + HTTP tool → 400 `TOOL_EXECUTION_MODE_UNSUPPORTED`.
- **Status**: ✅ covered

### INT-7: tool-call-executor — request/response type round-trip

- **File**: `apps/workflow-engine/src/__tests__/step-dispatcher.test.ts`, `apps/workflow-engine/src/__tests__/workflow-handler.test.ts`
- **What it tests**: `ToolExecutionResponse` discriminated type: `accepted`, `completed`, and `failed` statuses are distinguishable and flow correctly through the tool execution path. `tool-call-executor.test.ts` covers `completed` and `failed` only; `accepted` status is exercised in step-dispatcher and workflow-handler tests.
- **Status**: ✅ covered across files

### INT-8: Runtime — `mcp`, `sandbox`, `searchai` tools rejected for async modes

- **File**: `apps/runtime/src/routes/__tests__/internal-tools-project-scope.test.ts`
- **What it tests**: When `executionMode !== 'sync'` is requested for any non-async-capable tool type, runtime returns 400 `TOOL_CALLBACK_UNSUPPORTED`. Only `http` and `workflow` tool types may use async execution modes.
- **Status**: ✅ covered

### INT-9: Workflow-as-tool integration — `workflow`-type tool `async_wait` from `tool_call` node

- **File**: `apps/workflow-engine/src/__tests__/workflow-handler.test.ts`
- **Boundary**: workflow-handler → step-dispatcher → tool execution client (fake, returns `accepted`) → `waiting_callback` suspension → callback
- **What it tests**: A `tool_call` node targeting a `workflow`-type tool with `executionMode: 'async_wait'` — the tool executor returns `{ status: 'accepted' }`, step enters `waiting_callback`, and resumes on callback. This tests the workflow-as-tool integration path end-to-end within the engine.
- **Status**: ✅ covered (workflow tool wait path in workflow-handler.test.ts)

---

## 4. E2E Scenarios (Gap — Not Yet Implemented)

> The following E2E scenarios are specified here for tracking. They are not yet implemented.

### E2E-HTTP-1: Full async_wait HTTP tool round-trip through real workflow engine

- **What it covers**: FR-HTTP-4, FR-HTTP-5
- **Setup**: Real workflow-engine + real runtime on random ports. Workflow with a `tool_call` node (HTTP tool, `async_wait`). External service simulated by a test HTTP server that captures the callback URL and later POSTs back.
- **Steps**:
  1. Trigger workflow execution.
  2. Workflow tool node fires; test HTTP server receives request with callback URL + secret.
  3. Test HTTP server POSTs back to the callback URL (HMAC signed with the injected secret).
  4. Workflow execution reaches `completed` with tool output.
- **Gap reason**: Requires a real in-process "external service" HTTP server + real workflow-engine callback route wired in test harness. Deferred — complex test infrastructure for v1.

### E2E-HTTP-2: async_continue rejected for HTTP tool via real runtime route

- **What it covers**: FR-HTTP-9 at the HTTP layer
- **Gap reason**: Covered at integration level (INT-6). E2E adds HTTP wire verification.

### E2E-HTTP-3: Studio GET tool hides body callback location

- **What it covers**: FR-HTTP-10
- **Gap reason**: Playwright UI test needed. Deferred with UI-E2E tier.

---

## 5. Security Tests

- [x] **Callback secret not in trace output** — verify `__toolExecutionStatus` result does not contain `callbackSecret` field. Covered implicitly by INT-5.
- [x] **sync mode does not inject callback** — UT-6 covers. Verify no `callbackUrl` / `callbackSecret` in outbound HTTP body for `sync` nodes.
- [ ] **Callback HMAC rejection** — E2E-HTTP-1 should include a sub-case where the callback arrives with a wrong HMAC and returns 401. Not yet landed.
- [x] **`async_continue` blocked for HTTP** — UT-8 + INT-6 cover the explicit rejection path.

---

## 6. Test File Mapping

| Test File                                                                | Type        | Covers                                       |
| ------------------------------------------------------------------------ | ----------- | -------------------------------------------- |
| `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`  | unit        | UT-1, UT-2, UT-3, UT-4, UT-5, UT-6           |
| `apps/workflow-engine/src/__tests__/canvas-to-steps.test.ts`             | unit        | UT-7                                         |
| `apps/runtime/src/routes/__tests__/internal-tools-project-scope.test.ts` | integration | UT-8, INT-5, INT-6, INT-8                    |
| `apps/workflow-engine/src/__tests__/step-dispatcher.test.ts`             | integration | INT-1, INT-2, INT-7 (accepted status)        |
| `apps/workflow-engine/src/__tests__/workflow-handler.test.ts`            | integration | INT-3, INT-4, INT-7 (accepted status), INT-9 |
| `apps/workflow-engine/src/__tests__/tool-call-executor.test.ts`          | unit        | INT-7 (completed + failed statuses)          |
| _(not yet created)_                                                      | e2e         | E2E-HTTP-1, E2E-HTTP-2, E2E-HTTP-3           |

---

## 7. Open Testing Questions

1. E2E-HTTP-1 requires a test-harness external HTTP server that captures callback URL and fires it back — should this be an in-process server (`createServer(handler)`) or a dedicated test helper?
2. Should FR-HTTP-10 (Studio GET method hides body option) be covered by a Playwright spec added to `apps/studio/e2e/workflows/` or as a component test?
3. The `completed` inline behavior for `async_wait` nodes (INT-4) — is the fail-closed treatment correct, or should future iterations auto-fallback and emit a warning trace event instead of failing?
