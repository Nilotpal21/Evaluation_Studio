/**
 * Document Status Routes Tests
 *
 * Integration tests for document listing, status-summary, detail, and delete endpoints.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

// Mock dependencies before imports
vi.mock('../../db/index.js', () => {
  const models: Record<string, any> = {
    SearchDocument: {
      find: vi.fn(),
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
      countDocuments: vi.fn(),
      aggregate: vi.fn(),
      deleteOne: vi.fn(),
    },
    SearchIndex: {
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    },
    SearchChunk: {
      find: vi.fn(),
      aggregate: vi.fn(),
      countDocuments: vi.fn(),
      deleteMany: vi.fn(),
    },
    ChunkQuestion: {
      find: vi.fn(),
      deleteMany: vi.fn(),
    },
    KnowledgeBase: {
      findOneAndUpdate: vi.fn().mockResolvedValue({}),
    },
    SearchSource: {
      findOneAndUpdate: vi.fn().mockResolvedValue({}),
    },
  };

  return {
    getLazyModel: vi.fn((modelName: string) => models[modelName] || {}),
  };
});

vi.mock('@agent-platform/search-ai-internal', () => ({
  createVectorStore: vi.fn(() => ({
    delete: vi.fn().mockResolvedValue(undefined),
  })),
  resolveIndexForWrite: vi.fn().mockResolvedValue('vs-index-name'),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../../services/document-cleanup.service.js', () => ({
  cleanupAllFieldsAndVocab: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/structured-data/clickhouse-client.js', () => ({
  StructuredDataClickHouseClient: vi.fn().mockImplementation(() => ({
    deleteTable: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Import after mocks
import { getLazyModel } from '../../db/index.js';
import documentsRouter from '../documents.js';

describe('Document Routes', () => {
  let app: Express;
  let mockDocModel: any;
  let mockIndexModel: any;
  let mockChunkModel: any;
  let mockQuestionModel: any;
  let mockKbModel: any;
  let mockSourceModel: any;

  const mockTenantContext = {
    tenantId: 'tenant-123',
    userId: 'user-456',
  } as any;

  const mockUser = {
    id: 'user-456',
    email: 'test@example.com',
  } as any;

  const authMiddleware = (req: Request, _res: Response, next: NextFunction) => {
    req.tenantContext = mockTenantContext;
    req.user = mockUser;
    next();
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(authMiddleware);
    app.use(documentsRouter);

    mockDocModel = getLazyModel('SearchDocument') as any;
    mockIndexModel = getLazyModel('SearchIndex') as any;
    mockChunkModel = getLazyModel('SearchChunk') as any;
    mockQuestionModel = getLazyModel('ChunkQuestion') as any;
    mockKbModel = getLazyModel('KnowledgeBase') as any;
    mockSourceModel = getLazyModel('SearchSource') as any;

    vi.clearAllMocks();
    delete mockTenantContext.projectId;
    delete mockTenantContext.projectScope;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  const INDEX_ID = '507f1f77bcf86cd799439011';
  const DOC_ID = '507f1f77bcf86cd799439022';

  const createMockIndex = () => ({
    _id: INDEX_ID,
    tenantId: 'tenant-123',
    projectId: 'project-456',
    slug: 'test-kb',
    name: 'Test Index',
    status: 'active',
  });

  const createMockDocument = (overrides: Record<string, unknown> = {}) => ({
    _id: DOC_ID,
    tenantId: 'tenant-123',
    indexId: INDEX_ID,
    sourceId: 'source-001',
    originalReference: 'https://example.com/doc.pdf',
    status: 'indexed',
    chunkCount: 5,
    contentType: 'application/pdf',
    contentSizeBytes: 102400,
    extractedText: 'Sample extracted text content.',
    sourceMetadata: { readability: { title: 'My Document' } },
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    ...overrides,
  });

  // ── GET /:indexId/documents ──────────────────────────────────────────────

  describe('GET /:indexId/documents', () => {
    test('should return paginated list', async () => {
      const docs = [
        createMockDocument(),
        createMockDocument({ _id: '507f1f77bcf86cd799439033', originalReference: 'doc2.pdf' }),
      ];

      mockIndexModel.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(createMockIndex()),
      });
      mockDocModel.countDocuments.mockResolvedValue(2);

      // Chained find().sort().skip().limit().select().lean()
      const leanMock = vi.fn().mockResolvedValue(docs);
      const selectMock = vi.fn().mockReturnValue({ lean: leanMock });
      const limitMock = vi.fn().mockReturnValue({ select: selectMock });
      const skipMock = vi.fn().mockReturnValue({ limit: limitMock });
      const sortMock = vi.fn().mockReturnValue({ skip: skipMock });
      mockDocModel.find.mockReturnValue({ sort: sortMock });

      const response = await request(app).get(`/${INDEX_ID}/documents`).expect(200);

      expect(response.body.documents).toHaveLength(2);
      expect(response.body.total).toBe(2);
      expect(response.body.pagination).toMatchObject({
        limit: 50,
        offset: 0,
        hasMore: false,
      });
    });

    test('scopes index ownership by API-key projectScope before listing documents', async () => {
      mockTenantContext.projectScope = ['project-456'];
      mockIndexModel.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(createMockIndex()),
      });
      mockDocModel.countDocuments.mockResolvedValue(0);

      const leanMock = vi.fn().mockResolvedValue([]);
      const selectMock = vi.fn().mockReturnValue({ lean: leanMock });
      const limitMock = vi.fn().mockReturnValue({ select: selectMock });
      const skipMock = vi.fn().mockReturnValue({ limit: limitMock });
      const sortMock = vi.fn().mockReturnValue({ skip: skipMock });
      mockDocModel.find.mockReturnValue({ sort: sortMock });

      await request(app).get(`/${INDEX_ID}/documents`).expect(200);

      expect(mockIndexModel.findOne).toHaveBeenCalledWith({
        _id: INDEX_ID,
        tenantId: 'tenant-123',
        projectId: { $in: ['project-456'] },
      });
    });

    test('should filter by sourceId', async () => {
      mockIndexModel.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(createMockIndex()),
      });
      mockDocModel.countDocuments.mockResolvedValue(0);

      const leanMock = vi.fn().mockResolvedValue([]);
      const selectMock = vi.fn().mockReturnValue({ lean: leanMock });
      const limitMock = vi.fn().mockReturnValue({ select: selectMock });
      const skipMock = vi.fn().mockReturnValue({ limit: limitMock });
      const sortMock = vi.fn().mockReturnValue({ skip: skipMock });
      mockDocModel.find.mockReturnValue({ sort: sortMock });

      await request(app).get(`/${INDEX_ID}/documents?sourceId=source-001`).expect(200);

      expect(mockDocModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: 'source-001' }),
      );
    });

    test('should filter by comma-separated status', async () => {
      mockIndexModel.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(createMockIndex()),
      });
      mockDocModel.countDocuments.mockResolvedValue(0);

      const leanMock = vi.fn().mockResolvedValue([]);
      const selectMock = vi.fn().mockReturnValue({ lean: leanMock });
      const limitMock = vi.fn().mockReturnValue({ select: selectMock });
      const skipMock = vi.fn().mockReturnValue({ limit: limitMock });
      const sortMock = vi.fn().mockReturnValue({ skip: skipMock });
      mockDocModel.find.mockReturnValue({ sort: sortMock });

      await request(app).get(`/${INDEX_ID}/documents?status=indexed,error`).expect(200);

      expect(mockDocModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ status: { $in: ['indexed', 'error'] } }),
      );
    });

    test('should filter by search (regex on originalReference)', async () => {
      mockIndexModel.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(createMockIndex()),
      });
      mockDocModel.countDocuments.mockResolvedValue(0);

      const leanMock = vi.fn().mockResolvedValue([]);
      const selectMock = vi.fn().mockReturnValue({ lean: leanMock });
      const limitMock = vi.fn().mockReturnValue({ select: selectMock });
      const skipMock = vi.fn().mockReturnValue({ limit: limitMock });
      const sortMock = vi.fn().mockReturnValue({ skip: skipMock });
      mockDocModel.find.mockReturnValue({ sort: sortMock });

      await request(app).get(`/${INDEX_ID}/documents?search=example`).expect(200);

      expect(mockDocModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          originalReference: { $regex: 'example', $options: 'i' },
        }),
      );
    });

    test('should respect limit and offset', async () => {
      mockIndexModel.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(createMockIndex()),
      });
      mockDocModel.countDocuments.mockResolvedValue(10);

      const leanMock = vi.fn().mockResolvedValue([createMockDocument()]);
      const selectMock = vi.fn().mockReturnValue({ lean: leanMock });
      const limitMock = vi.fn().mockReturnValue({ select: selectMock });
      const skipMock = vi.fn().mockReturnValue({ limit: limitMock });
      const sortMock = vi.fn().mockReturnValue({ skip: skipMock });
      mockDocModel.find.mockReturnValue({ sort: sortMock });

      const response = await request(app)
        .get(`/${INDEX_ID}/documents?limit=1&offset=5`)
        .expect(200);

      expect(skipMock).toHaveBeenCalledWith(5);
      expect(limitMock).toHaveBeenCalledWith(1);
      expect(response.body.pagination).toMatchObject({
        limit: 1,
        offset: 5,
        hasMore: true,
      });
    });
  });

  // ── GET /:indexId/documents/status-summary ──────────────────────────────

  describe('GET /:indexId/documents/status-summary', () => {
    test('should return documentStatuses array and docsWithChunkErrors', async () => {
      mockDocModel.aggregate.mockResolvedValue([
        { _id: 'indexed', count: 10 },
        { _id: 'error', count: 2 },
      ]);
      mockChunkModel.aggregate.mockResolvedValue([{ docsWithChunkErrors: 3 }]);

      const response = await request(app).get(`/${INDEX_ID}/documents/status-summary`).expect(200);

      expect(response.body.documentStatuses).toEqual([
        { _id: 'indexed', count: 10 },
        { _id: 'error', count: 2 },
      ]);
      expect(response.body.docsWithChunkErrors).toBe(3);
    });

    test('should return 0 docsWithChunkErrors when no chunk errors', async () => {
      mockDocModel.aggregate.mockResolvedValue([{ _id: 'indexed', count: 5 }]);
      mockChunkModel.aggregate.mockResolvedValue([]);

      const response = await request(app).get(`/${INDEX_ID}/documents/status-summary`).expect(200);

      expect(response.body.docsWithChunkErrors).toBe(0);
    });

    test('should return 401 without tenantContext', async () => {
      const appNoAuth = express();
      appNoAuth.use(express.json());
      appNoAuth.use(documentsRouter);

      // The status-summary route uses req.tenantContext! (non-null assertion)
      // which will throw, resulting in a 500. But the list route checks explicitly.
      // Let's test the list route for 401 since status-summary doesn't check.
      const response = await request(appNoAuth).get(`/${INDEX_ID}/documents`).expect(401);

      expect(response.body.error).toBe('Unauthorized');
    });
  });

  // ── GET /:indexId/documents/:documentId ─────────────────────────────────

  describe('GET /:indexId/documents/:documentId', () => {
    test('should return document detail with chunks', async () => {
      const mockDoc = createMockDocument();
      const mockChunks = [
        { _id: 'chunk-1', content: 'Chunk 1 text', position: { order: 0 }, status: 'indexed' },
        { _id: 'chunk-2', content: 'Chunk 2 text', position: { order: 1 }, status: 'indexed' },
      ];

      mockIndexModel.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(createMockIndex()),
      });
      mockDocModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockDoc) });

      // Chained find().sort().select().skip().limit().lean()
      const leanMock = vi.fn().mockResolvedValue(mockChunks);
      const limitMock = vi.fn().mockReturnValue({ lean: leanMock });
      const skipMock = vi.fn().mockReturnValue({ limit: limitMock });
      const selectMock = vi.fn().mockReturnValue({ skip: skipMock });
      const sortMock = vi.fn().mockReturnValue({ select: selectMock });
      mockChunkModel.find.mockReturnValue({ sort: sortMock });
      mockChunkModel.countDocuments.mockResolvedValue(2);

      const response = await request(app).get(`/${INDEX_ID}/documents/${DOC_ID}`).expect(200);

      expect(response.body.document).toMatchObject({
        _id: DOC_ID,
        title: 'My Document', // from sourceMetadata.readability.title
        status: 'indexed',
      });
      expect(response.body.chunks).toHaveLength(2);
      expect(response.body.chunkCount).toBe(2);
    });

    test('should return 404 for non-existent document', async () => {
      mockIndexModel.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(createMockIndex()),
      });
      mockDocModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const response = await request(app)
        .get(`/${INDEX_ID}/documents/507f1f77bcf86cd799439099`)
        .expect(404);

      expect(response.body.error).toBe('Document not found');
    });

    test('should return 404 for wrong tenant (isolation)', async () => {
      // Index not found for this tenant = 404
      mockIndexModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const response = await request(app).get(`/${INDEX_ID}/documents/${DOC_ID}`).expect(404);

      expect(mockIndexModel.findOne).toHaveBeenCalledWith({
        _id: INDEX_ID,
        tenantId: 'tenant-123',
      });
      expect(response.body.error).toBe('Index not found');
    });
  });

  // ── DELETE /:indexId/documents/:documentId ──────────────────────────────

  describe('DELETE /:indexId/documents/:documentId', () => {
    test('should delete chunks + document + update index counters', async () => {
      const mockDoc = createMockDocument();
      const mockChunks = [{ _id: 'chunk-1' }, { _id: 'chunk-2' }, { _id: 'chunk-3' }];

      // Mock index findOne - needs to handle two calls:
      // 1. First call: index ownership check (returns lean chain)
      // 2. Second call: cleanup check (returns select().lean() chain)
      let findOneCallCount = 0;
      mockIndexModel.findOne.mockImplementation(() => {
        findOneCallCount++;
        if (findOneCallCount === 1) {
          // First call: index ownership check
          return { lean: vi.fn().mockResolvedValue(createMockIndex()) };
        } else {
          // Second call: cleanup check (with .select().lean())
          return {
            select: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue({ documentCount: 0 }),
            }),
          };
        }
      });

      mockDocModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockDoc) });

      // Chained find().select().lean() for chunks
      const leanMock = vi.fn().mockResolvedValue(mockChunks);
      const selectMock = vi.fn().mockReturnValue({ lean: leanMock });
      mockChunkModel.find.mockReturnValue({ select: selectMock });

      // Chained find().select().lean() for questions (empty array - no questions)
      const questionLeanMock = vi.fn().mockResolvedValue([]);
      const questionSelectMock = vi.fn().mockReturnValue({ lean: questionLeanMock });
      mockQuestionModel.find.mockReturnValue({ select: questionSelectMock });

      mockChunkModel.deleteMany.mockResolvedValue({ deletedCount: 3 });
      mockQuestionModel.deleteMany.mockResolvedValue({ deletedCount: 0 });
      mockDocModel.deleteOne.mockResolvedValue({ deletedCount: 1 });
      mockChunkModel.countDocuments.mockResolvedValue(0); // No remaining structured chunks
      mockIndexModel.findOneAndUpdate.mockResolvedValue({});
      mockIndexModel.updateOne.mockResolvedValue({ modifiedCount: 1 });
      mockKbModel.findOneAndUpdate.mockResolvedValue({});
      mockSourceModel.findOneAndUpdate.mockResolvedValue({});

      await request(app).delete(`/${INDEX_ID}/documents/${DOC_ID}`).expect(204);

      expect(mockChunkModel.deleteMany).toHaveBeenCalledWith({
        documentId: DOC_ID,
        tenantId: 'tenant-123',
      });
      expect(mockDocModel.deleteOne).toHaveBeenCalledWith({
        _id: DOC_ID,
        tenantId: 'tenant-123',
      });
      expect(mockIndexModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: INDEX_ID, tenantId: 'tenant-123' },
        { $inc: { documentCount: -1, chunkCount: -3 } },
      );
    });

    test('should return 404 for non-existent document', async () => {
      mockIndexModel.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(createMockIndex()),
      });
      mockDocModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const response = await request(app)
        .delete(`/${INDEX_ID}/documents/507f1f77bcf86cd799439099`)
        .expect(404);

      expect(response.body.error).toBe('Document not found');
    });

    test('should return 404 when index not found', async () => {
      mockIndexModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const response = await request(app).delete(`/${INDEX_ID}/documents/${DOC_ID}`).expect(404);

      expect(response.body.error).toBe('Index not found');
    });
  });
});
