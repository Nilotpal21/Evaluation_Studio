# Unified Source Page — High-Level Design

## What

Replace the `SourceDetailPanel` slide panel (for web sources only) with a full-page experience at `/searchai/{kbId}/sources/{sourceId}`. One page handles all web source states: configuring, crawling, completed, completed with issues, failed, cancelled, and idle. Non-web sources (manual, database, API, SharePoint) keep their current panels — zero regression.

**No backend changes required.** All endpoints already exist. This is a pure frontend feature.

---

## Verified Assumptions (Code Reality Check — 2026-05-17)

All components, hooks, APIs, and models referenced in this HLD were verified against
actual source code. Key findings incorporated into the design:

| #   | Assumption                                                                                  | Verified | Notes                                                                              |
| --- | ------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| 1   | CrawledPagesView props: `{ jobId, indexId, sourceId }`                                      | ✅       | No `refreshInterval` prop — must be ADDED (see A-5)                                |
| 2   | CrawlJobHistory props include `externalJobs?`, `onSelectJob?`, `onRecrawl?`, `onDeleteJob?` | ✅       | `onRecrawl: (urls: string[], strategy?) => void`, `onDeleteJob: () => void`        |
| 3   | `useCrawlProgress` returns `{ connected, isReconnecting }` booleans                         | ✅       | Also: `lastEvent`, `events` (cap 200), `error`, `connect`, `disconnect`            |
| 4   | `useCrawlProgress` reconnection: 5 attempts                                                 | ✅       | Linear backoff: 5s, 10s, 15s, 20s, 25s (75s total)                                 |
| 5   | `getCrawlDashboard` returns quality data                                                    | ⚠️       | Returns `ingestion.avgQualityScore` (live). Frontend type stale — needs extending. |
| 6   | CrawlJob has `results.qualityMetrics`                                                       | ✅       | `{ avgQualityScore, avgContentPreservation, avgChunksPerDoc, successRate }`        |
| 7   | CrawlJob has `sourceId` (indexed)                                                           | ✅       |                                                                                    |
| 8   | CrawlJob has NO `projectId`                                                                 | ✅       | Security gap — logged as pre-requisite                                             |
| 9   | `handleRowClick` else clause catches web+non-web                                            | ✅       | Lines 335-339. Split needed exactly as designed.                                   |
| 10  | `handleCrawlComplete` doesn't navigate                                                      | ✅       | Parent ignores args. T-6 must add navigation.                                      |
| 11  | `sourceType` includes `'web'`                                                               | ✅       | Values: `manual, web, database, api, sharepoint`                                   |
| 12  | Missing index on `sourceMetadata.crawlJobId`                                                | ✅       | Confirmed absent. Pre-requisite.                                                   |
| 13  | Rate limit: 120 req/min/tenant                                                              | ✅       | Configurable via `SEARCH_AI_RATE_LIMIT` env                                        |
| 14  | `useCrawlFlowStore.open(sourceId?)`                                                         | ✅       | Optional param. Store only sets `active` + `sourceId`.                             |
| 15  | `fetchSources` pagination                                                                   | ⚠️       | Defaults to limit=50. Fine for USP (find one source by ID).                        |

---

## Architecture

### System Context — Where USP Fits

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        KB Detail Page (existing)                            │
│                                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
│  │ Home Tab │  │ Data Tab │  │Intel Tab │  │Search Tab│                   │
│  └──────────┘  └────┬─────┘  └──────────┘  └──────────┘                   │
│                     │                                                       │
│              ┌──────▼──────┐                                               │
│              │ SourcesTable │                                               │
│              │ (list view)  │                                               │
│              └──────┬──────┘                                               │
│                     │                                                       │
│    ┌────────────────┼────────────────────────────────────┐                  │
│    │                │                │                   │                  │
│    ▼                ▼                ▼                   ▼                  │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────────────┐         │
│  │CrawlFlow │  │SourceDtl │  │SharePoint  │  │ Connector Detail │         │
│  │V5 Wizard │  │Panel     │  │Detail Panel│  │ Panel            │         │
│  │(full pg) │  │(slide)   │  │(store)     │  │ (slide)          │         │
│  └──────────┘  └──────────┘  └────────────┘  └──────────────────┘         │
│   web+config    non-web       sharepoint      enterprise                   │
│                                                                             │
│  ──── AFTER USP ────                                                       │
│                                                                             │
│    ┌────────────────┼──────────────────────────────────────┐               │
│    │                │                │         │           │               │
│    ▼                ▼                ▼         ▼           ▼               │
│  CrawlFlowV5   ╔══════════╗   SourceDtl  SharePoint  Connector           │
│  (web+config)  ║ USP      ║   Panel      Detail      Detail              │
│                ║ (NEW)    ║   (non-web)   Panel       Panel               │
│                ║ full pg  ║                                                │
│                ╚══════════╝                                                │
│                web+non-config                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Click Routing — 5 Branches (Only Branch 5 Changes)

```
handleRowClick(source):
  │
  ├─ B1: web + (configuring|draft)  ──→ useCrawlFlowStore.open(sourceId)     UNCHANGED
  │       checked FIRST                  → CrawlFlowV5 wizard (full page)
  │
  ├─ B2: sharepoint + connectorId   ──→ useConnectorStore.openPanel(cId)     UNCHANGED
  │                                      → SharePointDetailPanel
  │
  ├─ B3: connector + !manual        ──→ setConnectorId → ConnectorDetailPanel UNCHANGED
  │                                      → Enterprise connector slide panel
  │
  ├─ B4: manual|file|database|api   ──→ setSourceId → SourceDetailPanel      UNCHANGED
  │       (no connector, non-web)        → Slide panel (640px)
  │
  └─ B5: web + non-configuring      ──→ navigate(USP route)                  ★ NEW
         (the ONLY change)               → Full page at /sources/:sourceId
```

**Critical:** Current code has B4+B5 merged in a single `else` clause. USP must split:

```typescript
} else if (row.sourceType === 'web') {
  navigate(`/projects/${projectId}/search-ai/${kbId}/sources/${row._id}`);  // NEW
} else {
  setSelectedSourceId(row._id);  // UNCHANGED — manual/file/database/api
  setSourcePanelOpen(true);
}
```

### Navigation Flow — Entry & Exit

```
                    ENTRY POINTS                              EXIT POINTS
                    ────────────                              ───────────

  SourcesTable ──click web row──→ ┌──────────┐ ──← My KB──→ KB Detail (data tab)
                                  │          │
  CrawlFlowV5 ──onComplete─────→ │   USP    │ ──View Docs→ KB Detail (docs tab)
                                  │          │
  Toast [View Results] ─────────→ │          │ ──Run in Bg→ KB Detail (data tab)
                                  │          │
  Direct URL /sources/:id ──────→ │          │ ──Recrawl──→ CrawlFlowV5 (full pg)
                                  │          │               └→ onComplete → USP
  History job click ────────────→ │ (State J)│
                                  └──────────┘
                                       │
                                  Delete Source → KB Detail (navigate away)
```

### Component Tree

```
page.tsx (Next.js App Router)
  └─ UnifiedSourcePage (client component, orchestrator)
      │
      │  State: source, knowledgeBase, anchoredJobId, viewingJobId,
      │         displayState, activeTab, dashboardData
      │
      │  Anchoring: anchoredJobId set on first mount (latest job for THIS source)
      │             only changes on: fresh mount, CrawlFlowV5 onComplete
      │             NOT changed by: SWR refresh, retry jobs, other users' crawls
      │  activeJobId = viewingJobId ?? anchoredJobId
      │  displayJob  = sourceJobs.find(j => j._id === activeJobId) ?? sourceJobs[0]
      │
      │  URL: ?tab=pages|history|settings (synced via useSearchParams)
      │  SWR: KB → indexId → source + jobs(filter by sourceId) + dashboard
      │  WS:  useCrawlProgress(activeJobId) — only when displayState === 'crawling'
      │
      ├─ USPHeader
      │    ├─ PageBreadcrumb  [← My KB / epson.com]
      │    ├─ Badge  [● Crawling] or [✓ Active] etc.
      │    └─ DropdownMenu  [⋮] → Recrawl, Delete Source
      │
      ├─ USPStatusStrip
      │    ├─ ContextualMessage  "Crawling product pages (134 of ~200)"
      │    ├─ Progress bar  (animated, color per state)
      │    ├─ StatCounters  [Pages|Documents|Failed|Queued/Duration|Elapsed]
      │    │    └─ AnimatedCounter (per stat, rolls up/down)
      │    ├─ QualityBar  (post-crawl: green/amber/red segments)
      │    ├─ ActionableSuggestions  (dismissible alerts)
      │    ├─ ConnectionIndicator  "Live 📡" / "Polling"
      │    └─ HistoricalBanner  "📋 Viewing crawl from May 9 [Back to latest →]"
      │
      ├─ Tabs  [Pages] [History] [Settings]  ← synced to ?tab= query param
      │    │
      │    ├─ PagesTab
      │    │    ├─ CrawledPagesView  (REUSE — { jobId, indexId, sourceId })
      │    │    │    └─ refreshInterval: 5000 during crawl, undefined otherwise
      │    │    ├─ ErrorGroupingPanel  (NEW — below table)
      │    │    │    └─ Groups failed pages by error type + [Retry All] (fire-and-forget)
      │    │    ├─ EmptyDuringCrawl  (State B — pulsing + "Pages will appear...")
      │    │    └─ AutoScrollPill  "↓ 12 new pages" (during live crawl)
      │    │
      │    ├─ HistoryTab
      │    │    └─ CrawlJobHistory  (REUSE — { indexId, onSelectJob, ... })
      │    │         └─ Client-side filter: jobs.filter(j => j.sourceId === source._id)
      │    │
      │    └─ SettingsTab  (NEW — read-only)
      │         ├─ StrategyCard  (guided-discovery / crawl-sitemap / direct-urls)
      │         ├─ ScopeCard  (maxPages, maxDepth, requestDelay)
      │         ├─ SectionsCard  (pattern list with page counts)
      │         ├─ RenderingCard  (HTTP vs Playwright per section)
      │         ├─ AuthCard  (method type only, no credentials)
      │         ├─ ProfileCard  (siteType, hasSitemap, jsRequired, platform, avgResponseTime)
      │         └─ DangerZone  [Delete Source] → ConfirmDialog
      │
      └─ USPActionsBar
           └─ Buttons per display state (see Actions Matrix)
```

### Data Flow — SWR Cascade + Job Anchoring

```
  Data Model Chain:
    Project → SearchIndex (projectId) → SearchSource (indexId) → CrawlJob (sourceId, indexId)
    CrawlJob has both sourceId and indexId — both stored and indexed.

  URL params: { kbId, sourceId }
       │
       ▼
  SWR: getKnowledgeBase(kbId) ──→ knowledgeBase.searchIndexId = indexId
       │
       ├──→ SWR: fetchSources(indexId) ──→ find source by sourceId
       │         └→ source object (status, crawlConfig, name, etc.)
       │         └→ Guard: if source missing from list → redirect + toast
       │
       ├──→ SWR: getCrawlHistory(indexId, 100)
       │         └→ sourceJobs = jobs.filter(j => j.sourceId === source._id)
       │
       │    Job Anchoring (prevents retry/other-user jobs from hijacking display):
       │         └→ anchoredJobId: set ONCE on first load = sourceJobs[0]._id
       │         └→ activeJobId  = viewingJobId ?? anchoredJobId
       │         └→ displayJob   = sourceJobs.find(j => j._id === activeJobId)
       │         └→ displayState = deriveDisplayState(source, displayJob)
       │         └→ Anchor changes ONLY on: fresh mount, CrawlFlowV5.onComplete
       │         └→ Anchor does NOT change on: SWR refresh, retry jobs, other users
       │
       ├──→ SWR: getCrawlDashboard(activeJobId)  [only when crawling]
       │         └→ phase progress, stats, quality, errors
       │         └→ refreshInterval: 10000 (10s — rate limit safe)
       │
       └──→ WS: useCrawlProgress(activeJobId)  [only when crawling]
                 └→ real-time events: url_fetched, document_processed,
                    job_completed, job_failed
                 └→ on job_completed → mutate(source SWR) → displayState transitions

  Pages tab (independent):
       └──→ SWR: getCrawledPages(activeJobId, { status, search, offset })
                 └→ refreshInterval: 5000 during crawl, undefined otherwise
```

### State Derivation

```typescript
type DisplayState =
  | 'configuring' // source.status === 'configuring'
  | 'pending' // source.status === 'pending', no jobs
  | 'crawling' // active job: queued|crawling|ingesting|indexing
  | 'completed' // job completed, 0 failures
  | 'completed_with_issues' // job completed, failures > 0 or thin content
  | 'failed' // job failed
  | 'cancelled' // job cancelled
  | 'idle'; // source active, no active job

// Job status takes priority over source status when job exists
// Source status only used for configuring/pending (pre-job states)
// "completed_with_issues" is frontend-derived, not a backend status
// displayJob = anchored job (stable), NOT jobs[0] (moving target)
// See Job Anchoring in Data Flow section
```

### File Structure — New Files

```
apps/studio/src/
  app/projects/[projectId]/search-ai/[kbId]/sources/[sourceId]/
    page.tsx                          ← Next.js route (thin, delegates to component)

  components/search-ai/source-page/
    UnifiedSourcePage.tsx             ← Orchestrator (state, SWR, WS lifecycle)
    USPHeader.tsx                     ← Zone 1: breadcrumb + badge + menu
    USPStatusStrip.tsx                ← Zone 2: progress + stats + quality + suggestions
    USPActionsBar.tsx                 ← Zone 4: context-sensitive buttons
    USPSettingsTab.tsx                ← Settings tab (read-only config cards)
    ErrorGroupingPanel.tsx            ← Error groups with Retry All
    AnimatedCounter.tsx               ← Number roll-up animation
    types.ts                          ← DisplayState, props interfaces
    utils.ts                          ← deriveDisplayState, formatters

  proxy.ts                            ← Add route exclusion (1 line)

packages/i18n/locales/en/
  studio.json                         ← Add search_ai.source_page.* keys
```

---

## Design Analysis — Gap Assessment

### Category 1: NEW (Build From Scratch)

| #    | Component                        | Complexity | Design Decisions                                                         |
| ---- | -------------------------------- | ---------- | ------------------------------------------------------------------------ |
| N-1  | `UnifiedSourcePage` orchestrator | HIGH       | State shape, SWR cascade, WS lifecycle, loading/error                    |
| N-2  | `USPHeader`                      | LOW        | Badge mapping from DisplayState, ⋮ menu items per state                  |
| N-3  | `USPStatusStrip`                 | HIGH       | WS events → stats, quality bar, suggestions, State J banner, transitions |
| N-4  | `USPActionsBar`                  | MEDIUM     | 7-state button matrix, dialog triggers                                   |
| N-5  | `USPSettingsTab`                 | LOW        | Read-only card layout from crawlConfig                                   |
| N-6  | `ErrorGroupingPanel`             | MEDIUM     | Client-side grouping, Retry All mechanism                                |
| N-7  | `AnimatedCounter`                | LOW        | CSS transition or Framer Motion counter                                  |
| N-8  | State derivation                 | LOW        | Pure function, edge cases documented                                     |
| N-9  | Historical job viewing           | MEDIUM     | viewingJobId state flow across components                                |
| N-10 | Auto-scroll + pill               | MEDIUM     | Scroll detection, floating pill UI                                       |
| N-11 | Background toast                 | LOW        | SWR status-change detection (V1 polling-based)                           |
| N-12 | Route page                       | LOW        | Thin page.tsx + proxy.ts exclusion                                       |

### Category 2: EXISTING (Reuse Directly — Zero Changes)

| #   | Component/Hook           | Reuse As          | Confidence                                                                         |
| --- | ------------------------ | ----------------- | ---------------------------------------------------------------------------------- |
| E-1 | `CrawlJobHistory`        | History tab       | HIGH — props: `{ indexId, externalJobs?, onSelectJob?, onRecrawl?, onDeleteJob? }` |
| E-2 | `useCrawlProgress`       | WS hook           | HIGH — auto-connect/disconnect, linear backoff (5s, 10s, 15s, 20s, 25s)            |
| E-3 | `useMultiPageProgress`   | Per-page tracking | HIGH                                                                               |
| E-4 | `getCrawlDashboard`      | REST fallback     | HIGH — note: frontend `DashboardResponse` type needs extending (see T-2 notes)     |
| E-5 | Design system components | All zones         | HIGH — Tabs, Badge, Button, ConfirmDialog, etc.                                    |
| E-6 | API client functions     | All data          | HIGH — all verified against backend                                                |
| E-7 | `PageBreadcrumb`         | Header            | HIGH                                                                               |
| E-8 | `sonner` toast           | Notifications     | HIGH                                                                               |

### Category 3: EXISTING — Needs Adaptation

| #   | Component                | Change                                      | Risk                                                 |
| --- | ------------------------ | ------------------------------------------- | ---------------------------------------------------- |
| A-1 | `handleRowClick`         | Split else: web→USP, non-web→panel          | **HIGH** — wrong split breaks all non-web (see RJ-3) |
| A-2 | `handleCrawlComplete`    | Add navigate to USP after closeCrawlFlow    | LOW                                                  |
| A-3 | `proxy.ts`               | Add route exclusion pattern                 | LOW                                                  |
| A-4 | `CrawlJobHistory` filter | Client filter `job.sourceId === source._id` | LOW                                                  |
| A-5 | `CrawledPagesView`       | Add `refreshInterval` prop for live polling | LOW                                                  |
| A-6 | `CrawlFlowV5` onComplete | Consumer changes navigation target          | LOW                                                  |

### Category 4: Protocol Decisions

#### P-1: WebSocket Lifecycle

- **StatusStrip owns WS connection** via `useCrawlProgress(activeJobId)` — only when `displayState === 'crawling'`
- **Pages tab uses independent SWR polling** — `refreshInterval: 5000` during crawl (rate limit safe)
- **No shared event bus** — each zone fetches its own data to avoid coupling
- **Transition detection:** WS `job_completed` → `mutate(['sources', indexId])` → SWR refetch → displayState recalculates
- **Late-joiner:** REST `getCrawlDashboard` provides accumulated state on mount + WS picks up live events

#### P-2: Error Grouping + Retry All

- Client-side: `getCrawledPages(jobId, { status: 'failed', limit: 200 })` → group by `page.error`
- Cap: 200 failed pages in V1. Show "first 200 of N" if more.

**Retry All — Fire-and-Forget (Job Anchoring Safe):**

```
User clicks [Retry All] on error group (e.g., 2 timeout pages)
  → submitBatchCrawl({ urls: groupUrls, sourceId, indexId, strategy: 'single-page' })
  → New CrawlJob created (has same sourceId — appears in sourceJobs on next SWR refresh)
  → [Retry All] button → loading/disabled
  → Toast: "Retrying 2 pages..."
  → anchoredJobId UNCHANGED → displayState UNCHANGED → page context preserved
  → User still sees original 187 pages, 3 failed, all stats intact

Retry job completes (detected via SWR jobs refresh — new job status becomes terminal):
  → Toast: "Retry complete — 2 pages re-crawled. View in History."
  → [Retry All] button re-enables
  → Retry job visible in History tab
  → Original job's page list unchanged (failed pages still show as failed)
```

**Why fire-and-forget:** The backend creates a NEW CrawlJob for every
`submitBatchCrawl` call. There is no "retry within job" API. The new job's
pages are separate SearchDocuments (or updated documents with new crawlJobId).
The original job's page list doesn't change. Without the anchoring model,
the retry job would hijack `latestJob` → destroy the user's view context.

**V1 limitation:** Retry results not visible inline — user checks History.
**V2 path:** Backend adds `POST /crawl/jobs/:jobId/retry` — re-queues URLs
within same job, updates SearchDocuments in-place, inline results visible.

**Per-row ↻ retry:** Same fire-and-forget behavior. Already exists in
`CrawledPagesView.handleRetry`. No change needed — USP reuses as-is.

#### P-3: State Derivation Edge Cases

- Job status > source status (source may be stale by seconds)
- Must verify `job.sourceId === source._id` (history is index-wide)
- `completed_with_issues` = `job.completed + (failed > 0 || thin > threshold)`
- No job for source → `pending` (if source.status === 'pending') or `idle` (if active)

#### P-4: Background Toast (V1)

- Polling-based: SWR source list already refreshes. Compare `source.status` previous vs current.
- On transition from non-terminal → terminal: fire toast with source name + page count
- **V1 scope:** Toast only fires when KB source list is actively polled (user is on KB detail page). When user is on USP for a DIFFERENT source, KB page is unmounted → no source list polling → no toast for other sources. This is acceptable for V1.
- V2 upgrade path: global WS listener for `job_completed`/`job_failed` events (fires anywhere)

#### P-5: Pages Live Revalidation

- `refreshInterval: 5000` during crawl, `undefined` when terminal (5s, not 3s — rate limit budget)
- Dashboard polling: `refreshInterval: 10000` during crawl (10s)
- Total per user: ~18 req/min (well under 120/min tenant budget for 6 concurrent viewers)
- Minor prop addition to `CrawledPagesView` — pass from orchestrator

#### P-6: Two-Step Data Fetch

- Page URL has `kbId` → fetch KB → extract `searchIndexId` → fetch source/jobs
- Same pattern as `KnowledgeBaseDetailPage`
- SWR conditional keys (`key = null` until indexId available)

---

## Error Recovery & Degraded Mode

### SWR Cascade Failure Handling

The 2-step data fetch (KB → indexId → source/jobs) has 3 distinct failure points.
Each gets its own error UX:

```
Failure Point          Cause                    UX Response
─────────────────────  ───────────────────────  ──────────────────────────────────
KB fetch fails         Network error / 500      Full-page error: "Couldn't load
                                                knowledge base" + [Retry] button
                                                (re-triggers SWR mutate)

KB returns 404         KB deleted / wrong ID    Redirect to /search-ai with
                                                toast: "Knowledge base not found"

Source not found       Source deleted / wrong    Full-page error: "Source not found
in fetched sources     sourceId in URL          in this knowledge base" +
                                                [← Back to KB] link

indexId is null        KB exists but has no     Full-page error: "Knowledge base
                       searchIndex (edge case)  is not configured yet" +
                                                [← Back to KB] link
```

The orchestrator renders a `<USPErrorState>` component for each case. Loading
state renders `<USPSkeleton>` (full-page skeleton matching the 4-zone layout).

### WebSocket Reconnection UX

When `useCrawlProgress` loses the WebSocket connection during an active crawl:

```
Connection lost
  │
  ├─ Attempt 1-5 (linear backoff: 5s, 10s, 15s, 20s, 25s — 75s total):
  │    StatusStrip ConnectionIndicator shows "Reconnecting..." (amber, pulsing)
  │    Stats freeze at last-known values (no fake updates)
  │    Pages tab continues SWR polling independently (unaffected)
  │
  ├─ All 5 attempts fail:
  │    ConnectionIndicator switches to "Polling" (amber, static)
  │    StatusStrip falls back to REST polling:
  │      getCrawlDashboard(jobId) at 5s interval
  │    Stats resume updating from REST data
  │    User sees no gap — just slower updates
  │
  └─ WS reconnects successfully:
       ConnectionIndicator returns to "Live 📡" (green)
       Stats resume from WS events
       REST polling stops (WS takes priority)
```

**Key design rule:** Pages tab SWR polling is INDEPENDENT of WS state. The
table never stops updating — only the StatusStrip counters are affected by WS
loss. This provides graceful degradation without user intervention.

### REST Fallback Protocol

StatusStrip maintains two data sources:

1. **Primary (WS):** `useCrawlProgress(activeJobId)` — real-time events
2. **Fallback (REST):** `getCrawlDashboard(activeJobId)` — polled at 5s

Rules:

- When WS is connected: use WS events for stat counters, ignore REST
- When WS disconnects: start REST polling automatically (no user action)
- When WS reconnects: stop REST polling, resume WS events
- Implementation: `useEffect` derives tri-state from `useCrawlProgress` return
  (`isReconnecting ? 'reconnecting' : connected ? 'connected' : 'disconnected'`)
  to toggle REST `refreshInterval`

---

## Testing Strategy

### Unit-Testable (Pure Functions — Zero Mocks)

| Function                                | Test Cases                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `deriveDisplayState(source, latestJob)` | 7 states + edge cases: no job, stale source status, job from different source, null inputs |
| `formatStatCounters(dashboard)`         | Queued→Duration swap on terminal, zero values, large numbers                               |
| `groupErrorsByType(failedPages)`        | Grouping logic, empty array, single type, mixed types, 200-page cap                        |
| `deriveActionButtons(displayState)`     | 7-state matrix matches UX spec                                                             |
| `deriveSuggestions(errorTypes)`         | 403→auth suggestion, timeout→retry, unknown→generic                                        |

### Integration-Testable (SWR + MSW)

| Scenario                     | Setup                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------- |
| SWR cascade success          | MSW: KB → source → jobs → dashboard. Verify all data renders.                     |
| SWR cascade KB-404           | MSW: KB returns 404. Verify redirect + toast.                                     |
| SWR cascade source-not-found | MSW: KB returns valid, sources list doesn't include sourceId. Verify error state. |
| Tab state from URL           | Render with `?tab=settings`. Verify Settings tab active on mount.                 |
| Tab switch updates URL       | Click History tab. Verify URL changes to `?tab=history`.                          |

### E2E-Testable (Real Navigation, Real Server)

| Scenario                          | Verify                                                      |
| --------------------------------- | ----------------------------------------------------------- |
| Click web source → USP loads      | Full page renders, breadcrumb correct, badge matches status |
| Click manual source → panel opens | SourceDetailPanel slides in (regression NR-1)               |
| Routing dispatch all 5 branches   | NR-1 through NR-6 in sequence                               |
| Browser back from USP → KB        | Navigation returns to KB Data tab                           |
| Deep link with `?tab=settings`    | Direct URL loads Settings tab                               |

### Mock Boundaries

- **Mock:** External WS server (use mock WS for `useCrawlProgress` connection tests)
- **Don't mock:** SWR, React components, design system, API client functions
- **MSW for REST:** All `getCrawlDashboard`, `getCrawledPages`, `fetchSources` calls

---

## Decisions & Tradeoffs

| #   | Decision            | Chose                                                          | Over                                | Because                                                                                                                                                |
| --- | ------------------- | -------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1 | Routing             | App Router page (like browse-preview)                          | SPA navigation store extension      | URL-addressable, established pattern, less invasive                                                                                                    |
| D-2 | Pages/History tabs  | Reuse CrawledPagesView + CrawlJobHistory                       | Rebuild from scratch                | Self-contained, props-based API, already tested                                                                                                        |
| D-3 | Status Strip        | Build new USPStatusStrip                                       | Reuse CrawlJobProgress (869 lines)  | CJP is coupled to wizard UI; USP strip is simpler layout                                                                                               |
| D-4 | Settings tab        | Read-only display                                              | Editable config                     | Editing requires OCC + wizard-level complexity; use Recrawl flow                                                                                       |
| D-5 | History filtering   | Client-side (fetch 100, filter by sourceId)                    | Server-side `?sourceId=`            | Same as SourceDetailPanel; backend change out of scope                                                                                                 |
| D-6 | Post-submission     | Navigate to USP                                                | Close to KB detail                  | User wants to see live progress immediately                                                                                                            |
| D-7 | Background toast V1 | SWR polling detection                                          | Global WebSocket listener           | Simpler, no new WS subscription; upgrade to WS in V2                                                                                                   |
| D-8 | Tab state           | `?tab=` query param via `router.push` (GovernancePage pattern) | Local state only / `router.replace` | URL-shareable, browser back/forward works across tabs. Uses `push` (not `replace`) — each tab switch creates a history entry, matching GovernancePage. |
| D-9 | AnimatedCounter     | CSS `transition: all 0.3s`                                     | Framer Motion `animate`             | Zero bundle cost vs ~30KB dep; CSS transitions sufficient for number roll                                                                              |

---

## Task Decomposition

| Task | Package(s)   | Dep | Est. Files | Description                                                                                                                                                  |
| ---- | ------------ | --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T-1  | studio       | —   | 4-5        | **Route + Page Shell**: page.tsx, orchestrator, proxy.ts, state derivation, SWR cascade, loading/error                                                       |
| T-2  | studio       | T-1 | 4-5        | **Header + Status Strip**: breadcrumb, badge, menu, progress, stats (animated), quality bar, suggestions, connection indicator, State J banner, WS lifecycle |
| T-3  | studio       | T-2 | 4-5        | **Tabs + Pages Tab**: tab wiring, CrawledPagesView + refreshInterval, ErrorGroupingPanel, auto-scroll pill, State B empty, filter badges                     |
| T-4  | studio       | T-3 | 3-4        | **History + Settings Tabs**: CrawlJobHistory + client filter + job selection, USPSettingsTab (config cards), empty states                                    |
| T-5  | studio       | T-4 | 3-4        | **Actions Bar + Dialogs**: button matrix per state, cancel dialog, Run in Background, Recrawl/Start via crawlFlowStore, Delete in Settings                   |
| T-6  | studio       | T-5 | 3-4        | **Routing + Navigation**: handleRowClick split (B5), CrawlFlowV5 post-submission nav, back button, breadcrumbs                                               |
| T-7  | studio, i18n | T-6 | 3-4        | **i18n + Polish**: all keys, background toast (SWR polling), aria-labels, polish                                                                             |

### Notes for LLD — Per-Task

**T-1:**

- Orchestrator state: `{ source, knowledgeBase, anchoredJobId, viewingJobId, displayState, activeTab }`
- **Job Anchoring:**
  - `sourceJobs = jobs.filter(j => j.sourceId === source._id)` — scoped to THIS source
  - `anchoredJobId`: set ONCE on first successful jobs fetch (`sourceJobs[0]._id`). Stored in `useRef` — survives SWR refreshes, does NOT change when new jobs appear (retry, other users).
  - `activeJobId = viewingJobId ?? anchoredJobId`
  - `displayJob = sourceJobs.find(j => j._id === activeJobId) ?? sourceJobs[0]`
  - `displayState = deriveDisplayState(source, displayJob)`
  - Anchor reset: on CrawlFlowV5 `onComplete(newJobId)` → `setAnchoredJobId(newJobId)`. Page remount resets naturally (ref starts null).
  - Anchor invalidated: if `!sourceJobs.find(j => j._id === anchoredJobId)` (job deleted) → reset to `sourceJobs[0]._id`
- SWR cascade: KB(kbId) → indexId → source(sourceId) + jobs(indexId, filter by sourceId)
- **Tab state from URL:** `useSearchParams` to read `?tab=` on mount, `router.push(?tab=X, { scroll: false })` on tab switch. Default: `pages`. Valid: `pages|history|settings`. Invalid/missing → `pages`.
- **Error states (4 cases):** `<USPErrorState>` component with variant per failure: `kb-error` (retry), `kb-not-found` (redirect), `source-not-found` (back link), `index-missing` (back link). See Error Recovery section.
- **Deleted-source guard:** If SWR refresh returns source list without current sourceId (another user deleted it), redirect to KB with toast: "Source was deleted."
- Loading: `<USPSkeleton>` — full-page skeleton matching 4-zone layout
- proxy.ts: add exclusion like browse-preview

**T-2:**

- WS lifecycle: connect only when `displayState === 'crawling'`, disconnect on terminal
- **WS reconnect UX:** ConnectionIndicator shows 3 states: "Live 📡" (green, WS active), "Reconnecting..." (amber, pulsing, attempts 1-5), "Polling" (amber, static, REST fallback after 5 failed attempts). See Error Recovery section.
- **REST fallback:** `useEffect` derives connection state from `useCrawlProgress` return values: `isReconnecting ? 'reconnecting' : connected ? 'connected' : 'disconnected'`. On disconnected → start `getCrawlDashboard` polling at 10s. On connected → stop REST polling. Note: hook returns `{ connected, isReconnecting }` as separate booleans, not a single enum.
- **Frontend `DashboardResponse` type update:** The backend returns fields not yet declared in the frontend type (`ingestion.avgQualityScore`, `ingestion.statusBreakdown`, `extraction.avgChunksPerDoc`, `queues`, `errors`). T-2 must extend `DashboardResponse` in `apps/studio/src/api/crawl.ts` to include these fields before consuming them.
- **Quality data — two sources, two use cases:**
  - **Post-crawl (terminal states C, D, H):** Primary source: `displayJob.results.qualityMetrics` on the CrawlJob object from `getCrawlHistory`. Fields: `avgQualityScore`, `avgContentPreservation`, `avgChunksPerDoc`, `successRate`. Backend-computed aggregate. Fallback for older jobs without `qualityMetrics`: omit QualityBar (show "Quality data unavailable" text).
  - **During crawl (live):** `getCrawlDashboard` returns `ingestion.avgQualityScore` (computed live from SearchDocuments). Used for live stat display in StatusStrip, NOT for QualityBar.
  - QualityBar only renders in terminal states using CrawlJob data, never dashboard data.
- **Suggestions:** Two types, both dismissible (local state):
  - **Error suggestions** (States D, E, F): Derived from failed pages' `page.error` field — group by error type, map to actionable copy (403→"check auth", timeout→"try again"). Data from `getCrawledPages(jobId, { status: 'failed' })`, same call that feeds ErrorGroupingPanel.
  - **Thin content suggestion** (State D only): "N pages have thin content — consider adjusting extraction settings" when `page.quality === 'thin'` count exceeds threshold. Data from same getCrawledPages call.
- **Idle state contextual message** (State H): "Last crawled {relative time} · {N} pages · {quality}%" using `displayJob.timeline.completedAt` for relative time, `displayJob.results` for stats.
- State J: when `viewingJobId !== null` → "📋 Viewing crawl from {date}" + "Back to latest →"
- Real-time transitions: WS `job_completed` → `mutate(sourceKey)` → displayState recalculates
- AnimatedCounter: CSS `transition: all 0.3s` (D-9 — zero bundle cost vs Framer Motion ~30KB)

**T-3:**

- CrawledPagesView: add `refreshInterval` prop, pass `5000` during crawl (rate limit safe — see P-5)
- ErrorGroupingPanel: fetch failed pages (limit 200), group by `page.error`
  - **Retry All = fire-and-forget:** `submitBatchCrawl(groupUrls)` → toast → button loading → no state change (anchoring prevents hijack). Results in History. See P-2.
  - Per-row ↻ retry: same fire-and-forget pattern (already in CrawledPagesView, no change)
- State B empty: `displayState === 'crawling' && pages.length === 0` → pulsing + invitation text
- Auto-scroll: `useRef` on table container, scroll listener, floating pill on user-scroll-up
- Filter badges: Active badge only during crawl, Thin badge only when thin > 0

**T-4:**

- CrawlJobHistory: pass `externalJobs={sourceJobs}` prop (pre-filtered by orchestrator) — avoids duplicate SWR fetch inside component. Wire callbacks with correct signatures:
  - `onSelectJob: (jobId: string) => void` — sets `viewingJobId` in orchestrator
  - `onRecrawl: (urls: string[], strategy?: string) => void` — opens CrawlFlowV5 (note: receives URLs array, not jobId)
  - `onDeleteJob: () => void` — triggers SWR revalidation (no args — parent handles refresh)
- Job selection: `onSelectJob(jobId)` → orchestrator `setViewingJobId(jobId)` → Pages shows that job, Strip shows banner
- History help text: "Click a row to view that crawl's pages and stats." below table (per UX spec)
- History empty state: clipboard icon + "No crawl history. Crawl jobs will appear here after your first crawl."
- Settings: read-only cards from `source.crawlConfig` — strategy, scope, rendering, auth type, sections, profile, avgResponseTime
- Settings empty: "No crawl configuration yet" + Start Crawl CTA

**T-5:**

- Actions matrix: 7 states × different button combos (see UX spec table)
- **Historical mode override:** When `viewingJobId !== null` → Actions Bar shows [Recrawl] only. No [View Documents in KB] (documents may be superseded by later crawls). Per UX spec State J.
- Run in Background: `navigate('/projects/:id/search-ai/:kbId')` — just navigation
- Cancel: `ConfirmDialog` with detailed copy: "{N} pages have been crawled so far. These will be preserved. The remaining ~{M} pages will not be crawled." Buttons: [Keep Crawling] (secondary) | [Cancel Crawl] (danger). → `cancelCrawlJob(jobId)`
- Recrawl/Start: `useCrawlFlowStore.open(sourceId)` → CrawlFlowV5 with `restoreFromSource`
- Delete: in Settings tab DangerZone, `deleteSource()` → navigate to KB detail. Uses type-to-confirm pattern (user must type source domain to enable Delete button) for destructive safety.
- **No Run in Background / Cancel for retry jobs:** Retry All is fire-and-forget — page stays in terminal state, no crawling UX appears. See P-2.

**T-6:**

- handleRowClick: split else into `web → navigate(USP)` + `non-web → SourceDetailPanel`
- CrawlFlowV5: `handleCrawlComplete` adds `navigate(USP)` after `closeCrawlFlow()`. Preserve existing `refreshSources()` + `refresh()` calls — they ensure the KB source list is fresh if user navigates back via breadcrumb.
- Back: "← My KB" → `/projects/:id/search-ai/:kbId`
- Breadcrumbs: `[My KB → epson.com]`
- **SourceDetailPanel NOT deleted** — ADD→REPLACE→DELETE rule
- Verify NR-1 through NR-12

**T-7:**

- i18n: `search_ai.source_page.*` namespace, all strings → `t('key')`
- Toast V1: SWR polling detection — compare previous source status, fire toast on transition. Duration rules: short crawl (<1 min) → auto-dismiss 10s; long crawl (1+ min) → persistent until dismissed. Failed toast always persistent. Toast copy includes page count + failed count + quality % (per UX spec toast wireframes).
- aria-labels: all interactive elements

### Shared Files Risk — Zero Overlap

| External File                 | Task                                |
| ----------------------------- | ----------------------------------- |
| `proxy.ts`                    | T-1 only                            |
| `SourcesTable.tsx`            | T-6 only                            |
| `KnowledgeBaseDetailPage.tsx` | T-6 only                            |
| `CrawlFlowV5.tsx`             | T-6 only                            |
| `CrawledPagesView.tsx`        | T-3 only (add refreshInterval prop) |
| `studio.json` (i18n)          | T-7 only                            |

---

## Non-Web Source Regression Prevention

### SourceDetailPanel — Preserved, Not Deleted

`SourceDetailPanel` (919 lines) is **NOT deleted**. It continues to serve manual/file, database, and API sources. Web-source rendering branches become unreachable dead code — cleanup is a separate future refactor.

### Panels Completely Untouched

| Panel                         | Dispatch Branch             | USP Impact |
| ----------------------------- | --------------------------- | ---------- |
| `SharePointDetailPanel`       | B2: connectorStore          | Zero       |
| `ConnectorDetailPanel`        | B3: connectorId + !manual   | Zero       |
| `SourceDetailPanel` (non-web) | B4: else clause (preserved) | Zero       |
| `CrawlFlowV5` (configuring)   | B1: checked FIRST           | Zero       |

### Regression User Journeys

#### RJ-1: Manual Source Upload

```
User clicks manual source → handleRowClick: isManual=true → B4 → SourceDetailPanel
  → ManualSourceOverview: KPI cards, file breakdown, upload zone
  → [Upload Files] → panel closes → upload dialog
RISK: If B5 check omits sourceType==='web' guard, manual sources go to USP.
GUARD: Explicit `row.sourceType === 'web'` in B5.
```

#### RJ-2: Database Source Error → Retry

```
User clicks database source (error) → handleRowClick: not web → B4 → SourceDetailPanel
  → Error section: sync error message, [Retry Sync]
RISK: Database sources without connectorId fall to else branch (same as web).
GUARD: B5 must check sourceType before catching. See critical split code above.
```

#### RJ-3: SharePoint Re-Auth

```
User clicks SharePoint source → handleRowClick: sharepoint + connectorId → B2
  → SharePointDetailPanel (completely independent store + component)
RISK: Zero. B2 is checked before B5.
```

#### RJ-4: Configuring Web → Wizard → Complete → USP

```
User clicks configuring web source → B1 → CrawlFlowV5 wizard
  → User completes wizard, clicks "Crawl N Pages"
  → onComplete(jobId, sourceId, url) → closeCrawlFlow() + navigate(USP)
  → USP loads with State B (crawl just started)
CHANGE: Post-completion navigates to USP instead of KB detail. Intentional (D-6).
```

#### RJ-5: Rapid Source Type Switching (State Leak)

```
Click web(active) → USP (full page nav) → ← My KB → back to KB
Click manual → SourceDetailPanel (slide) → close
Click SharePoint → SharePointDetailPanel (store) → close
Click web(configuring) → CrawlFlowV5 (full page) → cancel → KB
Click web(active) → USP again
STATE: Each click path uses different state stores. Full-page nav unmounts SourcesTable
  → clean remount. No leaks. ✅
```

#### RJ-6: Delete from USP vs Other Panels

```
USP delete: Settings tab → [Delete Source] → confirm → deleteSource() → navigate(KB)
Panel delete: SourceDetailPanel → Danger Zone → confirm → deleteSource() → close panel
RISK: USP must navigate away after delete (source gone). Handle SWR returning null.
```

### Verification Matrix

| #     | Source Type          | Click Target                | Verify                            |
| ----- | -------------------- | --------------------------- | --------------------------------- |
| NR-1  | Manual/File          | SourceDetailPanel (slide)   | Panel opens, KPIs visible         |
| NR-2  | Database             | SourceDetailPanel (slide)   | Config + sync status visible      |
| NR-3  | API                  | SourceDetailPanel (slide)   | Endpoint config visible           |
| NR-4  | SharePoint           | SharePointDetailPanel       | SP tabs (Overview, Connect, etc.) |
| NR-5  | Enterprise connector | ConnectorDetailPanel        | Sync controls visible             |
| NR-6  | Web (configuring)    | CrawlFlowV5 wizard          | Wizard resumes at saved step      |
| NR-7  | Web (active)         | **USP (full page)**         | ★ NEW behavior                    |
| NR-8  | Manual (0 docs)      | SourceDetailPanel           | Upload zone, NOT "Start Crawl"    |
| NR-9  | Mixed types in KB    | Each dispatches correctly   | Click all types sequentially      |
| NR-10 | Bulk delete mixed    | All types delete correctly  | Multi-select → delete → clean     |
| NR-11 | Create new source    | Correct initial destination | Web→wizard, manual→panel          |
| NR-12 | Status badges        | All variants render         | All colors/icons correct          |

---

## Scenario Coverage Matrix

### UX Spec States → Tasks

| State               | Tasks                                               | Key Components                                    |
| ------------------- | --------------------------------------------------- | ------------------------------------------------- |
| A: Active Crawl     | T-2 (strip+WS), T-3 (live table+errors)             | StatusStrip, CrawledPagesView, ErrorGroupingPanel |
| B: Just Started     | T-2 (strip), T-3 (pulsing empty)                    | Strip + empty-during-crawl state                  |
| B→A: First page     | T-2 (WS events), T-3 (table render)                 | WS → SWR mutate → table re-render                 |
| C: Completed        | T-2 (green strip), T-3 (final table), T-5 (actions) | Quality bar, Recrawl button                       |
| D: Issues           | T-2 (amber strip+suggestions), T-3 (error grouping) | QualityBar, ErrorGroupingPanel                    |
| E: Failed (partial) | T-2 (red strip+suggestion), T-5 (Retry)             | Partial pages viewable                            |
| F: Failed (zero)    | T-2 (strip), T-3 (error empty), T-5 (Retry only)    | Error empty state                                 |
| G: Cancelled        | T-2 (neutral strip), T-5 (Recrawl)                  | Gray status, pages preserved                      |
| H: Idle             | T-2 (info strip), T-3 (static pages), T-5 (actions) | No WS needed                                      |
| I: Pending          | T-2 (invitation), T-3 (empty+CTA), T-5 (Start)      | Empty stats + CTA                                 |
| J: Historical       | T-4 (job select), T-2 (banner)                      | "Viewing crawl from..."                           |

### UX Spec Journeys → Tasks

| Journey                 | Tasks         | Critical Path                           |
| ----------------------- | ------------- | --------------------------------------- |
| J1: Fresh Crawl         | T-6, T-2, T-3 | CrawlFlowV5→USP + real-time transitions |
| J2: Background + Return | T-5, T-7, T-2 | Navigate back + toast + backscroll      |
| J3: Issues Investigate  | T-3           | Filter + ErrorGroupingPanel + Retry All |
| J4: Crawl Fails         | T-2, T-5      | Suggestion + Retry action               |
| J5: Cancel Mid-Crawl    | T-5, T-2      | ConfirmDialog + state transition        |
| J6: View Idle Source    | T-1, T-2-T-5  | Static data display                     |
| J7: View Pending        | T-1, T-3, T-5 | Empty CTA + Start Crawl                 |
| J8: Historical Job      | T-4, T-2, T-3 | viewingJobId flow                       |
| J9: Recrawl             | T-5           | CrawlFlowV5 + restoreFromSource         |
| J10: Multiple Sources   | T-6, T-7      | Per-source routing + toast              |

---

## Scaling & Enterprise SaaS Readiness

### Data Volume — API Bottlenecks

| Endpoint                       | Max Limit         | Query Pattern                                                | Index Support                                    | Risk                                     |
| ------------------------------ | ----------------- | ------------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------- |
| `GET /crawl/pages/:jobId`      | 200/page          | `{ tenantId, 'sourceMetadata.crawlJobId': jobId }`           | **MISSING INDEX** on `sourceMetadata.crawlJobId` | **HIGH** — collection scan at 10K+ pages |
| `GET /crawl/dashboard/:jobId`  | N/A (aggregation) | `$or` on `sourceMetadata.crawlJobId` + `metadata.crawlJobId` | **MISSING INDEX** — two unindexed nested fields  | **HIGH** — aggregation timeout at scale  |
| `GET /crawl/history`           | 100/page          | `{ tenantId, indexId }` cursor on `_id`                      | Compound index `{ tenantId, indexId, _id: -1 }`  | LOW — well-indexed                       |
| `GET /sources/:sourceId/stats` | N/A               | `{ indexId, tenantId, sourceId }`                            | Index `{ indexId, sourceId }`                    | LOW — well-indexed                       |

**USP Impact:** The pages API (`/crawl/pages/:jobId`) is the most-called endpoint during active crawl (every 3 seconds for live table refresh). With the missing index, a 10K-page crawl would cause slow queries on every poll.

**Mitigation (pre-requisite for USP):** Add MongoDB index:

```javascript
// packages/database/src/models/search-document.model.ts
{ 'sourceMetadata.crawlJobId': 1, tenantId: 1 }  // compound index for pages queries
```

This is a **backend infrastructure fix** — not a USP feature change, but USP makes it critical because USP polls this endpoint every 5 seconds during crawl.

### Persistence in Clustered Environment

```
                    Pod A (worker)              Pod B (API/WS)           Pod C (API/WS)
                    ┌──────────────┐            ┌──────────────┐        ┌──────────────┐
                    │ bulk-crawl   │            │ WS client 1  │        │ WS client 2  │
                    │ worker       │            │ WS client 3  │        │              │
                    │              │            │              │        │              │
                    │ publishes    │            │ subscribes   │        │ subscribes   │
                    └──────┬───────┘            └──────┬───────┘        └──────┬───────┘
                           │                          │                       │
                    ═══════╪══════════════════════════╪═══════════════════════╪═══════
                           │        Redis Pub/Sub     │                       │
                           │     progress:{jobId}     │                       │
                           ▼                          ▼                       ▼
                    ┌──────────────────────────────────────────────────────────────┐
                    │                         Redis                                │
                    │  progress:last:{jobId} ← cached last event (1hr TTL)        │
                    │  crawl:checkpoint:{tenantId}:{jobId}:{urlHash} (3hr TTL)    │
                    │  crawl:cancel:{jobId} ← cancel signal (1hr TTL)             │
                    └─────────────────────────────┬────────────────────────────────┘
                                                  │
                    ┌─────────────────────────────▼────────────────────────────────┐
                    │                        MongoDB                               │
                    │  CrawlJob ← authoritative state (updated every 15s)         │
                    │  SearchDocument ← per-page results (persisted on process)    │
                    │  SearchSource ← source status (updated on job events)        │
                    └──────────────────────────────────────────────────────────────┘
```

**What's safe (distributed, persisted):**

- ✅ Crawl progress events — Redis pub/sub broadcasts to ALL pods
- ✅ Late-joiner replay — `progress:last:{jobId}` in Redis (1hr TTL), works cross-pod
- ✅ Job state — MongoDB authoritative, updated every 15s by worker
- ✅ Per-URL checkpoints — Redis `crawl:checkpoint:*` (3hr TTL) + MongoDB fallback
- ✅ Worker crash recovery — BullMQ retries job, new worker checks checkpoints
- ✅ Cancel signal — Redis key, survives pod restart

**What's pod-local (acceptable):**

- ⚠️ `activeSubscriptions` Map (500 cap per pod) — tracks WS connections, bounded
- ⚠️ Each WS client creates dedicated Redis subscriber — N viewers = N connections

**Pod failure scenario for USP user:**

```
1. User viewing USP with active crawl → WS connected to Pod B
2. Pod B dies
3. Frontend: useCrawlProgress detects disconnect → auto-reconnect (5 attempts, backoff)
4. Load balancer routes reconnect to Pod C
5. Pod C creates new Redis subscriber for progress:{jobId}
6. Pod C reads progress:last:{jobId} from Redis → replays to client
7. User sees brief "Reconnecting..." then resumes live progress
```

**Conclusion:** The architecture is sound for clustered deployment. Redis pub/sub + MongoDB checkpoints ensure no data loss. The only gap is the transient "reconnecting" UX which `useCrawlProgress` already handles with auto-reconnect.

### Enterprise SaaS — Isolation Gaps Found

| #                                | Endpoint | Tenant Isolated | Project Isolated                                                     | Risk |
| -------------------------------- | -------- | --------------- | -------------------------------------------------------------------- | ---- |
| `GET /crawl/pages/:jobId`        | ✅ Yes   | ❌ **No**       | User could see pages from another project's crawl if they know jobId |
| `GET /crawl/history`             | ✅ Yes   | ❌ **No**       | History shows all jobs in the index regardless of project scope      |
| `GET /crawl/dashboard/:jobId`    | ✅ Yes   | ❌ **No**       | Dashboard accessible for any job in the tenant                       |
| `WS progress/subscribe`          | ✅ Yes   | ❌ **No**       | Progress events for any job in the tenant                            |
| `GET /sources/:sourceId/stats`   | ✅ Yes   | ✅ Yes          | Source access goes through index ownership                           |
| `POST /crawl/batch`              | ✅ Yes   | ✅ Yes          | Creates job scoped to index                                          |
| `POST /crawl/jobs/:jobId/cancel` | ✅ Yes   | ❌ **No**       | Any tenant user can cancel any job                                   |

**Root cause:** `CrawlJob` model has no `projectId` field. Crawl routes verify `tenantId` but don't enforce `projectScope` from the auth token. The `/api/indexes` sources routes DO enforce project scope (via `applyProjectScopeFilter` on SearchIndex lookup), but `/api/crawl` routes bypass this.

**Impact on USP:** LOW for V1. Project isolation matters in multi-project tenants. Since USP accesses crawl endpoints through the context of a specific source (which IS project-scoped), the attack surface requires knowing a `jobId` from another project — which is a UUIDv7, not guessable.

**Recommendation:** Log as a separate security hardening ticket. Not a USP blocker, but should be addressed before multi-project tenants go to production. Fix: add `projectId` to CrawlJob model, populate on job creation, enforce on crawl routes via `applyProjectScopeFilter`.

### Rate Limiting

- Global rate limit: 120 requests/minute/tenant across all `/api/` endpoints
- USP polling during crawl: pages API every 5s + dashboard every 10s = ~18 requests/min from one user
- With 5 concurrent viewers: ~160 requests/min — **exceeds the 120/min tenant budget**

**Mitigation options:**

1. **Increase crawl dashboard refresh to 10s** — reduces to ~18 req/min per user
2. **Add per-operation rate limiting** — separate budget for read-only polling vs mutations
3. **SWR deduplication** — if multiple tabs, SWR deduplicates in-browser but each user is independent

**Recommendation for USP:** Use conservative polling intervals:

- Pages: 5s during crawl (not 3s) → 12 req/min
- Dashboard: 10s during crawl → 6 req/min
- Total per user: ~18 req/min → 6 concurrent viewers stay under 120/min budget

## API Design

Skipped — pure frontend feature. No new or modified backend endpoints. All existing
endpoints verified against actual backend code (see Scaling section for endpoint audit).

## Open Questions

1. **SWR performance at 10K+ pages with 5s polling.** CrawledPagesView fetches paginated
   results (200/page). With 10K pages, the response payload is manageable, but SWR
   re-renders on every refetch. If jank is observed during live crawl, consider
   `keepPreviousData: true` (already set) + `compare` option to skip no-change re-renders.

2. **Quality data availability on older CrawlJobs.** `results.qualityMetrics` was added
   recently. Jobs created before this field exists will have `null`. QualityBar should
   gracefully handle this (show "Quality data unavailable" instead of broken bar). How
   far back do we need to support?

3. **Tab history depth.** D-8 uses `router.push` for tab changes (matching GovernancePage).
   A user clicking Pages → History → Settings → Pages creates 4 history entries. Is this
   acceptable, or should we switch to `router.replace` after first interaction? GovernancePage
   hasn't received complaints, so keeping `push` for now.

## Pre-requisites (Before USP Ships)

| Item                                                                                  | Why                                                                                 | Effort                          |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------- |
| Add MongoDB index `{ 'sourceMetadata.crawlJobId': 1, tenantId: 1 }` on SearchDocument | Pages API does collection scan at 10K+ docs; USP polls every 5s during crawl        | 1 line — model index definition |
| Log security ticket for CrawlJob project isolation                                    | Crawl routes lack `applyProjectScopeFilter` — not a USP blocker but must be tracked | Ticket only                     |

## Out of Scope

- Non-web source full-page treatment (future)
- Server-side history filtering by sourceId (future)
- Editable settings tab (use Recrawl flow)
- Section fill rate visualization during crawl
- Intelligence crawl per-page decisions display
- Quick recrawl "same settings" action (always CrawlFlowV5)
- SourceDetailPanel dead code cleanup (separate refactor)
