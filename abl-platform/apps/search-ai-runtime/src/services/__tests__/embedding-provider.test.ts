import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getEmbeddingProvider, closeEmbeddingProvider } from '../embedding/provider.js';
import { CachedEmbeddingProvider } from '../embedding/cached-provider.js';
import type { EmbeddingProvider } from '@agent-platform/search-ai-internal/embedding';

// ─── Mock createEmbeddingProvider ───────────────────────────────────────

vi.mock('@agent-platform/search-ai-internal/embedding', () => ({
  createEmbeddingProvider: vi.fn((config) => ({
    name: `${config.provider}-mock`,
    modelId: config.model,
    dimensions: config.dimensions || 1024,
    maxBatchSize: config.maxBatchSize || 32,
    embed: vi.fn().mockResolvedValue(new Array(config.dimensions || 1024).fill(0.5)),
    embedBatch: vi.fn().mockResolvedValue({
      embeddings: [[0.1], [0.2]],
      totalTokens: 10,
      model: config.model,
      dimensions: config.dimensions || 1024,
    }),
    estimateTokens: vi.fn().mockReturnValue(5),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 50 }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ─── Tests ───────────────────────────────────────────────────────────────

describe('EmbeddingProvider Factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment variables
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_API_URL;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_DIMENSIONS;
    delete process.env.EMBEDDING_MAX_BATCH_SIZE;
    delete process.env.EMBEDDING_TIMEOUT;
  });

  afterEach(async () => {
    await closeEmbeddingProvider();
  });

  describe('getEmbeddingProvider', () => {
    it('creates singleton instance with defaults', () => {
      const provider1 = getEmbeddingProvider();
      const provider2 = getEmbeddingProvider();

      expect(provider1).toBe(provider2); // Same instance
      expect(provider1.name).toBe('bge-m3-mock'); // Default provider
      expect(provider1.dimensions).toBe(1024);
    });

    it('uses environment variable configuration', () => {
      process.env.EMBEDDING_PROVIDER = 'openai';
      process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
      process.env.EMBEDDING_DIMENSIONS = '1536';

      const provider = getEmbeddingProvider();

      expect(provider.name).toBe('openai-mock');
      expect(provider.modelId).toBe('text-embedding-3-small');
      expect(provider.dimensions).toBe(1536);
    });

    it('uses default BGE-M3 when no provider specified', () => {
      const provider = getEmbeddingProvider();

      expect(provider.name).toBe('bge-m3-mock');
      expect(provider.modelId).toBe('BAAI/bge-m3');
    });
  });

  describe('closeEmbeddingProvider', () => {
    it('closes provider and clears singleton', async () => {
      const provider = getEmbeddingProvider();
      await closeEmbeddingProvider();

      // Provider should have close called
      expect(provider.close).toHaveBeenCalled();

      // New provider should be created
      const newProvider = getEmbeddingProvider();
      expect(newProvider).not.toBe(provider);
    });

    it('handles provider without close method', async () => {
      const provider = getEmbeddingProvider();
      delete (provider as any).close;

      await expect(closeEmbeddingProvider()).resolves.not.toThrow();
    });
  });
});

describe('CachedEmbeddingProvider', () => {
  let delegateProvider: EmbeddingProvider;
  let cachedProvider: CachedEmbeddingProvider;

  beforeEach(() => {
    delegateProvider = {
      name: 'test-provider',
      modelId: 'test-model',
      dimensions: 1024,
      maxBatchSize: 32,
      embed: vi.fn().mockResolvedValue(new Array(1024).fill(0.5)),
      embedBatch: vi.fn().mockResolvedValue({
        embeddings: [new Array(1024).fill(0.1), new Array(1024).fill(0.2)],
        totalTokens: 10,
        model: 'test-model',
        dimensions: 1024,
      }),
      estimateTokens: vi.fn().mockReturnValue(5),
      healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 50 }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    cachedProvider = new CachedEmbeddingProvider(delegateProvider, {
      maxSize: 100,
      ttlMs: 1000 * 60 * 5, // 5 minutes
    });
  });

  describe('constructor', () => {
    it('initializes with delegate provider', () => {
      expect(cachedProvider.name).toBe('cached-test-provider');
      expect(cachedProvider.modelId).toBe('test-model');
      expect(cachedProvider.dimensions).toBe(1024);
      expect(cachedProvider.maxBatchSize).toBe(32);
    });

    it('uses default cache options', () => {
      const defaultCached = new CachedEmbeddingProvider(delegateProvider);
      const stats = defaultCached.getCacheStats();

      expect(stats.maxSize).toBe(1000); // Default max size
    });
  });

  describe('embed', () => {
    it('calls delegate on cache miss', async () => {
      const embedding = await cachedProvider.embed('test query');

      expect(delegateProvider.embed).toHaveBeenCalledWith('test query');
      expect(embedding).toHaveLength(1024);
    });

    it('returns cached result on cache hit', async () => {
      // First call - cache miss
      await cachedProvider.embed('test query');
      expect(delegateProvider.embed).toHaveBeenCalledTimes(1);

      // Second call - cache hit
      const cachedResult = await cachedProvider.embed('test query');
      expect(delegateProvider.embed).toHaveBeenCalledTimes(1); // Not called again
      expect(cachedResult).toHaveLength(1024);
    });

    it('caches different queries separately', async () => {
      await cachedProvider.embed('query 1');
      await cachedProvider.embed('query 2');

      expect(delegateProvider.embed).toHaveBeenCalledTimes(2);

      const stats = cachedProvider.getCacheStats();
      expect(stats.size).toBe(2);
    });
  });

  describe('embedBatch', () => {
    it('calls delegate for all texts on first call', async () => {
      const result = await cachedProvider.embedBatch(['text 1', 'text 2']);

      expect(delegateProvider.embedBatch).toHaveBeenCalledWith(['text 1', 'text 2']);
      expect(result.embeddings).toHaveLength(2);
      expect(result.totalTokens).toBe(10);
    });

    it('uses cache for already embedded texts', async () => {
      // First batch
      await cachedProvider.embedBatch(['text 1', 'text 2']);
      expect(delegateProvider.embedBatch).toHaveBeenCalledTimes(1);

      // Second batch with one overlapping text
      await cachedProvider.embedBatch(['text 1', 'text 3']);

      // Should only call delegate with new text
      expect(delegateProvider.embedBatch).toHaveBeenCalledTimes(2);
      expect(delegateProvider.embedBatch).toHaveBeenLastCalledWith(['text 3']);
    });

    it('returns all cached when no new texts', async () => {
      // First batch
      await cachedProvider.embedBatch(['text 1', 'text 2']);

      // Second batch with same texts
      const result = await cachedProvider.embedBatch(['text 1', 'text 2']);

      // Should not call delegate again
      expect(delegateProvider.embedBatch).toHaveBeenCalledTimes(1);
      expect(result.embeddings).toHaveLength(2);
      expect(result.totalTokens).toBe(0); // All from cache
    });

    it('handles empty batch', async () => {
      const result = await cachedProvider.embedBatch([]);

      expect(delegateProvider.embedBatch).not.toHaveBeenCalled();
      expect(result.embeddings).toHaveLength(0);
      expect(result.totalTokens).toBe(0);
    });
  });

  describe('delegation methods', () => {
    it('delegates estimateTokens', () => {
      const tokens = cachedProvider.estimateTokens('test text');

      expect(delegateProvider.estimateTokens).toHaveBeenCalledWith('test text');
      expect(tokens).toBe(5);
    });

    it('delegates healthCheck', async () => {
      const health = await cachedProvider.healthCheck();

      expect(delegateProvider.healthCheck).toHaveBeenCalled();
      expect(health.ok).toBe(true);
      expect(health.latencyMs).toBe(50);
    });
  });

  describe('cache management', () => {
    it('returns cache statistics', () => {
      const stats = cachedProvider.getCacheStats();

      expect(stats.size).toBe(0);
      expect(stats.maxSize).toBe(100);
    });

    it('updates cache size after embeddings', async () => {
      await cachedProvider.embed('query 1');
      await cachedProvider.embed('query 2');

      const stats = cachedProvider.getCacheStats();
      expect(stats.size).toBe(2);
    });

    it('clears cache', async () => {
      await cachedProvider.embed('query 1');
      await cachedProvider.embed('query 2');

      cachedProvider.clearCache();

      const stats = cachedProvider.getCacheStats();
      expect(stats.size).toBe(0);
    });

    it('requires delegate calls after cache clear', async () => {
      await cachedProvider.embed('query 1');
      expect(delegateProvider.embed).toHaveBeenCalledTimes(1);

      cachedProvider.clearCache();

      await cachedProvider.embed('query 1');
      expect(delegateProvider.embed).toHaveBeenCalledTimes(2); // Called again
    });
  });

  describe('close', () => {
    it('closes delegate and clears cache', async () => {
      await cachedProvider.embed('query 1');

      await cachedProvider.close();

      expect(delegateProvider.close).toHaveBeenCalled();

      const stats = cachedProvider.getCacheStats();
      expect(stats.size).toBe(0);
    });

    it('handles delegate without close method', async () => {
      delete (delegateProvider as any).close;

      await expect(cachedProvider.close()).resolves.not.toThrow();

      const stats = cachedProvider.getCacheStats();
      expect(stats.size).toBe(0);
    });
  });

  describe('cache eviction', () => {
    it('respects max cache size', async () => {
      const smallCache = new CachedEmbeddingProvider(delegateProvider, {
        maxSize: 2,
      });

      await smallCache.embed('query 1');
      await smallCache.embed('query 2');
      await smallCache.embed('query 3'); // Should evict oldest

      const stats = smallCache.getCacheStats();
      expect(stats.size).toBeLessThanOrEqual(2);
    });
  });
});
