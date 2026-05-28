# HLD: USP Crawl-Centric Pages Tab

**Feature Spec**: `docs/features/sub-features/usp-crawl-pages-tab.md`
**Test Spec**: `docs/testing/sub-features/usp-crawl-pages-tab.md`
**Status**: DRAFT
**Author**: Bharat
**Date**: 2026-05-17
**Revised**: 2026-05-18 — Option A → Option B for write throughput at scale

---

## 1. Problem Statement

The Unified Source Page (USP) conflates two distinct pipelines — **crawl** (URL fetching) and **document processing** (extraction → embedding → indexing) — presenting document pipeline errors as crawl errors. Per-URL crawl failures (HTTP 404, timeouts, robots.txt blocks) are emitted via SSE during crawling but **never persisted**, so after a crawl completes, operators see "20 pages failed" with no way to know which URLs or why. The status strip shows identical numbers for "Pages" and "Documents" (both query SearchDocuments), with "Failed" meaning pipeline failures rather than crawl failures.

This feature separates the two pipelines: persist per-URL crawl outcomes, merge crawl errors with document results in the API, redesign the status strip and Pages tab to show two-state per-URL status (Crawled / Indexed), and add error grouping with remediation guidance.

---

## 2. Alternatives Considered

### Option A: Populate Existing `CrawlJob.urls.errors[]` + Merge in API

- **Description**: Write per-URL errors into the existing (never-written) `CrawlJob.urls.errors[]` subdocument array using `$push/$slice`. The `/pages/:jobId` endpoint reads the already-loaded CrawlJob document and merges `urls.errors[]` alongside SearchDocument results in a single response.
- **Pros**: Zero migration — schema already exists. Single document read (CrawlJob already loaded for tenant check). Atomic cap via `$push/$slice: -1000`. No new collections or indexes.
- **Cons**: **Does not scale.** For a 50K-URL crawl with 30% failure rate, that's 15,000 `$push` operations on a single 1-2MB CrawlJob document. Each `$push/$slice` rewrites the entire `urls` subdocument. With `WINDOW_SIZE=5` concurrent fetches in bulk worker, up to 5 simultaneous `$push` ops compete for document-level lock. Live reads from `/pages` and `/dashboard` compete with these writes on the same document. The 1,000-entry `$slice` cap loses tail errors for large failure sets.
- **Effort**: S
- **Verdict**: ❌ Rejected — document-level write hotspot at scale

### Option B: Dedicated `CrawlError` Collection (errors only)

- **Description**: Create a lightweight `CrawlError` collection storing one document per failed/blocked URL. Each error is an independent `insertOne` — zero document-level contention. The `/pages/:jobId` endpoint queries `CrawlError.find({crawlJobId})` alongside SearchDocuments. Same query works whether the crawl is active or completed — **single read path**.
- **Pros**: Zero write contention — each error is its own document. Natural pagination on errors. No cap on error count. Uniform read path for active and completed crawls. TTL index for automatic cleanup. Survives pod restarts (unlike in-memory or Redis buffers).
- **Cons**: New collection + compound index. One extra query in `/pages` read path. Storage: ~500 bytes/error × 15K = ~7.5MB per large crawl (acceptable, TTL-cleaned).
- **Effort**: M

### Option C: Create `SearchDocument` Entries for Failed URLs

- **Description**: Create SearchDocuments with `status: 'crawl_failed'` for URLs that fail during crawling, so the existing `/pages` endpoint returns them naturally.
- **Pros**: No API changes needed — failed URLs appear in existing pagination. Existing UI renders them automatically.
- **Cons**: Pollutes the document pipeline — failed URLs appear in document counts, embedding queues, and index statistics. `SearchDocument` schema designed for content that entered the pipeline, not URLs that never produced content. Conflates crawl failures with pipeline failures (the exact problem we're solving). Would need new document status values that don't map to the pipeline lifecycle.
- **Effort**: M (but architecturally wrong)

### Recommendation: **Option B** — Dedicated `CrawlError` Collection

**Rationale**: Option A creates an unacceptable write hotspot at scale — 15K `$push` operations on a single document with concurrent writes and live reads competing for the same document lock. Option B eliminates this entirely: each `insertOne` is an independent document write with zero contention. The single read path (`CrawlError.find({crawlJobId})`) works identically for active crawls and completed crawls — no dual-path logic needed. The compound index `{tenantId, crawlJobId, timestamp}` gives efficient tenant-scoped queries with natural time ordering. TTL index matches the existing CrawlJob 90-day cleanup. Option C is architecturally wrong — it conflates the two pipelines we're trying to separate.

**Scaling characteristics at 50K URLs, 30% failure rate (15K errors):**

| Metric               | Option A ($push)                      | Option B (collection)                                   |
| -------------------- | ------------------------------------- | ------------------------------------------------------- |
| Write throughput     | ~1K ops/sec (document-level lock)     | ~10K+ ops/sec (independent inserts)                     |
| Write contention     | HIGH — 5 concurrent $push on same doc | ZERO — each insert is independent                       |
| Live read impact     | Competes with writes on same document | Separate collection, no lock competition                |
| Error cap            | 1,000 (tail errors lost)              | Unlimited (paginate as needed)                          |
| Storage per crawl    | ~200KB in CrawlJob (capped)           | ~7.5MB in CrawlError (TTL-cleaned)                      |
| Read path complexity | Single (from CrawlJob)                | Single (from CrawlError — same query live or completed) |
| Pod restart safety   | N/A (MongoDB)                         | ✅ (MongoDB — no Redis/memory dependency)               |

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Studio (Frontend)                          │
│                                                                     │
│  USPStatusStrip ──── CrawledPagesView ──── ErrorGroupingPanel      │
│       │                    │                      │                 │
│       └────────────────────┼──────────────────────┘                 │
│                            │                                        │
│                    GET /pages/:jobId                                │
│                    GET /dashboard/:jobId                            │
│                    SSE /progress/:jobId                             │
└────────────────────────────┼────────────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────────────┐
│                     SearchAI API (3005)                              │
│                            │                                        │
│  ┌─────────────────────────┼─────────────────────────────────┐     │
│  │            /pages/:jobId (MODIFIED)                        │     │
│  │                                                           │     │
│  │  1. CrawlJob.findOne({_id, tenantId})  ←── tenant check  │     │
│  │  2. SearchDocument.find({crawlJobId})  ←── paginated     │     │
│  │  3. CrawlError.find({crawlJobId})      ←── paginated     │     │
│  │  4. Return CrawledPagesResponse envelope                 │     │
│  └───────────────────────────────────────────────────────────┘     │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────┐     │
│  │         /dashboard/:jobId (MODIFIED)                      │     │
│  │                                                           │     │
│  │  + crawl.errorBreakdown: CrawlError.aggregate by type    │     │
│  │  + ingestion.qualityDistribution: aggregate from docs     │     │
│  └───────────────────────────────────────────────────────────┘     │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────┐     │
│  │  bulk-crawl-worker          intelligence-crawl-worker     │     │
│  │  (MODIFIED)                 (MODIFIED)                    │     │
│  │                                                           │     │
│  │  On URL failure:                                          │     │
│  │  1. classifyCrawlError(error, statusCode)                │     │
│  │  2. CrawlError.insertOne(...)  ← independent write       │     │
│  │  3. Emit SSE event (existing, + type field)              │     │
│  │                                                           │     │
│  │  On job completion:                                       │     │
│  │  4. Compute qualityMetrics aggregation (non-blocking)    │     │
│  └───────────────────────────────────────────────────────────┘     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────────────┐
│                       MongoDB                                       │
│                                                                     │
│  CrawlError (NEW)                  SearchDocument                   │
│  ├─ tenantId                       ├─ sourceMetadata.quality        │
│  ├─ crawlJobId                     ├─ sourceMetadata.qualityScore   │
│  ├─ url                            ├─ sourceMetadata.method         │
│  ├─ type (CrawlErrorType)         └─ sourceMetadata.handlerReused  │
│  ├─ error (sanitized)                                               │
│  ├─ statusCode (optional)          CrawlJob                        │
│  └─ timestamp                      ├─ urls.failed (existing)       │
│                                    ├─ urls.blocked (existing)      │
│  Indexes:                          └─ results.qualityMetrics (WRITE)│
│  ├─ {tenantId, crawlJobId, ts}                                     │
│  └─ {createdAt} TTL 90 days                                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow

**Write path (during crawl — same for active and completed):**

```
URL fails in worker
  → classifyCrawlError(errorString, statusCode?) → CrawlErrorType
  → sanitizeErrorMessage(errorString) → cleaned message
  → CrawlError.insertOne({
      tenantId,
      crawlJobId: jobId,
      url,
      type,                    // classified error type
      error: sanitized,        // cleaned message
      statusCode,              // HTTP status code if available
      timestamp: new Date()
    })  ← fire-and-forget, catch errors silently
  → CrawlJob counter update via existing checkpoint (unchanged)
  → publishProgressEvent({ type: 'url_fetched', data: { url, status: 'failed', error, type } })
```

**Key scaling property**: Each `insertOne` creates an independent document — no document-level lock contention. With `WINDOW_SIZE=5` concurrent fetches in bulk worker, all 5 `insertOne` calls execute independently. The existing time-based checkpoint (L666-677) for counter updates (`urls.crawled`, `urls.failed`, `urls.blocked`) remains unchanged.

**Read path — UNIFIED for both active crawls and completed crawls:**

```
GET /pages/:jobId?status=all&limit=50&offset=0
  → CrawlJob.findOne({ _id: jobId, tenantId })           ← auth + counters
  → [parallel]:
     → SearchDocument.find({ tenantId, 'sourceMetadata.crawlJobId': jobId })
        .sort({ createdAt: -1 }).skip(offset).limit(limit)  ← paginated pages
     → SearchDocument.countDocuments(query)                   ← total for pagination
     → SearchChunk.aggregate([...])                           ← chunk counts per doc
     → CrawlError.find({ tenantId, crawlJobId: jobId })
        .sort({ timestamp: -1 }).limit(errorLimit)            ← errors (paginated)
     → CrawlError.countDocuments({ tenantId, crawlJobId: jobId }) ← total errors
  → Merge:
     - pages[]: from SearchDocuments (with quality/method/handlerReused from sourceMetadata)
     - crawlErrors[]: from CrawlError collection (paginated, with type/statusCode)
     - totalFailed: from crawlJob.urls.failed (authoritative counter)
     - totalBlocked: from crawlJob.urls.blocked
     - totalErrors: from CrawlError.countDocuments (may be < totalFailed for old jobs)
     - pagination: { total, offset, limit, hasMore }
     - errorPagination: { total: totalErrors, offset: errorOffset, limit: errorLimit, hasMore }
  → Wrap in { success: true, data: CrawledPagesResponse }
```

**Why this works identically for active and completed crawls**: The `CrawlError.find()` query returns whatever errors have been inserted so far. During an active crawl, new errors appear in subsequent polls (SWR `refreshInterval` on the frontend). After completion, the query returns the final set. No dual-path logic, no Redis vs MongoDB switching.

**Dashboard extension:**

```
GET /dashboard/:jobId
  → (existing logic loads CrawlJob)
  → + crawl.errorBreakdown:
     CrawlError.aggregate([
       { $match: { tenantId, crawlJobId: jobId } },
       { $group: { _id: '$type', count: { $sum: 1 } } }
     ])  ← uses compound index, works during active and completed crawls
  → + ingestion.qualityDistribution:
     IF crawlJob.results.qualityMetrics exists (job completed):
       → derive from stored metrics (no extra query)
     ELSE (job in progress):
       → SearchDocument.aggregate([
           { $match: { tenantId, 'sourceMetadata.crawlJobId': jobId } },
           { $group: { _id: '$sourceMetadata.quality', count: { $sum: 1 } } }
         ])  ← real-time aggregation during active crawl
```

### Sequence Diagram — Error Persistence During Crawl

```
Worker          classifyCrawlError    MongoDB(CrawlError)  MongoDB(CrawlJob)  Redis(SSE)
  │                    │                    │                    │                │
  │ URL fails          │                    │                    │                │
  │───────────────────>│                    │                    │                │
  │   classify(err)    │                    │                    │                │
  │<───────────────────│                    │                    │                │
  │   type: http_4xx   │                    │                    │                │
  │                    │                    │                    │                │
  │ insertOne(error)   │                    │                    │                │
  │────────────────────────────────────────>│                    │                │
  │ (fire-and-forget, independent doc)      │                    │                │
  │                    │                    │                    │                │
  │ checkpoint counter (time-based)         │                    │                │
  │─────────────────────────────────────────────────────────────>│                │
  │ $inc urls.failed (batched with other counters)              │                │
  │                    │                    │                    │                │
  │ publish SSE event  │                    │                    │                │
  │──────────────────────────────────────────────────────────────────────────────>│
  │ { type: url_fetched, data: { url, status: failed, type }}                    │
  │                    │                    │                    │                │
  │ continue to next URL                   │                    │                │
```

**Key difference from Option A**: The `insertOne` to `CrawlError` and the counter checkpoint to `CrawlJob` are independent operations on different collections — no document-level lock contention.

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern              | Design Decision                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation** | All queries include `tenantId`. CrawlJob lookup: `findOne({ _id: jobId, tenantId })`. SearchDocument query: `{ tenantId, 'sourceMetadata.crawlJobId': jobId }`. **CrawlError**: `{ tenantId, crawlJobId: jobId }` — compound index enforces tenant-scoped queries. Worker writes include `tenantId` from BullMQ job payload. Cross-tenant returns 404 per platform invariant.                            |
| 2   | **Data Access**      | Direct Mongoose model access (existing pattern). CrawlError model follows same pattern as CrawlJob/SearchDocument — no repository layer. Read path adds one parallel query (`CrawlError.find`) alongside existing SearchDocument query. No caching — data changes on every crawl progress update.                                                                                                        |
| 3   | **API Contract**     | `/pages/:jobId` response shape is **additive** — existing fields (`pages`, `total`, `pagination`) unchanged. New fields: `crawlErrors[]`, `totalFailed`, `totalBlocked`, `totalErrors`, `errorPagination`. Response wrapped in standard envelope `{ success: true, data: CrawledPagesResponse }`. Error envelope: `{ success: false, error: { code, message } }`. No versioning needed — additive.       |
| 4   | **Security Surface** | Error messages sanitized before persistence — strip internal hostnames (`127.0.0.1`, `localhost`), ports, stack traces. CrawlError documents contain URLs and sanitized error messages — no PII. 500 responses use generic message (log details server-side). No new auth surface — reuses existing `req.tenantContext` middleware. Input validation: malformed jobId returns 400 with structured error. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5   | **Error Model**   | **Worker errors**: Error persistence is best-effort fire-and-forget. If `insertOne` fails, worker logs and continues. `urls.failed` counter (incremented via existing checkpoint) remains authoritative. **API errors**: 404 for non-existent/wrong-tenant job, 400 for malformed jobId, 500 for unexpected errors (sanitized). **Frontend**: when `totalFailed > 0 && crawlErrors.length === 0`, show "error details not available for this crawl" (handles old jobs pre-feature).                                                              |
| 6   | **Failure Modes** | **MongoDB insertOne failure**: worker catches, logs, continues crawling — error detail lost but counter accurate. **CrawlError collection unavailable**: `/pages` falls back to returning empty `crawlErrors[]` with `totalFailed` from CrawlJob counter — frontend shows "X pages failed" without details. **Aggregation timeout**: errorBreakdown and qualityMetrics computations wrapped in try/catch with 5s timeout — endpoint returns partial data. **Frontend degradation**: old frontends ignore new response fields (additive).         |
| 7   | **Idempotency**   | Worker retries may insert duplicate CrawlError documents for the same URL. This is acceptable because: (1) error arrays are informational, not transactional, (2) `urls.failed` counter is the authoritative count (incremented once per failure in the checkpoint), (3) duplicates are bounded by retry count (typically 0-1 retries). A unique index on `{crawlJobId, url}` could prevent duplicates but adds `insertOne` failure handling complexity — not worth it for informational data. Dashboard aggregation is read-only and stateless. |
| 8   | **Observability** | Existing crawl progress SSE events extended with `type` field for real-time error classification. Existing `createLogger('crawl')` used for error persistence failures. `CrawlError.countDocuments` vs `crawlJob.urls.failed` divergence logged as a warning (indicates lost error details). Dashboard errorBreakdown provides aggregate observability via MongoDB aggregation.                                                                                                                                                                  |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | **Write path**: `insertOne` adds <1ms per URL failure (independent document, no lock contention). At WINDOW_SIZE=5 with 50K URLs, peak write rate ~50 inserts/sec — trivial for MongoDB. **Read path /pages**: one additional `CrawlError.find()` query (indexed, parallel with SearchDocument query) — adds ~2-5ms. **Read path /dashboard**: `CrawlError.aggregate` groupBy type — ~5-10ms on compound index for 15K docs. **Payload**: crawlErrors[100] (paginated) = ~50KB + pages[50] = ~25KB = ~75KB total. **qualityMetrics aggregation**: 5s budget, non-blocking post-completion.  |
| 10  | **Migration Path**     | **New collection only.** CrawlError collection is created on first write (Mongoose auto-creation). Compound index `{tenantId, crawlJobId, timestamp}` must be created explicitly (in model definition). No existing data to migrate. Old CrawlJob documents have empty `urls.errors[]` — no backfill needed. Old jobs: `totalFailed > 0 && totalErrors === 0` handled by frontend "details not available" copy. Jobs and associated CrawlErrors age out via 90-day TTL indexes (on both collections).                                                                                       |
| 11  | **Rollback Plan**      | **Backend**: revert commit removes CrawlError model, worker insertOne calls, and `/pages` merge logic. CrawlError collection can be dropped (`db.crawl_errors.drop()`) or left to TTL-clean itself. Existing CrawlJob fields unchanged — frontend falls back to current behavior. **Frontend**: revert restores old components. **No feature flag needed** — response is additive, old frontends ignore new fields. Backend and frontend can be rolled back independently.                                                                                                                  |
| 12  | **Test Strategy**      | **Unit** (7 scenarios): error classifier pure function, remediation text mapping, error sanitizer. **Integration** (10 scenarios): CrawlError insertOne + find round-trip, /pages merge (zero docs + zero errors, mixed, errors-only), error sanitization, errorBreakdown aggregation, qualityMetrics aggregation, dashboard compound query, SSE event shape, two-state model response shape. **E2E** (8 scenarios): merged response, cross-tenant 404, sourceMetadata fields, dashboard extensions, pagination, error pagination, invalid jobId, real-time SSE. Full details in test spec. |

---

## 5. Data Model

### New Collection: `CrawlError`

```typescript
// packages/database/src/models/crawl-error.model.ts
export interface ICrawlError {
  _id: string;
  tenantId: string;
  crawlJobId: string;
  url: string;
  type: CrawlErrorType;
  error: string; // Sanitized error message
  statusCode?: number; // HTTP status code if available (e.g., 404, 500)
  timestamp: Date;
  createdAt: Date; // For TTL index
}
```

**Indexes:**

```typescript
// Compound index for tenant-scoped queries by crawl job
crawlErrorSchema.index({ tenantId: 1, crawlJobId: 1, timestamp: -1 });

// TTL index — auto-delete after 90 days (matches CrawlJob TTL)
crawlErrorSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
```

**Collection name**: `crawl_errors`

**Storage estimate**: ~500 bytes/document × 15,000 errors (50K crawl, 30% failure) = ~7.5MB per large crawl. With 90-day TTL and typical crawl frequency (weekly), peak storage per tenant: ~30MB. Negligible compared to SearchDocument storage.

### Modified Collections

#### CrawlJob — `results` subdocument (unchanged from v1)

```typescript
// EXISTING schema, NEWLY POPULATED:
results: {
  // ... existing fields unchanged ...
  qualityMetrics: {
    // Schema already exists at crawl-job.model.ts:79-84
    // Currently never written — this feature writes it at job completion
    avgQualityScore: number;
    avgContentPreservation: number;
    avgChunksPerDoc: number;
    successRate: number;
  }
}
```

**Note**: `CrawlJob.urls.errors[]` schema remains in the model but is **NOT populated** by this feature. It stays as-is for backward compatibility. All error persistence goes to the `CrawlError` collection.

### New Types

```typescript
// packages/crawler/src/types/crawl-error.ts
type CrawlErrorType =
  | 'http_4xx'
  | 'http_5xx'
  | 'connection_error'
  | 'timeout'
  | 'robots_blocked'
  | 'quality_gated'
  | 'content_filtered'
  | 'ssrf_blocked'
  | 'crawl_error'; // catch-all fallback
```

#### SearchDocument — `sourceMetadata` (write-side gap fix)

```typescript
// EXISTING field, NOT CURRENTLY WRITTEN by workers:
sourceMetadata: {
  // ...existing fields...
  method: 'http' | 'playwright'; // NEW — must be added to both workers' ingestion metadata
  // quality, qualityScore, handlerReused already written by bulk worker
  // quality, qualityScore NOT written by intelligence worker — T-3 must add these
}
```

**Write-side changes required:**

- **Bulk worker** (L301-310): Already passes `quality`, `qualityScore`, `handlerReused`. Must ADD `method: strategy === 'browser' ? 'playwright' : 'http'` (from the `section?.strategy` check in `processUrl`).
- **Intelligence worker** (L723-728): Only passes `crawlJobId`, `crawledAt`, `domain`, `handlerReused`. Must ADD `quality`, `qualityScore` (from quality gate result), and `method` (derived from whether MCP/Playwright was used).

### Key Relationships

```
CrawlError.crawlJobId ──(references)──> CrawlJob._id
CrawlError.url ──(matches)──> SearchDocument.originalReference (for URL-level correlation)
CrawlJob._id ──(crawlJobId)──> SearchDocument.sourceMetadata.crawlJobId
CrawlJob.urls.failed ──(authoritative count, ≥ CrawlError.countDocuments for job)
```

---

## 6. API Design

### Modified Endpoints

#### `GET /pages/:jobId` — Merged Pages + Crawl Errors

**Current response** (unchanged fields):

```json
{
  "success": true,
  "jobId": "...",
  "pages": [
    { "url": "...", "status": "indexed", "documentId": "...", "chunks": 3, "crawledAt": "..." }
  ],
  "total": 786,
  "pagination": { "limit": 50, "offset": 0, "hasMore": true }
}
```

**New response** (additive):

```json
{
  "success": true,
  "data": {
    "pages": [
      {
        "url": "https://example.com/page",
        "status": "indexed",
        "documentId": "...",
        "chunks": 3,
        "crawledAt": "2026-05-17T10:00:00Z",
        "quality": "rich",
        "qualityScore": 0.92,
        "method": "http",
        "handlerReused": true,
        "error": null
      }
    ],
    "crawlErrors": [
      {
        "url": "https://example.com/missing",
        "type": "http_4xx",
        "error": "Page returned HTTP 404",
        "statusCode": 404,
        "timestamp": "2026-05-17T10:01:00Z"
      }
    ],
    "totalFailed": 15000,
    "totalBlocked": 200,
    "totalErrors": 15000,
    "pagination": { "total": 786, "offset": 0, "limit": 50, "hasMore": true },
    "errorPagination": { "total": 15000, "offset": 0, "limit": 100, "hasMore": true }
  }
}
```

**Breaking change note**: The response moves from flat `{ success, jobId, pages, total, pagination }` to envelope `{ success, data: { pages, crawlErrors, ..., pagination } }`. This is a **necessary breaking change** to align with the project standard envelope `{ success, data?, error? }`. The frontend must be updated in the same wave.

**Query parameters** (unchanged + new):

| Param         | Type   | Default | Description                              |
| ------------- | ------ | ------- | ---------------------------------------- |
| `limit`       | number | 50      | Pages per page                           |
| `offset`      | number | 0       | Pages offset                             |
| `status`      | string | `all`   | Filter pages (see table below)           |
| `search`      | string | —       | URL search                               |
| `errorLimit`  | number | 100     | Crawl errors per page                    |
| `errorOffset` | number | 0       | Crawl errors offset                      |
| `errorType`   | string | —       | Filter errors by type (e.g., `http_4xx`) |

**Status filter values** (replaces current `success/failed/all`):

| Value     | Behavior                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| `all`     | All pages + all crawlErrors (default)                                                                            |
| `fetched` | Only `pages[]` where `status` is NOT `'error'` — successfully crawled pages                                      |
| `failed`  | Only `pages[]` where `status === 'error'` (pipeline failures). `crawlErrors[]` still returned.                   |
| `blocked` | Only `crawlErrors[]` where `type` in `['robots_blocked', 'quality_gated', 'content_filtered']`. Empty `pages[]`. |

**Error pagination**: Unlike Option A where `crawlErrors[]` was capped at 1000 and returned in full, Option B paginates errors properly. The frontend can load more errors on scroll or filter by error type. Default `errorLimit=100` keeps initial payload small.

**Design decision — `origin` field vs structural separation**: The feature spec FR-4 mentions an `origin` field (`'document'` vs `'crawl_error'`) to distinguish entry types. This HLD replaces that with **structural separation** — `pages[]` (from SearchDocuments) and `crawlErrors[]` (from CrawlError collection) are separate arrays with different shapes. This is cleaner than a discriminated union because: (1) the two entry types have different fields (pages have `documentId`, `chunks`, `status`; errors have `type`, `statusCode`, `timestamp`), (2) pagination applies independently to pages and errors, (3) the frontend naturally renders them in different UI sections. No explicit `origin` field is needed — array membership IS the discriminator.

#### `GET /dashboard/:jobId` — Error Breakdown + Quality Distribution

**Additions** to existing response (additive):

```json
{
  "crawl": {
    "...existing fields...",
    "errorBreakdown": [
      { "type": "http_4xx", "count": 8000 },
      { "type": "timeout", "count": 3000 },
      { "type": "robots_blocked", "count": 4000 }
    ]
  },
  "ingestion": {
    "...existing fields...",
    "qualityDistribution": { "rich": 650, "standard": 100, "thin": 36 }
  }
}
```

**Note**: `errorBreakdown` uses `CrawlError.aggregate` — works at any scale because the compound index covers the `$match` and the `$group` is bounded by the 9 error types (constant-time grouping). Works identically during active and completed crawls.

### Error Responses

| Status | Code              | When                         | Example Message            |
| ------ | ----------------- | ---------------------------- | -------------------------- |
| 400    | `INVALID_REQUEST` | Malformed jobId              | "Invalid job ID format"    |
| 401    | `UNAUTHORIZED`    | Missing auth                 | "Authentication required"  |
| 404    | `NOT_FOUND`       | Job doesn't exist for tenant | "Crawl job not found"      |
| 500    | `INTERNAL_ERROR`  | Unexpected server error      | "Failed to get crawl data" |

All errors wrapped in `{ success: false, error: { code, message } }`. 500 errors never leak stack traces or internal hostnames.

### No New Endpoints

All changes modify existing endpoints. No new routes needed.

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: No new audit logging — crawl error persistence is operational data, not a security event. Existing worker logging captures URL processing outcomes.
- **Rate Limiting**: No new rate limiting — existing endpoint rate limits apply. Paginated error responses keep payload sizes bounded.
- **Caching**: No caching for `/pages` or `/dashboard` — data changes on every crawl progress event. SWR `refreshInterval` on the frontend provides client-side staleness management.
- **Encryption**: No new encryption requirements — error messages contain URLs and HTTP status codes, not PII. Error sanitization strips internal infrastructure details before persistence.
- **i18n**: New i18n keys under `search_ai.crawled_pages.error_types.*` (9 keys) and `search_ai.crawled_pages.remediation.*` (9 keys) in `packages/i18n`.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                     | Type    | Risk                                                                          |
| ------------------------------ | ------- | ----------------------------------------------------------------------------- |
| CrawlJob model (MongoDB)       | Data    | Low — read-only for counters, no schema changes to CrawlJob                   |
| SearchDocument model           | Data    | Low — read-only, no changes to SearchDocument schema                          |
| HttpAdapter (packages/crawler) | Library | Low — already exposes `statusCode` in `HttpFetchResult`; need to propagate it |
| SSE/Redis pub/sub              | Infra   | Low — existing infrastructure, only adding `type` field to event payload      |
| Existing /pages endpoint       | API     | Medium — modifying response shape (envelope wrapping is a breaking change)    |
| MongoDB                        | Infra   | Low — new collection, standard Mongoose patterns, auto-created on first write |

### Downstream (depends on this feature)

| Consumer                  | Impact                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------ |
| CrawledPagesView (Studio) | Must be updated to consume new response shape — deploy frontend and backend together |
| USPStatusStrip (Studio)   | Must be updated for two-row metrics layout — deploy with CrawledPagesView            |
| ErrorGroupingPanel        | Must be rewritten to use backend-provided `type` field and error pagination          |
| useCrawlProgress hook     | Must handle `type` field in SSE failure events for real-time display                 |

---

## 9. Task Decomposition

| Task | Description                           | Package(s)                 | Independent? | Est. Files | Wave |
| ---- | ------------------------------------- | -------------------------- | ------------ | ---------- | ---- |
| T-0  | CrawlError model + indexes            | packages/database          | Yes          | 1-2        | 1    |
| T-1  | Error classifier + sanitizer          | packages/crawler           | Yes          | 3-4        | 1    |
| T-2  | Bulk worker error persistence         | apps/search-ai             | No (T-0,T-1) | 1-2        | 1    |
| T-3  | Intelligence worker error persistence | apps/search-ai             | No (T-0,T-1) | 1-2        | 1    |
| T-4  | Extend /pages/:jobId endpoint         | apps/search-ai             | No (T-0)     | 1-2        | 2    |
| T-5  | Extend /dashboard/:jobId endpoint     | apps/search-ai             | No (T-0,T-4) | 1          | 2    |
| T-6  | API types + i18n keys                 | apps/studio, packages/i18n | Yes          | 2-3        | 3    |
| T-7  | Redesign USPStatusStrip               | apps/studio                | No (T-6)     | 1-2        | 3    |
| T-8  | Redesign CrawledPagesView             | apps/studio                | No (T-6)     | 1-2        | 3    |
| T-9  | Redesign ErrorGroupingPanel           | apps/studio                | No (T-6)     | 1-2        | 3    |

**Wave structure:**

- **Wave 1** (T-0, T-1, T-2, T-3): Backend persistence — CrawlError model, error classifier, both workers. T-0 and T-1 are independent of each other; T-2 and T-3 depend on both T-0 and T-1 but are independent of each other.
- **Wave 2** (T-4, T-5): API extensions — depend on Wave 1 data being persisted. T-5 depends on T-4 patterns.
- **Wave 3** (T-6, T-7, T-8, T-9): Frontend redesign — depends on Wave 2 API contracts. T-6 is independent; T-7/T-8/T-9 depend on T-6 but are independent of each other.

---

## 10. Open Questions & Decisions Needed

1. **Error sanitization depth**: How aggressively to strip internal details. Current plan: replace `127.0.0.1`, `localhost`, `0.0.0.0` with `[internal]`, strip port numbers from connection errors, never include stack traces. Need to verify this covers all HttpAdapter error formats during implementation.

2. **CrawlError index coverage**: The compound index `{tenantId, crawlJobId, timestamp}` should cover all read queries. Need to verify via `explain()` during implementation that the `/dashboard` aggregation ($match + $group) uses the index prefix efficiently.

3. **Intelligence worker qualityScore gap**: The intelligence-crawl-worker (L723-728) omits `qualityScore` and `quality` from ingestion metadata — only bulk worker stores these. T-3 must add these fields. The quality gate is already imported in the intelligence worker for gating decisions; need to verify the score is available at ingestion time.

4. **Error pagination defaults**: Default `errorLimit=100` chosen to keep initial payload small while showing meaningful error grouping. May need tuning based on real-world usage patterns — monitor frontend's error tab scroll behavior.

5. **Duplicate error documents on worker retry**: Decided to accept duplicates (see Idempotency concern #7). If production shows excessive duplication, a unique index on `{crawlJobId, url}` can be added later with `{ unique: true, dropDups: true }`.

---

## 11. References

- Feature spec: `docs/features/sub-features/usp-crawl-pages-tab.md`
- Test spec: `docs/testing/sub-features/usp-crawl-pages-tab.md`
- Parent USP HLD: `docs/specs/unified-source-page.hld.md`
- CrawlJob model: `packages/database/src/models/crawl-job.model.ts`
- Crawl workers: `apps/search-ai/src/workers/bulk-crawl-worker.ts`, `intelligence-crawl-worker.ts`
- Pages endpoint: `apps/search-ai/src/routes/crawl.ts` (L2970)
- Dashboard endpoint: `apps/search-ai/src/routes/crawl.ts` (L2382)
- HttpAdapter: `packages/crawler/src/intelligence/algorithms/http-adapter.ts`
- Error classifier precedent: `packages/crawler/src/intelligence/algorithms/failure-scorer.ts`
- Frontend components: `apps/studio/src/components/search-ai/CrawledPagesView.tsx`, `source-page/USPStatusStrip.tsx`, `source-page/ErrorGroupingPanel.tsx`
- Frontend API types: `apps/studio/src/api/crawl.ts` (L214-224)
