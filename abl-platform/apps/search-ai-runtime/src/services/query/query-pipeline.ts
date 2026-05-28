/**
 * Query Pipeline Orchestrator (RFC-003)
 *
 * Unified pipeline supporting all 4 query types:
 * structured, semantic, hybrid, aggregation
 *
 * **Pipeline Stages:**
 * Stage 0: Permission Filter (always first - security gate)
 * Stage 1: Preprocessing (conditional - skip for agent flow)
 * Stage 2: Vocabulary Resolution + Query Type Classification (conditional)
 * Stage 2.5: Alias Resolution (always - resolves alias names → OpenSearch paths + enum coercion)
 * Stage 2.6: Doc-ID Filter (optional - Browse SDK facet-to-document scoping)
 * Stage 3: Build + Execute Search (HybridSearchBuilder → OpenSearch)
 * Stage 4: Rerank (optional - semantic/hybrid only)
 * Stage 5: Metrics & Cost (always)
 *
 * **Two Flows:**
 * - Agent flow: skipPreprocessing=true, skipVocabularyResolution=true, queryType+filters provided
 * - Direct flow: raw query, auto-classification via LLM or heuristic
 */

import type { SearchResult, AggregationResult } from '@agent-platform/search-ai-sdk';
import type { EmbeddingProvider } from '@agent-platform/search-ai-internal/embedding';
import type { EmbeddingProviderResolver } from '@agent-platform/search-ai-internal/embedding';
import type { VectorStoreProvider } from '@agent-platform/search-ai-internal/vector-store';
import { VocabularyResolver, getVocabularyResolver } from '../vocabulary/vocabulary-resolver.js';
import type {
  DynamicVocabularyResolver,
  DynamicResolutionResult,
} from '../vocabulary/dynamic-vocabulary-resolver.js';
import type { HybridSearchBuilder } from '../hybrid-search/hybrid-search-builder.js';
import { RerankerFactory } from '../rerank/reranker-factory.js';
import { BatchedRerankerFactory } from '../rerank/batched-reranker-factory.js';
import type { CallerContext } from '../rerank/batch-types.js';
import { queryMetricsStore, type QueryMetrics } from '../metrics/query-metrics.js';
import { StructuredLogger } from '../metrics/structured-logger.js';
import { costCalculator, type QueryCostBreakdown } from '../cost/cost-calculator.js';
import { preprocessingClient, type PreprocessingClient } from '../preprocessing/index.js';
import { getPermissionFilterService } from './permission-filter-service.js';
import type { AliasResolver } from '../alias/alias-resolver.js';
import { AVAILABLE_CANONICAL_FIELDS } from '@agent-platform/search-ai-internal/canonical';
import { getGlobalRedisClient } from '../cache/redis-client.js';
import type { AuthMode } from '../../middleware/permission-filter.middleware.js';
import type { UserIdentity } from '../idp/idp-token-validator.js';
import type {
  UnifiedSearchQuery,
  UnifiedSearchResponse,
  UnifiedQueryType,
  UnifiedSearchLatency,
  PipelineDebugTrace,
  PipelineStageTrace,
} from './types.js';
import { DOC_ID_THRESHOLD } from '../browse/types.js';
import { toClickHouseDateTime } from '@agent-platform/database/clickhouse';
import { LRUCache } from 'lru-cache';
import { createHash, createHmac } from 'crypto';
import { getModel, getLazyModel } from '../../db/index.js';
import type { ISearchDocument } from '@agent-platform/database/models';
import { getQueryStore } from '../stores/query-store-singleton.js';
import { QueryCache } from './query-cache.js';
import { getConfig } from '../../config/index.js';

// ─── Design-Time Download URL Generation ─────────────────────────────────────
// Generates HMAC-signed download URLs for uploaded documents so they are
// accessible in Studio's browse/preview views (design time).
// Same pattern as search-ai's document-download.ts — 15-minute signed token.
const DESIGN_DOWNLOAD_TOKEN_EXPIRY_MS = 15 * 60 * 1000;

function generateDesignDownloadToken(documentId: string, tenantId: string, secret: string): string {
  const exp = Date.now() + DESIGN_DOWNLOAD_TOKEN_EXPIRY_MS;
  const payload = JSON.stringify({ documentId, tenantId, exp });
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64url') + '.' + signature;
}

function buildDesignDownloadUrl(documentId: string, token: string): string {
  const publicUrl = process.env.SEARCH_AI_PUBLIC_URL;
  if (publicUrl) {
    return `${publicUrl}/documents/${documentId}/download?token=${token}`;
  }
  const baseUrl = process.env.SEARCH_AI_URL || 'http://localhost:3005';
  return `${baseUrl}/api/documents/${documentId}/download?token=${token}`;
}

// =============================================================================
// QUERY CACHE KEY
// =============================================================================

/**
 * Fields on UnifiedSearchQuery that do NOT affect search results and should
 * be excluded from the cache key. Everything else is included automatically,
 * so new fields added to UnifiedSearchQuery are cache-safe by default
 * (worst case: lower hit rate, never incorrect results).
 */
const CACHE_KEY_EXCLUDED_FIELDS: ReadonlySet<string> = new Set([
  'debug', // Already gated — debug queries bypass cache entirely
]);

/**
 * Build a deterministic, collision-resistant cache key from the full query
 * context. Uses SHA-256 to keep keys compact in Redis/memory.
 *
 * Includes:
 *  - All UnifiedSearchQuery fields (minus CACHE_KEY_EXCLUDED_FIELDS)
 *  - authMode (public vs user — different permission filters)
 *  - userIdentity hash when authMode='user' (per-user permission results)
 *
 * New fields added to UnifiedSearchQuery are automatically included.
 */
export function buildQueryCacheKey(
  query: UnifiedSearchQuery,
  authMode: AuthMode | undefined,
  userIdentity?: UserIdentity,
): string {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!CACHE_KEY_EXCLUDED_FIELDS.has(key) && value !== undefined) {
      payload[key] = value;
    }
  }
  payload._authMode = authMode ?? 'public';

  // Per-user scoping: when authMode='user', permission filter results are
  // user-specific. Without this, User A's results could leak to User B.
  if (authMode === 'user' && userIdentity?.idpUserId) {
    payload._userId = userIdentity.idpUserId;
  }

  // Deterministic JSON (sorted keys at every depth) → SHA-256 → hex.
  // NOTE: A replacer *array* only includes keys present in the array at ALL
  // nesting levels, which strips nested object properties (e.g. filter
  // {field, operator, value} becomes {}). Use a recursive sort instead.
  const json = JSON.stringify(payload, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
  return createHash('sha256').update(json).digest('hex');
}

// =============================================================================
// MODULE-LEVEL SINGLETONS
// =============================================================================

/**
 * Shared collection name cache — module-level singleton so it persists across
 * QueryPipeline instances. buildPerTenantPipeline creates a new QueryPipeline
 * per request, so instance-level caches would be useless (0% hit rate).
 * Collection names only change during reindexing (rare), 10min TTL is safe.
 */
const collectionNameCache = new LRUCache<string, string>({
  max: 500,
  ttl: 10 * 60 * 1000, // 10 minutes
});

/**
 * Shared query result cache — module-level singleton (in-memory fallback).
 * Created once at module load. If Redis becomes available later, callers can
 * inject a Redis-backed QueryCache via QueryPipelineOptions to override.
 */
export const defaultQueryCache = new QueryCache();

// =============================================================================
// QUERY PIPELINE
// =============================================================================

export interface QueryPipelineOptions {
  embeddingProvider?: EmbeddingProvider;
  /** Per-KB embedding provider resolver (optional - enables configurable embedding per KB) */
  embeddingProviderResolver?: EmbeddingProviderResolver;
  vectorStore?: VectorStoreProvider;
  vocabularyResolver?: VocabularyResolver;
  rerankerFactory?: RerankerFactory;
  batchedRerankerFactory?: BatchedRerankerFactory;
  useBatchedReranker?: boolean; // Feature flag (default: true)
  preprocessingClient?: PreprocessingClient; // Multilingual preprocessing (default: singleton)
  /** LLM-based vocabulary resolver (optional - enables auto-classification + dynamic resolution) */
  dynamicVocabularyResolver?: DynamicVocabularyResolver;
  /** Hybrid search builder for OpenSearch DSL generation (optional - enables all 4 query types) */
  hybridSearchBuilder?: HybridSearchBuilder;
  /** Alias resolver for field name → OpenSearch path resolution + enum coercion (optional) */
  aliasResolver?: AliasResolver;
  /** Query result cache (optional — Redis-backed with in-memory fallback) */
  queryCache?: QueryCache;
}

export class QueryPipeline {
  private readonly vocabularyResolver: VocabularyResolver;
  private readonly dynamicVocabularyResolver?: DynamicVocabularyResolver;
  private readonly hybridSearchBuilder?: HybridSearchBuilder;
  private readonly aliasResolver?: AliasResolver;
  private readonly embeddingProvider?: EmbeddingProvider;
  private readonly embeddingProviderResolver?: EmbeddingProviderResolver;
  private readonly vectorStore?: VectorStoreProvider;
  private readonly rerankerFactory?: RerankerFactory;
  private readonly batchedRerankerFactory?: BatchedRerankerFactory;
  private readonly preprocessingClient: PreprocessingClient;
  private readonly useBatchedReranker: boolean;
  private readonly queryCache?: QueryCache;
  private readonly logger: StructuredLogger;

  constructor(opts?: QueryPipelineOptions) {
    this.vocabularyResolver = opts?.vocabularyResolver ?? getVocabularyResolver();
    this.dynamicVocabularyResolver = opts?.dynamicVocabularyResolver;
    this.hybridSearchBuilder = opts?.hybridSearchBuilder;
    this.aliasResolver = opts?.aliasResolver;
    this.embeddingProvider = opts?.embeddingProvider;
    this.embeddingProviderResolver = opts?.embeddingProviderResolver;
    this.vectorStore = opts?.vectorStore;
    this.preprocessingClient = opts?.preprocessingClient ?? preprocessingClient;

    // Batched reranker (default) or fallback to standard reranker
    this.useBatchedReranker = opts?.useBatchedReranker ?? true;
    if (this.useBatchedReranker) {
      this.batchedRerankerFactory = opts?.batchedRerankerFactory ?? new BatchedRerankerFactory();
    } else {
      this.rerankerFactory = opts?.rerankerFactory ?? new RerankerFactory();
    }

    this.queryCache = opts?.queryCache;
    this.logger = new StructuredLogger({ component: 'QueryPipeline' });
  }

  // ─── Unified Pipeline ──────────────────────────────────────────────────

  /**
   * Execute unified search pipeline supporting all 4 query types.
   *
   * Stages:
   * 0. Permission Filter (always first)
   * 1. Preprocessing (conditional - skip for agent flow)
   * 2. Vocabulary Resolution + Query Type Classification (conditional)
   * 2.5. Alias Resolution (resolves alias names → OpenSearch paths + enum coercion)
   * 2.6. Doc-ID Filter (Browse SDK facet-to-document scoping)
   * 3. Build + Execute Search (HybridSearchBuilder → OpenSearch)
   * 4. Rerank (optional - semantic/hybrid only)
   * 5. Metrics & Cost (always)
   */
  async executeUnified(
    query: UnifiedSearchQuery,
    tenantId: string,
    callerContext: CallerContext,
    authMode: AuthMode = 'public',
    userIdentity?: UserIdentity,
  ): Promise<UnifiedSearchResponse> {
    const correlationId = queryMetricsStore.startQuery();
    const log = this.logger.withCorrelationId(correlationId);

    log.info('Unified pipeline started', {
      queryText: query.query,
      queryType: query.queryType ?? 'auto',
      skipPreprocessing: query.skipPreprocessing,
      skipVocabularyResolution: query.skipVocabularyResolution,
      tenantId,
      indexId: query.indexId,
    });

    // ─── Query Cache Check ─────────────────────────────────────────────
    if (this.queryCache && query.queryType !== 'aggregation') {
      const cacheKey = buildQueryCacheKey(query, authMode, userIdentity);
      try {
        const cached = await this.queryCache.get<UnifiedSearchResponse>(cacheKey, tenantId);
        if (cached) {
          log.info('Query cache HIT', { indexId: query.indexId, queryType: query.queryType });
          // Zero all latency fields — the cached values are from the first run
          // and would mislead the UI into showing stale timing.
          return {
            ...cached,
            latency: {
              vocabularyResolveMs: 0,
              vectorSearchMs: 0,
              structuredFilterMs: 0,
              rerankMs: 0,
              totalMs: 0,
              preprocessingMs: 0,
              permissionFilterMs: 0,
              searchExecutionMs: 0,
              aliasResolveMs: 0,
              embeddingMs: 0,
              dslBuildMs: 0,
              opensearchMs: 0,
              questionParentMs: 0,
              cacheHit: true,
            } as UnifiedSearchLatency & { cacheHit: boolean },
          };
        }
      } catch {
        // Cache miss or error — continue with pipeline
      }
    }

    const latency: UnifiedSearchLatency = {
      vocabularyResolveMs: 0,
      vectorSearchMs: 0,
      structuredFilterMs: 0,
      rerankMs: 0,
      totalMs: 0,
    };

    const errors: QueryMetrics['errors'] = [];
    const overallStart = Date.now();
    let permissionFilter: any;
    let docIdFilter: string[] | undefined;

    // Initialize debug trace if requested
    const emptyStageTrace: PipelineStageTrace = { applied: false, durationMs: 0 };
    const debugTrace: PipelineDebugTrace | null = query.debug
      ? {
          stages: {
            permissionFilter: { ...emptyStageTrace },
            preprocessing: { ...emptyStageTrace },
            vocabularyResolution: { ...emptyStageTrace },
            aliasResolution: { ...emptyStageTrace },
            searchExecution: { ...emptyStageTrace, queryType: '' },
            rerank: { ...emptyStageTrace },
          },
          totalDurationMs: 0,
        }
      : null;

    // ─── Stage 0: Permission Filter (ALWAYS FIRST) ──────────────────────
    const permissionStart = Date.now();

    // DEV BYPASS: Skip permission filtering in development when DEV_BYPASS_AUTH is set
    const bypassAuth = process.env.DEV_BYPASS_AUTH === 'true';
    if (bypassAuth) {
      log.warn('DEV_BYPASS_AUTH enabled - skipping permission filter (development only!)');
      permissionFilter = null; // No filter applied
    } else {
      try {
        const permissionService = getPermissionFilterService(getGlobalRedisClient());

        if (authMode === 'user' && userIdentity) {
          permissionFilter = await permissionService.buildUserPermissionFilter(
            tenantId,
            userIdentity,
          );
          log.info('User mode: Permission filter applied', {
            email: userIdentity.email,
            provider: userIdentity.idpProvider,
          });
        } else {
          permissionFilter = permissionService.buildPublicPermissionFilter();
          log.debug('Public mode: Public-only filter applied');
        }
      } catch (error) {
        log.error('Permission filter failed', error);
        errors.push({
          component: 'permission-filter',
          error: error instanceof Error ? error.message : String(error),
          recoverable: false,
        });
        throw new Error('Failed to apply permission filter');
      }
    }
    const permissionMs = Date.now() - permissionStart;
    latency.permissionFilterMs = permissionMs;
    if (debugTrace) {
      debugTrace.stages.permissionFilter = {
        applied: !bypassAuth,
        durationMs: permissionMs,
        filterCount: permissionFilter ? 1 : 0,
      };
    }

    // ─── Stage 1: Preprocessing (CONDITIONAL) ───────────────────────────
    const preprocessStart = Date.now();
    let processedQuery = query.query;
    let detectedLanguage = 'en';
    let preprocessingApplied = false;

    if (!query.skipPreprocessing) {
      try {
        const preprocessResult = await this.preprocessingClient.preprocess(query.query, tenantId, {
          enableSpellCorrection: true,
          enableSynonymExpansion: true,
          enableEntityExtraction: true,
          maxSynonyms: 3,
        });

        processedQuery = preprocessResult.processedQuery;
        detectedLanguage = preprocessResult.language;

        const hasCorrections = preprocessResult.stages.spellCorrection.length > 0;
        const hasSynonyms = preprocessResult.stages.synonymExpansion.length > 0;
        const hasEntities = preprocessResult.stages.entities.length > 0;
        preprocessingApplied = hasCorrections || hasSynonyms || hasEntities;

        if (preprocessingApplied) {
          log.debug('Preprocessing complete', {
            originalQuery: query.query,
            processedQuery,
            language: detectedLanguage,
          });
        }
      } catch (error) {
        log.warn('Preprocessing failed (continuing with original query)', { error });
        errors.push({
          component: 'preprocessing',
          error: error instanceof Error ? error.message : String(error),
          recoverable: true,
        });
      }
    } else {
      log.debug('Preprocessing skipped (agent flow)');
    }
    const preprocessMs = Date.now() - preprocessStart;
    latency.preprocessingMs = preprocessMs;
    if (debugTrace) {
      debugTrace.stages.preprocessing = {
        applied: !query.skipPreprocessing && preprocessingApplied,
        durationMs: preprocessMs,
      };
    }

    // ─── Stage 2: Vocabulary Resolution + Query Type Classification ──────
    // Optimization: For semantic/hybrid queries, start embedding generation
    // in parallel with vocabulary resolution. Embedding doesn't depend on
    // vocab results, so running them concurrently saves ~500-1500ms.
    const vocabStart = Date.now();
    let resolvedQueryType: UnifiedQueryType = query.queryType ?? 'hybrid';
    let mergedFilters = [...(query.filters ?? [])];
    let searchQuery = processedQuery;
    // Cache vocabulary resolutions from Stage 2 to avoid duplicate LLM call (B-9 fix)
    let cachedVocabResolutions: DynamicResolutionResult[] = [];

    // Start embedding in parallel if we know the query type needs it
    const needsEmbedding = resolvedQueryType === 'semantic' || resolvedQueryType === 'hybrid';
    let embeddingPromise: Promise<number[]> | undefined;
    if (needsEmbedding && this.hybridSearchBuilder) {
      embeddingPromise = this.hybridSearchBuilder
        .generateEmbedding(processedQuery, query.indexId, tenantId)
        .catch((err) => {
          log.warn('Parallel embedding generation failed (will retry in builder)', {
            error: err instanceof Error ? err.message : String(err),
          });
          return [] as number[];
        });
    }

    if (!query.skipVocabularyResolution) {
      // Use LLM-based resolver if available
      if (this.dynamicVocabularyResolver) {
        try {
          const vocabResult = await this.dynamicVocabularyResolver.resolve(
            processedQuery,
            query.indexId, // projectKbId
            tenantId,
          );

          searchQuery = vocabResult.originalQuery;
          // Cache resolutions for Stage 3 builder (avoids duplicate LLM call)
          cachedVocabResolutions = vocabResult.resolutions;

          // Use LLM-classified query type if client didn't specify
          if (!query.queryType && vocabResult.classifiedQueryType) {
            resolvedQueryType = vocabResult.classifiedQueryType;
            log.debug('Query type auto-classified by LLM', {
              classifiedQueryType: resolvedQueryType,
            });
          }

          // Extract filters from vocabulary resolutions.
          // Skip vocab filters for fields that the client already provided —
          // the client (agent LLM) already resolved those and adding duplicates
          // with potentially different values causes 0 results.
          // Also expand semantically equivalent fields (source_type ↔ mime_type)
          // so that providing one suppresses vocabulary from adding the other.
          const EQUIVALENT_FIELDS: Record<string, string[]> = {
            source_type: ['mime_type'],
            mime_type: ['source_type'],
          };
          const clientFilterFields = new Set(
            (query.filters ?? []).flatMap((f: any) => {
              const field = (f.field || '').replace(/^canonical\./, '');
              return [field, ...(EQUIVALENT_FIELDS[field] ?? [])];
            }),
          );

          for (const resolution of vocabResult.resolutions) {
            if (resolution.resolvedAs === 'filter' && resolution.filter) {
              for (const f of resolution.filter) {
                const normalizedField = (f.field || '').replace(/^canonical\./, '');
                if (clientFilterFields.has(normalizedField)) {
                  log.debug('Skipping vocab filter (client already provides this field)', {
                    field: f.field,
                    clientValue: 'exists',
                  });
                  continue;
                }
                mergedFilters.push({
                  field: f.field,
                  operator: f.operator === 'equals' ? 'eq' : (f.operator as any),
                  value: f.value as any,
                });
              }
            }
          }

          log.debug('Dynamic vocabulary resolution complete', {
            resolvedCount: vocabResult.resolutions.length,
            unresolvedCount: vocabResult.unresolvedSegments.length,
            filtersExtracted: mergedFilters.length - (query.filters?.length ?? 0),
          });

          if (debugTrace) {
            debugTrace.stages.vocabularyResolution = {
              applied: true,
              durationMs: 0, // set after timing
              resolvedTerms: vocabResult.resolutions.map((r) => ({
                original: r.term,
                resolved: r.resolvedAs,
                type: r.resolvedAs,
              })),
              unresolvedSegments: vocabResult.unresolvedSegments,
              classifiedQueryType: vocabResult.classifiedQueryType,
              classificationConfidence: vocabResult.classificationConfidence,
            };
          }
        } catch (error) {
          log.warn('Dynamic vocabulary resolution failed (continuing with original query)', {
            error,
          });
          errors.push({
            component: 'vocabulary',
            error: error instanceof Error ? error.message : String(error),
            recoverable: true,
          });
        }
      }
      // Fallback to static resolver
      else {
        try {
          const vocabResult = await this.vocabularyResolver.resolve(
            query.indexId,
            processedQuery,
            tenantId,
          );

          searchQuery = vocabResult.originalQuery;

          if (vocabResult.structuredFilters.length > 0) {
            mergedFilters = [...mergedFilters, ...vocabResult.structuredFilters];
          }

          log.debug('Static vocabulary resolution complete', {
            resolvedTerms: vocabResult.resolvedTerms.length,
            filtersAdded: vocabResult.structuredFilters.length,
          });

          if (debugTrace) {
            debugTrace.stages.vocabularyResolution = {
              applied: true,
              durationMs: 0, // set after timing
              resolvedTerms: vocabResult.resolvedTerms.map((r) => ({
                original: r.inputTerm,
                resolved: r.matchedTerm,
                type: r.matchType,
              })),
              unresolvedSegments: vocabResult.unresolvedSegments,
            };
          }
        } catch (error) {
          log.warn('Static vocabulary resolution failed (continuing)', { error });
          errors.push({
            component: 'vocabulary',
            error: error instanceof Error ? error.message : String(error),
            recoverable: true,
          });
        }
      }
    } else {
      log.debug('Vocabulary resolution skipped (agent flow)');
    }
    const vocabMs = Date.now() - vocabStart;
    latency.vocabularyResolveMs = vocabMs;
    if (debugTrace) {
      debugTrace.stages.vocabularyResolution.durationMs = vocabMs;
      // If not yet set (e.g. skipped), mark as not applied
      if (!debugTrace.stages.vocabularyResolution.applied) {
        debugTrace.stages.vocabularyResolution.applied = false;
      }
    }

    // ─── Stage 2.5: Alias Resolution ────────────────────────────────────
    // Resolves alias field names to OpenSearch paths + enum value coercion.
    // Runs for ALL flows (agent and direct) since filters may use alias names.
    const aliasStart = Date.now();
    if (mergedFilters.length > 0 && this.aliasResolver) {
      try {
        const resolvedFilters = await this.aliasResolver.resolve(
          mergedFilters.map((f) => ({
            field: f.field,
            operator: f.operator as string,
            value: f.value,
          })),
          query.indexId,
          tenantId,
        );
        mergedFilters = resolvedFilters.map((rf) => ({
          field: rf.field,
          operator: rf.operator as any,
          value: rf.value as any,
        }));
        log.debug('Alias resolution complete', {
          filtersResolved: resolvedFilters.length,
          aliasesFound: resolvedFilters.filter((f) => f.originalAlias).length,
        });
      } catch (error) {
        log.warn('Alias resolution failed (continuing with original filters)', { error });
        errors.push({
          component: 'alias-resolver',
          error: error instanceof Error ? error.message : String(error),
          recoverable: true,
        });
      }
    }
    const aliasMs = Date.now() - aliasStart;
    latency.aliasResolveMs = aliasMs;
    if (debugTrace) {
      debugTrace.stages.aliasResolution = {
        applied: mergedFilters.length > 0 && !!this.aliasResolver,
        durationMs: aliasMs,
      };
    }

    // ─── Stage 2.6: Doc-ID Filter (Browse SDK) ─────────────────────────
    if (query.documentIds && query.documentIds.length > 0) {
      if (query.documentIds.length > DOC_ID_THRESHOLD) {
        log.warn('Doc-ID filter exceeds threshold, skipping', {
          count: query.documentIds.length,
          threshold: DOC_ID_THRESHOLD,
        });
        errors.push({
          component: 'doc-id-filter',
          error: `Document ID count (${query.documentIds.length}) exceeds threshold (${DOC_ID_THRESHOLD}). Use structured filters instead.`,
          recoverable: true,
        });
      } else {
        docIdFilter = query.documentIds;
        log.debug('Doc-ID filter applied', { count: query.documentIds.length });
      }
    }

    // ─── Stage 3: Build + Execute Search ────────────────────────────────
    const searchStart = Date.now();
    let results: SearchResult[] = [];
    let aggregations: AggregationResult[] | undefined;
    let embeddingCostDetails: QueryCostBreakdown['embedding'] | undefined;
    // (usedFallback removed — client-side RRF replaces native hybrid + fallback)

    // Detailed timing breakdown (will be populated as we execute)
    let detailedTiming = {
      embeddingMs: 0,
      dslBuildMs: 0,
      opensearchMs: 0,
      questionParentMs: 0,
    };

    // Use unified path (HybridSearchBuilder + executeQuery) if available
    if (this.hybridSearchBuilder && this.vectorStore?.executeQuery) {
      try {
        // Build OpenSearch DSL via HybridSearchBuilder
        // For aggregation queries: pass vocab resolutions (needed to identify agg field/metric).
        // For all other query types: pass empty resolutions — filters are injected later
        // via injectMetadataFilters from mergedFilters. Passing resolutions here for
        // non-aggregation queries would double-apply vocab filters.
        let aggResolutions =
          resolvedQueryType === 'aggregation' ? [...cachedVocabResolutions] : ([] as any[]);

        // If the client/agent passed an explicit aggregation spec (SDK shape:
        // {measure, function, groupBy}; some older callers may still use {field})
        // but vocab resolution didn't produce an aggregate resolution, synthesize one
        // so the builder generates proper aggregation DSL instead of a plain count.
        if (
          resolvedQueryType === 'aggregation' &&
          query.aggregation &&
          (((query.aggregation as any).field as string | undefined) ||
            ((query.aggregation as any).measure as string | undefined)) &&
          !aggResolutions.some((r: any) => r.resolvedAs === 'aggregate')
        ) {
          const aggParam = query.aggregation as unknown as {
            field?: string;
            measure?: string;
            function?: string;
            groupBy?: string[];
          };
          const aggField = aggParam.field ?? aggParam.measure;

          if (aggField) {
            aggResolutions.push({
              originalSegment: searchQuery,
              resolvedAs: 'aggregate',
              aggregate: {
                field: aggField,
                metric: aggParam.function || 'count',
                groupBy:
                  Array.isArray(aggParam.groupBy) && aggParam.groupBy.length > 0
                    ? aggParam.groupBy
                    : [],
                includeFields: [],
              },
            });
          }
        }

        const vocabForBuilder = {
          originalQuery: searchQuery,
          resolutions: aggResolutions,
        };

        // Await the parallel embedding (started in Stage 2) if available
        const embedWaitStart = Date.now();
        const precomputedEmbedding = embeddingPromise ? await embeddingPromise : undefined;
        const embedWaitMs = Date.now() - embedWaitStart;
        detailedTiming.embeddingMs = embedWaitMs; // This is the ACTUAL embedding time

        const dslBuildStart = Date.now();
        // Over-fetch +5 to compensate for question→parent dedup that may shrink results.
        // Questions are embedded as separate vectors (3-5 per chunk); when they match,
        // dedup collapses them into their parent, reducing the result count.
        // +5 provides headroom without meaningful latency impact.
        const QUESTION_DEDUP_BUFFER = 5;
        const baseLimit = query.limit ?? query.topK ?? 20;
        const dslBody = await this.hybridSearchBuilder.buildQueryFromResolution(
          vocabForBuilder,
          resolvedQueryType,
          {
            limit:
              resolvedQueryType !== 'aggregation' ? baseLimit + QUESTION_DEDUP_BUFFER : baseLimit,
            offset: query.offset ?? 0,
            tenantId,
            projectKbId: query.indexId,
            precomputedEmbedding,
          },
        );

        // Inject permission filter into DSL
        this.injectPermissionFilter(dslBody, permissionFilter);

        // Inject agent-provided filters into DSL
        if (mergedFilters.length > 0) {
          log.info('[AGG DEBUG] Before injectMetadataFilters', {
            queryType: resolvedQueryType,
            mergedFilters,
            dslBefore: JSON.stringify(dslBody, null, 2),
          });
          this.injectMetadataFilters(dslBody, mergedFilters);
          log.info('[AGG DEBUG] After injectMetadataFilters', {
            dslAfter: JSON.stringify(dslBody, null, 2),
          });

          // For structured queries with external filters: relax BM25 to match_all.
          // When the agent sends structured + filters (skipVocabularyResolution=true),
          // the builder gets empty resolutions → builds BM25 with operator:"and".
          // But filter-intent queries like "list of pdf" don't match document content
          // with AND — the metadata filter should drive results instead.
          if (resolvedQueryType === 'structured' && dslBody.query?.bool?.must) {
            const mustArray = Array.isArray(dslBody.query.bool.must)
              ? dslBody.query.bool.must
              : [dslBody.query.bool.must];
            const hasMultiMatch = mustArray.some((clause: any) => clause.multi_match !== undefined);
            if (hasMultiMatch) {
              dslBody.query.bool.must = [{ match_all: {} }];
            }
          }
        }

        // Inject appId filter to scope results to this knowledge base (CRITICAL for multi-tenant isolation)
        this.injectAppIdFilter(dslBody, query.indexId);

        // Exclude question vectors from aggregation queries.
        // Questions are embedded as separate vectors for semantic matching,
        // but aggregations should only count real content chunks — otherwise
        // counts are inflated (e.g., 4 chunks + 12 questions = 16 instead of 4).
        if (resolvedQueryType === 'aggregation') {
          if (!dslBody.query) dslBody.query = { bool: {} };
          if (!dslBody.query.bool) dslBody.query = { bool: { must: dslBody.query } };
          if (!dslBody.query.bool.must_not) dslBody.query.bool.must_not = [];
          if (!Array.isArray(dslBody.query.bool.must_not)) {
            dslBody.query.bool.must_not = [dslBody.query.bool.must_not];
          }
          dslBody.query.bool.must_not.push({ exists: { field: 'metadata.question' } });
        }

        // Boost kNN k value when filters are present.
        // OpenSearch kNN retrieves k nearest candidates THEN applies bool filters.
        // With a small k, all candidates may be filtered out. Use a multiplier
        // to ensure enough candidates survive post-filtering.
        const hasFilters = this.hasFilterClauses(dslBody);
        if (hasFilters) {
          this.boostKnnK(dslBody, query.limit ?? query.topK ?? 20);
        }

        // Inject doc-ID filter to scope results to specific documents (Browse SDK)
        if (docIdFilter) {
          this.injectDocIdFilter(dslBody, docIdFilter);
        }

        log.debug('OpenSearch DSL built', {
          queryType: resolvedQueryType,
          hasPermissionFilter: !!permissionFilter,
          mergedFiltersCount: mergedFilters.length,
        });

        // Clean internal fields from DSL body
        delete (dslBody as any)._boolFallback;
        delete (dslBody as any)._fallbackBool;

        // Resolve the actual OpenSearch collection name from the SearchIndex
        const collectionName = await this.resolveCollectionName(query.indexId);

        const dslBuildMs = Date.now() - dslBuildStart;
        detailedTiming.dslBuildMs = dslBuildMs; // Track DSL build time

        const osQueryStart = Date.now();
        let osResult: {
          hits: Array<{ id: string; score: number; source: Record<string, unknown> }>;
          aggregations?: Record<string, unknown>;
          total: number;
        };

        // ─── Client-side RRF for hybrid queries ──────────────────────
        // Run kNN and BM25 as separate queries in parallel, then fuse with RRF.
        // This avoids OpenSearch's min-max normalization which destroys absolute
        // relevance signals (maps top result to 1.0 even when nothing matches).
        const isClientSideRRF = !!(dslBody as any)._clientSideRRF;
        if (isClientSideRRF && this.vectorStore?.executeQuery) {
          const knnDsl = (dslBody as any)._knnQuery;
          const bm25Dsl = (dslBody as any)._bm25Query;

          // Inject appId + permission + metadata filters into both sub-queries
          for (const subDsl of [knnDsl, bm25Dsl]) {
            this.injectAppIdFilter(subDsl, query.indexId);
            if (permissionFilter) this.injectPermissionFilter(subDsl, permissionFilter);
            if (mergedFilters.length > 0) this.injectMetadataFilters(subDsl, mergedFilters);
            if (docIdFilter) this.injectDocIdFilter(subDsl, docIdFilter);
          }

          log.debug('Hybrid: client-side RRF sub-query DSL', {
            indexId: query.indexId,
            collectionName,
            knnHasNativeFilter: !!knnDsl?.query?.knn?.vector?.filter,
            bm25HasBoolFilter: !!bm25Dsl?.query?.bool?.filter,
          });

          const [knnResult, bm25Result] = await Promise.all([
            this.vectorStore.executeQuery(collectionName, knnDsl),
            this.vectorStore.executeQuery(collectionName, bm25Dsl),
          ]);

          // ─── Cross-KB leakage detection ───────────────────────────────
          // Check each sub-query's results for documents from other KBs.
          // On NMSLIB indices, knn.vector.filter is silently ignored so the
          // kNN sub-query returns the global top-k across ALL KBs. The
          // defensive post-filter below removes them before RRF fusion.
          const extractLeaked = (
            hits: Array<{ id: string; score: number; source: Record<string, unknown> }>,
          ) =>
            hits.filter((h) => {
              const appId = (h.source.metadata as any)?.sys?.appId;
              return appId && appId !== query.indexId;
            });
          const knnLeaked = extractLeaked(knnResult.hits);
          const bm25Leaked = extractLeaked(bm25Result.hits);

          if (knnLeaked.length > 0 || bm25Leaked.length > 0) {
            log.warn('Hybrid: CROSS-KB LEAKAGE detected in sub-query results', {
              requestedKB: query.indexId,
              knnTotal: knnResult.hits.length,
              knnLeakedCount: knnLeaked.length,
              knnLeakedAppIds: [
                ...new Set(knnLeaked.map((h) => (h.source.metadata as any)?.sys?.appId)),
              ],
              bm25Total: bm25Result.hits.length,
              bm25LeakedCount: bm25Leaked.length,
              bm25LeakedAppIds: [
                ...new Set(bm25Leaked.map((h) => (h.source.metadata as any)?.sys?.appId)),
              ],
            });
          }

          // ─── Defensive post-filter: remove any cross-KB results ───────
          // Belt-and-suspenders: even though both sub-queries have appId
          // filters injected, we enforce isolation here to prevent any
          // leakage from reaching the user. This catches edge cases where
          // OpenSearch's filter may not work as expected (e.g., mapping
          // mismatch, index created before strict mappings).
          const filterByAppId = (
            hits: Array<{ id: string; score: number; source: Record<string, unknown> }>,
          ) =>
            hits.filter((hit) => {
              const hitAppId = (hit.source.metadata as any)?.sys?.appId;
              return hitAppId === query.indexId;
            });

          const filteredKnnHits = filterByAppId(knnResult.hits);
          const filteredBm25Hits = filterByAppId(bm25Result.hits);

          if (
            filteredKnnHits.length !== knnResult.hits.length ||
            filteredBm25Hits.length !== bm25Result.hits.length
          ) {
            log.warn('Hybrid: Post-filter removed cross-KB results', {
              knnBefore: knnResult.hits.length,
              knnAfter: filteredKnnHits.length,
              bm25Before: bm25Result.hits.length,
              bm25After: filteredBm25Hits.length,
            });
          }

          // When BM25 returns 0 results, skip RRF and pass through kNN hits
          // with their original vector scores (already 0–1). RRF with only one
          // sub-query inflates ranks (e.g. 0.6 → 1.0 for the top hit) which
          // misrepresents relevance.
          if (filteredBm25Hits.length === 0) {
            const limit = dslBody.size || 20;
            osResult = {
              hits: filteredKnnHits.slice(0, limit).map((hit) => ({
                id: hit.id,
                score: hit.score, // Original vector similarity score (0–1)
                source: hit.source,
              })),
              aggregations: undefined,
              total: filteredKnnHits.length,
            };

            log.info('Hybrid: BM25 returned 0 — using kNN scores as-is', {
              knnCount: filteredKnnHits.length,
              topScore: osResult.hits[0]?.score ?? 0,
            });
          } else {
            // RRF fusion: combine ranks from both sub-queries
            const RRF_K = 60;
            const knnRankMap = new Map<string, { rank: number; hit: (typeof knnResult.hits)[0] }>();
            const bm25RankMap = new Map<string, number>();

            filteredKnnHits.forEach((hit, idx) => {
              knnRankMap.set(hit.id, { rank: idx + 1, hit });
            });
            filteredBm25Hits.forEach((hit, idx) => {
              bm25RankMap.set(hit.id, idx + 1);
            });

            // Collect all unique doc IDs
            const allDocIds = new Set([...knnRankMap.keys(), ...bm25RankMap.keys()]);
            const fusedHits: Array<{ id: string; score: number; source: Record<string, unknown> }> =
              [];

            for (const docId of allDocIds) {
              const knnEntry = knnRankMap.get(docId);
              const bm25Rank = bm25RankMap.get(docId);

              // RRF score = sum of 1/(k + rank) for each sub-query where doc appears
              let rrfScore = 0;
              if (knnEntry) rrfScore += 1 / (RRF_K + knnEntry.rank);
              if (bm25Rank) rrfScore += 1 / (RRF_K + bm25Rank);

              // Use kNN hit source if available, otherwise find in BM25 results
              const hit = knnEntry?.hit ?? filteredBm25Hits.find((h) => h.id === docId)!;
              fusedHits.push({ id: docId, score: rrfScore, source: hit.source });
            }

            // Sort by RRF score descending
            fusedHits.sort((a, b) => b.score - a.score);

            // Normalize to 0–1: max possible = 2/(k+1) for 2 sub-queries
            const maxPossible = 2 / (RRF_K + 1);
            for (const hit of fusedHits) {
              hit.score = Math.min(hit.score / maxPossible, 1.0);
            }

            osResult = {
              hits: fusedHits.slice(0, dslBody.size || 20),
              aggregations: undefined,
              total: fusedHits.length,
            };

            log.info('Hybrid RRF: fused results', {
              knnCount: filteredKnnHits.length,
              bm25Count: filteredBm25Hits.length,
              fusedCount: fusedHits.length,
              topScore: fusedHits[0]?.score ?? 0,
            });
          }
        } else {
          // Non-hybrid queries: execute the DSL directly
          log.info('OpenSearch Query DSL', {
            indexId: query.indexId,
            queryType: resolvedQueryType,
          });

          osResult = await this.vectorStore.executeQuery!(collectionName, dslBody as any);
        }

        const opensearchMs = Date.now() - osQueryStart;
        detailedTiming.opensearchMs = opensearchMs; // OpenSearch execution (before question→parent)

        // Map results based on query type
        if (resolvedQueryType === 'aggregation') {
          if (osResult.aggregations) {
            // Field-based aggregations (group by, metrics)
            aggregations = this.mapAggregationResults(osResult.aggregations, osResult.total ?? 0);
          } else {
            // Simple document count aggregation (no groupBy/field specified)
            const totalCount = osResult.total ?? 0;
            aggregations = [
              {
                groupKey: { field: 'total' },
                count: totalCount,
                value: totalCount,
              },
            ];
          }
        } else {
          results = osResult.hits.map((hit) => {
            const metadata = (hit.source.metadata as any) ?? {};
            const appId = metadata.sys?.appId;
            const doc = metadata.doc ?? {};
            return {
              documentId: (metadata.sys?.documentId as string) ?? hit.id,
              chunkId: (metadata.sys?.chunkId as string) ?? hit.id,
              score: hit.score,
              content: hit.source.content as string | undefined,
              metadata: metadata as Record<string, unknown>,
              source: {
                sourceId: metadata.sys?.connectorId ?? '',
                sourceType: metadata.sys?.connectorId ? 'connector' : 'upload',
                sourceName: doc.name ?? '',
                reference: undefined as string | undefined,
              },
            };
          });

          // ─── Enrich results with source URLs from SearchDocument ─────
          // Batch-lookup originalReference + sourceUrl for all unique documentIds,
          // then assign navigable URLs to source.reference:
          //   - Connector/crawled: use originalReference (http/https URL)
          //   - Uploads: generate a signed download URL (design-time access)
          const docIds = [...new Set(results.map((r) => r.documentId).filter(Boolean))];
          if (docIds.length > 0) {
            try {
              const SearchDocumentModel = getLazyModel<ISearchDocument>('SearchDocument');
              const docs = await SearchDocumentModel.find(
                { _id: { $in: docIds }, tenantId },
                { originalReference: 1, connectorId: 1, sourceUrl: 1, downloadUrl: 1 },
              ).lean();
              const docMap = new Map(docs.map((d) => [d._id.toString(), d]));

              // Get JWT secret for generating design-time download tokens
              let jwtSecret: string | undefined;
              try {
                jwtSecret = getConfig().jwt.secret;
              } catch {
                // Config not available — skip download URL generation
              }

              for (const result of results) {
                if (!result.documentId) continue;
                const doc = docMap.get(result.documentId);
                if (!doc) continue;

                // Priority 1: If document has a stored downloadUrl (signed at ingest),
                // use it directly — works for both connectors and uploads.
                if ((doc as any).downloadUrl && result.source) {
                  result.source.reference = (doc as any).downloadUrl;
                  continue;
                }

                if (doc.originalReference) {
                  const ref = doc.originalReference;
                  // Connector/crawled: assign navigable http(s) URL directly
                  if (ref.startsWith('http://') || ref.startsWith('https://')) {
                    if (result.source) {
                      result.source.reference = ref;
                      // Detect crawled sources: has URL but no connectorId
                      if (!doc.connectorId && result.source.sourceType === 'upload') {
                        result.source.sourceType = 'crawled';
                      }
                    }
                    continue;
                  }
                }

                // Generate a signed download URL for documents stored in S3/local storage
                // (both uploads AND connector-synced docs without a navigable HTTP URL).
                // Uses the same HMAC token pattern as search-ai's /api/documents/:id/download endpoint.
                if ((doc as any).sourceUrl && jwtSecret && result.source) {
                  const token = generateDesignDownloadToken(result.documentId, tenantId, jwtSecret);
                  result.source.reference = buildDesignDownloadUrl(result.documentId, token);
                }
              }
            } catch (err) {
              log.warn('Failed to enrich results with source URLs', {
                error: err instanceof Error ? err.message : String(err),
                docIdCount: docIds.length,
              });
              // Continue without enrichment — results still valid without URLs
            }
          }

          // ─── Defensive post-filter: enforce KB isolation ─────────────
          // Belt-and-suspenders: remove any results that don't belong to the
          // requested KB. This catches edge cases where OpenSearch's filter
          // may not work as expected (mapping mismatch, shared index race, etc.)
          const beforeFilterCount = results.length;
          results = results.filter((r) => {
            const hitAppId = (r.metadata as any)?.sys?.appId;
            return hitAppId === query.indexId;
          });

          if (results.length !== beforeFilterCount) {
            const leakedAppIds = [
              ...new Set(
                osResult.hits
                  .map((h) => (h.source.metadata as any)?.sys?.appId)
                  .filter((id: string) => id && id !== query.indexId),
              ),
            ];
            log.warn('CROSS-KB LEAKAGE: Post-filter removed results from other KBs', {
              requestedKB: query.indexId,
              queryType: resolvedQueryType,
              beforeCount: beforeFilterCount,
              afterCount: results.length,
              leakedCount: beforeFilterCount - results.length,
              leakedAppIds,
            });
          }

          // QUESTION → PARENT RESOLUTION
          // Questions are embedded as separate vectors to improve semantic matching,
          // but users should see the parent content chunk, not the question itself.
          // Deduplicate: if multiple questions from same parent match, show parent once.
          const qpStart = Date.now();
          results = await this.resolveQuestionsToParents(results, collectionName);
          detailedTiming.questionParentMs = Date.now() - qpStart;
        }

        const osQueryMs = Date.now() - osQueryStart;
        log.info('Search executed via unified path', {
          queryType: resolvedQueryType,
          resultsCount: results.length,
          topScore: results[0]?.score ?? null,
          collectionName,
          aggregationsCount: aggregations?.length ?? 0,
          timingBreakdown: {
            embeddingWaitMs: embedWaitMs,
            dslBuildMs,
            osQueryMs,
            usedPrecomputedEmbedding: !!(precomputedEmbedding && precomputedEmbedding.length > 0),
          },
        });
      } catch (error) {
        log.error('Unified search execution failed', error);
        errors.push({
          component: 'unified-search',
          error: error instanceof Error ? error.message : String(error),
          recoverable: false,
        });
      }
    }
    // ─── Score normalization ──────────────────────────────────────────────
    // Hybrid: Client-side RRF normalizes to 0–1 (divide by max possible). ✅
    // Semantic/vector: Pure kNN cosine similarity, already 0–1. ✅
    // Structured: Raw BM25 scores can be > 1 — must normalize for API consistency.
    // Safety net: Any path producing > 1 scores gets min-max normalized to 0–1.
    if (results.length > 0) {
      const maxScore = Math.max(...results.map((r) => r.score));
      if (maxScore > 1.0) {
        const minScore = Math.min(...results.map((r) => r.score));
        const range = maxScore - minScore;
        if (range > 0) {
          for (const r of results) {
            r.score = (r.score - minScore) / range;
          }
        } else {
          for (const r of results) {
            r.score = 1.0;
          }
        }
        log.debug('Scores normalized to 0-1 (max was > 1)', {
          originalMax: maxScore,
          originalMin: minScore,
          resultCount: results.length,
        });
      }
    }

    // Always sort results by score descending
    if (results.length > 1) {
      results.sort((a, b) => b.score - a.score);
    }

    // Apply similarity threshold — filter out low-relevance results.
    // Scores are already normalized to 0-1 at this point.
    // Default threshold: 0.2 (very permissive — only filters near-zero matches)
    const similarityThreshold = query.similarityThreshold ?? 0.0;
    if (similarityThreshold > 0 && results.length > 0) {
      const beforeCount = results.length;
      results = results.filter((r) => r.score >= similarityThreshold);
      if (results.length < beforeCount) {
        log.debug('Similarity threshold applied', {
          threshold: similarityThreshold,
          before: beforeCount,
          after: results.length,
        });
      }
    }

    // Trim to requested limit (hybrid queries over-fetch with post_filter compensation)
    const requestedLimit = query.limit ?? query.topK ?? 20;
    if (results.length > requestedLimit) {
      results = results.slice(0, requestedLimit);
    }

    const searchMs = Date.now() - searchStart;
    latency.vectorSearchMs = searchMs;
    latency.searchExecutionMs = searchMs;

    // Add detailed timing breakdown
    latency.embeddingMs = detailedTiming.embeddingMs;
    latency.dslBuildMs = detailedTiming.dslBuildMs;
    latency.opensearchMs = detailedTiming.opensearchMs;
    latency.questionParentMs = detailedTiming.questionParentMs;

    if (debugTrace) {
      debugTrace.stages.searchExecution = {
        applied: true,
        durationMs: searchMs,
        queryType: resolvedQueryType,
        rawResultCount: results.length + (aggregations?.length ?? 0),
      };
    }

    // ─── Stage 4: Rerank (OPTIONAL) ─────────────────────────────────────
    let rerankProvider: string | undefined;
    let rerankCostDetails: QueryCostBreakdown['rerank'] | undefined;
    const resultCountBeforeRerank = results.length;

    if (
      query.rerank &&
      results.length > 0 &&
      (resolvedQueryType === 'semantic' || resolvedQueryType === 'hybrid')
    ) {
      const rerankStart = Date.now();

      try {
        const rerankResult = await this.rerank(
          tenantId,
          query.indexId,
          searchQuery,
          results,
          callerContext,
        );

        if (rerankResult.provider && !rerankResult.fallback) {
          results = rerankResult.results;
          rerankProvider = rerankResult.provider;

          if (rerankProvider && rerankResult.model) {
            rerankCostDetails = costCalculator.calculateRerankCost(
              rerankProvider,
              rerankResult.model,
              results.length,
            );
          }

          log.info('Reranking complete', {
            provider: rerankProvider,
            resultsReordered: results.length,
          });
        }
      } catch (error) {
        log.error('Reranking failed, using original results', error);
        errors.push({
          component: 'rerank',
          error: error instanceof Error ? error.message : String(error),
          recoverable: true,
        });
      }

      latency.rerankMs = Date.now() - rerankStart;

      if (debugTrace) {
        debugTrace.stages.rerank = {
          applied: !!rerankProvider,
          durationMs: latency.rerankMs,
          modelUsed: rerankCostDetails ? rerankProvider : undefined,
          resultCountBefore: resultCountBeforeRerank,
          resultCountAfter: results.length,
        };
      }
    }

    // ─── Stage 5: Metrics & Cost ────────────────────────────────────────
    latency.totalMs = Date.now() - overallStart;

    const costBreakdown = costCalculator.calculateQueryCost(
      embeddingCostDetails,
      rerankCostDetails,
    );

    queryMetricsStore.recordQuery({
      correlationId,
      timestamp: overallStart,
      queryText: query.query,
      projectKbId: query.indexId,
      latency: {
        preprocessingMs: preprocessMs,
        vocabularyResolveMs: latency.vocabularyResolveMs,
        embeddingMs: 0,
        vectorSearchMs: latency.vectorSearchMs,
        rerankMs: latency.rerankMs,
        totalMs: latency.totalMs,
      },
      resultsCount: results.length,
      topK: query.topK ?? 20,
      embeddingProvider: this.embeddingProvider?.name,
      rerankProvider,
      rerankFallback: false,
      detectedLanguage,
      preprocessingApplied,
      errors,
      cost: {
        embeddingCost: embeddingCostDetails?.totalCost,
        rerankCost: rerankCostDetails?.totalCost,
        totalCost: costBreakdown.totalCost,
      },
    });

    log.info('Unified pipeline complete', {
      queryType: resolvedQueryType,
      queryText: query.query,
      indexId: query.indexId,
      resultsCount: results.length,
      aggregationsCount: aggregations?.length ?? 0,
      topScore: results[0]?.score ?? null,
      filtersApplied: mergedFilters.length,
      vocabularyResolved: cachedVocabResolutions.length,
      preprocessingApplied,
      latency: {
        preprocessingMs: preprocessMs,
        vocabularyMs: latency.vocabularyResolveMs,
        searchMs: latency.vectorSearchMs,
        rerankMs: latency.rerankMs,
        totalMs: latency.totalMs,
      },
      errorCount: errors.length,
      errors: errors.length > 0 ? errors.map((e) => e.error) : undefined,
    });

    // Finalize debug trace
    if (debugTrace) {
      debugTrace.totalDurationMs = latency.totalMs;
    }

    // ─── Fire-and-forget: Record query to ClickHouse ──────────────────────
    try {
      const queryStore = getQueryStore();
      if (queryStore) {
        queryStore.record({
          query_id: correlationId,
          tenant_id: tenantId,
          // TODO: Resolve projectId from index→kb→project chain. CallerContext doesn't carry it.
          project_id: '',
          session_id: '',
          index_id: query.indexId,
          user_id: callerContext.initiatedById ?? '',
          query_type: resolvedQueryType,
          query_text: query.query,
          result_count: results.length,
          total_latency_ms: latency.totalMs,
          vocabulary_resolve_ms: latency.vocabularyResolveMs,
          vector_search_ms: latency.vectorSearchMs,
          structured_filter_ms: latency.structuredFilterMs ?? 0,
          rerank_ms: latency.rerankMs,
          cache_hit: false,
          timestamp: toClickHouseDateTime(new Date()),
        });
      }
    } catch (recordErr) {
      // Fire and forget — must not affect query response
      log.warn('Failed to record query to ClickHouse', {
        error: recordErr instanceof Error ? recordErr.message : String(recordErr),
      });
    }

    // Compute totalCount based on query type
    let totalCount: number;
    if (aggregations) {
      // For simple count queries (one bucket with groupKey.field="total"), return the count value
      if (aggregations.length === 1 && (aggregations[0].groupKey as any)?.field === 'total') {
        totalCount = aggregations[0].count;
      } else {
        // For grouped aggregations, return the number of buckets
        totalCount = aggregations.length;
      }
    } else {
      totalCount = results.length;
    }

    const response: UnifiedSearchResponse = {
      queryId: correlationId,
      queryType: resolvedQueryType,
      results,
      aggregations,
      totalCount,
      latency,
      ...(debugTrace ? { debugTrace } : {}),
      // Search metrics (always included for observability)
      metrics: {
        filtersApplied: mergedFilters.length,
        vocabularyResolutions: cachedVocabResolutions.length,
        preprocessingApplied,
        rerankApplied: !!rerankProvider,
        rerankProvider: rerankProvider ?? null,
        errorCount: errors.length,
      },
    };

    // ─── Cache result (fire-and-forget) ────────────────────────────────
    if (
      this.queryCache &&
      !query.debug &&
      query.queryType !== 'aggregation' &&
      errors.length === 0
    ) {
      const cacheKey = buildQueryCacheKey(query, authMode, userIdentity);
      this.queryCache.set(cacheKey, response, 300, tenantId).catch((cacheErr) => {
        log.warn('Failed to write query cache', {
          error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        });
      });
    }

    return response;
  }

  // ─── Unified Pipeline Helpers ──────────────────────────────────────────

  /**
   * Inject permission filter into OpenSearch DSL body.
   */
  private injectPermissionFilter(dslBody: any, permissionFilter: any): void {
    if (!permissionFilter) return;
    this.injectFilterClauses(dslBody, [permissionFilter]);
  }

  /**
   * Inject metadata filters from agent/vocabulary into OpenSearch DSL body.
   *
   * Canonical fields (under `canonical.*`) have explicit OpenSearch mappings
   * (keyword, date, float, text, etc.) and do NOT need `.keyword` suffix.
   * Non-canonical fields (dynamic) may need `.keyword` for exact matching.
   */
  private injectMetadataFilters(dslBody: any, filters: any[]): void {
    if (filters.length === 0) return;

    // Normalize operator names: agents use "equals"/"greater_than"/etc.,
    // UI uses "eq"/"gt"/etc. Map everything to a canonical short form.
    const OPERATOR_MAP: Record<string, string> = {
      equals: 'eq',
      eq: 'eq',
      in: 'in',
      contains: 'contains',
      greater_than: 'gt',
      gt: 'gt',
      gte: 'gte',
      greater_than_or_equal: 'gte',
      less_than: 'lt',
      lt: 'lt',
      lte: 'lte',
      less_than_or_equal: 'lte',
      between: 'between',
    };

    // Canonical text fields — stored as keyword but need case-insensitive matching
    const CANONICAL_TEXT_FIELDS = new Set([
      'title',
      'content_summary',
      'description',
      'author',
      'assignee',
    ]);

    // Known canonical fields — these live under metadata.canonical.* in OpenSearch
    // and do NOT need a .keyword suffix (they have explicit keyword mappings).
    // Build canonical field set from single source of truth (available-canonical-fields.ts)
    // instead of hardcoding — ensures new core/common fields are automatically included.
    const CANONICAL_FIELDS = new Set(AVAILABLE_CANONICAL_FIELDS.map((f) => f.storageField));

    // Custom canonical field pattern — custom_string_*, custom_number_*, custom_date_*
    // These are dynamic slots used by JSON uploads and connectors for domain-specific fields.
    // They live under metadata.canonical.* just like the well-known fields above.
    const CUSTOM_CANONICAL_RE = /^custom_(string|number|date|bool)_\d+$/;
    const isCustomCanonicalField = (field: string): boolean => CUSTOM_CANONICAL_RE.test(field);

    // ── Value normalization maps ──
    // Agents often send user-friendly values like "pdf" for mime_type, but
    // OpenSearch stores full MIME types like "application/pdf". And vice versa
    // for source_type where the stored value is the short name ("pdf") but the
    // agent might send the full MIME string. These maps fix the mismatch.
    const SHORT_TO_MIME: Record<string, string> = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      json: 'application/json',
      csv: 'text/csv',
      text: 'text/plain',
      txt: 'text/plain',
      markdown: 'text/markdown',
      md: 'text/markdown',
      html: 'text/html',
      xml: 'application/xml',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ppt: 'application/vnd.ms-powerpoint',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
    };

    const MIME_TO_SHORT: Record<string, string> = {
      'application/pdf': 'pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/msword': 'doc',
      'application/json': 'json',
      'text/csv': 'csv',
      'text/plain': 'text',
      'text/markdown': 'markdown',
      'text/html': 'html',
      'application/xml': 'xml',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
      'application/vnd.ms-powerpoint': 'ppt',
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
    };

    /**
     * Normalize filter value for source_type / mime_type so agents can use
     * human-friendly terms ("pdf") and still match the stored canonical value.
     */
    function normalizeFieldValue(canonicalFieldName: string | null, value: unknown): unknown {
      if (canonicalFieldName === 'mime_type' && typeof value === 'string') {
        // Agent sent short name like "pdf" → map to "application/pdf"
        const lower = value.toLowerCase();
        return SHORT_TO_MIME[lower] ?? value;
      }
      if (canonicalFieldName === 'source_type' && typeof value === 'string') {
        // Agent sent full MIME like "application/pdf" → map to "pdf"
        const lower = value.toLowerCase();
        return MIME_TO_SHORT[lower] ?? value;
      }
      // For arrays (e.g., "in" operator), normalize each element
      if (Array.isArray(value)) {
        return value.map((v) => normalizeFieldValue(canonicalFieldName, v));
      }
      return value;
    }

    // Convert MetadataFilter[] to OpenSearch filter clauses
    const osClauses = filters.map((f) => {
      // Determine field path — handle multiple input formats:
      // 1. Already fully qualified from alias resolver: "metadata.canonical.source_type"
      // 2. Canonical prefix from UI: "canonical.source_type"
      // 3. Raw field name from agent: "source_type" (check CANONICAL_FIELDS)
      // 4. Non-canonical dynamic field: "custom_field"
      let fieldPath: string;
      let isCanonicalField: boolean;
      let canonicalFieldName: string | null;

      if (f.field.startsWith('metadata.canonical.')) {
        // Already resolved by alias resolver — use as-is
        fieldPath = f.field;
        isCanonicalField = true;
        canonicalFieldName = f.field.replace('metadata.canonical.', '');
      } else if (f.field.startsWith('canonical.')) {
        // UI format: canonical.source_type → metadata.canonical.source_type
        fieldPath = `metadata.${f.field}`;
        isCanonicalField = true;
        canonicalFieldName = f.field.replace('canonical.', '');
      } else if (f.field.startsWith('metadata.')) {
        // Already has metadata prefix — check if it's a known canonical field
        const stripped = f.field.replace('metadata.', '');
        if (CANONICAL_FIELDS.has(stripped) || isCustomCanonicalField(stripped)) {
          fieldPath = `metadata.canonical.${stripped}`;
          isCanonicalField = true;
          canonicalFieldName = stripped;
        } else {
          fieldPath = f.field;
          isCanonicalField = false;
          canonicalFieldName = null;
        }
      } else if (CANONICAL_FIELDS.has(f.field) || isCustomCanonicalField(f.field)) {
        // Raw canonical field name from agent/vocabulary (e.g., "source_type", "custom_string_1")
        fieldPath = `metadata.canonical.${f.field}`;
        isCanonicalField = true;
        canonicalFieldName = f.field;
      } else {
        // Non-canonical dynamic field
        fieldPath = `metadata.${f.field}`;
        isCanonicalField = false;
        canonicalFieldName = null;
      }

      const isCanonicalTextField =
        canonicalFieldName !== null && CANONICAL_TEXT_FIELDS.has(canonicalFieldName);

      // For term/terms queries: canonical keyword fields use direct path,
      // non-canonical fields use .keyword suffix, canonical text fields use match
      const termPath = isCanonicalField ? fieldPath : `${fieldPath}.keyword`;

      // Normalize operator
      const op = OPERATOR_MAP[f.operator] ?? f.operator;

      // Normalize value for source_type / mime_type mismatches
      const val = normalizeFieldValue(canonicalFieldName, f.value);

      switch (op) {
        case 'eq':
          if (isCanonicalTextField) {
            // Text fields (title, description, author) are analyzed — wildcard on the
            // analyzed field matches tokens, not the full string. Use match_phrase for
            // text fields which finds the exact phrase within the analyzed content.
            const eqVal = typeof val === 'string' ? val.toLowerCase() : val;
            return { match_phrase: { [fieldPath]: eqVal } };
          }
          return { term: { [termPath]: val } };
        case 'in':
          if (isCanonicalTextField) {
            const values = Array.isArray(val) ? val : [val];
            return {
              bool: {
                should: values.map((v: unknown) => ({
                  match_phrase: { [fieldPath]: v },
                })),
                minimum_should_match: 1,
              },
            };
          }
          return {
            terms: {
              [termPath]: Array.isArray(val) ? val : [val],
            },
          };
        case 'contains': {
          // Use wildcard substring matching for string metadata filters so
          // direct SDK/tool filters behave consistently for keyword-like fields.
          // Fall back to match only for non-string payloads.
          const containsVal = typeof val === 'string' ? val.toLowerCase() : val;
          if (typeof containsVal === 'string') {
            if (isCanonicalTextField) {
              // Text fields (title, description, author, assignee) are analyzed with
              // content_analyzer — wildcard on the analyzed field matches against tokens,
              // not the full string. Use match_phrase on the text field for substring-like
              // matching, which finds the phrase in the analyzed tokens in order.
              return { match_phrase: { [fieldPath]: containsVal } };
            }
            const wildcardField = isCanonicalField ? fieldPath : termPath;
            return {
              wildcard: {
                [wildcardField]: {
                  value: `*${containsVal}*`,
                  case_insensitive: true,
                },
              },
            };
          }
          return { match: { [fieldPath]: val } };
        }
        case 'gt':
          return { range: { [fieldPath]: { gt: val } } };
        case 'gte':
          return { range: { [fieldPath]: { gte: val } } };
        case 'lt':
          return { range: { [fieldPath]: { lt: val } } };
        case 'lte':
          return { range: { [fieldPath]: { lte: val } } };
        default:
          return { term: { [termPath]: val } };
      }
    });

    this.injectFilterClauses(dslBody, osClauses);
  }

  /**
   * Inject appId filter to scope results to a specific knowledge base.
   * This is CRITICAL for multi-tenant isolation in shared indices.
   */
  private injectAppIdFilter(dslBody: any, appId: string): void {
    const appIdFilter = { term: { 'metadata.sys.appId': appId } };
    this.injectFilterClauses(dslBody, [appIdFilter]);
  }

  /**
   * Inject doc-ID filter to scope results to a set of document IDs (Browse SDK).
   * metadata.sys.documentId is a keyword field — no .keyword suffix needed.
   */
  private injectDocIdFilter(dslBody: Record<string, any>, documentIds: string[]): void {
    const docIdClause = { terms: { 'metadata.sys.documentId': documentIds } };
    this.injectFilterClauses(dslBody, [docIdClause]);
  }

  /**
   * Inject filter clauses into an OpenSearch DSL body.
   *
   * Handles two query formats:
   * 1. Native `hybrid` query: inject filters into EACH sub-query by wrapping
   *    them in `bool { must: [subQuery], filter: [...] }`. This is required
   *    because the `hybrid` query type must be the top-level query for the
   *    search pipeline (score normalization) to work — wrapping hybrid in
   *    a bool would bypass normalization.
   * 2. Standard `bool` query: add to `bool.filter` array as before.
   * 3. Other queries (e.g., bare knn): wrap in bool with filter.
   */
  private injectFilterClauses(dslBody: any, clauses: any[]): void {
    if (clauses.length === 0) return;

    // Native hybrid query: use post_filter.
    // The normalization-processor needs raw kNN + raw BM25 sub-queries to properly
    // normalize and fuse scores. Wrapping sub-queries in bool breaks this.
    // Faiss engine supports native kNN-level `filter` param (2.9+), but hybrid queries
    // still need post_filter because the normalization pipeline must see raw sub-query scores.
    // post_filter runs AFTER scoring + normalization, correctly filtering the fused results.
    // We compensate by requesting more results (size * 3) so enough survive filtering.
    if (dslBody.query?.hybrid?.queries) {
      if (!dslBody.post_filter) {
        dslBody.post_filter =
          clauses.length === 1 ? clauses[0] : { bool: { filter: [...clauses] } };
      } else if (dslBody.post_filter.bool?.filter) {
        if (Array.isArray(dslBody.post_filter.bool.filter)) {
          dslBody.post_filter.bool.filter.push(...clauses);
        } else {
          dslBody.post_filter.bool.filter = [dslBody.post_filter.bool.filter, ...clauses];
        }
      } else {
        // Existing post_filter is a single clause — wrap in bool
        dslBody.post_filter = { bool: { filter: [dslBody.post_filter, ...clauses] } };
      }
      // Increase size to compensate for post_filter reducing results.
      // In shared indices, other tenants' docs occupy kNN/BM25 result slots.
      const currentSize = dslBody.size || 20;
      dslBody.size = Math.max(currentSize * 3, 60);
      return;
    }

    // Standard bool query
    if (dslBody.query?.bool?.filter) {
      if (Array.isArray(dslBody.query.bool.filter)) {
        dslBody.query.bool.filter.push(...clauses);
      } else {
        dslBody.query.bool.filter = [dslBody.query.bool.filter, ...clauses];
      }
    } else if (dslBody.query?.bool) {
      dslBody.query.bool.filter = clauses;
    } else if (dslBody.query?.knn) {
      // Bare kNN query: use Faiss native `filter` parameter.
      // Faiss HNSW (2.9+) supports efficient filtered kNN — the filter is applied
      // DURING the HNSW graph traversal, not after. This guarantees k results
      // from the filtered subset (e.g., a KB's 5 chunks in a shared index).
      // This is the optimal approach for shared indexes where post_filter would
      // fail because the KB's vectors may not appear in the global top-k at all.
      const filterClause = clauses.length === 1 ? clauses[0] : { bool: { filter: [...clauses] } };
      // Find the knn field (e.g., dslBody.query.knn.vector) and inject the filter
      const knnField = Object.keys(dslBody.query.knn)[0];
      if (knnField && dslBody.query.knn[knnField]) {
        const existing = dslBody.query.knn[knnField].filter;
        if (existing) {
          // Merge with existing kNN filter (e.g., permission + appId both inject here)
          dslBody.query.knn[knnField].filter = {
            bool: { filter: [existing, filterClause] },
          };
        } else {
          dslBody.query.knn[knnField].filter = filterClause;
        }
      }
    } else if (dslBody.query) {
      // Other non-kNN queries: wrap in bool with filter.
      const existingQuery = dslBody.query;
      dslBody.query = {
        bool: {
          must: [existingQuery],
          filter: clauses,
        },
      };
    }
  }

  /**
   * Check if a DSL body has any filter clauses (bool, hybrid, or Faiss native kNN filter).
   */
  private hasFilterClauses(dslBody: any): boolean {
    // Check post_filter (used by hybrid queries)
    if (dslBody.post_filter) return true;
    // Check Faiss native kNN filter (filter inside knn clause)
    if (dslBody.query?.knn) {
      const knnField = Object.keys(dslBody.query.knn)[0];
      if (knnField && dslBody.query.knn[knnField]?.filter) return true;
    }
    // Check standard bool
    return Array.isArray(dslBody.query?.bool?.filter) && dslBody.query.bool.filter.length > 0;
  }

  /**
   * Boost kNN k parameter when filters are present in the DSL.
   *
   * With Faiss native filtering, k candidates are drawn from the filtered subset
   * via efficient HNSW traversal. Boosting k ensures adequate exploration depth
   * even with highly selective filters.
   *
   * The k value is set to max(desiredResults * 10, 100) to handle
   * typical filter selectivity.
   */
  private boostKnnK(dslBody: any, desiredResults: number): void {
    const boostedK = Math.max(desiredResults * 10, 100);

    // Walk the DSL to find knn clauses and boost their k value
    const boostKnnInNode = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (node.knn?.vector?.k !== undefined) {
        node.knn.vector.k = Math.max(node.knn.vector.k, boostedK);
        return;
      }
      // Recurse into arrays (e.g., bool.must) and objects
      if (Array.isArray(node)) {
        for (const item of node) boostKnnInNode(item);
      } else {
        for (const value of Object.values(node)) boostKnnInNode(value);
      }
    };

    boostKnnInNode(dslBody.query);
  }

  /**
   * Map OpenSearch aggregation results to AggregationResult[].
   */
  private mapAggregationResults(
    aggregations: Record<string, unknown>,
    totalDocuments = 0,
  ): AggregationResult[] {
    const results: AggregationResult[] = [];

    for (const [key, agg] of Object.entries(aggregations)) {
      if (key.startsWith('by_') && (agg as any).buckets) {
        for (const bucket of (agg as any).buckets) {
          results.push({
            groupKey: { [key.replace('by_', '')]: bucket.key },
            value: bucket.metric_value?.value ?? bucket.doc_count ?? 0,
            count: bucket.doc_count ?? 0,
          });
        }
      } else if (agg && typeof agg === 'object' && typeof (agg as any).value === 'number') {
        results.push({
          groupKey: { field: 'total' },
          value: (agg as any).value,
          count: totalDocuments,
        });
      }
    }

    return results;
  }

  /**
   * Resolve OpenSearch index name from IndexRegistry.
   * The indexId is a SearchIndex UUID — the actual OS index name is in index_registry.
   *
   * Uses the module-level LRU cache (persists across QueryPipeline instances).
   */
  private async resolveCollectionName(indexId: string): Promise<string> {
    // Check module-level cache first
    const cached = collectionNameCache.get(indexId);
    if (cached) return cached;

    try {
      // PRIORITY 1: Check SearchIndex.activeVectorIndex (per-KB versioned indices)
      const SearchIndexModel = getModel('SearchIndex');
      const searchIndex = await SearchIndexModel.findOne({ _id: indexId })
        .select('activeVectorIndex')
        .lean();
      if (searchIndex && (searchIndex as any).activeVectorIndex) {
        const name = (searchIndex as any).activeVectorIndex as string;
        collectionNameCache.set(indexId, name);
        return name;
      }

      // PRIORITY 2: Fall back to IndexRegistry (legacy system)
      const IndexRegistry = getModel('IndexRegistry');
      const entry = await IndexRegistry.findOne({
        appId: indexId,
        status: 'active',
      })
        .select('indexName')
        .lean();
      if (entry && (entry as any).indexName) {
        const name = (entry as any).indexName as string;
        collectionNameCache.set(indexId, name);
        return name;
      }
    } catch {
      // Models not available — fall through to default
    }

    // PRIORITY 3: Last resort fallback — use indexId directly as collection name
    return indexId;
  }

  /**
   * Rerank search results using multi-provider reranker (RFC-003).
   * Uses batched reranker if enabled, with tenant isolation.
   * Returns original results if reranker is unavailable (graceful degradation).
   */
  private async rerank(
    tenantId: string,
    indexId: string,
    query: string,
    results: SearchResult[],
    callerContext: CallerContext,
  ): Promise<{
    results: SearchResult[];
    provider?: string;
    model?: string;
    cost?: number;
    fallback?: boolean;
  }> {
    if (results.length === 0) {
      return { results };
    }

    // Use batched reranker if enabled
    if (this.useBatchedReranker && this.batchedRerankerFactory) {
      if (!this.batchedRerankerFactory.isAvailable()) {
        return { results, fallback: true };
      }

      try {
        const rerankResult = await this.batchedRerankerFactory.rerank(
          tenantId,
          indexId,
          {
            query,
            documents: results.map((r) => r.content ?? ''),
            topN: results.length,
          },
          callerContext,
        );

        if (!rerankResult) {
          return { results, fallback: true };
        }

        // Map reranked indices back to original results
        const rerankedResults: SearchResult[] = rerankResult.results.map((r) => ({
          ...results[r.index],
          score: r.score,
        }));

        return {
          results: rerankedResults,
          provider: rerankResult.provider,
          model: rerankResult.model,
          cost: rerankResult.cost,
          fallback: false,
        };
      } catch (error) {
        return { results, fallback: true };
      }
    }

    // Fallback to standard reranker
    if (!this.rerankerFactory || !this.rerankerFactory.isAvailable()) {
      return { results, fallback: true };
    }

    try {
      const rerankResult = await this.rerankerFactory.rerank({
        query,
        documents: results.map((r) => r.content ?? ''),
        topN: results.length,
      });

      if (!rerankResult) {
        return { results, fallback: true };
      }

      const rerankedResults: SearchResult[] = rerankResult.results.map((r) => ({
        ...results[r.index],
        score: r.score,
      }));

      return {
        results: rerankedResults,
        provider: rerankResult.provider,
        model: rerankResult.model,
        cost: rerankResult.cost,
        fallback: false,
      };
    } catch (error) {
      return { results, fallback: true };
    }
  }

  /**
   * Resolve question chunks to their parent content chunks.
   *
   * Questions are embedded as separate vectors to improve semantic matching
   * (e.g., "What tools does Manthan use?" matches "programming languages").
   * But users should see the source content, not the generated question.
   *
   * Uses a SINGLE ORDERED PASS to preserve score-based ranking:
   * - Walk results in score order (position 1 → N)
   * - For each result, resolve its canonical chunk ID:
   *   - Content chunk → its own chunkId
   *   - Question → parent chunkId (from metadata.sys.chunkId)
   * - First occurrence of a canonical ID wins at that position
   * - Subsequent occurrences (duplicates) are skipped
   *
   * This ensures a question at position 2 (score 0.92) places its parent
   * content at position 2 — not appended at the end after lower-scored results.
   *
   * OPTIMIZED: Bulk-fetches all parent chunks in ONE query before the merge pass.
   *
   * @param results - Raw search results in score order (may contain question chunks)
   * @param collectionName - OpenSearch index name for fetching parents
   * @returns Results with questions replaced by their parent content chunks, score order preserved
   */
  private async resolveQuestionsToParents(
    results: SearchResult[],
    collectionName: string,
  ): Promise<SearchResult[]> {
    const qpStart = Date.now();
    const log = this.logger;

    // Pre-scan: identify question results and collect unique parent chunk IDs for bulk fetch
    const uniqueParentIds = new Set<string>();
    for (const result of results) {
      const questionId = (result.metadata as any)?.sys?.questionId;
      if (questionId) {
        const parentChunkId = (result.metadata as any)?.sys?.chunkId;
        if (parentChunkId) {
          uniqueParentIds.add(parentChunkId);
        }
      }
    }

    // Early return: if no questions, skip bulk fetch (saves 22ms)
    if (uniqueParentIds.size === 0) {
      log.info('TIMING: Question→Parent resolution skipped (no questions found)', {
        qpMs: Date.now() - qpStart,
      });
      return results;
    }

    // Bulk fetch ALL parent chunks via mget (direct ID lookup — no query parsing overhead)
    const parentChunksMap = new Map<string, SearchResult>();
    const bulkFetchStart = Date.now();

    try {
      const parentIds = Array.from(uniqueParentIds);
      // Use getByIds (OpenSearch mget) — ~10-20ms vs executeQuery's ~100-130ms
      const parentRecords = await this.vectorStore?.getByIds(collectionName, parentIds);

      for (const record of parentRecords ?? []) {
        const parentMetadata = (record.metadata as any) ?? {};
        const parentChunkId = (parentMetadata.sys?.chunkId as string) ?? record.id;

        parentChunksMap.set(parentChunkId, {
          documentId: (parentMetadata.sys?.documentId as string) ?? record.id,
          chunkId: parentChunkId,
          score: 0, // Overwritten per-occurrence in the merge pass
          content: record.content as string | undefined,
          metadata: parentMetadata as Record<string, unknown>,
        });
      }

      const bulkFetchMs = Date.now() - bulkFetchStart;
      log.info('TIMING: Question→Parent mget', {
        bulkFetchMs,
        parentIdsCount: parentIds.length,
        parentsFetchedCount: parentRecords?.length ?? 0,
      });
    } catch (error) {
      const bulkFetchMs = Date.now() - bulkFetchStart;
      this.logger.warn('Failed to bulk fetch parent chunks', {
        bulkFetchMs,
        parentCount: uniqueParentIds.size,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Single ordered pass: walk results in score order, first canonical ID wins
    const resolved: SearchResult[] = [];
    const seenChunkIds = new Set<string>();

    for (const result of results) {
      const questionId = (result.metadata as any)?.sys?.questionId;

      if (questionId) {
        // Question vector → resolve to parent chunk, keep question's score & position
        const parentChunkId = (result.metadata as any)?.sys?.chunkId;
        if (!parentChunkId || seenChunkIds.has(parentChunkId)) continue;

        const parent = parentChunksMap.get(parentChunkId);
        if (parent) {
          resolved.push({
            ...parent,
            score: result.score, // Preserve the question's relevance score
          });
          seenChunkIds.add(parentChunkId);
        }
        // If parent not found (deleted/missing), skip — don't show raw question
      } else {
        // Content chunk → keep as-is if not already seen
        if (!seenChunkIds.has(result.chunkId)) {
          resolved.push(result);
          seenChunkIds.add(result.chunkId);
        }
      }
    }

    const qpMs = Date.now() - qpStart;
    log.info('TIMING: Question→Parent resolution complete', {
      qpMs,
      questionsFound: uniqueParentIds.size,
      resultsBefore: results.length,
      resultsAfter: resolved.length,
    });

    return resolved;
  }
}
