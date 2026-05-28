# Knowledge Base Navigation — Fresh UX Design (v2)

**Date**: 2026-03-16
**Status**: Draft v2 — Revised after deep-dive into all tab components
**Author**: Architect Agent

---

## Part 1: Problem Verification

### All 4 stated problems are real — confirmed against code.

| #   | Problem                                             | Code Evidence                                                                                                                                                                                         | Severity    |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | **"Where do I start?"**                             | `KnowledgeBaseDetailPage.tsx` renders 10 tabs unconditionally (lines 49-78). Brand-new KB shows all 10 tabs with zero data. No onboarding flow.                                                       | High        |
| 2   | **"Why isn't search working?"**                     | `QueryPlaygroundTab` has zero diagnostic capability. Shows results + latency bar, nothing else. Users must check 6 tabs manually (Settings → Pipeline → Vocabulary → Fields → Overview → Connectors). | Critical    |
| 3   | **"Related things are far apart"**                  | Connectors(3)/Crawler(4)/Documents(2) = 3 tabs for "data ingestion." Fields(5)/Vocabulary(6) = separate but vocabulary refs field names. Settings(9) feeds Pipeline(8)/KG(7)/Vocab(6)/Playground(10). | Medium      |
| 4   | **"Too much first visit, too little repeat visit"** | KB list page: zero search, zero filters, zero pagination. Detail page: no keyboard shortcuts, no command palette, no quick actions.                                                                   | Medium-High |
| 5   | **Navigation bug (new finding)**                    | `KnowledgeBaseDetailPage.tsx` line 112: back button navigates to `/search` instead of `/search-ai`. Lands on `ProjectOverviewPage`.                                                                   | Bug         |

### Additional Scale Problems Found (code audit)

| Component                     | Current Behavior                                                                         | Impact at Scale                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **DocumentsTab** (656 lines)  | `fetchDocuments(indexId)` loads ALL docs in memory. Zero pagination.                     | 5K+ docs = UI freeze                                  |
| **ConnectorsTab** (645 lines) | Sources prop rendered entirely in `DataTable`. Zero pagination.                          | 100+ connectors = lag                                 |
| **FieldsTab** (~1100 lines)   | `useSearchAIMappings(schemaId)` loads ALL mappings. Zero pagination. 22+ useState hooks. | 100 connectors × 15 fields = 1500+ mappings in memory |
| **VocabularyTab** (414 lines) | Server-side pagination, 50/page.                                                         | ✅ Only properly scaled tab                           |

### What the v4 Analysis Gets Right

1. 4-section grouping (Summary, Data Sources, Enrichment, Search & Test) — solid intent-based reorg
2. Issues vs Opportunities split — prevents alert fatigue
3. Resolution Chain — genuinely differentiating, no competitor shows full query pipeline trace
4. Compound document status (Indexed/Processing/Partial/Failed) — surfaces real pipeline states
5. Enrichment → Search feedback loops — closes the "configure and hope" gap
6. Data Sources sidebar + document table — correct unified data view

### Where the v4 Analysis Falls Short

1. **Enrichment accordion can't contain the complexity** — FieldsTab alone is 1100 lines with 3 sub-views, 4 dialogs, and 22 state variables. Vocabulary has pagination + 4 dialogs. PipelineEditor is a full split-pane IDE. These can't live inside accordion sections.
2. **No scale strategy** — 100+ connectors need grouping, search, virtual scroll. 1500+ field mappings need server-side pagination. v4 mentions "scaling to 100+ connectors" but its sidebar design doesn't address the data layer.
3. **LLM config hidden in gear menu** — it's a prerequisite for Pipeline, KG, Vocabulary, and Field suggestions. Hiding it in Settings means users configure enrichment features without realizing they need an LLM model.
4. **KB list page not addressed** — zero search/filter/pagination.

---

## Part 2: Design — "4-Nav with Intelligence Hub"

### Design Principles

1. **Organize by user intent** — not by technical module
2. **Each navigation view is self-contained** — no accordion sections trying to contain full-page experiences
3. **Intelligence Hub shows health at a glance, drills down to full-page editors** — summary cards → dedicated routes
4. **Scale-aware from day one** — server-side pagination, virtual scroll, search/filter for every list
5. **Search is a dedicated view** — not ambient (see Part 1 self-critique)

### Information Architecture

```
Knowledge Bases (list page — with search, filters, cards)
  └─ KB Detail
       ├─ [Persistent Header] — name, status, metrics, gear icon
       │
       ├─ Home ─────────── Adaptive: Setup Guide (new) OR Operations Dashboard (mature)
       ├─ Data ─────────── Source sidebar + Document table (paginated)
       ├─ Intelligence ─── Card grid hub → drill-down to full-page editors
       │    ├─ /intelligence/fields ──────── Full Fields experience
       │    ├─ /intelligence/vocabulary ──── Full Vocabulary experience
       │    ├─ /intelligence/pipeline ────── Full Pipeline editor
       │    └─ /intelligence/knowledge-graph Full KG experience
       └─ Search & Test ── Playground + Resolution Chain + Diagnostics + History
```

**Why 4 navigation items (not 3)**:
Search & Test needs its own dedicated space. The Resolution Chain alone (7-stage visualization) plus diagnostics (3-category checklist) plus query history with compare plus developer docs is too much to squeeze into a slide-down panel. Playground is a daily-use power tool — it deserves a full view.

**Why Intelligence drills down to sub-routes (not accordion/slide-over)**:

- FieldsTab is 1100 lines with 3 sub-views, 4 dialogs, 22 state variables. It IS a full page.
- PipelineEditor is a split-pane IDE with Zustand store, Cmd+S, StageConfigPanel (fixed positioning). It IS a full page.
- KnowledgeGraphTab has a 3-state machine, 600px graph canvas, 5 custom hooks. It IS a full page.
- VocabularyTab has paginated table, search, filters, 4 dialogs. It IS a full page.
- Trying to contain any of these inside an accordion section or slide-over degrades the experience.

---

### 2.1 Persistent Header

Always visible across all views within a KB. Contains identity, health, and the most-used actions.

```
┌────────────────────────────────────────────────────────────────────┐
│ ← Knowledge Bases                                                  │
│                                                                    │
│ Product Docs KB                                         ⚙ Settings │
│ ✅ Ready │ 1,234 docs │ 45.6K chunks │ 3 sources │ Indexed: 5m ago│
│                                                                    │
│  ● Home    ● Data    ● Intelligence    ● Search & Test             │
└────────────────────────────────────────────────────────────────────┘
```

- **Inline metrics** replace v4's stat cards — always visible, no dedicated section needed
- **Settings gear** opens slide-over for rare config (name, description, visibility, index config, danger zone)
- **Status badge** with dot indicator (Ready/Creating/Rebuilding/Error)

---

### 2.2 Home — Adaptive Interface

Home adapts to the KB lifecycle. Three distinct states:

#### State 1: Brand New KB (0 documents, 0 sources)

```
┌────────────────────────────────────────────────────────────────────┐
│ [Header — metrics all zero, search disabled]                       │
│  ● Home    ● Data    ● Intelligence    ● Search & Test             │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                                                             │  │
│  │  Let's get "Product Docs KB" ready for search.              │  │
│  │                                                             │  │
│  │  ┌──────────────────┐    ┌──────────────────┐               │  │
│  │  │                  │    │                  │               │  │
│  │  │  📄 Upload files │    │  🔌 Connect a    │               │  │
│  │  │                  │    │     data source  │               │  │
│  │  │  Drag & drop a   │    │                  │               │  │
│  │  │  PDF, DOCX, or   │    │  SharePoint, web │               │  │
│  │  │  text file.      │    │  crawler, DB, or │               │  │
│  │  │                  │    │  API endpoint    │               │  │
│  │  │  ┌────────────┐  │    │                  │               │  │
│  │  │  │  Drop zone  │  │    │  [Connect →]     │               │  │
│  │  │  │  or [Browse]│  │    │                  │               │  │
│  │  │  └────────────┘  │    └──────────────────┘               │  │
│  │  │                  │                                      │  │
│  │  └──────────────────┘                                      │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─ What happens automatically ────────────────────────────────┐  │
│  │  ⬜ Schema detection — fields discovered from your data      │  │
│  │  ⬜ Field mapping — AI suggests source → canonical mappings   │  │
│  │  ⬜ Processing — extract → chunk → embed (default pipeline)  │  │
│  │  ⬜ Search ready — query with natural language               │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─ LLM Status ───────────────────────────────────────────────┐  │
│  │  ⚠ No LLM model configured — AI features limited           │  │
│  │  [Configure LLM Model →]                                    │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**Key design**: File upload drop zone is on the home page itself. Zero navigation to go from "new KB" to "data ingesting." This is the fastest path.

#### State 2: First Data Arriving (sync in progress)

```
┌────────────────────────────────────────────────────────────────────┐
│ [Header — "8 of 23 docs indexed"]                                  │
│  ● Home    ● Data    ● Intelligence    ● Search & Test             │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌─ Progress ──────────────────────────────────────────────────┐  │
│  │                                                             │  │
│  │  Setting up your knowledge base...                          │  │
│  │                                                             │  │
│  │  ✅ SharePoint connected — 23 documents discovered          │  │
│  │  🔄 Processing documents — 8 of 23 indexed                  │  │
│  │     ████████████░░░░░░░░░░░░ 35%                            │  │
│  │  ✅ Schema detected — 8 fields found                        │  │
│  │  🟡 12 field mapping suggestions ready                      │  │
│  │  ⬜ Search ready (partial results available now)             │  │
│  │                                                             │  │
│  │  [Try a search →]  [Review field mappings →]                │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─ Add More Data ────────────────────────────────────────────┐  │
│  │  [📄 Upload files]  [🌐 Add web crawler]  [🔌 Add source]  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

Home transitions automatically from setup guide to progress view when data starts flowing.

#### State 3: Mature KB (100+ documents, configured)

```
┌────────────────────────────────────────────────────────────────────┐
│ [Header — full metrics]                                            │
│  ● Home    ● Data    ● Intelligence    ● Search & Test             │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌─ Needs Attention (1) ──────────────────────────────────────┐  │
│  │                                                             │  │
│  │  🔴 SharePoint "Corp Docs" — auth token expired             │  │
│  │     Last synced 3 days ago. 23 documents may be stale.      │  │
│  │     [Reconnect →]                                           │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─ Suggestions ──────────────────────────────────────────────┐  │
│  │                                                             │  │
│  │  💡 12 field mapping suggestions from Web Crawler            │  │
│  │     [Review →]                              [Dismiss]       │  │
│  │                                                             │  │
│  │  💡 Vocabulary: 6 new terms auto-generated                   │  │
│  │     Match rate: 72% → 78%                                   │  │
│  │     [Review terms →]                        [Dismiss]       │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─ Activity ─────────────────────────────────────────────────┐  │
│  │                                                             │  │
│  │  5m ago    Web Crawler synced 45 pages           [View →]   │  │
│  │  12m ago   Pipeline processed 45 docs            [View →]   │  │
│  │  1h ago    Sarah uploaded Q1-Report.pdf           [View →]   │  │
│  │  3h ago    Pipeline v3 published                  [View →]   │  │
│  │                                                             │  │
│  │  [View all activity →]                                      │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**Mature Home has 3 sections max**: Needs Attention (red, issues), Suggestions (blue, optional), Activity (neutral, feed). When nothing needs attention: `✅ All systems healthy` one-liner replaces the section.

**Needs Attention includes** (aggregated from all subsystems):

- Connector auth failures, sync errors
- Pipeline circuit breakers tripped, unpublished draft with stale processing
- Embedding model mismatch between index and query
- Index rebuild failures

**Suggestions include**:

- Pending field mapping suggestions (from LLM/rule-based)
- Auto-generated vocabulary terms ready for review
- KG not enabled (if documents exist)
- Stale documents processed by older pipeline version

---

### 2.3 Data — Source Sidebar + Paginated Document Table

Unified view for "where does data come from and what's been ingested."

```
┌────────────────────────────────────────────────────────────────────┐
│ [Header]                                                           │
│  ● Home    ● Data    ● Intelligence    ● Search & Test             │
├────────────┬───────────────────────────────────────────────────────┤
│            │                                                       │
│  SOURCES   │  ┌─ Source: SharePoint Corp ─── ✅ Active ──────────┐│
│            │  │ Last sync: 2 min ago │ 23 docs │ Schedule: 6h    ││
│ [Search___]│  │ [Sync Now]  [Configure]  [View Docs]             ││
│ [Type▼Stat]│  └──────────────────────────────────────────────────┘│
│            │                                                       │
│ All (127)  │  Documents                       [🔍 Search docs... ]│
│ ────────── │  [Source▼] [Status▼] [Type▼] [Date▼]    [Columns ▼] │
│            │                                                       │
│ 🏢 SharePoint│ ┌──────┬─────────┬────────┬──────┬──────┬───────┐ │
│  ├ Corp (23)│ │Title │ Source  │ Status │ Type │Chunks│ Date  │ │
│  ├ HR (89) │ ├──────┼─────────┼────────┼──────┼──────┼───────┤ │
│  └ Legal(45)│ │📄 Q1  │SharePt  │ ✅ Idx │ PDF  │  23  │ Mar 8 │ │
│ 🌐 Web (8)  │ │🌐 FAQ │Web      │ ✅ Idx │ HTML │  45  │ Mar 7 │ │
│  ├ Docs(145)│ │📄 Spec│Manual   │ 🟡 8/12│ PDF  │  8   │ Mar 9 │ │
│  ├ Blog(234)│ │📄 Data│Manual   │ 🔴 Fail│ DOCX │  --  │ Mar 9 │ │
│  └ 5 more   │ │📄 API │Database │ 🔄 Proc│ JSON │  --  │ Mar10 │ │
│ 📄 Upload(12)│ └──────┴─────────┴────────┴──────┴──────┴───────┘ │
│ 🗄 DB (4)   │                                                     │
│ 🔌 API (100)│  Showing 1-50 of 1,234        [< 1 2 3 ... 25 >]  │
│  ├ Zendesk  │                                                     │
│  ├ Jira     │                                                     │
│  └ 98 more  │                                                     │
│ ────────── │                                                     │
│ [+ Add     │                                                     │
│  Source]   │                                                     │
│ ────────── │                                                     │
│ EXPLORE    │                                                     │
│            │                                                     │
└────────────┴───────────────────────────────────────────────────────┘
```

#### Source Sidebar — Designed for 100+ Connectors

```
┌────────────┐
│  SOURCES   │
│            │
│ [Search___]│  ← Search by connector name
│ [Type ▼]   │  ← Filter: All/SharePoint/Web/Upload/DB/API
│ [Status ▼] │  ← Filter: All/Active/Syncing/Error
│            │
│ All (127)  │  ← Total count
│ ────────── │
│ 🏢 SharePoint (3)    ← Type group header (collapsible)
│  ├ Corp Docs  ✅ 234  ← Compact row: name + status dot + doc count
│  ├ HR Portal  ✅  89
│  └ Legal Vault 🔴  45  ← Red dot = error, immediately visible
│ 🌐 Web Crawlers (8)
│  ├ Help Center ✅ 1.2K
│  ├ Blog       🔄  234  ← Spinner = syncing
│  └ ... 6 more         ← Collapsed, click to expand
│ 📄 Manual (12)
│  └ ... 12 items
│ 🗄 Database (4)
│  └ ... 4 items
│ 🔌 API (100)          ← Largest group
│  ├ Zendesk    ✅  12K
│  ├ Jira       ✅ 8.9K
│  ├ ServiceNow ✅ 4.5K
│  └ ... 97 more        ← Virtual scroll within group
│ ────────── │
│ [+ Add Source]
│ ────────── │
│ EXPLORE    │  ← Toggle to full data explorer
└────────────┘
```

**Scaling design**:

- **Search bar** at top — instant filter by connector name ("zen" → shows Zendesk)
- **Type filter**: All / SharePoint / Web / Upload / Database / API (with counts)
- **Status filter**: All / Active / Syncing / Error (with counts)
- **Collapsible type groups**: expanded by default when ≤10 total sources; collapsed at 10+
- **Compact rows**: icon + name + status dot + doc count. No cards. Fits 15-20 rows visible.
- **"... N more"**: groups with >3 items show top 3, click to expand
- **Virtual scroll**: within expanded groups, uses virtual scroll for 100+ items in a single type group
- Active (selected) source highlighted with left border accent

#### Source Detail Card

Clicking a source in the sidebar shows a **detail card above the document table** (not a slide-over):

```
┌─ Source: Zendesk API ──────────── ✅ Active ─── 12,345 docs ─────┐
│                                                                    │
│ Type: API │ Auth: OAuth ✅ │ Schedule: Every 2 hours               │
│ Last sync: 23 min ago │ Next: in 1h 37m                           │
│                                                                    │
│ [Sync Now]  [Configure →]  [Delete]                               │
│                                                                    │
│ Sync History:  Mar 16: +12 docs ✅ │ Mar 16: +8 ✅ │ Mar 15: +45 ✅│
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

For **Web Crawler** sources, the detail card includes crawler-specific sub-navigation:

```
┌─ Source: Help Center Crawler ──── 🔄 Crawling ─── 1,234 pages ───┐
│                                                                    │
│ URL: https://docs.example.com │ Depth: 3 │ Schedule: Daily        │
│ Pages discovered: 200 │ Crawled: 145/200 │ ████████████░░░░ 72%   │
│                                                                    │
│ [Stop Crawl]  [Configure →]  [Delete]                             │
│                                                                    │
│ ● Jobs  ● Pages  ● Preferences                                    │
│ ┌──────────────────────────────────────────────────────────────┐  │
│ │ [Crawler sub-content: job list / crawled pages / prefs]      │  │
│ └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**Why inline card instead of v4's slide-over**: Less context-switching. You see the source config AND its filtered documents on the same screen. The card collapses to a compact strip when you scroll down to focus on documents.

#### Document Table — Paginated

**Server-side pagination required** (current code loads ALL docs — will break at scale).

```
Documents                                    [🔍 Search docs... ]
[Source: Any ▼] [Status ▼] [Type ▼] [Date ▼]         [Columns ▼]

┌──────┬──────────┬────────┬──────┬──────┬───────┬────────────────┐
│      │ Title    │ Source │Status│ Type │Chunks │ Date           │
├──────┼──────────┼────────┼──────┼──────┼───────┼────────────────┤
│ 📄   │ Q1 Report│SharePt │ ✅   │ PDF  │  23   │ Mar 8, 2026    │
│ 🌐   │ FAQ Page │Web     │ ✅   │ HTML │  45   │ Mar 7, 2026    │
│ 📄   │ Spec v2  │Manual  │🟡8/12│ PDF  │  8    │ Mar 9, 2026    │
│ 📄   │ DataSheet│Manual  │ 🔴   │ DOCX │  --   │ Mar 9, 2026    │
│      │          │        │Extract│     │       │                │
│      │          │        │error │     │       │                │
│ 🗄   │ Product#1│Database│ 🔄   │ JSON │  --   │ Mar 10, 2026   │
└──────┴──────────┴────────┴──────┴──────┴───────┴────────────────┘

☐ 0 selected  [Reprocess] [Delete]       1-50 of 1,234  [< 1 2 3 >]
```

**Compound document status** (reflects both document and chunk states):

| Status     | Visual       | Data Condition                                               |
| ---------- | ------------ | ------------------------------------------------------------ |
| Indexed    | ✅           | `document.status=ready` AND all `chunks.status=ready`        |
| Processing | 🔄           | `document.status=processing` OR any `chunk.status=embedding` |
| Partial    | 🟡 8/12      | `document.status=ready` BUT some `chunks.status=error`       |
| Failed     | 🔴 + message | `document.status=error` (inline error text)                  |

**[Columns ▼] picker**: Toggle optional columns (Flow, Content Hash, Pipeline Version, Language). Default shows core set.

**Clicking a source in the sidebar** → filters document table to that source. "All" resets.

**Clicking a document row** → opens Document Detail drawer (right-side, same as v4 design).

#### Explore Mode

Toggle from "EXPLORE" in sidebar footer. Switches to full data explorer with:

- **Documents ↔ Chunks toggle** — same filter bar, different table
- **Content search** — search within chunk text (requires backend `$text` index or vector search)
- **Bulk actions** — multi-select → Reprocess, Delete, Export
- **Chunk inline expand** — click a chunk row to see full content, canonical metadata, vector info

---

### 2.4 Intelligence — Card Grid Hub with Drill-Down Routes

The hub page shows all enrichment features' health at a glance. Each card is a launch point to a full-page experience.

```
┌────────────────────────────────────────────────────────────────────┐
│ [Header]                                                           │
│  ● Home    ● Data    ● Intelligence    ● Search & Test             │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  How your data is processed and enriched for search.               │
│  Flow: Sources → Pipeline → Schema → Vocabulary → KG → Search     │
│                                                                    │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐│
│  │ 🔧 Processing Pipeline       │  │ 📋 Schema & Fields           ││
│  │                              │  │                              ││
│  │ 3 flows │ Published ✅       │  │ 14 canonical fields          ││
│  │ Embedding: e5-small (1536d)  │  │ 127 connector source fields  ││
│  │ 0 errors │ 0 breakers       │  │ 12 suggested mappings 🟡     ││
│  │                              │  │ 34 unmapped fields           ││
│  │ Last published: 2 days ago   │  │                              ││
│  │                              │  │ [Accept All High-Conf]       ││
│  │ [Open Editor →]              │  │ [Review Mappings →]          ││
│  │ [Test Flow Selection]        │  │                              ││
│  │                              │  │                              ││
│  └──────────────────────────────┘  └──────────────────────────────┘│
│                                                                    │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐│
│  │ 📖 Vocabulary                │  │ 🕸 Knowledge Graph            ││
│  │                              │  │                              ││
│  │ 156 terms │ 78% match rate   │  │ Enabled │ 234 entities       ││
│  │ 142 active │ 14 disabled     │  │ 98% documents enriched       ││
│  │                              │  │ Domain: Electronics          ││
│  │ Recent additions:            │  │ Taxonomy: v3                 ││
│  │  "CPU" → processor, chip     │  │                              ││
│  │  "RAM" → memory              │  │ [Explore Graph →]            ││
│  │                              │  │ [Run Enrichment]             ││
│  │ [Manage Terms →]             │  │                              ││
│  │ [Test Resolution]            │  │                              ││
│  │ [Generate from Schema]       │  │                              ││
│  └──────────────────────────────┘  └──────────────────────────────┘│
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 🤖 LLM Models                                              │  │
│  │                                                             │  │
│  │ GPT-4o-mini ✅  →  Summarization, Vocabulary, Fields,       │  │
│  │                    Classification, Query Resolution          │  │
│  │ GPT-4o ✅       →  Knowledge Graph extraction               │  │
│  │ — Not configured:  Vision, Multimodal                       │  │
│  │                                                             │  │
│  │ Usage: 234K / 1M tokens (23%)  ████░░░░░░░░░░░░            │  │
│  │                                                             │  │
│  │ [Configure Models →]                                        │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

#### Card Adaptive States

Each card adapts based on the feature's state:

**Not configured:**

```
┌──────────────────────────────┐
│ 🕸 Knowledge Graph            │
│                              │
│ Not enabled                  │
│                              │
│ Extract entities and         │
│ relationships from your      │
│ documents to improve search. │
│                              │
│ Requires: LLM model ✅       │
│                              │
│ [Enable Knowledge Graph →]   │
└──────────────────────────────┘
```

**Needs attention (yellow badge):**

```
┌──────────────────────────────┐
│ 📋 Schema & Fields      🟡   │
│                              │
│ 14 canonical fields          │
│ 127 connector source fields  │
│ 12 suggested mappings 🟡     │
│ 34 unmapped fields           │
│                              │
│ Accepting mappings improves  │
│ structured filtering.        │
│                              │
│ [Accept All High-Conf]       │
│ [Review Mappings →]          │
└──────────────────────────────┘
```

**Healthy (green badge):**

```
┌──────────────────────────────┐
│ 📖 Vocabulary           ✅   │
│                              │
│ 156 terms │ 78% match rate   │
│                              │
│ [Manage →] [Test Resolution] │
└──────────────────────────────┘
```

**Error (red badge):**

```
┌──────────────────────────────┐
│ 🔧 Pipeline             🔴   │
│                              │
│ 3 flows │ Draft (unpublished)│
│ 2 circuit breakers tripped   │
│                              │
│ Embedding: e5-small (1536d)  │
│                              │
│ [Open Editor →] [View Errors]│
└──────────────────────────────┘
```

#### Why LLM Models Card is on Intelligence (not Settings)

LLM models are a **prerequisite** for:

- Field mapping suggestions (mapping-suggestion.service.ts uses WorkerLLMClient)
- Vocabulary generation (vocabulary-generation-worker)
- Knowledge Graph extraction
- Query vocabulary resolution
- Pipeline summarization, classification, noise detection

Making this card visible alongside the features it powers surfaces the dependency. Users see "Not configured: Vision, Multimodal" next to the features that need them.

The `[Configure Models →]` link opens the full LLM configuration view — which IS the current SettingsTab content, moved to `/intelligence/models`.

#### Drill-Down: Full-Page Editors

Clicking `[Open Editor →]` on the Pipeline card navigates to `/intelligence/pipeline`. This renders the full `PipelineEditor` component with a back button:

```
┌────────────────────────────────────────────────────────────────────┐
│ ← Intelligence    Pipeline Editor              [Save] [Publish]    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│ Embedding: text-embedding-3-small (1536d)            [Change]      │
│ Pipeline: "Product Docs" │ Draft (unsaved changes)                 │
│                                                                    │
│ ┌── Flows (25%) ──┬── Flow Detail (75%) ──────────────────────┐   │
│ │                 │                                           │   │
│ │ Default Flow ◄  │  "Default Flow" (P10)                     │   │
│ │ PDF Flow        │                                           │   │
│ │ Web Flow        │  ┌────────┐  ┌────────┐  ┌────────┐      │   │
│ │                 │  │Extract │→ │ Chunk  │→ │ Embed  │      │   │
│ │ [+ Add Flow]    │  └────────┘  └────────┘  └────────┘      │   │
│ │                 │                                           │   │
│ │                 │  Selection: Default (no rules)             │   │
│ │                 │  Stages: 3 │ Enabled ✅                    │   │
│ └─────────────────┴───────────────────────────────────────────┘   │
│                                                                    │
│ [Test Flow Selection]                                              │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

Same pattern for all drill-downs:

| Card Click           | Route                           | Component                   | Back Button    |
| -------------------- | ------------------------------- | --------------------------- | -------------- |
| [Open Editor →]      | `/intelligence/pipeline`        | `PipelineEditor`            | ← Intelligence |
| [Review Mappings →]  | `/intelligence/fields`          | `FieldsTab` (refactored)    | ← Intelligence |
| [Manage Terms →]     | `/intelligence/vocabulary`      | `VocabularyTab`             | ← Intelligence |
| [Explore Graph →]    | `/intelligence/knowledge-graph` | `KnowledgeGraphTab`         | ← Intelligence |
| [Configure Models →] | `/intelligence/models`          | `SettingsTab` (LLM section) | ← Intelligence |

**This is NOT recreating tabs with extra steps.** The Intelligence hub provides something tabs can't: a unified health dashboard of all enrichment features at once. You see Pipeline has errors, Fields has pending suggestions, Vocabulary is healthy, and KG needs enabling — all in one glance. Then you drill into whichever needs work.

---

### 2.5 Intelligence → Fields (Drill-Down) — Designed for Scale

The Fields experience is the most complex. With 100 connectors × 15 fields each, we need:

- **Server-side pagination** for mappings (current code loads all — must fix)
- **Grouped view** that handles 100+ connectors without collapsing
- **Bulk actions** for efficiently reviewing hundreds of suggestions

```
┌────────────────────────────────────────────────────────────────────┐
│ ← Intelligence    Schema & Fields                                  │
│ 14 canonical fields │ 127 source fields │ 12 suggested │ 34 unmapped│
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ● My Fields    ● Suggested Mappings (12)    ● Unmapped Fields (34)│
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│  (Active sub-view: My Fields)                                      │
│                                                                    │
│  View: [By Field ▼]  ← toggle: By Field / By Connector            │
│  [+ Add Field]  [Search: _______________]                          │
│                                                                    │
│  ┌─ priority (issue_priority) ─── Text ─── Filter, Sort ────────┐ │
│  │                                                               │ │
│  │  Mapped from 4 connectors:                                    │ │
│  │                                                               │ │
│  │  ┌────────────┬───────────────────┬────────┬────────────────┐│ │
│  │  │ Connector  │ Source Path       │Conf.   │ Transform      ││ │
│  │  ├────────────┼───────────────────┼────────┼────────────────┤│ │
│  │  │ 🔌 Jira    │ fields.priority   │ 95% ██ │ value_map      ││ │
│  │  │ 🔌 ServiceN│ urgency           │ 92% ██ │ direct         ││ │
│  │  │ 🔌 PagerD  │ priority.level    │ 88% █░ │ lowercase      ││ │
│  │  │ 🔌 Zendesk │ ticket.priority   │ 91% ██ │ value_map      ││ │
│  │  └────────────┴───────────────────┴────────┴────────────────┘│ │
│  │                                                               │ │
│  │  Enum values: critical(1), high(2), medium(3), low(4)         │ │
│  │  [Edit Field]  [Edit Mappings]                                │ │
│  │                                                               │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ┌─ category ─── Text ─── Filter, Group ────────────────────────┐ │
│  │  Mapped from 2 connectors  │  3 unique values                │ │
│  │  [Expand ▶]                                                   │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ┌─ assignee_email ─── Text ─── Filter ─────────────────────────┐ │
│  │  Mapped from 3 connectors                                    │ │
│  │  [Expand ▶]                                                   │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  Showing 1-14 of 14 canonical fields                               │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**By Field view** (default): Each canonical field is a collapsible card showing all connector mappings. Good for answering "what feeds this field?"

**By Connector view** (toggle):

```
│  View: [By Connector ▼]                                           │
│  [Search: _______________]  [Type: Any ▼]  [Status: Any ▼]       │
│                                                                    │
│  ┌─ 🔌 Jira ─── API ─── 23 fields mapped ─── 2 unmapped ───────┐│
│  │                                                               ││
│  │  fields.priority    → priority (issue_priority)   95% ██     ││
│  │  fields.status      → status (issue_status)       92% ██     ││
│  │  fields.assignee    → assignee_email              88% █░     ││
│  │  ... 20 more                                                  ││
│  │                                                               ││
│  │  [View All 23]  [Show 2 Unmapped]                             ││
│  │                                                               ││
│  └───────────────────────────────────────────────────────────────┘│
│                                                                    │
│  ┌─ 🔌 ServiceNow ─── API ─── 18 fields ─── 5 unmapped ────────┐│
│  │  [Expand ▶]                                                   ││
│  └───────────────────────────────────────────────────────────────┘│
│                                                                    │
│  Showing 1-20 of 100 connectors           [< 1 2 3 4 5 >]       │
```

Good for answering "what's the mapping status for this connector?"

**Suggested Mappings sub-view**:

```
│  ● My Fields    ● Suggested Mappings (12)    ● Unmapped Fields    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ⚡ 8 high-confidence suggestions (≥80%)     [Accept All 8]       │
│                                                                    │
│  [Connector: Any ▼]  [Confidence: Any ▼]  [Search: ________]     │
│                                                                    │
│  ┌──────────┬───────────────────┬──────────────┬──────┬─────────┐│
│  │Connector │ Source Path       │ → Canonical   │ Conf │ Action  ││
│  ├──────────┼───────────────────┼──────────────┼──────┼─────────┤│
│  │🔌 Jira   │ fields.department │→ department   │ 92%  │[✅][❌] ││
│  │🔌 Jira   │ fields.component  │→ category     │ 85%  │[✅][❌] ││
│  │🔌 Service│ assignment_group  │→ team         │ 78%  │[✅][❌] ││
│  │🔌 Zendesk│ ticket.tags       │→ tags         │ 71%  │[✅][❌] ││
│  │🔌 Zendesk│ ticket.group_id   │→ team         │ 65%  │[✅][❌] ││
│  └──────────┴───────────────────┴──────────────┴──────┴─────────┘│
│                                                                    │
│  ☐ 0 selected  [Accept Selected] [Reject Selected]                │
│                                                                    │
│  Showing 1-12 of 12 suggestions                                   │
│                                                                    │
```

**Unmapped Fields sub-view**:

```
│  ● My Fields    ● Suggested Mappings    ● Unmapped Fields (34)    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Fields discovered from connectors that aren't mapped to any       │
│  canonical field yet. Map them to enable structured filtering.     │
│                                                                    │
│  [Connector: Any ▼]  [Type: Any ▼]  [Search: ________________]   │
│                                                                    │
│  ┌──────────┬──────────────────┬──────┬─────────┬───────────────┐│
│  │Connector │ Source Path      │ Type │ Samples │ Action        ││
│  ├──────────┼──────────────────┼──────┼─────────┼───────────────┤│
│  │🔌 Jira   │ fields.fix_ver   │ Text │ "v2.1", │ [Map →]       ││
│  │          │                  │      │ "v2.0"  │               ││
│  │🔌 Jira   │ fields.sprint    │ Text │ "Q1-S3" │ [Map →]       ││
│  │🔌 Service│ sys_domain       │ Text │ "global"│ [Map →]       ││
│  │🔌 Zendesk│ custom_field_123 │ Num  │ 42, 85  │ [Map →]       ││
│  └──────────┴──────────────────┴──────┴─────────┴───────────────┘│
│                                                                    │
│  Showing 1-20 of 34 unmapped           [< 1 2 >]                 │
│                                                                    │
```

**[Map →]** opens a dialog to either: create a new canonical field from this source field, or map it to an existing canonical field.

**Scale strategy for Fields**:

- **My Fields view**: Canonical fields are typically 10-40 (bounded by custom slot system: 20 string + 10 number + 5 date + 5 boolean = 40 max). Client-side rendering is fine.
- **Within each field, connector mappings**: Could be 100+. Use paginated expansion (show top 5, "[View all 100]").
- **By Connector view**: Server-side pagination at 20 connectors per page.
- **Suggested Mappings**: Server-side pagination. Typical batch is 10-50 per connector × number of connectors with pending suggestions.
- **Unmapped Fields**: Server-side pagination at 20 per page, filterable by connector.

---

### 2.6 Search & Test — Dedicated View

Full-page search experience with Resolution Chain, diagnostics, history, and developer docs.

```
┌────────────────────────────────────────────────────────────────────┐
│ [Header]                                                           │
│  ● Home    ● Data    ● Intelligence    ● Search & Test             │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌─ Query ─────────────────────────────────────────────────────┐  │
│  │                                                             │  │
│  │  ┌────────────────────────────────────────────────────────┐│  │
│  │  │ show me high priority bugs assigned to Alice           ││  │
│  │  └────────────────────────────────────────────────────────┘│  │
│  │  [Search]  [Test Vocabulary]                                │  │
│  │                                                             │  │
│  │  ▶ Options: Type [Hybrid ▼] TopK [10] Debug [on ▼]         │  │
│  │             Resolve [Alias ▼]                               │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─ Latency ── 234ms ─────────────────────────────────────────┐  │
│  │ ████████░░░░░░░░░░                                          │  │
│  │ Clean: 2ms │ Vocab: 10ms │ Vector: 156ms │ Rerank: 66ms    │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─ ▼ Resolution Chain (Debug) ───── Coverage: 80% (4/5) ─────┐  │
│  │                                                             │  │
│  │  ① "show me high priority bugs assigned to Alice"           │  │
│  │     ↓ clean                                                 │  │
│  │  ② "high priority bugs assigned alice"   → hybrid           │  │
│  │     ↓ vocabulary                                            │  │
│  │  ③ priority → issue_priority (95%)                          │  │
│  │    bugs → issue_type (88%)                                  │  │
│  │    assigned → assignee_email (92%)                          │  │
│  │     ↓ alias                                                 │  │
│  │  ④ high → level 2 │ bugs → bug │ alice → alice@corp.com     │  │
│  │     ↓ filters                                               │  │
│  │  ⑤ { issue_priority: 2, issue_type: "bug",                 │  │
│  │       assignee_email: "alice@corp.com" }                    │  │
│  │     ↓ search (hybrid RRF)                                   │  │
│  │  ⑥ 50 candidates                                            │  │
│  │     ↓ rerank                                                │  │
│  │  ⑦ 5 results (threshold 0.5)                                │  │
│  │                                                             │  │
│  │  [Copy API Call]  [Copy as cURL]                            │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  5 results (of 1,234 total)                                        │
│                                                                    │
│  ┌─ #1  Score: 0.923 ── SharePoint ── PDF Pipeline ───────────┐  │
│  │ Password Reset Guide                                       │  │
│  │ To reset your password, navigate to Settings...             │  │
│  │ category: IT │ department: Support                          │  │
│  │ 🏷 Vocab: password→credentials (92%)                        │  │
│  │                                                             │  │
│  │ ▶ Score: vector 0.89 │ filter +0.03 │ rerank 0.923         │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─ #2  Score: 0.871 ── Web Crawler ── Default ───────────────┐  │
│  │ Account Security FAQ                                       │  │
│  │ Common questions about account security...                  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─ Query Diagnostic ─── ⚠ Low vocabulary coverage ───────────┐  │
│  │                                                             │  │
│  │  Data & Indexing                                            │  │
│  │  ✅ 1,234 documents indexed                                 │  │
│  │  ✅ Embedding parity: query model = index model             │  │
│  │                                                             │  │
│  │  Enrichment                                                 │  │
│  │  🟡 "password" not in vocabulary  [Add term →]              │  │
│  │  🟡 12 field mappings pending     [Review →]                │  │
│  │                                                             │  │
│  │  Pipeline                                                   │  │
│  │  ✅ Published (v3) │ 0 errors                               │  │
│  │  🟡 15% chunks from older pipeline [Reprocess →]            │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─ Query History ─────────────────────────────────────────────┐  │
│  │  Mar 16 14:23  "reset password"  5 res  234ms   [Compare ↕]│  │
│  │  Mar 16 14:20  "return policy"   3 res  198ms              │  │
│  │  Mar 15 10:15  "reset password"  3 res  456ms   [Compare ↕]│  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌─ Query LLM ────────────────────────────────────────────────┐  │
│  │  🤖 GPT-4o-mini (auto-selected) ✅                          │  │
│  │  Used for: Vocabulary resolution, Query classification      │  │
│  │  [Change Model]                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ▶ Developer Integration (collapsed)                               │
│    POST /api/search-ai-runtime/search/{indexId}/query              │
│    [View API Docs →]                                               │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**Key features** (same concepts as v4, validated):

- **Resolution Chain**: 7-stage query pipeline trace. Primary differentiator — no competitor shows this.
- **Coverage indicator**: `80% (4/5)` — instant signal for vocabulary gap.
- **Score breakdown** per result: vector/filter/rerank components.
- **Flow attribution**: which pipeline flow processed each result.
- **Enrichment impact badges**: `🏷 Vocab: password→credentials (92%)` on results.
- **3-category diagnostic**: Data & Indexing, Enrichment, Pipeline Health. Each issue links to fix.
- **Query History** with server-side persistence, compare view for repeated queries.
- **Copy API Call**: generates exact cURL with actual generated filters from this query run.
- **"Test Vocabulary"** (renamed from "Resolve"): dry-runs stages ①–⑤ only.

---

### 2.7 Settings (Gear Icon → Slide-Over)

Only for rarely-changed configuration. LLM config lives on Intelligence page.

```
┌─ Settings ──────────────────────────────────────────────────[✕]──┐
│                                                                    │
│  General                                                           │
│  Name:        [Product Docs KB          ]                          │
│  Description: [Knowledge base for...     ]                         │
│  Visibility:  [Project-scoped ▼]                                   │
│  Created:     Mar 1, 2026 by Sarah                                 │
│  [Save]                                                            │
│                                                                    │
│  Index Configuration                                               │
│  Embedding:   text-embedding-3-small (1536d)                       │
│  Vector Store: qdrant / product-docs                               │
│  Search:      Top K: 10 │ Threshold: 0.7                          │
│  [Advanced →]                                                      │
│                                                                    │
│  Danger Zone                                                       │
│  [🔄 Rebuild Index]  [🗑 Delete Knowledge Base]                    │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

### 2.8 KB List Page — Cards with Search & Filters

Current list page has zero search, zero filters, zero pagination. Redesigned:

```
┌────────────────────────────────────────────────────────────────────┐
│ Knowledge Bases                                      [+ New KB]    │
│ Manage your project's knowledge bases                              │
│                                                                    │
│ ┌────────────────────────────────────────────────────────────────┐│
│ │ 🔍 Search knowledge bases...                                   ││
│ └────────────────────────────────────────────────────────────────┘│
│ [Status: Any ▼]  [Sort: Last Indexed ▼]                           │
│                                                                    │
│ ┌─ Product Docs ────────────── ✅ Ready ──── 1,234 docs ────────┐│
│ │ 3 sources │ 45.6K chunks │ Last indexed: 5 min ago             ││
│ └────────────────────────────────────────────────────────────────┘│
│                                                                    │
│ ┌─ Support KB ──────────────── ✅ Ready ──── 567 docs ──────────┐│
│ │ 2 sources │ 12.3K chunks │ Last indexed: 1 hour ago            ││
│ └────────────────────────────────────────────────────────────────┘│
│                                                                    │
│ ┌─ HR Knowledge Base ────────── 🔄 Rebuilding ──── 89 docs ────┐│
│ │ 1 source │ 2.1K chunks │ Rebuild: 45% ████████░░░░░░░░        ││
│ └────────────────────────────────────────────────────────────────┘│
│                                                                    │
│ ┌─ API Docs (v2) ──────────── 🔴 Error ──── 234 docs ──────────┐│
│ │ 2 sources │ 8.9K chunks │ Error: Embedding service down        ││
│ └────────────────────────────────────────────────────────────────┘│
│                                                                    │
│ Showing 4 knowledge bases                                          │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

- **Search** by KB name
- **Status filter**: All / Ready / Building / Error
- **Sort**: Last Indexed / Name / Created / Document Count
- **Card format** shows key metrics inline (sources, chunks, last indexed)
- **Error KBs show error message** on the card — no click-through required
- **Rebuilding KBs show progress bar** inline

---

### 2.9 Enrichment → Search Feedback Loops

Every enrichment action offers a bridge to verify its impact:

| After Action         | Toast Message              | Action Link                             |
| -------------------- | -------------------------- | --------------------------------------- |
| Accept field mapping | `✅ Accepted "department"` | `[Test query with department filter →]` |
| Add vocabulary term  | `✅ Added "CPU"`           | `[Test vocabulary resolution →]`        |
| Publish pipeline     | `✅ Published v4`          | `[Compare search results vs v3 →]`      |
| Enable KG            | `✅ KG enabled`            | `[Run enrichment →]`                    |
| Generate vocabulary  | `✅ 45 terms generated`    | `[Test resolution →]`                   |

Links navigate to Search & Test tab with pre-filled query/state.

---

### 2.10 Keyboard Shortcuts

```
Cmd+K  or  /     — Command palette (navigate, search, actions)
Alt+1             — Home
Alt+2             — Data
Alt+3             — Intelligence
Alt+4             — Search & Test
Alt+,             — Settings
```

**Command Palette** (Cmd+K):

```
┌─ Command Palette ───────────────────────────────────────┐
│  🔍 [Type a command...]                                  │
│                                                          │
│  Recent:                                                 │
│    Test query "reset password"                           │
│    Upload document                                       │
│                                                          │
│  Actions:                                                │
│    Upload document                          Cmd+U        │
│    Test search query                        Cmd+Q        │
│    Add data source                                       │
│    Rebuild index                            Cmd+Shift+R  │
│    Add vocabulary term                                   │
│                                                          │
│  Navigate:                                               │
│    Go to Home                               Alt+1        │
│    Go to Data                               Alt+2        │
│    Go to Intelligence                       Alt+3        │
│    Go to Search & Test                      Alt+4        │
│    Go to Pipeline Editor                                 │
│    Go to Fields                                          │
│    Go to Vocabulary                                      │
│    Open Settings                            Alt+,        │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

## Part 3: URL Structure

```
/projects/:projectId/search-ai                          → KB List
/projects/:projectId/search-ai/:kbId                    → KB Detail (Home)
/projects/:projectId/search-ai/:kbId/data               → Data
/projects/:projectId/search-ai/:kbId/intelligence        → Intelligence Hub
/projects/:projectId/search-ai/:kbId/intelligence/fields     → Fields (full)
/projects/:projectId/search-ai/:kbId/intelligence/vocabulary → Vocabulary (full)
/projects/:projectId/search-ai/:kbId/intelligence/pipeline   → Pipeline Editor
/projects/:projectId/search-ai/:kbId/intelligence/kg         → Knowledge Graph
/projects/:projectId/search-ai/:kbId/intelligence/models     → LLM Configuration
/projects/:projectId/search-ai/:kbId/search              → Search & Test
```

---

## Part 4: Comparison — Current vs v4 vs This Design

| Concern             | Current (10 tabs)        | v4 (4 tabs + gear)               | This (4-nav + hub)                              |
| ------------------- | ------------------------ | -------------------------------- | ----------------------------------------------- |
| **Tab count**       | 10 flat tabs             | 4 tabs + gear                    | 4 nav + 5 drill-down routes                     |
| **New user**        | 10 empty tabs            | Task cards on Summary            | Drop zone on Home, progress checklist           |
| **Search testing**  | Tab 10                   | Tab 4 (Search & Test)            | Tab 4 (Search & Test) — dedicated view          |
| **Debugging**       | Check 6 tabs             | Diagnostic on Search & Test      | Diagnostic on Search & Test                     |
| **Cross-reference** | Switch tabs              | Enrichment accordion             | Intelligence Hub shows all 4 at once            |
| **LLM config**      | Tab 9 (hidden)           | Gear menu (more hidden)          | Intelligence page (visible)                     |
| **Fields at scale** | All in memory            | Accordion section (same)         | Server-paginated, By Field/Connector views      |
| **100+ connectors** | DataTable, no pagination | Sidebar with grouping            | Sidebar with grouping + search + virtual scroll |
| **1000+ docs**      | All in memory            | Not addressed                    | Server-side pagination + filters                |
| **Pipeline editor** | Full tab                 | Accordion → slide-over (cramped) | Full-page route (proper space)                  |
| **KG explorer**     | Full tab                 | Accordion → slide-over (cramped) | Full-page route (proper space)                  |
| **KB list**         | No search/filter         | Not addressed                    | Search + status filter + cards                  |

---

## Part 5: Implementation Phases

### Phase 1: Structure + Data View (1.5 weeks)

- Persistent header with inline metrics
- 4-nav structure (Home/Data/Intelligence/Search & Test)
- Data view: source sidebar (with search, type groups, virtual scroll) + paginated document table
- Source detail inline card (including crawler sub-nav)
- Compound document status model
- Fix back button navigation bug

### Phase 2: Intelligence Hub + Drill-Downs (1.5 weeks)

- Intelligence card grid with adaptive states
- LLM Models card on Intelligence page
- Wire drill-down routes for Pipeline, Fields, Vocabulary, KG, Models
- Fields: add By Field / By Connector toggle views
- Fields: add server-side pagination for Suggested and Unmapped sub-views

### Phase 3: Adaptive Home (1 week)

- State 1: setup guide with drag-drop upload
- State 2: progress view during first data sync
- State 3: operations dashboard (Needs Attention, Suggestions, Activity)
- Activity feed with user attribution

### Phase 4: Search & Test Enhancements (1.5 weeks)

- Resolution Chain (7-stage visualization)
- Query Coverage indicator
- Score breakdown on results
- Flow attribution + enrichment badges
- 3-category diagnostic card
- Query History API (server-persisted, tenant+project+user scoped)
- Query History Compare view
- Copy API Call with actual generated filters

### Phase 5: Polish (1 week)

- KB list page (search, filters, cards)
- Command palette (Cmd+K)
- Keyboard shortcuts
- Enrichment → Search feedback toasts
- Pipeline Impact Preview on publish
- Real-time WebSocket updates for active operations

### Backend Changes Required

| Change                                                                 | Priority | Effort                                      |
| ---------------------------------------------------------------------- | -------- | ------------------------------------------- |
| Document list pagination (`GET /indexes/:id/documents` + limit/offset) | P0       | Small (endpoint exists, add params)         |
| Mapping list pagination (`GET /mappings` + limit/offset/filters)       | P0       | Medium                                      |
| Unmapped fields pagination                                             | P1       | Small                                       |
| Tab stats per-connector breakdown                                      | P1       | Small                                       |
| Activity/event log endpoint                                            | P2       | Medium (new model + endpoint)               |
| Query History model + CRUD                                             | P2       | Medium                                      |
| Resolution Chain data in query response                                | P2       | Medium (expose existing pipeline internals) |
| Compound document status (join doc + chunk status)                     | P1       | Small (aggregation query)                   |

---

## Part 6: Open Questions

| #   | Question                                       | Recommendation                                                                      |
| --- | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Intelligence card grid: 2-col or responsive?   | **Responsive**: 2-col wide, 1-col narrow. Cards should stack gracefully.            |
| 2   | Hub → drill-down: browser back or in-app back? | **Both**: in-app `← Intelligence` button + browser back works via URL routing.      |
| 3   | Query history storage?                         | **Server-persisted** (enterprise requirements: SOC2, cross-device, auditable).      |
| 4   | Document pagination: cursor or offset?         | **Offset** for v1 simplicity. Cursor for v2 if scale demands.                       |
| 5   | Sidebar virtual scroll library?                | `@tanstack/react-virtual` — already used in industry, tree-shakeable.               |
| 6   | Fields slot limit (40 max) — show in UI?       | **Yes**: "14 of 40 fields used" on the Fields card. Users need to know the ceiling. |
