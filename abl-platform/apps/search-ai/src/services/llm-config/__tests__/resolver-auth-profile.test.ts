/**
 * Search-AI LLM Config Resolver — Auth Profile Resolution Tests
 *
 * Tests the dual-read contract in tenant-model-adapter: when a TenantModel
 * connection has authProfileId, auth-profile resolution is authoritative
 * and SearchAI must never silently fall back to legacy LLMCredential data.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock models ──────────────────────────────────────────────────────────

const mockTenantModel = {
  findOne: vi.fn(),
  countDocuments: vi.fn(),
};
const mockLLMCredential = { findOne: vi.fn() };
const mockResolveTenantPlaintextValue = vi.fn();

vi.mock('../../../db/index.js', () => ({
  getModel: vi.fn((name: string) => {
    switch (name) {
      case 'TenantModel':
        return mockTenantModel;
      case 'LLMCredential':
        return mockLLMCredential;
      default:
        throw new Error(`Unknown model in test mock: ${name}`);
    }
  }),
  getLazyModel: vi.fn(),
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

// Mock auth profile service resolve
const mockResolveAuthProfile = vi.fn();
vi.mock('../../../services/auth-profile-resolver.js', () => ({
  resolveAuthProfileCredential: (...args: any[]) => mockResolveAuthProfile(...args),
}));

import { resolveTenantModelForTier } from '../tenant-model-adapter.js';

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Search-AI tenant-model-adapter — Auth Profile dual-read', () => {
  const tenantId = 'tenant-1';

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTenantPlaintextValue.mockImplementation(
      async (value: string | null | undefined) => value ?? null,
    );
  });

  it('resolves credential via authProfileId when authProfileId is present', async () => {
    const mockModel = {
      modelId: 'claude-sonnet-4-5-20251001',
      provider: 'anthropic',
      displayName: 'Claude Sonnet',
      tier: 'balanced',
      temperature: 0.7,
      maxTokens: 4096,
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      connections: [
        {
          isPrimary: true,
          isActive: true,
          credentialId: 'cred-legacy',
          authProfileId: 'ap-1',
        },
      ],
    };

    mockTenantModel.findOne.mockReturnValue({
      sort: vi.fn().mockResolvedValue(mockModel),
    });

    mockResolveAuthProfile.mockResolvedValue({
      apiKey: 'resolved-api-key-from-profile',
    });

    const result = await resolveTenantModelForTier(tenantId, 'balanced');

    expect(mockResolveAuthProfile).toHaveBeenCalledWith({
      authProfileId: 'ap-1',
      tenantId,
    });
    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('resolved-api-key-from-profile');
    // LLMCredential should NOT have been queried
    expect(mockLLMCredential.findOne).not.toHaveBeenCalled();
  });

  it('falls back to legacy credentialId when authProfileId is absent', async () => {
    const mockModel = {
      modelId: 'claude-sonnet-4-5-20251001',
      provider: 'anthropic',
      displayName: 'Claude Sonnet',
      tier: 'balanced',
      temperature: 0.7,
      maxTokens: 4096,
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      connections: [
        {
          isPrimary: true,
          isActive: true,
          credentialId: 'cred-legacy',
          // No authProfileId
        },
      ],
    };

    mockTenantModel.findOne.mockReturnValue({
      sort: vi.fn().mockResolvedValue(mockModel),
    });

    mockLLMCredential.findOne.mockResolvedValue({
      encryptedApiKey: 'legacy-api-key',
    });

    const result = await resolveTenantModelForTier(tenantId, 'balanced');

    expect(mockResolveAuthProfile).not.toHaveBeenCalled();
    expect(mockLLMCredential.findOne).toHaveBeenCalledWith({
      _id: 'cred-legacy',
      tenantId,
    });
    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('legacy-api-key');
  });

  it('decrypts lingering ciphertext on the legacy credential path', async () => {
    const mockModel = {
      modelId: 'claude-sonnet-4-5-20251001',
      provider: 'anthropic',
      displayName: 'Claude Sonnet',
      tier: 'balanced',
      temperature: 0.7,
      maxTokens: 4096,
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      connections: [
        {
          isPrimary: true,
          isActive: true,
          credentialId: 'cred-legacy',
        },
      ],
    };

    mockTenantModel.findOne.mockReturnValue({
      sort: vi.fn().mockResolvedValue(mockModel),
    });

    mockLLMCredential.findOne.mockResolvedValue({
      encryptedApiKey: 'N0:AAAA:BBBB:CCCC',
      _decryptionFailed: true,
    });
    mockResolveTenantPlaintextValue.mockResolvedValue('legacy-api-key');

    const result = await resolveTenantModelForTier(tenantId, 'balanced');

    expect(mockResolveTenantPlaintextValue).toHaveBeenCalledWith('N0:AAAA:BBBB:CCCC', tenantId, {
      decryptionFailed: true,
    });
    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('legacy-api-key');
  });

  it('rejects when auth profile returns null instead of falling back to legacy', async () => {
    const mockModel = {
      modelId: 'claude-sonnet-4-5-20251001',
      provider: 'anthropic',
      displayName: 'Claude Sonnet',
      tier: 'balanced',
      temperature: 0.7,
      maxTokens: 4096,
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      connections: [
        {
          isPrimary: true,
          isActive: true,
          credentialId: 'cred-legacy',
          authProfileId: 'ap-1',
        },
      ],
    };

    mockTenantModel.findOne.mockReturnValue({
      sort: vi.fn().mockResolvedValue(mockModel),
    });

    mockResolveAuthProfile.mockResolvedValue(null);

    await expect(resolveTenantModelForTier(tenantId, 'balanced')).rejects.toThrow(
      /refusing legacy fallback/i,
    );

    expect(mockResolveAuthProfile).toHaveBeenCalledWith({
      authProfileId: 'ap-1',
      tenantId,
    });
    expect(mockLLMCredential.findOne).not.toHaveBeenCalled();
  });

  it('rejects when auth profile resolution fails instead of falling back to legacy', async () => {
    const mockModel = {
      modelId: 'claude-sonnet-4-5-20251001',
      provider: 'anthropic',
      displayName: 'Claude Sonnet',
      tier: 'balanced',
      temperature: 0.7,
      maxTokens: 4096,
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      connections: [
        {
          isPrimary: true,
          isActive: true,
          credentialId: 'cred-legacy',
          authProfileId: 'ap-1',
        },
      ],
    };

    mockTenantModel.findOne.mockReturnValue({
      sort: vi.fn().mockResolvedValue(mockModel),
    });

    mockResolveAuthProfile.mockRejectedValue(new Error('Profile not found'));

    await expect(resolveTenantModelForTier(tenantId, 'balanced')).rejects.toThrow(
      'Profile not found',
    );

    expect(mockResolveAuthProfile).toHaveBeenCalledWith({
      authProfileId: 'ap-1',
      tenantId,
    });
    expect(mockLLMCredential.findOne).not.toHaveBeenCalled();
  });
});
