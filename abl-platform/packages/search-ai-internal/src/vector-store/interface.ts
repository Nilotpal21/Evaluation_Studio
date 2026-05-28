/**
 * Vector Store Provider Interface
 *
 * Abstract interface for vector storage backends (Qdrant, Pinecone, pgvector).
 * Implementations handle connection management and query translation.
 */

import type { MetadataFilter } from '@agent-platform/search-ai-sdk/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VectorRecord {
  /** Unique ID for this vector */
  id: string;
  /** Embedding vector */
  vector: number[];
  /** Metadata to store alongside the vector */
  metadata?: Record<string, unknown>;
  /** Optional text content for hybrid search */
  content?: string;
  /** Document-level permissions (IdP-based access control) */
  permissions?: {
    publicEverywhere: boolean;
    publicInDomain: boolean;
    allowedUsers: string[];
    allowedGroups: string[];
    allowedDomains: string[];
    source: string;
    lastSyncedAt: string;
  };
}

export interface VectorSearchParams {
  /** Query vector */
  vector: number[];
  /** Maximum results */
  topK: number;
  /** Minimum similarity score (0-1) */
  scoreThreshold?: number;
  /** Metadata filters to apply */
  filters?: MetadataFilter[];
  /** Include vector data in results */
  includeVectors?: boolean;
  /** Include metadata in results */
  includeMetadata?: boolean;
}

export interface HybridSearchParams extends VectorSearchParams {
  /** Original query text for BM25 matching */
  queryText: string;
  /** Fusion strategy for combining vector and keyword scores */
  fusion?: {
    /** Method: 'rrf' (Reciprocal Rank Fusion) or 'rsf' (Relative Score Fusion) */
    method: 'rrf' | 'rsf';
    /** For RRF: rank constant (default 60) */
    rankConstant?: number;
    /** For RSF: alpha weight for vector score, 0.7 = 70% vector + 30% keyword (default 0.7) */
    alpha?: number;
  };
}

export interface VectorSearchResult {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
  vector?: number[];
  content?: string;
}

export interface CollectionConfig {
  /** Collection/index name */
  name: string;
  /** Vector dimensions */
  dimensions: number;
  /** Distance metric */
  distance: 'cosine' | 'euclidean' | 'dot_product';
  /** Metadata field indexes for filtering */
  metadataIndexes?: MetadataIndexConfig[];
}

export interface MetadataIndexConfig {
  field: string;
  type: 'keyword' | 'integer' | 'float' | 'bool';
}

export interface CollectionInfo {
  name: string;
  vectorCount: number;
  dimensions: number;
  distance: string;
  status: 'ready' | 'indexing' | 'error';
}

// ─── Provider Interface ─────────────────────────────────────────────────────

export interface VectorStoreProvider {
  /** Provider name (e.g., 'qdrant', 'pinecone') */
  readonly name: string;

  /** Create a collection/index */
  createCollection(config: CollectionConfig): Promise<void>;

  /** Delete a collection/index */
  deleteCollection(name: string): Promise<void>;

  /** Get collection info */
  getCollectionInfo(name: string): Promise<CollectionInfo | null>;

  /** Check if collection exists */
  collectionExists(name: string): Promise<boolean>;

  /** Upsert vectors (insert or update) */
  upsert(collection: string, records: VectorRecord[]): Promise<void>;

  /** Search for similar vectors */
  search(collection: string, params: VectorSearchParams): Promise<VectorSearchResult[]>;

  /**
   * Hybrid search combining vector similarity and keyword matching.
   * Optional - not all providers support this.
   * Requires OpenSearch 2.11+ for native RRF support.
   */
  hybridSearch?(collection: string, params: HybridSearchParams): Promise<VectorSearchResult[]>;

  /**
   * Execute an arbitrary query DSL body against the collection.
   * Optional - required for unified pipeline support (structured, aggregation, hybrid via HybridSearchBuilder).
   */
  executeQuery?(
    collection: string,
    body: Record<string, unknown>,
  ): Promise<{
    hits: Array<{ id: string; score: number; source: Record<string, unknown> }>;
    aggregations?: Record<string, unknown>;
    total: number;
  }>;

  /** Delete vectors by IDs */
  delete(collection: string, ids: string[]): Promise<void>;

  /** Delete vectors by metadata filter */
  deleteByFilter(collection: string, filters: MetadataFilter[]): Promise<void>;

  /** Get vectors by IDs */
  getByIds(collection: string, ids: string[]): Promise<VectorRecord[]>;

  /** Count vectors in a collection */
  count(collection: string): Promise<number>;

  /**
   * Ensure the hybrid search pipeline exists in the vector store.
   * Optional - only supported by OpenSearch 2.11+.
   * Creates the pipeline if missing; idempotent.
   */
  ensureHybridSearchPipeline?(pipelineName: string): Promise<void>;

  /** Health check */
  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;

  /** Close connection */
  close(): Promise<void>;
}
