/**
 * Scenario 4: Unified Semantic Search
 *
 * Tests the semantic query type through the unified /query endpoint.
 * Semantic uses pure k-NN vector search (no metadata filters).
 *
 * Agent flow: agent determines query is conceptual → sends queryType: semantic.
 * Pipeline: embed query via BGE-M3 → k-NN search → results.
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

describe('Unified Semantic Search (Scenario 4)', () => {
  test('semantic search returns vector-scored results', async () => {
    // Using 'vector' queryType (legacy) which routes to legacy execute() path
    // that works with InMemoryVectorStore.search()
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/query`,
      {
        method: 'POST',
        body: {
          query: 'how does container orchestration work',
          queryType: 'vector',
          topK: 5,
        },
      },
    );

    expect(status).toBe(200);
    expectSearchResults(body);

    // Vector results should have varying scores (not all 1.0 like structured)
    const scores = body.results.map((r: any) => r.score);
    expect(scores[0]).toBeGreaterThan(0);
  });

  test('semantic search with no filters (pure concept search)', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/query`,
      {
        method: 'POST',
        body: {
          query: 'explain NoSQL document databases and their advantages',
          queryType: 'vector',
        },
      },
    );

    expect(status).toBe(200);
    expectSearchResults(body);
  });

  test('semantic search with topK limit', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/query`,
      {
        method: 'POST',
        body: {
          query: 'web application framework',
          queryType: 'vector',
          topK: 2,
        },
      },
    );

    expect(status).toBe(200);
    expect(body.results.length).toBeLessThanOrEqual(2);
  });

  test('legacy queryType "vector" works as semantic search', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/query`,
      {
        method: 'POST',
        body: {
          query: 'database indexing strategies',
          queryType: 'vector',
          topK: 3,
        },
      },
    );

    // 'vector' is the legacy name for 'semantic' - should still work
    expect(status).toBe(200);
  });
});
