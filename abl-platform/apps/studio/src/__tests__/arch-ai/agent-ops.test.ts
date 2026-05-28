import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPermissionContext } from '@/lib/arch-ai/guards';

const { findProjectAgentMock, deleteProjectAgentMock, getProjectAgentsMock, projectFindOneMock } =
  vi.hoisted(() => ({
    findProjectAgentMock: vi.fn(),
    deleteProjectAgentMock: vi.fn(),
    getProjectAgentsMock: vi.fn(),
    projectFindOneMock: vi.fn(),
  }));

vi.mock('@/repos/project-repo', () => ({
  findProjectAgent: findProjectAgentMock,
  deleteProjectAgent: deleteProjectAgentMock,
  updateProjectAgent: vi.fn(),
}));

vi.mock('@/services/project-service', () => ({
  getProjectAgents: getProjectAgentsMock,
  addAgentToProject: vi.fn(),
}));

vi.mock('@agent-platform/database/models', () => ({
  Project: {
    findOne: (...args: unknown[]) => ({
      lean: () => projectFindOneMock(...args),
    }),
  },
}));

const TOOL_CONTEXT: ToolPermissionContext = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  authToken: 'token-1',
  user: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    permissions: ['agent:read', 'agent:update', 'agent:delete'],
  },
};

describe('agent_ops', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('lists agents in the project', async () => {
    getProjectAgentsMock.mockResolvedValue([
      { name: 'Refund', dslContent: 'AGENT: Refund\n' },
      { name: 'Router', dslContent: 'SUPERVISOR: Router\n' },
    ]);

    const { executeAgentOps } = await import('@/lib/arch-ai/tools/agent-ops');
    const result = await executeAgentOps({ action: 'list' }, TOOL_CONTEXT);

    expect(result.success).toBe(true);
    expect(getProjectAgentsMock).toHaveBeenCalledWith('proj-1', 'tenant-1');
    expect(result.data).toMatchObject({
      count: 2,
      agents: expect.arrayContaining([
        expect.objectContaining({ name: 'Refund', hasDsl: true }),
        expect.objectContaining({ name: 'Router', hasDsl: true }),
      ]),
    });
  });

  it('returns needsConfirmation when delete is unconfirmed', async () => {
    const { executeAgentOps } = await import('@/lib/arch-ai/tools/agent-ops');
    const result = await executeAgentOps({ action: 'delete', agentName: 'Refund' }, TOOL_CONTEXT);

    expect(result.needsConfirmation).toBe(true);
    expect(deleteProjectAgentMock).not.toHaveBeenCalled();
    expect(findProjectAgentMock).not.toHaveBeenCalled();
  });

  it('blocks confirmed direct deletes when plan enforcement is enabled without an approved plan', async () => {
    const { executeAgentOps } = await import('@/lib/arch-ai/tools/agent-ops');
    const result = await executeAgentOps(
      { action: 'delete', agentName: 'Refund', confirmed: true },
      { ...TOOL_CONTEXT, requireApprovedPlanForMutation: true },
    );

    expect(result.success).toBe(false);
    expect(result.error).toEqual({
      code: 'PLAN_REQUIRED',
      message: 'Plan required before mutation. Call propose_plan first.',
    });
    expect(deleteProjectAgentMock).not.toHaveBeenCalled();
    expect(findProjectAgentMock).not.toHaveBeenCalled();
  });

  it('blocks raw DSL mutations when canonical-blueprint mode is enabled', async () => {
    projectFindOneMock.mockResolvedValue({
      archConfig: { canonicalBlueprintMode: true },
    });

    const { executeAgentOps } = await import('@/lib/arch-ai/tools/agent-ops');
    const result = await executeAgentOps(
      { action: 'delete', agentName: 'Refund', confirmed: true },
      TOOL_CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.error).toEqual({
      code: 'CANONICAL_BLUEPRINT_MODE',
      message:
        'This project is in canonical-blueprint mode. Use propose_blueprint_edit, or explicitly enable manual-drift mode before raw DSL edits.',
    });
    expect(projectFindOneMock).toHaveBeenCalledWith(
      { _id: 'proj-1', tenantId: 'tenant-1' },
      { archConfig: 1 },
    );
    expect(deleteProjectAgentMock).not.toHaveBeenCalled();
    expect(findProjectAgentMock).not.toHaveBeenCalled();
  });

  it('returns FORBIDDEN when permission missing', async () => {
    const noPerm: ToolPermissionContext = {
      ...TOOL_CONTEXT,
      user: { ...TOOL_CONTEXT.user, permissions: [] },
    };

    const { executeAgentOps } = await import('@/lib/arch-ai/tools/agent-ops');
    const result = await executeAgentOps({ action: 'list' }, noPerm);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');
    expect(getProjectAgentsMock).not.toHaveBeenCalled();
  });
});
