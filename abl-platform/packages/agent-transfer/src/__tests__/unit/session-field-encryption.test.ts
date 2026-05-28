import { describe, it, expect, vi } from 'vitest';
import { TenantScopedSessionEncryptor } from '../../security/session-field-encryption.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('TenantScopedSessionEncryptor', () => {
  it('prefixes encrypted payloads when encryption succeeds', async () => {
    const encryptor = new TenantScopedSessionEncryptor({
      encryptForTenant: vi.fn().mockReturnValue('ciphertext'),
      decryptForTenant: vi.fn(),
    });

    await expect(encryptor.encryptField('{"token":"secret"}', 'tenant-1')).resolves.toBe(
      'enc:v1:ciphertext',
    );
  });

  it('fails closed when the encryption backend throws', async () => {
    const encryptor = new TenantScopedSessionEncryptor({
      encryptForTenant: vi.fn(() => {
        throw new Error('kms unavailable');
      }),
      decryptForTenant: vi.fn(),
    });

    await expect(encryptor.encryptField('{"token":"secret"}', 'tenant-1')).rejects.toThrow(
      'kms unavailable',
    );
  });
});
