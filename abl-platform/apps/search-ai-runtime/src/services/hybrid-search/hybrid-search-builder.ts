/**
 * Hybrid Search Builder - FR-9
 *
 * Builds OpenSearch queries for structured, semantic, hybrid, and aggregation query types.
 * Integrates vocabulary resolution with embedding generation for semantic search.
 *
 * **Key Features:**
 * - Structured queries: Filters + BM25 text matching for unresolved terms
 * - Semantic queries: Pure k-NN vector search using embeddings
 * - Hybrid queries: Combined k-NN + filters with reciprocal rank fusion (RRF)
 * - Aggregation queries: Group-by with metrics (count, sum, avg, min, max)
 * - Semantic term extraction: Separates semantic from structured terms
 *
 * **Architecture:**
 * - Uses DynamicVocabularyResolver for structured term extraction
 * - Uses EmbeddingProvider for semantic query embedding
 * - Provider-agnostic: Works with any EmbeddingProvider implementation
 *
 * **Usage:**
 * ```typescript
 * const searchBuilder = new HybridSearchBuilder(vocabularyResolver, embeddingProvider);
 * const query = await searchBuilder.buildQuery({
 *   query: 'Show high priority bugs about login',
 *   queryType: 'hybrid',
 *   projectKbId: 'kb_123',
 *   tenantId: 'tenant_456',
 * });
 * ```
 */

import type {
  DynamicVocabularyResolver,
  DynamicResolutionResult,
} from '../vocabulary/dynamic-vocabulary-resolver.js';
import type {
  EmbeddingProvider,
  EmbeddingProviderResolver,
} from '@agent-platform/search-ai-internal/embedding';
import { CachedEmbeddingProvider } from '../embedding/cached-provider.js';
import { createLogger } from '@abl/compiler/platform';
import { AVAILABLE_CANONICAL_FIELDS } from '@agent-platform/search-ai-internal/canonical';

const logger = createLogger('HybridSearchBuilder');

/**
 * OpenSearch search pipeline for hybrid score normalization.
 * Created at service startup via ensureHybridSearchPipeline().
 * Uses min-max normalization (each sub-query → 0-1) + weighted arithmetic mean
 * (0.7 kNN vector, 0.3 BM25 text). Final scores: always 0-1.
 */
export const HYBRID_SEARCH_PIPELINE = 'hybrid-search-pipeline';

/** All canonical storage fields — derived once from AVAILABLE_CANONICAL_FIELDS (bounded, static). */
const CANONICAL_AGG_FIELD_SET = Object.freeze(
  AVAILABLE_CANONICAL_FIELDS.reduce<Record<string, true>>((acc, f) => {
    acc[f.storageField] = true;
    return acc;
  }, {}),
);

/** Canonical text fields — these need .keyword subfield for aggregation/sorting. */
const CANONICAL_TEXT_FIELDS_SET = Object.freeze(
  AVAILABLE_CANONICAL_FIELDS.filter((f) => f.type === 'text').reduce<Record<string, true>>(
    (acc, f) => {
      acc[f.storageField] = true;
      return acc;
    },
    {},
  ),
);

// ─── Types ───────────────────────────────────────────────────────────────

export type QueryType = 'structured' | 'semantic' | 'hybrid' | 'aggregation';

export interface FilterSpec {
  field: string;
  operator: 'equals' | 'contains' | 'in' | 'greater_than' | 'less_than' | 'between';
  value: any;
}

export interface AggregationSpec {
  field: string;
  metric: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct';
  groupBy: string[];
  contextFields?: string[];
}

export interface HybridSearchParams {
  query: string;
  queryType: QueryType;
  projectKbId: string;
  tenantId: string;
  limit?: number;
  offset?: number;
}

export interface OpenSearchQuery {
  query: any;
  size?: number;
  from?: number;
  aggs?: any;
  _source?: string[] | { includes?: string[]; excludes?: string[] };
  /** OpenSearch search pipeline name for score normalization (hybrid queries) */
  search_pipeline?: string;
  /** When true, this query uses the bool fallback (not native hybrid). Scores need client-side normalization. */
  _fallbackBool?: boolean;
  /** Fallback bool query to use if native hybrid fails (e.g. OS 2.11 bug). Stripped before sending to OS. */
  _boolFallback?: OpenSearchQuery;
  /** When true, the pipeline executes kNN + BM25 separately and fuses with client-side RRF. */
  _clientSideRRF?: boolean;
  /** Separate kNN query DSL for client-side RRF execution. */
  _knnQuery?: any;
  /** Separate BM25 query DSL for client-side RRF execution. */
  _bm25Query?: any;
}

// ─── Service ─────────────────────────────────────────────────────────────

/**
 * Hybrid Search Builder Service
 *
 * IMPLEMENTS:
 * - FR-9: Hybrid Search Support (semantic + structured)
 * - Structured queries (filters + BM25 for text keywords)
 * - Semantic queries (k-NN only)
 * - Hybrid queries (k-NN + filters)
 * - Aggregation queries (group-by with metrics)
 */
export class HybridSearchBuilder {
  /**
   * Per-KB cached embedding providers.
   * The EmbeddingProviderResolver caches provider INSTANCES (60s TTL) but each
   * embed() call still hits BGE-M3. This map wraps resolved providers with
   * CachedEmbeddingProvider so repeated/identical queries return instantly.
   * Max 100 entries with FIFO eviction.
   */
  private perKbCachedProviders = new Map<string, CachedEmbeddingProvider>();
  private static readonly MAX_CACHED_PROVIDERS = 100;

  constructor(
    private vocabularyResolver: DynamicVocabularyResolver,
    private embeddingProvider: EmbeddingProvider,
    private embeddingProviderResolver?: EmbeddingProviderResolver,
  ) {
    logger.info('HybridSearchBuilder initialized', {
      embeddingProvider: embeddingProvider.name,
      dimensions: embeddingProvider.dimensions,
      hasResolver: !!embeddingProviderResolver,
    });
  }

  /**
   * Resolve the embedding provider for a query.
   *
   * If an EmbeddingProviderResolver is configured and projectKbId is available,
   * resolves the provider per-KB from activeEmbeddingConfig. Falls back to the
   * constructor-provided embeddingProvider.
   *
   * Per-KB providers are wrapped with CachedEmbeddingProvider so that
   * repeated queries with identical text (e.g. Studio's parallel search + debug)
   * return instantly from cache instead of hitting BGE-M3 again (~1.2s on CPU).
   */
  private async resolveEmbeddingProvider(
    projectKbId: string | undefined,
    tenantId: string,
  ): Promise<EmbeddingProvider> {
    // Try per-KB resolution first
    if (this.embeddingProviderResolver && projectKbId) {
      try {
        const resolved = await this.embeddingProviderResolver.resolveProvider(
          projectKbId,
          tenantId,
        );
        if (resolved) {
          // Wrap with CachedEmbeddingProvider to avoid re-computing embeddings
          // for repeated/identical queries. The resolver caches provider INSTANCES
          // (60s TTL) but each embed() call still hits the model service.
          const cacheKey = `${tenantId}:${projectKbId}`;
          const existing = this.perKbCachedProviders.get(cacheKey);

          // Reuse existing wrapper if the underlying model hasn't changed
          if (
            existing &&
            existing.modelId === resolved.modelId &&
            existing.dimensions === resolved.dimensions
          ) {
            logger.debug('Reusing cached per-KB embedding provider', {
              projectKbId,
              provider: existing.name,
              cacheStats: existing.getCacheStats(),
            });
            return existing;
          }

          // Create new cached wrapper (model changed or first resolution)
          const cached = new CachedEmbeddingProvider(resolved, {
            maxSize: 500,
            ttlMs: 1000 * 60 * 30, // 30 min TTL for embedding vectors
          });
          this.perKbCachedProviders.set(cacheKey, cached);

          // Evict oldest entry if map exceeds max size
          if (this.perKbCachedProviders.size > HybridSearchBuilder.MAX_CACHED_PROVIDERS) {
            const firstKey = this.perKbCachedProviders.keys().next().value;
            if (firstKey !== undefined) this.perKbCachedProviders.delete(firstKey);
          }

          logger.debug('Created cached per-KB embedding provider', {
            projectKbId,
            provider: cached.name,
            dimensions: cached.dimensions,
          });
          return cached;
        }
      } catch (error) {
        logger.error(
          'Failed to resolve per-KB embedding provider, using default (THIS CAUSES DIMENSION MISMATCH!)',
          {
            projectKbId,
            tenantId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
        );
      }
    }

    // Fallback to constructor-provided provider (already wrapped with CachedEmbeddingProvider
    // in ServiceContainer.initialize())
    return this.embeddingProvider;
  }

  /**
   * Generate an embedding for a query string, resolving the per-KB provider.
   * Exposed so the query pipeline can start embedding in parallel with vocab resolution.
   */
  async generateEmbedding(query: string, projectKbId: string, tenantId: string): Promise<number[]> {
    const resolveStart = Date.now();
    const provider = await this.resolveEmbeddingProvider(projectKbId, tenantId);
    const resolveMs = Date.now() - resolveStart;

    const embedStart = Date.now();
    const result = await provider.embed(query);
    const embedMs = Date.now() - embedStart;

    logger.info('TIMING: Embedding generation breakdown', {
      resolveProviderMs: resolveMs,
      embedMs: embedMs,
      totalMs: resolveMs + embedMs,
      provider: provider.name,
      queryLength: query.length,
    });

    return result;
  }

  /**
   * Main entry point - builds OpenSearch query based on query type
   */
  async buildQuery(params: HybridSearchParams): Promise<OpenSearchQuery> {
    logger.info('Building OpenSearch query', {
      queryType: params.queryType,
      query: params.query,
    });

    // 1. Resolve vocabulary (LLM identifies structured terms from query)
    const vocabResult = await this.vocabularyResolver.resolve(
      params.query,
      params.projectKbId,
      params.tenantId,
    );

    logger.debug('Vocabulary resolution complete', {
      originalQuery: vocabResult.originalQuery,
      resolutionsCount: vocabResult.resolutions.length,
      unresolvedSegmentsCount: vocabResult.unresolvedSegments.length,
      structuredTerms: vocabResult.resolutions.map((r) => r.term),
    });

    // 2. Use full original query for search (don't remove resolved terms)
    // Resolutions provide metadata about structured filters, but the full query
    // is used for BM25 text matching and semantic embeddings for better relevance
    const searchQuery = vocabResult.originalQuery;

    // 3. Build query based on type
    switch (params.queryType) {
      case 'structured':
        return this.buildStructuredQuery(vocabResult, searchQuery, params);

      case 'semantic':
        return await this.buildSemanticQuery(searchQuery, params);

      case 'hybrid':
        return await this.buildHybridQuery(vocabResult, searchQuery, params);

      case 'aggregation':
        return this.buildAggregationQuery(vocabResult, params);

      default:
        throw new Error(`Unknown query type: ${params.queryType}`);
    }
  }

  /**
   * Build OpenSearch query from a pre-resolved vocabulary result.
   * Used by the unified pipeline where vocabulary resolution happens in a prior stage.
   * This avoids a double LLM call (pipeline resolves once, passes result here).
   */
  async buildQueryFromResolution(
    vocabResult: { resolutions: DynamicResolutionResult[]; originalQuery: string },
    queryType: QueryType,
    options?: {
      limit?: number;
      offset?: number;
      tenantId?: string;
      projectKbId?: string;
      /** Pre-computed embedding vector (skips embed call when provided) */
      precomputedEmbedding?: number[];
    },
  ): Promise<OpenSearchQuery> {
    const searchQuery = vocabResult.originalQuery;
    const params = {
      query: searchQuery,
      queryType,
      projectKbId: options?.projectKbId ?? '',
      tenantId: options?.tenantId ?? '',
      limit: options?.limit,
      offset: options?.offset,
    };

    logger.info('Building OpenSearch query from pre-resolved vocabulary', {
      queryType,
      query: searchQuery,
      resolutionsCount: vocabResult.resolutions.length,
      hasContext: !!(options?.tenantId && options?.projectKbId),
      tenantId: options?.tenantId,
      projectKbId: options?.projectKbId,
    });

    switch (queryType) {
      case 'structured':
        return this.buildStructuredQuery(vocabResult, searchQuery, params);

      case 'semantic':
        return await this.buildSemanticQuery(searchQuery, params, options?.precomputedEmbedding);

      case 'hybrid':
        return await this.buildHybridQuery(
          vocabResult,
          searchQuery,
          params,
          options?.precomputedEmbedding,
        );

      case 'aggregation':
        return this.buildAggregationQuery(vocabResult, params);

      default:
        throw new Error(`Unknown query type: ${queryType}`);
    }
  }

  /**
   * Build structured query (filters + BM25 text matching on full query)
   */
  private buildStructuredQuery(
    vocabResult: { resolutions: DynamicResolutionResult[] },
    searchQuery: string,
    params: HybridSearchParams,
  ): OpenSearchQuery {
    const filters = this.buildFilterClauses(vocabResult.resolutions);
    const displayFields = this.extractDisplayFields(vocabResult.resolutions);

    // When filters exist and the query is purely a filter intent
    // (e.g., "show me pdf documents"), use match_all so only filters
    // drive results. BM25 with "and" operator would fail because
    // words like "show", "me", "pdf" don't appear together in content.
    // When no filters exist, fall back to BM25 text matching.
    const hasFilters = filters.length > 0;
    const mustClause = hasFilters
      ? [{ match_all: {} }]
      : [
          {
            multi_match: {
              query: searchQuery,
              fields: ['content^3', 'title^3', 'metadata.description', 'metadata.summary'],
              type: 'best_fields',
              operator: 'and',
              fuzziness: 'AUTO',
            },
          },
        ];

    // KB isolation: appId pre-filter built into bool.filter alongside vocab filters.
    const appIdFilter = { term: { 'metadata.sys.appId': params.projectKbId } };
    const boolQuery: any = {
      must: mustClause,
      filter: [...filters, appIdFilter],
    };

    logger.debug('Built structured query', {
      searchQuery,
      filtersCount: filters.length + 1, // +1 for appId
      usedMatchAll: hasFilters,
    });

    // OPTIMIZATION: Always exclude large fields if no display fields specified
    // When displayFields is empty, use excludes to fetch content + metadata except large fields
    const sourceConfig =
      displayFields.length > 0
        ? displayFields
        : {
            includes: ['content', 'metadata'],
            excludes: ['embedding', 'metadata.raw', 'metadata.debug'],
          };

    return {
      query: {
        bool: boolQuery,
      },
      size: params.limit || 20,
      from: params.offset || 0,
      _source: sourceConfig,
    };
  }

  /**
   * Build semantic query — native hybrid (kNN ∥ BM25) with search pipeline.
   *
   * PRIMARY: Uses OpenSearch `hybrid` query (kNN + BM25 run in parallel,
   * scores fused via search pipeline with min-max normalization + weighted mean).
   * Works on OpenSearch 2.12+ / 3.x. Scores: always 0–1 from the pipeline.
   *
   * FALLBACK: `bool { must: [kNN], should: [BM25] }` for OpenSearch versions
   * where the `hybrid` query type is unavailable or buggy (e.g. 2.11).
   * When fallback is used, `_fallbackBool` is set so the query pipeline
   * can normalize scores client-side.
   */
  private async buildSemanticQuery(
    searchQuery: string,
    params: HybridSearchParams,
    precomputedEmbedding?: number[],
  ): Promise<OpenSearchQuery> {
    if (!searchQuery || searchQuery.trim().length === 0) {
      throw new Error('Empty search query provided');
    }

    let embedding: number[];
    if (precomputedEmbedding && precomputedEmbedding.length > 0) {
      embedding = precomputedEmbedding;
    } else {
      const provider = await this.resolveEmbeddingProvider(params.projectKbId, params.tenantId);
      embedding = await provider.embed(searchQuery);
    }

    logger.debug('Embedding generated for semantic query', {
      searchQuery,
      embeddingDimension: embedding.length,
    });

    // Pure kNN vector search — no BM25, no search pipeline.
    // Cosine similarity scores are naturally 0–1 from OpenSearch.
    //
    // KB isolation: appId pre-filter is built directly into the kNN clause.
    // Faiss HNSW (2.9+) applies this DURING graph traversal, guaranteeing
    // k results from this KB only — even in shared indexes with millions of
    // vectors from other KBs. Pipeline also injects this as a safety net.
    const requestedLimit = params.limit || 20;
    const appIdFilter = { term: { 'metadata.sys.appId': params.projectKbId } };
    return {
      query: {
        knn: {
          vector: {
            vector: embedding,
            k: Math.max(requestedLimit * 5, 200),
            filter: appIdFilter,
          },
        },
      },
      size: requestedLimit,
      from: params.offset || 0,
      // OPTIMIZATION: Exclude large fields to reduce network transfer (saves 3-5ms)
      _source: {
        includes: ['content', 'metadata'],
        excludes: ['embedding', 'metadata.raw', 'metadata.debug'],
      },
    };
  }

  /**
   * Build hybrid query — native hybrid (kNN ∥ BM25) with filters + search pipeline.
   *
   * PRIMARY: Uses OpenSearch `hybrid` query where kNN and BM25 run in parallel.
   * Vocabulary-derived filters are injected into each sub-query.
   * Scores: 0–1 from the search pipeline.
   *
   * FALLBACK: `bool { must: [kNN], should: [BM25], filter: [...] }` for older OS.
   * When fallback is used, `_fallbackBool` is set for client-side normalization.
   */
  private async buildHybridQuery(
    vocabResult: { resolutions: DynamicResolutionResult[] },
    searchQuery: string,
    params: HybridSearchParams,
    precomputedEmbedding?: number[],
  ): Promise<OpenSearchQuery> {
    let embedding: number[];
    if (precomputedEmbedding && precomputedEmbedding.length > 0) {
      embedding = precomputedEmbedding;
    } else {
      const provider = await this.resolveEmbeddingProvider(params.projectKbId, params.tenantId);
      embedding = await provider.embed(searchQuery);
    }

    const filters = this.buildFilterClauses(vocabResult.resolutions);
    const displayFields = this.extractDisplayFields(vocabResult.resolutions);

    logger.info('Built hybrid query (kNN ∥ BM25 + filters)', {
      searchQuery,
      filtersCount: filters.length,
      displayFieldsCount: displayFields.length,
      embeddingDimension: embedding.length,
    });

    // Use 2x multiplier for k parameter to reduce HNSW traversal time
    // For small collections (1-100 docs), this prevents over-fetching
    const knnK = Math.max((params.limit || 20) * 2, 100);
    const knnQuery = {
      knn: { vector: { vector: embedding, k: knnK } },
    };
    const bm25Query = {
      multi_match: {
        query: searchQuery,
        fields: ['content^3', 'metadata.canonical.title^3', 'metadata.canonical.content_summary'],
        type: 'best_fields' as const,
      },
    };

    // ─── KB Isolation: appId pre-filter ────────────────────────────
    // All KBs share the same OpenSearch index. The appId term filter is
    // the PRIMARY isolation mechanism — it MUST be built into every
    // sub-query at construction time, not injected later by the pipeline.
    // This guarantees kNN and BM25 both search ONLY within this KB.
    const appIdFilter = { term: { 'metadata.sys.appId': params.projectKbId } };
    const allFilters = [...filters, appIdFilter];

    // Client-side RRF: return separate kNN and BM25 queries for parallel execution.
    // The query pipeline runs both, checks if BM25 has matches, and fuses with RRF.
    // This avoids OpenSearch's min-max normalization which destroys absolute relevance.
    //
    // kNN sub-query: Faiss native `filter` param inside the knn clause filters
    // DURING HNSW traversal, guaranteeing k results from this KB only.
    // BM25 sub-query: bool.filter restricts text search to this KB only —
    // this is a Lucene-level pre-filter, equivalent to kNN's native filter.
    const fetchSize = (params.limit || 20) * 2;

    // OPTIMIZATION: Always exclude large fields to reduce network transfer (saves 3-5ms per query)
    // When displayFields is empty, use includes+excludes to fetch content + metadata except large fields
    const sourceConfig =
      displayFields.length > 0
        ? displayFields
        : {
            includes: ['content', 'metadata'],
            excludes: ['embedding', 'metadata.raw', 'metadata.debug'],
          };

    const knnFilterClause =
      allFilters.length === 1 ? allFilters[0] : { bool: { filter: allFilters } };
    const knnDsl: any = {
      query: {
        knn: {
          vector: { ...knnQuery.knn.vector, filter: knnFilterClause },
        },
      },
      size: fetchSize,
      _source: sourceConfig,
    };
    const bm25Dsl: any = {
      query: { bool: { must: [bm25Query], filter: allFilters } },
      size: fetchSize,
      _source: sourceConfig,
    };

    return {
      // Marker for the pipeline to use client-side RRF
      _clientSideRRF: true,
      _knnQuery: knnDsl,
      _bm25Query: bm25Dsl,
      // Placeholder query (not executed directly)
      query: { match_all: {} },
      size: params.limit || 20,
      from: params.offset || 0,
    };
  }

  /**
   * Build aggregation query
   */
  private buildAggregationQuery(
    vocabResult: { resolutions: DynamicResolutionResult[] },
    params: HybridSearchParams,
  ): OpenSearchQuery {
    // Extract aggregation specification from vocabulary resolutions
    const aggResolution = vocabResult.resolutions.find(
      (r: DynamicResolutionResult) => r.resolvedAs === 'aggregate',
    );

    // KB isolation: appId pre-filter for all aggregation queries
    const appIdFilter = { term: { 'metadata.sys.appId': params.projectKbId } };

    // If no aggregation spec from vocab resolver, build a simple document count query.
    // This handles cases where the agent specifies queryType='aggregation' but the LLM
    // doesn't provide an aggregation specification, or when filters are provided without
    // a specific aggregation field (e.g., "count of documents", "how many PDFs").
    if (!aggResolution || !aggResolution.aggregate) {
      const filters = this.buildFilterClauses(
        vocabResult.resolutions.filter((r: DynamicResolutionResult) => r.resolvedAs === 'filter'),
      );

      return {
        query: {
          bool: {
            filter: [...filters, appIdFilter],
          },
        },
        // Simple document count — no field-specific aggregations
        size: 0,
      };
    }

    // Strip canonical. prefix from field/groupBy — the LLM vocab resolver
    // returns "canonical.source_type" but the builder expects "source_type"
    const stripCanonical = (f: string) => f.replace(/^canonical\./, '');
    const aggregationSpec: AggregationSpec = {
      field: stripCanonical(aggResolution.aggregate.field),
      metric: aggResolution.aggregate.metric,
      groupBy: (aggResolution.aggregate.groupBy ?? []).map(stripCanonical),
      contextFields: aggResolution.aggregate.includeFields || [],
    };

    // Build aggregation query
    const filters = this.buildFilterClauses(
      vocabResult.resolutions.filter((r: DynamicResolutionResult) => r.resolvedAs === 'filter'),
    );
    const aggs = this.buildAggregations(aggregationSpec);

    return {
      query: {
        bool: {
          filter: [...filters, appIdFilter],
        },
      },
      ...(aggs ? { aggs } : {}),
      size: 0, // Don't return documents, only aggregations
    };
  }

  /**
   * Build filter clauses from vocabulary resolutions
   */
  private buildFilterClauses(resolutions: DynamicResolutionResult[]): any[] {
    const filters: any[] = [];

    // Canonical keyword fields have explicit OpenSearch mappings and do NOT
    // need .keyword suffix. Their path is metadata.canonical.<fieldName>.
    // Non-canonical (dynamic) fields may need .keyword for exact matching.
    // Use module-level CANONICAL_AGG_FIELD_SET (derived from AVAILABLE_CANONICAL_FIELDS)
    // to recognize all canonical fields — core, common, AND custom slots.

    // Canonical text fields that use text analyzer (not keyword).
    // For these, 'equals' uses match (contains) instead of term (exact).
    const CANONICAL_TEXT_FIELDS = new Set([
      'title',
      'content_summary',
      'description',
      'assignee',
      'author',
    ]);

    // Normalize source_type/mime_type values — LLM may resolve "pdf" for mime_type
    // but OpenSearch stores "application/pdf", and vice versa for source_type.
    const normalizeMimeOrSourceType = (field: string, value: unknown): unknown => {
      if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (field === 'mime_type') {
          const map: Record<string, string> = {
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
          };
          return map[lower] ?? value;
        }
        if (field === 'source_type') {
          const map: Record<string, string> = {
            'application/pdf': 'pdf',
            'application/msword': 'doc',
            'application/json': 'json',
            'text/csv': 'csv',
            'text/plain': 'text',
            'text/markdown': 'markdown',
            'text/html': 'html',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
          };
          return map[lower] ?? value;
        }
      }
      if (Array.isArray(value)) {
        return value.map((v: unknown) => normalizeMimeOrSourceType(field, v));
      }
      return value;
    };

    for (const resolution of resolutions) {
      if (resolution.resolvedAs !== 'filter' || !resolution.filter) {
        continue;
      }

      for (const filterCondition of resolution.filter) {
        const rawField = filterCondition.field;
        const CUSTOM_RE = /^custom_(string|number|date|bool)_\d+$/;
        const isCanonical = rawField in CANONICAL_AGG_FIELD_SET || CUSTOM_RE.test(rawField);
        const isCanonicalText = CANONICAL_TEXT_FIELDS.has(rawField);

        // Canonical fields: metadata.canonical.<field> (keyword, no .keyword suffix)
        // Non-canonical fields: metadata.<field>.keyword
        const fieldName = isCanonical ? `metadata.canonical.${rawField}` : `metadata.${rawField}`;
        const termPath = isCanonical ? fieldName : `${fieldName}.keyword`;

        // Normalize value for source_type/mime_type mismatches
        const val = normalizeMimeOrSourceType(rawField, filterCondition.value);

        // Lowercase text field values for case-insensitive matching
        // (canonical text fields are stored as keyword, so matching is exact)
        const matchVal = isCanonicalText && typeof val === 'string' ? val.toLowerCase() : val;

        switch (filterCondition.operator) {
          case 'equals':
            if (isCanonicalText) {
              // Text fields (title, description, author) are analyzed with content_analyzer.
              // Wildcard on analyzed fields matches individual tokens, not the full string.
              // Use match_phrase which finds the exact phrase within analyzed content.
              filters.push({ match_phrase: { [fieldName]: matchVal } });
            } else {
              filters.push({ term: { [termPath]: val } });
            }
            break;

          case 'contains':
            if (typeof val === 'string') {
              if (isCanonicalText) {
                // Text fields: match_phrase finds the phrase within analyzed tokens
                filters.push({ match_phrase: { [fieldName]: matchVal } });
              } else {
                // Keyword fields: wildcard for substring matching
                filters.push({
                  wildcard: { [termPath]: { value: `*${matchVal}*`, case_insensitive: true } },
                });
              }
            } else {
              filters.push({ match: { [fieldName]: val } });
            }
            break;

          case 'in':
            if (isCanonicalText) {
              const values = Array.isArray(val) ? val : [val];
              filters.push({
                bool: {
                  should: values.map((v: unknown) => ({ match_phrase: { [fieldName]: v } })),
                  minimum_should_match: 1,
                },
              });
            } else {
              filters.push({
                terms: {
                  [termPath]: Array.isArray(val) ? val : [val],
                },
              });
            }
            break;

          case 'gt':
            filters.push({ range: { [fieldName]: { gt: val } } });
            break;

          case 'lt':
            filters.push({ range: { [fieldName]: { lt: val } } });
            break;
        }
      }
    }

    return filters;
  }

  /**
   * Extract display fields from vocabulary resolutions
   */
  private extractDisplayFields(resolutions: DynamicResolutionResult[]): string[] {
    const fields = new Set<string>();

    for (const resolution of resolutions) {
      if (resolution.resolvedAs === 'display' && resolution.display) {
        // Add all display fields
        for (const field of resolution.display.fields) {
          fields.add(`metadata.${field}`);
        }
      }
    }

    // Always include content and core metadata so results are usable
    if (fields.size > 0) {
      fields.add('content');
      fields.add('metadata');
    }

    return Array.from(fields);
  }

  /**
   * Extract aggregation metric from query text
   */
  private extractAggregationMetric(query: string): 'count' | 'sum' | 'avg' | 'min' | 'max' {
    const lowerQuery = query.toLowerCase();

    if (lowerQuery.includes('sum') || lowerQuery.includes('total')) {
      return 'sum';
    }
    if (
      lowerQuery.includes('average') ||
      lowerQuery.includes('avg') ||
      lowerQuery.includes('mean')
    ) {
      return 'avg';
    }
    if (
      lowerQuery.includes('min') ||
      lowerQuery.includes('minimum') ||
      lowerQuery.includes('lowest')
    ) {
      return 'min';
    }
    if (
      lowerQuery.includes('max') ||
      lowerQuery.includes('maximum') ||
      lowerQuery.includes('highest')
    ) {
      return 'max';
    }

    // Default to count
    return 'count';
  }

  /**
   * Build aggregation clauses
   */
  private buildAggregations(spec: AggregationSpec): Record<string, unknown> | undefined {
    const metricFieldName = `metadata.${spec.field}`;
    const metricAggName = spec.metric === 'count_distinct' ? 'cardinality' : spec.metric;
    const groupField = spec.groupBy[0];

    if (!groupField) {
      if (spec.metric === 'count') {
        return undefined;
      }

      return {
        total_value: {
          [metricAggName]: {
            field: metricFieldName,
          },
        },
      };
    }

    const aggName = `by_${groupField}`;
    const rawField = groupField;
    // Canonical fields live at metadata.canonical.<field> (keyword mapped, no .keyword suffix)
    const CUSTOM_CANONICAL_RE = /^custom_(string|number|date|bool)_\d+$/;
    const isCanonical = rawField in CANONICAL_AGG_FIELD_SET || CUSTOM_CANONICAL_RE.test(rawField);
    const isTextField = rawField in CANONICAL_TEXT_FIELDS_SET;
    // Text canonical fields (title, description, content_summary) need .keyword
    // subfield for terms aggregation since text fields can't be aggregated directly.
    const fieldName = isCanonical
      ? isTextField
        ? `metadata.canonical.${rawField}.keyword`
        : `metadata.canonical.${rawField}`
      : `metadata.${rawField}.keyword`;

    const agg: any = {
      [aggName]: {
        terms: {
          field: fieldName,
          size: 100,
        },
      },
    };

    // Add metric sub-aggregation if not count
    if (spec.metric !== 'count') {
      agg[aggName].aggs = {
        metric_value: {
          [metricAggName]: {
            field: metricFieldName,
          },
        },
      };
    }

    // Add context fields as sub-aggregation
    if (spec.contextFields && spec.contextFields.length > 0) {
      agg[aggName].aggs = agg[aggName].aggs || {};
      agg[aggName].aggs.context = {
        top_hits: {
          size: 1,
          _source: spec.contextFields.map((f) => `metadata.${f}`),
        },
      };
    }

    return agg;
  }
}
