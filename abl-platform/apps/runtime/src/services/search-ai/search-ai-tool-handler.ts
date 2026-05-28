/**
 * SearchAI Tool Handler
 *
 * Translates agent tool calls (search_vector, search_structured, etc.) into
 * SearchAIClient API calls against the SearchAI Runtime / SearchAI services.
 *
 * Each tool maps to a specific SearchAIClient method. Parameters are validated
 * and adapted from the LLM tool-call format to the typed query format.
 */

import { SearchAIClient, type SearchAIClientConfig } from '@agent-platform/search-ai-sdk';
import type {
  VectorSearchQuery,
  StructuredSearchQuery,
  AggregationQuery,
  MetadataFilter,
  AggregationSpec,
} from '@agent-platform/search-ai-sdk/types';

// ─── Search Tool Names ──────────────────────────────────────────────────────

export const SEARCH_AI_TOOL_NAMES = [
  'search_vector',
  'search_structured',
  'search_aggregate',
  'search_hybrid',
  'vocabulary_resolve',
] as const;

export type SearchAIToolName = (typeof SEARCH_AI_TOOL_NAMES)[number];

export function isSearchAITool(name: string): name is SearchAIToolName {
  return (SEARCH_AI_TOOL_NAMES as readonly string[]).includes(name);
}

// ─── SearchAI Tool Handler ────────────────────────────────────────────────────

export class SearchAIToolHandler {
  private client: SearchAIClient;

  constructor(config: SearchAIClientConfig) {
    this.client = new SearchAIClient(config);
  }

  /**
   * Execute a search tool by name with the given parameters.
   * Returns the result in a format suitable for LLM consumption.
   */
  async execute(toolName: SearchAIToolName, params: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case 'search_vector':
        return this.searchVector(params);
      case 'search_structured':
        return this.searchStructured(params);
      case 'search_aggregate':
        return this.searchAggregate(params);
      case 'search_hybrid':
        return this.searchHybrid(params);
      case 'vocabulary_resolve':
        return this.vocabularyResolve(params);
      default:
        throw new Error(`Unknown search tool: ${toolName}`);
    }
  }

  // ─── Tool Implementations ───────────────────────────────────────────

  private async searchVector(params: Record<string, unknown>) {
    const query: VectorSearchQuery = {
      indexId: String(params.index_id ?? params.indexId ?? ''),
      queryType: 'vector',
      query: String(params.query ?? ''),
      topK: asNumber(params.top_k ?? params.topK, 10),
      similarityThreshold: asNumber(params.similarity_threshold ?? params.similarityThreshold, 0.7),
      filters: asFilters(params.filters),
      debug: asBoolean(params.debug),
    };

    if (!query.indexId) throw new Error('search_vector requires index_id');
    if (!query.query) throw new Error('search_vector requires query');

    const response = await this.client.vectorSearch(query);
    return formatSearchResponse(response);
  }

  private async searchStructured(params: Record<string, unknown>) {
    const filters = asFilters(params.filters);
    if (!filters || filters.length === 0) {
      throw new Error('search_structured requires at least one filter');
    }

    const query: StructuredSearchQuery = {
      indexId: String(params.index_id ?? params.indexId ?? ''),
      queryType: 'structured',
      filters,
      sort: asSortSpecs(params.sort),
      offset: asNumber(params.offset, undefined),
      limit: asNumber(params.limit, 20),
      debug: asBoolean(params.debug),
    };

    if (!query.indexId) throw new Error('search_structured requires index_id');

    const response = await this.client.structuredSearch(query);
    return formatSearchResponse(response);
  }

  private async searchAggregate(params: Record<string, unknown>) {
    const aggregation = asAggregationSpec(params);

    const query: AggregationQuery = {
      indexId: String(params.index_id ?? params.indexId ?? ''),
      queryType: 'aggregate',
      aggregation,
      filters: asFilters(params.filters),
      debug: asBoolean(params.debug),
    };

    if (!query.indexId) throw new Error('search_aggregate requires index_id');

    const response = await this.client.aggregate(query);
    return {
      results: response.results,
      totalCount: response.totalCount,
      latency: response.latency,
    };
  }

  private async searchHybrid(params: Record<string, unknown>) {
    const query: VectorSearchQuery = {
      indexId: String(params.index_id ?? params.indexId ?? ''),
      queryType: 'hybrid',
      query: String(params.query ?? ''),
      topK: asNumber(params.top_k ?? params.topK, 10),
      similarityThreshold: asNumber(params.similarity_threshold ?? params.similarityThreshold, 0.7),
      hybridAlpha: asNumber(params.hybrid_alpha ?? params.hybridAlpha, 0.7),
      rerank: asBoolean(params.rerank ?? true),
      filters: asFilters(params.filters),
      debug: asBoolean(params.debug),
    };

    if (!query.indexId) throw new Error('search_hybrid requires index_id');
    if (!query.query) throw new Error('search_hybrid requires query');

    const response = await this.client.vectorSearch(query);
    return formatSearchResponse(response);
  }

  private async vocabularyResolve(params: Record<string, unknown>) {
    const projectKbId = String(params.project_kb_id ?? params.projectKbId ?? '');
    const query = String(params.query ?? '');
    const mode =
      params.mode === 'exact' || params.mode === 'alias' || params.mode === 'fuzzy'
        ? params.mode
        : undefined;

    if (!projectKbId) throw new Error('vocabulary_resolve requires project_kb_id');
    if (!query) throw new Error('vocabulary_resolve requires query');

    const result = await this.client.resolveVocabulary(projectKbId, query, mode);
    return {
      resolvedTerms: result.resolvedTerms.map((t) => ({
        inputTerm: t.inputTerm,
        matchedTerm: t.matchedTerm,
        matchType: t.matchType,
        confidence: t.confidence,
      })),
      unresolvedSegments: result.unresolvedSegments,
      structuredFilters: result.structuredFilters,
      aggregationSpec: result.aggregationSpec,
    };
  }
}

// ─── Parameter Helpers ────────────────────────────────────────────────────────

function asNumber(val: unknown, fallback: number): number;
function asNumber(val: unknown, fallback: undefined): number | undefined;
function asNumber(val: unknown, fallback: number | undefined): number | undefined {
  if (val === undefined || val === null) return fallback;
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}

function asBoolean(val: unknown): boolean {
  if (val === undefined || val === null) return false;
  if (typeof val === 'boolean') return val;
  return val === 'true' || val === '1';
}

function asFilters(val: unknown): MetadataFilter[] | undefined {
  if (!val) return undefined;
  if (!Array.isArray(val)) return undefined;
  return val.filter(
    (f): f is MetadataFilter =>
      f && typeof f === 'object' && 'field' in f && 'operator' in f && 'value' in f,
  );
}

function asSortSpecs(val: unknown): Array<{ field: string; order: 'asc' | 'desc' }> | undefined {
  if (!val) return undefined;
  if (!Array.isArray(val)) return undefined;
  return val.filter(
    (s): s is { field: string; order: 'asc' | 'desc' } =>
      s && typeof s === 'object' && 'field' in s && 'order' in s,
  );
}

function asAggregationSpec(params: Record<string, unknown>): AggregationSpec {
  const measure = String(params.measure ?? '');
  const fn = String(params.function ?? params.fn ?? 'count') as AggregationSpec['function'];
  if (!measure) throw new Error('search_aggregate requires measure');

  return {
    measure,
    function: fn,
    groupBy: Array.isArray(params.group_by ?? params.groupBy)
      ? ((params.group_by ?? params.groupBy) as string[])
      : undefined,
    orderBy: (params.order_by ?? params.orderBy) as 'asc' | 'desc' | undefined,
    limit: asNumber(params.limit, undefined),
  };
}

function formatSearchResponse(response: {
  results: Array<{
    documentId: string;
    chunkId: string;
    score: number;
    content?: string;
    metadata?: Record<string, unknown>;
  }>;
  totalCount?: number;
  latency: {
    totalMs: number;
    embeddingMs?: number;
    opensearchMs?: number;
    questionParentMs?: number;
    dslBuildMs?: number;
    vocabularyResolveMs?: number;
    rerankMs?: number;
  };
}) {
  const {
    totalMs,
    embeddingMs,
    opensearchMs,
    questionParentMs,
    dslBuildMs,
    vocabularyResolveMs,
    rerankMs,
  } = response.latency;
  const hasDetailedTiming =
    embeddingMs !== undefined ||
    opensearchMs !== undefined ||
    questionParentMs !== undefined ||
    dslBuildMs !== undefined;

  // Calculate non-embedding time (search time) when detailed timing is available
  const nonEmbeddingMs = hasDetailedTiming
    ? (opensearchMs || 0) +
      (questionParentMs || 0) +
      (dslBuildMs || 0) +
      (vocabularyResolveMs || 0) +
      (rerankMs || 0)
    : undefined;

  return {
    results: response.results.map((r) => ({
      documentId: r.documentId,
      chunkId: r.chunkId,
      score: r.score,
      content: r.content,
      metadata: r.metadata,
    })),
    totalCount: response.totalCount,
    latencyMs: totalMs,
    // Detailed timing breakdown
    timing: {
      totalMs,
      embeddingMs: embeddingMs || 0,
      searchMs: nonEmbeddingMs,
      breakdown: {
        embedding: embeddingMs || 0,
        opensearch: opensearchMs || 0,
        questionParent: questionParentMs || 0,
        dslBuild: dslBuildMs || 0,
        vocabulary: vocabularyResolveMs || 0,
        rerank: rerankMs || 0,
      },
    },
  };
}
