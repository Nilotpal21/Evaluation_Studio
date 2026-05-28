import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/shared-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared-auth')>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  };
});

vi.mock('../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: unknown, _opts: unknown) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: unknown, ...handlers: any[]) => {
        const lastHandler = handlers[handlers.length - 1];
        const middlewares = handlers.slice(0, -1);
        (router as any)[method](path, ...middlewares, lastHandler);
      },
    };
  }),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

const mockFindProjectAgentForProject = vi.fn();
const mockUpsertAgentModelConfig = vi.fn();
vi.mock('../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn().mockResolvedValue({
    _id: 'proj-1',
    tenantId: 'tenant-A',
    ownerId: 'owner-user',
  }),
  findProjectMember: vi.fn().mockResolvedValue(null),
  findProjectAgentForProject: (...args: unknown[]) => mockFindProjectAgentForProject(...args),
  findAgentModelConfig: vi.fn().mockResolvedValue(null),
  upsertAgentModelConfig: (...args: unknown[]) => mockUpsertAgentModelConfig(...args),
}));

const mockModelConfigDistinct = vi.fn();
const mockModelConfigFindOneLean = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  ModelConfig: {
    distinct: (...args: unknown[]) => mockModelConfigDistinct(...args),
    findOne: vi.fn().mockReturnValue({ lean: mockModelConfigFindOneLean }),
  },
}));

const mockInvalidateModelResolutionCaches = vi.fn();
vi.mock('../services/llm/model-cache-invalidation.js', () => ({
  invalidateModelResolutionCaches: (...args: unknown[]) =>
    mockInvalidateModelResolutionCaches(...args),
}));

import { makeTenantContext, injectTenantContext } from './helpers/auth-context.js';

async function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(injectTenantContext(makeTenantContext('tenant-A', 'owner-user', 'OWNER')));
  const router = (await import('../routes/agent-model-config.js')).default;
  app.use('/api/projects/:projectId/agents/:agentName/model-config', router);
  return app;
}

describe('agent model config validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindProjectAgentForProject.mockResolvedValue({
      id: 'agent-1',
      _id: 'agent-1',
      name: 'main',
    });
    mockModelConfigFindOneLean.mockResolvedValue({ modelId: 'gpt-4o' });
    mockUpsertAgentModelConfig.mockResolvedValue({
      projectId: 'proj-1',
      agentName: 'main',
      defaultModel: 'gpt-4o',
      operationModels: '{}',
      temperature: null,
      maxTokens: null,
      hyperParameters: null,
      useResponsesApi: null,
      useStreaming: null,
    });
  });

  test('rejects a defaultModel that is not in the project model pool', async () => {
    mockModelConfigDistinct.mockResolvedValue(['gpt-4o']);
    const app = await createTestApp();

    const res = await request(app)
      .put('/api/projects/proj-1/agents/main/model-config')
      .send({ defaultModel: 'missing-model' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'Selected model must belong to this project',
    });
    expect(mockUpsertAgentModelConfig).not.toHaveBeenCalled();
  });

  test('rejects operationModels that are not in the project model pool', async () => {
    mockModelConfigDistinct.mockResolvedValue(['gpt-4o']);
    const app = await createTestApp();

    const res = await request(app)
      .put('/api/projects/proj-1/agents/main/model-config')
      .send({ defaultModel: 'gpt-4o', operationModels: { reasoning: 'missing-model' } });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'Selected model must belong to this project',
    });
    expect(mockUpsertAgentModelConfig).not.toHaveBeenCalled();
  });

  test('allows model IDs that belong to the project model pool', async () => {
    mockModelConfigDistinct.mockResolvedValue(['gpt-4o', 'gpt-4o-mini']);
    const app = await createTestApp();

    const res = await request(app)
      .put('/api/projects/proj-1/agents/main/model-config')
      .send({ defaultModel: 'gpt-4o', operationModels: { extraction: 'gpt-4o-mini' } });

    expect(res.status).toBe(200);
    expect(mockModelConfigDistinct).toHaveBeenCalledWith('modelId', {
      projectId: 'proj-1',
      tenantId: 'tenant-A',
      modelId: { $in: ['gpt-4o', 'gpt-4o-mini'] },
    });
    expect(mockUpsertAgentModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        agentName: 'main',
        tenantId: 'tenant-A',
        defaultModel: 'gpt-4o',
        operationModels: { extraction: 'gpt-4o-mini' },
      }),
    );
    expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-A');
  });
});
