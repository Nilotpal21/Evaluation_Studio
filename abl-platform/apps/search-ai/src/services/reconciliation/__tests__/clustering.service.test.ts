import { describe, it, expect } from 'vitest';
import { ClusteringService } from '../clustering.service.js';

describe('ClusteringService', () => {
  const service = new ClusteringService();

  describe('cosineSimilarity', () => {
    it('returns 1 for identical vectors', () => {
      expect(ClusteringService.cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    });

    it('returns 0 for orthogonal vectors', () => {
      expect(ClusteringService.cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    });

    it('returns -1 for opposite vectors', () => {
      expect(ClusteringService.cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    });

    it('returns 0 for zero-magnitude vector', () => {
      expect(ClusteringService.cosineSimilarity([0, 0], [1, 0])).toBeCloseTo(0);
    });
  });

  describe('buildCosineDistanceMatrix', () => {
    it('produces symmetric zero-diagonal matrix', () => {
      const embeddings = [
        [1, 0, 0],
        [0, 1, 0],
      ];
      const matrix = ClusteringService.buildCosineDistanceMatrix(embeddings);
      expect(matrix[0][0]).toBeCloseTo(0);
      expect(matrix[1][1]).toBeCloseTo(0);
      expect(matrix[0][1]).toBeCloseTo(matrix[1][0]);
      // orthogonal => distance = 1
      expect(matrix[0][1]).toBeCloseTo(1);
    });
  });

  describe('cluster', () => {
    it('returns empty array for empty input', () => {
      expect(service.cluster([], 0.2)).toEqual([]);
    });

    it('returns single cluster for single item', () => {
      expect(service.cluster([[1, 0, 0]], 0.2)).toEqual([[0]]);
    });

    it('clusters identical embeddings together', () => {
      const embeddings = [
        [1, 0, 0],
        [1, 0, 0],
        [0, 0, 1],
      ];
      const clusters = service.cluster(embeddings, 0.2);
      // First two should cluster, third separate
      const clusterOf0 = clusters.find((c: number[]) => c.includes(0));
      expect(clusterOf0).toContain(1);
      const clusterOf2 = clusters.find((c: number[]) => c.includes(2));
      expect(clusterOf2).not.toContain(0);
    });

    it('separates distant embeddings', () => {
      const embeddings = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];
      const clusters = service.cluster(embeddings, 0.2);
      // All orthogonal — distance = 1.0, threshold = 0.2, all separate
      expect(clusters.length).toBe(3);
    });

    it('respects distance threshold', () => {
      // Two similar vectors (cosine ~0.95, distance ~0.05)
      const a = [1, 0.1, 0];
      const b = [1, 0.2, 0];
      // One distant vector
      const c = [0, 0, 1];
      const clusters = service.cluster([a, b, c], 0.2);
      const clusterOfA = clusters.find((cl: number[]) => cl.includes(0));
      expect(clusterOfA).toContain(1); // a and b cluster
      expect(clusters.find((cl: number[]) => cl.includes(2))).not.toContain(0); // c separate
    });

    it('prevents transitive chain merges with complete linkage', () => {
      // Chain: A-B similar, B-C similar, but A-C NOT similar
      // Complete linkage should NOT merge A and C
      const A = [1, 0, 0, 0];
      const B = [0.7, 0.7, 0, 0]; // similar to A and C
      const C = [0, 1, 0, 0];

      // Cosine distance: A-B ~ 0.29, B-C ~ 0.29, A-C ~ 1.0
      // With threshold 0.35: single linkage would merge all 3
      // Complete linkage requires ALL pairs within threshold
      const clusters = service.cluster([A, B, C], 0.35);
      // A and C should NOT be in the same cluster
      const clusterOfA = clusters.find((cl: number[]) => cl.includes(0));
      expect(clusterOfA).not.toContain(2);
    });
  });
});
