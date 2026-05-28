/**
 * Crawl Dashboard API Tests
 *
 * Integration tests for centralized /api/crawl/dashboard/:jobId endpoint.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { DocumentStatus, ChunkStatus } from '@agent-platform/search-ai-sdk';

const { mockWriteCrawlAuditEvent, mockDeleteCrawlAuditEventsForJob } = vi.hoisted(() => ({
  mockWriteCrawlAuditEvent: vi.fn().mockResolvedValue(undefined),
  mockDeleteCrawlAuditEventsForJob: vi.fn().mockResolvedValue(undefined),
}));

// Helper to build Mongoose-like chainable query mock
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
  // Also make it thenable for `await find(...)` without .exec()
  chain.then = vi.fn((resolve: (v: unknown) => void) => resolve(resolvedValue));
  return chain;
}

/**
 * Build aggregate result for the document facet pipeline used in the dashboard route.
 * The route uses $facet with: byStatus, qualityScores, documentIds
 */
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

/**
 * Build aggregate result for the chunk status pipeline.
 */
function buildChunkAggregateResult(
  chunks: Array<{ _id: string; status: string }>,
): Array<{ _id: string; count: number }> {
  const byStatus: Record<string, number> = {};
  for (const chunk of chunks) {
    byStatus[chunk.status] = (byStatus[chunk.status] || 0) + 1;
  }
  return Object.entries(byStatus).map(([k, v]) => ({ _id: k, count: v }));
}

// Mock database models
const {
  mockSearchDocument,
  mockSearchChunk,
  mockSearchIndex,
  defaultCrawlJobDoc,
  mockCrawlJob,
  mockUserCrawlPreference,
} = vi.hoisted(() => {
  const defaultDoc = {
    _id: 'job-123',
    tenantId: 'tenant-1',
    status: 'completed',
    strategy: 'bulk',
    urls: { original: ['https://example.com'], expanded: [], crawled: 5, failed: 1 },
    configuration: { strategy: 'bulk' },
    timeline: {
      submittedAt: new Date(Date.now() - 60000),
      startedAt: new Date(Date.now() - 50000),
      completedAt: new Date(Date.now() - 10000),
    },
    results: { documentsCreated: 0, documentsIndexed: 0, documentsFailed: 0, chunksCreated: 0 },
    processingErrors: [],
    indexId: 'index-456',
    createdAt: new Date(Date.now() - 60000),
    updatedAt: new Date(Date.now() - 10000),
  };
  const chain: Record<string, any> = {};
  for (const method of [
    'select',
    'maxTimeMS',
    'lean',
    'sort',
    'skip',
    'limit',
    'where',
    'equals',
    'option',
  ]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.exec = vi.fn().mockResolvedValue(defaultDoc);
  chain.then = vi.fn((resolve: (value: unknown) => void) => resolve(defaultDoc));

  return {
    mockSearchDocument: { find: vi.fn(), aggregate: vi.fn() },
    mockSearchChunk: { find: vi.fn(), aggregate: vi.fn() },
    mockSearchIndex: { findById: vi.fn() },
    defaultCrawlJobDoc: defaultDoc,
    mockCrawlJob: Object.assign(
      vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        ...data,
        save: vi.fn().mockResolvedValue(data),
      })),
      {
        findOne: vi.fn().mockReturnValue(chain),
      },
    ),
    mockUserCrawlPreference: {
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      }),
      findOneAndUpdate: vi.fn(),
      findOneAndDelete: vi.fn(),
    },
  };
});

vi.mock('@agent-platform/database/models', () => ({
  SearchDocument: mockSearchDocument,
  SearchChunk: mockSearchChunk,
  SearchIndex: mockSearchIndex,
  CrawlJob: mockCrawlJob,
  UserCrawlPreference: mockUserCrawlPreference,
}));

// Mock db/index.js — crawl.ts uses getModel() for lazy model access
vi.mock('../../db/index.js', () => ({
  getModel: (name: string) => {
    const models: Record<string, any> = {
      SearchDocument: mockSearchDocument,
      SearchChunk: mockSearchChunk,
      SearchIndex: mockSearchIndex,
      CrawlJob: mockCrawlJob,
      UserCrawlPreference: mockUserCrawlPreference,
    };
    return models[name];
  },
  getLazyModel: (name: string) => {
    const models: Record<string, any> = {
      SearchDocument: mockSearchDocument,
      SearchChunk: mockSearchChunk,
      SearchIndex: mockSearchIndex,
      CrawlJob: mockCrawlJob,
      UserCrawlPreference: mockUserCrawlPreference,
    };
    return models[name];
  },
}));

vi.mock('../../services/crawl-audit.service.js', () => ({
  writeCrawlAuditEvent: mockWriteCrawlAuditEvent,
  deleteCrawlAuditEventsForJob: mockDeleteCrawlAuditEventsForJob,
}));

// Mock queue monitor
vi.mock('../../workers/queue-monitor.js', () => ({
  getAllQueueStats: vi.fn(),
  getAllQueueHealth: vi.fn(),
}));

// Mock logger (crawl.ts imports createLogger from @abl/compiler/platform)
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
  getRedisConnection: vi.fn().mockReturnValue({ host: 'localhost', port: 6379 }),
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

// Mock rate limit
vi.mock('../../middleware/rate-limit.js', () => ({
  searchAiRateLimit: vi
    .fn()
    .mockReturnValue((_req: unknown, _res: unknown, next: () => void) => next()),
}));

// Mock @abl/crawler (crawl.ts imports this at top level)
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

// Mock search-ai-sdk
vi.mock(
  '@agent-platform/search-ai-sdk',
  async () => await vi.importActual('@agent-platform/search-ai-sdk'),
);

// Mock config - crawl.ts imports from '../config/index.js'
vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    redis: {
      host: 'localhost',
      port: 6379,
    },
  })),
}));

// Mock auth middleware to bypass authentication
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

// Mock BullMQ
const mockJobData = {
  urls: ['https://example.com'],
  batchId: 'batch-123',
  jobId: 'batch-123',
  indexId: 'index-456',
  tenantId: 'tenant-1', // Must match tenantContext to pass isolation check
};

const mockJob = {
  id: 'job-123',
  data: mockJobData,
  timestamp: Date.now() - 60000, // 1 minute ago
  processedOn: Date.now() - 50000,
  finishedOn: Date.now() - 10000,
  progress: { crawled: 5, failed: 1, queued: 10 },
  getState: vi.fn(),
  failedReason: null as string | null,
};

vi.mock('bullmq', () => {
  class MockQueue {
    getJob = vi.fn((jobId: string) => {
      if (jobId === 'job-999') {
        return Promise.resolve(null);
      }
      return Promise.resolve(mockJob);
    });
    close = vi.fn();
    getJobs = vi.fn().mockResolvedValue([]);
  }
  return { Queue: MockQueue };
});

const SearchDocument = mockSearchDocument;
const SearchChunk = mockSearchChunk;
import { getAllQueueHealth } from '../../workers/queue-monitor.js';
import crawlRouter from '../crawl.js';

describe('Crawl Dashboard API', () => {
  let app: Express;

  /**
   * Set up aggregate mocks for SearchDocument and SearchChunk.
   * The dashboard route uses aggregate pipelines, not .find().
   */
  function setupAggregateMocks(
    docs: Array<{ _id: string; status: string; metadata?: any; processingError?: string }>,
    chunks: Array<{ _id: string; status: string }>,
  ) {
    const docResult = buildDocAggregateResult(docs);
    (SearchDocument.aggregate as any).mockReturnValue(createChainableMock(docResult));

    // The route also queries for error documents using .find() for error details
    const errorDocs = docs
      .filter((d) => d.status === DocumentStatus.ERROR)
      .map((d) => ({ ...d, processingError: d.processingError || 'Unknown error' }));
    (SearchDocument.find as any).mockReturnValue(createChainableMock(errorDocs));

    const chunkResult = buildChunkAggregateResult(chunks);
    (SearchChunk.aggregate as any).mockReturnValue(createChainableMock(chunkResult));
  }

  beforeEach(() => {
    app = express();
    app.use(express.json());
    // Mock auth context - routes check req.tenantContext
    app.use((req: any, _res, next) => {
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

    // Reset mock job state
    mockJob.getState = vi.fn().mockResolvedValue('completed');
    mockJob.failedReason = null;

    // Reset CrawlJob.findOne to return the default document (MongoDB-first lookup)
    mockCrawlJob.findOne.mockReturnValue(createChainableMock(defaultCrawlJobDoc));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/crawl/dashboard/:jobId', () => {
    test('should return complete dashboard for successful crawl', async () => {
      // Mock documents and chunks via aggregate
      setupAggregateMocks(
        [
          { _id: 'doc-1', status: DocumentStatus.INDEXED, metadata: { qualityScore: 0.85 } },
          { _id: 'doc-2', status: DocumentStatus.INDEXED, metadata: { qualityScore: 0.92 } },
          { _id: 'doc-3', status: DocumentStatus.EMBEDDING, metadata: { qualityScore: 0.78 } },
        ],
        [
          { _id: 'chunk-1', status: ChunkStatus.INDEXED },
          { _id: 'chunk-2', status: ChunkStatus.INDEXED },
          { _id: 'chunk-3', status: ChunkStatus.INDEXED },
          { _id: 'chunk-4', status: ChunkStatus.PENDING },
        ],
      );

      // Mock queue health
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
        {
          queueName: 'search-extraction',
          status: 'healthy',
          waiting: 0,
          active: 0,
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
        phase: expect.stringMatching(/indexed|embedding/),
        crawl: {
          status: 'completed',
          progress: 0,
          totalUrls: 1,
          urlsCrawled: 5,
          urlsFailed: 1,
          batchId: 'job-123',
        },
        ingestion: {
          documentsCreated: 3,
          documentsFailed: 0,
          documentsIndexed: 2,
          avgQualityScore: expect.any(Number),
          statusBreakdown: {
            indexed: 2,
            embedding: 1,
          },
        },
        extraction: {
          documentsProcessed: 3,
          chunksCreated: 4,
          avgChunksPerDoc: expect.any(Number),
          chunkStatusBreakdown: {
            indexed: 3,
            pending: 1,
          },
        },
        queues: {
          status: 'healthy',
          details: expect.arrayContaining([
            expect.objectContaining({
              queueName: expect.any(String),
              status: expect.stringMatching(/^(healthy|degraded|critical)$/),
            }),
          ]),
        },
        errors: expect.any(Array),
      });

      // Verify quality score calculation
      expect(response.body.ingestion.avgQualityScore).toBeCloseTo(0.85, 2);

      // Verify chunks per doc calculation
      expect(response.body.extraction.avgChunksPerDoc).toBeCloseTo(1.33, 2);
    });

    test('should detect critical queue status', async () => {
      setupAggregateMocks([], []);

      (getAllQueueHealth as any).mockResolvedValue([
        {
          queueName: 'search-embedding',
          status: 'critical',
          waiting: 1500,
          active: 20,
          failed: 50,
          issues: ['Very high backlog: 1500 jobs waiting', 'High failure rate: 50 failed jobs'],
          timestamp: new Date(),
        },
      ]);

      const response = await request(app).get('/api/crawl/dashboard/job-123').expect(200);

      expect(response.body.queues.status).toBe('critical');
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: 'queue',
            message: expect.stringContaining('search-embedding'),
          }),
        ]),
      );
    });

    test('should detect degraded queue status', async () => {
      setupAggregateMocks([], []);

      (getAllQueueHealth as any).mockResolvedValue([
        {
          queueName: 'search-embedding',
          status: 'degraded',
          waiting: 150,
          active: 10,
          failed: 5,
          issues: ['Moderate backlog: 150 jobs waiting'],
          timestamp: new Date(),
        },
        {
          queueName: 'search-extraction',
          status: 'healthy',
          waiting: 0,
          active: 0,
          failed: 0,
          issues: [],
          timestamp: new Date(),
        },
      ]);

      const response = await request(app).get('/api/crawl/dashboard/job-123').expect(200);

      expect(response.body.queues.status).toBe('degraded');
    });

    test('should include job failure in errors', async () => {
      mockJob.getState = vi.fn().mockResolvedValue('failed');
      mockJob.failedReason = 'Network timeout during crawl';
      mockCrawlJob.findOne.mockReturnValue(
        createChainableMock({
          ...defaultCrawlJobDoc,
          status: 'failed',
          processingErrors: [{ phase: 'crawling', message: 'Network timeout during crawl' }],
        }),
      );

      setupAggregateMocks([], []);

      (getAllQueueHealth as any).mockResolvedValue([]);

      const response = await request(app).get('/api/crawl/dashboard/job-123').expect(200);

      expect(response.body.phase).toBe('failed');
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: 'crawling',
            message: 'Network timeout during crawl',
          }),
        ]),
      );
    });

    test('should include document errors', async () => {
      setupAggregateMocks(
        [
          {
            _id: 'doc-1',
            status: DocumentStatus.ERROR,
            processingError: 'Failed to extract content',
          },
          { _id: 'doc-2', status: DocumentStatus.INDEXED },
        ],
        [],
      );

      (getAllQueueHealth as any).mockResolvedValue([]);

      const response = await request(app).get('/api/crawl/dashboard/job-123').expect(200);

      expect(response.body.ingestion.documentsFailed).toBe(1);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: 'ingestion',
            message: 'Failed to extract content',
          }),
        ]),
      );
    });

    test('should determine phase correctly - crawling', async () => {
      mockJob.getState = vi.fn().mockResolvedValue('active');
      mockCrawlJob.findOne.mockReturnValue(
        createChainableMock({
          ...defaultCrawlJobDoc,
          status: 'crawling',
          timeline: {
            ...defaultCrawlJobDoc.timeline,
            completedAt: undefined,
          },
        }),
      );

      setupAggregateMocks([], []);

      (getAllQueueHealth as any).mockResolvedValue([]);

      const response = await request(app).get('/api/crawl/dashboard/job-123').expect(200);

      expect(response.body.phase).toBe('crawling');
    });

    test('should determine phase correctly - extracting', async () => {
      setupAggregateMocks([{ _id: 'doc-1', status: DocumentStatus.EXTRACTING }], []);

      (getAllQueueHealth as any).mockResolvedValue([]);

      const response = await request(app).get('/api/crawl/dashboard/job-123').expect(200);

      expect(response.body.phase).toBe('extracting');
    });

    test('should handle job not found', async () => {
      // CrawlJob.findOne returns null — job not in MongoDB
      mockCrawlJob.findOne.mockReturnValue(createChainableMock(null));

      const response = await request(app).get('/api/crawl/dashboard/job-999').expect(404);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Crawl job not found' },
      });
    });

    test('should handle missing jobId', async () => {
      const response = await request(app).get('/api/crawl/dashboard/').expect(404);

      // Express 404 for route not found
      expect(response.status).toBe(404);
    });

    test('should limit errors to 50', async () => {
      // Create 60 failed documents
      const errorDocs = Array.from({ length: 60 }, (_, i) => ({
        _id: `doc-${i}`,
        status: DocumentStatus.ERROR,
        processingError: `Error ${i}`,
      }));
      setupAggregateMocks(errorDocs, []);

      (getAllQueueHealth as any).mockResolvedValue([]);

      const response = await request(app).get('/api/crawl/dashboard/job-123').expect(200);

      expect(response.body.errors.length).toBeLessThanOrEqual(50);
    });

    test('should handle no quality scores', async () => {
      setupAggregateMocks(
        [{ _id: 'doc-1', status: DocumentStatus.INDEXED }], // No qualityScore
        [],
      );

      (getAllQueueHealth as any).mockResolvedValue([]);

      const response = await request(app).get('/api/crawl/dashboard/job-123').expect(200);

      expect(response.body.ingestion.avgQualityScore).toBeNull();
    });

    test('should handle zero documents', async () => {
      setupAggregateMocks([], []);

      (getAllQueueHealth as any).mockResolvedValue([]);

      const response = await request(app).get('/api/crawl/dashboard/job-123').expect(200);

      expect(response.body.ingestion.documentsCreated).toBe(0);
      expect(response.body.extraction.avgChunksPerDoc).toBe(0);
    });
  });
});
