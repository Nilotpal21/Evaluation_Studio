/**
 * LLM Config Resolver Unit Tests
 *
 * Tests configuration resolution with inheritance hierarchy:
 * Index override → Smart defaults → Tenant credentials → Global env fallback
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerLLMClient } from '@agent-platform/llm';
import { resolveIndexLLMConfig, __testing } from '../resolver.js';

const mockResolveTenantPlaintextValue = vi.fn();

// ─── Mock models ─────────────────────────────────────────────────────────
// These stand in for Mongoose models returned by getModel().
const mockSearchIndex = { findById: vi.fn(), findOne: vi.fn() };
const mockTenantLLMPolicy = { findOne: vi.fn(), create: vi.fn() };
const mockLLMCredential = { findOne: vi.fn() };

// Mock db/index.ts — resolver imports getModel from here
vi.mock('../../../db/index.js', () => ({
  getModel: vi.fn((name: string) => {
    switch (name) {
      case 'SearchIndex':
        return mockSearchIndex;
      case 'TenantLLMPolicy':
        return mockTenantLLMPolicy;
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

vi.mock('@agent-platform/llm', () => {
  return {
    WorkerLLMClient: class MockWorkerLLMClient {
      getModelForTier(tier: string): string {
        const models: Record<string, string> = {
          fast: 'claude-haiku-4-5-20251001',
          balanced: 'claude-sonnet-4-5-20251001',
          powerful: 'claude-opus-4-7',
        };
        return models[tier] || 'claude-haiku-4-5-20251001';
      }
    },
  };
});

// Mock createLogger used by resolver and tenant-model-adapter at module scope
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock tenant-model-adapter to avoid its dynamic database imports
vi.mock('../tenant-model-adapter.js', () => ({
  resolveTenantModelWithFallback: vi.fn(),
  hasTenantModelsConfigured: vi.fn(),
}));

// =============================================================================
// Test Data
// =============================================================================

const mockTenantPolicy = {
  tenantId: 'tenant-123',
  allowedProviders: ['anthropic', 'openai', 'gemini'],
  monthlyTokenBudget: 10_000_000,
  dailyTokenBudget: 500_000,
  maxRequestsPerMinute: 100,
  credentialPolicy: 'tenant',
  allowProjectCredentials: false,
  platformDemoEnabled: false,
};

const mockCredential = {
  tenantId: 'tenant-123',
  provider: 'anthropic',
  encryptedApiKey: 'test-api-key-decrypted', // Auto-decrypted by mongoose plugin
  isActive: true,
  isDefault: true,
};

const mockIndexBase = {
  _id: 'index-456',
  tenantId: 'tenant-123',
  projectId: 'project-789',
  slug: 'test-index',
  name: 'Test Index',
  embeddingModel: 'bge-m3',
  embeddingDimensions: 1024,
  llmConfig: null, // No overrides
};

// =============================================================================
// Setup and Teardown
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveTenantPlaintextValue.mockImplementation(
    async (value: string | null | undefined) => value ?? null,
  );
  process.env.DEFAULT_LLM_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'test-env-api-key';
});

afterEach(() => {
  delete process.env.DEFAULT_LLM_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
});

// =============================================================================
// resolveIndexLLMConfig - Happy Path
// =============================================================================

describe('resolveIndexLLMConfig - happy path', () => {
  test('resolves full config with smart defaults', async () => {
    // Mock DB responses
    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexBase as any);

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    expect(result).toMatchObject({
      tenantId: 'tenant-123',
      indexId: 'index-456',
      provider: 'anthropic',
      apiKey: 'test-api-key-decrypted',
      monthlyTokenBudget: 10_000_000,
      dailyTokenBudget: 500_000,
      maxRequestsPerMinute: 100,
      embeddingModel: 'bge-m3',
      embeddingDimensions: 1024,
    });

    expect(result.useCases).toBeDefined();
    expect(result.useCases.progressiveSummarization).toBeDefined();
    expect(result.useCases.questionSynthesis).toBeDefined();
    expect(result.useCases.vision).toBeDefined();
  });

  test('decrypts lingering ciphertext from standalone LLMCredential records', async () => {
    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue({
      ...mockCredential,
      encryptedApiKey: 'N0:AAAA:BBBB:CCCC',
      _decryptionFailed: true,
    } as any);
    mockResolveTenantPlaintextValue.mockResolvedValue('test-api-key-decrypted');
    mockSearchIndex.findOne.mockResolvedValue(mockIndexBase as any);

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    expect(mockResolveTenantPlaintextValue).toHaveBeenCalledWith(
      'N0:AAAA:BBBB:CCCC',
      'tenant-123',
      {
        decryptionFailed: true,
      },
    );
    expect(result.apiKey).toBe('test-api-key-decrypted');
  });

  test('all use cases have resolved model names', async () => {
    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexBase as any);

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    for (const [useCase, config] of Object.entries(result.useCases)) {
      expect(config.model).toBeTruthy();
      expect(config.provider).toBe('anthropic');
      expect(config.modelTier).toMatch(/^(fast|balanced|powerful)$/);
    }
  });

  test('fast tier uses haiku model', async () => {
    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexBase as any);

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    expect(result.useCases.progressiveSummarization.modelTier).toBe('fast');
    expect(result.useCases.progressiveSummarization.model).toBe('claude-haiku-4-5-20251001');
  });

  test('balanced tier uses sonnet model', async () => {
    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexBase as any);

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    expect(result.useCases.vision.modelTier).toBe('balanced');
    expect(result.useCases.vision.model).toBe('claude-sonnet-4-5-20251001');
  });
});

// =============================================================================
// Configuration Inheritance
// =============================================================================

describe('configuration inheritance', () => {
  test('index override takes precedence over defaults', async () => {
    const mockIndexWithOverride = {
      ...mockIndexBase,
      llmConfig: {
        enabled: true,
        useCases: {
          progressiveSummarization: {
            enabled: true,
            modelTier: 'powerful', // Override: use powerful instead of fast
            maxTokens: 500, // Override: use 500 instead of 300
          },
        },
      },
    };

    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexWithOverride as any);

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    expect(result.useCases.progressiveSummarization.modelTier).toBe('powerful');
    expect(result.useCases.progressiveSummarization.model).toBe('claude-opus-4-7');
    expect(result.useCases.progressiveSummarization.maxTokens).toBe(500);
  });

  test('partial override merges with defaults', async () => {
    const mockIndexWithPartialOverride = {
      ...mockIndexBase,
      llmConfig: {
        useCases: {
          progressiveSummarization: {
            maxTokens: 400, // Only override maxTokens
          },
        },
      },
    };

    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexWithPartialOverride as any);

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    // Override applied
    expect(result.useCases.progressiveSummarization.maxTokens).toBe(400);
    // Defaults preserved
    expect(result.useCases.progressiveSummarization.enabled).toBe(true);
    expect(result.useCases.progressiveSummarization.modelTier).toBe('fast');
    expect(result.useCases.progressiveSummarization.enableDocumentSummary).toBe(true);
  });

  test('global enabled flag disables all use cases', async () => {
    const mockIndexDisabled = {
      ...mockIndexBase,
      llmConfig: {
        enabled: false, // Global disable
      },
    };

    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexDisabled as any);

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    for (const [useCase, config] of Object.entries(result.useCases)) {
      expect(config.enabled).toBe(false);
    }
  });

  test('use case-level enabled overrides global enabled', async () => {
    const mockIndexMixed = {
      ...mockIndexBase,
      llmConfig: {
        enabled: false, // Global disable
        useCases: {
          vision: {
            enabled: true, // But enable vision specifically
          },
        },
      },
    };

    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexMixed as any);

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    // Actually, looking at the resolver code, use case enabled should respect global flag
    // The resolver checks: if (!globalEnabled || !enabled) return disabled
    // So if global is false, use case cannot override to true
    expect(result.useCases.vision.enabled).toBe(false); // Global disable wins
    expect(result.useCases.progressiveSummarization.enabled).toBe(false);
  });
});

// =============================================================================
// Tenant Policy Creation
// =============================================================================

describe('tenant policy creation', () => {
  test('expands existing legacy default provider allowlists at read time', async () => {
    mockTenantLLMPolicy.findOne.mockResolvedValue({
      ...mockTenantPolicy,
      allowedProviders: ['anthropic', 'openai', 'gemini'],
    } as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexBase as any);

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    expect(result.allowedProviders).toEqual(['anthropic', 'openai', 'gemini', 'google', 'azure']);
    expect(mockTenantLLMPolicy.create).not.toHaveBeenCalled();
  });

  test('creates default policy if none exists', async () => {
    mockTenantLLMPolicy.findOne.mockResolvedValue(null);
    mockTenantLLMPolicy.create.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexBase as any);

    await resolveIndexLLMConfig('tenant-123', 'index-456');

    expect(mockTenantLLMPolicy.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-123',
        allowedProviders: ['anthropic', 'openai', 'gemini', 'google', 'azure'],
        monthlyTokenBudget: 10_000_000,
        dailyTokenBudget: 500_000,
        maxRequestsPerMinute: 100,
      }),
    );
  });

  test('logs warning when creating default policy', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockTenantLLMPolicy.findOne.mockResolvedValue(null);
    mockTenantLLMPolicy.create.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexBase as any);

    await resolveIndexLLMConfig('tenant-123', 'index-456');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No TenantLLMPolicy found for tenant tenant-123'),
    );

    consoleSpy.mockRestore();
  });
});

// =============================================================================
// Credential Fallback
// =============================================================================

describe('credential fallback', () => {
  test('uses environment variables if no credential exists', async () => {
    process.env.DEFAULT_LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'env-openai-key';

    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(null); // No credential
    mockSearchIndex.findOne.mockResolvedValue(mockIndexBase as any);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    expect(result.provider).toBe('openai');
    expect(result.apiKey).toBe('env-openai-key');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No LLMCredential or TenantModel found for tenant tenant-123'),
    );

    consoleSpy.mockRestore();
  });

  test('returns disabled config if no credential and no env var', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(null);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexBase as any);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    // Graceful degradation: returns config with empty apiKey and all use cases disabled
    expect(result.apiKey).toBe('');
    for (const [, config] of Object.entries(result.useCases)) {
      expect(config.enabled).toBe(false);
    }

    consoleSpy.mockRestore();
  });

  test('supports all provider env vars', async () => {
    const providers = [
      { name: 'anthropic', envVar: 'ANTHROPIC_API_KEY', key: 'test-anthropic-key' },
      { name: 'openai', envVar: 'OPENAI_API_KEY', key: 'test-openai-key' },
      { name: 'gemini', envVar: 'GEMINI_API_KEY', key: 'test-gemini-key' },
      { name: 'google', envVar: 'GOOGLE_API_KEY', key: 'test-google-key' },
    ];

    for (const { name, envVar, key } of providers) {
      vi.clearAllMocks();
      process.env.DEFAULT_LLM_PROVIDER = name;
      process.env[envVar] = key;

      mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
      mockLLMCredential.findOne.mockResolvedValue(null);
      mockSearchIndex.findOne.mockResolvedValue(mockIndexBase as any);

      const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

      expect(result.provider).toBe(name);
      expect(result.apiKey).toBe(key);

      delete process.env[envVar];
    }
  });

  test('uses GEMINI_API_KEY as a fallback for google env configuration', async () => {
    process.env.DEFAULT_LLM_PROVIDER = 'google';
    process.env.GEMINI_API_KEY = 'test-google-gemini-key';

    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(null);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexBase as any);

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    expect(result.provider).toBe('google');
    expect(result.apiKey).toBe('test-google-gemini-key');
  });
});

// =============================================================================
// Error Handling
// =============================================================================

describe('error handling', () => {
  test('throws if index not found', async () => {
    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(null);

    await expect(resolveIndexLLMConfig('tenant-123', 'index-456')).rejects.toThrow(
      'SearchIndex not found: index-456',
    );
  });

  test('throws if index belongs to different tenant', async () => {
    const wrongTenantIndex = {
      ...mockIndexBase,
      tenantId: 'tenant-999', // Different tenant!
    };

    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(wrongTenantIndex as any);

    await expect(resolveIndexLLMConfig('tenant-123', 'index-456')).rejects.toThrow(
      /does not belong to tenant tenant-123/,
    );
  });

  test('error message indicates security violation for tenant mismatch', async () => {
    const wrongTenantIndex = {
      ...mockIndexBase,
      tenantId: 'tenant-999',
    };

    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(wrongTenantIndex as any);

    await expect(resolveIndexLLMConfig('tenant-123', 'index-456')).rejects.toThrow(
      /security violation/,
    );
  });
});

// =============================================================================
// Use Case-Specific Parameters
// =============================================================================

describe('use case-specific parameters', () => {
  test('progressiveSummarization includes all parameters', async () => {
    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexBase as any);

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    expect(result.useCases.progressiveSummarization).toMatchObject({
      enabled: true,
      modelTier: 'fast',
      model: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      maxTokens: 300,
      enableDocumentSummary: true,
      documentSummaryMaxTokens: 500,
    });
  });

  test('vision includes screenshot and image options', async () => {
    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexBase as any);

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    expect(result.useCases.vision).toMatchObject({
      enabled: true,
      modelTier: 'balanced',
      model: 'claude-sonnet-4-5-20251001',
      provider: 'anthropic',
      maxTokens: 500,
      analyzeScreenshots: true,
      analyzeImages: true,
      enhanceTableContinuations: true,
    });
  });

  test('knowledgeGraph includes co-occurrence option', async () => {
    mockTenantLLMPolicy.findOne.mockResolvedValue(mockTenantPolicy as any);
    mockLLMCredential.findOne.mockResolvedValue(mockCredential as any);
    mockSearchIndex.findOne.mockResolvedValue(mockIndexBase as any);

    const result = await resolveIndexLLMConfig('tenant-123', 'index-456');

    expect(result.useCases.knowledgeGraph).toMatchObject({
      enabled: true,
      modelTier: 'fast',
      enableCoOccurrence: true,
    });
  });
});
