# Test Specification: Workflow-as-Tool

**Feature Spec**: `docs/features/workflow-as-tool.md`
**HLD**: `docs/specs/workflow-as-tool.hld.md`
**LLD**: `docs/plans/2026-04-13-workflow-as-tool-impl-plan.md`
**Status**: STABLE
**Last Updated**: 2026-04-15

---

## 1. Coverage Matrix

| FR    | Description                                                                                      | Unit | Integration | E2E | Manual | Status                            |
| ----- | ------------------------------------------------------------------------------------------------ | ---- | ----------- | --- | ------ | --------------------------------- |
| FR-1  | Accept `tool_type: 'workflow'` everywhere existing tool types are accepted                       | ✅   | ✅          | ✅  | ✅     | STABLE                            |
| FR-2  | Validate `workflowId` + `triggerId` non-empty; same tenant + project enforcement                 | ✅   | ✅          | ✅  | ✅     | STABLE                            |
| FR-3  | Reject non-existent triggerId or trigger with `type !== 'webhook'`                               | ✅   | ✅          | ✅  | ✅     | STABLE                            |
| FR-4  | Derive LLM param schema from `start.inputVariables` (type, description, required propagated)     | ✅   | ✅          | ✅  | ❌     | STABLE                            |
| FR-5  | Sync mode: POST → poll exp-backoff → terminal status → `output`; on timeout, POST cancel + throw | ✅   | ✅          | ✅  | ❌     | STABLE                            |
| FR-6  | Async mode: POST → return `{ executionId, status: 'running' }` immediately, no polling           | ✅   | ✅          | ✅  | ❌     | STABLE                            |
| FR-7  | Mint internal service JWT (tenant-scoped, 1-hour) for Runtime → Workflow-Engine calls            | ✅   | ✅          | ✅  | ❌     | STABLE                            |
| FR-8  | Studio: workflow → active-version → webhook-trigger sequential pickers; mode default             | ❌   | ❌          | ✅  | ✅     | BETA — UI-E2E-1 + UI-E2E-3 landed |
| FR-9  | Studio: empty-state when chosen workflow has zero webhook triggers                               | ❌   | ❌          | ✅  | ✅     | BETA — UI-E2E-2 landed            |
| FR-10 | Telemetry counts of `tool_type === 'workflow'` registrations alongside other tool types          | ✅   | ❌          | ❌  | ❌     | STABLE                            |

> **Legend:** ✅ = test file shipped and passing. 🟡 = scenario specified here, test file not yet landed. ❌ = intentionally not covered at that tier.

---

## 2. E2E Test Scenarios (MANDATORY)

> CRITICAL: All E2E scenarios exercise the real system through its HTTP API. Real Express server (random port via `{ port: 0 }`), real auth middleware, real validation, no `vi.mock` of platform code. External boundary fakes (Restate client, Mongoose models) are wired via DI per the `apps/workflow-engine/src/__tests__/workflow-executions-routes.test.ts:39-51` pattern.

### E2E-1: Sync workflow tool — happy path through the agent loop

- **Server setup**: Real `apps/runtime` Express app + real `apps/workflow-engine` Express app, each on its own random port (`{ port: 0 }`), full middleware chain (auth, tenant isolation, rate-limit, validation). Mongo connected to a per-test database. No HTTP transport stubbing.
- **Preconditions** (all seeded via real HTTP API, no direct DB writes):
  - Active workflow `wf_summary` in `tenant_a`/`project_x` with one webhook trigger `trg_sync` (`mode: 'sync'`), `start.inputVariables=[{name:'topic', type:'string', required:true, description:'Topic to summarize'}]`, and `end.outputMapping={summary: '$.context.result'}` — created via `POST /api/projects/project_x/workflows`.
  - Tool `summary_tool` of type `'workflow'` bound to `{workflowId: 'wf_summary', triggerId: 'trg_sync', mode: 'sync', timeoutMs: 30000}` — created via `POST /api/projects/project_x/tools`.
  - Agent `agent_1` configured with `summary_tool` attached — created via `POST /api/projects/project_x/agents`.
- **Steps**:
  1. `POST /api/projects/project_x/agents/agent_1/sessions` → obtain `sessionId`.
  2. `POST /api/projects/project_x/agents/agent_1/sessions/:sessionId/messages` with user message "summarize launch plan". MockLLM emits `tool_call(summary_tool, {topic: 'launch plan'})`.
  3. Agent runtime invokes `WorkflowToolExecutor.execute('summary_tool', {topic:'launch plan'}, 30000)`.
  4. Runtime POSTs to workflow-engine; engine returns `202 { executionId }`. Runtime polls `GET /api/projects/project_x/workflows/wf_summary/executions/:executionId` until `status === 'completed'`.
  5. Runtime returns `{ status: 'completed', output: { summary: 'Launch plan summary…' }, executionId }` to the agent.
  6. MockLLM uses the result, emits a final assistant message.
- **Expected Result**:
  - `GET /api/projects/project_x/agents/agent_1/sessions/:sessionId` shows the assistant message containing the workflow output.
  - `GET /api/projects/project_x/workflows/wf_summary/executions?sessionId=<sessionId>` returns one execution with `triggerType: 'api'`, `triggerMetadata.source: 'agent_tool'`, `triggerMetadata.sessionId: <sessionId>`, `status: 'completed'`.
- **Auth Context**: `tenantId=tenant_a`, `projectId=project_x`, user JWT with `OWNER` role.
- **Isolation Check**: Repeating step 4 with a Token bound to `tenantId=tenant_b` returns `404` (cross-tenant).

### E2E-2: Async workflow tool — immediate return, no polling

- **Server setup**: Same real-Express + random-port setup as E2E-1; full middleware chain.
- **Preconditions** (seeded via real HTTP API):
  - Active workflow `wf_publish` in `tenant_a`/`project_x` with webhook trigger `trg_async` (`mode: 'async'`), `start.inputVariables=[{name:'docId', type:'string', required:true}]`.
  - Tool `publish_tool` of type `'workflow'` bound to `{workflowId: 'wf_publish', triggerId: 'trg_async', mode: 'async'}`.
  - Agent `agent_1` configured with `publish_tool`.
- **Steps**:
  1. Open agent session and send user message that triggers `tool_call(publish_tool, {docId:'doc_42'})`.
  2. Runtime POSTs to engine; engine returns `202 { executionId }`. Runtime returns `{ executionId, status: 'running' }` to the agent immediately (no polling).
  3. MockLLM uses the executionId in its final reply: "Started publishing as run <id>".
  4. Independently, `GET /api/projects/project_x/workflows/wf_publish/executions/:executionId` after the workflow finishes shows `status: 'completed'`.
- **Expected Result**:
  - The tool result observed in the session trace contains `executionId` and `status: 'running'`. Tool latency on the agent side is < 500ms (no polling).
  - The workflow execution proceeds to completion independently of the agent turn.
- **Auth Context**: `tenantId=tenant_a`, `projectId=project_x`, user JWT.
- **Isolation Check**: A second tenant's agent attempting `GET /executions/:executionId` returns `404`.

### E2E-3: Sync timeout cancels the workflow execution

- **Server setup**: Same real-Express + random-port setup as E2E-1.
- **Preconditions** (seeded via real HTTP API):
  - Active workflow `wf_slow` in `tenant_a`/`project_x` with webhook trigger `trg_slow` (`mode: 'sync'`). The workflow's first node intentionally sleeps longer than the configured tool timeout.
  - Tool `slow_tool` bound to `{workflowId: 'wf_slow', triggerId: 'trg_slow', mode: 'sync', timeoutMs: 1000}`.
  - Agent configured with `slow_tool`.
- **Steps**:
  1. Open session, send message triggering `tool_call(slow_tool, {})`.
  2. Runtime POSTs to engine, polls. After ~1000 ms, runtime POSTs `/executions/:executionId/cancel` and throws `ToolExecutionError`.
  3. Agent receives the tool error in the next reasoning turn. MockLLM emits a fallback assistant message.
- **Expected Result**:
  - Session trace contains a tool error `{code: 'TOOL_EXECUTION_ERROR', toolName: 'slow_tool', message: /timeout/i}`.
  - `GET /executions/:executionId` shows `status: 'cancelled'`.
- **Auth Context**: `tenantId=tenant_a`, `projectId=project_x`, user JWT.
- **Isolation Check**: Cancel attempt by another tenant returns `404`.

### E2E-4: Validation rejects a non-webhook trigger at tool creation

- **Server setup**: Real `apps/runtime` Express on a random port, full middleware chain (auth + project-isolation), real Mongo.
- **Preconditions** (seeded via real HTTP API): Active workflow `wf_cron` in `tenant_a`/`project_x` with **only** a cron trigger `trg_cron` (no webhook triggers) — created via `POST /api/projects/project_x/workflows`.
- **Steps**:
  1. `POST /api/projects/project_x/tools` with body `{toolType: 'workflow', dslContent: 'type: workflow\nworkflow_id: wf_cron\ntrigger_id: trg_cron\n', name: 'cron_tool', signature: 'cron_tool() -> object'}`.
- **Expected Result**:
  - Response `400` with structured error `{ success: false, error: { code: 'INVALID_TOOL_BINDING', message: /trigger.*type.*webhook/i } }`.
  - No tool document is persisted (verify via `GET /api/projects/project_x/tools?name=cron_tool` returns empty array).
  - A second attempt with `trigger_id: 'nonexistent'` returns `400` with `code: 'INVALID_TOOL_BINDING'` and message mentioning the missing trigger.
- **Auth Context**: `tenantId=tenant_a`, `projectId=project_x`, user JWT with `OWNER` role.
- **Isolation Check**: N/A (rejection happens before any cross-resource access).

### E2E-5: Cross-project workflowId rejected at tool creation AND at runtime (stale-binding via API)

- **Server setup**: Real Runtime + Workflow-Engine Express apps on random ports, full middleware chain.
- **Preconditions** (seeded via real HTTP API):
  - Workflow `wf_target` first created in `tenant_a`/`project_y` with a webhook trigger `trg_w` (`POST /api/projects/project_y/workflows`). Tool creation attempted in `project_x`.
- **Steps**:
  1. `POST /api/projects/project_x/tools` referencing `workflow_id: wf_target / trigger_id: trg_w` → expect `404`.
  2. **API-only stale-binding flow** (no direct DB writes):
     - Create workflow `wf_movable` and an active webhook trigger inside `project_x` via `POST /api/projects/project_x/workflows`.
     - Create tool `mover_tool` of type `'workflow'` bound to that workflow via `POST /api/projects/project_x/tools` → succeeds.
     - Archive (or delete) the workflow via `PATCH /api/projects/project_x/workflows/wf_movable {status: 'archived'}` (or `DELETE` if exposed) — the binding now points at a workflow that no longer satisfies validation.
     - Open an agent session in `project_x` whose agent uses `mover_tool` and trigger the tool through MockLLM.
- **Expected Result**:
  - Step 1: `404` with `{ success: false, error: { code: 'WORKFLOW_NOT_FOUND' } }` from validation (404, not 403, per CLAUDE.md invariant 1).
  - Step 2: at runtime, the engine call returns `404`; executor surfaces a tool error in the session trace with `code: 'TOOL_EXECUTION_ERROR'`, observable via `GET /api/projects/project_x/agents/.../sessions/:sessionId`. The agent's next assistant turn references the tool failure.
- **Auth Context**: `tenantId=tenant_a`, `projectId=project_x`, user JWT.
- **Isolation Check**: Verifies CLAUDE.md invariant 1 (cross-scope returns 404). All resource access goes through HTTP — no direct Mongoose model writes.

### E2E-6: Multi-turn agent reasoning with two distinct workflow tool invocations

- **Server setup**: Same real-Express + random-port setup as E2E-1.
- **Preconditions** (seeded via real HTTP API):
  - Active workflow `wf_search` (sync, webhook trigger, `inputVariables=[{name:'q', type:'string', required:true}]`).
  - Active workflow `wf_summary` (sync, webhook trigger, `inputVariables=[{name:'docIds', type:'json', required:true}]`).
  - Two tools `search_tool`, `summary_tool` bound to those workflows.
  - Agent `agent_compose` with both tools.
- **Steps**:
  1. User message: "find docs about pricing and summarize them".
  2. MockLLM round 1: `tool_call(search_tool, {q:'pricing'})` → result `{ output: { docIds: ['d1','d2','d3'] } }`.
  3. MockLLM round 2: `tool_call(summary_tool, {docIds:['d1','d2','d3']})` → result `{ output: { summary: 'Pricing covers…' } }`.
  4. MockLLM round 3: emits final assistant reply quoting the summary.
- **Expected Result**:
  - Session trace (via `GET /api/projects/project_x/agents/agent_compose/sessions/:sessionId`) shows both tool calls in order, both with `status: 'completed'`, payloads correctly threaded between turns.
  - `GET /api/projects/project_x/workflows/wf_search/executions?sessionId=<sessionId>` returns one execution and `GET .../wf_summary/executions?sessionId=<sessionId>` returns one execution; both include the matching `sessionId` in `triggerMetadata`.
- **Auth Context**: `tenantId=tenant_a`, `projectId=project_x`, user JWT.
- **Isolation Check**: Repeat the executions list calls with a Token bound to `tenantId=tenant_b` and with `projectId=project_y` — both return `404` (no DB introspection used; assertions are made through HTTP responses only).

### E2E-7: Unauthenticated and forbidden requests are rejected before any workflow side-effects

- **Server setup**: Real Runtime + Workflow-Engine Express apps on random ports, full middleware chain.
- **Preconditions** (seeded via real HTTP API): A valid `summary_tool` bound to `wf_summary / trg_sync` in `tenant_a`/`project_x`, an agent `agent_1` configured with that tool. A second user JWT with `VIEWER` role only.
- **Steps**:
  1. `POST /api/projects/project_x/agents/agent_1/sessions` with **no** `Authorization` header → expect `401`.
  2. Same call with a syntactically valid but expired JWT → expect `401`.
  3. `POST /api/projects/project_x/tools` of type `'workflow'` with the `VIEWER` JWT → expect `403`.
  4. With the OWNER JWT, open a session and trigger `summary_tool`; assert the workflow-engine call is mediated by the runtime's internal service JWT (the engine never sees the original `VIEWER` token).
- **Expected Result**:
  - Steps 1-2: `401` from auth middleware before any handler runs. No `workflow_executions` document is created (verified by querying executions list and asserting empty).
  - Step 3: `403` with `{ success: false, error: { code: 'FORBIDDEN' } }` from `requirePermission('tool:create')`.
  - Step 4: agent run completes; the engine's request log shows an `Authorization` header with `internal: true` JWT claims (asserted via a request-capturing middleware wired during test setup, NOT by mocking auth).
- **Auth Context**: Mixed — explicit anonymous + expired + VIEWER + OWNER cases.
- **Isolation Check**: Confirms the auth middleware is exercised (FR-7 dependency) and that no privileged work occurs without a valid token.

### UI-E2E-1: FR-8 — workflow + webhook-trigger picker, mode default, user override

- **Layer**: Studio browser E2E (Playwright) — real Studio 5173 + real Runtime 3112 + real Workflow-Engine 9081 + real Mongo + real Redis, launched via `pnpm dev` per `apps/studio/e2e/workflows/agents.md` Prerequisites. No MockLLM needed; this test stops at tool creation.
- **Preconditions** (seeded via real HTTP API in test `beforeAll`, using a new `apiCreateWorkflowWithWebhook(page, projectId, token, opts)` helper):
  - `wf_ui_sync` in `project_x`: one webhook trigger `trg_sync` with `mode: 'sync'`, `start.inputVariables=[{name:'topic', type:'string', required:true}]`, `status: 'active'`.
  - `wf_ui_async` in `project_x`: one webhook trigger `trg_async` with `mode: 'async'`, `start.inputVariables=[{name:'docId', type:'string', required:true}]`, `status: 'active'`.
  - `wf_ui_draft` in `project_x`: one webhook trigger, `status: 'draft'` (must NOT appear in the picker).
- **Steps**:
  1. `loginViaDevApi`; navigate to `/projects/:projectId/tools`.
  2. Click `[data-testid="tool-create-button"]` → Create Tool dialog opens.
  3. Select **Workflow** via `[data-testid="tool-type-option-workflow"]`; fill `[data-testid="tool-create-name-input"]` with `ui_sync_tool`; submit.
  4. On the new tool's detail page, open the configuration section. Assert the workflow picker `[data-testid="workflow-picker-select"]` contains `wf_ui_sync` and `wf_ui_async` but NOT `wf_ui_draft`.
  5. Select `wf_ui_sync`. Assert the trigger picker `[data-testid="trigger-picker-select"]` contains exactly `trg_sync` (webhook-only filter). Select it. Assert `[data-testid="mode-selector"]` value === `sync`.
  6. Assert the read-only `[data-testid="input-variables-preview"]` lists `topic` (type `string`, required).
  7. Change mode selector to `async`; assert value updates to `async` (user override). Save.
  8. Refresh the page; assert persisted DSL (visible in `[data-testid="workflow-binding-panel"]`) shows `workflow_id: wf_ui_sync`, `trigger_id: trg_sync`, `mode: async`.
  9. Repeat steps 2–5 for `wf_ui_async`/`trg_async`; assert mode selector pre-fills `async`.
- **Expected Result**: Both mode defaults (sync, async) pre-fill correctly from the trigger node's `mode`; user override persists through save + reload; draft-status workflows are filtered out; non-webhook triggers are not offered.
- **Auth Context**: `tenantId=tenant_a`, `projectId=project_x`, OWNER JWT obtained via `loginViaDevApi`.
- **Isolation Check**: Workflow picker must not show workflows from `project_y` (assert by attempting selection of a same-tenant, other-project workflowId via URL param hack — Studio UI should surface "workflow not found" rather than silently binding).

### UI-E2E-2: FR-9 — empty-state when workflow has zero webhook triggers + submit blocked

- **Layer**: Same Playwright + real-services stack as UI-E2E-1.
- **Preconditions** (seeded via real HTTP API):
  - `wf_cron_only` in `project_x`: one cron trigger (`type: 'cron'`, daily schedule), **no** webhook triggers, `status: 'active'`.
- **Steps**:
  1. Login; navigate to Tools page; open Create Tool dialog; select Workflow; name `cron_only_attempt`; submit.
  2. On the detail page config form, open the workflow picker and select `wf_cron_only`.
  3. Assert the trigger picker area shows `[data-testid="no-webhook-triggers-empty-state"]` with visible text matching the feature spec wording: "This workflow has no webhook triggers. Only webhook-triggered workflows can be exposed as tools."
  4. Assert `[data-testid="save-tool-button"]` is disabled (or that clicking it surfaces an inline validation error visible via `getByRole('alert')`).
  5. Switch the picker selection to a different (webhook-bearing) workflow from UI-E2E-1 preconditions; assert the empty-state disappears and save becomes enabled.
- **Expected Result**: Empty-state renders for cron-only workflow; save blocked; recovery path works by switching workflow.
- **Auth Context**: `tenantId=tenant_a`, `projectId=project_x`, OWNER JWT.
- **Isolation Check**: N/A — purely UI-side rejection; the backend 400 path is covered by E2E-4.

### UI-E2E-3: Workflow tab in Tools list + `?tab=workflow` deep-link

- **Layer**: Same Playwright + real-services stack.
- **Preconditions** (seeded via real HTTP API): Two workflow-type tools (`tool_a`, `tool_b`) in `project_x` already bound to valid webhook workflows; one http tool and one searchai tool also present for disambiguation.
- **Steps**:
  1. Login; navigate to `/projects/:projectId/tools` with no query string.
  2. Assert `[data-testid="tools-tab-workflow"]` is visible, sits between the SearchAI and MCP tabs, and its badge count reads `2`.
  3. Click the workflow tab; assert the list body shows exactly `tool_a` and `tool_b` (assert by rows matching `[data-testid^="tool-row-"]` and counting 2).
  4. Reload with URL `/projects/:projectId/tools?tab=workflow`; assert the workflow tab is active using `expect(page.getByTestId('tools-tab-workflow')).toHaveAttribute('aria-selected', 'true')` (Playwright auto-retries with its default `expect` timeout). Additionally assert that no _other_ tab was ever selected during the navigation by observing `aria-selected="true"` count stays at 1 throughout — use a single `Promise.race` between the correct assertion and a short `waitForEvent('console', { predicate: msg => /tab switched/i.test(msg.text()) })` sentinel.
- **Expected Result**: Tab renders with accurate count, deep-link activates it directly without a transient state.
- **Auth Context**: `tenantId=tenant_a`, `projectId=project_x`, OWNER JWT.
- **Isolation Check**: Switching to `projectId=project_y` (which has no workflow tools) shows count `0` and an empty-state message; no `tool_a`/`tool_b` leakage.

### UI-E2E-4: Workflow tool badge + detail-page binding panel

- **Layer**: Same Playwright + real-services stack.
- **Preconditions** (seeded via real HTTP API): One workflow tool `badge_tool` bound to a valid sync-webhook workflow in `project_x`.
- **Steps**:
  1. Login; open the Tools list; switch to the Workflow tab.
  2. On the `badge_tool` row, assert `[data-testid="tool-type-badge-workflow"]` is present with visible text "Workflow" and that its computed background color matches the design-token accent (assert via `getComputedStyle(...).backgroundColor` against the resolved token value from `@agent-platform/design-tokens`, not a hardcoded hex).
  3. Click the row to open the detail page. Assert `[data-testid="tool-type-badge-workflow"]` is visible in the page header.
  4. Assert `[data-testid="workflow-binding-panel"]` is present and displays the workflow name, trigger id, and DSL content. Assert the panel is read-only — there is no edit button and no inline input is focusable within the panel container.
- **Expected Result**: Badge renders with correct label and design-token accent; detail-page binding panel is present and read-only.
- **Auth Context**: `tenantId=tenant_a`, `projectId=project_x`, OWNER JWT.
- **Isolation Check**: Log in as a user whose active token is scoped to `projectId=project_y` (same tenant, different project) and navigate to `/projects/:project_y/tools?tab=workflow`; assert `badge_tool` is NOT listed (cross-project isolation holds at the list layer, not only at the detail-page 404). This exercises the ToolsListPage's project-scoped fetch path alongside the visual badge assertions.

> **Test file location convention (clarification):** UI-E2E-1..4 specs live at `apps/studio/e2e/workflow-tool-*.spec.ts` (Tools-page tier), NOT under `apps/studio/e2e/workflows/`. Per the tier table in `apps/studio/e2e/workflows/agents.md`, the `workflows/` subfolder is reserved for workflow-canvas and engine-integration tests. FR-8/FR-9 test Tools-page behavior where workflow is the tool type, so the tools-adjacent location is correct.

> **Prerequisite for UI-E2E-1..4:** Add `data-testid` attributes to production components before the tests can run. Required testids:
>
> - `ToolsListPage.tsx` — `tools-tab-workflow`, `tool-row-<id>`, `tool-create-button`
> - `ToolCreateDialog.tsx` — `tool-type-option-workflow`, `tool-create-name-input`
> - `WorkflowConfigForm.tsx` — `workflow-picker-select`, `trigger-picker-select`, `mode-selector`, `input-variables-preview`, `no-webhook-triggers-empty-state`
> - `ToolDetailPage.tsx` — `workflow-binding-panel`, `save-tool-button`
> - `ToolTypeBadge.tsx` — `tool-type-badge-workflow`
>
> These testid additions are purely additive (no behavior change) and should ship in a `test(studio): add workflow-tool testids for UI E2E` commit BEFORE the spec file lands, per the commit-scope-guard discipline.

---

## 3. Integration Test Scenarios (MANDATORY)

> All integration scenarios use real components on both sides of the boundary. Mongoose models are wired via DI fakes (in-process implementations of the model interfaces), Restate client is a DI fake. No `vi.mock` of platform code. Pattern reference: `apps/workflow-engine/src/__tests__/workflow-executions-routes.test.ts:39-51`.

### INT-1: WorkflowToolExecutor → Workflow-Engine HTTP (sync round-trip)

- **Boundary**: `apps/runtime` `WorkflowToolExecutor` → real `apps/workflow-engine` Express router on a random port.
- **Setup**:
  - Spin up the workflow-engine executions router via `createWorkflowExecutionRouter(deps)` on `{ port: 0 }`, mirroring `apps/runtime/src/__tests__/helpers/search-server.ts`.
  - DI fake `WorkflowExecutionModel` returns documents with status transitioning `running → completed` on the third `findOne` call, with `output: { summary: 'ok' }`.
  - DI fake `RestateClient.startWorkflow` resolves with `{ executionId: 'exec_1' }`.
  - Instantiate `WorkflowToolExecutor({ workflowEngineUrl: <random-port-url>, authToken: <minted JWT>, projectId: 'project_x', tenantId: 'tenant_a', defaultTimeoutMs: 5000 })`.
  - `executor.registerBinding('summary_tool', { workflowId: 'wf_summary', triggerId: 'trg_sync', mode: 'sync', paramMapping: {} }, { name, description, inputVariables, triggerMode: 'sync' })`.
- **Steps**:
  1. `await executor.execute('summary_tool', { topic: 'X' }, 5000)`.
  2. Assert the engine received `POST /api/projects/project_x/workflows/wf_summary/executions/execute` with body `{ payload: {topic:'X'}, triggerType: 'api', triggerMetadata: { source: 'agent_tool', sessionId, agentName, triggerId: 'trg_sync' } }` (triggerId carried in metadata only; engine does not route by it).
  3. Assert the engine received at least 2 `GET .../executions/exec_1` polls with exp-backoff intervals (≥ 250 ms first delay).
- **Expected Result**: Returns `{ status: 'completed', output: { summary: 'ok' }, executionId: 'exec_1' }`.
- **Failure Mode**: If the engine route fake returns `502`, the executor throws `ToolExecutionError { code: 'TOOL_EXECUTION_ERROR' }` containing the engine's error body.

### INT-2: WorkflowToolExecutor → Workflow-Engine HTTP (async returns immediately)

- **Boundary**: Same as INT-1.
- **Setup**: Binding `mode: 'async'`. DI fake `RestateClient.startWorkflow` resolves with `{ executionId: 'exec_2' }`.
- **Steps**:
  1. `await executor.execute('publish_tool', { docId: 'd1' }, 5000)`.
  2. Track `GET /executions/...` requests on the engine fake.
- **Expected Result**: Returns `{ executionId: 'exec_2', status: 'running' }` in < 200 ms. **Zero** GET poll requests issued.
- **Failure Mode**: If the engine returns `400` to the POST, executor throws synchronously; no executionId returned.

### INT-3: WorkflowToolExecutor — sync timeout triggers cancel

- **Boundary**: Same as INT-1.
- **Setup**: DI fake model keeps returning `status: 'running'` indefinitely. Bind `mode: 'sync', timeoutMs: 1000`.
- **Steps**:
  1. Start `executor.execute('slow_tool', {}, 1000)`.
  2. Wait for the promise to reject.
- **Expected Result**:
  - Promise rejects with `ToolExecutionError { code: 'TOOL_EXECUTION_ERROR' }` whose message matches `/timeout/i`.
  - The engine fake recorded a `POST /executions/exec_3/cancel` call before the rejection.
  - Total elapsed time is ≥ 1000 ms and ≤ 1500 ms (cancel + small grace).
- **Failure Mode**: If the cancel endpoint returns 404 (already terminal), executor still rejects with timeout error and logs a debug warning.

### INT-4: project-tool-validator — webhook-only enforcement against real workflow documents

- **Boundary**: `packages/shared/src/tools/project-tool-validator.ts` → DI-injected `WorkflowModel.findOne`.
- **Setup**: Inject a model fake whose store contains:
  - `wf_with_webhook` (triggers: `[{id:'tw', type:'webhook', config:{mode:'sync'}, status:'active'}]`)
  - `wf_cron_only` (triggers: `[{id:'tc', type:'cron', config:{...}, status:'active'}]`)
  - `wf_with_event` (triggers: `[{id:'te', type:'appevent', config:{...}, status:'active'}]`)
  - `wf_in_other_project` (same workflowId in `project_y`).
- **Steps**: Call `validateProjectTool({toolType:'workflow', dslContent, projectId:'project_x', tenantId:'tenant_a'})` for each of:
  1. `wf_with_webhook / tw` — valid.
  2. `wf_cron_only / tc` — invalid (cron trigger).
  3. `wf_with_event / te` — invalid (event trigger).
  4. `wf_with_webhook / nonexistent` — invalid (missing trigger).
  5. `wf_in_other_project / tw` — invalid (cross-project, returns 404 semantics).
- **Expected Result**: Case 1 returns `{ valid: true, binding: {workflowId, triggerId, mode:'sync', ...} }`. Cases 2-5 return `{ valid: false, error: { code: 'INVALID_TOOL_BINDING', message } }` with messages distinguishing each cause.
- **Failure Mode**: If the model fake throws DB error, validator surfaces `{ valid: false, error: { code: 'VALIDATION_ERROR' } }` — not silently true.

### INT-5: load-project-tools-as-ir — derives JSON Schema from `start.inputVariables`

- **Boundary**: `apps/runtime/src/tools/load-project-tools-as-ir.ts` → DI-injected `WorkflowModel.findOne`.
- **Setup**: Workflow document has nodes including a `start` node with `config.inputVariables = [{name:'topic', type:'string', required:true, description:'Topic'}, {name:'limit', type:'number', required:false, defaultValue:'10'}]`. A `project_tool` row of type `'workflow'` references this workflow.
- **Steps**: Call `loadProjectToolsAsIR({projectId, tenantId})` and inspect the returned `ToolDefinition`.
- **Expected Result**:
  - `tool.tool_type === 'workflow'`.
  - `tool.workflow_binding.workflowId/triggerId/mode` populated.
  - `tool.parameters` includes `topic` (type `string`, `required: true`, description carried) and `limit` (type `number`, `required: false`, `default: 10`).
  - The `json` input variable type maps to JSON Schema `type: 'object'` (or `oneOf` permissive).
- **Failure Mode**: If the workflow has been deleted between binding and load, the loader emits a structured warning and skips the tool (does not throw).

### INT-6: Engine isolation — execution endpoint enforces `{tenantId, projectId}`

- **Boundary**: `apps/workflow-engine` executions router → DI-injected `WorkflowModel`/`WorkflowExecutionModel`.
- **Setup**: Workflow `wf_x` in `tenant_a/project_x`. Token A is for `tenant_a/project_x`. Token B is for `tenant_b/project_x`. Token C is for `tenant_a/project_y`.
- **Steps**:
  1. `POST .../executions/execute` with Token A → 202 + executionId.
  2. Same POST with Token B → expect 404.
  3. Same POST with Token C → expect 404.
  4. `GET .../executions/:id` with Token B / Token C → expect 404.
- **Expected Result**: All cross-tenant and cross-project responses are `404` (per CLAUDE.md invariant 1) with `{ success: false, error: { code: 'NOT_FOUND' } }`. The successful Token A path returns `executionId` and the GET shows full document.
- **Failure Mode**: If isolation regresses (e.g., a 200 leaks across tenants), the test fails immediately on assert.

### INT-7: WorkflowToolExecutor.executeParallel — independent concurrent executions

- **FR Coverage**: FR-1 (the `'workflow'` tool type must satisfy the full `ToolExecutor` interface, including `executeParallel`, on parity with the SearchAI executor — see `apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts:153-169`). Without this test, parallel calls regress silently when the LLM emits multi-tool turns.
- **Boundary**: `WorkflowToolExecutor` → engine.
- **Setup**: Bind three tools `t1`, `t2`, `t3` to three different workflows. DI fake engine returns distinct executionIds and `output` per call. Inject deterministic delays (50/100/150 ms) before status flips to `completed`.
- **Steps**: `await executor.executeParallel([{name:'t1', params:{...}}, {name:'t2', params:{...}}, {name:'t3', params:{...}}], 5000)`.
- **Expected Result**: Returns 3 settled results in the same order as the input array, each with the correct `output`. No binding-map mutation observed (re-running the same call yields the same result). One of the three failing (engine 500) results in `{ name: 'tN', error: <message> }` while the others succeed.
- **Failure Mode**: If two concurrent calls share state (e.g., same in-flight executionId), the test fails on output mismatch.

---

## 4. Unit Test Scenarios

### UT-1: `buildWorkflowBindingFromProps` parses DSL props

- **Module**: `packages/shared/src/tools/dsl-property-parser.ts`
- **Input**: `{ workflow_id: 'wf_x', trigger_id: 'tw', mode: 'sync', timeout_ms: '15000', param_mapping: '{"q":"$.query"}' }`
- **Expected Output**: `{ workflowId: 'wf_x', triggerId: 'tw', mode: 'sync', timeoutMs: 15000, paramMapping: { q: '$.query' } }`. Missing `mode` defaults to `'sync'`. Missing `param_mapping` defaults to `{}`. Invalid JSON in `param_mapping` throws a structured parse error.

### UT-2: IR validator accepts/rejects `tool_type: 'workflow'`

- **Module**: `packages/compiler/src/platform/ir/tool-schema-validator.ts`
- **Input**: ToolDefinition with `tool_type: 'workflow'` and (a) full binding, (b) missing `workflowId`, (c) missing `triggerId`.
- **Expected Output**: (a) valid; (b)/(c) validation error mentioning the missing field.

### UT-3: ToolBindingExecutor dispatches `case 'workflow':`

- **Module**: `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts`
- **Input**: ToolDefinition with `tool_type: 'workflow'`, a stub `workflowToolExecutor` whose `execute` is a spy.
- **Expected Output**: Spy is invoked once with `(toolName, params, effectiveTimeout)`. If `workflowToolExecutor` is undefined, throws `ToolExecutionError { code: 'TOOL_EXECUTION_ERROR' }`. Extends the existing test at `packages/compiler/src/__tests__/tool-binding-executor-connector.test.ts:71`.

### UT-4: `normalizeFilter`-style normalization for `paramMapping` aliases

- **Module**: `apps/runtime/src/services/workflow/workflow-tool-executor.ts`
- **Input**: `params = { topic: 'X' }`, `paramMapping = {}` (pass-through) and `paramMapping = { q: '$.topic' }` (rewrite).
- **Expected Output**: First case sends `payload: { topic: 'X' }`. Second case sends `payload: { q: 'X' }`.

### UT-5: Telemetry counts include workflow tools

- **Module**: `apps/runtime/src/services/execution/llm-wiring.ts` (telemetry block ~line 1301).
- **Input**: A tool list with 2 http, 1 searchai, 3 workflow tools.
- **Expected Output**: Emitted telemetry payload includes `tool_type_counts.workflow === 3`.

### UT-6: Sync poll exp-backoff schedule

- **Module**: `apps/runtime/src/services/workflow/workflow-tool-executor.ts` (poll loop helper).
- **Input**: A fake clock + a fake fetch that records call timestamps; status returns `running` 4 times then `completed`.
- **Expected Output**: Poll intervals approximate `[250, 500, 1000, 2000]` ms (cap at 2000 ms). Exact equality not required — assert monotonic increase up to cap.

---

## 5. Security & Isolation Tests

- [ ] **Cross-tenant access returns 404** — INT-6 covers; an agent in `tenant_b` cannot read or trigger an execution belonging to `tenant_a`.
- [ ] **Cross-project access returns 404** — INT-6 + E2E-5 cover; tool referencing a workflow in another project is rejected at validation AND at runtime.
- [ ] **Cross-user access returns 404** — N/A: workflow tools are project-scoped resources, not user-owned.
- [ ] **Missing auth returns 401** — Add an explicit assertion in INT-1: a request with no `Authorization` header to the engine returns 401 (executor surfaces an error).
- [ ] **Insufficient permissions returns 403** — A user JWT with `VIEWER` role attempting `POST /tools` of type workflow returns 403 (handled by `requirePermission('tool:create')`).
- [ ] **Input validation rejects malformed data** — UT-1, INT-4 cover. Additionally: tool DSL with non-string `workflow_id` or `trigger_id` is rejected.
- [ ] **Internal JWT cannot escalate scope** — Mint a JWT for `tenant_a` and use it to query `tenant_b` execution: returns 404. Confirms FR-7 + invariant 1.
- [ ] **Webhook-trigger-only invariant** — INT-4 cases 2 & 3 confirm cron and appevent triggers are rejected.
- [ ] **No PII leak in tool result payloads** — Add an assertion in INT-1 that the returned `output` has no `vector`/`embedding` field accidentally surfaced (mirrors `stripHeavyFields` in the SearchAI executor).

---

## 6. Performance & Load Tests

- **Not in scope for v1.** Workflow tool latency is dominated by the underlying workflow's runtime, which has its own perf scenarios in `docs/testing/workflows.md`. The integration tests exercise parallel execution (INT-7) up to 3 concurrent calls, which is the realistic agent-side concurrency bound. A future load scenario should measure: 10 concurrent agent sessions × 3 sync workflow tools × p95 poll latency.

---

## 7. Test Infrastructure

- **Required services**:
  - **Real, in-process**: workflow-engine Express router (random port via `{ port: 0 }`); MongoDB-backed Mongoose models; runtime Express stack.
  - **DI fakes (NOT mocks)**: `RestateClient` (start/cancel/get), `WorkflowExecutionModel`, `WorkflowModel`, `StatusPublisher`. Pattern: `apps/workflow-engine/src/__tests__/workflow-executions-routes.test.ts:39-51`.
  - **Real MockLLM**: emits scripted `tool_call`s for E2E-1/2/3/5/6.
- **Data seeding**:
  - Helper `seedWorkflowFixture(model, { id, projectId, tenantId, triggers, startInputVariables, status })` for both unit and integration setups.
  - Helper `seedAgentWithWorkflowTool(deps, { agentName, toolName, workflowId, triggerId, mode, timeoutMs })` for E2E setups.
- **Environment variables**:
  - `WORKFLOW_ENGINE_URL` — set per-test to the random-port URL.
  - `JWT_SECRET` — fixed test secret; both runtime and engine consume it.
  - `MONGO_URI` — `mongodb://localhost:27017/abl-test-<random>` (existing convention in the repo's E2E tests).
- **CI configuration**: Tests run under the existing `pnpm test` and `pnpm test:report` paths. No new docker services required.

---

## 8. Test File Mapping

| Test File                                                                                          | Type        | Covers                     |
| -------------------------------------------------------------------------------------------------- | ----------- | -------------------------- |
| `packages/shared/src/__tests__/dsl-property-parser.test.ts` (extended)                             | unit        | UT-1                       |
| `packages/compiler/src/__tests__/tool-schema-validator.test.ts` (extended)                         | unit        | UT-2                       |
| `packages/compiler/src/__tests__/tool-binding-executor-connector.test.ts` (extended)               | unit        | UT-3                       |
| `apps/runtime/src/services/workflow/__tests__/workflow-tool-executor.unit.test.ts` (new)           | unit        | UT-4, UT-6                 |
| `apps/runtime/src/services/execution/__tests__/llm-wiring-telemetry.test.ts` (extended or new)     | unit        | UT-5                       |
| `apps/runtime/src/__tests__/integration/workflow/workflow-tool-executor.integration.test.ts` (new) | integration | INT-1, INT-2, INT-3, INT-7 |
| `packages/shared/src/__tests__/project-tool-validator.workflow.test.ts` (new)                      | integration | INT-4                      |
| `apps/runtime/src/tools/__tests__/load-project-tools-as-ir.workflow.test.ts` (new)                 | integration | INT-5                      |
| `apps/workflow-engine/src/__tests__/executions-isolation.integration.test.ts` (new)                | integration | INT-6                      |
| `apps/runtime/src/__tests__/workflow-tool-agent.e2e.test.ts` (new)                                 | e2e         | E2E-1, E2E-2, E2E-3, E2E-6 |
| `apps/runtime/src/__tests__/workflow-tool-validation.e2e.test.ts` (new)                            | e2e         | E2E-4, E2E-5               |
| `apps/runtime/src/__tests__/workflow-tool-auth.e2e.test.ts` (new)                                  | e2e         | E2E-7                      |
| `apps/studio/e2e/workflow-tool-config.spec.ts` (new — Playwright)                                  | ui-e2e      | UI-E2E-1, UI-E2E-2         |
| `apps/studio/e2e/workflow-tool-list.spec.ts` (new — Playwright)                                    | ui-e2e      | UI-E2E-3, UI-E2E-4         |

---

## 9. Open Testing Questions

1. Should we add a sustained load scenario (e.g., 50 concurrent sync workflow tool calls under k6) before promoting the feature past ALPHA? Currently deferred (see §6).
2. For workflows whose webhook trigger has `auth.type === 'user_level'`, the feature spec defers a decision (open question 3 in feature spec) — until that's resolved, do we add a placeholder integration test that asserts the validator rejects such bindings, or skip until the decision lands?
3. Should the agent-level E2E tests include a parallel-tool-call scenario (`tool_calls: [t1, t2]` in one LLM turn) to cover INT-7's concurrency at the agent boundary, or is INT-7 sufficient?
4. The manual smoke test doc `docs/testing/manual-smoke-tests/workflow-as-tool-studio.md` overlaps UI-E2E-1..4 once those land. Confirmed decision (product-oracle, 2026-04-14): keep the manual doc as a visual/UX regression checklist (badge colors, panel layout) and annotate each checklist item with "[automated by UI-E2E-N]" once the Playwright specs ship. No action needed in this spec revision.
5. UI-E2E-3's deep-link assertion now uses Playwright's auto-retrying `expect` rather than a hard 500ms window (revised during test-spec audit round 1). If the sentinel console-log approach proves flaky against the actual implementation, fall back to a DOM MutationObserver recorded via `page.addInitScript` that captures every `aria-selected` flip during navigation and asserts the list contains only `['tools-tab-workflow']`.
