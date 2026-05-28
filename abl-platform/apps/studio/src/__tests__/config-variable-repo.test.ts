import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  ensureDbMock,
  projectConfigVariableCreateMock,
  projectConfigVariableFindOneAndDeleteMock,
  projectConfigVariableFindOneAndUpdateMock,
  refreshProjectAgentDraftMetadataForConfigMutationMock,
} = vi.hoisted(() => ({
  ensureDbMock: vi.fn(),
  projectConfigVariableCreateMock: vi.fn(),
  projectConfigVariableFindOneAndDeleteMock: vi.fn(),
  projectConfigVariableFindOneAndUpdateMock: vi.fn(),
  refreshProjectAgentDraftMetadataForConfigMutationMock: vi.fn(),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: (...args: unknown[]) => ensureDbMock(...args),
}));

vi.mock('@/lib/project-config-draft-invalidation', () => ({
  refreshProjectAgentDraftMetadataForConfigMutation: (...args: unknown[]) =>
    refreshProjectAgentDraftMetadataForConfigMutationMock(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectConfigVariable: {
    create: (...args: unknown[]) => projectConfigVariableCreateMock(...args),
    findOneAndUpdate: (...args: unknown[]) => ({
      lean: () => projectConfigVariableFindOneAndUpdateMock(...args),
    }),
    findOneAndDelete: (...args: unknown[]) => projectConfigVariableFindOneAndDeleteMock(...args),
  },
}));

import {
  createConfigVariable,
  deleteConfigVariable,
  updateConfigVariable,
} from '@/repos/config-variable-repo';

describe('config-variable-repo draft invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureDbMock.mockResolvedValue(undefined);
    refreshProjectAgentDraftMetadataForConfigMutationMock.mockResolvedValue(undefined);
  });

  it('refreshes persisted project draft metadata after create', async () => {
    projectConfigVariableCreateMock.mockResolvedValue({
      toObject: () => ({
        _id: 'var-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        key: 'API_URL',
        value: 'https://example.com',
      }),
    });

    await createConfigVariable({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      key: 'API_URL',
      value: 'https://example.com',
      createdBy: 'user-1',
    });

    expect(refreshProjectAgentDraftMetadataForConfigMutationMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
  });

  it('refreshes persisted project draft metadata after update', async () => {
    projectConfigVariableFindOneAndUpdateMock.mockResolvedValue({
      _id: 'var-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      key: 'API_URL',
      value: 'https://next.example.com',
    });

    await updateConfigVariable(
      'var-1',
      'tenant-1',
      {
        value: 'https://next.example.com',
        updatedBy: 'user-1',
      },
      'proj-1',
    );

    expect(refreshProjectAgentDraftMetadataForConfigMutationMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
  });

  it('refreshes persisted project draft metadata after delete', async () => {
    projectConfigVariableFindOneAndDeleteMock.mockResolvedValue({
      _id: 'var-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });

    await deleteConfigVariable('var-1', 'tenant-1', 'proj-1');

    expect(refreshProjectAgentDraftMetadataForConfigMutationMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
  });
});
