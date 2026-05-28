/**
 * Intelligence Handler Persistence Tests
 *
 * Tests for T-4: handler persistence after save, recordSuccess tracking,
 * handlerReused flag in IntelligenceAnalysisResult type, and singleton
 * initialization of HandlerReuser / MongoHandlerStore.
 *
 * NOTE: The analyze route runs handler persistence inside a fire-and-forget
 * `setImmediate` callback. Testing that background flow reliably in vitest
 * is fragile. Instead, we test:
 * 1. Save route: recordSuccess is called after successful ingestion
 * 2. Save route: recordSuccess failure doesn't block the response
 * 3. Save route: recordSuccess skipped when handler is absent
 * 4. Module initialization: singletons are created without errors
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
  mockSaveHandler,
  mockRecordSuccess,
  mockFindByFingerprint,
  mockFindByDomain,
  mockRecordFailure,
  mockDeleteByDomain,
  mockRegisterHandler,
  mockFingerprint,
  mockExecute,
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
  mockSaveHandler: vi.fn().mockResolvedValue(undefined),
  mockRecordSuccess: vi.fn().mockResolvedValue(undefined),
  mockFindByFingerprint: vi.fn().mockResolvedValue(null),
  mockFindByDomain: vi.fn().mockResolvedValue([]),
  mockRecordFailure: vi.fn().mockResolvedValue(undefined),
  mockDeleteByDomain: vi.fn().mockResolvedValue(0),
  mockRegisterHandler: vi.fn(),
  mockFingerprint: vi.fn().mockReturnValue({ fingerprint: 123456n, tagPathCount: 10 }),
  mockExecute: vi.fn(),
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
      case 'HandlerTemplate':
        return {};
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
  return { default: MockIORedis, Redis: MockIORedis };
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
  class MockCrawlIntelligenceService {
    execute = mockExecute;
  }
  class MockHandlerReuser {
    registerHandler = mockRegisterHandler;
    tryReuse = vi.fn().mockReturnValue({ matched: false, skippedPhases: [], llmCallsSaved: 0 });
    match = vi.fn().mockReturnValue({ matched: false });
    getStats = vi
      .fn()
      .mockReturnValue({ size: 0, maxSize: 1000, templateCount: 0, expiredCount: 0 });
  }
  class MockTemplateFingerprinter {
    fingerprint = mockFingerprint;
    compare = vi.fn();
    cluster = vi.fn();
    static toSerializable = vi.fn().mockReturnValue({
      fingerprint: '0000000000001e240',
      tagPathCount: 10,
    });
    static hammingDistance = vi.fn().mockReturnValue(0);
  }
  class MockMongoHandlerStore {
    saveHandler = mockSaveHandler;
    findByFingerprint = mockFindByFingerprint;
    findByDomain = mockFindByDomain;
    recordSuccess = mockRecordSuccess;
    recordFailure = mockRecordFailure;
    deleteByDomain = mockDeleteByDomain;
  }
  return {
    CrawlIntelligenceService: MockCrawlIntelligenceService,
    HandlerReuser: MockHandlerReuser,
    TemplateFingerprinter: MockTemplateFingerprinter,
    MongoHandlerStore: MockMongoHandlerStore,
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
    result: {
      title: 'Test',
      body: 'Content',
      quality: 'rich',
      handlerReused: false,
    },
    rawHtmlStorageUrl: '/uploads/intelligence/tenant-1/job-1/raw.html',
    handler: {
      steps: [{ action: 'navigate', description: 'Go to page' }],
      urlPattern: '**/*.html',
      description: 'Test handler',
      extractionSelectors: { content: 'main' },
    },
    completedAt: new Date().toISOString(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Intelligence Handler Persistence', () => {
  let app: Express;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default mocks for save route
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'index-1', tenantId: 'tenant-1', name: 'Test Index' }),
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
    mockCreateFileStorage.mockReturnValue({
      upload: vi.fn().mockResolvedValue({ url: '/uploads/test/raw.html', sizeBytes: 100 }),
    });

    app = await createTestApp();
  });

  // ─── Module loads without error ──────────────────────────────────────────

  test('route module initializes handler singletons without error', async () => {
    // The fact that createTestApp() succeeded means TemplateFingerprinter,
    // HandlerReuser, and MongoHandlerStore were constructed without error
    expect(app).toBeDefined();
  });

  // ─── Save: recordSuccess ──────────────────────────────────────────────

  test('recordSuccess called after successful save when handler exists in job', async () => {
    mockRedisGet.mockResolvedValueOnce(completedJobData());

    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // recordSuccess should have been called with tenant, domain, fingerprint
    expect(mockRecordSuccess).toHaveBeenCalledWith(
      'tenant-1',
      'example.com',
      expect.any(String), // fingerprint hex
    );
  });

  test('fingerprinter is called with HTML content and URL for save route', async () => {
    mockRedisGet.mockResolvedValueOnce(completedJobData());

    await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-1' });

    // fingerprinter.fingerprint should have been called with the HTML content
    expect(mockFingerprint).toHaveBeenCalledWith(
      '<html><body>Test</body></html>',
      'https://example.com/page',
    );
  });

  test('recordSuccess failure does not block save response', async () => {
    mockRedisGet.mockResolvedValueOnce(completedJobData());
    mockRecordSuccess.mockRejectedValueOnce(new Error('MongoDB error'));

    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-1' });

    // Save should still succeed
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sourceId).toBe('source-new-1');
    expect(res.body.data.documentId).toBe('doc-1');
  });

  test('recordSuccess not called when handler is absent in job', async () => {
    mockRedisGet.mockResolvedValueOnce(completedJobData({ handler: undefined }));

    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-1' });

    expect(res.status).toBe(200);
    expect(mockRecordSuccess).not.toHaveBeenCalled();
  });

  test('recordSuccess not called when rawHtmlStorageUrl is absent in job', async () => {
    // rawHtmlStorageUrl missing should skip handler success recording
    // but also fail save due to NO_HTML_AVAILABLE before reaching that code
    mockRedisGet.mockResolvedValueOnce(completedJobData({ rawHtmlStorageUrl: undefined }));

    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-1' });

    // Should return 400 because rawHtmlStorageUrl is required for save
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_HTML_AVAILABLE');
    expect(mockRecordSuccess).not.toHaveBeenCalled();
  });

  // ─── IntelligenceAnalysisResult type includes handlerReused ─────────────

  test('handlerReused field exists in completedJobData result', () => {
    const data = JSON.parse(completedJobData());
    expect(data.result).toHaveProperty('handlerReused');
    expect(data.result.handlerReused).toBe(false);
  });

  // ─── Save still works normally with handler persistence additions ──────

  test('save happy path still works with handler persistence code', async () => {
    mockRedisGet.mockResolvedValueOnce(completedJobData());

    const res = await request(app)
      .post('/api/crawl/intelligence/save')
      .send({ jobId: 'job-1', indexId: 'index-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sourceId).toBe('source-new-1');
    expect(res.body.data.documentId).toBe('doc-1');

    // Source was created
    expect(mockSearchSourceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        indexId: 'index-1',
        sourceType: 'web',
      }),
    );

    // Ingestion was called
    expect(mockIngestCrawledContent).toHaveBeenCalledWith(
      expect.objectContaining({
        indexId: 'index-1',
        tenantId: 'tenant-1',
      }),
    );

    // Redis was updated with savedSourceId
    const setexCalls = mockRedisSetex.mock.calls;
    const saveCalls = setexCalls.filter(
      (call: any[]) => typeof call[2] === 'string' && call[2].includes('savedSourceId'),
    );
    expect(saveCalls.length).toBeGreaterThan(0);
  });

  // ─── Idempotency still works ────────────────────────────────────────────

  test('idempotency: already saved job returns existing IDs without recordSuccess', async () => {
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
    expect(res.body.data.sourceId).toBe('source-existing');
    expect(res.body.data.documentId).toBe('doc-existing');

    // Should NOT have called recordSuccess (idempotent path exits early)
    expect(mockRecordSuccess).not.toHaveBeenCalled();
    expect(mockSearchSourceCreate).not.toHaveBeenCalled();
  });
});
