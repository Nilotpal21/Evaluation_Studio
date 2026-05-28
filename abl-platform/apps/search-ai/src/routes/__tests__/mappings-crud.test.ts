/**
 * FieldMapping CRUD API Tests (Story 2.4)
 *
 * Tests for:
 * - PATCH /:mappingId — Edit alias, enumValueMap, transform
 * - POST /bulk-action — Bulk confirm or reject mappings
 * - POST / — Manual field mapping creation
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────────

const {
  mockFieldMappingFind,
  mockFieldMappingFindOne,
  mockFieldMappingFindOneAndUpdate,
  mockFieldMappingFindOneAndDelete,
  mockFieldMappingCreate,
  mockFieldMappingUpdateMany,
  mockFieldMappingInsertMany,
  mockFieldMappingCountDocuments,
  mockCanonicalSchemaFindOne,
  mockCanonicalSchemaFindOneAndUpdate,
  mockSearchIndexFindOne,
  mockKnowledgeBaseFindOne,
  mockInvalidateCache,
  mockQueueAuditEntry,
  mockBatchUpdateMappings,
} = vi.hoisted(() => ({
  mockFieldMappingFind: vi.fn(),
  mockFieldMappingFindOne: vi.fn(),
  mockFieldMappingFindOneAndUpdate: vi.fn(),
  mockFieldMappingFindOneAndDelete: vi.fn(),
  mockFieldMappingCreate: vi.fn(),
  mockFieldMappingUpdateMany: vi.fn(),
  mockFieldMappingInsertMany: vi.fn(),
  mockFieldMappingCountDocuments: vi.fn(),
  mockCanonicalSchemaFindOne: vi.fn(),
  mockCanonicalSchemaFindOneAndUpdate: vi.fn(),
  mockSearchIndexFindOne: vi.fn(),
  mockKnowledgeBaseFindOne: vi.fn(),
  mockInvalidateCache: vi.fn(),
  mockQueueAuditEntry: vi.fn(),
  mockBatchUpdateMappings: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    switch (modelName) {
      case 'FieldMapping':
        return {
          find: mockFieldMappingFind,
          findOne: mockFieldMappingFindOne,
          findOneAndUpdate: mockFieldMappingFindOneAndUpdate,
          findOneAndDelete: mockFieldMappingFindOneAndDelete,
          create: mockFieldMappingCreate,
          updateMany: mockFieldMappingUpdateMany,
          insertMany: mockFieldMappingInsertMany,
          countDocuments: mockFieldMappingCountDocuments,
        };
      case 'CanonicalSchema':
        return {
          findOne: mockCanonicalSchemaFindOne,
          findOneAndUpdate: mockCanonicalSchemaFindOneAndUpdate,
          create: vi.fn(),
        };
      case 'ConnectorSchema':
        return {
          findOne: vi.fn().mockReturnValue({
            sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
          }),
        };
      case 'SearchIndex':
        return {
          findOne: mockSearchIndexFindOne,
        };
      case 'KnowledgeBase':
        return {
          findOne: mockKnowledgeBaseFindOne,
        };
      default:
        return {};
    }
  }),
}));

vi.mock('../../services/canonical-mapping/index.js', () => ({
  getCanonicalMapperService: vi.fn(() => ({
    invalidateCache: mockInvalidateCache,
  })),
}));

vi.mock('../../services/mapping-suggestion/index.js', () => ({
  mappingSuggestionService: {
    suggestMappings: vi.fn(),
  },
  MappingSuggestionService: vi.fn(),
}));

vi.mock('../../services/mapping-review/index.js', () => ({
  batchReviewService: {
    getMappingsForReview: vi.fn(),
    batchUpdateMappings: (...args: unknown[]) => mockBatchUpdateMappings(...args),
    getReviewStats: vi.fn(),
  },
  BatchReviewService: vi.fn(),
}));

vi.mock('../../middleware/rate-limit.js', () => ({
  searchAiRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../services/connector-audit.service.js', () => ({
  queueAuditEntry: (...args: unknown[]) => mockQueueAuditEntry(...args),
}));

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
import mappingsRouter from '../mappings.js';

// ─── Test App Setup ─────────────────────────────────────────────────────────

const mockTenantContext = { tenantId: 'tenant-test' } as any;
const leanQuery = <T>(value: T) => ({
  select: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue(value),
});

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantContext = mockTenantContext;
    next();
  });
  app.use('/mappings', mappingsRouter);
  return app;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const fakeMapping = {
  _id: 'mapping-001',
  tenantId: 'tenant-test',
  canonicalSchemaId: 'schema-001',
  canonicalField: 'priority',
  connectorId: 'conn-001',
  sourcePath: 'fields.priority.name',
  transform: { type: 'direct' },
  confidence: 0.85,
  status: 'suggested',
  suggestedBy: 'llm',
  reviewedBy: null,
  reviewedAt: null,
};

const fakeCanonicalSchema = {
  _id: 'schema-001',
  tenantId: 'tenant-test',
  knowledgeBaseId: 'kb-001',
  version: 1,
  fields: [
    {
      name: 'Priority',
      label: 'Priority Level',
      type: 'string',
      storageField: 'priority',
      indexed: true,
      filterable: true,
      aggregatable: false,
      sortable: true,
    },
    {
      name: 'Status',
      label: 'Status',
      type: 'string',
      storageField: 'status',
      indexed: true,
      filterable: true,
      aggregatable: false,
      sortable: true,
    },
  ],
  status: 'active',
};

// ─── Setup ──────────────────────────────────────────────────────────────────

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  delete mockTenantContext.projectId;
  delete mockTenantContext.projectScope;
  app = createApp();
  mockInvalidateCache.mockResolvedValue(undefined);
  mockQueueAuditEntry.mockReset();
  mockBatchUpdateMappings.mockReset();
  mockFieldMappingFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(fakeMapping) });
  mockCanonicalSchemaFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
  });
  mockSearchIndexFindOne.mockReturnValue(leanQuery({ _id: 'kb-001' }));
  mockKnowledgeBaseFindOne.mockReturnValue(leanQuery(null));
  mockFieldMappingCountDocuments.mockResolvedValue(0);
});

// ─── Project Scope Isolation ────────────────────────────────────────────────

describe('projectScope isolation', () => {
  test('GET /mappings?schemaId=... returns 404 before listing cross-project mappings', async () => {
    mockTenantContext.projectScope = ['project-allowed'];
    mockCanonicalSchemaFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
    });
    mockSearchIndexFindOne.mockReturnValue(leanQuery(null));

    const res = await request(app).get('/mappings?schemaId=schema-001');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Canonical schema not found');
    expect(mockSearchIndexFindOne).toHaveBeenCalledWith({
      _id: 'kb-001',
      tenantId: 'tenant-test',
      projectId: { $in: ['project-allowed'] },
    });
    expect(mockFieldMappingFind).not.toHaveBeenCalled();
  });

  test('PATCH /mappings/:mappingId refuses cross-project schema before mutating', async () => {
    mockTenantContext.projectScope = ['project-allowed'];
    mockFieldMappingFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(fakeMapping) });
    mockCanonicalSchemaFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
    });
    mockSearchIndexFindOne.mockReturnValue(leanQuery(null));

    const res = await request(app)
      .patch('/mappings/mapping-001')
      .send({ transform: { type: 'direct' } });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Mapping not found');
    expect(mockFieldMappingFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('DELETE /mappings/:mappingId refuses cross-project schema before deleting', async () => {
    mockTenantContext.projectScope = ['project-allowed'];
    mockFieldMappingFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(fakeMapping) });
    mockCanonicalSchemaFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
    });
    mockSearchIndexFindOne.mockReturnValue(leanQuery(null));

    const res = await request(app).delete('/mappings/mapping-001');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Mapping not found' });
    expect(mockFieldMappingFindOneAndDelete).not.toHaveBeenCalled();
  });
});

// ─── PATCH /:mappingId ──────────────────────────────────────────────────────

describe('PATCH /mappings/:mappingId', () => {
  test('happy path: update enumValueMap, returns updated mapping', async () => {
    const updatedMapping = {
      ...fakeMapping,
      transform: { type: 'value_map', valueMap: { high: 'H', low: 'L' } },
    };
    mockFieldMappingFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(fakeMapping) });
    mockFieldMappingFindOneAndUpdate.mockReturnValue({
      lean: vi.fn().mockResolvedValue(updatedMapping),
    });

    const res = await request(app)
      .patch('/mappings/mapping-001')
      .send({ enumValueMap: { high: 'H', low: 'L' } });

    expect(res.status).toBe(200);
    expect(res.body.mapping.transform.type).toBe('value_map');
    expect(res.body.mapping.transform.valueMap).toEqual({ high: 'H', low: 'L' });
  });

  test('happy path: update alias, updates CanonicalSchema field name', async () => {
    mockFieldMappingFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(fakeMapping) });
    mockCanonicalSchemaFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
    });
    mockCanonicalSchemaFindOneAndUpdate.mockResolvedValue(fakeCanonicalSchema);
    // Only alias update: no FieldMapping update, just re-fetch
    mockFieldMappingFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(fakeMapping) });

    const res = await request(app).patch('/mappings/mapping-001').send({ alias: 'Urgency' });

    expect(res.status).toBe(200);
    expect(mockCanonicalSchemaFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: 'schema-001',
        tenantId: 'tenant-test',
        'fields.storageField': 'priority',
      },
      { $set: { 'fields.$.name': 'Urgency' } },
    );
  });

  test('returns 404 when mapping not found (including cross-tenant)', async () => {
    mockFieldMappingFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

    const res = await request(app).patch('/mappings/mapping-999').send({ alias: 'test' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Mapping not found');
  });

  test('returns 409 when alias already in use', async () => {
    mockFieldMappingFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(fakeMapping) });
    mockCanonicalSchemaFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
    });

    // 'Status' is already used by the status field (storageField !== 'priority')
    const res = await request(app).patch('/mappings/mapping-001').send({ alias: 'Status' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Alias already in use within this knowledge base');
  });

  test('returns 400 when no fields provided in body', async () => {
    const res = await request(app).patch('/mappings/mapping-001').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('At least one of');
  });

  test('tenantId is included in query filter', async () => {
    mockFieldMappingFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(fakeMapping) });
    mockFieldMappingFindOneAndUpdate.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeMapping),
    });

    await request(app)
      .patch('/mappings/mapping-001')
      .send({ transform: { type: 'direct' } });

    expect(mockFieldMappingFindOne).toHaveBeenCalledWith({
      _id: 'mapping-001',
      tenantId: 'tenant-test',
    });
  });

  test('cache invalidation is called after update', async () => {
    mockFieldMappingFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(fakeMapping) });
    mockFieldMappingFindOneAndUpdate.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeMapping),
    });

    await request(app)
      .patch('/mappings/mapping-001')
      .send({ transform: { type: 'direct' } });

    expect(mockInvalidateCache).toHaveBeenCalledWith('conn-001', 'tenant-test');
  });

  test('writes durable connector audit for mapping updates', async () => {
    mockFieldMappingFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(fakeMapping) });
    mockFieldMappingFindOneAndUpdate.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeMapping),
    });

    await request(app)
      .patch('/mappings/mapping-001')
      .send({ transform: { type: 'direct' } });

    expect(mockQueueAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: 'conn-001',
        tenantId: 'tenant-test',
        event: 'mapping.update',
        category: 'config',
      }),
    );
  });

  test('returns 500 on unexpected error', async () => {
    mockFieldMappingFindOne.mockReturnValue({
      lean: vi.fn().mockRejectedValue(new Error('DB error')),
    });

    const res = await request(app).patch('/mappings/mapping-001').send({ alias: 'test' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to update mapping');
  });
});

// ─── POST /bulk-action ──────────────────────────────────────────────────────

describe('POST /mappings/bulk-action', () => {
  test('happy path: confirm multiple mappings, returns processedCount', async () => {
    const tenantMappings = [
      { _id: 'mapping-001', connectorId: 'conn-001' },
      { _id: 'mapping-002', connectorId: 'conn-001' },
    ];
    mockFieldMappingFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(tenantMappings),
      }),
    });
    mockFieldMappingUpdateMany.mockResolvedValue({ modifiedCount: 2 });

    const res = await request(app)
      .post('/mappings/bulk-action')
      .send({ action: 'confirm', mappingIds: ['mapping-001', 'mapping-002'] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.processedCount).toBe(2);
  });

  test('happy path: reject multiple mappings', async () => {
    const tenantMappings = [{ _id: 'mapping-001', connectorId: 'conn-001' }];
    mockFieldMappingFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(tenantMappings),
      }),
    });
    mockFieldMappingUpdateMany.mockResolvedValue({ modifiedCount: 1 });

    const res = await request(app)
      .post('/mappings/bulk-action')
      .send({ action: 'reject', mappingIds: ['mapping-001'] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.processedCount).toBe(1);
  });

  test('returns 400 when mappingIds is empty', async () => {
    const res = await request(app)
      .post('/mappings/bulk-action')
      .send({ action: 'confirm', mappingIds: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('mappingIds must be a non-empty array');
  });

  test('returns 400 when mappingIds is not an array', async () => {
    const res = await request(app)
      .post('/mappings/bulk-action')
      .send({ action: 'confirm', mappingIds: 'not-an-array' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('mappingIds must be a non-empty array');
  });

  test('returns 400 when mappingIds.length > 200', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `mapping-${i}`);

    const res = await request(app)
      .post('/mappings/bulk-action')
      .send({ action: 'confirm', mappingIds: ids });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('must not exceed 200');
  });

  test('returns 400 when action is invalid', async () => {
    const res = await request(app)
      .post('/mappings/bulk-action')
      .send({ action: 'invalid', mappingIds: ['mapping-001'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('action must be confirm or reject');
  });

  test('validates all mappingIds belong to tenant', async () => {
    // Only one of two IDs found in tenant scope
    mockFieldMappingFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ _id: 'mapping-001', connectorId: 'conn-001' }]),
      }),
    });

    const res = await request(app)
      .post('/mappings/bulk-action')
      .send({ action: 'confirm', mappingIds: ['mapping-001', 'mapping-not-owned'] });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Some mappingIds were not found');
  });

  test('cache invalidation is called for each affected connectorId', async () => {
    const tenantMappings = [
      { _id: 'mapping-001', connectorId: 'conn-001' },
      { _id: 'mapping-002', connectorId: 'conn-002' },
    ];
    mockFieldMappingFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(tenantMappings),
      }),
    });
    mockFieldMappingUpdateMany.mockResolvedValue({ modifiedCount: 2 });

    await request(app)
      .post('/mappings/bulk-action')
      .send({ action: 'confirm', mappingIds: ['mapping-001', 'mapping-002'] });

    expect(mockInvalidateCache).toHaveBeenCalledWith('conn-001', 'tenant-test');
    expect(mockInvalidateCache).toHaveBeenCalledWith('conn-002', 'tenant-test');
    expect(mockInvalidateCache).toHaveBeenCalledTimes(2);
  });

  test('writes durable connector audit entries grouped by connector for bulk action', async () => {
    const tenantMappings = [
      { _id: 'mapping-001', connectorId: 'conn-001' },
      { _id: 'mapping-002', connectorId: 'conn-002' },
    ];
    mockFieldMappingFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(tenantMappings),
      }),
    });
    mockFieldMappingUpdateMany.mockResolvedValue({ modifiedCount: 2 });

    await request(app)
      .post('/mappings/bulk-action')
      .send({ action: 'confirm', mappingIds: ['mapping-001', 'mapping-002'] });

    expect(mockQueueAuditEntry).toHaveBeenCalledTimes(2);
    expect(mockQueueAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: 'conn-001',
        event: 'mapping.batch_confirm',
      }),
    );
    expect(mockQueueAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: 'conn-002',
        event: 'mapping.batch_confirm',
      }),
    );
  });

  test('returns 500 on unexpected error', async () => {
    mockFieldMappingFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockRejectedValue(new Error('DB error')),
      }),
    });

    const res = await request(app)
      .post('/mappings/bulk-action')
      .send({ action: 'confirm', mappingIds: ['mapping-001'] });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to perform bulk action on mappings');
  });
});

describe('POST /mappings/batch-update', () => {
  test('writes batch_needs_review audit entries for needs_review transitions', async () => {
    mockBatchUpdateMappings.mockResolvedValue({ updatedCount: 2 });
    mockFieldMappingFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          {
            _id: 'mapping-001',
            connectorId: 'conn-001',
            canonicalSchemaId: 'schema-001',
            canonicalField: 'priority',
            sourcePath: 'fields.priority.name',
          },
          {
            _id: 'mapping-002',
            connectorId: 'conn-001',
            canonicalSchemaId: 'schema-002',
            canonicalField: 'status',
            sourcePath: 'fields.status.name',
          },
        ]),
      }),
    });

    const res = await request(app)
      .post('/mappings/batch-update')
      .send({
        mappingIds: ['mapping-001', 'mapping-002'],
        action: 'needs_review',
        reviewedBy: 'reviewer-1',
      });

    expect(res.status).toBe(200);
    expect(mockBatchUpdateMappings).toHaveBeenCalledWith({
      tenantId: 'tenant-test',
      mappingIds: ['mapping-001', 'mapping-002'],
      action: 'needs_review',
      reviewedBy: 'reviewer-1',
    });
    expect(mockQueueAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: 'conn-001',
        event: 'mapping.batch_needs_review',
        metadata: expect.objectContaining({
          action: 'needs_review',
          reviewedBy: 'reviewer-1',
          mappings: [
            {
              mappingId: 'mapping-001',
              canonicalSchemaId: 'schema-001',
              canonicalField: 'priority',
              sourcePath: 'fields.priority.name',
            },
            {
              mappingId: 'mapping-002',
              canonicalSchemaId: 'schema-002',
              canonicalField: 'status',
              sourcePath: 'fields.status.name',
            },
          ],
        }),
      }),
    );
  });
});

// ─── POST /:mappingId/confirm + /reject ────────────────────────────────────

describe('POST /mappings/:mappingId/confirm and /reject', () => {
  test('confirm writes durable connector audit entry', async () => {
    mockFieldMappingFindOneAndUpdate.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ ...fakeMapping, status: 'active' }),
    });

    const res = await request(app)
      .post('/mappings/mapping-001/confirm')
      .send({ reviewedBy: 'u-1' });

    expect(res.status).toBe(200);
    expect(mockQueueAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: 'conn-001',
        event: 'mapping.confirm',
        category: 'config',
      }),
    );
  });

  test('reject writes durable connector audit entry', async () => {
    mockFieldMappingFindOneAndUpdate.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ ...fakeMapping, status: 'rejected' }),
    });

    const res = await request(app).post('/mappings/mapping-001/reject').send({ reviewedBy: 'u-1' });

    expect(res.status).toBe(200);
    expect(mockQueueAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: 'conn-001',
        event: 'mapping.reject',
        category: 'config',
      }),
    );
  });
});

// ─── POST / (Manual Creation) ───────────────────────────────────────────────

describe('POST /mappings (manual creation)', () => {
  test('happy path: creates mapping with status=active, confidence=1.0, suggestedBy=user', async () => {
    const createdMapping = {
      _id: 'mapping-new',
      tenantId: 'tenant-test',
      canonicalSchemaId: 'schema-001',
      canonicalField: 'priority',
      connectorId: 'conn-001',
      sourcePath: 'fields.priority.name',
      transform: { type: 'direct' },
      confidence: 1.0,
      status: 'active',
      suggestedBy: 'user',
      reviewedBy: 'user',
      reviewedAt: new Date(),
    };
    mockCanonicalSchemaFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
    });
    mockFieldMappingCreate.mockResolvedValue(createdMapping);

    const res = await request(app).post('/mappings').send({
      sourcePath: 'fields.priority.name',
      canonicalField: 'priority',
      connectorId: 'conn-001',
      canonicalSchemaId: 'schema-001',
    });

    expect(res.status).toBe(201);
    expect(res.body.mapping.status).toBe('active');
    expect(res.body.mapping.confidence).toBe(1.0);
    expect(res.body.mapping.suggestedBy).toBe('user');
  });

  test('returns 201 status code', async () => {
    mockCanonicalSchemaFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
    });
    mockFieldMappingCreate.mockResolvedValue({ ...fakeMapping, status: 'active' });

    const res = await request(app).post('/mappings').send({
      sourcePath: 'fields.priority.name',
      canonicalField: 'priority',
      connectorId: 'conn-001',
      canonicalSchemaId: 'schema-001',
    });

    expect(res.status).toBe(201);
  });

  test('returns 400 when required fields missing', async () => {
    const res = await request(app).post('/mappings').send({
      sourcePath: 'fields.priority.name',
      // missing canonicalField, connectorId, canonicalSchemaId
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('required');
  });

  test('returns 404 when canonicalSchema not found', async () => {
    mockCanonicalSchemaFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

    const res = await request(app).post('/mappings').send({
      sourcePath: 'fields.priority.name',
      canonicalField: 'priority',
      connectorId: 'conn-001',
      canonicalSchemaId: 'schema-nonexistent',
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Canonical schema not found');
  });

  test('returns 404 when canonicalField not in schema.fields', async () => {
    mockCanonicalSchemaFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
    });

    const res = await request(app).post('/mappings').send({
      sourcePath: 'fields.unknown.name',
      canonicalField: 'nonexistent_field',
      connectorId: 'conn-001',
      canonicalSchemaId: 'schema-001',
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('canonicalField not found in schema');
  });

  test('returns 409 on duplicate key error (MongoDB error code 11000)', async () => {
    mockCanonicalSchemaFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
    });

    const dupError = new Error('E11000 duplicate key error') as any;
    dupError.code = 11000;
    mockFieldMappingCreate.mockRejectedValue(dupError);

    const res = await request(app).post('/mappings').send({
      sourcePath: 'fields.priority.name',
      canonicalField: 'priority',
      connectorId: 'conn-001',
      canonicalSchemaId: 'schema-001',
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Mapping already exists');
  });

  test('default transform is { type: "direct" } when not provided', async () => {
    mockCanonicalSchemaFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
    });
    mockFieldMappingCreate.mockImplementation((doc: any) =>
      Promise.resolve({ _id: 'new', ...doc }),
    );

    await request(app).post('/mappings').send({
      sourcePath: 'fields.priority.name',
      canonicalField: 'priority',
      connectorId: 'conn-001',
      canonicalSchemaId: 'schema-001',
    });

    expect(mockFieldMappingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        transform: { type: 'direct' },
      }),
    );
  });

  test('custom transform is preserved when provided', async () => {
    mockCanonicalSchemaFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
    });
    mockFieldMappingCreate.mockImplementation((doc: any) =>
      Promise.resolve({ _id: 'new', ...doc }),
    );

    const customTransform = { type: 'parse_date', sourceFormat: 'YYYY-MM-DD' };

    await request(app).post('/mappings').send({
      sourcePath: 'fields.priority.name',
      canonicalField: 'priority',
      connectorId: 'conn-001',
      canonicalSchemaId: 'schema-001',
      transform: customTransform,
    });

    expect(mockFieldMappingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        transform: customTransform,
      }),
    );
  });

  test('cache invalidation is called after creation', async () => {
    mockCanonicalSchemaFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
    });
    mockFieldMappingCreate.mockResolvedValue({ ...fakeMapping, _id: 'new' });

    await request(app).post('/mappings').send({
      sourcePath: 'fields.priority.name',
      canonicalField: 'priority',
      connectorId: 'conn-001',
      canonicalSchemaId: 'schema-001',
    });

    expect(mockInvalidateCache).toHaveBeenCalledWith('conn-001', 'tenant-test');
  });

  test('writes durable connector audit for manual mapping creation', async () => {
    mockCanonicalSchemaFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
    });
    mockFieldMappingCreate.mockResolvedValue({ ...fakeMapping, _id: 'new' });

    await request(app).post('/mappings').send({
      sourcePath: 'fields.priority.name',
      canonicalField: 'priority',
      connectorId: 'conn-001',
      canonicalSchemaId: 'schema-001',
    });

    expect(mockQueueAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: 'conn-001',
        event: 'mapping.manual_create',
        category: 'config',
      }),
    );
  });

  test('tenantId is included in created document', async () => {
    mockCanonicalSchemaFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(fakeCanonicalSchema),
    });
    mockFieldMappingCreate.mockImplementation((doc: any) =>
      Promise.resolve({ _id: 'new', ...doc }),
    );

    await request(app).post('/mappings').send({
      sourcePath: 'fields.priority.name',
      canonicalField: 'priority',
      connectorId: 'conn-001',
      canonicalSchemaId: 'schema-001',
    });

    expect(mockFieldMappingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-test',
      }),
    );
  });

  test('returns 500 on unexpected error', async () => {
    mockCanonicalSchemaFindOne.mockReturnValue({
      lean: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    });

    const res = await request(app).post('/mappings').send({
      sourcePath: 'fields.priority.name',
      canonicalField: 'priority',
      connectorId: 'conn-001',
      canonicalSchemaId: 'schema-001',
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to create mapping');
  });
});
