# KB Navigation Redesign — High-Level Design (v4)

**Date**: 2026-03-17
**Status**: Pending Approval
**Wireframes**: `docs/design/wireframes/kb-enterprise-wireframes.html` (agreed)
**Design Docs**: `docs/design/UX-KB-NAVIGATION-FRESH-DESIGN.md` + R1/R2 comments
**Exploration Findings**: `.claude/agent-memory-local/architect/kb-wireframe-exploration-findings.md`

---

## What

Redesign the Knowledge Base experience in Studio from a flat 10-tab layout to a **4-nav architecture** (Home, Data, Intelligence, Search & Test) based on the agreed wireframes. This is a **full-stack** effort — the wireframes define capabilities that require backend API work, bug fixes, and frontend restructuring.

The redesign solves four verified problems:

1. **"Where do I start?"** — New KB shows all 10 tabs with zero data, no onboarding
2. **"Why isn't search working?"** — Zero diagnostic capability in playground
3. **"Related things are far apart"** — Connectors/Crawler/Documents split across 3 tabs
4. **"Doesn't scale"** — DocumentsTab loads ALL docs, FieldsTab loads ALL mappings, no pagination UI

12 code-verified explorations uncovered **14 bugs** and **16 backend API gaps** that inform the phasing.

---

## Architecture Approach

### Packages That Change

| Package                  | Nature of Change                                              |
| ------------------------ | ------------------------------------------------------------- |
| `apps/studio`            | Primary — navigation store, layout, pages, section components |
| `apps/search-ai`         | Backend — new/enhanced API endpoints, bug fixes               |
| `apps/search-ai-runtime` | Backend — resolution chain debug trace (query pipeline)       |
| `packages/database`      | Model changes — `createdBy` on KB, text index on source       |

### Data Flow

```
URL: /projects/:projectId/search-ai/:kbId/:section/:subSection
                                              │           │
                                              ▼           ▼
                                    ┌─────────────────────────┐
                                    │   navigation-store.ts    │
                                    │   parseUrl() extended    │
                                    │   (section + subSection) │
                                    └────────┬────────────────┘
                                             │
                                             ▼
                                    ┌─────────────────────────┐
                                    │  KBDetailLayout (NEW)    │
                                    │  persistent header +     │
                                    │  4-nav + content router  │
                                    └────────┬────────────────┘
                                             │
                        ┌────────────┬───────┴───────┬──────────────┐
                        ▼            ▼               ▼              ▼
                   ┌─────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────┐
                   │  Home   │ │   Data   │ │ Intelligence │ │ Search & │
                   │ adaptive│ │ filter + │ │  hub → sub-  │ │   Test   │
                   │ 3-state │ │ paginate │ │  route drill │ │          │
                   └─────────┘ └──────────┘ └──────┬───────┘ └──────────┘
                                                   │
                                    ┌──────┬───────┼───────┬──────────┐
                                    ▼      ▼       ▼       ▼          ▼
                                Pipeline Fields  Vocab    KG      LLM Models
```

### Backend API Changes

```
search-ai/src/routes/
  ├── knowledge-bases.ts   ── Add: search, status, sort, pagination params
  ├── sources.ts           ── Add: pagination, search, type filter, summary endpoint
  ├── documents.ts         ── (already paginated, add compound status aggregation)
  ├── chunks.ts            ── Add: status filter param
  ├── indexes.ts           ── FIX: LLM config static routes BEFORE parameterized
  └── health-summary.ts    ── NEW: KB-level health aggregation

search-ai-runtime/src/services/query/
  └── query-pipeline.ts    ── Extend executeUnified to populate debug trace

packages/database/src/models/
  ├── knowledge-base.model.ts  ── Add: createdBy field
  └── search-source.model.ts   ── Add: text index on name
```

---

## Capability Inventory (Exploration-Verified)

### Tier 1: Ready Now — Frontend Only

| #    | Capability                                      | Backend Evidence (Code-Verified)                                                                                   | Notes                                                                                              |
| ---- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| C-1  | 4-nav structure (Home/Data/Intelligence/Search) | N/A — pure frontend routing                                                                                        | navigation-store.ts needs section/subSection parsing                                               |
| C-2  | Persistent header with inline metrics           | `useKnowledgeBase` returns KB + index with `documentCount`, `chunkCount`, `sourceCount`, `lastIndexedAt`, `status` | Verified in hooks                                                                                  |
| C-3  | Document table with server-side pagination      | `GET /:indexId/documents` supports `limit`, `offset`, `sourceId`, `status`, `search`                               | ✅ Backend ready, frontend needs pagination UI (currently none)                                    |
| C-4  | Field mappings display                          | `GET /mappings` supports `limit`, `skip`, `schemaId`, `connectorId`, `status`                                      | ✅ Backend paginated                                                                               |
| C-5  | Intelligence Hub — Pipeline stats               | Pipeline store + `GET /pipelines` returns flows, published state                                                   | ⚠ Pipeline store `reset()` on unmount destroys state (E-3)                                         |
| C-6  | Intelligence Hub — Fields stats                 | `GET /mappings/tab-stats` returns counts                                                                           | ✅                                                                                                 |
| C-7  | Intelligence Hub — KG stats                     | `GET /kg-enrich/stats` + `GET /kg-configuration-status`                                                            | ✅ Self-contained, needs only indexId (E-4)                                                        |
| C-8  | Intelligence Hub — Vocabulary stats             | Vocabulary API returns all entries with counts                                                                     | ✅                                                                                                 |
| C-9  | Intelligence Hub — LLM config card              | `GET /:indexId/llm-config` + use-cases/tiers endpoints                                                             | ⚠ Route ordering bug: static routes after parameterized (E-8)                                      |
| C-10 | Intelligence drill-down sub-routes              | Wraps existing FieldsTab, VocabularyTab, PipelineEditor, KGTab                                                     | Wrap don't rewrite — all verified self-contained (E-4, E-5)                                        |
| C-11 | Intelligence persistent sub-nav tabs            | N/A — Atlassian pattern per R2 feedback                                                                            | Direct jump between sibling sections                                                               |
| C-12 | Settings → gear icon SlidePanel                 | Relocates existing SettingsTab content                                                                             |                                                                                                    |
| C-13 | Search playground (existing)                    | `POST /:indexId/query` works                                                                                       | ⚠ `debug=true` is a NO-OP — never consumed by executeUnified (E-1). Resolution chain requires C-31 |
| C-14 | Document detail drawer — chunk listing          | `GET /indexes/:id/documents/:docId/chunks` exists (paginated)                                                      | ⚠ No document detail view exists — CrawledPageViewer is dead code (E-9)                            |
| C-15 | Single document retry                           | `POST /admin/errors/:docId/retry` exists                                                                           | ✅                                                                                                 |
| C-16 | Pipeline re-trigger (single doc)                | `POST /knowledge-bases/:kbId/documents/:docId/trigger-pipeline`                                                    | ✅                                                                                                 |
| C-17 | Pipeline re-trigger (bulk per source)           | Max 100 batch exists                                                                                               | ✅                                                                                                 |
| C-18 | Source type badges as filter                    | Sources return `sourceType` + `documentCount`                                                                      | Per R2: replaces sidebar with filter badges + dropdown                                             |
| C-19 | LLM circuit breaker status                      | `GET /mappings/circuit-status` exists                                                                              | ✅                                                                                                 |
| C-20 | Compound document status display                | `SearchDocument.status` + `SearchChunk.status` fields exist                                                        | Client-side join, or use C-30 endpoint                                                             |
| C-21 | Crawler sub-nav (Jobs/Pages/Prefs)              | Existing CrawlerTab + crawl APIs                                                                                   | ⚠ Auto-creates web source on mount (E-12)                                                          |
| C-22 | Enrichment → Search feedback toasts             | N/A — pure frontend                                                                                                |                                                                                                    |

### Tier 2: Small Backend Work (< 1 day each)

| #    | Capability                                  | What Exists                                    | What's Needed                                              |
| ---- | ------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| C-23 | KB list search + filter + sort + pagination | `GET /knowledge-bases` returns all, no filters | Add `search`, `status`, `sortBy`, `limit`, `offset` params |
| C-24 | Source pagination + search                  | `GET /:indexId/sources` returns all            | Add `limit`, `offset`, `search`, `sourceType` params       |
| C-25 | Source summary counts by type               | Source data has `sourceType` field             | New `GET /:indexId/sources/summary` endpoint               |
| C-26 | Chunk status filter                         | Chunks endpoint exists                         | Add `?status=error` param                                  |
| C-27 | KB `createdBy` field                        | Model has no `createdBy`                       | Add field, store `req.userId`, add filter                  |
| C-28 | Text index on source name                   | No text index                                  | Add text index on `SearchSource.name`                      |
| C-29 | Bulk retry failed documents                 | Single retry exists                            | Combine retry + enqueue for array of docIds                |
| C-30 | Compound document status endpoint           | Doc + chunk status fields exist                | Aggregation query joining doc status + chunk error counts  |

### Tier 3: Medium Backend Work (1-3 days each)

| #    | Capability                        | What Exists                                                                                                                             | What's Needed                                                                                             |
| ---- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| C-31 | Search Resolution Chain (7-stage) | `debug=true` NO-OP (E-1). All intermediate data discarded. `UnifiedSearchLatency` extended fields never set.                            | Must capture + return intermediate results from each pipeline stage. New `debugTrace` object on response. |
| C-32 | Health Summary                    | Source `syncState` + pipeline `validationErrors` + circuit breaker exist separately                                                     | Compose into single `GET /:kbId/health-summary` endpoint                                                  |
| C-33 | Query History (server-persisted)  | ClickHouse `search_queries` table exists BUT `ClickHouseSearchQueryStore` is DEAD CODE — never instantiated (E-2). Table will be EMPTY. | Wire up write path, build REST read endpoint                                                              |
| C-34 | Vocabulary match rate aggregate   | Per-entry data exists                                                                                                                   | ClickHouse aggregate query                                                                                |
| C-35 | Connector sync history            | CrawlJob model exists for web crawler only                                                                                              | New `ConnectorSyncHistory` model for non-crawler connectors                                               |
| C-36 | Chunk-level retry/re-embed        | No per-chunk retry                                                                                                                      | New endpoint                                                                                              |

### Tier 4: Large Backend Work (3+ days)

| #    | Capability              | What's Needed                                                                                                                               |
| ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| C-37 | Activity Feed (unified) | Two audit systems exist: `audit-helpers.ts` (fire-and-forget) + `audit-logger.ts` (structured with query functions). Unify + REST endpoint. |

### Descoped

| #    | Capability                                 | Reason                                                                |
| ---- | ------------------------------------------ | --------------------------------------------------------------------- |
| DS-1 | Cmd+K command palette                      | Per R2 — project-level feature, not KB-scoped                         |
| DS-2 | Enterprise chrome (top bar, notifications) | Separate initiative                                                   |
| DS-3 | WCAG contrast fixes                        | Design token changes tracked separately                               |
| DS-4 | Emoji → Lucide icon replacement            | Incremental, not blocking                                             |
| DS-5 | Source sidebar                             | Per R2 — doesn't scale to 10K. Replaced with filter badges + dropdown |
| DS-6 | Light mode refinements                     | Existing theme tokens work; CSS variables respected                   |

---

## Bugs to Fix (Discovered During Exploration)

These bugs will be addressed within the relevant task phases:

### Critical (Fix in Phase 1)

| #    | Bug                                                        | File                              | Impact                               | Fix In             |
| ---- | ---------------------------------------------------------- | --------------------------------- | ------------------------------------ | ------------------ |
| B-1  | Role case mismatch → ALL users get empty permissions       | `auth.ts:37-91`                   | All KB operations bypass permissions | T-0 (prerequisite) |
| B-14 | Back button navigates to `/search` instead of `/search-ai` | `KnowledgeBaseDetailPage.tsx:112` | Lands on wrong page                  | T-8                |

### High (Fix in Phase 1-2)

| #   | Bug                                                                                    | File                                                          | Impact                                     | Fix In |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------ | ------ |
| B-3 | Embedding model mismatch (index: text-embedding-3-small/1536d, pipeline: bge-m3/1024d) | `knowledge-bases.ts:101` vs `default-pipeline-template.ts:38` | New KBs get inconsistent embedding config  | T-0    |
| B-4 | Express route ordering: LLM config static routes after parameterized                   | `indexes.ts:567,602 after :246`                               | Static routes captured by `:indexId` param | T-0    |

### Medium (Fix opportunistically)

| #   | Bug                                                                     | File                               | Fix In |
| --- | ----------------------------------------------------------------------- | ---------------------------------- | ------ |
| B-5 | FieldsTab silently swallows SWR errors                                  | `FieldsTab.tsx:127`                | T-3    |
| B-6 | `mapping_suggestion`/`vocabularyGeneration` missing from Zod validation | `index-schemas.ts:225-239`         | T-0    |
| B-7 | `treeBuilder` missing from LLM defaults/metadata                        | `defaults.ts`, `metadata.ts`       | T-0    |
| B-8 | `ClickHouseSearchQueryStore` never instantiated                         | `clickhouse-search-query-store.ts` | T-22   |
| B-9 | Double LLM call in vocabulary resolution                                | `query-pipeline.ts:970-988`        | T-21   |

### Low (Track, fix when touching files)

| #    | Bug                                                  | File                           |
| ---- | ---------------------------------------------------- | ------------------------------ |
| B-10 | Frontend claims JSON upload support, backend rejects | `DocumentsTab.tsx:431`         |
| B-11 | No actual drag-and-drop despite UI text              | `DocumentsTab.tsx:429`         |
| B-12 | CrawledPageViewer is dead code                       | `viewer/CrawledPageViewer.tsx` |
| B-13 | optimisticKGEnabled never resets                     | `KnowledgeGraphTab.tsx:63`     |

---

## Decisions & Tradeoffs

| #    | Decision                                | Chose                                  | Over                                     | Because                                                                                                                                                    |
| ---- | --------------------------------------- | -------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | New KBDetailLayout                      | New component                          | Extending DetailPageShell                | DetailPageShell enforces max-width and single-level tabs. New layout needs full-width Data tab, persistent header with metrics, and nested sub-navigation. |
| D-2  | Phased full-stack delivery              | 5 phases by capability tier            | Frontend-only then backend               | Vertical slices. Each phase ships working features, not placeholders.                                                                                      |
| D-3  | Reuse existing tab components           | Wrap in sub-route containers           | Rewrite                                  | FieldsTab (1517 lines), KGTab (738 lines), PipelineEditor (240 + store) are complex and working. Wrapping is safer. Verified self-contained in E-4, E-5.   |
| D-4  | URL: section/subSection paths           | `/search-ai/:kbId/intelligence/fields` | Query params `?tab=...&sub=...`          | Path segments work with browser back/forward, bookmarkable, align with navigation-store pattern.                                                           |
| D-5  | Settings as SlidePanel                  | Gear icon → SlidePanel                 | Dedicated route                          | Settings rarely used after initial config. SlidePanel accessible without primary nav slot.                                                                 |
| D-6  | Source sidebar removed                  | Filter badges + dropdown               | Left sidebar                             | Per R2 — doesn't scale to 10K. Doc table gets full width. Sources are a filter dimension.                                                                  |
| D-7  | Intelligence sub-nav tabs               | Persistent horizontal tabs             | Back-to-hub-only                         | Per R2 — Atlassian pattern. Jump between Fields/Vocab/Pipeline/KG directly.                                                                                |
| D-8  | Crawler merged into Data                | Part of source management              | Separate tab                             | Web Crawler is just another data source type. CrawlerTab auto-creates source on mount.                                                                     |
| D-9  | Health-summary as composed endpoint     | Single aggregation endpoint            | Multiple client-side fetches             | Dual-DB architecture — client can't join across abl_platform + searchaicontent.                                                                            |
| D-10 | Activity feed deferred to Phase 3       | Use existing audit-logger queries      | Build new event system                   | `audit-logger.ts` already has `getRecentAuditLogs()`. Wire to REST first.                                                                                  |
| D-11 | Revive CrawledPageViewer for doc detail | Use existing dead code                 | Build from scratch                       | Fully built slide-out panel with tabs (Extracted/Original/Side-by-Side/Metadata) exists but is never imported (E-9).                                       |
| D-12 | Pipeline store persistence              | Add `useBlocker` nav guard             | `persist` middleware or remove `reset()` | Navigation guard warns on dirty state. Simpler than persisting Zustand to sessionStorage. Keeps reset on intentional unmount.                              |
| D-13 | Monochrome palette                      | Semantic color only for status         | Bright accent colors                     | Per R2 — matches Kore.ai brand. Only status indicators use color.                                                                                          |
| D-14 | Parallel waves (backend ∥ frontend)     | 4 concurrent waves                     | Serial phases                            | Studio and search-ai have zero file overlap. Running them in parallel halves elapsed time.                                                                 |

---

## Task Decomposition — Parallel Waves

### Execution Model

Frontend (`apps/studio`) and backend (`apps/search-ai`, `apps/search-ai-runtime`, `packages/database`) touch **zero overlapping files**. They run as parallel streams within each wave. Within each stream, independent tasks run as parallel implementers.

```
                    BACKEND STREAM                    FRONTEND STREAM
                    ══════════════                    ═══════════════
Wave 1:   T-0  (bug fixes)                ║   T-1 (nav store) + T-2 (layout+rewire)
          search-ai, database             ║   studio store + components
          ─────────────────────────────────╬───────────────────────────────────────
Wave 2:   T-10, T-11, T-12, T-13,        ║   T-3 (intelligence hub+sub-routes)
          T-14, T-15                      ║   T-4 (data section+add source+crawler)
          (6 backend tasks, all parallel) ║   T-5 (search+diagnostic+copy)
                                          ║   T-6 (home adaptive 3-state)
                                          ║   T-7 (settings slide-panel)
                                          ║   (5 frontend tasks, all parallel)
          ─────────────────────────────────╬───────────────────────────────────────
Wave 3:   T-19, T-20, T-21, T-22         ║   T-8 (tests for Wave 1-2 frontend)
          (4 backend tasks, all parallel) ║   T-16 (KB list UI)
                                          ║   T-17 (source badges UI)
                                          ║   T-18 (doc detail drawer)
          ─────────────────────────────────╬───────────────────────────────────────
Wave 4:                                   ║   T-23 (needs attention UI)
                                          ║   T-24 (activity feed UI)
                                          ║   T-25 (resolution chain UI)
                                          ║   T-26 (query history UI)
                                          ║   T-27 (keyboard shortcuts)
                                          ║   T-28 (feedback toasts)
                                          ║   T-29 (bulk actions)
                                          ║   (all parallel, all independent)
```

---

### Wave 1: Foundation (Backend Bug Fixes ∥ Frontend Skeleton)

**Backend stream:**

| Task | Package             | Independent? | Est. Files | Description                                                                                                       |
| ---- | ------------------- | ------------ | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| T-0  | search-ai, database | Yes          | 4-5        | B-1 (role case mismatch), B-3 (embedding mismatch), B-4 (route ordering), B-6 (Zod validation), B-7 (treeBuilder) |

**Frontend stream:**

| Task | Package         | Independent? | Est. Files | Description                                                                                                                                                                     |
| ---- | --------------- | ------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-1  | studio (store)  | Yes          | 2-3        | Navigation store: extend `parseUrl()` for section/subSection, add `setSection()` + `setSubSection()` helpers, `popstate` listener                                               |
| T-2  | studio (layout) | Yes          | 4-5        | KBDetailLayout: persistent header (C-2) + 4-nav tabs (C-1) + section content router + rewire KnowledgeBaseDetailPage.tsx + fix B-14 (back nav bug). **Merges old T-2 and T-8.** |

T-1 and T-2 run in parallel (store files vs component files — zero overlap).

---

### Wave 2: Section Shells + Backend APIs

All 5 frontend tasks touch **different component directories** — zero file overlap, all parallel.
All 6 backend tasks touch **different route files** — zero file overlap, all parallel.
Backend and frontend streams run concurrently.

**Backend stream (Tier 2 APIs):**

| Task | Package                       | Independent? | Est. Files | Description                                                            |
| ---- | ----------------------------- | ------------ | ---------- | ---------------------------------------------------------------------- |
| T-10 | search-ai (routes)            | Yes          | 2-3        | KB list: search + status + sort + pagination (C-23)                    |
| T-11 | search-ai (routes) + database | Yes          | 2-3        | Source: pagination + search + type filter + summary (C-24, C-25, C-28) |
| T-12 | search-ai (routes)            | Yes          | 1          | Chunk status filter param (C-26)                                       |
| T-13 | database + search-ai          | Yes          | 2          | KB `createdBy` field + store on creation + auto-navigate (C-27)        |
| T-14 | search-ai (routes)            | Yes          | 1-2        | Bulk retry failed documents (C-29)                                     |
| T-15 | search-ai (routes)            | Yes          | 2-3        | Compound document status aggregation (C-30)                            |

**Frontend stream (Section Shells — all depend on T-1+T-2 from Wave 1):**

| Task | Package               | Independent?  | Est. Files | Description                                                                                                                                                                                                                                                                       |
| ---- | --------------------- | ------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-3  | studio (intelligence) | Yes (of T-4+) | 6-8        | **Intelligence Hub + 5 sub-routes + persistent sub-nav.** Hub: 5 adaptive-state cards (not-configured/healthy/needs-attention/error state machine per card). Sub-routes: Pipeline, Fields, Vocabulary, KG, LLM Models. Sub-nav: Atlassian-pattern tabs (C-5–C-11, C-19). Fix B-5. |
| T-4  | studio (data)         | Yes (of T-3+) | 5-6        | **Data section.** Source filter badges + dropdown (C-18), paginated doc table (C-3, C-20), +Add Source button triggering existing ConnectorsTab add dialog + EnterpriseConnectorWizard, crawler source detail with sub-nav + auto-create guard (D-8, E-12), compound status UI.   |
| T-5  | studio (search)       | Yes (of T-3+) | 4-5        | **Search & Test section.** Wrap existing playground (C-13). Add: Query Diagnostic card (3-category: Data & Indexing / Enrichment / Pipeline Health with action links). Copy API Call + Copy as cURL. Test Vocabulary dry-run button. Score breakdown placeholder (needs C-31).    |
| T-6  | studio (home)         | Yes (of T-3+) | 5-6        | **Home adaptive 3-state.** State 1: setup guide with real drag-and-drop upload zone (fix B-11) + LLM status banner + "what happens automatically" checklist. State 2: progress polling via SWR for non-crawl docs + checklist transitions. State 3: operations dashboard shell.   |
| T-7  | studio (settings)     | Yes (of T-3+) | 2-3        | **Settings SlidePanel.** Gear icon trigger (C-12). Contains: General (name, description, visibility, createdBy). Index Config (embedding, vector store, search params). Danger Zone: Rebuild Index + Delete KB with confirmation dialogs.                                         |

---

### Wave 3: Tier 3 Backend + Tier 2 Frontend Consumers

Backend Tier 3 starts immediately after Wave 2 backend completes.
Frontend consumes Wave 2 backend APIs + writes tests for Wave 1-2 frontend.

**Backend stream (Tier 3 APIs):**

| Task | Package                       | Independent? | Est. Files | Description                                                                                                                           |
| ---- | ----------------------------- | ------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| T-19 | search-ai (routes)            | Yes          | 3-4        | Health-summary endpoint: aggregate source syncState + pipeline validationErrors + circuit breaker across subsystems (C-32)            |
| T-20 | search-ai (routes)            | Yes          | 2-3        | Activity feed: expose audit-logger queries as REST endpoint (C-37 partial)                                                            |
| T-21 | search-ai-runtime             | Yes          | 5-7        | Resolution Chain: capture + return intermediate results from all 7 stages in executeUnified. New `debugTrace` object. Fix B-9. (C-31) |
| T-22 | search-ai-runtime + search-ai | Yes          | 3-4        | Query history: wire ClickHouseSearchQueryStore write path (B-8) + REST read endpoint (C-33)                                           |

**Frontend stream (Tier 2 consumers + tests):**

| Task | Package | Independent?         | Est. Files | Description                                                                                                                                                                                                       |
| ---- | ------- | -------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-8  | studio  | Yes                  | 4-6        | **Tests for Wave 1-2 frontend.** Navigation store unit tests, section routing tests, component render tests for all 5 sections, intelligence hub card states, home state transitions.                             |
| T-16 | studio  | No (T-10)            | 2-3        | **KB list page.** Search + status filter + sort dropdown + card layout with inline metrics. Auto-navigate to new KB after creation.                                                                               |
| T-17 | studio  | No (T-4, T-11)       | 1-2        | **Data: source type badges.** Wire summary endpoint counts into filter badges. Source name search using text index.                                                                                               |
| T-18 | studio  | No (T-4, T-14, T-15) | 4-5        | **Document detail drawer.** Revive CrawledPageViewer (D-11) with 4 tabs: Extracted/Original/Side-by-Side/Metadata. Chunk listing with pagination + status filter. Single doc retry + bulk retry. Compound status. |

---

### Wave 4: Tier 3 Frontend + Polish

All tasks are independent — maximum parallelism.

| Task | Package | Independent? | Est. Files | Description                                                                                                                                                                                        |
| ---- | ------- | ------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-23 | studio  | No (T-19)    | 2-3        | **Home mature: Needs Attention.** Health-summary data → issue cards with action links (reconnect, view errors). "All systems healthy" one-liner when clean.                                        |
| T-24 | studio  | No (T-20)    | 1-2        | **Home mature: Activity feed.** Recent events timeline with user attribution and "View →" links.                                                                                                   |
| T-25 | studio  | No (T-21)    | 4-5        | **Resolution Chain 7-stage visualization.** Pipeline trace → visual stages ①–⑦. Score breakdown per result (vector/filter/rerank). Flow attribution. Enrichment impact badges. Coverage indicator. |
| T-26 | studio  | No (T-22)    | 2-3        | **Query history + compare.** Server-persisted history list. Side-by-side compare view for repeated queries.                                                                                        |
| T-27 | studio  | Yes          | 1-2        | Keyboard shortcuts (Alt+1–4, Alt+,)                                                                                                                                                                |
| T-28 | studio  | Yes          | 1-2        | Enrichment → Search feedback loop toasts (C-22) — navigate to Search & Test with pre-filled state                                                                                                  |
| T-29 | studio  | Yes          | 2-3        | Doc table bulk actions — multi-select, reprocess, delete with confirmation                                                                                                                         |

---

### Dependency Graph (Parallel Waves)

```
WAVE 1 ═══════════════════════════════════════════════════════════════════
  Backend:  T-0 (bug fixes)
  Frontend: T-1 (nav store) ∥ T-2 (layout+rewire)
  ── T-0 has zero file overlap with T-1, T-2 → all 3 run in parallel ──

WAVE 2 ═══════════════════════════════════════════════════════════════════
  Backend:  T-10 ∥ T-11 ∥ T-12 ∥ T-13 ∥ T-14 ∥ T-15  (6 parallel)
  Frontend: T-3 ∥ T-4 ∥ T-5 ∥ T-6 ∥ T-7              (5 parallel)
  ── Backend touches search-ai routes, Frontend touches studio ──
  ── Frontend depends on T-1+T-2. Backend depends on T-0. ──

WAVE 3 ═══════════════════════════════════════════════════════════════════
  Backend:  T-19 ∥ T-20 ∥ T-21 ∥ T-22  (4 parallel)
  Frontend: T-8 (tests) ∥ T-16 ∥ T-17 ∥ T-18  (4 parallel)
  ── T-16 needs T-10 (KB list API). T-17 needs T-11 (source API). ──
  ── T-18 needs T-14+T-15 (retry+compound status APIs). ──
  ── T-8 needs all Wave 2 frontend (T-3–T-7). ──

WAVE 4 ═══════════════════════════════════════════════════════════════════
  Frontend: T-23 ∥ T-24 ∥ T-25 ∥ T-26 ∥ T-27 ∥ T-28 ∥ T-29  (7 parallel)
  ── T-23 needs T-19 (health API). T-24 needs T-20 (activity API). ──
  ── T-25 needs T-21 (resolution chain). T-26 needs T-22 (query history). ──
  ── T-27, T-28, T-29 are fully independent. ──
```

**Total task count: 30 tasks (T-0 through T-29)**
**Maximum concurrent implementers per wave: 11 (Wave 2: 6 backend + 5 frontend)**
**Critical path: T-0 → T-1/T-2 → T-3–T-7 → T-8 → T-16–T-18 → T-23–T-29**

---

## Wireframe Completeness Checklist

Every wireframe section (design doc 2.1–2.10) must have a task. This table verifies coverage:

| Wireframe Section       | Feature                                               | Task                           | Status |
| ----------------------- | ----------------------------------------------------- | ------------------------------ | ------ |
| 2.1 Persistent Header   | Inline metrics, status badge, gear icon               | T-2                            | ✅     |
| 2.2 Home State 1        | Setup guide, drag-drop upload zone, LLM status banner | T-6                            | ✅     |
| 2.2 Home State 2        | Progress polling, checklist transitions               | T-6                            | ✅     |
| 2.2 Home State 3        | Needs Attention                                       | T-23 (needs T-19 health API)   | ✅     |
| 2.2 Home State 3        | Suggestions                                           | T-23                           | ✅     |
| 2.2 Home State 3        | Activity feed                                         | T-24 (needs T-20 activity API) | ✅     |
| 2.3 Data                | Source filter badges + dropdown                       | T-4, T-17                      | ✅     |
| 2.3 Data                | Paginated document table                              | T-4                            | ✅     |
| 2.3 Data                | +Add Source (ConnectorsTab dialog + wizard)           | T-4                            | ✅     |
| 2.3 Data                | Crawler source detail + sub-nav                       | T-4                            | ✅     |
| 2.3 Data                | Document detail drawer (4 tabs)                       | T-18                           | ✅     |
| 2.3 Data                | Compound document status                              | T-4 (UI), T-15 (API)           | ✅     |
| 2.3 Data                | Bulk actions                                          | T-29                           | ✅     |
| 2.4 Intelligence Hub    | 5 adaptive-state cards                                | T-3                            | ✅     |
| 2.4 Intelligence        | Persistent sub-nav tabs                               | T-3                            | ✅     |
| 2.4 Intelligence        | 5 drill-down sub-routes                               | T-3                            | ✅     |
| 2.4 Intelligence        | LLM Models card + drill-down                          | T-3                            | ✅     |
| 2.5 Fields drill-down   | By Field / By Connector views                         | T-3 (wraps existing)           | ✅     |
| 2.6 Search & Test       | Existing playground                                   | T-5                            | ✅     |
| 2.6 Search & Test       | Resolution Chain (7-stage)                            | T-25 (needs T-21 API)          | ✅     |
| 2.6 Search & Test       | Query Diagnostic (3-category)                         | T-5                            | ✅     |
| 2.6 Search & Test       | Score breakdown per result                            | T-25                           | ✅     |
| 2.6 Search & Test       | Flow attribution + enrichment badges                  | T-25                           | ✅     |
| 2.6 Search & Test       | Copy API Call / Copy as cURL                          | T-5                            | ✅     |
| 2.6 Search & Test       | Test Vocabulary button                                | T-5                            | ✅     |
| 2.6 Search & Test       | Query History + Compare                               | T-26 (needs T-22 API)          | ✅     |
| 2.6 Search & Test       | Query LLM config display                              | T-5                            | ✅     |
| 2.7 Settings            | SlidePanel with general + index + danger zone         | T-7                            | ✅     |
| 2.8 KB List             | Search + filter + sort + cards                        | T-16 (needs T-10 API)          | ✅     |
| 2.8 KB List             | Auto-navigate after creation                          | T-16                           | ✅     |
| 2.9 Feedback Loops      | Enrichment → Search toasts with links                 | T-28                           | ✅     |
| 2.10 Keyboard Shortcuts | Alt+1–4, Alt+,                                        | T-27                           | ✅     |

---

## Risk Register

| Risk                                                   | Impact                                                           | Mitigation                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Pipeline store reset() destroys state on nav (E-3)     | Users lose unsaved pipeline edits when switching sections        | D-12: Add `useBlocker` navigation guard. Test in T-3.                                 |
| ClickHouse read path (C-33 query history)              | First API read from ClickHouse — no precedent                    | Follow `ClickHouseAuditStore.query()` pattern (E-2). Can defer T-22 without blocking. |
| Dual-DB joins for health-summary                       | KnowledgeBase in abl_platform, SearchDocument in searchaicontent | Server-side composition endpoint (D-9).                                               |
| Navigation store is central to all routing             | Bug blocks entire KB experience                                  | T-1 has thorough tests (T-8). Existing tab URLs work as fallback.                     |
| 10 existing tab components are complex                 | FieldsTab 1517 lines, KGTab 738 lines                            | Wrap don't rewrite (D-3). All verified self-contained in E-4, E-5.                    |
| Permission system fundamentally broken (E-10)          | B-1 fix is prerequisite — changes auth behavior                  | T-0 runs first. Isolated fix (case normalization in ROLE_PERMISSIONS lookup).         |
| CrawlerTab auto-creates source on mount (E-12)         | Moving to Data section may trigger unwanted source creation      | Guard with conditional check before auto-create in T-4.                               |
| WebSocket crawl-only progress (E-7)                    | "8 of 23 docs indexed" progress needs general doc progress       | SWR polling for non-crawl jobs in T-6 (ConnectorDocumentsDialog pattern).             |
| FieldsTab swallows SWR errors (E-5)                    | Errors invisible to users                                        | Fix `{ onError: () => {} }` in T-3 when wrapping in sub-route.                        |
| Express route ordering (E-8)                           | Multiple existing static-after-param bugs                        | T-0 fixes known instances. Code review enforces for new routes.                       |
| Home drag-and-drop requires real implementation (B-11) | Current code has no onDrop/onDragOver handlers                   | T-6 must implement real drag-drop, not just UI text.                                  |
| Intelligence hub card complexity (5 cards × 4 states)  | T-3 is the largest frontend task at 6-8 files                    | Break into subtasks during LLD. Each card can be a separate component.                |
| Wave 2 maximum parallelism (11 concurrent tasks)       | Coordination overhead, merge conflicts                           | Zero file overlap verified. Each task owns distinct files. LLD specifies exact paths. |

---

## Review Policy

All phases use a **minimum 7 review iterations** before considering changes clean:

- LLD reviewer (Phase 2 of architect workflow): 7 iteration loops minimum
- PR reviewer (Phase 4): 7 iteration loops minimum
- Each iteration focuses on a different concern: correctness → completeness → consistency → naming → types → edge cases → tests

---

## Out of Scope

- **Cmd+K command palette** — per R2, project-level feature
- **Enterprise chrome** (top bar, notifications) — separate initiative
- **WCAG contrast fixes** — design token changes tracked separately
- **Source sidebar** — per R2, replaced with filter badges + dropdown
- **Connector sync history model** (C-35) — deferred, CrawlJob covers web crawlers
- **Vocabulary match rate aggregate** (C-34) — deferred, needs ClickHouse query design
- **Chunk-level retry** (C-36) — deferred, complex pipeline interaction
- **New WebSocket progress system** — use SWR polling fallback instead
- **Permission-based conditional rendering** — B-1 fix enables it; full RBAC UI is separate initiative
- **Explore Mode** (Documents ↔ Chunks toggle, content search) — v2 enhancement after core Data section ships
