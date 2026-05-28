/**
 * OpenSearch Assertions - Helper to assert OpenSearch state in tests
 */

import { expect } from 'vitest';
import { Client as OpenSearchClient } from '@opensearch-project/opensearch';

export class OpenSearchAssertions {
  constructor(private client: OpenSearchClient) {}

  /**
   * Assert that vectors exist for a document's chunks
   */
  async assertVectorsExist(
    indexName: string,
    tenantId: string,
    appId: string,
    documentId: string,
    expectedCount?: number,
  ) {
    const response = await this.client.search({
      index: indexName,
      body: {
        query: {
          bool: {
            filter: [
              { term: { 'metadata.sys.tenantId': tenantId } },
              { term: { 'metadata.sys.appId': appId } },
              { term: { 'metadata.sys.documentId': documentId } },
            ],
          },
        },
        size: 1000,
      },
    });

    const hits = response.body.hits.hits;

    expect(hits.length, 'At least one vector should exist').toBeGreaterThan(0);

    if (expectedCount !== undefined) {
      expect(hits.length, `Expected ${expectedCount} vectors`).toBe(expectedCount);
    }

    // Verify vector structure
    hits.forEach((hit: any, index: number) => {
      const source = hit._source;
      expect(source.vector, `Vector ${index} should have embedding`).toBeTruthy();
      expect(source.vector.length, `Vector ${index} should be 1024d`).toBe(1024);
      expect(source.content, `Vector ${index} should have content`).toBeTruthy();
      expect(source.metadata?.sys?.tenantId, `Vector ${index} should have tenantId`).toBe(tenantId);
      expect(source.metadata?.sys?.appId, `Vector ${index} should have appId`).toBe(appId);
      expect(source.metadata?.sys?.documentId, `Vector ${index} should have documentId`).toBe(
        documentId,
      );
    });

    console.log(`[OpenSearch] ✓ Found ${hits.length} vectors for document ${documentId}`);
    return hits;
  }

  /**
   * Assert that hybrid search returns results
   */
  async assertHybridSearchWorks(
    indexName: string,
    queryEmbedding: number[],
    filters: Record<string, any>,
    minResults = 1,
  ) {
    const response = await this.client.search({
      index: indexName,
      body: {
        size: 10,
        query: {
          bool: {
            must: [
              {
                knn: {
                  vector: {
                    vector: queryEmbedding,
                    k: 10,
                  },
                },
              },
            ],
            filter: Object.entries(filters).map(([key, value]) => ({
              term: { [key]: value },
            })),
          },
        },
      },
    });

    const hits = response.body.hits.hits;

    expect(hits.length, `Should return at least ${minResults} results`).toBeGreaterThanOrEqual(
      minResults,
    );

    // Verify scores are present and sorted
    hits.forEach((hit: any, index: number) => {
      expect(hit._score, `Result ${index} should have score`).toBeGreaterThan(0);
      if (index > 0) {
        expect(hit._score, 'Results should be sorted by score').toBeLessThanOrEqual(
          hits[index - 1]._score,
        );
      }
    });

    console.log(`[OpenSearch] ✓ Hybrid search returned ${hits.length} results`);
    return hits;
  }

  /**
   * Count vectors for a document
   */
  async countVectors(
    indexName: string,
    tenantId: string,
    appId: string,
    documentId: string,
  ): Promise<number> {
    const response = await this.client.count({
      index: indexName,
      body: {
        query: {
          bool: {
            filter: [
              { term: { 'metadata.sys.tenantId': tenantId } },
              { term: { 'metadata.sys.appId': appId } },
              { term: { 'metadata.sys.documentId': documentId } },
            ],
          },
        },
      },
    });

    return response.body.count;
  }

  /**
   * Check if index exists
   */
  async indexExists(indexName: string): Promise<boolean> {
    try {
      const response = await this.client.indices.exists({ index: indexName });
      return response.body;
    } catch {
      return false;
    }
  }
}
