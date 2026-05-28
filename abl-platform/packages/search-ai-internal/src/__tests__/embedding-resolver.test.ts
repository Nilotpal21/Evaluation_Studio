/**
 * Unit tests for EmbeddingProviderResolver
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingProviderResolver } from '../embedding/resolver.js';
import type { EmbeddingConfigSource, EmbeddingCredentialSource } from '../embedding/resolver.js';

// ─── Mocks ───────────────────────────────────────────────────────────────

const mockGetConfig = vi.fn<(kbId: string, tenantId: string) => Promise<EmbeddingConfigSource>>();
const mockResolveCredentials =
  vi.fn<(provider: string, tenantId: string) => Promise<EmbeddingCredentialSource>>();

function createResolver(options?: { maxCacheSize?: number; cacheTtlMs?: number }) {
  return new EmbeddingProviderResolver(mockGetConfig, mockResolveCredentials, options);
}

beforeEach(() => {
  vi.clearAllMocks();

  mockGetConfig.mockResolvedValue({
    provider: 'bge-m3',
    model: 'bge-m3',
    dimensions: 1024,
    providerConfig: { baseUrl: 'http://bge-m3:8000' },
  });

  mockResolveCredentials.mockResolvedValue({
    apiKey: '',
    source: 'none',
  });
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('EmbeddingProviderResolver', () => {
  it('resolves a provider from pipeline config', async () => {
    const resolver = createResolver();
    const provider = await resolver.resolveProvider('kb-1', 'tenant-1');

    expect(provider).toBeDefined();
    expect(provider.name).toBe('bge-m3');
    expect(mockGetConfig).toHaveBeenCalledWith('kb-1', 'tenant-1');
    expect(mockResolveCredentials).toHaveBeenCalledWith('bge-m3', 'tenant-1');
  });

  it('caches resolved providers', async () => {
    const resolver = createResolver();

    await resolver.resolveProvider('kb-1', 'tenant-1');
    await resolver.resolveProvider('kb-1', 'tenant-1');

    expect(mockGetConfig).toHaveBeenCalledTimes(1);
    expect(mockResolveCredentials).toHaveBeenCalledTimes(1);
  });

  it('resolves different providers for different KBs', async () => {
    const resolver = createResolver();

    mockGetConfig.mockResolvedValueOnce({
      provider: 'bge-m3',
      model: 'bge-m3',
      dimensions: 1024,
    });
    mockGetConfig.mockResolvedValueOnce({
      provider: 'bge-m3',
      model: 'bge-m3',
      dimensions: 1024,
    });

    await resolver.resolveProvider('kb-1', 'tenant-1');
    await resolver.resolveProvider('kb-2', 'tenant-1');

    expect(mockGetConfig).toHaveBeenCalledTimes(2);
  });

  it('invalidates cache for a specific KB', async () => {
    const resolver = createResolver();

    await resolver.resolveProvider('kb-1', 'tenant-1');
    resolver.invalidate('kb-1', 'tenant-1');
    await resolver.resolveProvider('kb-1', 'tenant-1');

    expect(mockGetConfig).toHaveBeenCalledTimes(2);
  });

  it('invalidates cache for entire tenant', async () => {
    const resolver = createResolver();

    await resolver.resolveProvider('kb-1', 'tenant-1');
    await resolver.resolveProvider('kb-2', 'tenant-1');

    resolver.invalidateTenant('tenant-1');

    await resolver.resolveProvider('kb-1', 'tenant-1');
    await resolver.resolveProvider('kb-2', 'tenant-1');

    // 2 initial + 2 after invalidation
    expect(mockGetConfig).toHaveBeenCalledTimes(4);
  });

  it('does not invalidate other tenants', async () => {
    const resolver = createResolver();

    await resolver.resolveProvider('kb-1', 'tenant-1');
    await resolver.resolveProvider('kb-1', 'tenant-2');

    resolver.invalidateTenant('tenant-1');

    // tenant-2 should still be cached
    await resolver.resolveProvider('kb-1', 'tenant-2');
    expect(mockGetConfig).toHaveBeenCalledTimes(2); // Only 2 initial calls
  });

  it('passes credentials to factory for openai provider', async () => {
    mockGetConfig.mockResolvedValue({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
    mockResolveCredentials.mockResolvedValue({
      apiKey: 'sk-test-key',
      source: 'llm-credential',
    });

    const resolver = createResolver();
    const provider = await resolver.resolveProvider('kb-1', 'tenant-1');

    expect(provider).toBeDefined();
    expect(provider.name).toBe('openai');
    expect(mockResolveCredentials).toHaveBeenCalledWith('openai', 'tenant-1');
  });

  it('clears all cached providers', async () => {
    const resolver = createResolver();

    await resolver.resolveProvider('kb-1', 'tenant-1');
    await resolver.resolveProvider('kb-2', 'tenant-1');

    resolver.clear();

    expect(resolver.getCacheStats().size).toBe(0);
  });

  it('reports cache statistics', async () => {
    const resolver = createResolver({ maxCacheSize: 50 });

    expect(resolver.getCacheStats()).toEqual({ size: 0, maxSize: 50 });

    await resolver.resolveProvider('kb-1', 'tenant-1');

    expect(resolver.getCacheStats()).toEqual({ size: 1, maxSize: 50 });
  });

  it('propagates config fetch errors', async () => {
    mockGetConfig.mockRejectedValue(new Error('Pipeline not found'));

    const resolver = createResolver();

    await expect(resolver.resolveProvider('kb-1', 'tenant-1')).rejects.toThrow(
      'Pipeline not found',
    );
  });
});
