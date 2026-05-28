# Crawl V2 — High-Level Design

## What

Replace the broken Go bulk crawler with a Node.js bulk crawl worker that honours
discovery outcomes, emits real-time per-page progress, supports cooperative
cancellation, and is serverless-friendly. Fix the WebSocket progress path, wire
activity bar hydration, eliminate duplicate source creation, and add re-crawl
support. The Go crawler path is removed only after the Node.js replacement is
verified.

**Why now:** The Go crawler ignores every discovery outcome (sections, rendering
mode, robots.txt, URL boundaries), has a broken Redis pipe that loses results,
publishes progress to a channel nothing reads, and is not in this repository.
Meanwhile, the Node.js codebase already has every building block needed.

---

## Crawl Architecture Inventory

The platform has multiple crawl/fetch paths. V2 affects only the bulk crawl path (row 6→8).

| #   | Path                     | Framework                                                                        | Trigger                                    | V2 Action       |
| --- | ------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------ | --------------- |
| 1   | HTTP Discovery           | Node.js `fetch()` + regex link extraction                                        | State 2: sitemap/sitemapless URL discovery | Keep as-is      |
| 2   | Browser Discovery        | **Playwright** via `crawler-mcp-server`                                          | State 2: JS-heavy site exploration         | Keep as-is      |
| 3   | Site Profiling           | `safeFetch` + **Cheerio**                                                        | State 1→2: robots.txt, sitemap, site type  | Keep as-is      |
| 4   | Single-Page Analysis     | **Playwright** (MCP) + LLM                                                       | State 2: extraction quality analysis       | Keep as-is      |
| 5   | Intelligence Multi-Page  | **Axios** (`HttpAdapter`) + **Playwright** (MCP) + LLM                           | Multi-page crawl with handler reuse        | Keep as-is      |
| 6   | **Bulk Crawl (Go)**      | **Go binary** — recursive HTTP, Docker-only                                      | State 4: "Start Crawl" button              | **REMOVE (O9)** |
| 7   | Crawl Preview            | `safeFetch` + **Readability**                                                    | State 3: preview extraction quality        | Keep as-is      |
| 8   | **Bulk Crawl (Node.js)** | **Axios** (`HttpAdapter`) + **Playwright** (MCP) + **Cheerio** + **Readability** | State 4: replaces Go crawler               | **NEW (O1-O6)** |

**Frameworks used across crawl paths:**

- **Axios** — HTTP fetching via `HttpAdapter` (SSRF protection built-in)
- **Playwright** — Browser rendering via `crawler-mcp-server` (MCP protocol, separate process on port 3100)
- **Cheerio** — HTML parsing, template fingerprinting, quality scoring
- **Readability** (Mozilla) — Content extraction from HTML
- **Go binary** — External Docker image, recursive HTTP crawler → **being removed**

**Not used:** Puppeteer, `node-fetch`, `got`

**Also in the platform (not web crawling, out of scope):**

- Connector sync workers (SharePoint, Zendesk, ServiceNow) — fetch from SaaS APIs
- IdP sync workers (Azure AD, Okta, Google) — fetch users/groups
- Schema discovery services — fetch metadata from external APIs
- Docling extraction — sends documents to Python service for structured extraction

---

## Architecture Approach

### Packages That Change

| Package             | What Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai`    | New `bulk-crawl-worker.ts`, new `bulk-crawl` BullMQ queue, updated batch route (accept crawlSettings, per-section strategy, draftId; skip sitemap re-expansion for explicit lists), cooperative cancel via Redis signal + BullMQ job removal, `cluster-urls` stores full URL lists to buckets (D13), robots.txt enforcement, CrawlJob TTL index, remove Go dead code (O9)                                                                                         |
| `apps/studio`       | Fix `useCrawlProgress` WS auth (add `?token=`), fix duplicate source creation in `CrawlFlowV5` (D3), wire all 6 config settings to `submitBatchCrawl`, `handleStartCrawl` reads full URLs from buckets (D13), remove scope/maxPages/maxDepth from State 3 (D7), propagate per-section strategy (D12), wire activity bar hydration on mount (D4), add "Resume" action to activity bar, add KB banner for active crawls, browser discovery persists URLs to buckets |
| `packages/crawler`  | **Extend** existing `robots-analyzer.ts` (already wraps `robots-parser`, has `analyzeRobotsTxt()`) with a cached `isUrlAllowed()` method for runtime enforcement. New `domain-rate-limiter.ts` (token bucket). New `url_skipped` event type in `progress.ts`. These are standalone modules used by the bulk worker — NOT in HttpAdapter.                                                                                                                          |
| `packages/database` | CrawlJob TTL index (90-day), add `strategy` field to `ICrawlDraftSection`, add `sectionMapping` to CrawlJob configuration, CrawlHistory cleanup cron config                                                                                                                                                                                                                                                                                                       |

### Data Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│  STUDIO (apps/studio)                                                │
│                                                                      │
│  State 2: Analysis                                                   │
│       │  /cluster-urls returns groups (count + 10 examples)          │
│       │  V2 FIX (D13): endpoint also stores FULL URL lists           │
│       │  into CrawlDraftUrlBucket (server-side, per section)         │
│       │                                                              │
│       ▼                                                              │
│  State 3: Configure                                                  │
│       │  V2 FIX (D7): Remove scope/maxPages/maxDepth                │
│       │  V2 FIX: Wire all 6 config settings to backend              │
│       │  V2 FIX (D3): Remove orphan addSource in handleContinue     │
│       │                                                              │
│       ▼                                                              │
│  handleStartCrawl():                                                 │
│       │  1. Read FULL URLs from buckets (D13 — primary path)         │
│       │     getSectionUrls(draftId, sid, {limit:50000})              │
│       │  2. Create ONE source (D3 — only source creation)            │
│       │  3. POST /api/crawl/batch with:                              │
│       │     - ALL URLs (from buckets, not examples)                  │
│       │     - Per-section strategy (D12)                             │
│       │     - All crawlSettings (D7)                                 │
│       │     - draftId (for worker → draft update, D10)               │
│       │                                         │                    │
│       │                                         ▼                    │
│  State 4: Progress ◄──── WebSocket ◄─── Redis pub/sub               │
│       │    ┌─────────────┐                progress:{jobId}           │
│       │    │ useCrawl    │◄── ws://.../subscribe?jobId=X&token=Y    │
│       │    │ Progress    │    V2 FIX: ?token= added (D2)             │
│       │    └─────────────┘                                           │
│       │                                                              │
│  Activity Bar ◄── V2: hydrate on mount via GET /crawl-drafts/active  │
│       │              + poll running crawls every 30s                  │
│       │              + "Resume" action → reopen crawl flow            │
│       │                                                              │
│  KB Detail ◄── banner: "Crawl in progress: 45/226 pages"             │
└──────────────────────────────────────────────────────────────────────┘
         │ cancel                        ▲ progress events
         ▼                               │
┌──────────────────────────────────────────────────────────────────────┐
│  SEARCH-AI (apps/search-ai)                                         │
│                                                                      │
│  POST /batch (MODIFIED):                                             │
│    - Accept crawlSettings, per-section strategy, draftId             │
│    - V2 FIX: Skip sitemap re-expansion for explicit URL lists        │
│    - Create CrawlJob (status: queued)                                │
│    - Enqueue on 'bulk-crawl' queue (replaces 'static-crawl')         │
│                                                                      │
│  POST /cancel (EXISTING + V2 ENHANCED):                              │
│    - Update MongoDB status → 'cancelled'                             │
│    - V2 NEW: SET crawl:cancel:{jobId} in Redis (1h TTL)              │
│    - V2 NEW: Remove BullMQ job from queue if still queued            │
│                       │                                              │
│                       ▼                                              │
│  ┌───────────────────────────────────────────────────────┐           │
│  │  bulk-crawl-worker.ts (NEW)                           │           │
│  │                                                       │           │
│  │  Sliding window of 5 concurrent fetches per job:      │           │
│  │  for each URL:                                        │           │
│  │    1. Check cancel signal (Redis GET <1ms)            │           │
│  │    2. Check robots.txt (cached per domain, D6)        │           │
│  │    3. Rate limit (per-domain token bucket)            │           │
│  │    4. Fetch: HTTP or Playwright (per-section, D12)    │           │
│  │    5. Extract: HandlerReuser → Readability (D14)       │           │
│  │    6. Quality gate (always ingest, mark thin, D8)     │           │
│  │    7. Ingest via crawlerIngestionService              │           │
│  │    8. Checkpoint to Redis                             │           │
│  │    9. publishProgressEvent(url_fetched + section)     │           │
│  │   10. publishProgressEvent(document_processed)        │           │
│  │                                                       │           │
│  │  On complete/fail/cancel:                             │           │
│  │    - Update CrawlJob to terminal status               │           │
│  │    - Update CrawlDraft.flowState → 'completed' (D10)  │           │
│  │    - Emit job_completed with comparison summary        │           │
│  │                                                       │           │
│  │  Crash recovery: Redis checkpoints + SearchDoc exist  │           │
│  └───────────────────────────────────────────────────────┘           │
│                       │                                              │
│                       ▼                                              │
│  crawlerIngestionService ──► SearchDocument ──► Docling queue        │
└──────────────────────────────────────────────────────────────────────┘
```

### Key Integration Points

1. **Cluster-urls → URL buckets (D13)**: `POST /api/crawl/cluster-urls?draftId=X` stores full URL lists per group into `CrawlDraftUrlBucket` documents after clustering. Frontend reads 10 examples; buckets hold all URLs.
2. **handleStartCrawl → buckets**: `getSectionUrls(draftId, sectionId, { limit: 50000 })` reads full URLs from buckets as primary path.
3. **Batch route → new queue**: `POST /api/crawl/batch` creates CrawlJob + enqueues on `bulk-crawl` (replaces `static-crawl`). V2: accepts `crawlSettings`, per-section `strategy`, `draftId`. V2: skips sitemap re-expansion when explicit URL list provided (> 1 URL). **V2 critical fix: forward `sectionMapping` in BullMQ job data** (currently only stored in CrawlJob MongoDB — worker never receives it).
4. **Worker → ingestion**: Reuses `crawlerIngestionService.ingestCrawledContent()` — same 12-step pipeline
5. **Worker → progress**: Reuses `publishProgressEvent()` on `progress:{jobId}` Redis channel. V2: adds `data.section` field for section fill rates.
6. **Worker → draft**: On completion, worker updates `CrawlDraft.flowState → 'completed'` via direct Mongoose call (D10).
7. **WS server → Studio**: Existing `initProgressWebSocket` at `/api/admin/progress/subscribe`. V2: `useCrawlProgress` adds `?token=` to WS URL (D2 fix).
8. **Cancel signal**: `POST /api/crawl/jobs/:jobId/cancel` (existing) — V2: also sets `crawl:cancel:{jobId}` in Redis (1h TTL) + removes BullMQ job from queue if still queued.
9. **Activity bar → drafts API**: `GET /api/crawl-drafts/active?indexId=X` returns drafts with `flowState: 'submitted'` + CrawlJob progress. Called on mount for hydration (D4). Activity bar has "Resume" action to reopen crawl flow.
10. **Browser discovery → buckets**: `BrowserDiscoveryInline` and `ExplorePanel` call `putSectionUrls()` after building sections (currently missing — V2 fix).

---

## Decisions & Tradeoffs

### D1: Single worker with per-URL concurrency vs fan-out sub-jobs

**Chose:** Single BullMQ worker processing URLs with a **sliding window** of 5 concurrent fetches per job. As each URL completes (success or fail), the next URL starts immediately — no waiting for a batch of 5 to finish.

**Concurrency model:**

```typescript
// Sliding window — NOT Promise.allSettled batches
const WINDOW_SIZE = 5;
const activeSet = new Set<Promise<void>>();

for (const url of urls) {
  if (cancelled) break;
  if (activeSet.size >= WINDOW_SIZE) {
    await Promise.race(activeSet); // wait for ANY to finish
  }
  const p = processUrl(url).finally(() => activeSet.delete(p));
  activeSet.add(p);
}
await Promise.allSettled(activeSet); // drain remaining
```

**Per-tenant concurrency cap** via Redis semaphore (prevents one tenant from monopolizing workers):

```
Key pattern:    crawl:tenant-sem:{tenantId}
Type:           Redis INCR/DECR with TTL safety
Max value:      20 (concurrent page fetches across ALL jobs for one tenant)
Acquire:        INCR key → if > 20, DECR and wait 1s, retry up to 30 times
Release:        DECR key (in finally block of each page fetch)
TTL safety:     SET key TTL 120s on every INCR (2× worst-case page timeout of 60s)
                On crash: at most 5 phantom slots (sliding window size), cleared within 120s
When limit hit: Backpressure — the URL waits in the sliding window until a slot opens
```

**BullMQ retry configuration:**

```
Retry attempts: 3
Backoff:        exponential, base delay 60s (60s → 120s → 240s)
Job timeout:    60 minutes (maxStalledCount: 1)
```

**Invariant (O6 — never lose work):** Semaphore TTL (120s) < first retry delay (60s) is
**not strictly met**, but the impact is bounded: a crashed worker holds at most 5 slots
(sliding window size, not all 20), and those phantom slots expire within 120s. By the time
the exponential backoff fires the first retry at 60s, only 5 slots are temporarily stuck.
By the second retry at 120s, all phantom slots have expired. The 20-slot cap is never
permanently exhausted.

**Why:** The intelligence-crawl-worker already proves this pattern works at concurrency 1. Fan-out (one BullMQ job per URL) adds coordination complexity (tracking parent job, aggregating results, partial failure semantics) without benefit — the bottleneck is the target server's rate limit, not our worker throughput.

**Tradeoff:** A single stuck URL blocks one of 5 slots for up to `PAGE_TIMEOUT` (60s). Acceptable because cancel is cooperative, timeout is bounded, and the other 4 slots continue processing.

### D2: Reuse `useCrawlProgress` hook vs merge into `useMultiPageProgress`

**Chose:** Keep both hooks but fix `useCrawlProgress` to pass `?token=` and connect directly to SearchAI in dev mode. The bulk worker emits the same `ProgressEvent` types that `useCrawlProgress` already handles (`job_started`, `url_fetched`, `document_processed`, `job_completed`, `job_failed`).

**Why:** `useMultiPageProgress` handles intelligence-specific events (`intelligence_page_started`, etc.) with a different state shape (per-page progress map, group progress). Merging would require a discriminated union that adds complexity for no user benefit. State4Crawl already uses both hooks — it just needs the bulk events to actually arrive.

**Tradeoff:** Two WebSocket connections per crawl view. The WS server already handles this (line 270 — per-client Redis subscriber). Future optimization: single connection with event type routing.

### D3: Draft → Source lifecycle — fix duplicate

**Chose:** Remove the fire-and-forget `addSource()` call in `handleContinue` (State 2→3 transition, line 599-609). Create the source ONCE in `handleStartCrawl` (State 3→4), storing `sourceId` in the draft. The draft IS the source identity during configuration.

**Why:** Currently, `handleContinue` creates a `web_crawl` source that is never used, and `handleStartCrawl` creates a second `web` source. This leaves orphaned sources. A draft already has a 30-day TTL and carries all configuration — it is the pre-source identity.

### D4: Activity bar hydration — server-side vs client-side

**Chose:** Server-side hydration via a new `GET /api/crawl-drafts/active` endpoint that returns drafts with `flowState: 'submitted'` + their associated CrawlJob status. Called once on mount.

**Why:** The Zustand store is ephemeral (page refresh = empty). The drafts API already exists with tenant-scoped queries. Adding a filtered endpoint is minimal work. Client-side (localStorage) would duplicate data and drift from server state.

### D5: CrawlJob retention — unbounded vs TTL

**Chose:** 90-day TTL via MongoDB TTL index on `timeline.completedAt`. Jobs in terminal states (`completed`, `failed`, `cancelled`) are auto-deleted after 90 days. Running jobs (`queued`, `crawling`, `ingesting`) are never deleted by TTL (no `completedAt` field).

**Why:** CrawlJobs are currently unbounded. For SaaS, every tenant accumulates jobs forever. 90 days gives enough history for re-crawl comparison (O8) and audit needs. The `CrawlJobHistory` UI already supports pagination.

### D6: Robots.txt — runtime enforcement vs build-time filtering

**Chose:** Runtime enforcement. Before each URL fetch, check `isAllowed(url, userAgent)` via cached `robots-parser` instance per domain. Cache TTL: 1 hour.

**Why:** Build-time filtering (during discovery) would require re-running robots.txt checks if the user re-crawls later with different settings. Runtime enforcement is simpler and always correct. The `robots-parser` npm package is well-maintained (1M+ weekly downloads).

### D7: State 3 redesign — HOW to crawl, not WHAT

**Insight:** By State 3, the user has already decided WHAT to crawl (selected sections
with explicit URLs in State 2). State 3 should only control HOW — politeness, extraction
quality, and compliance. Three settings are leftover from the recursive crawling era
and are now meaningless:

**Settings audit:**

| Setting                              | V1 Purpose                      | V2 Action       | Rationale                                                                                                                                                         |
| ------------------------------------ | ------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope` (Limited/Full/Custom)        | Cap recursive crawl depth       | **REMOVE**      | URL list is explicit from section selection. User already picked 210 pages — "limit to 1000" is nonsensical.                                                      |
| `maxPages` (locked at 1000)          | Hard cap on recursive discovery | **REMOVE**      | Page count = selected section URLs. The number is shown as a read-only summary, not a control.                                                                    |
| `maxDepth` (1-20)                    | Link-following hops             | **REMOVE**      | No link-following in explicit URL mode.                                                                                                                           |
| `rendering` (HTTP/Browser/Adaptive)  | Global override                 | **RETHINK**     | Per-section strategy was auto-detected in State 2. Default = "Use detected" (smart). Keep as override for power users who want to force HTTP or Browser globally. |
| `requestDelay` (200-5000ms)          | Not wired                       | **KEEP + WIRE** | User controls politeness. Wire as `crawlSettings.crawlDelay`.                                                                                                     |
| `respectRobotsTxt`                   | Not wired                       | **KEEP + WIRE** | User controls compliance. Wire as `crawlSettings.respectRobotsTxt`.                                                                                               |
| `learnedPatterns` (keep/reset)       | Not wired                       | **KEEP + WIRE** | Controls handler reuse. `reset` = extract fresh, ignoring discovery templates. Wire as `crawlSettings.reuseHandlers`.                                             |
| `cleanup` (standard/aggressive/none) | Not wired                       | **KEEP + WIRE** | Extraction aggressiveness. Wire as `crawlSettings.cleanupLevel`.                                                                                                  |
| `deduplicate`                        | Not wired                       | **KEEP + WIRE** | Re-crawl dedup behavior. Wire as `crawlSettings.deduplicate`.                                                                                                     |
| `cookieConsent`                      | Not wired                       | **KEEP + WIRE** | Auto-dismiss for Playwright pages. Wire as `crawlSettings.cookieConsent`.                                                                                         |

**State 3 new layout (V2):**

```
State 3 has TWO purposes:
  1. REVIEW what will be crawled (read-only summary from State 2)
  2. CONFIGURE how to crawl (execution settings)

┌─────────────────────────────────────────────────────┐
│  ┌─ CRAWL SUMMARY (read-only) ────────────────────┐ │
│  │  210 pages from 2 sections                     │ │
│  │  /products: 142 pages (HTTP)                   │ │
│  │  /support:   68 pages (Playwright)             │ │
│  │  Est. time: ~7 min                             │ │
│  │                             [← Edit Sections]  │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  ┌─ CRAWL SETTINGS ──────────────────────────────┐  │
│  │  Strategy                                     │  │
│  │    Rendering: [Auto-detected ▾]  ← smart      │  │
│  │    Patterns:  [Keep ● Reset]                  │  │
│  │    Speed:     [====●=====] 1000ms             │  │
│  │                                               │  │
│  │  Compliance                                   │  │
│  │    Robots.txt: [Respect ● Ignore]             │  │
│  │                                               │  │
│  │  Content                                      │  │
│  │    Cleanup:  [Standard ▾]                     │  │
│  │    Dedup:    [On ● Off]                       │  │
│  │    Cookies:  [Auto-dismiss ● Ignore]          │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  V2 NEW: Re-crawl context (if previous job):        │
│  ┌────────────────────────────────────────────────┐  │
│  │ ℹ️ Last crawled: 3 days ago (226 pages)        │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  [← Back]                        [Start Crawl →]   │
└─────────────────────────────────────────────────────┘
```

**Key change:** Scope/maxPages/maxDepth are gone. The page count is a read-only
summary derived from section selection. The "Edit Sections" link takes the user
back to State 2 if they want to change what's crawled.

### D12: Per-section rendering strategy propagation

**Problem:** Discovery correctly identifies which sections need HTTP vs Playwright (via
`FailureScorer` + `QualityGate` in `/sample-groups`), returning `GroupStrategy.method`
per URL group. But this per-section intelligence is **lost** before reaching the worker:

```
Current (broken):
  GroupStrategy.method='playwright'  →  warnings.push('tabs, accordions')  →  LOST
  CrawlSection has NO strategy field
  CrawlDraft has NO strategy field
  handleStartCrawl sends ONE global strategy: 'smart'
  Worker applies same rendering to ALL URLs
```

**Chose:** Propagate per-section strategy end-to-end:

```
V2 (fixed):
  /sample-groups → GroupStrategy{ method: 'http'|'playwright' } per group
       ↓
  mapGroupsToSections() → CrawlSection{ strategy: 'http'|'browser' }   ← NEW FIELD
       ↓
  CrawlDraft.sections[].strategy: 'http'|'browser'                     ← NEW FIELD
       ↓
  BatchCrawlRequest.sectionMapping[].strategy: 'http'|'browser'        ← NEW FIELD
       ↓
  CrawlJob stores sectionMapping in configuration                      ← STORED
       ↓
  Worker reads section strategy per URL: use HttpAdapter or Playwright MCP
```

**Type changes required:**

| Type                                 | Package                                  | Change                              |
| ------------------------------------ | ---------------------------------------- | ----------------------------------- |
| `CrawlSection`                       | `apps/studio` types.ts                   | Add `strategy: 'http' \| 'browser'` |
| `ICrawlDraftSection`                 | `packages/database` crawl-draft.model.ts | Add `strategy: 'http' \| 'browser'` |
| `BatchCrawlRequest.sectionMapping[]` | API contract                             | Add `strategy: 'http' \| 'browser'` |
| `CrawlJob.configuration`             | `packages/database` crawl-job.model.ts   | Add `sectionMapping` array          |

**Worker rendering decision:** For each URL, look up which section it belongs to (via
URL prefix match against `sectionMapping[].pattern`). Use that section's `strategy`.
Fallback: if URL matches no section, use HTTP (safer default).

**UI impact:** State 3 read-only summary shows strategy per section: "/products: 142 pages (HTTP)" and "/support: 68 pages (Playwright)". The global "Rendering" dropdown becomes an override: "Auto-detected" (use per-section), "Force HTTP", "Force Playwright".

### D13: Full URL storage — server-side bucket persistence

**Problem:** Discovery finds 142 URLs for a section but `UrlClusterer` only returns 10 examples per group (`MAX_EXAMPLES = 10`). The full URL list is discarded in memory. The user sees "142 pages" but only ~10 get crawled. **This is the most critical data loss bug in the entire flow.**

```
Current (broken):
  /cluster-urls endpoint:
    1. Fetches sitemap → finds 142 URLs for /products pattern
    2. UrlClusterer.cluster() → groups by pattern
    3. Returns { count: 142, examples: [10 URLs] }   ← 132 URLs DISCARDED
    4. Full URL list exists transiently in urlsToCluster → GARBAGE COLLECTED

  Frontend mapGroupsToSections():
    section.pages = g.examples → [10 URLs]
    section.pageCount = g.count → 142  ← MISMATCH

  persistSectionUrls():
    Stores section.pages → [10 URLs] into URL buckets
    (Bucket infra supports 50K/section — just never given the data)

  handleStartCrawl():
    Reads section.pages → [10 URLs]
    submitBatchCrawl({ urls: [~10 URLs] })  ← USER EXPECTS 142
```

**Chose:** Server-side bucket storage. The `cluster-urls` endpoint stores ALL URLs per group directly into `CrawlDraftUrlBucket` documents. `handleStartCrawl` reads from buckets as primary path.

```
V2 (fixed):
  /cluster-urls endpoint (MODIFIED — requires draftId param):
    1. Fetches sitemap → finds 142 URLs for /products pattern
    2. UrlClusterer.cluster() → groups by pattern
    3. NEW: Before discarding, write full URL lists to buckets:
       For each group → PUT /api/crawl-drafts/:draftId/sections/:sectionId/urls
       (500 URLs per bucket document, supports up to 50K per section)
    4. Returns { count: 142, examples: [10 URLs] } (response unchanged)

  Frontend mapGroupsToSections():
    section.pages = g.examples → [10 URLs for display only]
    section.pageCount = g.count → 142

  handleStartCrawl() (MODIFIED — bucket-first):
    1. PRIMARY: For each included section:
       const result = await getSectionUrls(draftId, sectionId, { limit: 50000 });
       allUrls.push(...result.urls.map(u => u.url));
    2. FALLBACK (if buckets empty): section.pages → examples
    3. submitBatchCrawl({ urls: [all 142 + 68 = 210 URLs] })

  Browser discovery (MODIFIED — also persist):
    BrowserDiscoveryInline / ExplorePanel:
    After building sections, call putSectionUrls() for each section
    (Currently neither calls putSectionUrls — URLs are lost on page refresh)
```

**API change:** `POST /api/crawl/cluster-urls` gains an optional `draftId` query param. When present, the endpoint stores full URL lists into buckets after clustering. When absent (backward compat), behavior unchanged.

**Why server-side (not return full URLs in response):**

- Sitemap may have 10,000+ URLs. Returning all in HTTP response = 1MB+ payload.
- Bucket infra already exists, handles pagination, supports 50K per section.
- Browser memory stays small (10 examples per section for display).
- `handleStartCrawl` already has a `getSectionUrls` fallback — just needs to be primary.

### D8: Quality gate policy — ingest vs reject

**Chose:** Always ingest, mark quality. Pages that fail quality gate are ingested
with `quality: 'thin'` in metadata. They appear in the "Thin content" count in the
completion summary and are searchable but ranked lower.

**Why:** Rejecting pages means data loss. The user chose those URLs during discovery
— they expect to see them in results. "Thin" content is better than missing content.
The quality score is visible in SourceDetailPanel → Pages tab, so users can identify
and address thin content later.

### D9: Playwright via MCP in bulk worker

**Chose:** The bulk worker creates an MCP client connection to `crawler-mcp-server`
(same pattern as intelligence-crawl-worker). For jobs with browser-rendered pages,
one MCP connection is opened at job start, reused across all Playwright pages in the
batch, and closed in the finally block.

**Why:** MCP connection is stateful (browser context). Opening one per page would be
expensive. One per job amortizes the cost. The connection has a `MAX_MCP_LINKS_PER_BATCH`
limit (50 links) matching the intelligence worker.

**Tradeoff:** MCP connection is not serverless-friendly. For future Lambda extraction,
browser pages would need a headless Chrome layer (Playwright in Lambda) instead of MCP.
This is acceptable — MVP is BullMQ worker; serverless refactor is future work.

### D14: Handler template seeding — how templates reach the bulk worker

**Problem:** O1 requires "handler templates (from intelligence analysis of samples) → apply
handler for extraction when available." The worker step 5 says "HandlerReuser → Readability"
but doesn't specify where templates come from or how they're loaded.

**Existing infrastructure (already built):**

| Component               | Location                                                                 | Purpose                                                                           |
| ----------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `HandlerReuser`         | `packages/crawler/src/intelligence/algorithms/handler-reuser.ts`         | In-memory library of template→handler pairs (Map, 1hr TTL, max 1000 entries)      |
| `MongoHandlerStore`     | `packages/crawler/src/intelligence/handler-store/mongo-handler-store.ts` | MongoDB persistence — `handler_templates` collection (90-day TTL on `lastUsedAt`) |
| `HandlerTemplate` model | `packages/database/src/models/handler-template.model.ts`                 | Schema: `{tenantId, domain, fingerprint, handler, trainedOn, confidence}`         |
| `TemplateFingerprinter` | `packages/crawler/src/intelligence/algorithms/template-fingerprinter.ts` | SimHash-based HTML structure fingerprinting (Hamming distance ≤ 3 for match)      |

**How templates get created (during discovery, State 2):**

```
intelligence-crawl-worker processes sample page →
  CrawlIntelligenceService.execute() Phase 3 (BUILD HANDLER) →
    1. handlerReuser.registerHandler(fingerprint, handler, [sampleUrl])  ← in-memory
    2. handlerStore.saveHandler({tenantId, domain, fingerprint, handler})  ← MongoDB
```

**Chose: Same pattern as intelligence-crawl-worker (proven, zero new infrastructure)**

The bulk-crawl-worker seeds `HandlerReuser` from MongoDB at job start:

```typescript
// bulk-crawl-worker.ts — at job start, before processing URLs:
const store = getHandlerStore(); // process-level lazy singleton (MongoHandlerStore)
const reuser = getHandlerReuser(); // process-level lazy singleton (HandlerReuser)
const fingerprinter = getFingerprinter(); // process-level lazy singleton

// Seed from MongoDB — same pattern as intelligence-crawl-worker lines 319-332
const templates = await store.findByDomain(tenantId, domain);
for (const t of templates) {
  const fp = TemplateFingerprinter.fromSerializable(t.fingerprint); // hex → bigint
  reuser.registerHandler(fp.fingerprint, t.handler, t.trainedOn);
}

// Per-URL extraction (step 5):
const match = reuser.tryReuse(html);
if (match.matched) {
  // Use handler's extractionSelectors — 0 LLM calls, skips Phase 2+3
  content = applyHandler(match.handler, html);
  await store.recordSuccess(tenantId, domain, match.fingerprint);
} else {
  // Readability fallback — still 0 LLM calls
  content = readability.parse(html);
}
```

**Why NOT pass templates in job data:** Templates can be large (extraction selectors, Playwright steps). Serializing them into BullMQ job data adds payload bloat and staleness risk (templates updated between enqueue and processing). MongoDB read at job start is <50ms and always fresh.

**Data flow:** Discovery (State 2) → MongoDB `handler_templates` → Bulk worker seeds at job start → per-URL `tryReuse()` → handler extraction or Readability fallback.

### D10: Draft post-completion lifecycle

**Chose:** After crawl completes (or fails/cancels), update draft `flowState` to
`'completed'`. Draft retains its 30-day TTL. It serves as re-crawl context — the
sections, settings, and crawl result are all accessible from the draft until it expires.

**Who updates:** The **bulk-crawl-worker** updates the draft in its `finally` block after updating the CrawlJob to a terminal status. The worker already has `draftId` in the job data (passed from `handleStartCrawl` via the batch route). Sequence:

```
Worker finally block:
  1. Update CrawlJob.status → 'completed'|'failed'|'cancelled'
  2. Update CrawlDraft.flowState → 'completed' via:
     PUT /api/crawl-drafts/:draftId (internal call, no auth — worker runs server-side)
     OR direct Mongoose update: CrawlDraft.updateOne({ _id: draftId }, { flowState: 'completed' })
  3. Emit job_completed/job_failed progress event
```

The worker uses direct Mongoose (not HTTP) since it runs in the same process as the SearchAI server. The `draftId` field is added to `BatchCrawlRequest` and stored in `CrawlJob.metadata.draftId`.

**Why:** Leaving drafts at `flowState: 'submitted'` forever makes the
`/api/crawl-drafts/active` endpoint return stale results. A terminal `flowState`
lets the activity bar hydration query filter correctly: `{ flowState: 'submitted' }` =
running crawls only.

### D11: Re-crawl dedup — content hash vs URL-only

**Chose:** URL + sourceId as primary dedup key, content hash (SHA-256) as change detection. `crawlerIngestionService` already computes content hash and checks for duplicates (step 6-7 of its pipeline).

**Why:** URL + sourceId dedup prevents duplicate documents. Content hash detects whether an existing document needs updating. Both are already implemented in the ingestion service — the bulk worker just needs to pass `force: false` and let the service handle it.

---

## Integrated User Journey (State 2 → 3 → 4)

This traces the complete user experience through the V2 crawl flow.

```
STATE 2: ANALYSIS
─────────────────
User enters URL → automatic 3-step pipeline:
  1. Profile site   → detect sitemap, JS, platform
  2. Cluster URLs   → group by pattern, count per group
  3. Sample groups  → test 1 page/group, detect HTTP vs Playwright

User sees:
  ┌─────────────────────────────────────────────────────┐
  │  📊 Analysis Complete                                │
  │                                                     │
  │  ☑ /products   142 pages  HTTP      [Preview]      │
  │  ☑ /support     68 pages  Playwright [Preview]      │
  │  ☐ /blog        16 pages  HTTP      [Preview]      │
  │                                                     │
  │  Total: 210 pages from 2 selected sections          │
  │                                                     │
  │  [← Back]                    [Continue to Config →] │
  └─────────────────────────────────────────────────────┘

Clicks "Continue" →
  • Draft saved: flowState='configured', sections persisted
  • V2 FIX: NO source created here (removes orphan source bug, D3)
  • V2 FIX: Full URLs already in buckets (stored by cluster-urls, D13)
  • Transition to State 3

STATE 3: CONFIGURE (HOW to crawl — WHAT was decided in State 2)
───────────────────────────────────────────────────────────────
User sees read-only crawl summary + configurable execution settings:

  ┌─────────────────────────────────────────────────────┐
  │  ┌─ CRAWL SUMMARY (read-only from State 2) ────┐   │
  │  │  210 pages from 2 sections                   │   │
  │  │  /products: 142 pages (HTTP)                 │   │
  │  │  /support:   68 pages (Playwright)           │   │
  │  │  Est. time: ~7 min                           │   │
  │  │                           [← Edit Sections]  │   │
  │  └──────────────────────────────────────────────┘   │
  │                                                     │
  │  V2: Scope/maxPages/maxDepth REMOVED                │
  │  (page count is determined by section selection)    │
  │                                                     │
  │  Strategy                                           │
  │    Rendering: [Auto-detected ▾]  ← uses per-group  │
  │    Patterns:  [Keep ● Reset]     ← handler reuse   │
  │    Speed:     [====●=====]       ← 1000ms delay    │
  │                                                     │
  │  Compliance                                         │
  │    Robots.txt: [Respect ● Ignore]                   │
  │                                                     │
  │  Content                                            │
  │    Cleanup:  [Standard ▾]                           │
  │    Dedup:    [On ● Off]                             │
  │    Cookies:  [Auto-dismiss ● Ignore]                │
  │                                                     │
  │  V2 NEW: Re-crawl context (if previous job exists): │
  │  ┌──────────────────────────────────────────────┐   │
  │  │ ℹ️ Last crawled: 3 days ago (226 pages)      │   │
  │  └──────────────────────────────────────────────┘   │
  │                                                     │
  │  [← Back]                       [Start Crawl →]    │
  └─────────────────────────────────────────────────────┘

Clicks "Start Crawl" →
  V2 FIX: ALL settings now sent to backend:
    1. V2 FIX (D13): Read FULL URL lists from buckets (PRIMARY path):
       For each included section:
         const result = await getSectionUrls(draftId, sectionId, { limit: 50000 });
         allUrls.push(...result.urls.map(u => u.url));
       FALLBACK: section.pages (examples only — for offline/bucket-failure cases)
    2. Deduplicate
    3. Create ONE source (POST /api/indexes/:id/sources)
    4. Submit crawl with FULL crawlSettings:
       POST /api/crawl/batch {
         urls: [...210],
         sourceId,
         draftId,              ← V2: for worker to update draft on completion
         // V2: no top-level strategy — per-section instead
         // V2: no limits — page count = urls.length
         sectionMapping: [     ← V2: includes per-section strategy
           { sectionId, pattern: '/products', urls: [...142], strategy: 'http' },
           { sectionId, pattern: '/support', urls: [...68], strategy: 'browser' },
         ],
         crawlSettings: {       ← V2: NOW SENT
           crawlDelay: 1000,
           respectRobotsTxt: true,
           cleanupLevel: 'standard',
           deduplicate: true,
           cookieConsent: true,
           reuseHandlers: true,
         }
       }
    5. Update draft: flowState='submitted', crawlJobId, sourceId
    6. Transition to State 4

STATE 4: CRAWLING
─────────────────
WebSocket connects immediately:
  ws://<host>/api/admin/progress/subscribe?jobId=X&token=Y

  ┌─────────────────────────────────────────────────────┐
  │  Crawling example.com — 45/210 (21%)  ETA: 3m      │
  │  ████████████░░░░░░░░░░░░░░░░░░░░░░░░               │
  │                                                     │
  │  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
  │  │ Crawled  │ │ Processed│ │ Failed   │            │
  │  │   45     │ │   43     │ │   2      │            │
  │  └──────────┘ └──────────┘ └──────────┘            │
  │                                                     │
  │  Section Fill Rates:                                │
  │  /products  ████████░░░░░░  30/142                  │
  │  /support   █████████████░  13/68                   │
  │                                                     │
  │  V2 NEW: Skipped:                                   │
  │  "3 URLs skipped (robots.txt)" [Show details]       │
  │                                                     │
  │  Quality: 🟢 38 Good  🟡 5 Thin  🔴 2 Failed       │
  │                                                     │
  │  [Cancel]                              [← Back]     │
  └─────────────────────────────────────────────────────┘

Cancel → confirm dialog → cooperative cancel (< 5s) → partial results kept
Back → minimize/cancel/stay dialog → activity bar shows progress
Navigate away → crawl continues server-side → activity bar on return

COMPLETION:
  ┌─────────────────────────────────────────────────────┐
  │  ✅ Crawl Complete                                   │
  │  210 pages crawled • 3 skipped • 2 failed           │
  │  Quality: 95% good                                  │
  │                                                     │
  │  [View Results]  [View Thin Content]                │
  └─────────────────────────────────────────────────────┘
  Draft updated: flowState='completed'
  Source status: 'active' (was 'draft')
```

---

## API Contract Changes (V2)

### `POST /api/crawl/batch` — Updated Request

```typescript
// BEFORE (V1): crawlSettings only partially read from strategy resolution
// AFTER (V2): explicit crawlSettings from frontend

interface BatchCrawlRequest {
  urls: string[];
  indexId: string;
  sourceId: string;
  // V2: strategy is now per-section (see sectionMapping below).
  // Top-level strategy removed — each section carries its own.
  // V2: limits.maxPages and limits.maxDepth REMOVED
  // Page count = urls.length (explicit URL list from section selection)
  sectionMapping: Array<{
    sectionId: string;
    pattern: string;
    name: string;
    urls: string[];
    strategy: 'http' | 'browser'; // V2 NEW: per-section rendering from discovery
    // Maps to CrawlJob.strategy enum: 'http' → 'bulk', 'browser' → 'browser'
    // Frontend resolves from GroupStrategy.method during mapGroupsToSections()
  }>;
  crawlSettings: {
    // V2: ALL settings now sent
    crawlDelay: number; // ms (200-5000)
    respectRobotsTxt: boolean;
    cleanupLevel: 'standard' | 'aggressive' | 'none';
    deduplicate: boolean;
    cookieConsent: boolean;
    reuseHandlers: boolean; // was 'learnedPatterns: keep|reset'
  };
  options?: {
    skipPrompts?: boolean;
  };
}

// Strategy enum alignment:
// Frontend CrawlConfig.rendering: 'http' | 'browser' | 'hybrid'
// GroupStrategy.method:           'http' | 'playwright'
// CrawlJob.strategy enum:        'browser' | 'bulk' | 'hybrid' | 'intelligence' | ...
// V2 canonical:                   'http' | 'browser' per section
//   'http' → worker uses HttpAdapter (Axios)
//   'browser' → worker uses Playwright via MCP
// The CrawlJob.strategy field stores the DOMINANT strategy for the overall job
// (e.g., 'smart' if mixed). Per-section strategies are in sectionMapping.
```

### `POST /api/crawl/batch` — Response

```typescript
interface BatchCrawlResponse {
  success: true;
  data: {
    jobId: string; // CrawlJob._id
    status: 'queued';
    urls: {
      total: number; // urls.length
      sections: number; // sectionMapping.length
    };
  };
}

// Error: { success: false, error: { code: string, message: string } }
```

### `GET /api/crawl-drafts/active` — New Endpoint

```typescript
// Query: ?indexId=X (required)
// Returns drafts with flowState='submitted' + their CrawlJob status

interface ActiveDraftsResponse {
  success: true;
  data: Array<{
    draftId: string;
    domain: string;
    flowState: 'submitted';
    crawlJobId: string;
    crawlJobStatus: 'queued' | 'crawling' | 'ingesting' | 'completed' | 'failed' | 'cancelled';
    progress?: {
      total: number;
      completed: number;
      failed: number;
      percentage: number;
    };
    submittedAt: string; // ISO
  }>;
}
```

### `POST /api/crawl/jobs/:jobId/cancel` — Existing Endpoint (V2 enhancement)

```typescript
// Already exists in crawl.ts (line 2671).
// V2 adds: Redis cancel signal for cooperative worker cancellation.

// Request: no body needed (jobId in path)
// Auth: tenantContext required (tenant-scoped)
// Behavior:
//   1. Updates CrawlJob.status → 'cancelled' + timeline.completedAt (existing)
//   2. V2 NEW: SET crawl:cancel:{jobId} in Redis (1-hour TTL)
//   3. Worker checks this key before each page fetch → stops within 1 page cycle

interface CancelResponse {
  success: true;
  jobId: string;
  status: 'cancelled';
}
```

### New ProgressEvent Types (V2)

The existing `ProgressEvent` interface (progress.ts) uses a **flat top-level + nested `data`** structure:

```typescript
// Existing shape (DO NOT change — other consumers depend on it):
interface ProgressEvent {
  type: 'job_started' | 'url_fetched' | 'document_processed' | 'job_completed' | 'job_failed' | ...;
  jobId: string;
  timestamp: string;  // ISO string, NOT number
  data?: {
    url?: string;
    documentId?: string;
    progress?: { total: number; completed: number; failed: number; percentage: number; };
    error?: { message: string; code?: string; };
    // ... intelligence fields
  };
}
```

**V2 additions** — extend the `type` union and `data` fields (same shape):

```typescript
// Add to ProgressEvent.type union:
  | 'url_skipped'         // NEW: URL blocked by robots.txt, rate limit, or dedup
  | 'bulk_crawl_started'  // NEW: bulk worker job started
  | 'bulk_crawl_complete' // NEW: bulk worker job finished (success or partial)

// Add to ProgressEvent.data:
  section?: string;       // NEW: sectionId from sectionMapping (for section fill rates)
  method?: 'http' | 'browser';  // NEW: rendering method used for this URL (url_fetched)
  statusCode?: number;    // NEW: HTTP status code (url_fetched)
  duration?: number;      // NEW: fetch duration in ms (url_fetched)
  score?: number;         // NEW: quality score 0-1 from QualityGate.scoreWithDom (document_processed)
  sections?: Array<{ sectionId: string; name: string; count: number }>; // NEW: section breakdown (bulk_crawl_started)
  skipReason?: 'robots_txt' | 'rate_limited' | 'duplicate'; // NEW: for url_skipped events
  quality?: 'good' | 'thin' | 'failed';  // NEW: for document_processed events
  comparison?: {          // NEW: for bulk_crawl_complete events (re-crawl summary)
    newDocuments: number;
    changedDocuments: number;
    deletedDocuments: number;
    unchangedDocuments: number;
  };
```

**Publishing pattern** (same as existing — flat event object):

```typescript
await publishProgressEvent({
  type: 'url_skipped',
  jobId,
  timestamp: new Date().toISOString(),
  data: { url, section: sectionId, skipReason: 'robots_txt' },
});
```

### Model Changes

```typescript
// CrawlDraft: Add 'completed' to FlowState enum
// BEFORE: 'profiling' | 'sections_ready' | 'configured' | 'submitted'
// AFTER:  'profiling' | 'sections_ready' | 'configured' | 'submitted' | 'completed'

// CrawlJob: Add TTL index
// schema.index({ 'timeline.completedAt': 1 }, { expireAfterSeconds: 90 * 24 * 3600 })
```

---

## Full UX Flow Per Objective

### O1: Honor Discovery Outcomes — UX Flow

```
State 3 (Configure) — read-only summary at top:
  ┌──────────────────────────────────────────┐
  │  CRAWL SUMMARY                           │
  │  210 pages from 2 sections               │
  │  /products: 142 pages (HTTP)             │
  │  /support:   68 pages (Playwright)       │
  │  Est. time: ~7 min                       │
  │                          [← Edit Sections]│
  └──────────────────────────────────────────┘
  (Sections were selected in State 2. State 3 is read-only summary + HOW settings.)

User clicks "Start Crawl" →
  Backend receives: { urls: [...210 URLs], sectionMapping: [...with per-section strategy] }
  Worker iterates exactly 210 URLs — no recursive link-following
  Worker uses per-section strategy (HTTP vs Playwright) from sectionMapping

In State 4 (Progress), user sees:
  ┌──────────────────────────────────────────┐
  │  Crawling example.com — 45/210 (21%)     │
  │  ████████░░░░░░░░░░░░░░░░░░░  ETA: 3m   │
  │                                          │
  │  Section Fill Rates:                     │
  │  /products  ██████░░░░  30/142           │
  │  /support   ██████████  15/68            │
  │                                          │
  │  Quality: 🟢 Good 38  🟡 Thin 5  🔴 2   │
  └──────────────────────────────────────────┘
```

**Per-page events map back to sections** via `sectionMapping` (URL prefix match → sectionId). The worker emits `document_processed` with `data.section` field (V2 new). `SectionFillRates` component (already exists in State4Crawl) aggregates these. The worker also uses `sectionMapping[].strategy` to decide HTTP vs Playwright per URL (D12).

### O2: Honor Crawl Configuration — UX Flow

**State 3 changes (settings wiring fix):**

The State 3 UI already has the right controls. The problem is `handleStartCrawl()`
doesn't pass most of them to the backend. V2 fixes this:

```
State 3 config → submitBatchCrawl payload:

  rendering       → strategy ('bulk' | 'playwright' | 'smart')  ✅ already wired
  requestDelay    → crawlSettings.crawlDelay (ms)               🆕 NOW WIRED
  respectRobotsTxt→ crawlSettings.respectRobotsTxt (bool)       🆕 NOW WIRED
  cleanup         → crawlSettings.cleanupLevel ('standard'|...) 🆕 NOW WIRED
  deduplicate     → crawlSettings.deduplicate (bool)            🆕 NOW WIRED
  cookieConsent   → crawlSettings.cookieConsent (bool)          🆕 NOW WIRED
  learnedPatterns → crawlSettings.reuseHandlers (bool)          🆕 NOW WIRED
  scope/maxPages  → REMOVED (page count = selected section URLs)
  maxDepth        → REMOVED (no link-following)
```

**State 3 UI changes:**

- Remove Scope cards, maxPages, and maxDepth (all recursive crawling concepts — page count is now read-only from section selection)
- Rendering default changed to "Auto-detected" (uses per-section strategy from State 2)
- Add read-only crawl summary at top (pages, sections, strategies, est. time)
- Add "Edit Sections" link back to State 2
- Add re-crawl context when previous CrawlJob exists: "Last crawled: 3 days ago"

**State 4 new elements:**

```
  - Skipped URLs shown in a collapsible section:
    "3 URLs skipped (blocked by robots.txt)" [Show details]
  - Rate limit indicator: "Crawl speed: ~2 pages/sec (limited by crawl-delay)"
```

**robots.txt enforcement produces `url_skipped` events** (new event type) with `{ url, reason: 'robots_txt' }`. These are NOT counted as failures — they appear in a separate "Skipped" section in the UI.

### O3: Real-Time Per-Page Progress — UX Flow

```
WebSocket connection established on State 4 mount:
  ws://<searchai-host>/api/admin/progress/subscribe?jobId=X&token=Y

Events arrive per page:
  url_fetched      → increment "Crawled" counter, update section fill
  document_processed → increment "Processed" counter, update quality breakdown
  job_completed    → show completion summary

Progress bar: continuous, driven by completed/total ratio
ETA: moving average of last 10 page durations × remaining
Section fills: live per-section bars (already rendered by SectionFillRates)
Quality: live Good/Thin/Failed breakdown (already rendered by computeQuality)
```

**Time to first progress event:** < 5 seconds after crawl start. The worker emits `job_started` immediately, then `url_fetched` after the first page fetch (typically 1-3 seconds).

### O4: WebSocket Reliability — UX Flow

```
Dev mode (Next.js):
  BEFORE: ws://localhost:5173/api/search-ai/... → blocked (can't proxy WS upgrades)
  AFTER:  ws://localhost:3005/api/admin/progress/subscribe?token=Y → direct connection

Production (NGINX):
  ws://<host>/api/search-ai/admin/progress/subscribe?token=Y → NGINX proxies to SearchAI

Fallback (WS fails after 3 attempts):
  Poll GET /api/crawl/status?jobId=X every 10s
  Less granular (job-level, not per-page) but always works
  UI shows: "Live updates unavailable — refreshing every 10s"
```

**User never sees a broken state.** If WS connects: live per-page updates. If WS fails: polling with slightly delayed updates. The `useCrawlProgress` hook handles this transparently — the `everOpenedRef` flag triggers fallback.

### O5: User Actions — UX Flow

**Cancel:**

```
User clicks [Cancel] in State 4 →
  Confirmation dialog: "Cancel crawl? Pages already processed will remain searchable."
  [Keep Crawling]  [Cancel Crawl]

On confirm:
  POST /api/crawl/jobs/:jobId/cancel
    → Sets CrawlJob.status = 'cancelled' in MongoDB
    → Sets crawl:cancel:{jobId} in Redis (1-hour TTL)

  Worker checks Redis before next page fetch → stops within 1 page cycle (< 5s)
  Worker emits job_completed with partial results summary

  UI transitions to completion view:
  ┌──────────────────────────────────────────┐
  │  ⚠️ Crawl Cancelled                      │
  │  45 pages processed • 0 failed           │
  │  Quality: 93% good                       │
  │                                          │
  │  [View Results]  [Re-crawl Remaining]    │
  └──────────────────────────────────────────┘
```

**Minimize:**

```
User clicks [←] back button during crawl →
  Dialog: "Crawl is still running"
  [Minimize to activity bar]  [Cancel crawl]  [Stay]

"Minimize" adds to DiscoveryActivityBar:
  ┌──────────────────────────────────────────┐
  │  🔄 example.com  Crawling 45/210 (21%)  │
  │     [Resume]                             │
  └──────────────────────────────────────────┘

Activity bar polls crawl status every 30s.
Clicking "Resume" reopens CrawlFlowV5 via restoration flow:
  1. Read CrawlDraft by draftId → get sections, settings, crawlJobId, sourceId
  2. Read CrawlJob by crawlJobId → get current status, progress, errors
  3. Open CrawlFlowV5 at the appropriate state:
     - CrawlJob.status 'queued'                → State 4 (waiting view)
     - CrawlJob.status 'crawling'/'ingesting'  → State 4 (live progress, reconnect WS)
     - CrawlJob.status 'completed'             → State 4 (completion summary)
     - CrawlJob.status 'failed'                → State 4 (failure + re-crawl option)
     - CrawlJob.status 'cancelled'             → State 4 (partial results summary)
  4. WS reconnection: useCrawlProgress hook auto-connects using jobId from draft
```

**Navigate away + return:**

```
User navigates to another page →
  Crawl continues server-side (BullMQ worker is independent of browser)

User returns to KB detail page →
  1. Activity bar hydrates from GET /api/crawl-drafts/active
     Shows any running/recently completed crawls
  2. KB detail page checks for active CrawlJobs:
     Banner: "🔄 Crawl in progress: example.com — 180/226 pages"  [View Progress]
     or: "✅ Crawl completed: example.com — 226 pages"  [View Results]  (shown for 1 hour)
```

### O6: Never Lose Work — UX Flow

```
Crash scenario 1: Worker dies mid-crawl
  BullMQ auto-retries the job (default 3 attempts)
  Worker on restart:
    1. Reads Redis checkpoints: skip pages marked 'ingested'
    2. Checks SearchDocument existence: skip pages already in DB
    3. Resumes from first unprocessed URL
  User sees: progress bar pauses briefly, then resumes

Crash scenario 2: Browser disconnects
  Crawl continues server-side
  On reconnect: WS re-establishes, receives current state
  Activity bar shows current progress on next page load

Crash scenario 3: Redis restart
  Layer 2 recovery: check SearchDocument existence per URL
  Slower (DB queries instead of Redis GETs) but complete

User always sees accurate state:
  - CrawlJob.urls.crawled reflects actual ingested count
  - Partial results are searchable immediately
  - "45 of 226 pages processed" is always truthful
```

### O7: SaaS-Ready — UX Flow

```
Tenant A starts a 10,000-page crawl
Tenant B starts a 50-page crawl 30 seconds later

Both see live progress:
  Tenant A: "Crawling site-a.com — 150/10000 (1%)"
  Tenant B: "Crawling site-b.com — 12/50 (24%)"

Tenant B finishes in ~2 minutes despite Tenant A's large job
  → BullMQ priority queues prevent starvation
  → Per-tenant concurrency cap (20 pages) prevents monopolization

No user-visible difference from single-tenant — isolation is transparent.
Metering data recorded per tenant (pages × rendering method) for future billing.
```

### O8: Re-Crawl — UX Flow

```
User re-crawls a previously crawled site:

State 3 shows comparison context:
  "Last crawled: 3 days ago (226 pages, 220 successful, 6 failed)"
  [Re-crawl All]  [Re-crawl Failed Only]

"Re-crawl Failed Only" implementation:
  1. Studio reads previous CrawlJob via GET /api/crawl/jobs?sourceId=X&status=completed&limit=1
  2. CrawlJob.urls.errors[] contains failed URLs with error reasons
  3. Studio filters sectionMapping to include ONLY URLs from the errors array
  4. Submits BatchCrawlRequest with the filtered URL list
  5. Worker processes only those URLs — same pipeline, smaller batch
  6. Re-crawl context: "Re-crawling 6 failed pages from previous crawl"

During crawl, dedup is automatic:
  - Same URL + same content hash → skipped (not re-ingested)
  - Same URL + different content → updated in place
  - New URL → new document created
  - Missing URL (was in last crawl, not in this one) → marked stale:
      SearchDocument.status = 'stale', staleAt = now()
      Excluded from search results (query filter: status !== 'stale')
      Auto-deleted after 30 days (MongoDB TTL index on staleAt)
      User sees: "3 pages removed (will be permanently deleted in 30 days)"

Completion summary:
  ┌──────────────────────────────────────────┐
  │  ✅ Re-crawl Complete                     │
  │                                          │
  │  📊 Changes detected:                    │
  │     12 new pages                         │
  │     5 pages updated                      │
  │     3 pages removed (no longer in site)  │
  │     206 pages unchanged (skipped)        │
  │                                          │
  │  [View Results]                          │
  └──────────────────────────────────────────┘
```

**CrawlJob.comparison** (already exists in model) is populated:
`{ previousJobId, newDocuments: 12, changedDocuments: 5, deletedDocuments: 3, unchangedDocuments: 206 }`

### O9: Remove Go Path — UX Flow

No user-facing changes. This is a code cleanup task executed AFTER O1-O6 pass acceptance criteria. Users never interacted with the Go crawler directly — they only saw its (broken) effects.

---

## Draft → Source Lifecycle (Fixed)

```
State 1 (URL Entry):
  → POST /api/crawl-drafts → creates CrawlDraft { flowState: 'profiling' }
  → NO source created yet

State 2 (Analysis):
  → Draft updated with discovery results { flowState: 'sections_ready' }
  → NO source created (remove the fire-and-forget addSource in handleContinue)

State 3 (Configure):
  → Draft updated with config { flowState: 'configured' }
  → NO source created yet — draft IS the pre-source identity

State 4 (Start Crawl):
  → handleStartCrawl():
    1. POST /api/indexes/:indexId/sources → creates ONE SearchSource { status: 'draft' }
    2. POST /api/crawl/batch { sourceId, urls, ... } → creates CrawlJob
    3. PUT /api/crawl-drafts/:id { flowState: 'submitted', crawlJobId, sourceId }
  → Draft now links to both source and job

Crawl completes:
  → crawlerIngestionService updates source status: 'draft' → 'active' (on first document)
  → CrawlJob status: 'completed'
  → Draft remains with 30-day TTL (for re-crawl context)

Source is now a real, active source with documents.
```

---

## Crawling Logs — Visibility & Retention

### Where Logs Are Shown

| Log Type                     | Where Visible                                       | Retention                                      |
| ---------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| **Per-page progress events** | State 4 progress UI (live via WebSocket)            | Session-only (not persisted after crawl)       |
| **CrawlJob record**          | SourceDetailPanel → History tab → CrawlJobHistory   | 90-day TTL (new)                               |
| **CrawlJob.errors array**    | SourceDetailPanel → History tab → job detail expand | Part of CrawlJob (90-day TTL)                  |
| **Audit events**             | `writeCrawlAuditEvent()` in MongoDB                 | Same as audit log retention (no TTL currently) |
| **BullMQ job data**          | Bull Board (admin)                                  | 24h completed, 7d failed                       |
| **SearchDocument quality**   | SourceDetailPanel → Pages tab                       | Permanent (part of document)                   |

### What the User Sees Post-Crawl

```
SourceDetailPanel (KB → Sources → click source):
  ┌─────────────────────────────────────────────────┐
  │  [Overview]  [Pages]  [History]  [Progress]     │
  │                                                 │
  │  History tab:                                   │
  │  ┌───────────────────────────────────────────┐  │
  │  │ ✅ May 5, 2026 — 226 pages, 220 success  │  │
  │  │    Strategy: bulk • Duration: 4m 23s      │  │
  │  │    Quality: 95% good • 3 failed           │  │
  │  │    [Re-crawl] [Delete]                    │  │
  │  ├───────────────────────────────────────────┤  │
  │  │ ⚠️ May 2, 2026 — 226 pages, 180 success  │  │
  │  │    Strategy: bulk • Duration: 6m 12s      │  │
  │  │    Quality: 82% good • 46 failed          │  │
  │  │    [View Errors] [Re-crawl] [Delete]      │  │
  │  └───────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────┘
```

---

## Memory & State Management

| State                                    | Storage                                                          | TTL                        | Survives Refresh?                                  |
| ---------------------------------------- | ---------------------------------------------------------------- | -------------------------- | -------------------------------------------------- |
| Draft configuration (sections, settings) | MongoDB via crawl-drafts API                                     | 30 days (`expiresAt`)      | ✅ Yes                                             |
| Crawl job status & results               | MongoDB CrawlJob model                                           | 90 days (new TTL index)    | ✅ Yes                                             |
| Activity bar items                       | Zustand store (client) → **hydrated from server on mount** (new) | Session + server sync      | ✅ Yes (via hydration)                             |
| WebSocket progress events                | Redis pub/sub (transient)                                        | Not persisted              | ❌ No — reconnect gets current state from CrawlJob |
| Worker crash recovery                    | Redis checkpoints (3h TTL) + SearchDocument existence            | 3 hours / permanent        | ✅ Yes                                             |
| Per-domain robots.txt cache              | Worker in-memory (bounded Map, 100 entries, 1h TTL)              | 1 hour                     | N/A (server-side)                                  |
| Per-domain rate limiter state            | Worker in-memory, process-level singleton keyed by domain (MVP)  | Session (reset on restart) | N/A (server-side)                                  |
| Stale document flag (`staleAt`)          | MongoDB SearchDocument field                                     | 30-day TTL on `staleAt`    | ✅ Yes (persisted)                                 |

### Activity Bar Hydration (New)

```
On KB detail page mount:
  1. GET /api/crawl-drafts/active?indexId=X
     Returns: drafts with flowState='submitted' + their CrawlJob status
  2. For each draft with running crawl:
     Add to DiscoveryActivityBar store via setItems()
  3. Activity bar renders and starts polling

This ensures:
  - Page refresh → activity bar shows running crawls
  - Navigation away + return → activity bar shows running crawls
  - Other browser tab → same state via API (not localStorage)
```

---

## Task Decomposition

| Task | Package(s)                            | Independent?                 | Est. Files | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------- | ---------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-0  | `apps/search-ai`, `apps/studio`       | Yes                          | 4-5        | **Full URL storage (D13)**: Modify `cluster-urls` endpoint to accept `draftId` and store full URL lists per group into `CrawlDraftUrlBucket` after clustering. Modify `handleStartCrawl` to read from buckets as primary path. Wire `BrowserDiscoveryInline` and `ExplorePanel` to call `putSectionUrls()` after building sections. This is the foundation — everything else depends on real URLs being available.                                                                                               |
| T-1  | `apps/search-ai`                      | Yes                          | 3-4        | **Bulk crawl worker**: New `bulk-crawl-worker.ts` with sliding window (5 concurrent), per-section strategy (D12), handler template seeding from MongoDB at job start (D14), quality gate, crash recovery, cooperative cancel, progress events with `data.{section, method, statusCode, duration}` fields. Register in `workers/index.ts`. Draft completion update (D10).                                                                                                                                         |
| T-2  | `apps/search-ai`                      | Depends on T-1               | 2-3        | **Batch route update**: Change `/batch` handler to enqueue on `bulk-crawl` queue (replace `static-crawl`), accept `crawlSettings` + per-section strategy + `draftId`, skip sitemap re-expansion for explicit URL lists (> 1 URL). **Critical: forward `sectionMapping` in BullMQ job data** (currently stored in CrawlJob MongoDB only — worker needs it for per-section progress, strategy routing, and section fill rates). Add `crawl:cancel:{jobId}` Redis signal + BullMQ job removal in cancel endpoint.   |
| T-3  | `packages/crawler`, `apps/search-ai`  | Yes                          | 2-3        | **Robots.txt + rate limiter**: Extend existing `robots-analyzer.ts` with cached `isUrlAllowed(url)` for runtime enforcement. New `domain-rate-limiter.ts` (in-memory token bucket, process-level singleton keyed by domain — MVP single-worker; Redis-based deferred). Enforces `max(crawlDelay, robots.txt crawl-delay)`. Add `url_skipped` event type to `progress.ts`.                                                                                                                                        |
| T-4  | `apps/studio`                         | Yes                          | 3-4        | **WebSocket fix + progress UX**: Fix `useCrawlProgress` AND `useMultiPageProgress` to pass `?token=` (both are missing it). Direct connection in dev mode. Add skipped-URLs section. REST polling fallback.                                                                                                                                                                                                                                                                                                      |
| T-5  | `apps/studio`, `packages/database`    | Depends on T-0               | 5-7        | **State 3 redesign + config wiring + per-section strategy (D7, D12)**: Remove Scope/maxPages/maxDepth from State3Configure. Add read-only crawl summary with per-section strategy labels. Wire all 6 missing settings to `submitBatchCrawl`. Add `strategy` field to `CrawlSection` and `ICrawlDraftSection`. Propagate `GroupStrategy.method` through `mapGroupsToSections()`. Remove orphan `addSource` in `handleContinue` (D3). Add re-crawl context banner. Wire draft `flowState: 'completed'` enum value. |
| T-6  | `apps/studio`                         | Yes                          | 4-5        | **Activity bar hydration + resume + KB banner (D4)**: Call `GET /api/crawl-drafts/active` on mount to hydrate Zustand store. Add "Resume" action: read draft (sections, settings, crawlJobId) → read CrawlJob (status, progress) → open CrawlFlowV5 at appropriate state (queued→waiting, crawling→live WS, completed→summary, failed→re-crawl, cancelled→partial). Add polling for backgrounded items. Add active crawl banner to KB detail page.                                                               |
| T-7  | `apps/search-ai`, `packages/database` | Depends on T-1               | 3-4        | **Re-crawl support (O8)**: Populate `CrawlJob.comparison` by looking up previous job for same sourceId. "Re-crawl Failed Only" — read failed URLs from previous `CrawlJob.urls.errors[]`, filter sectionMapping. Change summary in `job_completed` event. Stale document detection: set `SearchDocument.status='stale'` + `staleAt=now()` for URLs in previous crawl but absent in current; 30-day TTL index on `staleAt` for auto-cleanup; stale docs excluded from search (`status !== 'stale'`).              |
| T-8  | `packages/database`, `apps/search-ai` | Yes                          | 1-2        | **CrawlJob TTL + cleanup**: 90-day TTL index on `timeline.completedAt`, CrawlHistory archival.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| T-9  | `apps/search-ai`, scripts             | Depends on T-1, T-2 verified | 4-6        | **Remove Go crawler path (O9)**: Delete dead code, queues, Docker refs.                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Execution Waves

```
Wave 0 (foundation — must complete first):
  T-0  Full URL storage (D13)     (search-ai + studio)
  T-3  Robots.txt + rate limiter  (packages/crawler)
  T-8  CrawlJob TTL              (database)

Wave 1 (parallel — after Wave 0):
  T-1  Bulk crawl worker          (search-ai)
  T-5  State 3 redesign + wiring  (studio, depends on T-0 for bucket reads)

Wave 2 (parallel — after Wave 1):
  T-2  Batch route update         (search-ai, needs T-1 worker)
  T-4  WebSocket fix + progress   (studio)
  T-6  Activity bar + resume      (studio)

Wave 3 (sequential — after Wave 2):
  T-7  Re-crawl support           (needs T-1 worker running)

Wave 4 (sequential — after all verified):
  T-9  Remove Go path             (cleanup)
```

---

## Error Handling Strategy

### Per-Page Error Handling (Worker)

| Error Type                          | Retryable? | Action                                          | User Sees                                                  |
| ----------------------------------- | ---------- | ----------------------------------------------- | ---------------------------------------------------------- |
| HTTP 429 (rate limited)             | Yes        | Exponential backoff (1s, 2s, 4s), max 3 retries | url_skipped with reason 'rate_limited' if all retries fail |
| HTTP 5xx                            | Yes        | 2 retries with 2s delay                         | url_fetched with error on final failure                    |
| HTTP 4xx (not 429)                  | No         | Skip immediately                                | url_fetched with error                                     |
| DNS resolution failure              | No         | Skip immediately                                | url_fetched with error                                     |
| Connection timeout (30s)            | Yes        | 1 retry                                         | url_fetched with error on final failure                    |
| Playwright navigation timeout (60s) | Yes        | 1 retry with HTTP fallback                      | Falls back to HTTP if Playwright fails                     |
| Playwright crash                    | No         | Close MCP connection, reopen for next URL       | url_fetched with error                                     |
| Ingestion pipeline error            | No         | Log error, continue to next URL                 | document_processed with quality='failed'                   |
| robots.txt blocked                  | No         | Skip (not an error)                             | url_skipped with reason 'robots_txt'                       |

**Error accumulation:** CrawlJob.processingErrors[] stores error samples (max 100). CrawlJob.urls.failed increments per failed URL. Worker continues to next URL on any error — never stops the entire job for a single page failure.

**Fatal errors (stop entire job):**

- Redis unavailable (can't checkpoint, can't check cancel signal) → job_failed
- MCP server unreachable after 3 reconnection attempts → downgrade all Playwright URLs to HTTP, continue
- Cancel signal detected → orderly shutdown, job status 'cancelled'

### Job-Level Error Handling

| Scenario                     | Handling                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker process crash         | BullMQ auto-retries (3 attempts). Worker reads Redis checkpoints + checks SearchDocument existence to skip already-processed URLs.                            |
| Job timeout (60 min)         | BullMQ `jobTimeout`. Worker emits job_failed. Partial results kept.                                                                                           |
| Redis unavailable during job | Worker catches error, falls back to SearchDocument existence check (slower). If Redis is needed for cancel signal, worker proceeds without cancel capability. |

---

## Worker Registration & Startup

```typescript
// In workers/index.ts — register alongside existing workers:
import { createBulkCrawlWorker } from './bulk-crawl-worker.js';

// Worker creation:
const bulkCrawlWorker = new Worker(
  'bulk-crawl', // Queue name (replaces 'static-crawl')
  bulkCrawlProcessor, // Job processor function
  {
    connection: redisConnection,
    concurrency: 1, // One job at a time per worker instance
    // Per-URL concurrency is handled INSIDE the processor (sliding window of 5)
    limiter: {
      max: 1,
      duration: 1000, // Prevent burst job pickup
    },
  },
);

// Graceful shutdown:
process.on('SIGTERM', async () => {
  await bulkCrawlWorker.close(); // Finishes current job, stops picking new ones
});
```

**Queue configuration:** The `bulk-crawl` queue is created in the batch route handler (same pattern as existing `static-crawl` queue at crawl.ts line 183). BullMQ queue options: `removeOnComplete: { age: 86400, count: 1000 }`, `removeOnFail: { age: 604800 }`.

---

## Completion Event Shape

```typescript
// job_completed event — emitted by worker in finally block
await publishProgressEvent({
  type: 'job_completed',
  jobId,
  timestamp: new Date().toISOString(),
  data: {
    progress: {
      total: urls.length,
      completed: successCount,
      failed: failedCount,
      percentage: 100,
    },
    // V2 additions:
    skipped: skippedCount, // robots.txt + dedup skips
    quality: {
      good: goodCount,
      thin: thinCount,
      failed: qualityFailedCount,
    },
    comparison: isRecrawl
      ? {
          // Only present for re-crawl jobs
          newDocuments: 12,
          changedDocuments: 5,
          deletedDocuments: 3,
          unchangedDocuments: 206,
        }
      : undefined,
    duration: endTime - startTime, // ms
  },
});
```

---

## Testing Strategy

| Layer           | What to Test                                                                                                                 | Approach                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Unit**        | Robots.txt checker (cached `isUrlAllowed`), domain rate limiter (token bucket), quality gate scoring, URL-to-section mapping | Pure function tests, no mocks                                                                                      |
| **Integration** | Worker processes a batch of 3 URLs end-to-end (real Redis + MongoDB, mock HTTP responses via nock)                           | Start real Redis + MongoDB, assert CrawlJob status transitions, SearchDocument creation, progress events published |
| **E2E**         | Full State 3 → Start Crawl → State 4 progress → completion                                                                   | Real services, POST /batch via API, verify WS events arrive, verify documents in search index                      |
| **WS**          | useCrawlProgress hook receives events correctly, fallback to polling on failure                                              | Studio component test with real WS server                                                                          |
| **Cancel**      | Cancel during crawl → worker stops within 1 page cycle, partial results kept                                                 | Integration test: start crawl, cancel after 2 pages, verify job status + document count                            |

---

## Migration Strategy

**Deployment plan:** Both old (`static-crawl`) and new (`bulk-crawl`) queues coexist during rollout.

```
Phase 1: Deploy new code
  - bulk-crawl worker starts processing new queue
  - static-crawl worker still running (processes any in-flight Go jobs)
  - Batch route SWITCHES to enqueue on 'bulk-crawl' (not 'static-crawl')
  - New crawls → new worker. In-progress Go crawls → continue on old worker.

Phase 2: Drain (automatic, ~24h)
  - Old 'static-crawl' queue drains naturally (no new jobs)
  - Go worker container still running as safety net

Phase 3: Remove Go path (T-9, Wave 4)
  - After verification that bulk-crawl processes correctly
  - Remove Go Docker image, static-crawl queue, old handlers
```

**Rollback:** If bulk-crawl worker has issues, change batch route back to enqueue on `static-crawl`. Go worker picks up jobs. No data loss — CrawlJob model is shared.

---

## Pre-Existing Bugs Fixed by V2

These bugs exist in the current codebase (not introduced by V2) and are fixed as part of this work:

| Bug                                                                      | Severity    | Root Cause                                                                                                                                                                                                                         | V2 Fix                                                                                                        | Task |
| ------------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---- |
| **URL count illusion** — user sees "142 pages" but only ~10 get crawled  | 🔴 Critical | `UrlClusterer.MAX_EXAMPLES = 10` discards full URL lists after clustering. `persistSectionUrls()` only stores the 10 examples. `handleStartCrawl` collects ~10 URLs per section.                                                   | D13: `cluster-urls` stores full URL lists into buckets; `handleStartCrawl` reads from buckets as primary path | T-0  |
| **Duplicate source creation** — orphan `web_crawl` source per crawl      | 🟡 High     | `handleContinue()` creates a source with `sourceType: 'web_crawl'` (fire-and-forget, never used). `handleStartCrawl()` creates the real source with `sourceType: 'web'`.                                                           | D3: Remove `addSource` in `handleContinue`                                                                    | T-5  |
| **WebSocket auth missing** — no `?token=` in WS URL                      | 🔴 Critical | `useCrawlProgress` (line 155) and `useMultiPageProgress` (line 353) don't send auth token. Server requires token or cookie for WS upgrade. Works in prod only if `abl_token` cookie is present.                                    | D2: Add `?token=${accessToken}` to WS URL                                                                     | T-4  |
| **6 config settings not wired** — user toggles ignored                   | 🟡 High     | `handleStartCrawl` only sends `strategy` and `limits`. Settings for `requestDelay`, `respectRobotsTxt`, `cleanup`, `deduplicate`, `cookieConsent`, `learnedPatterns` exist in State 3 UI but are never sent to `submitBatchCrawl`. | D7: Wire all settings via `crawlSettings` object                                                              | T-5  |
| **Per-section strategy lost** — HTTP vs Playwright decision discarded    | 🟡 High     | `mapGroupsToSections()` converts `GroupStrategy.method='playwright'` to `warnings.push('tabs, accordions')`. No `strategy` field on `CrawlSection` or `ICrawlDraftSection`. Worker gets one global strategy.                       | D12: Add `strategy` field, propagate end-to-end                                                               | T-5  |
| **State 3 shows recursive crawl settings** — scope/maxPages/maxDepth     | 🟢 Medium   | Leftover from recursive crawling. User already selected pages in State 2. These controls are meaningless for explicit URL lists.                                                                                                   | D7: Remove all three controls                                                                                 | T-5  |
| **Activity bar doesn't hydrate** — lost on page refresh                  | 🟡 High     | Zustand store is ephemeral. No code calls server on mount. `setItems()` exists but is never called.                                                                                                                                | D4: Call `GET /api/crawl-drafts/active` on mount                                                              | T-6  |
| **Browser discovery doesn't persist URLs** — URLs lost if page refreshes | 🟢 Medium   | `BrowserDiscoveryInline` and `ExplorePanel` build sections but never call `putSectionUrls()`.                                                                                                                                      | Wire `putSectionUrls()` after building sections                                                               | T-0  |
| **Backend may re-expand URLs** — sitemap overrides explicit list         | 🟢 Medium   | `/batch` handler re-profiles the first URL and may expand via sitemap (when `urls.length === 1`). This could replace the curated section URLs.                                                                                     | Skip sitemap expansion when explicit URL list provided (> 1 URL)                                              | T-2  |
| **Cancel doesn't signal worker** — only updates MongoDB                  | 🟡 High     | Cancel endpoint updates CrawlJob status but doesn't set Redis key. Worker (when it exists) won't know to stop.                                                                                                                     | SET `crawl:cancel:{jobId}` in Redis + remove BullMQ job                                                       | T-2  |

---

## Out of Scope

- **Pause/resume crawl** — requires queue manipulation UX (separate feature)
- **Retry individual failed pages** — requires per-page action UI (separate feature)
- **View partial results during crawl** — requires live document list (separate feature)
- **Plan-based page quotas** — metering data recorded but not gated (billing integration separate)
- **Sitemapless discovery wiring** — `DiscoveryChain` exists but isn't wired into crawl-site route (separate ticket)
- **Depth-based link following** — discovery already finds URLs; not needed for bulk path
- **Dual WS connection merge** — optimize later; both hooks work correctly today
- **Pagination URL expansion** — `PaginationDetector.generatePageUrls()` exists in packages/crawler but is NOT wired into any discovery flow. V2 does not generate additional URLs from patterns. Discovery finds real URLs; the worker crawls exactly those. Wiring PaginationDetector is future work.
- **Pattern-based URL inference** — `PatternMatcher` scores/classifies URLs but never generates new ones. No change in V2.
