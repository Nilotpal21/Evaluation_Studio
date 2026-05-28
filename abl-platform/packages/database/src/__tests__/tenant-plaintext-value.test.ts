import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetEncryptionFacade = vi.fn();
const mockIsAlreadyEncrypted = vi.fn();

vi.mock('@agent-platform/shared-encryption', () => ({
  getEncryptionFacade: (...args: unknown[]) => mockGetEncryptionFacade(...args),
  isAlreadyEncrypted: (...args: unknown[]) => mockIsAlreadyEncrypted(...args),
}));

import { resolveTenantPlaintextValue } from '../tenant-plaintext-value.js';

describe('resolveTenantPlaintextValue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for empty values', async () => {
    await expect(resolveTenantPlaintextValue(null, 'tenant-1')).resolves.toBeNull();
    await expect(resolveTenantPlaintextValue(undefined, 'tenant-1')).resolves.toBeNull();
    expect(mockIsAlreadyEncrypted).not.toHaveBeenCalled();
  });

  it('returns plaintext when the value is not encrypted', async () => {
    mockIsAlreadyEncrypted.mockReturnValue(false);

    await expect(resolveTenantPlaintextValue('sk-plain', 'tenant-1')).resolves.toBe('sk-plain');

    expect(mockGetEncryptionFacade).not.toHaveBeenCalled();
  });

  it('decrypts encrypted values through the facade', async () => {
    const decrypt = vi.fn().mockResolvedValue('sk-decrypted');
    mockIsAlreadyEncrypted.mockReturnValue(true);
    mockGetEncryptionFacade.mockReturnValue({ decrypt });

    await expect(resolveTenantPlaintextValue('ciphertext-value', 'tenant-1')).resolves.toBe(
      'sk-decrypted',
    );

    expect(decrypt).toHaveBeenCalledWith('ciphertext-value', 'tenant-1', undefined);
  });

  it('returns plaintext when a document-level decryption failure flag is set on another field', async () => {
    const decrypt = vi.fn().mockResolvedValue('sk-decrypted');
    mockIsAlreadyEncrypted.mockReturnValue(false);
    mockGetEncryptionFacade.mockReturnValue({ decrypt });

    await expect(
      resolveTenantPlaintextValue('sk-plain-after-key-recovery', 'tenant-1', {
        decryptionFailed: true,
      }),
    ).resolves.toBe('sk-plain-after-key-recovery');

    expect(decrypt).not.toHaveBeenCalled();
  });

  it('throws when ciphertext remains but the facade is unavailable', async () => {
    mockIsAlreadyEncrypted.mockReturnValue(true);
    mockGetEncryptionFacade.mockReturnValue(undefined);

    await expect(resolveTenantPlaintextValue('ciphertext-value', 'tenant-1')).rejects.toThrow(
      /facade is not initialized/i,
    );
  });
});
