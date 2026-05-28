/**
 * Scenario 6: KB Tool Executor with Real Discovery
 *
 * Tests the SearchAIKBToolExecutor directly (not via RuntimeExecutor).
 * Validates: discovery manifest fetched, description built, search executed,
 * results returned - all against the real Express server.
 *
 * This is the KB-as-tool path: the executor calls /discover on first use,
 * caches the manifest, enriches the tool description, then calls /query.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupServer, teardownServer, SERVER_CONSTANTS } from './helpers/setup.js';
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

import { SearchAIKBToolExecutor } from '../../../services/search-ai/searchai-kb-tool-executor.js';

let server: TestSearchServer;

beforeAll(async () => {
  server = await setupServer();
}, 30_000);

afterAll(async () => {
  await teardownServer();
});

describe('KB Tool Executor (Scenario 6)', () => {
  test('fetches discovery manifest on first call', async () => {
    const executor = new SearchAIKBToolExecutor({
      runtimeUrl: server.baseUrl,
      searchTimeoutMs: 15_000,
      discoveryTimeoutMs: 5_000,
    });

    executor.registerBinding('search_kb_test', {
      tenantId: SERVER_CONSTANTS.TENANT_ID,
      indexId: SERVER_CONSTANTS.KB_ID,
    });

    const result = (await executor.execute(
      'search_kb_test',
      { query: 'kubernetes deployment' },
      15_000,
    )) as any;

    // Discovery should have been fetched and cached
    const manifest = executor.getDiscoveryManifest(SERVER_CONSTANTS.KB_ID);
    expect(manifest).toBeDefined();
    expect(manifest.kb).toBeDefined();
    expect(manifest.capabilities).toBeDefined();

    // Search should have returned results
    expect(result).toBeDefined();
    expect(result.results || result.queryType).toBeDefined();
  });

  test('caches discovery - second call does not re-fetch', async () => {
    const executor = new SearchAIKBToolExecutor({
      runtimeUrl: server.baseUrl,
      searchTimeoutMs: 15_000,
    });

    executor.registerBinding('search_kb_cached', {
      tenantId: SERVER_CONSTANTS.TENANT_ID,
      indexId: SERVER_CONSTANTS.KB_ID,
    });

    // First call
    await executor.execute('search_kb_cached', { query: 'first call' }, 15_000);
    const manifest1 = executor.getDiscoveryManifest(SERVER_CONSTANTS.KB_ID);

    // Second call - should use cached manifest
    await executor.execute('search_kb_cached', { query: 'second call' }, 15_000);
    const manifest2 = executor.getDiscoveryManifest(SERVER_CONSTANTS.KB_ID);

    expect(manifest1).toBe(manifest2); // Same reference (cached)
  });

  test('builds LLM-readable description from manifest', async () => {
    const executor = new SearchAIKBToolExecutor({
      runtimeUrl: server.baseUrl,
      searchTimeoutMs: 15_000,
    });

    executor.registerBinding('search_kb_desc', {
      tenantId: SERVER_CONSTANTS.TENANT_ID,
      indexId: SERVER_CONSTANTS.KB_ID,
    });

    let capturedDescription = '';
    executor.setDescriptionCallback((_toolName, description) => {
      capturedDescription = description;
    });

    await executor.execute('search_kb_desc', { query: 'test' }, 15_000);

    // Description should contain KB name and capabilities
    expect(capturedDescription).toBeDefined();
    expect(capturedDescription.length).toBeGreaterThan(50);
    expect(capturedDescription).toContain('VOCABULARY');
    expect(capturedDescription).toContain('devops tools');
  });

  test('forwards agent query parameters to unified endpoint', async () => {
    const executor = new SearchAIKBToolExecutor({
      runtimeUrl: server.baseUrl,
      searchTimeoutMs: 15_000,
    });

    executor.registerBinding('search_kb_params', {
      tenantId: SERVER_CONSTANTS.TENANT_ID,
      indexId: SERVER_CONSTANTS.INDEX_ID,
    });

    const result = (await executor.execute(
      'search_kb_params',
      {
        query: 'react hooks tutorial',
        queryType: 'semantic',
        topK: 3,
        skipPreprocessing: true,
      },
      15_000,
    )) as any;

    expect(result).toBeDefined();
    expect(result.results).toBeDefined();
    expect(result.results.length).toBeLessThanOrEqual(3);
  });

  test('throws on missing query parameter', async () => {
    const executor = new SearchAIKBToolExecutor({
      runtimeUrl: server.baseUrl,
    });

    executor.registerBinding('search_kb_err', {
      tenantId: SERVER_CONSTANTS.TENANT_ID,
      indexId: SERVER_CONSTANTS.INDEX_ID,
    });

    await expect(executor.execute('search_kb_err', {}, 15_000)).rejects.toThrow(
      'requires a "query" parameter',
    );
  });

  test('throws on unregistered tool name', async () => {
    const executor = new SearchAIKBToolExecutor({
      runtimeUrl: server.baseUrl,
    });

    await expect(executor.execute('unregistered_tool', { query: 'test' }, 15_000)).rejects.toThrow(
      'no registered binding',
    );
  });
});
