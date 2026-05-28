/**
 * Tests for pipeline model resolver.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';

const mockCreateVercelProvider = vi.fn();
const mockTenantModelFindOne = vi.fn();
const mockLLMCredentialFindOne = vi.fn();
const mockResolveTenantPlaintextValue = vi.fn();

vi.mock('@agent-platform/llm', () => ({
  createVercelProvider: (...args: unknown[]) => mockCreateVercelProvider(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  TenantModel: {
    findOne: (...args: unknown[]) => mockTenantModelFindOne(...args),
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

const { resolvePipelineModel } = await import('../services/pipeline/model-resolver.js');
const { DEFAULT_PIPELINE_CONFIG } = await import('../services/pipeline/types.js');

const mockLanguageModel = { modelId: 'mock-model' } as unknown as LanguageModel;

function createMockSession(overrides?: {
  resolveResult?: LanguageModel | null;
  tenantId?: string;
}) {
  const resolveResult =
    overrides && 'resolveResult' in overrides ? overrides.resolveResult : mockLanguageModel;
  return {
    llmClient: {
      resolveLanguageModel: vi.fn().mockResolvedValue(resolveResult),
    },
    tenantId: overrides && 'tenantId' in overrides ? overrides.tenantId : 'tenant-1',
  };
}

function mockTenantModelLookup(result: Record<string, unknown> | null) {
  mockTenantModelFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(result),
  });
}

describe('resolvePipelineModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateVercelProvider.mockReturnValue(mockLanguageModel);
    mockResolveTenantPlaintextValue.mockImplementation(
      async (value: string | null | undefined) => value ?? null,
    );
  });

  it('delegates to resolveLanguageModel for modelSource=default', async () => {
    const session = createMockSession();
    const config = { ...DEFAULT_PIPELINE_CONFIG, modelSource: 'default' as const };

    const result = await resolvePipelineModel(config, session as any);

    expect(session.llmClient.resolveLanguageModel).toHaveBeenCalledWith('tool_selection');
    expect(result).toBe(mockLanguageModel);
  });

  it('delegates to resolveLanguageModel when modelSource is missing', async () => {
    const session = createMockSession();
    const config = { ...DEFAULT_PIPELINE_CONFIG };

    const result = await resolvePipelineModel(config, session as any);

    expect(session.llmClient.resolveLanguageModel).toHaveBeenCalledWith('tool_selection');
    expect(result).toBe(mockLanguageModel);
  });

  it('returns null when default resolution returns null', async () => {
    const session = createMockSession({ resolveResult: null });
    const config = { ...DEFAULT_PIPELINE_CONFIG, modelSource: 'default' as const };

    const result = await resolvePipelineModel(config, session as any);

    expect(result).toBeNull();
  });

  it('falls back to default when modelSource=tenant but tenantModelId is missing', async () => {
    const session = createMockSession();
    const config = {
      ...DEFAULT_PIPELINE_CONFIG,
      modelSource: 'tenant' as const,
      tenantModelId: undefined,
    };

    const result = await resolvePipelineModel(config, session as any);

    expect(session.llmClient.resolveLanguageModel).toHaveBeenCalledWith('tool_selection');
    expect(result).toBe(mockLanguageModel);
  });

  it('returns null when tenantId is missing and modelSource is tenant', async () => {
    const session = createMockSession({ tenantId: undefined as any });
    const config = {
      ...DEFAULT_PIPELINE_CONFIG,
      modelSource: 'tenant' as const,
      tenantModelId: 'tm-123',
    };

    const result = await resolvePipelineModel(config, session as any);

    expect(session.llmClient.resolveLanguageModel).toHaveBeenCalledWith('tool_selection');
    expect(result).toBe(mockLanguageModel);
  });

  it('uses resolved plaintext credentials for tenant-model resolution', async () => {
    const session = createMockSession();
    const config = {
      ...DEFAULT_PIPELINE_CONFIG,
      modelSource: 'tenant' as const,
      tenantModelId: 'tm-123',
    };

    mockTenantModelLookup({
      _id: 'tm-123',
      tenantId: 'tenant-1',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      isActive: true,
      connections: [{ credentialId: 'cred-1', isActive: true, isPrimary: true }],
    });
    mockLLMCredentialFindOne.mockResolvedValue({
      _id: 'cred-1',
      encryptedApiKey: 'N0:AAAA:BBBB:CCCC',
      encryptedEndpoint: 'https://proxy.example.com/v1',
      _decryptionFailed: true,
    });
    mockResolveTenantPlaintextValue
      .mockResolvedValueOnce('sk-decrypted')
      .mockResolvedValueOnce('https://proxy.example.com/v1');

    const result = await resolvePipelineModel(config, session as any);

    expect(result).toBe(mockLanguageModel);
    expect(mockCreateVercelProvider).toHaveBeenCalledWith(
      'anthropic',
      'sk-decrypted',
      'https://proxy.example.com/v1',
      'claude-sonnet-4-6',
      undefined,
      undefined,
    );
    expect(session.llmClient.resolveLanguageModel).not.toHaveBeenCalled();
  });

  it('falls back to default when tenant credential decryption fails', async () => {
    const session = createMockSession();
    const config = {
      ...DEFAULT_PIPELINE_CONFIG,
      modelSource: 'tenant' as const,
      tenantModelId: 'tm-123',
    };

    mockTenantModelLookup({
      _id: 'tm-123',
      tenantId: 'tenant-1',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      isActive: true,
      connections: [{ credentialId: 'cred-1', isActive: true, isPrimary: true }],
    });
    mockLLMCredentialFindOne.mockResolvedValue({
      _id: 'cred-1',
      encryptedApiKey: 'N0:AAAA:BBBB:CCCC',
      _decryptionFailed: true,
    });
    mockResolveTenantPlaintextValue.mockRejectedValueOnce(new Error('bad ciphertext'));

    const result = await resolvePipelineModel(config, session as any);

    expect(result).toBe(mockLanguageModel);
    expect(session.llmClient.resolveLanguageModel).toHaveBeenCalledWith('tool_selection');
    expect(mockCreateVercelProvider).not.toHaveBeenCalled();
  });
});
