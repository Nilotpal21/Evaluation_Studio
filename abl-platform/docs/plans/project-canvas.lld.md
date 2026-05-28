# Project Canvas / Topology -- Low-Level Design

## Implementation Structure

The Project Canvas is implemented entirely within `apps/studio` with the following module structure:

```
apps/studio/src/
  components/canvas/
    ProjectCanvas.tsx        -- Main canvas component (~850 LOC)
    transform.ts             -- Topology-to-ReactFlow conversion (~224 LOC)
    types.ts                 -- Types and layout configs (~174 LOC)
    index.ts                 -- Barrel exports
    CanvasControls.tsx       -- Toolbar widget
    CanvasLegend.tsx         -- Relationship legend
    CanvasSidePanel.tsx      -- Side panel container
    AgentDetailPanel.tsx     -- Agent detail panel (legacy)
    ConnectionTypePicker.tsx -- Connection creation/edit modal (~597 LOC)
    hooks/
      useAutoLayout.ts       -- ELK.js layout hook (~146 LOC)
    nodes/
      AgentNode.tsx          -- Agent node renderer (~302 LOC)
      EscalationTargetNode.tsx
      index.ts
    edges/
      RelationshipEdge.tsx   -- Edge renderer with popover (~205 LOC)
      EdgePopover.tsx        -- Edge action menu
      EdgeMarkerDefs.tsx     -- SVG arrow markers
      index.ts
  components/topology/
    TopologyCanvas.tsx       -- Legacy SVG-based read-only view
  store/
    canvas-store.ts          -- Three Zustand stores (~180 LOC)
  lib/agent-canvas/
    dsl-updater.ts           -- DSL parsing and mutation
  types/
    arch.ts                  -- TopologyData, TopologyNode, TopologyEdge
```

---

## Module Detail: transform.ts

### Pattern Detection

```typescript
detectTopologyPattern(nodes, edges) -> TopologyPattern
```

- If any node has `type === 'supervisor'` -> `'tree'`
- Else if bidirectional edge pairs > 30% of total edges -> `'mesh'`
- Else -> `'chain'`

Each pattern maps to a different ELK layout configuration:

- `tree`: layered DOWN, 140px between layers, 100px between nodes
- `mesh`: layered RIGHT, 120px between nodes
- `chain`: layered RIGHT, 80px between nodes

### Rank Assignment

BFS from the entry node assigns ranks (0, 1, 2, ...) used for stagger animation delays (80ms per rank level). Unreachable nodes get rank 1.

### Node/Edge Conversion

`topologyToReactFlowNodes` maps TopologyNodes to ReactFlow nodes with `AgentNodeData` and TopologyEdges to ReactFlow edges with `RelationshipEdgeData`. Edge types are mapped: `handoff` -> `handoff`, `routing` -> `delegate`, `escalation` -> `escalate`.

---

## Module Detail: useAutoLayout Hook

### Flow

1. Convert ReactFlow nodes/edges to ELK graph input (`nodesToElkGraph`)
2. Lazily import `elkjs/lib/elk.bundled.js` (singleton)
3. Call `elk.layout(graph, { layoutOptions })` asynchronously
4. Apply ELK positions to nodes (`applyElkPositions`)
5. Merge with persisted positions from localStorage (`mergeWithPersistedPositions`)
6. Track `isComputing` and `layoutReady` states

### Cancellation

A `computeIdRef` counter ensures stale layout results (from superseded computations) are discarded.

### Entry Node Constraint

Entry nodes and supervisors get `elk.layered.layerConstraint: 'FIRST'` to force them to the top/left of the layout.

---

## Module Detail: canvas-store.ts

### Store 1: Viewport (60fps updates)

- `zoom`, `position`, `semanticZoomLevel`
- Hysteresis thresholds prevent flickering:
  - full -> summary: zoom < 0.57
  - summary -> full: zoom >= 0.63
  - summary -> compact: zoom < 0.27
  - compact -> summary: zoom >= 0.33

### Store 2: Selection (click-rate updates)

- `selectedNodeIds`, `selectedEdgeIds`, `hoveredNodeId`
- `sidePanelContent` for node/edge detail panels

### Store 3: Canvas Data (persisted)

- `nodePositions[projectId][nodeId]` -> XYPosition
- `projectViewports[projectId]` -> Viewport
- LRU eviction at 20 projects (`trimToRecent`)
- `resetLayout(projectId)` clears all positions for a project

---

## Module Detail: AgentNode

### Semantic Zoom Rendering

| Zoom Level | Badge Visibility | Content                                                     |
| ---------- | ---------------- | ----------------------------------------------------------- |
| full       | All              | Name, type/mode badges, goal, model, tool/step/field counts |
| summary    | Type + mode      | Name, type/mode badges, entry badge                         |
| compact    | None             | Name only, pill shape (rounded-full)                        |

### Visual Indicators

- **Supervisor**: left accent bar (3px), accent-colored type badge
- **Entry**: green pulsing dot (top-left), star icon in header, green glow shadow
- **Errors**: error border, error count badge
- **Selected**: ring-2 ring-accent with glow shadow

### Model Formatting

Model names are shortened via regex patterns (e.g., `claude-opus-4-6` -> `Opus 4.6`, `gpt-4o` -> `GPT-4o`). Names exceeding 20 characters are truncated with ellipsis.

---

## Module Detail: RelationshipEdge

### Visual Differentiation

| Type     | Color                       | Dash  | Default Opacity |
| -------- | --------------------------- | ----- | --------------- |
| handoff  | `hsl(var(--edge-handoff))`  | solid | 0.3             |
| delegate | `hsl(var(--edge-delegate))` | `8 5` | 0.45            |
| escalate | `hsl(var(--edge-escalate))` | `2 4` | 0.3             |

### Interaction States

- **Default**: subtle color, thin stroke, low opacity
- **Hover**: brighter color, thicker stroke (2px), glow filter, tooltip label
- **Selected**: full opacity, thickest stroke (2.5px), stronger glow, EdgePopover appears

### CustomEvent Communication

Edge actions dispatch window CustomEvents to avoid prop drilling:

- `canvas-edge-delete` -> ProjectCanvas removes handoff/delegate from DSL
- `canvas-edge-edit` -> ProjectCanvas opens ConnectionTypePicker in edit mode
- `canvas-edge-change-type` -> ProjectCanvas removes old type, creates new type

---

## Module Detail: ConnectionTypePicker

Two-step modal flow:

1. **Type Selection**: Handoff or Delegate buttons
2. **Configuration Form**:
   - Handoff: when (required), priority, summary, pass variables, history strategy, return checkbox
   - Delegate: when (required), purpose (required), input mapping (key-value rows), returns mapping, timeout

Supports both create mode (fresh form) and edit mode (pre-populated from existing relationship).

---

## Module Detail: dsl-updater.ts

### Operations

| Function              | Purpose                                  |
| --------------------- | ---------------------------------------- |
| `parseSummary`        | Extract goal, persona, supervisor status |
| `parseTools`          | Extract tool list from DSL               |
| `parseRelationships`  | Extract handoffs and delegates           |
| `removeHandoff`       | Remove a handoff by index (regex-based)  |
| `removeDelegate`      | Remove a delegate by index (regex-based) |
| `addHandoff`          | Append a handoff to DSL (regex-based)    |
| `addDelegate`         | Append a delegate to DSL (regex-based)   |
| `updateHandoffField`  | Update a specific field on a handoff     |
| `updateDelegateField` | Update a specific field on a delegate    |

### Approach

Read operations use `@abl/core`'s `parseAgentBasedABL` parser. Write operations use regex-based string manipulation because `@abl/core` does not have a serializer. This is fragile but sufficient for structured operations on the `HANDOFF:` and `DELEGATE:` sections.

---

## Known Gaps

| Gap   | Description                                 | Recommendation                                           |
| ----- | ------------------------------------------- | -------------------------------------------------------- |
| GAP-1 | No unit tests for transform.ts              | Pure functions, easy to test                             |
| GAP-2 | No unit tests for canvas-store.ts           | Zustand stores are pure, testable without DOM            |
| GAP-3 | No component tests for AgentNode            | Use @testing-library/react with different zoom levels    |
| GAP-4 | No E2E tests for connection creation        | Needs React Flow test harness                            |
| GAP-5 | DSL mutations are regex-based               | Replace with @abl/language-service serializer when ready |
| GAP-6 | CustomEvent-based edge communication        | Consider React context or zustand for edge actions       |
| GAP-7 | Agent-level drill-in canvas not implemented | Separate feature                                         |
