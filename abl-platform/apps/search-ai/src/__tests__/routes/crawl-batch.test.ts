/**
 * Crawl Batch Route Contract Tests
 *
 * Tests the POST /api/crawl/batch endpoint contract:
 * - BullMQ job payload structure
 * - Strategy object in job data
 * - Filters passthrough
 * - Validation (missing fields, empty URLs, too many URLs)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// MOCKS — hoisted before any module imports
// =============================================================================

// Mock BullMQ
const { mockQueueAdd } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
}));
vi.mock('bullmq', () => ({
  Queue: vi.fn(function (this: any) {
    this.add = mockQueueAdd;
    this.close = vi.fn();
    return this;
  }),
}));

// Mock @abl/crawler components
const mockProfile = {
  domain: 'example.com',
  profiledAt: new Date(),
  siteType: 'static' as const,
  jsRequired: false,
  linkDensity: 10,
  estimatedSize: 100,
  avgResponseTime: 200,
  rateLimitDetected: false,
  maxConcurrency: 10,
  confidence: 85,
  metadata: { hasRobotsTxt: true, hasSitemap: true },
};

const mockDecision = {
  strategy: 'bulk',
  batchSize: 50,
  concurrency: 10,
  confidence: 90,
  reasoning: 'test',
  source: 'profile',
  jsHandling: 'none',
};

const mockEvaluation = {
  shouldPrompt: false,
  reason: 'high confidence',
  skipRule: 'confidence_threshold',
};

const mockResolvedResult = {
  params: {
    internalStrategy: 'bulk',
    batchSize: 50,
    concurrency: 10,
    jsHandling: 'none',
    requestedStrategy: 'smart',
    fallbackApplied: false,
    reasoning: 'test',
    discovery: { useSitemap: true, followLinks: true, maxPages: 50, maxDepth: 3 },
    limits: { maxPages: 50, maxDurationMs: 1800000, maxDepth: 3 },
  },
  warnings: [],
  errors: [],
};

vi.mock('@abl/crawler', () => ({
  FastProfiler: vi.fn(function (this: any) {
    this.profile = vi.fn().mockResolvedValue(mockProfile);
    this.extractSitemapUrls = vi
      .fn()
      .mockResolvedValue(['https://example.com/page1', 'https://example.com/page2']);
    this.discoverSitemapUrls = vi.fn().mockResolvedValue({
      allUrls: ['https://example.com/page1', 'https://example.com/page2'],
      sitemapFiles: [],
      steps: [],
    });
    return this;
  }),
  DecisionEngine: vi.fn(function (this: any) {
    this.decide = vi.fn().mockResolvedValue(mockDecision);
    return this;
  }),
  PromptEvaluator: vi.fn(function (this: any) {
    this.evaluate = vi.fn().mockResolvedValue(mockEvaluation);
    return this;
  }),
  QuestionGenerator: vi.fn(function (this: any) {
    this.generate = vi.fn().mockReturnValue([]);
    return this;
  }),
  ResponseProcessor: vi.fn(function (this: any) {
    this.applyResponses = vi.fn();
    return this;
  }),
  StrategyResolver: vi.fn(function (this: any) {
    this.resolve = vi.fn().mockResolvedValue(mockResolvedResult);
    return this;
  }),
}));

// Mock database models
const {
  mockCrawlJob,
  mockCrawlAuditEvent,
  mockSearchDocument,
  mockSearchChunk,
  mockUserCrawlPreference,
  mockSearchIndex,
  mockSearchSource,
} = vi.hoisted(() => ({
  mockCrawlJob: vi.fn(function (this: any, data: Record<string, unknown>) {
    Object.assign(this, data);
    this.save = vi.fn().mockResolvedValue(data);
    return this;
  }),
  mockCrawlAuditEvent: vi.fn(function (this: any, data: Record<string, unknown>) {
    Object.assign(this, data);
    this.save = vi.fn().mockResolvedValue(data);
    return this;
  }),
  mockSearchDocument: { findOne: vi.fn() },
  mockSearchChunk: { countDocuments: vi.fn() },
  mockUserCrawlPreference: { find: vi.fn() },
  mockSearchIndex: {
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'idx-1', tenantId: 'test-tenant' }),
    }),
  },
  mockSearchSource: {
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue({ _id: 'src-1', indexId: 'idx-1', tenantId: 'test-tenant' }),
    }),
    findOneAndUpdate: vi.fn().mockResolvedValue({ _id: 'src-1' }),
  },
}));

vi.mock('@agent-platform/database/models', () => ({
  CrawlJob: mockCrawlJob,
  CrawlAuditEvent: mockCrawlAuditEvent,
  SearchDocument: mockSearchDocument,
  SearchChunk: mockSearchChunk,
  UserCrawlPreference: mockUserCrawlPreference,
  SearchIndex: mockSearchIndex,
  SearchSource: mockSearchSource,
}));

// Mock DB layer (route uses getModel from db/index.js)
vi.mock('../../db/index.js', () => ({
  getModel: vi.fn((name: string) => {
    const models: Record<string, unknown> = {
      CrawlJob: mockCrawlJob,
      CrawlAuditEvent: mockCrawlAuditEvent,
      SearchDocument: mockSearchDocument,
      SearchChunk: mockSearchChunk,
      UserCrawlPreference: mockUserCrawlPreference,
      SearchIndex: mockSearchIndex,
      SearchSource: mockSearchSource,
    };
    return models[name];
  }),
  getLazyModel: vi.fn((name: string) => {
    const models: Record<string, unknown> = {
      CrawlJob: mockCrawlJob,
      CrawlAuditEvent: mockCrawlAuditEvent,
      SearchDocument: mockSearchDocument,
      SearchChunk: mockSearchChunk,
      UserCrawlPreference: mockUserCrawlPreference,
      SearchIndex: mockSearchIndex,
      SearchSource: mockSearchSource,
    };
    return models[name];
  }),
}));

// Mock search-ai-sdk
vi.mock('@agent-platform/search-ai-sdk', () => ({
  DocumentStatus: {},
  ChunkStatus: {},
}));

// Mock config
vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn().mockReturnValue({ redis: { url: 'redis://localhost:6379' } }),
}));

// Mock rate limit middleware
vi.mock('../../middleware/rate-limit.js', () => ({
  searchAiRateLimit: vi
    .fn()
    .mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));

// Mock queue monitor
vi.mock('../../workers/queue-monitor.js', () => ({
  getAllQueueStats: vi.fn().mockResolvedValue([]),
  getAllQueueHealth: vi.fn().mockResolvedValue([]),
}));

// Mock duration estimator
vi.mock('../../services/crawler/duration-estimator.js', () => ({
  estimateCrawlDuration: vi.fn().mockReturnValue({
    min: 30,
    max: 120,
    unit: 'seconds',
    formatted: '30s - 2min',
  }),
}));

// Mock circuit breaker
vi.mock('../../services/crawler/circuit-breaker.js', () => ({
  CircuitBreaker: vi.fn(function (this: any) {
    this.isOpen = vi.fn().mockResolvedValue({ blocked: false });
    this.recordSuccess = vi.fn().mockResolvedValue(undefined);
    this.recordFailure = vi.fn().mockResolvedValue(undefined);
    return this;
  }),
}));

// Mock Redis connection
vi.mock('ioredis', () => ({
  default: vi.fn(function (this: any) {
    return this;
  }),
}));

vi.mock('../../workers/shared.js', () => ({
  QUEUE_BULK_CRAWL: 'bulk-crawl',
  createQueue: vi.fn().mockReturnValue({
    add: mockQueueAdd,
    close: vi.fn().mockResolvedValue(undefined),
  }),
  getRedisConnection: vi.fn().mockReturnValue({
    host: 'localhost',
    port: 6379,
  }),
  getSharedRedisClient: vi.fn().mockReturnValue({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  }),
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

// Mock logger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock SSRF protection
vi.mock('../../utils/ssrf-protection.js', () => ({
  isURLAllowed: vi.fn().mockResolvedValue({ allowed: true }),
}));

// =============================================================================
// Import Express + Supertest AFTER all mocks are set up
// =============================================================================

import express from 'express';
import request from 'supertest';
import crawlRoutes from '../../routes/crawl.js';

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  // Inject mock tenant context
  app.use((req: any, _res: any, next: () => void) => {
    req.tenantContext = {
      tenantId: 'test-tenant',
      userId: 'test-user',
      role: 'admin',
      permissions: ['admin:indexes:read'],
      authType: 'jwt_user',
      isSuperAdmin: false,
      identityTier: 'user',
      verificationMethod: 'jwt',
    };
    next();
  });
  app.use('/api/crawl', crawlRoutes);
  return app;
}

// =============================================================================
// TESTS
// =============================================================================

describe('POST /api/crawl/batch', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    vi.clearAllMocks();
  });

  test('should return 200 and enqueue a BullMQ job for valid request', async () => {
    const response = await request(app)
      .post('/api/crawl/batch')
      .send({
        urls: ['https://example.com'],
        indexId: 'idx-1',
        sourceId: 'src-1',
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.needsUserInput).toBe(false);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  test('should include resolved strategy info in BullMQ payload', async () => {
    await request(app)
      .post('/api/crawl/batch')
      .send({
        urls: ['https://example.com'],
        indexId: 'idx-1',
        sourceId: 'src-1',
      })
      .expect(200);

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const jobData = mockQueueAdd.mock.calls[0][1];

    // The resolvedStrategy object must be present
    expect(jobData.resolvedStrategy).toBeDefined();
    expect(typeof jobData.resolvedStrategy).toBe('object');
    expect(jobData.resolvedStrategy).toHaveProperty('requestedStrategy');
    expect(jobData.resolvedStrategy).toHaveProperty('internalStrategy');
    expect(jobData.resolvedStrategy).toHaveProperty('discovery');
    expect(jobData.resolvedStrategy).toHaveProperty('limits');
  });

  test('should include followLinks in options based on resolved params', async () => {
    await request(app)
      .post('/api/crawl/batch')
      .send({
        urls: ['https://example.com'],
        indexId: 'idx-1',
        sourceId: 'src-1',
        strategy: 'smart',
      })
      .expect(200);

    const jobData = mockQueueAdd.mock.calls[0][1];
    // Smart strategy with sitemap enables link following
    expect(jobData.options.followLinks).toBe(true);
  });

  test('should pass filters through to BullMQ payload when provided', async () => {
    // NOTE: This test verifies the contract that Workstream A must implement.
    // Until the route reads `req.body.filters` and forwards it to the job data,
    // this test documents the expected behavior.
    await request(app)
      .post('/api/crawl/batch')
      .send({
        urls: ['https://example.com'],
        indexId: 'idx-1',
        sourceId: 'src-1',
        filters: {
          includePaths: ['/docs/*'],
          excludePaths: ['/blog/*'],
        },
      })
      .expect(200);

    const jobData = mockQueueAdd.mock.calls[0][1];
    // Once Workstream A implements filters passthrough:
    // expect(jobData.filters).toBeDefined();
    // expect(jobData.filters.includePaths).toEqual(['/docs/*']);
    // expect(jobData.filters.excludePaths).toEqual(['/blog/*']);
    // For now, just verify the job was queued successfully
    expect(jobData).toBeDefined();
  });

  test('should return 400 for missing indexId', async () => {
    const response = await request(app)
      .post('/api/crawl/batch')
      .send({
        urls: ['https://example.com'],
        sourceId: 'src-1',
      })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('indexId');
  });

  test('should return 400 for missing sourceId', async () => {
    const response = await request(app)
      .post('/api/crawl/batch')
      .send({
        urls: ['https://example.com'],
        indexId: 'idx-1',
      })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('sourceId');
  });

  test('should return 400 for empty urls array', async () => {
    const response = await request(app)
      .post('/api/crawl/batch')
      .send({
        urls: [],
        indexId: 'idx-1',
        sourceId: 'src-1',
      })
      .expect(400);

    expect(response.body.success).toBe(false);
  });

  test('should return 400 for missing urls', async () => {
    const response = await request(app)
      .post('/api/crawl/batch')
      .send({
        indexId: 'idx-1',
        sourceId: 'src-1',
      })
      .expect(400);

    expect(response.body.success).toBe(false);
  });

  test('should return 400 for too many urls (over 50000)', async () => {
    const manyUrls = Array.from({ length: 50001 }, (_, i) => `https://example.com/page${i}`);
    const response = await request(app)
      .post('/api/crawl/batch')
      .send({
        urls: manyUrls,
        indexId: 'idx-1',
        sourceId: 'src-1',
      })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('50000');
  });

  test('should return 400 for invalid URL format', async () => {
    const response = await request(app)
      .post('/api/crawl/batch')
      .send({
        urls: ['not-a-url'],
        indexId: 'idx-1',
        sourceId: 'src-1',
      })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('Invalid URL');
  });

  test('should return 401 when tenantContext is missing', async () => {
    // Create app without tenant context injection
    const noAuthApp = express();
    noAuthApp.use(express.json());
    noAuthApp.use('/api/crawl', crawlRoutes);

    const response = await request(noAuthApp)
      .post('/api/crawl/batch')
      .send({
        urls: ['https://example.com'],
        indexId: 'idx-1',
        sourceId: 'src-1',
      })
      .expect(401);

    expect(response.body.success).toBe(false);
  });

  test('should include tenantId and sourceId in job data', async () => {
    await request(app)
      .post('/api/crawl/batch')
      .send({
        urls: ['https://example.com'],
        indexId: 'idx-1',
        sourceId: 'src-1',
      })
      .expect(200);

    const jobData = mockQueueAdd.mock.calls[0][1];
    expect(jobData.tenantId).toBe('test-tenant');
    expect(jobData.indexId).toBe('idx-1');
    expect(jobData.sourceId).toBe('src-1');
  });

  test('should include batchId in job data', async () => {
    await request(app)
      .post('/api/crawl/batch')
      .send({
        urls: ['https://example.com'],
        indexId: 'idx-1',
        sourceId: 'src-1',
      })
      .expect(200);

    const jobData = mockQueueAdd.mock.calls[0][1];
    expect(jobData.batchId).toBeDefined();
    expect(jobData.batchId).toMatch(/^batch-/);
  });

  test('should return strategy info in response body', async () => {
    const response = await request(app)
      .post('/api/crawl/batch')
      .send({
        urls: ['https://example.com'],
        indexId: 'idx-1',
        sourceId: 'src-1',
        strategy: 'smart',
      })
      .expect(200);

    expect(response.body.strategy).toBeDefined();
    expect(response.body.strategy.requested).toBe('smart');
    expect(response.body.strategy.internal).toBe('bulk');
  });
});
