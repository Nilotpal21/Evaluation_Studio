/**
 * Scenario 1: Discovery API
 *
 * Tests the GET /api/search/:indexId/discover endpoint that returns
 * a self-describing capability manifest for a knowledge base.
 *
 * This is the foundation of the KB-as-tool pattern: agents read this
 * manifest to understand what vocabulary, classification, filters, and
 * other capabilities are available.
 *
 * Real: MongoDB, Express routes, data aggregation
 * Mocked: Auth middleware (bypass)
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { setupServer, teardownServer, SERVER_CONSTANTS } from './helpers/setup.js';
import {
  fetchJson,
  expectDiscoveryManifest,
  expectCapabilityGuidance,
} from './helpers/assertions.js';
import type { TestSearchServer } from '../../helpers/search-server.js';

// Must mock auth before imports trigger module loading
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

import { vi } from 'vitest';

let server: TestSearchServer;

beforeAll(async () => {
  server = await setupServer();
}, 30_000);

afterAll(async () => {
  await teardownServer();
});

describe('Discovery API (Scenario 1)', () => {
  test('returns full manifest for KB with vocabulary and schema', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.KB_ID}/discover`,
    );

    expect(status).toBe(200);
    expectDiscoveryManifest(body);

    // KB metadata
    expect(body.kb.name).toBeDefined();
    expect(typeof body.kb.documentCount).toBe('number');
  });

  test('vocabulary capability includes only enabled terms', async () => {
    const { body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.KB_ID}/discover`,
    );

    const vocab = body.capabilities.vocabulary;
    expect(vocab.available).toBe(true);
    // 3 enabled terms (disabled_term filtered out)
    expect(vocab.terms.length).toBe(3);
    expect(vocab.terms.map((t: any) => t.term)).toContain('devops tools');
    expect(vocab.terms.map((t: any) => t.term)).toContain('total price');
    expect(vocab.terms.map((t: any) => t.term)).toContain('advanced content');
    // Disabled term should NOT be present
    expect(vocab.terms.map((t: any) => t.term)).not.toContain('disabled term');
  });

  test('vocabulary terms include field references and aliases', async () => {
    const { body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.KB_ID}/discover`,
    );

    const devopsTerm = body.capabilities.vocabulary.terms.find(
      (t: any) => t.term === 'devops tools',
    );
    expect(devopsTerm).toBeDefined();
    expect(devopsTerm.field).toBe('category');
    expect(devopsTerm.aliases).toContain('infrastructure');
    expect(devopsTerm.aliases).toContain('CI/CD');
    expect(devopsTerm.canFilter).toBe(true);
  });

  test('filter capability includes filterable schema fields with enum values', async () => {
    const { body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.KB_ID}/discover`,
    );

    const filters = body.capabilities.filters;
    expect(filters.available).toBe(true);
    // category, difficulty, price are filterable (title is not)
    expect(filters.fields.length).toBe(3);

    const categoryField = filters.fields.find((f: any) => f.name === 'category');
    expect(categoryField).toBeDefined();
    expect(categoryField.values).toContain('devops');
    expect(categoryField.values).toContain('frontend');

    expect(filters.operators).toContain('equals');
    expect(filters.operators).toContain('in');
  });

  test('classification capability includes examples', async () => {
    const { body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.KB_ID}/discover`,
    );

    const classification = body.capabilities.queryClassification;
    expect(classification.available).toBe(true);
    expect(classification.types).toBeDefined();
    expect(classification.types.structured).toBeDefined();
    expect(classification.types.semantic).toBeDefined();
    expect(classification.types.hybrid).toBeDefined();
    expect(classification.types.aggregation).toBeDefined();
    expect(classification.examples.length).toBeGreaterThan(0);
  });

  test('all capabilities include skipWhen guidance', async () => {
    const { body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.KB_ID}/discover`,
    );

    expectCapabilityGuidance(body.capabilities.queryClassification);
    expectCapabilityGuidance(body.capabilities.vocabulary);
    expectCapabilityGuidance(body.capabilities.filters);
    expectCapabilityGuidance(body.capabilities.reranking);
    expectCapabilityGuidance(body.capabilities.preprocessing);
  });

  test('reranking and preprocessing are always available', async () => {
    const { body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.KB_ID}/discover`,
    );

    expect(body.capabilities.reranking.available).toBe(true);
    expect(body.capabilities.preprocessing.available).toBe(true);
  });

  test('search endpoint contract is documented in manifest', async () => {
    const { body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.KB_ID}/discover`,
    );

    expect(body.searchEndpoint.url).toContain(SERVER_CONSTANTS.KB_ID);
    expect(body.searchEndpoint.method).toBe('POST');
  });

  test('manifest includes version metadata with TTL', async () => {
    const { body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.KB_ID}/discover`,
    );

    expect(body._meta.version).toBeDefined();
    expect(body._meta.generatedAt).toBeDefined();
    expect(body._meta.ttlSeconds).toBe(300);
  });

  test('returns 404 for non-existent index', async () => {
    const { status, body } = await fetchJson(
      server.baseUrl,
      '/api/search/non-existent-index/discover',
    );

    expect(status).toBe(404);
    expect(body.error).toBeDefined();
  });

  test('index without vocabulary returns vocabulary not available', async () => {
    // INDEX_ID has no vocabulary (only KB_ID has vocabulary)
    const { status, body } = await fetchJson(
      server.baseUrl,
      `/api/search/${SERVER_CONSTANTS.INDEX_ID}/discover`,
    );

    expect(status).toBe(200);
    expect(body.capabilities.vocabulary.available).toBe(false);
    expect(body.capabilities.vocabulary.terms).toHaveLength(0);
  });
});
