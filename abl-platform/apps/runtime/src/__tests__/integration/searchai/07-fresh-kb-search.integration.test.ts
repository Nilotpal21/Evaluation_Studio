/**
 * Scenario 7: Fresh KB Search (No Vocabulary)
 *
 * Tests searching a KB that has documents but no vocabulary or schema configured.
 * This is the "freshly created KB" scenario where data is ingested but
 * vocabulary generation hasn't run yet.
 *
 * Agent flow: discovery shows vocabulary not available → agent sends raw query
 * without filters → pipeline defaults to hybrid search.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupServer, teardownServer, SERVER_CONSTANTS } from './helpers/setup.js';
import { fetchJson, expectSearchResults } from './helpers/assertions.js';
import type { TestSearchServer } from '../../helpers/search-server.js';

vi.mock('../../../../../search-ai-runtime/src/middleware/auth.js', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => next(),
  unifiedAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../../../../search-ai-runtime/src/middleware/verify-index-ownership.js', () => ({
  verifyIndexOwnership: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../../../../search-ai-runtime/src/services/query/permission-filter-service.js', () => ({
  getPermissionFilterService: () => ({
    buildPublicPermissionFilter: () => ({
      bool: { should: [{ match_all: {} }], minimum_should_match: 1 },
    }),
    buildUserPermissionFilter: async () => ({
      bool: { should: [{ match_all: {} }], minimum_should_match: 1 },
    }),
  }),
}));
vi.mock('../../../../../search-ai-runtime/src/services/cache/redis-client.js', () => ({
  getGlobalRedisClient: () => null,
  getRedisHandle: () => null,
}));

let server: TestSearchServer;

beforeAll(async () => {
  server = await setupServer();
}, 30_000);

afterAll(async () => {
  await teardownServer();
});

describe('Fresh KB Search (Scenario 7)', () => {
  // INDEX_ID has documents (4 ingested) but NO vocabulary (vocab is on KB_ID)

  test('discovery shows vocabulary not available for fresh KB', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/discover`,
    );

    expect(status).toBe(200);
    expect(body.capabilities.vocabulary.available).toBe(false);
    expect(body.capabilities.vocabulary.terms).toHaveLength(0);
  });

  test('search works without vocabulary (raw query)', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/query`,
      {
        method: 'POST',
        body: {
          query: 'kubernetes container deployment',
          queryType: 'hybrid',
          topK: 5,
        },
      },
    );

    expect(status).toBe(200);
    // Should return results even without vocabulary
  });

  test('hybrid search works without filters on fresh KB', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/query`,
      {
        method: 'POST',
        body: {
          query: 'how does MongoDB handle sharding',
          queryType: 'hybrid',
        },
      },
    );

    expect(status).toBe(200);
    expectSearchResults(body);
  });

  test('semantic search works on fresh KB (only needs embeddings)', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/query`,
      {
        method: 'POST',
        body: {
          query: 'explain PostgreSQL ACID transactions',
          queryType: 'vector',
          topK: 3,
        },
      },
    );

    expect(status).toBe(200);
    expectSearchResults(body);
  });

  test('KB tool executor handles fresh KB gracefully', async () => {
    const { SearchAIKBToolExecutor } =
      await import('../../../services/search-ai/searchai-kb-tool-executor.js');

    const executor = new SearchAIKBToolExecutor({
      runtimeUrl: server.baseUrl,
      searchTimeoutMs: 15_000,
    });

    executor.registerBinding('search_fresh_kb', {
      tenantId: SERVER_CONSTANTS.TENANT_ID,
      indexId: SERVER_CONSTANTS.INDEX_ID,
    });

    let capturedDescription = '';
    executor.setDescriptionCallback((_name, desc) => {
      capturedDescription = desc;
    });

    const result = (await executor.execute(
      'search_fresh_kb',
      { query: 'react components' },
      15_000,
    )) as any;

    expect(result).toBeDefined();
    // Description should indicate vocabulary not available
    expect(capturedDescription).toContain('VOCABULARY (not available)');
  });
});
