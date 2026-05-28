/**
 * Web Crawler Routes
 *
 * Handle bulk crawl job submission and status tracking.
 * Integrates with Node.js bulk-crawl worker via BullMQ.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { Queue, type Job as BullMQJob } from 'bullmq';
import { getAllQueueStats, getAllQueueHealth } from '../workers/queue-monitor.js';
import { getModel, getLazyModel } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';
import type {
  ICrawlJob,
  ICrawlError,
  ICrawlConfigProfile,
  ICrawlConfigSettings,
} from '@agent-platform/database/models';
import { DocumentStatus, ChunkStatus } from '@agent-platform/search-ai-sdk';
import {
  FastProfiler,
  DecisionEngine,
  PromptEvaluator,
  QuestionGenerator,
  ResponseProcessor,
  StrategyResolver,
  UrlClusterer,
  HttpAdapter,
  FailureScorer,
  QualityGate,
  DiscoveryChain,
  type CrawlDecision,
  type PromptQuestion,
  type QuestionResponse,
  type StrategyConfig,
  type SiteProfile,
  type UrlGroup,
} from '@abl/crawler';
import { z } from 'zod';
import type { GroupStrategy } from '../workers/shared.js';
import { QUEUE_BULK_CRAWL, createQueue } from '../workers/shared.js';
import {
  estimateCrawlDuration,
  type CrawlStrategy,
} from '../services/crawler/duration-estimator.js';
import {
  learnPattern,
  learnPatterns,
  scoreUrl,
  scoreUrlMulti,
} from '../services/crawler/pattern-matcher.js';
import { CircuitBreaker } from '../services/crawler/circuit-breaker.js';
import { analyzeRobotsTxt } from '../services/crawler/robots-analyzer.js';
import { isURLAllowed } from '../utils/ssrf-protection.js';
import {
  createVectorStore,
  resolveIndexForWrite,
  type VectorStoreProvider,
} from '@agent-platform/search-ai-internal';
import type { RedisClient } from '@agent-platform/redis';
import { getSharedRedisClient } from '../workers/shared.js';
import { createLogger } from '@abl/compiler/platform';
import { SOURCE_URL_BUCKET_SIZE } from '@agent-platform/database/models';
import { deleteCrawlAuditForJob } from '../services/crawl-audit-policy.js';
import {
  deleteCrawlAuditEventsForJob,
  writeCrawlAuditEvent,
} from '../services/crawl-audit.service.js';

const router: RouterType = Router();

// Lazy model accessors — models are bound to the correct database connection
// by initMongoBackend() at startup. Using getModel() ensures we get the
// properly-bound instance (platform or content) rather than the default
// mongoose connection (which is never connected in SearchAI).
function getModels() {
  return {
    SearchDocument: getModel('SearchDocument'),
    SearchChunk: getModel('SearchChunk'),
    SearchIndex: getModel('SearchIndex'),
    CrawlJob: getModel('CrawlJob'),
    CrawlHistory: getModel('CrawlHistory'),
    UserCrawlPreference: getModel('UserCrawlPreference'),
    CrawlError: getModel('CrawlError'),
  };
}

// BullMQ queue (singleton)
let crawlQueue: Queue | null = null;

// Crawler intelligence components (singletons)
let profiler: FastProfiler | null = null;
let decisionEngine: DecisionEngine | null = null;
let promptEvaluator: PromptEvaluator | null = null;
let questionGenerator: QuestionGenerator | null = null;
let responseProcessor: ResponseProcessor | null = null;
let strategyResolver: StrategyResolver | null = null;

// Circuit breaker for protecting against problematic sites (singleton)
let circuitBreaker: CircuitBreaker | null = null;

const logger = createLogger('crawl-routes');

// Redis client for pending decisions (lazy singleton)
let pendingRedis: RedisClient | null = null;

function getPendingRedis(): RedisClient {
  if (!pendingRedis) {
    pendingRedis = getSharedRedisClient();
  }
  if (!pendingRedis) {
    throw new Error('Redis not configured — pending decision storage requires Redis');
  }
  return pendingRedis;
}

// Typed context for pending crawl decisions
interface PendingDecisionOptions {
  maxPages?: number;
  maxDepth?: number;
  followLinks?: boolean;
  extractMetadata?: boolean;
  useSitemap?: boolean;
  [key: string]: unknown;
}

interface PendingDecisionContext {
  urls: string[];
  tenantId: string;
  indexId: string;
  sourceId: string;
  userId: string;
  options: PendingDecisionOptions;
  profile: SiteProfile;
}

// Redis-backed store for pending decisions (multi-pod safe)
const PENDING_DECISION_TTL = 3600; // 1 hour

async function storePendingDecision(
  pendingId: string,
  data: { decision: CrawlDecision; questions: PromptQuestion[]; context: PendingDecisionContext },
): Promise<void> {
  const redis = getPendingRedis();
  await redis.setex(`pending:decision:${pendingId}`, PENDING_DECISION_TTL, JSON.stringify(data));
}

async function getPendingDecision(pendingId: string): Promise<{
  decision: CrawlDecision;
  questions: PromptQuestion[];
  context: PendingDecisionContext;
} | null> {
  const redis = getPendingRedis();
  const data = await redis.get(`pending:decision:${pendingId}`);
  if (!data) return null;
  return JSON.parse(data);
}

async function deletePendingDecision(pendingId: string): Promise<void> {
  const redis = getPendingRedis();
  await redis.del(`pending:decision:${pendingId}`);
}

// Initialize BullMQ queue (lazy) — uses cluster-aware createQueue() from shared.ts
function getCrawlQueue(): Queue {
  if (!crawlQueue) {
    crawlQueue = createQueue(QUEUE_BULK_CRAWL);
    logger.info('BullMQ queue initialized', { queue: QUEUE_BULK_CRAWL });
  }

  return crawlQueue;
}

// Initialize crawler intelligence components (lazy)
function getCrawlerComponents() {
  if (!profiler) {
    profiler = new FastProfiler();
    logger.info('FastProfiler initialized');
  }

  if (!decisionEngine) {
    decisionEngine = new DecisionEngine();
    logger.info('DecisionEngine initialized');
  }

  if (!promptEvaluator) {
    promptEvaluator = new PromptEvaluator();
    logger.info('PromptEvaluator initialized');
  }

  if (!questionGenerator) {
    questionGenerator = new QuestionGenerator();
    logger.info('QuestionGenerator initialized');
  }

  if (!responseProcessor) {
    responseProcessor = new ResponseProcessor();
    logger.info('ResponseProcessor initialized');
  }

  if (!strategyResolver) {
    strategyResolver = new StrategyResolver();
    logger.info('StrategyResolver initialized');
  }

  return {
    profiler,
    decisionEngine,
    promptEvaluator,
    questionGenerator,
    responseProcessor,
    strategyResolver,
  };
}

/**
 * Get or initialize circuit breaker
 */
function getCircuitBreaker(): CircuitBreaker {
  if (!circuitBreaker) {
    const redis = getSharedRedisClient();
    if (!redis) throw new Error('Redis not configured — circuit breaker requires Redis');
    circuitBreaker = new CircuitBreaker(redis);
  }
  return circuitBreaker;
}

// ── Shared recrawl helpers ────────────────────────────────────────────────

/**
 * Build a SiteProfile from the stored ICrawlConfigProfile.
 *
 * The stored profile is a flat, nullable subset. We synthesize safe defaults
 * for fields the StrategyResolver reads (linkDensity, rateLimitDetected, etc.).
 */
function buildSiteProfileFromStored(profile: ICrawlConfigProfile): SiteProfile {
  return {
    domain: profile.domain,
    profiledAt: new Date(),
    siteType: (profile.siteType as SiteProfile['siteType']) || 'unknown',
    jsRequired: profile.jsRequired ?? false,
    linkDensity: 0,
    estimatedSize: profile.estimatedSize ?? 0,
    avgResponseTime: profile.avgResponseTime ?? 500,
    rateLimitDetected: false,
    maxConcurrency: 10,
    confidence: 80, // Lower than fresh (100) — cached profile
    metadata: {
      hasSitemap: profile.hasSitemap ?? false,
      sitemapPageCount: profile.sitemapPageCount ?? undefined,
    },
  };
}

/**
 * Parameters for creating a CrawlJob and enqueuing the BullMQ job.
 * Shared between POST /batch and POST /recrawl.
 */
interface CreateCrawlJobParams {
  tenantId: string;
  userId: string;
  indexId: string;
  sourceId: string;
  urls: string[];
  resolvedParams: import('@abl/crawler').ResolvedCrawlParams;
  crawlSettings: {
    crawlDelay: number;
    respectRobotsTxt: boolean;
    cleanupLevel: 'standard' | 'aggressive' | 'none';
    deduplicate: boolean;
    cookieConsent: boolean;
    reuseHandlers: boolean;
  };
  decision: CrawlDecision;
  sectionMapping?: Array<{
    sectionId: string;
    pattern: string;
    name: string;
    urls: string[];
    strategy: 'http' | 'browser';
  }>;
  filters?: Record<string, unknown>;
  forceReprocess: boolean;
  previousJobId?: string;
  options?: Record<string, unknown>;
  /** Whether URLs were expanded (e.g. sitemap). Only used for response metadata. */
  urlExpansion?: { expanded: boolean; source: string; originalCount: number };
}

/**
 * Create a CrawlJob record, transition source status, and enqueue BullMQ job.
 *
 * This is the core "execute crawl" path shared between first-time crawl and recrawl.
 * Does NOT handle profiling, decision-making, or prompt evaluation — callers handle those.
 */
async function createCrawlJobAndEnqueue(
  params: CreateCrawlJobParams,
): Promise<{ jobId: string; batchId: string }> {
  const {
    tenantId,
    userId,
    indexId,
    sourceId,
    urls,
    resolvedParams,
    crawlSettings,
    decision,
    sectionMapping,
    filters,
    forceReprocess,
    previousJobId,
    options,
  } = params;

  const { CrawlJob } = getModels();
  const SearchSource = getModel('SearchSource');
  const batchId = `batch-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  // 1. Create CrawlJob record
  let crawlJobId: string;
  try {
    const crawlJobRecord = new CrawlJob({
      _id: batchId,
      tenantId,
      userId,
      status: 'queued',
      strategy: resolvedParams.internalStrategy as any,
      urls: {
        original: urls,
        expanded: [],
        crawled: 0,
        failed: 0,
      },
      configuration: {
        strategy: resolvedParams.requestedStrategy || resolvedParams.internalStrategy,
        limits: {
          maxPages: resolvedParams.limits.maxPages,
          maxDurationMinutes: resolvedParams.limits.maxDurationMs
            ? Math.floor(resolvedParams.limits.maxDurationMs / 60000)
            : undefined,
          maxDepth: resolvedParams.limits.maxDepth,
        },
        discovery: {
          useSitemap: resolvedParams.discovery.useSitemap,
          followLinks: resolvedParams.discovery.followLinks,
          respectRobotsTxt: crawlSettings.respectRobotsTxt,
        },
        crawlDelay: crawlSettings.crawlDelay,
        maxConcurrent: 3,
        filters: filters ?? undefined,
        ...(sectionMapping && sectionMapping.length > 0 ? { sectionMapping } : {}),
      },
      ...(previousJobId ? { comparison: { previousJobId } } : {}),
      timeline: { submittedAt: new Date() },
      results: {
        documentsCreated: 0,
        documentsIndexed: 0,
        documentsFailed: 0,
        chunksCreated: 0,
      },
      errors: [],
      indexId,
      sourceId,
    });

    await crawlJobRecord.save();
    crawlJobId = crawlJobRecord._id;

    await writeCrawlAuditEvent({
      tenantId,
      crawlJobId,
      userId,
      eventType: 'crawl.started',
      description: `Crawl job submitted for ${urls.length} URL(s)`,
      context: {
        strategy: resolvedParams.internalStrategy,
        urls: urls.length,
        ...(previousJobId ? { previousJobId, isRecrawl: true } : {}),
      },
      severity: 'info',
    });

    logger.info('CrawlJob record created', { crawlJobId, previousJobId });
  } catch (historyError) {
    logger.error('Failed to create CrawlJob record', {
      error: historyError instanceof Error ? historyError.message : String(historyError),
    });
    crawlJobId = batchId;
  }

  // 2. Source status transition
  const currentSource = await SearchSource.findOne({ _id: sourceId, tenantId })
    .select('status')
    .lean();

  if (currentSource) {
    const currentStatus = (currentSource as any).status;
    if (currentStatus === 'configuring') {
      await SearchSource.findOneAndUpdate(
        { _id: sourceId, tenantId },
        {
          $set: {
            status: 'pending',
            'crawlConfig.wizardStep': null,
            'crawlConfig.configExpiresAt': null,
            'crawlConfig.crawlJobId': crawlJobId,
          },
        },
      );
    } else if (currentStatus === 'active') {
      await SearchSource.findOneAndUpdate(
        { _id: sourceId, tenantId },
        {
          $set: {
            'crawlConfig.wizardStep': null,
            'crawlConfig.crawlJobId': crawlJobId,
          },
        },
      );
    }
  }

  // 3. Enqueue BullMQ job
  const queue = getCrawlQueue();
  const job = await queue.add(
    'crawl-batch',
    {
      urls,
      strategy: {
        followLinks: resolvedParams.discovery.followLinks,
        maxPages: resolvedParams.limits.maxPages,
        maxDepth: resolvedParams.limits.maxDepth,
        sameDomainOnly: true,
      },
      filters: filters ?? undefined,
      options: {
        maxDepth: resolvedParams.limits.maxDepth,
        followLinks: resolvedParams.discovery.followLinks,
        extractMetadata: (options as any)?.extractMetadata ?? true,
        maxPages: resolvedParams.limits.maxPages,
        useSitemap: resolvedParams.discovery.useSitemap,
        strategy: decision.strategy,
        batchSize: resolvedParams.batchSize,
        concurrency: resolvedParams.concurrency,
        jsHandling: resolvedParams.jsHandling,
      },
      resolvedStrategy: {
        requestedStrategy: resolvedParams.requestedStrategy,
        internalStrategy: resolvedParams.internalStrategy,
        discovery: resolvedParams.discovery,
        limits: resolvedParams.limits,
        fallbackApplied: resolvedParams.fallbackApplied,
        reasoning: resolvedParams.reasoning,
      },
      batchId,
      jobId: batchId,
      tenantId,
      indexId,
      sourceId,
      userId,
      sectionMapping: sectionMapping ?? [],
      crawlSettings: {
        crawlDelay: crawlSettings.crawlDelay ?? 1000,
        respectRobotsTxt: crawlSettings.respectRobotsTxt ?? true,
        cleanupLevel: crawlSettings.cleanupLevel ?? 'standard',
        deduplicate: crawlSettings.deduplicate ?? true,
        cookieConsent: crawlSettings.cookieConsent ?? true,
        reuseHandlers: crawlSettings.reuseHandlers ?? true,
      },
      forceReprocess: forceReprocess ?? false,
    },
    {
      jobId: undefined,
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 604800 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 60000 },
      priority: Math.min(urls.length, 10),
    },
  );

  logger.info('BullMQ job submitted', {
    jobId: job.id,
    batchId,
    urls: urls.length,
    strategy: resolvedParams.requestedStrategy,
    internalStrategy: resolvedParams.internalStrategy,
    isRecrawl: !!previousJobId,
  });

  return { jobId: crawlJobId, batchId };
}

/**
 * POST /api/crawl/batch - Submit bulk crawl job with intelligent profiling
 *
 * Request body:
 * {
 *   urls: string[]                    // URLs to crawl
 *   tenantId: string                  // Tenant ID for isolation
 *   indexId: string                   // SearchAI index ID for ingestion
 *   sourceId: string                  // SearchAI source ID for ingestion
 *   userId?: string                   // User ID for preferences
 *   strategy?: string                 // User-facing strategy (single-page, sitemap, smart, limited, full-site)
 *   limits?: {                        // Strategy-specific limits
 *     maxPages?: number               // Maximum pages to crawl
 *     maxDurationMinutes?: number     // Maximum duration
 *     maxDepth?: number               // Maximum depth for link following
 *   }
 *   fallbackStrategy?: string         // Fallback if primary strategy fails
 *   options?: {                       // @deprecated Legacy API (backward compat)
 *     maxDepth?: number               // Maximum crawl depth (default: 3)
 *     followLinks?: boolean           // Follow links (default: true)
 *     extractMetadata?: boolean       // Extract metadata (default: true)
 *     maxPages?: number               // Maximum pages per job (default: 50)
 *     useSitemap?: boolean            // Enable sitemap URL expansion (default: true)
 *   }
 * }
 *
 * URL Expansion:
 * - If single URL + sitemap exists + useSitemap !== false → URLs expanded from sitemap
 * - Expansion respects maxPages limit (from strategy limits or options)
 * - Graceful fallback: if sitemap parsing fails, uses original URLs
 *
 * Response (when prompts needed):
 * {
 *   success: true,
 *   needsUserInput: true,
 *   pendingId: string,
 *   questions: PromptQuestion[],
 *   decision: CrawlDecision,
 *   profile: SiteProfile
 * }
 *
 * Response (when no prompts needed):
 * {
 *   success: true,
 *   needsUserInput: false,
 *   jobId: string,
 *   batchId: string,
 *   urls: number,
 *   status: 'queued',
 *   urlExpansion: {
 *     expanded: boolean,              // Whether URLs were expanded
 *     source: 'sitemap' | 'none',     // Source of expansion
 *     originalCount: number,          // Original URL count
 *     expandedCount: number           // Expanded URL count
 *   },
 *   strategy: StrategyInfo,
 *   decision: CrawlDecision,
 *   warnings: string[]
 * }
 */
router.post('/batch', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { tenantId, userId } = req.tenantContext;
    const {
      indexId,
      sourceId,
      strategy,
      limits,
      fallbackStrategy,
      filters,
      options = {},
      sectionMapping,
      respectRobotsTxt,
      crawlDelay,
      maxConcurrent,
      documentUrls,
    } = req.body;

    // Frontend sends crawl settings nested under `crawlSettings` key;
    // legacy callers may send them at top level. Merge both, nested takes precedence.
    const nestedSettings = req.body.crawlSettings ?? {};

    // Validate optional crawl settings
    const crawlSettingsSchema = z.object({
      respectRobotsTxt: z.boolean().optional().default(true),
      crawlDelay: z
        .number()
        .max(30000)
        .optional()
        .transform((v) => (v !== undefined && v < 200 ? 200 : v)),
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
      forceReprocess: z.boolean().optional().default(false),
    });

    // Validate sectionMapping if provided
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

    const sectionMappingParsed = sectionMappingSchema.safeParse(sectionMapping);
    if (!sectionMappingParsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: sectionMappingParsed.error.message,
        },
      });
      return;
    }
    const parsedSectionMapping = sectionMappingParsed.data;

    const settingsParsed = crawlSettingsSchema.safeParse({
      respectRobotsTxt: nestedSettings.respectRobotsTxt ?? respectRobotsTxt,
      crawlDelay: nestedSettings.crawlDelay ?? crawlDelay,
      maxConcurrent: nestedSettings.maxConcurrent ?? maxConcurrent,
      cleanupLevel: nestedSettings.cleanupLevel ?? req.body.cleanupLevel,
      deduplicate: nestedSettings.deduplicate ?? req.body.deduplicate,
      cookieConsent: nestedSettings.cookieConsent ?? req.body.cookieConsent,
      reuseHandlers: nestedSettings.reuseHandlers ?? req.body.reuseHandlers,
      documentUrls: nestedSettings.documentUrls ?? documentUrls,
    });

    if (!settingsParsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: settingsParsed.error.message,
        },
      });
      return;
    }

    const crawlSettings = settingsParsed.data;

    // Use let for urls since it may be reassigned during sitemap expansion
    let urls = req.body.urls;

    // Validate required fields
    if (!indexId || typeof indexId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Missing required field: indexId',
      });
      return;
    }

    if (!sourceId || typeof sourceId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Missing required field: sourceId',
      });
      return;
    }

    // Validate URLs
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid URLs: must be a non-empty array',
      });
      return;
    }

    // Validate URL format
    const invalidUrls = urls.filter((url: any) => {
      if (typeof url !== 'string') return true;
      try {
        new URL(url);
        return false;
      } catch {
        return true;
      }
    });

    if (invalidUrls.length > 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid URL format',
        invalidUrls: invalidUrls.slice(0, 5),
      });
      return;
    }

    // Validate URL count — raised from 1000 for V2 bulk crawl (D13: full URL storage)
    // The bulk-crawl worker processes URLs in a sliding window so large lists are safe.
    const MAX_BATCH_URLS = 50_000;
    if (urls.length > MAX_BATCH_URLS) {
      res.status(400).json({
        success: false,
        error: `Too many URLs: maximum ${MAX_BATCH_URLS} per batch`,
        provided: urls.length,
      });
      return;
    }

    // SSRF protection: validate all URLs before processing
    const blockedURLs: Array<{ url: string; reason: string }> = [];
    for (const url of urls as string[]) {
      const check = await isURLAllowed(url);
      if (!check.allowed) {
        blockedURLs.push({ url, reason: check.reason || 'Blocked by SSRF protection' });
      }
    }

    if (blockedURLs.length > 0) {
      logger.warn('SSRF protection blocked URLs in batch crawl', {
        tenantId,
        userId,
        blocked: blockedURLs.length,
        total: urls.length,
      });
      res.status(400).json({
        success: false,
        error: 'SSRF_PROTECTION',
        message:
          'Some URLs are blocked by security policy (private IPs or internal endpoints are not allowed)',
        blockedURLs: blockedURLs.slice(0, 10),
        hint: 'Only public HTTP(S) URLs are allowed for crawling',
      });
      return;
    }

    // Validate index and source exist for this tenant BEFORE crawling
    const SearchIndex = getModel('SearchIndex');
    const SearchSource = getModel('SearchSource');

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({
        success: false,
        error: 'Index not found',
        hint: 'Ensure the indexId belongs to your tenant',
      });
      return;
    }

    const source = await SearchSource.findOne({ _id: sourceId, indexId, tenantId }).lean();
    if (!source) {
      res.status(404).json({
        success: false,
        error: 'Source not found for this index',
        hint: 'Ensure the sourceId belongs to the specified index and tenant',
      });
      return;
    }

    // Initialize crawler components
    const components = getCrawlerComponents();
    const cb = getCircuitBreaker();

    // Profile the first URL to understand the site
    const targetUrl = urls[0];

    // Check circuit breaker before profiling
    const circuitState = await cb.isOpen(targetUrl, tenantId);
    if (circuitState.blocked) {
      logger.warn('Circuit breaker blocked batch crawl request', {
        url: targetUrl,
        tenantId,
        resetAt: circuitState.resetAt,
        failureCount: circuitState.failureCount,
      });
      res.status(503).json({
        success: false,
        error: 'Site temporarily blocked',
        code: 'CIRCUIT_BREAKER_OPEN',
        resetAt: circuitState.resetAt?.toISOString(),
        message: `This site has been temporarily blocked due to repeated failures. Please try again at ${circuitState.resetAt?.toLocaleTimeString() || 'in a few minutes'}.`,
      });
      return;
    }

    logger.info('Profiling site for batch crawl', { url: targetUrl, tenantId });

    let profile;
    try {
      profile = await components.profiler.profile(targetUrl, {
        timeout: 10000,
        thoroughness: 'quick', // Use quick profiling for API responsiveness
      });
    } catch (profileError) {
      // Record profile failure with circuit breaker
      await cb.recordFailure(
        targetUrl,
        tenantId,
        profileError instanceof Error ? profileError.message : String(profileError),
      );

      logger.error('Profile failed for batch crawl', {
        url: targetUrl,
        tenantId,
        error: profileError instanceof Error ? profileError.message : String(profileError),
      });

      // Rethrow to be handled by outer catch
      throw profileError;
    }

    logger.info('Profile complete for batch crawl', {
      url: targetUrl,
      tenantId,
      domain: profile.domain,
      siteType: profile.siteType,
      estimatedSize: profile.estimatedSize,
    });

    // Record successful profile with circuit breaker
    await cb.recordSuccess(targetUrl, tenantId);

    // Sitemap URL expansion (if applicable)
    let urlsExpanded = false;
    let expandedFrom: 'sitemap' | 'none' = 'none';
    const originalUrlCount = urls.length;

    // Expand URLs from sitemap if:
    // 1. Only one URL provided (user wants site crawl, not specific URLs)
    // 2. Sitemap exists
    // 3. Strategy uses sitemap discovery (checked via resolvedParams.discovery.useSitemap)
    // 4. Not explicitly disabled
    if (
      urls.length === 1 &&
      !parsedSectionMapping?.length &&
      profile.metadata.hasSitemap &&
      options.useSitemap !== false
    ) {
      try {
        logger.info('Sitemap detected, expanding URL list...');

        const maxUrlsForExpansion = options.maxPages ?? limits?.maxPages ?? 50;

        const sitemapResult = await components.profiler.discoverSitemapUrls(
          targetUrl,
          maxUrlsForExpansion,
        );

        if (sitemapResult.allUrls.length > 0) {
          urls = sitemapResult.allUrls;
          urlsExpanded = true;
          expandedFrom = 'sitemap';

          logger.info('URL expansion successful', {
            originalCount: originalUrlCount,
            expandedCount: urls.length,
            source: 'sitemap',
          });
        } else {
          logger.info('Sitemap returned no URLs, using original URL');
        }
      } catch (error) {
        // Graceful fallback: if sitemap parsing fails, use original URLs
        logger.warn('Failed to expand URLs from sitemap, using original URLs', {
          error: error instanceof Error ? error.message : String(error),
        });
        // urls remains unchanged (fallback to original)
      }
    }

    // Resolve strategy to internal crawl parameters
    // Accept 'playwright' as a strategy hint — map to 'smart' with browser options
    const isPlaywright = strategy === 'playwright';
    const strategyConfig: StrategyConfig = {
      strategy: isPlaywright ? 'smart' : strategy,
      limits,
      fallbackStrategy,
      options: isPlaywright ? { ...options, forcePlaywright: true } : options,
    };

    const strategyResult = await components.strategyResolver.resolve(strategyConfig, profile);

    // Check for strategy validation errors
    if (strategyResult.errors.length > 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid strategy configuration',
        errors: strategyResult.errors,
        warnings: strategyResult.warnings,
      });
      return;
    }

    // Log warnings if any
    if (strategyResult.warnings.length > 0) {
      logger.warn('Strategy warnings', { warnings: strategyResult.warnings });
    }

    const resolvedParams = strategyResult.params;

    logger.info('Strategy resolved', {
      requestedStrategy: resolvedParams.requestedStrategy,
      internalStrategy: resolvedParams.internalStrategy,
      discovery: resolvedParams.discovery,
      fallbackApplied: resolvedParams.fallbackApplied,
      reasoning: resolvedParams.reasoning,
    });

    // Make crawl decision (for backward compatibility and advanced tuning)
    const decisionContext = {
      url: targetUrl,
      tenantId,
      userId,
      profile,
      estimatedUrlCount: urls.length,
    };

    const decision = await components.decisionEngine.decide(decisionContext);

    logger.info('Decision made', {
      strategy: decision.strategy,
      confidence: decision.confidence,
      source: decision.source,
    });

    // Evaluate if user prompt is needed
    const evaluation = await components.promptEvaluator.evaluate(decision, decisionContext);

    logger.info('Prompt evaluation', {
      shouldPrompt: evaluation.shouldPrompt,
      reason: evaluation.reason,
      skipRule: evaluation.skipRule,
    });

    // If prompts are needed, generate questions and return them
    // Skip when options.skipPrompts is set (e.g. crawl flow already collected user config)
    if (evaluation.shouldPrompt && !options.skipPrompts) {
      const questions = components.questionGenerator.generate(decision, decisionContext);

      // Generate cryptographically secure pending ID
      const pendingId = `pending-${crypto.randomUUID()}`;

      // Store pending decision in Redis (multi-pod safe)
      await storePendingDecision(pendingId, {
        decision,
        questions,
        context: { urls, tenantId, indexId, sourceId, userId, options, profile },
      });

      logger.info('User input needed', {
        pendingId,
        questions: questions.length,
      });

      res.status(200).json({
        success: true,
        needsUserInput: true,
        pendingId,
        questions,
        decision,
        profile: {
          domain: profile.domain,
          siteType: profile.siteType,
          estimatedSize: profile.estimatedSize,
          avgResponseTime: profile.avgResponseTime,
        },
      });
      return;
    }

    // No prompts needed, proceed with crawl via shared function
    const { jobId, batchId } = await createCrawlJobAndEnqueue({
      tenantId,
      userId,
      indexId,
      sourceId,
      urls,
      resolvedParams,
      crawlSettings: {
        crawlDelay: crawlSettings.crawlDelay ?? 1000,
        respectRobotsTxt: crawlSettings.respectRobotsTxt ?? true,
        cleanupLevel: crawlSettings.cleanupLevel ?? 'standard',
        deduplicate: crawlSettings.deduplicate ?? true,
        cookieConsent: crawlSettings.cookieConsent ?? true,
        reuseHandlers: crawlSettings.reuseHandlers ?? true,
      },
      decision,
      sectionMapping: parsedSectionMapping ?? undefined,
      filters: filters ?? undefined,
      forceReprocess: crawlSettings.forceReprocess ?? false,
      options,
    });

    res.status(200).json({
      success: true,
      needsUserInput: false,
      jobId,
      batchId,
      urls: urls.length,
      status: 'queued',
      urlExpansion: {
        expanded: urlsExpanded,
        source: expandedFrom,
        originalCount: originalUrlCount,
        expandedCount: urls.length,
      },
      strategy: {
        requested: resolvedParams.requestedStrategy,
        internal: resolvedParams.internalStrategy,
        reasoning: resolvedParams.reasoning,
        fallbackApplied: resolvedParams.fallbackApplied,
        discovery: resolvedParams.discovery,
        limits: resolvedParams.limits,
      },
      decision: {
        strategy: decision.strategy,
        batchSize: decision.batchSize,
        concurrency: decision.concurrency,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
      },
      warnings: strategyResult.warnings,
    });
  } catch (error) {
    logger.error('Failed to process crawl request', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to process crawl request',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

// ── POST /recrawl ─────────────────────────────────────────────────────────

/**
 * POST /api/crawl/recrawl - Re-run a crawl using stored configuration
 *
 * Reads all config from the backend (SearchSource.crawlConfig + latest CrawlJob).
 * Frontend only sends sourceId + indexId + optional forceReprocess.
 *
 * Request body:
 * {
 *   sourceId: string,
 *   indexId: string,
 *   forceReprocess?: boolean    // Skip deduplication (force re-extract all pages)
 * }
 *
 * Response: same shape as POST /batch (success case, needsUserInput: false)
 */
router.post('/recrawl', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { tenantId, userId } = req.tenantContext;

    // 1. Validate request body
    const recrawlSchema = z
      .object({
        sourceId: z.string().min(1),
        indexId: z.string().min(1),
        forceReprocess: z.boolean().optional().default(false),
      })
      .strict();

    const parsed = recrawlSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
      return;
    }

    const { sourceId, indexId, forceReprocess } = parsed.data;

    // 2. Load source (tenant-scoped)
    const SearchSource = getModel('SearchSource');
    const source = await SearchSource.findOne({ _id: sourceId, indexId, tenantId }).lean();
    if (!source) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Source not found for this index and tenant' },
      });
      return;
    }

    // 3. Guard: source status — reject if crawl already in progress
    const currentStatus = (source as any).status;
    if (['pending', 'syncing'].includes(currentStatus)) {
      res.status(409).json({
        success: false,
        error: {
          code: 'CRAWL_IN_PROGRESS',
          message: `Source status is '${currentStatus}' — cannot start a new crawl`,
        },
      });
      return;
    }

    // 4. Load latest CrawlJob for this source
    const { CrawlJob } = getModels();
    const previousJob = await CrawlJob.findOne({ sourceId, tenantId })
      .sort({ 'timeline.submittedAt': -1 })
      .lean();

    if (!previousJob) {
      res.status(400).json({
        success: false,
        error: {
          code: 'NO_PREVIOUS_CRAWL',
          message: 'No previous crawl found for this source. Use POST /batch for the first crawl.',
        },
      });
      return;
    }

    const prevJob = previousJob as any;
    const crawlConfig = (source as any).crawlConfig;

    // 5. Extract URLs from previous job
    const urls: string[] = prevJob.urls?.original ?? [];
    if (urls.length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'NO_URLS', message: 'Previous crawl has no URLs to recrawl' },
      });
      return;
    }

    // 6. SSRF re-validation — blocklist may have changed since original crawl
    const blockedUrls: Array<{ url: string; reason: string }> = [];
    for (const url of urls) {
      const allowed = await isURLAllowed(url);
      if (!allowed) {
        blockedUrls.push({ url, reason: 'Blocked by SSRF protection' });
      }
    }
    const safeUrls = urls.filter((u) => !blockedUrls.find((b) => b.url === u));
    if (safeUrls.length === 0) {
      res.status(400).json({
        success: false,
        error: {
          code: 'ALL_URLS_BLOCKED',
          message: 'All URLs are now blocked by SSRF protection',
          blockedCount: blockedUrls.length,
        },
      });
      return;
    }
    if (blockedUrls.length > 0) {
      logger.warn('Some recrawl URLs blocked by SSRF', {
        sourceId,
        blockedCount: blockedUrls.length,
        totalUrls: urls.length,
      });
    }

    // 7. Build SiteProfile from stored profile (skip network profiling)
    const storedProfile = crawlConfig?.profile;
    let siteProfile: SiteProfile;
    if (storedProfile?.domain) {
      siteProfile = buildSiteProfileFromStored(storedProfile);
    } else {
      // Edge case: no stored profile — fall back to quick network profiling
      logger.warn('No stored profile for recrawl, falling back to network profiling', {
        sourceId,
      });
      const components = getCrawlerComponents();
      siteProfile = await components.profiler.profile(safeUrls[0], {
        timeout: 10000,
        thoroughness: 'quick',
      });
    }

    // 8. Build crawl settings from source config
    //    Field mapping: ICrawlConfigSettings.requestDelay → crawlSettings.crawlDelay
    const settings: ICrawlConfigSettings | null = crawlConfig?.settings ?? null;
    const crawlSettings = {
      crawlDelay: (settings?.requestDelay as number) ?? 1000,
      respectRobotsTxt: settings?.respectRobotsTxt ?? true,
      cleanupLevel: (settings?.cleanup as 'standard' | 'aggressive' | 'none') ?? 'standard',
      deduplicate: settings?.deduplicate ?? true,
      cookieConsent: settings?.cookieConsent ?? true,
      reuseHandlers: settings?.reuseHandlers ?? true,
    };

    // 9. Build section mapping from stored sections
    const storedSections = crawlConfig?.sections;
    const sectionMapping = storedSections
      ? storedSections
          .filter((s: any) => s.included !== false)
          .map((s: any) => ({
            sectionId: s.sectionId,
            pattern: s.pattern,
            name: s.name,
            urls: s.urls ?? [],
            strategy: s.strategy ?? 'http',
          }))
      : [];

    // 10. Resolve strategy using stored user-facing strategy
    const userStrategy = prevJob.configuration?.strategy ?? 'smart';
    const storedLimits = prevJob.configuration?.limits;

    const components = getCrawlerComponents();
    const strategyResult = await components.strategyResolver.resolve(
      {
        strategy: userStrategy,
        limits: {
          maxPages: storedLimits?.maxPages ?? safeUrls.length,
          maxDepth: storedLimits?.maxDepth ?? 10,
          maxDurationMinutes: storedLimits?.maxDurationMinutes,
        },
      },
      siteProfile,
    );

    if (strategyResult.errors.length > 0) {
      res.status(400).json({
        success: false,
        error: {
          code: 'STRATEGY_ERROR',
          message: 'Failed to resolve crawl strategy for recrawl',
          errors: strategyResult.errors,
        },
      });
      return;
    }

    const resolvedParams = strategyResult.params;

    // 11. Synthetic decision (skip decision engine + prompt evaluator for recrawl)
    const decision: CrawlDecision = {
      strategy: resolvedParams.internalStrategy as any,
      confidence: 100,
      source: 'user-override',
      reasoning: `Recrawl of source ${sourceId} using stored configuration`,
      batchSize: resolvedParams.batchSize,
      concurrency: resolvedParams.concurrency,
      jsHandling: resolvedParams.jsHandling,
    };

    // 12. Stored filters from previous job
    const filters = prevJob.configuration?.filters ?? {};

    // 13. Create CrawlJob + transition source + enqueue BullMQ
    const { jobId, batchId } = await createCrawlJobAndEnqueue({
      tenantId,
      userId,
      indexId,
      sourceId,
      urls: safeUrls,
      resolvedParams,
      crawlSettings,
      decision,
      sectionMapping: sectionMapping.length > 0 ? sectionMapping : undefined,
      filters,
      forceReprocess,
      previousJobId: String(prevJob._id),
    });

    // 14. Response (same shape as POST /batch success)
    res.status(200).json({
      success: true,
      needsUserInput: false,
      jobId,
      batchId,
      urls: safeUrls.length,
      status: 'queued',
      urlExpansion: {
        expanded: false,
        source: 'none',
        originalCount: safeUrls.length,
        expandedCount: safeUrls.length,
      },
      strategy: {
        requested: resolvedParams.requestedStrategy,
        internal: resolvedParams.internalStrategy,
        reasoning: resolvedParams.reasoning,
        fallbackApplied: resolvedParams.fallbackApplied,
        discovery: resolvedParams.discovery,
        limits: resolvedParams.limits,
      },
      decision: {
        strategy: decision.strategy,
        batchSize: decision.batchSize,
        concurrency: decision.concurrency,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
      },
      previousJobId: String(prevJob._id),
      warnings: strategyResult.warnings,
      ...(blockedUrls.length > 0
        ? { blockedUrls: { count: blockedUrls.length, total: urls.length } }
        : {}),
    });
  } catch (error) {
    logger.error('Failed to process recrawl request', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to process recrawl request',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /api/crawl/batch/respond - Respond to crawl questions and proceed
 *
 * Request body:
 * {
 *   pendingId: string,
 *   responses: QuestionResponse[]
 * }
 *
 * Response:
 * {
 *   success: true,
 *   jobId: string,
 *   batchId: string,
 *   urls: number,
 *   status: 'queued',
 *   decision: CrawlDecision
 * }
 */
router.post('/batch/respond', async (req: Request, res: Response) => {
  try {
    // Enforce tenant authentication
    if (!req.tenantContext) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { pendingId, responses } = req.body;

    // Validate required fields
    if (!pendingId || typeof pendingId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Missing required field: pendingId',
      });
      return;
    }

    if (!responses || !Array.isArray(responses)) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: responses (must be array)',
      });
      return;
    }

    // Retrieve pending decision from Redis
    const pending = await getPendingDecision(pendingId);
    if (!pending) {
      res.status(404).json({
        success: false,
        error: 'Pending decision not found or expired',
        pendingId,
        hint: 'Decisions expire after 1 hour. Please start a new crawl.',
      });
      return;
    }

    // Verify tenant ownership — prevent cross-tenant access
    if (pending.context.tenantId !== req.tenantContext.tenantId) {
      res.status(404).json({
        success: false,
        error: 'Pending decision not found or expired',
      });
      return;
    }

    // Clean up used decision
    await deletePendingDecision(pendingId);

    // Validate index and source still exist before proceeding
    const SearchIndex = getModel('SearchIndex');
    const SearchSource = getModel('SearchSource');

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter(
        { _id: pending.context.indexId, tenantId: pending.context.tenantId },
        req.tenantContext!,
      ),
    ).lean();
    if (!index) {
      res.status(404).json({
        success: false,
        error: 'Index not found (may have been deleted since crawl was initiated)',
      });
      return;
    }

    const source = await SearchSource.findOne({
      _id: pending.context.sourceId,
      indexId: pending.context.indexId,
      tenantId: pending.context.tenantId,
    }).lean();
    if (!source) {
      res.status(404).json({
        success: false,
        error: 'Source not found for this index (may have been deleted since crawl was initiated)',
      });
      return;
    }

    // Initialize components
    const components = getCrawlerComponents();

    // Build context for response processor
    const context = {
      url: pending.context.urls[0],
      tenantId: pending.context.tenantId,
      userId: pending.context.userId,
      profile: pending.context.profile,
    };

    // Coerce response values to correct types based on question definitions
    // (form inputs may send numbers as strings)
    const typedResponses = responses.map((response: QuestionResponse) => {
      const question = pending.questions.find((q) => q.id === response.questionId);
      if (!question) return response;

      let coercedValue = response.value;

      // Coerce based on question type
      if (question.type === 'range' && typeof response.value === 'string') {
        const parsed = parseFloat(response.value);
        if (!isNaN(parsed)) {
          coercedValue = parsed;
        }
      } else if (question.type === 'confirm' && typeof response.value === 'string') {
        coercedValue = response.value === 'true' || response.value === '1';
      }

      return {
        ...response,
        value: coercedValue,
      };
    });

    // Apply user responses to decision
    const result = await components.responseProcessor.applyResponses(
      pending.decision,
      pending.questions,
      typedResponses,
      context,
    );

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: 'Failed to apply responses',
        details: result.error,
      });
      return;
    }

    const updatedDecision = result.updatedDecision!;

    logger.info('Responses applied', {
      pendingId,
      responses: responses.length,
      preferencesSaved: result.preferencesSaved,
      decision: {
        strategy: updatedDecision.strategy,
        confidence: updatedDecision.confidence,
      },
    });

    // Generate batch ID
    const { CrawlJob } = getModels();
    const batchId = `batch-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Create CrawlJob record FIRST
    let crawlJobId: string;
    try {
      const crawlJobRecord = new CrawlJob({
        _id: batchId,
        tenantId: pending.context.tenantId,
        userId: pending.context.userId,
        status: 'queued',
        strategy: updatedDecision.strategy as any,
        urls: {
          original: pending.context.urls,
          expanded: [],
          crawled: 0,
          failed: 0,
        },
        configuration: {
          strategy: updatedDecision.strategy,
          limits: {
            maxPages: pending.context.options.maxPages,
            maxDepth: pending.context.options.maxDepth,
          },
          discovery: {
            followLinks: pending.context.options.followLinks,
            respectRobotsTxt: true,
          },
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
        errors: [],
        indexId: pending.context.indexId,
        sourceId: pending.context.sourceId,
      });

      await crawlJobRecord.save();
      crawlJobId = crawlJobRecord._id;

      await writeCrawlAuditEvent({
        tenantId: pending.context.tenantId,
        crawlJobId: crawlJobId,
        userId: pending.context.userId,
        eventType: 'strategy.user_overridden',
        description: `User confirmed crawl strategy after prompts`,
        context: {
          strategy: updatedDecision.strategy,
          urls: pending.context.urls.length,
        },
        severity: 'info',
      });

      logger.info('History record created', { crawlJobId });
    } catch (historyError) {
      logger.error('Failed to create history record', {
        error: historyError instanceof Error ? historyError.message : String(historyError),
      });
      crawlJobId = batchId;
    }

    // Add job to BullMQ queue with updated decision
    const queue = getCrawlQueue();
    const job = await queue.add(
      'crawl-batch',
      {
        urls: pending.context.urls,
        strategy: {
          followLinks: pending.context.options.followLinks ?? true,
          maxPages: pending.context.options.maxPages ?? 50,
          maxDepth: pending.context.options.maxDepth ?? 3,
          sameDomainOnly: true,
        },
        options: {
          maxDepth: pending.context.options.maxDepth ?? 3,
          followLinks: pending.context.options.followLinks ?? true,
          extractMetadata: pending.context.options.extractMetadata ?? true,
          maxPages: pending.context.options.maxPages ?? 50,
          // Add user-confirmed decision parameters
          strategy: updatedDecision.strategy,
          batchSize: updatedDecision.batchSize,
          concurrency: updatedDecision.concurrency,
          jsHandling: updatedDecision.jsHandling,
        },
        batchId,
        jobId: batchId,
        tenantId: pending.context.tenantId,
        indexId: pending.context.indexId,
        sourceId: pending.context.sourceId,
        userId: pending.context.userId,
      },
      {
        jobId: undefined,
        removeOnComplete: {
          age: 86400, // Keep completed jobs for 24 hours
          count: 1000, // Keep last 1000 completed jobs
        },
        removeOnFail: {
          age: 604800, // Keep failed jobs for 7 days
        },
      },
    );

    logger.info('Job submitted after user response', {
      jobId: job.id,
      batchId,
      urls: pending.context.urls.length,
    });

    res.status(200).json({
      success: true,
      jobId: batchId,
      batchId,
      urls: pending.context.urls.length,
      status: 'queued',
      decision: {
        strategy: updatedDecision.strategy,
        batchSize: updatedDecision.batchSize,
        concurrency: updatedDecision.concurrency,
        confidence: updatedDecision.confidence,
        reasoning: updatedDecision.reasoning,
      },
      preferencesSaved: result.preferencesSaved,
    });
  } catch (error) {
    logger.error('Failed to process response', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to process response',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/search-ai/crawl/preview-urls - Preview discoverable URLs from a site
 *
 * Query params:
 *   url: string (required) - The site URL to preview
 *   limit: number (optional, default 500) - Max URLs to return
 *
 * Response:
 * {
 *   success: true,
 *   urls: Array<{ url: string }>,
 *   source: 'sitemap' | 'none',
 *   total: number
 * }
 */
router.get('/preview-urls', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const url = req.query.url as string;
    const limit = parseInt(req.query.limit as string) || 500;

    if (!url) {
      res.status(400).json({ success: false, error: 'Missing required query parameter: url' });
      return;
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      res.status(400).json({ success: false, error: 'Invalid URL format' });
      return;
    }

    const components = getCrawlerComponents();
    const profile = await components.profiler.profile(url, {
      timeout: 10000,
      thoroughness: 'quick',
    });

    if (!profile.metadata.hasSitemap) {
      res.json({ success: true, urls: [{ url }], source: 'none', total: 1 });
      return;
    }

    const sitemapResult = await components.profiler.discoverSitemapUrls(url, limit);
    res.json({
      success: true,
      urls: sitemapResult.allUrls.map((u: string) => ({ url: u })),
      source: 'sitemap',
      total: sitemapResult.allUrls.length,
    });
  } catch (error) {
    logger.error('Preview URLs failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to preview URLs',
    });
  }
});

/**
 * POST /api/search-ai/crawl/robots - Fetch and analyze robots.txt
 *
 * Request body:
 * {
 *   url: string   // Any page URL — robots.txt is derived from the origin
 * }
 *
 * Response:
 * {
 *   success: true,
 *   data: RobotsTxtAnalysis
 * }
 */
router.post('/robots', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const robotsSchema = z.object({ url: z.string().url() });
    const parsed = robotsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
      return;
    }

    const { url } = parsed.data;

    // SSRF defense: reject private/internal URLs
    const urlCheck = await isURLAllowed(url);
    if (!urlCheck.allowed) {
      res.status(400).json({
        success: false,
        error: {
          code: 'SSRF_BLOCKED',
          message: 'This URL cannot be accessed for security reasons',
        },
      });
      return;
    }

    const analysis = await analyzeRobotsTxt(url);

    // Filter sitemap URLs through SSRF check
    if (analysis.sitemapUrls.length > 0) {
      const safeSitemaps: string[] = [];
      for (const sitemapUrl of analysis.sitemapUrls) {
        const sitemapCheck = await isURLAllowed(sitemapUrl);
        if (sitemapCheck.allowed) {
          safeSitemaps.push(sitemapUrl);
        } else {
          logger.warn('Filtered out internal sitemap URL', { sitemapUrl });
        }
      }
      analysis.sitemapUrls = safeSitemaps;
    }

    res.json({ success: true, data: analysis });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to analyze robots.txt', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'ROBOTS_FETCH_FAILED', message: 'Failed to analyze robots.txt' },
    });
  }
});

/**
 * POST /api/search-ai/crawl/profile - Profile a site (rate-limited)
 *
 * Request body:
 * {
 *   url: string
 * }
 *
 * Response:
 * {
 *   success: true,
 *   domain: string,
 *   siteType: string,
 *   estimatedSize: number,
 *   hasSitemap: boolean,
 *   jsRequired: boolean,
 *   avgResponseTime: number,
 *   metadata: {
 *     title: string,
 *     description: string,
 *     favicon: string
 *   }
 * }
 */
router.post('/profile', async (req: Request, res: Response) => {
  let url: string | undefined;
  let cb: CircuitBreaker | undefined;

  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const profileSchema = z.object({ url: z.string().url() });
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.errors.map((e) => e.message).join(', '),
        },
      });
      return;
    }

    url = parsed.data.url;

    // Initialize crawler components
    const components = getCrawlerComponents();
    cb = getCircuitBreaker();

    // Check circuit breaker before profiling
    const circuitState = await cb.isOpen(url, req.tenantContext.tenantId);
    if (circuitState.blocked) {
      logger.warn('Circuit breaker blocked profile request', {
        url,
        tenantId: req.tenantContext.tenantId,
        resetAt: circuitState.resetAt,
        failureCount: circuitState.failureCount,
      });
      res.status(503).json({
        success: false,
        error: {
          code: 'CIRCUIT_BREAKER_OPEN',
          message: 'Site temporarily blocked due to repeated failures',
          resetAt: circuitState.resetAt?.toISOString(),
        },
      });
      return;
    }

    // Profile the site
    const profile = await components.profiler.profile(url, {
      timeout: 10000,
      thoroughness: 'quick',
    });

    // Get strategy recommendation
    const decision = await components.decisionEngine.decide({
      url,
      tenantId: req.tenantContext.tenantId,
      userId: req.tenantContext.userId,
      profile,
      estimatedUrlCount: 1,
    });
    const recommendedStrategy = decision.strategy as CrawlStrategy;

    // Estimate crawl duration
    const durationEstimate = estimateCrawlDuration(
      recommendedStrategy,
      profile.estimatedSize || 1,
      {
        avgResponseTime: profile.avgResponseTime,
        hasJavaScript: profile.metadata.jsRequired || false,
        hasSitemap: profile.metadata.hasSitemap || false,
      },
    );

    const platformResult = profile.metadata.platformResult;

    // Map sitemapDiscovery for frontend consumption
    // Include allUrls so cluster-urls doesn't need to re-fetch sitemaps
    // (re-fetching is non-deterministic and loses URLs due to timeouts)
    const sitemapDiscovery = profile.metadata.sitemapDiscovery
      ? {
          steps: profile.metadata.sitemapDiscovery.steps,
          sitemapFiles: profile.metadata.sitemapDiscovery.sitemapFiles.map((f) => ({
            url: f.url,
            origin: f.origin,
            parentUrl: f.parentUrl,
            urlCount: f.urls.length,
          })),
          totalUrls: profile.metadata.sitemapDiscovery.totalUrls,
          allUrls: profile.metadata.sitemapDiscovery.allUrls,
        }
      : undefined;

    res.json({
      success: true,
      domain: profile.domain,
      siteType: profile.siteType,
      estimatedSize: profile.estimatedSize,
      hasSitemap: profile.metadata.hasSitemap || false,
      jsRequired: profile.metadata.jsRequired || false,
      avgResponseTime: profile.avgResponseTime,
      recommendedStrategy,
      recommendationReasoning: decision.reasoning,
      recommendationConfidence: decision.confidence,
      estimatedDuration: durationEstimate,
      platform: platformResult?.platform ?? profile.framework ?? null,
      platformCategory: profile.metadata.platformCategory ?? null,
      apiEndpoints: profile.metadata.apiEndpoints ?? [],
      discoveryMethod: profile.metadata.hasSitemap ? 'sitemap' : 'links',
      sitemapDiscovery,
      metadata: {
        title: profile.metadata.title || '',
        description: profile.metadata.description || '',
        favicon: profile.metadata.favicon || '',
      },
    });

    // Record success with circuit breaker
    await cb.recordSuccess(url, req.tenantContext.tenantId);
    logger.info('Profile request successful', {
      url,
      tenantId: req.tenantContext.tenantId,
      domain: profile.domain,
    });
  } catch (error) {
    // Record failure with circuit breaker
    if (cb && url && req.tenantContext) {
      await cb.recordFailure(
        url,
        req.tenantContext.tenantId,
        error instanceof Error ? error.message : String(error),
      );
    }

    logger.error('Profile request failed', {
      url: url || 'unknown',
      tenantId: req.tenantContext?.tenantId || 'unknown',
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: {
        code: 'PROFILE_FAILED',
        message: 'Site profiling failed',
      },
    });
  }
});

// ─── Validate Sitemap ────────────────────────────────────────────────────

const validateSitemapSchema = z.object({
  url: z.string().url(),
});

/**
 * POST /api/search-ai/crawl/validate-sitemap - Validate a user-provided sitemap URL
 *
 * Fetches the sitemap, parses it, validates (XML? has URLs? is sitemap index?),
 * returns count + error classification. Reuses profiler's extractSitemapUrls.
 */
router.post('/validate-sitemap', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const parsed = validateSitemapSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.errors.map((e) => e.message).join(', '),
        },
      });
      return;
    }

    const { url: sitemapUrl } = parsed.data;

    // Use the profiler to extract URLs from the user-provided sitemap
    const components = getCrawlerComponents();
    const result = await components.profiler.extractSitemapUrls(
      sitemapUrl, // Pass the sitemap URL directly as the "base URL"
      5000, // maxUrls
      10_000, // timeout
      [sitemapUrl], // Treat the URL as a robots.txt-discovered sitemap
    );

    // Check if any URLs were found
    if (result.totalUrls === 0) {
      res.json({
        success: true,
        valid: false,
        error: 'no_urls',
        message: 'No URLs found in the sitemap. The URL may not be a valid sitemap XML.',
        urlCount: 0,
      });
      return;
    }

    // Determine if it was a sitemap index
    const isIndex = result.sitemapFiles.some((f) => f.origin === 'index');

    res.json({
      success: true,
      valid: true,
      urlCount: result.totalUrls,
      sitemapFiles: result.sitemapFiles.map((f) => ({
        url: f.url,
        origin: f.origin,
        urlCount: f.urls.length,
      })),
      type: isIndex ? 'index' : 'sitemap',
    });

    logger.info('Sitemap validation successful', {
      tenantId: req.tenantContext.tenantId,
      sitemapUrl,
      urlCount: result.totalUrls,
      type: isIndex ? 'index' : 'sitemap',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Sitemap validation failed', {
      tenantId: req.tenantContext?.tenantId,
      error: message,
    });

    // Classify the error
    const isTimeout = message.includes('timeout') || message.includes('Timeout');
    const isNetwork = message.includes('ECONNREFUSED') || message.includes('ENOTFOUND');

    res.json({
      success: true,
      valid: false,
      error: isTimeout ? 'timeout' : isNetwork ? 'unreachable' : 'invalid',
      message: isTimeout
        ? 'The sitemap URL took too long to respond.'
        : isNetwork
          ? 'Could not reach the sitemap URL.'
          : `Failed to parse sitemap: ${message}`,
      urlCount: 0,
    });
  }
});

// ─── Zod Schemas for New Routes ──────────────────────────────────────────

const clusterUrlsSchema = z.object({
  url: z.string().url(),
  sitemapUrls: z.array(z.string().url()).max(100_000).optional(),
  platform: z.string().optional(),
  apiEndpoints: z.array(z.string().startsWith('/')).max(20).optional(),
  /** Sample URLs for multi-pattern scoring (from browser discovery) — accepts full URLs or paths */
  sampleUrls: z.array(z.string().min(1)).max(50).optional(),
  /** When provided, full URL lists are persisted into SourceUrlBucket for each group */
  sourceId: z.string().min(1).optional(),
  /** User-provided sitemap URL — passed to discoverSitemapUrls as an extra source */
  customSitemapUrl: z.string().url().optional(),
});

const sampleGroupsSchema = z.object({
  groups: z
    .array(
      z.object({
        pattern: z.string().min(1),
        count: z.number().int().positive(),
        examples: z.array(z.string().url()).min(1).max(10),
      }),
    )
    .max(200),
});

/**
 * Match a URL path against a cluster pattern (e.g. "/docs/{slug}").
 * Literal segments must match exactly; {slug} matches any single segment.
 * Query-parameter sub-patterns (e.g. "?key=val") are checked on query string.
 */
function matchesGroupPattern(urlPath: string, queryString: string, pattern: string): boolean {
  // Handle query-parameter sub-patterns: "/path?key=val"
  const qIdx = pattern.indexOf('?');
  let pathPattern = pattern;
  let queryConstraint: { key: string; value: string } | null = null;
  if (qIdx !== -1) {
    pathPattern = pattern.slice(0, qIdx);
    const qPart = pattern.slice(qIdx + 1);
    const eqIdx = qPart.indexOf('=');
    if (eqIdx !== -1) {
      queryConstraint = { key: qPart.slice(0, eqIdx), value: qPart.slice(eqIdx + 1) };
    }
  }

  const patternSegs = pathPattern.split('/').filter(Boolean);
  const urlSegs = urlPath.split('/').filter(Boolean);

  if (patternSegs.length !== urlSegs.length) return false;

  for (let i = 0; i < patternSegs.length; i++) {
    if (patternSegs[i] === '{slug}') continue; // wildcard
    if (patternSegs[i] !== urlSegs[i]) return false;
  }

  // Check query constraint if present
  if (queryConstraint) {
    const params = new URLSearchParams(queryString);
    if (params.get(queryConstraint.key) !== queryConstraint.value) return false;
  }

  return true;
}

/**
 * Persist full URL lists into SourceUrlBucket for each cluster group.
 * Uses the bucket pattern (SOURCE_URL_BUCKET_SIZE per document).
 */
async function storeBucketUrlsForGroups(
  tenantId: string,
  sourceId: string,
  groups: Array<{ pattern: string; count: number; examples: string[]; depth: number }>,
  allUrls: string[],
): Promise<void> {
  const SourceUrlBucketModel = getLazyModel('SourceUrlBucket');

  // Delete existing buckets for this source (in case of re-analysis)
  await SourceUrlBucketModel.deleteMany({ sourceId, tenantId });

  // Assign each URL to its matching group
  const groupUrlMap = new Map<number, string[]>();
  for (let i = 0; i < groups.length; i++) {
    groupUrlMap.set(i, []);
  }

  const ungroupedUrls: string[] = [];

  for (const fullUrl of allUrls) {
    try {
      const parsed = new URL(fullUrl);
      const urlPath = parsed.pathname;
      const queryString = parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search;

      let matched = false;
      for (let i = 0; i < groups.length; i++) {
        if (matchesGroupPattern(urlPath, queryString, groups[i].pattern)) {
          groupUrlMap.get(i)!.push(fullUrl);
          matched = true;
          break;
        }
      }
      if (!matched) {
        ungroupedUrls.push(fullUrl);
      }
    } catch {
      // Skip invalid URLs
    }
  }

  // Write each group's URLs into buckets
  const bulkOps: Array<{
    insertOne: {
      document: {
        tenantId: string;
        sourceId: string;
        sectionId: string;
        bucketIndex: number;
        urls: Array<{ url: string; title: null; score: null; depth: number }>;
        urlCount: number;
      };
    };
  }> = [];

  for (let i = 0; i < groups.length; i++) {
    const groupUrls = groupUrlMap.get(i) ?? [];
    if (groupUrls.length === 0) continue;

    const sectionId = `sec-${i}`;
    const depth = groups[i].depth;

    for (let j = 0; j < groupUrls.length; j += SOURCE_URL_BUCKET_SIZE) {
      const chunk = groupUrls.slice(j, j + SOURCE_URL_BUCKET_SIZE);
      bulkOps.push({
        insertOne: {
          document: {
            tenantId,
            sourceId,
            sectionId,
            bucketIndex: Math.floor(j / SOURCE_URL_BUCKET_SIZE),
            urls: chunk.map((u) => ({ url: u, title: null, score: null, depth })),
            urlCount: chunk.length,
          },
        },
      });
    }
  }

  // Store ungrouped URLs in a dedicated bucket section
  if (ungroupedUrls.length > 0) {
    const sectionId = 'sec-ungrouped';
    for (let j = 0; j < ungroupedUrls.length; j += SOURCE_URL_BUCKET_SIZE) {
      const chunk = ungroupedUrls.slice(j, j + SOURCE_URL_BUCKET_SIZE);
      bulkOps.push({
        insertOne: {
          document: {
            tenantId,
            sourceId,
            sectionId,
            bucketIndex: Math.floor(j / SOURCE_URL_BUCKET_SIZE),
            urls: chunk.map((u) => ({ url: u, title: null, score: null, depth: 0 })),
            urlCount: chunk.length,
          },
        },
      });
    }
  }

  if (bulkOps.length > 0) {
    await SourceUrlBucketModel.bulkWrite(bulkOps);
    logger.info('Stored full URL lists in buckets', {
      sourceId,
      groups: groups.length,
      totalBuckets: bulkOps.length,
      totalUrls: allUrls.length,
      ungroupedUrls: ungroupedUrls.length,
    });
  }
}

/**
 * POST /api/search-ai/crawl/cluster-urls - Cluster URLs by path pattern
 *
 * If sitemapUrls provided, clusters those directly.
 * Otherwise uses profiler.extractSitemapUrls (recursive, handles sitemap indexes),
 * and if no sitemap, falls back to DiscoveryChain.
 */
router.post('/cluster-urls', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const { tenantId } = req.tenantContext;

    // Validate input
    const parsed = clusterUrlsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.errors.map((e) => e.message).join(', '),
        },
      });
      return;
    }

    const { url, sitemapUrls, platform, apiEndpoints, sampleUrls, sourceId, customSitemapUrl } =
      parsed.data;
    let urlsToCluster: string[] = [];
    let discoveryMethod = 'sitemap-provided';
    let discoverySteps: Array<{
      method: string;
      urlsFound: number;
      duration: number;
      details?: string;
    }> = [];
    let sitemapDiscoveryResult: import('@abl/crawler').SitemapDiscoveryResult | undefined;

    if (sitemapUrls && sitemapUrls.length > 0) {
      // Use provided sitemap URLs directly
      urlsToCluster = sitemapUrls;
    } else {
      // Use profiler's discoverSitemapUrls — fetches robots.txt + /sitemap.xml + any custom URL.
      // Handles sitemap indexes recursively, with SSRF protection via safeFetch.
      const components = getCrawlerComponents();
      try {
        const extraSitemaps = customSitemapUrl ? [customSitemapUrl] : [];
        sitemapDiscoveryResult = await components.profiler.discoverSitemapUrls(
          url,
          100_000, // Selection cap — all sitemap URLs visible during selection; crawl-time cap is separate
          10_000,
          extraSitemaps,
        );
        if (sitemapDiscoveryResult.allUrls.length > 0) {
          urlsToCluster = sitemapDiscoveryResult.allUrls;
          discoveryMethod = 'sitemap';
        }
      } catch {
        // Sitemap not available — fall through to DiscoveryChain
      }

      // If no sitemap URLs found, use DiscoveryChain for multi-step fallback
      if (urlsToCluster.length === 0) {
        const adapter = new HttpAdapter({ timeout: 10_000 });
        const chain = new DiscoveryChain(adapter);
        const discovery = await chain.discover(url, {
          platform,
          apiEndpoints,
        });
        urlsToCluster = discovery.urls;
        discoveryMethod = discovery.method;
        discoverySteps = discovery.steps;
      }
    }

    if (urlsToCluster.length === 0) {
      res.json({ success: true, groups: [], discoveryMethod, discoverySteps });
      return;
    }

    const clusterer = new UrlClusterer({ splitByQueryParam: true });
    const result = clusterer.cluster(urlsToCluster);

    // Score groups using pattern-matcher when sampleUrls are provided.
    // Use multi-pattern learning when samples have different path prefixes
    // (e.g. /faq/* + /Support/*) to avoid a single degenerate pattern.
    const patterns = sampleUrls && sampleUrls.length > 0 ? learnPatterns(sampleUrls) : [];
    // Fall back to single pattern when multi-pattern produces results,
    // or null when no sample URLs are provided
    const singlePattern =
      patterns.length === 0 && sampleUrls && sampleUrls.length > 0
        ? learnPattern(sampleUrls)
        : null;
    const hasPatterns = patterns.length > 0 || singlePattern !== null;

    const scoredGroups = result.groups.map((g) => {
      if (!hasPatterns)
        return {
          ...g,
          scoreTier: undefined as string | undefined,
          avgScore: undefined as number | undefined,
        };

      if (patterns.length > 0) {
        // Multi-pattern scoring: score each example against all patterns
        const scores = g.examples.map((u) => scoreUrlMulti(u, patterns));
        const avgScore =
          scores.length > 0
            ? Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length)
            : 0;
        const tiers = scores.map((s) => s.tier);
        const bestTier = tiers.includes('hot') ? 'hot' : tiers.includes('warm') ? 'warm' : 'cold';
        return { ...g, scoreTier: bestTier, avgScore };
      }

      // Single pattern scoring (may be degenerate — scoreUrl handles it)
      const scores = g.examples.map((u) => scoreUrl(u, singlePattern!));
      const avgScore =
        scores.length > 0
          ? Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length)
          : 0;
      const tiers = scores.map((s) => s.tier);
      const bestTier = tiers.includes('hot') ? 'hot' : tiers.includes('warm') ? 'warm' : 'cold';

      return { ...g, scoreTier: bestTier, avgScore };
    });

    // Tag groups with sitemapFile/sitemapOrigin from discovery provenance
    if (sitemapDiscoveryResult && sitemapDiscoveryResult.sitemapFiles.length > 0) {
      // Build URL → sitemapFile lookup
      const urlToSitemapFile = new Map<string, { url: string; origin: string }>();
      for (const file of sitemapDiscoveryResult.sitemapFiles) {
        for (const entry of file.urls) {
          if (!urlToSitemapFile.has(entry.loc)) {
            urlToSitemapFile.set(entry.loc, { url: file.url, origin: file.origin });
          }
        }
      }

      // Tag each group: use the sitemapFile of the majority of its examples
      for (const group of scoredGroups) {
        const fileCounts = new Map<string, number>();
        for (const example of group.examples) {
          const match = urlToSitemapFile.get(example);
          if (match) {
            fileCounts.set(match.url, (fileCounts.get(match.url) || 0) + 1);
          }
        }
        if (fileCounts.size > 0) {
          // Pick the sitemap file with the most examples in this group
          let bestFile = '';
          let bestCount = 0;
          for (const [file, count] of fileCounts) {
            if (count > bestCount) {
              bestFile = file;
              bestCount = count;
            }
          }
          const fileInfo = sitemapDiscoveryResult.sitemapFiles.find((f) => f.url === bestFile);
          (group as any).sitemapFile = bestFile;
          (group as any).sitemapOrigin = fileInfo?.origin ?? 'default';
        }
      }
    }

    // Persist full URL lists into buckets when sourceId is provided
    if (sourceId) {
      try {
        await storeBucketUrlsForGroups(tenantId, sourceId, scoredGroups, urlsToCluster);
      } catch (bucketErr) {
        const bucketMsg = bucketErr instanceof Error ? bucketErr.message : String(bucketErr);
        logger.error('Failed to store bucket URLs', {
          tenantId,
          sourceId,
          error: bucketMsg,
        });
        // Non-fatal: clustering result is still returned
      }
    }

    logger.info('URL clustering complete', {
      tenantId,
      url,
      totalUrls: urlsToCluster.length,
      groupCount: result.groups.length,
      groupedUrls: result.stats.groupedUrls,
      ungroupedCount: result.ungrouped.length,
      statsTotal: result.stats.totalUrls,
      discoveryMethod,
      patternScoring: hasPatterns,
      patternCount: patterns.length,
      bucketsPersisted: !!sourceId,
    });

    res.json({
      success: true,
      groups: scoredGroups,
      ungrouped: result.ungrouped,
      stats: result.stats,
      discoveryMethod,
      discoverySteps,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('URL clustering failed', {
      tenantId: req.tenantContext?.tenantId,
      error: message,
    });
    res.status(500).json({
      success: false,
      error: { code: 'CLUSTER_FAILED', message },
    });
  }
});

/**
 * POST /api/search-ai/crawl/sample-groups - Sample URL groups to determine crawl method
 *
 * For each group, fetches up to 3 example pages via HttpAdapter,
 * runs FailureScorer + QualityGate on each sample.
 * If all samples pass → method='http', else → method='playwright'.
 */
router.post('/sample-groups', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const { tenantId } = req.tenantContext;

    // Validate input
    const parsed = sampleGroupsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.errors.map((e) => e.message).join(', '),
        },
      });
      return;
    }

    const { groups } = parsed.data;

    logger.info('Sampling groups', { tenantId, groupCount: groups.length });

    // SSRF validation: check all example URLs before fetching
    for (const group of groups) {
      for (const exampleUrl of group.examples) {
        const check = await isURLAllowed(exampleUrl);
        if (!check.allowed) {
          res.status(400).json({
            success: false,
            error: {
              code: 'SSRF_BLOCKED',
              message: `URL blocked by security policy: ${check.reason ?? 'private IP or internal endpoint'}`,
            },
          });
          return;
        }
      }
    }

    // Sampling uses a shorter timeout — we just need a quick quality check, not a full crawl.
    // Fetching 1 sample per group is enough signal for HTTP vs Playwright decision.
    const adapter = new HttpAdapter({ timeout: 5_000 });
    const failureScorer = new FailureScorer();
    const qualityGate = new QualityGate();

    // Sample one group: fetch 1 example page, score it
    async function sampleOneGroup(group: (typeof groups)[number]): Promise<GroupStrategy> {
      const samplesToFetch = group.examples.slice(0, 1);
      let needsPlaywright = false;
      let sampleCount = 0;

      for (const sampleUrl of samplesToFetch) {
        const fetchResult = await adapter.fetch(sampleUrl);
        sampleCount++;

        if (!fetchResult.success || !fetchResult.crawlResult) {
          needsPlaywright = true;
          break;
        }

        const crawlResult = fetchResult.crawlResult;

        const failureResult = failureScorer.score(crawlResult);
        if (failureResult.shouldEscalate) {
          needsPlaywright = true;
          break;
        }

        const qualityResult = qualityGate.score(crawlResult.html ?? '', crawlResult.text ?? '');
        if (qualityResult.shouldBlock) {
          needsPlaywright = true;
          break;
        }
      }

      const method = needsPlaywright ? 'playwright' : 'http';
      const llmEstimate = method === 'playwright' ? group.count * 4 : group.count;

      return {
        pattern: group.pattern,
        method,
        llmEstimate,
        reason: needsPlaywright
          ? `${sampleCount} sample(s) indicated browser rendering needed`
          : `${sampleCount} sample(s) passed HTTP extraction checks`,
        count: group.count,
      };
    }

    // Run groups in parallel — 10 concurrent since each only fetches 1 page now
    const CONCURRENCY = 10;
    const strategies: GroupStrategy[] = [];
    for (let i = 0; i < groups.length; i += CONCURRENCY) {
      const batch = groups.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(sampleOneGroup));
      strategies.push(...batchResults);
    }

    logger.info('Group sampling complete', {
      tenantId,
      groupCount: groups.length,
      httpGroups: strategies.filter((s) => s.method === 'http').length,
      playwrightGroups: strategies.filter((s) => s.method === 'playwright').length,
    });

    res.json({ success: true, strategies });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Group sampling failed', {
      tenantId: req.tenantContext?.tenantId,
      error: message,
    });
    res.status(500).json({
      success: false,
      error: { code: 'SAMPLE_FAILED', message },
    });
  }
});

/**
 * GET /api/crawl/status?jobId=xxx - Check job status
 *
 * Query params:
 *   jobId: string - BullMQ job ID
 *
 * Response:
 * {
 *   success: true,
 *   jobId: string,
 *   state: 'waiting' | 'active' | 'completed' | 'failed',
 *   progress: number | object,
 *   data: object,              // Job input data
 *   returnvalue?: object,      // Job results (if completed)
 *   failedReason?: string,     // Error (if failed)
 * }
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
      });
      return;
    }

    const { jobId } = req.query;
    const tenantId = req.tenantContext.tenantId;

    if (!jobId || typeof jobId !== 'string') {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARAMETER', message: 'Missing jobId query parameter' },
      });
      return;
    }

    // ── 1. Read CrawlJob from MongoDB first (authoritative) ──────────────
    const CrawlJobModel = getLazyModel<ICrawlJob>('CrawlJob');
    const crawlJob = await CrawlJobModel.findOne({ _id: jobId, tenantId }).lean();

    if (!crawlJob) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Crawl job not found' },
      });
      return;
    }

    // ── 2. For non-intelligence jobs, optionally enrich with BullMQ state ─
    let bullState: string | null = null;
    let bullProgress: number | Record<string, unknown> | null = null;
    let bullProcessedOn: number | null = null;
    let bullFinishedOn: number | null = null;
    let bullReturnValue: unknown = undefined;
    let bullFailedReason: string | undefined = undefined;

    if (crawlJob.strategy !== 'intelligence') {
      try {
        const queue = getCrawlQueue();
        const bullJob = await queue.getJob(jobId);
        if (bullJob) {
          // Enforce tenant isolation on BullMQ job data
          const bullTenantId = (bullJob.data as { tenantId?: string })?.tenantId;
          if (!bullTenantId || bullTenantId === tenantId) {
            bullState = await bullJob.getState();
            bullProgress = bullJob.progress as number | Record<string, unknown>;
            bullProcessedOn = bullJob.processedOn ?? null;
            bullFinishedOn = bullJob.finishedOn ?? null;
            if (bullState === 'completed') bullReturnValue = bullJob.returnvalue;
            if (bullState === 'failed') bullFailedReason = bullJob.failedReason;
          }
        }
      } catch (err) {
        logger.warn('BullMQ job lookup failed, using MongoDB state', {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── 3. Build response using MongoDB as authoritative, BullMQ as supplement ─
    const response = {
      success: true,
      jobId: crawlJob._id,
      state: bullState ?? crawlJob.status,
      progress: bullProgress ?? 0,
      urls: crawlJob.urls?.original?.length ?? 0,
      crawled: crawlJob.urls?.crawled ?? 0,
      failed: crawlJob.urls?.failed ?? 0,
      strategy: crawlJob.strategy,
      processedOn: bullProcessedOn ?? crawlJob.timeline?.startedAt?.getTime?.() ?? null,
      finishedOn: bullFinishedOn ?? crawlJob.timeline?.completedAt?.getTime?.() ?? null,
      returnvalue:
        bullReturnValue ?? (crawlJob.status === 'completed' ? crawlJob.results : undefined),
      failedReason:
        bullFailedReason ??
        (crawlJob.status === 'failed' ? crawlJob.processingErrors?.[0]?.message : undefined),
    };

    res.json(response);
  } catch (error) {
    logger.error('Failed to get job status', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get job status' },
    });
  }
});

/**
 * GET /api/crawl/dashboard/:jobId - Centralized crawl pipeline dashboard
 *
 * Aggregates data from:
 * - Crawl job status (BullMQ)
 * - Document ingestion stats (MongoDB)
 * - Queue health (BullMQ queue monitor)
 * - Error tracking
 *
 * Response:
 * {
 *   success: true,
 *   jobId: string,
 *   timeline: {
 *     submitted: timestamp,
 *     started: timestamp | null,
 *     completed: timestamp | null,
 *     duration: number | null (ms)
 *   },
 *   phase: 'queued' | 'crawling' | 'ingesting' | 'extracting' | 'enriching' | 'embedding' | 'indexed' | 'failed',
 *   crawl: {
 *     status: 'waiting' | 'active' | 'completed' | 'failed',
 *     progress: number,
 *     urlsQueued: number,
 *     urlsCrawled: number,
 *     urlsFailed: number,
 *     batchId: string
 *   },
 *   ingestion: {
 *     documentsCreated: number,
 *     documentsFailed: number,
 *     documentsIndexed: number,
 *     avgQualityScore: number | null,
 *     statusBreakdown: Record<string, number>
 *   },
 *   extraction: {
 *     documentsProcessed: number,
 *     chunksCreated: number,
 *     avgChunksPerDoc: number,
 *     chunkStatusBreakdown: Record<string, number>
 *   },
 *   queues: {
 *     status: 'healthy' | 'degraded' | 'critical',
 *     details: QueueHealth[]
 *   },
 *   errors: Array<{ timestamp: string, phase: string, message: string }>
 * }
 */
router.get('/dashboard/:jobId', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
      });
      return;
    }

    const { jobId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    if (!jobId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARAMETER', message: 'Missing jobId parameter' },
      });
      return;
    }

    // ── 1. Read CrawlJob from MongoDB first (authoritative) ───────────────
    const { SearchDocument, SearchChunk } = getModels();
    const CrawlJobModel = getLazyModel<ICrawlJob>('CrawlJob');
    const crawlJob = await CrawlJobModel.findOne({ _id: jobId, tenantId }).lean();

    if (!crawlJob) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Crawl job not found' },
      });
      return;
    }

    // ── 2. For non-intelligence jobs, optionally query BullMQ for real-time progress ──
    let bullJob: BullMQJob | null = null;

    if (crawlJob.strategy !== 'intelligence') {
      try {
        const queue = getCrawlQueue();
        const foundJob = await queue.getJob(jobId);
        if (!foundJob && jobId.startsWith('batch-')) {
          const [waiting, active, completed, failed] = await Promise.all([
            queue.getJobs(['waiting'], 0, 99),
            queue.getJobs(['active'], 0, 99),
            queue.getJobs(['completed'], 0, 99),
            queue.getJobs(['failed'], 0, 99),
          ]);
          const batchMatch = [...waiting, ...active, ...completed, ...failed].find(
            (j) => (j.data as { batchId?: string }).batchId === jobId,
          );
          if (batchMatch) {
            bullJob = batchMatch;
          }
        } else if (foundJob) {
          bullJob = foundJob;
        }
      } catch (err) {
        logger.warn('BullMQ job lookup failed, using MongoDB state', {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── 3. Derive state from MongoDB (authoritative) + BullMQ (supplementary) ──
    const jobState = bullJob ? await bullJob.getState() : crawlJob.status;
    const bullData = bullJob
      ? (bullJob.data as { batchId?: string; jobId?: string; urls?: string[]; indexId?: string })
      : null;

    const batchId = bullData?.batchId || bullData?.jobId || crawlJob._id;
    const indexId = crawlJob.indexId || bullData?.indexId;

    // Build timeline — prefer BullMQ real-time data when available, fall back to MongoDB
    const submittedTs =
      bullJob?.timestamp ??
      crawlJob.timeline?.submittedAt?.getTime?.() ??
      crawlJob.createdAt?.getTime?.() ??
      Date.now();
    const startedTs = bullJob?.processedOn ?? crawlJob.timeline?.startedAt?.getTime?.() ?? null;
    const completedTs = bullJob?.finishedOn ?? crawlJob.timeline?.completedAt?.getTime?.() ?? null;
    const timeline = {
      submitted: submittedTs,
      started: startedTs,
      completed: completedTs,
      duration: startedTs && completedTs ? completedTs - startedTs : null,
    };

    // Parse crawl progress
    const totalUrls = crawlJob.urls?.original?.length || bullData?.urls?.length || 0;
    let urlsCrawled = crawlJob.urls?.crawled || 0;
    let urlsFailed = crawlJob.urls?.failed || 0;
    let crawlProgressNum = 0;

    if (bullJob) {
      const crawlProgress =
        typeof bullJob.progress === 'object'
          ? bullJob.progress
          : { crawled: 0, failed: 0, queued: totalUrls };
      urlsCrawled = (crawlProgress as Record<string, number>).crawled || urlsCrawled;
      urlsFailed = (crawlProgress as Record<string, number>).failed || urlsFailed;
      crawlProgressNum = typeof bullJob.progress === 'number' ? bullJob.progress : 0;
    }

    const crawlStats = {
      status: jobState,
      progress: crawlProgressNum,
      totalUrls,
      urlsCrawled,
      urlsFailed,
      batchId,
    };

    // ── 2. Get document ingestion stats (query by batchId; crawler stores in sourceMetadata) ───
    const docQuery = {
      tenantId,
      indexId,
      $or: [{ 'sourceMetadata.crawlJobId': batchId }, { 'metadata.crawlJobId': batchId }] as any,
    };

    const docAggregation = await SearchDocument.aggregate([
      { $match: docQuery },
      { $project: { status: 1, metadata: 1 } },
      {
        $facet: {
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          qualityScores: [
            { $match: { 'metadata.qualityScore': { $type: 'number' } } },
            { $group: { _id: null, avg: { $avg: '$metadata.qualityScore' } } },
          ],
          documentIds: [{ $group: { _id: null, ids: { $push: '$_id' } } }],
        },
      },
    ])
      .option({ maxTimeMS: 15000, allowDiskUse: true })
      .exec();

    const byStatus = (docAggregation[0]?.byStatus as Array<{ _id: string; count: number }>) || [];
    const documentsByStatus = byStatus.reduce(
      (acc, item) => {
        acc[item._id] = item.count;
        return acc;
      },
      {} as Record<string, number>,
    );
    const documentsCreated = byStatus.reduce((sum, item) => sum + item.count, 0);
    const documentsIndexed = documentsByStatus[DocumentStatus.INDEXED] || 0;
    const documentsFailed = documentsByStatus[DocumentStatus.ERROR] || 0;
    const avgQualityScore =
      (docAggregation[0]?.qualityScores?.[0] as { avg: number } | undefined)?.avg ?? null;
    const documentIds =
      (docAggregation[0]?.documentIds?.[0] as { ids: unknown[] } | undefined)?.ids ?? [];

    const ingestionStats = {
      documentsCreated,
      documentsFailed,
      documentsIndexed,
      avgQualityScore,
      statusBreakdown: documentsByStatus,
      progress: documentsCreated > 0 ? Math.round((documentsIndexed / documentsCreated) * 100) : 0,
    };

    // ── 2b. CrawlError breakdown by type ──────────────────────────────────
    const CrawlErrorModel = getLazyModel<ICrawlError>('CrawlError');
    let errorBreakdown: Array<{ type: string; count: number }> = [];
    try {
      const breakdownResult = await CrawlErrorModel.aggregate([
        { $match: { tenantId, crawlJobId: batchId } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
      ])
        .option({ maxTimeMS: 5000 })
        .exec();
      errorBreakdown = (breakdownResult as Array<{ _id: string; count: number }>).map((r) => ({
        type: r._id,
        count: r.count,
      }));
    } catch (err) {
      logger.warn('CrawlError aggregation failed', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── 2c. Quality distribution by tier (rich/standard/thin) ───────────────
    let qualityDistribution: Record<string, number> | null = null;
    try {
      const qualityAgg = await SearchDocument.aggregate([
        { $match: { tenantId, 'sourceMetadata.crawlJobId': batchId } },
        { $group: { _id: '$sourceMetadata.quality', count: { $sum: 1 } } },
      ])
        .option({ maxTimeMS: 5000 })
        .exec();
      qualityDistribution = {};
      for (const r of qualityAgg as Array<{ _id: string | null; count: number }>) {
        if (r._id) qualityDistribution[r._id] = r.count;
      }
    } catch (err) {
      logger.warn('Quality distribution aggregation failed', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── 3. Get extraction/chunking stats (aggregate to avoid buffering many docs) ──────────────
    let chunksByStatus: Record<string, number> = {};
    let chunksCount = 0;
    if (documentIds.length > 0) {
      const chunkAgg = await SearchChunk.aggregate([
        {
          $match: {
            documentId: { $in: documentIds },
            tenantId,
            indexId,
          },
        },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
        .option({ maxTimeMS: 15000, allowDiskUse: true })
        .exec();
      chunksCount = (chunkAgg as Array<{ _id: string; count: number }>).reduce(
        (sum, item) => sum + item.count,
        0,
      );
      chunksByStatus = (chunkAgg as Array<{ _id: string; count: number }>).reduce(
        (acc, item) => {
          acc[item._id] = item.count;
          return acc;
        },
        {} as Record<string, number>,
      );
    }

    const chunksIndexed = chunksByStatus['indexed'] || 0;
    const chunksEmbedded =
      chunksIndexed + (chunksByStatus['embedding'] || 0) + (chunksByStatus['embedded'] || 0);

    const extractionStats = {
      documentsProcessed: documentsCreated,
      chunksCreated: chunksCount,
      avgChunksPerDoc: documentsCreated > 0 ? chunksCount / documentsCreated : 0,
      chunkStatusBreakdown: chunksByStatus,
      progress: chunksCount > 0 ? Math.round((chunksIndexed / chunksCount) * 100) : 0,
    };

    // ── 4. Get queue health ───────────────────────────────────────────────
    const queueHealth = await getAllQueueHealth();
    const criticalQueues = queueHealth.filter((q) => q.status === 'critical');
    const degradedQueues = queueHealth.filter((q) => q.status === 'degraded');

    const overallQueueStatus =
      criticalQueues.length > 0 ? 'critical' : degradedQueues.length > 0 ? 'degraded' : 'healthy';

    const queueStats = {
      status: overallQueueStatus,
      details: queueHealth,
    };

    // ── 5. Determine current phase ────────────────────────────────────────
    // jobState may be BullMQ state ('waiting'|'active'|'completed'|'failed')
    // or CrawlJob status ('queued'|'crawling'|'ingesting'|'indexing'|'completed'|'failed'|'cancelled')
    let phase: string = 'queued';

    if (jobState === 'failed' || jobState === 'cancelled') {
      phase = 'failed';
    } else if (jobState === 'completed') {
      if (documentsIndexed === documentsCreated && documentsCreated > 0) {
        phase = 'indexed';
      } else if (documentsByStatus[DocumentStatus.EMBEDDING]) {
        phase = 'embedding';
      } else if (
        documentsByStatus[DocumentStatus.ENRICHING] ||
        documentsByStatus[DocumentStatus.ENRICHED]
      ) {
        phase = 'enriching';
      } else if (
        documentsByStatus[DocumentStatus.EXTRACTING] ||
        documentsByStatus[DocumentStatus.EXTRACTED]
      ) {
        phase = 'extracting';
      } else if (documentsCreated > 0) {
        phase = 'ingesting';
      } else {
        phase = 'indexed'; // Crawl complete, no documents created
      }
    } else if (jobState === 'active' || jobState === 'crawling') {
      phase = 'crawling';
    } else if (jobState === 'ingesting') {
      phase = 'ingesting';
    } else if (jobState === 'indexing') {
      phase = 'indexing';
    }

    // ── 6. Collect errors ─────────────────────────────────────────────────
    const errors: Array<{ timestamp: string; phase: string; message: string }> = [];

    // Collect crawl-phase errors from BullMQ or MongoDB CrawlJob
    const failedReason = bullJob?.failedReason ?? crawlJob.processingErrors?.[0]?.message;
    if (jobState === 'failed' && failedReason) {
      const failedTs =
        bullJob?.finishedOn ?? crawlJob.timeline?.completedAt?.getTime?.() ?? Date.now();
      errors.push({
        timestamp: new Date(failedTs).toISOString(),
        phase: 'crawling',
        message: failedReason,
      });
    }

    // Include all processing errors from CrawlJob document
    if (crawlJob.processingErrors && crawlJob.processingErrors.length > 0) {
      for (const pe of crawlJob.processingErrors) {
        // Skip the first one if already added above
        if (pe.message === failedReason && errors.length > 0 && errors[0].message === failedReason)
          continue;
        errors.push({
          timestamp: pe.timestamp?.toISOString?.() ?? new Date().toISOString(),
          phase: pe.phase,
          message: pe.message,
        });
      }
    }

    // Document errors: lightweight query (only status + processingError + updatedAt)
    const docErrors = await SearchDocument.find({
      ...docQuery,
      status: DocumentStatus.ERROR,
      processingError: { $exists: true, $ne: null },
    })
      .select('status processingError updatedAt createdAt')
      .limit(50)
      .maxTimeMS(5000)
      .lean()
      .exec();
    (docErrors as any[]).forEach((doc: any) => {
      if (doc.processingError) {
        errors.push({
          timestamp: (doc.updatedAt ?? doc.createdAt)?.toISOString() ?? new Date().toISOString(),
          phase: 'ingestion',
          message: doc.processingError,
        });
      }
    });

    // Add queue issues as warnings (not errors per se, but important to surface)
    queueHealth
      .filter((q) => q.status === 'critical')
      .forEach((q) => {
        q.issues.forEach((issue) => {
          errors.push({
            timestamp: q.timestamp.toISOString(),
            phase: 'queue',
            message: `${q.queueName}: ${issue}`,
          });
        });
      });

    // ── 7. Return aggregated dashboard ────────────────────────────────────
    res.json({
      success: true,
      jobId,
      timeline,
      phase,
      crawl: {
        ...crawlStats,
        errorBreakdown,
      },
      ingestion: {
        ...ingestionStats,
        qualityDistribution,
      },
      extraction: extractionStats,
      embedding: {
        chunksEmbedded,
        progress: chunksCount > 0 ? Math.round((chunksEmbedded / chunksCount) * 100) : 0,
      },
      indexing: {
        chunksIndexed,
        progress: chunksCount > 0 ? Math.round((chunksIndexed / chunksCount) * 100) : 0,
      },
      queues: queueStats,
      errors: errors.slice(0, 50), // Limit to 50 most recent errors
    });
  } catch (error) {
    logger.error('Failed to get dashboard', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get dashboard' },
    });
  }
});

/**
 * GET /api/search-ai/crawl/history - Get crawl job history with cursor pagination
 *
 * Query params:
 *   indexId: string (required)
 *   limit: number (default: 20, max: 100)
 *   cursor: string (optional, last job _id from previous page)
 *
 * Response:
 * {
 *   success: true,
 *   jobs: CrawlJob[],
 *   cursor: string | null,
 *   hasMore: boolean
 * }
 */
router.get('/history', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { indexId, limit = '20', cursor } = req.query;
    const tenantId = req.tenantContext.tenantId;
    const { CrawlJob } = getModels();

    // Validate indexId
    if (!indexId || typeof indexId !== 'string') {
      res.status(400).json({ success: false, error: 'Missing required parameter: indexId' });
      return;
    }

    // Parse and validate limit
    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 100);

    // Build query
    const query: any = { tenantId, indexId };
    if (cursor) {
      query._id = { $lt: cursor }; // Cursor-based pagination
    }

    // Fetch jobs (+1 to check if there are more)
    const jobs = await CrawlJob.find(query)
      .sort({ _id: -1 }) // Sort by _id descending (newest first)
      .limit(limitNum + 1)
      .select('urls status strategy timeline results indexId sourceId createdAt')
      .lean();

    // Check if there are more results
    const hasMore = jobs.length > limitNum;
    if (hasMore) jobs.pop(); // Remove the extra job

    // Get cursor for next page (last job's _id)
    const nextCursor = jobs.length > 0 ? jobs[jobs.length - 1]._id : null;

    res.json({
      success: true,
      jobs,
      cursor: nextCursor,
      hasMore,
    });
  } catch (error) {
    logger.error('Failed to fetch history', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch history',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/search-ai/crawl/preferences - List user's saved preferences
 *
 * Response:
 * {
 *   success: true,
 *   preferences: UserCrawlPreference[]
 * }
 */
router.get('/preferences', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { UserCrawlPreference } = getModels();
    const { tenantId, userId } = req.tenantContext;

    const preferences = await UserCrawlPreference.find({ tenantId, userId })
      .sort({ lastUsed: -1 })
      .lean();

    res.json({ success: true, preferences });
  } catch (error) {
    logger.error('Failed to fetch preferences', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch preferences',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /api/search-ai/crawl/preferences - Create or update preference
 *
 * Request body:
 * {
 *   domainPattern: string,
 *   strategy: 'browser' | 'bulk' | 'hybrid',
 *   autoDecide?: boolean,
 *   batchSize?: number,
 *   concurrency?: number
 * }
 */
router.post('/preferences', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { tenantId, userId } = req.tenantContext;
    const { UserCrawlPreference } = getModels();
    const { domainPattern, strategy, autoDecide, batchSize, concurrency } = req.body;

    // Validate required fields
    if (!domainPattern || !strategy) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: domainPattern, strategy',
      });
      return;
    }

    // Validate strategy
    if (!['browser', 'bulk', 'hybrid'].includes(strategy)) {
      res.status(400).json({
        success: false,
        error: 'Invalid strategy. Must be: browser, bulk, or hybrid',
      });
      return;
    }

    // Upsert preference
    const preference = await UserCrawlPreference.findOneAndUpdate(
      { tenantId, userId, domainPattern: domainPattern.toLowerCase().trim() },
      {
        strategy,
        autoDecide: autoDecide ?? false,
        batchSize,
        concurrency,
        $inc: { useCount: 1 },
        lastUsed: new Date(),
      },
      { upsert: true, new: true },
    );

    res.json({ success: true, preference });
  } catch (error) {
    logger.error('Failed to save preference', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to save preference',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * DELETE /api/search-ai/crawl/preferences/:id - Delete preference
 */
router.delete('/preferences/:id', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { tenantId, userId } = req.tenantContext;
    const { UserCrawlPreference } = getModels();
    const { id } = req.params;

    // Delete only if user owns the preference
    const result = await UserCrawlPreference.findOneAndDelete({
      _id: id,
      tenantId,
      userId, // Ensure user owns this preference
    });

    if (!result) {
      res.status(404).json({ success: false, error: 'Preference not found' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete preference', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to delete preference',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/crawl/pages/:jobId - Get crawled pages for a job
 *
 * Query params:
 * - limit: number (default 50, max 200) — pages pagination
 * - offset: number (default 0) — pages pagination
 * - status: 'all' | 'fetched' | 'failed' | 'blocked' (default 'all')
 * - search: string (optional URL filter)
 * - errorLimit: number (default 100, max 500) — crawlErrors pagination
 * - errorOffset: number (default 0)
 * - errorType: string (optional CrawlErrorType filter)
 *
 * Response:
 * {
 *   success: true,
 *   data: {
 *     pages: Array<{ url, status, documentId, chunks, crawledAt, error?,
 *                     quality?, qualityScore?, method?, handlerReused? }>,
 *     crawlErrors: Array<{ url, type, error, statusCode?, timestamp }>,
 *     totalFailed: number,
 *     totalBlocked: number,
 *     totalErrors: number,
 *     pagination: { total, offset, limit, hasMore },
 *     errorPagination: { total, offset, limit, hasMore }
 *   }
 * }
 */
router.get('/pages/:jobId', async (req: Request, res: Response) => {
  const PagesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    status: z.enum(['all', 'indexed', 'processing', 'error']).default('all'),
    search: z.string().optional(),
    errorLimit: z.coerce.number().int().min(1).max(500).default(100),
    errorOffset: z.coerce.number().int().min(0).default(0),
    errorType: z.string().optional(),
  });

  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const { jobId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    if (!jobId || jobId.length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'Invalid job ID format' },
      });
      return;
    }

    // Validate query parameters
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

    // 1. Verify job belongs to tenant (404 if not)
    const { CrawlJob, SearchDocument, SearchChunk, CrawlError } = getModels();
    const crawlJob = await CrawlJob.findOne({ _id: jobId, tenantId }).lean();
    if (!crawlJob) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Crawl job not found' },
      });
      return;
    }

    // 2. Build query for SearchDocument
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docQuery: Record<string, any> = {
      tenantId,
      'sourceMetadata.crawlJobId': jobId,
    };

    // Filter by pipeline status
    if (statusFilter === 'indexed') {
      docQuery.status = DocumentStatus.INDEXED;
    } else if (statusFilter === 'processing') {
      docQuery.status = {
        $in: [
          DocumentStatus.PENDING,
          DocumentStatus.EXTRACTING,
          DocumentStatus.EXTRACTED,
          DocumentStatus.ENRICHING,
          DocumentStatus.ENRICHED,
          DocumentStatus.EMBEDDING,
        ],
      };
    } else if (statusFilter === 'error') {
      docQuery.status = DocumentStatus.ERROR;
    }
    // 'all' → no filter on pages query

    // Filter by URL search
    if (searchQuery) {
      docQuery.originalReference = { $regex: searchQuery, $options: 'i' };
    }

    // 3. Build CrawlError query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const crawlErrorQuery: Record<string, any> = { tenantId, crawlJobId: jobId };
    if (errorType) {
      crawlErrorQuery.type = errorType;
    }

    // 4. Run queries in parallel
    const [documents, total, crawlErrors, totalErrors] = await Promise.all([
      SearchDocument.find(docQuery).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
      SearchDocument.countDocuments(docQuery),
      CrawlError.find(crawlErrorQuery)
        .sort({ timestamp: -1 })
        .skip(errorOffset)
        .limit(errorLimit)
        .lean(),
      CrawlError.countDocuments(crawlErrorQuery),
    ]);

    // 5. Get chunk counts for each document
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const documentIds = documents.map((doc: any) => doc._id);
    const chunkCounts =
      documentIds.length > 0
        ? await SearchChunk.aggregate([
            {
              $match: {
                documentId: { $in: documentIds },
                tenantId,
              },
            },
            {
              $group: {
                _id: '$documentId',
                count: { $sum: 1 },
              },
            },
          ])
        : [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunkCountMap = new Map(chunkCounts.map((item: any) => [String(item._id), item.count]));

    // 6. Build pages response with sourceMetadata fields
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pages = documents.map((doc: any) => ({
      url: doc.originalReference || '',
      status: doc.status,
      documentId: String(doc._id),
      chunks: chunkCountMap.get(String(doc._id)) || 0,
      crawledAt: doc.sourceMetadata?.crawledAt || doc.createdAt?.toISOString?.() || '',
      error: doc.processingError || undefined,
      quality: doc.sourceMetadata?.quality || undefined,
      qualityScore: doc.sourceMetadata?.qualityScore || undefined,
      method: doc.sourceMetadata?.method || undefined,
      handlerReused: doc.sourceMetadata?.handlerReused || undefined,
    }));

    // 7. Build crawlErrors response
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const crawlErrorEntries = (crawlErrors as any[]).map((err: any) => ({
      url: err.url,
      type: err.type,
      error: err.error,
      statusCode: err.statusCode || undefined,
      timestamp: err.timestamp?.toISOString?.() ?? '',
    }));

    // 8. Return structured envelope
    const crawlJobData = crawlJob as unknown as ICrawlJob;
    res.json({
      success: true,
      data: {
        pages,
        crawlErrors: crawlErrorEntries,
        totalFailed: crawlJobData.urls?.failed || 0,
        totalBlocked: crawlJobData.urls?.blocked || 0,
        totalErrors,
        pagination: {
          total,
          offset,
          limit,
          hasMore: offset + limit < total,
        },
        errorPagination: {
          total: totalErrors,
          offset: errorOffset,
          limit: errorLimit,
          hasMore: errorOffset + errorLimit < totalErrors,
        },
      },
    });
  } catch (error) {
    logger.error('Failed to get crawled pages', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get crawled pages' },
    });
  }
});

/**
 * POST /api/crawl/jobs/:jobId/cancel - Cancel a running crawl job
 */
router.post('/jobs/:jobId/cancel', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { jobId } = req.params;
    const { tenantId } = req.tenantContext;
    const { CrawlJob } = getModels();

    const crawlJob = await CrawlJob.findOneAndUpdate(
      {
        _id: jobId,
        tenantId,
        status: { $in: ['queued', 'crawling', 'ingesting'] },
      },
      {
        $set: {
          status: 'cancelled',
          'timeline.completedAt': new Date(),
        },
        $push: {
          processingErrors: {
            timestamp: new Date(),
            phase: 'crawl',
            message: 'Job cancelled by user',
            count: 0,
          },
        },
      },
      { new: true },
    );

    if (!crawlJob) {
      res.status(404).json({
        success: false,
        error: 'Job not found or already completed/cancelled',
      });
      return;
    }

    // V2: Set Redis cancel signal so the bulk-crawl worker can detect cancellation
    const redis = getPendingRedis();
    await redis.set(`crawl:cancel:${jobId}`, '1', 'EX', 3600);

    // V2: Remove from BullMQ queue if still queued
    try {
      const queueJob = await getCrawlQueue().getJob(jobId);
      if (queueJob) {
        const state = await queueJob.getState();
        if (state === 'waiting' || state === 'delayed') {
          await queueJob.remove();
        }
      }
    } catch (err) {
      logger.warn('Failed to remove job from queue', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info('Crawl job cancelled', { jobId, tenantId });

    res.json({ success: true, jobId, status: 'cancelled' });
  } catch (error) {
    logger.error('Failed to cancel crawl job', {
      error: error instanceof Error ? error.message : String(error),
      jobId: req.params.jobId,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to cancel crawl job',
    });
  }
});

/**
 * DELETE /api/crawl/jobs/:jobId - Delete a crawl job and all associated data
 *
 * Cascade: vectors → chunks → documents → history → audit → job
 * Only terminal states (completed, failed, cancelled) can be deleted.
 */
router.delete('/jobs/:jobId', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { jobId } = req.params;
    const { tenantId } = req.tenantContext;
    const { CrawlJob, CrawlHistory, SearchDocument, SearchChunk, SearchIndex } = getModels();

    const crawlJob = (await CrawlJob.findOne({ _id: jobId, tenantId }).lean()) as any;
    if (!crawlJob) {
      res.status(404).json({ success: false, error: 'Crawl job not found' });
      return;
    }

    if (['queued', 'crawling', 'ingesting'].includes(crawlJob.status)) {
      res.status(409).json({
        success: false,
        error: 'Cannot delete an active job. Cancel it first.',
      });
      return;
    }

    // Find all documents for this job
    const documents = await SearchDocument.find(
      { tenantId, 'sourceMetadata.crawlJobId': jobId },
      { _id: 1, sourceId: 1 },
    ).lean();
    const documentIds = documents.map((d: any) => String(d._id));

    // Count chunks before deletion
    const chunkCount = await SearchChunk.countDocuments({
      documentId: { $in: documentIds },
      tenantId,
    });

    // Delete vectors from vector store (best-effort, before MongoDB cleanup)
    if (documentIds.length > 0) {
      try {
        const chunkDocs = await SearchChunk.find(
          { documentId: { $in: documentIds }, tenantId },
          { _id: 1 },
        ).lean();
        const chunkIds = chunkDocs.map((c: any) => String(c._id));

        if (chunkIds.length > 0) {
          const vectorStore: VectorStoreProvider = createVectorStore({
            provider:
              (process.env.VECTOR_STORE_PROVIDER as
                | 'opensearch'
                | 'qdrant'
                | 'pinecone'
                | 'pgvector') || 'opensearch',
            url: process.env.VECTOR_STORE_URL || 'http://localhost:9200',
            apiKey: process.env.VECTOR_STORE_API_KEY,
          });
          const sourceId = (documents[0] as any)?.sourceId;
          const vsIndexName = await resolveIndexForWrite(
            vectorStore,
            tenantId,
            crawlJob.indexId,
            sourceId,
          );
          await vectorStore.delete(vsIndexName, chunkIds);
        }
      } catch (err) {
        logger.warn('Vector store cleanup failed during job delete (continuing)', {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Delete documents with centralized cleanup (already handled vector deletion above)
    // Note: Vector deletion was already attempted above (lines 2607-2625)
    // Using cleanup service for MongoDB deletion only since vectors were cleaned
    if (documentIds.length > 0) {
      const SearchChunk = getLazyModel('SearchChunk');
      const ChunkQuestion = getLazyModel('ChunkQuestion');
      // Direct deletion since vectors already cleaned above
      await ChunkQuestion.deleteMany({ documentId: { $in: documentIds }, tenantId });
      await SearchChunk.deleteMany({ documentId: { $in: documentIds }, tenantId });
      await SearchDocument.deleteMany({ tenantId, 'sourceMetadata.crawlJobId': jobId });
    }

    // Update index counters
    if (crawlJob.indexId && (documentIds.length > 0 || chunkCount > 0)) {
      await SearchIndex.findOneAndUpdate(
        applyProjectScopeFilter({ _id: crawlJob.indexId, tenantId }, req.tenantContext!),
        { $inc: { documentCount: -documentIds.length, chunkCount: -chunkCount } },
      );

      // Safety clamp: prevent negative counters
      await SearchIndex.updateMany(
        applyProjectScopeFilter(
          { _id: crawlJob.indexId, tenantId, documentCount: { $lt: 0 } },
          req.tenantContext!,
        ),
        { $set: { documentCount: 0 } },
      );
      await SearchIndex.updateMany(
        applyProjectScopeFilter(
          { _id: crawlJob.indexId, tenantId, chunkCount: { $lt: 0 } },
          req.tenantContext!,
        ),
        { $set: { chunkCount: 0 } },
      );
    }

    await CrawlHistory.deleteMany({ crawlJobId: jobId, tenantId });
    await deleteCrawlAuditForJob(
      (filter) => deleteCrawlAuditEventsForJob(filter as { crawlJobId: string; tenantId: string }),
      { crawlJobId: jobId, tenantId },
    );

    // Delete the job itself
    await CrawlJob.deleteOne({ _id: jobId, tenantId });

    logger.info('Crawl job deleted', {
      jobId,
      documents: documentIds.length,
      chunks: chunkCount,
    });

    res.json({
      success: true,
      deleted: { documents: documentIds.length, chunks: chunkCount },
    });
  } catch (error) {
    logger.error('Failed to delete crawl job', {
      error: error instanceof Error ? error.message : String(error),
      jobId: req.params.jobId,
    });
    res.status(500).json({ success: false, error: 'Failed to delete crawl job' });
  }
});

/**
 * DELETE /api/crawl/jobs/:jobId/pages - Delete all pages for a job (keep job record)
 */
router.delete('/jobs/:jobId/pages', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { jobId } = req.params;
    const { tenantId } = req.tenantContext;
    const { CrawlJob, SearchDocument, SearchChunk, SearchIndex } = getModels();

    const crawlJob = (await CrawlJob.findOne({ _id: jobId, tenantId }).lean()) as any;
    if (!crawlJob) {
      res.status(404).json({ success: false, error: 'Crawl job not found' });
      return;
    }

    if (['queued', 'crawling', 'ingesting'].includes(crawlJob.status)) {
      res.status(409).json({
        success: false,
        error: 'Cannot delete pages of an active job. Cancel it first.',
      });
      return;
    }

    const documents = await SearchDocument.find(
      { tenantId, 'sourceMetadata.crawlJobId': jobId },
      { _id: 1, sourceId: 1 },
    ).lean();
    const documentIds = documents.map((d: any) => String(d._id));

    const chunkCount = await SearchChunk.countDocuments({
      documentId: { $in: documentIds },
      tenantId,
    });

    // Delete vectors from vector store (best-effort, before MongoDB cleanup)
    if (documentIds.length > 0) {
      try {
        const chunkDocs = await SearchChunk.find(
          { documentId: { $in: documentIds }, tenantId },
          { _id: 1 },
        ).lean();
        const chunkIds = chunkDocs.map((c: any) => String(c._id));

        if (chunkIds.length > 0) {
          const vectorStore: VectorStoreProvider = createVectorStore({
            provider:
              (process.env.VECTOR_STORE_PROVIDER as
                | 'opensearch'
                | 'qdrant'
                | 'pinecone'
                | 'pgvector') || 'opensearch',
            url: process.env.VECTOR_STORE_URL || 'http://localhost:9200',
            apiKey: process.env.VECTOR_STORE_API_KEY,
          });
          const sourceId = (documents[0] as any)?.sourceId;
          const vsIndexName = await resolveIndexForWrite(
            vectorStore,
            tenantId,
            crawlJob.indexId,
            sourceId,
          );
          await vectorStore.delete(vsIndexName, chunkIds);
        }
      } catch (err) {
        logger.warn('Vector store cleanup failed during pages delete (continuing)', {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (documentIds.length > 0) {
      // Delete questions, chunks, and documents (vectors already cleaned above)
      const ChunkQuestion = getLazyModel('ChunkQuestion');
      await ChunkQuestion.deleteMany({ documentId: { $in: documentIds }, tenantId });
      await SearchChunk.deleteMany({ documentId: { $in: documentIds }, tenantId });
      await SearchDocument.deleteMany({ tenantId, 'sourceMetadata.crawlJobId': jobId });
    }

    if (crawlJob.indexId && (documentIds.length > 0 || chunkCount > 0)) {
      await SearchIndex.findOneAndUpdate(
        applyProjectScopeFilter({ _id: crawlJob.indexId, tenantId }, req.tenantContext!),
        { $inc: { documentCount: -documentIds.length, chunkCount: -chunkCount } },
      );

      // Safety clamp: prevent negative counters
      await SearchIndex.updateMany(
        applyProjectScopeFilter(
          { _id: crawlJob.indexId, tenantId, documentCount: { $lt: 0 } },
          req.tenantContext!,
        ),
        { $set: { documentCount: 0 } },
      );
      await SearchIndex.updateMany(
        applyProjectScopeFilter(
          { _id: crawlJob.indexId, tenantId, chunkCount: { $lt: 0 } },
          req.tenantContext!,
        ),
        { $set: { chunkCount: 0 } },
      );
    }

    // Reset job results
    await CrawlJob.findOneAndUpdate(
      { _id: jobId, tenantId },
      {
        $set: {
          'results.documentsCreated': 0,
          'results.documentsIndexed': 0,
          'results.documentsFailed': 0,
          'results.chunksCreated': 0,
        },
      },
    );

    res.json({
      success: true,
      deleted: { documents: documentIds.length, chunks: chunkCount },
    });
  } catch (error) {
    logger.error('Failed to delete crawl pages', {
      error: error instanceof Error ? error.message : String(error),
      jobId: req.params.jobId,
    });
    res.status(500).json({ success: false, error: 'Failed to delete crawl pages' });
  }
});

/**
 * Cleanup on shutdown
 */
export async function closeCrawlQueue(): Promise<void> {
  if (crawlQueue) {
    await crawlQueue.close();
    logger.info('BullMQ queue closed');
    crawlQueue = null;
  }
}

export default router;
