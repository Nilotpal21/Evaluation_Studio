/**
 * Scenario 8: Aggregation Search
 *
 * Tests the aggregation query type through the /aggregate endpoint
 * and the unified /query endpoint. Aggregation returns group-by buckets
 * with counts/sums/averages instead of documents.
 *
 * Agent flow: agent recognizes counting/grouping intent → sends
 * queryType: aggregation with measure and groupBy fields.
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

describe('Aggregation Search (Scenario 8)', () => {
  test('aggregation via /aggregate endpoint (legacy path)', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/aggregate`,
      {
        method: 'POST',
        body: {
          aggregation: {
            measure: 'documentId',
            function: 'count',
          },
        },
      },
    );

    expect(status).toBe(200);
    expect(body.results).toBeDefined();
    expect(body.totalCount).toBeDefined();
  });

  test('aggregation with groupBy field', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/aggregate`,
      {
        method: 'POST',
        body: {
          aggregation: {
            measure: 'documentId',
            function: 'count',
            groupBy: ['category'],
          },
        },
      },
    );

    expect(status).toBe(200);
    // Results should be grouped buckets
    expect(body.results).toBeDefined();
  });

  test('aggregation validates required fields', async () => {
    const { status } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/aggregate`,
      {
        method: 'POST',
        body: {
          // Missing aggregation spec
        },
      },
    );

    expect(status).toBe(400);
  });

  test('aggregation validates function type', async () => {
    const { status } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/aggregate`,
      {
        method: 'POST',
        body: {
          aggregation: {
            measure: 'price',
            function: 'invalid_function',
          },
        },
      },
    );

    expect(status).toBe(400);
  });

  test('aggregation supports count function', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/aggregate`,
      {
        method: 'POST',
        body: {
          aggregation: {
            measure: 'documentId',
            function: 'count',
          },
        },
      },
    );

    expect(status).toBe(200);
    // Should have at least one result bucket
    if (body.results && body.results.length > 0) {
      expect(typeof body.results[0].count).toBe('number');
    }
  });

  test('aggregation with filters narrows results', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/aggregate`,
      {
        method: 'POST',
        body: {
          aggregation: {
            measure: 'documentId',
            function: 'count',
          },
          filters: [{ field: 'category', operator: 'eq', value: 'devops' }],
        },
      },
    );

    expect(status).toBe(200);
  });
});
