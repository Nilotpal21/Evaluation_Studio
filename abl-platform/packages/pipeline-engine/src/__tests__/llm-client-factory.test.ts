import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTenantModelFindOne = vi.fn();
const mockModelConfigFindOne = vi.fn();
const mockLLMCredentialFindOne = vi.fn();
const mockResolveTenantPlaintextValue = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  TenantModel: {
    findOne: (...args: unknown[]) => mockTenantModelFindOne(...args),
  },
  ModelConfig: {
    findOne: (...args: unknown[]) => mockModelConfigFindOne(...args),
  },
  LLMCredential: {
    findOne: (...args: unknown[]) => mockLLMCredentialFindOne(...args),
  },
}));

vi.mock('@agent-platform/database', () => ({
  resolveTenantPlaintextValue: (...args: unknown[]) => mockResolveTenantPlaintextValue(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { resolvePipelineLLM, isPipelineLLMResolutionError } =
  await import('../pipeline/services/llm-client-factory.js');

describe('resolvePipelineLLM', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTenantPlaintextValue.mockImplementation(
      async (value: string | null | undefined) => value ?? null,
    );
  });

  it('returns resolved plaintext credentials for the tenant default model', async () => {
    mockTenantModelFindOne.mockResolvedValueOnce({
      _id: 'tm-1',
      tenantId: 'tenant-1',
      provider: 'azure',
      modelId: 'azure/gpt-4o-mini',
      connections: [{ credentialId: 'cred-1', isActive: true, isPrimary: true }],
    });
    mockLLMCredentialFindOne.mockResolvedValue({
      _id: 'cred-1',
      provider: 'azure',
      encryptedApiKey: 'N0:AAAA:BBBB:CCCC',
      encryptedEndpoint: 'https://proxy.example.com/v1',
      authConfig: {
        resourceName: 'tenant-azure-openai',
        deploymentId: 'gpt-4o-mini-prod',
        apiVersion: '2024-10-21',
      },
      _decryptionFailed: true,
    });
    mockResolveTenantPlaintextValue
      .mockResolvedValueOnce('sk-decrypted')
      .mockResolvedValueOnce('https://proxy.example.com/v1');

    await expect(resolvePipelineLLM('tenant-1')).resolves.toEqual({
      source: 'tenant',
      provider: 'azure',
      modelId: 'azure/gpt-4o-mini',
      apiKey: 'sk-decrypted',
      baseUrl: 'https://proxy.example.com/v1',
      authConfig: {
        resourceName: 'tenant-azure-openai',
        deploymentId: 'gpt-4o-mini-prod',
        apiVersion: '2024-10-21',
      },
    });
  });

  it('resolves legacy short model ids only to dated model variants', async () => {
    const sort = vi.fn().mockReturnThis();
    const exec = vi.fn().mockResolvedValue({
      _id: 'tm-legacy',
      tenantId: 'tenant-1',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6-20260217',
      connections: [{ credentialId: 'cred-1', isActive: true, isPrimary: true }],
    });

    mockTenantModelFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce({ sort, exec });
    mockLLMCredentialFindOne.mockResolvedValue({
      _id: 'cred-1',
      provider: 'anthropic',
      encryptedApiKey: 'sk-ant-test',
      _decryptionFailed: false,
    });

    await expect(
      resolvePipelineLLM('tenant-1', 'project-1', 'claude-sonnet-4-6', {
        allowFallbackOnExplicitModel: false,
      }),
    ).resolves.toEqual({
      source: 'pipeline',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6-20260217',
      apiKey: 'sk-ant-test',
      baseUrl: undefined,
      authConfig: undefined,
    });

    const prefixQuery = mockTenantModelFindOne.mock.calls[2]?.[0] as {
      modelId: { $regex: string };
    };
    const regex = new RegExp(prefixQuery.modelId.$regex);
    expect(regex.test('claude-sonnet-4-6-20260217')).toBe(true);
    expect(regex.test('claude-sonnet-4-6-2026-02-17')).toBe(true);
    expect(regex.test('claude-sonnet-4-60-20261001')).toBe(false);
  });

  it('does not treat sibling model variants as dated legacy aliases', async () => {
    const sort = vi.fn().mockReturnThis();
    const exec = vi.fn().mockResolvedValue(null);

    const configuredSort = vi.fn().mockReturnThis();
    const configuredExec = vi.fn().mockResolvedValue(null);

    mockTenantModelFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce({ sort, exec })
      .mockReturnValueOnce({ sort: configuredSort, exec: configuredExec });

    await expect(
      resolvePipelineLLM('tenant-1', 'project-1', 'gpt-4o', {
        allowFallbackOnExplicitModel: false,
      }),
    ).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      userMessage:
        'Configured LLM model was not found. Select an active model with configured credentials.',
    });

    const prefixQuery = mockTenantModelFindOne.mock.calls[2]?.[0] as {
      modelId: { $regex: string };
    };
    const regex = new RegExp(prefixQuery.modelId.$regex);
    expect(regex.test('gpt-4o-20240806')).toBe(true);
    expect(regex.test('gpt-4o-2024-08-06')).toBe(true);
    expect(regex.test('gpt-4o-mini')).toBe(false);
    expect(mockModelConfigFindOne).not.toHaveBeenCalled();
  });

  it('scopes project default ModelConfig lookup by tenant', async () => {
    const lean = vi.fn().mockResolvedValue({
      tenantModelId: 'tm-project',
    });
    mockModelConfigFindOne.mockReturnValueOnce({ lean });
    mockTenantModelFindOne.mockResolvedValueOnce({
      _id: 'tm-project',
      tenantId: 'tenant-1',
      provider: 'openai',
      modelId: 'gpt-4o-project',
      connections: [{ credentialId: 'cred-project', isActive: true, isPrimary: true }],
    });
    mockLLMCredentialFindOne.mockResolvedValue({
      _id: 'cred-project',
      tenantId: 'tenant-1',
      provider: 'openai',
      encryptedApiKey: 'sk-project',
      _decryptionFailed: false,
    });

    await expect(resolvePipelineLLM('tenant-1', 'project-1')).resolves.toMatchObject({
      source: 'project',
      provider: 'openai',
      modelId: 'gpt-4o-project',
      apiKey: 'sk-project',
    });

    expect(mockModelConfigFindOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      isDefault: true,
    });
  });

  it('fails closed when credential decryption does not succeed', async () => {
    mockTenantModelFindOne
      .mockResolvedValueOnce({
        _id: 'tm-1',
        tenantId: 'tenant-1',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        connections: [{ credentialId: 'cred-1', isActive: true, isPrimary: true }],
        isDefault: true,
      })
      .mockResolvedValueOnce(null);
    mockLLMCredentialFindOne.mockResolvedValue({
      _id: 'cred-1',
      provider: 'anthropic',
      encryptedApiKey: 'N0:AAAA:BBBB:CCCC',
      _decryptionFailed: true,
    });
    mockResolveTenantPlaintextValue.mockRejectedValueOnce(new Error('bad ciphertext'));

    await expect(resolvePipelineLLM('tenant-1')).rejects.toMatchObject({
      code: 'KEY_INVALID',
      userMessage:
        'Configured LLM credential could not be read. Reconnect the provider credential or contact an administrator.',
    });
  });

  it('reports inference-disabled models without leaking tenant identifiers', async () => {
    mockTenantModelFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      _id: 'tm-disabled',
      tenantId: 'tenant-1',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      connections: [{ credentialId: 'cred-1', isActive: true, isPrimary: true }],
      isDefault: true,
      isActive: true,
      inferenceEnabled: false,
    });

    try {
      await resolvePipelineLLM('tenant-1');
      throw new Error('Expected resolvePipelineLLM to fail');
    } catch (error) {
      expect(isPipelineLLMResolutionError(error)).toBe(true);
      if (!isPipelineLLMResolutionError(error)) return;
      expect(error.code).toBe('INFERENCE_DISABLED');
      expect(error.userMessage).toContain('inference is disabled');
      expect(error.userMessage).not.toContain('tenant-1');
      expect(error.message).not.toContain('tenant-1');
    }
  });
});
