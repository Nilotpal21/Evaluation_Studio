/**
 * Model Catalog Service Tests
 *
 * Tests for the hybrid model catalog (built-in + LiteLLM data + gateway).
 */

import { describe, test, expect } from 'vitest';
import { ModelCatalogService } from '../services/llm/model-catalog';

describe('ModelCatalogService', () => {
  describe('initialization', () => {
    test('should have built-in models after initialization', () => {
      const catalog = new ModelCatalogService();
      const models = catalog.listModels();

      expect(models.length).toBeGreaterThan(0);

      // Should have Anthropic models
      const anthropicModels = models.filter((m) => m.provider === 'anthropic');
      expect(anthropicModels.length).toBeGreaterThan(0);

      // Should have OpenAI models
      const openaiModels = models.filter((m) => m.provider === 'openai');
      expect(openaiModels.length).toBeGreaterThan(0);

      // Should expose Microsoft Foundry as a top-level browse provider
      const foundryModels = models.filter((m) => m.provider === 'microsoft_foundry_anthropic');
      expect(foundryModels.length).toBeGreaterThan(0);
    });

    test('should NOT include KNOWN_MODEL_CAPABILITIES in browsable catalog', () => {
      const catalog = new ModelCatalogService();

      // KNOWN_MODEL_CAPABILITIES entries use "provider/model" keys without date
      // suffixes — they are internal capability lookups, not valid browsable models.
      const opus = catalog.getModel('anthropic/claude-3-opus');
      expect(opus).toBeUndefined();

      // But the correct dated versions should be present from BUILT_IN_MODELS
      const opusCorrect = catalog.getModel('claude-opus-4-20250514');
      expect(opusCorrect).toBeDefined();
      expect(opusCorrect!.source).toBe('platform');
    });
  });

  describe('listModels', () => {
    test('should filter by provider', () => {
      const catalog = new ModelCatalogService();

      const anthropicModels = catalog.listModels({ provider: 'anthropic' });
      expect(anthropicModels.every((m) => m.provider === 'anthropic')).toBe(true);

      const openaiModels = catalog.listModels({ provider: 'openai' });
      expect(openaiModels.every((m) => m.provider === 'openai')).toBe(true);

      const foundryModels = catalog.listModels({ provider: 'microsoft_foundry_anthropic' });
      expect(foundryModels).toHaveLength(4);
      expect(foundryModels.every((m) => m.provider === 'microsoft_foundry_anthropic')).toBe(true);
      expect(foundryModels.map((m) => m.modelId)).toContain(
        'microsoft_foundry_anthropic/claude-opus-4-7',
      );
    });

    test('treats google and gemini as provider aliases when filtering', () => {
      const catalog = new ModelCatalogService();

      const geminiModels = catalog.listModels({ provider: 'gemini' });
      const googleModels = catalog.listModels({ provider: 'google' });

      expect(geminiModels.length).toBeGreaterThan(0);
      expect(geminiModels.map((model) => model.modelId)).toEqual(
        googleModels.map((model) => model.modelId),
      );
      expect(geminiModels.every((model) => model.provider === 'google')).toBe(true);
    });

    test('should return sorted by display name', () => {
      const catalog = new ModelCatalogService();
      const models = catalog.listModels();

      for (let i = 1; i < models.length; i++) {
        expect(
          models[i].displayName.localeCompare(models[i - 1].displayName),
        ).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('getModel', () => {
    test('should return model details for known model', () => {
      const catalog = new ModelCatalogService();
      const model = catalog.getModel('claude-sonnet-4-20250514');

      expect(model).toBeDefined();
      expect(model!.modelId).toBe('claude-sonnet-4-20250514');
      expect(model!.provider).toBe('anthropic');
      expect(model!.capabilities.supportsTools).toBe(true);
      expect(model!.pricing).toBeDefined();
    });

    test('should return undefined for unknown model', () => {
      const catalog = new ModelCatalogService();
      const model = catalog.getModel('nonexistent-model-xyz');

      expect(model).toBeUndefined();
    });
  });

  describe('loadLiteLLMData', () => {
    test('should add LiteLLM models to catalog', () => {
      const catalog = new ModelCatalogService();
      const initialCount = catalog.listModels().length;

      catalog.loadLiteLLMData({
        'custom/test-model': {
          max_tokens: 4096,
          max_input_tokens: 4096,
          input_cost_per_token: 0.001,
          output_cost_per_token: 0.002,
          litellm_provider: 'custom',
          mode: 'chat',
          supports_function_calling: true,
          supports_vision: false,
          supports_streaming: true,
        },
      });

      const newCount = catalog.listModels().length;
      expect(newCount).toBeGreaterThan(initialCount);

      const customModel = catalog.getModel('custom/test-model');
      expect(customModel).toBeDefined();
      expect(customModel!.source).toBe('litellm_data');
      expect(customModel!.capabilities.supportsTools).toBe(true);
      expect(customModel!.pricing).toBeDefined();
      expect(customModel!.pricing!.inputCostPer1k).toBe(1); // 0.001 * 1000
      expect(customModel!.pricing!.outputCostPer1k).toBe(2); // 0.002 * 1000
    });

    test('should not overwrite platform models with LiteLLM data', () => {
      const catalog = new ModelCatalogService();

      // claude-sonnet-4-20250514 is a built-in platform model
      const beforeModel = catalog.getModel('claude-sonnet-4-20250514');
      expect(beforeModel!.source).toBe('platform');

      catalog.loadLiteLLMData({
        'claude-sonnet-4-20250514': {
          max_tokens: 1,
          litellm_provider: 'anthropic',
          mode: 'chat',
        },
      });

      const afterModel = catalog.getModel('claude-sonnet-4-20250514');
      expect(afterModel!.source).toBe('platform'); // Still platform, not overwritten
    });

    test('should skip non-chat models', () => {
      const catalog = new ModelCatalogService();
      const initialCount = catalog.listModels().length;

      catalog.loadLiteLLMData({
        'custom/embedding-model': {
          litellm_provider: 'custom',
          mode: 'embedding',
        },
      });

      expect(catalog.listModels().length).toBe(initialCount);
      expect(catalog.getModel('custom/embedding-model')).toBeUndefined();
    });

    test('should skip sample_spec entry', () => {
      const catalog = new ModelCatalogService();
      const initialCount = catalog.listModels().length;

      catalog.loadLiteLLMData({
        sample_spec: {
          litellm_provider: 'sample',
          mode: 'chat',
        } as any,
      });

      expect(catalog.listModels().length).toBe(initialCount);
    });
  });

  describe('needsRefresh', () => {
    test('should not need refresh immediately after creation', () => {
      const catalog = new ModelCatalogService();
      expect(catalog.needsRefresh()).toBe(false);
    });
  });
});
