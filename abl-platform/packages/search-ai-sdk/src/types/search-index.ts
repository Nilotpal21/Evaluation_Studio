/**
 * Search Index Types
 */

import type { IndexStatus } from '../constants.js';

export interface SearchIndexConfig {
  /** Embedding model to use for this index */
  embeddingModel: string;
  /** Embedding vector dimensions */
  embeddingDimensions: number;
  /** Chunking strategy */
  chunkStrategy: ChunkStrategy;
  /** Vector store backend */
  vectorStore: VectorStoreConfig;
  /** Default search parameters */
  searchDefaults: SearchDefaults;
}

export interface ChunkStrategy {
  method: 'fixed' | 'semantic' | 'sliding_window';
  chunkSize: number;
  chunkOverlap: number;
  /** Separator for splitting (for fixed strategy) */
  separator?: string;
}

export interface VectorStoreConfig {
  provider: 'qdrant' | 'pinecone' | 'pgvector';
  /** Collection/index name in the vector store */
  collectionName: string;
  /** Provider-specific connection config */
  connectionConfig?: Record<string, unknown>;
}

export interface SearchDefaults {
  topK: number;
  similarityThreshold: number;
  /** Whether to include metadata in results */
  includeMetadata: boolean;
  /** Whether to include the chunk content in results */
  includeContent: boolean;
  /** Reranker to use (if any) */
  reranker?: RerankerConfig;
}

export interface RerankerConfig {
  provider: 'cohere' | 'cross-encoder';
  model?: string;
  topN?: number;
}

export interface SearchIndexSummary {
  id: string;
  tenantId: string;
  projectId: string;
  slug: string;
  name: string;
  description: string | null;
  status: IndexStatus;
  documentCount: number;
  chunkCount: number;
  sourceCount: number;
  embeddingModel: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchIndexDetail extends SearchIndexSummary {
  config: SearchIndexConfig;
  lastIndexedAt: string | null;
  indexError: string | null;
}
