/**
 * Scenario 5: Vocabulary Resolution via Resolve Endpoint
 *
 * Tests the /resolve endpoint that maps business terms to structured filters.
 * This is the static VocabularyResolver path (exact/alias/fuzzy matching).
 *
 * Agent flow: agent calls vocabulary_resolve before search to get filters,
 * then uses those filters in the search call.
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

describe('Vocabulary Resolution (Scenario 5)', () => {
  test('resolves known vocabulary term to structured filter', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.KB_ID}/resolve`,
      {
        method: 'POST',
        body: { query: 'show me devops tools', mode: 'alias' },
      },
    );

    expect(status).toBe(200);
    expect(body.originalQuery).toBe('show me devops tools');
    expect(body.resolvedTerms.length).toBeGreaterThan(0);

    // Should have resolved 'devops tools' to a filter
    const devopsTerm = body.resolvedTerms.find(
      (t: any) => t.canonicalTerm === 'devops tools' || t.inputTerm === 'devops tools',
    );
    expect(devopsTerm).toBeDefined();
  });

  test('resolves alias to vocabulary term', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.KB_ID}/resolve`,
      {
        method: 'POST',
        body: { query: 'infrastructure monitoring', mode: 'alias' },
      },
    );

    expect(status).toBe(200);
    // 'infrastructure' is an alias for 'devops tools'
    expect(body.resolvedTerms.length).toBeGreaterThan(0);
  });

  test('returns unresolved segments for unknown terms', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.KB_ID}/resolve`,
      {
        method: 'POST',
        body: { query: 'something completely unrelated', mode: 'exact' },
      },
    );

    expect(status).toBe(200);
    expect(body.unresolvedSegments.length).toBeGreaterThan(0);
  });

  test('returns structured filters that can be used in search', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.KB_ID}/resolve`,
      {
        method: 'POST',
        body: { query: 'devops tools overview', mode: 'alias' },
      },
    );

    expect(status).toBe(200);

    if (body.structuredFilters?.length > 0) {
      const filter = body.structuredFilters[0];
      expect(filter.field).toBeDefined();
      expect(filter.operator).toBeDefined();
      expect(filter.value).toBeDefined();
    }
  });

  test('vocabulary resolve then search (two-step agent pattern)', async () => {
    // Step 1: Resolve vocabulary
    const resolveResult = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.KB_ID}/resolve`,
      {
        method: 'POST',
        body: { query: 'advanced content about databases', mode: 'alias' },
      },
    );
    expect(resolveResult.status).toBe(200);

    // Step 2: Use resolved filters in hybrid search via legacy path
    const searchResult = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/query`,
      {
        method: 'POST',
        body: {
          query: 'advanced content about databases',
          queryType: 'hybrid',
          filters: resolveResult.body.structuredFilters || [],
        },
      },
    );
    expect(searchResult.status).toBe(200);
  });

  test('rejects invalid mode', async () => {
    const { status } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.KB_ID}/resolve`,
      {
        method: 'POST',
        body: { query: 'test', mode: 'invalid' },
      },
    );

    expect(status).toBe(400);
  });
});
