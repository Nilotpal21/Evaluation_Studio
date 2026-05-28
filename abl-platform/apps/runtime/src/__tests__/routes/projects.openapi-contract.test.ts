import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireProjectPermission = vi.fn();
const mockProjectFindOne = vi.fn();
const mockProjectLean = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.tenantContext = { tenantId: 'tenant-1' };
    next();
  }),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: (...args: unknown[]) => mockRequireProjectPermission(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  Project: {
    findOne: (...args: unknown[]) => mockProjectFindOne(...args),
  },
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import projectsRouter from '../../routes/projects.js';

function createApp() {
  const app = express();
  app.use('/api/projects/:projectId', projectsRouter);
  return app;
}

describe('Projects route contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectPermission.mockResolvedValue(true);
    mockProjectFindOne.mockImplementation(() => ({
      lean: mockProjectLean,
    }));
    mockProjectLean.mockResolvedValue({
      _id: 'project-123',
      name: 'Project One',
      slug: 'project-one',
      description: null,
      entryAgentName: 'main-agent',
      kind: 'application',
      createdAt: '2026-03-30T00:00:00.000Z',
      updatedAt: '2026-03-30T01:00:00.000Z',
    });
  });

  it('returns project detail with the existing response envelope', async () => {
    const app = createApp();

    await request(app)
      .get('/api/projects/project-123')
      .expect(200, {
        success: true,
        project: {
          _id: 'project-123',
          name: 'Project One',
          slug: 'project-one',
          description: null,
          entryAgentName: 'main-agent',
          kind: 'application',
          createdAt: '2026-03-30T00:00:00.000Z',
          updatedAt: '2026-03-30T01:00:00.000Z',
        },
      });

    expect(mockRequireProjectPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ projectId: 'project-123' }),
      }),
      expect.anything(),
      'project:read',
    );
    expect(mockProjectFindOne).toHaveBeenCalledWith({
      _id: 'project-123',
      tenantId: 'tenant-1',
    });
  });

  it('returns 404 when the project is missing', async () => {
    const app = createApp();
    mockProjectLean.mockResolvedValue(null);

    await request(app)
      .get('/api/projects/project-404')
      .expect(404, {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'Project not found',
        },
      });
  });

  it('returns 500 with the existing fetch failure envelope on repository errors', async () => {
    const app = createApp();
    mockProjectLean.mockRejectedValue(new Error('db unavailable'));

    await request(app)
      .get('/api/projects/project-123')
      .expect(500, {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to fetch project',
        },
      });
  });

  it('stops before the project lookup when project permission is denied', async () => {
    const app = createApp();
    mockRequireProjectPermission.mockImplementation(async (_req: unknown, res: any) => {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Forbidden',
        },
      });
      return false;
    });

    await request(app)
      .get('/api/projects/project-123')
      .expect(403, {
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Forbidden',
        },
      });

    expect(mockProjectFindOne).not.toHaveBeenCalled();
  });
});
