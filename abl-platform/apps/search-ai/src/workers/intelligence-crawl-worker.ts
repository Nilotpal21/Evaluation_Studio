/**
 * Intelligence Crawl Worker
 *
 * BullMQ worker that processes multi-page intelligence crawl jobs.
 * For each discovered URL:
 *   1. Try handler reuse (0 LLM calls) via template fingerprinting
 *   2. If no match + budget available, run full intelligence loop (2+ LLM calls)
 *   3. Ingest extracted content via CrawlerIngestionService
 *   4. Track progress via WS events and CrawlJob updates
 *
 * Crash recovery:
 *   - Layer 1: Redis checkpoints per URL (survives worker restart)
 *   - Layer 2: SearchDocument existence check (survives Redis flush)
 *
 * Resource management:
 *   - Per-tenant distributed lock (only one crawl per tenant)
 *   - LLM budget enforcement (maxLlmCalls)
 *   - Job timeout (60 min)
 *   - MCP client cleanup in finally block
 */

import { Worker, type Job } from 'bullmq';
import { createHash } from 'crypto';
import type { RedisClient } from '@agent-platform/redis';
import { QUEUE_INTELLIGENCE_CRAWL } from '@agent-platform/search-ai-sdk';
import type {
  ICrawlJob,
  ICrawlError,
  IHandlerTemplate,
  ISearchDocument,
} from '@agent-platform/database/models';
import { WorkerLLMClient } from '@agent-platform/llm';
import { MCPClient, createLogger, type MCPTextContent } from '@abl/compiler/platform';
import * as cheerio from 'cheerio';
import {
  CrawlIntelligenceService,
  HandlerReuser,
  TemplateFingerprinter,
  MongoHandlerStore,
  QualityGate,
  HttpAdapter,
  FailureScorer,
  LinkScorer,
  PaginationDetector,
  InteractiveDetector,
  JsonLdExtractor,
  IntentDecomposer,
  type IHandlerStore,
  type HandlerTemplateModel,
  type OnProgressCallback,
  type HttpFetchResult,
  type CrawlResultLink,
  classifyCrawlError,
  sanitizeErrorMessage,
} from '@abl/crawler';
import {
  createWorkerOptions,
  workerLog,
  workerError,
  type IntelligenceCrawlJobData,
  type GroupStrategy,
} from './shared.js';
import { getSharedRedisClient } from './shared.js';
import { getLazyModel } from '../db/index.js';
import { publishProgressEvent } from '../routes/progress.js';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';
import { resolveTenantModelWithFallback } from '../services/llm-config/tenant-model-adapter.js';
import { crawlerIngestionService } from '../services/ingestion/crawler-ingestion.js';
import { isURLAllowed } from '../utils/ssrf-protection.js';
import { createFileStorage } from '../storage/storage-factory.js';
import { getConfig } from '../config/index.js';

const log = createLogger('intelligence-crawl-worker');

/** Extract text from MCP tool result content blocks */
function extractMcpText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c): c is MCPTextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Max time for a page going through the full intelligence loop (2 min) */
const PAGE_TIMEOUT_FULL = 120_000;

/** Max time for the entire job (60 min) */
const JOB_TIMEOUT = 3_600_000;

/** Redis checkpoint TTL — 3 hours, covers retries */
const CHECKPOINT_TTL = 10_800;

/** MCP server URL */
const MCP_SERVER_URL = process.env.CRAWLER_MCP_URL || 'http://localhost:3100';

/** Max new links discovered per page via MCP link extraction */
const MAX_MCP_LINKS_PER_BATCH = 50;

// =============================================================================
// LAZY SINGLETONS (per process)
// =============================================================================

const fingerprinter = new TemplateFingerprinter();
let handlerReuser: HandlerReuser | null = null;
let handlerStore: IHandlerStore | null = null;

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

let qualityGate: QualityGate | null = null;
let httpAdapter: HttpAdapter | null = null;
let failureScorer: FailureScorer | null = null;
let linkScorer: LinkScorer | null = null;
let paginationDetector: PaginationDetector | null = null;

function getQualityGate(): QualityGate {
  if (!qualityGate) qualityGate = new QualityGate();
  return qualityGate;
}

function getHttpAdapter(): HttpAdapter {
  if (!httpAdapter) httpAdapter = new HttpAdapter();
  return httpAdapter;
}

function getFailureScorer(): FailureScorer {
  if (!failureScorer) failureScorer = new FailureScorer();
  return failureScorer;
}

function getLinkScorer(): LinkScorer {
  if (!linkScorer) linkScorer = new LinkScorer();
  return linkScorer;
}

function getPaginationDetector(): PaginationDetector {
  if (!paginationDetector) paginationDetector = new PaginationDetector();
  return paginationDetector;
}

let interactiveDetector: InteractiveDetector | null = null;
let jsonLdExtractor: JsonLdExtractor | null = null;
// NOTE: IntentDecomposer is NOT a singleton — created per-job with llmClient

function getInteractiveDetector(): InteractiveDetector {
  if (!interactiveDetector) interactiveDetector = new InteractiveDetector();
  return interactiveDetector;
}

function getJsonLdExtractor(): JsonLdExtractor {
  if (!jsonLdExtractor) jsonLdExtractor = new JsonLdExtractor();
  return jsonLdExtractor;
}

// =============================================================================
// HELPERS — group strategy matching + progress tracking
// =============================================================================

/**
 * Match a URL to a group strategy using pattern matching.
 * Patterns like "/docs/{slug}" are converted to regex for matching.
 */
function findGroupForUrl(url: string, strategies: GroupStrategy[]): GroupStrategy | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  return strategies.find((s) => matchesPattern(pathname, s.pattern));
}

/**
 * Check if a pathname matches a group pattern.
 * {param} segments match any non-slash string.
 */
function matchesPattern(pathname: string, pattern: string): boolean {
  // Escape regex special chars except our {param} placeholders
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (match) => {
    if (match === '{' || match === '}') return match;
    return `\\${match}`;
  });
  const regexStr = escaped.replace(/\{[^}]+\}/g, '[^/]+');
  try {
    return new RegExp(`^${regexStr}$`, 'i').test(pathname);
  } catch {
    return false;
  }
}

/**
 * Update group progress counts after processing a page.
 */
function updateGroupProgress(
  url: string,
  groupCounts: Map<string, { completed: number; total: number; method: string }>,
  strategies?: GroupStrategy[],
): void {
  if (!strategies || groupCounts.size === 0) return;
  const group = findGroupForUrl(url, strategies);
  if (!group) return;
  const entry = groupCounts.get(group.pattern);
  if (entry) {
    entry.completed++;
  }
}

/**
 * Emit group progress event for the group the URL belongs to.
 */
async function emitGroupProgress(
  jobId: string,
  url: string,
  groupCounts: Map<string, { completed: number; total: number; method: string }>,
  strategies?: GroupStrategy[],
): Promise<void> {
  if (!strategies || groupCounts.size === 0) return;
  const group = findGroupForUrl(url, strategies);
  if (!group) return;
  const entry = groupCounts.get(group.pattern);
  if (!entry) return;
  await publishProgressEvent({
    type: 'intelligence_group_progress',
    jobId,
    timestamp: new Date().toISOString(),
    data: {
      groupPattern: group.pattern,
      completed: entry.completed,
      total: entry.total,
      method: entry.method as 'http' | 'playwright',
    },
  });
}

// =============================================================================
// MAIN PROCESSOR
// =============================================================================

export async function processIntelligenceCrawl(job: Job<IntelligenceCrawlJobData>): Promise<void> {
  const {
    jobId,
    tenantId,
    indexId,
    sourceId,
    entryUrl,
    discoveredUrls,
    intent,
    limits,
    discovery,
    groupStrategies,
  } = job.data;

  const redis = getSharedRedisClient();
  if (!redis) throw new Error('Redis not configured — intelligence crawl requires Redis');
  const lockKey = `intelligence-crawl:active:${tenantId}`;
  let mcpClient: MCPClient | null = null;

  try {
    // 1. LOCK — acquire per-tenant distributed lock
    // Use EX (seconds) + NX for distributed lock
    const lockTtlSeconds = Math.ceil(JOB_TIMEOUT / 1000);
    const acquired = await redis.set(lockKey, jobId, 'EX', lockTtlSeconds, 'NX');
    if (!acquired) {
      throw new Error('Another intelligence crawl is active for this tenant');
    }

    // 2. Update CrawlJob status → 'crawling'
    const CrawlJob = getLazyModel<ICrawlJob>('CrawlJob');
    await CrawlJob.findOneAndUpdate(
      { _id: jobId, tenantId },
      { status: 'crawling', 'timeline.startedAt': new Date() },
    );

    // 3. CONNECT — create MCPClient
    mcpClient = new MCPClient({
      name: 'intelligence-crawl-worker',
      transport: 'http',
      url: MCP_SERVER_URL,
      ssrfOptions: { allowLocalhost: true },
      autoReconnect: false,
      requestTimeoutMs: 30_000,
    });
    await mcpClient.connect();

    // 4. Resolve LLM config
    const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);
    let provider = llmConfig.provider;
    let apiKey = llmConfig.apiKey;
    let modelId = '';

    if (!apiKey) {
      const tierResult = await resolveTenantModelWithFallback(tenantId, 'balanced');
      if (!tierResult.model) {
        throw new Error('No LLM credentials configured for this tenant');
      }
      provider = tierResult.model.provider;
      apiKey = tierResult.model.apiKey;
      modelId = tierResult.model.modelId;
    } else {
      const tierResult = await resolveTenantModelWithFallback(tenantId, 'balanced');
      modelId = tierResult.model?.modelId ?? 'default';
    }

    const llmClient = new WorkerLLMClient(provider, apiKey, modelId);

    // 5. Initialize handler reuser + store, seed from MongoDB
    const reuser = getHandlerReuser();
    const store = getHandlerStore();

    const entryDomain = new URL(entryUrl).hostname;
    try {
      const storedHandlers = await store.findByDomain(tenantId, entryDomain);
      for (const sh of storedHandlers) {
        const fp = TemplateFingerprinter.fromSerializable({
          fingerprint: sh.fingerprint,
          tagPathCount: 0,
        });
        reuser.registerHandler(fp.fingerprint, sh.handler, sh.trainedOn);
      }
    } catch (err) {
      log.warn('Failed to seed handler reuser from store', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 6. Emit discovering event
    await publishProgressEvent({
      type: 'intelligence_crawl_discovering',
      jobId,
      timestamp: new Date().toISOString(),
      data: { url: entryUrl },
    });

    // 7. MCP link discovery (extends sitemap URLs)
    let allUrls = [...discoveredUrls];
    if (discovery.followLinks) {
      try {
        await mcpClient.callTool('navigate', { url: entryUrl });
        const linksResult = await mcpClient.callTool('extract_links', {});
        const rawLinks = JSON.parse(extractMcpText(linksResult.content) || '[]');
        const linkUrls: string[] = (Array.isArray(rawLinks) ? rawLinks : rawLinks.links || [])
          .map((l: unknown) => (typeof l === 'string' ? l : (l as { href?: string })?.href))
          .filter(Boolean) as string[];

        const existingSet = new Set(allUrls);
        const newLinks = linkUrls
          .filter((u) => !existingSet.has(u))
          .filter((u) => {
            try {
              return new URL(u).hostname === entryDomain;
            } catch {
              return false;
            }
          });

        // Async SSRF check
        const ssrfChecks = await Promise.all(
          newLinks.slice(0, MAX_MCP_LINKS_PER_BATCH).map(async (link) => ({
            link,
            result: await isURLAllowed(link),
          })),
        );
        const safeLinks = ssrfChecks.filter((c) => c.result.allowed).map((c) => c.link);
        const slotsAvailable = Math.max(0, limits.maxPages - allUrls.length);
        allUrls.push(...safeLinks.slice(0, slotsAvailable));
      } catch (err) {
        log.warn('MCP link discovery failed, continuing with sitemap URLs', {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Update CrawlJob with expanded URLs
    await CrawlJob.findOneAndUpdate({ _id: jobId, tenantId }, { 'urls.expanded': allUrls });

    // 7b. A9 Intent Decomposition — prioritize URLs by sub-intent matching
    let urlPriority: string[] = allUrls;
    if (intent && allUrls.length > 0) {
      try {
        const decomposer = new IntentDecomposer(llmClient); // per-job, NOT singleton
        const decomposition = await decomposer.decompose(intent, allUrls);
        if (decomposition.subIntents.length > 0) {
          const priorityPatterns = decomposition.subIntents.map((si) => si.urlPattern);
          urlPriority = [
            ...allUrls.filter((u) => priorityPatterns.some((p) => u.includes(p))),
            ...allUrls.filter((u) => !priorityPatterns.some((p) => u.includes(p))),
          ];
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Intent decomposition failed, using default URL order', { error: msg });
      }
    }

    // 8. Emit started event
    await publishProgressEvent({
      type: 'intelligence_crawl_started',
      jobId,
      timestamp: new Date().toISOString(),
      data: {
        totalPages: allUrls.length,
        reusablePages: 0,
        maxLlmCalls: limits.maxLlmCalls,
      },
    });

    // 9. PROCESS PAGES (sequential)
    let crawledCount = 0;
    let newDocumentCount = 0;
    let failedCount = 0;
    let reusedCount = 0;
    let totalLlmCalls = 0;
    let totalTokens = 0;
    let fastCount = 0;
    let aiCount = 0;
    let blockedCount = 0;
    const processedUrls = new Set<string>();
    const jobStartTime = Date.now();

    // Initialize group progress tracking from groupStrategies
    const groupCounts = new Map<string, { completed: number; total: number; method: string }>();
    if (groupStrategies) {
      for (const gs of groupStrategies) {
        groupCounts.set(gs.pattern, {
          completed: 0,
          total: gs.count ?? 0,
          method: gs.method,
        });
      }
    }

    for (let i = 0; i < urlPriority.length; i++) {
      const pageUrl = urlPriority[i];
      if (processedUrls.has(pageUrl)) continue;
      processedUrls.add(pageUrl);

      // Job timeout check
      if (Date.now() - jobStartTime > JOB_TIMEOUT) {
        log.warn('Job timeout reached', {
          jobId,
          processed: i,
          total: urlPriority.length,
        });
        break;
      }

      // Crash recovery: check Redis checkpoint
      const urlHash = createHash('sha256').update(pageUrl).digest('hex').slice(0, 16);
      const checkpointKey = `intelligence-crawl:page:${tenantId}:${jobId}:${urlHash}`;
      const existingCheckpoint = await redis.get(checkpointKey);
      if (existingCheckpoint) {
        try {
          const cp = JSON.parse(existingCheckpoint);
          if (cp.status === 'ingested') {
            crawledCount++;
            continue;
          }
        } catch {
          // Invalid checkpoint JSON, reprocess
        }
      }

      // Layer 2 crash recovery: check SearchDocument
      const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
      const existingDoc = await SearchDocument.findOne({
        tenantId,
        indexId,
        originalReference: pageUrl,
        'sourceMetadata.crawlJobId': jobId,
      }).lean();
      if (existingDoc) {
        crawledCount++;
        continue;
      }

      // Emit page started
      await publishProgressEvent({
        type: 'intelligence_page_started',
        jobId,
        timestamp: new Date().toISOString(),
        data: {
          url: pageUrl,
          pageIndex: i,
          totalPages: urlPriority.length,
          handlerReused: false,
        },
      });

      let cachedHttpResult: HttpFetchResult | null = null;

      try {
        // --- A11 routing decision ---
        let method: 'http' | 'playwright' = 'playwright'; // safe default

        if (groupStrategies) {
          // Pre-crawl sampling told us the strategy per group
          const group = findGroupForUrl(pageUrl, groupStrategies);
          if (group?.method === 'http') method = 'http';
        } else {
          // No pre-crawl data: try HTTP first, evaluate with FailureScorer
          cachedHttpResult = await getHttpAdapter().fetch(pageUrl);
          if (cachedHttpResult.success && cachedHttpResult.crawlResult) {
            const failureScore = getFailureScorer().score(cachedHttpResult.crawlResult);
            if (!failureScore.shouldEscalate) {
              method = 'http';
            }
          }
        }

        let rawHtml: string | undefined;
        let rawText: string | undefined;
        let pageLinks: CrawlResultLink[] = [];

        if (method === 'http') {
          // Reuse cached result if available; otherwise fetch fresh
          const result = cachedHttpResult ?? (await getHttpAdapter().fetch(pageUrl));
          if (!result.success || !result.crawlResult) {
            // HTTP failed → fallback to Playwright for this page
            method = 'playwright';
          } else {
            rawHtml = result.crawlResult.html;
            rawText = result.crawlResult.text;
            pageLinks = result.crawlResult.links;
            fastCount++;
          }
        }

        if (method === 'playwright') {
          // EXISTING MCP flow — Playwright path
          await mcpClient.callTool('navigate', { url: pageUrl });

          // Get page content for fingerprinting
          const pageContentResult = await mcpClient.callTool('get_page_content', {
            includeHtml: true,
            includeText: true,
          });
          const pageContentText = extractMcpText(pageContentResult.content);

          try {
            const parsed = JSON.parse(pageContentText);
            if (parsed?.html) rawHtml = parsed.html;
          } catch {
            /* not JSON */
          }
          if (!rawHtml) rawHtml = pageContentText;
          // Extract text from HTML if not parsed
          if (!rawText) rawText = rawHtml;
          aiCount++;
        }

        // At this point rawHtml is guaranteed to be set
        const html = rawHtml ?? '';
        const text = rawText ?? '';

        // --- CHEERIO PARSE-ONCE (V7 optimization) ---
        const $ = cheerio.load(html);

        // --- A7 quality gate (runs for BOTH paths, now uses WithDom) ---
        const qualityResult = getQualityGate().scoreWithDom($, text);
        if (qualityResult.shouldBlock) {
          blockedCount++;
          await publishProgressEvent({
            type: 'intelligence_page_blocked',
            jobId,
            timestamp: new Date().toISOString(),
            data: {
              url: pageUrl,
              reason: qualityResult.reason,
              qualityScore: qualityResult.score,
            },
          });
          // Update group counts and emit group progress
          updateGroupProgress(pageUrl, groupCounts, groupStrategies);
          await emitGroupProgress(jobId, pageUrl, groupCounts, groupStrategies);
          continue; // SKIP ingestion
        }

        // --- A8 interactive detection (V7 — replaces placeholder) ---
        const interactive = getInteractiveDetector().detectWithDom($);

        // --- A12 JSON-LD extraction (V7 — before handler reuse) ---
        const jsonLd = getJsonLdExtractor().extractWithDom($);
        let jsonLdUsed = false;

        // --- A5 pagination + A6 link scoring (now uses WithDom) ---
        const pagination = getPaginationDetector().detectWithDom($, pageUrl, pageLinks);
        const scoredLinks = getLinkScorer().scoreLinksWithDom($, pageLinks, pageUrl);
        const relevantLinks = scoredLinks.filter((l) => l.relevant);

        // Try handler reuse
        let wasReused = false;
        let pageLlmCalls = 0;
        let pageTokens = 0;

        if (jsonLd.canSkipLlm) {
          // A12 fast-path: JSON-LD provides enough structured data — skip LLM entirely
          jsonLdUsed = true;
          wasReused = false; // Not handler reuse; this is JSON-LD extraction

          await publishProgressEvent({
            type: 'intelligence_page_phase',
            jobId,
            timestamp: new Date().toISOString(),
            data: {
              url: pageUrl,
              phase: 'jsonld',
              phaseDetail: `JSON-LD ${jsonLd.primaryType ?? 'unknown'} extracted — 0 LLM calls`,
            },
          });
        } else {
          // Normal path: try handler reuse first
          const reuseResult = reuser.tryReuse(html);

          if (reuseResult.matched && reuseResult.handler) {
            // HANDLER REUSE — skip Phase 2+3
            wasReused = true;
            reusedCount++;

            await publishProgressEvent({
              type: 'intelligence_page_phase',
              jobId,
              timestamp: new Date().toISOString(),
              data: {
                url: pageUrl,
                phase: 'reuse',
                phaseDetail: 'Reusing stored handler — 0 LLM calls',
              },
            });
          } else if (totalLlmCalls < limits.maxLlmCalls) {
            // NO MATCH + budget available — full intelligence loop
            const onProgress: OnProgressCallback = async (phase, detail) => {
              await publishProgressEvent({
                type: 'intelligence_page_phase',
                jobId,
                timestamp: new Date().toISOString(),
                data: { url: pageUrl, phase, phaseDetail: detail },
              });
            };

            const service = new CrawlIntelligenceService({
              llmClient,
              mcpClient,
              handlerReuser: reuser,
              handlerStore: store,
              fingerprinter,
              tenantId,
              onProgress,
            });

            const crawlIntent = {
              intent: intent || `Extract main content from ${pageUrl}`,
              siteUrl: new URL(pageUrl).origin,
              sampleUrl: pageUrl,
            };

            const result = await Promise.race([
              service.execute(crawlIntent),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Page analysis timeout')), PAGE_TIMEOUT_FULL),
              ),
            ]);

            pageLlmCalls = result.llmCallCount;
            pageTokens = result.totalTokens;
            if (result.replay?.content?.rawHtml) {
              rawHtml = result.replay.content.rawHtml;
            }
          } else {
            // Budget exhausted + no handler match → skip
            log.info('Skipping page — LLM budget exhausted and no handler match', {
              url: pageUrl,
              jobId,
            });
            failedCount++;

            // Persist CrawlError for budget-exhausted pages (best-effort non-blocking)
            try {
              const CrawlError = getLazyModel<ICrawlError>('CrawlError');
              await CrawlError.create({
                tenantId,
                crawlJobId: jobId,
                url: pageUrl,
                type: 'crawl_error' as ICrawlError['type'],
                error: sanitizeErrorMessage('LLM budget exhausted and no handler match'),
                timestamp: new Date(),
              });
            } catch (crawlErrPersist) {
              log.warn('Failed to persist CrawlError for budget-exhausted page', {
                url: pageUrl,
                jobId,
                error:
                  crawlErrPersist instanceof Error
                    ? crawlErrPersist.message
                    : String(crawlErrPersist),
              });
            }

            await publishProgressEvent({
              type: 'intelligence_page_failed',
              jobId,
              timestamp: new Date().toISOString(),
              data: {
                url: pageUrl,
                errorType: 'crawl_error',
                error: { message: 'LLM budget exhausted and no handler match' },
              },
            });

            // Update group counts even for failed pages
            updateGroupProgress(pageUrl, groupCounts, groupStrategies);
            await emitGroupProgress(jobId, pageUrl, groupCounts, groupStrategies);
            continue;
          }
        }

        totalLlmCalls += pageLlmCalls;
        totalTokens += pageTokens;

        // Set checkpoint: analyzed
        await redis.setex(checkpointKey, CHECKPOINT_TTL, JSON.stringify({ status: 'analyzed' }));

        // Upload rawHtml to storage
        const finalHtml = rawHtml ?? html;
        try {
          const config = getConfig();
          const storage = createFileStorage(config.storage);
          const htmlBuffer = Buffer.from(finalHtml, 'utf-8');
          const storageKey = `intelligence/${tenantId}/${jobId}/${urlHash}.html`;
          await storage.upload(storageKey, htmlBuffer, { contentType: 'text/html' });
        } catch (storageErr) {
          log.warn('Failed to upload HTML to storage, continuing with ingestion', {
            url: pageUrl,
            error: storageErr instanceof Error ? storageErr.message : String(storageErr),
          });
        }

        // Ingest via CrawlerIngestionService
        const ingestionMetadata: Record<string, unknown> = {
          crawlJobId: jobId,
          crawledAt: new Date().toISOString(),
          domain: entryDomain,
          handlerReused: wasReused,
          method,
        };
        if (jsonLdUsed && jsonLd.primaryType) {
          ingestionMetadata.jsonLdType = jsonLd.primaryType;
          ingestionMetadata.jsonLdFields = jsonLd.extractedFields;
        }
        const ingestionResult = await crawlerIngestionService.ingestCrawledContent({
          indexId,
          sourceId,
          url: pageUrl,
          htmlContent: finalHtml,
          tenantId,
          metadata: ingestionMetadata,
        });

        if (ingestionResult.duplicate) {
          log.info('Duplicate document, counting as processed', {
            url: pageUrl,
            duplicateId: ingestionResult.duplicate.documentId,
          });
        } else {
          newDocumentCount++;
        }

        // Record handler success in store (non-blocking)
        if (wasReused) {
          try {
            const fp = fingerprinter.fingerprint(finalHtml, pageUrl);
            const fpHex = TemplateFingerprinter.toSerializable(fp).fingerprint;
            await store.recordSuccess(tenantId, entryDomain, fpHex);
          } catch (err) {
            log.warn('Failed to record handler success', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Update checkpoint: ingested
        await redis.setex(checkpointKey, CHECKPOINT_TTL, JSON.stringify({ status: 'ingested' }));

        crawledCount++;

        // Update CrawlJob progress
        await CrawlJob.findOneAndUpdate(
          { _id: jobId, tenantId },
          { 'urls.crawled': crawledCount, 'urls.failed': failedCount },
        );

        // Emit page complete + saved events (extended with A5/A6/A7/A11 fields)
        await publishProgressEvent({
          type: 'intelligence_page_complete',
          jobId,
          timestamp: new Date().toISOString(),
          data: {
            url: pageUrl,
            handlerReused: wasReused,
            llmCalls: pageLlmCalls,
            method,
            qualityScore: qualityResult.score,
            quality: qualityResult.quality,
            interactiveFlags: interactive.flags,
            jsonLdUsed,
            a6RelevantLinks: relevantLinks.length,
            paginationDetected: pagination.detected,
          },
        });

        await publishProgressEvent({
          type: 'intelligence_page_saved',
          jobId,
          timestamp: new Date().toISOString(),
          data: {
            url: pageUrl,
            documentId: ingestionResult.documentId || '',
          },
        });

        // Update group progress and emit
        updateGroupProgress(pageUrl, groupCounts, groupStrategies);
        await emitGroupProgress(jobId, pageUrl, groupCounts, groupStrategies);

        // MCP link discovery for this page (extend allUrls) — only when Playwright was used
        if (
          method === 'playwright' &&
          discovery.followLinks &&
          allUrls.length < limits.maxPages &&
          mcpClient
        ) {
          try {
            const linksResult = await mcpClient.callTool('extract_links', {});
            const rawLinks = JSON.parse(extractMcpText(linksResult.content) || '[]');
            const linkUrls: string[] = (Array.isArray(rawLinks) ? rawLinks : rawLinks.links || [])
              .map((l: unknown) => (typeof l === 'string' ? l : (l as { href?: string })?.href))
              .filter(Boolean) as string[];

            const existingSet = new Set(allUrls);
            const newLinks = linkUrls
              .filter((u) => !existingSet.has(u) && !processedUrls.has(u))
              .filter((u) => {
                try {
                  return new URL(u).hostname === entryDomain;
                } catch {
                  return false;
                }
              });

            const ssrfChecks = await Promise.all(
              newLinks.slice(0, MAX_MCP_LINKS_PER_BATCH).map(async (link) => ({
                link,
                result: await isURLAllowed(link),
              })),
            );
            const safeLinks = ssrfChecks.filter((c) => c.result.allowed).map((c) => c.link);
            const slotsAvailable = Math.max(0, limits.maxPages - allUrls.length);
            const newSafe = safeLinks.slice(0, slotsAvailable);
            allUrls.push(...newSafe);
            urlPriority.push(...newSafe);
          } catch {
            /* non-blocking link discovery */
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error('Page processing failed', { url: pageUrl, jobId, error: errMsg });
        failedCount++;

        // Persist CrawlError (best-effort non-blocking)
        const errorType = classifyCrawlError(errMsg, cachedHttpResult?.statusCode);
        try {
          const CrawlError = getLazyModel<ICrawlError>('CrawlError');
          await CrawlError.create({
            tenantId,
            crawlJobId: jobId,
            url: pageUrl,
            type: errorType,
            error: sanitizeErrorMessage(errMsg),
            statusCode: cachedHttpResult?.statusCode,
            timestamp: new Date(),
          });
        } catch (crawlErrPersist) {
          log.warn('Failed to persist CrawlError for page failure', {
            url: pageUrl,
            jobId,
            error:
              crawlErrPersist instanceof Error ? crawlErrPersist.message : String(crawlErrPersist),
          });
        }

        await publishProgressEvent({
          type: 'intelligence_page_failed',
          jobId,
          timestamp: new Date().toISOString(),
          data: {
            url: pageUrl,
            errorType,
            error: { message: 'Page processing failed' },
          },
        });

        // Update CrawlJob
        await CrawlJob.findOneAndUpdate({ _id: jobId, tenantId }, { 'urls.failed': failedCount });
      }
    }

    // 10. Compute quality metrics from ingested documents
    let qualityMetrics: Record<string, number> | undefined;
    try {
      const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
      const metricsPipeline = [
        { $match: { tenantId, 'sourceMetadata.crawlJobId': jobId } },
        {
          $group: {
            _id: null,
            avgQualityScore: { $avg: '$sourceMetadata.qualityScore' },
            avgContentPreservation: { $avg: '$sourceMetadata.contentPreservation' },
            avgChunksPerDoc: { $avg: '$chunksCount' },
            totalDocs: { $sum: 1 },
            successDocs: {
              $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] },
            },
          },
        },
      ];
      const [metrics] = await SearchDocument.aggregate(metricsPipeline).option({
        maxTimeMS: 5000,
      });
      if (metrics) {
        qualityMetrics = {
          avgQualityScore: Math.round((metrics.avgQualityScore ?? 0) * 100) / 100,
          avgContentPreservation: Math.round((metrics.avgContentPreservation ?? 0) * 100) / 100,
          avgChunksPerDoc: Math.round((metrics.avgChunksPerDoc ?? 0) * 100) / 100,
          successRate:
            metrics.totalDocs > 0
              ? Math.round((metrics.successDocs / metrics.totalDocs) * 10000) / 100
              : 0,
        };
      }
    } catch (metricsErr) {
      log.warn('Failed to compute quality metrics', {
        jobId,
        error: metricsErr instanceof Error ? metricsErr.message : String(metricsErr),
      });
    }

    // 11. COMPLETE
    const finalStatus = crawledCount > 0 ? 'completed' : 'failed';
    await CrawlJob.findOneAndUpdate(
      { _id: jobId, tenantId },
      {
        status: finalStatus,
        'timeline.completedAt': new Date(),
        'urls.crawled': crawledCount,
        'urls.failed': failedCount,
        'urls.blocked': blockedCount,
        'results.documentsCreated': newDocumentCount,
        ...(qualityMetrics && { 'results.qualityMetrics': qualityMetrics }),
      },
    );

    await publishProgressEvent({
      type: 'intelligence_crawl_complete',
      jobId,
      timestamp: new Date().toISOString(),
      data: {
        summary: {
          totalPages: allUrls.length,
          completed: crawledCount,
          failed: failedCount,
          reused: reusedCount,
          llmCallsTotal: totalLlmCalls,
          tokensTotal: totalTokens,
          fastCount,
          aiCount,
          blockedCount,
        },
      },
    });

    workerLog('intelligence-crawl', 'Intelligence crawl completed', {
      jobId,
      crawled: crawledCount,
      failed: failedCount,
      reused: reusedCount,
      totalLlmCalls,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error('Intelligence crawl failed', { jobId, error: errMsg });

    const CrawlJob = getLazyModel<ICrawlJob>('CrawlJob');
    await CrawlJob.findOneAndUpdate(
      { _id: jobId, tenantId },
      { status: 'failed', 'timeline.completedAt': new Date() },
    ).catch((updateErr: unknown) => {
      log.warn('Failed to update CrawlJob on error', {
        error: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
    });

    await publishProgressEvent({
      type: 'intelligence_crawl_failed',
      jobId,
      timestamp: new Date().toISOString(),
      data: { error: { message: 'Intelligence crawl failed' }, pagesCompleted: 0 },
    }).catch((pubErr: unknown) => {
      log.warn('Failed to publish failure event', {
        error: pubErr instanceof Error ? pubErr.message : String(pubErr),
      });
    });

    throw err; // Let BullMQ handle retry
  } finally {
    // Always cleanup
    if (mcpClient) {
      await mcpClient.disconnect().catch((err: unknown) => {
        log.warn('Failed to disconnect MCP client', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    await redis.del(lockKey).catch((err: unknown) => {
      log.warn('Failed to release tenant lock', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // Shared client — do not quit here; process-level shutdown handles it.
  }
}

// =============================================================================
// WORKER CREATION
// =============================================================================

let worker: Worker | null = null;

export function createIntelligenceCrawlWorker(): Worker {
  const options = createWorkerOptions(1); // concurrency 1 — sequential crawling

  const w = new Worker<IntelligenceCrawlJobData>(
    QUEUE_INTELLIGENCE_CRAWL,
    processIntelligenceCrawl,
    {
      ...options,
      lockDuration: 600_000, // 10 min lock (long-running job)
      lockRenewTime: 300_000, // Renew every 5 min
    },
  );

  w.on('completed', (completedJob) => {
    workerLog('intelligence-crawl', `Job ${completedJob.id} completed`);
  });

  w.on('failed', (failedJob, error) => {
    if (failedJob) {
      workerError('intelligence-crawl', `Job ${failedJob.id} failed`, error);
    } else {
      workerError('intelligence-crawl', 'Job failed (no job object)', error);
    }
  });

  w.on('error', (error) => {
    workerError('intelligence-crawl', 'Worker error', error);
  });

  worker = w;
  workerLog('intelligence-crawl', 'Intelligence crawl worker started', {
    queue: QUEUE_INTELLIGENCE_CRAWL,
    concurrency: 1,
  });

  return w;
}

export function getIntelligenceCrawlWorker(): Worker | null {
  return worker;
}
