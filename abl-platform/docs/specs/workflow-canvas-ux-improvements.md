# Workflow Canvas UX Improvements — UI Specification

**Status:** DRAFT
**Date:** 2026-03-30
**Branch:** KI081/feat/workflows

---

## Table of Contents

0. [Flow Direction: Left-to-Right](#0-flow-direction-left-to-right)
1. [Tab Rename: "Steps" -> "Flow"](#1-tab-rename-steps---flow)
2. [Canvas Header Refinement](#2-canvas-header-refinement)
3. [Remove Quick-Add Bar](#3-remove-quick-add-bar)
4. [Handle Hover: Plus Icon + Context Menu / Drag](#4-handle-hover-plus-icon--context-menu--drag)
5. [Node Hover: Trash Icon to Delete](#5-node-hover-trash-icon-to-delete)
6. [Edge Selection: Trash Icon + Keyboard Delete](#6-edge-selection-trash-icon--keyboard-delete)
7. [Assets Sidebar: Integration "Coming Soon"](#7-assets-sidebar-integration-coming-soon)
8. [Debug Console Redesign + Monitor Execution Detail](#8-debug-console-redesign--monitor-execution-detail)
9. [Run Behavior: Direct Debug Panel, Conditional Modal](#9-run-behavior-direct-debug-panel-conditional-modal)
10. [Visual Polish & Animation System](#10-visual-polish--animation-system)

---

## 0. Flow Direction: Left-to-Right

### Current State

The canvas flows **top-to-bottom**:

- Input handles (`<Handle type="target">`) are on `Position.Top`
- Output handles (`<Handle type="source">`) are on `Position.Bottom`
- Edges curve vertically from bottom of source to top of target

```
Current (top-to-bottom):

        ┌─────────┐
        │  Start  │
        └────┬────┘
             │
        ┌────┴────┐
        │  API    │
        └────┬────┘
             │
        ┌────┴────┐
        │  End    │
        └─────────┘
```

### New Layout: Left-to-Right

```
New (left-to-right):

  ┌─────────┐       ┌──────────────┐       ┌─────────┐
  │  Start  ├──────►│   API Node   ├──────►│   End   │
  └─────────┘       │              │       └─────────┘
                    ├─ on_failure ─┤
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │  Error Handler│
                    └──────────────┘
```

### Code Changes Required

#### 0.1 Node Components: Handle Position Changes

**All three node components** must change handle positions from Top/Bottom to Left/Right:

| Component               | File                                     | Handle Change                                                                                 |
| ----------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `StartNodeComponent`    | `canvas/nodes/StartNodeComponent.tsx`    | Source: `Position.Bottom` -> `Position.Right`                                                 |
| `EndNodeComponent`      | `canvas/nodes/EndNodeComponent.tsx`      | Target: `Position.Top` -> `Position.Left`                                                     |
| `WorkflowNodeComponent` | `canvas/nodes/WorkflowNodeComponent.tsx` | Target: `Position.Top` -> `Position.Left`, All sources: `Position.Bottom` -> `Position.Right` |

**StartNodeComponent changes:**

```tsx
// Before
<Handle type="source" position={Position.Bottom} id="on_success" ... />

// After
<Handle type="source" position={Position.Right} id="on_success" ... />
```

**EndNodeComponent changes:**

```tsx
// Before
<Handle type="target" position={Position.Top} ... />

// After
<Handle type="target" position={Position.Left} ... />
```

**WorkflowNodeComponent changes:**

```tsx
// Before: Input handle on top
<Handle type="target" position={Position.Top} ... />

// After: Input handle on left
<Handle type="target" position={Position.Left} ... />

// Before: Output handles on bottom, laid out horizontally
<div className="px-3 pb-2 flex flex-row items-end justify-center gap-4">
  {outputHandles.map((handle) => (
    <div className="flex flex-col items-center gap-0.5 relative">
      <span>{formatHandleLabel(handle)}</span>
      <Handle type="source" position={Position.Bottom} id={handle} ... />
    </div>
  ))}
</div>

// After: Output handles on right side, stacked vertically
<div className="absolute right-0 top-0 h-full flex flex-col items-end justify-center gap-3 pr-0 translate-x-0">
  {outputHandles.map((handle) => (
    <div className="flex flex-row items-center gap-1.5 relative">
      <span className="text-[10px] text-foreground-muted whitespace-nowrap">
        {formatHandleLabel(handle)}
      </span>
      <Handle type="source" position={Position.Right} id={handle} ... />
    </div>
  ))}
</div>
```

#### 0.2 Node Layout: Wider Cards for Horizontal Flow

With left-to-right flow, nodes need to accommodate output handle labels on the right side:

| Property              | Before                    | After                               |
| --------------------- | ------------------------- | ----------------------------------- |
| Min width             | `min-w-[200px]`           | `min-w-[220px]`                     |
| Output handle layout  | Horizontal row at bottom  | Vertical stack on right edge        |
| Handle label position | Above the handle dot      | Left of the handle dot              |
| Node card padding     | `pb-2` for bottom handles | `pr-8` for right-side handle labels |

**Node visual structure (left-to-right):**

```
         ┌─────────────────────────────────────────────┐
         │ ██████████████████████ (color bar, full top) │
  (in)●──│  ⚙ API Node                   on_success ●──(out)
         │                                on_failure ●──(out)
         └─────────────────────────────────────────────┘
```

- Input handle: centered vertically on the **left** edge
- Output handles: stacked vertically on the **right** edge, each with its label to the left
- Color bar: remains at top (full width)
- Content area: icon + label left-aligned, handle labels right-aligned

#### 0.3 Condition Node: Multiple Right-Side Outputs

Condition nodes have dynamic outputs (one per condition branch + `else`):

```
         ┌─────────────────────────────────────────────┐
         │ ██████████████████████ (color bar)           │
  (in)●──│  ⑂ Condition                  if age > 18 ●──►
         │                               if score < 5 ●──►
         │                                       else ●──►
         │                                on_failure ●--► (dashed, red)
         └─────────────────────────────────────────────┘
```

#### 0.4 Loop Node: Right-Side Outputs

```
         ┌─────────────────────────────────────────────┐
         │ ██████████████████████ (color bar)           │
  (in)●──│  ↻ Loop                        loop_body ●──►
         │                              on_complete ●──►
         │                              on_failure ●--► (dashed, red)
         └─────────────────────────────────────────────┘
```

#### 0.5 Human Node: Right-Side Outputs

```
         ┌─────────────────────────────────────────────┐
         │ ██████████████████████ (color bar)           │
  (in)●──│  👤 Human Review              on_approval ●──►
         │                              on_decline ●--► (dashed, red)
         │                              on_timeout ●--► (dashed, red)
         │                              on_failure ●--► (dashed, red)
         └─────────────────────────────────────────────┘
```

#### 0.6 Start / End Pill Nodes

**Start node** (pill shape):

```
  ┌──────────────┐
  │  🚩 Start    ●──► (on_success)
  └──────────────┘
```

- No left input handle (entry point)
- Single right output handle

**End node** (pill shape):

```
         ┌──────────────┐
  ──► ●──│  ■ End       │
         └──────────────┘
```

- Single left input handle
- No right output handles

#### 0.7 ReactFlow Configuration

**File:** `apps/studio/src/components/workflows/canvas/WorkflowCanvas.tsx`

Update the `<ReactFlow>` default edge options and layout hints:

```tsx
<ReactFlow
  ...
  defaultEdgeOptions={{
    type: 'workflowEdge',
    // Edges now flow left-to-right
  }}
  fitView
  fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
  ...
>
```

#### 0.8 Edge Routing

**File:** `apps/studio/src/components/workflows/canvas/edges/WorkflowEdgeComponent.tsx`

The `getBezierPath` call already receives `sourcePosition` and `targetPosition` from ReactFlow, which are derived from the Handle positions. No change needed in the edge component itself — the position change in handles automatically routes edges horizontally.

#### 0.9 Auto-Layout (Node Positioning)

When adding nodes via the context menu (Section 4) or sidebar drop, position calculation changes:

| Property                 | Before (top-to-bottom) | After (left-to-right)                              |
| ------------------------ | ---------------------- | -------------------------------------------------- |
| New node X               | Same as source         | Source X + 250px (node width + gap)                |
| New node Y               | Source Y + 150px       | Same as source (or staggered for multiple outputs) |
| Multiple outputs stagger | Horizontal spread      | Vertical spread (Y offset per output)              |

**Stagger logic for condition/loop fan-out:**

When a node has N output handles and all connect to new nodes, space them vertically:

```
                                     ┌──────────┐
                              ──────►│  Branch A │  Y = sourceY - ((N-1)/2 * 80)
                             │       └──────────┘
  ┌─────────────┐            │       ┌──────────┐
  │  Condition  ├────────────┼──────►│  Branch B │  Y = sourceY
  └─────────────┘            │       └──────────┘
                             │       ┌──────────┐
                              ──────►│  Else     │  Y = sourceY + ((N-1)/2 * 80)
                                     └──────────┘
```

Vertical gap: `80px` per output branch.

#### 0.10 MiniMap Orientation

No code change needed — MiniMap auto-reflects the node positions.

#### 0.11 Migration: Existing Workflow Positions

For workflows saved with top-to-bottom positions, apply a one-time migration when loading:

```ts
function migrateToHorizontalLayout(nodes: Node[]): Node[] {
  // Detect if layout is vertical (most nodes share similar X, vary in Y)
  const isVertical = detectVerticalLayout(nodes);
  if (!isVertical) return nodes; // Already horizontal or manual layout

  // Swap X/Y and scale
  return nodes.map((node) => ({
    ...node,
    position: {
      x: node.position.y * 1.5, // Spread horizontally (nodes are wider than tall)
      y: node.position.x,
    },
  }));
}
```

This is a best-effort transform. Users can re-arrange manually after migration. The `fitView` on load will center the migrated layout.

---

## 1. Tab Rename: "Steps" -> "Flow"

### Current State

**File:** `apps/studio/src/components/workflows/WorkflowDetailPage.tsx:60`

```tsx
{ id: 'steps', label: 'Steps', icon: <ListOrdered className="w-4 h-4" /> },
```

The `WORKFLOW_TABS` constant defines 6 tabs: Overview, **Steps**, Triggers, Monitor, Errors, Notifications.

### Required Change

| Property | Before          | After                            |
| -------- | --------------- | -------------------------------- |
| `id`     | `steps`         | `flow`                           |
| `label`  | `Steps`         | `Flow`                           |
| `icon`   | `<ListOrdered>` | `<Workflow>` (from lucide-react) |

### Impact

- Route changes from `…/steps` to `…/flow` — ensure redirect/alias for bookmarked URLs
- Update all `data-testid` references containing `steps-tab`
- Update the `ContextExplorer.tsx:556` sidebar category label from "Steps" to "Nodes" (contextually more accurate within the flow canvas)

---

## 2. Canvas Header Refinement

### Current State

**File:** `apps/studio/src/components/workflows/canvas/panels/CanvasToolbar.tsx`

Current layout (left to right):

```
[Back] [Run] [Save] [Saved ✓]  ...  [Workflow Name] [Validation Badge]  ...  [Zoom Out] [Zoom In] [Deploy]
```

### New Layout

```
[Back]  [Workflow Name] [Validation Badge]  ···spacing···  [Saving status] [Run ▶] [Expand/Collapse ⤢]
```

Everything right-aligned after the workflow name, in this exact order:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ← Back    Workflow Name  ⚠ 2 errors        All changes saved   ▶ Run   ⤢  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Detailed Changes

#### 2.1 Move Expand/Collapse to rightmost position

| Property    | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Position    | Rightmost element in toolbar                                           |
| data-testid | `toolbar-expand-collapse-btn`                                          |
| Icon        | `<Maximize2>` (collapsed) / `<Minimize2>` (expanded) from lucide-react |
| Behavior    | Toggles between full-viewport canvas mode and normal tabbed layout     |
| Tooltip     | "Expand canvas" / "Collapse canvas"                                    |
| Size        | `btn-icon size-xs` (consistent with other toolbar buttons)             |

Implementation: Call `fitView()` from `useReactFlow()` after toggling to re-center content.

#### 2.2 Move Run button right-aligned, immediately left of Expand/Collapse

| Property    | Before            | After                                                        |
| ----------- | ----------------- | ------------------------------------------------------------ |
| Position    | Left section      | Right section, second from right                             |
| data-testid | `toolbar-run-btn` | `toolbar-run-btn` (unchanged)                                |
| Style       | Standard button   | Primary button with play icon `<Play className="w-4 h-4" />` |
| Label       | "Run"             | "Run" (keep text + icon)                                     |

#### 2.3 Remove Save button

**Delete entirely.** The workflow auto-saves on every change. The save button (`toolbar-save-btn`) and its loading state are removed.

Ensure auto-save is wired correctly:

- `useWorkflowCanvasStore` already persists on node/edge mutations
- Verify debounced save fires on: node add, node delete, node move, node config change, edge add, edge delete

#### 2.4 Move saving status right-aligned, left of Run

| Property    | Value                                         |
| ----------- | --------------------------------------------- |
| Position    | Right section, third from right (left of Run) |
| data-testid | `toolbar-save-status`                         |
| States      | `saving` / `saved` / `error`                  |
| Display     | Subtle text, no button chrome                 |

State rendering:

| State    | Display                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| `saving` | `<Loader2 className="animate-spin w-3 h-3" />` + "Saving..." (text-foreground-muted)                                 |
| `saved`  | `<Check className="w-3 h-3" />` + "All changes saved" (text-foreground-muted) — fades out after 3s                   |
| `error`  | `<AlertCircle className="w-3 h-3 text-destructive" />` + "Save failed" (text-destructive) — persists until next save |

#### 2.5 Remove Deploy button

**Delete entirely.** Remove `toolbar-deploy-btn` and any associated deploy panel/dialog.

#### 2.6 Remove Zoom In / Zoom Out buttons

**Delete entirely.** Users use:

- Scroll wheel / trackpad pinch to zoom
- ReactFlow's built-in `<Controls>` component (already at bottom-right) for zoom controls
- `fitView` on the Expand/Collapse toggle

#### Summary: Elements Removed

| Element         | data-testid          | Action |
| --------------- | -------------------- | ------ |
| Save button     | `toolbar-save-btn`   | Remove |
| Deploy button   | `toolbar-deploy-btn` | Remove |
| Zoom In button  | (none)               | Remove |
| Zoom Out button | (none)               | Remove |

#### Summary: Elements Added/Moved

| Element         | data-testid                   | Position             |
| --------------- | ----------------------------- | -------------------- |
| Save status     | `toolbar-save-status`         | Right, 3rd from edge |
| Run button      | `toolbar-run-btn`             | Right, 2nd from edge |
| Expand/Collapse | `toolbar-expand-collapse-btn` | Rightmost            |

---

## 3. Remove Quick-Add Bar

### Current State

**File:** `apps/studio/src/components/workflows/canvas/panels/QuickAddBar.tsx`

A horizontal bar at the bottom of the canvas with 16 node-type buttons (data-testid="quick-add-bar").

### Required Change

- **Delete** `QuickAddBar.tsx` entirely
- **Remove** its usage from `WorkflowCanvasPage.tsx` (currently rendered at the bottom of the canvas layout)
- Node addition is now exclusively via:
  1. **Assets Sidebar** (drag-and-drop from left panel)
  2. **Handle context menu** (see Section 4 below)

---

## 4. Handle Hover: Plus Icon + Context Menu / Drag

### Current State

**File:** `apps/studio/src/components/workflows/canvas/nodes/WorkflowNodeComponent.tsx:139-163`

Output handles are rendered as plain `<Handle type="source">` elements with labels like "on success", "on failure", "if ...", "else", "loop body", "on approval", "on decline", "on timeout". No hover interaction beyond the default ReactFlow connect-by-drag behavior.

### New Behavior

**Every output handle** — regardless of its label — gets the same plus-icon hover experience. This includes:

| Handle type        | Appears on                | Examples                              |
| ------------------ | ------------------------- | ------------------------------------- |
| `on_success`       | All standard nodes, Start | API, Function, Text-to-Text, etc.     |
| `on_failure`       | All standard nodes        | Red/dashed styling preserved          |
| Condition branches | Condition node            | `if age > 18`, `if score < 5`, `else` |
| `loop_body`        | Loop node                 | —                                     |
| `on_complete`      | Loop node                 | —                                     |
| `on_approval`      | Human node                | —                                     |
| `on_decline`       | Human node                | Red/dashed styling preserved          |
| `on_timeout`       | Human node                | Red/dashed styling preserved          |

When the user hovers over **any** of these output handles (now on the **right side** of the node per Section 0), a **plus icon** appears with a smooth transition. This plus icon supports two interactions: **click** (context menu) and **drag** (dummy edge).

#### 4.1 Hover Appearance (Left-to-Right Layout)

```
  ┌─────────────────────────────────────────┐
  │  ⚙ API Node                             │
  │                           on success ●──[+]    <-- hover: plus fades in
  │                           on failure ●──[+]    <-- same on every handle
  └─────────────────────────────────────────┘
```

For a condition node with multiple branches:

```
  ┌─────────────────────────────────────────┐
  │  ⑂ Condition                            │
  │                         if age > 18 ●──[+]
  │                        if score < 5 ●──[+]
  │                                else ●──[+]
  │                          on failure ●──[+]   (red handle, same [+] behavior)
  └─────────────────────────────────────────┘
```

| Property              | Value                                                          |
| --------------------- | -------------------------------------------------------------- |
| data-testid           | `handle-plus-${nodeId}-${handleId}`                            |
| Icon                  | `<Plus className="w-3.5 h-3.5" />` from lucide-react           |
| Container             | 20x20px circle, bg-background, border border-border, shadow-sm |
| Position              | Centered to the **right** of the handle dot, offset 8px right  |
| Transition            | `opacity 0->1, scale 0.8->1` over `150ms ease-out`             |
| Hover state           | `bg-primary text-primary-foreground` (blue highlight)          |
| Failure handles hover | `bg-destructive text-destructive-foreground` (red highlight)   |
| Cursor                | `pointer`                                                      |

The plus icon inherits the handle's semantic color on hover:

- Normal handles (on_success, conditions, loop_body, on_approval, on_complete): **blue** highlight
- Failure handles (on_failure, on_decline, on_timeout): **red** highlight

CSS approach:

```css
.handle-plus-trigger {
  opacity: 0;
  transform: scale(0.8) translateX(-4px);
  transition:
    opacity 150ms ease-out,
    transform 150ms ease-out;
  pointer-events: none;
  position: absolute;
  left: calc(100% + 4px); /* Right of the handle dot */
  top: 50%;
  transform-origin: left center;
}

.handle-wrapper:hover .handle-plus-trigger,
.handle-plus-trigger:hover {
  opacity: 1;
  transform: scale(1) translateX(0);
  pointer-events: all;
}
```

#### 4.2 Click Interaction: Context Menu

Clicking the plus icon opens a **context menu** (popover) listing available node types the user can add. Adding a node automatically creates an edge from the clicked source handle to the new node's input (left-side) handle.

```
  on success ●──[+]  <-- click
                  │
             ┌────────────────┐
             │ ▸ AI           │
             │   Text to Text │
             │   Text to Image│
             │   ...          │
             │ ▸ Actions      │
             │   API          │
             │   Function     │
             │   ...          │
             │ ▸ Flow Control │
             │   Condition    │
             │   Loop         │
             │   ...          │
             └────────────────┘
```

| Property        | Value                                                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| data-testid     | `handle-context-menu`                                                                                                                                                                                                                          |
| Component       | Popover (Radix `<Popover>`) anchored to the plus icon, opens to the right                                                                                                                                                                      |
| Width           | 220px                                                                                                                                                                                                                                          |
| Max height      | 320px, scrollable                                                                                                                                                                                                                              |
| Categories      | Same as AssetsSidebar: AI, Actions, Data, Human, Agent, Flow Control                                                                                                                                                                           |
| Category toggle | Collapsible sections with chevron                                                                                                                                                                                                              |
| Disabled items  | Stub types (`browser`, `doc_search`, `doc_intelligence`, `integration`) show "Coming soon" badge, not clickable                                                                                                                                |
| On select       | 1. Create new node positioned **250px to the right** of source node (staggered vertically if multiple handles), 2. Create edge from `{sourceHandle}` to new node's left-side input, 3. Close popover, 4. Select new node, 5. Open config panel |

**Example: Adding a node from a condition branch:**

```
Before:
  ┌──────────────┐
  │  Condition   ├─ if age > 18 ●──[+]  <-- user clicks [+]
  │              ├─ else ●
  └──────────────┘

After selecting "API" from context menu:
  ┌──────────────┐                    ┌──────────┐
  │  Condition   ├─ if age > 18 ●────►●  API     │  (auto-connected + selected)
  │              ├─ else ●            └──────────┘
  └──────────────┘
```

#### 4.3 Drag Interaction: Dummy Edge

Dragging from the plus icon (or from the handle directly — preserving existing ReactFlow behavior) shows a **dummy/preview edge** that follows the cursor **horizontally**, allowing the user to connect to an existing node's left-side input handle.

| Property               | Value                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| Edge style during drag | Dashed stroke, `stroke: #3b82f6` (blue), `strokeDasharray: '6 4'`, `strokeWidth: 2`          |
| Drag direction hint    | Edge curves naturally from right to left (source Right -> target Left)                       |
| Valid target highlight | Target handle (left side of nodes) glows with `ring-2 ring-primary` when hovered during drag |
| Invalid target         | Cursor shows `not-allowed`, no highlight                                                     |
| On drop (no target)    | Show the same context menu at drop position — user can add a new node there                  |
| On drop (valid target) | Create edge connection (standard ReactFlow `onConnect`)                                      |

**Drag from failure handle:**

The dummy edge uses the failure handle's styling — red dashed stroke instead of blue:

| Source handle                                | Drag edge color  | Dash pattern |
| -------------------------------------------- | ---------------- | ------------ |
| Normal (on_success, conditions, etc.)        | `#3b82f6` (blue) | `6 4` dashed |
| Failure (on_failure, on_decline, on_timeout) | `#ef4444` (red)  | `6 4` dashed |

---

## 5. Node Hover: Trash Icon to Delete

### Current State

Nodes have no visible delete affordance on hover. Deletion is only possible via keyboard (Backspace/Delete when selected) or context menu.

### New Behavior

When hovering over any node (except `start`), a **trash icon** appears at the top-right corner of the node card.

```
              ┌──────────────────────────────[🗑]─┐
   ──► ●──   │  ⚙ API Node          on_success ●──►
              │                      on_failure ●--►
              └───────────────────────────────────┘
```

| Property    | Value                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| data-testid | `node-delete-${nodeId}`                                                  |
| Icon        | `<Trash2 className="w-3.5 h-3.5" />` from lucide-react                   |
| Container   | 24x24px circle, `bg-background border border-border shadow-sm`           |
| Position    | Absolute, top: -8px, right: -8px (overlapping the node card corner)      |
| Transition  | `opacity 0->1, scale 0.8->1` over `150ms ease-out` (same as handle plus) |
| Hover state | `bg-destructive text-destructive-foreground` (red)                       |
| Cursor      | `pointer`                                                                |
| Hidden for  | `start` node (always present, cannot be deleted)                         |

**On click:**

1. If node has connected edges, show a confirmation tooltip: "Delete node and X connection(s)?" with [Delete] [Cancel] buttons
2. If node has no edges, delete immediately
3. Remove node and all connected edges
4. Trigger auto-save

**Keyboard shortcut** (existing, unchanged): Backspace / Delete when node is selected.

---

## 6. Edge Selection: Trash Icon + Keyboard Delete

### Current State

**File:** `apps/studio/src/components/workflows/canvas/edges/WorkflowEdgeComponent.tsx`

Selected edges get blue stroke styling but have no delete affordance beyond keyboard shortcuts.

### New Behavior

When an edge is **selected** (clicked), a **trash icon** appears at the midpoint of the edge path.

```
  ┌──────────┐              ┌──────────┐
  │  Node A  ├────── [🗑] ──────►│  Node B  │
  └──────────┘   (midpoint)      └──────────┘
```

| Property     | Value                                                             |
| ------------ | ----------------------------------------------------------------- |
| data-testid  | `edge-delete-${edgeId}`                                           |
| Rendered via | `<EdgeLabelRenderer>` (already used for edge labels)              |
| Icon         | `<Trash2 className="w-3.5 h-3.5" />` from lucide-react            |
| Container    | 24x24px circle, `bg-background border border-border shadow-sm`    |
| Position     | Midpoint of bezier path (`labelX`, `labelY` from `getBezierPath`) |
| Visibility   | Only when `selected === true`                                     |
| Transition   | `opacity 0->1, scale 0.8->1` over `150ms ease-out`                |
| Hover state  | `bg-destructive text-destructive-foreground` (red)                |
| Cursor       | `pointer`                                                         |

**On click:** Delete edge immediately (no confirmation — edges are lightweight).

**Keyboard shortcut:** When edge is selected, pressing `Backspace` or `Delete` removes it.

Implementation: Add `onKeyDown` handler to the canvas or use ReactFlow's `deleteKeyCode` prop:

```tsx
<ReactFlow
  deleteKeyCode={['Backspace', 'Delete']}
  ...
/>
```

---

## 7. Assets Sidebar: Integration "Coming Soon"

### Current State

**File:** `apps/studio/src/components/workflows/canvas/panels/AssetsSidebar.tsx:78-80`

Stub types with "Coming soon" badge: `browser`, `doc_search`, `doc_intelligence`.

**File:** `packages/shared-kernel/src/types/workflow-types.ts:29`

```ts
export const STUB_NODE_TYPES: WorkflowNodeType[] = ['browser', 'doc_search', 'doc_intelligence'];
```

### Required Change

Add `integration` to the stub types list:

```ts
export const STUB_NODE_TYPES: WorkflowNodeType[] = [
  'browser',
  'doc_search',
  'doc_intelligence',
  'integration', // <-- add
];
```

This single change propagates to:

| Location                    | Effect                                        |
| --------------------------- | --------------------------------------------- |
| `AssetsSidebar.tsx`         | Shows "Coming soon" badge, item not draggable |
| `QuickAddBar.tsx`           | N/A (being removed per Section 3)             |
| Handle context menu         | Shows "Coming soon" badge, not selectable     |
| `WorkflowNodeComponent.tsx` | Shows "Coming soon" overlay if somehow added  |

---

## 8. Debug Console Redesign + Monitor Execution Detail

### Overview

The debug panel serves two contexts with the **same component**:

| Context            | Where                                                          | How it opens                                  |
| ------------------ | -------------------------------------------------------------- | --------------------------------------------- |
| **Canvas debug**   | Right panel in workflow canvas (`ExecutionDebugPanel.tsx`)     | After clicking "Run" and execution starts     |
| **Monitor detail** | Right panel / slider in Monitor tab (`WorkflowMonitorTab.tsx`) | Clicking a row in the execution history table |

Both contexts render the **same `<WorkflowDebugPanel>`** component with identical structure. The monitor tab currently shows inline expansion — this will be replaced with the shared debug panel in a right slider.

### 8.1 Debug Panel Component Structure

**Component:** `<WorkflowDebugPanel>` (replaces current `ExecutionDebugPanel`)

```
┌─────────────────────────────────────────────────┐
│ HEADER                                          │
│ ┌─────────────────────────────────────────────┐ │
│ │ Run                    ⏱ 1s 882ms  [</>] [⤢] [✕] │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ ┌─ Input ─────────────────────── [expanded] ──┐ │
│ │ No input variable defined                   │ │
│ │  (or JSON editor with input vars)           │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ ┌─ Flow Log ──────────────────── [expanded] ──┐ │
│ │ ✅ Start ............................ 0ms    │ │
│ │ ✅ GmailIntegration0001 ......... 1s 646ms  │ │
│ │    └─ 200 - Request accepted                │ │
│ │    └─ ▸ Input   ▸ Output                    │ │
│ │    └─ Metrics: initiated/completed/duration  │ │
│ │ ✅ End0001 .......................... 0ms    │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ ┌─ Output ─────────────────────── [expanded] ─┐ │
│ │ ⏱ 1s 882ms                          [copy]  │ │
│ │ ┌─────────────────────────────────────────┐  │ │
│ │ │ {                              [expand]  │  │ │
│ │ │   "startTime": "...",          [copy]    │  │ │
│ │ │   "endTime": "...",                      │  │ │
│ │ │   "elapsedTime": 1882,                   │  │ │
│ │ │   "output": { ... }                      │  │ │
│ │ │ }                                        │  │ │
│ │ └─────────────────────────────────────────┘  │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### 8.2 Panel Header

```
<div data-testid="debug-panel-header" class="property-panel-header">
  ├── <span class="panel-title"> "Run" </span>
  └── <div class="header-actions">
        ├── Elapsed Time badge
        ├── Debugger Code toggle
        ├── Expand panel button
        └── Close panel button
```

| Element      | data-testid          | Description                                                                                                                                   |
| ------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Title        | `debug-panel-title`  | "Run" (static label)                                                                                                                          |
| Elapsed time | `debug-elapsed-time` | Clock icon + formatted duration. Class: `elapsed-time-success` (green) / `elapsed-time-error` (red) / `elapsed-time-running` (blue, animated) |
| Code toggle  | `debug-code-toggle`  | Toggles Context Object panel. Icon: `<Code2>`, blue (`text-primary`) when active                                                              |
| Expand       | `debug-expand-btn`   | Expands panel to full width. Icon: `<Maximize2>`                                                                                              |
| Close        | `debug-close-btn`    | Closes the debug panel. Icon: `<X>`                                                                                                           |

**Elapsed time states:**

| Execution status    | Class                  | Color              | Extra                                |
| ------------------- | ---------------------- | ------------------ | ------------------------------------ |
| Running             | `elapsed-time-running` | `text-primary`     | Animated pulse, counter incrementing |
| Completed (success) | `elapsed-time-success` | `text-success`     | Static final time                    |
| Failed              | `elapsed-time-error`   | `text-destructive` | Static time at failure               |

### 8.3 Input Accordion

```
<div data-testid="debug-input-accordion">
  └── Collapsible, expanded by default
       ├── Header: "Input"
       └── Body:
            ├── (if no input vars) Empty state illustration + "No input variable defined"
            └── (if input vars) JSON key-value display or read-only code editor
```

| Property      | Value                                                                        |
| ------------- | ---------------------------------------------------------------------------- |
| data-testid   | `debug-input-accordion`                                                      |
| Default state | Expanded                                                                     |
| Empty state   | Centered illustration + muted text                                           |
| With data     | Read-only Monaco editor (JSON, `vs-dark` theme) or structured key-value list |

### 8.4 Flow Log Accordion

```
<div data-testid="debug-flow-log-accordion">
  └── Collapsible, expanded by default
       ├── Header: "Flow log"
       └── Body: <DebugFlowLog>
            ├── StepLogItem (Start)
            ├── StepLogItem (Integration node)
            └── StepLogItem (End)
```

#### StepLogItem Structure

Each step in the flow log is a collapsible item:

```
<div data-testid="debug-step-${stepName}">
  ├── Header (always visible):
  │   ├── Status icon (success ✅ / error ❌ / running 🔄 / skipped ⊘)
  │   ├── Node type icon (flag, link, stop-circle, etc.)
  │   ├── Step name (truncated with tooltip)
  │   ├── Elapsed time (right-aligned)
  │   └── Collapse/expand chevron
  └── Body (expanded):
       ├── Status code (integration nodes only): "200 - Request accepted"
       │   Class: success-status / error-status
       ├── Input sub-accordion (collapsed by default)
       │   └── Monaco editor (JSON, read-only)
       ├── Output sub-accordion (collapsed by default)
       │   └── Monaco editor (JSON, read-only)
       └── Metrics:
            ├── "Initiated on" : timestamp
            ├── "Completed on" : timestamp
            └── "Total time taken" : duration
```

| Property             | Value                               |
| -------------------- | ----------------------------------- |
| data-testid (item)   | `debug-step-${stepName}`            |
| data-testid (header) | `debug-step-header-${stepName}`     |
| data-testid (body)   | `debug-step-body-${stepName}`       |
| Expand/collapse      | Click header to toggle              |
| Default state        | Collapsed (user expands to inspect) |

**Status icons:**

| Status  | Icon                                 | Color                             |
| ------- | ------------------------------------ | --------------------------------- |
| Success | `<CheckCircle2>`                     | `text-success` (#12B76A)          |
| Failed  | `<XCircle>`                          | `text-destructive` (#ef4444)      |
| Running | `<Loader2 className="animate-spin">` | `text-primary` (#3b82f6)          |
| Skipped | `<MinusCircle>`                      | `text-foreground-muted` (#98A2B3) |
| Waiting | `<Clock>`                            | `text-warning` (#F79009)          |

**Node type icons:**

| Node type    | Icon              | Notes |
| ------------ | ----------------- | ----- |
| start        | `<Flag>`          | —     |
| end          | `<StopCircle>`    | —     |
| integration  | `<Link>`          | —     |
| api          | `<Globe>`         | —     |
| function     | `<Code2>`         | —     |
| condition    | `<GitBranch>`     | —     |
| loop         | `<Repeat>`        | —     |
| human        | `<UserCheck>`     | —     |
| text_to_text | `<MessageSquare>` | —     |
| delay        | `<Timer>`         | —     |

**Metrics section:**

| Field            | data-testid              | Format                           |
| ---------------- | ------------------------ | -------------------------------- |
| Initiated on     | `debug-metric-initiated` | `YYYY-MM-DD HH:mm:ss`            |
| Completed on     | `debug-metric-completed` | `YYYY-MM-DD HH:mm:ss`            |
| Total time taken | `debug-metric-duration`  | Human-readable (e.g. "1s 646ms") |

### 8.5 Output Accordion

```
<div data-testid="debug-output-accordion">
  └── Collapsible, expanded by default
       ├── Header: "Output" + [Copy button]
       └── Body:
            ├── Time summary: clock icon + total elapsed
            └── Code editor container:
                 ├── Actions: [Expand] [Copy]
                 └── Monaco editor (JSON, vs-dark, read-only)
```

| Property      | Value                                                                 |
| ------------- | --------------------------------------------------------------------- |
| data-testid   | `debug-output-accordion`                                              |
| Copy button   | data-testid `debug-output-copy` — copies full JSON to clipboard       |
| Expand button | data-testid `debug-output-expand` — opens editor in modal/full-screen |
| Editor        | Monaco, language `json`, theme `vs-dark`, readOnly, font: Menlo 10px  |

**Output JSON structure:**

```json
{
  "startTime": "2026-03-30T21:21:23.000Z",
  "endTime": "2026-03-30T21:21:25.000Z",
  "elapsedTime": 1882,
  "inputTokens": 0,
  "outputTokens": 0,
  "totalTokens": 0,
  "cfId": "cfp-...",
  "processMeta": {},
  "output": { ... }
}
```

### 8.6 Context Object Panel (Code Toggle)

When the debugger code toggle (`debug-code-toggle`) is active, a **secondary panel** appears alongside the debug panel:

```
<div data-testid="debug-context-panel">
  ├── Header:
  │   ├── Tab: "Context object"
  │   ├── Copy button
  │   └── Close button
  └── Body:
       └── Monaco editor (JSON, vs-dark, read-only)
            └── Shows the full execution context/state object
```

This panel shows the runtime context available at each step, useful for debugging variable resolution and data flow.

### 8.7 Monitor Tab Integration

The Monitor tab (`WorkflowMonitorTab.tsx`) currently shows inline row expansion. This is replaced with the shared debug panel in a right slider.

#### Current Monitor Tab Layout (unchanged parts)

```
┌─────────────────────────────────────────────────────────────────┐
│ Workflow monitor                                                │
│ Monitor your workflow's performance across runs                 │
│                                          [Search] [Calendar] [Filter] │
├─────────────────────────────────────────────────────────────────┤
│ [All runs]  [Model runs]                                        │
├─────────────────────────────────────────────────────────────────┤
│ Total runs: 31  |  In progress: --  |  P90: 1s 717ms  P99: 3s  |  Failure: -- │
├─────────────────────────────────────────────────────────────────┤
│ ┌─── All Runs Grid ───────────────────────────────────────────┐ │
│ │ Run ID │ Status │ Response │ Nodes │ Start │ End │ Type │ Source │
│ │ cfp-.. │ ✅ Suc │ 1s 454ms│   3   │ Mar 30│ ... │ Sched│ Time.. │
│ │ cfp-.. │ ✅ Suc │ 1s 463ms│   3   │ Mar 29│ ... │ Sched│ Time.. │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

#### New: Row Click Opens Debug Panel Slider

**When a user clicks a row** in the monitor grid, a right-side slider opens with the shared `<WorkflowDebugPanel>` component, showing that execution's debug data.

```
┌────────────── Monitor Tab ──────────────┬──── Debug Slider ────────┐
│                                         │ Run              1s 882ms│
│  Run ID │ Status │ Response │ ...       │                          │
│  cfp-.. │ ✅     │ 1s 454ms │ ...  ──▶ │ ┌─ Input ─────────────┐  │
│  cfp-.. │ ✅     │ 1s 463ms │ ...       │ │ No input defined    │  │
│  cfp-.. │ ✅     │ 1s 650ms │ ...       │ └─────────────────────┘  │
│                                         │ ┌─ Flow Log ──────────┐  │
│                                         │ │ ✅ Start     0ms    │  │
│                                         │ │ ✅ Gmail   1s 646ms │  │
│                                         │ │ ✅ End       0ms    │  │
│                                         │ └─────────────────────┘  │
│                                         │ ┌─ Output ────────────┐  │
│                                         │ │ { ... JSON ... }    │  │
│                                         │ └─────────────────────┘  │
└─────────────────────────────────────────┴──────────────────────────┘
```

**Slider properties:**

| Property      | Value                                                         |
| ------------- | ------------------------------------------------------------- |
| data-testid   | `monitor-execution-slider`                                    |
| Width         | 432px (matches reference design), resizable via drag handle   |
| Open trigger  | Click any row in the All Runs grid                            |
| Close trigger | Click close button, click outside, or press Escape            |
| Drag handle   | Left edge with chevron-left icon (same as canvas debug panel) |
| Selected row  | Highlighted in the grid with `ag-row-selected` styling        |
| Animation     | Slide in from right, 200ms ease-out                           |

**Data flow:**

1. User clicks a row -> `selectedExecutionId` state is set
2. Fetch execution detail via API: `GET /api/projects/:projectId/workflows/:workflowId/executions/:executionId`
3. Pass execution data to `<WorkflowDebugPanel executionData={data} mode="monitor" />`
4. Panel renders identically to the canvas debug panel

**Component prop interface:**

```tsx
interface WorkflowDebugPanelProps {
  /** Execution data to display */
  executionData: WorkflowExecutionDetail;
  /** Context: 'canvas' shows run controls, 'monitor' is read-only */
  mode: 'canvas' | 'monitor';
  /** Close handler */
  onClose: () => void;
  /** Expand handler */
  onExpand?: () => void;
}
```

Mode differences:

| Feature        | Canvas mode                        | Monitor mode                   |
| -------------- | ---------------------------------- | ------------------------------ |
| Re-run button  | Shown (re-execute with same input) | Hidden                         |
| Live updates   | Yes (polling/SSE while running)    | No (static data)               |
| Input editing  | Editable before run                | Read-only                      |
| Panel position | Fixed right panel in canvas layout | Slider overlay on monitor grid |

### 8.8 Monitor KPI Summary Bar

Rendered above the grid (see Section 8.7 layout). These KPIs come from the aggregated execution data:

| KPI               | data-testid             | Format             | States                                                          |
| ----------------- | ----------------------- | ------------------ | --------------------------------------------------------------- |
| Total runs        | `monitor-total-runs`    | Integer            | —                                                               |
| Total in progress | `monitor-in-progress`   | Integer or `--`    | —                                                               |
| Response time     | `monitor-response-time` | P90 + P99 badges   | P90: `success` class (green), P99: `error` class if > threshold |
| Failure rate      | `monitor-failure-rate`  | Percentage or `--` | Red if > 0%                                                     |

### 8.9 Monitor Grid Columns

| col-id          | Header         | Width | Sort               | Cell renderer                                                                  |
| --------------- | -------------- | ----- | ------------------ | ------------------------------------------------------------------------------ |
| `runId`         | Run ID         | 116px | Yes                | Bold text, UUID format `cfp-...`                                               |
| `status`        | Status         | 140px | Yes                | Badge: `Success` (green), `Failed` (red), `Running` (blue), `Cancelled` (gray) |
| `responseTime`  | Response time  | 116px | Yes                | Formatted duration                                                             |
| `nodesExecuted` | Nodes executed | 116px | Yes                | Integer                                                                        |
| `startTime`     | Start time     | 116px | Yes (default desc) | `MMM DD, YYYY HH:mm A`                                                         |
| `endTime`       | End time       | 116px | Yes                | Same format                                                                    |
| `type`          | Type           | 113px | Yes                | "Schedule Based", "API", "Manual", etc.                                        |
| `apiKey`        | Source         | 116px | Yes                | Tooltip cell: "Time trigger", "API key name", etc.                             |

---

## 9. Run Behavior: Direct Debug Panel, Conditional Modal

### Current State

**File:** `apps/studio/src/components/workflows/canvas/panels/RunDialog.tsx`
**File:** `apps/studio/src/components/workflows/canvas/panels/CanvasToolbar.tsx:64-72`

Current flow:

1. User clicks **Run** button
2. **Always** opens `RunDialog` — a full-screen overlay modal (480px card, `fixed inset-0 bg-black/50 z-50`)
3. Modal shows input variable fields (or "No input variables defined" if none)
4. User clicks "Run" in modal
5. Modal closes, `setCurrentExecutionId` + `setDebugPanelOpen(true)` — debug panel appears

**Problem:** The modal is unnecessary friction when no input variables exist. Users must click through an empty modal every time they run a simple workflow.

### New Behavior

```
User clicks Run
       │
       ├── Has input variables? ──YES──► Show input modal ──► User fills & clicks Run ──► Close modal ──► Debug panel opens
       │
       └── No input variables? ──────────────────────────────────────────────────────────► Debug panel opens directly
```

#### 9.1 No Input Variables: Direct Execution

When the Start node has **no input variables** defined (the common case):

1. User clicks **Run** in the toolbar
2. **No modal appears**
3. Execution starts immediately via `executeWorkflow(projectId, workflowId, {})`
4. Debug panel slides open on the right (see Section 10 for animation)
5. Flow log begins populating with live step status

```
  Click [▶ Run]
       │
       ▼
  ┌─────── Canvas ─────────────┬──── Debug Panel (slides in) ────┐
  │                             │ Run                ⏱ 0s         │
  │  ┌─────┐      ┌─────┐     │                                  │
  │  │Start├─────►│ API │     │ ┌─ Flow Log ──────────────────┐  │
  │  └─────┘      └──┬──┘     │ │ 🔄 Start ............. 0ms  │  │
  │                   │        │ │ ⏳ API ............... ---   │  │
  │              ┌────┴───┐    │ │ ⏳ End ............... ---   │  │
  │              │  End   │    │ └─────────────────────────────┘  │
  │              └────────┘    │                                  │
  └────────────────────────────┴──────────────────────────────────┘
```

#### 9.2 With Input Variables: Modal First

When the Start node **has input variables** defined:

1. User clicks **Run** in the toolbar
2. Modal opens with input fields for each variable
3. User fills in values and clicks **Run** in the modal
4. Modal closes with a quick fade-out (150ms)
5. Debug panel slides open simultaneously
6. Execution starts with the provided input values

**Modal design (refined from current):**

```
  ┌──────────────────────────────────────────┐
  │  Run Workflow                         ✕  │
  ├──────────────────────────────────────────┤
  │                                          │
  │  Input Variables                         │
  │                                          │
  │  user_email *                            │
  │  ┌──────────────────────────────────┐    │
  │  │ john@example.com                 │    │
  │  └──────────────────────────────────┘    │
  │                                          │
  │  batch_size                              │
  │  ┌──────────────────────────────────┐    │
  │  │ 100                              │    │
  │  └──────────────────────────────────┘    │
  │                                          │
  ├──────────────────────────────────────────┤
  │                      [Cancel]  [▶ Run]   │
  └──────────────────────────────────────────┘
```

| Property        | Value                                                                      |
| --------------- | -------------------------------------------------------------------------- |
| data-testid     | `run-input-modal`                                                          |
| Backdrop        | `bg-black/40` with `backdrop-blur-sm`, click outside to cancel             |
| Card width      | 420px                                                                      |
| Entry animation | Fade in backdrop (150ms) + scale card from 0.96 to 1.0 (200ms, `ease-out`) |
| Exit animation  | Fade out (150ms, `ease-out`) — **no abrupt disappear**                     |
| Required fields | Marked with `*`, red border + error message on empty submit                |
| Run button      | Primary, disabled until all required fields filled                         |
| Cancel button   | Ghost/secondary                                                            |

#### 9.3 Start Node in Debug Panel Flow Log

**Current gap:** The `ExecutionDebugPanel` does not show the Start node as a step in the flow log. The log begins from the first "real" execution step.

**New behavior:** The Start node is **always the first item** in the Flow Log, showing that the workflow was initiated and input was received.

```
  ┌─ Flow Log ──────────────────────────────────┐
  │ ✅ Start ................................ 0ms │  <-- always present
  │    └─ Input: { "user_email": "john@..." }    │  <-- shows input values if any
  │ 🔄 API Call .......................... ---    │
  │ ⏳ Send Email ....................... ---    │
  │ ⏳ End .............................. ---    │
  └──────────────────────────────────────────────┘
```

**Start node step item details:**

| Property        | Value                                                                                   |
| --------------- | --------------------------------------------------------------------------------------- |
| data-testid     | `debug-step-Start`                                                                      |
| Status icon     | `<CheckCircle2>` (always immediate success — Start doesn't "execute")                   |
| Node type icon  | `<Flag>` (same as canvas Start node)                                                    |
| Duration        | "0ms" (instantaneous)                                                                   |
| Expandable body | If input variables exist: read-only JSON of input values. If none: "No input variables" |
| Metrics         | "Initiated on" timestamp only (no "Completed on" — same instant)                        |

#### 9.4 Implementation Changes

**File:** `RunDialog.tsx` — refactor to split logic:

```tsx
// In CanvasToolbar.tsx — new Run button handler:
const handleRun = useCallback(() => {
  const startNode = nodes.find((n) => n.type === 'startNode');
  const inputVars = startNode?.data?.config?.inputVariables ?? [];

  if (inputVars.length > 0) {
    // Has inputs → show modal
    setRunDialogOpen(true);
  } else {
    // No inputs → execute immediately
    executeWorkflow(projectId, workflowId, {}).then((execution) => {
      setCurrentExecutionId(execution.id);
      setDebugPanelOpen(true);
    });
  }
}, [nodes, projectId, workflowId]);
```

**File:** `ExecutionDebugPanel.tsx` (→ `WorkflowDebugPanel.tsx`) — ensure Start node is included:

The execution polling data should always include a synthetic Start step at index 0. If the API doesn't return it, prepend it client-side:

```tsx
const stepsWithStart = useMemo(() => {
  const steps = execution?.steps ?? [];
  const hasStart = steps.some((s) => s.nodeType === 'start');
  if (hasStart) return steps;

  return [
    {
      id: 'start',
      name: 'Start',
      nodeType: 'start' as const,
      status: 'completed' as const,
      duration: 0,
      startedAt: execution?.startedAt,
      completedAt: execution?.startedAt,
      input: execution?.input ?? {},
      output: {},
    },
    ...steps,
  ];
}, [execution]);
```

#### 9.5 Run Button State During Execution

While a workflow is running, the Run button changes to indicate active execution:

| State     | Button display                                        | Behavior on click                   |
| --------- | ----------------------------------------------------- | ----------------------------------- |
| Idle      | `[▶ Run]` primary button                              | Start execution (per 9.1/9.2 logic) |
| Running   | `[■ Stop]` destructive-outline button, with pulse dot | Cancel execution (calls cancel API) |
| Completed | `[▶ Run]` primary button (reset)                      | Start new execution                 |

The running state uses a small animated dot:

```tsx
<Button variant="outline" className="border-destructive text-destructive">
  <span className="relative flex h-2 w-2 mr-2">
    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75" />
    <span className="relative inline-flex rounded-full h-2 w-2 bg-destructive" />
  </span>
  Stop
</Button>
```

---

## 10. Visual Polish & Animation System

### Design Philosophy

The canvas should feel like a premium, enterprise-grade design tool — think Figma's precision, Linear's smoothness, and Retool's clarity. Every interaction should have deliberate, subtle feedback. No jarring state changes. No raw CSS defaults.

**Principles:**

1. **Everything animates** — but nothing is slow. 150-200ms for micro-interactions, 250-350ms for panel transitions.
2. **Depth through shadow, not borders** — nodes float above the canvas with layered shadows.
3. **Color with purpose** — only use accent colors for interactive states and status indicators.
4. **Consistent easing** — one curve for enter (`ease-out`), one for exit (`ease-in`), one for movement (`ease-in-out`).
5. **Reduced motion** — all animations respect `prefers-reduced-motion: reduce` and degrade to instant transitions.

### 10.1 Animation Timing Constants

Define a shared animation config used across all canvas components:

```ts
// canvas/constants/animation.ts

export const CANVAS_ANIMATION = {
  /** Micro-interactions: hover, focus, icon appear */
  fast: { duration: 150, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },

  /** Panel transitions: slide-in, accordion expand */
  medium: { duration: 250, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },

  /** Layout shifts: panel open/close, node reposition */
  slow: { duration: 350, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },

  /** Spring-like for interactive drags and snaps */
  spring: { duration: 400, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
} as const;
```

The easing `cubic-bezier(0.16, 1, 0.3, 1)` is an "expo-out" curve — fast start, smooth deceleration. Used by Linear, Vercel, and Framer for premium feel.

Tailwind config extension:

```ts
// tailwind.config.ts (extend)
theme: {
  extend: {
    transitionTimingFunction: {
      'canvas': 'cubic-bezier(0.16, 1, 0.3, 1)',
      'canvas-spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    },
    transitionDuration: {
      '150': '150ms',
      '250': '250ms',
      '350': '350ms',
    },
    keyframes: {
      'slide-in-right': {
        '0%': { transform: 'translateX(100%)', opacity: '0' },
        '100%': { transform: 'translateX(0)', opacity: '1' },
      },
      'slide-out-right': {
        '0%': { transform: 'translateX(0)', opacity: '1' },
        '100%': { transform: 'translateX(100%)', opacity: '0' },
      },
      'fade-scale-in': {
        '0%': { opacity: '0', transform: 'scale(0.96)' },
        '100%': { opacity: '1', transform: 'scale(1)' },
      },
      'node-appear': {
        '0%': { opacity: '0', transform: 'scale(0.9)' },
        '100%': { opacity: '1', transform: 'scale(1)' },
      },
      'pulse-ring': {
        '0%': { boxShadow: '0 0 0 0 rgba(59, 130, 246, 0.4)' },
        '70%': { boxShadow: '0 0 0 8px rgba(59, 130, 246, 0)' },
        '100%': { boxShadow: '0 0 0 0 rgba(59, 130, 246, 0)' },
      },
      'status-dot-ping': {
        '75%, 100%': { transform: 'scale(2)', opacity: '0' },
      },
    },
    animation: {
      'slide-in-right': 'slide-in-right 350ms cubic-bezier(0.16, 1, 0.3, 1)',
      'slide-out-right': 'slide-out-right 250ms cubic-bezier(0.16, 1, 0.3, 1)',
      'fade-scale-in': 'fade-scale-in 200ms cubic-bezier(0.16, 1, 0.3, 1)',
      'node-appear': 'node-appear 250ms cubic-bezier(0.34, 1.56, 0.64, 1)',
      'pulse-ring': 'pulse-ring 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      'status-dot': 'status-dot-ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite',
    },
  },
}
```

### 10.2 Node Visual Refinement

#### Shadow System

Nodes use a three-tier shadow system to communicate state:

| State               | Shadow                                                                             | Border                                                   |
| ------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Default (resting)   | `shadow-sm` → `0 1px 2px rgba(0,0,0,0.05)`                                         | `border-default` (subtle, 1px)                           |
| Hovered             | `shadow-md` → `0 4px 6px -1px rgba(0,0,0,0.07), 0 2px 4px -2px rgba(0,0,0,0.05)`   | `border-default`                                         |
| Selected            | `shadow-lg` → `0 10px 15px -3px rgba(0,0,0,0.08), 0 4px 6px -4px rgba(0,0,0,0.04)` | `ring-2 ring-primary/30` (soft blue glow)                |
| Executing (running) | `shadow-lg` + pulsing glow                                                         | `animate-pulse-ring` (soft blue pulse radiating outward) |

Transition between all shadow states: `transition-shadow duration-200 ease-canvas`.

#### Color Header Bar

The 6px color bar at the top of each node is refined:

| Current                                   | New                                                     |
| ----------------------------------------- | ------------------------------------------------------- |
| Flat solid color, sharp corners at bottom | Gradient from solid to 80% opacity, smooth inner radius |

```css
.node-color-bar {
  height: 6px;
  border-radius: 8px 8px 0 0;
  background: linear-gradient(
    90deg,
    var(--node-color) 0%,
    color-mix(in srgb, var(--node-color) 80%, transparent) 100%
  );
}
```

#### Node Appear Animation

When a node is added to the canvas (from sidebar drag, context menu, or paste):

```css
.node-entering {
  animation: node-appear 250ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}
```

This gives a slight "pop" / overshoot effect — the node scales from 0.9 to 1.0 with a spring feel, then settles.

#### Node Delete Animation

When a node is removed:

```css
.node-exiting {
  animation: node-appear 150ms ease-in reverse forwards;
  /* Shrinks to 0.9 and fades out */
}
```

### 10.3 Edge Visual Refinement

#### Default Edges

| Property       | Current        | New                                                                                     |
| -------------- | -------------- | --------------------------------------------------------------------------------------- |
| Stroke color   | `#94a3b8`      | `#cbd5e1` (lighter, less dominant — edges should recede)                                |
| Stroke width   | 2              | 1.5                                                                                     |
| Stroke linecap | default (butt) | `round`                                                                                 |
| Path type      | Bezier         | **Smooth step** (`getSmoothStepPath` with `borderRadius: 12`) — cleaner for L-to-R flow |

#### Hover / Selected Edges

| State            | Stroke color                | Stroke width | Extra                                                                    |
| ---------------- | --------------------------- | ------------ | ------------------------------------------------------------------------ |
| Default          | `#cbd5e1`                   | 1.5          | —                                                                        |
| Hovered          | `#94a3b8` (slightly darker) | 2            | —                                                                        |
| Selected         | `#3b82f6` (blue)            | 2.5          | Subtle drop shadow: `filter: drop-shadow(0 0 3px rgba(59,130,246,0.25))` |
| Failure          | `#fca5a5` (soft red)        | 1.5          | `strokeDasharray: '8 4'` (slightly more space)                           |
| Failure selected | `#ef4444`                   | 2.5          | Drop shadow red                                                          |

Transition: `transition: stroke 200ms ease-canvas, stroke-width 150ms ease-canvas, filter 200ms ease-canvas`.

#### Edge Creation Animation

When a new edge is created (connecting two nodes), it draws in from source to target:

```css
.edge-entering {
  stroke-dasharray: 1000;
  stroke-dashoffset: 1000;
  animation: edge-draw 400ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes edge-draw {
  to {
    stroke-dashoffset: 0;
  }
}
```

#### Edge Delete Animation

Edges fade out on deletion:

```css
.edge-exiting {
  animation: edge-fade 150ms ease-in forwards;
}

@keyframes edge-fade {
  to {
    opacity: 0;
    stroke-width: 0;
  }
}
```

### 10.4 Handle Visual Refinement

#### Resting State

| Property   | Current                 | New                                          |
| ---------- | ----------------------- | -------------------------------------------- |
| Size       | 12x12 (`!w-3 !h-3`)     | 10x10 (slightly smaller — less visual noise) |
| Border     | 2px solid bg-elevated   | 2px solid, color matches node border         |
| Background | `!bg-foreground-subtle` | `#cbd5e1` (muted, recedes until hovered)     |
| Shape      | Circle                  | Circle                                       |

#### Hover State (handle dot itself, before plus icon appears)

```css
.react-flow__handle:hover {
  background: #3b82f6 !important; /* Primary blue */
  transform: scale(1.3);
  transition:
    transform 150ms cubic-bezier(0.34, 1.56, 0.64, 1),
    background 150ms ease;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
}

/* Failure handles hover red */
.react-flow__handle.failure-handle:hover {
  background: #ef4444 !important;
  box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.15);
}
```

The handle dot scales up slightly (spring easing — overshoots then settles), gains color, and shows a soft glow ring. This signals interactivity before the plus icon fully appears.

#### Connected vs Unconnected

Handles that already have an edge connected show a filled dot. Unconnected handles show a ring/outline:

| State          | Style                                                |
| -------------- | ---------------------------------------------------- |
| Unconnected    | Ring: 2px border, hollow center (bg matches node bg) |
| Connected      | Filled: solid color matching the edge                |
| Hover (either) | Scale 1.3 + blue/red fill + glow                     |

### 10.5 Panel Transitions

#### Debug Panel (Right Side)

**Enter:** Slides from right, 350ms expo-out:

```css
.debug-panel-enter {
  animation: slide-in-right 350ms cubic-bezier(0.16, 1, 0.3, 1);
}
```

The canvas content area smoothly compresses to accommodate:

```css
.canvas-with-panel {
  transition: width 350ms cubic-bezier(0.16, 1, 0.3, 1);
}
```

**Exit:** Slides out to right, 250ms (faster exit — users shouldn't wait for panels to close):

```css
.debug-panel-exit {
  animation: slide-out-right 250ms cubic-bezier(0.16, 1, 0.3, 1);
}
```

#### Config Panel (Right Side, same slot)

Same slide-in/out animation as debug panel. When **switching** between config and debug panel (e.g., execution starts while config is open), cross-fade:

```css
.panel-crossfade-exit {
  animation: fade-out 150ms ease-in;
}
.panel-crossfade-enter {
  animation: fade-in 200ms ease-out 100ms;
} /* 100ms delay for stagger */
```

#### Assets Sidebar (Left Side)

Slides from left with the same timing as the right panel, keeping the canvas centered between both panels.

#### Run Input Modal

**Enter:** Backdrop fades in (150ms) while card scales up with fade (200ms, expo-out):

```css
.modal-backdrop-enter {
  animation: fade-in 150ms ease-out;
}
.modal-card-enter {
  animation: fade-scale-in 200ms cubic-bezier(0.16, 1, 0.3, 1);
}
```

**Exit:** Everything fades out together (150ms):

```css
.modal-exit {
  animation: fade-out 150ms ease-in;
}
```

### 10.6 Toolbar Refinement

| Element                   | Animation                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------- |
| Save status text          | Fades in/out with `transition: opacity 300ms ease`                                    |
| Validation badge          | Number change uses a subtle scale pulse (`transform: scale(1.1)` for 150ms then back) |
| Run button idle → running | Color crossfade 200ms + icon morph (Play → Stop)                                      |
| Run button running state  | Ping dot animation on the left (1.5s infinite)                                        |

### 10.7 Canvas Background

| Property  | Current   | New                                       |
| --------- | --------- | ----------------------------------------- |
| Pattern   | Dots      | Dots (unchanged)                          |
| Dot color | `#e2e8f0` | `#e2e8f0` at 0.5 opacity (softer)         |
| Dot size  | 1         | 0.8 (slightly smaller — less distracting) |
| Gap       | 20        | 20 (unchanged)                            |

Add a subtle radial gradient vignette at the edges to give depth:

```css
.react-flow__background::after {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at center, transparent 50%, rgba(0, 0, 0, 0.02) 100%);
  pointer-events: none;
}
```

### 10.8 Selection & Multi-Select

#### Selection Box (Lasso)

When the user drags to select multiple nodes:

| Property      | Current (ReactFlow default) | New                                                                     |
| ------------- | --------------------------- | ----------------------------------------------------------------------- |
| Border        | Blue dashed                 | `1.5px solid #3b82f6` (solid, thin)                                     |
| Fill          | Light blue                  | `rgba(59, 130, 246, 0.04)` (barely visible — just enough to see bounds) |
| Border radius | 0                           | `4px`                                                                   |
| Animation     | None                        | Border fades in over 100ms                                              |

#### Multi-Node Selected State

All selected nodes show the blue ring. Additionally, a subtle "group bounding box" outline appears around all selected nodes:

```css
.selection-group-outline {
  border: 1.5px dashed rgba(59, 130, 246, 0.3);
  border-radius: 8px;
  padding: 8px;
  transition: all 200ms ease-canvas;
}
```

### 10.9 Drag & Drop from Sidebar

When dragging a node type from the Assets Sidebar onto the canvas:

| Phase                             | Visual                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Drag start**                    | Sidebar item slightly lifts (`scale(1.02)`, `shadow-md`) for 100ms, then a ghost preview attaches to cursor |
| **Over canvas**                   | Ghost shows as a semi-transparent node card (`opacity: 0.7`) with the correct color bar and icon            |
| **Valid drop**                    | Ghost snaps to grid position, ripple effect at drop point (expanding circle, 300ms, fades)                  |
| **Invalid drop** (outside canvas) | Ghost fades out and returns to sidebar (spring animation, 200ms)                                            |

Ghost preview node:

```css
.drag-ghost-node {
  opacity: 0.7;
  transform: scale(0.95);
  filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.12));
  pointer-events: none;
}
```

### 10.10 Execution Overlay Animations

When a workflow is running and nodes light up in sequence:

| Node state                        | Visual                                               | Transition                                                               |
| --------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| **Pending** (not yet reached)     | Default styling, `opacity: 0.6`                      | —                                                                        |
| **Running** (currently executing) | Blue ring + soft pulsing glow (`animate-pulse-ring`) | Ring appears with 200ms fade-in                                          |
| **Completed** (success)           | Green ring (solid, no pulse) + brief green flash     | Ring transitions blue→green over 300ms, flash is a 150ms overlay         |
| **Failed**                        | Red ring (solid) + subtle shake                      | Ring transitions blue→red over 300ms, shake is 3 oscillations over 300ms |
| **Skipped**                       | `opacity: 0.4`, grayscale filter                     | 200ms transition                                                         |

**Completion flash:**

```css
@keyframes completion-flash {
  0% {
    box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5);
  }
  50% {
    box-shadow: 0 0 0 12px rgba(34, 197, 94, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(34, 197, 94, 0);
  }
}

.node-just-completed {
  animation: completion-flash 500ms ease-out;
}
```

**Failure shake:**

```css
@keyframes error-shake {
  0%,
  100% {
    transform: translateX(0);
  }
  20%,
  60% {
    transform: translateX(-3px);
  }
  40%,
  80% {
    transform: translateX(3px);
  }
}

.node-just-failed {
  animation: error-shake 300ms ease-in-out;
}
```

**Sequential node lighting:** When execution progresses from node A to node B, there's a brief "traveling pulse" along the connecting edge:

```css
@keyframes edge-pulse-travel {
  0% {
    stroke-dashoffset: 20;
    opacity: 1;
  }
  100% {
    stroke-dashoffset: 0;
    opacity: 0;
  }
}
```

This creates a visual sense of data flowing through the pipeline.

### 10.11 Reduced Motion Support

**All animations** must respect the user's system preference:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

In React, use a hook:

```tsx
const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
const duration = prefersReducedMotion ? 0 : CANVAS_ANIMATION.medium.duration;
```

### 10.12 Dark Mode Considerations

All colors defined above use CSS custom properties. Dark mode overrides:

| Element             | Light                   | Dark                     |
| ------------------- | ----------------------- | ------------------------ |
| Node shadow         | `rgba(0,0,0,0.05-0.08)` | `rgba(0,0,0,0.3-0.5)`    |
| Node border         | `var(--border)`         | `rgba(255,255,255,0.08)` |
| Edge default        | `#cbd5e1`               | `#475569`                |
| Canvas dot          | `#e2e8f0` at 0.5        | `#334155` at 0.3         |
| Selection ring      | `rgba(59,130,246,0.3)`  | `rgba(96,165,250,0.4)`   |
| Background vignette | `rgba(0,0,0,0.02)`      | `rgba(0,0,0,0.15)`       |

### 10.13 Interaction Sound (Optional, Off by Default)

For teams that want audio feedback, support optional interaction sounds (disabled by default, toggle in settings):

| Interaction                  | Sound             | Duration |
| ---------------------------- | ----------------- | -------- |
| Node connect                 | Soft click / snap | ~80ms    |
| Execution complete (success) | Subtle chime      | ~200ms   |
| Execution failed             | Low tone          | ~200ms   |
| Node delete                  | Soft whoosh       | ~100ms   |

Implementation: Use the Web Audio API with pre-generated tiny audio buffers. Gated behind a `canvasSoundEnabled` user preference in local storage.

---

## Appendix A: File Change Summary

| File                                | Action                                                                                                | Section |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- | ------- |
| `WorkflowNodeComponent.tsx`         | Handle positions Top/Bottom -> Left/Right, vertical output handle stack, handle plus icon, trash icon | 0, 4, 5 |
| `StartNodeComponent.tsx`            | Handle Bottom -> Right, handle plus icon (no trash)                                                   | 0, 4    |
| `EndNodeComponent.tsx`              | Handle Top -> Left, trash icon (no handle plus)                                                       | 0, 5    |
| `WorkflowEdgeComponent.tsx`         | Add trash icon on selection (edge routing auto-adapts)                                                | 6       |
| `WorkflowCanvas.tsx`                | Update `deleteKeyCode`, fitView options (no edge changes needed — positions auto-resolve)             | 0, 6    |
| `WorkflowDetailPage.tsx`            | Edit tab id/label/icon                                                                                | 1       |
| `CanvasToolbar.tsx`                 | Major refactor — new layout, conditional run logic (modal vs direct)                                  | 2, 9    |
| `QuickAddBar.tsx`                   | Delete                                                                                                | 3       |
| `WorkflowCanvasPage.tsx`            | Remove QuickAddBar, update layout                                                                     | 3       |
| `workflow-types.ts` (shared-kernel) | Add `integration` to `STUB_NODE_TYPES`                                                                | 7       |
| `AssetsSidebar.tsx`                 | No code change (driven by STUB_NODE_TYPES)                                                            | 7       |
| `ExecutionDebugPanel.tsx`           | Replace with new `WorkflowDebugPanel`                                                                 | 8       |
| `RunDialog.tsx`                     | Refactor — only shown when input variables exist, refined animations                                  | 9       |
| `WorkflowMonitorTab.tsx`            | Add slider with `WorkflowDebugPanel`                                                                  | 8       |
| `WorkflowCanvasPage.tsx`            | Remove QuickAddBar, panel transition animations, crossfade logic                                      | 3, 10   |
| `workflow-canvas-store.ts`          | Update `addNode` position logic for left-to-right, add layout migration, run state management         | 0, 9    |
| `tailwind.config.ts`                | Add canvas animation keyframes, easing functions, durations                                           | 10      |

### New files:

| File                                  | Purpose                                                         | Section |
| ------------------------------------- | --------------------------------------------------------------- | ------- |
| `WorkflowDebugPanel.tsx`              | Shared debug panel component                                    | 8       |
| `DebugFlowLog.tsx`                    | Flow log sub-component                                          | 8.4     |
| `StepLogItem.tsx`                     | Individual step log item                                        | 8.4     |
| `HandlePlusMenu.tsx`                  | Handle hover plus + context menu (shared by all output handles) | 4       |
| `NodeDeleteButton.tsx`                | Node hover trash icon                                           | 5       |
| `EdgeDeleteButton.tsx`                | Edge selection trash icon                                       | 6       |
| `canvas/constants/animation.ts`       | Shared animation timing constants                               | 10      |
| `canvas/styles/canvas-animations.css` | Keyframes, reduced motion, execution overlays                   | 10      |

---

## Appendix B: Data-TestID Registry

| data-testid                         | Component                     | Section |
| ----------------------------------- | ----------------------------- | ------- |
| `toolbar-expand-collapse-btn`       | CanvasToolbar                 | 2.1     |
| `toolbar-run-btn`                   | CanvasToolbar                 | 2.2     |
| `toolbar-save-status`               | CanvasToolbar                 | 2.4     |
| `handle-plus-${nodeId}-${handleId}` | HandlePlusMenu                | 4.1     |
| `handle-context-menu`               | HandlePlusMenu                | 4.2     |
| `node-delete-${nodeId}`             | NodeDeleteButton              | 5       |
| `edge-delete-${edgeId}`             | EdgeDeleteButton              | 6       |
| `debug-panel-header`                | WorkflowDebugPanel            | 8.2     |
| `debug-panel-title`                 | WorkflowDebugPanel            | 8.2     |
| `debug-elapsed-time`                | WorkflowDebugPanel            | 8.2     |
| `debug-code-toggle`                 | WorkflowDebugPanel            | 8.2     |
| `debug-expand-btn`                  | WorkflowDebugPanel            | 8.2     |
| `debug-close-btn`                   | WorkflowDebugPanel            | 8.2     |
| `debug-input-accordion`             | WorkflowDebugPanel            | 8.3     |
| `debug-flow-log-accordion`          | WorkflowDebugPanel            | 8.4     |
| `debug-step-${stepName}`            | StepLogItem                   | 8.4     |
| `debug-step-header-${stepName}`     | StepLogItem                   | 8.4     |
| `debug-step-body-${stepName}`       | StepLogItem                   | 8.4     |
| `debug-metric-initiated`            | StepLogItem                   | 8.4     |
| `debug-metric-completed`            | StepLogItem                   | 8.4     |
| `debug-metric-duration`             | StepLogItem                   | 8.4     |
| `debug-output-accordion`            | WorkflowDebugPanel            | 8.5     |
| `debug-output-copy`                 | WorkflowDebugPanel            | 8.5     |
| `debug-output-expand`               | WorkflowDebugPanel            | 8.5     |
| `debug-context-panel`               | ContextPanel                  | 8.6     |
| `monitor-execution-slider`          | WorkflowMonitorTab            | 8.7     |
| `monitor-total-runs`                | WorkflowMonitorTab            | 8.8     |
| `monitor-in-progress`               | WorkflowMonitorTab            | 8.8     |
| `monitor-response-time`             | WorkflowMonitorTab            | 8.8     |
| `monitor-failure-rate`              | WorkflowMonitorTab            | 8.8     |
| `run-input-modal`                   | RunDialog                     | 9.2     |
| `toolbar-stop-btn`                  | CanvasToolbar (running state) | 9.5     |
| `debug-step-Start`                  | StepLogItem (Start node)      | 9.3     |
