/**
 * Test Data Factory - Helper to create test data via HTTP APIs
 */

const SEARCH_AI_URL = process.env.SEARCH_AI_URL || 'http://localhost:3113';

export class TestDataFactory {
  /**
   * Create a test SearchIndex via API
   */
  async createTestIndex(tenantId: string, overrides?: Partial<any>) {
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(7);
    const slug = `test-kb-${timestamp}`;
    const collectionName = `test-collection-${timestamp}-${randomSuffix}`;

    const response = await fetch(`${SEARCH_AI_URL}/api/indexes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': tenantId,
      },
      body: JSON.stringify({
        projectId: 'test-project',
        slug,
        name: 'Test Knowledge Base',
        description: 'Test KB for E2E tests',
        embeddingModel: 'bge-m3',
        embeddingDimensions: 1024,
        vectorStore: {
          provider: 'opensearch',
          collectionName,
        },
        searchDefaults: {
          topK: 10,
          similarityThreshold: 0.7,
          includeMetadata: true,
          includeContent: true,
        },
        ...overrides,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create index: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const index = data.index;
    console.log(`[TestFactory] Created test index: ${index._id}`);
    return index;
  }

  /**
   * Create a test SearchSource via API
   */
  async createTestSource(tenantId: string, indexId: string, overrides?: Partial<any>) {
    const response = await fetch(`${SEARCH_AI_URL}/api/indexes/${indexId}/sources`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': tenantId,
      },
      body: JSON.stringify({
        name: 'Test File Upload',
        sourceType: 'file',
        ...overrides,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create source: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const source = data.source;
    console.log(`[TestFactory] Created test source: ${source._id}`);
    return source;
  }

  /**
   * Generate a unique test tenant ID
   */
  generateTenantId(): string {
    return `test-tenant-${Date.now()}`;
  }
}
