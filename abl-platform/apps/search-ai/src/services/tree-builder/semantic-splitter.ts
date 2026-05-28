/**
 * Semantic Splitter
 *
 * Groups semantically similar chunks using cosine similarity.
 * Splits when similarity drops below threshold (indicating topic shift).
 */

export interface SemanticSplitConfig {
  /** Similarity threshold for grouping (0-1) */
  similarityThreshold: number;
  /** Embedding dimension */
  embeddingDim: number;
}

export interface ChunkWithEmbedding {
  text: string;
  embedding: number[];
  tokenCount: number;
}

export interface SemanticGroup {
  chunks: ChunkWithEmbedding[];
  avgSimilarity: number;
}

export class SemanticSplitter {
  private config: SemanticSplitConfig;

  constructor(config: Partial<SemanticSplitConfig> = {}) {
    this.config = {
      similarityThreshold: config.similarityThreshold ?? 0.7,
      embeddingDim: config.embeddingDim ?? 1536, // OpenAI default
    };
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0) return 0;

    return dotProduct / magnitude;
  }

  /**
   * Split chunks into semantic groups based on similarity
   */
  splitIntoGroups(chunks: ChunkWithEmbedding[]): SemanticGroup[] {
    if (chunks.length === 0) return [];
    if (chunks.length === 1) {
      return [{ chunks, avgSimilarity: 1.0 }];
    }

    const groups: SemanticGroup[] = [];
    let currentGroup: ChunkWithEmbedding[] = [chunks[0]];
    let similarities: number[] = [];

    for (let i = 1; i < chunks.length; i++) {
      const prevChunk = chunks[i - 1];
      const currentChunk = chunks[i];

      const similarity = this.cosineSimilarity(prevChunk.embedding, currentChunk.embedding);

      // If similarity drops below threshold, start new group
      if (similarity < this.config.similarityThreshold) {
        groups.push({
          chunks: currentGroup,
          avgSimilarity:
            similarities.length > 0
              ? similarities.reduce((a, b) => a + b, 0) / similarities.length
              : 1.0,
        });
        currentGroup = [currentChunk];
        similarities = [];
      } else {
        currentGroup.push(currentChunk);
        similarities.push(similarity);
      }
    }

    // Add final group
    if (currentGroup.length > 0) {
      groups.push({
        chunks: currentGroup,
        avgSimilarity:
          similarities.length > 0
            ? similarities.reduce((a, b) => a + b, 0) / similarities.length
            : 1.0,
      });
    }

    return groups;
  }

  /**
   * Calculate average embedding for a group (centroid)
   */
  calculateCentroid(embeddings: number[][]): number[] {
    if (embeddings.length === 0) {
      return new Array(this.config.embeddingDim).fill(0);
    }

    const centroid = new Array(this.config.embeddingDim).fill(0);

    for (const embedding of embeddings) {
      for (let i = 0; i < embedding.length; i++) {
        centroid[i] += embedding[i];
      }
    }

    // Average
    for (let i = 0; i < centroid.length; i++) {
      centroid[i] /= embeddings.length;
    }

    return centroid;
  }

  /**
   * Merge text from chunks in a group
   */
  static mergeGroup(group: SemanticGroup): string {
    return group.chunks.map((c) => c.text).join('\n\n');
  }

  /**
   * Get total token count for a group
   */
  static getGroupTokenCount(group: SemanticGroup): number {
    return group.chunks.reduce((sum, c) => sum + c.tokenCount, 0);
  }
}
