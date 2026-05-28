/**
 * Health Summary Route Tests
 *
 * Tests for GET /:kbId/health-summary endpoint.
 * Uses forks pool due to supertest HTTP server lifecycle.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

// ── Mock dependencies before imports ──────────────────────────────────────

let mockResolveIndexLLMConfig: any = vi.fn();
let mockGetCircuitBreakerStatus: any = vi.fn();
let mockHasTenantModelsConfigured: any = vi.fn();

vi.mock('../../db/index.js', () => {
  const models: Record<string, any> = {
    KnowledgeBase: {
      findOne: vi.fn(),
    },
    SearchIndex: {},
    SearchSource: {
      find: vi.fn(),
    },
    SearchDocument: {
      aggregate: vi.fn(),
    },
    SearchChunk: {},
    SearchPipelineDefinition: {
      findOne: vi.fn(),
    },
    ConnectorConfig: {
      find: vi.fn(),
    },
  };

  return {
    getLazyModel: vi.fn((modelName: string) => models[modelName] || {}),
  };
});

vi.mock('../../services/searchai-tool-registration.js', () => ({
  registerSearchAITool: vi.fn().mockResolvedValue(undefined),
  unregisterSearchAITool: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/pipeline-orchestration/index.js', () => ({
  createDefaultPipeline: vi.fn().mockReturnValue({ name: 'default' }),
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
  resolveIndexLLMConfig: (...args: any[]) => mockResolveIndexLLMConfig(...args),
}));

vi.mock('../../services/llm-config/tenant-model-adapter.js', () => ({
  hasTenantModelsConfigured: (...args: any[]) => mockHasTenantModelsConfigured(...args),
}));

vi.mock('../../services/mapping-suggestion/index.js', () => ({
  mappingSuggestionService: {
    getCircuitBreakerStatus: (...args: any[]) => mockGetCircuitBreakerStatus(...args),
  },
}));

// Import after mocks
import { getLazyModel } from '../../db/index.js';
import knowledgeBasesRouter from '../knowledge-bases.js';

describe('GET /:kbId/health-summary', () => {
  let app: Express;
  let mockKBModel: any;
  let mockSourceModel: any;
  let mockDocModel: any;
  let mockPipelineModel: any;
  let mockConnectorModel: any;

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
    mockResolveIndexLLMConfig = vi.fn();
    mockGetCircuitBreakerStatus = vi.fn();
    mockHasTenantModelsConfigured = vi.fn().mockResolvedValue(false);

    app = express();
    app.use(express.json());
    app.use(authMiddleware);
    app.use(knowledgeBasesRouter);

    mockKBModel = getLazyModel('KnowledgeBase') as any;
    mockSourceModel = getLazyModel('SearchSource') as any;
    mockDocModel = getLazyModel('SearchDocument') as any;
    mockPipelineModel = getLazyModel('SearchPipelineDefinition') as any;
    mockConnectorModel = getLazyModel('ConnectorConfig') as any;

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  const createMockKB = (overrides: Record<string, unknown> = {}) => ({
    _id: 'kb-001',
    tenantId: 'tenant-123',
    projectId: 'project-456',
    name: 'Test KB',
    searchIndexId: 'idx-001',
    status: 'active',
    ...overrides,
  });

  const createMockSource = (overrides: Record<string, unknown> = {}) => ({
    _id: 'source-001',
    tenantId: 'tenant-123',
    indexId: 'idx-001',
    name: 'SharePoint Docs',
    ...overrides,
  });

  const createMockConnector = (overrides: Record<string, unknown> = {}) => ({
    _id: 'conn-001',
    tenantId: 'tenant-123',
    sourceId: 'source-001',
    syncState: {
      syncInProgress: false,
      lastSyncError: null,
      lastFullSyncAt: '2026-01-15T00:00:00.000Z',
      lastDeltaSyncAt: null,
    },
    ...overrides,
  });

  // ── Tests ───────────────────────────────────────────────────────────────

  test('happy path: returns full health summary', async () => {
    const mockKB = createMockKB();
    const mockSources = [
      createMockSource(),
      createMockSource({ _id: 'source-002', name: 'Jira Issues' }),
    ];
    const mockConnectors = [
      createMockConnector(),
      createMockConnector({
        _id: 'conn-002',
        sourceId: 'source-002',
        syncState: {
          syncInProgress: true,
          lastSyncError: null,
          lastFullSyncAt: null,
          lastDeltaSyncAt: null,
        },
      }),
    ];
    const mockPipeline = {
      validationStatus: 'valid',
      validationErrors: [],
    };

    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
    mockSourceModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockSources) });
    mockConnectorModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockConnectors) });
    mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockPipeline) });
    mockDocModel.aggregate.mockResolvedValue([{ _id: null, total: 42, errored: 2, processing: 5 }]);

    mockResolveIndexLLMConfig.mockResolvedValue({ provider: 'anthropic' });
    mockGetCircuitBreakerStatus.mockResolvedValue({
      state: 'CLOSED',
      failureRate: 0,
      provider: 'anthropic',
    });

    const response = await request(app).get('/kb-001/health-summary').expect(200);

    expect(response.body.data).toMatchObject({
      sources: {
        total: 2,
        syncing: 1,
        errors: [],
      },
      pipeline: {
        status: 'valid',
        errors: [],
      },
      circuitBreaker: {
        state: 'CLOSED',
        failureRate: 0,
        provider: 'anthropic',
      },
      documents: {
        total: 42,
        errored: 2,
        processing: 5,
      },
    });
  });

  test('returns 404 for non-existent KB', async () => {
    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

    const response = await request(app).get('/kb-nonexistent/health-summary').expect(404);

    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(mockKBModel.findOne).toHaveBeenCalledWith({
      _id: 'kb-nonexistent',
      tenantId: 'tenant-123',
    });
  });

  test('returns empty sources when no connectors exist', async () => {
    const mockKB = createMockKB();

    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
    mockSourceModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    mockConnectorModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
    // No sources → no doc aggregation (Promise.resolve([]))

    mockResolveIndexLLMConfig.mockResolvedValue({ provider: 'anthropic' });
    mockGetCircuitBreakerStatus.mockResolvedValue(null);

    const response = await request(app).get('/kb-001/health-summary').expect(200);

    expect(response.body.data.sources).toMatchObject({
      total: 0,
      syncing: 0,
      errors: [],
    });
    expect(response.body.data.documents).toMatchObject({
      total: 0,
      errored: 0,
      processing: 0,
    });
  });

  test('returns not_configured when pipeline does not exist', async () => {
    const mockKB = createMockKB();

    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
    mockSourceModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    mockConnectorModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

    mockResolveIndexLLMConfig.mockResolvedValue({ provider: 'openai' });
    mockGetCircuitBreakerStatus.mockResolvedValue(null);

    const response = await request(app).get('/kb-001/health-summary').expect(200);

    expect(response.body.data.pipeline).toMatchObject({
      status: 'not-configured',
      errors: [],
    });
  });

  test('returns null circuitBreaker when resolver throws', async () => {
    const mockKB = createMockKB();

    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
    mockSourceModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    mockConnectorModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

    mockResolveIndexLLMConfig.mockRejectedValue(new Error('LLM config not available'));

    const response = await request(app).get('/kb-001/health-summary').expect(200);

    expect(response.body.data.circuitBreaker).toBeNull();
  });

  test('includes source errors with sourceId and error details', async () => {
    const mockKB = createMockKB();
    const mockSources = [createMockSource()];
    const mockConnectors = [
      createMockConnector({
        sourceId: 'source-001',
        syncState: {
          syncInProgress: false,
          lastSyncError: 'Auth token expired',
          lastFullSyncAt: '2026-01-10T00:00:00.000Z',
          lastDeltaSyncAt: null,
        },
      }),
    ];

    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
    mockSourceModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockSources) });
    mockConnectorModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockConnectors) });
    mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
    mockDocModel.aggregate.mockResolvedValue([]);

    mockResolveIndexLLMConfig.mockResolvedValue({ provider: 'anthropic' });
    mockGetCircuitBreakerStatus.mockResolvedValue(null);

    const response = await request(app).get('/kb-001/health-summary').expect(200);

    expect(response.body.data.sources.errors).toHaveLength(1);
    expect(response.body.data.sources.errors[0]).toMatchObject({
      sourceId: 'source-001',
      error: 'Auth token expired',
      lastSyncAt: '2026-01-10T00:00:00.000Z',
    });
  });

  test('pipeline with validation errors returns them', async () => {
    const mockKB = createMockKB();
    const mockPipeline = {
      validationStatus: 'invalid',
      validationErrors: [
        {
          code: 'MISSING_EMBEDDING',
          message: 'No embedding stage configured',
          severity: 'error',
          path: 'flows[0].stages',
        },
      ],
    };

    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
    mockSourceModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    mockConnectorModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockPipeline) });

    mockResolveIndexLLMConfig.mockResolvedValue({ provider: 'anthropic' });
    mockGetCircuitBreakerStatus.mockResolvedValue(null);

    const response = await request(app).get('/kb-001/health-summary').expect(200);

    expect(response.body.data.pipeline).toMatchObject({
      status: 'invalid',
      errors: [
        {
          code: 'MISSING_EMBEDDING',
          message: 'No embedding stage configured',
          severity: 'error',
          path: 'flows[0].stages',
        },
      ],
    });
  });

  // ── LLM health ────────────────────────────────────────────────────────

  test('returns llm.configured=true when LLM config resolves successfully', async () => {
    const mockKB = createMockKB();

    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
    mockSourceModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    mockConnectorModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

    // hasTenantModelsConfigured determines llm.configured (not resolveIndexLLMConfig)
    mockHasTenantModelsConfigured.mockResolvedValue(true);
    mockResolveIndexLLMConfig.mockResolvedValue({ provider: 'openai', apiKey: 'sk-test' });
    mockGetCircuitBreakerStatus.mockResolvedValue(null);

    const response = await request(app).get('/kb-001/health-summary').expect(200);

    expect(response.body.data.llm).toMatchObject({ configured: true });
  });

  test('returns llm.configured=false when LLM config resolution throws', async () => {
    const mockKB = createMockKB();

    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
    mockSourceModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    mockConnectorModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

    mockResolveIndexLLMConfig.mockRejectedValue(new Error('No LLM config found'));

    const response = await request(app).get('/kb-001/health-summary').expect(200);

    expect(response.body.data.llm).toMatchObject({ configured: false });
  });

  test('processing count uses extracting/enriching/embedding statuses', async () => {
    const mockKB = createMockKB();
    const mockSources = [createMockSource()];
    const mockConnectors = [createMockConnector()];

    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
    mockSourceModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockSources) });
    mockConnectorModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockConnectors) });
    mockPipelineModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

    // The aggregation pipeline uses $in: ['extracting', 'enriching', 'embedding']
    // Verify that the processing count comes through correctly
    mockDocModel.aggregate.mockResolvedValue([{ _id: null, total: 20, errored: 1, processing: 7 }]);

    mockResolveIndexLLMConfig.mockResolvedValue({ provider: 'anthropic', apiKey: 'key' });
    mockGetCircuitBreakerStatus.mockResolvedValue(null);

    const response = await request(app).get('/kb-001/health-summary').expect(200);

    expect(response.body.data.documents).toMatchObject({
      total: 20,
      errored: 1,
      processing: 7,
    });

    // Verify the aggregation was called (meaning the pipeline uses the new statuses)
    expect(mockDocModel.aggregate).toHaveBeenCalledTimes(1);
    const aggregationPipeline = mockDocModel.aggregate.mock.calls[0][0];
    // The $group stage should contain the $in check for extracting/enriching/embedding
    const groupStage = aggregationPipeline.find((stage: any) => stage.$group);
    expect(groupStage.$group.processing.$sum.$cond[0].$in[1]).toEqual(
      expect.arrayContaining(['extracting', 'enriching', 'embedding']),
    );
  });
});
