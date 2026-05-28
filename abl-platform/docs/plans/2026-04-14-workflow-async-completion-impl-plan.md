# LLD: Workflow Async Completion (Polling + Push)

**Feature Spec**: `docs/features/sub-features/workflow-async-completion.md`
**HLD**: N/A (sub-feature of workflow-as-tool — established architecture)
**Test Spec**: `docs/testing/sub-features/workflow-async-completion.md`
**Status**: DONE
**Date**: 2026-04-14

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                       | Rationale                                                                                                          | Alternatives Rejected                                                         |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| D-1  | Implement polling (Phase 1) before push (Phase 2)                              | Polling is self-contained in runtime; push requires cross-service changes (workflow-engine + runtime + WS manager) | Push first — higher blast radius for initial change                           |
| D-2  | `WorkflowStatusTool` as standalone class, not method on `WorkflowToolExecutor` | Separation of concerns: executor handles execution; status tool handles queries. Testable independently.           | Add `checkStatus()` to executor — mixes concerns                              |
| D-3  | Inject companion tool in `buildTools()` (prompt-builder)                       | Follows existing system tool pattern (handoff, escalate, set_context). Tools list built per-session.               | Inject in IR compiler — wrong layer; system tools are runtime-only            |
| D-4  | Name-based dispatch in `ToolBindingExecutor` before type switch                | `check_workflow_status` is a system tool, not a project tool with `tool_type`. Needs special dispatch.             | Add new `tool_type: 'workflow_status'` — over-engineering for a single tool   |
| D-5  | Callback endpoint uses HMAC auth, not JWT `requireServiceAuth`                 | Workflow-engine already signs callbacks with HMAC via `buildSignatureHeaders`. Reuse existing pattern.             | JWT service auth — would require engine to mint tokens; HMAC is already wired |
| D-6  | `broadcastToSession()` via linear scan of WS connections                       | Connection count per pod is bounded (10k max). Linear scan is <1ms. No index maintenance overhead.                 | sessionId→WS reverse index map — premature optimization, adds state to manage |
| D-7  | Channel `'api'` for push-injected system messages                              | Push comes from internal API callback, not a user channel. `'api'` is the correct semantic.                        | New `'internal'` channel — unnecessary new channel type                       |
| D-8  | Two-tier fallback: Redis → GET (no pod-local cache)                            | Stateless-distributed invariant (CLAUDE.md invariant 3). Redis is the shared cache layer.                          | Three-tier with pod-local Map — violates stateless invariant                  |
| D-9  | `executionId` tracking stored on `WorkflowToolExecutor` instance               | Same pattern as `bindings` Map (line 62). Session-scoped, bounded by async tool count. Released on session end.    | Redis-based tracking — over-engineering; executor is already session-scoped   |
| D-10 | Push injects passive system message (no auto-LLM-turn)                         | Avoids unexpected agent behavior. The message is included in the next turn naturally.                              | Auto-trigger LLM turn — unpredictable UX, may interrupt user mid-conversation |

### Key Interfaces & Types

```typescript
// ── WorkflowStatusTool (new) ──
export interface WorkflowStatusToolConfig {
  workflowEngineUrl: string;
  authToken: string;
  projectId: string;
  tenantId: string;
  sessionId: string;
  redis: Redis;
  getAsyncExecutionIds: () => ReadonlySet<string>; // closure over WorkflowToolExecutor
  asyncResultTtlHours?: number; // default 24
}

export interface WorkflowStatusResult {
  status: string;
  output?: Record<string, unknown>;
  error?: string;
  executionId: string;
  workflowId: string;
}

// ── Callback handler (new) ──
export interface WorkflowCallbackPayload {
  executionId: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  workflowId: string;
  workflowName: string;
  status: string;
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
  source: 'agent_tool';
}

// ── Redis async-result value ──
export interface AsyncResultEntry {
  status: string;
  output: Record<string, unknown> | null;
  error: string | null;
  workflowId: string;
  workflowName: string;
  executionId: string;
  sessionId: string;
  projectId: string;
  completedAt: string; // ISO 8601
}

// ── Modified CallbackJobData (workflow-engine) ──
export interface CallbackJobData {
  executionId: string;
  tenantId: string;
  callbackUrl: string;
  source?: string; // NEW — 'agent_tool' for internal callbacks
  payload: {
    traceId: string;
    status: string;
    result?: Record<string, unknown>;
    error?: { code: string; message: string };
    // NEW fields for push callback
    executionId?: string;
    tenantId?: string;
    projectId?: string;
    sessionId?: string;
    workflowId?: string;
    workflowName?: string;
    source?: string;
  };
}

// ── Modified CallbackDeliveryDeps (workflow-engine) ──
export interface CallbackDeliveryDeps {
  webhookSecret: (tenantId: string, source?: string) => Promise<string>;
}
```

### Module Boundaries

| Module                    | Responsibility                                                 | Depends On                                          |
| ------------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| `WorkflowStatusTool`      | Query execution status (Redis → GET fallback), session scoping | Redis, workflow-engine HTTP API                     |
| `WorkflowCallbackHandler` | HMAC verify, Redis persist, session inject, WS notify          | Redis, `StoreFactory`, `WebSocketConnectionManager` |
| `WorkflowToolExecutor`    | Track executionIds, enrich async response, set callbackUrl     | (existing — modified)                               |
| `prompt-builder.ts`       | Auto-inject `check_workflow_status` tool definition            | (existing — modified)                               |
| `ToolBindingExecutor`     | Dispatch `check_workflow_status` calls to `WorkflowStatusTool` | (existing — modified)                               |
| `CallbackDeliveryWorker`  | Resolve internal secret for `source: 'agent_tool'` callbacks   | (existing — modified)                               |

---

## 2. File-Level Change Map

### New Files

| File                                                              | Purpose                                              | LOC Estimate |
| ----------------------------------------------------------------- | ---------------------------------------------------- | ------------ |
| `apps/runtime/src/services/workflow/workflow-status-tool.ts`      | Companion polling tool implementation                | ~120         |
| `apps/runtime/src/services/workflow/workflow-callback-handler.ts` | Push callback processing (HMAC, persist, inject)     | ~150         |
| `apps/runtime/src/routes/internal-callbacks.ts`                   | `POST /api/internal/workflow-callback` Express route | ~60          |

### Modified Files

| File                                                                           | Change Description                                                                                         | Risk |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ---- |
| `apps/runtime/src/services/workflow/workflow-tool-executor.ts`                 | Add `asyncExecutionIds` Set, enrich async response (FR-8), include `callbackUrl` in triggerMetadata (FR-4) | Med  |
| `apps/runtime/src/services/execution/prompt-builder.ts`                        | Add `check_workflow_status` tool definition when async workflow tools detected (FR-1)                      | Low  |
| `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` | Add name-based dispatch for `check_workflow_status` before type switch                                     | Low  |
| `apps/runtime/src/services/execution/types.ts`                                 | Add `_workflowStatusToolActive?: boolean` to `RuntimeSession` interface                                    | Low  |
| `apps/runtime/src/services/execution/llm-wiring.ts`                            | Create `WorkflowStatusTool`, pass to `ToolBindingExecutor`; pass `storeFactory` for callback handler       | Med  |
| `apps/workflow-engine/src/services/callback-delivery-worker.ts`                | Widen `webhookSecret` signature, add `source` to `CallbackJobData`, resolve internal secret (FR-9)         | Med  |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`                        | Include `source`, `sessionId`, `projectId`, `workflowId`, `workflowName` in callback job data              | Low  |
| `apps/runtime/src/websocket/connection-manager.ts`                             | Add `broadcastToSession(sessionId, event, data)` helper method                                             | Low  |
| `apps/runtime/src/server.ts`                                                   | Register `/api/internal/workflow-callback` route                                                           | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Polling Companion Tool (FR-1, FR-2, FR-3, FR-8)

**Goal**: Agent can call `check_workflow_status(executionId)` to retrieve async workflow execution results.

**Tasks**:

1.1. **Create `WorkflowStatusTool`** at `apps/runtime/src/services/workflow/workflow-status-tool.ts`:

- Implements the 3-arg `ToolExecutor` interface: `execute(toolName: string, params: Record<string, unknown>, timeoutMs: number)`
- Constructor accepts `WorkflowStatusToolConfig` (engineUrl, authToken, projectId, tenantId, sessionId, redis)
- Extracts `executionId` from `params.executionId`, validates with `z.string().min(1)` (Zod)
- Session-scoped validation: reject executionIds not in `allowedExecutionIds` Set
- Two-tier fallback: (1) Redis `GET workflow:{tenantId}:{projectId}:async-result:{executionId}`, (2) `GET {engineUrl}/api/projects/{projectId}/workflows/_/executions/{executionId}` with auth header
- Return `{ status, output, executionId, workflowId }` or `{ error: 'Execution not found or not authorized' }`
- **Note on session resumption**: If a session resumes on a different pod, `allowedExecutionIds` will be empty. The tool falls back to Redis → GET, which are project-scoped (not session-scoped). This is acceptable because: (a) Redis keys include `sessionId` in the value for verification, and (b) the GET endpoint is project-scoped with auth. The local Set is an optimization for fast rejection, not a security gate.

  1.2. **Modify `WorkflowToolExecutor`** to track async execution IDs and enrich async response:

- Add `private readonly asyncExecutionIds = new Set<string>()` (session-scoped, bounded)
- Add `getAsyncExecutionIds(): ReadonlySet<string>` getter
- In the `if (binding.mode === 'async')` block (line 158), add `this.asyncExecutionIds.add(executionId)`
- Enrich return value: `{ executionId, status: 'running', message: 'Workflow execution started...' }` (FR-8)

  1.3. **Inject companion tool in `buildTools()`** (`prompt-builder.ts`):

- BEFORE the `return tools;` statement (line 829), add conditional injection. The insertion point is between the closing `}` of the `if (sessionVars.length > 0)` block (line 827) and `return tools;` (line 829).
- Condition: `session._workflowStatusToolActive === true` (flag set by `llm-wiring.ts` when async workflow tools exist)
- Tool definition: `{ name: 'check_workflow_status', description: '...', input_schema: { type: 'object', properties: { executionId: { type: 'string', ... } }, required: ['executionId'] } }`
- Include `thought` parameter if extended thinking enabled

  1.4. **Add `_workflowStatusToolActive` to `RuntimeSession` interface**:

- In `apps/runtime/src/services/execution/types.ts` (where `RuntimeSession` is defined), add `_workflowStatusToolActive?: boolean` as an optional transient property (follows existing `_pinnedIntent`, `_fillerEnabled` pattern)

  1.5. **Wire `WorkflowStatusTool` in `llm-wiring.ts`**:

- After the `WorkflowToolExecutor` creation block (~line 1098), instantiate `WorkflowStatusTool`:
  ```
  const hasAsyncWorkflowTools = workflowTools.some(t => t.workflow_binding?.mode === 'async');
  let workflowStatusTool: WorkflowStatusTool | undefined;
  if (hasAsyncWorkflowTools && workflowToolExecutor) {
    workflowStatusTool = new WorkflowStatusTool({
      workflowEngineUrl: process.env.WORKFLOW_ENGINE_URL ?? '',
      authToken: workflowAuthToken ?? '',
      projectId: resolvedProjectId!,
      tenantId: resolvedTenantId!,
      sessionId: session.id,
      redis: getRedisClient()!,
      getAsyncExecutionIds: () => workflowToolExecutor!.getAsyncExecutionIds(),
    });
    session._workflowStatusToolActive = true;
  }
  ```
- The `getAsyncExecutionIds` callback keeps the dependency one-directional (status tool → executor, not circular)
- Pass `workflowStatusTool` to `ToolBindingExecutor` constructor (new optional field)

  1.6. **Add dispatch in `ToolBindingExecutor`**:

- Add `workflowStatusTool?: ToolExecutor` field to `ToolBindingExecutorConfig` (line 67 — NOTE: the interface is `ToolBindingExecutorConfig`, not `ToolBindingExecutorOptions`) and populate in constructor
- In `dispatch()` method (line 523), add name-based check BEFORE the `if (!tool)` guard (line 529): `if (toolName === 'check_workflow_status' && this.workflowStatusTool) { return this.workflowStatusTool.execute(toolName, params, effectiveTimeout); }`. This intercept must come before line 529 because `check_workflow_status` is a system tool NOT in the `tools` Map — without early interception, it would hit the `!tool` fallback/throw branch.
- **Known gap**: This intercept bypasses the middleware chain (logging, PII, audit) in `execute()` (lines 401-411) because `tool` is undefined for system tools. Acceptable for Phase 1 — the status tool only returns execution status data. Future improvement: add middleware coverage by constructing a synthetic `ToolCallContext` with `toolType: 'system'`.

**Files Touched**:

- `apps/runtime/src/services/workflow/workflow-status-tool.ts` — NEW
- `apps/runtime/src/services/workflow/workflow-tool-executor.ts` — add `asyncExecutionIds`, enrich async return
- `apps/runtime/src/services/execution/prompt-builder.ts` — inject companion tool definition
- `apps/runtime/src/services/execution/types.ts` — add `_workflowStatusToolActive` to `RuntimeSession`
- `apps/runtime/src/services/execution/llm-wiring.ts` — create `WorkflowStatusTool`, set session flag
- `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` — name-based dispatch in `dispatch()` before `!tool` guard

**Exit Criteria**:

- [ ] `pnpm build --filter @abl/compiler` succeeds with 0 errors
- [ ] `pnpm build --filter @abl/runtime` succeeds with 0 errors
- [ ] `WorkflowStatusTool` returns result for known executionId from Redis
- [ ] `WorkflowStatusTool` falls back to GET when Redis miss
- [ ] `WorkflowStatusTool` rejects unknown executionId with error message (not throw)
- [ ] `WorkflowToolExecutor.execute()` in async mode returns enriched `{ executionId, status, message }`
- [ ] `buildTools()` includes `check_workflow_status` when `session._workflowStatusToolActive` is true
- [ ] `buildTools()` does NOT include `check_workflow_status` when flag is false
- [ ] `ToolBindingExecutor` dispatches `check_workflow_status` to the status tool

**Test Strategy**:

- Unit: `WorkflowStatusTool` — session-scoped rejection, Redis hit, Redis miss fallback to GET, error formatting
- Unit: `WorkflowToolExecutor` — asyncExecutionIds tracking, enriched async response
- Unit: `buildTools()` — companion tool injection conditional on flag

**Rollback**: Revert the commit. No data model changes, no migrations. Companion tool simply disappears from tool list.

---

### Phase 2: Push Callback — Workflow-Engine Changes (FR-4, FR-9)

**Goal**: Workflow-engine signs agent-tool callbacks with `INTERNAL_CALLBACK_SECRET` and includes full context in callback payload.

**Tasks**:

2.1. **Widen `CallbackDeliveryDeps.webhookSecret`** in `callback-delivery-worker.ts`:

- Change interface from `(tenantId: string) => Promise<string>` to `(tenantId: string, source?: string) => Promise<string>`
- In `processJob()` (line 102), change call to: `const secret = await this.deps.webhookSecret(tenantId, job.data.source)`

  2.2. **Extend `CallbackJobData`** with `source?: string` field:

- Add `source?: string` to the `CallbackJobData` interface (after `callbackUrl`)

  2.3. **Update callback enqueue in `workflow-handler.ts`** (TWO sites):

- **Success path** (~line 1359): Include `source: input.triggerMetadata?.source` in `CallbackJobData` and extend payload with `executionId`, `tenantId: input.tenantId`, `projectId: input.projectId`, `sessionId: input.triggerMetadata?.sessionId`, `workflowId`, `workflowName`, `source: input.triggerMetadata?.source`
- **Failure path** (~line 1416): Same enrichment — push callbacks must fire on both success and failure terminal states so the agent receives the error result

  2.4. **Add `callbackUrl` to `triggerMetadata` in `WorkflowToolExecutor`**:

- In the POST body for async mode (line 105-114), add: `callbackUrl: process.env.RUNTIME_URL ? \`${process.env.RUNTIME_URL}/api/internal/workflow-callback\` : undefined`
- Only set when `binding.mode === 'async'` AND `process.env.RUNTIME_URL` is defined

  2.5. **Update `webhookSecret` resolver** at `apps/workflow-engine/src/index.ts:461-467`:

- Current resolver (line 462): `async (tenantId: string) => { ... }` — returns `${secret}:${tenantId}`
- Widen to: `async (tenantId: string, source?: string) => { if (source === 'agent_tool') { const internalSecret = process.env.INTERNAL_CALLBACK_SECRET; if (!internalSecret) throw new Error('INTERNAL_CALLBACK_SECRET not configured'); return internalSecret; } ... }`
- Otherwise, fall back to existing tenant webhook secret logic

**Files Touched**:

- `apps/workflow-engine/src/services/callback-delivery-worker.ts` — widen interface, pass `source`
- `apps/workflow-engine/src/handlers/workflow-handler.ts` — enrich callback job data
- `apps/runtime/src/services/workflow/workflow-tool-executor.ts` — add `callbackUrl` to triggerMetadata
- `apps/workflow-engine/src/index.ts` — update resolver at line 461-467 to handle `source === 'agent_tool'`

**Exit Criteria**:

- [ ] `pnpm build --filter @abl/workflow-engine` succeeds with 0 errors
- [ ] `pnpm build --filter @abl/runtime` succeeds with 0 errors
- [ ] `CallbackDeliveryWorker` uses internal secret when `source === 'agent_tool'`
- [ ] `CallbackDeliveryWorker` uses tenant secret when `source` is undefined (backward compatible)
- [ ] Async workflow execution POST includes `callbackUrl` in `triggerMetadata` when `RUNTIME_URL` is set
- [ ] Callback payload includes `executionId`, `tenantId`, `projectId`, `sessionId`, `workflowId`, `workflowName`

**Test Strategy**:

- Unit: `CallbackDeliveryWorker` — internal secret resolution for `source: 'agent_tool'`, tenant secret for undefined source
- Unit: `WorkflowToolExecutor` — callbackUrl presence in triggerMetadata for async mode
- Integration: Callback job enqueue → delivery with correct HMAC (internal secret)

**Rollback**: Revert the commit. The `webhookSecret` signature widening is backward-compatible (optional param). No data model changes.

---

### Phase 3: Push Callback — Runtime Endpoint & Session Injection (FR-5, FR-6, FR-7, FR-10)

**Goal**: Runtime receives push callbacks, persists results, injects session messages, and emits WebSocket events.

**Tasks**:

3.1. **Create `WorkflowCallbackHandler`** at `apps/runtime/src/services/workflow/workflow-callback-handler.ts`:

- Constructor: `{ redis: Redis, messageStore: DualWriteMessageStore, internalWsManager: WebSocketConnectionManager, sdkWsManager: WebSocketConnectionManager, internalSecret: string, asyncResultTtlHours?: number }`
- Define Zod schema `WorkflowCallbackPayloadSchema`:
  ```typescript
  const WorkflowCallbackPayloadSchema = z.object({
    executionId: z.string().min(1),
    tenantId: z.string().min(1),
    projectId: z.string().min(1),
    sessionId: z.string().min(1),
    workflowId: z.string().min(1),
    workflowName: z.string().min(1),
    status: z.string().min(1),
    output: z.record(z.unknown()).optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    source: z.literal('agent_tool'),
  });
  ```
- `verifyHmac(body: string, signature: string, timestamp: string): boolean` — delegates to `verifyWebhookSignature()` from `@agent-platform/shared-kernel/security`
- `handleCallback(rawPayload: unknown): Promise<{ injected: boolean }>`:
  1.  Validate with `WorkflowCallbackPayloadSchema.safeParse(rawPayload)` — return validation error if invalid
  2.  Persist to Redis: `SET workflow:{tenantId}:{projectId}:async-result:{executionId}` with TTL (value includes `sessionId` for isolation verification)
  3.  Format system message per FR-7: `[Workflow Complete] Execution {executionId}...` or `[Workflow Failed]...`
  4.  Try `messageStore.addMessage({ sessionId: payload.sessionId, role: 'system', content: message, channel: 'api', traceId: payload.executionId, tenantId: payload.tenantId, projectId: payload.projectId })` — catch errors (session may not exist). Note: `'api'` is a valid `Channel` value (confirmed at `packages/compiler/src/platform/core/types.ts:79`). `DualWriteMessageStore.addMessage()` matches `AddMessageParams`.
  5.  Broadcast `workflow.result` event via `internalWsManager.broadcastToSession(...)` AND `sdkWsManager.broadcastToSession(...)` — user may be connected via either WS path
  6.  Log telemetry: `tool.workflow.callback.received`, `tool.workflow.callback.injected` or `tool.workflow.callback.session_inactive`
  7.  Return `{ injected: true/false }`

  3.2. **Add `broadcastToSession()` to `WebSocketConnectionManager`**:

- New method: `broadcastToSession(sessionId: string, event: string, data: unknown): number`
- Linear scan of `this.clients` entries, check `(state.sessionId as string | undefined) === sessionId`, send JSON message to matching WebSocket connections (strict `===` comparison with type assertion via index signature)
- Return count of messages sent (0 if no active connections)
- **WS manager access**: Both `clients` (in `handler.ts:276`) and `sdkClients` (in `sdk-handler.ts:246`) are module-private `const` variables. To make them accessible from `server.ts` for wiring into the callback handler, export a getter function from each module: `export function getInternalConnectionManager()` and `export function getSdkConnectionManager()`. The callback handler should broadcast to BOTH managers (a user may be connected via internal WS or SDK WS).

  3.3. **Create callback route** at `apps/runtime/src/routes/internal-callbacks.ts`:

- `POST /` handler:
  1.  Raw body is already captured by global `express.json({ verify })` middleware at `server.ts:443-449` — access via `(req as any).rawBody` (Buffer), call `.toString()`. Do NOT add a second `express.json` on this route. Follows existing pattern in `routes/channel-webhooks.ts:90` and `routes/callbacks.ts:84-86`.
  2.  Extract `x-webhook-signature` and `x-webhook-timestamp` headers
  3.  Verify HMAC via `callbackHandler.verifyHmac(rawBody, signature, timestamp)` → on failure return `401 { success: false, error: { code: 'HMAC_VERIFICATION_FAILED', message: 'Invalid signature' } }`
  4.  Call `callbackHandler.handleCallback(req.body)` — Zod validation happens inside the handler
  5.  On Zod validation failure → return `400 { success: false, error: { code: 'VALIDATION_ERROR', message: zodError.message } }`
  6.  On success → return `200 { success: true }`
  7.  On transient processing error → return `500 { success: false, error: { code: 'INTERNAL_ERROR', message } }` (retriable by `CallbackDeliveryWorker`)
- The handler instance is created in `server.ts` and passed via router factory function

  3.4. **Register route and wire handler in `server.ts`**:

- Access message store via `getStores().message` (imported at `server.ts:159` via `./services/stores/store-factory.js`) — the type is `DualWriteMessageStore` which implements `addMessage(params: AddMessageParams)`
- Access Redis via `getRedisClient()` from `./redis/redis-client.js` (already used throughout server.ts)
- Access WS managers via new getter exports: `getInternalConnectionManager()` from `./websocket/handler.js` and `getSdkConnectionManager()` from `./websocket/sdk-handler.js`
- Instantiate `WorkflowCallbackHandler({ redis, messageStore: getStores().message, internalWsManager: getInternalConnectionManager(), sdkWsManager: getSdkConnectionManager(), internalSecret: process.env.INTERNAL_CALLBACK_SECRET })`
- Create router via factory: `createInternalCallbacksRouter(callbackHandler)`
- Register: `app.use('/api/internal/workflow-callback', internalCallbacksRouter)` (no `requireServiceAuth` — HMAC auth, not JWT)

  3.5. **Add telemetry events** (FR-10):

- `tool.workflow.async.started` — in `WorkflowToolExecutor` async block (already has log, add structured event)
- `tool.workflow.callback.received` — in `WorkflowCallbackHandler.handleCallback()`
- `tool.workflow.callback.injected` — after successful `messageStore.addMessage()`
- `tool.workflow.status.polled` — in `WorkflowStatusTool.execute()`
- `tool.workflow.callback.session_inactive` — when session injection fails/skipped

**Files Touched**:

- `apps/runtime/src/services/workflow/workflow-callback-handler.ts` — NEW
- `apps/runtime/src/routes/internal-callbacks.ts` — NEW
- `apps/runtime/src/websocket/connection-manager.ts` — add `broadcastToSession()`
- `apps/runtime/src/websocket/handler.ts` — export `getInternalConnectionManager()` getter
- `apps/runtime/src/websocket/sdk-handler.ts` — export `getSdkConnectionManager()` getter
- `apps/runtime/src/server.ts` — register route, wire handler with stores + Redis + WS managers
- `apps/runtime/src/services/workflow/workflow-tool-executor.ts` — telemetry event
- `apps/runtime/src/services/workflow/workflow-status-tool.ts` — telemetry event

**Exit Criteria**:

- [ ] `pnpm build --filter @abl/runtime` succeeds with 0 errors
- [ ] `POST /api/internal/workflow-callback` with valid HMAC returns 200
- [ ] `POST /api/internal/workflow-callback` with invalid HMAC returns 401
- [ ] `POST /api/internal/workflow-callback` with `source !== 'agent_tool'` returns 400 (Zod validation error)
- [ ] Callback persists result to Redis key `workflow:{tenantId}:{projectId}:async-result:{executionId}`
- [ ] Callback injects system message into active session via `messageStore.addMessage()`
- [ ] System message format matches FR-7 for completed and failed executions
- [ ] `broadcastToSession()` sends event to WebSocket connections with matching sessionId
- [ ] Telemetry events emitted for all completion paths (FR-10)

**Test Strategy**:

- Unit: `WorkflowCallbackHandler` — HMAC verification, Redis persist, message formatting (completed/failed), session injection error handling
- Unit: `broadcastToSession()` — sends to matching connections, skips non-matching
- Integration: Full callback flow — POST to endpoint → Redis + session message

**Rollback**: Revert the commit. The route is new and isolated. No data model changes.

---

## 4. Wiring Checklist

- [ ] `WorkflowStatusTool` class exported from `apps/runtime/src/services/workflow/workflow-status-tool.ts`
- [ ] `WorkflowStatusTool` instantiated in `llm-wiring.ts` and passed to `ToolBindingExecutor`
- [ ] `_workflowStatusToolActive?: boolean` added to `RuntimeSession` in `apps/runtime/src/services/execution/types.ts`
- [ ] `ToolBindingExecutor` constructor accepts optional `workflowStatusTool` field
- [ ] `ToolBindingExecutor` dispatches `check_workflow_status` in `dispatch()` BEFORE `!tool` guard (line 529)
- [ ] `buildTools()` includes `check_workflow_status` definition when `session._workflowStatusToolActive`
- [ ] `WorkflowCallbackHandler` class exported from `apps/runtime/src/services/workflow/workflow-callback-handler.ts`
- [ ] `internal-callbacks.ts` route uses `WorkflowCallbackHandler` instance
- [ ] Route registered in `server.ts` at `/api/internal/workflow-callback`
- [ ] `broadcastToSession()` method added to `WebSocketConnectionManager`
- [ ] `getInternalConnectionManager()` getter exported from `apps/runtime/src/websocket/handler.ts`
- [ ] `getSdkConnectionManager()` getter exported from `apps/runtime/src/websocket/sdk-handler.ts`
- [ ] `CallbackDeliveryWorker.webhookSecret` signature widened in workflow-engine
- [ ] Webhook secret resolver updated to check `source === 'agent_tool'` → return internal secret
- [ ] `WorkflowToolExecutor` includes `callbackUrl` in `triggerMetadata` for async executions
- [ ] `workflow-handler.ts` includes `source` field in `CallbackJobData` when enqueueing

---

## 5. Cross-Phase Concerns

### Database Migrations

None. Redis keys are new and self-managing (TTL-based expiry). No MongoDB schema changes.

### Feature Flags

None. Both polling and push are always active when async workflow tools exist.

### Configuration Changes

| Variable                   | Service          | Default                 | Required     |
| -------------------------- | ---------------- | ----------------------- | ------------ |
| `INTERNAL_CALLBACK_SECRET` | runtime + engine | (none)                  | Production   |
| `RUNTIME_URL`              | runtime          | `http://localhost:3112` | Production   |
| `ASYNC_RESULT_TTL_HOURS`   | runtime          | `24`                    | No (default) |

Both `INTERNAL_CALLBACK_SECRET` must match across runtime and workflow-engine deployments.

**Local development note**: Push callback (Phase 3) is disabled unless `RUNTIME_URL` and `INTERNAL_CALLBACK_SECRET` are both explicitly set. The polling tool (Phase 1) works regardless. In local dev, only polling is available by default. Additionally, even when `RUNTIME_URL` is set to `http://localhost:3112`, the `assertUrlSafeForSSRF` check in `CallbackDeliveryWorker` (line 90) blocks localhost URLs. For local push testing, use `host.docker.internal` or a non-localhost hostname, or add a dev-only SSRF bypass for `source: 'agent_tool'` callbacks.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 3 phases complete with exit criteria met
- [ ] FR-1: `check_workflow_status` tool appears in LLM tool list when async workflow tools are active
- [ ] FR-2: Polling tool rejects cross-session executionId with error message
- [ ] FR-3: Polling tool uses two-tier fallback (Redis → GET)
- [ ] FR-4: Async execution includes `callbackUrl` in triggerMetadata
- [ ] FR-5: Callback endpoint verifies HMAC, returns 200/401/500
- [ ] FR-6: Push result persisted to Redis and injected into active session
- [ ] FR-7: System message format correct for completed and failed executions
- [ ] FR-8: Async tool response includes `message` with polling instructions
- [ ] FR-9: Workflow-engine uses internal secret for `source: 'agent_tool'` callbacks
- [ ] FR-10: Telemetry events emitted for all completion paths
- [ ] No regressions: `pnpm build && pnpm test` on affected packages
- [ ] All files formatted with prettier

---

## 7. Open Questions

1. ~~**Raw body for HMAC verification**~~: **DECIDED** — global `express.json({ verify })` at `server.ts:443-449` already captures raw body. Use `(req as any).rawBody.toString()` in the callback route. Matches existing pattern in `routes/channel-webhooks.ts:90`.
2. **WebSocket sessionId field**: `ManagedClientState` has `[key: string]: unknown` — callers store `sessionId` but it's not typed. `broadcastToSession()` reads `state.sessionId` via the index signature with type assertion. Consider adding explicit `sessionId?: string` to `ManagedClientState` in a follow-up to reduce fragility.
3. ~~**Redis connection in `WorkflowStatusTool`**~~: **DECIDED** — use `getRedisClient()` from `../redis/redis-client.js`, already imported and used in `llm-wiring.ts` (line 74, 451, 1285).

**Note**: Phases are SEQUENTIAL (not parallelizable) — `workflow-tool-executor.ts` is modified in all 3 phases (Phase 1: asyncExecutionIds, Phase 2: callbackUrl, Phase 3: telemetry).
