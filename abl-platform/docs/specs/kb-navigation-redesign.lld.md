# KB Navigation Redesign — Low-Level Design

**HLD Reference**: `docs/specs/kb-navigation-redesign.hld.md` (v4, approved)
**Exploration Findings**: `.claude/agent-memory-local/architect/kb-wireframe-exploration-findings.md`
**Date**: 2026-03-17

---

## Wave 1: Foundation

---

### Task T-0: Backend Bug Fixes

**Package**: `apps/search-ai`, `packages/database`
**Independent**: Yes (zero file overlap with T-1, T-2)

#### Files to Modify

| File                                                                         | What Changes                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/search-ai/src/middleware/auth.ts` (lines 37-91)                        | Fix ROLE_PERMISSIONS keys from lowercase to UPPER_CASE                 |
| `apps/search-ai/src/routes/knowledge-bases.ts` (lines 101-102)               | Fix hardcoded embedding model/dimensions                               |
| `apps/search-ai/src/routes/indexes.ts` (lines 567-645 vs 163)                | Move static LLM config routes before parameterized `/:indexId`         |
| `apps/search-ai/src/validation/index-schemas.ts` (lines 225-239)             | Add `mapping_suggestion` + `vocabularyGeneration` to `LLMConfigSchema` |
| `apps/search-ai/src/services/llm-config/defaults.ts` (lines 43-166, 222-270) | Add `treeBuilder` to `USE_CASE_DEFAULTS` and `specificParams`          |
| `apps/search-ai/src/services/llm-config/metadata.ts` (lines 47-204)          | Add `treeBuilder` to `USE_CASE_METADATA`                               |

#### Function Signatures (changes)

```typescript
// auth.ts — Change keys only, function stays same
const ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: [...],   // was: owner
  ADMIN: [...],   // was: admin
  MEMBER: [...],  // was: member
  VIEWER: [...],  // was: viewer
};

// Also add normalization in resolveRolePermissions:
function resolveRolePermissions(role: string): string[] {
  return ROLE_PERMISSIONS[role.toUpperCase()] ?? [];
}
```

```typescript
// knowledge-bases.ts — Lines 101-102, change to:
embeddingModel: 'bge-m3',       // was: 'text-embedding-3-small'
embeddingDimensions: 1024,       // was: 1536
```

```typescript
// index-schemas.ts — Add to LLMConfigSchema.useCases:
mapping_suggestion: MappingSuggestionConfigSchema.optional(),
vocabularyGeneration: VocabularyGenerationConfigSchema.optional(),

// New schemas (follow BaseUseCaseConfigSchema.extend pattern):
export const MappingSuggestionConfigSchema = BaseUseCaseConfigSchema.extend({});
export const VocabularyGenerationConfigSchema = BaseUseCaseConfigSchema.extend({});
```

```typescript
// defaults.ts — Add treeBuilder entry (follow existing pattern):
treeBuilder: {
  enabled: true,
  modelTier: 'fast' as const,
  category: 'core' as const,
  description: 'Builds hierarchical document tree structure for chunking',
  volume: 'high' as const,
  costRating: 3,
},

// Also add to specificParams map:
treeBuilder: {
  maxTokens: 512,
  targetChunkSize: 512,
  chunkOverlap: 50,
},
```

```typescript
// metadata.ts — Add treeBuilder entry:
treeBuilder: {
  displayName: 'Tree Builder',
  description: 'Hierarchical document tree structure for intelligent chunking',
  icon: 'GitBranch',
  category: 'core',
  configFields: [
    { key: 'maxTokens', label: 'Max Tokens', type: 'number', min: 50, max: 500 },
    { key: 'targetChunkSize', label: 'Target Chunk Size', type: 'number', min: 128, max: 2048 },
    { key: 'chunkOverlap', label: 'Chunk Overlap', type: 'number', min: 0, max: 200 },
  ],
},
```

#### Subtasks (execution order)

1. **ST-0.1**: Fix ROLE_PERMISSIONS keys in `auth.ts` — uppercase keys + `.toUpperCase()` normalization
2. **ST-0.2**: Fix embedding model mismatch in `knowledge-bases.ts` — change to `bge-m3`/1024
3. **ST-0.3**: Move static routes in `indexes.ts` — cut lines 567-645, paste before line 163
4. **ST-0.4**: Add Zod schemas for `mapping_suggestion` + `vocabularyGeneration` in `index-schemas.ts`
5. **ST-0.5**: Add `treeBuilder` to `defaults.ts` (USE_CASE_DEFAULTS + specificParams)
6. **ST-0.6**: Add `treeBuilder` to `metadata.ts` (USE_CASE_METADATA)
7. **ST-0.7**: Fix ALL `console.error` → `logger.error` in `knowledge-bases.ts` (lines 60, 147, 155, 183, 216, 281, 317 — 7 occurrences total)

#### Acceptance Criteria

- AC-0.1: `resolveRolePermissions('OWNER')` returns non-empty array
  - Verify: Unit test — call with 'OWNER', 'owner', 'Owner' — all return same permissions
- AC-0.2: New KB gets `embeddingModel: 'bge-m3'`, `embeddingDimensions: 1024`
  - Verify: `pnpm build --filter=search-ai`
- AC-0.3: `GET /llm-config/use-cases` returns 200 (not captured by `/:indexId`)
  - Verify: Route order in `indexes.ts` — static before parameterized
- AC-0.4: PATCH to `/llm-config` with `mapping_suggestion` data is NOT stripped
  - Verify: Zod parse preserves the field
- AC-0.5: `getAvailableUseCases()` includes `treeBuilder`
  - Verify: Check USE_CASE_DEFAULTS keys
- AC-0.6: Zero `console.error` calls in `knowledge-bases.ts`
  - Verify: `grep console.error knowledge-bases.ts` returns empty

---

### Task T-1: Navigation Store — Section/SubSection Support

**Package**: `apps/studio` (store only)
**Independent**: Yes (store file, no component overlap with T-2)

#### Files to Modify

| File                                                    | What Changes                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/studio/src/store/navigation-store.ts` (365 lines) | Add `section`/`subSection` to state, extend `parseUrl()`, `buildPath()`, add `setSection()` |

#### Current State (verified)

```typescript
// NavigationState interface (lines 77-96)
interface NavigationState {
  area: NavigationArea; // 'projects' | 'project' | 'admin' | 'settings'
  projectId: string | null;
  page: string | null; // e.g., 'search-ai'
  subPage: string | null; // e.g., kbId
  tab: string | null; // e.g., 'documents' (FLAT — one level)
  // ... actions
}

// parseUrl splits on '/' — parts[0..4]:
// /projects/:projectId/search-ai/:kbId/:tab
// parts[0]=projectId, parts[1]=page, parts[2]=subPage, parts[3]=tab

// buildPath constructs: /projects/${projectId}/${page}/${subPage}/${tab}

// setTab uses window.history.replaceState (no pushState)
```

#### Design: Repurpose `tab` as `section`, Add `subSection`

The current URL structure caps at 5 segments. The new 4-nav redesign needs:

```
/projects/:projectId/search-ai/:kbId/:section/:subSection
```

Where `section` = `home | data | intelligence | search` and `subSection` = intelligence drill-down (`pipeline | fields | vocabulary | knowledge-graph | llm-models`).

**Approach**: Repurpose existing `tab` field as `section`. Add new `subSection` field. This minimizes changes to `parseUrl`/`buildPath` since `tab` already occupies `parts[4]`.

#### Function Signatures (changes)

```typescript
// Updated NavigationState
interface NavigationState {
  area: NavigationArea;
  projectId: string | null;
  page: string | null;
  subPage: string | null;
  tab: string | null; // NOW: section for KB detail (home/data/intelligence/search)
  subSection: string | null; // NEW: drill-down within section
  sidebarCollapsed: boolean;
  breadcrumbs: Breadcrumb[];

  navigate: (path: string) => void;
  goBack: () => void;
  setTab: (tab: string | null) => void;
  setSubSection: (subSection: string | null) => void; // NEW
  setSidebarCollapsed: (collapsed: boolean) => void;
}
```

```typescript
// parseUrl — extend to read parts[5] for subSection
function parseUrl(
  pathname: string,
): Pick<NavigationState, 'area' | 'projectId' | 'page' | 'subPage' | 'tab' | 'subSection'> {
  // ... existing logic ...
  // After line 151 (tab extraction):
  const subSection = parts[5]?.split('?')[0] || null;
  return { area, projectId, page, subPage, tab, subSection };
}
```

```typescript
// buildPath — extend to append subSection
function buildPath(state: Partial<NavigationState>): string {
  // ... existing logic for /projects/${projectId}/${page}/${subPage}/${tab}
  // After tab:
  if (state.subSection) path += `/${state.subSection}`;
  return path;
}
```

```typescript
// NEW: setSubSection uses pushState (back-navigable, unlike setTab)
setSubSection: (subSection: string | null) => {
  const state = get();
  const newState = { ...state, subSection };
  const path = buildPath(newState);
  window.history.pushState({}, '', path);
  set({ subSection });
},
```

#### Subtasks

1. **ST-1.1**: Add `subSection: string | null` to `NavigationState` and `initialState`
2. **ST-1.2**: Extend `parseUrl()` to extract `parts[5]` as `subSection`
3. **ST-1.3**: Extend `buildPath()` to append `subSection` segment
4. **ST-1.4**: Add `setSubSection()` action using `pushState` (not `replaceState`)
5. **ST-1.5**: Update `popstate` handler — already handles via `parseUrl()`, just ensure `subSection` is in the setState call
6. **ST-1.6**: Update `buildBreadcrumbs()` to include subSection in breadcrumb trail

#### Acceptance Criteria

- AC-1.1: `parseUrl('/projects/p1/search-ai/kb1/intelligence/fields')` returns `{ tab: 'intelligence', subSection: 'fields' }`
- AC-1.2: `buildPath({ area: 'projects', projectId: 'p1', page: 'search-ai', subPage: 'kb1', tab: 'intelligence', subSection: 'fields' })` returns `/projects/p1/search-ai/kb1/intelligence/fields`
- AC-1.3: `setSubSection('pipeline')` pushes new history entry (not replace)
- AC-1.4: Browser back button after `setSubSection` returns to previous subSection
- AC-1.5: `parseUrl('/projects/p1/search-ai/kb1/home')` returns `{ tab: 'home', subSection: null }`
- AC-1.6: `pnpm build --filter=studio` succeeds with zero type errors

---

### Task T-2: KBDetailLayout + Rewire Detail Page

**Package**: `apps/studio` (components only)
**Independent**: Yes (component files, no store overlap with T-1)

#### Files to Create

| File                                                             | Purpose                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/studio/src/components/search-ai/layout/KBDetailLayout.tsx` | New 4-nav layout: persistent header + section tabs + content router |
| `apps/studio/src/components/search-ai/layout/KBHeader.tsx`       | Persistent header: KB name, inline metrics, status badge, gear icon |
| `apps/studio/src/components/search-ai/layout/KBSectionNav.tsx`   | 4-nav horizontal tabs: Home, Data, Intelligence, Search & Test      |
| `apps/studio/src/components/search-ai/layout/index.ts`           | Barrel export                                                       |

#### Files to Modify

| File                                                                           | What Changes                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/studio/src/components/search-ai/KnowledgeBaseDetailPage.tsx` (159 lines) | Replace `DetailPageShell` + 10-tab rendering with `KBDetailLayout` + section routing. Fix B-14 (line 112: `/search` → `/search-ai`). |

#### Design

**KBDetailLayout** replaces `DetailPageShell` for KB detail. Key differences:

- Full-width (no `max-w-5xl` constraint)
- Persistent header with inline metrics (not just title)
- 4 section tabs (not 10 flat tabs)
- Content area driven by `tab` (section) from navigation store

```
┌──────────────────────────────────────────────────────────────┐
│ KBHeader                                                      │
│ ← Back to KBs  |  KB Name  |  32 docs • 156 chunks  |  ⚙    │
├──────────────────────────────────────────────────────────────┤
│ KBSectionNav                                                  │
│ [Home]  [Data]  [Intelligence]  [Search & Test]              │
├──────────────────────────────────────────────────────────────┤
│ {sectionContent}                                              │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

#### Function Signatures

```typescript
// KBDetailLayout.tsx
interface KBDetailLayoutProps {
  knowledgeBase: KnowledgeBaseDetail;
  sources: SearchAISource[];
  isLoading: boolean;
  onRefresh: () => void;
  onRefreshSources: () => void;
}

export function KBDetailLayout(props: KBDetailLayoutProps): JSX.Element;
// Reads tab/subSection from useNavigationStore()
// Routes to section components based on tab value
```

```typescript
// KBHeader.tsx
interface KBHeaderProps {
  knowledgeBase: KnowledgeBaseDetail;
  onBack: () => void;
  onOpenSettings: () => void;
}

export function KBHeader(props: KBHeaderProps): JSX.Element;
// Shows: back arrow, KB name, inline metrics (doc count, chunk count, source count, last indexed)
// Status badge from knowledgeBase.status
// Gear icon button → onOpenSettings
```

```typescript
// KBSectionNav.tsx
interface KBSectionNavProps {
  activeSection: string; // from navigation store tab
  onSectionChange: (section: string) => void;
}

const SECTIONS = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'intelligence', label: 'Intelligence', icon: Brain },
  { id: 'search', label: 'Search & Test', icon: Search },
] as const;

export function KBSectionNav(props: KBSectionNavProps): JSX.Element;
```

#### Subtasks

1. **ST-2.1**: Create `KBHeader.tsx` — persistent header with back button, KB name, inline metrics, status badge, gear icon
2. **ST-2.2**: Create `KBSectionNav.tsx` — 4 horizontal tabs using existing `Tabs` component (from `../ui/Tabs`)
3. **ST-2.3**: Create `KBDetailLayout.tsx` — composes KBHeader + KBSectionNav + section content router
4. **ST-2.4**: Rewire `KnowledgeBaseDetailPage.tsx`:
   - Replace `DetailPageShell` with `KBDetailLayout`
   - Remove 10-tab definition array
   - Section content router renders placeholder divs for now (Wave 2 fills them)
   - Fix back button (line 112): `/projects/${projectId}/search` → `/projects/${projectId}/search-ai`
   - Default section: `home` when tab is null
5. **ST-2.5**: Create `layout/index.ts` barrel export

#### Acceptance Criteria

- AC-2.1: URL `/projects/p1/search-ai/kb1` renders KBDetailLayout with Home section active
- AC-2.2: Clicking "Data" tab navigates to `/projects/p1/search-ai/kb1/data`
- AC-2.3: Back button navigates to `/projects/${projectId}/search-ai` (not `/search`)
- AC-2.4: Header shows KB name, doc count, chunk count from `useKnowledgeBase` data
- AC-2.5: Gear icon is visible (functionality in T-7)
- AC-2.6: `pnpm build --filter=studio` succeeds

---

## Wave 2: Section Shells + Backend APIs

---

### Task T-3: Intelligence Hub + 5 Sub-Routes

**Package**: `apps/studio` (intelligence section)
**Independent**: Yes (of T-4, T-5, T-6, T-7 — different component directories)

#### Files to Create

| File                                                                             | Purpose                                            |
| -------------------------------------------------------------------------------- | -------------------------------------------------- |
| `apps/studio/src/components/search-ai/intelligence/IntelligenceSection.tsx`      | Hub view + sub-route content router                |
| `apps/studio/src/components/search-ai/intelligence/IntelligenceHub.tsx`          | 5 adaptive-state cards grid                        |
| `apps/studio/src/components/search-ai/intelligence/IntelligenceSubNav.tsx`       | Persistent sub-navigation tabs (Atlassian pattern) |
| `apps/studio/src/components/search-ai/intelligence/cards/PipelineCard.tsx`       | Pipeline status card (4 states)                    |
| `apps/studio/src/components/search-ai/intelligence/cards/FieldsCard.tsx`         | Fields status card (4 states)                      |
| `apps/studio/src/components/search-ai/intelligence/cards/VocabularyCard.tsx`     | Vocabulary status card (4 states)                  |
| `apps/studio/src/components/search-ai/intelligence/cards/KnowledgeGraphCard.tsx` | KG status card (4 states)                          |
| `apps/studio/src/components/search-ai/intelligence/cards/LLMModelsCard.tsx`      | LLM Models status card (4 states)                  |
| `apps/studio/src/components/search-ai/intelligence/cards/IntelligenceCard.tsx`   | Shared card shell with 4-state rendering           |
| `apps/studio/src/components/search-ai/intelligence/index.ts`                     | Barrel export                                      |

#### Files to Modify

| File                                                             | What Changes                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/studio/src/components/search-ai/layout/KBDetailLayout.tsx` | Import and render `IntelligenceSection` when `tab === 'intelligence'` |

#### Design: IntelligenceSection Routing

```
tab === 'intelligence' && subSection === null  →  IntelligenceHub (card grid)
tab === 'intelligence' && subSection !== null  →  IntelligenceSubNav + wrapped component

subSection mapping:
  'pipeline'         → <PipelineEditor projectId={} knowledgeBaseId={} knowledgeBaseName={} />
  'fields'           → <FieldsTab indexId={} sources={} />
  'vocabulary'       → <VocabularyTab indexId={} />
  'knowledge-graph'  → <KnowledgeGraphTab indexId={} />
  'llm-models'       → <SettingsTab indexId={} />  (LLM features section only)
```

#### Card State Machine (shared across all 5 cards)

```typescript
type IntelligenceCardState = 'not-configured' | 'healthy' | 'needs-attention' | 'error';

interface IntelligenceCardProps {
  title: string;
  icon: LucideIcon;
  state: IntelligenceCardState;
  stats: { label: string; value: string | number }[];
  description: string;
  actionLabel: string;
  onAction: () => void; // navigates to sub-route
  attentionMessage?: string; // shown in needs-attention state
  errorMessage?: string; // shown in error state
}
```

#### Card State Derivation

| Card       | not-configured         | healthy                        | needs-attention               | error               |
| ---------- | ---------------------- | ------------------------------ | ----------------------------- | ------------------- |
| Pipeline   | No published pipeline  | Published, 0 validation errors | Has warnings                  | Has errors          |
| Fields     | 0 confirmed fields     | confirmed > 0, suggested = 0   | suggested > 0 awaiting review | —                   |
| Vocabulary | No vocabulary doc      | Active vocabulary              | —                             | Generation failed   |
| KG         | `!kgEnabled`           | Taxonomy exists                | —                             | KG processing error |
| LLM Models | All use cases disabled | ≥1 enabled, no circuit break   | Circuit breaker open          | —                   |

#### Function Signatures

```typescript
// IntelligenceSection.tsx
interface IntelligenceSectionProps {
  indexId: string;
  projectId: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  sources: SearchAISource[];
}
export function IntelligenceSection(props: IntelligenceSectionProps): JSX.Element;
// Reads subSection from useNavigationStore()
// subSection === null → <IntelligenceHub />
// subSection !== null → <IntelligenceSubNav /> + wrapped child
```

```typescript
// IntelligenceHub.tsx
interface IntelligenceHubProps {
  indexId: string;
}
export function IntelligenceHub(props: IntelligenceHubProps): JSX.Element;
// Fetches stats via existing hooks: useFieldsTabStats, useKGConfigurationStatus, useSWR for pipeline/vocabulary
// Renders 5 IntelligenceCard instances in 2x3 grid
```

```typescript
// IntelligenceSubNav.tsx
interface IntelligenceSubNavProps {
  activeSubSection: string;
  onSubSectionChange: (subSection: string) => void;
}
const SUB_SECTIONS = [
  { id: 'pipeline', label: 'Pipeline', icon: Workflow },
  { id: 'fields', label: 'Fields', icon: TableProperties },
  { id: 'vocabulary', label: 'Vocabulary', icon: BookOpen },
  { id: 'knowledge-graph', label: 'Knowledge Graph', icon: Share2 },
  { id: 'llm-models', label: 'LLM Models', icon: Cpu },
] as const;
```

#### Subtasks

1. **ST-3.1**: Create `IntelligenceCard.tsx` — shared card component with 4-state visual rendering
2. **ST-3.2**: Create 5 card components (PipelineCard, FieldsCard, VocabularyCard, KGCard, LLMModelsCard) — each derives state from hooks and renders IntelligenceCard
3. **ST-3.3**: Create `IntelligenceHub.tsx` — card grid layout
4. **ST-3.4**: Create `IntelligenceSubNav.tsx` — horizontal tabs for sub-routes
5. **ST-3.5**: Create `IntelligenceSection.tsx` — routing logic (hub vs sub-route) + wrapping existing tab components
6. **ST-3.6**: Wire into `KBDetailLayout.tsx` — render IntelligenceSection when `tab === 'intelligence'`
7. **ST-3.7**: Fix FieldsTab SWR error swallowing (B-5) — replace `{ onError: () => {} }` with proper error handler in FieldsTab.tsx line 127

#### Acceptance Criteria

- AC-3.1: `/projects/p1/search-ai/kb1/intelligence` shows 5 cards in grid
- AC-3.2: Clicking Pipeline card navigates to `/intelligence/pipeline`
- AC-3.3: Sub-nav tabs visible in drill-down view, allow jumping between sub-routes
- AC-3.4: PipelineEditor renders correctly at `/intelligence/pipeline` with correct props (`projectId`, `knowledgeBaseId`, `knowledgeBaseName`)
- AC-3.5: FieldsTab renders at `/intelligence/fields` with `indexId` and `sources` props
- AC-3.6: Each card shows correct state (not-configured for empty KB, healthy for configured)
- AC-3.7: FieldsTab no longer silently swallows SWR errors
- AC-3.8: `pnpm build --filter=studio` succeeds

---

### Task T-4: Data Section

**Package**: `apps/studio` (data section)
**Independent**: Yes (of T-3, T-5, T-6, T-7)

#### Files to Create

| File                                                                | Purpose                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/studio/src/components/search-ai/data/DataSection.tsx`         | Main data view: source filters + paginated doc table |
| `apps/studio/src/components/search-ai/data/SourceFilterBar.tsx`     | Source type badges + dropdown filter                 |
| `apps/studio/src/components/search-ai/data/DocumentTable.tsx`       | Paginated document table with compound status        |
| `apps/studio/src/components/search-ai/data/AddSourceButton.tsx`     | +Add Source button triggering ConnectorsTab dialog   |
| `apps/studio/src/components/search-ai/data/CrawlerSourceDetail.tsx` | Crawler source detail with sub-nav                   |
| `apps/studio/src/components/search-ai/data/index.ts`                | Barrel export                                        |

#### Files to Modify

| File                                                             | What Changes                               |
| ---------------------------------------------------------------- | ------------------------------------------ |
| `apps/studio/src/components/search-ai/layout/KBDetailLayout.tsx` | Render `DataSection` when `tab === 'data'` |

#### Design: DataSection Layout

```
┌─────────────────────────────────────────────────────────────┐
│ DataSection                                                  │
│ ┌──────────────────────────────────────────────────────────┐│
│ │ SourceFilterBar                              [+Add Source]││
│ │ [All: 156] [Web: 89] [SharePoint: 45] [File: 22] [▼]   ││
│ └──────────────────────────────────────────────────────────┘│
│ ┌──────────────────────────────────────────────────────────┐│
│ │ DocumentTable (paginated)                                 ││
│ │ Title | Source | Status | Updated | Actions               ││
│ │ ...                                                       ││
│ │ Page 1 of 4  [<] [>]                                     ││
│ └──────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

#### Function Signatures

```typescript
// DataSection.tsx
interface DataSectionProps {
  indexId: string;
  sources: SearchAISource[];
  onRefresh: () => void;
  onRefreshSources: () => void;
}
export function DataSection(props: DataSectionProps): JSX.Element;
// Manages: selectedSourceFilter, currentPage, searchQuery
// If subSection matches a source ID for web/crawler → render CrawlerSourceDetail
// Otherwise → SourceFilterBar + DocumentTable
```

```typescript
// SourceFilterBar.tsx
interface SourceFilterBarProps {
  sources: SearchAISource[];
  activeFilter: string | null; // null = All, or sourceType string
  onFilterChange: (sourceType: string | null) => void;
  onAddSource: () => void;
}
```

```typescript
// DocumentTable.tsx
interface DocumentTableProps {
  indexId: string;
  sourceFilter: string | null; // sourceType or specific sourceId
  searchQuery: string;
}
export function DocumentTable(props: DocumentTableProps): JSX.Element;
// Uses SWR with fetchDocuments(indexId, { limit, offset, sourceId, status, search })
// Renders paginated table with compound status column
// Row click → opens document detail (T-18, placeholder for now)
```

```typescript
// AddSourceButton.tsx
interface AddSourceButtonProps {
  indexId: string;
  onSourceAdded: () => void;
}
export function AddSourceButton(props: AddSourceButtonProps): JSX.Element;
// Renders button that opens ConnectorsTab's add dialog inline
// For enterprise types, opens EnterpriseConnectorWizard
```

```typescript
// CrawlerSourceDetail.tsx
interface CrawlerSourceDetailProps {
  indexId: string;
  sourceId: string;
  onBack: () => void;
}
export function CrawlerSourceDetail(props: CrawlerSourceDetailProps): JSX.Element;
// Wraps existing CrawlerTab with back navigation
// Guards auto-create: only creates source if explicitly requested (D-8 mitigation)
```

#### Subtasks

1. **ST-4.1**: Create `SourceFilterBar.tsx` — badges derived from source list grouped by `sourceType`, count per type
2. **ST-4.2**: Create `DocumentTable.tsx` — paginated table using existing `fetchDocuments` API with `limit`/`offset` params. Compound status column shows doc status + chunk error indicator.
3. **ST-4.3**: Create `AddSourceButton.tsx` — opens inline dialog with connector type selection. Reuse ConnectorsTab's two-step dialog pattern (extract if needed).
4. **ST-4.4**: Create `CrawlerSourceDetail.tsx` — wrap `CrawlerTab` with conditional mount guard (prevent auto-source-creation on mount unless user explicitly chose "Web Crawler" source type)
5. **ST-4.5**: Create `DataSection.tsx` — compose SourceFilterBar + DocumentTable + AddSourceButton. Handle subSection routing for crawler detail.
6. **ST-4.6**: Wire into `KBDetailLayout.tsx`

#### Acceptance Criteria

- AC-4.1: `/projects/p1/search-ai/kb1/data` shows source filter badges + document table
- AC-4.2: Clicking a source badge filters documents to that source type
- AC-4.3: Document table shows pagination controls (next/prev/page number)
- AC-4.4: +Add Source button opens connector type selection
- AC-4.5: Crawler source detail renders CrawlerTab content with back nav
- AC-4.6: No unwanted source auto-creation when switching to Data section

---

### Task T-5: Search & Test Section

**Package**: `apps/studio` (search section)
**Independent**: Yes

#### Files to Create

| File                                                                   | Purpose                                                        |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `apps/studio/src/components/search-ai/search/SearchTestSection.tsx`    | Main section: playground wrapper + diagnostic card + utilities |
| `apps/studio/src/components/search-ai/search/QueryDiagnosticCard.tsx`  | 3-category diagnostic with action links                        |
| `apps/studio/src/components/search-ai/search/CopyApiCallButton.tsx`    | Copy API Call / Copy as cURL                                   |
| `apps/studio/src/components/search-ai/search/TestVocabularyButton.tsx` | Test Vocabulary dry-run                                        |
| `apps/studio/src/components/search-ai/search/index.ts`                 | Barrel export                                                  |

#### Files to Modify

| File                                                             | What Changes                                       |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| `apps/studio/src/components/search-ai/layout/KBDetailLayout.tsx` | Render `SearchTestSection` when `tab === 'search'` |

#### Function Signatures

```typescript
// SearchTestSection.tsx
interface SearchTestSectionProps {
  indexId: string;
}
export function SearchTestSection(props: SearchTestSectionProps): JSX.Element;
// Layout: QueryPlaygroundTab on left (2/3), diagnostic sidebar on right (1/3)
// Below playground: CopyApiCallButton + TestVocabularyButton
```

```typescript
// QueryDiagnosticCard.tsx
interface QueryDiagnosticCardProps {
  indexId: string;
}
// 3 categories:
// 1. Data & Indexing: doc count, chunk count, last indexed, error docs
// 2. Enrichment: vocabulary status, field mapping stats, KG status
// 3. Pipeline Health: circuit breaker status, embedding model, pipeline validation
// Each issue links to the relevant Intelligence sub-route
```

```typescript
// CopyApiCallButton.tsx
interface CopyApiCallButtonProps {
  indexId: string;
  query: string;
  queryType: string;
  topK: number;
}
export function CopyApiCallButton(props: CopyApiCallButtonProps): JSX.Element;
// Dropdown: "Copy API Call" (JSON body), "Copy as cURL" (full curl command)
```

#### Subtasks

1. **ST-5.1**: Create `QueryDiagnosticCard.tsx` — fetch stats from existing endpoints, render 3-category diagnostics
2. **ST-5.2**: Create `CopyApiCallButton.tsx` — builds JSON/cURL from current query state
3. **ST-5.3**: Create `TestVocabularyButton.tsx` — calls `resolveVocabulary` with current query, shows inline results
4. **ST-5.4**: Create `SearchTestSection.tsx` — wraps existing `QueryPlaygroundTab` + adds diagnostic + utilities
5. **ST-5.5**: Wire into `KBDetailLayout.tsx`

#### Acceptance Criteria

- AC-5.1: Search section renders existing playground with query functionality intact
- AC-5.2: Diagnostic card shows 3 categories with real data from existing endpoints
- AC-5.3: "Copy as cURL" copies valid curl command to clipboard
- AC-5.4: "Test Vocabulary" button shows resolution results inline
- AC-5.5: Diagnostic issues link to correct Intelligence sub-routes

---

### Task T-6: Home Section — Adaptive 3-State

**Package**: `apps/studio` (home section)
**Independent**: Yes

#### Files to Create

| File                                                                | Purpose                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/studio/src/components/search-ai/home/HomeSection.tsx`         | State router: setup / progress / operations          |
| `apps/studio/src/components/search-ai/home/SetupGuide.tsx`          | State 1: setup checklist + upload zone + LLM banner  |
| `apps/studio/src/components/search-ai/home/ProgressView.tsx`        | State 2: processing progress + checklist transitions |
| `apps/studio/src/components/search-ai/home/OperationsDashboard.tsx` | State 3: mature KB dashboard shell                   |
| `apps/studio/src/components/search-ai/home/UploadDropZone.tsx`      | Real drag-and-drop upload (fixes B-11)               |
| `apps/studio/src/components/search-ai/home/index.ts`                | Barrel export                                        |

#### Design: 3-State Machine

```typescript
type KBHomeState = 'setup' | 'progress' | 'operations';

function deriveHomeState(kb: KnowledgeBaseDetail, sources: SearchAISource[]): KBHomeState {
  if (kb.documentCount === 0 && sources.length === 0) return 'setup';
  if (kb.status === 'creating' || kb.status === 'indexing' || kb.status === 'error')
    return 'progress';
  return 'operations';
}
```

#### Function Signatures

```typescript
// HomeSection.tsx
interface HomeSectionProps {
  knowledgeBase: KnowledgeBaseDetail;
  sources: SearchAISource[];
  onRefresh: () => void;
  onRefreshSources: () => void;
}
export function HomeSection(props: HomeSectionProps): JSX.Element;
```

```typescript
// SetupGuide.tsx
interface SetupGuideProps {
  knowledgeBase: KnowledgeBaseDetail;
  indexId: string;
  sources: SearchAISource[];
  onSourceAdded: () => void;
}
// Renders: checklist (Add data source ✓, Configure pipeline, Run first search)
// UploadDropZone for quick file upload
// LLM status banner (configured / needs setup)
// "What happens automatically" expandable section
```

```typescript
// UploadDropZone.tsx
interface UploadDropZoneProps {
  indexId: string;
  onUploadComplete: () => void;
}
export function UploadDropZone(props: UploadDropZoneProps): JSX.Element;
// Real drag-and-drop: onDrop, onDragOver, onDragLeave handlers
// Uses existing document-upload API: POST /api/indexes/:indexId/sources/:sourceId/documents
// Find-or-create "File Upload" source using useRef guard to prevent duplicate creation:
//   1. Check sources list for existing file-type source
//   2. If none, POST to create source with useRef.current guard (prevent concurrent calls)
//   3. Use the returned sourceId for upload
```

```typescript
// ProgressView.tsx
interface ProgressViewProps {
  knowledgeBase: KnowledgeBaseDetail;
  indexId: string;
}
// SWR polling (PROGRESS_POLL_INTERVAL_MS = 5000) for document processing status
// Pattern: ConnectorDocumentsDialog SWR polling (not WebSocket)
// Shows: "8 of 23 documents indexed" progress bar
// Checklist with state transitions (extracting → embedding → indexed)
```

```typescript
// OperationsDashboard.tsx
interface OperationsDashboardProps {
  knowledgeBase: KnowledgeBaseDetail;
  indexId: string;
}
// Shell for mature KB state. Contains:
// - Quick stats row (doc count, chunk count, sources, last indexed)
// - Placeholder for Needs Attention (T-23) and Activity Feed (T-24)
```

#### Subtasks

1. **ST-6.1**: Create `UploadDropZone.tsx` — real drag-and-drop with `onDrop`/`onDragOver`/`onDragLeave`, file type validation, size limit display (100MB)
2. **ST-6.2**: Create `SetupGuide.tsx` — checklist, upload zone, LLM banner
3. **ST-6.3**: Create `ProgressView.tsx` — SWR polling (5s) for doc status aggregation, progress bar
4. **ST-6.4**: Create `OperationsDashboard.tsx` — stats row + placeholder cards for T-23/T-24
5. **ST-6.5**: Create `HomeSection.tsx` — state derivation + routing
6. **ST-6.6**: Wire into `KBDetailLayout.tsx`

#### Acceptance Criteria

- AC-6.1: Empty KB shows SetupGuide with checklist
- AC-6.2: Drag-and-drop a file onto UploadDropZone starts upload (real `onDrop` handlers, not fake)
- AC-6.3: Processing KB shows ProgressView with "X of Y documents indexed"
- AC-6.4: Mature KB shows OperationsDashboard with stats
- AC-6.5: State transitions happen automatically as data changes (SWR revalidation)
- AC-6.6: LLM status banner shows whether LLM is configured

---

### Task T-7: Settings SlidePanel

**Package**: `apps/studio` (settings)
**Independent**: Yes

#### Files to Create

| File                                                                   | Purpose                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| `apps/studio/src/components/search-ai/settings/SettingsPanel.tsx`      | SlidePanel wrapper for settings content        |
| `apps/studio/src/components/search-ai/settings/GeneralSection.tsx`     | Name, description, visibility, createdBy       |
| `apps/studio/src/components/search-ai/settings/IndexConfigSection.tsx` | Embedding model, vector store, search defaults |
| `apps/studio/src/components/search-ai/settings/DangerZoneSection.tsx`  | Rebuild Index + Delete KB                      |
| `apps/studio/src/components/search-ai/settings/index.ts`               | Barrel export                                  |

#### Files to Modify

| File                                                             | What Changes                                     |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| `apps/studio/src/components/ui/SlidePanel.tsx` (109 lines)       | Add `xl` width option (`max-w-xl` = 36rem/576px) |
| `apps/studio/src/components/search-ai/layout/KBDetailLayout.tsx` | Add settings panel state + gear icon handler     |

#### Function Signatures

```typescript
// SlidePanel.tsx — extend width
width?: 'sm' | 'md' | 'lg' | 'xl';  // add 'xl'
// Width map update: xl: 'max-w-xl'

// SettingsPanel.tsx
interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  knowledgeBase: KnowledgeBaseDetail;
  onRefresh: () => void;
}
export function SettingsPanel(props: SettingsPanelProps): JSX.Element;
// Uses SlidePanel with width="xl"
// Sections: GeneralSection + IndexConfigSection + DangerZoneSection
```

```typescript
// GeneralSection.tsx
interface GeneralSectionProps {
  knowledgeBase: KnowledgeBaseDetail;
  onUpdate: () => void;
}
// Fields: name (editable), description (editable), visibility toggle, createdBy (read-only)
```

```typescript
// DangerZoneSection.tsx
interface DangerZoneSectionProps {
  knowledgeBase: KnowledgeBaseDetail;
  onDeleted: () => void;
}
// Rebuild Index button with ConfirmDialog
// Delete KB button with ConfirmDialog (navigate back to KB list on success)
```

#### Subtasks

1. **ST-7.1**: Extend `SlidePanel.tsx` — add `xl` width option
2. **ST-7.2**: Create `GeneralSection.tsx` — editable name/description, read-only fields
3. **ST-7.3**: Create `IndexConfigSection.tsx` — embedding model, vector store info (read-only display)
4. **ST-7.4**: Create `DangerZoneSection.tsx` — rebuild + delete with confirmation dialogs (reuse patterns from KBOverviewTab actions)
5. **ST-7.5**: Create `SettingsPanel.tsx` — compose sections in SlidePanel
6. **ST-7.6**: Wire gear icon in `KBHeader.tsx` to open SettingsPanel

#### Acceptance Criteria

- AC-7.1: Gear icon in header opens Settings SlidePanel from right
- AC-7.2: Panel shows General, Index Config, Danger Zone sections
- AC-7.3: Name/description are editable with save
- AC-7.4: Delete KB prompts confirmation, then navigates to KB list
- AC-7.5: Rebuild Index prompts confirmation, then triggers rebuild
- AC-7.6: Panel closes on Escape, backdrop click, or close button

---

### Task T-10: KB List Pagination + Search API

**Package**: `apps/search-ai` (routes)
**Independent**: Yes

#### Files to Modify

| File                                                         | What Changes                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `apps/search-ai/src/routes/knowledge-bases.ts` (lines 47-63) | Add `search`, `status`, `sortBy`, `sortOrder`, `limit`, `offset` query params |

#### Current Code (lines 47-63)

```typescript
router.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantContext!.tenantId;
  const { projectId, status } = req.query;
  const filter: Record<string, unknown> = { tenantId };
  if (projectId) filter.projectId = projectId;
  if (status) filter.status = status;
  const knowledgeBases = await KnowledgeBase.find(filter).sort({ createdAt: -1 }).lean();
  res.json({ knowledgeBases, total: knowledgeBases.length });
```

#### Function Signatures (after change)

```typescript
// Shared utility (add to apps/search-ai/src/utils/query-helpers.ts)
const ALLOWED_KB_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'status'] as const;
type KBSortField = (typeof ALLOWED_KB_SORT_FIELDS)[number];

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.get('/', async (req: Request, res: Response) => {
  const tenantId = req.tenantContext!.tenantId;
  const { projectId, status, search, sortBy, sortOrder } = req.query;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;

  const filter: Record<string, unknown> = { tenantId };
  if (projectId) filter.projectId = projectId;
  if (status) filter.status = status;
  if (search) filter.name = { $regex: escapeRegex(search as string), $options: 'i' };

  const sortField: KBSortField = ALLOWED_KB_SORT_FIELDS.includes(sortBy as KBSortField)
    ? (sortBy as KBSortField)
    : 'createdAt';
  const sortDir = sortOrder === 'asc' ? 1 : -1;

  const [knowledgeBases, total] = await Promise.all([
    KnowledgeBase.find(filter)
      .sort({ [sortField]: sortDir })
      .skip(offset)
      .limit(limit)
      .lean(),
    KnowledgeBase.countDocuments(filter),
  ]);

  res.json({
    knowledgeBases,
    total,
    pagination: { limit, offset, hasMore: offset + knowledgeBases.length < total },
  });
});
```

**Standardized pagination response shape** (used by ALL new endpoints):

```typescript
{
  [itemsKey]: T[],           // e.g., knowledgeBases, sources, documents
  total: number,              // total count in DB (top level, consistent with existing documents.ts)
  pagination: {
    limit: number,
    offset: number,
    hasMore: boolean,
  }
}
```

#### Subtasks

1. **ST-10.1**: Create `apps/search-ai/src/utils/query-helpers.ts` with `escapeRegex()` + `ALLOWED_KB_SORT_FIELDS`
2. **ST-10.2**: Parse `limit`, `offset`, `search`, `sortBy`, `sortOrder` from `req.query`
3. **ST-10.3**: Add escaped regex filter when `search` provided
4. **ST-10.4**: Whitelist `sortBy` against `ALLOWED_KB_SORT_FIELDS` (default: `createdAt`)
5. **ST-10.5**: Replace unbounded `find()` with `find().skip().limit()` + parallel `countDocuments()`
6. **ST-10.6**: Return standardized pagination response
7. **ST-10.7**: Replace `console.error` with `logger.error` (line 60)

#### Acceptance Criteria

- AC-10.1: `GET /knowledge-bases?limit=10&offset=0` returns max 10 results with `pagination.hasMore`
- AC-10.2: `GET /knowledge-bases?search=customer` returns only KBs with "customer" in name
- AC-10.3: `GET /knowledge-bases?search=.*` does NOT cause ReDoS (regex escaped)
- AC-10.4: `GET /knowledge-bases?sortBy=__proto__` defaults to `createdAt` (whitelist enforced)
- AC-10.5: `total` reflects full count (not page count)
- AC-10.5: Zero `console.error` in the file

---

### Task T-11: Source Pagination + Search + Summary API

**Package**: `apps/search-ai` (routes) + `packages/database`
**Independent**: Yes

#### Files to Modify

| File                                                            | What Changes                          |
| --------------------------------------------------------------- | ------------------------------------- |
| `apps/search-ai/src/routes/sources.ts` (lines 28-47)            | Add pagination + search + type filter |
| `packages/database/src/models/search-source.model.ts` (line 68) | Add text index on `name` field        |

#### Files to Add

New endpoint in `sources.ts`:

```typescript
// GET /:indexId/sources/summary — grouped counts by sourceType
router.get('/:indexId/sources/summary', async (req, res) => {
  const { indexId } = req.params;
  const tenantId = req.tenantContext!.tenantId;
  const summary = await SearchSource.aggregate([
    { $match: { indexId, tenantId } },
    { $group: { _id: '$sourceType', count: { $sum: 1 }, totalDocs: { $sum: '$documentCount' } } },
    { $sort: { count: -1 } },
  ]);
  res.json({ summary, total: summary.reduce((s, g) => s + g.count, 0) });
});
```

**CRITICAL**: Register `/summary` route BEFORE `/:sourceId` parameterized routes to avoid Express capture.

#### Subtasks

1. **ST-11.1**: Add pagination params to source list endpoint (follow documents.ts pattern + standardized response shape)
2. **ST-11.2**: Add `search` param with `name: { $regex: escapeRegex(search), $options: 'i' }` filter (use shared `escapeRegex` from `query-helpers.ts`)
3. **ST-11.3**: Add `sourceType` filter param
4. **ST-11.4**: Add `GET /:indexId/sources/summary` aggregation endpoint
5. **ST-11.5**: Add text index on `SearchSource.name` in model schema
6. **ST-11.6**: Ensure summary route registered BEFORE any `/:sourceId` parameterized routes

#### Acceptance Criteria

- AC-11.1: `GET /:indexId/sources?limit=10&search=share` returns paginated results
- AC-11.2: `GET /:indexId/sources/summary` returns `[{ _id: 'web', count: 3, totalDocs: 89 }, ...]`
- AC-11.3: Summary route is reachable (not captured by `:sourceId`)

---

### Task T-12: Chunk Status Filter

**Package**: `apps/search-ai` (routes)
**Independent**: Yes

#### Files to Modify

| File                                                | What Changes                       |
| --------------------------------------------------- | ---------------------------------- |
| `apps/search-ai/src/routes/chunks.ts` (lines 29-85) | Add `status` query param to filter |

#### Subtasks

1. **ST-12.1**: Parse `status` from `req.query` (accept comma-separated for multi-status: `?status=error,pending`)
2. **ST-12.2**: Build filter object with conditional `status` inclusion (use `$in` for multiple)
3. **ST-12.3**: Apply filter to both `find()` and `countDocuments()` calls

#### Acceptance Criteria

- AC-12.1: `GET /:indexId/documents/:docId/chunks?status=error` returns only error chunks
- AC-12.2: `GET /:indexId/documents/:docId/chunks?status=error,pending` returns both statuses
- AC-12.3: Pagination total reflects filtered count

---

### Task T-13: KB `createdBy` Field

**Package**: `packages/database` + `apps/search-ai`
**Independent**: Yes

#### Files to Modify

| File                                                                        | What Changes                          |
| --------------------------------------------------------------------------- | ------------------------------------- |
| `packages/database/src/models/knowledge-base.model.ts` (lines 18-40, 44-63) | Add `createdBy` to interface + schema |
| `apps/search-ai/src/routes/knowledge-bases.ts` (line 130)                   | Store `createdBy` on KB creation      |

#### Subtasks

1. **ST-13.1**: Add `createdBy?: string` to `IKnowledgeBase` interface (optional for backward compat)
2. **ST-13.2**: Add `createdBy: { type: String, default: 'system' }` to schema (NOT required — existing docs lack it)
3. **ST-13.3**: Store `createdBy: (req as any).userId || 'system'` in POST create handler

#### Acceptance Criteria

- AC-13.1: New KB has `createdBy` set to the creating user's ID
- AC-13.2: Existing KBs (without `createdBy`) don't fail on read — field defaults to undefined/system
- AC-13.3: `pnpm build --filter=database --filter=search-ai` succeeds

---

### Task T-14: Bulk Retry Failed Documents

**Package**: `apps/search-ai` (routes)
**Independent**: Yes

#### Files to Modify

| File                                                    | What Changes                    |
| ------------------------------------------------------- | ------------------------------- |
| `apps/search-ai/src/routes/errors.ts` (before line 241) | Add `POST /bulk-retry` endpoint |

#### Function Signatures

```typescript
// New endpoint — MUST be registered BEFORE /:documentId routes
router.post(
  '/bulk-retry',
  requirePermission('admin:errors:retry'),
  async (req: Request, res: Response) => {
    const tenantId = req.tenantContext!.tenantId;
    const { documentIds } = req.body;

    // Validate: array of strings, max 100
    if (!Array.isArray(documentIds) || documentIds.length === 0 || documentIds.length > 100) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'documentIds must be array of 1-100 IDs' },
      });
    }

    const result = await SearchDocument.updateMany(
      { _id: { $in: documentIds }, tenantId, status: DocumentStatus.ERROR },
      { $set: { status: DocumentStatus.PENDING, processingError: null, updatedAt: new Date() } },
    );

    res.json({
      success: true,
      modifiedCount: result.modifiedCount,
      requestedCount: documentIds.length,
    });
  },
);
```

#### Subtasks

1. **ST-14.1**: Add `POST /bulk-retry` endpoint in `errors.ts` BEFORE `/:documentId` routes
2. **ST-14.2**: Validate request body (array, max 100, non-empty)
3. **ST-14.3**: Use `updateMany` with tenant isolation + status guard

#### Acceptance Criteria

- AC-14.1: `POST /bulk-retry` with `{ documentIds: [...] }` resets all matching error docs to pending
- AC-14.2: Non-error docs are not affected (status guard)
- AC-14.3: Max 100 IDs enforced
- AC-14.4: Route is reachable (not captured by `/:documentId`)

---

### Task T-15: Compound Document Status Aggregation

**Package**: `apps/search-ai` (routes)
**Independent**: Yes

#### Files to Modify

| File                                                   | What Changes                                         |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `apps/search-ai/src/routes/documents.ts` (lines 30-85) | Enhance status filter + add compound status endpoint |

#### Function Signatures

```typescript
// Enhance existing GET /:indexId/documents — support comma-separated status
// Change line 53 from: if (status) filter.status = status;
// To:
if (status) {
  const statuses = (status as string).split(',');
  filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
}

// NEW endpoint — register BEFORE any /:documentId routes
router.get('/:indexId/documents/status-summary', async (req, res) => {
  const { indexId } = req.params;
  const tenantId = req.tenantContext!.tenantId;

  const [docStatusCounts, chunkErrorCounts] = await Promise.all([
    SearchDocument.aggregate([
      { $match: { indexId, tenantId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    SearchChunk.aggregate([
      { $match: { indexId, tenantId, status: 'error' } },
      { $group: { _id: '$documentId', errorCount: { $sum: 1 } } },
      { $count: 'docsWithChunkErrors' },
    ]),
  ]);

  res.json({
    documentStatuses: docStatusCounts,
    docsWithChunkErrors: chunkErrorCounts[0]?.docsWithChunkErrors ?? 0,
  });
});
```

**CRITICAL**: Register `/status-summary` BEFORE `/:documentId` parameterized routes.

#### Subtasks

1. **ST-15.1**: Enhance status filter to support comma-separated values
2. **ST-15.2**: Add `GET /:indexId/documents/status-summary` aggregation endpoint
3. **ST-15.3**: Ensure route ordering (static before parameterized)

#### Acceptance Criteria

- AC-15.1: `GET /:indexId/documents?status=error,pending` returns both statuses
- AC-15.2: `GET /:indexId/documents/status-summary` returns `{ documentStatuses: [...], docsWithChunkErrors: N }`
- AC-15.3: Route is reachable (not captured by `/:documentId`)

---

## Wave 3: Tier 3 Backend + Tier 2 Frontend Consumers

---

### Task T-8: Tests for Wave 1-2 Frontend

**Package**: `apps/studio`
**Independent**: Yes

#### Files to Create

| File                                                                                   | Purpose                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `apps/studio/src/store/__tests__/navigation-store.test.ts`                             | Unit tests for parseUrl, buildPath, setSubSection |
| `apps/studio/src/components/search-ai/layout/__tests__/KBDetailLayout.test.tsx`        | Render tests for layout + section routing         |
| `apps/studio/src/components/search-ai/intelligence/__tests__/IntelligenceHub.test.tsx` | Card state derivation + rendering tests           |
| `apps/studio/src/components/search-ai/home/__tests__/HomeSection.test.tsx`             | 3-state derivation tests                          |
| `apps/studio/src/components/search-ai/data/__tests__/DataSection.test.tsx`             | Filter + pagination integration tests             |

#### Subtasks

1. **ST-8.1**: Navigation store tests — `parseUrl` with section/subSection URLs, `buildPath` round-trip, `setSubSection` pushState behavior
2. **ST-8.2**: KBDetailLayout tests — renders correct section based on tab, back button URL, header metrics
3. **ST-8.3**: IntelligenceHub tests — card state derivation for each of 5 cards × 4 states
4. **ST-8.4**: HomeSection tests — 3-state machine transitions
5. **ST-8.5**: DataSection tests — source filter badges, pagination controls

#### Acceptance Criteria

- AC-8.1: All tests pass with `pnpm vitest run apps/studio/src/store/__tests__/navigation-store.test.ts`
- AC-8.2: Card state logic covered for all combinations
- AC-8.3: Home state transitions covered (empty → progress → operations)

---

### Task T-9: Tests for Wave 1-2 Backend APIs

**Package**: `apps/search-ai`
**Independent**: Yes

#### Files to Create

| File                                                                    | Purpose                                                   |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/search-ai/src/routes/__tests__/knowledge-bases.test.ts`           | Pagination, search, sort, createdBy, regex escaping tests |
| `apps/search-ai/src/routes/__tests__/sources-pagination.test.ts`        | Source pagination + summary endpoint tests                |
| `apps/search-ai/src/routes/__tests__/chunks-status-filter.test.ts`      | Chunk status filter tests                                 |
| `apps/search-ai/src/routes/__tests__/errors-bulk-retry.test.ts`         | Bulk retry validation + tenant isolation tests            |
| `apps/search-ai/src/routes/__tests__/documents-compound-status.test.ts` | Compound status + comma-separated filter tests            |
| `apps/search-ai/src/utils/__tests__/query-helpers.test.ts`              | escapeRegex + sort whitelist tests                        |

#### Test Pattern

Follow existing `errors.test.ts` pattern: vitest, supertest, express, mock `getLazyModel` via `vi.mock('../../db/index.js')`, mock `requirePermission` to pass through.

#### Subtasks

1. **ST-9.1**: Test `escapeRegex` — verify `.*+?^${}()|[]\` all escaped. Verify `(?=` doesn't cause ReDoS.
2. **ST-9.2**: Test KB list pagination — limit/offset/hasMore, search with special chars, sort whitelist rejection
3. **ST-9.3**: Test source pagination + summary endpoint
4. **ST-9.4**: Test chunk status filter — single status, comma-separated, empty filter
5. **ST-9.5**: Test bulk retry — array validation, max 100 enforcement, status guard, tenant isolation
6. **ST-9.6**: Test compound document status — comma-separated filter, status-summary aggregation

#### Acceptance Criteria

- AC-9.1: All tests pass with `pnpm vitest run apps/search-ai/src/routes/__tests__/knowledge-bases.test.ts` (etc.)
- AC-9.2: Regex injection test passes (search input `.*` does not match everything)
- AC-9.3: Sort whitelist test passes (arbitrary field names rejected)
- AC-9.4: `pnpm build --filter=search-ai && pnpm vitest run apps/search-ai/src/routes/__tests__/` all pass

---

### Task T-16: KB List Page UI

**Package**: `apps/studio`
**Independent**: No (depends on T-10 for KB list API)

#### Files to Modify

| File                                                                  | What Changes                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/studio/src/components/search-ai/KnowledgeBaseDashboardPage.tsx` | Add search bar, status filter, sort dropdown, card layout, pagination |
| `apps/studio/src/api/search-ai.ts`                                    | Update `fetchKnowledgeBases` to pass pagination/search/sort params    |

#### Subtasks

1. **ST-16.1**: Update `fetchKnowledgeBases` API function to accept `{ search, status, sortBy, limit, offset }` params
2. **ST-16.2**: Add search input + status filter dropdown + sort dropdown to KB list header
3. **ST-16.3**: Render KBs as cards with inline metrics (doc count, last indexed, status)
4. **ST-16.4**: Add pagination controls
5. **ST-16.5**: Auto-navigate to new KB after creation (from CreateKnowledgeBaseDialog onSuccess)

#### Acceptance Criteria

- AC-16.1: KB list shows search bar, status filter, sort controls
- AC-16.2: Typing in search filters KB list in real-time (debounced SWR)
- AC-16.3: After creating KB, user navigates to the new KB's home page
- AC-16.4: Pagination shows correct page info

---

### Task T-17: Source Type Badges UI

**Package**: `apps/studio`
**Independent**: No (depends on T-4 DataSection, T-11 source API)

#### Files to Modify

| File                                                            | What Changes                                   |
| --------------------------------------------------------------- | ---------------------------------------------- |
| `apps/studio/src/components/search-ai/data/SourceFilterBar.tsx` | Wire to source summary API for counts          |
| `apps/studio/src/api/search-ai.ts`                              | Add `fetchSourceSummary(indexId)` API function |

#### Subtasks

1. **ST-17.1**: Add `fetchSourceSummary` function to `search-ai.ts` API client
2. **ST-17.2**: Wire SourceFilterBar to use summary endpoint for badge counts
3. **ST-17.3**: Add source name search input using text search

#### Acceptance Criteria

- AC-17.1: Source badges show accurate counts from summary endpoint
- AC-17.2: Source search filters by name

---

### Task T-18: Document Detail Drawer

**Package**: `apps/studio`
**Independent**: No (depends on T-4, T-14, T-15)

#### Files to Modify

| File                                                                | What Changes                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/studio/src/components/search-ai/viewer/CrawledPageViewer.tsx` | Rename to DocumentDetailDrawer, enhance with retry + status |
| `apps/studio/src/components/search-ai/data/DocumentTable.tsx`       | Wire row click to open document detail drawer               |

#### Files to Create

| File                                                                   | Purpose                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/studio/src/components/search-ai/viewer/DocumentDetailDrawer.tsx` | Wrapper that composes CrawledPageViewer tabs + chunk listing + actions |
| `apps/studio/src/components/search-ai/viewer/ChunkListPanel.tsx`       | Paginated chunk list with status filter                                |
| `apps/studio/src/components/search-ai/viewer/DocumentActions.tsx`      | Retry, re-trigger pipeline, delete actions                             |

#### Current CrawledPageViewer (dead code to revive)

```typescript
// /apps/studio/src/components/search-ai/viewer/CrawledPageViewer.tsx
interface CrawledPageViewerProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  documentId: string;
}
// 4 tabs: extracted, original, sideBySide, metadata
// Existing sub-components: ExtractedContentView, OriginalPageView, SideBySideView, MetadataView
```

#### Subtasks

1. **ST-18.1**: Create `DocumentDetailDrawer.tsx` — compose CrawledPageViewer tabs + ChunkListPanel + DocumentActions
2. **ST-18.2**: Create `ChunkListPanel.tsx` — paginated chunk list using existing chunks API + status filter (T-12)
3. **ST-18.3**: Create `DocumentActions.tsx` — retry button (single doc), re-trigger pipeline button, compound status display
4. **ST-18.4**: Wire DocumentTable row click to open DocumentDetailDrawer

#### Acceptance Criteria

- AC-18.1: Clicking a document row opens detail drawer with 4 content tabs
- AC-18.2: Chunk list shows paginated chunks with status filter
- AC-18.3: Retry button resets error docs to pending
- AC-18.4: Drawer closes cleanly

---

### Task T-19: Health Summary API

**Package**: `apps/search-ai` (routes)
**Independent**: Yes

#### Files to Create

| File                                          | Purpose                                                    |
| --------------------------------------------- | ---------------------------------------------------------- |
| `apps/search-ai/src/routes/health-summary.ts` | New route: `GET /api/knowledge-bases/:kbId/health-summary` |

#### Design: Cross-DB Aggregation

Health summary must compose data from both databases:

- `abl_platform`: `ConnectorConfig.syncState`, `ConnectorConfig.errorState`
- `searchaicontent`: `SearchSource.status`, `SearchPipelineDefinition.validationErrors`, `SearchDocument` error counts

```typescript
interface HealthSummaryResponse {
  overall: 'healthy' | 'needs-attention' | 'error';
  categories: {
    sources: {
      status: 'healthy' | 'needs-attention' | 'error';
      total: number;
      syncing: number;
      errored: number;
      details: Array<{ sourceId: string; name: string; status: string; lastSyncError?: string }>;
    };
    pipeline: {
      status: 'healthy' | 'needs-attention' | 'error';
      validationErrors: number;
      validationWarnings: number;
    };
    documents: {
      status: 'healthy' | 'needs-attention' | 'error';
      total: number;
      errored: number;
      processing: number;
    };
    circuitBreaker: {
      status: 'healthy' | 'needs-attention' | 'error';
      state: 'closed' | 'open' | 'half-open';
      failureRate: number;
    };
  };
}
```

#### Subtasks

1. **ST-19.1**: Create `health-summary.ts` route file
2. **ST-19.2**: Implement source health — query SearchSource + ConnectorConfig for sync errors
3. **ST-19.3**: Implement pipeline health — query SearchPipelineDefinition for validation errors
4. **ST-19.4**: Implement document health — aggregate SearchDocument error counts
5. **ST-19.5**: Implement circuit breaker health — call existing `getCircuitBreakerStatus`
6. **ST-19.6**: Compose overall health status (worst of all categories)
7. **ST-19.7**: Mount route in `apps/search-ai/src/server.ts` — add `app.use('/api/knowledge-bases', healthSummaryRouter)` at ~line 139 (after existing `knowledgeBasesRouter` mount). The health-summary route is nested under `:kbId` so it won't conflict.

#### Acceptance Criteria

- AC-19.1: `GET /api/knowledge-bases/:kbId/health-summary` returns composed health data
- AC-19.2: Overall status is 'error' if any category is 'error'
- AC-19.3: Includes tenant isolation on all queries
- AC-19.4: Graceful degradation if circuit breaker service unavailable (return `circuitBreaker.status: 'unknown'`)

---

### Task T-20: Activity Feed REST API

**Package**: `apps/search-ai` (routes)
**Independent**: Yes

#### Files to Create

| File                                    | Purpose                                              |
| --------------------------------------- | ---------------------------------------------------- |
| `apps/search-ai/src/routes/activity.ts` | New route: `GET /api/knowledge-bases/:kbId/activity` |

#### Design

Expose existing `audit-logger.ts` query functions via REST:

```typescript
router.get('/:kbId/activity', async (req, res) => {
  const tenantId = req.tenantContext!.tenantId;
  const { kbId } = req.params;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const eventType = req.query.eventType as string | undefined;

  const logs = await getRecentAuditLogs({ tenantId, eventType, limit });
  // Filter to KB-relevant events (resourceId matches kbId or indexId)
  const kbLogs = logs.filter(
    (l) => l.metadata?.resourceId === kbId || l.metadata?.knowledgeBaseId === kbId,
  );

  res.json({ activity: kbLogs, total: kbLogs.length });
});
```

#### Subtasks

1. **ST-20.1**: Create `activity.ts` route file
2. **ST-20.2**: Wire to existing `getRecentAuditLogs` from `audit-logger.ts`
3. **ST-20.3**: Filter results to KB-relevant events
4. **ST-20.4**: Mount in `apps/search-ai/src/server.ts` — add `app.use('/api/knowledge-bases', activityRouter)` near line 139. The activity route uses `:kbId/activity` so it nests under the KB path.

#### Acceptance Criteria

- AC-20.1: `GET /api/knowledge-bases/:kbId/activity` returns recent audit events
- AC-20.2: Only events related to the specified KB are returned
- AC-20.3: Tenant isolation enforced

---

### Task T-21: Resolution Chain (Debug Trace)

**Package**: `apps/search-ai-runtime`
**Independent**: Yes

#### Files to Modify

| File                                                                          | What Changes                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/search-ai-runtime/src/services/query/query-pipeline.ts` (lines 498-961) | Capture intermediate results from all 7 stages when `debug=true`                 |
| `apps/search-ai-runtime/src/services/query/types.ts` (lines 77-117)           | Add `DebugTrace` type, populate `vocabularyTrace`, extend `UnifiedSearchLatency` |

#### Design: Pipeline Trace Object

```typescript
// types.ts — NEW
interface PipelineDebugTrace {
  stages: {
    permissionFilter: { applied: boolean; durationMs: number };
    preprocessing: {
      applied: boolean;
      durationMs: number;
      corrections?: Array<{ original: string; corrected: string }>;
      entities?: string[];
    };
    vocabularyResolution: {
      applied: boolean;
      durationMs: number;
      resolvedTerms?: Array<{ term: string; field: string; value: string; confidence: number }>;
      unresolvedSegments?: string[];
      classifiedQueryType?: string;
    };
    aliasResolution: {
      applied: boolean;
      durationMs: number;
      mappings?: Array<{
        alias: string;
        storagePath: string;
        enumCoercion?: Record<string, unknown>;
      }>;
    };
    searchExecution: {
      applied: boolean;
      durationMs: number;
      queryDsl?: Record<string, unknown>;
      rawResultCount?: number;
    };
    rerank: {
      applied: boolean;
      durationMs: number;
      originalScores?: number[];
      rerankedScores?: number[];
    };
    metrics: {
      durationMs: number;
      costEstimate?: number;
    };
  };
}

// Extend UnifiedSearchResponse
interface UnifiedSearchResponse {
  // ... existing fields ...
  debugTrace?: PipelineDebugTrace; // populated when query.debug === true
  vocabularyTrace?: VocabularyTrace; // populated when debug === true
}
```

#### Subtasks

1. **ST-21.1**: Define `PipelineDebugTrace` type in `types.ts`
2. **ST-21.2**: Create a `trace` object at the start of `executeUnified()` when `query.debug === true`
3. **ST-21.3**: Capture Stage 0 (permission filter) trace — duration, applied flag
4. **ST-21.4**: Capture Stage 1 (preprocessing) trace — corrections, entities, duration
5. **ST-21.5**: Capture Stage 2 (vocabulary resolution) trace — resolved terms, unresolved segments, classified type. Fix B-9: use resolution from Stage 2 in Stage 3 (avoid double LLM call)
6. **ST-21.6**: Capture Stage 2.5 (alias resolution) trace — alias→storage mappings
7. **ST-21.7**: Capture Stage 3 (search execution) trace — query DSL, raw result count
8. **ST-21.8**: Capture Stage 4 (rerank) trace — original vs reranked scores
9. **ST-21.9**: Capture Stage 5 (metrics) trace — duration, cost estimate
10. **ST-21.10**: Populate `UnifiedSearchLatency` extended fields (preprocessingMs, permissionFilterMs, etc.)
11. **ST-21.11**: Include `debugTrace` in response when `query.debug === true`

#### Acceptance Criteria

- AC-21.1: `POST /query` with `debug: true` returns `debugTrace` with all 7 stages
- AC-21.2: Each stage has `applied`, `durationMs`, and stage-specific data
- AC-21.3: `vocabularyTrace` is populated (was previously always undefined)
- AC-21.4: `UnifiedSearchLatency` extended fields are set (were previously never set)
- AC-21.5: No double LLM call for vocabulary resolution (B-9 fix)
- AC-21.6: `debug: false` or absent — no `debugTrace` in response (no performance impact)
- AC-21.7: `pnpm build --filter=search-ai-runtime` succeeds

---

### Task T-22: Query History (ClickHouse Write + Read)

**Package**: `apps/search-ai-runtime` + `apps/search-ai`
**Independent**: Yes

#### Files to Modify

| File                                                                          | What Changes                                                                |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/search-ai-runtime/src/server.ts` (lines 221-241)                        | Store ClickHouse client reference, instantiate `ClickHouseSearchQueryStore` |
| `apps/search-ai-runtime/src/services/stores/clickhouse-search-query-store.ts` | Add `query()` read method                                                   |
| `apps/search-ai-runtime/src/services/query/query-pipeline.ts`                 | Record query at end of `executeUnified()`                                   |

#### Files to Create

| File                                         | Purpose                                                  |
| -------------------------------------------- | -------------------------------------------------------- |
| `apps/search-ai/src/routes/query-history.ts` | REST endpoint: `GET /api/indexes/:indexId/query-history` |

#### Subtasks

1. **ST-22.1**: Store ClickHouse client reference in `server.ts` during init
2. **ST-22.2**: Instantiate `ClickHouseSearchQueryStore` and export it
3. **ST-22.3**: Add `record()` call at end of `executeUnified()` and `execute()` in query-pipeline.ts
4. **ST-22.4**: Add `query()` read method to `ClickHouseSearchQueryStore` — pagination, time range, index filter
5. **ST-22.5**: Create `query-history.ts` REST endpoint in search-ai (reads from ClickHouse, following `ClickHouseAuditStore.query()` pattern)
6. **ST-22.6**: Mount route in server.ts

#### Acceptance Criteria

- AC-22.1: Queries are recorded to ClickHouse `search_queries` table
- AC-22.2: `GET /api/indexes/:indexId/query-history?limit=20` returns recent queries
- AC-22.3: Graceful degradation if ClickHouse unavailable (B-8 fix)
- AC-22.4: Tenant isolation on all queries

---

## Wave 4: Tier 3 Frontend + Polish

---

### Task T-23: Home Mature — Needs Attention UI

**Package**: `apps/studio`
**Independent**: No (depends on T-19 health API)
**Execution**: Must run BEFORE T-24 (both modify OperationsDashboard.tsx + api/search-ai.ts)

#### Files to Create

| File                                                                             | Purpose                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `apps/studio/src/components/search-ai/home/NeedsAttentionCard.tsx`               | Health summary → issue cards with action links          |
| `apps/studio/src/app/api/search-ai/knowledge-bases/[id]/health-summary/route.ts` | Next.js proxy route for health-summary backend endpoint |

#### Files to Modify

| File                                                                | What Changes                                    |
| ------------------------------------------------------------------- | ----------------------------------------------- |
| `apps/studio/src/components/search-ai/home/OperationsDashboard.tsx` | Replace inline "Needs Attention" with component |
| `apps/studio/src/api/search-ai.ts`                                  | Add `fetchHealthSummary(kbId)` + response types |
| `packages/i18n/locales/en/studio.json`                              | Add health category i18n keys under operations  |

#### Backend API Contract (verified from implementation)

```typescript
// GET /api/knowledge-bases/:kbId/health-summary
// Response: { success: true, data: HealthSummaryResponse }
export interface HealthSummaryResponse {
  sources: {
    total: number;
    syncing: number;
    errors: Array<{
      sourceId: string;
      sourceName: string;
      error: string;
      lastSyncAt: string | null;
    }>;
  };
  pipeline: {
    status: 'valid' | 'invalid' | 'pending' | 'not-configured';
    errors: Array<{ code: string; message: string; severity: string; path: string }>;
  };
  circuitBreaker: {
    state: string;
    failureRate: number;
    provider: string;
  } | null;
  documents: {
    total: number;
    errored: number;
    processing: number;
  };
}
```

#### Design: Category Registry Pattern (extensible)

```typescript
// Instead of hardcoding categories in JSX, use a registry:
interface HealthCategory {
  key: string;
  icon: React.ReactNode;
  checkHealth: (data: HealthSummaryResponse) => HealthIssue[];
}

interface HealthIssue {
  severity: 'error' | 'warning' | 'info';
  title: string;   // i18n-resolved
  detail: string;   // i18n-resolved
  action: { label: string; section: string; subSection?: string };
}

// Registry — add new categories without modifying component:
const HEALTH_CATEGORIES: HealthCategory[] = [
  { key: 'sources', icon: <Database />, checkHealth: checkSourceHealth },
  { key: 'pipeline', icon: <GitBranch />, checkHealth: checkPipelineHealth },
  { key: 'circuitBreaker', icon: <Shield />, checkHealth: checkCircuitBreakerHealth },
  { key: 'documents', icon: <FileText />, checkHealth: checkDocumentHealth },
];

// Each checker is a pure function — unit-testable in isolation
function checkSourceHealth(data: HealthSummaryResponse): HealthIssue[] {
  const issues: HealthIssue[] = [];
  if (data.sources.errors.length > 0) {
    issues.push({
      severity: 'error',
      title: t('source_errors', { count: data.sources.errors.length }),
      detail: data.sources.errors.map(e => e.sourceName).join(', '),
      action: { label: t('view_in_data'), section: 'data' },
    });
  }
  // ... syncing as info, etc.
  return issues;
}
```

**Why**: Adding future categories (embedding health, compliance alerts, search quality) requires only appending to array + adding a checker function. Zero modification to rendering code.

#### SWR Strategy

- **SWR key**: `/api/search-ai/knowledge-bases/${kbId}/health-summary`
- **refreshInterval**: `30_000` (30s polling — health changes asynchronously)
- **Error handling**: Show "Unable to check health" fallback, NOT crash dashboard
- **Props**: `kbId` from `knowledgeBase._id` (already available via `OperationsDashboard` parent)

#### Subtasks

1. **ST-23.0**: Create proxy route at `knowledge-bases/[id]/health-summary/route.ts` (GET, forward to backend)
2. **ST-23.1**: Add `HealthSummaryResponse` type + `fetchHealthSummary(kbId)` to `api/search-ai.ts`
3. **ST-23.2**: Create `NeedsAttentionCard.tsx` with category registry pattern — maps health data to issue cards with severity indicators and action links (using `useNavigationStore().setTab()`)
4. **ST-23.3**: Wire into OperationsDashboard — replace inline "Needs Attention" card. Layout: full-width below stat cards, collapsible when all healthy
5. **ST-23.4**: Add i18n keys for all health categories + labels

#### i18n Keys

```json
{
  "search_ai.operations.health_loading": "Checking health...",
  "search_ai.operations.health_error": "Unable to check health status.",
  "search_ai.operations.all_healthy": "All systems healthy. Your knowledge base is running smoothly.",
  "search_ai.operations.source_errors": "{count} {count, plural, one {source} other {sources}} with sync errors",
  "search_ai.operations.source_syncing": "{count} {count, plural, one {source} other {sources}} syncing",
  "search_ai.operations.pipeline_invalid": "Pipeline has {count} validation {count, plural, one {error} other {errors}}",
  "search_ai.operations.pipeline_not_configured": "Pipeline not configured",
  "search_ai.operations.circuit_breaker_open": "LLM circuit breaker is open ({provider})",
  "search_ai.operations.docs_errored": "{count} {count, plural, one {document} other {documents}} with errors",
  "search_ai.operations.docs_processing": "{count} {count, plural, one {document} other {documents}} processing",
  "search_ai.operations.view_in_data": "View in Data →",
  "search_ai.operations.view_pipeline": "View Pipeline →",
  "search_ai.operations.view_errors": "View Errors →"
}
```

#### Acceptance Criteria

- AC-23.1: Issues display as categorized cards with severity indicators and action links (e.g., "3 sources with sync errors → View in Data")
- AC-23.2: "All systems healthy" one-liner shown when zero issues across all categories
- AC-23.3: SWR polls every 30s; stale data shows while revalidating
- AC-23.4: Error state shows fallback, doesn't crash OperationsDashboard
- AC-23.5: Action links navigate correctly via `setTab()`

---

### Task T-24: Home Mature — Activity Feed UI

**Package**: `apps/studio`
**Independent**: No (depends on T-20 activity API + T-23 must complete first)
**Execution**: Must run AFTER T-23 (both modify OperationsDashboard.tsx + api/search-ai.ts)

#### Files to Create

| File                                                                       | Purpose                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------- |
| `apps/studio/src/components/search-ai/home/ActivityFeed.tsx`               | Recent events timeline with "View →" links        |
| `apps/studio/src/app/api/search-ai/knowledge-bases/[id]/activity/route.ts` | Next.js proxy route for activity backend endpoint |

#### Files to Modify

| File                                                                | What Changes                                       |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| `apps/studio/src/components/search-ai/home/OperationsDashboard.tsx` | Add ActivityFeed below NeedsAttentionCard          |
| `apps/studio/src/api/search-ai.ts`                                  | Add `fetchActivity(kbId, params)` + response types |
| `packages/i18n/locales/en/studio.json`                              | Add activity i18n keys under operations            |

#### Backend API Contract (verified from implementation)

```typescript
// GET /api/knowledge-bases/:kbId/activity?limit=N&offset=N
// Response: { success: true, data: ActivityFeedResponse }
export interface ActivityItem {
  id: string;
  action: string; // e.g., 'source.sync.completed', 'index.rebuild.started'
  metadata: {
    resourceType: string; // 'index' | 'source'
    resourceId: string;
    [key: string]: unknown;
  };
  timestamp: string; // ISO date
  userId: string;
}

export interface ActivityFeedResponse {
  activities: ActivityItem[];
  total: number;
  hasMore: boolean;
}
```

#### Design: Action Type Registry Pattern (extensible)

```typescript
interface ActivityActionConfig {
  pattern: RegExp;             // matches action string
  i18nKey: string;             // translation key
  icon: React.ReactNode;
  targetSection: string;       // navigation section for "View →" link
  targetSubSection?: string;   // optional sub-section
}

const ACTIVITY_ACTION_REGISTRY: ActivityActionConfig[] = [
  { pattern: /^source\.sync/, i18nKey: 'activity_source_sync', icon: <RefreshCw />, targetSection: 'data' },
  { pattern: /^index\.rebuild/, i18nKey: 'activity_index_rebuild', icon: <RotateCcw />, targetSection: 'home' },
  { pattern: /^pipeline\./, i18nKey: 'activity_pipeline', icon: <GitBranch />, targetSection: 'intelligence', targetSubSection: 'pipeline' },
  { pattern: /^vocabulary\./, i18nKey: 'activity_vocabulary', icon: <BookOpen />, targetSection: 'intelligence', targetSubSection: 'vocabulary' },
  { pattern: /^mapping\./, i18nKey: 'activity_mapping', icon: <Map />, targetSection: 'intelligence', targetSubSection: 'fields' },
];

// Fallback for unknown actions — renders generic icon + raw action name
function resolveAction(action: string): ActivityActionConfig {
  return ACTIVITY_ACTION_REGISTRY.find(c => c.pattern.test(action))
    ?? { pattern: /.*/, i18nKey: 'activity_unknown', icon: <Activity />, targetSection: 'home' };
}
```

**Why**: Backend will emit more action types as features grow. Registry pattern = one-line addition per new type.

#### Pagination UX: "Load More" Pattern

- Default: `limit=10`
- Show "Load more" button when `hasMore === true`
- On click: increment offset, append to existing list
- No infinite scroll (simpler, consistent with existing DocumentTable pagination)

#### SWR Strategy

- **SWR key**: `/api/search-ai/knowledge-bases/${kbId}/activity?limit=${limit}&offset=0`
- **refreshInterval**: None (stale-while-revalidate on window focus is sufficient for timeline)
- **Error handling**: Show "Unable to load activity" fallback, isolated from NeedsAttentionCard
- **Props**: `kbId` from `knowledgeBase._id`

#### OperationsDashboard Layout After T-23 + T-24

```
┌─────────────────────────────────────────────────────────────┐
│ Row 1: StatCards (grid-cols-2 md:grid-cols-4)               │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐│
│ │ Documents│ │ Chunks   │ │ Sources  │ │ Last Indexed     ││
│ └──────────┘ └──────────┘ └──────────┘ └──────────────────┘│
├─────────────────────────────────────────────────────────────┤
│ Row 2: NeedsAttentionCard (full-width)                      │
│ ┌───────────────────────────────────────────────────────────┐│
│ │ ⚠ Needs Attention                                        ││
│ │ ┌─────────────────┐ ┌─────────────────┐ ┌──────────────┐││
│ │ │ 2 source errors │ │ Pipeline invalid│ │ 5 doc errors │││
│ │ │ View in Data →  │ │ View Pipeline → │ │ View Errors →│││
│ │ └─────────────────┘ └─────────────────┘ └──────────────┘││
│ │ (or: "✓ All systems healthy" one-liner when no issues)   ││
│ └───────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────┤
│ Row 3: grid-cols-2                                          │
│ ┌────────────────────────────┐ ┌────────────────────────────┐│
│ │ Activity Feed              │ │ Document Status             ││
│ │ ○ Source sync completed    │ │ ● indexed: 42               ││
│ │   Mar 18, 2:30 PM         │ │ ● error: 2                  ││
│ │ ○ Pipeline published       │ │ ● processing: 5             ││
│ │   Mar 18, 1:15 PM         │ │ ● pending: 3                ││
│ │ ○ Vocabulary updated       │ │                             ││
│ │   Mar 17, 4:00 PM         │ │                             ││
│ │ [Load more]               │ │                             ││
│ └────────────────────────────┘ └────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

#### Subtasks

1. **ST-24.0**: Create proxy route at `knowledge-bases/[id]/activity/route.ts` (GET, forward query params)
2. **ST-24.1**: Add `ActivityItem`, `ActivityFeedResponse` types + `fetchActivity(kbId, params)` to `api/search-ai.ts`
3. **ST-24.2**: Create `ActivityFeed.tsx` with action type registry — timeline items with icons, user IDs, timestamps, "View →" links using `useNavigationStore().setTab()`
4. **ST-24.3**: Wire into OperationsDashboard — grid-cols-2 row with ActivityFeed + existing DocumentStatus card
5. **ST-24.4**: Add i18n keys for all activity action types + labels

#### i18n Keys

```json
{
  "search_ai.operations.activity_title": "Recent Activity",
  "search_ai.operations.activity_empty": "No activity recorded yet.",
  "search_ai.operations.activity_load_more": "Load more",
  "search_ai.operations.activity_error": "Unable to load activity.",
  "search_ai.operations.activity_source_sync": "Source sync {action}",
  "search_ai.operations.activity_index_rebuild": "Index rebuild {action}",
  "search_ai.operations.activity_pipeline": "Pipeline {action}",
  "search_ai.operations.activity_vocabulary": "Vocabulary {action}",
  "search_ai.operations.activity_mapping": "Field mapping {action}",
  "search_ai.operations.activity_unknown": "Activity: {action}"
}
```

#### Acceptance Criteria

- AC-24.1: Recent events show with resolved action labels (via registry), timestamps, and user IDs
- AC-24.2: "View →" links navigate to correct section via `setTab()`
- AC-24.3: "Load more" button appears when `hasMore === true`, appends to list
- AC-24.4: Empty state shows "No activity recorded yet."
- AC-24.5: Error state shows isolated fallback, doesn't affect NeedsAttentionCard or StatCards

---

### Task T-25: Resolution Chain 7-Stage Visualization

**Package**: `apps/studio`
**Independent**: No (depends on T-21 debug trace API)

#### Files to Create

| File                                                              | Purpose                            |
| ----------------------------------------------------------------- | ---------------------------------- |
| `apps/studio/src/components/search-ai/search/ResolutionChain.tsx` | Pipeline trace → visual stages ①–⑦ |
| `apps/studio/src/components/search-ai/search/StageDetail.tsx`     | Expandable stage detail with data  |
| `apps/studio/src/components/search-ai/search/ScoreBreakdown.tsx`  | Per-result score visualization     |

#### Subtasks

1. **ST-25.1**: Create `ResolutionChain.tsx` — 7-stage horizontal pipeline with status indicators
2. **ST-25.2**: Create `StageDetail.tsx` — expandable accordion for each stage's debug data
3. **ST-25.3**: Create `ScoreBreakdown.tsx` — vector/filter/rerank score bars per result
4. **ST-25.4**: Wire into SearchTestSection — show below results when `debug=true`

#### Acceptance Criteria

- AC-25.1: 7 stages shown as connected pipeline steps with timing
- AC-25.2: Clicking a stage expands to show intermediate data
- AC-25.3: Score breakdown shows component scores per result

---

### Task T-26: Query History + Compare UI

**Package**: `apps/studio`
**Independent**: No (depends on T-22 query history API)

#### Files to Create

| File                                                           | Purpose                                   |
| -------------------------------------------------------------- | ----------------------------------------- |
| `apps/studio/src/components/search-ai/search/QueryHistory.tsx` | Server-persisted history list             |
| `apps/studio/src/components/search-ai/search/QueryCompare.tsx` | Side-by-side compare for repeated queries |

#### Subtasks

1. **ST-26.1**: Add `fetchQueryHistory(indexId, params)` to API client
2. **ST-26.2**: Create `QueryHistory.tsx` — list with query text, type, timestamp, result count
3. **ST-26.3**: Create `QueryCompare.tsx` — side-by-side diff for two query results
4. **ST-26.4**: Wire into SearchTestSection

#### Acceptance Criteria

- AC-26.1: Query history list shows recent queries with key metrics
- AC-26.2: Compare view shows differences between two query runs

---

### Task T-27: Keyboard Shortcuts

**Package**: `apps/studio`
**Independent**: Yes

#### Files to Create

| File                                                           | Purpose                                |
| -------------------------------------------------------------- | -------------------------------------- |
| `apps/studio/src/components/search-ai/hooks/useKBShortcuts.ts` | Keyboard shortcut hook for KB sections |

#### Subtasks

1. **ST-27.1**: Create `useKBShortcuts` hook — `Alt+1` → Home, `Alt+2` → Data, `Alt+3` → Intelligence, `Alt+4` → Search, `Alt+,` → Settings
2. **ST-27.2**: Wire into KBDetailLayout

#### Acceptance Criteria

- AC-27.1: Alt+1-4 navigates to correct section
- AC-27.2: Alt+, opens settings panel
- AC-27.3: Shortcuts disabled when input/textarea focused

---

### Task T-28: Feedback Toasts

**Package**: `apps/studio`
**Independent**: Yes

#### Files to Create

| File                                                                        | Purpose                            |
| --------------------------------------------------------------------------- | ---------------------------------- |
| `apps/studio/src/components/search-ai/feedback/EnrichmentFeedbackToast.tsx` | Toast with "Test in Search →" link |

#### Subtasks

1. **ST-28.1**: Create toast component — shows after enrichment actions (vocabulary save, field mapping confirm, KG setup)
2. **ST-28.2**: Wire into Intelligence sub-route components — trigger toast on save success

#### Acceptance Criteria

- AC-28.1: After saving vocabulary changes, toast says "Test in Search & Test →"
- AC-28.2: Clicking toast link navigates to Search section

---

### Task T-29: Document Table Bulk Actions

**Package**: `apps/studio`
**Independent**: Yes

#### Files to Modify

| File                                                          | What Changes                                 |
| ------------------------------------------------------------- | -------------------------------------------- |
| `apps/studio/src/components/search-ai/data/DocumentTable.tsx` | Add multi-select checkboxes, bulk action bar |

#### Subtasks

1. **ST-29.1**: Add checkbox column to document table
2. **ST-29.2**: Add bulk action bar (appears when ≥1 selected): "Reprocess (N)" + "Delete (N)"
3. **ST-29.3**: Wire reprocess to bulk retry API (T-14)
4. **ST-29.4**: Wire delete to bulk delete with confirmation

#### Acceptance Criteria

- AC-29.1: Checkboxes appear on each row + "select all" header checkbox
- AC-29.2: Bulk action bar appears with selected count
- AC-29.3: "Reprocess" calls bulk retry API
- AC-29.4: "Delete" prompts confirmation dialog

---

## File Overlap Matrix

Verifying zero overlap between parallel tasks within each wave:

### Wave 1 (T-0 ∥ T-1 ∥ T-2)

| File                                                      | T-0 | T-1 | T-2 |
| --------------------------------------------------------- | --- | --- | --- |
| `search-ai/middleware/auth.ts`                            | ✏️  |     |     |
| `search-ai/routes/knowledge-bases.ts`                     | ✏️  |     |     |
| `search-ai/routes/indexes.ts`                             | ✏️  |     |     |
| `search-ai/validation/index-schemas.ts`                   | ✏️  |     |     |
| `search-ai/services/llm-config/defaults.ts`               | ✏️  |     |     |
| `search-ai/services/llm-config/metadata.ts`               | ✏️  |     |     |
| `studio/store/navigation-store.ts`                        |     | ✏️  |     |
| `studio/components/search-ai/layout/*`                    |     |     | ✏️  |
| `studio/components/search-ai/KnowledgeBaseDetailPage.tsx` |     |     | ✏️  |

**Zero overlap** ✅

### Wave 2 Backend (T-10 ∥ T-11 ∥ T-12 ∥ T-13 ∥ T-14 ∥ T-15)

| File                             | T-10 | T-11 | T-12 | T-13 | T-14 | T-15 |
| -------------------------------- | ---- | ---- | ---- | ---- | ---- | ---- |
| `routes/knowledge-bases.ts`      | ✏️   |      |      | ✏️   |      |      |
| `routes/sources.ts`              |      | ✏️   |      |      |      |      |
| `routes/chunks.ts`               |      |      | ✏️   |      |      |      |
| `routes/errors.ts`               |      |      |      |      | ✏️   |      |
| `routes/documents.ts`            |      |      |      |      |      | ✏️   |
| `models/knowledge-base.model.ts` |      |      |      | ✏️   |      |      |
| `models/search-source.model.ts`  |      | ✏️   |      |      |      |      |

**⚠ Overlap: T-10 and T-13 both modify `knowledge-bases.ts`** — T-10 changes GET handler (lines 47-63), T-13 changes POST handler (lines 130-137) and model. Different functions, but same file. **Make T-13 sequential after T-10** to avoid merge conflicts.

### Wave 2 Frontend (T-3 ∥ T-4 ∥ T-5 ∥ T-6 ∥ T-7)

| Directory                   | T-3 | T-4 | T-5 | T-6 | T-7 |
| --------------------------- | --- | --- | --- | --- | --- |
| `intelligence/*`            | ✏️  |     |     |     |     |
| `data/*`                    |     | ✏️  |     |     |     |
| `search/*`                  |     |     | ✏️  |     |     |
| `home/*`                    |     |     |     | ✏️  |     |
| `settings/*`                |     |     |     |     | ✏️  |
| `layout/KBDetailLayout.tsx` | ✏️  | ✏️  | ✏️  | ✏️  | ✏️  |

**⚠ Overlap: All 5 tasks modify `KBDetailLayout.tsx`** to wire their section. **Solution**: T-3 through T-7 add their import + case in the section router. To avoid conflicts, have T-3 add ALL section routing placeholders in `KBDetailLayout.tsx` with `null` returns, then T-4/T-5/T-6/T-7 only modify their own new component files (not KBDetailLayout). T-3 runs first among frontend Wave 2, adds the routing skeleton.

**Revised execution order for Wave 2 frontend:**

1. T-3 runs first — creates Intelligence section + adds ALL section routing in KBDetailLayout
2. T-4, T-5, T-6, T-7 run in parallel after T-3 — each creates ONLY their section directory files

---

## Review Policy

Per HLD v4 and user mandate:

- **LLD review**: Minimum 7 iterations
- **PR review**: Minimum 7 iterations
- **Implementation verification**: Minimum 7 rounds
- Each iteration focuses on different concerns: correctness → completeness → consistency → naming → types → edge cases → tests
