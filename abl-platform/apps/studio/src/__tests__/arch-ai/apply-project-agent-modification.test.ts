import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  projectAgentFindOneMock,
  projectAgentFindMock,
  projectAgentUpdateOneMock,
  projectUpdateOneMock,
  agentVersionCreateMock,
  refreshPersistedStudioProjectAgentDraftMetadataMock,
  withTransactionMock,
} = vi.hoisted(() => ({
  projectAgentFindOneMock: vi.fn(),
  projectAgentFindMock: vi.fn(),
  projectAgentUpdateOneMock: vi.fn(),
  projectUpdateOneMock: vi.fn(),
  agentVersionCreateMock: vi.fn(),
  refreshPersistedStudioProjectAgentDraftMetadataMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectAgent: {
    findOne: (...args: unknown[]) => projectAgentFindOneMock(...args),
    find: (...args: unknown[]) => projectAgentFindMock(...args),
    updateOne: (...args: unknown[]) => projectAgentUpdateOneMock(...args),
  },
  Project: {
    updateOne: (...args: unknown[]) => projectUpdateOneMock(...args),
  },
  AgentVersion: {
    create: (...args: unknown[]) => agentVersionCreateMock(...args),
  },
}));

vi.mock('@agent-platform/shared/repos', () => ({
  withTransaction: (...args: unknown[]) => withTransactionMock(...args),
  findMcpServerConfigsByProject: vi.fn(),
}));

vi.mock('@/lib/arch-ai/message-services', () => ({
  sessionService: {},
  journalService: {},
  projectMemoryService: {},
}));

vi.mock('@/lib/arch-ai/tools/build-tools', () => ({
  buildBuildTools: vi.fn(() => ({})),
}));

vi.mock('@/services/project-service', () => ({
  buildProjectAgentPath: vi.fn(
    (projectId: string, agentName: string) => `${projectId}/${agentName}`,
  ),
}));

vi.mock('@/lib/abl/project-agent-draft-metadata', () => ({
  refreshPersistedStudioProjectAgentDraftMetadata: (...args: unknown[]) =>
    refreshPersistedStudioProjectAgentDraftMetadataMock(...args),
}));

import { applyProjectAgentModification } from '@/lib/arch-ai/tools/in-project-tools';

describe('applyProjectAgentModification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectAgentFindOneMock.mockResolvedValue({
      _id: 'agent-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'SupportAgent',
      dslContent: 'AGENT: SupportAgent\nGOAL: "Old goal"\n',
      dslValidationStatus: 'error',
      dslDiagnostics: [
        { severity: 'error', message: 'Old validation error', source: 'studio-repo' },
      ],
    });
    projectAgentFindMock.mockResolvedValue([
      {
        name: 'SupportAgent',
        dslContent: 'AGENT: SupportAgent\nGOAL: "Old goal"\n',
      },
    ]);
    projectAgentUpdateOneMock.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    projectUpdateOneMock.mockResolvedValue({ acknowledged: true, modifiedCount: 0 });
    agentVersionCreateMock.mockResolvedValue({});
    refreshPersistedStudioProjectAgentDraftMetadataMock.mockResolvedValue(new Map());
    withTransactionMock.mockImplementation(
      async (callback: (session?: unknown) => Promise<unknown>) => callback(undefined),
    );
  });

  it('refreshes persisted draft metadata after a successful Arch AI edit', async () => {
    const updatedCode = 'AGENT: SupportAgent\nGOAL: "New goal"\n';

    const result = await applyProjectAgentModification(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'proj-1',
      'SupportAgent',
      updatedCode,
    );

    expect(result).toEqual({
      success: true,
      agentName: 'SupportAgent',
      applied: true,
    });
    expect(projectAgentUpdateOneMock).toHaveBeenCalledWith(
      { _id: 'agent-1', projectId: 'proj-1', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          dslContent: updatedCode,
          sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      },
      {},
    );
    expect(agentVersionCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        status: 'draft',
        dslContent: updatedCode,
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        changelog: 'Applied agent DSL modification',
      }),
    );
    expect(refreshPersistedStudioProjectAgentDraftMetadataMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      session: undefined,
    });
  });
});
