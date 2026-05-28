import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireProjectPermission = vi.fn();
const mockExecuteQuery = vi.fn();

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

vi.mock('@agent-platform/pipeline-engine', () => ({
  NLQueryService: class NLQueryService {
    executeQuery(...args: unknown[]) {
      return mockExecuteQuery(...args);
    }
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

import nlAnalyticsRouter from '../../routes/nl-analytics.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/projects/:projectId/nl-analytics', nlAnalyticsRouter);
  return app;
}

describe('NL analytics route contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectPermission.mockResolvedValue(true);
    mockExecuteQuery.mockResolvedValue({
      question: 'How many calls today?',
      sql: 'SELECT count() FROM calls',
      data: [{ count: 7 }],
      rowCount: 1,
    });
  });

  it('returns the existing success envelope and trims the question before execution', async () => {
    const app = createApp();

    await request(app)
      .post('/api/projects/project-123/nl-analytics/ask')
      .send({ question: '  How many calls today?  ' })
      .expect(200, {
        success: true,
        data: {
          question: 'How many calls today?',
          sql: 'SELECT count() FROM calls',
          data: [{ count: 7 }],
          rowCount: 1,
        },
      });

    expect(mockRequireProjectPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ projectId: 'project-123' }),
      }),
      expect.anything(),
      'session:read',
    );
    expect(mockExecuteQuery).toHaveBeenCalledWith(
      'tenant-1',
      'project-123',
      'How many calls today?',
    );
  });

  it.each([{}, { question: '   ' }, { question: 42 }])(
    'preserves the invalid-input envelope for malformed request bodies: %j',
    async (payload) => {
      const app = createApp();

      await request(app)
        .post('/api/projects/project-123/nl-analytics/ask')
        .send(payload)
        .expect(400, {
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Request body must include a non-empty "question" string',
          },
        });

      expect(mockExecuteQuery).not.toHaveBeenCalled();
    },
  );

  it('returns 400 with the SQL validation envelope for rejected unsafe queries', async () => {
    const app = createApp();
    mockExecuteQuery.mockRejectedValue(new Error('SQL validation failed: SELECT * is not allowed'));

    await request(app)
      .post('/api/projects/project-123/nl-analytics/ask')
      .send({ question: 'Show me everything' })
      .expect(400, {
        success: false,
        error: {
          code: 'SQL_VALIDATION_FAILED',
          message: 'SQL validation failed: SELECT * is not allowed',
        },
      });
  });

  it('returns 500 with the current failure envelope on unexpected query errors', async () => {
    const app = createApp();
    mockExecuteQuery.mockRejectedValue(new Error('clickhouse unavailable'));

    await request(app)
      .post('/api/projects/project-123/nl-analytics/ask')
      .send({ question: 'How many calls today?' })
      .expect(500, {
        success: false,
        error: 'Failed to execute analytics query',
      });
  });

  it('stops before query execution when project permission is denied', async () => {
    const app = createApp();
    mockRequireProjectPermission.mockImplementation(async (_req: unknown, res: any) => {
      res.status(404).json({
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'Project not found',
        },
      });
      return false;
    });

    await request(app)
      .post('/api/projects/project-123/nl-analytics/ask')
      .send({ question: 'How many calls today?' })
      .expect(404, {
        success: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: 'Project not found',
        },
      });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });
});
