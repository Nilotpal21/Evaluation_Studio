# Feature: USP Crawl-Centric Pages Tab

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Web Crawling](../web-crawling.md)
**Status**: PLANNED
**Feature Area(s)**: `customer experience`, `observability`
**Package(s)**: `apps/search-ai`, `apps/studio`, `packages/database`, `packages/i18n`
**Owner(s)**: SearchAI Team
**Testing Guide**: `../../testing/sub-features/usp-crawl-pages-tab.md`
**Last Updated**: 2026-05-17

---

## 1. Introduction / Overview

### Problem Statement

The Unified Source Page (USP) currently displays document processing results (SearchDocuments) as if they were crawl results, conflating two distinct pipelines. When a user views their source's "Pages" tab, they see Docling extraction errors ("Docling service unreachable at localhost:8080") instead of crawl-level information (which pages were fetched, which returned HTTP 404, which were blocked by robots.txt). URLs that failed during crawling (HTTP errors, timeouts, connection failures) are **never persisted** — only counted as `CrawlJob.urls.failed` — so individual failure details are permanently lost after the crawl completes.

This creates three concrete problems:

1. **Misleading error attribution**: Document pipeline errors (extraction, embedding) are displayed as crawl errors, confusing users about what actually went wrong.
2. **Lost failure details**: Per-URL crawl errors (HTTP 404, timeout, robots.txt block) are emitted via SSE during the crawl but never persisted. After the crawl ends, the user sees "20 pages failed" but can never know which URLs or why.
3. **No crawl-vs-pipeline separation**: The status strip shows `Pages 786 Documents 786 Failed 22` — misleading because "Pages" and "Documents" are the same number (both query SearchDocuments), and "Failed" means pipeline failures, not crawl failures.

### Goal Statement

Redesign the USP source view to be **crawl-centric**: persist per-URL crawl outcomes (success/fail/blocked/skipped with error details), separate crawl metrics from document pipeline metrics in the status strip, add error grouping by error type with remediation guidance, and show a two-state per-URL status model (Crawled / Indexed) that cleanly separates "was the page fetched?" from "is it searchable?".

### Summary

This sub-feature makes three categories of changes:

1. **Backend**: Persist per-URL crawl errors to a dedicated `CrawlError` collection (high write throughput, no document-level contention) from both crawl workers, extend the `/pages/:jobId` API to merge crawl failures with document results, and add error breakdown + quality distribution to the `DashboardResponse`.
2. **Frontend**: Redesign the USP status strip to show crawl metrics (URLs attempted / fetched / failed / blocked) separately from pipeline metrics (documents indexed / processing errors). Add error grouping panel that separates crawl errors from processing errors with remediation guidance. Implement two-state per-URL status (Crawled ✅ / Indexed ✅).
3. **Data surfacing**: Expose quality scores, crawl method, and handler reuse data that already exists in `SearchDocument.sourceMetadata` but is omitted by the current API.

---

## 2. Scope

### Goals

- G1: Persist per-URL crawl error details (URL, error type, error message, timestamp) in a dedicated `CrawlError` collection for both `bulk-crawl-worker` and `intelligence-crawl-worker`
- G2: Separate crawl-level metrics from document pipeline metrics in the USP status strip
- G3: Group errors by type (crawl errors vs processing errors) with actionable remediation copy
- G4: Show two-state per-URL status: **Crawled** (URL fetched) and **Indexed** (fully processed and searchable)
- G5: Surface per-URL quality scores, crawl method, and handler reuse data from existing `sourceMetadata`
- G6: Show failed/blocked/skipped URLs in the Pages tab (currently invisible — no SearchDocument exists for them)
- G7: Provide real-time error visibility during active crawls (failed URLs appear immediately, not just after completion)
- G8: Add error breakdown and quality distribution to DashboardResponse for live crawl monitoring

### Non-Goals (Out of Scope)

- NG1: Re-crawl comparison UI (Journey 5) — `CrawlJob.comparison` data surfacing is P1 for a future iteration
- NG2: Bulk retry-by-error-group functionality — per-document retry already exists; group retry is P1
- NG3: Separate "Documents" tab — the existing KB detail page Data tab already shows documents
- NG4: ~~New MongoDB collection for crawl page results~~ — **REVISED in HLD**: A dedicated `CrawlError` collection is required for write throughput at scale (50K+ URLs). `CrawlJob.urls.errors[]` creates a document-level write hotspot.
- NG5: Crawl error alerting/notifications — no email/webhook on error threshold
- NG6: Custom error remediation copy per-tenant — remediation text is static, derived from error type
- NG7: Historical error trend analysis across crawl jobs

---

## 3. User Stories

1. As a **knowledge base operator**, I want to see which specific URLs failed during crawling and why (HTTP 404, timeout, robots blocked) so that I can fix the source site or adjust my crawl configuration.
2. As a **knowledge base operator**, I want to distinguish between "URL couldn't be fetched" (crawl error) and "URL was fetched but processing failed" (pipeline error) so that I know whether the problem is with the target site or with my platform services.
3. As a **knowledge base operator**, I want to see crawl-level stats (URLs attempted, fetched, failed, blocked) separately from pipeline stats (documents indexed, processing errors) so that I get an accurate picture of crawl coverage vs content readiness.
4. As a **knowledge base operator**, I want to see the quality distribution of crawled pages (rich / standard / thin) so that I can assess whether the crawled content is good enough for my knowledge base.
5. As a **knowledge base operator**, I want to see failed URLs appear in real-time during an active crawl so that I can spot systematic issues (e.g., all /api/ paths returning 403) before the crawl finishes.
6. As a **knowledge base operator**, I want error groups to include remediation hints (e.g., "Check if authentication is required" for 403 errors) so that I can take action without needing to understand HTTP status codes.
7. As a **knowledge base operator**, I want each page row to show whether it was crawled successfully and whether it's been fully indexed so that I can quickly identify pages stuck in the pipeline.

---

## 4. Functional Requirements

1. **FR-1**: The system must persist per-URL crawl error details in a dedicated `CrawlError` collection when a URL fails during the crawl phase, including the URL, classified error type, sanitized error message, HTTP status code (when available), and timestamp. Each error is an independent document — no document-level contention.
2. **FR-2**: The system must classify crawl errors into these categories: `http_4xx`, `http_5xx`, `connection_error`, `timeout`, `robots_blocked`, `quality_gated`, `content_filtered`, `ssrf_blocked`, `crawl_error` (catch-all).
3. **FR-3**: The `CrawlError` collection stores all errors without a cap. The API paginates errors via `errorLimit`/`errorOffset` query parameters (default: 100 per page). The `CrawlJob.urls.failed` counter remains the authoritative failure count. A TTL index on `CrawlError` auto-deletes records after 90 days (matching CrawlJob TTL).
4. **FR-4**: The `/api/crawl/pages/:jobId` endpoint must return both SearchDocument results (for crawled pages) and `CrawlError` documents (for failed/blocked pages) in a single response, using **structural separation** — `pages[]` and `crawlErrors[]` are separate arrays with different shapes (array membership is the discriminator; no explicit `origin` field needed). Both pages and errors are independently paginated. The response must use the project standard envelope: `{ success: true, data: CrawledPagesResponse }`. The same query works for both active (in-progress) and completed crawls — no dual-path logic.
5. **FR-5**: The USP status strip must display two rows of metrics:

- Row 1 (Crawl): URLs Attempted, Fetched, Failed, Blocked
- Row 2 (Pipeline): Documents Indexed, Processing Errors, Duration, Quality Distribution

6. **FR-6**: The Pages tab must display all URLs — successful, failed, blocked, and skipped — with a two-state status model:

- **Crawled**: ✅ (fetched), ❌ (failed), ⏭ (skipped/blocked)
- **Indexed**: ✅ (indexed), ⏳ (processing), ❌ (error), — (not applicable)

7. **FR-7**: The error grouping panel must separate errors into two sections — "Crawl Errors" and "Processing Errors" — with each section showing error groups by type, count per group, and expandable URL lists.
8. **FR-8**: Each error group must display remediation guidance text derived from the error type (e.g., 403 → "Check if authentication is required for this section", timeout → "Page may require browser rendering", Docling error → "Extraction service may be unavailable").
9. **FR-9**: The `/api/crawl/pages/:jobId` endpoint must return `quality`, `qualityScore`, `handlerReused`, and `method` fields from `SearchDocument.sourceMetadata` for each successful page.
10. **FR-10**: The `DashboardResponse` must include `crawl.errorBreakdown: Array<{type: string, count: number}>` for real-time error grouping during active crawls.
11. **FR-11**: The `DashboardResponse` must include `ingestion.qualityDistribution: {rich: number, standard: number, thin: number}` for real-time quality visibility during active crawls.
12. **FR-12**: Failed URLs must appear in the Pages tab in real-time during an active crawl via SSE events, not only after crawl completion. Bulk crawl emits `url_fetched` events with `data.status: 'failed'` and `data.error.message`. Intelligence crawl emits `intelligence_page_failed` events with `data.url` and `data.error.message`. The frontend must handle both event types to display failures in real-time.
13. **FR-13**: The Pages tab filter bar must support filtering by crawl status (`All`, `Fetched`, `Failed`, `Blocked`) in addition to the existing search-by-URL.
14. **FR-14**: The system must compute and store `CrawlJob.results.qualityMetrics` (avgQualityScore, avgContentPreservation, avgChunksPerDoc, successRate) at job completion. The schema exists but is currently never written to.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                       |
| -------------------------- | ------------ | ----------------------------------------------------------- |
| Project lifecycle          | NONE         | No project lifecycle changes                                |
| Agent lifecycle            | NONE         | No agent lifecycle changes                                  |
| Customer experience        | PRIMARY      | Core UX improvement — how operators understand crawl health |
| Integrations / channels    | NONE         | No channel impact                                           |
| Observability / tracing    | SECONDARY    | Better error categorization improves debugging              |
| Governance / controls      | NONE         | No governance changes                                       |
| Enterprise / compliance    | NONE         | No compliance changes                                       |
| Admin / operator workflows | SECONDARY    | Operators can diagnose crawl issues without support tickets |

### Related Feature Integration Matrix

| Related Feature                             | Relationship Type | Why It Matters                                                   | Key Touchpoints                                     | Current State                             |
| ------------------------------------------- | ----------------- | ---------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| [Web Crawling](../web-crawling.md)          | extends           | Parent feature — this redesigns how crawl results are presented  | CrawlJob model, crawl workers, /pages endpoint      | ALPHA — crawl works, results view is gap  |
| USP (docs/specs/unified-source-page.hld.md) | extends           | This redesigns the Pages tab and status strip within USP         | USPStatusStrip, CrawledPagesView, UnifiedSourcePage | ALPHA — implemented, Pages tab needs work |
| Document Processing Pipeline                | shares data with  | Pipeline status (extracting→indexed) feeds the "Indexed" column  | SearchDocument.status, docling/embedding workers    | STABLE — works independently              |
| Crawl Progress (SSE)                        | depends on        | Real-time failed URL display depends on SSE event infrastructure | useCrawlProgress, progress.ts, Redis pub/sub        | STABLE — works for success events         |

---

## 6. Design Considerations

### Two-State Per-URL Model

Each URL in the Pages tab shows two orthogonal statuses:

| Crawled    | Indexed       | User Sees                             |
| ---------- | ------------- | ------------------------------------- |
| ✅ Fetched | ✅ Indexed    | Fully processed and searchable        |
| ✅ Fetched | ⏳ Processing | Fetched, pipeline in progress         |
| ✅ Fetched | ❌ Error      | Fetched but pipeline failed           |
| ❌ Failed  | —             | HTTP error, timeout, connection error |
| ⏭ Blocked | —             | Robots.txt, quality-gated, filtered   |

Users needing pipeline details (which extraction stage failed, Docling logs) navigate to the KB detail page's Documents/Data tab.

### Status Strip Redesign

```
┌──────────────────────────────────────────────────────────────────┐
│ Crawl complete with issues — 22 pages failed                     │
│                                                                  │
│  URLs Attempted: 808    Fetched: 786    Failed: 20    Blocked: 2 │
│  Documents: 764 indexed  │  22 processing errors                 │
│  Duration: 11m 53s       │  ████████████░░  94% rich  4% std     │
└──────────────────────────────────────────────────────────────────┘
```

### Error Grouping Panel

```
┌─ Error Summary ──────────────────────────────────────────────────┐
│ CRAWL ERRORS (12 pages)                                          │
│ ├─ HTTP 404 Not Found .............. 8 pages  [View URLs]        │
│ │   ℹ️ Pages may have been moved or deleted                       │
│ ├─ Connection Timeout .............. 3 pages  [View URLs]        │
│ │   ℹ️ Pages may require browser rendering — try Playwright       │
│ └─ Blocked by robots.txt .......... 1 page   [View URLs]        │
│     ℹ️ Site owner disallows crawling this path                    │
│                                                                  │
│ PROCESSING ERRORS (10 pages)                                     │
│ ├─ Extraction failed .............. 8 pages  [View URLs]         │
│ │   ℹ️ Extraction service may be unavailable                      │
│ └─ Embedding failed ............... 2 pages  [View URLs]         │
│     ℹ️ Embedding service error — pages can be retried             │
└──────────────────────────────────────────────────────────────────┘
```

### Error Type Classification

| Error Category      | Error Type          | Source                          | Remediation Hint                                           |
| ------------------- | ------------------- | ------------------------------- | ---------------------------------------------------------- |
| **Crawl Errors**    | `http_4xx`          | HTTP 400-499 response           | "Page returned {code} — may have moved or require auth"    |
|                     | `http_5xx`          | HTTP 500-599 response           | "Server error — the target site may be having issues"      |
|                     | `connection_error`  | ECONNREFUSED, ECONNRESET, DNS   | "Could not connect — check if the site is accessible"      |
|                     | `timeout`           | Request exceeded time limit     | "Page took too long — may require browser rendering"       |
|                     | `robots_blocked`    | robots.txt disallow             | "Site owner disallows crawling this path"                  |
|                     | `quality_gated`     | Score < 0.3 (intelligence only) | "Page content too thin — mostly navigation or boilerplate" |
|                     | `content_filtered`  | Keyword filter no match         | "Page didn't match content filters"                        |
|                     | `ssrf_blocked`      | Private IP / DNS rebinding      | "URL resolves to a private address"                        |
| **Pipeline Errors** | `extraction_failed` | Docling service error           | "Extraction service may be unavailable"                    |
|                     | `embedding_failed`  | Embedding service error         | "Embedding service error — pages can be retried"           |
|                     | `indexing_failed`   | Vector store error              | "Indexing failed — check vector store availability"        |
|                     | `chunking_failed`   | Page processing error           | "Content could not be split into chunks"                   |

---

## 7. Technical Considerations

### Data Flow: Merging Two Sources

The `/pages/:jobId` endpoint must merge data from two sources:

```
Source: SearchDocument (for crawled pages) → response.data.pages[]
  → URL, document status, quality score, method, handler reused, chunks

Source: CrawlError collection (for failed/blocked pages) → response.data.crawlErrors[]
  → URL, error type, error message, status code, timestamp

Combined response = pages[] (paginated) + crawlErrors[] (paginated independently)
  → Structural separation: array membership is the discriminator (no origin field)
  → Both independently paginated: offset/limit on pages[], errorOffset/errorLimit on crawlErrors[]
  → Same query works for active crawls and completed crawls (unified read path)
```

### Worker Changes (Both Workers)

Both `bulk-crawl-worker` and `intelligence-crawl-worker` must:

1. Classify errors into the error taxonomy (parse HTTP status codes, connection errors)
2. Insert a `CrawlError` document per failure via `CrawlError.insertOne()` (fire-and-forget, independent write — no document-level contention)
3. Continue using existing time-based checkpoint for counter updates (`urls.failed`, `urls.crawled`, `urls.blocked`)
4. Compute `results.qualityMetrics` at job completion (aggregate from ingested documents)

### Existing Schema Leverage

The `CrawlJob` model already defines these fields that are **never populated**:

| Field                    | Schema Line | Type                                                                      | Action                                                                        |
| ------------------------ | ----------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `urls.errors[]`          | L28-33      | `Array<{url, error, timestamp}>`                                          | NOT used — replaced by dedicated `CrawlError` collection for write throughput |
| `results.qualityMetrics` | L79-84      | `{avgQualityScore, avgContentPreservation, avgChunksPerDoc, successRate}` | Compute at completion                                                         |

The `SearchDocument.sourceMetadata` already contains these fields that the API **doesn't return**:

| Field           | Stored By                                  | Action                  | Notes                                                                                          |
| --------------- | ------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `qualityScore`  | bulk-crawl-worker via metadata passthrough | Include in API response | **Bulk only** — intelligence-crawl-worker omits this from ingestion metadata. T-3 must add it. |
| `quality`       | bulk-crawl-worker via metadata passthrough | Include in API response | **Bulk only** — intelligence-crawl-worker omits this. T-3 must add it.                         |
| `handlerReused` | both workers via metadata passthrough      | Include in API response | Stored by both workers.                                                                        |
| `crawledAt`     | both workers via metadata passthrough      | Already returned        | —                                                                                              |

The `method` field (http vs playwright) is **not persisted** — it is only emitted via SSE events. To surface it, workers must add `method` to the ingestion metadata.

### Existing Frontend Components

An `ErrorGroupingPanel` already exists at `apps/studio/src/components/search-ai/source-page/ErrorGroupingPanel.tsx` with a frontend `categorizeError()` function and `ErrorCategory` type (`access_denied`, `not_found`, `timeout`, `rate_limited`, `server_error`, `ssl_error`, `dns_error`, `other`). This spec moves error classification to the backend (T-1) — the frontend `categorizeError()` must be removed in T-9 and replaced with consumption of the backend-provided `type` field.

A `QualityMetricsService` exists at `apps/search-ai/src/services/quality-metrics/index.ts` with per-page extraction quality analysis. The `results.qualityMetrics` in this spec aggregates per-document `sourceMetadata` fields at job completion — a different granularity. The existing service MAY be reused for the `avgContentPreservation` computation.

### API Hygiene (Pre-existing Issues to Fix)

The existing `/pages/:jobId` endpoint has pre-existing issues that should be fixed as part of this work:

1. **Error envelope**: Returns `{ success: false, error: '...', message: '...' }` instead of the project standard `{ success, error: { code, message } }`. Must normalize.
2. **Auth typing**: Uses `(req as any).tenantContext` instead of typed `req.tenantContext`. Must normalize.
3. **500 error leakage**: Returns raw `error.message` in 500 responses, which can leak internal hostnames/stack traces. Must sanitize to generic message, log details server-side only.
4. **No project scope filter**: Neither `/pages/:jobId` nor `/dashboard/:jobId` call `applyProjectScopeFilter`. This is a pre-existing gap (GAP-001) — document but don't block this spec on it.

### AMigration

No schema migration required:

- `CrawlError` collection is auto-created on first `insertOne` (Mongoose default)
- Compound index `{tenantId, crawlJobId, timestamp}` and TTL index defined in model schema
- `CrawlJob.urls.errors[]` schema remains in model but is NOT populated — no migration needed
- `results.qualityMetrics` schema exists — just needs computation
- `DashboardResponse` extensions are API-level only

---

## 8. How to Consume

### Studio UI

Users interact with this feature through the Unified Source Page at `/projects/:projectId/search-ai/:kbId/sources/:sourceId`.

**Entry points:**

- Click a web source row in the KB detail page → navigates to USP
- Direct URL navigation / browser back / hard reload
- Toast notification "[View Results]" after background crawl completion

**Key interactions:**

- Status strip shows crawl metrics row + pipeline metrics row
- Pages tab shows all URLs (success + fail + blocked) with two-state status columns
- Filter bar: `All | Fetched | Failed | Blocked` + search by URL
- Error grouping panel appears below filter bar when errors exist
- Click "View URLs" in error group → filters table to that error type
- Pipeline detail → "View in Documents tab" link navigates to KB detail Data tab

### Surface Semantics Matrix

N/A — this feature does not import or mount assets across boundaries.

### Design-Time vs Runtime Behavior

N/A — this is a read-only results view with no design-time / runtime split.

### API (Runtime)

N/A — no runtime API changes.

### API (Studio)

| Method | Path                          | Purpose                                        | Changes                                                               |
| ------ | ----------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| GET    | `/api/crawl/pages/:jobId`     | Retrieve crawled pages + failed URLs for a job | Add `crawlErrors[]`, `quality`, `method`, `handlerReused` to response |
| GET    | `/api/crawl/dashboard/:jobId` | Real-time crawl progress                       | Add `crawl.errorBreakdown`, `ingestion.qualityDistribution`           |

**Extended `/pages/:jobId` Response:**

```typescript
// Wrapped in standard envelope: { success: true, data: CrawledPagesResponse }
interface CrawledPagesResponse {
  pages: CrawledPage[]; // Existing — from SearchDocuments (paginated)
  crawlErrors: CrawlErrorEntry[]; // NEW — from CrawlError collection (paginated independently)
  totalFailed: number; // NEW — from CrawlJob.urls.failed (authoritative count)
  totalBlocked: number; // NEW — from CrawlJob.urls.blocked
  totalErrors: number; // NEW — from CrawlError.countDocuments
  pagination: { total: number; offset: number; limit: number; hasMore: boolean };
  errorPagination: { total: number; offset: number; limit: number; hasMore: boolean };
}

interface CrawledPage {
  url: string;
  status: string; // Document pipeline status
  documentId: string;
  chunks: number;
  crawledAt: string;
  error?: string; // Pipeline error message (if status=error)
  quality?: 'rich' | 'standard' | 'thin'; // NEW — from sourceMetadata
  qualityScore?: number; // NEW — from sourceMetadata (0.0-1.0)
  handlerReused?: boolean; // NEW — from sourceMetadata
  method?: 'http' | 'playwright'; // NEW — from sourceMetadata
}

interface CrawlErrorEntry {
  url: string;
  type: CrawlErrorType; // Classified error category
  error: string; // Human-readable, sanitized error message
  statusCode?: number; // HTTP status code if available
  timestamp: string;
}

type CrawlErrorType =
  | 'http_4xx'
  | 'http_5xx'
  | 'connection_error'
  | 'timeout'
  | 'robots_blocked'
  | 'quality_gated'
  | 'content_filtered'
  | 'ssrf_blocked'
  | 'crawl_error';
```

**Extended `DashboardResponse`** (showing all existing + new fields):

```typescript
interface DashboardResponse {
  jobId: string;
  phase: string;
  crawl: {
    urlsCrawled: number; // existing
    urlsFailed: number; // existing
    urlsQueued: number; // existing
    totalUrls: number; // existing
    progress: number; // existing
    batchId?: string; // existing
    errorBreakdown?: Array<{ type: CrawlErrorType; count: number }>; // NEW
  };
  ingestion: {
    documentsCreated: number; // existing
    documentsFailed: number; // existing
    documentsIndexed: number; // existing
    progress: number; // existing
    avgQualityScore?: number; // existing
    statusBreakdown?: Record<string, number>; // existing
    qualityDistribution?: { rich: number; standard: number; thin: number }; // NEW
  };
  extraction: { chunksCreated: number; progress: number }; // existing
  embedding: { progress: number }; // existing
  indexing: { progress: number }; // existing
  timeline: { submittedAt: string; startedAt?: string; completedAt?: string }; // existing
}
```

### Admin Portal

N/A — no admin portal changes.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — this feature is not channel-aware.

---

## 9. Data Model

### Collections / Tables

#### NEW: `crawl_errors` (CrawlError)

```text
New collection — one document per failed/blocked URL:
  - _id: string (uuidv7)
  - tenantId: string
  - crawlJobId: string
  - url: string
  - type: CrawlErrorType
  - error: string (sanitized)
  - statusCode?: number (HTTP status code if available)
  - timestamp: Date
  - createdAt: Date (for TTL index)

Indexes:
  - { tenantId: 1, crawlJobId: 1, timestamp: -1 }  — compound for tenant-scoped queries
  - { createdAt: 1 } with expireAfterSeconds: 90 days  — TTL cleanup matching CrawlJob
```

#### Modified: `crawl_jobs` (CrawlJob)

```text
Modified fields:
  - results.qualityMetrics: {         // EXISTING schema, now COMPUTED
      avgQualityScore: number,
      avgContentPreservation: number,
      avgChunksPerDoc: number,
      successRate: number
    }

Note: urls.errors[] schema remains in model but is NOT populated.
All error persistence goes to the CrawlError collection for write throughput at scale.
```

#### Read-only: `search_documents` (SearchDocument)

```text
Existing fields surfaced to API:
  - sourceMetadata.qualityScore: number    // Already stored, now returned by /pages
  - sourceMetadata.quality: string         // Already stored, now returned by /pages
  - sourceMetadata.handlerReused: boolean  // Already stored, now returned by /pages
  - sourceMetadata.crawledAt: string       // Already returned

New field stored by workers:
  - sourceMetadata.method: 'http' | 'playwright'  // NEW — crawl method used
```

### Key Relationships

```
CrawlError (N) ──crawlJobId──> CrawlJob (1) [failed/blocked URL records]
CrawlJob (1) ──sourceMetadata.crawlJobId──> SearchDocument (N) [success pages]
CrawlJob ──sourceId──> SearchSource
CrawlJob ──indexId──> SearchIndex
SearchDocument ──sourceId──> SearchSource
CrawlJob.urls.failed ──(authoritative count, ≥ CrawlError.countDocuments for job)
```

The `/pages/:jobId` API merges CrawlError documents with SearchDocuments by crawlJobId to produce a unified view. The same query works for both active and completed crawls.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                           | Purpose                                                              |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/database/src/models/crawl-error.model.ts`            | NEW — CrawlError model with compound + TTL indexes                   |
| `packages/database/src/models/crawl-job.model.ts`              | CrawlJob model — no schema changes (urls.errors[] left as-is)        |
| `packages/crawler/src/intelligence/algorithms/http-adapter.ts` | HTTP fetch — source of status codes and error types                  |
| `apps/search-ai/src/services/quality-metrics/index.ts`         | Existing QualityMetricsService — may reuse for aggregate computation |

### Routes / Handlers

| File                                 | Purpose                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/routes/crawl.ts` | `/pages/:jobId` endpoint — merge errors, return quality/method; `/dashboard/:jobId` — add errorBreakdown, qualityDistribution |

### Workers

| File                                                      | Purpose                                                                            |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/search-ai/src/workers/bulk-crawl-worker.ts`         | CrawlError.insertOne per failure, store method in metadata, compute qualityMetrics |
| `apps/search-ai/src/workers/intelligence-crawl-worker.ts` | Same changes for intelligence crawl path                                           |

### UI Components

| File                                                                      | Purpose                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `apps/studio/src/components/search-ai/source-page/USPStatusStrip.tsx`     | Redesign to show crawl metrics row + pipeline metrics row    |
| `apps/studio/src/components/search-ai/CrawledPagesView.tsx`               | Add crawl error entries, two-state columns, filter by status |
| `apps/studio/src/components/search-ai/source-page/ErrorGroupingPanel.tsx` | Redesign error grouping — crawl vs pipeline sections         |
| `apps/studio/src/api/crawl.ts`                                            | Update CrawledPage, DashboardResponse types                  |

### i18n

| File                                   | Purpose                                             |
| -------------------------------------- | --------------------------------------------------- |
| `packages/i18n/locales/en/studio.json` | Error type labels, remediation hints, status labels |

### Tests

| File                                                                    | Type        | Coverage Focus                        |
| ----------------------------------------------------------------------- | ----------- | ------------------------------------- |
| `apps/search-ai/src/routes/__tests__/crawl-pages.test.ts`               | integration | /pages endpoint with merged errors    |
| `apps/search-ai/src/routes/__tests__/crawl-dashboard.test.ts`           | integration | Dashboard with errorBreakdown/quality |
| `apps/search-ai/src/workers/__tests__/bulk-crawl-error-persist.test.ts` | unit        | Error classification and persistence  |
| TBD                                                                     | e2e         | Full crawl → USP error display flow   |

---

## 11. Configuration

### Environment Variables

No new environment variables. The error type taxonomy is a hardcoded constant. The default pagination limits (`errorLimit=100`, `limit=50`) are query parameter defaults — no per-deployment configuration needed.

### Runtime Configuration

No new runtime configuration. Error remediation text is static i18n, not configurable per-tenant.

### DSL / Agent IR / Schema

N/A — this feature does not affect DSL or agent configuration.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | The `/pages/:jobId` endpoint already verifies `CrawlJob.tenantId === req.tenantId` (crawl.ts:2994). Error entries inherit the job's tenant scope. No new isolation code needed. |
| Project isolation | CrawlJob lacks `projectId` (USP HLD assumption A-8 logs this as a pre-existing gap). No regression — same isolation level as before.                                            |
| User isolation    | Crawl jobs are shared within a tenant (any tenant user can view). No user-level filtering. This matches current behavior.                                                       |

### Security & Compliance

- Error messages in `CrawlError` documents may contain internal hostnames (e.g., "localhost:8080"). Messages are sanitized before persistence — strip internal hostnames, ports, stack traces.
- Normalize all 500 error responses in `/pages/:jobId` and `/dashboard/:jobId` to return generic messages via the structured envelope `{ success: false, error: { code, message } }`. Internal details (stack traces, hostnames) must be logged server-side only, never returned to the client.
- No PII in crawl error records — URLs are public web addresses, error messages are HTTP-level.
- No new auth surface — reuses existing `requireAuth` on crawl routes.

### Performance & Scalability

- `CrawlError.insertOne()` per failure — independent document write, no contention. ~10K+ inserts/sec on MongoDB.
- At `WINDOW_SIZE=5` with 50K URLs, peak write rate ~50 inserts/sec — trivial for MongoDB.
- The `/pages/:jobId` endpoint adds one parallel `CrawlError.find()` query (indexed on `{tenantId, crawlJobId, timestamp}`) — adds ~2-5ms.
- Error pagination (`errorLimit=100`) keeps response payload bounded (~50KB for errors + ~25KB for pages = ~75KB total).
- `DashboardResponse` error breakdown via `CrawlError.aggregate` — ~5-10ms on compound index, bounded by 9 error types.
- `results.qualityMetrics` computation at job completion requires an aggregation query on SearchDocuments by `crawlJobId`. For 10,000-page crawls, this is a single indexed aggregation.
- Storage: ~500 bytes/error × 15K errors = ~7.5MB per large crawl. TTL index auto-cleans after 90 days.

### Reliability & Failure Modes

- If `CrawlError.insertOne()` fails, the worker must catch the error, log it, and continue crawling. Error persistence must never block the crawl pipeline.
- The `CrawlJob.urls.failed` counter remains the authoritative failure count. `CrawlError` documents are best-effort detail.
- If the CrawlError collection is unavailable, `/pages` falls back to returning empty `crawlErrors[]` with `totalFailed` from CrawlJob counter.
- If qualityMetrics computation fails at job completion, the job still completes successfully. Metrics are informational.

### Observability

- Workers log error classification decisions: `log.debug('Classified crawl error', { url, type, errorMessage })`.
- The change manifest tracks which error types were seen per job.
- Existing crawl progress SSE events remain unchanged — error classification happens at persist time.

### Data Lifecycle

- `CrawlError` documents are stored in a dedicated collection with a 90-day TTL index (matching CrawlJob TTL).
- CrawlJob retention follows existing policy. `CrawlJob.urls.errors[]` schema remains but is NOT populated by this feature.
- TTL cleanup is automatic — no manual purge needed.

---

## 13. Delivery Plan / Work Breakdown

### Wave 1: Backend Data Persistence (independent)

1. **T-0: CrawlError Model + Indexes**
   0.1 Create `CrawlError` Mongoose model in `packages/database/src/models/crawl-error.model.ts`
   0.2 Define `ICrawlError` interface with `tenantId`, `crawlJobId`, `url`, `type`, `error`, `statusCode?`, `timestamp`, `createdAt`
   0.3 Add compound index `{tenantId, crawlJobId, timestamp}` and TTL index `{createdAt}` (90 days)
   0.4 Export from `packages/database` barrel
2. **T-1: Error Classification Utility**
   1.1 Create error classification function: parse HTTP status codes, connection errors, robots blocks, quality gates → CrawlErrorType
   1.2 Create error message sanitizer: strip internal hostnames, ports, stack traces
   1.3 Unit tests for error classification (all error types) and sanitization
3. **T-2: Bulk Crawl Worker — Error Persistence**
   2.1 In `processUrl` failure path: classify error, `CrawlError.insertOne()` (fire-and-forget)
   2.2 On robots.txt skip: insert with type `robots_blocked`
   2.3 Add `method` to ingestion metadata (currently only in SSE)
   2.4 Compute `results.qualityMetrics` at job completion (aggregate SearchDocuments by crawlJobId)
4. **T-3: Intelligence Crawl Worker — Error Persistence**
   3.1 In page failure path (`intelligence_page_failed` at L685, L853): classify error, `CrawlError.insertOne()` (fire-and-forget)
   3.2 On quality gate block (`intelligence_page_blocked` at L570): insert with type `quality_gated`
   3.3 Add `method` to ingestion metadata (currently only in SSE `intelligence_page_complete` events)
   3.4 Add `qualityScore` and `quality` to ingestion metadata (currently only in bulk worker — intelligence worker at L723-728 omits these)
   3.5 Compute `results.qualityMetrics` at job completion

### Wave 2: Backend API Extensions (depends on Wave 1)

1. **T-4: Extend /pages/:jobId Endpoint**
   4.1 Query `CrawlError.find({tenantId, crawlJobId})` alongside existing SearchDocument pages
   4.2 Return `quality`, `handlerReused`, `method` from `sourceMetadata` for each page
   4.3 Return `totalFailed`, `totalBlocked`, `totalErrors`, `errorPagination` metadata
   4.4 Normalize error responses to project standard envelope `{ success, error: { code, message } }`
   4.5 Fix auth typing: replace `(req as any).tenantContext` with typed `req.tenantContext`
   4.6 Sanitize 500 error responses — log details server-side, return generic message to client
   4.7 Integration tests for merged response
2. **T-5: Extend /dashboard/:jobId Endpoint**
   5.1 Add `crawl.errorBreakdown` — aggregate from `CrawlError.aggregate([{$match}, {$group}])`
   5.2 Add `ingestion.qualityDistribution` — aggregate from ingested documents
   5.3 Integration tests for new fields

### Wave 3: Frontend Redesign (depends on Wave 2)

1. **T-6: Update API Types + i18n**
   6.1 Update `CrawledPage`, `CrawledPagesResponse`, `DashboardResponse` types in `api/crawl.ts`
   6.2 Add `CrawlErrorEntry`, `CrawlErrorType` types
   6.3 Add i18n keys under `search_ai.crawled_pages.error_types.`_ and `search_ai.crawled_pages.remediation._` namespaces
2. **T-7: Redesign USPStatusStrip**
   7.1 Split metrics into crawl row (attempted/fetched/failed/blocked) and pipeline row (indexed/errors)
   7.2 Update live dashboard data binding for new fields
   7.3 Update terminal state data binding for new fields
3. **T-8: Redesign CrawledPagesView**
   8.1 Render `crawlErrors[]` in a separate section from `pages[]` (structural separation — no origin field)
   8.2 Add two-state status columns (Crawled / Indexed)
   8.3 Add filter bar: All / Fetched / Failed / Blocked
   8.4 Show failed/blocked URLs with error type badge and error message
4. **T-9: Redesign ErrorGroupingPanel**
   9.1 Remove existing frontend `categorizeError()` function and `ErrorCategory` type — replaced by backend-provided `type` field
   9.2 Separate crawl errors from processing errors using `CrawlErrorEntry` (crawl) vs `SearchDocument.processingError` (pipeline)
   9.3 Group by error type with count and expandable URL list
   9.4 Add remediation hint text per error type (from i18n `search_ai.crawled_pages.remediation.`\*)
   9.5 "View URLs" action filters the Pages table to that error type

---

## 14. Success Metrics

| Metric                             | Baseline                | Target                 | How Measured                                                            |
| ---------------------------------- | ----------------------- | ---------------------- | ----------------------------------------------------------------------- |
| Failed URL details persisted       | 0% (only counts)        | 100% (all errors)      | Query: CrawlError.countDocuments({crawlJobId}) > 0 when urls.failed > 0 |
| Error type classification coverage | 0 types                 | 9 types                | Code review: all error paths classified                                 |
| USP status strip accuracy          | Misleading (Pages=Docs) | Correct separation     | Manual verification: crawl vs pipeline metrics                          |
| Per-URL quality visibility         | Not shown               | Shown for all pages    | API response includes quality field                                     |
| User error investigation time      | Unknown (no data)       | < 30s to identify type | User testing: find error cause for a failed crawl                       |

---

## 15. Open Questions

1. **Error message sanitization**: How aggressively should we strip internal infrastructure details (hostnames, ports, stack traces) from error messages in `CrawlError` documents? Currently, raw error strings from Axios/HTTP adapters include internal addresses like `localhost:8080`.
2. **Error pagination defaults**: Default `errorLimit=100` chosen to keep initial payload small. May need tuning based on real-world usage patterns — monitor frontend's error tab scroll behavior.
3. **Quality metrics computation timing**: Computing `results.qualityMetrics` at job completion requires an aggregation query. For very large crawls (50K+ documents), should this be a separate background job instead of inline at completion?
4. **Method persistence for bulk worker**: The bulk crawl worker uses `browser` and `http` methods but only stores the ratio in `results.metering`. Adding `method` to ingestion metadata is new per-URL data. Is there a performance concern with larger `sourceMetadata` documents?
5. **SSRF protection verification**: The error taxonomy includes `ssrf_blocked`. SSRF protection exists in `http-adapter.ts` (private IP/DNS rebinding checks). Verify during implementation that these errors are properly caught and classified — if the SSRF guard throws before the worker's error handler, the error may not flow through the standard classification path.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                   | Severity | Status                  |
| ------- | --------------------------------------------------------------------------------------------- | -------- | ----------------------- |
| GAP-001 | CrawlJob has no `projectId` field — project-level isolation gap (pre-existing, logged in HLD) | Medium   | Open                    |
| GAP-002 | ~~`urls.errors[]` capped at 1,000~~ — RESOLVED by CrawlError collection (no cap, paginated)   | Low      | Resolved                |
| GAP-003 | Re-crawl comparison data (`CrawlJob.comparison`) not surfaced in UI — deferred to P1          | Medium   | Open                    |
| GAP-004 | Bulk retry-by-error-group not implemented — only per-document retry exists                    | Medium   | Open                    |
| GAP-005 | `method` field not persisted by bulk-crawl-worker currently — must be added                   | High     | In Progress (this spec) |
| GAP-006 | Intelligence crawl `results.metering` (fastCount/aiCount) not written to CrawlJob             | Low      | Open                    |

---

## 17. Testing & Validation

**Full Test Spec**: `[docs/testing/sub-features/usp-crawl-pages-tab.md](../../testing/sub-features/usp-crawl-pages-tab.md)` — 8 E2E scenarios, 10 integration scenarios, 7 unit scenarios, 2 performance scenarios.

### Required Test Coverage

| #   | Scenario                                                     | Coverage Type | Status     | Test File / Note |
| --- | ------------------------------------------------------------ | ------------- | ---------- | ---------------- |
| 1   | Error classification maps HTTP 404 → `http_4xx`              | unit          | NOT TESTED | T-1 tests        |
| 2   | Error classification maps ECONNREFUSED → `connection_error`  | unit          | NOT TESTED | T-1 tests        |
| 3   | Bulk worker inserts errors to CrawlError collection          | integration   | NOT TESTED | T-2 tests        |
| 4   | CrawlError pagination with errorLimit/errorOffset            | integration   | NOT TESTED | T-4 tests        |
| 5   | /pages/:jobId returns merged pages + crawlErrors             | integration   | NOT TESTED | T-4 tests        |
| 6   | /pages/:jobId returns quality, method, handlerReused         | integration   | NOT TESTED | T-4 tests        |
| 7   | /dashboard/:jobId returns errorBreakdown during active crawl | integration   | NOT TESTED | T-5 tests        |
| 8   | Status strip shows separate crawl vs pipeline metrics        | e2e           | NOT TESTED | T-7 tests        |
| 9   | Pages tab shows failed URLs from crawlErrors                 | e2e           | NOT TESTED | T-8 tests        |
| 10  | Error grouping separates crawl from pipeline errors          | e2e           | NOT TESTED | T-9 tests        |
| 11  | Filter bar filters by crawl status                           | e2e           | NOT TESTED | T-8 tests        |
| 12  | Cross-tenant request to /pages/:jobId returns 404            | integration   | NOT TESTED | Security test    |
| 13  | Error remediation text matches error type                    | unit          | NOT TESTED | i18n test        |
| 14  | qualityMetrics computed at job completion                    | integration   | NOT TESTED | T-2/T-3 tests    |

### Testing Notes

- Backend integration tests should use real CrawlJob + SearchDocument documents in MongoDB (no mocking).
- E2E tests should crawl a small test site (2-3 pages with one deliberate 404) and verify the USP displays the correct error grouping.
- Cross-tenant isolation test: create CrawlJob under tenant A, request /pages with tenant B credentials → expect 404.

> Full testing details: `../../testing/sub-features/usp-crawl-pages-tab.md`

---

## 18. References

- Parent feature: [Web Crawling](../web-crawling.md)
- UX Specification: `docs/specs/unified-source-page.ux-spec.md`
- HLD: `docs/specs/unified-source-page.hld.md`
- CrawlJob model: `packages/database/src/models/crawl-job.model.ts`
- Crawl workers: `apps/search-ai/src/workers/bulk-crawl-worker.ts`, `intelligence-crawl-worker.ts`
- Pages endpoint: `apps/search-ai/src/routes/crawl.ts` (line ~2970)
- Frontend components: `apps/studio/src/components/search-ai/CrawledPagesView.tsx`, `source-page/USPStatusStrip.tsx`
