/**
 * Scenario 3: Structured Search
 *
 * Tests structured (filter-based) search via the /structured endpoint.
 * Structured uses MongoDB queries on SearchChunk.canonicalMetadata.
 *
 * Note: Unified /query endpoint with queryType: 'structured' requires
 * HybridSearchBuilder + VectorStoreProvider.executeQuery which the test
 * server doesn't have. This test uses the dedicated /structured route.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupServer, teardownServer, SERVER_CONSTANTS } from './helpers/setup.js';
import { fetchJson } from './helpers/assertions.js';
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

describe('Structured Search (Scenario 3)', () => {
  test('structured search with explicit filters via /structured route', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/structured`,
      {
        method: 'POST',
        body: {
          filters: [{ field: 'category', operator: 'eq', value: 'devops' }],
          limit: 10,
        },
      },
    );

    expect(status).toBe(200);
    expect(body.results).toBeDefined();
  });

  test('structured search returns results with score 1.0 (no relevance ranking)', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/structured`,
      {
        method: 'POST',
        body: {
          filters: [{ field: 'category', operator: 'eq', value: 'database' }],
          limit: 5,
        },
      },
    );

    expect(status).toBe(200);
    if (body.results?.length > 0) {
      // Structured results have fixed score of 1.0
      expect(body.results[0].score).toBe(1.0);
    }
  });

  test('structured search with multiple filters (AND combined)', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/structured`,
      {
        method: 'POST',
        body: {
          filters: [
            { field: 'category', operator: 'eq', value: 'devops' },
            { field: 'difficulty', operator: 'eq', value: 'advanced' },
          ],
          limit: 10,
        },
      },
    );

    expect(status).toBe(200);
  });

  test('structured search requires at least one filter', async () => {
    const { status } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/structured`,
      {
        method: 'POST',
        body: {
          filters: [],
        },
      },
    );

    expect(status).toBe(400);
  });

  test('structured search returns latency breakdown', async () => {
    const { body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/structured`,
      {
        method: 'POST',
        body: {
          filters: [{ field: 'category', operator: 'eq', value: 'frontend' }],
        },
      },
    );

    expect(body.latency).toBeDefined();
    expect(typeof body.latency.totalMs).toBe('number');
  });
});
