# Crawl V2 — Low-Level Design

**HLD:** `docs/specs/crawl-v2.hld.md`
**Objectives:** `docs/specs/crawl-v2-objectives.md`
**Test Scenarios:** `docs/specs/crawl-v2-test-scenarios.md`
**Ticket:** ABLP-71

---

## Task T-0: Full URL Storage (D13)

### Problem

`UrlClusterer.cluster()` returns max 10 examples per group (`MAX_EXAMPLES = 10`). The full URL list is discarded. User sees "142 pages" but only ~10 get crawled.

### Files to Modify

- `apps/search-ai/src/routes/crawl.ts` — Modify `POST /cluster-urls` to accept `draftId` and store full URLs into buckets after clustering
- `apps/studio/src/components/search-ai/crawl-flow/CrawlFlowV5.tsx` — Modify `handleStartCrawl()` to read from buckets as primary path
- `apps/studio/src/api/crawl.ts` — Add `draftId` param to `clusterUrls()` API call

### Files to Create

None — bucket infrastructure (`putSectionUrls`, `getSectionUrls`) already exists.

### Function Signatures

#### Backend: `POST /cluster-urls` (crawl.ts ~line 1501)

Current Zod schema:

```typescript
const clusterUrlsSchema = z.object({
  url: z.string().url(),
  sitemapUrls: z.array(z.string().url()).max(5000).optional(),
  platform: z.string().optional(),
  apiEndpoints: z.array(z.string().startsWith('/')).max(20).optional(),
  sampleUrls: z.array(z.string().min(1)).max(50).optional(),
});
```

Add to schema:

```typescript
  draftId: z.string().min(1).optional(), // When present, store full URLs per group into buckets
```

After clustering (after line ~1657), add bucket storage:

```typescript
if (draftId) {
  // Store full URLs per group into CrawlDraftUrlBucket
  for (const group of scoredGroups) {
    const sectionId = `sec-${scoredGroups.indexOf(group)}`;
    const fullUrls = getFullUrlsForGroup(group, urlsToCluster);
    if (fullUrls.length > 0) {
      const bucketUrls: Array<{
        url: string;
        title: string | null;
        score: number | null;
        depth: number;
      }> = fullUrls.map((u) => ({ url: u, title: null, score: null, depth: group.depth }));
      await putSectionUrlsInternal(tenantId, draftId, sectionId, bucketUrls);
    }
  }
}
```

New internal function:

```typescript
async function putSectionUrlsInternal(
  tenantId: string,
  draftId: string,
  sectionId: string,
  urls: Array<{ url: string; title: string | null; score: number | null; depth: number }>,
): Promise<void>;
```

This reuses the existing bucket write logic from `crawl-drafts.ts` PUT handler. Extract the shared logic into a service function or call the existing route internally.

#### Frontend: `handleStartCrawl()` (CrawlFlowV5.tsx ~line 626)

Change URL collection priority (currently at ~line 640-660):

```typescript
// V2: Bucket-first URL collection
for (const section of includedSections) {
  const sid = section.sectionId ?? `sec-${includedSections.indexOf(section)}`;
  try {
    const result = await getSectionUrls(draftId!, sid, { limit: 50000 });
    if (result.urls.length > 0) {
      allUrls.push(...result.urls.map((u) => u.url));
      continue; // Got full URLs from bucket
    }
  } catch (err) {
    log.warn('Bucket read failed, falling back to examples', {
      draftId,
      sectionId: sid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // FALLBACK: use examples (only ~10 URLs)
  if (section.pages?.length) {
    allUrls.push(...section.pages.map((p) => p.url));
  } else if (section.examples?.length) {
    allUrls.push(...section.examples);
  }
}
```

#### Frontend: `clusterUrls()` call site

Pass `draftId` when calling the cluster-urls API. In `CrawlFlowV5.tsx`, the cluster call happens via the analysis pipeline. Find where `POST /cluster-urls` is invoked and add `draftId` to the request body.

### Database/Model Changes

None — `CrawlDraftUrlBucket` model already exists with the exact schema needed.

### Subtasks (execution order)

1. **ST-0.1**: Extract bucket write logic from `crawl-drafts.ts` PUT handler into a shared `putSectionUrlsBulk()` utility in `apps/search-ai/src/services/crawl-draft-url.service.ts`
2. **ST-0.2**: Modify `POST /cluster-urls` endpoint to accept optional `draftId`, call `putSectionUrlsBulk()` after clustering with full URL lists (not just examples)
3. **ST-0.3**: Modify `clusterUrls()` API call in Studio to pass `draftId`
4. **ST-0.4**: Modify `handleStartCrawl()` in `CrawlFlowV5.tsx` to use bucket-first URL collection
5. **ST-0.5**: Wire `BrowserDiscoveryInline.tsx` to call `putSectionUrls()` after building sections from browser exploration
6. **ST-0.6**: Wire `ExplorePanel.tsx` to call `putSectionUrls()` after building sections from explore results
7. **ST-0.7**: Verify: `pnpm build --filter=@agent-platform/search-ai --filter=studio`

### Acceptance Criteria

- AC-0.1: Given a site with 142 URLs in a section, when cluster-urls runs with draftId, then all 142 URLs are stored in buckets (not just 10 examples)
  - Verify: POST `/api/crawl/cluster-urls` with draftId → query `crawl_draft_url_buckets` collection → verify URL count matches group count
- AC-0.2: Given buckets populated, when handleStartCrawl fires, then submitBatchCrawl receives all 142 URLs (not 10)
  - Verify: Network capture shows batch request with `urls.length === 142`
- AC-0.3: Given buckets are empty (fallback), handleStartCrawl still works using section.pages/examples
  - Verify: Delete buckets → start crawl → batch request sent with example URLs
- AC-0.4: Given browser-based discovery builds sections, URLs are persisted to buckets (survive page refresh)
  - Verify: Browser discover → refresh page → buckets contain discovered URLs
- AC-0.5: SectionId from backend bucket storage (`sec-{i}`) matches sectionId from frontend `mapGroupsToSections()` (`sec-{i}`)
  - Verify: Bucket sectionIds align with draft section sectionIds

---

## Task T-1: Bulk Crawl Worker

### Problem

No Node.js bulk crawl worker exists. The Go crawler is broken (ignores discovery outcomes, broken Redis pipe, not in this repo).

### Files to Create

- `apps/search-ai/src/workers/bulk-crawl-worker.ts` — New BullMQ worker with sliding window concurrency

### Files to Modify

- `apps/search-ai/src/workers/index.ts` — Register new worker in `startWorkers()`
- `apps/search-ai/src/workers/shared.ts` — Add `BulkCrawlJobData` interface, `QUEUE_BULK_CRAWL` constant

### Function Signatures

#### Job data interface (shared.ts):

```typescript
export const QUEUE_BULK_CRAWL = 'bulk-crawl';

export interface BulkCrawlSectionMapping {
  sectionId: string;
  pattern: string;
  name: string;
  urls: string[];
  strategy: 'http' | 'browser';
}

export interface BulkCrawlJobData {
  jobId: string;
  tenantId: string;
  userId: string;
  indexId: string;
  sourceId: string;
  draftId?: string;
  urls: string[];
  sectionMapping: BulkCrawlSectionMapping[];
  crawlSettings: {
    crawlDelay: number;
    respectRobotsTxt: boolean;
    cleanupLevel: 'standard' | 'aggressive' | 'none';
    deduplicate: boolean;
    cookieConsent: boolean;
    reuseHandlers: boolean;
  };
}
```

#### Worker processor (bulk-crawl-worker.ts):

```typescript
import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import {
  createWorkerOptions,
  getRedisConnection,
  workerLog,
  workerError,
  type BulkCrawlJobData,
  QUEUE_BULK_CRAWL,
} from './shared.js';
import { crawlerIngestionService } from '../services/ingestion/crawler-ingestion.js';
import { publishProgressEvent } from '../routes/progress.js';
import {
  HandlerReuser,
  TemplateFingerprinter,
  MongoHandlerStore,
  QualityGate,
  HttpAdapter,
  type IHandlerStore,
} from '@abl/crawler';
import { RobotsChecker, DomainRateLimiter } from '@abl/crawler';
import { createLogger } from '@abl/compiler/platform';
import { getLazyModel } from '../db/index.js';
import type { ICrawlJob } from '@agent-platform/database';

const log = createLogger('bulk-crawl-worker');
const WINDOW_SIZE = 5;
const PAGE_TIMEOUT_MS = 60_000;
const CANCEL_CHECK_KEY = 'crawl:cancel:';
const CHECKPOINT_KEY = 'crawl:checkpoint:';
const CHECKPOINT_TTL = 10_800; // 3 hours
const SEMAPHORE_KEY = 'crawl:tenant-sem:';
const SEMAPHORE_MAX = 20;
const SEMAPHORE_TTL = 120;

// Lazy singletons — same pattern as intelligence-crawl-worker.ts:100-162
const fingerprinter = new TemplateFingerprinter();
let handlerReuser: HandlerReuser | null = null;
let handlerStore: MongoHandlerStore | null = null;
let httpAdapter: HttpAdapter | null = null;
let qualityGate: QualityGate | null = null;
let redisClient: IORedis | null = null;
let mcpClient: any = null; // MCP client for Playwright, opened per-job

function getHandlerReuser(): HandlerReuser {
  if (!handlerReuser) handlerReuser = new HandlerReuser(fingerprinter);
  return handlerReuser;
}
function getHandlerStore(): MongoHandlerStore {
  if (!handlerStore) {
    const model =
      getLazyModel<import('@agent-platform/database').IHandlerTemplate>('HandlerTemplate');
    handlerStore = new MongoHandlerStore(model);
  }
  return handlerStore;
}
function getHttpAdapter(): HttpAdapter {
  if (!httpAdapter) httpAdapter = new HttpAdapter();
  return httpAdapter;
}
function getQualityGate(): QualityGate {
  if (!qualityGate) qualityGate = new QualityGate();
  return qualityGate;
}
function getRedis(): IORedis {
  if (!redisClient) redisClient = new IORedis(getRedisConnection() as any);
  return redisClient;
}

export async function processBulkCrawl(job: Job<BulkCrawlJobData>): Promise<void>;

let bulkCrawlWorker: Worker | null = null;
export function getBulkCrawlWorker(): Worker | null {
  return bulkCrawlWorker;
}

export function createBulkCrawlWorker(): Worker {
  const options = createWorkerOptions(1); // One job at a time
  const w = new Worker<BulkCrawlJobData>(QUEUE_BULK_CRAWL, processBulkCrawl, {
    ...options,
    lockDuration: 3_600_000, // 60 min
    lockRenewTime: 300_000, // 5 min
    stalledInterval: 3_600_000,
  });

  // Standard worker event handlers (matching intelligence-crawl-worker pattern)
  w.on('completed', (completedJob) => workerLog('bulk-crawl', `Job ${completedJob.id} completed`));
  w.on('failed', (failedJob, error) => {
    workerError('bulk-crawl', `Job ${failedJob?.id} failed`, error);
  });
  w.on('error', (error) => workerError('bulk-crawl', 'Worker error', error));

  bulkCrawlWorker = w;
  return w;
}
```

#### Core processing loop:

```typescript
async function processBulkCrawl(job: Job<BulkCrawlJobData>): Promise<void> {
  const {
    jobId,
    tenantId,
    userId,
    indexId,
    sourceId,
    draftId,
    urls,
    sectionMapping,
    crawlSettings,
  } = job.data;
  const redis = getRedis(); // Lazy IORedis singleton (matching intelligence-crawl-worker pattern)
  const CrawlJob = getLazyModel<ICrawlJob>('CrawlJob');
  const startTime = Date.now(); // Used in finally block for duration

  // 1. Update job status to 'crawling'
  await CrawlJob.updateOne(
    { _id: jobId, tenantId },
    { status: 'crawling', 'timeline.startedAt': new Date() },
  );

  // 2. Emit job_started
  await publishProgressEvent({
    type: 'job_started',
    jobId,
    timestamp: new Date().toISOString(),
    data: { progress: { total: urls.length, completed: 0, failed: 0, percentage: 0 } },
  });

  // 3. Seed handler templates (D14) — same pattern as intelligence-crawl-worker lines 319-332
  const store = getHandlerStore();
  const reuser = getHandlerReuser();
  const domain = new URL(urls[0]).hostname;
  if (crawlSettings.reuseHandlers) {
    const templates = await store.findByDomain(tenantId, domain);
    for (const t of templates) {
      const fp = TemplateFingerprinter.fromSerializable({
        fingerprint: t.fingerprint,
        tagPathCount: 0,
      });
      reuser.registerHandler(fp.fingerprint, t.handler, t.trainedOn);
    }
  }

  // 3b. Open MCP connection if any section uses browser strategy (D9)
  const hasBrowserSections = sectionMapping.some((sm) => sm.strategy === 'browser');
  let mcpConnection: any = null;
  let mcpLinksUsed = 0;
  const MAX_MCP_LINKS_PER_BATCH = 50;
  if (hasBrowserSections) {
    try {
      mcpConnection = await openMcpConnection(); // Opens Playwright MCP client to port 3100
    } catch (err) {
      log.warn('MCP connection failed — all browser URLs will fallback to HTTP', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. Build URL→section lookup
  const urlSectionMap = buildUrlSectionMap(urls, sectionMapping);

  // 5. Load robots.txt if respectRobotsTxt
  let robotsChecker: RobotsChecker | null = null;
  if (crawlSettings.respectRobotsTxt) {
    robotsChecker = await createRobotsChecker(domain);
  }

  // 6. Create rate limiter
  const rateLimiter = createDomainRateLimiter(domain, crawlSettings.crawlDelay);

  // 7. Load checkpoint (crash recovery)
  const checkpoint = await loadCheckpoint(redis, jobId);
  const processedUrls = new Set(checkpoint.processedUrls);
  const remainingUrls = urls.filter((u) => !processedUrls.has(u));

  // 8. Sliding window processing
  let successCount = checkpoint.successCount;
  let failedCount = checkpoint.failedCount;
  let skippedCount = checkpoint.skippedCount;
  let cancelled = false;
  const sectionCounts: Record<string, { completed: number; total: number }> = {};

  // Initialize section counts
  for (const sm of sectionMapping) {
    sectionCounts[sm.sectionId] = { completed: 0, total: sm.urls.length };
  }

  // Bounded Set — max size = urls.length (finite, from job data)
  const activeSet = new Set<Promise<void>>();
  let lastCheckpointTime = Date.now();
  const CHECKPOINT_INTERVAL_MS = 15_000; // Time-based checkpoint (not count-based)

  // Quality tracking (D8)
  let goodCount = 0;
  let thinCount = 0;
  let qualityFailedCount = 0;

  try {
    for (const url of remainingUrls) {
      // Check cancel signal
      const cancelKey = await redis.get(`${CANCEL_CHECK_KEY}${jobId}`);
      if (cancelKey) {
        cancelled = true;
        break;
      }

      if (activeSet.size >= WINDOW_SIZE) {
        await Promise.race(activeSet);
      }

      // Acquire semaphore slot (AFTER window check — don't hold slot while waiting)
      await acquireSemaphore(redis, tenantId);

      const p = processUrl(url, {
        jobId,
        tenantId,
        indexId,
        sourceId,
        urlSectionMap,
        robotsChecker,
        rateLimiter,
        reuser,
        store,
        crawlSettings,
        sectionCounts,
        mcpConnection,
        mcpLinksUsed,
        MAX_MCP_LINKS_PER_BATCH,
      })
        .then((result) => {
          if (result.status === 'success') {
            successCount++;
            if (result.quality === 'thin') thinCount++;
            else goodCount++;
          } else if (result.status === 'failed') {
            failedCount++;
            qualityFailedCount++;
          } else if (result.status === 'skipped') skippedCount++;
          if (result.usedMcp) mcpLinksUsed++;
          processedUrls.add(url);
        })
        .catch((err) => {
          failedCount++;
          processedUrls.add(url);
          log.error('Unexpected error processing URL', {
            url,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          activeSet.delete(p);
          releaseSemaphore(redis, tenantId).catch(() => {});
        });

      activeSet.add(p);

      // Time-based checkpoint (reliable with sliding window)
      if (Date.now() - lastCheckpointTime > CHECKPOINT_INTERVAL_MS) {
        await saveCheckpoint(redis, jobId, {
          processedUrls: [...processedUrls],
          successCount,
          failedCount,
          skippedCount,
        });
        lastCheckpointTime = Date.now();
      }
    }

    // Drain remaining
    await Promise.allSettled(activeSet);
  } finally {
    // 9. Update CrawlJob to terminal status
    const status = cancelled ? 'cancelled' : failedCount === urls.length ? 'failed' : 'completed';
    await CrawlJob.updateOne(
      { _id: jobId, tenantId },
      {
        status,
        'timeline.completedAt': new Date(),
        'urls.crawled': successCount,
        'urls.failed': failedCount,
        'urls.blocked': skippedCount,
        'results.documentsCreated': successCount,
      },
    );

    // 10. Update CrawlDraft flowState → 'completed' (D10)
    if (draftId) {
      const CrawlDraft = getLazyModel<ICrawlDraft>('CrawlDraft');
      await CrawlDraft.updateOne({ _id: draftId, tenantId }, { flowState: 'completed' });
    }

    // 11. Close MCP connection (D9 — one per job)
    if (mcpConnection) {
      try {
        await mcpConnection.close();
      } catch {
        /* best effort */
      }
    }

    // 12. Emit terminal event with quality stats (D8)
    await publishProgressEvent({
      type: cancelled ? 'job_failed' : status === 'failed' ? 'job_failed' : 'job_completed',
      jobId,
      timestamp: new Date().toISOString(),
      data: {
        progress: {
          total: urls.length,
          completed: successCount,
          failed: failedCount,
          percentage: 100,
        },
        skipped: skippedCount,
        quality: { good: goodCount, thin: thinCount, failed: qualityFailedCount },
        duration: Date.now() - startTime,
        sections: Object.entries(sectionCounts).map(([sid, c]) => ({
          sectionId: sid,
          name: sectionMapping.find((sm) => sm.sectionId === sid)?.name ?? sid,
          count: c.completed,
        })),
      },
    });

    // 13. Record metering data (O7 — SaaS billing)
    await CrawlJob.updateOne(
      { _id: jobId, tenantId },
      {
        $set: {
          'results.metering': {
            httpPages: goodCount - thinCount /* approx */,
            browserPages: mcpLinksUsed,
            totalPages: successCount,
          },
        },
      },
    ).catch((err) =>
      log.warn('Metering update failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    // 14. Clean up checkpoint
    await redis.del(`${CHECKPOINT_KEY}${jobId}`);
  }
}
```

#### Per-URL processor:

Return type is a result object (not bare string) to track quality:

```typescript
interface ProcessUrlResult {
  status: 'success' | 'failed' | 'skipped';
  quality?: 'good' | 'thin' | 'failed';
  usedMcp?: boolean;
}

async function processUrl(url: string, ctx: ProcessUrlContext): Promise<ProcessUrlResult> {
  const {
    jobId,
    tenantId,
    indexId,
    sourceId,
    urlSectionMap,
    robotsChecker,
    rateLimiter,
    reuser,
    store,
    crawlSettings,
    sectionCounts,
    mcpConnection,
    mcpLinksUsed,
    MAX_MCP_LINKS_PER_BATCH,
  } = ctx;

  const section = urlSectionMap.get(url);
  let strategy = section?.strategy ?? 'http';

  // 1. Robots.txt check
  if (robotsChecker && !(await robotsChecker.isAllowed(url))) {
    await publishProgressEvent({
      type: 'url_skipped',
      jobId,
      timestamp: new Date().toISOString(),
      data: { url, reason: 'robots_txt' },
    });
    return { status: 'skipped' };
  }

  // 2. Rate limit (respects max of crawlDelay vs robots.txt crawl-delay)
  const robotsDelay = robotsChecker ? await robotsChecker.getCrawlDelay(url) : null;
  await rateLimiter.acquire(robotsDelay);

  // 3. Fetch WITH RETRY (matching HLD Error Handling Strategy table)
  let html: string;
  let statusCode: number;
  let usedMcp = false;
  const fetchStart = Date.now();

  // Downgrade browser to HTTP if MCP unavailable or link limit reached
  if (strategy === 'browser' && (!mcpConnection || mcpLinksUsed >= MAX_MCP_LINKS_PER_BATCH)) {
    strategy = 'http';
    log.info('Downgraded browser to HTTP', {
      url,
      reason: !mcpConnection ? 'no_mcp' : 'link_limit',
    });
  }

  if (strategy === 'browser') {
    try {
      // Two-step MCP pattern (matching intelligence-crawl-worker lines 537-551)
      await mcpConnection.callTool('navigate', {
        url,
        waitUntil: 'networkidle',
        timeout: PAGE_TIMEOUT_MS,
      });
      const pageContent = await mcpConnection.callTool('get_page_content', {
        includeHtml: true,
        includeText: true,
      });
      html = pageContent.html;
      statusCode = 200;
      usedMcp = true;
    } catch (err) {
      // Playwright timeout → 1 retry with HTTP fallback (HLD error table)
      log.warn('Playwright fetch failed, falling back to HTTP', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      const httpResult = await fetchWithHttpRetry(url);
      html = httpResult.html;
      statusCode = httpResult.statusCode;
    }
  } else {
    const httpResult = await fetchWithHttpRetry(url);
    html = httpResult.html;
    statusCode = httpResult.statusCode;
  }

  const duration = Date.now() - fetchStart;

  // Check for HTTP errors that mean skip
  if (statusCode >= 400 && statusCode !== 429) {
    await emitUrlFetched(jobId, url, strategy, statusCode, duration, sectionCounts);
    return { status: 'failed' };
  }

  // 4. Quality gate (D8 — always ingest, mark thin)
  const qg = getQualityGate();
  const qualityResult = qg.scoreWithDom
    ? qg.scoreWithDom(html, url)
    : { score: 1, quality: 'good' as const };
  const qualityLabel: 'good' | 'thin' | 'failed' = qualityResult.score < 0.3 ? 'thin' : 'good';

  // 5. Handler reuse (D14)
  let content: string = html;
  if (crawlSettings.reuseHandlers) {
    const match = reuser.tryReuse(html);
    if (match.matched && match.handler) {
      // Handler extraction — 0 LLM calls
      content = html; // Handler selectors applied during ingestion via metadata
      store.recordSuccess(tenantId, new URL(url).hostname, match.templateId!).catch((err) =>
        log.warn('Handler success record failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // 6. Ingest (crawlerIngestionService handles Readability extraction internally)
  const ingestionResult = await crawlerIngestionService.ingestCrawledContent({
    indexId,
    sourceId,
    url,
    htmlContent: content,
    tenantId,
    metadata: {
      crawledAt: new Date().toISOString(),
      domain: new URL(url).hostname,
      quality: qualityLabel,
      qualityScore: qualityResult.score,
    },
    force: !crawlSettings.deduplicate,
  });

  // 7. Update section counts
  if (section && sectionCounts[section.sectionId]) {
    sectionCounts[section.sectionId].completed++;
  }

  // 8. Emit progress events
  await emitUrlFetched(jobId, url, strategy, statusCode, duration, sectionCounts);

  if (ingestionResult.success) {
    await publishProgressEvent({
      type: 'document_processed',
      jobId,
      timestamp: new Date().toISOString(),
      data: {
        url,
        documentId: ingestionResult.documentId,
        quality: qualityLabel,
        score: qualityResult.score,
      },
    });
    return { status: 'success', quality: qualityLabel, usedMcp };
  }

  if (ingestionResult.duplicate) return { status: 'skipped' };
  return { status: 'failed', quality: 'failed' };
}

// HTTP fetch with retry (matching HLD error handling table)
async function fetchWithHttpRetry(
  url: string,
  maxRetries = 2,
): Promise<{ html: string; statusCode: number }> {
  const adapter = getHttpAdapter();
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // HttpAdapter.fetch(url) — single arg, no options (verified signature)
      // Wrap with timeout via Promise.race (matching intelligence-crawl-worker pattern)
      const result = await Promise.race([
        adapter.fetch(url),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Fetch timeout')), PAGE_TIMEOUT_MS),
        ),
      ]);
      if (result.statusCode === 429 && attempt < maxRetries) {
        // 429: exponential backoff 1s → 2s → 4s
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        continue;
      }
      if (result.statusCode >= 500 && attempt < maxRetries) {
        // 5xx: retry with 2s delay
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      return { html: result.html, statusCode: result.statusCode };
    } catch (err) {
      if (attempt === maxRetries) {
        return { html: '', statusCode: 0 };
      }
      // Connection timeout: 1 retry
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  return { html: '', statusCode: 0 };
}

async function emitUrlFetched(
  jobId: string,
  url: string,
  strategy: string,
  statusCode: number,
  duration: number,
  sectionCounts: Record<string, { completed: number; total: number }>,
): Promise<void> {
  await publishProgressEvent({
    type: 'url_fetched',
    jobId,
    timestamp: new Date().toISOString(),
    data: {
      url,
      method: strategy === 'browser' ? 'browser' : 'http',
      statusCode,
      duration,
      sections: Object.entries(sectionCounts).map(([sid, c]) => ({
        sectionId: sid,
        name: sid,
        count: c.completed,
      })),
    },
  });
}
```

### Helper functions:

```typescript
function buildUrlSectionMap(
  urls: string[],
  sectionMapping: BulkCrawlSectionMapping[],
): Map<string, { sectionId: string; strategy: 'http' | 'browser' }> {
  // Build a Set per section for O(1) lookup (bounded: total URLs in job)
  const sectionSets = sectionMapping.map((sm) => ({
    sectionId: sm.sectionId,
    strategy: sm.strategy,
    urlSet: new Set(sm.urls), // Bounded: sm.urls.length per section
  }));
  const map = new Map<string, { sectionId: string; strategy: 'http' | 'browser' }>();
  for (const url of urls) {
    for (const ss of sectionSets) {
      if (ss.urlSet.has(url)) {
        map.set(url, { sectionId: ss.sectionId, strategy: ss.strategy });
        break;
      }
    }
  }
  return map;
}

// Atomic semaphore via Lua script (R1-F1: INCR + EXPIRE race condition)
const SEMAPHORE_LUA = `
  local key = KEYS[1]
  local max = tonumber(ARGV[1])
  local ttl = tonumber(ARGV[2])
  local current = redis.call('INCR', key)
  redis.call('EXPIRE', key, ttl)
  if current > max then
    redis.call('DECR', key)
    return 0
  end
  return 1
`;

async function acquireSemaphore(redis: IORedis, tenantId: string): Promise<void> {
  const key = `${SEMAPHORE_KEY}${tenantId}`;
  for (let attempt = 0; attempt < 30; attempt++) {
    const acquired = await redis.eval(SEMAPHORE_LUA, 1, key, SEMAPHORE_MAX, SEMAPHORE_TTL);
    if (acquired === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Semaphore acquisition timeout');
}

async function releaseSemaphore(redis: IORedis, tenantId: string): Promise<void> {
  const key = `${SEMAPHORE_KEY}${tenantId}`;
  const val = await redis.decr(key);
  // Prevent negative — if val < 0, reset to 0
  if (val < 0) await redis.set(key, '0', 'EX', SEMAPHORE_TTL);
}

// MCP connection lifecycle (D9 — one per job)
async function openMcpConnection(): Promise<any> {
  // Connect to crawler-mcp-server at port 3100 (same pattern as intelligence-crawl-worker)
  // Implementation: MCP client with stdio or HTTP transport to localhost:3100
  // Returns client with callTool(name, params) method
}
```

### Worker registration (workers/index.ts):

Add after intelligence-crawl-worker registration (~line 267):

```typescript
try {
  const { createBulkCrawlWorker } = await import('./bulk-crawl-worker.js');
  const bulkCrawlWorker = createBulkCrawlWorker();
  workers.push({ name: 'bulk-crawl', worker: bulkCrawlWorker });
  log.info('Bulk crawl worker started');
} catch (err) {
  log.warn('Failed to start bulk crawl worker', {
    error: err instanceof Error ? err.message : String(err),
  });
}
```

### Subtasks (execution order)

1. **ST-1.1**: Add `QUEUE_BULK_CRAWL` constant and `BulkCrawlJobData` interface to `shared.ts`
2. **ST-1.2**: Create `bulk-crawl-worker.ts` with:
   - Lazy singletons (HandlerReuser, HandlerStore, HttpAdapter, MCP client, TemplateFingerprinter)
   - `processBulkCrawl()` main processor
   - `processUrl()` per-URL handler
   - Semaphore acquire/release helpers
   - Checkpoint save/load helpers
   - `createBulkCrawlWorker()` factory
3. **ST-1.3**: Register worker in `workers/index.ts` `startWorkers()`
4. **ST-1.4**: Verify: `pnpm build --filter=@agent-platform/search-ai`

### Acceptance Criteria

- AC-1.1: Given a BullMQ job with 10 URLs, the worker processes all 10 with sliding window of 5
  - Verify: Integration test with mock HTTP server, assert all 10 URLs fetched
- AC-1.2: Given a cancel signal in Redis, the worker stops within 1 URL processing cycle
  - Verify: Start 10-URL job, set cancel key after 3 URLs, assert job status 'cancelled' with 3-5 URLs processed
- AC-1.3: Given a crash mid-job, BullMQ retries and the worker skips already-processed URLs via checkpoint
  - Verify: Process 5 URLs, kill worker, restart, assert remaining 5 processed (not 10)
- AC-1.4: Given handler templates exist in MongoDB, the worker seeds HandlerReuser and uses them for extraction
  - Verify: Seed `handler_templates`, process URL, assert handler reuse logged
- AC-1.5: Worker updates CrawlJob status through lifecycle: queued → crawling → completed
  - Verify: Query CrawlJob after completion, assert status transitions and timeline fields

---

## Task T-2: Batch Route Update

### Problem

Batch route enqueues on `static-crawl` (Go worker). Does not forward `sectionMapping` in job data. Does not accept `crawlSettings`. Re-expands URLs via sitemap when not needed. Cancel only updates MongoDB.

### Files to Modify

- `apps/search-ai/src/routes/crawl.ts` — Modify batch handler, cancel handler, queue name

### Function Signatures

#### Queue name change (crawl.ts ~line 189):

```typescript
// BEFORE
function getCrawlQueue(): Queue {
  if (!crawlQueue) {
    crawlQueue = new Queue('static-crawl', { connection: parseRedisUrl(REDIS_URL) });
  }
  return crawlQueue;
}

// AFTER
function getCrawlQueue(): Queue {
  if (!crawlQueue) {
    crawlQueue = new Queue(QUEUE_BULK_CRAWL, { connection: parseRedisUrl(REDIS_URL) });
  }
  return crawlQueue;
}
```

Import `QUEUE_BULK_CRAWL` from `../workers/shared.js`.

#### Batch handler changes (~line 316-885):

**1. Update Zod schema** — add new fields to `crawlSettings`:

```typescript
const crawlSettingsSchema = z.object({
  respectRobotsTxt: z.boolean().optional().default(true),
  crawlDelay: z.number().min(200).max(30000).optional().default(1000),
  maxConcurrent: z.number().min(1).max(10).optional().default(3),
  cleanupLevel: z.enum(['standard', 'aggressive', 'none']).optional().default('standard'),
  deduplicate: z.boolean().optional().default(true),
  cookieConsent: z.boolean().optional().default(true),
  reuseHandlers: z.boolean().optional().default(true),
  documentUrls: z
    .array(
      z.object({
        url: z.string().url(),
        fileType: z.string().min(1),
        processingMethod: z.enum(['docling', 'default']).optional(),
      }),
    )
    .optional(),
});
```

**2. Accept `draftId`** in request body:

```typescript
const { draftId, ...rest } = req.body;
// Validate draftId
const draftIdParsed = draftId ? z.string().min(1).parse(draftId) : undefined;
```

**3. Accept `sectionMapping` with strategy**:

```typescript
const sectionMappingSchema = z
  .array(
    z.object({
      sectionId: z.string().min(1),
      pattern: z.string().min(1),
      name: z.string().min(1),
      urls: z.array(z.string().min(1)),
      strategy: z.enum(['http', 'browser']).optional().default('http'),
    }),
  )
  .optional();
```

**4. Skip sitemap re-expansion** when explicit URLs provided:

```typescript
// BEFORE: if urls.length === 1 && sitemapExists → expand
// AFTER:
if (urls.length === 1 && !sectionMapping?.length) {
  // Only re-expand for single-URL calls without explicit section mapping
  // ... existing sitemap expansion logic
}
```

**5. Forward sectionMapping in queue.add()** (~line 773-830):

```typescript
// CRITICAL FIX: Include sectionMapping in job data
await getCrawlQueue().add(
  'crawl-batch',
  {
    urls,
    strategy: resolvedParams.internalStrategy,
    filters,
    options,
    resolvedStrategy: resolvedParams.internalStrategy,
    batchId: crawlJob._id,
    jobId: crawlJob._id,
    tenantId,
    indexId,
    sourceId,
    userId,
    draftId: draftIdParsed,
    sectionMapping: parsedSectionMapping ?? [], // ← NEW: was missing
    crawlSettings: {
      // ← NEW: full settings
      crawlDelay: parsedSettings.crawlDelay ?? 1000,
      respectRobotsTxt: parsedSettings.respectRobotsTxt ?? true,
      cleanupLevel: parsedSettings.cleanupLevel ?? 'standard',
      deduplicate: parsedSettings.deduplicate ?? true,
      cookieConsent: parsedSettings.cookieConsent ?? true,
      reuseHandlers: parsedSettings.reuseHandlers ?? true,
    },
  },
  {
    jobId: crawlJob._id,
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: { age: 604800 },
    attempts: 3,
    backoff: { type: 'exponential', delay: 60000 },
  },
);
```

**6. Store sectionMapping in CrawlJob** (~line 700-746):

```typescript
// Add to CrawlJob creation:
configuration: {
  ...existingConfig,
  sectionMapping: parsedSectionMapping ?? [],  // ← NEW
},
```

#### Cancel handler changes (~line 2671-2726):

```typescript
// AFTER updating MongoDB status:
// V2: Set Redis cancel signal (use getPendingRedis() — same lazy singleton as rest of crawl.ts)
const redis = getPendingRedis();
await redis.set(`crawl:cancel:${jobId}`, '1', 'EX', 3600);

// V2: Try to remove from BullMQ queue if still queued
try {
  const queueJob = await getCrawlQueue().getJob(jobId);
  if (queueJob) {
    const state = await queueJob.getState();
    if (state === 'waiting' || state === 'delayed') {
      await queueJob.remove();
    }
  }
} catch (err) {
  log.warn('Failed to remove job from queue', {
    jobId,
    error: err instanceof Error ? err.message : String(err),
  });
}
```

### Subtasks (execution order)

1. **ST-2.1**: Import `QUEUE_BULK_CRAWL` from shared, change `getCrawlQueue()` to use new queue name
2. **ST-2.2**: Update Zod schemas — `crawlSettingsSchema` (add `cleanupLevel`, `deduplicate`, `cookieConsent`, `reuseHandlers`), `sectionMappingSchema` (add `strategy`), add `draftId` validation
3. **ST-2.3**: Skip sitemap re-expansion for explicit URL lists (guard with `sectionMapping?.length`)
4. **ST-2.4**: Store `sectionMapping` in CrawlJob.configuration
5. **ST-2.5**: Forward `sectionMapping`, `crawlSettings`, `draftId` in `queue.add()` payload
6. **ST-2.6**: Add BullMQ retry config: `attempts: 3, backoff: { type: 'exponential', delay: 60000 }`
7. **ST-2.7**: Enhance cancel endpoint — Redis signal + BullMQ job removal
8. **ST-2.8**: Verify: `pnpm build --filter=@agent-platform/search-ai`

### Acceptance Criteria

- AC-2.1: Given a batch request with sectionMapping, the BullMQ job data includes sectionMapping
  - Verify: Inspect BullMQ job data after enqueue
- AC-2.2: Given `crawlSettings` in the request, they are forwarded to the worker in job data
  - Verify: Integration test — submit batch, inspect job data
- AC-2.3: Given 200 explicit URLs with sectionMapping, sitemap re-expansion does NOT run
  - Verify: No sitemap fetch logged when sectionMapping provided
- AC-2.4: Given a cancel request, Redis key `crawl:cancel:{jobId}` is set with 1h TTL
  - Verify: `redis.get('crawl:cancel:{jobId}')` returns '1'
- AC-2.5: Given a queued job, cancel removes it from BullMQ queue
  - Verify: `getCrawlQueue().getJob(jobId)` returns null after cancel

---

## Task T-3: Robots.txt + Rate Limiter

### Problem

No runtime robots.txt enforcement during bulk crawl. No per-domain rate limiting. `crawlDelay` setting is accepted but never enforced.

### Files to Create

- `packages/crawler/src/bulk/robots-checker.ts` — Cached robots.txt checker for runtime enforcement
- `packages/crawler/src/bulk/domain-rate-limiter.ts` — Per-domain token bucket rate limiter

### Files to Modify

- `packages/crawler/src/index.ts` — Export new modules
- `apps/search-ai/src/routes/progress.ts` — Add `url_skipped` to ProgressEvent type union

### Function Signatures

#### robots-checker.ts:

```typescript
// Use robots-parser directly (already a packages/crawler dependency)
// Do NOT import from apps/search-ai — that would be a cross-package boundary violation
import robotsParser from 'robots-parser';

export interface RobotsCheckerConfig {
  cacheTtlMs: number; // default 3_600_000 (1 hour)
  maxCacheSize: number; // default 100
  userAgent: string; // default 'ABLBot/1.0'
}

export class RobotsChecker {
  private cache: Map<
    string,
    { parser: ReturnType<typeof robotsParser>; expiresAt: number; crawlDelay: number | null }
  >;

  constructor(config?: Partial<RobotsCheckerConfig>);

  /**
   * Check if a URL is allowed by robots.txt. Fetches and caches per domain.
   * Never throws — returns true (allow) on any error.
   */
  async isAllowed(url: string): Promise<boolean>;

  /**
   * Get the crawl-delay for a domain from robots.txt.
   * Returns null if not specified.
   */
  async getCrawlDelay(url: string): Promise<number | null>;

  /**
   * Preload robots.txt for a domain. Called at job start.
   */
  async preload(domain: string): Promise<void>;

  getStats(): { cacheSize: number; maxSize: number };
}
```

#### domain-rate-limiter.ts:

```typescript
export interface DomainRateLimiterConfig {
  defaultDelayMs: number; // from crawlSettings.crawlDelay
  maxTokens: number; // default 1 (one request at a time per domain)
  refillRateMs: number; // same as defaultDelayMs
}

export class DomainRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly delayMs: number;

  constructor(delayMs: number);

  /**
   * Wait until a token is available. Enforces minimum delay between requests.
   * If robots.txt crawl-delay is higher, uses that instead.
   */
  async acquire(robotsCrawlDelay?: number | null): Promise<void>;

  /**
   * Update the base delay (e.g., after reading robots.txt crawl-delay).
   */
  setDelay(delayMs: number): void;
}
```

#### ProgressEvent type update (progress.ts ~line 22):

Add `'url_skipped'` to the type union:

```typescript
type:
  | 'job_started' | 'url_fetched' | 'url_skipped' | 'document_processed' | ...
```

### Subtasks (execution order)

1. **ST-3.1**: Add `robots-parser` dependency to `packages/crawler/package.json` (verify if already present)
2. **ST-3.2**: Create `packages/crawler/src/bulk/robots-checker.ts` with cached per-domain robots.txt checking
3. **ST-3.3**: Create `packages/crawler/src/bulk/domain-rate-limiter.ts` with token bucket
4. **ST-3.4**: Create `packages/crawler/src/bulk/index.ts` barrel exporting both classes
5. **ST-3.5**: Add `export * from './bulk/index.js'` to `packages/crawler/src/index.ts`
6. **ST-3.6**: Add `'url_skipped'` to `ProgressEvent.type` union in `progress.ts`
7. **ST-3.7**: Add new `data` fields to `ProgressEvent` interface in `progress.ts`: `statusCode?: number`, `duration?: number`, `sections?: Array<{sectionId: string; name: string; count: number}>`, `score?: number`, `skipped?: number`, `comparison?: Record<string, number>`, `handlerReused?: boolean`
8. **ST-3.8**: Verify: `pnpm build --filter=@abl/crawler --filter=@agent-platform/search-ai`

### Acceptance Criteria

- AC-3.1: Given robots.txt blocks `/private/`, when worker checks URL `/private/page1`, it returns `false`
  - Verify: Unit test with mock robots.txt content
- AC-3.2: Given `crawlDelay: 1000ms`, sequential requests are spaced ≥ 1000ms apart
  - Verify: Unit test — 5 acquire() calls, measure timestamps, assert min 1000ms between each
- AC-3.3: Given robots.txt specifies `Crawl-delay: 2000`, and user set `crawlDelay: 500`, the effective delay is 2000ms (max wins)
  - Verify: Unit test with both delays, assert max is used
- AC-3.4: Given robots.txt fetch fails, URL is allowed (permissive default)
  - Verify: Unit test with network error, assert `isAllowed()` returns true

---

## Task T-4: WebSocket Fix + Progress UX

### Problem

`useCrawlProgress` and `useMultiPageProgress` do not send auth token in WS URL. No skipped-URLs section in progress UI.

### Files to Modify

- `apps/studio/src/hooks/useCrawlProgress.ts` — Add `?token=` to WS URL
- `apps/studio/src/hooks/useMultiPageProgress.ts` — Add `?token=` to WS URL
- `apps/studio/src/components/search-ai/crawl-flow/State4Crawl.tsx` — Add skipped URLs section, handle `url_skipped` events

### Function Signatures

#### useCrawlProgress.ts (~line 155):

The hook already destructures `accessToken` from `useAuthStore()` at line 124. Use the existing closure variable (connectRef is reassigned on every render, so closure captures latest token):

```typescript
// BEFORE:
const wsUrl = `${wsProtocol}//${host}/api/search-ai/admin/progress/subscribe?jobId=${jobId}`;

// AFTER (use existing accessToken from hook scope, line 124):
const wsUrl = `${wsProtocol}//${host}/api/search-ai/admin/progress/subscribe?jobId=${jobId}&token=${accessToken}`;
```

#### useMultiPageProgress.ts (~line 353):

Same pattern — use existing `accessToken` from hook scope:

```typescript
// BEFORE:
const wsUrl = `${wsProtocol}//${host}/api/search-ai/admin/progress/subscribe?jobId=${jobId}&type=crawler`;

// AFTER:
const wsUrl = `${wsProtocol}//${host}/api/search-ai/admin/progress/subscribe?jobId=${jobId}&type=crawler&token=${accessToken}`;
```

#### Studio-side type update (useCrawlProgress.ts ~line 12):

Add `url_skipped` to the Studio-side `CrawlProgressEvent` type union (both backend and frontend must agree):

```typescript
// Add to CrawlProgressEvent type union:
| 'url_skipped'
```

#### State4Crawl.tsx — skipped URLs:

Add state tracking for skipped URLs:

```typescript
const [skippedUrls, setSkippedUrls] = useState<Array<{ url: string; reason: string }>>([]);

// In WebSocket message handler, add case for url_skipped:
case 'url_skipped':
  setSkippedUrls(prev => [...prev, { url: event.data.url, reason: event.data.reason }]);
  break;
```

Add skipped URLs display section (after the progress bars):

```typescript
{skippedUrls.length > 0 && (
  <div className="mt-4">
    <span className="text-sm text-muted-foreground">
      {t('crawl.skippedUrls', { count: skippedUrls.length })}
    </span>
    {showSkippedDetails && (
      <ul className="mt-2 text-xs text-muted-foreground">
        {skippedUrls.map((s, i) => (
          <li key={i}>{s.url} — {s.reason}</li>
        ))}
      </ul>
    )}
  </div>
)}
```

### Subtasks (execution order)

1. **ST-4.1**: Fix `useCrawlProgress` WS URL — add `&token=${accessToken}` using existing hook variable
2. **ST-4.2**: Fix `useMultiPageProgress` WS URL — add `&token=${accessToken}` using existing hook variable
3. **ST-4.3**: Add `'url_skipped'` to Studio-side `CrawlProgressEvent` type union in `useCrawlProgress.ts`
4. **ST-4.4**: Add skipped URL tracking state to State4Crawl
5. **ST-4.5**: Add skipped URLs display section to State4Crawl UI
6. **ST-4.6**: Add REST polling fallback: if WS fails after 3 attempts, poll `GET /api/crawl/jobs/:jobId` every 10s with "Live updates unavailable" indicator
7. **ST-4.7**: Add minimize dialog to State4Crawl back button: [Minimize to activity bar] [Cancel crawl] [Stay] (O5)
8. **ST-4.8**: Add i18n keys for skipped URLs messages, polling fallback, minimize dialog
9. **ST-4.9**: Verify: `pnpm build --filter=studio`

### Acceptance Criteria

- AC-4.1: WS URL includes `?token=` parameter with valid auth token
  - Verify: Browser dev tools → Network → WS → URL includes `token=`
- AC-4.2: WS connection succeeds in non-cookie-based auth environments
  - Verify: Clear cookies, rely on token auth, WS events arrive
- AC-4.3: Skipped URLs (robots.txt, dedup) are displayed in progress UI
  - Verify: Crawl with robots.txt blocking some URLs → skipped section appears
- AC-4.4: Given WS fails, progress UI falls back to polling with "refreshing every 10s" indicator
  - Verify: Block WS → polling starts → progress still updates
- AC-4.5: Back button during crawl shows minimize/cancel/stay dialog
  - Verify: Click back during active crawl → dialog appears with 3 options

---

## Task T-5: State 3 Redesign + Config Wiring + Per-Section Strategy (D7, D12, D3)

### Problem

State 3 shows meaningless recursive crawl settings. 6 config settings are not wired. Per-section strategy is lost. Orphan source creation in handleContinue.

### Files to Modify

- `apps/studio/src/components/search-ai/crawl-flow/CrawlFlowV5.tsx` — Remove orphan addSource from handleContinue (D3), wire all settings in handleStartCrawl, propagate strategy in mapGroupsToSections
- `apps/studio/src/components/search-ai/crawl-flow/types.ts` — Add `strategy` to CrawlSection
- `apps/studio/src/api/crawl.ts` — Add `crawlSettings` to `submitBatchCrawl()`, add `strategy` to `SectionMappingEntry`
- `packages/database/src/models/crawl-draft.model.ts` — Add `strategy` to ICrawlDraftSection schema

### Function Signatures

#### types.ts — CrawlSection update:

```typescript
export interface CrawlSection {
  sectionId?: string;
  pattern: string;
  name: string;
  pageCount: number;
  examples: string[];
  included: boolean;
  estimatedTime: string;
  warnings: string[];
  depth: number;
  source?: 'sitemap' | 'explored' | 'auto';
  pages?: Array<{ url: string; title: string }>;
  fileTypeCounts?: Record<string, number>;
  strategy?: 'http' | 'browser'; // ← NEW (D12)
}
```

#### CrawlFlowV5.tsx — mapGroupsToSections (~line 63):

Add strategy propagation:

```typescript
function mapGroupsToSections(
  groups: UrlGroup[],
  strategies: GroupStrategy[],
  urlPath: string,
): CrawlSection[] {
  const strategyMap = new Map(strategies.map(s => [s.pattern, s]));

  return groups.map((g, i) => {
    const matchedStrategy = strategyMap.get(g.pattern);
    return {
      sectionId: `sec-${i}`,
      pattern: g.pattern,
      name: g.pattern || '/',
      pageCount: g.count,
      examples: g.examples,
      included: /* existing smart selection logic */,
      estimatedTime: /* existing calculation */,
      warnings: /* existing warnings */,
      depth: g.depth,
      source: 'sitemap' as const,
      pages: g.examples.map(u => ({ url: u, title: '' })),
      strategy: matchedStrategy?.method === 'playwright' ? 'browser' : 'http',  // ← NEW
    };
  });
}
```

#### CrawlFlowV5.tsx — handleContinue (~line 589):

Remove orphan addSource (D3):

```typescript
const handleContinue = useCallback(() => {
  setFlowState('configure');
  if (draftId) {
    saveDraft({
      flowState: 'configured',
      sections: sectionsToDraftSections(sections),
      discoveryStatus: 'complete',
    });
  }
  // V2 FIX (D3): Removed fire-and-forget addSource call
  // Source is created ONCE in handleStartCrawl (State 4 transition)
}, [draftId, saveDraft, sections]);
```

#### CrawlFlowV5.tsx — handleStartCrawl:

Wire all crawlSettings:

```typescript
const result = await submitBatchCrawl({
  urls: allUrls,
  indexId: indexId!,
  sourceId: source.source._id,
  sectionMapping: includedSections.map((s) => ({
    sectionId: s.sectionId ?? `sec-${includedSections.indexOf(s)}`,
    pattern: s.pattern,
    name: s.name,
    urls: sectionUrls.get(s.sectionId ?? '') ?? s.examples,
    strategy: s.strategy ?? 'http', // ← NEW (D12)
  })),
  crawlSettings: {
    // ← NEW (D7)
    crawlDelay: config.requestDelay,
    respectRobotsTxt: config.respectRobotsTxt,
    cleanupLevel: config.cleanup,
    deduplicate: config.deduplicate,
    cookieConsent: config.cookieConsent,
    reuseHandlers: config.learnedPatterns === 'keep',
  },
  draftId: draftId!, // ← NEW (D10)
  options: { skipPrompts: true },
});
```

#### crawl.ts (Studio API) — submitBatchCrawl:

Add new fields to the API function:

```typescript
export async function submitBatchCrawl(data: {
  urls: string[];
  indexId: string;
  sourceId: string;
  strategy?: string;
  limits?: { maxPages?: number; maxDepth?: number };
  filters?: CrawlFilters;
  sectionMapping?: Array<SectionMappingEntry & { strategy?: 'http' | 'browser' }>;
  crawlSettings?: {
    crawlDelay: number;
    respectRobotsTxt: boolean;
    cleanupLevel: 'standard' | 'aggressive' | 'none';
    deduplicate: boolean;
    cookieConsent: boolean;
    reuseHandlers: boolean;
  };
  draftId?: string;
  options?: Record<string, unknown>;
}): Promise<BatchSubmitResponse>;
```

#### crawl-draft.model.ts — ICrawlDraftSection:

Add `strategy` field:

```typescript
export interface ICrawlDraftSection {
  sectionId: string;
  pattern: string;
  name: string;
  source: 'sitemap' | 'explored' | 'auto';
  depth: number;
  pageCount: number;
  included: boolean;
  estimatedTime: number;
  warnings: string[];
  strategy?: 'http' | 'browser'; // ← NEW (D12)
}
```

And in the Mongoose schema:

```typescript
const CrawlDraftSectionSchema = new Schema(
  {
    // ... existing fields
    strategy: { type: String, enum: ['http', 'browser'], default: 'http' }, // ← NEW
  },
  { _id: false },
);
```

#### CrawlDraftFlowState enum update:

```typescript
// BEFORE: 'profiling' | 'sections_ready' | 'configured' | 'submitted'
// AFTER:
export type CrawlDraftFlowState =
  | 'profiling'
  | 'sections_ready'
  | 'configured'
  | 'submitted'
  | 'completed';
```

### Subtasks (execution order)

1. **ST-5.1**: Add `strategy` to `ICrawlDraftSection` interface and schema in `crawl-draft.model.ts`
2. **ST-5.2**: Add `'completed'` to `CrawlDraftFlowState` enum in `crawl-draft.model.ts`
3. **ST-5.3**: Add `strategy` to `CrawlSection` interface in `types.ts`
4. **ST-5.4**: Update `mapGroupsToSections()` to propagate `GroupStrategy.method` → `CrawlSection.strategy`
5. **ST-5.5**: Remove orphan `addSource()` call in `handleContinue` (D3)
6. **ST-5.6**: Update `submitBatchCrawl()` API function signature — add `crawlSettings`, `draftId`, `strategy` in sectionMapping
7. **ST-5.7**: Wire all crawlSettings in `handleStartCrawl()` — pass `crawlSettings` and `draftId` to `submitBatchCrawl()`
8. **ST-5.8**: Add re-crawl context banner to State 3: query previous CrawlJob by sourceId, display "Last crawled: X days ago (N pages)"
9. **ST-5.9**: Verify: `pnpm build --filter=@agent-platform/database --filter=studio`

### Acceptance Criteria

- AC-5.1: `handleContinue` does NOT call `addSource()` — no orphan source created
  - Verify: Set breakpoint/log, click Continue → no addSource network call
- AC-5.2: `submitBatchCrawl` payload includes all 6 `crawlSettings` fields
  - Verify: Network capture → request body has crawlSettings object
- AC-5.3: Per-section strategy propagates from discovery → draft → batch request
  - Verify: Section with `strategy: 'browser'` in discovery → sectionMapping includes `strategy: 'browser'`
- AC-5.4: `CrawlDraft.flowState = 'completed'` is valid enum value
  - Verify: `pnpm build --filter=@agent-platform/database` passes

---

## Task T-6: Activity Bar Hydration + Resume + KB Banner (D4)

### Problem

Activity bar doesn't hydrate on mount (Zustand store ephemeral). No resume action. No KB banner for active crawls.

### Files to Modify

- `apps/studio/src/components/search-ai/crawl-flow/DiscoveryActivityBar.tsx` — Add mount hydration, resume action
- `apps/studio/src/store/discovery-store.ts` — No changes needed (setItems already exists)
- `apps/studio/src/api/crawl.ts` — Add `getActiveDrafts()` function if not already exported

### Function Signatures

#### DiscoveryActivityBar.tsx — hydration on mount:

```typescript
export function DiscoveryActivityBar({ indexId, onResumeDraft }: DiscoveryActivityBarProps) {
  const { backgroundedItems, setItems, updateItem, removeItem, activePanelDraftId } =
    useDiscoveryStore();

  // V2: Hydrate from server on mount
  useEffect(() => {
    async function hydrate() {
      try {
        const response = await getActiveDrafts(indexId);
        if (response.drafts?.length) {
          const items: BackgroundedDiscovery[] = response.drafts.map((d) => ({
            draftId: d._id,
            domain: d.profile?.domain ?? new URL(d.url).hostname,
            discoveredCount: d.sections?.reduce((sum, s) => sum + s.pageCount, 0) ?? 0,
            sectionCount: d.sections?.length ?? 0,
            status: d.flowState === 'submitted' ? 'running' : 'complete',
            ownerName: '', // Not available from API
            ownerId: d.userId ?? '',
            isOwner: true, // Current user's drafts
            type: d.crawlJobId ? 'crawl' : 'discovery',
            jobId: d.crawlJobId ?? undefined,
            crawlProgress: d.crawlJob
              ? {
                  crawled: d.crawlJob.urls?.crawled ?? 0,
                  total: d.crawlJob.urls?.original?.length ?? 0,
                  failed: d.crawlJob.urls?.failed ?? 0,
                }
              : undefined,
          }));
          setItems(items);
        }
      } catch {
        // Best effort — activity bar is a convenience feature
      }
    }
    hydrate();
  }, [indexId, setItems]);

  // ... existing render logic
}
```

#### Resume action:

In the activity bar item renderer, add resume handling:

```typescript
// For items where type === 'crawl' and status is not 'running'
<Button
  variant="ghost"
  size="sm"
  onClick={() => onResumeDraft?.(item.draftId)}
>
  {t('crawl.resume')}
</Button>
```

The `onResumeDraft` callback in the parent component (`CrawlFlowV5.tsx` or KB detail) should:

1. Read draft via `GET /api/crawl/drafts/:draftId`
2. Read CrawlJob via `GET /api/crawl/jobs/:jobId` (if crawlJobId present)
3. Open CrawlFlowV5 at the appropriate state based on job status:
   - `queued` → State 4 (waiting)
   - `crawling` → State 4 (live WS)
   - `completed` → done state (show results)
   - `failed` → configure state (allow re-crawl)
   - `cancelled` → configure state (allow re-crawl)

#### crawl.ts API — extend existing `getActiveDrafts`:

The function already exists at line 1354 as `getActiveDrafts(indexId: string): Promise<ActiveDraft[]>`.
The existing `ActiveDraft` interface (line 1340) has: `{ draftId, domain, discoveredCount, sectionCount, discoveryStatus, createdBy, isOwner, updatedAt }`.

**Extend** the interface (do not redefine):

```typescript
// Add to existing ActiveDraft interface:
export interface ActiveDraft {
  // ... existing fields
  flowState?: string; // V2: 'submitted' | 'completed' etc.
  crawlJobId?: string; // V2: for crawl items
  crawlJob?: {
    // V2: populated from backend join
    status: string;
    urls: { crawled: number; total: number; failed: number };
  };
  type?: 'discovery' | 'crawl'; // V2: distinguish discovery vs crawl items
}
```

The existing function uses `apiFetch()` + `handleResponse()` pattern — no changes needed to the function body, only to the interface and backend response shape.

### Backend changes needed

The existing `GET /api/crawl/drafts/active` endpoint (crawl-drafts.ts ~line 298) currently filters by `discoveryStatus: { $in: ['running', 'complete'] }`. V2 needs it to also return drafts with `flowState: 'submitted'` (active crawls). Modify the query:

```typescript
// BEFORE:
{ tenantId, indexId, discoveryStatus: { $in: ['running', 'complete'] }, updatedAt: { $gt: oneHourAgo } }

// AFTER:
{
  tenantId, indexId,
  $or: [
    { discoveryStatus: { $in: ['running', 'complete'] }, updatedAt: { $gt: oneHourAgo } },
    { flowState: 'submitted' }, // Active crawls — no time filter (crawls can run for hours)
  ]
}
```

Also populate CrawlJob data for submitted drafts:

```typescript
// For drafts with crawlJobId, fetch job status
for (const draft of drafts) {
  if (draft.crawlJobId) {
    const CrawlJob = getModel('CrawlJob');
    const job = await CrawlJob.findOne({ _id: draft.crawlJobId, tenantId }, 'status urls timeline');
    if (job) {
      draft.crawlJob = { urls: job.urls, status: job.status };
    }
  }
}
```

### Subtasks (execution order)

1. **ST-6.1**: Update `GET /api/crawl/drafts/active` query to include `flowState: 'submitted'` drafts via `$or`
2. **ST-6.2**: Update `.select()` projection to include `flowState`, `crawlJobId`, `sourceId`
3. **ST-6.3**: Add CrawlJob data population for drafts with `crawlJobId`
4. **ST-6.4**: Extend `ActiveDraft` interface in Studio `crawl.ts` with V2 fields (flowState, crawlJobId, crawlJob, type)
5. **ST-6.5**: Add mount hydration `useEffect` to `DiscoveryActivityBar`
6. **ST-6.6**: Add resume button to activity bar items
7. **ST-6.7**: Implement resume logic in parent component (read draft → read job → open at correct state)
8. **ST-6.8**: Add KB detail page banner for active crawls: "Crawl in progress: 45/226 pages [View Progress]"
9. **ST-6.9**: Add i18n keys for resume UI and KB banner
10. **ST-6.10**: Verify: `pnpm build --filter=@agent-platform/search-ai --filter=studio`

### Acceptance Criteria

- AC-6.1: Page refresh → activity bar shows running crawls (hydrated from server)
  - Verify: Start crawl → refresh page → activity bar visible with progress
- AC-6.2: Resume action reopens crawl flow at correct state
  - Verify: Click Resume on completed crawl → opens at done state with results
- AC-6.3: Active drafts endpoint returns both discovery and crawl drafts
  - Verify: API call returns drafts with `flowState: 'submitted'` and their CrawlJob status
- AC-6.4: KB detail page shows banner when crawl is active
  - Verify: Start crawl → navigate to KB detail → banner visible with progress count

---

## Task T-7: Re-crawl Support (O8)

### Problem

No re-crawl comparison summary. No "Re-crawl Failed Only". No stale document detection.

### Files to Modify

- `apps/search-ai/src/workers/bulk-crawl-worker.ts` — Add comparison logic, stale detection
- `packages/database/src/models/search-document.model.ts` — Add `staleAt` field

### Function Signatures

#### search-document.model.ts — staleAt field:

Add to ISearchDocument interface:

```typescript
staleAt?: Date | null;  // Set when document is marked stale during re-crawl
```

Add to schema:

```typescript
staleAt: { type: Date, default: null },
```

Add TTL index:

```typescript
SearchDocumentSchema.index(
  { staleAt: 1 },
  {
    expireAfterSeconds: 30 * 24 * 60 * 60, // 30 days
    partialFilterExpression: { staleAt: { $type: 'date' } },
  },
);
```

#### bulk-crawl-worker.ts — re-crawl comparison:

Add to `processBulkCrawl()` finally block, before terminal event:

```typescript
// Re-crawl comparison
let comparison: { newDocuments: number; changedDocuments: number; deletedDocuments: number; unchangedDocuments: number } | undefined;

if (sourceId) {
  const CrawlJobModel = getLazyModel<ICrawlJob>('CrawlJob');
  const previousJob = await CrawlJobModel.findOne(
    { sourceId, tenantId, status: 'completed', _id: { $ne: jobId } },
    null,
    { sort: { 'timeline.completedAt': -1 } },
  );

  if (previousJob) {
    const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');

    // Mark stale: URLs in previous crawl but not in current
    const currentUrlSet = new Set(urls);
    const previousUrls = previousJob.urls?.expanded ?? previousJob.urls?.original ?? [];
    const staleUrls = previousUrls.filter(u => !currentUrlSet.has(u));

    if (staleUrls.length > 0) {
      await SearchDocument.updateMany(
        { tenantId, indexId, sourceId, originalReference: { $in: staleUrls }, staleAt: null },
        { $set: { staleAt: new Date(), status: 'stale' } },
      );
    }

    comparison = {
      newDocuments: /* count docs created this job with no previous version */,
      changedDocuments: /* count docs updated (same URL, different hash) */,
      deletedDocuments: staleUrls.length,
      unchangedDocuments: /* count docs skipped (same hash) */,
    };

    // Store comparison in CrawlJob
    await CrawlJobModel.updateOne(
      { _id: jobId, tenantId },
      { $set: { comparison: { ...comparison, previousJobId: previousJob._id } } },
    );
  }
}
```

### Subtasks (execution order)

1. **ST-7.1**: Add `staleAt` field to `ISearchDocument` interface and schema
2. **ST-7.2**: Add `'stale'` to `ISearchDocument.status` type (or widen to accept it) — Mongoose schema uses String so MongoDB accepts it, but TypeScript needs it
3. **ST-7.3**: Add TTL index on `staleAt` with 30-day expiry and partial filter
4. **ST-7.4**: Add `unchangedDocuments` to `CrawlJob.comparison` sub-schema (Mongoose strict:true will silently drop it otherwise — per `packages/database/agents.md` 2026-04-16)
5. **ST-7.5**: Add re-crawl comparison logic to bulk-crawl-worker finally block
6. **ST-7.6**: Add stale document marking (URLs in previous crawl but not current)
7. **ST-7.7**: Store comparison in CrawlJob.comparison field
8. **ST-7.8**: Include comparison in `job_completed` progress event
9. **ST-7.9**: **Frontend**: Add "Re-crawl Failed Only" button to State 3 re-crawl context, with logic to read `CrawlJob.urls.errors[]` from previous job and filter sectionMapping
10. **ST-7.10**: Verify: `pnpm build --filter=@agent-platform/database --filter=@agent-platform/search-ai --filter=studio`

### Acceptance Criteria

- AC-7.1: Given a re-crawl, documents from previous crawl not in current are marked `staleAt` with current date
  - Verify: Query SearchDocument collection → stale docs have `staleAt` set
- AC-7.2: Stale documents auto-delete after 30 days via TTL index
  - Verify: MongoDB index exists with `expireAfterSeconds: 2592000`
- AC-7.3: CrawlJob.comparison is populated with new/changed/deleted/unchanged counts
  - Verify: Query CrawlJob after re-crawl → comparison object present
- AC-7.4: job_completed event includes comparison data for re-crawls
  - Verify: WS event includes `data.comparison` field

---

## Task T-8: CrawlJob TTL + Cleanup

### Problem

CrawlJobs are unbounded — accumulate forever. No archival.

### Files to Modify

- `packages/database/src/models/crawl-job.model.ts` — Add TTL index on `timeline.completedAt`

### Database/Model Changes

Add TTL index:

```typescript
CrawlJobSchema.index(
  { 'timeline.completedAt': 1 },
  {
    expireAfterSeconds: 90 * 24 * 60 * 60, // 90 days
    partialFilterExpression: {
      'timeline.completedAt': { $type: 'date' },
      status: { $in: ['completed', 'failed', 'cancelled'] },
    },
  },
);
```

This ensures:

- Only terminal jobs (completed/failed/cancelled) are eligible for TTL
- Running jobs (queued/crawling/ingesting) are never deleted (no `completedAt` field)
- 90 days provides enough history for re-crawl comparison

### Subtasks (execution order)

1. **ST-8.1**: Add TTL index to CrawlJob schema
2. **ST-8.2**: Verify: `pnpm build --filter=@agent-platform/database`

### Acceptance Criteria

- AC-8.1: TTL index exists on `timeline.completedAt` with 90-day expiry
  - Verify: `CrawlJobSchema.indexes()` includes the TTL index
- AC-8.2: Running jobs are not eligible for TTL deletion (no completedAt field)
  - Verify: Job with status 'crawling' and no completedAt → not matched by partial filter

---

## Task T-9: Remove Go Crawler Path (O9)

### Problem

Go crawler is broken and being replaced. Dead code should be removed after Node.js replacement is verified.

### Files to Modify

- `apps/search-ai/src/routes/crawl.ts` — Remove Go-specific code paths
- `apps/search-ai/src/routes/crawler-ingestion.ts` — Mark as deprecated (keep for draining)
- `apps/search-ai/src/workers/crawler-ingestion-worker.ts` — Mark as deprecated

### Files to Remove (after verification)

- Docker references to Go crawler image
- `static-crawl` queue references (replaced by `bulk-crawl`)

### Subtasks (execution order)

1. **ST-9.1**: Identify all Go crawler references (`static-crawl`, `crawl-batch` job name, `crawler-ingestion` route)
2. **ST-9.2**: Add deprecation comments to Go-related code
3. **ST-9.3**: Remove `static-crawl` queue creation (replaced by `bulk-crawl` in T-2)
4. **ST-9.4**: Remove Go Docker image references from docker-compose files
5. **ST-9.5**: Verify no in-flight Go jobs before removing
6. **ST-9.6**: Verify: `pnpm build --filter=@agent-platform/search-ai`

### Acceptance Criteria

- AC-9.1: No references to `static-crawl` queue in active code paths
  - Verify: `grep -r 'static-crawl' apps/search-ai/src/` returns only deprecated comments
- AC-9.2: Go crawler Docker image no longer started in docker-compose
  - Verify: `docker-compose config` does not include Go crawler service
- AC-9.3: Existing crawls complete normally after Go code removal
  - Verify: Start a crawl after removal → completes successfully via Node.js worker

---

## Cross-Task Contracts

### T-0 → T-1: URL data

- T-0 stores full URLs in `CrawlDraftUrlBucket` docs
- T-1 receives URLs in `BulkCrawlJobData.urls[]` (read by Studio from buckets, sent via batch request)

### T-1 → T-2: Job data interface

- T-1 defines `BulkCrawlJobData` in `shared.ts`
- T-2 constructs job data matching this interface in `queue.add()`

### T-1 → T-3: Robots + rate limiter

- T-1 imports `RobotsChecker` and `DomainRateLimiter` from `@abl/crawler`
- T-3 creates these classes in `packages/crawler/src/bulk/`

### T-1 → T-7: Re-crawl comparison

- T-1 provides the finally block where T-7 adds comparison logic
- T-7 adds `staleAt` to SearchDocument which T-1's ingestion pipeline writes

### T-2 → T-1: Queue name

- T-2 changes `getCrawlQueue()` to use `QUEUE_BULK_CRAWL`
- T-1 creates worker on `QUEUE_BULK_CRAWL`

### T-5 → T-2: Request payload

- T-5 wires `crawlSettings` + `draftId` + `strategy` in `submitBatchCrawl()` call
- T-2 accepts and validates these fields in the batch route

### T-5 → T-0: Strategy field

- T-5 adds `strategy` to `CrawlSection` and `ICrawlDraftSection`
- T-0's bucket storage doesn't need strategy (URLs are per-section, strategy is on the section)

### T-6 → T-1: Draft completion

- T-6 hydrates activity bar for `flowState: 'submitted'` drafts
- T-1 updates `flowState: 'completed'` when job finishes (D10)

---

## Execution Waves

```
Wave 0 (foundation — all independent, parallel):
  T-0  Full URL storage         → search-ai routes, studio CrawlFlowV5
  T-3  Robots + rate limiter    → packages/crawler (new files)
  T-8  CrawlJob TTL             → packages/database (index only)

Wave 1 (parallel — after Wave 0):
  T-1  Bulk crawl worker        → search-ai workers (new file)
  T-5  State 3 + config wiring  → studio CrawlFlowV5, types, API; database model

Wave 2 (parallel — after Wave 1):
  T-2  Batch route update       → search-ai routes
  T-4  WebSocket fix            → studio hooks, State4Crawl
  T-6  Activity bar + resume    → studio DiscoveryActivityBar; search-ai crawl-drafts

Wave 3 (after Wave 2):
  T-7  Re-crawl support         → search-ai worker, database SearchDocument

Wave 4 (after all verified):
  T-9  Remove Go path           → cleanup
```

### File Overlap Analysis

| File                         | Tasks                                                                               | Conflict?                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `CrawlFlowV5.tsx`            | T-0 (handleStartCrawl), T-5 (handleContinue, mapGroupsToSections, handleStartCrawl) | **YES** — T-0 and T-5 both modify handleStartCrawl. T-5 depends on T-0 (Wave 1 after Wave 0). |
| `crawl.ts` (search-ai route) | T-0 (cluster-urls), T-2 (batch, cancel)                                             | No — different endpoints                                                                      |
| `crawl.ts` (studio API)      | T-0 (clusterUrls call), T-5 (submitBatchCrawl)                                      | No — different functions                                                                      |
| `crawl-draft.model.ts`       | T-5 (strategy), T-8 (no — CrawlJob not CrawlDraft)                                  | No overlap                                                                                    |
| `State4Crawl.tsx`            | T-4 (skipped URLs)                                                                  | Solo                                                                                          |
| `bulk-crawl-worker.ts`       | T-1 (create), T-7 (re-crawl logic)                                                  | T-7 depends on T-1 (Wave 3 after Wave 1). Sequential.                                         |
| `search-document.model.ts`   | T-7 (staleAt)                                                                       | Solo                                                                                          |
| `progress.ts`                | T-3 (url_skipped type)                                                              | Solo                                                                                          |

All overlaps are handled by wave ordering — no parallel conflicts.

---

## Audit Resolution Log

Findings from 5-round LLD audit. All CRITICAL and HIGH items resolved.

### Mongoose strict:true Schema Fixes (R5-F1 — CRITICAL)

Per `packages/database/agents.md` 2026-04-16: Mongoose `strict: true` silently drops `$set` fields not in schema.

**CrawlJob model** (`crawl-job.model.ts`) — add these fields:

1. `configuration.sectionMapping` — Array sub-schema: `[{ sectionId: String, pattern: String, name: String, strategy: { type: String, enum: ['http', 'browser'] }, urls: [String] }]`
2. `results.metering` — Sub-schema: `{ httpPages: Number, browserPages: Number, totalPages: Number }`
3. `comparison.unchangedDocuments` — Add `unchangedDocuments: Number` to existing comparison sub-schema

These MUST be added in T-2 (ST-2.4) and T-7 (ST-7.4) respectively, or the worker's `$set` will silently lose data.

### Event Type Resolution (R4-F1 — CRITICAL)

**Decision**: Reuse existing `job_started` / `job_completed` event types (not `bulk_crawl_started` / `bulk_crawl_complete`). Rationale: `useCrawlProgress` already handles `job_started` and `job_completed`. Creating new types would require updating the hook's event handler. The HLD types are aspirational — the actual integration uses the established types.

**Action**: Update HLD to remove `bulk_crawl_started` / `bulk_crawl_complete` from the event type list (post-LLD doc sync).

### ProgressEvent Data Interface (R5-F2 — HIGH)

New fields to add to `ProgressEvent.data` in `progress.ts` (done in T-3 ST-3.7):

- `statusCode?: number`
- `duration?: number`
- `sections?: Array<{sectionId: string; name: string; count: number}>`
- `score?: number`
- `skipped?: number`
- `comparison?: Record<string, number>`
- `handlerReused?: boolean`
- `skipReason?: string`

### Enum Value Alignment (R5-F3 — HIGH)

- `method` field: Worker emits `'http' | 'browser'`. Existing V6 type uses `'http' | 'playwright'`. **Fix**: Widen to `'http' | 'playwright' | 'browser'` (backward compatible).
- `quality` field: Worker emits `'good' | 'thin' | 'failed'`. Existing V6 type uses `'rich' | 'standard' | 'thin'`. **Fix**: Add `'good' | 'failed'` to the union (backward compatible).

### REST Polling Fallback (R4-F3 — CRITICAL)

**Endpoint**: Use existing `GET /api/crawl/jobs/:jobId` (verified in `crawl.ts` route). This returns CrawlJob status including `urls.crawled`, `urls.failed`, `status`. No new endpoint needed.

### Edit Sections Link (R4-F6 — HIGH)

Add to T-5 subtasks: ST-5.8b — "Edit Sections" link in State 3 summary that transitions back to State 2 (`setFlowState('analyzing')`) with sections preserved in draft.

### Swallowed Catches (R1-F2/F3/F4, R5-F5)

All `.catch(() => {})` changed to `.catch(err => log.warn(...))` with structured error messages. Applies to:

- T-1: `releaseSemaphore`, MCP close
- T-6: Activity bar hydration (already has try/catch with comment — add log.warn)

### BullMQ Priority (R4-F8 — HIGH)

Add `priority` to queue.add() in T-2: `priority: Math.min(urls.length, 10)` — smaller jobs get higher priority (lower number = higher priority). This prevents large crawls from blocking small ones.

### Handler Reuse Observable (R4-F13 — MEDIUM)

Add `handlerReused: boolean` to `document_processed` event data in T-1 `processUrl`. This enables test scenario Journey 11.1 verification.

### Concurrent Crawls (R4-F14 — MEDIUM)

BullMQ `concurrency: 1` means one job per worker process. Multiple concurrent crawls run on separate worker processes (SearchAI scales horizontally). The semaphore (20 slots per tenant) bounds total concurrent fetches across all workers.
