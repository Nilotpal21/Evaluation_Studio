import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions so they are available inside vi.mock factories
const { mockSearchIndexFindOne, mockCanonicalSchemaFindOne, mockGetAppIndices } = vi.hoisted(
  () => ({
    mockSearchIndexFindOne: vi.fn(),
    mockCanonicalSchemaFindOne: vi.fn(),
    mockGetAppIndices: vi.fn().mockResolvedValue(['search-vectors-v1']),
  }),
);

vi.mock('../../../db/index.js', () => ({
  getLazyModel: vi.fn((name: string) => {
    if (name === 'SearchIndex') {
      return { findOne: mockSearchIndexFindOne };
    }
    if (name === 'CanonicalSchema') {
      return { findOne: mockCanonicalSchemaFindOne };
    }
    return { findOne: vi.fn() };
  }),
}));

vi.mock('@agent-platform/search-ai-internal', () => ({
  createVectorStore: vi.fn(),
  getAppIndices: (...args: unknown[]) => mockGetAppIndices(...args),
}));

// Import after mocks are set up
import { DocumentContentSampler } from '../document-content-sampler.js';

// Mock logger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeSchemaFields(
  overrides: Array<{
    storageField?: string;
    name?: string;
    label?: string;
    type?: string;
    enumValues?: Record<string, unknown>;
  }> = [],
) {
  return overrides.map((o) => ({
    storageField: o.storageField ?? 'status',
    name: o.name ?? 'ticket_status',
    label: o.label ?? 'Ticket Status',
    type: o.type ?? 'string',
    indexed: true,
    filterable: true,
    aggregatable: true,
    sortable: false,
    enumValues: o.enumValues ?? { open: 'open', closed: 'closed' },
  }));
}

function setupMocks(opts: {
  searchIndex?: Record<string, unknown> | null;
  schema?: { fields: ReturnType<typeof makeSchemaFields>; [k: string]: unknown } | null;
}) {
  // SearchIndex.findOne returns a lean-compatible result
  mockSearchIndexFindOne.mockReturnValue({
    lean: vi
      .fn()
      .mockResolvedValue(
        opts.searchIndex !== undefined ? opts.searchIndex : { _id: 'kb-1', tenantId: 'tenant-1' },
      ),
  });

  // CanonicalSchema.findOne returns a chain: sort -> lean
  const leanResult = opts.schema !== undefined ? opts.schema : null;
  mockCanonicalSchemaFindOne.mockReturnValue({
    sort: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(leanResult),
    }),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('DocumentContentSampler', () => {
  let sampler: DocumentContentSampler;
  let mockVectorStore: { executeQuery: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockVectorStore = {
      executeQuery: vi.fn().mockResolvedValue({
        hits: [],
        aggregations: {},
        total: 0,
      }),
    };

    sampler = new DocumentContentSampler(mockVectorStore as any);
    mockGetAppIndices.mockResolvedValue(['search-vectors-v1']);
  });

  // ── Test 1: Returns candidates for valid enum fields ───────────────────

  it('returns candidates for valid enum fields', async () => {
    setupMocks({
      searchIndex: { _id: 'kb-1', tenantId: 'tenant-1' },
      schema: {
        fields: makeSchemaFields([
          {
            storageField: 'status',
            name: 'ticket_status',
            label: 'Ticket Status',
            type: 'string',
            enumValues: { open: 'open', closed: 'closed', pending: 'pending' },
          },
        ]),
      },
    });

    mockVectorStore.executeQuery.mockResolvedValue({
      hits: [],
      total: 1000,
      aggregations: {
        enum_status: {
          buckets: [
            { key: 'open', doc_count: 400 },
            { key: 'closed', doc_count: 350 },
            { key: 'pending', doc_count: 250 },
          ],
        },
      },
    });

    const result = await sampler.sampleEnumValues('kb-1', 'tenant-1');

    expect(result.sampledDocCount).toBe(1000);
    expect(result.indexName).toBe('search-vectors-v1');
    expect(result.candidates).toHaveLength(1);

    const candidate = result.candidates[0];
    expect(candidate.storageField).toBe('status');
    expect(candidate.alias).toBe('ticket_status');
    expect(candidate.label).toBe('Ticket Status');
    expect(candidate.cardinality).toBe(3);
    expect(candidate.values).toHaveLength(3);
    expect(candidate.values[0].value).toBe('open');
    expect(candidate.values[0].count).toBe(400);
    expect(candidate.values[0].frequency).toBeCloseTo(0.4);
    expect(candidate.confidence).toBeGreaterThan(0);
    expect(candidate.confidence).toBeLessThanOrEqual(1);
  });

  // ── Test 2: Excludes fields with cardinality > 50 ─────────────────────

  it('excludes fields with cardinality >= maxCardinality', async () => {
    setupMocks({
      searchIndex: { _id: 'kb-1', tenantId: 'tenant-1' },
      schema: {
        fields: makeSchemaFields([
          {
            storageField: 'category',
            name: 'category',
            label: 'Category',
            type: 'string',
            enumValues: { a: 'a' },
          },
        ]),
      },
    });

    // Return 50 buckets — equals maxCardinality so it should be excluded
    const buckets = Array.from({ length: 50 }, (_, i) => ({
      key: `val_${i}`,
      doc_count: 100,
    }));

    mockVectorStore.executeQuery.mockResolvedValue({
      hits: [],
      total: 5000,
      aggregations: {
        enum_category: { buckets },
      },
    });

    const result = await sampler.sampleEnumValues('kb-1', 'tenant-1');
    expect(result.candidates).toHaveLength(0);
  });

  // ── Test 3: Excludes values below 0.1% frequency ─────────────────────

  it('excludes values below minimum frequency threshold', async () => {
    setupMocks({
      searchIndex: { _id: 'kb-1', tenantId: 'tenant-1' },
      schema: {
        fields: makeSchemaFields([
          {
            storageField: 'status',
            name: 'status',
            label: 'Status',
            type: 'string',
            enumValues: { open: 'open' },
          },
        ]),
      },
    });

    mockVectorStore.executeQuery.mockResolvedValue({
      hits: [],
      total: 10000,
      aggregations: {
        enum_status: {
          buckets: [
            { key: 'open', doc_count: 5000 },
            { key: 'rare_value', doc_count: 1 }, // 0.01% — below 0.1% threshold
          ],
        },
      },
    });

    const result = await sampler.sampleEnumValues('kb-1', 'tenant-1');
    expect(result.candidates).toHaveLength(1);
    // The rare_value should be filtered out (1 < floor(10000 * 0.001) = 10)
    const values = result.candidates[0].values;
    expect(values).toHaveLength(1);
    expect(values[0].value).toBe('open');
  });

  // ── Test 4: Returns empty when no active schema exists ────────────────

  it('returns empty candidates when no schema exists', async () => {
    setupMocks({
      searchIndex: { _id: 'kb-1', tenantId: 'tenant-1' },
      schema: null,
    });

    const result = await sampler.sampleEnumValues('kb-1', 'tenant-1');
    expect(result.candidates).toEqual([]);
    expect(result.sampledDocCount).toBe(0);
  });

  // ── Test 5: Returns empty when no keyword fields in schema ─────────────

  it('returns empty when no keyword fields in schema', async () => {
    setupMocks({
      searchIndex: { _id: 'kb-1', tenantId: 'tenant-1' },
      schema: {
        fields: makeSchemaFields([
          {
            storageField: 'description',
            name: 'description',
            label: 'Description',
            type: 'text', // Not a keyword field — cannot do terms aggregation
            enumValues: {},
          },
          {
            storageField: 'score',
            name: 'score',
            label: 'Score',
            type: 'float', // Not a keyword field
            enumValues: {},
          },
        ]),
      },
    });

    const result = await sampler.sampleEnumValues('kb-1', 'tenant-1');
    expect(result.candidates).toEqual([]);
    expect(mockVectorStore.executeQuery).not.toHaveBeenCalled();
  });

  // ── Test 6: Tenant isolation — returns empty for wrong tenant ─────────

  it('returns empty for wrong tenant (tenant isolation)', async () => {
    setupMocks({
      searchIndex: null, // SearchIndex.findOne returns null for wrong tenant
    });

    const result = await sampler.sampleEnumValues('kb-1', 'wrong-tenant');
    expect(result.candidates).toEqual([]);
    expect(result.sampledDocCount).toBe(0);
    expect(result.indexName).toBe('');
  });

  // ── Test 7: Confidence calculation — uniform distribution ─────────────

  it('calculates high confidence for uniform distribution', async () => {
    setupMocks({
      searchIndex: { _id: 'kb-1', tenantId: 'tenant-1' },
      schema: {
        fields: makeSchemaFields([
          {
            storageField: 'status',
            name: 'status',
            label: 'Status',
            type: 'string',
            enumValues: { a: 'a', b: 'b', c: 'c' },
          },
        ]),
      },
    });

    // Perfectly uniform: 3 values, each with 333 docs out of 1000
    mockVectorStore.executeQuery.mockResolvedValue({
      hits: [],
      total: 1000,
      aggregations: {
        enum_status: {
          buckets: [
            { key: 'a', doc_count: 333 },
            { key: 'b', doc_count: 333 },
            { key: 'c', doc_count: 334 },
          ],
        },
      },
    });

    const result = await sampler.sampleEnumValues('kb-1', 'tenant-1');
    expect(result.candidates).toHaveLength(1);
    // Uniform distribution should yield high confidence (close to 1.0)
    expect(result.candidates[0].confidence).toBeGreaterThanOrEqual(0.7);
  });

  // ── Test 8: Confidence calculation — single-dominant value ────────────

  it('calculates lower confidence for single-dominant value', async () => {
    setupMocks({
      searchIndex: { _id: 'kb-1', tenantId: 'tenant-1' },
      schema: {
        fields: makeSchemaFields([
          {
            storageField: 'status',
            name: 'status',
            label: 'Status',
            type: 'string',
            enumValues: { dominant: 'dominant', rare: 'rare' },
          },
        ]),
      },
    });

    // Heavily skewed: one value has 990 out of 1000
    mockVectorStore.executeQuery.mockResolvedValue({
      hits: [],
      total: 1000,
      aggregations: {
        enum_status: {
          buckets: [
            { key: 'dominant', doc_count: 990 },
            { key: 'rare', doc_count: 10 },
          ],
        },
      },
    });

    const result = await sampler.sampleEnumValues('kb-1', 'tenant-1');
    expect(result.candidates).toHaveLength(1);
    // Skewed distribution should yield lower confidence
    expect(result.candidates[0].confidence).toBeLessThan(0.7);
  });

  // ── Test 9: Handles OpenSearch query failure gracefully ───────────────

  it('handles OpenSearch query failure gracefully', async () => {
    setupMocks({
      searchIndex: { _id: 'kb-1', tenantId: 'tenant-1' },
      schema: {
        fields: makeSchemaFields([
          {
            storageField: 'status',
            name: 'status',
            label: 'Status',
            type: 'string',
            enumValues: { a: 'a' },
          },
        ]),
      },
    });

    mockVectorStore.executeQuery.mockRejectedValue(new Error('Connection refused'));

    const result = await sampler.sampleEnumValues('kb-1', 'tenant-1');
    expect(result.candidates).toEqual([]);
    expect(result.sampledDocCount).toBe(0);
    expect(result.indexName).toBe('search-vectors-v1');
  });

  // ── Test 10: Excludes non-keyword field types ─────────────────────────

  it('excludes non-keyword field types from aggregation', async () => {
    setupMocks({
      searchIndex: { _id: 'kb-1', tenantId: 'tenant-1' },
      schema: {
        fields: makeSchemaFields([
          {
            storageField: 'priority',
            name: 'priority',
            label: 'Priority',
            type: 'float', // Not a keyword field — should be excluded
            enumValues: { high: 0.8, low: 0.2 },
          },
          {
            storageField: 'created_at',
            name: 'created',
            label: 'Created',
            type: 'date', // Not a keyword field
            enumValues: { recent: 'recent' },
          },
          {
            storageField: 'is_active',
            name: 'active',
            label: 'Active',
            type: 'boolean', // Not a keyword field
            enumValues: { yes: true },
          },
        ]),
      },
    });

    const result = await sampler.sampleEnumValues('kb-1', 'tenant-1');
    // All fields excluded because none are keyword-typed
    expect(result.candidates).toEqual([]);
    // executeQuery should not be called because no enum fields pass the filter
    expect(mockVectorStore.executeQuery).not.toHaveBeenCalled();
  });
});
