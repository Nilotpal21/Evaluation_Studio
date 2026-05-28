/**
 * Error Recovery and Retry Tests
 *
 * Tests how core crawler components handle failures gracefully:
 * - FastProfiler: HTTP errors, timeouts, partial failures
 * - DecisionEngine: Store failures, missing dependencies
 * - StrategyResolver: Invalid configs, fallbacks
 * - Error type verification
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import axios from 'axios';
import { FastProfiler } from '../../profiler/fast-profiler.js';
import { ProfilerTimeoutError, ProfilerError } from '../../profiler/interfaces.js';
import { DecisionEngine } from '../../decision/decision-engine.js';
import { DecisionError } from '../../decision/interfaces.js';
import type {
  DecisionContext,
  IUserPreferenceStore,
  ITenantPolicyStore,
  IPatternLearner,
  CrawlOutcome,
} from '../../decision/interfaces.js';
import type { SiteProfile } from '../../profiler/interfaces.js';
import { StrategyResolver } from '../../strategy/resolver.js';

const mockSafeFetch = vi.hoisted(() => vi.fn());

// Mock axios
vi.mock('axios');
// Mock safeFetch (production code calls it from this subpath after ABLP-573).
vi.mock('@agent-platform/shared-kernel/security/safe-fetch', () => ({
  safeFetch: mockSafeFetch,
}));
const mockedAxios = vi.mocked(axios);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<SiteProfile> = {}): SiteProfile {
  return {
    domain: 'example.com',
    profiledAt: new Date(),
    siteType: 'static',
    jsRequired: false,
    linkDensity: 10,
    estimatedSize: 100,
    avgResponseTime: 200,
    rateLimitDetected: false,
    maxConcurrency: 10,
    confidence: 85,
    metadata: {
      hasRobotsTxt: true,
      hasSitemap: true,
      htmlSize: 5000,
      scriptTagCount: 2,
    },
    ...overrides,
  };
}

function makeDecisionContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    url: 'https://example.com',
    tenantId: 'tenant-1',
    profile: makeProfile(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Part 1: FastProfiler Error Handling
// ---------------------------------------------------------------------------

describe('FastProfiler Error Handling', () => {
  let profiler: FastProfiler;

  beforeEach(() => {
    profiler = new FastProfiler();
    vi.clearAllMocks();
    // Bridge production safeFetch (used by fast-profiler) to the axios
    // mock fixtures so existing tests' mockResolvedValue / mockRejectedValue
    // setups continue to drive behavior, including axios-shaped errors.
    mockSafeFetch.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const fn = method === 'HEAD' ? mockedAxios.head : mockedAxios.get;
      const axiosResp = await fn(String(url));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => axiosResp?.data ?? '',
      } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('HTTP 404 response throws ProfilerError (not timeout)', async () => {
    const axiosError = {
      isAxiosError: true,
      message: 'Request failed with status code 404',
      code: undefined,
      response: { status: 404 },
    };

    mockedAxios.get.mockRejectedValue(axiosError);
    mockedAxios.head.mockRejectedValue(new Error('Not found'));

    // We need isAxiosError to return true for this mock
    vi.mocked(axios.isAxiosError).mockReturnValue(true);

    await expect(profiler.profile('https://missing.example')).rejects.toThrow(ProfilerError);
    await expect(profiler.profile('https://missing.example')).rejects.not.toThrow(
      ProfilerTimeoutError,
    );
  });

  test('HTTP 429 response throws ProfilerError (not timeout)', async () => {
    const axiosError = {
      isAxiosError: true,
      message: 'Request failed with status code 429',
      code: undefined,
      response: { status: 429 },
    };

    mockedAxios.get.mockRejectedValue(axiosError);
    mockedAxios.head.mockRejectedValue(new Error('Not found'));
    vi.mocked(axios.isAxiosError).mockReturnValue(true);

    await expect(profiler.profile('https://ratelimited.example')).rejects.toThrow(ProfilerError);
    await expect(profiler.profile('https://ratelimited.example')).rejects.not.toThrow(
      ProfilerTimeoutError,
    );
  });

  test('HTTP 503 response throws ProfilerError (not timeout)', async () => {
    const axiosError = {
      isAxiosError: true,
      message: 'Request failed with status code 503',
      code: undefined,
      response: { status: 503 },
    };

    mockedAxios.get.mockRejectedValue(axiosError);
    mockedAxios.head.mockRejectedValue(new Error('Not found'));
    vi.mocked(axios.isAxiosError).mockReturnValue(true);

    await expect(profiler.profile('https://unavailable.example')).rejects.toThrow(ProfilerError);
    await expect(profiler.profile('https://unavailable.example')).rejects.not.toThrow(
      ProfilerTimeoutError,
    );
  });

  test('Network ECONNREFUSED throws ProfilerError', async () => {
    const axiosError = {
      isAxiosError: true,
      message: 'connect ECONNREFUSED 127.0.0.1:443',
      code: 'ECONNREFUSED',
    };

    mockedAxios.get.mockRejectedValue(axiosError);
    mockedAxios.head.mockRejectedValue(new Error('Not found'));
    vi.mocked(axios.isAxiosError).mockReturnValue(true);

    // ECONNREFUSED is not a timeout code, so fetchHTML goes to isAxiosError branch
    await expect(profiler.profile('https://refused.example')).rejects.toThrow(ProfilerError);
  });

  test('Timeout ECONNABORTED throws ProfilerTimeoutError (not generic error)', async () => {
    mockedAxios.get.mockRejectedValue({
      code: 'ECONNABORTED',
      message: 'Connection aborted',
      isAxiosError: true,
    });
    mockedAxios.head.mockRejectedValue(new Error('Not found'));

    await expect(profiler.profile('https://slow.example', { timeout: 1000 })).rejects.toThrow(
      ProfilerTimeoutError,
    );
  });

  test('Timeout ETIMEDOUT throws ProfilerTimeoutError', async () => {
    mockedAxios.get.mockRejectedValue({
      code: 'ETIMEDOUT',
      message: 'Timeout',
      isAxiosError: true,
    });
    mockedAxios.head.mockRejectedValue(new Error('Not found'));

    await expect(profiler.profile('https://slow.example', { timeout: 2000 })).rejects.toThrow(
      ProfilerTimeoutError,
    );
  });

  test('robots.txt failure is silent — profile still succeeds', async () => {
    // HTML succeeds, robots.txt fails, sitemap fails
    mockedAxios.get.mockImplementation((url) => {
      if (url === 'https://example.com') {
        return Promise.resolve({
          data: '<html><body><article>Content here</article></body></html>',
        });
      }
      if (typeof url === 'string' && url.includes('robots.txt')) {
        return Promise.reject({ response: { status: 404 }, isAxiosError: true });
      }
      return Promise.reject(new Error('Not found'));
    });
    mockedAxios.head.mockRejectedValue(new Error('Not found'));

    const profile = await profiler.profile('https://example.com');

    expect(profile.metadata.hasRobotsTxt).toBe(false);
    expect(profile.domain).toBe('example.com');
  });

  test('sitemap failure is silent — profile still succeeds', async () => {
    // HTML succeeds, robots.txt succeeds, sitemap fails
    mockedAxios.get.mockImplementation((url) => {
      if (url === 'https://example.com') {
        return Promise.resolve({
          data: '<html><body><article>Content here</article></body></html>',
        });
      }
      if (typeof url === 'string' && url.includes('robots.txt')) {
        return Promise.resolve({ data: 'User-agent: *\nAllow: /' });
      }
      return Promise.reject(new Error('Not found'));
    });
    mockedAxios.head.mockRejectedValue(new Error('Sitemap not found'));

    const profile = await profiler.profile('https://example.com');

    expect(profile.metadata.hasSitemap).toBe(false);
    expect(profile.metadata.hasRobotsTxt).toBe(true);
  });

  test('HTML fetch fails but robots.txt and sitemap succeed — should throw', async () => {
    // HTML fails, robots.txt and sitemap succeed
    const axiosError = {
      isAxiosError: true,
      message: 'Request failed with status code 500',
      code: undefined,
    };

    mockedAxios.get.mockImplementation((url) => {
      if (url === 'https://broken.example') {
        return Promise.reject(axiosError);
      }
      if (typeof url === 'string' && url.includes('robots.txt')) {
        return Promise.resolve({ data: 'User-agent: *\nAllow: /' });
      }
      return Promise.resolve({ data: '<?xml version="1.0"?><urlset></urlset>' });
    });
    mockedAxios.head.mockResolvedValue({ status: 200 });
    vi.mocked(axios.isAxiosError).mockReturnValue(true);

    // HTML is required — Promise.all will reject because fetchHTML throws
    await expect(profiler.profile('https://broken.example')).rejects.toThrow();
  });

  test('All three parallel requests fail — should throw ProfilerError for HTML failure', async () => {
    const axiosError = {
      isAxiosError: true,
      message: 'Network Error',
      code: 'ERR_NETWORK',
    };

    mockedAxios.get.mockRejectedValue(axiosError);
    mockedAxios.head.mockRejectedValue(axiosError);
    vi.mocked(axios.isAxiosError).mockReturnValue(true);

    // The profile() catch wraps the error from Promise.all
    // The first rejection from fetchHTML (which throws ProfilerError) propagates
    await expect(profiler.profile('https://down.example')).rejects.toThrow(ProfilerError);
  });
});

// ---------------------------------------------------------------------------
// Part 2: DecisionEngine Error Handling
// ---------------------------------------------------------------------------

describe('DecisionEngine Error Handling', () => {
  test('userPreferenceStore throws — decide() throws DecisionError', async () => {
    const failingStore: IUserPreferenceStore = {
      getPreference: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      savePreference: vi.fn(),
      deletePreference: vi.fn(),
      listPreferences: vi.fn(),
      trackUsage: vi.fn(),
    };

    const engine = new DecisionEngine({
      userPreferenceStore: failingStore,
    });

    const context = makeDecisionContext({ userId: 'user-1' });

    await expect(engine.decide(context)).rejects.toThrow(DecisionError);
    await expect(engine.decide(context)).rejects.toMatchObject({
      code: 'DECISION_FAILED',
    });
  });

  test('tenantPolicyStore throws — decide() throws DecisionError', async () => {
    const failingPolicyStore: ITenantPolicyStore = {
      getPolicy: vi.fn().mockRejectedValue(new Error('Redis timeout')),
      createPolicy: vi.fn(),
      updatePolicy: vi.fn(),
      deletePolicy: vi.fn(),
      listPolicies: vi.fn(),
    };

    const engine = new DecisionEngine({
      tenantPolicyStore: failingPolicyStore,
    });

    const context = makeDecisionContext();

    await expect(engine.decide(context)).rejects.toThrow(DecisionError);
  });

  test('Both stores throw — DecisionError with meaningful message', async () => {
    const failingUserStore: IUserPreferenceStore = {
      getPreference: vi.fn().mockRejectedValue(new Error('User store down')),
      savePreference: vi.fn(),
      deletePreference: vi.fn(),
      listPreferences: vi.fn(),
      trackUsage: vi.fn(),
    };

    const failingPolicyStore: ITenantPolicyStore = {
      getPolicy: vi.fn().mockRejectedValue(new Error('Policy store down')),
      createPolicy: vi.fn(),
      updatePolicy: vi.fn(),
      deletePolicy: vi.fn(),
      listPolicies: vi.fn(),
    };

    const engine = new DecisionEngine({
      userPreferenceStore: failingUserStore,
      tenantPolicyStore: failingPolicyStore,
    });

    // With userId, it hits userPreferenceStore first and fails
    const context = makeDecisionContext({ userId: 'user-1' });

    const error = await engine.decide(context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecisionError);
    expect((error as DecisionError).message).toBe('Failed to make crawl decision');
    expect((error as DecisionError).code).toBe('DECISION_FAILED');
    expect((error as DecisionError).cause).toBeInstanceOf(Error);
  });

  test('Empty options (no stores) — succeeds with heuristic-only (Level 5)', async () => {
    const engine = new DecisionEngine();

    const context = makeDecisionContext();
    const decision = await engine.decide(context);

    expect(decision.source).toBe('profile-heuristic');
    expect(decision.strategy).toBeDefined();
    expect(decision.confidence).toBeGreaterThan(0);
  });

  test('recordOutcome with no patternLearner — no-op, does not throw', async () => {
    const engine = new DecisionEngine();

    const outcome: CrawlOutcome = {
      tenantId: 'tenant-1',
      domain: 'example.com',
      strategy: 'bulk',
      batchSize: 50,
      concurrency: 10,
      success: true,
      urlsCrawled: 100,
      duration: 5000,
      throughput: 20,
      completedAt: new Date(),
    };

    // Should not throw
    await expect(engine.recordOutcome(outcome)).resolves.toBeUndefined();
  });

  test('recordOutcome with patternLearner that throws — does not propagate error', async () => {
    const failingLearner: IPatternLearner = {
      learn: vi.fn().mockRejectedValue(new Error('Learning failed')),
      getPattern: vi.fn(),
      listPatterns: vi.fn(),
      decayPatterns: vi.fn(),
    };

    const engine = new DecisionEngine({
      patternLearner: failingLearner,
    });

    const outcome: CrawlOutcome = {
      tenantId: 'tenant-1',
      domain: 'example.com',
      strategy: 'bulk',
      batchSize: 50,
      concurrency: 10,
      success: true,
      urlsCrawled: 100,
      duration: 5000,
      throughput: 20,
      completedAt: new Date(),
    };

    // Should swallow the error (logs it, doesn't throw)
    await expect(engine.recordOutcome(outcome)).resolves.toBeUndefined();
    expect(failingLearner.learn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Part 3: StrategyResolver Error Recovery
// ---------------------------------------------------------------------------

describe('StrategyResolver Error Recovery', () => {
  let resolver: StrategyResolver;
  let staticProfile: SiteProfile;

  beforeEach(() => {
    resolver = new StrategyResolver();
    staticProfile = makeProfile({
      metadata: {
        hasRobotsTxt: true,
        hasSitemap: false,
        htmlSize: 5000,
        scriptTagCount: 2,
      },
    });
  });

  test('Invalid strategy with fallback — returns errors', async () => {
    const result = await resolver.resolve({ strategy: 'bogus-strategy' as any }, staticProfile);

    // Unknown strategy produces validation error
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('Unknown strategy'))).toBe(true);
    // Still returns default params
    expect(result.params).toBeDefined();
    expect(result.params.internalStrategy).toBe('bulk');
  });

  test('Sitemap strategy without sitemap, with fallback — uses fallback, adds warning', async () => {
    const profileNoSitemap = makeProfile({
      metadata: { hasSitemap: false },
    });

    const result = await resolver.resolve(
      {
        strategy: 'sitemap',
        fallbackStrategy: 'smart',
      },
      profileNoSitemap,
    );

    // Should have a warning about falling back
    expect(result.warnings.some((w) => w.includes('No sitemap found'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('smart'))).toBe(true);
    // No errors since fallback was provided
    expect(result.errors).toHaveLength(0);
    // Should have resolved params — requestedStrategy reflects the applied fallback
    expect(result.params.requestedStrategy).toBe('smart');
    expect(result.params.fallbackApplied).toBe(true);
  });

  test('Sitemap strategy without sitemap, without fallback — returns errors array, uses default params', async () => {
    const profileNoSitemap = makeProfile({
      metadata: { hasSitemap: false },
    });

    const result = await resolver.resolve({ strategy: 'sitemap' }, profileNoSitemap);

    // Should have errors
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('sitemap'))).toBe(true);
    // Returns default params
    expect(result.params.internalStrategy).toBe('bulk');
    expect(result.params.batchSize).toBe(50);
  });

  test('Validation failure — returns default params with exact values', async () => {
    // 'limited' strategy requires maxPages
    const result = await resolver.resolve({ strategy: 'limited' }, staticProfile);

    expect(result.errors.length).toBeGreaterThan(0);

    // Verify exact default values
    expect(result.params.internalStrategy).toBe('bulk');
    expect(result.params.batchSize).toBe(50);
    expect(result.params.concurrency).toBe(10);
    expect(result.params.jsHandling).toBe('none');
    expect(result.params.requestedStrategy).toBe('single-page');
    expect(result.params.fallbackApplied).toBe(false);
    expect(result.params.reasoning).toBe('Default parameters due to validation error.');
  });
});

// ---------------------------------------------------------------------------
// Part 4: Error Type Verification
// ---------------------------------------------------------------------------

describe('Error Type Verification', () => {
  test('ProfilerTimeoutError — has url, timeoutMs, message includes both, instanceof Error', () => {
    const error = new ProfilerTimeoutError('https://slow.example', 5000);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProfilerTimeoutError);
    expect(error.url).toBe('https://slow.example');
    expect(error.timeoutMs).toBe(5000);
    expect(error.message).toContain('https://slow.example');
    expect(error.message).toContain('5000');
    expect(error.name).toBe('ProfilerTimeoutError');
  });

  test('ProfilerError — has cause chain, message, instanceof Error', () => {
    const rootCause = new Error('DNS resolution failed');
    const error = new ProfilerError('Failed to profile site', rootCause);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProfilerError);
    expect(error.message).toBe('Failed to profile site');
    expect(error.cause).toBe(rootCause);
    expect(error.name).toBe('ProfilerError');
  });

  test('ProfilerError — works without cause', () => {
    const error = new ProfilerError('Generic profiler failure');

    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBeUndefined();
    expect(error.message).toBe('Generic profiler failure');
  });

  test('DecisionError — has code DECISION_FAILED, cause chain, message', () => {
    const rootCause = new Error('MongoDB connection refused');
    const error = new DecisionError('Failed to make crawl decision', 'DECISION_FAILED', rootCause);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DecisionError);
    expect(error.code).toBe('DECISION_FAILED');
    expect(error.message).toBe('Failed to make crawl decision');
    expect(error.cause).toBe(rootCause);
    expect(error.name).toBe('DecisionError');
  });

  test('DecisionError — works without cause', () => {
    const error = new DecisionError('No stores configured', 'NO_STORES');

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('NO_STORES');
    expect(error.cause).toBeUndefined();
  });
});
