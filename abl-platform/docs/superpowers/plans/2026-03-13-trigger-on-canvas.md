# Trigger Node on Canvas — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move pipeline triggers from the toolbar popover to the canvas as a visual-only trigger node that points to the entry node, making the pipeline start point visually obvious.

**Architecture:** A new `pipelineTriggerNode` React Flow node type is always present on the canvas. It is non-deletable, has only a source handle, and its outgoing edge target determines `entryNodeId`. The backend schema is unchanged — the trigger node is filtered out before save. Clicking the trigger node opens the existing `TriggerConfigPanel` in the right side panel.

**Tech Stack:** React, @xyflow/react (React Flow), Zustand, Next.js, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-13-trigger-on-canvas-design.md`

---

## File Structure

| File                                                                 | Action     | Responsibility                                                        |
| -------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------- |
| `apps/studio/src/components/pipelines/pipeline-trigger-constants.ts` | **Create** | Shared constants (`TRIGGER_NODE_ID`, etc.) and `TriggerNodeData` type |
| `apps/studio/src/components/pipelines/PipelineTriggerNode.tsx`       | **Create** | Custom React Flow node component for the trigger                      |
| `apps/studio/src/store/pipeline-editor-store.ts`                     | **Modify** | Guard `removeNode` against trigger node deletion                      |
| `apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx`       | **Modify** | Register trigger node type, guard delete/connect/edge changes         |
| `apps/studio/src/components/pipelines/NodeConfigPanel.tsx`           | **Modify** | Render `TriggerConfigPanel` when trigger node is selected             |
| `apps/studio/src/components/pipelines/PipelineEditorToolbar.tsx`     | **Modify** | Remove trigger button and popover                                     |
| `apps/studio/src/components/pipelines/usePipelineAutoLayout.ts`      | **Modify** | Exclude trigger from ELK, reposition after layout                     |
| `apps/studio/src/components/pipelines/PipelineEditorPage.tsx`        | **Modify** | Synthesize trigger node on load, filter on save, validate, sync data  |

---

## Chunk 1: Foundation

### Task 1: Create shared constants and types

**Files:**

- Create: `apps/studio/src/components/pipelines/pipeline-trigger-constants.ts`

- [ ] **Step 1: Create the constants file**

```typescript
// apps/studio/src/components/pipelines/pipeline-trigger-constants.ts

/**
 * Pipeline Trigger Node Constants
 *
 * Shared constants and types for the visual-only trigger node
 * on the pipeline graph canvas. The trigger node is a UI construct
 * that is never persisted to the backend PipelineNode[] schema.
 */

import type { SelectedTrigger } from '../../store/pipeline-editor-store';

// =============================================================================
// Constants
// =============================================================================

/** Well-known React Flow node ID for the trigger node. */
export const TRIGGER_NODE_ID = '__trigger__';

/** Width matches PIPELINE_NODE_WIDTH from PipelineNodeComponent. */
export const TRIGGER_NODE_WIDTH = 220;

/** Height matches PIPELINE_NODE_HEIGHT from PipelineNodeComponent. */
export const TRIGGER_NODE_HEIGHT = 100;

/** Edge ID prefix for trigger → entry node edges. */
export const TRIGGER_EDGE_ID_PREFIX = 'e-trigger-';

/** Vertical offset: trigger node is positioned this many px above the entry node. */
export const TRIGGER_POSITION_OFFSET_Y = -180;

// =============================================================================
// Types
// =============================================================================

export interface TriggerNodeData extends Record<string, unknown> {
  label: 'Trigger';
  triggerCount: number;
  triggerSummary: string;
}

// =============================================================================
// Helpers
// =============================================================================

interface TriggerDef {
  id: string;
  type: string;
}

/**
 * Build a human-readable summary string from selected triggers.
 * e.g. "Kafka, Manual" or "Not configured".
 */
export function buildTriggerSummary(
  selectedTriggers: SelectedTrigger[],
  triggerDefs: TriggerDef[],
): string {
  if (selectedTriggers.length === 0) return 'Not configured';
  return selectedTriggers
    .map((t) => triggerDefs.find((d) => d.id === t.triggerId)?.type ?? 'unknown')
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(', ');
}
```

- [ ] **Step 2: Verify the import path resolves**

Run: `cd /Users/Thiru/researchWS/abl-platform && npx tsc --noEmit --project apps/studio/tsconfig.json 2>&1 | head -20`
Expected: No errors from the new file (other pre-existing errors are OK).

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/pipeline-trigger-constants.ts
git add apps/studio/src/components/pipelines/pipeline-trigger-constants.ts
git commit -m "feat(studio): add trigger node constants and types for canvas trigger"
```

---

### Task 2: Create PipelineTriggerNode component

**Files:**

- Create: `apps/studio/src/components/pipelines/PipelineTriggerNode.tsx`
- Reference: `apps/studio/src/components/pipelines/PipelineNodeComponent.tsx` (follow this pattern)

- [ ] **Step 1: Read PipelineNodeComponent.tsx for the exact pattern**

Read `apps/studio/src/components/pipelines/PipelineNodeComponent.tsx` to verify handle classes, card classes, and selected-state styling. The trigger node must visually match except for: amber accent, no delete button, source handle only, trigger-specific body content.

- [ ] **Step 2: Create the component**

```typescript
// apps/studio/src/components/pipelines/PipelineTriggerNode.tsx

/**
 * PipelineTriggerNode
 *
 * Visual-only React Flow node representing the pipeline trigger.
 * Always present on canvas, non-deletable.
 * Shows trigger summary and configured count badge.
 *
 * Pattern: follows PipelineNodeComponent.tsx
 */

'use client';

import { memo, type CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import { Zap } from 'lucide-react';
import { clsx } from 'clsx';
import {
  TRIGGER_NODE_WIDTH,
  TRIGGER_NODE_HEIGHT,
  type TriggerNodeData,
} from './pipeline-trigger-constants';

// =============================================================================
// Types
// =============================================================================

type TriggerNodeType = Node<TriggerNodeData, 'pipelineTriggerNode'>;

// =============================================================================
// Component
// =============================================================================

function PipelineTriggerNodeComponent({ data, selected }: NodeProps<TriggerNodeType>) {
  const containerStyle: CSSProperties = {
    width: TRIGGER_NODE_WIDTH,
    height: TRIGGER_NODE_HEIGHT,
  };

  return (
    <div
      className={clsx(
        'group/node bg-background-elevated border shadow-sm rounded-lg flex flex-col overflow-hidden',
        'transition-shadow duration-200 ease-out',
        'hover:shadow-md',
        'border-l-[3px] border-l-amber-500',
        !selected && 'border-default',
        selected && 'ring-2 ring-accent border-accent',
      )}
      style={containerStyle}
      role="button"
      aria-label="Pipeline trigger"
    >
      {/* Header: icon + label (no delete button) */}
      <div className="px-3 pt-2.5 pb-1.5 border-b border-default/40 flex items-center gap-1.5">
        <Zap className="w-3.5 h-3.5 text-amber-400 shrink-0" />
        <span className="text-sm font-semibold text-foreground truncate flex-1">
          {data.label}
        </span>
      </div>

      {/* Body: trigger summary + configured indicator */}
      <div className="px-3 py-2 flex-1 flex flex-col gap-1 min-h-0">
        <span
          className={clsx(
            'text-[11px] truncate',
            data.triggerCount > 0 ? 'text-foreground-muted' : 'text-foreground-muted/60',
          )}
        >
          {data.triggerSummary}
        </span>

        {data.triggerCount > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-accent/20 text-accent text-[10px] font-bold">
              {data.triggerCount}
            </span>
            <span className="text-[10px] text-foreground-muted">
              configured
            </span>
          </div>
        )}
      </div>

      {/* Source handle only (bottom) — no target handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-foreground-subtle !border-2 !border-background-elevated !w-2.5 !h-2.5"
      />
    </div>
  );
}

export const PipelineTriggerNode = memo(PipelineTriggerNodeComponent);
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=studio 2>&1 | tail -10`
Expected: Build succeeds (component is created but not yet imported anywhere).

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineTriggerNode.tsx
git add apps/studio/src/components/pipelines/PipelineTriggerNode.tsx
git commit -m "feat(studio): add PipelineTriggerNode component for canvas trigger"
```

---

### Task 3: Guard store removeNode

**Files:**

- Modify: `apps/studio/src/store/pipeline-editor-store.ts` (line ~235, `removeNode` action)

- [ ] **Step 1: Read the current removeNode implementation**

Read `apps/studio/src/store/pipeline-editor-store.ts` lines 235-300 to verify the exact shape of `removeNode`.

- [ ] **Step 2: Add the TRIGGER_NODE_ID guard**

At the top of the `removeNode` handler (immediately inside `set((state) => {`), add:

```typescript
import { TRIGGER_NODE_ID } from '../components/pipelines/pipeline-trigger-constants';
```

Then in the `removeNode` body, before `const targetNode = state.nodes.find(...)`:

```typescript
if (nodeId === TRIGGER_NODE_ID) return state;
```

- [ ] **Step 3: Verify build**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=studio 2>&1 | tail -10`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/store/pipeline-editor-store.ts
git add apps/studio/src/store/pipeline-editor-store.ts
git commit -m "fix(studio): guard removeNode against trigger node deletion"
```

---

## Chunk 2: Canvas Integration

### Task 4: Update PipelineGraphCanvas — register node type and add guards

**Files:**

- Modify: `apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx`

- [ ] **Step 1: Read the current file**

Read `apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx` to get exact line numbers for: `pipelineNodeTypes` registration (line ~48), `onNodesChange` (line ~102), `onEdgesChange` (line ~117), `onConnect` (line ~126), `handleKeyDown` (line ~259).

- [ ] **Step 2: Add imports**

At the top of the file, add:

```typescript
import { PipelineTriggerNode } from './PipelineTriggerNode';
import { TRIGGER_NODE_ID, TRIGGER_EDGE_ID_PREFIX } from './pipeline-trigger-constants';
```

- [ ] **Step 3: Register the trigger node type**

In `pipelineNodeTypes` (line ~48), add:

```typescript
const pipelineNodeTypes: NodeTypes = {
  pipelineNode: PipelineNode,
  pipelineGroupNode: PipelineGroupNode,
  pipelineTriggerNode: PipelineTriggerNode,
};
```

- [ ] **Step 4: Update `onNodesChange` to prevent trigger node removal**

Replace the existing `onNodesChange` callback. The current code filters child node drags. Add a filter for trigger node removal:

```typescript
const onNodesChange = useCallback(
  (changes: NodeChange[]) => {
    const filtered = changes.filter((change) => {
      // Prevent removing the trigger node
      if (
        change.type === 'remove' &&
        'id' in change &&
        (change as { id: string }).id === TRIGGER_NODE_ID
      )
        return false;
      // Prevent dragging child nodes (they're auto-positioned inside groups)
      if (change.type === 'position' && 'id' in change) {
        const node = nodes.find((n) => n.id === (change as { id: string }).id);
        if (node?.parentId) return false;
      }
      return true;
    });
    setNodes(applyNodeChanges(filtered, nodes));
  },
  [nodes, setNodes],
);
```

- [ ] **Step 5: Update `onEdgesChange` to prevent trigger edge deletion**

Replace the existing `onEdgesChange` callback:

```typescript
const onEdgesChange = useCallback(
  (changes: EdgeChange[]) => {
    const filtered = changes.filter((change) => {
      if (change.type === 'remove' && 'id' in change) {
        const edge = edges.find((e) => e.id === (change as { id: string }).id);
        if (edge?.source === TRIGGER_NODE_ID) return false;
      }
      return true;
    });
    setEdges(applyEdgeChanges(filtered, edges));
  },
  [edges, setEdges],
);
```

- [ ] **Step 6: Update `onConnect` for trigger edge behavior**

Add trigger guards at the top of the `onConnect` callback, before the existing `if (!connection.source || !connection.target) return;`:

```typescript
const onConnect = useCallback(
  (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    if (connection.source === connection.target) return;

    // Prevent connections TO the trigger node
    if (connection.target === TRIGGER_NODE_ID) return;

    // Trigger node: replace existing trigger edge (only one outgoing edge allowed)
    if (connection.source === TRIGGER_NODE_ID) {
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (targetNode?.parentId) return; // Can't point trigger at a group child node

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

    // Prevent connecting from/to child nodes directly
    const sourceNode = nodes.find((n) => n.id === connection.source);
    const targetNode = nodes.find((n) => n.id === connection.target);
    if (sourceNode?.parentId || targetNode?.parentId) return;

    const newEdge: Edge = {
      id: `e-${connection.source}-${connection.target}-${Date.now()}`,
      source: connection.source,
      target: connection.target,
      type: 'pipelineEdge',
    };

    setEdges([...edges, newEdge]);
  },
  [edges, setEdges, nodes],
);
```

- [ ] **Step 7: Update `handleKeyDown` to protect trigger node and trigger edges**

In the `handleKeyDown` callback, update the delete/backspace branch:

```typescript
if (event.key === 'Delete' || event.key === 'Backspace') {
  if (selectedNodeId === TRIGGER_NODE_ID) return;
  if (selectedNodeId) {
    removeNode(selectedNodeId);
  } else if (selectedEdgeId) {
    const edge = edges.find((e) => e.id === selectedEdgeId);
    if (edge?.source === TRIGGER_NODE_ID) return;
    setEdges(edges.filter((e) => e.id !== selectedEdgeId));
    clearSelection();
  }
}
```

- [ ] **Step 8: Verify build**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=studio 2>&1 | tail -10`
Expected: Build succeeds.

- [ ] **Step 9: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx
git add apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx
git commit -m "feat(studio): register trigger node type and add canvas guards"
```

---

### Task 5: Update NodeConfigPanel — trigger panel early return

**Files:**

- Modify: `apps/studio/src/components/pipelines/NodeConfigPanel.tsx`

- [ ] **Step 1: Read the current file**

Read `apps/studio/src/components/pipelines/NodeConfigPanel.tsx` to verify exact structure. The trigger check must go after `selectedNode` is resolved (~line 62) but before the `activityType`/`nodeTypeDef` derivation and the `!nodeData` null guard (~line 130).

- [ ] **Step 2: Add imports**

```typescript
import { TRIGGER_NODE_ID } from './pipeline-trigger-constants';
import { TriggerConfigPanel } from './TriggerConfigPanel';
```

- [ ] **Step 3: Add trigger panel early return**

After the `selectedNode` useMemo (after line ~62), before `const nodeData = selectedNode?.data...` (line ~62), add:

```typescript
// ── Trigger node: render trigger config panel instead ──
if (selectedNodeId === TRIGGER_NODE_ID && isConfigPanelOpen) {
  return (
    <div className="w-80 border-l border-default bg-background flex flex-col shrink-0 h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-default shrink-0">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">
            Trigger Configuration
          </h3>
          <button
            type="button"
            className="p-1 text-muted hover:text-foreground rounded transition-colors"
            onClick={clearSelection}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[11px] text-foreground-muted mt-1">
          Choose when this pipeline should run
        </p>
      </div>

      {/* Trigger selection list */}
      <div className="flex-1 overflow-y-auto">
        <TriggerConfigPanel />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify build**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=studio 2>&1 | tail -10`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/NodeConfigPanel.tsx
git add apps/studio/src/components/pipelines/NodeConfigPanel.tsx
git commit -m "feat(studio): show trigger config panel when trigger node selected"
```

---

### Task 6: Clean up PipelineEditorToolbar — remove trigger popover

**Files:**

- Modify: `apps/studio/src/components/pipelines/PipelineEditorToolbar.tsx`

- [ ] **Step 1: Read the current file**

Read `apps/studio/src/components/pipelines/PipelineEditorToolbar.tsx` to identify all trigger-related code.

- [ ] **Step 2: Remove trigger imports and state**

Remove these:

- `import { TriggerConfigPanel } from './TriggerConfigPanel';` (line ~16)
- `const selectedTriggers = usePipelineEditorStore((s) => s.selectedTriggers);` (line ~59)
- `const [triggerPanelOpen, setTriggerPanelOpen] = useState(false);` (line ~60)
- `const triggerPanelRef = useRef<HTMLDivElement>(null);` (line ~61)
- The entire `useEffect` for outside-click handling (lines ~71-80)
- The `Zap` icon import from lucide-react (line ~13, only if no other usage)

- [ ] **Step 3: Remove trigger button JSX**

Remove the entire trigger button + popover JSX block (lines ~129-161):

```
{/* Triggers button + popover */}
<div className="relative" ref={triggerPanelRef}>
  ...
</div>
```

- [ ] **Step 4: Clean up unused imports**

Remove `useState`, `useRef`, `useEffect` from React imports if they are no longer used by other code in this file. Remove `Zap` from lucide-react import.

- [ ] **Step 5: Verify build**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=studio 2>&1 | tail -10`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineEditorToolbar.tsx
git add apps/studio/src/components/pipelines/PipelineEditorToolbar.tsx
git commit -m "refactor(studio): remove trigger popover from toolbar (moved to canvas)"
```

---

## Chunk 3: Layout, Hydration, and Save

### Task 7: Update usePipelineAutoLayout — exclude trigger, reposition after layout

**Files:**

- Modify: `apps/studio/src/components/pipelines/usePipelineAutoLayout.ts`

- [ ] **Step 1: Read the current file**

Read `apps/studio/src/components/pipelines/usePipelineAutoLayout.ts` to verify `nodesToElkGraph` (line ~99) and `applyElkPositions` (line ~123).

- [ ] **Step 2: Add import**

```typescript
import { TRIGGER_NODE_ID, TRIGGER_POSITION_OFFSET_Y } from './pipeline-trigger-constants';
```

- [ ] **Step 3: Exclude trigger node from ELK graph**

In `nodesToElkGraph` (line ~101), change the filter:

```typescript
const topLevelNodes = nodes.filter((n) => !n.parentId && n.id !== TRIGGER_NODE_ID);
```

- [ ] **Step 4: Add repositionTriggerNode helper**

After `applyElkPositions`, add:

```typescript
/**
 * After ELK layout, reposition the trigger node above the entry node.
 */
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

- [ ] **Step 5: Call repositionTriggerNode after layout**

In the `autoLayout` callback, after `const positioned = applyElkPositions(nodes, result);` (line ~163), add:

```typescript
const withTrigger = repositionTriggerNode(positioned, edges);
```

Then return `withTrigger` instead of `positioned`. The full block becomes:

```typescript
const positioned = applyElkPositions(nodes, result);
const withTrigger = repositionTriggerNode(positioned, edges);

startTransition(() => {
  setIsComputing(false);
});

return withTrigger;
```

Note: The `autoLayout` callback needs to accept `edges` as a parameter, or read them from the argument. Currently the signature is `async (nodes: Node[], edges: Edge[])` — edges are already available.

- [ ] **Step 6: Verify build**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=studio 2>&1 | tail -10`
Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/usePipelineAutoLayout.ts
git add apps/studio/src/components/pipelines/usePipelineAutoLayout.ts
git commit -m "feat(studio): exclude trigger node from ELK layout, reposition after"
```

---

### Task 8: Update PipelineEditorPage — hydration, save, validate, trigger data sync

This is the largest task. It modifies `PipelineEditorPage.tsx` in four areas: hydration (load), save, validate, and trigger data sync.

**Files:**

- Modify: `apps/studio/src/components/pipelines/PipelineEditorPage.tsx`

- [ ] **Step 1: Read the current file**

Read `apps/studio/src/components/pipelines/PipelineEditorPage.tsx` to verify exact line numbers for: hydration useEffect (~line 354), handleSave (~line 433), handleValidate (~line 500), setPipeline calls, and the "new" pipeline useEffect (~line 346).

- [ ] **Step 2: Add imports**

```typescript
import {
  TRIGGER_NODE_ID,
  TRIGGER_EDGE_ID_PREFIX,
  TRIGGER_POSITION_OFFSET_Y,
  buildTriggerSummary,
  type TriggerNodeData,
} from './pipeline-trigger-constants';
```

- [ ] **Step 3: Add createTriggerNode helper**

After the existing `findEntryNodeId` function (~line 177), add:

```typescript
/**
 * Create the visual-only trigger React Flow node and its edge to the entry node.
 * The trigger node is never persisted to the backend — it's synthesized on load.
 */
function createTriggerElements(
  entryNodeId: string | undefined,
  entryPosition: { x: number; y: number },
  triggerCount: number,
  triggerSummary: string,
): { triggerNode: Node; triggerEdge: Edge | null } {
  const triggerNode: Node = {
    id: TRIGGER_NODE_ID,
    type: 'pipelineTriggerNode',
    position: {
      x: entryPosition.x,
      y: entryPosition.y + TRIGGER_POSITION_OFFSET_Y,
    },
    data: {
      label: 'Trigger',
      triggerCount,
      triggerSummary,
    } satisfies TriggerNodeData,
  };

  const triggerEdge: Edge | null = entryNodeId
    ? {
        id: `${TRIGGER_EDGE_ID_PREFIX}${entryNodeId}`,
        source: TRIGGER_NODE_ID,
        target: entryNodeId,
        type: 'pipelineEdge',
      }
    : null;

  return { triggerNode, triggerEdge };
}
```

- [ ] **Step 4: Update the "new pipeline" useEffect**

In the useEffect that handles `pipelineId === 'new'` (~line 346), after `setPipeline('new', 'Untitled Pipeline', 'draft', [], []);`, add the trigger node:

Replace:

```typescript
setPipeline('new', 'Untitled Pipeline', 'draft', [], []);
```

With:

```typescript
const { triggerNode } = createTriggerElements(undefined, { x: 0, y: 0 }, 0, 'Not configured');
setPipeline('new', 'Untitled Pipeline', 'draft', [triggerNode], []);
```

- [ ] **Step 5: Update the hydration useEffect to inject trigger node**

In the hydration useEffect (~line 354), after the `setPipeline(...)` calls (both the layout and non-layout branches), inject the trigger node. The trigger node must be added after layout (if applicable) so it can be positioned relative to the entry node.

Find the block that calls `setPipeline` (both `needsLayout` and non-layout paths). In both cases, after the nodes and edges are ready, append the trigger node and edge.

For the **non-layout path** (the `else` branch around line 395), replace:

```typescript
setPipeline(pipelineData._id, pipelineData.name, pipelineData.status, rfNodes, rfEdges);
```

With:

```typescript
// Determine entry node
const computedEntryId = pipelineData.entryNodeId ?? findEntryNodeId(pipelineData.nodes ?? []);
const entryNode = rfNodes.find((n) => n.id === computedEntryId);
const entryPos = entryNode?.position ?? { x: 0, y: 0 };

const summary = buildTriggerSummary(
  /* selectedTriggers are set in the next block; use [] for initial render */
  [],
  triggerDefsData?.data ?? [],
);
const { triggerNode, triggerEdge } = createTriggerElements(computedEntryId, entryPos, 0, summary);

setPipeline(
  pipelineData._id,
  pipelineData.name,
  pipelineData.status,
  [triggerNode, ...rfNodes],
  triggerEdge ? [triggerEdge, ...rfEdges] : rfEdges,
);
```

For the **layout path** (the `autoLayout(...).then(...)` around line 385), replace:

```typescript
autoLayout(rfNodes, rfEdges).then((layoutedNodes) => {
  setPipeline(pipelineData._id, pipelineData.name, pipelineData.status, layoutedNodes, rfEdges);
});
```

With:

```typescript
autoLayout(rfNodes, rfEdges).then((layoutedNodes) => {
  const computedEntryId = pipelineData.entryNodeId ?? findEntryNodeId(pipelineData.nodes ?? []);
  const entryNode = layoutedNodes.find((n) => n.id === computedEntryId);
  const entryPos = entryNode?.position ?? { x: 0, y: 0 };

  const summary = buildTriggerSummary([], triggerDefsData?.data ?? []);
  const { triggerNode, triggerEdge } = createTriggerElements(computedEntryId, entryPos, 0, summary);

  setPipeline(
    pipelineData._id,
    pipelineData.name,
    pipelineData.status,
    [triggerNode, ...layoutedNodes],
    triggerEdge ? [triggerEdge, ...rfEdges] : rfEdges,
  );
});
```

- [ ] **Step 6: Update `handleSave` — filter trigger node, fix stale closure**

Replace the entire body of `handleSave` callback (~line 433). Key changes:

1. Read `selectedTriggers` from `getState()` instead of closure (fixes stale closure bug)
2. Filter out trigger node/edges before `toPipelineNodes`
3. Derive `entryNodeId` from trigger edge

```typescript
const handleSave = useCallback(async () => {
  if (!pipelineId) return;

  // Read latest state to avoid stale closures
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

  try {
    if (pipelineId === 'new') {
      const res = await apiFetch('/api/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          name: latestState.pipelineName,
          nodes: backendNodes,
          entryNodeId,
          triggerSelections,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Save failed' }));
        toast.error(body.error ?? 'Failed to save pipeline');
        return;
      }

      const created = await res.json();
      markSaved();
      toast.success('Pipeline created');
      navigate(`/projects/${projectId}/pipelines/${created._id}`);
    } else {
      const res = await apiFetch(`/api/pipelines/${pipelineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: latestState.pipelineName,
          nodes: backendNodes,
          entryNodeId,
          triggerSelections,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Save failed' }));
        toast.error(body.error ?? 'Failed to save pipeline');
        return;
      }

      markSaved();
      mutatePipeline();
      toast.success('Pipeline saved');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    toast.error(`Save failed: ${message}`);
  }
}, [pipelineId, projectId, markSaved, mutatePipeline, navigate]);
```

Note: The `useCallback` dependency array now omits `pipelineName` and `selectedTriggers` because both are read from `getState()` inside.

- [ ] **Step 7: Update `handleValidate` — exclude trigger node**

In `handleValidate` (~line 500), change the `topLevelNodes` filter:

```typescript
const topLevelNodes = nodes.filter((n) => !n.parentId && n.id !== TRIGGER_NODE_ID);
```

Also in the per-node label check loop (~line 534), exclude the trigger node:

```typescript
for (const node of nodes) {
  if (node.id === TRIGGER_NODE_ID) continue;
  // ... existing label check
}
```

- [ ] **Step 8: Add trigger data sync useEffect**

After the existing hydration useEffect and before the cleanup useEffect, add a new `useEffect` that syncs the trigger node's data when `selectedTriggers` changes:

```typescript
// ── Sync trigger node data when selectedTriggers changes ──
useEffect(() => {
  const state = usePipelineEditorStore.getState();
  const hasTriggerNode = state.nodes.some((n) => n.id === TRIGGER_NODE_ID);
  if (!hasTriggerNode) return;

  const triggerDefs = triggerDefsData?.data ?? [];
  const summary = buildTriggerSummary(selectedTriggers, triggerDefs);
  state.updateNodeData(TRIGGER_NODE_ID, {
    triggerCount: selectedTriggers.length,
    triggerSummary: summary,
  });
}, [selectedTriggers, triggerDefsData]);
```

This subscribes to `selectedTriggers` from the store (already subscribed at ~line 291) and updates the trigger node's visual data whenever the user toggles triggers in the config panel.

- [ ] **Step 9: Verify full build**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=studio 2>&1 | tail -20`
Expected: Build succeeds with no type errors.

- [ ] **Step 10: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineEditorPage.tsx
git add apps/studio/src/components/pipelines/PipelineEditorPage.tsx
git commit -m "feat(studio): synthesize trigger node on load, filter on save, sync data"
```

---

## Chunk 4: Final Verification

### Task 9: Full build and manual smoke test

- [ ] **Step 1: Run full monorepo build**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build 2>&1 | tail -20`
Expected: All packages build successfully.

- [ ] **Step 2: Run existing tests**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm test 2>&1 | tail -30`
Expected: All existing tests pass (no regressions).

- [ ] **Step 3: Manual verification checklist**

Start the studio dev server and open the pipeline editor:

1. **New pipeline**: Trigger node appears at (0,0), labeled "Trigger", shows "Not configured", has amber left accent
2. **Click trigger node**: Right panel opens with "Trigger Configuration" header and trigger checkboxes
3. **Select 2 triggers**: Trigger node body updates to show types (e.g. "Kafka, Manual") and badge "2 configured"
4. **Drag trigger node**: Can reposition. Cannot delete via keyboard or any other means
5. **Connect trigger to a node**: Edge appears from trigger to the target node
6. **Reconnect trigger**: Dragging from trigger to a different node replaces the old edge
7. **Save and reload**: Pipeline saves correctly, reloads with trigger node pointing to the correct entry node
8. **Toolbar**: No trigger button/popover in the toolbar
9. **Auto-layout**: Trigger node repositions above entry node when layout runs
10. **Validation**: Trigger node does not appear in validation warnings/errors
