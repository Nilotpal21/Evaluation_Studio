/**
 * Intelligence Analysis Route
 *
 * POST /intelligence/analyze — Start a crawl intelligence analysis
 * GET  /intelligence/status/:jobId — Get analysis status
 * POST /intelligence/crawl-site — Start a multi-page intelligence crawl
 * GET  /intelligence/crawl-site/:jobId — Get per-page crawl status
 *
 * Uses the CrawlIntelligenceService (4-phase loop) via MCP browser automation.
 * Auth is inherited from global `app.use('/api', authMiddleware)`.
 */

import { Router, type Request, type Response, type Router as RouterType } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import type { RedisClient } from '@agent-platform/redis';
import { createQueue } from '../workers/shared.js';
import { getSharedRedisClient } from '../workers/shared.js';
import type { IntelligenceCrawlJobData } from '../workers/shared.js';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';
import { resolveTenantModelWithFallback } from '../services/llm-config/tenant-model-adapter.js';
import { WorkerLLMClient } from '@agent-platform/llm';
import { MCPClient } from '@abl/compiler/platform';
import {
  CrawlIntelligenceService,
  FastProfiler,
  HandlerReuser,
  TemplateFingerprinter,
  MongoHandlerStore,
  type IntelligenceAnalysisResult,
  type OnProgressCallback,
  type IHandlerStore,
  type HandlerTemplateModel,
} from '@abl/crawler';
import type { IHandlerTemplate, ICrawlJob, ISearchDocument } from '@agent-platform/database/models';
import { isURLAllowed } from '../utils/ssrf-protection.js';
import { publishProgressEvent } from './progress.js';
import { createLogger } from '@abl/compiler/platform';
import { createFileStorage, readFileFromStorage } from '../storage/storage-factory.js';
import { getConfig } from '../config/index.js';
import { crawlerIngestionService } from '../services/ingestion/crawler-ingestion.js';
import { getLazyModel } from '../db/index.js';
import type { ISearchIndex, ISearchSource } from '@agent-platform/database/models';
import { QUEUE_INTELLIGENCE_CRAWL } from '@agent-platform/search-ai-sdk';
import { applyProjectScopeFilter } from './project-scope.js';
import { scanKeys } from '@agent-platform/redis';

const logger = createLogger('intelligence-route');

const router: RouterType = Router();

// Lazy Redis — reuse shared cluster-safe connection
let redis: RedisClient | null = null;
function getRedis(): RedisClient {
  if (!redis) {
    redis = getSharedRedisClient();
  }
  if (!redis) {
    throw new Error('Redis not configured — intelligence routes require Redis');
  }
  return redis;
}

const MCP_SERVER_URL = process.env.CRAWLER_MCP_URL || 'http://localhost:3100';

// ─── Handler Reuse Singletons (lazy, one per process) ────────────────────
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

// ─── Rate Limit Constants ─────────────────────────────────────────────────
const MAX_CONCURRENT_PER_TENANT = 1;
const MAX_HOURLY_PER_TENANT = 30;
const ACTIVE_KEY_TTL_SECONDS = 120; // matches analysis timeout
const HOURLY_KEY_TTL_SECONDS = 3600;

// ─── Analysis Timeout ─────────────────────────────────────────────────────
const ANALYSIS_TIMEOUT_MS = 120_000; // 2 minutes

// ─── Validation Schemas ───────────────────────────────────────────────────

const analyzeInputSchema = z.object({
  url: z.string().url().max(2048),
  intent: z.string().max(500).optional(),
  indexId: z.string().min(1),
});

const jobIdParamSchema = z.string().min(1).max(100);

// ─── POST /intelligence/analyze ───────────────────────────────────────────

router.post('/intelligence/analyze', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing tenant context' },
      });
    }

    // 1. Validate input
    const parsed = analyzeInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      });
    }

    const { url, intent, indexId } = parsed.data;

    // 2. SSRF check
    const ssrfResult = await isURLAllowed(url);
    if (!ssrfResult.allowed) {
      return res.status(400).json({
        success: false,
        error: { code: 'URL_BLOCKED', message: 'URL blocked by security policy' },
      });
    }

    // 3. Rate limit checks
    const redisClient = getRedis();

    // 3a. Concurrent limit
    const activeKey = `intelligence:active:${tenantId}`;
    const activeExists = await redisClient.exists(activeKey);
    if (activeExists) {
      return res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_CONCURRENT',
          message: 'An intelligence analysis is already running for this tenant',
        },
      });
    }

    // 3b. Hourly limit
    const hourlyKey = `intelligence:hourly:${tenantId}`;
    const hourlyCount = await redisClient.incr(hourlyKey);
    // Set TTL on first increment
    if (hourlyCount === 1) {
      await redisClient.expire(hourlyKey, HOURLY_KEY_TTL_SECONDS);
    }
    if (hourlyCount > MAX_HOURLY_PER_TENANT) {
      return res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_HOURLY',
          message: `Hourly intelligence analysis limit (${MAX_HOURLY_PER_TENANT}) exceeded`,
        },
      });
    }

    // 4. Resolve LLM config
    let provider: string;
    let apiKey: string;
    let modelId: string;

    try {
      const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);
      provider = llmConfig.provider;
      apiKey = llmConfig.apiKey;

      if (!apiKey) {
        // Try tenant model resolution directly
        const tierResult = await resolveTenantModelWithFallback(tenantId, 'balanced');
        if (!tierResult.model) {
          return res.status(500).json({
            success: false,
            error: {
              code: 'LLM_NOT_CONFIGURED',
              message: 'No LLM credentials configured for this tenant',
            },
          });
        }
        provider = tierResult.model.provider;
        apiKey = tierResult.model.apiKey;
        modelId = tierResult.model.modelId;
      } else {
        // Resolve model ID from tenant models
        const tierResult = await resolveTenantModelWithFallback(tenantId, 'balanced');
        modelId = tierResult.model?.modelId ?? 'default';
      }
    } catch (err) {
      logger.error('Failed to resolve LLM config', {
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({
        success: false,
        error: {
          code: 'LLM_NOT_CONFIGURED',
          message: 'Failed to resolve LLM configuration',
        },
      });
    }

    // 5. Set concurrent lock
    await redisClient.setex(activeKey, ACTIVE_KEY_TTL_SECONDS, '1');

    // 6. Generate job ID and store initial state
    const jobId = crypto.randomUUID();
    const jobStateKey = `intelligence:job:${jobId}`;
    await redisClient.setex(
      jobStateKey,
      600, // 10 minute TTL
      JSON.stringify({
        status: 'pending',
        tenantId,
        url,
        intent,
        indexId,
        createdAt: new Date().toISOString(),
      }),
    );

    // 7. Return immediately with jobId
    res.json({ success: true, jobId });

    // 8. Run analysis in background
    setImmediate(async () => {
      let mcpClient: MCPClient | null = null;
      try {
        // Update status to running
        await redisClient.setex(
          jobStateKey,
          600,
          JSON.stringify({
            status: 'running',
            tenantId,
            url,
            intent,
            indexId,
            startedAt: new Date().toISOString(),
          }),
        );

        // Create LLM client
        const llmClient = new WorkerLLMClient(provider, apiKey, modelId);

        // Create and connect MCP client
        mcpClient = new MCPClient({
          name: 'crawl-intelligence',
          transport: 'http',
          url: MCP_SERVER_URL,
          ssrfOptions: { allowLocalhost: true },
          autoReconnect: false,
          requestTimeoutMs: 30_000,
        });
        await mcpClient.connect();

        // Publish started event
        await publishProgressEvent({
          type: 'intelligence_started',
          jobId,
          timestamp: new Date().toISOString(),
          data: { url },
        });

        // Create progress callback
        const onProgress: OnProgressCallback = async (phase, detail) => {
          await publishProgressEvent({
            type: 'intelligence_phase',
            jobId,
            timestamp: new Date().toISOString(),
            data: { phase, phaseDetail: detail },
          });
        };

        // Create service and execute
        const service = new CrawlIntelligenceService({
          llmClient,
          mcpClient,
          onProgress,
          handlerReuser: getHandlerReuser(),
          handlerStore: getHandlerStore(),
          fingerprinter,
          tenantId,
        });

        const crawlIntent = {
          intent: intent || `Extract main content from ${url}`,
          siteUrl: new URL(url).origin,
          sampleUrl: url,
        };

        // Race against timeout
        const result = await Promise.race([
          service.execute(crawlIntent),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Intelligence analysis timed out')),
              ANALYSIS_TIMEOUT_MS,
            ),
          ),
        ]);

        // Build analysis result for the API
        const analysisResult: IntelligenceAnalysisResult = {
          title: result.replay.content.title,
          body: result.replay.content.body,
          bodyLength: result.replay.content.body.length,
          quality:
            result.replay.content.body.length > 2000
              ? 'rich'
              : result.replay.content.body.length > 500
                ? 'standard'
                : 'thin',
          handler: {
            steps: result.buildHandler.handler.steps.length,
            urlPattern: result.buildHandler.handler.urlPattern,
          },
          llmCallCount: result.llmCallCount,
          totalTokens: result.totalTokens,
          handlerReused: result.handlerReused ?? false,
        };

        // Persist handler to MongoDB for future reuse
        if (result.replay.content.rawHtml && result.buildHandler?.handler) {
          try {
            const fp = fingerprinter.fingerprint(result.replay.content.rawHtml, url);
            const fpHex = TemplateFingerprinter.toSerializable(fp).fingerprint;
            const domain = new URL(url).hostname;

            await getHandlerStore().saveHandler({
              tenantId,
              domain,
              urlPattern: result.buildHandler.handler.urlPattern,
              fingerprint: fpHex,
              handler: result.buildHandler.handler,
              trainedOn: [url],
            });

            // Also register in in-memory cache for same-session reuse
            getHandlerReuser().registerHandler(fp.fingerprint, result.buildHandler.handler, [url]);

            logger.info('Handler persisted to MongoDB', {
              jobId,
              domain,
              fingerprint: fpHex,
            });
          } catch (err) {
            // Non-blocking — don't fail analysis if handler persistence fails
            logger.warn('Failed to persist handler', {
              jobId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Upload raw HTML to common file storage (not Redis — HTML can be large)
        let rawHtmlStorageUrl: string | undefined;
        if (result.replay.content.rawHtml) {
          try {
            const config = getConfig();
            const storage = createFileStorage(config.storage);
            const htmlBuffer = Buffer.from(result.replay.content.rawHtml, 'utf-8');
            const storageKey = `intelligence/${tenantId}/${jobId}/raw.html`;
            const uploadResult = await storage.upload(storageKey, htmlBuffer, {
              contentType: 'text/html',
            });
            rawHtmlStorageUrl = uploadResult.url;
            logger.info('Uploaded raw HTML to storage', {
              jobId,
              storageKey,
              sizeBytes: uploadResult.sizeBytes,
            });
          } catch (err) {
            logger.warn('Failed to upload raw HTML to storage', {
              jobId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Publish complete event
        await publishProgressEvent({
          type: 'intelligence_complete',
          jobId,
          timestamp: new Date().toISOString(),
          data: { result: analysisResult },
        });

        // Update Redis with completed status
        await redisClient.setex(
          jobStateKey,
          600,
          JSON.stringify({
            status: 'completed',
            tenantId,
            url,
            intent,
            indexId,
            result: analysisResult,
            rawHtmlStorageUrl,
            handler: result.buildHandler.handler,
            handlerReused: result.handlerReused ?? false,
            completedAt: new Date().toISOString(),
          }),
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error('Intelligence analysis failed', { jobId, error: errorMessage });

        // Publish failed event
        await publishProgressEvent({
          type: 'intelligence_failed',
          jobId,
          timestamp: new Date().toISOString(),
          data: { error: { message: 'Intelligence analysis failed' } },
        }).catch((pubErr) => {
          logger.warn('Failed to publish intelligence_failed event', {
            jobId,
            error: pubErr instanceof Error ? pubErr.message : String(pubErr),
          });
        });

        // Update Redis with failed status
        await redisClient
          .setex(
            jobStateKey,
            600,
            JSON.stringify({
              status: 'failed',
              tenantId,
              url,
              intent,
              indexId,
              error: 'Intelligence analysis failed',
              failedAt: new Date().toISOString(),
            }),
          )
          .catch((redisErr) => {
            logger.warn('Failed to update Redis with failed status', {
              jobId,
              error: redisErr instanceof Error ? redisErr.message : String(redisErr),
            });
          });
      } finally {
        // Always clean up
        if (mcpClient) {
          await mcpClient.disconnect().catch((err) => {
            logger.warn('Failed to disconnect MCP client', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
        await redisClient.del(activeKey).catch((delErr) => {
          logger.warn('Failed to delete active key', {
            activeKey,
            error: delErr instanceof Error ? delErr.message : String(delErr),
          });
        });
      }
    });
  } catch (err) {
    logger.error('Unexpected error in intelligence analyze', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

// ─── Validation Schema (Save) ──────────────────────────────────────────────
const saveInputSchema = z.object({
  jobId: z.string().min(1).max(100),
  indexId: z.string().min(1),
  name: z.string().min(1).max(500).optional(),
});

// ─── POST /intelligence/save ───────────────────────────────────────────────
router.post('/intelligence/save', async (req: Request, res: Response) => {
  try {
    // 1. Auth
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    // 2. Validate input
    const parseResult = saveInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parseResult.error.message },
      });
    }
    const { jobId, indexId, name } = parseResult.data;

    // 3. Validate index belongs to tenant (C-1 fix)
    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Index not found' },
      });
    }

    // 4. Read job from Redis — verify tenant ownership
    const redisClient = getRedis();
    const jobStateKey = `intelligence:job:${jobId}`;
    const jobData = await redisClient.get(jobStateKey);
    if (!jobData) {
      return res.status(404).json({
        success: false,
        error: { code: 'JOB_NOT_FOUND', message: 'Analysis job not found or expired' },
      });
    }

    const job = JSON.parse(jobData);
    if (job.tenantId !== tenantId) {
      return res.status(404).json({
        success: false,
        error: { code: 'JOB_NOT_FOUND', message: 'Analysis job not found or expired' },
      });
    }

    // 5. Check status and HTML availability
    if (job.status !== 'completed') {
      return res.status(400).json({
        success: false,
        error: { code: 'JOB_NOT_COMPLETE', message: 'Analysis has not completed yet' },
      });
    }

    if (!job.rawHtmlStorageUrl) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_HTML_AVAILABLE', message: 'Raw HTML was not captured during analysis' },
      });
    }

    // 6. Idempotency check
    if (job.savedSourceId) {
      return res.json({
        success: true,
        data: { sourceId: job.savedSourceId, documentId: job.savedDocumentId },
      });
    }

    // 7. Download raw HTML from storage
    const rawHtmlBuffer = await readFileFromStorage(job.rawHtmlStorageUrl);
    const htmlContent = rawHtmlBuffer.toString('utf-8');

    // 8. Create SearchSource
    const SearchSource = getLazyModel<ISearchSource>('SearchSource');
    const source = await SearchSource.create({
      tenantId,
      indexId,
      name: name || job.url,
      sourceType: 'web',
      status: 'pending',
    });

    // 9. Call CrawlerIngestionService — with cleanup on failure (H-2 fix)
    let ingestionResult;
    try {
      ingestionResult = await crawlerIngestionService.ingestCrawledContent({
        indexId,
        sourceId: String(source._id),
        url: job.url,
        htmlContent,
        tenantId,
      });
    } catch (ingestionErr) {
      // Cleanup orphaned source
      await SearchSource.deleteOne({ _id: source._id }).catch((cleanupErr: unknown) => {
        logger.warn('Failed to cleanup orphaned SearchSource', {
          sourceId: String(source._id),
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      });
      throw ingestionErr; // re-throw to outer catch
    }

    // 10. Handle ingestion result (H-1 fix)
    if (!ingestionResult.success) {
      // Cleanup orphaned source
      await SearchSource.deleteOne({ _id: source._id }).catch((cleanupErr: unknown) => {
        logger.warn('Failed to cleanup orphaned SearchSource after ingestion failure', {
          sourceId: String(source._id),
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      });
      return res.status(500).json({
        success: false,
        error: { code: 'INGESTION_FAILED', message: 'Failed to ingest content into pipeline' },
      });
    }

    const documentId = ingestionResult.documentId || '';

    // 11. Update Redis with saved state (idempotency)
    await redisClient.setex(
      jobStateKey,
      600,
      JSON.stringify({
        ...job,
        savedSourceId: String(source._id),
        savedDocumentId: documentId,
      }),
    );

    // 12. Record handler reuse success for confidence tracking
    if (job.handler && job.rawHtmlStorageUrl) {
      try {
        const domain = new URL(job.url).hostname;
        const fp = fingerprinter.fingerprint(htmlContent, job.url);
        const fpHex = TemplateFingerprinter.toSerializable(fp).fingerprint;
        await getHandlerStore().recordSuccess(tenantId, domain, fpHex);
        logger.info('Recorded handler success', { jobId, domain, fingerprint: fpHex });
      } catch (err) {
        logger.warn('Failed to record handler success', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return res.json({
      success: true,
      data: { sourceId: String(source._id), documentId },
    });
  } catch (err) {
    logger.error('Failed to save intelligence result to KB', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

// ─── Crawl-Site Validation Schema ─────────────────────────────────────────

const crawlSiteSchema = z.object({
  url: z.string().url().max(2048),
  indexId: z.string().min(1),
  intent: z.string().max(500).optional(),
  limits: z
    .object({
      maxPages: z.number().int().min(1).max(100).default(10),
      maxDepth: z.number().int().min(0).max(5).default(2),
      maxLlmCalls: z.number().int().min(1).max(200).default(50),
    })
    .optional()
    .default({}),
  discovery: z
    .object({
      useSitemap: z.boolean().default(true),
      followLinks: z.boolean().default(true),
    })
    .optional()
    .default({}),
  filters: z
    .object({
      includePaths: z.array(z.string()).optional(),
      excludePaths: z.array(z.string()).optional(),
    })
    .optional(),
  groupStrategies: z
    .array(
      z.object({
        pattern: z.string().min(1),
        method: z.enum(['http', 'playwright']),
        llmEstimate: z.number().int().min(0),
        reason: z.string().default(''),
        count: z.number().int().optional(),
      }),
    )
    .optional(),
});

// ─── Crawl-Site Rate Limit Constants ──────────────────────────────────────

const CRAWL_SITE_MAX_HOURLY = 5;
const CRAWL_SITE_HOURLY_TTL = 3600;

// ─── Lazy FastProfiler singleton ──────────────────────────────────────────

let _profiler: InstanceType<typeof FastProfiler> | null = null;
function getProfiler(): InstanceType<typeof FastProfiler> {
  if (!_profiler) {
    _profiler = new FastProfiler();
  }
  return _profiler;
}

// ─── POST /intelligence/crawl-site ───────────────────────────────────────

router.post('/intelligence/crawl-site', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing tenant context' },
      });
    }

    // 1. Validate input
    const parsed = crawlSiteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      });
    }

    const { url, indexId, intent, limits, discovery, filters, groupStrategies } = parsed.data;

    // 2. SSRF check
    const ssrfResult = await isURLAllowed(url);
    if (!ssrfResult.allowed) {
      return res.status(400).json({
        success: false,
        error: { code: 'URL_BLOCKED', message: 'URL blocked by security policy' },
      });
    }

    // 3. Rate limit: 5/hour per tenant
    const redisClient = getRedis();
    const hourlyKey = `intelligence-crawl:hourly:${tenantId}`;
    const hourlyCount = await redisClient.incr(hourlyKey);
    if (hourlyCount === 1) {
      await redisClient.expire(hourlyKey, CRAWL_SITE_HOURLY_TTL);
    }
    if (hourlyCount > CRAWL_SITE_MAX_HOURLY) {
      return res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_HOURLY',
          message: `Hourly crawl-site limit (${CRAWL_SITE_MAX_HOURLY}) exceeded`,
        },
      });
    }

    // 4. Validate index belongs to tenant
    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Index not found' },
      });
    }

    // 5. Create SearchSource
    const SearchSource = getLazyModel<ISearchSource>('SearchSource');
    const source = await SearchSource.create({
      tenantId,
      indexId,
      name: url,
      sourceType: 'web',
      status: 'pending',
    });
    const sourceId = String(source._id);

    // 6. Sitemap discovery (synchronous, 2-10s)
    let discoveredUrls: string[] = [url];
    let discoverySource: 'sitemap' | 'entry-only' = 'entry-only';

    if (discovery.useSitemap) {
      try {
        const profiler = getProfiler();
        const sitemapResult = await profiler.discoverSitemapUrls(url, limits.maxPages);

        if (sitemapResult.allUrls.length > 0) {
          // Filter to same domain
          const entryDomain = new URL(url).hostname;
          const sameDomainUrls = sitemapResult.allUrls.filter((u: string) => {
            try {
              return new URL(u).hostname === entryDomain;
            } catch {
              return false;
            }
          });

          if (sameDomainUrls.length > 0) {
            discoveredUrls = sameDomainUrls.slice(0, limits.maxPages);
            discoverySource = 'sitemap';
          }
        }
      } catch (err) {
        // Graceful fallback: if sitemap fails, use entry URL only
        logger.warn('Sitemap discovery failed, using entry URL only', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 7. Create CrawlJob
    const jobId = `crawl-site-${crypto.randomUUID()}`;
    const CrawlJob = getLazyModel<ICrawlJob>('CrawlJob');
    await CrawlJob.create({
      _id: jobId,
      tenantId,
      status: 'queued',
      strategy: 'intelligence',
      urls: {
        original: [url],
        expanded: discoveredUrls,
        crawled: 0,
        failed: 0,
      },
      configuration: {
        strategy: 'intelligence',
        limits: {
          maxPages: limits.maxPages,
          maxDepth: limits.maxDepth,
          maxLlmCalls: limits.maxLlmCalls,
        },
        discovery: {
          useSitemap: discovery.useSitemap,
          followLinks: discovery.followLinks,
        },
        filters: filters ?? undefined,
      },
      timeline: {
        submittedAt: new Date(),
      },
      results: {
        documentsCreated: 0,
        documentsIndexed: 0,
        documentsFailed: 0,
        chunksCreated: 0,
      },
      processingErrors: [],
      indexId,
      sourceId,
    });

    // 8. Enqueue to intelligence-crawl queue
    const queue = createQueue(QUEUE_INTELLIGENCE_CRAWL);
    const jobData: IntelligenceCrawlJobData = {
      jobId,
      tenantId,
      indexId,
      sourceId,
      entryUrl: url,
      discoveredUrls,
      intent,
      limits: {
        maxPages: limits.maxPages,
        maxDepth: limits.maxDepth,
        maxLlmCalls: limits.maxLlmCalls,
      },
      discovery: {
        useSitemap: discovery.useSitemap,
        followLinks: discovery.followLinks,
      },
      filters,
      groupStrategies,
    };
    await queue.add('intelligence-crawl', jobData, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    });

    // Estimate LLM calls: ~3-5 per page for intelligence
    const estimatedLlmCalls = Math.min(discoveredUrls.length * 4, limits.maxLlmCalls);

    logger.info('Intelligence crawl-site job enqueued', {
      jobId,
      tenantId,
      url,
      discoveredUrlCount: discoveredUrls.length,
      discoverySource,
    });

    return res.json({
      success: true,
      jobId,
      sourceId,
      status: 'queued',
      discovery: {
        source: discoverySource,
        urlCount: discoveredUrls.length,
        sitemapUrls: discoverySource === 'sitemap' ? discoveredUrls : undefined,
      },
      estimatedLlmCalls,
    });
  } catch (err) {
    logger.error('Unexpected error in intelligence crawl-site', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

// ─── GET /intelligence/crawl-site/:jobId ─────────────────────────────────

router.get('/intelligence/crawl-site/:jobId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing tenant context' },
      });
    }

    // Validate jobId param
    const jobIdResult = jobIdParamSchema.safeParse(req.params.jobId);
    if (!jobIdResult.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid job ID' },
      });
    }

    const jobId = jobIdResult.data;

    // Read CrawlJob from MongoDB — verify tenant + strategy
    const CrawlJob = getLazyModel<ICrawlJob>('CrawlJob');
    const crawlJob = await CrawlJob.findOne({
      _id: jobId,
      tenantId,
      strategy: 'intelligence',
    }).lean();

    if (!crawlJob) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Crawl job not found' },
      });
    }

    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: crawlJob.indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Crawl job not found' },
      });
    }

    // Read per-page Redis checkpoints
    const redisClient = getRedis();
    const pageKeyPattern = `intelligence-crawl:page:${tenantId}:${jobId}:*`;
    const pageKeys: string[] = [];
    for await (const k of scanKeys(redisClient, pageKeyPattern)) pageKeys.push(k);

    const pages: Array<{
      url: string;
      status: string;
      startedAt?: string;
      completedAt?: string;
      error?: string;
    }> = [];

    if (pageKeys.length > 0) {
      // Cluster-safe: page keys span URL slots, so a single pipeline would
      // CROSSSLOT. Issue independent GETs in parallel — ioredis Cluster
      // routes each to its owning master.
      const results = await Promise.all(
        pageKeys.map((k) =>
          redisClient.get(k).then(
            (val) => [null, val] as [Error | null, string | null],
            (err: Error) => [err, null] as [Error | null, string | null],
          ),
        ),
      );
      for (const [err, val] of results) {
        if (!err && val && typeof val === 'string') {
          try {
            pages.push(JSON.parse(val));
          } catch {
            // Skip unparseable entries
          }
        }
      }
    }

    // Read SearchDocuments for completed pages
    const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
    const completedDocs = await SearchDocument.find({
      tenantId,
      sourceId: crawlJob.sourceId,
      indexId: crawlJob.indexId,
    })
      .select('_id originalReference status')
      .lean();

    // Pagination
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    const startIdx = (page - 1) * limit;
    const paginatedPages = pages.slice(startIdx, startIdx + limit);

    // Build summary
    const completedCount = pages.filter((p) => p.status === 'completed').length;
    const failedCount = pages.filter((p) => p.status === 'failed').length;
    const processingCount = pages.filter(
      (p) => p.status === 'processing' || p.status === 'started',
    ).length;
    const pendingCount =
      (crawlJob.urls?.expanded?.length ?? 0) - completedCount - failedCount - processingCount;

    return res.json({
      success: true,
      jobId,
      summary: {
        status: crawlJob.status,
        totalUrls: crawlJob.urls?.expanded?.length ?? 0,
        completed: completedCount,
        failed: failedCount,
        processing: processingCount,
        pending: Math.max(0, pendingCount),
        documentsCreated: completedDocs.length,
      },
      pages: paginatedPages,
      pagination: {
        page,
        limit,
        total: pages.length,
        hasMore: startIdx + limit < pages.length,
      },
    });
  } catch (err) {
    logger.error('Error getting intelligence crawl-site status', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

// ─── GET /intelligence/status/:jobId ──────────────────────────────────────

router.get('/intelligence/status/:jobId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing tenant context' },
      });
    }

    // Validate jobId
    const jobIdResult = jobIdParamSchema.safeParse(req.params.jobId);
    if (!jobIdResult.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid job ID' },
      });
    }

    const jobId = jobIdResult.data;
    const redisClient = getRedis();
    const jobStateKey = `intelligence:job:${jobId}`;

    const raw = await redisClient.get(jobStateKey);
    if (!raw) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Job not found' },
      });
    }

    let jobState: Record<string, unknown>;
    try {
      jobState = JSON.parse(raw);
    } catch {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to read job state' },
      });
    }

    // Tenant isolation: return 404 (not 403) per CLAUDE.md
    if (jobState.tenantId !== tenantId) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Job not found' },
      });
    }

    return res.json({
      success: true,
      data: {
        status: jobState.status,
        result: jobState.result,
      },
    });
  } catch (err) {
    logger.error('Error getting intelligence status', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

export const intelligenceRouter: RouterType = router;
