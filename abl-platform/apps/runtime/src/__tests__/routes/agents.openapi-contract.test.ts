import express from 'express';
import request from 'supertest';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mockIsDatabaseAvailable = vi.fn();
const mockFindProjectAgentsWithTenant = vi.fn();
const mockFindProjectAgentByName = vi.fn();
const mockGetCurrentTenantId = vi.fn();
const mockBuildAgentDetails = vi.fn();
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: (...args: unknown[]) => mockIsDatabaseAvailable(...args),
}));

vi.mock('../../repos/project-repo.js', () => ({
  findProjectAgentsWithTenant: (...args: unknown[]) => mockFindProjectAgentsWithTenant(...args),
  findProjectAgentByName: (...args: unknown[]) => mockFindProjectAgentByName(...args),
}));

vi.mock('@agent-platform/shared-auth/middleware', () => ({
  getCurrentTenantId: (...args: unknown[]) => mockGetCurrentTenantId(...args),
}));

vi.mock('../../services/dsl-utils.js', () => ({
  buildAgentDetails: (...args: unknown[]) => mockBuildAgentDetails(...args),
}));

import agentsRouter from '../../routes/agents.js';

function createApp() {
  const app = express();
  app.use('/api/agents', agentsRouter);
  return app;
}

describe('Agents route contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDatabaseAvailable.mockReturnValue(true);
    mockGetCurrentTenantId.mockReturnValue('tenant-1');
    mockFindProjectAgentsWithTenant.mockResolvedValue([
      {
        id: 'agent-1',
        name: 'alpha-agent',
      },
    ]);
    mockFindProjectAgentByName.mockResolvedValue({
      name: 'alpha-agent',
      dslContent: 'AGENT: alpha-agent\nGOAL: "Help users"',
    });
    mockBuildAgentDetails.mockReturnValue({
      id: 'alpha-agent',
      name: 'alpha-agent',
      dslContent: 'AGENT: alpha-agent\nGOAL: "Help users"',
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockClear();
  });

  it('returns the existing success envelope when listing agents', async () => {
    const app = createApp();

    await request(app)
      .get('/api/agents')
      .expect(200, {
        success: true,
        total: 1,
        agents: [
          {
            id: 'agent-1',
            name: 'alpha-agent',
          },
        ],
      });

    expect(mockFindProjectAgentsWithTenant).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
  });

  it('returns 503 when the database is unavailable', async () => {
    const app = createApp();
    mockIsDatabaseAvailable.mockReturnValue(false);

    await request(app).get('/api/agents').expect(503, {
      success: false,
      error: 'Database not available',
    });
  });

  it('returns 403 when tenant context is missing', async () => {
    const app = createApp();
    mockGetCurrentTenantId.mockReturnValue(null);

    await request(app).get('/api/agents').expect(403, {
      success: false,
      error: 'Tenant context required',
    });
  });

  it('returns the existing success envelope for agent details', async () => {
    const app = createApp();

    await request(app)
      .get('/api/agents/alpha-agent?projectId=project-1')
      .expect(200, {
        success: true,
        agent: {
          id: 'alpha-agent',
          name: 'alpha-agent',
          dslContent: 'AGENT: alpha-agent\nGOAL: "Help users"',
        },
      });

    expect(mockFindProjectAgentByName).toHaveBeenCalledWith('alpha-agent', {
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
    expect(mockBuildAgentDetails).toHaveBeenCalledWith(
      'AGENT: alpha-agent\nGOAL: "Help users"',
      'alpha-agent',
    );
  });

  it('requires project scope for legacy agent detail lookups', async () => {
    const app = createApp();

    await request(app).get('/api/agents/alpha-agent').expect(400, {
      success: false,
      error: 'projectId query parameter is required for agent detail lookup',
    });

    expect(mockFindProjectAgentByName).not.toHaveBeenCalled();
  });

  it('returns 404 when the agent is missing', async () => {
    const app = createApp();
    mockFindProjectAgentByName.mockResolvedValue(null);

    await request(app).get('/api/agents/missing-agent?projectId=project-1').expect(404, {
      success: false,
      error: 'Agent not found: missing-agent',
    });
  });

  it('returns 500 when agent DSL compilation fails', async () => {
    const app = createApp();
    mockBuildAgentDetails.mockReturnValue(null);

    await request(app).get('/api/agents/alpha-agent?projectId=project-1').expect(500, {
      success: false,
      error: 'Failed to compile agent DSL',
    });
  });

  it('returns 500 with the existing envelope on repository errors', async () => {
    const app = createApp();
    mockFindProjectAgentByName.mockRejectedValue(new Error('lookup failed'));

    await request(app).get('/api/agents/alpha-agent?projectId=project-1').expect(500, {
      success: false,
      error: 'Failed to load agent',
    });

    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
