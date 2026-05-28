/**
 * Crawl Sample Groups Route Tests
 *
 * Tests for POST /crawl/sample-groups
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Hoisted Mocks
// ---------------------------------------------------------------------------

const { mockIsURLAllowed, mockHttpAdapterFetch } = vi.hoisted(() => ({
  mockIsURLAllowed: vi.fn(),
  mockHttpAdapterFetch: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module Mocks
// ---------------------------------------------------------------------------

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/database/models', () => ({}));

vi.mock('../../db/index.js', () => ({
  getModel: () => ({}),
  getLazyModel: () => ({}),
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

vi.mock('@abl/crawler', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@abl/crawler');
  return {
    ...actual,
    HttpAdapter: class MockHttpAdapter {
      fetch = mockHttpAdapterFetch;
    },
    FastProfiler: class MockFastProfiler {
      profile = vi.fn().mockResolvedValue({
        domain: 'example.com',
        siteType: 'static',
        estimatedSize: 10,
        avgResponseTime: 100,
        metadata: { hasSitemap: false },
      });
      extractSitemapUrls = vi.fn().mockResolvedValue([]);
    },
    DecisionEngine: class {
      decide = vi.fn().mockResolvedValue({ strategy: 'bulk', confidence: 90 });
    },
    PromptEvaluator: class {
      evaluate = vi.fn().mockResolvedValue({ shouldPrompt: false });
    },
    QuestionGenerator: class {
      generate = vi.fn().mockReturnValue([]);
    },
    ResponseProcessor: class {
      applyResponses = vi.fn();
    },
    StrategyResolver: class {
      resolve = vi.fn().mockResolvedValue({ params: {}, warnings: [], errors: [] });
    },
  };
});

vi.mock('../../workers/queue-monitor.js', () => ({
  getAllQueueStats: vi.fn().mockResolvedValue({}),
  getAllQueueHealth: vi.fn().mockResolvedValue({}),
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
    on = vi.fn().mockReturnThis();
    disconnect = vi.fn();
    status = 'ready';
  }
  return { default: MockRedis };
});

vi.mock('../../workers/shared.js', () => ({
  getRedisConnection: vi.fn().mockReturnValue({ host: 'localhost', port: 6379 }),
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

vi.mock('../../utils/ssrf-protection.js', () => ({
  isURLAllowed: mockIsURLAllowed,
}));

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    isAxiosError: vi.fn().mockReturnValue(false),
  },
}));

// ---------------------------------------------------------------------------
// Test App Setup
// ---------------------------------------------------------------------------

async function createTestApp(tenantId = 'tenant-1'): Promise<Express> {
  const app = express();
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).tenantContext = { tenantId, userId: 'user-1' };
    next();
  });

  const { default: crawlRouter } = await import('../crawl.js');
  app.use('/api/crawl', crawlRouter);

  return app;
}

async function createUnauthApp(): Promise<Express> {
  const app = express();
  app.use(express.json());

  const { default: crawlRouter } = await import('../crawl.js');
  app.use('/api/crawl', crawlRouter);

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /crawl/sample-groups', () => {
  let app: Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsURLAllowed.mockResolvedValue({ allowed: true });
    app = await createTestApp();
  });

  test('returns 401 without auth', async () => {
    const unauthApp = await createUnauthApp();
    const res = await request(unauthApp)
      .post('/api/crawl/sample-groups')
      .send({
        groups: [
          {
            pattern: '/docs/{slug}',
            count: 10,
            examples: ['https://example.com/docs/page1'],
          },
        ],
      });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('returns 400 for invalid input', async () => {
    const res = await request(app).post('/api/crawl/sample-groups').send({ groups: 'invalid' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 for groups with empty examples', async () => {
    const res = await request(app)
      .post('/api/crawl/sample-groups')
      .send({
        groups: [{ pattern: '/docs/{slug}', count: 10, examples: [] }],
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('blocks private IPs via SSRF protection', async () => {
    mockIsURLAllowed.mockResolvedValue({ allowed: false, reason: 'Private IP address' });

    const res = await request(app)
      .post('/api/crawl/sample-groups')
      .send({
        groups: [
          {
            pattern: '/docs/{slug}',
            count: 10,
            examples: ['http://192.168.1.1/docs/page1'],
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('SSRF_BLOCKED');
  });

  test('returns http method when samples pass all checks', async () => {
    mockHttpAdapterFetch.mockResolvedValue({
      success: true,
      crawlResult: {
        url: 'https://example.com/docs/page1',
        html: `<html><head><title>Test Page</title><meta name="description" content="A test"></head>
<body><article><section>${'Real content here. '.repeat(100)}</section></article>
<nav><a href="/home">Home</a><a href="/about">About</a><a href="/contact">Contact</a>
<a href="/docs">Docs</a><a href="/blog">Blog</a><a href="/help">Help</a></nav></body></html>`,
        text: 'Real content here. '.repeat(100),
        links: [
          { href: 'https://example.com/home', text: 'Home' },
          { href: 'https://example.com/about', text: 'About' },
          { href: 'https://example.com/contact', text: 'Contact' },
          { href: 'https://example.com/docs', text: 'Docs' },
          { href: 'https://example.com/blog', text: 'Blog' },
          { href: 'https://example.com/help', text: 'Help' },
        ],
        statusCode: 200,
        metadata: {},
      },
      statusCode: 200,
      duration: 100,
    });

    const res = await request(app)
      .post('/api/crawl/sample-groups')
      .send({
        groups: [
          {
            pattern: '/docs/{slug}',
            count: 10,
            examples: ['https://example.com/docs/page1'],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.strategies).toHaveLength(1);
    expect(res.body.strategies[0].method).toBe('http');
    expect(res.body.strategies[0].pattern).toBe('/docs/{slug}');
    expect(res.body.strategies[0]).toHaveProperty('llmEstimate');
    expect(res.body.strategies[0]).toHaveProperty('reason');
  });

  test('returns playwright method when samples fail quality checks', async () => {
    // Simulate an empty SPA shell
    mockHttpAdapterFetch.mockResolvedValue({
      success: true,
      crawlResult: {
        url: 'https://example.com/app/page1',
        html: '<html><body><div id="root"></div><script src="bundle.js"></script></body></html>',
        text: '', // Empty — SPA not rendered
        links: [],
        statusCode: 200,
        metadata: {},
      },
      statusCode: 200,
      duration: 100,
    });

    const res = await request(app)
      .post('/api/crawl/sample-groups')
      .send({
        groups: [
          {
            pattern: '/app/{slug}',
            count: 5,
            examples: ['https://example.com/app/page1'],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.strategies).toHaveLength(1);
    expect(res.body.strategies[0].method).toBe('playwright');
  });

  test('returns playwright method when fetch fails', async () => {
    mockHttpAdapterFetch.mockResolvedValue({
      success: false,
      error: 'Connection timeout',
      duration: 10000,
    });

    const res = await request(app)
      .post('/api/crawl/sample-groups')
      .send({
        groups: [
          {
            pattern: '/app/{slug}',
            count: 5,
            examples: ['https://example.com/app/page1'],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.strategies[0].method).toBe('playwright');
  });

  test('handles multiple groups correctly', async () => {
    // First group: good content
    mockHttpAdapterFetch
      .mockResolvedValueOnce({
        success: true,
        crawlResult: {
          url: 'https://example.com/docs/page1',
          html: `<html><head><title>Test</title></head><body><article>${'Content '.repeat(200)}</article>
<nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a><a href="/d">D</a><a href="/e">E</a><a href="/f">F</a></nav></body></html>`,
          text: 'Content '.repeat(200),
          links: Array.from({ length: 6 }, (_, i) => ({
            href: `https://example.com/${i}`,
            text: `Link ${i}`,
          })),
          statusCode: 200,
          metadata: {},
        },
        statusCode: 200,
        duration: 100,
      })
      // Second group: SPA shell
      .mockResolvedValueOnce({
        success: true,
        crawlResult: {
          url: 'https://example.com/app/page1',
          html: '<html><body><div id="root"></div></body></html>',
          text: '',
          links: [],
          statusCode: 200,
          metadata: {},
        },
        statusCode: 200,
        duration: 100,
      });

    const res = await request(app)
      .post('/api/crawl/sample-groups')
      .send({
        groups: [
          {
            pattern: '/docs/{slug}',
            count: 10,
            examples: ['https://example.com/docs/page1'],
          },
          {
            pattern: '/app/{slug}',
            count: 5,
            examples: ['https://example.com/app/page1'],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.strategies).toHaveLength(2);
    expect(res.body.strategies[0].method).toBe('http');
    expect(res.body.strategies[1].method).toBe('playwright');
  });

  test('error response uses structured envelope', async () => {
    // The route should catch and return structured error
    mockIsURLAllowed.mockRejectedValue(new Error('SSRF check crashed'));

    const res = await request(app)
      .post('/api/crawl/sample-groups')
      .send({
        groups: [
          {
            pattern: '/docs/{slug}',
            count: 10,
            examples: ['https://example.com/docs/page1'],
          },
        ],
      });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
    expect(res.body.error.code).toBe('SAMPLE_FAILED');
  });
});
