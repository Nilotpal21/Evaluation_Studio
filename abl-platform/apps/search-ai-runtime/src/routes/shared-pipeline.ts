/**
 * Shared Pipeline Builder
 *
 * Single entry point for resolving a per-tenant QueryPipeline.
 * Used by all search routes (/query, /similar, /structured, /aggregate).
 * Caches pipelines per tenant+index for 2 minutes.
 */

import { QueryPipeline, defaultQueryCache } from '../services/query/query-pipeline.js';
import { serviceContainer } from '../services/service-container.js';
import { resolveQueryLLMStack } from '../services/query-llm-resolver.js';
import { createLogger } from '@abl/compiler/platform';
import type { ISearchIndex } from '@agent-platform/database/models';
import { getLazyModel } from '../db/index.js';

const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
const logger = createLogger('shared-pipeline');

// ─── Pipeline cache ─────────────────────────────────────────────────────────

interface CachedPipeline {
  pipeline: QueryPipeline;
  queryIntelligenceDisabled: boolean;
  cachedAt: number;
}

const PIPELINE_CACHE_TTL_MS = 2 * 60 * 1000;
const PIPELINE_CACHE_MAX = 500;
const pipelineCache = new Map<string, CachedPipeline>();

let fallbackPipeline: QueryPipeline | null = null;
function getFallbackPipeline(): QueryPipeline {
  if (!fallbackPipeline) {
    fallbackPipeline = new QueryPipeline(
      serviceContainer.isInitialized() ? serviceContainer.getPipelineOptions() : undefined,
    );
  }
  return fallbackPipeline;
}

/** Invalidate cached pipeline for a specific tenant+index (call on config update). */
export function invalidatePipelineCache(tenantId: string, indexId: string): void {
  pipelineCache.delete(`${tenantId}:${indexId}`);
}

/**
 * Get a QueryPipeline for the given tenant+index.
 * Resolves per-tenant LLM config, caches the result.
 *
 * @returns A QueryPipeline wired with the correct embedding + LLM providers
 */
export async function getSharedPipeline(
  tenantId: string,
  indexId: string,
  verifiedIndex?: Record<string, unknown>,
): Promise<QueryPipeline> {
  const result = await buildPerTenantPipeline(tenantId, indexId, verifiedIndex);
  return result.pipeline;
}

/**
 * Get a QueryPipeline + queryIntelligenceDisabled flag.
 * Used by the /query route which needs to know whether to skip vocab resolution.
 */
export async function getSharedPipelineWithFlags(
  tenantId: string,
  indexId: string,
  verifiedIndex?: Record<string, unknown>,
): Promise<{ pipeline: QueryPipeline; queryIntelligenceDisabled: boolean }> {
  return buildPerTenantPipeline(tenantId, indexId, verifiedIndex);
}

async function buildPerTenantPipeline(
  tenantId: string,
  indexId: string,
  verifiedIndex?: Record<string, unknown>,
): Promise<{ pipeline: QueryPipeline; queryIntelligenceDisabled: boolean }> {
  const cacheKey = `${tenantId}:${indexId}`;
  const cached = pipelineCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < PIPELINE_CACHE_TTL_MS) {
    return {
      pipeline: cached.pipeline,
      queryIntelligenceDisabled: cached.queryIntelligenceDisabled,
    };
  }

  let queryLLMConfig: {
    enabled?: boolean;
    modelId: string | null;
    autoSelect: boolean;
    preferredTier: string;
  } | null = null;

  if (verifiedIndex) {
    queryLLMConfig = (verifiedIndex as any)?.queryLLMConfig ?? null;
  } else {
    try {
      const index = await SearchIndex.findOne({ _id: indexId, tenantId })
        .select('queryLLMConfig')
        .lean();
      queryLLMConfig = (index as any)?.queryLLMConfig ?? null;
    } catch {
      // Model may not be registered yet during startup
    }
  }

  const queryIntelligenceDisabled = queryLLMConfig?.enabled !== true;
  if (queryIntelligenceDisabled) {
    logger.info('Query Intelligence disabled for index, vocabulary resolution will be skipped', {
      indexId,
      tenantId,
    });
  }

  if (!serviceContainer.isInitialized()) {
    return { pipeline: getFallbackPipeline(), queryIntelligenceDisabled };
  }
  const baseOptions = serviceContainer.getPipelineOptions();

  const embeddingProvider = serviceContainer.getEmbeddingProvider();
  const llmStack = embeddingProvider
    ? await resolveQueryLLMStack(
        tenantId,
        indexId,
        queryLLMConfig,
        embeddingProvider,
        baseOptions.embeddingProviderResolver,
      )
    : null;

  let result: { pipeline: QueryPipeline; queryIntelligenceDisabled: boolean };

  if (llmStack && !queryIntelligenceDisabled) {
    result = {
      pipeline: new QueryPipeline({
        ...baseOptions,
        dynamicVocabularyResolver: llmStack.resolver,
        hybridSearchBuilder: llmStack.builder,
        queryCache: defaultQueryCache,
      }),
      queryIntelligenceDisabled,
    };
  } else {
    result = {
      pipeline: new QueryPipeline({ ...baseOptions, queryCache: defaultQueryCache }),
      queryIntelligenceDisabled,
    };
  }

  if (pipelineCache.size >= PIPELINE_CACHE_MAX) {
    const oldest = pipelineCache.keys().next().value;
    if (oldest !== undefined) pipelineCache.delete(oldest);
  }
  pipelineCache.delete(cacheKey);
  pipelineCache.set(cacheKey, { ...result, cachedAt: Date.now() });

  return result;
}
