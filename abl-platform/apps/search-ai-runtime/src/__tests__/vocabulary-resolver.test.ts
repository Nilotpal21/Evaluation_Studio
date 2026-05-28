/**
 * Vocabulary Resolver Unit Tests
 *
 * Tests for VocabularyResolver using the fieldRef + capabilities schema:
 * - Term matching (exact, alias, fuzzy modes)
 * - Alias resolution
 * - Aggregation spec extraction from canAggregate entries
 * - Filter extraction from canFilter entries (field: fieldRef, value: term)
 * - Multiple entry resolution (replaces composite)
 * - Database error handling
 * - Edge cases (empty queries, no vocabulary, disabled entries)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// MOCKS — must be declared before imports of modules that use them
// =============================================================================

// Use vi.hoisted() to ensure mocks are available during module evaluation
const { mockDomainVocabularyFindOne } = vi.hoisted(() => ({
  mockDomainVocabularyFindOne: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'DomainVocabulary') return { findOne: mockDomainVocabularyFindOne };
    return {};
  },
}));

// Mock ioredis to prevent real Redis connections in tests
vi.mock('ioredis', () => {
  const MockRedis = vi.fn().mockImplementation(() => ({
    subscribe: vi.fn((_channel: string, cb: (err: Error | null) => void) => cb(null)),
    on: vi.fn(),
    publish: vi.fn().mockResolvedValue(1),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  }));
  return { default: MockRedis };
});

// Mock createLogger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// =============================================================================
// IMPORTS
// =============================================================================

import { VocabularyResolver } from '../services/vocabulary/vocabulary-resolver.js';

// =============================================================================
// HELPERS
// =============================================================================

function mockVocabulary(entries: any[]) {
  mockDomainVocabularyFindOne.mockReturnValue({
    sort: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        entries,
      }),
    }),
  });
}

function mockEmptyVocabulary() {
  mockDomainVocabularyFindOne.mockReturnValue({
    sort: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    }),
  });
}

function mockDbError() {
  mockDomainVocabularyFindOne.mockReturnValue({
    sort: vi.fn().mockReturnValue({
      lean: vi.fn().mockRejectedValue(new Error('DB connection refused')),
    }),
  });
}

const TENANT_ID = 'tenant-1';

const DEVOPS_ENTRY = {
  term: 'devops tools',
  aliases: ['infrastructure', 'CI/CD'],
  description: 'DevOps and infrastructure tools',
  fieldRef: 'category',
  capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
  relatedFields: { displayWith: [], aggregateWith: [] },
  enabled: true,
};

const PRICE_ENTRY = {
  term: 'total price',
  aliases: ['revenue', 'total cost'],
  description: 'Sum of all prices',
  fieldRef: 'price',
  capabilities: { canFilter: false, canDisplay: true, canAggregate: true, canSort: false },
  relatedFields: { displayWith: [], aggregateWith: [] },
  enabled: true,
};

const ADVANCED_ENTRY = {
  term: 'advanced content',
  aliases: ['expert level'],
  description: 'Advanced difficulty content',
  fieldRef: 'difficulty',
  capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
  relatedFields: { displayWith: [], aggregateWith: [] },
  enabled: true,
};

const FIELD_ENTRY = {
  term: 'category name',
  aliases: ['cat name'],
  description: 'Category field',
  fieldRef: 'category',
  capabilities: { canFilter: false, canDisplay: true, canAggregate: false, canSort: false },
  relatedFields: { displayWith: [], aggregateWith: [] },
  enabled: true,
};

const DISABLED_ENTRY = {
  term: 'disabled term',
  aliases: ['also disabled'],
  description: 'This is disabled',
  fieldRef: 'status',
  capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
  relatedFields: { displayWith: [], aggregateWith: [] },
  enabled: false,
};

const PREMIUM_PRODUCTS_ENTRY = {
  term: 'premium products',
  aliases: ['expensive items'],
  description: 'Products in the premium tier',
  fieldRef: 'tier',
  capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
  relatedFields: { displayWith: [], aggregateWith: [] },
  enabled: true,
};

const PRODUCT_PRICE_ENTRY = {
  term: 'average price',
  aliases: ['price average'],
  description: 'Average product price',
  fieldRef: 'price',
  capabilities: { canFilter: false, canDisplay: true, canAggregate: true, canSort: false },
  relatedFields: { displayWith: [], aggregateWith: [] },
  enabled: true,
};

// =============================================================================
// TESTS
// =============================================================================

describe('VocabularyResolver', () => {
  let resolver: VocabularyResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new VocabularyResolver();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Constructor ──────────────────────────────────────────────────────────

  describe('constructor', () => {
    test('creates resolver instance', () => {
      expect(resolver).toBeDefined();
    });
  });

  // ─── Exact Matching ───────────────────────────────────────────────────────

  describe('exact matching', () => {
    test('matches exact primary term in query', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      const result = await resolver.resolve('kb-1', 'show me devops tools', TENANT_ID, 'exact');

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.resolvedTerms[0].inputTerm).toBe('devops tools');
      expect(result.resolvedTerms[0].matchedTerm).toBe('devops tools');
      expect(result.resolvedTerms[0].matchType).toBe('exact');
      expect(result.resolvedTerms[0].confidence).toBe(1.0);
    });

    test('exact mode does not match aliases', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      const result = await resolver.resolve('kb-1', 'show me infrastructure', TENANT_ID, 'exact');

      // In exact mode, aliases ARE matched because the code checks aliases in 'alias' and 'fuzzy' modes only
      // Wait - looking at the code, 'exact' mode only matches the primary term, not aliases
      // The findMatch method: alias match is gated behind mode === 'alias' || mode === 'fuzzy'
      expect(result.resolvedTerms).toHaveLength(0);
      expect(result.unresolvedSegments).toContain('show');
    });

    test('exact match is case-insensitive', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      const result = await resolver.resolve('kb-1', 'show me DEVOPS TOOLS', TENANT_ID, 'exact');

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.resolvedTerms[0].matchedTerm).toBe('devops tools');
    });

    test('generates correct structured filters from exact match', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      const result = await resolver.resolve('kb-1', 'devops tools guide', TENANT_ID, 'exact');

      expect(result.structuredFilters).toHaveLength(1);
      expect(result.structuredFilters[0]).toEqual({
        field: 'category',
        operator: 'eq',
        value: 'devops tools',
      });
    });

    test('removes matched term from remaining query', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      const result = await resolver.resolve(
        'kb-1',
        'show me devops tools please',
        TENANT_ID,
        'exact',
      );

      expect(result.unresolvedSegments).toContain('show');
      expect(result.unresolvedSegments).toContain('please');
      expect(result.unresolvedSegments).not.toContain('devops');
      expect(result.unresolvedSegments).not.toContain('tools');
      // Note: 'me' is filtered out as it's too short (< 3 chars)
    });
  });

  // ─── Alias Matching ───────────────────────────────────────────────────────

  describe('alias matching', () => {
    test('matches alias in query', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      const result = await resolver.resolve('kb-1', 'infrastructure guide', TENANT_ID, 'alias');

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.resolvedTerms[0].inputTerm).toBe('infrastructure');
      expect(result.resolvedTerms[0].matchedTerm).toBe('devops tools');
      expect(result.resolvedTerms[0].matchType).toBe('alias');
      expect(result.resolvedTerms[0].confidence).toBe(0.9);
    });

    test('prefers exact match over alias match', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      const result = await resolver.resolve('kb-1', 'devops tools guide', TENANT_ID, 'alias');

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.resolvedTerms[0].matchType).toBe('exact');
      expect(result.resolvedTerms[0].confidence).toBe(1.0);
    });

    test('matches case-insensitive alias', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      const result = await resolver.resolve('kb-1', 'INFRASTRUCTURE docs', TENANT_ID, 'alias');

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.resolvedTerms[0].matchType).toBe('alias');
    });

    test('default mode is alias', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      // Not passing mode should default to 'alias'
      const result = await resolver.resolve('kb-1', 'infrastructure docs', TENANT_ID);

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.resolvedTerms[0].matchType).toBe('alias');
    });

    test('matches CI/CD alias', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      const result = await resolver.resolve('kb-1', 'CI/CD pipelines', TENANT_ID, 'alias');

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.resolvedTerms[0].inputTerm).toBe('CI/CD');
      expect(result.resolvedTerms[0].matchedTerm).toBe('devops tools');
    });
  });

  // ─── Fuzzy Matching ───────────────────────────────────────────────────────

  describe('fuzzy matching', () => {
    test('matches word substring in fuzzy mode', async () => {
      mockVocabulary([
        {
          term: 'kubernetes deployment',
          aliases: [],
          description: 'K8s deploys',
          fieldRef: 'tech',
          capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
          relatedFields: { displayWith: [], aggregateWith: [] },
          enabled: true,
        },
      ]);

      // "kubernetes" is 10 chars (>= 4), so fuzzy word match should fire
      const result = await resolver.resolve('kb-1', 'kubernetes guide', TENANT_ID, 'fuzzy');

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.resolvedTerms[0].matchType).toBe('fuzzy');
      expect(result.resolvedTerms[0].confidence).toBe(0.6);
    });

    test('fuzzy mode also matches exact and alias', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      // Exact match should take priority
      const result = await resolver.resolve('kb-1', 'devops tools guide', TENANT_ID, 'fuzzy');

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.resolvedTerms[0].matchType).toBe('exact');
    });

    test('fuzzy mode matches aliases', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      const result = await resolver.resolve('kb-1', 'infrastructure guide', TENANT_ID, 'fuzzy');

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.resolvedTerms[0].matchType).toBe('alias');
    });

    test('fuzzy ignores words shorter than 4 characters', async () => {
      mockVocabulary([
        {
          term: 'foo bar',
          aliases: [],
          description: 'Short words',
          fieldRef: 'x',
          capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
          relatedFields: { displayWith: [], aggregateWith: [] },
          enabled: true,
        },
      ]);

      const result = await resolver.resolve('kb-1', 'foo something', TENANT_ID, 'fuzzy');

      // "foo" is 3 chars, so no fuzzy match
      expect(result.resolvedTerms).toHaveLength(0);
    });

    test('fuzzy matches word with exactly 4 characters', async () => {
      mockVocabulary([
        {
          term: 'data pipeline',
          aliases: [],
          description: 'Data processing',
          fieldRef: 'type',
          capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
          relatedFields: { displayWith: [], aggregateWith: [] },
          enabled: true,
        },
      ]);

      // "data" is exactly 4 chars
      const result = await resolver.resolve('kb-1', 'data analysis', TENANT_ID, 'fuzzy');

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.resolvedTerms[0].matchType).toBe('fuzzy');
    });
  });

  // ─── Aggregate Resolution ─────────────────────────────────────────────────

  describe('aggregate resolution', () => {
    test('extracts aggregation spec from aggregate-capable entry', async () => {
      mockVocabulary([PRICE_ENTRY]);

      const result = await resolver.resolve('kb-1', 'total price', TENANT_ID, 'exact');

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.resolvedTerms[0].fieldRef).toBe('price');
      expect(result.resolvedTerms[0].capabilities.canAggregate).toBe(true);
      expect(result.aggregationSpec).toBeDefined();
      expect(result.aggregationSpec?.measure).toBe('price');
      expect(result.aggregationSpec?.function).toBe('count');
    });

    test('alias resolves to aggregation spec', async () => {
      mockVocabulary([PRICE_ENTRY]);

      const result = await resolver.resolve('kb-1', 'revenue breakdown', TENANT_ID, 'alias');

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.resolvedTerms[0].matchedTerm).toBe('total price');
      expect(result.resolvedTerms[0].fieldRef).toBe('price');
      expect(result.aggregationSpec).toBeDefined();
      expect(result.aggregationSpec?.measure).toBe('price');
    });

    test('aggregate resolution produces no structured filters', async () => {
      mockVocabulary([PRICE_ENTRY]);

      const result = await resolver.resolve('kb-1', 'total price', TENANT_ID, 'exact');

      expect(result.structuredFilters).toHaveLength(0);
    });
  });

  // ─── Field Resolution ─────────────────────────────────────────────────────

  describe('field resolution', () => {
    test('field resolution produces no filters or aggregation', async () => {
      mockVocabulary([FIELD_ENTRY]);

      const result = await resolver.resolve('kb-1', 'category name lookup', TENANT_ID, 'exact');

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.structuredFilters).toHaveLength(0);
      expect(result.aggregationSpec).toBeUndefined();
    });
  });

  // ─── Multiple Entry Resolution (replaces composite) ──────────────────────

  describe('multiple entry resolution (filter + aggregate)', () => {
    test('extracts filters and aggregation from separate entries', async () => {
      mockVocabulary([PREMIUM_PRODUCTS_ENTRY, PRODUCT_PRICE_ENTRY]);

      const result = await resolver.resolve(
        'kb-1',
        'premium products average price overview',
        TENANT_ID,
        'exact',
      );

      expect(result.resolvedTerms).toHaveLength(2);
      expect(result.structuredFilters).toHaveLength(1);
      expect(result.structuredFilters[0]).toEqual({
        field: 'tier',
        operator: 'eq',
        value: 'premium products',
      });
      expect(result.aggregationSpec).toBeDefined();
      expect(result.aggregationSpec?.measure).toBe('price');
      expect(result.aggregationSpec?.function).toBe('count');
    });

    test('alias on filter entry resolves correctly alongside aggregate entry', async () => {
      mockVocabulary([PREMIUM_PRODUCTS_ENTRY, PRODUCT_PRICE_ENTRY]);

      const result = await resolver.resolve(
        'kb-1',
        'expensive items average price report',
        TENANT_ID,
        'alias',
      );

      expect(result.resolvedTerms).toHaveLength(2);
      expect(result.resolvedTerms[0].matchType).toBe('alias');
      expect(result.structuredFilters).toHaveLength(1);
      expect(result.aggregationSpec).toBeDefined();
    });
  });

  // ─── Multiple Terms ───────────────────────────────────────────────────────

  describe('multiple terms', () => {
    test('resolves multiple terms in same query', async () => {
      mockVocabulary([DEVOPS_ENTRY, ADVANCED_ENTRY]);

      const result = await resolver.resolve(
        'kb-1',
        'devops tools with advanced content',
        TENANT_ID,
        'exact',
      );

      expect(result.resolvedTerms).toHaveLength(2);
      expect(result.structuredFilters).toHaveLength(2);
      expect(result.structuredFilters).toContainEqual({
        field: 'category',
        operator: 'eq',
        value: 'devops tools',
      });
      expect(result.structuredFilters).toContainEqual({
        field: 'difficulty',
        operator: 'eq',
        value: 'advanced content',
      });
    });

    test('unresolved segments are what remains after all matches', async () => {
      mockVocabulary([DEVOPS_ENTRY, ADVANCED_ENTRY]);

      const result = await resolver.resolve(
        'kb-1',
        'show me devops tools with advanced content',
        TENANT_ID,
        'exact',
      );

      expect(result.unresolvedSegments).toContain('show');
      expect(result.unresolvedSegments).toContain('with');
      // Note: 'me' is filtered out as it's too short (< 3 chars)
    });

    test('resolves mix of filter and aggregate terms', async () => {
      mockVocabulary([DEVOPS_ENTRY, PRICE_ENTRY]);

      const result = await resolver.resolve('kb-1', 'devops tools total price', TENANT_ID, 'exact');

      expect(result.resolvedTerms).toHaveLength(2);
      expect(result.structuredFilters).toHaveLength(1);
      expect(result.aggregationSpec).toBeDefined();
    });
  });

  // ─── Disabled Entries ─────────────────────────────────────────────────────

  describe('disabled entries', () => {
    test('skips disabled vocabulary entries', async () => {
      mockVocabulary([DISABLED_ENTRY]);

      const result = await resolver.resolve('kb-1', 'disabled term', TENANT_ID, 'exact');

      expect(result.resolvedTerms).toHaveLength(0);
      expect(result.unresolvedSegments).toContain('disabled');
      expect(result.unresolvedSegments).toContain('term');
    });

    test('matches enabled entries but skips disabled ones', async () => {
      mockVocabulary([DEVOPS_ENTRY, DISABLED_ENTRY]);

      const result = await resolver.resolve(
        'kb-1',
        'devops tools disabled term',
        TENANT_ID,
        'exact',
      );

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.resolvedTerms[0].matchedTerm).toBe('devops tools');
    });
  });

  // ─── Empty / Missing Data ─────────────────────────────────────────────────

  describe('empty / missing data', () => {
    test('returns unresolved query when no vocabulary exists', async () => {
      mockEmptyVocabulary();

      const result = await resolver.resolve('kb-1', 'test query', TENANT_ID);

      expect(result.resolvedTerms).toHaveLength(0);
      expect(result.unresolvedSegments).toEqual(['test', 'query']);
      expect(result.structuredFilters).toHaveLength(0);
    });

    test('returns unresolved query when vocabulary has no entries', async () => {
      mockDomainVocabularyFindOne.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ entries: [] }),
        }),
      });

      const result = await resolver.resolve('kb-1', 'test query', TENANT_ID);

      expect(result.resolvedTerms).toHaveLength(0);
      expect(result.unresolvedSegments).toEqual(['test', 'query']);
    });

    test('returns unresolved query when vocabulary entries field is missing', async () => {
      mockDomainVocabularyFindOne.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({}),
        }),
      });

      const result = await resolver.resolve('kb-1', 'test query', TENANT_ID);

      expect(result.resolvedTerms).toHaveLength(0);
      expect(result.unresolvedSegments).toEqual(['test', 'query']);
    });

    test('handles empty query string', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      const result = await resolver.resolve('kb-1', '', TENANT_ID, 'exact');

      expect(result.resolvedTerms).toHaveLength(0);
      expect(result.unresolvedSegments).toHaveLength(0);
    });

    test('handles whitespace-only query', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      const result = await resolver.resolve('kb-1', '   ', TENANT_ID, 'exact');

      expect(result.resolvedTerms).toHaveLength(0);
      expect(result.unresolvedSegments).toHaveLength(0);
    });

    test('handles missing aliases in vocabulary entry', async () => {
      mockVocabulary([
        {
          term: 'test term',
          // aliases missing
          description: 'A test',
          fieldRef: 'x',
          capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
          relatedFields: { displayWith: [], aggregateWith: [] },
          enabled: true,
        },
      ]);

      // The loadVocabulary method defaults aliases to []
      const result = await resolver.resolve('kb-1', 'test term', TENANT_ID, 'alias');
      expect(result.resolvedTerms).toHaveLength(1);
    });

    test('handles missing enabled flag in vocabulary entry (defaults to true)', async () => {
      mockVocabulary([
        {
          term: 'test term',
          aliases: [],
          description: 'A test',
          fieldRef: 'x',
          capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
          relatedFields: { displayWith: [], aggregateWith: [] },
          // enabled missing — loadVocabulary defaults to true
        },
      ]);

      const result = await resolver.resolve('kb-1', 'test term', TENANT_ID, 'exact');
      expect(result.resolvedTerms).toHaveLength(1);
    });
  });

  // ─── Database Errors ──────────────────────────────────────────────────────

  describe('database errors', () => {
    test('returns empty result when database is unavailable', async () => {
      mockDbError();

      const result = await resolver.resolve('kb-1', 'devops tools', TENANT_ID);

      expect(result.resolvedTerms).toHaveLength(0);
      expect(result.unresolvedSegments).toEqual(['devops', 'tools']);
      expect(result.structuredFilters).toHaveLength(0);
    });

    test('does not throw when database connection fails', async () => {
      mockDbError();

      await expect(resolver.resolve('kb-1', 'test', TENANT_ID)).resolves.toBeDefined();
    });
  });

  // ─── Query Parameters ─────────────────────────────────────────────────────

  describe('query parameters', () => {
    test('queries correct projectKnowledgeBaseId', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      await resolver.resolve('kb-special-123', 'devops tools', TENANT_ID);

      expect(mockDomainVocabularyFindOne).toHaveBeenCalledWith({
        projectKnowledgeBaseId: 'kb-special-123',
        tenantId: TENANT_ID,
        status: 'active',
      });
    });

    test('sorts by version descending to get latest', async () => {
      const sortFn = vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });
      mockDomainVocabularyFindOne.mockReturnValue({ sort: sortFn });

      await resolver.resolve('kb-1', 'test', TENANT_ID);

      expect(sortFn).toHaveBeenCalledWith({ version: -1 });
    });
  });

  // ─── No Match Scenarios ───────────────────────────────────────────────────

  describe('no match scenarios', () => {
    test('returns full query as unresolved when no terms match', async () => {
      mockVocabulary([DEVOPS_ENTRY, PRICE_ENTRY]);

      const result = await resolver.resolve(
        'kb-1',
        'completely unrelated query',
        TENANT_ID,
        'exact',
      );

      expect(result.resolvedTerms).toHaveLength(0);
      expect(result.unresolvedSegments).toContain('completely');
      expect(result.unresolvedSegments).toContain('unrelated');
      expect(result.unresolvedSegments).toContain('query');
      expect(result.structuredFilters).toHaveLength(0);
    });

    test('partial query resolution leaves unmatched parts as unresolved', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      const result = await resolver.resolve(
        'kb-1',
        'find devops tools with good reviews',
        TENANT_ID,
        'exact',
      );

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.unresolvedSegments).toContain('find');
      expect(result.unresolvedSegments).toContain('with');
      expect(result.unresolvedSegments).toContain('good');
      expect(result.unresolvedSegments).toContain('reviews');
    });
  });

  // ─── Resolution Extraction ────────────────────────────────────────────────

  describe('resolution extraction', () => {
    test('filter-capable entry extracts single filter from fieldRef', async () => {
      const filterEntry = {
        term: 'active premium',
        aliases: [],
        description: 'Active premium items',
        fieldRef: 'status',
        capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
        relatedFields: { displayWith: [], aggregateWith: [] },
        enabled: true,
      };
      mockVocabulary([filterEntry]);

      const result = await resolver.resolve('kb-1', 'active premium items', TENANT_ID, 'exact');

      expect(result.structuredFilters).toHaveLength(1);
      expect(result.structuredFilters[0].field).toBe('status');
      expect(result.structuredFilters[0].value).toBe('active premium');
    });

    test('multiple separate filter entries produce multiple filters', async () => {
      const statusEntry = {
        term: 'active',
        aliases: [],
        description: 'Active status',
        fieldRef: 'status',
        capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
        relatedFields: { displayWith: [], aggregateWith: [] },
        enabled: true,
      };
      const tierEntry = {
        term: 'premium',
        aliases: [],
        description: 'Premium tier',
        fieldRef: 'tier',
        capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
        relatedFields: { displayWith: [], aggregateWith: [] },
        enabled: true,
      };
      const countEntry = {
        term: 'total count',
        aliases: [],
        description: 'Total count metric',
        fieldRef: 'count',
        capabilities: { canFilter: false, canDisplay: true, canAggregate: true, canSort: false },
        relatedFields: { displayWith: [], aggregateWith: [] },
        enabled: true,
      };
      mockVocabulary([statusEntry, tierEntry, countEntry]);

      const result = await resolver.resolve(
        'kb-1',
        'active premium total count report',
        TENANT_ID,
        'exact',
      );

      expect(result.structuredFilters).toHaveLength(2);
      expect(result.structuredFilters).toContainEqual({
        field: 'status',
        operator: 'eq',
        value: 'active',
      });
      expect(result.structuredFilters).toContainEqual({
        field: 'tier',
        operator: 'eq',
        value: 'premium',
      });
      expect(result.aggregationSpec).toBeDefined();
      expect(result.aggregationSpec?.measure).toBe('count');
    });

    test('field resolution returns empty filters', async () => {
      mockVocabulary([FIELD_ENTRY]);

      const result = await resolver.resolve('kb-1', 'category name', TENANT_ID, 'exact');

      expect(result.structuredFilters).toHaveLength(0);
    });

    test('entry without fieldRef returns empty filters', async () => {
      const noFieldRefEntry = {
        term: 'unknown type',
        aliases: [],
        description: 'Entry with no fieldRef',
        // fieldRef missing
        capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
        relatedFields: { displayWith: [], aggregateWith: [] },
        enabled: true,
      };
      mockVocabulary([noFieldRefEntry]);

      const result = await resolver.resolve('kb-1', 'unknown type', TENANT_ID, 'exact');

      expect(result.resolvedTerms).toHaveLength(1);
      expect(result.structuredFilters).toHaveLength(0);
    });
  });

  // ─── Aggregation Spec Merging ─────────────────────────────────────────────

  describe('aggregation spec merging', () => {
    test('multiple aggregate-capable entries merge specs', async () => {
      const entry1 = {
        term: 'price sum',
        aliases: [],
        fieldRef: 'price',
        capabilities: { canFilter: false, canDisplay: true, canAggregate: true, canSort: false },
        relatedFields: { displayWith: [], aggregateWith: [] },
        enabled: true,
      };
      const entry2 = {
        term: 'order count',
        aliases: [],
        fieldRef: 'orders',
        capabilities: { canFilter: false, canDisplay: true, canAggregate: true, canSort: false },
        relatedFields: { displayWith: [], aggregateWith: [] },
        enabled: true,
      };
      mockVocabulary([entry1, entry2]);

      const result = await resolver.resolve(
        'kb-1',
        'price sum order count report',
        TENANT_ID,
        'exact',
      );

      expect(result.resolvedTerms).toHaveLength(2);
      expect(result.aggregationSpec).toBeDefined();
      // Second entry's aggregation overwrites via spread merge
      expect(result.aggregationSpec?.measure).toBe('orders');
      expect(result.aggregationSpec?.function).toBe('count');
    });
  });

  // ─── Intent Preservation (RFC-003 Critical Test Cases) ───────────────────
  //
  // These tests verify that the original query is ALWAYS preserved for
  // semantic search, even when vocabulary terms are matched.
  // This addresses the critical bug where vocabulary resolution destroyed
  // query intent by stripping matched terms.

  describe('RFC-003: Intent Preservation - Critical Test Cases', () => {
    /**
     * Test 1: Vocabulary matches preserved in original query
     * Addresses: Preserve original query for semantic search
     */
    test('preserves original query with vocabulary matches', async () => {
      const PREMIUM_CUSTOMERS = {
        term: 'premium customers',
        aliases: [],
        description: 'Premium tier customers',
        fieldRef: 'tier',
        capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
        relatedFields: { displayWith: [], aggregateWith: [] },
        enabled: true,
      };

      const SF_ENTRY = {
        term: 'SF',
        aliases: ['San Francisco'],
        description: 'San Francisco location',
        fieldRef: 'city',
        capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
        relatedFields: { displayWith: [], aggregateWith: [] },
        enabled: true,
      };

      mockVocabulary([PREMIUM_CUSTOMERS, SF_ENTRY]);

      const result = await resolver.resolve(
        'kb-1',
        'Show me premium customers in SF with revenue > 100K',
        TENANT_ID,
      );

      // CRITICAL: Original query preserved
      expect(result.originalQuery).toBe('Show me premium customers in SF with revenue > 100K');

      // Filters extracted (value is the entry term in new schema)
      expect(result.structuredFilters).toHaveLength(2);
      expect(result.structuredFilters).toContainEqual({
        field: 'tier',
        operator: 'eq',
        value: 'premium customers',
      });
      expect(result.structuredFilters).toContainEqual({
        field: 'city',
        operator: 'eq',
        value: 'SF',
      });

      // Resolved terms tracked (for debugging)
      expect(result.resolvedTerms).toHaveLength(2);
      expect(result.resolvedTerms[0].inputTerm).toBe('premium customers');
      expect(result.resolvedTerms[0].fieldRef).toBe('tier');
      expect(result.resolvedTerms[0].capabilities.canFilter).toBe(true);
      expect(result.resolvedTerms[1].inputTerm).toBe('SF');
      expect(result.resolvedTerms[1].fieldRef).toBe('city');
    });

    /**
     * Test 2: Semantic queries preserve intent for embedding
     * User feedback: "Add test case for preserving original query for semantic"
     */
    test('semantic query with vocabulary - preserves for embedding', async () => {
      const Q1_ENTRY = {
        term: 'Q1 2024',
        aliases: [],
        description: 'First quarter 2024',
        fieldRef: 'quarter',
        capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
        relatedFields: { displayWith: [], aggregateWith: [] },
        enabled: true,
      };

      mockVocabulary([Q1_ENTRY]);

      const query = 'Explain the revenue trends for Q1 2024';
      const result = await resolver.resolve('kb-1', query, TENANT_ID);

      // Full query preserved for semantic understanding
      expect(result.originalQuery).toBe(query);

      // Time filter extracted (value is the entry term in new schema)
      expect(result.structuredFilters).toContainEqual({
        field: 'quarter',
        operator: 'eq',
        value: 'Q1 2024',
      });

      // Verify original query contains all semantic terms
      expect(result.originalQuery).toContain('Explain');
      expect(result.originalQuery).toContain('revenue');
      expect(result.originalQuery).toContain('trends');
      expect(result.originalQuery).toContain('Q1 2024');
    });

    /**
     * Test 3: Question queries benefit from vocabulary
     * Question queries should be hybrid, not semantic-only
     */
    test('question query combines semantic + vocabulary filters', async () => {
      const ACTIVE_USERS = {
        term: 'active users',
        aliases: [],
        description: 'Users with active status',
        fieldRef: 'status',
        capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
        relatedFields: { displayWith: [], aggregateWith: [] },
        enabled: true,
      };

      mockVocabulary([ACTIVE_USERS]);

      const query = 'What are the characteristics of active users?';
      const result = await resolver.resolve('kb-1', query, TENANT_ID);

      // Full question preserved
      expect(result.originalQuery).toBe(query);

      // Status filter added (value is the entry term in new schema)
      expect(result.structuredFilters).toContainEqual({
        field: 'status',
        operator: 'eq',
        value: 'active users',
      });

      // Original query contains question words + vocabulary term
      expect(result.originalQuery).toContain('What');
      expect(result.originalQuery).toContain('active users');
    });

    /**
     * Test 4: No vocabulary matches - still preserve original
     */
    test('no vocabulary matches - original query unchanged', async () => {
      mockVocabulary([]); // Empty vocabulary

      const query = 'How does machine learning work?';
      const result = await resolver.resolve('kb-1', query, TENANT_ID);

      // ✅ No modifications
      expect(result.originalQuery).toBe(query);
      expect(result.structuredFilters).toHaveLength(0);
      expect(result.resolvedTerms).toHaveLength(0);
    });

    /**
     * Test 5: Complex query with multiple vocabulary terms
     * Ensure ALL terms preserved in original query
     */
    test('multiple vocabulary terms - all preserved in original', async () => {
      const PREMIUM = {
        term: 'premium',
        aliases: [],
        description: 'Premium tier',
        fieldRef: 'tier',
        capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
        relatedFields: { displayWith: [], aggregateWith: [] },
        enabled: true,
      };

      const ACTIVE = {
        term: 'active',
        aliases: [],
        description: 'Active status',
        fieldRef: 'status',
        capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
        relatedFields: { displayWith: [], aggregateWith: [] },
        enabled: true,
      };

      const SAN_FRANCISCO = {
        term: 'San Francisco',
        aliases: ['SF'],
        description: 'San Francisco location',
        fieldRef: 'city',
        capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
        relatedFields: { displayWith: [], aggregateWith: [] },
        enabled: true,
      };

      mockVocabulary([PREMIUM, ACTIVE, SAN_FRANCISCO]);

      const query = 'Find premium active customers in San Francisco from last month';
      const result = await resolver.resolve('kb-1', query, TENANT_ID);

      // Original completely preserved
      expect(result.originalQuery).toBe(query);

      // All 3 filters extracted
      expect(result.structuredFilters).toHaveLength(3);

      // Embedding represents FULL query
      const queryWords = result.originalQuery.split(' ');
      expect(queryWords).toContain('premium');
      expect(queryWords).toContain('active');
      expect(queryWords).toContain('San');
      expect(queryWords).toContain('Francisco');
      expect(queryWords).toContain('from');
      expect(queryWords).toContain('last');
      expect(queryWords).toContain('month');
    });

    /**
     * Test 6: originalQuery field is always present
     * Even for empty queries or errors
     */
    test('originalQuery field always present', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      // Empty query
      const result1 = await resolver.resolve('kb-1', '', TENANT_ID);
      expect(result1.originalQuery).toBe('');

      // Whitespace only
      const result2 = await resolver.resolve('kb-1', '   ', TENANT_ID);
      expect(result2.originalQuery).toBe('   ');

      // Normal query
      const result3 = await resolver.resolve('kb-1', 'test query', TENANT_ID);
      expect(result3.originalQuery).toBe('test query');
    });

    /**
     * Test 7: unresolvedSegments is for debugging only
     * Doesn't affect the originalQuery that gets embedded
     */
    test('unresolvedSegments separate from originalQuery', async () => {
      mockVocabulary([DEVOPS_ENTRY]);

      const result = await resolver.resolve('kb-1', 'show me devops tools please', TENANT_ID);

      // ✅ Original preserved
      expect(result.originalQuery).toBe('show me devops tools please');

      // ✅ Unresolved segments tracked separately (for observability)
      expect(result.unresolvedSegments).toContain('show');
      expect(result.unresolvedSegments).toContain('please');

      // ✅ But originalQuery is not modified
      expect(result.originalQuery).toContain('show');
      expect(result.originalQuery).toContain('me');
      expect(result.originalQuery).toContain('devops');
      expect(result.originalQuery).toContain('tools');
      expect(result.originalQuery).toContain('please');
    });
  });
});
