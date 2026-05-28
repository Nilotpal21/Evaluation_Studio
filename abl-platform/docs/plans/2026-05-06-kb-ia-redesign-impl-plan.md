# LLD: Knowledge Bases Information Architecture Redesign

**Feature Spec**: `explorations/2026-05-06-knowledge-bases-ia-redesign.md`
**HLD**: `docs/design/KB-PAGE-LAYOUT-AUDIT-REVISED.md`
**Test Spec**: N/A (UI refactor — existing E2E tests are API-driven and unaffected)
**Status**: DRAFT
**Date**: 2026-05-06

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                           | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                | Alternatives Rejected                                                                        |
| ---- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| D-1  | No feature flag — branch isolation is sufficient                                   | `feature-resolver.ts` is for plan-tier gating, not UI refactors; Agent editor had no flag; branch provides isolation                                                                                                                                                                                                                                                                                                     | Feature flag with runtime toggle (over-engineering for a UI refactor)                        |
| D-2  | Sidebar infrastructure first, then extract pages incrementally                     | Matches Settings/Insights drill-down implementation pattern; enables incremental commits within commit discipline (max 40 files, max 3 packages)                                                                                                                                                                                                                                                                         | Build all pages first then switch (risky big-bang swap)                                      |
| D-3  | Delete old components in Phase 5 as `refactor()` commit                            | CLAUDE.md requires additive `feat()` commits; `deletion-ratio-guard.sh` allows `refactor()` deletions                                                                                                                                                                                                                                                                                                                    | Delete inline during extraction (violates additive commit rule)                              |
| D-4  | Sidebar drill-down replaces main nav naturally (no `isEditorActive` change needed) | Settings/Insights drill-down already works at 240px via `navGroups`/`activeGroup` pattern — no auto-collapse to 56px. The IA proposal's viewport math (56px + 240px = 296px) describes a dual-pane pattern not implemented by the existing navGroup infrastructure. Actual content area is viewport - 240px (~1160px at 1400px). KB canvas pages (Pipeline, KG) handle their own full-width needs via `maxWidth="full"`. | Auto-collapse to 56px via `isEditorActive` (wrong — would hide the 240px contextual sidebar) |
| D-5  | Reuse existing `tab` URL segment for KB page routing                               | `parseUrl` already extracts `tab` from URL position 4; no new routing mechanism needed                                                                                                                                                                                                                                                                                                                                   | New `section` field in nav store (unnecessary complexity)                                    |
| D-6  | Replace `KBDetailLayout` with `KBContextualSidebar` + standalone pages             | Matches Settings pattern; each page independently rendered from `renderContent()`                                                                                                                                                                                                                                                                                                                                        | Keep KBDetailLayout as wrapper (defeats the purpose of the redesign)                         |
| D-7  | Add `sessionStorage` persist to `pipeline-store` draft state                       | Page unmount loses unsaved drafts; `sessionStorage` scoped to browser session; validate kbId on restore                                                                                                                                                                                                                                                                                                                  | No persist (data loss on navigation)                                                         |
| D-8  | Option A: Apply layout improvements during migration (one pass)                    | Each page is new code anyway; marginal extra effort; avoids touching files twice                                                                                                                                                                                                                                                                                                                                         | Option B: Pixel parity first, polish later (doubles touch count)                             |
| D-9  | Mount `SharePointDetailPanel` at AppShell KB wrapper level                         | Panel must be accessible from Sources, Documents, Overview; currently at KBDetailLayout level for same reason                                                                                                                                                                                                                                                                                                            | Mount per-page (duplicated, stale state)                                                     |
| D-10 | Create `KBDetailContext` provider for shared KB data                               | `useKnowledgeBase` hook result needed by both contextual sidebar (name, stats) and active page; avoids duplicate fetches                                                                                                                                                                                                                                                                                                 | Each page fetches independently (duplicate network calls, inconsistent data)                 |

### Key Interfaces & Types

```typescript
// New ProjectPage entries (add to navigation-store.ts ProjectPage union)
type KBPage =
  | 'kb-overview'
  | 'kb-sources'
  | 'kb-documents'
  | 'kb-pipeline'
  | 'kb-fields'
  | 'kb-vocabulary'
  | 'kb-knowledge-graph'
  | 'kb-search-test'
  | 'kb-settings';

// New URL segment mapping (similar to SETTINGS_PAGE_SEGMENTS)
const KB_PAGE_SEGMENTS: Record<string, KBPage> = {
  overview: 'kb-overview',
  sources: 'kb-sources',
  documents: 'kb-documents',
  pipeline: 'kb-pipeline',
  fields: 'kb-fields',
  vocabulary: 'kb-vocabulary',
  'knowledge-graph': 'kb-knowledge-graph',
  'search-test': 'kb-search-test',
  settings: 'kb-settings',
} as const;

// Reverse mapping for URL construction
const KB_PAGE_TO_SEGMENT: Record<KBPage, string> = {
  'kb-overview': 'overview',
  'kb-sources': 'sources',
  'kb-documents': 'documents',
  'kb-pipeline': 'pipeline',
  'kb-fields': 'fields',
  'kb-vocabulary': 'vocabulary',
  'kb-knowledge-graph': 'knowledge-graph',
  'kb-search-test': 'search-test',
  'kb-settings': 'settings',
} as const;

// NavGroup for KB drill-down sidebar (add to ProjectSidebar.tsx navGroups)
const kbNavGroup: NavGroup = {
  id: 'knowledge-bases',
  Icon: BookOpen,
  key: 'knowledge_bases',
  defaultPage: 'kb-overview',
  pages: [
    'kb-overview',
    'kb-sources',
    'kb-documents',
    'kb-pipeline',
    'kb-fields',
    'kb-vocabulary',
    'kb-knowledge-graph',
    'kb-search-test',
    'kb-settings',
  ],
  items: [
    { id: 'kb-overview', Icon: LayoutGrid, key: 'kb_overview' },
    { id: 'kb-sources', Icon: Database, key: 'kb_sources', section: 'Data' },
    { id: 'kb-documents', Icon: FileText, key: 'kb_documents' },
    { id: 'kb-pipeline', Icon: Workflow, key: 'kb_pipeline', section: 'Processing' },
    { id: 'kb-fields', Icon: TableProperties, key: 'kb_fields' },
    { id: 'kb-vocabulary', Icon: BookOpen, key: 'kb_vocabulary', section: 'Intelligence' },
    { id: 'kb-knowledge-graph', Icon: Share2, key: 'kb_knowledge_graph' },
    { id: 'kb-search-test', Icon: Search, key: 'kb_search_test' },
    { id: 'kb-settings', Icon: Settings, key: 'kb_settings', section: 'Settings' },
  ],
};

// KBDetailContext for shared data across pages
// IMPORTANT: Provider must stabilize value with useMemo keyed on individual fields
// to prevent cascading re-renders across all 9 consumer pages on SWR revalidation.
interface KBDetailContextValue {
  knowledgeBase: KnowledgeBaseDetail;
  sources: SearchAISource[];
  sourceCount: number;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  refreshSources: () => void;
}
// Provider implementation pattern:
// const value = useMemo(() => ({ knowledgeBase, sources, sourceCount, isLoading, error, refresh, refreshSources }),
//   [knowledgeBase, sources, sourceCount, isLoading, error, refresh, refreshSources]);
```

### Module Boundaries

| Module                           | Responsibility                                                            | Depends On                                                                        |
| -------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `navigation-store.ts`            | URL parsing, KB page routing, `KB_PAGE_SEGMENTS`                          | —                                                                                 |
| `ProjectSidebar.tsx`             | KB `navGroup` definition, drill-down rendering, back button, count badges | `navigation-store`                                                                |
| `AppShell.tsx`                   | KB page component mounting, `KBDetailContext` provider wrapping           | `navigation-store`, `useKnowledgeBase`                                            |
| `KBContextualSidebar.tsx` (NEW)  | KB name/stats display in sidebar header, badge counts                     | `KBDetailContext`, `navigation-store`                                             |
| `KBOverviewPage.tsx` (NEW)       | Overview dashboard                                                        | `KBDetailContext`, `DetailPageShell`, `MetricCard`, `Section`, `ActivityTimeline` |
| `KBSourcesPage.tsx` (NEW)        | Source management                                                         | `KBDetailContext`, `ListPageShell`, `SourcesTable` (existing)                     |
| `KBDocumentsPage.tsx` (NEW)      | Document browsing                                                         | `KBDetailContext`, `ListPageShell`, `DocumentTable` (existing)                    |
| `KBPipelinePage.tsx` (NEW)       | Pipeline editor wrapper                                                   | `KBDetailContext`, `PipelineEditorV2` (existing), `EmbeddingModelSection`         |
| `KBFieldsPage.tsx` (NEW)         | Field mappings                                                            | `KBDetailContext`, `DetailPageShell`, `FieldsTab` (existing)                      |
| `KBVocabularyPage.tsx` (NEW)     | Vocabulary management                                                     | `KBDetailContext`, `ListPageShell`, `VocabularyTab` (existing)                    |
| `KBKnowledgeGraphPage.tsx` (NEW) | KG visualization & config                                                 | `KBDetailContext`, `KnowledgeGraphTab` (existing)                                 |
| `KBSearchTestPage.tsx` (NEW)     | Search playground                                                         | `KBDetailContext`, `SearchTestSection` (existing)                                 |
| `KBSettingsPage.tsx` (NEW)       | KB settings                                                               | `KBDetailContext`, `DetailPageShell`                                              |

---

## 2. File-Level Change Map

### New Files

| File                                                                  | Purpose                                                                                | LOC Estimate |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------ |
| `apps/studio/src/components/search-ai/context/KBDetailContext.tsx`    | React context provider wrapping `useKnowledgeBase` + `SharePointDetailPanel`           | ~80          |
| `apps/studio/src/components/search-ai/layout/KBContextualSidebar.tsx` | KB sidebar header (name, stats, status) rendered inside `ProjectSidebar` drill-down    | ~120         |
| `apps/studio/src/components/search-ai/pages/KBOverviewPage.tsx`       | Overview dashboard with `DetailPageShell`, `MetricCard`, `Section`, `ActivityTimeline` | ~200         |
| `apps/studio/src/components/search-ai/pages/KBSourcesPage.tsx`        | Sources list page with `ListPageShell` wrapping existing `SourcesTable`                | ~80          |
| `apps/studio/src/components/search-ai/pages/KBDocumentsPage.tsx`      | Documents list page with `ListPageShell` wrapping existing `DocumentTable`             | ~80          |
| `apps/studio/src/components/search-ai/pages/KBPipelinePage.tsx`       | Pipeline page with editor + embedded embedding/vision model config                     | ~150         |
| `apps/studio/src/components/search-ai/pages/KBFieldsPage.tsx`         | Fields page with `DetailPageShell` wrapping existing `FieldsTab` + model config        | ~100         |
| `apps/studio/src/components/search-ai/pages/KBVocabularyPage.tsx`     | Vocabulary page with `ListPageShell` wrapping existing `VocabularyTab` + model config  | ~100         |
| `apps/studio/src/components/search-ai/pages/KBKnowledgeGraphPage.tsx` | KG page wrapping existing `KnowledgeGraphTab` + model config                           | ~100         |
| `apps/studio/src/components/search-ai/pages/KBSearchTestPage.tsx`     | Search page wrapping existing `SearchTestSection` + query LLM config + vocab test      | ~120         |
| `apps/studio/src/components/search-ai/pages/KBSettingsPage.tsx`       | Settings page with General, Index Info, API & SDK, Model Usage, Danger Zone            | ~200         |

### Modified Files

| File                                                       | Change Description                                                                                                                                                                                                             | Risk                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `apps/studio/src/store/navigation-store.ts`                | Add `KBPage` types to `ProjectPage` union, add `KB_PAGE_SEGMENTS` + `KB_PAGE_TO_SEGMENT` mappings, update `parseUrl()` to map KB tab segments to KBPage variants, update `buildPath()` to construct KB URLs                    | **High** — core routing; must not break other modules |
| `apps/studio/src/components/navigation/ProjectSidebar.tsx` | Add KB `navGroup` to `navGroups` array, add KB sidebar header rendering, update `handleBackToMain` to be group-aware (KB back → `/search-ai`, not `/overview`)                                                                 | **High** — shared navigation component                |
| `apps/studio/src/components/navigation/AppShell.tsx`       | Wrap KB pages in `KBDetailContext` provider, add KB page component rendering in `renderContent()` (remove old `KnowledgeBaseDetailPage` guard), mount `SharePointDetailPanel` at KB wrapper level. No `isEditorActive` change. | **High** — application shell                          |
| `apps/studio/src/store/pipeline-store.ts`                  | Add `persist` middleware with `sessionStorage`, `partialize` to only persist draft/isDirty/projectId/knowledgeBaseId, validate kbId on restore                                                                                 | **Medium** — isolated store change                    |
| `apps/studio/src/store/data-tab-filter-store.ts`           | Remove `'chunks'` from `DataView` type (chunks folded into documents page)                                                                                                                                                     | **Low** — minor type change                           |
| `packages/i18n/locales/en/studio.json`                     | Add flat nav-namespace i18n keys (`kb_overview`, `kb_sources`, `kb_documents`, `kb_pipeline`, `kb_fields`, `kb_vocabulary`, `kb_knowledge_graph`, `kb_search_test`, `kb_settings`)                                             | **Low** — additive                                    |

### Deleted Files (Phase 5 only)

| File                                                                        | Reason                                                      |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/studio/src/components/search-ai/layout/KBDetailLayout.tsx`            | Replaced by `KBDetailContext` + standalone pages            |
| `apps/studio/src/components/search-ai/layout/KBSectionNav.tsx`              | Replaced by sidebar drill-down navigation                   |
| `apps/studio/src/components/search-ai/layout/KBHeader.tsx`                  | Replaced by `KBContextualSidebar` header                    |
| `apps/studio/src/components/search-ai/intelligence/IntelligenceSection.tsx` | Replaced by individual pages (Pipeline, Fields, Vocab, KG)  |
| `apps/studio/src/components/search-ai/intelligence/IntelligenceSubNav.tsx`  | Replaced by sidebar navigation                              |
| `apps/studio/src/components/search-ai/intelligence/IntelligenceHub.tsx`     | Redundant — status shown via sidebar badges + Overview page |
| `apps/studio/src/components/search-ai/settings/SettingsPanel.tsx`           | Replaced by `KBSettingsPage`                                |
| `apps/studio/src/components/search-ai/KnowledgeBaseDetailPage.tsx`          | Replaced by `KBDetailContext` provider in `AppShell`        |

---

## 3. Implementation Phases

### Phase 1: Routing Infrastructure

**Goal**: Add KB dual-sidebar routing so navigating to a KB shows the contextual sidebar with section items and routes to individual page components (initially rendering placeholder content).

**Tasks**:

1.1. Add `KBPage` type variants to `ProjectPage` union in `navigation-store.ts`
1.2. Add `KB_PAGE_SEGMENTS` and `KB_PAGE_TO_SEGMENT` mappings in `navigation-store.ts`
1.3. Update `parseUrl()` to detect KB page URLs: when `page === 'search-ai'` and `subPage` exists and `tab` matches a `KB_PAGE_SEGMENTS` key, set `page` to the KBPage variant (e.g., `'kb-sources'`), preserve `subPage` as the kbId, and set `tab` to `null`. When `tab` is absent or doesn't match any KB segment, default to `page='kb-overview'`. This makes navGroup `activeGroup` detection work naturally since the KBPage variants are in the navGroup's `pages` array.
1.4. Update `buildPath()` to handle KB pages: when `page` matches a `KB_PAGE_TO_SEGMENT` key, reverse-map the KBPage variant back to the segment and construct `/projects/${projectId}/search-ai/${subPage}/${KB_PAGE_TO_SEGMENT[page]}`. CRITICAL: `setTab()` and `setSubSection()` also call `buildPath()` — ensure they don't corrupt KB URLs (after parseUrl remap, KB state has `page='kb-sources'`, `subPage=kbId`, `tab=null`; a stray `setTab('something')` must not produce `/projects/pid/kb-sources/kbId/something`)
1.5. Add KB `navGroup` to `navGroups` array in `ProjectSidebar.tsx` with all 9 items and 4 section headers (DATA, PROCESSING, INTELLIGENCE, separator before Settings)
1.6. Update `handleBackToMain` in `ProjectSidebar.tsx` to be group-aware: if `activeGroup.id === 'knowledge-bases'`, navigate to `/projects/${projectId}/search-ai` instead of `/overview`
1.7. Update `handleNav` in `ProjectSidebar.tsx` to handle KB pages: when `pageId` exists in `KB_PAGE_TO_SEGMENT`, read the current kbId from `useNavigationStore.getState().subPage` and construct `/projects/${projectId}/search-ai/${kbId}/${KB_PAGE_TO_SEGMENT[pageId]}`
1.8. Update `renderContent()` in `AppShell.tsx` to route KB pages to placeholder components based on the derived page ID. Also remove the `if (subPage) return <KnowledgeBaseDetailPage />` guard from the existing `case 'search-ai':` block, since `parseUrl` now maps KB detail URLs to KBPage variants instead of `'search-ai'`. No `isEditorActive` change needed — the navGroup drill-down works at 240px sidebar width naturally, matching the Settings/Insights pattern.
1.9. Add i18n keys as flat keys under the "nav" namespace in `packages/i18n/locales/en/studio.json`: `"kb_overview": "Overview"`, `"kb_sources": "Sources"`, `"kb_documents": "Documents"`, `"kb_pipeline": "Pipeline"`, `"kb_fields": "Fields"`, `"kb_vocabulary": "Vocabulary"`, `"kb_knowledge_graph": "Knowledge Graph"`, `"kb_search_test": "Search & Test"`, `"kb_settings": "Settings"`
1.10. Run `pnpm build --filter=apps/studio` and verify no type errors

**Files Touched**:

- `apps/studio/src/store/navigation-store.ts` — add types, segments, parseUrl update, buildPath update
- `apps/studio/src/components/navigation/ProjectSidebar.tsx` — add navGroup, update handleBackToMain, update handleNav for KB URLs
- `apps/studio/src/components/navigation/AppShell.tsx` — update renderContent (no isEditorActive change)
- `packages/i18n/locales/en/studio.json` — add flat nav label keys

**Exit Criteria**:

- [ ] Navigating to `/projects/:id/search-ai/:kbId/sources` shows the KB contextual sidebar with "Sources" highlighted and a placeholder page
- [ ] Back button in sidebar navigates to KB list page (`/projects/:id/search-ai`)
- [ ] Sidebar renders at 240px with drill-down navigation (not collapsed to 56px — matches Settings pattern)
- [ ] All 9 sidebar items are visible with correct section headers (DATA, PROCESSING, INTELLIGENCE)
- [ ] Browser back/forward navigation works correctly between KB pages
- [ ] `pnpm build --filter=apps/studio` succeeds with 0 errors
- [ ] Navigating to non-KB pages (agents, workflows, etc.) is completely unaffected

**Test Strategy**:

- Unit: Add pure-function tests for `parseUrl()` and `buildPath()` covering all 9 KB URL patterns, the default-to-overview fallback, and non-KB regression cases (agents, workflows, settings must still parse correctly). These are pure functions needing zero mocks — per CLAUDE.md test architecture.
- Manual: Navigate to each of 9 KB URLs, verify sidebar renders correctly, verify back button. Verify keyboard navigation (Tab/Shift+Tab/Enter/Escape) through all sidebar items and back button. Verify active page has `aria-current="page"`.
- Build: `pnpm build --filter=apps/studio` passes

**Rollback**: Revert the commit. No database or API changes.

---

### Phase 2: Context Provider & Sidebar Header

**Goal**: Create the shared `KBDetailContext` provider and the `KBContextualSidebar` header component that shows KB name, stats, and status in the sidebar.

**Tasks**:

2.1. Create `KBDetailContext.tsx` with `KBDetailProvider` component that:

- Calls `useKnowledgeBase(kbId)` (existing hook)
- Provides `knowledgeBase`, `sources`, `isLoading`, `error`, `refresh`, `refreshSources` via React context (stabilized with `useMemo`)
- Calls `setSubPageLabel(knowledgeBase.name)` on mount and `setSubPageLabel(null)` on unmount — preserves breadcrumb display (lifted from `KBDetailLayout.tsx` line 90-93)
- Resets `search-tab-store` when kbId changes — prevents stale search results when switching KBs (lifted from `KBDetailLayout.tsx` lines 83-88)
- Mounts `SharePointDetailPanel` wrapped in `<TooltipProvider>` (lifted from `KBDetailLayout.tsx` line 204-208)
- Mounts `DiscoveryActivityBar` (lifted from `KBDetailLayout.tsx`)
- Shows loading skeleton when `isLoading` and no data
- Shows error state with retry when `error` and no data

  2.2. Create `KBContextualSidebar.tsx` that renders inside the ProjectSidebar drill-down header area:

- KB name (truncated, `text-sm font-medium text-foreground`)
- Summary line: `{sourceCount} Sources · {docCount} Docs` (`text-xs text-muted`)
- Status badge using `Badge` with `variant` from `statusIntent(knowledgeBase.status)`, `dot={true}`, `pulse={true}` for in-progress states
- Uses `KBDetailContext` to read data

  2.3. Wire `KBDetailProvider` in `AppShell.tsx` to wrap the KB page content area when the current page is a KBPage variant. Use `kbNavGroup.pages.includes(page)` or `page?.startsWith('kb-')` as the check — NOT `page === 'search-ai'` (which no longer matches after Phase 1's `parseUrl` changes map KB detail URLs to KBPage variants)

  2.4. Add count badges to sidebar items by reading from `KBDetailContext`:

- Sources: source count
- Documents: document count
- Fields: confirmed field count
- Vocabulary: term count
- Knowledge Graph: taxonomy version or "—"
- Pipeline: "Active" / "Draft" status text

  2.5. Run `pnpm build --filter=apps/studio` and verify

**Files Touched**:

- `apps/studio/src/components/search-ai/context/KBDetailContext.tsx` — NEW
- `apps/studio/src/components/search-ai/layout/KBContextualSidebar.tsx` — NEW
- `apps/studio/src/components/navigation/AppShell.tsx` — wrap KB pages in KBDetailProvider
- `apps/studio/src/components/navigation/ProjectSidebar.tsx` — render KBContextualSidebar in drill-down header, add count badges

**Exit Criteria**:

- [ ] Sidebar header shows KB name, summary stats, and status badge
- [ ] Count badges appear next to each sidebar item with live data
- [ ] Loading skeleton shows in sidebar when KB data is loading
- [ ] Error state shows when KB fetch fails, with retry capability
- [ ] `SharePointDetailPanel` renders correctly when opened from any page
- [ ] `pnpm build --filter=apps/studio` succeeds with 0 errors

**Test Strategy**:

- Manual: Open a KB, verify sidebar header shows correct name/stats/status; click a source to verify SharePointDetailPanel works
- Build: `pnpm build --filter=apps/studio` passes

**Rollback**: Revert the commit. Context provider is additive.

---

### Phase 3: Extract Pages (DATA + SEARCH sections)

**Goal**: Extract Overview, Sources, Documents, and Search & Test into standalone pages with design-system-aligned layouts (Option A). These are the most self-contained pages.

**Tasks**:

3.1. **KBOverviewPage** — `DetailPageShell` with `maxWidth="lg"`, `.page-comfortable`:

- Use `DetailPageShell` `title` and `actions` props for KB name + action buttons (do NOT nest a separate `PageHeader` inside `DetailPageShell` — it already renders its own header row)
- 3x `MetricCard` in `grid-cols-3` (Sources, Documents, Chunks) — replace custom `StatCard`
- 2-column grid: `Section` "Needs Attention" (with `InfoCard variant="success"` for "All clear") + `Section` "Recent Activity" (with `ActivityTimeline maxItems={8}`)
- Compact source rows in `grid-cols-2` with `Card hoverable padding="sm"` (max 4, "View All" link)
- Conditional `PipelineProgressTracker` shown when `knowledgeBase.status` is `creating`, `indexing`, `rebuilding`, or `error` — replaces the "progress" state from the old HomeSection 3-state machine (component at `../home/PipelineProgressTracker.tsx`)
- Setup wizard (`SetupGuide` from `../home/SetupGuide.tsx`) conditional when 0 documents
- Reuses sub-components from `../home/`: `SetupGuide`, `PipelineProgressTracker`, `NeedsAttentionCard`, `OperationsDashboard` (for stat breakdown logic)
- Loading: 3x `Skeleton h-24 rounded-xl` + 2x `SkeletonCard`
- Error: `ErrorBoundary` with retry
- Empty: `EmptyState` with setup CTA

  3.2. **KBSourcesPage** — `ListPageShell` with `.page-compact`:

- Lift `SourcesTable` content from `DataSection.tsx` (Sources view)
- `ListPageShell` props: title "Sources", primaryAction "[+ Add Source]", search, filters (Type, Status)
- `SegmentedControl` for Card/Table view toggle
- Health summary using `Badge` with `statusIntent()`
- Loading: `SkeletonTable` or `SkeletonCard` grid
- Error: `ErrorBoundary`
- Empty: `EmptyState` with "Add your first source" CTA

  3.3. **KBDocumentsPage** — `ListPageShell` with `.page-compact`:

- Lift `DocumentTable` content from `DataSection.tsx` (Documents view)
- Source filter as `FilterSelect` dropdown (not sub-tabs)
- Status badges via `statusIntent()` — replace multi-dot `PipelineStatusTooltip` with text `Badge`
- Per-document chunk expand (lift from ChunksGroupedView)
- Loading: `SkeletonTable`
- Error: `ErrorBoundary`
- Empty: `EmptyState` with contextual CTA

  3.4. **KBSearchTestPage** — `DetailPageShell` with `maxWidth="xl"`:

- Lift `SearchTestSection` content
- Add Query LLM config section with `border-l-2 border-purple` accent (AI section)
- Add Vocabulary Test section (moved from VocabularyTab)
- Add Top K and Similarity Threshold controls here (currently in SettingsPanel; the old copy is removed in Phase 5)
- Consolidate debug/history into diagnostics right panel (collapsible sections)
- Replace LLM awareness banner with compact `InfoCard` (dismissible)
- Loading: skeleton matching 2-column layout
- Error: `ErrorBoundary`

  3.5. Wire all 4 pages in `AppShell.tsx` `renderContent()`, replacing placeholder components
  3.6. Run `pnpm build --filter=apps/studio` and verify

**Files Touched**:

- `apps/studio/src/components/search-ai/pages/KBOverviewPage.tsx` — NEW
- `apps/studio/src/components/search-ai/pages/KBSourcesPage.tsx` — NEW
- `apps/studio/src/components/search-ai/pages/KBDocumentsPage.tsx` — NEW
- `apps/studio/src/components/search-ai/pages/KBSearchTestPage.tsx` — NEW
- `apps/studio/src/components/navigation/AppShell.tsx` — wire pages

**Exit Criteria**:

- [ ] Overview page shows `MetricCard` stats, `ActivityTimeline`, `Section`-wrapped attention/activity panels
- [ ] Sources page uses `ListPageShell` with search, filters, card/table toggle, bulk actions
- [ ] Documents page uses `ListPageShell` with source `FilterSelect`, text status `Badge` (not multi-dot), chunk expand per document
- [ ] Search & Test page has query playground + diagnostics + Query LLM config (purple accent) + vocab test
- [ ] All 4 pages have loading skeleton, error boundary, and empty state
- [ ] Cross-page navigation works (clicking stat card on Overview navigates to Documents with filter via `data-tab-filter-store`)
- [ ] No hardcoded Tailwind palette colors (design-token-lint passes)
- [ ] `pnpm build --filter=apps/studio` succeeds with 0 errors

**Test Strategy**:

- Manual: Navigate to each page, verify layout matches audit wireframes, verify data loads, verify actions work
- Build: `pnpm build --filter=apps/studio` passes
- Lint: `npx prettier --write` on all new files

**Rollback**: Revert the commit. Old tab-based navigation still functional until Phase 5.

---

### Phase 4: Extract Pages (PROCESSING + INTELLIGENCE + SETTINGS sections)

**Goal**: Extract Pipeline, Fields, Vocabulary, Knowledge Graph, and Settings into standalone pages with design-system-aligned layouts and distributed AI model config.

**Tasks**:

4.1. **KBPipelinePage** — `DetailPageShell` with `maxWidth="full"` (canvas page):

- Pipeline summary card: status, flow count, stage count, last deployed, [Open Editor] [Deploy]
- [Open Editor] launches `PipelineEditorV2` as full-screen overlay (existing component)
- Embedding model config section with `border-l-2 border-purple` accent
- Vision/Multimodal model toggles with purple accent
- Add `sessionStorage` persist to `pipeline-store.ts` (task 4.1b):
  - `import { persist, createJSONStorage } from 'zustand/middleware'`
  - Wrap store with `persist` middleware, `storage: createJSONStorage(() => sessionStorage)` (Zustand v4.4+ requires `createJSONStorage` wrapper — raw `sessionStorage` does not satisfy `StateStorage` interface)
  - `partialize`: only persist `draft`, `isDirty`, `projectId`, `knowledgeBaseId`
  - `version: 1` + no-op `migrate` function (scaffold for future schema changes — prevents silent data corruption if store shape changes)
  - `skipHydration: true` to avoid Next.js SSR hydration mismatch; call `useStore.persist.rehydrate()` in a `useEffect` on client mount
  - On restore: read current kbId from `useNavigationStore.getState().subPage`, compare against persisted `knowledgeBaseId`; if mismatched, call `clearDraft()` to discard stale data
  - Add `beforeunload` handler when `isDirty === true` to warn users before tab close
  - On successful restore, show a brief toast ("Draft restored from previous session")
- Loading: `SkeletonFormSection`
- Error: `ErrorBoundary`

  4.2. **KBFieldsPage** — `DetailPageShell` with `maxWidth="lg"`:

- Summary bar: "77 mapped · 3 suggested · 7 unmapped" (above inline tabs)
- `Tabs` component for My Fields / Suggested (with count badge) / Unmapped
- Lift field table content from `FieldsTab.tsx`
- Field mapping suggestion model config with purple accent
- Loading: `SkeletonTable`
- Error: `ErrorBoundary`

  4.3. **KBVocabularyPage** — `ListPageShell` with `.page-compact`:

- Lift `VocabularyTab` content
- Vocabulary generation model config with purple accent
- Move `[Test Resolution]` button reference to Search & Test page (already done in Phase 3)
- Loading: `SkeletonTable`
- Error: `ErrorBoundary`

  4.4. **KBKnowledgeGraphPage** — `DetailPageShell` with `maxWidth="full"` (canvas page):

- Lift `KnowledgeGraphTab` content (all 4 states preserved)
- KG extraction model config with purple accent
- Graph/Statistics/Attributes inline toggle via `SegmentedControl`
- Full-width canvas for graph visualization
- Loading: `Skeleton` canvas + side panels
- Error: `ErrorBoundary`

  4.5. **KBSettingsPage** — `DetailPageShell` with `maxWidth="md"`:

- Reuse existing sub-components from `../settings/`: `GeneralSection`, `IndexConfigSection`, `DangerZoneSection` (production-ready with working API calls)
- Add new sections: API & SDK, Model Usage
- Wrap in `DetailPageShell` with `Section` components
- `Section` "General": reuse `GeneralSection` (name, description, status, created, save button)
- `Section` "Index Info": reuse `IndexConfigSection` (index ID, embedding model, dimensions, vector store, collection — all read-only)
- `Section` "API & SDK": Preview SDK link + `Button`, API snippet with `CodeBlock`
- `Section` "Model Usage": read-only summary of all active models across KB, cost tiers
- `Section variant="elevated"` "Danger Zone": [Rebuild Index] + [Delete KB] with `ConfirmDialog variant="danger"`
- Loading: `SkeletonFormSection` x3
- Error: `ErrorBoundary`

  4.6. Wire all 5 pages in `AppShell.tsx` `renderContent()`, replacing remaining placeholders
  4.7. Run `pnpm build --filter=apps/studio` and verify

**Files Touched**:

- `apps/studio/src/components/search-ai/pages/KBPipelinePage.tsx` — NEW
- `apps/studio/src/components/search-ai/pages/KBFieldsPage.tsx` — NEW
- `apps/studio/src/components/search-ai/pages/KBVocabularyPage.tsx` — NEW
- `apps/studio/src/components/search-ai/pages/KBKnowledgeGraphPage.tsx` — NEW
- `apps/studio/src/components/search-ai/pages/KBSettingsPage.tsx` — NEW
- `apps/studio/src/store/pipeline-store.ts` — add sessionStorage persist
- `apps/studio/src/components/navigation/AppShell.tsx` — wire pages

**Exit Criteria**:

- [ ] Pipeline page shows summary card + [Open Editor] launches full canvas + embedding/vision model config with purple accent
- [ ] Pipeline store draft persists across navigation via sessionStorage; validates kbId on restore
- [ ] Fields page shows summary bar + 3 inline tabs + field mapping model config with purple accent
- [ ] Vocabulary page uses `ListPageShell` + vocab generation model config with purple accent
- [ ] KG page renders all 4 states correctly + graph canvas at full width + KG model config with purple accent
- [ ] Settings page has 5 sections (General, Index Info, API & SDK, Model Usage, Danger Zone)
- [ ] Rebuild Index and Delete KB work via `ConfirmDialog` with danger variant
- [ ] All 5 pages have loading skeleton, error boundary, and empty state
- [ ] No hardcoded Tailwind palette colors
- [ ] `pnpm build --filter=apps/studio` succeeds with 0 errors

**Test Strategy**:

- Manual: Navigate to each page, verify data loads, verify model config sections show purple accent, verify pipeline persist survives navigation
- Build: `pnpm build --filter=apps/studio` passes
- Lint: `npx prettier --write` on all new files

**Rollback**: Revert the commit. Pipeline store persist is safe to revert (sessionStorage is ephemeral).

---

### Phase 5: Cleanup & Remove Old Navigation

**Goal**: Remove all old navigation components that are no longer referenced. This is a `refactor()` commit, not `feat()`.

**Tasks**:

5.1. Remove `KBDetailLayout.tsx` — replaced by `KBDetailContext` + standalone pages
5.2. Remove `KBSectionNav.tsx` — replaced by sidebar drill-down
5.3. Remove `KBHeader.tsx` — replaced by `KBContextualSidebar`
5.4. Remove `IntelligenceSection.tsx` — replaced by individual pages
5.5. Remove `IntelligenceSubNav.tsx` — replaced by sidebar navigation
5.6. Remove `IntelligenceHub.tsx` — redundant (status via sidebar badges + Overview)
5.7. Remove `SettingsPanel.tsx` — replaced by `KBSettingsPage`
5.8. Remove `KnowledgeBaseDetailPage.tsx` — replaced by `KBDetailContext` in `AppShell`
5.9. Remove `DataSection.tsx` — replaced by `KBSourcesPage` + `KBDocumentsPage`
5.9b. Remove `HomeSection.tsx` — replaced by `KBOverviewPage` (sub-components `SetupGuide`, `PipelineProgressTracker`, `NeedsAttentionCard`, `OperationsDashboard` are NOT deleted — reused by `KBOverviewPage` imports)
5.9c. Remove `SettingsTab.tsx` (the confusingly-named LLM Models component) — sub-components (`FeatureCard`, `QueryPipelineLLMSection`, `EmbeddingModelSection`) are NOT deleted — reused by new pages
5.9d. Remove or rewrite `useKBShortcuts.ts` — the old hook calls `setTab('data')` / `setTab('intelligence')` which no longer exist. Either rewrite to use `navigate()` for new KB pages (Alt+1→kb-overview, Alt+2→kb-sources, etc.) or delete and defer keyboard shortcuts to a follow-up
5.9e. Remove `data-section.test.tsx` — tests deleted `DataSection` component
5.9f. Remove orphaned test files: `home-section.test.tsx`, `intelligence-hub.test.tsx`, `settings-panel-rebuild.test.tsx`, `index-not-ready-guard.test.tsx`
5.9g. Remove `IntelligenceCard.tsx` + entire `intelligence/cards/` directory (FieldsCard, KnowledgeGraphCard, LLMModelsCard, PipelineCard, VocabularyCard) + `intelligence-cards.test.tsx` — consumed only by deleted IntelligenceHub, replaced by `MetricCard` on Overview page
5.10. Update `data-tab-filter-store.ts`: remove `'chunks'` from `DataView` type. Update the 2 real consumers: `OperationsDashboard.tsx` line 172 (change `view: 'chunks'` to `view: 'documents'`), `NeedsAttentionCard.tsx` line 33 (update inline type from `'documents' | 'chunks' | 'sources'` to `'documents' | 'sources'`). Note: `KBHeader.tsx` and `DataSection.tsx` also reference `'chunks'` but are both being deleted in this phase.
5.11. Clean up orphaned imports in remaining files. Delete orphaned barrel files: `layout/index.ts`, `intelligence/index.ts`, `home/index.ts`, `data/index.ts`, `search/index.ts` (keep `settings/index.ts` if settings sub-components are reused). `ChunksGroupedView.tsx` is NOT deleted — it's reused inside `KBDocumentsPage` for per-document chunk expansion.
5.12. Run `pnpm build --filter=apps/studio` to verify no broken imports
5.13. Run `npx prettier --write` on all modified files

**Files Touched**:

- DELETE: 8 files listed in "Deleted Files" table above + DataSection.tsx + HomeSection.tsx + SettingsTab.tsx + useKBShortcuts.ts + data-section.test.tsx + orphaned barrel files
- MODIFY: `apps/studio/src/store/data-tab-filter-store.ts` — remove `'chunks'` view type
- MODIFY: any files with orphaned imports

**Exit Criteria**:

- [ ] All deleted files are gone from the codebase (8 from Deleted Files table + DataSection, HomeSection, SettingsTab, useKBShortcuts, data-section.test, barrel files)
- [ ] No remaining imports reference deleted files (`grep` for each deleted file path returns 0 results)
- [ ] `pnpm build --filter=apps/studio` succeeds with 0 errors
- [ ] All 9 KB pages still render correctly after cleanup
- [ ] KB list page still works (no changes to `KnowledgeBaseDashboardPage`)

**Test Strategy**:

- Build: `pnpm build --filter=apps/studio` passes (proves no broken imports)
- Manual: Smoke test all 9 pages + KB list page
- Grep: `grep -r 'KBDetailLayout\|KBSectionNav\|KBHeader\|IntelligenceSection\|IntelligenceSubNav\|IntelligenceHub\|SettingsPanel\|KnowledgeBaseDetailPage\|DataSection' apps/studio/src/ --include='*.ts' --include='*.tsx'` returns 0 matches

**Rollback**: Revert the commit. Previous phases' code still references old components — but since Phase 5 runs last, reverting just this phase is safe.

---

### Phase 6: Polish & Visual Regression

**Goal**: Final polish — verify design-system compliance, update visual regression baselines, fix any remaining issues.

**Tasks**:

6.1. Run `design-token-lint.sh` on all new/modified files — fix any hardcoded palette colors
6.2. Run `accent-foreground-lint.sh` — fix any invisible accent/foreground combos
6.3. Run `native-select-lint.sh` — verify no native `<select>` elements
6.4. Verify all AI model sections use `border-l-2 border-purple` + `Badge variant="purple"` (not purple backgrounds)
6.5. Verify all status badges use `statusIntent()` from `@agent-platform/design-tokens`
6.6. Verify all section headers use `SECTION_LABEL_CLASS` pattern (`text-xs font-medium uppercase tracking-wider text-muted`)
6.7. Verify all pages have loading/error/empty states per PipelineEditor standard
6.8. Update visual regression baselines for KB pages (if visual regression tests exist)
6.9. Run `npx prettier --write` on all files touched across phases 1-5
6.10. Run `pnpm build` (full monorepo) to verify no cross-package issues

**Files Touched**:

- All new page files (spot fixes)
- Visual regression snapshot files (if applicable)

**Exit Criteria**:

- [ ] All 3 design linting hooks pass on all new/modified files
- [ ] Full monorepo `pnpm build` succeeds with 0 errors
- [ ] Every AI section has purple accent (verified by visual inspection)
- [ ] Every status badge uses `statusIntent()` mapping
- [ ] Every page has skeleton loading, ErrorBoundary, and EmptyState
- [ ] Keyboard navigation works through all sidebar items (Tab/Shift+Tab/Enter/Escape)
- [ ] Active sidebar item has `aria-current="page"`

**Test Strategy**:

- Lint: All 3 design hooks pass
- Build: `pnpm build` (full monorepo) passes
- Manual: Visual walkthrough of all 9 pages in both light and dark mode
- Accessibility: Keyboard navigation test + `aria-current` verification on active sidebar item

**Rollback**: Spot fixes only — no structural risk.

---

## 4. Wiring Checklist

**Studio UI (all items apply):**

- [ ] `KBDetailContext` provider wraps KB page area in `AppShell.tsx`
- [ ] Each new page component is imported and rendered in `AppShell.renderContent()` switch
- [ ] KB `navGroup` is added to `navGroups` array in `ProjectSidebar.tsx`
- [ ] `KBContextualSidebar` is rendered in the drill-down header area
- [ ] `SharePointDetailPanel` is mounted inside `KBDetailProvider` (not per-page)
- [ ] `DiscoveryActivityBar` is mounted inside `KBDetailProvider` or Overview page
- [ ] All 9 i18n keys added to `packages/i18n/locales/en/studio.json`
- [ ] `KB_PAGE_SEGMENTS` mapping added to `navigation-store.ts`
- [ ] `handleBackToMain` updated for KB group (back → `/search-ai`)
- [ ] `handleNav` updated to construct KB-specific URLs using `KB_PAGE_TO_SEGMENT` and current kbId from navigation store
- [ ] Old `if (subPage) return <KnowledgeBaseDetailPage />` removed from `case 'search-ai':` in AppShell
- [ ] Pipeline store `persist` middleware added with `createJSONStorage(() => sessionStorage)`
- [ ] No native `<select>` elements — use `Select` or `FilterSelect`
- [ ] No `bg-accent text-foreground` — use `bg-accent text-accent-foreground`
- [ ] Each page's mutation handlers have error handling (try/catch or onError)
- [ ] Submit buttons have `disabled={isPending}` loading guards
- [ ] Each page uses the correct shell (`ListPageShell` or `DetailPageShell`) per layout audit
- [ ] Each page has loading skeleton, `ErrorBoundary`, and `EmptyState`

---

## 5. Cross-Phase Concerns

### Database Migrations

None. This is a pure frontend restructuring.

### Feature Flags

None. Branch isolation is sufficient (Decision D-1).

### Configuration Changes

No new env vars or config keys.

### Shared State Concerns

| Store                   | Change                                          | Impact                                                                                            |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `navigation-store`      | New `ProjectPage` variants, new segment mapping | Must not break existing page routing                                                              |
| `pipeline-store`        | Add `sessionStorage` persist                    | Must validate kbId on restore; discard stale drafts                                               |
| `data-tab-filter-store` | Remove `'chunks'` from `DataView`               | Consumers of `consumeFilter()` must handle the change                                             |
| `connector-store`       | No changes                                      | Already global singleton, works as-is                                                             |
| `search-tab-store`      | Reset on kbId change                            | Must call `reset()` when navigating to a different KB — implemented in `KBDetailContext` provider |

### AppShell Cross-Phase Edits

`AppShell.tsx` is modified across 4 phases (1, 2, 3, 4). Each phase's changes are additive to the prior:

- Phase 1: Add KB page routing in `renderContent()` with placeholders
- Phase 2: Wrap KB content area in `KBDetailProvider`
- Phase 3: Replace placeholders with real page components (Overview, Sources, Documents, Search & Test)
- Phase 4: Replace remaining placeholders (Pipeline, Fields, Vocabulary, KG, Settings)

### Animation Consistency

- Sidebar drill-down transition: use existing `slideVariants` + `springs.gentle` (already implemented for Settings/Insights)
- Page content transition: The existing `AnimatePresence` key pattern `${area}-${page}-${subPage}` already produces unique keys per KB page because `page` changes between KBPage variants (e.g., `project-kb-sources-abc123` vs `project-kb-documents-abc123`). No key update needed.
- Use `transitions.pageEnter` (0.2s with EASE_SPRING) for page content

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 6 phases complete with exit criteria met
- [ ] Navigating to a KB shows the dual-sidebar pattern with contextual KB navigation
- [ ] All 9 sidebar items route to their own full-width pages
- [ ] Every current feature, action, and dialog is preserved (per exploration doc Part 4 coverage table)
- [ ] AI model configs distributed to their target pages with purple accent
- [ ] No sub-tabs or nesting — flat sidebar navigation only
- [ ] Sidebar count badges show live data
- [ ] Back button returns to KB list page
- [ ] Browser back/forward works across all KB pages
- [ ] Cross-page navigation with pre-set filters works (e.g., Overview stat card → Documents filtered)
- [ ] Pipeline unsaved drafts survive navigation via sessionStorage
- [ ] All design-system linting hooks pass
- [ ] All pages have loading/error/empty states
- [ ] `pnpm build` (full monorepo) succeeds
- [ ] Light mode and dark mode both render correctly

---

## 7. Open Questions

1. **Chunks as standalone page?** — The current proposal folds chunks into per-document expand on the Documents page. If users frequently need a global chunks view, consider adding it back as a standalone page later. Monitor usage post-launch.
2. **Sidebar item ordering for Settings** — Currently Settings is below a separator. If users find it hard to discover, consider promoting it to a section or adding a gear icon shortcut in the sidebar header.
3. **KG page canvas vs. form** — The KG page mixes canvas visualization (full-width) with form-based config (fixed-width). May need a layout toggle or split view. Defer to implementation.
