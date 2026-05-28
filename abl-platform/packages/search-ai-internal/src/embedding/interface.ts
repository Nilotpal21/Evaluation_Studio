/**
 * Embedding Provider Interface
 *
 * Abstract interface for embedding providers (OpenAI, Cohere, etc.).
 * Implementations handle API calls, batching, and rate limiting.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EmbeddingRequest {
  /** Text(s) to embed */
  texts: string[];
  /** Optional model override */
  model?: string;
}

export interface EmbeddingResult {
  /** Embedding vectors (one per input text) */
  embeddings: number[][];
  /** Token count for the request */
  totalTokens: number;
  /** Model used */
  model: string;
  /** Dimensions of each vector */
  dimensions: number;
}

export interface EmbeddingProviderConfig {
  /** API key */
  apiKey: string;
  /** Model name */
  model: string;
  /** Vector dimensions (for models that support variable dimensions) */
  dimensions?: number;
  /** Maximum texts per batch request */
  maxBatchSize?: number;
  /** Request timeout in ms */
  timeoutMs?: number;
  /** Base URL override */
  baseUrl?: string;
}

// ─── Provider Interface ─────────────────────────────────────────────────────

export interface EmbeddingProvider {
  /** Provider name (e.g., 'openai', 'cohere') */
  readonly name: string;

  /** Model ID being used */
  readonly modelId: string;

  /** Dimensions of produced vectors */
  readonly dimensions: number;

  /** Maximum batch size supported */
  readonly maxBatchSize: number;

  /** Embed a single text */
  embed(text: string): Promise<number[]>;

  /** Embed multiple texts in batch */
  embedBatch(texts: string[]): Promise<EmbeddingResult>;

  /** Estimate token count for text (without calling API) */
  estimateTokens(text: string): number;

  /** Health check */
  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;

  /** Optional cleanup method */
  close?(): Promise<void>;
}
