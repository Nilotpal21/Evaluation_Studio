/**
 * Activity Feed Route Tests
 *
 * Tests for GET /:kbId/activity endpoint.
 * Uses forks pool due to supertest HTTP server lifecycle.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

const { mockQueryKnowledgeBaseActivityAuditLogsFromClickHouse } = vi.hoisted(() => ({
  mockQueryKnowledgeBaseActivityAuditLogsFromClickHouse: vi.fn(),
}));

// ── Mock dependencies before imports ──────────────────────────────────────

vi.mock('../../db/index.js', () => {
  const models: Record<string, any> = {
    KnowledgeBase: {
      findOne: vi.fn(),
    },
    SearchIndex: {},
    SearchSource: {
      find: vi.fn(),
    },
    SearchDocument: {},
    SearchChunk: {},
    SearchPipelineDefinition: {},
    ConnectorConfig: {},
  };

  return {
    getLazyModel: vi.fn((modelName: string) => models[modelName] || {}),
  };
});

vi.mock('../../services/search-ai-clickhouse-audit-reader.js', () => ({
  queryKnowledgeBaseActivityAuditLogsFromClickHouse:
    mockQueryKnowledgeBaseActivityAuditLogsFromClickHouse,
}));

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
  resolveIndexLLMConfig: vi.fn(),
}));

vi.mock('../../services/mapping-suggestion/index.js', () => ({
  mappingSuggestionService: {
    getCircuitBreakerStatus: vi.fn(),
  },
}));

// Import after mocks
import { getLazyModel } from '../../db/index.js';
import knowledgeBasesRouter from '../knowledge-bases.js';

describe('GET /:kbId/activity', () => {
  let app: Express;
  let mockKBModel: any;
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
    app.use(knowledgeBasesRouter);

    mockKBModel = getLazyModel('KnowledgeBase') as any;
    mockSourceModel = getLazyModel('SearchSource') as any;
    mockQueryKnowledgeBaseActivityAuditLogsFromClickHouse.mockReset();

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createMockKB = (overrides: Record<string, unknown> = {}) => ({
    _id: 'kb-001',
    tenantId: 'tenant-123',
    projectId: 'project-456',
    name: 'Test KB',
    searchIndexId: 'idx-001',
    status: 'active',
    ...overrides,
  });

  const createMockActivity = (overrides: Record<string, unknown> = {}) => ({
    id: 'audit-001',
    tenantId: 'tenant-123',
    actor: 'user-456',
    action: 'source.sync.completed',
    metadata: {
      resourceType: 'source',
      resourceId: 'source-001',
    },
    timestamp: new Date('2026-03-15T10:00:00.000Z'),
    ...overrides,
  });

  test('happy path: returns activities with pagination', async () => {
    const mockKB = createMockKB();
    const mockSources = [{ _id: 'source-001' }, { _id: 'source-002' }];
    const mockActivities = [
      createMockActivity(),
      createMockActivity({
        id: 'audit-002',
        action: 'index.rebuild.started',
        metadata: { resourceType: 'index', resourceId: 'idx-001' },
        timestamp: new Date('2026-03-15T09:00:00.000Z'),
      }),
    ];

    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
    mockSourceModel.find.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(mockSources) }),
    });
    mockQueryKnowledgeBaseActivityAuditLogsFromClickHouse.mockResolvedValue({
      logs: mockActivities,
      total: 2,
    });

    const response = await request(app).get('/kb-001/activity').expect(200);

    expect(response.body.data.activities).toHaveLength(2);
    expect(response.body.data.total).toBe(2);
    expect(response.body.data.hasMore).toBe(false);

    expect(mockKBModel.findOne).toHaveBeenCalledWith({
      _id: 'kb-001',
      tenantId: 'tenant-123',
    });
    expect(mockQueryKnowledgeBaseActivityAuditLogsFromClickHouse).toHaveBeenCalledWith({
      tenantId: 'tenant-123',
      indexId: 'idx-001',
      sourceIds: ['source-001', 'source-002'],
      limit: 20,
      offset: 0,
    });
  });

  test('returns empty activities when none exist', async () => {
    const mockKB = createMockKB();

    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
    mockSourceModel.find.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    });
    mockQueryKnowledgeBaseActivityAuditLogsFromClickHouse.mockResolvedValue({
      logs: [],
      total: 0,
    });

    const response = await request(app).get('/kb-001/activity').expect(200);

    expect(response.body.data.activities).toHaveLength(0);
    expect(response.body.data.total).toBe(0);
    expect(response.body.data.hasMore).toBe(false);
  });

  test('returns 404 for non-existent KB', async () => {
    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

    const response = await request(app).get('/kb-nonexistent/activity').expect(404);

    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(mockKBModel.findOne).toHaveBeenCalledWith({
      _id: 'kb-nonexistent',
      tenantId: 'tenant-123',
    });
    expect(mockQueryKnowledgeBaseActivityAuditLogsFromClickHouse).not.toHaveBeenCalled();
  });

  test('respects limit and offset for pagination', async () => {
    const mockKB = createMockKB();
    const mockSources = [{ _id: 'source-001' }];

    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
    mockSourceModel.find.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(mockSources) }),
    });
    mockQueryKnowledgeBaseActivityAuditLogsFromClickHouse.mockResolvedValue({
      logs: [createMockActivity()],
      total: 25,
    });

    const response = await request(app).get('/kb-001/activity?limit=5&offset=10').expect(200);

    expect(response.body.data.hasMore).toBe(true);
    expect(mockQueryKnowledgeBaseActivityAuditLogsFromClickHouse).toHaveBeenCalledWith({
      tenantId: 'tenant-123',
      indexId: 'idx-001',
      sourceIds: ['source-001'],
      limit: 5,
      offset: 10,
    });
  });

  test('clamps limit to max 100', async () => {
    const mockKB = createMockKB();
    const mockSources = [{ _id: 'source-001' }];

    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });
    mockSourceModel.find.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(mockSources) }),
    });
    mockQueryKnowledgeBaseActivityAuditLogsFromClickHouse.mockResolvedValue({
      logs: [],
      total: 0,
    });

    await request(app).get('/kb-001/activity?limit=500').expect(200);

    expect(mockQueryKnowledgeBaseActivityAuditLogsFromClickHouse).toHaveBeenCalledWith({
      tenantId: 'tenant-123',
      indexId: 'idx-001',
      sourceIds: ['source-001'],
      limit: 100,
      offset: 0,
    });
  });

  test('returns empty when KB has no searchIndexId', async () => {
    const mockKB = createMockKB({ searchIndexId: null });

    mockKBModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(mockKB) });

    const response = await request(app).get('/kb-001/activity').expect(200);

    expect(response.body.data.activities).toHaveLength(0);
    expect(response.body.data.total).toBe(0);
    expect(response.body.data.hasMore).toBe(false);
    expect(mockQueryKnowledgeBaseActivityAuditLogsFromClickHouse).not.toHaveBeenCalled();
  });
});
