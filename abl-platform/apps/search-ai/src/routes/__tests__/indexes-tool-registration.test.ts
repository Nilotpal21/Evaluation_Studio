import { beforeEach, describe, expect, test, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

let mockRegisterSearchAITool: any = vi.fn().mockResolvedValue(undefined);
let mockUnregisterSearchAITool: any = vi.fn().mockResolvedValue(undefined);

const { models } = vi.hoisted(() => ({
  models: {
    SearchIndex: {
      find: vi.fn(),
      findOne: vi.fn(),
      create: vi.fn(),
      findOneAndUpdate: vi.fn(),
      findOneAndDelete: vi.fn(),
    },
    CanonicalSchema: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    KnowledgeBase: {},
    SearchPipelineDefinition: {},
  },
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: keyof typeof models) => models[modelName] ?? {}),
}));

vi.mock('../../services/searchai-tool-registration.js', () => ({
  registerSearchAITool: (...args: unknown[]) => mockRegisterSearchAITool(...args),
  unregisterSearchAITool: (...args: unknown[]) => mockUnregisterSearchAITool(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock('../../services/reindexing/index.js', () => ({
  createReindexOrchestrator: vi.fn(() => ({})),
}));

vi.mock('../../services/llm-config/resolver.js', () => ({
  resolveEnhancedIndexLLMConfig: vi.fn(),
  resolveIndexLLMConfig: vi.fn(),
}));

vi.mock('../../services/llm-config/defaults.js', () => ({
  getAvailableUseCases: vi.fn(() => []),
  getUseCaseDefaults: vi.fn(),
}));

vi.mock('../../services/llm-config/tenant-model-adapter.js', () => ({
  resolveTenantModelById: vi.fn(),
  resolveTenantModelWithFallback: vi.fn(),
}));

vi.mock('@agent-platform/llm', () => ({
  WorkerLLMClient: vi.fn(),
}));

import indexesRouter from '../indexes.js';

function createApp(
  tenantContext: Record<string, unknown> = { tenantId: 'tenant-1', userId: 'user-1' },
): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.tenantContext = tenantContext as any;
    next();
  });
  app.use(indexesRouter);
  return app;
}

describe('Search index route SearchAI tool registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegisterSearchAITool = vi.fn().mockResolvedValue(undefined);
    mockUnregisterSearchAITool = vi.fn().mockResolvedValue(undefined);
    models.SearchIndex.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    });
    models.SearchIndex.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
    models.SearchIndex.create.mockResolvedValue({
      _id: 'idx-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      slug: 'docs',
      name: 'Docs',
    });
    models.SearchIndex.findOneAndUpdate.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'idx-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        slug: 'docs',
      }),
    });
    models.SearchIndex.findOneAndDelete.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'idx-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        slug: 'docs',
      }),
    });
    models.CanonicalSchema.create.mockResolvedValue({ _id: 'schema-1' });
    models.CanonicalSchema.deleteMany.mockResolvedValue({ deletedCount: 1 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  test('scopes index listing by API-key projectScope', async () => {
    const response = await request(
      createApp({
        tenantId: 'tenant-1',
        userId: 'api-key-1',
        projectScope: ['project-2', 'project-1'],
      }),
    ).get('/');

    expect(response.status).toBe(200);
    expect(models.SearchIndex.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: { $in: ['project-1', 'project-2'] },
    });
  });

  test('fails closed when tenantContext projectId conflicts with API-key projectScope', async () => {
    const response = await request(
      createApp({
        tenantId: 'tenant-1',
        userId: 'api-key-1',
        projectId: 'project-2',
        projectScope: ['project-1'],
      }),
    ).get('/');

    expect(response.status).toBe(200);
    expect(models.SearchIndex.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: { $in: [] },
    });
  });

  test('rejects index creation outside API-key projectScope without creating rows', async () => {
    const response = await request(
      createApp({
        tenantId: 'tenant-1',
        userId: 'api-key-1',
        projectScope: ['project-1'],
      }),
    )
      .post('/')
      .send({ projectId: 'project-2', slug: 'docs', name: 'Docs' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('INDEX_NOT_FOUND');
    expect(models.SearchIndex.create).not.toHaveBeenCalled();
    expect(mockRegisterSearchAITool).not.toHaveBeenCalled();
  });

  test('scopes index update by API-key projectScope', async () => {
    const response = await request(
      createApp({
        tenantId: 'tenant-1',
        userId: 'api-key-1',
        projectScope: ['project-1'],
      }),
    )
      .patch('/idx-1')
      .send({ name: 'Docs v2' });

    expect(response.status).toBe(200);
    expect(models.SearchIndex.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'idx-1', tenantId: 'tenant-1', projectId: { $in: ['project-1'] } },
      { $set: { name: 'Docs v2' } },
      { new: true, runValidators: true },
    );
  });

  test('waits for generated SearchAI tool registration before returning created index', async () => {
    let resolveRegistration!: () => void;
    let settled = false;
    mockRegisterSearchAITool = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRegistration = resolve;
        }),
    );

    const pending = request(createApp())
      .post('/')
      .send({ projectId: 'project-1', slug: 'docs', name: 'Docs' })
      .then((response) => {
        settled = true;
        return response;
      });

    try {
      await vi.waitFor(() => expect(mockRegisterSearchAITool).toHaveBeenCalled());
      expect(settled).toBe(false);
    } finally {
      resolveRegistration?.();
    }

    const response = await pending;

    expect(response.status).toBe(201);
    expect(settled).toBe(true);
  });

  test('fails index creation response when generated tool registration fails', async () => {
    mockRegisterSearchAITool = vi.fn().mockRejectedValue(new Error('registration failed'));

    const response = await request(createApp())
      .post('/')
      .send({ projectId: 'project-1', slug: 'docs', name: 'Docs' });

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('CREATE_FAILED');
    expect(models.SearchIndex.findOneAndDelete).toHaveBeenCalledWith({
      _id: 'idx-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
    expect(models.CanonicalSchema.deleteMany).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      knowledgeBaseId: 'idx-1',
    });
  });

  test('awaits tool unregister and invalidates runtime caches before delete returns', async () => {
    let resolveUnregister!: () => void;
    let settled = false;
    models.SearchIndex.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'idx-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        slug: 'docs',
      }),
    });
    mockUnregisterSearchAITool = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUnregister = resolve;
        }),
    );

    const pending = request(createApp())
      .delete('/idx-1')
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
        body: JSON.stringify({ indexId: 'idx-1', tenantId: 'tenant-1' }),
      }),
    );
  });

  test('does not delete SearchIndex first when generated tool unregister fails', async () => {
    models.SearchIndex.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'idx-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        slug: 'docs',
      }),
    });
    mockUnregisterSearchAITool = vi.fn().mockRejectedValue(new Error('unregister failed'));

    const response = await request(createApp()).delete('/idx-1');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('DELETE_FAILED');
    expect(models.SearchIndex.findOneAndDelete).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
