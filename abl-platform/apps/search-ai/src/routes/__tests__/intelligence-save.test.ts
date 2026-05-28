/**
 * Intelligence Save Route Tests
 *
 * Tests for POST /intelligence/save — saves analysis results to KB
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
  mockSearchSourceDeleteOne,
  mockIngestCrawledContent,
  mockReadFileFromStorage,
  mockCreateFileStorage,
  mockGetConfig,
  mockRedisGet,
  mockRedisSetex,
  mockRedisSet,
  mockRedisDel,
  mockRedisIncr,
  mockRedisExists,
  mockRedisExpire,
  mockRedisPublish,
} = vi.hoisted(() => ({
  mockSearchIndexFindOne: vi.fn(),
  mockSearchSourceCreate: vi.fn(),
  mockSearchSourceDeleteOne: vi.fn(),
  mockIngestCrawledContent: vi.fn(),
  mockReadFileFromStorage: vi.fn(),
  mockCreateFileStorage: vi.fn(),
  mockGetConfig: vi.fn(),
  mockRedisGet: vi.fn(),
  mockRedisSetex: vi.fn().mockResolvedValue('OK'),
  mockRedisSet: vi.fn().mockResolvedValue('OK'),
  mockRedisDel: vi.fn().mockResolvedValue(1),
  mockRedisIncr: vi.fn().mockResolvedValue(1),
  mockRedisExists: vi.fn().mockResolvedValue(0),
  mockRedisExpire: vi.fn().mockResolvedValue(1),
  mockRedisPublish: vi.fn().mockResolvedValue(1),
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
        return { create: mockSearchSourceCreate, deleteOne: mockSearchSourceDeleteOne };
      default:
        return {};
    }
  }),
}));

vi.mock('../../services/ingestion/crawler-ingestion.js', () => ({
  crawlerIngestionService: {
    ingestCrawledContent: mockIngestCrawledContent,
  },
}));

vi.mock('../../storage/storage-factory.js', () => ({
  createFileStorage: mockCreateFileStorage,
  readFileFromStorage: mockReadFileFromStorage,
}));

vi.mock('../../config/index.js', () => ({
  getConfig: mockGetConfig,
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
    on = vi.fn().mockReturnThis();
    quit = vi.fn().mockResolvedValue('OK');
    disconnect = vi.fn();
    status = 'ready';
  }
  return { default: MockIORedis };
});

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
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
  }),
  createQueue: vi.fn(() => ({ add: vi.fn().mockResolvedValue({ id: 'job-id-1' }) })),
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

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
  isURLAllowed: vi.fn().mockResolvedValue({ allowed: true }),
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
      projectScope: ['project-allowed'],
    };
    next();
  });

  const { intelligenceRouter } = await import('../intelligence.js');
  app.use('/api/crawl', intelligenceRouter);

  // Error handler prevents "socket hang up"
  app.use((err: any, _req: any, res: any, _next: any) => {
    res
      .status(500)
      .json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function completedJobData(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    status: 'completed',
    tenantId: 'tenant-1',
    url: 'https://example.com/page',
    intent: 'Extract content',
    indexId: 'index-1',
    result: { title: 'Test', body: 'Content', quality: 'rich' },
    rawHtmlStorageUrl: '/uploads/intelligence/tenant-1/job-1/raw.html',
    handler: { steps: [{ action: 'navigate' }], urlPattern: '**/*.html' },
    completedAt: new Date().toISOString(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /intelligence/save', () => {
  let app: Express;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default mocks
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'index-1',
        tenantId: 'tenant-1',
        projectId: 'project-allowed',
        name: 'Test Index',
      }),
    });
    mockSearchSourceCreate.mockResolvedValue({
      _id: 'source-new-1',
      tenantId: 'tenant-1',
      indexId: 'index-1',
      name: 'https://example.com/page',
      sourceType: 'web',
      status: 'pending',
    });
    mockSearchSourceDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mockReadFileFromStorage.mockResolvedValue(
      Buffer.from('<html><body>Test</body></html>', 'utf-8'),
    );
    mockIngestCrawledContent.mockResolvedValue({
      success: true,
      documentId: 'doc-1',
      originalReference: 'https://example.com/page',
      contentType: 'text/html',
      status: 'pending',
    });
    mockGetConfig.mockReturnValue({
      storage: { provider: 'local', basePath: './uploads', bucket: 'test' },
    });

    app = await createTestApp();
  });

  // ─── Happy Path ──────────────────────────────────────────────────────────

  test('happy path: completed job -> save -> source created + ingestion called', async () => {
    mockRedisGet.mockResolvedValueOnce(completedJobData());

    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sourceId).toBe('source-new-1');
    expect(res.body.data.documentId).toBe('doc-1');

    // Verify SearchSource was created
    expect(mockSearchSourceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        indexId: 'index-1',
        sourceType: 'web',
        status: 'pending',
      }),
    );

    // Verify ingestion was called
    expect(mockIngestCrawledContent).toHaveBeenCalledWith(
      expect.objectContaining({
        indexId: 'index-1',
        sourceId: 'source-new-1',
        url: 'https://example.com/page',
        tenantId: 'tenant-1',
      }),
    );

    // Verify Redis was updated with savedSourceId
    const setexCalls = mockRedisSetex.mock.calls;
    const saveCalls = setexCalls.filter(
      (call: any[]) => typeof call[2] === 'string' && call[2].includes('savedSourceId'),
    );
    expect(saveCalls.length).toBeGreaterThan(0);
    const savedState = JSON.parse(saveCalls[0][2]);
    expect(savedState.savedSourceId).toBe('source-new-1');
    expect(savedState.savedDocumentId).toBe('doc-1');
  });

  // ─── 404 Cases ───────────────────────────────────────────────────────────

  test('returns 404 for expired/missing job', async () => {
    mockRedisGet.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'expired-job', indexId: 'index-1' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('JOB_NOT_FOUND');
  });

  test('returns 404 for cross-tenant access (not 403)', async () => {
    mockRedisGet.mockResolvedValueOnce(completedJobData({ tenantId: 'other-tenant' }));

    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-1' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('JOB_NOT_FOUND');
  });

  test('returns 404 for index not belonging to tenant', async () => {
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-other' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('returns 404 for index outside API key projectScope before creating a source', async () => {
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });
    mockRedisGet.mockResolvedValueOnce(completedJobData());

    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-1' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockSearchIndexFindOne).toHaveBeenCalledWith({
      _id: 'index-1',
      tenantId: 'tenant-1',
      projectId: { $in: ['project-allowed'] },
    });
    expect(mockSearchSourceCreate).not.toHaveBeenCalled();
  });

  // ─── 400 Cases ───────────────────────────────────────────────────────────

  test('returns 400 for incomplete job', async () => {
    mockRedisGet.mockResolvedValueOnce(
      completedJobData({ status: 'running', rawHtmlStorageUrl: undefined }),
    );

    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-1' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('JOB_NOT_COMPLETE');
  });

  test('returns 400 for missing raw HTML', async () => {
    mockRedisGet.mockResolvedValueOnce(completedJobData({ rawHtmlStorageUrl: undefined }));

    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-1' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NO_HTML_AVAILABLE');
  });

  // ─── Validation Errors ───────────────────────────────────────────────────

  test('returns 400 for missing jobId', async () => {
    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ indexId: 'index-1' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 for missing indexId', async () => {
    const res = await request(app).post('/api/crawl/intelligence/save').send({ jobId: 'job-1' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // ─── Idempotency ────────────────────────────────────────────────────────

  test('idempotency: second save returns same IDs without re-creating', async () => {
    mockRedisGet.mockResolvedValueOnce(
      completedJobData({
        savedSourceId: 'source-existing',
        savedDocumentId: 'doc-existing',
      }),
    );

    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sourceId).toBe('source-existing');
    expect(res.body.data.documentId).toBe('doc-existing');

    // Should NOT create a new source
    expect(mockSearchSourceCreate).not.toHaveBeenCalled();
    expect(mockIngestCrawledContent).not.toHaveBeenCalled();
  });

  // ─── Cleanup on Ingestion Failure ────────────────────────────────────────

  test('cleanup on ingestion failure: orphaned source is deleted', async () => {
    mockRedisGet.mockResolvedValueOnce(completedJobData());
    mockIngestCrawledContent.mockRejectedValueOnce(new Error('Ingestion pipeline error'));

    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-1' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');

    // Verify cleanup — source was deleted
    expect(mockSearchSourceDeleteOne).toHaveBeenCalledWith({ _id: 'source-new-1' });
  });

  test('cleanup on ingestion result failure: orphaned source is deleted', async () => {
    mockRedisGet.mockResolvedValueOnce(completedJobData());
    mockIngestCrawledContent.mockResolvedValueOnce({
      success: false,
      error: { code: 'INGESTION_FAILED', message: 'Pipeline error' },
    });

    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-1' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INGESTION_FAILED');

    // Verify cleanup
    expect(mockSearchSourceDeleteOne).toHaveBeenCalledWith({ _id: 'source-new-1' });
  });

  // ─── Auth ────────────────────────────────────────────────────────────────

  test('returns 401 when no tenantId', async () => {
    const noAuthApp = express();
    noAuthApp.use(express.json());
    noAuthApp.use((req: Request, _res: Response, next: NextFunction) => {
      // No tenantId set
      next();
    });
    const { intelligenceRouter } = await import('../intelligence.js');
    noAuthApp.use('/api/crawl', intelligenceRouter);
    noAuthApp.use((err: any, _req: any, res: any, _next: any) => {
      res
        .status(500)
        .json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
    });

    const res = await request(noAuthApp)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-1' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
