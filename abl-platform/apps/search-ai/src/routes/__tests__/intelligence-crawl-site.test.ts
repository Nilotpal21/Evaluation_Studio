/**
 * Intelligence Crawl-Site Route Tests
 *
 * Tests for POST /intelligence/crawl-site and GET /intelligence/crawl-site/:jobId
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Hoisted Mocks
// ---------------------------------------------------------------------------

const {
  mockSearchIndexFindOne,
  mockSearchSourceCreate,
  mockCrawlJobCreate,
  mockCrawlJobFindOne,
  mockSearchDocumentFind,
  mockQueueAdd,
  mockExtractSitemapUrls,
  mockIsURLAllowed,
  mockRedisGet,
  mockRedisSetex,
  mockRedisSet,
  mockRedisDel,
  mockRedisIncr,
  mockRedisExists,
  mockRedisExpire,
  mockRedisPublish,
  mockRedisKeys,
  mockRedisScan,
  mockRedisPipeline,
} = vi.hoisted(() => ({
  mockSearchIndexFindOne: vi.fn(),
  mockSearchSourceCreate: vi.fn(),
  mockCrawlJobCreate: vi.fn(),
  mockCrawlJobFindOne: vi.fn(),
  mockSearchDocumentFind: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockExtractSitemapUrls: vi.fn(),
  mockIsURLAllowed: vi.fn(),
  mockRedisGet: vi.fn(),
  mockRedisSetex: vi.fn().mockResolvedValue('OK'),
  mockRedisSet: vi.fn().mockResolvedValue('OK'),
  mockRedisDel: vi.fn().mockResolvedValue(1),
  mockRedisIncr: vi.fn().mockResolvedValue(1),
  mockRedisExists: vi.fn().mockResolvedValue(0),
  mockRedisExpire: vi.fn().mockResolvedValue(1),
  mockRedisPublish: vi.fn().mockResolvedValue(1),
  mockRedisKeys: vi.fn().mockResolvedValue([]),
  mockRedisScan: vi.fn().mockResolvedValue(['0', []]),
  mockRedisPipeline: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module Mocks
// ---------------------------------------------------------------------------

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    switch (modelName) {
      case 'SearchIndex':
        return { findOne: mockSearchIndexFindOne };
      case 'SearchSource':
        return { create: mockSearchSourceCreate };
      case 'CrawlJob':
        return { create: mockCrawlJobCreate, findOne: mockCrawlJobFindOne };
      case 'SearchDocument':
        return { find: mockSearchDocumentFind };
      default:
        return {};
    }
  }),
}));

vi.mock('../../workers/shared.js', () => ({
  getRedisConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  getSharedRedisClient: () => ({
    get: mockRedisGet,
    setex: mockRedisSetex,
    set: mockRedisSet,
    del: mockRedisDel,
    incr: mockRedisIncr,
    exists: mockRedisExists,
    expire: mockRedisExpire,
    publish: mockRedisPublish,
    keys: mockRedisKeys,
    scan: mockRedisScan,
    pipeline: mockRedisPipeline,
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
  }),
  createQueue: vi.fn(() => ({
    add: mockQueueAdd,
  })),
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

vi.mock('ioredis', () => {
  class MockIORedis {
    get = mockRedisGet;
    setex = mockRedisSetex;
    set = mockRedisSet;
    del = mockRedisDel;
    incr = mockRedisIncr;
    exists = mockRedisExists;
    expire = mockRedisExpire;
    publish = mockRedisPublish;
    keys = mockRedisKeys;
    scan = mockRedisScan;
    pipeline = mockRedisPipeline;
    on = vi.fn().mockReturnThis();
    quit = vi.fn().mockResolvedValue('OK');
    disconnect = vi.fn();
    status = 'ready';
  }
  return { default: MockIORedis, Redis: MockIORedis };
});

vi.mock('@abl/compiler/platform', () => ({
  MCPClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn(),
  })),
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/database/models', () => ({}));

vi.mock('../../utils/ssrf-protection.js', () => ({
  isURLAllowed: mockIsURLAllowed,
}));

vi.mock('@abl/crawler', () => {
  class MockTemplateFingerprinter {
    fingerprint = vi.fn().mockReturnValue({ fingerprint: 0n, tagPathCount: 0 });
    compare = vi.fn();
    cluster = vi.fn();
    static toSerializable = vi
      .fn()
      .mockReturnValue({ fingerprint: '0000000000000000', tagPathCount: 0 });
    static hammingDistance = vi.fn().mockReturnValue(0);
  }
  return {
    CrawlIntelligenceService: vi.fn().mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({
        replay: { content: { title: 'Test', body: 'Test body content', metadata: {} } },
        buildHandler: {
          handler: { steps: [{ action: 'navigate' }], urlPattern: '**/*.html' },
        },
        llmCallCount: 3,
        totalTokens: 1000,
        handlerReused: false,
      }),
    })),
    FastProfiler: class MockFastProfiler {
      extractSitemapUrls = mockExtractSitemapUrls;
      discoverSitemapUrls = vi.fn(async () => {
        const allUrls = await mockExtractSitemapUrls();
        return { allUrls, sitemapFiles: [], steps: [] };
      });
    },
    HandlerReuser: vi.fn().mockImplementation(() => ({
      registerHandler: vi.fn(),
      tryReuse: vi.fn().mockReturnValue({ matched: false, skippedPhases: [], llmCallsSaved: 0 }),
      match: vi.fn().mockReturnValue({ matched: false }),
      getStats: vi
        .fn()
        .mockReturnValue({ size: 0, maxSize: 1000, templateCount: 0, expiredCount: 0 }),
    })),
    TemplateFingerprinter: MockTemplateFingerprinter,
    MongoHandlerStore: vi.fn().mockImplementation(() => ({
      saveHandler: vi.fn().mockResolvedValue(undefined),
      findByFingerprint: vi.fn().mockResolvedValue(null),
      findByDomain: vi.fn().mockResolvedValue([]),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
      deleteByDomain: vi.fn().mockResolvedValue(0),
    })),
  };
});

vi.mock('../../services/llm-config/resolver.js', () => ({
  resolveIndexLLMConfig: vi.fn().mockResolvedValue({
    tenantId: 'tenant-1',
    provider: 'anthropic',
    apiKey: 'test-api-key',
    indexId: 'index-1',
    useCases: {},
  }),
}));

vi.mock('../../services/llm-config/tenant-model-adapter.js', () => ({
  resolveTenantModelWithFallback: vi.fn().mockResolvedValue({
    model: { modelId: 'claude-sonnet-4-20250514', provider: 'anthropic', apiKey: 'test-key' },
    actualTier: 'balanced',
    reason: 'default_tier',
  }),
}));

vi.mock('@agent-platform/llm', () => ({
  WorkerLLMClient: vi.fn().mockImplementation(() => ({
    chat: vi.fn(),
    chatWithToolUse: vi.fn(),
  })),
}));

vi.mock('../progress.js', () => ({
  publishProgressEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../storage/storage-factory.js', () => ({
  createFileStorage: vi.fn(),
  readFileFromStorage: vi.fn(),
}));

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    storage: { provider: 'local', basePath: './uploads', bucket: 'test' },
  }),
}));

vi.mock('../../services/ingestion/crawler-ingestion.js', () => ({
  crawlerIngestionService: {
    ingestCrawledContent: vi.fn(),
  },
}));

vi.mock('@agent-platform/search-ai-sdk', () => ({
  QUEUE_INTELLIGENCE_CRAWL: 'intelligence-crawl',
}));

// ---------------------------------------------------------------------------
// Test App Setup
// ---------------------------------------------------------------------------

async function createTestApp(tenantId = 'tenant-1'): Promise<Express> {
  const app = express();
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).tenantContext = {
      tenantId,
      userId: 'user-1',
      role: 'ADMIN',
      permissions: ['*'],
      authType: 'user' as const,
      isSuperAdmin: false,
    };
    next();
  });

  const { intelligenceRouter } = await import('../intelligence.js');
  app.use('/api/crawl', intelligenceRouter);

  // Error handler
  app.use((err: any, _req: any, res: any, _next: any) => {
    res
      .status(500)
      .json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
  });

  return app;
}

// ---------------------------------------------------------------------------
// POST /intelligence/crawl-site Tests
// ---------------------------------------------------------------------------

describe('POST /intelligence/crawl-site', () => {
  let app: Express;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default mocks
    mockIsURLAllowed.mockResolvedValue({ allowed: true });
    mockRedisIncr.mockResolvedValue(1);
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'index-1', tenantId: 'tenant-1', name: 'Test' }),
    });
    mockSearchSourceCreate.mockResolvedValue({
      _id: 'source-1',
      tenantId: 'tenant-1',
      indexId: 'index-1',
      name: 'https://example.com',
      sourceType: 'web',
      status: 'pending',
    });
    mockCrawlJobCreate.mockResolvedValue({ _id: 'crawl-job-1' });
    mockQueueAdd.mockResolvedValue({ id: 'queue-job-1' });
    mockExtractSitemapUrls.mockResolvedValue([
      'https://example.com/',
      'https://example.com/about',
      'https://example.com/contact',
    ]);

    app = await createTestApp();
  });

  // ─── Happy Path ──────────────────────────────────────────────────────────

  test('happy path: creates CrawlJob + SearchSource, enqueues job, returns jobId', async () => {
    const res = await request(app).post('/api/crawl/intelligence/crawl-site').send({
      url: 'https://example.com',
      indexId: 'index-1',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.jobId).toBeDefined();
    expect(res.body.sourceId).toBe('source-1');
    expect(res.body.status).toBe('queued');
    expect(res.body.discovery.source).toBe('sitemap');
    expect(res.body.discovery.urlCount).toBe(3);
    expect(res.body.estimatedLlmCalls).toBeDefined();

    // Verify SearchSource was created
    expect(mockSearchSourceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        indexId: 'index-1',
        sourceType: 'web',
        status: 'pending',
      }),
    );

    // Verify CrawlJob was created
    expect(mockCrawlJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        status: 'queued',
        strategy: 'intelligence',
        indexId: 'index-1',
        sourceId: 'source-1',
      }),
    );

    // Verify job was enqueued
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'intelligence-crawl',
      expect.objectContaining({
        tenantId: 'tenant-1',
        indexId: 'index-1',
        sourceId: 'source-1',
        entryUrl: 'https://example.com',
        discoveredUrls: expect.arrayContaining(['https://example.com/']),
      }),
      expect.objectContaining({
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      }),
    );
  });

  // ─── Validation Errors ───────────────────────────────────────────────────

  test('returns 400 for missing url', async () => {
    const res = await request(app)
      .post('/api/crawl/intelligence/crawl-site')
      .send({ indexId: 'index-1' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 for invalid url', async () => {
    const res = await request(app)
      .post('/api/crawl/intelligence/crawl-site')
      .send({ url: 'not-a-url', indexId: 'index-1' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 for missing indexId', async () => {
    const res = await request(app)
      .post('/api/crawl/intelligence/crawl-site')
      .send({ url: 'https://example.com' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // ─── SSRF Blocked ───────────────────────────────────────────────────────

  test('returns 400 for SSRF-blocked URL', async () => {
    mockIsURLAllowed.mockResolvedValueOnce({
      allowed: false,
      reason: 'Private IP range',
    });

    const res = await request(app).post('/api/crawl/intelligence/crawl-site').send({
      url: 'https://example.com',
      indexId: 'index-1',
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('URL_BLOCKED');
  });

  // ─── Rate Limit ─────────────────────────────────────────────────────────

  test('returns 429 when hourly rate limit exceeded', async () => {
    mockRedisIncr.mockResolvedValueOnce(6); // > 5

    const res = await request(app).post('/api/crawl/intelligence/crawl-site').send({
      url: 'https://example.com',
      indexId: 'index-1',
    });

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('RATE_LIMIT_HOURLY');
  });

  // ─── Cross-Tenant Index ──────────────────────────────────────────────────

  test('returns 404 for cross-tenant index', async () => {
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const res = await request(app).post('/api/crawl/intelligence/crawl-site').send({
      url: 'https://example.com',
      indexId: 'index-other',
    });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ─── Sitemap Failure Fallback ────────────────────────────────────────────

  test('falls back to entry URL when sitemap discovery fails', async () => {
    mockExtractSitemapUrls.mockRejectedValueOnce(new Error('Sitemap fetch timeout'));

    const res = await request(app).post('/api/crawl/intelligence/crawl-site').send({
      url: 'https://example.com',
      indexId: 'index-1',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.discovery.source).toBe('entry-only');
    expect(res.body.discovery.urlCount).toBe(1);
  });

  // ─── Same-Domain Filter ──────────────────────────────────────────────────

  test('filters out off-domain URLs from sitemap', async () => {
    mockExtractSitemapUrls.mockResolvedValueOnce([
      'https://example.com/page1',
      'https://other-site.com/page2',
      'https://example.com/page3',
    ]);

    const res = await request(app).post('/api/crawl/intelligence/crawl-site').send({
      url: 'https://example.com',
      indexId: 'index-1',
    });

    expect(res.status).toBe(200);
    expect(res.body.discovery.urlCount).toBe(2);
    // Verify enqueued job has only same-domain URLs
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'intelligence-crawl',
      expect.objectContaining({
        discoveredUrls: ['https://example.com/page1', 'https://example.com/page3'],
      }),
      expect.any(Object),
    );
  });

  // ─── Auth ────────────────────────────────────────────────────────────────

  test('returns 401 when no tenantId', async () => {
    const noAuthApp = express();
    noAuthApp.use(express.json());
    noAuthApp.use((req: Request, _res: Response, next: NextFunction) => {
      next();
    });
    const { intelligenceRouter } = await import('../intelligence.js');
    noAuthApp.use('/api/crawl', intelligenceRouter);
    noAuthApp.use((err: any, _req: any, res: any, _next: any) => {
      res
        .status(500)
        .json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
    });

    const res = await request(noAuthApp).post('/api/crawl/intelligence/crawl-site').send({
      url: 'https://example.com',
      indexId: 'index-1',
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// GET /intelligence/crawl-site/:jobId Tests
// ---------------------------------------------------------------------------

describe('GET /intelligence/crawl-site/:jobId', () => {
  let app: Express;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default — no-op for POST mocks (avoid interference)
    mockIsURLAllowed.mockResolvedValue({ allowed: true });
    mockRedisIncr.mockResolvedValue(1);

    app = await createTestApp();
  });

  test('returns summary + pages for an active crawl job', async () => {
    mockCrawlJobFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'job-1',
        tenantId: 'tenant-1',
        status: 'crawling',
        strategy: 'intelligence',
        indexId: 'index-1',
        sourceId: 'source-1',
        urls: {
          original: ['https://example.com'],
          expanded: ['https://example.com/', 'https://example.com/about'],
        },
      }),
    });
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'index-1', tenantId: 'tenant-1', name: 'Test' }),
    });

    // Per-page checkpoints — scanKeys calls scan(), then Promise.all calls get() per key
    mockRedisScan.mockResolvedValueOnce([
      '0',
      [
        'intelligence-crawl:page:tenant-1:job-1:url1',
        'intelligence-crawl:page:tenant-1:job-1:url2',
      ],
    ]);
    mockRedisGet
      .mockResolvedValueOnce(
        JSON.stringify({
          url: 'https://example.com/',
          status: 'completed',
          completedAt: '2026-03-22T10:00:00Z',
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          url: 'https://example.com/about',
          status: 'processing',
          startedAt: '2026-03-22T10:01:00Z',
        }),
      );

    // Completed documents
    mockSearchDocumentFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi
          .fn()
          .mockResolvedValue([
            { _id: 'doc-1', originalReference: 'https://example.com/', status: 'indexed' },
          ]),
      }),
    });

    const res = await request(app).get('/api/crawl/intelligence/crawl-site/job-1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.jobId).toBe('job-1');
    expect(res.body.summary.status).toBe('crawling');
    expect(res.body.summary.totalUrls).toBe(2);
    expect(res.body.summary.completed).toBe(1);
    expect(res.body.summary.processing).toBe(1);
    expect(res.body.summary.documentsCreated).toBe(1);
    expect(res.body.pages).toHaveLength(2);
    expect(res.body.pagination).toBeDefined();
  });

  test('returns 404 for non-existent crawl job', async () => {
    mockCrawlJobFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const res = await request(app).get('/api/crawl/intelligence/crawl-site/non-existent');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('returns 401 when no tenantId', async () => {
    const noAuthApp = express();
    noAuthApp.use(express.json());
    noAuthApp.use((req: Request, _res: Response, next: NextFunction) => {
      next();
    });
    const { intelligenceRouter } = await import('../intelligence.js');
    noAuthApp.use('/api/crawl', intelligenceRouter);
    noAuthApp.use((err: any, _req: any, res: any, _next: any) => {
      res
        .status(500)
        .json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
    });

    const res = await request(noAuthApp).get('/api/crawl/intelligence/crawl-site/job-1');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
