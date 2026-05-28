/**
 * Entity Embedding Index
 *
 * Uses embeddings for similarity-based entity value matching.
 * Useful for enum entities with many values + synonyms.
 */

import type { EmbeddingProvider, IndexEntry, SimilarityMatch } from './types.js';
import type { EntityDefinition } from '../types.js';
import { cosineSimilarity } from '../utils.js';

// =============================================================================
// ENTITY EMBEDDING INDEX
// =============================================================================

export class EntityEmbeddingIndex {
  private indices: Map<string, IndexEntry[]> = new Map();
  private provider: EmbeddingProvider;
  private threshold: number;
  private built = false;

  constructor(provider: EmbeddingProvider, threshold: number = 0.8) {
    this.provider = provider;
    this.threshold = threshold;
  }

  /**
   * Build index from entity definitions.
   * Indexes values + synonyms for each entity type.
   */
  async build(entities: EntityDefinition[]): Promise<void> {
    for (const entity of entities) {
      if (entity.type !== 'enum' || !entity.values) continue;

      const texts: string[] = [];
      const labels: string[] = [];

      for (const value of entity.values) {
        // Index the canonical value
        texts.push(value);
        labels.push(value);

        // Index synonyms mapped to canonical
        if (entity.synonyms?.[value]) {
          for (const synonym of entity.synonyms[value]) {
            texts.push(synonym);
            labels.push(value); // Maps back to canonical
          }
        }
      }

      if (texts.length > 0) {
        const embeddings = await this.provider.embed(texts);
        const entries = texts.map((text, i) => ({
          text,
          label: labels[i],
          embedding: embeddings[i],
        }));
        this.indices.set(entity.name, entries);
      }
    }

    this.built = true;
  }

  /**
   * Match a user mention against an entity's value set.
   * Returns the canonical value (resolving synonyms).
   */
  async match(entityName: string, mention: string): Promise<SimilarityMatch | null> {
    const entries = this.indices.get(entityName);
    if (!entries || entries.length === 0) return null;

    const [mentionEmb] = await this.provider.embed([mention]);

    let best: SimilarityMatch = { label: '', score: 0, text: '' };

    for (const entry of entries) {
      const score = cosineSimilarity(mentionEmb, entry.embedding);
      if (score > best.score) {
        best = { label: entry.label, score, text: entry.text };
      }
    }

    if (best.score >= this.threshold) {
      return best;
    }

    return null;
  }

  /**
   * Match across all indexed entities
   */
  async matchAll(mention: string): Promise<Map<string, SimilarityMatch>> {
    const results = new Map<string, SimilarityMatch>();

    for (const entityName of this.indices.keys()) {
      const match = await this.match(entityName, mention);
      if (match) {
        results.set(entityName, match);
      }
    }

    return results;
  }

  /**
   * Check if index has been built
   */
  isBuilt(): boolean {
    return this.built;
  }

  /**
   * Get indexed entity names
   */
  getIndexedEntities(): string[] {
    return [...this.indices.keys()];
  }
}
