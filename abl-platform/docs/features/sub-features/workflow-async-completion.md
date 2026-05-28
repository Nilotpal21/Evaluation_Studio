# Feature: Workflow Async Completion (Polling + Push)

**Doc Type**: SUB-FEATURE
**Parent Feature**: workflow-as-tool.md
**Status**: ALPHA
**Feature Area(s)**: `agent lifecycle`, `integrations`
**Package(s)**: `apps/runtime`, `apps/workflow-engine`, `packages/compiler`
**Owner(s)**: Platform / Agent Runtime
**Testing Guide**: `../../testing/sub-features/workflow-async-completion.md`
**Last Updated**: 2026-04-14

---

## 1. Introduction / Overview

### Problem Statement

When an agent calls a workflow tool in `mode: 'async'`, the executor returns `{ executionId, status: 'running' }` immediately and the agent has **no way to get the result**. The workflow completes minutes later, but the agent cannot check its outcome or receive a notification. This makes async workflow tools effectively fire-and-forget — usable only when the agent doesn't care about the result. Builders who need the workflow's output but can't block the agent turn (long-running approvals, data enrichment) have no viable path.

> **Parent non-goal now in scope**: The parent feature spec (`workflow-as-tool.md` §2 Non-Goals) explicitly deferred "A companion 'wait-for-workflow-execution' tool to pair with `mode: 'async'`". This sub-feature implements that deferred capability. The tool is named `check_workflow_status` (polling, not blocking-wait) to reflect its non-blocking semantics — the agent calls it when it wants to check, rather than blocking until completion.

### Goal Statement

Provide two complementary completion mechanisms for async workflow tool executions: (1) a **polling companion tool** (`check_workflow_status`) the agent can call to retrieve execution status/output on demand, and (2) a **push callback** where the workflow-engine delivers the result to the runtime when execution terminates, and the runtime injects it into the agent session as a new turn.

### Summary

When an async workflow tool is registered in a session, the runtime auto-injects a `check_workflow_status` companion tool (system tool, not a project-level Tool entity). The agent can call it with an `executionId` to get the current status and output. Independently, the runtime sets a `callbackUrl` in `triggerMetadata` when starting every async execution. The workflow-engine's existing `CallbackDeliveryWorker` (BullMQ, HMAC-signed, retries) POSTs the result to this URL when the execution reaches a terminal state. The runtime's callback endpoint processes the result and, if the session is still active, injects it as a system message in a new turn. If the session has ended, the result is persisted in Redis (24h TTL) for later retrieval via the polling tool.

---

## 2. Scope

### Goals

- Auto-register a `check_workflow_status(executionId)` companion tool when any `mode: 'async'` workflow tool is active in a session.
- The polling tool returns `{ status, output?, executionId, workflowId }` for executions started by the current session.
- Runtime sets `callbackUrl` in `triggerMetadata` for every async agent-tool execution.
- New runtime endpoint `POST /api/internal/workflow-callback` receives push results from the workflow-engine.
- On push receipt, inject the result as a system message if the session is active; persist to Redis if not.
- Async tool response enriched with polling instructions for the LLM.
- HMAC verification of push callbacks using a separate internal-service signing key.

### Non-Goals (Out of Scope)

- **Cancel companion tool** — exposing `cancel_workflow(executionId)` to the LLM requires product guardrails (confirmation steps); deferred to a follow-up.
- **Cross-session polling** — the polling tool only returns results for executions started in the current session (user-isolation invariant).
- **Custom per-tool polling/push configuration** — both mechanisms are always available; no per-tool toggle.
- **WebSocket-only delivery** — WebSocket is a supplementary real-time signal, not a replacement for the REST callback endpoint.
- **Streaming intermediate workflow step events** — already out of scope in the parent feature.

---

## 3. User Stories

1. As an **agent builder**, I want the agent to check the status of a long-running async workflow so it can report the result to the user when asked "is it done yet?"
2. As an **agent builder**, I want the runtime to automatically notify the agent when an async workflow completes so the user gets the result without having to ask.
3. As an **agent builder**, I want the async tool's response to tell the agent how to check status so the LLM knows about the `check_workflow_status` tool without me writing custom prompts.
4. As an **agent operator**, I want the polling tool scoped to the current session so agents can't query other users' workflow executions.
5. As an **agent builder**, I want results persisted even if the user disconnects, so if they reconnect and ask about a previous workflow, the agent can still retrieve the output.

---

## 4. Functional Requirements

1. **FR-1**: When at least one `mode: 'async'` workflow tool binding is registered in a session, the runtime must auto-inject a `check_workflow_status` system tool into the LLM tool list. The tool must accept `executionId: string` (required) and return `{ status: string, output?: object, executionId: string, workflowId: string }`.
2. **FR-2**: The `check_workflow_status` tool must only return results for execution IDs that were initiated by the current session. Queries for unknown or other-session execution IDs must return an error message (not a 404 or throw).
3. **FR-3**: The `check_workflow_status` tool must first check the Redis async-result store (`workflow:{tenantId}:{projectId}:async-result:{executionId}`), then fall back to a GET call to the workflow-engine execution status endpoint. There is no pod-local cache — all shared state lives in Redis or MongoDB per the stateless-distributed invariant (CLAUDE.md invariant 3).
4. **FR-4**: When the `WorkflowToolExecutor` starts an async execution, it must include `callbackUrl: '{RUNTIME_URL}/api/internal/workflow-callback'` in the `triggerMetadata` of the POST request to the workflow-engine.
5. **FR-5**: The runtime must expose a `POST /api/internal/workflow-callback` endpoint that accepts HMAC-signed payloads from the workflow-engine. The endpoint must verify the HMAC signature using a shared `INTERNAL_CALLBACK_SECRET` environment variable. On success, return `200 { success: true }`. On invalid HMAC, return `401 { error: 'Invalid signature' }` (permanent failure, no retry). On transient processing errors, return `500 { error: { code, message } }` (retriable by the `CallbackDeliveryWorker`).
6. **FR-6**: When the callback endpoint receives a terminal execution result, it must: (a) persist the result to Redis key `workflow:{tenantId}:{projectId}:async-result:{executionId}` with 24h TTL (value includes `sessionId` and `projectId` for isolation checks), and (b) if the originating session is active, append the result as a system-role message via `StoreFactory.addMessage({ sessionId, role: 'system', content, ... })` (or the underlying `MongoMessageStore.addMessage()`) and emit a WebSocket event (`workflow.result`) to notify connected clients. The runtime does NOT auto-trigger a new LLM turn — the injected message is passive and will be included in the next LLM call when the user sends a message or the agent framework processes the next turn.
7. **FR-7**: The system message format for push results must be: `[Workflow Complete] Execution {executionId} for workflow "{workflowName}" completed successfully.\nOutput: {JSON output (truncated to 2000 chars)}` for completed executions, and `[Workflow Failed] Execution {executionId} for workflow "{workflowName}" {status}. Error: {error.code} — {error.message}` for failures.
8. **FR-8**: The async tool response must be enriched from `{ executionId, status: 'running' }` to include a `message` field: `"Workflow execution started. You will be notified when it completes. To check status manually, call check_workflow_status with this executionId."`.
9. **FR-9**: The `CallbackDeliveryWorker` in the workflow-engine must support resolving the `INTERNAL_CALLBACK_SECRET` for internal callback URLs. The `CallbackDeliveryDeps.webhookSecret` interface must be widened from `(tenantId: string) => Promise<string>` to `(tenantId: string, source?: string) => Promise<string>`. When `source === 'agent_tool'` (passed from `CallbackJobData`), the resolver returns `process.env.INTERNAL_CALLBACK_SECRET`. The `CallbackJobData` type must be extended with an optional `source?: string` field populated from `triggerMetadata.source` when the callback is enqueued.
10. **FR-10**: The runtime must emit telemetry for: (a) async executions started with callback URL, (b) push callbacks received, (c) push results injected into sessions, (d) polling tool invocations.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                             |
| -------------------------- | ------------ | ------------------------------------------------- |
| Project lifecycle          | NONE         |                                                   |
| Agent lifecycle            | PRIMARY      | Changes how agents receive async workflow results |
| Customer experience        | SECONDARY    | Users see workflow results automatically via push |
| Integrations / channels    | SECONDARY    | WebSocket notification enhances real-time UX      |
| Observability / tracing    | SECONDARY    | New telemetry for async completion paths          |
| Governance / controls      | NONE         |                                                   |
| Enterprise / compliance    | SECONDARY    | Internal callback uses separate signing key       |
| Admin / operator workflows | NONE         |                                                   |

### Related Feature Integration Matrix

| Related Feature       | Relationship Type | Why It Matters                                                        | Key Touchpoints                                                        | Current State                             |
| --------------------- | ----------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| workflow-as-tool      | extends           | Parent feature; this adds completion to async mode                    | `WorkflowToolExecutor`, `prompt-builder.ts`, IR schema                 | BETA — async returns fire-and-forget      |
| workflows             | depends on        | Execution engine, `CallbackDeliveryWorker`, execution status API      | `workflow-handler.ts`, `callback-delivery-worker.ts`, execution routes | STABLE — callback infra exists            |
| agent-anatomy (Tools) | extends           | Adds a new system tool type (`check_workflow_status`)                 | `prompt-builder.ts:buildTools()`, `ToolBindingExecutor`                | STABLE — system tools pattern established |
| sessions              | shares data with  | Push injects messages into session; polling reads session-scoped data | `session-factory.ts`, `SessionService`, conversation store             | STABLE                                    |

---

## 6. Design Considerations (Optional)

**Push result UX**: When a push callback arrives and the user has a WebSocket connection, the UI should display a notification or update the chat to show the workflow result. This mirrors how agent "thinking" indicators work — the result appears as a new message in the conversation.

**Polling UX**: The LLM decides when to call `check_workflow_status`. A well-crafted tool description guides the agent to check proactively or in response to user queries like "is the approval done?"

---

## 7. Technical Considerations (Optional)

- **Stateless-distributed**: The runtime callback endpoint must not assume the originating pod handles the callback. Session lookup is via MongoDB/Redis, not in-memory state (CLAUDE.md invariant 3). No pod-local caches for async results.
- **HMAC signing**: Internal callbacks use `INTERNAL_CALLBACK_SECRET`, not the tenant webhook secret. The `CallbackDeliveryDeps.webhookSecret` signature widens from `(tenantId: string) => Promise<string>` to `(tenantId: string, source?: string) => Promise<string>`. When `source === 'agent_tool'`, the resolver returns the internal secret. `CallbackJobData` gains a `source?: string` field.
- **Redis key schema**: `workflow:{tenantId}:{projectId}:async-result:{executionId}` — 24h TTL. JSON value: `{ status, output, error, workflowId, workflowName, executionId, sessionId, projectId, completedAt }`. The `sessionId` and `projectId` fields enable the polling tool to enforce session-scoped and project-scoped isolation without a secondary lookup.
- **Session injection mechanism**: The callback handler resolves the `sessionId` from `triggerMetadata.sessionId` and calls `StoreFactory.addMessage({ sessionId, role: 'system', content: formattedResult })` (facade over `MongoMessageStore.addMessage()`) to append the system-role message. This is a **passive append** — it does NOT trigger a new LLM turn. The message will be included in the conversation context on the next user message or agent framework turn. If the client has an active WebSocket connection, the handler emits a `workflow.result` event. NOTE: Session-targeted WebSocket emission is implemented via `broadcastToSession(sessionId, event, data)` on `WebSocketConnectionManager` — a linear scan bounded by maxConnections (10k), <1ms typical. Both internal and SDK WS managers are broadcast to via getter exports (`getInternalConnectionManager()`, `getSdkConnectionManager()`).
- **Session not found**: If the session has ended or the `sessionId` is not resolvable, the handler persists the result to Redis only (no conversation append). The polling tool can still retrieve it if the session is resumed.

---

## 8. How to Consume

### Studio UI

No new Studio UI for this sub-feature. The existing workflow tool creation dialog and detail page remain unchanged. The push result appears in the agent conversation as a system message. The polling tool appears in the LLM tool list automatically.

### API (Runtime)

| Method | Path                              | Purpose                                    |
| ------ | --------------------------------- | ------------------------------------------ |
| POST   | `/api/internal/workflow-callback` | Receives push results from workflow-engine |

### API (Studio)

N/A — no Studio-side routes.

### Admin Portal

N/A.

### Channel / SDK / Voice / A2A / MCP Integration

The push system message and polling tool work across all channels (WebSocket, REST, SDK, A2A) because they operate at the session/conversation level. WebSocket-connected clients additionally receive a real-time event.

---

## 9. Data Model

### Collections / Tables

No new collections. Changes to existing data:

```text
Redis key: workflow:{tenantId}:{projectId}:async-result:{executionId}
TTL: 24 hours
Value (JSON):
  - status: string ('completed' | 'failed' | 'cancelled' | 'rejected')
  - output: object | null
  - error: string | null
  - workflowId: string
  - workflowName: string
  - executionId: string
  - sessionId: string (originating agent session — for isolation enforcement)
  - projectId: string (for project-scoped isolation enforcement)
  - completedAt: string (ISO 8601)
```

### Key Relationships

- `executionId` links to `workflow_executions._id` in MongoDB (existing)
- `sessionId` in `triggerMetadata` links to the originating agent session
- Redis async-result is a cache — authoritative data remains in the workflow-engine's execution store

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                              | Purpose                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `apps/runtime/src/services/workflow/workflow-tool-executor.ts`    | Enrich async response, track executionIds, set callbackUrl |
| `apps/runtime/src/services/workflow/workflow-status-tool.ts`      | NEW — companion polling tool implementation                |
| `apps/runtime/src/services/workflow/workflow-callback-handler.ts` | NEW — push callback processing logic                       |

### Routes / Handlers

| File                                            | Purpose                                               |
| ----------------------------------------------- | ----------------------------------------------------- |
| `apps/runtime/src/routes/internal-callbacks.ts` | NEW — `POST /api/internal/workflow-callback` endpoint |

### UI Components

N/A — no new UI components.

### Jobs / Workers / Background Processes

| File                                                            | Purpose                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/workflow-engine/src/services/callback-delivery-worker.ts` | MODIFY — widen `CallbackDeliveryDeps.webhookSecret` interface, add `source` to `CallbackJobData` |

### Wiring / Dispatch

| File                                                                           | Purpose                                                           |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `apps/runtime/src/services/execution/llm-wiring.ts`                            | MODIFY — create WorkflowStatusTool, pass to ToolBindingExecutor   |
| `apps/runtime/src/services/execution/prompt-builder.ts`                        | MODIFY — inject check_workflow_status into LLM tool list          |
| `apps/runtime/src/services/execution/types.ts`                                 | MODIFY — add `_workflowStatusToolActive` to RuntimeSession        |
| `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` | MODIFY — name-based dispatch for check_workflow_status            |
| `apps/runtime/src/websocket/connection-manager.ts`                             | MODIFY — add broadcastToSession() helper                          |
| `apps/runtime/src/websocket/handler.ts`                                        | MODIFY — export getInternalConnectionManager() getter             |
| `apps/runtime/src/websocket/sdk-handler.ts`                                    | MODIFY — export getSdkConnectionManager() getter                  |
| `apps/runtime/src/server.ts`                                                   | MODIFY — register /api/internal/workflow-callback route           |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`                        | MODIFY — enrich callback payload with sessionId, workflowId, etc. |
| `apps/workflow-engine/src/index.ts`                                            | MODIFY — INTERNAL_CALLBACK_SECRET resolver for agent_tool source  |

### Tests

| File                                                                     | Type        | Coverage Focus                                           |
| ------------------------------------------------------------------------ | ----------- | -------------------------------------------------------- |
| `apps/runtime/src/__tests__/workflow-status-tool.test.ts`                | unit        | Redis/GET fallback, input validation, session tracking   |
| `apps/runtime/src/__tests__/workflow-callback-handler.test.ts`           | unit        | Zod validation, Redis persist, message formatting, WS    |
| `apps/runtime/src/__tests__/workflow-async-callback.integration.test.ts` | integration | HMAC verification, replay protection, full callback flow |
| `apps/workflow-engine/src/__tests__/callback-delivery-internal.test.ts`  | unit        | Internal vs tenant secret resolution                     |

---

## 11. Configuration

### Environment Variables

| Variable                   | Default                  | Description                                             |
| -------------------------- | ------------------------ | ------------------------------------------------------- |
| `INTERNAL_CALLBACK_SECRET` | (required in production) | Shared HMAC key for runtime ↔ workflow-engine callbacks |
| `RUNTIME_URL`              | `http://localhost:3112`  | Runtime's externally-reachable URL (for callbackUrl)    |
| `ASYNC_RESULT_TTL_HOURS`   | `24`                     | TTL for Redis async-result keys                         |

### Runtime Configuration

No feature flags. Both polling and push are always active for async workflow tools.

### DSL / Agent IR / Schema

The companion tool `check_workflow_status` is a **system tool** injected by `prompt-builder.ts:buildTools()`. It does not appear in the IR, DSL, or project_tools collection. Its definition:

```typescript
{
  name: 'check_workflow_status',
  description: 'Check the status and output of an async workflow execution started in this session. Returns the current status, and the output if the workflow has completed.',
  parameters: {
    type: 'object',
    properties: {
      executionId: {
        type: 'string',
        description: 'The executionId returned by the async workflow tool call'
      }
    },
    required: ['executionId']
  }
}
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| Project isolation | Polling tool only queries executions within the same `tenantId` + `projectId`.                                    |
| Tenant isolation  | Callback endpoint validates `tenantId` from HMAC payload matches execution record. Redis keys include `tenantId`. |
| User isolation    | Polling tool only returns results for executions started by the current session (`sessionId` match).              |

### Security & Compliance

- Callback endpoint verifies HMAC-SHA256 signature using `INTERNAL_CALLBACK_SECRET`.
- `INTERNAL_CALLBACK_SECRET` is separate from tenant webhook secrets (blast radius isolation).
- Callback endpoint validates `source: 'agent_tool'` in payload to reject external misuse.
- SSRF protection on the callback URL is already handled by `CallbackDeliveryWorker` (`assertUrlSafeForSSRF`).

### Performance & Scalability

- Polling tool does a single GET to the workflow-engine (no backoff loop). Latency: ~50ms internal call.
- Push callback adds negligible overhead — one POST per terminal execution.
- Redis async-result keys use 24h TTL with automatic eviction.

### Reliability & Failure Modes

- If push callback fails all retries (3 attempts, exponential backoff), the result is still available via polling (execution document in MongoDB is authoritative).
- If Redis is down, polling falls back to direct GET to workflow-engine.
- If the runtime pod that receives the callback can't find the session, the result is persisted to Redis for later retrieval.

### Observability

- `tool.workflow.async.dispatched` — logged when async execution begins with callbackUrl
- `tool.workflow.callback.received` — logged when push callback arrives
- `tool.workflow.callback.injected` — logged when result is injected into session
- `tool.workflow.status.polled` — logged when companion tool is invoked
- `tool.workflow.callback.session_inactive` — logged when callback arrives but session is not active

### Data Lifecycle

- Redis async-result keys: 24h TTL (configurable via `ASYNC_RESULT_TTL_HOURS`).
- Execution records in MongoDB: governed by the workflow-engine's existing retention policy.
- Session messages (injected system messages): governed by the session's conversation retention policy.

---

## 13. Delivery Plan / Work Breakdown

1. **Polling companion tool**
   1.1 Add `check_workflow_status` tool definition to `prompt-builder.ts:buildTools()` (inject when async workflow tools exist)
   1.2 Implement `WorkflowStatusTool` class in `apps/runtime/src/services/workflow/workflow-status-tool.ts`
   1.3 Track async execution IDs in `WorkflowToolExecutor` (session-scoped set)
   1.4 Wire `WorkflowStatusTool` into `ToolBindingExecutor` dispatch
   1.5 Enrich async tool response with `message` field (FR-8)
   1.6 Unit tests for session-scoped ID tracking and status retrieval

2. **Push callback — runtime endpoint**
   2.1 Create `POST /api/internal/workflow-callback` route with HMAC verification
   2.2 Implement `WorkflowCallbackHandler` — HMAC check, Redis persistence, session injection
   2.3 Register route in runtime server (internal routes, no tenant auth middleware)
   2.4 Unit tests for HMAC verification and result persistence

3. **Push callback — workflow-engine integration**
   3.1 Extend `CallbackDeliveryWorker.deps.webhookSecret` to resolve `INTERNAL_CALLBACK_SECRET` for `source: 'agent_tool'` callbacks
   3.2 Set `callbackUrl` in `triggerMetadata` from `WorkflowToolExecutor` for async executions (FR-4)
   3.3 Integration test for internal signing key resolution

4. **Push callback — session injection**
   4.1 Implement session message injection via conversation store
   4.2 WebSocket notification for connected clients
   4.3 Redis async-result persistence for disconnected sessions
   4.4 Integration test for push → session injection flow

5. **Telemetry & observability**
   5.1 Add telemetry events for all completion paths (FR-10)
   5.2 Update workflow tool telemetry counters

6. **Tests** (committed separately from feature code per commit discipline)
   6.1 Unit tests: companion tool auto-registration, session-scoped ID tracking, system message formatting
   6.2 Unit tests: HMAC verification, result persistence logic
   6.3 Integration tests: internal signing key resolution, Redis fallback chain, session injection
   6.4 E2E tests: full async → poll/push flows, cross-session isolation, HMAC rejection

---

## 14. Success Metrics

| Metric                              | Baseline | Target                      | How Measured                                               |
| ----------------------------------- | -------- | --------------------------- | ---------------------------------------------------------- |
| Async workflow result delivery rate | 0%       | >95% (via push or poll)     | Ratio of terminal executions with result delivered/polled  |
| Push callback delivery latency      | N/A      | <5s from execution terminal | Time delta between execution completedAt and callback POST |
| Polling tool usage                  | N/A      | <30% of async completions   | Push should handle majority; high polling = push failures  |
| Agent turns saved by push           | N/A      | 1 turn per async completion | Push eliminates need for "is it done yet?" polling turn    |

---

## 15. Open Questions

1. Should the push system message trigger the LLM to generate a new response automatically, or should it wait for the next user message? (Current assumption: inject message, let the agent framework decide based on conversation state.)
2. What is the right Redis TTL for async results — 24h is the initial default, but should it be tenant-configurable?
3. Should the `check_workflow_status` tool description vary based on how many async workflows are active, or remain static?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                | Severity | Status    |
| ------- | ------------------------------------------------------------------------------------------ | -------- | --------- |
| GAP-001 | No cancel companion tool — agent cannot cancel a running async workflow via tool call      | Medium   | Open      |
| GAP-002 | Push injection requires active session lookup — may add latency if session store is slow   | Low      | Mitigated |
| GAP-003 | `INTERNAL_CALLBACK_SECRET` must be coordinated between runtime and workflow-engine deploys | Medium   | Open      |
| GAP-004 | No Studio UI indicator for push-delivered results (conversation just gets a new message)   | Low      | Open      |
| GAP-005 | Callback idempotency dedup via SETNX — duplicate deliveries now return early               | Medium   | Mitigated |
| GAP-006 | broadcastToSession tenant filtering — tenantId param added as defense-in-depth             | Low      | Mitigated |
| GAP-007 | Callback route IP-based rate limiting (120 req/min default)                                | Low      | Mitigated |
| GAP-008 | ~~No full E2E tests~~ — 9 E2E tests with real Runtime harness + mock workflow engine       | Medium   | Mitigated |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                            | Coverage Type | Status  | Test File / Note                                          |
| --- | ------------------------------------------------------------------- | ------------- | ------- | --------------------------------------------------------- |
| 1   | Polling tool returns status for session-owned executionId           | unit          | ✅      | `workflow-status-tool.test.ts` (Redis hit + GET fallback) |
| 2   | Polling tool rejects unknown executionId                            | unit          | ✅      | `workflow-status-tool.test.ts` (empty/missing validation) |
| 3   | Polling tool rejects cross-session executionId                      | unit          | ✅      | `workflow-status-tool.test.ts` (session tracking)         |
| 4   | Push callback delivers result and injects system message            | integration   | ✅      | `workflow-async-callback.integration.test.ts`             |
| 5   | Push callback persists to Redis when session inactive, then polled  | integration   | ✅      | `workflow-async-callback.integration.test.ts`             |
| 6   | Push callback with mismatched tenantId rejected (cross-tenant)      | e2e           | PLANNED | Requires real runtime + engine                            |
| 7   | Push callback HMAC verification rejects invalid signatures          | integration   | ✅      | `workflow-async-callback.integration.test.ts`             |
| 8   | Async tool response includes polling instructions                   | unit          | PLANNED | Tested via WorkflowToolExecutor (in executor tests)       |
| 9   | Companion tool auto-registered only when async workflow tools exist | unit          | PLANNED | Requires buildTools() integration test                    |
| 10  | Workflow-engine uses internal secret for agent-tool callbacks       | unit          | ✅      | `callback-delivery-internal.test.ts`                      |
| 11  | Polling tool falls back to GET endpoint when Redis miss             | unit          | ✅      | `workflow-status-tool.test.ts`                            |

### Testing Notes

E2E tests must start real runtime + workflow-engine servers. The polling tool test seeds an async workflow execution, calls `check_workflow_status`, and verifies the response. The push callback test sends a signed POST to the callback endpoint and verifies session injection. No mocking of platform components.

> Full testing details: `../../testing/sub-features/workflow-async-completion.md`

---

## 18. References

- Parent feature spec: `docs/features/workflow-as-tool.md`
- Workflow engine callback infra: `apps/workflow-engine/src/services/callback-delivery-worker.ts`
- Workflow handler callback enqueue: `apps/workflow-engine/src/handlers/workflow-handler.ts:1358`
- Runtime executor: `apps/runtime/src/services/workflow/workflow-tool-executor.ts`
- System tools pattern: `apps/runtime/src/services/execution/prompt-builder.ts:buildTools()`
- Session factory: `apps/runtime/src/services/session/session-factory.ts`
