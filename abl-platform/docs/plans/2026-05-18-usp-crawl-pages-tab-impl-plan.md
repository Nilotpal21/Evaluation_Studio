# LLD: USP Crawl-Centric Pages Tab

**Feature Spec**: `docs/features/sub-features/usp-crawl-pages-tab.md`
**HLD**: `docs/specs/usp-crawl-pages-tab.hld.md`
**Test Spec**: `docs/testing/sub-features/usp-crawl-pages-tab.md`
**Status**: DRAFT
**Date**: 2026-05-18

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                   | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                             | Alternatives Rejected                                                                                                   |
| ---- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| D-1  | CrawlError model uses same pattern as CrawlJob             | `tenantIsolationPlugin` + `uuidv7` + Mongoose Schema — matches existing database patterns                                                                                                                                                                                                                                                                                                                                                             | Custom lightweight collection without plugin                                                                            |
| D-2  | Best-effort non-blocking with `await` + `try/catch`        | Matches worker error handling convention (intelligence-crawl-worker L714-719). `await` provides write acknowledgement (w:majority durability) while `try/catch` prevents CrawlError persistence failures from blocking the crawl pipeline. This is intentionally NOT fire-and-forget (`w:0`) — we want durable writes. For WINDOW_SIZE=5, the per-insert `await` adds ~1-2ms network round-trip per failure, acceptable for the batch sizes involved. | `.catch()` chain (no stack trace), `w:0` fire-and-forget (data loss risk), `insertMany` batch (adds complexity per D-7) |
| D-3  | Add CrawlError to `getModels()` for /pages endpoint        | Co-locates model access; /pages already uses `getModels()` (L2993)                                                                                                                                                                                                                                                                                                                                                                                    | getLazyModel in /pages handler                                                                                          |
| D-4  | Use `getLazyModel('CrawlError')` in workers/dashboard      | Workers don't have access to `getModels()` (it's route-local). Dashboard already uses `getLazyModel` for CrawlJob (L2405). Both `getModel` and `getLazyModel` resolve from the same ModelRegistry — the choice is call-site convenience, not functional.                                                                                                                                                                                              | Import from getModels (not available in workers)                                                                        |
| D-5  | Add `statusCode?: number` to ProcessUrlResult              | HttpFetchResult.statusCode exists (L38); one-line propagation at bulk-worker L272                                                                                                                                                                                                                                                                                                                                                                     | Parse statusCode from error string (fragile)                                                                            |
| D-6  | Frontend API function unwraps `{ success, data }` envelope | Standard Studio API pattern — single adaptation point                                                                                                                                                                                                                                                                                                                                                                                                 | Components handle envelope themselves                                                                                   |
| D-7  | Individual `insertOne` per error (no batching)             | WINDOW_SIZE=5 means ≤5 concurrent inserts — trivial for MongoDB; batching adds complexity                                                                                                                                                                                                                                                                                                                                                             | insertMany after allSettled loop                                                                                        |
| D-8  | Remove old client-side `categorizeError()` entirely        | Dead code after backend provides `type`; contradicts feature goal of separating crawl vs pipeline errors                                                                                                                                                                                                                                                                                                                                              | Keep as fallback for old jobs                                                                                           |
| D-9  | Sequential per-task execution (hybrid workflow)            | User preference: mini-LLD→implement→review→commit per task, no parallel forks                                                                                                                                                                                                                                                                                                                                                                         | Parallel implementation of independent tasks                                                                            |
| D-10 | Error classifier placed in `packages/crawler`              | Near error source; both workers already `import` from `@abl/crawler`; matches FailureScorer location precedent (pure functions, not class)                                                                                                                                                                                                                                                                                                            | packages/database (wrong domain), apps/search-ai (not shared)                                                           |

### Key Interfaces & Types

```typescript
// packages/database/src/models/crawl-error.model.ts
export interface ICrawlError {
  _id: string;
  tenantId: string;
  crawlJobId: string;
  url: string;
  type: CrawlErrorType;
  error: string; // Sanitized error message
  statusCode?: number;
  timestamp: Date;
  createdAt: Date; // TTL index
}

// packages/crawler/src/types/crawl-error.ts
export type CrawlErrorType =
  | 'http_4xx'
  | 'http_5xx'
  | 'connection_error'
  | 'timeout'
  | 'robots_blocked'
  | 'quality_gated'
  | 'content_filtered'
  | 'ssrf_blocked'
  | 'crawl_error';

// packages/crawler/src/errors/crawl-error-classifier.ts
export function classifyCrawlError(errorString: string, statusCode?: number): CrawlErrorType;
export function sanitizeErrorMessage(errorString: string): string;
export function getRemediationKey(type: CrawlErrorType): string;

// apps/search-ai/src/workers/bulk-crawl-worker.ts — modified interface
interface ProcessUrlResult {
  success: boolean;
  skipped: boolean;
  isDuplicate?: boolean;
  quality?: 'rich' | 'standard' | 'thin';
  qualityScore?: number;
  handlerReused?: boolean;
  documentId?: string;
  error?: string;
  statusCode?: number; // NEW — from HttpFetchResult.statusCode
}

// apps/studio/src/api/crawl.ts — updated types
export interface CrawledPage {
  url: string;
  status: string;
  documentId: string;
  chunks: number;
  crawledAt: string;
  error?: string;
  handlerReused?: boolean;
  quality?: 'rich' | 'standard' | 'thin';
  qualityScore?: number;
  method?: 'http' | 'playwright';
  blockReason?: string;
}

export interface CrawlErrorEntry {
  url: string;
  type: CrawlErrorType;
  error: string;
  statusCode?: number;
  timestamp: string;
}

export interface CrawledPagesResponse {
  pages: CrawledPage[];
  crawlErrors: CrawlErrorEntry[];
  totalFailed: number;
  totalBlocked: number;
  totalErrors: number;
  pagination: { total: number; offset: number; limit: number; hasMore: boolean };
  errorPagination: { total: number; offset: number; limit: number; hasMore: boolean };
}
```

### Module Boundaries

| Module                     | Responsibility                                                                | Depends On                             |
| -------------------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| `packages/database`        | CrawlError Mongoose model, schema, indexes, export                            | mongoose, base-document, tenant plugin |
| `packages/crawler`         | Error classifier, sanitizer, CrawlErrorType enum                              | None (pure functions)                  |
| `apps/search-ai` (workers) | Persist CrawlError on URL failure, compute qualityMetrics                     | packages/database, packages/crawler    |
| `apps/search-ai` (routes)  | Merge CrawlError + SearchDocument in /pages, add errorBreakdown to /dashboard | packages/database                      |
| `apps/studio` (API types)  | Frontend types for CrawledPagesResponse + CrawlErrorEntry                     | None                                   |
| `apps/studio` (components) | USPStatusStrip, CrawledPagesView, ErrorGroupingPanel redesign                 | apps/studio API types, i18n            |
| `packages/i18n`            | Error type labels, remediation text keys                                      | None                                   |

---

## 2. File-Level Change Map

### New Files

| File                                                    | Purpose                                                     | LOC Estimate |
| ------------------------------------------------------- | ----------------------------------------------------------- | ------------ |
| `packages/database/src/models/crawl-error.model.ts`     | CrawlError Mongoose model + ICrawlError interface           | 60-80        |
| `packages/crawler/src/errors/crawl-error-classifier.ts` | classifyCrawlError, sanitizeErrorMessage, getRemediationKey | 80-100       |
| `packages/crawler/src/errors/index.ts`                  | Barrel re-export for errors module                          | 5            |
| `packages/crawler/src/types/crawl-error.ts`             | CrawlErrorType enum export                                  | 15           |

### Modified Files

| File                                                                      | Change Description                                                                       | Risk |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---- |
| `packages/database/src/models/index.ts`                                   | Add `export { CrawlError, type ICrawlError }` line                                       | Low  |
| `apps/search-ai/src/db/index.ts`                                          | Register CrawlError in ModelRegistry (searchaicontent DB)                                | Low  |
| `packages/crawler/src/index.ts`                                           | Add `export * from './errors/index.js'` to root barrel                                   | Low  |
| `packages/crawler/src/types/index.ts`                                     | Add CrawlErrorType export to types barrel                                                | Low  |
| `apps/search-ai/src/routes/progress.ts` (L53-118)                         | Add `errorType?: string` to ProgressEvent.data interface                                 | Low  |
| `apps/search-ai/src/routes/crawl.ts` (getModels, L72-81)                  | Add `CrawlError: getModel('CrawlError')` to getModels()                                  | Low  |
| `apps/search-ai/src/routes/crawl.ts` (/pages, L2970-3080)                 | Add CrawlError query, merge response, add errorPagination, wrap in envelope              | High |
| `apps/search-ai/src/routes/crawl.ts` (/dashboard, L2382-2726)             | Add errorBreakdown + qualityDistribution aggregations                                    | Med  |
| `apps/search-ai/src/workers/bulk-crawl-worker.ts` (L196-206)              | Add `statusCode?: number` to ProcessUrlResult                                            | Low  |
| `apps/search-ai/src/workers/bulk-crawl-worker.ts` (L268-273)              | Propagate `fetchResult.statusCode` in failure return                                     | Low  |
| `apps/search-ai/src/workers/bulk-crawl-worker.ts` (L560-677)              | Add CrawlError.insertOne in failure paths (L562-566, L635-663), add method to SSE events | Med  |
| `apps/search-ai/src/workers/bulk-crawl-worker.ts` (L680-700)              | Compute qualityMetrics at job completion                                                 | Med  |
| `apps/search-ai/src/workers/intelligence-crawl-worker.ts` (L670-698)      | Add CrawlError.insertOne in budget-exhausted path                                        | Med  |
| `apps/search-ai/src/workers/intelligence-crawl-worker.ts` (L722-740)      | Add quality, qualityScore, method to ingestion metadata                                  | Low  |
| `apps/search-ai/src/workers/intelligence-crawl-worker.ts` (L848-862)      | Add CrawlError.insertOne in catch block                                                  | Med  |
| `apps/search-ai/src/workers/intelligence-crawl-worker.ts` (L865-877)      | Compute qualityMetrics at job completion                                                 | Med  |
| `apps/studio/src/api/crawl.ts` (L201-224)                                 | Update CrawledPage, add CrawlErrorEntry, rewrite CrawledPagesResponse                    | Med  |
| `apps/studio/src/api/crawl.ts` (getCrawledPages function)                 | Update to handle new response envelope and query params                                  | Med  |
| `apps/studio/src/components/search-ai/source-page/USPStatusStrip.tsx`     | Redesign for two-row crawl + pipeline metrics                                            | High |
| `apps/studio/src/components/search-ai/CrawledPagesView.tsx`               | Add crawlErrors display, two-state model, filter bar, error pagination                   | High |
| `apps/studio/src/components/search-ai/source-page/ErrorGroupingPanel.tsx` | Rewrite: separate crawl vs pipeline errors, backend type grouping, remediation           | High |

### Deleted Files

None.

---

## 3. Implementation Phases

CRITICAL: Each phase is independently deployable and testable. Sequential execution: T-0 → T-1 → T-2 → T-3 → T-4 → T-5 → T-6 → T-7 → T-8 → T-9.

---

### Phase 1: T-0 — CrawlError Model + Indexes

**Goal**: Create the CrawlError Mongoose model with compound index and TTL index.

**Tasks**:
1.0.1. Create `packages/database/src/models/crawl-error.model.ts`:

- Define `ICrawlError` interface (tenantId, crawlJobId, url, type, error, statusCode?, timestamp, createdAt)
- Create Mongoose schema with `tenantIsolationPlugin` and `uuidv7` for `_id`
- Add compound index: `{ tenantId: 1, crawlJobId: 1, timestamp: -1 }`
- Add TTL index: `{ createdAt: 1 }, { expireAfterSeconds: 7776000 }` (90 days)
- Collection name: `crawl_errors`
- Export `CrawlError` model and `ICrawlError` interface

  1.0.2. Add export to `packages/database/src/models/index.ts`:

- Add `export { CrawlError, type ICrawlError } from './crawl-error.model.js';` near L712 (after CrawlJob exports)

  1.0.3. Register CrawlError in SearchAI ModelRegistry (`apps/search-ai/src/db/index.ts`):

- Follow the CrawlJob registration pattern exactly at L165-168 (3-arg call: name, schema, dbName):

```typescript
import('@agent-platform/database/models').then((mod) => {
  if (mod.CrawlError?.schema && !ModelRegistry.hasModel('CrawlError')) {
    ModelRegistry.registerModelDefinition('CrawlError', mod.CrawlError.schema, 'searchaicontent');
  }
}),
```

- Place this immediately after the CrawlJob registration block (L165-168)
- The collection name `crawl_errors` must be set in the schema definition itself (step 1.0.1), not in the registration call — the 3-arg form does not accept options
- **CRITICAL**: Without this registration, `getLazyModel('CrawlError')` and `getModel('CrawlError')` will throw "Model not found in registry" at runtime

  1.0.4. Run `pnpm build --filter=@agent-platform/database && pnpm build --filter=search-ai` to verify types compile

**Files Touched**:

- `packages/database/src/models/crawl-error.model.ts` — CREATE
- `packages/database/src/models/index.ts` — ADD export line
- `apps/search-ai/src/db/index.ts` — ADD ModelRegistry registration

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/database` succeeds with 0 errors
- [ ] `pnpm build --filter=search-ai` succeeds with 0 errors
- [ ] `ICrawlError` interface is importable from `@agent-platform/database/models`
- [ ] Schema defines both indexes (compound + TTL)
- [ ] `tenantIsolationPlugin` is applied to the schema
- [ ] Collection name is `crawl_errors`
- [ ] `getLazyModel('CrawlError')` resolves without error in SearchAI context

**Test Strategy**:

- No tests needed at this phase — model is tested implicitly in Phase 4 (T-2 integration) and Phase 6 (T-4 integration)

**Rollback**: Delete `crawl-error.model.ts`, remove export line from `index.ts`

---

### Phase 2: T-1 — Error Classifier + Sanitizer

**Goal**: Create pure-function error classifier and message sanitizer in `packages/crawler`.

**Tasks**:
1.1.1. Create `packages/crawler/src/types/crawl-error.ts`:

- Export `CrawlErrorType` union type (9 values)

  1.1.2. Create `packages/crawler/src/errors/crawl-error-classifier.ts`:

- `classifyCrawlError(errorString: string, statusCode?: number): CrawlErrorType`
  - If `statusCode` 400-499 → `http_4xx`
  - If `statusCode` 500-599 → `http_5xx`
  - If error contains 'timeout' / 'timed out' / 'ETIMEDOUT' → `timeout`
  - If error contains 'ECONNREFUSED' / 'ECONNRESET' / 'ENOTFOUND' / 'socket hang up' → `connection_error`
  - If error contains 'robots' / 'disallowed' → `robots_blocked`
  - If error contains 'quality' / 'thin' / 'below threshold' → `quality_gated`
  - If error contains 'content type' / 'not html' / 'binary' / 'filtered' → `content_filtered`
  - If error contains 'ssrf' / 'private' / 'loopback' / 'blocked ip' → `ssrf_blocked`
  - Default → `crawl_error`
- `sanitizeErrorMessage(errorString: string): string`
  - Replace `127.0.0.1`, `localhost`, `0.0.0.0` with `[internal]`
  - Strip port numbers from connection errors (`:3005`, `:8080`, etc.)
  - Strip stack traces (everything after first `\n    at `)
  - Truncate to 500 chars
- `getRemediationKey(type: CrawlErrorType): string`
  - Maps type → i18n key prefix (e.g., `'search_ai.crawled_pages.remediation.http_4xx'`)

    1.1.3. Create `packages/crawler/src/errors/index.ts` barrel:

```typescript
export {
  classifyCrawlError,
  sanitizeErrorMessage,
  getRemediationKey,
} from './crawl-error-classifier.js';
```

1.1.4. Add CrawlErrorType to `packages/crawler/src/types/index.ts` barrel:

```typescript
export type { CrawlErrorType } from './crawl-error.js';
```

1.1.5. Export from `packages/crawler/src/index.ts` root barrel:

- Add `export * from './errors/index.js';`
- The types barrel is likely already re-exported; verify `export * from './types/index.js'` exists

  1.1.6. Run `pnpm build --filter=@abl/crawler` to verify

**Files Touched**:

- `packages/crawler/src/types/crawl-error.ts` — CREATE
- `packages/crawler/src/errors/crawl-error-classifier.ts` — CREATE
- `packages/crawler/src/errors/index.ts` — CREATE (barrel)
- `packages/crawler/src/index.ts` — ADD exports

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/crawler` succeeds with 0 errors
- [ ] `classifyCrawlError('Page returned HTTP 404', 404)` returns `'http_4xx'`
- [ ] `classifyCrawlError('connect ECONNREFUSED 127.0.0.1:3005')` returns `'connection_error'`
- [ ] `sanitizeErrorMessage('connect ECONNREFUSED 127.0.0.1:3005')` returns `'connect ECONNREFUSED [internal]'`
- [ ] All 9 error types are classified correctly
- [ ] Functions are importable from `@abl/crawler`

**Test Strategy**:

- Unit: Test all 9 classification branches + edge cases (no statusCode, empty string, unknown error)
- Unit: Test sanitizer strips internal IPs, ports, stack traces, and truncates

**Rollback**: Delete the two new files, remove exports from index.ts

---

### Phase 3: T-2 — Bulk Worker Error Persistence

**Prerequisite**: T-1 unit tests must all pass before starting T-2. The classifier is a critical dependency — incorrect classification will propagate bad `type` values into CrawlError documents.

**Goal**: Persist CrawlError documents on URL failure in bulk-crawl-worker, add method to SSE events, compute qualityMetrics at completion.

**Tasks**:
1.2.1. Add `statusCode?: number` to `ProcessUrlResult` interface (L196-206):

```typescript
interface ProcessUrlResult {
  // ...existing fields...
  statusCode?: number; // NEW
}
```

1.2.2. Propagate statusCode in HTTP failure path (L268-273):

```typescript
return {
  success: false,
  skipped: false,
  error: fetchResult.error ?? 'HTTP fetch failed',
  statusCode: fetchResult.statusCode, // NEW
};
```

1.2.3. Add imports at top of bulk-crawl-worker.ts:

```typescript
import { classifyCrawlError, sanitizeErrorMessage } from '@abl/crawler';
import type { ICrawlError } from '@agent-platform/database/models';
```

1.2.4. In the failure path after `allSettled` (L635-663), add CrawlError persistence:

- After `failedCount++` (L636 or L562), before `publishProgressEvent`:

```typescript
// Persist crawl error (best-effort non-blocking)
try {
  const CrawlErrorModel = getLazyModel<ICrawlError>('CrawlError');
  const errorType = classifyCrawlError(result.error ?? 'Unknown error', result.statusCode);
  await CrawlErrorModel.create({
    tenantId,
    crawlJobId: jobId,
    url,
    type: errorType,
    error: sanitizeErrorMessage(result.error ?? 'Unknown error'),
    statusCode: result.statusCode,
    timestamp: new Date(),
  });
} catch (err) {
  log.warn('Failed to persist crawl error', {
    url,
    jobId,
    error: err instanceof Error ? err.message : String(err),
  });
}
```

1.2.5. In the skipped (robots) path (L573-593), add CrawlError persistence:

- After `skippedCount++` (L574):

```typescript
try {
  const CrawlErrorModel = getLazyModel<ICrawlError>('CrawlError');
  await CrawlErrorModel.create({
    tenantId,
    crawlJobId: jobId,
    url,
    type: 'robots_blocked',
    error: 'URL blocked by robots.txt',
    timestamp: new Date(),
  });
} catch (err) {
  log.warn('Failed to persist crawl error for blocked URL', {
    url,
    jobId,
    error: err instanceof Error ? err.message : String(err),
  });
}
```

1.2.6. Update `ProgressEvent` interface in `apps/search-ai/src/routes/progress.ts`:

- Add `errorType?: string` to the `ProgressEvent.data` interface (alongside existing optional fields like `method`, `quality`, `qualityScore`)
- This is a flat bag of optional fields — no discriminated union needed
- **Naming decision**: Use `errorType` (not `type`) in the SSE `data` payload to avoid collision with the parent-level `ProgressEvent.type` field which indicates the event kind (e.g., `url_fetched`). The parent `type` and `data.errorType` serve different purposes. The HLD references `data.type` but the LLD uses `data.errorType` for clarity — update test spec INT-10 to assert `errorType` instead of `type`.

  1.2.7. Add `type` field to SSE failure event (L644-662):

```typescript
await publishProgressEvent({
  type: 'url_fetched',
  jobId,
  timestamp: new Date().toISOString(),
  data: {
    url,
    status: 'failed',
    error: { message: result.error ?? 'Processing failed' },
    errorType: classifyCrawlError(result.error ?? 'Unknown error', result.statusCode), // NEW
    // ...existing progress fields...
  },
});
```

1.2.8. Add `method` field to SSE success event (L613-634) — already present at L621 (`method: section?.strategy === 'browser' ? 'playwright' : 'http'`). Verify it's there and correct. ✅ Already done.

1.2.9. Add `method` to ingestion metadata (L301-310):

- After `quality: qualityResult.quality,` add:

```typescript
method: (section?.strategy === 'browser') ? 'playwright' : 'http',
```

1.2.10. Compute qualityMetrics BEFORE the final CrawlJob update block at L685-700 (insert new code before the update, add `'results.qualityMetrics': qualityMetrics` to the update object):

```typescript
// Compute qualityMetrics from SearchDocuments (non-blocking, 5s timeout)
let qualityMetrics: ICrawlJob['results']['qualityMetrics'] | undefined;
try {
  const SearchDocModel = getLazyModel<ISearchDocument>('SearchDocument');
  const qmResult = await SearchDocModel.aggregate([
    { $match: { tenantId, 'sourceMetadata.crawlJobId': jobId } },
    {
      $group: {
        _id: null,
        avgQualityScore: { $avg: '$sourceMetadata.qualityScore' },
        total: { $sum: 1 },
        succeeded: { $sum: { $cond: [{ $ne: ['$status', 'error'] }, 1, 0] } },
      },
    },
  ])
    .option({ maxTimeMS: 5000 })
    .exec();

  if (qmResult.length > 0) {
    const r = qmResult[0];
    qualityMetrics = {
      avgQualityScore: r.avgQualityScore ?? 0,
      avgContentPreservation: 0, // Not tracked in sourceMetadata — deferred
      avgChunksPerDoc: 0, // Requires SearchChunk aggregation — deferred
      successRate: r.total > 0 ? r.succeeded / r.total : 0,
    };
  }
} catch (err) {
  log.warn('Failed to compute qualityMetrics', {
    jobId,
    error: err instanceof Error ? err.message : String(err),
  });
}
```

Then include `'results.qualityMetrics': qualityMetrics` in the final CrawlJob update (L685-700).

1.2.11. Also handle the allSettled rejection path (L561-566) — when the URL processing promise itself rejects:

```typescript
if (settled.status === 'rejected') {
  failedCount++;
  const errMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
  log.error('URL processing promise rejected', { jobId, error: errMsg });
  // Persist error (fire-and-forget) — url is from the batch, extract it
  try {
    const batchUrl = batch[idx]; // Need to track batch URL for this index
    const CrawlErrorModel = getLazyModel<ICrawlError>('CrawlError');
    await CrawlErrorModel.create({
      tenantId,
      crawlJobId: jobId,
      url: batchUrl?.url ?? 'unknown',
      type: classifyCrawlError(errMsg),
      error: sanitizeErrorMessage(errMsg),
      timestamp: new Date(),
    });
  } catch (e) {
    log.warn('Failed to persist crawl error for rejected promise', { jobId });
  }
  continue;
}
```

**Note**: Need to verify that the batch URL is accessible at this point — the `batch` variable from the window needs to be in scope. Read the surrounding code during implementation to confirm.

**Files Touched**:

- `apps/search-ai/src/workers/bulk-crawl-worker.ts` — MODIFY (L196-206, L268-273, L562-566, L573-593, L635-663, L644-662, L685-700, imports)

**Exit Criteria**:

- [ ] `pnpm build --filter=search-ai` succeeds with 0 errors
- [ ] Bulk worker failure path creates CrawlError document with correct type and sanitized error
- [ ] Robots.txt blocked URLs create CrawlError with type `robots_blocked`
- [ ] SSE failure events include `errorType` field
- [ ] `method` field is included in ingestion metadata
- [ ] qualityMetrics is computed and stored in CrawlJob at completion

**Test Strategy**:

- Integration: INT-2 (CrawlError insertOne + find round-trip), verify CrawlError documents exist for failed URLs
- Integration: Verify qualityMetrics is populated in CrawlJob.results after completion
- E2E: E2E-8 (real-time SSE + persistence round-trip — bulk worker emits failure events with errorType, CrawlError documents persist)

**Rollback**: Revert bulk-crawl-worker.ts changes. CrawlError documents from test runs are TTL-cleaned.

---

### Phase 4: T-3 — Intelligence Worker Error Persistence

**Goal**: Persist CrawlError documents on URL failure in intelligence-crawl-worker, add quality/method to ingestion metadata, compute qualityMetrics.

**Tasks**:
1.3.1. Add imports at top of intelligence-crawl-worker.ts:

```typescript
import { classifyCrawlError, sanitizeErrorMessage } from '@abl/crawler';
import type { ICrawlError } from '@agent-platform/database/models';
```

1.3.2. In the budget-exhausted failure path (L682-697), add CrawlError persistence:

```typescript
failedCount++;

// Persist crawl error (best-effort non-blocking)
try {
  const CrawlErrorModel = getLazyModel<ICrawlError>('CrawlError');
  await CrawlErrorModel.create({
    tenantId,
    crawlJobId: jobId,
    url: pageUrl,
    type: 'crawl_error',
    error: sanitizeErrorMessage('LLM budget exhausted and no handler match'),
    timestamp: new Date(),
  });
} catch (err) {
  log.warn('Failed to persist crawl error', {
    url: pageUrl,
    jobId,
    error: err instanceof Error ? err.message : String(err),
  });
}
```

1.3.3. In the catch block failure path (L848-862), add CrawlError persistence:

```typescript
} catch (err) {
  const errMsg = err instanceof Error ? err.message : String(err);
  log.error('Page processing failed', { url: pageUrl, jobId, error: errMsg });
  failedCount++;

  // Persist crawl error (best-effort non-blocking)
  try {
    const CrawlErrorModel = getLazyModel<ICrawlError>('CrawlError');
    const errorType = classifyCrawlError(errMsg, cachedHttpResult?.statusCode);
    await CrawlErrorModel.create({
      tenantId,
      crawlJobId: jobId,
      url: pageUrl,
      type: errorType,
      error: sanitizeErrorMessage(errMsg),
      statusCode: cachedHttpResult?.statusCode,
      timestamp: new Date(),
    });
  } catch (persistErr) {
    log.warn('Failed to persist crawl error', {
      url: pageUrl, jobId,
      error: persistErr instanceof Error ? persistErr.message : String(persistErr),
    });
  }
  // ...existing SSE event and CrawlJob update...
}
```

1.3.4. Add `errorType` to SSE failure events (L685 and L854):

```typescript
data: {
  url: pageUrl,
  error: { message: errMsg },
  errorType: classifyCrawlError(errMsg, cachedHttpResult?.statusCode), // NEW
},
```

1.3.5. Add `quality`, `qualityScore`, and `method` to ingestion metadata (L722-728):

```typescript
const ingestionMetadata: Record<string, unknown> = {
  crawlJobId: jobId,
  crawledAt: new Date().toISOString(),
  domain: entryDomain,
  handlerReused: wasReused,
  quality: qualityResult?.quality, // NEW — from quality gate
  qualityScore: qualityResult?.score, // NEW — from quality gate
  method, // NEW — 'http' | 'playwright' from L500
};
```

**Note**: `qualityResult` availability confirmed — quality gate runs at intelligence-crawl-worker L567 and result is available at L722. The `method` variable from L500 is also in scope.
**Note on cachedHttpResult scope** (step 1.3.3): `cachedHttpResult` is declared at L501 and assigned at L509. If an error occurs before L509, `cachedHttpResult` is null — `cachedHttpResult?.statusCode` correctly returns undefined, and `classifyCrawlError(errMsg)` without statusCode falls back to string matching. This is the intended behavior.

1.3.6. Compute qualityMetrics at job completion (before final CrawlJob update at L867-877):
Same pattern as T-2 step 1.2.9 — aggregate from SearchDocuments, store in `results.qualityMetrics`.

**Files Touched**:

- `apps/search-ai/src/workers/intelligence-crawl-worker.ts` — MODIFY (imports, L682-697, L722-728, L848-862, L865-877)

**Exit Criteria**:

- [ ] `pnpm build --filter=search-ai` succeeds with 0 errors
- [ ] Intelligence worker budget-exhausted path creates CrawlError document
- [ ] Intelligence worker catch-block path creates CrawlError with statusCode from cachedHttpResult
- [ ] SSE failure events include `errorType` field
- [ ] Ingestion metadata includes quality, qualityScore, method fields
- [ ] qualityMetrics is computed and stored in CrawlJob at completion

**Test Strategy**:

- Integration: Trigger intelligence crawl failure, verify CrawlError documents
- Integration: Verify ingestion metadata includes quality/method fields

**Rollback**: Revert intelligence-crawl-worker.ts changes.

---

### Phase 5: T-4 — Extend /pages/:jobId Endpoint

**Goal**: Add CrawlError merge, error pagination, envelope wrapping, and sourceMetadata fields to /pages endpoint.

**Tasks**:
1.4.1. Add CrawlError to `getModels()` function (L72-81):

```typescript
function getModels() {
  return {
    // ...existing...
    CrawlError: getModel('CrawlError'),
  };
}
```

1.4.2. Add Zod validation for all query parameters (after L2990):

```typescript
import { z } from 'zod';

const PagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['all', 'fetched', 'failed', 'blocked']).default('all'),
  search: z.string().optional(),
  errorLimit: z.coerce.number().int().min(1).max(500).default(100),
  errorOffset: z.coerce.number().int().min(0).default(0),
  errorType: z.string().optional(),
});

const parsed = PagesQuerySchema.safeParse(req.query);
if (!parsed.success) {
  res.status(400).json({
    success: false,
    error: { code: 'INVALID_REQUEST', message: 'Invalid query parameters' },
  });
  return;
}
const {
  limit,
  offset,
  status: statusFilter,
  search: searchQuery,
  errorLimit,
  errorOffset,
  errorType,
} = parsed.data;
```

1.4.3. Update status filter logic (L3009-3014) to new filter values:

```typescript
// Old: success/failed/all → New: all/fetched/failed/blocked
if (statusFilter === 'fetched') {
  query.status = { $nin: [DocumentStatus.ERROR] };
} else if (statusFilter === 'failed') {
  query.status = DocumentStatus.ERROR;
} else if (statusFilter === 'blocked') {
  // For 'blocked', we only return crawlErrors, skip pages query
}
// 'all' → no filter on pages query
```

1.4.4. Add CrawlError query in parallel (modify L3022-3025):

```typescript
const { CrawlError } = getModels();

// Build crawlError query
const crawlErrorQuery: FilterQuery<ICrawlError> = { tenantId, crawlJobId: jobId };
if (errorType) {
  crawlErrorQuery.type = errorType;
}

const isBlockedFilter = statusFilter === 'blocked';

// 'blocked' filter restricts to blocked-type errors only (HLD status filter table)
if (isBlockedFilter) {
  crawlErrorQuery.type = { $in: ['robots_blocked', 'quality_gated', 'content_filtered'] };
}

const [documents, total, chunkCounts, crawlErrors, totalErrors] = await Promise.all([
  isBlockedFilter ? Promise.resolve([]) :
    SearchDocument.find(query).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
  isBlockedFilter ? Promise.resolve(0) :
    SearchDocument.countDocuments(query),
  isBlockedFilter ? Promise.resolve([]) :
    SearchChunk.aggregate([...existing aggregation...]),
  CrawlError.find(crawlErrorQuery)
    .sort({ timestamp: -1 })
    .skip(errorOffset)
    .limit(errorLimit)
    .lean(),
  CrawlError.countDocuments(crawlErrorQuery),
]);
```

1.4.5. Build response with sourceMetadata fields (modify L3050-3057):

```typescript
const pages = documents.map((doc: any) => ({
  url: doc.originalReference || '',
  status: doc.status,
  documentId: String(doc._id),
  chunks: chunkCountMap.get(String(doc._id)) || 0,
  crawledAt: doc.sourceMetadata?.crawledAt || doc.createdAt?.toISOString?.() || '',
  error: doc.processingError || undefined,
  // NEW sourceMetadata fields
  quality: doc.sourceMetadata?.quality || undefined,
  qualityScore: doc.sourceMetadata?.qualityScore || undefined,
  method: doc.sourceMetadata?.method || undefined,
  handlerReused: doc.sourceMetadata?.handlerReused || undefined,
}));
```

1.4.6. Build crawlErrors array:

```typescript
const crawlErrorEntries = (crawlErrors as any[]).map((err: any) => ({
  url: err.url,
  type: err.type,
  error: err.error,
  statusCode: err.statusCode || undefined,
  timestamp: err.timestamp?.toISOString?.() ?? '',
}));
```

1.4.7. Update response format (L3059-3069) to use standard envelope:

```typescript
res.json({
  success: true,
  data: {
    pages,
    crawlErrors: crawlErrorEntries,
    totalFailed: crawlJob.urls?.failed || 0,
    totalBlocked: crawlJob.urls?.blocked || 0,
    totalErrors,
    pagination: {
      total: isBlockedFilter ? 0 : total,
      offset: isBlockedFilter ? 0 : offset,
      limit,
      hasMore: isBlockedFilter ? false : offset + limit < total,
    },
    errorPagination: {
      total: totalErrors,
      offset: errorOffset,
      limit: errorLimit,
      hasMore: errorOffset + errorLimit < totalErrors,
    },
  },
});
```

1.4.8. Add jobId path parameter validation (before CrawlJob.findOne):
**IMPORTANT**: CrawlJob uses `_id: { type: String, default: uuidv7 }`, NOT MongoDB ObjectId. `mongoose.isValidObjectId()` validates 24-char hex strings and would reject ALL valid UUIDv7 IDs. Instead, validate via the Zod schema already introduced in step 1.4.2:

```typescript
// Add to PagesQuerySchema or validate separately:
const jobId = req.params.jobId;
if (!jobId || jobId.length === 0) {
  res.status(400).json({
    success: false,
    error: { code: 'INVALID_REQUEST', message: 'Invalid job ID format' },
  });
  return;
}
```

The existing `CrawlJob.findOne({ _id: jobId, tenantId })` already returns null for non-existent IDs (including garbage strings), and the 404 handler covers that case. The validation here is a minimal guard against empty/missing params. Do NOT use `mongoose.isValidObjectId()` — it would break the endpoint for all valid jobs.

1.4.9a. Fix error response format (L2976-2981, L2996-3001, L3074-3079):
All three error responses must use structured format `{ success: false, error: { code, message } }` matching `/dashboard` pattern:

```typescript
// 401
res.status(401).json({
  success: false,
  error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
});
// 404
res.status(404).json({
  success: false,
  error: { code: 'NOT_FOUND', message: 'Crawl job not found' },
});
// 500 — do NOT leak error.message to client
res.status(500).json({
  success: false,
  error: { code: 'INTERNAL_ERROR', message: 'Failed to get crawled pages' },
});
```

1.4.9. Normalize `tenantContext` access — remove `(req as any)` cast, use `req.tenantContext?.tenantId` (matches `/dashboard` pattern at L2393).

1.4.10. Update JSDoc comment (L2946-2968) to document new query params and response shape.

**Files Touched**:

- `apps/search-ai/src/routes/crawl.ts` — MODIFY (L72-81, L2946-3080)

**Exit Criteria**:

- [ ] `pnpm build --filter=search-ai` succeeds with 0 errors
- [ ] `GET /pages/:jobId` returns `{ success: true, data: { pages, crawlErrors, ... } }` envelope
- [ ] `crawlErrors[]` array populated from CrawlError collection
- [ ] `errorPagination` reflects CrawlError count
- [ ] `pages[]` includes quality, qualityScore, method, handlerReused from sourceMetadata
- [ ] `status=blocked` returns only crawlErrors, empty pages
- [ ] `errorType` query param filters crawlErrors by type
- [ ] Cross-tenant returns 404

**Test Strategy**:

- Integration: INT-3 (merged response empty), INT-4 (empty job), INT-5 (pagination), INT-8 (response shape), INT-9 (structural separation)
- E2E: E2E-1 (merged response), E2E-2 (cross-tenant 404), E2E-3 (sourceMetadata fields), E2E-5 (pagination), E2E-7 (invalid jobId 400/404)

**Rollback**: Revert crawl.ts /pages handler changes. Response reverts to old flat format.

---

### Phase 6: T-5 — Extend /dashboard/:jobId Endpoint

**Goal**: Add errorBreakdown and qualityDistribution to dashboard response.

**Tasks**:
1.5.1. Add CrawlError aggregation after existing docAggregation (L2503-2518):

```typescript
// CrawlError error breakdown by type
const CrawlErrorModel = getLazyModel<ICrawlError>('CrawlError');
let errorBreakdown: Array<{ type: string; count: number }> = [];
try {
  const breakdownResult = await CrawlErrorModel.aggregate([
    { $match: { tenantId, crawlJobId: batchId } },
    { $group: { _id: '$type', count: { $sum: 1 } } },
  ])
    .option({ maxTimeMS: 5000 })
    .exec();
  errorBreakdown = (breakdownResult as any[]).map((r: any) => ({
    type: r._id,
    count: r.count,
  }));
} catch (err) {
  logger.warn('CrawlError aggregation failed', {
    jobId,
    error: err instanceof Error ? err.message : String(err),
  });
}
```

1.5.2. Add qualityDistribution (conditional source):

```typescript
// Quality distribution — always real-time aggregation
// NOTE: HLD suggested deriving from stored qualityMetrics for completed jobs,
// but qualityMetrics contains averages (avgQualityScore), not per-tier counts
// (rich/standard/thin). Real-time aggregation is always required for distribution.
let qualityDistribution: Record<string, number> | null = null;
try {
  const qualityAgg = await SearchDocument.aggregate([
    { $match: { tenantId, 'sourceMetadata.crawlJobId': batchId } },
    { $group: { _id: '$sourceMetadata.quality', count: { $sum: 1 } } },
  ])
    .option({ maxTimeMS: 5000 })
    .exec();
  qualityDistribution = {};
  for (const r of qualityAgg as any[]) {
    if (r._id) qualityDistribution[r._id] = r.count;
  }
} catch (err) {
  logger.warn('Quality distribution aggregation failed', {
    jobId,
    error: err instanceof Error ? err.message : String(err),
  });
}
```

1.5.3. Add to response (L2698-2716):

```typescript
res.json({
  // ...existing fields...
  crawl: {
    ...crawlStats,
    errorBreakdown, // NEW
  },
  ingestion: {
    ...ingestionStats,
    qualityDistribution, // NEW
  },
  // ...rest unchanged...
});
```

1.5.4. Import ICrawlError type at top of file.

**Files Touched**:

- `apps/search-ai/src/routes/crawl.ts` — MODIFY (L2382-2726)

**Exit Criteria**:

- [ ] `pnpm build --filter=search-ai` succeeds with 0 errors
- [ ] Dashboard response includes `crawl.errorBreakdown` array
- [ ] Dashboard response includes `ingestion.qualityDistribution` object
- [ ] Both aggregations are wrapped in try/catch with 5s timeout
- [ ] Works for both active and completed crawl jobs

**Test Strategy**:

- Integration: INT-6 (quality metrics computation), INT-7 (errorBreakdown aggregation)
- E2E: E2E-4 (dashboard extensions)

**Rollback**: Revert dashboard handler changes. Additive response fields — old frontend ignores them.

---

### Phase 7: T-6 — API Types + i18n Keys

**Goal**: Update frontend API types and add i18n keys for error types and remediation.

**Tasks**:
1.6.1. Update `apps/studio/src/api/crawl.ts`:

- Import/define `CrawlErrorType` (same union type as backend)
- Add `CrawlErrorEntry` interface
- Update `CrawledPage` to add `qualityScore?: number`
- Rewrite `CrawledPagesResponse` — this type represents the UNWRAPPED data (no `success` field):
  ```typescript
  export interface CrawledPagesResponse {
    pages: CrawledPage[];
    crawlErrors: CrawlErrorEntry[];
    totalFailed: number;
    totalBlocked: number;
    totalErrors: number;
    pagination: { total: number; offset: number; limit: number; hasMore: boolean };
    errorPagination: { total: number; offset: number; limit: number; hasMore: boolean };
  }
  ```
- Update `getCrawledPages()` function to unwrap the envelope (matches `analyzeRobotsTxt` pattern at L261-265):

  ```typescript
  export async function getCrawledPages(
    jobId: string,
    opts?: {
      status?: string;
      limit?: number;
      offset?: number;
      search?: string;
      errorLimit?: number;
      errorOffset?: number;
      errorType?: string;
    },
  ): Promise<CrawledPagesResponse> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    if (opts?.search) params.set('search', opts.search);
    if (opts?.errorLimit) params.set('errorLimit', String(opts.errorLimit));
    if (opts?.errorOffset) params.set('errorOffset', String(opts.errorOffset));
    if (opts?.errorType) params.set('errorType', opts.errorType);
    const response = await apiFetch(crawlUrl(`/pages/${jobId}?${params.toString()}`));
    const result = await handleResponse<{ success: boolean; data: CrawledPagesResponse }>(response);
    return result.data;
  }
  ```

  1.6.2. Update `DashboardResponse` type in `apps/studio/src/api/crawl.ts`:

- Add to `crawl` section: `errorBreakdown?: Array<{ type: string; count: number }>`
- Add to `ingestion` section: `qualityDistribution?: Record<string, number>`

  1.6.3. Add i18n keys to `packages/i18n`:

- Find the correct locale file for SearchAI (grep for existing `search_ai.crawled_pages` or `search_ai.source_page` keys)
- Add 9 error type label keys: `search_ai.crawled_pages.error_types.http_4xx`, etc.
- Add 9 remediation text keys: `search_ai.crawled_pages.remediation.http_4xx`, etc.
- Add status filter labels: `search_ai.crawled_pages.filter_all`, `filter_fetched`, `filter_failed`, `filter_blocked`
- Add two-state status labels: `search_ai.crawled_pages.crawl_status`, `index_status`

  1.6.4. Run `pnpm build --filter=studio --filter=@agent-platform/i18n` to verify.

**Files Touched**:

- `apps/studio/src/api/crawl.ts` — MODIFY (L201-224, getCrawledPages function)
- `packages/i18n/locales/en/studio.json` — MODIFY (add keys)

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] `CrawledPagesResponse` type matches backend envelope shape (unwrapped)
- [ ] `getCrawledPages()` correctly unwraps `{ success, data }` response
- [ ] All 9 error type labels have i18n keys
- [ ] All 9 remediation texts have i18n keys
- [ ] Filter labels have i18n keys

**Test Strategy**:

- Type checking via build (no runtime tests needed at this phase)

**Rollback**: Revert type changes, remove i18n keys.

---

### Phase 8: T-7 — Redesign USPStatusStrip

**Goal**: Two-row layout showing crawl metrics separately from pipeline metrics.

**Tasks**:
1.7.1. Redesign `USPStatusStrip` component:

- Row 1 (Crawl): URLs Attempted, Fetched, Failed, Blocked — from `displayJob.urls` or dashboard `crawl` stats
- Row 2 (Pipeline): Documents Indexed, Processing Errors, Duration, Quality Distribution — from dashboard `ingestion` stats
- Quality distribution mini-bar: green (rich) / amber (standard) / red (thin) segments
- Use `AnimatedCounter` for all numeric values (existing component)
- Use data from dashboard response's `crawl.errorBreakdown` and `ingestion.qualityDistribution`

  1.7.2. Consume `crawl.errorBreakdown` and `ingestion.qualityDistribution` from the DashboardResponse (types already updated in T-6 step 1.6.2).

  1.7.3. Ensure crawl row uses `displayJob.urls` for terminal states and dashboard `crawl` stats for active states.

**Files Touched**:

- `apps/studio/src/components/search-ai/source-page/USPStatusStrip.tsx` — REWRITE
- `apps/studio/src/api/crawl.ts` — MODIFY (DashboardResponse type if needed)

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] Status strip renders two distinct rows: Crawl row and Pipeline row
- [ ] Crawl row shows: URLs Attempted, Fetched, Failed, Blocked
- [ ] Pipeline row shows: Documents Indexed, Processing Errors, Duration, Quality Distribution
- [ ] No hardcoded Tailwind palette colors — only semantic tokens
- [ ] No native `<select>` elements

**Test Strategy**:

- Manual: Visual verification with crawl job in various states
- E2E: Covered by existing USP E2E tests (structural verification)

**Rollback**: Revert USPStatusStrip.tsx.

---

### Phase 9: T-8 — Redesign CrawledPagesView

**Goal**: Display crawlErrors alongside pages, add filter bar (All/Fetched/Failed/Blocked), show two-state per-URL status.

**Tasks**:
1.8.1. Update `CrawledPagesView` to consume new `CrawledPagesResponse`:

- Use updated `getCrawledPages()` that returns `{ pages, crawlErrors, totalFailed, totalBlocked, totalErrors, pagination, errorPagination }`
- Render `pages[]` in existing table with new columns: Quality badge, Method icon, Crawl Status, Index Status
- Render `crawlErrors[]` below or in a separate section — each showing URL, error type badge, sanitized error message

  1.8.2. Add filter bar above the pages table:

- Tabs or segmented control: All / Fetched / Failed / Blocked
- Pass selected filter as `status` query param to `getCrawledPages()`
- When "Blocked" selected: only crawlErrors shown, pages table hidden

  1.8.3. Add two-state per-URL model to PageRow:

- Column 1: Crawl Status — ✅ (fetched), ❌ (failed), ⏭ (blocked)
- Column 2: Index Status — ✅ (indexed), ⏳ (processing), ❌ (error), — (N/A for failed/blocked)
- For pages: Crawl = ✅, Index = derive from `page.status`
- For crawlErrors: Crawl = ❌ or ⏭, Index = —

  1.8.4. Add error pagination:

- "Load more errors" button when `errorPagination.hasMore`
- Increment `errorOffset` and append results

  1.8.5. Update SWR key to include all new query params.

**Files Touched**:

- `apps/studio/src/components/search-ai/CrawledPagesView.tsx` — REWRITE

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] Pages tab shows both pages and crawlErrors from merged response
- [ ] Filter bar switches between All/Fetched/Failed/Blocked views
- [ ] Two-state status model renders correctly (Crawl ✅/❌/⏭ × Index ✅/⏳/❌/—)
- [ ] Error pagination loads more errors on demand
- [ ] No hardcoded colors, no native `<select>`

**Test Strategy**:

- E2E: E2E-5 (pagination), E2E-6 (error pagination)
- Manual: Visual verification with real crawl data

**Rollback**: Revert CrawledPagesView.tsx.

---

### Phase 10: T-9 — Redesign ErrorGroupingPanel

**Goal**: Separate crawl errors from pipeline errors, use backend-provided type, add remediation guidance.

**Tasks**:
1.9.1. Rewrite `ErrorGroupingPanel`:

- Remove old `categorizeError()` function entirely
- Accept `crawlErrors: CrawlErrorEntry[]` and `pages: CrawledPage[]` as props (or consume from shared data)
- Section 1: "Crawl Errors" — group `crawlErrors[]` by `type` field, show count per group, expandable URL list
- Section 2: "Processing Errors" — filter `pages[]` where `status === 'error'`, group by error message similarity
- Each group shows remediation guidance from i18n key (`search_ai.crawled_pages.remediation.{type}`)

  1.9.2. Update component props:

```typescript
interface ErrorGroupingPanelProps {
  jobId: string;
  indexId: string;
  sourceId: string;
  crawlErrors: CrawlErrorEntry[];
  pipelineErrors: CrawledPage[];
}
```

1.9.3. Handle historical jobs with no CrawlError data:

- When `crawlErrors.length === 0 && (totalFailed > 0 || totalBlocked > 0)`: show a contextual message like "Detailed error information is available for crawls started after [feature deploy]. This job shows {totalFailed} failed URLs."
- This covers pre-existing completed jobs that have `urls.failed > 0` in the CrawlJob but no CrawlError documents (since errors were not persisted before this feature).
- Add i18n key: `search_ai.crawled_pages.error_details_unavailable`

  1.9.4. Render ErrorGroupingPanel as a child of CrawledPagesView (not UnifiedSourcePage):

- CrawledPagesView already fetches CrawledPagesResponse via SWR — it has `crawlErrors` and `pages` data
- Render ErrorGroupingPanel inside CrawledPagesView, passing `crawlErrors` and `pipelineErrors` (filtered from pages) as props
- This avoids restructuring UnifiedSourcePage's data flow or lifting SWR state up

  1.9.5. Remove the old SWR fetch inside ErrorGroupingPanel — data now comes from parent via props. Remove the separate `getCrawledPages(jobId, { status: 'failed' })` call.

**Files Touched**:

- `apps/studio/src/components/search-ai/source-page/ErrorGroupingPanel.tsx` — REWRITE
- `apps/studio/src/components/search-ai/source-page/UnifiedSourcePage.tsx` — MODIFY (pass new props)

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] Crawl Errors section groups by backend `type` field
- [ ] Processing Errors section shows pipeline failures (SearchDocuments with status=error)
- [ ] Each group shows remediation guidance text from i18n
- [ ] Old `categorizeError()` function is deleted
- [ ] No internal SWR fetch — data from props
- [ ] No hardcoded colors, no native `<select>`

**Test Strategy**:

- E2E: E2E-1 (crawlErrors displayed), E2E-4 (error breakdown)
- Manual: Visual verification with error groups

**Rollback**: Revert ErrorGroupingPanel.tsx and UnifiedSourcePage.tsx.

---

## 4. Wiring Checklist

- [x] New CrawlError model registered in `packages/database/src/models/index.ts` barrel export (T-0)
- [x] CrawlError registered in SearchAI ModelRegistry at `apps/search-ai/src/db/index.ts` (T-0)
- [x] CrawlError added to `getModels()` in `apps/search-ai/src/routes/crawl.ts` (T-4)
- [x] CrawlError imported via `getLazyModel('CrawlError')` in both workers (T-2, T-3)
- [x] CrawlError imported via `getLazyModel('CrawlError')` in dashboard handler (T-5)
- [x] New types exported via barrel chain: `errors/index.ts` → `src/index.ts` in `packages/crawler` (T-1)
- [x] CrawlErrorType exported via `types/index.ts` barrel in `packages/crawler` (T-1)
- [x] i18n keys added to locale files (T-6)
- [x] Frontend API types updated to match backend response (T-6)
- [x] getCrawledPages function updated to handle new envelope (T-6)
- [x] ErrorGroupingPanel props updated and wired in parent (T-9)
- [x] `ProgressEvent.data.errorType` added to progress.ts interface (T-2) — SSE consumers tolerate new optional fields

**Studio UI checks:**

- [ ] No native `<select>` elements — all use `<Select>` from `components/ui/Select.tsx`
- [ ] No `bg-accent text-foreground` — use `bg-accent text-accent-foreground`
- [ ] Each form's onSubmit/mutation has error handling
- [ ] Submit buttons have `disabled={isPending}` loading guard
- [ ] No hardcoded Tailwind palette colors — semantic tokens only

**Dockerfile sync:**

- [ ] No new packages added — CrawlError model is in existing `packages/database`, classifier is in existing `packages/crawler`. No Dockerfile changes needed.

---

## 5. Cross-Phase Concerns

### Database Migrations

None required. CrawlError collection is auto-created on first `create()` by Mongoose. Compound index and TTL index are defined in the schema.

**Index creation note**: Verify during T-0 implementation whether SearchAI's Mongoose connection has `autoIndex: false`. If so, indexes must be created manually (e.g., `model.syncIndexes()` call during startup, or a one-time migration script). If `autoIndex: true` (default), indexes are created on first model use — expect a one-time performance hit on first deployment. The compound index `{tenantId, crawlJobId, timestamp}` and TTL index `{createdAt}` are small and should build quickly on an empty collection.

**TTL semantic note**: CrawlJob's TTL fires on `timeline.completedAt` with a `partialFilterExpression` limiting to terminal statuses. CrawlError's TTL fires on `createdAt` unconditionally. For extremely long-running crawls (>90 days, unrealistic in practice), early errors could theoretically expire before the parent CrawlJob. Accepted tradeoff — crawls complete within hours, not months.

### Feature Flags

None. Response changes are additive — old frontends ignore new fields. Backend and frontend deploy together in Wave 3.

### Configuration Changes

No new env vars. Error pagination defaults (errorLimit=100, errorOffset=0) are hardcoded with sensible values.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] CrawlError documents are created when URLs fail during both bulk and intelligence crawls
- [ ] `/pages/:jobId` returns merged pages + crawlErrors with independent pagination
- [ ] `/dashboard/:jobId` returns errorBreakdown and qualityDistribution
- [ ] USP status strip shows two rows: crawl metrics and pipeline metrics
- [ ] Pages tab shows all URLs with two-state model (Crawled/Indexed)
- [ ] Error grouping panel separates crawl errors from pipeline errors with remediation
- [ ] Cross-tenant isolation returns 404 (not 403)
- [ ] All queries include tenantId
- [ ] No regressions in existing tests (`pnpm build && pnpm test`)
- [ ] E2E-1 through E2E-8 scenarios passing
- [ ] INT-1 through INT-10 scenarios passing
- [ ] UT-1 through UT-7 scenarios passing

---

## 7. Open Questions

1. **Intelligence worker quality gate scope**: The intelligence worker at L722-728 doesn't currently run quality gate or store qualityScore in ingestion metadata. Need to verify during T-3 implementation whether the quality gate is imported/available in the intelligence worker, and where in the flow the quality assessment happens.

2. **Batch URL tracking in allSettled rejection**: The bulk worker's allSettled rejection path (L561-566) increments `failedCount` but may not have access to the specific URL that failed (depends on how the batch/window variable is structured). Verify during T-2 implementation.

3. **CrawledPagesView data source for ErrorGroupingPanel**: The ErrorGroupingPanel currently fetches its own data via SWR. In the redesign (T-9), it receives data via props from the parent. Need to verify which parent component currently renders ErrorGroupingPanel and update its data passing.

4. ~~**DashboardResponse type in Studio**~~: **RESOLVED** — T-6 step 1.6.2 explicitly adds `errorBreakdown` and `qualityDistribution` to the DashboardResponse type.

5. **HTTP 429 as distinct error type** (Round 7 industry research): Industry crawlers treat 429 (rate-limited) differently from generic 4xx — it signals "slow down" rather than "page not found." Consider adding `http_429_rate_limited` as a 10th type in a follow-up, checking 429 before the `http_4xx` catch-all. Not blocking for initial implementation since the current taxonomy covers the user-facing UX requirements.

6. **SSE reconnection gap** (Round 7): SSE events lack `id:` field for Last-Event-ID reconnection recovery. If client disconnects mid-crawl, missed `errorType` events are lost. The `/pages` endpoint serves as the durable fallback. Acceptable for current scope — flag for future SSE hardening.

7. **Dashboard aggregation timeout** (Round 7): `maxTimeMS: 5000` may be too aggressive for large crawl jobs without a covering index on `sourceMetadata.crawlJobId + quality`. If dashboard queries time out in production, consider adding a compound index on SearchDocument `{ 'sourceMetadata.crawlJobId': 1, 'sourceMetadata.quality': 1 }` or increasing the timeout to 15s (dashboard is not latency-critical).
