# Knowledge Bases Information Architecture Redesign

**Date**: 2026-05-06
**Author**: Santhosh + Claude
**Status**: Proposal

---

## Part 1: Current State Information Hierarchy

### Screen Flow Map

```
KB List Page (/search-ai)
  |-- [+ New Knowledge Base] --> CreateKnowledgeBaseDialog (modal)
  |-- KB Cards (click) --> KB Detail Page (/search-ai/:kbId)

KB Detail Page
  |-- KBHeader (persistent)
  |     |-- Back arrow
  |     |-- KB Name
  |     |-- Inline metrics: Sources | Documents | Chunks | Last indexed
  |     |-- Status badge
  |     |-- [Preview SDK] button (opens /browse-preview in new tab)
  |     |-- [Settings gear] --> SettingsPanel (slide-over)
  |
  |-- KBSectionNav (4 tabs)
  |     |-- Home
  |     |-- Data
  |     |-- Intelligence
  |     |-- Search & Test
  |
  |-- HOME TAB
  |     |-- State: Setup (0 docs) --> SetupGuide
  |     |     |-- FileDropZone (upload files)
  |     |     |-- [Connect a Data Source] --> AddSourceButton --> ConnectorCatalog
  |     |     |-- LLM status banner
  |     |-- State: Progress (indexing) --> PipelineProgressTracker
  |     |-- State: Operations (ready) --> OperationsDashboard
  |           |-- Stats: Sources / Documents / Chunks (clickable -> Data tab)
  |           |-- NeedsAttentionCard
  |           |-- ActivityFeed
  |           |-- Your Sources (max 5 cards)
  |
  |-- DATA TAB
  |     |-- Sub-tabs: Sources | Documents | Chunks
  |     |-- [+ Add Source] --> ConnectorCatalog (88 connectors, 12 categories)
  |     |
  |     |-- Sources view
  |     |     |-- Health summary bar
  |     |     |-- Search + Group By + View mode (Cards/Table)
  |     |     |-- Status filter pills
  |     |     |-- Per-source actions: Upload, View Documents, Delete
  |     |     |-- Bulk actions: Pause/Resume/Sync/Delete
  |     |     |-- Click row --> SourceDetailPanel / SharePointDetailPanel / ConnectorDetailPanel
  |     |
  |     |-- Documents view
  |     |     |-- Source filter bar + Status filter
  |     |     |-- Paginated table: title, type, size, status, source, created
  |     |     |-- Bulk: Reprocess / Delete
  |     |     |-- Click row --> CrawledPageViewer
  |     |
  |     |-- Chunks view
  |           |-- Document-grouped accordion
  |           |-- Per-document: token stats, chunk list with metadata
  |           |-- Search within document
  |
  |-- INTELLIGENCE TAB
  |     |-- Sub-tabs: Overview | Pipeline | Fields | Vocabulary | Knowledge Graph | LLM Models
  |     |
  |     |-- Overview --> IntelligenceHub (5 status cards linking to sub-sections)
  |     |-- Pipeline --> PipelineEditorV2 (ReactFlow DAG editor)
  |     |     |-- Pipeline selector, toolbar (Save/Deploy)
  |     |     |-- Visual canvas with swim lanes
  |     |     |-- Stage config side panel
  |     |     |-- Embedding fields drawer
  |     |     |-- Rule builder panel
  |     |-- Fields --> FieldsTab
  |     |     |-- Sub-tabs: My Fields | Suggested | Unmapped
  |     |     |-- Per-field: edit, toggle searchable/filterable/visible, delete
  |     |     |-- [+ Add Field]
  |     |-- Vocabulary --> VocabularyTab
  |     |     |-- Search + filters + [+ Add Entry] + [Test Resolution]
  |     |     |-- Table: Term, Field Reference, Capabilities, Source, Enabled toggle
  |     |     |-- Per-entry: Edit, Delete
  |     |-- Knowledge Graph --> KnowledgeGraphTab
  |     |     |-- States: Not deployed / Needs setup / No taxonomy / Full view
  |     |     |-- Full view: Taxonomy card + [Run Enrichment] + [Delete Taxonomy]
  |     |     |-- View modes: Graph | Statistics | Attributes
  |     |     |-- Attribute manager with bulk actions
  |     |-- LLM Models --> SettingsTab (confusing name)
  |           |-- Tenant models summary + [Configure Models]
  |           |-- Embedding model config
  |           |-- Enrichment features: KG Extraction, Field Mapping, Vocabulary Gen
  |           |-- Advanced features: Vision Analysis, Multimodal Deep Analysis
  |           |-- Query Pipeline LLM config
  |
  |-- SEARCH & TEST TAB
  |     |-- LLM awareness banner
  |     |-- Query Playground (left 2/3)
  |     |     |-- Query input + type selector + TopK + [Search] + [Resolve Vocabulary]
  |     |     |-- Results with scores + content preview
  |     |     |-- Latency breakdown bar
  |     |     |-- [Copy API Call] + [Copy as cURL]
  |     |-- Query Diagnostics (right 1/3)
  |     |     |-- Data & Indexing / Enrichment / Pipeline Health (collapsible)
  |     |-- Pipeline Debug section
  |     |     |-- Resolution chain + stage details
  |     |-- Query History + Compare
  |
  |-- SETTINGS PANEL (slide-over, gear icon)
        |-- General: Name, Description (editable), Status, Index ID, Created (read-only)
        |-- Index Config: Embedding Model, Dimensions, Vector Store (read-only), Top K, Threshold (editable)
        |-- Danger Zone: Rebuild Index, Delete KB
```

### Identified Issues in Current Hierarchy

#### 1. **Inconsistent Naming & Conceptual Overlap**

- "Intelligence" tab is a grab-bag that mixes processing configuration (Pipeline), data schema (Fields), search enhancement (Vocabulary), AI enrichment (Knowledge Graph), and infrastructure (LLM Models)
- "LLM Models" sub-tab is internally named `SettingsTab.tsx` -- even the code is confused about what it is
- "Home" tab duplicates info already visible in the header (Sources, Documents, Chunks counts)

#### 2. **3 Levels of Tab Nesting**

- Main tabs (Home/Data/Intelligence/Search) --> Intelligence sub-tabs (6 items) --> Fields sub-tabs (My Fields/Suggested/Unmapped)
- This is the deepest nesting in the entire ABL platform -- no other module goes 3 levels deep

#### 3. **"Intelligence" Tab Overload**

- 6 sub-tabs (Overview, Pipeline, Fields, Vocabulary, Knowledge Graph, LLM Models) is too many
- The Overview is essentially a redundant dashboard for just this section
- Pipeline (processing HOW) and Fields/Vocabulary (WHAT to search) are fundamentally different concerns jammed together

#### 4. **Settings Panel vs. LLM Models Confusion**

- Settings gear icon opens a slide-over with General + Index Config + Danger Zone
- But "LLM Models" under Intelligence is ALSO settings -- it configures models, embedding, enrichment features
- User must check TWO different places for configuration

#### 5. **"Home" Tab Adds Little Value After Setup**

- The setup flow (State 1) is useful for onboarding
- But once running (State 3: OperationsDashboard), it mostly shows the same stats as the header + some attention items
- Competes with the Data tab for being the "content dashboard"

#### 6. **Data Tab Sub-tabs Are Good, But...**

- Sources/Documents/Chunks is a clean hierarchy
- But the "+ Add Source" button is positioned as if it belongs to all three sub-tabs, when it really only relates to Sources
- Chunks view is deeply nested (accordion -> expand document -> see chunks) making it hard to browse

#### 7. **Knowledge Graph Is a Feature Island**

- Has its own onboarding states, its own model config, its own run/enrichment actions
- Lives under "Intelligence" but has a completely different interaction model
- The Graph/Statistics/Attributes sub-views add another navigation level

#### 8. **Search & Test Is Buried**

- Despite being the primary way to validate KB quality, it's the last tab
- No quick-access from the header or home page
- Diagnostics panel duplicates pipeline health info available elsewhere

#### 9. **Discoverability of Key Actions**

- "Rebuild Index" is hidden in Settings slide-over danger zone
- "Run Enrichment" (KG) is only visible when you navigate to Intelligence > Knowledge Graph
- Pipeline "Deploy" is only visible in Intelligence > Pipeline
- SDK Preview is a small button in the header that's easy to miss

#### 10. **Accessibility Concerns**

- The deep nesting (3 levels of tabs) creates complex keyboard navigation paths
- The slide-over Settings panel is not reachable from keyboard shortcuts (only gear icon click)
- Status pills in the health summary bar use color alone (green/red/yellow) without text differentiation
- The pipeline visual editor (ReactFlow canvas) has limited keyboard navigation

---

## Part 2: Research Findings

### 2A. How Other ABL Modules Organize Navigation

| Module              | List Page                   | Detail Page                               | Tabs                                        | Settings             | Max Depth |
| ------------------- | --------------------------- | ----------------------------------------- | ------------------------------------------- | -------------------- | --------- |
| **Agents**          | Cards (3-col) + Canvas view | Single page, accordion sections           | None (accordions)                           | Inline in sections   | 2         |
| **Workflows**       | Cards (2-col)               | 5 horizontal tabs                         | Overview, Flow, Triggers, Monitor, Versions | Spread across tabs   | 2         |
| **Tools**           | 5 type-tabs + cards         | SegmentedControl (Config/Testing)         | Type tabs on list                           | Inline               | 2         |
| **Evals**           | Single page, 5 tabs         | No separate detail                        | Personas, Scenarios, Evaluators, Sets, Runs | Within each tab      | 1         |
| **Integrations**    | 2 tabs + grouped cards      | Inline expand panel                       | My Connections, Catalog                     | In expand panel      | 1         |
| **Deployments**     | 3 tabs                      | No drill-down                             | Environments, Channels, API Keys            | Within tabs          | 1         |
| **Knowledge Bases** | Cards (3-col) + metrics     | 4 main tabs + 6 sub-tabs + 3 sub-sub-tabs | Home, Data, Intelligence, Search & Test     | Gear icon slide-over | **3**     |

**Key Insight**: Knowledge Bases is the **only module** with 3 levels of tab nesting. Every other module stays at 2 levels max. The platform norm is:

- Sidebar item --> Page with tabs (or sections)
- No module uses a "hub/overview" sub-tab within a tab
- Settings are either inline (Agents, Tools) or spread across tabs (Workflows) -- never in a separate slide-over

**Patterns That Work Well Elsewhere**:

1. **Workflows**: Clean 5-tab structure at one level, each tab self-contained
2. **Tools**: Config/Testing as a binary toggle (maps well to KB's need)
3. **Agents**: Accordion sections for dense config (could work for KB Intelligence items)
4. **Evals**: Flat single-page with tabs (simple, fast navigation)

### 2B. Competitive Research Summary

**Platforms analyzed**: Pinecone, Vectara, Cohere, Algolia, Elastic, AWS Bedrock, Google Vertex AI, LangSmith, Notion/Guru/Glean

**Universal patterns across all 9 platforms**:

1. **4-6 tabs per resource is the sweet spot** (Vectara: 5, Algolia: 5, AWS: 4 sections)
2. **Testing is adjacent to content, not separate** -- every platform puts search testing either inside the resource or as a prominent tab, never buried
3. **Configuration is progressive** -- sensible defaults shown, advanced in accordions/expanders
4. **"Settings" = set-once infra; "Configuration" = iterate-on tuning** -- these are always separate
5. **Workflow-based grouping** (Algolia's Configure/Observe/Enhance) outperforms technical-taxonomy grouping

**Algolia's redesign is most relevant** -- they explicitly restructured from technical taxonomy to workflow-based grouping:

- **Before**: Everything in one sidebar, "bursting at the seams"
- **After**: Configure (setup) | Observe (monitor) | Enhance (tune)

**Vectara's 5-tab corpus model is cleanest**:

- Data | Query | Analytics | Access Control | Configuration
- Each tab is self-contained, no sub-tabs needed

**AWS Bedrock keeps it simple**:

- Detail page has Overview + Data Sources + Test panel (always visible)
- Configuration through expandable sections, not tabs

---

## Part 3: Revised Proposal

### Navigation Pattern: Dual-Sidebar (Agent Detail Pattern)

The proposed navigation uses the **dual-sidebar pattern** already established by the Agent detail page:

- **Left strip**: Main project sidebar collapses to 56px icon-only mode
- **Contextual sidebar** (240px): Shows KB name, summary stats, and categorized navigation items with section headers and count badges
- **Content area**: Full-width page for each sidebar item

This pattern is proven in the codebase (Agent detail uses it with 13 items across 5 sections: IDENTITY, CAPABILITIES, BEHAVIOR, COORDINATION, LIFECYCLE). The infrastructure exists in `ProjectSidebar.tsx` via `navGroups` with `AnimatePresence` slide transitions.

### Design Principles

1. **Dual-sidebar pattern** (align with Agent detail, the closest comparable module)
2. **Lifecycle-based section grouping** (DATA → PROCESSING → INTELLIGENCE → Search → Settings)
3. **2+ items per section** (no orphaned single-item sections -- matches Agent pattern)
4. **AI model config distributed** to the page it powers (configure + its model in one place)
5. **No sub-tabs or nesting** (every sidebar item is a full-width page)
6. **Count badges** on sidebar items for at-a-glance status

### Proposed Sidebar Structure

```
┌──────────────────────────────────────────────┐
│ ← Knowledge Bases                            │
│                                              │
│  Financial Products KB                       │
│  1 Source · 3,577 Docs · Active              │
│                                              │
│  Overview                                    │
│                                              │
│ DATA                                         │
│  Sources                            2        │
│  Documents                       3,577       │
│                                              │
│ PROCESSING                                   │
│  Pipeline                         Active     │
│  Fields                             77       │
│                                              │
│ INTELLIGENCE                                 │
│  Vocabulary                      36 terms    │
│  Knowledge Graph                    v1.0     │
│                                              │
│  Search & Test                               │
│                                              │
│ ─────────────────────────────────────────── │
│  Settings                                    │
└──────────────────────────────────────────────┘
```

### Full Layout

```
┌────────┬──────────────────────┬──────────────────────────────────────────────┐
│ Icons  │ Contextual Sidebar   │ Content Area (full width)                    │
│ (56px) │ (240px)              │                                              │
│        │                      │                                              │
│ [Grid] │ ← Knowledge Bases    │  Pipeline                                    │
│ [Bot]  │                      │                                              │
│ [Flow] │ Financial Products KB│  Pipeline summary card: Default Pipeline     │
│ [Tool] │ 1 Source · 3,577 ... │  Status: Active · Last deployed: 28/04/2026  │
│ [KB] ◄─│                      │  [Open Editor]  [Deploy]                     │
│ [Lib]  │ Overview             │                                              │
│ [Plug] │                      │  ┌── Embedding Model ──────────────────────┐ │
│ [Ext]  │ DATA                 │  │ BGE-M3 (bge-m3) · 1024 dims · Active   │ │
│        │  Sources          2  │  │ [Change]                                │ │
│ [Eval] │  Documents     3577  │  └─────────────────────────────────────────┘ │
│ [Exp]  │                      │                                              │
│        │ PROCESSING           │  ┌── Vision / Multimodal ──────────────────┐ │
│ [Sess] │  Pipeline      Active│  │ Vision Analysis: [toggle] Active        │ │
│ [Depl] │  Fields           77 │  │ Multimodal Deep Analysis: [toggle]      │ │
│ [Mail] │                      │  └─────────────────────────────────────────┘ │
│ [Xfer] │ INTELLIGENCE         │                                              │
│        │  Vocabulary   36 trm │                                              │
│ [Guard]│  Knowledge Graph v1  │                                              │
│        │                      │                                              │
│        │ Search & Test        │                                              │
│        │                      │                                              │
│        │ ──────────────────── │                                              │
│        │ Settings             │                                              │
└────────┴──────────────────────┴──────────────────────────────────────────────┘
```

### Section Grouping Rationale

| Section             | Items                               | User intent                                          | Why grouped together                                                                                                                                                        |
| ------------------- | ----------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(standalone)_      | **Overview**                        | "What's the status of my KB?"                        | KB-level dashboard, not a category                                                                                                                                          |
| **DATA**            | **Sources**, **Documents**          | "What content do I have?"                            | Both about the raw content that feeds the KB                                                                                                                                |
| **PROCESSING**      | **Pipeline**, **Fields**            | "How is content extracted, chunked, and structured?" | Pipeline handles extraction/chunking; Fields defines the schema that content is structured into during indexing. The pipeline editor already contains field mapping stages. |
| **INTELLIGENCE**    | **Vocabulary**, **Knowledge Graph** | "How is search made smarter?"                        | Both add domain understanding on top of processed content -- vocabulary for language, KG for entities/relationships                                                         |
| _(standalone)_      | **Search & Test**                   | "Does search work correctly?"                        | The validation step after all configuration -- follows the lifecycle naturally                                                                                              |
| _(below separator)_ | **Settings**                        | "KB admin: rename, delete, API access"               | Set-once infrastructure, separate from iterate-on configuration                                                                                                             |

**Why Fields is under PROCESSING, not INTELLIGENCE**: Field mappings define how source data maps to index fields during ingestion -- they're about structuring raw content into a schema. The pipeline editor already has field mapping nodes as processing stages. Vocabulary and Knowledge Graph, by contrast, add semantic understanding on top of already-structured content.

### AI Model Config Distribution

Each sidebar page includes the AI model configuration that powers it, so users configure the capability and its model in one place:

| Sidebar page        | AI model config included                  | Why here                                                                                   |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Pipeline**        | Embedding model, Vision/Multimodal models | These are processing stages -- embedding happens during indexing, vision during extraction |
| **Fields**          | Field mapping suggestion model            | LLM that auto-suggests field mappings                                                      |
| **Vocabulary**      | Vocabulary generation model               | LLM that auto-generates domain vocabulary                                                  |
| **Knowledge Graph** | KG extraction model                       | LLM that extracts entities and relationships                                               |
| **Search & Test**   | Query LLM                                 | LLM that powers query-time features (answer generation, reranking)                         |
| **Settings**        | Model usage summary (read-only)           | Admin view: all models in use, cost tiers, no configuration -- just visibility             |

### Per-Page Content Specification

#### Overview

- Stats row: Sources, Documents, Chunks, Last indexed
- Pipeline status card (healthy / needs attention / error)
- Needs attention items (promoted to be visible)
- Recent activity feed
- Quick actions: Add Source, Upload Files, Search, Deploy Pipeline
- Setup wizard (conditional, shown when 0 documents)
- Discovery activity bar (when background crawls are running)

#### Sources

- Source list with health summary
- Search + Group By + View mode (Cards/Table)
- Status filter pills
- [+ Add Source] --> ConnectorCatalog (88 connectors, 12 categories)
- Per-source actions: Upload, View Documents, Delete
- Bulk actions: Pause/Resume/Sync/Delete
- Click source --> SourceDetailPanel / SharePointDetailPanel / ConnectorDetailPanel (slide-overs)

#### Documents

- Document table with source filtering and status filtering
- Search documents
- Paginated table: title, type, size, status, source, created
- Bulk actions: Reprocess / Delete
- Click document --> CrawledPageViewer
- Expand document row --> chunk details (token stats, chunk list, metadata)
- PipelineStatusTooltip on status column

#### Pipeline

- Pipeline summary card with status, flow count, stage count
- [Open Editor] button --> full-screen PipelineEditorV2 (ReactFlow canvas)
- [Deploy] button
- Pipeline selector (switch between pipelines)
- Embedding model configuration section
- Vision/Multimodal model toggles
- All editor features preserved: stage config panel, embedding fields drawer, rule builder, unsaved indicator, create/delete pipeline

#### Fields

- My Fields / Suggested / Unmapped (inline tabs or filter toggles within the page)
- Per-field: edit, toggle searchable/filterable/visible, delete
- [+ Add Field]
- Bulk confirm/reject suggested mappings
- Field mapping suggestion model configuration

#### Vocabulary

- Terms table with search + filters (Status, Generated By)
- [+ Add Entry]
- Per-entry: edit, delete, enable/disable toggle
- Pagination
- VocabularyReviewDialog (review auto-generated terms)
- Vocabulary generation model configuration
- Note: [Test Resolution] moved to Search & Test page

#### Knowledge Graph

- Onboarding states: not deployed / needs setup / no taxonomy (inline, not separate pages)
- Taxonomy summary card: domain, version, products/attributes counts
- [Run Enrichment] button
- [Delete Taxonomy] (in 3-dot menu)
- View modes: Graph | Statistics | Attributes (inline toggle, same page)
- Graph: force visualization with edge type toggles, entity limit
- Statistics: document classification table, entity distribution
- Attributes: AttributeTable + bulk actions, AttributeDetailPanel, AttributeMergeDialog
- KG extraction model configuration

#### Search & Test

- LLM awareness banner
- Query playground: query input, type selector (semantic/structured/hybrid), TopK, [Search], [Resolve Vocabulary]
- Results with scores + content preview
- Latency breakdown bar
- [Copy API Call] + [Copy as cURL]
- Query diagnostics sidebar: Data & Indexing / Enrichment / Pipeline Health
- Pipeline debug: ResolutionChain + stage details
- Query history + compare (select 2 for side-by-side)
- Vocabulary test (moved from Intelligence > Vocabulary)
- Query LLM configuration

#### Settings

- General: Name (editable), Description (editable), Status (read-only), Created (read-only)
- Index Info: Search Index ID, Embedding model, Dimensions, Vector store, Collection (all read-only)
- API & SDK: Preview SDK link, API snippets, SDK configuration
- Model Usage: read-only summary of all active models across the KB, cost tiers
- Danger Zone: Rebuild Index, Delete KB

### Implementation Notes

**Reuses existing infrastructure**: The dual-sidebar drill-down is already implemented in `ProjectSidebar.tsx` via `navGroups`. Adding KB requires:

1. Add a `'knowledge-bases'` entry to `navGroups` with ~9 pages in its `pages` array
2. Add URL segment mappings (like `SETTINGS_PAGE_SEGMENTS`) for KB sub-pages
3. Each sidebar item renders a full-page component in `AppShell.renderContent()`
4. Adjust `handleBackToMain` to be group-aware: KB back button goes to `/search-ai` (KB list), not `/overview`

**Components removed**: `KBSectionNav` (horizontal tab bar), `IntelligenceSubNav` (sub-tab bar), `IntelligenceHub` (overview dashboard), `SettingsPanel` (gear slide-over)

**Components preserved**: All detail panels (SourceDetailPanel, SharePointDetailPanel, ConnectorDetailPanel), all dialogs, PipelineEditorV2, CrawlFlowV5, BrowsePreviewPage, all data tables and viewers

### Comparison with Agent Sidebar

|                       | Agent                                                                 | Knowledge Base                                      |
| --------------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| **Top**               | Agent name + description                                              | KB name + summary stats                             |
| **Section 1**         | IDENTITY (2 items: Goal & Persona, Execution)                         | DATA (2 items: Sources, Documents)                  |
| **Section 2**         | CAPABILITIES (2 items: Tools, Gather Fields)                          | PROCESSING (2 items: Pipeline, Fields)              |
| **Section 3**         | BEHAVIOR (4 items: Flow Steps, Constraints, Guardrails, Conversation) | INTELLIGENCE (2 items: Vocabulary, Knowledge Graph) |
| **Section 4**         | COORDINATION (2 items: Handoffs, Delegates)                           | --                                                  |
| **Section 5**         | LIFECYCLE (3 items: On Start, Error Handling, Completion)             | --                                                  |
| **Standalone**        | --                                                                    | Overview, Search & Test                             |
| **Below separator**   | --                                                                    | Settings                                            |
| **Total items**       | 13                                                                    | 9                                                   |
| **Items per section** | 2-4                                                                   | 2 (consistent)                                      |

KB is simpler than Agent (fewer configuration surfaces), so 9 items vs. 13 is proportional.

---

## Part 4: Feature Coverage Comparison

Every feature and action available in the current UI is mapped to its location in the proposed structure. **Zero features removed.**

### KB List Page (unchanged)

| Current Feature                                           | Proposed Location | Notes     |
| --------------------------------------------------------- | ----------------- | --------- |
| KB card grid (3-col)                                      | Same              | No change |
| Metric cards (Total KBs, Active, Total Docs, Failed Docs) | Same              | No change |
| Search bar + sort/status filters                          | Same              | No change |
| [+ New Knowledge Base] button                             | Same              | No change |
| CreateKnowledgeBaseDialog                                 | Same              | No change |
| Pagination                                                | Same              | No change |

### KB Header → Contextual Sidebar Header

| Current Feature                                   | Proposed Location                                           | Notes                                                   |
| ------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| Back arrow                                        | Sidebar: ← Knowledge Bases                                  | Back button navigates to KB list page                   |
| KB Name                                           | Sidebar: top of contextual sidebar                          | Persistent, always visible                              |
| Inline metrics (Sources/Docs/Chunks/Last indexed) | Sidebar: summary line under KB name + count badges on items | Distributed: summary at top, per-item counts in sidebar |
| Status badge                                      | Sidebar: summary line (Active/Indexing/Error)               | Same                                                    |
| [Preview SDK] button                              | Settings > API & SDK                                        | Accessible from Settings page                           |
| Settings gear icon                                | Sidebar: Settings item (below separator)                    | Real page, not a slide-over                             |
| DiscoveryActivityBar                              | Overview page                                               | Shown when background crawls are active                 |

### Home Tab → Overview Page

| Current Feature                          | Proposed Location                       | Notes                                                      |
| ---------------------------------------- | --------------------------------------- | ---------------------------------------------------------- |
| SetupGuide (0 docs state)                | Overview > conditional setup wizard     | Shown as a callout when 0 documents                        |
| FileDropZone                             | Overview > Quick Actions > Upload Files | Same functionality                                         |
| [Connect a Data Source]                  | Overview > Quick Actions > Add Source   | Same functionality                                         |
| LLM status banner                        | Overview > pipeline status card         | Integrated                                                 |
| PipelineProgressTracker (indexing state) | Overview > pipeline status card         | Shows progress inline                                      |
| OperationsDashboard stats                | Overview > stats row                    | Same data, cleaner layout                                  |
| NeedsAttentionCard                       | Overview > needs attention section      | Promoted to be more visible                                |
| ActivityFeed                             | Overview > recent activity              | Same                                                       |
| Your Sources section                     | Removed from Overview; use Sources page | Reduces redundancy -- Sources is one click away in sidebar |

### Data Tab > Sources → Sources Page

| Current Feature                                | Proposed Location                        | Notes                             |
| ---------------------------------------------- | ---------------------------------------- | --------------------------------- |
| Sources sub-tab                                | Sources page (dedicated full-width page) | Promoted from sub-tab to own page |
| Health summary bar                             | Sources > health indicators              | Same                              |
| Search + Group By + View toggle (Card/Table)   | Sources > toolbar                        | Same                              |
| Status filter pills                            | Sources > toolbar filters                | Same                              |
| [+ Add Source] button                          | Sources > header                         | Same                              |
| ConnectorCatalog (88 connectors)               | Same dialog                              | No change to catalog              |
| Per-source actions (Upload, View Docs, Delete) | Same (context menu or inline)            | Same                              |
| Bulk actions (Pause/Resume/Sync/Delete)        | Same                                     | Same                              |
| SourceDetailPanel (slide-over)                 | Same                                     | Same                              |
| SharePointDetailPanel (slide-over)             | Same                                     | Same                              |
| ConnectorDetailPanel (slide-over)              | Same                                     | Same                              |

### Data Tab > Documents → Documents Page

| Current Feature                                              | Proposed Location                             | Notes                             |
| ------------------------------------------------------------ | --------------------------------------------- | --------------------------------- |
| Documents sub-tab                                            | Documents page (dedicated full-width page)    | Promoted from sub-tab to own page |
| Source filter bar                                            | Documents > source filter (dropdown or pills) | Same filtering, new placement     |
| Status filter badges                                         | Documents > toolbar                           | Same                              |
| Search documents                                             | Documents > search bar                        | Same                              |
| Paginated table (title, type, size, status, source, created) | Same                                          | Same                              |
| Bulk actions (Reprocess/Delete)                              | Same                                          | Same                              |
| Click → CrawledPageViewer                                    | Same                                          | Same                              |
| PipelineStatusTooltip                                        | Same                                          | Same                              |

### Data Tab > Chunks → Documents Page (per-document expand)

| Current Feature                             | Proposed Location                   | Notes                                   |
| ------------------------------------------- | ----------------------------------- | --------------------------------------- |
| Chunks sub-tab (global view)                | Documents > expand document row     | Chunks accessed by expanding a document |
| Document-grouped accordion                  | Same pattern, within Documents page | Click/expand document → see its chunks  |
| Per-document search                         | Same                                | Same                                    |
| Token stats (total, avg, smallest, largest) | Same, shown in document expand      | Same                                    |
| Chunk content + metadata viewer             | Same                                | Same                                    |
| Sort by date/chunks/name                    | Documents > sort options            | Same                                    |

### Intelligence Tab > Overview → Removed

| Current Feature                  | Proposed Location | Notes                                                                                                     |
| -------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| IntelligenceHub (5 status cards) | **Removed**       | Redundant. Status visible via sidebar count badges + Overview page stats. Each page shows its own status. |

### Intelligence Tab > Pipeline → Pipeline Page

| Current Feature                | Proposed Location                              | Notes                            |
| ------------------------------ | ---------------------------------------------- | -------------------------------- |
| PipelineEditorV2 (full canvas) | Pipeline > [Open Editor] → full-screen overlay | Full canvas preserved            |
| Pipeline selector              | Same (in editor)                               | Same                             |
| Save/Deploy toolbar            | Pipeline page + inside editor                  | Save/Deploy accessible from both |
| Stage configuration side panel | Same (in editor)                               | Same                             |
| Embedding fields drawer        | Same (in editor)                               | Same                             |
| Rule builder panel             | Same (in editor)                               | Same                             |
| Unsaved indicator              | Same (in editor)                               | Same                             |
| Create/Delete pipeline         | Same (in editor)                               | Same                             |
| All node types and configs     | Same (in editor)                               | No functionality removed         |

### Intelligence Tab > Fields → Fields Page

| Current Feature              | Proposed Location                      | Notes        |
| ---------------------------- | -------------------------------------- | ------------ |
| My Fields sub-tab            | Fields > My Fields (inline tab/filter) | Default view |
| Suggested sub-tab            | Fields > Suggested (inline tab/filter) | Same         |
| Unmapped sub-tab             | Fields > Unmapped (inline tab/filter)  | Same         |
| Per-field edit/toggle/delete | Same                                   | Same         |
| [+ Add Field]                | Same                                   | Same         |
| Bulk confirm/reject          | Same                                   | Same         |

### Intelligence Tab > Vocabulary → Vocabulary Page

| Current Feature              | Proposed Location               | Notes                        |
| ---------------------------- | ------------------------------- | ---------------------------- |
| Vocabulary entries table     | Vocabulary page                 | Full-width dedicated page    |
| Search + filter              | Same                            | Same                         |
| [+ Add Entry]                | Same                            | Same                         |
| Per-entry edit/delete/toggle | Same                            | Same                         |
| [Test Resolution] button     | **Moved to Search & Test page** | Testing belongs with testing |
| VocabularyReviewDialog       | Same                            | Same                         |

### Intelligence Tab > Knowledge Graph → Knowledge Graph Page

| Current Feature           | Proposed Location                           | Notes                                    |
| ------------------------- | ------------------------------------------- | ---------------------------------------- |
| KG onboarding states      | Knowledge Graph page (inline)               | No separate states -- progressive inline |
| Taxonomy summary card     | Same                                        | Same                                     |
| [Run Enrichment]          | Same                                        | Same                                     |
| [Delete Taxonomy]         | Same (3-dot menu)                           | Same                                     |
| Graph View (force graph)  | Same (full-width, benefits from more space) | Same visualization, more room            |
| Statistics View           | Same (inline toggle)                        | Same                                     |
| Attributes View + manager | Same (inline toggle)                        | Same                                     |
| AttributeDetailPanel      | Same                                        | Same                                     |
| AttributeMergeDialog      | Same                                        | Same                                     |
| Edge type toggles         | Same                                        | Same                                     |
| Entity limit selector     | Same                                        | Same                                     |

### Intelligence Tab > LLM Models → Distributed Across Pages

| Current Feature                                | Proposed Location                       | Notes                                     |
| ---------------------------------------------- | --------------------------------------- | ----------------------------------------- |
| Tenant models summary                          | Settings > Model Usage                  | Read-only summary moved to Settings       |
| [Configure Models] (links to project settings) | Settings > Model Usage                  | Same link                                 |
| EmbeddingModelSection                          | Pipeline page > Embedding Model section | Embedding is a processing concern         |
| KG Extraction toggle + model                   | Knowledge Graph page                    | Configure KG and its model together       |
| Field Mapping Suggestions toggle + model       | Fields page                             | Configure fields and their model together |
| Domain Vocabulary Generation toggle + model    | Vocabulary page                         | Configure vocab and its model together    |
| Vision Analysis toggle + model                 | Pipeline page > Vision section          | Vision is a processing stage              |
| Multimodal Deep Analysis toggle + model        | Pipeline page > Vision section          | Same                                      |
| Query Pipeline LLM config                      | Search & Test page                      | Query LLM powers search features          |
| ModelSelectorDialog                            | Same (available from each page)         | Same                                      |
| EmbeddingModelDialog                           | Same (available from Pipeline page)     | Same                                      |
| Pending features alert                         | Overview page                           | Visible on dashboard                      |

### Search & Test Tab → Search & Test Page

| Current Feature                                       | Proposed Location                       | Notes                        |
| ----------------------------------------------------- | --------------------------------------- | ---------------------------- |
| LLM awareness banner                                  | Search & Test page                      | Same                         |
| Query playground                                      | Same                                    | Same                         |
| Query type selector (semantic/structured/hybrid)      | Same                                    | Same                         |
| TopK selector                                         | Same                                    | Same                         |
| [Search] + [Resolve Vocabulary]                       | Same                                    | Same                         |
| Results with scores                                   | Same                                    | Same                         |
| Latency breakdown bar                                 | Same                                    | Same                         |
| [Copy API Call] + [Copy as cURL]                      | Same                                    | Same                         |
| QueryDiagnosticCard (3 sections)                      | Same                                    | Same                         |
| Pipeline Debug + ResolutionChain                      | Same                                    | Same                         |
| Query History + Compare                               | Same                                    | Same                         |
| **Moved here**: Vocabulary Test (from Vocabulary tab) | Search & Test > Vocabulary Test section | Testing belongs with testing |
| **Moved here**: Query LLM config (from LLM Models)    | Search & Test > Query LLM section       | Configure and test together  |

### Settings Panel (slide-over) → Settings Page

| Current Feature                               | Proposed Location                            | Notes                                         |
| --------------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| General: Name (editable)                      | Settings > General                           | Same                                          |
| General: Description (editable)               | Settings > General                           | Same                                          |
| General: Status (read-only)                   | Settings > General                           | Same                                          |
| General: Search Index ID (read-only)          | Settings > Index Info                        | Grouped with index details                    |
| General: Created (read-only)                  | Settings > General                           | Same                                          |
| Index Config: Embedding Model (read-only)     | Settings > Index Info                        | Read-only reference (config on Pipeline page) |
| Index Config: Dimensions (read-only)          | Settings > Index Info                        | Same                                          |
| Index Config: Vector Store (read-only)        | Settings > Index Info                        | Same                                          |
| Index Config: Top K (editable)                | Search & Test page (search tuning parameter) | Moved to where it's tested                    |
| Index Config: Similarity Threshold (editable) | Search & Test page (search tuning parameter) | Moved to where it's tested                    |
| Danger Zone: Rebuild Index                    | Settings > Danger Zone                       | Same                                          |
| Danger Zone: Delete KB                        | Settings > Danger Zone                       | Same                                          |
| **New**: Model Usage summary                  | Settings > Model Usage                       | Read-only view of all models across KB        |
| **New**: API & SDK                            | Settings > API & SDK                         | Preview SDK link, API snippets                |

### Browse Preview (standalone page)

| Current Feature                  | Proposed Location | Notes                    |
| -------------------------------- | ----------------- | ------------------------ |
| BrowsePreviewPage (separate tab) | Same (no change)  | Opens in new browser tab |
| Browse-first mode                | Same              | Same                     |
| Search-first mode                | Same              | Same                     |
| Taxonomy tree + facets           | Same              | Same                     |
| Document results grid            | Same              | Same                     |

### Crawl Flow (Web Source Discovery)

| Current Feature                          | Proposed Location | Notes                                         |
| ---------------------------------------- | ----------------- | --------------------------------------------- |
| CrawlFlowV5 (multi-step wizard)          | Same (no change)  | Launched from Add Source flow on Sources page |
| URL entry → Analysis → Configure → Crawl | Same              | Same                                          |
| DiscoveryActivityBar                     | Overview page     | Shown when active                             |

### SharePoint Connector

| Current Feature                        | Proposed Location | Notes                                    |
| -------------------------------------- | ----------------- | ---------------------------------------- |
| SharePointDetailPanel (all tabs)       | Same (no change)  | All 7 setup + 5 monitoring tabs retained |
| Multi-connector, export, purge dialogs | Same              | Same                                     |

---

## Summary of Net Changes

### Navigation Pattern Change

- **Current**: Horizontal tabs (Home/Data/Intelligence/Search & Test) with sub-tabs and sub-sub-tabs
- **Proposed**: Dual-sidebar with contextual KB navigation (matching Agent detail pattern)

### Removed (0 features removed)

- **No features are removed.** Every action, dialog, panel, and configuration option is preserved.
- **IntelligenceHub** (overview cards) eliminated as redundant -- status visible via sidebar badges

### Consolidated

- Home tab 3-state machine → unified Overview page with conditional elements
- Settings slide-over → Settings page (real sidebar item)
- "LLM Models" grab-bag → distributed to the pages each model powers
- Chunks global view → per-document expand on Documents page

### Moved

- Vocabulary Test → Search & Test page
- Top K / Similarity Threshold → Search & Test page (test where you tune)
- Query LLM config → Search & Test page
- Embedding model config → Pipeline page
- KG extraction model → Knowledge Graph page
- Field mapping model → Fields page
- Vocab generation model → Vocabulary page
- SDK Preview → Settings > API & SDK

### Navigation Target Count

- **Current**: 4 main tabs + 6 sub-tabs + 3 sub-sub-tabs = **13 navigation targets** across 3 depth levels
- **Proposed**: 9 sidebar items + 0 sub-navigation = **9 navigation targets** at **1 depth level**
- Every item is visible at a glance in the sidebar -- no hidden sub-tabs to discover

### Alignment with Platform Norms

- Navigation pattern: **matches Agent detail** (dual-sidebar with sections)
- Max navigation depth: 3 → **1** (flat sidebar, best in the platform)
- Section structure: 4 sections + 2 standalone + 1 separator (Agent has 5 sections, Settings has 5 sections)
- Items per section: consistently 2 (Agent ranges 2-4, Settings ranges 1-6)
- Count badges: matches Agent pattern (Tools: 1, Flow Steps: 5)
- Back button: navigates to KB list (like Agent back → Agent list)
