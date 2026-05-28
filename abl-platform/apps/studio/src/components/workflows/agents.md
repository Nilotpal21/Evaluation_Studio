# Workflow UI — agents.md

Agent learning journal for the workflow UI components in `apps/studio/src/components/workflows/`.

Agents MUST read this file before modifying workflow UI code. Agents MUST append learnings after completing work.

---

## What This Is

The visual workflow builder: ReactFlow canvas, node config panels, debug/execution overlays, trigger management, and monitoring views. This does NOT cover the execution engine or API routes — see `docs/workflows/agents.md` (hub) for those.

## Architecture at a Glance

### Component Hierarchy

```
WorkflowsListPage.tsx          # /workflows — list view
  WorkflowCard.tsx             # Card in grid
  CreateWorkflowModal.tsx      # Create dialog

WorkflowDetailPage.tsx         # /workflows/:id — tab view
  tabs/
    WorkflowOverviewTab.tsx
    WorkflowStepsTab.tsx       # Legacy step-based editor
    WorkflowTriggersTab.tsx    # Trigger management
    WorkflowNotificationsTab.tsx
    WorkflowMonitorTab.tsx     # Execution history + KPIs
    WorkflowErrorTab.tsx

  canvas/
    WorkflowCanvasPage.tsx     # /workflows/:id/canvas — top-level canvas route
    WorkflowCanvas.tsx         # ReactFlow canvas (nodes, edges, interactions)
    nodes/
      WorkflowNodeComponent.tsx  # Generic node renderer (all types)
      StartNodeComponent.tsx     # Start node (special shape)
      EndNodeComponent.tsx       # End node (special shape)
      NodeDeleteButton.tsx
      HandlePlusMenu.tsx         # "+" button on handles to add downstream nodes
    edges/
      WorkflowEdgeComponent.tsx  # Custom edge with delete button
      EdgeDeleteButton.tsx
    config/                      # Node configuration panels (one per type)
      ApiNodeConfig.tsx
      ConditionNodeConfig.tsx
      EndNodeConfig.tsx
      FunctionNodeConfig.tsx
      HumanNodeConfig.tsx
      LoopNodeConfig.tsx
      StartNodeConfig.tsx
      TextToTextNodeConfig.tsx
      GenericNodeConfig.tsx      # Fallback for unknown types
    panels/
      ConfigPanel.tsx            # Right sidebar — shows selected node's config
      ValidationPanel.tsx        # Validation errors display
      RunDialog.tsx              # Execute dialog (input fields by type)
      ExecutionDebugPanel.tsx    # Debug overlay after execution
      WorkflowDebugPanel.tsx     # Alternative debug view
      DebugFlowLog.tsx           # Step-by-step flow log
      CanvasToolbar.tsx          # Top toolbar (run, save, zoom, etc.)
      QuickAddBar.tsx            # Quick-add node bar
      AssetsSidebar.tsx          # Left sidebar — available node types
      StepLogItem.tsx            # Single step in flow log
      ConditionStepDetail.tsx    # Condition step detail in debug
      HttpStepDetail.tsx         # HTTP step detail in debug

  steps/                         # Legacy step-based editor (pre-canvas)
    StepList.tsx
    StepEditor.tsx
    StepTypeSelector.tsx
    ParallelBranchEditor.tsx
    ContextExplorer.tsx

  triggers/
    ExternalAppCatalog.tsx
    SchedulePresetPicker.tsx
    WebhookKeyCreationModal.tsx
    WebhookQuickStart.tsx
    CodeSnippets.tsx
```

### State Management (Zustand)

| Store                    | File                                 | Responsibility                                                                                            |
| ------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `useWorkflowCanvasStore` | `src/store/workflow-canvas-store.ts` | Canvas state: nodes, edges, selected node, add/remove/update operations, serialization to/from API format |
| `useWorkflowStore`       | `src/store/workflow-store.ts`        | Workflow metadata: name, description, current workflow, list operations                                   |

**Canvas store is the source of truth for graph state.** Nodes and edges live in Zustand, ReactFlow renders them. All mutations (add node, connect, delete, rename) go through store actions.

### API Layer

| File                                   | Purpose                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `src/api/workflows.ts`                 | Client-side API functions (fetch, create, update, delete, execute) |
| `src/lib/workflow-engine-proxy.ts`     | Proxy helper for direct engine calls                               |
| `src/app/api/projects/[id]/workflows/` | ~13 Next.js BFF routes that proxy to Runtime or Workflow Engine    |

### Key Hooks

| Hook                    | File                              | Purpose                                             |
| ----------------------- | --------------------------------- | --------------------------------------------------- |
| `useAutoSave`           | `canvas/useAutoSave.ts`           | Auto-saves canvas after changes (debounced)         |
| `useWorkflowSave`       | `canvas/useWorkflowSave.ts`       | Manual save with validation                         |
| `useWorkflowValidation` | `canvas/useWorkflowValidation.ts` | Validates graph (connectivity, config completeness) |
| `useExecutionPolling`   | `canvas/useExecutionPolling.ts`   | Polls execution status during/after run             |

## Patterns & Conventions

### Adding a New Node Type

1. Add the type to `packages/shared-kernel/src/types/workflow-types.ts` (`NodeType` source of truth) and keep `packages/shared/src/types/workflow-schemas.ts` in sync
2. Create `config/{NodeType}NodeConfig.tsx` — must accept `node` and `onUpdate` props
3. Register in `ConfigPanel.tsx` switch statement
4. Add to `AssetsSidebar.tsx` node catalog (icon, label, category)
5. Add to `HandlePlusMenu.tsx` if it should appear in the "+" menu
6. Add executor in `apps/workflow-engine/src/executors/` (see engine agents.md)
7. Update `canvas-to-steps.ts` mapping if the node type name differs from step type
8. Add E2E test coverage (see `apps/studio/e2e/workflows/agents.md`)

### Config Panel Pattern

Each config component follows this pattern:

```tsx
interface Props {
  node: WorkflowNode;
  onUpdate: (nodeId: string, data: Partial<WorkflowNodeData>) => void;
}

export function ApiNodeConfig({ node, onUpdate }: Props) {
  // Read config from node.data.config
  // Call onUpdate(node.id, { config: { ...updated } }) on changes
}
```

### Design Tokens

Use semantic tokens from `@agent-platform/design-tokens`. No hardcoded Tailwind palette colors (`bg-blue-500`). See CLAUDE.md design token enforcement rule.

### Canvas Animations

Animation constants in `canvas/constants/animation.ts`, CSS in `canvas/styles/canvas-animations.css`.

## Known Gaps & Gotchas

- **Steps editor is legacy** — `steps/` folder is the pre-canvas editor. New work should target canvas only.
- **GenericNodeConfig.tsx** is a fallback — if a node type has no dedicated config, this renders. Check if your new node type falls through to it.
- **Canvas viewport positioning** — nodes added programmatically may be off-screen. Use Zustand store for reliable positioning in E2E tests (see E2E agents.md).
- **ConfigPanel re-renders on node selection** — selecting a different node unmounts and remounts the config component. Local state is lost.
- **Auto-save debounce** — `useAutoSave` debounces 2s after last change. Rapid changes don't trigger multiple saves.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work>
-->

## 2026-04-08 — Integration Picker State Must Reset Cleanly

**Category**: gotcha
**Learning**: `IntegrationPickerModal` is intentionally a two-screen flow (connector grid, then action list). Re-open, close, and Back all need to reset search state while still honoring `initialConnectorId` so editing an existing integration opens on the right connector without leaking prior modal state.
**Files**: `apps/studio/src/components/workflows/canvas/config/IntegrationPickerModal.tsx`
**Impact**: Modal refactors need to preserve the reopen/reset behavior or the integration picker becomes sticky and confusing in edit flows.

## 2026-04-08 — Integration Config Uses Connector Names And Hydrated Defaults

**Category**: pattern
**Learning**: The integration node stores the selected connector in `config.connectorId`, but that value is currently the connector catalog `name`, not a database `_id`. The config panel uses it for action lookup and connection filtering, keeps a client-side connection filter as a safety net, and must hydrate `config.params` with action prop `defaultValue`s so required defaults persist even when the user never touches that field.
**Files**: `apps/studio/src/components/workflows/canvas/config/IntegrationNodeConfig.tsx`
**Impact**: Any change to connector identity fields or action schemas must migrate saved config, API filters, and default-value hydration together.

## 2026-04-19 — React Flow `onNodesChange` fires on mount — filter dirty events

**Category**: gotcha
**Learning**: `workflow-canvas-store.onNodesChange` / `onEdgesChange` used to unconditionally set `isDirty: true`. React Flow dispatches `dimensions` change events the first time each node measures its DOM, and `select` events on click — neither is a user edit. Combined with `useAutoSave` (2s debounce on `isDirty`), the Steps tab fired a spurious `PATCH /versions/draft` on every mount. The fix only dirties on `add` / `remove` / `replace` / drag-end `position` for nodes, and `add` / `remove` / `replace` for edges. Config edits are unaffected because they go through dedicated store actions (`updateNodeConfig`, `updateNodeName`, `addNode`, `removeNode`, `setEnvVars`) which set `isDirty` directly.
**Files**: `apps/studio/src/store/workflow-canvas-store.ts`
**Impact**: Any new React Flow event wiring (new `onXChange` handlers, new change types in future SDK versions) must apply the same filter. When debugging "save fires but nothing changed" bugs, check the store's dirty filter before assuming the auto-save hook is wrong.

## 2026-04-19 — Parallel step at `runWorkflow` level ignores injected branchRunner

**Category**: gotcha
**Learning**: Writing an e2e test for the parallel step by injecting a custom `branchRunner` via `dispatcherDeps` will NOT work — `runWorkflow` in `apps/workflow-engine/src/handlers/workflow-handler.ts:663` unconditionally overwrites `dispatcherDeps.branchRunner` with its own `executeStepChain` wrapper. The correct pattern for parallel e2e is to include branch sub-steps in `input.steps` (so they land in `stepIndex`) and reference them by id from each `ParallelBranch.steps[]`. See `e2e-advanced.test.ts` "L3: Parallel step end-to-end" for the concrete pattern.
**Files**: `apps/workflow-engine/src/handlers/workflow-handler.ts`, `apps/workflow-engine/src/__tests__/e2e-advanced.test.ts`
**Impact**: Any handler-level test that wants parallel-step coverage must put real sub-steps (transforms, HTTP steps etc.) in `input.steps` — injecting a mock branchRunner is dead code.

## 2026-05-04 — Context Suggestions: Step-Key Contract and Shared Hook

**Category**: pattern
**Learning**: Before this feature, `IntegrationNodeConfig` had inline BFS traversal that used the node UUID (`steps.${uuid}.output`) as the step key, which silently never resolved at runtime. The workflow engine resolves steps by `ctx.steps[step.name ?? step.id]` where `step.name = n.data.label` (canvas label). The hook `useWorkflowExpressionContext(nodeId)` computes `previousSteps` with `id: n.data.label ?? n.id`. All node config panels consume this via `useNodeExpressionContext()` from `NodeExpressionContext.tsx` — `ConfigPanel` calls the hook once and provides it via React context so all \*NodeConfig children share a single BFS computation.
**Files**: `apps/studio/src/components/workflows/canvas/hooks/useWorkflowExpressionContext.ts`, `apps/studio/src/components/workflows/canvas/config/NodeExpressionContext.tsx`, `apps/studio/src/components/workflows/canvas/panels/ConfigPanel.tsx`
**Impact**: New node types with expression inputs must call `useNodeExpressionContext()` (not the raw hook directly). `ConfigPanel` is the only place that calls `useWorkflowExpressionContext`. Never use `n.id` (UUID) as a step key — always `n.data.label`.

## 2026-05-04 — Context Suggestions: ContextExplorer Static Schemas

**Category**: pattern
**Learning**: Memory, Agent Session, and Agent Context categories in `ContextExplorer.tsx` use hardcoded constants (`MEMORY_FIELDS`, `AGENT_SESSION_FIELDS`, `AGENT_CONTEXT_FIELDS`) derived from `AgentSessionProjection`, `AgentContextProjection`, `MemoryProjection` interfaces in `apps/workflow-engine/src/context/expression-resolver.ts`. When those interfaces gain new fields, the constants must be updated to match. `KNOWN_TOP_LEVEL_KEYS` in `expression-resolver.ts` is the canonical source of all top-level expression keys — the `vars` key is intentionally excluded from ContextExplorer because its contents are not predictable at design time.
**Files**: `apps/studio/src/components/workflows/steps/ContextExplorer.tsx`, `apps/workflow-engine/src/context/expression-resolver.ts`
**Impact**: When extending the expression context (new memory scope, new agentSession field, etc.), update both the engine interfaces AND the studio constants in the same change.

## 2026-05-04 — Context Suggestions: data-testids on ExpressionInput and ContextExplorer

**Category**: pattern
**Learning**: `ExpressionInput.tsx` and `ContextExplorer.tsx` now have `data-testid` attributes needed for E2E expression authoring tests: `expression-input` (container div), `expression-explorer-btn` (the `{⋮}` button), `context-explorer` (root div), `context-explorer-search` (search input), `context-explorer-category-{categoryKey}` (per category button), `context-explorer-leaf-{node.key}` (per leaf node button, only on leaves).
**Files**: `apps/studio/src/components/workflows/canvas/config/ExpressionInput.tsx`, `apps/studio/src/components/workflows/steps/ContextExplorer.tsx`
**Impact**: E2E tests at `apps/studio/e2e/workflows/expression-authoring.spec.ts` can now use these selectors. See `docs/testing/sub-features/workflow-canvas-context-suggestions.md` §7 for the full list.

## 2026-05-04 — Context Suggestions: GAP-006 — Node rename breaks expressions

**Category**: gotcha
**Learning**: Renaming a canvas node (via `updateNodeName` in `workflow-canvas-store.ts`) does NOT scan other nodes' config values for `{{steps.<old-label>.output}}` references. The rename-cascade feature is unimplemented. Any expression authored before a rename becomes stale and silently resolves to `undefined` at runtime. This is documented as GAP-006 (High severity) in the feature spec. Until fixed, do not advertise expression authoring as "safe from rename" in UX copy.
**Files**: `apps/studio/src/store/workflow-canvas-store.ts` (updateNodeName action, line ~434)
**Impact**: If implementing rename-cascade, scan all node config string values for `{{steps.<old>.output}}` patterns and replace. Test with INT-6 pattern once cascade is implemented.

## 2026-05-08 — Multiple End Nodes Share One Output Schema

**Category**: gotcha
**Learning**: Studio save-time output schema derivation must mirror workflow-engine execution: every canvas End node contributes output fields to the workflow-level `outputSchema`. A `oneOf` schema described mutually exclusive branches, but execution now resolves the aggregate `outputMappings` list so consumers should see one object schema with all declared fields.
**Files**: `apps/studio/src/lib/variables-to-json-schema.ts`, `apps/studio/src/__tests__/variables-to-json-schema.test.ts`
**Impact**: When changing End-node output behavior, update both runtime conversion and Studio schema derivation together or saved workflow metadata will drift from execution output.
