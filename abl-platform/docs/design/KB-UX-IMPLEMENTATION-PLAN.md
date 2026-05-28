# KB UX Enhancement — Implementation Plan

**Date:** 2026-03-20
**Approach:** Easy fixes first, exact line-level changes, review after every phase, maximum parallelism within phases.

---

## Dependency Graph

```
Phase 1 (G3,G4,G9) ───┐
Phase 2 (G1,G2,G17) ──┤── all independent, can run in parallel
Phase 3 (G5) ─────────┤
Phase 5 (G7) ─────────┤
Phase 6 (G26) ─────────┘
                       │
Phase 4 (G8) ─────────┤── independent, but enhances Phase 2+3 results
                       │
Phase 7 (G6,G10,G15) ─┤── depends on Phase 4 (filter store)
                       │
Phase 8 (G14) ─────────┘── depends on Phase 4 + Phase 7 (3-way SegmentedControl)
```

**Parallelism plan:**

- **Wave 1:** Phase 1 + Phase 2 + Phase 3 + Phase 5 + Phase 6 (all independent)
- **Wave 2:** Phase 4 (filter store)
- **Wave 3:** Phase 7 (sources config — needs filter store)
- **Wave 4:** Phase 8 (all chunks — needs filter store + 3-way segmented control)

---

## Phase 1: Bug Fixes (G3, G4, G9)

### 1a+1b: ActivityFeed — G3 (null target button) + G4 (sub-section navigation)

**File:** `apps/studio/src/components/search-ai/home/ActivityFeed.tsx`

**Change 1 — Line 126:** Add `setTabAndSubSection` import

```tsx
// BEFORE (line 126):
const setTab = useNavigationStore((s) => s.setTab);

// AFTER:
const setTab = useNavigationStore((s) => s.setTab);
const setTabAndSubSection = useNavigationStore((s) => s.setTabAndSubSection);
```

**Change 2 — Lines 42-73:** Add `targetSubSection` to ACTION_REGISTRY entries

```tsx
// Line 42 (source.sync) — add:
targetSubSection: undefined,  // navigates to data tab top-level

// Line 53 (pipeline.*) — add:
targetSubSection: 'pipeline',

// Line 58 (vocabulary.*) — add:
targetSubSection: 'vocabulary',

// Line 64 (mapping.*) — add:
targetSubSection: 'fields',
```

Leave `index.rebuild` (line 47) and FALLBACK (line 73) unchanged — they keep `targetSection: null`.

**Change 3 — Line 202:** Wrap button in conditional + use `setTabAndSubSection`

```tsx
// BEFORE (line 202):
<Button variant="ghost" size="xs" onClick={() => setTab(config.targetSection)}>

// AFTER:
{config.targetSection !== null && (
  <Button
    variant="ghost"
    size="xs"
    onClick={() => {
      if (config.targetSubSection) {
        setTabAndSubSection(config.targetSection!, config.targetSubSection);
      } else {
        setTab(config.targetSection);
      }
    }}
  >
    {t('activity_view')} <ArrowRight className="w-3 h-3" />
  </Button>
)}
```

Note: The closing `</Button>` and `)}` must replace the existing button's closing tags.

**Verification:** `index.rebuild` and fallback items should NOT show a "View" button. `pipeline.*` items should navigate to Intelligence > Pipeline. `vocabulary.*` to Intelligence > Vocabulary. `mapping.*` to Intelligence > Fields. `source.sync` to Data tab.

---

### 1c: ConnectorsTab — G9 (sourceType inconsistency)

**File:** `apps/studio/src/components/search-ai/ConnectorsTab.tsx`

**Change — Line 281:** Map `'file'` to `'manual'`

```tsx
// BEFORE (line 280-284):
await addSource(indexId, {
  name: name.trim(),
  sourceType: selectedType!,
  sourceConfig: buildSourceConfig(),
});

// AFTER:
await addSource(indexId, {
  name: name.trim(),
  sourceType: selectedType === 'file' ? 'manual' : selectedType!,
  sourceConfig: buildSourceConfig(),
});
```

**Verification:** Create a file-upload source via ConnectorsTab. Check network tab — the `sourceType` in the POST body should be `'manual'`, not `'file'`.

---

### Phase 1 Review Checklist

- [ ] `pnpm build --filter=studio` passes
- [ ] `npx prettier --write` on ActivityFeed.tsx, ConnectorsTab.tsx
- [ ] Visual: Open a KB with activity history. Confirm "Index rebuild" items have NO "View" button
- [ ] Visual: Click "View" on a pipeline activity → lands on Intelligence > Pipeline (not just Intelligence)
- [ ] Visual: Click "View" on a vocabulary activity → lands on Intelligence > Vocabulary

---

## Phase 2: Clickable Metrics (G1, G2, G17, G25)

### 2a: KBHeader — G1 (clickable metrics)

**File:** `apps/studio/src/components/search-ai/layout/KBHeader.tsx`

**Change 1 — Lines 13-17:** Add `onNavigate` prop

```tsx
// BEFORE:
interface KBHeaderProps {
  knowledgeBase: KnowledgeBaseDetail;
  onBack: () => void;
  onOpenSettings: () => void;
}

// AFTER:
interface KBHeaderProps {
  knowledgeBase: KnowledgeBaseDetail;
  onBack: () => void;
  onOpenSettings: () => void;
  onNavigate?: (tab: string, subSection?: string) => void;
}
```

**Change 2 — Lines 41-48:** Add click targets and aria-labels to metrics

```tsx
// BEFORE:
const metrics = [
  { label: t('label_documents'), value: index?.documentCount ?? knowledgeBase.documentCount ?? 0 },
  { label: t('label_chunks'), value: index?.chunkCount ?? 0 },
  { label: t('label_sources'), value: index?.sourceCount ?? knowledgeBase.connectorCount ?? 0 },
];

// AFTER:
const metrics = [
  {
    label: t('label_documents'),
    value: index?.documentCount ?? knowledgeBase.documentCount ?? 0,
    onClick: () => onNavigate?.('data'),
    ariaLabel: t('aria_go_to_documents'),
  },
  {
    label: t('label_chunks'),
    value: index?.chunkCount ?? 0,
    onClick: () => onNavigate?.('data'),
    ariaLabel: t('aria_go_to_chunks'),
  },
  {
    label: t('label_sources'),
    value: index?.sourceCount ?? knowledgeBase.connectorCount ?? 0,
    onClick: () => onNavigate?.('data'),
    ariaLabel: t('aria_go_to_sources'),
  },
];
```

Note: Chunks and Sources `onClick` targets will be updated to sub-views (`'chunks'`, `'sources'`) in Phase 7/8 when the 3-way SegmentedControl exists. For now, all navigate to the Data tab.

**Change 3 — Lines 65-70:** Replace `<span>` with `<button>`

```tsx
// BEFORE:
{
  metrics.map((m) => (
    <span key={m.label} className="flex items-center gap-1">
      <span className="font-medium text-foreground">{m.value.toLocaleString()}</span>
      {m.label}
    </span>
  ));
}

// AFTER:
{
  metrics.map((m) => (
    <button
      key={m.label}
      onClick={m.onClick}
      className="flex items-center gap-1 text-muted hover:text-foreground hover:underline cursor-pointer transition-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded"
      aria-label={m.ariaLabel}
    >
      <span className="font-medium text-foreground">{m.value.toLocaleString()}</span>
      {m.label}
    </button>
  ));
}
```

### 2b: KBDetailLayout — pass onNavigate to KBHeader

**File:** `apps/studio/src/components/search-ai/layout/KBDetailLayout.tsx`

**Change — Lines 138-142:** Add `onNavigate` prop

```tsx
// BEFORE:
<KBHeader
  knowledgeBase={knowledgeBase}
  onBack={handleBack}
  onOpenSettings={() => setSettingsOpen(true)}
/>

// AFTER:
<KBHeader
  knowledgeBase={knowledgeBase}
  onBack={handleBack}
  onOpenSettings={() => setSettingsOpen(true)}
  onNavigate={handleNavigate}
/>
```

`handleNavigate` already exists at lines 80-89 and does the right thing.

### 2c: OperationsDashboard — G2 (clickable stat cards)

**File:** `apps/studio/src/components/search-ai/home/OperationsDashboard.tsx`

**Change 1 — Lines 18-21:** Add `onNavigate` prop

```tsx
// BEFORE:
interface OperationsDashboardProps {
  knowledgeBase: KnowledgeBaseDetail;
  indexId: string;
}

// AFTER:
interface OperationsDashboardProps {
  knowledgeBase: KnowledgeBaseDetail;
  indexId: string;
  onNavigate?: (tab: string, subSection?: string) => void;
}
```

**Change 2 — Lines 23-27:** Add `onClick` to StatCardProps

```tsx
// BEFORE:
interface StatCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
}

// AFTER:
interface StatCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  onClick?: () => void;
}
```

**Change 3 — Lines 29-41:** Accept + use `onClick`, pass to Card

```tsx
// BEFORE:
function StatCard({ label, value, icon }: StatCardProps) {
  return (
    <Card hoverable={false} padding="md">

// AFTER:
function StatCard({ label, value, icon, onClick }: StatCardProps) {
  return (
    <Card hoverable={!!onClick} padding="md" onClick={onClick}>
```

**Change 4 — Lines 74-93:** Add onClick to each stat card

```tsx
// Documents stat card — add:
onClick={() => onNavigate?.('data')}

// Chunks stat card — add:
onClick={() => onNavigate?.('data')}

// Sources stat card — add:
onClick={() => onNavigate?.('data')}

// Last Indexed — no onClick (keep as-is)
```

### 2d: OperationsDashboard — G17 (clickable document status counts)

**Change — Lines 109-115 (document status rendering):** Make status rows clickable

```tsx
// BEFORE:
<div key={s._id} className="flex items-center justify-between text-xs">
  <span className="text-muted capitalize">{s._id}</span>
  <span className="font-mono text-foreground">{s.count}</span>
</div>

// AFTER:
<button
  key={s._id}
  className="flex items-center justify-between text-xs w-full hover:bg-background-muted rounded px-1 py-0.5 transition-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus rounded"
  onClick={() => onNavigate?.('data')}
  aria-label={t('aria_view_status_docs', { status: s._id, count: s.count })}
>
  <span className="text-muted capitalize">{s._id}</span>
  <span className="font-mono text-foreground hover:underline">{s.count}</span>
</button>
```

### 2e: HomeSection — pass onNavigate to OperationsDashboard

**File:** `apps/studio/src/components/search-ai/home/HomeSection.tsx`

**Change — Line 52:** Pass `onNavigate` to OperationsDashboard

```tsx
// BEFORE (line 52):
<OperationsDashboard knowledgeBase={knowledgeBase} indexId={indexId} />

// AFTER:
<OperationsDashboard knowledgeBase={knowledgeBase} indexId={indexId} onNavigate={onNavigate} />
```

### 2g: i18n keys

**File:** `packages/i18n/locales/en/studio.json`

Add under `search_ai.header`:

```json
"aria_go_to_documents": "Go to documents",
"aria_go_to_chunks": "Go to chunks",
"aria_go_to_sources": "Go to sources"
```

Add under `search_ai.operations`:

```json
"aria_view_status_docs": "View {count} {status} documents"
```

### Phase 2 Review Checklist

- [ ] `pnpm build --filter=studio` passes
- [ ] `npx prettier --write` on all changed files
- [ ] Visual: Click "1,234 Documents" in header → navigates to Data tab
- [ ] Visual: Click "Sources" stat card → navigates to Data tab
- [ ] Visual: Click "Error: 22" in document status → navigates to Data tab
- [ ] Keyboard: Tab through header metrics, press Enter → navigates
- [ ] Keyboard: All new buttons show focus ring on focus-visible
- [ ] Visual: "Last Indexed" card is NOT clickable (no hover, no cursor change)

---

## Phase 3: ProgressView Actions (G5)

### 3a: ProgressView — add action links

**File:** `apps/studio/src/components/search-ai/home/ProgressView.tsx`

**Change 1 — Lines 19-22:** Add `onNavigate` prop

```tsx
// BEFORE:
interface ProgressViewProps {
  knowledgeBase: KnowledgeBaseDetail;
  indexId: string;
}

// AFTER:
interface ProgressViewProps {
  knowledgeBase: KnowledgeBaseDetail;
  indexId: string;
  onNavigate?: (tab: string, subSection?: string) => void;
}
```

**Change 2 — Add imports at top:**

```tsx
import { ArrowRight } from 'lucide-react';
import { Button } from '../../ui/Button';
```

**Change 3 — After line 93 (end of progress bar section), inside the Card:** Add action links

```tsx
{
  /* Action links */
}
{
  !isError && (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <Button variant="ghost" size="xs" onClick={() => onNavigate?.('search')}>
        {t('action_try_search')} <ArrowRight className="w-3 h-3" />
      </Button>
      <Button variant="ghost" size="xs" onClick={() => onNavigate?.('data')}>
        {t('action_view_documents')} <ArrowRight className="w-3 h-3" />
      </Button>
      <Button variant="ghost" size="xs" onClick={() => onNavigate?.('intelligence', 'fields')}>
        {t('action_review_mappings')} <ArrowRight className="w-3 h-3" />
      </Button>
    </div>
  );
}
{
  isError && (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <Button variant="ghost" size="xs" onClick={() => onNavigate?.('intelligence', 'llm-models')}>
        {t('action_configure_llm')} <ArrowRight className="w-3 h-3" />
      </Button>
      <Button variant="ghost" size="xs" onClick={() => onNavigate?.('data')}>
        {t('action_view_failed_docs')} <ArrowRight className="w-3 h-3" />
      </Button>
    </div>
  );
}
```

### 3b: HomeSection — pass onNavigate to ProgressView

**File:** `apps/studio/src/components/search-ai/home/HomeSection.tsx`

**Change — Line 50:** Pass `onNavigate` to ProgressView

```tsx
// BEFORE:
<ProgressView knowledgeBase={knowledgeBase} indexId={indexId} />

// AFTER:
<ProgressView knowledgeBase={knowledgeBase} indexId={indexId} onNavigate={onNavigate} />
```

### 3c: i18n keys

Add under `search_ai.progress`:

```json
"action_try_search": "Try a search",
"action_view_documents": "View documents",
"action_review_mappings": "Review field mappings",
"action_configure_llm": "Configure LLM Models",
"action_view_failed_docs": "View failed documents"
```

### Phase 3 Review Checklist

- [ ] `pnpm build --filter=studio` passes
- [ ] Visual: KB in indexing state → 3 action links below progress bar
- [ ] Visual: KB in error state → 2 contextual action links
- [ ] Click "Try a search" → Search & Test tab
- [ ] Click "Review field mappings" → Intelligence > Fields

---

## Phase 4: Filter Context Store (G8)

### 4a: Create store

**File:** `apps/studio/src/store/data-tab-filter-store.ts` (NEW)

```tsx
import { create } from 'zustand';

export type DataView = 'documents' | 'chunks' | 'sources';

export interface PendingFilter {
  view?: DataView;
  sourceType?: string;
  statusFilter?: string;
  sourceId?: string;
}

interface DataTabFilterState {
  pendingFilter: PendingFilter | null;
  setPendingFilter: (filter: PendingFilter) => void;
  consumeFilter: () => PendingFilter | null;
}

export const useDataTabFilterStore = create<DataTabFilterState>((set, get) => ({
  pendingFilter: null,
  setPendingFilter: (filter) => set({ pendingFilter: filter }),
  consumeFilter: () => {
    const current = get().pendingFilter;
    if (current) set({ pendingFilter: null });
    return current;
  },
}));
```

### 4b: NeedsAttentionCard — set filter before navigation

**File:** `apps/studio/src/components/search-ai/home/NeedsAttentionCard.tsx`

**Change 1 — Add import:**

```tsx
import { useDataTabFilterStore } from '../../../store/data-tab-filter-store';
```

**Change 2 — Inside component (after line 169):**

```tsx
const setPendingFilter = useDataTabFilterStore((s) => s.setPendingFilter);
```

**Change 3 — In the issue click handler building (around lines 121-130):** For document error issues, set filter before navigating. Locate where `section: 'data'` is set and add:

```tsx
// Before the setTab/setTabAndSubSection call, when the issue is document errors:
setPendingFilter({ view: 'documents', statusFilter: 'error' });
```

This needs careful insertion. The exact location depends on the health issue mapping logic. The principle: wherever `setTab('data')` is called for error-related items, call `setPendingFilter` first.

### 4c: OperationsDashboard — set filter on status count click

**File:** `apps/studio/src/components/search-ai/home/OperationsDashboard.tsx`

**Change — In the status count button onClick (from Phase 2d):** Replace plain `onNavigate?.('data')` with:

```tsx
onClick={() => {
  setPendingFilter({ view: 'documents', statusFilter: s._id });
  onNavigate?.('data');
}}
```

Add import + hook call at component top:

```tsx
import { useDataTabFilterStore } from '../../../store/data-tab-filter-store';
// inside component:
const setPendingFilter = useDataTabFilterStore((s) => s.setPendingFilter);
```

### 4d: ProgressView — set filter on error link click

**File:** `apps/studio/src/components/search-ai/home/ProgressView.tsx`

**Change — In the error state "View failed documents" onClick:**

```tsx
import { useDataTabFilterStore } from '../../../store/data-tab-filter-store';
// inside component:
const setPendingFilter = useDataTabFilterStore((s) => s.setPendingFilter);

// In onClick:
onClick={() => {
  setPendingFilter({ view: 'documents', statusFilter: 'error' });
  onNavigate?.('data');
}}
```

### 4e: DataSection — consume filter on mount

**File:** `apps/studio/src/components/search-ai/data/DataSection.tsx`

**Change — Add import + consumption effect:**

```tsx
import { useDataTabFilterStore } from '../../../store/data-tab-filter-store';

// Inside component, after existing state declarations:
const consumeFilter = useDataTabFilterStore((s) => s.consumeFilter);

useEffect(() => {
  const pending = consumeFilter();
  if (pending) {
    if (pending.sourceType) setActiveFilter(pending.sourceType);
    // pending.view and pending.statusFilter reserved for Phase 7/8
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

### Phase 4 Review Checklist

- [ ] `pnpm build --filter=studio` passes
- [ ] Visual: Click "Error: 22" in dashboard → Data tab opens (filter store consumed)
- [ ] Visual: Navigate to Data tab directly (no pending filter) → no filter applied
- [ ] Visual: Click "View errored docs" in NeedsAttention → Data tab
- [ ] Verify filter is consumed only once (navigate away and back → no stale filter)

---

## Phase 5: ChunkExplorer Access (G7)

### 5a: CrawledPageViewer — add Explore Chunks button

**File:** `apps/studio/src/components/search-ai/viewer/CrawledPageViewer.tsx`

**Change 1 — Add imports (around line 11-26):**

```tsx
import { ChunkExplorerDialog } from '../ChunkExplorer';
import { Layers } from 'lucide-react';
```

**Change 2 — Add state (inside component, near other useState):**

```tsx
const [chunkExplorerOpen, setChunkExplorerOpen] = useState(false);
```

**Change 3 — After PageViewerHeader (line ~309), before the tab bar (line ~312):** Add button bar

```tsx
<div className="px-5 py-1.5 border-b border-default flex items-center justify-between">
  <span className="text-xs text-muted">{data ? `${data.chunkCount} chunks` : ''}</span>
  <Button
    variant="secondary"
    size="xs"
    onClick={() => setChunkExplorerOpen(true)}
    disabled={!data}
    aria-label={t('explore_chunks')}
  >
    <Layers className="w-3.5 h-3.5" />
    {t('explore_chunks')}
  </Button>
</div>
```

**Change 4 — Before closing `</motion.div>` at end of component:** Render ChunkExplorerDialog

```tsx
{
  data && (
    <ChunkExplorerDialog
      open={chunkExplorerOpen}
      onClose={() => setChunkExplorerOpen(false)}
      indexId={indexId}
      documentId={documentId}
      documentTitle={data.document.title ?? data.document.fileName ?? 'Document'}
      totalChunks={data.chunkCount}
    />
  );
}
```

**Verify ChunkExplorerDialog props match:** `open`, `onClose`, `indexId`, `documentId`, `documentTitle`, `totalChunks` — confirmed at ChunkExplorer.tsx lines 45-52.

### 5b: i18n key

Add under `search_ai.viewer`:

```json
"explore_chunks": "Explore Chunks"
```

### Phase 5 Review Checklist

- [ ] `pnpm build --filter=studio` passes
- [ ] Visual: Click a document row → CrawledPageViewer opens → "Explore Chunks" button visible
- [ ] Click "Explore Chunks" → ChunkExplorerDialog opens on top
- [ ] Close dialog → CrawledPageViewer still visible underneath
- [ ] Button disabled when no document data loaded

---

## Phase 6: File Upload Retry (G26)

### 6a: FileUploadDialog — add per-file retry

**File:** `apps/studio/src/components/search-ai/data/FileUploadDialog.tsx`

**Change 1 — Add import:**

```tsx
import { RotateCcw } from 'lucide-react';
```

**Change 2 — Add `handleRetryFile` function (inside component, after line ~310):**

```tsx
const handleRetryFile = useCallback(
  async (fileIndex: number) => {
    if (!selectedSourceId) return;
    const file = files[fileIndex];
    setUploadProgress((prev) => ({ ...prev, [String(fileIndex)]: 'uploading' }));

    try {
      let finalMetadata: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(metadata)) {
        if (value.trim()) finalMetadata[key] = value.trim();
      }
      if (advancedJson.trim()) {
        try {
          finalMetadata = { ...finalMetadata, ...JSON.parse(advancedJson.trim()) };
        } catch {
          /* already validated */
        }
      }
      await uploadDocument(
        indexId,
        selectedSourceId,
        file,
        Object.keys(finalMetadata).length > 0 ? finalMetadata : undefined,
      );
      setUploadProgress((prev) => ({ ...prev, [String(fileIndex)]: 'done' }));
    } catch (err: unknown) {
      setUploadProgress((prev) => ({ ...prev, [String(fileIndex)]: 'error' }));
      toast.error(sanitizeError(err, t('error_upload_failed')));
    }
  },
  [files, selectedSourceId, metadata, advancedJson, indexId, t],
);
```

**Change 3 — In `renderFileList()` (around lines 437-459):** Add retry button next to error status

```tsx
{
  uploadProgress[String(index)] === 'error' && (
    <button
      type="button"
      onClick={() => handleRetryFile(index)}
      className="p-1 text-accent hover:text-foreground transition-default rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
      aria-label={t('aria_retry_file', { name: file.name })}
    >
      <RotateCcw className="w-3.5 h-3.5" />
    </button>
  );
}
```

### 6b: i18n key

Add under `search_ai.upload`:

```json
"aria_retry_file": "Retry uploading {name}"
```

### Phase 6 Review Checklist

- [ ] `pnpm build --filter=studio` passes
- [ ] Visual: Upload 2+ files, simulate failure → retry icon appears on failed file
- [ ] Click retry → file re-uploads, status updates
- [ ] Successful retry → status changes from error to done

---

## Phase 7: Sources Configuration (G6, G10, G15)

### 7a: Frontend API — add fetchSourceSummary

**File:** `apps/studio/src/api/search-ai.ts`

Add after `fetchSources` (line ~783):

```tsx
export async function fetchSourceSummary(
  indexId: string,
): Promise<{ summary: Array<{ sourceType: string; count: number }> }> {
  const res = await fetch(engineUrl(`/indexes/${indexId}/sources/summary`), {
    headers: defaultHeaders(),
  });
  if (!res.ok) throw new Error(`fetchSourceSummary failed: ${res.status}`);
  return res.json();
}
```

### 7b: Create SourcesTable component

**File:** `apps/studio/src/components/search-ai/data/SourcesTable.tsx` (NEW, ~300 lines)

Props:

```tsx
interface SourcesTableProps {
  indexId: string;
  sources: SearchAISource[];
  onRefresh: () => void;
  onViewDocuments: (sourceId: string, sourceName: string) => void;
  onUploadToSource: (sourceId: string, sourceName: string) => void;
}
```

Key implementation details:

- Use `DataTable` from `../../ui/DataTable` (verified exists)
- Columns: Name, Type (Badge with icon), Status (Badge with dot), Docs (clickable count), Last Sync, Actions
- Row click: check if source has enterprise connector → open ConnectorDetailPanel vs SourceDetailPanel
- Need to call `fetchEnterpriseConnectors(indexId)` to build `connectorMap: Record<sourceId, connectorId>`
- Type badge colors: manual=default, web=info, database=purple, api=warning, sharepoint=accent
- Health summary bar at top using SWR + `fetchSourceSummary`
- Import and render both `ConnectorDetailPanel` and `SourceDetailPanel`

### 7c: Create SourceDetailPanel component

**File:** `apps/studio/src/components/search-ai/data/SourceDetailPanel.tsx` (NEW, ~200 lines)

Props:

```tsx
interface SourceDetailPanelProps {
  open: boolean;
  onClose: () => void;
  source: SearchAISource;
  indexId: string;
  onRefresh: () => void;
  onViewDocuments: () => void;
  onUploadFiles?: () => void;
}
```

Key implementation details:

- Use `SlidePanel` from `../../ui/SlidePanel` (verified exists at `apps/studio/src/components/ui/SlidePanel.tsx`, props: `open`, `onClose`, `title`, `description`, `width`)
- Sections: Overview (documentCount, lastSyncAt, syncError), Configuration (type-specific), Actions, Danger Zone
- Configuration rendering switches on `source.sourceType`:
  - `'manual'`: file types, max size from `source.sourceConfig`
  - `'database'`: connection (masked), collection, query
  - `'api'`: url, method, auth type
  - `'web'`: url, crawl depth, patterns
- Actions: "View Documents" always, "Upload Files" for manual, "Trigger Sync" for non-manual
- Danger Zone: Delete button with confirmation dialog

### 7d: DataSection — add SegmentedControl

**File:** `apps/studio/src/components/search-ai/data/DataSection.tsx`

Major restructure. Add:

- `import { SegmentedControl } from '../../ui/SegmentedControl';`
- `import { SourcesTable } from './SourcesTable';`
- `import { useDataTabFilterStore } from '../../../store/data-tab-filter-store';`
- State: `const [activeView, setActiveView] = useState<'documents' | 'sources'>('documents');`
- consumeFilter effect updates `activeView` from pending filter
- SegmentedControl with 2 options: Documents, Sources (Chunks added in Phase 8)
- Conditional render: documents view (existing) or sources view (SourcesTable)

Note: Start with 2-way control (Documents | Sources). Phase 8 adds the third option (Chunks).

### 7e: i18n keys

Add under `search_ai.data`:

```json
"view_documents": "Documents",
"view_sources": "Sources"
```

Add new namespace `search_ai.source_detail` with keys for all labels.
Add new namespace `search_ai.sources_table` with keys for column headers and actions.

### Phase 7 Review Checklist

- [ ] `pnpm build --filter=studio` passes
- [ ] Visual: Data tab shows SegmentedControl with "Documents | Sources"
- [ ] Click "Sources" → SourcesTable renders with all sources
- [ ] Click enterprise source row → ConnectorDetailPanel opens
- [ ] Click non-enterprise source row → SourceDetailPanel opens
- [ ] "View Documents" in panel → switches to Documents view filtered by source
- [ ] Source health summary displays correct counts
- [ ] Delete source with confirmation → source removed, table refreshes
- [ ] "Upload Files" button shown only for manual sources

---

## Phase 8: All Chunks View (G14)

### 8a: Backend — new chunk listing route

**File:** `apps/search-ai/src/routes/chunks.ts`

Add NEW route BEFORE line 101 (`GET /:indexId/chunks/:chunkId`) — Express route ordering critical:

```tsx
// GET /:indexId/chunks — List all chunks for an index (cross-document)
router.get('/:indexId/chunks', async (req, res) => {
  const { indexId } = req.params;
  const tenantId = req.tenantContext.tenantId;
  const {
    limit = '20',
    offset = '0',
    status,
    sourceId,
    documentId,
    search,
    minTokens,
    maxTokens,
    sort = 'chunkIndex',
    order = 'asc',
    includeContent = 'true',
  } = req.query as Record<string, string>;

  const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');
  const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');

  const filter: Record<string, unknown> = { indexId, tenantId };

  if (status) {
    const statuses = status.split(',').map((s) => s.trim());
    filter.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
  }
  if (documentId) filter.documentId = documentId;
  if (sourceId) {
    // Find documents for this source, then filter chunks
    const docs = await SearchDocument.find({ indexId, tenantId, sourceId }).select('_id').lean();
    filter.documentId = { $in: docs.map((d) => d._id.toString()) };
  }
  if (search) filter.content = { $regex: search, $options: 'i' };
  if (minTokens || maxTokens) {
    filter.tokenCount = {};
    if (minTokens) (filter.tokenCount as any).$gte = parseInt(minTokens, 10);
    if (maxTokens) (filter.tokenCount as any).$lte = parseInt(maxTokens, 10);
  }

  const sortObj: Record<string, 1 | -1> = { [sort]: order === 'desc' ? -1 : 1 };
  const lim = Math.min(parseInt(limit, 10) || 20, 100);
  const off = parseInt(offset, 10) || 0;

  const [chunks, total] = await Promise.all([
    SearchChunk.find(filter)
      .sort(sortObj)
      .skip(off)
      .limit(lim)
      .select(includeContent === 'false' ? '-content' : undefined)
      .lean(),
    SearchChunk.countDocuments(filter),
  ]);

  // Resolve document titles
  const docIds = [...new Set(chunks.map((c) => c.documentId))];
  const docs = await SearchDocument.find({ _id: { $in: docIds }, tenantId })
    .select('_id title fileName')
    .lean();
  const docMap = new Map(docs.map((d) => [d._id.toString(), d.title || d.fileName || 'Untitled']));

  const mapped = chunks.map((c) => ({
    id: c._id.toString(),
    chunkIndex: c.chunkIndex,
    content: c.content,
    tokenCount: c.tokenCount,
    status: c.status,
    metadata: c.metadata,
    canonicalMetadata: c.canonicalMetadata,
    documentId: c.documentId,
    documentTitle: docMap.get(c.documentId) ?? 'Untitled',
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));

  res.json({
    chunks: mapped,
    pagination: { total, limit: lim, offset: off, hasMore: off + lim < total },
  });
});
```

**CRITICAL:** This route must be registered BEFORE `GET /:indexId/chunks/:chunkId` (line 101), otherwise Express will match `chunks` path segments as `:chunkId`.

### 8b+8c: Frontend API — add fetchAllChunks + extend type

**File:** `apps/studio/src/api/search-ai.ts`

Extend SearchAIChunk (line ~1018):

```tsx
export interface SearchAIChunk {
  id: string;
  chunkIndex: number;
  content?: string;
  tokenCount: number;
  metadata: Record<string, unknown> | null;
  canonicalMetadata: Record<string, unknown> | null;
  status: string;
  documentId?: string; // NEW
  documentTitle?: string; // NEW
  createdAt: string;
  updatedAt: string;
}
```

Add after `fetchChunks`:

```tsx
export interface FetchAllChunksOptions {
  limit?: number;
  offset?: number;
  status?: string[];
  sourceId?: string;
  documentId?: string;
  search?: string;
  minTokens?: number;
  maxTokens?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  includeContent?: boolean;
}

export async function fetchAllChunks(
  indexId: string,
  options?: FetchAllChunksOptions,
): Promise<{ chunks: SearchAIChunk[]; pagination: ChunkPagination }> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));
  if (options?.status?.length) params.set('status', options.status.join(','));
  if (options?.sourceId) params.set('sourceId', options.sourceId);
  if (options?.documentId) params.set('documentId', options.documentId);
  if (options?.search) params.set('search', options.search);
  if (options?.minTokens) params.set('minTokens', String(options.minTokens));
  if (options?.maxTokens) params.set('maxTokens', String(options.maxTokens));
  if (options?.sort) params.set('sort', options.sort);
  if (options?.order) params.set('order', options.order);
  if (options?.includeContent === false) params.set('includeContent', 'false');
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(engineUrl(`/indexes/${indexId}/chunks${qs}`), {
    headers: defaultHeaders(),
  });
  if (!res.ok) throw new Error(`fetchAllChunks failed: ${res.status}`);
  return res.json();
}
```

### 8d+8e: Create ChunkFilterBar + ChunksTable

**File:** `apps/studio/src/components/search-ai/data/ChunkFilterBar.tsx` (NEW, ~120 lines)
**File:** `apps/studio/src/components/search-ai/data/ChunksTable.tsx` (NEW, ~350 lines)

ChunkFilterBar props:

```tsx
interface ChunkFilterBarProps {
  filters: ChunkFilters;
  onFiltersChange: (filters: ChunkFilters) => void;
  sources: SearchAISource[];
}
```

ChunksTable props:

```tsx
interface ChunksTableProps {
  indexId: string;
  sources: SearchAISource[];
  initialFilters?: { status?: string; sourceId?: string };
}
```

ChunksTable uses SWR with `fetchAllChunks`, renders DataTable, handles pagination + sorting. Row click opens ChunkExplorerDialog for the clicked chunk's document.

### 8f: DataSection — upgrade to 3-way SegmentedControl

**File:** `apps/studio/src/components/search-ai/data/DataSection.tsx`

Update the SegmentedControl from Phase 7:

```tsx
<SegmentedControl
  options={[
    { id: 'documents', label: t('view_documents') },
    { id: 'chunks', label: t('view_chunks') },
    { id: 'sources', label: t('view_sources') },
  ]}
  value={activeView}
  onChange={(v) => setActiveView(v as DataView)}
  size="sm"
/>
```

Add conditional render for chunks:

```tsx
{
  activeView === 'chunks' && <ChunksTable indexId={indexId} sources={sources} />;
}
```

### 8g: i18n keys

Add under `search_ai.data`:

```json
"view_chunks": "Chunks"
```

Add new namespace `search_ai.chunks` with filter labels, column headers, empty state text.

### Phase 8 Review Checklist

- [ ] `pnpm build --filter=search-ai` passes (backend)
- [ ] `pnpm build --filter=studio` passes (frontend)
- [ ] Backend: `GET /api/indexes/:indexId/chunks` returns chunks with documentTitle
- [ ] Backend: Status filter works (single + comma-separated)
- [ ] Backend: sourceId filter works (resolves via documents)
- [ ] Backend: tokenCount range filter works
- [ ] Backend: Pagination correct (total, hasMore)
- [ ] Frontend: Chunks sub-view renders with stats bar
- [ ] Frontend: Filter dropdowns populate correctly
- [ ] Frontend: Row click opens ChunkExplorerDialog
- [ ] Frontend: Column sorting works
- [ ] Frontend: Empty state + filtered-empty state display correctly

---

## Post-Implementation: Final Review

After all phases complete:

1. Full `pnpm build` (all packages)
2. `npx prettier --write` on all changed files
3. End-to-end walkthrough of every navigation path in the Cross-Tab Navigation Map
4. Keyboard-only navigation test (Tab through all new interactive elements)
5. Test both dark and light themes
6. Verify no console errors/warnings
7. Update `KB-UX-GAP-TRACKER.md` — mark all gaps as DONE
