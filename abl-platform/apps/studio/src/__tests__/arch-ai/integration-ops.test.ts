import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPermissionContext } from '@/lib/arch-ai/guards';

const {
  createOrResumeIntegrationDraftMock,
  getActiveIntegrationDraftForSessionMock,
  getIntegrationDraftByIdMock,
  listIntegrationDraftsMock,
  mergeIntoIntegrationDraftMock,
  completeIntegrationDraftMock,
  archiveIntegrationDraftMock,
  executeToolsOpsMock,
  invalidateProjectCachesMock,
} = vi.hoisted(() => ({
  createOrResumeIntegrationDraftMock: vi.fn(),
  getActiveIntegrationDraftForSessionMock: vi.fn(),
  getIntegrationDraftByIdMock: vi.fn(),
  listIntegrationDraftsMock: vi.fn(),
  mergeIntoIntegrationDraftMock: vi.fn(),
  completeIntegrationDraftMock: vi.fn(),
  archiveIntegrationDraftMock: vi.fn(),
  executeToolsOpsMock: vi.fn(),
  invalidateProjectCachesMock: vi.fn(),
}));

vi.mock('@/lib/arch-ai/integration-draft-service', () => ({
  createOrResumeIntegrationDraft: createOrResumeIntegrationDraftMock,
  getActiveIntegrationDraftForSession: getActiveIntegrationDraftForSessionMock,
  getIntegrationDraftById: getIntegrationDraftByIdMock,
  listIntegrationDrafts: listIntegrationDraftsMock,
  mergeIntoIntegrationDraft: mergeIntoIntegrationDraftMock,
  completeIntegrationDraft: completeIntegrationDraftMock,
  archiveIntegrationDraft: archiveIntegrationDraftMock,
}));

vi.mock('@/lib/arch-ai/tools/tools-ops', () => ({
  executeToolsOps: executeToolsOpsMock,
}));

vi.mock('@/lib/arch-ai/tools/cache-invalidation', () => ({
  invalidateProjectCaches: invalidateProjectCachesMock,
}));

const TOOL_CONTEXT: ToolPermissionContext = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  authToken: 'token-1',
  user: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    permissions: ['project:read', 'project:update', 'tool:execute'],
  },
};

describe('integration_ops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts or resumes an integration draft for the active session', async () => {
    createOrResumeIntegrationDraftMock.mockResolvedValue({
      id: 'draft-1',
      title: 'CRM Integration',
      providerKey: 'salesforce',
      status: 'needs_input',
    });

    const { executeIntegrationOps } = await import('@/lib/arch-ai/tools/integration-ops');
    const result = await executeIntegrationOps(
      {
        action: 'start',
        title: 'CRM Integration',
        providerKey: 'salesforce',
        pendingSteps: ['collect_auth', 'create_vars'],
        targetAgentNames: ['RouterAgent'],
      },
      TOOL_CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(createOrResumeIntegrationDraftMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      source: 'in_project',
      title: 'CRM Integration',
      providerKey: 'salesforce',
      targetAgentNames: ['RouterAgent'],
      pendingSteps: ['collect_auth', 'create_vars'],
      lastIntentSummary: null,
    });
    expect(invalidateProjectCachesMock).toHaveBeenCalledWith('tenant-1', 'proj-1');
  });

  it('runs a tool test and advances the active draft when the final test step clears', async () => {
    getActiveIntegrationDraftForSessionMock.mockResolvedValue({
      id: 'draft-2',
      pendingSteps: ['run_tool_test'],
      toolIds: ['tool-1'],
    });
    executeToolsOpsMock.mockResolvedValue({
      success: true,
      data: { passed: true, output: { ok: true } },
    });
    mergeIntoIntegrationDraftMock.mockResolvedValue({
      id: 'draft-2',
      status: 'ready_to_apply',
      pendingSteps: [],
    });

    const { executeIntegrationOps } = await import('@/lib/arch-ai/tools/integration-ops');
    const result = await executeIntegrationOps(
      {
        action: 'run_tool_test',
        testInput: { customer_id: 'cust-1' },
      },
      TOOL_CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(executeToolsOpsMock).toHaveBeenCalledWith(
      {
        action: 'test',
        toolId: 'tool-1',
        testInput: { customer_id: 'cust-1' },
      },
      TOOL_CONTEXT,
    );
    expect(mergeIntoIntegrationDraftMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      draftId: 'draft-2',
      pendingSteps: [],
      status: 'ready_to_apply',
    });
    expect(result.data).toMatchObject({
      test: { passed: true, output: { ok: true } },
      draft: { id: 'draft-2', status: 'ready_to_apply' },
    });
  });
});
