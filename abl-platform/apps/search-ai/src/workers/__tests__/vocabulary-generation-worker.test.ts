/**
 * Vocabulary Generation Worker Tests — Story 4.4
 *
 * Tests the pipeline: Schema Fields → Document Sampling → LLM Generation → Persist.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Job } from 'bullmq';

// ─── Hoisted mocks ──────────────────────────────────────────────────────

const {
  mockSampleEnumValues,
  mockLlmChat,
  mockCanonicalSchemaFindOne,
  mockDomainVocabularyFindOne,
  mockDomainVocabularyCreate,
  mockPromptLoad,
  mockPromptRender,
} = vi.hoisted(() => ({
  mockSampleEnumValues: vi.fn(),
  mockLlmChat: vi.fn(),
  mockCanonicalSchemaFindOne: vi.fn(),
  mockDomainVocabularyFindOne: vi.fn(),
  mockDomainVocabularyCreate: vi.fn(),
  mockPromptLoad: vi.fn(),
  mockPromptRender: vi.fn(),
}));

vi.mock('../../services/vocabulary/index.js', () => ({
  getDocumentContentSampler: vi.fn(() => ({
    sampleEnumValues: mockSampleEnumValues,
  })),
  VocabularyEnrichmentService: vi.fn(),
}));

vi.mock('@agent-platform/llm', () => ({
  WorkerLLMClient: vi.fn(function (this: any) {
    this.chat = mockLlmChat;
  }),
}));

vi.mock('@agent-platform/database/mongo', () => ({
  withTenantContext: vi.fn(async (_ctx: any, cb: () => any) => cb()),
  uuidv7: vi.fn(() => 'mock-uuid'),
}));

vi.mock('../../services/llm-config/resolver.js', () => ({
  resolveIndexLLMConfig: vi.fn().mockResolvedValue({
    provider: 'anthropic',
    apiKey: 'test-key',
    useCases: {
      vocabularyGeneration: {
        enabled: true,
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        apiKey: 'test-key',
      },
    },
  }),
}));

vi.mock('../../services/prompts/prompt-loader.service.js', () => ({
  PromptLoaderService: vi.fn(function (this: any) {
    this.loadPrompt = mockPromptLoad;
    this.renderPrompt = mockPromptRender;
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../shared.js', () => ({
  createWorkerOptions: vi.fn(() => ({})),
  getRedisConnection: vi.fn(() => ({})),
  workerLog: vi.fn(),
  workerError: vi.fn(),
}));

// Mock getLazyModel to return our mock models
vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    if (modelName === 'CanonicalSchema') {
      return {
        findOne: (...args: any[]) => {
          const result = mockCanonicalSchemaFindOne(...args);
          // Chain .sort().lean() support
          return {
            sort: () => ({
              lean: () => result,
            }),
          };
        },
      };
    }
    if (modelName === 'DomainVocabulary') {
      return {
        findOne: mockDomainVocabularyFindOne,
        create: mockDomainVocabularyCreate,
      };
    }
    return {};
  }),
}));

// Import after mocks
import type { VocabularyGenerationJobData } from '../vocabulary-generation-worker.js';
import { processVocabularyGenerationJob } from '../vocabulary-generation-worker.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function createMockJob(
  overrides: Partial<VocabularyGenerationJobData> = {},
): Job<VocabularyGenerationJobData> {
  return {
    id: 'test-job-1',
    data: {
      connectorId: 'connector-1',
      projectKbId: 'kb-1',
      knowledgeBaseId: 'kb-1',
      tenantId: 'tenant-1',
      connectorType: 'sharepoint',
      indexId: 'index-1',
      ...overrides,
    },
    updateProgress: vi.fn(),
  } as unknown as Job<VocabularyGenerationJobData>;
}

const mockSchemaFields = [
  { name: 'Title', label: 'Title', type: 'text', storageField: 'title', enumValues: {} },
  { name: 'Author', label: 'Author', type: 'keyword', storageField: 'author', enumValues: {} },
  {
    name: 'Department',
    label: 'Department',
    type: 'keyword',
    storageField: 'department',
    enumValues: {},
  },
  {
    name: 'Created Date',
    label: 'Created Date',
    type: 'date',
    storageField: 'created_date',
    enumValues: {},
  },
];

const mockLlmResponse = JSON.stringify([
  {
    term: 'author',
    aliases: ['who wrote', 'created by', 'writer'],
    fieldRef: 'Author',
    description: 'The person who created the document in SharePoint.',
    confidence: 0.9,
    capabilities: { canFilter: true, canDisplay: true, canAggregate: true, canSort: true },
    relatedFields: { displayWith: ['Title', 'Created Date'], aggregateWith: ['Department'] },
  },
  {
    term: 'department',
    aliases: ['team', 'group', 'division'],
    fieldRef: 'Department',
    description: 'The organizational department or team.',
    confidence: 0.85,
    capabilities: { canFilter: true, canDisplay: true, canAggregate: true, canSort: false },
    relatedFields: { displayWith: ['Author'], aggregateWith: [] },
  },
]);

function setupDefaultMocks() {
  mockCanonicalSchemaFindOne.mockResolvedValue({ fields: mockSchemaFields });
  mockSampleEnumValues.mockResolvedValue({ candidates: [], sampledDocCount: 0, indexName: '' });
  mockDomainVocabularyFindOne.mockResolvedValue(null);
  mockDomainVocabularyCreate.mockResolvedValue({ _id: 'vocab-1' });
  mockPromptLoad.mockReturnValue({
    system_prompt: 'System prompt for {connectorType}',
    user_prompt_template: 'Generate for {fieldCount} fields: {fieldDescriptions}',
  });
  mockPromptRender.mockImplementation((template: string, vars: Record<string, string>) => {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(`{${key}}`, value);
    }
    return result;
  });
  mockLlmChat.mockResolvedValue(mockLlmResponse);
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('VocabularyGenerationWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('successful generation', () => {
    it('generates vocabulary from schema fields via LLM', async () => {
      setupDefaultMocks();
      const job = createMockJob();

      await processVocabularyGenerationJob(job);

      // LLM should be called with schema field context
      expect(mockLlmChat).toHaveBeenCalledTimes(1);

      // Vocabulary should be persisted
      expect(mockDomainVocabularyCreate).toHaveBeenCalledTimes(1);
      const createCall = mockDomainVocabularyCreate.mock.calls[0][0];
      expect(createCall.tenantId).toBe('tenant-1');
      expect(createCall.projectKnowledgeBaseId).toBe('kb-1');
      expect(createCall.status).toBe('active');
      expect(createCall.entries.length).toBe(2);

      // Verify entries are well-formed
      const authorEntry = createCall.entries.find((e: any) => e.term === 'author');
      expect(authorEntry).toBeDefined();
      expect(authorEntry.aliases).toEqual(['who wrote', 'created by', 'writer']);
      expect(authorEntry.fieldRef).toBe('Author');
      expect(authorEntry.generatedBy).toBe('auto');
      expect(authorEntry.enabled).toBe(true);
    });

    it('reports progress through all stages', async () => {
      setupDefaultMocks();
      const job = createMockJob();

      await processVocabularyGenerationJob(job);

      expect(job.updateProgress).toHaveBeenCalledWith(10);
      expect(job.updateProgress).toHaveBeenCalledWith(20);
      expect(job.updateProgress).toHaveBeenCalledWith(40);
      expect(job.updateProgress).toHaveBeenCalledWith(80);
      expect(job.updateProgress).toHaveBeenCalledWith(100);
    });

    it('includes enum context from document sampling when available', async () => {
      setupDefaultMocks();
      mockSampleEnumValues.mockResolvedValue({
        candidates: [
          {
            storageField: 'department',
            alias: 'Department',
            label: 'Department',
            values: [
              { value: 'Engineering', count: 50, frequency: 0.5 },
              { value: 'Sales', count: 30, frequency: 0.3 },
            ],
            cardinality: 2,
            confidence: 0.9,
          },
        ],
        sampledDocCount: 100,
        indexName: 'test-index',
      });

      const job = createMockJob();
      await processVocabularyGenerationJob(job);

      // LLM should still be called (with enum context included in prompt)
      expect(mockLlmChat).toHaveBeenCalledTimes(1);
      expect(mockDomainVocabularyCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('no schema fields', () => {
    it('skips generation when schema has no fields', async () => {
      setupDefaultMocks();
      mockCanonicalSchemaFindOne.mockResolvedValue({ fields: [] });

      const job = createMockJob();
      await processVocabularyGenerationJob(job);

      expect(mockLlmChat).not.toHaveBeenCalled();
      expect(mockDomainVocabularyCreate).not.toHaveBeenCalled();
      expect(job.updateProgress).toHaveBeenCalledWith(100);
    });

    it('skips generation when no schema exists', async () => {
      setupDefaultMocks();
      mockCanonicalSchemaFindOne.mockResolvedValue(null);

      const job = createMockJob();
      await processVocabularyGenerationJob(job);

      expect(mockLlmChat).not.toHaveBeenCalled();
      expect(mockDomainVocabularyCreate).not.toHaveBeenCalled();
    });
  });

  describe('no LLM available', () => {
    it('skips generation when LLM credentials are missing', async () => {
      setupDefaultMocks();
      const { resolveIndexLLMConfig } = await import('../../services/llm-config/resolver.js');
      vi.mocked(resolveIndexLLMConfig).mockResolvedValueOnce({
        provider: 'anthropic',
        apiKey: '',
        useCases: {
          vocabularyGeneration: {
            enabled: true,
            model: 'claude-sonnet-4-20250514',
            provider: 'anthropic',
            apiKey: '', // No credentials
          },
        },
      } as any);

      const job = createMockJob();
      await processVocabularyGenerationJob(job);

      expect(mockLlmChat).not.toHaveBeenCalled();
      expect(mockDomainVocabularyCreate).not.toHaveBeenCalled();
    });
  });

  describe('graceful degradation', () => {
    it('continues when document sampling fails', async () => {
      setupDefaultMocks();
      mockSampleEnumValues.mockRejectedValue(new Error('OpenSearch unreachable'));

      const job = createMockJob();
      await processVocabularyGenerationJob(job);

      // LLM should still be called (sampling is optional)
      expect(mockLlmChat).toHaveBeenCalledTimes(1);
      expect(mockDomainVocabularyCreate).toHaveBeenCalledTimes(1);
    });

    it('returns empty when LLM returns invalid JSON', async () => {
      setupDefaultMocks();
      mockLlmChat.mockResolvedValue('This is not JSON');

      const job = createMockJob();
      await processVocabularyGenerationJob(job);

      // Should not crash, just produce no entries
      expect(mockDomainVocabularyCreate).not.toHaveBeenCalled();
    });
  });

  describe('vocabulary upsert', () => {
    it('merges with existing vocabulary, keeping manual entries', async () => {
      setupDefaultMocks();
      const existingVocab = {
        _id: 'existing-vocab',
        entries: [
          {
            id: 'manual-1',
            term: 'custom term',
            aliases: ['custom'],
            fieldRef: 'Author',
            generatedBy: 'manual',
            enabled: true,
          },
          {
            id: 'auto-old',
            term: 'old auto term',
            aliases: ['old'],
            fieldRef: 'Department',
            generatedBy: 'auto',
            enabled: true,
          },
        ],
        version: 2,
        updatedAt: new Date(),
        save: vi.fn(),
      };
      mockDomainVocabularyFindOne.mockResolvedValue(existingVocab);

      const job = createMockJob();
      await processVocabularyGenerationJob(job);

      // Should update existing, not create new
      expect(mockDomainVocabularyCreate).not.toHaveBeenCalled();
      expect(existingVocab.save).toHaveBeenCalledTimes(1);

      // Manual entry should be kept, auto entries replaced
      const manualEntries = existingVocab.entries.filter((e: any) => e.generatedBy === 'manual');
      expect(manualEntries.length).toBe(1);
      expect(manualEntries[0].term).toBe('custom term');

      // Version should increment
      expect(existingVocab.version).toBe(3);
    });
  });

  describe('tenant isolation', () => {
    it('uses withTenantContext for the entire job', async () => {
      setupDefaultMocks();
      const { withTenantContext } = await import('@agent-platform/database/mongo');
      const job = createMockJob({ tenantId: 'tenant-xyz' });

      await processVocabularyGenerationJob(job);

      expect(withTenantContext).toHaveBeenCalledWith(
        { tenantId: 'tenant-xyz' },
        expect.any(Function),
      );
    });
  });

  describe('fallback knowledgeBaseId', () => {
    it('uses projectKbId when knowledgeBaseId is not provided', async () => {
      setupDefaultMocks();
      const job = createMockJob({ projectKbId: 'kb-legacy' });
      delete (job.data as any).knowledgeBaseId;

      await processVocabularyGenerationJob(job);

      expect(mockCanonicalSchemaFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ knowledgeBaseId: 'kb-legacy' }),
      );
    });
  });
});
