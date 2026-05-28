/**
 * LLM Config API Integration Tests
 *
 * Tests SearchIndex LLM configuration endpoints:
 * - GET /:indexId (with resolvedLLMConfig)
 * - PATCH /:indexId/llm-config
 * - GET /llm-config/use-cases
 * - GET /llm-config/tiers
 */

import { describe, test, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import indexesRouter from '../routes/indexes.js';
import { SearchIndex, TenantLLMPolicy, LLMCredential } from '@agent-platform/database/models';
import { WorkerLLMClient } from '@agent-platform/llm';
import {
  resolveIndexLLMConfig,
  resolveEnhancedIndexLLMConfig,
} from '../services/llm-config/resolver.js';

// Mock dependencies - must mock the same path that routes import from
vi.mock('@agent-platform/database/models', () => ({
  SearchIndex: {
    find: vi.fn(),
    findOne: vi.fn(),
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findByIdAndDelete: vi.fn(),
    findOneAndDelete: vi.fn(),
    create: vi.fn(),
  },
  TenantLLMPolicy: {
    findOne: vi.fn(),
    create: vi.fn(),
  },
  LLMCredential: {
    findOne: vi.fn(),
  },
}));

// Mock db/index.js so getLazyModel returns mocked SearchIndex from above
vi.mock('../db/index.js', async () => {
  const models = await import('@agent-platform/database/models');
  return {
    getLazyModel: (modelName: string) => {
      if (modelName === 'SearchIndex') return models.SearchIndex;
      return models.SearchIndex;
    },
    getModel: (modelName: string) => {
      if (modelName === 'SearchIndex') return models.SearchIndex;
      return models.SearchIndex;
    },
    isDatabaseAvailable: () => true,
  };
});

vi.mock('@agent-platform/llm', () => {
  class MockWorkerLLMClient {
    getModelForTier(tier: string): string {
      const models: Record<string, string> = {
        fast: 'claude-haiku-4-5-20251022',
        balanced: 'claude-sonnet-4-5-20250514',
        powerful: 'claude-opus-4-7',
      };
      return models[tier] || 'claude-haiku-4-5-20251022';
    }
  }

  return {
    WorkerLLMClient: MockWorkerLLMClient,
  };
});

// Mock the resolver to avoid complex dependency chain
vi.mock('../services/llm-config/resolver.js', () => ({
  resolveIndexLLMConfig: vi.fn(),
  resolveEnhancedIndexLLMConfig: vi.fn(),
}));

// =============================================================================
// Test App Setup
// =============================================================================

let app: Express;

beforeAll(() => {
  app = express();
  app.use(express.json());

  // Mock tenant context middleware
  app.use((req, _res, next) => {
    req.tenantContext = {
      tenantId: 'tenant-123',
      userId: 'user-456',
      roles: ['admin'],
    } as any;
    next();
  });

  app.use('/api/search/indexes', indexesRouter);
});

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
};

const mockCredential = {
  tenantId: 'tenant-123',
  provider: 'anthropic',
  encryptedApiKey: 'test-api-key', // Auto-decrypted by mongoose plugin
  isActive: true,
  isDefault: true,
};

const mockIndex = {
  _id: 'index-456',
  tenantId: 'tenant-123',
  projectId: 'project-789',
  slug: 'test-index',
  name: 'Test Index',
  embeddingModel: 'bge-m3',
  embeddingDimensions: 1024,
  llmConfig: null,
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

// =============================================================================
// Setup and Teardown
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(TenantLLMPolicy.findOne).mockResolvedValue(mockTenantPolicy as any);
  vi.mocked(LLMCredential.findOne).mockResolvedValue(mockCredential as any);

  // Mock SearchIndex with chainable query methods (critical for Mongoose queries)
  // Routes call: await SearchIndex.findOne({ _id, tenantId }).lean()
  // So mock must return object with .lean() method
  vi.mocked(SearchIndex.findById).mockReturnValue({
    lean: vi.fn().mockResolvedValue(mockIndex),
  } as any);

  vi.mocked(SearchIndex.findOne).mockReturnValue({
    lean: vi.fn().mockResolvedValue(mockIndex),
  } as any);

  vi.mocked(SearchIndex.find).mockReturnValue({
    sort: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue([mockIndex]),
    }),
  } as any);

  vi.mocked(SearchIndex.findByIdAndUpdate).mockReturnValue({
    lean: vi.fn().mockResolvedValue(mockIndex),
  } as any);

  vi.mocked(SearchIndex.findOneAndUpdate).mockReturnValue({
    lean: vi.fn().mockResolvedValue(mockIndex),
  } as any);

  vi.mocked(SearchIndex.findByIdAndDelete).mockReturnValue({
    lean: vi.fn().mockResolvedValue(mockIndex),
  } as any);

  vi.mocked(SearchIndex.findOneAndDelete).mockReturnValue({
    lean: vi.fn().mockResolvedValue(mockIndex),
  } as any);

  vi.mocked(SearchIndex.create).mockResolvedValue(mockIndex as any);

  // Mock resolved LLM config
  vi.mocked(resolveIndexLLMConfig).mockResolvedValue({
    tenantId: 'tenant-123',
    provider: 'anthropic',
    apiKey: 'test-key',
    monthlyTokenBudget: 10_000_000,
    dailyTokenBudget: 500_000,
    maxRequestsPerMinute: 100,
    allowedProviders: ['anthropic', 'openai', 'gemini'],
    indexId: 'index-456',
    embeddingModel: 'bge-m3',
    embeddingDimensions: 1024,
    useCases: {
      progressiveSummarization: {
        enabled: true,
        modelTier: 'fast',
        model: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        maxTokens: 300,
      },
      questionSynthesis: {
        enabled: true,
        modelTier: 'fast', // Default is fast, not balanced
        model: 'claude-haiku-4-5-20251001', // Fast tier = Haiku
        provider: 'anthropic',
        maxTokens: 150,
      },
      vision: {
        enabled: false, // Disabled by default (opt-in)
        modelTier: 'balanced',
        model: 'claude-sonnet-4-5-20251001',
        provider: 'anthropic',
        maxTokens: 500,
      },
      multimodal: {
        enabled: true,
        modelTier: 'balanced',
        model: 'claude-sonnet-4-5-20251001',
        provider: 'anthropic',
        maxTokens: 500,
      },
      knowledgeGraph: {
        enabled: true,
        modelTier: 'powerful',
        model: 'claude-opus-4-7',
        provider: 'anthropic',
        maxTokens: 1000,
      },
      scopeClassification: {
        enabled: true,
        modelTier: 'fast',
        model: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        maxTokens: 200,
      },
    },
  } as any);

  // Mock enhanced LLM config (used by PATCH endpoint)
  vi.mocked(resolveEnhancedIndexLLMConfig).mockResolvedValue({
    tenantId: 'tenant-123',
    indexId: 'index-456',
    provider: 'anthropic',
    useCases: {
      progressiveSummarization: {
        enabled: true,
        modelTier: 'fast',
        model: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        maxTokens: 300,
        status: 'active',
      },
      questionSynthesis: {
        enabled: true,
        modelTier: 'fast',
        model: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        maxTokens: 150,
        status: 'active',
      },
      vision: {
        enabled: false,
        modelTier: 'balanced',
        model: 'claude-sonnet-4-5-20251001',
        provider: 'anthropic',
        maxTokens: 500,
        status: 'pending',
      },
      multimodal: {
        enabled: true,
        modelTier: 'balanced',
        model: 'claude-sonnet-4-5-20251001',
        provider: 'anthropic',
        maxTokens: 500,
        status: 'active',
      },
      knowledgeGraph: {
        enabled: true,
        modelTier: 'powerful',
        model: 'claude-opus-4-7',
        provider: 'anthropic',
        maxTokens: 1000,
        status: 'active',
      },
      scopeClassification: {
        enabled: true,
        modelTier: 'fast',
        model: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        maxTokens: 200,
        status: 'active',
      },
    },
  } as any);
});

// =============================================================================
// GET /:indexId - With Resolved LLM Config
// =============================================================================

describe('GET /:indexId', () => {
  test('returns index with resolved LLM config', async () => {
    const response = await request(app).get('/api/search/indexes/index-456').expect(200);

    expect(response.body).toHaveProperty('index');
    expect(response.body).toHaveProperty('resolvedLLMConfig');

    expect(response.body.index._id).toBe('index-456');
    expect(response.body.resolvedLLMConfig.tenantId).toBe('tenant-123');
    expect(response.body.resolvedLLMConfig.provider).toBe('anthropic');
  });

  test('resolved config includes all use cases', async () => {
    const response = await request(app).get('/api/search/indexes/index-456').expect(200);

    const { useCases } = response.body.resolvedLLMConfig;
    expect(useCases).toHaveProperty('progressiveSummarization');
    expect(useCases).toHaveProperty('questionSynthesis');
    expect(useCases).toHaveProperty('vision');
    expect(useCases).toHaveProperty('multimodal');
    expect(useCases).toHaveProperty('knowledgeGraph');
    expect(useCases).toHaveProperty('scopeClassification');
  });

  test('use cases have resolved model names', async () => {
    const response = await request(app).get('/api/search/indexes/index-456').expect(200);

    const { useCases } = response.body.resolvedLLMConfig;
    expect(useCases.progressiveSummarization.model).toBe('claude-haiku-4-5-20251001');
    expect(useCases.vision.model).toBe('claude-sonnet-4-5-20251001');
  });

  test('returns 404 if index not found', async () => {
    vi.mocked(SearchIndex.findById).mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    } as any);
    vi.mocked(SearchIndex.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    } as any);

    const response = await request(app).get('/api/search/indexes/nonexistent').expect(404);

    expect(response.body.error).toEqual({ code: 'INDEX_NOT_FOUND', message: 'Index not found' });
  });

  test('returns index without resolvedLLMConfig if resolution fails', async () => {
    // Make resolver throw error for this test
    vi.mocked(resolveIndexLLMConfig).mockRejectedValueOnce(new Error('DB error'));

    const response = await request(app).get('/api/search/indexes/index-456').expect(200);

    expect(response.body).toHaveProperty('index');
    expect(response.body.resolvedLLMConfig).toBeNull();
  });
});

// =============================================================================
// PATCH /:indexId/llm-config - Update LLM Configuration
// =============================================================================

describe('PATCH /:indexId/llm-config', () => {
  test('updates LLM config successfully', async () => {
    const updatedIndex = {
      ...mockIndex,
      llmConfig: {
        enabled: true,
        useCases: {
          vision: {
            enabled: true,
            modelTier: 'balanced',
          },
        },
      },
    };

    vi.mocked(SearchIndex.findOneAndUpdate).mockReturnValue({
      lean: vi.fn().mockResolvedValue(updatedIndex),
    } as any);

    const response = await request(app)
      .patch('/api/search/indexes/index-456/llm-config')
      .send({
        enabled: true,
        useCases: {
          vision: {
            enabled: true,
            modelTier: 'balanced',
          },
        },
      })
      .expect(200);

    expect(response.body).toHaveProperty('index');
    expect(response.body).toHaveProperty('enhancedConfig');
    expect(response.body.message).toBe('LLM configuration updated successfully');

    expect(vi.mocked(SearchIndex.findOneAndUpdate)).toHaveBeenCalledWith(
      { _id: 'index-456', tenantId: 'tenant-123' },
      {
        $set: {
          llmConfig: {
            enabled: true,
            useCases: {
              vision: {
                enabled: true,
                modelTier: 'balanced',
              },
            },
          },
        },
      },
      { new: true, runValidators: true },
    );
  });

  test('validates LLM config structure', async () => {
    const response = await request(app)
      .patch('/api/search/indexes/index-456/llm-config')
      .send({
        useCases: {
          vision: {
            modelTier: 'invalid-tier', // Invalid tier
          },
        },
      })
      .expect(400);

    expect(response.body.error).toBe('Invalid LLM configuration');
    expect(response.body.details).toBeDefined();
  });

  test('returns 404 if index not found', async () => {
    vi.mocked(SearchIndex.findById).mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    } as any);
    vi.mocked(SearchIndex.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    } as any);

    const response = await request(app)
      .patch('/api/search/indexes/nonexistent/llm-config')
      .send({
        enabled: true,
      })
      .expect(404);

    expect(response.body.error).toEqual({ code: 'INDEX_NOT_FOUND', message: 'Index not found' });
  });

  test('allows partial updates', async () => {
    const updatedIndex = {
      ...mockIndex,
      llmConfig: {
        useCases: {
          progressiveSummarization: {
            maxTokens: 400,
          },
        },
      },
    };

    vi.mocked(SearchIndex.findById).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockIndex),
    } as any);
    vi.mocked(SearchIndex.findOneAndUpdate).mockReturnValue({
      lean: vi.fn().mockResolvedValue(updatedIndex),
    } as any);

    // Override resolver to return updated maxTokens
    vi.mocked(resolveEnhancedIndexLLMConfig).mockResolvedValueOnce({
      tenantId: 'tenant-123',
      indexId: 'index-456',
      enabled: true,
      embeddingModel: 'bge-m3',
      embeddingDimensions: 1024,
      policy: {
        monthlyTokenBudget: 10_000_000,
        dailyTokenBudget: 500_000,
        maxRequestsPerMinute: 100,
        allowedProviders: ['anthropic', 'openai', 'gemini'],
      },
      useCases: {
        progressiveSummarization: {
          enabled: true,
          modelTier: 'fast',
          model: 'claude-haiku-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 400, // Updated
          status: 'active',
        },
        questionSynthesis: {
          enabled: true,
          modelTier: 'balanced',
          model: 'claude-sonnet-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 500,
          status: 'active',
        },
        vision: {
          enabled: true,
          modelTier: 'balanced',
          model: 'claude-sonnet-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 500,
          status: 'active',
        },
        multimodal: {
          enabled: true,
          modelTier: 'balanced',
          model: 'claude-sonnet-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 500,
          status: 'active',
        },
        knowledgeGraph: {
          enabled: true,
          modelTier: 'powerful',
          model: 'claude-opus-4-7',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 1000,
          status: 'active',
        },
        scopeClassification: {
          enabled: true,
          modelTier: 'fast',
          model: 'claude-haiku-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 200,
          status: 'active',
        },
      },
    } as any);

    const response = await request(app)
      .patch('/api/search/indexes/index-456/llm-config')
      .send({
        useCases: {
          progressiveSummarization: {
            maxTokens: 400,
          },
        },
      })
      .expect(200);

    expect(response.body.enhancedConfig.useCases.progressiveSummarization.maxTokens).toBe(400);
    // Other fields should use defaults
    expect(response.body.enhancedConfig.useCases.progressiveSummarization.enabled).toBe(true);
    expect(response.body.enhancedConfig.useCases.progressiveSummarization.modelTier).toBe('fast');
  });

  test('validates use case-specific parameters', async () => {
    const response = await request(app)
      .patch('/api/search/indexes/index-456/llm-config')
      .send({
        useCases: {
          progressiveSummarization: {
            maxTokens: 5000, // Exceeds max (1000)
          },
        },
      })
      .expect(400);

    expect(response.body.error).toBe('Invalid LLM configuration');
  });

  test('validates questionsPerChunk range', async () => {
    const response = await request(app)
      .patch('/api/search/indexes/index-456/llm-config')
      .send({
        useCases: {
          questionSynthesis: {
            questionsPerChunk: 15, // Exceeds max (10)
          },
        },
      })
      .expect(400);

    expect(response.body.error).toBe('Invalid LLM configuration');
  });

  test('returns resolved config after update', async () => {
    const updatedIndex = {
      ...mockIndex,
      llmConfig: {
        useCases: {
          vision: {
            enabled: true,
            modelTier: 'powerful',
          },
        },
      },
    };

    vi.mocked(SearchIndex.findById).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockIndex),
    } as any);
    vi.mocked(SearchIndex.findOneAndUpdate).mockReturnValue({
      lean: vi.fn().mockResolvedValue(updatedIndex),
    } as any);

    // Override resolver to return vision with powerful tier
    vi.mocked(resolveEnhancedIndexLLMConfig).mockResolvedValueOnce({
      tenantId: 'tenant-123',
      indexId: 'index-456',
      enabled: true,
      embeddingModel: 'bge-m3',
      embeddingDimensions: 1024,
      policy: {
        monthlyTokenBudget: 10_000_000,
        dailyTokenBudget: 500_000,
        maxRequestsPerMinute: 100,
        allowedProviders: ['anthropic', 'openai', 'gemini'],
      },
      useCases: {
        progressiveSummarization: {
          enabled: true,
          modelTier: 'fast',
          model: 'claude-haiku-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 300,
          status: 'active',
        },
        questionSynthesis: {
          enabled: true,
          modelTier: 'balanced',
          model: 'claude-sonnet-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 500,
          status: 'active',
        },
        vision: {
          enabled: true,
          modelTier: 'powerful', // Upgraded
          model: 'claude-opus-4-7', // Upgraded
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 500,
          status: 'active',
        },
        multimodal: {
          enabled: true,
          modelTier: 'balanced',
          model: 'claude-sonnet-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 500,
          status: 'active',
        },
        knowledgeGraph: {
          enabled: true,
          modelTier: 'powerful',
          model: 'claude-opus-4-7',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 1000,
          status: 'active',
        },
        scopeClassification: {
          enabled: true,
          modelTier: 'fast',
          model: 'claude-haiku-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 200,
          status: 'active',
        },
      },
    } as any);

    const response = await request(app)
      .patch('/api/search/indexes/index-456/llm-config')
      .send({
        useCases: {
          vision: {
            enabled: true,
            modelTier: 'powerful',
          },
        },
      })
      .expect(200);

    expect(response.body.enhancedConfig.useCases.vision.modelTier).toBe('powerful');
    expect(response.body.enhancedConfig.useCases.vision.model).toBe('claude-opus-4-7');
    expect(response.body.enhancedConfig.useCases.vision.enabled).toBe(true);
  });
});

// =============================================================================
// GET /llm-config/use-cases - List Available Use Cases
// =============================================================================

describe('GET /llm-config/use-cases', () => {
  test('returns list of all use cases with defaults', async () => {
    const response = await request(app).get('/api/search/indexes/llm-config/use-cases').expect(200);

    expect(response.body).toHaveProperty('useCases');
    expect(response.body).toHaveProperty('total');
    expect(response.body.useCases).toBeInstanceOf(Array);
    expect(response.body.useCases.length).toBeGreaterThan(0);
  });

  test('each use case has complete metadata', async () => {
    const response = await request(app).get('/api/search/indexes/llm-config/use-cases').expect(200);

    for (const useCase of response.body.useCases) {
      expect(useCase).toHaveProperty('name');
      expect(useCase).toHaveProperty('enabled');
      expect(useCase).toHaveProperty('modelTier');
      expect(useCase).toHaveProperty('description');
      expect(useCase).toHaveProperty('rationale');
      expect(useCase).toHaveProperty('costRating');
      expect(useCase).toHaveProperty('volumeEstimate');
    }
  });

  test('includes progressiveSummarization', async () => {
    const response = await request(app).get('/api/search/indexes/llm-config/use-cases').expect(200);

    const progressiveSummarization = response.body.useCases.find(
      (uc: any) => uc.name === 'progressiveSummarization',
    );

    expect(progressiveSummarization).toBeDefined();
    expect(progressiveSummarization.enabled).toBe(true);
    expect(progressiveSummarization.modelTier).toBe('fast');
    expect(progressiveSummarization.costRating).toBe(2);
    expect(progressiveSummarization.volumeEstimate).toBe('high');
  });

  test('includes vision', async () => {
    const response = await request(app).get('/api/search/indexes/llm-config/use-cases').expect(200);

    const vision = response.body.useCases.find((uc: any) => uc.name === 'vision');

    expect(vision).toBeDefined();
    expect(vision.enabled).toBe(true); // Vision is enabled by default (enterprise feature)
    expect(vision.modelTier).toBe('balanced');
    expect(vision.costRating).toBe(8);
    expect(vision.volumeEstimate).toBe('medium');
  });

  test('total matches array length', async () => {
    const response = await request(app).get('/api/search/indexes/llm-config/use-cases').expect(200);

    expect(response.body.total).toBe(response.body.useCases.length);
  });
});

// =============================================================================
// GET /llm-config/tiers - List Available Model Tiers
// =============================================================================

describe('GET /llm-config/tiers', () => {
  test('returns tier information with model names', async () => {
    const response = await request(app).get('/api/search/indexes/llm-config/tiers').expect(200);

    expect(response.body).toHaveProperty('provider');
    expect(response.body).toHaveProperty('tiers');
    expect(response.body.tiers).toHaveProperty('fast');
    expect(response.body.tiers).toHaveProperty('balanced');
    expect(response.body.tiers).toHaveProperty('powerful');
  });

  test('each tier has complete information', async () => {
    const response = await request(app).get('/api/search/indexes/llm-config/tiers').expect(200);

    for (const [tierName, tier] of Object.entries(response.body.tiers) as [string, any][]) {
      expect(tier.tier).toBe(tierName);
      expect(tier.model).toBeTruthy();
      expect(tier.description).toBeTruthy();
      expect(tier.costMultiplier).toBeGreaterThan(0);
    }
  });

  test('defaults to anthropic provider', async () => {
    const response = await request(app).get('/api/search/indexes/llm-config/tiers').expect(200);

    expect(response.body.provider).toBe('anthropic');
    expect(response.body.tiers.fast.model).toBe('claude-haiku-4-5-20251022');
    expect(response.body.tiers.balanced.model).toBe('claude-sonnet-4-5-20250514');
    expect(response.body.tiers.powerful.model).toBe('claude-opus-4-7');
  });

  test('accepts provider query parameter', async () => {
    const response = await request(app)
      .get('/api/search/indexes/llm-config/tiers')
      .query({ provider: 'openai' })
      .expect(200);

    expect(response.body.provider).toBe('openai');
  });

  test('cost multipliers increase with tier', async () => {
    const response = await request(app).get('/api/search/indexes/llm-config/tiers').expect(200);

    const fastCost = response.body.tiers.fast.costMultiplier;
    const balancedCost = response.body.tiers.balanced.costMultiplier;
    const powerfulCost = response.body.tiers.powerful.costMultiplier;

    expect(balancedCost).toBeGreaterThan(fastCost);
    expect(powerfulCost).toBeGreaterThan(balancedCost);
  });

  test('requires tenant context', async () => {
    // Create app without tenant context middleware
    const appNoAuth = express();
    appNoAuth.use(express.json());
    appNoAuth.use('/api/search/indexes', indexesRouter);

    const response = await request(appNoAuth)
      .get('/api/search/indexes/llm-config/tiers')
      .expect(401);

    expect(response.body.error).toEqual({
      code: 'TENANT_REQUIRED',
      message: 'Tenant context required',
    });
  });
});

// =============================================================================
// Integration Scenarios
// =============================================================================

describe('integration scenarios', () => {
  test('user can enable vision and verify resolved config', async () => {
    // Step 1: Get initial state (vision disabled by default)
    let response = await request(app).get('/api/search/indexes/index-456').expect(200);
    expect(response.body.resolvedLLMConfig.useCases.vision.enabled).toBe(false);

    // Step 2: Enable vision with balanced tier
    const updatedIndex = {
      ...mockIndex,
      llmConfig: {
        useCases: {
          vision: {
            enabled: true,
            modelTier: 'balanced',
          },
        },
      },
    };
    vi.mocked(SearchIndex.findById).mockReturnValue({
      lean: vi.fn().mockResolvedValue(updatedIndex),
    } as any);
    vi.mocked(SearchIndex.findOneAndUpdate).mockReturnValue({
      lean: vi.fn().mockResolvedValue(updatedIndex),
    } as any);

    // Override resolver to return vision enabled
    vi.mocked(resolveEnhancedIndexLLMConfig).mockResolvedValueOnce({
      tenantId: 'tenant-123',
      indexId: 'index-456',
      enabled: true,
      embeddingModel: 'bge-m3',
      embeddingDimensions: 1024,
      policy: {
        monthlyTokenBudget: 10_000_000,
        dailyTokenBudget: 500_000,
        maxRequestsPerMinute: 100,
        allowedProviders: ['anthropic', 'openai', 'gemini'],
      },
      useCases: {
        progressiveSummarization: {
          enabled: true,
          modelTier: 'fast',
          model: 'claude-haiku-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 300,
          status: 'active',
        },
        questionSynthesis: {
          enabled: true,
          modelTier: 'balanced',
          model: 'claude-sonnet-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 500,
          status: 'active',
        },
        vision: {
          enabled: true, // Changed
          modelTier: 'balanced',
          model: 'claude-sonnet-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 500,
          status: 'active',
        },
        multimodal: {
          enabled: true,
          modelTier: 'balanced',
          model: 'claude-sonnet-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 500,
          status: 'active',
        },
        knowledgeGraph: {
          enabled: true,
          modelTier: 'powerful',
          model: 'claude-opus-4-7',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 1000,
          status: 'active',
        },
        scopeClassification: {
          enabled: true,
          modelTier: 'fast',
          model: 'claude-haiku-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 200,
          status: 'active',
        },
      },
    } as any);

    response = await request(app)
      .patch('/api/search/indexes/index-456/llm-config')
      .send({
        useCases: {
          vision: {
            enabled: true,
            modelTier: 'balanced',
          },
        },
      })
      .expect(200);

    // Step 3: Verify vision is enabled with correct model
    expect(response.body.enhancedConfig.useCases.vision.enabled).toBe(true);
    expect(response.body.enhancedConfig.useCases.vision.modelTier).toBe('balanced');
    expect(response.body.enhancedConfig.useCases.vision.model).toBe('claude-sonnet-4-5-20251001');
  });

  test('user can upgrade use case to powerful tier', async () => {
    const updatedIndex = {
      ...mockIndex,
      llmConfig: {
        useCases: {
          progressiveSummarization: {
            modelTier: 'powerful',
          },
        },
      },
    };
    vi.mocked(SearchIndex.findById).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockIndex),
    } as any);
    vi.mocked(SearchIndex.findOneAndUpdate).mockReturnValue({
      lean: vi.fn().mockResolvedValue(updatedIndex),
    } as any);

    // Override resolver to return powerful tier
    vi.mocked(resolveEnhancedIndexLLMConfig).mockResolvedValueOnce({
      tenantId: 'tenant-123',
      indexId: 'index-456',
      enabled: true,
      embeddingModel: 'bge-m3',
      embeddingDimensions: 1024,
      policy: {
        monthlyTokenBudget: 10_000_000,
        dailyTokenBudget: 500_000,
        maxRequestsPerMinute: 100,
        allowedProviders: ['anthropic', 'openai', 'gemini'],
      },
      useCases: {
        progressiveSummarization: {
          enabled: true,
          modelTier: 'powerful',
          model: 'claude-opus-4-7',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 300,
          status: 'active',
        },
        questionSynthesis: {
          enabled: true,
          modelTier: 'balanced',
          model: 'claude-sonnet-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 500,
          status: 'active',
        },
        vision: {
          enabled: true,
          modelTier: 'balanced',
          model: 'claude-sonnet-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 500,
          status: 'active',
        },
        multimodal: {
          enabled: true,
          modelTier: 'balanced',
          model: 'claude-sonnet-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 500,
          status: 'active',
        },
        knowledgeGraph: {
          enabled: true,
          modelTier: 'powerful',
          model: 'claude-opus-4-7',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 1000,
          status: 'active',
        },
        scopeClassification: {
          enabled: true,
          modelTier: 'fast',
          model: 'claude-haiku-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 200,
          status: 'active',
        },
      },
    } as any);

    const response = await request(app)
      .patch('/api/search/indexes/index-456/llm-config')
      .send({
        useCases: {
          progressiveSummarization: {
            modelTier: 'powerful',
          },
        },
      })
      .expect(200);

    expect(response.body.enhancedConfig.useCases.progressiveSummarization.modelTier).toBe(
      'powerful',
    );
    expect(response.body.enhancedConfig.useCases.progressiveSummarization.model).toBe(
      'claude-opus-4-7',
    );
    // Other parameters should retain defaults
    expect(response.body.enhancedConfig.useCases.progressiveSummarization.enabled).toBe(true);
    expect(response.body.enhancedConfig.useCases.progressiveSummarization.maxTokens).toBe(300);
  });

  test('user can customize maxTokens while keeping default tier', async () => {
    const updatedIndex = {
      ...mockIndex,
      llmConfig: {
        useCases: {
          questionSynthesis: {
            maxTokens: 200,
            questionsPerChunk: 5,
          },
        },
      },
    };
    vi.mocked(SearchIndex.findById).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockIndex),
    } as any);
    vi.mocked(SearchIndex.findOneAndUpdate).mockReturnValue({
      lean: vi.fn().mockResolvedValue(updatedIndex),
    } as any);

    // Override resolver to return customized maxTokens
    vi.mocked(resolveEnhancedIndexLLMConfig).mockResolvedValueOnce({
      tenantId: 'tenant-123',
      indexId: 'index-456',
      enabled: true,
      embeddingModel: 'bge-m3',
      embeddingDimensions: 1024,
      policy: {
        monthlyTokenBudget: 10_000_000,
        dailyTokenBudget: 500_000,
        maxRequestsPerMinute: 100,
        allowedProviders: ['anthropic', 'openai', 'gemini'],
      },
      useCases: {
        progressiveSummarization: {
          enabled: true,
          modelTier: 'fast',
          model: 'claude-haiku-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 300,
          status: 'active',
        },
        questionSynthesis: {
          enabled: true,
          modelTier: 'fast', // Default tier preserved
          model: 'claude-haiku-4-5-20251001', // Fast tier model
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 200, // Customized
          questionsPerChunk: 5, // Customized
          enableEmbedding: true,
          enableDocumentQuestions: true,
          documentQuestionsCount: 5,
          status: 'active',
        },
        vision: {
          enabled: true,
          modelTier: 'balanced',
          model: 'claude-sonnet-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 500,
          status: 'active',
        },
        multimodal: {
          enabled: true,
          modelTier: 'balanced',
          model: 'claude-sonnet-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 500,
          status: 'active',
        },
        knowledgeGraph: {
          enabled: true,
          modelTier: 'powerful',
          model: 'claude-opus-4-7',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 1000,
          status: 'active',
        },
        scopeClassification: {
          enabled: true,
          modelTier: 'fast',
          model: 'claude-haiku-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'test-key',
          maxTokens: 200,
          status: 'active',
        },
      },
    } as any);

    const response = await request(app)
      .patch('/api/search/indexes/index-456/llm-config')
      .send({
        useCases: {
          questionSynthesis: {
            maxTokens: 200,
            questionsPerChunk: 5,
          },
        },
      })
      .expect(200);

    expect(response.body.enhancedConfig.useCases.questionSynthesis.maxTokens).toBe(200);
    expect(response.body.enhancedConfig.useCases.questionSynthesis.questionsPerChunk).toBe(5);
    // Default tier preserved
    expect(response.body.enhancedConfig.useCases.questionSynthesis.modelTier).toBe('fast');
  });
});
