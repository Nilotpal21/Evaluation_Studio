/**
 * Field Mapping → Vocabulary Generation Chain Tests
 *
 * Verifies that processFieldMappingSuggestionJob enqueues a vocabulary
 * generation job when auto-applied mappings exist, and skips when none do.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────────

const { mockDiscoveredSchemaModel, mockCanonicalSchemaModel, mockFieldMappingModel } = vi.hoisted(
  () => ({
    mockDiscoveredSchemaModel: {
      findOne: vi.fn(),
    },
    mockCanonicalSchemaModel: {
      findOne: vi.fn(),
    },
    mockFieldMappingModel: {
      find: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([]) })),
    },
  }),
);

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

// Mock canonical field helpers
vi.mock('@agent-platform/search-ai-internal/canonical', () => ({
  getAvailableFieldsForLLM: vi.fn(() => []),
  getAvailableField: vi.fn(),
  toCanonicalField: vi.fn(),
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

// Mock shared worker utilities — capture createQueue calls
const mockVocabQueue = {
  add: vi.fn().mockResolvedValue({}),
  close: vi.fn().mockResolvedValue({}),
};
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

// Mock search-ai-sdk
vi.mock('@agent-platform/search-ai-sdk', () => ({
  QUEUE_FIELD_MAPPING_SUGGESTION: 'search-field-mapping-suggestion',
}));

import { generateMappings } from '@agent-platform/search-ai-internal/services';
import { confidenceScoringService } from '../../services/confidence-scoring/index.js';
import { createQueue } from '../shared.js';
import {
  processFieldMappingSuggestionJob,
  type FieldMappingSuggestionJobData,
} from '../field-mapping-suggestion-worker.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

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
  fields: [
    { name: 'priority', type: 'string', path: 'fields.priority.name', enumValues: [] },
    { name: 'status', type: 'string', path: 'fields.status.name', enumValues: [] },
  ],
  fieldCount: 2,
};

const mockCanonicalSchema = {
  _id: 'cs-1',
  tenantId: 'tenant-1',
  knowledgeBaseId: 'kb-1',
  fields: [],
  status: 'active',
};

const mockRuleResults = [
  {
    canonicalField: 'priority',
    sourcePath: 'fields.priority.name',
    transform: { type: 'direct' as const },
    confidence: 1.0,
    reasoning: 'Match',
    suggestedAlias: 'Priority',
    mappingSource: 'rule-based' as const,
  },
  {
    canonicalField: 'status',
    sourcePath: 'fields.status.name',
    transform: { type: 'direct' as const },
    confidence: 1.0,
    reasoning: 'Match',
    suggestedAlias: 'Status',
    mappingSource: 'rule-based' as const,
  },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Field Mapping → Vocabulary Generation chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDiscoveredSchemaModel.findOne.mockResolvedValue(mockDiscoveredSchema);
    mockCanonicalSchemaModel.findOne.mockResolvedValue(mockCanonicalSchema);
    mockFieldMappingModel.find.mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    });
    vi.mocked(generateMappings).mockReturnValue(mockRuleResults);
  });

  it('should enqueue vocabulary generation when totalAutoApplied > 0', async () => {
    vi.mocked(confidenceScoringService.processSuggestions).mockResolvedValue({
      autoApplied: [{ _id: 'fm-1' }],
      pending: [],
      filteredCount: 0,
    } as any);

    const job = createMockJob();
    await processFieldMappingSuggestionJob(job);

    expect(createQueue).toHaveBeenCalledWith('vocabulary-generation');
    expect(mockVocabQueue.add).toHaveBeenCalledWith(
      'vocab-gen:connector-1',
      expect.objectContaining({
        connectorId: 'connector-1',
        projectKbId: 'kb-1',
        knowledgeBaseId: 'kb-1',
        tenantId: 'tenant-1',
        connectorType: 'jira',
        indexId: 'index-1',
      }),
    );
  });

  it('should NOT enqueue vocabulary generation when totalAutoApplied === 0', async () => {
    vi.mocked(confidenceScoringService.processSuggestions).mockResolvedValue({
      autoApplied: [],
      pending: [{ _id: 'fm-1' }],
      filteredCount: 0,
    } as any);

    const job = createMockJob();
    await processFieldMappingSuggestionJob(job);

    // createQueue should not have been called with vocabulary queue name
    expect(mockVocabQueue.add).not.toHaveBeenCalled();
  });

  it('should close the vocabulary queue in finally block', async () => {
    vi.mocked(confidenceScoringService.processSuggestions).mockResolvedValue({
      autoApplied: [{ _id: 'fm-1' }],
      pending: [],
      filteredCount: 0,
    } as any);

    const job = createMockJob();
    await processFieldMappingSuggestionJob(job);

    expect(mockVocabQueue.close).toHaveBeenCalled();
  });
});
