/**
 * Intent Embedding Index
 *
 * Builds a vector index from intent patterns + examples,
 * then matches user messages via cosine similarity.
 */

import type { EmbeddingProvider, IndexEntry, SimilarityMatch } from './types.js';
import type { IntentDefinition, IntentResult } from '../types.js';
import type { EmbeddingIntentIndex } from '../engine.js';
import { cosineSimilarity } from '../utils.js';

// =============================================================================
// INTENT EMBEDDING INDEX
// =============================================================================

export class IntentEmbeddingIndex implements EmbeddingIntentIndex {
  private entries: IndexEntry[] = [];
  private provider: EmbeddingProvider;
  private threshold: number;
  private built = false;

  constructor(provider: EmbeddingProvider, threshold: number = 0.85) {
    this.provider = provider;
    this.threshold = threshold;
  }

  /**
   * Build the index from intent definitions.
   * Embeds all patterns and examples for each intent.
   */
  async build(intents: IntentDefinition[]): Promise<void> {
    const texts: string[] = [];
    const labels: string[] = [];

    for (const intent of intents) {
      // Add patterns
      for (const pattern of intent.patterns) {
        texts.push(pattern);
        labels.push(intent.name);
      }

      // Add examples
      if (intent.examples) {
        for (const example of intent.examples) {
          texts.push(example);
          labels.push(intent.name);
        }
      }
    }

    if (texts.length === 0) return;

    // Batch embed all texts
    const embeddings = await this.provider.embed(texts);

    this.entries = texts.map((text, i) => ({
      text,
      label: labels[i],
      embedding: embeddings[i],
    }));

    this.built = true;
  }

  /**
   * Find the best matching intent for a message
   */
  async match(message: string): Promise<IntentResult | null> {
    if (!this.built || this.entries.length === 0) return null;

    const [messageEmb] = await this.provider.embed([message]);

    let bestMatch: SimilarityMatch = { label: '', score: 0, text: '' };

    for (const entry of this.entries) {
      const score = cosineSimilarity(messageEmb, entry.embedding);
      if (score > bestMatch.score) {
        bestMatch = { label: entry.label, score, text: entry.text };
      }
    }

    if (bestMatch.score >= this.threshold) {
      return {
        intent: bestMatch.label,
        confidence: bestMatch.score,
        source: 'embedding',
      };
    }

    return null;
  }

  /**
   * Get top-N matches for analysis/debugging
   */
  async matchTopN(message: string, n: number = 5): Promise<SimilarityMatch[]> {
    if (!this.built || this.entries.length === 0) return [];

    const [messageEmb] = await this.provider.embed([message]);

    const scores: SimilarityMatch[] = this.entries.map((entry) => ({
      label: entry.label,
      score: cosineSimilarity(messageEmb, entry.embedding),
      text: entry.text,
    }));

    return scores.sort((a, b) => b.score - a.score).slice(0, n);
  }

  /**
   * Check if the index has been built
   */
  isBuilt(): boolean {
    return this.built;
  }

  /**
   * Get the number of indexed entries
   */
  get size(): number {
    return this.entries.length;
  }
}
