/**
 * Tests for the consolidated Model Registry — single source of truth.
 *
 * Validates:
 * - All 200 entries have required fields (displayName, contextWindow, maxOutputTokens)
 * - getBuiltInCatalog() returns correct shape for all entries
 * - getModelCapabilities() returns correct data via exact and family-prefix matching
 * - Reasoning, thinking, and streaming flags are correctly propagated
 * - Pricing data is preserved for curated models
 * - Provider-specific invariants hold across all entries
 */

import { describe, test, expect } from 'vitest';
import {
  MODEL_REGISTRY,
  MODEL_IDS,
  getBuiltInCatalog,
  modelSupportsResponsesApi,
  type ModelRegistryEntry,
  type CatalogModelData,
} from '../../platform/llm/model-registry.js';
import {
  getModelCapabilities,
  getModelRegistryEntry,
  getModelRegistryKey,
  getHyperParameters,
  isReasoningModel,
  supportsThinking,
  supportsReasoningEffort,
  getMaxOutputTokens,
  getContextWindow,
  inferModelProviderFromId,
  stripLeadingPlatformModelProviderPrefix,
} from '../../platform/llm/model-capabilities.js';

function collectHyperParameterIdentities(
  parameters: ModelRegistryEntry['hyperParameters'],
  names = new Set<string>(),
): Set<string> {
  for (const param of parameters) {
    names.add(param.name);
    names.add(param.unifiedParam);
    collectHyperParameterIdentities(param.options ?? [], names);
    collectHyperParameterIdentities(param.hyperParameters ?? [], names);
  }
  return names;
}

// =============================================================================
// REGISTRY STRUCTURAL INTEGRITY
// =============================================================================

describe('MODEL_REGISTRY structural integrity', () => {
  test('contains exactly 209 entries', () => {
    expect(Object.keys(MODEL_REGISTRY).length).toBe(209);
    expect(MODEL_IDS.length).toBe(209);
  });

  test('every entry has required fields', () => {
    for (const [modelId, entry] of Object.entries(MODEL_REGISTRY)) {
      expect(entry.provider, `${modelId} missing provider`).toBeTruthy();
      expect(typeof entry.displayName, `${modelId} displayName not string`).toBe('string');
      expect(entry.displayName.length, `${modelId} displayName empty`).toBeGreaterThan(0);
      expect(typeof entry.contextWindow, `${modelId} contextWindow not number`).toBe('number');
      expect(entry.contextWindow, `${modelId} contextWindow <= 0`).toBeGreaterThan(0);
      expect(typeof entry.maxOutputTokens, `${modelId} maxOutputTokens not number`).toBe('number');
      // maxOutputTokens can be 0 for embedding models
      expect(entry.maxOutputTokens, `${modelId} maxOutputTokens < 0`).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(entry.hyperParameters), `${modelId} hyperParameters not array`).toBe(
        true,
      );
      expect(Array.isArray(entry.capabilities), `${modelId} capabilities not array`).toBe(true);
      expect(typeof entry.supportsTools, `${modelId} supportsTools not boolean`).toBe('boolean');
      expect(
        typeof entry.supportsParallelToolCalls,
        `${modelId} supportsParallelToolCalls not boolean`,
      ).toBe('boolean');
      expect(
        typeof entry.supportsStructuredOutput,
        `${modelId} supportsStructuredOutput not boolean`,
      ).toBe('boolean');
    }
  });

  test('every displayName is unique (no accidental duplicates within same provider)', () => {
    const seen = new Map<string, string>();
    for (const [modelId, entry] of Object.entries(MODEL_REGISTRY)) {
      const key = `${entry.provider}::${entry.displayName}`;
      // Azure variants may share display names with their lowercase counterparts
      // but they have different providers, so the key is unique
      if (seen.has(key)) {
        // Allow same display name for different casings of same model (e.g. gpt-4 vs GPT-4 on azure)
        const existingId = seen.get(key)!;
        expect(
          modelId.toLowerCase() !== existingId.toLowerCase(),
          `Duplicate displayName "${entry.displayName}" for provider "${entry.provider}": ${existingId} vs ${modelId}`,
        ).toBe(true);
      }
      seen.set(key, modelId);
    }
  });

  test('pricing fields are valid when present', () => {
    for (const [modelId, entry] of Object.entries(MODEL_REGISTRY)) {
      if (entry.pricing) {
        expect(entry.pricing.inputCostPer1k, `${modelId} inputCostPer1k <= 0`).toBeGreaterThan(0);
        expect(entry.pricing.outputCostPer1k, `${modelId} outputCostPer1k <= 0`).toBeGreaterThan(0);
      }
    }
  });
});

// =============================================================================
// PROVIDER-SPECIFIC INVARIANTS
// =============================================================================

describe('Provider-specific invariants', () => {
  const groupedByProvider = new Map<string, [string, ModelRegistryEntry][]>();
  for (const [modelId, entry] of Object.entries(MODEL_REGISTRY)) {
    const provider = entry.provider;
    if (!groupedByProvider.has(provider)) groupedByProvider.set(provider, []);
    groupedByProvider.get(provider)!.push([modelId, entry]);
  }

  test('all known providers are represented', () => {
    const providers = new Set(Object.values(MODEL_REGISTRY).map((e) => e.provider));
    expect(providers.has('openai')).toBe(true);
    expect(providers.has('anthropic')).toBe(true);
    expect(providers.has('google')).toBe(true);
    expect(providers.has('cohere')).toBe(true);
    expect(providers.has('azure')).toBe(true);
  });

  test('all anthropic models have contextWindow=200000 or 1000000', () => {
    for (const [modelId, entry] of groupedByProvider.get('anthropic') ?? []) {
      expect(
        [200_000, 1_000_000].includes(entry.contextWindow),
        `${modelId} contextWindow should be 200k or 1M, got ${entry.contextWindow}`,
      ).toBe(true);
    }
  });

  test('all anthropic models support vision (imageToText)', () => {
    for (const [modelId, entry] of groupedByProvider.get('anthropic') ?? []) {
      expect(entry.capabilities, `${modelId} missing imageToText`).toContain('imageToText');
    }
  });

  test('anthropic thinking models have supportsThinking=true', () => {
    const thinkingModels = [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-opus-4-7',
      'claude-opus-4-1-20250805',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20251101',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-6-20260204',
      'claude-sonnet-4-6-20260217',
    ];
    for (const id of thinkingModels) {
      expect(MODEL_REGISTRY[id]?.supportsThinking, `${id} supportsThinking`).toBe(true);
    }
  });

  test('openai o-series models are reasoning models with temp/topP disabled', () => {
    const oSeries = [
      'o1',
      'o1-2024-12-17',
      'o3',
      'o3-2025-04-16',
      'o3-mini',
      'o3-mini-2025-01-31',
      'o4-mini',
      'o4-mini-2025-04-16',
    ];
    for (const id of oSeries) {
      expect(MODEL_REGISTRY[id]?.isReasoningModel, `${id} isReasoningModel`).toBe(true);
      expect(MODEL_REGISTRY[id]?.temperatureDisabled, `${id} temperatureDisabled`).toBe(true);
      expect(MODEL_REGISTRY[id]?.topPDisabled, `${id} topPDisabled`).toBe(true);
    }
  });

  test('openai gpt-5 family are reasoning models with supportsReasoningEffort', () => {
    const gpt5Family = [
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-5.1',
      'gpt-5.2',
      'gpt-5-2025-08-07',
      'gpt-5-nano-2025-08-07',
      'gpt-5-mini-2025-08-07',
      'gpt-5-chat-latest',
      'gpt-5.1-2025-11-13',
      'gpt-5.1-chat-latest',
      'gpt-5.2-2025-12-11',
      'gpt-5.2-chat-latest',
    ];
    for (const id of gpt5Family) {
      expect(MODEL_REGISTRY[id]?.isReasoningModel, `${id} isReasoningModel`).toBe(true);
      expect(MODEL_REGISTRY[id]?.supportsReasoningEffort, `${id} supportsReasoningEffort`).toBe(
        true,
      );
    }
  });

  test('gemini 2.5+ models have supportsThinkingBudget', () => {
    const thinkingBudgetModels = Object.entries(MODEL_REGISTRY)
      .filter(
        ([id, e]) =>
          e.provider === 'google' && (id.startsWith('gemini-2.5') || id.startsWith('gemini-3')),
      )
      .filter(([id]) => !id.includes('-vertex')) // vertex variants tested separately
      .filter(([, e]) => !e.supportsRealtimeVoice) // realtime audio models don't use thinking budget
      .filter(([id]) => !id.includes('flash-lite')); // flash-lite models don't use thinking budget

    for (const [id, entry] of thinkingBudgetModels) {
      expect(entry.supportsThinkingBudget, `${id} supportsThinkingBudget`).toBe(true);
    }
  });

  test('realtime models have supportsRealtimeVoice=true', () => {
    const realtimeModels = MODEL_IDS.filter((id) => id.toLowerCase().includes('realtime'));
    expect(realtimeModels.length).toBeGreaterThan(0);
    for (const id of realtimeModels) {
      expect(MODEL_REGISTRY[id]?.supportsRealtimeVoice, `${id} supportsRealtimeVoice`).toBe(true);
    }
  });

  test('embedding models have maxOutputTokens=0 and supportsStreaming=false', () => {
    const embeddingModels = MODEL_IDS.filter((id) =>
      MODEL_REGISTRY[id]?.capabilities?.includes('textToEmbedding'),
    );
    expect(embeddingModels.length).toBeGreaterThanOrEqual(6);
    for (const id of embeddingModels) {
      expect(MODEL_REGISTRY[id]?.maxOutputTokens, `${id} maxOutputTokens`).toBe(0);
      expect(MODEL_REGISTRY[id]?.supportsStreaming, `${id} supportsStreaming`).toBe(false);
    }
  });

  test('image generation models have supportsStreaming=false', () => {
    const imageModels = MODEL_IDS.filter(
      (id) => id.startsWith('dall-e') || (id.includes('image') && !id.includes('imageToText')),
    );
    for (const id of imageModels) {
      if (MODEL_REGISTRY[id]?.supportsStreaming !== undefined) {
        expect(MODEL_REGISTRY[id]?.supportsStreaming, `${id} supportsStreaming`).toBe(false);
      }
    }
  });

  test('disabled sampling parameters are not advertised in raw registry metadata', () => {
    for (const [modelId, entry] of Object.entries(MODEL_REGISTRY)) {
      const names = collectHyperParameterIdentities(entry.hyperParameters);
      if (entry.temperatureDisabled) {
        expect(names.has('temperature'), `${modelId} must not advertise temperature`).toBe(false);
      }
      if (entry.topPDisabled) {
        expect(
          names.has('topP') || names.has('top_p'),
          `${modelId} must not advertise topP/top_p`,
        ).toBe(false);
      }
    }
  });
});

// =============================================================================
// getBuiltInCatalog()
// =============================================================================

describe('getBuiltInCatalog()', () => {
  const catalog = getBuiltInCatalog();

  test('returns registry entries plus top-level provider catalog aliases', () => {
    expect(catalog.length).toBe(213);
  });

  test('every entry has required CatalogModelData fields', () => {
    for (const entry of catalog) {
      expect(typeof entry.modelId).toBe('string');
      expect(entry.modelId.length).toBeGreaterThan(0);
      expect(typeof entry.provider).toBe('string');
      expect(typeof entry.displayName).toBe('string');
      expect(entry.displayName.length).toBeGreaterThan(0);
      expect(typeof entry.capabilities.supportsTools).toBe('boolean');
      expect(typeof entry.capabilities.supportsVision).toBe('boolean');
      expect(typeof entry.capabilities.supportsStreaming).toBe('boolean');
      expect(typeof entry.capabilities.contextWindow).toBe('number');
    }
  });

  test('gpt-4o catalog entry is correct', () => {
    const gpt4o = catalog.find((m) => m.modelId === 'gpt-4o');
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.provider).toBe('openai');
    expect(gpt4o!.displayName).toBe('GPT-4o');
    expect(gpt4o!.capabilities.supportsTools).toBe(true);
    expect(gpt4o!.capabilities.supportsVision).toBe(true);
    expect(gpt4o!.capabilities.supportsStreaming).toBe(true);
    expect(gpt4o!.capabilities.contextWindow).toBe(128_000);
    expect(gpt4o!.pricing).toEqual({ inputCostPer1k: 0.005, outputCostPer1k: 0.015 });
  });

  test('claude-opus-4-7 catalog entry is correct', () => {
    const opus4 = catalog.find((m) => m.modelId === 'claude-opus-4-7');
    expect(opus4).toBeDefined();
    expect(opus4!.provider).toBe('anthropic');
    expect(opus4!.displayName).toBe('Claude Opus 4.7');
    expect(opus4!.capabilities.supportsVision).toBe(true);
    expect(opus4!.capabilities.contextWindow).toBe(1_000_000);
    expect(opus4!.pricing).toEqual({ inputCostPer1k: 0.005, outputCostPer1k: 0.025 });
  });

  test('Microsoft Foundry Anthropic models are top-level catalog entries', () => {
    const foundryModels = catalog.filter((m) => m.provider === 'microsoft_foundry_anthropic');

    expect(foundryModels).toHaveLength(4);
    expect(foundryModels.map((m) => m.modelId)).toContain(
      'microsoft_foundry_anthropic/claude-opus-4-7',
    );

    const opus4 = foundryModels.find(
      (m) => m.modelId === 'microsoft_foundry_anthropic/claude-opus-4-7',
    );
    expect(opus4).toBeDefined();
    expect(opus4!.displayName).toBe('Claude Opus 4.7 (Microsoft Foundry)');
    expect(opus4!.capabilities.supportsTools).toBe(true);
    expect(opus4!.capabilities.supportsVision).toBe(true);
    expect(opus4!.capabilities.contextWindow).toBe(1_000_000);
  });

  test('models without pricing have pricing=undefined', () => {
    // Find any model in the catalog that lacks pricing data
    const noPricing = catalog.find((m) => !m.pricing);
    expect(noPricing).toBeDefined();
    expect(noPricing!.pricing).toBeUndefined();
  });

  test('realtime models have supportsRealtimeVoice in capabilities', () => {
    const realtime = catalog.find((m) => m.modelId === 'gpt-4o-realtime-preview');
    expect(realtime).toBeDefined();
    expect(realtime!.capabilities.supportsRealtimeVoice).toBe(true);
  });

  test('fixie-ai/ultravox catalog entry is correct', () => {
    const ultravox = catalog.find((m) => m.modelId === 'fixie-ai/ultravox');
    expect(ultravox).toBeDefined();
    expect(ultravox!.provider).toBe('ultravox');
    expect(ultravox!.displayName).toBe('Ultravox');
    expect(ultravox!.capabilities.supportsTools).toBe(false);
    expect(ultravox!.capabilities.supportsStreaming).toBe(true);
    expect(ultravox!.capabilities.contextWindow).toBe(128_000);
    expect(ultravox!.capabilities.supportsRealtimeVoice).toBe(true);
  });
});

// =============================================================================
// getModelCapabilities() — exact match
// =============================================================================

describe('getModelCapabilities() exact match', () => {
  test('gpt-4o', () => {
    const caps = getModelCapabilities('gpt-4o');
    expect(caps.provider).toBe('openai');
    expect(caps.contextWindow).toBe(128_000);
    expect(caps.maxOutputTokens).toBe(16_384);
    expect(caps.supportsVision).toBe(true);
    expect(caps.supportsTools).toBe(true);
    expect(caps.supportsStructuredOutput).toBe(true);
    expect(caps.isReasoningModel).toBe(false);
  });

  test('o3 — reasoning model', () => {
    const caps = getModelCapabilities('o3');
    expect(caps.provider).toBe('openai');
    expect(caps.contextWindow).toBe(200_000);
    expect(caps.maxOutputTokens).toBe(100_000);
    expect(caps.isReasoningModel).toBe(true);
    expect(caps.temperatureDisabled).toBe(true);
    expect(caps.topPDisabled).toBe(true);
    expect(caps.supportsParallelToolCalls).toBe(false);
  });

  test('gpt-5 — reasoning with reasoning_effort', () => {
    const caps = getModelCapabilities('gpt-5');
    expect(caps.isReasoningModel).toBe(true);
    expect(caps.supportsReasoningEffort).toBe(true);
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.maxOutputTokens).toBe(128_000);
  });

  test('claude-sonnet-4-20250514 — thinking model', () => {
    const caps = getModelCapabilities('claude-sonnet-4-20250514');
    expect(caps.provider).toBe('anthropic');
    expect(caps.supportsThinking).toBe(true);
    expect(caps.contextWindow).toBe(200_000);
    expect(caps.maxOutputTokens).toBe(16_384);
    expect(caps.supportsVision).toBe(true);
  });

  test('claude-opus-4-5-20251101 — thinking model with 32k output', () => {
    const caps = getModelCapabilities('claude-opus-4-5-20251101');
    expect(caps.supportsThinking).toBe(true);
    expect(caps.maxOutputTokens).toBe(32_000);
  });

  test('gemini-2.5-pro — thinking budget model', () => {
    const caps = getModelCapabilities('gemini-2.5-pro');
    expect(caps.provider).toBe('google');
    expect(caps.supportsThinkingBudget).toBe(true);
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.maxOutputTokens).toBe(65_536);
    expect(caps.supportsVision).toBe(true);
  });

  test('gemini-2.0-flash — no thinking budget', () => {
    const caps = getModelCapabilities('gemini-2.0-flash');
    expect(caps.supportsThinkingBudget).toBe(false);
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.maxOutputTokens).toBe(8_192);
  });

  test('command-a-03-2025 — cohere model', () => {
    const caps = getModelCapabilities('command-a-03-2025');
    expect(caps.provider).toBe('cohere');
    expect(caps.contextWindow).toBe(256_000);
    expect(caps.maxOutputTokens).toBe(16_384);
  });
});

// =============================================================================
// getModelCapabilities() — provider prefix stripping
// =============================================================================

describe('getModelCapabilities() provider prefix stripping', () => {
  test('strips "openai/" prefix', () => {
    const caps = getModelCapabilities('openai/gpt-4o');
    expect(caps.provider).toBe('openai');
    expect(caps.contextWindow).toBe(128_000);
  });

  test('strips "anthropic/" prefix', () => {
    const caps = getModelCapabilities('anthropic/claude-sonnet-4-20250514');
    expect(caps.provider).toBe('anthropic');
    expect(caps.supportsThinking).toBe(true);
  });

  test('strips "google/" prefix', () => {
    const caps = getModelCapabilities('google/gemini-2.5-pro');
    expect(caps.provider).toBe('google');
    expect(caps.supportsThinkingBudget).toBe(true);
  });

  test('strips routed provider prefixes before capability lookup', () => {
    const caps = getModelCapabilities('openrouter/openai/gpt-5');
    expect(caps.provider).toBe('openai');
    expect(caps.isReasoningModel).toBe(true);
    expect(caps.supportsReasoningEffort).toBe(true);
  });

  test('uses Azure registry metadata for azure-prefixed lowercase aliases', () => {
    const caps = getModelCapabilities('azure/gpt-4.1');
    expect(caps.provider).toBe('azure');
    expect(caps.contextWindow).toBe(1_047_576);
    expect(caps.maxOutputTokens).toBe(32_768);
    expect(caps.supportsStructuredOutput).toBe(false);
  });
});

// =============================================================================
// getModelCapabilities() — family prefix matching
// =============================================================================

describe('getModelCapabilities() family prefix matching', () => {
  test('unknown o1 date variant matches o1 family', () => {
    const caps = getModelCapabilities('o1-2025-99-99');
    expect(caps.isReasoningModel).toBe(true);
    expect(caps.temperatureDisabled).toBe(true);
    expect(caps.contextWindow).toBe(200_000);
  });

  test('unknown o3 date variant matches o3 family', () => {
    const caps = getModelCapabilities('o3-2026-01-01');
    expect(caps.isReasoningModel).toBe(true);
    expect(caps.contextWindow).toBe(200_000);
  });

  test('unknown gpt-5 variant matches gpt-5 family', () => {
    const caps = getModelCapabilities('gpt-5-turbo-2026');
    expect(caps.isReasoningModel).toBe(true);
    expect(caps.supportsReasoningEffort).toBe(true);
    expect(caps.contextWindow).toBe(1_000_000);
  });

  test('normalizes Azure-cased dotted GPT-5 variants', () => {
    const caps = getModelCapabilities('GPT-5.4');
    expect(caps.isReasoningModel).toBe(true);
    expect(caps.supportsReasoningEffort).toBe(true);
    expect(caps.contextWindow).toBe(1_050_000);
  });

  test('unknown claude-sonnet-4 variant matches family', () => {
    const caps = getModelCapabilities('claude-sonnet-4-20260101');
    expect(caps.supportsThinking).toBe(true);
    expect(caps.contextWindow).toBe(200_000);
  });

  test('unknown claude-opus-4-5 variant matches family', () => {
    const caps = getModelCapabilities('claude-opus-4-5-20260101');
    expect(caps.supportsThinking).toBe(true);
    expect(caps.maxOutputTokens).toBe(32_000);
  });

  test('unknown gemini-2.5-flash variant matches family', () => {
    const caps = getModelCapabilities('gemini-2.5-flash-exp-2026');
    expect(caps.supportsThinkingBudget).toBe(true);
    expect(caps.contextWindow).toBe(1_000_000);
  });

  test('unknown gemini-3-pro variant matches family', () => {
    const caps = getModelCapabilities('gemini-3-pro-stable');
    expect(caps.supportsThinkingBudget).toBe(true);
  });
});

// =============================================================================
// getModelCapabilities() — fallback defaults
// =============================================================================

describe('getModelCapabilities() fallback defaults', () => {
  test('unknown claude model gets anthropic provider + vision', () => {
    const caps = getModelCapabilities('claude-99-turbo');
    expect(caps.provider).toBe('anthropic');
    expect(caps.supportsVision).toBe(true);
  });

  test('unknown gpt-4 model gets openai provider + vision', () => {
    const caps = getModelCapabilities('gpt-4-unknown-variant');
    expect(caps.provider).toBe('openai');
    expect(caps.supportsVision).toBe(true);
  });

  test('unknown gemini model gets google provider + vision', () => {
    const caps = getModelCapabilities('gemini-99-ultra');
    expect(caps.provider).toBe('google');
    expect(caps.supportsVision).toBe(true);
  });

  test('completely unknown model gets conservative defaults', () => {
    const caps = getModelCapabilities('totally-unknown-model-xyz');
    expect(caps.provider).toBe('openai');
    expect(caps.maxOutputTokens).toBe(4096);
    expect(caps.contextWindow).toBe(128_000);
    expect(caps.supportsTools).toBe(true);
    expect(caps.supportsVision).toBe(false);
    expect(caps.isReasoningModel).toBe(false);
    expect(caps.supportsThinking).toBe(false);
  });
});

// =============================================================================
// Helper functions
// =============================================================================

describe('Helper functions', () => {
  test('isReasoningModel()', () => {
    expect(isReasoningModel('o3')).toBe(true);
    expect(isReasoningModel('o1')).toBe(true);
    expect(isReasoningModel('gpt-5')).toBe(true);
    expect(isReasoningModel('gpt-4o')).toBe(false);
    expect(isReasoningModel('claude-sonnet-4-20250514')).toBe(false);
  });

  test('supportsThinking()', () => {
    expect(supportsThinking('claude-sonnet-4-20250514')).toBe(true);
    expect(supportsThinking('claude-opus-4-20250514')).toBe(true);
    expect(supportsThinking('claude-opus-4-7')).toBe(true);
    expect(supportsThinking('claude-3-5-haiku-20241022')).toBe(false);
    expect(supportsThinking('gpt-4o')).toBe(false);
  });

  test('supportsReasoningEffort()', () => {
    expect(supportsReasoningEffort('gpt-5')).toBe(true);
    expect(supportsReasoningEffort('gpt-5.1')).toBe(true);
    expect(supportsReasoningEffort('o3')).toBe(true); // o3 supports reasoning_effort
    expect(supportsReasoningEffort('o1')).toBe(false); // o1 uses automatic reasoning (no effort param)
    expect(supportsReasoningEffort('gpt-4o')).toBe(false);
  });

  test('getMaxOutputTokens()', () => {
    expect(getMaxOutputTokens('gpt-4o')).toBe(16_384);
    expect(getMaxOutputTokens('o3')).toBe(100_000);
    expect(getMaxOutputTokens('claude-opus-4-5-20251101')).toBe(32_000);
    expect(getMaxOutputTokens('gemini-2.5-pro')).toBe(65_536);
  });

  test('getContextWindow()', () => {
    expect(getContextWindow('gpt-4o')).toBe(128_000);
    expect(getContextWindow('claude-sonnet-4-20250514')).toBe(200_000);
    expect(getContextWindow('gemini-2.5-pro')).toBe(1_000_000);
    expect(getContextWindow('gpt-5')).toBe(1_000_000);
  });

  test('modelSupportsResponsesApi normalizes provider prefixes and casing', () => {
    expect(modelSupportsResponsesApi('gpt-5.4')).toBe(true);
    expect(modelSupportsResponsesApi('GPT-5.4')).toBe(true);
    expect(modelSupportsResponsesApi('openai/GPT-5.4')).toBe(true);
    expect(modelSupportsResponsesApi('openrouter/openai/GPT-5.4')).toBe(true);
    expect(modelSupportsResponsesApi('openai/GPT-5')).toBe(true);
    expect(modelSupportsResponsesApi('openai/GPT-5.5')).toBe(true);
    expect(modelSupportsResponsesApi('claude-sonnet-4-6')).toBe(false);
  });
});

// =============================================================================
// getModelRegistryEntry() and getHyperParameters()
// =============================================================================

describe('getModelRegistryEntry()', () => {
  test('returns full entry for known model', () => {
    const entry = getModelRegistryEntry('gpt-4o');
    expect(entry).not.toBeNull();
    expect(entry!.provider).toBe('openai');
    expect(entry!.displayName).toBe('GPT-4o');
    expect(entry!.hyperParameters.length).toBeGreaterThan(0);
  });

  test('returns null for unknown model', () => {
    expect(getModelRegistryEntry('totally-unknown-xyz')).toBeNull();
  });

  test('strips provider prefix', () => {
    const entry = getModelRegistryEntry('openai/gpt-4o');
    expect(entry).not.toBeNull();
    expect(entry!.displayName).toBe('GPT-4o');
  });

  test('strips routed provider prefixes', () => {
    const entry = getModelRegistryEntry('openrouter/openai/GPT-5');
    expect(entry).not.toBeNull();
    expect(entry!.provider).toBe('openai');
    expect(entry!.displayName).toBe('GPT-5');
  });

  test('normalizes provider-prefixed Azure-cased model aliases', () => {
    const entry = getModelRegistryEntry('openai/GPT-5.4');
    expect(entry).not.toBeNull();
    expect(entry!.displayName).toBe('GPT-5.4');
  });

  test('provider-prefixed aliases prefer normalized provider model over Azure-cased exact key', () => {
    const entry = getModelRegistryEntry('openai/GPT-5');
    expect(entry).not.toBeNull();
    expect(entry!.provider).toBe('openai');
    expect(entry!.displayName).toBe('GPT-5');
  });

  test('azure-prefixed aliases prefer Azure registry entries', () => {
    const entry = getModelRegistryEntry('azure/gpt-4.1');
    expect(entry).not.toBeNull();
    expect(entry!.provider).toBe('azure');
    expect(entry!.displayName).toBe('GPT-4.1 (Azure)');
    expect(getModelRegistryKey('azure/gpt-4.1')).toBe('GPT-4.1');
  });

  test('non-Azure provider-prefixed aliases resolve to provider-specific registry entries', () => {
    expect(getModelRegistryKey('openai/GPT-4.1')).toBe('gpt-4.1');
    expect(getModelRegistryKey('anthropic/CLAUDE-OPUS-4-7')).toBe('claude-opus-4-7');
    expect(getModelRegistryKey('togetherai/META-LLAMA/LLAMA-3.3-70B-INSTRUCT-TURBO')).toBe(
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    );
  });

  test('provider-native slash model IDs resolve without losing organization prefix', () => {
    expect(getModelRegistryKey('META-LLAMA/LLAMA-3.3-70B-INSTRUCT-TURBO')).toBe(
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    );
  });

  test('provider-prefixed Azure embeddings keep their full registry key', () => {
    const entry = getModelRegistryEntry('azure/text-embedding-3-small');
    expect(entry).not.toBeNull();
    expect(entry!.provider).toBe('azure');
    expect(getModelRegistryKey('azure/text-embedding-3-small')).toBe(
      'azure/text-embedding-3-small',
    );
  });

  test('uses prefix matching for date variants', () => {
    // gpt-4o-2024-08-06 is a known model, so exact match
    const entry = getModelRegistryEntry('gpt-4o-2024-08-06');
    expect(entry).not.toBeNull();
    expect(entry!.provider).toBe('openai');
  });

  test('uses reverse date-alias matching for a single dated family variant', () => {
    const entry = getModelRegistryEntry('claude-sonnet-4-6');
    expect(entry).not.toBeNull();
    expect(entry!.displayName).toBe('Claude Sonnet 4.6');
  });

  test('returns null for ambiguous partial prefixes', () => {
    expect(getModelRegistryEntry('gpt-4')).toBeNull();
    expect(getModelRegistryEntry('claude')).toBeNull();
  });
});

// =============================================================================
// Provider identity helpers
// =============================================================================

describe('provider identity helpers', () => {
  test('infers registry providers for provider-native slash model IDs', () => {
    expect(inferModelProviderFromId('meta-llama/Llama-3.3-70B-Instruct-Turbo')).toBe('togetherai');
    expect(inferModelProviderFromId('accounts/fireworks/models/qwen-qwq-32b-preview')).toBe(
      'fireworks',
    );
    expect(inferModelProviderFromId('some-org/custom-model')).toBeNull();
  });

  test('detects only leading platform provider prefixes', () => {
    expect(inferModelProviderFromId('openrouter/openai/gpt-5')).toBe('openrouter');
    expect(stripLeadingPlatformModelProviderPrefix('openrouter/openai/gpt-5')).toBe('openai/gpt-5');
    expect(stripLeadingPlatformModelProviderPrefix('accounts/fireworks/models/custom')).toBe(
      'accounts/fireworks/models/custom',
    );
  });
});

describe('getHyperParameters()', () => {
  test('returns hyperparameters for known model', () => {
    const params = getHyperParameters('gpt-4o');
    expect(params.length).toBeGreaterThan(0);
    const names = params.map((p) => p.name);
    expect(names).toContain('temperature');
    expect(names).toContain('max_tokens');
  });

  test('returns empty array for unknown model', () => {
    expect(getHyperParameters('totally-unknown-xyz')).toEqual([]);
  });

  test('anthropic models have expected hyperparameters', () => {
    const params = getHyperParameters('claude-sonnet-4-20250514');
    expect(params.length).toBeGreaterThan(0);
    const names = params.map((p) => p.name);
    expect(names).toContain('max_tokens');
  });

  test('filters disabled sampling parameters from UI-facing metadata', () => {
    const names = collectHyperParameterIdentities(getHyperParameters('claude-opus-4-7'));
    expect(names.has('temperature')).toBe(false);
    expect(names.has('topP')).toBe(false);
    expect(names.has('top_p')).toBe(false);
    expect(names.has('max_tokens')).toBe(true);
    expect(names.has('thinking.enabled')).toBe(true);
    expect(names.has('thinking.budget_tokens')).toBe(true);
  });
});

// =============================================================================
// SPOT-CHECK: Every model by provider
// =============================================================================

describe('Spot-check: every model has valid capabilities', () => {
  test.each(MODEL_IDS)('%s has valid capabilities', (modelId) => {
    const caps = getModelCapabilities(modelId);
    expect(caps.provider).toBeTruthy();
    expect(caps.contextWindow).toBeGreaterThan(0);
    // maxOutputTokens can be 0 for embedding models
    expect(caps.maxOutputTokens).toBeGreaterThanOrEqual(0);
    expect(typeof caps.supportsTools).toBe('boolean');
    expect(typeof caps.supportsVision).toBe('boolean');
    expect(typeof caps.supportsStreaming).toBe('boolean');
    expect(typeof caps.isReasoningModel).toBe('boolean');
    expect(typeof caps.supportsThinking).toBe('boolean');
    expect(typeof caps.supportsThinkingBudget).toBe('boolean');
    expect(typeof caps.temperatureDisabled).toBe('boolean');
    expect(typeof caps.topPDisabled).toBe('boolean');
  });
});

// =============================================================================
// AZURE-CASED ALIASES
// =============================================================================

describe('Azure-cased aliases', () => {
  // Azure models use uppercase IDs (but not all uppercase IDs are Azure)
  const azureModels = MODEL_IDS.filter((id) => MODEL_REGISTRY[id]?.provider === 'azure');

  test('azure models exist and have provider "azure"', () => {
    expect(azureModels.length).toBeGreaterThan(10);
    for (const id of azureModels) {
      expect(MODEL_REGISTRY[id]?.provider, `${id} provider`).toBe('azure');
    }
  });

  test('azure GPT-4o has same capabilities as lowercase gpt-4o', () => {
    const azureCaps = getModelCapabilities('GPT-4o');
    const openaiCaps = getModelCapabilities('gpt-4o');
    expect(azureCaps.contextWindow).toBe(openaiCaps.contextWindow);
    expect(azureCaps.maxOutputTokens).toBe(openaiCaps.maxOutputTokens);
    expect(azureCaps.supportsVision).toBe(openaiCaps.supportsVision);
  });

  test('azure O1 is a reasoning model', () => {
    const caps = getModelCapabilities('O1');
    expect(caps.isReasoningModel).toBe(true);
    expect(caps.temperatureDisabled).toBe(true);
  });

  test('azure GPT-5 family supports reasoning effort', () => {
    const caps = getModelCapabilities('GPT-5');
    expect(caps.isReasoningModel).toBe(true);
    expect(caps.supportsReasoningEffort).toBe(true);
  });
});
