# Workflow Canvas System Replacement — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the step-list workflow UI with a visual node-based canvas using XY Flow, update CRUD APIs for the node-based data model, and validate with Playwright E2E tests against UAT scenarios.

**Architecture:** Three-panel canvas layout (assets sidebar, XY Flow canvas, config panel) with a Zustand store managing canvas state. The existing database models and shared types are already updated for the node-based system. Studio API routes proxy to runtime, which needs CRUD route updates. E2E tests use Playwright against the running Studio app.

**Tech Stack:** React 19, @xyflow/react 12, Zustand 4, SWR 2, Next.js 16, Playwright, Tailwind CSS, Zod, Lucide icons

**Spec:** `docs/superpowers/specs/2026-03-17-workflow-koreai-replacement-design.md`
**UAT:** `docs/superpowers/specs/2026-03-17-workflow-uat-scenarios.md`

---

## File Structure

### New Files

| File                                                                          | Responsibility                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/studio/src/store/workflow-canvas-store.ts`                              | Zustand store for canvas state (nodes, edges, selection, validation)     |
| `apps/studio/src/components/workflows/canvas/WorkflowCanvasPage.tsx`          | Main canvas page (three-panel layout, XY Flow provider)                  |
| `apps/studio/src/components/workflows/canvas/WorkflowCanvas.tsx`              | XY Flow canvas with drag-drop, minimap, background                       |
| `apps/studio/src/components/workflows/canvas/nodes/WorkflowNodeComponent.tsx` | Generic node card renderer (colored header, handles, name)               |
| `apps/studio/src/components/workflows/canvas/nodes/StartNodeComponent.tsx`    | Start node (green pill, single output)                                   |
| `apps/studio/src/components/workflows/canvas/nodes/EndNodeComponent.tsx`      | End node (dark gray pill, single input)                                  |
| `apps/studio/src/components/workflows/canvas/edges/WorkflowEdgeComponent.tsx` | Custom edge (curved, failure=dashed red, labels)                         |
| `apps/studio/src/components/workflows/canvas/panels/AssetsSidebar.tsx`        | Left panel — draggable node type palette                                 |
| `apps/studio/src/components/workflows/canvas/panels/ConfigPanel.tsx`          | Right panel — node config form (routes to type-specific editors)         |
| `apps/studio/src/components/workflows/canvas/panels/CanvasToolbar.tsx`        | Top toolbar — save, run, versions, validation, deploy                    |
| `apps/studio/src/components/workflows/canvas/panels/QuickAddBar.tsx`          | Bottom bar — click-to-add node icons                                     |
| `apps/studio/src/components/workflows/canvas/panels/ValidationPanel.tsx`      | Validation warnings/errors list                                          |
| `apps/studio/src/components/workflows/canvas/panels/RunDialog.tsx`            | Run workflow dialog (input fields, execute)                              |
| `apps/studio/src/components/workflows/canvas/panels/DeployPanel.tsx`          | Deploy panel (slug, mode, API keys)                                      |
| `apps/studio/src/components/workflows/canvas/config/StartNodeConfig.tsx`      | Start node config (input variables)                                      |
| `apps/studio/src/components/workflows/canvas/config/EndNodeConfig.tsx`        | End node config (output mapping)                                         |
| `apps/studio/src/components/workflows/canvas/config/TextToTextNodeConfig.tsx` | Text-to-Text config (model, prompts, params)                             |
| `apps/studio/src/components/workflows/canvas/config/ApiNodeConfig.tsx`        | API node config (method, URL, headers, body)                             |
| `apps/studio/src/components/workflows/canvas/config/FunctionNodeConfig.tsx`   | Function node config (code editor, variables)                            |
| `apps/studio/src/components/workflows/canvas/config/ConditionNodeConfig.tsx`  | Condition node config (conditions builder)                               |
| `apps/studio/src/components/workflows/canvas/config/HumanNodeConfig.tsx`      | Human node config (subject, assign, timeout)                             |
| `apps/studio/src/components/workflows/canvas/config/LoopNodeConfig.tsx`       | Loop node config (source, alias, error strategy)                         |
| `apps/studio/src/components/workflows/canvas/config/GenericNodeConfig.tsx`    | Fallback config for simple nodes (Integration, Delay, AgenticApp, stubs) |
| `apps/studio/src/components/workflows/canvas/useWorkflowValidation.ts`        | Validation hook (runs rules, returns errors/warnings)                    |
| `apps/studio/src/components/workflows/canvas/useWorkflowSave.ts`              | Auto-save + manual save hook                                             |
| `apps/studio/e2e/workflow-canvas-uat.spec.ts`                                 | Playwright E2E tests for UAT scenarios                                   |
| `apps/studio/e2e/helpers/workflow-helpers.ts`                                 | Shared E2E helpers (login, create workflow, navigate)                    |

### Modified Files

| File                                                           | Change                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/studio/src/components/navigation/AppShell.tsx`           | Route `workflows` subPage to `WorkflowCanvasPage` instead of `WorkflowDetailPage` |
| `apps/studio/src/api/workflows.ts`                             | Update types for node-based model, add save/deploy/version API calls              |
| `apps/studio/src/store/workflow-store.ts`                      | Add `selectedNodeId` field                                                        |
| `apps/studio/src/components/workflows/CreateWorkflowModal.tsx` | Remove type selector, simplify to name+description only                           |
| `apps/studio/src/hooks/useWorkflows.ts`                        | Update normalization for node-based model                                         |
| `apps/studio/src/app/api/projects/[id]/workflows/route.ts`     | Ensure proxy handles node-based payload                                           |

---

## Task 1: Canvas Store + Types

**Files:**

- Create: `apps/studio/src/store/workflow-canvas-store.ts`
- Modify: `apps/studio/src/api/workflows.ts`

- [ ] **Step 1: Create workflow canvas Zustand store**

The store manages all canvas state: nodes, edges, selected node, validation results, execution overlay state. Uses XY Flow's `applyNodeChanges` and `applyEdgeChanges` for immutable updates.

- [ ] **Step 2: Update API client types**

Replace step-based types with node-based types. Add `saveWorkflow`, `createWorkflowVersion`, `deployWorkflow` functions.

- [ ] **Step 3: Run prettier and build check**

Run: `npx prettier --write apps/studio/src/store/workflow-canvas-store.ts apps/studio/src/api/workflows.ts`
Run: `pnpm build --filter=@abl/studio`

---

## Task 2: Canvas Page Layout + XY Flow Canvas

**Files:**

- Create: `apps/studio/src/components/workflows/canvas/WorkflowCanvasPage.tsx`
- Create: `apps/studio/src/components/workflows/canvas/WorkflowCanvas.tsx`
- Modify: `apps/studio/src/components/navigation/AppShell.tsx`

- [ ] **Step 1: Create WorkflowCanvasPage**

Three-panel layout: AssetsSidebar (left, 200px), XY Flow canvas (center, flex), ConfigPanel (right, 380px, conditional). Top toolbar, bottom quick-add bar.

- [ ] **Step 2: Create WorkflowCanvas**

XY Flow `<ReactFlow>` with custom node types, custom edge types, minimap, background dots, snap-to-grid, delete handling, drag-drop from sidebar.

- [ ] **Step 3: Update AppShell routing**

Change the `case 'workflows':` branch to render `WorkflowCanvasPage` when `subPage` is set.

- [ ] **Step 4: Run prettier and build check**

---

## Task 3: Node Components

**Files:**

- Create: `apps/studio/src/components/workflows/canvas/nodes/WorkflowNodeComponent.tsx`
- Create: `apps/studio/src/components/workflows/canvas/nodes/StartNodeComponent.tsx`
- Create: `apps/studio/src/components/workflows/canvas/nodes/EndNodeComponent.tsx`

- [ ] **Step 1: Create WorkflowNodeComponent**

Generic node card: colored header bar (from `NODE_COLOR_MAP`), node type icon, editable name, output handles listed vertically (from `getOutputHandles()`), left input handle. Shows "Coming soon" badge for stub nodes.

- [ ] **Step 2: Create StartNodeComponent**

Green pill shape, single output handle ("on_success"), no input handle.

- [ ] **Step 3: Create EndNodeComponent**

Dark gray pill shape, single input handle, no output handles.

- [ ] **Step 4: Run prettier and build check**

---

## Task 4: Custom Edge + Panels (Sidebar, QuickAdd, Toolbar)

**Files:**

- Create: `apps/studio/src/components/workflows/canvas/edges/WorkflowEdgeComponent.tsx`
- Create: `apps/studio/src/components/workflows/canvas/panels/AssetsSidebar.tsx`
- Create: `apps/studio/src/components/workflows/canvas/panels/QuickAddBar.tsx`
- Create: `apps/studio/src/components/workflows/canvas/panels/CanvasToolbar.tsx`

- [ ] **Step 1: Create WorkflowEdgeComponent**

Custom edge: curved Bezier with arrowhead. Failure edges (sourceHandle contains "failure") use dashed red style. Condition/human edges show labels.

- [ ] **Step 2: Create AssetsSidebar**

Flat list of node types grouped by category (AI, Actions, Flow Control, etc.). Each item is draggable (`onDragStart` sets `application/workflow-node` data transfer). Stub nodes show "Coming soon" badge.

- [ ] **Step 3: Create QuickAddBar**

Horizontal strip of node type icons. Click adds node at default position.

- [ ] **Step 4: Create CanvasToolbar**

Top bar: back arrow, Run button, Save button, workflow name, version dropdown, validation badge, Manage I/O, zoom controls, Deploy button.

- [ ] **Step 5: Run prettier and build check**

---

## Task 5: Config Panel + Node Config Editors

**Files:**

- Create: `apps/studio/src/components/workflows/canvas/panels/ConfigPanel.tsx`
- Create: `apps/studio/src/components/workflows/canvas/config/StartNodeConfig.tsx`
- Create: `apps/studio/src/components/workflows/canvas/config/EndNodeConfig.tsx`
- Create: `apps/studio/src/components/workflows/canvas/config/TextToTextNodeConfig.tsx`
- Create: `apps/studio/src/components/workflows/canvas/config/ApiNodeConfig.tsx`
- Create: `apps/studio/src/components/workflows/canvas/config/FunctionNodeConfig.tsx`
- Create: `apps/studio/src/components/workflows/canvas/config/ConditionNodeConfig.tsx`
- Create: `apps/studio/src/components/workflows/canvas/config/HumanNodeConfig.tsx`
- Create: `apps/studio/src/components/workflows/canvas/config/LoopNodeConfig.tsx`
- Create: `apps/studio/src/components/workflows/canvas/config/GenericNodeConfig.tsx`

- [ ] **Step 1: Create ConfigPanel**

Right panel that opens when a node is selected. Header shows node type icon + editable name + close button. Routes to type-specific config editor based on `nodeType`.

- [ ] **Step 2: Create StartNodeConfig**

Input variables table: name, type dropdown, required checkbox, description. "Add input variable" button.

- [ ] **Step 3: Create EndNodeConfig**

Output mapping: key-value pairs where values are context expressions.

- [ ] **Step 4: Create TextToTextNodeConfig**

Model dropdown, connection dropdown, system prompt textarea, human prompt textarea, temperature slider, max tokens input, timeout slider, structured output toggle + JSON schema editor.

- [ ] **Step 5: Create ApiNodeConfig**

Method dropdown, URL input, headers key-value editor, body type selector + content editor, auth selector, mode toggle, timeout slider.

- [ ] **Step 6: Create FunctionNodeConfig**

Mode toggle (inline/custom_script), Monaco code editor, input variables table, test panel placeholder.

- [ ] **Step 7: Create ConditionNodeConfig**

Condition builder: field input + operator dropdown + value input. "Add Else If" button. Shows dynamic output handles.

- [ ] **Step 8: Create HumanNodeConfig**

Subject input, message textarea, assignTo radio (everyone/specific), assignees email input, timeout config, onTimeout radio.

- [ ] **Step 9: Create LoopNodeConfig**

Source expression input, item alias input, output field input, onError dropdown, maxIterations input.

- [ ] **Step 10: Create GenericNodeConfig**

Fallback for Integration, Delay, AgenticApp, Browser, DocSearch, DocIntelligence. Renders fields based on Zod schema.

- [ ] **Step 11: Run prettier and build check**

---

## Task 6: Validation + Save + CreateWorkflow Update

**Files:**

- Create: `apps/studio/src/components/workflows/canvas/useWorkflowValidation.ts`
- Create: `apps/studio/src/components/workflows/canvas/useWorkflowSave.ts`
- Create: `apps/studio/src/components/workflows/canvas/panels/ValidationPanel.tsx`
- Modify: `apps/studio/src/components/workflows/CreateWorkflowModal.tsx`

- [ ] **Step 1: Create useWorkflowValidation hook**

Implements validation rules from spec Section 5.8: no start node, no end node, disconnected nodes, missing config, duplicate names, stub nodes, cycle detection.

- [ ] **Step 2: Create useWorkflowSave hook**

Debounced auto-save (500ms) + manual save via toolbar. Calls `updateWorkflow` API with current nodes/edges.

- [ ] **Step 3: Create ValidationPanel**

List of validation errors/warnings with severity icons. Click error to select/highlight the offending node.

- [ ] **Step 4: Update CreateWorkflowModal**

Remove the type selector (node-based workflows don't have cx/ex/internal types). On create, auto-add a Start node at position {x:250, y:200}. Navigate to canvas page.

- [ ] **Step 5: Run prettier and build check**

---

## Task 7: Run Dialog + Deploy Panel

**Files:**

- Create: `apps/studio/src/components/workflows/canvas/panels/RunDialog.tsx`
- Create: `apps/studio/src/components/workflows/canvas/panels/DeployPanel.tsx`

- [ ] **Step 1: Create RunDialog**

Modal showing input variable fields (derived from Start node config). Run button triggers `executeWorkflow` API. Shows execution overlay on canvas (pulsing border for running, green check for completed, red X for failed).

- [ ] **Step 2: Create DeployPanel**

Slide-out panel: validation status, endpoint slug (editable, auto-generated from name), mode selector (sync/async_poll/async_push), timeout slider, API key list with create/revoke, endpoint URL with copy button.

- [ ] **Step 3: Run prettier and build check**

---

## Task 8: Playwright E2E Tests

**Files:**

- Create: `apps/studio/e2e/helpers/workflow-helpers.ts`
- Create: `apps/studio/e2e/workflow-canvas-uat.spec.ts`

- [ ] **Step 1: Create shared E2E helpers**

Extract `loginAndSetup` into reusable helper. Add helpers: `createWorkflowViaUI(page, name, description)`, `addNodeViaSidebar(page, nodeType)`, `addNodeViaQuickAdd(page, nodeType)`, `connectNodes(page, sourceId, handleName, targetId)`, `selectNode(page, nodeName)`, `waitForCanvasReady(page)`.

- [ ] **Step 2: Write UAT-1 tests (Canvas basics)**

Cover: UAT-1.1 (create workflow), UAT-1.2 (add nodes via drag), UAT-1.3 (add via quick-add), UAT-1.4 (connect nodes), UAT-1.5 (delete nodes/edges), UAT-1.6 (canvas navigation).

- [ ] **Step 3: Write UAT-2 tests (Node configuration)**

Cover: UAT-2.1 (Start config), UAT-2.2 (TextToText config), UAT-2.3 (API config), UAT-2.4 (Function config), UAT-2.5 (Condition config), UAT-2.6 (Human config), UAT-2.7 (Loop config), UAT-2.10 (Delay config), UAT-2.11 (rename), UAT-2.12 (stubs).

- [ ] **Step 4: Write UAT-3 tests (Toolbar actions)**

Cover: UAT-3.1 (save), UAT-3.2 (validation warnings).

- [ ] **Step 5: Write UAT-9 tests (Context and expressions)**

Cover: UAT-9.1 (context autocomplete), partially for UI-testable parts.

- [ ] **Step 6: Write UAT-10 tests (Error handling - validation)**

Cover: UAT-10.5 (invalid workflow validation), UAT-10.7 (cycle detection).

- [ ] **Step 7: Run E2E tests, fix failures iteratively**

Run: `cd apps/studio && npx playwright test e2e/workflow-canvas-uat.spec.ts --reporter=list`
Target: 80% of scenarios passing.

---

## Task Dependencies

```
Task 1 (store + types) ─┬─> Task 2 (page + canvas) ─┬─> Task 4 (edges + panels)
                        │                             │
                        └─> Task 3 (nodes)            └─> Task 5 (config panel)
                                                      │
                                                      └─> Task 6 (validation + save)
                                                      │
                                                      └─> Task 7 (run + deploy)

All Tasks 1-7 ──> Task 8 (E2E tests)
```

Tasks 3, 4, 5, 6, 7 can run in parallel after Task 1+2 are complete.
Task 8 runs after all UI tasks.
