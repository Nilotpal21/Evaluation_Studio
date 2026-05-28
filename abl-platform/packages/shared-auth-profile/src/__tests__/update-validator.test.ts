import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindOne = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: { findOne: mockFindOne },
}));

import { validateAuthProfileUpdate } from '../update-validator.js';

describe('validateAuthProfileUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects authType mutation', async () => {
    await expect(
      validateAuthProfileUpdate({
        existingProfile: { authType: 'bearer', tenantId: 'tenant-1' },
        updatePayload: { authType: 'api_key' },
      }),
    ).rejects.toThrow(/authType cannot be changed/);
  });

  it('rejects linkedAppProfileId updates for non-oauth2_token types', async () => {
    await expect(
      validateAuthProfileUpdate({
        existingProfile: { authType: 'bearer', tenantId: 'tenant-1' },
        updatePayload: { linkedAppProfileId: 'ap-linked' },
      }),
    ).rejects.toThrow(/only valid for oauth2_token/i);
  });

  it('re-validates linked app using scope/visibility/project boundaries', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-new-app',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      scope: 'project',
      visibility: 'shared',
      projectId: 'project-1',
    });

    await expect(
      validateAuthProfileUpdate({
        existingProfile: {
          authType: 'oauth2_token',
          tenantId: 'tenant-1',
          linkedAppProfileId: 'ap-old-app',
          scope: 'project',
          visibility: 'shared',
          projectId: 'project-1',
        },
        updatePayload: { linkedAppProfileId: 'ap-new-app' },
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects oauth2_token updates that clear linkedAppProfileId', async () => {
    await expect(
      validateAuthProfileUpdate({
        existingProfile: {
          authType: 'oauth2_token',
          tenantId: 'tenant-1',
          linkedAppProfileId: 'ap-old-app',
          scope: 'project',
          visibility: 'shared',
          projectId: 'project-1',
        },
        updatePayload: { linkedAppProfileId: null },
      }),
    ).rejects.toThrow(/must reference linkedAppProfileId/);
  });

  it('rejects personal linked-app changes without owner context', async () => {
    await expect(
      validateAuthProfileUpdate({
        existingProfile: {
          authType: 'oauth2_token',
          tenantId: 'tenant-1',
          linkedAppProfileId: 'ap-old-app',
          scope: 'project',
          visibility: 'personal',
          projectId: 'project-1',
        },
        updatePayload: { linkedAppProfileId: 'ap-new-app' },
      }),
    ).rejects.toThrow(/owner context/);
  });

  it('rejects project-scoped linked-app changes when project context is missing', async () => {
    await expect(
      validateAuthProfileUpdate({
        existingProfile: {
          authType: 'oauth2_token',
          tenantId: 'tenant-1',
          linkedAppProfileId: 'ap-old-app',
          scope: 'project',
          visibility: 'shared',
        },
        updatePayload: { linkedAppProfileId: 'ap-new-app' },
      }),
    ).rejects.toThrow(/require a projectId/);
  });

  it('re-validates linked app boundaries when visibility changes', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-linked',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      scope: 'project',
      visibility: 'personal',
      projectId: 'project-1',
      createdBy: 'user-1',
      encryptedSecrets: '{}',
      config: {},
    });

    await expect(
      validateAuthProfileUpdate({
        existingProfile: {
          authType: 'oauth2_token',
          tenantId: 'tenant-1',
          linkedAppProfileId: 'ap-linked',
          scope: 'project',
          visibility: 'shared',
          projectId: 'project-1',
          createdBy: 'user-1',
        },
        updatePayload: { visibility: 'personal' },
      }),
    ).resolves.toBeUndefined();

    expect(mockFindOne).toHaveBeenCalledWith({
      _id: 'ap-linked',
      tenantId: 'tenant-1',
    });
  });
});
