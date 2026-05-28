/**
 * Tenant Models & Connections Tests
 *
 * Tests for TenantModel CRUD, connections, and model resolution
 * through the tenant-based resolution chain.
 *
 * Resolution chain (after simplification):
 * Level 0: Deployment model override
 * Level 1: Agent IR
 * Level 2: Agent DB
 * Level 3: Project DB
 * Level 3b: Voice-specific
 * Level 4: Tenant Model — tier-specific → ANY default TenantModel
 * Level 5: FAIL with clear error
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ErrorCodes } from '@agent-platform/shared-kernel';
import { ModelResolutionService } from '../services/llm/model-resolution';

// Mock the repo module used by ModelResolutionService
const mockFindAgentModelConfig = vi.fn().mockResolvedValue(null);
const mockFindAgentModelConfigByDslName = vi.fn().mockResolvedValue(null);
const mockFindModelConfigByModelId = vi.fn().mockResolvedValue(null);
const mockFindModelConfigForTier = vi.fn().mockResolvedValue(null);
const mockFindAnyModelConfig = vi.fn().mockResolvedValue(null);
const mockFindTenantModelByIdWithPrimaryConnection = vi.fn().mockResolvedValue(null);
const mockFindDefaultTenantModelForTier = vi.fn().mockResolvedValue(null);
const mockFindAnyDefaultTenantModel = vi.fn().mockResolvedValue(null);
const mockFindTenantModelByProvider = vi.fn().mockResolvedValue(null);
const mockFindTenantLLMPolicy = vi.fn().mockResolvedValue(null);
const mockFindDefaultUserCredential = vi.fn().mockResolvedValue(null);
const mockFindDefaultTenantCredential = vi.fn().mockResolvedValue(null);
const mockFindDefaultTenantModelForVoice = vi.fn().mockResolvedValue(null);
const mockFindCredentialById = vi.fn().mockResolvedValue(null);
const mockFindProjectOperationTierOverrides = vi.fn().mockResolvedValue(null);
const mockFindProjectEnableThinking = vi.fn().mockResolvedValue(undefined);

// Mock the shared encryption module used by buildTenantModelResolution
// to decrypt connection API keys in encrypted format (N0:... or Z1:... envelopes).
const mockDecryptForTenantAuto = vi.fn().mockResolvedValue('sk-ant-test-key');
vi.mock('@agent-platform/shared/encryption', () => ({
  decryptForTenantAuto: (...args: any[]) => mockDecryptForTenantAuto(...args),
}));

vi.mock('../repos/llm-resolution-repo', () => ({
  isResolutionDatabaseAvailable: vi.fn().mockReturnValue(true),
  findAgentModelConfig: (...args: any[]) => mockFindAgentModelConfig(...args),
  findAgentModelConfigByDslName: (...args: any[]) => mockFindAgentModelConfigByDslName(...args),
  findModelConfigByModelId: (...args: any[]) => mockFindModelConfigByModelId(...args),
  findModelConfigForTier: (...args: any[]) => mockFindModelConfigForTier(...args),
  findAnyModelConfig: (...args: any[]) => mockFindAnyModelConfig(...args),
  findTenantModelByIdWithPrimaryConnection: (...args: any[]) =>
    mockFindTenantModelByIdWithPrimaryConnection(...args),
  findDefaultTenantModelForTier: (...args: any[]) => mockFindDefaultTenantModelForTier(...args),
  findAnyDefaultTenantModel: (...args: any[]) => mockFindAnyDefaultTenantModel(...args),
  findTenantModelByProvider: (...args: any[]) => mockFindTenantModelByProvider(...args),
  findTenantLLMPolicy: (...args: any[]) => mockFindTenantLLMPolicy(...args),
  findDefaultUserCredential: (...args: any[]) => mockFindDefaultUserCredential(...args),
  findDefaultTenantCredential: (...args: any[]) => mockFindDefaultTenantCredential(...args),
  findDefaultTenantModelForVoice: (...args: any[]) => mockFindDefaultTenantModelForVoice(...args),
  findCredentialById: (...args: any[]) => mockFindCredentialById(...args),
  findProjectOperationTierOverrides: (...args: any[]) =>
    mockFindProjectOperationTierOverrides(...args),
  findProjectEnableThinking: (...args: any[]) => mockFindProjectEnableThinking(...args),
}));

// =============================================================================
// Helpers
// =============================================================================

function makeTenantModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tm-1',
    tenantId: 'tenant-1',
    displayName: 'Claude Sonnet',
    integrationType: 'easy',
    modelId: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    isActive: true,
    inferenceEnabled: true,
    isDefault: true,
    tier: 'balanced',
    temperature: 0.7,
    maxTokens: 4096,
    connections: [
      {
        id: 'conn-1',
        encryptedApiKey: 'N0:AAAAAAAAAAAAAAAAAAAAAA==:BBBBBBBBBBBBBBBBBBBBBB==:CCCCCCCCCC==',
        authType: 'api_key',
        isActive: true,
        isPrimary: true,
      },
    ],
    ...overrides,
  };
}

function makeMockEncryption(apiKey = 'sk-ant-test-key') {
  return {
    decrypt: vi.fn().mockReturnValue(''),
    decryptForTenant: vi.fn().mockReturnValue(apiKey),
  } as any;
}

// =============================================================================
// ModelResolutionService — Tenant Model Resolution
// =============================================================================

describe('ModelResolutionService tenant model resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAgentModelConfig.mockResolvedValue(null);
    mockFindAgentModelConfigByDslName.mockResolvedValue(null);
    mockFindModelConfigByModelId.mockResolvedValue(null);
    mockFindModelConfigForTier.mockResolvedValue(null);
    mockFindAnyModelConfig.mockResolvedValue(null);
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(null);
    mockFindDefaultTenantModelForTier.mockResolvedValue(null);
    mockFindAnyDefaultTenantModel.mockResolvedValue(null);
    mockFindTenantModelByProvider.mockResolvedValue(null);
    mockFindTenantLLMPolicy.mockResolvedValue(null);
    mockFindDefaultUserCredential.mockResolvedValue(null);
    mockFindDefaultTenantCredential.mockResolvedValue(null);
    mockFindDefaultTenantModelForVoice.mockResolvedValue(null);
    mockFindCredentialById.mockResolvedValue(null);
    mockFindProjectOperationTierOverrides.mockResolvedValue(null);
    mockFindProjectEnableThinking.mockResolvedValue(undefined);
    mockDecryptForTenantAuto.mockResolvedValue('sk-ant-test-key');
  });

  describe('Level 4: Tenant Model resolution', () => {
    test('should resolve from tier-specific default tenant model', async () => {
      const model = makeTenantModel();
      mockFindDefaultTenantModelForTier.mockResolvedValue(model);

      const service = new ModelResolutionService(true, makeMockEncryption());
      const result = await service.resolve({
        tenantId: 'tenant-1',
        operationType: 'response_gen',
      });

      expect(result.modelId).toBe('claude-sonnet-4-20250514');
      expect(result.source).toBe('tenant_model');
      expect(result.provider).toBe('anthropic');
      expect(result.credential.apiKey).toBe('sk-ant-test-key');
      expect(result.parameters.temperature).toBe(0.7);
      expect(result.parameters.maxTokens).toBe(4096);
    });

    test('should resolve fast tier model for extraction operations', async () => {
      const fastModel = makeTenantModel({
        id: 'tm-fast',
        modelId: 'claude-haiku-4-5-20251001',
        tier: 'fast',
        temperature: 0.3,
        maxTokens: 2048,
      });
      mockFindDefaultTenantModelForTier.mockResolvedValue(fastModel);

      const service = new ModelResolutionService(true, makeMockEncryption());
      const result = await service.resolve({
        tenantId: 'tenant-1',
        operationType: 'extraction',
      });

      expect(result.modelId).toBe('claude-haiku-4-5-20251001');
      expect(result.source).toBe('tenant_model');
    });

    test('should fall back to any default TenantModel when tier miss', async () => {
      // No tier-specific model
      mockFindDefaultTenantModelForTier.mockResolvedValue(null);

      // But there IS a default model (different tier)
      const anyModel = makeTenantModel({
        id: 'tm-balanced',
        modelId: 'claude-sonnet-4-20250514',
        tier: 'balanced',
      });
      mockFindAnyDefaultTenantModel.mockResolvedValue(anyModel);

      const service = new ModelResolutionService(true, makeMockEncryption());
      const result = await service.resolve({
        tenantId: 'tenant-1',
        operationType: 'extraction', // maps to 'fast' tier — no model for fast
      });

      // Should still resolve via the tier-agnostic fallback
      expect(result.modelId).toBe('claude-sonnet-4-20250514');
      expect(result.source).toBe('tenant_model');
      expect(mockFindDefaultTenantModelForTier).toHaveBeenCalledWith('tenant-1', 'fast');
      expect(mockFindAnyDefaultTenantModel).toHaveBeenCalledWith('tenant-1');
    });

    test('should NOT call tier-agnostic fallback when tier-specific model found', async () => {
      const tierModel = makeTenantModel();
      mockFindDefaultTenantModelForTier.mockResolvedValue(tierModel);

      const service = new ModelResolutionService(true, makeMockEncryption());
      await service.resolve({
        tenantId: 'tenant-1',
        operationType: 'response_gen',
      });

      expect(mockFindAnyDefaultTenantModel).not.toHaveBeenCalled();
    });
  });

  describe('Level 5: FAIL with clear error', () => {
    test('should throw when no model or credential is configured', async () => {
      const service = new ModelResolutionService(false, null);

      await expect(
        service.resolve({
          operationType: 'response_gen',
        }),
      ).rejects.toMatchObject({
        code: ErrorCodes.MODEL_NOT_CONFIGURED.code,
        message:
          'AI model configuration is missing for this workspace. Ask your workspace administrator to configure a model and credentials.',
      });
    });

    test('should throw when no TenantModels exist for tenant', async () => {
      mockFindDefaultTenantModelForTier.mockResolvedValue(null);
      mockFindAnyDefaultTenantModel.mockResolvedValue(null);

      const service = new ModelResolutionService(true, makeMockEncryption());

      await expect(
        service.resolve({
          tenantId: 'tenant-1',
          operationType: 'response_gen',
        }),
      ).rejects.toMatchObject({
        code: ErrorCodes.MODEL_NOT_CONFIGURED.code,
        message:
          'AI model configuration is missing for this workspace. Ask your workspace administrator to configure a model and credentials.',
      });
    });
  });

  describe('Platform demo level removed', () => {
    test('should not have platform_demo as a valid source', async () => {
      // With tier-agnostic fallback, a tenant with any model should resolve
      const model = makeTenantModel();
      mockFindDefaultTenantModelForTier.mockResolvedValue(model);

      const service = new ModelResolutionService(true, makeMockEncryption());
      const result = await service.resolve({
        tenantId: 'tenant-1',
        operationType: 'response_gen',
      });

      expect(result.source).not.toBe('platform_demo');
    });
  });

  describe('API integration', () => {
    test('should resolve API integration model with custom endpoint', async () => {
      mockDecryptForTenantAuto.mockResolvedValue('gw-token-123');
      const apiModel = {
        id: 'tm-api',
        tenantId: 'tenant-1',
        integrationType: 'api',
        modelId: null,
        displayName: 'Internal LLM',
        provider: null,
        endpointUrl: 'https://llm.corp.com/v1/chat',
        providerStructure: 'openai',
        requestTemplate: null,
        responseMapping: null,
        customHeaders: JSON.stringify({ 'X-Gateway': 'internal' }),
        customEndpoint: null,
        isActive: true,
        inferenceEnabled: true,
        isDefault: true,
        tier: 'balanced',
        temperature: 0.5,
        maxTokens: 8192,
        connections: [
          {
            id: 'conn-api',
            encryptedApiKey: 'N0:AAAAAAAAAAAAAAAAAAAAAA==:BBBBBBBBBBBBBBBBBBBBBB==:DDDDDDDDDD==',
            authType: 'bearer',
            authConfig: null,
            isActive: true,
            isPrimary: true,
          },
        ],
      };

      mockFindDefaultTenantModelForTier.mockResolvedValue(apiModel);

      const service = new ModelResolutionService(true, makeMockEncryption('gw-token-123'));
      const result = await service.resolve({
        tenantId: 'tenant-1',
        operationType: 'response_gen',
      });

      expect(result.modelId).toBe('Internal LLM');
      expect(result.source).toBe('tenant_model');
      expect(result.credential.apiKey).toBe('gw-token-123');
      expect(result.credential.authType).toBe('bearer');
      expect(result.apiIntegration).toBeDefined();
      expect(result.apiIntegration!.providerStructure).toBe('openai');
      expect(result.apiIntegration!.customHeaders).toEqual({ 'X-Gateway': 'internal' });
    });
  });

  describe('dynamic hyperparameter compatibility cleanup', () => {
    test('project dynamic parameters ignore legacy scalar sampling defaults not stored in the bag', async () => {
      const tenantModel = makeTenantModel({
        id: 'tm-gpt-5',
        modelId: 'gpt-5',
        provider: 'openai',
        temperature: 0.7,
        maxTokens: 4096,
      });
      mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);
      mockFindModelConfigForTier.mockResolvedValue({
        id: 'model-config-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        modelId: 'gpt-5',
        tenantModelId: 'tm-gpt-5',
        tier: 'balanced',
        temperature: 0.8,
        maxTokens: 2048,
        topP: 0.9,
        frequencyPenalty: 0.2,
        presencePenalty: 0.3,
        hyperParameters: { reasoning_effort: 'medium' },
      });

      const service = new ModelResolutionService(true, makeMockEncryption());
      const result = await service.resolve({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        operationType: 'response_gen',
      });

      expect(result.modelId).toBe('gpt-5');
      expect(result.parameters.temperature).toBeUndefined();
      expect(result.parameters.topP).toBeUndefined();
      expect(result.parameters.frequencyPenalty).toBeUndefined();
      expect(result.parameters.presencePenalty).toBeUndefined();
      expect(result.parameters.reasoningEffort).toBe('medium');
      expect(result.parameters.maxTokens).toBe(2048);
    });

    test('agent dynamic parameters ignore stale legacy temperature when it is absent from the bag', async () => {
      const tenantModel = makeTenantModel({
        id: 'tm-gpt-4o',
        displayName: 'GPT-4o',
        modelId: 'gpt-4o',
        provider: 'openai',
        temperature: 0.7,
        maxTokens: 4096,
      });
      mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);
      mockFindAgentModelConfig.mockResolvedValue({
        id: 'agent-model-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        agentName: 'Support_Agent',
        defaultModel: 'gpt-4o',
        operationModels: {},
        temperature: 0.95,
        maxTokens: 1024,
        hyperParameters: { top_p: 0.25 },
      });
      mockFindModelConfigByModelId.mockResolvedValue({
        id: 'model-config-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        modelId: 'gpt-4o',
        tenantModelId: 'tm-gpt-4o',
        tier: 'balanced',
        temperature: 0.4,
        maxTokens: 2048,
        topP: 0.8,
        frequencyPenalty: 0,
        presencePenalty: 0,
        hyperParameters: { temperature: 0.4, top_p: 0.8 },
      });

      const service = new ModelResolutionService(true, makeMockEncryption());
      const result = await service.resolve({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        agentName: 'Support_Agent',
        operationType: 'response_gen',
      });

      expect(result.modelId).toBe('gpt-4o');
      expect(result.parameters.temperature).toBe(0.4);
      expect(result.parameters.topP).toBe(0.25);
      expect(result.parameters.maxTokens).toBe(1024);
    });
  });
});

// =============================================================================
// Provider allowlist enforcement
// =============================================================================

describe('Provider allowlist enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAgentModelConfig.mockResolvedValue(null);
    mockFindAgentModelConfigByDslName.mockResolvedValue(null);
    mockFindModelConfigByModelId.mockResolvedValue(null);
    mockFindModelConfigForTier.mockResolvedValue(null);
    mockFindAnyModelConfig.mockResolvedValue(null);
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(null);
    mockFindDefaultTenantModelForTier.mockResolvedValue(null);
    mockFindAnyDefaultTenantModel.mockResolvedValue(null);
    mockFindTenantModelByProvider.mockResolvedValue(null);
    mockFindTenantLLMPolicy.mockResolvedValue(null);
    mockFindDefaultUserCredential.mockResolvedValue(null);
    mockFindDefaultTenantCredential.mockResolvedValue(null);
    mockFindDefaultTenantModelForVoice.mockResolvedValue(null);
    mockFindCredentialById.mockResolvedValue(null);
    mockFindProjectOperationTierOverrides.mockResolvedValue(null);
    mockFindProjectEnableThinking.mockResolvedValue(undefined);
    mockDecryptForTenantAuto.mockResolvedValue('sk-ant-test-key');
  });

  test('should throw when provider not in allowlist', async () => {
    const mockTenantModel = makeTenantModel({
      modelId: 'gpt-4o',
      provider: 'openai',
    });

    mockFindTenantLLMPolicy.mockResolvedValue({
      tenantId: 'tenant-1',
      allowedProviders: ['anthropic'], // Only Anthropic allowed
      credentialPolicy: 'user_only',
      allowProjectCredentials: false,
    });

    mockFindDefaultTenantModelForTier.mockResolvedValue(mockTenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());

    await expect(
      service.resolve({
        tenantId: 'tenant-1',
        operationType: 'response_gen',
      }),
    ).rejects.toThrow(/not allowed for this tenant/);
  });

  test('allows Gemini models when the tenant policy uses the gemini provider alias', async () => {
    const mockTenantModel = makeTenantModel({
      modelId: 'gemini-2.5-flash',
      provider: 'google',
    });

    mockFindTenantLLMPolicy.mockResolvedValue({
      tenantId: 'tenant-1',
      allowedProviders: ['anthropic', 'openai', 'gemini'],
      credentialPolicy: 'org_first',
      allowProjectCredentials: true,
    });

    mockFindDefaultTenantModelForTier.mockResolvedValue(mockTenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    expect(result.provider).toBe('google');
    expect(result.modelId).toBe('gemini-2.5-flash');
  });

  test('does not treat Azure OpenAI as the openai provider in allowlist checks', async () => {
    const mockTenantModel = makeTenantModel({
      modelId: 'GPT-4.1',
      provider: 'azure',
    });

    mockFindTenantLLMPolicy.mockResolvedValue({
      tenantId: 'tenant-1',
      allowedProviders: ['openai'],
      credentialPolicy: 'org_first',
      allowProjectCredentials: true,
    });

    mockFindDefaultTenantModelForTier.mockResolvedValue(mockTenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());

    await expect(
      service.resolve({
        tenantId: 'tenant-1',
        operationType: 'response_gen',
      }),
    ).rejects.toThrow(/Provider 'azure'/);
  });
});
