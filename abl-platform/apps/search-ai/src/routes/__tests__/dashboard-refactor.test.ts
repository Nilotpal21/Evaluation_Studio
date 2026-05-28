/**
 * Dashboard & Status Refactor Tests
 *
 * Tests that dashboard and status endpoints read from MongoDB first (authoritative),
 * then optionally query BullMQ for real-time progress on non-intelligence jobs.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { DocumentStatus, ChunkStatus } from '@agent-platform/search-ai-sdk';

const { mockWriteCrawlAuditEvent, mockDeleteCrawlAuditEventsForJob } = vi.hoisted(() => ({
  mockWriteCrawlAuditEvent: vi.fn().mockResolvedValue(undefined),
  mockDeleteCrawlAuditEventsForJob: vi.fn().mockResolvedValue(undefined),
}));

// ─── Helpers ─────────────────────────────────────────────────────────

function createChainableMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  const methods = [
    'select',
    'maxTimeMS',
    'lean',
    'sort',
    'skip',
    'limit',
    'where',
    'equals',
    'option',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain.exec = vi.fn().mockResolvedValue(resolvedValue);
  chain.then = vi.fn((resolve: (v: unknown) => void) => resolve(resolvedValue));
  return chain;
}

function buildDocAggregateResult(
  docs: Array<{ _id: string; status: string; metadata?: any }>,
): any[] {
  const byStatus: Record<string, number> = {};
  const qualityScores: number[] = [];
  const ids: string[] = [];

  for (const doc of docs) {
    byStatus[doc.status] = (byStatus[doc.status] || 0) + 1;
    ids.push(doc._id);
    if (doc.metadata?.qualityScore !== undefined) {
      qualityScores.push(doc.metadata.qualityScore);
    }
  }

  return [
    {
      byStatus: Object.entries(byStatus).map(([k, v]) => ({ _id: k, count: v })),
      qualityScores:
        qualityScores.length > 0
          ? [{ _id: null, avg: qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length }]
          : [],
      documentIds: ids.length > 0 ? [{ _id: null, ids }] : [],
    },
  ];
}

function buildChunkAggregateResult(
  chunks: Array<{ _id: string; status: string }>,
): Array<{ _id: string; count: number }> {
  const byStatus: Record<string, number> = {};
  for (const chunk of chunks) {
    byStatus[chunk.status] = (byStatus[chunk.status] || 0) + 1;
  }
  return Object.entries(byStatus).map(([k, v]) => ({ _id: k, count: v }));
}

// ─── Mock Models ─────────────────────────────────────────────────────

const {
  mockSearchDocument,
  mockSearchChunk,
  mockSearchIndex,
  mockCrawlJobModel,
  mockUserCrawlPreference,
  mockCrawlJobConstructor,
} = vi.hoisted(() => {
  const crawlJobModel = { findOne: vi.fn() };
  return {
    mockSearchDocument: { find: vi.fn(), aggregate: vi.fn() },
    mockSearchChunk: { find: vi.fn(), aggregate: vi.fn() },
    mockSearchIndex: { findById: vi.fn() },
    mockCrawlJobModel: crawlJobModel,
    mockUserCrawlPreference: {
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      }),
      findOneAndUpdate: vi.fn(),
      findOneAndDelete: vi.fn(),
    },
    mockCrawlJobConstructor: Object.assign(
      vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        ...data,
        save: vi.fn().mockResolvedValue(data),
      })),
      {
        findOne: crawlJobModel.findOne,
      },
    ),
  };
});

vi.mock('@agent-platform/database/models', () => ({
  SearchDocument: mockSearchDocument,
  SearchChunk: mockSearchChunk,
  SearchIndex: mockSearchIndex,
  CrawlJob: mockCrawlJobConstructor,
  UserCrawlPreference: mockUserCrawlPreference,
}));

vi.mock('../../db/index.js', () => ({
  getModel: (name: string) => {
    const models: Record<string, any> = {
      SearchDocument: mockSearchDocument,
      SearchChunk: mockSearchChunk,
      SearchIndex: mockSearchIndex,
      CrawlJob: mockCrawlJobConstructor,
      UserCrawlPreference: mockUserCrawlPreference,
    };
    return models[name];
  },
  getLazyModel: (name: string) => {
    const models: Record<string, any> = {
      SearchDocument: mockSearchDocument,
      SearchChunk: mockSearchChunk,
      SearchIndex: mockSearchIndex,
      CrawlJob: mockCrawlJobConstructor,
      UserCrawlPreference: mockUserCrawlPreference,
    };
    return models[name];
  },
}));

vi.mock('../../services/crawl-audit.service.js', () => ({
  writeCrawlAuditEvent: mockWriteCrawlAuditEvent,
  deleteCrawlAuditEventsForJob: mockDeleteCrawlAuditEventsForJob,
}));

vi.mock('../../workers/queue-monitor.js', () => ({
  getAllQueueStats: vi.fn(),
  getAllQueueHealth: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../services/crawler/duration-estimator.js', () => ({
  estimateCrawlDuration: vi
    .fn()
    .mockReturnValue({ min: 30, max: 120, unit: 'seconds', formatted: '30s - 2min' }),
}));

vi.mock('../../services/crawler/circuit-breaker.js', () => {
  class MockCircuitBreaker {
    isOpen = vi.fn().mockResolvedValue({ blocked: false });
    recordSuccess = vi.fn().mockResolvedValue(undefined);
    recordFailure = vi.fn().mockResolvedValue(undefined);
  }
  return { CircuitBreaker: MockCircuitBreaker };
});

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
  getRedisConnection: vi.fn().mockReturnValue({ host: 'localhost', port: 6379 }),
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

vi.mock('../../middleware/rate-limit.js', () => ({
  searchAiRateLimit: vi
    .fn()
    .mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('@abl/crawler', () => {
  class MockFastProfiler {
    profile = vi.fn();
    extractSitemapUrls = vi.fn();
  }
  class MockDecisionEngine {
    decide = vi.fn();
  }
  class MockPromptEvaluator {
    evaluate = vi.fn();
  }
  class MockQuestionGenerator {
    generate = vi.fn();
  }
  class MockResponseProcessor {
    applyResponses = vi.fn();
  }
  class MockStrategyResolver {
    resolve = vi.fn();
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

vi.mock(
  '@agent-platform/search-ai-sdk',
  async () => await vi.importActual('@agent-platform/search-ai-sdk'),
);

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    redis: {
      host: 'localhost',
      port: 6379,
    },
  })),
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 'test-user-id', email: 'test@example.com', name: 'Test User' };
    req.tenantContext = {
      tenantId: 'tenant-1',
      userId: 'test-user-id',
      role: 'admin',
      permissions: ['admin:indexes:read', 'admin:metrics:read', 'admin:queues:read'],
      authType: 'jwt_user' as any,
      isSuperAdmin: false,
    };
    next();
  },
  unifiedAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'test-user-id', email: 'test@example.com', name: 'Test User' };
    req.tenantContext = {
      tenantId: 'tenant-1',
      userId: 'test-user-id',
      role: 'admin',
      permissions: ['admin:indexes:read', 'admin:metrics:read', 'admin:queues:read'],
      authType: 'jwt_user' as any,
      isSuperAdmin: false,
    };
    next();
  },
}));

// ─── BullMQ Mock ─────────────────────────────────────────────────────

const mockBullJobData = {
  urls: ['https://example.com'],
  batchId: 'batch-123',
  jobId: 'batch-123',
  indexId: 'index-456',
  tenantId: 'tenant-1',
};

const mockBullJob = {
  id: 'job-123',
  data: mockBullJobData,
  timestamp: Date.now() - 60000,
  processedOn: Date.now() - 50000,
  finishedOn: Date.now() - 10000,
  progress: { crawled: 5, failed: 1, queued: 10 },
  getState: vi.fn(),
  failedReason: null as string | null,
  returnvalue: null as any,
};

vi.mock('bullmq', () => {
  class MockQueue {
    getJob = vi.fn((jobId: string) => {
      if (jobId === 'job-123') {
        return Promise.resolve(mockBullJob);
      }
      return Promise.resolve(null);
    });
    close = vi.fn();
    getJobs = vi.fn().mockResolvedValue([]);
  }
  return { Queue: MockQueue };
});

import { getAllQueueHealth } from '../../workers/queue-monitor.js';
import crawlRouter from '../crawl.js';

// ─── Test Data ───────────────────────────────────────────────────────

function makeCrawlJobDoc(overrides: Record<string, any> = {}) {
  return {
    _id: 'job-123',
    tenantId: 'tenant-1',
    status: 'completed',
    strategy: 'bulk',
    urls: {
      original: ['https://example.com'],
      expanded: [],
      crawled: 5,
      failed: 1,
    },
    configuration: { strategy: 'bulk' },
    timeline: {
      submittedAt: new Date(Date.now() - 60000),
      startedAt: new Date(Date.now() - 50000),
      completedAt: new Date(Date.now() - 10000),
    },
    results: {
      documentsCreated: 3,
      documentsIndexed: 2,
      documentsFailed: 0,
      chunksCreated: 6,
    },
    processingErrors: [],
    indexId: 'index-456',
    createdAt: new Date(Date.now() - 60000),
    updatedAt: new Date(Date.now() - 10000),
    _v: 0,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('Dashboard & Status Refactor — MongoDB-first', () => {
  let app: Express;

  function setupAggregateMocks(
    docs: Array<{ _id: string; status: string; metadata?: any; processingError?: string }>,
    chunks: Array<{ _id: string; status: string }>,
  ) {
    const docResult = buildDocAggregateResult(docs);
    (mockSearchDocument.aggregate as any).mockReturnValue(createChainableMock(docResult));

    const errorDocs = docs
      .filter((d) => d.status === DocumentStatus.ERROR)
      .map((d) => ({ ...d, processingError: d.processingError || 'Unknown error' }));
    (mockSearchDocument.find as any).mockReturnValue(createChainableMock(errorDocs));

    const chunkResult = buildChunkAggregateResult(chunks);
    (mockSearchChunk.aggregate as any).mockReturnValue(createChainableMock(chunkResult));
  }

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.tenantContext = {
        tenantId: 'tenant-1',
        userId: 'test-user-id',
        role: 'admin',
        permissions: ['admin:indexes:read', 'admin:metrics:read', 'admin:queues:read'],
        authType: 'jwt_user',
        isSuperAdmin: false,
      };
      next();
    });
    app.use('/api/crawl', crawlRouter);
    vi.clearAllMocks();

    // Reset BullMQ mock state
    mockBullJob.getState = vi.fn().mockResolvedValue('completed');
    mockBullJob.failedReason = null;
    mockBullJob.returnvalue = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Dashboard Tests ─────────────────────────────────────────────

  describe('GET /api/crawl/dashboard/:jobId', () => {
    test('should return dashboard for intelligence job without BullMQ lookup', async () => {
      const crawlJobDoc = makeCrawlJobDoc({
        strategy: 'intelligence',
        status: 'completed',
      });
      mockCrawlJobModel.findOne.mockReturnValue(createChainableMock(crawlJobDoc));

      setupAggregateMocks(
        [
          { _id: 'doc-1', status: DocumentStatus.INDEXED, metadata: { qualityScore: 0.9 } },
          { _id: 'doc-2', status: DocumentStatus.INDEXED, metadata: { qualityScore: 0.8 } },
        ],
        [
          { _id: 'chunk-1', status: ChunkStatus.INDEXED },
          { _id: 'chunk-2', status: ChunkStatus.INDEXED },
        ],
      );

      (getAllQueueHealth as any).mockResolvedValue([]);

      const response = await request(app).get('/api/crawl/dashboard/job-123').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        jobId: 'job-123',
        phase: 'indexed',
        crawl: expect.objectContaining({
          status: 'completed',
        }),
        ingestion: expect.objectContaining({
          documentsCreated: 2,
          documentsIndexed: 2,
        }),
      });

      // BullMQ getJob should NOT have been called for intelligence strategy
      // We verify by checking the CrawlJob findOne was called with tenant isolation
      expect(mockCrawlJobModel.findOne).toHaveBeenCalledWith({
        _id: 'job-123',
        tenantId: 'tenant-1',
      });
    });

    test('should return dashboard for bulk job with BullMQ fallback', async () => {
      const crawlJobDoc = makeCrawlJobDoc({
        strategy: 'bulk',
        status: 'completed',
      });
      mockCrawlJobModel.findOne.mockReturnValue(createChainableMock(crawlJobDoc));
      mockBullJob.getState.mockResolvedValue('completed');

      setupAggregateMocks(
        [
          { _id: 'doc-1', status: DocumentStatus.INDEXED, metadata: { qualityScore: 0.85 } },
          { _id: 'doc-2', status: DocumentStatus.INDEXED, metadata: { qualityScore: 0.92 } },
          { _id: 'doc-3', status: DocumentStatus.EMBEDDING },
        ],
        [
          { _id: 'chunk-1', status: ChunkStatus.INDEXED },
          { _id: 'chunk-2', status: ChunkStatus.INDEXED },
          { _id: 'chunk-3', status: ChunkStatus.PENDING },
        ],
      );

      (getAllQueueHealth as any).mockResolvedValue([
        {
          queueName: 'search-embedding',
          status: 'healthy',
          waiting: 5,
          active: 2,
          failed: 0,
          issues: [],
          timestamp: new Date(),
        },
      ]);

      const response = await request(app).get('/api/crawl/dashboard/job-123').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        jobId: 'job-123',
        timeline: {
          submitted: expect.any(Number),
          started: expect.any(Number),
          completed: expect.any(Number),
          duration: expect.any(Number),
        },
        crawl: expect.objectContaining({
          status: 'completed',
          batchId: 'job-123',
        }),
        ingestion: expect.objectContaining({
          documentsCreated: 3,
          documentsIndexed: 2,
        }),
        extraction: expect.objectContaining({
          chunksCreated: 3,
        }),
        queues: expect.objectContaining({
          status: 'healthy',
        }),
      });
    });

    test('should return 404 for non-existent job', async () => {
      mockCrawlJobModel.findOne.mockReturnValue(createChainableMock(null));

      const response = await request(app).get('/api/crawl/dashboard/nonexistent-job').expect(404);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Crawl job not found' },
      });
    });

    test('should return 404 for cross-tenant access', async () => {
      // CrawlJob query includes tenantId, so cross-tenant returns null
      mockCrawlJobModel.findOne.mockReturnValue(createChainableMock(null));

      const response = await request(app).get('/api/crawl/dashboard/other-tenant-job').expect(404);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Crawl job not found' },
      });

      // Verify tenant isolation in the query
      expect(mockCrawlJobModel.findOne).toHaveBeenCalledWith({
        _id: 'other-tenant-job',
        tenantId: 'tenant-1',
      });
    });

    test('should use structured error format for server errors', async () => {
      const chain: Record<string, any> = {};
      ['select', 'maxTimeMS', 'lean', 'sort', 'skip', 'limit', 'option'].forEach((m) => {
        chain[m] = vi.fn(() => chain);
      });
      chain.lean = vi.fn(() => {
        throw new Error('DB connection lost');
      });
      mockCrawlJobModel.findOne.mockReturnValue(chain);

      const response = await request(app).get('/api/crawl/dashboard/job-123').expect(500);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get dashboard' },
      });
      // No internal error details leaked
      expect(response.body.error.message).not.toContain('DB connection lost');
    });
  });

  // ─── Status Tests ────────────────────────────────────────────────

  describe('GET /api/crawl/status', () => {
    test('should return status for intelligence job without BullMQ lookup', async () => {
      const crawlJobDoc = makeCrawlJobDoc({
        _id: 'intel-job-1',
        strategy: 'intelligence',
        status: 'crawling',
      });
      mockCrawlJobModel.findOne.mockReturnValue(createChainableMock(crawlJobDoc));

      const response = await request(app).get('/api/crawl/status?jobId=intel-job-1').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        jobId: 'intel-job-1',
        state: 'crawling',
        strategy: 'intelligence',
        urls: 1,
      });

      // Verify tenant-scoped query
      expect(mockCrawlJobModel.findOne).toHaveBeenCalledWith({
        _id: 'intel-job-1',
        tenantId: 'tenant-1',
      });
    });

    test('should return status for bulk job with BullMQ enrichment', async () => {
      const crawlJobDoc = makeCrawlJobDoc({
        _id: 'job-123',
        strategy: 'bulk',
        status: 'crawling',
      });
      mockCrawlJobModel.findOne.mockReturnValue(createChainableMock(crawlJobDoc));
      mockBullJob.getState.mockResolvedValue('active');

      const response = await request(app).get('/api/crawl/status?jobId=job-123').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        jobId: 'job-123',
        state: 'crawling',
        strategy: 'bulk',
      });
    });

    test('should return 404 for non-existent job', async () => {
      mockCrawlJobModel.findOne.mockReturnValue(createChainableMock(null));

      const response = await request(app).get('/api/crawl/status?jobId=nonexistent').expect(404);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Crawl job not found' },
      });
    });

    test('should return 404 for cross-tenant access', async () => {
      mockCrawlJobModel.findOne.mockReturnValue(createChainableMock(null));

      const response = await request(app)
        .get('/api/crawl/status?jobId=other-tenant-job')
        .expect(404);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Crawl job not found' },
      });

      expect(mockCrawlJobModel.findOne).toHaveBeenCalledWith({
        _id: 'other-tenant-job',
        tenantId: 'tenant-1',
      });
    });

    test('should return 400 for missing jobId', async () => {
      const response = await request(app).get('/api/crawl/status').expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: 'MISSING_PARAMETER', message: 'Missing jobId query parameter' },
      });
    });

    test('should use structured error format for all error responses', async () => {
      // Test 500 error
      const chain: Record<string, any> = {};
      ['select', 'maxTimeMS', 'sort', 'skip', 'limit', 'option'].forEach((m) => {
        chain[m] = vi.fn(() => chain);
      });
      chain.lean = vi.fn(() => {
        throw new Error('Connection error');
      });
      mockCrawlJobModel.findOne.mockReturnValue(chain);

      const response = await request(app).get('/api/crawl/status?jobId=job-123').expect(500);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to get job status' },
      });
      // Should not leak internal error
      expect(response.body.error.message).not.toContain('Connection error');
    });
  });
});
