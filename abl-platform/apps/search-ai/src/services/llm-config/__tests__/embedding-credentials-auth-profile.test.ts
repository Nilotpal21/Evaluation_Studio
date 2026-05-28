/**
 * Search-AI Embedding Credentials — Auth Profile Resolution Tests
 *
 * Tests the unified embedding credential resolution path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLLMCredential = { findOne: vi.fn() };
const mockResolveTenantPlaintextValue = vi.fn();

vi.mock('../../../db/index.js', () => ({
  getModel: vi.fn((name: string) => {
    switch (name) {
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

const mockResolveEmbeddingAuthProfile = vi.fn();
vi.mock('../../../services/auth-profile-resolver.js', () => ({
  resolveAuthProfileCredential: vi.fn(),
  resolveEmbeddingAuthProfile: (...args: any[]) => mockResolveEmbeddingAuthProfile(...args),
}));

import { resolveEmbeddingCredentials } from '../embedding-credentials.js';

describe('Embedding credentials — Auth Profile dual-read', () => {
  const tenantId = 'tenant-1';

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTenantPlaintextValue.mockImplementation(
      async (value: string | null | undefined) => value ?? null,
    );
  });

  it('resolves via auth profile when a profile is found', async () => {
    mockResolveEmbeddingAuthProfile.mockResolvedValue({
      apiKey: 'profile-embedding-key',
      source: 'auth-profile' as const,
    });

    const result = await resolveEmbeddingCredentials('openai', tenantId);

    expect(mockResolveEmbeddingAuthProfile).toHaveBeenCalledWith('openai', tenantId);
    expect(result.apiKey).toBe('profile-embedding-key');
    expect(result.source).toBe('auth-profile');
  });

  it('falls back to legacy LLMCredential when auth profile returns null', async () => {
    mockResolveEmbeddingAuthProfile.mockResolvedValue(null);

    mockLLMCredential.findOne.mockReturnValue({
      sort: vi.fn().mockResolvedValue({
        encryptedApiKey: 'legacy-embedding-key',
      }),
    });

    const result = await resolveEmbeddingCredentials('openai', tenantId);

    expect(result.apiKey).toBe('legacy-embedding-key');
    expect(result.source).toBe('llm-credential');
  });

  it('uses legacy path before auth profile when legacy credentials are available', async () => {
    mockResolveEmbeddingAuthProfile.mockResolvedValue(null);

    mockLLMCredential.findOne.mockReturnValue({
      sort: vi.fn().mockResolvedValue({
        encryptedApiKey: 'legacy-key',
      }),
    });

    const result = await resolveEmbeddingCredentials('openai', tenantId);

    expect(mockResolveEmbeddingAuthProfile).not.toHaveBeenCalled();
    expect(result.apiKey).toBe('legacy-key');
    expect(result.source).toBe('llm-credential');
  });
});
