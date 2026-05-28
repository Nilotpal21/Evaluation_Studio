# Feature Spec: Web Crawling

> **Feature Slug:** web-crawling
> **Status:** ALPHA
> **Owner:** SearchAI Team
> **Created:** 2026-03-23
> **Last Updated:** 2026-04-23

---

## 1. Problem Statement

ABL Platform users need to ingest web content (documentation sites, knowledge bases, marketing pages, support articles) into SearchAI for agent-powered retrieval. Currently, users must manually upload documents. There is no integrated web crawling capability that allows users to provide a URL and have the system automatically discover, crawl, extract, and index web content into a knowledge base.

### 1.1 Business Context

- **Competitor gap:** Decagon and Sierra offer integrated web crawling; Kore.ai's legacy platform had basic web scraping but no intelligent crawling
- **User friction:** Manual document upload is the #1 barrier to SearchAI adoption for customers with existing web-based knowledge (documentation sites, FAQs, help centers)
- **Revenue impact:** Enterprise customers with 5,000+ page documentation sites need automated ingestion -- manual upload is not viable

### 1.2 Core Problem

Users cannot provide a URL and have the ABL platform automatically:

1. Profile the target site (static vs SPA, sitemap availability, estimated size)
2. Decide on an optimal crawl strategy (single-page, sitemap-based, smart discovery)
3. Execute the crawl at scale (Go workers for static HTML, Playwright for JS-heavy sites)
4. Clean and extract meaningful content (Readability for noise removal)
5. Ingest into the SearchAI pipeline (extraction, chunking, embedding, indexing)
6. Provide real-time progress and history tracking

---

## 2. Scope

### 2.1 In Scope

| Area                       | Description                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Site Profiling**         | Auto-detect site type, sitemap, JS requirements, estimated size                                        |
| **Strategy Selection**     | 5-level decision hierarchy (user override > preferences > tenant policy > learned patterns > defaults) |
| **Progressive Disclosure** | Ask user only when confidence is low; auto-start when preferences exist                                |
| **Crawl Execution**        | Go worker for static HTML (Colly, 10k req/s), MCP server for browser automation (Playwright)           |
| **SSRF Protection**        | Block private IPs, link-local, cloud metadata endpoints                                                |
| **Content Ingestion**      | Readability cleanup, S3 storage, Docling extraction, SearchAI pipeline                                 |
| **Real-Time Progress**     | WebSocket streaming via Redis pub/sub across pods                                                      |
| **Job Management**         | Submit, cancel, retry, history with filtering and search                                               |
| **Circuit Breaker**        | Protect against problematic domains (rate limits, persistent failures)                                 |
| **Tenant Isolation**       | All queries scoped by tenantId; cross-tenant returns 404                                               |

### 2.2 Out of Scope

| Area                                      | Reason                                                            |
| ----------------------------------------- | ----------------------------------------------------------------- |
| **Scheduled/recurring crawls**            | Deferred to v2; requires cron infrastructure                      |
| **Delta sync (crawl only changed pages)** | Requires content fingerprinting; deferred to v2                   |
| **Authentication-gated sites**            | Complex (OAuth, session cookies); deferred to v2                  |
| **CAPTCHA solving**                       | Ethical and legal concerns; manual escalation only                |
| **Custom extraction selectors**           | Agent-driven extraction handles this; manual selectors are legacy |
| **Kubernetes HPA auto-scaling**           | Deploy-time concern, not application logic                        |

---

## 3. Requirements

### 3.1 Functional Requirements

| ID    | Requirement                                                                                                     | Priority | Source                        |
| ----- | --------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------- |
| FR-1  | User provides a URL; system profiles the site and returns metadata (type, sitemap, size estimate, JS detection) | P0       | User story 1                  |
| FR-2  | System selects an optimal crawl strategy using 5-level decision hierarchy                                       | P0       | Architecture doc              |
| FR-3  | System prompts user only when decision confidence < 0.7 or policy violations exist                              | P1       | Progressive disclosure design |
| FR-4  | Bulk crawl jobs are submitted to BullMQ and processed by Go workers (static) or MCP server (browser)            | P0       | Architecture doc              |
| FR-5  | SSRF protection blocks private IPs, link-local, cloud metadata before any crawl                                 | P0       | Security requirement          |
| FR-6  | Crawled HTML is cleaned via Readability, stored in S3, and enqueued for Docling extraction                      | P0       | Ingestion pipeline            |
| FR-7  | Real-time progress is streamed via WebSocket (Redis pub/sub for multi-pod)                                      | P1       | User experience               |
| FR-8  | Users can cancel running crawl jobs                                                                             | P0       | User story 3                  |
| FR-9  | Crawl history is queryable with filtering by status, strategy, date range                                       | P1       | User story 5                  |
| FR-10 | Circuit breaker trips after N failures for a domain, auto-resets after TTL                                      | P1       | Reliability                   |
| FR-11 | Content deduplication via hash prevents re-indexing identical pages                                             | P1       | Performance                   |
| FR-12 | Sitemap URL expansion respects maxPages limits                                                                  | P0       | Safety                        |
| FR-13 | Crawl audit events are logged for compliance traceability                                                       | P1       | Compliance                    |

### 3.2 Non-Functional Requirements

| ID    | Requirement                                                     | Target |
| ----- | --------------------------------------------------------------- | ------ |
| NFR-1 | Site profiling completes in < 5 seconds (quick mode)            | P0     |
| NFR-2 | Go worker throughput: 10,000+ static pages/second per worker    | P1     |
| NFR-3 | WebSocket progress latency < 500ms from event to client         | P1     |
| NFR-4 | Crawl job submission response time < 2 seconds                  | P0     |
| NFR-5 | Circuit breaker state shared across pods via Redis              | P0     |
| NFR-6 | All crawl data tenant-isolated; cross-tenant access returns 404 | P0     |
| NFR-7 | Crawl jobs survive pod restarts (BullMQ + Redis persistence)    | P0     |

---

## 4. User Stories

### US-1: Single Page Crawl

**As a** knowledge base admin, **I want to** paste a URL and have it crawled and indexed, **so that** I can quickly add a single web page to my knowledge base.

**Acceptance Criteria:**

- URL is validated (format, SSRF protection)
- Page is fetched, cleaned (Readability), and ingested into SearchAI pipeline
- Progress is shown in real-time
- Completion status is visible in crawl history

### US-2: Full Site Crawl with Strategy

**As a** knowledge base admin, **I want to** crawl an entire documentation site using sitemap discovery, **so that** I can bulk-import hundreds of pages without manual upload.

**Acceptance Criteria:**

- Site is profiled (type, sitemap, estimated size)
- Strategy is auto-selected (sitemap if available, smart otherwise)
- User can override strategy and set limits (maxPages, maxDepth)
- Progress shows per-URL status
- Completion shows total pages indexed with quality metrics

### US-3: Cancel Running Crawl

**As a** knowledge base admin, **I want to** cancel a running crawl that is taking too long, **so that** I can free resources and retry with different settings.

**Acceptance Criteria:**

- Cancel button visible during crawling/ingesting phases
- Cancellation stops new URL fetches
- Already-fetched pages complete ingestion
- Status changes to "cancelled"
- New crawl can be started immediately

### US-4: SSRF Protection

**As a** platform operator, **I want to** ensure crawl URLs cannot target internal infrastructure, **so that** the platform is protected from SSRF attacks.

**Acceptance Criteria:**

- Private IPs (10.x, 172.16-31.x, 192.168.x) are blocked
- Link-local (169.254.x) is blocked
- Cloud metadata endpoints (169.254.169.254) are blocked
- Loopback (127.0.0.1, ::1) is blocked
- DNS resolution validates resolved IPs (DNS rebinding protection)

### US-5: Crawl History and Filtering

**As a** knowledge base admin, **I want to** view past crawl jobs with filtering, **so that** I can track what has been crawled and diagnose failures.

**Acceptance Criteria:**

- History lists all crawl jobs for the tenant
- Filterable by status (completed, failed, cancelled, running)
- Filterable by strategy, date range
- Searchable by URL
- Click on job shows detailed progress view

### US-6: Preference Auto-Start

**As a** knowledge base admin, **I want** previously crawled domains to auto-start with saved preferences, **so that** repeat crawls require zero configuration.

**Acceptance Criteria:**

- After first crawl, user can save preference with auto-decide
- Next crawl of same domain shows preference banner with 3-second countdown
- Auto-starts if user does not intervene
- Preference is per-user, per-domain

---

## 5. Existing Implementation Inventory

### 5.1 Packages and Services

| Component                 | Location                                                                    | Status      | Description                                                                           |
| ------------------------- | --------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `@abl/crawler`            | `packages/crawler/`                                                         | Implemented | Intelligence layer: profiler, decision engine, disclosure, strategy, transparency     |
| Crawler MCP Server        | `apps/crawler-mcp-server/`                                                  | Implemented | Playwright-based browser automation exposed as MCP tools (11 tools)                   |
| Go Crawler Worker         | `apps/crawler-go-worker/`                                                   | Implemented | Colly-based static HTML crawler consuming BullMQ jobs                                 |
| Crawl Routes              | `apps/search-ai/src/routes/crawl.ts`                                        | Implemented | `/api/crawl/batch`, profile, cancel, dashboard, pages endpoints                       |
| Crawl History Routes      | `apps/search-ai/src/routes/crawl-history.ts`                                | Implemented | `/api/crawl/jobs`, history, comparison, audit endpoints                               |
| Crawler Ingestion Worker  | `apps/search-ai/src/workers/crawler-ingestion-worker.ts`                    | Implemented | BullMQ worker consuming Go crawler output, calling CrawlerIngestionService            |
| Crawler Ingestion Service | `apps/search-ai/src/services/ingestion/crawler-ingestion.ts`                | Implemented | Readability cleanup, S3 upload, MongoDB document creation, Docling extraction enqueue |
| Progress WebSocket        | `apps/search-ai/src/routes/progress.ts`                                     | Implemented | Redis pub/sub WebSocket for real-time crawl progress                                  |
| SSRF Protection           | `apps/search-ai/src/utils/ssrf-protection.ts`                               | Implemented | URL validation + DNS resolution with shared-kernel validator                          |
| Circuit Breaker           | `apps/search-ai/src/services/crawler/circuit-breaker.ts`                    | Implemented | Redis-backed circuit breaker for domain protection                                    |
| Duration Estimator        | `apps/search-ai/src/services/crawler/duration-estimator.ts`                 | Implemented | Strategy-based crawl time estimation                                                  |
| DB Models                 | `packages/database/src/models/crawl-job.model.ts`, `crawl-history.model.ts` | Implemented | CrawlJob, CrawlHistory, CrawlAuditEvent models                                        |

### 5.2 Integration Gaps

| Gap                                 | Description                                                                                                                                                       | Priority    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **Studio UI**                       | ~~No Studio web crawling UI exists~~ → Discovery Panel implemented (DiscoveryPanel, DiscoveryTree, DiscoveryConsole, DecisionCards, CoverageSummary, State4Crawl) | ~~P0~~ DONE |
| **Browser Discovery UX**            | Full discovery flow: site profiling → browser exploration → tree visualization → coverage analysis → crawl-as-you-discover                                        | DONE        |
| **SSRF on intervention endpoint**   | `isPrivateOrUnsafeUrl()` blocks private IPs on POST intervention payloads                                                                                         | DONE        |
| **Connector wiring**                | Crawl is not wired as a SearchAI "connector" type; manual setup required                                                                                          | P1          |
| **ABL agent definition**            | No ABL agent definition exists for agent-driven crawling                                                                                                          | P2          |
| **E2E tests**                       | Zero E2E tests through real HTTP API; 190 unit tests for pure functions exist                                                                                     | P0          |
| **Go worker → Node.js handoff**     | Content-processing queue integration needs production testing                                                                                                     | P0          |
| **Auth middleware on crawl routes** | Crawl routes use `req.tenantContext` but auth middleware wiring needs verification                                                                                | P0          |
| **Crawl-as-discover batch API**     | Backend batch submission endpoint not yet implemented; frontend ready                                                                                             | P1          |
| **Rate limiting on interventions**  | POST intervention endpoint has no Redis-based rate limiting                                                                                                       | P2          |

---

### 5.3 Discovery Panel Components (implemented 2026-04-23, ABLP-71)

| Component              | Location                                                                     | Description                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| DiscoveryPanel         | `apps/studio/src/components/search-ai/crawl-flow/DiscoveryPanel.tsx`         | Orchestrates Console + Tree + CoverageSummary; processes progress events                                       |
| DiscoveryTree          | `apps/studio/src/components/search-ai/crawl-flow/DiscoveryTree.tsx`          | Auto-collapsing tree (30-node threshold), breadcrumb trail, per-state action verbs                             |
| DiscoveryConsole       | `apps/studio/src/components/search-ai/crawl-flow/DiscoveryConsole.tsx`       | Scrollable timestamped log with decision cards integration                                                     |
| DecisionCards          | `apps/studio/src/components/search-ai/crawl-flow/DecisionCards.tsx`          | Dynamic decision cards with browse titles dropdown                                                             |
| CoverageSummary        | `apps/studio/src/components/search-ai/crawl-flow/CoverageSummary.tsx`        | Category coverage analysis with confidence bars                                                                |
| State4Crawl            | `apps/studio/src/components/search-ai/crawl-flow/State4Crawl.tsx`            | Crawl progress with per-category status                                                                        |
| BrowserDiscoveryInline | `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx` | SSE shell hosting DiscoveryPanel, SSE reconnection with backoff                                                |
| Discovery Utils        | `apps/studio/src/components/search-ai/crawl-flow/discovery/`                 | 6 pure utility modules (tree-utils, url-set, decision-utils, console-utils, coverage-utils, crawl-queue-utils) |
| Types                  | `apps/studio/src/components/search-ai/crawl-flow/types.ts`                   | 30+ types/interfaces for discovery system                                                                      |
| YieldTracker           | `apps/crawler-mcp-server/src/explore/yield-tracker.ts`                       | Adaptive stopping signal replacing static caps                                                                 |
| NavExtractor           | `apps/crawler-mcp-server/src/explore/nav-extractor.ts`                       | Playwright-based header/footer/mega-menu extraction                                                            |
| CommandQueue           | `apps/crawler-mcp-server/src/explore/command-queue.ts`                       | Intervention command queue for POST-alongside-SSE                                                              |
| Intervention endpoint  | `apps/search-ai/src/routes/crawl-browser-discover.ts`                        | POST /discover/browser/:id/intervention with SSRF protection                                                   |
| DiscoveredUrl type     | `packages/crawler/src/types/discovered-url.ts`                               | Shared type for discovered URL entries                                                                         |

### 5.4 Test Files (implemented 2026-04-23, ABLP-71)

| File                                                                                         | Tests | Description                                                               |
| -------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------- |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/tree-utils.test.ts`     | 60    | Tree CRUD, flattening, visibility, node actions                           |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/url-set.test.ts`        | 33    | URL normalization, dedup, eviction, serialization                         |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/decision-utils.test.ts` | 48    | Decision card generation, browse items, fuzzy match, objective evaluation |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/console-utils.test.ts`  | 29    | Progress-to-console conversion, yield status, contextual prompts          |
| `apps/crawler-mcp-server/src/explore/__tests__/yield-tracker.test.ts`                        | 20    | Yield tracking, adaptive stopping, sample count selection                 |

---

## 6. Decision Log

| Decision                                            | Classification | Rationale                                                                          |
| --------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| Go workers for static HTML, Playwright for JS-heavy | DECIDED        | 70/30 split: Go is 10x faster and 100x cheaper for static content                  |
| BullMQ for job orchestration                        | DECIDED        | Existing infrastructure, proven at scale in ingestion pipeline                     |
| Agent-driven crawling (MCP tools)                   | DECIDED        | Zero-config for users; agent adapts dynamically to site structure                  |
| 5-level decision hierarchy                          | DECIDED        | Progressive refinement: user overrides > preferences > tenant > learned > defaults |
| Readability for content cleaning                    | DECIDED        | Removes ads, navigation, footers; graceful fallback to raw HTML                    |
| Redis pub/sub for progress                          | DECIDED        | Multi-pod safe; existing WebSocket infrastructure in SearchAI                      |
| SSRF protection at URL validation + DNS resolution  | DECIDED        | Defense in depth: pre-validation + DNS rebinding protection                        |

---

## 7. Success Metrics

| Metric                | Target                         | Measurement                    |
| --------------------- | ------------------------------ | ------------------------------ |
| Crawl success rate    | > 95%                          | CrawlJob.results.successRate   |
| Site profiling time   | < 5s (quick mode)              | Profiler timing metrics        |
| E2E test coverage     | 100% of user stories           | Test spec coverage matrix      |
| SSRF protection       | 0 successful internal requests | Security audit                 |
| Content quality score | > 0.7 average                  | QualityMetrics.avgQualityScore |
