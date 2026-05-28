/**
 * Cancel Crawl Job API Tests
 *
 * POST /api/crawl/jobs/:jobId/cancel
 *
 * Verifies:
 * - Only active jobs (queued/crawling/ingesting) can be cancelled
 * - Completed/failed/cancelled jobs return 404
 * - Tenant isolation enforced (cross-tenant returns 404, not 403)
 * - Atomic status transition via findOneAndUpdate
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFindOneAndUpdate = vi.fn();

vi.mock('../../db/index.js', () => ({
  getModel: (name: string) => {
    if (name === 'CrawlJob') {
      return { findOneAndUpdate: mockFindOneAndUpdate };
    }
    return {};
  },
  getLazyModel: () => ({}),
}));

vi.mock('../../config/index.js', () => ({
  getConfig: () => ({
    redis: { url: 'redis://localhost:6379' },
  }),
}));

vi.mock('../../middleware/rate-limit.js', () => ({
  searchAiRateLimit: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../workers/shared.js', () => ({
  getSharedRedisClient: () => ({
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
  }),
  getRedisConnection: () => ({ host: 'localhost', port: 6379 }),
  createQueue: () => ({
    add: vi.fn().mockResolvedValue({ id: 'test-job-id' }),
    getJob: vi.fn().mockResolvedValue(null),
    close: vi.fn(),
  }),
  QUEUE_BULK_CRAWL: 'bulk-crawl',
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

vi.mock('../../workers/queue-monitor.js', () => ({
  getAllQueueStats: vi.fn().mockResolvedValue({}),
  getAllQueueHealth: vi.fn().mockResolvedValue({}),
}));

vi.mock('@abl/crawler', () => ({
  FastProfiler: vi.fn(),
  DecisionEngine: vi.fn(),
  PromptEvaluator: vi.fn(),
  QuestionGenerator: vi.fn(),
  ResponseProcessor: vi.fn(),
  StrategyResolver: vi.fn(),
}));

vi.mock('../../utils/ssrf-protection.js', () => ({
  isURLAllowed: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('../../services/crawler/duration-estimator.js', () => ({
  estimateCrawlDuration: vi.fn(),
}));

vi.mock('../../services/crawler/circuit-breaker.js', () => ({
  CircuitBreaker: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue({ id: 'test-job-id' }),
    getJob: vi.fn().mockResolvedValue(null),
    close: vi.fn(),
  })),
}));

vi.mock('ioredis', () => {
  class MockRedis {
    set = vi.fn().mockResolvedValue('OK');
    setex = vi.fn();
    get = vi.fn().mockResolvedValue(null);
    del = vi.fn().mockResolvedValue(1);
    on = vi.fn().mockReturnThis();
    quit = vi.fn().mockResolvedValue('OK');
    disconnect = vi.fn();
    status = 'ready';
  }
  return { default: MockRedis };
});

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/search-ai-internal', () => ({
  createVectorStore: vi.fn(),
  resolveIndexForWrite: vi.fn(),
}));

vi.mock('@agent-platform/search-ai-sdk', () => ({
  DocumentStatus: { indexed: 'indexed', pending: 'pending', failed: 'failed' },
  ChunkStatus: { indexed: 'indexed', pending: 'pending', failed: 'failed' },
}));

vi.mock('@agent-platform/database/models', () => ({}));

vi.mock('../project-scope.js', () => ({
  applyProjectScopeFilter: vi.fn(),
}));

vi.mock('../../services/crawler/pattern-matcher.js', () => ({
  learnPattern: vi.fn(),
  learnPatterns: vi.fn().mockReturnValue([]),
  scoreUrl: vi.fn().mockReturnValue(0),
  scoreUrlMulti: vi.fn().mockReturnValue(0),
}));

vi.mock('../../services/crawler/robots-analyzer.js', () => ({
  analyzeRobotsTxt: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let app: Express;

function createTenantMiddleware(tenantId: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as any).tenantContext = { tenantId, userId: 'user-1' };
    next();
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  app = express();
  app.use(express.json());
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/crawl/jobs/:jobId/cancel', () => {
  describe('Success cases', () => {
    test('should cancel a queued job and return 200', async () => {
      mockFindOneAndUpdate.mockResolvedValue({
        _id: 'job-123',
        status: 'cancelled',
        tenantId: 'tenant-abc',
      });

      app.use(createTenantMiddleware('tenant-abc'));
      const { default: crawlRouter } = await import('../crawl.js');
      app.use('/api/crawl', crawlRouter);

      const res = await request(app).post('/api/crawl/jobs/job-123/cancel').send();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('cancelled');

      // Verify atomic findOneAndUpdate was called with correct filter
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: 'job-123',
          tenantId: 'tenant-abc',
          status: { $in: ['queued', 'crawling', 'ingesting'] },
        }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'cancelled' }),
        }),
        expect.objectContaining({ new: true }),
      );
    });

    test('should add cancel phase to processingErrors', async () => {
      mockFindOneAndUpdate.mockResolvedValue({
        _id: 'job-123',
        status: 'cancelled',
        tenantId: 'tenant-abc',
      });

      app.use(createTenantMiddleware('tenant-abc'));
      const { default: crawlRouter } = await import('../crawl.js');
      app.use('/api/crawl', crawlRouter);

      await request(app).post('/api/crawl/jobs/job-123/cancel').send();

      const updateArg = mockFindOneAndUpdate.mock.calls[0][1];
      expect(updateArg.$push.processingErrors).toMatchObject({
        phase: 'crawl',
        message: 'Job cancelled by user',
      });
    });
  });

  describe('Not found cases', () => {
    test('should return 404 for already completed job', async () => {
      mockFindOneAndUpdate.mockResolvedValue(null);

      app.use(createTenantMiddleware('tenant-abc'));
      const { default: crawlRouter } = await import('../crawl.js');
      app.use('/api/crawl', crawlRouter);

      const res = await request(app).post('/api/crawl/jobs/job-123/cancel').send();

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test('should return 404 for cross-tenant cancel (not 403)', async () => {
      // Simulate cross-tenant: the job exists for tenant-abc but request comes from tenant-xyz
      mockFindOneAndUpdate.mockResolvedValue(null);

      app.use(createTenantMiddleware('tenant-xyz'));
      const { default: crawlRouter } = await import('../crawl.js');
      app.use('/api/crawl', crawlRouter);

      const res = await request(app).post('/api/crawl/jobs/job-123/cancel').send();

      // Should be 404, not 403 (no existence leaking)
      expect(res.status).toBe(404);
    });
  });

  describe('Auth', () => {
    test('should return 401 without tenantContext', async () => {
      // No tenant middleware
      const { default: crawlRouter } = await import('../crawl.js');
      app.use('/api/crawl', crawlRouter);

      const res = await request(app).post('/api/crawl/jobs/job-123/cancel').send();

      expect(res.status).toBe(401);
    });
  });
});
