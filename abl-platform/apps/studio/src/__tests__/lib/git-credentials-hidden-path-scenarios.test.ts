import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuthProfileFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: (...args: unknown[]) => mockAuthProfileFindOne(...args),
  },
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  decryptForTenantAuto: vi.fn().mockResolvedValue('raw-token'),
  isTenantEncryptionReady: vi.fn(() => true),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('resolveGitCredentials auth profile hidden paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('scopes project auth profile lookup to the integration project while allowing tenant profiles', async () => {
    mockAuthProfileFindOne.mockResolvedValueOnce({
      _id: 'auth-profile-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      scope: 'project',
      status: 'active',
      authType: 'bearer',
      encryptedSecrets: JSON.stringify({ token: 'profile-token' }),
    });
    const { resolveGitCredentials } = await import('@/lib/git-credentials');

    await (resolveGitCredentials as any)('auth-profile-1', 'tenant-1', 'project-1');

    expect(mockAuthProfileFindOne).toHaveBeenCalledWith({
      _id: 'auth-profile-1',
      tenantId: 'tenant-1',
      status: 'active',
      $or: [{ projectId: 'project-1' }, { projectId: null, scope: 'tenant' }],
    });
  });

  it('does not allow personal profiles even when lifecycle calls include a user context', async () => {
    mockAuthProfileFindOne.mockResolvedValueOnce(null);
    const { resolveGitCredentials } = await import('@/lib/git-credentials');

    await expect(
      (resolveGitCredentials as any)('personal-profile-1', 'tenant-1', {
        projectId: 'project-1',
        userId: 'user-1',
      }),
    ).rejects.toThrow(/auth profile cannot be used/i);

    expect(mockAuthProfileFindOne).toHaveBeenCalledWith({
      _id: 'personal-profile-1',
      tenantId: 'tenant-1',
      status: 'active',
      $or: [{ projectId: 'project-1' }, { projectId: null, scope: 'tenant' }],
    });
  });

  it('rejects personal profiles even if an old git integration points at one', async () => {
    mockAuthProfileFindOne.mockResolvedValueOnce({
      _id: 'personal-profile-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      scope: 'personal',
      status: 'active',
      authType: 'bearer',
      encryptedSecrets: JSON.stringify({ token: 'personal-token' }),
    });
    const { resolveGitCredentials } = await import('@/lib/git-credentials');

    await expect(
      (resolveGitCredentials as any)('personal-profile-1', 'tenant-1', {
        projectId: 'project-1',
        userId: 'user-1',
      }),
    ).rejects.toThrow(/auth profile cannot be used/i);
  });

  it('rejects legacy integrations without an auth profile before decrypting', async () => {
    const { decryptForTenantAuto } = await import('@agent-platform/shared/encryption');
    const { resolveGitCredentials } = await import('@/lib/git-credentials');

    await expect((resolveGitCredentials as any)(null, 'tenant-1', 'project-1')).rejects.toThrow(
      /requires an auth profile/i,
    );

    expect(mockAuthProfileFindOne).not.toHaveBeenCalled();
    expect(decryptForTenantAuto).not.toHaveBeenCalled();
  });

  it.each(['none', 'basic', 'ssh_key', 'oauth2_app'])(
    'rejects auth profile type %s for Git token resolution',
    async (authType) => {
      mockAuthProfileFindOne.mockResolvedValueOnce({
        _id: 'auth-profile-wrong-type',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        scope: 'project',
        status: 'active',
        authType,
        encryptedSecrets: JSON.stringify({ token: 'not-a-git-token' }),
      });
      const { resolveGitCredentials } = await import('@/lib/git-credentials');

      await expect(
        (resolveGitCredentials as any)('auth-profile-wrong-type', 'tenant-1', 'project-1'),
      ).rejects.toThrow(/auth profile type/i);
    },
  );

  it('sanitizes malformed auth profile secret errors', async () => {
    mockAuthProfileFindOne.mockResolvedValueOnce({
      _id: 'auth-profile-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      scope: 'project',
      status: 'active',
      authType: 'bearer',
      encryptedSecrets: '{not-json',
    });
    const { resolveGitCredentials } = await import('@/lib/git-credentials');

    await expect(
      (resolveGitCredentials as any)('auth-profile-1', 'tenant-1', 'project-1'),
    ).rejects.not.toThrow(/auth-profile-1|tenant-1|legacy-secret-1/);
  });
});
