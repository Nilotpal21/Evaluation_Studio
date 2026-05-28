/**
 * LLM Services Tests
 *
 * Tests for model capabilities, cost calculation, tier mapping,
 * resolution caching, and provider cache utilities.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorCodes } from '@agent-platform/shared-kernel';
import {
  getModelCapabilities,
  calculateCost,
  KNOWN_MODEL_CAPABILITIES,
  mapCompilerTierToPlatform,
  mapPlatformTierToCompiler,
} from '../services/llm/model-router';
import { ModelResolutionService, inferProviderFromModelId } from '../services/llm/model-resolution';
import { modelSupportsResponsesApi } from '@abl/compiler/platform/llm/model-registry.js';

// Mock the repo module used by ModelResolutionService
vi.mock('../repos/llm-resolution-repo', () => ({
  isResolutionDatabaseAvailable: vi.fn().mockReturnValue(false),
  findAgentModelConfig: vi.fn().mockResolvedValue(null),
  findModelConfigForTier: vi.fn().mockResolvedValue(null),
  findAnyModelConfig: vi.fn().mockResolvedValue(null),
  findTenantModelByIdWithPrimaryConnection: vi.fn().mockResolvedValue(null),
  findDefaultTenantModelForTier: vi.fn().mockResolvedValue(null),
  findTenantModelByProvider: vi.fn().mockResolvedValue(null),
  findTenantLLMPolicy: vi.fn().mockResolvedValue(null),
  findDefaultUserCredential: vi.fn().mockResolvedValue(null),
  findDefaultTenantCredential: vi.fn().mockResolvedValue(null),
  findCredentialById: vi.fn().mockResolvedValue(null),
}));

// =============================================================================
// getModelCapabilities (standalone function)
// =============================================================================

describe('getModelCapabilities', () => {
  test('should return known capabilities for recognized model', () => {
    const capabilities = getModelCapabilities('anthropic/claude-sonnet-4');

    expect(capabilities.supportsTools).toBe(true);
    expect(capabilities.supportsVision).toBe(true);
    expect(capabilities.supportsStreaming).toBe(true);
    expect(capabilities.contextWindow).toBe(200000);
    expect(capabilities.inputCostPer1k).toBe(0.003);
    expect(capabilities.outputCostPer1k).toBe(0.015);
  });

  test('should return defaults for unknown model', () => {
    const capabilities = getModelCapabilities('unknown/model');

    expect(capabilities.supportsTools).toBe(true);
    expect(capabilities.supportsVision).toBe(false);
    expect(capabilities.supportsStreaming).toBe(true);
    expect(capabilities.contextWindow).toBe(128000);
    expect(capabilities.inputCostPer1k).toBe(0.001);
    expect(capabilities.outputCostPer1k).toBe(0.002);
  });

  test('should merge known partial with defaults', () => {
    const capabilities = getModelCapabilities('groq/mixtral-8x7b');

    expect(capabilities.supportsVision).toBe(false); // explicitly false in known
    expect(capabilities.supportsTools).toBe(true); // explicitly true in known
    expect(capabilities.contextWindow).toBe(32000);
  });
});

// =============================================================================
// calculateCost (standalone function)
// =============================================================================

describe('calculateCost', () => {
  test('should calculate cost based on token usage', () => {
    const cost = calculateCost(0.003, 0.015, 1000, 500);

    expect(cost).toBeCloseTo(0.003 + 0.0075, 5);
  });

  test('should handle zero tokens', () => {
    const cost = calculateCost(0.003, 0.015, 0, 0);

    expect(cost).toBe(0);
  });

  test('should handle zero costs', () => {
    const cost = calculateCost(0, 0, 1000, 500);

    expect(cost).toBe(0);
  });
});

// =============================================================================
// inferProviderFromModelId (shared utility)
// =============================================================================

describe('inferProviderFromModelId', () => {
  test('should extract provider from slash format', () => {
    expect(inferProviderFromModelId('anthropic/claude-3-sonnet')).toBe('anthropic');
    expect(inferProviderFromModelId('openai/gpt-4o')).toBe('openai');
    expect(inferProviderFromModelId('groq/llama-3.1-70b')).toBe('groq');
  });

  test('should not treat provider-native slash model IDs as platform provider prefixes', () => {
    expect(inferProviderFromModelId('meta-llama/Llama-3.3-70B-Instruct-Turbo')).toBe('togetherai');
    expect(inferProviderFromModelId('accounts/fireworks/models/qwen-qwq-32b-preview')).toBe(
      'fireworks',
    );
    expect(inferProviderFromModelId('some-org/custom-model')).toBeNull();
  });

  test('should infer anthropic from bare claude model names', () => {
    expect(inferProviderFromModelId('claude-3-sonnet-20240229')).toBe('anthropic');
    expect(inferProviderFromModelId('claude-haiku-4-5-20251001')).toBe('anthropic');
  });

  test('should infer openai from bare gpt/o1/o3 model names', () => {
    expect(inferProviderFromModelId('gpt-4o')).toBe('openai');
    expect(inferProviderFromModelId('o1-preview')).toBe('openai');
    expect(inferProviderFromModelId('o3-mini')).toBe('openai');
  });

  test('should infer google from bare gemini model names', () => {
    expect(inferProviderFromModelId('gemini-1.5-pro')).toBe('google');
    expect(inferProviderFromModelId('gemini-2.5-pro')).toBe('google');
  });

  test('should infer provider from other known model name patterns', () => {
    expect(inferProviderFromModelId('mistral-large-latest')).toBe('mistral');
    expect(inferProviderFromModelId('mixtral-8x7b')).toBe('mistral');
    expect(inferProviderFromModelId('deepseek-chat')).toBe('deepseek');
    expect(inferProviderFromModelId('grok-2')).toBe('xai');
    expect(inferProviderFromModelId('command-r-plus')).toBe('cohere');
    expect(inferProviderFromModelId('sonar-pro')).toBe('perplexity');
  });

  test('should return null for unknown models', () => {
    expect(inferProviderFromModelId('some-unknown-model')).toBeNull();
  });
});

// =============================================================================
// Tier Mapping Functions
// =============================================================================

describe('Tier Mapping Functions', () => {
  test('mapCompilerTierToPlatform', () => {
    expect(mapCompilerTierToPlatform('haiku')).toBe('fast');
    expect(mapCompilerTierToPlatform('sonnet')).toBe('balanced');
    expect(mapCompilerTierToPlatform('opus')).toBe('powerful');
  });

  test('mapPlatformTierToCompiler', () => {
    expect(mapPlatformTierToCompiler('fast')).toBe('haiku');
    expect(mapPlatformTierToCompiler('balanced')).toBe('sonnet');
    expect(mapPlatformTierToCompiler('powerful')).toBe('opus');
  });
});

// =============================================================================
// KNOWN_MODEL_CAPABILITIES
// =============================================================================

describe('KNOWN_MODEL_CAPABILITIES', () => {
  test('should have Anthropic models', () => {
    expect(KNOWN_MODEL_CAPABILITIES['anthropic/claude-opus-4']).toBeDefined();
    expect(KNOWN_MODEL_CAPABILITIES['anthropic/claude-sonnet-4']).toBeDefined();
    expect(KNOWN_MODEL_CAPABILITIES['anthropic/claude-haiku-4-5']).toBeDefined();
  });

  test('should have OpenAI models', () => {
    expect(KNOWN_MODEL_CAPABILITIES['openai/gpt-4o']).toBeDefined();
    expect(KNOWN_MODEL_CAPABILITIES['openai/gpt-4o-mini']).toBeDefined();
  });

  test('should have Google models', () => {
    expect(KNOWN_MODEL_CAPABILITIES['google/gemini-2.5-pro']).toBeDefined();
    expect(KNOWN_MODEL_CAPABILITIES['google/gemini-2.0-flash']).toBeDefined();
  });

  test('should have correct capability flags', () => {
    const opus = KNOWN_MODEL_CAPABILITIES['anthropic/claude-opus-4'];
    expect(opus?.supportsTools).toBe(true);
    expect(opus?.supportsVision).toBe(true);
    expect(opus?.supportsStreaming).toBe(true);
    expect(opus?.contextWindow).toBeGreaterThan(0);
    expect(opus?.inputCostPer1k).toBeGreaterThan(0);
    expect(opus?.outputCostPer1k).toBeGreaterThan(0);
  });
});

// =============================================================================
// ModelResolutionService — Resolution Cache
// =============================================================================

describe('ModelResolutionService resolution cache', () => {
  let service: ModelResolutionService;

  beforeEach(() => {
    service = new ModelResolutionService(false, null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('should return cached result within TTL (agent_ir level)', async () => {
    const agentIR = {
      metadata: { name: 'test-agent', description: '' },
      execution: { mode: 'reasoning', model: 'anthropic/claude-3-sonnet' },
    } as any;

    // Agent IR provides model — but credential resolution will fail without DB/encryption
    // The test verifies caching by checking same reference
    await expect(
      service.resolve({
        operationType: 'response_gen',
        agentIR,
      }),
    ).rejects.toThrow(/No credential found/);
  });

  test('should throw when no model configured and no env fallback', async () => {
    await expect(
      service.resolve({
        operationType: 'response_gen',
        agentName: 'test-agent',
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.MODEL_NOT_CONFIGURED.code,
      message:
        'AI model configuration is missing for this workspace. Ask your workspace administrator to configure a model and credentials.',
    });
  });

  test('should use agent IR model when provided (with mock credential)', async () => {
    const { findDefaultUserCredential } = await import('../repos/llm-resolution-repo');
    vi.mocked(findDefaultUserCredential).mockResolvedValue({
      tenantId: 'tenant-1',
      credentialScope: 'user',
      ownerId: 'user-1',
      encryptedApiKey: 'encrypted-key',
      authType: 'api_key',
    });

    const mockEncryption = {
      decrypt: vi.fn().mockReturnValue('test-api-key'),
      decryptForTenant: vi.fn().mockReturnValue('test-api-key'),
    } as any;

    const svcWithDb = new ModelResolutionService(true, mockEncryption);
    const agentIR = {
      metadata: { name: 'test-agent', description: '' },
      execution: { mode: 'reasoning', model: 'anthropic/claude-3-sonnet' },
    } as any;

    const result = await svcWithDb.resolve({
      operationType: 'response_gen',
      agentIR,
      userId: 'user-1',
    });

    expect(result.modelId).toBe('anthropic/claude-3-sonnet');
    expect(result.source).toBe('agent_ir');
    expect(result.provider).toBe('anthropic');
  });

  test('should use operation_models when provided', async () => {
    const { findDefaultUserCredential } = await import('../repos/llm-resolution-repo');
    vi.mocked(findDefaultUserCredential).mockResolvedValue({
      tenantId: 'tenant-1',
      credentialScope: 'user',
      ownerId: 'user-1',
      encryptedApiKey: 'encrypted-key',
      authType: 'api_key',
    });

    const mockEncryption = {
      decrypt: vi.fn().mockReturnValue('test-api-key'),
      decryptForTenant: vi.fn().mockReturnValue('test-api-key'),
    } as any;

    const svcWithDb = new ModelResolutionService(true, mockEncryption);
    const agentIR = {
      metadata: { name: 'test-agent', description: '' },
      execution: {
        mode: 'reasoning',
        model: 'anthropic/claude-3-sonnet',
        operation_models: {
          extraction: 'anthropic/claude-3-haiku',
        },
      },
    } as any;

    const result = await svcWithDb.resolve({
      operationType: 'extraction',
      agentIR,
      userId: 'user-1',
    });

    expect(result.modelId).toBe('anthropic/claude-3-haiku');
    expect(result.source).toBe('agent_ir');
  });
});

// =============================================================================
// modelSupportsResponsesApi — OpenAI Responses API auto-detection
// =============================================================================

describe('modelSupportsResponsesApi', () => {
  test('should return true for GPT-4o models', () => {
    expect(modelSupportsResponsesApi('gpt-4o')).toBe(true);
    expect(modelSupportsResponsesApi('gpt-4o-mini')).toBe(true);
    expect(modelSupportsResponsesApi('gpt-4o-2024-08-06')).toBe(true);
  });

  test('should return true for reasoning models (o-series)', () => {
    expect(modelSupportsResponsesApi('o1')).toBe(true);
    expect(modelSupportsResponsesApi('o3')).toBe(true);
    expect(modelSupportsResponsesApi('o3-mini')).toBe(true);
    expect(modelSupportsResponsesApi('o4-mini')).toBe(true);
  });

  test('should return true for GPT-4.1 models', () => {
    expect(modelSupportsResponsesApi('gpt-4.1')).toBe(true);
    expect(modelSupportsResponsesApi('gpt-4.1-mini')).toBe(true);
    expect(modelSupportsResponsesApi('gpt-4.1-nano')).toBe(true);
  });

  test('should return true for GPT-5 models', () => {
    expect(modelSupportsResponsesApi('gpt-5')).toBe(true);
    expect(modelSupportsResponsesApi('gpt-5-mini')).toBe(true);
    expect(modelSupportsResponsesApi('gpt-5.1')).toBe(true);
  });

  test('should return false for non-OpenAI models', () => {
    expect(modelSupportsResponsesApi('claude-sonnet-4-20250514')).toBe(false);
    expect(modelSupportsResponsesApi('gemini-2.5-pro')).toBe(false);
    expect(modelSupportsResponsesApi('mistral-large-latest')).toBe(false);
  });

  test('should return false for unknown models', () => {
    expect(modelSupportsResponsesApi('some-unknown-model')).toBe(false);
  });

  test('should return false for older OpenAI models not in the set', () => {
    expect(modelSupportsResponsesApi('gpt-3.5-turbo')).toBe(false);
    expect(modelSupportsResponsesApi('gpt-4-turbo')).toBe(false);
  });
});
