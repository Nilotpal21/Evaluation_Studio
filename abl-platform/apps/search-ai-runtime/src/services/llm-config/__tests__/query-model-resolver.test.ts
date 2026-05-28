import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTenantModel = {
  findOne: vi.fn(),
};
const mockLLMCredential = {
  findOne: vi.fn(),
};
const mockResolveTenantPlaintextValue = vi.fn();

vi.mock('../../../db/index.js', () => ({
  getLazyModel: vi.fn((name: string) => {
    switch (name) {
      case 'TenantModel':
        return mockTenantModel;
      case 'LLMCredential':
        return mockLLMCredential;
      default:
        throw new Error(`Unknown model in test mock: ${name}`);
    }
  }),
}));

vi.mock('@agent-platform/database', async () => {
  const actual = await vi.importActual<typeof import('@agent-platform/database')>(
    '@agent-platform/database',
  );
  return {
    ...actual,
    resolveTenantPlaintextValue: (...args: unknown[]) => mockResolveTenantPlaintextValue(...args),
  };
});

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { resolveTenantModelById } from '../query-model-resolver.js';

describe('query-model-resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTenantPlaintextValue.mockImplementation(
      async (value: string | null | undefined) => value ?? null,
    );
  });

  it('decrypts lingering ciphertext before returning the resolved model', async () => {
    mockTenantModel.findOne.mockResolvedValue({
      modelId: 'claude-sonnet-4-5-20251001',
      provider: 'anthropic',
      displayName: 'Claude Sonnet',
      tier: 'balanced',
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      connections: [
        {
          isPrimary: true,
          isActive: true,
          credentialId: 'cred-1',
        },
      ],
    });
    mockLLMCredential.findOne.mockResolvedValue({
      encryptedApiKey: 'N0:AAAA:BBBB:CCCC',
      _decryptionFailed: true,
    });
    mockResolveTenantPlaintextValue.mockResolvedValue('sk-decrypted');

    const result = await resolveTenantModelById('tenant-1', 'tm-1');

    expect(mockResolveTenantPlaintextValue).toHaveBeenCalledWith('N0:AAAA:BBBB:CCCC', 'tenant-1', {
      decryptionFailed: true,
    });
    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('sk-decrypted');
  });

  it('fails closed when plaintext resolution throws', async () => {
    mockTenantModel.findOne.mockResolvedValue({
      modelId: 'claude-sonnet-4-5-20251001',
      provider: 'anthropic',
      displayName: 'Claude Sonnet',
      tier: 'balanced',
      connections: [
        {
          isPrimary: true,
          isActive: true,
          credentialId: 'cred-1',
        },
      ],
    });
    mockLLMCredential.findOne.mockResolvedValue({
      encryptedApiKey: 'N0:AAAA:BBBB:CCCC',
      _decryptionFailed: true,
    });
    mockResolveTenantPlaintextValue.mockRejectedValue(new Error('decryption failed'));

    await expect(resolveTenantModelById('tenant-1', 'tm-1')).resolves.toBeNull();
  });
});
