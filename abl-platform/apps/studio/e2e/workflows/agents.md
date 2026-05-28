# Workflow E2E Test Suite — Agent Instructions

This file is the **source of truth** for workflow E2E tests in `apps/studio/e2e/workflows/`.

Read this file BEFORE writing or modifying any workflow test.

**Hub:** `docs/workflows/agents.md` — cross-cutting architecture, all agents.md links, doc index.

**Related agents.md files:**

- `docs/workflows/agents.md` — hub (start here for cross-cutting context)
- `apps/workflow-engine/agents.md` — engine internals, Docker rebuild, executors
- `apps/studio/src/components/workflows/agents.md` — UI canvas, config panels, stores
- `apps/runtime/src/routes/agents.md` — CRUD routes, proxy mapping
- `packages/shared/src/types/agents.md` — shared types and Zod schemas

## Keeping This File Updated — MANDATORY

Every time you finish work in this folder, update this file:

| What changed                                  | What to update in this file                           |
| --------------------------------------------- | ----------------------------------------------------- |
| Created/renamed/deleted a spec or helper file | **Folder Layout** — update the tree                   |
| Added a test for a node type                  | **Node Types** tracker — mark Done, add spec file     |
| Added a test for a trigger type               | **Triggers** tracker — mark Done, add spec file       |
| Added a test for monitor/debug feature        | **Monitor & Debug** tracker — mark Done               |
| Added `data-testid` to a component            | **Testid registry** table — add the new testid        |
| Discovered or resolved an engine gap          | **Known Engine Gaps** table — update status           |
| Hit a non-obvious bug or learned a pattern    | **Learnings** section — append it                     |
| Added a new test to an existing spec          | **Test Tiers** table — verify it still maps correctly |

If you skip this, the next agent will put tests in the wrong file, duplicate coverage, or repeat known mistakes.

---

## Folder Layout

```
apps/studio/e2e/
  helpers/                             # General E2E helpers (auth, api, ui, env)
    auth.ts                            # loginViaDevApi, getDevAccessToken, etc.
    index.ts                           # Barrel export for general helpers
    ...
  workflows/                           # ALL workflow tests live here
    agents.md                          # THIS FILE — read first
    helpers.ts                         # Workflow-specific helpers (login, nav, node ops, run, cleanup)
    workflow-comprehensive.spec.ts     # T2: Multi-node flows, typed inputs, debug panel
    workflow-monitor-triggers.spec.ts  # Monitor tab + trigger configuration
    workflow-trigger-api-key.spec.ts   # API key lifecycle for webhooks
    workflow-lifecycle.spec.ts         # Full lifecycle: create->add->connect->save->run->delete
    workflow-create-execute.spec.ts    # Create via UI + add steps via API
    workflow-canvas-uat.spec.ts        # Canvas UAT (drag, zoom, config panels)
    workflow-apple-care-e2e.spec.ts    # Domain-specific: Apple Care escalation flow
    workflow-triggers-showcase.spec.ts # Screenshot showcase of trigger UI
    workflow-tool-node.spec.ts        # Tool node: create HTTP tool, use in workflow, run, verify output
    workflow-agent-node.spec.ts      # Agent node: create agent, use in workflow, run, verify output. Empty-state test.
    workflow-function-node.spec.ts   # Function node: V8 sandbox, inputVars, timeout, syntax error, loop body, coming-soon
    workflow-integration-node.spec.ts # Integration node: Gmail connector catalog, action schemas, connection picker, config UI, picker modal nav
    workflow-webhook-versioning.spec.ts # Webhook versioning: two-badge header, short URL, ?version= param, served-via caption
    workflow-inbox.spec.ts              # Unified Inbox UI shell: empty state, filter bar, mailbox toggle, type-pill switching (no live task lifecycle — documented gap)
    workflow-first-class-memory.spec.ts # First-class memory + agent context: E2E-3 full (memory.user UNAVAILABLE_SCOPE, agentSession=undefined under non-agent trigger) + E2E-6 full (cross-run workflow-scope memory continuity, Studio direct-run × 2). E2E-1 / E2E-2 are skipped scaffolds — see GAP-018 / GAP-019.
    workflow-memory-erasure.spec.ts     # GDPR cascade purges memory.user.* for the deleted contact via DELETE /api/contacts/manage/:id/gdpr; sibling memory.project.* fact survives. Mints service-token for /api/internal/memory/* — same secret as runtime-memory-client.
    workflow-as-tool-nesting-memory.spec.ts # E2E-5 (workflow-as-tool nesting agent context propagation) — scaffold only, GAP-018.
```

**Helpers live inside the folder.** Import as `from './helpers'`. Only `workflow-apple-care-e2e.spec.ts` imports from `'../helpers'` (general auth barrel) because it uses a different login flow.

---

## Test Tiers — Where Does My Test Go?

| What you're testing                                                                 | Spec file                                                                                                 | Tier     |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------- |
| Create, save, delete, basic Start->End                                              | `workflow-lifecycle.spec.ts`                                                                              | T1       |
| Multi-node flows, typed inputs, config panels, debug panel                          | `workflow-comprehensive.spec.ts`                                                                          | T2       |
| Multi-branch conditional (IF/ELSE), failure routing                                 | `workflow-comprehensive.spec.ts` (legacy reference test)                                                  | T2       |
| Loops, parallel branches, error flows, human-in-loop                                | `workflow-comprehensive.spec.ts` (new test) or new `workflow-advanced.spec.ts` when 3+ tests exist        | T3       |
| A specific node type's config + execution                                           | `workflow-comprehensive.spec.ts` (new test per node)                                                      | Nodes    |
| Monitor tab (KPI, executions, detail view)                                          | `workflow-monitor-triggers.spec.ts`                                                                       | Monitor  |
| Trigger creation, code snippets, pause/resume                                       | `workflow-monitor-triggers.spec.ts`                                                                       | Triggers |
| SDK/API key lifecycle for webhooks                                                  | `workflow-trigger-api-key.spec.ts`                                                                        | Triggers |
| Canvas interactions (drag, zoom, pan, select)                                       | `workflow-canvas-uat.spec.ts`                                                                             | Canvas   |
| Tool node (create tool, select, execute, debug)                                     | `workflow-tool-node.spec.ts`                                                                              | Nodes    |
| Agent node (create agent, select, execute, debug)                                   | `workflow-agent-node.spec.ts`                                                                             | Nodes    |
| Integration node (connector picker, connection, form)                               | `workflow-integration-node.spec.ts`                                                                       | Nodes    |
| Webhook versioning badges, short URL, ?version=                                     | `workflow-webhook-versioning.spec.ts`                                                                     | Version  |
| Inbox UI (empty state, filter pills, mailbox toggle)                                | `workflow-inbox.spec.ts`                                                                                  | Inbox    |
| Domain-specific workflow scenarios                                                  | Own file: `workflow-{domain}.spec.ts`                                                                     | Domain   |
| First-class memory globals (`memory.workflow/project/user`) under non-agent trigger | `workflow-first-class-memory.spec.ts`                                                                     | Memory   |
| GDPR right-to-erasure cascade for `memory.user.*`                                   | `workflow-memory-erasure.spec.ts`                                                                         | Memory   |
| Agent-bound workflow + workflow-as-tool nesting agent context                       | `workflow-first-class-memory.spec.ts` / `workflow-as-tool-nesting-memory.spec.ts` (`test.skip` — GAP-018) | Memory   |

**Rule: Do NOT create new spec files unless adding an entirely new test category.** Add tests to the existing file for that tier. One spec file per concern keeps the suite navigable. Only create a new file when it would hold 3+ related tests that don't fit any existing file.

---

## Coverage Trackers

Update these tables when adding or completing test coverage.

### Node Types

| Node Type      | Config Test | Execution Test | Covered In       | Notes                                                                                                                                                                   |
| -------------- | ----------- | -------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`        | Done        | Done           | comprehensive    | Input variables (string/number/boolean/json)                                                                                                                            |
| `end`          | Done        | Done           | comprehensive    | Auto-added from handle menu                                                                                                                                             |
| `api`          | Done        | Done           | comprehensive    | URL config, real fetch execution                                                                                                                                        |
| `condition`    | Done        | Done           | comprehensive    | Operator default='equals', else-if, else path, multi-branch IF/ELSE routing                                                                                             |
| `text_to_text` | Done        | —              | comprehensive    | Model dropdown, prompts, temperature. Config in legacy ref test. No exec (needs LLM creds)                                                                              |
| `function`     | Done        | Done           | function-node    | V8 sandbox via isolated-vm. 7 tests: data transform, inputVars, timeout, syntax err, condition chain, loop body, coming-soon badge                                      |
| `delay`        | —           | —              | —                | Planned                                                                                                                                                                 |
| `loop`         | —           | —              | —                | Planned                                                                                                                                                                 |
| `human`        | —           | —              | inbox (UI shell) | UI shell only (empty state, filter pills, mailbox toggle) in `workflow-inbox.spec.ts`. Live approval/human-task lifecycle (suspend + resume via Restate) still Planned. |
| `tool`         | Done        | Done           | tool-node        | HTTP tool via API, select in config, run workflow, verify debug output. Empty-state test.                                                                               |
| `agent`        | Done        | Done           | agent-node       | Agent via API, select in config, run workflow, verify debug output. Empty-state test.                                                                                   |
| `integration`  | Done        | —              | integration-node | Connector catalog, action schema, connection picker, dynamic form, picker modal nav. Requires Gmail connection on TestProjectOne.                                       |
| Stub nodes     | Done        | N/A            | comprehensive    | Coming-soon badge opacity check (7 stub types)                                                                                                                          |

### Triggers

| Trigger Type           | Creation | Card UI             | Code Snippets               | Pause/Resume | Covered In                      |
| ---------------------- | -------- | ------------------- | --------------------------- | ------------ | ------------------------------- |
| `webhook`              | Done     | Done                | Done (sync/async/poll/push) | Done         | monitor-triggers                |
| `webhook` + async push | Done     | Done (callback URL) | Done                        | —            | monitor-triggers                |
| `cron`                 | —        | —                   | N/A                         | —            | Planned                         |
| `polling`              | —        | —                   | N/A                         | —            | Planned                         |
| `event`                | —        | —                   | N/A                         | —            | Planned                         |
| `connector`            | —        | —                   | N/A                         | —            | Planned (needs connector infra) |

### Monitor & Debug

| Feature                                                                     | Status  | Covered In       |
| --------------------------------------------------------------------------- | ------- | ---------------- |
| KPI bar (Total Runs, In Progress, Response Time, Failure Rate)              | Done    | monitor-triggers |
| Execution row (truncated ID, status badge, timestamp, duration, step count) | Done    | monitor-triggers |
| Status filter dropdown (all/running/completed/failed/waiting/cancelled)     | Done    | monitor-triggers |
| Detail slide panel: Input section                                           | Done    | monitor-triggers |
| Detail slide panel: Flow Log (per-step entries)                             | Done    | monitor-triggers |
| Detail slide panel: Output section                                          | Done    | monitor-triggers |
| Raw JSON toggle                                                             | Done    | monitor-triggers |
| Canvas debug panel (Input/FlowLog/Output accordions)                        | Done    | comprehensive    |
| Config panel opens after debug panel close (bug fix)                        | Done    | comprehensive    |
| Execution state transitions (running -> completed)                          | Partial | comprehensive    |
| Live polling indicator                                                      | —       | Planned          |

### Inbox (Human-in-the-loop)

| Feature                                                             | Status | Covered In                        |
| ------------------------------------------------------------------- | ------ | --------------------------------- |
| Page loads and renders empty state for zero tasks                   | Done   | inbox (workflow-inbox.spec.ts)    |
| Filter bar: Workflow/Agent mailbox toggle                           | Done   | inbox                             |
| Filter bar: type pills (All / Approvals / Data Entry) for workflow  | Done   | inbox                             |
| Type pill click toggles `data-active` on the clicked pill           | Done   | inbox                             |
| Mailbox switch resets active type filter to `all`                   | Done   | inbox                             |
| Agent mailbox shows the Escalation pill (not Approvals/Data Entry)  | Done   | inbox                             |
| Approval task card — approve/reject via UI triggers workflow resume | —      | Planned — needs Restate + suspend |
| Data-entry task card — dynamic form submission                      | —      | Planned — needs Restate + suspend |
| Decision task card — radio + notes submission                       | —      | Planned — needs Restate + suspend |
| Load more pagination                                                | —      | Planned                           |

---

## Writing Rules

### 1. Import helpers from `./helpers` — never duplicate login/nav/node logic

```typescript
import {
  loginAndSetup,
  navigateToWorkflows,
  createWorkflowViaUI,
  waitForCanvasReady,
  addNodeViaHandleMenu,
  selectNodeByName,
  saveWorkflow,
  runWorkflow,
  waitForDebugPanel,
  deleteWorkflowFromList,
} from './helpers';
```

If a helper pattern repeats across 2+ tests, extract it into `./helpers.ts`.

For general auth helpers (e.g., `loginViaDevApi`, `getDevAccessToken`) used by domain-specific tests with custom login flows, import from `'../helpers'` (the general barrel).

### 2. Use Zustand store for reliable node/edge operations

Canvas interactions (clicking nodes, adding edges) are fragile in E2E due to viewport positioning. Use the Zustand store for setup steps:

```typescript
// Add node via store (reliable)
await page.evaluate(() => {
  const store = (window as any).__zustandStores?.workflowCanvas;
  const state = store.getState();
  const startNode = state.nodes.find((n: any) => n.data.nodeType === 'start');
  state.addNode('api', { x: 400, y: 200 }, { nodeId: startNode.id, handleId: 'on_success' });
});

// Select node via store (viewport-safe)
await selectNodeByName(page, 'API0001');
```

Use `addNodeViaHandleMenu()` only when testing the handle-plus-menu UI itself.

### 3. Use `data-testid` selectors — add them when missing

Prefer `[data-testid="..."]` over text selectors. If a component lacks a testid:

1. Add `data-testid` to the component source file
2. Naming convention: `{component}-{element}` (e.g., `monitor-kpi-bar`, `trigger-card-webhook`)
3. Use the testid in the E2E test

**Existing testids** (update this list when adding new ones):

| Area                | Testids                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Canvas              | `workflow-canvas-page`, `workflow-canvas`, `workflow-node-start`, `config-panel`, `config-panel-close`, `assets-sidebar`                                                                                                                                                                                                                                                 |
| Node config         | `config-url`, `condition-config`, `add-condition-btn`, `text-to-text-config`, `config-system-prompt`, `config-human-prompt`, `config-temperature`, `config-settings-link`                                                                                                                                                                                                |
| Tool config         | `tool-node-config`, `tool-empty-state`, `tool-create-link`, `tool-add-param`, `tool-param-row-{i}`, `tool-param-remove-{i}` (Select id: `#tool-select`)                                                                                                                                                                                                                  |
| Agent config        | `agent-node-config`, `agent-empty-state`, `agent-create-link` (Select id: `#agent-select`)                                                                                                                                                                                                                                                                               |
| Integration         | `integration-node-config`, `integration-select-button`, `integration-selection-button`, `create-connection-link`, `manage-connections-link`                                                                                                                                                                                                                              |
| Run                 | `toolbar-run-btn`, `run-dialog`, `run-input-{name}`, `run-execute-btn`                                                                                                                                                                                                                                                                                                   |
| Debug               | `execution-debug-panel`, `debug-code-toggle`                                                                                                                                                                                                                                                                                                                             |
| Monitor             | `monitor-kpi-bar`, `monitor-status-filter`, `monitor-execution-row-{id8}`                                                                                                                                                                                                                                                                                                |
| Triggers            | `trigger-creation-form`, `trigger-type-{type}`, `trigger-async-push-toggle`, `trigger-create-btn`, `trigger-card-{type}`, `add-trigger-btn`                                                                                                                                                                                                                              |
| Snippets            | `snippet-tab-{mode}` (sync, async, async_poll, async_push)                                                                                                                                                                                                                                                                                                               |
| Versioning          | `workflow-version-badge`, `workflow-state-badge`, `served-via-caption`                                                                                                                                                                                                                                                                                                   |
| Toolbar             | `canvas-toolbar`                                                                                                                                                                                                                                                                                                                                                         |
| Handles             | `handle-plus-{handleId}`, `handle-plus-menu`, `plus-menu-{nodeType}`                                                                                                                                                                                                                                                                                                     |
| Edges               | `edge-delete-{edgeId}`                                                                                                                                                                                                                                                                                                                                                   |
| Inbox               | `unified-inbox-page`, `unified-inbox-filter-bar` (with `data-active-mailbox` / `data-active-type`), `unified-inbox-empty`, `unified-inbox-loading`, `unified-inbox-error`, `unified-inbox-list`, `unified-inbox-total-active`, `unified-inbox-load-more`, `inbox-type-filter-{key}` (key ∈ `all` / `approval` / `data_entry` / `escalation`, with `data-active` boolean) |
| Task Card           | `human-task-card` (with `data-task-id` / `data-task-type` / `data-task-status`), `human-task-card-toggle`, `human-task-approval-panel`, `human-task-notes`, `human-task-approve`, `human-task-reject`                                                                                                                                                                    |
| Connect-to-existing | `connect-to-existing-section`, `connect-to-existing-search`, `connect-to-existing-row-{nodeId}`, `connect-to-existing-empty`, `connect-to-existing-no-matches`, `merger-node-config`                                                                                                                                                                                     |

### 4. Test structure — phases with clear section comments

```typescript
test('Description of what is tested', async ({ page }) => {
  test.setTimeout(180_000);

  const workflowName = `DescriptivePrefix_${Date.now()}`;

  // ════════════════════════════════════════════════════════════════
  // PHASE 1: Setup
  // ════════════════════════════════════════════════════════════════
  await loginAndSetup(page);
  await navigateToWorkflows(page);
  await createWorkflowViaUI(page, workflowName, 'Test description');
  await waitForCanvasReady(page);

  // ════════════════════════════════════════════════════════════════
  // PHASE 2: Build flow
  // ════════════════════════════════════════════════════════════════
  // ... add nodes, configure

  // ════════════════════════════════════════════════════════════════
  // PHASE 3: Execute & verify
  // ════════════════════════════════════════════════════════════════
  // ... run workflow, check debug panel

  // ════════════════════════════════════════════════════════════════
  // Cleanup (best-effort)
  // ════════════════════════════════════════════════════════════════
  try {
    await navigateToWorkflows(page);
    await deleteWorkflowFromList(page, workflowName);
  } catch {
    console.warn(`Cleanup failed for workflow: ${workflowName}`);
  }
});
```

### 5. Unique workflow names — always include `Date.now()`

```typescript
const workflowName = `MonitorE2E_${Date.now()}`;
```

### 6. Handle flaky execution timing with defensive waits

```typescript
const didFinish = await debugPanel
  .locator('text=Completed')
  .or(debugPanel.locator('text=Failed'))
  .isVisible({ timeout: 45000 })
  .catch(() => false);

if (!didFinish) {
  console.warn('Execution did not complete — continuing with available checks');
}
```

### 7. Cleanup is best-effort — never fail the test on cleanup

Wrap cleanup in `try/catch`. A test that passes assertions must not fail because cleanup hit a stale element.

### 8. Close SlidePanel before interacting with elements behind it

The Monitor tab detail view uses Radix Dialog with a backdrop overlay that intercepts clicks:

```typescript
const closeBtn = page.locator('button[aria-label="Close panel"]');
if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
  await closeBtn.click();
} else {
  await page.keyboard.press('Escape');
}
```

### 9. Avoid ambiguous selectors — Playwright strict mode

```typescript
// BAD: matches label, badge, URL, heading, warning text (5 elements)
await expect(card.locator('text=Webhook')).toBeVisible();

// GOOD: specific element type + .first()
await expect(card.locator('p:has-text("Webhook")').first()).toBeVisible();
```

---

## Running Tests

All commands run from `apps/studio/`.

```bash
# All workflow E2E tests
npx playwright test e2e/workflows/ --reporter=list

# Specific spec file
npx playwright test e2e/workflows/workflow-comprehensive.spec.ts

# Headed mode (watch in browser)
npx playwright test e2e/workflows/workflow-comprehensive.spec.ts --headed

# Single test by grep
npx playwright test -g "Monitor tab"

# Core tests only (comprehensive + monitor-triggers = 5 tests, ~3 min)
npx playwright test e2e/workflows/workflow-comprehensive.spec.ts e2e/workflows/workflow-monitor-triggers.spec.ts
```

## Prerequisites

| Service          | URL                                                   | How to start                           |
| ---------------- | ----------------------------------------------------- | -------------------------------------- |
| Studio           | `localhost:5173`                                      | `pnpm --filter studio dev`             |
| Runtime          | `localhost:3112`                                      | `pnpm --filter runtime dev`            |
| Workflow Engine  | `localhost:9080`                                      | Express API for Runtime/Studio traffic |
| Restate Endpoint | `localhost:9081`                                      | See env vars below                     |
| Restate          | `localhost:8091` (ingress) / `localhost:9070` (admin) | Docker                                 |
| MongoDB          | `localhost:27018`                                     | Docker                                 |
| Redis            | `localhost:6380` (password: `localdev`)               | Docker                                 |

**JWT_SECRET must match across Studio, Runtime, and Workflow Engine**: `dev-jwt-secret-that-is-at-least-32chars`

Workflow engine env vars:

```
MONGODB_URL="mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true"
REDIS_URL="redis://:localdev@localhost:6380"
RESTATE_INGRESS_URL="http://localhost:8091"
JWT_SECRET="dev-jwt-secret-that-is-at-least-32chars"
ENCRYPTION_MASTER_KEY="0000000000000000000000000000000000000000000000000000000000000000"
```

---

## Known Engine Gaps

Update when resolved:

| Gap                                                                       | Impact                                              | Status                                                                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Function node: `transform-executor` expects `inputExpression`, not `code` | Cannot test JS code execution in function nodes     | Resolved -- function nodes now use dedicated `function-executor.ts` via `function -> function` mapping |
| Human node: email suggestion UI not built                                 | Cannot test assignee selection                      | Open                                                                                                   |
| Loop node: engine support unclear                                         | Cannot test loop iteration execution                | Open                                                                                                   |
| Connector triggers: need connector + connection infra                     | Cannot test connector trigger E2E                   | Open                                                                                                   |
| GAP-018: agent-bound chat → workflow-tool E2E harness                     | Blocks E2E-1 / E2E-5 / agent leg of E2E-2           | Open — deferred to v1.1 of `workflow-first-class-memory`                                               |
| GAP-019: cron trigger E2E harness                                         | Blocks cron leg of E2E-2 (cross-trigger continuity) | Open — deferred (engine support exists; harness setup not in workflow E2E surface)                     |

---

## Learnings

Append new learnings here. These prevent agents from repeating known mistakes.

- **Restate replays cause duplicate key errors**: MongoDB ops inside Restate handlers must use upsert (`$setOnInsert`), not `create()`/`insertOne`. Fixed in `execution-store.ts`.
- **JWT_SECRET mismatch causes silent 500s**: Studio generates a random `devSecret` if `JWT_SECRET` not in env. Always set it in `apps/studio/.env.local`.
- **Restate ingress port is 8091, not 8090**: Docker maps 8080->8091. Default in `restate-client.ts` was corrected.
- **MongoDB `nodeExecutions` vs frontend `steps`**: DB stores `nodeId`/`nodeName`/`nodeType`, frontend expects `stepId`/`stepName`. Normalization in `useWorkflowExecutions` hook.
- **Canvas node clicks are viewport-dependent**: Nodes may be off-screen in L-to-R layout. Use `selectNodeByName()` (Zustand store) instead of `page.click()`.
- **SlidePanel overlay blocks clicks**: Radix Dialog `SlidePanel` renders a `fixed inset-0 z-50` overlay. Must close panel before clicking elements behind it.
- **Strict mode on text selectors**: `text=Webhook` inside a trigger card matches 5+ elements (label, badge, URL, heading, warning). Always use specific selectors like `p:has-text("Webhook")`.
- **Multi-branch conditional testing**: To test both IF and ELSE paths, run the workflow twice with different inputs. Use postId=1 for ELSE (id=1 not > 1) and postId=3 for IF (id=3 > 1). Verify the skipped branch's nodes don't appear in the flow log.
- **GenAI/text_to_text nodes skip execution**: Without LLM credentials, the IF branch through text_to_text will fail. Test config (prompts, temperature, settings link) separately, and test execution via the ELSE branch that bypasses GenAI.
- **Tool creation API returns `{ tool: {...} }` not `{ data: {...} }`**: The `successJson('tool', doc)` helper produces `{ success: true, tool: {...} }`. List endpoint returns `{ data: [...] }`. Different shapes — handle both.
- **Tool node End-node wiring**: Use Zustand store `addNode('end', pos, { nodeId, handleId })` to add End node after Tool node. The `addNodeViaHandleMenu` from a Tool node fails because the node is off-screen in L-to-R layout.
- **Tool Select is Radix**: The tool selection dropdown renders via Radix Portal. Click `#tool-select` trigger, then `[role="option"]` with the tool name.
- **Agent creation API returns flat document**: POST `/api/projects/:id/agents` returns the agent document directly (`{ id, name, ... }`), not wrapped in `{ agent: {...} }`. Name must match `/^[a-zA-Z][a-zA-Z0-9_]*$/`. DELETE uses agent name (URL-encoded), not ID.
- **Agent Select is Radix**: Same pattern as Tool Select. Click `#agent-select` trigger, then `[role="option"]` with the agent name.
- **Agent node 401 on runtime chat API**: The workflow engine's runtimeClient was calling `/api/v1/chat` (authenticated endpoint). Fixed by creating `/api/internal/chat/agent` — an internal service-to-service endpoint without auth middleware, matching the existing `/api/internal/tools/execute` pattern.
- **Workflow engine has split API and Restate ports**: E2E traffic goes through Studio/Runtime and the engine Express API on `9080`; `9081` is the Restate endpoint. If a harness points workflow HTTP traffic at `9081`, it is using the wrong surface.
- **A targeted regression test is not blanket E2E coverage**: If a new spec only proves one public API path or a local-dev wiring path, record that as targeted coverage instead of marking the broader workflow area complete.
- **2026-04-19 — `workflow-trigger-api-key.spec.ts` tab-label loop is 3 entries, not 4**: `CodeSnippets` dropped the Async-only curl tab. The test now loops `['Sync', 'Async + Poll', 'Async Push']`. If you reintroduce an Async-only tab, also restore the `async_mode` key under `workflows.triggers.*` in `packages/i18n/locales/en/studio.json` and the `'async'` branch in `CodeSnippets.tsx` `buildCurl()`. Don't be surprised if an old stash reintroduces a 4-tab assertion — it's stale.
- **2026-04-19 — Draft view renders ONE badge, not two**: `WorkflowDetailPage` now suppresses the `workflow-state-badge` when the viewed version is draft. State (active/inactive) only applies to published versions; the draft is the editable working copy, not a lifecycle state. The old `'draft version shows [draft] [active] badges (not amber)'` test has been renamed to `'draft version shows only [draft] badge — no state pill'` and asserts `stateBadge.not.toBeVisible()`. Downstream consumers (Triggers tab, WebhookQuickStart) still receive `state === 'draft'` via props — only the header pill is suppressed.
- **2026-04-28 — Function-node memory globals via Zustand `updateNodeConfig`**: `workflow-first-class-memory.spec.ts` reuses the `configureFunctionNode` pattern from `workflow-function-node.spec.ts` to drop arbitrary code into the function node, including code that reads `agentSession` and calls `memory.user.get`. The host rethrows `WorkflowMemoryError` as `Error('UNAVAILABLE_SCOPE: ...')` (function-executor.ts:280-286), so the script-side catch matches by `/^([A-Z_]+):/` prefix on the message — author-facing branching contract.
- **2026-04-28 — Internal memory route uses service-token, not user-JWT**: `workflow-memory-erasure.spec.ts` mints its own service token via `jsonwebtoken` directly (issuer `agent-platform`, audience `agent-platform-internal`, type `service`, 5-minute expiry, secret = same `JWT_SECRET` workflow-engine uses). Don't try to hit `/api/internal/memory/*` with a user-access JWT — `requireServiceAuth` rejects it with 401. The middleware also cross-checks `body.tenantId` matches token claim — Phase 0 fix.
- **2026-04-28 — `DELETE /api/contacts/manage/:id/gdpr` is the cascade endpoint**: Studio E2E's `loginAndSetup` returns a user-access token that's authorized for the manage router (admin role). The route runs `CascadeDeleteContact.execute(tenantId, id)` end-to-end, which in turn fires the Phase 5 `factErasure` port, hard-deletes the contact document, and emits an audit event. The contact ID returned by `POST /api/contacts` is at `body.contact.id` OR `body.id` depending on the response wrapping — handle both shapes.
- **2026-04-28 — Memory projection user scope requires `endUserId`**: `POST /api/internal/memory/projection` returns `{ workflow, project, user? }` — the `user` field is `undefined` if the request omits `endUserId`. To assert the cascade deleted user-scope facts, you MUST pass the (now-deleted) contact's id as `endUserId` in the projection POST. Otherwise `user` will be omitted and the assertion is vacuous.

## 2026-04-28 — workflow-first-class-memory + workflow-memory-erasure E2E specs (Phase 6)

**Category**: feature
**Learning**: Phase 6 of `workflow-first-class-memory-and-context` lands two production E2E specs and one scaffold:

- `workflow-first-class-memory.spec.ts` — E2E-3 full: drives a Studio direct-run with a function-node body that reads `agentSession?.channel` (proves the global is `undefined` under non-agent triggers, falls through to `'no-agent'`) and a chained second function-node that calls `memory.user.get('foo')` inside a `try/catch`. The host rethrows `WorkflowMemoryError` as `Error('UNAVAILABLE_SCOPE: User scope requires actor.kind=end-user with endUserId')` — the script-side `try/catch` matches the code prefix via `/^([A-Z_]+):/`. E2E-1 / E2E-2 are explicit `test.skip` with rationale linking to GAP-018 (agent-bound chat E2E harness) and GAP-019 (cron trigger E2E harness).
- `workflow-memory-erasure.spec.ts` — E2E-4 full: real `POST /api/contacts` → service-token-authenticated `POST /api/internal/memory/set` (user-scope owned by `contactId`, plus a sibling project-scope sentinel) → `DELETE /api/contacts/manage/:id/gdpr` → re-projection asserts user-scope is empty AND project-scope sentinel is intact. Mints the service token inline using `jsonwebtoken` with the same issuer/audience/secret that `runtime-memory-client.ts` uses (`audience: 'agent-platform-internal'`, `issuer: 'agent-platform'`, `type: 'service'`) — keeps the spec free of compile-time platform-package coupling.
- `workflow-as-tool-nesting-memory.spec.ts` — E2E-5 scaffold (`test.skip`) with full file-level docstring documenting the agent-runtime prerequisite. Will gain a body when GAP-018 is closed.
  **Files**: `apps/studio/e2e/workflows/workflow-first-class-memory.spec.ts`, `apps/studio/e2e/workflows/workflow-memory-erasure.spec.ts`, `apps/studio/e2e/workflows/workflow-as-tool-nesting-memory.spec.ts`, this file
  **Impact**: E2E specs that exercise platform-internal HTTP routes (anything under `/api/internal/*`) must mint their own service tokens — they cannot use the `loginAndSetup` user-access JWT. The minting helper is short enough to keep inline; do not extract it into `helpers.ts` until at least 3 specs need it (avoid premature abstraction). E2E specs that depend on agent-runtime infrastructure (chat → agent → workflow-tool) should be scaffolded as `test.skip` with full docstring and tracked in the Known Engine Gaps table — DO NOT write a "looks-like-E2E-but-mocks-the-agent-runtime" spec; that produces false confidence.
