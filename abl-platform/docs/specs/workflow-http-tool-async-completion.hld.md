# HLD: Workflow HTTP Tool Async Completion

**Feature Spec**: `docs/features/workflow-as-tool.md`  
**LLD**: `docs/plans/2026-05-10-workflow-http-tool-async-completion-plan.md`  
**Test Spec**: `docs/testing/sub-features/workflow-http-tool-async-completion.md`  
**Status**: IMPLEMENTED  
**Author**: Sriram Elluru  
**Date**: 2026-05-10  
**Implemented**: 2026-05-11

---

## 1. Overview / Goal

Extend workflow `tool_call` nodes to invoke HTTP tools asynchronously — letting a workflow suspend until an external HTTP service completes its job and calls back, rather than blocking a synchronous HTTP response. This generalizes the existing workflow-tool async wait path to cover HTTP tools as well.

**Before this feature**: workflow `tool_call` nodes could only invoke tools synchronously (block on HTTP response) or with the workflow-tool async wait path (suspend until workflow engine callbacks). HTTP tools had no native async path from workflow context.

**After this feature**: HTTP tools gain two orchestration modes when invoked from a workflow node:

- `sync` — invoke and return immediately with the HTTP response (existing behavior, unchanged).
- `async_wait` — inject a callback URL + secret into the outbound HTTP request, suspend the parent workflow step, and resume when the external service POSTs back.

`async_continue` (fire + inject callback without suspending) is supported for `workflow`-type tools only, where the distinction from `sync` is semantically meaningful.

---

## 2. Problem Statement

Workflow builders who want to invoke long-running external services from a workflow step face a mismatch: HTTP tool nodes execute synchronously (wait for the HTTP response before continuing), but many downstream services — document processing pipelines, approval systems, external job queues — accept a request and complete asynchronously, delivering the result via webhook. Without async support, builders must either (a) poll the external service by chaining multiple tool nodes, (b) accept a fire-and-forget model with no result visible to the workflow, or (c) restructure the entire workflow around webhook-triggered re-entry.

---

## 3. Alternatives Considered

### Option A: Node-owned execution mode with callback injection (RECOMMENDED — SHIPPED)

- **Description**: Add an `executionMode` field to the workflow tool node config (`ToolNodeConfigSchema`). For `async_wait`, the workflow engine generates a per-step callback secret, injects the callback URL and secret into the outbound HTTP request (body / query param / header, configurable), and reuses the existing `waiting_callback` Restate promise path to suspend the step. The runtime internal-tools route returns a discriminated `accepted` / `completed` result to tell the engine whether the step finished now or was handed off.
- **Pros**: Reuses the existing callback infrastructure (secret generation, encrypted persistence, HMAC verification, timeout path) with zero new endpoints. The same workflow node already supports `async_wait` for workflow-type tools — extending to HTTP is additive. Minimal blast radius: one new field on `ToolNodeConfigSchema`, one new branch in `step-dispatcher.ts`, one new behavior in `http-tool-executor.ts`.
- **Cons**: Requires the HTTP executor to carry per-call execution options without mutating the tool DSL — threaded via `executionOptions` at call time.
- **Effort**: M

### Option B: HTTP-tool-DSL-owned async mode

- **Description**: Add an `asyncMode` field to the HTTP tool definition's DSL (`type: http / ... / async_mode: async_wait`). The runtime always injects callback metadata when the tool is invoked.
- **Pros**: Simpler UI — one setting on the tool definition, applies everywhere the tool is used.
- **Cons**: Violates D-2 (this is a workflow-orchestration choice, not a tool-definition concern). The same HTTP tool may be called synchronously in one workflow and asynchronously in another. Embedding the async mode in the DSL conflates "how the tool behaves" with "how the workflow calls it". Also complicates the runtime's behavior for non-workflow callers (e.g., agent direct tool calls) that have no concept of workflow callbacks.
- **Effort**: M

### Option C: Dedicated async HTTP node type

- **Description**: Add a new `async_http_call` node type to the workflow DSL that encapsulates the callback injection + suspension logic.
- **Pros**: Clean separation; no behavior change to existing `tool_call` nodes.
- **Cons**: Duplicates the entire `tool_call` surface for one new behavior. Breaks backward compatibility for any builder who switches from sync to async by just changing a setting. Adds a new IR node type to maintain.
- **Effort**: L

### Recommendation: **Option A** (shipped)

---

## 4. Architecture

### System Context

```
┌──────────────────┐    tool node     ┌────────────────────┐   callback POST    ┌─────────────────────┐
│  Workflow Engine │ ──────────────►  │   apps/runtime     │ ◄─────────────────  │  External HTTP      │
│  (Restate)       │   executeTool()  │   internal-tools   │                     │  Service            │
└──────────────────┘                  └────────────────────┘                     └─────────────────────┘
       │                                       │                                          │
       │ suspend step                          │ inject callback                          │
       │ (waiting_callback)                    │ URL + secret                             │
       │                                       ▼                                          │
       │                              ┌────────────────────┐                             │
       │                              │  @abl/compiler     │ ──── outbound HTTP ────────►│
       │                              │  http-tool-        │                             │
       │                              │  executor.ts       │◄────── HTTP 202 ────────────┤
       │                              └────────────────────┘    (accepted)               │
       │                                                                                  │
       │◄─────────────────────────────── callback POST (HMAC signed) ───────────────────┘
       │  resume step with output
```

### Execution Modes

| Mode             | HTTP tool                                       | Workflow tool                                             | MCP / Sandbox / SearchAI | Workflow step behavior                    |
| ---------------- | ----------------------------------------------- | --------------------------------------------------------- | ------------------------ | ----------------------------------------- |
| `sync`           | ✅ Execute, return response body                | ✅ POST → poll → return output                            | ✅ (only supported mode) | Continue immediately                      |
| `async_wait`     | ✅ Inject callback, classify response           | ✅ POST → return executionId; suspend until callback      | ❌ Not supported         | Suspend; resume on callback or timeout    |
| `async_continue` | ❌ Rejected (`TOOL_EXECUTION_MODE_UNSUPPORTED`) | ✅ POST → return executionId; continue without suspending | ❌ Not supported         | Continue immediately regardless of result |

> **Excluded tool types**: `mcp`, `sandbox`, and `searchai` tools do **not** support any async execution mode. They are explicitly excluded from the callback contract in this version — these tool types have no standardized async job/callback contract today. Requests with `executionMode !== 'sync'` for these types are rejected at the runtime route with `TOOL_CALLBACK_UNSUPPORTED`. This exclusion is tracked and can be revisited when those executors gain async capability.

> **Workflow-as-tool integration**: `workflow`-type tools (added in the parent `workflow-as-tool` feature) are fully first-class participants in the async execution contract. They support all three modes — `sync` (poll until terminal), `async_wait` (suspend until callback via the same `waiting_callback` Restate promise path), and `async_continue` (fire and advance without suspension). The `callbackConfig` and `asyncHttpSuccess` fields are HTTP-specific and are ignored for workflow tool calls.

---

### HTTP Tool — Available Options

When a workflow `tool_call` node targets an **HTTP tool**, the following configuration is available on the node:

| Option                                 | Type                            | Applies to mode | Description                                                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `executionMode`                        | `'sync' \| 'async_wait'`        | all             | How the parent workflow step behaves after the HTTP call. `sync` returns immediately; `async_wait` suspends until callback. Default: `'sync'`.                                                                                 |
| `callbackConfig.enabled`               | `boolean`                       | `async_wait`    | Must be `true` for `async_wait`. If `false`, the request is rejected with `TOOL_CALLBACK_CONFIG_INVALID`.                                                                                                                      |
| `callbackConfig.location`              | `'body' \| 'query' \| 'header'` | `async_wait`    | Where the callback URL and secret are injected into the outbound HTTP request. Default: `'body'`. `'body'` not available for GET HTTP tools (Studio hides it).                                                                 |
| `callbackConfig.callbackUrlKey`        | `string`                        | `async_wait`    | Field/param/header name for the callback URL. Default: `'callbackUrl'`.                                                                                                                                                        |
| `callbackConfig.callbackSecretKey`     | `string`                        | `async_wait`    | Field/param/header name for the HMAC secret. Default: `'callbackSecret'`.                                                                                                                                                      |
| `asyncHttpSuccess.acceptedStatusCodes` | `number[]`                      | `async_wait`    | HTTP status codes that classify the response as "accepted" (async job started). Default: `[202]`. Other codes classify as `'completed'` inline — the step still enters `waiting_callback` since the callback URL was injected. |
| `asyncHttpSuccess.acceptedBodyPath`    | `string` (JSONPath)             | `async_wait`    | Optional JSONPath into the response body. Only checked when status code matches.                                                                                                                                               |
| `asyncHttpSuccess.acceptedBodyEquals`  | `string`                        | `async_wait`    | Expected value at `acceptedBodyPath`. Both must match for `'accepted'` classification.                                                                                                                                         |

**Callback contract for the downstream HTTP service**:

- The service receives `callbackUrlKey` and `callbackSecretKey` in the request (body, query, or header).
- To resume the workflow, it POSTs back to the callback URL with an HMAC-SHA256 signature using the secret.
- Callback endpoint: `{WORKFLOW_ENGINE_PUBLIC_URL}/api/v1/workflows/callbacks/:executionId/:stepId`

---

### Workflow Tool — Available Options

When a workflow `tool_call` node targets a **workflow tool** (`tool_type: 'workflow'`), the following configuration is available on the node:

| Option          | Type                                         | Applies to mode | Description                                                                                                                                                                                                               |
| --------------- | -------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executionMode` | `'sync' \| 'async_wait' \| 'async_continue'` | all             | How the parent workflow step behaves. `sync` polls until terminal; `async_wait` suspends until the workflow-engine delivers a callback; `async_continue` fires and moves to the next step immediately. Default: `'sync'`. |
| `timeout`       | `number` (ms)                                | `sync`          | How long to poll before cancelling the workflow execution. Default: 60000ms.                                                                                                                                              |

> `callbackConfig` and `asyncHttpSuccess` are **not applicable** to workflow tools — the callback mechanism for workflow-as-tool uses the existing workflow-engine callback infrastructure, not HTTP-level injection. These fields are silently ignored if present on a node targeting a workflow tool.

> For `async_wait` on workflow tools: the workflow-engine uses its own internal callback delivery (`CallbackDeliveryWorker`) to signal completion back to the parent step. No `WORKFLOW_ENGINE_PUBLIC_URL` requirement — this is internal engine-to-engine signaling.

---

### Component Diagram

```
apps/workflow-engine/src/handlers/canvas-to-steps.ts
  └─ reads ToolNodeConfig.executionMode, callbackConfig, asyncHttpSuccess
  └─ emits ToolCallStep { executionMode, callbackConfig, asyncHttpSuccess }

apps/workflow-engine/src/handlers/step-dispatcher.ts
  └─ dispatchStep('tool_call')
       ├─ sync: call → expect completed → continue
       ├─ async_continue: call → accept completed OR accepted → continue
       └─ async_wait:
            ├─ build callback URL (workflow-engine public URL + /callbacks/:execId/:stepId)
            ├─ generate per-step callback secret (workflow-handler generates + encrypts)
            └─ call runtime executeTool() with callback + config
                 ├─ runtime returns { status: 'accepted' } → enter waiting_callback suspension
                 └─ runtime returns { status: 'completed' } → fail closed (unexpected for async_wait)

apps/workflow-engine/src/handlers/workflow-handler.ts
  └─ generateCallbackSecret() → encrypt + persist to step context
  └─ step.waiting_callback → Restate promise suspension

apps/runtime/src/routes/internal-tools.ts
  └─ receives executionMode, callback, callbackConfig, asyncHttpSuccess
  └─ rejects async_continue for HTTP tools
  └─ delegates to http-tool-executor via ToolBindingExecutor
  └─ returns { success: true, status: 'completed' | 'accepted' } or { success: false, status: 'failed' }

packages/compiler/src/platform/constructs/executors/http-tool-executor.ts
  └─ if executionMode === 'async_wait' && callback:
       ├─ inject callbackUrl/callbackSecret into body / query / header per callbackConfig
       └─ execute HTTP
            ├─ response matches asyncHttpSuccess → return { __toolExecutionStatus: 'accepted', output }
            └─ response does not match → return { __toolExecutionStatus: 'completed', output }
```

### Data Flow: async_wait HTTP tool call

```
1. Workflow execution reaches a tool_call node with executionMode: 'async_wait'
   ├─ canvas-to-steps.ts has already converted the node to ToolCallStep with callback config
   └─ step-dispatcher.ts calls workflow-handler.ts to generate callback secret

2. workflow-handler.ts:
   ├─ generateCallbackSecret() → random 32-byte hex string
   ├─ encrypt + persist to step context (Restate durable state)
   └─ build callbackUrl: {WORKFLOW_ENGINE_PUBLIC_URL}/api/v1/workflows/callbacks/:executionId/:stepId

3. step-dispatcher.ts calls runtime executeTool():
   POST /api/internal/tools/execute
   {
     toolName, params, tenantId, projectId,
     executionMode: 'async_wait',
     callback: { url: callbackUrl, secret: callbackSecret },
     callbackConfig: { location, callbackUrlKey, callbackSecretKey },
     asyncHttpSuccess: { acceptedStatusCodes, acceptedBodyPath, acceptedBodyEquals }
   }

4. runtime internal-tools.ts:
   ├─ validates: tool_type must be 'http' or 'workflow' for async modes
   ├─ rejects if tool_type === 'http' && executionMode === 'async_continue'
   └─ delegates to ToolBindingExecutor → HttpToolExecutor.execute(params, executionOptions)

5. http-tool-executor.ts:
   ├─ injects { [callbackUrlKey]: callback.url, [callbackSecretKey]: callback.secret } per location
   ├─ executes outbound HTTP request (with safeFetch, SSRF protection, auth profile preserved)
   └─ classifyAsyncExecutionResult(responseStatus, body, executionOptions):
        ├─ if status ∈ acceptedStatusCodes AND body matches acceptedBodyPath/acceptedBodyEquals → 'accepted'
        └─ otherwise → 'completed'

6. runtime returns { success: true, status: 'accepted' | 'completed', output }

7. step-dispatcher.ts / workflow-handler.ts:
   ├─ HTTP tool (callbackConfig present): BOTH 'accepted' AND 'completed' → enter waiting_callback suspension
   │    Rationale: the tool already fired and injected the callback URL; even if the service
   │    responded synchronously, the workflow must wait for the callback to close the step.
   └─ Workflow tool (no callbackConfig): ONLY 'accepted' → waiting_callback; 'completed' inline → fails closed

8. External service calls back:
   POST {WORKFLOW_ENGINE_PUBLIC_URL}/api/v1/workflows/callbacks/:executionId/:stepId
   { HMAC-signed payload, output }

9. workflow-engine callback route:
   ├─ verifies HMAC against stored per-step secret
   ├─ resolves Restate waiting_callback promise with the result
   └─ workflow step resumes with output
```

---

## 5. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Callback URL includes `executionId` and `stepId` (opaque). The per-step HMAC secret is unique per step — an attacker cannot forge callbacks for another execution without the secret. Workflow engine routes validate `tenantId` + `projectId` on callback receipt as they do on all execution routes.                                                                                            |
| 2   | **Data Access Pattern** | No new collections. Callback secret stored in existing Restate durable step context (already encrypted at rest). Async result flows through the existing callback route back to the workflow engine — no new storage.                                                                                                                                                                             |
| 3   | **API Contract**        | **Inbound** (workflow engine → runtime): `POST /api/internal/tools/execute` extended with `executionMode`, `callback`, `callbackConfig`, `asyncHttpSuccess`. New discriminated response: `{ success: true, status: 'completed'                                                                                                                                                                    | 'accepted', output }`. **Outbound** (runtime → HTTP service): callback URL and secret injected into request body / query params / headers based on `callbackConfig.location`. The external service's callback contract is unchanged (same callback route). |
| 4   | **Security Surface**    | Callback secrets are per-step randomly-generated, encrypted at rest in Restate state, never logged or surfaced via Studio execution views. Callback injection uses the existing `safeFetch` path (SSRF protection, header sanitization, auth profiles preserved). `async_continue` rejected for HTTP tools to prevent accidentally creating a dangling callback URL without suspension semantics. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Three outcomes from the HTTP executor: (a) `completed` — service responded synchronously with a non-accepted response; (b) `accepted` — service acknowledged async job (202 or configured status); (c) `failed` — HTTP error or explicit failure. **HTTP async_wait suspension rule**: when `callbackConfig` is present (HTTP tool path), BOTH `accepted` AND `completed` inline responses enter `waiting_callback` suspension — the callback URL has already been injected so the step must wait for the callback regardless. For workflow-type tools (no `callbackConfig`), only `accepted` enters suspension; `completed` inline fails the step closed (misconfigured node). Timeout handled by the existing Restate promise timeout. |
| 6   | **Failure Modes** | (a) External service unreachable → `safeFetch` throws → `failed`, step fails. (b) External service returns non-accepted response for `async_wait` HTTP node → classified `completed` inline → still enters waiting_callback suspension (see concern 5). (c) Callback never arrives before timeout → Restate promise times out → existing timeout path fails the step. (d) Callback arrives with invalid HMAC → 401, not retried by `CallbackDeliveryWorker`. (e) Callback secret mismatch → 401.                                                                                                                                                                                                                                         |
| 7   | **Idempotency**   | Per-step callback secret ensures a specific callback is bound to exactly one step instance. The existing callback route deduplicates via `SETNX` on a Redis idempotency key. Duplicate HTTP calls from the workflow engine side are not expected (step dispatcher calls exactly once).                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 8   | **Observability** | Existing `TraceEvent` emissions from `HttpToolExecutor` extended with `__toolExecutionStatus` in the result output. `step-dispatcher.ts` logs `async_wait` acceptance and suspension at `info` level. Callback arrival and secret verification logged in the callback route.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | No polling overhead for `async_wait` — the step suspends via Restate rather than polling. Callback injection adds ~0ms overhead (JSON/query/header manipulation). The `classifyAsyncExecutionResult` check is a O(1) status code lookup + optional JSONPath evaluation.                                                                                                |
| 10  | **Migration Path**     | Purely additive. No existing `tool_call` nodes are affected. `executionMode` defaults to `sync` when absent. `callbackConfig` and `asyncHttpSuccess` are ignored unless `executionMode === 'async_wait'`.                                                                                                                                                              |
| 11  | **Rollback Plan**      | Revert the four implementation commits. Studio UI reverts to showing no async controls for HTTP nodes. Workflow nodes with saved `executionMode: 'async_wait'` would default to `sync` behavior after rollback (the schema parser defaults missing modes to `sync`). The existing callback route is unaffected — it was already in place for workflow-tool async wait. |
| 12  | **Test Strategy**      | Unit tests for HTTP executor callback injection and response classification. Integration tests for step-dispatcher mode matrix and workflow-handler suspension path. See `docs/testing/sub-features/workflow-http-tool-async-completion.md`.                                                                                                                           |

---

## 6. Data Model

### Modified Types (in-memory IR, not persisted directly)

```typescript
// packages/shared/src/types/workflow-schemas.ts
type ToolNodeExecutionMode = 'sync' | 'async_continue' | 'async_wait';

interface ToolNodeCallbackConfig {
  enabled: boolean;
  location: 'body' | 'query' | 'header';
  callbackUrlKey: string; // default: 'callbackUrl'
  callbackSecretKey: string; // default: 'callbackSecret'
}

interface ToolNodeAsyncHttpSuccessConfig {
  acceptedStatusCodes?: number[]; // default: [202]
  acceptedBodyPath?: string; // JSONPath to bool/string discriminator
  acceptedBodyEquals?: string; // expected value at acceptedBodyPath
}

// Extends existing ToolNodeConfig
interface ToolNodeConfig {
  // ... existing fields ...
  executionMode?: ToolNodeExecutionMode; // default: 'sync'
  callbackConfig?: ToolNodeCallbackConfig; // honored only for http tools + async_wait
  asyncHttpSuccess?: ToolNodeAsyncHttpSuccessConfig; // honored only for async_wait
}
```

```typescript
// apps/workflow-engine/src/executors/tool-call-executor.ts
type ToolExecutionResponse =
  | { success: true; status: 'completed'; output: unknown }
  | { success: true; status: 'accepted'; output: unknown }
  | { success: false; status: 'failed'; error: { code: string; message: string } };
```

```typescript
// packages/compiler/src/platform/constructs/executors/http-tool-executor.ts
interface AsyncHttpExecutionResult {
  __toolExecutionStatus: 'completed' | 'accepted';
  output: unknown;
  responseStatus: number;
}
```

### Constants

```typescript
const DEFAULT_HTTP_CALLBACK_CONFIG: ToolNodeCallbackConfig = {
  enabled: true,
  location: 'body',
  callbackUrlKey: 'callbackUrl',
  callbackSecretKey: 'callbackSecret',
};

const DEFAULT_ASYNC_HTTP_ACCEPTED_STATUS_CODES = [202];
```

---

## 7. API Design

### Modified Endpoint

`POST /api/internal/tools/execute` — request schema extended (all new fields optional, backward-compatible):

```typescript
{
  toolName: string;
  params: Record<string, unknown>;
  tenantId: string;
  projectId: string;
  actorUserId?: string;
  timeout?: number;
  executionMode?: 'sync' | 'async_continue' | 'async_wait';  // NEW
  callback?: { url: string; secret: string };                  // NEW
  callbackConfig?: ToolNodeCallbackConfig;                     // NEW
  asyncHttpSuccess?: ToolNodeAsyncHttpSuccessConfig;           // NEW
}
```

Response now discriminated:

```typescript
// success: true
{
  success: true;
  status: 'completed' | 'accepted';
  output: unknown;
}
// success: false
{
  success: false;
  status: 'failed';
  error: {
    code: string;
    message: string;
  }
}
```

### Error Codes (new)

| Code                              | HTTP | Trigger                                                                                  |
| --------------------------------- | ---- | ---------------------------------------------------------------------------------------- |
| `TOOL_EXECUTION_MODE_UNSUPPORTED` | 400  | HTTP tool + `async_continue` requested                                                   |
| `TOOL_CALLBACK_UNSUPPORTED`       | 400  | `callback` provided for tool type that doesn't support it (`mcp`, `sandbox`, `searchai`) |

### Existing Endpoints (unchanged)

The workflow engine callback route (`POST /api/v1/workflows/callbacks/:executionId/:stepId`) is reused without modification — it was already the only callback-resume endpoint.

---

## 8. Cross-Cutting Concerns

- **Security**: Callback secrets are per-step, random, encrypted at rest. Never in trace payloads, Studio execution views, or public step serialization. `safeFetch` protections (SSRF, header sanitization, auth profiles) remain active during callback injection.
- **Callback URL reachability**: `WORKFLOW_ENGINE_PUBLIC_URL` must be reachable from the external HTTP service. This is an operational requirement, not a new one — it was already required for workflow-tool async wait.
- **GET method and body injection**: When a tool's HTTP method is `GET`, the Studio UI hides the `body` callback location option. If `body` was previously saved for a now-GET tool, the Studio resets it to `query` automatically. The executor does not validate this at runtime (GET + body injection is technically valid HTTP) — the UI guard is a UX improvement only.
- **Observability**: `__toolExecutionStatus` is surfaced in tool execution trace output so operators can distinguish inline-completed from accepted-async tool invocations.

---

## 9. Open Questions & Known Limitations

1. **`completed` inline for `async_wait` nodes fails closed** — if an HTTP service responds synchronously (200 OK) to a node configured as `async_wait`, the step fails. The operator must either switch the node to `sync` or ensure the service always responds with an accepted status code. A future improvement could auto-fallback to `completed` with a warning trace event.
2. **No UI for acceptance contract presets** — builders must manually enter `callbackUrlKey` / `callbackSecretKey` / `acceptedStatusCodes`. Common presets (e.g., `webhook_url`, `X-Callback-Url`) would reduce config friction.
3. **`async_continue` for HTTP** — this was explicitly removed (see D-4 deviation in the LLD). If use cases emerge where a builder wants to fire an HTTP call with a callback URL but not wait, they should use `async_wait` — the semantic difference is small and the overhead is minimal (Restate suspension + immediate callback deliver is fast).

---

## 10. References

- LLD: `docs/plans/2026-05-10-workflow-http-tool-async-completion-plan.md`
- Parent feature spec: `docs/features/workflow-as-tool.md`
- Parent HLD: `docs/specs/workflow-as-tool.hld.md`
- Related sub-feature (workflow async polling + push): `docs/features/sub-features/workflow-async-completion.md`
- Test spec: `docs/testing/sub-features/workflow-http-tool-async-completion.md`
- Callback route: `apps/workflow-engine/src/routes/workflow-callbacks.ts`
- HTTP executor: `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`
- Step dispatcher: `apps/workflow-engine/src/handlers/step-dispatcher.ts`
- Internal tools route: `apps/runtime/src/routes/internal-tools.ts`
- Workflow schema types: `packages/shared/src/types/workflow-schemas.ts`
