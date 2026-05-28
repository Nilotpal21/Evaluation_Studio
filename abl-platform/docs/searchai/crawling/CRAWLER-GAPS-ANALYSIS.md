# Crawler System — Gap Analysis

> Generated: 2026-03-17
> Source: Full codebase exploration of implemented vs targeted design

## Critical Path Blocker

The **Readability content preservation** issue blocks the entire crawl-to-search pipeline.
Until fixed, crawled content cannot produce chunks, cannot get indexed, and cannot be searched.

```
Readability (8% preserved) → 0 chunks → 0% indexed → crawled content unusable
```

---

## Gap Details

### 🔴 CRITICAL

| #   | Gap                             | Current State                                                                                                              | Targeted State                         | Blocker                                                                  | Est. Effort       |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ | ----------------- |
| C-1 | Content preservation            | 8% preserved (Readability strips 98%)                                                                                      | 90%+ preserved                         | Readability config too aggressive in `services/readability/index.ts`     | 8-12 hrs          |
| C-2 | Zero chunks produced            | 0 chunks from crawled content                                                                                              | 10-50 chunks per page                  | Blocked by C-1 — extraction has nothing to chunk                         | Resolves with C-1 |
| C-3 | Zero indexing success           | 0% of crawled content searchable                                                                                           | 85%+ indexed                           | Blocked by C-2 — no chunks to embed/index                                | Resolves with C-1 |
| C-4 | Link-following payload mismatch | Node sends `options: { followLinks, maxPages, maxDepth }`, Go expects `strategy: { ... }` — `CrawlRecursive` NEVER invoked | Recursive crawling discovers full site | Field name mismatch between `crawl.ts` job payload and Go `processor.go` | 1-2 days          |

### 🟡 HIGH

| #   | Gap                                                  | Current State                                                                                         | Targeted State                                       | Impact                                                                                       | Est. Effort |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------- |
| H-1 | CrawlPattern model not registered                    | Model exists in `packages/database` but NOT in `apps/search-ai/src/db/index.ts`                       | Registered, usable via `getLazyModel()`              | Pattern caching broken in search-ai context; `MongoPatternStore` may use wrong DB connection | 30 min      |
| H-2 | TenantCrawlPolicy model not registered               | Same as H-1                                                                                           | Registered, usable via `getLazyModel()`              | Tenant policy enforcement broken in search-ai context                                        | 30 min      |
| H-3 | Redis memory leak on crawl queues                    | `removeOnComplete: false`, `removeOnFail: false` on `static-crawl` queue jobs (crawl.ts line 749-751) | Jobs cleaned after completion                        | Unbounded Redis memory growth in production                                                  | 1-2 hrs     |
| H-4 | Crawler ingestion worker excluded from health checks | Not in `workers[]` array (started separately at index.ts line 240)                                    | Included in `getWorkerStatus()` / `getWorkerCount()` | Silent worker death not detected by monitoring                                               | 2-3 hrs     |
| H-5 | Go BullMQ protocol fragility                         | Go worker manually implements BullMQ Redis protocol in `consumer.go`                                  | Stable protocol layer or versioned contract tests    | Any BullMQ version change breaks Go worker silently                                          | Medium      |
| H-6 | Sitemap URL extraction missing                       | `FastProfiler` detects sitemaps (HEAD request) but has no URL extraction method                       | Extract URLs from `sitemap.xml` for discovery        | Only user-provided URLs are crawled; no sitemap discovery                                    | 1-2 days    |

### 🟠 MEDIUM

| #   | Gap                                             | Current State                                                                               | Targeted State                                                                                             | Impact                                                            | Est. Effort |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------- |
| M-1 | MCP Playwright not integrated into crawl flow   | `apps/crawler-mcp-server/` exists with 13 tools, not wired to crawl pipeline                | Track 2 browser worker handles SPA/JS-heavy sites (25% of target)                                          | Cannot crawl JavaScript-rendered content                          | Large       |
| M-2 | Agent-driven crawling not integrated            | Design docs + example exist, ABL agent not in crawl flow                                    | Track 3 agent handles complex sites (login walls, CAPTCHAs, infinite scroll) — <5% of sites                | Cannot handle interactive/protected sites                         | Large       |
| M-3 | Learning engine not started                     | No outcome capture or pattern reinforcement                                                 | Crawl outcomes feed back into DecisionEngine Level 4 ("Learned Pattern"), reducing user involvement to <5% | Every crawl requires full decision flow; no improvement over time | ~40 hrs     |
| M-4 | Transparency UI not built                       | `TransparencyService` emits 35+ event types, no React component                             | `DecisionTimeline` component shows why decisions were made                                                 | Users cannot see why a strategy was chosen                        | ~12 hrs     |
| M-5 | Tenant crawl policy has no admin UI             | `TenantCrawlPolicy` model exists with limits + compliance fields                            | Admin panel for setting domain-level crawl policies per tenant                                             | No governance/compliance controls for admins                      | Medium      |
| M-6 | No scheduled/recurring crawls                   | Crawling is purely user-initiated (manual click)                                            | Cron-based re-crawl scheduler (similar to `permission-recrawl-scheduler.ts`)                               | Content goes stale; users must manually re-crawl                  | Medium      |
| M-7 | Sequential batch processing in ingestion worker | `for (const result of results)` loop (crawler-ingestion-worker.ts line 161)                 | Parallel processing with concurrency control                                                               | Large crawl batches process slowly                                | 1-2 days    |
| M-8 | Route shadowing risk                            | `crawl.ts` and `crawl-history.ts` both mount at `/api/crawl` with overlapping `/jobs` paths | Deduplicated route mounts or namespace separation                                                          | Potential route conflicts in Express                              | 2-3 hrs     |
| M-9 | UI exposes ~35% of backend capabilities         | Many documented flows only partially implemented in Studio                                  | Full feature parity between backend API and frontend UI                                                    | Users cannot access most crawler intelligence features            | Large       |

### 🔵 LOW

| #   | Gap                                                           | Current State                                             | Targeted State                           | Notes                              |
| --- | ------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------- | ---------------------------------- |
| L-1 | `CrawlJob._id` uses `batch-{timestamp}-{random}` format       | Inconsistent with other models using UUIDv7               | UUIDv7 or consistent ID scheme           | Non-breaking but inconsistent      |
| L-2 | Content keyword filtering happens after Readability           | Full HTML cleaned before filtering (wasted processing)    | Filter before expensive Readability pass | Minor performance optimization     |
| L-3 | Dashboard endpoint performance                                | Multiple aggregations per request with `maxTimeMS: 15000` | Cached/pre-computed dashboard stats      | Could be slow for large crawl jobs |
| L-4 | Connector-permission-crawl-worker instantiates at import time | Creates Redis connection even when not needed (line 148)  | Lazy initialization                      | Minor resource waste               |

---

## Recommended Fix Order

### Phase 1: Unblock the Pipeline (C-1 → C-3 resolve together)

Fix Readability content preservation → chunks get produced → indexing works → **crawled content becomes searchable**.

```
Fix Readability config ──▶ Content preserved ──▶ Chunks created ──▶ Indexed ──▶ Searchable
    (8-12 hrs)                  (90%+)              (10-50/page)     (85%+)
```

### Phase 2: Quick Wins (1-2 days total)

- H-1 + H-2: Register CrawlPattern + TenantCrawlPolicy in `db/index.ts` (~1 hr)
- H-3: Add `removeOnComplete`/`removeOnFail` to crawl queue jobs (~1 hr)
- C-4: Fix payload field mismatch (`options` → `strategy`) to enable recursive crawling (~1 day)

### Phase 3: Discovery & Reliability (1-2 weeks)

- H-6: Implement sitemap URL extraction in FastProfiler
- H-4: Add crawler-ingestion-worker to health check monitoring
- H-5: Add contract tests for Go-BullMQ protocol compatibility
- M-7: Parallelize batch processing in ingestion worker
- M-8: Resolve route shadowing

### Phase 4: Intelligence & Browser (3-4 weeks)

- M-1: Wire MCP Playwright into crawl flow (Track 2)
- M-3: Build Learning Engine (outcome capture → pattern reinforcement)
- M-4: Build TransparencyUI (DecisionTimeline component)
- M-5: Tenant crawl policy admin UI

### Phase 5: Full Vision (6-8 weeks)

- M-2: Agent-driven crawling integration (Track 3)
- M-6: Scheduled recurring crawl scheduler
- M-9: Full UI feature parity with backend API

---

## Key File References

| Area                        | File                                                         |
| --------------------------- | ------------------------------------------------------------ |
| Readability service         | `apps/search-ai/src/services/readability/index.ts`           |
| Crawl routes (batch submit) | `apps/search-ai/src/routes/crawl.ts`                         |
| Go worker processor         | `apps/crawler-go-worker/internal/processor/processor.go`     |
| Go worker consumer          | `apps/crawler-go-worker/internal/queue/consumer.go`          |
| Crawler ingestion worker    | `apps/search-ai/src/workers/crawler-ingestion-worker.ts`     |
| Crawler ingestion service   | `apps/search-ai/src/services/ingestion/crawler-ingestion.ts` |
| Worker registration         | `apps/search-ai/src/workers/index.ts`                        |
| DB model registration       | `apps/search-ai/src/db/index.ts`                             |
| FastProfiler                | `packages/crawler/src/profiler/fast-profiler.ts`             |
| DecisionEngine              | `packages/crawler/src/decision/decision-engine.ts`           |
| StrategyResolver            | `packages/crawler/src/strategy/resolver.ts`                  |
| CrawlJob model              | `packages/database/src/models/crawl-job.model.ts`            |
| CrawlPattern model          | `packages/database/src/models/crawl-pattern.model.ts`        |
| TenantCrawlPolicy model     | `packages/database/src/models/tenant-crawl-policy.model.ts`  |
| MCP server                  | `apps/crawler-mcp-server/src/`                               |
| Studio crawl API            | `apps/studio/src/api/crawl.ts`                               |
| Studio CrawlerTab           | `apps/studio/src/components/search-ai/CrawlerTab.tsx`        |
