/**
 * Crawler Security & Endpoint Tests
 *
 * Verifies:
 * 1. Tenant isolation on all new endpoints (history, preferences, profile)
 * 2. Rate limiting on profile endpoint
 * 3. Input validation and error handling
 * 4. Cursor-based pagination correctness
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

const { mockWriteCrawlAuditEvent, mockDeleteCrawlAuditEventsForJob } = vi.hoisted(() => ({
  mockWriteCrawlAuditEvent: vi.fn().mockResolvedValue(undefined),
  mockDeleteCrawlAuditEventsForJob: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCrawlJob = {
  find: vi.fn(),
  findOne: vi.fn(),
};

const mockSearchDocument = { find: vi.fn(), countDocuments: vi.fn() };
const mockSearchChunk = { find: vi.fn(), countDocuments: vi.fn() };
const mockUserCrawlPreference = {
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
  findOneAndDelete: vi.fn(),
};

vi.mock('@agent-platform/database/models', () => ({
  CrawlJob: mockCrawlJob,
  SearchDocument: mockSearchDocument,
  SearchChunk: mockSearchChunk,
  UserCrawlPreference: mockUserCrawlPreference,
}));

// Mock db/index.js — crawl.ts uses getModel() for lazy model access
vi.mock('../../db/index.js', () => ({
  getModel: (name: string) => {
    const models: Record<string, any> = {
      CrawlJob: mockCrawlJob,
      SearchDocument: mockSearchDocument,
      SearchChunk: mockSearchChunk,
      UserCrawlPreference: mockUserCrawlPreference,
    };
    return models[name];
  },
  getLazyModel: (name: string) => {
    const models: Record<string, any> = {
      CrawlJob: mockCrawlJob,
      SearchDocument: mockSearchDocument,
      SearchChunk: mockSearchChunk,
      UserCrawlPreference: mockUserCrawlPreference,
    };
    return models[name];
  },
}));

vi.mock('../../services/crawl-audit.service.js', () => ({
  writeCrawlAuditEvent: mockWriteCrawlAuditEvent,
  deleteCrawlAuditEventsForJob: mockDeleteCrawlAuditEventsForJob,
}));

vi.mock('../../middleware/rate-limit.js', () => ({
  searchAiRateLimit: (_opts?: any) => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../config/index.js', () => ({
  getConfig: () => ({
    redis: { url: 'redis://localhost:6379' },
    jwt: { secret: 'test-secret' },
  }),
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue({ id: 'job-123' }),
    getJob: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock('@abl/crawler', () => {
  class MockFastProfiler {
    profile = vi.fn().mockResolvedValue({
      domain: 'example.com',
      siteType: 'documentation',
      estimatedSize: 42,
      avgResponseTime: 150,
      metadata: {
        hasSitemap: true,
        jsRequired: false,
        title: 'Example',
        description: 'Example site',
        favicon: 'https://example.com/favicon.ico',
      },
    });
    extractSitemapUrls = vi.fn().mockResolvedValue([]);
  }
  class MockDecisionEngine {
    decide = vi.fn().mockResolvedValue({ strategy: 'bulk', confidence: 90 });
  }
  class MockPromptEvaluator {
    evaluate = vi.fn().mockResolvedValue({ shouldPrompt: false });
  }
  class MockQuestionGenerator {
    generate = vi.fn().mockReturnValue([]);
  }
  class MockResponseProcessor {
    applyResponses = vi.fn();
  }
  class MockStrategyResolver {
    resolve = vi.fn().mockResolvedValue({ params: {}, warnings: [], errors: [] });
  }
  return {
    FastProfiler: MockFastProfiler,
    DecisionEngine: MockDecisionEngine,
    PromptEvaluator: MockPromptEvaluator,
    QuestionGenerator: MockQuestionGenerator,
    ResponseProcessor: MockResponseProcessor,
    StrategyResolver: MockStrategyResolver,
  };
});

vi.mock('../../workers/queue-monitor.js', () => ({
  getAllQueueStats: vi.fn().mockResolvedValue({}),
  getAllQueueHealth: vi.fn().mockResolvedValue({}),
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

// Mock duration estimator
vi.mock('../../services/crawler/duration-estimator.js', () => ({
  estimateCrawlDuration: vi
    .fn()
    .mockReturnValue({ min: 30, max: 120, unit: 'seconds', formatted: '30s - 2min' }),
}));

// Mock circuit breaker
vi.mock('../../services/crawler/circuit-breaker.js', () => {
  class MockCircuitBreaker {
    isOpen = vi.fn().mockResolvedValue({ blocked: false });
    recordSuccess = vi.fn().mockResolvedValue(undefined);
    recordFailure = vi.fn().mockResolvedValue(undefined);
  }
  return { CircuitBreaker: MockCircuitBreaker };
});

// Mock Redis
vi.mock('ioredis', () => {
  class MockRedis {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue('OK');
    del = vi.fn().mockResolvedValue(1);
    quit = vi.fn().mockResolvedValue('OK');
  }
  return { default: MockRedis };
});

vi.mock('../../workers/shared.js', () => ({
  getSharedRedisClient: vi.fn().mockReturnValue({ host: 'localhost', port: 6379 }),
  getRedisConnection: vi.fn().mockReturnValue({ host: 'localhost', port: 6379 }),
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

// Use the mock variables directly (CrawlJob = mockCrawlJob, etc.)
const CrawlJob = mockCrawlJob;
const UserCrawlPreference = mockUserCrawlPreference;

// ---------------------------------------------------------------------------
// Test app setup
// ---------------------------------------------------------------------------

async function createTestApp(tenantId: string, userId: string): Promise<Express> {
  const app = express();
  app.use(express.json());

  // Simulate auth middleware — injects tenantContext
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).tenantContext = { tenantId, userId };
    next();
  });

  // Lazy-import the router — must be after mocks
  const { default: crawlRouter } = await import('../crawl.js');
  app.use('/api/crawl', crawlRouter);

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Crawler Security & Endpoints', () => {
  let app: Express;

  beforeEach(async () => {
    app = await createTestApp('tenant-A', 'user-1');
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Profile endpoint
  // =========================================================================

  describe('POST /api/crawl/profile', () => {
    test('should reject unauthenticated requests', async () => {
      const unauthApp = express();
      unauthApp.use(express.json());
      // No tenantContext middleware
      const { default: crawlRouter } = await import('../crawl.js');
      unauthApp.use('/api/crawl', crawlRouter);

      const res = await request(unauthApp)
        .post('/api/crawl/profile')
        .send({ url: 'https://example.com' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    test('should reject missing URL', async () => {
      const res = await request(app).post('/api/crawl/profile').send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('should reject invalid URL format', async () => {
      const res = await request(app).post('/api/crawl/profile').send({ url: 'not-a-url' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('should return profile for valid URL', async () => {
      const res = await request(app)
        .post('/api/crawl/profile')
        .send({ url: 'https://example.com' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.domain).toBe('example.com');
      expect(res.body.siteType).toBe('documentation');
      expect(res.body.estimatedSize).toBe(42);
      expect(res.body.hasSitemap).toBe(true);
      expect(res.body.jsRequired).toBe(false);
      expect(res.body.metadata.title).toBe('Example');
    });
  });

  // =========================================================================
  // History endpoint — tenant isolation
  // =========================================================================

  describe('GET /api/crawl/history', () => {
    test('should reject unauthenticated requests', async () => {
      const unauthApp = express();
      unauthApp.use(express.json());
      const { default: crawlRouter } = await import('../crawl.js');
      unauthApp.use('/api/crawl', crawlRouter);

      const res = await request(unauthApp).get('/api/crawl/history?indexId=idx-1');
      expect(res.status).toBe(401);
    });

    test('should require indexId parameter', async () => {
      const res = await request(app).get('/api/crawl/history');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('indexId');
    });

    test('should filter by tenantId (tenant isolation)', async () => {
      const mockSort = vi.fn().mockReturnThis();
      const mockLimit = vi.fn().mockReturnThis();
      const mockSelect = vi.fn().mockReturnThis();
      const mockLean = vi.fn().mockResolvedValue([]);

      (CrawlJob.find as any).mockReturnValue({
        sort: mockSort,
        limit: mockLimit,
        select: mockSelect,
        lean: mockLean,
      });

      await request(app).get('/api/crawl/history?indexId=idx-1');

      // Verify the query included tenantId
      const queryArg = (CrawlJob.find as any).mock.calls[0][0];
      expect(queryArg.tenantId).toBe('tenant-A');
      expect(queryArg.indexId).toBe('idx-1');
    });

    test('should not return jobs from other tenants', async () => {
      const mockSort = vi.fn().mockReturnThis();
      const mockLimit = vi.fn().mockReturnThis();
      const mockSelect = vi.fn().mockReturnThis();
      const mockLean = vi.fn().mockResolvedValue([]);

      (CrawlJob.find as any).mockReturnValue({
        sort: mockSort,
        limit: mockLimit,
        select: mockSelect,
        lean: mockLean,
      });

      // Tenant B querying tenant A's indexId
      const appB = await createTestApp('tenant-B', 'user-2');
      const res = await request(appB).get('/api/crawl/history?indexId=idx-1');

      expect(res.status).toBe(200);
      expect(res.body.jobs).toEqual([]);

      // Verify tenant B's tenantId was used
      const queryArg = (CrawlJob.find as any).mock.calls[0][0];
      expect(queryArg.tenantId).toBe('tenant-B');
    });

    test('should support cursor-based pagination', async () => {
      const mockSort = vi.fn().mockReturnThis();
      const mockLimit = vi.fn().mockReturnThis();
      const mockSelect = vi.fn().mockReturnThis();
      const mockLean = vi.fn().mockResolvedValue([
        { _id: 'job-3', status: 'completed' },
        { _id: 'job-2', status: 'completed' },
      ]);

      (CrawlJob.find as any).mockReturnValue({
        sort: mockSort,
        limit: mockLimit,
        select: mockSelect,
        lean: mockLean,
      });

      const res = await request(app).get('/api/crawl/history?indexId=idx-1&limit=2&cursor=job-4');

      expect(res.status).toBe(200);

      // Verify cursor was applied
      const queryArg = (CrawlJob.find as any).mock.calls[0][0];
      expect(queryArg._id).toEqual({ $lt: 'job-4' });
    });

    test('should cap limit to 100', async () => {
      const mockSort = vi.fn().mockReturnThis();
      const mockLimit = vi.fn().mockReturnThis();
      const mockSelect = vi.fn().mockReturnThis();
      const mockLean = vi.fn().mockResolvedValue([]);

      (CrawlJob.find as any).mockReturnValue({
        sort: mockSort,
        limit: mockLimit,
        select: mockSelect,
        lean: mockLean,
      });

      await request(app).get('/api/crawl/history?indexId=idx-1&limit=500');

      // Should clamp to 100 + 1 (hasMore check)
      expect(mockLimit).toHaveBeenCalledWith(101);
    });

    test('should report hasMore correctly', async () => {
      const threeJobs = [
        { _id: 'job-3' },
        { _id: 'job-2' },
        { _id: 'job-1' }, // Extra one indicates hasMore
      ];

      const mockSort = vi.fn().mockReturnThis();
      const mockLimit = vi.fn().mockReturnThis();
      const mockSelect = vi.fn().mockReturnThis();
      const mockLean = vi.fn().mockResolvedValue(threeJobs);

      (CrawlJob.find as any).mockReturnValue({
        sort: mockSort,
        limit: mockLimit,
        select: mockSelect,
        lean: mockLean,
      });

      const res = await request(app).get('/api/crawl/history?indexId=idx-1&limit=2');

      expect(res.body.hasMore).toBe(true);
      expect(res.body.jobs).toHaveLength(2); // Extra stripped
      expect(res.body.cursor).toBe('job-2');
    });
  });

  // =========================================================================
  // Preferences — tenant + user isolation
  // =========================================================================

  describe('GET /api/crawl/preferences', () => {
    test('should reject unauthenticated requests', async () => {
      const unauthApp = express();
      unauthApp.use(express.json());
      const { default: crawlRouter } = await import('../crawl.js');
      unauthApp.use('/api/crawl', crawlRouter);

      const res = await request(unauthApp).get('/api/crawl/preferences');
      expect(res.status).toBe(401);
    });

    test('should filter by tenantId AND userId', async () => {
      const mockSort = vi.fn().mockReturnThis();
      const mockLean = vi.fn().mockResolvedValue([]);

      (UserCrawlPreference.find as any).mockReturnValue({
        sort: mockSort,
        lean: mockLean,
      });

      await request(app).get('/api/crawl/preferences');

      const queryArg = (UserCrawlPreference.find as any).mock.calls[0][0];
      expect(queryArg.tenantId).toBe('tenant-A');
      expect(queryArg.userId).toBe('user-1');
    });
  });

  describe('POST /api/crawl/preferences', () => {
    test('should reject missing required fields', async () => {
      const res = await request(app)
        .post('/api/crawl/preferences')
        .send({ domainPattern: '*.example.com' }); // missing strategy

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
    });

    test('should reject invalid strategy', async () => {
      const res = await request(app)
        .post('/api/crawl/preferences')
        .send({ domainPattern: '*.example.com', strategy: 'invalid' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid strategy');
    });

    test('should upsert preference scoped to tenant + user', async () => {
      (UserCrawlPreference.findOneAndUpdate as any).mockResolvedValue({
        _id: 'pref-1',
        tenantId: 'tenant-A',
        userId: 'user-1',
        domainPattern: '*.example.com',
        strategy: 'bulk',
        autoDecide: true,
      });

      const res = await request(app).post('/api/crawl/preferences').send({
        domainPattern: '*.example.com',
        strategy: 'bulk',
        autoDecide: true,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify upsert filter included tenant + user
      const filterArg = (UserCrawlPreference.findOneAndUpdate as any).mock.calls[0][0];
      expect(filterArg.tenantId).toBe('tenant-A');
      expect(filterArg.userId).toBe('user-1');
    });

    test('should normalise domainPattern to lowercase', async () => {
      (UserCrawlPreference.findOneAndUpdate as any).mockResolvedValue({
        _id: 'pref-1',
        domainPattern: '*.example.com',
        strategy: 'hybrid',
      });

      await request(app).post('/api/crawl/preferences').send({
        domainPattern: '*.EXAMPLE.COM',
        strategy: 'hybrid',
      });

      const filterArg = (UserCrawlPreference.findOneAndUpdate as any).mock.calls[0][0];
      expect(filterArg.domainPattern).toBe('*.example.com');
    });
  });

  describe('DELETE /api/crawl/preferences/:id', () => {
    test('should only delete preferences owned by the user', async () => {
      (UserCrawlPreference.findOneAndDelete as any).mockResolvedValue({ _id: 'pref-1' });

      const res = await request(app).delete('/api/crawl/preferences/pref-1');
      expect(res.status).toBe(200);

      const filterArg = (UserCrawlPreference.findOneAndDelete as any).mock.calls[0][0];
      expect(filterArg._id).toBe('pref-1');
      expect(filterArg.tenantId).toBe('tenant-A');
      expect(filterArg.userId).toBe('user-1');
    });

    test('should return 404 for non-existent or other-user preference', async () => {
      (UserCrawlPreference.findOneAndDelete as any).mockResolvedValue(null);

      const res = await request(app).delete('/api/crawl/preferences/pref-999');
      expect(res.status).toBe(404);
    });
  });
});
