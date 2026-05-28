import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreateNonce = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  SDKBootstrapArtifactNonce: {
    create: (...args: unknown[]) => mockCreateNonce(...args),
  },
}));

import { consumeSdkBootstrapJti } from '../../services/identity/sdk-bootstrap-replay-store.js';

describe('sdk-bootstrap-replay-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateNonce.mockResolvedValue(undefined);
  });

  it('persists a fresh customer bootstrap JTI', async () => {
    const expiresAtMs = Date.now() + 60_000;

    await expect(
      consumeSdkBootstrapJti({
        jti: 'bootstrap-jti-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        expiresAtMs,
      }),
    ).resolves.toEqual({ success: true });

    expect(mockCreateNonce).toHaveBeenCalledWith({
      _id: 'bootstrap-jti-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      expiresAt: new Date(expiresAtMs),
    });
  });

  it('rejects blank or expired JTIs before touching persistence', async () => {
    await expect(
      consumeSdkBootstrapJti({
        jti: '   ',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        expiresAtMs: Date.now() + 60_000,
      }),
    ).resolves.toEqual({ success: false, reason: 'replayed' });

    await expect(
      consumeSdkBootstrapJti({
        jti: 'bootstrap-jti-expired',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        expiresAtMs: Date.now() - 1,
      }),
    ).resolves.toEqual({ success: false, reason: 'expired' });

    expect(mockCreateNonce).not.toHaveBeenCalled();
  });

  it('treats duplicate-key insert failures as replays', async () => {
    mockCreateNonce.mockRejectedValue({ code: 11000 });

    await expect(
      consumeSdkBootstrapJti({
        jti: 'bootstrap-jti-replay',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        expiresAtMs: Date.now() + 60_000,
      }),
    ).resolves.toEqual({ success: false, reason: 'replayed' });
  });

  it('surfaces storage failures as replay protection unavailability', async () => {
    mockCreateNonce.mockRejectedValue(new Error('mongodb unavailable'));

    await expect(
      consumeSdkBootstrapJti({
        jti: 'bootstrap-jti-error',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        expiresAtMs: Date.now() + 60_000,
      }),
    ).resolves.toEqual({ success: false, reason: 'unavailable' });
  });
});
