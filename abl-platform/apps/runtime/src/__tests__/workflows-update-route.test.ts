import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const { mockWorkflowGetById, mockWorkflowUpdate } = vi.hoisted(() => ({
  mockWorkflowGetById: vi.fn(),
  mockWorkflowUpdate: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: vi.fn().mockResolvedValue(true),
}));

vi.mock('@agent-platform/shared-auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireProjectScope: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn(() => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: unknown, ...handlers: any[]) => {
        (router as any)[method](path, ...handlers);
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

vi.mock('../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    workflowDefinition: {
      create: vi.fn(),
      query: vi.fn(),
      getByName: vi.fn(),
      archive: vi.fn(),
      getById: mockWorkflowGetById,
      update: mockWorkflowUpdate,
    },
    conversation: {
      associateWorkflow: vi.fn(),
    },
  })),
}));

vi.mock('../repos/session-repo.js', () => ({
  countSessions: vi.fn().mockResolvedValue(0),
}));

vi.mock('../services/audit-helpers.js', () => ({
  auditWorkflowCreated: vi.fn().mockResolvedValue(undefined),
  auditWorkflowUpdated: vi.fn().mockResolvedValue(undefined),
  auditWorkflowArchived: vi.fn().mockResolvedValue(undefined),
}));

describe('Workflows update route', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).tenantContext = {
        tenantId: 'tenant-1',
        userId: 'user-1',
      };
      next();
    });
    const workflowsRouter = (await import('../routes/workflows.js')).default;
    app.use('/api/projects/:projectId/workflows', workflowsRouter);

    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkflowGetById.mockResolvedValue({
      id: 'wf-1',
      name: 'Workflow',
      type: 'cx_automation',
      status: 'active',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      steps: [],
      triggers: [],
      escalationRules: [],
      metadata: {},
      createdAt: new Date().toISOString(),
      entryAgent: 'triage_agent',
    });
    mockWorkflowUpdate.mockResolvedValue({
      id: 'wf-1',
      name: 'Workflow',
      type: 'cx_automation',
      status: 'active',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      steps: [],
      triggers: [],
      escalationRules: [],
      metadata: {},
      createdAt: new Date().toISOString(),
      entryAgent: 'handoff_agent',
    });
  });

  it('keeps entryAgent in the validated update schema output', async () => {
    const { updateWorkflowRequestSchema } = await import('../routes/workflows.js');
    const parsed = updateWorkflowRequestSchema.safeParse({
      entryAgent: 'handoff_agent',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ entryAgent: 'handoff_agent' });
    }
  });

  it('passes entryAgent through to the workflow store on PUT', async () => {
    const response = await fetch(`${baseUrl}/api/projects/proj-1/workflows/wf-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entryAgent: 'handoff_agent',
      }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      data: {
        id: 'wf-1',
        entryAgent: 'handoff_agent',
      },
    });
    expect(mockWorkflowUpdate).toHaveBeenCalledWith('wf-1', 'tenant-1', 'proj-1', {
      entryAgent: 'handoff_agent',
    });
  });
});
