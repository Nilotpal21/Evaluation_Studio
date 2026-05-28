# CrawlProgressView Extraction + USP Integration — Implementation Plan

**Date**: 2026-05-20
**Status**: REVIEWED — Ready for Implementation
**Ticket**: ABLP-71
**Context**: Recrawl from USP shows stale completed/failed state until SWR refetch picks up the new job (200ms-5s gap). No progressive loading experience. First-time crawl wizard has rich real-time progress (State4Crawl) that is never shown on USP.

---

## Problem

When user clicks Recrawl on USP:

1. API call succeeds → toast "Recrawl submitted"
2. **200ms-5s gap**: Page shows OLD completed/failed stats and pages
3. SWR refetch returns new job → displayState flips → stats reset to 0
4. Pages appear all at once when bulk worker finishes

The crawl wizard has `State4Crawl` with WebSocket-driven real-time progress (progress bar, phase cards, quality breakdown, failure grouping, per-page streaming) — but it's only used inside the wizard. USP never shows it.

## Approach: Composable Decomposition (Option C)

```
CrawlProgressView  ← pure progress display (progress bar, phase cards, quality,
│                     failures, connection indicator, skipped URLs)
│                     No actions, no dialogs, no navigation — just renders data
│
├── State4Crawl    ← wizard wrapper: adds Back/Cancel dialogs, completion
│                     summary with "View Results", backgrounding to activity bar
│
└── USP Pages tab  ← USP wrapper: adds cancel via existing ActionsBar,
                      transitions back to CrawledPagesView when done
```

- Progress logic lives in ONE place — `CrawlProgressView`
- Each consumer adds its own chrome (dialogs, actions, navigation)
- Adding a third consumer just wraps `CrawlProgressView` again
- ✅ Maintainability: single source of truth for progress UI
- ✅ Pluggability: composable, no mode flags

---

## Review Findings — Resolved

### Round 1 (Architecture Review)

| #   | Severity | Finding                                                                                                | Resolution                                                                                                                                                                                                                 |
| --- | -------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | HIGH     | `onComplete` signature contradiction — `() => void` in Step 1 vs rich object in Step 3                 | **Use rich signature everywhere.** USP ignores extra fields. See updated Step 1.                                                                                                                                           |
| 2   | HIGH     | `sections` prop optional but `sectionFill` memo calls `sections.find()`/`.filter()` without null guard | **Default `sections` to `[]`** in CrawlProgressView destructuring. All section iteration guarded.                                                                                                                          |
| 3   | HIGH     | `CrawlCompletionSummary` needs live data but `onComplete` fires once (snapshot)                        | **Accepted as snapshot.** Summary shows at terminal state — no more events arrive after `job_completed`. Late `intelligence_page_saved` events are an edge case; sticky `isDoneRef` prevents further state changes anyway. |
| 4   | HIGH     | Step 5b duplicates anchoring logic already in L209-226                                                 | **Removed Step 5b.** Replace with simple: `useEffect(() => { if (isCrawling && recrawlJobId) setRecrawlJobId(null); }, [isCrawling, recrawlJobId])`                                                                        |
| 5   | MEDIUM   | No i18n namespace specified for CrawlProgressView                                                      | **Uses `search_ai.crawl_flow`** — same namespace as State4Crawl. Strings are identical (moved, not created).                                                                                                               |
| 6   | MEDIUM   | Stale recrawlJobId if backend returns different jobId than expected                                    | **Fixed by removing jobId matching.** New cleanup clears on `isCrawling` transition, not jobId comparison.                                                                                                                 |
| 7   | MEDIUM   | `CrawledPagesView` `refreshInterval` change not called out                                             | **Intentional behavioral change documented.** CrawledPagesView no longer shown during active crawl, so `refreshInterval` is always `undefined` when it renders.                                                            |
| 8   | MEDIUM   | REST polling cleanup must move to CrawlProgressView                                                    | **Explicitly noted.** REST polling `useEffect` with its cleanup function moves verbatim into CrawlProgressView.                                                                                                            |

### Round 2 (Dry-Run Regression Review)

| #   | Severity | Finding                                                                                                                                                                                                                                                            | Resolution                                                                                                                                                                                                  |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **HIGH** | Back/backgrounding dialog (State4Crawl L806-838) uses `completedCount`, `totalCount`, `failedCount` during ACTIVE crawl. After extraction these only exist inside CrawlProgressView. `terminalResult` is null during active crawl → backgrounding item gets 0/0/0. | **Fixed: Add `onProgressUpdate` callback.** CrawlProgressView fires it on each progress change with live stats. State4Crawl mirrors into local state for backgrounding dialog. See updated Step 1 + Step 3. |
| R2  | MEDIUM   | `thinPages.length` in action bar hint (State4Crawl L745-749) depends on `multiPage.pages` which moves to CrawlProgressView.                                                                                                                                        | **Fixed: Use `terminalResult?.thinCount ?? 0`** in the action bar. `thinPages` hint only shows when `effectiveIsDone`, so `terminalResult` is available. Explicitly called out in Step 3.                   |
| R3  | MEDIUM   | `progressJobId` change during backend dedup causes WS reconnection + accumulated state loss (skipped URLs, multiPage pages).                                                                                                                                       | **Documented as known limitation.** Dedup is rare. StatusStrip REST polling compensates. Progress view reconnects and accumulates from that point forward.                                                  |
| R4  | MEDIUM   | First-time crawl now shows CrawlProgressView instead of CrawledPagesView — user-visible behavioral change.                                                                                                                                                         | **Documented as intentional improvement.** WebSocket real-time progress is strictly better than 5s REST polling of an empty document table.                                                                 |
| R5  | LOW      | CrawlCompletionSummary snapshot timing is correct — no regression.                                                                                                                                                                                                 | No action needed.                                                                                                                                                                                           |
| R6  | LOW      | Cancel handler unaffected by extraction.                                                                                                                                                                                                                           | No action needed.                                                                                                                                                                                           |
| R7  | LOW      | Missing `result.jobId` from recrawlSource degrades gracefully to old behavior.                                                                                                                                                                                     | No action needed.                                                                                                                                                                                           |
| R8  | LOW      | `handleHistoryRecrawl` correctly uses updated `handleQuickRecrawl` with jobId capture.                                                                                                                                                                             | No action needed.                                                                                                                                                                                           |
| R9  | LOW      | `CrawledPagesView` `refreshInterval` always `undefined` when visible — correct by construction.                                                                                                                                                                    | No action needed.                                                                                                                                                                                           |
| R10 | LOW      | useEffect race clearing `recrawlJobId` is harmless (extra render, no flicker).                                                                                                                                                                                     | No action needed.                                                                                                                                                                                           |
| R11 | LOW      | Double SWR refresh on first-time completion is harmless (SWR deduplicates).                                                                                                                                                                                        | No action needed.                                                                                                                                                                                           |

---

## File Inventory

| File                                | Action                                                                                    | Risk                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| `crawl-flow/CrawlProgressView.tsx`  | **CREATE**                                                                                | None — new file                              |
| `crawl-flow/State4Crawl.tsx`        | **MODIFY** — import CrawlProgressView, delegate rendering                                 | Medium — must preserve all existing behavior |
| `crawl-flow/types.ts`               | **MODIFY** — add `CrawlProgressViewProps`, `CrawlProgressResult`                          | Low                                          |
| `crawl-flow/index.ts`               | **MODIFY** — export `CrawlProgressView`                                                   | Low                                          |
| `source-page/UnifiedSourcePage.tsx` | **MODIFY** — add progress view in Pages tab, optimistic state, capture jobId from recrawl | Medium                                       |

### Files NOT Changed (Regression Safety)

| Component                   | Why No Change                                                                                                                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USPStatusStrip`            | Keeps its own WS connection for stats. Unaffected.                                                                                                                                                                                                                     |
| `USPActionsBar`             | Already has Cancel + Run in Background during `crawling` state. Works as-is.                                                                                                                                                                                           |
| `USPHeader`                 | Uses `displayState` for badge. Will lag slightly on recrawl (acceptable — catches up via SWR in ≤5s).                                                                                                                                                                  |
| `CrawlFlowV5.tsx`           | Still renders `State4Crawl` the same way. Only State4Crawl's internal import changes.                                                                                                                                                                                  |
| `KnowledgeBaseDetailPage`   | No changes. Still renders CrawlFlowV5 for wizard flow.                                                                                                                                                                                                                 |
| `CrawledPagesView`          | No changes. Conditionally hidden during active crawl (intentional — CrawlProgressView replaces it). Previously passed `refreshInterval={isCrawling ? 5000 : undefined}` but now it only renders when `!showCrawlProgress`, so `refreshInterval` is always `undefined`. |
| `useCrawlProgress` hook     | No changes. Used by both StatusStrip and CrawlProgressView independently.                                                                                                                                                                                              |
| `useMultiPageProgress` hook | No changes. Used internally by CrawlProgressView.                                                                                                                                                                                                                      |

---

## Step-by-Step Implementation

### Step 1: Add types to `types.ts`

**File**: `apps/studio/src/components/search-ai/crawl-flow/types.ts`

```typescript
/** Quality breakdown — exported for consumers that need terminal stats */
export interface QualityBreakdown {
  good: number;
  thin: number;
  empty: number;
  unknown: number;
}

/** Terminal result passed from CrawlProgressView to consumers via onComplete */
export interface CrawlProgressResult {
  state: 'done' | 'failed';
  completedCount: number;
  failedCount: number;
  totalCount: number;
  quality: QualityBreakdown;
  thinCount: number;
}

/** Live progress stats — fired on each progress change for parents that need live counts */
export interface CrawlProgressStats {
  completedCount: number;
  failedCount: number;
  totalCount: number;
}

/** Props for reusable CrawlProgressView — pure progress display, no actions */
export interface CrawlProgressViewProps {
  jobId: string;
  sourceId: string;
  url: string;
  /** Optional sections for fill-rate fallback (wizard has these, USP doesn't).
   *  Defaults to [] — all section iteration is guarded against empty array. */
  sections?: CrawlSection[];
  /** Fallback total when WS hasn't reported yet (default: 0) */
  totalPages?: number;
  /** Called once when crawl reaches terminal state (done or failed).
   *  Passes a snapshot of progress stats at terminal time. */
  onComplete?: (result: CrawlProgressResult) => void;
  /** Called on each progress update with current stats.
   *  Used by State4Crawl's backgrounding dialog which needs live counts during active crawl.
   *  USP does not use this (ActionsBar gets stats from its own SWR/dashboard polling). */
  onProgressUpdate?: (stats: CrawlProgressStats) => void;
  /** When crawl-as-you-discover is active — dual progress bars */
  discoveryProgress?: {
    discoveredUrls: number;
    pagesVisited: number;
    isRunning: boolean;
  };
  /** Per-category crawl status from crawl-as-you-discover */
  categoryCrawlStatus?: CategoryCrawlStatus[];
}
```

**Note**: The `QualityBreakdown` interface is currently defined locally inside State4Crawl.tsx (L101-106). Moving it to `types.ts` makes it importable by both CrawlProgressView and State4Crawl.

### Step 2: Create `CrawlProgressView.tsx`

**File**: `apps/studio/src/components/search-ai/crawl-flow/CrawlProgressView.tsx`

**i18n namespace**: `search_ai.crawl_flow` — same as State4Crawl (strings are moved, not created).

**Move FROM State4Crawl into CrawlProgressView:**

1. Helper components (already pure — no state, no side effects):
   - `ProgressBar` component
   - `PhaseCard` component
   - `groupFailures()` function + `FailureGroup` interface
   - `computeQuality()` function (returns `QualityBreakdown` — now imported from types)
   - `SectionFillRates` component (with `SECTION_COLLAPSE_THRESHOLD`)

2. All hook wiring and derived state:
   - `useCrawlProgress(jobId)` — WS real-time
   - `useMultiPageProgress(jobId)` — per-page tracking
   - Progress derivation (WS → REST fallback)
   - Terminal state detection with sticky refs (`isDoneRef`, `isFailedRef`)
   - `onComplete` callback on terminal — passes `CrawlProgressResult` snapshot
   - Skipped URL tracking (capped at 200)
   - WS connection tracking + REST polling fallback (10s interval)
   - **REST polling cleanup**: the `useEffect` with `pollIntervalRef` and its cleanup function moves verbatim from State4Crawl
   - **`onProgressUpdate` callback**: fires in a `useEffect` whenever `completedCount`, `failedCount`, or `totalCount` change. This gives parent components (State4Crawl) live counts for the backgrounding dialog without duplicating hooks.
   - Failure grouping, quality breakdown, section fill rate memos

3. **sections prop handling**: Destructure with default `sections = []`:

   ```typescript
   export function CrawlProgressView({
     jobId, sourceId, url, sections = [], totalPages = 0,
     onComplete, discoveryProgress, categoryCrawlStatus,
   }: CrawlProgressViewProps) {
   ```

   All section iteration (`.find()`, `.filter()`) is safe with empty array — produces empty fills, which means section fill rates simply don't render when sections aren't provided (the `{sectionFill.length > 0 && ...}` guard handles this).

4. **`onProgressUpdate` implementation**: Add a `useEffect` that fires whenever `completedCount`, `failedCount`, or `totalCount` change:

   ```typescript
   useEffect(() => {
     onProgressUpdate?.({ completedCount, failedCount, totalCount });
   }, [completedCount, failedCount, totalCount, onProgressUpdate]);
   ```

   This gives State4Crawl live counts for the backgrounding dialog without duplicating hooks. USP doesn't pass this callback (doesn't need live counts — its ActionsBar has its own dashboard polling).

5. Render output:
   - Header ("Crawl In Progress" / "Crawl Complete" / "Crawl Failed") with URL and connection indicator
   - Progress bar with X/Y pages processed + percentage
   - Phase cards grid (3 cols: Crawled, Processed, Failed)
   - Quality breakdown (good/thin/empty)
   - Dual progress bars (discovery mode)
   - Per-category crawl status
   - Section fill rates (only rendered when sections data available from WS or props)
   - Failure details (grouped by reason, 5 URLs shown + "+N more")
   - Skipped URLs (collapsible)

**What CrawlProgressView does NOT include:**

- Cancel/Back buttons and their confirmation dialogs
- `CrawlCompletionSummary` card with "View Results" button
- `onViewResults`, `onBack` props
- Discovery store interaction (`addItem` for backgrounding)
- Thin pages recrawl tracking
- Any navigation logic

### Step 3: Refactor `State4Crawl.tsx`

**File**: `apps/studio/src/components/search-ai/crawl-flow/State4Crawl.tsx`

Replace extracted code with a wrapper around `CrawlProgressView`. Keep:

- `CrawlCompletionSummary` component (stays in this file — wizard-specific)
- Cancel handler + confirmation dialog
- Back handler + backgrounding dialog (3-option)
- Action bar (Back, Cancel, View Results)

```tsx
import { CrawlProgressView } from './CrawlProgressView';
import type { CrawlProgressResult, CrawlProgressStats } from './types';

export function State4Crawl({
  jobId, sourceId, url, sections, totalPages,
  onViewResults, onBack, onCrawlComplete,
  discoveryProgress, categoryCrawlStatus,
}: State4CrawlProps) {
  const t = useTranslations('search_ai.crawl_flow');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showBackConfirm, setShowBackConfirm] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [terminalResult, setTerminalResult] = useState<CrawlProgressResult | null>(null);

  // Live progress stats — updated by CrawlProgressView on each WS/REST event.
  // Used by the backgrounding dialog which fires during ACTIVE crawl (terminalResult is null).
  const [liveStats, setLiveStats] = useState<CrawlProgressStats>({
    completedCount: 0, failedCount: 0, totalCount: 0,
  });

  const addItem = useDiscoveryStore((s) => s.addItem);

  const handleProgressComplete = useCallback((result: CrawlProgressResult) => {
    setTerminalResult(result);
    if (result.state === 'done') onCrawlComplete?.();
  }, [onCrawlComplete]);

  // Mirror live stats from CrawlProgressView — for backgrounding dialog
  const handleProgressUpdate = useCallback((stats: CrawlProgressStats) => {
    setLiveStats(stats);
  }, []);

  const effectiveIsDone = terminalResult?.state === 'done';
  const effectiveIsFailed = terminalResult?.state === 'failed';

  // Cancel handler — same as current
  const handleCancel = useCallback(async () => {
    setIsCancelling(true);
    try {
      await cancelCrawlJob(jobId);
      toast.success(t('crawl_cancelled'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg);
    } finally {
      setIsCancelling(false);
      setShowCancelConfirm(false);
    }
  }, [jobId, t]);

  return (
    <div className="space-y-6">
      <CrawlProgressView
        jobId={jobId}
        sourceId={sourceId}
        url={url}
        sections={sections}
        totalPages={totalPages}
        onComplete={handleProgressComplete}
        onProgressUpdate={handleProgressUpdate}
        discoveryProgress={discoveryProgress}
        categoryCrawlStatus={categoryCrawlStatus}
      />

      {/* Completion summary — wizard-specific */}
      {effectiveIsDone && terminalResult && (
        <CrawlCompletionSummary
          completedCount={terminalResult.completedCount}
          failedCount={terminalResult.failedCount}
          thinCount={terminalResult.thinCount}
          quality={terminalResult.quality}
          totalCount={terminalResult.totalCount}
          sourceId={sourceId}
          onViewResults={onViewResults}
          t={t}
        />
      )}

      {/* Action bar — same behavior as current */}
      <div className="flex items-center justify-between pt-2 border-t border-border-default">
        {effectiveIsDone ? (
          /* Back + View Results + thin pages hint using terminalResult.thinCount */
          /* NOTE: Replace old `thinPages.length` with `terminalResult?.thinCount ?? 0` */
        ) : effectiveIsFailed ? (
          /* Back + View Results */
        ) : (
          /* Back (with backgrounding confirm) + Cancel */
          /* Backgrounding dialog uses liveStats.completedCount/totalCount/failedCount */
        )}
      </div>

      {/* Cancel confirmation — same as current */}
      <ConfirmDialog ... />
      {/* Back confirmation with backgrounding — uses liveStats for activity bar item:
          addItem({ ..., crawlProgress: {
            crawled: liveStats.completedCount,
            total: liveStats.totalCount,
            failed: liveStats.failedCount,
          }})
      */}
      <Dialog ... />
    </div>
  );
}
```

**Data flow for backgrounding dialog (blocker fix from dry-run R1):**

- During ACTIVE crawl: `terminalResult` is null, `liveStats` has current counts from `onProgressUpdate`
- Backgrounding dialog uses `liveStats.completedCount`, `liveStats.totalCount`, `liveStats.failedCount`
- This replaces the old direct access to `completedCount`/`totalCount`/`failedCount` hook-derived state

**Thin pages hint in action bar (fix from dry-run R2):**

- Old code: `thinPages.length` (from `multiPage.pages` memo — moved to CrawlProgressView)
- New code: `terminalResult?.thinCount ?? 0` (from `onComplete` snapshot)
- Only shown when `effectiveIsDone` is true, so `terminalResult` is always available

**CrawlCompletionSummary data model**: The `onComplete` callback passes a `CrawlProgressResult` snapshot at terminal time. This is a snapshot — the summary won't update after terminal. This is acceptable because:

- `isDoneRef` is sticky — once true, no state changes revert it
- The `job_completed` WS event is the last meaningful event
- Late events (if any) don't change counts because the sticky ref prevents re-rendering

**Remaining in State4Crawl after extraction**: ~160 lines (from current ~560 lines):

- `CrawlCompletionSummary` component (~55 lines)
- State4Crawl wrapper with cancel/back/backgrounding logic + liveStats mirroring (~105 lines)

### Step 4: Export from barrel

**File**: `apps/studio/src/components/search-ai/crawl-flow/index.ts`

```typescript
export { CrawlFlowV5 } from './CrawlFlowV5';
export { CrawlProgressView } from './CrawlProgressView';
export type { CrawlFlowV5Props, CrawlProgressViewProps } from './types';
```

### Step 5: Integrate into USP Pages Tab

**File**: `apps/studio/src/components/search-ai/source-page/UnifiedSourcePage.tsx`

#### 5a. Import and state

```typescript
import { CrawlProgressView } from '@/components/search-ai/crawl-flow/CrawlProgressView';

// Inside UnifiedSourcePageContent:
// New state: optimistic recrawl job ID (bridges the SWR gap)
const [recrawlJobId, setRecrawlJobId] = useState<string | null>(null);
```

#### 5b. Update handleQuickRecrawl to capture jobId

```typescript
const handleQuickRecrawl = useCallback(
  async (options?: { force?: boolean }) => {
    if (!indexId || !sourceId) return;
    try {
      const result = await recrawlSource({
        sourceId,
        indexId,
        forceReprocess: options?.force ?? false,
      });
      if (result.success) {
        toast.success(options?.force ? t('force_recrawl_submitted') : t('recrawl_submitted'));
        setHasActiveJob(true);
        if (result.jobId) {
          setRecrawlJobId(result.jobId); // ← capture for instant progress
          setActiveTab('pages'); // ← auto-switch to pages tab
          window.history.replaceState({}, '', `${window.location.pathname}?tab=pages`);
        }
        mutateSources();
        mutateHistory();
      } else {
        toast.error(t('recrawl_failed'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('recrawl_failed'));
    }
  },
  [indexId, sourceId, t, mutateSources, mutateHistory],
);
```

#### 5c. Clear recrawlJobId when SWR catches up

**Simplified from review feedback** — clear on `isCrawling` transition, not jobId matching:

```typescript
// When displayState transitions to crawling (SWR caught up), clear optimistic recrawlJobId.
// This is more robust than jobId matching — handles cases where backend returns
// a different jobId than the recrawl API (e.g., deduplication to existing queued job).
useEffect(() => {
  if (isCrawling && recrawlJobId) {
    setRecrawlJobId(null);
  }
}, [isCrawling, recrawlJobId]);
```

#### 5d. Derive whether to show progress view

```typescript
// Show progress view during active crawl OR optimistic recrawl gap
const showCrawlProgress = isCrawling || recrawlJobId !== null;
const progressJobId = isCrawling ? activeJobId : recrawlJobId;
```

#### 5e. Pages tab rendering (replace current block)

```tsx
{
  /* Tab Content */
}
<div className="min-h-[300px]" data-testid="usp-tab-content">
  {activeTab === 'pages' && showCrawlProgress && progressJobId && (
    <CrawlProgressView
      jobId={progressJobId}
      sourceId={sourceId}
      url={source.url || source.name}
      onComplete={() => {
        // Crawl finished — clear optimistic state, refresh data
        setRecrawlJobId(null);
        mutateSources();
        mutateHistory();
      }}
    />
  )}
  {activeTab === 'pages' && !showCrawlProgress && displayJob && indexId && (
    <CrawledPagesView
      jobId={displayJob._id}
      indexId={indexId}
      sourceId={sourceId}
      refreshInterval={undefined}
    />
  )}
  {activeTab === 'pages' && !showCrawlProgress && !displayJob && (
    <div className="text-sm text-muted p-8 text-center">{t('no_crawl_data')}</div>
  )}
  {/* history + settings tabs unchanged */}
</div>;
```

**Intentional behavioral change**: `CrawledPagesView` previously received `refreshInterval={isCrawling ? 5000 : undefined}`. Now it only renders when `!showCrawlProgress` (crawl is not active), so `refreshInterval` is always `undefined`. During active crawl, `CrawlProgressView` replaces it entirely with WebSocket-driven real-time progress — a strictly better experience than 5s REST polling of a document table.

---

## Duplicate WebSocket Analysis

| Consumer                           | Hook                            | When Active                          |
| ---------------------------------- | ------------------------------- | ------------------------------------ |
| `USPStatusStrip`                   | `useCrawlProgress(activeJobId)` | `displayState === 'crawling'`        |
| `CrawlProgressView` (in Pages tab) | `useCrawlProgress(jobId)`       | `showCrawlProgress && progressJobId` |

Same jobId → two WS connections to the same endpoint.

**Assessment:**

- **Functionally safe** — both get the same events independently
- **Slightly wasteful** — two WebSocket connections for one job
- **Acceptable tradeoff** — refactoring to share would couple StatusStrip and Pages tab, breaking pluggability
- **Future optimization** — could lift WS connection to USP and pass events down as props, but not needed for initial implementation

**During optimistic gap** (recrawlJobId set, SWR not yet caught up):

- USPStatusStrip: `isCrawling` is false → WS NOT connected (no double connection during gap)
- CrawlProgressView: connected to `recrawlJobId` → WS connected
- Once SWR catches up: both connect → brief double connection (acceptable)

---

## Optimistic State Behavior

### Timeline After Recrawl Click

| Phase                  | Duration       | User Sees (BEFORE fix)       | User Sees (AFTER fix)                                      |
| ---------------------- | -------------- | ---------------------------- | ---------------------------------------------------------- |
| Button click           | Instant        | Spinner on button only       | Spinner on button                                          |
| API call               | ~200-500ms     | Page unchanged               | Page unchanged                                             |
| API returns with jobId | Instant        | Toast only                   | Toast + **Pages tab switches to CrawlProgressView**        |
| **SWR gap**            | **200-5000ms** | **Stale completed/failed**   | **CrawlProgressView showing "Connecting..."**              |
| WS connects            | ~100ms         | —                            | **Live progress bar, phase cards**                         |
| Pages crawled          | 5-60s          | Old pages, then suddenly new | **Progressive updates via WS**                             |
| Crawl completes        | —              | Stats update via SWR         | **onComplete fires → transition back to CrawledPagesView** |

### StatusStrip Behavior

StatusStrip is NOT optimistically updated. It will:

1. Show old completed/failed stats for 200ms-5s (SWR gap)
2. Once SWR returns new active job → `displayState` flips to `crawling` → stats zero out → dashboard polling starts

This is acceptable because:

- The Pages tab (which the user is looking at) transitions instantly
- StatusStrip catches up within one SWR poll interval (5s max)
- Optimistically overriding StatusStrip would require overriding `displayState` which flows through Header badge too — more risk for marginal gain

---

## Testing Scenarios

### Regression (must pass — existing behavior preserved)

1. **First-time crawl via wizard**: User goes through Steps 1-3 → clicks "Crawl N Pages" → State4Crawl renders with progress bar, phase cards, quality, failure groups → crawl completes → "View Results" button → navigates to USP
2. **State4Crawl cancel**: During wizard crawl → click Cancel → confirmation dialog → cancels job → toast
3. **State4Crawl back + backgrounding**: During wizard crawl → click Back → 3-option dialog (minimize/stay/go back)
4. **State4Crawl completion summary**: After wizard crawl completes → summary card with stats + quality + "View Results"
5. **USP during first-time crawl navigation**: Wizard calls `onComplete(jobId, sourceId, url)` → navigates to USP → SWR picks up active job → StatusStrip shows crawling stats → Pages tab shows CrawlProgressView (new behavior — previously showed CrawledPagesView with 5s polling)

### New Behavior (recrawl from USP)

6. **Recrawl instant transition**: Click Recrawl on USP → toast + Pages tab immediately shows CrawlProgressView with "Connecting..." → WS connects → live progress
7. **Force recrawl**: Click Force Recrawl dropdown → same instant transition
8. **Tab auto-switch**: User is on History tab → clicks Recrawl → auto-switches to Pages tab showing progress
9. **Progress completes**: CrawlProgressView shows "Crawl Complete" header → `onComplete` fires → Pages tab transitions back to CrawledPagesView showing new results
10. **Progress fails**: CrawlProgressView shows "Crawl Failed" → `onComplete` fires → Pages tab transitions back to CrawledPagesView
11. **Cancel during recrawl**: USP ActionsBar "Cancel Crawl" button → cancels job → progress view shows terminal state → transitions to CrawledPagesView
12. **Run in Background**: USP ActionsBar "Run in Background" → naming dialog → navigates to KB page → crawl continues in background
13. **SWR catches up**: After recrawlJobId is set optimistically, SWR returns the real job → `isCrawling` becomes true → recrawlJobId cleared → progress continues seamlessly from SWR-tracked activeJobId
14. **WS fallback**: If WebSocket fails, CrawlProgressView falls back to REST polling at 10s intervals (same as current State4Crawl behavior)

### Edge Cases

15. **Double recrawl**: User clicks Recrawl twice quickly → second click blocked by loading state in USPActionsBar (2s cooldown)
16. **Navigate away during recrawl**: User goes to History/Settings tab → CrawlProgressView unmounts (WS disconnects) → user returns to Pages → CrawlProgressView remounts (WS reconnects to same jobId)
17. **Page refresh during recrawl**: `recrawlJobId` is lost (React state) but SWR will pick up the active job on remount → displayState becomes crawling → CrawlProgressView shown via `isCrawling` path
18. **Recrawl with all-unchanged pages**: Backend marks job as completed (fixed in earlier commit `76db5cb51e`) → CrawlProgressView shows "Crawl Complete" → transitions back to CrawledPagesView
19. **Recrawl deduplication**: Backend returns different jobId than expected (e.g., dedup to existing queued job) → doesn't matter, cleanup is based on `isCrawling` transition, not jobId matching

---

## Open Questions

None — all design decisions resolved.
