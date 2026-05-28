/**
 * Project LLM Config Route Tests
 *
 * Locks the opt-in operation routing compatibility contract:
 * - ProjectLLMConfig is canonical.
 * - ProjectRuntimeConfig is a temporary compatibility fallback/write mirror.
 * - Successful writes invalidate runtime model-resolution caches.
 */

import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

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
  createOpenAPIRouter: vi.fn((_registry: any, _opts: any) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: any, ...handlers: any[]) => {
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

vi.mock('../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn().mockResolvedValue({
    _id: 'proj-1',
    tenantId: 'tenant-A',
    ownerId: 'owner-user',
  }),
  findProjectMember: vi.fn().mockResolvedValue(null),
}));

vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn(),
}));

const {
  mockProjectLLMFindOneLean,
  mockProjectRuntimeFindOneLean,
  mockProjectLLMFindOneAndUpdateLean,
  mockProjectRuntimeFindOneAndUpdateLean,
  mockInvalidateModelResolutionCaches,
} = vi.hoisted(() => ({
  mockProjectLLMFindOneLean: vi.fn(),
  mockProjectRuntimeFindOneLean: vi.fn(),
  mockProjectLLMFindOneAndUpdateLean: vi.fn(),
  mockProjectRuntimeFindOneAndUpdateLean: vi.fn(),
  mockInvalidateModelResolutionCaches: vi.fn(),
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectLLMConfig: {
    findOne: vi.fn().mockReturnValue({ lean: mockProjectLLMFindOneLean }),
    findOneAndUpdate: vi.fn().mockReturnValue({ lean: mockProjectLLMFindOneAndUpdateLean }),
  },
  ProjectRuntimeConfig: {
    findOne: vi.fn().mockReturnValue({ lean: mockProjectRuntimeFindOneLean }),
    findOneAndUpdate: vi.fn().mockReturnValue({ lean: mockProjectRuntimeFindOneAndUpdateLean }),
  },
}));

vi.mock('../services/llm/model-cache-invalidation.js', () => ({
  invalidateModelResolutionCaches: (...args: unknown[]) =>
    mockInvalidateModelResolutionCaches(...args),
}));

import express from 'express';
import { makeTenantContext, injectTenantContext } from './helpers/auth-context.js';
import { ProjectLLMConfig, ProjectRuntimeConfig } from '@agent-platform/database/models';

const CONFIG_BASE = '/api/projects/proj-1/llm-config';
const ENABLED_OPERATION_ROUTING_MAP = {
  extraction: 'fast',
  validation: 'fast',
  tool_selection: 'fast',
  response_gen: 'balanced',
  summarization: 'balanced',
  reasoning: 'powerful',
  coordination: 'powerful',
  realtime_voice: 'voice',
};

async function request(baseUrl: string, method: string, path: string, opts?: { body?: unknown }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function createServer() {
  const app = express();
  app.use(express.json());
  const ctx = makeTenantContext('tenant-A', 'owner-user', 'OWNER');
  app.use(injectTenantContext(ctx));
  const configRouter = (await import('../routes/project-llm-config.js')).default;
  app.use('/api/projects/:projectId/llm-config', configRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

describe('Project LLM config route', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    ({ baseUrl, server } = await createServer());
  });

  afterAll(() => server?.close());

  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectLLMFindOneLean.mockResolvedValue(null);
    mockProjectRuntimeFindOneLean.mockResolvedValue(null);
  });

  test('GET reads canonical ProjectLLMConfig before compatibility runtime config', async () => {
    mockProjectLLMFindOneLean.mockResolvedValue({
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      operationTierOverrides: { response_gen: 'powerful' },
    });
    mockProjectRuntimeFindOneLean.mockResolvedValue({
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      operationTierOverrides: { response_gen: 'fast' },
    });

    const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);

    expect(status).toBe(200);
    expect(body.config.operationTierOverrides).toEqual({ response_gen: 'powerful' });
    expect(ProjectLLMConfig.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-A',
      projectId: 'proj-1',
    });
    expect(ProjectRuntimeConfig.findOne).not.toHaveBeenCalled();
  });

  test('GET falls back to ProjectRuntimeConfig compatibility data', async () => {
    mockProjectLLMFindOneLean.mockResolvedValue(null);
    mockProjectRuntimeFindOneLean.mockResolvedValue({
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      operationTierOverrides: new Map([['reasoning', 'powerful']]),
    });

    const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);

    expect(status).toBe(200);
    expect(body.config.operationTierOverrides).toEqual({ reasoning: 'powerful' });
    expect(ProjectRuntimeConfig.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-A',
      projectId: 'proj-1',
    });
  });

  test('PUT mirrors overrides into canonical and compatibility records and invalidates caches', async () => {
    const updatedDoc = {
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      operationTierOverrides: { response_gen: 'powerful' },
    };
    mockProjectLLMFindOneAndUpdateLean.mockResolvedValue(updatedDoc);
    mockProjectRuntimeFindOneAndUpdateLean.mockResolvedValue(updatedDoc);

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: { operationTierOverrides: { response_gen: 'powerful' } },
    });

    expect(status).toBe(200);
    expect(body.config.operationTierOverrides).toEqual({ response_gen: 'powerful' });
    expect(ProjectLLMConfig.findOneAndUpdate).toHaveBeenCalledWith(
      { tenantId: 'tenant-A', projectId: 'proj-1' },
      {
        $set: {
          operationTierOverrides: { response_gen: 'powerful' },
          tenantId: 'tenant-A',
          projectId: 'proj-1',
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    expect(ProjectRuntimeConfig.findOneAndUpdate).toHaveBeenCalledWith(
      { tenantId: 'tenant-A', projectId: 'proj-1' },
      {
        $set: {
          operationTierOverrides: { response_gen: 'powerful' },
          tenantId: 'tenant-A',
          projectId: 'proj-1',
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-A');
  });

  test('PUT persists a full enabled operation routing map and invalidates caches', async () => {
    const updatedDoc = {
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      operationTierOverrides: ENABLED_OPERATION_ROUTING_MAP,
    };
    mockProjectLLMFindOneAndUpdateLean.mockResolvedValue(updatedDoc);
    mockProjectRuntimeFindOneAndUpdateLean.mockResolvedValue(updatedDoc);

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: { operationTierOverrides: ENABLED_OPERATION_ROUTING_MAP },
    });

    expect(status).toBe(200);
    expect(body.config.operationTierOverrides).toEqual(ENABLED_OPERATION_ROUTING_MAP);
    expect(ProjectLLMConfig.findOneAndUpdate).toHaveBeenCalledWith(
      { tenantId: 'tenant-A', projectId: 'proj-1' },
      {
        $set: {
          operationTierOverrides: ENABLED_OPERATION_ROUTING_MAP,
          tenantId: 'tenant-A',
          projectId: 'proj-1',
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    expect(ProjectRuntimeConfig.findOneAndUpdate).toHaveBeenCalledWith(
      { tenantId: 'tenant-A', projectId: 'proj-1' },
      {
        $set: {
          operationTierOverrides: ENABLED_OPERATION_ROUTING_MAP,
          tenantId: 'tenant-A',
          projectId: 'proj-1',
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-A');
  });

  test('PUT persists an empty disabled operation routing map and invalidates caches', async () => {
    const updatedDoc = {
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      operationTierOverrides: {},
    };
    mockProjectLLMFindOneAndUpdateLean.mockResolvedValue(updatedDoc);
    mockProjectRuntimeFindOneAndUpdateLean.mockResolvedValue(updatedDoc);

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: { operationTierOverrides: {} },
    });

    expect(status).toBe(200);
    expect(body.config.operationTierOverrides).toEqual({});
    expect(ProjectLLMConfig.findOneAndUpdate).toHaveBeenCalledWith(
      { tenantId: 'tenant-A', projectId: 'proj-1' },
      {
        $set: {
          operationTierOverrides: {},
          tenantId: 'tenant-A',
          projectId: 'proj-1',
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    expect(ProjectRuntimeConfig.findOneAndUpdate).toHaveBeenCalledWith(
      { tenantId: 'tenant-A', projectId: 'proj-1' },
      {
        $set: {
          operationTierOverrides: {},
          tenantId: 'tenant-A',
          projectId: 'proj-1',
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-A');
  });

  test('PUT accepts realtime voice operation overrides targeting the voice tier', async () => {
    const updatedDoc = {
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      operationTierOverrides: { realtime_voice: 'voice' },
    };
    mockProjectLLMFindOneAndUpdateLean.mockResolvedValue(updatedDoc);
    mockProjectRuntimeFindOneAndUpdateLean.mockResolvedValue(updatedDoc);

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: { operationTierOverrides: { realtime_voice: 'voice' } },
    });

    expect(status).toBe(200);
    expect(body.config.operationTierOverrides).toEqual({ realtime_voice: 'voice' });
    expect(ProjectLLMConfig.findOneAndUpdate).toHaveBeenCalledWith(
      { tenantId: 'tenant-A', projectId: 'proj-1' },
      {
        $set: {
          operationTierOverrides: { realtime_voice: 'voice' },
          tenantId: 'tenant-A',
          projectId: 'proj-1',
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    expect(ProjectRuntimeConfig.findOneAndUpdate).toHaveBeenCalledWith(
      { tenantId: 'tenant-A', projectId: 'proj-1' },
      {
        $set: {
          operationTierOverrides: { realtime_voice: 'voice' },
          tenantId: 'tenant-A',
          projectId: 'proj-1',
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-A');
  });

  test('PUT rejects realtime voice operation overrides targeting text tiers', async () => {
    mockProjectLLMFindOneAndUpdateLean.mockClear();
    mockProjectRuntimeFindOneAndUpdateLean.mockClear();
    mockInvalidateModelResolutionCaches.mockClear();

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: { operationTierOverrides: { realtime_voice: 'fast' } },
    });

    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: expect.stringContaining('realtime_voice=fast'),
    });
    expect(ProjectLLMConfig.findOneAndUpdate).not.toHaveBeenCalled();
    expect(ProjectRuntimeConfig.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mockInvalidateModelResolutionCaches).not.toHaveBeenCalled();
  });
});
