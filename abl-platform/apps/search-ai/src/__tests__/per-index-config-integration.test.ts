/**
 * Per-Index LLM Configuration Integration Tests (Focused Suite)
 *
 * Tests core functionality of per-index LLM configuration:
 * - Model tier resolution (fast/balanced/powerful)
 * - Feature toggles per index
 * - Default handling for partial configs
 * - Multiple indexes with different configs
 *
 * Note: This is the first deployment of SearchAI, so no legacy data exists.
 * Users can provide partial llmConfig (only some use cases defined), and
 * undefined use cases will get smart defaults.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import type { Model } from 'mongoose';
import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';
import { getModel } from '../db/index.js';

// Models are retrieved AFTER setupTestMongo() connects to the database.
// Direct imports from @agent-platform/database would reference model instances
// created before mongoose.connect(), causing 10s buffering timeouts.
let SearchIndex: Model<any>;
let TenantLLMPolicy: Model<any>;
let LLMCredential: Model<any>;

// =============================================================================
// Mock LLMClient
// =============================================================================

vi.mock('@abl/compiler/platform/llm', () => ({
  LLMClient: class MockLLMClient {
    constructor(private config: { provider: string; apiKey: string }) {}

    getProvider() {
      return this.config.provider;
    }

    getModelForTier(tier: string): string {
      const models: Record<string, string> = {
        fast: 'claude-haiku-4-5-20251001',
        balanced: 'claude-sonnet-4-5-20251001',
        powerful: 'claude-opus-4-7',
      };
      return models[tier] || 'claude-haiku-4-5-20251001';
    }
  },
}));

// =============================================================================
// Test Data
// =============================================================================

const tenantId = 'test-tenant-per-index';
const projectId = 'test-project-per-index';

// Helper to create test index with required fields
const createTestIndex = (config: any) => {
  return SearchIndex.create({
    tenantId,
    projectId,
    embeddingModel: 'bge-m3',
    embeddingDimensions: 1024,
    vectorStore: {
      provider: 'qdrant',
      collectionName: `test_${config.slug}`,
    },
    searchDefaults: {
      topK: 10,
      similarityThreshold: 0.7,
      includeMetadata: true,
      includeContent: true,
    },
    ...config,
  });
};

// =============================================================================
// Setup and Teardown
// =============================================================================

beforeAll(async () => {
  await setupTestMongo();

  // Retrieve models bound to the correct database connections
  SearchIndex = getModel('SearchIndex');
  TenantLLMPolicy = getModel('TenantLLMPolicy');
  LLMCredential = getModel('LLMCredential');

  // Create tenant policy
  await TenantLLMPolicy.create({
    tenantId,
    allowedProviders: ['anthropic', 'openai', 'gemini'],
    monthlyTokenBudget: 10_000_000,
    dailyTokenBudget: 500_000,
    maxRequestsPerMinute: 100,
    credentialPolicy: 'tenant',
    allowProjectCredentials: false,
    platformDemoEnabled: false,
  });

  // Create tenant credential
  await LLMCredential.create({
    credentialScope: 'tenant',
    ownerId: tenantId,
    tenantId,
    provider: 'anthropic',
    name: 'Test Anthropic Credential',
    encryptedApiKey: 'sk-ant-test-key',
    encryptedEndpoint: null,
    authType: 'api_key',
    authConfig: {},
    isActive: true,
    isDefault: true,
    lastUsedAt: null,
    lastValidatedAt: null,
  });
}, 90_000); // 90s timeout for MongoDB startup + dual-connection init

afterAll(async () => {
  await teardownTestMongo();
}, 60_000);

beforeEach(async () => {
  await clearCollections(['search_indexes', 'search_documents', 'document_pages', 'search_chunks']);
});

// =============================================================================
// Test Suite 1: Model Tier Resolution
// =============================================================================

describe('Model Tier Resolution', () => {
  it('should resolve fast tier to cheaper models', async () => {
    const index = await createTestIndex({
      slug: 'fast-index',
      name: 'Fast Index',
      llmConfig: {
        enabled: true,
        useCases: {
          progressiveSummarization: {
            enabled: true,
            modelTier: 'fast',
            maxTokens: 150,
          },
        },
      },
    });

    const config = await resolveIndexLLMConfig(tenantId, index._id);

    expect(config.useCases.progressiveSummarization.enabled).toBe(true);
    expect(config.useCases.progressiveSummarization.modelTier).toBe('fast');
    expect(config.useCases.progressiveSummarization.model).toContain('haiku');
    expect(config.useCases.progressiveSummarization.maxTokens).toBe(150);

    // Provider and apiKey are at config level, not use case level
    expect(config.provider).toBe('anthropic');
    expect(config.apiKey).toBe('sk-ant-test-key');
  });

  it('should resolve balanced tier to mid-range models', async () => {
    const index = await createTestIndex({
      slug: 'balanced-index',
      name: 'Balanced Index',
      llmConfig: {
        enabled: true,
        useCases: {
          progressiveSummarization: {
            enabled: true,
            modelTier: 'balanced',
            maxTokens: 300,
          },
        },
      },
    });

    const config = await resolveIndexLLMConfig(tenantId, index._id);

    expect(config.useCases.progressiveSummarization.modelTier).toBe('balanced');
    expect(config.useCases.progressiveSummarization.model).toContain('sonnet');
    expect(config.useCases.progressiveSummarization.maxTokens).toBe(300);
  });

  it('should resolve powerful tier to premium models', async () => {
    const index = await createTestIndex({
      slug: 'powerful-index',
      name: 'Powerful Index',
      llmConfig: {
        enabled: true,
        useCases: {
          progressiveSummarization: {
            enabled: true,
            modelTier: 'powerful',
            maxTokens: 500,
          },
        },
      },
    });

    const config = await resolveIndexLLMConfig(tenantId, index._id);

    expect(config.useCases.progressiveSummarization.modelTier).toBe('powerful');
    expect(config.useCases.progressiveSummarization.model).toContain('opus');
    expect(config.useCases.progressiveSummarization.maxTokens).toBe(500);
  });
});

// =============================================================================
// Test Suite 2: Feature Toggles
// =============================================================================

describe('Feature Toggles', () => {
  it('should allow disabling specific features', async () => {
    const index = await createTestIndex({
      slug: 'disabled-features',
      name: 'Disabled Features Index',
      llmConfig: {
        enabled: true,
        useCases: {
          progressiveSummarization: {
            enabled: false, // Explicitly disabled
          },
          questionSynthesis: {
            enabled: true,
            modelTier: 'fast',
          },
        },
      },
    });

    const config = await resolveIndexLLMConfig(tenantId, index._id);

    expect(config.useCases.progressiveSummarization.enabled).toBe(false);
    expect(config.useCases.questionSynthesis.enabled).toBe(true);
    expect(config.useCases.questionSynthesis.modelTier).toBe('fast');
  });

  it('should support different tiers for different use cases', async () => {
    const index = await createTestIndex({
      slug: 'mixed-tiers',
      name: 'Mixed Tiers Index',
      llmConfig: {
        enabled: true,
        useCases: {
          progressiveSummarization: {
            enabled: true,
            modelTier: 'fast', // Fast for summaries
          },
          questionSynthesis: {
            enabled: true,
            modelTier: 'powerful', // Powerful for questions
          },
          vision: {
            enabled: true,
            modelTier: 'balanced', // Balanced for vision
          },
        },
      },
    });

    const config = await resolveIndexLLMConfig(tenantId, index._id);

    expect(config.useCases.progressiveSummarization.modelTier).toBe('fast');
    expect(config.useCases.questionSynthesis.modelTier).toBe('powerful');
    expect(config.useCases.vision.modelTier).toBe('balanced');
  });
});

// =============================================================================
// Test Suite 3: Default Handling
// =============================================================================

describe('Default Handling', () => {
  it('should merge partial llmConfig with smart defaults', async () => {
    // Common scenario: user only configures what they care about
    const partialIndex = await createTestIndex({
      slug: 'partial-config',
      name: 'Partial Config Index',
      llmConfig: {
        enabled: true,
        useCases: {
          // Only define ONE use case
          progressiveSummarization: {
            enabled: true,
            modelTier: 'fast',
            maxTokens: 150,
          },
          // questionSynthesis undefined → should get defaults
          // vision undefined → should get defaults
          // others undefined → should get defaults
        },
      },
    });

    const config = await resolveIndexLLMConfig(tenantId, partialIndex._id);

    // Defined use case uses custom config
    expect(config.useCases.progressiveSummarization.enabled).toBe(true);
    expect(config.useCases.progressiveSummarization.modelTier).toBe('fast');
    expect(config.useCases.progressiveSummarization.maxTokens).toBe(150);

    // Undefined use cases get smart defaults (not disabled!)
    expect(config.useCases.questionSynthesis.enabled).toBe(true);
    expect(config.useCases.questionSynthesis.modelTier).toBe('fast'); // Default is fast, not balanced
    expect(config.useCases.vision.enabled).toBe(true); // Vision is enabled by default (enterprise feature)
    expect(config.useCases.vision.modelTier).toBe('balanced'); // Uses balanced tier for quality
  });
});

// =============================================================================
// Test Suite 4: Multiple Indexes with Different Configs
// =============================================================================

describe('Multiple Indexes with Different Configs', () => {
  it('should maintain separate configs for dev vs prod indexes', async () => {
    // Create dev index (fast, cheap)
    const devIndex = await createTestIndex({
      slug: 'dev-index',
      name: 'Development Index',
      llmConfig: {
        enabled: true,
        useCases: {
          progressiveSummarization: {
            enabled: true,
            modelTier: 'fast',
            maxTokens: 150,
          },
          questionSynthesis: {
            enabled: false, // Disabled in dev
          },
          vision: {
            enabled: false, // Disabled in dev
          },
        },
      },
    });

    // Create prod index (balanced, feature-rich)
    const prodIndex = await createTestIndex({
      slug: 'prod-index',
      name: 'Production Index',
      llmConfig: {
        enabled: true,
        useCases: {
          progressiveSummarization: {
            enabled: true,
            modelTier: 'balanced',
            maxTokens: 300,
            enableDocumentSummary: true,
          },
          questionSynthesis: {
            enabled: true,
            modelTier: 'balanced',
            questionsPerChunk: 3,
          },
          vision: {
            enabled: true,
            modelTier: 'balanced',
          },
        },
      },
    });

    // Verify dev config
    const devConfig = await resolveIndexLLMConfig(tenantId, devIndex._id);
    expect(devConfig.useCases.progressiveSummarization.modelTier).toBe('fast');
    expect(devConfig.useCases.progressiveSummarization.maxTokens).toBe(150);
    expect(devConfig.useCases.questionSynthesis.enabled).toBe(false);
    expect(devConfig.useCases.vision.enabled).toBe(false);

    // Verify prod config
    const prodConfig = await resolveIndexLLMConfig(tenantId, prodIndex._id);
    expect(prodConfig.useCases.progressiveSummarization.modelTier).toBe('balanced');
    expect(prodConfig.useCases.progressiveSummarization.maxTokens).toBe(300);
    expect(prodConfig.useCases.progressiveSummarization.enableDocumentSummary).toBe(true);
    expect(prodConfig.useCases.questionSynthesis.enabled).toBe(true);
    expect(prodConfig.useCases.vision.enabled).toBe(true);

    // Configs should be completely independent
    expect(devConfig.useCases.progressiveSummarization.modelTier).not.toBe(
      prodConfig.useCases.progressiveSummarization.modelTier,
    );
  });
});
