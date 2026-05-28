import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireProjectPermission = vi.fn();
const mockRunPreflightValidation = vi.fn();
const mockFindProjectAgentsForProject = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.tenantContext = { tenantId: 'tenant-1' };
    next();
  }),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('@agent-platform/shared-auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireProjectScope: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: (...args: unknown[]) => mockRequireProjectPermission(...args),
}));

vi.mock('../../services/preflight-validation-service.js', () => ({
  runPreflightValidation: (...args: unknown[]) => mockRunPreflightValidation(...args),
}));

vi.mock('../../repos/project-repo.js', () => ({
  findProjectAgentsForProject: (...args: unknown[]) => mockFindProjectAgentsForProject(...args),
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

import validateRouter from '../../routes/validate.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/projects/:projectId/validate', validateRouter);
  return app;
}

describe('Validate route contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectPermission.mockResolvedValue(true);
    mockFindProjectAgentsForProject.mockResolvedValue([{ name: 'alpha' }, { name: 'beta' }]);
    mockRunPreflightValidation.mockResolvedValue({
      status: 'ready',
      agents: [],
      summary: {
        total: 2,
        passed: 2,
        warnings: 0,
        errors: 0,
        canonicalIssues: [],
      },
    });
  });

  it('returns the existing success envelope for explicit agent names', async () => {
    const app = createApp();

    await request(app)
      .post('/api/projects/project-123/validate')
      .send({ agentNames: ['agent-a', 'agent-b'] })
      .expect(200, {
        success: true,
        data: {
          status: 'ready',
          agents: [],
          summary: {
            total: 2,
            passed: 2,
            warnings: 0,
            errors: 0,
            canonicalIssues: [],
          },
        },
      });

    expect(mockRequireProjectPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ projectId: 'project-123' }),
      }),
      expect.anything(),
      'deployment:create',
    );
    expect(mockFindProjectAgentsForProject).not.toHaveBeenCalled();
    expect(mockRunPreflightValidation).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-123',
      agentNames: ['agent-a', 'agent-b'],
    });
  });

  it('discovers project agents when agent names are omitted', async () => {
    const app = createApp();

    await request(app).post('/api/projects/project-123/validate').send({}).expect(200);

    expect(mockFindProjectAgentsForProject).toHaveBeenCalledWith('project-123', {
      tenantId: 'tenant-1',
    });
    expect(mockRunPreflightValidation).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-123',
      agentNames: ['alpha', 'beta'],
    });
  });

  it('returns 400 with the helper-owned invalid-input envelope for malformed request bodies', async () => {
    const app = createApp();

    await request(app)
      .post('/api/projects/project-123/validate')
      .send({ agentNames: 'agent-a' })
      .expect(400, {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Request body must include an optional "agentNames" array',
        },
      });

    expect(mockFindProjectAgentsForProject).not.toHaveBeenCalled();
    expect(mockRunPreflightValidation).not.toHaveBeenCalled();
  });

  it('returns 500 with the current failure envelope when validation execution fails', async () => {
    const app = createApp();
    mockRunPreflightValidation.mockRejectedValue(new Error('diagnostic engine unavailable'));

    await request(app)
      .post('/api/projects/project-123/validate')
      .send({ agentNames: ['agent-a'] })
      .expect(500, {
        success: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Preflight validation failed',
        },
      });
  });

  it('stops before discovery when project permission is denied', async () => {
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
      .post('/api/projects/project-123/validate')
      .send({ agentNames: ['agent-a'] })
      .expect(403, {
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Forbidden',
        },
      });

    expect(mockFindProjectAgentsForProject).not.toHaveBeenCalled();
    expect(mockRunPreflightValidation).not.toHaveBeenCalled();
  });
});
