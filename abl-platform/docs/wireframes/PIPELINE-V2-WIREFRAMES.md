# Pipeline Editor V2 — Wireframes & Requirements Reference

> **Status**: Approved wireframes (2026-04-14)
> **Purpose**: Primary reference for implementation. All wireframes validated against confirmed requirements.

---

## Confirmed Requirements

### Two Pipelines per KB

| Pipeline             | Created By | Deletable? | Editable?                                                   | Execution Order |
| -------------------- | ---------- | ---------- | ----------------------------------------------------------- | --------------- |
| **Default Pipeline** | System     | No         | Yes — change providers, add/remove stages, add/remove flows | Fallback (last) |
| **Custom Pipeline**  | User       | Yes        | Yes — full control                                          | First evaluated |

### Default Pipeline — Provider-Based Flows (NOT catch-all)

- **Flow "Rich Documents" (P:1)**: mimeType rules for PDF, DOCX, PPTX, HTML, images → **Docling** extraction
- **Flow "Text Documents" (P:2)**: mimeType rules for text/plain, text/markdown → **LlamaIndex** extraction
- **No catch-all "default flow"** — the two provider-based flows cover all supported MIME types
- User CAN: change providers, change settings, add/remove optional stages, add/remove flows
- User CANNOT: delete the pipeline itself

### Custom Pipeline

- Has a Router + multiple user-defined Flows with selection rules (mimeType, source, CEL expressions)
- Full control: add/edit/delete flows, change providers, configure stages
- Can be deleted entirely
- Only 0 or 1 Custom Pipeline per KB (backend enforces via 409)

### Execution Model

```
Document Arrives
    │
    ▼
Custom Pipeline exists?
    │
    ├── YES → Evaluate custom pipeline flows by priority (highest first)
    │         │
    │         ├── Match found → process through that flow ✅ DONE
    │         │
    │         └── No match → FALL THROUGH to Default Pipeline
    │                        │
    │                        └── Evaluate default pipeline flows by priority
    │                            (provider-based rules cover all MIME types)
    │
    └── NO → Default Pipeline evaluates its flows directly

Every document gets processed. Nothing dropped.
```

### Stage Structure (per flow)

Fixed stage type order: **Extraction → Chunking → [Enrichment] → Embedding → OpenSearch**

- User picks PROVIDER for each stage type (dropdown)
- User configures provider-specific settings
- Optional stages (enrichment, multimodal) can be added/removed
- Embedding config is shared at pipeline level (`activeEmbeddingConfig`)

---

## UX Design Decisions

| #   | Decision                         | Pattern Source     | Rationale                                                                                  |
| --- | -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| 1   | No FlowsSidebar                  | —                  | Canvas swim lanes ARE the navigation; sidebar duplicated flows in two places               |
| 2   | Persistent Detail Panel (420px)  | AWS Step Functions | Always visible, content switches on selection; no open/close jank                          |
| 3   | Edge-Hover Insertion             | Make.com           | Replaces permanent InsertPointNode components; saves ~680px per flow                       |
| 4   | Drag & Drop Stage Reorder        | Industry standard  | Drag handles `⠿` on stage list in detail panel; not ▲/▼ arrows                             |
| 5   | Compound Zone Nodes              | —                  | Ingress (Docs+Router) and Output (Embedding+OpenSearch) collapsed to save space            |
| 6   | Right-Click Context Menu         | Standard           | Secondary access to configure, move, duplicate, remove stages                              |
| 7   | Default Pipeline is editable     | User requirement   | NOT read-only reference — user can change providers, stages, flows                         |
| 8   | Flow deletion allowed everywhere | User requirement   | User can delete flows in both pipelines; only the Default Pipeline itself can't be deleted |

### Layout

```
┌──────────────────────────────────────────────────────────┬────────────────────────┐
│  TOOLBAR                                                 │                        │
│  [Pipeline Selector ▾] [+ Add Flow] [Version] [Save] [Publish]                   │
├──────────────────────────────────────────────────────────┬────────────────────────┤
│                                                          │                        │
│  CANVAS (flex-1)                                         │  DETAIL PANEL (420px)  │
│                                                          │                        │
│  Ingress → Flow swim lanes → Output                     │  Context-aware:        │
│                                                          │  - Empty state         │
│  No FlowsSidebar.                                        │  - Stage config        │
│  No InsertPointNodes.                                    │  - Flow config         │
│                                                          │  - Version history     │
│                                                          │  - Embedding info      │
│                                                          │                        │
├──────────────────────────────────────────────────────────┴────────────────────────┤

Graph: ~2,380px → ~840px. Fits at 85-100% zoom.
```

### Detail Panel — Context Switching

| User Clicks...         | Detail Panel Shows...                                             |
| ---------------------- | ----------------------------------------------------------------- |
| Nothing / empty canvas | Empty state: "Select a stage or flow"                             |
| A stage node           | Stage config (provider, settings, error handling)                 |
| A flow lane header     | Flow config (name, priority, rules, stage list with drag reorder) |
| Compound Output node   | Shared embedding info (read-only)                                 |
| Version toolbar button | Version history, JSON export/import                               |

---

## Wireframes

### Screen 1: Default Pipeline — Landing View

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ TOOLBAR                                                                          │
│ [Default Pipeline ▾]   [+ Add Flow]   [Version]   [Save Draft]   [Publish]      │
├──────────────────────────────────────────────────────────┬────────────────────────┤
│                                                          │                        │
│  CANVAS (flex-1)                                         │  DETAIL PANEL (420px)  │
│                                                          │                        │
│  ┌─────────┐                                             │                        │
│  │ INGRESS │                                             │   ┌──────────────┐     │
│  │ Docs    │                                             │   │   [  icon  ]  │     │
│  │ Router  │                                             │   │              │     │
│  │ 2 flows │──┐                                          │   │  Select a    │     │
│  └─────────┘  │                                          │   │  stage or    │     │
│               │  ┌─ Rich Documents (P:1) ──────────────┐ │   │  flow to     │     │
│               ├─▶│ [Extraction] ──▶ [Chunking] ──▶ [Enrichment] │  configure   │     │
│               │  │  Docling        Tree Builder  LLM   │ │   │              │     │
│               │  └─────────────────────────────────────┘ │   │  Click any   │     │
│               │                                          │   │  stage node  │     │
│               │  ┌─ Text Documents (P:2) ──────────────┐ │   │  or flow     │     │
│               └─▶│ [Extraction] ──▶ [Chunking]         │ │   │  header      │     │
│                  │  LlamaIndex      Recursive Char     │ │   └──────────────┘     │
│                  └─────────────────────────────────────┘ │                        │
│                              │                           │                        │
│                              ▼                           │                        │
│                  ┌─────────────────────┐                 │                        │
│                  │ OUTPUT              │                 │                        │
│                  │  Embedding: BGE-M3  │                 │                        │
│                  │  OpenSearch   [ok]  │                 │                        │
│                  └─────────────────────┘                 │                        │
│                                                          │                        │
├──────────────────────────────────────────────────────────┴────────────────────────┤
```

- No FlowsSidebar — canvas swim lanes ARE the navigation
- Default Pipeline shown as EDITABLE (toolbar has Save/Publish, not grayed out)
- Two provider-based flows: Rich Documents (Docling) + Text Documents (LlamaIndex)
- No catch-all flow
- Compound Ingress node (Documents + Router collapsed)
- Compound Output node (Embedding + OpenSearch collapsed)
- Shared embedding (BGE-M3) shown at pipeline level
- Detail panel shows empty state — persistent, always visible
- `+ Add Flow` in toolbar (not in a removed sidebar)

---

### Screen 2: PipelineSelector — Switching Pipelines

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ TOOLBAR                                                                          │
│ ┌──────────────────────────────┐                                                 │
│ │ Default Pipeline       ▾    │   [+ Add Flow]  [Version]  [Save]  [Publish]    │
│ ├──────────────────────────────┤                                                 │
│ │ ● Default Pipeline           │ ◀── System-created, always exists               │
│ │   2 flows · Active           │     EDITABLE (not read-only)                    │
│ │                              │                                                 │
│ │ ○ My Custom Pipeline         │ ◀── User-created, optional                      │
│ │   3 flows · Draft            │     Fully editable + deletable                  │
│ │                              │                                                 │
│ │ ─────────────────────────── │                                                 │
│ │ + Create Custom Pipeline     │ ◀── Disabled if custom already exists           │
│ │   (disabled: already exists) │     Only ONE custom pipeline per KB             │
│ └──────────────────────────────┘                                                 │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  Canvas shows whichever pipeline is selected.                                    │
│  Both Default and Custom are FULLY EDITABLE.                                     │
│                                                                                  │
│  ┌────────────────────────┬──────────────────┬──────────────────┐                │
│  │                        │ Default Pipeline │ Custom Pipeline  │                │
│  ├────────────────────────┼──────────────────┼──────────────────┤                │
│  │ Delete pipeline        │ ✗ Not allowed    │ ✓ Allowed        │                │
│  │ Edit flows             │ ✓                │ ✓                │                │
│  │ Add/remove flows       │ ✓                │ ✓                │                │
│  │ Change providers       │ ✓                │ ✓                │                │
│  │ Add/remove stages      │ ✓                │ ✓                │                │
│  │ Execution order        │ Fallback (last)  │ First evaluated  │                │
│  │ Delete last flow       │ ✗ Min 1 flow     │ ✗ Min 1 flow     │                │
│  └────────────────────────┴──────────────────┴──────────────────┘                │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- Default Pipeline is EDITABLE (was incorrectly "read-only reference" in old design doc)
- Custom Pipeline can be deleted; Default cannot
- Only 0 or 1 Custom Pipeline per KB — create button disabled when exists
- Execution order: Custom evaluated first → fallthrough to Default

---

### Screen 3: Stage Config — Click a Stage Node

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [Default Pipeline ▾]   [+ Add Flow]   [Version]   [Save Draft]   [Publish]      │
├──────────────────────────────────────────────────────────┬────────────────────────┤
│                                                          │                        │
│  ┌─────────┐                                             │  Stage Configuration   │
│  │ INGRESS │                                             │  ────────────────────  │
│  │ Docs    │                                             │                        │
│  │ Router  │──┐                                          │  Flow: Rich Documents  │
│  └─────────┘  │                                          │  Type: EXTRACTION      │
│               │  ┌─ Rich Documents (P:1) ──────────────┐ │                        │
│               ├─▶│ ╔═══════════╗──▶[Chunking]──▶[Enr.] │ │  Provider:             │
│               │  │ ║Extraction ║   Tree Bldr   LLM     │ │  ┌────────────────┐    │
│               │  │ ║ Docling   ║                       │ │  │ Docling      ▾ │    │
│               │  │ ╚═══════════╝  ◀── accent ring      │ │  └────────────────┘    │
│               │  └─────────────────────────────────────┘ │                        │
│               │                                          │  ─── Settings ───────  │
│               │  ┌─ Text Documents (P:2) ──────────────┐ │                        │
│               └─▶│ [Extraction] ──▶ [Chunking]         │ │  OCR:      [ON ]       │
│                  └─────────────────────────────────────┘ │  Tables:   [ON ]       │
│                              │                           │  Images:   [OFF]       │
│                              ▼                           │  Max Pages: [100__]    │
│                  ┌─────────────────────┐                 │                        │
│                  │ OUTPUT              │                 │  ─── Error Handling ──  │
│                  │  Embedding: BGE-M3  │                 │                        │
│                  │  OpenSearch   [ok]  │                 │  On Error:             │
│                  └─────────────────────┘                 │  ┌────────────────┐    │
│                                                          │  │ Skip document▾│    │
│                                                          │  └────────────────┘    │
│                                                          │                        │
│                                                          │  Fallback Provider:    │
│                                                          │  ┌────────────────┐    │
│                                                          │  │ LlamaIndex   ▾│    │
│                                                          │  └────────────────┘    │
│                                                          │                        │
│                                                          │  [Apply]    [Reset]    │
│                                                          │                        │
├──────────────────────────────────────────────────────────┴────────────────────────┤
```

- User picks PROVIDER per stage via dropdown
- Provider-specific settings shown (OCR, Tables, etc. for Docling)
- Error handling: onError + fallbackProvider (existing schema fields)
- Selected node has accent ring on canvas
- Panel shows which flow this stage belongs to
- Apply/Reset for saving changes

---

### Screen 4: Flow Config — Click Flow Lane Header

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [Default Pipeline ▾]   [+ Add Flow]   [Version]   [Save Draft]   [Publish]      │
├──────────────────────────────────────────────────────────┬────────────────────────┤
│                                                          │                        │
│  ┌─────────┐                                             │  Flow Configuration    │
│  │ INGRESS │                                             │  ────────────────────  │
│  │ Docs    │──┐                                          │                        │
│  └─────────┘  │                                          │  Name:                 │
│               │  ╔═ Rich Documents (P:1) ══════════════╗ │  [Rich Documents____]  │
│               ├─▶║ [Extraction] ──▶ [Chunking] ──▶ [E] ║ │                        │
│               │  ║  Docling        Tree Bldr    LLM    ║ │  Description:          │
│               │  ╚═════════════════════════════════════╝ │  [Process PDF, DOCX,]  │
│               │   ◀── entire lane highlighted            │  [images and HTML___]  │
│               │                                          │                        │
│               │  ┌─ Text Documents (P:2) ──────────────┐ │  Priority: [1___]      │
│               └─▶│ [Extraction] ──▶ [Chunking]         │ │  Enabled:  [ON]        │
│                  └─────────────────────────────────────┘ │                        │
│                              │                           │  ─── Selection Rules ─ │
│                              ▼                           │                        │
│                  ┌─────────────────────┐                 │  Route when:           │
│                  │ OUTPUT              │                 │  • mimeType IN         │
│                  └─────────────────────┘                 │    [application/pdf,   │
│                                                          │     application/vnd.*, │
│                                                          │     text/html,         │
│                                                          │     image/*]           │
│                                                          │  [Edit Rules]          │
│                                                          │                        │
│                                                          │  ─── Stages (3) ─────  │
│                                                          │                        │
│                                                          │  ⠿ 1. Extraction       │
│                                                          │       Docling    [⚙][✕]│
│                                                          │  ⠿ 2. Chunking         │
│                                                          │       Tree Bldr  [⚙][✕]│
│                                                          │  ⠿ 3. Enrichment       │
│                                                          │       LLM Enr.  [⚙][✕]│
│                                                          │                        │
│                                                          │  [+ Add Stage]         │
│                                                          │                        │
│                                                          │  ─── Danger Zone ────  │
│                                                          │  [Delete Flow]         │
│                                                          │                        │
├──────────────────────────────────────────────────────────┴────────────────────────┤
```

- **Drag handles `⠿`** for stage reorder (NOT ▲/▼ arrows)
- **Explicit MIME rules** shown (NOT "catches all unmatched")
- **Delete Flow button visible** in both Default and Custom pipelines
  - Exception: disabled if this is the LAST flow ("Pipeline must have at least 1 flow")
- `⚙` navigates to that stage's config panel; `✕` removes with confirmation
- Edit Rules opens existing RuleBuilderPanel
- Flow lane highlighted on canvas with accent border

---

### Screen 5: Edge-Hover Insert — Adding a Stage

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [Default Pipeline ▾]   [+ Add Flow]   [Version]   [Save Draft]   [Publish]      │
├──────────────────────────────────────────────────────────┬────────────────────────┤
│                                                          │                        │
│  STEP 1: Hover over an edge between two stages           │  (Detail panel stays   │
│                                                          │   in current state)    │
│  ┌─ Rich Documents (P:1) ─────────────────────────────┐ │                        │
│  │                                                     │ │                        │
│  │ [Extraction] ────────(⊕)────────▶ [Chunking]       │ │                        │
│  │  Docling        ◀── hover here     Tree Builder     │ │                        │
│  │                  "+" fades in                        │ │                        │
│  └─────────────────────────────────────────────────────┘ │                        │
│                                                          │                        │
│                                                          │                        │
│  STEP 2: Click "+" — AddStagePopover opens               │                        │
│                                                          │                        │
│  ┌─ Rich Documents (P:1) ─────────────────────────────┐ │                        │
│  │                                                     │ │                        │
│  │ [Extraction] ────┌───────────────┐──▶ [Chunking]   │ │                        │
│  │  Docling         │ Add Stage     │    Tree Builder  │ │                        │
│  │                  │               │                  │ │                        │
│  │                  │ ○ Enrichment  │                  │ │                        │
│  │                  │ ○ Multimodal  │                  │ │                        │
│  │                  │               │                  │ │                        │
│  │                  │ (only valid   │                  │ │                        │
│  │                  │  types shown  │                  │ │                        │
│  │                  │  based on     │                  │ │                        │
│  │                  │  position)    │                  │ │                        │
│  │                  └───────────────┘                  │ │                        │
│  └─────────────────────────────────────────────────────┘ │                        │
│                                                          │                        │
│                                                          │                        │
│  STEP 3: Stage added — auto-selected, panel updates      │                        │
│                                                          │                        │
│  ┌─ Rich Documents (P:1) ─────────────────────────────┐ │  Stage Configuration   │
│  │                                                     │ │  ────────────────────  │
│  │ [Extraction]──▶╔═══════════╗──▶[Chunking]          │ │  Type: ENRICHMENT      │
│  │  Docling       ║Enrichment ║    Tree Builder       │ │  Provider:             │
│  │                ║(pick one) ║                        │ │  ┌────────────────┐    │
│  │                ╚═══════════╝                        │ │  │ Select...    ▾│    │
│  └─────────────────────────────────────────────────────┘ │  └────────────────┘    │
│                                                          │                        │
├──────────────────────────────────────────────────────────┴────────────────────────┤
```

- Edge-hover insertion (Make.com pattern) — "+" appears on hover, not permanent nodes
- AddStagePopover shows only VALID stage types based on position (`stage-insertion-rules.ts`)
- Fixed stage type order enforced: can only insert Enrichment between Chunking and Embedding
- After insertion, new stage auto-selected → detail panel opens with provider dropdown
- Optional stages (enrichment, multimodal) can be added/removed

---

### Screen 6: Add New Flow — Via Toolbar

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [Custom Pipeline ▾]  [+ Add Flow] ◀── click  [Version]  [Save]  [Publish]      │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│                     ┌──────────────────────────────────┐                         │
│                     │                                  │                         │
│                     │  Create New Flow                 │                         │
│                     │  ──────────────────────          │                         │
│                     │                                  │                         │
│                     │  Name:                           │                         │
│                     │  [________________________]      │                         │
│                     │                                  │                         │
│                     │  Description:                    │                         │
│                     │  [________________________]      │                         │
│                     │                                  │                         │
│                     │  Priority: [3___]                │                         │
│                     │  (auto-set to next available)    │                         │
│                     │                                  │                         │
│                     │  Start from:                     │                         │
│                     │  (•) Minimal                     │                         │
│                     │      Extraction + Chunking       │                         │
│                     │  ( ) Copy from existing flow     │                         │
│                     │      ┌─────────────────────┐     │                         │
│                     │      │ Rich Documents    ▾ │     │                         │
│                     │      └─────────────────────┘     │                         │
│                     │  ( ) Empty (no stages)           │                         │
│                     │                                  │                         │
│                     │  [Cancel]        [Create Flow]   │                         │
│                     │                                  │                         │
│                     └──────────────────────────────────┘                         │
│                                                                                  │
│  After creation:                                                                 │
│  ┌─ (existing flows) ─────────────────────────────────┐ ┌────────────────────┐  │
│  │ ...                                                 │ │ Flow Configuration │  │
│  └─────────────────────────────────────────────────────┘ │ ────────────────── │  │
│  ╔═ NEW: My New Flow (P:3) ═══════════════════════════╗ │ Name: [My New Flow]│  │
│  ║ [Extraction] ──▶ [Chunking]                        ║ │ Priority: [3]      │  │
│  ║  (pick provider)  (pick provider)                  ║ │ Rules: [none yet]  │  │
│  ╚════════════════════════════════════════════════════╝  │ [Edit Rules] ◀──── │  │
│  ◀── new lane auto-selected, accent border               │  SET UP RULES!     │  │
│                                                          └────────────────────┘  │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- `+ Add Flow` in toolbar (NOT in a removed FlowsSidebar)
- Works in BOTH Default and Custom pipelines (user can add flows to either)
- Template options: Minimal, Copy from existing, Empty
- Priority auto-set to next available
- Post-creation: new flow lane appears on canvas, auto-selected
- Detail panel immediately shows flow config with "Edit Rules" call-to-action
- Selection rules start empty — user must configure

---

### Screen 7: Version History — Detail Panel Mode

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [Default Pipeline ▾]   [+ Add Flow]   [Version] ◀── click   [Save]  [Publish]  │
├──────────────────────────────────────────────────────────┬────────────────────────┤
│                                                          │                        │
│  (Canvas remains visible, nothing selected)              │  Version History       │
│                                                          │  ────────────────────  │
│  ┌─ Rich Documents (P:1) ─────────────────────────────┐ │                        │
│  │ [Extraction] ──▶ [Chunking] ──▶ [Enrichment]       │ │  v3 — Active           │
│  │  Docling          Tree Builder   LLM Enrichment     │ │  Published: Apr 14     │
│  └─────────────────────────────────────────────────────┘ │  Flows: 2              │
│                                                          │  Stages: 5             │
│  ┌─ Text Documents (P:2) ─────────────────────────────┐ │  [View JSON]           │
│  │ [Extraction] ──▶ [Chunking]                         │ │                        │
│  │  LlamaIndex       Recursive Char                    │ │  v2                    │
│  └─────────────────────────────────────────────────────┘ │  (snapshot not stored) │
│                                                          │  [Not available]       │
│                              │                           │                        │
│                              ▼                           │  v1                    │
│                  ┌─────────────────────┐                 │  (snapshot not stored) │
│                  │ OUTPUT              │                 │  [Not available]       │
│                  └─────────────────────┘                 │                        │
│                                                          │  ─── Actions ────────  │
│                                                          │                        │
│                                                          │  [Export as JSON]      │
│                                                          │  [Import JSON]         │
│                                                          │                        │
│                                                          │  Version snapshots     │
│                                                          │  will be available in  │
│                                                          │  a future update.      │
│                                                          │  Export regularly.     │
│                                                          │                        │
├──────────────────────────────────────────────────────────┴────────────────────────┤
```

- Backend doesn't store version history (Phase 1) — shown honestly
- Current version info displayed (number, date, flow/stage count)
- JSON export/import available NOW (no backend changes needed)
- View JSON shows formatted current config
- No mock data, no disabled buttons with fake versions

---

### Screen 8: Shared Embedding — Click Locked Output Node

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [Default Pipeline ▾]   [+ Add Flow]   [Version]   [Save Draft]   [Publish]      │
├──────────────────────────────────────────────────────────┬────────────────────────┤
│                                                          │                        │
│  (flow lanes above)                                      │  Shared Configuration  │
│                              │                           │  ────────────────────  │
│                              ▼                           │                        │
│                  ┌─────────────────────┐                 │  EMBEDDING             │
│                  │ OUTPUT              │                 │  ──────────            │
│                  │  ╔═══════════════╗  │                 │                        │
│                  │  ║Embedding:     ║  │                 │  Provider: BGE-M3      │
│                  │  ║ BGE-M3       ║◀── selected         │  Model: BAAI/bge-m3    │
│                  │  ╚═══════════════╝  │                 │  Dimensions: 1024      │
│                  │  OpenSearch   [ok]  │                 │  Max Tokens: 8192      │
│                  └─────────────────────┘                 │                        │
│                                                          │  Status: ● Connected   │
│                                                          │  Endpoint: localhost:   │
│                                                          │           8000         │
│                                                          │                        │
│                                                          │  ─── Scope ──────────  │
│                                                          │                        │
│                                                          │  This embedding config │
│                                                          │  is shared across ALL  │
│                                                          │  flows in this         │
│                                                          │  pipeline.             │
│                                                          │                        │
│                                                          │  Changing the model    │
│                                                          │  requires reindexing   │
│                                                          │  all documents.        │
│                                                          │                        │
│                                                          │  Configure via KB      │
│                                                          │  Settings > Embedding. │
│                                                          │                        │
├──────────────────────────────────────────────────────────┴────────────────────────┤
```

- Embedding config is shared at pipeline level (`activeEmbeddingConfig`)
- Read-only display — not editable from pipeline editor
- Points user to KB Settings for embedding changes
- Shows reindex warning
- No mock checkboxes for embedding fields (backend doesn't exist yet — Phase 1)

---

### Screen 9: Right-Click Context Menu on Stage

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [Default Pipeline ▾]   [+ Add Flow]   [Version]   [Save Draft]   [Publish]      │
├──────────────────────────────────────────────────────────┬────────────────────────┤
│                                                          │                        │
│  ┌─ Rich Documents (P:1) ─────────────────────────────┐ │  (panel stays in       │
│  │                                                     │ │   current state)       │
│  │ [Extraction] ──▶ [Chunking] ──▶ [Enrichment]       │ │                        │
│  │  Docling          Tree Bldr     LLM Enrichment     │ │                        │
│  │                      ▲                              │ │                        │
│  └──────────────────────│──────────────────────────────┘ │                        │
│                         │                                │                        │
│                    right-click                            │                        │
│                         │                                │                        │
│                  ┌──────┴──────────────┐                 │                        │
│                  │ ⚙  Configure        │                 │                        │
│                  │ ────────────────── │                 │                        │
│                  │ ←  Move Left       │                 │                        │
│                  │ →  Move Right      │                 │                        │
│                  │ ────────────────── │                 │                        │
│                  │ ⧉  Duplicate       │                 │                        │
│                  │ ────────────────── │                 │                        │
│                  │ ✕  Remove    ⌫     │                 │                        │
│                  └────────────────────┘                  │                        │
│                                                          │                        │
│  Actions:                                                │                        │
│  • Configure → opens stage config in detail panel        │                        │
│  • Move Left/Right → reorder within flow                 │                        │
│  • Duplicate → copies stage with same provider/config    │                        │
│  • Remove → confirmation dialog, then removes            │                        │
│                                                          │                        │
│  Disabled states:                                        │                        │
│  • Move Left disabled on first stage                     │                        │
│  • Move Right disabled on last stage                     │                        │
│  • Remove disabled on required stages (Extraction)       │                        │
│                                                          │                        │
├──────────────────────────────────────────────────────────┴────────────────────────┤
```

- Context menu provides secondary access to all stage operations
- Primary path is still the detail panel (drag handles + buttons)
- Move respects fixed stage type ordering
- Remove has confirmation; Extraction stage cannot be removed (required)

---

### Screen 10: Execution Fallthrough — Custom → Default

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                                                                  │
│  HOW DOCUMENT ROUTING WORKS                                                      │
│  ═════════════════════════                                                       │
│                                                                                  │
│                    Document Arrives                                               │
│                         │                                                        │
│                         ▼                                                        │
│              ┌─────────────────────┐                                             │
│              │ Custom Pipeline     │                                             │
│              │ exists?             │                                             │
│              └─────────┬──────────┘                                              │
│                   YES  │   NO                                                    │
│            ┌───────────┴──────────────┐                                          │
│            ▼                          ▼                                           │
│  ┌──────────────────┐      ┌──────────────────────┐                              │
│  │ CUSTOM PIPELINE  │      │ DEFAULT PIPELINE      │                              │
│  │ ──────────────── │      │ ──────────────────── │                              │
│  │ Router evaluates │      │ Router evaluates      │                              │
│  │ flows by priority│      │ flows by priority     │                              │
│  │ (highest first)  │      │ (highest first)       │                              │
│  └────────┬─────────┘      │                       │                              │
│           │                │  Rich Docs (P:1)      │                              │
│      ┌────┴────┐           │  PDF,DOCX,HTML,img    │                              │
│      │         │           │  → Docling extraction  │                              │
│   MATCH    NO MATCH        │                       │                              │
│      │         │           │  Text Docs (P:2)      │                              │
│      ▼         │           │  text/plain, markdown │                              │
│   Process      │           │  → LlamaIndex extract  │                              │
│   via that     │           │                       │                              │
│   flow         └──────────▶│  (provider-based flows │                              │
│   ✅ DONE       FALL        │   cover all MIME types │                              │
│                 THROUGH     │   — nothing dropped)  │                              │
│                             └──────────────────────┘                              │
│                                        │                                         │
│                                        ▼                                         │
│                              ┌──────────────────┐                                │
│                              │ Shared Output     │                                │
│                              │ Embedding → OS    │                                │
│                              └──────────────────┘                                │
│                                        │                                         │
│                                        ▼                                         │
│                             Every document processed.                            │
│                             Nothing dropped.                                     │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- Custom pipeline evaluated FIRST
- Fallthrough to Default on no match
- Default Pipeline has provider-based flows (NOT a catch-all)
- Two flows cover all MIME types — nothing dropped
- Every document guaranteed to be processed

---

### Screen 11: Custom Pipeline View

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ TOOLBAR                                                                          │
│ [My Custom Pipeline ▾]  [+ Add Flow]  [Version]  [Save Draft]  [Publish]        │
│                                                     [Delete Pipeline]            │
├──────────────────────────────────────────────────────────┬────────────────────────┤
│                                                          │                        │
│  CANVAS                                                  │  DETAIL PANEL (420px)  │
│                                                          │                        │
│  ┌─────────┐                                             │                        │
│  │ INGRESS │                                             │   Select a stage       │
│  │ Docs    │                                             │   or flow to           │
│  │ Router  │──┐                                          │   configure            │
│  │ 3 flows │  │                                          │                        │
│  └─────────┘  │                                          │                        │
│               │  ┌─ Invoice Processing (P:1) ──────────┐ │                        │
│               ├─▶│ [Extraction] ──▶ [Chunking] ──▶ [E] │ │                        │
│               │  │  Docling        Tree Builder   LLM  │ │                        │
│               │  └─────────────────────────────────────┘ │                        │
│               │                                          │                        │
│               │  ┌─ Email Archives (P:2) ──────────────┐ │                        │
│               ├─▶│ [Extraction] ──▶ [Chunking]         │ │                        │
│               │  │  LlamaIndex      Recursive Char     │ │                        │
│               │  └─────────────────────────────────────┘ │                        │
│               │                                          │                        │
│               │  ┌─ Spreadsheets (P:3) ────────────────┐ │                        │
│               └─▶│ [Extraction] ──▶ [Chunking]         │ │                        │
│                  │  Structured      JSON Chunking       │ │                        │
│                  └─────────────────────────────────────┘ │                        │
│                              │                           │                        │
│                              ▼                           │                        │
│                  ┌─────────────────────┐                 │                        │
│                  │ OUTPUT              │                 │                        │
│                  │  Embedding: BGE-M3  │                 │                        │
│                  │  OpenSearch   [ok]  │                 │                        │
│                  └─────────────────────┘                 │                        │
│                                                          │                        │
│  ℹ Documents not matching any flow above will fall       │                        │
│    through to the Default Pipeline.                      │                        │
│                                                          │                        │
├──────────────────────────────────────────────────────────┴────────────────────────┤
```

- Custom Pipeline toolbar shows `[Delete Pipeline]` (allowed for custom, not for default)
- Multiple user-defined flows with selection rules
- Fallthrough notice at bottom of canvas
- Same structure: Router → per-flow stages → shared Output
- Full control: add/edit/delete flows, change providers, configure stages

---

### Screen 12: Create Custom Pipeline — Modal

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [Default Pipeline ▾]   [+ Add Flow]   [Version]   [Save Draft]   [Publish]      │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  (User opens PipelineSelector, clicks "Create Custom Pipeline")                  │
│                                                                                  │
│                     ┌──────────────────────────────────┐                         │
│                     │                                  │                         │
│                     │  Create Custom Pipeline          │                         │
│                     │  ──────────────────────          │                         │
│                     │                                  │                         │
│                     │  Name:                           │                         │
│                     │  [________________________]      │                         │
│                     │                                  │                         │
│                     │  Description:                    │                         │
│                     │  [________________________]      │                         │
│                     │                                  │                         │
│                     │  The custom pipeline is           │                         │
│                     │  evaluated FIRST. Documents      │                         │
│                     │  that don't match any flow       │                         │
│                     │  will fall through to the        │                         │
│                     │  Default Pipeline.               │                         │
│                     │                                  │                         │
│                     │  Start with:                     │                         │
│                     │  (•) Copy Default Pipeline       │                         │
│                     │      (2 flows, same config)      │                         │
│                     │  ( ) Single empty flow           │                         │
│                     │                                  │                         │
│                     │  [Cancel]   [Create Pipeline]    │                         │
│                     │                                  │                         │
│                     └──────────────────────────────────┘                         │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- Only ONE custom pipeline per KB (backend enforces via 409)
- Create button disabled in PipelineSelector when custom already exists
- Explains fallthrough behavior upfront
- Template: copy from Default Pipeline or start with single empty flow

---

## Screen Index

| #   | Screen                   | Interaction              | Detail Panel Content          |
| --- | ------------------------ | ------------------------ | ----------------------------- |
| 1   | Default Pipeline Landing | Page load                | Empty state                   |
| 2   | Pipeline Selector        | Click dropdown           | — (overlay)                   |
| 3   | Stage Config             | Click stage node         | Provider + settings           |
| 4   | Flow Config              | Click flow lane header   | Name, priority, rules, stages |
| 5   | Edge-Hover Insert        | Hover edge → click "+"   | Stage config (after add)      |
| 6   | Add New Flow             | Toolbar "+" button       | Flow config (after create)    |
| 7   | Version History          | Toolbar "Version" button | Version info + export/import  |
| 8   | Shared Embedding         | Click output node        | Read-only embedding info      |
| 9   | Context Menu             | Right-click stage        | — (overlay menu)              |
| 10  | Execution Fallthrough    | Conceptual diagram       | —                             |
| 11  | Custom Pipeline          | Switch via selector      | Empty state                   |
| 12  | Create Pipeline          | Selector "Create"        | — (modal)                     |

---

## Implementation Phases

| Phase                                 | Scope                                                                      | Impact                                        |
| ------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------- |
| **Phase 1: Layout**                   | Compound nodes, remove InsertPoints, reduce spacing                        | Fixes problems 1, 2, 3 — graph 2380px → 840px |
| **Phase 2: Detail Panel + Flow CRUD** | Persistent panel, stage config, flow config, add/delete flow, drag reorder | Restores all V1 features + better UX          |
| **Phase 3: Edge-Hover Insert**        | Custom PipelineEdge, hover-to-insert, AddStagePopover                      | Completes insert point replacement            |
| **Phase 4: Visual Polish**            | Level-of-detail, flow lane headers, responsive, context menu, JSON export  | Refinement                                    |

---

## Code Gaps to Fix (Before or During Implementation)

| #   | File                           | Issue                               | Fix                                             |
| --- | ------------------------------ | ----------------------------------- | ----------------------------------------------- |
| 1   | `default-pipeline-template.ts` | Creates ONE catch-all flow          | Create TWO provider-based flows with MIME rules |
| 2   | `PipelineSelector.tsx`         | Shows Default Pipeline as read-only | Make Default Pipeline fully editable            |
| 3   | `05-SYSTEM-DEFAULT-FLOW.md`    | Describes catch-all model           | Update to two-provider-flow model               |
| 4   | `document-routing.ts`          | Hardcoded MIME routing              | Being replaced by pipeline-driven routing       |
| 5   | `FlowsSidebar.tsx`             | Exists as separate component        | Remove — canvas swim lanes replace it           |
