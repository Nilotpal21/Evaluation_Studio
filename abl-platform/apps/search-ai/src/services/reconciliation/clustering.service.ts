/**
 * Clustering Service
 *
 * Agglomerative hierarchical clustering over cosine-distance embeddings.
 * Uses ml-hclust (AGNES algorithm) with complete linkage.
 */

import { agnes, type Cluster } from 'ml-hclust';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('clustering-service');

export class ClusteringService {
  /**
   * Compute cosine similarity between two vectors.
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    // H4 fix: guard against mismatched vector lengths
    if (a.length !== b.length) {
      log.warn('Vector length mismatch in cosineSimilarity', {
        aLen: a.length,
        bLen: b.length,
      });
      return 0;
    }
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * Build a distance matrix (1 - cosine similarity) from embeddings.
   */
  static buildCosineDistanceMatrix(embeddings: number[][]): number[][] {
    const n = embeddings.length;
    const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dist = 1 - ClusteringService.cosineSimilarity(embeddings[i], embeddings[j]);
        matrix[i][j] = dist;
        matrix[j][i] = dist;
      }
    }
    return matrix;
  }

  /**
   * Cluster embeddings using agglomerative hierarchical clustering
   * with complete linkage and a distance threshold.
   *
   * Returns array of clusters, each cluster = array of original indices.
   */
  /** Max novels per clustering call. Beyond this, O(n²) distance matrix risks OOM. */
  static readonly MAX_CLUSTER_SIZE = 5000;

  cluster(embeddings: number[][], distanceThreshold: number): number[][] {
    if (embeddings.length === 0) return [];
    if (embeddings.length === 1) return [[0]];

    // H5 fix: cap input size to prevent O(n²) OOM (5000² = 25M entries ≈ 200MB)
    if (embeddings.length > ClusteringService.MAX_CLUSTER_SIZE) {
      log.warn('Clustering input exceeds max size — truncating', {
        actual: embeddings.length,
        max: ClusteringService.MAX_CLUSTER_SIZE,
      });
      embeddings = embeddings.slice(0, ClusteringService.MAX_CLUSTER_SIZE);
    }

    const distanceMatrix = ClusteringService.buildCosineDistanceMatrix(embeddings);

    // CRITICAL: isDistanceMatrix=true — input is precomputed distances
    const tree = agnes(distanceMatrix, {
      method: 'complete',
      isDistanceMatrix: true,
    });

    // Cut tree at threshold — returns Cluster[] objects
    const clusters = tree.cut(distanceThreshold);

    // Extract leaf indices from each cluster
    return clusters.map((c: Cluster) => c.indices());
  }
}
