import { describe, test, expect, vi, beforeEach } from 'vitest';

let mockRedisRef: { keys: ReturnType<typeof vi.fn> } | null = null;

// Stub `scanKeys` so it yields whatever the test's `mockRedis.keys` returns —
// production code uses `for await (const k of scanKeys(client, pattern))`.
vi.mock('@agent-platform/redis', () => ({
  scanKeys: async function* (_client: unknown, pattern: string): AsyncIterable<string> {
    if (!mockRedisRef) return;
    const keys: string[] = await mockRedisRef.keys(pattern);
    for (const k of keys) yield k;
  },
}));

const { AnalyticsCache } = await import('../pipeline/services/analytics-cache.js');

function makeOpts(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    pipelineType: 'sentiment_analysis',
    queryType: 'summary',
    params: { period: '7d' },
    ...overrides,
  };
}

describe('AnalyticsCache', () => {
  let mockRedis: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    keys: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockRedis = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      keys: vi.fn(),
    };
    mockRedisRef = mockRedis;
  });

  test('returns null when redis is null', async () => {
    const cache = new AnalyticsCache(null);
    const result = await cache.get(makeOpts());
    expect(result).toBeNull();
  });

  test('returns null on cache miss', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    const cache = new AnalyticsCache(mockRedis);

    const result = await cache.get(makeOpts());

    expect(result).toBeNull();
    expect(mockRedis.get).toHaveBeenCalledTimes(1);
  });

  test('returns cached data on hit', async () => {
    const data = { avgScore: 4.2, count: 100 };
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(data));
    const cache = new AnalyticsCache(mockRedis);

    const result = await cache.get(makeOpts());

    expect(result).toEqual(data);
  });

  test('sets cached data with correct TTL for summary', async () => {
    mockRedis.set.mockResolvedValueOnce('OK');
    const cache = new AnalyticsCache(mockRedis);
    const data = { avgScore: 4.2 };

    await cache.set(makeOpts(), data);

    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('analytics:tenant-1:proj-1:sentiment_analysis:summary:'),
      JSON.stringify(data),
      'EX',
      300,
    );
  });

  test('sets cached data with correct TTL for conversation', async () => {
    mockRedis.set.mockResolvedValueOnce('OK');
    const cache = new AnalyticsCache(mockRedis);

    await cache.set(makeOpts({ queryType: 'conversation' }), { scores: [] });

    expect(mockRedis.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'EX', 3600);
  });

  test('invalidate removes matching keys', async () => {
    const keys = ['analytics:tenant-1:proj-1:sentiment_analysis:summary:abc123'];
    mockRedis.keys.mockResolvedValueOnce(keys);
    mockRedis.del.mockResolvedValueOnce(1);
    const cache = new AnalyticsCache(mockRedis);

    await cache.invalidate('tenant-1', 'proj-1', 'sentiment_analysis');

    expect(mockRedis.keys).toHaveBeenCalledWith('analytics:tenant-1:proj-1:sentiment_analysis:*');
    // Per-key del (cluster-safe)
    expect(mockRedis.del).toHaveBeenCalledWith(keys[0]);
  });

  test('get fails open on redis error', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('Connection refused'));
    const cache = new AnalyticsCache(mockRedis);

    const result = await cache.get(makeOpts());

    expect(result).toBeNull();
  });

  test('set fails open on redis error', async () => {
    mockRedis.set.mockRejectedValueOnce(new Error('Connection refused'));
    const cache = new AnalyticsCache(mockRedis);

    // Should not throw
    await cache.set(makeOpts(), { data: 'test' });
  });

  test('different params produce different cache keys', async () => {
    mockRedis.get.mockResolvedValue(null);
    const cache = new AnalyticsCache(mockRedis);

    await cache.get(makeOpts({ params: { period: '7d' } }));
    await cache.get(makeOpts({ params: { period: '30d' } }));

    const key1 = mockRedis.get.mock.calls[0][0];
    const key2 = mockRedis.get.mock.calls[1][0];
    expect(key1).not.toBe(key2);
  });
});
