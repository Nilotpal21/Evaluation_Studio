# Pipeline Editor V2 -- Component Implementation Spec

> Faithfully translates `docs/wireframes/pipeline-v2-unified-canvas.html` (8850 lines) into an engineering specification. Every entry includes `[Source: line X-Y]` references back to the wireframe.

---

## 1. Design Token Extraction

All tokens are defined in the wireframe `:root` block. **Wireframe uses raw hex values for demo purposes. Implementation MUST use `@agent-platform/design-tokens` semantic tokens** (`getIntentStyles()`, `pipelineStageIntent()`, etc.).

> **Critical**: Do NOT create a parallel CSS variable color system from these hex values. The existing `PipelineCanvas.tsx` already correctly uses `pipelineStageIntent()` and `getIntentStyles()` from `@agent-platform/design-tokens`. All new pipeline components must follow this pattern.

### 1.1 Color Tokens

| Token                  | Wireframe Value             | Usage                       | Design System Mapping                                                                                                         | Source            |
| ---------------------- | --------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `--bg`                 | `#0f1117`                   | Page / app background       | `bg-background` (existing CSS var from globals.css)                                                                           | [Source: line 16] |
| `--bg-elevated`        | `#1a1d27`                   | Cards, panels, sidebar      | `bg-background-elevated` (existing)                                                                                           | [Source: line 17] |
| `--bg-surface`         | `#222531`                   | Inputs, nested surfaces     | `bg-background-muted` (existing)                                                                                              | [Source: line 18] |
| `--bg-hover`           | `#282b3a`                   | Hover states on surfaces    | `hover:bg-background-elevated` (existing)                                                                                     | [Source: line 19] |
| `--border`             | `#2a2d3a`                   | Default border              | `border-default` (existing)                                                                                                   | [Source: line 20] |
| `--border-hover`       | `#3d4155`                   | Hovered border              | `hover:border-muted` (existing)                                                                                               | [Source: line 21] |
| `--text`               | `#e2e8f0`                   | Primary text                | `text-foreground` (existing)                                                                                                  | [Source: line 22] |
| `--text-muted`         | `#8892a8`                   | Secondary text              | `text-foreground-muted` (existing)                                                                                            | [Source: line 23] |
| `--text-dim`           | `#5a6278`                   | Tertiary / disabled text    | `text-foreground-subtle` (existing)                                                                                           | [Source: line 24] |
| `--accent`             | `#6366f1`                   | Primary accent (indigo)     | `getIntentStyles('accent').text` / `.bg` / `.bgSubtle`                                                                        | [Source: line 25] |
| `--accent-hover`       | `#818cf8`                   | Accent hover state          | `hover:bg-accent` (existing)                                                                                                  | [Source: line 26] |
| `--accent-bg`          | `rgba(99, 102, 241, 0.12)`  | Accent background tint      | `getIntentStyles('accent').bgSubtle`                                                                                          | [Source: line 27] |
| `--success`            | `#22c55e`                   | Success states              | `getIntentStyles('success').text` / `.bg`                                                                                     | [Source: line 28] |
| `--success-bg`         | `rgba(34, 197, 94, 0.12)`   | Success background tint     | `getIntentStyles('success').bgSubtle`                                                                                         | [Source: line 29] |
| `--warning`            | `#f59e0b`                   | Warning states              | `getIntentStyles('warning').text` / `.bg`                                                                                     | [Source: line 30] |
| `--warning-bg`         | `rgba(245, 158, 11, 0.12)`  | Warning background tint     | `getIntentStyles('warning').bgSubtle`                                                                                         | [Source: line 31] |
| `--error`              | `#ef4444`                   | Error states                | `getIntentStyles('error').text` / `.bg`                                                                                       | [Source: line 32] |
| `--error-bg`           | `rgba(239, 68, 68, 0.12)`   | Error background tint       | `getIntentStyles('error').bgSubtle`                                                                                           | [Source: line 33] |
| `--extraction`         | `#8b5cf6`                   | Extraction stage color      | `pipelineStageIntent('extraction')` -> `'info'` -> `getIntentStyles('info')`                                                  | [Source: line 34] |
| `--extraction-bg`      | `rgba(139, 92, 246, 0.12)`  | Extraction tint             | `getIntentStyles('info').bgSubtle`                                                                                            | [Source: line 35] |
| `--chunking`           | `#06b6d4`                   | Chunking stage color        | `STAGE_INTENT_OVERRIDES['chunking']` -> `'info'` (see PipelineCanvas.tsx)                                                     | [Source: line 36] |
| `--chunking-bg`        | `rgba(6, 182, 212, 0.12)`   | Chunking tint               | `getIntentStyles('info').bgSubtle`                                                                                            | [Source: line 37] |
| `--enrichment`         | `#f59e0b`                   | Enrichment stage color      | `pipelineStageIntent('enrichment')` -> `'info'` -> `getIntentStyles('info')`                                                  | [Source: line 38] |
| `--enrichment-bg`      | `rgba(245, 158, 11, 0.12)`  | Enrichment tint             | `getIntentStyles('info').bgSubtle`                                                                                            | [Source: line 39] |
| `--embedding`          | `#22c55e`                   | Embedding stage color       | `STAGE_INTENT_OVERRIDES['embedding']` -> `'success'` -> `getIntentStyles('success')`                                          | [Source: line 40] |
| `--embedding-bg`       | `rgba(34, 197, 94, 0.12)`   | Embedding tint              | `getIntentStyles('success').bgSubtle`                                                                                         | [Source: line 41] |
| `--index`              | `#3b82f6`                   | OpenSearch/index color      | `getIntentStyles('info').text`                                                                                                | [Source: line 42] |
| `--index-bg`           | `rgba(59, 130, 246, 0.12)`  | Index tint                  | `getIntentStyles('info').bgSubtle`                                                                                            | [Source: line 43] |
| `--field-selection`    | `#a78bfa`                   | Embedding Fields node color | `getIntentStyles('purple').text` **NEW**: needs a `'field-selection'` entry in `STAGE_INTENT_OVERRIDES` mapping to `'purple'` | [Source: line 44] |
| `--field-selection-bg` | `rgba(167, 139, 250, 0.12)` | Embedding Fields tint       | `getIntentStyles('purple').bgSubtle`                                                                                          | [Source: line 45] |

**Color divergences between wireframe and design system**:

The wireframe assigns unique hues per stage type (purple for extraction, cyan for chunking, amber for enrichment). The existing design system maps `extraction` -> `info` (blue), `chunking` -> `info` (blue, via `STAGE_INTENT_OVERRIDES` in `PipelineCanvas.tsx`), `enrichment` -> `info` (blue). This is intentional -- the design system uses semantic intents, not per-stage-type hues. If distinct per-stage colors are desired, add new entries to `STAGE_INTENT_OVERRIDES` in `PipelineCanvas.tsx` (e.g., `enrichment: 'warning'`) rather than creating raw CSS variables.

**Tokens that need NEW design system additions**:

- `field-selection` -> Add `'field-selection': 'purple'` to `STAGE_INTENT_OVERRIDES` in `PipelineCanvas.tsx`
- No changes needed to `@agent-platform/design-tokens` package itself -- all needed intents (`info`, `success`, `warning`, `error`, `purple`, `accent`) already exist.

### 1.2 Shape & Shadow Tokens

| Token         | Value                           | Usage                 | Source            |
| ------------- | ------------------------------- | --------------------- | ----------------- |
| `--radius`    | `8px`                           | Default border radius | [Source: line 46] |
| `--radius-lg` | `12px`                          | Large border radius   | [Source: line 47] |
| `--shadow`    | `0 4px 24px rgba(0, 0, 0, 0.3)` | Card shadow           | [Source: line 48] |
| `--shadow-lg` | `0 8px 32px rgba(0, 0, 0, 0.4)` | Panel shadow          | [Source: line 49] |

### 1.3 Typography

| Property     | Value                                                                | Source               |
| ------------ | -------------------------------------------------------------------- | -------------------- |
| Font family  | `'Inter', -apple-system, sans-serif`                                 | [Source: line 57-60] |
| Font weights | 300 (light), 400 (regular), 500 (medium), 600 (semibold), 700 (bold) | [Source: line 8]     |

---

## 2. Component Tree

The hierarchy below maps every wireframe HTML element to a React component. Indentation represents parent-child relationships.

```
PipelineEditorPage                              [Source: line 2746-2748]
  PipelineToolbar                               [Source: line 2749-2927]
    PipelineSelector                            [Source: line 2752-2840]
      PipelineDropdown                          [Source: line 2778-2839]
        PipelineDropdownItem                    [Source: line 2780-2815]
        PipelineDropdownAction ("Create New")   [Source: line 2817-2838]
    ExecutionOrderIndicator                     [Source: line 2843-2848]
    UnsavedChangesIndicator                     [Source: line 2850-2853]
    ToolbarActions                              [Source: line 2856-2926]
      IconButton (Test Routing)                 [Source: line 2857-2872]
      IconButton (Version History)              [Source: line 2873-2887]
      Button (Validate)                         [Source: line 2891]
      Button (Save Draft)                       [Source: line 2892-2908]
      Button (Deploy)                           [Source: line 2909-2925]
  PipelineEditor                                [Source: line 2930]
    FlowsSidebar                                [Source: line 2932-3036]
      FlowsSidebarHeader                        [Source: line 2933-2958]
      FlowItem (per flow)                       [Source: line 2961-2973]
      AddFlowButton                             [Source: line 2975-2994]
      EmbeddingInfoCard                         [Source: line 2997-3033]
    CanvasContainer                             [Source: line 3039-4982]
      DefaultPipelineBanner                     [Source: line 3041-3061]
      CanvasBackground (dot grid)               [Source: line 3062]
      CanvasSVG (edge layer)                    [Source: line 3063]
      CanvasWorld (node layer)                  [Source: line 3064-4959]
        DocumentIngressNode                     [Source: line 3066-3087]
        ContentRouterNode                       [Source: line 3090-3132]
        StageNode (per flow per stage type)     [Source: line 3134-3305, 3843-4042, etc.]
          StageColorBar                         [Source: line 3142]
          StageDragHandle                       [Source: line 3143-3152]
          Ports (in/out)                        [Source: line 3153-3154]
          StageHeader                           [Source: line 3155-3188]
            StageTypeLabel                      [Source: line 3157-3184]
            StageInfoButton                     [Source: line 3159-3184]
            StageProviderLabel                  [Source: line 3186]
          StageConfigSummary (collapsed view)   [Source: line 3189-3198]
          StageFooter (badges)                  [Source: line 3199-3202]
          StageExpandedForm                     [Source: line 3203-3304]
            ProviderSelect                      [Source: line 3205-3216]
            ProviderConfigSection (per provider)[Source: line 3219-3302]
        AddStageButton (between stages)         [Source: line 3307-3327]
        AddStagePopover                         [Source: line 3328-3438]
          PopoverItem (valid stages)            [Source: line 3331-3356]
          PopoverItemDisabled (invalid stages)  [Source: line 3407-3437]
        MergeNode                               [Source: line 4678-4716]
        EmbeddingFieldsNode                     [Source: line 4719-4796]
        EmbeddingNode (shared, locked)          [Source: line 4799-4918]
        OpenSearchNode (locked)                 [Source: line 4922-4958]
      CanvasToolbar (zoom controls)             [Source: line 4963-4982]
      ValidationPanel                           [Source: line 4985-5099]
      TestRoutingPanel                          [Source: line 5101-5230+]
      VersionHistoryPanel                       [Source: line ~5230-5400+]
      Minimap                                   [Source: line ~5400+]
    ConfigSidePanel (Custom API, 520px)         [Source: line ~5900-6400+]
      ConfigPanelHeader                         [Source: line ~5920]
      ConfigPanelTabs                           [Source: line ~5940]
        ConfigTab                               [Source: line ~5950-6000]
        AuthHeadersTab                          [Source: line ~6000-6100]
        BehaviorTab                             [Source: line ~6100-6200]
        TestTab                                 [Source: line ~6200-6300]
      ConfigPanelFooter                         [Source: line ~6350]
    ScriptSidePanel (Custom Script, 520px)      [Source: line ~6400-6800+]
      ScriptPanelHeader                         [Source: line ~6420]
      ScriptPanelTabs                           [Source: line ~6440]
        ScriptTab (code editor)                 [Source: line ~6450-6550]
        VariablesTab                            [Source: line ~6550-6650]
        SettingsTab                             [Source: line ~6650-6700]
        TestTab                                 [Source: line ~6700-6800]
      ScriptPanelFooter                         [Source: line ~6800]
    EmbeddingFieldsDrawer (420px)               [Source: line ~6900-7500+]
      FieldDrawerHeader                         [Source: line ~6920]
      FieldDrawerActions (Reset All)            [Source: line ~6940]
      CurrentlyEmbeddingSection                 [Source: line ~6960-7050]
        FieldSelectedItem (per field)           [Source: line ~6970]
      AvailableFieldsSections                   [Source: line ~7050-7400]
        FieldSection (Core/Common/Custom)       [Source: line ~7060]
          FieldItem                             [Source: line ~7080]
            FieldCheckbox                       [Source: line ~7090]
            FieldName                           [Source: line ~7095]
            FieldTypeBadge                      [Source: line ~7100]
            FieldOriginBadge                    [Source: line ~7105]
            FieldSourceBreakdown (expandable)   [Source: line ~7110-7130]
              SourceToggle (per source)          [Source: line ~7115]
      FieldDrawerImpactBanner                   [Source: line ~7420]
      FieldDrawerFooter                         [Source: line ~7440]
  Modals (portal-rendered)
    DeployConfirmModal                          [Source: line ~7460-7560]
    EmbeddingChangeModal                        [Source: line ~7560-7620]
    NewPipelineModal                            [Source: line ~7620-7746]
  ToastContainer                                [Source: line 7752]
  Tooltip                                       [Source: line 7748-7749]
  SkeletonOverlay                               [Source: line ~7650-7690]
```

---

## 3. Interaction Catalog

Every user interaction from the wireframe JavaScript, mapped to its handler, behavior, and React implementation approach.

### 3.1 Pipeline Management

| ID   | Trigger                       | Wireframe Handler            | Behavior                                                                                                                                            | Source                   |
| ---- | ----------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| I-01 | Click pipeline selector       | `togglePipelineDropdown()`   | Toggle dropdown open/close                                                                                                                          | [Source: line 7758-7761] |
| I-02 | Select pipeline from dropdown | `selectPipeline(id,name,st)` | Update selector label+badge; if default pipeline: lock all stages, hide Add Flow, show banner; if custom: unlock stages, hide banner; show skeleton | [Source: line 7762-7790] |
| I-03 | Click outside dropdown        | `document click handler`     | Close pipeline dropdown and all open popovers                                                                                                       | [Source: line 7793-7802] |
| I-04 | Click "Create New Pipeline"   | Shows `newPipelineModal`     | Opens modal with name+description fields; on create, shows toast with name                                                                          | [Source: line 7929-7935] |

### 3.2 Flow Management

| ID   | Trigger              | Wireframe Handler      | Behavior                                                                                         | Source                   |
| ---- | -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------ |
| I-05 | Click flow item      | `selectFlow(flowId)`   | Highlight selected flow nodes (opacity 1), dim other flow nodes (opacity 0.35), restore after 3s | [Source: line 7821-7836] |
| I-06 | Click sidebar toggle | `toggleFlowsSidebar()` | Toggle sidebar collapsed/expanded; redraw edges + minimap after 280ms transition                 | [Source: line 7807-7815] |
| I-07 | Click "Add Flow"     | Shows toast            | Placeholder -- will open flow creation wizard                                                    | [Source: line 2978]      |

### 3.3 Stage Interaction

| ID   | Trigger                       | Wireframe Handler            | Behavior                                                                                                                   | Source                   |
| ---- | ----------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| I-08 | Click stage node              | `toggleExpand(el)`           | If locked, return. Collapse all other expanded nodes. Toggle clicked node expanded. Mark unsaved. Redraw edges after 320ms | [Source: line 7841-7852] |
| I-09 | Click + button between stages | `togglePopover(id)`          | Close all other popovers; toggle target popover open/closed; stops propagation                                             | [Source: line 7857-7863] |
| I-10 | Click popover stage item      | Shows toast                  | Placeholder -- will insert the selected stage type at that position                                                        | [Source: line 3333-3334] |
| I-11 | Mousedown on drag handle      | DnD visual feedback          | Adds `.dragging` class to node; removes on mouseup. Visual only in wireframe                                               | [Source: line 8268-8280] |
| I-12 | Click stage info (?) button   | `showStageTooltip(btn,text)` | Positions tooltip below button; auto-hides after 3s                                                                        | [Source: line 7986-7995] |

### 3.4 Provider Switching

| ID   | Trigger                   | Wireframe Handler                | Behavior                                                                                                                                                                                  | Source                   |
| ---- | ------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| I-13 | Change provider dropdown  | `switchProvider(sel, stageType)` | Hides all inline provider sections; updates provider label in header; if "Custom API" -> opens config panel; if "Custom Script" -> opens script panel; else shows matching inline section | [Source: line 8491-8524] |
| I-14 | Change embedding provider | Inline `onchange`                | If value changes from bge-m3, shows embedding change warning modal                                                                                                                        | [Source: line 4876-4881] |

### 3.4a Inline Stage Config Interactions

These interactions apply to the inline expanded form within stage nodes (distinct from the side panels in Section 3.5).

| ID   | Trigger                   | Wireframe Handler          | Behavior                                                                                         | Source                   |
| ---- | ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------ |
| I-57 | Switch auth type (inline) | `switchAuthType(selectEl)` | Hides all auth field groups within the inline form; shows matching auth fields for selected type | [Source: line 8529-8540] |
| I-58 | Add header (inline)       | `addHeader(btn)`           | Creates new key-value input row before the add button in the inline form                         | [Source: line 8545-8551] |
| I-59 | Remove header (inline)    | `removeHeader(btn)`        | Removes the key-value input row from the inline form                                             | [Source: line 8553-8561] |
| I-60 | Test connection (inline)  | `testConnection(btn)`      | Disables button; shows "Testing..." text; after 1500ms shows success/failure result              | [Source: line 8567-8598] |
| I-61 | Test script (inline)      | `testScript(btn)`          | Disables button; shows "Running..." text; after 1200ms shows success/failure result              | [Source: line 8584-8598] |

### 3.5 Side Panels (Custom API / Custom Script)

| ID    | Trigger                   | Wireframe Handler                  | Behavior                                                                                                                                                     | Source                   |
| ----- | ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| I-15  | Open config panel         | `openConfigPanel(node, stageType)` | Closes other panels; sets active node; updates stage type label; updates schemas; adds `.panel-active` to node; shows overlay; opens panel; auto-pans canvas | [Source: line 8606-8627] |
| I-16  | Close config panel        | `closeConfigPanel()`               | Removes `.open`; hides overlay; removes `.panel-active` from node                                                                                            | [Source: line 8629-8636] |
| I-17  | Open script panel         | `openScriptPanel(node, stageType)` | Same pattern as config panel but for script editor                                                                                                           | [Source: line 8643-8664] |
| I-18  | Switch config tab         | `switchConfigTab(btn, tabName)`    | Deactivates all tabs; activates clicked tab + matching content panel                                                                                         | [Source: line 8698-8710] |
| I-18a | Switch script tab         | `switchScriptTab(btn, tabName)`    | Same pattern as I-18 but for the script panel tabs (Script, Variables, Settings, Test)                                                                       | [Source: line 8712-8724] |
| I-19  | Switch auth type in panel | `switchPanelAuthType(selectEl)`    | Hides all auth field groups; shows matching auth fields                                                                                                      | [Source: line 8726-8734] |
| I-20  | Add header in panel       | `addPanelHeader(btn)`              | Creates new key-value input row before the add button                                                                                                        | [Source: line 8736-8745] |
| I-21  | Test connection           | `testPanelConnection(btn)`         | Disables button; shows "Connecting..." text; after 1500ms shows success result                                                                               | [Source: line 8794-8809] |
| I-22  | Test script               | `testPanelScript(btn)`             | Disables button; shows "Running..." text; after 1200ms shows success result                                                                                  | [Source: line 8811-8826] |
| I-23  | Escape key                | `keydown` handler                  | Closes both config and script panels                                                                                                                         | [Source: line 8829-8834] |
| I-24  | Auto-pan for panel        | `autoPanForPanel(node)`            | Calculates if node+120px gap would overlap 520px panel; if so, uses `useReactFlow().setViewport()` to keep node visible; smooth transition                   | [Source: line 8680-8696] |
| I-25  | Update panel schemas      | `updatePanelSchemas(stageType)`    | Swaps request/response schema examples based on stage type (extraction vs enrichment)                                                                        | [Source: line 8751-8766] |
| I-26  | Update script schemas     | `updateScriptSchemas(stageType)`   | Swaps input description, input schema, and return type based on stage type (extraction/chunking/enrichment)                                                  | [Source: line 8768-8792] |
| I-62  | Save config panel         | `saveConfigPanel()`                | Validates panel form; updates stage providerConfig in store; closes panel; shows toast                                                                       | [Source: line 8638-8641] |
| I-63  | Save script panel         | `saveScriptPanel()`                | Validates script; updates stage providerConfig in store; closes panel; shows toast                                                                           | [Source: line 8675-8678] |

### 3.6 Embedding Fields Drawer

| ID   | Trigger                     | Wireframe Handler                | Behavior                                                                                                                     | Source                   |
| ---- | --------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| I-27 | Click Embedding Fields node | `openFieldDrawer()`              | Closes config/script panels; adds `.open` to drawer; shows overlay; highlights node; updates impact                          | [Source: line 8285-8292] |
| I-28 | Close field drawer          | `closeFieldDrawer()`             | Removes `.open`; hides overlay; removes highlight from node                                                                  | [Source: line 8294-8298] |
| I-29 | Toggle field section        | `toggleFieldSection(headerEl)`   | Collapses/expands section (Core/Common/Custom)                                                                               | [Source: line 8300-8302] |
| I-30 | Toggle field detail         | `toggleFieldDetail(itemEl)`      | Collapse other expanded items in same section; toggle per-source breakdown                                                   | [Source: line 8304-8310] |
| I-31 | Toggle field checkbox       | `toggleField(cb, fieldName)`     | Changes origin badge to "Pipeline" if was "Global"; syncs "Currently Embedding" section; marks unsaved; updates node summary | [Source: line 8312-8330] |
| I-32 | Remove from embedding (x)   | `removeFromEmbedding(fieldName)` | Unchecks matching checkbox in Available Fields; removes from selected list; marks unsaved; updates summaries                 | [Source: line 8332-8353] |
| I-33 | Toggle source toggle        | `toggleSourceField(...)`         | Changes origin badge to "Pipeline" if was "Global"; marks unsaved; updates summaries                                         | [Source: line 8413-8424] |
| I-34 | Reset All to Global         | `resetToGlobal()`                | Removes all `.field-origin-pipeline` classes, replaces with `.field-origin-global`; shows toast                              | [Source: line 8470-8479] |
| I-35 | Save Field Changes          | `saveFieldChanges()`             | Closes drawer; marks unsaved (pipeline dirty); shows toast                                                                   | [Source: line 8481-8486] |

### 3.7 Canvas Interactions

> **Implementation note**: The wireframe implements canvas pan/zoom with vanilla JS for demo purposes. The production implementation uses **React Flow** (`@xyflow/react`), which is already integrated in the existing `PipelineCanvas.tsx`. All viewport manipulation uses React Flow APIs. See Appendix B for details.

| ID   | Trigger               | React Flow API                                  | Behavior                                                                                                                                             | Source (wireframe)       |
| ---- | --------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| I-36 | Mouse wheel on canvas | Built-in React Flow zoom (configured via props) | React Flow handles wheel zoom natively. Configure `minZoom={0.3}` `maxZoom={2.0}` on `<ReactFlow>`. Panels/drawers use `zoomOnScroll={false}` guard. | [Source: line 8029-8046] |
| I-37 | Mousedown on canvas   | Built-in React Flow pan (configured via props)  | React Flow handles panning natively. Configure `panOnDrag={true}` on `<ReactFlow>`.                                                                  | [Source: line 8048-8061] |
| I-38 | Mousemove during pan  | Built-in React Flow pan                         | Handled by React Flow internals.                                                                                                                     | [Source: line 8062-8067] |
| I-39 | Mouseup               | Built-in React Flow pan                         | Handled by React Flow internals.                                                                                                                     | [Source: line 8068-8071] |
| I-40 | Click zoom in (+)     | `useReactFlow().zoomIn({ duration: 300 })`      | Step: 0.15, max 2.0.                                                                                                                                 | [Source: line 8073-8076] |
| I-41 | Click zoom out (-)    | `useReactFlow().zoomOut({ duration: 300 })`     | Step: 0.15, min 0.3.                                                                                                                                 | [Source: line 8077-8080] |
| I-42 | Click fit to view     | `useReactFlow().fitView({ duration: 300 })`     | React Flow calculates optimal viewport. Wireframe reference: scale=0.7, panX=20, panY=10.                                                            | [Source: line 8081-8086] |
| I-43 | Window resize         | Handled by React Flow `<ReactFlowProvider>`     | React Flow auto-resizes. Edges and minimap update automatically.                                                                                     | [Source: line 8839-8842] |

### 3.8 SVG Edge Drawing

| ID   | Trigger              | Wireframe Handler | Behavior                                                                                                                                                                                                                                                                     | Source                   |
| ---- | -------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| I-44 | Any layout change    | `drawEdges()`     | Clears SVG. Draws bezier curves: Ingress->Router (accent), Router->first stage per flow (extraction/chunking colors), sequential stages within flow, last stage->Merge, Merge->EmbFields (accent), EmbFields->Embedding (field-selection), Embedding->OpenSearch (embedding) | [Source: line 8116-8210] |
| I-45 | Bezier curve drawing | `bezier(svg,...)` | Creates glow layer path + main path using cubic bezier with horizontal midpoint control points                                                                                                                                                                               | [Source: line 8091-8105] |

### 3.9 Toolbar Actions

| ID   | Trigger            | Wireframe Handler          | Behavior                                                                                           | Source                   |
| ---- | ------------------ | -------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------ |
| I-46 | Click Save Draft   | `saveDraft()`              | Clears unsaved indicator; shows toast                                                              | [Source: line 7881-7884] |
| I-47 | Click Deploy       | `deploy()`                 | Shows deploy confirmation modal                                                                    | [Source: line 7886-7889] |
| I-48 | Confirm Deploy     | `confirmDeploy()`          | Hides modal; shows deploying toast; changes badge to "Deploying"; after 2200ms changes to "Active" | [Source: line 7891-7908] |
| I-49 | Click Validate     | `validatePipeline()`       | Shows validating toast; after 600ms opens validation panel                                         | [Source: line 7913-7918] |
| I-50 | Test Routing panel | `toggleTestRoutingPanel()` | Toggle test routing panel; close version panel if open                                             | [Source: line 7940-7945] |
| I-51 | Run test routing   | `runTestRouting()`         | Reads MIME type; matches to flow; shows result with color coding (success/warning)                 | [Source: line 7946-7971] |
| I-52 | Version History    | `toggleVersionPanel()`     | Toggle version panel; close test routing panel if open                                             | [Source: line 7976-7981] |

### 3.10 State Indicators

| ID   | Trigger       | Wireframe Handler | Behavior                                                            | Source                   |
| ---- | ------------- | ----------------- | ------------------------------------------------------------------- | ------------------------ |
| I-53 | Mark unsaved  | `markUnsaved()`   | Sets `hasUnsaved=true`; adds `.visible` to indicator                | [Source: line 7868-7872] |
| I-54 | Clear unsaved | `clearUnsaved()`  | Sets `hasUnsaved=false`; removes `.visible` from indicator          | [Source: line 7874-7876] |
| I-55 | Show skeleton | `showSkeleton()`  | Shows skeleton overlay; auto-hides after 1200ms                     | [Source: line 8000-8004] |
| I-56 | Show toast    | `showToast(msg)`  | Creates toast element; fades out after 2500ms; removes after 2800ms | [Source: line 8252-8263] |

---

## 4. State Management

### 4.1 Global Pipeline State (Zustand)

> **Implementation strategy**: EVOLVE the existing `usePipelineStore` at `apps/studio/src/store/pipeline-store.ts`, not replace it. The existing store has 112 lines of state + 538 lines of implementation. Use atomic Zustand selectors per Studio convention.

**Existing fields** (from `usePipelineStore` -- keep as-is):

| Existing Field                            | Maps To Spec Concept      | Notes          |
| ----------------------------------------- | ------------------------- | -------------- |
| `draft: PipelineDefinition \| null`       | `currentPipeline`         | Keep as-is     |
| `published: PipelineDefinition \| null`   | Published snapshot        | Keep as-is     |
| `selectedFlowId: string \| null`          | `activeFlowId`            | Keep as-is     |
| `selectedStageId: string \| null`         | `expandedStageId`         | Keep as-is     |
| `isDirty: boolean`                        | `hasUnsavedChanges`       | Keep as-is     |
| `isLoading: boolean`                      | Loading/skeleton state    | Keep as-is     |
| `saveStatus: SaveStatus`                  | Save state tracking       | Keep as-is     |
| `error: string \| null`                   | Error state               | Keep as-is     |
| `validationErrors: ValidationError[]`     | Validation results        | Keep as-is     |
| `validationResult: ValidationResult`      | Full validation result    | Keep as-is     |
| `projectId / knowledgeBaseId`             | Context                   | Keep as-is     |
| `stageConfigOpen: boolean`                | Part of `activePanelType` | Evolve (below) |
| `ruleBuilderOpen: boolean`                | Rule builder state        | Keep as-is     |
| `testSelectionOpen: boolean`              | `testRoutingPanelOpen`    | Keep as-is     |
| `embeddingProviders / embeddingDialog*`   | Embedding dialog state    | Keep as-is     |
| `reindexPending / reindexLoading / etc.`  | Reindex state             | Keep as-is     |
| All existing actions (loadPipeline, etc.) | --                        | Keep as-is     |

**NEW fields to add** to the existing store:

```typescript
// These are additions to the existing PipelineStore interface

// UI state -- NEW
flowsSidebarCollapsed: boolean; // default false    [Source: line 7807]

  // Panel state -- NEW (replaces existing stageConfigOpen with richer model)
  // The existing stageConfigOpen boolean evolves into this mutually exclusive panel type.
  activePanelType: 'none' | 'configPanel' | 'scriptPanel' | 'fieldDrawer'; // default 'none'
  activePanelNodeId: string | null;
  activePanelStageType: SearchPipelineStageType | null;

  // Validation panel -- NEW (existing validationResult/validationErrors kept for data)
  validationPanelOpen: boolean; // default false

  // Version history -- NEW
  versionPanelOpen: boolean; // default false

  // NEW Actions (existing actions like saveDraft, publish, validate are kept as-is)
  toggleFlowsSidebar: () => void;
  openConfigPanel: (nodeId: string, stageType: SearchPipelineStageType) => void;
  openScriptPanel: (nodeId: string, stageType: SearchPipelineStageType) => void;
  openFieldDrawer: () => void;
  closeAllPanels: () => void;
  toggleValidationPanel: () => void;
  toggleVersionPanel: () => void;
}
```

> **Canvas viewport state**: `scale`, `panX`, `panY`, `isPanning` are NOT stored in Zustand. These are managed internally by React Flow via `useReactFlow()`. See Appendix B for the React Flow API mapping.
>
> **REMOVED from spec** (vs. original draft): `scale`, `panX`, `panY`, `isPanning`, `pipelines: PipelineSummary[]` (deferred to multi-pipeline, see Section 7.1), `currentPipelineId` (single-pipeline mode uses `draft._id`).

### 4.2 Field Drawer Local State

```typescript
interface FieldDrawerState {
  overrides: FieldOverride[]; // working copy, not committed until Save
  expandedFieldName: string | null;
  expandedSectionIds: Record<string, boolean>; // keys: 'core' | 'common' | 'custom' (max 3 entries)
}

interface FieldOverride {
  canonicalField: string;
  connectorId: string;
  embeddable: boolean;
}
```

### 4.3 State Invariants

1. **Only one panel open at a time** -- opening config panel closes script panel and field drawer, and vice versa. [Source: line 8286-8288, 8607-8608, 8644-8645]
2. **Only one stage expanded at a time** -- expanding a stage collapses all others. [Source: line 7845-7847]
3. **Test routing and version history are mutually exclusive** -- opening one closes the other. [Source: line 7943-7944, 7979-7980]
4. **Default pipeline locks all stages** -- when `pipelineId === 'default'`, all stage nodes get `locked` class, Add Flow is hidden. [Source: line 7773-7785]
5. **Unsaved changes track dirty state** -- any form change calls `markUnsaved()`. Save/deploy clears it. [Source: line 7868-7876]

### 4.4 Merge vs Separate Embedding Fields

Per the Embedding Fields Design Doc (Section 9), when the pipeline has no merge node (separate embedding per flow), EACH flow gets its own Embedding Fields node with flow-level configuration. The current spec describes only the shared (merge) scenario.

**Implementation note**: In separate-embedding mode:

- The `EmbeddingFieldsNode` component is rendered once per flow instead of once globally.
- Each `EmbeddingFieldsNode` receives a `flowId` prop and scopes its field overrides to that flow.
- The `FieldDrawerState.overrides` array includes a `flowId` field to distinguish per-flow overrides from global overrides.
- The canvas layout places the Embedding Fields node between each flow's last stage and its flow-specific Embedding node (no Merge node present).
- Detecting which mode to render: if `pipeline.flows.length === 1` or the pipeline has a shared embedding config, render in merge mode. If flows have separate embedding configs, render in separate mode.

---

## 5. Provider Config Matrix

Exact configuration fields per provider, extracted from the wireframe HTML. Each entry specifies field name, type, options, default, and source line.

### 5.1 Extraction Providers

#### Docling [Source: line 3219-3263]

| Field             | Type   | Options                     | Default    | Notes                             |
| ----------------- | ------ | --------------------------- | ---------- | --------------------------------- |
| OCR               | select | Enabled, Disabled           | Enabled    | For scanned docs and images       |
| Extract Tables    | select | Yes, No                     | Yes        |                                   |
| Extract Images    | select | Yes, No                     | Yes        |                                   |
| On Error          | select | Fail, Continue, Dead letter | Fail       | Dead letter: saved for inspection |
| Fallback Provider | select | LlamaIndex, None            | LlamaIndex |                                   |

#### LlamaIndex [Source: line 3265-3302]

| Field             | Type   | Options                                                                        | Default           |
| ----------------- | ------ | ------------------------------------------------------------------------------ | ----------------- |
| Format / Parser   | select | Auto, Markdown, Text (PDF context) / SimpleText, Markdown, HTML (Text context) | Auto / SimpleText |
| Language          | text   | Free text                                                                      | `en`              |
| On Error          | select | Fail, Continue, Dead letter                                                    | Fail              |
| Fallback Provider | select | Docling, None                                                                  | None              |

#### Custom API [Source: opens ConfigSidePanel, line 8508-8510]

Opens 520px side panel with 4 tabs. See Section 5.5.

#### Custom Script [Source: opens ScriptSidePanel, line 8512-8514]

Opens 520px side panel with 4 tabs. See Section 5.6.

### 5.2 Chunking Providers

#### Tree Builder [Source: line 3931-3968]

| Field          | Type   | Options                          | Default      |
| -------------- | ------ | -------------------------------- | ------------ |
| Strategy       | select | Hierarchical, Semantic, Sentence | Hierarchical |
| Max Token Size | number | Free input                       | 512          |
| Overlap Tokens | number | Free input                       | 50           |
| On Error       | select | Fail, Continue                   | Fail         |

Hint on Max Token Size: "Larger chunks = more context, less precision" [Source: line 3949]

#### Recursive Character [Source: line 3970-4011]

| Field              | Type   | Options        | Default          |
| ------------------ | ------ | -------------- | ---------------- |
| Chunk Size (chars) | number | Free input     | 1000             |
| Overlap (chars)    | number | Free input     | 200              |
| Separators         | text   | Free input     | `\n\n, \n, . , ` |
| On Error           | select | Fail, Continue | Fail             |

Hint on Separators: "Comma-separated split characters, tried in order" [Source: line 4001]

#### Fixed Size [Source: line 4013-4039]

| Field               | Type   | Options        | Default |
| ------------------- | ------ | -------------- | ------- |
| Chunk Size (tokens) | number | Free input     | 512     |
| Overlap (tokens)    | number | Free input     | 50      |
| On Error            | select | Fail, Continue | Fail    |

#### Custom Script -- same as extraction Custom Script, opens ScriptSidePanel.

### 5.3 Enrichment Providers

#### LLM Enrichment [Source: line 4128-4161]

| Field    | Type   | Options                                                        | Default            |
| -------- | ------ | -------------------------------------------------------------- | ------------------ |
| Model    | select | GPT-4o-mini, GPT-4o, Claude 3.5 Sonnet                         | GPT-4o-mini        |
| Tasks    | select | Summary + Keywords, Summary only, Keywords only, Custom prompt | Summary + Keywords |
| On Error | select | Continue, Fail, Dead letter                                    | Continue           |

Hint on On Error: "Continue = skip enrichment, keep chunk" [Source: line 4158]

#### Question Synthesis [Source: line 4163-4194]

| Field               | Type   | Options                                | Default     |
| ------------------- | ------ | -------------------------------------- | ----------- |
| Model               | select | GPT-4o-mini, GPT-4o, Claude 3.5 Sonnet | GPT-4o-mini |
| Questions per Chunk | number | Free input                             | 3           |
| On Error            | select | Continue, Fail                         | Continue    |

Hint on Questions per Chunk: "Number of synthetic questions to generate" [Source: line 4184]

#### Custom API / Custom Script -- open respective side panels.

### 5.4 Embedding Provider

#### BGE-M3 (shared, locked) [Source: line 4870-4917]

| Field      | Type   | Options                                                                                             | Default              |
| ---------- | ------ | --------------------------------------------------------------------------------------------------- | -------------------- |
| Provider   | select | BGE-M3 (Self-hosted), OpenAI text-embedding-3-large, OpenAI text-embedding-3-small, Cohere embed-v3 | BGE-M3 (Self-hosted) |
| Dimensions | select | 1024, 768, 512, 3072                                                                                | 1024                 |
| Batch Size | number | Free input                                                                                          | 32                   |
| Hosting    | select | Self-hosted, Cloud API                                                                              | Self-hosted          |

Warning: "Changing provider triggers a full reindex" [Source: line 4889]

### 5.5 Custom API Side Panel (520px) [Source: line ~5900-6400]

**Tab: Config**

| Field           | Type   | Default                          |
| --------------- | ------ | -------------------------------- |
| Endpoint URL    | text   | (empty)                          |
| HTTP Method     | select | POST                             |
| Request Schema  | code   | Stage-type-specific JSON example |
| Response Schema | code   | Stage-type-specific JSON example |

Request/response schemas adapt per stage type. [Source: line 8751-8766]

**Tab: Auth & Headers**

| Field     | Type           | Options                                 | Default |
| --------- | -------------- | --------------------------------------- | ------- |
| Auth Type | select         | None, Bearer Token, API Key, Basic Auth | None    |
| Token/Key | text           | (dynamic per auth type)                 |         |
| Headers   | key-value list | Addable/removable rows                  | 1 row   |

Auth type switching hides/shows relevant fields. [Source: line 8726-8734]

**Tab: Behavior**

| Field    | Type   | Options                     | Default |
| -------- | ------ | --------------------------- | ------- |
| Timeout  | number | Free input (ms)             | 30000   |
| Retries  | number | 0-5 range                   | 2       |
| On Error | select | Fail, Continue, Dead letter | Fail    |

**Tab: Test**

| Field        | Type     | Default                    |
| ------------ | -------- | -------------------------- |
| Test Payload | textarea | Stage-type-specific sample |
| Test Button  | button   | "Test Connection"          |
| Result       | display  | Success/failure + timing   |

### 5.6 Custom Script Side Panel (520px) [Source: line ~6400-6800]

**Tab: Script**

| Field         | Type               | Default                             |
| ------------- | ------------------ | ----------------------------------- |
| Script Editor | monospace textarea | Boilerplate template per stage type |

**Tab: Variables**

| Field          | Type    | Default                         |
| -------------- | ------- | ------------------------------- |
| Input Object   | display | Stage-type-specific schema      |
| Context Schema | display | `pipelineContext: { ... }`      |
| Return Type    | display | Stage-type-specific return type |

Variable schemas adapt per stage type. [Source: line 8768-8792]

**Tab: Settings**

| Field            | Type    | Options                      | Default |
| ---------------- | ------- | ---------------------------- | ------- |
| Timeout (ms)     | number  | Free input                   | 5000    |
| On Error         | select  | Fail, Continue, Dead letter  | Fail    |
| Security Sandbox | display | V8 isolate restrictions info |         |

**Tab: Test**

| Field        | Type     | Default                    |
| ------------ | -------- | -------------------------- |
| Sample Input | textarea | Stage-type-specific sample |
| Test Button  | button   | "Test Script"              |
| Result       | display  | Success/failure + timing   |

---

## 6. Data Contracts (API)

Verified against actual backend routes in `apps/search-ai/src/routes/pipelines.ts`.

### 6.1 Existing Endpoints

| Method | Path                                                              | Purpose                     | Request Body                                     | Response                                         | Source (route file)    |
| ------ | ----------------------------------------------------------------- | --------------------------- | ------------------------------------------------ | ------------------------------------------------ | ---------------------- |
| GET    | `/api/projects/:projectId/knowledge-bases/:kbId/pipelines`        | Get active pipeline         | --                                               | `ISearchPipelineDefinition`                      | pipelines.ts line ~30  |
| POST   | `/api/projects/:projectId/knowledge-bases/:kbId/pipelines`        | Create default pipeline     | `{ name?, description? }`                        | `ISearchPipelineDefinition`                      | pipelines.ts line ~80  |
| PATCH  | `/api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id`    | Update pipeline             | Partial `ISearchPipelineDefinition`              | `ISearchPipelineDefinition`                      | pipelines.ts line ~130 |
| POST   | `.../:kbId/pipelines/:id/publish`                                 | Publish/deploy pipeline     | --                                               | `{ success, version }`                           | pipelines.ts line ~180 |
| POST   | `.../:kbId/pipelines/:id/reindex`                                 | Trigger reindex             | --                                               | `{ success, jobId }`                             | pipelines.ts line ~200 |
| POST   | `.../:kbId/pipelines/validate`                                    | Validate pipeline config    | `ISearchPipelineDefinition` (partial)            | `{ errors, warnings }`                           | pipelines.ts line ~220 |
| POST   | `.../:kbId/pipelines/:id/test-selection`                          | Test flow selection         | `{ mimeType, metadata? }`                        | `{ matchedFlow, rule }`                          | pipelines.ts line ~240 |
| GET    | `/api/projects/:projectId/pipelines/providers/:stageType/schemas` | Get provider schemas        | --                                               | `{ providers: JSONSchema[] }`                    | pipelines.ts line ~260 |
| GET    | `/api/projects/:projectId/pipelines/providers/embedding`          | List embedding providers    | --                                               | `{ providers: EmbeddingProviderInfo[] }`         | pipelines.ts line 1183 |
| PATCH  | `.../:kbId/pipelines/:id/embedding-config`                        | Update embedding config     | `{ provider, model, dimensions, confirm: true }` | `{ previousConfig, newConfig, reindexRequired }` | pipelines.ts line 1237 |
| POST   | `.../:kbId/documents/:docId/trigger-pipeline`                     | Trigger pipeline for doc    | --                                               | `{ success, pipelineId, pipelineVersion }`       | pipelines.ts line 1466 |
| POST   | `.../:kbId/sources/:sourceId/trigger-pipeline`                    | Trigger pipeline for source | --                                               | `{ success, pipelineId, pipelineVersion }`       | pipelines.ts line 1569 |

> **Note**: The `PATCH .../embedding-config` endpoint is the correct target for Embedding node provider changes (I-14), not the general pipeline PATCH. It handles the reindex confirmation flow separately and returns reindex analysis. The existing Studio API client at `apps/studio/src/api/pipelines.ts` already has `updateEmbeddingConfig()`, `fetchEmbeddingProviders()`, `triggerDocumentPipeline()`, and `triggerSourcePipeline()` functions for these endpoints.

### 6.2 Required New Endpoints

| Method | Path                                                | Purpose                          | Why Needed                                                                 |
| ------ | --------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| GET    | `.../:kbId/pipelines`                               | **List ALL pipelines** for KB    | Current GET returns only active. Dropdown needs all (active+draft+default) |
| POST   | `.../:kbId/pipelines/:id/test-webhook`              | Test Custom API provider         | Test tab sends test payload to webhook endpoint                            |
| POST   | `.../:kbId/pipelines/:id/test-script`               | Test Custom Script in sandbox    | Test tab executes script in V8 sandbox                                     |
| GET    | `.../:kbId/pipelines/:id/versions`                  | Version history list             | Version history panel needs version list                                   |
| POST   | `.../:kbId/pipelines/:id/versions/:version/restore` | Restore pipeline version         | Version history "Restore" action                                           |
| GET    | `.../:kbId/embedding-fields`                        | Get canonical fields + overrides | Field drawer needs field list with source mappings                         |
| PATCH  | `.../:kbId/embedding-fields`                        | Save field selection overrides   | Field drawer Save action                                                   |

### 6.3 Data Model Reference

The pipeline is stored as `ISearchPipelineDefinition` from `packages/database/src/models/search-pipeline-definition.model.ts`. The interfaces below are copied verbatim from the model file (lines 17-144). The frontend API types in `apps/studio/src/api/pipelines.ts` mirror these with minor serialization differences (dates as strings).

```typescript
// Source: packages/database/src/models/search-pipeline-definition.model.ts

interface ISearchPipelineDefinition {
  _id: string;
  tenantId: string;
  knowledgeBaseId: string;

  name: string;
  description: string; // required, defaults to ''
  version: number; // auto-incremented on save (pre-save hook)
  status: 'draft' | 'active' | 'archived';

  flows: ISearchPipelineFlow[]; // min 1, max 50; at least one must be enabled

  activeEmbeddingConfig: IActiveEmbeddingConfig; // required, defaults to bge-m3

  sharedStages?: {
    enrichment?: ISearchPipelineStage[];
    indexing?: ISearchPipelineStage[];
  };

  providerDefaults?: Record<string, Record<string, unknown>>;

  /** Snapshot of the previously active pipeline, stored at publish time for reindex diffing */
  previousVersion?: Record<string, unknown> | null;

  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastDeployedAt?: Date;

  validationErrors?: ISearchValidationError[];
  validationStatus?: 'valid' | 'invalid' | 'pending';
  lastValidatedAt?: Date;
}

interface ISearchPipelineFlow {
  id: string; // NOT flowId
  name: string;
  description?: string;
  enabled: boolean;

  selectionRules?: ISearchRuleCondition[]; // NOT rules
  priority: number; // 0-100
  isDefault: boolean;
  templateVersion?: string;

  stages: ISearchPipelineStage[]; // min 1
  customEnrichment?: ISearchPipelineStage[];
  customIndexing?: ISearchPipelineStage[];

  providerDefaults?: Record<string, Record<string, unknown>>;

  createdAt: Date;
  updatedAt: Date;
}

interface ISearchPipelineStage {
  id: string; // NOT stageId
  name: string;
  type: SearchPipelineStageType; // 'extraction' | 'chunking' | 'enrichment' | 'embedding' | 'multimodal'
  provider: string; // e.g., 'docling', 'http-webhook', 'javascript-sandbox'
  providerConfig: Record<string, unknown>;

  onError: 'fail' | 'continue'; // required, defaults to 'fail'

  fallbackProvider?: string;
  fallbackConfig?: Record<string, unknown>;

  executionCondition?: string; // CEL expression for conditional execution
  requiredProviderVersion?: string;

  description?: string;
  estimatedDuration?: number; // seconds
  estimatedCost?: number; // USD
}
// NOTE: ISearchPipelineStage has NO `order` or `enabled` fields.
// Stage ordering is determined by array position within flow.stages.
// Stage enabling/disabling is managed at the flow level (ISearchPipelineFlow.enabled).

interface IActiveEmbeddingConfig {
  provider: 'openai' | 'cohere' | 'bge-m3' | 'custom';
  model: string; // e.g., 'bge-m3', 'text-embedding-3-small'
  dimensions: number; // e.g., 1024
  providerConfig?: Record<string, unknown>;
}

interface ISearchValidationError {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  path: string;
}

interface ISearchRuleCondition {
  type: 'simple' | 'compound' | 'cel';
  description?: string;
  // Simple: field, operator, value
  field?: string;
  operator?: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'matches' | 'in';
  value?: unknown;
  // Compound: logic + nested conditions
  logic?: 'AND' | 'OR';
  conditions?: ISearchRuleCondition[];
  // CEL: expression string
  celExpression?: string;
}
```

**Key differences from frontend API types** (`apps/studio/src/api/pipelines.ts`):

- Frontend `PipelineDefinition.description` is typed as optional (`description?`); the DB model has it required with a `''` default. Frontend code should treat missing description as empty string.
- Frontend dates are serialized as `string` (ISO format); the DB model uses `Date`.
- Frontend `PipelineStage.onError` is optional; the DB model requires it (defaults to `'fail'`).
- Frontend `PipelineStage.order` exists on the API type as optional for legacy compat but is NOT in the DB model.
- Frontend `PipelineDefinition.validationStatus` omits `'pending'`; the DB model includes it.

---

## 7. Backend Gaps

Differences between what the wireframe shows and what the backend currently supports.

### 7.1 CRITICAL: Single Pipeline Per KB

**Gap**: The MongoDB model has a unique index `{ tenantId: 1, knowledgeBaseId: 1 }`, meaning only ONE pipeline can exist per KB. The wireframe shows multiple pipelines (PDF Optimized, Research Documents, Default Pipeline) selectable from a dropdown. Additionally, the `POST /api/projects/:projectId/knowledge-bases/:kbId/pipelines` endpoint returns 409 if any pipeline already exists for the KB (`Pipeline already exists for this knowledge base`), blocking multi-pipeline creation at the API level.

**Source**: `search-pipeline-definition.model.ts` unique index definition; `pipelines.ts` line ~248-256 (409 guard).

**Decision: SINGLE-PIPELINE MODE for initial implementation.** The pipeline editor operates in single-pipeline mode. The `PipelineSelector` dropdown shows the one existing pipeline plus a "Default Pipeline" placeholder entry. Multi-pipeline support (Design Objective O-4) is deferred to a follow-up backend change that would: (a) modify the unique index to `{ tenantId: 1, knowledgeBaseId: 1, name: 1 }`, (b) add an `isActive` field, and (c) update the POST create endpoint to remove the 409 guard.

The component structure (PipelineSelector, PipelineDropdown, PipelineDropdownItem) is built to support multi-pipeline, but the API layer gates it. In single-pipeline mode:

- PipelineSelector shows: `[Current Pipeline Name] (Active|Draft)` + `Default Pipeline (Fallback)`
- "Create New Pipeline" button is hidden or disabled with a tooltip
- No list endpoint is needed (the existing GET returns the single pipeline)

### 7.2 Missing `field-selection` Stage Type

**Gap**: The `ISearchPipelineStage.type` enum allows `'extraction' | 'chunking' | 'enrichment' | 'embedding' | 'multimodal'`. The Embedding Fields node requires a `'field-selection'` type or must store its data differently.

**Resolution**: Per the design doc, field selection config is stored on `ISearchPipelineStage.providerConfig` where `type = 'field-selection'`. Either add `'field-selection'` to the type enum, or store it as a special shared stage with type `'embedding'` and a field-selection provider.

### 7.3 Missing Multi-Pipeline List Endpoint

**Gap**: Current `GET .../pipelines` returns only the active pipeline. The dropdown needs a list of all pipelines (active, draft, archived, default).

**Resolution**: Add a list endpoint or query parameter to return all pipelines for a KB.

### 7.4 Missing Version History Endpoint

**Gap**: The model auto-increments `version` on save, but there is no endpoint to list historical versions or restore a specific version.

**Resolution**: Add version history storage (either separate collection or embedded array) and restore endpoint.

### 7.5 Missing Webhook/Script Test Endpoints

**Gap**: No backend endpoint to execute a test payload against a Custom API webhook or run a Custom Script in a V8 sandbox and return results.

**Resolution**: Add test execution endpoints that validate connectivity and return results with timing.

### 7.6 Missing Embedding Fields API

**Gap**: No endpoint to retrieve canonical field definitions with source mappings, or to save field selection overrides per pipeline.

**Resolution**: Add endpoints for field listing and override management. The canonical field schema exists conceptually (78 slots) but needs an API surface.

### 7.7 Provider Config Not Validated at REST Layer

**Gap**: The route accepts `providerConfig: Record<string, unknown>` without schema validation. Each provider should validate its own config via `validateConfig()` from the provider registry.

**Resolution**: Wire the `POST .../validate` endpoint to call each provider's `validateConfig()` method. The provider registry (`apps/search-ai/src/services/provider-registry/`) already has `getSchema()` and `validateConfig()` methods on each provider.

---

## 8. Visual Specification

### 8.1 Layout Dimensions

| Element                 | Dimension                           | Source               |
| ----------------------- | ----------------------------------- | -------------------- |
| App header              | height: 48px                        | [Source: line 79]    |
| App sidebar             | width: 240px                        | Design doc O-9       |
| KB header               | height: ~48px                       | [Source: line ~200]  |
| Tabs bar                | height: 36px                        | [Source: line ~230]  |
| Subtabs bar             | height: 36px                        | [Source: line ~260]  |
| Pipeline toolbar        | height: 44px                        | [Source: line ~290]  |
| Flows sidebar expanded  | width: 220px                        | [Source: line ~380]  |
| Flows sidebar collapsed | width: 40px                         | [Source: line ~395]  |
| Canvas available space  | ~(100vw - 240px) x ~(100vh - 220px) | Design doc Section 1 |
| Config side panel       | width: 520px                        | [Source: line ~1800] |
| Script side panel       | width: 520px                        | [Source: line ~1900] |
| Field drawer            | width: 420px                        | [Source: line ~2000] |

### 8.2 Node Dimensions and Positions

| Node             | Position (left, top) | Width | Node Class             | Source                   |
| ---------------- | -------------------- | ----- | ---------------------- | ------------------------ |
| Document Ingress | (40, 180)            | 140px | `node-entry`           | [Source: line 3066]      |
| Content Router   | (240, 148)           | 180px | `node-decision`        | [Source: line 3090]      |
| PDF Extraction   | (490, 40)            | 200px | `node-stage`           | [Source: line 3138]      |
| PDF Chunking     | (760, 40)            | 200px | `node-stage`           | [Source: line 3847]      |
| PDF Enrichment   | (1030, 40)           | 200px | `node-stage`           | [Source: line 4048]      |
| Text Extraction  | (490, 210)           | 200px | `node-stage`           | [Source: line 4203]      |
| Text Chunking    | (760, 210)           | 200px | `node-stage`           | [Source: line 4353]      |
| Text Enrichment  | (1030, 210)          | 200px | `node-stage`           | [Source: line 4536]      |
| Merge            | (1300, 130)          | 110px | `node` (custom)        | [Source: line 4681-4684] |
| Embedding Fields | (1460, 125)          | 180px | `node-field-selection` | [Source: line 4722]      |
| Embedding BGE-M3 | (1690, 125)          | 200px | `node-stage`           | [Source: line 4802]      |
| OpenSearch       | (1940, 125)          | 160px | `node-output`          | [Source: line 4922]      |

### 8.3 Node Visual States

| State        | Visual Treatment                                                         | Source               |
| ------------ | ------------------------------------------------------------------------ | -------------------- |
| Default      | `background: var(--bg-elevated)`, `border: 1px solid var(--border)`      | [Source: line ~450]  |
| Hover        | `border-color: var(--border-hover)`, `transform: translateY(-1px)`       | [Source: line ~470]  |
| Expanded     | Inline config form visible below header; width increases to 240px        | [Source: line ~490]  |
| Locked       | `opacity: 0.65`, no expand on click, cursor not-allowed                  | [Source: line ~510]  |
| Dragging     | `box-shadow: var(--shadow-lg)`, `transform: scale(1.03)`, `z-index: 100` | [Source: line ~530]  |
| Panel Active | `box-shadow: 0 0 0 2px var(--accent)`, `z-index: 50`                     | [Source: line ~1830] |
| Highlighted  | `box-shadow: 0 0 0 2px var(--field-selection)`                           | [Source: line ~2050] |

### 8.4 Stage Color Bar

Every stage node has a 3px color bar at the top. Color per stage type:

| Stage Type      | Color                    | Source              |
| --------------- | ------------------------ | ------------------- |
| Extraction      | `var(--extraction)`      | [Source: line 3142] |
| Chunking        | `var(--chunking)`        | [Source: line 3851] |
| Enrichment      | `var(--enrichment)`      | [Source: line 4052] |
| Embedding       | `var(--embedding)`       | [Source: line 4806] |
| Field Selection | `var(--field-selection)` | [Source: line 4729] |

### 8.5 Edge Colors

| Edge Segment                  | Color                    | Source              |
| ----------------------------- | ------------------------ | ------------------- |
| Ingress -> Router             | `var(--accent)`          | [Source: line 8140] |
| Router -> PDF flow stages     | `var(--extraction)`      | [Source: line 8147] |
| Router -> Text flow stages    | `var(--chunking)`        | [Source: line 8147] |
| Within PDF flow               | `var(--extraction)`      | [Source: line 8156] |
| Within Text flow              | `var(--chunking)`        | [Source: line 8156] |
| Last stage -> Merge           | Per-flow color           | [Source: line 8173] |
| Merge -> Embedding Fields     | `var(--accent)`          | [Source: line 8188] |
| Embedding Fields -> Embedding | `var(--field-selection)` | [Source: line 8198] |
| Embedding -> OpenSearch       | `var(--embedding)`       | [Source: line 8208] |

### 8.6 Edge Drawing Algorithm

Bezier curves use horizontal midpoint control points:

```
M x1,y1 C mx,y1 mx,y2 x2,y2
where mx = (x1 + x2) / 2
```

Each edge has two paths: a glow layer (`edge-path-glow`, wider stroke, lower opacity) and a main line (`edge-path`). [Source: line 8091-8105]

### 8.7 Port Positions

| Port Type  | Position                                                  |
| ---------- | --------------------------------------------------------- |
| `port-in`  | `left: -4px; top: 50%` (vertically centered, left edge)   |
| `port-out` | `right: -4px; top: 50%` (vertically centered, right edge) |
| Router out | Two ports: `top: 35%` and `top: 65%` for flow branching   |
| Merge in   | Two ports: `top: 30%` and `top: 70%` for flow merging     |

### 8.8 Canvas Controls

| Element          | Position                  | Size         | Source                   |
| ---------------- | ------------------------- | ------------ | ------------------------ |
| Zoom toolbar     | bottom: 16px, left: 16px  | 32px buttons | [Source: line 4963-4982] |
| Minimap          | bottom: 16px, right: 16px | 160x100px    | [Source: line 8217-8218] |
| Minimap viewport | Calculated from scale/pan | Dynamic      | [Source: line 8240-8245] |

### 8.9 Panel Positioning

| Panel            | Position                                                         | z-index | Source               |
| ---------------- | ---------------------------------------------------------------- | ------- | -------------------- |
| Config panel     | `position: fixed; top: 0; right: 0; height: 100vh; width: 520px` | 200     | [Source: line ~1800] |
| Script panel     | Same as config panel                                             | 200     | [Source: line ~1900] |
| Field drawer     | `position: fixed; top: 0; right: 0; height: 100vh; width: 420px` | 200     | [Source: line ~2000] |
| Validation panel | `position: absolute; top: 12px; right: 12px` inside canvas       | 40      | [Source: line 4985]  |
| Test routing     | `position: absolute; top: 12px; left: 12px` inside canvas        | 40      | [Source: line 5102]  |
| Version history  | `position: absolute; top: 12px; right: 12px` inside canvas       | 40      | Same as validation   |

### 8.10 Animations and Transitions

| Animation                | Duration | Easing             | Source                   |
| ------------------------ | -------- | ------------------ | ------------------------ |
| Panel slide in/out       | 300ms    | ease-out           | [Source: line ~1820]     |
| Field drawer slide       | 300ms    | ease-out           | [Source: line ~2020]     |
| Canvas auto-pan          | 300ms    | CSS transition     | [Source: line 8694]      |
| Stage expand/collapse    | 300ms    | ease-out           | [Source: line ~500]      |
| Flow highlight/dim       | 300ms    | opacity transition | [Source: line 7828-7829] |
| Flow highlight restore   | 3000ms   | (timeout)          | [Source: line 7834]      |
| Skeleton shimmer         | 1200ms   | auto-hide          | [Source: line 8003]      |
| Toast auto-dismiss       | 2500ms   | fade 300ms         | [Source: line 8258-8261] |
| Deploy status transition | 2200ms   | (timeout)          | [Source: line 7900-7907] |
| Node hover lift          | 200ms    | ease               | [Source: line ~470]      |
| Tooltip show             | 3000ms   | auto-hide          | [Source: line 7994]      |
| Popover remove animation | 200ms    | opacity+transform  | [Source: line 8398-8401] |

### 8.11 Internationalization (i18n)

All user-facing strings MUST use `useTranslations('search_ai.pipeline')` from `next-intl`. The existing `search_ai.pipeline` namespace in `packages/i18n/locales/en/studio.json` already has ~120 keys. New components require new keys added to this namespace.

- All labels, button text, tooltips, placeholder text, validation messages, toast messages, dialog titles, and empty-state messages use `t('key')`.
- All `aria-label` attributes use `t('aria_key')` (accessibility text needs i18n too).
- Status values from the DB (e.g., `'draft'`, `'active'`, `'archived'`) go through `t('status_' + value)`.
- Literal English strings in the wireframe (e.g., "Fail", "Continue", "Dead letter", "Enabled", "Disabled") are for reference only. Implementation uses translation keys.
- Module-level constants with English labels must move inside the component body as `useMemo(() => [...], [t])` since `t()` requires React context.

### 8.12 Error, Loading, and Empty States

Every component that makes API calls must implement three states:

**Loading states**:

| Component              | Loading Indicator                              | Trigger                       |
| ---------------------- | ---------------------------------------------- | ----------------------------- |
| PipelineEditorPage     | Full skeleton overlay (1200ms)                 | Initial load, pipeline switch |
| ConfigSidePanel        | `<Skeleton>` rows in config form               | Opening (fetching schemas)    |
| ScriptSidePanel        | `<Skeleton>` for code editor area              | Opening                       |
| EmbeddingFieldsDrawer  | `<Skeleton>` rows for field list               | Opening (fetching fields)     |
| TestRoutingPanel       | Spinner in result area                         | Running test                  |
| VersionHistoryPanel    | `<Skeleton>` rows for version list             | Loading versions              |
| Deploy confirmation    | Button disabled + spinner text                 | Deploy in progress            |
| Test Connection/Script | Button disabled + "Connecting..."/"Running..." | Test in progress              |

**Error states**:

| Component             | Error UI                                                |
| --------------------- | ------------------------------------------------------- |
| PipelineEditorPage    | Error banner with retry button, replacing canvas        |
| ConfigSidePanel       | Inline error alert above form, retry fetching schemas   |
| ScriptSidePanel       | Inline error alert if script fails to load              |
| EmbeddingFieldsDrawer | Inline error alert if field fetch fails                 |
| TestRoutingPanel      | Red result card with error message                      |
| VersionHistoryPanel   | Inline error alert with retry                           |
| Test Connection       | Red result card: "Connection failed" + error detail     |
| Test Script           | Red result card: "Script error" + error detail + timing |
| Deploy                | Toast with error message; badge stays at current status |
| Save Draft            | Toast with error; saveStatus -> 'error' in store        |

**Empty states**:

| Component             | Empty UI                                           |
| --------------------- | -------------------------------------------------- |
| VersionHistoryPanel   | "No version history available" with muted text     |
| EmbeddingFieldsDrawer | "No fields available" (if no sources connected)    |
| ValidationPanel       | Green success banner: "No validation issues found" |
| TestRoutingPanel      | Prompt to enter test document properties           |

### 8.13 Keyboard Accessibility

| Interaction                 | Keyboard Support                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Escape key                  | Closes active panel/drawer/modal. Already specified in I-23.                                                       |
| Tab order                   | Follows DOM order: toolbar -> sidebar -> canvas -> panels.                                                         |
| Focus trapping              | Side panels and modals trap focus within while open.                                                               |
| Enter to confirm            | Modals (Deploy, Embedding Change) confirm on Enter.                                                                |
| Arrow keys in FieldDrawer   | Up/Down to navigate field checkboxes within a section.                                                             |
| Ctrl+S / Cmd+S              | Save draft (existing in `PipelineEditor.tsx`).                                                                     |
| Canvas node navigation      | Tab through canvas nodes in visual order (left-to-right, top-to-bottom).                                           |
| Screen reader announcements | State changes (save complete, deploy started, validation results) announced via `aria-live="polite"` region.       |
| ARIA roles                  | Canvas: `role="application"`. Panels: `role="dialog"`. Sidebar: `role="navigation"`. Stage nodes: `role="button"`. |

---

## 9. Traceability Matrix

Maps every design objective (from `PIPELINE-DESIGN-OBJECTIVES.md`) to the component(s) and interaction(s) that implement it.

| Objective | Description                                                 | Components                                                                                      | Interactions           |
| --------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------- |
| **O-1**   | Fixed-order stages with position-aware intermediate inserts | `AddStageButton`, `AddStagePopover` (disabled items)                                            | I-09, I-10             |
| **O-2**   | Stage I/O complexity abstracted, seamless config            | `StageNode`, `StageExpandedForm`, `ProviderConfigSection`, `ConfigSidePanel`, `ScriptSidePanel` | I-08, I-13, I-15, I-17 |
| **O-3**   | Entire pipeline in single unified view                      | `CanvasContainer`, `CanvasWorld`, `CanvasSVG`, `FlowsSidebar`                                   | I-36 to I-44           |
| **O-4**   | Multiple pipelines, one custom active + default fallback    | `PipelineSelector`, `PipelineDropdown`, `PipelineDropdownItem`                                  | I-01, I-02, I-04       |
| **O-5**   | Default pipeline: locked stages, insertable between         | `DefaultPipelineBanner`, `StageNode` (locked state), `AddStageButton`                           | I-02 (default mode)    |
| **O-6**   | Building new stage types is out of scope                    | `AddStagePopover` (fixed list of stage types)                                                   | I-09                   |
| **O-7**   | Strong UX with PM review cycles                             | All UI components follow consistent patterns                                                    | All                    |
| **O-8**   | Up to 3 design options grounded in codebase                 | This spec is the single selected design                                                         | --                     |
| **O-9**   | Layout fits within existing app shell                       | `PipelineEditorPage` respects app sidebar + KB header + tabs                                    | Layout constraints     |

### Design Principles Traceability

| Principle                         | Implementation                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| Flows are part of pipelines       | `FlowsSidebar` inside `PipelineEditor`; flows stored on `ISearchPipelineDefinition.flows` |
| Default pipeline is FALLBACK only | `ExecutionOrderIndicator` shows "Custom flows -> no match -> Default Pipeline"            |
| Consistency over cleverness       | Every stage uses same `toggleExpand()` click pattern (I-08)                               |
| Show the full picture             | All flows visible on canvas simultaneously; `FlowsSidebar` lists all flows                |
| Prevent, don't correct            | Position-aware insert popover disables invalid stage types (I-09, I-10)                   |
| Auto-sync, don't notify           | Field drawer fields appear automatically when sources connect -- no banners or badges     |
| Providers, not stage types        | `ProviderSelect` dropdown within each stage; 5 fixed stage types                          |
| Dynamic config forms              | `ProviderConfigSection` switches based on selected provider (I-13)                        |
| Test before deploy                | Custom API/Script panels include Test tabs (I-21, I-22)                                   |

### Backend Model to Component Mapping

| Model Field                            | Component(s)                                          |
| -------------------------------------- | ----------------------------------------------------- |
| `ISearchPipelineDefinition.name`       | `PipelineSelector` label                              |
| `ISearchPipelineDefinition.status`     | `PipelineSelector` badge (Active/Draft/Fallback)      |
| `ISearchPipelineDefinition.version`    | `VersionHistoryPanel`                                 |
| `ISearchPipelineDefinition.flows`      | `FlowsSidebar`, `FlowItem`, per-flow `StageNode` sets |
| `ISearchPipelineFlow.selectionRules`   | `ContentRouterNode` routes display                    |
| `ISearchPipelineFlow.stages`           | Per-flow `StageNode` instances on canvas              |
| `ISearchPipelineStage.type`            | `StageColorBar` color, `StageTypeLabel` text          |
| `ISearchPipelineStage.provider`        | `StageProviderLabel`, `ProviderSelect` value          |
| `ISearchPipelineStage.providerConfig`  | `ProviderConfigSection` form fields                   |
| `IActiveEmbeddingConfig`               | `EmbeddingInfoCard`, `EmbeddingNode` config           |
| `providerConfig.overrides` (field-sel) | `EmbeddingFieldsDrawer` override list                 |

### Provider Registry to Component Mapping

| Registry Provider                      | UI Component                   | Config Tier |
| -------------------------------------- | ------------------------------ | ----------- |
| `DoclingExtraction`                    | Inline `ProviderConfigSection` | Simple      |
| `LlamaIndexExtraction`                 | Inline `ProviderConfigSection` | Simple      |
| `HttpWebhook` (extraction/enrichment)  | `ConfigSidePanel` (520px)      | Complex     |
| `JavaScriptSandbox` (ext/chunk/enrich) | `ScriptSidePanel` (520px)      | Complex     |
| `TreeBuilderChunking`                  | Inline `ProviderConfigSection` | Simple      |
| `RecursiveCharacterChunking`           | Inline `ProviderConfigSection` | Simple      |
| `FixedSizeChunking`                    | Inline `ProviderConfigSection` | Simple      |
| `LLMEnrichment`                        | Inline `ProviderConfigSection` | Simple      |
| `QuestionSynthesis`                    | Inline `ProviderConfigSection` | Simple      |
| `BGEM3Embedding`                       | Inline (shared node)           | Simple      |

---

## Appendix A: Existing Studio Components

The following components already exist in `apps/studio/src/components/search-ai/pipelines/` and should be evolved rather than rewritten:

| File                         | Current Purpose          | Evolution Needed                                   |
| ---------------------------- | ------------------------ | -------------------------------------------------- |
| `PipelineEditor.tsx`         | Top-level editor wrapper | Integrate canvas, sidebar, panels                  |
| `PipelineCanvas.tsx`         | Canvas rendering         | Adopt React Flow; implement all node types         |
| `PipelineHeader.tsx`         | Header with actions      | Becomes `PipelineToolbar`                          |
| `FlowsList.tsx`              | Flow listing             | Becomes `FlowsSidebar` with collapse               |
| `FlowDetail.tsx`             | Individual flow detail   | Merge into `FlowItem`                              |
| `StageConfigPanel.tsx`       | Stage configuration      | Evolve into side panel for complex providers       |
| `ProviderConfigForm.tsx`     | Provider config form     | Evolve for JSON Schema-driven dynamic forms        |
| `AddStageModal.tsx`          | Stage insertion          | Replace with `AddStagePopover` (inline, not modal) |
| `ChangeEmbeddingDialog.tsx`  | Embedding change warning | Keep, integrate with `EmbeddingNode`               |
| `EmbeddingConfigSection.tsx` | Embedding config         | Keep for `EmbeddingInfoCard` in sidebar            |
| `ReindexConfirmDialog.tsx`   | Reindex confirmation     | Keep, integrate with deploy flow                   |
| `RuleBuilderPanel.tsx`       | Routing rule builder     | Keep for `ContentRouterNode` edit mode             |
| `TestSelectionModal.tsx`     | Test flow selection      | Evolve into `TestRoutingPanel` (inline, not modal) |
| `index.ts`                   | Barrel exports           | Update exports                                     |

## Appendix B: React Flow Integration Notes

> **Important**: The wireframe (`pipeline-v2-unified-canvas.html`) uses vanilla JS for canvas pan/zoom/edges because it is a standalone HTML demo. The production implementation uses **React Flow** (`@xyflow/react`), which is already integrated in `PipelineCanvas.tsx`. Do NOT implement the vanilla JS canvas state management (`scale`, `panX`, `panY`, `isPanning`) -- these are handled internally by React Flow.

The production implementation uses **React Flow** (`@xyflow/react`):

1. **Custom nodes**: Each node type (entry, decision, stage, merge, field-selection, output) becomes a custom React Flow node with its own component.
2. **Custom edges**: Bezier edges with glow effect become custom React Flow edge components using the same cubic bezier formula: `M x1,y1 C mx,y1 mx,y2 x2,y2`.
3. **Viewport control**: `useReactFlow().setViewport()` replaces manual `panX/panY/scale` management.
4. **Auto-pan for panels**: Use `fitView()` or `setViewport()` with animation to keep selected node visible when a 520px panel opens.
5. **Minimap**: React Flow has a built-in `<MiniMap>` component.
6. **Background**: React Flow has a built-in `<Background>` component for the dot grid.
7. **Node positions**: The wireframe positions map directly to React Flow node `position` objects.
8. **Edge connections**: Define edges as `{ source, target, sourceHandle, targetHandle }` arrays derived from pipeline flow/stage data.

Canvas zoom range: [0.3, 2.0], default scale: 0.85. [Source: line 8009, 8041-8042]

Zoom step for buttons: 0.15. [Source: line 8074, 8078]
Zoom step for wheel: 0.05. [Source: line 8041]
Fit-to-view: scale=0.7, panX=20, panY=10. [Source: line 8082-8084]
