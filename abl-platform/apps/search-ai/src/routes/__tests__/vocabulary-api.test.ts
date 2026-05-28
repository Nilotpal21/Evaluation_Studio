/**
 * Vocabulary API Tests (Story 4.6)
 *
 * Tests for:
 * - GET /:indexId/vocabulary/:fieldRef — Get terms for a specific field
 * - POST /:indexId/vocabulary/review — Bulk approve/reject terms
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────────

const {
  mockSearchIndexFindOne,
  mockDomainVocabularyFindOne,
  mockCanonicalSchemaFindOne,
  mockAuditVocabularyUpdated,
} = vi.hoisted(() => ({
  mockSearchIndexFindOne: vi.fn(),
  mockDomainVocabularyFindOne: vi.fn(),
  mockCanonicalSchemaFindOne: vi.fn(),
  mockAuditVocabularyUpdated: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    switch (modelName) {
      case 'SearchIndex':
        return {
          findOne: mockSearchIndexFindOne,
        };
      case 'DomainVocabulary':
        return {
          findOne: mockDomainVocabularyFindOne,
          create: vi.fn(),
        };
      case 'CanonicalSchema':
        return {
          findOne: mockCanonicalSchemaFindOne,
        };
      default:
        return {};
    }
  }),
}));

vi.mock('../../services/audit-helpers.js', () => ({
  auditVocabularyUpdated: mockAuditVocabularyUpdated,
}));

vi.mock('../../workers/shared.js', () => ({
  getSharedRedisClient: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  getRedisConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  workerLog: vi.fn(),
  workerError: vi.fn(),
}));

vi.mock('ioredis', () => {
  const mockPublish = vi.fn().mockResolvedValue(1);
  return {
    default: vi.fn().mockImplementation(() => ({
      publish: mockPublish,
      on: vi.fn().mockReturnThis(),
      quit: vi.fn().mockResolvedValue('OK'),
      disconnect: vi.fn(),
      status: 'ready',
    })),
  };
});

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/database/models', () => ({}));

// Import after mocks
import vocabularyRouter from '../vocabulary.js';

// ─── Test App Setup ─────────────────────────────────────────────────────────

function createApp(tenantId = 'tenant-test') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantContext = { tenantId } as any;
    (req as any).userId = 'user-123';
    next();
  });
  app.use('/indexes', vocabularyRouter);
  // Error handler prevents "socket hang up" when route throws unexpectedly
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  });
  return app;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-test';
const INDEX_ID = 'idx-001';

const fakeIndex = {
  _id: INDEX_ID,
  tenantId: TENANT_ID,
  name: 'Test Index',
};

const fakeCanonicalSchema = {
  _id: 'schema-001',
  tenantId: TENANT_ID,
  knowledgeBaseId: INDEX_ID,
  version: 1,
  status: 'active',
  fields: [
    {
      name: 'issue_priority',
      label: 'Priority',
      type: 'string',
      storageField: 'priority',
      indexed: true,
      filterable: true,
      aggregatable: false,
      sortable: true,
    },
    {
      name: 'issue_status',
      label: 'Status',
      type: 'string',
      storageField: 'status',
      indexed: true,
      filterable: true,
      aggregatable: false,
      sortable: false,
    },
  ],
};

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry_001',
    term: 'high',
    aliases: ['critical', 'urgent'],
    description: 'High priority',
    fieldRef: 'issue_priority',
    capabilities: { canFilter: true, canDisplay: true, canAggregate: false, canSort: false },
    relatedFields: { displayWith: [], aggregateWith: [] },
    enabled: true,
    confidence: 0.9,
    generatedBy: 'auto',
    usageCount: 10,
    lastUsed: new Date('2026-01-01'),
    createdAt: new Date('2025-12-01'),
    updatedAt: new Date('2025-12-15'),
    ...overrides,
  };
}

const fakeEntries = [
  makeEntry({ id: 'entry_001', term: 'high', confidence: 0.9, usageCount: 10 }),
  makeEntry({
    id: 'entry_002',
    term: 'low',
    confidence: 0.7,
    usageCount: 5,
    fieldRef: 'issue_priority',
  }),
  makeEntry({
    id: 'entry_003',
    term: 'medium',
    confidence: 0.9,
    usageCount: 3,
    fieldRef: 'issue_priority',
  }),
  makeEntry({
    id: 'entry_004',
    term: 'open',
    confidence: 0.85,
    usageCount: 20,
    fieldRef: 'issue_status',
  }),
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockChainedFindOne(result: any) {
  return vi.fn().mockReturnValue({
    lean: vi.fn().mockResolvedValue(result),
  });
}

function mockChainedCanonicalSchemaFindOne(result: any) {
  return vi.fn().mockReturnValue({
    sort: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(result),
    }),
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /:indexId/vocabulary/:fieldRef', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  test('returns filtered entries sorted by confidence desc, then usageCount desc', async () => {
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeIndex),
    });
    mockCanonicalSchemaFindOne.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
      }),
    });
    mockDomainVocabularyFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'vocab-001',
        tenantId: TENANT_ID,
        projectKnowledgeBaseId: INDEX_ID,
        entries: fakeEntries,
      }),
    });

    const res = await request(app).get(`/indexes/${INDEX_ID}/vocabulary/issue_priority`);

    expect(res.status).toBe(200);
    expect(res.body.fieldRef).toBe('issue_priority');
    expect(res.body.total).toBe(3);
    expect(res.body.entries).toHaveLength(3);

    // Confidence 0.9 entries first (high, medium), then 0.7 (low)
    // Among confidence=0.9: high (usageCount=10) before medium (usageCount=3)
    expect(res.body.entries[0].term).toBe('high');
    expect(res.body.entries[1].term).toBe('medium');
    expect(res.body.entries[2].term).toBe('low');
  });

  test('returns empty entries array when fieldRef has no vocabulary terms', async () => {
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeIndex),
    });
    mockCanonicalSchemaFindOne.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
      }),
    });
    mockDomainVocabularyFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'vocab-001',
        tenantId: TENANT_ID,
        projectKnowledgeBaseId: INDEX_ID,
        entries: [], // no entries
      }),
    });

    const res = await request(app).get(`/indexes/${INDEX_ID}/vocabulary/issue_priority`);

    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.fieldRef).toBe('issue_priority');
  });

  test('returns empty entries when vocab document does not exist', async () => {
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeIndex),
    });
    mockCanonicalSchemaFindOne.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
      }),
    });
    mockDomainVocabularyFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const res = await request(app).get(`/indexes/${INDEX_ID}/vocabulary/issue_priority`);

    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  test('returns 404 when SearchIndex not found', async () => {
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const res = await request(app).get(`/indexes/${INDEX_ID}/vocabulary/issue_priority`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('returns 404 when fieldRef does not exist in CanonicalSchema', async () => {
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeIndex),
    });
    mockCanonicalSchemaFindOne.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
      }),
    });

    const res = await request(app).get(`/indexes/${INDEX_ID}/vocabulary/nonexistent_field`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FIELD_NOT_FOUND');
  });

  test('returns 404 when no CanonicalSchema exists', async () => {
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeIndex),
    });
    mockCanonicalSchemaFindOne.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
    });

    const res = await request(app).get(`/indexes/${INDEX_ID}/vocabulary/issue_priority`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FIELD_NOT_FOUND');
  });

  test('response shape includes { entries, total, fieldRef }', async () => {
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeIndex),
    });
    mockCanonicalSchemaFindOne.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
      }),
    });
    mockDomainVocabularyFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'vocab-001',
        tenantId: TENANT_ID,
        projectKnowledgeBaseId: INDEX_ID,
        entries: [fakeEntries[0]],
      }),
    });

    const res = await request(app).get(`/indexes/${INDEX_ID}/vocabulary/issue_priority`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('entries');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('fieldRef');

    // Verify entry shape
    const entry = res.body.entries[0];
    expect(entry).toHaveProperty('id');
    expect(entry).toHaveProperty('term');
    expect(entry).toHaveProperty('aliases');
    expect(entry).toHaveProperty('fieldRef');
    expect(entry).toHaveProperty('capabilities');
    expect(entry).toHaveProperty('enabled');
    expect(entry).toHaveProperty('confidence');
    expect(entry).toHaveProperty('generatedBy');
    expect(entry).toHaveProperty('usageCount');
  });

  test('tenant isolation: returns 404 for different tenant', async () => {
    const otherApp = createApp('other-tenant');
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null), // not found for other tenant
    });

    const res = await request(otherApp).get(`/indexes/${INDEX_ID}/vocabulary/issue_priority`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /:indexId/vocabulary/review', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  test('approves terms: sets enabled=true on matched entries', async () => {
    const entriesCopy = [
      makeEntry({ id: 'entry_001', enabled: false }),
      makeEntry({ id: 'entry_002', enabled: false }),
    ];
    const mockSave = vi.fn().mockResolvedValue(undefined);

    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeIndex),
    });
    mockDomainVocabularyFindOne.mockResolvedValue({
      _id: 'vocab-001',
      tenantId: TENANT_ID,
      projectKnowledgeBaseId: INDEX_ID,
      version: 1,
      entries: entriesCopy,
      save: mockSave,
    });

    const res = await request(app)
      .post(`/indexes/${INDEX_ID}/vocabulary/review`)
      .send({ action: 'approve', termIds: ['entry_001', 'entry_002'] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.action).toBe('approve');
    expect(res.body.updatedCount).toBe(2);
    expect(res.body.updatedIds).toEqual(['entry_001', 'entry_002']);
    expect(res.body.notFoundIds).toBeUndefined();

    // Verify entries were toggled
    expect(entriesCopy[0].enabled).toBe(true);
    expect(entriesCopy[1].enabled).toBe(true);
    expect(mockSave).toHaveBeenCalledOnce();
    expect(mockAuditVocabularyUpdated).toHaveBeenCalledOnce();
  });

  test('rejects terms: sets enabled=false on matched entries', async () => {
    const entriesCopy = [
      makeEntry({ id: 'entry_001', enabled: true }),
      makeEntry({ id: 'entry_002', enabled: true }),
    ];
    const mockSave = vi.fn().mockResolvedValue(undefined);

    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeIndex),
    });
    mockDomainVocabularyFindOne.mockResolvedValue({
      _id: 'vocab-001',
      tenantId: TENANT_ID,
      projectKnowledgeBaseId: INDEX_ID,
      version: 1,
      entries: entriesCopy,
      save: mockSave,
    });

    const res = await request(app)
      .post(`/indexes/${INDEX_ID}/vocabulary/review`)
      .send({ action: 'reject', termIds: ['entry_001', 'entry_002'] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.action).toBe('reject');
    expect(res.body.updatedCount).toBe(2);
    expect(entriesCopy[0].enabled).toBe(false);
    expect(entriesCopy[1].enabled).toBe(false);
  });

  test('returns 400 when action is invalid', async () => {
    const res = await request(app)
      .post(`/indexes/${INDEX_ID}/vocabulary/review`)
      .send({ action: 'invalid', termIds: ['entry_001'] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ACTION');
  });

  test('returns 400 when action is missing', async () => {
    const res = await request(app)
      .post(`/indexes/${INDEX_ID}/vocabulary/review`)
      .send({ termIds: ['entry_001'] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ACTION');
  });

  test('returns 400 when termIds is empty', async () => {
    const res = await request(app)
      .post(`/indexes/${INDEX_ID}/vocabulary/review`)
      .send({ action: 'approve', termIds: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TERM_IDS');
  });

  test('returns 400 when termIds is missing', async () => {
    const res = await request(app)
      .post(`/indexes/${INDEX_ID}/vocabulary/review`)
      .send({ action: 'approve' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TERM_IDS');
  });

  test('returns 400 when termIds exceeds 500', async () => {
    const tooManyIds = Array.from({ length: 501 }, (_, i) => `entry_${i}`);
    const res = await request(app)
      .post(`/indexes/${INDEX_ID}/vocabulary/review`)
      .send({ action: 'approve', termIds: tooManyIds });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOO_MANY_TERMS');
  });

  test('returns 404 when SearchIndex not found', async () => {
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const res = await request(app)
      .post(`/indexes/${INDEX_ID}/vocabulary/review`)
      .send({ action: 'approve', termIds: ['entry_001'] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('returns 404 when vocabulary document not found', async () => {
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeIndex),
    });
    mockDomainVocabularyFindOne.mockResolvedValue(null);

    const res = await request(app)
      .post(`/indexes/${INDEX_ID}/vocabulary/review`)
      .send({ action: 'approve', termIds: ['entry_001'] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Vocabulary not found');
  });

  test('returns 404 when no matching term IDs found', async () => {
    const entriesCopy = [makeEntry({ id: 'entry_001' })];
    const mockSave = vi.fn().mockResolvedValue(undefined);

    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeIndex),
    });
    mockDomainVocabularyFindOne.mockResolvedValue({
      _id: 'vocab-001',
      tenantId: TENANT_ID,
      projectKnowledgeBaseId: INDEX_ID,
      version: 1,
      entries: entriesCopy,
      save: mockSave,
    });

    const res = await request(app)
      .post(`/indexes/${INDEX_ID}/vocabulary/review`)
      .send({ action: 'approve', termIds: ['nonexistent_001', 'nonexistent_002'] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TERMS_NOT_FOUND');
    expect(mockSave).not.toHaveBeenCalled();
  });

  test('partial match: returns updatedIds and notFoundIds', async () => {
    const entriesCopy = [
      makeEntry({ id: 'entry_001', enabled: false }),
      makeEntry({ id: 'entry_002', enabled: false }),
    ];
    const mockSave = vi.fn().mockResolvedValue(undefined);

    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeIndex),
    });
    mockDomainVocabularyFindOne.mockResolvedValue({
      _id: 'vocab-001',
      tenantId: TENANT_ID,
      projectKnowledgeBaseId: INDEX_ID,
      version: 1,
      entries: entriesCopy,
      save: mockSave,
    });

    const res = await request(app)
      .post(`/indexes/${INDEX_ID}/vocabulary/review`)
      .send({ action: 'approve', termIds: ['entry_001', 'nonexistent_999'] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.updatedCount).toBe(1);
    expect(res.body.updatedIds).toEqual(['entry_001']);
    expect(res.body.notFoundIds).toEqual(['nonexistent_999']);
  });

  test('tenant isolation: returns 404 for different tenant', async () => {
    const otherApp = createApp('other-tenant');
    mockSearchIndexFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null), // not found for other tenant
    });

    const res = await request(otherApp)
      .post(`/indexes/${INDEX_ID}/vocabulary/review`)
      .send({ action: 'approve', termIds: ['entry_001'] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
