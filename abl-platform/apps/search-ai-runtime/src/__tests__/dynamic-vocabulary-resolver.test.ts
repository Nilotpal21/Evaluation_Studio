import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { DynamicVocabularyResolver } from '../services/vocabulary/dynamic-vocabulary-resolver.js';
import { WorkerLLMClient } from '@agent-platform/llm';
import { DomainVocabulary } from '@agent-platform/database/models';
import type { IVocabularyEntry } from '@agent-platform/database';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  vi.clearAllMocks();
});

// ─── Helper Functions ────────────────────────────────────────────────────

const createMockLLMClient = () => {
  return {
    chat: vi.fn(),
    getModelForTier: vi.fn(),
  } as unknown as WorkerLLMClient;
};

const createVocabularyEntry = (term: string, fieldRef: string): IVocabularyEntry => ({
  term,
  aliases: [],
  fieldRef,
  capabilities: {
    canFilter: true,
    canDisplay: true,
    canAggregate: true,
    canSort: true,
  },
  relatedFields: {
    displayWith: ['related_field_1'],
    aggregateWith: ['related_field_2'],
  },
  enabled: true,
  generatedBy: 'manual',
});

// ─── DynamicVocabularyResolver Tests ─────────────────────────────────────

describe('DynamicVocabularyResolver', () => {
  const tenantId = 'tenant-1';
  const projectKbId = 'kb-1';

  describe('constructor', () => {
    it('initializes with provided LLM client', () => {
      const mockClient = createMockLLMClient();
      const resolver = new DynamicVocabularyResolver(mockClient);
      expect(resolver).toBeDefined();
      expect(resolver.getCacheStats().vocabulary.max).toBe(500);
      expect(resolver.getCacheStats().schema.max).toBe(200);
    });
  });

  describe('resolve', () => {
    it('returns empty resolution when no vocabulary exists', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const mockClient = createMockLLMClient();
      const resolver = new DynamicVocabularyResolver(mockClient);

      const result = await resolver.resolve('priority', projectKbId, tenantId);

      expect(result.originalQuery).toBe('priority');
      expect(result.resolutions).toHaveLength(0);
      expect(result.unresolvedSegments).toEqual(['priority']);
      expect(mockClient.chat).not.toHaveBeenCalled();
    });

    it('resolves vocabulary terms using LLM', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      // Create vocabulary
      await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: projectKbId,
        version: 1,
        status: 'active',
        entries: [
          createVocabularyEntry('priority', 'issue_priority'),
          createVocabularyEntry('status', 'issue_status'),
        ],
      });

      const mockClient = createMockLLMClient();
      (mockClient.chat as any).mockResolvedValue(
        JSON.stringify({
          resolutions: [
            {
              term: 'priority',
              resolvedAs: 'filter',
              reasoning: 'User wants to filter by priority',
              field: 'issue_priority',
              operator: 'equals',
              value: 'high',
            },
          ],
        }),
      );

      const resolver = new DynamicVocabularyResolver(mockClient);
      const result = await resolver.resolve('filter by priority', projectKbId, tenantId);

      expect(result.resolutions).toHaveLength(1);
      expect(result.resolutions[0].term).toBe('priority');
      expect(result.resolutions[0].resolvedAs).toBe('filter');
      expect(result.resolutions[0].filter).toBeDefined();
      expect(result.resolutions[0].filter![0].field).toBe('issue_priority');
      expect(mockClient.chat).toHaveBeenCalledTimes(1);
    });

    it('handles display resolution with related fields', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: projectKbId,
        version: 1,
        status: 'active',
        entries: [createVocabularyEntry('priority', 'issue_priority')],
      });

      const mockClient = createMockLLMClient();
      (mockClient.chat as any).mockResolvedValue(
        JSON.stringify({
          resolutions: [
            {
              term: 'priority',
              resolvedAs: 'display',
              reasoning: 'User wants to see priority field',
              field: 'issue_priority',
            },
          ],
        }),
      );

      const resolver = new DynamicVocabularyResolver(mockClient);
      const result = await resolver.resolve('show me priority', projectKbId, tenantId);

      expect(result.resolutions[0].resolvedAs).toBe('display');
      expect(result.resolutions[0].display).toBeDefined();
      expect(result.resolutions[0].display!.fields).toContain('issue_priority');
      expect(result.resolutions[0].display!.fields).toContain('related_field_1');
    });

    it('handles aggregate resolution with related fields', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: projectKbId,
        version: 1,
        status: 'active',
        entries: [createVocabularyEntry('priority', 'issue_priority')],
      });

      const mockClient = createMockLLMClient();
      (mockClient.chat as any).mockResolvedValue(
        JSON.stringify({
          resolutions: [
            {
              term: 'priority',
              resolvedAs: 'aggregate',
              reasoning: 'User wants to count by priority',
              field: 'issue_priority',
              metric: 'count',
            },
          ],
        }),
      );

      const resolver = new DynamicVocabularyResolver(mockClient);
      const result = await resolver.resolve('count by priority', projectKbId, tenantId);

      expect(result.resolutions[0].resolvedAs).toBe('aggregate');
      expect(result.resolutions[0].aggregate).toBeDefined();
      expect(result.resolutions[0].aggregate!.metric).toBe('count');
      expect(result.resolutions[0].aggregate!.field).toBe('issue_priority');
      expect(result.resolutions[0].aggregate!.includeFields).toContain('related_field_2');
    });

    it('handles sort resolution', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: projectKbId,
        version: 1,
        status: 'active',
        entries: [createVocabularyEntry('priority', 'issue_priority')],
      });

      const mockClient = createMockLLMClient();
      (mockClient.chat as any).mockResolvedValue(
        JSON.stringify({
          resolutions: [
            {
              term: 'priority',
              resolvedAs: 'sort',
              reasoning: 'User wants to sort by priority',
              field: 'issue_priority',
              direction: 'desc',
            },
          ],
        }),
      );

      const resolver = new DynamicVocabularyResolver(mockClient);
      const result = await resolver.resolve('sort by priority descending', projectKbId, tenantId);

      expect(result.resolutions[0].resolvedAs).toBe('sort');
      expect(result.resolutions[0].sort).toBeDefined();
      expect(result.resolutions[0].sort!.field).toBe('issue_priority');
      expect(result.resolutions[0].sort!.direction).toBe('desc');
    });

    it('handles LLM response with markdown code fences', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: projectKbId,
        version: 1,
        status: 'active',
        entries: [createVocabularyEntry('status', 'issue_status')],
      });

      const mockClient = createMockLLMClient();
      (mockClient.chat as any).mockResolvedValue(
        '```json\n{"resolutions":[{"term":"status","resolvedAs":"filter","reasoning":"Filter by status","field":"issue_status"}]}\n```',
      );

      const resolver = new DynamicVocabularyResolver(mockClient);
      const result = await resolver.resolve('status is open', projectKbId, tenantId);

      expect(result.resolutions).toHaveLength(1);
      expect(result.resolutions[0].term).toBe('status');
    });

    it('filters out unknown terms from LLM response', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: projectKbId,
        version: 1,
        status: 'active',
        entries: [createVocabularyEntry('priority', 'issue_priority')],
      });

      const mockClient = createMockLLMClient();
      (mockClient.chat as any).mockResolvedValue(
        JSON.stringify({
          resolutions: [
            {
              term: 'priority',
              resolvedAs: 'filter',
              reasoning: 'Valid term',
              field: 'issue_priority',
            },
            {
              term: 'unknown_term',
              resolvedAs: 'filter',
              reasoning: 'Invalid term',
              field: 'unknown_field',
            },
          ],
        }),
      );

      const resolver = new DynamicVocabularyResolver(mockClient);
      const result = await resolver.resolve('priority and unknown', projectKbId, tenantId);

      expect(result.resolutions).toHaveLength(1);
      expect(result.resolutions[0].term).toBe('priority');
    });

    it('gracefully handles LLM errors', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: projectKbId,
        version: 1,
        status: 'active',
        entries: [createVocabularyEntry('priority', 'issue_priority')],
      });

      const mockClient = createMockLLMClient();
      (mockClient.chat as any).mockRejectedValue(new Error('LLM API error'));

      const resolver = new DynamicVocabularyResolver(mockClient);
      const result = await resolver.resolve('priority', projectKbId, tenantId);

      // Should fallback to empty resolution
      expect(result.resolutions).toHaveLength(0);
      expect(result.unresolvedSegments).toEqual(['priority']);
    });

    it('gracefully handles invalid JSON from LLM', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: projectKbId,
        version: 1,
        status: 'active',
        entries: [createVocabularyEntry('priority', 'issue_priority')],
      });

      const mockClient = createMockLLMClient();
      (mockClient.chat as any).mockResolvedValue('This is not JSON');

      const resolver = new DynamicVocabularyResolver(mockClient);
      const result = await resolver.resolve('priority', projectKbId, tenantId);

      expect(result.resolutions).toHaveLength(0);
    });

    it('extracts unresolved segments correctly', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: projectKbId,
        version: 1,
        status: 'active',
        entries: [createVocabularyEntry('priority', 'issue_priority')],
      });

      const mockClient = createMockLLMClient();
      (mockClient.chat as any).mockResolvedValue(
        JSON.stringify({
          resolutions: [
            {
              term: 'priority',
              resolvedAs: 'filter',
              reasoning: 'Filter',
              field: 'issue_priority',
            },
          ],
        }),
      );

      const resolver = new DynamicVocabularyResolver(mockClient);
      const result = await resolver.resolve(
        'show me priority and something else',
        projectKbId,
        tenantId,
      );

      expect(result.unresolvedSegments).toContain('show');
      expect(result.unresolvedSegments).toContain('me');
      expect(result.unresolvedSegments).not.toContain('priority');
    });
  });

  describe('caching', () => {
    it('caches vocabulary entries', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: projectKbId,
        version: 1,
        status: 'active',
        entries: [createVocabularyEntry('priority', 'issue_priority')],
      });

      const mockClient = createMockLLMClient();
      (mockClient.chat as any).mockResolvedValue(JSON.stringify({ resolutions: [] }));

      const resolver = new DynamicVocabularyResolver(mockClient);

      // First call
      await resolver.resolve('test', projectKbId, tenantId);

      // Second call should use cache
      await resolver.resolve('test2', projectKbId, tenantId);

      // Should only call LLM twice (not load vocabulary twice)
      expect(mockClient.chat).toHaveBeenCalledTimes(2);
    });

    it('provides cache statistics', () => {
      const mockClient = createMockLLMClient();
      const resolver = new DynamicVocabularyResolver(mockClient);

      const stats = resolver.getCacheStats();

      expect(stats.vocabulary).toHaveProperty('size');
      expect(stats.vocabulary).toHaveProperty('max');
      expect(stats.schema).toHaveProperty('size');
      expect(stats.schema).toHaveProperty('max');
    });

    it('allows clearing caches', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const mockClient = createMockLLMClient();
      const resolver = new DynamicVocabularyResolver(mockClient);

      // Populate cache
      await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: projectKbId,
        version: 1,
        status: 'active',
        entries: [createVocabularyEntry('priority', 'issue_priority')],
      });

      (mockClient.chat as any).mockResolvedValue(JSON.stringify({ resolutions: [] }));

      await resolver.resolve('test', projectKbId, tenantId);

      let stats = resolver.getCacheStats();
      expect(stats.vocabulary.size).toBeGreaterThan(0);

      // Clear caches
      resolver.clearCaches();

      stats = resolver.getCacheStats();
      expect(stats.vocabulary.size).toBe(0);
      expect(stats.schema.size).toBe(0);
    });
  });

  describe('tenant isolation', () => {
    it('loads vocabulary only for specified tenant', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      // Create vocabulary for tenant-1
      await DomainVocabulary.create({
        tenantId: 'tenant-1',
        projectKnowledgeBaseId: projectKbId,
        version: 1,
        status: 'active',
        entries: [createVocabularyEntry('priority', 'issue_priority')],
      });

      // Create vocabulary for tenant-2 with different KB to avoid unique index conflict
      await DomainVocabulary.create({
        tenantId: 'tenant-2',
        projectKnowledgeBaseId: 'kb-2',
        version: 1,
        status: 'active',
        entries: [createVocabularyEntry('status', 'issue_status')],
      });

      const mockClient = createMockLLMClient();
      (mockClient.chat as any).mockResolvedValue(
        JSON.stringify({
          resolutions: [
            {
              term: 'priority',
              resolvedAs: 'filter',
              reasoning: 'Test',
              field: 'issue_priority',
            },
          ],
        }),
      );

      const resolver = new DynamicVocabularyResolver(mockClient);

      // Query for tenant-1
      const result = await resolver.resolve('priority', projectKbId, 'tenant-1');

      expect(result.resolutions).toHaveLength(1);
      expect(result.resolutions[0].term).toBe('priority');

      // Verify system prompt includes only tenant-1's vocabulary
      const systemPrompt = (mockClient.chat as any).mock.calls[0][0];
      expect(systemPrompt).toContain('priority');
      expect(systemPrompt).not.toContain('status');
    });
  });

  describe('vocabulary filtering', () => {
    it('only loads enabled vocabulary entries', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: projectKbId,
        version: 1,
        status: 'active',
        entries: [
          { ...createVocabularyEntry('priority', 'issue_priority'), enabled: true },
          { ...createVocabularyEntry('status', 'issue_status'), enabled: false },
        ],
      });

      const mockClient = createMockLLMClient();
      (mockClient.chat as any).mockResolvedValue(JSON.stringify({ resolutions: [] }));

      const resolver = new DynamicVocabularyResolver(mockClient);
      await resolver.resolve('test', projectKbId, tenantId);

      // Verify system prompt includes only enabled entries
      const systemPrompt = (mockClient.chat as any).mock.calls[0][0];
      expect(systemPrompt).toContain('priority');
      expect(systemPrompt).not.toContain('status');
    });

    it('only loads active vocabulary status', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      // Create active vocabulary
      await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: projectKbId,
        version: 1,
        status: 'active',
        entries: [createVocabularyEntry('priority', 'issue_priority')],
      });

      // Create draft vocabulary (should be ignored)
      await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: 'kb-2',
        version: 1,
        status: 'draft',
        entries: [createVocabularyEntry('status', 'issue_status')],
      });

      const mockClient = createMockLLMClient();
      (mockClient.chat as any).mockResolvedValue(JSON.stringify({ resolutions: [] }));

      const resolver = new DynamicVocabularyResolver(mockClient);
      await resolver.resolve('test', projectKbId, tenantId);

      // Should have vocabulary for kb-1
      expect(mockClient.chat).toHaveBeenCalledTimes(1);

      // Query for kb-2 should find no vocabulary
      const result = await resolver.resolve('test', 'kb-2', tenantId);
      expect(result.resolutions).toHaveLength(0);
    });
  });
});
