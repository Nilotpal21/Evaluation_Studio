/**
 * Intelligence Route Tests
 *
 * Tests for POST /intelligence/analyze and GET /intelligence/status/:jobId
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Mocks — must be before module imports
// ---------------------------------------------------------------------------

// Mock Redis
const mockRedisGet = vi.fn();
const mockRedisSetex = vi.fn().mockResolvedValue('OK');
const mockRedisDel = vi.fn().mockResolvedValue(1);
const mockRedisExists = vi.fn().mockResolvedValue(0);
const mockRedisIncr = vi.fn().mockResolvedValue(1);
const mockRedisExpire = vi.fn().mockResolvedValue(1);
const mockRedisOn = vi.fn();
const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-id-1' });
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockSharedRedis = {
  get: mockRedisGet,
  setex: mockRedisSetex,
  del: mockRedisDel,
  exists: mockRedisExists,
  incr: mockRedisIncr,
  expire: mockRedisExpire,
  on: mockRedisOn,
  quit: vi.fn().mockResolvedValue('OK'),
};

vi.mock('ioredis', () => {
  class MockIORedis {
    get = mockRedisGet;
    setex = mockRedisSetex;
    del = mockRedisDel;
    exists = mockRedisExists;
    incr = mockRedisIncr;
    expire = mockRedisExpire;
    on = mockRedisOn;
    quit = vi.fn().mockResolvedValue('OK');
  }
  return { default: MockIORedis, Redis: MockIORedis };
});

vi.mock('../../workers/shared.js', () => ({
  getRedisConnection: () => ({ host: 'localhost', port: 6379 }),
  getSharedRedisClient: () => mockSharedRedis,
  createQueue: vi.fn().mockReturnValue({ add: mockQueueAdd, close: mockQueueClose }),
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

// Mock LLM config resolver
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

// Mock WorkerLLMClient
vi.mock('@agent-platform/llm', () => ({
  WorkerLLMClient: vi.fn().mockImplementation(() => ({
    chat: vi.fn(),
    chatWithToolUse: vi.fn(),
  })),
}));

// Mock MCPClient
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

// Mock CrawlIntelligenceService
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

// Mock SSRF protection
vi.mock('../../utils/ssrf-protection.js', () => ({
  isURLAllowed: vi.fn().mockResolvedValue({ allowed: true }),
}));

// Mock progress events
vi.mock('../progress.js', () => ({
  publishProgressEvent: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Test App Setup
// ---------------------------------------------------------------------------

async function createTestApp(): Promise<Express> {
  const app = express();
  app.use(express.json());

  // Fake auth middleware injecting tenant context
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).tenantContext = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'ADMIN',
      permissions: ['*'],
      authType: 'user' as const,
      isSuperAdmin: false,
    };
    next();
  });

  // Lazy-import the router — must be after mocks
  const { intelligenceRouter } = await import('../intelligence.js');
  app.use('/api/crawl', intelligenceRouter);

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Intelligence Route', () => {
  let app: Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRedisExists.mockResolvedValue(0);
    mockRedisIncr.mockResolvedValue(1);
    mockRedisGet.mockResolvedValue(null);
    app = await createTestApp();
  });

  // BT-1: POST with valid input returns { success: true, jobId }
  test('BT-1: POST /intelligence/analyze with valid input returns jobId', async () => {
    const res = await request(app)
      .post('/api/crawl/intelligence/analyze')
      .send({ url: 'https://example.com/page', indexId: 'index-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.jobId).toBeDefined();
    expect(typeof res.body.jobId).toBe('string');
  });

  // BT-2: POST with missing url returns 400
  test('BT-2: POST with missing url returns 400', async () => {
    const res = await request(app)
      .post('/api/crawl/intelligence/analyze')
      .send({ indexId: 'index-1' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // BT-3: POST with invalid URL format returns 400
  test('BT-3: POST with invalid URL format returns 400', async () => {
    const res = await request(app)
      .post('/api/crawl/intelligence/analyze')
      .send({ url: 'not-a-url', indexId: 'index-1' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // BT-4: POST with missing indexId returns 400
  test('BT-4: POST with missing indexId returns 400', async () => {
    const res = await request(app)
      .post('/api/crawl/intelligence/analyze')
      .send({ url: 'https://example.com/page' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // BT-5: LLM config not found returns 500 with LLM_NOT_CONFIGURED
  test('BT-5: LLM config not found returns 500', async () => {
    const { resolveIndexLLMConfig } = await import('../../services/llm-config/resolver.js');
    (resolveIndexLLMConfig as any).mockRejectedValueOnce(new Error('No config'));

    const res = await request(app)
      .post('/api/crawl/intelligence/analyze')
      .send({ url: 'https://example.com/page', indexId: 'index-1' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('LLM_NOT_CONFIGURED');
  });

  // BT-6: Redis job state set correctly
  test('BT-6: Redis job state includes tenantId', async () => {
    const res = await request(app)
      .post('/api/crawl/intelligence/analyze')
      .send({ url: 'https://example.com/page', indexId: 'index-1' });

    expect(res.status).toBe(200);

    // Verify setex was called with job state containing tenantId
    const setexCalls = mockRedisSetex.mock.calls;
    const jobStateCalls = setexCalls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('intelligence:job:'),
    );
    expect(jobStateCalls.length).toBeGreaterThan(0);

    const jobState = JSON.parse(jobStateCalls[0][2]);
    expect(jobState.tenantId).toBe('tenant-1');
    expect(jobState.status).toBe('pending');
  });

  // BT-7: GET /status/:jobId own job returns status
  test('BT-7: GET /intelligence/status/:jobId returns status for own job', async () => {
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({ status: 'completed', tenantId: 'tenant-1', result: { body: 'test' } }),
    );

    const res = await request(app).get('/api/crawl/intelligence/status/job-123');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('completed');
    expect(res.body.data.result).toEqual({ body: 'test' });
  });

  // BT-8: GET /status/:jobId other tenant returns 404
  test('BT-8: GET /intelligence/status/:jobId other tenant returns 404', async () => {
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({ status: 'completed', tenantId: 'other-tenant' }),
    );

    const res = await request(app).get('/api/crawl/intelligence/status/job-123');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // BT-9: GET /status/:jobId non-existent returns 404
  test('BT-9: GET /intelligence/status/:jobId non-existent returns 404', async () => {
    mockRedisGet.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/crawl/intelligence/status/nonexistent-job');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // BT-10: Concurrent limit blocks second request
  test('BT-10: Concurrent limit returns 429', async () => {
    mockRedisExists.mockResolvedValueOnce(1); // Active key exists

    const res = await request(app)
      .post('/api/crawl/intelligence/analyze')
      .send({ url: 'https://example.com/page', indexId: 'index-1' });

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('RATE_LIMIT_CONCURRENT');
  });

  // BT-11: Hourly limit blocks after 30
  test('BT-11: Hourly limit returns 429 after 30 requests', async () => {
    mockRedisIncr.mockResolvedValueOnce(31); // Over limit

    const res = await request(app)
      .post('/api/crawl/intelligence/analyze')
      .send({ url: 'https://example.com/page', indexId: 'index-1' });

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('RATE_LIMIT_HOURLY');
  });
});
