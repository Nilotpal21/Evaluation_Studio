import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindOne = vi.fn();
const mockDecryptForTenantAuto = vi.fn();
const mockResolveAuthProfileCredentials = vi.fn();
const mockChannelConnectionFindOne = vi.fn(() => ({
  lean: mockFindOne,
}));

vi.mock('@agent-platform/database/models', () => ({
  ChannelConnection: {
    findOne: (...args: unknown[]) => mockChannelConnectionFindOne(...args),
  },
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  isTenantEncryptionReady: () => true,
  decryptForTenantAuto: (...args: unknown[]) => mockDecryptForTenantAuto(...args),
}));

vi.mock('../services/auth-profile-resolver.js', () => ({
  resolveAuthProfileCredentials: (...args: unknown[]) => mockResolveAuthProfileCredentials(...args),
  getAuthProfileCache: vi.fn(),
  resolveAuthProfileCredentials: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  resolveChannelConnection,
  resolveConnectionByVerifyToken,
} from '../channels/connection-resolver.js';

describe('connection-resolver credential decoding', () => {
  beforeEach(() => {
    mockFindOne.mockReset();
    mockDecryptForTenantAuto.mockReset();
    mockResolveAuthProfileCredentials.mockReset();
    mockChannelConnectionFindOne.mockClear();
    mockChannelConnectionFindOne.mockImplementation(() => ({
      lean: mockFindOne,
    }));
  });

  it('parses plugin-decrypted credential JSON without re-decrypting it', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'conn-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      deploymentId: null,
      environment: null,
      channelType: 'slack',
      externalIdentifier: 'T1:A1',
      status: 'active',
      authProfileId: null,
      encryptedCredentials: JSON.stringify({
        bot_token: 'xoxb-test-token',
        signing_secret: 'slack-signing-secret',
      }),
      config: {},
    });

    const result = await resolveChannelConnection('slack', 'T1:A1');

    expect(result?.credentials).toEqual({
      bot_token: 'xoxb-test-token',
      signing_secret: 'slack-signing-secret',
    });
    expect(mockDecryptForTenantAuto).not.toHaveBeenCalled();
  });

  it('decrypts ciphertext when the query still returns encrypted credentials', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'conn-2',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      deploymentId: null,
      environment: null,
      channelType: 'slack',
      externalIdentifier: 'T2:A2',
      status: 'active',
      authProfileId: null,
      encryptedCredentials: 'dek-envelope-ciphertext',
      config: {},
    });
    mockDecryptForTenantAuto.mockResolvedValue(
      JSON.stringify({
        bot_token: 'xoxb-decrypted-token',
      }),
    );

    const result = await resolveChannelConnection('slack', 'T2:A2');

    expect(mockDecryptForTenantAuto).toHaveBeenCalledWith('dek-envelope-ciphertext', 'tenant-1');
    expect(result?.credentials).toEqual({
      bot_token: 'xoxb-decrypted-token',
    });
  });

  it('reuses the same credential parsing path for verify-token bootstrap lookups', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'conn-3',
      tenantId: 'tenant-verify',
      projectId: 'project-verify',
      agentId: null,
      deploymentId: null,
      environment: null,
      channelType: 'whatsapp',
      externalIdentifier: 'phone-1',
      status: 'active',
      authProfileId: null,
      encryptedCredentials: JSON.stringify({
        verify_token: 'verify-token',
      }),
      config: {},
    });

    const result = await resolveConnectionByVerifyToken('whatsapp', 'verify-token');

    expect(result?.credentials).toEqual({
      verify_token: 'verify-token',
    });
    expect(mockDecryptForTenantAuto).not.toHaveBeenCalled();
  });

  it('falls back to legacy plus-prefixed WhatsApp identifiers for digits-only webhooks', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      _id: 'conn-whatsapp',
      tenantId: 'tenant-wa',
      projectId: 'project-wa',
      agentId: null,
      deploymentId: null,
      environment: null,
      channelType: 'whatsapp',
      externalIdentifier: '+447860099299',
      status: 'active',
      authProfileId: null,
      encryptedCredentials: JSON.stringify({
        api_key: 'infobip-key',
        base_url: 'https://api.infobip.com',
      }),
      config: { provider: 'infobip' },
    });

    const result = await resolveChannelConnection('whatsapp', '447860099299');

    expect(result?.externalIdentifier).toBe('+447860099299');
    expect(mockChannelConnectionFindOne).toHaveBeenNthCalledWith(1, {
      channelType: 'whatsapp',
      externalIdentifier: '447860099299',
    });
    expect(mockChannelConnectionFindOne).toHaveBeenNthCalledWith(2, {
      channelType: 'whatsapp',
      externalIdentifier: '+447860099299',
    });
  });
});
