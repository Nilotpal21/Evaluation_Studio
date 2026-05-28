import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryTypeClassifier } from '../query-type-classifier.service.js';
import type { WorkerLLMClient } from '@agent-platform/llm';
import { QUERY_TYPE_EXAMPLES } from '../query-type-examples.js';

// ─── Mock LLM Client ─────────────────────────────────────────────────────

const createMockLLMClient = (): WorkerLLMClient =>
  ({
    chat: vi.fn(),
    getModelForTier: vi.fn(),
  }) as any;

// ─── Test Data ───────────────────────────────────────────────────────────

const mockStructuredResponse = JSON.stringify({
  queryType: 'structured',
  confidence: 0.95,
  reasoning: 'Query contains field-based filters (priority, status)',
  expectedComponents: {
    filters: ['priority', 'status'],
  },
});

const mockSemanticResponse = JSON.stringify({
  queryType: 'semantic',
  confidence: 0.88,
  reasoning: 'Query requires concept search in descriptions',
  expectedComponents: {
    concepts: ['authentication', 'security'],
  },
});

const mockHybridResponse = JSON.stringify({
  queryType: 'hybrid',
  confidence: 0.92,
  reasoning: 'Combines structured filters with semantic concepts',
  expectedComponents: {
    filters: ['priority'],
    concepts: ['authentication'],
  },
});

const mockAggregationResponse = JSON.stringify({
  queryType: 'aggregation',
  confidence: 0.96,
  reasoning: 'Contains aggregation function and grouping',
  expectedComponents: {
    aggregation: {
      function: 'count',
      groupBy: 'assignee',
    },
  },
});

const mockResponseWithMarkdown = `Here's the classification:

\`\`\`json
{
  "queryType": "structured",
  "confidence": 0.95,
  "reasoning": "Field-based query",
  "expectedComponents": {
    "filters": ["status"]
  }
}
\`\`\`

This is a structured query.`;

// ─── Tests ───────────────────────────────────────────────────────────────

describe('QueryTypeClassifier', () => {
  let classifier: QueryTypeClassifier;
  let mockLLMClient: WorkerLLMClient;

  beforeEach(() => {
    mockLLMClient = createMockLLMClient();
    classifier = new QueryTypeClassifier(mockLLMClient);
    classifier.clearCache(); // Clear cache between tests
  });

  describe('classify', () => {
    it('classifies structured queries correctly', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      const result = await classifier.classify({
        query: 'Show high priority open bugs',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.queryType).toBe('structured');
      expect(result.confidence).toBe(0.95);
      expect(result.reasoning).toContain('field-based');
      expect(result.expectedComponents.filters).toEqual(['priority', 'status']);
      expect(mockLLMClient.chat).toHaveBeenCalledWith(
        expect.stringContaining('query type classifier'),
        [{ role: 'user', content: expect.stringContaining('Show high priority open bugs') }],
        expect.objectContaining({
          model: 'claude-3-5-haiku-20241022',
          maxTokens: 500,
        }),
      );
    });

    it('classifies semantic queries correctly', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockSemanticResponse);

      const result = await classifier.classify({
        query: 'Find bugs about authentication problems',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.queryType).toBe('semantic');
      expect(result.confidence).toBe(0.88);
      expect(result.reasoning).toContain('concept search');
      expect(result.expectedComponents.concepts).toEqual(['authentication', 'security']);
    });

    it('classifies hybrid queries correctly', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockHybridResponse);

      const result = await classifier.classify({
        query: 'Show high priority bugs about authentication',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.queryType).toBe('hybrid');
      expect(result.confidence).toBe(0.92);
      expect(result.reasoning).toContain('Combines structured filters');
      expect(result.expectedComponents.filters).toEqual(['priority']);
      expect(result.expectedComponents.concepts).toEqual(['authentication']);
    });

    it('classifies aggregation queries correctly', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockAggregationResponse);

      const result = await classifier.classify({
        query: 'Count bugs by assignee',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.queryType).toBe('aggregation');
      expect(result.confidence).toBe(0.96);
      expect(result.reasoning).toContain('aggregation function');
      expect(result.expectedComponents.aggregation).toEqual({
        function: 'count',
        groupBy: 'assignee',
      });
    });

    it('handles different connector types', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      // Test Jira
      await classifier.classify({
        query: 'Show high priority bugs',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      const jiraCall = vi.mocked(mockLLMClient.chat).mock.calls[0];
      expect(jiraCall[0]).toContain('Show high priority bugs');
      expect(jiraCall[0]).toContain('Jira-specific');

      vi.clearAllMocks();

      // Test Salesforce
      await classifier.classify({
        query: 'Show high value opportunities',
        connectorType: 'salesforce',
        tenantId: 'tenant_123',
      });

      const salesforceCall = vi.mocked(mockLLMClient.chat).mock.calls[0];
      expect(salesforceCall[0]).toContain('Salesforce');
    });

    it('falls back to generic examples for unknown connectors', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      await classifier.classify({
        query: 'Show active items',
        connectorType: 'unknown_connector',
        tenantId: 'tenant_123',
      });

      const call = vi.mocked(mockLLMClient.chat).mock.calls[0];
      expect(call[0]).toContain('high priority items');
    });

    it('falls back to semantic query on LLM error', async () => {
      vi.mocked(mockLLMClient.chat).mockRejectedValue(new Error('LLM service unavailable'));

      const result = await classifier.classify({
        query: 'Some query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.queryType).toBe('semantic');
      expect(result.confidence).toBe(0.5);
      expect(result.reasoning).toContain('Classification failed');
      expect(result.expectedComponents).toEqual({});
    });

    it('falls back to semantic query on parsing error', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue('Invalid JSON response');

      const result = await classifier.classify({
        query: 'Some query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.queryType).toBe('semantic');
      expect(result.confidence).toBe(0.5);
      expect(result.reasoning).toContain('Classification failed');
    });

    it('parses JSON wrapped in markdown code blocks', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockResponseWithMarkdown);

      const result = await classifier.classify({
        query: 'Show open bugs',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.queryType).toBe('structured');
      expect(result.confidence).toBe(0.95);
      expect(result.reasoning).toBe('Field-based query');
    });

    it('handles empty expectedComponents gracefully', async () => {
      const responseWithoutComponents = JSON.stringify({
        queryType: 'structured',
        confidence: 0.9,
        reasoning: 'Simple query',
      });

      vi.mocked(mockLLMClient.chat).mockResolvedValue(responseWithoutComponents);

      const result = await classifier.classify({
        query: 'Show items',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.queryType).toBe('structured');
      expect(result.expectedComponents).toEqual({});
    });
  });

  describe('loadExamples', () => {
    it('loads connector-specific examples', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      await classifier.classify({
        query: 'Test query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      const call = vi.mocked(mockLLMClient.chat).mock.calls[0];
      const systemPrompt = call[0] as string;

      // Check that Jira-specific examples are included
      expect(systemPrompt).toContain('Show high priority bugs');
      expect(systemPrompt).toContain('Find bugs in sprint 23');
    });

    it('loads generic examples for unknown connectors', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      await classifier.classify({
        query: 'Test query',
        connectorType: 'unknown',
        tenantId: 'tenant_123',
      });

      const call = vi.mocked(mockLLMClient.chat).mock.calls[0];
      const systemPrompt = call[0] as string;

      // Check that generic examples are included
      expect(systemPrompt).toContain('Show high priority items');
      expect(systemPrompt).toContain('Find active records');
    });

    it('caches examples on first load', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      // First call
      await classifier.classify({
        query: 'Test query 1',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      const initialStats = classifier.getCacheStats();
      expect(initialStats.size).toBe(1);

      // Second call with same connector - should use cache
      await classifier.classify({
        query: 'Test query 2',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      const statsAfter = classifier.getCacheStats();
      expect(statsAfter.size).toBe(1); // Still 1, cache hit
    });

    it('caches examples for different connectors separately', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      await classifier.classify({
        query: 'Test query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      await classifier.classify({
        query: 'Test query',
        connectorType: 'salesforce',
        tenantId: 'tenant_123',
      });

      const stats = classifier.getCacheStats();
      expect(stats.size).toBe(2); // Two different connector types cached
    });
  });

  describe('buildClassificationPrompt', () => {
    it('includes all four query types in prompt', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      await classifier.classify({
        query: 'Test query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      const call = vi.mocked(mockLLMClient.chat).mock.calls[0];
      const systemPrompt = call[0] as string;

      expect(systemPrompt).toContain('structured');
      expect(systemPrompt).toContain('semantic');
      expect(systemPrompt).toContain('hybrid');
      expect(systemPrompt).toContain('aggregation');
    });

    it('includes examples for all query types', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      await classifier.classify({
        query: 'Test query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      const call = vi.mocked(mockLLMClient.chat).mock.calls[0];
      const systemPrompt = call[0] as string;

      // Check structured examples
      expect(systemPrompt).toContain('Show high priority bugs');

      // Check semantic examples
      expect(systemPrompt).toContain('Find bugs about API rate limiting');

      // Check hybrid examples
      expect(systemPrompt).toContain('Show high priority bugs about authentication');

      // Check aggregation examples
      expect(systemPrompt).toContain('Count bugs by assignee');
    });

    it('includes output format specification', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      await classifier.classify({
        query: 'Test query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      const call = vi.mocked(mockLLMClient.chat).mock.calls[0];
      const systemPrompt = call[0] as string;

      expect(systemPrompt).toContain('Output Format');
      expect(systemPrompt).toContain('queryType');
      expect(systemPrompt).toContain('confidence');
      expect(systemPrompt).toContain('reasoning');
      expect(systemPrompt).toContain('expectedComponents');
    });
  });

  describe('parseClassificationResult', () => {
    it('parses valid JSON response', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      const result = await classifier.classify({
        query: 'Test query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.queryType).toBe('structured');
      expect(result.confidence).toBe(0.95);
      expect(result.reasoning).toContain('field-based');
    });

    it('extracts JSON from markdown code blocks', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockResponseWithMarkdown);

      const result = await classifier.classify({
        query: 'Test query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.queryType).toBe('structured');
      expect(result.confidence).toBe(0.95);
    });

    it('falls back on invalid JSON', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue('Not a JSON response');

      const result = await classifier.classify({
        query: 'Test query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.queryType).toBe('semantic');
      expect(result.confidence).toBe(0.5);
      expect(result.reasoning).toContain('Classification failed');
    });

    it('falls back on missing required fields', async () => {
      const incompleteResponse = JSON.stringify({
        queryType: 'structured',
        // Missing confidence and reasoning
      });

      vi.mocked(mockLLMClient.chat).mockResolvedValue(incompleteResponse);

      const result = await classifier.classify({
        query: 'Test query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.queryType).toBe('semantic');
      expect(result.confidence).toBe(0.5);
      expect(result.reasoning).toContain('Classification failed');
    });

    it('handles JSON with extra whitespace', async () => {
      const responseWithWhitespace = `
        {
          "queryType": "structured",
          "confidence": 0.95,
          "reasoning": "Field-based query",
          "expectedComponents": {
            "filters": ["status"]
          }
        }
      `;

      vi.mocked(mockLLMClient.chat).mockResolvedValue(responseWithWhitespace);

      const result = await classifier.classify({
        query: 'Test query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.queryType).toBe('structured');
      expect(result.confidence).toBe(0.95);
    });
  });

  describe('cache management', () => {
    it('getCacheStats returns cache size and max', () => {
      const stats = classifier.getCacheStats();

      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('maxSize');
      expect(stats.maxSize).toBe(100);
      expect(typeof stats.size).toBe('number');
    });

    it('clearCache removes all cached examples', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      // Populate cache
      await classifier.classify({
        query: 'Test query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      await classifier.classify({
        query: 'Test query',
        connectorType: 'salesforce',
        tenantId: 'tenant_123',
      });

      const beforeStats = classifier.getCacheStats();
      expect(beforeStats.size).toBe(2);

      // Clear cache
      classifier.clearCache();

      const afterStats = classifier.getCacheStats();
      expect(afterStats.size).toBe(0);
    });

    it('cache persists examples across multiple classify calls', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      // First call
      await classifier.classify({
        query: 'Query 1',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      // Second call with same connector
      await classifier.classify({
        query: 'Query 2',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      // Third call with same connector
      await classifier.classify({
        query: 'Query 3',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      const stats = classifier.getCacheStats();
      expect(stats.size).toBe(1); // Only one entry for 'jira' connector
    });
  });

  describe('confidence scoring', () => {
    it('returns high confidence for structured queries', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      const result = await classifier.classify({
        query: 'Show high priority bugs',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('returns medium-high confidence for semantic queries', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockSemanticResponse);

      const result = await classifier.classify({
        query: 'Find bugs about authentication',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
      expect(result.confidence).toBeLessThan(0.95);
    });

    it('returns fallback confidence of 0.5 on errors', async () => {
      vi.mocked(mockLLMClient.chat).mockRejectedValue(new Error('LLM error'));

      const result = await classifier.classify({
        query: 'Some query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(result.confidence).toBe(0.5);
    });
  });

  describe('LLM model selection', () => {
    it('uses Haiku model for fast classification', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      await classifier.classify({
        query: 'Test query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(mockLLMClient.chat).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          model: 'claude-3-5-haiku-20241022',
        }),
      );
    });

    it('sets appropriate max tokens for classification', async () => {
      vi.mocked(mockLLMClient.chat).mockResolvedValue(mockStructuredResponse);

      await classifier.classify({
        query: 'Test query',
        connectorType: 'jira',
        tenantId: 'tenant_123',
      });

      expect(mockLLMClient.chat).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          maxTokens: 500,
        }),
      );
    });
  });
});
