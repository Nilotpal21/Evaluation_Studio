# Crawl Intelligence -- System Architecture & User Journeys

This document covers the end-to-end architecture of the crawler intelligence
system: the three crawl pipelines, their components, data flow, queue topology,
user journeys, and the decision tree for routing pages.

---

## System Overview

The crawler system provides three distinct pipelines for ingesting web content.
Each pipeline serves a different use case and operates at different cost and
fidelity levels.

```
                         +-------------------+
                         |    Studio UI      |
                         | (React, Vite)     |
                         +--------+----------+
                                  |
                    +-------------+-------------+
                    |             |              |
                    v             v              v
            +-----------+  +-----------+  +-----------+
            | Analyze   |  |  Crawl    |  |   Bulk    |
            | Page      |  |  Website  |  |   HTTP    |
            | (single)  |  | (intelli- |  |  Import   |
            |           |  |  gence)   |  |           |
            +-----------+  +-----------+  +-----------+
                 |              |               |
                 v              v               v
            +---------+  +------------+  +----------+
            | MCP     |  | Intel.     |  | Go       |
            | Server  |  | Crawl      |  | Worker   |
            | (Play-  |  | Worker     |  | (Colly)  |
            | wright) |  | (Node.js)  |  |          |
            +---------+  +-----+------+  +----+-----+
                 |         |   |   |          |
                 |    +----+   |   +----+     |
                 |    |        |        |     |
                 v    v        v        v     v
            +--------+  +--------+  +-------------+
            |  LLM   |  | A1-A12 |  |  Content    |
            | (GPT/  |  | Algo-  |  |  Processing |
            | Claude)|  | rithms |  |  Pipeline   |
            +--------+  +--------+  +-------------+
                                          |
                                          v
                                   +-------------+
                                   | SearchAI    |
                                   | Index       |
                                   | (OpenSearch)|
                                   +-------------+
```

---

## Component Map

| Component                  | Package / App                                                            | Language   | Role                                                   |
| -------------------------- | ------------------------------------------------------------------------ | ---------- | ------------------------------------------------------ |
| `FastProfiler`             | `packages/crawler/src/profiler/fast-profiler.ts`                         | TypeScript | Site profiling: type detection (A1), framework ID      |
| `PlatformDetector`         | `packages/crawler/src/intelligence/algorithms/platform-detector.ts`      | TypeScript | Multi-signal platform identification (A2)              |
| `UrlClusterer`             | `packages/crawler/src/intelligence/algorithms/url-clusterer.ts`          | TypeScript | URL pattern grouping (A3)                              |
| `TemplateFingerprinter`    | `packages/crawler/src/intelligence/algorithms/template-fingerprinter.ts` | TypeScript | SimHash DOM fingerprinting (A4)                        |
| `PaginationDetector`       | `packages/crawler/src/intelligence/algorithms/pagination-detector.ts`    | TypeScript | Pagination pattern detection (A5)                      |
| `LinkScorer`               | `packages/crawler/src/intelligence/algorithms/link-scorer.ts`            | TypeScript | Link relevance scoring (A6)                            |
| `QualityGate`              | `packages/crawler/src/intelligence/algorithms/quality-gate.ts`           | TypeScript | Content quality gate (A7)                              |
| `InteractiveDetector`      | `packages/crawler/src/intelligence/algorithms/interactive-detector.ts`   | TypeScript | CSS selector-based interactive detection (A8)          |
| `IntentDecomposer`         | `packages/crawler/src/intelligence/algorithms/intent-decomposer.ts`      | TypeScript | Intent decomposition (A9)                              |
| `DiscoveryChain`           | `packages/crawler/src/intelligence/algorithms/discovery-chain.ts`        | TypeScript | 5-step sitemapless URL discovery (A10)                 |
| `FailureScorer`            | `packages/crawler/src/intelligence/algorithms/failure-scorer.ts`         | TypeScript | Escalation prediction (A11)                            |
| `JsonLdExtractor`          | `packages/crawler/src/intelligence/algorithms/jsonld-extractor.ts`       | TypeScript | JSON-LD structured data extraction (A12)               |
| `HandlerReuser`            | `packages/crawler/src/intelligence/algorithms/handler-reuser.ts`         | TypeScript | SimHash-based handler reuse (A4+A12)                   |
| `HttpAdapter`              | `packages/crawler/src/intelligence/algorithms/http-adapter.ts`           | TypeScript | SSRF-protected HTTP fetch + cheerio                    |
| `MongoHandlerStore`        | `packages/crawler/src/intelligence/handler-store/`                       | TypeScript | Persistent handler template storage                    |
| `CrawlIntelligenceService` | `packages/crawler/src/intelligence/crawl-intelligence-service.ts`        | TypeScript | LLM intelligence loop (MAP, UNDERSTAND, BUILD, REPLAY) |
| intelligence-crawl-worker  | `apps/search-ai/src/workers/intelligence-crawl-worker.ts`                | TypeScript | BullMQ worker: multi-page intelligence crawl           |
| crawler-ingestion-worker   | `apps/search-ai/src/workers/crawler-ingestion-worker.ts`                 | TypeScript | BullMQ worker: content processing + ingestion          |
| `CrawlerIngestionService`  | `apps/search-ai/src/services/ingestion/crawler-ingestion.ts`             | TypeScript | Content ingestion into SearchAI index                  |
| crawler-go-worker          | `apps/crawler-go-worker/` (main: `cmd/worker/main.go`)                   | Go         | Bulk HTTP crawl via Colly framework                    |
| crawler-mcp-server         | `apps/crawler-mcp-server/src/server.ts`                                  | TypeScript | MCP server wrapping Playwright browser pool            |
| CrawlSiteForm              | `apps/studio/src/components/search-ai/CrawlSiteForm.tsx`                 | TypeScript | Studio UI: crawl configuration form                    |

---

## Pipeline Architecture

### Pipeline 1: Single Page Analysis

Analyzes a single URL using Playwright + LLM. Used for preview before
committing to a full crawl.

```
Studio                    SearchAI                       MCP Server
  |                          |                              |
  |  POST /analyze           |                              |
  |  { url, intent }         |                              |
  +------------------------->|                              |
  |                          |                              |
  |                          |  MCP: navigate(url)          |
  |                          +----------------------------->|
  |                          |                              | Playwright:
  |                          |                              |   launch browser
  |                          |  MCP: get_page_content       |   navigate to URL
  |                          +----------------------------->|   wait for network
  |                          |  { html, text, links }       |   idle
  |                          |<-----------------------------+
  |                          |                              |
  |                          | LLM loop:                    |
  |                          |   Phase 1: MAP (structure)   |
  |                          |   Phase 2: UNDERSTAND        |
  |                          |   Phase 3: BUILD HANDLER     |
  |                          |   Phase 4: REPLAY            |
  |                          |                              |
  |  preview response        |                              |
  |  { content, schema,      |                              |
  |    extractedFields }     |                              |
  |<-------------------------+                              |
```

**Cost:** 2-4 LLM calls, 1 Playwright session. Latency: 5-15 seconds.

### Pipeline 2: Intelligence Crawl (Main Pipeline)

The primary crawl pipeline. Discovers URLs, profiles the site, routes each page
to the optimal extraction path, and ingests content.

```
                            PRE-CRAWL
                            =========

Studio                    SearchAI
  |                          |
  |  POST /crawl/profile     |
  |  { url }                 |
  +------------------------->|
  |                          |  FastProfiler.profile()
  |                          |    A1: detectSiteType()
  |                          |    A2: PlatformDetector.detect()
  |                          |    fetch sitemap.xml
  |  { siteType, platform,   |
  |    sitemapUrls, ... }    |
  |<-------------------------+
  |                          |
  |  POST /crawl/cluster-urls|
  |  { sitemapUrls }         |
  +------------------------->|
  |                          |  if no sitemap:
  |                          |    A10: DiscoveryChain.discover()
  |                          |  A3: UrlClusterer.cluster()
  |  { groups: UrlGroup[] }  |
  |<-------------------------+
  |                          |
  |  POST /crawl/sample-groups (optional)
  |  { groups }              |
  +------------------------->|
  |                          |  A11: sample 3 pages/group via HTTP
  |                          |  A7 + A8: evaluate samples
  |  { groupStrategies[] }   |
  |<-------------------------+
  |                          |
  |  POST /intelligence/crawl-site
  |  { url, intent, maxPages,|
  |    maxLlmCalls,          |
  |    groupStrategies }     |
  +------------------------->|
  |                          |  enqueue to BullMQ
  |                          |  queue: intelligence-crawl
```

```
                            PER-PAGE LOOP
                            =============

intelligence-crawl-worker
  |
  |  for each URL in discovery queue:
  |
  |  1. ROUTING (A11)
  |  +--------------------------------------------------+
  |  | if groupStrategies available:                     |
  |  |   find group for URL -> use group.method          |
  |  | else:                                             |
  |  |   HTTP fetch first -> FailureScorer.score()       |
  |  |   shouldEscalate? -> Playwright : HTTP            |
  |  +--------------------------------------------------+
  |
  |  2. FETCH CONTENT
  |  +--------------------------------------------------+
  |  | HTTP path:                                        |
  |  |   HttpAdapter.fetch(url)                          |
  |  |   -> { html, text, links }                        |
  |  |   if failed -> fallback to Playwright             |
  |  |                                                   |
  |  | Playwright path:                                  |
  |  |   MCP navigate(url) -> get_page_content           |
  |  |   -> { html, text }                               |
  |  +--------------------------------------------------+
  |
  |  3. CHEERIO PARSE-ONCE (all algorithms share one $)
  |     const $ = cheerio.load(html);
  |
  |  4. QUALITY GATE (A7)
  |  +--------------------------------------------------+
  |  | QualityGate.scoreWithDom($, text)                 |
  |  | if shouldBlock:                                   |
  |  |   emit intelligence_page_blocked -> skip page     |
  |  +--------------------------------------------------+
  |
  |  5. PARALLEL ANALYSIS
  |  +--------------------------------------------------+
  |  | A8:  InteractiveDetector.detectWithDom($)         |
  |  | A12: JsonLdExtractor.extractWithDom($)            |
  |  | A5:  PaginationDetector.detectWithDom($, url)     |
  |  | A6:  LinkScorer.scoreLinksWithDom($, links, url)  |
  |  +--------------------------------------------------+
  |
  |  6. EXTRACTION PATH SELECTION
  |  +--------------------------------------------------+
  |  | if jsonLd.canSkipLlm:                             |
  |  |   -> JSON-LD extraction (0 LLM calls)             |
  |  |                                                   |
  |  | else if HandlerReuser.findMatch(fingerprint):     |
  |  |   -> Handler reuse (0 LLM calls)                  |
  |  |                                                   |
  |  | else if budget remaining:                         |
  |  |   -> Full intelligence loop (2+ LLM calls)        |
  |  |      MAP -> UNDERSTAND -> BUILD HANDLER -> REPLAY |
  |  |      Register new handler in library              |
  |  |                                                   |
  |  | else:                                             |
  |  |   -> Budget exhausted, skip LLM extraction        |
  |  +--------------------------------------------------+
  |
  |  7. INGESTION
  |     CrawlerIngestionService.ingestCrawledContent()
  |     -> content-processing pipeline -> OpenSearch index
  |
  |  8. PROGRESS
  |     emit intelligence_page_complete via WebSocket
  |     { url, method, qualityScore, llmCalls, ... }
  |
  |  9. LINK DISCOVERY
  |     Add relevant links (score > threshold) to queue
  |     Check: same domain, not visited, within budget
```

**Crash recovery:**

- Layer 1: Redis checkpoints per URL (survives worker restart)
- Layer 2: SearchDocument existence check (survives Redis flush)

**Resource management:**

- Per-tenant distributed lock (one crawl per tenant)
- LLM budget enforcement (`maxLlmCalls`)
- Job timeout (60 min default)
- MCP client cleanup in finally block

### Pipeline 3: Bulk HTTP Import

High-throughput static crawl via Go worker + Colly. No LLM, no Playwright.
Fastest path for sites known to serve complete content via HTTP.

```
Studio                    SearchAI              Go Worker
  |                          |                      |
  |  POST /batch             |                      |
  |  { urls[], config }      |                      |
  +------------------------->|                      |
  |                          |  enqueue to BullMQ   |
  |                          |  queue: static-crawl  |
  |                          +--------------------->|
  |                          |                      |
  |                          |                      | Colly:
  |                          |                      |   concurrent HTTP
  |                          |                      |   respect robots.txt
  |                          |                      |   rate limiting
  |                          |                      |   SSRF validation
  |                          |                      |
  |                          |  results via BullMQ   |
  |                          |<---------------------+
  |                          |                      |
  |                          | content-processing   |
  |                          | pipeline             |
  |                          |   -> ingestion       |
  |                          |   -> OpenSearch      |
```

**Cost:** 0 LLM calls, 0 Playwright sessions. Pure HTTP + Colly.
Throughput: hundreds of pages per minute.

---

## Queue Topology

All inter-service communication uses BullMQ queues backed by Redis.

```
+---------------------+     +---------------------------+
| Producer            |     | Consumer                  |
+=====================+=====+===========================+
| SearchAI routes     | --> | intelligence-crawl        |
| (crawl-site)        |     | (intelligence-crawl-      |
|                     |     |  worker.ts)               |
+---------------------+-----+---------------------------+
| SearchAI routes     | --> | static-crawl              |
| (batch-crawl)       |     | (crawler-go-worker,       |
|                     |     |  Go/Colly)                |
+---------------------+-----+---------------------------+
| Intelligence worker | --> | search-ingestion          |
| Go worker           |     | (crawler-ingestion-       |
|                     |     |  worker.ts)               |
+---------------------+-----+---------------------------+
| Ingestion worker    | --> | search-page-processing    |
|                     |     | search-extraction         |
|                     |     | search-embedding          |
|                     |     | search-enrichment         |
|                     |     | (downstream pipeline)     |
+---------------------+-----+---------------------------+
```

Queue constants defined in `packages/search-ai-sdk/src/constants.ts`:

- `QUEUE_INTELLIGENCE_CRAWL = 'intelligence-crawl'`
- `QUEUE_INGESTION = 'search-ingestion'`
- `QUEUE_PAGE_PROCESSING = 'search-page-processing'`
- `QUEUE_EXTRACTION = 'search-extraction'`
- `QUEUE_EMBEDDING = 'search-embedding'`
- Go worker queue: `static-crawl` (configured via `QUEUE_NAME` env var)

---

## User Journeys

### Journey 1: Crawl a Documentation Site

A user wants to index a Next.js documentation site with a sitemap.

**What the user sees:**

1. Opens Studio, clicks "Add Source" -> "Crawl Website"
2. Enters `https://docs.example.com` and tabs away
3. Profile card appears (1-2s): "Static HTML, Next.js, Sitemap found, ~120 pages"
4. URL groups load (1-3s): `/docs/{slug}` x 98, `/api/{version}/{slug}` x 18, `/guides/{category}/{slug}` x 4
5. Escalation preview (optional): all groups marked "HTTP sufficient"
6. Clicks "Start Crawl"
7. Progress bar fills. Stats: "98 fast / 2 AI / 0 blocked"
8. Done in ~30 seconds

**What happens behind the scenes:**

```
Profile:
  A1: detectSiteType(html) -> "static" (Next.js __NEXT_DATA__ found)
  A2: PlatformDetector.detect() -> "nextjs" (confidence 0.95)
  Sitemap: 120 URLs found

Cluster:
  A3: UrlClusterer.cluster(120 urls) -> 3 groups

Pre-crawl:
  A11: sample 3 pages/group via HTTP
  A7: quality_score > 0.7 for all samples -> "HTTP sufficient"

Per page:
  Method: HTTP (all pages)
  HttpAdapter.fetch() -> cheerio parse
  A7: QualityGate.scoreWithDom() -> all pass (rich content)
  A12: JsonLdExtractor -> no JSON-LD on doc pages
  A4/A12: HandlerReuser -> reuse after first page per group
  Ingest via CrawlerIngestionService
```

### Journey 2: Crawl a Shopify Store (No Sitemap)

A user wants to crawl a Shopify store that has no sitemap.xml.

**What the user sees:**

1. Enters `https://shop.example.com`
2. Profile card: "SPA, Shopify, No sitemap"
3. Discovery runs: "Found 847 products via Shopify API"
4. URL groups: `/products/{slug}` x 847, `/collections/{slug}` x 24
5. Escalation preview: products need "browser" (accordions detected), collections "HTTP sufficient"
6. AI budget auto-suggested: 20 LLM calls
7. Clicks "Start Crawl"
8. Stats: "24 fast / 6 AI / 810 reused / 7 JSON-LD / 0 blocked"

**What happens behind the scenes:**

```
Profile:
  A1: detectSiteType() -> "SPA"
  A2: PlatformDetector.detect() -> "shopify" (confidence 0.99)
       apiEndpoints: ['/products.json', '/collections.json']
  Sitemap: not found

Discovery:
  A10: DiscoveryChain.discover()
    Step 1 (platform-api): GET /products.json -> 847 URLs (STOP, > minUrls)

Cluster:
  A3: UrlClusterer.cluster(871 urls) -> 2 groups

Pre-crawl:
  A11: sample 3 products via HTTP
  A7: quality_score = 0.35 (thin -- accordions hide content)
  A8: interactive = 5 accordions, 2 tabs
  -> products need Playwright

  A11: sample 3 collections via HTTP
  A7: quality_score = 0.82 (rich)
  -> collections fine with HTTP

Per page (collections, HTTP path):
  HttpAdapter.fetch() -> cheerio extract -> ingest
  24 pages, 0 LLM calls

Per page (products, Playwright path):
  First 3 pages: full intelligence loop (6 LLM calls)
  A12: JsonLdExtractor -> some products have JSON-LD Product (0 LLM)
  A4: TemplateFingerprinter -> SimHash matches -> HandlerReuser (0 LLM)
  Result: 6 LLM calls for 847 pages
```

### Journey 3: Crawl a React SPA

A user wants to crawl a custom React SPA with no sitemap, no known platform,
and content hidden behind JavaScript rendering.

**What the user sees:**

1. Enters `https://app.example.com`
2. Profile card: "SPA, React, No sitemap, JS required"
3. Discovery runs: found 45 URLs via nav-BFS
4. URL groups: `/features/{slug}` x 20, `/docs/{slug}` x 15, misc x 10
5. Escalation preview: all groups "Playwright needed"
6. AI budget auto-suggested: 12 LLM calls
7. Clicks "Start Crawl"
8. Progress shows Playwright loading each page
9. Stats: "0 fast / 8 AI / 32 reused / 5 blocked"

**What happens behind the scenes:**

```
Profile:
  A1: detectSiteType() -> "SPA" (#root empty mount point)
  A2: PlatformDetector.detect() -> "react" (confidence 0.8)
  Sitemap: not found

Discovery:
  A10: DiscoveryChain.discover()
    Step 1 (platform-api): no API endpoints for React -> skip
    Step 2 (footer-mining): found /sitemap page with 30 URLs
    Step 3 (nav-bfs): <nav> links -> 15 more URLs
    Total: 45 unique URLs (> minUrls, stop)

Cluster:
  A3: UrlClusterer.cluster(45 urls) -> 3 groups

Pre-crawl:
  A11: sample 3 pages/group via HTTP
  A7: quality_score < 0.3 for ALL (empty #root div)
  A8: interactive = 0 (no content to detect interactivity on)
  -> all groups need Playwright

Per page (Playwright path):
  MCP: navigate -> get_page_content (JS executes, content renders)
  A7: QualityGate.scoreWithDom() -> most pass after Playwright
  A8: InteractiveDetector -> some pages have accordions
  First page per group: full intelligence loop
  Subsequent: SimHash match -> handler reuse
  5 pages blocked (login walls, empty after JS)
```

---

## Decision Tree -- HTTP vs Playwright vs JSON-LD

For each page in the crawl, the worker selects the extraction path:

```
                        Page URL
                           |
                           v
                  +------------------+
                  | Pre-crawl group  |     YES
                  | strategy exists? |-----------> Use group.method
                  +--------+---------+
                           | NO
                           v
                  +------------------+
                  | HTTP fetch first |
                  +--------+---------+
                           |
                           v
                  +------------------+
                  | FailureScorer    |     score < 50
                  | .score(result)   |-----------> HTTP PATH
                  +--------+---------+
                           | score >= 50
                           v
                      PLAYWRIGHT PATH
                           |
                           v
               (both paths merge here)
                           |
                           v
                  +------------------+
                  | cheerio.load()   |
                  | (parse once)     |
                  +--------+---------+
                           |
                           v
                  +------------------+
                  | A7: QualityGate  |     shouldBlock
                  | .scoreWithDom()  |-----------> BLOCKED (skip)
                  +--------+---------+
                           | pass
                           v
                  +------------------+
                  | A12: JSON-LD     |     canSkipLlm
                  | .extractWithDom()|-----------> JSON-LD PATH
                  +--------+---------+              (0 LLM calls)
                           | no JSON-LD
                           v
                  +------------------+
                  | A4: Fingerprint  |     match found
                  | HandlerReuser    |-----------> REUSE PATH
                  | .findMatch()     |              (0 LLM calls)
                  +--------+---------+
                           | no match
                           v
                  +------------------+
                  | LLM budget left? |     NO
                  +--------+---------+-----------> SKIP (no budget)
                           | YES
                           v
                  FULL INTELLIGENCE LOOP
                  MAP -> UNDERSTAND ->
                  BUILD HANDLER -> REPLAY
                  (2-4 LLM calls)
                           |
                           v
                  Register handler in library
                  for future reuse
```

---

## Cost Model

| Path               | Time/Page | LLM Calls | When Used                              |
| ------------------ | --------- | --------- | -------------------------------------- |
| JSON-LD            | ~100ms    | 0         | Pages with Schema.org structured data  |
| HTTP + Reuse       | ~200ms    | 0         | Static pages matching known template   |
| HTTP + Cheerio     | ~300ms    | 0         | Static pages, first extraction attempt |
| Playwright + Reuse | ~2s       | 0         | SPA pages matching known template      |
| Playwright + LLM   | ~8-15s    | 2-4       | First page of each new template        |
| Go/Colly batch     | ~50ms     | 0         | Bulk import mode (Pipeline 3)          |

**Typical crawl of 1000 pages:**

| Scenario                | LLM Calls | Time     | Estimated Cost |
| ----------------------- | --------- | -------- | -------------- |
| Naive (LLM per page)    | 2000-4000 | ~4 hours | $80-160        |
| With handler reuse only | 20-40     | ~30 min  | $2-4           |
| With full A1-A12        | 10-30     | ~5 min   | $0.50-1.50     |

---

## Data Flow -- WebSocket Events to Studio UI

Progress events flow from the intelligence crawl worker through Redis pub/sub
to the Studio frontend via WebSocket.

```
intelligence-crawl-worker
  |
  | publishProgressEvent()
  |   type: intelligence_page_complete
  |   data: { url, method, qualityScore,
  |           llmCalls, reused, jsonLdUsed,
  |           interactiveFlags, ... }
  |
  v
+----------+      +-----------+      +----------+
| Redis    | ---> | WebSocket | ---> | Studio   |
| Pub/Sub  |      | Gateway   |      | Browser  |
| channel: |      | (Express  |      |          |
| crawl:   |      |  ws)      |      |          |
| {jobId}  |      |           |      |          |
+----------+      +-----------+      +----------+
                                          |
                                          v
                                   useMultiPageProgress()
                                   (React hook)
                                          |
                         +----------------+----------------+
                         |                |                |
                         v                v                v
                   Stats Bar        Group Progress    Timeline
                   fast/AI/         per-group bars    per-page
                   blocked/         with method       entries
                   reused counts    indicators        with algo
                                                      labels
```

**WebSocket event types emitted by the worker:**

| Event Type                    | Payload                                                   | When Emitted           |
| ----------------------------- | --------------------------------------------------------- | ---------------------- |
| `intelligence_page_complete`  | url, method, qualityScore, llmCalls, reused, jsonLdUsed   | After each page        |
| `intelligence_page_blocked`   | url, reason, qualityScore                                 | When A7 blocks a page  |
| `intelligence_page_phase`     | url, phase, phaseDetail                                   | During LLM loop phases |
| `intelligence_crawl_complete` | totalPages, fastCount, aiCount, blockedCount, reusedCount | When job finishes      |
| `intelligence_crawl_progress` | processed, total, currentUrl                              | Periodic progress      |

**Studio components consuming events:**

| Component              | Hook/Source            | Events Consumed                 |
| ---------------------- | ---------------------- | ------------------------------- |
| `IntelligenceProgress` | `useMultiPageProgress` | all progress + complete         |
| `CrawledPagesView`     | `useMultiPageProgress` | page_complete + page_blocked    |
| `CrawlSiteForm`        | API responses          | profile + cluster-urls (not WS) |

---

## Appendix: File Index

All algorithm source files under `packages/crawler/src/intelligence/algorithms/`:

```
discovery-chain.ts        -- A10 DiscoveryChain (sitemapless discovery)
failure-scorer.ts         -- A11 FailureScorer (escalation prediction)
handler-reuser.ts         -- A4+A12 HandlerReuser (template-based handler reuse)
http-adapter.ts           -- HttpAdapter (SSRF-protected HTTP fetch)
intent-decomposer.ts      -- A9 IntentDecomposer (intent decomposition)
interactive-detector.ts   -- A8 InteractiveDetector (CSS selector detection)
jsonld-extractor.ts       -- A12 JsonLdExtractor (JSON-LD structured data)
link-scorer.ts            -- A6 LinkScorer (link relevance scoring)
pagination-detector.ts    -- A5 PaginationDetector (pagination pattern detection)
platform-detector.ts      -- A2 PlatformDetector (multi-signal platform ID)
quality-gate.ts           -- A7 QualityGate (content quality gate)
template-fingerprinter.ts -- A4 TemplateFingerprinter (SimHash DOM fingerprinting)
types.ts                  -- Shared types (CrawlResult, CrawlResultLink)
url-clusterer.ts          -- A3 UrlClusterer (URL pattern clustering)
```

Worker entry point:

```
apps/search-ai/src/workers/intelligence-crawl-worker.ts
```

Go worker:

```
apps/crawler-go-worker/cmd/worker/main.go
apps/crawler-go-worker/internal/crawler/colly.go
```

MCP server:

```
apps/crawler-mcp-server/src/server.ts
apps/crawler-mcp-server/src/browser/pool.ts
apps/crawler-mcp-server/src/tools/navigate.ts
apps/crawler-mcp-server/src/tools/content.ts
```
