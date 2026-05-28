/**
 * Embedding Provider Factory
 *
 * Creates embedding providers for different backends
 * (LiteLLM, OpenAI, local ONNX).
 */

import type { EmbeddingProvider, EmbeddingProviderConfig } from './types.js';

// =============================================================================
// LITELLM / OPENAI PROVIDER
// =============================================================================

/**
 * HTTP-based embedding provider.
 * Works with OpenAI-compatible APIs (OpenAI, LiteLLM, vLLM, etc.)
 */
class HTTPEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimension: number;
  private baseUrl: string;
  private apiKey?: string;

  constructor(config: EmbeddingProviderConfig) {
    this.model = config.model;
    this.dimension = config.dimension ?? 384;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.apiKey = config.apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/embeddings`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to match input order
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create an embedding provider from configuration
 */
export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'litellm':
    case 'openai':
      return new HTTPEmbeddingProvider(config);
    case 'local':
      // Local/ONNX provider - for now, falls back to HTTP
      return new HTTPEmbeddingProvider(config);
    default:
      return new HTTPEmbeddingProvider(config);
  }
}
