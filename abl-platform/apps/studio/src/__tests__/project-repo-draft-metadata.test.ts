import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeProjectAgentDraftSourceHash } from '@agent-platform/project-io/project-agent-draft-metadata';

const {
  ensureDbMock,
  projectAgentCreateMock,
  projectAgentDeleteOneMock,
  projectAgentFindOneMock,
  projectAgentFindOneAndUpdateMock,
  projectFindOneMock,
  agentVersionCreateMock,
  refreshPersistedStudioProjectAgentDraftMetadataMock,
} = vi.hoisted(() => ({
  ensureDbMock: vi.fn(),
  projectAgentCreateMock: vi.fn(),
  projectAgentDeleteOneMock: vi.fn(),
  projectAgentFindOneMock: vi.fn(),
  projectAgentFindOneAndUpdateMock: vi.fn(),
  projectFindOneMock: vi.fn(),
  agentVersionCreateMock: vi.fn(),
  refreshPersistedStudioProjectAgentDraftMetadataMock: vi.fn(),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: (...args: unknown[]) => ensureDbMock(...args),
}));

vi.mock('@/lib/abl/project-agent-draft-metadata', () => ({
  refreshPersistedStudioProjectAgentDraftMetadata: (...args: unknown[]) =>
    refreshPersistedStudioProjectAgentDraftMetadataMock(...args),
}));

vi.mock('@/repos/project-member-repo', () => ({
  deleteProjectMembersByProjectIds: vi.fn(),
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectAgent: {
    create: (...args: unknown[]) => projectAgentCreateMock(...args),
    deleteOne: (...args: unknown[]) => projectAgentDeleteOneMock(...args),
    findOne: (...args: unknown[]) => ({
      lean: () => projectAgentFindOneMock(...args),
    }),
    findOneAndUpdate: (...args: unknown[]) => ({
      lean: () => projectAgentFindOneAndUpdateMock(...args),
    }),
  },
  Project: {
    findOne: (...args: unknown[]) => ({
      lean: () => projectFindOneMock(...args),
    }),
  },
  AgentVersion: {
    create: (...args: unknown[]) => agentVersionCreateMock(...args),
  },
}));

import {
  createProjectAgent,
  deleteProjectAgent,
  findProjectAgentByIdAndTenant,
  updateProjectAgent,
} from '@/repos/project-repo';

describe('project-repo draft metadata refresh', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ensureDbMock.mockResolvedValue(undefined);
    agentVersionCreateMock.mockResolvedValue({});
    refreshPersistedStudioProjectAgentDraftMetadataMock.mockResolvedValue(new Map());
  });

  it('refreshes project draft metadata after creating an agent with DSL content', async () => {
    projectAgentCreateMock.mockResolvedValue({
      _id: 'agent-1',
      toObject: () => ({
        _id: 'agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'BookingAgent',
        agentPath: 'proj-1/default/BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
      }),
    });
    projectAgentFindOneMock.mockResolvedValue({
      _id: 'agent-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'BookingAgent',
      agentPath: 'proj-1/default/BookingAgent',
      dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
      dslValidationStatus: 'valid',
      dslDiagnostics: [],
    });

    const result = await createProjectAgent({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'BookingAgent',
      agentPath: 'proj-1/default/BookingAgent',
      dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
    });

    expect(projectAgentCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(agentVersionCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        status: 'draft',
        dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        changelog: 'Created project agent DSL snapshot',
      }),
    );
    expect(refreshPersistedStudioProjectAgentDraftMetadataMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(projectAgentFindOneMock).toHaveBeenCalledWith({
      _id: 'agent-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(result).toMatchObject({
      id: 'agent-1',
      dslValidationStatus: 'valid',
    });
  });

  it('derives canonical agentPath during direct repo creates', async () => {
    projectAgentCreateMock.mockResolvedValue({
      _id: 'agent-1',
      toObject: () => ({
        _id: 'agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'BookingAgent',
        agentPath: 'proj-1/BookingAgent',
      }),
    });
    projectAgentFindOneMock.mockResolvedValue({
      _id: 'agent-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'BookingAgent',
      agentPath: 'proj-1/BookingAgent',
    });

    await createProjectAgent({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'BookingAgent',
      agentPath: 'legacy-domain/BookingAgent',
    });

    expect(projectAgentCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        name: 'BookingAgent',
        agentPath: 'proj-1/BookingAgent',
      }),
    );
  });

  it('scopes project-agent ID lookups by tenant before checking the parent project', async () => {
    projectAgentFindOneMock.mockResolvedValue({
      _id: 'agent-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'BookingAgent',
      dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
    });
    projectFindOneMock.mockResolvedValue({ _id: 'proj-1' });

    const result = await findProjectAgentByIdAndTenant('agent-1', 'tenant-1');

    expect(projectAgentFindOneMock).toHaveBeenCalledWith({
      _id: 'agent-1',
      tenantId: 'tenant-1',
    });
    expect(result).toMatchObject({ id: 'agent-1', tenantId: 'tenant-1' });
  });

  it('computes companion-aware sourceHash when creating an agent with a prompt library ref', async () => {
    projectAgentCreateMock.mockResolvedValue({
      _id: 'agent-1',
      toObject: () => ({
        _id: 'agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'BookingAgent',
        agentPath: 'proj-1/default/BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
        },
      }),
    });
    projectAgentFindOneMock.mockResolvedValue({
      _id: 'agent-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'BookingAgent',
      agentPath: 'proj-1/default/BookingAgent',
      dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
      systemPromptLibraryRef: {
        promptId: 'prompt-1',
        versionId: 'version-1',
      },
      dslValidationStatus: 'valid',
      dslDiagnostics: [],
    });

    await createProjectAgent({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'BookingAgent',
      agentPath: 'proj-1/default/BookingAgent',
      dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
      systemPromptLibraryRef: {
        promptId: 'prompt-1',
        versionId: 'version-1',
      },
    });

    expect(projectAgentCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceHash: computeProjectAgentDraftSourceHash({
          recordName: 'BookingAgent',
          dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        }),
      }),
    );
  });

  it('refreshes project draft metadata after updating DSL content without explicit diagnostics', async () => {
    projectAgentFindOneMock
      .mockResolvedValueOnce({
        _id: 'agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "Old goal"\n',
      })
      .mockResolvedValueOnce({
        _id: 'agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "New goal"\n',
        dslValidationStatus: 'valid',
        dslDiagnostics: [],
      });
    projectFindOneMock.mockResolvedValue({ _id: 'proj-1' });
    projectAgentFindOneAndUpdateMock.mockResolvedValue({
      _id: 'agent-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'BookingAgent',
      dslContent: 'AGENT: BookingAgent\nGOAL: "New goal"\n',
    });

    const result = await updateProjectAgent(
      'agent-1',
      { dslContent: 'AGENT: BookingAgent\nGOAL: "New goal"\n' },
      'tenant-1',
    );

    expect(projectAgentFindOneMock).toHaveBeenNthCalledWith(1, {
      _id: 'agent-1',
      tenantId: 'tenant-1',
    });
    expect(projectAgentFindOneAndUpdateMock).toHaveBeenCalledWith(
      { _id: 'agent-1', projectId: 'proj-1', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          dslContent: 'AGENT: BookingAgent\nGOAL: "New goal"\n',
          sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      },
      { new: true },
    );
    expect(agentVersionCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        status: 'draft',
        dslContent: 'AGENT: BookingAgent\nGOAL: "New goal"\n',
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        changelog: 'Updated project agent DSL snapshot',
      }),
    );
    expect(refreshPersistedStudioProjectAgentDraftMetadataMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(result).toMatchObject({
      id: 'agent-1',
      dslValidationStatus: 'valid',
    });
  });

  it('refreshes project draft metadata after updating DSL content with explicit diagnostics', async () => {
    projectAgentFindOneMock
      .mockResolvedValueOnce({
        _id: 'agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "Old goal"\n',
      })
      .mockResolvedValueOnce({
        _id: 'agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "New goal"\n',
        dslValidationStatus: 'valid',
        dslDiagnostics: [],
      });
    projectFindOneMock.mockResolvedValue({ _id: 'proj-1' });
    projectAgentFindOneAndUpdateMock.mockResolvedValue({
      _id: 'agent-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'BookingAgent',
      dslContent: 'AGENT: BookingAgent\nGOAL: "New goal"\n',
      dslValidationStatus: 'warning',
      dslDiagnostics: [{ severity: 'warning', message: 'save warning', source: 'studio-save' }],
    });

    await updateProjectAgent(
      'agent-1',
      {
        dslContent: 'AGENT: BookingAgent\nGOAL: "New goal"\n',
        dslValidationStatus: 'warning',
        dslDiagnostics: [{ severity: 'warning', message: 'save warning', source: 'studio-save' }],
      },
      'tenant-1',
    );

    expect(refreshPersistedStudioProjectAgentDraftMetadataMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });

  it('recomputes companion-aware sourceHash when only systemPromptLibraryRef changes', async () => {
    projectAgentFindOneMock
      .mockResolvedValueOnce({
        _id: 'agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
        },
      })
      .mockResolvedValueOnce({
        _id: 'agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-2',
        },
        dslValidationStatus: 'valid',
        dslDiagnostics: [],
      });
    projectFindOneMock.mockResolvedValue({ _id: 'proj-1' });
    projectAgentFindOneAndUpdateMock.mockResolvedValue({
      _id: 'agent-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'BookingAgent',
      dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
      systemPromptLibraryRef: {
        promptId: 'prompt-1',
        versionId: 'version-2',
      },
    });

    await updateProjectAgent(
      'agent-1',
      {
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-2',
        },
      },
      'tenant-1',
    );

    expect(projectAgentFindOneAndUpdateMock).toHaveBeenCalledWith(
      { _id: 'agent-1', projectId: 'proj-1', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-2',
          },
          sourceHash: computeProjectAgentDraftSourceHash({
            recordName: 'BookingAgent',
            dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
            systemPromptLibraryRef: {
              promptId: 'prompt-1',
              versionId: 'version-2',
            },
          }),
        }),
      },
      { new: true },
    );
  });

  it('refreshes project draft metadata after renaming an agent without DSL changes', async () => {
    projectAgentFindOneMock
      .mockResolvedValueOnce({
        _id: 'agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'BookingAgent',
        agentPath: 'proj-1/default/BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
      })
      .mockResolvedValueOnce({
        _id: 'agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'SupportAgent',
        agentPath: 'proj-1/default/SupportAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
        dslValidationStatus: 'warning',
        dslDiagnostics: [{ severity: 'warning', message: 'rename warning', source: 'studio-repo' }],
      });
    projectFindOneMock.mockResolvedValue({ _id: 'proj-1' });
    projectAgentFindOneAndUpdateMock.mockResolvedValue({
      _id: 'agent-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'SupportAgent',
      agentPath: 'proj-1/default/SupportAgent',
      dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
    });

    const result = await updateProjectAgent(
      'agent-1',
      {
        name: 'SupportAgent',
        agentPath: 'proj-1/default/SupportAgent',
      },
      'tenant-1',
    );

    expect(refreshPersistedStudioProjectAgentDraftMetadataMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(result).toMatchObject({
      id: 'agent-1',
      name: 'SupportAgent',
      dslValidationStatus: 'warning',
    });
  });

  it('repairs direct repo agentPath updates to the canonical project/name path', async () => {
    projectAgentFindOneMock
      .mockResolvedValueOnce({
        _id: 'agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'BookingAgent',
        agentPath: 'legacy-domain/BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
      })
      .mockResolvedValueOnce({
        _id: 'agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'BookingAgent',
        agentPath: 'proj-1/BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
        dslValidationStatus: 'valid',
        dslDiagnostics: [],
      });
    projectFindOneMock.mockResolvedValue({ _id: 'proj-1' });
    projectAgentFindOneAndUpdateMock.mockResolvedValue({
      _id: 'agent-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'BookingAgent',
      agentPath: 'proj-1/BookingAgent',
      dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
    });

    await updateProjectAgent('agent-1', { agentPath: 'attacker/path' }, 'tenant-1');

    expect(projectAgentFindOneAndUpdateMock).toHaveBeenCalledWith(
      { _id: 'agent-1', projectId: 'proj-1', tenantId: 'tenant-1' },
      {
        $set: expect.objectContaining({
          agentPath: 'proj-1/BookingAgent',
        }),
      },
      { new: true },
    );
  });

  it('refreshes project draft metadata after deleting an agent', async () => {
    projectAgentFindOneMock.mockResolvedValue({
      _id: 'agent-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      name: 'BookingAgent',
      dslContent: 'AGENT: BookingAgent\nGOAL: "Book trips"\n',
    });
    projectFindOneMock.mockResolvedValue({ _id: 'proj-1' });
    projectAgentDeleteOneMock.mockResolvedValue({ deletedCount: 1 });

    await deleteProjectAgent('agent-1', 'tenant-1');

    expect(projectAgentFindOneMock).toHaveBeenCalledWith({
      _id: 'agent-1',
      tenantId: 'tenant-1',
    });
    expect(projectAgentDeleteOneMock).toHaveBeenCalledWith({
      _id: 'agent-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(refreshPersistedStudioProjectAgentDraftMetadataMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });
});
