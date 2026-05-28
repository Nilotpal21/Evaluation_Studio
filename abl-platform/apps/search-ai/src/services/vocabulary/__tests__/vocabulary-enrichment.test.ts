import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ITermCandidate } from '@agent-platform/database/models';
import type { EnumCandidate } from '../types.js';

// ─── Hoisted mocks ────────────────────────────────────────────────────────

const { mockDomainVocabularyFindOne, mockDomainVocabularyCreate, mockUuidv7, mockLlmChat } =
  vi.hoisted(() => ({
    mockDomainVocabularyFindOne: vi.fn(),
    mockDomainVocabularyCreate: vi.fn(),
    mockUuidv7: vi.fn(() => 'test-uuid-001'),
    mockLlmChat: vi.fn(),
  }));

vi.mock('../../../db/index.js', () => ({
  getLazyModel: vi.fn((name: string) => {
    if (name === 'DomainVocabulary') {
      return {
        findOne: mockDomainVocabularyFindOne,
        create: mockDomainVocabularyCreate,
      };
    }
    return { findOne: vi.fn(), create: vi.fn() };
  }),
}));

vi.mock('@agent-platform/database/mongo', () => ({
  uuidv7: () => mockUuidv7(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Import after mocks
import { VocabularyEnrichmentService } from '../vocabulary-enrichment.service.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeLlmClient() {
  return { chat: mockLlmChat } as any;
}

function makeTermCandidate(overrides: Partial<ITermCandidate> = {}): ITermCandidate {
  return {
    term: 'priority',
    frequency: 42,
    queryCount: 30,
    fieldAffinity: 'issue_priority',
    coOccurrences: [{ term: 'status', count: 15 }],
    sampleQueries: ['show high priority tickets'],
    ...overrides,
  };
}

function makeEnumCandidate(overrides: Partial<EnumCandidate> = {}): EnumCandidate {
  return {
    storageField: 'issue_priority',
    alias: 'priority',
    label: 'Priority',
    values: [
      { value: 'High', count: 100, frequency: 0.3 },
      { value: 'Medium', count: 150, frequency: 0.45 },
      { value: 'Low', count: 80, frequency: 0.25 },
    ],
    cardinality: 3,
    confidence: 0.9,
    ...overrides,
  };
}

function makeLlmResponse(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify(entries);
}

function makeValidLlmEntry(term: string) {
  return {
    term,
    aliases: [`${term} alias`, `${term} alt`],
    fieldRef: `${term}_field`,
    description: `Description for ${term}`,
    confidence: 0.85,
    capabilities: {
      canFilter: true,
      canDisplay: true,
      canAggregate: true,
      canSort: false,
    },
    relatedFields: {
      displayWith: ['status'],
      aggregateWith: ['project'],
    },
  };
}

function makeTerms(count: number): ITermCandidate[] {
  return Array.from({ length: count }, (_, i) =>
    makeTermCandidate({ term: `term${i}`, fieldAffinity: `field${i}` }),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('VocabularyEnrichmentService', () => {
  let service: VocabularyEnrichmentService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new VocabularyEnrichmentService();
    mockDomainVocabularyFindOne.mockResolvedValue(null);
    mockDomainVocabularyCreate.mockResolvedValue({ _id: 'vocab-1', version: 1 });
    mockUuidv7.mockReturnValue('test-uuid-001');
  });

  describe('batching', () => {
    it('should split 120 terms into 3 batches of 50+50+20', async () => {
      const terms = makeTerms(120);
      const response = makeLlmResponse([makeValidLlmEntry('term0')]);

      // Each call returns at least one valid entry for one term from the batch
      mockLlmChat.mockImplementation(async (_sys: string, msgs: any[]) => {
        // Extract term names from the user message to return matching entries
        const userMsg = msgs[0].content as string;
        const matched = terms
          .filter((t) => userMsg.includes(`"${t.term}"`))
          .slice(0, 5) // Return subset to keep test fast
          .map((t) => makeValidLlmEntry(t.term));
        return makeLlmResponse(matched);
      });

      await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      // Should have made exactly 3 LLM calls (50+50+20)
      expect(mockLlmChat).toHaveBeenCalledTimes(3);
    });

    it('should handle fewer than 50 terms in a single batch', async () => {
      const terms = makeTerms(10);
      mockLlmChat.mockResolvedValue(makeLlmResponse(terms.map((t) => makeValidLlmEntry(t.term))));

      await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      expect(mockLlmChat).toHaveBeenCalledTimes(1);
    });
  });

  describe('LLM response parsing', () => {
    it('should parse plain JSON array', async () => {
      const terms = [makeTermCandidate({ term: 'priority' })];
      mockLlmChat.mockResolvedValue(makeLlmResponse([makeValidLlmEntry('priority')]));

      const result = await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      expect(result.enrichedCount).toBe(1);
      expect(result.entries[0].term).toBe('priority');
      expect(result.entries[0].aliases).toEqual(['priority alias', 'priority alt']);
    });

    it('should parse JSON inside markdown code fences', async () => {
      const terms = [makeTermCandidate({ term: 'status' })];
      const fencedResponse = '```json\n' + makeLlmResponse([makeValidLlmEntry('status')]) + '\n```';
      mockLlmChat.mockResolvedValue(fencedResponse);

      const result = await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      expect(result.enrichedCount).toBe(1);
      expect(result.entries[0].term).toBe('status');
    });

    it('should handle unparseable response gracefully', async () => {
      const terms = [makeTermCandidate({ term: 'priority' })];
      mockLlmChat.mockResolvedValue('This is not JSON at all');

      const result = await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      expect(result.enrichedCount).toBe(0);
      expect(result.failedCount).toBe(0); // Parse failure is not a batch failure
    });
  });

  describe('validation', () => {
    it('should reject entries with empty aliases', async () => {
      const terms = [makeTermCandidate({ term: 'priority' })];
      const entry = makeValidLlmEntry('priority');
      entry.aliases = [];
      mockLlmChat.mockResolvedValue(makeLlmResponse([entry]));

      const result = await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      expect(result.enrichedCount).toBe(0);
    });

    it('should reject entries with missing term', async () => {
      const terms = [makeTermCandidate({ term: 'priority' })];
      const entry = makeValidLlmEntry('priority');
      (entry as any).term = '';
      mockLlmChat.mockResolvedValue(makeLlmResponse([entry]));

      const result = await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      expect(result.enrichedCount).toBe(0);
    });

    it('should reject entries whose term does not match any input candidate', async () => {
      const terms = [makeTermCandidate({ term: 'priority' })];
      mockLlmChat.mockResolvedValue(
        makeLlmResponse([makeValidLlmEntry('completely_unrelated_hallucination')]),
      );

      const result = await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      expect(result.enrichedCount).toBe(0);
    });

    it('should filter out non-string aliases', async () => {
      const terms = [makeTermCandidate({ term: 'priority' })];
      const entry = makeValidLlmEntry('priority');
      (entry.aliases as any) = ['valid', '', null, 42, 'also valid'];
      mockLlmChat.mockResolvedValue(makeLlmResponse([entry]));

      const result = await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      expect(result.enrichedCount).toBe(1);
      expect(result.entries[0].aliases).toEqual(['valid', 'also valid']);
    });
  });

  describe('circuit breaker', () => {
    it('should open after 3 consecutive failures and skip remaining batches', async () => {
      // Create 150 terms = 3 batches
      const terms = makeTerms(150);

      // All LLM calls throw
      mockLlmChat.mockRejectedValue(new Error('LLM unavailable'));

      const result = await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      expect(result.circuitBreakerTripped).toBe(true);
      expect(result.enrichedCount).toBe(0);
      // First batch fails after 3 retries (3 calls), circuit opens, rest are skipped
      expect(result.skippedCount).toBeGreaterThan(0);
    });

    it('should record success and keep circuit closed on successful calls', async () => {
      const terms = makeTerms(100); // 2 batches
      mockLlmChat.mockResolvedValue(makeLlmResponse([makeValidLlmEntry('term0')]));

      const result = await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      expect(result.circuitBreakerTripped).toBe(false);
    });
  });

  describe('graceful degradation', () => {
    it('should return partial results when some batches fail', async () => {
      const terms = makeTerms(100); // 2 batches
      let callCount = 0;

      mockLlmChat.mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) {
          // First call succeeds
          return makeLlmResponse([makeValidLlmEntry('term0')]);
        }
        // All subsequent calls fail
        throw new Error('LLM error');
      });

      const result = await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      // First batch succeeded with 1 entry, second batch failed
      expect(result.enrichedCount).toBe(1);
      expect(result.failedCount).toBe(50);
    });

    it('should return empty result for zero term candidates', async () => {
      const result = await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: [],
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      expect(result.enrichedCount).toBe(0);
      expect(result.totalTerms).toBe(0);
      expect(mockLlmChat).not.toHaveBeenCalled();
    });
  });

  describe('token usage tracking', () => {
    it('should estimate input and output token counts', async () => {
      const terms = [makeTermCandidate({ term: 'priority' })];
      mockLlmChat.mockResolvedValue(makeLlmResponse([makeValidLlmEntry('priority')]));

      const result = await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      expect(result.tokenUsage.estimatedInputTokens).toBeGreaterThan(0);
      expect(result.tokenUsage.estimatedOutputTokens).toBeGreaterThan(0);
    });

    it('should accumulate tokens across batches', async () => {
      const terms = makeTerms(100); // 2 batches
      mockLlmChat.mockResolvedValue(makeLlmResponse([makeValidLlmEntry('term0')]));

      const result = await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      // 2 batches should produce more tokens than 1
      // Input tokens should be substantial (system prompt + 50 terms each)
      expect(result.tokenUsage.estimatedInputTokens).toBeGreaterThan(100);
    });
  });

  describe('tenant isolation', () => {
    it('should query DomainVocabulary with tenantId', async () => {
      const terms = [makeTermCandidate({ term: 'priority' })];
      mockLlmChat.mockResolvedValue(makeLlmResponse([makeValidLlmEntry('priority')]));

      await service.enrichTerms({
        tenantId: 'tenant-42',
        knowledgeBaseId: 'kb-99',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      expect(mockDomainVocabularyFindOne).toHaveBeenCalledWith({
        projectKnowledgeBaseId: 'kb-99',
        tenantId: 'tenant-42',
        status: 'active',
      });
    });

    it('should create vocabulary with correct tenantId when none exists', async () => {
      const terms = [makeTermCandidate({ term: 'priority' })];
      mockLlmChat.mockResolvedValue(makeLlmResponse([makeValidLlmEntry('priority')]));
      mockDomainVocabularyFindOne.mockResolvedValue(null);

      await service.enrichTerms({
        tenantId: 'tenant-42',
        knowledgeBaseId: 'kb-99',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      expect(mockDomainVocabularyCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-42',
          projectKnowledgeBaseId: 'kb-99',
          status: 'active',
        }),
      );
    });
  });

  describe('vocabulary upsert', () => {
    it('should merge with existing vocabulary preserving manual entries', async () => {
      const terms = [makeTermCandidate({ term: 'priority' })];
      mockLlmChat.mockResolvedValue(makeLlmResponse([makeValidLlmEntry('priority')]));

      const existingVocab = {
        _id: 'vocab-existing',
        tenantId: 'tenant-1',
        version: 2,
        entries: [
          {
            id: 'manual-1',
            term: 'custom term',
            aliases: ['my alias'],
            fieldRef: 'custom_field',
            capabilities: {
              canFilter: true,
              canDisplay: true,
              canAggregate: false,
              canSort: false,
            },
            relatedFields: { displayWith: [], aggregateWith: [] },
            enabled: true,
            generatedBy: 'manual',
          },
          {
            id: 'auto-old',
            term: 'priority',
            aliases: ['old alias'],
            fieldRef: 'old_field',
            capabilities: {
              canFilter: true,
              canDisplay: true,
              canAggregate: false,
              canSort: false,
            },
            relatedFields: { displayWith: [], aggregateWith: [] },
            enabled: true,
            generatedBy: 'auto',
          },
        ],
        updatedAt: new Date(),
        save: vi.fn().mockResolvedValue(undefined),
      };
      mockDomainVocabularyFindOne.mockResolvedValue(existingVocab);

      await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: [],
        llmClient: makeLlmClient(),
      });

      expect(existingVocab.save).toHaveBeenCalled();
      // Should have manual entry + new auto entry (old auto "priority" replaced)
      expect(existingVocab.entries.length).toBe(2);
      expect(existingVocab.entries[0].generatedBy).toBe('manual');
      expect(existingVocab.entries[1].term).toBe('priority');
      expect(existingVocab.entries[1].generatedBy).toBe('auto');
      expect(existingVocab.version).toBe(3);
    });
  });

  describe('enum context in prompt', () => {
    it('should include enum values in prompt when available', async () => {
      const terms = [makeTermCandidate({ term: 'priority', fieldAffinity: 'issue_priority' })];
      const enums = [makeEnumCandidate({ storageField: 'issue_priority' })];

      mockLlmChat.mockResolvedValue(makeLlmResponse([makeValidLlmEntry('priority')]));

      await service.enrichTerms({
        tenantId: 'tenant-1',
        knowledgeBaseId: 'kb-1',
        connectorType: 'jira',
        termCandidates: terms,
        enumCandidates: enums,
        llmClient: makeLlmClient(),
      });

      // Check that the user message includes enum values
      const userMessage = mockLlmChat.mock.calls[0][1][0].content;
      expect(userMessage).toContain('Known Values:');
      expect(userMessage).toContain('High');
      expect(userMessage).toContain('Medium');
      expect(userMessage).toContain('Low');
    });
  });
});
