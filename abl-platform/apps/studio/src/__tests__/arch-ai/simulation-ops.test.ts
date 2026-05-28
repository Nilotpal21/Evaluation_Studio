import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPermissionContext } from '@/lib/arch-ai/guards';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock('@/config/runtime.server', () => ({
  getRuntimeUrl: () => 'http://runtime.test',
}));

const TOOL_CONTEXT: ToolPermissionContext = {
  projectId: 'proj-1',
  sessionId: 'arch-session-1',
  authToken: 'user-token-1',
  user: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    permissions: ['session:execute'],
  },
};

describe('simulation_ops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('calls the project-scoped runtime simulation endpoint with forwarded user auth', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () =>
        [
          'event: started',
          'data: {"success":true,"sessionId":"sim-1","agentName":"RefundAgent"}',
          '',
          'event: turn',
          'data: {"index":0,"user":"refund please","response":"Sure"}',
          '',
          'event: trace',
          'data: {"type":"model_response","data":{"simulation":true}}',
          '',
          'event: complete',
          'data: {"success":true,"sessionId":"sim-1","traceEventCount":1}',
          '',
        ].join('\n'),
    });

    const { executeSimulationOps } = await import('@/lib/arch-ai/tools/simulation-ops');
    const result = await executeSimulationOps(
      {
        agentName: 'RefundAgent',
        dslOverride: 'AGENT: RefundAgent\nGOAL: "Refunds"',
        scriptedUserTurns: ['refund please'],
        mockedToolResponses: {
          lookup_order: { success: true, data: { orderId: 'ord-1' } },
        },
        options: { scenarioId: 'scenario-1', intentTags: ['refund'] },
      },
      TOOL_CONTEXT,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        turns: [expect.objectContaining({ response: 'Sure' })],
        traces: [expect.objectContaining({ type: 'model_response' })],
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://runtime.test/api/projects/proj-1/runtime/simulate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer user-token-1',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      agentId: 'RefundAgent',
      dslOverride: 'AGENT: RefundAgent\nGOAL: "Refunds"',
      scriptedUserTurns: ['refund please'],
      mockedToolResponses: {
        lookup_order: { success: true, data: { orderId: 'ord-1' } },
      },
      options: { scenarioId: 'scenario-1', intentTags: ['refund'] },
    });
    expect(body).not.toHaveProperty('projectId');
  });

  it('fails closed when no user auth token is available', async () => {
    const { executeSimulationOps } = await import('@/lib/arch-ai/tools/simulation-ops');
    const result = await executeSimulationOps(
      {
        agentName: 'RefundAgent',
        scriptedUserTurns: ['refund please'],
      },
      { ...TOOL_CONTEXT, authToken: undefined },
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: 'AUTH_REQUIRED' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
