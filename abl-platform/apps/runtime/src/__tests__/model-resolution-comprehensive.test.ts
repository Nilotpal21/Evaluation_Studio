/**
 * Comprehensive Model Resolution Tests
 *
 * Covers all gaps identified in the resolution chain audit:
 * - Cache behavior (TTL, invalidation, cross-user contamination)
 * - tenantModelId caching and rehydration
 * - displayName-as-modelId fallback
 * - filterPrimaryConnection fallback behavior
 * - Level 0 (deployment override), Level 2 (agent DB), Level 3 (project DB)
 * - Multi-user credential policy resolution
 * - Auth profile dual-read integration
 * - Project-level enableThinking and tier overrides
 * - findAgentModelConfigByDslName full scan
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorCodes } from '@agent-platform/shared-kernel';
import { ModelResolutionService, inferProviderFromModelId } from '../services/llm/model-resolution';

// =============================================================================
// Mock Setup — all repo functions individually controllable
// =============================================================================

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
const mockFindCredentialById = vi.fn().mockResolvedValue(null);
const mockFindDefaultTenantModelForVoice = vi.fn().mockResolvedValue(null);
const mockFindProjectOperationTierOverrides = vi.fn().mockResolvedValue(null);
const mockFindProjectEnableThinking = vi.fn().mockResolvedValue(undefined);
const mockResolveTenantPlaintextValue = vi.fn();

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
  findCredentialById: (...args: any[]) => mockFindCredentialById(...args),
  findDefaultTenantModelForVoice: (...args: any[]) => mockFindDefaultTenantModelForVoice(...args),
  findProjectOperationTierOverrides: (...args: any[]) =>
    mockFindProjectOperationTierOverrides(...args),
  findProjectEnableThinking: (...args: any[]) => mockFindProjectEnableThinking(...args),
}));

vi.mock('@agent-platform/database', () => ({
  resolveTenantPlaintextValue: (...args: any[]) => mockResolveTenantPlaintextValue(...args),
}));

// Mock the shared encryption module used by buildTenantModelResolution
// to decrypt connection API keys in encrypted format (N0:... or Z1:... envelopes).
const mockDecryptForTenantAuto = vi.fn().mockResolvedValue('sk-ant-test-key');
vi.mock('@agent-platform/shared/encryption', () => ({
  decryptForTenantAuto: (...args: any[]) => mockDecryptForTenantAuto(...args),
}));

// Mock AuthProfile for auth profile tests
const mockAuthProfileFindOne = vi.fn().mockResolvedValue(null);
// Mock TenantModel.find() chain for the merged DSL-modelId tail (Phase B).
// Returns lean candidate docs ({_id, isDefault}); resolveTenantModelById
// then loads each via mockFindTenantModelByIdWithPrimaryConnection.
const mockTenantModelFindCandidates = vi.fn().mockResolvedValue([]);
vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: (...args: any[]) => mockAuthProfileFindOne(...args),
    updateOne: vi.fn().mockResolvedValue({}),
  },
  TenantModel: {
    find: (filter: any) => ({
      sort: (_sort: any) => ({
        select: (_proj: any) => ({
          lean: () => mockTenantModelFindCandidates(filter),
        }),
      }),
    }),
  },
}));

// Mock config — relative to the service file that imports it
vi.mock('../config/index.js', () => ({
  isConfigLoaded: vi.fn().mockReturnValue(false),
  getConfig: vi.fn(),
}));

// =============================================================================
// Helpers
// =============================================================================

function makeTenantModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tm-1',
    _id: 'tm-1',
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
        // Use encryptedApiKey directly (not credentialId) for the default helper.
        // Tests that need credentialId-based resolution should override connections.
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
    decrypt: vi.fn().mockReturnValue(apiKey),
    decryptForTenant: vi.fn().mockReturnValue(apiKey),
  } as any;
}

function makeCredential(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'cred-1',
    tenantId: 'tenant-1',
    encryptedApiKey: 'decrypted-api-key',
    encryptedEndpoint: null,
    authType: 'api_key',
    authConfig: null,
    isActive: true,
    ...overrides,
  };
}

function resetAllMocks() {
  vi.clearAllMocks();
  mockFindAgentModelConfig.mockResolvedValue(null);
  mockFindAgentModelConfigByDslName.mockResolvedValue(null);
  mockFindModelConfigByModelId.mockResolvedValue(null);
  mockFindModelConfigForTier.mockResolvedValue(null);
  mockFindAnyModelConfig.mockResolvedValue(null);
  mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(null);
  mockFindDefaultTenantModelForTier.mockResolvedValue(null);
  // Legacy tests use the tier mock as shorthand for "the tenant default model".
  // Routing-specific tests override this mock directly to assert the exact repo call.
  mockFindAnyDefaultTenantModel.mockImplementation((tenantId: string) =>
    mockFindDefaultTenantModelForTier(tenantId, 'balanced'),
  );
  mockFindTenantModelByProvider.mockResolvedValue(null);
  mockFindTenantLLMPolicy.mockResolvedValue(null);
  mockFindDefaultUserCredential.mockResolvedValue(null);
  mockFindDefaultTenantCredential.mockResolvedValue(null);
  mockFindCredentialById.mockResolvedValue(null);
  mockFindDefaultTenantModelForVoice.mockResolvedValue(null);
  mockFindProjectOperationTierOverrides.mockResolvedValue(null);
  mockFindProjectEnableThinking.mockResolvedValue(undefined);
  mockAuthProfileFindOne.mockResolvedValue(null);
  mockTenantModelFindCandidates.mockResolvedValue([]);
  mockDecryptForTenantAuto.mockResolvedValue('sk-ant-test-key');
  mockResolveTenantPlaintextValue.mockImplementation(async (value: string | null | undefined) => {
    return value ?? null;
  });
}

// =============================================================================
// 1. Cache Behavior — TTL, invalidation, cross-user contamination
// =============================================================================

describe('ModelResolutionService cache behavior', () => {
  beforeEach(resetAllMocks);

  test('should return cached metadata on second resolve within TTL', async () => {
    const model = makeTenantModel();
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);

    const service = new ModelResolutionService(true, makeMockEncryption());

    // First resolve — hits DB
    const result1 = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });
    expect(mockFindDefaultTenantModelForTier).toHaveBeenCalledTimes(1);

    // Second resolve — should use cache with no additional model or credential DB reads
    const result2 = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    // Model metadata should be same
    expect(result2.modelId).toBe(result1.modelId);
    expect(result2.provider).toBe(result1.provider);
    expect(result2.source).toBe(result1.source);

    // findDefaultTenantModelForTier should NOT be called again (cached)
    expect(mockFindDefaultTenantModelForTier).toHaveBeenCalledTimes(1);
    expect(mockFindTenantModelByIdWithPrimaryConnection).not.toHaveBeenCalled();
  });

  test('should reuse cached user-scoped credential on second resolve within TTL', async () => {
    mockFindDefaultUserCredential.mockResolvedValue(makeCredential());

    const service = new ModelResolutionService(true, makeMockEncryption());

    await service.resolve({
      tenantId: 'tenant-1',
      userId: 'user-1',
      operationType: 'response_gen',
      agentIR: {
        execution: {
          model: 'claude-sonnet-4-20250514',
        },
      } as any,
    });

    await service.resolve({
      tenantId: 'tenant-1',
      userId: 'user-1',
      operationType: 'response_gen',
      agentIR: {
        execution: {
          model: 'claude-sonnet-4-20250514',
        },
      } as any,
    });

    expect(mockFindDefaultUserCredential).toHaveBeenCalledTimes(1);
  });

  test('should reuse cached tenant policy on cold and warm resolves within TTL', async () => {
    const model = makeTenantModel();
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);
    mockFindTenantLLMPolicy.mockResolvedValue({
      tenantId: 'tenant-1',
      allowedProviders: [],
      credentialPolicy: 'user_only',
      allowProjectCredentials: false,
      dailyTokenBudget: 0,
      monthlyTokenBudget: 0,
      maxRequestsPerMinute: 0,
      defaultModel: null,
      defaultFastModel: null,
      defaultVoiceModel: null,
    });

    const service = new ModelResolutionService(true, makeMockEncryption());

    await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    expect(mockFindTenantLLMPolicy).toHaveBeenCalledTimes(1);
  });

  test('should clear cache for specific tenant via clearCache(tenantId)', async () => {
    const model = makeTenantModel();
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);

    const service = new ModelResolutionService(true, makeMockEncryption());

    // First resolve
    await service.resolve({ tenantId: 'tenant-1', operationType: 'response_gen' });
    expect(mockFindDefaultTenantModelForTier).toHaveBeenCalledTimes(1);

    // Clear cache for tenant-1
    service.clearCache('tenant-1');

    // Next resolve should hit DB again
    await service.resolve({ tenantId: 'tenant-1', operationType: 'response_gen' });
    expect(mockFindDefaultTenantModelForTier).toHaveBeenCalledTimes(2);
  });

  test('should clear all cache entries via clearCache() without tenantId', async () => {
    const model = makeTenantModel();
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);

    const service = new ModelResolutionService(true, makeMockEncryption());

    await service.resolve({ tenantId: 'tenant-1', operationType: 'response_gen' });
    service.clearCache();

    await service.resolve({ tenantId: 'tenant-1', operationType: 'response_gen' });
    expect(mockFindDefaultTenantModelForTier).toHaveBeenCalledTimes(2);
  });

  test('cache key includes userId — different users get separate cache entries', async () => {
    const model = makeTenantModel();
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);
    // Needed for rehydrateCredential on cache hit
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(model);

    const service = new ModelResolutionService(true, makeMockEncryption());

    // User A resolves
    await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
      userId: 'user-A',
    });

    // User B resolves same tenant/operation — should be a separate cache entry
    await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
      userId: 'user-B',
    });

    // FIX: cache key now includes userId, so each user gets their own resolution
    expect(mockFindDefaultTenantModelForTier).toHaveBeenCalledTimes(2);
  });

  test('cache key includes settingsVersionId — pinned settings stay isolated', async () => {
    const model = makeTenantModel();
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);
    mockFindProjectEnableThinking.mockImplementation(
      async (_projectId: string, versionId?: string) =>
        versionId === 'sv-1'
          ? {
              enableThinking: true,
              thinkingBudget: 4000,
            }
          : {
              enableThinking: false,
              thinkingBudget: 1000,
            },
    );

    const service = new ModelResolutionService(true, makeMockEncryption());

    const result1 = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'agent-1',
      operationType: 'reasoning',
      settingsVersionId: 'sv-1',
    });

    const result2 = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'agent-1',
      operationType: 'reasoning',
      settingsVersionId: 'sv-2',
    });

    expect(result1.parameters.enableThinking).toBe(true);
    expect(result1.parameters.thinkingBudget).toBe(4000);
    expect(result2.parameters.enableThinking).toBe(false);
    expect(result2.parameters.thinkingBudget).toBe(1000);
    expect(mockFindDefaultTenantModelForTier).toHaveBeenCalledTimes(2);
  });

  test('resolveReasoningSettings skips user-scoped credential policy', async () => {
    mockFindTenantLLMPolicy.mockResolvedValue({
      tenantId: 'tenant-1',
      allowedProviders: [],
      credentialPolicy: 'user_only',
      allowProjectCredentials: false,
      dailyTokenBudget: 0,
      monthlyTokenBudget: 0,
      maxRequestsPerMinute: 60,
      defaultModel: null,
      defaultFastModel: null,
      defaultVoiceModel: null,
    });

    const service = new ModelResolutionService(true, makeMockEncryption());

    const settings = await service.resolveReasoningSettings({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'agent-1',
      settingsVersionId: 'sv-1',
      agentIR: {
        metadata: { name: 'agent-1', description: '' },
        execution: {
          mode: 'reasoning',
          model: 'anthropic/claude-sonnet-4',
          enable_thinking: true,
          thinking_budget: 4096,
          thought_description: 'think carefully',
          compaction_threshold: 40000,
        },
      } as any,
    });

    expect(settings.modelId).toBe('anthropic/claude-sonnet-4');
    expect(settings.parameters.enableThinking).toBe(true);
    expect(settings.parameters.thinkingBudget).toBe(4096);
    expect(settings.parameters.thoughtDescription).toBe('think carefully');
    expect(settings.parameters.compactionThreshold).toBe(40000);
    expect(mockFindDefaultUserCredential).not.toHaveBeenCalled();

    await expect(
      service.resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        agentName: 'agent-1',
        operationType: 'reasoning',
        userId: 'user-1',
        settingsVersionId: 'sv-1',
        agentIR: {
          metadata: { name: 'agent-1', description: '' },
          execution: {
            mode: 'reasoning',
            model: 'anthropic/claude-sonnet-4',
            enable_thinking: true,
          },
        } as any,
      }),
    ).rejects.toThrow(/No credential found/);

    expect(mockFindDefaultUserCredential).toHaveBeenCalledWith('user-1', 'anthropic');
  });

  test('cache key includes resolution-relevant Agent IR execution inputs', async () => {
    const credentialModel = makeTenantModel({
      id: 'tm-anthropic',
      modelId: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
    });
    mockFindTenantModelByProvider.mockResolvedValue(credentialModel);

    const service = new ModelResolutionService(true, makeMockEncryption());

    const result1 = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'agent-1',
      operationType: 'response_gen',
      agentIR: {
        metadata: { name: 'agent-1', description: '' },
        execution: { mode: 'reasoning', model: 'anthropic/cache-test-model-a' },
      } as any,
    });

    const result2 = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'agent-1',
      operationType: 'response_gen',
      agentIR: {
        metadata: { name: 'agent-1', description: '' },
        execution: { mode: 'reasoning', model: 'anthropic/cache-test-model-b' },
      } as any,
    });

    expect(result1.modelId).toBe('anthropic/cache-test-model-a');
    expect(result2.modelId).toBe('anthropic/cache-test-model-b');
  });

  test('cache key includes the full deployment override payload, not just model ID', async () => {
    const credentialModel = makeTenantModel({
      id: 'tm-openai',
      modelId: 'gpt-4o',
      provider: 'openai',
    });
    mockFindTenantModelByProvider.mockResolvedValue(credentialModel);

    const service = new ModelResolutionService(true, makeMockEncryption());

    const result1 = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'agent-1',
      operationType: 'response_gen',
      deploymentModelOverride: {
        model: 'openai/gpt-4o',
        temperature: 0.1,
        maxTokens: 1024,
      },
    });

    const result2 = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'agent-1',
      operationType: 'response_gen',
      deploymentModelOverride: {
        model: 'openai/gpt-4o',
        temperature: 0.9,
        maxTokens: 2048,
      },
    });

    expect(result1.parameters.temperature).toBe(0.1);
    expect(result1.parameters.maxTokens).toBe(1024);
    expect(result2.parameters.temperature).toBe(0.9);
    expect(result2.parameters.maxTokens).toBe(2048);
  });

  test('should not share cache between different tenants', async () => {
    const model1 = makeTenantModel({ tenantId: 'tenant-1', modelId: 'model-1' });
    const model2 = makeTenantModel({ tenantId: 'tenant-2', modelId: 'model-2' });

    mockFindDefaultTenantModelForTier.mockImplementation(async (tenantId: string) => {
      return tenantId === 'tenant-1' ? model1 : model2;
    });

    const service = new ModelResolutionService(true, makeMockEncryption());

    const result1 = await service.resolve({ tenantId: 'tenant-1', operationType: 'response_gen' });
    const result2 = await service.resolve({ tenantId: 'tenant-2', operationType: 'response_gen' });

    expect(result1.modelId).toBe('model-1');
    expect(result2.modelId).toBe('model-2');
    expect(mockFindDefaultTenantModelForTier).toHaveBeenCalledTimes(2);
  });

  test('should not share cache between different operation types', async () => {
    const balanced = makeTenantModel({ modelId: 'claude-sonnet-4-20250514', tier: 'balanced' });
    const fast = makeTenantModel({ modelId: 'claude-haiku-4-5-20251001', tier: 'fast' });

    mockFindProjectOperationTierOverrides.mockResolvedValue({
      response_gen: 'balanced',
      extraction: 'fast',
    });
    mockFindDefaultTenantModelForTier.mockImplementation(
      async (_tenantId: string, tier: string) => {
        return tier === 'balanced' ? balanced : tier === 'fast' ? fast : null;
      },
    );

    const service = new ModelResolutionService(true, makeMockEncryption());

    const result1 = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen', // balanced tier
    });
    const result2 = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'extraction', // fast tier
    });

    expect(result1.modelId).toBe('claude-sonnet-4-20250514');
    expect(result2.modelId).toBe('claude-haiku-4-5-20251001');
  });
});

// =============================================================================
// 2. tenantModelId Caching and Rehydration
// =============================================================================

describe('ModelResolutionService tenantModelId caching and rehydration', () => {
  beforeEach(resetAllMocks);

  test('rehydration uses cached tenantModelId for exact lookup instead of provider search', async () => {
    vi.useFakeTimers();

    try {
      // Setup: tenant has TWO models from the same provider (anthropic)
      const sonnet = makeTenantModel({
        id: 'tm-sonnet',
        _id: 'tm-sonnet',
        modelId: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        isDefault: true,
      });
      const haiku = makeTenantModel({
        id: 'tm-haiku',
        _id: 'tm-haiku',
        modelId: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        isDefault: false,
      });

      // First resolve: findDefaultTenantModelForTier returns sonnet
      mockFindDefaultTenantModelForTier.mockResolvedValue(sonnet);

      const encryption = makeMockEncryption();
      const service = new ModelResolutionService(true, encryption);

      const result1 = await service.resolve({
        tenantId: 'tenant-1',
        operationType: 'response_gen',
      });
      expect(result1.modelId).toBe('claude-sonnet-4-20250514');

      // Expire the short-lived credential cache while keeping metadata cache warm.
      await vi.advanceTimersByTimeAsync(6_000);

      // On rehydration: the service should use findTenantModelByIdWithPrimaryConnection
      // with the cached tenantModelId ('tm-sonnet'), NOT findTenantModelByProvider.
      mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(sonnet);
      // Even if provider search would return haiku, the ID-based lookup should be preferred
      mockFindTenantModelByProvider.mockResolvedValue(haiku);

      const result2 = await service.resolve({
        tenantId: 'tenant-1',
        operationType: 'response_gen',
      });

      expect(result2.modelId).toBe('claude-sonnet-4-20250514');
      // FIX: rehydration now uses exact ID lookup
      expect(mockFindTenantModelByIdWithPrimaryConnection).toHaveBeenCalledWith(
        'tm-sonnet',
        'tenant-1',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('rehydration should not re-resolve model — only credential', async () => {
    const model = makeTenantModel();
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);
    // Rehydration now uses ID-based lookup first
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(model);

    const service = new ModelResolutionService(true, makeMockEncryption());

    // First resolve
    const result1 = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    // Second resolve (cached) — should keep same model metadata
    const result2 = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    expect(result2.modelId).toBe(result1.modelId);
    expect(result2.provider).toBe(result1.provider);
    expect(result2.source).toBe(result1.source);
    expect(result2.parameters).toEqual(result1.parameters);
  });
});

// =============================================================================
// 3. displayName-as-modelId Fallback
// =============================================================================

describe('ModelResolutionService displayName fallback for modelId', () => {
  beforeEach(resetAllMocks);

  test('should use modelId when available', async () => {
    const model = makeTenantModel({ modelId: 'claude-sonnet-4-20250514' });
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('claude-sonnet-4-20250514');
  });

  test('uses displayName when modelId is null (easy integration) with warning', async () => {
    // For non-API models with null modelId, displayName is used as a fallback
    // but a warning is logged since displayNames are not valid provider model IDs
    const model = makeTenantModel({
      modelId: null,
      displayName: 'My Claude Model',
      integrationType: 'easy',
    });
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    // Falls back to displayName — a warning is logged for non-API integrations
    expect(result.modelId).toBe('My Claude Model');
  });

  test('displayName fallback is acceptable for API integration', async () => {
    // For API integrations, there is no standard model ID, so displayName is fine
    const model = makeTenantModel({
      modelId: null,
      displayName: 'Internal LLM',
      integrationType: 'api',
      providerStructure: 'openai',
    });
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('Internal LLM');
    expect(result.apiIntegration).toBeDefined();
  });

  test('displayName with spaces still triggers provider inference with warning', async () => {
    const model = makeTenantModel({
      modelId: null,
      displayName: 'GPT-4o Production',
      provider: null, // no explicit provider
      integrationType: 'easy',
    });
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    // "GPT-4o Production" starts with "gpt" so inferProviderFromModelId returns "openai"
    // A warning is logged for null modelId on non-API integration
    expect(result.modelId).toBe('GPT-4o Production');
    expect(result.provider).toBe('openai');
  });

  test('uses TenantModel.provider over inferred provider when available', async () => {
    const model = makeTenantModel({
      modelId: 'my-azure-deployment',
      provider: 'azure',
    });
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    // Provider should come from TenantModel.provider, not inferred from modelId
    expect(result.provider).toBe('azure');
  });
});

// =============================================================================
// 4. filterPrimaryConnection Fallback Behavior
// =============================================================================

describe('ModelResolutionService filterPrimaryConnection fallback', () => {
  beforeEach(resetAllMocks);

  test('should use primary active connection when available', async () => {
    // Use encryptedApiKey directly (not credentialId) so resolution doesn't depend on findCredentialById
    mockDecryptForTenantAuto.mockResolvedValue('key-from-primary');
    const model = makeTenantModel({
      connections: [
        {
          id: 'conn-1',
          encryptedApiKey: 'N0:AAAAAAAAAAAAAAAAAAAAAA==:BBBBBBBBBBBBBBBBBBBBBB==:AAAAAAAAAA==',
          authType: 'api_key',
          isActive: true,
          isPrimary: false,
        },
        {
          id: 'conn-2',
          encryptedApiKey: 'N0:AAAAAAAAAAAAAAAAAAAAAA==:BBBBBBBBBBBBBBBBBBBBBB==:BBBBBBBBBB==',
          authType: 'api_key',
          isActive: true,
          isPrimary: true,
        },
      ],
    });
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);

    const encryption = makeMockEncryption('key-from-primary');
    const service = new ModelResolutionService(true, encryption);
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    expect(result.credential).toBeDefined();
    expect(result.credential.apiKey).toBe('key-from-primary');
    // decryptForTenantAuto is called with the primary connection's encrypted key
    expect(mockDecryptForTenantAuto).toHaveBeenCalled();
  });

  test('should use repo-provided connection (repo pre-filters to active connections)', async () => {
    // The repo's filterPrimaryConnection selects the best connection before
    // returning to buildTenantModelResolution. The service uses connections[0].
    // This test verifies the service correctly processes a single non-primary
    // active connection (as the repo would provide when no primary exists).
    mockDecryptForTenantAuto.mockResolvedValue('fallback-key');
    const model = makeTenantModel({
      connections: [
        {
          id: 'conn-2',
          encryptedApiKey: 'N0:AAAAAAAAAAAAAAAAAAAAAA==:BBBBBBBBBBBBBBBBBBBBBB==:BBBBBBBBBB==',
          authType: 'api_key',
          isActive: true,
          isPrimary: false,
        },
      ],
    });
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);

    const encryption = makeMockEncryption('fallback-key');
    const service = new ModelResolutionService(true, encryption);
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    expect(result.credential).toBeDefined();
    expect(result.credential.apiKey).toBe('fallback-key');
  });

  test('should return null (fail resolution) when all connections are inactive', async () => {
    const model = makeTenantModel({
      connections: [
        {
          id: 'conn-1',
          credentialId: 'cred-1',
          encryptedApiKey: 'enc-1',
          authType: 'api_key',
          isActive: false,
          isPrimary: true,
        },
        {
          id: 'conn-2',
          credentialId: 'cred-2',
          encryptedApiKey: 'enc-2',
          authType: 'api_key',
          isActive: false,
          isPrimary: false,
        },
      ],
    });
    // The tier-specific model has all inactive connections
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);
    // No fallback model either
    mockFindAnyDefaultTenantModel.mockResolvedValue(null);

    const service = new ModelResolutionService(true, makeMockEncryption());

    await expect(
      service.resolve({ tenantId: 'tenant-1', operationType: 'response_gen' }),
    ).rejects.toMatchObject({
      code: ErrorCodes.MODEL_NOT_CONFIGURED.code,
      message:
        'AI model configuration is missing for this workspace. Ask your workspace administrator to configure a model and credentials.',
    });
  });

  test('should return null when connections array is empty', async () => {
    const model = makeTenantModel({ connections: [] });
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);
    mockFindAnyDefaultTenantModel.mockResolvedValue(null);

    const service = new ModelResolutionService(true, makeMockEncryption());

    await expect(
      service.resolve({ tenantId: 'tenant-1', operationType: 'response_gen' }),
    ).rejects.toMatchObject({
      code: ErrorCodes.MODEL_NOT_CONFIGURED.code,
      message:
        'AI model configuration is missing for this workspace. Ask your workspace administrator to configure a model and credentials.',
    });
  });
});

// =============================================================================
// 5. Level 0: Deployment Model Override
// =============================================================================

describe('ModelResolutionService Level 0: Deployment model override', () => {
  beforeEach(resetAllMocks);

  test('should use deployment model override when provided', async () => {
    // Even though a tenant model exists, the deployment override takes priority
    const tenantModel = makeTenantModel({ modelId: 'claude-sonnet-4-20250514' });
    mockFindDefaultTenantModelForTier.mockResolvedValue(tenantModel);
    mockFindTenantModelByProvider.mockResolvedValue(tenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
      deploymentModelOverride: { model: 'anthropic/claude-opus-4-20250514' },
    });

    expect(result.modelId).toBe('anthropic/claude-opus-4-20250514');
  });

  test('should use deployment temperature and maxTokens overrides', async () => {
    const tenantModel = makeTenantModel();
    mockFindDefaultTenantModelForTier.mockResolvedValue(tenantModel);
    mockFindTenantModelByProvider.mockResolvedValue(tenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
      deploymentModelOverride: {
        model: 'anthropic/claude-opus-4-20250514',
        temperature: 0.1,
        maxTokens: 2048,
      },
    });

    expect(result.parameters.temperature).toBe(0.1);
    expect(result.parameters.maxTokens).toBe(2048);
  });

  test('deployment override without model should not override model but should set params', async () => {
    const tenantModel = makeTenantModel({ modelId: 'claude-sonnet-4-20250514' });
    mockFindDefaultTenantModelForTier.mockResolvedValue(tenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
      deploymentModelOverride: { temperature: 0.2 },
    });

    // Model comes from tenant model (Level 4), not deployment override
    expect(result.modelId).toBe('claude-sonnet-4-20250514');
    expect(result.parameters.temperature).toBe(0.2);
  });
});

// =============================================================================
// 6. Level 2: Agent DB Resolution + findAgentModelConfigByDslName
// =============================================================================

describe('ModelResolutionService Level 2: Agent DB resolution', () => {
  beforeEach(resetAllMocks);

  test('should resolve from AgentModelConfig exact match', async () => {
    mockFindAgentModelConfig.mockResolvedValue({
      id: 'amc-1',
      projectId: 'proj-1',
      agentName: 'sales-agent',
      defaultModel: 'gpt-4o',
      operationModels: '{}',
      temperature: 0.5,
      maxTokens: 2048,
      hyperParameters: null,
    });
    // Agent defaultModel 'gpt-4o' links through ModelConfig to TenantModel
    mockFindModelConfigByModelId.mockResolvedValue({
      id: 'mc-1',
      projectId: 'proj-1',
      modelId: 'gpt-4o',
      tenantModelId: 'tm-gpt4o',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(
      makeTenantModel({
        id: 'tm-gpt4o',
        modelId: 'gpt-4o',
        provider: 'openai',
      }),
    );

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'sales-agent',
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('gpt-4o');
    expect(result.source).toBe('agent_db');
    expect(result.provider).toBe('openai');
  });

  test('should fall back to findAgentModelConfigByDslName when exact match fails', async () => {
    // Exact match fails
    mockFindAgentModelConfig.mockResolvedValue(null);
    // DSL name lookup succeeds
    mockFindAgentModelConfigByDslName.mockResolvedValue({
      id: 'amc-1',
      projectId: 'proj-1',
      agentName: 'supervisor',
      defaultModel: 'claude-sonnet-4-20250514',
      operationModels: '{}',
      temperature: null,
      maxTokens: null,
      hyperParameters: null,
    });
    mockFindModelConfigByModelId.mockResolvedValue({
      id: 'mc-1',
      projectId: 'proj-1',
      modelId: 'claude-sonnet-4-20250514',
      tenantModelId: 'tm-sonnet',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(
      makeTenantModel({ id: 'tm-sonnet', modelId: 'claude-sonnet-4-20250514' }),
    );

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'TravelDesk_Supervisor', // DSL name, not slug
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('claude-sonnet-4-20250514');
    expect(result.source).toBe('agent_db');
    expect(mockFindAgentModelConfigByDslName).toHaveBeenCalledWith(
      'proj-1',
      'TravelDesk_Supervisor',
      'tenant-1',
    );
  });

  test('should resolve operation-specific model from agent operationModels', async () => {
    mockFindAgentModelConfig.mockResolvedValue({
      id: 'amc-1',
      projectId: 'proj-1',
      agentName: 'sales-agent',
      defaultModel: 'claude-sonnet-4-20250514',
      operationModels: JSON.stringify({
        extraction: 'claude-haiku-4-5-20251001',
      }),
      temperature: null,
      maxTokens: null,
      hyperParameters: null,
    });
    mockFindModelConfigByModelId.mockResolvedValue({
      id: 'mc-1',
      projectId: 'proj-1',
      modelId: 'claude-haiku-4-5-20251001',
      tenantModelId: 'tm-haiku',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(
      makeTenantModel({
        id: 'tm-haiku',
        modelId: 'claude-haiku-4-5-20251001',
        tier: 'fast',
      }),
    );

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'sales-agent',
      operationType: 'extraction',
    });

    expect(result.modelId).toBe('claude-haiku-4-5-20251001');
    expect(result.source).toBe('agent_db');
  });

  test('should use agent defaultModel when no operation-specific model', async () => {
    mockFindAgentModelConfig.mockResolvedValue({
      id: 'amc-1',
      projectId: 'proj-1',
      agentName: 'sales-agent',
      defaultModel: 'gpt-4o',
      operationModels: '{}',
      temperature: null,
      maxTokens: null,
      hyperParameters: null,
    });
    mockFindModelConfigByModelId.mockResolvedValue({
      id: 'mc-1',
      projectId: 'proj-1',
      modelId: 'gpt-4o',
      tenantModelId: 'tm-gpt4o',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(
      makeTenantModel({ id: 'tm-gpt4o', modelId: 'gpt-4o', provider: 'openai' }),
    );

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'sales-agent',
      operationType: 'summarization', // no specific mapping
    });

    expect(result.modelId).toBe('gpt-4o');
    expect(result.source).toBe('agent_db');
  });

  test('should not execute legacy agent model IDs without a project ModelConfig', async () => {
    mockFindAgentModelConfig.mockResolvedValue({
      id: 'amc-legacy',
      projectId: 'proj-1',
      agentName: 'sales-agent',
      defaultModel: 'unapproved-literal-model',
      operationModels: '{}',
      temperature: null,
      maxTokens: null,
      hyperParameters: null,
    });
    mockFindModelConfigByModelId.mockResolvedValue(null);
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-balanced',
      projectId: 'proj-1',
      modelId: 'gpt-4o-mini',
      tenantModelId: 'tm-balanced',
      tier: 'balanced',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(
      makeTenantModel({
        id: 'tm-balanced',
        modelId: 'gpt-4o-mini',
        provider: 'openai',
        tier: 'balanced',
      }),
    );

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'sales-agent',
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('gpt-4o-mini');
    expect(result.source).toBe('project_db');
  });

  test('should extract hyperParameters (enableThinking, thinkingBudget) from agent config', async () => {
    mockFindAgentModelConfig.mockResolvedValue({
      id: 'amc-1',
      projectId: 'proj-1',
      agentName: 'deep-thinker',
      defaultModel: 'claude-sonnet-4-20250514',
      operationModels: '{}',
      temperature: null,
      maxTokens: null,
      hyperParameters: JSON.stringify({
        enableThinking: true,
        thinkingBudget: 8000,
        thoughtDescription: 'Think step by step',
      }),
    });
    mockFindModelConfigByModelId.mockResolvedValue({
      id: 'mc-1',
      projectId: 'proj-1',
      modelId: 'claude-sonnet-4-20250514',
      tenantModelId: 'tm-sonnet',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(makeTenantModel());

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'deep-thinker',
      operationType: 'response_gen',
    });

    expect(result.parameters.enableThinking).toBe(true);
    expect(result.parameters.thinkingBudget).toBe(8000);
    expect(result.parameters.thoughtDescription).toBe('Think step by step');
  });

  test('should continue to Level 3 when agent DB resolution fails', async () => {
    // Agent config lookup throws
    mockFindAgentModelConfig.mockRejectedValue(new Error('DB timeout'));
    mockFindAgentModelConfigByDslName.mockResolvedValue(null);

    // Level 3: default project model config
    const model = makeTenantModel();
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-1',
      projectId: 'proj-1',
      modelId: 'claude-sonnet-4-20250514',
      tenantModelId: 'tm-1',
      tier: 'balanced',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(model);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'broken-agent',
      operationType: 'response_gen',
    });

    // Should have fallen through to Level 3
    expect(result.source).toBe('project_db');
  });
});

// =============================================================================
// 7. Level 3: Project DB Resolution
// =============================================================================

describe('ModelResolutionService Level 3: Project DB resolution', () => {
  beforeEach(resetAllMocks);

  test('should resolve tier-specific project model config when operation routing is enabled', async () => {
    mockFindProjectOperationTierOverrides.mockResolvedValue({
      response_gen: 'balanced',
    });
    const tenantModel = makeTenantModel({ id: 'tm-1', modelId: 'claude-sonnet-4-20250514' });
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-1',
      projectId: 'proj-1',
      modelId: 'claude-sonnet-4-20250514',
      tenantModelId: 'tm-1',
      tier: 'balanced',
      temperature: 0.6,
      maxTokens: 3000,
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('claude-sonnet-4-20250514');
    expect(result.source).toBe('project_db');
    expect(result.parameters.temperature).toBe(0.6);
    expect(result.parameters.maxTokens).toBe(3000);
    expect(mockFindModelConfigForTier).toHaveBeenCalledWith('proj-1', 'balanced', 'tenant-1');
  });

  test('dynamic project hyperParameters suppress legacy sampling defaults when keys are absent', async () => {
    const tenantModel = makeTenantModel({ id: 'tm-1', modelId: 'claude-opus-4-7' });
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-1',
      projectId: 'proj-1',
      modelId: 'claude-opus-4-7',
      tenantModelId: 'tm-1',
      tier: 'powerful',
      temperature: 0.6,
      maxTokens: 3000,
      topP: 0.9,
      frequencyPenalty: 0.2,
      presencePenalty: 0.3,
      hyperParameters: { compactionThreshold: 0.75 },
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });

    expect(result.parameters.compactionThreshold).toBe(0.75);
    expect(result.parameters.temperature).toBeUndefined();
    expect(result.parameters.maxTokens).toBe(3000);
    expect(result.parameters.topP).toBeUndefined();
    expect(result.parameters.frequencyPenalty).toBeUndefined();
    expect(result.parameters.presencePenalty).toBeUndefined();
  });

  test('should fall back to any project model when enabled tier routing misses', async () => {
    mockFindProjectOperationTierOverrides.mockResolvedValue({
      response_gen: 'balanced',
    });
    // No tier-specific model
    mockFindModelConfigForTier.mockResolvedValue(null);

    const tenantModel = makeTenantModel({ id: 'tm-1', modelId: 'gpt-4o', provider: 'openai' });
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-1',
      projectId: 'proj-1',
      modelId: 'gpt-4o',
      tenantModelId: 'tm-1',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('gpt-4o');
    expect(result.source).toBe('project_db');
    expect(mockFindModelConfigForTier).toHaveBeenCalledWith('proj-1', 'balanced', 'tenant-1');
    expect(mockFindAnyModelConfig).toHaveBeenCalledWith('proj-1', 'tenant-1');
  });

  test('should use project model without tenantModelId (bare model ID)', async () => {
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-1',
      projectId: 'proj-1',
      modelId: 'anthropic/claude-3-sonnet',
      tenantModelId: null, // no linked TenantModel
      tier: 'balanced',
    });

    // Credential resolution: tenant has a credential for anthropic
    mockFindDefaultTenantCredential.mockResolvedValue(makeCredential({ provider: 'anthropic' }));
    mockFindTenantLLMPolicy.mockResolvedValue({
      tenantId: 'tenant-1',
      credentialPolicy: 'org_only',
      allowedProviders: [],
    });

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('anthropic/claude-3-sonnet');
    expect(result.source).toBe('project_db');
    expect(result.provider).toBe('anthropic');
  });

  test('should resolve linked TenantModel for project model', async () => {
    mockFindProjectOperationTierOverrides.mockResolvedValue({
      reasoning: 'powerful',
    });
    const tenantModel = makeTenantModel({
      id: 'tm-linked',
      modelId: 'claude-opus-4-20250514',
      provider: 'anthropic',
    });
    mockFindModelConfigForTier.mockResolvedValue({
      id: 'mc-1',
      projectId: 'proj-1',
      modelId: 'claude-opus-4-20250514',
      tenantModelId: 'tm-linked',
      tier: 'powerful',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'reasoning', // maps to 'powerful' tier
    });

    expect(result.modelId).toBe('claude-opus-4-20250514');
    expect(result.source).toBe('project_db');
    expect(mockFindModelConfigForTier).toHaveBeenCalledWith('proj-1', 'powerful', 'tenant-1');
    expect(mockFindTenantModelByIdWithPrimaryConnection).toHaveBeenCalledWith(
      'tm-linked',
      'tenant-1',
    );
  });

  test('should fail closed when an explicit project tenantModelId cannot resolve', async () => {
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-broken-binding',
      projectId: 'proj-1',
      modelId: 'gpt-4o',
      provider: 'openai',
      tenantModelId: 'tm-missing',
      tier: 'balanced',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(null);
    mockFindDefaultTenantCredential.mockResolvedValue(makeCredential({ provider: 'openai' }));
    mockFindTenantLLMPolicy.mockResolvedValue({
      tenantId: 'tenant-1',
      credentialPolicy: 'org_only',
      allowedProviders: [],
    });

    const service = new ModelResolutionService(true, makeMockEncryption());

    await expect(
      service.resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        operationType: 'response_gen',
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.MODEL_NOT_CONFIGURED.code,
    });
  });

  test('should propagate project model execution parameters, capabilities, and pricing', async () => {
    const tenantModel = makeTenantModel({
      id: 'tm-linked',
      modelId: 'gpt-4o',
      provider: 'openai',
      supportsStreaming: true,
      supportsVision: false,
      supportsTools: true,
      useStreaming: null,
    });
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-runtime-params',
      projectId: 'proj-1',
      modelId: 'gpt-4o',
      tenantModelId: 'tm-linked',
      tier: 'balanced',
      temperature: 0.31,
      maxTokens: 1234,
      topP: 0.42,
      frequencyPenalty: -0.2,
      presencePenalty: 0.6,
      hyperParameters: {
        temperature: 0.31,
        maxTokens: 1234,
        topP: 0.42,
        frequencyPenalty: -0.2,
        presencePenalty: 0.6,
        topK: 33,
        seed: '42',
        stop: 'END,STOP',
        reasoning_effort: 'high',
      },
      contextWindow: 32768,
      inputCostPer1k: 0.012,
      outputCostPer1k: 0.034,
      supportsTools: false,
      supportsVision: true,
      supportsStreaming: false,
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });

    expect(result.parameters).toEqual(
      expect.objectContaining({
        temperature: 0.31,
        maxTokens: 1234,
        topP: 0.42,
        frequencyPenalty: -0.2,
        presencePenalty: 0.6,
        contextWindow: 32768,
      }),
    );
    expect(result.parameters.topK).toBeUndefined();
    expect(result.parameters.seed).toBeUndefined();
    expect(result.parameters.stopSequences).toBeUndefined();
    expect(result.parameters.reasoningEffort).toBeUndefined();
    expect(result.capabilities).toEqual(
      expect.objectContaining({
        supportsTools: false,
        supportsVision: true,
        supportsStreaming: false,
        contextWindow: 32768,
      }),
    );
    expect(result.pricing).toEqual({ inputCostPer1k: 0.012, outputCostPer1k: 0.034 });
    expect(result.useStreaming).toBe(false);
  });

  test('should strip project sampling parameters not supported by the resolved model', async () => {
    const tenantModel = makeTenantModel({
      id: 'tm-opus',
      modelId: 'claude-opus-4-7',
      provider: 'anthropic',
    });
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-opus',
      projectId: 'proj-1',
      modelId: 'claude-opus-4-7',
      tenantModelId: 'tm-opus',
      tier: 'powerful',
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 4096,
      hyperParameters: {
        topK: 40,
      },
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'reasoning',
    });

    expect(result.modelId).toBe('claude-opus-4-7');
    expect(result.parameters.temperature).toBeUndefined();
    expect(result.parameters.topP).toBeUndefined();
    expect(result.parameters.topK).toBeUndefined();
    expect(result.parameters.maxTokens).toBe(4096);
  });

  test('should strip reasoning and thinking parameters not supported by the resolved model', async () => {
    const tenantModel = makeTenantModel({
      id: 'tm-gpt4o',
      modelId: 'gpt-4o',
      provider: 'openai',
    });
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-gpt4o',
      projectId: 'proj-1',
      modelId: 'gpt-4o',
      tenantModelId: 'tm-gpt4o',
      tier: 'balanced',
      maxTokens: 4096,
      hyperParameters: {
        reasoningEffort: 'high',
        enableThinking: true,
        thinkingBudget: 4096,
        thinkingLevel: 'high',
        thoughtDescription: 'show working',
      },
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('gpt-4o');
    expect(result.parameters.reasoningEffort).toBeUndefined();
    expect(result.parameters.enableThinking).toBeUndefined();
    expect(result.parameters.thinkingBudget).toBeUndefined();
    expect(result.parameters.thinkingLevel).toBeUndefined();
    expect(result.parameters.thoughtDescription).toBe('show working');
    expect(result.parameters.maxTokens).toBe(4096);
  });

  test('should strip provider-unsupported parameters for unregistered custom model metadata', async () => {
    const tenantModel = makeTenantModel({
      id: 'tm-custom-anthropic',
      modelId: 'custom-anthropic/future-text-model',
      provider: 'anthropic',
    });
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-custom-anthropic',
      projectId: 'proj-1',
      modelId: 'custom-anthropic/future-text-model',
      tenantModelId: 'tm-custom-anthropic',
      tier: 'balanced',
      maxTokens: 4096,
      hyperParameters: {
        temperature: 0.4,
        topP: 0.8,
        topK: 40,
        frequencyPenalty: 0.3,
        presencePenalty: 0.2,
        seed: 1234,
        stop: 'END',
      },
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('custom-anthropic/future-text-model');
    expect(result.parameters).toEqual(
      expect.objectContaining({
        temperature: 0.4,
        maxTokens: 4096,
        topP: 0.8,
        topK: 40,
        stopSequences: ['END'],
      }),
    );
    expect(result.parameters.frequencyPenalty).toBeUndefined();
    expect(result.parameters.presencePenalty).toBeUndefined();
    expect(result.parameters.seed).toBeUndefined();
  });

  test('should strip dynamic hyperparameters for unregistered providers with unknown support', async () => {
    const tenantModel = makeTenantModel({
      id: 'tm-unknown-provider',
      modelId: 'unregistered-provider/future-chat-model',
      provider: 'unregistered-provider',
    });
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-unknown-provider',
      projectId: 'proj-1',
      modelId: 'unregistered-provider/future-chat-model',
      tenantModelId: 'tm-unknown-provider',
      tier: 'balanced',
      maxTokens: 2048,
      hyperParameters: {
        temperature: 0.4,
        topP: 0.8,
        frequencyPenalty: 0.3,
        presencePenalty: 0.2,
        seed: 1234,
      },
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('unregistered-provider/future-chat-model');
    expect(result.parameters.maxTokens).toBe(2048);
    expect(result.parameters.temperature).toBeUndefined();
    expect(result.parameters.topP).toBeUndefined();
    expect(result.parameters.frequencyPenalty).toBeUndefined();
    expect(result.parameters.presencePenalty).toBeUndefined();
    expect(result.parameters.seed).toBeUndefined();
  });

  test('should use project auth profile override instead of linked TenantModel credentials', async () => {
    const tenantModel = makeTenantModel({
      id: 'tm-linked',
      modelId: 'gpt-4o',
      provider: 'openai',
    });
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-project-auth',
      projectId: 'proj-1',
      modelId: 'gpt-4o',
      tenantModelId: 'tm-linked',
      tier: 'balanced',
      authProfileId: 'profile-project-auth',
      credentialId: null,
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);
    mockAuthProfileFindOne.mockResolvedValue({
      _id: 'profile-project-auth',
      tenantId: 'tenant-1',
      status: 'active',
      authType: 'api_key',
      encryptedSecrets: JSON.stringify({ apiKey: 'project-profile-key' }),
      config: { endpoint: 'https://project-profile.example.test' },
    });

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('gpt-4o');
    expect(result.credential.apiKey).toBe('project-profile-key');
    expect(result.credential.endpoint).toBe('https://project-profile.example.test');
    expect(mockFindCredentialById).not.toHaveBeenCalled();
  });

  test('should use project legacy credential override instead of linked TenantModel credentials', async () => {
    const tenantModel = makeTenantModel({
      id: 'tm-linked',
      modelId: 'gpt-4o',
      provider: 'openai',
    });
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-project-credential',
      projectId: 'proj-1',
      modelId: 'gpt-4o',
      tenantModelId: 'tm-linked',
      tier: 'balanced',
      authProfileId: null,
      credentialId: 'cred-project',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);
    mockFindCredentialById.mockResolvedValue(
      makeCredential({
        _id: 'cred-project',
        encryptedApiKey: 'project-credential-key',
        encryptedEndpoint: 'https://project-credential.example.test',
      }),
    );

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('gpt-4o');
    expect(result.credential.apiKey).toBe('project-credential-key');
    expect(result.credential.endpoint).toBe('https://project-credential.example.test');
    expect(mockFindCredentialById).toHaveBeenCalledWith('cred-project', 'tenant-1');
  });

  test('should rehydrate cached project auth profile override credentials', async () => {
    const tenantModel = makeTenantModel({
      id: 'tm-linked',
      modelId: 'gpt-4o',
      provider: 'openai',
    });
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-project-auth',
      projectId: 'proj-1',
      modelId: 'gpt-4o',
      tenantModelId: 'tm-linked',
      tier: 'balanced',
      authProfileId: 'profile-project-cache',
      credentialId: null,
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);
    mockAuthProfileFindOne
      .mockResolvedValueOnce({
        _id: 'profile-project-cache',
        tenantId: 'tenant-1',
        status: 'active',
        authType: 'api_key',
        encryptedSecrets: JSON.stringify({ apiKey: 'project-profile-key-1' }),
        config: { endpoint: 'https://project-profile.example.test' },
        updatedAt: new Date('2026-05-02T00:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        _id: 'profile-project-cache',
        tenantId: 'tenant-1',
        status: 'active',
        authType: 'api_key',
        encryptedSecrets: JSON.stringify({ apiKey: 'project-profile-key-2' }),
        config: { endpoint: 'https://project-profile.example.test' },
        updatedAt: new Date('2026-05-02T00:01:00.000Z'),
      });

    const service = new ModelResolutionService(true, makeMockEncryption());
    const first = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });
    expect(first.credential.apiKey).toBe('project-profile-key-1');

    (service as unknown as { credentialCache: Map<string, unknown> }).credentialCache.clear();

    const second = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });

    expect(second.credential.apiKey).toBe('project-profile-key-2');
    expect(mockFindAnyModelConfig).toHaveBeenCalledTimes(1);
    expect(mockAuthProfileFindOne).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// 8. Multi-User Credential Policy Resolution
// =============================================================================

describe('ModelResolutionService credential policy', () => {
  beforeEach(resetAllMocks);

  test('user_only: should resolve only user credential', async () => {
    mockFindTenantLLMPolicy.mockResolvedValue({
      tenantId: 'tenant-1',
      credentialPolicy: 'user_only',
      allowedProviders: [],
    });
    mockFindDefaultUserCredential.mockResolvedValue(
      makeCredential({ _id: 'user-cred-1', ownerId: 'user-1', credentialScope: 'user' }),
    );

    // Model comes from agent IR (Level 1) — no TenantModel in chain
    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
      userId: 'user-1',
      agentIR: {
        metadata: { name: 'test', description: '' },
        execution: { mode: 'reasoning', model: 'anthropic/claude-3-sonnet' },
      } as any,
    });

    expect(result.credential.apiKey).toBeDefined();
    expect(mockFindDefaultUserCredential).toHaveBeenCalledWith('user-1', 'anthropic');
    // Should NOT try tenant credential for user_only policy
    expect(mockFindDefaultTenantCredential).not.toHaveBeenCalled();
  });

  test('org_only: should resolve only tenant credential', async () => {
    mockFindTenantLLMPolicy.mockResolvedValue({
      tenantId: 'tenant-1',
      credentialPolicy: 'org_only',
      allowedProviders: [],
    });
    mockFindDefaultTenantCredential.mockResolvedValue(
      makeCredential({ _id: 'tenant-cred-1', ownerId: 'tenant-1', credentialScope: 'tenant' }),
    );

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
      userId: 'user-1',
      agentIR: {
        metadata: { name: 'test', description: '' },
        execution: { mode: 'reasoning', model: 'anthropic/claude-3-sonnet' },
      } as any,
    });

    expect(result.credential.apiKey).toBeDefined();
    expect(mockFindDefaultTenantCredential).toHaveBeenCalledWith('tenant-1', 'anthropic');
    // Should NOT try user credential for org_only policy
    expect(mockFindDefaultUserCredential).not.toHaveBeenCalled();
  });

  test('user_first: should try user, then fall back to tenant', async () => {
    mockFindTenantLLMPolicy.mockResolvedValue({
      tenantId: 'tenant-1',
      credentialPolicy: 'user_first',
      allowedProviders: [],
    });
    // User credential not found
    mockFindDefaultUserCredential.mockResolvedValue(null);
    // Tenant credential found
    mockFindDefaultTenantCredential.mockResolvedValue(makeCredential({ _id: 'tenant-cred-1' }));

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
      userId: 'user-1',
      agentIR: {
        metadata: { name: 'test', description: '' },
        execution: { mode: 'reasoning', model: 'anthropic/claude-3-sonnet' },
      } as any,
    });

    expect(result.credential.apiKey).toBeDefined();
    // Should try user first, then tenant
    expect(mockFindDefaultUserCredential).toHaveBeenCalledWith('user-1', 'anthropic');
    expect(mockFindDefaultTenantCredential).toHaveBeenCalledWith('tenant-1', 'anthropic');
  });

  test('org_first: should try tenant, then fall back to user', async () => {
    mockFindTenantLLMPolicy.mockResolvedValue({
      tenantId: 'tenant-1',
      credentialPolicy: 'org_first',
      allowedProviders: [],
    });
    // Tenant credential not found
    mockFindDefaultTenantCredential.mockResolvedValue(null);
    // User credential found
    mockFindDefaultUserCredential.mockResolvedValue(makeCredential({ _id: 'user-cred-1' }));

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
      userId: 'user-1',
      agentIR: {
        metadata: { name: 'test', description: '' },
        execution: { mode: 'reasoning', model: 'anthropic/claude-3-sonnet' },
      } as any,
    });

    expect(result.credential.apiKey).toBeDefined();
    // Should try tenant first, then user
    expect(mockFindDefaultTenantCredential).toHaveBeenCalledWith('tenant-1', 'anthropic');
    expect(mockFindDefaultUserCredential).toHaveBeenCalledWith('user-1', 'anthropic');
  });

  test('user_first: falls back to tenant credential when user credential cannot be decrypted', async () => {
    mockFindTenantLLMPolicy.mockResolvedValue({
      tenantId: 'tenant-1',
      credentialPolicy: 'user_first',
      allowedProviders: [],
    });
    mockFindDefaultUserCredential.mockResolvedValue(
      makeCredential({
        _id: 'user-cred-1',
        ownerId: 'user-1',
        credentialScope: 'user',
        encryptedApiKey: 'N0:AAAA:BBBB:CCCC',
        _decryptionFailed: true,
      }),
    );
    mockFindDefaultTenantCredential.mockResolvedValue(
      makeCredential({
        _id: 'tenant-cred-1',
        ownerId: 'tenant-1',
        credentialScope: 'tenant',
        encryptedApiKey: 'tenant-plain-key',
      }),
    );
    mockResolveTenantPlaintextValue
      .mockRejectedValueOnce(new Error('bad ciphertext'))
      .mockResolvedValueOnce('tenant-plain-key')
      .mockResolvedValueOnce(null);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
      userId: 'user-1',
      agentIR: {
        metadata: { name: 'test', description: '' },
        execution: { mode: 'reasoning', model: 'anthropic/claude-3-sonnet' },
      } as any,
    });

    expect(result.credential.apiKey).toBe('tenant-plain-key');
    expect(mockFindDefaultUserCredential).toHaveBeenCalledWith('user-1', 'anthropic');
    expect(mockFindDefaultTenantCredential).toHaveBeenCalledWith('tenant-1', 'anthropic');
  });

  test('should fall back to TenantModel-by-provider when no standalone credentials', async () => {
    mockFindTenantLLMPolicy.mockResolvedValue({
      tenantId: 'tenant-1',
      credentialPolicy: 'user_only',
      allowedProviders: [],
    });
    // No user credential
    mockFindDefaultUserCredential.mockResolvedValue(null);
    // But a TenantModel exists with an active connection for this provider
    const tmByProvider = makeTenantModel({ id: 'tm-fallback', provider: 'anthropic' });
    mockFindTenantModelByProvider.mockResolvedValue(tmByProvider);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
      userId: 'user-1',
      agentIR: {
        metadata: { name: 'test', description: '' },
        execution: { mode: 'reasoning', model: 'anthropic/claude-3-sonnet' },
      } as any,
    });

    expect(result.credential.apiKey).toBeDefined();
    expect(mockFindTenantModelByProvider).toHaveBeenCalledWith('tenant-1', 'anthropic');
  });

  test('should throw when all credential paths exhausted', async () => {
    mockFindTenantLLMPolicy.mockResolvedValue({
      tenantId: 'tenant-1',
      credentialPolicy: 'user_only',
      allowedProviders: [],
    });
    mockFindDefaultUserCredential.mockResolvedValue(null);
    mockFindTenantModelByProvider.mockResolvedValue(null);

    const service = new ModelResolutionService(true, makeMockEncryption());

    await expect(
      service.resolve({
        tenantId: 'tenant-1',
        operationType: 'response_gen',
        userId: 'user-1',
        agentIR: {
          metadata: { name: 'test', description: '' },
          execution: { mode: 'reasoning', model: 'anthropic/claude-3-sonnet' },
        } as any,
      }),
    ).rejects.toThrow(/No credential found/);
  });
});

// =============================================================================
// 9. Auth Profile Dual-Read Integration
// =============================================================================

describe('ModelResolutionService auth profile dual-read', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  test('should resolve credential via auth profile when authProfileId exists', async () => {
    const model = makeTenantModel({
      connections: [
        {
          id: 'conn-1',
          credentialId: 'cred-1',
          authProfileId: 'profile-1',
          encryptedApiKey: null,
          authType: 'api_key',
          isActive: true,
          isPrimary: true,
        },
      ],
    });
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);

    // Auth profile returns credential
    mockAuthProfileFindOne.mockResolvedValue({
      _id: 'profile-1',
      tenantId: 'tenant-1',
      status: 'active',
      authType: 'api_key',
      encryptedSecrets: JSON.stringify({ apiKey: 'profile-api-key' }),
      config: { endpoint: 'https://api.anthropic.com' },
    });

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    expect(result.credential.apiKey).toBe('profile-api-key');
    expect(result.credential.endpoint).toBe('https://api.anthropic.com');
    // Should NOT fall through to legacy credential lookup
    expect(mockFindCredentialById).not.toHaveBeenCalled();
  });

  test('should throw "No model configured" when auth profile resolution fails (error caught by tier resolution)', async () => {
    const model = makeTenantModel({
      connections: [
        {
          id: 'conn-1',
          credentialId: 'cred-1',
          authProfileId: 'profile-broken',
          encryptedApiKey: null,
          authType: 'api_key',
          isActive: true,
          isPrimary: true,
        },
      ],
    });
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);

    // Auth profile fails — buildTenantModelResolution throws, caught by resolveTenantModelDefault
    mockAuthProfileFindOne.mockRejectedValue(new Error('Profile service unavailable'));

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

    // Legacy credential NOT consulted since auth profile error caused tier resolution to return null
    expect(mockFindCredentialById).not.toHaveBeenCalled();
  });

  test('should throw "No model configured" when auth profile returns no API key (no fallback to legacy)', async () => {
    const model = makeTenantModel({
      connections: [
        {
          id: 'conn-1',
          credentialId: 'cred-1',
          authProfileId: 'profile-empty',
          encryptedApiKey: null,
          authType: 'api_key',
          isActive: true,
          isPrimary: true,
        },
      ],
    });
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);

    mockAuthProfileFindOne.mockResolvedValue({
      _id: 'profile-empty',
      tenantId: 'tenant-1',
      status: 'active',
      encryptedSecrets: JSON.stringify({}), // no apiKey
      config: {},
    });

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

    // Legacy credential NOT consulted since auth profile null caused tier resolution to return null
    expect(mockFindCredentialById).not.toHaveBeenCalled();
  });

  test('should use legacy credentials when authProfileId is absent', async () => {
    // With encryptedApiKey directly — no credentialId path needed
    const model = makeTenantModel();
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    expect(result.credential).toBeDefined();
    // No authProfileId means the legacy credential path stays in use.
    expect(mockAuthProfileFindOne).not.toHaveBeenCalled();
  });

  test('should fail when both auth profile AND legacy credential fail', async () => {
    const model = makeTenantModel({
      connections: [
        {
          id: 'conn-1',
          credentialId: 'cred-missing',
          authProfileId: 'profile-broken',
          encryptedApiKey: null,
          authType: 'api_key',
          isActive: true,
          isPrimary: true,
        },
      ],
    });
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);
    mockFindAnyDefaultTenantModel.mockResolvedValue(null);

    // Auth profile fails
    mockAuthProfileFindOne.mockRejectedValue(new Error('Profile service down'));
    // Legacy credential also missing
    mockFindCredentialById.mockResolvedValue(null);

    const service = new ModelResolutionService(true, makeMockEncryption());

    await expect(
      service.resolve({ tenantId: 'tenant-1', operationType: 'response_gen' }),
    ).rejects.toMatchObject({
      code: ErrorCodes.MODEL_NOT_CONFIGURED.code,
      message:
        'AI model configuration is missing for this workspace. Ask your workspace administrator to configure a model and credentials.',
    });
  });
});

// =============================================================================
// 10. TenantModel HyperParameters
// =============================================================================

describe('ModelResolutionService TenantModel hyperParameters', () => {
  beforeEach(resetAllMocks);

  test('should apply tenant model hyperParameters at tenant-default resolution', async () => {
    mockFindDefaultTenantModelForTier.mockResolvedValue(
      makeTenantModel({
        hyperParameters: {
          thinking: { enabled: true },
          reasoningConfig: { budgetTokens: '4096' },
          top_k: '33',
          seed: '42',
          stop: 'END,STOP',
          reasoning_effort: 'high',
        },
      }),
    );

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    expect(result.source).toBe('tenant_model');
    expect(result.parameters).toEqual(
      expect.objectContaining({
        enableThinking: true,
        thinkingBudget: 4096,
        topK: 33,
      }),
    );
    expect(result.parameters.seed).toBeUndefined();
    expect(result.parameters.stopSequences).toBeUndefined();
    expect(result.parameters.reasoningEffort).toBeUndefined();
  });

  test('dynamic tenant hyperParameters suppress legacy sampling defaults when keys are absent', async () => {
    mockFindDefaultTenantModelForTier.mockResolvedValue(
      makeTenantModel({
        modelId: 'custom-provider/no-registry-metadata',
        provider: 'custom',
        temperature: 0.9,
        maxTokens: 1234,
        hyperParameters: { compactionThreshold: 0.65 },
      }),
    );

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    expect(result.parameters.compactionThreshold).toBe(0.65);
    expect(result.parameters.temperature).toBeUndefined();
    expect(result.parameters.maxTokens).toBe(1234);
  });
});

// =============================================================================
// 11. Project-Level enableThinking and Tier Overrides
// =============================================================================

describe('ModelResolutionService project settings', () => {
  beforeEach(resetAllMocks);

  test('should apply project-level enableThinking when agent does not set it', async () => {
    // Use a tenant model at Level 4 for resolution
    const model = makeTenantModel();
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);
    mockFindProjectEnableThinking.mockResolvedValue({
      enableThinking: true,
      thinkingBudget: 10000,
      thoughtDescription: 'Project-level thinking',
      compactionThreshold: 50000,
    });

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });

    expect(result.parameters.enableThinking).toBe(true);
    expect(result.parameters.thinkingBudget).toBe(10000);
    expect(result.parameters.thoughtDescription).toBe('Project-level thinking');
    expect(result.parameters.compactionThreshold).toBe(50000);
  });

  test('agent-level thinking settings should override project-level', async () => {
    const tenantModel = makeTenantModel();
    mockFindAgentModelConfig.mockResolvedValue({
      id: 'amc-1',
      projectId: 'proj-1',
      agentName: 'thinker',
      defaultModel: 'claude-sonnet-4-20250514',
      operationModels: '{}',
      temperature: null,
      maxTokens: null,
      hyperParameters: JSON.stringify({
        enableThinking: false, // agent disables thinking
      }),
    });
    mockFindModelConfigByModelId.mockResolvedValue({
      id: 'mc-1',
      projectId: 'proj-1',
      modelId: 'claude-sonnet-4-20250514',
      tenantModelId: 'tm-1',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);
    mockFindProjectEnableThinking.mockResolvedValue({
      enableThinking: true, // project enables thinking
      thinkingBudget: 10000,
    });

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'thinker',
      operationType: 'response_gen',
    });

    // Agent-level should win
    expect(result.parameters.enableThinking).toBe(false);
  });

  test('should use project operation-to-tier overrides', async () => {
    // Project overrides: map response_gen to 'powerful' instead of default 'balanced'
    mockFindProjectOperationTierOverrides.mockResolvedValue({
      response_gen: 'powerful',
    });

    const powerful = makeTenantModel({
      id: 'tm-opus',
      modelId: 'claude-opus-4-20250514',
      tier: 'powerful',
    });
    mockFindDefaultTenantModelForTier.mockImplementation(
      async (_tenantId: string, tier: string) => {
        return tier === 'powerful' ? powerful : null;
      },
    );
    // Also needed for any fallback path
    mockFindAnyDefaultTenantModel.mockResolvedValue(powerful);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('claude-opus-4-20250514');
    expect(mockFindProjectOperationTierOverrides).toHaveBeenCalledWith('tenant-1', 'proj-1');
    // Should have queried with 'powerful' tier, not 'balanced'
    expect(mockFindDefaultTenantModelForTier).toHaveBeenCalledWith('tenant-1', 'powerful');
  });

  test('should ignore invalid persisted project operation-to-tier overrides', async () => {
    mockFindProjectOperationTierOverrides.mockResolvedValue({
      response_gen: 'premium',
    });

    const defaultModel = makeTenantModel({
      id: 'tm-default',
      modelId: 'gpt-5.4',
      tier: 'balanced',
    });
    mockFindAnyDefaultTenantModel.mockResolvedValue(defaultModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('gpt-5.4');
    expect(mockFindDefaultTenantModelForTier).not.toHaveBeenCalled();
    expect(mockFindAnyDefaultTenantModel).toHaveBeenCalledWith('tenant-1');
  });

  test('should ignore incompatible persisted project operation-to-tier overrides', async () => {
    mockFindProjectOperationTierOverrides.mockResolvedValue({
      response_gen: 'voice',
    });

    const defaultModel = makeTenantModel({
      id: 'tm-default',
      modelId: 'gpt-5.4',
      tier: 'balanced',
    });
    mockFindAnyDefaultTenantModel.mockResolvedValue(defaultModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
    });

    expect(result.modelId).toBe('gpt-5.4');
    expect(mockFindDefaultTenantModelForTier).not.toHaveBeenCalled();
    expect(mockFindAnyDefaultTenantModel).toHaveBeenCalledWith('tenant-1');
  });

  test('should use workspace default for validation when operation routing is disabled', async () => {
    const defaultModel = makeTenantModel({
      id: 'tm-default',
      modelId: 'gpt-5.4',
      provider: 'openai',
      tier: 'balanced',
    });
    mockFindAnyDefaultTenantModel.mockResolvedValue(defaultModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'validation',
    });

    expect(result.modelId).toBe('gpt-5.4');
    expect(mockFindDefaultTenantModelForTier).not.toHaveBeenCalled();
    expect(mockFindAnyDefaultTenantModel).toHaveBeenCalledWith('tenant-1');
  });

  test('should route tool_selection to fast tier when project explicitly opts in', async () => {
    mockFindProjectOperationTierOverrides.mockResolvedValue({
      tool_selection: 'fast',
    });

    const fast = makeTenantModel({
      id: 'tm-fast',
      modelId: 'gpt-4o-mini',
      provider: 'openai',
      tier: 'fast',
    });
    mockFindDefaultTenantModelForTier.mockImplementation(async (_tenantId: string, tier: string) =>
      tier === 'fast' ? fast : null,
    );
    mockFindAnyDefaultTenantModel.mockResolvedValue(fast);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'tool_selection',
    });

    expect(result.modelId).toBe('gpt-4o-mini');
    expect(mockFindDefaultTenantModelForTier).toHaveBeenCalledWith('tenant-1', 'fast');
  });

  test('should pass settingsVersionId for pinned settings resolution', async () => {
    const model = makeTenantModel();
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);
    mockFindProjectEnableThinking.mockResolvedValue({
      enableThinking: true,
      thinkingBudget: 5000,
    });

    const service = new ModelResolutionService(true, makeMockEncryption());
    await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
      settingsVersionId: 'sv-pinned-123',
    });

    expect(mockFindProjectEnableThinking).toHaveBeenCalledWith(
      'proj-1',
      'sv-pinned-123',
      'tenant-1',
    );
  });
});

// =============================================================================
// 11. inferProviderFromModelId — Missing Providers and Edge Cases
// =============================================================================

describe('inferProviderFromModelId edge cases', () => {
  test('should handle slash-prefixed model IDs correctly', () => {
    expect(inferProviderFromModelId('azure/my-gpt4-deployment')).toBe('azure');
    expect(inferProviderFromModelId('bedrock/amazon.titan-text-express')).toBe('bedrock');
    expect(inferProviderFromModelId('together/meta-llama/Llama-3-70B')).toBe('together');
  });

  test('llama bare name defaults to meta provider', () => {
    expect(inferProviderFromModelId('llama-3.1-70b')).toBe('meta');
    expect(inferProviderFromModelId('meta-llama-3.1-8b')).toBe('meta');
  });

  test('unknown model returns null so callers do not guess the provider', () => {
    expect(inferProviderFromModelId('my-custom-model')).toBeNull();
    expect(inferProviderFromModelId('random-model-name')).toBeNull();
  });

  test('should handle new providers: amazon, ai21, nvidia, azure', () => {
    expect(inferProviderFromModelId('titan-text-express')).toBe('amazon');
    expect(inferProviderFromModelId('jamba-1.5-mini')).toBe('ai21');
    expect(inferProviderFromModelId('nemotron-4-340b')).toBe('nvidia');
    expect(inferProviderFromModelId('phi-3-mini')).toBe('microsoft');
  });

  test('should handle codestral as mistral provider', () => {
    expect(inferProviderFromModelId('codestral-latest')).toBe('mistral');
  });

  test('should handle c4ai-aya as cohere provider', () => {
    expect(inferProviderFromModelId('c4ai-aya-expanse')).toBe('cohere');
  });

  test('should handle o4 as openai provider', () => {
    expect(inferProviderFromModelId('o4-mini')).toBe('openai');
  });

  test('should be case-insensitive for bare model name matching', () => {
    expect(inferProviderFromModelId('Claude-3-Sonnet')).toBe('anthropic');
    expect(inferProviderFromModelId('GPT-4o')).toBe('openai');
    expect(inferProviderFromModelId('Gemini-2.5-Pro')).toBe('google');
  });
});

// =============================================================================
// 12. Level 1: Agent IR Resolution
// =============================================================================

describe('ModelResolutionService Level 1: Agent IR', () => {
  beforeEach(resetAllMocks);

  test('should use agent IR execution.model', async () => {
    mockFindDefaultUserCredential.mockResolvedValue(makeCredential());

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
      userId: 'user-1',
      agentIR: {
        metadata: { name: 'test', description: '' },
        execution: { mode: 'reasoning', model: 'anthropic/claude-3-sonnet' },
      } as any,
    });

    expect(result.modelId).toBe('anthropic/claude-3-sonnet');
    expect(result.source).toBe('agent_ir');
  });

  test('should use agent IR operation_models over default model', async () => {
    mockFindDefaultUserCredential.mockResolvedValue(makeCredential());

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'extraction',
      userId: 'user-1',
      agentIR: {
        metadata: { name: 'test', description: '' },
        execution: {
          mode: 'reasoning',
          model: 'anthropic/claude-sonnet-4-20250514',
          operation_models: {
            extraction: 'anthropic/claude-3-haiku',
          },
        },
      } as any,
    });

    expect(result.modelId).toBe('anthropic/claude-3-haiku');
    expect(result.source).toBe('agent_ir');
  });

  test('should extract reasoning parameters from agent IR', async () => {
    mockFindDefaultUserCredential.mockResolvedValue(makeCredential());

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
      userId: 'user-1',
      agentIR: {
        metadata: { name: 'test', description: '' },
        execution: {
          mode: 'reasoning',
          model: 'anthropic/claude-sonnet-4-20250514',
          temperature: 0.3,
          max_tokens: 1024,
          reasoning_effort: 'high',
          enable_thinking: true,
          thinking_budget: 5000,
        },
      } as any,
    });

    expect(result.parameters.temperature).toBe(0.3);
    expect(result.parameters.maxTokens).toBe(1024);
    expect(result.parameters.reasoningEffort).toBeUndefined();
    expect(result.parameters.enableThinking).toBe(true);
    expect(result.parameters.thinkingBudget).toBe(5000);
  });

  test('agent IR enable_thinking=false should override project thinking default', async () => {
    mockFindDefaultUserCredential.mockResolvedValue(makeCredential());
    mockFindProjectEnableThinking.mockResolvedValue({
      enableThinking: true,
      thinkingBudget: 10000,
    });

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
      userId: 'user-1',
      agentIR: {
        metadata: { name: 'test', description: '' },
        execution: {
          mode: 'reasoning',
          model: 'anthropic/claude-sonnet-4-20250514',
          enable_thinking: false,
        },
      } as any,
    });

    expect(result.parameters.enableThinking).toBe(false);
    expect(result.parameters.thinkingBudget).toBe(10000);
  });

  test('agent IR should take priority over all DB levels', async () => {
    // Agent IR has model
    // Agent DB also has model
    mockFindAgentModelConfig.mockResolvedValue({
      id: 'amc-1',
      projectId: 'proj-1',
      agentName: 'test',
      defaultModel: 'gpt-4o',
      operationModels: '{}',
    });
    // Tenant model also exists
    mockFindDefaultTenantModelForTier.mockResolvedValue(
      makeTenantModel({ modelId: 'claude-sonnet-4-20250514' }),
    );

    mockFindDefaultUserCredential.mockResolvedValue(makeCredential());

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'test',
      operationType: 'response_gen',
      userId: 'user-1',
      agentIR: {
        metadata: { name: 'test', description: '' },
        execution: { mode: 'reasoning', model: 'google/gemini-2.5-pro' },
      } as any,
    });

    // IR model should win over both agent DB and tenant model
    expect(result.modelId).toBe('google/gemini-2.5-pro');
    expect(result.source).toBe('agent_ir');
  });
});

// =============================================================================
// 12b.DSL pinned modelId tail (single merged block: project then tenant)
// =============================================================================

// Phase A = project ModelConfig (uses findModelConfigByModelId from llm-resolution-repo — now
//           deterministic: find().sort({isDefault:-1,priority:-1,updatedAt:-1,_id:1}).limit(2) + duplicate warn).
// Phase B = tenant TenantModel iteration (uses TenantModel.find directly).

describe('ModelResolutionService DSL pinned modelId tail', () => {
  beforeEach(resetAllMocks);

  test('Phase A: DSL execution.model resolves through project ModelConfig → TenantModel (Azure beats inferred openai)', async () => {
    // Project binds DSL `gpt-4.1` to an Azure TenantModel.
    const azureTenantModel = makeTenantModel({
      id: 'tm-azure-1',
      _id: 'tm-azure-1',
      modelId: 'gpt-4.1',
      provider: 'azure',
      isDefault: false,
    });
    mockFindModelConfigByModelId.mockResolvedValue({
      id: 'mc-azure',
      _id: 'mc-azure',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      modelId: 'gpt-4.1',
      tenantModelId: 'tm-azure-1',
      isDefault: true,
      priority: 10,
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(azureTenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
      agentIR: {
        metadata: { name: 'a', description: '' },
        execution: { mode: 'reasoning', model: 'gpt-4.1' },
      } as any,
    });

    expect(result.modelId).toBe('gpt-4.1');
    expect(result.provider).toBe('azure');
    expect(result.source).toBe('project_db');
    expect(mockFindModelConfigByModelId).toHaveBeenCalledWith('proj-1', 'gpt-4.1', 'tenant-1');
    // Did NOT fall through to tenant Phase B
    expect(mockTenantModelFindCandidates).not.toHaveBeenCalled();
  });

  test('Phase A: DSL operation_models[op] also flows through project ModelConfig', async () => {
    const azureTenantModel = makeTenantModel({
      id: 'tm-azure-1',
      _id: 'tm-azure-1',
      modelId: 'gpt-4.1',
      provider: 'azure',
    });
    mockFindModelConfigByModelId.mockResolvedValue({
      id: 'mc-azure',
      _id: 'mc-azure',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      modelId: 'gpt-4.1',
      tenantModelId: 'tm-azure-1',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(azureTenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
      agentIR: {
        metadata: { name: 'a', description: '' },
        execution: {
          mode: 'reasoning',
          model: 'fallback-model',
          operation_models: { response_gen: 'gpt-4.1' },
        },
      } as any,
    });

    expect(result.modelId).toBe('gpt-4.1');
    expect(result.provider).toBe('azure');
    expect(result.source).toBe('project_db');
    // operation_models[op] takes precedence over execution.model — tail runs for `gpt-4.1`.
    expect(mockFindModelConfigByModelId).toHaveBeenCalledWith('proj-1', 'gpt-4.1', 'tenant-1');
  });

  test('Phase A: uses the deterministic project ModelConfig helper winner', async () => {
    // findModelConfigByModelId has repo-level coverage for its
    // isDefault→priority→updatedAt→_id ordering. This resolver test verifies that
    // Phase A follows the helper's selected winner.
    const azureTenantModel = makeTenantModel({
      id: 'tm-azure-default',
      _id: 'tm-azure-default',
      modelId: 'gpt-4.1',
      provider: 'azure',
      isDefault: true,
    });
    // Simulate the repo helper having picked the highest-priority winner
    // (isDefault:true, priority:10) and returned it as the single resolved doc.
    mockFindModelConfigByModelId.mockResolvedValue({
      id: 'mc-default-priority-10',
      _id: 'mc-default-priority-10',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      modelId: 'gpt-4.1',
      tenantModelId: 'tm-azure-default',
      isDefault: true,
      priority: 10,
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(azureTenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
      agentIR: {
        metadata: { name: 'a', description: '' },
        execution: { mode: 'reasoning', model: 'gpt-4.1' },
      } as any,
    });

    expect(result.modelId).toBe('gpt-4.1');
    expect(result.provider).toBe('azure');
    expect(result.source).toBe('project_db');
    expect(mockFindTenantModelByIdWithPrimaryConnection).toHaveBeenCalledWith(
      'tm-azure-default',
      'tenant-1',
    );
    // Phase B was not entered because Phase A resolved.
    expect(mockTenantModelFindCandidates).not.toHaveBeenCalled();
  });

  test('Phase B: when no project binding, tenant TenantModel registry resolves the DSL modelId', async () => {
    // No project ModelConfig matches (Phase A returns null).
    mockFindModelConfigByModelId.mockResolvedValue(null);
    // Tenant has an Azure TenantModel for gpt-4.1.
    mockTenantModelFindCandidates.mockResolvedValue([{ _id: 'tm-azure-1', isDefault: true }]);
    const azureTenantModel = makeTenantModel({
      id: 'tm-azure-1',
      _id: 'tm-azure-1',
      modelId: 'gpt-4.1',
      provider: 'azure',
      isDefault: true,
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(azureTenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
      agentIR: {
        metadata: { name: 'a', description: '' },
        execution: { mode: 'reasoning', model: 'gpt-4.1' },
      } as any,
    });

    expect(result.modelId).toBe('gpt-4.1');
    expect(result.provider).toBe('azure');
    expect(result.source).toBe('tenant_model');
    expect(mockTenantModelFindCandidates).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      modelId: 'gpt-4.1',
      isActive: true,
      inferenceEnabled: true,
    });
  });

  test('Phase B: iteration skips unusable candidate and picks the next usable one', async () => {
    mockFindModelConfigByModelId.mockResolvedValue(null);
    // Two candidates — isDefault one is unusable (resolveTenantModelById returns null),
    // the second one builds successfully.
    mockTenantModelFindCandidates.mockResolvedValue([
      { _id: 'tm-broken', isDefault: true },
      { _id: 'tm-usable', isDefault: false },
    ]);
    const usable = makeTenantModel({
      id: 'tm-usable',
      _id: 'tm-usable',
      modelId: 'gpt-4.1',
      provider: 'azure',
      isDefault: false,
    });
    // First call (tm-broken) returns null; second call (tm-usable) returns the model.
    mockFindTenantModelByIdWithPrimaryConnection
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(usable);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
      agentIR: {
        metadata: { name: 'a', description: '' },
        execution: { mode: 'reasoning', model: 'gpt-4.1' },
      } as any,
    });

    expect(result.modelId).toBe('gpt-4.1');
    expect(result.provider).toBe('azure');
    expect(result.source).toBe('tenant_model');
    // resolveTenantModelById invoked for BOTH candidates (broken first, then usable).
    expect(mockFindTenantModelByIdWithPrimaryConnection).toHaveBeenCalledTimes(2);
  });

  test('Phase B: when all matching tenant candidates are unusable, throws MODEL_NOT_CONFIGURED', async () => {
    mockFindModelConfigByModelId.mockResolvedValue(null);
    mockTenantModelFindCandidates.mockResolvedValue([
      { _id: 'tm-broken-1', isDefault: true },
      { _id: 'tm-broken-2', isDefault: false },
    ]);
    // Both candidates fail to build.
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(null);

    const service = new ModelResolutionService(true, makeMockEncryption());
    await expect(
      service.resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        operationType: 'response_gen',
        agentIR: {
          metadata: { name: 'a', description: '' },
          execution: { mode: 'reasoning', model: 'gpt-4.1' },
        } as any,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.MODEL_NOT_CONFIGURED.code });
    expect(mockFindTenantModelByIdWithPrimaryConnection).toHaveBeenCalledTimes(2);
  });

  test('miss path: DSL gpt-4.1 with no project/tenant binding → provider-inference resolves via existing OpenAI credential path (behavior unchanged)', async () => {
    mockFindModelConfigByModelId.mockResolvedValue(null);
    mockTenantModelFindCandidates.mockResolvedValue([]);
    const openaiTenantModel = makeTenantModel({
      id: 'tm-openai-existing',
      _id: 'tm-openai-existing',
      modelId: 'gpt-4o',
      provider: 'openai',
      isDefault: false,
    });
    mockFindTenantModelByProvider.mockResolvedValue(openaiTenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
      agentIR: {
        metadata: { name: 'a', description: '' },
        execution: { mode: 'reasoning', model: 'gpt-4.1' },
      } as any,
    });

    // Provider stays openai (existing inference path).
    expect(result.provider).toBe('openai');
    expect(inferProviderFromModelId('gpt-4.1')).toBe('openai');
    // findTenantModelByProvider IS the existing OpenAI-credential resolution branch.
    expect(mockFindTenantModelByProvider).toHaveBeenCalled();
  });

  test('Phase A: ModelConfig found but missing tenantModelId — continues to tenant fallback', async () => {
    mockFindModelConfigByModelId.mockResolvedValue({
      id: 'mc-orphan',
      _id: 'mc-orphan',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      modelId: 'gpt-4.1',
      tenantModelId: null,
    });
    // Missing tenantModelId is a non-fatal orphan row. Phase B can still resolve
    // a usable tenant-level custom model for the same DSL modelId.
    mockTenantModelFindCandidates.mockResolvedValue([{ _id: 'tm-azure-1', isDefault: true }]);
    const azureTenantModel = makeTenantModel({
      id: 'tm-azure-1',
      _id: 'tm-azure-1',
      modelId: 'gpt-4.1',
      provider: 'azure',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(azureTenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
      agentIR: {
        metadata: { name: 'a', description: '' },
        execution: { mode: 'reasoning', model: 'gpt-4.1' },
      } as any,
    });

    expect(result.modelId).toBe('gpt-4.1');
    expect(result.provider).toBe('azure');
    expect(result.source).toBe('tenant_model');
    expect(mockTenantModelFindCandidates).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      modelId: 'gpt-4.1',
      isActive: true,
      inferenceEnabled: true,
    });
  });

  test('Phase A: ModelConfig binding exists but linked TenantModel is unusable — throws MODEL_NOT_CONFIGURED', async () => {
    // Phase A finds a valid project ModelConfig with a tenantModelId, but the
    // linked TenantModel cannot be built (e.g., bad credentials / decryption fails).
    // Fail-closed: same pattern as Level 0 / Level 2 / Level 3 (line 1619 / 1784 / 1901).
    mockFindModelConfigByModelId.mockResolvedValue({
      id: 'mc-bound-but-broken',
      _id: 'mc-bound-but-broken',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      modelId: 'gpt-4.1',
      tenantModelId: 'tm-broken',
    });
    // Linked TenantModel cannot be resolved.
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(null);
    // Phase B would succeed if invoked — assert it is NOT invoked.
    mockTenantModelFindCandidates.mockResolvedValue([{ _id: 'tm-azure-other', isDefault: true }]);

    const service = new ModelResolutionService(true, makeMockEncryption());
    await expect(
      service.resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        operationType: 'response_gen',
        agentIR: {
          metadata: { name: 'a', description: '' },
          execution: { mode: 'reasoning', model: 'gpt-4.1' },
        } as any,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.MODEL_NOT_CONFIGURED.code });
    expect(mockTenantModelFindCandidates).not.toHaveBeenCalled();
  });

  test('guard: tail does NOT run when DSL did not pin a model (regression — preserves existing precedence)', async () => {
    // No DSL model. The merged tail is gated by `dslPinnedModelId && !tenantModelResult`,
    // so neither ModelConfig.find nor TenantModel.find should be invoked by
    // the tail path. The existing Level 4 main path takes over.
    const tenantDefault = makeTenantModel({
      id: 'tm-default',
      _id: 'tm-default',
      modelId: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      isDefault: true,
    });
    mockFindDefaultTenantModelForTier.mockResolvedValue(tenantDefault);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
      // No agentIR.execution.model.
    });

    expect(result.modelId).toBe('claude-sonnet-4-20250514');
    expect(result.source).toBe('tenant_model');
    // Tail never ran (Level 4 main resolved it first via mockFindDefaultTenantModelForTier).
    expect(mockFindModelConfigByModelId).not.toHaveBeenCalled();
    expect(mockTenantModelFindCandidates).not.toHaveBeenCalled();
  });

  test('guard: tail does NOT run for Level 0 deployment overrides — operator pin is preserved', async () => {
    // Level 0 uses findModelConfigByModelId; tail Phase A also uses it — both return null.
    mockFindModelConfigByModelId.mockResolvedValue(null);
    // If the tail incorrectly fired, this would route the deployment override
    // to an Azure tenant model. The test asserts that does NOT happen.
    const wouldHijack = makeTenantModel({
      id: 'tm-hijack',
      _id: 'tm-hijack',
      modelId: 'openai/deployment-gpt-4o',
      provider: 'azure',
      isDefault: true,
    });
    mockTenantModelFindCandidates.mockResolvedValue([{ _id: 'tm-hijack', isDefault: true }]);
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(wouldHijack);
    // Provider inference resolves credential via existing path.
    mockFindTenantModelByProvider.mockResolvedValue(
      makeTenantModel({
        id: 'tm-openai-default',
        _id: 'tm-openai-default',
        modelId: 'openai/deployment-gpt-4o',
        provider: 'openai',
        isDefault: false,
      }),
    );

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'response_gen',
      // No DSL model. Only Level 0 deployment override sets modelId.
      deploymentModelOverride: { model: 'openai/deployment-gpt-4o' },
    });

    // Tail must NOT have been invoked — dslPinnedModelId is undefined for Level 0 overrides.
    // findModelConfigByModelId IS called by Level 0 itself; assert Phase B (tenant find) did not fire.
    expect(mockTenantModelFindCandidates).not.toHaveBeenCalled();
    // Provider stays openai (existing inference path), not Azure.
    expect(result.provider).toBe('openai');
    expect(result.modelId).toBe('openai/deployment-gpt-4o');
  });
});

// =============================================================================
// 13. Voice Model Resolution (Level 3b)
// =============================================================================

describe('ModelResolutionService Level 3b: Voice resolution', () => {
  beforeEach(resetAllMocks);

  test('should skip arbitrary project model fallback for realtime_voice tier misses', async () => {
    const textModel = makeTenantModel({
      id: 'tm-text',
      modelId: 'gpt-4o',
      provider: 'openai',
      tier: 'balanced',
      capabilities: ['text'],
    });
    const voiceModel = makeTenantModel({
      id: 'tm-voice',
      modelId: 'gpt-4o-realtime-preview-2025-06-03',
      provider: 'openai',
      tier: 'voice',
      capabilities: ['realtime_voice'],
      realtimeConfig: JSON.stringify({
        audioFormat: 'pcm16',
        voices: ['marin'],
        connectionType: 'websocket',
      }),
    });

    mockFindModelConfigForTier.mockResolvedValue(null);
    mockFindAnyModelConfig.mockResolvedValue({
      id: 'mc-text',
      projectId: 'proj-1',
      modelId: 'gpt-4o',
      tenantModelId: 'tm-text',
      tier: 'balanced',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(textModel);
    mockFindDefaultTenantModelForVoice.mockResolvedValue(voiceModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationType: 'realtime_voice',
    });

    expect(result.modelId).toBe('gpt-4o-realtime-preview-2025-06-03');
    expect(result.source).toBe('tenant_model');
    expect(result.realtimeConfig).toBeDefined();
    expect(mockFindAnyModelConfig).not.toHaveBeenCalled();
    expect(mockFindTenantModelByIdWithPrimaryConnection).not.toHaveBeenCalledWith(
      'tm-text',
      'tenant-1',
    );
  });

  test('should resolve voice-capable TenantModel for realtime_voice operation', async () => {
    const voiceModel = makeTenantModel({
      id: 'tm-voice',
      modelId: 'gpt-realtime-1.5',
      provider: 'openai',
      capabilities: ['realtime_voice'],
      realtimeConfig: JSON.stringify({
        audioFormat: 'pcm16',
        voices: ['alloy', 'echo'],
        connectionType: 'websocket',
      }),
    });
    // Voice resolution is at Level 3b, called after Level 4 tier misses for 'voice' tier
    mockFindDefaultTenantModelForTier.mockResolvedValue(null);
    mockFindAnyDefaultTenantModel.mockResolvedValue(null);
    mockFindDefaultTenantModelForVoice.mockResolvedValue(voiceModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'realtime_voice',
    });

    expect(result.modelId).toBe('gpt-realtime-1.5');
    expect(result.source).toBe('tenant_model');
    expect(result.realtimeConfig).toBeDefined();
    expect(result.realtimeConfig!.audioFormat).toBe('pcm16');
  });

  test('should fail closed instead of using generic tenant model fallback for realtime_voice', async () => {
    const textModel = makeTenantModel({
      id: 'tm-text',
      modelId: 'gpt-4o',
      provider: 'openai',
      tier: 'balanced',
      capabilities: ['text'],
    });

    mockFindModelConfigForTier.mockResolvedValue(null);
    mockFindDefaultTenantModelForVoice.mockResolvedValue(null);
    mockFindDefaultTenantModelForTier.mockResolvedValue(null);
    mockFindAnyDefaultTenantModel.mockResolvedValue(textModel);

    const service = new ModelResolutionService(true, makeMockEncryption());

    await expect(
      service.resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        operationType: 'realtime_voice',
      }),
    ).rejects.toThrow('AI model configuration is missing');

    expect(mockFindAnyDefaultTenantModel).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 14. Credential Resolution with Null/Missing API Key
// =============================================================================

describe('ModelResolutionService credential edge cases', () => {
  beforeEach(resetAllMocks);

  test('should handle credential with null encryptedApiKey', async () => {
    const model = makeTenantModel({
      connections: [
        {
          id: 'conn-1',
          credentialId: 'cred-broken',
          encryptedApiKey: null,
          authType: 'api_key',
          isActive: true,
          isPrimary: true,
        },
      ],
    });
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);
    // Credential exists but decryption failed — encryptedApiKey is null
    mockFindCredentialById.mockResolvedValue(
      makeCredential({ _id: 'cred-broken', encryptedApiKey: null }),
    );
    // No fallback
    mockFindAnyDefaultTenantModel.mockResolvedValue(null);

    const service = new ModelResolutionService(true, makeMockEncryption());

    await expect(
      service.resolve({ tenantId: 'tenant-1', operationType: 'response_gen' }),
    ).rejects.toMatchObject({
      code: ErrorCodes.MODEL_NOT_CONFIGURED.code,
      message:
        'AI model configuration is missing for this workspace. Ask your workspace administrator to configure a model and credentials.',
    });
  });

  test('should recover credentialId-backed tenant model credentials when the plugin leaves ciphertext', async () => {
    const model = makeTenantModel({
      connections: [
        {
          id: 'conn-1',
          credentialId: 'cred-recoverable',
          isActive: true,
          isPrimary: true,
        },
      ],
    });
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);
    mockFindCredentialById.mockResolvedValue(
      makeCredential({
        _id: 'cred-recoverable',
        encryptedApiKey: 'N0:AAAA:BBBB:CCCC',
        _decryptionFailed: true,
      }),
    );
    mockResolveTenantPlaintextValue
      .mockResolvedValueOnce('sk-recovered')
      .mockResolvedValueOnce(null);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    expect(result.credential.apiKey).toBe('sk-recovered');
  });

  test('should handle encryption service being null', async () => {
    // DB available but no encryption — can't decrypt anything
    mockFindDefaultTenantModelForTier.mockResolvedValue(makeTenantModel());

    const service = new ModelResolutionService(true, null);

    await expect(
      service.resolve({ tenantId: 'tenant-1', operationType: 'response_gen' }),
    ).rejects.toMatchObject({
      code: ErrorCodes.MODEL_NOT_CONFIGURED.code,
      message:
        'AI model configuration is missing for this workspace. Ask your workspace administrator to configure a model and credentials.',
    });
  });

  test('should handle DB being unavailable', async () => {
    const service = new ModelResolutionService(false, makeMockEncryption());

    await expect(
      service.resolve({ tenantId: 'tenant-1', operationType: 'response_gen' }),
    ).rejects.toMatchObject({
      code: ErrorCodes.MODEL_NOT_CONFIGURED.code,
      message:
        'AI model configuration is missing for this workspace. Ask your workspace administrator to configure a model and credentials.',
    });
  });

  test('should honor dynamic tenant encryption readiness changes', async () => {
    let encryptionReady = false;
    const service = new ModelResolutionService(true, () => encryptionReady);

    mockFindDefaultTenantCredential.mockResolvedValue(makeCredential());

    await expect(
      (service as any).findTenantCredential('tenant-1', 'anthropic'),
    ).resolves.toBeNull();

    encryptionReady = true;

    await expect(
      (service as any).findTenantCredential('tenant-1', 'anthropic'),
    ).resolves.toMatchObject({
      apiKey: 'decrypted-api-key',
      authType: 'api_key',
    });
  });
});

// =============================================================================
// 15. Resolution Priority (full chain integration)
// =============================================================================

describe('ModelResolutionService full chain priority', () => {
  beforeEach(resetAllMocks);

  test('Level 0 > Level 1 > Level 2 > Level 3 > Level 4', async () => {
    // Set up all levels with different models
    const tenantModel = makeTenantModel({
      modelId: 'tenant-level-model',
      provider: 'anthropic',
    });
    mockFindDefaultTenantModelForTier.mockResolvedValue(tenantModel); // Level 4
    // Needed for credential resolution (TenantModel-by-provider fallback)
    mockFindTenantModelByProvider.mockResolvedValue(tenantModel);

    mockFindModelConfigForTier.mockResolvedValue({
      id: 'mc-1',
      projectId: 'proj-1',
      modelId: 'project-level-model',
      tenantModelId: null,
      tier: 'balanced',
    }); // Level 3

    mockFindAgentModelConfig.mockResolvedValue({
      id: 'amc-1',
      projectId: 'proj-1',
      agentName: 'my-agent',
      defaultModel: 'agent-db-model',
      operationModels: '{}',
    }); // Level 2
    mockFindModelConfigByModelId.mockResolvedValue(null);

    const agentIR = {
      metadata: { name: 'my-agent', description: '' },
      execution: { mode: 'reasoning', model: 'anthropic/agent-ir-model' },
    } as any; // Level 1

    const deploymentOverride = { model: 'openai/deployment-model' }; // Level 0

    const service = new ModelResolutionService(true, makeMockEncryption());

    // With deployment override — Level 0 wins
    // The model comes from deployment override, but credential comes from
    // Level 2 agent_db model resolution (which matched first), or falls through
    // to TenantModel-by-provider.
    const r0 = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'my-agent',
      operationType: 'response_gen',
      agentIR,
      deploymentModelOverride: deploymentOverride,
    });
    expect(r0.modelId).toBe('openai/deployment-model');

    // Clear cache between tests
    service.clearCache();

    // Without deployment override — Level 1 (IR) wins
    const r1 = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'my-agent',
      operationType: 'response_gen',
      agentIR,
    });
    expect(r1.modelId).toBe('anthropic/agent-ir-model');
  });
});

// =============================================================================
// 16. useResponsesApi / useStreaming Overrides
// =============================================================================

describe('ModelResolutionService useResponsesApi and useStreaming', () => {
  beforeEach(resetAllMocks);

  test('should propagate TenantModel useResponsesApi to result', async () => {
    const model = makeTenantModel({ useResponsesApi: true, useStreaming: false });
    mockFindDefaultTenantModelForTier.mockResolvedValue(model);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    expect(result.useResponsesApi).toBe(true);
    expect(result.useStreaming).toBe(false);
  });

  test('agent-level useResponsesApi should override TenantModel level', async () => {
    const tenantModel = makeTenantModel({ useResponsesApi: false });
    mockFindAgentModelConfig.mockResolvedValue({
      id: 'amc-1',
      projectId: 'proj-1',
      agentName: 'agent-1',
      defaultModel: 'gpt-4o',
      operationModels: '{}',
      temperature: null,
      maxTokens: null,
      hyperParameters: null,
      useResponsesApi: true, // agent overrides to true
      useStreaming: null,
    });
    mockFindModelConfigByModelId.mockResolvedValue({
      id: 'mc-1',
      projectId: 'proj-1',
      modelId: 'gpt-4o',
      tenantModelId: 'tm-1',
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'agent-1',
      operationType: 'response_gen',
    });

    // Agent-level override should win
    expect(result.useResponsesApi).toBe(true);
  });

  test('agent hyperParameters should override inherited project generation parameters', async () => {
    const tenantModel = makeTenantModel({ id: 'tm-1', modelId: 'gpt-4o', provider: 'openai' });
    mockFindAgentModelConfig.mockResolvedValue({
      id: 'amc-params',
      projectId: 'proj-1',
      agentName: 'agent-1',
      defaultModel: 'gpt-4o',
      operationModels: '{}',
      temperature: null,
      maxTokens: null,
      hyperParameters: {
        topP: 0.25,
        frequencyPenalty: -0.4,
        presencePenalty: 1.2,
      },
      useResponsesApi: null,
      useStreaming: null,
    });
    mockFindModelConfigByModelId.mockResolvedValue({
      id: 'mc-1',
      projectId: 'proj-1',
      modelId: 'gpt-4o',
      tenantModelId: 'tm-1',
      topP: 0.9,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
    });
    mockFindTenantModelByIdWithPrimaryConnection.mockResolvedValue(tenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'agent-1',
      operationType: 'response_gen',
    });

    expect(result.parameters).toEqual(
      expect.objectContaining({
        topP: 0.25,
        frequencyPenalty: -0.4,
        presencePenalty: 1.2,
      }),
    );
  });

  test('tenant hyperParameters should map max_completion_tokens to maxTokens', async () => {
    const tenantModel = makeTenantModel({
      id: 'tm-o3',
      modelId: 'o3',
      provider: 'openai',
      maxTokens: 4096,
      hyperParameters: {
        max_completion_tokens: 12345,
      },
    });
    mockFindDefaultTenantModelForTier.mockResolvedValue(tenantModel);

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
    });

    expect(result.parameters.maxTokens).toBe(12345);
  });
});

// =============================================================================
// 17. Agent IR compaction_threshold and thought_description
// =============================================================================

describe('ModelResolutionService Agent IR extended parameters', () => {
  beforeEach(resetAllMocks);

  test('should extract compaction_threshold and thought_description from agent IR', async () => {
    mockFindDefaultUserCredential.mockResolvedValue(makeCredential());

    const service = new ModelResolutionService(true, makeMockEncryption());
    const result = await service.resolve({
      tenantId: 'tenant-1',
      operationType: 'response_gen',
      userId: 'user-1',
      agentIR: {
        metadata: { name: 'test', description: '' },
        execution: {
          mode: 'reasoning',
          model: 'anthropic/claude-3-sonnet',
          compaction_threshold: 40000,
          thought_description: 'Think carefully about each step',
        },
      } as any,
    });

    expect(result.parameters.compactionThreshold).toBe(40000);
    expect(result.parameters.thoughtDescription).toBe('Think carefully about each step');
  });
});
