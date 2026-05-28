/**
 * Scenario 2: Unified Hybrid Search
 *
 * Tests the hybrid query type through the unified /query endpoint.
 * Hybrid combines k-NN vector search with metadata filters.
 *
 * Agent flow: agent provides queryType + filters + query text.
 * Pipeline: permission filter → embed query → k-NN + filters → results.
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

describe('Unified Hybrid Search (Scenario 2)', () => {
  test('returns results for hybrid query with filters', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/query`,
      {
        method: 'POST',
        body: {
          query: 'kubernetes container orchestration',
          queryType: 'hybrid',
          topK: 5,
        },
      },
    );

    expect(status).toBe(200);
    expectSearchResults(body);
  });

  test('hybrid search with skipPreprocessing (agent flow)', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/query`,
      {
        method: 'POST',
        body: {
          query: 'react component lifecycle hooks',
          queryType: 'hybrid',
          skipPreprocessing: true,
          topK: 3,
        },
      },
    );

    expect(status).toBe(200);
    expectSearchResults(body);
  });

  test('hybrid search via legacy "vector" queryType', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/query`,
      {
        method: 'POST',
        body: {
          query: 'database replication strategies',
          queryType: 'vector',
          topK: 5,
        },
      },
    );

    // 'vector' routes to legacy execute() path which works with InMemoryVectorStore
    expect(status).toBe(200);
  });

  test('returns queryId and results in response', async () => {
    const { body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/query`,
      {
        method: 'POST',
        body: {
          query: 'postgresql indexing',
          queryType: 'hybrid',
        },
      },
    );

    expect(body.queryId).toBeDefined();
    expect(body.results).toBeDefined();
    expect(typeof body.totalCount).toBe('number');
  });
});
