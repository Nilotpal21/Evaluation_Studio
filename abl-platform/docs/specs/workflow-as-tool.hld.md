# HLD: Workflow-as-Tool

**Feature Spec**: `docs/features/workflow-as-tool.md`
**Test Spec**: `docs/testing/workflow-as-tool.md`
**Status**: IMPLEMENTED
**Author**: Pattabhi
**Date**: 2026-04-13

---

## 1. Overview / Goal

Let agents invoke existing webhook-triggered workflows as tools, so builders stop rebuilding orchestration as raw HTTP tools. The workflow's `start.inputVariables` becomes the LLM-facing parameter schema; execution flows through the existing workflow-engine HTTP API. Sync mode returns `output` after polling; async mode returns `executionId` immediately. Cron/event triggers are explicitly rejected — only webhook triggers are tool-eligible.

---

## 2. Problem Statement

Agents in ABL Platform can call HTTP endpoints, sandbox functions, MCP tools, and SearchAI knowledge bases — but not user-defined **Workflows**, even though Workflows are first-class artifacts (project-scoped, typed inputs/outputs, Restate-backed engine, versioned). Builders today rebuild orchestration as raw HTTP tools or duplicate it inside agent reasoning, causing drift between agents and workflows that should share business logic.

We expose a workflow as a callable tool with `tool_type: 'workflow'`. The agent sees the workflow's `start.inputVariables` as the LLM-facing parameter schema. Execution flows through the existing workflow-engine HTTP API (no engine changes). **Webhook triggers only**; cron and event triggers are explicitly not exposable as tools. Sync mode polls until terminal and returns `output`; async mode returns `executionId` immediately.

---

## 3. Alternatives Considered

### Option A: New `WorkflowToolExecutor` peer service in apps/runtime (mirrors SearchAI KB executor) — **RECOMMENDED**

- **Description**: Add `apps/runtime/src/services/workflow/workflow-tool-executor.ts` implementing the existing `ToolExecutor` interface. Wire it into `LLMWiringService` next to the existing SearchAI block (`apps/runtime/src/services/execution/llm-wiring.ts:917-994`). Calls workflow-engine HTTP directly (POST execute → poll GET → POST cancel on timeout). The IR + dispatcher already accept `tool_type: 'workflow'` (`packages/compiler/src/platform/ir/schema.ts:781,807,881-886`; `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts:573-582`).
- **Pros**: Pattern parity with SearchAI (low cognitive load for future maintainers); reuses existing dispatcher/wiring; no engine changes; per-session executor instance gives natural blast-radius isolation; touches only ~5 packages with additive changes.
- **Cons**: Sync polling adds up to 2 s tail latency between status flips (exp-backoff cap). Two-step "Tool entry → workflow + trigger" UX in Studio.
- **Effort**: M (well-bounded — IR/validator + DSL + DB enum + executor + Studio form).

### Option B: Build a `WorkflowSDK` in `packages/` and let the executor wrap it

- **Description**: Build a typed SDK (`@agent-platform/workflow-sdk`) that mirrors `@agent-platform/search-ai-sdk`. The runtime executor delegates all HTTP calls to the SDK.
- **Pros**: Reusable from Studio test runner, future agent SDK consumers, and scripts.
- **Cons**: Over-abstraction for 3 endpoints; the SearchAI SDK exists because SearchAI has 10+ endpoints (discover, unifiedSearch, ingest, mappings, etc.). Adds a new package, new build target, and an extra layer of indirection without near-term consumers. Can be extracted later if more clients appear.
- **Effort**: L (new package, build wiring, tests, publish path).

### Option C: Auto-expose every active workflow as an implicit tool

- **Description**: Skip the explicit Tool entry. Every workflow with `status: 'active'` and at least one webhook trigger becomes callable from any agent in the project.
- **Pros**: Zero ceremony; one fewer concept for users to learn.
- **Cons**: No per-agent gating (any agent sees every workflow); no way to override description, paramMapping, or timeout per agent; surprise cost on the LLM token budget when a project has dozens of workflows; harder to revoke (must archive the workflow). Disagrees with the user-confirmed "explicit Tool entry" decision in the feature spec.
- **Effort**: M (less DB plumbing, more permission/listing logic).

### Recommendation: **Option A**

**Rationale**: Maximum reuse of the existing dispatcher and wiring; minimum surface area; matches the user's confirmed registration model; lets us extract an SDK later if other consumers emerge. Option B is premature abstraction; Option C contradicts the explicit-Tool-entry requirement in the feature spec.

---

## 4. Architecture

### System Context Diagram

```
┌─────────────┐    HTTP    ┌────────────────┐    HTTP     ┌──────────────────┐
│   Studio    │ ─────────► │  apps/runtime  │ ──────────► │ apps/workflow-   │
│  (UI form)  │            │                │  internal   │     engine       │
└─────────────┘            │  • LLM session │   svc JWT   │                  │
       │                   │  • Tool exec   │             │  • executions/*  │
       ▼ writes            │                │             │  • Restate       │
┌─────────────┐            └────────────────┘             └──────────────────┘
│   MongoDB   │                  ▲                               │
│             │                  │ reads tools + workflow doc    ▼
│ project_   │ ◄────────────────┘                          ┌──────────────────┐
│   tools     │                                            │ workflow_       │
│ workflows   │                                            │  executions     │
└─────────────┘                                            └──────────────────┘
```

### Component Diagram (apps/runtime — workflow tool path)

```
┌────────────────────────────────────────────────────────────────────┐
│ apps/runtime                                                       │
│                                                                    │
│  ┌──────────────────┐   build IR    ┌──────────────────────────┐   │
│  │ load-project-    │ ────────────► │ ToolDefinition           │   │
│  │ tools-as-ir.ts   │               │  tool_type: 'workflow'   │   │
│  └──────────────────┘               │  workflow_binding {…}    │   │
│         ▲                           │  parameters (from start. │   │
│         │ reads                     │   inputVariables)        │   │
│         │ workflow doc              └──────────────────────────┘   │
│         │                                       │                  │
│  ┌──────────────────┐                           ▼                  │
│  │ MongoDB          │                  ┌──────────────────────┐    │
│  │  workflows{}     │                  │ LLMWiringService     │    │
│  │  project_tools{} │                  │  (filters wf tools,  │    │
│  └──────────────────┘                  │   mints internal JWT,│    │
│                                        │   registers          │    │
│                                        │   bindings)          │    │
│                                        └──────────┬───────────┘    │
│                                                   ▼                │
│                                        ┌──────────────────────┐    │
│                                        │ ToolBindingExecutor  │    │
│                                        │  switch case         │    │
│                                        │   'workflow':        │    │
│                                        └──────────┬───────────┘    │
│                                                   ▼                │
│                                        ┌──────────────────────┐    │
│                                        │ WorkflowToolExecutor │    │
│                                        │  • execute()         │    │
│                                        │  • executeParallel() │    │
│                                        │  • poll/backoff      │    │
│                                        │  • cancel on timeout │    │
│                                        └──────────┬───────────┘    │
└───────────────────────────────────────────────────┼────────────────┘
                                                    ▼
                                       HTTP (internal service JWT)
                                                    │
                                                    ▼
                                  ┌────────────────────────────────┐
                                  │ apps/workflow-engine           │
                                  │  POST /executions/execute      │
                                  │  GET  /executions/:id          │
                                  │  POST /executions/:id/cancel   │
                                  └────────────────────────────────┘
```

### Data Flow — Sync mode

```
1. Agent session starts
   ├─ LLMWiringService.compileForSession()
   ├─ filter tools where tool_type === 'workflow'
   ├─ if any → mint internal JWT (tenantId, role:'OWNER', internal:true, exp 1h)
   ├─ instantiate WorkflowToolExecutor({ workflowEngineUrl, authToken, projectId, tenantId })
   └─ for each tool → executor.registerBinding(name, binding, meta)

2. LLM emits tool_call(name, params)

3. ToolBindingExecutor.execute(tool, params, timeout)
   └─ case 'workflow': → workflowToolExecutor.execute(name, params, timeout)

4. WorkflowToolExecutor.execute(name, params, timeoutMs)
   ├─ resolve binding (workflowId, triggerId, mode, paramMapping)
   ├─ build payload via paramMapping (default: pass-through)
   ├─ POST {WORKFLOW_ENGINE_URL}/api/projects/:projectId/workflows/:workflowId/executions/execute
   │     headers: Authorization: Bearer <internal JWT>
   │     body: { payload, triggerType:'api', triggerMetadata:{ source:'agent_tool', sessionId, agentName, triggerId } }
   │     (triggerId carried in metadata for traceability; engine does not use it for routing)
   ├─ on 202 → parse `{ success:true, executionId }` → extract executionId
   ├─ if mode === 'async' → return { executionId, status:'running' }
   └─ if mode === 'sync' →
        loop with exp backoff [250ms → 500 → 1000 → 2000 cap] until elapsed >= timeoutMs:
          GET {url}/executions/:executionId
          if status in {completed,failed,cancelled,rejected} → break
        on timeout → POST {url}/executions/:executionId/cancel; throw ToolExecutionError
        on completed → return { status, output, executionId }
        on failed/cancelled/rejected → throw ToolExecutionError(engine error body)
```

### Sequence — Async mode

```
LLM    ToolBindingExecutor    WorkflowToolExecutor    workflow-engine
 │           │                       │                       │
 │ tool_call │                       │                       │
 ├──────────►│ execute('publish',    │                       │
 │           │   {docId})            │                       │
 │           ├──────────────────────►│ POST executions/execute
 │           │                       ├──────────────────────►│
 │           │                       │     202 {executionId} │
 │           │                       │◄──────────────────────┤
 │           │                       │ return {executionId,  │
 │           │                       │   status:'running'}   │
 │           │ tool result           │                       │
 │           │◄──────────────────────┤                       │
 │ next turn │                       │                       │
 │◄──────────┤                       │                       │
```

---

## 5. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Every executor instance carries `tenantId` + `projectId`. The internal service JWT bakes `tenantId` into the token. Workflow-engine routes (`apps/workflow-engine/src/routes/workflow-executions.ts:222-226`) already filter `findOne({_id, tenantId, projectId})`, returning **404** (not 403) for cross-scope per CLAUDE.md invariant 1.                                                                                                                                                                                                                                                                                    |
| 2   | **Data Access Pattern** | No new DB collections. Reads workflow document at IR-load time (`load-project-tools-as-ir.ts`) to derive parameters. Writes go to existing `workflow_executions` collection via the engine — runtime never writes execution rows directly. No caching of workflow definitions (the IR load is per session, ~once).                                                                                                                                                                                                                                                                                                            |
| 3   | **API Contract**        | **Inbound** — same `POST /api/projects/:projectId/tools` accepts `toolType: 'workflow'` with DSL `type: workflow / workflow_id / trigger_id / mode / timeout_ms`. New create-path errors follow the CLAUDE.md structured envelope `{ success: false, error: { code, message } }`. **Outbound (runtime → engine)** — uses the three existing endpoints; no new engine routes. The engine today returns a **flat** `{ success: false, error: '<message>' }` string body — the executor normalizes this into `ToolExecutionError` (see Concern #5). Changing the engine envelope is out of scope for v1; tracked as a follow-up. |
| 4   | **Security Surface**    | Internal service JWT (1-hour TTL, `internal: true` claim, signed with shared `JWT_SECRET`) — same pattern as SearchAI block (`llm-wiring.ts:930-952`). Workflow tool inherits agent auth context; no per-tool auth profile in v1 (FR-7). Webhook-trigger-only validator prevents exposing cron/event triggers. No SSRF surface — engine URL is operator-configured.                                                                                                                                                                                                                                                           |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | All failures surface as `ToolExecutionError { code: 'TOOL_EXECUTION_ERROR', toolName, toolType: 'workflow', message }` (matches the existing dispatcher branch at `tool-binding-executor.ts:573-582`). **Engine error normalization** — the live engine returns a **mixed** error envelope: **flat-string** form `{ success: false, error: '<text>' }` for most 404/400s (`workflow-executions.ts:88,118,129,174,229,305,316`) **and** **structured** form `{ success: false, error: { code, message } }` for specific cases — `INVALID_EXECUTION_ID` (L185), `INVALID_TRIGGER_TYPE` (L196), `DUPLICATE_NODE_NAMES` (L258), `RESTATE_START_FAILED` (L288). The executor normalizes both shapes into `ToolExecutionError` (no engine changes required): **shape check** — `typeof body.error === 'string'` → wrap message; `typeof body.error === 'object' && body.error.code` → forward `<code>: <message>`. Concrete mappings: engine 404 (flat) → `message: "workflow not found: <engine-string>"`; engine 400 (flat or structured) → `message: "<code-or-text>"`; engine 502 with `{code:'RESTATE_START_FAILED', message}` → `message: "workflow engine unavailable: <engine-message>"`; network error (ECONNREFUSED/ETIMEDOUT) → `message: "workflow engine unreachable"`; terminal `failed`/`cancelled`/`rejected` → `message: "<terminal-status>: <engine-payload>"`; sync timeout → `message: "workflow execution timed out after <timeoutMs>ms"`; **cancel-on-timeout returning 409** (engine L320-323, execution already terminal) → log at `debug` ("execution already terminal, cancel unnecessary"), swallow the 409, keep surfacing the original timeout error to the agent. The agent reasoning loop receives the normalized error and continues (E2E-3). |
| 6   | **Failure Modes** | (a) Engine unreachable → POST throws → `ToolExecutionError`. (b) Sync timeout → POST cancel + throw. (c) Cancel POST itself fails (engine down or already terminal) → log warning, still throw timeout error. (d) Restate down → engine returns 502 → executor surfaces error. (e) Workflow deleted between bind and call → engine 404 → executor surfaces error. No circuit breaker in v1 (per-session executor + agent-level retry semantics).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 7   | **Idempotency**   | The agent loop assigns each `tool_call` a unique `tool_call_id`; we forward it via `triggerMetadata.toolCallId` so engine duplicates can be detected if Restate retries. Sync mode is naturally retry-safe (each call mints a fresh executionId). Async mode returns the executionId once — duplicate retries from the LLM would create distinct executions; this matches existing tool-call semantics (LLM loop typically does not retry tool calls).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 8   | **Observability** | `WorkflowToolExecutor` emits `TraceEvent`s via the shared `TraceStore` (per CLAUDE.md invariant 4): `tool.workflow.execute.start`, `tool.workflow.execute.poll`, `tool.workflow.execute.complete`, `tool.workflow.execute.timeout`, `tool.workflow.execute.cancel`, `tool.workflow.execute.error` — each tagged with `executionId`, `workflowId`, `triggerId`, `mode`, `latencyMs`. Logger via `createLogger('workflow-tool-executor')`. The full workflow trace lives in the engine and is linkable via executionId.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Sync executor adds up to **2 s tail latency** between engine status flips (exp-backoff cap). Initial poll is 250 ms. Async mode is essentially zero overhead (one POST). Per-session memory: `O(toolBindings)` — a `Map<string, WorkflowBinding>`. Engine concurrency bounded by agent-side `executeParallel` (typically ≤ 3 concurrent calls per turn).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 10  | **Migration Path**     | Purely additive. New enum value in `PROJECT_TOOL_TYPES`; existing data unaffected. No backfill, no cutover, no shadow mode. Existing tools of other types continue to work unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 11  | **Rollback Plan**      | **Revert the commit(s)** — feature is fully additive and opt-in (a user must explicitly create a workflow tool). No feature flag in v1. `WORKFLOW_ENGINE_URL` is **shared** with other runtime → engine consumers (e.g., workflow-node agentic-app invocations); it is not workflow-tool-exclusive, so unsetting it affects all engine consumers. Kill-switch for workflow tools specifically: flip a tenant feature flag at the Studio create dialog (future) or hot-archive all `toolType: 'workflow'` docs via DB script (disables registration without redeploy). **In-flight sessions**: existing `WorkflowToolExecutor` instances keep the binding they were constructed with; on the next tool call they either succeed (if engine reachable) or throw `ToolExecutionError`, and the agent loop continues with remaining tools. **Blast radius**: other tool types (`http`/`mcp`/`sandbox`/`searchai`) are entirely unaffected by revert or kill — the executor branch is isolated in the dispatcher `switch`. Existing data (persisted workflow tools) remains readable after revert; only the executor dispatch arm is missing, so calls throw at dispatch time. |
| 12  | **Test Strategy**      | 7 E2E + 7 integration + 6 unit (see `docs/testing/workflow-as-tool.md`). E2E uses real Express on random ports + full middleware (no platform mocks). Integration uses DI fakes only for external boundaries (Restate, Mongoose models). No `vi.mock` of `@agent-platform/*` or `@abl/*`. Coverage matrix maps every FR-1..FR-10 to at least one test type.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 6. Data Model

### New Collections/Tables

**None.** Workflow tools are stored in the existing `project_tools` collection (`packages/database/src/models/project-tool.model.ts`) with `toolType: 'workflow'`. Workflow execution rows continue to live in the existing `workflow_executions` collection (engine-owned).

### Modified Collections/Tables

#### `project_tools` (additive)

- `toolType` enum extended: `['http', 'mcp', 'sandbox', 'searchai']` → `['http', 'mcp', 'sandbox', 'searchai', 'workflow']`
- `dslContent` for workflow tools encodes:
  ```
  type: workflow
  workflow_id: <workflow id>
  trigger_id: <webhook trigger id>
  mode: sync | async
  timeout_ms: <number>          # sync only; default 60000
  param_mapping: <json-object>  # optional; default {} — flat map { workflow-input-name: JSONPath }
  ```
- No new indexes (existing `{tenantId, projectId, name}` index covers lookups).

#### `WorkflowBindingIR` (in-memory IR, not persisted)

```ts
interface WorkflowBindingIR {
  workflowId: string; // existing
  triggerId?: string; // NEW — optional at the type level; required at runtime
  //       for tool_type: 'workflow' (validator rejects missing)
  mode: 'sync' | 'async'; // existing
  paramMapping: Record<string, string>; // existing — flat map of workflow-input-name
  //            to JSONPath expression (e.g. "$.query")
  timeoutMs?: number; // existing
}
```

**Interface-change policy**: `triggerId` is added as **optional** on the exported `WorkflowBindingIR` type to avoid breaking any latent external compiler consumer (the IR schema is exported from `@abl/compiler`). Runtime validation in `tool-schema-validator.ts` enforces that `triggerId` is a non-empty string for every `tool_type: 'workflow'` tool (FR-2). Because the monorepo builds atomically and no external package pins `@abl/compiler` today, this is a safe additive change.

`paramMapping` is intentionally `Record<string, string>` — values are **JSONPath strings** (e.g. `{ topic: '$.query' }`), not nested JSON. The DSL property is therefore a flat key-value map, not arbitrary JSON.

### Key Relationships

`project_tools (toolType: 'workflow')` → references `workflows._id` + a `triggers[].id` of `type: 'webhook'`. Both must be in the same `(tenantId, projectId)` as the tool. Validator enforces at create time; runtime engine 404 enforces at execute time.

---

## 7. API Design

### New Endpoints

**None.** All new functionality flows through existing endpoints:

| Method | Path                                                                            | Purpose                                                           | Auth                    |
| ------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------- |
| `POST` | `/api/projects/:projectId/tools`                                                | Create a workflow tool (existing endpoint accepts new `toolType`) | User JWT, `tool:create` |
| `POST` | `/api/projects/:projectId/workflows/:workflowId/executions/execute`             | Runtime → engine, start workflow execution (existing)             | Internal service JWT    |
| `GET`  | `/api/projects/:projectId/workflows/:workflowId/executions/:executionId`        | Runtime → engine, poll status (existing)                          | Internal service JWT    |
| `POST` | `/api/projects/:projectId/workflows/:workflowId/executions/:executionId/cancel` | Runtime → engine, cancel on timeout (existing)                    | Internal service JWT    |

### Modified Endpoints

`POST /api/projects/:projectId/tools` validation extended (additive) — `project-tool-validator.ts:318-331,574-587`:

- Accepts `toolType: 'workflow'`.
- Validates DSL via new `buildWorkflowBindingFromProps` and a new `validateWorkflowTool` that confirms (a) workflow exists in same `(tenantId, projectId)`, (b) `status: 'active'`, (c) `triggerId` exists on `triggers[]`, (d) trigger `type === 'webhook'`.

### Error Responses

| Code                             | HTTP             | Trigger                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_TOOL_BINDING`           | 400              | DSL malformed; missing `workflow_id` or `trigger_id`; `param_mapping` not valid JSON                                                                                                                                                                                                                                                                           |
| `WORKFLOW_NOT_FOUND`             | 404              | Referenced workflow not found in `(tenantId, projectId)` (cross-scope returns 404, not 403). Engine wire format today is flat string `{ success: false, error: 'Workflow not found' }`; the runtime executor normalizes this into `ToolExecutionError` (see Concern #5). Create-path validator (tool create) uses the structured `{ code, message }` envelope. |
| `INVALID_TOOL_BINDING` (trigger) | 400              | `triggerId` missing on workflow OR trigger type ≠ `webhook`                                                                                                                                                                                                                                                                                                    |
| `WORKFLOW_INACTIVE`              | 400              | Workflow status ≠ `active`                                                                                                                                                                                                                                                                                                                                     |
| `TOOL_EXECUTION_ERROR` (runtime) | n/a (in-process) | Engine 4xx/5xx, sync timeout (with cancel), terminal `failed`/`cancelled`/`rejected`                                                                                                                                                                                                                                                                           |
| `FORBIDDEN`                      | 403              | User JWT lacks `tool:create` role                                                                                                                                                                                                                                                                                                                              |
| `UNAUTHORIZED`                   | 401              | Missing/expired JWT                                                                                                                                                                                                                                                                                                                                            |

---

## 8. Cross-Cutting Concerns

- **Audit Logging**: Tool create/update/delete already audit-logged via existing `project_tools` middleware. Workflow executions audit-logged by the engine. Runtime adds trace events (see Concern #8) — no new audit logs.
- **Rate Limiting**: No new limits. Tool-call rate is governed by the per-session LLM turn rate. Engine has its own per-tenant execution rate limits (existing).
- **Caching**: No caching of workflow definitions in the executor — IR load reads fresh per session. (The session IR itself is cached upstream, so workflow input schemas are effectively cached for the session lifetime.)
- **Encryption**: Internal service JWT signed with `JWT_SECRET` (shared HMAC). HTTP between runtime and engine assumed mTLS / network-level encryption per platform deployment (out of scope of this feature).
- **i18n**: Validator error messages use `@agent-platform/i18n` — new keys: `tool.workflow.invalidBinding`, `tool.workflow.workflowNotFound`, `tool.workflow.triggerNotWebhook`, `tool.workflow.workflowInactive`.
- **Structured logging**: `createLogger('workflow-tool-executor')`. No `console.log` (per CLAUDE.md hook).

---

## 9. Dependencies

### Upstream (this feature depends on)

| Dependency                                                                                                                              | Type          | Risk                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------- |
| `apps/workflow-engine` executions router (3 endpoints)                                                                                  | Internal HTTP | LOW — endpoints stable, no schema change required                |
| `packages/compiler` IR + ToolBindingExecutor (already accepts `tool_type: 'workflow'`)                                                  | Library       | LOW — additive validator change only                             |
| `packages/shared` DSL parser, project-tool-validator, standalone-tool-adapter, resolve-tool-implementations, serialize-tool-form-to-dsl | Library       | LOW — adds new branches, no behavior change to existing branches |
| `packages/database` `project-tool` model (enum) + `workflow` model (read for inputVariables)                                            | Library       | LOW — additive enum                                              |
| `jsonwebtoken` (already a transitive dep, used at `llm-wiring.ts:934`)                                                                  | External      | LOW                                                              |
| `packages/config` (`getConfig().jwt.secret`, `DEFAULT_WORKFLOW_ENGINE_PORT` from `packages/config/src/constants.ts:38`)                 | Library       | LOW                                                              |
| Native `fetch` (Node 18+)                                                                                                               | Runtime       | LOW — no new dep needed                                          |
| `apps/studio` shared tool-form components                                                                                               | Library       | LOW — additive UI                                                |

### Downstream (depends on this feature)

| Consumer                                               | Impact                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Agent runtime (`apps/runtime` LLM session)             | Consumes the new `tool_type: 'workflow'` via the existing `ToolBindingExecutor` switch — no changes to other branches. |
| Studio Tools UI                                        | Adds Workflow tab, badge, create-dialog option, configuration form.                                                    |
| Future: agent SDK consumers building agents externally | Receive the new tool type in compiled IRs; SDK serialization already supports the union.                               |

---

## 10. Open Questions & Decisions Needed

1. **`auth.type === 'user_level'` webhook triggers** — when a webhook trigger requires user-scoped credentials, do we (a) propagate the agent's `userId` into the engine call, (b) reject exposing such triggers as tools in v1, or (c) require an explicit auth-profile attachment on the workflow tool? Default: **reject in v1** (validator surfaces a clear error). Decide before LLD.
2. **Companion "wait-for-execution" tool for async mode** — should we ship a paired `wait_for_workflow(executionId, timeoutMs)` tool so an agent can choose to await an async workflow later in its reasoning, or wait for user demand?
3. **Stale-binding behavior** — when a workflow is archived after a tool is created, the runtime currently surfaces a 404 at execute time. Should the IR loader proactively skip such tools (degrading silently) or keep the runtime error so the issue surfaces to operators? Recommendation: keep runtime error + add a Studio inspector warning; but confirm.

---

## 11. Post-Implementation Notes

**Status**: IMPLEMENTED (as of 2026-04-15).

Key deviations from the original HLD, captured during implementation follow-up (commit `76d206c6c5`):

- **Validator source of truth** — The HLD's §3 design referenced the denormalized `workflow.triggers[]` array for webhook-trigger enforcement (FR-3). Actual implementation reads from `TriggerRegistrationsRepo` via `packages/shared/src/tools/validate-workflow-tool-binding.ts`. Rationale: the version-first model makes `TriggerRegistration` the canonical source; the denormalized array is eventually-consistent. No behavior change visible to the agent runtime.
- **Studio picker shape (FR-8 surface area)** — HLD §4 Component Diagram showed a single workflow-and-trigger picker. Shipped as three sequential dropdowns (workflow → active version → webhook trigger) in `apps/studio/src/components/tools/WorkflowConfigForm.tsx`. Draft versions are always treated as active per the version-first spec. This keeps the backend contract identical (still `{workflowId, triggerId, mode, timeoutMs}`) while matching the shipped workflow-versioning UX.
- **Parameter propagation on create** — `ToolCreateDialog` forwards the derived `parameters` to `POST /api/projects/:projectId/tools` so the stored tool persists the params the LLM will see. Otherwise the tool detail page and runtime loader would show no parameters until the next IR refresh.

---

## 12. References

- Feature spec: `docs/features/workflow-as-tool.md`
- Test spec: `docs/testing/workflow-as-tool.md`
- Implementation plan: `~/.claude/plans/smooth-roaming-wozniak.md`
- Sibling pattern: `apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts`
- IR + dispatcher (already wired): `packages/compiler/src/platform/ir/schema.ts:781,807,881-886`; `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts:573-582`
- Engine API: `apps/workflow-engine/src/routes/workflow-executions.ts:113,169,298`
- Wiring point: `apps/runtime/src/services/execution/llm-wiring.ts:917-994`
- Related: `docs/specs/workflows.hld.md`, `docs/specs/workflow-triggers.hld.md`
- Platform principles: CLAUDE.md (12 architectural concerns)
- **HTTP async completion sub-feature HLD**: `docs/specs/workflow-http-tool-async-completion.hld.md`
- **HTTP async completion LLD**: `docs/plans/2026-05-10-workflow-http-tool-async-completion-plan.md`
