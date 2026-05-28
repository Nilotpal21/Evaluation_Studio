/**
 * Query Pipeline LLM Resolver
 *
 * Resolves per-tenant LLM configuration for the query pipeline.
 * Caches the full resolver stack (client + DynamicVocabularyResolver + HybridSearchBuilder)
 * per tenantId:indexId so that DynamicVocabularyResolver's internal vocabulary and schema
 * LRU caches stay warm across requests.
 */

import { LRUCache } from 'lru-cache';
import { WorkerLLMClient } from '@agent-platform/llm';
import { DynamicVocabularyResolver } from './vocabulary/dynamic-vocabulary-resolver.js';
import { HybridSearchBuilder } from './hybrid-search/hybrid-search-builder.js';
import type {
  EmbeddingProvider,
  EmbeddingProviderResolver,
} from '@agent-platform/search-ai-internal/embedding';
import {
  resolveTenantModelById,
  resolveTenantModelWithFallback,
} from './llm-config/query-model-resolver.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('query-llm-resolver');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CachedQueryLLMStack {
  client: WorkerLLMClient;
  resolver: DynamicVocabularyResolver;
  builder: HybridSearchBuilder;
  modelDisplayName: string;
  resolution: 'pinned' | 'auto-selected';
}

// ─── Cache ────────────────────────────────────────────────────────────────────

// Sentinel value for "resolved but no model available" (LRUCache rejects null)
const NO_MODEL = Symbol('NO_MODEL');
type CacheEntry = CachedQueryLLMStack | typeof NO_MODEL;

// Cache the full stack per tenant+index. DynamicVocabularyResolver's internal
// vocabulary (5min TTL) and schema (10min TTL) caches stay warm across requests.
const resolverCache = new LRUCache<string, CacheEntry>({
  max: 500,
  ttl: 5 * 60 * 1000, // 5 min
});

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolve the per-tenant LLM stack for a KB's query pipeline.
 *
 * Returns cached stack if available (warm DynamicVocabularyResolver caches).
 * Returns null if no model is configured or available → pipeline uses static fallback.
 */
export async function resolveQueryLLMStack(
  tenantId: string,
  indexId: string,
  queryLLMConfig: { modelId: string | null; autoSelect: boolean; preferredTier: string } | null,
  embeddingProvider: EmbeddingProvider,
  embeddingProviderResolver?: EmbeddingProviderResolver,
): Promise<CachedQueryLLMStack | null> {
  const cacheKey = `${tenantId}:${indexId}`;

  const cached = resolverCache.get(cacheKey);
  if (cached !== undefined) {
    return cached === NO_MODEL ? null : cached;
  }

  if (!queryLLMConfig) {
    resolverCache.set(cacheKey, NO_MODEL);
    return null;
  }

  const { modelId, autoSelect, preferredTier } = queryLLMConfig;

  let resolvedModel: {
    modelId: string;
    provider: string;
    displayName: string;
    tier: string;
    apiKey: string;
  } | null = null;
  let resolution: 'pinned' | 'auto-selected' = 'auto-selected';

  try {
    if (modelId && !autoSelect) {
      // Pinned model
      resolvedModel = await resolveTenantModelById(tenantId, modelId);
      resolution = 'pinned';
    } else if (autoSelect) {
      // Auto-select best for preferred tier
      const tier = (preferredTier as 'fast' | 'balanced' | 'powerful') || 'fast';
      const result = await resolveTenantModelWithFallback(tenantId, tier);
      resolvedModel = result.model;
      resolution = 'auto-selected';
    }
  } catch (error) {
    logger.error('Failed to resolve tenant model for query pipeline', {
      tenantId,
      indexId,
      error: error instanceof Error ? error.message : String(error),
    });
    resolverCache.set(cacheKey, NO_MODEL);
    return null;
  }

  if (!resolvedModel) {
    logger.debug('No model available for query pipeline, using static fallback', {
      tenantId,
      indexId,
    });
    resolverCache.set(cacheKey, NO_MODEL);
    return null;
  }

  // Build the full stack
  const client = new WorkerLLMClient(
    resolvedModel.provider,
    resolvedModel.apiKey,
    resolvedModel.modelId,
  );
  const resolver = new DynamicVocabularyResolver(client);
  const builder = new HybridSearchBuilder(resolver, embeddingProvider, embeddingProviderResolver);

  const stack: CachedQueryLLMStack = {
    client,
    resolver,
    builder,
    modelDisplayName: resolvedModel.displayName,
    resolution,
  };

  logger.info('Resolved query pipeline LLM', {
    tenantId,
    indexId,
    model: resolvedModel.displayName,
    tier: resolvedModel.tier,
    resolution,
  });

  resolverCache.set(cacheKey, stack);
  return stack;
}

/**
 * Invalidate cached resolver for a specific tenant+index.
 * Call this when queryLLMConfig is updated via API.
 */
export function invalidateQueryLLMCache(tenantId: string, indexId: string): void {
  resolverCache.delete(`${tenantId}:${indexId}`);
}
