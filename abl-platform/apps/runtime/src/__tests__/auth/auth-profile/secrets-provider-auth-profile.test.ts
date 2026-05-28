/**
 * RuntimeSecretsProvider — Auth Profile Resolution Tests
 *
 * Tests the auth profile resolution layer (step 2.5) in the secrets
 * provider lookup chain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RuntimeSecretsProvider,
  type AuthProfileResolver,
  type ToolSecretStore,
  type SecretDecryptor,
} from '../../../services/secrets-provider.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('RuntimeSecretsProvider — Auth Profile resolution', () => {
  let mockAuthProfileResolver: AuthProfileResolver;
  let mockSecretStore: ToolSecretStore;
  let mockDecryptor: SecretDecryptor;

  beforeEach(() => {
    mockAuthProfileResolver = {
      resolveBySecretKey: vi.fn().mockResolvedValue(null),
    };
    mockSecretStore = {
      findSecret: vi.fn().mockResolvedValue(null),
    };
    mockDecryptor = {
      decryptForTenant: vi.fn().mockImplementation((v) => `decrypted:${v}`),
    };
  });

  it('resolves secret from auth profile when resolver returns a match', async () => {
    (mockAuthProfileResolver.resolveBySecretKey as any).mockResolvedValue({
      secrets: { OPENAI_API_KEY: 'sk-from-profile' },
    });

    const provider = new RuntimeSecretsProvider({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      environment: 'dev',
      authProfileResolver: mockAuthProfileResolver,
      secretStore: mockSecretStore,
      decryptor: mockDecryptor,
    });

    const result = await provider.getSecret('OPENAI_API_KEY');

    expect(result).toBe('sk-from-profile');
    expect(mockAuthProfileResolver.resolveBySecretKey).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      secretKey: 'OPENAI_API_KEY',
      environment: 'dev',
    });
    // Should NOT have queried the legacy store
    expect(mockSecretStore.findSecret).not.toHaveBeenCalled();
  });

  it('falls back to apiKey field when exact key not in secrets', async () => {
    (mockAuthProfileResolver.resolveBySecretKey as any).mockResolvedValue({
      secrets: { apiKey: 'sk-fallback-key' },
    });

    const provider = new RuntimeSecretsProvider({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      environment: 'dev',
      authProfileResolver: mockAuthProfileResolver,
    });

    const result = await provider.getSecret('MY_CUSTOM_KEY');

    expect(result).toBe('sk-fallback-key');
  });

  it('falls through to ToolSecret when auth profile returns null', async () => {
    (mockAuthProfileResolver.resolveBySecretKey as any).mockResolvedValue(null);
    (mockSecretStore.findSecret as any).mockResolvedValue({
      encryptedValue: 'encrypted-secret',
      expiresAt: null,
      version: 1,
    });

    const provider = new RuntimeSecretsProvider({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      environment: 'dev',
      authProfileResolver: mockAuthProfileResolver,
      secretStore: mockSecretStore,
      decryptor: mockDecryptor,
    });

    const result = await provider.getSecret('MY_KEY', { toolName: 'test_tool' });

    expect(mockAuthProfileResolver.resolveBySecretKey).toHaveBeenCalled();
    expect(mockSecretStore.findSecret).toHaveBeenCalled();
    expect(result).toBe('decrypted:encrypted-secret');
  });

  it('falls through to ToolSecret when auth profile resolver throws', async () => {
    (mockAuthProfileResolver.resolveBySecretKey as any).mockRejectedValue(
      new Error('Profile not found'),
    );
    (mockSecretStore.findSecret as any).mockResolvedValue({
      encryptedValue: 'enc-val',
      expiresAt: null,
      version: 1,
    });

    const provider = new RuntimeSecretsProvider({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      environment: 'dev',
      authProfileResolver: mockAuthProfileResolver,
      secretStore: mockSecretStore,
      decryptor: mockDecryptor,
    });

    const result = await provider.getSecret('MY_KEY', { toolName: 'test_tool' });

    expect(result).toBe('decrypted:enc-val');
  });

  it('skips auth profile when no resolver configured', async () => {
    const provider = new RuntimeSecretsProvider({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      environment: 'dev',
      secretStore: mockSecretStore,
      decryptor: mockDecryptor,
    });

    (mockSecretStore.findSecret as any).mockResolvedValue({
      encryptedValue: 'enc-val',
      expiresAt: null,
      version: 1,
    });

    const result = await provider.getSecret('MY_KEY', { toolName: 'test_tool' });
    expect(result).toBe('decrypted:enc-val');
  });

  it('caches auth profile result for subsequent calls', async () => {
    (mockAuthProfileResolver.resolveBySecretKey as any).mockResolvedValue({
      secrets: { MY_KEY: 'cached-val' },
    });

    const provider = new RuntimeSecretsProvider({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      environment: 'dev',
      authProfileResolver: mockAuthProfileResolver,
    });

    await provider.getSecret('MY_KEY');
    await provider.getSecret('MY_KEY');

    // Should only call resolver once (second call hits cache)
    expect(mockAuthProfileResolver.resolveBySecretKey).toHaveBeenCalledTimes(1);
  });
});
