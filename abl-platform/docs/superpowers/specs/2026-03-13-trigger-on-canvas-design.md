# Trigger Node on Canvas — Design Spec

**Date:** 2026-03-13
**Status:** Approved
**Scope:** `apps/studio/src/components/pipelines/`

## Problem

When the pipeline graph becomes complex, identifying the starting node is confusing. Triggers are currently configured via a popover in the toolbar — disconnected from the visual flow. Users cannot see at a glance which node the pipeline starts from or what triggers it.

## Solution

Move triggers from the toolbar to the canvas as a **visual-only trigger node** that points to the entry node via an edge. The trigger node is always present, non-deletable, and clicking it opens the right config panel (same pattern as regular nodes). The backend schema remains unchanged.

## Constants

```typescript
const TRIGGER_NODE_ID = '__trigger__';
const TRIGGER_NODE_WIDTH = 220; // matches PIPELINE_NODE_WIDTH
const TRIGGER_NODE_HEIGHT = 100; // matches PIPELINE_NODE_HEIGHT
const TRIGGER_EDGE_ID_PREFIX = 'e-trigger-';
const TRIGGER_POSITION_OFFSET_Y = -180; // above entry node
```

## New Component: `PipelineTriggerNode.tsx`

Custom React Flow node type registered as `pipelineTriggerNode`.

### Visual Design

- Same dimensions as `PipelineNodeComponent` (220x100)
- Amber/yellow left-border accent (`border-l-amber-500`) to distinguish from compute/data/logic/integration/action categories
- Card background matches existing nodes: `bg-background-elevated border shadow-sm rounded-lg`
- Selected state: `ring-2 ring-accent border-accent` (same as regular nodes)

### Layout

```
┌─────────────────────────────┐
│ ⚡ Trigger                   │  ← header: icon + label, no delete button
├─────────────────────────────┤
│ Kafka, Manual               │  ← body: summary of active trigger types
│ 🟢 2 configured             │  ← count indicator when configured
└──────────┬──────────────────┘
           ●                     ← source handle only (bottom)
```

### Configured Indicator

When `selectedTriggers.length > 0`, show a count badge on the node:

- Same style as the existing toolbar badge: round pill with `bg-accent/20 text-accent text-[10px] font-bold`
- Positioned inline in the body area
- Shows count: "2 configured"

When no triggers are selected:

- Body shows "Not configured" in muted text (`text-foreground-muted`)

### Handles

- **Source handle only** (bottom) — nothing flows into the trigger
- No target handle
- Handle styling matches existing nodes: `!bg-foreground-subtle !border-2 !border-background-elevated !w-2.5 !h-2.5`

### Behavior

- **Non-deletable**: no trash icon, delete/backspace key ignored
- **Draggable**: user can reposition it on the canvas
- **Clickable**: opens right panel with trigger configuration
- **Not in palette**: trigger node is auto-inserted, not draggable from NodePalette

### Data Shape

```typescript
interface TriggerNodeData extends Record<string, unknown> {
  label: 'Trigger';
  triggerCount: number; // number of selected triggers
  triggerSummary: string; // e.g. "Kafka, Manual" or "Not configured"
}
```

## Modified: `NodeConfigPanel.tsx`

When `selectedNodeId === TRIGGER_NODE_ID`:

1. Render a different panel layout:
   - Header: "Trigger Configuration" (non-editable label) + close button
   - No activity type badge
   - Body: embed `<TriggerConfigPanel />` directly (new import from `./TriggerConfigPanel`)
   - No "Execution Settings" section (timeout/retries/onFailure)
   - No "Remove Node" button

2. Detection: insert the trigger check **immediately after `selectedNode` is resolved** (after the `useMemo` at ~line 62) but **before** the `activityType` / `nodeTypeDef` derivations. Return the trigger panel variant from there so none of the existing nodeData destructuring applies. This must come before the existing `!nodeData` null guard at line 130, otherwise the component will return `null` before the trigger branch runs.

```typescript
// Early return: trigger node gets its own panel
if (selectedNodeId === TRIGGER_NODE_ID && isConfigPanelOpen) {
  return (
    <div className="w-80 border-l border-default bg-background flex flex-col shrink-0 h-full overflow-hidden">
      <div className="px-4 py-3 border-b border-default shrink-0">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Trigger Configuration</h3>
          <button type="button" className="..." onClick={clearSelection}>
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <TriggerConfigPanel />
      </div>
    </div>
  );
}
```

## Modified: `PipelineGraphCanvas.tsx`

### Node Type Registration

```typescript
const pipelineNodeTypes: NodeTypes = {
  pipelineNode: PipelineNode,
  pipelineGroupNode: PipelineGroupNode,
  pipelineTriggerNode: PipelineTriggerNode, // new
};
```

### `onNodesChange`

Filter out `remove` changes targeting `TRIGGER_NODE_ID`:

```typescript
const filtered = changes.filter((change) => {
  // Prevent removing the trigger node
  if (change.type === 'remove' && 'id' in change && change.id === TRIGGER_NODE_ID) return false;
  // Prevent dragging child nodes
  if (change.type === 'position' && 'id' in change) {
    const node = nodes.find((n) => n.id === change.id);
    if (node?.parentId) return false;
  }
  return true;
});
```

### `onConnect`

- Prevent connections **to** the trigger node (it has no target handle, but guard anyway)
- When connecting **from** the trigger node: prevent connecting to child nodes, replace any existing trigger edge (only one outgoing edge allowed)

```typescript
if (connection.target === TRIGGER_NODE_ID) return;

if (connection.source === TRIGGER_NODE_ID) {
  // Can't point trigger at a group child node
  const targetNode = nodes.find((n) => n.id === connection.target);
  if (targetNode?.parentId) return;

  // Replace existing trigger edge (only one allowed)
  const withoutOldTriggerEdge = edges.filter((e) => e.source !== TRIGGER_NODE_ID);
  const newEdge: Edge = {
    id: `${TRIGGER_EDGE_ID_PREFIX}${connection.target}`,
    source: TRIGGER_NODE_ID,
    target: connection.target,
    type: 'pipelineEdge',
  };
  setEdges([...withoutOldTriggerEdge, newEdge]);
  return;
}
```

### `onEdgesChange`

Prevent deletion of trigger edges:

```typescript
const filtered = changes.filter((change) => {
  if (change.type === 'remove' && 'id' in change) {
    const edge = edges.find((e) => e.id === change.id);
    if (edge?.source === TRIGGER_NODE_ID) return false;
  }
  return true;
});
setEdges(applyEdgeChanges(filtered, edges));
```

### `handleKeyDown`

Skip delete for trigger node and trigger edges:

```typescript
if (event.key === 'Delete' || event.key === 'Backspace') {
  if (selectedNodeId === TRIGGER_NODE_ID) return; // can't delete trigger
  if (selectedEdgeId) {
    const edge = edges.find((e) => e.id === selectedEdgeId);
    if (edge?.source === TRIGGER_NODE_ID) return; // can't delete trigger edge
  }
  // ... existing logic
}
```

## Modified: `PipelineEditorPage.tsx`

### Hydration (load existing pipeline)

After converting backend nodes to React Flow nodes and computing layout:

1. Create a trigger React Flow node with id `TRIGGER_NODE_ID`
2. Find the entry node (use `entryNodeId` from pipeline data, fall back to `findEntryNodeId()`)
3. Position the trigger node above the entry node: `{ x: entryNode.position.x, y: entryNode.position.y + TRIGGER_POSITION_OFFSET_Y }`
4. Create a synthetic edge from trigger to entry node
5. Set trigger node data from store's `selectedTriggers`

```typescript
function createTriggerNode(
  entryPosition: { x: number; y: number },
  selectedTriggers: SelectedTrigger[],
  triggerDefs: TriggerDefinition[],
): { node: Node; edge: Edge | null } {
  const count = selectedTriggers.length;
  const summary =
    count > 0
      ? selectedTriggers
          .map((t) => triggerDefs.find((d) => d.id === t.triggerId)?.type ?? 'unknown')
          .filter((v, i, a) => a.indexOf(v) === i) // unique types
          .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
          .join(', ')
      : 'Not configured';

  return {
    node: {
      id: TRIGGER_NODE_ID,
      type: 'pipelineTriggerNode',
      position: {
        x: entryPosition.x,
        y: entryPosition.y + TRIGGER_POSITION_OFFSET_Y,
      },
      data: {
        label: 'Trigger',
        triggerCount: count,
        triggerSummary: summary,
      },
    },
    edge: null, // set separately when entryNodeId is known
  };
}
```

### Hydration (new pipeline)

Insert trigger node at `{ x: 0, y: 0 }` with no outgoing edge. When the user adds the first node and connects it, that becomes the entry node.

### Save (`handleSave`)

Replace the current `findEntryNodeId(backendNodes)` call. Also fix the existing stale-closure bug on `selectedTriggers` by reading from `getState()`:

```typescript
// Read ALL latest state to avoid stale closures
const latestState = usePipelineEditorStore.getState();
const triggerSelections = latestState.selectedTriggers;

// Filter out trigger node/edges before converting to backend format
const realNodes = latestState.nodes.filter((n) => n.id !== TRIGGER_NODE_ID);
const realEdges = latestState.edges.filter(
  (e) => e.source !== TRIGGER_NODE_ID && e.target !== TRIGGER_NODE_ID,
);
const backendNodes = toPipelineNodes(realNodes, realEdges);

// Derive entryNodeId from trigger edge, fall back to topology
const triggerEdge = latestState.edges.find((e) => e.source === TRIGGER_NODE_ID);
const entryNodeId = triggerEdge?.target ?? findEntryNodeId(backendNodes);
```

### `handleValidate`

Exclude the trigger node from validation checks (it's not a real pipeline node):

```typescript
const topLevelNodes = nodes.filter((n) => !n.parentId && n.id !== TRIGGER_NODE_ID);
```

Without this, the trigger node would produce false warnings (e.g., "Node Trigger is disconnected") and inflate the node count (the "Pipeline has no nodes" check would pass incorrectly when only the trigger node exists).

### Trigger Node Data Sync

When `selectedTriggers` changes in the store, update the trigger node's data (triggerCount, triggerSummary). Use a `useEffect` that watches `selectedTriggers` and calls `updateNodeData(TRIGGER_NODE_ID, ...)`.

## Modified: `PipelineEditorToolbar.tsx`

Remove the triggers button and popover entirely:

- Remove the `useState(triggerPanelOpen)` and `useRef(triggerPanelRef)`
- Remove the `useEffect` for outside-click handling
- Remove the `selectedTriggers` store subscription
- Remove the trigger button JSX (lines 129-161)
- Remove `TriggerConfigPanel` import

The toolbar becomes simpler: back, name, status, validation, spacer, validate/save/activate buttons.

## Modified: `usePipelineAutoLayout.ts`

In `nodesToElkGraph`: filter out the trigger node from ELK layout input.

```typescript
const topLevelNodes = nodes.filter((n) => !n.parentId && n.id !== TRIGGER_NODE_ID);
```

After ELK layout, reposition the trigger node above the entry node:

```typescript
function repositionTriggerNode(nodes: Node[], edges: Edge[]): Node[] {
  const triggerEdge = edges.find((e) => e.source === TRIGGER_NODE_ID);
  if (!triggerEdge) return nodes;

  const entryNode = nodes.find((n) => n.id === triggerEdge.target);
  if (!entryNode) return nodes;

  return nodes.map((n) =>
    n.id === TRIGGER_NODE_ID
      ? {
          ...n,
          position: {
            x: entryNode.position.x,
            y: entryNode.position.y + TRIGGER_POSITION_OFFSET_Y,
          },
        }
      : n,
  );
}
```

## Modified: `pipeline-editor-store.ts`

In `removeNode`: guard against removing the trigger node.

```typescript
removeNode: (nodeId) =>
  set((state) => {
    if (nodeId === TRIGGER_NODE_ID) return state; // guard
    // ... existing logic
  }),
```

No new state fields needed — `selectedTriggers`, `toggleTrigger`, and `updateTriggerSchedule` already exist and work correctly.

## Backend — No Changes

| Artifact                  | Change                                      |
| ------------------------- | ------------------------------------------- |
| `PipelineDefinition` type | None                                        |
| `PipelineNode[]`          | Trigger node never appears                  |
| `entryNodeId`             | Still stored, now derived from trigger edge |
| `supportedTriggers`       | Unchanged                                   |
| API routes                | Unchanged                                   |
| `resolve-triggers.ts`     | Unchanged                                   |
| `graph-walker.ts`         | Unchanged                                   |

## Edge Cases

1. **All real nodes deleted**: Trigger node remains alone. No edge. `entryNodeId` saved as `undefined`.
2. **Reconnect trigger to different node**: Old edge replaced, new target becomes entry node.
3. **Multiple outgoing edges from trigger**: Prevented in `onConnect` — connecting to a new target replaces the old edge.
4. **Pipeline loaded with no `entryNodeId`**: Fall back to `findEntryNodeId()` for the synthesized edge target.
5. **Auto-layout**: Trigger excluded from ELK, repositioned 180px above entry node afterward.
6. **Drag trigger node**: Allowed — user can reposition freely. Position persists in React Flow state but is not saved to backend (re-synthesized on load).
7. **Entry node deleted while other nodes remain**: Trigger edge is removed by the existing `removeNode` edge cleanup. Trigger node has no outgoing edge. On save, `entryNodeId` falls back to `findEntryNodeId()` topology detection.
8. **Connect trigger to group child node**: Prevented in `onConnect` — child nodes are invalid entry points.

## Files Changed

| File                        | Action                                                 |
| --------------------------- | ------------------------------------------------------ |
| `PipelineTriggerNode.tsx`   | **New** — custom React Flow node component             |
| `PipelineGraphCanvas.tsx`   | Modified — register node type, guard delete/connect    |
| `PipelineEditorPage.tsx`    | Modified — synthesize/filter trigger node on load/save |
| `NodeConfigPanel.tsx`       | Modified — render trigger panel when trigger selected  |
| `PipelineEditorToolbar.tsx` | Modified — remove trigger button/popover               |
| `usePipelineAutoLayout.ts`  | Modified — exclude trigger from ELK, reposition after  |
| `pipeline-editor-store.ts`  | Modified — guard removeNode                            |
