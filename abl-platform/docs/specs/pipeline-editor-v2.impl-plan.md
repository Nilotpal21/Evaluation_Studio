# Pipeline Editor V2 — Implementation Plan

> Based on `pipeline-editor-v2.component-spec.md`, architecture review, and phase audit findings.
> All spec references use `[Spec §X]` notation. Wireframe references use `[Source: line N]`.

---

## 4-Phase Approach

| Phase | Name                                    | Goal                                                                                     | Output                                           |
| ----- | --------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1     | **Complete UI + Wire Existing Backend** | Build the FULL pipeline editor UI. Wire every feature that the backend already supports. | Working UI + **Gap Manifest** (unwired features) |
| 2     | **Design Missing Backend**              | Read Phase 1 Gap Manifest. Design the backend APIs/models needed to close each gap.      | Backend design spec per gap                      |
| 3     | **Implement Missing Backend + Wire UI** | Build the missing backend. Wire it to the UI. Close all gaps from Phase 1.               | Fully wired experience                           |
| 4     | **Review Memory**                       | Phase 1-3 outcomes become structured reviewer memory. Full experience review.            | Reviewer context doc + final review              |

---

## Conventions

- **Package**: `apps/studio` unless noted otherwise
- **i18n**: All user-facing strings via `useTranslations('search_ai.pipeline')` — new keys added to `packages/i18n/locales/en/studio.json`
- **Design tokens**: Use `getIntentStyles()`, `pipelineStageIntent()`, `STAGE_INTENT_OVERRIDES` from `@agent-platform/design-tokens` and `PipelineCanvas.tsx` — never raw hex
- **State**: Evolve `usePipelineStore` at `apps/studio/src/store/pipeline-store.ts` — never replace
- **Canvas**: React Flow (`@xyflow/react`) — never vanilla JS pan/zoom
- **Single-pipeline mode**: No multi-pipeline backend changes (Spec §7.1 decision)
- **Commit scope**: Max 40 files, max 3 packages per commit

---

## Phase 1: Complete UI + Wire Existing Backend

**Goal**: Build the FULL pipeline editor experience as designed in the wireframe. Wire every feature to existing backend APIs where they exist. For features that have no backend support, build the UI anyway with clear placeholder/mock behavior, and document each unwired feature in the **Gap Manifest**.

**Deliverable**: Complete, navigable, interactive UI that a PM can click through. Plus a structured gap list.

### What Already Exists (backend support)

From Spec §6.1, these endpoints EXIST and should be wired:

| Endpoint                                                     | Wires To                        |
| ------------------------------------------------------------ | ------------------------------- |
| `GET .../pipelines`                                          | Load pipeline for canvas        |
| `POST .../pipelines`                                         | Create New Pipeline modal       |
| `PATCH .../pipelines/:id`                                    | Save Draft button               |
| `POST .../pipelines/:id/publish`                             | Deploy button                   |
| `POST .../pipelines/:id/validate`                            | Validate button                 |
| `GET .../pipelines/providers/:stageType`                     | Provider dropdown options       |
| `POST .../pipelines/providers/:stageType/:providerId/schema` | Dynamic provider config forms   |
| `PATCH .../embedding-config`                                 | Embedding provider change modal |
| `GET .../providers/embedding`                                | Embedding provider list         |
| `POST .../trigger-pipeline` (doc + source)                   | Pipeline re-run after deploy    |

### What Does NOT Exist Yet (will become Gap Manifest)

From Spec §7:

| Gap ID | Feature                    | UI Behavior Without Backend                               |
| ------ | -------------------------- | --------------------------------------------------------- |
| G-1    | Multi-pipeline list        | Show single pipeline only (selector shows 1 + Default)    |
| G-2    | Pipeline version history   | Show version list with mock data, restore button disabled |
| G-3    | Webhook/Script test        | Test buttons show simulated success (no real execution)   |
| G-4    | Embedding fields API       | Drawer shows mock canonical fields, save is local-only    |
| G-5    | Provider config validation | Client-side validation only, no server round-trip         |
| G-6    | Test routing simulation    | Client-side MIME type matching (already in wireframe)     |

### Task Breakdown

#### Task 1.1: Foundation — Store + Canvas Shell + Nodes

**Package(s)**: apps/studio
**Est. Files**: 6 new, 6 modified
**Dependencies**: None

**What**: Evolve the Zustand store with V2 fields. Create custom React Flow node type components for every node in the wireframe (Document Ingress, Content Router, Stage Node, Merge, Embedding Fields, Embedding, OpenSearch). Build a graph builder that converts pipeline data into React Flow nodes and edges. Render the full canvas with all flows visible simultaneously.

**Files to Create**:

- `apps/studio/src/components/search-ai/pipelines/v2/nodes/DocumentIngressNode.tsx` — Entry point node [Spec §2, Source: line 3066-3087]
- `apps/studio/src/components/search-ai/pipelines/v2/nodes/ContentRouterNode.tsx` — Decision node with routing rules [Spec §2, Source: line 3090-3132]
- `apps/studio/src/components/search-ai/pipelines/v2/nodes/StageNode.tsx` — Main stage node with color bar, drag handle, ports, header, config summary, footer badges, expandable form [Spec §2, Source: line 3134-3305]
- `apps/studio/src/components/search-ai/pipelines/v2/nodes/MergeNode.tsx` — Flow merge point [Source: line 4678-4716]
- `apps/studio/src/components/search-ai/pipelines/v2/nodes/EmbeddingFieldsNode.tsx` — Field selection gate [Source: line 4719-4796]
- `apps/studio/src/components/search-ai/pipelines/v2/nodes/SharedStageNode.tsx` — Locked shared nodes (Embedding, OpenSearch) [Source: line 4799-4958]
- `apps/studio/src/components/search-ai/pipelines/v2/graph-builder.ts` — Converts `ISearchPipelineDefinition` → React Flow `Node[]` + `Edge[]`
- `apps/studio/src/components/search-ai/pipelines/v2/edge-styles.ts` — Custom bezier edge with glow effect per stage type color [Spec §3.8, Source: line 8091-8210]
- `apps/studio/src/components/search-ai/pipelines/v2/PipelineCanvasV2.tsx` — Main canvas component wrapping React Flow [Spec §2]

**Files to Modify**:

- `apps/studio/src/store/pipeline-store.ts` — Add V2 fields: `flowsSidebarCollapsed`, `activePanelType`, `activePanelNodeId`, `activePanelStageType`, `expandedStageId` [Spec §4.1]
- `apps/studio/src/api/pipelines.ts` — Add `getProviders(stageType)`, `getProviderSchema(stageType, providerId)` API functions

**Acceptance Criteria**:

- [ ] Canvas renders all nodes from a real pipeline (fetched via existing GET endpoint)
- [ ] Nodes are positioned left-to-right in correct DAG layout
- [ ] Bezier edges connect nodes with stage-type colors and glow effects
- [ ] Canvas supports pan and zoom (React Flow built-in)
- [ ] Minimap shows viewport indicator
- [ ] Zoom controls (+/−/fit) work

**Exit Criteria**:

- `pnpm build --filter=studio` passes
- Visual: Open pipeline page → see full DAG with all flows and shared zone

---

#### Task 1.2: Flows Sidebar

**Package(s)**: apps/studio
**Est. Files**: 2 new, 1 modified
**Dependencies**: Task 1.1

**What**: Build the collapsible flows sidebar (220px → 40px). Lists all flows with name, priority, document count. "Add Flow" button. Embedding config summary card. Click flow → highlight its nodes on canvas (others dim for 3s).

**Files to Create**:

- `apps/studio/src/components/search-ai/pipelines/v2/FlowsSidebar.tsx` — Sidebar with flow list, collapse toggle, add flow button, embedding info [Spec §2, I-05 through I-07]
- `apps/studio/src/components/search-ai/pipelines/v2/FlowItem.tsx` — Individual flow row with name, priority badge, doc count

**Wired to Backend**: Flow data comes from pipeline definition (already fetched). No new endpoint needed.

**Acceptance Criteria**:

- [ ] Sidebar shows all flows from the pipeline
- [ ] Click flow → that flow's nodes highlight, others dim for 3s [I-05]
- [ ] Collapse/expand toggles sidebar width [I-06]
- [ ] Edge redraw happens after sidebar transition [I-06 behavior]
- [ ] Add Flow button shows toast (no backend for flow creation yet)

---

#### Task 1.3: Stage Node Expansion + Provider Config

**Package(s)**: apps/studio
**Est. Files**: 8 new, 2 modified
**Dependencies**: Task 1.1

**What**: Implement click-to-expand on stage nodes. Build inline provider config forms for ALL simple providers (Docling, LlamaIndex, Tree Builder, Recursive Character, Fixed Size, LLM Enrichment, Question Synthesis). Provider dropdown dynamically swaps config form. Build the 520px Custom API side panel and Custom Script side panel with all 4 tabs each. Wire `getProviderSchema()` to populate config forms from backend when available.

**Files to Create**:

- `apps/studio/src/components/search-ai/pipelines/v2/StageExpandedForm.tsx` — Provider dropdown + dynamic config switching [I-08, I-13]
- `apps/studio/src/components/search-ai/pipelines/v2/providers/DoclingConfig.tsx` — OCR, tables, images, on error, fallback [Spec §5.1]
- `apps/studio/src/components/search-ai/pipelines/v2/providers/LlamaIndexConfig.tsx` — Format, language, on error, fallback [Spec §5.1]
- `apps/studio/src/components/search-ai/pipelines/v2/providers/TreeBuilderConfig.tsx` — Strategy, max tokens, overlap [Spec §5.2]
- `apps/studio/src/components/search-ai/pipelines/v2/providers/ChunkingConfig.tsx` — Shared config for Recursive Character and Fixed Size [Spec §5.2]
- `apps/studio/src/components/search-ai/pipelines/v2/providers/EnrichmentConfig.tsx` — Shared config for LLM Enrichment and Question Synthesis [Spec §5.3]
- `apps/studio/src/components/search-ai/pipelines/v2/ConfigSidePanel.tsx` — 520px Custom API panel with 4 tabs: Config, Auth & Headers, Behavior, Test [Spec §5.5, I-15 through I-26]
- `apps/studio/src/components/search-ai/pipelines/v2/ScriptSidePanel.tsx` — 520px Custom Script panel with 4 tabs: Script, Variables, Settings, Test [Spec §5.6, I-17 through I-26]

**Files to Modify**:

- `apps/studio/src/components/search-ai/pipelines/v2/nodes/StageNode.tsx` — Add expanded state rendering
- `apps/studio/src/store/pipeline-store.ts` — Add `expandedStageId` handling

**Wired to Backend**:

- Provider list → `GET .../providers/:stageType` (EXISTS)
- Provider schema → `POST .../providers/:stageType/:providerId/schema` (EXISTS)
- Save stage config → `PATCH .../pipelines/:id` (EXISTS — stage data is part of pipeline)

**NOT Wired (Gap Manifest)**:

- Test Connection button → G-3: shows simulated success, no real execution
- Test Script button → G-3: shows simulated success, no real execution
- Provider config server-side validation → G-5: client-side only

**Acceptance Criteria**:

- [ ] Click stage node → expands inline form [I-08]
- [ ] Change provider dropdown → config form swaps [I-13]
- [ ] Select Custom API → 520px side panel slides in from right [I-15]
- [ ] Select Custom Script → 520px side panel slides in [I-17]
- [ ] Canvas auto-pans to keep node visible beside panel [I-24]
- [ ] Escape key closes panel [I-23]
- [ ] Panel tabs switch content [I-18]
- [ ] Auth type switching shows/hides fields [I-19]
- [ ] Headers can be added/removed [I-20]
- [ ] Provider configs are saved via PATCH when Save is clicked

---

#### Task 1.4: Position-Aware Insert Popovers

**Package(s)**: apps/studio
**Est. Files**: 2 new, 1 modified
**Dependencies**: Task 1.1

**What**: Build the `+` buttons between stages that open context-aware popovers showing only valid stage types for that position. Custom API and Custom Script appear as provider options. Already-present types shown as disabled.

**Files to Create**:

- `apps/studio/src/components/search-ai/pipelines/v2/AddStagePopover.tsx` — Position-aware popover with valid stage types [Spec §2, I-09, I-10]
- `apps/studio/src/components/search-ai/pipelines/v2/stage-insertion-rules.ts` — Logic for which stages are valid between which positions [Spec §3.3]

**Wired to Backend**: Adding a stage → modifies the flow's `stages[]` array → saved via `PATCH .../pipelines/:id`

**Acceptance Criteria**:

- [ ] `+` button between Extraction and Chunking shows Enrichment, Custom API, Custom Script [I-09]
- [ ] Already-present stage types are disabled [I-10]
- [ ] Clicking a valid option adds the stage to the pipeline and re-renders canvas
- [ ] Pipeline data is saved to backend after adding a stage

---

#### Task 1.5: Embedding Fields Drawer

**Package(s)**: apps/studio
**Est. Files**: 4 new, 1 modified
**Dependencies**: Task 1.1

**What**: Build the 420px side drawer for Embedding Fields node. Currently Embedding section (pinned selected fields), Available Fields sections (Core/Common/Custom, collapsible), per-source toggles, Global/Pipeline override indicators, Reset All to Global, Save Changes.

**Files to Create**:

- `apps/studio/src/components/search-ai/pipelines/v2/EmbeddingFieldsDrawer.tsx` — Main drawer shell [Spec §2, I-27 through I-35]
- `apps/studio/src/components/search-ai/pipelines/v2/FieldSection.tsx` — Collapsible field category section (Core/Common/Custom) [I-29]
- `apps/studio/src/components/search-ai/pipelines/v2/FieldItem.tsx` — Individual field with checkbox, type badge, origin indicator, expandable source breakdown [I-30, I-31]
- `apps/studio/src/components/search-ai/pipelines/v2/CurrentlyEmbeddingSection.tsx` — Pinned list of selected fields with × remove [I-32]

**NOT Wired (Gap Manifest)**:

- G-4: No backend API for canonical field definitions or override persistence
- Drawer shows MOCK canonical fields (hardcoded 12 core + sample common/custom)
- Save writes to local state only (not persisted to backend)
- Reset All to Global works in local state

**Acceptance Criteria**:

- [ ] Click Embedding Fields node → 420px drawer slides in [I-27]
- [ ] Currently Embedding shows selected fields [I-32]
- [ ] Toggle field checkbox → adds/removes from Currently Embedding [I-31]
- [ ] Expand field → shows per-source toggles [I-30]
- [ ] Toggle source → origin changes to "✎ Pipeline" [I-33]
- [ ] Reset All to Global works [I-34]
- [ ] Close via ×, Escape, or dimmed overlay click [I-28]

---

#### Task 1.6: Pipeline Management UI

**Package(s)**: apps/studio
**Est. Files**: 4 new, 2 modified
**Dependencies**: Task 1.1

**What**: Build pipeline selector dropdown (single-pipeline mode: shows the one pipeline + Default Pipeline). Default pipeline lock behavior (all stages locked, banner, `+` buttons still active). Unsaved changes tracking. Toolbar actions (Save Draft, Deploy, Validate, Test Routing, Version History).

**Files to Create**:

- `apps/studio/src/components/search-ai/pipelines/v2/PipelineSelector.tsx` — Dropdown with pipeline list + Create New [I-01 through I-04]
- `apps/studio/src/components/search-ai/pipelines/v2/PipelineToolbar.tsx` — Actions bar with all buttons [I-46 through I-52]
- `apps/studio/src/components/search-ai/pipelines/v2/DefaultPipelineBanner.tsx` — Lock banner for default pipeline [I-02]
- `apps/studio/src/components/search-ai/pipelines/v2/UnsavedIndicator.tsx` — Yellow dot + label [I-53, I-54]

**Wired to Backend**:

- Save Draft → `PATCH .../pipelines/:id` (EXISTS)
- Deploy → `POST .../pipelines/:id/publish` (EXISTS)
- Validate → `POST .../pipelines/:id/validate` (EXISTS)
- Create Pipeline → `POST .../pipelines` (EXISTS, single-pipeline only)

**NOT Wired (Gap Manifest)**:

- G-1: Pipeline selector shows only 1 pipeline (multi-pipeline blocked by unique index)
- G-2: Version History shows mock data, restore button disabled

**Acceptance Criteria**:

- [ ] Pipeline selector shows current pipeline + Default Pipeline [I-01]
- [ ] Selecting Default Pipeline → all stages lock, banner shows [I-02]
- [ ] Save Draft calls PATCH endpoint [I-46]
- [ ] Deploy opens confirmation modal, then calls publish [I-47, I-48]
- [ ] Validate calls validate endpoint, shows results panel [I-49]
- [ ] Unsaved indicator appears when form state is dirty [I-53]

---

#### Task 1.7: Modals + Panels

**Package(s)**: apps/studio
**Est. Files**: 5 new, 0 modified
**Dependencies**: Task 1.6

**What**: Build all modals and overlay panels: Deploy Confirmation (with reindex impact), Embedding Change Warning, New Pipeline Creation, Validation Results panel, Test Routing panel, Version History panel.

**Files to Create**:

- `apps/studio/src/components/search-ai/pipelines/v2/DeployConfirmModal.tsx` — Change summary, reindex warning, affected sources [I-47, I-48]
- `apps/studio/src/components/search-ai/pipelines/v2/EmbeddingChangeModal.tsx` — Full reindex warning [I-14]
- `apps/studio/src/components/search-ai/pipelines/v2/NewPipelineModal.tsx` — Name + description [I-04]
- `apps/studio/src/components/search-ai/pipelines/v2/ValidationPanel.tsx` — Errors/warnings list overlay [I-49]
- `apps/studio/src/components/search-ai/pipelines/v2/TestRoutingPanel.tsx` — MIME type selector + flow matching [I-50, I-51]
- `apps/studio/src/components/search-ai/pipelines/v2/VersionHistoryPanel.tsx` — Version list [I-52]

**Wired to Backend**:

- Validation results → from `POST .../validate` response
- Deploy → uses `POST .../publish`
- Embedding change → uses `PATCH .../embedding-config`

**NOT Wired**:

- G-2: Version history shows mock versions, restore disabled
- G-6: Test routing is client-side MIME matching (no backend needed)

**Acceptance Criteria**:

- [ ] Deploy modal shows change summary before confirming
- [ ] Embedding change shows reindex warning with chunk count
- [ ] Validation panel shows errors/warnings from API
- [ ] Test routing simulates flow matching client-side
- [ ] Version history shows version list (mock data)

---

#### Task 1.8: Loading, Empty, Error States + Skeleton

**Package(s)**: apps/studio
**Est. Files**: 2 new, 3 modified
**Dependencies**: Tasks 1.1-1.7

**What**: Add loading skeleton (shimmer during pipeline load/switch), empty state (new pipeline with no flows), error states (API failures), and toast notifications. This is the polish pass.

**Files to Create**:

- `apps/studio/src/components/search-ai/pipelines/v2/PipelineSkeleton.tsx` — Shimmer overlay during pipeline load [I-55]
- `apps/studio/src/components/search-ai/pipelines/v2/EmptyPipelineState.tsx` — Empty state for new pipelines

**Acceptance Criteria**:

- [ ] Loading skeleton shows during pipeline fetch
- [ ] Empty state appears for pipeline with no flows
- [ ] Toast notifications for save/deploy/create/reset actions [I-56]
- [ ] API error → error toast with retry action

---

### Phase 1 Gap Manifest Template

At the end of Phase 1, produce this document:

```markdown
# Pipeline Editor V2 — Gap Manifest

## Wired Features (working end-to-end)

- [ ] Pipeline CRUD (create, read, update via Save Draft)
- [ ] Deploy + publish
- [ ] Validation
- [ ] Provider listing per stage type
- [ ] Provider schema fetching
- [ ] Stage config save (via pipeline PATCH)
- [ ] Embedding config change
- [ ] Trigger pipeline (document + source)
- ...

## Unwired Features (UI built, backend missing)

### G-1: Multi-Pipeline Support

- UI: Pipeline selector shows 1 pipeline + Default
- Missing: Unique index change, list endpoint, multi-pipeline CRUD
- Impact: Users cannot create multiple pipelines per KB

### G-2: Version History

- UI: Version panel shows mock data
- Missing: Version storage endpoint, restore endpoint
- Impact: Users cannot view or restore previous versions

### G-3: Webhook/Script Testing

- UI: Test buttons show simulated success
- Missing: POST test-execution endpoints
- Impact: Users cannot validate webhook connectivity or script correctness

### G-4: Embedding Fields API

- UI: Drawer shows mock canonical fields
- Missing: Field listing endpoint, override persistence endpoint
- Impact: Field selection is not persisted

### G-5: Provider Config Server Validation

- UI: Client-side validation only
- Missing: Wiring validateConfig() at REST layer
- Impact: Invalid configs may be saved

### G-6: Test Routing (OK — client-side only)

- UI: Works with client-side MIME matching
- No backend needed — this is complete
```

---

## Phase 2: Design Missing Backend

**Goal**: Read the Phase 1 Gap Manifest. For each unwired feature, design the backend API (endpoint, request/response schema, model changes, security concerns).

**Input**: Gap Manifest from Phase 1
**Output**: Backend design spec for each gap

### Tasks

#### Task 2.1: Design Backend APIs for Each Gap

For each gap in the manifest:

- Define endpoint path, method, request/response schema
- Identify model changes needed (e.g., unique index for G-1)
- Identify security concerns (e.g., SSRF for G-3 webhook testing)
- Identify data migration needs
- Define acceptance criteria

#### Task 2.2: Review Backend Design

- Architecture review of proposed endpoints against platform principles
- Tenant isolation verification
- Auth/permission model verification
- Performance implications

---

## Phase 3: Implement Missing Backend + Wire UI

**Goal**: Build every backend API designed in Phase 2. Wire each to the UI components built in Phase 1. Close all gaps.

**Input**: Phase 2 backend design spec
**Output**: Fully wired experience — no mock data, no simulated responses

### Tasks

#### Task 3.1: Implement Backend APIs

Per gap:

- **G-1**: Multi-pipeline support (if approved) or keep single-pipeline
- **G-2**: Version history storage + restore endpoint
- **G-3**: Webhook test endpoint (with SSRF protection) + Script sandbox test endpoint
- **G-4**: Embedding fields listing + override persistence
- **G-5**: Wire `validateConfig()` from provider registry into REST validation

#### Task 3.2: Wire UI to New Backend

Replace all mock/simulated behavior in Phase 1 components:

- Version History panel → real API calls
- Test Connection/Script buttons → real execution endpoints
- Embedding Fields drawer → real field data + persistence
- Validation → server-side validation results

#### Task 3.3: Integration Testing

- E2E test: Create pipeline → configure stages → deploy → verify
- E2E test: Custom API provider → test connection → save → deploy
- E2E test: Embedding fields → select fields → save → verify persistence
- E2E test: Version history → view → restore (if implemented)

---

## Phase 4: Review Memory

**Goal**: Compile all Phase 1-3 outcomes into structured reviewer memory. Conduct final experience review.

**Input**: Complete implementation from Phases 1-3
**Output**: Reviewer context doc + final review findings

### Tasks

#### Task 4.1: Compile Reviewer Memory

Create a structured document capturing:

- **Component inventory**: Every component built, its file path, its spec reference
- **Wiring map**: Every UI feature → backend endpoint → model field (end-to-end trace)
- **Interaction catalog**: All 60+ interactions verified working
- **Known limitations**: Anything deferred or descoped
- **Architecture decisions**: React Flow, Zustand evolution, single-pipeline mode, design tokens
- **Test coverage**: What's tested, what's not

#### Task 4.2: Final Experience Review

Using the reviewer memory:

- Walk through every user scenario from the wireframe
- Verify every interaction from the spec's catalog (I-01 through I-63)
- Check error/loading/empty states
- Verify i18n coverage
- Verify design system token usage
- Performance check with realistic pipeline data
- Produce final findings → fix loop until clean

---

## Risk Register

### Phase 1 Risks

| Risk                                          | Mitigation                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| React Flow node layout conflicts              | Use dagre or elk layout algorithm, not absolute positioning                 |
| Stage node expansion affects layout           | React Flow `nodeTypes` re-render is efficient; test with expanded nodes     |
| Side panel z-index over React Flow            | React Flow renders in SVG; panel is absolutely positioned DOM — no conflict |
| Provider schema API returns unexpected format | Build adapter layer between API response and form renderer                  |

### Phase 2-3 Risks

| Risk                                   | Mitigation                                                              |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Unique index change for multi-pipeline | May require data migration — design carefully, consider backward compat |
| Webhook test SSRF vulnerability        | SSRF protection via URL allowlist/denylist, private IP blocking         |
| Script sandbox escape                  | Use existing `vm.createContext` with timeout; no new attack surface     |

### Cross-Phase Dependencies

```
Phase 1 ──────────────────────────────────────────→ Phase 1 Gap Manifest
                                                          │
                                                          ▼
                                            Phase 2 (Design Backend)
                                                          │
                                                          ▼
                                            Phase 3 (Implement + Wire)
                                                          │
                                                          ▼
                                            Phase 4 (Review Memory)
```

Phase 1 is the largest phase (~8 tasks, ~35 files). Phases 2-4 are smaller but sequential — each depends on the previous phase's output.
