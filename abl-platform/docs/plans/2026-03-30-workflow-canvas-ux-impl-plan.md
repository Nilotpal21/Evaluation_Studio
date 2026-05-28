# LLD: Workflow Canvas UX Improvements

**Feature Spec**: `docs/features/workflows.md`
**HLD/UI Spec**: `docs/specs/workflow-canvas-ux-improvements.md`
**Test Spec**: `docs/testing/workflows.md`
**Status**: DRAFT
**Date**: 2026-03-30

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                | Rationale                                                                                                            | Alternatives Rejected                                                                    |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| D-1 | Left-to-right flow: handles move from Top/Bottom to Left/Right          | Horizontal flow is standard for pipeline/workflow tools (Retool, n8n, Power Automate). Matches how users read (LTR). | Keep top-to-bottom (less intuitive for linear flows)                                     |
| D-2 | Client-side position migration, not DB migration                        | Positions are visual-only metadata. fitView provides fallback. No data risk.                                         | Server-side migration script (heavyweight, risky)                                        |
| D-3 | Radix Popover for handle context menu                                   | Flexible positioning, scrollable content, collapsible sections. Radix already a transitive dep.                      | DropdownMenu (less flexible for nested categories), custom portal (reinvention)          |
| D-4 | Single WorkflowDebugPanel with `mode` prop                              | Identical sub-components (Input, FlowLog, Output accordions). Only header actions differ.                            | Two separate components (code duplication), shared sub-components only (over-fragmented) |
| D-5 | CSS/Tailwind keyframes + framer-motion for exit animations              | Both already in codebase. CSS for simple transitions, framer-motion for AnimatePresence exit.                        | CSS-only (no exit animations), framer-motion everywhere (overkill for hovers)            |
| D-6 | getSmoothStepPath in polish phase, getBezierPath initially              | Bezier auto-adapts to handle position changes. Smooth-step is visual upgrade only.                                   | Switch immediately (unnecessary coupling of structural + visual changes)                 |
| D-7 | No feature flag — ship directly on feature branch                       | UI-only changes, ALPHA feature, feature branch is the gate.                                                          | Feature flag per section (over-engineering for alpha feature)                            |
| D-8 | Remove QuickAddBar and replace with handle context menu simultaneously  | Cannot remove the primary node-add mechanism without providing replacement. Sections 3+4 are coupled.                | Remove QuickAddBar later (leaves gap in UX)                                              |
| D-9 | Run button: direct execution when no input vars, modal only when needed | Eliminates unnecessary click-through for the common case. Current modal shows empty "no variables" state.            | Always show modal (unnecessary friction), always skip modal (can't collect inputs)       |

### Key Interfaces & Types

```typescript
// New store state additions (workflow-canvas-store.ts)
interface WorkflowCanvasStore {
  // ... existing ...

  // Derived (not stored): saveStatus derived from existing isSaving/isDirty in toolbar
  // Derived (not stored): isExecuting derived from currentExecutionId !== null

  // New: Canvas expand state
  canvasExpanded: boolean;
  setCanvasExpanded: (expanded: boolean) => void;

  // Modified: addNode now takes optional sourceInfo for auto-edge creation
  addNode: (
    nodeType: NodeType,
    position?: { x: number; y: number },
    sourceInfo?: { nodeId: string; handleId: string },
  ) => void;

  // New: Remove edge by ID
  removeEdge: (edgeId: string) => void;
}

// WorkflowDebugPanel props (new component)
interface WorkflowDebugPanelProps {
  executionData: WorkflowExecution | null;
  mode: 'canvas' | 'monitor';
  onClose: () => void;
  onExpand?: () => void;
}

// HandlePlusMenu props (new component)
interface HandlePlusMenuProps {
  nodeId: string;
  handleId: string;
  isFailureHandle: boolean;
  position: { x: number; y: number };
}
```

### Module Boundaries

| Module                      | Responsibility                                                        | Depends On                                        |
| --------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| `workflow-canvas-store.ts`  | Canvas state, node/edge CRUD, execution state, UI panel state         | `@xyflow/react`, `shared-kernel/types`            |
| `WorkflowNodeComponent.tsx` | Node rendering with L-to-R handles, hover trash, handle plus triggers | Store, `HandlePlusMenu`, `NodeDeleteButton`       |
| `WorkflowEdgeComponent.tsx` | Edge rendering with selection trash                                   | Store, `EdgeDeleteButton`                         |
| `HandlePlusMenu.tsx`        | Plus icon hover + Popover context menu for adding nodes               | Store, Radix Popover, `shared-kernel/types`       |
| `WorkflowDebugPanel.tsx`    | Shared debug panel (Input, FlowLog, Output accordions)                | Store (canvas mode), execution API, Monaco        |
| `CanvasToolbar.tsx`         | Toolbar with save status, run/stop, expand/collapse                   | Store, execution API                              |
| `WorkflowMonitorTab.tsx`    | Execution history grid + slider with debug panel                      | Execution API, `WorkflowDebugPanel`, `SlidePanel` |

---

## 2. File-Level Change Map

### New Files

| File                                   | Purpose                                                                               | LOC Est. |
| -------------------------------------- | ------------------------------------------------------------------------------------- | -------- |
| `canvas/nodes/HandlePlusMenu.tsx`      | Handle hover plus icon + node-type context menu popover                               | ~180     |
| `canvas/nodes/NodeDeleteButton.tsx`    | Hover trash icon for node deletion                                                    | ~60      |
| `canvas/edges/EdgeDeleteButton.tsx`    | Selection trash icon for edge deletion                                                | ~50      |
| `canvas/panels/WorkflowDebugPanel.tsx` | Shared debug panel with Input/FlowLog/Output accordions                               | ~350     |
| `canvas/panels/DebugFlowLog.tsx`       | Flow log accordion content with step items                                            | ~200     |
| `canvas/panels/StepLogItem.tsx`        | Individual step log item (collapsible, metrics, I/O)                                  | ~180     |
| `canvas/constants/animation.ts`        | Tailwind keyframe constants (framer-motion presets go in existing `lib/animation.ts`) | ~20      |

### Modified Files

| File                                     | Change Description                                                                                                                               | Risk |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| `store/workflow-canvas-store.ts`         | Add `saveStatus`, `isExecuting`, `canvasExpanded`, `removeEdge`; modify `addNode` for sourceInfo param; update default position logic for L-to-R | Med  |
| `canvas/nodes/WorkflowNodeComponent.tsx` | Handle positions Top->Left, Bottom->Right; vertical output handle stack; render HandlePlusMenu + NodeDeleteButton                                | High |
| `canvas/nodes/StartNodeComponent.tsx`    | Handle Bottom->Right; render HandlePlusMenu (no delete)                                                                                          | Low  |
| `canvas/nodes/EndNodeComponent.tsx`      | Handle Top->Left; render NodeDeleteButton (no plus menu)                                                                                         | Low  |
| `canvas/edges/WorkflowEdgeComponent.tsx` | Render EdgeDeleteButton on selection                                                                                                             | Low  |
| `canvas/WorkflowCanvas.tsx`              | Add `deleteKeyCode={['Backspace','Delete']}`, update edge defaults                                                                               | Low  |
| `canvas/WorkflowCanvasPage.tsx`          | Remove QuickAddBar import/render; add panel transition logic; wire new RunDialog flow                                                            | Med  |
| `canvas/panels/CanvasToolbar.tsx`        | New layout: remove Save/Deploy/Zoom, add save status + expand/collapse; conditional Run logic                                                    | Med  |
| `canvas/panels/RunDialog.tsx`            | Add entry/exit animations; called only when input vars exist                                                                                     | Low  |
| `workflows/WorkflowDetailPage.tsx`       | Tab id `steps`->`flow`, label `Steps`->`Flow`, icon change                                                                                       | Low  |
| `workflows/tabs/WorkflowMonitorTab.tsx`  | Replace inline expansion with slider + WorkflowDebugPanel                                                                                        | Med  |
| `shared-kernel/types/workflow-types.ts`  | Add `integration` to `STUB_NODE_TYPES`                                                                                                           | Low  |
| `tailwind.config.ts` (studio)            | Add canvas animation keyframes, easing, durations                                                                                                | Low  |
| `e2e/helpers/workflow-helpers.ts`        | Replace `addNodeViaQuickAdd` with `addNodeViaHandleMenu`                                                                                         | Med  |
| `e2e/workflow-canvas-uat.spec.ts`        | Update all node-add calls, remove save/deploy assertions                                                                                         | Med  |

### Deleted Files

| File                                    | Reason                                      |
| --------------------------------------- | ------------------------------------------- |
| `canvas/panels/QuickAddBar.tsx`         | Replaced by handle context menu (Section 3) |
| `canvas/panels/ExecutionDebugPanel.tsx` | Replaced by WorkflowDebugPanel (Section 8)  |

---

## 3. Implementation Phases

### Phase 1: Foundation — Left-to-Right Layout + Animation Constants

**Goal**: Switch the canvas flow direction from top-to-bottom to left-to-right, and establish the shared animation infrastructure.

**Tasks**:

1.1. Add Tailwind keyframe constants to `canvas/constants/animation.ts` (durations, easing tokens) and extend `tailwind.config.ts` with canvas keyframes, easing functions (`cubic-bezier(0.16, 1, 0.3, 1)`), and animation utilities (slide-in-right, fade-scale-in, node-appear, pulse-ring). Framer-motion transition presets go in existing `lib/animation.ts` (where `SlidePanel` already imports from).

1.2. Update `StartNodeComponent.tsx`: change output handle from `Position.Bottom` to `Position.Right`.

1.3. Update `EndNodeComponent.tsx`: change input handle from `Position.Top` to `Position.Left`.

1.4. Update `WorkflowNodeComponent.tsx`: change input handle from `Position.Top` to `Position.Left`; change all output handles from `Position.Bottom` to `Position.Right`; restructure output handle layout from horizontal row at bottom to vertical stack on right side with labels to the left of each handle dot. Add right-side padding (`pr-8`) for handle labels.

1.5. Update `workflow-canvas-store.ts` `addNode` default position logic: new nodes offset 250px right (instead of 150px down). Add `migrateToHorizontalLayout()` helper function.

1.6. Update `WorkflowCanvasPage.tsx` `convertApiNodesToFlow`: apply `migrateToHorizontalLayout()` transform when loading existing workflows with vertical layout. Default Start node position changes from `{x:400, y:50}` to `{x:50, y:200}`.

**Files Touched**:

- `apps/studio/src/components/workflows/canvas/constants/animation.ts` — new
- `apps/studio/tailwind.config.ts` — add keyframes/animations
- `apps/studio/src/components/workflows/canvas/nodes/StartNodeComponent.tsx` — handle position
- `apps/studio/src/components/workflows/canvas/nodes/EndNodeComponent.tsx` — handle position
- `apps/studio/src/components/workflows/canvas/nodes/WorkflowNodeComponent.tsx` — handle positions + layout
- `apps/studio/src/store/workflow-canvas-store.ts` — addNode positioning + migration helper
- `apps/studio/src/components/workflows/canvas/WorkflowCanvasPage.tsx` — apply migration on load

**Exit Criteria**:

- [ ] All three node components render handles on Left (input) and Right (output) sides
- [ ] Edges route horizontally between nodes (verified visually by running Studio dev server)
- [ ] Output handles on WorkflowNodeComponent are stacked vertically with labels to the left
- [ ] Existing vertical-layout workflows load with horizontal positions after client-side migration
- [ ] `fitView` centers the canvas correctly after migration
- [ ] `pnpm build --filter=@agent-platform/studio` succeeds with 0 errors
- [ ] New animation keyframes are available in Tailwind (`animate-slide-in-right`, `animate-node-appear`, etc.)

**Test Strategy**:

- Unit: Verify `migrateToHorizontalLayout()` correctly detects vertical layout and swaps coordinates
- Visual: Manual verification of node rendering in dev server (L-to-R flow, handles on correct sides)

**Rollback**: Revert handle position changes in all 3 node components. Positions saved after migration will render with handles on wrong sides but `fitView` keeps them visible.

---

### Phase 2: Canvas Chrome — Tab Rename, Header, Remove QuickAddBar

**Goal**: Clean up the canvas chrome: rename tab, simplify toolbar, remove QuickAddBar.

**Tasks**:

2.1. Update `WorkflowDetailPage.tsx`: change tab from `{id:'steps', label:'Steps', icon:<ListOrdered>}` to `{id:'flow', label:'Flow', icon:<Workflow>}`. Add URL redirect: if `tabId === 'steps'`, navigate to `flow` to preserve bookmarked URLs.

2.2. Refactor `CanvasToolbar.tsx` to new layout: remove Save button, Deploy button, Zoom In/Out buttons. Add save status indicator (reads `saveStatus` from store). Move Run button right-aligned. Add Expand/Collapse button (rightmost).

2.3. Update `workflow-canvas-store.ts`: derive `saveStatus` from existing `isSaving`/`isDirty` state in CanvasToolbar (do NOT add parallel `saveStatus` field — use existing state). Add `canvasExpanded` state + `setCanvasExpanded` action. Grep for `deployPanelOpen` consumers and remove all references before deleting the state.

2.4. Update `useWorkflowSave.ts`: add `saveError` state tracking (boolean). On save failure, set `saveError = true` so the toolbar can show "Save failed". The toolbar derives display status from existing `isSaving` (→ "Saving..."), `isDirty` (→ shows dot), and new `saveError` (→ "Save failed"). Auto-clear `saveError` after 5s.

2.5. Delete `QuickAddBar.tsx`. Remove its import and render from `WorkflowCanvasPage.tsx`.

2.6. Add `integration` to `STUB_NODE_TYPES` in `packages/shared-kernel/src/types/workflow-types.ts`.

2.7. Update `ContextExplorer.tsx`: rename any "Steps" labels to "Nodes" per spec Section 1.

**Files Touched**:

- `apps/studio/src/components/workflows/WorkflowDetailPage.tsx` — tab rename
- `apps/studio/src/components/workflows/canvas/panels/CanvasToolbar.tsx` — major refactor
- `apps/studio/src/store/workflow-canvas-store.ts` — new state fields
- `apps/studio/src/components/workflows/canvas/useWorkflowSave.ts` — save status updates
- `apps/studio/src/components/workflows/canvas/panels/QuickAddBar.tsx` — delete
- `apps/studio/src/components/workflows/canvas/WorkflowCanvasPage.tsx` — remove QuickAddBar
- `packages/shared-kernel/src/types/workflow-types.ts` — STUB_NODE_TYPES
- `apps/studio/src/components/workflows/steps/ContextExplorer.tsx` — "Steps" → "Nodes" label

**Exit Criteria**:

- [ ] Tab shows "Flow" with Workflow icon (not "Steps" with ListOrdered)
- [ ] Navigating to old `?tab=steps` URL redirects to `?tab=flow`
- [ ] ContextExplorer shows "Nodes" label instead of "Steps"
- [ ] Toolbar layout is: `[Back] [Name] [Badge] ··· [Save status] [Run] [Expand]`
- [ ] Save/Deploy/Zoom buttons are gone from toolbar
- [ ] Save status shows "Saving...", "All changes saved" (fades after 3s), or "Save failed"
- [ ] QuickAddBar is completely removed (no bottom bar)
- [ ] `integration` shows "Coming soon" badge in AssetsSidebar
- [ ] `pnpm build --filter=@agent-platform/studio --filter=@agent-platform/shared-kernel` succeeds
- [ ] No TypeScript errors referencing removed `deployPanelOpen` or `QuickAddBar`

**Test Strategy**:

- Unit: Verify `STUB_NODE_TYPES` includes `integration`
- Visual: Toolbar renders correctly, save status transitions work

**Rollback**: Revert toolbar changes. QuickAddBar can be re-added from git history. Tab rename is trivial to revert.

---

### Phase 3: Canvas Interactions — Handle Plus Menu, Node Delete, Edge Delete

**Goal**: Implement the three core interaction improvements: handle hover context menu, node hover trash, edge selection trash.

**Tasks**:

3.1. Create `HandlePlusMenu.tsx`: renders a plus icon 8px to the right of each output handle on hover (150ms fade-in, scale 0.8→1). On click, opens a Radix Popover (used directly, matching existing pattern in `VariableNamespaceTagPopover.tsx` — no shared wrapper needed) with node types grouped by category (same categories as AssetsSidebar). On select: calls `addNode(nodeType, position, {nodeId, handleId})` to create node + edge. Failure handles show red hover state.

3.2. Update `WorkflowNodeComponent.tsx`: wrap each output handle in a `handle-wrapper` div that renders `<HandlePlusMenu>` as a sibling. Ensure the plus icon doesn't interfere with ReactFlow's native drag-to-connect behavior.

3.3. Update `StartNodeComponent.tsx`: add `<HandlePlusMenu>` to the `on_success` output handle.

3.4. Create `NodeDeleteButton.tsx`: renders a trash icon at top-right of node on hover (150ms fade-in). On click: if node has connected edges, show confirmation tooltip; otherwise delete immediately via `removeNode`. Hidden for `start` node type.

3.5. Update `WorkflowNodeComponent.tsx`: render `<NodeDeleteButton>` as a positioned overlay. Update `StartNodeComponent.tsx` to NOT render it. Update `EndNodeComponent.tsx` to render it.

3.6. Create `EdgeDeleteButton.tsx`: renders a trash icon at edge midpoint (`labelX`, `labelY`) when edge is selected. On click: delete edge via `removeEdge`. Rendered inside `<EdgeLabelRenderer>`.

3.7. Update `WorkflowEdgeComponent.tsx`: render `<EdgeDeleteButton>` when `selected === true`.

3.8. Update `WorkflowCanvas.tsx`: set `deleteKeyCode={['Backspace', 'Delete']}` to enable keyboard deletion for both nodes and edges.

3.9. Update `workflow-canvas-store.ts`: modify `addNode` to accept optional `sourceInfo` parameter — when provided, automatically create an edge from `sourceInfo.nodeId/handleId` to the new node's input. Add `removeEdge(edgeId)` action.

**Files Touched**:

- `apps/studio/src/components/workflows/canvas/nodes/HandlePlusMenu.tsx` — new
- `apps/studio/src/components/workflows/canvas/nodes/NodeDeleteButton.tsx` — new
- `apps/studio/src/components/workflows/canvas/edges/EdgeDeleteButton.tsx` — new
- `apps/studio/src/components/workflows/canvas/nodes/WorkflowNodeComponent.tsx` — integrate plus menu + delete
- `apps/studio/src/components/workflows/canvas/nodes/StartNodeComponent.tsx` — integrate plus menu
- `apps/studio/src/components/workflows/canvas/nodes/EndNodeComponent.tsx` — integrate delete button
- `apps/studio/src/components/workflows/canvas/edges/WorkflowEdgeComponent.tsx` — integrate delete button
- `apps/studio/src/components/workflows/canvas/WorkflowCanvas.tsx` — deleteKeyCode
- `apps/studio/src/store/workflow-canvas-store.ts` — addNode sourceInfo, removeEdge

**Exit Criteria**:

- [ ] Hovering any output handle (on_success, on_failure, condition branches, etc.) shows plus icon with 150ms transition
- [ ] Clicking plus icon opens popover with categorized node types; stub types show "Coming soon"
- [ ] Selecting a node type from popover creates node 250px to the right + auto-edge from source handle
- [ ] Dragging from handle still works (native ReactFlow connect behavior preserved)
- [ ] Hovering any non-start node shows trash icon at top-right
- [ ] Clicking node trash deletes node + connected edges (with confirmation if edges exist)
- [ ] Selecting an edge shows trash icon at midpoint; clicking deletes the edge
- [ ] Backspace/Delete key removes selected nodes or edges
- [ ] `pnpm build --filter=@agent-platform/studio` succeeds

**Test Strategy**:

- Unit: `addNode` with `sourceInfo` creates node + edge in store. `removeEdge` removes correct edge.
- Visual: All hover/click interactions verified manually in dev server

**Rollback**: Delete new component files, revert integration changes in node/edge components.

---

### Phase 4: Run Behavior — Direct Execution + Conditional Modal

**Goal**: Run button directly opens debug panel when no input variables; modal only when inputs needed.

**Tasks**:

4.1. Update `CanvasToolbar.tsx` Run button handler: extract `inputVariables` from `startNode.data.config.inputVariables` (same lookup as `RunDialog.tsx:31-36`). Extract this lookup into a shared `getWorkflowInputVariables(nodes)` utility in `canvas/utils/workflow-utils.ts`. If `inputVariables` is empty, call `executeWorkflow` directly and open debug panel. If non-empty, open `RunDialog`. **Note**: Phase 4 uses the existing `ExecutionDebugPanel` for the debug panel — it will be replaced by `WorkflowDebugPanel` in Phase 5. The run behavior logic is independent of which panel renders.

4.2. Update `RunDialog.tsx`: add framer-motion `AnimatePresence` for backdrop fade (150ms) and card scale entry (200ms, expo-out). Remove the "No input variables defined" empty state (modal is never shown without variables now).

4.3. Update `workflow-canvas-store.ts`: derive `isExecuting` from `currentExecutionId !== null && executionOverlay` active state (avoid duplicating derivable state). Add a `computed` selector `useIsExecuting()` if Zustand subscriptions need it.

4.4. Update `CanvasToolbar.tsx` Run button: show `[▶ Run]` when idle, `[■ Stop]` with ping dot animation when executing. **Note**: Cancel execution API does not exist yet in `apps/studio/src/api/workflows.ts`. Stop button renders disabled with tooltip "Cancel not yet available" until the backend endpoint is implemented. Wire it to a `cancelExecution(projectId, workflowId, executionId)` API stub that can be enabled later.

4.5. Wire execution data polling: reuse the `useExecutionPolling` hook (already in `useExecutionPolling.ts`, polls every 1500ms) for the debug panel. Pass `currentExecutionId` to the hook to fetch live updates.

**Files Touched**:

- `apps/studio/src/components/workflows/canvas/panels/CanvasToolbar.tsx` — run logic
- `apps/studio/src/components/workflows/canvas/panels/RunDialog.tsx` — conditional + animations
- `apps/studio/src/store/workflow-canvas-store.ts` — isExecuting state

**Exit Criteria**:

- [ ] Clicking Run on a workflow with no input variables immediately opens debug panel (no modal)
- [ ] Clicking Run on a workflow with input variables shows modal with fields
- [ ] Modal has fade/scale entry animation and fade exit animation
- [ ] Run button shows "Stop" with ping animation during execution
- [ ] Stop button renders disabled with tooltip "Cancel not yet available" during execution
- [ ] `pnpm build --filter=@agent-platform/studio` succeeds

**Test Strategy**:

- Unit: Verify run handler branches correctly based on inputVariables presence
- Visual: Test both paths (with/without input vars) in dev server

**Rollback**: Revert toolbar run handler to always open RunDialog.

---

### Phase 5: Debug Panel Redesign

**Goal**: Replace ExecutionDebugPanel with the new WorkflowDebugPanel featuring Input/FlowLog/Output accordions with step-level I/O and metrics.

**Tasks**:

5.1. Create `StepLogItem.tsx`: collapsible step using existing `CollapsibleSection` pattern (from `JsonViewer.tsx`) with status icon, node type icon, step name, elapsed time, chevron. Expanded body: status code (integration nodes), Input sub-accordion using `JsonViewer` component (read-only, with copy-to-clipboard), Output sub-accordion using `JsonViewer`, Metrics section (initiated/completed/duration). Reserve Monaco for the main Output accordion only (where search/select is valuable).

5.2. Create `DebugFlowLog.tsx`: renders list of `StepLogItem` components. Prepends synthetic Start step (with input values) if not present in execution data.

5.3. Create `WorkflowDebugPanel.tsx`: header (title, elapsed time badge, code toggle, expand, close), three collapsible accordions (Input, Flow Log, Output). Output accordion has Monaco JSON editor with copy/expand actions. Accepts `mode: 'canvas' | 'monitor'` prop.

5.4. Update `WorkflowCanvasPage.tsx`: replace `<ExecutionDebugPanel>` with `<WorkflowDebugPanel mode="canvas">`. Add slide-in-right animation (350ms) for panel entry.

5.5. Implement Context Object Panel (spec Section 8.6): the "code toggle" (`</>`) button in the debug panel header toggles a full-width Monaco editor showing the raw execution context JSON (the entire execution response). When toggled on, it replaces the accordion view. Read-only, `vs-dark` theme, with copy button. Toggle state stored locally in component (not store).

5.6. Delete `ExecutionDebugPanel.tsx`.

**Files Touched**:

- `apps/studio/src/components/workflows/canvas/panels/StepLogItem.tsx` — new
- `apps/studio/src/components/workflows/canvas/panels/DebugFlowLog.tsx` — new
- `apps/studio/src/components/workflows/canvas/panels/WorkflowDebugPanel.tsx` — new
- `apps/studio/src/components/workflows/canvas/WorkflowCanvasPage.tsx` — swap panel
- `apps/studio/src/components/workflows/canvas/panels/ExecutionDebugPanel.tsx` — delete

**Exit Criteria**:

- [ ] Debug panel shows Input, Flow Log, and Output accordions (all expanded by default)
- [ ] Start node always appears as first item in Flow Log with input values
- [ ] Each step item is expandable with Input/Output sub-accordions (Monaco JSON, read-only, vs-dark)
- [ ] Metrics section shows initiated/completed timestamps and duration
- [ ] Elapsed time badge in header updates live during execution (blue pulse) and shows final time on completion (green)
- [ ] Panel slides in from right with 350ms animation
- [ ] Copy button copies output JSON to clipboard
- [ ] Code toggle button (`</>`) switches to full Monaco editor showing raw execution context JSON
- [ ] Code toggle is a local component toggle (does not persist in store)
- [ ] `pnpm build --filter=@agent-platform/studio` succeeds

**Test Strategy**:

- Unit: `stepsWithStart` memoized computation correctly prepends Start step
- Visual: Run a workflow and verify all accordions, step items, and Monaco editors render correctly

**Rollback**: Restore `ExecutionDebugPanel.tsx` from git, revert `WorkflowCanvasPage.tsx` swap.

---

### Phase 6: Monitor Tab — Slider with Debug Panel

**Goal**: Replace the monitor tab's inline row expansion with a right-side slider that renders the shared WorkflowDebugPanel.

**Tasks**:

6.1. Update `WorkflowMonitorTab.tsx`: remove inline `ExecutionRow` expansion logic. Add `selectedExecutionId` state. On row click, set `selectedExecutionId` and fetch execution detail.

6.2. Add `<SlidePanel>` (existing UI component) to `WorkflowMonitorTab.tsx` that renders `<WorkflowDebugPanel mode="monitor" executionData={...}>` when an execution is selected.

6.3. Add KPI summary bar above the grid using existing `MetricCard` component (from `components/ui/MetricCard.tsx` — has label, value, trend, icon props): Total runs, In progress, Response time (P90/P99), Failure rate. Calculate from execution list data.

6.4. Ensure the selected row is highlighted in the grid and the slider can be closed via close button, click outside, or Escape key.

6.5. Verify monitor grid columns match HLD Section 8.9 (Status, Name/ID, Duration, Started, Steps). Update column headers/order if they differ from the current `ExecutionRow` layout.

**Files Touched**:

- `apps/studio/src/components/workflows/tabs/WorkflowMonitorTab.tsx` — major refactor

**Exit Criteria**:

- [ ] Clicking a row in the execution history opens a 432px slider from the right
- [ ] Slider contains WorkflowDebugPanel in monitor mode (read-only, no re-run button)
- [ ] KPI bar shows total runs, in-progress count, P90/P99 response times, failure rate
- [ ] Selected row is visually highlighted
- [ ] Slider closes via close button, Escape, or clicking outside
- [ ] `pnpm build --filter=@agent-platform/studio` succeeds

**Test Strategy**:

- Visual: Click rows in monitor tab, verify slider opens with correct execution data

**Rollback**: Revert to inline expansion pattern from git history.

---

### Phase 7: Visual Polish

**Goal**: Apply the visual refinements from Section 10 of the spec — node shadows, edge styling, handle refinement, panel transitions, execution overlays.

**Tasks**:

7.1. Node visual refinement: three-tier shadow system (resting/hovered/selected), color header gradient, `animate-node-appear` on add, shrink-fade on delete.

7.2. Edge visual refinement: lighter default stroke (define `EDGE_DEFAULT_STROKE` constant, value `#cbd5e1`, 1.5px), `getSmoothStepPath` with `borderRadius: 12` (replace `getBezierPath`), draw-in animation on create, fade on delete. Selection drop-shadow.

7.3. Handle visual refinement: smaller resting size (10x10), scale 1.3 + color fill + glow ring on hover, connected vs unconnected visual distinction.

7.4. Panel transitions: debug panel slide-in (350ms) / slide-out (250ms), canvas width compression animation, config↔debug cross-fade.

7.5. Execution overlay animations: pending opacity, running pulse-ring, completed green flash, failed red + shake, edge traveling pulse.

7.6. Canvas background: softer dots (0.5 opacity, 0.8 size), radial gradient vignette.

7.7. Drag-and-drop polish: ghost preview node at 70% opacity, grid-snap ripple on drop.

7.8. Add `prefers-reduced-motion` support: all animations degrade to instant transitions.

7.9. Toolbar micro-animations (spec Section 10.6): save status text fade transitions, validation badge counter pulse on change, run button color crossfade between idle/executing states.

7.10. Selection & multi-select visual refinement (spec Section 10.8): custom lasso/marquee selection box styling (dashed border, semi-transparent fill), multi-node group outline on selection.

7.11. Dark mode overrides (spec Section 10.12): six color overrides for canvas background, node surfaces, edge strokes, handle colors, shadow intensities, and panel backgrounds. Studio currently uses light mode — these overrides ensure dark mode readiness via `dark:` Tailwind variants.

7.12. Create `canvas/styles/canvas-animations.css` for complex multi-step CSS keyframes (edge-draw, completion-flash, error-shake, edge-pulse-travel) that exceed Tailwind's `@keyframes` ergonomics. Import in `WorkflowCanvas.tsx`.

**Files Touched**:

- `apps/studio/src/components/workflows/canvas/nodes/WorkflowNodeComponent.tsx` — shadows, appear/exit
- `apps/studio/src/components/workflows/canvas/nodes/StartNodeComponent.tsx` — shadows
- `apps/studio/src/components/workflows/canvas/nodes/EndNodeComponent.tsx` — shadows
- `apps/studio/src/components/workflows/canvas/edges/WorkflowEdgeComponent.tsx` — smooth-step, styling
- `apps/studio/src/components/workflows/canvas/WorkflowCanvas.tsx` — background, drag polish, import animations CSS
- `apps/studio/src/components/workflows/canvas/WorkflowCanvasPage.tsx` — panel transitions
- `apps/studio/src/components/workflows/canvas/panels/CanvasToolbar.tsx` — micro-animations
- `apps/studio/src/components/workflows/canvas/styles/canvas-animations.css` — new, complex keyframes
- `apps/studio/tailwind.config.ts` — additional keyframes + dark mode overrides

**Exit Criteria**:

- [ ] Nodes have three-tier shadow (resting < hovered < selected) with smooth transitions
- [ ] Edges use smooth-step paths with rounded corners
- [ ] Handles scale up with color + glow on hover
- [ ] Debug panel slides in/out smoothly (no instant appear/disappear)
- [ ] Running nodes show pulsing blue ring; completed nodes flash green; failed nodes shake
- [ ] Canvas background has subtle vignette effect
- [ ] All animations disabled when `prefers-reduced-motion: reduce` is set
- [ ] Toolbar save status fades, validation badge pulses on change, run button crossfades
- [ ] Lasso selection has styled box; multi-select shows group outline
- [ ] Dark mode variants applied for all canvas surfaces
- [ ] `pnpm build --filter=@agent-platform/studio` succeeds

**Test Strategy**:

- Visual: Manual verification of all animations in dev server
- Accessibility: Test with `prefers-reduced-motion` enabled in browser dev tools

**Rollback**: Revert individual style changes. Animations are purely additive — removal doesn't break functionality.

---

### Phase 8: E2E Test Updates

**Goal**: Update all E2E tests to use the new interaction patterns.

**Tasks**:

8.1. Update `e2e/helpers/workflow-helpers.ts`: replace `addNodeViaQuickAdd(page, nodeType)` with `addNodeViaHandleMenu(page, sourceNodeName, handleId, nodeType)` — clicks the source node's handle plus icon, selects from context menu.

8.2. Update `e2e/workflow-canvas-uat.spec.ts`: replace all ~34 `addNodeViaQuickAdd` calls with `addNodeViaHandleMenu`. Remove assertions for `quick-add-bar`, `toolbar-save-btn`, `toolbar-deploy-btn`. Update tab assertions from "Steps" to "Flow".

8.3. Add new E2E tests: handle plus menu opens on hover, node delete button appears on hover, edge delete button appears on selection.

8.4. Update any workflow lifecycle E2E tests that reference removed elements.

**Files Touched**:

- `apps/studio/e2e/helpers/workflow-helpers.ts` — new helper function
- `apps/studio/e2e/workflow-canvas-uat.spec.ts` — update ~34 call sites
- `apps/studio/e2e/workflow-lifecycle.spec.ts` — update if references removed elements

**Exit Criteria**:

- [ ] All E2E tests pass with the new interaction patterns
- [ ] No references to `quick-add-bar`, `toolbar-save-btn`, `toolbar-deploy-btn` in E2E tests
- [ ] New E2E tests cover: handle plus menu, node delete, edge delete
- [ ] `pnpm test --filter=@agent-platform/studio` passes (unit + E2E)

**Test Strategy**:

- E2E: Run full E2E suite against dev server

**Rollback**: E2E tests are test-only changes — revert doesn't affect production code.

---

## 4. Wiring Checklist

- [ ] `HandlePlusMenu` imported and rendered inside `WorkflowNodeComponent` and `StartNodeComponent`
- [ ] `NodeDeleteButton` imported and rendered inside `WorkflowNodeComponent` and `EndNodeComponent`
- [ ] `EdgeDeleteButton` imported and rendered inside `WorkflowEdgeComponent`
- [ ] `WorkflowDebugPanel` imported in `WorkflowCanvasPage` (replacing `ExecutionDebugPanel`)
- [ ] `WorkflowDebugPanel` imported in `WorkflowMonitorTab` (inside `SlidePanel`)
- [ ] `DebugFlowLog` imported in `WorkflowDebugPanel`
- [ ] `StepLogItem` imported in `DebugFlowLog`
- [ ] `HandlePlusMenu` uses Radix Popover directly (matching `VariableNamespaceTagPopover.tsx` pattern)
- [ ] `animation.ts` constants imported in components that use timing values
- [ ] New Tailwind animations (`animate-slide-in-right`, `animate-node-appear`, etc.) registered in `tailwind.config.ts`
- [ ] `removeEdge` action added to store interface and implementation
- [ ] `canvasExpanded` state added to store; `saveStatus` derived from existing `isSaving`/`isDirty`; `isExecuting` derived from `currentExecutionId`
- [ ] `QuickAddBar` import removed from `WorkflowCanvasPage`
- [ ] `ExecutionDebugPanel` import removed from `WorkflowCanvasPage`
- [ ] `integration` added to `STUB_NODE_TYPES` in shared-kernel
- [ ] `canvas/styles/canvas-animations.css` imported in `WorkflowCanvas.tsx`
- [ ] E2E helper `addNodeViaHandleMenu` replaces all `addNodeViaQuickAdd` calls

---

## 5. Cross-Phase Concerns

### Database Migrations

None. All changes are client-side. Node positions are visual metadata transformed on load.

### Feature Flags

None. Ship directly on feature branch. Feature is ALPHA status.

### Configuration Changes

None. No new environment variables, config keys, or API changes.

### Package Dependencies

| Package                   | Status                    | Notes                                                                   |
| ------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `@radix-ui/react-popover` | May need explicit install | Likely transitive dep from other Radix packages; verify with `pnpm why` |
| `@monaco-editor/react`    | Already installed         | v4.6.0 in studio                                                        |
| `framer-motion`           | Already installed         | v12.31.0 in studio                                                      |
| `@xyflow/react`           | Already installed         | Verify `getSmoothStepPath` export exists in current version             |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] Canvas flows left-to-right with handles on Left (input) and Right (output)
- [ ] Existing workflows load with migrated horizontal positions
- [ ] Tab reads "Flow" (not "Steps")
- [ ] Toolbar shows: Back, Name, Badge, Save Status, Run, Expand/Collapse (no Save/Deploy/Zoom)
- [ ] QuickAddBar is gone; nodes added via handle context menu or sidebar drag
- [ ] Every output handle (on_success, on_failure, conditions, loop, human) shows plus icon on hover
- [ ] Clicking plus opens categorized node type popover; selecting creates node + auto-edge
- [ ] Hovering non-start nodes shows trash icon; clicking deletes (with confirmation if edges exist)
- [ ] Selecting an edge shows trash icon at midpoint; clicking or Delete key removes it
- [ ] Integration shows "Coming soon" in assets sidebar
- [ ] Run button directly starts execution when no input vars; shows modal only when inputs defined
- [ ] Debug panel has Input, Flow Log (with Start node), Output accordions with Monaco JSON
- [ ] Monitor tab row click opens 432px slider with shared debug panel
- [ ] All animations are smooth (150-350ms expo-out easing) and respect `prefers-reduced-motion`
- [ ] All existing E2E tests updated and passing
- [ ] `pnpm build` and `pnpm test` pass across all affected packages

---

## 7. Open Questions

1. **Radix Popover dependency**: Need to verify if `@radix-ui/react-popover` is already installed as transitive dependency or needs explicit `pnpm add`. Run `pnpm why @radix-ui/react-popover --filter=@agent-platform/studio` before Phase 3.

2. **getSmoothStepPath availability**: Need to verify this export exists in the installed `@xyflow/react` version. Check with `grep -r 'getSmoothStepPath' node_modules/@xyflow/` before Phase 7.

3. **Cancel execution API**: Verified — endpoint does NOT exist in `apps/studio/src/api/workflows.ts`. Stop button renders disabled with tooltip until backend implements it. API stub added for future wiring.

4. **i18n**: ~8 new components introduce hardcoded English strings. This is a known gap — consistent with existing codebase patterns (no i18n framework in use). Will be addressed when i18n is adopted platform-wide.
