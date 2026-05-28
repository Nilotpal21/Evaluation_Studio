# KB UX Enhancement — Complete Wireframes (Post All Fixes)

**Date**: 2026-03-20
**Status**: Draft — For review
**Context**: Shows the complete KB experience after all gap fixes (G1–G10, G13, G14, G15, G17, G25, G26) are applied. Every screen the user encounters is documented below.

---

## Screen Map

```
Knowledge Bases List
  └─ KB Detail (4 tabs)
       ├─ HOME
       │    ├─ State 1: Setup Guide (new KB)
       │    ├─ State 2: Progress View (indexing/error)
       │    └─ State 3: Operations Dashboard (mature)
       │
       ├─ DATA (3-way SegmentedControl)
       │    ├─ Sub-view: Documents (default)
       │    ├─ Sub-view: Chunks (G14 — new "All Chunks" view)
       │    │    └─ Dialog: ChunkExplorerDialog (chunk row click)
       │    ├─ Sub-view: Sources (G15 — "Sources Configuration" view)
       │    │    ├─ Overlay: SourceDetailPanel (non-enterprise row click)
       │    │    └─ Overlay: ConnectorDetailPanel (enterprise row click)
       │    ├─ Overlay: CrawledPageViewer (doc row click)
       │    │    └─ Dialog: ChunkExplorerDialog (button)
       │    ├─ Dialog: FileUploadDialog
       │    └─ Dialog: AddSourceDialog
       │
       ├─ INTELLIGENCE
       │    ├─ Hub (overview grid)
       │    ├─ /pipeline → PipelineEditor
       │    ├─ /fields → FieldsTab
       │    ├─ /vocabulary → VocabularyTab
       │    ├─ /knowledge-graph → KnowledgeGraphTab
       │    └─ /llm-models → SettingsTab (LLM config)
       │
       ├─ SEARCH & TEST
       │    ├─ Zone 1: Playground (2/3) + Diagnostics (1/3)
       │    ├─ Zone 2: Debug — Resolution Chain + Stage Details
       │    └─ Zone 3: Query History (1/2) + Compare (1/2)
       │
       └─ SETTINGS (gear icon → SlidePanel)
            ├─ General (name, description)
            ├─ Index Configuration (read-only)
            └─ Danger Zone (rebuild, delete)
```

---

## 1. Persistent Header (All Tabs)

Visible on every tab. Metrics are clickable (G1 fix).

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  ←   engineering      0 Documents  ·  0 Chunks  ·  2 Sources    ● Active  ⚙ │
│                       ~~~~~~~~~~~     ~~~~~~~~     ~~~~~~~~~                  │
│                       hover:underline + cursor:pointer on each metric        │
│                                                                              │
│   ⌂ Home        ⊟ Data        ◎ Intelligence        ⌕ Search & Test         │
│   ──────                                                                     │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

Click targets:
  "0 Documents"  → Data tab, Documents sub-view
  "0 Chunks"     → Data tab, Documents sub-view
  "2 Sources"    → Data tab, Sources sub-view
  ⚙ (gear)       → Settings slide-over
  ←              → KB list page
```

---

## 2. HOME — State 1: Setup Guide (0 sources, 0 documents)

No changes from current. SetupGuide action links already work correctly.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Header — all metrics zero]                                                 │
│   ⌂ Home        ⊟ Data        ◎ Intelligence        ⌕ Search & Test         │
│   ──────                                                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Get started with "engineering"                                              │
│  Follow these steps to set up your knowledge base.                           │
│                                                                              │
│  ┌─ Setup checklist ────────────────────────────────────────────────────┐    │
│  │                                                                      │    │
│  │  ○  Add a data source                                                │    │
│  │     Connect files, web pages, or enterprise connectors.              │    │
│  │     [Go to Data →]                                                   │    │
│  │                                                                      │    │
│  │  ○  Configure pipeline                                               │    │
│  │     Set up chunking, enrichment, and embedding.                      │    │
│  │     [Go to Pipeline →]                                               │    │
│  │                                                                      │    │
│  │  ○  Run your first search                                            │    │
│  │     Test queries against your indexed content.                       │    │
│  │     [Go to Search & Test →]                                          │    │
│  │                                                                      │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. HOME — State 2: Progress View (G5 fix — action links added)

**Before (current):** Progress bar only, no action links. Dead-end during indexing and error states.
**After:** Action links below progress. Error state shows contextual guidance.

```
INDEXING STATE:
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Header — "8 of 23 docs indexed"]                                           │
│   ⌂ Home        ⊟ Data        ◎ Intelligence        ⌕ Search & Test         │
│   ──────                                                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Processing documents...                                                     │
│  ████████████████░░░░░░░░░░░░░░░ 35%                                        │
│  8 of 23 documents  ·  124 chunks created                                    │
│                                                                              │
│  This page updates automatically.                                            │
│                                                                              │
│  [Try a search →]    [View documents →]    [Review field mappings →]         │
│       ↓                    ↓                       ↓                         │
│   Search & Test tab    Data tab          Intelligence > Fields               │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘


ERROR STATE:
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Header]                                                                    │
│   ⌂ Home        ⊟ Data        ◎ Intelligence        ⌕ Search & Test         │
│   ──────                                                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ⚠ Indexing error                                                            │
│  ┌─ Error ──────────────────────────────────────────────────────────────┐    │
│  │  "Embedding model not configured — cannot process documents."        │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  [Configure LLM Models →]         [View failed documents →]                  │
│       ↓                                  ↓                                   │
│   Intelligence > LLM Models        Data tab, status=error filter             │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. HOME — State 3: Operations Dashboard (G2, G3, G4, G8 fixes)

**Changes from current:**

- Stat cards are clickable (G2) — Documents/Chunks → Data, Sources → Data sources view
- NeedsAttention "View" links carry filter context (G8)
- ActivityFeed "View" buttons hidden for null targets (G3), navigate to sub-sections (G4)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Header — full metrics, all clickable]                                      │
│   ⌂ Home        ⊟ Data        ◎ Intelligence        ⌕ Search & Test         │
│   ──────                                                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌────────────┐│
│  │ 📄 Documents     │ │ 📑 Chunks       │ │ 🗄 Sources      │ │ 🕐 Last    ││
│  │    1,234         │ │    45,600       │ │    3            │ │  Indexed   ││
│  │    cursor:ptr    │ │    cursor:ptr   │ │    cursor:ptr   │ │  5m ago    ││
│  │ → Data/Documents │ │ → Data/Documents│ │ → Data/Sources  │ │ (no click) ││
│  └─────────────────┘ └─────────────────┘ └─────────────────┘ └────────────┘│
│                                                                              │
│  ┌─ Needs Attention (2) ────────────────────────────────────────────────┐   │
│  │                                                                      │   │
│  │  🔴 1 document with errors            [View errored docs →]          │   │
│  │                                        → Data tab + status="error"   │   │
│  │                                                                      │   │
│  │  🔴 SharePoint "Corp Docs" — auth expired  [View source →]          │   │
│  │     Last synced 3 days ago.                 → Data/Sources + opens   │   │
│  │                                               ConnectorDetailPanel   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌─ Recent Activity ────────────────────┐ ┌─ Document Status ──────────┐   │
│  │                                      │ │                            │   │
│  │  5m ago  Crawler synced 45 pages     │ │  Indexed       1,200      │   │
│  │          [View in Data →]            │ │  Processing       12      │   │
│  │                                      │ │  Error            22      │   │
│  │  12m ago Pipeline v3 published       │ │                            │   │
│  │          [View Pipeline →]           │ │                            │   │
│  │          → Intelligence > Pipeline   │ │                            │   │
│  │                                      │ │                            │   │
│  │  1h ago  Vocabulary: 6 terms updated │ │                            │   │
│  │          [View Vocabulary →]         │ │                            │   │
│  │          → Intelligence > Vocabulary │ │                            │   │
│  │                                      │ │                            │   │
│  │  3h ago  Index rebuild completed     │ │                            │   │
│  │          (no button — G3 fix)        │ │                            │   │
│  │                                      │ │                            │   │
│  │  [Load more]                         │ │                            │   │
│  └──────────────────────────────────────┘ └────────────────────────────┘   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. DATA — Documents Sub-View (default)

**Change from current:** 3-way SegmentedControl added (G6/G14/G15) to switch between Documents, Chunks, and Sources.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Header]                                                                    │
│   ⌂ Home        ⊟ Data        ◎ Intelligence        ⌕ Search & Test         │
│                  ──────                                                       │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  [● Documents | Chunks | Sources]                            [+ Add Source]  │
│   SegmentedControl (3-way)                                                   │
│                                                                              │
│  [All (5)] [manual (2)] [sharepoint (1)] [web (2)]        [📤 Upload Files] │
│                                                                              │
│  [🔍 Search documents...]                                                    │
│                                                                              │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐        │
│  │ ☐        │ Title    │ Source   │ Status   │ Created  │ Size     │        │
│  ├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤        │
│  │ ☐        │ Q1 Report│ manual   │ ● Indexed│ Mar 8    │ 2.4 MB   │ ←click│
│  │ ☐        │ FAQ Page │ web      │ ● Indexed│ Mar 7    │ 156 KB   │  opens│
│  │ ☐        │ API Spec │ manual   │ 🟡 8/12  │ Mar 9    │ 890 KB   │ viewer│
│  │ ☐        │ Data Dict│ manual   │ 🔴 Failed│ Mar 9    │ 1.1 MB   │        │
│  │ ☐        │ Onboard  │ spoint   │ 🔄 Proc  │ Mar 10   │ 3.2 MB   │        │
│  └──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘        │
│                                                                              │
│  Showing 1–5 of 5                                          [< 1 >]          │
│                                                                              │
│  ┌─ Bulk Actions (shown when checkboxes selected) ─────────────────────┐    │
│  │  3 selected                          [↻ Reprocess]  [🗑 Delete]     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 5b. DATA — All Chunks Sub-View (G14 — new)

Clicking "Chunks" in the SegmentedControl shows all chunks across all documents for this KB. This is a new view that requires a **new backend endpoint** (`GET /api/indexes/:indexId/chunks`) since the current chunk API is document-scoped only.

**Why this view matters:** Users need to inspect chunk quality across the entire KB — find poorly tokenized chunks, spot embedding failures, verify chunk sizes are reasonable, and debug pipeline issues. Currently the only way to see chunks is one document at a time via CrawledPageViewer.

**Backend dependency:** New route `GET /api/indexes/:indexId/chunks` with params: `status`, `sourceId`, `documentId`, `search`, `minTokens`, `maxTokens`, `limit`, `offset`, `sort`. The existing DB index `{indexId, status}` supports this. Response must include `documentId` and `documentTitle` (via `$lookup` or separate resolution).

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Header — "45,600 Chunks" metric is clickable → lands here]                 │
│   ⌂ Home        ⊟ Data        ◎ Intelligence        ⌕ Search & Test         │
│                  ──────                                                       │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  [Documents | ● Chunks | Sources]                            [+ Add Source]  │
│                                                                              │
│  ┌─ Chunk Stats ─────────────────────────────────────────────────────────┐  │
│  │  Total: 45,600  │  Indexed: 44,200  │  Pending: 1,100  │             │  │
│  │                    Embedded: 200     │  Error: 80       │             │  │
│  │                    Filtered: 20      │                  │             │  │
│  │  Avg Tokens: 228  │  Min: 12  │  Max: 512                            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌─ Filters ─────────────────────────────────────────────────────────────┐  │
│  │                                                                       │  │
│  │  Status:  [All ▾]     Source:  [All ▾]     Document:  [All ▾]        │  │
│  │                                                                       │  │
│  │  Tokens:  [min ___] – [max ___]            [🔍 Search chunk content] │  │
│  │                                                                       │  │
│  │  Active filters: status=error  ×           [Clear all]               │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌──────┬──────────────────────┬──────────────┬────────┬───────┬─────────┐ │
│  │  #   │ Content Preview      │ Document     │ Source │ Status│ Tokens  │ │
│  ├──────┼──────────────────────┼──────────────┼────────┼───────┼─────────┤ │
│  │  #1  │ "Executive Summary:  │ Q1 Report    │ Corp   │●Index │  245    │ │
│  │      │  Q1 revenue incre..."│              │ Docs   │  ed   │         │ │
│  ├──────┼──────────────────────┼──────────────┼────────┼───────┼─────────┤ │
│  │  #2  │ "Revenue Breakdown   │ Q1 Report    │ Corp   │●Index │  198    │ │
│  │      │  by Region: North..."│              │ Docs   │  ed   │         │ │
│  ├──────┼──────────────────────┼──────────────┼────────┼───────┼─────────┤ │
│  │ #14  │ "Appendix B: Detail  │ Q1 Report    │ Corp   │🔴Error│  312    │ │
│  │      │  Financial Proje..." │              │ Docs   │       │         │ │
│  ├──────┼──────────────────────┼──────────────┼────────┼───────┼─────────┤ │
│  │  #1  │ "Product Overview:   │ Catalog.pdf  │Product │●Index │  189    │ │
│  │      │  Our platform off..."│              │ PDFs   │  ed   │         │ │
│  ├──────┼──────────────────────┼──────────────┼────────┼───────┼─────────┤ │
│  │  #3  │ "API authentication  │ API Spec     │Product │●Embed │  267    │ │
│  │      │  uses Bearer tok..." │              │ PDFs   │  ded  │         │ │
│  └──────┴──────────────────────┴──────────────┴────────┴───────┴─────────┘ │
│                                                                              │
│  Showing 1–20 of 45,600                    [< 1  2  3  ...  2280 >]        │
│                                                                              │
│  Click targets:                                                              │
│    Row click → opens ChunkExplorerDialog for that chunk's document,          │
│                scrolled/highlighted to the clicked chunk                      │
│    "Document" column link → opens CrawledPageViewer for that document        │
│    "Source" column link → switches to Sources view, opens detail panel        │
│    Status badge → filters table to that status                               │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

SORT OPTIONS (column header click):
  # (chunk index)  — default asc
  Tokens           — asc/desc (find outliers)
  Status           — group by status
  Document         — group by document
  Created          — newest/oldest

FILTER INTERACTIONS:
  Status dropdown:  Multi-select checkboxes for each ChunkStatus value
                    (pending, embedded, indexed, filtered, error)
  Source dropdown:   Lists all sources by name, single-select
  Document dropdown: Typeahead search across document titles, single-select
  Token range:       Min/max number inputs, applied on blur/Enter
  Search:            Full-text search within chunk content (debounced 300ms)
  Active filters:    Chip badges with × to remove, "Clear all" resets

EMPTY STATE (0 chunks):
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Documents | ● Chunks | Sources]                            [+ Add Source]  │
│                                                                              │
│              No chunks yet                                                   │
│                                                                              │
│     Chunks are created when documents are processed through the pipeline.    │
│     Add documents and run the pipeline to see chunks here.                   │
│                                                                              │
│     [Go to Documents →]        [Configure Pipeline →]                        │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

FILTERED EMPTY STATE (filters active but 0 results):
┌──────────────────────────────────────────────────────────────────────────────┐
│  Active filters: status=error ×                      [Clear all]             │
│                                                                              │
│              No chunks match the current filters.                            │
│              [Clear all filters]                                             │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. DATA — Sources Configuration Sub-View (G6/G15 — restored + enhanced)

Clicking "Sources" in the SegmentedControl shows the full sources configuration and management view. This restores the capability lost when ConnectorsTab was orphaned during the 4-nav layout redesign, with enhancements: health summary cards, unified table for all source types, and inline status indicators.

**Why this was lost:** The original ConnectorsTab.tsx (646 lines) provided a full sources management table with detail panels. When the KB detail page was redesigned to use 4 top-level tabs (Home, Data, Intelligence, Search & Test), ConnectorsTab was not wired into the new layout. The Data tab only got a `SourceFilterBar` (horizontal badges for filtering documents) but no actual source management.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Header — "2 Sources" metric is clickable → lands here]                     │
│   ⌂ Home        ⊟ Data        ◎ Intelligence        ⌕ Search & Test         │
│                  ──────                                                       │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  [Documents | Chunks | ● Sources]                            [+ Add Source]  │
│                                                                              │
│  ┌─ Source Health ────────────────────────────────────────────────────────┐  │
│  │                                                                       │  │
│  │  Total: 4 sources  │  Active: 2  │  Syncing: 1  │  Error: 1          │  │
│  │  Documents: 1,234  │  Last activity: 2m ago                           │  │
│  │                                                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌──────────────┬──────────┬──────────┬──────┬───────────┬─────────────────┐│
│  │ Name         │ Type     │ Status   │ Docs │ Last Sync │ Actions         ││
│  ├──────────────┼──────────┼──────────┼──────┼───────────┼─────────────────┤│
│  │ Corp Docs    │🏢 Share- │ ● Active │  23  │ 2m ago    │ [⟳] [📄] [⋮]  ││
│  │              │  Point   │  ✅ Auth │ link │           │                 ││
│  ├──────────────┼──────────┼──────────┼──────┼───────────┼─────────────────┤│
│  │ Product PDFs │📤 File   │ ● Active │   5  │    —      │ [📤] [📄] [⋮]  ││
│  │              │  Upload  │          │ link │           │                 ││
│  ├──────────────┼──────────┼──────────┼──────┼───────────┼─────────────────┤│
│  │ Inventory DB │🗄 Data-  │ ● Active │ 340  │ 1h ago    │ [⟳] [📄] [⋮]  ││
│  │              │  base    │          │ link │           │                 ││
│  ├──────────────┼──────────┼──────────┼──────┼───────────┼─────────────────┤│
│  │ Docs Site    │🌐 Web    │ 🔴 Error │ 145  │ 3d ago    │ [⟳] [📄] [⋮]  ││
│  │              │          │ ⚠ Auth   │ link │           │                 ││
│  │              │          │  expired │      │           │                 ││
│  └──────────────┴──────────┴──────────┴──────┴───────────┴─────────────────┘│
│                                                                              │
│  Action icons:                                                               │
│    [⟳]  Trigger Sync (non-manual types only)                                │
│    [📤] Upload Files (manual/file types only)                                │
│    [📄] View Documents → switches to Documents view, filtered by source      │
│    [⋮]  More menu: Edit Config, View Chunks, Delete                          │
│                                                                              │
│  Click targets:                                                              │
│    Row click → opens detail panel (see Screens 7 & 8)                        │
│    "Docs" link → Documents sub-view, filtered to that source                 │
│    "View Chunks" in ⋮ menu → Chunks sub-view, filtered to that source        │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

TYPE BADGES (icon + label, colored by category):
  📤 File Upload   — neutral (gray)
  🌐 Web           — blue
  🗄 Database      — purple
  🔌 API           — orange
  🏢 SharePoint    — teal (enterprise badge)
  🏢 Jira          — teal (enterprise badge)
  🏢 Confluence    — teal (enterprise badge)

STATUS INDICATORS (inline, below main status):
  ● Active                    — green dot
  ● Syncing (45%)             — blue dot + progress text
  🔴 Error                    — red dot
  ⏸ Paused                    — yellow dot
  ✅ Auth OK                  — shown for enterprise connectors with valid auth
  ⚠ Auth expired              — shown for enterprise connectors with expired auth
  ⚠ {consecutiveFailures}     — shown when errorState.consecutiveFailures > 0
     consecutive failures

EMPTY STATE (0 sources):
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Documents | Chunks | ● Sources]                            [+ Add Source]  │
│                                                                              │
│              No sources configured                                           │
│                                                                              │
│     Sources define where your knowledge base content comes from.             │
│     Add a source to start ingesting documents.                               │
│                                                                              │
│     [+ Add Source]                                                            │
│                                                                              │
│     Supported types:                                                         │
│     📤 File Upload    🗄 Database    🔌 API    🏢 SharePoint                 │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. DATA — Source Detail Panel: Enterprise Connector (existing ConnectorDetailPanel)

Opens as SlidePanel when clicking a SharePoint (or other enterprise) source row.
This component already exists at 764 lines. No changes needed.

```
┌─ Corp Docs (SharePoint) ───────────────────────────────── [×] ──┐
│                                                                   │
│  Type: SharePoint  │  Status: ● Active                            │
│                                                                   │
│  ▼ Connection ─────────────────────────────────────────────────── │
│    Auth: ✅ Authenticated                                         │
│    Client ID: a3f8c2e1-...                                        │
│    Tenant URL: https://contoso.sharepoint.com                     │
│    [Edit]  [Re-authenticate]                                      │
│                                                                   │
│  ▼ Sync ───────────────────────────────────────────────────────── │
│    Status: ● Synced                                               │
│    Total: 23  │  Processed: 23  │  Failed: 0                     │
│    Last full sync: Mar 20, 14:23                                  │
│    [Start Sync]  [Pause]                                          │
│                                                                   │
│  ▶ Filters ────────────────────────────────────────────────────── │
│  ▶ Permissions ────────────────────────────────────────────────── │
│  ▶ Errors ─────────────────────────────────────────────────────── │
│  ▶ Metadata ───────────────────────────────────────────────────── │
│                                                                   │
│  ─────────────────────────────────────────────────────────────── │
│  [View Documents →]                                               │
│   → switches to Documents sub-view, filtered to this source       │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## 8. DATA — Source Detail Panel: Non-Enterprise (G10 fix — new)

Opens as SlidePanel when clicking a Manual/Web/Database/API source row.
Simpler than ConnectorDetailPanel — no OAuth, no discovery, no filters.

```
┌─ Product PDFs ──────────────────────────────────────────── [×] ──┐
│                                                                    │
│  Type: File Upload  │  Status: ● Active                            │
│  Created: Mar 8, 2026                                              │
│                                                                    │
│  ─── Overview ──────────────────────────────────────────────────── │
│                                                                    │
│    Documents:    5                                                  │
│    Total Size:   12.4 MB                                           │
│    Last Upload:  Mar 15, 2026                                      │
│                                                                    │
│  ─── Configuration ─────────────────────────────────────────────── │
│                                                                    │
│    Accepted Types:  pdf, docx, txt                                 │
│    Max File Size:   50 MB                                          │
│                                                                    │
│  ─── Actions ───────────────────────────────────────────────────── │
│                                                                    │
│    [📄 Upload Files]          Opens FileUploadDialog               │
│    [View Documents →]         Switches to Documents, filtered      │
│                                                                    │
│  ─── Danger Zone ─────────────────────────────── border-error/30 ─ │
│                                                                    │
│    [🗑 Delete Source]                                               │
│    Removes this source and all 5 of its documents.                 │
│    This cannot be undone.                                          │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘


VARIANT: Web Source
┌─ Docs Site ─────────────────────────────────────────────── [×] ──┐
│                                                                    │
│  Type: Web Crawler  │  Status: 🔴 Error                           │
│  Created: Mar 10, 2026                                             │
│                                                                    │
│  ─── Overview ──────────────────────────────────────────────────── │
│                                                                    │
│    Documents:     145                                              │
│    Last Sync:     3 days ago                                       │
│    Sync Error:    "Connection timeout after 30s"                   │
│                                                                    │
│  ─── Configuration ─────────────────────────────────────────────── │
│                                                                    │
│    URL:              https://docs.example.com                      │
│    Crawl Depth:      2                                             │
│    Include Patterns: /docs/*, /api/*                               │
│    Exclude Patterns: /blog/*                                       │
│    [Edit Configuration]                                            │
│                                                                    │
│  ─── Actions ───────────────────────────────────────────────────── │
│                                                                    │
│    [🔄 Trigger Sync]         [View Documents →]                    │
│                                                                    │
│  ─── Danger Zone ─────────────────────────────── border-error/30 ─ │
│                                                                    │
│    [🗑 Delete Source]                                               │
│    Removes this source and all 145 of its documents.               │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘


VARIANT: API Source
┌─ Product API ───────────────────────────────────────────── [×] ──┐
│                                                                    │
│  Type: API Endpoint  │  Status: ● Active                           │
│  Created: Mar 12, 2026                                             │
│                                                                    │
│  ─── Overview ──────────────────────────────────────────────────── │
│                                                                    │
│    Documents:     100                                              │
│    Last Sync:     Mar 19, 14:23                                    │
│    Sync Error:    —                                                │
│                                                                    │
│  ─── Configuration ─────────────────────────────────────────────── │
│                                                                    │
│    URL:     https://api.example.com/data                           │
│    Method:  GET                                                    │
│    Auth:    Bearer Token                                           │
│    [Edit Configuration]                                            │
│                                                                    │
│  ─── Actions ───────────────────────────────────────────────────── │
│                                                                    │
│    [🔄 Trigger Sync]         [View Documents →]                    │
│                                                                    │
│  ─── Danger Zone ─────────────────────────────── border-error/30 ─ │
│                                                                    │
│    [🗑 Delete Source]                                               │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘


VARIANT: Database Source
┌─ Product DB ────────────────────────────────────────────── [×] ──┐
│                                                                    │
│  Type: Database  │  Status: ● Active                               │
│  Created: Mar 14, 2026                                             │
│                                                                    │
│  ─── Overview ──────────────────────────────────────────────────── │
│                                                                    │
│    Documents:     340                                              │
│    Last Sync:     Mar 20, 09:00                                    │
│    Sync Error:    —                                                │
│                                                                    │
│  ─── Configuration ─────────────────────────────────────────────── │
│                                                                    │
│    Connection:   mongodb://...                                     │
│    Collection:   products                                          │
│    Query:        { "status": "published" }                         │
│    [Edit Configuration]                                            │
│                                                                    │
│  ─── Actions ───────────────────────────────────────────────────── │
│                                                                    │
│    [🔄 Trigger Sync]         [View Documents →]                    │
│                                                                    │
│  ─── Danger Zone ─────────────────────────────── border-error/30 ─ │
│                                                                    │
│    [🗑 Delete Source]                                               │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## 9. DATA — Document Viewer (G7 fix — enhanced CrawledPageViewer)

Opens as full-width slide-out when clicking a document row. Enhanced with chunk count in header, chunk status badges, copy button, retry for failed chunks, and "Explore Chunks" button to access the rich ChunkExplorer.

**Backend dependency:** The current `getDocumentDetail` API only returns `_id, content, position, status` per chunk — no `tokenCount`, no `canonicalMetadata`. CrawledPageViewer currently fabricates token counts via `Math.ceil(content.length / 4)`. To show real token counts and chunk status badges, either (a) enhance `getDocumentDetail` to return full chunk fields, or (b) switch CrawledPageViewer to use `fetchChunks` API (same as ChunkExplorer). Option (b) is preferred — avoids API duplication and ensures consistency.

```
┌─ Q1 Financial Report.pdf ──────────────── [Explore Chunks ◎] [×] ┐
│                                                                     │
│  SharePoint Corp Docs  ·  PDF  ·  2.4 MB  ·  23 chunks             │
│  Status: ● Indexed  ·  Quality: 0.92                                │
│                                                                     │
│  [Extracted]  [Original]  [Side by Side]  [Metadata]                │
│  ──────────                                                         │
│                                                                     │
│  ┌─ Chunk #1 ─── 245 tokens ── ● Indexed ───────────────── [📋] ─┐│
│  │                                                                 ││
│  │  "Executive Summary: Q1 revenue increased by 12% compared      ││
│  │   to the previous quarter, driven primarily by expansion        ││
│  │   in the APAC region..."                                        ││
│  │                                                                 ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  ┌─ Chunk #2 ─── 198 tokens ── ● Indexed ───────────────── [📋] ─┐│
│  │                                                                 ││
│  │  "Revenue Breakdown by Region: North America $4.2M,             ││
│  │   EMEA $2.8M, APAC $3.1M..."                                   ││
│  │                                                                 ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  ┌─ Chunk #14 ── 312 tokens ── 🔴 Failed ───── [↻ Retry] [📋] ──┐│
│  │                                                                 ││
│  │  "Appendix B: Detailed Financial Projections..."                ││
│  │                                                                 ││
│  │  ⚠ Error: Embedding timeout after 30s                          ││
│  │                                                                 ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  ┌─ Chunk #15 ── 287 tokens ── 🔴 Failed ───── [↻ Retry] [📋] ──┐│
│  │                                                                 ││
│  │  "Appendix C: Risk Assessment Matrix..."                        ││
│  │                                                                 ││
│  │  ⚠ Error: Embedding timeout after 30s                          ││
│  │                                                                 ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  [< 1  2  3 ... 10 >]  Chunk Navigator                             │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

METADATA TAB (existing, no changes):
┌─ Q1 Financial Report.pdf ──────────────── [Explore Chunks ◎] [×] ┐
│                                                                     │
│  [Extracted]  [Original]  [Side by Side]  [Metadata]                │
│                                                                      ────────│
│                                                                     │
│  ─── Document Info ─────────────────────────────────────────────── │
│  Title:         Q1 Financial Report.pdf                             │
│  URL:           https://contoso.sharepoint.com/docs/Q1-Report.pdf   │
│  Content Type:  application/pdf                                     │
│  Size:          2.4 MB                                              │
│  Created:       Mar 8, 2026                                         │
│  Updated:       Mar 8, 2026                                         │
│                                                                     │
│  ─── Source Metadata (JSON) ────────────────────────────────────── │
│  {                                                                  │
│    "sourceType": "sharepoint",                                      │
│    "sourceName": "Corp Docs",                                       │
│    "category": "finance",                                           │
│    "department": "accounting"                                       │
│  }                                                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 10. DATA — Chunk Explorer Dialog (G7 — accessed via "Explore Chunks" button)

Opens as a Dialog on top of CrawledPageViewer. Existing ChunkExplorer component — already built at 872 lines. No changes needed to the component itself, just wiring it in.

```
┌─ Chunks: Q1 Financial Report.pdf ───────── 23 chunks ───── [×] ──┐
│                                                                     │
│  [Flow]  [Grid]  [List]              [🔍 Search within chunks...]  │
│  ─────                                                              │
│                                                                     │
│  ─── Token Distribution ─────────────────────────────────────────── │
│  █████████████████████████████████░░░░░░░░░░░                       │
│  Total: 5,234  │  Avg: 228  │  Min: 89  │  Max: 412                │
│                                                                     │
│  ┌─ #1 ─── ● Indexed ─── 245 tokens ───────────────────────── ▼ ─┐│
│  │ "Executive Summary: Q1 revenue increased by 12%..."    [📋]    ││
│  │                                                                 ││
│  │  ─── Metadata ─────────────────────────────────────────         ││
│  │  { "position": { "page": 1, "order": 0 },                      ││
│  │    "canonicalMetadata": { "category": "finance" } }             ││
│  │  Chunk ID: chk_a3f8c2e1   Created: Mar 8, 14:23                ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  ┌─ #2 ─── ● Indexed ─── 198 tokens ────────────────────────── ▶ ─┐
│  │ "Revenue Breakdown by Region: North America $4.2M..."    [📋]   │
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  ┌─ #14 ── 🔴 Failed ── 312 tokens ────────────────────────── ▶ ─┐│
│  │ "Appendix B: Detailed Financial Projections..."          [📋]  ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  23 chunks loaded                                                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 11. INTELLIGENCE — Hub (Overview)

No structural changes. Cards already work correctly with 4-state display. Sub-nav tabs already navigate to drill-down views.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Header]                                                                    │
│   ⌂ Home        ⊟ Data        ◎ Intelligence        ⌕ Search & Test         │
│                                ──────────────                                │
│                                                                              │
│  ☰ Overview   ⊞ Pipeline   ≡ Fields   📖 Vocabulary   ◈ Knowledge Graph   ⊡ LLM│
│  ─────────                                                                   │
│                                                                              │
│  Intelligence Hub                                                            │
│  Configure enrichment features for your knowledge base.                      │
│                                                                              │
│  ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐       │
│  │ ⊞ Pipeline    ●grn │ │ ≡ Fields     ●amb  │ │ 📖 Vocabulary ●grn │       │
│  │                    │ │                    │ │                    │       │
│  │ Status: Active     │ │ Confirmed: 14     │ │ Terms: 156        │       │
│  │                    │ │ Suggested: 12     │ │ Synonyms: 42      │       │
│  │ Manage your ingest │ │                    │ │                    │       │
│  │ pipeline.          │ │ ⚠ 12 suggestions  │ │ Manage search      │       │
│  │                    │ │   ready to review  │ │ vocabulary.        │       │
│  │ [Configure →]      │ │ [Review Fields →]  │ │ [Manage →]         │       │
│  └────────────────────┘ └────────────────────┘ └────────────────────┘       │
│                                                                              │
│  ┌────────────────────┐ ┌────────────────────┐                              │
│  │ ◈ KG          ●gry │ │ ⊡ LLM Models ●amb  │                              │
│  │                    │ │                    │                              │
│  │ Not configured.    │ │ Active: 0/3       │                              │
│  │ Enable knowledge   │ │                    │                              │
│  │ graph enrichment.  │ │ ⚠ No use cases    │                              │
│  │                    │ │   enabled          │                              │
│  │ [Set Up →]         │ │ [Configure →]      │                              │
│  └────────────────────┘ └────────────────────┘                              │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 12. INTELLIGENCE — Drill-Down (e.g., Pipeline)

Sub-nav persists across all drill-down views. Clicking any tab navigates directly.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Header]                                                                    │
│   ⌂ Home        ⊟ Data        ◎ Intelligence        ⌕ Search & Test         │
│                                ──────────────                                │
│                                                                              │
│  ☰ Overview   ⊞ Pipeline   ≡ Fields   📖 Vocabulary   ◈ Knowledge Graph   ⊡ LLM│
│               ──────────                                                     │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                                                                      │    │
│  │  (Full PipelineEditor content — flow list, canvas, stage config)     │    │
│  │  (This is the existing PipelineEditor component, no changes)         │    │
│  │                                                                      │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

Same pattern for Fields, Vocabulary, Knowledge Graph, LLM Models — each renders its full-page component under the persistent sub-nav.

---

## 13. SEARCH & TEST

No structural changes from current implementation. Three vertically stacked zones.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Header]                                                                    │
│   ⌂ Home        ⊟ Data        ◎ Intelligence        ⌕ Search & Test         │
│                                                      ────────────────        │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─── ZONE 1: Playground (2/3) ──────────────┐ ┌─── Diagnostics (1/3) ────┐│
│  │                                            │ │                          ││
│  │  [🔍 Enter search query...           ]     │ │  Diagnostics             ││
│  │                                            │ │                          ││
│  │  Type: [hybrid▼]  Top-K: [10]              │ │  ▼ Data & Indexing       ││
│  │  Resolve: [exact▼]  Debug: [●on]           │ │    Documents:  1,234     ││
│  │                                            │ │    Chunks:     45,600    ││
│  │  [▶ Search] [📖 Resolve Vocab] [📋 cURL]  │ │    Last Indexed: 5m ago  ││
│  │                                            │ │    [View Pipeline →]     ││
│  │  ─── Results ────────────────────────────  │ │                          ││
│  │                                            │ │  ▶ Enrichment            ││
│  │  ┌ Latency ─────────────────────────────┐  │ │    Vocabulary: 156 terms ││
│  │  │ ████ vocab ████████ search ██ rerank │  │ │    Mappings: 14/12      ││
│  │  │ Total: 142ms                         │  │ │    [View Vocabulary →]  ││
│  │  └──────────────────────────────────────┘  │ │                          ││
│  │                                            │ │  ▶ Pipeline Health       ││
│  │  5 results / 45,600 chunks                 │ │    Embedding: text-3-sm  ││
│  │                                            │ │    Status: active        ││
│  │  ┌ #1 ─ 0.943 ─ Corp Docs ─────────────┐  │ │    [View KG →]          ││
│  │  │ "Q1 revenue increased by 12%..."     │  │ │                          ││
│  │  └──────────────────────────────────────┘  │ │                          ││
│  │                                            │ │                          ││
│  │  ┌ #2 ─ 0.891 ─ Product API ───────────┐  │ │                          ││
│  │  │ "Revenue targets for APAC..."        │  │ │                          ││
│  │  └──────────────────────────────────────┘  │ │                          ││
│  │                                            │ │                          ││
│  └────────────────────────────────────────────┘ └──────────────────────────┘│
│                                                                              │
│  ─── ZONE 2: Debug ─────────────────────────────────────────────────────── │
│                                                                              │
│  Resolution Chain Debug                                                      │
│  Run a debug query to see how each pipeline stage processes your search.     │
│                                                                              │
│  [🔍 Debug query...                          ]  [Run Debug]                  │
│                                                                              │
│  ○─── permFilter ───○─── preprocess ───○─── vocabResolve ───○─── alias ──── │
│  │    ● 2ms         │    ● 5ms         │    ● 12ms          │    ○ skip     │
│  │    applied       │    applied       │    applied         │    skipped    │
│                                                                              │
│  ───○─── search ────○─── rerank ───○─── metrics                             │
│      │   ● 89ms      │   ● 34ms    │   ● 0ms                               │
│      │   applied     │   applied   │   applied                              │
│                                                                              │
│  ▼ Vocabulary Resolution                                                     │
│    "password reset" → "credential reset" [synonym] [92%]                     │
│    "account"        → "account"          [exact]   [100%]                    │
│                                                                              │
│  ▶ Search Execution                                                          │
│  ▶ Reranking                                                                 │
│                                                                              │
│  Score Breakdown                                                             │
│  #1 Corp Docs  ████████████████████ 0.943                                   │
│  #2 Product API ██████████████████░ 0.891                                   │
│  #3 FAQ Page    ████████████░░░░░░ 0.654                                    │
│                                                                              │
│  ─── ZONE 3: Query History ─────────────────────────────────────────────── │
│                                                                              │
│  Query History                                                               │
│  Select up to 2 queries to compare side-by-side.                             │
│                                                                              │
│  ┌─── History (1/2) ─────────────────┐ ┌─── Compare (1/2) ────────────────┐│
│  │                                    │ │                                  ││
│  │  ☑ "password reset" hybrid 5 res   │ │        Query A    Query B       ││
│  │    42ms · Mar 20, 02:15 PM         │ │  Query  passw..   account..     ││
│  │                                    │ │  Type   hybrid    hybrid        ││
│  │  ☑ "account settings" hybrid 3 res │ │  Results  5         3           ││
│  │    38ms · Mar 20, 02:10 PM         │ │  Total   42ms     38ms         ││
│  │                                    │ │  Vocab   12ms      8ms         ││
│  │  ○ "pricing plans" vector 8 res    │ │  Search  24ms     25ms         ││
│  │    67ms · Mar 20, 01:55 PM         │ │  Rerank   6ms      5ms         ││
│  │                                    │ │                                  ││
│  │  [Load more]                       │ │  Latency Bars:                  ││
│  │                                    │ │  A: ███ vocab █████ srch ██ rnk ││
│  │                                    │ │  B: ██ vocab ██████ srch █ rnk  ││
│  └────────────────────────────────────┘ └──────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 14. SETTINGS (Gear Icon → SlidePanel)

No changes from current. Already working correctly.

```
┌─ Settings ──────────────────────────────────────────────── [×] ──┐
│                                                                    │
│  ─── General ───────────────────────────────────────────────────── │
│                                                                    │
│    Name:         [engineering                    ]                  │
│    Description:  [Product engineering docs       ]                  │
│                  [                               ]                  │
│                                                                    │
│    Status:       active                                            │
│    Index ID:     idx_a3f8c2e1-...                                  │
│    Created:      Mar 11, 2026                                      │
│                                                                    │
│  ─── Index Configuration ───────────────────────────────────────── │
│                                                                    │
│    Embedding Model:      text-embedding-3-small                    │
│    Dimensions:           1536                                      │
│    Vector Store:         qdrant                                    │
│    Collection:           idx_engineering_v1                        │
│    Top K:                10                                        │
│    Similarity Threshold: 0.5                                       │
│                                                                    │
│  ─── Danger Zone ──────────────────────────── border-error/30 ──── │
│                                                                    │
│    [↻ Rebuild Index]     (Coming soon)                             │
│                                                                    │
│    [🗑 Delete Knowledge Base]                                      │
│    Permanently deletes "engineering" and all data.                  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## Cross-Tab Navigation Map (G8 — Filter Context)

Shows how every navigation action carries context after fixes.

```
FROM                          ACTION                    TO
──────────────────────────────────────────────────────────────────────
Header "0 Documents"    →  click                    →  Data / Documents
Header "45,600 Chunks"  →  click                    →  Data / Chunks
Header "2 Sources"      →  click                    →  Data / Sources
Stat card "Documents"   →  click                    →  Data / Documents
Stat card "Chunks"      →  click                    →  Data / Chunks
Stat card "Sources"     →  click                    →  Data / Sources

NeedsAttention:
  "1 doc with errors"   →  [View errored docs →]   →  Data / Documents + status=error
  "Source auth expired"  →  [View source →]         →  Data / Sources + open detail panel
  "Pipeline invalid"     →  [View Pipeline →]       →  Intelligence > Pipeline
  "Circuit breaker open" →  [View Errors →]         →  Intelligence > Pipeline

ActivityFeed:
  "Crawler synced"       →  [View in Data →]        →  Data / Documents
  "Pipeline published"   →  [View Pipeline →]       →  Intelligence > Pipeline
  "Vocab updated"        →  [View Vocabulary →]     →  Intelligence > Vocabulary
  "Mappings accepted"    →  [View Fields →]         →  Intelligence > Fields
  "Index rebuilt"        →  (no button)             →  n/a

SetupGuide:
  "Add a data source"   →  [Go to Data →]          →  Data / Documents
  "Configure pipeline"  →  [Go to Pipeline →]      →  Intelligence > Pipeline
  "Run first search"    →  [Go to Search →]        →  Search & Test

ProgressView:
  "Try a search"        →  click                    →  Search & Test
  "View documents"      →  click                    →  Data / Documents
  "Review mappings"     →  click                    →  Intelligence > Fields
  "Configure LLM"       →  click (error state)     →  Intelligence > LLM Models
  "View failed docs"    →  click (error state)     →  Data / Documents + status=error

Source Detail Panel:
  "View Documents"      →  click                    →  Data / Documents + sourceId filter
  "View Chunks"         →  click                    →  Data / Chunks + sourceId filter
  "Upload Files"        →  click (manual type)     →  FileUploadDialog with sourceId
  "Trigger Sync"        →  click                    →  calls startConnectorSync/triggerSync API

Sources Table:
  Row click             →  click                    →  Source Detail Panel (enterprise or non)
  [⟳] Sync button      →  click                    →  calls sync API, shows toast
  [📤] Upload button    →  click                    →  FileUploadDialog with sourceId
  [📄] Docs button      →  click                    →  Data / Documents + sourceId filter
  ⋮ → "View Chunks"    →  click                    →  Data / Chunks + sourceId filter
  "Docs" count link     →  click                    →  Data / Documents + sourceId filter

Chunks Table:
  Row click             →  click                    →  ChunkExplorerDialog (doc context)
  "Document" link       →  click                    →  CrawledPageViewer for that doc
  "Source" link          →  click                    →  Data / Sources + opens detail panel
  Status badge          →  click                    →  filters Chunks table by that status

Diagnostics Sidebar:
  "View Pipeline"       →  click                    →  Intelligence > Pipeline
  "View Vocabulary"     →  click                    →  Intelligence > Vocabulary
  "View KG"             →  click                    →  Intelligence > KG
```

---

## Implementation Notes

### New Components Needed

| Component               | Est. Lines | Based On                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SourceDetailPanel`     | ~200       | New — simpler version of ConnectorDetailPanel                                                                                                                                                                                                                                                                                                                                                                |
| `SourcesTable`          | ~300       | Extract columns/actions from ConnectorsTab, add health summary, type badges, inline sync actions                                                                                                                                                                                                                                                                                                             |
| `ChunksTable`           | ~350       | New — paginated chunk table with multi-filter bar, stats header, chunk content preview                                                                                                                                                                                                                                                                                                                       |
| `ChunkFilterBar`        | ~120       | New — status multi-select, source dropdown, document typeahead, token range, search                                                                                                                                                                                                                                                                                                                          |
| `useDataTabFilterStore` | ~40        | New Zustand store — `{ pendingFilter, view, consumeFilter() }`. `view` now supports `'documents' \| 'chunks' \| 'sources'`. Writers (NeedsAttentionCard, ProgressView, SourceDetailPanel, SourcesTable) call `setPendingFilter()` before `setTab('data')`. Consumer (DataSection) calls `consumeFilter()` on mount to read & clear the pending filter, applying it to `activeFilter` and `activeView` state. |

### Modified Components

| Component                 | Change                                                                                                    | Gap          |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | ------------ |
| `KBHeader.tsx`            | Wrap metrics in `<button>` with onClick                                                                   | G1           |
| `OperationsDashboard.tsx` | Add onClick to StatCards, change `hoverable`                                                              | G2           |
| `ActivityFeed.tsx`        | Hide button for null target, use `setTabAndSubSection`, contextual labels                                 | G3, G4       |
| `ProgressView.tsx`        | Add action links below progress bar + error guidance                                                      | G5           |
| `DataSection.tsx`         | Add 3-way SegmentedControl (Documents/Chunks/Sources), render ChunksTable, SourcesTable, or DocumentTable | G6, G14, G15 |
| `CrawledPageViewer.tsx`   | Add "Explore Chunks" button, show chunk status/count, copy button                                         | G7           |
| `NeedsAttentionCard.tsx`  | Set `pendingFilter` before navigation                                                                     | G8           |
| `ConnectorsTab.tsx`       | Fix sourceType: send 'manual' instead of 'file' for file-upload sources (AddSourceButton already correct) | G9           |

### Backend Changes Required

| File                                   | Change                                                                                                                                                                                                                                                                     | Gap |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `apps/search-ai/src/routes/chunks.ts`  | Add `GET /:indexId/chunks` route (cross-document chunk listing with filters: status, sourceId, search, minTokens, maxTokens, sort). Must be registered BEFORE `/:indexId/chunks/:chunkId` for Express route ordering. Use `$lookup` on SearchDocument for `documentTitle`. | G14 |
| `apps/studio/src/api/search-ai.ts`     | Add `fetchAllChunks(indexId, options)` function. Extend `SearchAIChunk` type with `documentId` and `documentTitle` fields. Add `fetchChunkStats(indexId)` for aggregate stats.                                                                                             | G14 |
| `apps/search-ai/src/routes/sources.ts` | Add `GET /:indexId/sources/:sourceId` route for individual source detail (currently only `/status` sub-endpoint exists). Consider `PATCH /:indexId/sources/:sourceId` for editing source config.                                                                           | G15 |
| `apps/studio/src/api/search-ai.ts`     | Add `fetchSourceDetail(indexId, sourceId)`, optionally `updateSource(indexId, sourceId, data)`. Add `fetchSourceSummary(indexId)` (backend endpoint already exists at `GET /:indexId/sources/summary` but has no frontend client).                                         | G15 |

### No Changes Needed

| Component                                | Reason                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `ConnectorDetailPanel.tsx`               | Already fully built, just needs to be wired into Data/Sources          |
| `ChunkExplorerDialog`                    | Already fully built, just needs to be triggered from CrawledPageViewer |
| `IntelligenceSection/Hub/Cards`          | Already working correctly                                              |
| `SearchTestSection` + all sub-components | Already working correctly                                              |
| `SettingsPanel`                          | Already working correctly                                              |
| `SetupGuide`                             | Already navigates correctly                                            |
| `KBSectionNav`                           | No changes needed                                                      |

---

## Additional Gaps Found in Review (G13, G17, G25, G26)

### G13 — CrawlerTab Unreachable (HIGH)

**Problem:** `CrawlerTab.tsx` (208 lines) — full web crawler workflow with job form, progress tracking, history, crawled pages viewer, and preferences — is not imported anywhere in the new 4-nav layout. The "web" source type is disabled in AddSourceButton ("Coming Soon") but CrawlerTab has a working implementation.

**Resolution:** Two options:

1. **Re-enable web source:** Wire CrawlerTab as a sub-section of Data tab (accessible when a web source exists or via the Sources sub-view). Remove "Coming Soon" from AddSourceButton.
2. **Keep disabled, defer:** If web crawling is intentionally gated, no action needed — but CrawlerTab should be marked as deprecated/dormant in code comments to avoid confusion.

**Recommendation:** Option 2 for now — document the decision. Revisit when web source is production-ready.

### G17 — Document Status Not Clickable (MEDIUM)

**Problem:** The "Document Status" summary on the Operations Dashboard (right column) shows counts for Indexed/Processing/Error but these are not clickable. Clicking "Error: 22" should navigate to Data > Documents filtered to error status.

```
Document Status (AFTER fix):
┌─────────────────────────────────┐
│                                 │
│  Indexed       1,200            │
│  Processing       12            │
│  Error            22  ← click   │
│                   ~~            │
│    → Data / Documents           │
│      + status=error filter      │
│                                 │
└─────────────────────────────────┘
```

**Implementation:** Add `onClick` to each status row in `DocumentStatusSummary` (or wherever the summary is rendered in OperationsDashboard). Use `useDataTabFilterStore.setPendingFilter({ status })` + `setTab('data')`.

### G25 — WCAG / Accessibility (HIGH)

**Problem:** Several new interactive elements need accessibility attention:

- **Clickable metrics in KBHeader** (G1): Must have `role="button"`, `tabIndex={0}`, keyboard Enter/Space handler, `aria-label` (e.g., "View 1,234 documents in Data tab")
- **Clickable stat cards** (G2): Same keyboard + ARIA requirements
- **SourceFilterBar badges**: Already `<button>` elements — verify `aria-pressed` for active state
- **SegmentedControl** (G6): Must use `role="tablist"` / `role="tab"` with `aria-selected`
- **Focus rings**: All new clickable elements must show visible focus ring (`focus-visible:ring-2 ring-border-focus`)

**Implementation:** Apply as part of each gap's implementation. No separate component needed.

### G26 — File Upload Retry on Failure (LOW)

**Problem:** `FileUploadDialog` uploads files sequentially. If one file fails, the error is shown but the user cannot retry just the failed file — they must close and re-open the dialog, re-selecting all files. For large batches this is frustrating.

**Resolution:** Add per-file retry button next to failed items in the upload progress list. The existing `uploadDocument()` API call is idempotent (creates or replaces), so retry is safe.

```
File Upload Progress (enhanced):
┌────────────────────────────────────────────────────┐
│  report.pdf          ● Uploaded                    │
│  data.csv            ● Uploaded                    │
│  image.png           ✗ Failed: "File too large"    │
│                        [↻ Retry]                   │
│  notes.md            ● Uploaded                    │
│                                                    │
│  3 of 4 files uploaded successfully.               │
│  [Close]                                           │
└────────────────────────────────────────────────────┘
```

---

## Updated Gap Summary

| #   | Gap                                                         | Severity | Effort | Status                                          |
| --- | ----------------------------------------------------------- | -------- | ------ | ----------------------------------------------- |
| G1  | Header metrics not clickable                                | Low      | XS     | Wireframed (Screen 1)                           |
| G2  | Home stat cards not clickable                               | Low      | XS     | Wireframed (Screen 4)                           |
| G3  | ActivityFeed "View" for null targets (bug)                  | Bug      | XS     | Wireframed (Screen 4)                           |
| G4  | ActivityFeed never navigates to sub-sections                | UX       | S      | Wireframed (Screen 4)                           |
| G5  | ProgressView has zero action links                          | UX       | S      | Wireframed (Screen 3)                           |
| G6  | No source management in Data tab                            | High     | M      | Wireframed (Screen 6)                           |
| G7  | ChunkExplorer not reachable from Data tab                   | Medium   | S      | Wireframed (Screen 9, 10)                       |
| G8  | No cross-tab navigation with filter context                 | UX       | S      | Wireframed (Nav Map + store spec)               |
| G9  | Source type inconsistency ('manual' vs 'file')              | Bug      | XS     | Wireframed — fix in ConnectorsTab.tsx           |
| G10 | Non-enterprise sources have no detail panel                 | Medium   | M      | Wireframed (Screen 8)                           |
| G13 | CrawlerTab unreachable in new layout                        | High     | —      | Deferred — mark as dormant                      |
| G14 | **No "All Chunks" view — chunks only visible per-document** | **High** | **L**  | **Wireframed (Screen 5b) — needs backend**      |
| G15 | **Sources configuration view lost in redesign**             | **High** | **M**  | **Wireframed (Screen 6) — restored + enhanced** |
| G17 | Document status counts not clickable                        | Medium   | XS     | Wireframed (above)                              |
| G25 | WCAG/a11y for new interactive elements                      | High     | S      | Inline with each gap                            |
| G26 | File upload retry on failure                                | Low      | S      | Wireframed (above)                              |

### Updated Implementation Order

1. **Bug fixes:** G3, G4, G9 (XS each)
2. **Clickable metrics:** G1, G2, G17 + G25 a11y (XS–S)
3. **ProgressView actions:** G5 (S)
4. **Filter context store:** G8 — create `useDataTabFilterStore` with 3-way view support (S)
5. **ChunkExplorer access:** G7 — switch to `fetchChunks` API, add button (S)
6. **Sources configuration:** G6, G10, G15 — SourcesTable with health summary, SourceDetailPanel, inline actions (M)
7. **All Chunks view:** G14 — backend route + frontend ChunksTable + ChunkFilterBar (L, backend + frontend)
8. **File upload retry:** G26 (S, can be deferred)
9. **CrawlerTab:** G13 — document as dormant, revisit later

### Backend-First Items

G14 (All Chunks) requires backend work before frontend can begin:

1. Add `GET /api/indexes/:indexId/chunks` route with filters + `$lookup` for document titles
2. Add `fetchAllChunks()` + `fetchChunkStats()` to frontend API client
3. Extend `SearchAIChunk` type with `documentId`, `documentTitle`

G15 (Sources Configuration) has partial backend support — `fetchSources` and `fetchEnterpriseConnectors` exist. Missing:

1. `GET /api/indexes/:indexId/sources/:sourceId` for individual source detail
2. Frontend `fetchSourceSummary()` (backend endpoint exists, no client function)
