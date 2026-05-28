import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  projectStateSummaryLoader,
  activeDraftSnapshotLoader,
  __resetProjectStateCacheForTests,
} from '../runtime-support';

describe('projectStateSummaryLoader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __resetProjectStateCacheForTests();
  });

  it('returns markdown summary mentioning agents/tools/profiles when seeded data exists', async () => {
    const { ProjectAgent, ProjectTool, AuthProfile, MCPServerConfig, ArchIntegrationDraft } =
      await import('@agent-platform/database/models');

    vi.spyOn(ProjectAgent, 'find').mockReturnValue({
      select: () => ({ lean: async () => [{ name: 'support' }, { name: 'router' }] }),
    } as unknown as ReturnType<typeof ProjectAgent.find>);

    vi.spyOn(ProjectTool, 'find').mockReturnValue({
      select: () => ({
        lean: async () => [{ name: 'lookup', toolType: 'http' }],
      }),
    } as unknown as ReturnType<typeof ProjectTool.find>);

    vi.spyOn(AuthProfile, 'find').mockReturnValue({
      select: () => ({
        lean: async () => [{ name: 'slack-prod', authType: 'oauth2' }],
      }),
    } as unknown as ReturnType<typeof AuthProfile.find>);

    vi.spyOn(MCPServerConfig, 'find').mockReturnValue({
      select: () => ({ lean: async () => [{ name: 'docs-mcp' }] }),
    } as unknown as ReturnType<typeof MCPServerConfig.find>);

    vi.spyOn(ArchIntegrationDraft, 'find').mockReturnValue({
      select: () => ({
        lean: async () => [{ providerKey: 'slack', status: 'ready_to_test', title: 'Slack' }],
      }),
    } as unknown as ReturnType<typeof ArchIntegrationDraft.find>);

    const result = await projectStateSummaryLoader({ tenantId: 't1' }, 'p1');

    expect(result).not.toBeNull();
    expect(result).toContain('## Project State');
    expect(result).toContain('support, router');
    expect(result).toContain('1 ProjectTool');
    expect(result).toContain('slack-prod (oauth2)');
    expect(result).toContain('docs-mcp');
    expect(result).toContain('slack (ready_to_test)');
  });

  it('returns the same cached result twice within the TTL window', async () => {
    const { ProjectAgent, ProjectTool, AuthProfile, MCPServerConfig, ArchIntegrationDraft } =
      await import('@agent-platform/database/models');

    const agentSpy = vi.spyOn(ProjectAgent, 'find').mockReturnValue({
      select: () => ({ lean: async () => [{ name: 'a1' }] }),
    } as unknown as ReturnType<typeof ProjectAgent.find>);
    vi.spyOn(ProjectTool, 'find').mockReturnValue({
      select: () => ({ lean: async () => [] }),
    } as unknown as ReturnType<typeof ProjectTool.find>);
    vi.spyOn(AuthProfile, 'find').mockReturnValue({
      select: () => ({ lean: async () => [] }),
    } as unknown as ReturnType<typeof AuthProfile.find>);
    vi.spyOn(MCPServerConfig, 'find').mockReturnValue({
      select: () => ({ lean: async () => [] }),
    } as unknown as ReturnType<typeof MCPServerConfig.find>);
    vi.spyOn(ArchIntegrationDraft, 'find').mockReturnValue({
      select: () => ({ lean: async () => [] }),
    } as unknown as ReturnType<typeof ArchIntegrationDraft.find>);

    const r1 = await projectStateSummaryLoader({ tenantId: 't1' }, 'p-cache');
    const r2 = await projectStateSummaryLoader({ tenantId: 't1' }, 'p-cache');

    expect(r1).toBe(r2);
    // Cache hit: ProjectAgent.find should only have been invoked once.
    expect(agentSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null when tenantId or projectId is missing', async () => {
    const result = await projectStateSummaryLoader({ tenantId: '' }, 'p1');
    expect(result).toBeNull();
  });
});

describe('activeDraftSnapshotLoader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when the session has no active integration draft', async () => {
    const { ArchSession } = await import('@agent-platform/database/models');

    vi.spyOn(ArchSession, 'findOne').mockReturnValue({
      select: () => ({ lean: async () => ({ metadata: {} }) }),
    } as unknown as ReturnType<typeof ArchSession.findOne>);

    const result = await activeDraftSnapshotLoader({ tenantId: 't1' }, 's-no-draft');
    expect(result).toBeNull();
  });

  it('returns formatted snapshot when an active draft pointer is set', async () => {
    const { ArchSession, ArchIntegrationDraft } = await import('@agent-platform/database/models');

    vi.spyOn(ArchSession, 'findOne').mockReturnValue({
      select: () => ({
        lean: async () => ({ metadata: { activeIntegrationDraftId: 'draft_1' } }),
      }),
    } as unknown as ReturnType<typeof ArchSession.findOne>);

    vi.spyOn(ArchIntegrationDraft, 'findOne').mockReturnValue({
      lean: async () => ({
        _id: 'draft_1',
        providerKey: 'slack',
        status: 'ready_to_test',
        title: 'Slack integration',
        authProfileIds: ['ap_1'],
        toolIds: ['t_1', 't_2'],
        connectionIds: ['c_1'],
        targetAgentNames: ['support'],
        pendingSteps: ['run smoke test'],
        lastTestStatus: 'pass',
        lastTestAt: new Date('2026-05-01T12:00:00Z'),
      }),
    } as unknown as ReturnType<typeof ArchIntegrationDraft.findOne>);

    const result = await activeDraftSnapshotLoader({ tenantId: 't1' }, 's-with-draft');

    expect(result).not.toBeNull();
    expect(result).toContain('## Active Integration');
    expect(result).toContain('Provider: slack');
    expect(result).toContain('Status: ready_to_test');
    expect(result).toContain('Auth profiles: 1');
    expect(result).toContain('Tools: 2');
    expect(result).toContain('Wired agents: support');
    expect(result).toContain('Pending steps: run smoke test');
    expect(result).toContain('Last test: pass');
  });
});
