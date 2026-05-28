/**
 * Unified Search Query Types
 *
 * Interfaces for the unified QueryPipeline that supports all 4 query types
 * (structured, semantic, hybrid, aggregation) with conditional stages
 * for agent vs direct flows.
 */

import type {
  MetadataFilter,
  SortSpec,
  AggregationSpec,
  SearchResult,
  SearchLatency,
  AggregationResult,
  VocabularyTrace,
} from '@agent-platform/search-ai-sdk';

// ─── Query Types ────────────────────────────────────────────────────────────

export type UnifiedQueryType = 'structured' | 'semantic' | 'hybrid' | 'aggregation';

// ─── Unified Search Query ───────────────────────────────────────────────────

export interface UnifiedSearchQuery {
  /** Index to search */
  indexId: string;

  /** Natural language query text */
  query: string;

  /**
   * Query type. If not provided, the pipeline auto-classifies via LLM
   * (requires DynamicVocabularyResolver to be configured).
   */
  queryType?: UnifiedQueryType;

  /** Pre-resolved metadata filters (agent flow provides these) */
  filters?: MetadataFilter[];

  /** Maximum results (default: 20) */
  topK?: number;

  /** Whether to use reranker (only applies to semantic/hybrid) */
  rerank?: boolean;

  /**
   * Skip preprocessing stage (spell correction, synonym expansion).
   * Set true for agent flow where the query is already rephrased.
   */
  skipPreprocessing?: boolean;

  /**
   * Skip vocabulary resolution stage.
   * Set true for agent flow where filters are already provided.
   */
  skipVocabularyResolution?: boolean;

  /** Include debug/trace info in response */
  debug?: boolean;

  /** Sort specification (structured queries) */
  sort?: SortSpec[];

  /** Pagination offset */
  offset?: number;

  /** Result limit */
  limit?: number;

  /** Aggregation specification (aggregation queries) */
  aggregation?: AggregationSpec;

  /** Document IDs to scope search results (Browse SDK: facet to document flow) */
  documentIds?: string[];

  /** Minimum score threshold (0-1). Results below this score are filtered out. */
  similarityThreshold?: number;
}

// ─── Pipeline Debug Trace ───────────────────────────────────────────────────

export interface PipelineStageTrace {
  applied: boolean;
  durationMs: number;
  input?: unknown;
  output?: unknown;
}

export interface PipelineDebugTrace {
  stages: {
    permissionFilter: PipelineStageTrace & { filterCount?: number };
    preprocessing: PipelineStageTrace & { corrections?: string[]; entities?: unknown[] };
    vocabularyResolution: PipelineStageTrace & {
      resolvedTerms?: Array<{ original: string; resolved: string; type: string }>;
      unresolvedSegments?: string[];
      classifiedQueryType?: string;
      classificationConfidence?: number;
    };
    aliasResolution: PipelineStageTrace & { mappings?: Record<string, string> };
    searchExecution: PipelineStageTrace & {
      queryType: string;
      rawResultCount?: number;
    };
    rerank: PipelineStageTrace & {
      modelUsed?: string;
      resultCountBefore?: number;
      resultCountAfter?: number;
    };
  };
  totalDurationMs: number;
}

// ─── Unified Search Response ────────────────────────────────────────────────

export interface UnifiedSearchResponse {
  /** Query ID for tracking */
  queryId: string;

  /** Resolved query type (may differ from input if auto-classified) */
  queryType: UnifiedQueryType;

  /** Document results (structured/semantic/hybrid) */
  results: SearchResult[];

  /** Aggregation results (aggregation queries) */
  aggregations?: AggregationResult[];

  /** Total count */
  totalCount: number;

  /** Latency breakdown per stage */
  latency: UnifiedSearchLatency;

  /** Vocabulary resolution trace (if debug=true) */
  vocabularyTrace?: VocabularyTrace;

  /** Debug trace with per-stage timing and details (if debug=true) */
  debugTrace?: PipelineDebugTrace;

  /** Search metrics for observability */
  metrics?: {
    filtersApplied: number;
    vocabularyResolutions: number;
    preprocessingApplied: boolean;
    rerankApplied: boolean;
    rerankProvider?: string | null;
    errorCount: number;
  };
}

// ─── Extended Latency ───────────────────────────────────────────────────────

export interface UnifiedSearchLatency extends SearchLatency {
  /** Preprocessing stage latency */
  preprocessingMs?: number;

  /** Permission filter stage latency */
  permissionFilterMs?: number;

  /** Query classification latency (included in vocabularyResolveMs if combined) */
  classificationMs?: number;

  /** Query build latency (HybridSearchBuilder) */
  queryBuildMs?: number;

  /** Search execution latency (OpenSearch) */
  searchExecutionMs?: number;

  /** Alias resolution stage latency */
  aliasResolveMs?: number;

  /** DETAILED TIMING: Embedding generation (resolve provider + embed call) */
  embeddingMs?: number;

  /** DETAILED TIMING: DSL building (OpenSearch query construction) */
  dslBuildMs?: number;

  /** DETAILED TIMING: Raw OpenSearch query time */
  opensearchMs?: number;

  /** DETAILED TIMING: Question→Parent resolution (bulk fetch + merge) */
  questionParentMs?: number;
}
