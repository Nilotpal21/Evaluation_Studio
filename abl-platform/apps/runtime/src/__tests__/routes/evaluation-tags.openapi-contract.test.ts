import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireProjectPermission = vi.fn();
const mockFind = vi.fn();
const mockLean = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockToObject = vi.fn();

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

vi.mock('../../models/EvaluationTagConfig.js', () => ({
  EvaluationTagConfig: {
    find: (...args: unknown[]) => mockFind(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
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

import evaluationTagsRouter from '../../routes/evaluation-tags.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/projects/:projectId/evaluation-tags', evaluationTagsRouter);
  return app;
}

describe('Evaluation tags route contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectPermission.mockResolvedValue(true);
    mockFind.mockReturnValue({ lean: mockLean });
    mockLean.mockResolvedValue([
      {
        tag: 'quality',
        direction: 'higher_is_better',
        threshold: 0.8,
      },
    ]);
    mockToObject.mockReturnValue({
      tag: 'quality',
      direction: 'higher_is_better',
      threshold: 0.8,
      displayName: 'Quality',
    });
    mockFindOneAndUpdate.mockResolvedValue({
      toObject: mockToObject,
    });
  });

  it('returns the existing success envelope for listing configs', async () => {
    const app = createApp();

    await request(app)
      .get('/api/projects/project-123/evaluation-tags')
      .expect(200, {
        success: true,
        data: [
          {
            tag: 'quality',
            direction: 'higher_is_better',
            threshold: 0.8,
          },
        ],
      });

    expect(mockRequireProjectPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ projectId: 'project-123' }),
      }),
      expect.anything(),
      'session:read',
    );
    expect(mockFind).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-123',
    });
  });

  it('returns the existing success envelope for upserts', async () => {
    const app = createApp();

    await request(app)
      .put('/api/projects/project-123/evaluation-tags/quality')
      .send({
        direction: 'higher_is_better',
        threshold: 0.8,
        displayName: 'Quality',
      })
      .expect(200, {
        success: true,
        data: {
          tag: 'quality',
          direction: 'higher_is_better',
          threshold: 0.8,
          displayName: 'Quality',
        },
      });

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        projectId: 'project-123',
        tag: 'quality',
      },
      {
        $set: {
          direction: 'higher_is_better',
          threshold: 0.8,
          displayName: 'Quality',
        },
        $setOnInsert: {
          tenantId: 'tenant-1',
          projectId: 'project-123',
          tag: 'quality',
        },
      },
      { new: true, upsert: true },
    );
  });

  it('preserves the invalid input envelope for bad direction values', async () => {
    const app = createApp();

    await request(app)
      .put('/api/projects/project-123/evaluation-tags/quality')
      .send({
        direction: 'sideways',
        threshold: 0.8,
      })
      .expect(400, {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'direction is required and must be "higher_is_better" or "lower_is_better"',
        },
      });

    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('preserves the invalid input envelope for non-numeric thresholds', async () => {
    const app = createApp();

    await request(app)
      .put('/api/projects/project-123/evaluation-tags/quality')
      .send({
        direction: 'higher_is_better',
        threshold: '0.8',
      })
      .expect(400, {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'threshold is required and must be a number',
        },
      });

    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('returns 500 with the existing envelope on write failures', async () => {
    const app = createApp();
    mockFindOneAndUpdate.mockRejectedValue(new Error('write failed'));

    await request(app)
      .put('/api/projects/project-123/evaluation-tags/quality')
      .send({
        direction: 'higher_is_better',
        threshold: 0.8,
      })
      .expect(500, {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to upsert evaluation tag config',
        },
      });
  });
});
