import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGenerateSdkChannelServerSecret = vi.fn();

vi.mock('../../services/identity/sdk-channel-server-secret.js', () => ({
  generateSdkChannelServerSecret: (...args: unknown[]) =>
    mockGenerateSdkChannelServerSecret(...args),
}));

import { resolveSdkChannelAuthUpdates } from '../../routes/sdk-channel-identity-utils.js';

describe('sdk-channel-identity-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateSdkChannelServerSecret.mockResolvedValue({
      plaintext: 'sk_0123456789abcdef0123456789abcdef0123456789abcdef',
      hash: 'hash-1',
      salt: 'salt-1',
      prefix: 'sk_0123456789ab',
      rotatedAt: new Date('2026-04-09T00:00:00.000Z'),
    });
  });

  it('does not rotate a hosted exchange server secret when re-saving the same mode', async () => {
    await expect(
      resolveSdkChannelAuthUpdates(
        {
          auth: {
            mode: 'hosted_exchange',
          },
        },
        {
          authMode: 'hosted_exchange',
          serverSecretHash: 'existing-hash',
          serverSecretSalt: 'existing-salt',
          serverSecretPrefix: 'sk_existing1234',
        },
      ),
    ).resolves.toEqual({
      updates: {
        authMode: 'hosted_exchange',
      },
    });

    expect(mockGenerateSdkChannelServerSecret).not.toHaveBeenCalled();
  });

  it('generates a hosted exchange server secret when transitioning from anonymous mode', async () => {
    await expect(
      resolveSdkChannelAuthUpdates(
        {
          auth: {
            mode: 'hosted_exchange',
          },
        },
        {
          authMode: 'anonymous',
          serverSecretHash: null,
          serverSecretSalt: null,
        },
      ),
    ).resolves.toEqual({
      updates: {
        authMode: 'hosted_exchange',
        serverSecretHash: 'hash-1',
        serverSecretSalt: 'salt-1',
        serverSecretPrefix: 'sk_0123456789ab',
        serverSecretLastRotatedAt: new Date('2026-04-09T00:00:00.000Z'),
      },
      generatedServerSecret: 'sk_0123456789abcdef0123456789abcdef0123456789abcdef',
    });

    expect(mockGenerateSdkChannelServerSecret).toHaveBeenCalledTimes(1);
  });

  it('rotates a hosted exchange server secret only when explicitly requested', async () => {
    await expect(
      resolveSdkChannelAuthUpdates(
        {
          auth: {
            rotateServerSecret: true,
          },
        },
        {
          authMode: 'hosted_exchange',
          serverSecretHash: 'existing-hash',
          serverSecretSalt: 'existing-salt',
          serverSecretPrefix: 'sk_existing1234',
        },
      ),
    ).resolves.toEqual({
      updates: {
        authMode: 'hosted_exchange',
        serverSecretHash: 'hash-1',
        serverSecretSalt: 'salt-1',
        serverSecretPrefix: 'sk_0123456789ab',
        serverSecretLastRotatedAt: new Date('2026-04-09T00:00:00.000Z'),
      },
      generatedServerSecret: 'sk_0123456789abcdef0123456789abcdef0123456789abcdef',
    });

    expect(mockGenerateSdkChannelServerSecret).toHaveBeenCalledTimes(1);
  });
});
