import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveTenantPlaintextValue = vi.fn();

vi.mock('@agent-platform/database', () => ({
  resolveTenantPlaintextValue: (...args: unknown[]) => mockResolveTenantPlaintextValue(...args),
}));

import { resolveLegacyCredentialApiKey } from '../legacy-credential-resolution.js';

describe('resolveLegacyCredentialApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTenantPlaintextValue.mockImplementation(async (value: string | null | undefined) => {
      return value ?? null;
    });
  });

  it('returns the resolved API key and forwards the decryption flag', async () => {
    mockResolveTenantPlaintextValue.mockResolvedValueOnce('resolved-api-key');

    await expect(
      resolveLegacyCredentialApiKey(
        {
          encryptedApiKey: 'ciphertext-api-key',
          _decryptionFailed: true,
        },
        'tenant-1',
        'cred-1',
      ),
    ).resolves.toBe('resolved-api-key');

    expect(mockResolveTenantPlaintextValue).toHaveBeenCalledWith('ciphertext-api-key', 'tenant-1', {
      decryptionFailed: true,
    });
  });

  it('throws when the credential is missing', async () => {
    await expect(resolveLegacyCredentialApiKey(null, 'tenant-1', 'cred-1')).rejects.toThrow(
      'LLM Credential cred-1 not found or inactive',
    );
  });

  it('throws when the credential resolves to no usable API key', async () => {
    mockResolveTenantPlaintextValue.mockResolvedValueOnce(null);

    await expect(
      resolveLegacyCredentialApiKey(
        {
          encryptedApiKey: 'ciphertext-api-key',
        },
        'tenant-1',
        'cred-1',
      ),
    ).rejects.toThrow('LLM Credential cred-1 does not have a usable API key');
  });

  it('wraps decryption failures with a consistent worker-facing error', async () => {
    mockResolveTenantPlaintextValue.mockRejectedValueOnce(new Error('decrypt failed'));

    await expect(
      resolveLegacyCredentialApiKey(
        {
          encryptedApiKey: 'ciphertext-api-key',
        },
        'tenant-1',
        'cred-1',
      ),
    ).rejects.toThrow('LLM Credential cred-1 could not be decrypted');
  });
});
