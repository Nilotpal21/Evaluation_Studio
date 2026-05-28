# LLD: Workflow HTTP Tool Async Completion

**Feature Spec**: `docs/features/workflow-as-tool.md`  
**HLD**: `docs/specs/workflow-http-tool-async-completion.hld.md`  
**Test Spec**: `docs/testing/sub-features/workflow-http-tool-async-completion.md`  
**Related Sub-Feature**: `docs/features/sub-features/workflow-async-completion.md`  
**Status**: IMPLEMENTED  
**Date**: 2026-05-10  
**Implemented**: 2026-05-11

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Rationale                                                                                                                                    | Alternatives Rejected                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| D-1  | Scope this item to `http` tools invoked from workflow `tool_call` nodes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `workflow` tools already support callback-based waiting; `mcp`, `sandbox`, and `searchai` do not have an async job/callback contract today.  | “All tools” in one pass.                                      |
| D-2  | Put async execution mode on the workflow tool node config, not on the HTTP tool DSL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | This is a workflow-orchestration choice: the same HTTP tool may be called synchronously in one workflow and asynchronously in another.       | Binding-owned async mode.                                     |
| D-3  | Put HTTP callback injection rules on the workflow tool node config as well, but only for `tool_call` workflow usage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | This keeps the feature workflow-local as requested and avoids mutating general-purpose tool DSL for non-workflow callers.                    | Persist callback injection rules on the tool definition.      |
| D-4  | Replace the binary `waitForCompletion` model with an explicit node execution mode: `sync`, `async_continue`, `async_wait`. **Implementation deviation**: HTTP tools were restricted to `sync` and `async_wait` only; `async_continue` is supported only for `workflow`-type tools. The original plan allowed all three for HTTP, but `async_continue` and `sync` are semantically equivalent for HTTP (both return immediately to the workflow after the call), so `async_continue` was removed from the HTTP path to reduce surface area and avoid confusion. The runtime now explicitly rejects `async_continue` with `TOOL_EXECUTION_MODE_UNSUPPORTED` for HTTP tools. | Keep only `waitForCompletion` and infer the rest.                                                                                            |
| D-5  | Reuse workflow-engine’s existing `waiting_callback` route, per-step callback secret generation, and Restate promise wake-up path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | The callback route, signing, persistence, and timeout behavior are already built and working.                                                | Add an HTTP-specific callback endpoint.                       |
| D-6  | Extend Runtime internal tool execution to return a discriminated result: `completed`, `accepted`, or `failed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Workflow-engine must distinguish “tool finished now” from “tool accepted async work and will callback later”.                                | Continue overloading the current immediate result shape.      |
| D-7  | Capability-gate async modes to `workflow` and `http` tools only; reject all other tool types explicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Prevents Studio and Runtime from advertising a mode the executor cannot honor.                                                               | Soft-fail at execution time or silently ignore async config.  |
| D-8  | Treat async HTTP success as “accepted” only when the downstream response matches a narrow configured acceptance contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Avoids incorrectly suspending parent workflows on ordinary synchronous `200` responses.                                                      | Assume any `2xx` means async accepted.                        |
| D-9  | Require both callback URL and callback secret injection for every async HTTP tool.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | The parent callback route authenticates with the per-step secret; shipping async HTTP without secret propagation creates an unsafe contract. | Make `callbackSecretKey` optional.                            |
| D-10 | In `async_continue`, treat either downstream `accepted` or downstream terminal `completed` as a successful step outcome.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Fire-and-continue only needs successful handoff or immediate terminal success; it does not need to suspend.                                  | Require `accepted` only for `async_continue`.                 |
| D-11 | Do not carry a legacy `waitForCompletion` compatibility lane in this plan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | You confirmed this config is not deployed yet, so there is no persisted-shape compatibility requirement.                                     | Run both `waitForCompletion` and `executionMode` in parallel. |

### Key Interfaces & Types

```typescript
// packages/shared/src/types/workflow-schemas.ts
type ToolNodeExecutionMode = 'sync' | 'async_continue' | 'async_wait';

type ToolNodeCallbackLocation = 'body' | 'query' | 'header';

interface ToolNodeCallbackConfig {
  enabled: boolean;
  location: ToolNodeCallbackLocation;
  callbackUrlKey: string;
  callbackSecretKey: string;
}

interface ToolNodeAsyncHttpSuccessConfig {
  acceptedStatusCodes?: number[]; // default [202]
  acceptedBodyPath?: string; // optional JSONPath to boolean/string discriminator
  acceptedBodyEquals?: string;
}

interface ToolNodeConfig {
  toolId?: string;
  toolName?: string;
  params: Record<string, string>;
  timeout: number;
  executionMode?: ToolNodeExecutionMode;
  callbackConfig?: ToolNodeCallbackConfig; // honored only for http tools
  asyncHttpSuccess?: ToolNodeAsyncHttpSuccessConfig; // honored only for http tools
}

// apps/workflow-engine/src/executors/tool-call-executor.ts
interface ToolCallStep {
  id: string;
  type: 'tool_call';
  toolName: string;
  params: Record<string, string>;
  timeout?: number;
  executionMode?: ToolNodeExecutionMode;
  callbackConfig?: ToolNodeCallbackConfig;
  asyncHttpSuccess?: ToolNodeAsyncHttpSuccessConfig;
}

// apps/workflow-engine/src/executors/tool-call-executor.ts
interface ToolExecutionRequest {
  toolName: string;
  params: Record<string, unknown>;
  tenantId: string;
  projectId: string;
  actorUserId?: string;
  timeout?: number;
  executionMode?: ToolNodeExecutionMode;
  callback?: { url: string; secret: string };
  callbackConfig?: ToolNodeCallbackConfig;
  asyncHttpSuccess?: ToolNodeAsyncHttpSuccessConfig;
}

type ToolExecutionResponse =
  | { success: true; status: 'completed'; output: unknown }
  | { success: true; status: 'accepted'; output: unknown }
  | { success: false; status: 'failed'; error: { code: string; message: string } };
```

### Module Boundaries

| Module                                                                      | Responsibility                                                                                                             | Depends On                                           |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `packages/shared/src/types/workflow-schemas.ts`                             | Canonical workflow-node config shape for tool async modes and callback injection.                                          | `zod`                                                |
| `apps/studio/src/components/workflows/canvas/config/GenericNodeConfig.tsx`  | Tool node UI, gating by selected tool type, migration from legacy `waitForCompletion`.                                     | Workflow schemas, tool metadata APIs                 |
| `apps/workflow-engine/src/handlers/canvas-to-steps.ts`                      | Converts persisted workflow-node config into `ToolCallStep` IR with explicit execution mode and callback config.           | Workflow schemas, step types                         |
| `apps/workflow-engine/src/handlers/step-dispatcher.ts`                      | Branches tool execution into sync, async-continue, or async-wait paths.                                                    | Tool executor client, callback URL builder           |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`                     | Reuses existing callback-secret generation, `waiting_callback`, timeout, and wake-up logic for async HTTP tools.           | Step dispatcher, Restate, callback route             |
| `apps/runtime/src/routes/internal-tools.ts`                                 | Validates async tool capability, forwards execution mode/config, and maps executor result to the workflow-engine contract. | Project tool loader, Runtime executors               |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` | Injects callback URL/secret into outbound HTTP request and classifies sync vs accepted async response.                     | Safe fetch, auth middleware, HTTP binding resolution |

---

## 2. File-Level Change Map

### New Files

| File                                                               | Purpose                                                                                                   | LOC Estimate |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------ |
| `docs/testing/sub-features/workflow-http-tool-async-completion.md` | Dedicated test spec for the HTTP async callback path if the existing parent test guide becomes too broad. | 180          |

### Modified Files

| File                                                                           | Change Description                                                                                                    | Risk   |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------ |
| `packages/shared/src/types/workflow-schemas.ts`                                | Replace `waitForCompletion` with `executionMode`, `callbackConfig`, and `asyncHttpSuccess` in `ToolNodeConfigSchema`. | Medium |
| `apps/studio/src/components/workflows/canvas/config/GenericNodeConfig.tsx`     | Show async mode controls for `http` and `workflow` tools only; show callback injection fields only for `http`.        | Medium |
| `apps/workflow-engine/src/handlers/canvas-to-steps.ts`                         | Emit explicit `executionMode`, callback config, and acceptance config into `ToolCallStep`.                            | Low    |
| `apps/workflow-engine/src/executors/tool-call-executor.ts`                     | Extend request/response types for discriminated internal-tool results and async config forwarding.                    | Medium |
| `apps/workflow-engine/src/handlers/step-dispatcher.ts`                         | Generalize `tool_call` dispatch from boolean wait to explicit mode handling.                                          | High   |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`                        | Reuse the callback-secret generation/persistence path for async HTTP tools and normalize accepted callback payloads.  | High   |
| `apps/runtime/src/routes/internal-tools.ts`                                    | Remove workflow-only callback restriction; capability-gate by tool type + requested execution mode.                   | High   |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`    | Add async callback injection + accepted-result classification.                                                        | High   |
| `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` | Thread new per-call execution metadata into HTTP executor entry points without affecting other executors.             | Medium |
| `apps/runtime/src/routes/__tests__/internal-tools-project-scope.test.ts`       | Extend coverage for HTTP async acceptance and unsupported-tool rejection.                                             | Medium |
| `apps/workflow-engine/src/__tests__/step-dispatcher.test.ts`                   | Cover `sync`, `async_continue`, `async_wait` tool-call branching.                                                     | Medium |
| `apps/workflow-engine/src/__tests__/tool-call-executor.test.ts`                | Cover discriminated internal-tool response contract.                                                                  | Low    |
| `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`        | Cover callback injection and accepted-response classification.                                                        | Medium |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Workflow Node Contract

**Goal**: Introduce a workflow-node-owned async execution contract for tool nodes using explicit execution modes.

**Tasks**:
1.1. Extend `ToolNodeConfigSchema` with `executionMode`, `callbackConfig`, and `asyncHttpSuccess`.
1.2. Update Studio tool-node config to:

- show execution mode for `http` and `workflow` tools only
- hide async controls for sync-only tools
- show callback injection config only when selected tool type is `http` and execution mode is async
  1.3. Add local validation rules:
- `callbackUrlKey` required when `executionMode !== 'sync'` for HTTP tools
- `callbackSecretKey` required when `executionMode !== 'sync'` for HTTP tools
- `callbackConfig` forbidden for non-HTTP tools
- `asyncHttpSuccess` forbidden when `executionMode === 'sync'`
  1.4. Update `canvas-to-steps.ts` to emit explicit `executionMode`.

**Files Touched**:

- `packages/shared/src/types/workflow-schemas.ts`
- `apps/studio/src/components/workflows/canvas/config/GenericNodeConfig.tsx`
- `apps/workflow-engine/src/handlers/canvas-to-steps.ts`

**Exit Criteria**:

- [ ] Tool node schema persists explicit `executionMode` with no legacy boolean fallback.
- [ ] Studio shows async controls only for `http` and `workflow` tools.
- [ ] Sync HTTP tools do not render callback fields.
- [ ] Async HTTP tools require both callback URL key and callback secret key.
- [ ] `pnpm build --filter=@agent-platform/workflow-engine` succeeds.

**Test Strategy**:

- Unit: schema parse/validation tests for `ToolNodeConfigSchema`.
- Component/unit: `GenericNodeConfig` mode gating and reset behavior.
- Unit: `canvas-to-steps` conversion for explicit execution modes.

**Rollback**: Revert the schema/UI/converter changes.

---

### Phase 2: Workflow-Engine Tool Call Generalization

**Goal**: Generalize `tool_call` from boolean wait semantics to explicit sync / async-continue / async-wait behavior.

**Tasks**:
2.1. Extend `ToolCallStep` and `ToolExecutionClient.executeTool()` payloads with `executionMode`, `callbackConfig`, and `asyncHttpSuccess`.
2.2. Update `dispatchStep('tool_call')`:

- `sync` → execute immediately and expect `status: 'completed'`
- `async_continue` → execute immediately and accept either `completed` or `accepted` as a successful step outcome
- `async_wait` → require Runtime to return `accepted`, then enter callback suspension
  2.3. Reuse the existing callback-secret generation, encrypted persistence, `step.waiting_callback` notification, and Restate promise path for `async_wait`.
  2.4. Add explicit error handling:
- `async_wait` + Runtime returns `completed` unexpectedly → fail closed
- `async_wait` + Runtime returns `accepted` without callback config for HTTP → fail closed
- `async_continue` + Runtime returns `failed` → fail the step immediately
  2.5. Normalize callback payload for async HTTP completion to the same terminal shape already handled for workflow-tool waits.

**Files Touched**:

- `apps/workflow-engine/src/executors/tool-call-executor.ts`
- `apps/workflow-engine/src/handlers/step-dispatcher.ts`
- `apps/workflow-engine/src/handlers/workflow-handler.ts`
- `apps/workflow-engine/src/context/step-context-schema.ts` if callback payload normalization needs extra stored fields

**Exit Criteria**:

- [ ] `tool_call` dispatch supports all three execution modes.
- [ ] Existing workflow-tool wait path still passes under explicit `executionMode`.
- [ ] Async HTTP wait path stores encrypted callback secret and reaches `waiting_callback`.
- [ ] `pnpm build --filter=@agent-platform/workflow-engine` succeeds.

**Test Strategy**:

- Unit: step dispatcher mode matrix.
- Unit: tool-call executor request/response typing.
- Integration: workflow handler wait/resume path for accepted async tool responses.

**Rollback**: Revert the explicit execution-mode plumbing.

---

### Phase 3: Runtime Internal Tool Contract

**Goal**: Make Runtime internal-tool execution capability-aware and explicit about `completed` vs `accepted`.

**Tasks**:
3.1. Extend `/api/internal/tools/execute` request schema to accept:

- `executionMode`
- `callback`
- `callbackConfig`
- `asyncHttpSuccess`
  3.2. Remove the hard-coded “workflow only” callback restriction and replace it with capability gating:
- `workflow` supports `sync`, `async_continue`, `async_wait` (workflow-as-tool integration: all three modes; `callbackConfig` and `asyncHttpSuccess` ignored for workflow tools)
- `http` supports `sync` and `async_wait` only (`async_continue` explicitly rejected with `TOOL_EXECUTION_MODE_UNSUPPORTED`)
- `mcp`, `sandbox`, `searchai` support `sync` only — explicitly excluded from the async callback contract; rejected with `TOOL_CALLBACK_UNSUPPORTED` for any non-sync mode
  3.3. Return a discriminated response:
- `completed`
- `accepted`
- `failed`
  3.4. Preserve existing auth-profile middleware and actor-user propagation for HTTP tools.
  3.5. Add logging/trace fields that distinguish:
- requested execution mode
- selected tool type
- executor result status

**Files Touched**:

- `apps/runtime/src/routes/internal-tools.ts`
- `apps/runtime/src/routes/__tests__/internal-tools-project-scope.test.ts`
- any Runtime-side type declarations co-located with the route

**Exit Criteria**:

- [ ] Runtime returns `TOOL_CALLBACK_UNSUPPORTED` only for truly unsupported tool types/modes.
- [ ] Runtime returns `accepted` for async HTTP tools when downstream acceptance criteria match.
- [ ] Existing workflow-tool callers still pass unchanged.
- [ ] Focused Runtime route tests pass.

**Test Strategy**:

- Integration: internal-tools route with real tool loading and mocked executor outputs.
- Regression: workflow-tool async wait behavior remains unchanged.

**Rollback**: Restore workflow-only callback gating and the old immediate-result contract.

---

### Phase 4: HTTP Executor Async Callback Path

**Goal**: Teach the HTTP executor to send callback metadata to downstream services and classify accepted async responses safely.

**Tasks**:
4.1. Extend the HTTP executor call path to receive workflow-node async metadata for a single execution without mutating the underlying tool DSL.
4.2. Inject callback metadata into the outbound request according to `callbackConfig`:

- `body` → add `callbackUrlKey` / `callbackSecretKey` into JSON body
- `query` → append query params
- `header` → add headers
  4.3. Keep all existing SSRF, header sanitization, auth, and safe-fetch protections intact.
  4.4. Classify downstream responses:
- `completed` when sync response is terminal
- `accepted` only when status/body match `asyncHttpSuccess`
- `failed` on any explicit downstream error
  4.5. Document the required downstream callback contract:
- callback target is `/api/v1/workflows/callbacks/:executionId/:stepId`
- HMAC uses the per-step secret already generated by workflow-engine

**Files Touched**:

- `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`
- `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts`
- `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`

**Exit Criteria**:

- [ ] Async HTTP callback URL and secret can be injected into body, query, or header.
- [ ] Ordinary sync `200` responses do not accidentally become `accepted`.
- [ ] HTTP executor tests cover acceptance misclassification regressions.
- [ ] Relevant package build passes.

**Test Strategy**:

- Unit: injection location permutations.
- Unit/integration: accepted status/body classification and failure cases.

**Rollback**: Revert HTTP async-path code and keep HTTP tools sync-only in workflows.

---

### Phase 5: End-to-End Hardening

**Goal**: Prove the full workflow-parent → Runtime → downstream HTTP service → callback → parent-resume path and document operational constraints.

**Tasks**:
5.1. Add workflow-engine integration coverage for:

- HTTP async continue
- HTTP async wait success
- HTTP async wait timeout
- HTTP async wait invalid signature
- HTTP async wait callback payload with terminal failure
  5.2. Add Runtime integration coverage for accepted/completed mapping.
  5.3. Update testing docs and feature-doc references if this follow-on becomes a formal sub-feature.
  5.4. Document rollout order:
- Runtime route/executor support
- workflow-engine execution-mode support
- Studio UI exposure

**Files Touched**:

- `apps/workflow-engine/src/__tests__/e2e-advanced.test.ts` or a dedicated integration suite
- `apps/runtime/src/routes/__tests__/internal-tools-project-scope.test.ts`
- `docs/testing/sub-features/workflow-http-tool-async-completion.md` if created

**Exit Criteria**:

- [ ] End-to-end async HTTP wait test passes against the real callback route.
- [ ] Invalid callback signature is rejected with `401`.
- [ ] Timeout path fails the parent step and does not leak callback secrets.
- [ ] Docs reflect the final node config contract.

**Test Strategy**:

- Integration/E2E only.

**Rollback**: Hide the Studio async HTTP controls and keep Runtime capability-gated to workflow tools only.

---

## 4. Wiring Checklist

- [x] `ToolNodeConfigSchema` exports the new async fields with no legacy wait boolean.
- [x] `GenericNodeConfig` writes `executionMode` back into persisted workflow JSON.
- [x] `canvas-to-steps.ts` threads the new fields into `ToolCallStep`.
- [x] `ToolCallStep` and `ToolExecutionClient` types stay aligned.
- [x] `dispatchStep('tool_call')` passes callback metadata only for `async_wait`.
- [x] `workflow-handler.ts` publishes `step.waiting_callback` for async HTTP waits.
- [x] `/api/internal/tools/execute` validates and forwards async HTTP config.
- [x] `ToolBindingExecutor` hands per-call async config to `HttpToolExecutor`.
- [x] Callback route remains the only parent-resume endpoint.
- [x] Tests cover `sync`, `async_continue` (workflow tools), and `async_wait`.

---

## 5. Cross-Phase Concerns

### Compatibility / Migration

- No legacy `waitForCompletion` compatibility lane is required for this item.
- Studio and workflow persistence should use only explicit `executionMode`.

### Security

- Callback secrets remain per-step, workflow-engine-generated, encrypted at rest, and verified only at callback receipt.
- HTTP executor must not bypass `safeFetch`, SSRF blocking, auth-profile middleware, or header sanitization when injecting callback metadata.
- Do not write callback secrets into trace payloads, Studio execution payloads, or public step serialization.

### Runtime Classification

- The plan assumes a configured acceptance contract, not a blanket `2xx === accepted`.
- Default acceptance should be narrow:
  - status code `202`
  - optional body discriminator only when explicitly configured
- In `async_continue`, both Runtime `accepted` and Runtime terminal `completed` are treated as successful step completion.

### Configuration Changes

- No new global env vars are required for the core feature.
- Existing callback base URL requirements remain:
  - workflow-engine must expose a reachable `WORKFLOW_ENGINE_PUBLIC_URL` in environments where downstream HTTP services need to callback from outside the cluster/pod network.

---

## 6. Acceptance Criteria

- [x] A workflow tool node can invoke an HTTP tool in `sync` or `async_wait` mode (deviation from original: `async_continue` removed from HTTP path).
- [x] The node, not the HTTP tool DSL, owns the async orchestration mode.
- [x] Every async HTTP tool configuration requires both callback URL and callback secret injection keys.
- [x] Async HTTP wait reuses the existing workflow callback route and per-step callback secret flow.
- [x] Runtime internal-tools returns explicit `completed` vs `accepted`.
- [x] Unsupported tool types cannot enable async callback modes; HTTP + `async_continue` explicitly rejected.
- [x] `async_continue` succeeds on either downstream `accepted` or downstream terminal `completed` (for workflow-type tools).
- [x] Existing workflow-tool async wait behavior continues to pass under explicit `executionMode`.
- [x] No callback secrets leak through workflow execution APIs or Studio execution views.
- [x] Focused package builds and tests for workflow-engine, runtime, and compiler paths pass.

---

## 8. Post-Implementation Notes

**Status**: IMPLEMENTED (commits `cb0d3fbfc2`, `0b325cfcc1`, `3819788007`, `51e3a171ce`).

### Deviations from Original Plan

**D-4: HTTP async_continue removed**  
The plan originally specified that HTTP tools would support `sync`, `async_continue`, and `async_wait`. During implementation it became clear that `async_continue` and `sync` are semantically equivalent for HTTP tools — both return immediately to the parent workflow without suspending, so there is no observable behavioral difference between them. Keeping `async_continue` for HTTP would create a confusing API surface. Decision: HTTP tools support only `sync` and `async_wait`. `async_continue` is preserved exclusively for `workflow`-type tools where the distinction is meaningful (fire + inject callback URL vs plain fire). The runtime route (`apps/runtime/src/routes/internal-tools.ts`) now explicitly rejects `async_continue` for HTTP tools with error code `TOOL_EXECUTION_MODE_UNSUPPORTED`.

**Studio UI: technical labels**  
The original plan assumed user-friendly execution mode labels (e.g., "Run synchronously", "Wait for callback"). The shipped UI uses technical labels (`sync`, `async_wait`, `async_continue`) in execution mode dropdowns. Rationale: these are workflow orchestration configuration fields targeted at builders who understand the tool execution contract.

**Studio UI: GET method hides body callback location**  
An additional Studio improvement was made: when the selected HTTP tool uses the `GET` method (derived from its DSL), the callback location dropdown hides the `body` option (since GET requests have no body). The available options become `query` and `header` only. The selected HTTP method is derived via `parseDslProperties(tool.dslContent).method` at tool-select time and stored in local React state (`selectedHttpMethod`).

**Callback injection guard tightened**  
In `http-tool-executor.ts`, the callback injection guard was tightened from `executionMode !== 'sync'` (original: would inject for `async_continue` and `async_wait`) to `executionMode === 'async_wait'` (inject only when the workflow is suspending to wait). This prevents callback metadata from being injected for fire-and-continue tool nodes.

### Actual Files Touched

| File                                                                           | Change                                                                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/types/workflow-schemas.ts`                                | `ToolNodeExecutionMode`, `ToolNodeCallbackConfig`, `ToolNodeAsyncHttpSuccessConfig` added to `ToolNodeConfigSchema` |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`    | Callback injection + `AsyncHttpExecutionResult` classification                                                      |
| `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` | Per-call `executionOptions` threading to HTTP executor                                                              |
| `packages/compiler/src/platform/constructs/executors/tool-middleware.ts`       | `AsyncHttpExecutionResult` type pass-through                                                                        |
| `apps/workflow-engine/src/handlers/canvas-to-steps.ts`                         | Emit `executionMode`, `callbackConfig`, `asyncHttpSuccess` into `ToolCallStep`                                      |
| `apps/workflow-engine/src/executors/tool-call-executor.ts`                     | Discriminated request/response types                                                                                |
| `apps/workflow-engine/src/handlers/step-dispatcher.ts`                         | Sync/async-continue/async-wait branching for tool_call steps                                                        |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`                        | Callback secret generation + waiting_callback for async HTTP                                                        |
| `apps/workflow-engine/src/index.ts`                                            | Export updates                                                                                                      |
| `apps/runtime/src/routes/internal-tools.ts`                                    | Capability gating; `async_continue` rejection for HTTP; discriminated response                                      |
| `apps/studio/src/components/workflows/canvas/config/GenericNodeConfig.tsx`     | Execution mode dropdowns; GET-method callback location filter; technical labels                                     |
| Test files across all four packages                                            | Unit + integration coverage for new modes                                                                           |

---

## 7. Open Questions

1. Do we need a Studio-side preset list for common callback field names (`callback_url`, `webhook_url`, `X-Callback-Url`) to reduce config mistakes?
2. Do we want a dedicated sub-feature/test-spec doc for this HTTP follow-on, or should the parent workflow-as-tool docs absorb it directly?
