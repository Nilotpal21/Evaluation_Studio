/**
 * SearchAI Runtime Configuration
 *
 * Thin wrapper around @agent-platform/config.
 * Composes the base config schema with search-ai-runtime-specific extensions.
 */

import { z } from 'zod';
import {
  composeConfigSchema,
  createConfigLoader,
  validateProductionConfig,
  type BaseAppConfig,
} from '@agent-platform/config';

// =============================================================================
// SEARCH-AI-RUNTIME-SPECIFIC EXTENSIONS
// =============================================================================

const QueryConfigSchema = z.object({
  /** Default number of results to return */
  defaultTopK: z.coerce.number().int().positive().default(10),
  /** Maximum allowed topK value */
  maxTopK: z.coerce.number().int().positive().default(100),
  /** Query timeout in milliseconds */
  timeoutMs: z.coerce.number().int().positive().default(10_000),
  /** Whether to enable query caching */
  cacheEnabled: z.boolean().default(true),
  /** Cache TTL in seconds */
  cacheTtlSeconds: z.coerce.number().int().positive().default(300),
});

const RerankerConfigSchema = z.object({
  /** Reranker provider (e.g., 'cohere', 'cross-encoder') */
  provider: z.string().default('cohere'),
  /** Reranker model identifier */
  model: z.string().default('rerank-english-v3.0'),
  /** Whether reranking is enabled */
  enabled: z.boolean().default(false),
});

// =============================================================================
// COMPOSED SCHEMA
// =============================================================================

export const SearchAIRuntimeConfigSchema = composeConfigSchema({
  query: QueryConfigSchema.default({}),
  reranker: RerankerConfigSchema.default({}),
});

export type SearchAIRuntimeConfig = z.infer<typeof SearchAIRuntimeConfigSchema>;

// =============================================================================
// CONFIG LOADER
// =============================================================================

const SEARCH_AI_RUNTIME_ENV_MAPPING = {
  // Query
  SEARCH_DEFAULT_TOP_K: 'query.defaultTopK',
  SEARCH_MAX_TOP_K: 'query.maxTopK',
  SEARCH_TIMEOUT_MS: 'query.timeoutMs',
  SEARCH_CACHE_ENABLED: 'query.cacheEnabled',
  SEARCH_CACHE_TTL_SECONDS: 'query.cacheTtlSeconds',

  // Reranker
  RERANKER_PROVIDER: 'reranker.provider',
  RERANKER_MODEL: 'reranker.model',
  RERANKER_ENABLED: 'reranker.enabled',
};

function logSearchAIRuntimeConfigSummary(cfg: unknown): void {
  const c = cfg as SearchAIRuntimeConfig;
  console.log(`
[Config] SearchAI Runtime configuration loaded:
  Environment:     ${c.env}
  Server:          ${c.server.host}:${c.server.port}
  Database:        ${c.database.url ? 'configured' : 'not configured'}
  Redis:           ${c.redis.enabled ? `enabled (${c.redis.url || 'localhost'})` : 'disabled'}
  Query:           topK=${c.query.defaultTopK}, max=${c.query.maxTopK}, timeout=${c.query.timeoutMs}ms
  Cache:           ${c.query.cacheEnabled ? `enabled (TTL: ${c.query.cacheTtlSeconds}s)` : 'disabled'}
  Reranker:        ${c.reranker.enabled ? `${c.reranker.provider}/${c.reranker.model}` : 'disabled'}
`);
}

const loader = createConfigLoader(SearchAIRuntimeConfigSchema, {
  envMapping: SEARCH_AI_RUNTIME_ENV_MAPPING,
  productionChecks: (cfg) => validateProductionConfig(cfg as BaseAppConfig).map((w) => w.message),
  logSummary: logSearchAIRuntimeConfigSummary,
});

export const loadConfig = loader.loadConfig;
export const getConfig = loader.getConfig;
export const isConfigLoaded = loader.isConfigLoaded;
export const reloadConfig = loader.reloadConfig;
export const getConfigMeta = loader.getConfigMeta;
