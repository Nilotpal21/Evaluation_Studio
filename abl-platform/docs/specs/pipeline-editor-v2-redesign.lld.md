# Pipeline Editor V2 Redesign — Low-Level Design

## Task T-1: Graph Builder Rewrite

### Files to Modify

- `apps/studio/src/components/search-ai/pipelines/v2/graph-builder.ts` — full rewrite of layout logic

### Changes

1. Remove all InsertPoint node generation (the `insert-` prefixed nodes and their edges)
2. Remove `INSERT_POINT_SIZE` and `INSERT_POINT_OFFSET` constants
3. Reduce `COLUMN_GAP` from 340 to 200
4. Replace separate Ingress + Router nodes with single `compoundIngress` node at x=0
5. Replace Merge + EmbeddingFields + Embedding + OpenSearch (4 nodes) with single `compoundOutput` node
6. Add `flowName` and `flowPriority` to each flow lane's first edge data for lane header rendering
7. Add `V2NodeData` fields: `embeddingProvider`, `embeddingModel`, `embeddingDimensions` to compoundOutput data

### Layout Math (after)

```
CompoundIngress (x=0) → Stage1 (x=200) → Stage2 (x=400) → Stage3 (x=600) → CompoundOutput (x=800)
Total width: ~1000px for 3-stage flow. Fits at 100% in canvas.
```

### Acceptance Criteria

- AC-1: Graph for 2-flow, 3-stage pipeline produces exactly 2 + (stages per flow) + 2 = ~8-10 nodes (no insert points)
- AC-2: No node with `nodeType: 'insertPoint'` in output
- AC-3: One node with `nodeType: 'compoundIngress'`, one with `nodeType: 'compoundOutput'`

---

## Task T-2: Compound Node Components

### Files to Create

- `apps/studio/src/components/search-ai/pipelines/v2/nodes/CompoundIngressNode.tsx`
- `apps/studio/src/components/search-ai/pipelines/v2/nodes/CompoundOutputNode.tsx`

### CompoundIngressNode

- Shows: file icon + "Documents" label + router icon + "Content Router" + flow count badge
- Single source handle on right
- Muted styling (dashed border, reduced opacity) — Tier 2 visual hierarchy
- Non-interactive (no click handler)
- Uses `getIntentStyles('muted')` from design tokens

### CompoundOutputNode

- Shows: stacked list: "Embedding: {model}" + "OpenSearch" with status dots
- Single target handle on left
- Clickable: dispatches selection to detail panel for embedding info
- Data from graph-builder: `embeddingProvider`, `embeddingModel`, `embeddingDimensions`
- Uses `getIntentStyles('success')` for embedding, `getIntentStyles('muted')` for container

### Acceptance Criteria

- AC-1: CompoundIngressNode renders with Documents + Router + flow count
- AC-2: CompoundOutputNode renders with Embedding model name + OpenSearch
- AC-3: CompoundOutputNode click dispatches `selectNode('compoundOutput')` to store

---

## Task T-3: DetailPanel + Context Switching

### Files to Create

- `apps/studio/src/components/search-ai/pipelines/v2/DetailPanel.tsx`

### Store Changes (in T-4)

Add to `pipeline-store.ts`:

```typescript
detailPanelMode: 'empty' | 'stage' | 'flow' | 'version' | 'embedding';
selectedNodeId: string | null;
setDetailPanelMode: (mode, nodeId?) => void;
```

### DetailPanel Component

- 420px width, `h-full`, flex column, `border-l border-default bg-background-elevated`
- Content switches based on `detailPanelMode`:

| Mode        | Content                                                             | Triggered By                          |
| ----------- | ------------------------------------------------------------------- | ------------------------------------- |
| `empty`     | Icon + "Select a stage or flow to configure"                        | Default / click empty canvas / Escape |
| `stage`     | Provider dropdown + config form (reuse StageExpandedForm logic)     | Click stage node                      |
| `flow`      | Placeholder: "Flow configuration coming soon"                       | Click flow lane header (future)       |
| `version`   | Placeholder: "Version history coming soon"                          | Toolbar Version button                |
| `embedding` | Read-only: provider, model, dimensions, "Configure via KB Settings" | Click CompoundOutput                  |

### Stage Config Mode (reuse existing logic)

- Move provider dropdown + config forms from `StageExpandedForm.tsx` into DetailPanel
- Show: flow name breadcrumb, stage type label, provider Select, config form, Apply/Reset buttons
- Reuse: `PROVIDERS_BY_TYPE`, `DoclingConfig`, `LlamaIndexConfig`, `TreeBuilderConfig`, `ChunkingConfig`, `EnrichmentConfig`
- Complex providers (http-webhook, javascript-sandbox) still open overlay panels

### Acceptance Criteria

- AC-1: DetailPanel renders in all 5 modes
- AC-2: Stage mode shows provider dropdown and config form
- AC-3: Embedding mode shows read-only info
- AC-4: Empty mode shown when nothing selected

---

## Task T-4: Layout Rewire

### Files to Modify

- `apps/studio/src/components/search-ai/pipelines/v2/PipelineEditorV2.tsx` — layout restructure
- `apps/studio/src/components/search-ai/pipelines/v2/PipelineCanvasV2.tsx` — node registry update
- `apps/studio/src/store/pipeline-store.ts` — add detailPanelMode state

### PipelineEditorV2 Changes

```tsx
// BEFORE:
<FlowsSidebar />
<Canvas />
<ConfigSidePanel overlay />
<ScriptSidePanel overlay />
<EmbeddingFieldsDrawer overlay />

// AFTER:
<div className="flex flex-1 overflow-hidden">
  <div className="relative flex flex-1 flex-col overflow-hidden">
    <PipelineCanvasV2 />
  </div>
  <DetailPanel />
</div>
// ConfigSidePanel and ScriptSidePanel remain as overlays for complex providers only
```

### PipelineCanvasV2 Changes

- Remove from nodeTypes: `ingress`, `router`, `merge`, `embeddingFields`, `insertPoint`
- Add to nodeTypes: `compoundIngress`, `compoundOutput`
- Keep: `stage`, `sharedStage`
- Move MiniMap to `position="bottom-left"`
- Update `onNodeClick` to dispatch `setDetailPanelMode('stage', stageId)` for stage nodes, `setDetailPanelMode('embedding')` for compoundOutput
- Add `onPaneClick` to reset to empty mode

### Store Changes

- Add `detailPanelMode` and `selectedNodeId` fields
- Add `setDetailPanelMode` action
- Remove `expandedStageId` (replaced by `selectedNodeId` + `detailPanelMode`)
- Keep `activePanelType` for complex provider overlays only

### Acceptance Criteria

- AC-1: No FlowsSidebar in rendered layout
- AC-2: DetailPanel visible as 420px right panel in flex layout
- AC-3: Click stage → detail panel shows stage config
- AC-4: Click empty canvas → detail panel shows empty state
- AC-5: CompoundOutput click → detail panel shows embedding info

---

## Task T-5: StageNode Cleanup

### Files to Modify

- `apps/studio/src/components/search-ai/pipelines/v2/nodes/StageNode.tsx`

### Changes

1. Remove `import { StageExpandedForm }` and all expanded form rendering
2. Remove `expandedStageId` subscription from store
3. Remove `isExpanded` logic and `ring-2 ring-accent` conditional (selection ring now based on `selectedNodeId`)
4. Remove `GripVertical` import and icon rendering
5. Remove `minWidth: 340` expanded style
6. Add: subscribe to `selectedNodeId` from store, show accent ring when `selectedNodeId === stageId`
7. Keep: colored left bar, stage type label, provider name, status badge, click handler

### Acceptance Criteria

- AC-1: No inline StageExpandedForm rendered
- AC-2: No GripVertical icon
- AC-3: Accent ring shown when node is selected in store
- AC-4: Click dispatches to detail panel (handled by canvas onNodeClick)

---

## Task T-6: Toolbar + Default Pipeline Fix

### Files to Modify

- `apps/studio/src/components/search-ai/pipelines/v2/PipelineToolbar.tsx` — add + Add Flow, wire Version
- `apps/studio/src/components/search-ai/pipelines/v2/PipelineSelector.tsx` — remove Lock icon for default
- `apps/studio/src/components/search-ai/pipelines/v2/DefaultPipelineBanner.tsx` — remove/hide

### PipelineToolbar Changes

- Add `+ Add Flow` button (Plus icon) — shows toast "Coming in next phase" for now (flow creation modal is Phase 2)
- Wire Version History button to dispatch `setDetailPanelMode('version')` instead of toast
- Keep: Save Draft, Validate, Deploy buttons unchanged

### PipelineSelector Changes

- Remove `Lock` icon next to "Default Pipeline" in dropdown
- Remove `Lock` icon in trigger button when `isDefaultView`
- Keep: dropdown switching, create button disabled when pipeline exists

### DefaultPipelineBanner

- Remove the import and rendering from PipelineEditorV2.tsx
- The component file stays (no delete during feature work) but is no longer rendered

### Acceptance Criteria

- AC-1: "+ Add Flow" button visible in toolbar
- AC-2: Version History button opens detail panel in version mode (not toast)
- AC-3: No Lock icon shown for Default Pipeline
- AC-4: No "stages are locked" banner shown
