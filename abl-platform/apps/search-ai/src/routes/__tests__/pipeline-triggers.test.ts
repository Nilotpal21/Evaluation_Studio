/**
 * Pipeline Trigger Routes Tests
 *
 * Integration tests for pipeline trigger API endpoints.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

// Store mock functions that can be controlled from tests
let mockBuildFlow: any = vi.fn();
let mockSafeAddFlow: any = vi.fn();
let mockCheckBackpressure: any = vi.fn();

// Mock dependencies
vi.mock('../../db/index.js', () => {
  class MockSearchPipelineDefinition {
    constructor(data: any) {
      Object.assign(this, data);
    }
  }
  (MockSearchPipelineDefinition as any).findOne = vi.fn();

  const kbModel = { findOne: vi.fn() };
  const docModel = {
    findOne: vi.fn(),
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const sourceModel = { findOne: vi.fn() };
  const chunkModel = {
    find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
  };
  const questionModel = {
    find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
  };
  const pageModel = { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) };
  const indexModel = {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  };
  const canonicalSchemaModel = {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
  };
  const fieldMappingModel = {
    find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
  };

  return {
    getLazyModel: vi.fn((modelName: string) => {
      if (modelName === 'SearchPipelineDefinition') return MockSearchPipelineDefinition;
      if (modelName === 'KnowledgeBase') return kbModel;
      if (modelName === 'SearchDocument') return docModel;
      if (modelName === 'SearchSource') return sourceModel;
      if (modelName === 'SearchChunk') return chunkModel;
      if (modelName === 'ChunkQuestion') return questionModel;
      if (modelName === 'DocumentPage') return pageModel;
      if (modelName === 'SearchIndex') return indexModel;
      if (modelName === 'CanonicalSchema') return canonicalSchemaModel;
      if (modelName === 'FieldMapping') return fieldMappingModel;
      return {};
    }),
  };
});

vi.mock('@agent-platform/search-ai-internal', () => ({
  createVectorStore: vi.fn(() => ({
    delete: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  })),
}));

vi.mock('../../services/pipeline-orchestration/flow-builder.js', () => ({
  PipelineFlowBuilder: class {
    buildFlow: any;
    constructor() {
      this.buildFlow = (...args: any[]) => mockBuildFlow(...args);
    }
  },
  safeAddFlow: (...args: any[]) => mockSafeAddFlow(...args),
  checkBackpressure: (...args: any[]) => mockCheckBackpressure(...args),
}));

vi.mock('../../services/flow-selection/index.js', () => ({
  FlowSelectionService: class {
    selectFlow = vi.fn();
  },
}));

vi.mock('../../services/pipeline-orchestration/types.js', async () => {
  const actual = await vi.importActual<any>('../../services/pipeline-orchestration/types.js');
  return actual;
});

vi.mock('../../middleware/rate-limit.js', () => ({
  searchAiRateLimit: vi.fn(() => (req: any, res: any, next: any) => next()),
}));

vi.mock('../../workers/shared.js', () => ({
  getRedisConnection: vi.fn(() => ({})),
  createQueue: vi.fn(() => ({
    add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
    getJob: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
    getWaitingCount: vi.fn().mockResolvedValue(0),
  })),
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

vi.mock('../../services/ingestion/document-routing.js', () => ({
  routeDocument: vi.fn(() => 'docling'),
}));

vi.mock('bullmq', () => ({
  FlowProducer: class {
    close = vi.fn();
    add = vi.fn();
  },
  Queue: class {
    close = vi.fn();
    getJob = vi.fn();
    getWaitingCount = vi.fn().mockResolvedValue(0);
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/search-ai-sdk', () => ({
  QUEUE_EXTRACTION: 'search-extraction',
  QUEUE_DOCLING_EXTRACTION: 'search-docling-extraction',
  QUEUE_PAGE_PROCESSING: 'search-page-processing',
  QUEUE_ENRICHMENT: 'search-enrichment',
  QUEUE_EMBEDDING: 'search-embedding',
  QUEUE_MULTIMODAL: 'search-multimodal',
  QUEUE_TREE_BUILDING: 'search-tree-building',
  QUEUE_QUESTION_SYNTHESIS: 'search-question-synthesis',
  QUEUE_SCOPE_CLASSIFICATION: 'search-scope-classification',
}));

import { getLazyModel } from '../../db/index.js';
import pipelineTriggersRouter from '../pipeline-triggers.js';

describe('Pipeline Trigger Routes', () => {
  let app: Express;
  let mockPipelineModel: any;
  let mockKBModel: any;
  let mockDocModel: any;
  let mockSourceModel: any;

  const mockTenantContext = {
    tenantId: 'tenant-123',
    userId: 'user-456',
  } as any;

  const mockUser = { id: 'user-456', email: 'test@example.com' } as any;

  const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    req.tenantContext = mockTenantContext;
    req.user = mockUser;
    next();
  };

  beforeEach(() => {
    mockBuildFlow = vi.fn();
    mockSafeAddFlow = vi.fn();
    mockCheckBackpressure = vi.fn();

    app = express();
    app.use(express.json());
    app.use(authMiddleware);
    app.use(pipelineTriggersRouter);

    mockPipelineModel = (getLazyModel as any)('SearchPipelineDefinition');
    mockKBModel = (getLazyModel as any)('KnowledgeBase');
    mockDocModel = (getLazyModel as any)('SearchDocument');
    mockSourceModel = (getLazyModel as any)('SearchSource');

    vi.clearAllMocks();
    delete mockTenantContext.projectId;
    delete mockTenantContext.projectScope;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper to create mock KB
  const createMockKB = () => ({
    _id: 'kb-789',
    tenantId: 'tenant-123',
    projectId: 'project-456',
    searchIndexId: 'index-001',
    name: 'Test KB',
    status: 'active',
  });

  // Helper to create mock pipeline
  const createMockPipeline = () => ({
    _id: 'pipeline-123',
    tenantId: 'tenant-123',
    knowledgeBaseId: 'kb-789',
    name: 'Test Pipeline',
    version: 2,
    status: 'active',
    flows: [
      {
        id: 'flow-001',
        name: 'default-flow',
        enabled: true,
        priority: 10,
        stages: [
          { id: 'stage-001', type: 'extraction', providerId: 'docling', config: {}, order: 0 },
        ],
        selectionRules: [],
      },
    ],
  });

  // Helper to create mock document
  const createMockDocument = (id = 'doc-001') => ({
    _id: id,
    tenantId: 'tenant-123',
    sourceId: 'source-001',
    indexId: 'index-001',
    contentType: 'application/pdf',
    originalReference: 'test.pdf',
    status: 'pending',
  });

  describe('POST /api/projects/:projectId/knowledge-bases/:kbId/documents/:docId/trigger-pipeline', () => {
    test('should trigger pipeline for a single document', async () => {
      const mockKB = createMockKB();
      const mockPipeline = createMockPipeline();
      const mockDoc = createMockDocument();

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockPipeline) });
      mockDocModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockDoc) });

      mockBuildFlow.mockResolvedValue({
        success: true,
        flow: { name: 'doc-001-default-flow', queueName: 'search-extraction', data: {} },
        details: { pipelineId: 'pipeline-123', stageCount: 1, queueNames: ['search-extraction'] },
      });

      mockSafeAddFlow.mockResolvedValue({ job: { id: 'flow-job-001' } });

      const response = await request(app)
        .post('/api/projects/project-456/knowledge-bases/kb-789/documents/doc-001/trigger-pipeline')
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        flowJobId: 'flow-job-001',
        documentId: 'doc-001',
        pipelineId: 'pipeline-123',
        pipelineVersion: 2,
      });

      expect(mockBuildFlow).toHaveBeenCalledWith(
        mockPipeline,
        expect.objectContaining({
          documentId: 'doc-001',
          tenantId: 'tenant-123',
        }),
      );
      expect(mockDocModel.findOne).toHaveBeenCalledWith({
        _id: 'doc-001',
        tenantId: 'tenant-123',
        indexId: 'index-001',
      });
    });

    test('should return 401 without tenant context', async () => {
      const appNoAuth = express();
      appNoAuth.use(express.json());
      appNoAuth.use(pipelineTriggersRouter);

      const response = await request(appNoAuth)
        .post('/api/projects/project-456/knowledge-bases/kb-789/documents/doc-001/trigger-pipeline')
        .expect(401);

      expect(response.body).toMatchObject({ error: 'Tenant context required' });
    });

    test('should return 404 when knowledge base not found', async () => {
      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const response = await request(app)
        .post('/api/projects/project-456/knowledge-bases/kb-789/documents/doc-001/trigger-pipeline')
        .expect(404);

      expect(response.body).toMatchObject({ error: 'Knowledge base not found' });
    });

    test('should return 404 when API key projectScope excludes requested project', async () => {
      mockTenantContext.projectScope = ['project-other'];

      const response = await request(app)
        .post('/api/projects/project-456/knowledge-bases/kb-789/documents/doc-001/trigger-pipeline')
        .expect(404);

      expect(response.body).toMatchObject({ error: 'Knowledge base not found' });
      expect(mockKBModel.findOne).not.toHaveBeenCalled();
    });

    test('should return 400 when no active pipeline', async () => {
      const mockKB = createMockKB();

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const response = await request(app)
        .post('/api/projects/project-456/knowledge-bases/kb-789/documents/doc-001/trigger-pipeline')
        .expect(400);

      expect(response.body).toMatchObject({
        error: 'No active pipeline found for this knowledge base',
      });
    });

    test('should return 404 when document not found', async () => {
      const mockKB = createMockKB();
      const mockPipeline = createMockPipeline();

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockPipeline) });
      mockDocModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const response = await request(app)
        .post('/api/projects/project-456/knowledge-bases/kb-789/documents/doc-001/trigger-pipeline')
        .expect(404);

      expect(response.body).toMatchObject({ error: 'Document not found' });
    });

    test('should return 503 on backpressure', async () => {
      const { BackpressureError } = await import('../../services/pipeline-orchestration/types.js');

      const mockKB = createMockKB();
      const mockPipeline = createMockPipeline();
      const mockDoc = createMockDocument();

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockPipeline) });
      mockDocModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockDoc) });

      mockBuildFlow.mockResolvedValue({
        success: true,
        flow: { name: 'test', queueName: 'search-extraction', data: {} },
        details: { pipelineId: 'pipeline-123', stageCount: 1, queueNames: [] },
      });

      mockCheckBackpressure.mockRejectedValue(
        new BackpressureError('Queue depth exceeded', 'search-extraction', 500, 300, 30000),
      );

      const response = await request(app)
        .post('/api/projects/project-456/knowledge-bases/kb-789/documents/doc-001/trigger-pipeline')
        .expect(503);

      expect(response.body).toMatchObject({
        error: 'Service temporarily unavailable - queue capacity exceeded',
        retryAfterMs: 30000,
      });
    });
  });

  describe('POST /api/projects/:projectId/knowledge-bases/:kbId/sources/:sourceId/trigger-pipeline', () => {
    test('should trigger pipeline for all documents in source', async () => {
      const mockKB = createMockKB();
      const mockPipeline = createMockPipeline();
      const mockSource = { _id: 'source-001', tenantId: 'tenant-123', name: 'Test Source' };
      const mockDocs = [createMockDocument('doc-001'), createMockDocument('doc-002')];

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockPipeline) });
      mockSourceModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockSource) });
      mockDocModel.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue(mockDocs),
          }),
        }),
      });

      mockBuildFlow.mockResolvedValue({
        success: true,
        flow: { name: 'test', queueName: 'search-extraction', data: {} },
        details: { pipelineId: 'pipeline-123', stageCount: 1, queueNames: [] },
      });

      mockSafeAddFlow.mockResolvedValue({ job: { id: 'flow-job-001' } });

      const response = await request(app)
        .post(
          '/api/projects/project-456/knowledge-bases/kb-789/sources/source-001/trigger-pipeline',
        )
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        triggeredCount: 2,
        totalDocuments: 2,
        pipelineId: 'pipeline-123',
        pipelineVersion: 2,
      });

      expect(response.body.flowJobIds).toHaveLength(2);
      expect(mockSourceModel.findOne).toHaveBeenCalledWith({
        _id: 'source-001',
        tenantId: 'tenant-123',
        indexId: 'index-001',
      });
      expect(mockDocModel.find).toHaveBeenCalledWith({
        sourceId: 'source-001',
        tenantId: 'tenant-123',
        indexId: 'index-001',
        isDeleted: { $ne: true },
      });
    });

    test('should return empty result when no documents in source', async () => {
      const mockKB = createMockKB();
      const mockPipeline = createMockPipeline();
      const mockSource = { _id: 'source-001', tenantId: 'tenant-123' };

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockPipeline) });
      mockSourceModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockSource) });
      mockDocModel.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const response = await request(app)
        .post(
          '/api/projects/project-456/knowledge-bases/kb-789/sources/source-001/trigger-pipeline',
        )
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        triggeredCount: 0,
        flowJobIds: [],
      });
    });

    test('should return 404 when source not found', async () => {
      const mockKB = createMockKB();
      const mockPipeline = createMockPipeline();

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockPipeline) });
      mockSourceModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const response = await request(app)
        .post(
          '/api/projects/project-456/knowledge-bases/kb-789/sources/source-001/trigger-pipeline',
        )
        .expect(404);

      expect(response.body).toMatchObject({ error: 'Source not found' });
    });
  });

  describe('POST /api/projects/:projectId/knowledge-bases/:kbId/trigger-pipeline', () => {
    test('should trigger pipeline for entire knowledge base', async () => {
      const mockKB = createMockKB();
      const mockPipeline = createMockPipeline();
      const mockDocs = [
        createMockDocument('doc-001'),
        createMockDocument('doc-002'),
        createMockDocument('doc-003'),
      ];

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockPipeline) });
      mockDocModel.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue(mockDocs),
          }),
        }),
      });

      mockBuildFlow.mockResolvedValue({
        success: true,
        flow: { name: 'test', queueName: 'search-extraction', data: {} },
        details: { pipelineId: 'pipeline-123', stageCount: 1, queueNames: [] },
      });

      mockSafeAddFlow.mockResolvedValue({ job: { id: 'flow-job-001' } });

      const response = await request(app)
        .post('/api/projects/project-456/knowledge-bases/kb-789/trigger-pipeline')
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        triggeredCount: 3,
        totalDocuments: 3,
        pipelineId: 'pipeline-123',
        pipelineVersion: 2,
      });

      expect(response.body.batchId).toMatch(/^batch-kb-789-/);
      expect(response.body.flowJobIds).toHaveLength(3);
      expect(mockDocModel.find).toHaveBeenCalledWith({
        tenantId: 'tenant-123',
        indexId: 'index-001',
        isDeleted: { $ne: true },
      });
    });

    test('should return empty result when no documents in KB', async () => {
      const mockKB = createMockKB();
      const mockPipeline = createMockPipeline();

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockPipeline) });
      mockDocModel.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const response = await request(app)
        .post('/api/projects/project-456/knowledge-bases/kb-789/trigger-pipeline')
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        triggeredCount: 0,
        totalDocuments: 0,
      });
    });

    test('should return 400 when no active pipeline', async () => {
      const mockKB = createMockKB();

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const response = await request(app)
        .post('/api/projects/project-456/knowledge-bases/kb-789/trigger-pipeline')
        .expect(400);

      expect(response.body).toMatchObject({
        error: 'No active pipeline found for this knowledge base',
      });
    });
  });

  describe('POST /api/projects/:projectId/knowledge-bases/:kbId/documents/bulk-reprocess', () => {
    test('should only load documents from the verified KB search index', async () => {
      const mockKB = createMockKB();
      const mockPipeline = createMockPipeline();
      const mockDocs = [createMockDocument('doc-001'), createMockDocument('doc-002')];

      mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
      mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockPipeline) });
      mockDocModel.find.mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockDocs),
        }),
      });
      mockBuildFlow.mockResolvedValue({
        success: true,
        flow: { name: 'test', queueName: 'search-extraction', data: {} },
        details: { pipelineId: 'pipeline-123', stageCount: 1, queueNames: [] },
      });
      mockSafeAddFlow.mockResolvedValue({ job: { id: 'flow-job-001' } });

      const response = await request(app)
        .post('/api/projects/project-456/knowledge-bases/kb-789/documents/bulk-reprocess')
        .send({ documentIds: ['doc-001', 'doc-002'] })
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        totalRequested: 2,
        totalFound: 2,
      });
      expect(mockDocModel.find).toHaveBeenCalledWith({
        _id: { $in: ['doc-001', 'doc-002'] },
        tenantId: 'tenant-123',
        indexId: 'index-001',
        isDeleted: { $ne: true },
      });
    });
  });
});
