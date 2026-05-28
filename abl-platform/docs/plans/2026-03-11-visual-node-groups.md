# Visual Node Groups Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render node-group children as visual nodes inside a dashed container on the pipeline canvas, replacing the nested-list config panel approach.

**Architecture:** Backend stores children as nested `GroupChildNode[]` inside the parent `PipelineNode`. On hydration, `toReactFlowNodes()` flattens children into separate React Flow nodes with `parentId` pointing at the group. On save, `toPipelineNodes()` collects child nodes back into the parent's `children[]`. A new `PipelineGroupNode` custom component renders the dashed container with header/handles.

**Tech Stack:** React Flow v12 (`@xyflow/react`), Zustand store, Tailwind CSS, lucide-react icons, ELK auto-layout

---

## File Map

| Action | File                                                             | Responsibility                                                       |
| ------ | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| Create | `apps/studio/src/components/pipelines/PipelineGroupNode.tsx`     | Dashed-border group container with header, handles, auto-sizing      |
| Modify | `apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx`   | Register `pipelineGroupNode` type, drop-into-group detection         |
| Modify | `apps/studio/src/components/pipelines/PipelineEditorPage.tsx`    | Flatten/unflatten children in conversion helpers                     |
| Modify | `apps/studio/src/components/pipelines/PipelineNodeComponent.tsx` | Revert children indicator (Layers icon), remove `children` from data |
| Modify | `apps/studio/src/components/pipelines/NodeConfigPanel.tsx`       | Remove nested children list UI                                       |
| Modify | `apps/studio/src/store/pipeline-editor-store.ts`                 | Group-aware `removeNode`, `addChildNode` action                      |
| Modify | `apps/studio/src/components/pipelines/usePipelineAutoLayout.ts`  | Handle group node sizing, exclude children from top-level layout     |

---

## Chunk 1: Group Node Component + Canvas Registration

### Task 1: Create PipelineGroupNode component

**Files:**

- Create: `apps/studio/src/components/pipelines/PipelineGroupNode.tsx`

This component renders the dashed-border group container. It does NOT render children — React Flow handles that automatically via `parentId`. The component just provides the visual container, header, and connection handles.

- [ ] **Step 1: Create PipelineGroupNode.tsx**

```tsx
/**
 * PipelineGroupNode
 *
 * Custom React Flow node for parallel group containers.
 * Renders a dashed-border container with header label, child count badge,
 * and source/target handles. Children are rendered by React Flow via parentId.
 */

'use client';

import { memo, type CSSProperties } from 'react';
import { Handle, Position, useNodes } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import { Layers } from 'lucide-react';
import { clsx } from 'clsx';

// =============================================================================
// Types
// =============================================================================

export interface PipelineGroupNodeData extends Record<string, unknown> {
  label: string;
  timeout?: number;
  retries?: number;
  onFailure?: 'stop' | 'skip' | 'continue';
}

type PipelineGroupNodeType = Node<PipelineGroupNodeData, 'pipeline-group-node'>;

// =============================================================================
// Constants
// =============================================================================

export const GROUP_HEADER_HEIGHT = 44;
export const GROUP_PADDING_X = 20;
export const GROUP_PADDING_TOP = GROUP_HEADER_HEIGHT + 12;
export const GROUP_PADDING_BOTTOM = 20;
export const CHILD_GAP = 20;

// =============================================================================
// Component
// =============================================================================

function PipelineGroupNodeComponent({ id, data, selected }: NodeProps<PipelineGroupNodeType>) {
  const allNodes = useNodes();
  const childCount = allNodes.filter((n) => n.parentId === id).length;

  return (
    <div
      className={clsx(
        'rounded-xl flex flex-col',
        'transition-shadow duration-200 ease-out',
        'border-2 border-dashed',
        selected
          ? 'border-purple-400 bg-purple-500/5 shadow-lg shadow-purple-500/10'
          : 'border-purple-500/40 bg-purple-500/[0.02] hover:border-purple-500/60',
      )}
      style={{ width: '100%', height: '100%' }}
      role="group"
      aria-label={`Node group: ${data.label}`}
    >
      {/* Target handle (top) */}
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-purple-400 !border-2 !border-background-elevated !w-2.5 !h-2.5"
      />

      {/* Header */}
      <div
        className="flex items-center gap-2 px-4 shrink-0"
        style={{ height: GROUP_HEADER_HEIGHT }}
      >
        <Layers className="w-4 h-4 text-purple-400 shrink-0" />
        <span className="text-sm font-semibold text-foreground truncate" title={data.label}>
          {data.label}
        </span>
        <span className="ml-auto inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20 shrink-0">
          {childCount} node{childCount !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Body — children render here via React Flow parentId mechanism */}
      <div className="flex-1 min-h-0" />

      {/* Source handle (bottom) */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-purple-400 !border-2 !border-background-elevated !w-2.5 !h-2.5"
      />
    </div>
  );
}

export const PipelineGroupNode = memo(PipelineGroupNodeComponent);
```

- [ ] **Step 2: Verify file was created correctly**

Run: `npx tsc --noEmit --project apps/studio/tsconfig.json 2>&1 | head -20`
Expected: No errors related to PipelineGroupNode

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineGroupNode.tsx
git add apps/studio/src/components/pipelines/PipelineGroupNode.tsx
git commit -m "feat(studio): add PipelineGroupNode component for visual node groups"
```

### Task 2: Register group node type in canvas

**Files:**

- Modify: `apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx`

Register `pipelineGroupNode` in the React Flow `nodeTypes` map so the canvas knows how to render it.

- [ ] **Step 1: Add import and registration**

In `PipelineGraphCanvas.tsx`, add the import:

```tsx
import { PipelineGroupNode } from './PipelineGroupNode';
```

Update the nodeTypes object:

```tsx
const pipelineNodeTypes: NodeTypes = {
  pipelineNode: PipelineNode,
  pipelineGroupNode: PipelineGroupNode,
};
```

- [ ] **Step 2: Build to verify**

Run: `pnpm build --filter=@agent-platform/studio 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx
git add apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx
git commit -m "feat(studio): register PipelineGroupNode in canvas node types"
```

---

## Chunk 2: Conversion Helpers (Flatten/Unflatten)

### Task 3: Rewrite toReactFlowNodes to flatten group children

**Files:**

- Modify: `apps/studio/src/components/pipelines/PipelineEditorPage.tsx`

The conversion from backend format to React Flow format must:

1. For `node-group` nodes: create a `pipelineGroupNode` with calculated dimensions, then create child `pipelineNode`s with `parentId` and relative positions
2. For regular nodes: same as before

**Important constants for sizing:**

- `PIPELINE_NODE_WIDTH = 220`, `PIPELINE_NODE_HEIGHT = 100` (from PipelineNodeComponent)
- `GROUP_PADDING_X = 20`, `GROUP_PADDING_TOP = 56`, `GROUP_PADDING_BOTTOM = 20`, `CHILD_GAP = 20` (from PipelineGroupNode)

- [ ] **Step 1: Add imports**

Add to imports in `PipelineEditorPage.tsx`:

```tsx
import {
  GROUP_PADDING_X,
  GROUP_PADDING_TOP,
  GROUP_PADDING_BOTTOM,
  CHILD_GAP,
  GROUP_HEADER_HEIGHT,
} from './PipelineGroupNode';
import { PIPELINE_NODE_WIDTH, PIPELINE_NODE_HEIGHT } from './PipelineNodeComponent';
```

- [ ] **Step 2: Rewrite toReactFlowNodes**

Replace the existing `toReactFlowNodes` function:

```tsx
/**
 * Convert backend PipelineNode[] to React Flow Node[].
 * node-group nodes are split into a parent group node + child nodes with parentId.
 */
function toReactFlowNodes(pipelineNodes: BackendPipelineNode[]): Node[] {
  const result: Node[] = [];

  for (const pn of pipelineNodes) {
    if (pn.type === 'node-group' && pn.children && pn.children.length > 0) {
      // Calculate group dimensions based on child count
      const childCount = pn.children.length;
      const groupWidth = Math.max(
        280,
        GROUP_PADDING_X * 2 + childCount * PIPELINE_NODE_WIDTH + (childCount - 1) * CHILD_GAP,
      );
      const groupHeight = GROUP_PADDING_TOP + PIPELINE_NODE_HEIGHT + GROUP_PADDING_BOTTOM;

      // Create the group container node
      result.push({
        id: pn.id,
        type: 'pipelineGroupNode',
        position: pn.position ?? { x: 0, y: 0 },
        style: { width: groupWidth, height: groupHeight },
        data: {
          label: pn.label ?? 'Parallel Group',
          timeout: pn.timeout,
          retries: pn.retries,
          onFailure: pn.onFailure,
        },
      });

      // Create child nodes positioned horizontally inside the group
      for (let i = 0; i < pn.children.length; i++) {
        const child = pn.children[i];
        result.push({
          id: child.id,
          type: 'pipelineNode',
          parentId: pn.id,
          extent: 'parent' as const,
          position: {
            x: GROUP_PADDING_X + i * (PIPELINE_NODE_WIDTH + CHILD_GAP),
            y: GROUP_PADDING_TOP,
          },
          data: {
            label: child.label ?? child.type,
            activityType: child.type,
            category: 'compute', // enriched later
            config: child.config ?? {},
            timeout: child.timeout,
            retries: child.retries,
            onFailure: child.onFailure,
          } satisfies PipelineNodeData,
        });
      }
    } else {
      // Regular node (or empty group)
      result.push({
        id: pn.id,
        type: pn.type === 'node-group' ? 'pipelineGroupNode' : 'pipelineNode',
        position: pn.position ?? { x: 0, y: 0 },
        ...(pn.type === 'node-group'
          ? {
              style: {
                width: 280,
                height: GROUP_PADDING_TOP + PIPELINE_NODE_HEIGHT + GROUP_PADDING_BOTTOM,
              },
            }
          : {}),
        data:
          pn.type === 'node-group'
            ? {
                label: pn.label ?? 'Parallel Group',
                timeout: pn.timeout,
                retries: pn.retries,
                onFailure: pn.onFailure,
              }
            : ({
                label: pn.label ?? pn.type,
                activityType: pn.type,
                category: 'compute',
                config: pn.config ?? {},
                timeout: pn.timeout,
                retries: pn.retries,
                onFailure: pn.onFailure,
              } satisfies PipelineNodeData),
      });
    }
  }

  return result;
}
```

- [ ] **Step 3: Rewrite toPipelineNodes**

Replace the existing `toPipelineNodes` function to collect children back:

```tsx
/**
 * Convert React Flow nodes/edges back to backend PipelineNode[].
 * Nodes with parentId are collected as children of their parent group.
 */
function toPipelineNodes(nodes: Node[], edges: Edge[]): BackendPipelineNode[] {
  // Group edges by source
  const transitionsBySource = new Map<string, NodeTransition[]>();
  for (const edge of edges) {
    const transitions = transitionsBySource.get(edge.source) ?? [];
    const edgeData = edge.data as Record<string, unknown> | undefined;
    transitions.push({
      target: edge.target,
      condition: edgeData?.condition as string | undefined,
      label: edgeData?.label as string | undefined,
    });
    transitionsBySource.set(edge.source, transitions);
  }

  // Collect child nodes by parentId
  const childrenByParent = new Map<string, GroupChildNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const d = node.data as PipelineNodeData;
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push({
      id: node.id,
      type: d.activityType,
      label: d.label,
      config: (d.config as Record<string, unknown>) ?? {},
      timeout: d.timeout,
      retries: d.retries,
      onFailure: d.onFailure,
    });
    childrenByParent.set(node.parentId, siblings);
  }

  // Build top-level nodes only (skip children)
  return nodes
    .filter((node) => !node.parentId)
    .map((node) => {
      const isGroup = node.type === 'pipelineGroupNode';
      const d = node.data as Record<string, unknown>;

      if (isGroup) {
        return {
          id: node.id,
          type: 'node-group',
          label: d.label as string,
          config: {},
          transitions: transitionsBySource.get(node.id) ?? [],
          timeout: d.timeout as number | undefined,
          retries: d.retries as number | undefined,
          onFailure: d.onFailure as 'stop' | 'skip' | 'continue' | undefined,
          position: node.position,
          children: childrenByParent.get(node.id) ?? [],
        };
      }

      const nd = d as unknown as PipelineNodeData;
      return {
        id: node.id,
        type: nd.activityType,
        label: nd.label,
        config: (nd.config as Record<string, unknown>) ?? {},
        transitions: transitionsBySource.get(node.id) ?? [],
        timeout: nd.timeout,
        retries: nd.retries,
        onFailure: nd.onFailure,
        position: node.position,
      };
    });
}
```

- [ ] **Step 4: Update category enrichment in hydration effect**

In the `useEffect` that hydrates the store (around line 229), the enrichment loop must also handle child nodes (which have `parentId` and a `PipelineNodeData.activityType`). No change needed because the enrichment iterates ALL `rfNodes` regardless of parentId — just make sure it skips group nodes (which don't have `activityType` in data):

```tsx
// Enrich node categories from node type map
if (nodeTypeMap.size > 0) {
  rfNodes = rfNodes.map((node) => {
    const d = node.data as Record<string, unknown>;
    const activityType = d.activityType as string | undefined;
    if (!activityType) return node; // skip group nodes
    const typeDef = nodeTypeMap.get(activityType);
    if (typeDef) {
      return {
        ...node,
        data: { ...d, category: typeDef.category },
      };
    }
    return node;
  });
}
```

- [ ] **Step 5: Update validation handler**

In `handleValidate`, exclude child nodes (which have `parentId`) from the disconnected-node check since they're inside a group and don't have direct edges:

After `const issues: Array<{...}> = [];`, add:

```tsx
// Top-level nodes only (children are inside groups)
const topLevelNodes = nodes.filter((n) => !n.parentId);
```

Then replace `nodes` with `topLevelNodes` in the disconnected/label validation loops.

- [ ] **Step 6: Build to verify**

Run: `pnpm build --filter=@agent-platform/studio 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineEditorPage.tsx
git add apps/studio/src/components/pipelines/PipelineEditorPage.tsx
git commit -m "feat(studio): flatten/unflatten group children in React Flow conversion"
```

---

## Chunk 3: Revert Previous Nested-List Approach

### Task 4: Clean up PipelineNodeComponent

**Files:**

- Modify: `apps/studio/src/components/pipelines/PipelineNodeComponent.tsx`

Remove the `children` field from `PipelineNodeData`, the `Layers` import, and the child count indicator. Children are now separate React Flow nodes, not data on the parent.

- [ ] **Step 1: Remove children-related code**

1. Remove `Layers` from the lucide-react import
2. Remove `GroupChildNode` from the pipeline-engine import
3. Remove `children?: GroupChildNode[]` from `PipelineNodeData`
4. Remove the `isNodeGroup` and `childCount` variables
5. Remove the `{/* Node-group: child count indicator */}` JSX block

- [ ] **Step 2: Build to verify**

Run: `pnpm build --filter=@agent-platform/studio 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineNodeComponent.tsx
git add apps/studio/src/components/pipelines/PipelineNodeComponent.tsx
git commit -m "refactor(studio): remove children data from PipelineNodeData"
```

### Task 5: Clean up NodeConfigPanel

**Files:**

- Modify: `apps/studio/src/components/pipelines/NodeConfigPanel.tsx`

Remove the entire nested children management UI. Child nodes are now clicked directly on the canvas, which opens the normal config panel for them.

- [ ] **Step 1: Remove children-related imports and code**

1. Remove `useState` from react import (if not used elsewhere)
2. Remove `Plus, Trash2, ChevronDown, ChevronRight, Layers` from lucide import (keep `X`)
3. Remove `GroupChildNode` from pipeline-engine import
4. Remove `clsx` import if unused after cleanup
5. Remove all the children management state and handlers:
   - `isNodeGroup`, `children` memo
   - `childNodeTypeOptions` memo
   - `expandedChildren` state and `toggleChildExpanded`
   - `handleAddChild`, `handleRemoveChild`, `handleChildFieldChange`, `handleChildConfigChange`
6. Remove the entire `{/* Node-group children section */}` JSX block (lines 256-423)

- [ ] **Step 2: Build to verify**

Run: `pnpm build --filter=@agent-platform/studio 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/NodeConfigPanel.tsx
git add apps/studio/src/components/pipelines/NodeConfigPanel.tsx
git commit -m "refactor(studio): remove nested children list from NodeConfigPanel"
```

---

## Chunk 4: Store + Canvas Interaction Updates

### Task 6: Update store for group-aware operations

**Files:**

- Modify: `apps/studio/src/store/pipeline-editor-store.ts`

When removing a group node, also remove all child nodes (those with `parentId === nodeId`). Add an `addChildNode` action for adding a node inside a group with auto-positioning.

- [ ] **Step 1: Update removeNode**

Replace the existing `removeNode` implementation:

```tsx
removeNode: (nodeId) =>
  set((state) => {
    // Collect IDs to remove: the node itself + any children (if it's a group)
    const childIds = new Set(
      state.nodes.filter((n) => n.parentId === nodeId).map((n) => n.id),
    );
    const removeIds = new Set([nodeId, ...childIds]);

    return {
      nodes: state.nodes.filter((n) => !removeIds.has(n.id)),
      edges: state.edges.filter(
        (e) => !removeIds.has(e.source) && !removeIds.has(e.target),
      ),
      selectedNodeId: removeIds.has(state.selectedNodeId ?? '')
        ? null
        : state.selectedNodeId,
      isConfigPanelOpen: removeIds.has(state.selectedNodeId ?? '')
        ? false
        : state.isConfigPanelOpen,
      isDirty: true,
    };
  }),
```

- [ ] **Step 2: Add addChildNode action**

Add to the interface:

```tsx
addChildNode: (parentId: string, node: Node) => void;
```

Add to the store implementation:

```tsx
addChildNode: (parentId, node) =>
  set((state) => {
    // Count existing children to position the new one
    const siblings = state.nodes.filter((n) => n.parentId === parentId);
    const CHILD_GAP = 20;
    const CHILD_WIDTH = 220; // PIPELINE_NODE_WIDTH
    const PADDING_X = 20;    // GROUP_PADDING_X
    const PADDING_TOP = 56;  // GROUP_PADDING_TOP
    const PADDING_BOTTOM = 20;
    const CHILD_HEIGHT = 100; // PIPELINE_NODE_HEIGHT

    // Position new child after existing siblings
    const childNode: Node = {
      ...node,
      parentId,
      extent: 'parent' as const,
      position: {
        x: PADDING_X + siblings.length * (CHILD_WIDTH + CHILD_GAP),
        y: PADDING_TOP,
      },
    };

    // Resize the parent group to fit the new child
    const newChildCount = siblings.length + 1;
    const newGroupWidth = Math.max(
      280,
      PADDING_X * 2 + newChildCount * CHILD_WIDTH + (newChildCount - 1) * CHILD_GAP,
    );
    const newGroupHeight = PADDING_TOP + CHILD_HEIGHT + PADDING_BOTTOM;

    const updatedNodes = state.nodes.map((n) => {
      if (n.id === parentId) {
        return {
          ...n,
          style: { ...n.style, width: newGroupWidth, height: newGroupHeight },
        };
      }
      return n;
    });

    return {
      nodes: [...updatedNodes, childNode],
      isDirty: true,
    };
  }),
```

Also update `removeNode` to resize the group when a child is removed. After filtering out the removed node, recalculate the parent group's dimensions:

Actually, to keep it simpler, let's add a helper that recalculates group sizes. Update `removeNode` to handle child removal:

```tsx
removeNode: (nodeId) =>
  set((state) => {
    const targetNode = state.nodes.find((n) => n.id === nodeId);
    if (!targetNode) return state;

    const CHILD_GAP = 20;
    const CHILD_WIDTH = 220;
    const PADDING_X = 20;
    const PADDING_TOP = 56;
    const PADDING_BOTTOM = 20;
    const CHILD_HEIGHT = 100;

    // If removing a group, also remove all children
    if (!targetNode.parentId) {
      const childIds = new Set(
        state.nodes.filter((n) => n.parentId === nodeId).map((n) => n.id),
      );
      const removeIds = new Set([nodeId, ...childIds]);
      return {
        nodes: state.nodes.filter((n) => !removeIds.has(n.id)),
        edges: state.edges.filter(
          (e) => !removeIds.has(e.source) && !removeIds.has(e.target),
        ),
        selectedNodeId: removeIds.has(state.selectedNodeId ?? '')
          ? null
          : state.selectedNodeId,
        isConfigPanelOpen: removeIds.has(state.selectedNodeId ?? '')
          ? false
          : state.isConfigPanelOpen,
        isDirty: true,
      };
    }

    // Removing a child node — reposition siblings and resize parent
    const parentId = targetNode.parentId;
    const remainingSiblings = state.nodes.filter(
      (n) => n.parentId === parentId && n.id !== nodeId,
    );

    // Reposition remaining siblings
    const repositioned = new Map<string, { x: number; y: number }>();
    remainingSiblings.forEach((sib, i) => {
      repositioned.set(sib.id, {
        x: PADDING_X + i * (CHILD_WIDTH + CHILD_GAP),
        y: PADDING_TOP,
      });
    });

    const newGroupWidth = Math.max(
      280,
      PADDING_X * 2 +
        remainingSiblings.length * CHILD_WIDTH +
        Math.max(0, remainingSiblings.length - 1) * CHILD_GAP,
    );
    const newGroupHeight = PADDING_TOP + CHILD_HEIGHT + PADDING_BOTTOM;

    return {
      nodes: state.nodes
        .filter((n) => n.id !== nodeId)
        .map((n) => {
          if (n.id === parentId) {
            return { ...n, style: { ...n.style, width: newGroupWidth, height: newGroupHeight } };
          }
          const newPos = repositioned.get(n.id);
          if (newPos) {
            return { ...n, position: newPos };
          }
          return n;
        }),
      edges: state.edges.filter(
        (e) => e.source !== nodeId && e.target !== nodeId,
      ),
      selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
      isConfigPanelOpen: state.selectedNodeId === nodeId ? false : state.isConfigPanelOpen,
      isDirty: true,
    };
  }),
```

- [ ] **Step 3: Build to verify**

Run: `pnpm build --filter=@agent-platform/studio 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/store/pipeline-editor-store.ts
git add apps/studio/src/store/pipeline-editor-store.ts
git commit -m "feat(studio): group-aware removeNode and addChildNode in editor store"
```

### Task 7: Update canvas drop handler for drop-into-group

**Files:**

- Modify: `apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx`

When a node is dropped from the palette, check if the drop position falls inside a group node's bounds. If so, add it as a child of that group using `addChildNode`. If not, add as a top-level node.

Also: prevent connecting edges from/to child nodes (they're internal to the group).

- [ ] **Step 1: Add store import for addChildNode**

Update the store selectors in `PipelineGraphCanvasInner`:

```tsx
const addChildNode = usePipelineEditorStore((s) => s.addChildNode);
```

- [ ] **Step 2: Update onDrop to detect group targets**

Replace the `onDrop` callback:

```tsx
const onDrop = useCallback(
  (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();

    const raw = event.dataTransfer.getData('application/pipeline-node');
    if (!raw) return;

    let nodeType: NodeTypeDefinition;
    try {
      nodeType = JSON.parse(raw) as NodeTypeDefinition;
    } catch {
      return;
    }

    const position = screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });

    nodeIdCounter.current += 1;
    const nodeId = `node-${Date.now()}-${nodeIdCounter.current}`;

    // Check if dropped inside a group node
    const groupNode = nodes.find((n) => {
      if (n.type !== 'pipelineGroupNode') return false;
      const w = (n.style?.width as number) ?? 280;
      const h = (n.style?.height as number) ?? 200;
      return (
        position.x >= n.position.x &&
        position.x <= n.position.x + w &&
        position.y >= n.position.y &&
        position.y <= n.position.y + h
      );
    });

    // Don't allow nesting groups inside groups
    if (groupNode && nodeType.type === 'node-group') return;

    const nodeData: PipelineNodeData = {
      label: nodeType.label,
      activityType: nodeType.type,
      category: nodeType.category,
      config: {},
    };

    if (groupNode && nodeType.type !== 'node-group') {
      // Add as child of the group
      addChildNode(groupNode.id, {
        id: nodeId,
        type: 'pipelineNode',
        position: { x: 0, y: 0 }, // will be repositioned by addChildNode
        data: nodeData,
      });
    } else if (nodeType.type === 'node-group') {
      // Create an empty group node
      const GROUP_PADDING_TOP_VAL = 56;
      const GROUP_PADDING_BOTTOM_VAL = 20;
      const CHILD_HEIGHT_VAL = 100;
      addNode({
        id: nodeId,
        type: 'pipelineGroupNode',
        position,
        style: {
          width: 280,
          height: GROUP_PADDING_TOP_VAL + CHILD_HEIGHT_VAL + GROUP_PADDING_BOTTOM_VAL,
        },
        data: {
          label: nodeType.label,
          timeout: undefined,
          retries: undefined,
          onFailure: undefined,
        },
      });
    } else {
      // Regular top-level node
      addNode({
        id: nodeId,
        type: 'pipelineNode',
        position,
        data: nodeData,
      });
    }
  },
  [screenToFlowPosition, addNode, addChildNode, nodes],
);
```

- [ ] **Step 3: Update connection handler to prevent edges from/to child nodes**

Update `onConnect`:

```tsx
const onConnect = useCallback(
  (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    if (connection.source === connection.target) return;

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

- [ ] **Step 4: Build to verify**

Run: `pnpm build --filter=@agent-platform/studio 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx
git add apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx
git commit -m "feat(studio): drop-into-group detection and child node creation"
```

---

## Chunk 5: Auto-Layout and Final Polish

### Task 8: Update auto-layout for group nodes

**Files:**

- Modify: `apps/studio/src/components/pipelines/usePipelineAutoLayout.ts`

ELK auto-layout must:

1. Use the actual dimensions for group nodes (from `node.style`) instead of the fixed `PIPELINE_NODE_WIDTH/HEIGHT`
2. Exclude child nodes from the top-level layout (they're positioned inside their parent)

- [ ] **Step 1: Update nodesToElkGraph to handle groups and exclude children**

```tsx
function nodesToElkGraph(nodes: Node[], edges: Edge[]): ElkGraphInput {
  // Only include top-level nodes in the ELK layout
  const topLevelNodes = nodes.filter((n) => !n.parentId);

  // Edges: only between top-level nodes
  const topLevelIds = new Set(topLevelNodes.map((n) => n.id));

  return {
    id: 'root',
    children: topLevelNodes.map((node) => ({
      id: node.id,
      width: (node.style?.width as number) ?? PIPELINE_NODE_WIDTH,
      height: (node.style?.height as number) ?? PIPELINE_NODE_HEIGHT,
    })),
    edges: edges
      .filter((e) => topLevelIds.has(e.source) && topLevelIds.has(e.target))
      .map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
  };
}
```

- [ ] **Step 2: Update applyElkPositions to only move top-level nodes**

No change needed — `applyElkPositions` already matches by ID, and since ELK only returns top-level node positions, child nodes won't be found in the position map and will keep their relative positions.

- [ ] **Step 3: Build to verify**

Run: `pnpm build --filter=@agent-platform/studio 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/usePipelineAutoLayout.ts
git add apps/studio/src/components/pipelines/usePipelineAutoLayout.ts
git commit -m "feat(studio): update ELK auto-layout to handle group nodes"
```

### Task 9: Make child nodes non-draggable within group

**Files:**

- Modify: `apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx`

Child nodes should not be individually draggable (they auto-position). Set `draggable: false` on child nodes, or handle it in the `onNodesChange` handler by filtering out position changes for child nodes.

- [ ] **Step 1: Filter position changes for child nodes**

Update `onNodesChange`:

```tsx
const onNodesChange = useCallback(
  (changes: NodeChange[]) => {
    // Prevent dragging child nodes (they're auto-positioned inside groups)
    const filtered = changes.filter((change) => {
      if (change.type === 'position' && 'id' in change) {
        const node = nodes.find((n) => n.id === change.id);
        if (node?.parentId) return false;
      }
      return true;
    });
    setNodes(applyNodeChanges(filtered, nodes));
  },
  [nodes, setNodes],
);
```

- [ ] **Step 2: Build and verify**

Run: `pnpm build --filter=@agent-platform/studio 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx
git add apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx
git commit -m "feat(studio): prevent dragging child nodes within groups"
```

### Task 10: Final build + manual smoke test

- [ ] **Step 1: Full build**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: Build succeeds with no errors

- [ ] **Step 2: Run prettier on all changed files**

```bash
npx prettier --write \
  apps/studio/src/components/pipelines/PipelineGroupNode.tsx \
  apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx \
  apps/studio/src/components/pipelines/PipelineEditorPage.tsx \
  apps/studio/src/components/pipelines/PipelineNodeComponent.tsx \
  apps/studio/src/components/pipelines/NodeConfigPanel.tsx \
  apps/studio/src/store/pipeline-editor-store.ts \
  apps/studio/src/components/pipelines/usePipelineAutoLayout.ts
```

- [ ] **Step 3: Manual verification checklist**

Open `localhost:5173` and navigate to a pipeline with a node-group:

1. Group node renders as dashed purple container with header and child count badge
2. Child nodes render inside the group as regular pipeline node cards
3. Clicking a child node opens the config panel with that child's settings
4. Clicking the group background opens the config panel with group-level settings
5. Dropping a node from the palette onto the group adds it as a child
6. Dropping a node outside any group adds it as a top-level node
7. Deleting a group removes all its children
8. Deleting a child node removes it and repositions remaining siblings
9. Save/load round-trips correctly (children persist)
10. Auto-layout positions the group correctly alongside other nodes
