import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPermissionContext } from '@/lib/arch-ai/guards';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { fetchDeploymentsMock, createDeploymentMock, promoteDeploymentMock, fetchMock } = vi.hoisted(
  () => ({
    fetchDeploymentsMock: vi.fn(),
    createDeploymentMock: vi.fn(),
    promoteDeploymentMock: vi.fn(),
    fetchMock: vi.fn(),
  }),
);

vi.mock('@/api/deployments', () => ({
  fetchDeployments: fetchDeploymentsMock,
  createDeployment: createDeploymentMock,
  promoteDeployment: promoteDeploymentMock,
}));

vi.mock('@/config/runtime.server', () => ({
  getRuntimeUrl: () => 'http://runtime.test',
}));

const TOOL_CONTEXT: ToolPermissionContext = {
  projectId: 'proj-1',
  authToken: 'token-1',
  user: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    permissions: ['deployment:read', 'deployment:create', 'channel:read', 'channel:update'],
  },
};

describe('deployment_ops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('lists deployments', async () => {
    fetchDeploymentsMock.mockResolvedValue([{ id: 'dep-1', environment: 'staging' }]);

    const { executeDeploymentOps } = await import('@/lib/arch-ai/tools/deployment-ops');
    const result = await executeDeploymentOps({ action: 'list' }, TOOL_CONTEXT);

    expect(result.success).toBe(true);
    expect(fetchDeploymentsMock).toHaveBeenCalled();
  });

  it('blocks deploy without confirmed flag', async () => {
    const { executeDeploymentOps } = await import('@/lib/arch-ai/tools/deployment-ops');
    const result = await executeDeploymentOps(
      { action: 'deploy', environment: 'production' },
      TOOL_CONTEXT,
    );

    expect(result.needsConfirmation).toBe(true);
  });

  it('lists channels via runtime', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ channels: [{ id: 'chan-1', name: 'Slack', channelType: 'slack' }] }),
    });

    const { executeDeploymentOps } = await import('@/lib/arch-ai/tools/deployment-ops');
    const result = await executeDeploymentOps({ action: 'list_channels' }, TOOL_CONTEXT);

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-1/sdk-channels'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
      }),
    );
  });

  it('blocks configure_channel without confirmed flag', async () => {
    const { executeDeploymentOps } = await import('@/lib/arch-ai/tools/deployment-ops');
    const result = await executeDeploymentOps(
      { action: 'configure_channel', channelType: 'slack', channelConfig: {} },
      TOOL_CONTEXT,
    );

    expect(result.needsConfirmation).toBe(true);
  });
});
