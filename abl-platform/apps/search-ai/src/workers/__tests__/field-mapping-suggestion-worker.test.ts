/**
 * Field Mapping Suggestion Worker Tests
 *
 * Tests the orchestration worker that ties together:
 * - RuleBasedMappingService (rule-based mapping)
 * - MappingSuggestionService (LLM-based mapping)
 * - ConfidenceScoringService (threshold + persist)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Models (hoisted for vi.mock factory access) ─────────────────────────

const { mockDiscoveredSchemaModel, mockCanonicalSchemaModel, mockFieldMappingModel } = vi.hoisted(
  () => ({
    mockDiscoveredSchemaModel: {
      findOne: vi.fn(),
    },
    mockCanonicalSchemaModel: {
      findOne: vi.fn(),
      create: vi.fn(),
    },
    mockFieldMappingModel: {
      find: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([]) })),
    },
  }),
);

// Mock database layer (workers use getLazyModel from db/index.js)
vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    if (modelName === 'DiscoveredSchema') return mockDiscoveredSchemaModel;
    if (modelName === 'CanonicalSchema') return mockCanonicalSchemaModel;
    if (modelName === 'FieldMapping') return mockFieldMappingModel;
    return {};
  }),
}));

// Mock tenant context
vi.mock('@agent-platform/database/mongo', () => ({
  withTenantContext: vi.fn((_ctx: unknown, fn: () => Promise<void>) => fn()),
}));

// Mock rule-based mapping service
vi.mock('@agent-platform/search-ai-internal/services', () => ({
  generateMappings: vi.fn(),
}));

// Mock mapping suggestion service
vi.mock('../../services/mapping-suggestion/index.js', () => ({
  mappingSuggestionService: {
    suggestMappings: vi.fn(),
  },
}));

// Mock confidence scoring service
vi.mock('../../services/confidence-scoring/index.js', () => ({
  confidenceScoringService: {
    processSuggestions: vi.fn(),
  },
}));

// Mock shared worker utilities
const mockVocabQueue = { add: vi.fn().mockResolvedValue({}), close: vi.fn().mockResolvedValue({}) };
vi.mock('../shared.js', () => ({
  createWorkerOptions: vi.fn(() => ({ connection: {} })),
  createQueue: vi.fn(() => mockVocabQueue),
  getRedisConnection: vi.fn(() => ({})),
  workerLog: vi.fn(),
  workerError: vi.fn(),
}));

// Mock BullMQ
vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
    isRunning: vi.fn(() => true),
  })),
}));

// Mock vocabulary generation worker exports
vi.mock('../vocabulary-generation-worker.js', () => ({
  VOCABULARY_GENERATION_QUEUE_NAME: 'vocabulary-generation',
}));

// Mock canonical field helpers used by the worker
vi.mock('@agent-platform/search-ai-internal/canonical', () => ({
  getAvailableFieldsForLLM: vi.fn(() => [
    {
      name: 'title',
      label: 'Title',
      type: 'string',
      storageField: 'title',
      indexed: true,
      filterable: true,
    },
    {
      name: 'priority',
      label: 'Priority',
      type: 'string',
      storageField: 'priority',
      indexed: true,
      filterable: true,
    },
    {
      name: 'status',
      label: 'Status',
      type: 'string',
      storageField: 'status',
      indexed: true,
      filterable: true,
    },
    {
      name: 'custom_string_1',
      label: 'Custom 1',
      type: 'string',
      storageField: 'custom_string_1',
      indexed: true,
      filterable: true,
    },
    {
      name: 'created_at',
      label: 'Created At',
      type: 'date',
      storageField: 'created_at',
      indexed: true,
      filterable: true,
    },
  ]),
  getAvailableField: vi.fn(),
  toCanonicalField: vi.fn(),
}));

// Mock search-ai-sdk
vi.mock('@agent-platform/search-ai-sdk', () => ({
  QUEUE_FIELD_MAPPING_SUGGESTION: 'search-field-mapping-suggestion',
}));

import { generateMappings } from '@agent-platform/search-ai-internal/services';
import { mappingSuggestionService } from '../../services/mapping-suggestion/index.js';
import { confidenceScoringService } from '../../services/confidence-scoring/index.js';
import {
  processFieldMappingSuggestionJob,
  type FieldMappingSuggestionJobData,
} from '../field-mapping-suggestion-worker.js';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

const baseJobData: FieldMappingSuggestionJobData = {
  tenantId: 'tenant-1',
  connectorId: 'connector-1',
  knowledgeBaseId: 'kb-1',
  discoveredSchemaId: 'ds-1',
  indexId: 'index-1',
  connectorType: 'jira',
};

function createMockJob(data: Partial<FieldMappingSuggestionJobData> = {}) {
  return {
    id: 'job-1',
    data: { ...baseJobData, ...data },
    updateProgress: vi.fn(),
  } as any;
}

const mockDiscoveredSchema = {
  _id: 'ds-1',
  tenantId: 'tenant-1',
  connectorId: 'connector-1',
  knowledgeBaseId: 'kb-1',
  fields: [
    {
      name: 'priority',
      type: 'string',
      path: 'fields.priority.name',
      enumValues: ['High', 'Medium', 'Low'],
    },
    { name: 'status', type: 'string', path: 'fields.status.name', enumValues: ['Open', 'Closed'] },
    { name: 'summary', type: 'string', path: 'fields.summary' },
    { name: 'custom_field_1', type: 'string', path: 'fields.customfield_10001' },
    { name: 'created', type: 'date', path: 'fields.created' },
  ],
  fieldCount: 5,
  metadata: { connectorType: 'jira' },
};

const mockCanonicalSchema = {
  _id: 'cs-1',
  tenantId: 'tenant-1',
  knowledgeBaseId: 'kb-1',
  fields: [
    { name: 'Priority', storageField: 'priority', type: 'string' },
    { name: 'Status', storageField: 'status', type: 'string' },
    { name: 'Title', storageField: 'title', type: 'string' },
    { name: 'Custom 1', storageField: 'custom_string_1', type: 'string' },
    { name: 'Created At', storageField: 'created_at', type: 'date' },
  ],
  status: 'active',
};

const mockRuleResults = [
  {
    canonicalField: 'priority',
    sourcePath: 'fields.priority.name',
    transform: { type: 'direct' as const },
    confidence: 1.0,
    reasoning: 'Exact name match',
    suggestedAlias: 'Priority',
    mappingSource: 'rule-based' as const,
  },
  {
    canonicalField: 'status',
    sourcePath: 'fields.status.name',
    transform: { type: 'direct' as const },
    confidence: 1.0,
    reasoning: 'Exact name match',
    suggestedAlias: 'Status',
    mappingSource: 'rule-based' as const,
  },
  {
    canonicalField: 'created_at',
    sourcePath: 'fields.created',
    transform: { type: 'parse_date' as const, sourceFormat: 'ISO8601' },
    confidence: 0.9,
    reasoning: 'Normalized name match',
    suggestedAlias: 'Created At',
    mappingSource: 'rule-based' as const,
  },
];

const mockLLMResponse = {
  suggestions: [
    {
      canonicalField: 'title',
      sourcePath: 'fields.summary',
      transform: { type: 'direct' as const },
      confidence: 0.85,
      reasoning: 'Summary maps to title in Jira',
      suggestedAlias: 'Title',
    },
    {
      canonicalField: 'custom_string_1',
      sourcePath: 'fields.customfield_10001',
      transform: { type: 'direct' as const },
      confidence: 0.6,
      reasoning: 'Custom field mapping',
      suggestedAlias: 'Custom Field 1',
    },
  ],
  totalProcessed: 2,
  averageConfidence: 0.725,
  processingTimeMs: 1500,
};

const mockProcessSuggestionsResult = {
  autoApplied: [{ _id: 'fm-1', status: 'active' }],
  pending: [{ _id: 'fm-2', status: 'suggested' }],
  filteredCount: 0,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FieldMappingSuggestionWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDiscoveredSchemaModel.findOne.mockResolvedValue(mockDiscoveredSchema);
    mockCanonicalSchemaModel.findOne.mockResolvedValue(mockCanonicalSchema);
    mockFieldMappingModel.find.mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    });
    vi.mocked(generateMappings).mockReturnValue(mockRuleResults);
    vi.mocked(mappingSuggestionService.suggestMappings).mockResolvedValue(mockLLMResponse);
    vi.mocked(confidenceScoringService.processSuggestions).mockResolvedValue(
      mockProcessSuggestionsResult as any,
    );
  });

  describe('Full Pipeline', () => {
    it('should run rules then LLM then confidence scoring', async () => {
      const job = createMockJob();
      await processFieldMappingSuggestionJob(job);

      // Rule-based called with all unmapped fields
      expect(generateMappings).toHaveBeenCalledWith({
        fields: mockDiscoveredSchema.fields,
        connectorType: 'jira',
        logger: expect.anything(),
      });

      // LLM called with fields NOT matched by rules
      expect(mappingSuggestionService.suggestMappings).toHaveBeenCalledWith(
        'tenant-1',
        'index-1',
        expect.objectContaining({
          connectorType: 'jira',
          existingMappings: [],
        }),
      );

      // Verify LLM only got the 2 unmapped fields (summary + custom_field_1)
      const llmCall = vi.mocked(mappingSuggestionService.suggestMappings).mock.calls[0];
      expect(llmCall[2].sourceFields).toHaveLength(2);
      expect(llmCall[2].sourceFields.map((f: any) => f.path)).toEqual([
        'fields.summary',
        'fields.customfield_10001',
      ]);

      // Confidence scoring called twice: once for rules, once for LLM
      expect(confidenceScoringService.processSuggestions).toHaveBeenCalledTimes(2);
      expect(confidenceScoringService.processSuggestions).toHaveBeenCalledWith(
        expect.objectContaining({ suggestedBy: 'rules' }),
      );
      expect(confidenceScoringService.processSuggestions).toHaveBeenCalledWith(
        expect.objectContaining({ suggestedBy: 'llm' }),
      );

      // Progress updated
      expect(job.updateProgress).toHaveBeenCalledWith(100);
    });

    it('should pass correct canonicalSchemaId and connectorId to confidence scoring', async () => {
      const job = createMockJob();
      await processFieldMappingSuggestionJob(job);

      const calls = vi.mocked(confidenceScoringService.processSuggestions).mock.calls;
      for (const call of calls) {
        expect(call[0].canonicalSchemaId).toBe('cs-1');
        expect(call[0].connectorId).toBe('connector-1');
        expect(call[0].tenantId).toBe('tenant-1');
      }
    });
  });

  describe('Rules Cover All Fields', () => {
    it('should skip LLM when rules match every field', async () => {
      // Return a rule result for every discovered field
      const allFieldRules = mockDiscoveredSchema.fields.map((f) => ({
        canonicalField: f.name,
        sourcePath: f.path,
        transform: { type: 'direct' as const },
        confidence: 0.9,
        reasoning: 'Match',
        mappingSource: 'rule-based' as const,
      }));
      vi.mocked(generateMappings).mockReturnValue(allFieldRules);

      const job = createMockJob();
      await processFieldMappingSuggestionJob(job);

      // LLM should NOT be called
      expect(mappingSuggestionService.suggestMappings).not.toHaveBeenCalled();

      // Confidence scoring still called for rule results
      expect(confidenceScoringService.processSuggestions).toHaveBeenCalledTimes(2);
      // LLM batch should have empty suggestions
      const llmBatchCall = vi.mocked(confidenceScoringService.processSuggestions).mock.calls[1];
      expect(llmBatchCall[0].suggestions).toHaveLength(0);
    });
  });

  describe('LLM Failure (Graceful Degradation)', () => {
    it('should continue with rule-based results when LLM fails', async () => {
      vi.mocked(mappingSuggestionService.suggestMappings).mockRejectedValue(
        new Error('LLM provider unavailable'),
      );

      const job = createMockJob();
      await processFieldMappingSuggestionJob(job);

      // Rule-based still called
      expect(generateMappings).toHaveBeenCalled();

      // Confidence scoring called for rules, LLM batch is empty
      expect(confidenceScoringService.processSuggestions).toHaveBeenCalledTimes(2);
      const ruleCall = vi.mocked(confidenceScoringService.processSuggestions).mock.calls[0];
      expect(ruleCall[0].suggestedBy).toBe('rules');
      expect(ruleCall[0].suggestions).toHaveLength(3);

      const llmCall = vi.mocked(confidenceScoringService.processSuggestions).mock.calls[1];
      expect(llmCall[0].suggestedBy).toBe('llm');
      expect(llmCall[0].suggestions).toHaveLength(0);

      // Job completes (no throw)
      expect(job.updateProgress).toHaveBeenCalledWith(100);
    });
  });

  describe('Empty Discovered Schema', () => {
    it('should return early when all fields already mapped', async () => {
      // All fields already have existing mappings
      mockFieldMappingModel.find.mockReturnValue({
        lean: vi.fn().mockResolvedValue(
          mockDiscoveredSchema.fields.map((f) => ({
            sourcePath: f.path,
            canonicalField: f.name,
          })),
        ),
      });

      const job = createMockJob();
      await processFieldMappingSuggestionJob(job);

      // No service calls made
      expect(generateMappings).not.toHaveBeenCalled();
      expect(mappingSuggestionService.suggestMappings).not.toHaveBeenCalled();
      expect(confidenceScoringService.processSuggestions).not.toHaveBeenCalled();
      expect(job.updateProgress).toHaveBeenCalledWith(100);
    });
  });

  describe('Schema Not Found', () => {
    it('should throw when DiscoveredSchema not found', async () => {
      mockDiscoveredSchemaModel.findOne.mockResolvedValue(null);

      const job = createMockJob();
      await expect(processFieldMappingSuggestionJob(job)).rejects.toThrow(
        'DiscoveredSchema not found: ds-1',
      );
    });

    it('should auto-create CanonicalSchema when not found', async () => {
      mockCanonicalSchemaModel.findOne.mockResolvedValue(null);
      mockCanonicalSchemaModel.create.mockResolvedValue({
        _id: 'auto-created-cs',
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        version: 1,
        fields: [],
        status: 'active',
      });

      const job = createMockJob();
      await processFieldMappingSuggestionJob(job);

      expect(mockCanonicalSchemaModel.create).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        version: 1,
        fields: [],
        status: 'active',
      });
    });
  });

  describe('De-duplication', () => {
    it('should prefer rule-based over LLM when both suggest same sourcePath', async () => {
      // LLM also suggests a mapping for priority (already matched by rules)
      const llmWithDuplicate = {
        ...mockLLMResponse,
        suggestions: [
          ...mockLLMResponse.suggestions,
          {
            canonicalField: 'priority',
            sourcePath: 'fields.priority.name', // Same as rule-based
            transform: { type: 'direct' as const },
            confidence: 0.7,
            reasoning: 'LLM also found priority',
            suggestedAlias: 'Priority',
          },
        ],
      };
      vi.mocked(mappingSuggestionService.suggestMappings).mockResolvedValue(llmWithDuplicate);

      const job = createMockJob();
      await processFieldMappingSuggestionJob(job);

      // LLM confidence scoring should NOT include the duplicate
      const llmBatchCall = vi.mocked(confidenceScoringService.processSuggestions).mock.calls[1];
      const llmSourcePaths = llmBatchCall[0].suggestions.map((s: any) => s.sourcePath);
      expect(llmSourcePaths).not.toContain('fields.priority.name');
      expect(llmSourcePaths).toEqual(['fields.summary', 'fields.customfield_10001']);
    });
  });

  describe('Existing Mappings Excluded', () => {
    it('should exclude already-mapped fields from processing', async () => {
      // Priority already mapped
      mockFieldMappingModel.find.mockReturnValue({
        lean: vi
          .fn()
          .mockResolvedValue([{ sourcePath: 'fields.priority.name', canonicalField: 'priority' }]),
      });

      const job = createMockJob();
      await processFieldMappingSuggestionJob(job);

      // generateMappings should receive only 4 fields (not priority)
      const ruleCall = vi.mocked(generateMappings).mock.calls[0];
      const fields = ruleCall[0].fields;
      expect(fields).toHaveLength(4);
      expect(fields.map((f: any) => f.name)).not.toContain('priority');
    });
  });

  describe('Progress Updates', () => {
    it('should update progress at key stages', async () => {
      const job = createMockJob();
      await processFieldMappingSuggestionJob(job);

      const progressCalls = job.updateProgress.mock.calls.map((c: any) => c[0]);
      expect(progressCalls).toContain(10);
      expect(progressCalls).toContain(20);
      expect(progressCalls).toContain(25);
      expect(progressCalls).toContain(50);
      expect(progressCalls).toContain(75);
      expect(progressCalls).toContain(95);
      expect(progressCalls).toContain(100);
    });
  });

  describe('Job Data Passed Correctly', () => {
    it('should query DiscoveredSchema with correct id and tenantId', async () => {
      const job = createMockJob();
      await processFieldMappingSuggestionJob(job);

      expect(mockDiscoveredSchemaModel.findOne).toHaveBeenCalledWith({
        _id: 'ds-1',
        tenantId: 'tenant-1',
      });
    });

    it('should query CanonicalSchema with correct knowledgeBaseId and tenantId', async () => {
      const job = createMockJob();
      await processFieldMappingSuggestionJob(job);

      expect(mockCanonicalSchemaModel.findOne).toHaveBeenCalledWith({
        knowledgeBaseId: 'kb-1',
        tenantId: 'tenant-1',
        status: 'active',
      });
    });

    it('should query existing FieldMappings scoped to tenant and connector', async () => {
      const job = createMockJob();
      await processFieldMappingSuggestionJob(job);

      expect(mockFieldMappingModel.find).toHaveBeenCalledWith({
        canonicalSchemaId: 'cs-1',
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
      });
    });

    it('should convert discovered fields to connector schema format for LLM', async () => {
      const job = createMockJob();
      await processFieldMappingSuggestionJob(job);

      const llmCall = vi.mocked(mappingSuggestionService.suggestMappings).mock.calls[0];
      const sourceFields = llmCall[2].sourceFields;

      // Check connector schema field format
      for (const field of sourceFields) {
        expect(field).toHaveProperty('path');
        expect(field).toHaveProperty('label');
        expect(field).toHaveProperty('type');
        expect(field).toHaveProperty('isCustom');
        expect(field).toHaveProperty('isRequired');
      }
    });
  });
});
