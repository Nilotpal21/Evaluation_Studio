/**
 * Embedding Provider Resolver
 *
 * Resolves and caches embedding providers per knowledge base.
 * Uses dependency injection for pipeline config and credential resolution
 * to avoid coupling a shared package to app-level code.
 *
 * Usage:
 * ```typescript
 * const resolver = new EmbeddingProviderResolver(
 *   (kbId, tenantId) => getActiveEmbeddingConfig(kbId, tenantId),
 *   (provider, tenantId) => resolveEmbeddingCredentials(provider, tenantId),
 * );
 *
 * const provider = await resolver.resolveProvider('kb-123', 'tenant-456');
 * const embedding = await provider.embed('query text');
 * ```
 *
 * Reference: docs/searchai/pipelines/design/backend/04-CONFIGURABLE-EMBEDDING-PROVIDERS.md
 */

import type { EmbeddingProvider } from './interface.js';
import { createEmbeddingProvider, type EmbeddingFactoryConfig } from './factory.js';

// ─── TTL Cache ───────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Simple Map-based cache with TTL and max size eviction.
 * Avoids adding lru-cache as a dependency to this shared package.
 */
class TTLCache<T> {
  private entries = new Map<string, CacheEntry<T>>();
  readonly max: number;
  private readonly ttlMs: number;

  constructor(max: number, ttlMs: number) {
    this.max = max;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    // Evict oldest entry if at max capacity
    if (this.entries.size >= this.max && !this.entries.has(key)) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey !== undefined) this.entries.delete(firstKey);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

// ─── Types ───────────────────────────────────────────────────────────────

export interface EmbeddingConfigSource {
  provider: string;
  model: string;
  dimensions?: number;
  providerConfig?: Record<string, unknown>;
}

export interface EmbeddingCredentialSource {
  apiKey: string;
  source: 'llm-credential' | 'env-var' | 'none';
}

export type GetPipelineConfigFn = (
  kbId: string,
  tenantId: string,
) => Promise<EmbeddingConfigSource>;

export type ResolveCredentialsFn = (
  provider: string,
  tenantId: string,
) => Promise<EmbeddingCredentialSource>;

export interface EmbeddingProviderResolverOptions {
  /** Maximum cached providers (default: 100) */
  maxCacheSize?: number;
  /** Cache TTL in milliseconds (default: 10 minutes) */
  cacheTtlMs?: number;
  /**
   * Fallback base URL when pipeline config has no providerConfig.baseUrl.
   * Without this, self-hosted providers (BGE-M3) default to http://localhost:8000
   * which fails in Kubernetes where BGE-M3 runs in a separate pod.
   */
  baseUrlFallback?: string;
}

// ─── Resolver ────────────────────────────────────────────────────────────

export class EmbeddingProviderResolver {
  private cache: TTLCache<EmbeddingProvider>;
  private readonly baseUrlFallback?: string;

  constructor(
    private readonly getPipelineConfig: GetPipelineConfigFn,
    private readonly resolveCredentials: ResolveCredentialsFn,
    options?: EmbeddingProviderResolverOptions,
  ) {
    this.cache = new TTLCache(
      options?.maxCacheSize ?? 100,
      options?.cacheTtlMs ?? 10 * 60 * 1000, // 10 minutes
    );
    this.baseUrlFallback = options?.baseUrlFallback;
  }

  /**
   * Resolve an embedding provider for a knowledge base.
   *
   * Reads activeEmbeddingConfig from the pipeline, resolves credentials,
   * creates the provider via factory, and caches the result.
   *
   * @param kbId - Knowledge base ID
   * @param tenantId - Tenant ID (for credential resolution)
   * @returns Configured embedding provider
   */
  async resolveProvider(kbId: string, tenantId: string): Promise<EmbeddingProvider> {
    const cacheKey = `${tenantId}:${kbId}`;

    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Fetch active embedding config from pipeline
    const config = await this.getPipelineConfig(kbId, tenantId);

    // Resolve credentials (returns empty apiKey for self-hosted providers)
    const credentials = await this.resolveCredentials(config.provider, tenantId);

    // Resolve baseUrl: pipeline config → provider-specific fallback → undefined (factory default)
    // CRITICAL: baseUrlFallback is the BGE-M3 service URL (EMBEDDING_API_URL / EMBEDDING_BASE_URL).
    // Only apply it for bge-m3 — applying it to openai/cohere sends API calls to the
    // BGE-M3 Flask server which returns 404, causing dimension mismatch fallback.
    const pipelineBaseUrl = config.providerConfig?.baseUrl as string | undefined;
    const resolvedBaseUrl =
      pipelineBaseUrl || (config.provider === 'bge-m3' ? this.baseUrlFallback : undefined);

    // Create provider instance via existing factory
    const factoryConfig: EmbeddingFactoryConfig = {
      provider: config.provider as EmbeddingFactoryConfig['provider'],
      model: config.model,
      dimensions: config.dimensions,
      apiKey: credentials.apiKey || undefined,
      baseUrl: resolvedBaseUrl,
      maxBatchSize: config.providerConfig?.maxBatchSize as number | undefined,
      timeoutMs: config.providerConfig?.timeoutMs as number | undefined,
      // Azure-specific fields — without these, AzureOpenAIEmbeddingProvider
      // throws "requires resourceName" and query-time embedding fails.
      resourceName: config.providerConfig?.resourceName as string | undefined,
      deploymentId: config.providerConfig?.deploymentId as string | undefined,
      apiVersion: config.providerConfig?.apiVersion as string | undefined,
    };

    const provider = createEmbeddingProvider(factoryConfig);

    this.cache.set(cacheKey, provider);
    return provider;
  }

  /**
   * Invalidate cached provider for a knowledge base.
   *
   * Call when activeEmbeddingConfig changes to force re-resolution.
   */
  invalidate(kbId: string, tenantId: string): void {
    const cacheKey = `${tenantId}:${kbId}`;
    this.cache.delete(cacheKey);
  }

  /**
   * Invalidate all cached providers for a tenant.
   *
   * Useful when tenant-level credentials change.
   */
  invalidateTenant(tenantId: string): void {
    const prefix = `${tenantId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear all cached providers.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics for monitoring.
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.cache.max,
    };
  }
}
