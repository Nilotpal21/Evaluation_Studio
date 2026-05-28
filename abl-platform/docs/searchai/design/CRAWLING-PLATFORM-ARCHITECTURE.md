# Crawling Platform — Architecture (UX-traced)

**Status:** Living. **Method:** walk the actual code path that fires when a user clicks **Add Source** in Studio today, then catalogue everything else as either _adjacent_, _legacy_, or _dead_.
**Render hint:** monospace preview required for the ASCII diagrams.

**Related (deeper) documents:**

| Topic                                       | Document                                                   |
| ------------------------------------------- | ---------------------------------------------------------- |
| BFS phases, UX states, algorithm intent     | `docs/searchai/design/DISCOVERY-ALGORITHM.md`              |
| Build sequencing, learnings, constants      | `docs/searchai/design/DISCOVERY-IMPLEMENTATION.md`         |
| Crawl v2 objectives, HLD/LLD                | `docs/specs/crawl-v2.hld.md`, `docs/specs/crawl-v2.lld.md` |
| Older end-to-end topology (partially stale) | `docs/searchai/design/CRAWLER-SYSTEM-ARCHITECTURE.md`      |

---

## 0. The word "crawl" appears in three unrelated places

| Term in code                                                                             | Real subject                                                                | Hits arbitrary URLs?                               |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------- |
| **Web crawl** — `bulk-crawl-worker`, `intelligence-crawl-worker`, the `bulk-crawl` queue | Public web pages                                                            | Yes                                                |
| **Permission crawl** — `connector-permission-crawl-worker`, `permission-recrawl-worker`  | SharePoint **ACLs** for documents already synced via a connector            | No                                                 |
| **Discovery** — `routes/discovery.ts`, `bfs-discovery.ts`, `connector-discovery-worker`  | URL/resource **inventory** (BFS over a site, or Graph API over a connector) | Discovery itself fetches pages, but it’s pre-crawl |

The rest of the doc treats only the **first** as “crawling”.

---

## 1. UX trace — what fires when a user clicks **Add Source**

This is the single source of truth. Everything else in the codebase is described relative to whether **this** flow uses it.

### 1.1 Entry and routing

```
User clicks "Add Source"
  apps/studio/src/components/search-ai/data/AddSourceButton.tsx
    -> Dialog opens with ConnectorCatalog
       apps/studio/src/components/search-ai/data/ConnectorCatalog.tsx
    -> User picks "Web Crawler" tile
       -> handleWebModeRequested() sets webMode = 'crawl-v5'
       -> CrawlFlowPanel (SlidePanel) opens, mounting:
          apps/studio/src/components/search-ai/crawl-flow/CrawlFlowV5.tsx
```

`AddSourceButton` does **not** call `/api/crawl/*` for the web path — it just hands off to `CrawlFlowV5`. For non-web sources (`file`, `database`, `api`, `sharepoint`) it calls `addSource()` directly and stops; those branches do not crawl.

### 1.2 State machine inside `CrawlFlowV5`

`CrawlFlowState = 'url-entry' | 'analyzing' | 'configure' | 'crawling' | 'done'`

```
State1UrlEntry  ──URL──▶  State2Analysis  ──sections──▶  State3Configure  ──Start crawl──▶  State4Crawl
   |                            |                                                                |
   |                            |                                                                |
   |       (every transition writes/updates a CrawlDraft via /api/crawl/drafts)                  |
   |                            |                                                                |
   |                            +-- runAnalysis():                                               |
   |                            |     POST /api/crawl/profile                                    |
   |                            |     POST /api/crawl/cluster-urls   (sitemap groups bucketed)   |
   |                            |     POST /api/crawl/sample-groups                              |
   |                            |                                                                |
   |                            +-- StrategySelector renders TWO options:                        |
   |                            |     [A] crawl-sitemap     -> use clustered groups, Continue    |
   |                            |     [B] guided-discovery  -> renders UnifiedDiscoveryPanel:    |
   |                            |             POST /api/crawl/discovery/start                    |
   |                            |             GET  /api/crawl/discovery/:id/stream  (SSE)        |
   |                            |             POST /api/crawl/discovery/:id/stop                 |
   |                            |             tree -> treeToSections() -> sections               |
   |                            |                                                                |
   |                            +-- Optional "Test extraction" widget for ONE URL:               |
   |                                  POST /api/crawl/intelligence/crawl-site                    |
   |                                  GET  /api/crawl/intelligence/crawl-site/:jobId             |
   |                                  (preview only — no source created, no batch enqueued)      |
                                                                                                  |
                                                                                                  v
                                                                              handleStartCrawl():
                                                                                getSectionUrls(...)   (paginated bucket reads)
                                                                                addSource()           (creates SearchSource)
                                                                                submitBatchCrawl()    => POST /api/crawl/batch
                                                                                                          { urls, sectionMapping,
                                                                                                            crawlSettings,
                                                                                                            options.skipPrompts: true }
                                                                                                |
                                                                                                v
                                                                                 BullMQ queue: "bulk-crawl"
                                                                                                |
                                                                                                v
                                                                       apps/search-ai/src/workers/bulk-crawl-worker.ts
                                                                                                |
                                                                                                v
                                                                       crawlerIngestionService.ingestCrawledContent (in-process)
                                                                                                |
                                                                                                v
                                                                        BullMQ: "docling-extraction" -> page-processing ->
                                                                        canonical-mapper -> enrichment -> embedding -> index
```

### 1.3 What that means for the URLs that exist in code

Every request the **Add Source web flow** can actually make:

| When                          | Studio call                          | Search-AI route                                                       | Producer / side effect                                       |
| ----------------------------- | ------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| State 1 submit                | `checkDomain()`                      | `GET /api/search-ai/indexes/:indexId/check-domain`                    | none                                                         |
| First state transition        | `createCrawlDraft()`                 | `POST /api/crawl/drafts`                                              | writes `CrawlDraft`                                          |
| Every state transition        | `updateCrawlDraft()`                 | `PATCH /api/crawl/drafts/:id`                                         | writes `CrawlDraft`                                          |
| State 2 auto-analysis         | `profileSite()`                      | `POST /api/crawl/profile`                                             | none (read-only)                                             |
| State 2 auto-analysis         | `clusterUrls()`                      | `POST /api/crawl/cluster-urls`                                        | writes section URL buckets (sitemap-derived)                 |
| State 2 auto-analysis         | `sampleGroups()`                     | `POST /api/crawl/sample-groups`                                       | none                                                         |
| State 2, guided strategy      | `startDiscovery()`                   | `POST /api/crawl/discovery/start`                                     | upserts `TenantDiscovery`, in-memory `activeDiscoveries` map |
| State 2, guided strategy      | `EventSource`                        | `GET /api/crawl/discovery/:id/stream`                                 | SSE proxy of MCP BFS                                         |
| State 2, guided strategy      | `stopDiscovery()` / `discoverMore()` | `POST /api/crawl/discovery/:id/...`                                   | command queue on MCP                                         |
| State 2, discovery write-back | section bucket writes                | `PUT /api/crawl/drafts/:id/sections/:sectionId/urls`                  | writes draft buckets                                         |
| State 2, “Test extraction”    | `startIntelligenceAnalysis()`        | `POST /api/crawl/intelligence/crawl-site`                             | enqueues `intelligence-crawl` for **one** URL                |
| State 2, “Test extraction”    | `getIntelligenceStatus()`            | `GET /api/crawl/intelligence/crawl-site/:jobId`                       | none                                                         |
| State 3                       | `analyzeRobotsTxt()`                 | `POST /api/crawl/robots`                                              | none                                                         |
| State 3 → 4                   | `getSectionUrls()`                   | `GET /api/crawl/drafts/:id/sections/:sectionId/urls?offset&limit=100` | reads buckets                                                |
| State 3 → 4                   | `addSource()`                        | `POST /api/search-ai/indexes/:indexId/sources`                        | creates `SearchSource`                                       |
| State 3 → 4                   | `submitBatchCrawl()`                 | `POST /api/crawl/batch`                                               | enqueues `bulk-crawl`                                        |
| State 4                       | `getCrawlDashboard()`                | `GET /api/crawl/dashboard/:jobId`                                     | none                                                         |
| State 4                       | `cancelCrawlJob()`                   | `POST /api/crawl/jobs/:jobId/cancel`                                  | writes cancel flag in Redis                                  |

Everything else under `/api/crawl/*` is **not reachable from Add Source** in the current UX.

### 1.4 Compact ASCII for §1.2

```
+--------------------------- Studio: Add Source ---------------------------+
|                                                                          |
|   AddSourceButton                                                        |
|        |                                                                 |
|        v                                                                 |
|   ConnectorCatalog (Web Crawler tile)                                   |
|        |                                                                 |
|        v                                                                 |
|   CrawlFlowPanel  ->  CrawlFlowV5  state machine                        |
|        |                |                                                |
|        |   State1 URL   |  State2 Analysis              State3 Configure |
|        |     |          |    profile + cluster + sample      |           |
|        |     |          |          \                         |  State4   |
|        |     |          |   crawl-sitemap   guided-discovery |  poll +   |
|        |     |          |          \         |               |  cancel   |
|        |     |          |           \   UnifiedDiscoveryPanel|           |
|        |     |          |            \      |                |           |
|        |     |          |             \     v                |           |
|        |     |          |              \   SSE BFS via MCP   |           |
|        |     |          |               \   |                v           |
|        |     |          |                \  v          POST /crawl/batch |
|        +-----+----------+-----------------> sections -----> bulk-crawl   |
+--------------------------------------------------------------------------+
                                                |
                                                v
                              Search-AI worker: bulk-crawl-worker
                                                |
                                                v
                              crawlerIngestionService.ingestCrawledContent
                                                |
                                                v
                       docling-extraction -> ... -> embedding -> OpenSearch
```

---

## 2. Workers, queues, and routes — labelled by what §1 actually uses

### 2.1 Used by the Add Source web flow

| Component                                                                                                                                                                                                                                                                                              | Queue / Path                   | Role in §1                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/routes/crawl.ts`                                                                                                                                                                                                                                                                   | `/api/crawl/*`                 | Hosts `profile`, `cluster-urls`, `sample-groups`, `robots`, `batch`, `dashboard`, `jobs/:id/cancel`, plus `drafts/:id/sections/:id/urls`. Producer for `bulk-crawl`. |
| `apps/search-ai/src/routes/crawl-drafts.ts`                                                                                                                                                                                                                                                            | `/api/crawl/drafts/*`          | Draft CRUD + section bucket reads/writes.                                                                                                                            |
| `apps/search-ai/src/routes/discovery.ts`                                                                                                                                                                                                                                                               | `/api/crawl/discovery/*`       | Used only when the user picks **guided-discovery**. SSE proxy to `crawler-mcp-server`.                                                                               |
| `apps/search-ai/src/routes/intelligence.ts`                                                                                                                                                                                                                                                            | `/api/crawl/intelligence/*`    | Only the **Test extraction** widget (single URL). Producer for `intelligence-crawl`.                                                                                 |
| `apps/crawler-mcp-server`                                                                                                                                                                                                                                                                              | `POST /api/bfs-discover` + SSE | Runs BFS when guided-discovery is chosen.                                                                                                                            |
| **Worker: `bulk-crawl-worker.ts`**                                                                                                                                                                                                                                                                     | `bulk-crawl`                   | The only crawl worker the main flow enqueues.                                                                                                                        |
| `crawlerIngestionService` (in-process module, not a worker)                                                                                                                                                                                                                                            | n/a                            | Called by `bulk-crawl-worker` per URL. Enqueues `docling-extraction`.                                                                                                |
| Ingestion pipeline workers (`docling-extraction`, `page-processing`, `canonical-mapper`, `enrichment`, `embedding`, plus the conditional `kg-enrichment`, `multimodal`, `visual-enrichment`, `tree-building`, `question-synthesis`, `scope-classification`, `vocabulary-generation`, `taxonomy-setup`) | various                        | Always hit downstream of `crawlerIngestionService`. Not crawl.                                                                                                       |

### 2.2 Conditionally used by the Add Source web flow

| Component                                                   | When used                                                          | Notes                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `discovery.ts` + `crawler-mcp-server` BFS engine            | Only when State 2 strategy is **guided-discovery**                 | The default path is sitemap-clustering, so BFS is **opt-in** today.                                               |
| `intelligence-crawl-worker.ts` (queue `intelligence-crawl`) | Only via the State 2 **Test extraction** widget, with a single URL | The main "Start crawl" button **never** enqueues here — it always enqueues `bulk-crawl` with `skipPrompts: true`. |

### 2.3 Not used by the Add Source web flow (but workers still start)

| Component                                                                                                                                             | What it is                                                        | Why §1 does not touch it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/crawler-go-worker` (queues `static-crawl` -> `content-processing`)                                                                              | Legacy Go HTTP crawler                                            | `routes/crawl.ts::POST /batch` enqueues `bulk-crawl`, not `static-crawl`. No producer in Studio.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `crawler-ingestion-worker.ts` (queue `content-processing`)                                                                                            | Drain path for Go-worker batches; file header is `@deprecated V2` | The Node `bulk-crawl-worker` ingests in-process via `crawlerIngestionService`, bypassing `content-processing`.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `connector-permission-crawl-worker.ts` (queue `connector-permission-crawl`)                                                                           | SharePoint ACL crawl                                              | Triggered only from `connector.service` for enterprise connectors. Nothing to do with web pages.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `connector-discovery-worker.ts` (queue `connector-discovery`)                                                                                         | SharePoint Graph resource discovery                               | Connector flow, not web.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `permission-recrawl-worker.ts` (queue `permission-recrawl`)                                                                                           | Orchestrator that re-enqueues `connector-permission-crawl` jobs   | **Consumer is not registered in `workers/index.ts::startWorkers()`** — `createPermissionRecrawlWorker` is only invoked from tests. Yet `connector.service.triggerPermissionRecrawl` enqueues to this queue.                                                                                                                                                                                                                                                                                                                                        |
| `scheduler/permission-recrawl-scheduler.ts` (`setupPermissionRecrawlScheduler`)                                                                       | Weekly cron driver for permission recrawl                         | **Never invoked from `server.ts`**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `triggerPostSyncRecrawl`                                                                                                                              | Exported helper for post-sync ACL refresh                         | **No non-test callers.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Other `/api/crawl/*` routes — `preview-urls`, `batch/respond`, `cluster-urls/preferences`, `history`, `preferences`, `pages/:jobId`, `jobs/:id/pages` | Studio surfaces from earlier UX iterations and admin tools        | `CrawlFlowV5` always submits with `options.skipPrompts: true`, so `batch/respond` is unreachable. `CrawlJobForm`, `BulkImportForm`, `UrlPreviewDialog`, `BatchPreviewPanel`, `PreviewPanel`, `CrawlJobHistory`, `CrawlJobProgress`, `CrawledPagesView`, `SourceDetailPanel`, `CrawlPreferences`, `SavePreferenceDialog`, `useCrawlPreferences` are **not imported by `AddSourceButton`/`CrawlFlowV5`**. Some are still mounted elsewhere (e.g. SourceDetailPanel for an existing source) but the **Add Source new-crawl path** never reaches them. |

### 2.4 Compact ASCII — wired vs idle

```
Producers wired to Add Source flow             Consumer

POST /api/crawl/batch  ───────────────────▶  bulk-crawl-worker
POST /api/crawl/intelligence/crawl-site ──▶  intelligence-crawl-worker      (only via Test extraction)
POST /api/crawl/discovery/start + SSE  ───▶  crawler-mcp-server BFS         (only via guided-discovery)

Producers NOT wired in current UX             Consumer status

(none)                                        crawler-go-worker  (would write content-processing)
(none)                                        crawler-ingestion-worker  (drain content-processing — deprecated header)
connector.service.startPermissionCrawl ──▶   connector-permission-crawl-worker   (active, but NOT web)
connector.service.triggerPermissionRecrawl ▶  permission-recrawl  -> NO CONSUMER REGISTERED
(would-be cron, never started)                permission-recrawl-scheduler  -> NOT STARTED
```

---

## 3. The two "discovery" things — keep them separate

**Site discovery (BFS, browser, SSE)** — implemented in `apps/crawler-mcp-server/src/explore/bfs-discovery.ts` and proxied by `apps/search-ai/src/routes/discovery.ts`. **Reachable from Add Source only via the guided-discovery strategy in State 2.**

```
Studio (useDiscovery)
  POST /api/crawl/discovery/start  +  GET .../stream (SSE)
                              |
                              v
  routes/discovery.ts:  tenant + SSRF, upsert TenantDiscovery, persist tree snapshots
                              |
                              v
  crawler-mcp-server:   POST /api/bfs-discover  ->  runBfsDiscovery + BrowserPool
                              |
                              v
  Mongo:  SiteDiscovery (per domain),  TenantDiscovery (per run)
```

**Connector discovery** — `connector-discovery-worker.ts` walks SharePoint sites/libraries via Graph API. **Never** invoked from the Add Source web flow. Lives entirely on the connector side.

---

## 4. Execution crawl — the path the user actually hits

Single producer, single consumer. Everything else marked `intelligence-crawl`, `static-crawl`, `content-processing`, or `connector-permission-crawl` is **not** in this path.

```
POST /api/crawl/batch
  routes/crawl.ts: resolves strategy, profile, decision engine, then
    queue.add('crawl-batch', { urls, sectionMapping, crawlSettings, options, tenantId, indexId, sourceId, ... })
  queue: BullMQ "bulk-crawl"
                              |
                              v
  workers/bulk-crawl-worker.ts  (concurrency 1; lockDuration 60min)
    sliding window WINDOW_SIZE = 5
    per URL:
      RobotsChecker.isAllowed (if respectRobotsTxt)
      DomainRateLimiter.acquire (with crawlDelay)
      acquireSemaphore (Redis SET NX; SEMAPHORE_MAX=20 per tenant, TTL 120s)
      Redis checkpoint + SearchDocument dedup
      strategy === 'browser' && MCPClient
        -> mcpClient.callTool('navigate', { url })
        -> mcpClient.callTool('get_page_content', { includeHtml, includeText })
        else
        -> HttpAdapter.fetch(url)  (PAGE_TIMEOUT_MS = 60_000)
      QualityGate.score(html, text)
      HandlerReuser.tryReuse (if reuseHandlers)
      crawlerIngestionService.ingestCrawledContent(...)   <-- in-process, NOT a queue
                              |
                              v
  services/ingestion/crawler-ingestion.ts
    extraction cascade (Readability + ...)
    S3 / local storage upload
    SearchDocument upsert (URL + content-hash dedup, tenantId-scoped)
    queue.add(QUEUE_DOCLING_EXTRACTION, { documentId, indexId, sourceId, tenantId, ... })
                              |
                              v
  docling-extraction -> page-processing -> canonical-mapper -> enrichment -> embedding -> OpenSearch
```

---

## 5. What is genuinely dead or misleadingly named

This list is the answer to “workers with `crawl` in the name that are **not** used for web crawling”.

| Item                                                                                                                                                                                                      | Verdict                                                                                                                                       | Recommendation                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `apps/crawler-go-worker` (Go)                                                                                                                                                                             | **Dead in current UX.** `routes/crawl.ts` no longer enqueues `static-crawl`.                                                                  | Retire after confirming no environment still produces `static-crawl`.                                                           |
| `apps/search-ai/src/workers/crawler-ingestion-worker.ts` (queue `content-processing`)                                                                                                                     | **Dead in current UX.** Header is `@deprecated V2`. Only drains Go batches.                                                                   | Remove together with the Go worker.                                                                                             |
| `apps/search-ai/src/workers/connector-permission-crawl-worker.ts`                                                                                                                                         | **Misleadingly named — not web crawling.** Active for SharePoint ACLs.                                                                        | Rename to `connector-permission-acl-worker` (or similar) in a follow-up to stop confusing reviewers.                            |
| `apps/search-ai/src/workers/permission-recrawl-worker.ts`                                                                                                                                                 | **Producer-without-consumer.** Jobs are enqueued but no worker is registered in `workers/index.ts`.                                           | Either wire `createPermissionRecrawlWorker` in `startWorkers()` or remove `connector.service.triggerPermissionRecrawl` callers. |
| `apps/search-ai/src/scheduler/permission-recrawl-scheduler.ts::setupPermissionRecrawlScheduler`                                                                                                           | **Never invoked from `server.ts`.**                                                                                                           | Wire from `server.ts` after the consumer is started, otherwise drop it.                                                         |
| `triggerPostSyncRecrawl` (exported in `permission-recrawl-worker.ts`)                                                                                                                                     | **No non-test callers.**                                                                                                                      | Remove or wire from `connector-sync-worker`.                                                                                    |
| `BulkImportForm`, `CrawlJobForm`, `UrlPreviewDialog`, `BatchPreviewPanel`, `PreviewPanel`, `CrawlJobHistory`, `CrawlJobProgress`, `CrawledPagesView`, `CrawlPreferences`, `SavePreferenceDialog` (Studio) | **Not reached from Add Source.** Some are still mounted in other surfaces (e.g. `SourceDetailPanel`) but the new-crawl path never opens them. | Audit which ones are still mounted in shipped code vs only in tests; delete the rest.                                           |
| `POST /api/crawl/batch/respond`                                                                                                                                                                           | **Unreachable from current UX** — `CrawlFlowV5` always sends `options.skipPrompts: true`.                                                     | Either delete or document as a manual-CLI escape hatch.                                                                         |
| `POST /api/crawl/preview-urls`, `/sample-groups`, `/cluster-urls/preferences`, `/preferences`, `/pages/:jobId`, `/jobs/:id/pages`, `/history`                                                             | Some are used by adjacent surfaces (`SourceDetailPanel`, admin pages). Confirm per route before deleting.                                     | Tag each as "Add-Source UX", "admin UI", or "unused" in a separate sweep.                                                       |
| `intelligence-crawl-worker.ts` for **batch** crawling                                                                                                                                                     | Earlier docs implied this is part of the main path. **It is not.**                                                                            | Document in this file only as the "Test extraction" widget backend.                                                             |

---

## 6. Persistence model (unchanged, scoped to §1)

| Model (`packages/database`) | Written by §1 step                                | Notable fields                                                                       |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ | ------- |
| `CrawlDraft`                | Every state transition                            | `flowState`, `profile`, `sections`, `strategy`, `discoveryState`, version            |
| Draft section URL buckets   | State 2 (`putSectionUrls` / discovery write-back) | Per-section URL list, capped at 100 per page                                         |
| `TenantDiscovery`           | Only when guided-discovery is selected            | `discoveryId`, seeds, selections, `crawlConfig`, status, `lastStats`                 |
| `SiteDiscovery`             | Only when guided-discovery is selected            | Per **domain**, no `tenantId`; `treeHierarchy`, `discoveredUrls`, `breadcrumbChains` |
| `SearchSource`              | State 3 -> 4 (`addSource`)                        | `sourceType: 'web'`, `sourceConfig.url`, `sections` count                            |
| `CrawlJob`                  | `POST /api/crawl/batch`                           | Lifecycle `queued -> crawling -> ingesting -> completed                              | failed` |
| `CrawlHistory`              | Same                                              | Audit                                                                                |
| `SearchDocument`            | `crawlerIngestionService` per URL                 | Tenant-scoped; dedup by URL + content hash                                           |
| `HandlerTemplate`           | `bulk-crawl-worker` handler reuse path            | Tenant + domain scoped fingerprints                                                  |

---

## 7. Cross-cutting concerns (only the parts §1 touches)

| Concern                      | Mechanism                                                                                                                                                                | Constants / files                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Tenant isolation             | Every Mongo query filters by `tenantId`; cross-tenant returns 404                                                                                                        | `routes/crawl.ts`, `routes/discovery.ts`, `bulk-crawl-worker.ts`, `crawler-ingestion.ts` |
| SSRF                         | `isURLAllowed` on seeds and link expansions                                                                                                                              | `routes/discovery.ts`, `routes/crawl.ts`, intelligence worker                            |
| SSE auth                     | `?token=` query for `EventSource` (cannot send `Authorization` header)                                                                                                   | `routes/discovery.ts`                                                                    |
| Robots.txt                   | `RobotsChecker` per worker; preload all domains                                                                                                                          | `bulk-crawl-worker.ts`                                                                   |
| Rate / concurrency           | `DomainRateLimiter`, per-tenant Redis semaphore `SEMAPHORE_MAX = 20`, `SEMAPHORE_TTL = 120s`, `WINDOW_SIZE = 5`, `PAGE_TIMEOUT_MS = 60_000`, `CHECKPOINT_TTL_S = 10_800` | `bulk-crawl-worker.ts`                                                                   |
| Snapshot back-pressure (BFS) | `PROGRESS_THROTTLE_MS = 300`, `MAX_TIMER_SNAPSHOT_URLS = 10_000`, `DEFAULT_MAX_ALL_LINKS = 50_000`                                                                       | `bfs-discovery.ts`                                                                       |
| Observability                | `publishProgressEvent`, `writeCrawlAuditEvent`, structured logs                                                                                                          | `workers/status-logger.ts`, `services/crawl-audit.service.ts`                            |

---

## 8. Build 3 — backlog inventory

### 8.1 Product / UX (`DISCOVERY-IMPLEMENTATION.md`)

| ID    | Item                         | Notes                                                                  |
| ----- | ---------------------------- | ---------------------------------------------------------------------- |
| B3-P1 | Direct URLs mode             | Paste textarea + optional sitemap-assisted expansion                   |
| B3-P2 | Quick-select patterns        | System-detected URL patterns with checkbox                             |
| B3-P3 | Custom glob / pattern filter | User pattern input with highlight                                      |
| B3-P4 | Recrawl                      | Reuse selected URLs from tenant source config without full rediscovery |
| B3-P5 | Rediscover                   | Re-run BFS; refresh `SiteDiscovery`                                    |
| B3-P6 | E2E coverage                 | Full-flow automated tests beyond Build 2 manual pass                   |
| B3-P7 | Code cleanup                 | Remove dead discovery / crawl UI or API paths (see §5)                 |

### 8.2 Resume / drafts / background UX (from `discovery-build2.lld` Deferred)

| ID    | Item                                                                                   |
| ----- | -------------------------------------------------------------------------------------- |
| B3-R1 | Typed draft model — `CrawlDraftDiscoveryState` discriminated by `_treeVersion`         |
| B3-R2 | Reconnect to running BFS via `discoveryId` + `GET .../stream`                          |
| B3-R3 | Wire `useDiscoveryStore` / `DiscoveryActivityBar` to live `totalUrls` / `totalVisited` |
| B3-R4 | Cross-tab / minimized discovery state with reconnect metadata                          |

### 8.3 Platform / scale (from `discovery-build1.lld` gap table)

| ID    | Item                                                                      |
| ----- | ------------------------------------------------------------------------- |
| B3-S1 | Redis-backed active discovery map (replace in-memory `activeDiscoveries`) |
| B3-S2 | Per-domain discovery lock across tenants (`SET NX PX`)                    |

### 8.4 Worker hygiene (uncovered by the §1 trace)

| ID    | Item                                       | Action                                                                                                                                                     |
| ----- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B3-W1 | `permission-recrawl` consumer              | Either start `createPermissionRecrawlWorker` in `workers/index.ts::startWorkers()` or remove the producer in `connector.service.triggerPermissionRecrawl`. |
| B3-W2 | `setupPermissionRecrawlScheduler`          | Wire from `server.ts` after B3-W1, or delete the file.                                                                                                     |
| B3-W3 | Decommission Go path                       | Remove `apps/crawler-go-worker` and `crawler-ingestion-worker.ts` once no `static-crawl` / `content-processing` jobs are produced.                         |
| B3-W4 | Rename `connector-permission-crawl-worker` | Stop calling ACL refresh "crawl" — reviewers keep misreading it.                                                                                           |
| B3-W5 | Audit Studio dead surfaces                 | Delete `BulkImportForm`, `CrawlJobForm`, etc. once §5 inventory is confirmed unused in shipped paths.                                                      |
| B3-W6 | Decide `POST /api/crawl/batch/respond`     | Either delete (UX always sends `skipPrompts: true`) or document as CLI-only.                                                                               |

### 8.5 Carry-forward notes

- **Virtualization:** `UnifiedTree` uses `@tanstack/react-virtual`; treat any remaining work as profiling-driven batched React state, not a new dep.
- **Nav extractor gaps:** Heading-grouped nav patterns — confirm status in `nav-extractor.ts`.
- **MCP hardening:** `CRAWLER-CONSOLIDATED-BACKLOG.md` covers MCP auth, rate limiting, `execute_javascript` risk, PDF/document transparency. Merge into Build 3 sprints explicitly.

---

## 9. File index (UX-traced)

| Layer                                | Key paths                                                                                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add Source entry                     | `apps/studio/src/components/search-ai/data/AddSourceButton.tsx`, `ConnectorCatalog.tsx`                                                                                                                                                                 |
| State machine                        | `apps/studio/src/components/search-ai/crawl-flow/CrawlFlowV5.tsx`, `State1UrlEntry.tsx`, `State2Analysis.tsx`, `StrategySelector.tsx`, `State3Configure.tsx`, `State4Crawl.tsx`, `discovery/UnifiedDiscoveryPanel.tsx`, `discovery/tree-to-sections.ts` |
| Discovery hook                       | `apps/studio/src/hooks/useDiscovery.ts`, `apps/studio/src/api/discovery.ts`                                                                                                                                                                             |
| Crawl client                         | `apps/studio/src/api/crawl.ts`, `apps/studio/src/api/search-ai.ts` (`addSource`)                                                                                                                                                                        |
| Web crawl producers                  | `apps/search-ai/src/routes/crawl.ts`, `routes/intelligence.ts`, `routes/discovery.ts`, `routes/crawl-drafts.ts`, `routes/crawl-preview.ts`                                                                                                              |
| Web crawl worker                     | `apps/search-ai/src/workers/bulk-crawl-worker.ts`                                                                                                                                                                                                       |
| MCP BFS                              | `apps/crawler-mcp-server/src/explore/bfs-discovery.ts`, `url-normalizer.ts`, `yield-tracker.ts`, `nav-extractor.ts`, `breadcrumb-extractor.ts`, `command-queue.ts`, `server.ts`                                                                         |
| Ingestion bridge                     | `apps/search-ai/src/services/ingestion/crawler-ingestion.ts`                                                                                                                                                                                            |
| Models                               | `packages/database/src/models/site-discovery.model.ts`, `tenant-discovery.model.ts`, `CrawlDraft`, `CrawlJob`, `CrawlHistory`, `SearchDocument`, `HandlerTemplate`, `SearchSource`                                                                      |
| Misleadingly named / unused (see §5) | `workers/connector-permission-crawl-worker.ts`, `workers/permission-recrawl-worker.ts`, `scheduler/permission-recrawl-scheduler.ts`, `workers/crawler-ingestion-worker.ts`, `apps/crawler-go-worker/`                                                   |

---

## 10. Maintenance contract

Update this document in the same PR whenever you:

1. Change anything in `AddSourceButton`, `CrawlFlowV5`, or its state files — the §1 trace must stay literal.
2. Add, rename, or remove a `/api/crawl/*` route.
3. Change a queue name, worker registration, or `crawlerIngestionService` contract.
4. Wire (or unwire) any consumer mentioned in §5 ("permission-recrawl", Go worker, etc.).

When a Build 3 item ships, replace its row in §8 with a link to the implementing PR.
