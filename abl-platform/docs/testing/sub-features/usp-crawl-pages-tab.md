# Test Specification: USP Crawl-Centric Pages Tab

**Feature Spec**: `docs/features/sub-features/usp-crawl-pages-tab.md`
**HLD**: `docs/specs/unified-source-page.hld.md` (parent USP)
**Status**: PLANNED
**Last Updated**: 2026-05-17

---

## 1. Coverage Matrix

| FR    | Description                                        | Unit | Integration | E2E | Manual | Status     |
| ----- | -------------------------------------------------- | ---- | ----------- | --- | ------ | ---------- |
| FR-1  | Error details persisted in CrawlError collection   | ✅   | ✅          | ☐   | ☐      | NOT TESTED |
| FR-1E | Error persistence failure path (worker continues)  | ✅   | ☐           | ☐   | ☐      | NOT TESTED |
| FR-2  | Error classified into 9 categories                 | ✅   | ☐           | ☐   | ☐      | NOT TESTED |
| FR-2E | Unrecognized error string → `crawl_error` fallback | ✅   | ☐           | ☐   | ☐      | NOT TESTED |
| FR-3  | CrawlError pagination + TTL cleanup                | ☐    | ✅          | ☐   | ☐      | NOT TESTED |
| FR-3E | urls.failed counter accurate vs CrawlError count   | ☐    | ✅          | ☐   | ☐      | NOT TESTED |
| FR-4  | /pages returns merged pages + crawlErrors          | ☐    | ✅          | ✅  | ☐      | NOT TESTED |
| FR-4E | /pages with zero pages + zero errors               | ☐    | ✅          | ☐   | ☐      | NOT TESTED |
| FR-4P | /pages pagination with mixed sources               | ☐    | ✅          | ✅  | ☐      | NOT TESTED |
| FR-5  | Status strip shows crawl + pipeline rows           | ☐    | ✅          | ☐   | ✅     | NOT TESTED |
| FR-6  | Pages tab shows all URLs with two-state model      | ☐    | ✅          | ☐   | ✅     | NOT TESTED |
| FR-7  | Error grouping: crawl vs pipeline sections         | ☐    | ✅          | ☐   | ✅     | NOT TESTED |
| FR-8  | Remediation guidance per error type                | ✅   | ☐           | ☐   | ☐      | NOT TESTED |
| FR-9  | quality, handlerReused, method in page response    | ☐    | ✅          | ✅  | ☐      | NOT TESTED |
| FR-10 | DashboardResponse errorBreakdown                   | ☐    | ✅          | ✅  | ☐      | NOT TESTED |
| FR-11 | DashboardResponse qualityDistribution              | ☐    | ✅          | ☐   | ☐      | NOT TESTED |
| FR-12 | Failed URLs in real-time via SSE                   | ☐    | ✅          | ✅  | ✅     | NOT TESTED |
| FR-13 | Filter bar: All/Fetched/Failed/Blocked             | ☐    | ✅          | ✅  | ☐      | NOT TESTED |
| FR-14 | qualityMetrics computed at job completion          | ☐    | ✅          | ☐   | ☐      | NOT TESTED |
| FR-4V | /pages invalid jobId returns 400/404               | ☐    | ✅          | ✅  | ☐      | NOT TESTED |

---

## 2. E2E Test Scenarios (MANDATORY)

> CRITICAL: E2E tests exercise the real system through its HTTP API. No mocks, no direct DB access, no stubbed servers. Use `playwrightRequest` with `x-tenant-id` header per established SearchAI E2E pattern.

### E2E-1: Pages Endpoint Returns Merged Pages and Crawl Errors

- **Preconditions**: Tenant A authenticated. CrawlJob exists with `urls.failed: 3`. 3 CrawlError documents exist for this job (1 `http_4xx`, 1 `timeout`, 1 `connection_error`). 5 SearchDocuments exist with `sourceMetadata.crawlJobId` matching the job.
- **Steps**:
  1. `GET /api/crawl/pages/{jobId}` with `x-tenant-id: tenantA`
  2. Assert response envelope: `{ success: true, data: { pages, crawlErrors, ... } }`
  3. Assert `data.pages.length === 5`
  4. Assert `data.crawlErrors.length === 3`
  5. Assert each crawlError has `{ url, type, error, statusCode?, timestamp }` shape
  6. Assert `data.totalFailed === 3`
  7. Assert `data.errorPagination` contains `{ total: 3, offset: 0, limit: 100, hasMore: false }`
- **Expected Result**: Merged response with 5 pages from SearchDocuments + 3 crawlErrors from CrawlError collection, correct envelope format
- **Auth Context**: Tenant A, any user within tenant
- **Isolation Check**: Same request with `x-tenant-id: tenantB` returns 404

### E2E-2: Cross-Tenant Isolation — Pages Endpoint Returns 404

- **Preconditions**: CrawlJob created under Tenant A with CrawlError documents. Tenant B credentials available.
- **Steps**:
  1. `GET /api/crawl/pages/{jobId}` with `x-tenant-id: tenantB`
  2. Assert HTTP 404
  3. Assert response: `{ success: false, error: { code: 'NOT_FOUND', message: ... } }`
  4. `GET /api/crawl/pages/{jobId}` with no auth header
  5. Assert HTTP 401
- **Expected Result**: Cross-tenant returns 404 (not 403). No auth returns 401.
- **Auth Context**: Tenant B (wrong tenant), then no tenant
- **Isolation Check**: This IS the isolation test

### E2E-3: Pages Endpoint Returns Quality, Method, HandlerReused from SourceMetadata

- **Preconditions**: CrawlJob completed. 3 SearchDocuments exist with `sourceMetadata` containing `{ quality: 'rich', qualityScore: 0.92, handlerReused: true, method: 'http' }`, `{ quality: 'thin', qualityScore: 0.25, handlerReused: false, method: 'playwright' }`, and `{ quality: 'standard', qualityScore: 0.65, method: 'http' }`.
- **Steps**:
  1. `GET /api/crawl/pages/{jobId}` with `x-tenant-id: tenantA`
  2. Assert each page in `data.pages` has `quality`, `qualityScore`, `method` fields
  3. Assert page 1: `quality === 'rich'`, `qualityScore === 0.92`, `handlerReused === true`, `method === 'http'`
  4. Assert page 2: `quality === 'thin'`, `qualityScore === 0.25`, `handlerReused === false`, `method === 'playwright'`
  5. Assert page 3: `quality === 'standard'`, `qualityScore === 0.65`, `method === 'http'`
- **Expected Result**: All sourceMetadata fields surfaced in page response
- **Auth Context**: Tenant A
- **Isolation Check**: Covered by E2E-2

### E2E-4: Dashboard Endpoint Returns Error Breakdown and Quality Distribution

- **Preconditions**: CrawlJob exists with `urls.failed: 10`. 10 CrawlError documents: 5 `http_4xx`, 3 `timeout`, 2 `connection_error`. `results.qualityMetrics` populated. 10 SearchDocuments with quality distribution: 6 rich, 3 standard, 1 thin.
- **Steps**:
  1. `GET /api/crawl/dashboard/{jobId}` with `x-tenant-id: tenantA`
  2. Assert `data.crawl.errorBreakdown` is an array
  3. Assert errorBreakdown contains `{ type: 'http_4xx', count: 5 }`, `{ type: 'timeout', count: 3 }`, `{ type: 'connection_error', count: 2 }`
  4. Assert `data.ingestion.qualityDistribution === { rich: 6, standard: 3, thin: 1 }`
- **Expected Result**: Dashboard response includes both new extension fields with correct aggregations
- **Auth Context**: Tenant A
- **Isolation Check**: `GET /api/crawl/dashboard/{jobId}` with `x-tenant-id: tenantB` returns 404 (same isolation as pages endpoint — both query CrawlJob by {\_id, tenantId})

### E2E-5: Pages Endpoint Pagination with Status Filter

- **Preconditions**: CrawlJob with `urls.failed: 3`. 3 CrawlError documents. 15 SearchDocuments (12 with status `indexed`, 3 with status `error`).
- **Steps**:
  1. `GET /api/crawl/pages/{jobId}?limit=5&offset=0` — assert `data.pages.length === 5`, `data.pagination.hasMore === true`, `data.crawlErrors.length === 3`, `data.errorPagination.total === 3`
  2. `GET /api/crawl/pages/{jobId}?limit=5&offset=10` — assert `data.pages.length === 5`, `data.pagination.hasMore === false`
  3. `GET /api/crawl/pages/{jobId}?status=failed` — assert only pages with `status === 'error'` returned (3 pages), plus crawlErrors (3 errors)
  4. `GET /api/crawl/pages/{jobId}?search=example.com/blog` — assert only pages/errors with matching URL pattern
- **Expected Result**: Pages and errors are independently paginated, status filter works, search works
- **Auth Context**: Tenant A

### E2E-6: Pages Endpoint with Large Error Set — Pagination

- **Preconditions**: CrawlJob with `urls.failed: 250`. 250 CrawlError documents with various types.
- **Steps**:
  1. `GET /api/crawl/pages/{jobId}?errorLimit=100&errorOffset=0` with `x-tenant-id: tenantA`
  2. Assert `data.crawlErrors.length === 100`
  3. Assert `data.errorPagination.total === 250`
  4. Assert `data.errorPagination.hasMore === true`
  5. Assert `data.totalFailed === 250` (authoritative count from CrawlJob)
  6. `GET /api/crawl/pages/{jobId}?errorLimit=100&errorOffset=200`
  7. Assert `data.crawlErrors.length === 50` (remaining)
  8. Assert `data.errorPagination.hasMore === false`
- **Expected Result**: Error pagination works correctly, totalFailed reflects authoritative count
- **Auth Context**: Tenant A

### E2E-7: Pages Endpoint Error Path — Invalid Job ID

- **Preconditions**: Tenant A authenticated. No CrawlJob exists for the given jobId.
- **Steps**:
  1. `GET /api/crawl/pages/000000000000000000000000` with `x-tenant-id: tenantA` (valid ObjectId format, non-existent)
  2. Assert HTTP 404
  3. Assert response: `{ success: false, error: { code: 'NOT_FOUND', message: ... } }`
  4. `GET /api/crawl/pages/not-a-valid-id` with `x-tenant-id: tenantA` (malformed ID)
  5. Assert HTTP 400
  6. Assert response: `{ success: false, error: { code: 'INVALID_REQUEST', message: ... } }`
  7. Assert neither response leaks stack traces or internal hostnames
- **Expected Result**: Non-existent job returns 404, malformed ID returns 400, both use structured error envelope
- **Auth Context**: Tenant A
- **Isolation Check**: Error responses don't reveal whether the job exists for another tenant

### E2E-8: Real-Time Failed URL Delivery via SSE Stream

- **Preconditions**: Tenant A authenticated. Source configured with a small URL list including at least one URL guaranteed to fail (e.g., `https://httpstat.us/404`).
- **Steps**:
  1. `POST /api/crawl/start` to initiate a crawl for the source
  2. Connect to SSE stream `GET /api/crawl/progress/{jobId}` with `x-tenant-id: tenantA`
  3. Listen for events until crawl completes
  4. Assert at least one `url_fetched` event with `status: 'failed'` was received (bulk worker pattern)
  5. Assert the failed event includes `{ url, error, type }` where `type` is a valid CrawlErrorType
  6. After crawl completes, `GET /api/crawl/pages/{jobId}` and assert the same failed URL appears in `data.crawlErrors[]`
  7. Assert the SSE-reported error type matches the persisted error type
- **Expected Result**: Failed URLs are delivered in real-time via SSE AND persisted for later retrieval
- **Auth Context**: Tenant A
- **Note**: This E2E requires a running crawl — use a controlled fixture URL set to keep execution time bounded

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Error Classification — All Error String Formats

- **Boundary**: Error classifier ← HTTP adapter error strings
- **Setup**: Import `classifyCrawlError()` utility
- **Steps**:
  1. `classifyCrawlError('HTTP 404')` → assert `http_4xx`
  2. `classifyCrawlError('HTTP 403')` → assert `http_4xx`
  3. `classifyCrawlError('HTTP 500')` → assert `http_5xx`
  4. `classifyCrawlError('HTTP 502')` → assert `http_5xx`
  5. `classifyCrawlError('Request timeout after 15000ms')` → assert `timeout`
  6. `classifyCrawlError('connect ECONNREFUSED 127.0.0.1:443')` → assert `connection_error`
  7. `classifyCrawlError('getaddrinfo ENOTFOUND example.invalid')` → assert `connection_error`
  8. `classifyCrawlError('robots.txt')` → assert `robots_blocked` (passed explicitly by worker)
  9. `classifyCrawlError('SSRF blocked: hostname resolves to private IP 10.0.0.1')` → assert `ssrf_blocked`
  10. `classifyCrawlError('Some unknown error xyz')` → assert `crawl_error` (fallback)
- **Expected Result**: All known error formats correctly classified; unknown errors fall back to `crawl_error`
- **Failure Mode**: Misclassification causes wrong error groups in UI

### INT-2: CrawlError InsertOne + Find Round-Trip Against Real MongoDB

- **Boundary**: CrawlError model ← MongoDB insertOne/find
- **Setup**: Create a CrawlJob in real MongoDB. No existing CrawlError documents.
- **Steps**:
  1. Insert 150 CrawlError documents for this crawlJobId with various types and timestamps
  2. `CrawlError.find({ tenantId, crawlJobId }).sort({ timestamp: -1 }).limit(100)`
  3. Assert returned 100 documents, sorted newest-first
  4. `CrawlError.countDocuments({ tenantId, crawlJobId })`
  5. Assert count === 150 (all errors stored, no cap)
  6. `CrawlError.find({ tenantId, crawlJobId }).sort({ timestamp: -1 }).skip(100).limit(100)`
  7. Assert returned 50 documents (remaining)
  8. Verify tenant isolation: `CrawlError.find({ tenantId: 'other-tenant', crawlJobId })` returns 0
- **Expected Result**: CrawlError collection stores all errors, supports pagination, enforces tenant isolation
- **Failure Mode**: Missing compound index causes slow queries; missing tenantId in query leaks cross-tenant data

### INT-3: /pages/:jobId Merge — Zero Documents, Some Errors

- **Boundary**: Pages endpoint ← CrawlJob + CrawlError + SearchDocument collections
- **Setup**: Create CrawlJob with `urls.failed: 5`, `urls.crawled: 0`. Create 5 CrawlError documents for this crawlJobId. No SearchDocuments for this crawlJobId.
- **Steps**:
  1. `GET /api/crawl/pages/{jobId}`
  2. Assert `data.pages === []` (empty — no SearchDocuments)
  3. Assert `data.crawlErrors.length === 5`
  4. Assert `data.totalFailed === 5`
  5. Assert `data.pagination.total === 0`
- **Expected Result**: When all URLs failed, pages array is empty but errors are populated from CrawlError collection
- **Failure Mode**: Endpoint crashes or returns 500 when no documents exist

### INT-4: /pages/:jobId Merge — Documents Only, No Errors

- **Boundary**: Pages endpoint ← CrawlJob + CrawlError + SearchDocument collections
- **Setup**: Create CrawlJob with `urls.failed: 0`. No CrawlError documents. Create 5 SearchDocuments with `sourceMetadata.crawlJobId` matching, various statuses.
- **Steps**:
  1. `GET /api/crawl/pages/{jobId}`
  2. Assert `data.pages.length === 5`
  3. Assert `data.crawlErrors === []`
  4. Assert `data.totalFailed === 0`
  5. Assert `data.totalErrors === 0`
- **Expected Result**: Clean crawl with no errors returns only pages
- **Failure Mode**: Missing crawlErrors key or null instead of empty array

### INT-5: /pages/:jobId Error Response Sanitization

- **Boundary**: Pages endpoint → client response
- **Setup**: Create CrawlJob with `urls.failed: 1`. Create CrawlError document with error message `"connect ECONNREFUSED 127.0.0.1:8080"` — contains internal hostname/port.
- **Steps**:
  1. `GET /api/crawl/pages/{jobId}`
  2. Assert crawlError entry has `type: 'connection_error'`
  3. Assert crawlError `error` field does NOT contain `127.0.0.1` or `localhost` (sanitized)
  4. Force endpoint to throw 500 (e.g., pass malformed jobId)
  5. Assert 500 response uses structured envelope `{ success: false, error: { code, message } }`
  6. Assert 500 response message does NOT contain stack trace or internal details
- **Expected Result**: Internal infrastructure details sanitized from client responses
- **Failure Mode**: Raw error.message leaks hostnames/ports/stack traces

### INT-6: Quality Metrics Computation at Job Completion

- **Boundary**: CrawlJob update ← SearchDocument aggregation
- **Setup**: Create completed CrawlJob. Create 10 SearchDocuments with `sourceMetadata.qualityScore` values: [0.9, 0.85, 0.7, 0.65, 0.5, 0.45, 0.3, 0.25, 0.8, 0.75]. `sourceMetadata.quality`: 4 rich, 4 standard, 2 thin.
- **Steps**:
  1. Trigger qualityMetrics computation (call the function that runs at job completion)
  2. Read updated CrawlJob
  3. Assert `results.qualityMetrics.avgQualityScore` ≈ 0.615
  4. Assert `results.qualityMetrics.successRate` = 1.0 (all ingested)
- **Expected Result**: Aggregate quality metrics correctly computed from SearchDocument data
- **Failure Mode**: Aggregation includes documents from other jobs (missing crawlJobId filter)

### INT-7: Dashboard Error Breakdown Aggregation

- **Boundary**: Dashboard endpoint ← CrawlError collection aggregation
- **Setup**: Create CrawlJob. Create 10 CrawlError documents: 5 with `type: 'http_4xx'`, 3 with `type: 'timeout'`, 1 with `type: 'robots_blocked'`, 1 with `type: 'connection_error'`.
- **Steps**:
  1. `GET /api/crawl/dashboard/{jobId}`
  2. Assert `crawl.errorBreakdown` contains exactly 4 entries
  3. Assert breakdown: `http_4xx: 5`, `timeout: 3`, `robots_blocked: 1`, `connection_error: 1`
  4. Assert sorted by count descending
- **Expected Result**: Error breakdown correctly aggregates by type from CrawlError collection
- **Failure Mode**: Counts are wrong if aggregation includes errors from other jobs (missing crawlJobId filter)

### INT-8: /pages Response Shape — Two-State Model via Structural Separation (FR-5, FR-6)

- **Boundary**: Pages endpoint → frontend contract
- **Setup**: Create CrawlJob with mixed outcomes. Create SearchDocuments: 3 with `status: 'indexed'`, 1 with `status: 'processing'`, 1 with `status: 'error'` (pipeline failure). Create 2 CrawlError documents (crawl failures).
- **Steps**:
  1. `GET /api/crawl/pages/{jobId}`
  2. Assert `data.pages` contains 5 entries (all successfully crawled URLs that entered the pipeline)
  3. Assert each page has `status` field: `'indexed'` for 3, `'processing'` for 1, `'error'` for 1
  4. Assert `data.crawlErrors` contains 2 entries (URLs that failed during crawl — never entered pipeline)
  5. Assert crawl errors are structurally separated from pages — different arrays, different shapes
  6. Assert `data.totalFailed === 2` (crawl failures only, from CrawlJob.urls.failed)
  7. Assert `data.pagination.total === 5` (SearchDocument count only, not including crawl errors)
- **Expected Result**: Two-state model encoded structurally: `pages[]` = crawled (with pipeline status), `crawlErrors[]` = failed crawl (no pipeline status). Frontend can derive crawl metrics from array lengths + totalFailed, pipeline metrics from page status distribution.
- **Failure Mode**: Crawl failures mixed into pages array, making it impossible to distinguish crawl errors from pipeline errors
- **Note**: Exact field names for two-state discriminators to be finalized during HLD/LLD. This test validates structural separation.

### INT-9: /pages Response Shape — Error Origin Separation via Structural Arrays (FR-7)

- **Boundary**: Pages endpoint → frontend contract
- **Setup**: Create CrawlJob with `urls.failed: 2`. Create 2 CrawlError documents (`http_4xx`, `timeout`). Create 1 SearchDocument with `status: 'error'` and `processingError: 'Docling extraction failed'`.
- **Steps**:
  1. `GET /api/crawl/pages/{jobId}`
  2. Assert `data.crawlErrors` contains the 2 crawl errors — each has `{ url, type, error, timestamp }` shape (no `origin` field needed — array membership IS the discriminator)
  3. Assert the error page in `data.pages` has `status: 'error'` with `processingError` field (pipeline error)
  4. Assert crawl errors (`data.crawlErrors[]`) and pipeline errors (`data.pages[].status === 'error'`) are structurally separated into different arrays with different shapes
- **Expected Result**: Frontend can render "Crawl Errors" from `crawlErrors[]` and "Processing Errors" from `pages[]` filtered by `status === 'error'`, without client-side re-classification
- **Failure Mode**: All errors mixed into one array, requiring frontend to guess error origin

### INT-10: SSE Event Shape — Failed URL Events (FR-12)

- **Boundary**: Crawl worker → SSE event stream → client
- **Setup**: Import the SSE event emitter or create a crawl job that processes a URL known to fail
- **Steps**:
  1. Verify that bulk worker emits `url_fetched` event with `{ url, status: 'failed', error, type }` shape when a URL fails
  2. Verify that intelligence worker emits `intelligence_page_failed` event with `{ url, error, type }` shape
  3. Assert `type` field in both event shapes is a valid `CrawlErrorType` enum value
  4. Assert event shape matches what the frontend expects for real-time table row insertion
- **Expected Result**: Both worker types emit structured failure events with classified error types for real-time display
- **Failure Mode**: Events lack `type` field, forcing frontend to classify errors client-side (defeats the purpose of backend classification)

---

## 4. Unit Test Scenarios

### UT-1: classifyCrawlError — HTTP Status Code Parsing

- **Module**: Error classification utility (T-1)
- **Input**: `'HTTP 404'`, `'HTTP 429'`, `'HTTP 500'`, `'HTTP 503'`
- **Expected Output**: `http_4xx`, `http_4xx`, `http_5xx`, `http_5xx`

### UT-2: classifyCrawlError — Connection Error Patterns

- **Module**: Error classification utility
- **Input**: `'connect ECONNREFUSED 127.0.0.1:443'`, `'getaddrinfo ENOTFOUND bad.domain'`, `'read ECONNRESET'`, `'socket hang up'`
- **Expected Output**: `connection_error` for all

### UT-3: classifyCrawlError — Timeout Patterns

- **Module**: Error classification utility
- **Input**: `'Request timeout after 15000ms'`, `'Request timeout after 60000ms'`, `'Page fetch timeout'`, `'Page analysis timeout'`
- **Expected Output**: `timeout` for all

### UT-4: classifyCrawlError — Special Types

- **Module**: Error classification utility
- **Input**: `'robots.txt'` → `robots_blocked`, `'quality_gated'` → `quality_gated`, `'content_filtered'` → `content_filtered`, `'SSRF blocked: private IP'` → `ssrf_blocked`
- **Expected Output**: As specified

### UT-5: classifyCrawlError — Fallback

- **Module**: Error classification utility
- **Input**: `'MCP navigate failed'`, `'Some random error'`, `''`, `undefined`
- **Expected Output**: `crawl_error` for all (catch-all)

### UT-6: Remediation Text Mapping

- **Module**: i18n remediation keys
- **Input**: Each CrawlErrorType value
- **Expected Output**: Non-empty remediation text string for every error type; no missing i18n keys

### UT-7: Error Entry Sanitization

- **Module**: Error message sanitizer
- **Input**: `'connect ECONNREFUSED 127.0.0.1:8080'`, `'Docling service unreachable at http://localhost:8080'`
- **Expected Output**: Messages with `127.0.0.1`, `localhost`, port numbers stripped or replaced with generic text

---

## 5. Security & Isolation Tests

- [x] **Cross-tenant access returns 404**: E2E-2 covers this — Tenant B requesting Tenant A's job gets 404
- [x] **Missing auth returns 401**: E2E-2 covers this — no auth header returns 401
- [ ] **Cross-project access**: Not testable yet (GAP-001 — CrawlJob has no projectId). **Forward plan**: When `projectId` is added to CrawlJob, add E2E scenario: project-scoped request with wrong projectId returns 404. Track via GAP-001 in feature spec.
- [ ] **Cross-user access**: N/A — crawl jobs are shared within tenant (no user-level ownership)
- [x] **Input validation rejects malformed data**: INT-5 covers malformed jobId → structured 500 response
- [x] **Error message sanitization**: INT-5 and UT-7 cover — no internal hostnames/ports leaked to client
- [ ] **Insufficient permissions returns 403**: N/A for crawl routes (tenant-level auth only, no granular permissions)

---

## 6. Performance & Load Tests

### PERF-1: /pages/:jobId Response Time with Large Error Set

- **Setup**: CrawlJob with `urls.failed: 15000`. 15,000 CrawlError documents. 1000 SearchDocuments.
- **Assertion**: Response time < 500ms for first page (`limit=50`, `errorLimit=100`)
- **Rationale**: Verify compound index on CrawlError handles large error sets without degradation.

### PERF-2: Concurrent CrawlError.insertOne Under Load

- **Setup**: 10 concurrent goroutines inserting CrawlError documents for the same crawlJobId
- **Assertion**: After 1000 total inserts, `CrawlError.countDocuments({crawlJobId}) === 1000`, no write conflicts
- **Rationale**: Bulk worker's WINDOW_SIZE=5 means up to 5 concurrent insertOne calls. This tests 10 for safety margin. Independent documents should have zero contention.

---

## 7. Test Infrastructure

### Required Services

| Service  | Purpose                              | Config                 |
| -------- | ------------------------------------ | ---------------------- |
| MongoDB  | CrawlJob, CrawlError, SearchDocument | Default dev connection |
| Redis    | BullMQ job state                     | Default dev connection |
| SearchAI | API under test                       | `SEARCH_AI_PORT=3005`  |

### Not Required

| Service         | Reason                                                     |
| --------------- | ---------------------------------------------------------- |
| Docling (:8080) | Feature reads crawl results, doesn't invoke extraction     |
| BGE-M3 (:8000)  | No embedding operations in this feature                    |
| Studio (:5173)  | Frontend tests are manual; API tests hit SearchAI directly |
| Playwright/MCP  | No browser crawling needed for tests                       |

### Data Seeding Strategy

**E2E tests** seed data exclusively via HTTP API — no direct DB access:

1. **CrawlJob seeding**: Trigger a real crawl via `POST /api/crawl/start` against a controlled fixture URL set (static test server or `httpstat.us` URLs for predictable failure codes). The crawl itself creates CrawlError documents for failures and populates `urls.crawled`, `urls.failed`, etc.
2. **SearchDocument seeding**: Crawl execution creates SearchDocuments automatically through the full pipeline. For tests that need specific `sourceMetadata` values, use a controlled fixture server that returns content designed to produce the expected quality/method attributes.
3. **Tenant context**: Use `x-tenant-id` header per `pipeline-flows.spec.ts` pattern.
4. **Cleanup**: Delete seeded data via API (e.g., `DELETE /api/crawl/{jobId}` or source deletion) to prevent test pollution.

**Integration tests** may use direct MongoDB access via Mongoose models (CrawlJob.create(), SearchDocument.create()) because they test service internals at the boundary level, not the full HTTP stack. This is consistent with the project's test architecture rules — integration tests verify service boundaries, not external API contracts.

**Note on E2E preconditions**: The E2E scenarios above describe desired data states (e.g., "CrawlJob exists with 3 CrawlError documents"). These states are achieved by triggering real crawls against fixture URLs that produce those outcomes, NOT by direct DB insertion. The implementation must include a test fixture server that serves controllable HTTP responses (200, 404, 500, timeout, robots.txt deny).

### Environment Variables

| Variable         | Value           | Purpose              |
| ---------------- | --------------- | -------------------- |
| `SEARCH_AI_PORT` | `3005`          | SearchAI server port |
| `MONGODB_URI`    | dev MongoDB URI | Test database        |
| `REDIS_URL`      | dev Redis URL   | BullMQ + pub/sub     |
| `NODE_ENV`       | `test`          | Test mode            |

---

## 8. Test File Mapping

| Test File                                                                | Type        | Covers                                                         |
| ------------------------------------------------------------------------ | ----------- | -------------------------------------------------------------- |
| `apps/search-ai/src/utils/__tests__/crawl-error-classifier.test.ts`      | unit        | FR-2, FR-2E (UT-1 to UT-5)                                     |
| `apps/search-ai/src/utils/__tests__/error-message-sanitizer.test.ts`     | unit        | UT-7, INT-5 (sanitization)                                     |
| `apps/search-ai/src/routes/__tests__/crawl-pages-merged.test.ts`         | integration | FR-4, FR-4E, FR-4P, FR-4V, FR-9 (INT-3 to INT-5, INT-8, INT-9) |
| `apps/search-ai/src/routes/__tests__/crawl-dashboard-extensions.test.ts` | integration | FR-10, FR-11 (INT-7)                                           |
| `apps/search-ai/src/workers/__tests__/crawl-error-persistence.test.ts`   | integration | FR-1, FR-3 (INT-2 — CrawlError insertOne/find round-trip)      |
| `apps/search-ai/src/workers/__tests__/crawl-quality-metrics.test.ts`     | integration | FR-14 (INT-6)                                                  |
| `apps/search-ai/src/workers/__tests__/crawl-sse-events.test.ts`          | integration | FR-12 (INT-10)                                                 |
| `apps/studio/e2e/searchai/crawl-pages-tab.spec.ts`                       | e2e         | E2E-1 to E2E-8                                                 |
| `packages/i18n/locales/__tests__/crawl-error-i18n.test.ts`               | unit        | FR-8 (UT-6)                                                    |

---

## 9. Open Testing Questions

1. **RESOLVED — Test data seeding**: E2E tests seed via real crawls against a controlled fixture HTTP server (serves 200/404/500/timeout/robots.txt). Integration tests use Mongoose models directly. See Data Seeding Strategy section.

2. **RESOLVED — Frontend testing**: FR-5, FR-6, FR-7 backend contracts are covered by INT-8, INT-9 integration tests (verify API response shapes that frontend consumes). UI rendering is Manual. FR-12 SSE events covered by INT-10 and E2E-8.

3. **Error sanitization scope**: INT-5 tests sanitization of CrawlError messages and 500 responses. Should sanitization also strip internal details from `SearchDocument.processingError` (e.g., "Docling service unreachable at http://localhost:8080")?

4. **Concurrent insertOne stress test**: PERF-2 tests concurrent CrawlError.insertOne (independent documents, should have zero contention). This is valuable but may be slow in CI. Should it be in the standard test suite or a separate performance test run?

5. **Fixture server implementation**: E2E tests need a lightweight HTTP fixture server that serves controllable responses (200 with HTML, 404, 500, slow response for timeout, robots.txt deny). Should this be a shared test utility or per-test inline server?
