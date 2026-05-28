# Unified Source Page — UX Specification (Rev 4)

## What

Replace three separate, redundant views (State4Crawl, SourceDetailPanel, CrawlJobProgress) with a single full-page experience for web sources. One page handles all states: configuring, crawling, completed, completed with issues, failed, cancelled, and idle.

**Key innovations** (from competitive research — Firecrawl, Vercel, Algolia, LogRocket, GitHub Actions):

- **Live Results Table**: Pages appear in the table AS they're crawled — the table IS the progress (Firecrawl pattern)
- **Merged Status Strip**: Single header area combines progress, stats, and quality — zero duplication
- **"Completed with Issues"**: Third terminal state beyond success/fail (AppMaster/Buildkite)
- **Error Grouping**: Failures grouped by type with actionable copy and per-group retry (LogRocket)
- **Contextual Microcopy**: "Crawling product pages (142 of ~300)" not "Processing..." (Algolia)
- **Toast on Background Completion**: Notification with [View Results] when user is elsewhere

**What changes from current UI**:

- `SourceDetailPanel` (slide panel) → Unified Source Page (full page, URL-addressable)
- `CrawlJobProgress` (separate component) → merged into live results table + status strip
- `State4Crawl` (crawl flow step) → USP takes over after crawl submission
- Progress tab in `SourceDetailPanel` → eliminated (Pages tab IS the progress)
- Phase cards (Crawled/Processed/Failed) → Status Strip stat counters

**Scoping note**: Crawler is HTML-only — it discovers PDF/DOC links via `link-extractor.ts` but never fetches them. Document download from crawled sites is a future feature. Non-web sources (file, database, API, SharePoint) keep current SourceDetailPanel for now.

---

## Current Code Context

### Source Statuses (Backend)

From `packages/search-ai-sdk/src/constants.ts`:

```typescript
SourceStatus = {
  CONFIGURING: 'configuring', // wizard in progress (web sources start here)
  PENDING: 'pending', // created but never crawled (non-web start here)
  SYNCING: 'syncing', // connector sync active
  ACTIVE: 'active', // has data, healthy
  ERROR: 'error', // last sync/crawl failed
  DISABLED: 'disabled', // manually disabled
};
```

Frontend status variant maps also handle: `draft` (legacy), `crawling`, `partial`, `auth_failed`, `awaiting_auth`.

### CrawlJob Statuses

From `packages/database/src/models/crawl-job.model.ts`:

```
'queued' | 'crawling' | 'ingesting' | 'indexing' | 'completed' | 'failed' | 'cancelled'
```

### crawlConfig (inline on SearchSource)

From `packages/database/src/models/search-source.model.ts` — `ICrawlConfig`:

| Field             | Type                                                             | Purpose                                                                  |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `wizardStep`      | `'profiling' \| 'sections_ready' \| 'configured' \| 'submitted'` | Wizard progress                                                          |
| `strategy`        | `'guided-discovery' \| 'crawl-sitemap' \| 'direct-urls'`         | Discovery strategy                                                       |
| `profile`         | `ICrawlConfigProfile`                                            | Domain info: siteType, hasSitemap, jsRequired, platform                  |
| `sections`        | `ICrawlConfigSection[]`                                          | Per-section: pattern, name, source, pageCount, included                  |
| `settings`        | `ICrawlConfigSettings`                                           | scope, rendering, maxPages, maxDepth, requestDelay, cleanup              |
| `auth`            | `ICrawlConfigAuth`                                               | method, basicUsername/Password, bearerToken, cookieString, customHeaders |
| `groupStrategies` | `ICrawlConfigGroupStrategy[]`                                    | Per-pattern rendering method + reason                                    |
| `configVersion`   | `number`                                                         | OCC counter for concurrent edit safety                                   |
| `crawlJobId`      | `string`                                                         | Active crawl job reference                                               |
| `configExpiresAt` | `Date`                                                           | TTL for abandoned wizard cleanup (30 days)                               |

### Current Navigation

- Source list: `SourcesTable` or `SourcesCardGrid` in `DataSection`
- Source detail: `SourceDetailPanel` (slide panel, NOT a page route)
- Configuring/draft web sources → `onResumeSource(sourceId)` opens `CrawlFlowV5`
- No URL-addressable source detail page exists today

### Backend Endpoints (Source Management)

From `apps/search-ai/src/routes/sources.ts`, mounted at `/api/indexes`:

| Method | Path                                                   | Purpose                                      |
| ------ | ------------------------------------------------------ | -------------------------------------------- |
| GET    | `/:indexId/sources`                                    | List sources (paginated, filterable)         |
| POST   | `/:indexId/sources`                                    | Create source                                |
| DELETE | `/:indexId/sources/:sourceId`                          | Delete (cascades config state + URL buckets) |
| PATCH  | `/:indexId/sources/:sourceId/crawl-config`             | Update crawl config (OCC)                    |
| GET    | `/:indexId/sources/:sourceId/discovery-state`          | Read discovery wizard state                  |
| PUT    | `/:indexId/sources/:sourceId/discovery-state`          | Save discovery wizard state                  |
| GET    | `/:indexId/sources/:sourceId/sections/:sectionId/urls` | Read section URLs (paginated)                |
| PUT    | `/:indexId/sources/:sourceId/sections/:sectionId/urls` | Store section URLs (bucket pattern)          |
| GET    | `/:indexId/sources/:sourceId/stats`                    | Aggregated analytics                         |

### Progress Infrastructure

- **WebSocket** (`apps/search-ai/src/routes/progress.ts`): Redis pub/sub, distributed, multi-pod safe. Used for crawl job progress. Late-joiner replay via `progress:last:<jobId>`.
- **SSE** (`apps/search-ai/src/routes/discovery.ts`): In-process, single-pod. Used for discovery engine.
- Frontend hooks: `useCrawlProgress` (standard crawls), `useMultiPageProgress` (intelligence crawls).
- Polling fallback: `getCrawlDashboard(jobId)` returns per-phase progress.

---

## Page Anatomy

Every scenario renders the same 4-zone layout. Only the CONTENT of each zone changes per state.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ZONE 1: HEADER                                                        │
│  Breadcrumb + Status Badge + Primary Action                            │
├─────────────────────────────────────────────────────────────────────────┤
│  ZONE 2: STATUS STRIP                                                  │
│  Contextual message + Progress bar + Stats counters + Quality bar      │
├─────────────────────────────────────────────────────────────────────────┤
│  ZONE 3: TABS + TAB CONTENT                                            │
│  [Pages]  [History]  [Settings]                                        │
│  ─────────────────────────────────────                                 │
│  (Tab content area — scrollable)                                       │
├─────────────────────────────────────────────────────────────────────────┤
│  ZONE 4: ACTIONS BAR                                                   │
│  Left action(s) + Right action(s)                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

**3 tabs always visible.** Empty states when no data — no tab surprises.

### Header Status States

These are **display states** derived from source status + latest crawl job:

| State                 | Icon | Color | Label                 | Dot Animation | Actions Menu (⋮)       |
| --------------------- | ---- | ----- | --------------------- | ------------- | ---------------------- |
| Configuring           | ⚙    | Gray  | Configuring           | None          | Delete Source          |
| Pending               | ○    | Gray  | Pending               | None          | Delete Source          |
| Crawling              | ●    | Blue  | Crawling              | Pulsing       | —                      |
| Completed             | ✓    | Green | Active                | None          | Recrawl, Delete Source |
| Completed with issues | ⚠    | Amber | Completed with issues | None          | Recrawl, Delete Source |
| Failed                | ✗    | Red   | Failed                | None          | Recrawl, Delete Source |
| Cancelled             | ⊘    | Gray  | Cancelled             | None          | Recrawl, Delete Source |

**Status derivation logic:**

- `source.status === 'configuring'` → Configuring (wizard in progress)
- `source.status === 'pending'` → Pending (never crawled)
- Active CrawlJob with status `queued | crawling | ingesting | indexing` → Crawling
- CrawlJob `completed` + `failedPages === 0` → Completed (Active)
- CrawlJob `completed` + `failedPages > 0` OR thin content above threshold → Completed with Issues
- CrawlJob `failed` → Failed
- CrawlJob `cancelled` → Cancelled
- `source.status === 'active'` + no active job → idle (shows as Active)

**"Completed with issues"** triggers when: crawl finishes but `failedPages > 0` OR `thinContentPages > threshold`. It's NOT a failure — the crawl ran to completion, but some pages need attention.

### Tab Auto-Selection

| Situation                 | Auto-selected tab                           |
| ------------------------- | ------------------------------------------- |
| Crawl in progress         | Pages (live results table)                  |
| Crawl just completed      | Pages (final results)                       |
| Source idle with data     | Pages                                       |
| Source idle, no data      | Pages (shows empty state + Start Crawl CTA) |
| Source configuring        | Settings (shows wizard resume CTA)          |
| User selected History job | Pages (for that job)                        |

### Actions Bar Matrix

| Source State              | Left                                         | Right                                          |
| ------------------------- | -------------------------------------------- | ---------------------------------------------- |
| **Configuring**           | —                                            | Resume Setup (primary)                         |
| **Crawling**              | Cancel Crawl (danger outline, ConfirmDialog) | Run in Background (primary)                    |
| **Completed**             | Recrawl (secondary)                          | View Documents in KB (primary)                 |
| **Completed with issues** | Recrawl (secondary)                          | View Documents in KB (primary)                 |
| **Failed**                | Retry Crawl (primary)                        | View Partial Results (secondary, if pages > 0) |
| **Cancelled**             | Recrawl (secondary)                          | View Documents in KB (primary, if pages > 0)   |
| **Idle (has data)**       | Recrawl (secondary)                          | View Documents in KB (primary)                 |
| **No data**               | —                                            | Start Crawl (primary)                          |

### Per-Page Row Columns (Pages Tab)

| Column      | Description                                                 |
| ----------- | ----------------------------------------------------------- |
| Status icon | ○ queued, ● crawling (pulsing), ✓ success, ✗ failed         |
| URL         | Relative path, clickable (opens page preview)               |
| Method      | HTTP / PW (Playwright) / — (not started)                    |
| Quality     | rich / std / thin / error / queued                          |
| Chunks      | Number of chunks extracted (e.g., "8ch")                    |
| Actions     | 👁 View (opens chunk explorer), ↻ Retry (failed), 🗑 Delete |

---

## Complete Page: State A — Active Crawl (Mid-Progress)

**When**: Crawl job is running. 134 of ~200 pages crawled. 3 failures so far.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← My KB  /  epson.com                    ● Crawling  [Run in Background]│
├─────────────────────────────────────────────────────────────────────────┤
│  ● Crawling product pages (134 of ~200)                      Live 📡   │
│  ████████████████████░░░░░░░░░  67%  · ETA ~3 min                      │
│                                                                         │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────┐              │
│  │ 134      │ 131      │ 3        │ 12       │ 2m 14s   │              │
│  │ Pages    │ Documents│ Failed   │ Queued   │ Elapsed  │              │
│  │ Crawled  │ Created  │          │          │          │              │
│  └──────────┴──────────┴──────────┴──────────┴──────────┘              │
├─────────────────────────────────────────────────────────────────────────┤
│  [● Pages]     [History]     [Settings]                                │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│  🔍 Search pages...       [All 134] [✓ Success 131] [● Active 5] [✗ Failed 3]│
│                                                            [Export CSV] │
│  ┌─────┬──────────────────────────────────┬──────┬────────┬─────┬─────┐│
│  │  ✗  │ /admin/dashboard                 │  —   │  403   │     │  ↻  ││
│  │  ✗  │ /support/printers/very-long-page │  —   │timeout │     │  ↻  ││
│  │  ✗  │ /downloads/large-catalog         │  —   │timeout │     │  ↻  ││
│  ├─────┼──────────────────────────────────┼──────┼────────┼─────┼─────┤│
│  │  ●  │ /support/printers/workforce      │  PW  │  ···   │     │     ││ ← pulsing
│  │  ●  │ /products/scanners              │ HTTP │  ···   │     │     ││ ← pulsing
│  ├─────┼──────────────────────────────────┼──────┼────────┼─────┼─────┤│
│  │  ✓  │ /products/inkjet-printers       │ HTTP │  rich  │ 8ch │  👁 ││
│  │  ✓  │ /support/faq                    │ HTTP │  std   │ 4ch │  👁 ││
│  │  ✓  │ /downloads/drivers              │  PW  │  rich  │15ch │  👁 ││
│  │  ✓  │ /products/workforce-printers    │ HTTP │  rich  │11ch │  👁 ││
│  │  ✓  │ /support/warranty               │ HTTP │  std   │ 3ch │  👁 ││
│  │ ... │                                 │      │        │     │     ││
│  ├─────┼──────────────────────────────────┼──────┼────────┼─────┼─────┤│
│  │  ○  │ /products/laser-printers        │  —   │ queued │     │     ││
│  │  ○  │ /products/large-format          │  —   │ queued │     │     ││
│  │  ○  │ /support/contact                │  —   │ queued │     │     ││
│  └─────┴──────────────────────────────────┴──────┴────────┴─────┴─────┘│
│  134 crawled · 12 queued · 3 failed                                     │
│                                                                         │
│  ▸ Errors (3)                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  Timeout (2 pages)                                     [Retry All] ││
│  │    /support/printers/very-long-page                                ││
│  │    /downloads/large-catalog                                        ││
│  │  403 Forbidden (1 page)                                            ││
│  │    /admin/dashboard                                                ││
│  │    💡 Check if authentication is required for this section         ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [Cancel Crawl]                                    [Run in Background]  │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key behaviors:**

- New rows appear at TOP as pages are discovered/crawled
- Rows transition: `○ queued` → `● crawling` (pulsing) → `✓ success` / `✗ failed`
- **Failed rows pinned to top** within their status group (Buildkite pattern)
- Table auto-scrolls unless user scrolled up → floating pill: "↓ 12 new pages"
- **Backscroll on join**: When navigating to running crawl, ALL pages loaded from Redis `progress:last:<jobId>` cache immediately (GitHub Actions)
- Contextual microcopy: "Crawling product pages (134 of ~200)" — section name from most active crawl section
- Tilde-estimated-total: honest about unpredictable sizes
- Connection indicator: "Live" (green, WebSocket via `useCrawlProgress`) or "Polling" (amber, REST fallback via `getCrawlDashboard`)
- All stat counters animate on update (number rolls up, Vercel-style)
- Error grouping: collapsed by default, groups by error type, actionable copy per type, [Retry All] per group

---

## Complete Page: State B — Crawl Just Started (0 Pages)

**When**: User just clicked "Start Crawl". CrawlJob created via `submitBatchCrawl()`, no pages yet.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← My KB  /  epson.com                    ● Crawling  [Run in Background]│
├─────────────────────────────────────────────────────────────────────────┤
│  ● Crawling pages (0 of ~200)                                Live 📡   │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  0%  · ETA calculating...              │
│                                                                         │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────┐              │
│  │ 0        │ 0        │ 0        │ 0        │ 0s       │              │
│  │ Pages    │ Documents│ Failed   │ Queued   │ Elapsed  │              │
│  │ Crawled  │ Created  │          │          │          │              │
│  └──────────┴──────────┴──────────┴──────────┴──────────┘              │
├─────────────────────────────────────────────────────────────────────────┤
│  [● Pages]     [History]     [Settings]                                │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│  🔍 Search pages...                         [All 0]                     │
│                                                                         │
│                                                                         │
│                      ● (pulsing animation)                              │
│                                                                         │
│               Pages will appear here as they're crawled...              │
│               First results typically arrive within seconds.            │
│                                                                         │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [Cancel Crawl]                                    [Run in Background]  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Page: State C — Crawl Completed Successfully

**When**: All pages crawled, 0 failures, good quality. Source status transitions to `active`.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← My KB  /  epson.com                          ✓ Active      [⋮]      │
├─────────────────────────────────────────────────────────────────────────┤
│  ✓ Crawl completed · 4 minutes ago                                     │
│  ████████████████████████████████████  100%                             │
│                                                                         │
│  ┌──────────┬──────────┬──────────┬──────────┐                         │
│  │ 187      │ 184      │ 0        │ 4m 12s   │                         │
│  │ Pages    │ Documents│ Failed   │ Duration │                         │
│  │ Crawled  │ Created  │          │          │                         │
│  └──────────┴──────────┴──────────┴──────────┘                         │
│                                                                         │
│  Quality: ████████████████████  100% good                              │
├─────────────────────────────────────────────────────────────────────────┤
│  [● Pages]     [History]     [Settings]                                │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│  🔍 Search pages...       [All 187] [✓ Success 187]      [Export CSV]  │
│                                                                         │
│  ┌─────┬──────────────────────────────────┬──────┬────────┬─────┬─────┐│
│  │  ✓  │ /products/inkjet-printers       │ HTTP │  rich  │ 8ch │  👁 ││
│  │  ✓  │ /products/workforce-printers    │ HTTP │  rich  │11ch │  👁 ││
│  │  ✓  │ /products/scanners             │ HTTP │  rich  │ 9ch │  👁 ││
│  │  ✓  │ /support/faq                   │ HTTP │  std   │ 4ch │  👁 ││
│  │  ✓  │ /support/printers/workforce    │  PW  │  rich  │12ch │  👁 ││
│  │  ✓  │ /downloads/drivers             │  PW  │  rich  │15ch │  👁 ││
│  │  ✓  │ /support/warranty              │ HTTP │  std   │ 3ch │  👁 ││
│  │ ... │                                │      │        │     │     ││
│  └─────┴──────────────────────────────────┴──────┴────────┴─────┴─────┘│
│  Showing 20 of 187 · Load more                 Crawled May 14, 2026    │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [Recrawl]                                   [View Documents in KB]     │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key differences from crawling state:**

- Header: ✓ Active (green, static) — no "Run in Background" button
- Status Strip: no progress animation, completion message with relative time
- Stats: Queued counter gone (replaced by Duration), no "Live 📡" indicator
- Quality bar appears below stats
- Table: all rows terminal (✓ only), no pulsing dots, no queued rows
- Filter: `[✓ Success 187]` only — no Active/Failed/Thin filters needed
- Footer: "Crawled May 14, 2026" replaces "Live 📡"
- Actions Bar: [Recrawl] | [View Documents in KB]

---

## Complete Page: State D — Completed with Issues

**When**: Crawl finished but has failures AND/OR thin content pages.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← My KB  /  epson.com                ⚠ Completed with issues    [⋮]   │
├─────────────────────────────────────────────────────────────────────────┤
│  ⚠ Completed with issues · 4 minutes ago                               │
│  187 pages crawled · 3 failed · 12 thin content                        │
│                                                                         │
│  ┌──────────┬──────────┬──────────┬──────────┐                         │
│  │ 187      │ 172      │ 3        │ 4m 12s   │                         │
│  │ Pages    │ Documents│ Failed   │ Duration │                         │
│  │ Crawled  │ Created  │          │          │                         │
│  └──────────┴──────────┴──────────┴──────────┘                         │
│                                                                         │
│  Quality: ████████████████░░░░  89% good · 12 thin · 3 failed         │
│                                                                         │
│  💡 12 pages have thin content — consider adjusting extraction          │
│     3 pages returned 403 — check if authentication is required    [✕]  │
├─────────────────────────────────────────────────────────────────────────┤
│  [● Pages]     [History]     [Settings]                                │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│  🔍 Search pages...   [All 187] [✓ Success 172] [✗ Failed 3] [⚠ Thin 12]│
│                                                            [Export CSV] │
│  ┌─────┬──────────────────────────────────┬──────┬────────┬─────┬─────┐│
│  │  ✗  │ /admin/dashboard                │  —   │  403   │     │  ↻  ││
│  │  ✗  │ /support/printers/very-long-page│  —   │timeout │     │  ↻  ││
│  │  ✗  │ /downloads/large-catalog        │  —   │timeout │     │  ↻  ││
│  ├─────┼──────────────────────────────────┼──────┼────────┼─────┼─────┤│
│  │  ✓  │ /products/inkjet-printers       │ HTTP │  rich  │ 8ch │  👁 ││
│  │  ✓  │ /support/faq                    │ HTTP │  thin  │ 1ch │  👁 ││
│  │  ✓  │ /support/printers/workforce     │  PW  │  rich  │12ch │  👁 ││
│  │  ✓  │ /downloads/drivers              │  PW  │  rich  │15ch │  👁 ││
│  │  ✓  │ /products/workforce-printers    │ HTTP │  thin  │ 2ch │  👁 ││
│  │ ... │                                 │      │        │     │     ││
│  └─────┴──────────────────────────────────┴──────┴────────┴─────┴─────┘│
│  Showing 20 of 187 · Load more                 Crawled May 14, 2026    │
│                                                                         │
│  ▸ Errors (3)                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  Timeout (2 pages)                                     [Retry All] ││
│  │    /support/printers/very-long-page                                ││
│  │    /downloads/large-catalog                                        ││
│  │    💡 These pages took too long to respond. May work on retry.     ││
│  │  403 Forbidden (1 page)                                            ││
│  │    /admin/dashboard                                                ││
│  │    💡 Check if authentication is required for this section.        ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [Recrawl]                                   [View Documents in KB]     │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key differences from clean completion:**

- Header: ⚠ amber badge, "Completed with issues"
- Status Strip: amber progress bar (not green), explicit failure + thin counts
- Quality bar: shows breakdown "89% good · 12 thin · 3 failed"
- **Data quality suggestions** (Algolia pattern): actionable suggestions below quality bar, dismissible [✕]
- Filter buttons: `[✗ Failed 3]` and `[⚠ Thin 12]` active — user can click to isolate
- Failed rows pinned to top of table
- Error grouping panel: visible (collapsed by default), with [Retry All] per group
- Actionable microcopy per error type

---

## Complete Page: State E — Crawl Failed (With Partial Results)

**When**: CrawlJob status = `failed`. Some pages were crawled before failure.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← My KB  /  epson.com                            ✗ Failed      [⋮]    │
├─────────────────────────────────────────────────────────────────────────┤
│  ✗ Crawl failed · 12 minutes ago                                       │
│  Connection timeout after 45 pages · 155 remaining                     │
│                                                                         │
│  ┌──────────┬──────────┬──────────┬──────────┐                         │
│  │ 45       │ 42       │ 3        │ 1m 30s   │                         │
│  │ Pages    │ Documents│ Failed   │ Duration │                         │
│  │ Crawled  │ Created  │          │          │                         │
│  └──────────┴──────────┴──────────┴──────────┘                         │
│                                                                         │
│  💡 The target site may be rate-limiting requests.                      │
│     Try reducing crawl speed in Settings, or retry later.         [✕]  │
├─────────────────────────────────────────────────────────────────────────┤
│  [● Pages]     [History]     [Settings]                                │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│  🔍 Search pages...       [All 45] [✓ Success 42] [✗ Failed 3]        │
│                                                            [Export CSV] │
│  ┌─────┬──────────────────────────────────┬──────┬────────┬─────┬─────┐│
│  │  ✗  │ /support/printers/very-long-page│  —   │timeout │     │  ↻  ││
│  │  ✗  │ /downloads/large-catalog        │  —   │timeout │     │  ↻  ││
│  │  ✗  │ /admin/dashboard               │  —   │  403   │     │  ↻  ││
│  ├─────┼──────────────────────────────────┼──────┼────────┼─────┼─────┤│
│  │  ✓  │ /products/inkjet-printers       │ HTTP │  rich  │ 8ch │  👁 ││
│  │  ✓  │ /support/faq                    │ HTTP │  std   │ 4ch │  👁 ││
│  │  ✓  │ /downloads/drivers              │  PW  │  rich  │15ch │  👁 ││
│  │ ... │                                 │      │        │     │     ││
│  └─────┴──────────────────────────────────┴──────┴────────┴─────┴─────┘│
│  Showing 20 of 45                               Crawled May 14, 2026   │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [Retry Crawl]                                  [View Partial Results]  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Page: State F — Crawl Failed (Zero Pages)

**When**: Crawl couldn't connect at all. 0 pages crawled.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← My KB  /  epson.com                            ✗ Failed      [⋮]    │
├─────────────────────────────────────────────────────────────────────────┤
│  ✗ Crawl failed · 2 minutes ago                                        │
│  Could not connect to epson.com · 0 pages crawled                      │
│                                                                         │
│  ┌──────────┬──────────┬──────────┬──────────┐                         │
│  │ 0        │ 0        │ 0        │ 0m 12s   │                         │
│  │ Pages    │ Documents│ Failed   │ Duration │                         │
│  │ Crawled  │ Created  │          │          │                         │
│  └──────────┴──────────┴──────────┴──────────┘                         │
│                                                                         │
│  💡 Check that the URL is accessible and not blocking automated        │
│     requests. You can test by opening the URL in an incognito tab. [✕] │
├─────────────────────────────────────────────────────────────────────────┤
│  [● Pages]     [History]     [Settings]                                │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│                                                                         │
│                         ✗ (error icon)                                  │
│                                                                         │
│              No pages were crawled before the failure.                  │
│              Retry the crawl or check the URL in Settings.             │
│                                                                         │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [Retry Crawl]                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Page: State G — Crawl Cancelled

**When**: User cancelled a running crawl. CrawlJob status = `cancelled`. Pages crawled before cancellation are preserved.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← My KB  /  epson.com                          ⊘ Cancelled     [⋮]    │
├─────────────────────────────────────────────────────────────────────────┤
│  ⊘ Crawl cancelled · 5 minutes ago                                     │
│  Stopped by user after 89 pages                                        │
│                                                                         │
│  ┌──────────┬──────────┬──────────┬──────────┐                         │
│  │ 89       │ 87       │ 2        │ 3m 45s   │                         │
│  │ Pages    │ Documents│ Failed   │ Duration │                         │
│  │ Crawled  │ Created  │          │          │                         │
│  └──────────┴──────────┴──────────┴──────────┘                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [● Pages]     [History]     [Settings]                                │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│  🔍 Search pages...       [All 89] [✓ Success 87] [✗ Failed 2]        │
│                                                            [Export CSV] │
│  ┌─────┬──────────────────────────────────┬──────┬────────┬─────┬─────┐│
│  │  ✗  │ /admin/dashboard               │  —   │  403   │     │  ↻  ││
│  │  ✗  │ /support/printers/very-long-page│  —   │timeout │     │  ↻  ││
│  ├─────┼──────────────────────────────────┼──────┼────────┼─────┼─────┤│
│  │  ✓  │ /products/inkjet-printers       │ HTTP │  rich  │ 8ch │  👁 ││
│  │  ✓  │ /support/faq                    │ HTTP │  std   │ 4ch │  👁 ││
│  │  ✓  │ /downloads/drivers              │  PW  │  rich  │15ch │  👁 ││
│  │  ✓  │ /products/workforce-printers    │ HTTP │  rich  │11ch │  👁 ││
│  │ ... │                                 │      │        │     │     ││
│  └─────┴──────────────────────────────────┴──────┴────────┴─────┴─────┘│
│  Showing 20 of 89                               Crawled May 14, 2026   │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [Recrawl]                                   [View Documents in KB]     │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key details:**

- Header: ⊘ gray badge, "Cancelled" — NOT red, NOT error
- Status Strip: neutral tone, "Stopped by user" — no blame, no alarm
- No quality bar (crawl didn't complete fully)
- No suggestions (cancellation was intentional)
- Table: 89 usable pages, full search/filter/export
- Actions: [Recrawl] | [View Documents in KB] — pages ARE in the KB

---

## Complete Page: State H — Idle Source (Has Data, No Active Crawl)

**When**: Source status = `active`, no CrawlJob running. User clicks source row from KB sources table.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← My KB  /  epson.com                          ✓ Active        [⋮]    │
├─────────────────────────────────────────────────────────────────────────┤
│  Last crawled 3 days ago · 187 pages · 89% quality                     │
│                                                                         │
│  ┌──────────┬──────────┬──────────┬──────────┐                         │
│  │ 187      │ 184      │ 3        │ 4m 12s   │                         │
│  │ Pages    │ Documents│ Failed   │ Duration │                         │
│  │ Crawled  │ Created  │          │          │                         │
│  └──────────┴──────────┴──────────┴──────────┘                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [● Pages]     [History]     [Settings]                                │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│  🔍 Search pages...   [All 187] [✓ Success 184] [✗ Failed 3] [⚠ Thin 12]│
│                                                            [Export CSV] │
│  ┌─────┬──────────────────────────────────┬──────┬────────┬─────┬─────┐│
│  │  ✗  │ /admin/dashboard               │  —   │  403   │     │  ↻  ││
│  │  ✗  │ /support/printers/very-long-page│  —   │timeout │     │  ↻  ││
│  │  ✗  │ /downloads/large-catalog        │  —   │timeout │     │  ↻  ││
│  ├─────┼──────────────────────────────────┼──────┼────────┼─────┼─────┤│
│  │  ✓  │ /products/inkjet-printers       │ HTTP │  rich  │ 8ch │  👁 ││
│  │  ✓  │ /support/faq                    │ HTTP │  thin  │ 1ch │  👁 ││
│  │  ✓  │ /support/printers/workforce     │  PW  │  rich  │12ch │  👁 ││
│  │  ✓  │ /downloads/drivers              │  PW  │  rich  │15ch │  👁 ││
│  │ ... │                                 │      │        │     │     ││
│  └─────┴──────────────────────────────────┴──────┴────────┴─────┴─────┘│
│  Showing 20 of 187 · Load more                 Crawled May 11, 2026    │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [Recrawl]                                   [View Documents in KB]     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Page: State I — Pending Source (No Data, Never Crawled)

**When**: Source status = `pending`, never crawled. User clicks source row from KB sources table.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← My KB  /  epson.com                          ○ Pending       [⋮]    │
├─────────────────────────────────────────────────────────────────────────┤
│  No crawl data yet                                                     │
│  Start a crawl to discover and index pages from this source            │
│                                                                         │
│  ┌──────────┬──────────┬──────────┬──────────┐                         │
│  │ —        │ —        │ —        │ —        │                         │
│  │ Pages    │ Documents│ Failed   │ Duration │                         │
│  │ Crawled  │ Created  │          │          │                         │
│  └──────────┴──────────┴──────────┴──────────┘                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [● Pages]     [History]     [Settings]                                │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│                                                                         │
│                         📄 (document icon)                              │
│                                                                         │
│                    No pages crawled yet                                 │
│            Start a crawl to discover and index pages                   │
│                                                                         │
│                        [Start Crawl]                                    │
│                                                                         │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                      [Start Crawl]     │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key details:**

- Header: ○ gray, "Pending"
- Status Strip: invitation copy, all dashes in stats
- Pages tab: centered empty state with icon and CTA
- [Start Crawl] appears BOTH in empty state AND in Actions Bar (for discoverability)
- [Start Crawl] opens CrawlFlowV5 with source URL pre-filled
- History and Settings tabs show their own empty states

---

## Complete Page: State J — Viewing Historical Job

**When**: User clicked a past job in History tab. Pages and stats show THAT job's data, not the latest.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← My KB  /  epson.com                          ✓ Active        [⋮]    │
├─────────────────────────────────────────────────────────────────────────┤
│  📋 Viewing crawl from May 9, 2026                 [Back to latest →]  │
│                                                                         │
│  ┌──────────┬──────────┬──────────┬──────────┐                         │
│  │ 142      │ 140      │ 2        │ 3m 20s   │                         │
│  │ Pages    │ Documents│ Failed   │ Duration │                         │
│  │ Crawled  │ Created  │          │          │                         │
│  └──────────┴──────────┴──────────┴──────────┘                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [● Pages]     [History]     [Settings]                                │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│  🔍 Search pages...       [All 142] [✓ Success 140] [✗ Failed 2]      │
│                                                            [Export CSV] │
│  ┌─────┬──────────────────────────────────┬──────┬────────┬─────┬─────┐│
│  │  ✗  │ /admin/dashboard               │  —   │  403   │     │  ↻  ││
│  │  ✗  │ /support/old-page              │  —   │  404   │     │  ↻  ││
│  ├─────┼──────────────────────────────────┼──────┼────────┼─────┼─────┤│
│  │  ✓  │ /products/inkjet-printers       │ HTTP │  rich  │ 7ch │  👁 ││
│  │  ✓  │ /support/faq                    │ HTTP │  std   │ 4ch │  👁 ││
│  │  ✓  │ /downloads/drivers              │  PW  │  rich  │14ch │  👁 ││
│  │ ... │                                 │      │        │     │     ││
│  └─────┴──────────────────────────────────┴──────┴────────┴─────┴─────┘│
│  Showing 20 of 142                              Crawled May 9, 2026    │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [Recrawl]                                                              │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key differences:**

- Status Strip: "📋 Viewing crawl from..." with [Back to latest →] link
- Stats: from the SELECTED job, not the latest
- Table: THAT job's pages (may differ from current)
- Actions: [Recrawl] only — no [View Documents in KB] (documents may be superseded)
- Header still shows current source status (✓ Active) — this is accurate, the source IS active

---

## Complete Page: History Tab View

**When**: User clicks History tab from any state.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← My KB  /  epson.com                          ✓ Active        [⋮]    │
├─────────────────────────────────────────────────────────────────────────┤
│  Last crawled 3 days ago · 187 pages · 89% quality                     │
│                                                                         │
│  ┌──────────┬──────────┬──────────┬──────────┐                         │
│  │ 187      │ 184      │ 3        │ 4m 12s   │                         │
│  │ Pages    │ Documents│ Failed   │ Duration │                         │
│  │ Crawled  │ Created  │          │          │                         │
│  └──────────┴──────────┴──────────┴──────────┘                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [Pages]     [● History]     [Settings]                                │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│  ┌───────────┬──────────────────┬──────────┬────────┬────────┬────────┐│
│  │ Status    │ URL              │ Results  │Strategy│ When   │Actions ││
│  ├───────────┼──────────────────┼──────────┼────────┼────────┼────────┤│
│  │ ✓ Done    │ epson.com        │ 187 / 3  │ Bulk   │ 3d ago │ ↻   🗑 ││
│  │ ⚠ Issues  │ epson.com        │ 142 / 12 │ Bulk   │ 10d    │ ↻   🗑 ││
│  │ ✗ Fail    │ epson.com        │  45 /155 │ Bulk   │ 15d    │ ↻   🗑 ││
│  │ ⊘ Cancel  │ epson.com        │  89 / 2  │ Intel  │ 20d    │     🗑 ││
│  │ ✓ Done    │ epson.com        │ 142 / 1  │ Intel  │ 30d    │ ↻   🗑 ││
│  └───────────┴──────────────────┴──────────┴────────┴────────┴────────┘│
│                                                                         │
│  Click a row to view that crawl's pages and stats.                     │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [Recrawl]                                   [View Documents in KB]     │
└─────────────────────────────────────────────────────────────────────────┘
```

**History tab details:**

- Data source: `getCrawlHistory(indexId, limit)` filtered by `sourceId` client-side
- Click a row → switches to Pages tab showing THAT job's pages via `getCrawledPages(jobId)` (→ State J)
- Status Strip + stats update to selected job's numbers
- Status column: same icons/colors as header badge (consistent visual language)
- Results: `crawled / failed` format
- Strategy: from `CrawlJob.configuration.strategy` (browser, bulk, hybrid, intelligence, etc.)
- Per-row ↻ Recrawl: only for completed/failed/issues (not cancelled)
- Per-row 🗑 Delete: terminal states only, with ConfirmDialog
- Actions Bar remains from the current source state (not from selected history row)
- **Note**: Currently fetches ALL jobs for the index (up to 100) and filters client-side — may need server-side filtering for scale

---

## Complete Page: History Tab — Empty

**When**: Source has never been crawled (status = `pending`).

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← My KB  /  epson.com                          ○ Pending       [⋮]    │
├─────────────────────────────────────────────────────────────────────────┤
│  No crawl data yet                                                     │
│  Start a crawl to discover and index pages from this source            │
│                                                                         │
│  ┌──────────┬──────────┬──────────┬──────────┐                         │
│  │ —        │ —        │ —        │ —        │                         │
│  │ Pages    │ Documents│ Failed   │ Duration │                         │
│  │ Crawled  │ Created  │          │          │                         │
│  └──────────┴──────────┴──────────┴──────────┘                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [Pages]     [● History]     [Settings]                                │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│                                                                         │
│                         📋 (clipboard icon)                             │
│                                                                         │
│                    No crawl history                                     │
│          Crawl jobs will appear here after your first crawl            │
│                                                                         │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                      [Start Crawl]     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Page: Settings Tab

**When**: User clicks Settings tab. Settings reflect the persisted `crawlConfig` on the source.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← My KB  /  epson.com                          ✓ Active        [⋮]    │
├─────────────────────────────────────────────────────────────────────────┤
│  Last crawled 3 days ago · 187 pages · 89% quality                     │
│                                                                         │
│  ┌──────────┬──────────┬──────────┬──────────┐                         │
│  │ 187      │ 184      │ 3        │ 4m 12s   │                         │
│  │ Pages    │ Documents│ Failed   │ Duration │                         │
│  │ Crawled  │ Created  │          │          │                         │
│  └──────────┴──────────┴──────────┴──────────┘                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [Pages]     [History]     [● Settings]                                │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│  Source Configuration                                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ URL              https://epson.com                                  ││
│  │ Strategy         Guided Discovery                                   ││
│  │ Created          May 1, 2026                                        ││
│  │ Last Crawled     May 11, 2026 (3 days ago)                          ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  Site Profile                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ Site Type        Corporate                                          ││
│  │ Has Sitemap      Yes (1,200 URLs)                                   ││
│  │ JS Required      No                                                 ││
│  │ Platform         WordPress                                          ││
│  │ Avg Response     240ms                                              ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  Crawl Settings                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ Scope            Limited                                            ││
│  │ Rendering        HTTP (hybrid where needed)                         ││
│  │ Max Pages        200                                                ││
│  │ Max Depth        3                                                  ││
│  │ Request Delay    1000ms                                             ││
│  │ Cleanup          Aggressive                                         ││
│  │ Respect robots   Yes                                                ││
│  │ Deduplicate      Yes                                                ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  Sections (3 included)                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ ✓  /products/*          Sitemap    HTTP     ~120 pages              ││
│  │ ✓  /support/*           Explored   PW       ~80 pages              ││
│  │ ✓  /downloads/*         Sitemap    HTTP     ~45 pages              ││
│  │ ✗  /admin/*             Explored   —        ~15 pages (excluded)   ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  Authentication                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ Method           None                                               ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  Danger Zone                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ Delete this source and all its crawled documents                    ││
│  │ This action cannot be undone.                                       ││
│  │                                              [Delete Source]        ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [Recrawl]                                   [View Documents in KB]     │
└─────────────────────────────────────────────────────────────────────────┘
```

**Settings details:**

- All read-only — to change settings, user does a Recrawl (CrawlFlowV5 pre-fills from `source.crawlConfig`)
- **Source Configuration**: URL, discovery strategy, timestamps
- **Site Profile**: from `crawlConfig.profile` — siteType, hasSitemap, sitemapPageCount, jsRequired, platform, avgResponseTime
- **Crawl Settings**: from `crawlConfig.settings` — scope, rendering, maxPages, maxDepth, requestDelay, cleanup, respectRobotsTxt, deduplicate
- **Sections**: from `crawlConfig.sections` — pattern, name, source (sitemap/explored/auto/direct), strategy (http/browser), pageCount, included flag
- **Authentication**: from `crawlConfig.auth` — method (none/basic/bearer/headers/cookies), credentials masked
- **Danger Zone**: Delete Source with ConfirmDialog (requires typing source domain to confirm)
- Actions Bar: same as the current source state

---

## Complete Page: Cancel Confirmation Dialog

**When**: User clicks [Cancel Crawl] during active crawl. Dialog overlays the page.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← My KB  /  epson.com                    ● Crawling  [Run in Background]│
├─────────────────────────────────────────────────────────────────────────┤
│  ● Crawling product pages (89 of ~200)                       Live 📡   │
│  ████████████░░░░░░░░░░░░░░░░░  45%  · ETA ~5 min                     │
│  ...                                                                    │
│                                                                         │
│       ┌─────────────────────────────────────────────────┐              │
│       │  Cancel crawl?                                  │              │
│       │                                                 │              │
│       │  89 pages have been crawled so far.             │              │
│       │  These will be preserved.                       │              │
│       │                                                 │              │
│       │  The remaining ~111 pages will not be crawled.  │              │
│       │                                                 │              │
│       │  [Keep Crawling]          [Cancel Crawl] (red)  │              │
│       └─────────────────────────────────────────────────┘              │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [Cancel Crawl]                                    [Run in Background]  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## KB Sources Table — Source Row States

**When**: User is on KB detail page, sources tab. This is the entry/exit point for the Unified Source Page.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Sources                                                  [Add Source]  │
│  ┌──────┬──────────────────────┬──────────────────────────────┬───────┐│
│  │Status│ Source               │ Details                      │Actions││
│  ├──────┼──────────────────────┼──────────────────────────────┼───────┤│
│  │  ⚙   │ new-site.com         │ Configuring · Step 2 of 3   │       ││ ← gray, click resumes wizard
│  │  ●   │ epson.com            │ Crawling · 134 pages · 2m   │       ││ ← blue pulsing
│  │  ✓   │ docs.example.com     │ Active · 42 pages · 2d ago  │  ⋮    ││
│  │  ⚠   │ api.example.com      │ Issues · 12 failed · 1h ago │  ⋮    ││
│  │  ✗   │ broken.example.com   │ Failed · 0 pages · 30m ago  │  ⋮    ││
│  │  ⊘   │ old.example.com      │ Cancelled · 89 pages · 5d   │  ⋮    ││
│  │  ○   │ new-site.com         │ Pending                     │  ⋮    ││
│  └──────┴──────────────────────┴──────────────────────────────┴───────┘│
│                                                                         │
│  Click any row → opens Unified Source Page (full page)                 │
│  Configuring row → resumes CrawlFlowV5 wizard                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Source row details:**

- Status dot: matches header badge states (same colors, same icons)
- **Configuring row**: ⚙ gray, shows wizard progress ("Step 2 of 3"), click resumes `CrawlFlowV5` via `useCrawlFlowStore.open(sourceId)`
- Crawling row: pulsing blue dot, live page count + elapsed time
- Active row: green dot, page count, last crawl relative time
- Issues row: amber dot, failed count, last crawl relative time
- Failed/Cancelled/Pending: same consistent visual language
- Click non-configuring row → opens Unified Source Page for that source

---

## Background Completion — Toast Notifications

**When**: Crawl completes while user is NOT on the Unified Source Page. Delivered via WebSocket `job_completed` / `job_failed` events.

### Toast: Success (short crawl < 1 min)

```
                                    ┌──────────────────────────────────────┐
                                    │ ✓ epson.com crawl completed          │
                                    │   187 pages                          │
                                    │ [View Results]              [Dismiss]│
                                    └──────────────────────────────────────┘
Auto-dismisses after 10 seconds.
```

### Toast: Success (long crawl 1-10 min)

```
                                    ┌──────────────────────────────────────┐
                                    │ ✓ epson.com crawl completed          │
                                    │   187 pages · 3 failed               │
                                    │   Quality: 89% good                  │
                                    │ [View Results]              [Dismiss]│
                                    └──────────────────────────────────────┘
Persistent — stays until dismissed or clicked.
```

### Toast: Completed with issues

```
                                    ┌──────────────────────────────────────┐
                                    │ ⚠ epson.com completed with issues    │
                                    │   187 pages · 3 failed · 12 thin    │
                                    │ [View Results]              [Dismiss]│
                                    └──────────────────────────────────────┘
```

### Toast: Failed

```
                                    ┌──────────────────────────────────────┐
                                    │ ✗ epson.com crawl failed             │
                                    │   Connection timeout after 45 pages  │
                                    │ [View Details]              [Dismiss]│
                                    └──────────────────────────────────────┘
```

---

## Complete Journeys

### Journey 1: Fresh Crawl — First Time

**Trigger**: User completes CrawlFlowV5 wizard (3 steps), clicks "Crawl N Pages"

```
User clicks "Crawl N Pages" on Step 2 (Analysis/Configure)
  → CrawlFlowV5 submits via submitBatchCrawl()
  → crawlConfig.wizardStep set to 'submitted', crawlJobId set
  → Source status transitions: configuring → (job starts) → crawling display
  → Navigates to Unified Source Page (full page)
  → URL: /searchai/{kbId}/sources/{sourceId}
  → PAGE STATE: State B (crawl just started, 0 pages)

First page crawled
  → WebSocket event: url_fetched → document_processed
  → Row appears at top of Pages table: "● /products/inkjet-printers  HTTP  ···"
  → Row transitions: ● crawling → ✓ success, quality badge appears, chunk count fills
  → PAGE STATE: Transitioning B → A (active crawl, pages appearing)

Mid-crawl (134 pages)
  → PAGE STATE: State A (active crawl, mid-progress)
  → All stat counters animate on update
  → Failed rows pinned to top
  → Error panel appears if failures > 0

Crawl completes (all good)
  → WebSocket event: job_completed
  → Source status → active
  → Status Strip: crawling → "✓ Crawl completed · just now"
  → Progress bar fills to 100% (green)
  → All table rows terminal — no pulsing dots
  → PAGE STATE: State C (completed successfully)

Crawl completes (with issues)
  → PAGE STATE: State D (completed with issues)
  → Quality suggestions appear in Status Strip
```

### Journey 2: Run in Background + Return Later

**Trigger**: User clicks "Run in Background" during active crawl

```
User is on State A (active crawl, 134 pages)
  → Clicks "Run in Background" in Actions Bar
  → Navigates back to KB detail page (sources tab)
  → No dialog, no confirmation — just navigates
  → Crawl continues server-side

KB sources table
  → Source row: "● epson.com  Crawling · 134 pages · 2m" (pulsing blue dot)
  → User can see it's still running at a glance

User returns DURING crawl
  → Clicks crawling source row
  → Opens Unified Source Page → PAGE STATE: State A
  → WebSocket reconnects via useCrawlProgress
  → Backscroll: ALL pages loaded from Redis progress:last:<jobId> cache immediately
  → Live table resumes — no "you joined late" penalty

User returns AFTER completion
  → Source row shows: "✓ epson.com  Active · 187 pages · 5 min ago"
  → Clicks source row → PAGE STATE: State C or D

Toast (if user is on KB page when crawl finishes)
  → Toast: "✓ epson.com crawl completed · 187 pages [View Results]"
  → Click [View Results] → navigates to Unified Source Page
```

### Journey 3: Crawl Completes with Issues

**Trigger**: Crawl finishes but has failures or thin content

```
Crawl completes with 3 failures + 12 thin content pages
  → PAGE STATE: State D (completed with issues)
  → Status Strip: amber, "⚠ Completed with issues"
  → Quality bar: "89% good · 12 thin · 3 failed"
  → Suggestions: "💡 12 pages have thin content..."

User investigates thin content
  → Clicks [⚠ Thin 12] filter in Pages tab
  → Table filters to thin-content pages only
  → Each shows: URL, quality "thin", low chunk count
  → Click 👁 to preview and decide if acceptable

User investigates failures
  → Clicks [✗ Failed 3] filter
  → Failed rows visible at top
  → Expands error grouping panel
  → Sees: "Timeout (2 pages) [Retry All]", "403 Forbidden (1 page)"
  → Clicks [Retry All] on timeout group

Retry in progress
  → Status Strip briefly returns to crawling for 2 pages
  → Those 2 rows transition: ✗ failed → ● crawling → ✓ success / ✗ failed
  → If all succeed: PAGE STATE → State C
  → If some still fail: PAGE STATE remains State D
```

### Journey 4: Crawl Fails Entirely

**Trigger**: CrawlJob status transitions to `failed`

```
WITH partial results (45 pages crawled before failure)
  → PAGE STATE: State E (failed, partial results)
  → Suggestion: "💡 The target site may be rate-limiting..."
  → User can browse 45 pages, search, filter, export
  → Actions: [Retry Crawl] | [View Partial Results]
  → [Retry Crawl]: new CrawlJob via submitBatchCrawl() → PAGE STATE: State B

WITHOUT partial results (0 pages)
  → PAGE STATE: State F (failed, zero pages)
  → Pages tab: empty error state
  → Suggestion: "💡 Check that the URL is accessible..."
  → Actions: [Retry Crawl] only
```

### Journey 5: User Cancels Mid-Crawl

**Trigger**: User clicks [Cancel Crawl] during active crawl

```
User on PAGE STATE: State A (active crawl)
  → Clicks [Cancel Crawl]
  → Cancel Confirmation Dialog appears (overlay)
  → Shows: "89 pages crawled, these will be preserved. ~111 remaining will not be crawled."

User confirms
  → Calls cancelCrawlJob(jobId)
  → Brief "⊘ Cancelling..." state
  → Worker finishes current page, stops
  → CrawlJob status → cancelled
  → PAGE STATE: State G (cancelled)
  → 89 pages fully usable, documents in KB
  → NO error messaging — neutral tone

User cancels the cancel dialog
  → Dialog closes, crawl continues uninterrupted
  → PAGE STATE: remains State A
```

### Journey 6: View Existing Source (Idle, Has Data)

**Trigger**: User clicks web source row from KB sources table (source.status = `active`, no crawl running)

```
Clicks source row
  → Opens Unified Source Page (full page, NOT slide panel)
  → PAGE STATE: State H (idle, has data)
  → Pages tab auto-selected with latest job's pages
  → Full search, filter, sort, export available

Browse pages
  → Search: type URL fragment to filter
  → Filter: [All 187] [✓ Success 184] [✗ Failed 3] [⚠ Thin 12]
  → Click 👁 on page → opens chunk explorer (preview content)
  → Click ↻ on failed page → retries that single page

Check history
  → Click History tab → see History Tab View
  → Click any row → PAGE STATE: State J (viewing historical job)

Check settings
  → Click Settings tab → see Settings Tab View
  → Read-only; change settings via Recrawl flow

Actions
  → [Recrawl] → opens CrawlFlowV5 with crawlConfig pre-filled (via restoreFromSource)
  → [View Documents in KB] → navigates to KB documents tab, filtered by source
```

### Journey 7: View Source with No Data

**Trigger**: User clicks pending web source (source.status = `pending`)

```
Clicks source row
  → PAGE STATE: State I (pending, no data)
  → All stats show dashes
  → Pages tab: centered empty state with [Start Crawl] CTA

Other tabs
  → History tab: empty state — "No crawl history"
  → Settings tab: source config (URL, type), Delete Source

Start crawl
  → Click [Start Crawl] (in Pages empty state OR Actions Bar)
  → Opens CrawlFlowV5 with source URL pre-filled
  → After completing flow → PAGE STATE: State B → A → C/D
```

### Journey 8: View Past Job from History

**Trigger**: User clicks a past job row in History tab

```
User on PAGE STATE: State H (idle) or any terminal state
  → Clicks History tab
  → Sees chronological list of all past crawl jobs for this source
  → Clicks a row (e.g., "✗ Fail · 45/155 · 15 days ago")

PAGE STATE: State J (viewing historical job)
  → Pages tab activates with THAT job's pages (via getCrawledPages(jobId))
  → Status Strip: "📋 Viewing crawl from May 1 · [Back to latest →]"
  → Stats update to that job's numbers
  → Error grouping shows that job's errors

Return to latest
  → Click "Back to latest →" in Status Strip
  → PAGE STATE: returns to State H (or whatever the current state is)
  → Stats, pages, status strip all reset to latest
```

### Journey 9: Recrawl Existing Source

**Trigger**: User clicks [Recrawl] from any terminal state

```
Click [Recrawl] in Actions Bar (or ↻ on History row)
  → Opens CrawlFlowV5 with settings pre-filled from source.crawlConfig
  → Pre-fill includes: URL, sections, settings, auth (via restoreFromSource)
  → User can adjust: max pages, depth, patterns, strategy, auth
  → Clicks "Crawl N Pages" → new CrawlJob via submitBatchCrawl()
  → PAGE STATE: State B → A → C/D (same as Journey 1)

After recrawl completes
  → New job appears at top of History
  → Previous job preserved (viewable via History)
  → Documents in KB updated/replaced as new pages processed
  → Worker post-crawl cleanup: SourceConfigState + SourceUrlBucket deleted
```

### Journey 10: Multiple Sources in Same KB

**Trigger**: User has multiple web sources

```
KB sources table shows all sources with live status
  → See "KB Sources Table — Source Row States" section above
  → Each row: status dot, source domain, inline details, actions

Navigate between sources
  → Click "epson.com" → Unified Source Page (State A/C/D/etc)
  → Click "← My KB" breadcrumb → back to sources table
  → Click "docs.example.com" → Unified Source Page for that source
  → Each source page is fully independent — no shared state

Background awareness
  → While viewing docs.example.com, epson.com crawl finishes
  → Toast: "✓ epson.com crawl completed · 187 pages [View Results]"
  → Click [View Results] → navigates to epson.com's page
  → Or dismiss and continue with docs.example.com
```

---

## Non-Web Sources — No Regression (SourceDetailPanel Preserved)

USP only replaces the **web source** path. All other source types continue to use their current slide panel (`SourceDetailPanel` or `ConnectorDetailPanel`/`SharePointDetailPanel`). This section documents the current behavior that MUST remain unchanged.

### Source Click Routing (SourcesTable.handleRowClick)

The routing logic in `SourcesTable` (lines 310-342) dispatches based on source type and status:

| Source Type                   | Condition                               | Click Action       | Component                                       |
| ----------------------------- | --------------------------------------- | ------------------ | ----------------------------------------------- |
| Web                           | `status === 'configuring'` or `'draft'` | Resume wizard      | `CrawlFlowV5` via `useCrawlFlowStore`           |
| Web                           | All other statuses                      | **NEW: Full page** | Unified Source Page                             |
| SharePoint                    | Has connectorId                         | Enterprise panel   | `SharePointDetailPanel` via `useConnectorStore` |
| Enterprise connector (non-SP) | Has connectorId                         | Enterprise panel   | `ConnectorDetailPanel`                          |
| Manual / File                 | Any                                     | Slide panel        | `SourceDetailPanel` (non-web branch)            |
| Database                      | Any                                     | Slide panel        | `SourceDetailPanel` (non-web branch)            |
| API                           | Any                                     | Slide panel        | `SourceDetailPanel` (non-web branch)            |

**Only the "Web + non-configuring" row changes.** All other rows keep their current click targets.

### Manual / File Source — Current Behavior (Preserve As-Is)

`SourceDetailPanel` renders a rich analytics dashboard via `ManualSourceOverview`:

```
┌──────────────────────────────────────────────── SlidePanel (640px) ──┐
│  Header: source name + status badge + close button                   │
│  Type label: "Manual"                                                │
├──────────────────────────────────────────────────────────────────────┤
│  0 documents:                                                        │
│    Dashed upload zone: icon + "Upload files" CTA                     │
│                                                                      │
│  Has documents:                                                      │
│    KPI Cards (2x2 grid):                                             │
│      📄 Documents (count)    💾 Total Size (formatted)               │
│      📦 Chunks (count)       📄 Pages (if > 0)                      │
│                                                                      │
│    Content Breakdown (by file type):                                 │
│      PDF  45 (60%)  ██████████████████░░░░░                          │
│      DOCX 20 (27%)  ██████████░░░░░░░░░░░                            │
│      TXT  10 (13%)  █████░░░░░░░░░░░░░░░░                            │
│                                                                      │
│    Processing Status:                                                │
│      ● completed 42  ● pending 3  ● extracting 2                    │
│      (polls at 1s while any docs are processing)                     │
│                                                                      │
│    Storage Summary (Card):                                           │
│      Total: 12.4 MB  |  Average: 165 KB  |  Largest: 2.1 MB        │
│                                                                      │
│    Recent Activity (last 5 docs):                                    │
│      report.pdf    2.1 MB    May 14                                  │
│      notes.docx    45 KB     May 13                                  │
│                                                                      │
│    Actions:                                                          │
│      [Upload Files]  [View Documents]                                │
├──────────────────────────────────────────────────────────────────────┤
│  Danger Zone:                                                        │
│    [Delete Source] → confirm dialog                                  │
└──────────────────────────────────────────────────────────────────────┘
```

**Data source**: `fetchSourceStats(indexId, sourceId)` → `SourceStats` (byFileType, byStatus, size, totalChunks, recentDocuments).

### Database Source — Current Behavior (Preserve As-Is)

```
┌──────────────────────────────────────────────── SlidePanel (640px) ──┐
│  Header: source name + status badge                                  │
├──────────────────────────────────────────────────────────────────────┤
│  Overview:                                                           │
│    Documents: 1,234    Last sync: May 14, 3:20 PM                   │
│                                                                      │
│  Error (if status === 'error'):                                      │
│    ⚠ Sync Error                                                      │
│    "Connection refused: mongodb://***@host:27017/db"                 │
│    Error occurred at: May 14, 3:20 PM                                │
│    [Retry Sync] (if connectorId)                                     │
│                                                                      │
│  Configuration:                                                      │
│    Connection: mongodb://***@host:27017/db (credentials masked)      │
│    Collection: products                                              │
│    Query: { "active": true }                                         │
│                                                                      │
│  "Sync is managed automatically" info box (if no connectorId)        │
│                                                                      │
│  Actions:                                                            │
│    [View Documents]  [Sync Now] (if connectorId + not error)         │
├──────────────────────────────────────────────────────────────────────┤
│  Danger Zone:                                                        │
│    [Delete Source] → confirm dialog                                  │
└──────────────────────────────────────────────────────────────────────┘
```

### API Source — Current Behavior (Preserve As-Is)

```
┌──────────────────────────────────────────────── SlidePanel (640px) ──┐
│  Header: source name + status badge                                  │
├──────────────────────────────────────────────────────────────────────┤
│  Overview:                                                           │
│    Documents: 567    Last sync: May 12, 1:15 PM                     │
│                                                                      │
│  Configuration:                                                      │
│    URL: https://api.example.com/data                                 │
│    Method: GET                                                       │
│    Auth type: Bearer                                                 │
│                                                                      │
│  Actions:                                                            │
│    [View Documents]  [Sync Now] (if connectorId)                     │
├──────────────────────────────────────────────────────────────────────┤
│  Danger Zone:                                                        │
│    [Delete Source] → confirm dialog                                  │
└──────────────────────────────────────────────────────────────────────┘
```

### SharePoint Source — Current Behavior (Preserve As-Is)

SharePoint sources use a completely separate panel (`SharePointDetailPanel`) opened via `useConnectorStore.openPanel()`. This panel has its own tabbed UI (Overview, Connect, Sites, Sync, Settings). **USP does not touch this path at all.**

### Enterprise Connector (Non-SharePoint) — Current Behavior (Preserve As-Is)

Non-SharePoint enterprise connectors use `ConnectorDetailPanel` which shows connection status, sync controls (start/pause/resume), filter configuration, and permission mode. **USP does not touch this path at all.**

### Non-Regression Scenarios

These scenarios verify that USP changes do NOT break non-web source behavior:

#### Scenario NR-1: Manual Source Click → SourceDetailPanel (Slide Panel)

```
User has a "Manual Upload" source in KB sources table
  → Clicks the source row
  → SourceDetailPanel opens as slide panel (640px, right side)
  → Shows KPI cards, file type breakdown, processing status, recent activity
  → [Upload Files] and [View Documents] actions available
  → [Delete Source] in danger zone

MUST NOT:
  → Navigate to a full page
  → Open CrawlFlowV5
  → Show crawl-related tabs (Pages/History/Settings)
```

#### Scenario NR-2: Database Source Click → SourceDetailPanel (Slide Panel)

```
User has a "Database" source with status 'active'
  → Clicks the source row
  → SourceDetailPanel opens as slide panel
  → Shows overview (doc count, last sync)
  → Shows configuration (masked connection string, collection, query)
  → Shows "Sync is managed automatically" if no connectorId

User has a "Database" source with status 'error'
  → Error section visible: sync error message, timestamp, [Retry Sync] button
  → Error section has orange/red border + warning icon

MUST NOT:
  → Navigate to a full page
  → Show web source tabs or crawl actions
```

#### Scenario NR-3: API Source Click → SourceDetailPanel (Slide Panel)

```
User has an "API" source with status 'active'
  → Clicks the source row
  → SourceDetailPanel opens as slide panel
  → Shows overview (doc count, last sync)
  → Shows configuration (URL, method, auth type)
  → Actions: [View Documents], [Sync Now] if connectorId present

MUST NOT:
  → Navigate to a full page
  → Show crawl-related UI elements
```

#### Scenario NR-4: SharePoint Source Click → SharePointDetailPanel

```
User has a "SharePoint" source with connectorId in connectorMap
  → Clicks the source row
  → SharePointDetailPanel opens (via useConnectorStore.openPanel)
  → Panel has its own tabs: Overview, Connect, Sites, Sync, Settings
  → Completely independent of SourceDetailPanel

MUST NOT:
  → Open SourceDetailPanel
  → Navigate to USP
  → Break connector store state
```

#### Scenario NR-5: Enterprise Connector Click → ConnectorDetailPanel

```
User has a non-SharePoint enterprise connector source
  → connectorMap[sourceId] returns a connectorId
  → Clicks the source row
  → ConnectorDetailPanel opens as slide panel
  → Shows connection status, sync controls, filter config, permission mode

MUST NOT:
  → Open SourceDetailPanel
  → Navigate to USP
```

#### Scenario NR-6: Manual Source — Empty State → Upload Flow

```
User has a "Manual" source with 0 documents
  → Clicks the source row → SourceDetailPanel opens
  → Shows dashed upload zone with [Upload Files] CTA
  → Click [Upload Files] → closes panel, triggers onUploadFiles callback
  → Upload dialog opens (handled by parent)

MUST NOT:
  → Show "Start Crawl" CTA (that's web-only)
  → Navigate to USP
```

#### Scenario NR-7: Mixed Source Types in Same KB

```
KB has: Manual (2), Web (3), Database (1), SharePoint (1)
  → All show in SourcesTable with correct status badges
  → Click Manual → SourceDetailPanel (slide)
  → Click Web (configuring) → CrawlFlowV5 (wizard)
  → Click Web (active) → Unified Source Page (full page) ← ONLY change
  → Click Database → SourceDetailPanel (slide)
  → Click SharePoint → SharePointDetailPanel (store)
  → Each click path is independent — no state leaks between panels

Health summary bar shows all source types:
  → "7 total · 4 active · 1 syncing · 1 error · 1 pending"
  → Counts include ALL source types, not just web
```

#### Scenario NR-8: Source Table Bulk Actions — All Source Types

```
User selects mix of Manual + Web + Database sources via checkboxes
  → BulkActionsToolbar appears
  → Delete action works for all selected types
  → SP-specific actions (re-auth, schedule, export) only appear if allAreSP

MUST NOT:
  → Treat web sources differently in bulk actions
  → Break bulk delete for non-web sources
```

#### Scenario NR-9: Source Table Status Display — All Source Types

```
Status variant map in SourcesTable handles ALL statuses:
  active → success (green)
  awaiting_auth → warning (amber)
  configuring → default (gray)
  draft → default (gray, legacy)
  pending → default (gray)
  syncing → info (blue)
  crawling → info (blue)
  partial → warning (amber)
  disabled → default (gray)
  error → error (red)
  auth_failed → error (red)

All source types render through same status badge.
Non-web sources can have: active, pending, syncing, error, disabled
Web sources can additionally have: configuring, crawling

MUST NOT:
  → Remove any existing status variant
  → Change variant colors for non-web statuses
  → Break pulsing dot for syncing (non-web sync progress)
```

#### Scenario NR-10: Delete Source — All Types Cascade Correctly

```
Delete a Manual source:
  → deleteSource(indexId, sourceId) called
  → Documents removed, source removed
  → No SourceConfigState/SourceUrlBucket to clean (web-only)

Delete a Database source:
  → deleteSource(indexId, sourceId) called
  → Same cascade as manual

Delete a SharePoint source:
  → deleteConnector(indexId, connectorId) called instead
  → Cleans up connector + source + OAuth tokens
  → Closes SharePointDetailPanel if open

Delete a Web source:
  → deleteSource(indexId, sourceId) called
  → Backend cascades: SourceConfigState + SourceUrlBucket deleted (sources.ts lines 326-339)
  → CrawlJobs remain (have their own 90-day TTL)

MUST NOT:
  → Use connector delete path for non-connector sources
  → Miss cascade for web-specific transient data
  → Leave orphaned SourceConfigState/SourceUrlBucket
```

---

## What Changes from Current UI

### Components to Replace

| Current Component                 | Replacement                     | Notes                                      |
| --------------------------------- | ------------------------------- | ------------------------------------------ |
| `SourceDetailPanel` (web sources) | Unified Source Page             | Slide panel → full page with URL route     |
| `CrawlJobProgress`                | Status Strip + Live Pages table | Progress component merged into page zones  |
| `State4Crawl` (CrawlFlowV5 step)  | USP takes over post-submission  | CrawlFlowV5 submits, then navigates to USP |
| Progress tab in SourceDetailPanel | Eliminated                      | Pages tab IS the progress                  |

### Components Preserved (relocated)

| Capability                       | Current Location               | New Location                                |
| -------------------------------- | ------------------------------ | ------------------------------------------- |
| Live WebSocket progress          | `useCrawlProgress` hook        | Same hook → Status Strip + Pages live table |
| REST polling fallback            | `getCrawlDashboard`            | Same API → Status Strip fallback            |
| Per-page view with search/filter | `CrawledPagesView`             | Pages tab (enhanced with live updates)      |
| Crawl history with recrawl       | `CrawlJobHistory`              | History tab                                 |
| Cancel crawl                     | `State4Crawl` actions          | Actions Bar + ConfirmDialog                 |
| Source deletion                  | `SourceDetailPanel` overview   | Settings tab Danger Zone                    |
| Page retry/delete/view           | `CrawledPagesView` row actions | Pages tab per-row actions                   |

### Components Unchanged

| Component                             | Why                                                            |
| ------------------------------------- | -------------------------------------------------------------- |
| `SourceDetailPanel` (non-web sources) | File, Database, API, SharePoint keep slide panel for now       |
| `CrawlFlowV5` (wizard)                | Still handles Steps 1-3 (URL entry → analysis → configure)     |
| `SourcesTable` / `SourcesCardGrid`    | Entry point — updated row states, click → USP instead of panel |
| `ConnectorDetailPanel`                | Enterprise connectors unaffected                               |

### New Route Required

Currently no URL-addressable source detail page exists. USP needs:

```
/searchai/{kbId}/sources/{sourceId}
```

This is a **new Next.js route** — the biggest architectural change. Current source detail is a `SlidePanel` opened via state, not URL navigation.

---

## Data Point → Zone Matrix

Every data point maps to its SINGLE zone. If a data point appears in more than one zone, it's intentional duplication documented below.

| Data Point                | Status Strip      | Pages Tab          | History Tab      | Settings Tab       | Actions Bar | Header         | Toast           |
| ------------------------- | ----------------- | ------------------ | ---------------- | ------------------ | ----------- | -------------- | --------------- |
| Pages crawled count       | ✓ (stats)         |                    |                  |                    |             |                | ✓ (summary)     |
| Documents created count   | ✓ (stats)         |                    |                  |                    |             |                |                 |
| Failed count              | ✓ (stats)         | ✓ (filter badge)   | ✓ (results col)  |                    |             |                | ✓ (if issues)   |
| Duration / Elapsed        | ✓ (stats)         |                    |                  |                    |             |                |                 |
| Queued count              | ✓ (crawling only) |                    |                  |                    |             |                |                 |
| Progress %                | ✓ (bar)           |                    |                  |                    |             |                |                 |
| ETA                       | ✓ (bar)           |                    |                  |                    |             |                |                 |
| Connection (Live/Polling) | ✓ (indicator)     |                    |                  |                    |             |                |                 |
| Quality %                 | ✓ (post-crawl)    |                    |                  |                    |             |                | ✓ (long crawl)  |
| Thin content count        | ✓ (quality bar)   | ✓ (filter badge)   |                  |                    |             |                | ✓ (if issues)   |
| Source status             |                   |                    |                  |                    |             | ✓ (badge)      |                 |
| Source URL / domain       |                   |                    |                  | ✓ (config)         |             | ✓ (breadcrumb) | ✓ (toast title) |
| Per-page URL              |                   | ✓ (row)            |                  |                    |             |                |                 |
| Per-page status           |                   | ✓ (row icon)       |                  |                    |             |                |                 |
| Per-page quality          |                   | ✓ (row badge)      |                  |                    |             |                |                 |
| Per-page method           |                   | ✓ (row badge)      |                  |                    |             |                |                 |
| Per-page chunks           |                   | ✓ (row count)      |                  |                    |             |                |                 |
| Error details             |                   | ✓ (grouping panel) |                  |                    |             |                |                 |
| Per-job status            |                   |                    | ✓ (status col)   |                    |             |                |                 |
| Per-job results           |                   |                    | ✓ (results col)  |                    |             |                |                 |
| Per-job strategy          |                   |                    | ✓ (strategy col) |                    |             |                |                 |
| Per-job timestamp         |                   |                    | ✓ (when col)     |                    |             |                |                 |
| Source config             |                   |                    |                  | ✓ (config panel)   |             |                |                 |
| Site profile              |                   |                    |                  | ✓ (profile panel)  |             |                |                 |
| Crawl settings            |                   |                    |                  | ✓ (settings panel) |             |                |                 |
| Sections                  |                   |                    |                  | ✓ (sections panel) |             |                |                 |
| Auth method               |                   |                    |                  | ✓ (auth panel)     |             |                |                 |
| Quality suggestions       | ✓ (post-crawl)    |                    |                  |                    |             |                |                 |

**Intentional overlaps** (not duplication — different purposes):

- **Failed count**: Stats shows total number, Pages filter badge enables click-to-filter, History results column shows per-job count. Three different interaction purposes.
- **Source URL**: Breadcrumb for navigation, Settings for configuration reference, Toast for identification. Three different contexts.
- **Thin content count**: Quality bar shows total, Pages filter badge enables filtering. Two different interaction purposes.

---

## Design Patterns Applied (from competitive research)

| Pattern                          | Source              | Where Applied                                     |
| -------------------------------- | ------------------- | ------------------------------------------------- |
| Live Results Table               | Firecrawl           | Pages tab during active crawl                     |
| Event-driven streaming           | Firecrawl           | WebSocket per-page events → table row updates     |
| "Done with Issues" third state   | AppMaster/Buildkite | Status Strip + header badge                       |
| Animated status dot              | Vercel              | Header badge, per-row status icons                |
| Contextual microcopy             | Algolia             | Status Strip progress text                        |
| Error grouping + actionable copy | LogRocket           | Pages tab error panel                             |
| Data quality suggestions         | Algolia             | Status Strip post-crawl suggestions               |
| Backscroll on join               | GitHub Actions      | Redis `progress:last:<jobId>` replay on page load |
| Toast on background completion   | LogRocket/AppMaster | Global toast system                               |
| Tilde-estimated totals           | Algolia             | "142 of ~300" — honest about unpredictable sizes  |

---

## Open Questions

1. **Non-web sources** (file, database, API, SharePoint): Keep in current SourceDetailPanel slide panel? Or future full-page treatment?
2. **Intelligence crawl details** (per-page decisions, LLM calls, method breakdown from `useMultiPageProgress`): Show as expandable per-row detail in Pages table, or simplify?
3. **Section fill visibility**: Show per-section mini progress bars somewhere during crawl, or is the live table sufficient?
4. **Quick recrawl vs Configure recrawl**: Always open CrawlFlowV5 with pre-fill, or offer a "same settings" quick action? (Journey 9)
5. **History filtering**: Currently client-side (fetches 100 jobs for entire index, filters by sourceId). Need server-side `?sourceId=` filter for scale?
