import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireProjectPermission = vi.fn();
const mockIsDatabaseAvailable = vi.fn();
const mockFindProjectSettings = vi.fn();
const mockFindOneAndUpdate = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    if (req.headers['x-test-no-tenant'] !== 'true') {
      req.tenantContext = { tenantId: 'tenant-1' };
    }
    next();
  }),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: (...args: unknown[]) => mockRequireProjectPermission(...args),
}));

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: (...args: unknown[]) => mockIsDatabaseAvailable(...args),
}));

vi.mock('../../repos/project-settings-repo.js', () => ({
  findProjectSettings: (...args: unknown[]) => mockFindProjectSettings(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectSettings: {
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

import agentTransferSettingsRouter from '../../routes/agent-transfer-settings.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/agent-transfer/settings', agentTransferSettingsRouter);
  return app;
}

describe('Agent transfer settings route contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectPermission.mockResolvedValue(true);
    mockIsDatabaseAvailable.mockReturnValue(true);
    mockFindProjectSettings.mockResolvedValue({
      agentTransfer: { enabled: true, mode: 'warm' },
    });
    mockFindOneAndUpdate.mockResolvedValue({
      projectId: 'project-123',
      tenantId: 'tenant-1',
      agentTransfer: { enabled: true, mode: 'warm' },
    });
  });

  it('returns the existing success envelope for GET', async () => {
    const app = createApp();

    await request(app)
      .get('/api/v1/agent-transfer/settings')
      .set('X-Project-Id', 'project-123')
      .expect(200, {
        success: true,
        data: { enabled: true, mode: 'warm' },
      });

    expect(mockRequireProjectPermission).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'connection:read',
      'project-123',
    );
    expect(mockFindProjectSettings).toHaveBeenCalledWith('project-123', 'tenant-1');
  });

  it('normalizes legacy default routing connectionId into the canonical connection reference', async () => {
    const app = createApp();
    mockFindProjectSettings.mockResolvedValue({
      agentTransfer: {
        defaultRouting: {
          connectionId: 'conn-123',
          queue: 'vip-support',
          postAgentAction: 'return',
        },
      },
    });

    await request(app)
      .get('/api/v1/agent-transfer/settings')
      .set('X-Project-Id', 'project-123')
      .expect(200, {
        success: true,
        data: {
          defaultRouting: {
            connection: {
              connectionId: 'conn-123',
            },
            queue: 'vip-support',
            postAgentAction: 'return',
          },
        },
      });
  });

  it('returns the existing success envelope for PUT and writes the body unchanged', async () => {
    const app = createApp();
    const payload = {
      enabled: true,
      mode: 'warm',
      fallbackAgent: 'agent-two',
    };

    await request(app)
      .put('/api/v1/agent-transfer/settings')
      .set('X-Project-Id', 'project-123')
      .send(payload)
      .expect(200, {
        success: true,
        data: payload,
      });

    expect(mockRequireProjectPermission).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'connection:write',
      'project-123',
    );
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-123', tenantId: 'tenant-1' },
      { $set: { projectId: 'project-123', tenantId: 'tenant-1', agentTransfer: payload } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  });

  it('normalizes legacy default routing writes before persisting project settings', async () => {
    const app = createApp();
    const payload = {
      defaultRouting: {
        connectionId: 'conn-123',
        queue: 'vip-support',
        postAgentAction: 'return',
      },
    };

    await request(app)
      .put('/api/v1/agent-transfer/settings')
      .set('X-Project-Id', 'project-123')
      .send(payload)
      .expect(200, {
        success: true,
        data: {
          defaultRouting: {
            connection: {
              connectionId: 'conn-123',
            },
            queue: 'vip-support',
            postAgentAction: 'return',
          },
        },
      });

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-123', tenantId: 'tenant-1' },
      {
        $set: {
          projectId: 'project-123',
          tenantId: 'tenant-1',
          agentTransfer: {
            defaultRouting: {
              connection: {
                connectionId: 'conn-123',
              },
              queue: 'vip-support',
              postAgentAction: 'return',
            },
          },
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
  });

  it('preserves lifecycle-owned session TTL when legacy PUT omits it', async () => {
    const app = createApp();
    mockFindProjectSettings.mockResolvedValue({
      agentTransfer: {
        session: {
          ttl: {
            chat: 1800,
            email: 7200,
          },
        },
      },
    });
    const payload = {
      session: {
        maxConcurrentPerContact: 4,
      },
      defaultRouting: {
        queue: 'vip-support',
      },
    };

    await request(app)
      .put('/api/v1/agent-transfer/settings')
      .set('X-Project-Id', 'project-123')
      .send(payload)
      .expect(200, {
        success: true,
        data: {
          session: {
            maxConcurrentPerContact: 4,
            ttl: {
              chat: 1800,
              email: 7200,
            },
          },
          defaultRouting: {
            queue: 'vip-support',
          },
        },
      });

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-123', tenantId: 'tenant-1' },
      {
        $set: {
          projectId: 'project-123',
          tenantId: 'tenant-1',
          agentTransfer: {
            session: {
              maxConcurrentPerContact: 4,
              ttl: {
                chat: 1800,
                email: 7200,
              },
            },
            defaultRouting: {
              queue: 'vip-support',
            },
          },
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
  });

  it('returns 400 when the project header is missing', async () => {
    const app = createApp();

    await request(app)
      .get('/api/v1/agent-transfer/settings')
      .expect(400, {
        success: false,
        error: { code: 'MISSING_PROJECT', message: 'X-Project-Id header is required' },
      });

    expect(mockFindProjectSettings).not.toHaveBeenCalled();
  });

  it('returns 403 when tenant context is missing after auth middleware', async () => {
    const app = createApp();

    await request(app)
      .get('/api/v1/agent-transfer/settings')
      .set('X-Project-Id', 'project-123')
      .set('X-Test-No-Tenant', 'true')
      .expect(403, {
        success: false,
        error: { code: 'TENANT_CONTEXT_REQUIRED', message: 'Tenant context is required' },
      });

    expect(mockFindProjectSettings).not.toHaveBeenCalled();
  });

  it('returns 503 when the database is unavailable', async () => {
    const app = createApp();
    mockIsDatabaseAvailable.mockReturnValue(false);

    await request(app)
      .get('/api/v1/agent-transfer/settings')
      .set('X-Project-Id', 'project-123')
      .expect(503, {
        success: false,
        error: { code: 'DB_UNAVAILABLE', message: 'Database not available' },
      });
  });

  it('preserves the invalid-body envelope for non-object PUT payloads', async () => {
    const app = createApp();

    await request(app)
      .put('/api/v1/agent-transfer/settings')
      .set('X-Project-Id', 'project-123')
      .send(['bad'])
      .expect(400, {
        success: false,
        error: { code: 'INVALID_BODY', message: 'Request body must be a JSON object' },
      });

    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('preserves the disallowed-keys envelope for prototype-polluting payloads', async () => {
    const app = createApp();

    await request(app)
      .put('/api/v1/agent-transfer/settings')
      .set('X-Project-Id', 'project-123')
      .set('Content-Type', 'application/json')
      .send('{"constructor":{"polluted":true}}')
      .expect(400, {
        success: false,
        error: { code: 'INVALID_BODY', message: 'Request body contains disallowed keys' },
      });

    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('stops before reads when permission is denied', async () => {
    const app = createApp();
    mockRequireProjectPermission.mockImplementation(async (_req: unknown, res: any) => {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Forbidden' },
      });
      return false;
    });

    await request(app)
      .get('/api/v1/agent-transfer/settings')
      .set('X-Project-Id', 'project-123')
      .expect(403, {
        success: false,
        error: { code: 'FORBIDDEN', message: 'Forbidden' },
      });

    expect(mockFindProjectSettings).not.toHaveBeenCalled();
  });
});
