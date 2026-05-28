/**
 * @deprecated V2: Go crawler replaced by Node.js bulk-crawl worker.
 * This worker remains for draining in-flight Go jobs on the 'content-processing' queue.
 *
 * Crawler Ingestion Worker
 *
 * Consumes crawl results from the Go crawler worker and ingests them into SearchAI.
 *
 * Flow:
 * 1. Go worker publishes BatchResult to 'content-processing' queue
 * 2. This worker consumes from 'content-processing'
 * 3. For each CrawlResult, call CrawlerIngestionService (DIRECT access, no HTTP)
 * 4. Service handles: Readability → S3 → MongoDB → BullMQ
 * 5. Track success/failure metrics
 *
 * Architecture Benefits:
 * - Direct access (S3, MongoDB, BullMQ) - no HTTP timeouts
 * - Decouples crawling (Go) from ingestion (Node.js)
 * - Async processing with retry support
 * - Integration with Docling extraction pipeline
 * - Full tenant isolation
 * - Readability removes noise (ads, navigation, footers)
 */

import { Worker, Job } from 'bullmq';
import { createWorkerOptions, workerLog, workerError, withTraceContext } from './shared.js';
import { crawlerIngestionService } from '../services/ingestion/crawler-ingestion.js';
import { publishProgressEvent } from '../routes/progress.js';
import { getModel } from '../db/index.js';
import { writeCrawlAuditEvent } from '../services/crawl-audit.service.js';

/**
 * Process items in batches with controlled concurrency.
 * Each batch runs in parallel via Promise.allSettled, batches run sequentially.
 */
async function processBatch<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map((item, batchIndex) => processor(item, i + batchIndex)),
    );
    results.push(...batchResults);
  }
  return results;
}

const INGESTION_BATCH_SIZE = 5;

function getCrawlModels() {
  return {
    CrawlJob: getModel('CrawlJob'),
    CrawlHistory: getModel('CrawlHistory'),
    SearchDocument: getModel('SearchDocument'),
  };
}

function getModels() {
  return getCrawlModels();
}

// =============================================================================
// TYPES (matching Go worker types/job.go)
// =============================================================================

interface CrawlResult {
  url: string;
  statusCode: number;
  title: string;
  html?: string;
  text: string;
  links: Array<{ text: string; href: string; title?: string; rel?: string; target?: string }>;
  metadata: Record<string, string>;
  crawledAt: string; // ISO timestamp
  duration: number; // milliseconds
  success: boolean;
  error?: string;
  contentLength: number;
  contentType: string;
}

interface BatchResult {
  jobId: string;
  batchId: string;
  results: CrawlResult[];
  totalUrls: number;
  successful: number;
  failed: number;
  duration: number; // milliseconds
  completedAt: string; // ISO timestamp
  tenantId: string;
  indexId: string;
  sourceId: string;
}

/**
 * Job data for crawler ingestion worker
 */
interface CrawlerIngestionJobData extends BatchResult {}

// =============================================================================
// PER-RESULT PROCESSING
// =============================================================================

interface ProcessOneContext {
  indexId: string;
  sourceId: string;
  tenantId: string;
  batchId: string;
  totalResults: number;
}

/**
 * Process a single crawl result: validate, ingest, handle duplicates.
 * Returns a structured result for aggregation — does NOT update progress or counters.
 */
async function processOneResult(
  result: CrawlResult,
  context: ProcessOneContext,
  models: ReturnType<typeof getCrawlModels>,
): Promise<{
  url: string;
  success: boolean;
  documentId?: string;
  error?: string;
  isDuplicate?: boolean;
}> {
  const { indexId, sourceId, tenantId, batchId } = context;

  workerLog('crawler-ingestion', `Ingesting ${result.url}`, {
    success: result.success,
    hasHtml: !!result.html,
    contentLength: result.html?.length || 0,
  });

  // Skip failed crawls or crawls without HTML
  if (!result.success || !result.html || result.html.length === 0) {
    workerLog('crawler-ingestion', `✗ Skipped ${result.url}`, {
      reason: result.error || 'No HTML content',
    });
    return {
      url: result.url,
      success: false,
      error: result.error || 'No HTML content available',
    };
  }

  // Ingest using shared service (handles Readability, S3, MongoDB, BullMQ)
  let domain = '';
  try {
    domain = new URL(result.url).hostname;
  } catch {}
  const ingestionResult = await crawlerIngestionService.ingestCrawledContent({
    indexId,
    sourceId,
    url: result.url,
    htmlContent: result.html,
    tenantId,
    metadata: {
      crawledAt: result.crawledAt,
      domain,
      siteType: (result.metadata.siteType as 'static' | 'spa' | 'hybrid' | 'unknown') || 'unknown',
      profileConfidence: result.metadata.profileConfidence
        ? parseFloat(result.metadata.profileConfidence)
        : undefined,
      jsRequired: result.metadata.jsRequired === 'true',
      title: result.title,
      contentLength: result.contentLength,
      contentType: result.contentType,
      crawlDuration: result.duration,
      crawlJobId: batchId,
    },
    force: false,
  });

  if (ingestionResult.success) {
    workerLog('crawler-ingestion', `✓ Ingested ${result.url}`, {
      documentId: ingestionResult.documentId,
      readability: ingestionResult.metadata?.readability,
    });
    return {
      url: result.url,
      success: true,
      documentId: ingestionResult.documentId,
    };
  }

  // Handle duplicate case (not actually an error)
  if (ingestionResult.error?.code === 'DUPLICATE_CONTENT') {
    const dupDocId = ingestionResult.duplicate?.documentId;
    workerLog('crawler-ingestion', `⊙ Duplicate ${result.url}`, {
      documentId: dupDocId,
    });

    // Link duplicate document to this crawl job so pages/dashboard queries work
    if (dupDocId) {
      try {
        const { SearchDocument } = models;
        await SearchDocument.findOneAndUpdate(
          { _id: dupDocId, tenantId },
          { $set: { 'sourceMetadata.crawlJobId': batchId } },
        );
      } catch (linkErr) {
        workerError('crawler-ingestion', 'Failed to link duplicate to crawl job', linkErr);
      }
    }

    return {
      url: result.url,
      success: true,
      documentId: dupDocId,
      isDuplicate: true,
    };
  }

  // Actual failure
  workerLog('crawler-ingestion', `✗ Failed to ingest ${result.url}`, {
    error: ingestionResult.error?.message,
  });
  return {
    url: result.url,
    success: false,
    error: ingestionResult.error?.message || 'Unknown error',
  };
}

// =============================================================================
// WORKER
// =============================================================================

/**
 * Process crawler ingestion job: ingest all crawled URLs from a batch
 */
async function processCrawlerIngestion(job: Job<CrawlerIngestionJobData>): Promise<{
  ingested: number;
  failed: number;
  errors: Array<{ url: string; error: string }>;
}> {
  return withTraceContext(job.data as unknown as Record<string, unknown>, async () => {
    const { jobId, batchId, results, indexId, sourceId, tenantId } = job.data;
    const { CrawlJob, CrawlHistory } = getCrawlModels();

    workerLog('crawler-ingestion', `Processing batch ${batchId}`, {
      jobId,
      batchId,
      results: results.length,
      indexId,
      sourceId,
      tenantId,
    });

    // Update CrawlJob status to 'ingesting' (atomic to prevent race conditions)
    try {
      const crawlJob = await CrawlJob.findOneAndUpdate(
        { _id: batchId, status: { $in: ['queued', 'crawling'] } },
        { $set: { status: 'ingesting', 'timeline.startedAt': new Date() } },
        { new: true },
      );
      if (crawlJob) {
        await writeCrawlAuditEvent({
          tenantId,
          crawlJobId: batchId,
          eventType: 'crawl.completed',
          description: `Crawl completed, starting ingestion of ${results.length} URLs`,
          context: {
            strategy: crawlJob.strategy,
            urls: results.length,
          },
          severity: 'info',
        });

        // Initialize CrawlHistory if it doesn't exist
        const history = await CrawlHistory.findOne({ crawlJobId: batchId });
        if (!history) {
          const newHistory = new CrawlHistory({
            tenantId,
            crawlJobId: batchId,
            statuses: [
              {
                timestamp: crawlJob.timeline.submittedAt,
                status: 'queued',
                phase: 'queued',
              },
              {
                timestamp: new Date(),
                status: 'ingesting',
                phase: 'ingesting',
              },
            ],
            documentStatusChanges: [],
            performance: [],
          });
          await newHistory.save();
        }

        workerLog('crawler-ingestion', `CrawlJob status updated to 'ingesting'`, { batchId });
      }
    } catch (historyError) {
      workerError('crawler-ingestion', 'Failed to update CrawlJob status', historyError);
    }

    let ingested = 0;
    let failed = 0;
    const errors: Array<{ url: string; error: string }> = [];

    // Process crawl results in parallel batches
    const batchResults = await processBatch(results, INGESTION_BATCH_SIZE, async (result) =>
      processOneResult(
        result,
        { indexId, sourceId, tenantId, batchId, totalResults: results.length },
        getModels(),
      ),
    );

    // Aggregate results
    for (const settled of batchResults) {
      if (settled.status === 'fulfilled') {
        const r = settled.value;
        if (r.success || r.isDuplicate) {
          ingested++;
        } else {
          failed++;
          if (r.error) {
            errors.push({ url: r.url, error: r.error });
          }
        }
      } else {
        // Promise rejection — unexpected error
        failed++;
        const errMsg =
          settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        errors.push({ url: 'unknown', error: errMsg });
      }
    }

    // Report final progress
    await job.updateProgress({
      processed: ingested + failed,
      total: results.length,
      ingested,
      failed,
    });

    // Publish final progress event
    await publishProgressEvent({
      type: 'document_processed',
      jobId: batchId,
      timestamp: new Date().toISOString(),
      data: {
        url: 'batch-complete',
        progress: {
          total: results.length,
          completed: ingested + failed,
          failed,
          percentage: 100,
        },
      },
    });

    workerLog('crawler-ingestion', `Batch ${batchId} completed`, {
      ingested,
      failed,
      totalResults: results.length,
    });

    // Update CrawlJob with final ingestion results (atomic to prevent race conditions)
    try {
      const updateDoc: Record<string, unknown> = {
        $set: {
          'urls.crawled': results.length,
          'urls.failed': failed,
          'results.documentsCreated': ingested,
          'results.documentsFailed': failed,
        },
      };

      // Add errors atomically if any
      if (errors.length > 0) {
        const errorEntry = {
          timestamp: new Date(),
          phase: 'ingest' as const,
          message: `Failed to ingest ${failed} URLs`,
          count: failed,
          sample: errors
            .slice(0, 5)
            .map((e) => `${e.url}: ${e.error}`)
            .join('; '),
        };
        (updateDoc as Record<string, unknown>).$push = { processingErrors: errorEntry };
      }

      // Mark as 'failed' if zero documents were ingested, 'completed' otherwise
      const finalStatus = ingested === 0 ? 'failed' : 'completed';
      (updateDoc.$set as Record<string, unknown>).status = finalStatus;
      (updateDoc.$set as Record<string, unknown>)['timeline.completedAt'] = new Date();

      if (ingested === 0) {
        const failEntry = {
          timestamp: new Date(),
          phase: 'ingest' as const,
          message:
            results.length === 0
              ? 'Crawler returned 0 results — possible crash or timeout in Go worker'
              : `All ${results.length} crawled URLs failed ingestion`,
          count: failed,
          sample: errors
            .slice(0, 5)
            .map((e) => `${e.url}: ${e.error}`)
            .join('; '),
        };
        if ((updateDoc as Record<string, unknown>).$push) {
          (
            (updateDoc as Record<string, unknown>).$push as Record<string, unknown>
          ).processingErrors = failEntry;
        } else {
          (updateDoc as Record<string, unknown>).$push = { processingErrors: failEntry };
        }
      }

      const crawlJob = await CrawlJob.findOneAndUpdate(
        { _id: batchId, status: 'ingesting' },
        updateDoc,
        { new: true },
      );
      if (crawlJob) {
        // Update CrawlHistory atomically with $push
        await CrawlHistory.findOneAndUpdate(
          { crawlJobId: batchId },
          {
            $push: {
              statuses: {
                timestamp: new Date(),
                status: finalStatus,
                phase: finalStatus,
                metrics: {
                  urlsCrawled: results.length,
                  documentsCreated: ingested,
                },
              },
            },
          },
        );

        workerLog('crawler-ingestion', `CrawlJob results updated`, {
          batchId,
          ingested,
          failed,
          finalStatus,
        });

        // Publish job_failed event so the UI reflects the actual failure
        if (finalStatus === 'failed') {
          await publishProgressEvent({
            type: 'job_failed',
            jobId: batchId,
            timestamp: new Date().toISOString(),
            data: {
              error: {
                message:
                  results.length === 0
                    ? 'Crawler returned 0 results'
                    : `All ${results.length} crawled URLs failed ingestion`,
                code: 'CRAWL_ZERO_INGESTED',
              },
            },
          });
        }
      }
    } catch (historyError) {
      workerError('crawler-ingestion', 'Failed to update CrawlJob results', historyError);
    }

    return { ingested, failed, errors };
  });
}

// =============================================================================
// WORKER INITIALIZATION
// =============================================================================

let worker: Worker | null = null;

/**
 * Start the crawler ingestion worker
 */
export async function startCrawlerIngestionWorker(concurrency = 3): Promise<void> {
  if (worker) {
    workerLog('crawler-ingestion', 'Worker already running');
    return;
  }

  const options = createWorkerOptions(concurrency);

  worker = new Worker<CrawlerIngestionJobData>('content-processing', processCrawlerIngestion, {
    ...options,
    // Crawler ingestion can take time (S3 uploads, Readability processing)
    lockDuration: 120000, // 2 min lock (was 60s)
    lockRenewTime: 60000, // Renew every 1 min
  });

  worker.on('completed', (job, result) => {
    workerLog('crawler-ingestion', `Job ${job.id} completed`, result);
  });

  worker.on('failed', async (job, error) => {
    if (job) {
      workerError('crawler-ingestion', `Job ${job.id} failed`, error);

      // Update CrawlJob status and publish job_failed event
      const batchId = job.data.batchId;
      if (batchId) {
        try {
          const { CrawlJob } = getCrawlModels();
          const crawlJob = await CrawlJob.findOneAndUpdate(
            { _id: batchId, status: { $ne: 'failed' } },
            {
              $set: { status: 'failed', 'timeline.completedAt': new Date() },
              $push: {
                processingErrors: {
                  timestamp: new Date(),
                  phase: 'ingest',
                  message: error instanceof Error ? error.message : String(error),
                  count: 1,
                },
              },
            },
            { new: true },
          );
          if (crawlJob) {
            // Publish job_failed event
            await publishProgressEvent({
              type: 'job_failed',
              jobId: batchId,
              timestamp: new Date().toISOString(),
              data: {
                error: {
                  message: error instanceof Error ? error.message : String(error),
                  code: 'CRAWL_FAILED',
                },
              },
            });
          }
        } catch (err) {
          workerError('crawler-ingestion', 'Failed to update job failure status', err);
        }
      }
    } else {
      workerError('crawler-ingestion', 'Job failed (no job object)', error);
    }
  });

  worker.on('error', (error) => {
    workerError('crawler-ingestion', 'Worker error', error);
  });

  workerLog('crawler-ingestion', 'Crawler ingestion worker started', {
    concurrency,
    queue: 'content-processing',
  });
}

/**
 * Stop the crawler ingestion worker
 */
export async function stopCrawlerIngestionWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    workerLog('crawler-ingestion', 'Crawler ingestion worker stopped');
  }
}

export function getWorker(): Worker | null {
  return worker;
}
