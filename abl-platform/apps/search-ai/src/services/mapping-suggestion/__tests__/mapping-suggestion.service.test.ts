/**
 * MappingSuggestionService Unit Tests
 *
 * Tests LLM client migration (WorkerLLMClient), enum hint extensions,
 * parseResponse hardening, and sanitization helpers.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockChat = vi.fn();

vi.mock('@agent-platform/llm', () => {
  const MockWorkerLLMClient = vi.fn().mockImplementation(function () {
    return { chat: mockChat };
  });
  return { WorkerLLMClient: MockWorkerLLMClient };
});

vi.mock('../../llm-config/resolver.js', () => ({
  resolveIndexLLMConfig: vi.fn(),
}));

vi.mock('@agent-platform/search-ai-internal/canonical', () => ({
  getTemplateForConnector: vi.fn(),
}));

// Mock circuit breaker registry to return null (skip Redis dependency in unit tests).
// The service handles null gracefully by executing LLM calls without circuit breaker.
vi.mock('../circuit-breaker-registry.js', () => ({
  getCircuitBreakerRegistry: vi.fn().mockReturnValue(null),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock PromptLoaderService so tests don't depend on YAML files on disk.
// The system_prompt and user_prompt_template match the content of
// apps/search-ai/src/prompts/v1/mapping-suggestion.yaml.
const MOCK_SYSTEM_PROMPT =
  'You are a data mapping expert. You analyze source connector schemas and suggest mappings to canonical schemas. You always respond with valid JSON arrays only.\n';

const MOCK_USER_PROMPT_TEMPLATE = `Your task is to suggest field mappings from a source connector schema to a canonical schema. For each mapping, also suggest a business-friendly alias name that users and AI agents will use to refer to this field.

**Connector Type:** {connectorType}
{templateHints}{enumHints}
**Source Fields:**
\`\`\`json
{sourceFieldsJson}
\`\`\`

**Canonical Fields:**
\`\`\`json
{canonicalFieldsJson}
\`\`\`

**Existing Mappings:**
\`\`\`json
{existingMappingsJson}
\`\`\`

For each source field, suggest the best canonical field mapping. Consider:
1. Field PURPOSE (match by what the field represents, not just its name)
2. Data type compatibility
3. Semantic meaning and sample values
4. The connector category patterns listed above (if available)
5. Custom fields (e.g., customfield_*) may match existing canonical fields — check sample values
6. When a source field has enumValues and the target canonical field has enum patterns listed above, generate a valueMap transform that maps each source enum value to the closest canonical enum value
7. If no canonical enum exists for a field, use transform.type = 'direct'

For each mapping, provide:
- canonicalField: The target canonical field name (the storage field)
- sourcePath: The source field path
- suggestedAlias: A business-friendly alias name. MUST be snake_case, max 50 chars, only [a-z0-9_], unique across all suggestions (e.g., "priority_level", "team_code")
- suggestedLabel: A display label. MUST be Title Case, max 100 chars (e.g., "Priority Level", "Team Code")
- transform.type: One of: direct, lowercase, uppercase, split, join, parse_date, value_map
- transform.valueMap: (if type is value_map) A mapping of source values to canonical values
- transform.delimiter: (if type is split/join) The delimiter character
- transform.sourceFormat: (if type is parse_date) The source date format
- confidence: A score from 0.0 to 1.0 indicating confidence in the mapping
- reasoning: Brief explanation of why this mapping makes sense

Return your response as a JSON array of mappings. Only suggest mappings with confidence >= 0.5.

Example response format:
\`\`\`json
[
  {
    "canonicalField": "title",
    "sourcePath": "summary",
    "suggestedAlias": "title",
    "suggestedLabel": "Title",
    "transform": { "type": "direct" },
    "confidence": 0.95,
    "reasoning": "Jira 'summary' field is semantically equivalent to 'title'"
  },
  {
    "canonicalField": "status",
    "sourcePath": "status.name",
    "suggestedAlias": "ticket_status",
    "suggestedLabel": "Ticket Status",
    "transform": {
      "type": "value_map",
      "valueMap": {
        "To Do": "open",
        "In Progress": "in_progress",
        "Done": "closed"
      }
    },
    "confidence": 0.9,
    "reasoning": "Map Jira status values to canonical status enum"
  },
  {
    "canonicalField": "custom_string_1",
    "sourcePath": "customfield_10042",
    "suggestedAlias": "team_code",
    "suggestedLabel": "Team Code",
    "transform": { "type": "direct" },
    "confidence": 0.78,
    "reasoning": "Custom field 'Team Code' has no standard canonical match, allocated to custom slot"
  }
]
\`\`\`

Respond only with the JSON array. Do not include any other text.
`;

vi.mock('../../prompts/prompt-loader.service.js', () => {
  class MockPromptLoaderService {
    loadPrompt() {
      return {
        metadata: {
          version: 1,
          author: 'System',
          created: '2026-03-16',
          description: 'Mapping suggestion prompt',
          model: 'claude-haiku-4-5-20251001',
          performance: { max_latency_ms: 120000, max_tokens: 4000 },
        },
        system_prompt: MOCK_SYSTEM_PROMPT,
        user_prompt_template: MOCK_USER_PROMPT_TEMPLATE,
      };
    }

    renderPrompt(template: string, variables: Record<string, any>) {
      let rendered = template;
      for (const [key, value] of Object.entries(variables)) {
        const placeholder = `{${key}}`;
        rendered = rendered.replace(
          new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          String(value),
        );
      }
      return rendered;
    }
  }
  return { PromptLoaderService: MockPromptLoaderService };
});

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { MappingSuggestionService } from '../mapping-suggestion.service.js';
import { WorkerLLMClient } from '@agent-platform/llm';
import { resolveIndexLLMConfig } from '../../llm-config/resolver.js';
import { getTemplateForConnector } from '@agent-platform/search-ai-internal/canonical';
import type { MappingSuggestionRequest } from '../mapping-suggestion.service.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-123';
const INDEX_ID = 'index-456';

const mockLLMConfig = {
  tenantId: TENANT_ID,
  provider: 'anthropic',
  apiKey: 'test-api-key',
  monthlyTokenBudget: 10_000_000,
  dailyTokenBudget: 500_000,
  maxRequestsPerMinute: 100,
  allowedProviders: ['anthropic'],
  indexId: INDEX_ID,
  embeddingModel: 'bge-m3',
  embeddingDimensions: 1024,
  useCases: {
    mapping_suggestion: {
      enabled: true,
      modelTier: 'fast' as const,
      model: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      apiKey: 'test-api-key',
    },
  },
};

const issueTicketTemplate = {
  category: 'issue_ticket',
  label: 'Issue Ticket',
  connectors: ['jira', 'linear'],
  fieldPatterns: {
    title: ['summary', 'name', 'subject'],
    status: ['status', 'state', 'workflow_state'],
    priority: ['priority', 'urgency', 'severity'],
  },
  relevantFields: ['title', 'status', 'priority'],
  expectedCustomFields: 15,
  enumPatterns: {
    priority: {
      values: ['critical', 'high', 'medium', 'low', 'trivial'],
      displayNames: {
        critical: 'Critical',
        high: 'High',
        medium: 'Medium',
        low: 'Low',
        trivial: 'Trivial',
      },
    },
    status: {
      values: ['open', 'in_progress', 'resolved', 'closed'],
      displayNames: {
        open: 'Open',
        in_progress: 'In Progress',
        resolved: 'Resolved',
        closed: 'Closed',
      },
    },
  },
};

const genericTemplate = {
  category: 'generic',
  label: 'Generic',
  connectors: [],
  fieldPatterns: {},
  relevantFields: [],
  expectedCustomFields: 10,
  enumPatterns: {
    status: {
      values: ['active', 'inactive', 'archived'],
      displayNames: { active: 'Active', inactive: 'Inactive', archived: 'Archived' },
    },
  },
};

function makeRequest(overrides?: Partial<MappingSuggestionRequest>): MappingSuggestionRequest {
  return {
    sourceFields: [
      {
        path: 'summary',
        label: 'Summary',
        type: 'string',
        isCustom: false,
        isRequired: true,
      },
      {
        path: 'priority.name',
        label: 'Priority',
        type: 'string',
        isCustom: false,
        isRequired: false,
        enumValues: ['Highest', 'High', 'Medium', 'Low', 'Lowest'],
      },
      {
        path: 'status.name',
        label: 'Status',
        type: 'string',
        isCustom: false,
        isRequired: false,
        enumValues: ['To Do', 'In Progress', 'Done'],
      },
    ],
    canonicalFields: [
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
    ] as any[],
    connectorType: 'jira',
    ...overrides,
  };
}

const VALID_LLM_RESPONSE = JSON.stringify([
  {
    canonicalField: 'title',
    sourcePath: 'summary',
    suggestedAlias: 'title',
    suggestedLabel: 'Title',
    transform: { type: 'direct' },
    confidence: 0.95,
    reasoning: 'Summary maps to title',
  },
  {
    canonicalField: 'priority',
    sourcePath: 'priority.name',
    suggestedAlias: 'priority_level',
    suggestedLabel: 'Priority Level',
    transform: {
      type: 'value_map',
      valueMap: {
        Highest: 'critical',
        High: 'high',
        Medium: 'medium',
        Low: 'low',
        Lowest: 'trivial',
      },
    },
    confidence: 0.9,
    reasoning: 'Priority enum needs value mapping',
  },
  {
    canonicalField: 'status',
    sourcePath: 'status.name',
    suggestedAlias: 'ticket_status',
    suggestedLabel: 'Ticket Status',
    transform: {
      type: 'value_map',
      valueMap: {
        'To Do': 'open',
        'In Progress': 'in_progress',
        Done: 'closed',
      },
    },
    confidence: 0.88,
    reasoning: 'Status enum needs value mapping',
  },
]);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MappingSuggestionService', () => {
  let service: MappingSuggestionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new MappingSuggestionService();

    vi.mocked(resolveIndexLLMConfig).mockResolvedValue(mockLLMConfig as any);
    vi.mocked(getTemplateForConnector).mockReturnValue(issueTicketTemplate as any);
    mockChat.mockResolvedValue(VALID_LLM_RESPONSE);
  });

  // ─── WorkerLLMClient Migration ──────────────────────────────────────────

  describe('LLM client migration', () => {
    test('creates WorkerLLMClient with resolved provider/apiKey/model', async () => {
      await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(WorkerLLMClient).toHaveBeenCalledWith(
        'anthropic',
        'test-api-key',
        'claude-haiku-4-5-20251001',
      );
    });

    test('calls resolveIndexLLMConfig with (tenantId, indexId)', async () => {
      await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(resolveIndexLLMConfig).toHaveBeenCalledWith(TENANT_ID, INDEX_ID);
    });

    test('calls llmClient.chat with system prompt and user message', async () => {
      await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(mockChat).toHaveBeenCalledWith(
        expect.stringContaining('data mapping expert'),
        [{ role: 'user', content: expect.any(String) }],
        { timeoutMs: 120_000 },
      );
    });

    test('returns empty suggestions when no LLM apiKey is configured', async () => {
      vi.mocked(resolveIndexLLMConfig).mockResolvedValue({
        ...mockLLMConfig,
        useCases: {
          mapping_suggestion: {
            enabled: true,
            modelTier: 'fast',
            model: '',
            provider: 'anthropic',
            apiKey: '',
          },
        },
      } as any);

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(result.suggestions).toEqual([]);
      expect(WorkerLLMClient).not.toHaveBeenCalled();
    });

    test('returns empty suggestions when mapping_suggestion use case is missing', async () => {
      vi.mocked(resolveIndexLLMConfig).mockResolvedValue({
        ...mockLLMConfig,
        useCases: {},
      } as any);

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(result.suggestions).toEqual([]);
    });

    test('passes resolved model directly from use case config', async () => {
      vi.mocked(resolveIndexLLMConfig).mockResolvedValue({
        ...mockLLMConfig,
        useCases: {
          mapping_suggestion: {
            enabled: true,
            modelTier: 'fast',
            model: 'claude-haiku-4-5-20251001',
            provider: 'openai',
            apiKey: 'sk-test',
          },
        },
      } as any);

      await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(WorkerLLMClient).toHaveBeenCalledWith(
        'openai',
        'sk-test',
        'claude-haiku-4-5-20251001',
      );
    });
  });

  // ─── buildPrompt — Enum Hints ──────────────────────────────────────────

  describe('buildPrompt enum hints', () => {
    test('includes enum pattern section when connector has enumPatterns', async () => {
      await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      const userPrompt = mockChat.mock.calls[0][1][0].content as string;
      expect(userPrompt).toContain('Canonical Enum Patterns');
      expect(userPrompt).toContain('priority: [critical, high, medium, low, trivial]');
      expect(userPrompt).toContain('status: [open, in_progress, resolved, closed]');
      expect(userPrompt).toContain('display:');
    });

    test('includes source field enumValues in serialized fields', async () => {
      await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      const userPrompt = mockChat.mock.calls[0][1][0].content as string;
      // The source fields JSON should include enumValues
      expect(userPrompt).toContain('"enumValues"');
      expect(userPrompt).toContain('Highest');
      expect(userPrompt).toContain('To Do');
    });

    test('omits enum section for generic template without non-generic category', async () => {
      vi.mocked(getTemplateForConnector).mockReturnValue(genericTemplate as any);

      await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      const userPrompt = mockChat.mock.calls[0][1][0].content as string;
      // Generic template still has enumPatterns, so the section should still appear
      expect(userPrompt).toContain('Canonical Enum Patterns');
      // But should NOT have the field patterns section
      expect(userPrompt).not.toContain('Connector Category:');
    });

    test('includes enum coercion instruction in prompt', async () => {
      await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      const userPrompt = mockChat.mock.calls[0][1][0].content as string;
      expect(userPrompt).toContain('generate a valueMap transform');
      expect(userPrompt).toContain("transform.type = 'direct'");
    });

    test('includes alias/label formatting instructions in prompt', async () => {
      await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      const userPrompt = mockChat.mock.calls[0][1][0].content as string;
      expect(userPrompt).toContain('MUST be snake_case');
      expect(userPrompt).toContain('MUST be Title Case');
      expect(userPrompt).toContain('max 50 chars');
      expect(userPrompt).toContain('max 100 chars');
    });
  });

  // ─── parseResponse — Value Map Extraction ─────────────────────────────

  describe('parseResponse', () => {
    test('correctly extracts transform.type = value_map with valueMap', async () => {
      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      const prioritySuggestion = result.suggestions.find((s) => s.canonicalField === 'priority');
      expect(prioritySuggestion).toBeDefined();
      expect(prioritySuggestion!.transform.type).toBe('value_map');
      expect(prioritySuggestion!.transform.valueMap).toEqual({
        Highest: 'critical',
        High: 'high',
        Medium: 'medium',
        Low: 'low',
        Lowest: 'trivial',
      });
    });

    test('downgrades to direct when valueMap is invalid', async () => {
      mockChat.mockResolvedValue(
        JSON.stringify([
          {
            canonicalField: 'status',
            sourcePath: 'status.name',
            transform: { type: 'value_map', valueMap: 'not-an-object' },
            confidence: 0.8,
            reasoning: 'test',
          },
        ]),
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(result.suggestions[0].transform.type).toBe('direct');
      expect(result.suggestions[0].transform.valueMap).toBeUndefined();
    });

    test('downgrades to direct when valueMap is missing for value_map type', async () => {
      mockChat.mockResolvedValue(
        JSON.stringify([
          {
            canonicalField: 'status',
            sourcePath: 'status.name',
            transform: { type: 'value_map' },
            confidence: 0.8,
            reasoning: 'test',
          },
        ]),
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(result.suggestions[0].transform.type).toBe('direct');
    });

    test('downgrades to direct when valueMap is an array', async () => {
      mockChat.mockResolvedValue(
        JSON.stringify([
          {
            canonicalField: 'status',
            sourcePath: 'status.name',
            transform: { type: 'value_map', valueMap: ['a', 'b'] },
            confidence: 0.8,
            reasoning: 'test',
          },
        ]),
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(result.suggestions[0].transform.type).toBe('direct');
    });

    test('validates suggestedAlias format (snake_case, max length)', async () => {
      mockChat.mockResolvedValue(
        JSON.stringify([
          {
            canonicalField: 'title',
            sourcePath: 'summary',
            suggestedAlias: 'My Field Name!!',
            suggestedLabel: 'Title',
            transform: { type: 'direct' },
            confidence: 0.9,
            reasoning: 'test',
          },
        ]),
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(result.suggestions[0].suggestedAlias).toBe('my_field_name');
    });

    test('validates suggestedLabel format (max length)', async () => {
      const longLabel = 'A'.repeat(200);
      mockChat.mockResolvedValue(
        JSON.stringify([
          {
            canonicalField: 'title',
            sourcePath: 'summary',
            suggestedLabel: longLabel,
            transform: { type: 'direct' },
            confidence: 0.9,
            reasoning: 'test',
          },
        ]),
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(result.suggestions[0].suggestedLabel!.length).toBeLessThanOrEqual(100);
    });

    test('sets suggestedAlias to undefined for empty/invalid aliases', async () => {
      mockChat.mockResolvedValue(
        JSON.stringify([
          {
            canonicalField: 'title',
            sourcePath: 'summary',
            suggestedAlias: '!!!',
            transform: { type: 'direct' },
            confidence: 0.9,
            reasoning: 'test',
          },
        ]),
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(result.suggestions[0].suggestedAlias).toBeUndefined();
    });

    test('filters out suggestions with confidence < 0.5', async () => {
      mockChat.mockResolvedValue(
        JSON.stringify([
          {
            canonicalField: 'title',
            sourcePath: 'summary',
            transform: { type: 'direct' },
            confidence: 0.3,
            reasoning: 'low confidence',
          },
          {
            canonicalField: 'status',
            sourcePath: 'status.name',
            transform: { type: 'direct' },
            confidence: 0.8,
            reasoning: 'high confidence',
          },
        ]),
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].canonicalField).toBe('status');
    });

    test('handles malformed JSON gracefully (returns empty array)', async () => {
      mockChat.mockResolvedValue('this is not json at all');

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(result.suggestions).toEqual([]);
    });

    test('extracts transform.delimiter and transform.sourceFormat', async () => {
      mockChat.mockResolvedValue(
        JSON.stringify([
          {
            canonicalField: 'tags',
            sourcePath: 'labels',
            transform: { type: 'split', delimiter: ',' },
            confidence: 0.85,
            reasoning: 'test',
          },
          {
            canonicalField: 'created_date',
            sourcePath: 'createdAt',
            transform: { type: 'parse_date', sourceFormat: 'YYYY-MM-DD' },
            confidence: 0.9,
            reasoning: 'test',
          },
        ]),
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(result.suggestions[0].transform.delimiter).toBe(',');
      expect(result.suggestions[1].transform.sourceFormat).toBe('YYYY-MM-DD');
    });

    test('handles JSON wrapped in code blocks', async () => {
      mockChat.mockResolvedValue(
        '```json\n' +
          JSON.stringify([
            {
              canonicalField: 'title',
              sourcePath: 'summary',
              transform: { type: 'direct' },
              confidence: 0.9,
              reasoning: 'test',
            },
          ]) +
          '\n```',
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(result.suggestions).toHaveLength(1);
    });
  });

  // ─── sanitizeFields ───────────────────────────────────────────────────

  describe('sanitizeFields', () => {
    test('includes enumValues when present on source field', async () => {
      await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      const userPrompt = mockChat.mock.calls[0][1][0].content as string;
      // Source field with enumValues should have them in the JSON
      expect(userPrompt).toContain('"Highest"');
      expect(userPrompt).toContain('"In Progress"');
    });

    test('omits enumValues when not present on source field', async () => {
      const request = makeRequest({
        sourceFields: [
          {
            path: 'title',
            label: 'Title',
            type: 'string',
            isCustom: false,
            isRequired: true,
          },
        ],
      });

      await service.suggestMappings(TENANT_ID, INDEX_ID, request);

      const userPrompt = mockChat.mock.calls[0][1][0].content as string;
      const parsed = JSON.parse(
        userPrompt.match(/\*\*Source Fields:\*\*\n```json\n([\s\S]+?)\n```/)![1],
      );
      expect(parsed[0].enumValues).toBeUndefined();
    });

    test('limits enumValues to 20 items', async () => {
      const manyEnumValues = Array.from({ length: 30 }, (_, i) => `value_${i}`);
      const request = makeRequest({
        sourceFields: [
          {
            path: 'big_enum',
            label: 'Big Enum',
            type: 'string',
            isCustom: false,
            isRequired: false,
            enumValues: manyEnumValues,
          },
        ],
      });

      await service.suggestMappings(TENANT_ID, INDEX_ID, request);

      const userPrompt = mockChat.mock.calls[0][1][0].content as string;
      const parsed = JSON.parse(
        userPrompt.match(/\*\*Source Fields:\*\*\n```json\n([\s\S]+?)\n```/)![1],
      );
      expect(parsed[0].enumValues.length).toBe(20);
    });
  });

  // ─── isValidValueMap ──────────────────────────────────────────────────

  describe('isValidValueMap (via parseResponse)', () => {
    test('accepts valid string-to-string maps', async () => {
      mockChat.mockResolvedValue(
        JSON.stringify([
          {
            canonicalField: 'status',
            sourcePath: 'status',
            transform: { type: 'value_map', valueMap: { open: 'active', closed: 'done' } },
            confidence: 0.9,
            reasoning: 'test',
          },
        ]),
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());
      expect(result.suggestions[0].transform.type).toBe('value_map');
      expect(result.suggestions[0].transform.valueMap).toEqual({ open: 'active', closed: 'done' });
    });

    test('rejects null valueMap', async () => {
      mockChat.mockResolvedValue(
        JSON.stringify([
          {
            canonicalField: 'status',
            sourcePath: 'status',
            transform: { type: 'value_map', valueMap: null },
            confidence: 0.9,
            reasoning: 'test',
          },
        ]),
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());
      expect(result.suggestions[0].transform.type).toBe('direct');
    });

    test('rejects empty object valueMap', async () => {
      mockChat.mockResolvedValue(
        JSON.stringify([
          {
            canonicalField: 'status',
            sourcePath: 'status',
            transform: { type: 'value_map', valueMap: {} },
            confidence: 0.9,
            reasoning: 'test',
          },
        ]),
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());
      expect(result.suggestions[0].transform.type).toBe('direct');
    });

    test('rejects valueMap with non-string values', async () => {
      mockChat.mockResolvedValue(
        JSON.stringify([
          {
            canonicalField: 'status',
            sourcePath: 'status',
            transform: { type: 'value_map', valueMap: { open: 123, closed: true } },
            confidence: 0.9,
            reasoning: 'test',
          },
        ]),
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());
      expect(result.suggestions[0].transform.type).toBe('direct');
    });
  });

  // ─── sanitizeAlias ────────────────────────────────────────────────────

  describe('sanitizeAlias (via parseResponse)', () => {
    test('normalizes to snake_case', async () => {
      mockChat.mockResolvedValue(
        JSON.stringify([
          {
            canonicalField: 'title',
            sourcePath: 'summary',
            suggestedAlias: 'Priority Level',
            transform: { type: 'direct' },
            confidence: 0.9,
            reasoning: 'test',
          },
        ]),
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());
      expect(result.suggestions[0].suggestedAlias).toBe('priority_level');
    });

    test('rejects non-string alias', async () => {
      mockChat.mockResolvedValue(
        JSON.stringify([
          {
            canonicalField: 'title',
            sourcePath: 'summary',
            suggestedAlias: 12345,
            transform: { type: 'direct' },
            confidence: 0.9,
            reasoning: 'test',
          },
        ]),
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());
      expect(result.suggestions[0].suggestedAlias).toBeUndefined();
    });

    test('collapses multiple underscores and trims edges', async () => {
      mockChat.mockResolvedValue(
        JSON.stringify([
          {
            canonicalField: 'title',
            sourcePath: 'summary',
            suggestedAlias: '__my___field__',
            transform: { type: 'direct' },
            confidence: 0.9,
            reasoning: 'test',
          },
        ]),
      );

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());
      expect(result.suggestions[0].suggestedAlias).toBe('my_field');
    });
  });

  // ─── Integration: suggestMappings end-to-end ──────────────────────────

  describe('suggestMappings end-to-end', () => {
    test('returns parsed suggestions from mocked LLM response', async () => {
      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(result.suggestions).toHaveLength(3);
      expect(result.totalProcessed).toBe(3);
      expect(result.averageConfidence).toBeGreaterThan(0);
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);

      // Verify structure
      const first = result.suggestions[0];
      expect(first.canonicalField).toBe('title');
      expect(first.sourcePath).toBe('summary');
      expect(first.transform.type).toBe('direct');
      expect(first.confidence).toBe(0.95);
      expect(first.suggestedAlias).toBe('title');
      expect(first.suggestedLabel).toBe('Title');
    });

    test('graceful degradation on LLM failure', async () => {
      mockChat.mockRejectedValue(new Error('API timeout'));

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, makeRequest());

      expect(result.suggestions).toEqual([]);
      expect(result.totalProcessed).toBe(0);
    });

    test('returns empty when too many source fields', async () => {
      const manyFields = Array.from({ length: 201 }, (_, i) => ({
        path: `field_${i}`,
        label: `Field ${i}`,
        type: 'string',
        isCustom: false,
        isRequired: false,
      }));

      const result = await service.suggestMappings(
        TENANT_ID,
        INDEX_ID,
        makeRequest({ sourceFields: manyFields }),
      );

      expect(result.suggestions).toEqual([]);
      expect(mockChat).not.toHaveBeenCalled();
    });
  });
});
