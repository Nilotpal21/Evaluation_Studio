/**
 * Search Query & Result Types
 *
 * Covers all three query archetypes: vector/hybrid, structured, and aggregation.
 */

import type { QueryType } from '../constants.js';

// ─── Base Query ──────────────────────────────────────────────────────────────

export interface SearchQueryBase {
  /** Index to search */
  indexId: string;
  /** Query type for analytics */
  queryType: QueryType;
  /** Metadata filters */
  filters?: MetadataFilter[];
  /** Maximum results */
  topK?: number;
  /** Whether to include debug/trace info */
  debug?: boolean;
}

// ─── Vector/Hybrid Search ────────────────────────────────────────────────────

export interface VectorSearchQuery extends SearchQueryBase {
  queryType: 'vector' | 'hybrid';
  /** Natural language query text */
  query: string;
  /** Similarity threshold (0-1) */
  similarityThreshold?: number;
  /** Hybrid search weight for vector vs keyword (0=keyword, 1=vector) */
  hybridAlpha?: number;
  /** Whether to use reranker */
  rerank?: boolean;
}

// ─── Structured Search ───────────────────────────────────────────────────────

export interface StructuredSearchQuery extends SearchQueryBase {
  queryType: 'structured';
  /** Filters are required for structured queries */
  filters: MetadataFilter[];
  /** Sort order */
  sort?: SortSpec[];
  /** Offset for pagination */
  offset?: number;
  /** Limit for pagination */
  limit?: number;
}

// ─── Aggregation Search ──────────────────────────────────────────────────────

export interface AggregationQuery extends SearchQueryBase {
  queryType: 'aggregate';
  /** Aggregation specification */
  aggregation: AggregationSpec;
}

export interface AggregationSpec {
  /** Measure field to aggregate */
  measure: string;
  /** Aggregation function */
  function: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';
  /** Group by fields */
  groupBy?: string[];
  /** Having clause (post-aggregation filter) */
  having?: MetadataFilter;
  /** Sort by aggregation result */
  orderBy?: 'asc' | 'desc';
  /** Limit number of groups */
  limit?: number;
}

// ─── Suggest / Similar ───────────────────────────────────────────────────────

export interface SuggestQuery {
  indexId: string;
  /** Partial text for autocomplete */
  prefix: string;
  /** Maximum suggestions */
  limit?: number;
  /** Field to suggest from */
  field?: string;
}

export interface SimilarQuery {
  indexId: string;
  /** Document ID to find similar documents for */
  documentId: string;
  /** Maximum results */
  topK?: number;
  /** Filters to apply */
  filters?: MetadataFilter[];
}

// ─── Metadata Filters ────────────────────────────────────────────────────────

export interface MetadataFilter {
  field: string;
  operator: FilterOperator;
  value: FilterValue;
}

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'not_contains'
  | 'exists'
  | 'not_exists';

export type FilterValue = string | number | boolean | string[] | number[];

export interface SortSpec {
  field: string;
  order: 'asc' | 'desc';
}

// ─── Search Results ──────────────────────────────────────────────────────────

export interface SearchResponse {
  /** Query ID for tracking */
  queryId: string;
  /** Results */
  results: SearchResult[];
  /** Total count (if available) */
  totalCount?: number;
  /** Query latency breakdown */
  latency: SearchLatency;
  /** Vocabulary resolution trace (if debug=true) */
  vocabularyTrace?: VocabularyTrace;
}

export interface SearchResult {
  /** Document ID */
  documentId: string;
  /** Chunk ID */
  chunkId: string;
  /** Relevance score (0-1) */
  score: number;
  /** Chunk content */
  content?: string;
  /** Metadata (canonical field values) */
  metadata?: Record<string, unknown>;
  /** Source attribution */
  source?: SourceAttribution;
}

export interface SourceAttribution {
  sourceId: string;
  sourceType: string;
  sourceName: string;
  /** Original URL or reference */
  reference?: string;
}

export interface SearchLatency {
  vocabularyResolveMs: number;
  vectorSearchMs: number;
  structuredFilterMs: number;
  rerankMs: number;
  totalMs: number;
}

export interface VocabularyTrace {
  inputQuery: string;
  resolvedTerms: ResolvedTerm[];
  unresolvedSegments: string[];
  appliedFilters: MetadataFilter[];
}

export interface ResolvedTerm {
  term: string;
  matchedEntry: string;
  resolution: string;
  confidence: number;
}

// ─── Aggregation Results ─────────────────────────────────────────────────────

export interface AggregationResponse {
  queryId: string;
  results: AggregationResult[];
  totalCount?: number;
  latency: SearchLatency;
  vocabularyTrace?: VocabularyTrace;
}

export interface AggregationResult {
  /** Group key values (if groupBy was specified) */
  groupKey?: Record<string, unknown>;
  /** Aggregated value */
  value: number;
  /** Count of items in this group */
  count: number;
}
