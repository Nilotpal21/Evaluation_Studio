# Crawler System Architecture

> **Source-of-truth reference** for the web crawler subsystem in abl-platform.
> All paths, ports, queues, and models verified against code.
>
> Last verified: 2026-04-30

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Service Topology](#2-service-topology)
3. [Package Structure — packages/crawler/](#3-package-structure--packagescrawler)
4. [API Surface](#4-api-surface)
   - 4.1 [crawl.ts — Bulk Crawl with Intelligence Profiling](#41-crawlts--bulk-crawl-with-intelligence-profiling)
   - 4.2 [crawl-discover.ts — HTTP Recursive Discovery](#42-crawl-discoverts--http-recursive-discovery)
   - 4.3 [crawl-browser-discover.ts — Browser-Based Discovery via MCP](#43-crawl-browser-discoverts--browser-based-discovery-via-mcp)
   - 4.4 [crawl-drafts.ts — Draft Persistence](#44-crawl-draftsts--draft-persistence)
   - 4.5 [crawl-preview.ts — Content Preview](#45-crawl-previewts--content-preview)
   - 4.6 [intelligence.ts — Intelligence Crawl](#46-intelligencets--intelligence-crawl)
   - 4.7 [crawler-ingestion.ts — Ingestion Pipeline Entry](#47-crawler-ingestionts--ingestion-pipeline-entry)
5. [Workers](#5-workers)
6. [Queue Topology](#6-queue-topology)
7. [Go Worker — apps/crawler-go-worker/](#7-go-worker--appscrawler-go-worker)
8. [MCP Server — apps/crawler-mcp-server/](#8-mcp-server--appscrawler-mcp-server)
9. [Database Models](#9-database-models)
10. [Real-Time Communication](#10-real-time-communication)
11. [Inter-Service Communication](#11-inter-service-communication)
12. [Security Considerations](#12-security-considerations)
13. [Architecture Gaps and Tech Debt](#13-architecture-gaps-and-tech-debt)

---

## 1. System Overview

The crawler system acquires web content for SearchAI knowledge bases. Its core design challenge is supporting two very different crawl modes — **high-throughput bulk crawling** (hundreds of pages, static HTML) and **intelligent single-page extraction** (JavaScript-heavy sites, interactive elements, LLM-guided content analysis) — within a single user-facing workflow.

To handle this, the architecture separates concerns across four services:

- **Search-AI** orchestrates everything: it hosts the API routes that Studio calls, runs background workers, and coordinates the other services. It's the control plane.
- **Go Worker** handles the fast path — bulk HTTP crawling via Colly, optimized for throughput when a site is simple and the URL list is known.
- **Crawler MCP Server** handles the smart path — Playwright browser automation for sites that require JavaScript rendering, navigation, or interaction. It exposes both MCP protocol tools (for LLM-driven page exploration) and REST endpoints (for programmatic discovery).
- **Studio UI** provides the user-facing `CrawlFlowV5` slide panel — a multi-step wizard that guides users through site profiling → URL discovery → section review → configuration → crawl submission.

The system uses **BullMQ queues** (Redis-backed) to decouple producers from consumers, enabling the Go worker and intelligence worker to process jobs independently. Real-time feedback flows through two channels: **WebSocket** (via Redis pub/sub) for crawl progress events, and **SSE** for discovery streaming.

```
 Studio UI                Search-AI                  Crawler MCP Server
 (port 5173)              (port 3005)                (port 3100)
 +-----------+            +------------------+       +------------------+
 | CrawlFlow |--REST/WS-->| crawl routes     |--REST-| Playwright       |
 |   V5      |            | workers          |--MCP--| browser pool     |
 +-----------+            +--------+---------+       +------------------+
                                   |
                          BullMQ (Redis)
                                   |
                          +--------+---------+
                          | Go Worker        |
                          | (Colly HTTP)     |
                          +------------------+
```

**Services at a glance:**

| Service            | Location                   | Port                 | Role                                           |
| ------------------ | -------------------------- | -------------------- | ---------------------------------------------- |
| Search-AI          | `apps/search-ai/`          | 3005                 | Control plane: API routes, workers, queue mgmt |
| Crawler MCP Server | `apps/crawler-mcp-server/` | 3100                 | Playwright browser automation, MCP tools       |
| Go Worker          | `apps/crawler-go-worker/`  | N/A (queue consumer) | High-throughput HTTP bulk crawl (Colly/Go)     |
| Studio UI          | `apps/studio/`             | 5173                 | CrawlFlowV5 wizard, draft management           |

**Supporting package:** `packages/crawler/` — shared algorithms, profiler, decision engine, intelligence service. This package is consumed by Search-AI routes and workers; it contains no server code of its own.

---

## 2. Service Topology

The diagram below shows the full data flow. A crawl begins in Studio, passes through Search-AI for orchestration, then fans out to either the Go Worker (bulk path) or MCP Server (browser path). Both paths converge back into Search-AI's ingestion worker, which feeds the standard Docling extraction pipeline.

```
+----------------------------------------------------------+
|                     Studio (Next.js)                      |
|  CrawlFlowV5 slide panel                                 |
|  HTTP REST to /api/crawl/*   WebSocket for progress       |
+----+---------------------+-------------------------------+
     |                     |
     | REST                | WS (progress:{jobId})
     v                     v
+----------------------------------------------------------+
|                  Search-AI (Express)                      |
|                                                          |
|  Routes (7 modules):                                     |
|    /api/crawl/batch           (bulk crawl submission)    |
|    /api/crawl/discover        (HTTP recursive discovery) |
|    /api/crawl/discover/browser (Playwright via MCP)      |
|    /api/crawl/drafts          (draft CRUD)               |
|    /api/crawl/preview         (content preview)          |
|    /api/crawl/intelligence/*  (LLM analysis)             |
|    /api/crawler/ingest/*      (ingestion pipeline)       |
|                                                          |
|  Workers (2):                                            |
|    intelligence-crawl-worker  (queue: intelligence-crawl)|
|    crawler-ingestion-worker   (queue: content-processing)|
+----+--------------------+----+---------------------------+
     |                    |    |
     | BullMQ             |    | REST + MCP protocol
     | (Redis)            |    |
     v                    |    v
+-------------------+     |  +-----------------------------+
| Go Worker (Colly) |     |  | Crawler MCP Server          |
|                   |     |  |                             |
| Queue in:         |     |  | Playwright browser pool     |
|   static-crawl    |     |  | MCP tools (navigate, click, |
| Queue out:        |     |  |   extract, screenshot, etc.)|
|   content-        |     |  | REST: /api/explore*         |
|   processing      |     |  | SSE: real-time events       |
+-------------------+     |  +-----------------------------+
                          |
                          v
               +---------------------+
               | Docling Pipeline    |
               | (downstream)        |
               +---------------------+
```

**Why four services instead of one?** Each service has fundamentally different resource characteristics. The Go Worker is CPU/network-bound and benefits from Go's concurrency model. The MCP Server manages long-lived browser processes that are memory-heavy and latency-sensitive. Search-AI is the I/O-bound orchestrator. Keeping them separate allows independent scaling and deployment.

---

## 3. Package Structure — packages/crawler/

The `packages/crawler/` package contains all shared crawl logic — algorithms, decision-making, and intelligence services — consumed by Search-AI's routes and workers. It has no server code; it's a pure library. The package follows a layered design: **profiler** understands a site's structure, **decision engine** picks the best crawl strategy, **disclosure** asks the user when the decision is ambiguous, and **intelligence** runs the LLM-powered extraction loop.

Barrel exports from `packages/crawler/src/index.ts`:

| Directory                     | Purpose                                                                            | Key Exports                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `profiler/`                   | Site profiling: HTTP headers, sitemap detection, JS framework detection            | `FastProfiler`, `CachedProfiler`, `ProfilerFactory`          |
| `pattern-store/`              | MongoDB-backed cache for site profiles                                             | `MongoPatternStore`                                          |
| `decision/`                   | Autonomous crawl strategy selection                                                | `DecisionEngine`, `TenantPolicyStore`, `UserPreferenceStore` |
| `disclosure/`                 | Progressive disclosure: generates user-facing questions when decision is ambiguous | `QuestionGenerator`, `PromptEvaluator`, `ResponseProcessor`  |
| `strategy/`                   | Resolves crawl strategy from decision + user responses                             | `StrategyResolver`                                           |
| `intelligence/`               | LLM-powered 4-phase crawl intelligence loop                                        | `CrawlIntelligenceService`, `prompts.ts`, `types.ts`         |
| `intelligence/algorithms/`    | 13 algorithms (see below)                                                          | `DiscoveryChain`, `LinkScorer`, `PlatformDetector`, etc.     |
| `intelligence/handler-store/` | MongoDB persistence for handler templates                                          | `MongoHandlerStore`                                          |
| `intelligence/utils/`         | URL heuristics and helper utilities                                                | `url-heuristics.ts`                                          |
| `types/`                      | Shared type definitions                                                            | `DiscoveredUrl`, `UrlConfidence`, `PageRole`                 |

### Intelligence Algorithms (`intelligence/algorithms/`)

| Algorithm               | Purpose                                             |
| ----------------------- | --------------------------------------------------- |
| `DiscoveryChain`        | Orchestrates multi-phase URL discovery              |
| `LinkScorer`            | Scores discovered links by relevance                |
| `PlatformDetector`      | Identifies CMS/framework (WordPress, Shopify, etc.) |
| `UrlClusterer`          | Clusters URLs by path-segment patterns              |
| `TemplateFingerprinter` | Detects duplicate page templates                    |
| `PaginationDetector`    | Identifies paginated content                        |
| `InteractiveDetector`   | Detects pages requiring JS/interaction              |
| `IntentDecomposer`      | Breaks crawl intent into sub-tasks                  |
| `QualityGate`           | Pass/fail quality checks on extracted content       |
| `JsonLdExtractor`       | Extracts structured data from JSON-LD               |
| `FailureScorer`         | Scores and classifies extraction failures           |
| `HandlerReuser`         | Matches pages to saved handler templates            |
| `HttpAdapter`           | HTTP-only extraction fallback (no browser)          |

---

## 4. API Surface

Seven route modules handle the crawl API, all mounted at `/api/crawl` except crawler-ingestion which mounts at `/api/crawler`. They are registered in `apps/search-ai/src/server.ts` (lines 249-255) in a specific order — intelligence routes first (so `/intelligence/*` paths aren't captured by other routers).

The routes reflect the crawl lifecycle: **discover** URLs on a site → **draft** a selection → **preview** individual pages → **submit** a bulk crawl → **ingest** results. The intelligence path is a parallel workflow for LLM-powered single-page analysis.

### 4.1 crawl.ts — Bulk Crawl with Intelligence Profiling

This is the primary crawl submission route. When a user submits URLs, it profiles the site, runs the `DecisionEngine` to pick a crawl strategy, and either enqueues directly to the Go Worker or returns progressive-disclosure questions for the user to answer first.

| Method | Path                  | Purpose                                                                                                            |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| POST   | `/batch`              | Submit bulk crawl job. Profiles site, runs DecisionEngine, may return questions or enqueue to `static-crawl` queue |
| POST   | `/batch/respond`      | Respond to pending decision questions, then enqueue                                                                |
| GET    | `/preview-urls`       | Preview URL expansion from sitemap                                                                                 |
| POST   | `/profile`            | Profile a URL (returns SiteProfile)                                                                                |
| POST   | `/cluster-urls`       | Cluster URLs by path patterns using UrlClusterer                                                                   |
| POST   | `/sample-groups`      | Sample URL groups for pre-crawl analysis                                                                           |
| GET    | `/status`             | Crawl queue status                                                                                                 |
| GET    | `/dashboard/:jobId`   | Dashboard view for a crawl job                                                                                     |
| GET    | `/history`            | List past crawl jobs                                                                                               |
| GET    | `/preferences`        | Get user crawl preferences                                                                                         |
| POST   | `/preferences`        | Save user crawl preferences                                                                                        |
| DELETE | `/preferences/:id`    | Delete a preference                                                                                                |
| GET    | `/pages/:jobId`       | List crawled pages for a job                                                                                       |
| POST   | `/jobs/:jobId/cancel` | Cancel a running crawl                                                                                             |
| DELETE | `/jobs/:jobId`        | Delete crawl job and associated data                                                                               |
| DELETE | `/jobs/:jobId/pages`  | Delete pages from a job                                                                                            |

### 4.2 crawl-discover.ts — HTTP Recursive Discovery

The lightweight discovery path — uses HTTP requests (no browser) to recursively explore a site's URL structure using pattern-guided heuristics. Fast but limited to sites with link-based navigation. Progress streams via SSE directly from Search-AI.

In-memory state: `Map`, max 50 entries, 30-minute TTL. **⚠️ No SSRF protection** — see [Security Gaps](#known-security-gaps).

| Method | Path                   | Purpose                                                     |
| ------ | ---------------------- | ----------------------------------------------------------- |
| POST   | `/discover`            | Start HTTP pattern-guided recursive crawl                   |
| POST   | `/discover/deepen`     | Fan-out using warm URLs + API URLs from browser exploration |
| GET    | `/discover/:id`        | SSE stream of progress events                               |
| POST   | `/discover/:id/stop`   | Stop discovery                                              |
| GET    | `/discover/:id/result` | Final discovery results                                     |

### 4.3 crawl-browser-discover.ts — Browser-Based Discovery via MCP

The heavy-weight discovery path — launches a Playwright browser via the MCP Server to explore sites that require JavaScript rendering, navigation clicks, or form interaction. Search-AI acts as an SSE proxy: it receives events from the MCP Server and relays them to Studio, adding intervention support (users can redirect the browser, add samples, skip branches). This is the path used for complex sites like SPAs or sites behind JS-rendered navigation.

In-memory state: `Map`, max 20 entries, 30-minute TTL.

| Method | Path                                 | Purpose                                                                                               |
| ------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| POST   | `/discover/browser`                  | Start Playwright exploration via MCP server                                                           |
| GET    | `/discover/browser/:id`              | SSE stream proxied from MCP server                                                                    |
| POST   | `/discover/browser/:id/stop`         | Stop exploration                                                                                      |
| GET    | `/discover/browser/:id/result`       | Final exploration results                                                                             |
| POST   | `/discover/browser/:id/intervention` | User interventions: `stop`, `add-sample`, `explore-branch`, `skip-branch`, `explore-all`, `undo-skip` |

### 4.4 crawl-drafts.ts — Draft Persistence

After discovery, users review and curate URLs before submitting a crawl. Drafts persist this intermediate state — the selected URL sections, configuration overrides, and section-level URL lists. URLs are stored in buckets (500 per bucket) to handle large sites without hitting MongoDB document size limits. Drafts use optimistic concurrency (version field) to prevent lost updates when multiple tabs edit the same draft.

| Method | Path                                        | Purpose                                           |
| ------ | ------------------------------------------- | ------------------------------------------------- |
| POST   | `/drafts`                                   | Create draft + SearchSource with `status='draft'` |
| GET    | `/drafts`                                   | List current user's drafts                        |
| GET    | `/drafts/:draftId`                          | Get single draft                                  |
| PATCH  | `/drafts/:draftId`                          | Update with optimistic concurrency                |
| DELETE | `/drafts/:draftId`                          | Delete draft + cascade                            |
| PUT    | `/drafts/:draftId/sections/:sectionId/urls` | Bulk-write URLs (bucket pattern, 500 per bucket)  |
| GET    | `/drafts/:draftId/sections/:sectionId/urls` | Paginated URL fetch                               |

### 4.5 crawl-preview.ts — Content Preview

| Method | Path       | Purpose                                                                         |
| ------ | ---------- | ------------------------------------------------------------------------------- |
| POST   | `/preview` | Readability extraction preview. SSRF-protected. Rate limited: 10 req/min/tenant |

### 4.6 intelligence.ts — Intelligence Crawl

The LLM-powered crawl path. Instead of simply fetching HTML and extracting with Readability, intelligence crawl runs a 4-phase analysis loop per page: navigate → extract → evaluate quality → decide next action. It can reuse saved handler templates for pages with similar structure (e.g., all product pages on the same site), dramatically reducing LLM calls for repetitive content. The multi-page variant (`/crawl-site`) runs as a background BullMQ job with heavy rate limiting (5/hr) since each crawl makes many LLM calls.

| Method | Path                              | Purpose                                                                         |
| ------ | --------------------------------- | ------------------------------------------------------------------------------- |
| POST   | `/intelligence/analyze`           | Single-page 4-phase LLM analysis via MCP. Rate limited: 1 concurrent + 30/hr    |
| GET    | `/intelligence/status/:jobId`     | Analysis status from Redis                                                      |
| POST   | `/intelligence/save`              | Save analysis result to knowledge base                                          |
| POST   | `/intelligence/crawl-site`        | Multi-page intelligence crawl via BullMQ `intelligence-crawl` queue. 5/hr limit |
| GET    | `/intelligence/crawl-site/:jobId` | Per-page crawl status                                                           |

### 4.7 crawler-ingestion.ts — Ingestion Pipeline Entry

Mounted at `/api/crawler` (not `/api/crawl`).

| Method | Path                         | Purpose                                                                                    |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------------ |
| POST   | `/ingest/crawled-content`    | Ingest raw HTML: Readability extraction, S3 upload, SearchDocument creation, Docling queue |
| GET    | `/ingest/status/:documentId` | Ingestion status for a document                                                            |

---

## 5. Workers

Two BullMQ workers handle the async crawl processing. They run inside the Search-AI process but consume from separate queues, allowing independent concurrency tuning. The intelligence worker is intentionally single-concurrency with long locks because each job makes dozens of LLM calls and browser interactions — running multiple in parallel would overwhelm both the LLM budget and the MCP Server's browser pool. The ingestion worker runs at concurrency 3 since it's I/O-bound (Readability extraction + S3 upload).

### intelligence-crawl-worker.ts

| Setting          | Value                       |
| ---------------- | --------------------------- |
| Queue            | `intelligence-crawl`        |
| Concurrency      | 1 (sequential)              |
| Distributed lock | Per-tenant, Redis-based     |
| Lock TTL         | 10 min, renewed every 5 min |
| Job timeout      | 60 min                      |

**Processing pipeline per URL:**

1. Crash recovery check
2. Route decision: HTTP vs Playwright (via `InteractiveDetector`)
3. Quality gate evaluation
4. Handler reuse check (match against saved `HandlerTemplate`)
5. Full LLM intelligence loop if no reusable handler
6. Ingest via `CrawlerIngestionService`

**Algorithms used:** QualityGate, InteractiveDetector, JsonLdExtractor, PaginationDetector, LinkScorer, IntentDecomposer, FailureScorer, HttpAdapter.

### crawler-ingestion-worker.ts

| Setting     | Value                      |
| ----------- | -------------------------- |
| Queue       | `content-processing`       |
| Concurrency | 3                          |
| Lock TTL    | 2 min, renewed every 1 min |

Consumes `BatchResult` from Go Worker, feeds into `CrawlerIngestionService`, produces `SearchDocument` records.

---

## 6. Queue Topology

The crawler uses three BullMQ queues to decouple the crawl lifecycle stages. This is critical because each stage has different latency, failure modes, and scaling characteristics. The bulk path is a two-hop pipeline (enqueue → Go Worker crawl → ingestion), while the intelligence path is single-hop (enqueue → intelligence worker does everything internally). Both paths converge at `CrawlerIngestionService`, which creates `SearchDocument` records and feeds the standard Docling extraction pipeline.

```
                        BULK CRAWL PATH
                        ===============

  crawl.ts POST /batch
        |
        v
  +------------------+       +-------------------+       +-------------------------+
  | static-crawl     | ----> | Go Worker (Colly) | ----> | content-processing      |
  | (BullMQ queue)   |       | HTTP bulk crawl   |       | (BullMQ queue)          |
  +------------------+       +-------------------+       +------------+------------+
                                                                      |
                                                                      v
                                                         +-------------------------+
                                                         | crawler-ingestion-      |
                                                         | worker.ts               |
                                                         |   CrawlerIngestion-     |
                                                         |   Service               |
                                                         +------------+------------+
                                                                      |
                                                                      v
                                                         +-------------------------+
                                                         | Docling pipeline        |
                                                         | (downstream)            |
                                                         +-------------------------+


                     INTELLIGENCE CRAWL PATH
                     =======================

  intelligence.ts POST /crawl-site
        |
        v
  +---------------------+       +----------------------------+
  | intelligence-crawl   | ----> | intelligence-crawl-        |
  | (BullMQ queue)       |       | worker.ts                  |
  +---------------------+       |   per-URL:                  |
                                |     MCP Server / HttpAdapter|
                                |     LLM intelligence loop   |
                                +-------------+--------------+
                                              |
                                              v
                                +----------------------------+
                                | CrawlerIngestionService    |
                                |   -> Docling pipeline      |
                                +----------------------------+
```

**Queue details:**

| Queue                | Producer                           | Consumer                       | Data Shape                                                                       |
| -------------------- | ---------------------------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| `static-crawl`       | `crawl.ts` POST /batch             | Go Worker                      | `{ JobID, BatchID, TenantID, IndexID, SourceID, URLs, Type, Strategy, Filters }` |
| `content-processing` | Go Worker                          | `crawler-ingestion-worker.ts`  | `BatchResult`                                                                    |
| `intelligence-crawl` | `intelligence.ts` POST /crawl-site | `intelligence-crawl-worker.ts` | Intelligence job payload with URL list                                           |

---

## 7. Go Worker — apps/crawler-go-worker/

The Go Worker exists because bulk HTTP crawling is fundamentally a throughput problem — fetching hundreds of pages as fast as possible with proper rate limiting and concurrency control. Go + Colly handles this better than Node.js: Colly manages connection pooling, domain-scoped rate limiting, and concurrent request scheduling natively. The Go Worker speaks BullMQ-compatible Redis protocol directly (no Node.js dependency) — it reads jobs from `static-crawl` and publishes `BatchResult` messages to `content-processing`.

| Aspect          | Detail                                                |
| --------------- | ----------------------------------------------------- |
| Language        | Go                                                    |
| Crawl library   | Colly                                                 |
| Queue input     | `static-crawl` (Redis polling, BullMQ-compatible)     |
| Queue output    | `content-processing` (publishes `BatchResult`)        |
| SSRF protection | `ssrf/validator.go`                                   |
| BullMQ compat   | Manually creates BullMQ-compatible Redis hash entries |

**Two crawl modes:**

| Mode             | Description                                                                 |
| ---------------- | --------------------------------------------------------------------------- |
| `CrawlBatch`     | Crawl an explicit list of URLs                                              |
| `CrawlRecursive` | Follow links from seed URLs using a strategy (depth, domain scope, filters) |

**Job data schema:**

```
JobID        string
BatchID      string
TenantID     string
IndexID      string
SourceID     string
ConnectionID string          // legacy field, may be empty
URLs         []string
Type         "static" | "browser"
Strategy     CrawlStrategy
Filters      URLFilters
Priority     int             // job priority (0 = default)
```

---

## 8. MCP Server — apps/crawler-mcp-server/

The MCP Server wraps Playwright in two interfaces: **MCP protocol tools** (for LLM agents to drive browser interactions programmatically) and **REST endpoints** (for Search-AI to trigger discovery explorations). Each browser session is isolated via Playwright browser contexts with a 30-minute timeout and a 50-page cap to prevent runaway resource consumption. The server has **no authentication or rate limiting** of its own — it relies entirely on network-level access control (ingress rules, pod networking). This is a known security gap documented in Section 12.

| Aspect       | Detail                                                     |
| ------------ | ---------------------------------------------------------- |
| Port         | 3100 (env: `CRAWLER_MCP_URL`)                              |
| Browser pool | Session-isolated, 30-min timeout, max 50 pages per browser |

### MCP Tools

| Tool                 | Purpose                                   |
| -------------------- | ----------------------------------------- |
| `navigate`           | Navigate to URL                           |
| `get_page_content`   | Get page HTML/text content                |
| `click_element`      | Click a DOM element                       |
| `type_text`          | Type into an input field                  |
| `scroll`             | Scroll the page                           |
| `wait_for_element`   | Wait for element to appear                |
| `extract_links`      | Extract all links from page               |
| `extract_elements`   | Extract elements by selector              |
| `take_screenshot`    | Capture page screenshot                   |
| `execute_javascript` | Run arbitrary JS in page context          |
| `get_page_state`     | Get current page state (URL, title, etc.) |

### REST Endpoints

| Method | Path                       | Purpose                                                                              |
| ------ | -------------------------- | ------------------------------------------------------------------------------------ |
| GET    | `/health`                  | Health check                                                                         |
| POST   | `/mcp`                     | MCP Streamable HTTP transport endpoint (MCP protocol)                                |
| POST   | `/api/explore`             | Single-page navigation exploration with SSE                                          |
| POST   | `/api/explore-deep`        | Multi-page depth probing with SSE. Supports resume context (`visitedUrls` up to 15K) |
| POST   | `/api/explore/:id/command` | Intervention commands                                                                |

### Explore Modules

| Module                     | Purpose                                                 |
| -------------------------- | ------------------------------------------------------- |
| `navigation-explorer.ts`   | Single-page interactive exploration                     |
| `depth-prober.ts`          | Multi-page recursive depth probing                      |
| `api-interceptor.ts`       | Intercepts XHR/fetch requests during exploration        |
| `page-classifier.ts`       | Classifies page type (article, listing, form, etc.)     |
| `nav-extractor.ts`         | Extracts navigation structure from DOM                  |
| `dom-region-classifier.ts` | Classifies DOM regions (header, content, sidebar, etc.) |
| `breadcrumb-extractor.ts`  | Extracts breadcrumb paths                               |
| `command-queue.ts`         | Queues and dispatches intervention commands             |
| `yield-tracker.ts`         | Tracks content yield per exploration step               |

---

## 9. Database Models

The crawler adds 9 MongoDB collections to the platform database. All use `tenantIsolationPlugin` for automatic tenant scoping. The models split into three groups: **job lifecycle** (CrawlJob, CrawlHistory, CrawlAuditEvent — tracking what was crawled and when), **draft workflow** (CrawlDraft, CrawlDraftUrlBucket — persisting the user's curation before submission), and **intelligence infrastructure** (CrawlPattern, TenantCrawlPolicy, UserCrawlPreference, HandlerTemplate — the decision engine's configuration and learned templates).

| Model                 | Collection                | Purpose                                                  |
| --------------------- | ------------------------- | -------------------------------------------------------- |
| `CrawlJob`            | `crawl_jobs`              | Active and completed crawl jobs                          |
| `CrawlHistory`        | `crawl_history`           | Historical job records                                   |
| `CrawlAuditEvent`     | `crawl_audit_events`      | Audit trail for crawl actions                            |
| `CrawlDraft`          | `crawl_drafts`            | User draft configurations before crawl submission        |
| `CrawlDraftUrlBucket` | `crawl_draft_url_buckets` | URL storage for drafts (bucket pattern, 500 URLs/bucket) |
| `CrawlPattern`        | `crawl_patterns`          | Cached site profiles and URL patterns                    |
| `TenantCrawlPolicy`   | `tenant_crawl_policies`   | Per-tenant crawl policies and limits                     |
| `UserCrawlPreference` | `user_crawl_preferences`  | Per-user crawl preference storage                        |
| `HandlerTemplate`     | `handler_templates`       | Saved extraction handler templates for handler reuse     |

---

## 10. Real-Time Communication

Real-time feedback is essential for crawl UX — users need to see discovery progress, crawl status, and page-by-page results as they happen. The system uses two transport mechanisms because they serve different access patterns: **WebSocket** for bidirectional progress events (job lifecycle, page counts), and **SSE** for unidirectional discovery streams (URL-by-URL discovery events that can produce hundreds of events per session).

### WebSocket (progress events)

```
  Search-AI worker/route
        |
        | Redis pub/sub
        v
  progress.ts  ──────>  Studio (CrawlFlowV5)
  Channel: progress:{jobId}
```

**Events:** `job_started`, `document_processed`, `job_completed`, `job_failed`, `intelligence_*`

### Server-Sent Events (SSE)

| Source                      | Transport                                      | Consumer                 |
| --------------------------- | ---------------------------------------------- | ------------------------ |
| `crawl-discover.ts`         | Direct SSE from Search-AI                      | Studio                   |
| `crawl-browser-discover.ts` | Proxied SSE (Search-AI proxies MCP server SSE) | Studio                   |
| MCP Server `/api/explore*`  | Direct SSE                                     | Search-AI (then proxied) |

---

## 11. Inter-Service Communication

```
  +----------+    REST + WS     +------------+    REST + MCP     +-----------+
  |  Studio  | ───────────────> | Search-AI  | ────────────────> | MCP       |
  |          | <─────────────── |            | <──────────────── | Server    |
  +----------+  /api/crawl/*    +------+-----+   /api/explore*   +-----------+
                                       |
                                BullMQ (Redis)
                                       |
                               +-------+--------+
                               |  Go Worker     |
                               +----------------+
```

| From      | To         | Protocol                    | Details                                                  |
| --------- | ---------- | --------------------------- | -------------------------------------------------------- |
| Studio    | Search-AI  | HTTP REST + WebSocket       | All `/api/crawl/*` endpoints, `progress:{jobId}` channel |
| Search-AI | MCP Server | REST (fetch) + MCP protocol | REST for `/api/explore*`, `MCPClient` for tool calls     |
| Search-AI | Go Worker  | BullMQ (Redis)              | Jobs enqueued on `static-crawl`                          |
| Go Worker | Search-AI  | BullMQ (Redis)              | `BatchResult` published to `content-processing`          |

---

## 12. Security Considerations

Security in the crawler is layered: URL validation prevents SSRF, rate limiting prevents abuse, distributed locks prevent resource exhaustion, and tenant isolation prevents cross-tenant data access. However, coverage is uneven — some routes have comprehensive protection while others have gaps (see below).

### Protections in Place

| Control                                | Location                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| SSRF protection on URL inputs          | `crawl-browser-discover.ts`, `crawl-preview.ts`, Go worker `ssrf/validator.go` |
| Rate limiting: intelligence/analyze    | 1 concurrent + 30 requests/hr                                                  |
| Rate limiting: intelligence/crawl-site | 5 requests/hr                                                                  |
| Rate limiting: preview                 | 10 requests/min/tenant                                                         |
| Per-tenant distributed locks           | Intelligence crawl worker (Redis `SET NX PX`)                                  |

### Known Security Gaps

| Gap                                        | Risk                                                              | Location                     |
| ------------------------------------------ | ----------------------------------------------------------------- | ---------------------------- |
| `crawl-discover.ts` has no SSRF protection | Accepts arbitrary `baseUrl`/`sampleUrls` without URL validation   | `apps/search-ai/src/routes/` |
| MCP server has no authentication           | Relies entirely on ingress-level access control                   | `apps/crawler-mcp-server/`   |
| MCP server has no rate limiting            | Unbounded resource consumption                                    | `apps/crawler-mcp-server/`   |
| `execute_javascript` MCP tool              | Remote code execution in browser context                          | `apps/crawler-mcp-server/`   |
| Shared browser pool                        | Cross-tenant session isolation relies on Playwright contexts only | `apps/crawler-mcp-server/`   |

---

## 13. Architecture Gaps and Tech Debt

The biggest architectural limitation is **in-memory state for discovery sessions**. Both `crawl-discover.ts` and `crawl-browser-discover.ts` store active discovery state in a `Map` — this means discovery doesn't survive pod restarts and can't run across multiple pods. The second major gap is the lack of **automatic escalation** from the bulk HTTP path to the browser path — when the Go Worker encounters a JS-heavy page, the extraction silently fails rather than re-queuing to the intelligence path.

### Architecture Gaps

| #   | Gap                                                                                   | Impact                                                                   | Mitigation Path                                     |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| 1   | In-memory state for discovery (`Map` in crawl-discover.ts, crawl-browser-discover.ts) | Not multi-pod safe; discovery state lost on restart                      | Migrate to Redis-backed state                       |
| 2   | SSE bypasses Next.js proxy                                                            | Requires dedicated ingress routing in production                         | Add ingress rules or WebSocket fallback             |
| 3   | No quality-driven retry pipeline                                                      | Failed extractions are not automatically retried with different strategy | Add retry queue with HTTP-to-Playwright escalation  |
| 4   | No auto-escalation HTTP to Playwright                                                 | Pages requiring JS interaction fail silently in bulk path                | Wire InteractiveDetector result into re-queue logic |
| 5   | Single-sample prefix cap heuristic                                                    | URL pattern detection accuracy limited by small sample size              | Increase sample diversity in UrlClusterer           |
