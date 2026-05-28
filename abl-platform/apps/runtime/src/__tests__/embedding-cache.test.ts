/**
 * Embedding Cache — Unit Tests
 *
 * Verifies Redis-backed embedding caching with:
 *   - Cache miss returns null
 *   - Cache hit returns parsed embedding vector
 *   - Set stores with correct key prefix, TTL, and serialized data
 *   - Graceful degradation on Redis errors (returns null, never throws)
 *   - Null Redis client handled safely
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Redis client
const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
};

vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: vi.fn(() => mockRedis),
  getRedisHandle: () => null,
}));

// Mock logger to suppress output
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { getCachedEmbedding, setCachedEmbedding } from '../services/cache/embedding-cache.js';
import { getRedisClient } from '../services/redis/redis-client.js';

describe('embedding cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to return mock redis by default
    vi.mocked(getRedisClient).mockReturnValue(mockRedis);
  });

  describe('getCachedEmbedding', () => {
    it('returns null on cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await getCachedEmbedding('test query', 'text-embedding-3-large');
      expect(result).toBeNull();
      expect(mockRedis.get).toHaveBeenCalledWith(
        expect.stringMatching(/^emb:text-embedding-3-large:[a-f0-9]{16}$/),
      );
    });

    it('returns cached embedding on hit', async () => {
      const embedding = [0.1, 0.2, 0.3, -0.5, 0.99];
      mockRedis.get.mockResolvedValue(JSON.stringify(embedding));
      const result = await getCachedEmbedding('test query', 'text-embedding-3-large');
      expect(result).toEqual(embedding);
    });

    it('produces same key for case/whitespace variations', async () => {
      mockRedis.get.mockResolvedValue(null);

      await getCachedEmbedding('Hello World', 'model-a');
      await getCachedEmbedding('  hello world  ', 'model-a');

      const [call1, call2] = mockRedis.get.mock.calls;
      expect(call1[0]).toBe(call2[0]);
    });

    it('returns null when Redis client is unavailable', async () => {
      vi.mocked(getRedisClient).mockReturnValue(null);
      const result = await getCachedEmbedding('test', 'model');
      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('returns null on Redis error (graceful degradation)', async () => {
      mockRedis.get.mockRejectedValue(new Error('connection refused'));
      const result = await getCachedEmbedding('test query', 'text-embedding-3-large');
      expect(result).toBeNull();
    });
  });

  describe('setCachedEmbedding', () => {
    it('stores embedding with correct key format and 1hr TTL', async () => {
      mockRedis.set.mockResolvedValue('OK');
      const embedding = [0.1, 0.2, 0.3];

      await setCachedEmbedding('test query', 'text-embedding-3-large', embedding);

      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^emb:text-embedding-3-large:[a-f0-9]{16}$/),
        JSON.stringify(embedding),
        'EX',
        3600,
      );
    });

    it('does not throw on Redis error', async () => {
      mockRedis.set.mockRejectedValue(new Error('connection refused'));
      // Should not throw
      await setCachedEmbedding('test', 'model', [0.1, 0.2]);
    });

    it('does nothing when Redis client is unavailable', async () => {
      vi.mocked(getRedisClient).mockReturnValue(null);
      await setCachedEmbedding('test', 'model', [0.1]);
      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });
});
