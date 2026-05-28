/**
 * Deterministic Embedding Provider for Testing
 *
 * Generates consistent embeddings from text using word-level hashing.
 * Texts with similar words produce similar vectors (via cosine similarity).
 */

import type {
  EmbeddingProvider,
  EmbeddingResult,
} from '@agent-platform/search-ai-internal/embedding';

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'deterministic';
  readonly modelId = 'deterministic-32d';
  readonly dimensions = 32;
  readonly maxBatchSize = 100;

  async embed(text: string): Promise<number[]> {
    return this.textToVector(text);
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult> {
    return {
      embeddings: texts.map((t) => this.textToVector(t)),
      totalTokens: texts.reduce((sum, t) => sum + this.estimateTokens(t), 0),
      model: this.modelId,
      dimensions: this.dimensions,
    };
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: true, latencyMs: 0 };
  }

  /**
   * Convert text to a unit vector using word-level feature hashing.
   * Similar texts will produce similar vectors because overlapping words
   * hash to the same dimensions.
   */
  private textToVector(text: string): number[] {
    const words = text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);
    const vector = new Array(this.dimensions).fill(0);

    for (const word of words) {
      // Deterministic hash of the word
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
      }
      const dimIndex = Math.abs(hash) % this.dimensions;
      // Use sign of hash to allow positive and negative contributions
      vector[dimIndex] += hash > 0 ? 1 : -1;
    }

    // Normalize to unit vector
    const magnitude = Math.sqrt(vector.reduce((sum: number, v: number) => sum + v * v, 0));
    return magnitude > 0 ? vector.map((v: number) => v / magnitude) : vector;
  }
}
