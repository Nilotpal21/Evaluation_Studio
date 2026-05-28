/**
 * Bulk Crawl Worker
 *
 * BullMQ worker that processes bulk crawl jobs — high-throughput page
 * fetching with section-aware routing, robots.txt respect, rate limiting,
 * quality gating, handler reuse, and Redis-based checkpointing.
 *
 * Processing model:
 *   - Sliding window of WINDOW_SIZE concurrent fetches
 *   - Per-tenant semaphore (max SEMAPHORE_MAX concurrent pages across jobs)
 *   - Cancel signal via Redis key
 *   - Time-based checkpointing (every 15s)
 *   - Quality gate scoring — always ingest, mark thin
 *   - Handler template seeding from MongoDB at job start
 *   - MCP two-step for browser strategy sections
 */

import { Worker, type Job } from 'bullmq';
import { createHash } from 'crypto';
import type { RedisClient } from '@agent-platform/redis';
import { runLuaScript, type LuaScript } from '@agent-platform/redis';
import type {
  ICrawlJob,
  ICrawlError,
  IHandlerTemplate,
  ISearchDocument,
} from '@agent-platform/database/models';
import { classifyCrawlError, sanitizeErrorMessage } from '@abl/crawler';
import { MCPClient, createLogger, type MCPTextContent } from '@abl/compiler/platform';
import {
  RobotsChecker,
  DomainRateLimiter,
  HandlerReuser,
  TemplateFingerprinter,
  MongoHandlerStore,
  QualityGate,
  HttpAdapter,
  type IHandlerStore,
  type HandlerTemplateModel,
} from '@abl/crawler';
import {
  getRedisConnection,
  createWorkerOptions,
  workerLog,
  workerError,
  QUEUE_BULK_CRAWL,
  type BulkCrawlJobData,
  type BulkCrawlSectionMapping,
} from './shared.js';
import { getLazyModel } from '../db/index.js';
import { publishProgressEvent, type ProgressEvent } from '../routes/progress.js';
import { crawlerIngestionService } from '../services/ingestion/crawler-ingestion.js';

const log = createLogger('bulk-crawl-worker');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Sliding window concurrency for fetches */
const WINDOW_SIZE = 5;

/** Per-page timeout (60s) */
const PAGE_TIMEOUT_MS = 60_000;

/** Redis key prefix for cancel signal */
const CANCEL_CHECK_KEY = 'crawl:cancel:';

/** Redis key prefix for checkpoints */
const CHECKPOINT_KEY = 'crawl:checkpoint:';

/** Checkpoint TTL — 3 hours */
const CHECKPOINT_TTL = 10_800;

/** Redis key prefix for per-tenant semaphore */
const SEMAPHORE_KEY = 'crawl:tenant-sem:';

/** Max concurrent pages per tenant across all jobs */
const SEMAPHORE_MAX = 20;

/** Semaphore TTL in seconds */
const SEMAPHORE_TTL = 120;

/** Time-based checkpoint interval (15s) */
const CHECKPOINT_INTERVAL_MS = 15_000;

/** MCP server URL */
const MCP_SERVER_URL = process.env.CRAWLER_MCP_URL || 'http://localhost:3100';

// =============================================================================
// REDIS SEMAPHORE LUA SCRIPT
// =============================================================================

const SEMAPHORE_LUA_SCRIPT: LuaScript = {
  name: 'bulk-crawl-semaphore',
  body: `
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
`,
  numberOfKeys: 1,
};

// =============================================================================
// LAZY SINGLETONS
// =============================================================================

const fingerprinter = new TemplateFingerprinter();
let handlerReuser: HandlerReuser | null = null;
let handlerStore: IHandlerStore | null = null;
let qualityGate: QualityGate | null = null;
let httpAdapter: HttpAdapter | null = null;
let redisInstance: RedisClient | null = null;

function getHandlerReuser(): HandlerReuser {
  if (!handlerReuser) {
    handlerReuser = new HandlerReuser(fingerprinter);
  }
  return handlerReuser;
}

function getHandlerStore(): IHandlerStore {
  if (!handlerStore) {
    const HandlerTemplate = getLazyModel<IHandlerTemplate>('HandlerTemplate');
    handlerStore = new MongoHandlerStore(HandlerTemplate as unknown as HandlerTemplateModel);
  }
  return handlerStore;
}

function getQualityGate(): QualityGate {
  if (!qualityGate) qualityGate = new QualityGate();
  return qualityGate;
}

function getHttpAdapter(): HttpAdapter {
  if (!httpAdapter) httpAdapter = new HttpAdapter();
  return httpAdapter;
}

function getRedis(): RedisClient {
  if (!redisInstance) {
    redisInstance = getRedisConnection();
  }
  return redisInstance;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Extract text from MCP tool result content blocks */
function extractMcpText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c): c is MCPTextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

/** Find which section a URL belongs to */
function findSectionForUrl(
  url: string,
  sectionMapping: BulkCrawlSectionMapping[],
): BulkCrawlSectionMapping | undefined {
  return sectionMapping.find((s) => s.urls.includes(url));
}

/** Acquire tenant semaphore slot. Returns true if acquired. */
async function acquireSemaphore(redis: RedisClient, tenantId: string): Promise<boolean> {
  const key = `${SEMAPHORE_KEY}${tenantId}`;
  const result = await runLuaScript<number>(
    redis,
    SEMAPHORE_LUA_SCRIPT,
    [key],
    [SEMAPHORE_MAX, SEMAPHORE_TTL],
  );
  return result === 1;
}

/** Release tenant semaphore slot. */
async function releaseSemaphore(redis: RedisClient, tenantId: string): Promise<void> {
  const key = `${SEMAPHORE_KEY}${tenantId}`;
  await redis.decr(key);
}

/** Check if this job has been cancelled. */
async function isCancelled(redis: RedisClient, jobId: string): Promise<boolean> {
  const val = await redis.get(`${CANCEL_CHECK_KEY}${jobId}`);
  return val !== null;
}

// =============================================================================
// SINGLE URL PROCESSOR
// =============================================================================

interface ProcessUrlResult {
  success: boolean;
  skipped: boolean;
  /** True when ingestion succeeded by dedup (existing doc matched) */
  isDuplicate?: boolean;
  /** Outcome from ingestion: new, updated, or unchanged */
  outcome?: 'new' | 'updated' | 'unchanged';
  quality?: 'rich' | 'standard' | 'thin';
  qualityScore?: number;
  handlerReused?: boolean;
  documentId?: string;
  error?: string;
  statusCode?: number;
}

async function processUrl(
  url: string,
  jobData: BulkCrawlJobData,
  section: BulkCrawlSectionMapping | undefined,
  robotsChecker: RobotsChecker,
  rateLimiter: DomainRateLimiter,
  mcpClient: MCPClient | null,
  redis: RedisClient,
): Promise<ProcessUrlResult> {
  const { jobId, tenantId, indexId, sourceId, crawlSettings, forceReprocess } = jobData;

  // 1. Robots.txt check
  if (crawlSettings.respectRobotsTxt) {
    const allowed = await robotsChecker.isAllowed(url);
    if (!allowed) {
      return { success: false, skipped: true };
    }
  }

  // 2. Rate limiting
  const robotsDelay = crawlSettings.respectRobotsTxt
    ? await robotsChecker.getCrawlDelay(url)
    : null;
  await rateLimiter.acquire(robotsDelay);

  // 3. Determine strategy for this URL
  const strategy = section?.strategy ?? 'http';

  let rawHtml = '';
  let rawText = '';

  if (strategy === 'browser' && mcpClient) {
    // MCP two-step: navigate + get_page_content
    const navResult = await mcpClient.callTool('navigate', { url });
    if (!navResult) {
      return { success: false, skipped: false, error: 'MCP navigate failed' };
    }

    const contentResult = await mcpClient.callTool('get_page_content', {
      includeHtml: true,
      includeText: true,
    });
    const contentText = extractMcpText(contentResult.content);
    try {
      const parsed = JSON.parse(contentText);
      if (parsed?.html) rawHtml = parsed.html;
      if (parsed?.text) rawText = parsed.text;
    } catch {
      rawHtml = contentText;
      rawText = contentText;
    }
  } else {
    // HTTP fetch via HttpAdapter (single-arg)
    const fetchResult = await Promise.race([
      getHttpAdapter().fetch(url),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Page fetch timeout')), PAGE_TIMEOUT_MS),
      ),
    ]);

    if (!fetchResult.success || !fetchResult.crawlResult) {
      return {
        success: false,
        skipped: false,
        error: fetchResult.error ?? 'HTTP fetch failed',
        statusCode: fetchResult.statusCode,
      };
    }
    rawHtml = fetchResult.crawlResult.html;
    rawText = fetchResult.crawlResult.text;
  }

  // 4. Quality gate — always ingest, mark thin (D8)
  const qg = getQualityGate();
  const qualityResult = qg.score(rawHtml, rawText);

  // 5. Handler reuse check
  let handlerReused = false;
  if (crawlSettings.reuseHandlers) {
    const reuser = getHandlerReuser();
    const reuseResult = reuser.tryReuse(rawHtml);
    if (reuseResult.matched) {
      handlerReused = true;
    }
  }

  // 6. Ingest via CrawlerIngestionService
  const domain = new URL(url).hostname;
  const ingestionResult = await crawlerIngestionService.ingestCrawledContent({
    indexId,
    sourceId,
    url,
    htmlContent: rawHtml,
    tenantId,
    force: forceReprocess ?? false,
    metadata: {
      crawlJobId: jobId,
      crawledAt: new Date().toISOString(),
      domain,
      handlerReused,
      sectionId: section?.sectionId,
      sectionName: section?.name,
      qualityScore: qualityResult.score,
      quality: qualityResult.quality,
      method: section?.strategy === 'browser' ? 'playwright' : 'http',
    },
  });

  if (!ingestionResult.success && !ingestionResult.duplicate) {
    return {
      success: false,
      skipped: false,
      error: ingestionResult.error?.message ?? 'Ingestion failed',
    };
  }

  return {
    success: true,
    skipped: false,
    isDuplicate: !!ingestionResult.duplicate,
    outcome: ingestionResult.outcome,
    quality: qualityResult.quality,
    qualityScore: qualityResult.score,
    handlerReused,
    documentId: ingestionResult.documentId ?? ingestionResult.duplicate?.documentId,
  };
}

// =============================================================================
// MAIN PROCESSOR
// =============================================================================

export async function processBulkCrawl(job: Job<BulkCrawlJobData>): Promise<void> {
  const {
    jobId,
    tenantId,
    indexId,
    sourceId,
    urls,
    sectionMapping,
    crawlSettings,
    forceReprocess,
  } = job.data;

  const redis = getRedis();
  let mcpClient: MCPClient | null = null;
  const robotsChecker = new RobotsChecker();
  const rateLimiter = new DomainRateLimiter(crawlSettings.crawlDelay);

  // Section progress tracking
  const sectionCounts = new Map<string, { completed: number; failed: number; total: number }>();
  for (const section of sectionMapping) {
    sectionCounts.set(section.sectionId, {
      completed: 0,
      failed: 0,
      total: section.urls.length,
    });
  }

  let crawledCount = 0;
  let newDocumentCount = 0;
  let unchangedCount = 0;
  let updatedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let httpPages = 0;
  let browserPages = 0;
  let lastCheckpointTime = Date.now();

  try {
    // 1. Update CrawlJob status → 'crawling'
    const CrawlJob = getLazyModel<ICrawlJob>('CrawlJob');
    await CrawlJob.findOneAndUpdate(
      { _id: jobId, tenantId },
      {
        status: 'crawling',
        'timeline.startedAt': new Date(),
        'configuration.sectionMapping': sectionMapping.map((s) => ({
          sectionId: s.sectionId,
          pattern: s.pattern,
          name: s.name,
          strategy: s.strategy,
          urls: s.urls,
        })),
      },
    );

    // 2. Preload robots.txt for all domains
    if (crawlSettings.respectRobotsTxt) {
      const domains = new Set(
        urls
          .map((u) => {
            try {
              return new URL(u).hostname;
            } catch {
              return '';
            }
          })
          .filter(Boolean),
      );
      for (const domain of domains) {
        await robotsChecker.preload(domain);
      }
    }

    // 3. Seed handler reuser from MongoDB (D14)
    if (crawlSettings.reuseHandlers) {
      const reuser = getHandlerReuser();
      const store = getHandlerStore();
      const domains = new Set(
        urls
          .map((u) => {
            try {
              return new URL(u).hostname;
            } catch {
              return '';
            }
          })
          .filter(Boolean),
      );
      for (const domain of domains) {
        try {
          const storedHandlers = await store.findByDomain(tenantId, domain);
          for (const sh of storedHandlers) {
            const fp = TemplateFingerprinter.fromSerializable({
              fingerprint: sh.fingerprint,
              tagPathCount: 0,
            });
            reuser.registerHandler(fp.fingerprint, sh.handler, sh.trainedOn);
          }
        } catch (err) {
          log.warn('Failed to seed handler reuser from store', {
            domain,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 4. Connect MCP if any section uses browser strategy
    const hasBrowserSections = sectionMapping.some((s) => s.strategy === 'browser');
    if (hasBrowserSections) {
      mcpClient = new MCPClient({
        name: 'bulk-crawl-worker',
        transport: 'http',
        url: MCP_SERVER_URL,
        ssrfOptions: { allowLocalhost: true },
        autoReconnect: false,
        requestTimeoutMs: 30_000,
      });
      await mcpClient.connect();
    }

    // 5. Emit started event
    await publishProgressEvent({
      type: 'job_started',
      jobId,
      timestamp: new Date().toISOString(),
      data: {
        totalPages: urls.length,
        sections: sectionMapping.map((s) => ({
          sectionId: s.sectionId,
          name: s.name,
          count: s.urls.length,
        })),
        progress: { total: urls.length, completed: 0, failed: 0, percentage: 0 },
      },
    });

    // 6. Process URLs in sliding window
    const processedUrls = new Set<string>();
    let urlIndex = 0;

    while (urlIndex < urls.length) {
      // Cancel check
      if (await isCancelled(redis, jobId)) {
        log.info('Job cancelled', { jobId });
        break;
      }

      // Build window batch
      const batch: string[] = [];
      while (batch.length < WINDOW_SIZE && urlIndex < urls.length) {
        const url = urls[urlIndex];
        urlIndex++;
        if (processedUrls.has(url)) continue;
        processedUrls.add(url);

        // Check Redis checkpoint
        const urlHash = createHash('sha256').update(url).digest('hex').slice(0, 16);
        const cpKey = `${CHECKPOINT_KEY}${tenantId}:${jobId}:${urlHash}`;
        const existingCp = await redis.get(cpKey);
        if (existingCp) {
          try {
            const cp = JSON.parse(existingCp);
            if (cp.status === 'ingested') {
              crawledCount++;
              continue;
            }
          } catch {
            // Invalid checkpoint, reprocess
          }
        }

        // Layer 2: check SearchDocument
        const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
        const existingDoc = await SearchDocument.findOne({
          tenantId,
          indexId,
          originalReference: url,
          'sourceMetadata.crawlJobId': jobId,
        }).lean();
        if (existingDoc) {
          crawledCount++;
          continue;
        }

        batch.push(url);
      }

      if (batch.length === 0) continue;

      // Process batch concurrently with semaphore
      const results = await Promise.allSettled(
        batch.map(async (url) => {
          // Acquire semaphore
          let semaphoreAcquired = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            semaphoreAcquired = await acquireSemaphore(redis, tenantId);
            if (semaphoreAcquired) break;
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          if (!semaphoreAcquired) {
            log.warn('Failed to acquire semaphore after retries', { url, jobId, tenantId });
            return {
              url,
              result: {
                success: false,
                skipped: true,
                error: 'Semaphore timeout',
              } as ProcessUrlResult,
            };
          }

          try {
            const section = findSectionForUrl(url, sectionMapping);
            const result = await processUrl(
              url,
              job.data,
              section,
              robotsChecker,
              rateLimiter,
              mcpClient,
              redis,
            );
            return { url, result, section };
          } finally {
            await releaseSemaphore(redis, tenantId).catch((err: unknown) => {
              log.warn('Failed to release semaphore', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }),
      );

      // Process results
      for (let idx = 0; idx < results.length; idx++) {
        const settled = results[idx];
        if (settled.status === 'rejected') {
          failedCount++;
          const errMsg =
            settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
          log.error('URL processing promise rejected', { jobId, error: errMsg });

          // Persist crawl error (best-effort non-blocking)
          try {
            const batchUrl = batch[idx];
            const CrawlErrorModel = getLazyModel<ICrawlError>('CrawlError');
            await CrawlErrorModel.create({
              tenantId,
              crawlJobId: jobId,
              url: batchUrl ?? 'unknown',
              type: classifyCrawlError(errMsg),
              error: sanitizeErrorMessage(errMsg),
              timestamp: new Date(),
            });
          } catch (persistErr) {
            log.warn('Failed to persist crawl error for rejected promise', {
              jobId,
              error: persistErr instanceof Error ? persistErr.message : String(persistErr),
            });
          }
          continue;
        }

        const { url, result, section } = settled.value;
        const urlHash = createHash('sha256').update(url).digest('hex').slice(0, 16);
        const cpKey = `${CHECKPOINT_KEY}${tenantId}:${jobId}:${urlHash}`;

        if (result.skipped) {
          skippedCount++;

          // Persist blocked URL as CrawlError (best-effort non-blocking)
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
          } catch (persistErr) {
            log.warn('Failed to persist crawl error for blocked URL', {
              url,
              jobId,
              error: persistErr instanceof Error ? persistErr.message : String(persistErr),
            });
          }

          await publishProgressEvent({
            type: 'url_skipped',
            jobId,
            timestamp: new Date().toISOString(),
            data: {
              url,
              skipReason: 'robots.txt',
              progress: {
                total: urls.length,
                completed: crawledCount,
                failed: failedCount,
                percentage:
                  urls.length > 0
                    ? Math.round(((crawledCount + failedCount + skippedCount) / urls.length) * 100)
                    : 0,
              },
            },
          });
          continue;
        }

        if (result.success) {
          if (result.outcome === 'unchanged') {
            unchangedCount++;
          } else {
            crawledCount++;
            if (result.outcome === 'updated') updatedCount++;
            else if (!result.isDuplicate) newDocumentCount++;
            const sectionStrategy = section?.strategy ?? 'http';
            if (sectionStrategy === 'http') httpPages++;
            else browserPages++;
          }

          // Update section counts
          if (section) {
            const sc = sectionCounts.get(section.sectionId);
            if (sc) sc.completed++;
          }

          // Set checkpoint
          await redis.setex(cpKey, CHECKPOINT_TTL, JSON.stringify({ status: 'ingested' }));

          // Emit progress
          await publishProgressEvent({
            type: 'url_fetched',
            jobId,
            timestamp: new Date().toISOString(),
            data: {
              url,
              qualityScore: result.qualityScore,
              quality: result.quality,
              method: section?.strategy === 'browser' ? 'playwright' : 'http',
              handlerReused: result.handlerReused,
              documentId: result.documentId,
              progress: {
                total: urls.length,
                completed: crawledCount,
                failed: failedCount,
                percentage:
                  urls.length > 0
                    ? Math.round(((crawledCount + failedCount + skippedCount) / urls.length) * 100)
                    : 0,
              },
            },
          });
        } else {
          failedCount++;

          // Update section counts
          if (section) {
            const sc = sectionCounts.get(section.sectionId);
            if (sc) sc.failed++;
          }

          // Persist crawl error (best-effort non-blocking)
          const errorType = classifyCrawlError(result.error ?? 'Unknown error', result.statusCode);
          try {
            const CrawlErrorModel = getLazyModel<ICrawlError>('CrawlError');
            await CrawlErrorModel.create({
              tenantId,
              crawlJobId: jobId,
              url,
              type: errorType,
              error: sanitizeErrorMessage(result.error ?? 'Unknown error'),
              statusCode: result.statusCode,
              timestamp: new Date(),
            });
          } catch (persistErr) {
            log.warn('Failed to persist crawl error', {
              url,
              jobId,
              error: persistErr instanceof Error ? persistErr.message : String(persistErr),
            });
          }

          await publishProgressEvent({
            type: 'url_fetched',
            jobId,
            timestamp: new Date().toISOString(),
            data: {
              url,
              status: 'failed',
              error: { message: result.error ?? 'Processing failed' },
              errorType,
              progress: {
                total: urls.length,
                completed: crawledCount,
                failed: failedCount,
                percentage:
                  urls.length > 0
                    ? Math.round(((crawledCount + failedCount + skippedCount) / urls.length) * 100)
                    : 0,
              },
            },
          });
        }
      }

      // Time-based checkpoint: update CrawlJob progress
      if (Date.now() - lastCheckpointTime > CHECKPOINT_INTERVAL_MS) {
        await CrawlJob.findOneAndUpdate(
          { _id: jobId, tenantId },
          {
            'urls.crawled': crawledCount,
            'urls.failed': failedCount,
            'urls.blocked': skippedCount,
            'urls.unchanged': unchangedCount,
          },
        );
        lastCheckpointTime = Date.now();
      }
    }

    // 7. Compute qualityMetrics from SearchDocuments (non-blocking, 5s timeout)
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
    } catch (qmErr) {
      log.warn('Failed to compute qualityMetrics', {
        jobId,
        error: qmErr instanceof Error ? qmErr.message : String(qmErr),
      });
    }

    // 8. Determine final status
    const cancelled = await isCancelled(redis, jobId);
    // A recrawl with all pages unchanged has crawledCount=0 but unchangedCount>0
    // — that's a successful completion, not a failure.
    const finalStatus = cancelled
      ? 'cancelled'
      : crawledCount > 0 || unchangedCount > 0
        ? 'completed'
        : 'failed';

    // 9. Update CrawlJob to terminal status
    await CrawlJob.findOneAndUpdate(
      { _id: jobId, tenantId },
      {
        status: finalStatus,
        'timeline.completedAt': new Date(),
        'urls.crawled': crawledCount,
        'urls.failed': failedCount,
        'urls.blocked': skippedCount,
        'urls.unchanged': unchangedCount,
        'results.documentsCreated': newDocumentCount,
        'results.qualityMetrics': qualityMetrics,
        'results.metering': {
          httpPages,
          browserPages,
          totalPages: httpPages + browserPages,
        },
      },
    );

    // 10. Re-crawl comparison (O8) — mark stale docs and compute diff metrics
    let comparison:
      | {
          newDocuments: number;
          changedDocuments: number;
          deletedDocuments: number;
          unchangedDocuments: number;
        }
      | undefined;

    if (sourceId) {
      try {
        const previousJob = await CrawlJob.findOne(
          { sourceId, tenantId, status: 'completed', _id: { $ne: jobId } },
          null,
          { sort: { 'timeline.completedAt': -1 } },
        );

        if (previousJob) {
          const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');

          // Mark stale: URLs in previous crawl but not in current
          const currentUrlSet: Record<string, true> = {};
          for (const u of urls) {
            currentUrlSet[u] = true;
          }
          const previousUrls = previousJob.urls?.expanded?.length
            ? previousJob.urls.expanded
            : (previousJob.urls?.original ?? []);
          const staleUrls = previousUrls.filter((u: string) => !currentUrlSet[u]);

          if (staleUrls.length > 0) {
            await SearchDocument.updateMany(
              {
                tenantId,
                indexId,
                sourceId,
                'sourceMetadata.url': { $in: staleUrls },
                staleAt: null,
              },
              { $set: { staleAt: new Date() } },
            );
          }

          // Count comparison metrics
          const previousCrawled = previousJob.urls?.crawled ?? 0;

          comparison = {
            newDocuments: Math.max(0, crawledCount - previousCrawled),
            changedDocuments: 0, // Content hash comparison deferred to future iteration
            deletedDocuments: staleUrls.length,
            unchangedDocuments: Math.max(
              0,
              crawledCount - Math.max(0, crawledCount - previousCrawled),
            ),
          };

          // Store comparison in CrawlJob
          await CrawlJob.updateOne(
            { _id: jobId, tenantId },
            {
              $set: {
                comparison: { ...comparison, previousJobId: previousJob._id },
              },
            },
          );
        }
      } catch (err) {
        log.warn('Re-crawl comparison failed', {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 11. Emit terminal event
    const terminalType = cancelled
      ? 'job_failed'
      : crawledCount > 0
        ? 'job_completed'
        : 'job_failed';
    await publishProgressEvent({
      type: terminalType as ProgressEvent['type'],
      jobId,
      timestamp: new Date().toISOString(),
      data: {
        progress: {
          total: urls.length,
          completed: crawledCount,
          failed: failedCount,
          percentage:
            urls.length > 0
              ? Math.round(((crawledCount + failedCount + skippedCount) / urls.length) * 100)
              : 0,
        },
        ...(cancelled ? { error: { message: 'Crawl cancelled by user', code: 'CANCELLED' } } : {}),
        ...(crawledCount === 0 && !cancelled
          ? { error: { message: 'No pages could be crawled', code: 'ZERO_PAGES' } }
          : {}),
        summary: {
          totalPages: urls.length,
          completed: crawledCount,
          failed: failedCount,
          skipped: skippedCount,
          httpPages,
          browserPages,
        },
        sections: Array.from(sectionCounts.entries()).map(([sectionId, counts]) => ({
          sectionId,
          name: sectionMapping.find((s) => s.sectionId === sectionId)?.name ?? sectionId,
          count: counts.completed,
        })),
        comparison: comparison ?? undefined,
      },
    });

    // 12. Clean up checkpoint keys (best-effort).
    // Cluster-safe: checkpoint keys span URL hashes (different slots), so a
    // single pipeline would CROSSSLOT. Issue independent DELs in parallel —
    // ioredis Cluster routes each to its owning master.
    try {
      await Promise.all(
        urls.map((url) => {
          const urlHash = createHash('sha256').update(url).digest('hex').slice(0, 16);
          return redis.del(`${CHECKPOINT_KEY}${tenantId}:${jobId}:${urlHash}`);
        }),
      );
    } catch (err) {
      log.warn('Failed to clean up checkpoint keys', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 13. Draft Elimination: post-crawl cleanup
    // Delete transient wizard data (SourceConfigState + SourceUrlBucket),
    // clear wizardStep and configExpiresAt on the source.
    try {
      const [SourceConfigState, SourceUrlBucket, SearchSource] = [
        getLazyModel('SourceConfigState'),
        getLazyModel('SourceUrlBucket'),
        getLazyModel('SearchSource'),
      ];
      await Promise.all([
        SourceConfigState.deleteMany({ sourceId, tenantId }),
        SourceUrlBucket.deleteMany({ sourceId, tenantId }),
        SearchSource.updateOne(
          { _id: sourceId, tenantId },
          {
            $set: {
              'crawlConfig.wizardStep': null,
              'crawlConfig.configExpiresAt': null,
            },
          },
        ),
      ]);
    } catch (err) {
      log.warn('Failed post-crawl cleanup of wizard data', {
        sourceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    workerLog('bulk-crawl', 'Bulk crawl completed', {
      jobId,
      crawled: crawledCount,
      failed: failedCount,
      skipped: skippedCount,
      httpPages,
      browserPages,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error('Bulk crawl job failed', { jobId, error: errMsg });

    // Update CrawlJob to failed
    const CrawlJob = getLazyModel<ICrawlJob>('CrawlJob');
    await CrawlJob.findOneAndUpdate(
      { _id: jobId, tenantId },
      {
        status: 'failed',
        'timeline.completedAt': new Date(),
        'urls.crawled': crawledCount,
        'urls.failed': failedCount,
      },
    ).catch((updateErr: unknown) => {
      log.warn('Failed to update CrawlJob on error', {
        error: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
    });

    await publishProgressEvent({
      type: 'job_failed',
      jobId,
      timestamp: new Date().toISOString(),
      data: {
        error: { message: 'Bulk crawl failed' },
        progress: {
          total: urls.length,
          completed: crawledCount,
          failed: failedCount,
          percentage: urls.length > 0 ? Math.round((crawledCount / urls.length) * 100) : 0,
        },
      },
    }).catch((pubErr: unknown) => {
      log.warn('Failed to publish failure event', {
        error: pubErr instanceof Error ? pubErr.message : String(pubErr),
      });
    });

    throw err; // Let BullMQ handle retry
  } finally {
    // Always cleanup MCP
    if (mcpClient) {
      await mcpClient.disconnect().catch((err: unknown) => {
        log.warn('Failed to disconnect MCP client', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
}

// =============================================================================
// WORKER CREATION
// =============================================================================

let bulkCrawlWorker: Worker | null = null;

export function createBulkCrawlWorker(): Worker {
  const options = createWorkerOptions(1); // One job at a time

  const w = new Worker<BulkCrawlJobData>(QUEUE_BULK_CRAWL, processBulkCrawl, {
    ...options,
    lockDuration: 3_600_000, // 60 min
    lockRenewTime: 300_000, // 5 min
    stalledInterval: 3_600_000,
  });

  w.on('completed', (j) => workerLog('bulk-crawl', `Job ${j.id} completed`));
  w.on('failed', (j, err) => workerError('bulk-crawl', `Job ${j?.id} failed`, err));
  w.on('error', (err) => workerError('bulk-crawl', 'Worker error', err));

  bulkCrawlWorker = w;
  workerLog('bulk-crawl', 'Bulk crawl worker started', {
    queue: QUEUE_BULK_CRAWL,
    concurrency: 1,
  });

  return w;
}

export function getBulkCrawlWorker(): Worker | null {
  return bulkCrawlWorker;
}
