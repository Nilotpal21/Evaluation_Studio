/**
 * Tests for Arch AI utilities and API clients:
 * - arch-llm.ts (exported constants)
 * - api/projects.ts (fetchProjects, fetchProject, createProject, updateProject, deleteProject, fetchProjectAgents, addAgentToProject, removeAgentFromProject)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expectRejectedMessage } from './helpers/expect-rejected-message';

// ---------------------------------------------------------------------------
// Mock zustand stores
// ---------------------------------------------------------------------------

const mockAuthStoreState = {
  accessToken: 'test-token',
  tenantId: 'tenant-1',
  setTokens: vi.fn(),
  clearAuth: vi.fn(),
};

vi.mock('@/store/auth-store', () => ({
  useAuthStore: {
    getState: () => mockAuthStoreState,
  },
}));

const mockProjectStoreState = {
  setProjects: vi.fn(),
  setLoading: vi.fn(),
  setError: vi.fn(),
  addProject: vi.fn(),
  removeProject: vi.fn(),
};

vi.mock('@/store/project-store', () => ({
  useProjectStore: {
    getState: () => mockProjectStoreState,
  },
}));

// ---------------------------------------------------------------------------
// Mock sanitize-error
// ---------------------------------------------------------------------------

vi.mock('@/lib/sanitize-error', () => ({
  sanitizeServerError: (msg: unknown, fallback: string) =>
    typeof msg === 'string' && msg.length > 0 ? msg : fallback,
  sanitizeError: (err: unknown, fallback: string) => {
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === 'string' && err.length > 0) return err;
    return fallback;
  },
}));

// ---------------------------------------------------------------------------
// Mock LLMClient for arch-llm tests
// ---------------------------------------------------------------------------

class MockLLMClientClass {
  complete = vi.fn();
  static constructorCalls: unknown[][] = [];
  constructor(...args: unknown[]) {
    MockLLMClientClass.constructorCalls.push(args);
  }
}

const mockCreateVercelProvider = vi.fn();
const mockResolveTenantPlaintextValue = vi.fn();

vi.mock('@abl/compiler/platform/llm/provider.js', () => ({
  LLMClient: MockLLMClientClass,
  getDefaultModel: (provider: string) => {
    if (provider === 'anthropic') return 'claude-sonnet-4-6';
    if (provider === 'openai') return 'gpt-4o';
    if (provider === 'google' || provider === 'vertex') return 'gemini-2.5-pro';
    return 'claude-sonnet-4-6';
  },
}));

vi.mock('@abl/compiler/platform/llm/providers/index.js', () => ({}));

vi.mock('@agent-platform/llm', () => ({
  createVercelProvider: (...args: unknown[]) => mockCreateVercelProvider(...args),
}));

vi.mock('@agent-platform/database', () => ({
  resolveTenantPlaintextValue: (...args: unknown[]) => mockResolveTenantPlaintextValue(...args),
}));

// Mock database models to prevent mongoose model overwrite errors on re-import
const mockArchConfigFindOne = vi.fn().mockResolvedValue(null);
const mockTenantModelFindOne = vi.fn().mockResolvedValue(null);
const mockLLMCredentialFindOne = vi.fn().mockResolvedValue(null);

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  ArchWorkspaceConfig: {
    findOne: (...args: unknown[]) => mockArchConfigFindOne(...args),
  },
  TenantModel: {
    findOne: (...args: unknown[]) => mockTenantModelFindOne(...args),
  },
  LLMCredential: {
    findOne: (...args: unknown[]) => mockLLMCredentialFindOne(...args),
  },
  AuthProfile: {
    findOne: vi.fn().mockResolvedValue(null),
  },
}));

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  mockAuthStoreState.accessToken = 'test-token';
  mockAuthStoreState.tenantId = 'tenant-1';
  mockResolveTenantPlaintextValue.mockReset();
  mockResolveTenantPlaintextValue.mockImplementation(
    async (value: string | null | undefined) => value ?? null,
  );
});

// ===========================================================================
// arch-llm.ts
// ===========================================================================

describe('arch-llm', () => {
  describe('exported constants', () => {
    it('should export ARCH_CHAT_MAX_TOKENS as 2048', async () => {
      const { ARCH_CHAT_MAX_TOKENS } = await import('@/lib/arch-llm');
      expect(ARCH_CHAT_MAX_TOKENS).toBe(2048);
    });

    it('should export ARCH_GENERATE_MAX_TOKENS as 8192', async () => {
      const { ARCH_GENERATE_MAX_TOKENS } = await import('@/lib/arch-llm');
      expect(ARCH_GENERATE_MAX_TOKENS).toBe(8192);
    });

    it('should export ARCH_TIMEOUT_MS as 60000', async () => {
      const { ARCH_TIMEOUT_MS } = await import('@/lib/arch-llm');
      expect(ARCH_TIMEOUT_MS).toBe(60_000);
    });

    it('should export ARCH_CHAT_MODEL with a default value', async () => {
      const { ARCH_CHAT_MODEL } = await import('@/lib/arch-llm');
      expect(typeof ARCH_CHAT_MODEL).toBe('string');
      expect(ARCH_CHAT_MODEL.length).toBeGreaterThan(0);
    });

    it('should export ARCH_GENERATE_MODEL with a default value', async () => {
      const { ARCH_GENERATE_MODEL } = await import('@/lib/arch-llm');
      expect(typeof ARCH_GENERATE_MODEL).toBe('string');
      expect(ARCH_GENERATE_MODEL.length).toBeGreaterThan(0);
    });
  });

  describe('resolveArchLLMClient', () => {
    beforeEach(() => {
      mockArchConfigFindOne.mockResolvedValue(null);
      mockTenantModelFindOne.mockResolvedValue(null);
      mockLLMCredentialFindOne.mockResolvedValue(null);
      MockLLMClientClass.constructorCalls = [];
      mockCreateVercelProvider.mockReset();
      // Mock a proper Vercel AI SDK LanguageModel with required methods
      mockCreateVercelProvider.mockReturnValue({
        modelId: 'mock-model',
        provider: 'mock',
        doGenerate: vi.fn(),
        doStream: vi.fn(),
      });
      // Clear platform key env vars so attemptAutoPlatformTarget cannot fall through
      // and override expected null results in tests that verify tenant-config failures.
      // Without this, a dev ANTHROPIC_API_KEY / OPENAI_API_KEY in .env.local causes
      // the auto-platform path to succeed and return source:'platform' instead of 'none'.
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('OPENAI_API_KEY', '');
      vi.stubEnv('GEMINI_API_KEY', '');
      vi.stubEnv('GOOGLE_API_KEY', '');
    });

    it('should return error when no config exists', async () => {
      const { resolveArchLLMClient } = await import('@/lib/arch-llm');
      const result = await resolveArchLLMClient('tenant-1');

      expect(result.client).toBeNull();
      expect(result.source).toBe('none');
      expect(result.error).toBeDefined();
    });

    it('should resolve via Tier 1a when tenantModelId points to valid TenantModel + credential', async () => {
      mockArchConfigFindOne.mockResolvedValue({
        tenantModelId: 'tm-1',
        modelId: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        maxTokensChat: 2048,
        maxTokensGenerate: 8192,
        temperature: 0.7,
      });
      mockTenantModelFindOne.mockResolvedValue({
        _id: 'tm-1',
        provider: 'openai',
        modelId: 'gpt-4o',
        connections: [{ isPrimary: true, isActive: true, credentialId: 'cred-1' }],
      });
      mockLLMCredentialFindOne.mockResolvedValue({
        _id: 'cred-1',
        encryptedApiKey: 'sk-test-key',
      });

      const { resolveArchLLMClient } = await import('@/lib/arch-llm');
      const result = await resolveArchLLMClient('tenant-1');

      expect(result.client).not.toBeNull();
      expect(result.source).toBe('tenant');
      // Model should come from TenantModel, not ArchWorkspaceConfig
      expect(result.model).toBe('gpt-4o');
      // LLMClient should have been constructed once with an LLMProvider for openai
      expect(MockLLMClientClass.constructorCalls.length).toBe(1);
      const ctorArgs = MockLLMClientClass.constructorCalls[0][0] as Record<string, unknown>;
      // LLMClient now receives an LLMProvider object; provider type is in `name`
      expect(ctorArgs.name).toBe('openai');
    });

    it('should infer Model Hub provider from registry for provider-native slash model IDs', async () => {
      mockArchConfigFindOne.mockResolvedValue({
        tenantModelId: 'tm-provider-native',
        maxTokensChat: 2048,
        maxTokensGenerate: 8192,
        temperature: 0.7,
      });
      mockTenantModelFindOne.mockResolvedValue({
        _id: 'tm-provider-native',
        modelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        connections: [{ isPrimary: true, isActive: true, credentialId: 'cred-provider-native' }],
      });
      mockLLMCredentialFindOne.mockResolvedValue({
        _id: 'cred-provider-native',
        encryptedApiKey: 'sk-provider-native-key',
      });

      const { resolveArchLLMClient } = await import('@/lib/arch-llm');
      const result = await resolveArchLLMClient('tenant-1');

      expect(result.client).not.toBeNull();
      expect(result.source).toBe('tenant');
      expect(result.provider).toBe('togetherai');
      expect(result.model).toBe('meta-llama/Llama-3.3-70B-Instruct-Turbo');
      expect(mockCreateVercelProvider).toHaveBeenCalledWith(
        'togetherai',
        'sk-provider-native-key',
        undefined,
        'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        undefined,
        undefined,
      );
    });

    it('should enforce tenant isolation on TenantModel lookup', async () => {
      mockArchConfigFindOne.mockResolvedValue({
        tenantModelId: 'tm-other-tenant',
        provider: 'anthropic',
      });
      // TenantModel.findOne returns null (tenantId filter prevents cross-tenant)
      mockTenantModelFindOne.mockResolvedValue(null);

      const { resolveArchLLMClient } = await import('@/lib/arch-llm');
      const result = await resolveArchLLMClient('tenant-1');

      // Should fall through to next tier (no client from Tier 1a)
      expect(result.source).toBe('none');
      // Verify TenantModel.findOne was called with tenantId filter
      expect(mockTenantModelFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1' }),
      );
    });

    it('should not silently fall back from a selected Model Hub model to an automatic tenant model', async () => {
      mockArchConfigFindOne.mockResolvedValue({
        tenantModelId: 'tm-missing',
        provider: 'openai',
        modelId: 'gpt-4o',
      });
      mockTenantModelFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
        _id: 'tm-azure-default',
        provider: 'azure',
        modelId: 'gpt-5.4-mini',
        connections: [{ isPrimary: true, isActive: true, credentialId: 'cred-azure' }],
      });
      mockLLMCredentialFindOne.mockResolvedValue({
        _id: 'cred-azure',
        encryptedApiKey: 'azure-key-that-should-not-be-used',
        encryptedEndpoint: 'https://inception-oai.openai.azure.com',
      });

      const { resolveArchLLMClient } = await import('@/lib/arch-llm');
      const result = await resolveArchLLMClient('tenant-1');

      expect(result.client).toBeNull();
      expect(result.source).toBe('none');
      expect(result.requestedSource).toBe('model_hub');
      expect(result.usedFallback).toBe(false);
      expect(mockTenantModelFindOne).toHaveBeenCalledTimes(1);
      expect(mockLLMCredentialFindOne).not.toHaveBeenCalled();
    });

    it('should fall through when TenantModel has no connections', async () => {
      mockArchConfigFindOne.mockResolvedValue({
        tenantModelId: 'tm-no-conn',
        provider: 'anthropic',
      });
      mockTenantModelFindOne.mockResolvedValue({
        _id: 'tm-no-conn',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-20250514',
        connections: [],
      });

      const { resolveArchLLMClient } = await import('@/lib/arch-llm');
      const result = await resolveArchLLMClient('tenant-1');

      expect(result.client).toBeNull();
      expect(result.source).toBe('none');
    });

    it('should fall through when credential has no API key', async () => {
      mockArchConfigFindOne.mockResolvedValue({
        tenantModelId: 'tm-no-key',
        provider: 'anthropic',
      });
      mockTenantModelFindOne.mockResolvedValue({
        _id: 'tm-no-key',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-20250514',
        connections: [{ isPrimary: true, isActive: true, credentialId: 'cred-empty' }],
      });
      mockLLMCredentialFindOne.mockResolvedValue({
        _id: 'cred-empty',
        encryptedApiKey: null,
      });

      const { resolveArchLLMClient } = await import('@/lib/arch-llm');
      const result = await resolveArchLLMClient('tenant-1');

      expect(result.client).toBeNull();
      expect(result.source).toBe('none');
    });

    it('should not silently fall back from a bad direct OpenAI key to platform or tenant Azure', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-platform-openai-key-that-should-not-be-used');
      mockArchConfigFindOne.mockResolvedValue({
        tenantModelId: null,
        modelId: 'gpt-4o',
        provider: 'openai',
        usePlatformCredits: false,
        encryptedApiKey: 'short',
      });
      mockTenantModelFindOne.mockResolvedValue({
        _id: 'tm-azure-default',
        provider: 'azure',
        modelId: 'gpt-5.4-mini',
        connections: [{ isPrimary: true, isActive: true, credentialId: 'cred-azure' }],
      });

      const { resolveArchLLMClient } = await import('@/lib/arch-llm');
      const result = await resolveArchLLMClient('tenant-1');

      expect(result.client).toBeNull();
      expect(result.source).toBe('none');
      expect(result.requestedSource).toBe('direct_api_key');
      expect(result.usedFallback).toBe(false);
      expect(mockCreateVercelProvider).not.toHaveBeenCalled();
      expect(mockTenantModelFindOne).not.toHaveBeenCalled();
    });

    it('should still auto-resolve a tenant Model Hub model when no Arch config exists', async () => {
      mockArchConfigFindOne.mockResolvedValue(null);
      mockTenantModelFindOne.mockResolvedValue({
        _id: 'tm-auto',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        connections: [{ isPrimary: true, isActive: true, credentialId: 'cred-auto' }],
      });
      mockLLMCredentialFindOne.mockResolvedValue({
        _id: 'cred-auto',
        encryptedApiKey: 'sk-auto-tenant-key',
      });

      const { resolveArchLLMClient } = await import('@/lib/arch-llm');
      const result = await resolveArchLLMClient('tenant-1');

      expect(result.client).not.toBeNull();
      expect(result.source).toBe('tenant');
      expect(result.resolutionPath).toBe('auto_model_hub');
      expect(result.requestedSource).toBe('auto');
      expect(result.usedFallback).toBe(false);
    });

    it('should use Tier 1b when tenantModelId is not set but encryptedApiKey exists', async () => {
      mockArchConfigFindOne.mockResolvedValue({
        tenantModelId: null,
        modelId: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        maxTokensChat: 2048,
        maxTokensGenerate: 8192,
        temperature: 0.7,
        usePlatformCredits: false,
        encryptedApiKey: 'sk-direct-key',
      });

      const { resolveArchLLMClient } = await import('@/lib/arch-llm');
      const result = await resolveArchLLMClient('tenant-1');

      expect(result.client).not.toBeNull();
      expect(result.source).toBe('tenant');
      // Model ID is normalized from legacy ID
      expect(result.model).toBe('claude-sonnet-4-6');
      // LLMClient receives an LLMProvider object; provider type is in `name`
      const ctorArgs = MockLLMClientClass.constructorCalls[0][0] as Record<string, unknown>;
      expect(ctorArgs.name).toBe('anthropic');
    });

    it('should prefer Tier 1a over Tier 1b when both are available', async () => {
      mockArchConfigFindOne.mockResolvedValue({
        tenantModelId: 'tm-priority',
        modelId: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        maxTokensChat: 2048,
        maxTokensGenerate: 8192,
        temperature: 0.7,
        usePlatformCredits: false,
        encryptedApiKey: 'sk-should-not-use',
      });
      mockTenantModelFindOne.mockResolvedValue({
        _id: 'tm-priority',
        provider: 'openai',
        modelId: 'gpt-4o',
        connections: [{ isPrimary: true, isActive: true, credentialId: 'cred-hub' }],
      });
      mockLLMCredentialFindOne.mockResolvedValue({
        _id: 'cred-hub',
        encryptedApiKey: 'sk-hub-key',
      });

      const { resolveArchLLMClient } = await import('@/lib/arch-llm');
      const result = await resolveArchLLMClient('tenant-1');

      // Tier 1a should win — uses TenantModel's provider/model/key
      expect(result.source).toBe('tenant');
      expect(result.model).toBe('gpt-4o');
      // Only one LLMClient created (Tier 1a short-circuits Tier 1b)
      expect(MockLLMClientClass.constructorCalls.length).toBe(1);
      const ctorArgs = MockLLMClientClass.constructorCalls[0][0] as Record<string, unknown>;
      // LLMProvider object — provider type is `name`
      expect(ctorArgs.name).toBe('openai');
    });

    it('should include custom endpoint from credential', async () => {
      mockArchConfigFindOne.mockResolvedValue({
        tenantModelId: 'tm-endpoint',
        provider: 'openai',
      });
      mockTenantModelFindOne.mockResolvedValue({
        _id: 'tm-endpoint',
        provider: 'openai',
        modelId: 'gpt-4o',
        connections: [{ isPrimary: true, isActive: true, credentialId: 'cred-ep' }],
      });
      mockLLMCredentialFindOne.mockResolvedValue({
        _id: 'cred-ep',
        encryptedApiKey: 'sk-valid-openai-key-1234567890',
        encryptedEndpoint: 'https://custom-openai.example.com/v1',
      });

      const { resolveArchLLMClient } = await import('@/lib/arch-llm');
      const result = await resolveArchLLMClient('tenant-1');

      // Client should be created successfully with the custom endpoint in the provider closure
      expect(result.client).not.toBeNull();
      expect(result.source).toBe('tenant');
      expect(MockLLMClientClass.constructorCalls.length).toBe(1);
      expect(mockCreateVercelProvider).toHaveBeenCalledWith(
        'openai',
        'sk-valid-openai-key-1234567890',
        'https://custom-openai.example.com/v1',
        'gpt-4o',
        undefined,
        undefined,
      );
    });

    it('should reject Azure endpoints when the saved provider is plain OpenAI', async () => {
      mockArchConfigFindOne.mockResolvedValue({
        tenantModelId: 'tm-azure-miswired',
        provider: 'openai',
      });
      mockTenantModelFindOne.mockResolvedValue({
        _id: 'tm-azure-miswired',
        provider: 'openai',
        modelId: 'gpt-5.4-mini',
        connections: [{ isPrimary: true, isActive: true, credentialId: 'cred-azure' }],
      });
      mockLLMCredentialFindOne.mockResolvedValue({
        _id: 'cred-azure',
        encryptedApiKey: 'sk-valid-openai-key-1234567890',
        encryptedEndpoint: 'https://inception-oai.openai.azure.com',
      });

      const { resolveArchLLMClient } = await import('@/lib/arch-llm');
      const result = await resolveArchLLMClient('tenant-1');

      expect(result.client).toBeNull();
      expect(result.source).toBe('none');
      expect(result.requestedSource).toBe('model_hub');
      expect(result.error).toContain('Azure OpenAI endpoints must use the Azure provider');
      expect(mockCreateVercelProvider).not.toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// arch.service.ts
// ===========================================================================

describe('arch.service', () => {
  beforeEach(() => {
    mockArchConfigFindOne.mockResolvedValue(null);
    mockTenantModelFindOne.mockResolvedValue(null);
  });

  it('should clear stale Model Hub and auth profile fields when saving a direct API key', async () => {
    const configDoc: Record<string, unknown> = {
      tenantId: 'tenant-1',
      tenantModelId: 'tm-stale',
      authProfileId: 'auth-stale',
      usePlatformCredits: true,
      provider: 'azure',
      modelId: 'gpt-5.4-mini',
      encryptedApiKey: 'old-key',
      set: vi.fn((key: string, value: unknown) => {
        configDoc[key] = value;
      }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockArchConfigFindOne.mockResolvedValue(configDoc);

    const { updateArchConfig } = await import('@/services/arch.service');
    const result = await updateArchConfig('tenant-1', 'user-1', {
      provider: 'openai',
      modelId: 'gpt-4o',
      usePlatformCredits: false,
      apiKey: 'sk-valid-openai-key-1234567890',
    });

    expect(result.success).toBe(true);
    expect(configDoc['set']).toHaveBeenCalledWith('tenantModelId', null);
    expect(configDoc['set']).toHaveBeenCalledWith('authProfileId', null);
    expect(configDoc['set']).toHaveBeenCalledWith('usePlatformCredits', false);
    expect(configDoc['tenantModelId']).toBeNull();
    expect(configDoc['authProfileId']).toBeNull();
    expect(configDoc['usePlatformCredits']).toBe(false);
    expect(configDoc['encryptedApiKey']).toBe('sk-valid-openai-key-1234567890');
  });

  it('should only allow active tool-capable TenantModels with active credentials for Arch', async () => {
    const lean = vi.fn().mockResolvedValue(null);
    mockTenantModelFindOne.mockReturnValue({ lean });

    const { updateArchConfig } = await import('@/services/arch.service');
    const result = await updateArchConfig('tenant-1', 'user-1', {
      tenantModelId: 'tm-disabled',
      provider: 'azure',
      modelId: 'gpt-5.4-mini',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(404);
      expect(result.error.code).toBe('INVALID_REFERENCE');
    }
    expect(mockTenantModelFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'tm-disabled',
        tenantId: 'tenant-1',
        isActive: true,
        inferenceEnabled: true,
        supportsTools: true,
      }),
    );
    expect(mockTenantModelFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        connections: expect.objectContaining({
          $elemMatch: expect.objectContaining({ isActive: true }),
        }),
      }),
    );
    expect(mockArchConfigFindOne).not.toHaveBeenCalled();
  });

  it('should clear stale direct credentials when switching to Model Hub credentials', async () => {
    const lean = vi.fn().mockResolvedValue({
      _id: 'tm-active',
      tenantId: 'tenant-1',
      isActive: true,
      inferenceEnabled: true,
      supportsTools: true,
      connections: [{ isActive: true, credentialId: 'cred-1' }],
    });
    mockTenantModelFindOne.mockReturnValue({ lean });
    const configDoc: Record<string, unknown> = {
      tenantId: 'tenant-1',
      tenantModelId: null,
      authProfileId: null,
      usePlatformCredits: false,
      encryptedApiKey: 'sk-stale-direct-key',
      encryptedEndpoint: 'https://direct.example.com/v1',
      set: vi.fn((key: string, value: unknown) => {
        configDoc[key] = value;
      }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockArchConfigFindOne.mockResolvedValue(configDoc);

    const { updateArchConfig } = await import('@/services/arch.service');
    const result = await updateArchConfig('tenant-1', 'user-1', {
      tenantModelId: 'tm-active',
      provider: 'openai',
      modelId: 'gpt-4o',
    });

    expect(result.success).toBe(true);
    expect(configDoc['encryptedApiKey']).toBeUndefined();
    expect(configDoc['encryptedEndpoint']).toBeUndefined();
    if (result.success) {
      expect(result.data.hasApiKey).toBe(false);
      expect(result.data.hasEndpoint).toBe(false);
    }
  });
});

// ===========================================================================
// api/projects.ts
// ===========================================================================

describe('api/projects', () => {
  // Helper to return a successful fetch response
  function okResponse(data: unknown): Response {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  describe('fetchProjects', () => {
    it('should fetch and return project list', async () => {
      const projects = [{ id: 'p1', name: 'Project 1' }];
      mockFetch.mockResolvedValueOnce(okResponse({ projects }));

      const { fetchProjects } = await import('@/api/projects');
      const result = await fetchProjects();

      expect(result).toEqual(projects);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects'),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        }),
      );
    });

    it('should include Authorization header when token exists', async () => {
      mockFetch.mockResolvedValueOnce(okResponse({ projects: [] }));

      const { fetchProjects } = await import('@/api/projects');
      await fetchProjects();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        }),
      );
    });

    it('should throw on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Server Error' }), { status: 500 }),
      );

      const { fetchProjects } = await import('@/api/projects');
      await expectRejectedMessage(fetchProjects(), 'Server Error');
    });
  });

  describe('fetchProject', () => {
    it('should fetch a single project by ID', async () => {
      const project = { id: 'p1', name: 'My Project' };
      mockFetch.mockResolvedValueOnce(okResponse({ success: true, project }));

      const { fetchProject } = await import('@/api/projects');
      const result = await fetchProject('p1');

      expect(result).toEqual(project);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/p1'),
        expect.any(Object),
      );
    });
  });

  describe('createProject', () => {
    it('should POST project data and return created project', async () => {
      const newProject = { id: 'p-new', name: 'New Project', slug: 'new-project' };
      mockFetch.mockResolvedValueOnce(okResponse({ success: true, project: newProject }));

      const { createProject } = await import('@/api/projects');
      const result = await createProject({ name: 'New Project', slug: 'new-project' });

      expect(result).toEqual(newProject);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'New Project', slug: 'new-project' }),
        }),
      );
    });
  });

  describe('updateProject', () => {
    it('should PATCH project data and return updated project', async () => {
      const updated = { id: 'p1', name: 'Updated Name' };
      mockFetch.mockResolvedValueOnce(okResponse({ success: true, project: updated }));

      const { updateProject } = await import('@/api/projects');
      const result = await updateProject('p1', { name: 'Updated Name' });

      expect(result).toEqual(updated);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/p1'),
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
  });

  describe('deleteProject', () => {
    it('should DELETE a project', async () => {
      mockFetch.mockResolvedValueOnce(okResponse({ success: true }));

      const { deleteProject } = await import('@/api/projects');
      await deleteProject('p1');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/p1'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('fetchProjectAgents', () => {
    it('should fetch agents for a project', async () => {
      const agents = [{ id: 'a1', name: 'Agent 1' }];
      mockFetch.mockResolvedValueOnce(okResponse({ agents }));

      const { fetchProjectAgents } = await import('@/api/projects');
      const result = await fetchProjectAgents('proj-1');

      expect(result).toEqual(agents);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/proj-1/agents'),
        expect.any(Object),
      );
    });
  });

  describe('addAgentToProject', () => {
    it('should POST new agent to project', async () => {
      const agent = { id: 'a-new', name: 'new_agent', agentPath: 'domain/new_agent' };
      mockFetch
        .mockResolvedValueOnce(okResponse(agent))
        .mockResolvedValueOnce(okResponse({ projects: [] }));

      const { addAgentToProject } = await import('@/api/projects');
      const result = await addAgentToProject('proj-1', {
        name: 'new_agent',
      });

      expect(result).toEqual(agent);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/proj-1/agents'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should refresh project list counts after adding an agent', async () => {
      const agent = {
        id: 'a-new',
        projectId: 'proj-1',
        name: 'new_agent',
        agentPath: 'domain/new_agent',
      };
      const refreshedProjects = [
        {
          id: 'proj-1',
          name: 'Project 1',
          slug: 'project-1',
          createdAt: '2026-05-06T00:00:00.000Z',
          updatedAt: '2026-05-06T00:00:00.000Z',
          agentCount: 1,
          sessionCount: 0,
          kind: 'application',
        },
      ];
      mockFetch
        .mockResolvedValueOnce(okResponse(agent))
        .mockResolvedValueOnce(okResponse({ projects: refreshedProjects }));

      const { addAgentToProject } = await import('@/api/projects');
      await addAgentToProject('proj-1', {
        name: 'new_agent',
      });

      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('/api/projects/proj-1/agents'),
        expect.objectContaining({ method: 'POST' }),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('/api/projects'),
        expect.objectContaining({ cache: 'no-store' }),
      );
      expect(mockProjectStoreState.setProjects).toHaveBeenCalledWith(refreshedProjects);
    });

    it('should not refresh project list counts when adding an agent fails', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Create failed' }), { status: 500 }),
      );

      const { addAgentToProject } = await import('@/api/projects');
      await expectRejectedMessage(
        addAgentToProject('proj-1', {
          name: 'new_agent',
        }),
        'Create failed',
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockProjectStoreState.setProjects).not.toHaveBeenCalled();
    });
  });

  describe('removeAgentFromProject', () => {
    it('should DELETE agent from project', async () => {
      mockFetch
        .mockResolvedValueOnce(okResponse({ success: true }))
        .mockResolvedValueOnce(okResponse({ projects: [] }));

      const { removeAgentFromProject } = await import('@/api/projects');
      await removeAgentFromProject('proj-1', 'agent-1');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/proj-1/agents/agent-1'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('should refresh project list counts after removing an agent', async () => {
      const refreshedProjects = [
        {
          id: 'proj-1',
          name: 'Project 1',
          slug: 'project-1',
          createdAt: '2026-05-06T00:00:00.000Z',
          updatedAt: '2026-05-06T00:00:00.000Z',
          agentCount: 0,
          sessionCount: 0,
          kind: 'application',
        },
      ];
      mockFetch
        .mockResolvedValueOnce(okResponse({ success: true }))
        .mockResolvedValueOnce(okResponse({ projects: refreshedProjects }));

      const { removeAgentFromProject } = await import('@/api/projects');
      await removeAgentFromProject('proj-1', 'agent-1');

      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('/api/projects/proj-1/agents/agent-1'),
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('/api/projects'),
        expect.objectContaining({ cache: 'no-store' }),
      );
      expect(mockProjectStoreState.setProjects).toHaveBeenCalledWith(refreshedProjects);
    });

    it('should not refresh project list counts when removing an agent fails', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Delete failed' }), { status: 500 }),
      );

      const { removeAgentFromProject } = await import('@/api/projects');
      await expectRejectedMessage(removeAgentFromProject('proj-1', 'agent-1'), 'Delete failed');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockProjectStoreState.setProjects).not.toHaveBeenCalled();
    });
  });

  describe('loadProjects (store integration)', () => {
    it('should set loading state and call setProjects on success', async () => {
      const projects = [{ id: 'p1', name: 'P1' }];
      mockFetch.mockResolvedValueOnce(okResponse({ projects }));

      const { loadProjects } = await import('@/api/projects');
      await loadProjects();

      expect(mockProjectStoreState.setLoading).toHaveBeenCalledWith(true);
      expect(mockProjectStoreState.setProjects).toHaveBeenCalledWith(projects);
      expect(mockProjectStoreState.setLoading).toHaveBeenCalledWith(false);
    });

    it('should set error on failure', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
      );

      const { loadProjects } = await import('@/api/projects');
      await loadProjects();

      expect(mockProjectStoreState.setError).toHaveBeenCalledWith(expect.any(String));
      expect(mockProjectStoreState.setLoading).toHaveBeenCalledWith(false);
    });
  });
});
