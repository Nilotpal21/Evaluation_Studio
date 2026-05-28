/**
 * Knowledge Base Routes Tests
 *
 * Integration tests for knowledge base CRUD API endpoints.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

// Mock dependencies before imports
let mockRegisterSearchAITool: any = vi.fn().mockResolvedValue(undefined);
let mockUnregisterSearchAITool: any = vi.fn().mockResolvedValue(undefined);
let mockCreateDefaultPipeline: any = vi.fn().mockReturnValue({ name: 'default' });
let mockDeleteDocumentsWithVectorCleanup: any = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db/index.js', () => {
  const models: Record<string, any> = {
    KnowledgeBase: {
      find: vi.fn(),
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
      findOneAndDelete: vi.fn(),
      countDocuments: vi.fn(),
      create: vi.fn(),
    },
    SearchIndex: {
      find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
      findOneAndDelete: vi.fn(),
      create: vi.fn(),
    },
    SearchSource: {
      find: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
      countDocuments: vi.fn(),
      aggregate: vi.fn(),
    },
    SearchDocument: {
      find: vi.fn(),
      distinct: vi.fn(),
      deleteMany: vi.fn(),
      countDocuments: vi.fn(),
      aggregate: vi.fn(),
    },
    SearchChunk: {
      deleteMany: vi.fn(),
      countDocuments: vi.fn(),
    },
    SearchPipelineDefinition: {
      create: vi.fn(),
    },
    CanonicalSchema: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  };

  return {
    getLazyModel: vi.fn((modelName: string) => models[modelName] || {}),
  };
});

vi.mock('../../services/searchai-tool-registration.js', () => ({
  registerSearchAITool: (...args: any[]) => mockRegisterSearchAITool(...args),
  unregisterSearchAITool: (...args: any[]) => mockUnregisterSearchAITool(...args),
}));

vi.mock('../../services/pipeline-orchestration/index.js', () => ({
  createDefaultPipeline: (...args: any[]) => mockCreateDefaultPipeline(...args),
}));

vi.mock('@agent-platform/shared-kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared-kernel')>();
  return {
    ...actual,
    slugify: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
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

vi.mock('../../services/llm-config/resolver.js', () => ({
  resolveIndexLLMConfig: vi.fn().mockResolvedValue({ provider: 'openai' }),
}));

vi.mock('../../services/mapping-suggestion/index.js', () => ({
  mappingSuggestionService: {
    getCircuitBreakerStatus: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../services/document-cleanup.service.js', () => ({
  deleteDocumentsWithVectorCleanup: (...args: any[]) =>
    mockDeleteDocumentsWithVectorCleanup(...args),
}));

// Import after mocks
import { getLazyModel } from '../../db/index.js';
import knowledgeBasesRouter from '../knowledge-bases.js';

describe('Knowledge Base Routes', () => {
  let app: Express;
  let mockKBModel: any;
  let mockIndexModel: any;
  let mockSourceModel: any;
  let mockDocModel: any;
  let mockChunkModel: any;
  let mockPipelineModel: any;
  let mockCanonicalSchemaModel: any;

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
    mockRegisterSearchAITool = vi.fn().mockResolvedValue(undefined);
    mockUnregisterSearchAITool = vi.fn().mockResolvedValue(undefined);
    mockCreateDefaultPipeline = vi.fn().mockReturnValue({ name: 'default' });
    mockDeleteDocumentsWithVectorCleanup = vi.fn().mockResolvedValue(undefined);

    app = express();
    app.use(express.json());
    app.use(authMiddleware);
    app.use(knowledgeBasesRouter);

    mockKBModel = getLazyModel('KnowledgeBase') as any;
    mockIndexModel = getLazyModel('SearchIndex') as any;
    mockSourceModel = getLazyModel('SearchSource') as any;
    mockDocModel = getLazyModel('SearchDocument') as any;
    mockChunkModel = getLazyModel('SearchChunk') as any;
    mockPipelineModel = getLazyModel('SearchPipelineDefinition') as any;
    mockCanonicalSchemaModel = getLazyModel('CanonicalSchema') as any;

    vi.clearAllMocks();
    delete mockTenantContext.projectId;
    delete mockTenantContext.projectScope;
    mockCanonicalSchemaModel.create.mockResolvedValue({ _id: 'schema-123' });
    mockCanonicalSchemaModel.deleteMany.mockResolvedValue({ deletedCount: 1 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    // Default aggregate mocks (route enriches KB list with source/doc counts)
    mockSourceModel.aggregate.mockResolvedValue([]);
    mockDocModel.aggregate.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  const createMockKB = (overrides: Record<string, unknown> = {}) => ({
    _id: '507f1f77bcf86cd799439011',
    tenantId: 'tenant-123',
    projectId: 'project-456',
    name: 'Test KB',
    description: 'A test knowledge base',
    searchIndexId: '507f1f77bcf86cd799439022',
    status: 'active',
    createdBy: 'user-456',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    ...overrides,
  });

  const createMockIndex = (overrides: Record<string, unknown> = {}) => ({
    _id: '507f1f77bcf86cd799439022',
    tenantId: 'tenant-123',
    projectId: 'project-456',
    slug: 'test-kb',
    name: 'Test KB Index',
    status: 'active',
    embeddingModel: 'bge-m3',
    embeddingDimensions: 1024,
    ...overrides,
  });

  // ── GET / ────────────────────────────────────────────────────────────────

  describe('GET /', () => {
    test('should return list with total and pagination', async () => {
      const kbs = [createMockKB(), createMockKB({ _id: '507f1f77bcf86cd799439033', name: 'KB 2' })];

      // Mock chained find().sort().skip().limit().lean()
      const leanMock = vi.fn().mockResolvedValue(kbs);
      const limitMock = vi.fn().mockReturnValue({ lean: leanMock });
      const skipMock = vi.fn().mockReturnValue({ limit: limitMock });
      const sortMock = vi.fn().mockReturnValue({ skip: skipMock });
      mockKBModel.find.mockReturnValue({ sort: sortMock });
      mockKBModel.countDocuments.mockResolvedValue(2);

      const response = await request(app).get('/').expect(200);

      expect(response.body.knowledgeBases).toHaveLength(2);
      expect(response.body.total).toBe(2);
      expect(response.body.pagination).toMatchObject({
        limit: 50,
        offset: 0,
        hasMore: false,
      });
    });

    test('should filter by projectId', async () => {
      const leanMock = vi.fn().mockResolvedValue([]);
      const limitMock = vi.fn().mockReturnValue({ lean: leanMock });
      const skipMock = vi.fn().mockReturnValue({ limit: limitMock });
      const sortMock = vi.fn().mockReturnValue({ skip: skipMock });
      mockKBModel.find.mockReturnValue({ sort: sortMock });
      mockKBModel.countDocuments.mockResolvedValue(0);

      await request(app).get('/?projectId=project-456').expect(200);

      expect(mockKBModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-456' }),
      );
    });

    test('should filter by search (regex on name)', async () => {
      const leanMock = vi.fn().mockResolvedValue([]);
      const limitMock = vi.fn().mockReturnValue({ lean: leanMock });
      const skipMock = vi.fn().mockReturnValue({ limit: limitMock });
      const sortMock = vi.fn().mockReturnValue({ skip: skipMock });
      mockKBModel.find.mockReturnValue({ sort: sortMock });
      mockKBModel.countDocuments.mockResolvedValue(0);

      await request(app).get('/?search=Test').expect(200);

      expect(mockKBModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          name: { $regex: 'Test', $options: 'i' },
        }),
      );
    });

    test('should sort by allowed fields', async () => {
      const leanMock = vi.fn().mockResolvedValue([]);
      const limitMock = vi.fn().mockReturnValue({ lean: leanMock });
      const skipMock = vi.fn().mockReturnValue({ limit: limitMock });
      const sortMock = vi.fn().mockReturnValue({ skip: skipMock });
      mockKBModel.find.mockReturnValue({ sort: sortMock });
      mockKBModel.countDocuments.mockResolvedValue(0);

      await request(app).get('/?sortBy=name&sortOrder=asc').expect(200);

      expect(sortMock).toHaveBeenCalledWith({ name: 1 });
    });

    test('should respect limit and offset', async () => {
      const leanMock = vi.fn().mockResolvedValue([createMockKB()]);
      const limitMock = vi.fn().mockReturnValue({ lean: leanMock });
      const skipMock = vi.fn().mockReturnValue({ limit: limitMock });
      const sortMock = vi.fn().mockReturnValue({ skip: skipMock });
      mockKBModel.find.mockReturnValue({ sort: sortMock });
      mockKBModel.countDocuments.mockResolvedValue(5);

      const response = await request(app).get('/?limit=1&offset=2').expect(200);

      expect(skipMock).toHaveBeenCalledWith(2);
      expect(limitMock).toHaveBeenCalledWith(1);
      expect(response.body.pagination).toMatchObject({
        limit: 1,
        offset: 2,
        hasMore: true,
      });
    });
  });

  // ── POST / ───────────────────────────────────────────────────────────────

  describe('POST /', () => {
    test('should create KB + SearchIndex + register tool + seed pipeline', async () => {
      const mockIndex = createMockIndex();
      const mockKB = createMockKB();

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
      mockIndexModel.create.mockResolvedValue(mockIndex);
      mockKBModel.create.mockResolvedValue(mockKB);
      mockPipelineModel.create.mockResolvedValue({});

      const response = await request(app)
        .post('/')
        .send({ projectId: 'project-456', name: 'Test KB', description: 'A test KB' })
        .expect(201);

      expect(response.body.knowledgeBase).toMatchObject({ name: 'Test KB' });
      expect(mockIndexModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-123',
          projectId: 'project-456',
          name: 'Test KB Index',
          embeddingModel: 'bge-m3',
        }),
      );
      expect(mockRegisterSearchAITool).toHaveBeenCalled();
      expect(mockCreateDefaultPipeline).toHaveBeenCalled();
    });

    test('rejects KB creation outside API-key projectScope before creating SearchIndex', async () => {
      mockTenantContext.projectScope = ['project-123'];

      const response = await request(app)
        .post('/')
        .send({ projectId: 'project-456', name: 'Test KB', description: 'A test KB' });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(mockIndexModel.create).not.toHaveBeenCalled();
      expect(mockRegisterSearchAITool).not.toHaveBeenCalled();
    });

    test('waits for SearchAI tool registration before returning created KB', async () => {
      const mockIndex = createMockIndex();
      const mockKB = createMockKB();
      let resolveRegistration!: () => void;
      let settled = false;

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
      mockIndexModel.create.mockResolvedValue(mockIndex);
      mockKBModel.create.mockResolvedValue(mockKB);
      mockPipelineModel.create.mockResolvedValue({});
      mockRegisterSearchAITool = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveRegistration = resolve;
          }),
      );

      const pending = request(app)
        .post('/')
        .send({ projectId: 'project-456', name: 'Test KB', description: 'A test KB' })
        .then((response) => {
          settled = true;
          return response;
        });

      try {
        await vi.waitFor(() => expect(mockRegisterSearchAITool).toHaveBeenCalled());

        expect(settled).toBe(false);
        expect(mockKBModel.create).not.toHaveBeenCalled();
      } finally {
        resolveRegistration?.();
      }

      const response = await pending;

      expect(response.status).toBe(201);
      expect(settled).toBe(true);
      expect(mockKBModel.create).toHaveBeenCalled();
    });

    test('removes the just-created SearchIndex when generated tool registration fails', async () => {
      const mockIndex = createMockIndex();

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
      mockIndexModel.create.mockResolvedValue(mockIndex);
      mockIndexModel.findOneAndDelete.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockIndex),
      });
      mockRegisterSearchAITool = vi.fn().mockRejectedValue(new Error('registration failed'));

      const response = await request(app)
        .post('/')
        .send({ projectId: 'project-456', name: 'Test KB', description: 'A test KB' });

      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('CREATE_FAILED');
      expect(mockKBModel.create).not.toHaveBeenCalled();
      expect(mockIndexModel.findOneAndDelete).toHaveBeenCalledWith({
        _id: '507f1f77bcf86cd799439022',
        tenantId: 'tenant-123',
        projectId: 'project-456',
      });
      expect(mockCanonicalSchemaModel.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant-123',
        knowledgeBaseId: '507f1f77bcf86cd799439022',
      });
    });

    test('should reject missing projectId or name with 400', async () => {
      const response = await request(app).post('/').send({ name: 'Test' }).expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('MISSING_FIELDS');
    });

    test('should reject missing name with 400', async () => {
      await request(app).post('/').send({ projectId: 'project-456' }).expect(400);
    });

    test('should reject duplicate name with 409', async () => {
      mockKBModel.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(createMockKB()),
      });

      const response = await request(app)
        .post('/')
        .send({ projectId: 'project-456', name: 'Test KB' })
        .expect(409);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('DUPLICATE_NAME');
      expect(response.body.error.message).toContain('already exists');
    });
  });

  // ── GET /:kbId ───────────────────────────────────────────────────────────

  describe('GET /:kbId', () => {
    test('should return KB with nested index', async () => {
      const mockKB = createMockKB();
      const mockIndex = createMockIndex();

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockIndexModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockIndex) });
      mockDocModel.countDocuments.mockResolvedValue(5);
      mockChunkModel.countDocuments.mockResolvedValue(25);
      mockSourceModel.countDocuments.mockResolvedValue(2);

      const response = await request(app).get('/507f1f77bcf86cd799439011').expect(200);

      expect(response.body.knowledgeBase).toMatchObject({
        _id: '507f1f77bcf86cd799439011',
        name: 'Test KB',
      });
      expect(response.body.knowledgeBase.index).toMatchObject({
        _id: '507f1f77bcf86cd799439022',
      });
    });

    test('scopes linked SearchIndex lookup by projectScope and hides mismatched legacy links', async () => {
      mockTenantContext.projectScope = ['project-456'];
      const mockKB = createMockKB();

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockIndexModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const response = await request(app).get('/507f1f77bcf86cd799439011').expect(200);

      expect(mockIndexModel.findOne).toHaveBeenCalledWith({
        _id: '507f1f77bcf86cd799439022',
        tenantId: 'tenant-123',
        projectId: { $in: ['project-456'] },
      });
      expect(response.body.knowledgeBase.index).toBeNull();
    });

    test('should return 404 for non-existent KB', async () => {
      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const response = await request(app).get('/507f1f77bcf86cd799439099').expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    test('should return 404 for wrong tenant (isolation)', async () => {
      // The mock already scopes by tenantId, so non-existent = null
      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const response = await request(app).get('/507f1f77bcf86cd799439011').expect(404);

      // Verify findOne was called with tenantId
      expect(mockKBModel.findOne).toHaveBeenCalledWith({
        _id: '507f1f77bcf86cd799439011',
        tenantId: 'tenant-123',
      });
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ── PATCH /:kbId ─────────────────────────────────────────────────────────

  describe('PATCH /:kbId', () => {
    test('should update and return updated KB', async () => {
      const updatedKB = createMockKB({ name: 'Updated Name' });

      mockKBModel.findOneAndUpdate.mockReturnValue({
        lean: vi.fn().mockResolvedValue(updatedKB),
      });

      const response = await request(app)
        .patch('/507f1f77bcf86cd799439011')
        .send({ name: 'Updated Name' })
        .expect(200);

      expect(response.body.knowledgeBase.name).toBe('Updated Name');
      expect(mockKBModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: '507f1f77bcf86cd799439011', tenantId: 'tenant-123' },
        { $set: { name: 'Updated Name' } },
        { new: true, runValidators: true },
      );
    });

    test('should return 404 for wrong tenant', async () => {
      mockKBModel.findOneAndUpdate.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      const response = await request(app)
        .patch('/507f1f77bcf86cd799439011')
        .send({ name: 'Updated' })
        .expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ── DELETE /:kbId ────────────────────────────────────────────────────────

  describe('DELETE /:kbId', () => {
    test('should delete KB + sources + documents + chunks + index', async () => {
      const mockKB = createMockKB();
      const mockSources = [{ _id: 'source-1' }, { _id: 'source-2' }];
      const mockDocIds = ['doc-1', 'doc-2'];
      const mockDeletedIndex = createMockIndex({ slug: 'test-kb', projectId: 'project-456' });

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockIndexModel.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockDeletedIndex),
      });
      mockSourceModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockSources) });
      mockDocModel.distinct.mockResolvedValue(mockDocIds);
      mockChunkModel.deleteMany.mockResolvedValue({ deletedCount: 10 });
      mockDocModel.deleteMany.mockResolvedValue({ deletedCount: 2 });
      mockSourceModel.deleteMany.mockResolvedValue({ deletedCount: 2 });
      mockIndexModel.findOneAndDelete.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockDeletedIndex),
      });
      mockKBModel.findOneAndDelete.mockResolvedValue({});

      const response = await request(app).delete('/507f1f77bcf86cd799439011').expect(200);

      expect(response.body).toMatchObject({ deleted: true, kbId: '507f1f77bcf86cd799439011' });
      expect(mockDocModel.distinct).toHaveBeenCalledWith('_id', {
        sourceId: { $in: ['source-1', 'source-2'] },
        tenantId: 'tenant-123',
      });
      // Now uses deleteDocumentsWithVectorCleanup service instead of direct deleteMany
      expect(mockDeleteDocumentsWithVectorCleanup).toHaveBeenCalledWith(
        ['doc-1', 'doc-2'],
        'tenant-123',
        '507f1f77bcf86cd799439022',
      );
      expect(mockSourceModel.deleteMany).toHaveBeenCalledWith({
        indexId: '507f1f77bcf86cd799439022',
        tenantId: 'tenant-123',
      });
      expect(mockUnregisterSearchAITool).toHaveBeenCalled();
    });

    test('awaits generated tool unregister and runtime cache invalidation before delete returns', async () => {
      const mockKB = createMockKB();
      const mockDeletedIndex = createMockIndex({ slug: 'test-kb', projectId: 'project-456' });
      let resolveUnregister!: () => void;
      let settled = false;

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockIndexModel.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockDeletedIndex),
      });
      mockSourceModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
      mockSourceModel.deleteMany.mockResolvedValue({ deletedCount: 0 });
      mockIndexModel.findOneAndDelete.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockDeletedIndex),
      });
      mockKBModel.findOneAndDelete.mockResolvedValue({});
      mockUnregisterSearchAITool = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveUnregister = resolve;
          }),
      );

      const pending = request(app)
        .delete('/507f1f77bcf86cd799439011')
        .then((response) => {
          settled = true;
          return response;
        });

      try {
        await vi.waitFor(() => expect(mockUnregisterSearchAITool).toHaveBeenCalled());
        expect(settled).toBe(false);
      } finally {
        resolveUnregister?.();
      }

      const response = await pending;

      expect(response.status).toBe(200);
      expect(settled).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/internal/invalidate-pipeline-cache'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            indexId: '507f1f77bcf86cd799439022',
            tenantId: 'tenant-123',
          }),
        }),
      );
    });

    test('does not delete KB or index when generated tool unregister fails', async () => {
      const mockKB = createMockKB();
      const mockIndex = createMockIndex({ slug: 'test-kb', projectId: 'project-456' });

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockIndexModel.findOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockIndex),
      });
      mockUnregisterSearchAITool = vi.fn().mockRejectedValue(new Error('tool unregister failed'));

      const response = await request(app).delete('/507f1f77bcf86cd799439011').expect(500);

      expect(response.body.error.code).toBe('DELETE_FAILED');
      expect(mockSourceModel.deleteMany).not.toHaveBeenCalled();
      expect(mockIndexModel.findOneAndDelete).not.toHaveBeenCalled();
      expect(mockKBModel.findOneAndDelete).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    test('should return 404 for non-existent KB', async () => {
      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const response = await request(app).delete('/507f1f77bcf86cd799439099').expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ── POST /:kbId/rebuild ──────────────────────────────────────────────────

  describe('POST /:kbId/rebuild', () => {
    test('should return 501 not implemented', async () => {
      const response = await request(app).post('/507f1f77bcf86cd799439011/rebuild').expect(501);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: 'NOT_IMPLEMENTED', message: 'Rebuild is not yet implemented' },
      });
    });
  });
});
