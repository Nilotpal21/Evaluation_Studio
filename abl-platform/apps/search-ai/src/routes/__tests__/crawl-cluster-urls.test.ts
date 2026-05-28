/**
 * Crawl Cluster URLs Route Tests
 *
 * Tests for POST /crawl/cluster-urls
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Hoisted Mocks
// ---------------------------------------------------------------------------

const { mockAxiosGet, mockHttpAdapterFetch, mockDiscoveryChainDiscover, mockExtractSitemapUrls } =
  vi.hoisted(() => ({
    mockAxiosGet: vi.fn(),
    mockHttpAdapterFetch: vi.fn(),
    mockDiscoveryChainDiscover: vi.fn(),
    mockExtractSitemapUrls: vi.fn(),
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
    DiscoveryChain: class MockDiscoveryChain {
      discover = mockDiscoveryChainDiscover;
    },
    FastProfiler: class MockFastProfiler {
      profile = vi.fn().mockResolvedValue({
        domain: 'example.com',
        siteType: 'static',
        estimatedSize: 10,
        avgResponseTime: 100,
        metadata: { hasSitemap: false },
      });
      extractSitemapUrls = mockExtractSitemapUrls.mockResolvedValue([]);
      discoverSitemapUrls = vi.fn(async () => {
        const allUrls = await mockExtractSitemapUrls();
        return {
          allUrls,
          sitemapFiles: [
            {
              url: 'https://example.com/sitemap.xml',
              origin: 'default',
              urls: allUrls.map((loc: string) => ({ loc })),
              error: null,
            },
          ],
          steps: [],
          totalUrls: allUrls.length,
        };
      });
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
  getSharedRedisClient: vi.fn().mockReturnValue({
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
  }),
  getRedisConnection: vi.fn().mockReturnValue({ host: 'localhost', port: 6379 }),
  createQueue: vi.fn().mockReturnValue({
    add: vi.fn().mockResolvedValue({ id: 'job-123' }),
    getJob: vi.fn(),
    close: vi.fn(),
  }),
  QUEUE_BULK_CRAWL: 'bulk-crawl',
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

vi.mock('../../utils/ssrf-protection.js', () => ({
  isURLAllowed: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('axios', () => ({
  default: {
    get: mockAxiosGet,
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
  // No tenantContext injected

  const { default: crawlRouter } = await import('../crawl.js');
  app.use('/api/crawl', crawlRouter);

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /crawl/cluster-urls', () => {
  let app: Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await createTestApp();
  });

  test('returns 401 without auth', async () => {
    const unauthApp = await createUnauthApp();
    const res = await request(unauthApp)
      .post('/api/crawl/cluster-urls')
      .send({ url: 'https://example.com' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('returns 400 for invalid URL', async () => {
    const res = await request(app).post('/api/crawl/cluster-urls').send({ url: 'not-a-url' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('clusters provided sitemapUrls directly', async () => {
    const sitemapUrls = [
      'https://example.com/docs/page1',
      'https://example.com/docs/page2',
      'https://example.com/docs/page3',
      'https://example.com/blog/post1',
      'https://example.com/blog/post2',
      'https://example.com/blog/post3',
    ];

    const res = await request(app)
      .post('/api/crawl/cluster-urls')
      .send({ url: 'https://example.com', sitemapUrls });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.groups)).toBe(true);
    // Should group by pattern
    expect(res.body.groups.length).toBeGreaterThan(0);
    // Groups should be sorted by count descending
    for (let i = 1; i < res.body.groups.length; i++) {
      expect(res.body.groups[i - 1].count).toBeGreaterThanOrEqual(res.body.groups[i].count);
    }
  });

  test('falls back to sitemap.xml when sitemapUrls not provided', async () => {
    // Route now uses profiler.extractSitemapUrls (single authoritative sitemap path)
    mockExtractSitemapUrls.mockResolvedValueOnce([
      'https://example.com/page1',
      'https://example.com/page2',
    ]);

    const res = await request(app)
      .post('/api/crawl/cluster-urls')
      .send({ url: 'https://example.com' });

    // With only 2 URLs and default minGroupSize=2, both end up in root pattern
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.discoveryMethod).toBe('sitemap');
  });

  test('falls back to DiscoveryChain when sitemap fails', async () => {
    // Sitemap extraction fails (profiler.extractSitemapUrls throws)
    mockExtractSitemapUrls.mockRejectedValueOnce(new Error('404'));
    // DiscoveryChain returns discovered URLs
    mockDiscoveryChainDiscover.mockResolvedValueOnce({
      urls: ['https://example.com/about', 'https://example.com/contact'],
      method: 'nav-bfs',
      steps: [{ method: 'nav-bfs', urlsFound: 2, duration: 150 }],
      stats: { totalSteps: 1, totalDuration: 150, urlsPerStep: { 'nav-bfs': 2 } },
    });

    const res = await request(app)
      .post('/api/crawl/cluster-urls')
      .send({ url: 'https://example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.discoveryMethod).toBe('nav-bfs');
    expect(res.body.discoverySteps).toHaveLength(1);
  });

  test('passes platform and apiEndpoints to DiscoveryChain', async () => {
    // Sitemap extraction fails — falls through to DiscoveryChain
    mockExtractSitemapUrls.mockRejectedValueOnce(new Error('404'));
    // DiscoveryChain returns platform API discovered URLs
    mockDiscoveryChainDiscover.mockResolvedValueOnce({
      urls: ['https://example.com/products/widget', 'https://example.com/products/gadget'],
      method: 'platform-api',
      steps: [{ method: 'platform-api', urlsFound: 2, duration: 200 }],
      stats: { totalSteps: 1, totalDuration: 200, urlsPerStep: { 'platform-api': 2 } },
    });

    const res = await request(app)
      .post('/api/crawl/cluster-urls')
      .send({
        url: 'https://example.com',
        platform: 'shopify',
        apiEndpoints: ['/products.json'],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.discoveryMethod).toBe('platform-api');
    expect(mockDiscoveryChainDiscover).toHaveBeenCalledWith('https://example.com', {
      platform: 'shopify',
      apiEndpoints: ['/products.json'],
    });
  });

  test('returns empty groups when no URLs found', async () => {
    // Sitemap extraction fails — falls through to DiscoveryChain
    mockExtractSitemapUrls.mockRejectedValueOnce(new Error('404'));
    // DiscoveryChain returns no URLs
    mockDiscoveryChainDiscover.mockResolvedValueOnce({
      urls: [],
      method: 'none',
      steps: [],
      stats: { totalSteps: 0, totalDuration: 0, urlsPerStep: {} },
    });

    const res = await request(app)
      .post('/api/crawl/cluster-urls')
      .send({ url: 'https://example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.groups).toEqual([]);
  });

  test('error response uses structured envelope', async () => {
    // Sitemap extraction fails
    mockExtractSitemapUrls.mockRejectedValueOnce(new Error('network error'));
    // DiscoveryChain also fails
    mockDiscoveryChainDiscover.mockRejectedValueOnce(new Error('discovery failed'));

    const res = await request(app)
      .post('/api/crawl/cluster-urls')
      .send({ url: 'https://example.com' });

    // Should fail with structured error
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
  });
});
