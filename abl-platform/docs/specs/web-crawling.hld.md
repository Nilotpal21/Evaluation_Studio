# High-Level Design: Web Crawling

> **Feature Slug:** web-crawling
> **Status:** APPROVED
> **Created:** 2026-03-23
> **Last Updated:** 2026-04-23
> **Feature Spec:** `docs/features/web-crawling.md`
> **Test Spec:** `docs/testing/web-crawling.md`

---

## 1. Architecture Overview

The web crawling system follows a 3-layer architecture:

1. **Intelligence Layer** (`packages/crawler/`) -- Site profiling, strategy selection, progressive disclosure, pattern learning
2. **Execution Layer** (`apps/crawler-go-worker/`, `apps/crawler-mcp-server/`) -- High-performance static crawling (Go/Colly) and browser automation (Playwright/MCP)
3. **Ingestion Layer** (`apps/search-ai/`) -- Content cleaning, storage, extraction, embedding, indexing via the existing 17-worker BullMQ pipeline

### 1.1 System Context Diagram

```
┌────────────┐     ┌──────────────────────────────────────────────────────────┐
│   Studio   │────>│                     SearchAI                             │
│    (UI)    │     │  ┌─────────┐  ┌───────────┐  ┌──────────────────┐      │
│            │<────│  │ Crawl   │  │ Intelligence│  │ Ingestion         │      │
│            │  WS │  │ Routes  │──│ Layer      │──│ Worker            │      │
└────────────┘     │  └────┬────┘  └───────────┘  └────────┬─────────┘      │
                   │       │                                 │                 │
                   │       │ BullMQ                          │ BullMQ          │
                   │       v                                 v                 │
                   │  ┌─────────┐                     ┌──────────────────┐    │
                   │  │ Go      │                     │ Docling           │    │
                   │  │ Worker  │─────────────────────│ Extraction        │    │
                   │  └─────────┘  content-processing │ Pipeline          │    │
                   │                                   └──────────────────┘    │
                   │  ┌─────────┐                                             │
                   │  │ MCP     │  (browser automation for JS sites)          │
                   │  │ Server  │                                             │
                   │  └─────────┘                                             │
                   └──────────────────────────────────────────────────────────┘
                         │              │              │
                    ┌────▼───┐    ┌────▼───┐    ┌────▼───┐
                    │ Redis  │    │MongoDB │    │  S3/   │
                    │(BullMQ │    │(Docs,  │    │  Local │
                    │ PubSub)│    │ Jobs)  │    │  FS    │
                    └────────┘    └────────┘    └────────┘
```

### 1.2 Request Flow

```
1. User submits URL via Studio UI → POST /api/crawl/batch
2. Route validates (SSRF check, auth, tenant isolation)
3. Intelligence layer profiles site → decides strategy
4. If confidence < 0.7 → return questions to user (needsUserInput: true)
5. If confidence >= 0.7 → enqueue to BullMQ static-crawl queue
6. Go worker consumes job → crawls URLs via Colly → publishes to content-processing queue
7. CrawlerIngestionWorker consumes → Readability cleanup → S3 upload → MongoDB doc → Docling extraction
8. Docling → page-processing → canonical-mapper → embedding → OpenSearch index
9. Progress events published via Redis pub/sub → WebSocket to client
10. CrawlJob status updated at each phase transition
```

---

## 2. 12 Architectural Concerns

### 2.1 Resource Isolation

**Tenant isolation** is enforced at every layer:

- **Route layer:** `req.tenantContext.tenantId` is required on all crawl endpoints. Cross-tenant access returns 404.
- **DB layer:** All CrawlJob, CrawlHistory, CrawlAuditEvent queries include `tenantId` in the filter. The `crawl-history.ts` route builds filters with `{ tenantId }`.
- **BullMQ jobs:** Every job payload includes `tenantId` (BatchResult interface). Workers verify tenantId before processing.
- **WebSocket:** Progress subscriptions authenticate via JWT cookie and scope to tenant.
- **User isolation:** CrawlJob has optional `userId` field for user-scoped queries.

**Gap identified:** The `crawl-history.ts` GET /jobs route reads `tenantId` from query params rather than `req.tenantContext`. This should be fixed to use authenticated tenant context.

### 2.2 Authentication and Authorization

- **Auth middleware:** Crawl routes use `req.tenantContext` populated by auth middleware. The route checks `if (!req.tenantContext)` and returns 401.
- **WebSocket auth:** Progress WebSocket validates JWT from cookies during the upgrade handshake.
- **Go worker:** No direct auth (internal service); consumes from BullMQ which is internal-only.
- **Permission model:** Currently tenant-level only. Project-level isolation (crawl scoped to a project) is deferred to v2.

### 2.3 Data Model

**Existing models (already implemented):**

```
CrawlJob {
  _id: string (UUIDv7)
  tenantId: string (required, indexed)
  userId?: string
  status: 'queued' | 'crawling' | 'ingesting' | 'indexing' | 'completed' | 'failed' | 'cancelled'
  strategy: 'browser' | 'bulk' | 'hybrid' | 'single-page' | 'sitemap' | 'smart'
  urls: { original: string[], expanded: string[], crawled: number, failed: number, errors: [] }
  configuration: { strategy, limits, discovery, filters }
  timeline: { submittedAt, startedAt, completedAt, estimatedEndAt }
  results: { documentsCreated, documentsIndexed, documentsFailed, chunksCreated, qualityMetrics }
  processingErrors: [{ timestamp, phase, url, error, retryable }]
  indexId: string
  sourceId: string
}

CrawlHistory {
  _id: string (UUIDv7)
  tenantId: string (required, indexed)
  crawlJobId: string
  statuses: [{ timestamp, status, phase, reason, metrics }]
  documentStatusChanges: [{ documentId, fromStatus, toStatus, timestamp, worker, durationMs }]
  performance: [{ timestamp, phase, documentsProcessed, chunksCreated, avgProcessingTimeMs }]
}

CrawlAuditEvent {
  tenantId: string
  crawlJobId: string
  eventType: string
  timestamp: Date
  details: Record<string, unknown>
}

UserCrawlPreference {
  tenantId: string
  userId: string
  domain: string
  preferences: Record<string, unknown>
}
```

### 2.4 Error Handling

- **Route-level:** Try/catch wraps all route handlers. Errors return `{ success: false, error: { code, message } }`.
- **SSRF errors:** Throw `ValidationError` (from shared-kernel) which routes map to 400.
- **Worker errors:** BullMQ retry with exponential backoff (3 attempts, 2s base delay). Failed jobs retained 24 hours.
- **Circuit breaker:** After N failures for a domain, circuit opens and blocks further crawl attempts. Auto-resets after TTL.
- **Readability fallback:** If Readability fails, raw HTML is used (graceful degradation).
- **Go worker errors:** Reported in BatchResult.results as `{ success: false, error: string }`. CrawlerIngestionWorker tracks per-URL failures.

### 2.5 Performance

- **Go worker throughput:** 10,000+ static pages/second (Colly with connection pooling)
- **Profiling latency:** < 5s in quick mode (HTTP-only, no browser)
- **BullMQ concurrency:** Configurable worker parallelism (default: 10 concurrent jobs)
- **Content deduplication:** SHA-256 hash of cleaned content prevents re-indexing identical pages
- **Batch processing:** Go worker processes URLs in configurable batch sizes (default: 100)
- **Sitemap parsing:** Parallel parsing with maxPages limit to prevent memory issues

### 2.6 Observability

- **Structured logging:** `createLogger('module-name')` used in all services (crawl-routes, progress-ws, crawler-ingestion)
- **Progress events:** ProgressEvent type with 7 event types (job_started, url_fetched, document_processed, chunk_created, job_completed, job_failed, error)
- **Audit trail:** CrawlAuditEvent model tracks all state transitions for compliance
- **Queue monitoring:** `getAllQueueStats()` and `getAllQueueHealth()` provide BullMQ queue metrics
- **CrawlHistory:** Performance timeline with per-phase metrics (documentsProcessed, avgProcessingTimeMs, queueDepth)

### 2.7 Security

- **SSRF protection:** Multi-layer defense:
  1. URL format validation (shared-kernel `validateUrlForSSRF`)
  2. DNS resolution validation (resolve hostname, check resolved IPs against blocklist)
  3. Go worker has its own SSRF validator (`internal/ssrf/validator.go`)
- **Rate limiting:** `searchAiRateLimit` middleware on crawl routes
- **Input validation:** URL format, maxPages bounds, strategy enum validation
- **Content size limits:** 5MB max response size in SSRF fetch utility
- **User-Agent:** Fixed `ABL-Platform-Scraper/1.0` to identify crawl traffic

### 2.8 Scalability

- **Horizontal scaling:** Go workers scale independently (Kubernetes pods). BullMQ distributes work.
- **Redis pub/sub:** Progress events scale across SearchAI pods.
- **Stateless routes:** No pod-local state; all state in Redis/MongoDB.
- **Queue backpressure:** BullMQ queue depth monitoring; circuit breaker prevents overload from problematic domains.
- **Batch sizing:** Configurable batch sizes for Go worker to balance throughput vs memory.

### 2.9 Reliability

- **BullMQ persistence:** Jobs survive pod restarts (Redis persistence).
- **Retry logic:** 3 attempts with exponential backoff (2s, 4s, 8s).
- **Circuit breaker:** Prevents cascading failures from problematic domains.
- **Graceful shutdown:** Go worker handles SIGTERM, drains in-flight jobs.
- **Dead letter:** Failed jobs retained 24 hours for investigation.
- **Progress reconnection:** WebSocket clients can reconnect and resume subscription.

### 2.10 Compliance

- **Audit logging:** CrawlAuditEvent tracks who initiated crawl, when, what URLs, what strategy, what results.
- **Data minimization:** Completed jobs have configurable retention (`removeOnComplete.age: 3600`).
- **robots.txt respect:** Strategy configuration includes `respectRobotsTxt` option.
- **User-Agent identification:** All crawl requests identify as ABL platform.
- **Tenant data isolation:** All crawl data (jobs, history, documents) scoped by tenantId.

### 2.11 Backward Compatibility

- **Legacy options API:** The `/api/crawl/batch` endpoint supports both the new `strategy`/`limits` API and the legacy `options` API (maxDepth, followLinks, etc.) for backward compatibility.
- **Existing ingestion pipeline:** Crawler feeds into the existing 17-worker Docling extraction pipeline via standard BullMQ queues.

### 2.12 Deployment

- **Go worker:** Docker image (`apps/crawler-go-worker/Dockerfile`) deployable as Kubernetes pods.
- **MCP server:** Docker image (`apps/crawler-mcp-server/Dockerfile`) for browser automation.
- **SearchAI:** Crawler routes, ingestion worker, and progress WebSocket are part of the SearchAI service deployment.
- **Infrastructure deps:** Redis (6379/6380), MongoDB, S3 (or local filesystem in dev).
- **No new infra required:** All components use existing Redis/MongoDB/BullMQ infrastructure.

---

## 3. Component Architecture

### 3.1 Intelligence Layer (`packages/crawler/`)

```
packages/crawler/src/
├── profiler/           # Site profiling (fast, cached, factory)
│   ├── interfaces.ts   # ISiteProfiler, SiteProfile, ProfileOptions
│   ├── fast-profiler.ts    # HTTP-only profiling
│   ├── cached-profiler.ts  # LRU cache wrapper
│   └── profiler-factory.ts # Factory pattern
├── decision/           # Strategy selection
│   ├── decision-engine.ts      # 5-level hierarchy
│   ├── user-preference-store.ts  # MongoDB user preferences
│   └── tenant-policy-store.ts    # MongoDB tenant policies
├── disclosure/         # Progressive disclosure
│   ├── prompt-evaluator.ts  # 5 skip rules
│   ├── question-generator.ts  # 4 question types
│   └── response-processor.ts  # Validation + persistence
├── strategy/           # Strategy resolution
│   ├── resolver.ts     # User strategy → internal strategy
│   └── types.ts        # UserCrawlStrategy, InternalCrawlStrategy, StrategyConfig
├── pattern-store/      # Learned pattern caching
└── transparency/       # Decision transparency logging
```

### 3.2 Execution Layer

**Go Worker** (`apps/crawler-go-worker/`):

- Consumes from `static-crawl` BullMQ queue
- Uses Colly for HTTP crawling
- SSRF validation in `internal/ssrf/`
- Publishes BatchResult to `content-processing` queue
- Configurable: parallelism, concurrency, batch size

**MCP Server** (`apps/crawler-mcp-server/`):

- 11 MCP tools: navigate, get_page_content, click_element, type_text, scroll, wait, extract_links, extract_elements, take_screenshot, execute_javascript, get_page_state
- Browser pool management (per-session isolation, 50 pages/browser, 30-min timeout)
- Used by ABL agents for JS-heavy sites

### 3.3 Ingestion Layer (`apps/search-ai/`)

**Routes:**

- `routes/crawl.ts` -- POST /batch, GET /dashboard/:jobId, GET /pages/:jobId, POST /cancel/:jobId, POST /profile
- `routes/crawl-history.ts` -- GET /jobs, GET /history/:jobId, GET /compare, GET /audit
- `routes/progress.ts` -- WebSocket /api/admin/progress/subscribe

**Services:**

- `services/ingestion/crawler-ingestion.ts` -- Readability cleanup, S3 upload, MongoDB doc creation, Docling extraction enqueue
- `services/crawler/circuit-breaker.ts` -- Redis-backed circuit breaker
- `services/crawler/duration-estimator.ts` -- Strategy-based time estimation

**Workers:**

- `workers/crawler-ingestion-worker.ts` -- Consumes content-processing queue, calls CrawlerIngestionService

---

## 4. API Design

### 4.1 REST Endpoints

| Method | Path                             | Description                | Auth                     |
| ------ | -------------------------------- | -------------------------- | ------------------------ |
| POST   | `/api/crawl/batch`               | Submit crawl job           | Required (tenantContext) |
| POST   | `/api/crawl/profile`             | Profile a URL              | Required                 |
| POST   | `/api/crawl/jobs/:jobId/cancel`  | Cancel crawl job           | Required                 |
| GET    | `/api/crawl/dashboard/:jobId`    | Get job dashboard          | Required                 |
| GET    | `/api/crawl/pages/:jobId`        | Get crawled pages          | Required                 |
| POST   | `/api/crawl/respond/:pendingId`  | Respond to crawl questions | Required                 |
| GET    | `/api/crawl/jobs`                | List crawl jobs (history)  | Required                 |
| GET    | `/api/crawl/history/:crawlJobId` | Get job history timeline   | Required                 |
| GET    | `/api/crawl/compare`             | Compare two crawl jobs     | Required                 |
| GET    | `/api/crawl/audit/:crawlJobId`   | Get audit events           | Required                 |

### 4.2 WebSocket Protocol

```
Connection: ws://host/api/admin/progress/subscribe?jobId=XXX
Auth: Cookie-based JWT (abl_token or accessToken)

Events (server → client):
{
  type: 'job_started' | 'url_fetched' | 'document_processed' | 'chunk_created' | 'job_completed' | 'job_failed' | 'error',
  jobId: string,
  timestamp: string,
  data?: { url?, documentId?, chunkId?, progress?, error? }
}
```

### 4.3 BullMQ Queue Contract

**Queue: `static-crawl`** (SearchAI → Go Worker)

```typescript
{
  jobId: string;
  batchId: string;
  urls: string[];
  tenantId: string;
  indexId: string;
  sourceId: string;
  options: { maxDepth, followLinks, extractMetadata, maxPages, useSitemap };
}
```

**Queue: `content-processing`** (Go Worker → CrawlerIngestionWorker)

```typescript
{
  jobId: string;
  batchId: string;
  results: CrawlResult[];
  totalUrls: number;
  successful: number;
  failed: number;
  duration: number;
  completedAt: string;
  tenantId: string;
  indexId: string;
  sourceId: string;
}
```

---

## 5. Alternatives Considered

| Alternative                                 | Decision | Rationale                                                                                       |
| ------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| Python-only crawler (Scrapy)                | Rejected | Not unified with ABL platform; TypeScript/Go preferred for performance and codebase consistency |
| All-browser crawling (Playwright only)      | Rejected | 100x more expensive and 10x slower for static content (70% of web)                              |
| External crawler service (Firecrawl, Apify) | Rejected | Vendor lock-in, data residency concerns, cost at scale                                          |
| Autonomous crawler (no agent intelligence)  | Rejected | Requires per-site configuration; agent-driven approach handles dynamic sites                    |
| Direct ingestion (skip Readability)         | Rejected | Navigation, ads, footers degrade content quality; Readability removes noise                     |

---

## 6. Risks and Mitigations

| Risk                                                | Impact | Probability | Mitigation                                         |
| --------------------------------------------------- | ------ | ----------- | -------------------------------------------------- |
| Go worker queue incompatibility with Node.js BullMQ | HIGH   | LOW         | Integration test (INT-3) validates end-to-end      |
| SSRF bypass via DNS rebinding                       | HIGH   | LOW         | DNS resolution validation already implemented      |
| Memory exhaustion from large sitemaps               | MEDIUM | MEDIUM      | maxPages limit enforced; streaming XML parser      |
| Circuit breaker stuck open                          | MEDIUM | LOW         | Auto-reset TTL + manual override endpoint          |
| WebSocket connection storms on large crawls         | MEDIUM | MEDIUM      | Rate-limit progress events (max 10/second per job) |
| Tenant data leak via crawl history                  | HIGH   | LOW         | E2E-8 verifies tenant isolation                    |
