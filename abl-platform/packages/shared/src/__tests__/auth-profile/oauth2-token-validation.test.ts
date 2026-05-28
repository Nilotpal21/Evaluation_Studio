/**
 * Task 12: oauth2_token linkedAppProfileId validation on create
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindOne = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: { findOne: mockFindOne },
}));

import { validateLinkedAppProfile } from '../../services/auth-profile/linked-app-validator.js';

describe('validateLinkedAppProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves when linkedAppProfileId references a valid oauth2_app in same tenant', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-google-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
    });

    await expect(
      validateLinkedAppProfile({
        linkedAppProfileId: 'ap-google-1',
        tenantId: 'tenant-1',
      }),
    ).resolves.toEqual(expect.objectContaining({ _id: 'ap-google-1', authType: 'oauth2_app' }));

    expect(mockFindOne).toHaveBeenCalledWith({
      _id: 'ap-google-1',
      tenantId: 'tenant-1',
    });
  });

  it('rejects when linkedAppProfileId does not exist in tenant', async () => {
    mockFindOne.mockResolvedValue(null);

    await expect(
      validateLinkedAppProfile({
        linkedAppProfileId: 'ap-nonexistent',
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow(/Linked OAuth app must belong to the same tenant/);
  });

  it('rejects when referenced profile has authType !== oauth2_app', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-bearer-1',
      tenantId: 'tenant-1',
      authType: 'bearer',
      status: 'active',
    });

    await expect(
      validateLinkedAppProfile({
        linkedAppProfileId: 'ap-bearer-1',
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow(/must reference a profile with authType 'oauth2_app'/);
  });

  it('rejects when referenced profile has status revoked', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-google-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'revoked',
    });

    await expect(
      validateLinkedAppProfile({
        linkedAppProfileId: 'ap-google-1',
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow(/OAuth app profile is not active/);
  });

  it('rejects when the linked OAuth app profile has expired', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-google-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(
      validateLinkedAppProfile({
        linkedAppProfileId: 'ap-google-1',
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow(/has expired/);
  });

  it('rejects linked personal apps that belong to another owner', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-google-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      scope: 'project',
      visibility: 'personal',
      projectId: 'project-1',
      createdBy: 'other-user',
    });

    await expect(
      validateLinkedAppProfile({
        linkedAppProfileId: 'ap-google-1',
        tenantId: 'tenant-1',
        requiredScope: 'project',
        requiredVisibility: 'personal',
        requiredProjectId: 'project-1',
        requiredOwnerId: 'user-1',
      }),
    ).rejects.toThrow(/same owner/);
  });
});
