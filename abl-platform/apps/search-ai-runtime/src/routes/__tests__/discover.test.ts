import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

// ─── Mock Dependencies ───────────────────────────────────────────────────

const { mockSearchIndex, mockDomainVocabulary, mockCanonicalSchema } = vi.hoisted(() => ({
  mockSearchIndex: { findOne: vi.fn() },
  mockDomainVocabulary: { findOne: vi.fn() },
  mockCanonicalSchema: { findOne: vi.fn() },
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'SearchIndex') return mockSearchIndex;
    if (name === 'DomainVocabulary') return mockDomainVocabulary;
    if (name === 'CanonicalSchema') return mockCanonicalSchema;
    return {};
  },
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.tenantContext = { tenantId: 'tenant_123', userId: 'user_456' };
    next();
  },
}));

vi.mock('../../middleware/verify-index-ownership.js', () => ({
  verifyIndexOwnership: (_req: any, _res: any, next: any) => next(),
}));

const SearchIndex = mockSearchIndex;
const DomainVocabulary = mockDomainVocabulary;
const CanonicalSchema = mockCanonicalSchema;

const mockIndex = {
  _id: 'idx_123',
  tenantId: 'tenant_123',
  name: 'Product Documentation',
  description: 'Technical docs',
  documentCount: 1247,
  lastIndexedAt: new Date('2026-03-08'),
};

const mockVocabulary = {
  _id: 'vocab_1',
  tenantId: 'tenant_123',
  projectKnowledgeBaseId: 'idx_123',
  version: 3,
  status: 'active',
  entries: [
    {
      term: 'priority',
      aliases: ['pri', 'urgency'],
      fieldRef: 'issue_priority',
      capabilities: { canFilter: true, canDisplay: true, canAggregate: true, canSort: false },
      relatedFields: { displayWith: ['summary'], aggregateWith: ['status'] },
      enabled: true,
    },
    {
      term: 'status',
      aliases: [],
      fieldRef: 'issue_status',
      capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
      relatedFields: { displayWith: [], aggregateWith: [] },
      enabled: true,
    },
    {
      term: 'disabled_term',
      aliases: [],
      fieldRef: 'some_field',
      capabilities: { canFilter: true, canDisplay: false, canAggregate: false, canSort: false },
      relatedFields: { displayWith: [], aggregateWith: [] },
      enabled: false,
    },
  ],
};

const mockSchema = {
  _id: 'schema_1',
  tenantId: 'tenant_123',
  knowledgeBaseId: 'idx_123',
  fields: [
    {
      name: 'issue_priority',
      label: 'Priority',
      type: 'string',
      storageField: 'priority',
      filterable: true,
      aggregatable: true,
      sortable: false,
      indexed: true,
      enumValues: { P0: 'P0', P1: 'P1', P2: 'P2', P3: 'P3' },
    },
    {
      name: 'issue_status',
      label: 'Status',
      type: 'string',
      storageField: 'status',
      filterable: true,
      aggregatable: false,
      sortable: true,
      indexed: true,
      enumValues: { open: 'open', in_progress: 'in_progress', closed: 'closed' },
    },
    {
      name: 'content',
      label: 'Content',
      type: 'text',
      storageField: 'content_summary',
      filterable: false,
      aggregatable: false,
      sortable: false,
      indexed: true,
    },
  ],
};

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Discovery Route', () => {
  let app: Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const { createDiscoverRouter } = await import('../discover.js');
    app = express();
    app.use(express.json());
    app.use(createDiscoverRouter());
  });

  it('returns full manifest when all data is available', async () => {
    vi.mocked(SearchIndex.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockIndex),
    } as any);
    vi.mocked(DomainVocabulary.findOne).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(mockVocabulary) }),
    } as any);
    vi.mocked(CanonicalSchema.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockSchema),
    } as any);

    const response = await request(app).get('/idx_123/discover').expect(200);

    expect(response.body.kb.name).toBe('Product Documentation');
    expect(response.body.kb.documentCount).toBe(1247);

    // Vocabulary available with 2 enabled terms (disabled one filtered)
    expect(response.body.capabilities.vocabulary.available).toBe(true);
    expect(response.body.capabilities.vocabulary.terms).toHaveLength(2);
    expect(response.body.capabilities.vocabulary.terms[0].term).toBe('priority');

    // Filters available (2 filterable fields)
    expect(response.body.capabilities.filters.available).toBe(true);
    expect(response.body.capabilities.filters.fields).toHaveLength(2);

    // Classification available
    expect(response.body.capabilities.queryClassification.available).toBe(true);
    expect(response.body.capabilities.queryClassification.examples.length).toBeGreaterThan(0);

    // Search endpoint documented
    expect(response.body.searchEndpoint.url).toBe('/api/search/idx_123/query');
    expect(response.body.searchEndpoint.method).toBe('POST');

    // Meta included
    expect(response.body._meta.version).toBe('v3');
    expect(response.body._meta.ttlSeconds).toBe(300);
  });

  it('returns empty capabilities for fresh KB (no vocabulary, no schema)', async () => {
    vi.mocked(SearchIndex.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'idx_new',
        tenantId: 'tenant_123',
        name: 'New KB',
        documentCount: 0,
      }),
    } as any);
    vi.mocked(DomainVocabulary.findOne).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
    } as any);
    vi.mocked(CanonicalSchema.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    } as any);

    const response = await request(app).get('/idx_new/discover').expect(200);

    expect(response.body.kb.name).toBe('New KB');
    expect(response.body.kb.documentCount).toBe(0);
    expect(response.body.capabilities.vocabulary.available).toBe(false);
    expect(response.body.capabilities.vocabulary.terms).toHaveLength(0);
    expect(response.body.capabilities.filters.available).toBe(false);
    expect(response.body.capabilities.filters.fields).toHaveLength(0);
    expect(response.body.capabilities.aggregation.available).toBe(false);

    // Reranking and preprocessing are always available
    expect(response.body.capabilities.reranking.available).toBe(true);
    expect(response.body.capabilities.preprocessing.available).toBe(true);
  });

  it('returns 404 when index not found', async () => {
    vi.mocked(SearchIndex.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    } as any);
    vi.mocked(DomainVocabulary.findOne).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
    } as any);
    vi.mocked(CanonicalSchema.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    } as any);

    const response = await request(app).get('/idx_missing/discover').expect(404);
    expect(response.body.error).toBe('Index not found');
  });

  it('includes skipWhen guidance for each capability', async () => {
    vi.mocked(SearchIndex.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockIndex),
    } as any);
    vi.mocked(DomainVocabulary.findOne).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(mockVocabulary) }),
    } as any);
    vi.mocked(CanonicalSchema.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockSchema),
    } as any);

    const response = await request(app).get('/idx_123/discover').expect(200);

    expect(response.body.capabilities.queryClassification.skipWhen).toBeDefined();
    expect(response.body.capabilities.vocabulary.skipWhen).toBeDefined();
    expect(response.body.capabilities.filters.skipWhen).toBeDefined();
    expect(response.body.capabilities.reranking.skipWhen).toBeDefined();
    expect(response.body.capabilities.preprocessing.skipWhen).toBeDefined();
  });

  it('sets cache headers', async () => {
    vi.mocked(SearchIndex.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockIndex),
    } as any);
    vi.mocked(DomainVocabulary.findOne).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(mockVocabulary) }),
    } as any);
    vi.mocked(CanonicalSchema.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockSchema),
    } as any);

    const response = await request(app).get('/idx_123/discover').expect(200);
    expect(response.headers['cache-control']).toBe('public, max-age=300');
  });

  it('vocabulary terms include field values from schema', async () => {
    vi.mocked(SearchIndex.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockIndex),
    } as any);
    vi.mocked(DomainVocabulary.findOne).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(mockVocabulary) }),
    } as any);
    vi.mocked(CanonicalSchema.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockSchema),
    } as any);

    const response = await request(app).get('/idx_123/discover').expect(200);

    const priorityTerm = response.body.capabilities.vocabulary.terms.find(
      (t: any) => t.term === 'priority',
    );
    expect(priorityTerm.values).toEqual(['P0', 'P1', 'P2', 'P3']);
    expect(priorityTerm.canFilter).toBe(true);
    expect(priorityTerm.canAggregate).toBe(true);
    expect(priorityTerm.aliases).toEqual(['pri', 'urgency']);
  });
});
