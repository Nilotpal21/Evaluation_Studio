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

const { findProjectAgentMock, findEvalSetsPageByProjectMock, createEvalSetMock, fetchMock } =
  vi.hoisted(() => ({
    findProjectAgentMock: vi.fn(),
    findEvalSetsPageByProjectMock: vi.fn(),
    createEvalSetMock: vi.fn(),
    fetchMock: vi.fn(),
  }));

vi.mock('@/repos/project-repo', () => ({
  findProjectAgent: findProjectAgentMock,
}));

vi.mock('@/repos/eval-repo', () => ({
  findEvalSetsPageByProject: findEvalSetsPageByProjectMock,
  createEvalSet: createEvalSetMock,
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
    permissions: ['session:read', 'session:execute'],
  },
};

describe('testing_ops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('runs a test against the live runtime', async () => {
    findProjectAgentMock.mockResolvedValue({ name: 'Refund', dslContent: 'AGENT: Refund\n' });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'Hello', sessionId: 'sess-99' }),
    });

    const { executeTestingOps } = await import('@/lib/arch-ai/tools/testing-ops');
    const result = await executeTestingOps(
      { action: 'run_test', agentName: 'Refund', testMessage: 'hi' },
      TOOL_CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/chat'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('lists eval sets for the project', async () => {
    findEvalSetsPageByProjectMock.mockResolvedValue({
      items: [{ id: 'eval-1', name: 'happy path' }],
      pagination: { limit: 100, nextCursor: null, hasMore: false, total: 1 },
    });

    const { executeTestingOps } = await import('@/lib/arch-ai/tools/testing-ops');
    const result = await executeTestingOps({ action: 'list_evals' }, TOOL_CONTEXT);

    expect(result.success).toBe(true);
    expect(findEvalSetsPageByProjectMock).toHaveBeenCalledWith('proj-1', 'tenant-1', {
      cursor: null,
      limit: 100,
    });
    expect(result.data).toMatchObject({
      evalSets: [{ id: 'eval-1', name: 'happy path', description: null }],
      pagination: { returned: 1, total: 1, truncated: false },
    });
  });

  it('continues listing eval sets past the first page', async () => {
    findEvalSetsPageByProjectMock
      .mockResolvedValueOnce({
        items: [{ id: 'eval-1', name: 'first page' }],
        pagination: { limit: 100, nextCursor: 'cursor-1', hasMore: true, total: 2 },
      })
      .mockResolvedValueOnce({
        items: [{ id: 'eval-2', name: 'second page' }],
        pagination: { limit: 100, nextCursor: null, hasMore: false, total: 2 },
      });

    const { executeTestingOps } = await import('@/lib/arch-ai/tools/testing-ops');
    const result = await executeTestingOps({ action: 'list_evals' }, TOOL_CONTEXT);

    expect(result.success).toBe(true);
    expect(findEvalSetsPageByProjectMock).toHaveBeenNthCalledWith(1, 'proj-1', 'tenant-1', {
      cursor: null,
      limit: 100,
    });
    expect(findEvalSetsPageByProjectMock).toHaveBeenNthCalledWith(2, 'proj-1', 'tenant-1', {
      cursor: 'cursor-1',
      limit: 100,
    });
    expect(result.data).toMatchObject({
      evalSets: [
        { id: 'eval-1', name: 'first page', description: null },
        { id: 'eval-2', name: 'second page', description: null },
      ],
      pagination: { returned: 2, total: 2, truncated: false },
    });
  });

  it('persists eval set name only (Phase 1 caveat)', async () => {
    createEvalSetMock.mockResolvedValue({ id: 'eval-2', name: 'my eval' });

    const { executeTestingOps } = await import('@/lib/arch-ai/tools/testing-ops');
    const result = await executeTestingOps(
      {
        action: 'create_eval',
        evalConfig: {
          name: 'my eval',
          scenarios: [{ input: 'hi', expectedBehavior: 'greet' }],
        },
      },
      TOOL_CONTEXT,
    );

    expect(result.success).toBe(true);
    // Phase 1: scenarios are silently dropped. Verify createEvalSet
    // was called without 'scenarios' in the payload.
    const callArgs = (createEvalSetMock.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('scenarios');
    expect(callArgs).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      name: 'my eval',
      createdBy: 'user-1',
    });
  });
});
