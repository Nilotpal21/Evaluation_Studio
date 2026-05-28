import { describe, it, expect } from 'vitest';
import { buildToolDescription, classifyKBComplexity } from '../description-builder.js';

const fullManifest = {
  kb: {
    name: 'Product Documentation',
    description: 'Technical docs for the product suite',
    documentCount: 1247,
    lastUpdated: new Date().toISOString(),
  },
  searchEndpoint: {
    url: '/api/search/idx_123/query',
    method: 'POST',
    description: 'Unified search endpoint.',
  },
  capabilities: {
    queryClassification: {
      available: true,
      description: 'Classify query type before searching.',
      types: {
        structured: 'Field filters only',
        semantic: 'Conceptual search',
        hybrid: 'Filters + concepts',
        aggregation: 'Counts and statistics',
      },
      examples: [
        { query: 'show open bugs', type: 'structured', reasoning: 'field filter' },
        { query: 'how does auth work', type: 'semantic', reasoning: 'concept' },
      ],
      skipWhen: 'You already know the intent.',
    },
    vocabulary: {
      available: true,
      version: 3,
      description: 'Map business terms to fields.',
      terms: [
        {
          term: 'priority',
          aliases: ['pri', 'urgency'],
          field: 'issue_priority',
          values: ['P0', 'P1', 'P2'],
          canFilter: true,
          canAggregate: true,
          usage:
            'Map "high priority" to filter { field: "issue_priority", operator: "in", value: ["P0","P1"] }',
        },
        {
          term: 'status',
          aliases: [],
          field: 'issue_status',
          values: ['open', 'closed'],
          canFilter: true,
          canAggregate: false,
          usage:
            'Map "open" to filter { field: "issue_status", operator: "equals", value: "open" }',
        },
      ],
      skipWhen: 'Query is purely conceptual.',
    },
    filters: {
      available: true,
      description: 'Add metadata filters.',
      fields: [
        { name: 'issue_priority', type: 'string', values: ['P0', 'P1', 'P2', 'P3'] },
        { name: 'issue_status', type: 'string', values: ['open', 'closed'] },
      ],
      operators: ['equals', 'in', 'contains'],
      skipWhen: 'No filtering intent.',
    },
    aggregation: {
      available: true,
      description: 'Count, sum, avg operations.',
      functions: ['count', 'sum', 'avg', 'min', 'max'],
      skipWhen: 'User wants documents.',
    },
    reranking: {
      available: true,
      description: 'Set rerank: true for better relevance.',
      skipWhen: 'Structured or aggregation queries.',
    },
    preprocessing: {
      available: true,
      description: 'Typo correction and synonym expansion.',
      skipWhen: 'You already rephrased the query.',
    },
  },
  permissions: {
    description: 'Pass auth token for user-scoped results.',
    authHeader: 'Authorization: Bearer <token>',
  },
};

describe('buildToolDescription', () => {
  it('includes KB identity and dynamic content for rich manifest', () => {
    const desc = buildToolDescription(fullManifest);

    // KB header
    expect(desc).toContain('Product Documentation');
    expect(desc).toContain('1,247 documents');
    expect(desc).toContain('Technical docs');

    // Vocabulary (dynamic per-KB content — stays in description)
    expect(desc).toContain('VOCABULARY (2 terms)');
    expect(desc).toContain('"priority"');
    expect(desc).toContain('(aliases: pri, urgency)');
    expect(desc).toContain('[P0, P1, P2]');

    // Filters (dynamic per-KB content — stays in description)
    expect(desc).toContain('FILTERS (2 fields)');
    expect(desc).toContain('issue_priority');
    expect(desc).toContain('Operators: equals, in, contains');

    // Rules
    expect(desc).toContain('RULES:');
  });

  it('does NOT include static parameter guidance in description', () => {
    const desc = buildToolDescription(fullManifest);

    // These now live in input_schema param descriptions, not the main body
    expect(desc).not.toContain('QUERY CLASSIFICATION');
    expect(desc).not.toContain('AGGREGATION');
    expect(desc).not.toContain('RERANKING');
    expect(desc).not.toContain('PREPROCESSING');
    expect(desc).not.toContain('PERMISSIONS');
    expect(desc).not.toContain('SEARCH CONTRACT');
    expect(desc).not.toContain('Skip when');
  });

  it('omits unavailable sections for empty KB', () => {
    const emptyManifest = {
      kb: { name: 'New KB', documentCount: 0 },
      capabilities: {
        queryClassification: { available: false, description: 'Not configured.' },
        vocabulary: { available: false, description: 'No vocabulary yet.', terms: [] },
        filters: { available: false, description: 'No fields yet.', fields: [] },
        aggregation: { available: false },
        reranking: { available: true, description: 'Available.' },
        preprocessing: { available: true, description: 'Available.' },
      },
    };

    const desc = buildToolDescription(emptyManifest);

    expect(desc).toContain('New KB');
    expect(desc).toContain('no documents yet');
    // Unavailable sections completely omitted
    expect(desc).not.toContain('VOCABULARY');
    expect(desc).not.toContain('FILTERS');
    // Static capability sections omitted (moved to param descriptions)
    expect(desc).not.toContain('RERANKING');
    expect(desc).not.toContain('PREPROCESSING');
    // Rules always present
    expect(desc).toContain('RULES:');
  });

  it('produces under 500 tokens for basic KB', () => {
    const basicManifest = {
      kb: { name: 'Basic KB', description: 'A simple knowledge base.', documentCount: 10 },
      capabilities: {
        vocabulary: { available: false, terms: [] },
        filters: { available: false, fields: [] },
      },
    };

    const desc = buildToolDescription(basicManifest);

    // Rough token estimate: ~1 token per 4 chars for English text
    const estimatedTokens = Math.ceil(desc.length / 4);
    expect(estimatedTokens).toBeLessThan(500);
    // Should be very lean — just header + rules
    expect(desc.split('\n').length).toBeLessThan(10);
  });

  it('truncates vocabulary terms beyond limit', () => {
    const manyTerms = Array.from({ length: 50 }, (_, i) => ({
      term: `term_${i}`,
      aliases: [],
      field: `field_${i}`,
      values: [],
      canFilter: true,
      canAggregate: false,
    }));

    const manifest = {
      kb: { name: 'Big KB', documentCount: 100 },
      capabilities: {
        vocabulary: {
          available: true,
          description: 'Many terms.',
          terms: manyTerms,
        },
      },
    };

    const desc = buildToolDescription(manifest);

    // Should include first 30 terms
    expect(desc).toContain('term_0');
    expect(desc).toContain('term_29');
    // Should not include term 30+
    expect(desc).not.toContain('"term_30"');
    // Should show truncation message
    expect(desc).toContain('20 more terms');
  });

  it('handles missing capabilities gracefully', () => {
    const minimal = {
      kb: { name: 'Minimal' },
      capabilities: {},
    };

    const desc = buildToolDescription(minimal);
    expect(desc).toContain('Minimal');
    expect(desc).toContain('RULES:');
    expect(desc).toBeDefined();
  });

  it('uses simple tier for empty KB — minimal prompt, no carry-forward rule', () => {
    const emptyManifest = {
      kb: { name: 'Empty' },
      capabilities: {},
    };

    const desc = buildToolDescription(emptyManifest);
    expect(desc).toContain('RULES:');
    // Simple tier intentionally omits carry-forward to save tokens
    expect(desc).toContain('hybrid');
    expect(desc).toContain('Prefer ONE search call');
  });

  it('uses filtered tier — includes carry-forward for KBs with filters', () => {
    const filteredManifest = {
      kb: { name: 'Filtered KB', documentCount: 50 },
      capabilities: {
        vocabulary: {
          available: true,
          terms: [
            {
              term: 'status',
              aliases: [],
              field: 'status',
              values: ['open', 'closed'],
              canFilter: true,
              canAggregate: false,
            },
            {
              term: 'category',
              aliases: [],
              field: 'category',
              values: ['bug', 'feature'],
              canFilter: true,
              canAggregate: false,
            },
          ],
        },
        filters: {
          available: true,
          fields: [
            { name: 'status', type: 'string', values: ['open', 'closed'] },
            { name: 'category', type: 'string', values: ['bug', 'feature'] },
          ],
          operators: ['equals', 'in'],
        },
      },
    };

    const desc = buildToolDescription(filteredManifest);
    expect(desc).toContain('carry forward relevant context');
    expect(desc).toContain('VOCABULARY');
    expect(desc).toContain('FILTERS');
  });
});

describe('classifyKBComplexity', () => {
  it('classifies empty KB as simple', () => {
    const result = classifyKBComplexity({ capabilities: {} });
    expect(result.tier).toBe('simple');
    expect(result.hasFilters).toBe(false);
    expect(result.hasAggregation).toBe(false);
  });

  it('classifies KB with ≤2 vocab, no filters as simple', () => {
    const result = classifyKBComplexity({
      capabilities: {
        vocabulary: {
          terms: [
            { term: 'document type', field: 'mime_type' },
            { term: 'source type', field: 'source_type' },
          ],
        },
        filters: { fields: [] },
      },
    });
    expect(result.tier).toBe('simple');
  });

  it('classifies KB with filters but no aggregation as filtered', () => {
    const result = classifyKBComplexity({
      capabilities: {
        vocabulary: {
          terms: [
            { term: 'status', field: 'status' },
            { term: 'type', field: 'type' },
          ],
        },
        filters: { fields: [{ name: 'status' }, { name: 'type' }] },
        aggregation: { available: false },
      },
    });
    expect(result.tier).toBe('filtered');
    expect(result.hasFilters).toBe(true);
  });

  it('classifies KB with aggregation as advanced', () => {
    const result = classifyKBComplexity({
      capabilities: {
        vocabulary: {
          terms: [
            { term: 'status', field: 'status' },
            { term: 'type', field: 'type' },
          ],
        },
        filters: { fields: [{ name: 'status' }] },
        aggregation: { available: true },
      },
    });
    expect(result.tier).toBe('advanced');
    expect(result.hasAggregation).toBe(true);
  });

  it('returns hybrid as default queryType for all tiers', () => {
    expect(classifyKBComplexity({ capabilities: {} }).defaultQueryType).toBe('hybrid');
    expect(
      classifyKBComplexity({
        capabilities: { filters: { fields: [{ name: 'x' }] } },
      }).defaultQueryType,
    ).toBe('hybrid');
  });
});
