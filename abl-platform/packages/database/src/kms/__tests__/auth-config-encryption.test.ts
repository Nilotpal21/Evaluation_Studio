import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LocalKMSProvider } from '../local-kms-provider.js';
import { encryptAuthConfig, decryptAuthConfig } from '../auth-config-crypto.js';

const MASTER_KEY_HEX = 'a'.repeat(64);
const PLATFORM_KEY_ID = 'platform-default';

describe('auth-config-crypto', () => {
  let localProvider: LocalKMSProvider;

  beforeAll(async () => {
    localProvider = new LocalKMSProvider(MASTER_KEY_HEX);
    await localProvider.initialize();
  });

  afterAll(async () => {
    await localProvider.shutdown();
  });

  it('round-trips AWS auth config', async () => {
    const config = {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    };
    const encrypted = await encryptAuthConfig(config, localProvider, PLATFORM_KEY_ID);
    expect(typeof encrypted).toBe('string');
    expect(encrypted).not.toContain('AKIAIOSFODNN7EXAMPLE');

    const decrypted = await decryptAuthConfig(encrypted, localProvider, PLATFORM_KEY_ID);
    expect(decrypted).toEqual(config);
  });

  it('round-trips Azure auth config', async () => {
    const config = {
      tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      clientId: '11111111-2222-3333-4444-555555555555',
      clientSecret: 'my-azure-client-secret',
    };
    const encrypted = await encryptAuthConfig(config, localProvider, PLATFORM_KEY_ID);
    const decrypted = await decryptAuthConfig(encrypted, localProvider, PLATFORM_KEY_ID);
    expect(decrypted).toEqual(config);
  });

  it('round-trips GCP auth config', async () => {
    const config = {
      projectId: 'my-gcp-project',
      keyRing: 'my-key-ring',
      credentialsPath: '/etc/gcp/sa-key.json',
    };
    const encrypted = await encryptAuthConfig(config, localProvider, PLATFORM_KEY_ID);
    const decrypted = await decryptAuthConfig(encrypted, localProvider, PLATFORM_KEY_ID);
    expect(decrypted).toEqual(config);
  });

  it('round-trips external BYOP auth config', async () => {
    const config = {
      externalApiKey: 'byop-api-key-1234',
    };
    const encrypted = await encryptAuthConfig(config, localProvider, PLATFORM_KEY_ID);
    const decrypted = await decryptAuthConfig(encrypted, localProvider, PLATFORM_KEY_ID);
    expect(decrypted).toEqual(config);
  });

  it('returns empty object for null/undefined input', async () => {
    const decrypted = await decryptAuthConfig(null, localProvider, PLATFORM_KEY_ID);
    expect(decrypted).toEqual({});
  });

  it('returns empty object for empty string input', async () => {
    const decrypted = await decryptAuthConfig('', localProvider, PLATFORM_KEY_ID);
    expect(decrypted).toEqual({});
  });

  it('different configs produce different ciphertexts', async () => {
    const a = await encryptAuthConfig({ key: 'aaa' }, localProvider, PLATFORM_KEY_ID);
    const b = await encryptAuthConfig({ key: 'bbb' }, localProvider, PLATFORM_KEY_ID);
    expect(a).not.toEqual(b);
  });

  it('throws on tampered ciphertext', async () => {
    const encrypted = await encryptAuthConfig({ key: 'secret' }, localProvider, PLATFORM_KEY_ID);
    const tampered = encrypted.slice(0, -4) + 'XXXX';
    await expect(decryptAuthConfig(tampered, localProvider, PLATFORM_KEY_ID)).rejects.toThrow();
  });
});
