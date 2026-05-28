# Test Spec: Web Crawling

> **Feature Slug:** web-crawling
> **Status:** PARTIAL
> **Created:** 2026-03-23
> **Last Updated:** 2026-04-23
> **Feature Spec:** `docs/features/web-crawling.md`

---

## 1. Test Strategy

### 1.1 Approach

The web crawling feature spans 4 services (SearchAI, Go Worker, MCP Server, packages/crawler) and integrates with 5 infrastructure components (Redis, MongoDB, S3/filesystem, BullMQ, WebSocket). Testing must exercise the real system end-to-end through HTTP APIs while also verifying component boundaries via integration tests.

### 1.2 Test Pyramid

| Layer             | Count | Focus                                                                                                                   |
| ----------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| E2E Tests         | 10    | Full HTTP API flows through real SearchAI server                                                                        |
| Integration Tests | 12    | Service boundary tests with real Redis/MongoDB                                                                          |
| Unit Tests        | 190+  | `packages/crawler/__tests__/` (130+ profiler, 129 decision) + Discovery Panel pure functions (190 tests across 5 files) |

### 1.3 Rules

- E2E tests interact only via HTTP API (no `vi.mock`, no direct DB access, no stubbed servers)
- Start real Express servers on random ports (`{ port: 0 }`)
- Full middleware chain must execute: auth, rate limiting, tenant isolation, validation
- Only external third-party services may be mocked via DI (e.g., actual web servers for crawl targets use local HTTP test servers)
- Integration tests verify real service boundaries (BullMQ, Redis, MongoDB)

---

## 2. Test Coverage Matrix

### 2.1 E2E Test Scenarios

| ID     | Scenario                                                                                             | User Story | Priority | Status     |
| ------ | ---------------------------------------------------------------------------------------------------- | ---------- | -------- | ---------- |
| E2E-1  | Single page crawl: submit URL, verify job created, poll until completed, verify document indexed     | US-1       | P0       | NOT TESTED |
| E2E-2  | Site profiling: POST /api/crawl/profile with valid URL, verify profile response shape                | US-1       | P0       | NOT TESTED |
| E2E-3  | Batch crawl with sitemap strategy: submit multiple URLs, verify expansion and queuing                | US-2       | P0       | NOT TESTED |
| E2E-4  | Cancel running crawl: submit job, cancel mid-crawl, verify status transitions                        | US-3       | P0       | NOT TESTED |
| E2E-5  | SSRF protection: attempt private IPs (127.0.0.1, 169.254.169.254, 10.0.0.1), verify 400              | US-4       | P0       | NOT TESTED |
| E2E-6  | Crawl history listing: submit 3 jobs, query with filters (status, strategy, date), verify pagination | US-5       | P1       | NOT TESTED |
| E2E-7  | Crawl dashboard: submit job, GET dashboard endpoint, verify phase breakdown                          | US-2       | P1       | NOT TESTED |
| E2E-8  | Tenant isolation: create jobs under tenant A, query from tenant B, verify 404/empty                  | NFR-6      | P0       | NOT TESTED |
| E2E-9  | Circuit breaker: trigger failures for a domain, verify circuit opens, retry after TTL                | FR-10      | P1       | NOT TESTED |
| E2E-10 | Duplicate content detection: submit same URL twice, verify dedup prevents re-indexing                | FR-11      | P1       | NOT TESTED |

### 2.2 Integration Test Scenarios

| ID     | Scenario                                                                                                         | Component                   | Priority | Status     |
| ------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------- | -------- | ---------- |
| INT-1  | CrawlerIngestionService: ingest valid HTML, verify Readability cleanup, S3 upload, and MongoDB document creation | crawler-ingestion.ts        | P0       | NOT TESTED |
| INT-2  | CrawlerIngestionService: duplicate detection via content hash                                                    | crawler-ingestion.ts        | P1       | NOT TESTED |
| INT-3  | CrawlerIngestionWorker: consume BatchResult from BullMQ, verify documents created                                | crawler-ingestion-worker.ts | P0       | NOT TESTED |
| INT-4  | FastProfiler: profile a local test HTTP server, verify site type detection                                       | profiler/                   | P0       | NOT TESTED |
| INT-5  | DecisionEngine: 5-level hierarchy resolution with mock stores                                                    | decision/                   | P0       | NOT TESTED |
| INT-6  | StrategyResolver: resolve user strategy to internal strategy                                                     | strategy/                   | P0       | NOT TESTED |
| INT-7  | PromptEvaluator: skip rules (high confidence, recent preference, low risk)                                       | disclosure/                 | P1       | NOT TESTED |
| INT-8  | Circuit breaker: trip after threshold, auto-reset after TTL, Redis state persistence                             | circuit-breaker.ts          | P0       | NOT TESTED |
| INT-9  | Duration estimator: estimate for each strategy with various site characteristics                                 | duration-estimator.ts       | P1       | NOT TESTED |
| INT-10 | SSRF protection: validate private IPs, DNS resolution, and link-local detection                                  | ssrf-protection.ts          | P0       | NOT TESTED |
| INT-11 | Progress WebSocket: connect, subscribe to job, receive events, verify auth                                       | progress.ts                 | P1       | NOT TESTED |
| INT-12 | CrawlJob model: CRUD with tenant isolation, status transitions, timeline updates                                 | crawl-job.model.ts          | P0       | NOT TESTED |

### 2.3 Unit Test Coverage — Discovery Panel (implemented 2026-04-23)

| ID     | Module         | Tests | Key Scenarios                                                                                                                      | Status  |
| ------ | -------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------- | ------- |
| UNIT-1 | tree-utils     | 60    | formatDisplayName, findNode, walkTree, flattenTree, upsertNode, updateTree, computeVisibleNodes, getNodeActions                    | PASSING |
| UNIT-2 | url-set        | 33    | normalizeDiscoveryUrl, DiscoveredUrlSet add/has/eviction/serialize/deserialize                                                     | PASSING |
| UNIT-3 | decision-utils | 48    | generateDecisionCards (3 triggers), buildBrowseItems, fuzzyMatchTitle, evaluateObjective, deriveMatchers, scoreUrlAgainstObjective | PASSING |
| UNIT-4 | console-utils  | 29    | formatTimestamp, progressToConsoleEntries, getYieldStatus, generateContextualPrompt                                                | PASSING |
| UNIT-5 | yield-tracker  | 20    | createYieldTracker, trackPageVisit, shouldContinue, pickSampleCount                                                                | PASSING |

**Total: 190 unit tests, 0 failures**

Test files:

- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/tree-utils.test.ts`
- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/url-set.test.ts`
- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/decision-utils.test.ts`
- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/console-utils.test.ts`
- `apps/crawler-mcp-server/src/explore/__tests__/yield-tracker.test.ts`

---

## 3. E2E Test Design

### 3.1 Test Infrastructure

```
Test Setup:
1. Start SearchAI Express server on random port
2. Connect to real Redis (test instance)
3. Connect to real MongoDB (test instance)
4. Start local HTTP test server (serves static HTML for crawl targets)
5. Authenticate and obtain test tenant token

Test Teardown:
1. Clean up CrawlJob, CrawlHistory, CrawlAuditEvent documents for test tenant
2. Close Redis connections
3. Stop test servers
```

### 3.2 E2E-1: Single Page Crawl (Happy Path)

**Preconditions:** Test tenant with valid auth token, SearchAI index and source created

**Steps:**

1. POST `/api/crawl/profile` with `{ url: "http://localhost:TEST_PORT/simple-page" }`
2. Verify 200 response with profile shape: `{ domain, siteType, estimatedSize, metadata }`
3. POST `/api/crawl/batch` with `{ urls: ["http://localhost:TEST_PORT/simple-page"], tenantId, indexId, sourceId, strategy: "single-page" }`
4. Verify 200 response with `{ success: true, jobId, batchId, status: "queued" }`
5. Poll GET `/api/crawl/dashboard/{jobId}` until status is "completed" (max 30s)
6. GET `/api/crawl/pages/{jobId}` and verify 1 page with success status
7. Verify SearchDocument exists in MongoDB for the crawled URL

**Expected Result:** Document is created, extracted, and indexed via the full pipeline.

### 3.3 E2E-5: SSRF Protection

**Steps:**

1. POST `/api/crawl/batch` with `{ urls: ["http://127.0.0.1"], tenantId, indexId, sourceId }`
2. Verify 400 response with SSRF error
3. POST `/api/crawl/batch` with `{ urls: ["http://169.254.169.254/latest/meta-data/"], ... }`
4. Verify 400 response with SSRF error
5. POST `/api/crawl/batch` with `{ urls: ["http://10.0.0.1:8080/admin"], ... }`
6. Verify 400 response with SSRF error
7. POST `/api/crawl/batch` with `{ urls: ["http://[::1]/"], ... }`
8. Verify 400 response with SSRF error

**Expected Result:** All private/reserved IPs are blocked before any crawl attempt.

### 3.4 E2E-8: Tenant Isolation

**Steps:**

1. Create crawl job under tenant-A: POST `/api/crawl/batch` with tenantId=A
2. Verify job created with jobId
3. Query crawl history as tenant-B: GET `/api/crawl/jobs?tenantId=B`
4. Verify tenant-B sees empty results (not tenant-A's jobs)
5. Query specific job as tenant-B: GET `/api/crawl/dashboard/{jobId}` with tenant-B auth
6. Verify 404 (not 403, to avoid leaking existence)

**Expected Result:** Cross-tenant access returns 404 or empty results.

---

## 4. Integration Test Design

### 4.1 INT-1: CrawlerIngestionService

**Setup:** Real MongoDB connection, real filesystem (dev mode, no S3)

**Steps:**

1. Create test SearchIndex and SearchSource in MongoDB
2. Call `crawlerIngestionService.ingestCrawledContent()` with valid HTML
3. Verify SearchDocument created in MongoDB with correct tenantId, sourceId, indexId
4. Verify content was cleaned by Readability (no nav/footer elements)
5. Verify extraction job enqueued to BullMQ

**Expected Result:** Full ingestion pipeline completes with Readability cleanup.

### 4.2 INT-8: Circuit Breaker

**Setup:** Real Redis connection

**Steps:**

1. Create CircuitBreaker with threshold=3, resetTimeout=1000ms
2. Record 3 failures for "problematic.com"
3. Verify circuit is OPEN for "problematic.com"
4. Verify crawl attempt for "problematic.com" is blocked
5. Wait 1100ms (> resetTimeout)
6. Verify circuit is HALF-OPEN (allows probe request)
7. Record success, verify circuit closes

**Expected Result:** Circuit breaker state transitions match expected lifecycle.

### 4.3 INT-10: SSRF Protection

**Setup:** No external dependencies

**Steps:**

1. Call `isURLAllowed("http://127.0.0.1")` -- verify blocked
2. Call `isURLAllowed("http://169.254.169.254")` -- verify blocked
3. Call `isURLAllowed("http://10.0.0.1")` -- verify blocked
4. Call `isURLAllowed("http://192.168.1.1")` -- verify blocked
5. Call `isURLAllowed("http://example.com")` -- verify allowed
6. Call `isURLAllowed("http://[::1]")` -- verify blocked
7. Test DNS rebinding: hostname resolving to private IP -- verify blocked

**Expected Result:** All private/reserved IP ranges blocked; public URLs allowed.

---

## 5. Existing Test Inventory

### 5.1 Unit Tests (Already Exist)

| File                                                                     | Tests               | Status             |
| ------------------------------------------------------------------------ | ------------------- | ------------------ |
| `packages/crawler/src/profiler/__tests__/`                               | 130+                | Passing            |
| `packages/crawler/src/decision/__tests__/`                               | 129                 | Passing            |
| `packages/crawler/src/strategy/__tests__/`                               | Unknown             | Needs verification |
| `packages/crawler/src/disclosure/__tests__/`                             | Unknown             | Needs verification |
| `apps/search-ai/src/routes/__tests__/crawl-security.test.ts`             | SSRF tests          | Passing            |
| `apps/search-ai/src/routes/__tests__/crawl-cancel.test.ts`               | Cancel tests        | Passing            |
| `apps/search-ai/src/routes/__tests__/crawl-dashboard.test.ts`            | Dashboard tests     | Passing            |
| `apps/search-ai/src/routes/__tests__/crawl-history.test.ts`              | History tests       | Passing            |
| `apps/search-ai/src/routes/__tests__/crawl-url-expansion.test.ts`        | URL expansion tests | Passing            |
| `apps/search-ai/src/workers/__tests__/crawl-completion-tracking.test.ts` | Completion tracking | Passing            |

### 5.2 Coverage Gaps

| Gap                                                  | Risk                                                        | Priority |
| ---------------------------------------------------- | ----------------------------------------------------------- | -------- |
| No E2E tests through real HTTP API                   | HIGH -- cannot verify auth, rate limiting, middleware chain | P0       |
| No integration test for Go worker -> Node.js handoff | HIGH -- BullMQ queue compatibility untested                 | P0       |
| No WebSocket progress streaming test                 | MEDIUM -- client experience untested                        | P1       |
| No multi-tenant isolation E2E test                   | HIGH -- data leak risk                                      | P0       |
| No circuit breaker integration test with Redis       | MEDIUM -- state persistence untested                        | P1       |
| No content deduplication E2E test                    | MEDIUM -- duplicate indexing risk                           | P1       |

---

## 6. Test Data Requirements

### 6.1 Local Test HTTP Server

A lightweight HTTP server serving static pages for crawl targets:

- `/simple-page` -- single HTML page with title, body, links
- `/sitemap.xml` -- valid sitemap with 5 page entries
- `/robots.txt` -- standard robots.txt allowing all
- `/docs/page-1` through `/docs/page-5` -- documentation-style pages
- `/spa-page` -- page requiring JavaScript (returns empty body without JS)
- `/slow-page` -- page with 5-second delay (for timeout testing)
- `/redirect-chain` -- 3-hop redirect chain ending at `/final-page`

### 6.2 Test Tenant Setup

- Tenant with valid auth token
- SearchAI index created
- SearchAI source (type: "web") linked to index
- Second tenant for isolation tests

---

## 7. Quality Gates

| Gate                      | Criteria                                | Blocking |
| ------------------------- | --------------------------------------- | -------- |
| E2E pass rate             | 100% of P0 scenarios pass               | Yes      |
| Integration pass rate     | 100% of P0 scenarios pass               | Yes      |
| No mocks in E2E           | Zero `vi.mock()` or `jest.mock()` calls | Yes      |
| API-only interaction      | Zero direct DB imports in E2E tests     | Yes      |
| Tenant isolation verified | E2E-8 passes                            | Yes      |
| SSRF protection verified  | E2E-5 passes with all IP ranges         | Yes      |
