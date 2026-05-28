/**
 * Embedding Types
 *
 * Interfaces for embedding providers and vector similarity operations.
 */

/**
 * Embedding provider interface
 */
export interface EmbeddingProvider {
  /** Generate embeddings for one or more texts */
  embed(texts: string[]): Promise<number[][]>;

  /** Embedding vector dimension */
  readonly dimension: number;

  /** Model identifier */
  readonly model: string;
}

/**
 * Configuration for creating an embedding provider
 */
export interface EmbeddingProviderConfig {
  provider: 'litellm' | 'openai' | 'local';
  model: string;
  baseUrl?: string;
  apiKey?: string;
  dimension?: number;
}

/**
 * Indexed entry for similarity search
 */
export interface IndexEntry {
  text: string;
  label: string;
  embedding: number[];
}

/**
 * Similarity match result
 */
export interface SimilarityMatch {
  label: string;
  score: number;
  text: string;
}
