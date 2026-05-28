# Crawl V2 — Objectives & Architecture Direction

## Context

The current crawl pipeline has a fundamental architecture gap: discovery runs in
Node.js (sitemap parsing, section detection, strategy selection), but bulk
fetching is delegated to a Go worker that **ignores** all discovery outcomes —
sections, rendering mode, crawl settings, and URL boundaries.

The Go crawler:

- Treats selected URLs as seeds for recursive link-following (re-discovers what
  discovery already found)
- Drops `crawlSettings` (robots.txt, crawl delay, concurrency)
- Only supports HTTP (no browser rendering despite UX offering "Adaptive" /
  "Browser")
- Publishes progress to a BullMQ event stream that nothing reads
- Has a Redis broken-pipe bug that loses crawled results
- Is not in this repository (local Docker image only)

Meanwhile, the Node.js codebase already has every building block needed:
`HttpAdapter` (axios + SSRF protection), Playwright via MCP, quality gating,
handler reuse (0 LLM calls), crash recovery, per-page progress events, and a
shared ingestion pipeline.

**Decision: retire the Go crawler. Build a Node.js bulk crawl worker that
honours discovery outcomes, emits real-time progress, and is
serverless-friendly.**

---

## Objectives

### O1: Honor Discovery Outcomes

The bulk crawl MUST fetch only the URLs that discovery found and the user
selected. No recursive link-following. No re-discovery.

| What discovery provides                                   | How bulk crawl uses it                                |
| --------------------------------------------------------- | ----------------------------------------------------- |
| Explicit URL list (from sitemap or sitemapless discovery) | Fetch exactly these URLs — no more, no less           |
| Section mapping (sectionId → URL pattern → URLs)          | Track progress per section, map results back          |
| Group strategies (`method: 'http' \| 'playwright'`)       | Route each URL to the correct fetcher                 |
| Handler templates (from intelligence analysis of samples) | Apply handler for extraction when available           |
| Quality expectations (from sample scoring)                | Quality-gate each page post-fetch (heuristic, no LLM) |

**Extraction strategy per page:**

| Scenario                                 | Approach                                                            | LLM cost |
| ---------------------------------------- | ------------------------------------------------------------------- | -------- |
| Handler template exists (from discovery) | Apply via `HandlerReuser`                                           | $0       |
| No handler, but HTML is clean            | Cheerio/Readability extraction                                      | $0       |
| No handler, page needs JS rendering      | Playwright fetch → Readability                                      | $0       |
| No handler, complex structure            | Ingest with Readability (lower quality, mark as "basic extraction") | $0       |

**Design note:** The bulk crawl path does NOT fall back to the LLM intelligence
loop. If a handler template was not created during discovery, the page is
ingested via Readability (the same pipeline all crawlers use). Quality gating
uses `QualityGate.scoreWithDom()` which is a heuristic scorer — zero LLM calls.
Users who want LLM-assisted extraction use the intelligence crawl path (State 2
single-page analysis).

**Acceptance criteria:**

- Given 226 URLs from 3 sections, the crawl fetches exactly 226 URLs
- Each fetched page is mapped back to its section for fill tracking
- Handler reuse is applied when templates exist; Readability fallback otherwise
- No LLM calls during bulk crawl — verified by zero LLM cost metrics

### O2: Honor Crawl Configuration

Every setting the user configures in State 3 MUST be enforced during crawl.

| Setting                                    | Current                                                | Target                                                                                            |
| ------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Rendering mode (HTTP / Browser / Adaptive) | Ignored — Go is HTTP-only                              | Route per URL based on group strategy                                                             |
| ~~Crawl scope (Limited / Full / Custom)~~  | maxPages passed but recursive crawl ignores boundaries | **REMOVED (D7)** — page count = selected section URLs. No user-configurable scope/limit.          |
| robots.txt compliance                      | Profiled but not enforced                              | Enforce disallow rules, crawl-delay                                                               |
| Crawl speed / politeness                   | Dropped by Go struct                                   | Per-domain rate limiting with configurable delay                                                  |
| ~~Max pages~~                              | Passed but overridden by recursive crawl               | **REMOVED (D7)** — hard cap = `urls.length` from section selection. Read-only summary in State 3. |

**Implementation note — robots.txt:** The codebase currently fetches and parses
robots.txt during profiling (`FastProfiler`) but does NOT enforce rules during
actual page fetching. The LLD must include integrating a robots.txt parser (e.g.
`robots-parser` npm package) into the fetch path: before each URL fetch, check
`isAllowed(url, userAgent)`. Per-domain crawl-delay enforcement requires a
simple token-bucket or delay-queue per domain.

**Acceptance criteria:**

- "Browser" rendering mode uses Playwright (via MCP) for pages in
  `method: 'playwright'` groups
- robots.txt disallow rules prevent fetching blocked URLs; blocked URLs are
  reported as skipped (not failed)
- Crawl delay from robots.txt or user config is enforced between requests to
  same domain

### O3: Real-Time Per-Page Progress

The user MUST see live progress at page and section granularity — not a single
event at 100%.

**Progress events emitted per page:**

Events use the existing `ProgressEvent` type union in `progress.ts` and extend
it with new bulk crawl events. The `useCrawlProgress` hook dispatches bulk
events; the `useMultiPageProgress` hook continues to handle intelligence events.

| Event                | When                | Data                                                 |
| -------------------- | ------------------- | ---------------------------------------------------- |
| `job_started`        | Crawl begins        | `{ total, sections }`                                |
| `url_fetched`        | After HTML received | `{ url, section, method, statusCode, duration }`     |
| `document_processed` | After ingestion     | `{ url, documentId, quality, score }`                |
| `job_completed`      | All pages done      | `{ summary: { total, completed, failed, quality } }` |
| `job_failed`         | Crawl-level failure | `{ error }`                                          |

**Aggregate events (computed client-side from per-page events):**

- Section fill rates — count `document_processed` events per section
- Quality breakdown — aggregate `quality` field from `document_processed`
- ETA — moving average of last 10 page durations × remaining pages
- Overall progress — `completed / total`

**Acceptance criteria:**

- Progress bar moves from 0% to 100% with per-page granularity
- Section fill bars update in real-time as pages in each section complete
- Quality breakdown (Good / Thin / Failed) updates live
- ETA recalculates based on actual throughput (moving average of recent pages)
- WebSocket connection works in both local dev and production

### O4: WebSocket Reliability

Fix the current broken WebSocket path so progress events reach the UI.

| Issue                                                 | Fix                                                                                                                                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS blocked in dev mode (Next.js can't proxy upgrades) | Connect directly to SearchAI backend in dev; use NGINX path in prod                                                                                                                 |
| Auth token missing from WS URL                        | Pass `token` query param (match `useIntelligenceProgress` pattern)                                                                                                                  |
| Dual WS connections (both hooks subscribe same jobId) | **Keep both hooks** (D2) — `useCrawlProgress` for bulk events, `useMultiPageProgress` for intelligence events. Fix auth on both. Single connection deferred (see HLD Out of Scope). |

**REST polling fallback:** When WebSocket connection fails (detected via
`everOpenedRef`), fall back to polling `GET /api/crawl/status?jobId=xxx` every
10 seconds. This endpoint reads from MongoDB (authoritative) and returns
progress, state, and results. Polling is less granular (no per-page events) but
ensures the user always sees current status.

**Acceptance criteria:**

- WebSocket connects and receives events in local dev mode
- WebSocket connects and receives events in production (via NGINX ingress)
- Authentication works via token query parameter
- Reconnection with backoff on transient failures
- REST polling activates automatically when WebSocket fails

### O5: User Actions During Crawl

The user MUST be able to act on the crawl at any point — not just watch.

| Action            | Behaviour                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Cancel**        | Stops in-flight fetches. Pages already ingested remain searchable. UI shows: "Cancelled. N pages ingested. View partial results." |
| **Minimize**      | Crawl continues in background. Activity bar shows domain + progress. Re-opening panel shows current state.                        |
| **Navigate away** | Same as minimize — crawl runs server-side. Returning to KB shows crawl status.                                                    |
| **Close panel**   | 3-option dialog: Minimize / Close (continues in background) / Cancel                                                              |

**Cancel implementation — cooperative cancellation:**

The current cancel endpoint only sets `status: 'cancelled'` in MongoDB. The
worker never checks for cancellation. The bulk crawl worker MUST implement
cooperative cancellation:

1. Cancel endpoint sets `CrawlJob.status = 'cancelled'` in MongoDB AND sets a
   Redis key `crawl:cancel:{jobId}` with 1-hour TTL
2. Worker checks `crawl:cancel:{jobId}` before each page fetch (Redis GET, <1ms)
3. On cancel detected: stop fetching, emit `job_completed` with partial results,
   update CrawlJob with actual counts
4. Target: cancel takes effect within 1 page-fetch cycle (typically < 5 seconds)

**Background crawl notification:**

When a crawl completes in the background (user navigated away), the UI detects
completion via:

1. **Activity bar polling** — the `DiscoveryActivityBar` polls crawl status
   every 30 seconds for minimized crawls
2. **KB page mount** — when user navigates to KB detail page, check for active
   CrawlJobs and show status banner if running or recently completed
3. **Draft persistence** — crawl configuration (sections, settings) persists via
   crawl-drafts API. Reopening the crawl panel restores state from draft +
   CrawlJob status.

**Acceptance criteria:**

- Cancel stops the crawl within 5 seconds, partial results preserved
- Minimized crawl shows live progress in activity bar
- Navigating away and returning restores crawl progress state
- KB detail page shows banner for active/recently completed crawls
- No user action results in data loss

### O6: Never Lose Work

Partial results are first-class. A crawl that processes 180/226 pages before
failure has 180 searchable documents.

| Scenario                      | Behaviour                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker crash mid-crawl        | Crash recovery via Redis checkpoints. Resume from last completed page. BullMQ auto-retries the job.                                                                                                                                                                                                                                                           |
| Network timeout on single URL | Mark page as failed, continue with remaining URLs                                                                                                                                                                                                                                                                                                             |
| User cancels mid-crawl        | Ingested pages remain. CrawlJob status = `cancelled` with results summary.                                                                                                                                                                                                                                                                                    |
| Browser disconnects           | Server-side crawl continues. Reconnecting shows current state.                                                                                                                                                                                                                                                                                                |
| Redis restart                 | Recover from MongoDB CrawlJob + SearchDocument existence checks (layer 2)                                                                                                                                                                                                                                                                                     |
| SearchAI service restart      | BullMQ retries the job (exponential backoff: 60s → 120s → 240s, 3 attempts). Worker checks Redis checkpoints + SearchDocument existence to skip already-processed URLs. Per-tenant semaphore TTL (120s) bounds phantom slots to at most 5 (sliding window size); all phantom slots clear before second retry at 120s. See HLD D1 for full invariant analysis. |

**Acceptance criteria:**

- Every successfully ingested page is searchable regardless of overall crawl
  outcome
- CrawlJob results always reflect actual work done (not all-or-nothing)
- REST polling fallback if WebSocket fails (GET /api/crawl/status)
- Service restart mid-crawl resumes from last checkpoint, not from scratch

### O7: SaaS-Ready Architecture

The bulk crawl worker MUST be designed for multi-tenant SaaS operation.

| Concern                    | Approach                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-tenant isolation** | Per-tenant concurrency limits, no shared state between tenants                                                                                            |
| **Concurrent crawls**      | Allow multiple crawl jobs per tenant (different sites). Per-tenant cap on total concurrent page fetches (configurable, default 20).                       |
| **Fair scheduling**        | BullMQ priority queues — no tenant monopolises resources                                                                                                  |
| **Noisy neighbour**        | Per-tenant page concurrency cap applies across all active jobs                                                                                            |
| **Cost predictability**    | Zero LLM calls in bulk crawl — cost = pages × fetch cost                                                                                                  |
| **Serverless-friendly**    | Per-URL fetch is a pure stateless function. MVP runs as a BullMQ worker; architecture allows future extraction to Lambda/Azure Functions without rewrite. |
| **Metering**               | Track pages crawled × rendering method per tenant for billing                                                                                             |

**Concurrency model clarification:**

- Multiple crawl _jobs_ per tenant: YES (e.g. crawling two different sites)
- Per-tenant page concurrency cap: 20 concurrent page fetches across all jobs
  (prevents one tenant from consuming all worker capacity)
- Cross-tenant: BullMQ priority ensures fair distribution
- Per-domain rate limit: enforced within each worker process (in-memory token bucket,
  process-level singleton keyed by domain). Enforces `max(user crawlDelay, robots.txt crawl-delay)`.
  **MVP limitation:** not shared across worker replicas. V2 runs a single worker instance.
  Redis-based cross-worker rate limiting is deferred to multi-worker scaling phase.

**Plan-based page limits:** Not enforced in V2. The worker fetches all selected
URLs regardless of plan quota. Billing/metering integration is a separate
feature. The metering data (pages × method per tenant) is recorded for future
billing but does not gate access.

**Acceptance criteria:**

- Two tenants can crawl simultaneously without blocking each other
- One tenant's 10,000-page crawl does not starve another's 50-page crawl
- Per-URL fetch is a pure function (URL + config in → HTML + metadata out)

### O8: Re-Crawl Support

When a user re-crawls a previously crawled site, the system MUST handle
document lifecycle correctly.

| Scenario                                          | Behaviour                                                                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Same URL, content unchanged                       | Skip or update existing document (dedup by URL + sourceId)                                                                                                                     |
| Same URL, content changed                         | Update existing document, preserve documentId                                                                                                                                  |
| URL removed from new crawl (no longer in sitemap) | Mark as stale (`SearchDocument.status='stale'`, `staleAt=now()`). Excluded from search results immediately. Auto-deleted after **30 days** via MongoDB TTL index on `staleAt`. |
| New URL added since last crawl                    | Create new document                                                                                                                                                            |

**Implementation note:** The CrawlJob model already has a `comparison` field
(`previousJobId`, `newDocuments`, `changedDocuments`, `deletedDocuments`) that
was designed for this. The ingestion service should:

1. Before ingesting, check if a `SearchDocument` exists for `{url, sourceId}`
2. If exists and content hash matches → skip (unchanged)
3. If exists and content hash differs → update document, increment
   `changedDocuments`
4. After crawl, compare ingested URLs vs previous crawl's URLs → mark missing
   as stale

**Acceptance criteria:**

- Re-crawling the same site does not create duplicate documents
- Changed content is detected and documents updated
- CrawlJob.comparison is populated with diff summary
- User sees "12 new, 5 updated, 3 removed" in completion summary

### O9: Clean Removal of Go Crawler Path

Remove all dead code from the Go crawler integration.

**Dependency: O9 MUST be implemented AFTER O1-O6 are verified working. The Go
path is the only bulk crawl path until the Node.js worker replaces it.**

| Remove                                   | Location                                                 |
| ---------------------------------------- | -------------------------------------------------------- |
| `crawler-ingestion-worker.ts`            | `apps/search-ai/src/workers/`                            |
| `content-processing` queue setup         | `apps/search-ai/src/workers/index.ts`                    |
| `static-crawl` queue (`getCrawlQueue()`) | `apps/search-ai/src/routes/crawl.ts`                     |
| `/batch` POST handler                    | `apps/search-ai/src/routes/crawl.ts` lines 316-885       |
| `/batch/respond` POST handler            | `apps/search-ai/src/routes/crawl.ts` lines 906-1208      |
| `static-crawl` health check              | `apps/search-ai/src/routes/health.ts`                    |
| Go Docker references in `abl-dev.sh`     | `scripts/abl-dev.sh` lines 543-571, 637-640, 679-680     |
| Local Docker image                       | `docker rm crawler-worker; docker rmi crawler-go-worker` |

**Keep:**

- `crawlerIngestionService` (shared ingestion pipeline — used by both old and
  new paths)
- Intelligence crawl worker (used for discovery/analysis in State 2)
- All discovery infrastructure (profiler, sections, strategies)
- CrawlJob model, status/dashboard/history endpoints (work for any strategy)
- `publishProgressEvent()` and WebSocket server (reused by new worker)

**Acceptance criteria:**

- `pnpm build` passes with no references to removed code
- No BullMQ worker starts for `content-processing` or `static-crawl`
- `abl-dev.sh` no longer attempts to build/start Go Docker container

---

## Out of Scope (Future)

| Item                                               | Why deferred                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| Pause/resume crawl                                 | Requires queue manipulation UX — separate feature                   |
| Retry individual failed pages                      | Requires per-page action UI — separate feature                      |
| View partial results during crawl                  | Requires live document list refresh — separate feature              |
| Sitemapless discovery wiring into crawl-site route | `DiscoveryChain` exists but isn't wired — separate ticket           |
| Depth-based link following                         | Discovery already finds URLs — not needed for bulk                  |
| Plan-based page quotas                             | Metering data recorded but not gated — billing integration separate |

---

## Success Metrics

| Metric                       | Current                                | Target                                               |
| ---------------------------- | -------------------------------------- | ---------------------------------------------------- |
| Progress visibility          | 0% → stuck (no events)                 | 0% → 100% per-page                                   |
| Section fill accuracy        | Always 0/N                             | Matches actual ingested pages per section            |
| Discovery-to-crawl fidelity  | 226 selected → 522 crawled (recursive) | 226 selected → 226 fetched                           |
| Rendering mode honoured      | Never (HTTP-only)                      | Correct per group strategy                           |
| robots.txt honoured          | Never                                  | Always enforced                                      |
| Time to first progress event | Never arrives                          | < 5 seconds after crawl start                        |
| Crawl cancellation           | Unreliable                             | < 5 seconds, partial results preserved               |
| Concurrent tenant crawls     | Blocked (per-tenant lock)              | Multiple (with per-tenant concurrency cap)           |
| LLM cost during bulk crawl   | $0 (Go) but no quality                 | $0 (handler reuse + Readability) with quality gating |
| Re-crawl dedup               | Creates duplicates                     | Updates existing, detects changes                    |

---

## Review Findings Addressed

This document was reviewed and updated to address these findings:

| Finding                                            | Severity | Resolution                                                                                                                  |
| -------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| Cancel has no cooperative cancellation mechanism   | CRITICAL | Added cancel design to O5: Redis signal + per-page check                                                                    |
| "Zero LLM" contradicts quality gating              | CRITICAL | Clarified: quality gate is heuristic ($0). No LLM fallback — Readability is the fallback. See O1 extraction strategy table. |
| Re-crawl scenario unaddressed                      | CRITICAL | Added O8: Re-Crawl Support with dedup, change detection, stale cleanup                                                      |
| robots.txt enforcement has no implementation path  | HIGH     | Added implementation note to O2: needs `robots-parser` + token-bucket rate limiter                                          |
| Progress event types don't match existing infra    | HIGH     | O3 now uses existing event types (`job_started`, `url_fetched`, `document_processed`, `job_completed`, `job_failed`)        |
| "Serverless-ready" conflicts with MCP client state | HIGH     | Downgraded to "serverless-friendly" in O7. MVP is BullMQ worker; per-URL purity enables future extraction.                  |
| No plan limit / quota enforcement                  | HIGH     | Added explicit "not enforced in V2" note to O7 + out of scope                                                               |
| No notification for background crawl completion    | MEDIUM   | Added notification design to O5: activity bar polling + KB page banner + draft persistence                                  |
| Draft persistence not mentioned                    | MEDIUM   | Added to O5 background notification section                                                                                 |
| Service restart mid-crawl lock deadlock            | MEDIUM   | Added to O6: lock TTL must be shorter than retry delay                                                                      |
| O8 ordering risk (removing Go before replacement)  | MEDIUM   | Added dependency note to O9: must follow O1-O6                                                                              |
| Concurrent crawl concurrency model unclear         | MEDIUM   | Clarified in O7: multiple jobs per tenant, cap on total page fetches                                                        |
