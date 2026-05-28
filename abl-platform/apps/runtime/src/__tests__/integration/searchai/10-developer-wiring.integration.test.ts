/**
 * Scenario 10: Developer Wiring — IR Tool Definition → Executor Dispatch
 *
 * Tests the developer's perspective: how a SearchAI KB tool defined in
 * ABL DSL flows through the IR and gets dispatched to the KB executor.
 *
 * Chain: DSL properties → buildSearchAIBindingFromProps() → binding IR
 * → SearchAIKBToolExecutor registered with binding → auto-discovery
 * → real search → results
 *
 * This tests the compiler layer (DSL parsing) and runtime layer (execution)
 * together, showing the full developer experience.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

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

import { setupServer, teardownServer, SERVER_CONSTANTS } from './helpers/setup.js';
import { SearchAIKBToolExecutor } from '../../../services/search-ai/searchai-kb-tool-executor.js';
import { parseDslProperties, buildSearchAIBindingFromProps } from '@agent-platform/shared/tools';
import type { TestSearchServer } from '../../helpers/search-server.js';

let server: TestSearchServer;

beforeAll(async () => {
  server = await setupServer();
}, 30_000);

afterAll(async () => {
  await teardownServer();
});

// What the developer writes in ABL DSL
const TOOL_DSL = `search_kb_products(query: string, queryType?: string, filters?: object[]) -> {results: object[], totalCount: number}
  description: "Search the Product Documentation knowledge base"
  type: searchai
  index_id: "${SERVER_CONSTANTS.INDEX_ID}"
  tenant_id: "${SERVER_CONSTANTS.TENANT_ID}"
  kb_name: "Product Documentation"`;

describe('Developer Wiring (Scenario 10)', () => {
  describe('Step 1: DSL → IR (Compiler)', () => {
    test('parses searchai properties from developer DSL', () => {
      const props = parseDslProperties(TOOL_DSL);
      expect(props.type).toBe('searchai');
      expect(props.index_id).toBe(SERVER_CONSTANTS.INDEX_ID);
      expect(props.tenant_id).toBe(SERVER_CONSTANTS.TENANT_ID);
      expect(props.kb_name).toBe('Product Documentation');
    });

    test('builds SearchAI binding IR from parsed properties', () => {
      const props = parseDslProperties(TOOL_DSL);
      const binding = buildSearchAIBindingFromProps(props);
      expect(binding.indexId).toBe(SERVER_CONSTANTS.INDEX_ID);
      expect(binding.tenantId).toBe(SERVER_CONSTANTS.TENANT_ID);
      expect(binding.kbName).toBe('Product Documentation');
    });
  });

  describe('Step 2: IR → Executor Wiring (Runtime)', () => {
    test('executor created from binding auto-discovers KB', async () => {
      const props = parseDslProperties(TOOL_DSL);
      const binding = buildSearchAIBindingFromProps(props);

      const executor = new SearchAIKBToolExecutor({
        runtimeUrl: server.baseUrl,
        searchTimeoutMs: 15_000,
      });
      executor.registerBinding('search_kb_products', {
        tenantId: binding.tenantId,
        indexId: binding.indexId,
      });

      let description = '';
      executor.setDescriptionCallback((_n, d) => {
        description = d;
      });

      await executor.execute(
        'search_kb_products',
        { query: 'kubernetes', queryType: 'hybrid' },
        15_000,
      );

      expect(description.length).toBeGreaterThan(0);
      expect(description).toContain('Product Documentation');
    });

    test('vocabulary-enabled KB enriches tool description', async () => {
      const executor = new SearchAIKBToolExecutor({
        runtimeUrl: server.baseUrl,
        searchTimeoutMs: 15_000,
      });
      executor.registerBinding('search_with_vocab', {
        tenantId: SERVER_CONSTANTS.TENANT_ID,
        indexId: SERVER_CONSTANTS.KB_ID,
      });

      let description = '';
      executor.setDescriptionCallback((_n, d) => {
        description = d;
      });

      await executor.execute('search_with_vocab', { query: 'test', queryType: 'hybrid' }, 15_000);

      expect(description).toContain('VOCABULARY (available');
      expect(description).toContain('devops tools');
    });
  });

  describe('Step 3: Agent Uses Tool (End User)', () => {
    test('agent searches with vocabulary-resolved filters', async () => {
      const executor = new SearchAIKBToolExecutor({
        runtimeUrl: server.baseUrl,
        searchTimeoutMs: 15_000,
      });
      executor.registerBinding('search_kb_products', {
        tenantId: SERVER_CONSTANTS.TENANT_ID,
        indexId: SERVER_CONSTANTS.INDEX_ID,
      });

      const result = (await executor.execute(
        'search_kb_products',
        {
          query: 'CI/CD infrastructure monitoring',
          queryType: 'hybrid',
          filters: [{ field: 'category', operator: 'eq', value: 'devops' }],
          skipPreprocessing: true,
          skipVocabularyResolution: true,
        },
        15_000,
      )) as any;

      expect(result.results).toBeDefined();
    });

    test('agent does semantic search for conceptual questions', async () => {
      const executor = new SearchAIKBToolExecutor({
        runtimeUrl: server.baseUrl,
        searchTimeoutMs: 15_000,
      });
      executor.registerBinding('search_kb_products', {
        tenantId: SERVER_CONSTANTS.TENANT_ID,
        indexId: SERVER_CONSTANTS.INDEX_ID,
      });

      const result = (await executor.execute(
        'search_kb_products',
        { query: 'how does React handle component lifecycle', queryType: 'vector' },
        15_000,
      )) as any;

      expect(result.results).toBeDefined();
      expect(result.results.length).toBeGreaterThan(0);
    });

    test('parallel search with different queries', async () => {
      const executor = new SearchAIKBToolExecutor({
        runtimeUrl: server.baseUrl,
        searchTimeoutMs: 15_000,
      });
      executor.registerBinding('search_kb_products', {
        tenantId: SERVER_CONSTANTS.TENANT_ID,
        indexId: SERVER_CONSTANTS.INDEX_ID,
      });

      const results = await executor.executeParallel(
        [
          { name: 'search_kb_products', params: { query: 'kubernetes', queryType: 'vector' } },
          { name: 'search_kb_products', params: { query: 'postgresql', queryType: 'vector' } },
        ],
        15_000,
      );

      expect(results).toHaveLength(2);
      expect(results[0].result).toBeDefined();
      expect(results[1].result).toBeDefined();
    });
  });
});
