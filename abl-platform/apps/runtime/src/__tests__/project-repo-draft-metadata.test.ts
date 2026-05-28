import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  projectAgentFindOneMock,
  projectAgentFindMock,
  projectAgentBulkWriteMock,
  projectConfigVariableFindMock,
  mergeProjectAgentDraftStatesMock,
  evaluateRuntimeProjectAgentDraftsMock,
} = vi.hoisted(() => ({
  projectAgentFindOneMock: vi.fn(),
  projectAgentFindMock: vi.fn(),
  projectAgentBulkWriteMock: vi.fn(),
  projectConfigVariableFindMock: vi.fn(),
  mergeProjectAgentDraftStatesMock: vi.fn(),
  evaluateRuntimeProjectAgentDraftsMock: vi.fn(),
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectAgent: {
    findOne: (...args: unknown[]) => ({
      lean: () => projectAgentFindOneMock(...args),
    }),
    find: (...args: unknown[]) => ({
      lean: () => projectAgentFindMock(...args),
    }),
    bulkWrite: (...args: unknown[]) => projectAgentBulkWriteMock(...args),
  },
  ProjectConfigVariable: {
    find: (...args: unknown[]) => ({
      lean: () => projectConfigVariableFindMock(...args),
    }),
  },
}));

vi.mock('../services/session/project-agent-draft-metadata.js', () => ({
  mergeProjectAgentDraftStates: (...args: unknown[]) => mergeProjectAgentDraftStatesMock(...args),
  evaluateRuntimeProjectAgentDrafts: (...args: unknown[]) =>
    evaluateRuntimeProjectAgentDraftsMock(...args),
}));

import { updateProjectAgentDsl } from '../repos/project-repo.js';

describe('runtime project-repo draft metadata parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    projectAgentFindOneMock
      .mockResolvedValueOnce({
        _id: 'agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "Old goal"\n',
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
        dslContent: 'AGENT: BookingAgent\nGOAL: "New goal"\n',
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
        },
        sourceHash: 'companion-aware-hash',
      });

    projectAgentFindMock.mockResolvedValue([
      {
        _id: 'agent-1',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "Old goal"\n',
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
        },
      },
    ]);

    projectConfigVariableFindMock.mockResolvedValue([]);

    mergeProjectAgentDraftStatesMock.mockReturnValue([
      {
        recordName: 'BookingAgent',
        dslContent: 'AGENT: BookingAgent\nGOAL: "New goal"\n',
        systemPromptLibraryRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
        },
      },
    ]);

    evaluateRuntimeProjectAgentDraftsMock.mockResolvedValue(
      new Map([
        [
          'BookingAgent',
          {
            sourceHash: 'companion-aware-hash',
            dslValidationStatus: 'valid',
            dslDiagnostics: [],
          },
        ],
      ]),
    );

    projectAgentBulkWriteMock.mockResolvedValue({ modifiedCount: 1 });
  });

  it('preserves the current prompt companion when recomputing runtime DSL-save metadata', async () => {
    const result = await updateProjectAgentDsl(
      'agent-1',
      'AGENT: BookingAgent\nGOAL: "New goal"\n',
      'tenant-1',
    );

    expect(mergeProjectAgentDraftStatesMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'BookingAgent',
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        }),
      ]),
      [
        {
          recordName: 'BookingAgent',
          dslContent: 'AGENT: BookingAgent\nGOAL: "New goal"\n',
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
          },
        },
      ],
    );

    expect(projectAgentBulkWriteMock).toHaveBeenCalledWith([
      {
        updateOne: {
          filter: {
            _id: 'agent-1',
            projectId: 'proj-1',
            tenantId: 'tenant-1',
          },
          update: {
            $set: {
              dslContent: 'AGENT: BookingAgent\nGOAL: "New goal"\n',
              sourceHash: 'companion-aware-hash',
              dslValidationStatus: 'valid',
              dslDiagnostics: [],
            },
          },
        },
      },
    ]);

    expect(result).toMatchObject({
      _id: 'agent-1',
      sourceHash: 'companion-aware-hash',
    });
  });
});
