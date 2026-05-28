/**
 * Task 13: Update validator tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindOne = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: { findOne: mockFindOne },
}));

import { validateAuthProfileUpdate } from '../../services/auth-profile/update-validator.js';
import { AuthProfileError } from '../../services/auth-profile/linked-app-validator.js';

describe('validateAuthProfileUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes when no authType change is attempted', async () => {
    await expect(
      validateAuthProfileUpdate({
        existingProfile: { authType: 'bearer', tenantId: 'tenant-1' },
        updatePayload: { name: 'updated-name' },
      }),
    ).resolves.toBeUndefined();
  });

  it('passes when authType matches existing (no mutation)', async () => {
    await expect(
      validateAuthProfileUpdate({
        existingProfile: { authType: 'bearer', tenantId: 'tenant-1' },
        updatePayload: { authType: 'bearer', name: 'updated-name' },
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects authType mutation', async () => {
    await expect(
      validateAuthProfileUpdate({
        existingProfile: { authType: 'bearer', tenantId: 'tenant-1' },
        updatePayload: { authType: 'api_key' },
      }),
    ).rejects.toThrow(/authType cannot be changed/);
  });

  it('re-validates linkedAppProfileId when changed on oauth2_token', async () => {
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

    expect(mockFindOne).toHaveBeenCalledWith({
      _id: 'ap-new-app',
      tenantId: 'tenant-1',
    });
  });

  it('rejects when new linkedAppProfileId is invalid', async () => {
    mockFindOne.mockResolvedValue(null);

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
        updatePayload: { linkedAppProfileId: 'ap-bad' },
      }),
    ).rejects.toThrow(/Linked OAuth app must belong to the same tenant/);
  });

  it('rejects linkedAppProfileId updates for non-oauth2_token types', async () => {
    await expect(
      validateAuthProfileUpdate({
        existingProfile: { authType: 'bearer', tenantId: 'tenant-1' },
        updatePayload: { linkedAppProfileId: 'ap-some' },
      }),
    ).rejects.toThrow(/only valid for oauth2_token/i);
  });

  it('skips linkedApp validation when linkedAppProfileId unchanged', async () => {
    await expect(
      validateAuthProfileUpdate({
        existingProfile: {
          authType: 'oauth2_token',
          tenantId: 'tenant-1',
          linkedAppProfileId: 'ap-same',
          scope: 'project',
          visibility: 'shared',
          projectId: 'project-1',
        },
        updatePayload: { linkedAppProfileId: 'ap-same' },
      }),
    ).resolves.toBeUndefined();

    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('rejects personal oauth2_token updates when owner context is missing', async () => {
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

  it('rejects project-scoped oauth2_token updates when project context is missing', async () => {
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
