/**
 * NLU Engine & Infrastructure Tests
 *
 * Tests for: NLUEngine orchestration, ModelRouter, NLUConfig builder/validator,
 * NLUContextBuilder, NLUPluginPipeline, NLUTaskPipeline, prompt-loader,
 * fallbacks, utils, language utilities, and metrics.
 *
 * All LLM providers are mocked.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Engine
import { NLUEngine } from '../platform/nlu/engine.js';

// Infrastructure
import { ModelRouter } from '../platform/nlu/model-router.js';
import { NLUTaskPipeline } from '../platform/nlu/pipeline.js';
import { NLUPluginPipeline } from '../platform/nlu/plugins.js';
import { buildNLUConfig, validateNLUConfig } from '../platform/nlu/config.js';
import type { NLUConfig } from '../platform/nlu/config.js';
import { NLUContextBuilder } from '../platform/nlu/context-builder.js';
import {
  renderTemplate,
  loadPromptTemplate,
  getEmbeddedPrompts,
} from '../platform/nlu/prompt-loader.js';
import { parseJSON, cosineSimilarity } from '../platform/nlu/utils.js';
import {
  detectIntentFallback,
  classifyCategoryFallback,
  extractEntitiesFallback,
  detectCorrectionFallback,
  detectLanguageFallback,
} from '../platform/nlu/fallbacks.js';
import {
  detectLanguage,
  LanguageSessionCache,
  getDateFormat,
  getDecimalSeparator,
  filterExamplesByLanguage,
} from '../platform/nlu/language.js';
import { InMemoryMetricsCollector, TenantScopedMetrics } from '../platform/nlu/metrics.js';

import type {
  NLUEngineConfig,
  NLUContext,
  IntentResult,
  IntentCandidate,
  CategoryDefinition,
  EntityField,
  NLUPlugin,
  NLUPredictionEvent,
} from '../platform/nlu/types.js';

// =============================================================================
// MOCK LLM PROVIDER
// =============================================================================

function createMockProvider(chatResponse?: string, opts?: { withExtractJson?: boolean }) {
  const provider: Record<string, unknown> = {
    chat: vi.fn().mockResolvedValue(chatResponse ?? '{}'),
    chatWithTools: vi.fn().mockResolvedValue({ text: '', toolCalls: [] }),
    streamChat: vi.fn(),
  };
  if (opts?.withExtractJson) {
    provider.extractJson = vi.fn().mockResolvedValue({});
  }
  return provider;
}

function createMockContext(overrides: Partial<NLUContext> = {}): NLUContext {
  return {
    userMessage: 'test message',
    conversationHistory: [],
    turnNumber: 1,
    conversationPhase: 'collecting',
    agentGoal: 'Test agent',
    collectedData: {},
    ...overrides,
  };
}

function createBaseEngineConfig(chatResponse?: string): NLUEngineConfig {
  return {
    layers: {
      fast: {
        provider: createMockProvider(chatResponse),
        model: 'fast-model',
        timeoutMs: 2000,
      },
    },
    enableFallbacks: true,
    confidenceThreshold: 0.7,
  };
}

// =============================================================================
// UTILS TESTS
// =============================================================================

describe('Utils', () => {
  describe('parseJSON', () => {
    test('parses plain JSON', () => {
      const result = parseJSON<{ name: string }>('{"name": "test"}');
      expect(result).toEqual({ name: 'test' });
    });

    test('parses JSON wrapped in markdown code block', () => {
      const result = parseJSON<{ intent: string }>('```json\n{"intent": "book"}\n```');
      expect(result).toEqual({ intent: 'book' });
    });

    test('parses JSON wrapped in plain code block', () => {
      const result = parseJSON<{ x: number }>('```\n{"x": 42}\n```');
      expect(result).toEqual({ x: 42 });
    });

    test('extracts JSON from surrounding text', () => {
      const result = parseJSON<{ key: string }>('Here is the result: {"key": "value"} done.');
      expect(result).toEqual({ key: 'value' });
    });

    test('returns null for non-JSON text', () => {
      const result = parseJSON('just plain text');
      expect(result).toBeNull();
    });

    test('returns null for empty string', () => {
      const result = parseJSON('');
      expect(result).toBeNull();
    });

    test('returns null for malformed JSON', () => {
      const result = parseJSON('{broken json}');
      expect(result).toBeNull();
    });

    test('handles nested JSON objects', () => {
      const result = parseJSON<{ a: { b: number } }>('{"a": {"b": 1}}');
      expect(result).toEqual({ a: { b: 1 } });
    });
  });

  describe('cosineSimilarity', () => {
    test('returns 1.0 for identical vectors', () => {
      const a = [1, 0, 0];
      expect(cosineSimilarity(a, a)).toBeCloseTo(1.0);
    });

    test('returns 0 for orthogonal vectors', () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    });

    test('returns -1 for opposite vectors', () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    });

    test('returns 0 for different length vectors', () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    test('returns 0 for zero vectors', () => {
      expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    });

    test('computes correct similarity for non-trivial vectors', () => {
      const a = [1, 2, 3];
      const b = [4, 5, 6];
      // dot = 32, normA = sqrt(14), normB = sqrt(77)
      const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
      expect(cosineSimilarity(a, b)).toBeCloseTo(expected);
    });
  });
});

// =============================================================================
// MODEL ROUTER TESTS
// =============================================================================

describe('ModelRouter', () => {
  test('routes fast tasks to fast layer', () => {
    const config = createBaseEngineConfig();
    const router = new ModelRouter(config);
    const result = router.getLayerForTask('intent_detection');

    expect(result.primaryLayer).toBe('fast');
    expect(result.primary.model).toBe('fast-model');
  });

  test('routes balanced tasks to balanced layer when available', () => {
    const config: NLUEngineConfig = {
      layers: {
        fast: { provider: createMockProvider(), model: 'fast-model' },
        balanced: { provider: createMockProvider(), model: 'balanced-model' },
      },
      confidenceThreshold: 0.7,
    };
    const router = new ModelRouter(config);
    const result = router.getLayerForTask('sub_intent_detection'); // defaults to balanced

    expect(result.primaryLayer).toBe('balanced');
    expect(result.primary.model).toBe('balanced-model');
    expect(result.fallbackLayer).toBe('fast');
  });

  test('falls back to fast when balanced is not configured for balanced task', () => {
    const config = createBaseEngineConfig();
    const router = new ModelRouter(config);
    const result = router.getLayerForTask('sub_intent_detection');

    expect(result.primaryLayer).toBe('fast');
    expect(result.fallback).toBeUndefined();
  });

  test('getConfidenceThreshold returns configured threshold', () => {
    const config = createBaseEngineConfig();
    config.confidenceThreshold = 0.85;
    const router = new ModelRouter(config);

    expect(router.getConfidenceThreshold()).toBe(0.85);
  });

  test('getConfidenceThreshold defaults to 0.7', () => {
    const config: NLUEngineConfig = {
      layers: { fast: { provider: createMockProvider(), model: 'fast' } },
    };
    const router = new ModelRouter(config);

    expect(router.getConfidenceThreshold()).toBe(0.7);
  });

  test('isFallbackEnabled returns true by default', () => {
    const config = createBaseEngineConfig();
    const router = new ModelRouter(config);

    expect(router.isFallbackEnabled()).toBe(true);
  });

  test('isFallbackEnabled returns false when disabled', () => {
    const config = createBaseEngineConfig();
    config.enableFallbacks = false;
    const router = new ModelRouter(config);

    expect(router.isFallbackEnabled()).toBe(false);
  });

  test('selectABVariant returns fast only when no balanced layer', () => {
    const config = createBaseEngineConfig();
    const router = new ModelRouter(config);
    const result = router.selectABVariant();

    expect(result.variant).toBe('fast');
  });

  test('selectABVariant returns either fast or balanced when both available', () => {
    const config: NLUEngineConfig = {
      layers: {
        fast: { provider: createMockProvider(), model: 'fast-model' },
        balanced: { provider: createMockProvider(), model: 'balanced-model' },
      },
    };
    const router = new ModelRouter(config);

    // Run multiple times to increase probability of seeing both variants
    const variants = new Set<string>();
    for (let i = 0; i < 50; i++) {
      variants.add(router.selectABVariant().variant);
    }

    expect(variants.has('fast') || variants.has('balanced')).toBe(true);
  });

  test('routes entity_extraction to fast by default', () => {
    const config = createBaseEngineConfig();
    const router = new ModelRouter(config);
    const result = router.getLayerForTask('entity_extraction');

    expect(result.primaryLayer).toBe('fast');
  });

  test('routes language_detection to fast by default', () => {
    const config = createBaseEngineConfig();
    const router = new ModelRouter(config);
    const result = router.getLayerForTask('language_detection');

    expect(result.primaryLayer).toBe('fast');
  });
});

// =============================================================================
// NLU CONFIG TESTS
// =============================================================================

describe('NLU Config', () => {
  describe('buildNLUConfig', () => {
    test('builds config with dev defaults', () => {
      const config = buildNLUConfig({ environment: 'dev' });

      expect(config.environment).toBe('dev');
      expect(config.fastModel).toBe('default');
      expect(config.confidenceThreshold).toBe(0.7);
      expect(config.enableFallbacks).toBe(true);
      expect(config.cache.enabled).toBe(false); // dev disables cache
      expect(config.circuitBreaker.enabled).toBe(false); // dev disables circuit breaker
    });

    test('builds config with production defaults', () => {
      const config = buildNLUConfig({ environment: 'production' });

      expect(config.cache.enabled).toBe(true);
      expect(config.piiRedaction.enabled).toBe(true);
      expect(config.piiRedaction.redactOutput).toBe(true);
      expect(config.audit.enabled).toBe(true);
      expect(config.audit.logPredictions).toBe(true);
    });

    test('builds config with staging defaults', () => {
      const config = buildNLUConfig({ environment: 'staging' });

      expect(config.cache.enabled).toBe(true);
      expect(config.piiRedaction.enabled).toBe(true);
      expect(config.audit.enabled).toBe(true);
      expect(config.audit.logPredictions).toBe(false);
    });

    test('builds config with dev defaults (cache and circuit breaker disabled)', () => {
      const config = buildNLUConfig({ environment: 'dev' });

      expect(config.cache.enabled).toBe(false);
      expect(config.circuitBreaker.enabled).toBe(false);
    });

    test('applies environment variables', () => {
      const config = buildNLUConfig({
        environment: 'dev',
        envVars: {
          NLU_FAST_MODEL: 'gpt-4o-mini',
          NLU_BALANCED_MODEL: 'gpt-4o',
          NLU_CONFIDENCE_THRESHOLD: '0.85',
          NLU_CACHE_ENABLED: 'true',
          NLU_CACHE_TTL_MS: '300000',
          NLU_PII_REDACTION_ENABLED: 'true',
          NLU_CIRCUIT_BREAKER_ENABLED: 'true',
          NLU_AUDIT_ENABLED: 'true',
          NLU_RATE_LIMIT_PER_MINUTE: '500',
        },
      });

      expect(config.fastModel).toBe('gpt-4o-mini');
      expect(config.balancedModel).toBe('gpt-4o');
      expect(config.confidenceThreshold).toBe(0.85);
      expect(config.cache.enabled).toBe(true);
      expect(config.cache.ttlMs).toBe(300000);
      expect(config.piiRedaction.enabled).toBe(true);
      expect(config.circuitBreaker.enabled).toBe(true);
      expect(config.audit.enabled).toBe(true);
      expect(config.rateLimiting.maxCallsPerMinute).toBe(500);
    });

    test('applies ABL config', () => {
      const config = buildNLUConfig({
        environment: 'dev',
        ablConfig: {
          models: { fast: 'claude-haiku', balanced: 'claude-sonnet' },
          intents: [],
          categories: [],
          entities: [],
          glossary: [],
          evaluation: { confidenceThreshold: 0.9 },
        },
      });

      expect(config.fastModel).toBe('claude-haiku');
      expect(config.balancedModel).toBe('claude-sonnet');
      expect(config.confidenceThreshold).toBe(0.9);
    });

    test('manual overrides take highest priority', () => {
      const config = buildNLUConfig({
        environment: 'production',
        envVars: { NLU_FAST_MODEL: 'env-model' },
        ablConfig: {
          models: { fast: 'abl-model' },
          intents: [],
          categories: [],
          entities: [],
          glossary: [],
        },
        overrides: { fastModel: 'override-model' },
      });

      expect(config.fastModel).toBe('override-model');
    });

    test('ignores invalid env var values', () => {
      const config = buildNLUConfig({
        environment: 'dev',
        envVars: {
          NLU_CONFIDENCE_THRESHOLD: 'not-a-number',
          NLU_CACHE_TTL_MS: 'invalid',
          NLU_RATE_LIMIT_PER_MINUTE: 'abc',
        },
      });

      expect(config.confidenceThreshold).toBe(0.7); // unchanged
    });
  });

  describe('validateNLUConfig', () => {
    test('valid config returns no errors', () => {
      const config = buildNLUConfig({ environment: 'dev' });
      const errors = validateNLUConfig(config);

      expect(errors).toEqual([]);
    });

    test('detects missing fastModel', () => {
      const config = buildNLUConfig({ environment: 'dev' });
      config.fastModel = '';
      const errors = validateNLUConfig(config);

      expect(errors).toContain('fastModel is required');
    });

    test('detects confidence threshold out of range', () => {
      const config = buildNLUConfig({ environment: 'dev' });
      config.confidenceThreshold = 1.5;
      const errors = validateNLUConfig(config);

      expect(errors).toContain('confidenceThreshold must be between 0 and 1');
    });

    test('detects negative confidence threshold', () => {
      const config = buildNLUConfig({ environment: 'dev' });
      config.confidenceThreshold = -0.1;
      const errors = validateNLUConfig(config);

      expect(errors).toContain('confidenceThreshold must be between 0 and 1');
    });

    test('detects negative cache TTL', () => {
      const config = buildNLUConfig({ environment: 'dev' });
      config.cache.ttlMs = -1;
      const errors = validateNLUConfig(config);

      expect(errors).toContain('cache.ttlMs must be non-negative');
    });

    test('detects invalid circuit breaker threshold', () => {
      const config = buildNLUConfig({ environment: 'dev' });
      config.circuitBreaker.failureThreshold = 0;
      const errors = validateNLUConfig(config);

      expect(errors).toContain('circuitBreaker.failureThreshold must be at least 1');
    });

    test('detects negative circuit breaker timeout', () => {
      const config = buildNLUConfig({ environment: 'dev' });
      config.circuitBreaker.resetTimeoutMs = -1;
      const errors = validateNLUConfig(config);

      expect(errors).toContain('circuitBreaker.resetTimeoutMs must be non-negative');
    });

    test('detects invalid rate limit', () => {
      const config = buildNLUConfig({ environment: 'dev' });
      config.rateLimiting.maxCallsPerMinute = 0;
      const errors = validateNLUConfig(config);

      expect(errors).toContain('rateLimiting.maxCallsPerMinute must be at least 1');
    });

    test('detects multiple errors at once', () => {
      const config = buildNLUConfig({ environment: 'dev' });
      config.fastModel = '';
      config.confidenceThreshold = 2;
      config.cache.ttlMs = -1;
      const errors = validateNLUConfig(config);

      expect(errors.length).toBeGreaterThanOrEqual(3);
    });
  });
});

// =============================================================================
// PLUGIN PIPELINE TESTS
// =============================================================================

describe('NLUPluginPipeline', () => {
  test('returns null when no plugins are registered', async () => {
    const pipeline = new NLUPluginPipeline([]);
    const ctx = createMockContext();

    const result = await pipeline.preProcess(ctx, 'intent_detection');
    expect(result).toBeNull();
  });

  test('preProcess returns first confident plugin result', async () => {
    const plugin1: NLUPlugin = {
      name: 'plugin1',
      preProcess: vi.fn().mockResolvedValue(null),
    };
    const plugin2: NLUPlugin = {
      name: 'plugin2',
      preProcess: vi
        .fn()
        .mockResolvedValue({ intent: 'book', confidence: 0.95, source: 'plugin' as const }),
    };
    const pipeline = new NLUPluginPipeline([plugin1, plugin2]);
    const ctx = createMockContext();

    const result = await pipeline.preProcess(ctx, 'intent_detection');

    expect(result).not.toBeNull();
    expect(result!.intent).toBe('book');
    expect(plugin1.preProcess).toHaveBeenCalled();
    expect(plugin2.preProcess).toHaveBeenCalled();
  });

  test('preProcess catches and logs plugin errors', async () => {
    const errorPlugin: NLUPlugin = {
      name: 'error-plugin',
      preProcess: vi.fn().mockRejectedValue(new Error('plugin crash')),
    };
    const goodPlugin: NLUPlugin = {
      name: 'good-plugin',
      preProcess: vi
        .fn()
        .mockResolvedValue({ intent: 'book', confidence: 0.9, source: 'plugin' as const }),
    };
    const pipeline = new NLUPluginPipeline([errorPlugin, goodPlugin]);
    const ctx = createMockContext();

    const result = await pipeline.preProcess(ctx, 'intent_detection');

    expect(result).not.toBeNull();
    expect(result!.intent).toBe('book');
  });

  test('postProcess chains plugin modifications', async () => {
    const plugin1: NLUPlugin = {
      name: 'modifier1',
      postProcess: vi.fn().mockImplementation(async (_ctx, _task, result) => {
        return { ...(result as Record<string, unknown>), modified1: true };
      }),
    };
    const plugin2: NLUPlugin = {
      name: 'modifier2',
      postProcess: vi.fn().mockImplementation(async (_ctx, _task, result) => {
        return { ...(result as Record<string, unknown>), modified2: true };
      }),
    };
    const pipeline = new NLUPluginPipeline([plugin1, plugin2]);
    const ctx = createMockContext();

    const result = (await pipeline.postProcess(ctx, 'intent_detection', {
      intent: 'book',
    })) as Record<string, unknown>;

    expect(result.intent).toBe('book');
    expect(result.modified1).toBe(true);
    expect(result.modified2).toBe(true);
  });

  test('postProcess catches and continues on plugin error', async () => {
    const errorPlugin: NLUPlugin = {
      name: 'error-plugin',
      postProcess: vi.fn().mockRejectedValue(new Error('crash')),
    };
    const pipeline = new NLUPluginPipeline([errorPlugin]);
    const ctx = createMockContext();

    const result = await pipeline.postProcess(ctx, 'intent_detection', { intent: 'book' });

    expect(result).toEqual({ intent: 'book' }); // unchanged
  });

  test('register adds a plugin', () => {
    const pipeline = new NLUPluginPipeline([]);
    const plugin: NLUPlugin = { name: 'new-plugin' };
    pipeline.register(plugin);

    expect(pipeline.getPlugins().length).toBe(1);
    expect(pipeline.getPlugins()[0].name).toBe('new-plugin');
  });

  test('unregister removes a plugin by name', () => {
    const plugin1: NLUPlugin = { name: 'keep' };
    const plugin2: NLUPlugin = { name: 'remove' };
    const pipeline = new NLUPluginPipeline([plugin1, plugin2]);

    pipeline.unregister('remove');

    expect(pipeline.getPlugins().length).toBe(1);
    expect(pipeline.getPlugins()[0].name).toBe('keep');
  });

  test('getPlugins returns a copy', () => {
    const plugin: NLUPlugin = { name: 'test' };
    const pipeline = new NLUPluginPipeline([plugin]);
    const plugins = pipeline.getPlugins();

    plugins.push({ name: 'extra' });
    expect(pipeline.getPlugins().length).toBe(1); // original unmodified
  });
});

// =============================================================================
// NLU TASK PIPELINE TESTS
// =============================================================================

describe('NLUTaskPipeline', () => {
  const defaultResult: IntentResult = { intent: null, confidence: 0, source: 'fallback' };
  const plugins = new NLUPluginPipeline([]);

  test('returns first confident step result', async () => {
    const steps = [
      {
        name: 'step1',
        layer: 'fast',
        execute: vi.fn().mockResolvedValue({ intent: 'book', confidence: 0.9, source: 'fast' }),
      },
      {
        name: 'step2',
        layer: 'balanced',
        execute: vi
          .fn()
          .mockResolvedValue({ intent: 'cancel', confidence: 0.95, source: 'balanced' }),
      },
    ];
    const pipeline = new NLUTaskPipeline<IntentResult>(
      'intent_detection',
      steps,
      defaultResult,
      plugins,
      0.7,
    );
    const ctx = createMockContext();

    const result = await pipeline.execute(ctx, []);

    expect(result.intent).toBe('book');
    expect(steps[1].execute).not.toHaveBeenCalled();
  });

  test('skips step below confidence threshold', async () => {
    const steps = [
      {
        name: 'step1',
        layer: 'fast',
        execute: vi.fn().mockResolvedValue({ intent: 'book', confidence: 0.3, source: 'fast' }),
      },
      {
        name: 'step2',
        layer: 'fallback',
        execute: vi.fn().mockResolvedValue({ intent: 'book', confidence: 0.8, source: 'fallback' }),
      },
    ];
    const pipeline = new NLUTaskPipeline<IntentResult>(
      'intent_detection',
      steps,
      defaultResult,
      plugins,
      0.7,
    );
    const ctx = createMockContext();

    const result = await pipeline.execute(ctx, []);

    expect(result.intent).toBe('book');
    expect(result.source).toBe('fallback');
    expect(steps[1].execute).toHaveBeenCalled();
  });

  test('returns default result when no step is confident', async () => {
    const steps = [
      {
        name: 'step1',
        layer: 'fast',
        execute: vi.fn().mockResolvedValue({ intent: 'maybe', confidence: 0.3, source: 'fast' }),
      },
    ];
    const pipeline = new NLUTaskPipeline<IntentResult>(
      'intent_detection',
      steps,
      defaultResult,
      plugins,
      0.7,
    );
    const ctx = createMockContext();

    const result = await pipeline.execute(ctx, []);

    expect(result.intent).toBeNull();
    expect(result.confidence).toBe(0);
  });

  test('catches step errors and continues', async () => {
    const steps = [
      { name: 'failing', layer: 'fast', execute: vi.fn().mockRejectedValue(new Error('crash')) },
      {
        name: 'working',
        layer: 'fallback',
        execute: vi.fn().mockResolvedValue({ intent: 'book', confidence: 0.8, source: 'fallback' }),
      },
    ];
    const pipeline = new NLUTaskPipeline<IntentResult>(
      'intent_detection',
      steps,
      defaultResult,
      plugins,
      0.7,
    );
    const ctx = createMockContext();

    const result = await pipeline.execute(ctx, []);

    expect(result.intent).toBe('book');
  });

  test('returns null step result and moves to next', async () => {
    const steps = [
      { name: 'null-step', layer: 'fast', execute: vi.fn().mockResolvedValue(null) },
      {
        name: 'good-step',
        layer: 'fallback',
        execute: vi.fn().mockResolvedValue({ intent: 'book', confidence: 0.8, source: 'fallback' }),
      },
    ];
    const pipeline = new NLUTaskPipeline<IntentResult>(
      'intent_detection',
      steps,
      defaultResult,
      plugins,
      0.7,
    );
    const ctx = createMockContext();

    const result = await pipeline.execute(ctx, []);

    expect(result.intent).toBe('book');
  });

  test('calls beforeExecute hook', async () => {
    const hookCtx = createMockContext({ userMessage: 'redacted' });
    const hooks = {
      beforeExecute: vi.fn().mockResolvedValue(hookCtx),
    };
    const steps = [
      {
        name: 'step',
        layer: 'fast',
        execute: vi.fn().mockResolvedValue({ intent: 'x', confidence: 0.9, source: 'fast' }),
      },
    ];
    const pipeline = new NLUTaskPipeline<IntentResult>(
      'intent_detection',
      steps,
      defaultResult,
      plugins,
      0.7,
      undefined,
      hooks,
    );
    const ctx = createMockContext();

    await pipeline.execute(ctx, []);

    expect(hooks.beforeExecute).toHaveBeenCalledWith(ctx, 'intent_detection');
    expect(steps[0].execute).toHaveBeenCalledWith(hookCtx, []);
  });

  test('returns cached result when cache hook provides one', async () => {
    const cachedResult: IntentResult = { intent: 'cached', confidence: 0.99, source: 'fast' };
    const hooks = {
      checkCache: vi.fn().mockResolvedValue(cachedResult),
    };
    const steps = [
      {
        name: 'step',
        layer: 'fast',
        execute: vi.fn().mockResolvedValue({ intent: 'fresh', confidence: 0.9, source: 'fast' }),
      },
    ];
    const pipeline = new NLUTaskPipeline<IntentResult>(
      'intent_detection',
      steps,
      defaultResult,
      plugins,
      0.7,
      undefined,
      hooks,
    );
    const ctx = createMockContext();

    const result = await pipeline.execute(ctx, []);

    expect(result.intent).toBe('cached');
    expect(steps[0].execute).not.toHaveBeenCalled();
  });

  test('wraps LLM calls via wrapLLMCall hook', async () => {
    const hooks = {
      wrapLLMCall: vi
        .fn()
        .mockImplementation(async <T>(_layer: string, fn: () => Promise<T>) => fn()),
    };
    const steps = [
      {
        name: 'step',
        layer: 'fast',
        execute: vi.fn().mockResolvedValue({ intent: 'x', confidence: 0.9, source: 'fast' }),
      },
    ];
    const pipeline = new NLUTaskPipeline<IntentResult>(
      'intent_detection',
      steps,
      defaultResult,
      plugins,
      0.7,
      undefined,
      hooks,
    );
    const ctx = createMockContext();

    await pipeline.execute(ctx, []);

    expect(hooks.wrapLLMCall).toHaveBeenCalled();
  });

  test('records metric via metrics collector', async () => {
    const metrics: any = { recordPrediction: vi.fn() };
    const steps = [
      {
        name: 'step',
        layer: 'fast',
        execute: vi.fn().mockResolvedValue({ intent: 'x', confidence: 0.9, source: 'fast' }),
      },
    ];
    const pipeline = new NLUTaskPipeline<IntentResult>(
      'intent_detection',
      steps,
      defaultResult,
      plugins,
      0.7,
      metrics,
    );
    const ctx = createMockContext();

    await pipeline.execute(ctx, []);

    expect(metrics.recordPrediction).toHaveBeenCalled();
    const event = metrics.recordPrediction.mock.calls[0][0];
    expect(event.task).toBe('intent_detection');
    expect(event.confidence).toBe(0.9);
  });

  test('stores result in cache when storeCache hook is present', async () => {
    const hooks = {
      storeCache: vi.fn().mockResolvedValue(undefined),
    };
    const steps = [
      {
        name: 'step',
        layer: 'fast',
        execute: vi.fn().mockResolvedValue({ intent: 'x', confidence: 0.9, source: 'fast' }),
      },
    ];
    const pipeline = new NLUTaskPipeline<IntentResult>(
      'intent_detection',
      steps,
      defaultResult,
      plugins,
      0.7,
      undefined,
      hooks,
    );
    const ctx = createMockContext();

    await pipeline.execute(ctx, []);

    expect(hooks.storeCache).toHaveBeenCalled();
  });
});

// =============================================================================
// PROMPT LOADER TESTS
// =============================================================================

describe('Prompt Loader', () => {
  describe('loadPromptTemplate', () => {
    test('loads embedded intent template', () => {
      const template = loadPromptTemplate('intent');
      expect(template.system).toContain('intent classification');
    });

    test('loads embedded entity template', () => {
      const template = loadPromptTemplate('entity');
      expect(template.system).toContain('entity extraction');
    });

    test('loads embedded category template', () => {
      const template = loadPromptTemplate('category');
      expect(template.system).toContain('category classifier');
    });

    test('loads embedded correction template', () => {
      const template = loadPromptTemplate('correction');
      expect(template.system).toContain('correction detection');
    });

    test('loads embedded combined template', () => {
      const template = loadPromptTemplate('combined');
      expect(template.system).toContain('NLU engine');
    });

    test('loads embedded language template', () => {
      const template = loadPromptTemplate('language');
      expect(template.system).toContain('language');
    });

    test('returns minimal fallback for unknown task', () => {
      const template = loadPromptTemplate('unknown_task');
      expect(template.system).toContain('Analyze');
    });

    test('falls back to embedded when override path does not exist', () => {
      const template = loadPromptTemplate('intent', '/nonexistent/path.yaml');
      expect(template.system).toContain('intent classification');
    });
  });

  describe('getEmbeddedPrompts', () => {
    test('returns all embedded prompts', () => {
      const prompts = getEmbeddedPrompts();
      expect(Object.keys(prompts)).toContain('intent');
      expect(Object.keys(prompts)).toContain('entity');
      expect(Object.keys(prompts)).toContain('category');
      expect(Object.keys(prompts)).toContain('correction');
      expect(Object.keys(prompts)).toContain('combined');
      expect(Object.keys(prompts)).toContain('language');
    });

    test('returns a copy (not the original)', () => {
      const prompts1 = getEmbeddedPrompts();
      const prompts2 = getEmbeddedPrompts();
      expect(prompts1).toEqual(prompts2);
      expect(prompts1).not.toBe(prompts2);
    });
  });

  describe('renderTemplate', () => {
    test('replaces simple variables', () => {
      const result = renderTemplate('Hello {{name}}, welcome to {{place}}', {
        name: 'Alice',
        place: 'Wonderland',
      });
      expect(result).toBe('Hello Alice, welcome to Wonderland');
    });

    test('handles undefined variables as empty string', () => {
      const result = renderTemplate('Hello {{name}}', {});
      expect(result).toBe('Hello');
    });

    test('renders if blocks when condition is truthy', () => {
      const result = renderTemplate('{{#if show}}visible{{/if}}', { show: true });
      expect(result).toBe('visible');
    });

    test('hides if blocks when condition is falsy', () => {
      const result = renderTemplate('{{#if show}}visible{{/if}} rest', { show: false });
      expect(result).toBe('rest');
    });

    test('hides if blocks when condition is empty string', () => {
      const result = renderTemplate('start {{#if val}}content{{/if}} end', { val: '' });
      expect(result).toBe('start  end');
    });

    test('renders each blocks', () => {
      const result = renderTemplate('{{#each items}}[{{this}}]{{/each}}', {
        items: ['a', 'b', 'c'],
      });
      expect(result).toBe('[a][b][c]');
    });

    test('renders each blocks with empty array', () => {
      const result = renderTemplate('{{#each items}}[{{this}}]{{/each}}', { items: [] });
      expect(result).toBe('');
    });

    test('serializes object variables as JSON', () => {
      const result = renderTemplate('data: {{obj}}', { obj: { x: 1 } });
      expect(result).toBe('data: {"x":1}');
    });

    test('cleans up multiple blank lines', () => {
      const result = renderTemplate('line1\n\n\n\n\nline2', {});
      expect(result).toBe('line1\n\nline2');
    });

    test('nested if inside template', () => {
      const result = renderTemplate('{{#if domain}}Domain: {{domain}}{{/if}} Goal: {{goal}}', {
        domain: 'travel',
        goal: 'booking',
      });
      expect(result).toBe('Domain: travel Goal: booking');
    });
  });
});

// =============================================================================
// FALLBACK TESTS
// =============================================================================

describe('Fallback Layer', () => {
  describe('detectIntentFallback', () => {
    const candidates: IntentCandidate[] = [
      { name: 'book', patterns: ['book', 'reserve'], examples: ['I want to book a room'] },
      { name: 'cancel', patterns: ['cancel', 'remove'] },
    ];

    test('matches keyword in message', () => {
      const result = detectIntentFallback('I want to book a hotel', candidates);
      expect(result.intent).toBe('book');
      expect(result.confidence).toBe(0.7); // CONFIDENCE_KEYWORD_MATCH
      expect(result.source).toBe('fallback');
    });

    test('matches exact example', () => {
      const result = detectIntentFallback('I want to book a room', candidates);
      // Should match keyword first (book is in patterns)
      expect(result.intent).toBe('book');
    });

    test('matches quoted phrase pattern', () => {
      const phraseCandidates: IntentCandidate[] = [
        { name: 'check_status', patterns: ['"check my status"'] },
      ];
      const result = detectIntentFallback('please check my status now', phraseCandidates);
      expect(result.intent).toBe('check_status');
      expect(result.confidence).toBe(0.8); // CONFIDENCE_PHRASE_MATCH
    });

    test('returns null when no match', () => {
      const result = detectIntentFallback('what is the weather', candidates);
      expect(result.intent).toBeNull();
      expect(result.confidence).toBe(0);
    });

    test('is case-insensitive', () => {
      const result = detectIntentFallback('PLEASE CANCEL MY RESERVATION', candidates);
      expect(result.intent).toBe('cancel');
    });
  });

  describe('classifyCategoryFallback', () => {
    const categories: CategoryDefinition[] = [
      { name: 'greeting', patterns: ['hello', 'hi'] },
      { name: 'farewell', patterns: ['bye', 'goodbye'] },
    ];

    test('matches category pattern', () => {
      const result = classifyCategoryFallback('hello there', categories);
      expect(result.category).toBe('greeting');
      expect(result.source).toBe('fallback');
    });

    test('returns null when no match', () => {
      const result = classifyCategoryFallback('random text', categories);
      expect(result.category).toBeNull();
    });

    test('is case-insensitive', () => {
      const result = classifyCategoryFallback('GOODBYE!', categories);
      expect(result.category).toBe('farewell');
    });
  });

  describe('detectCorrectionFallback', () => {
    const collectedData = { city: 'Paris', guests: 2 };

    test('detects correction with "actually" pattern', () => {
      const result = detectCorrectionFallback('actually London', collectedData);
      expect(result.detected).toBe(true);
      // The fallback lowercases the message before matching, so captured value is lowercase
      expect(result.newValue).toBe('london');
      expect(result.source).toBe('fallback');
    });

    test('detects correction with "change it to" pattern', () => {
      const result = detectCorrectionFallback('change it to 3', collectedData);
      expect(result.detected).toBe(true);
    });

    test('returns no correction for normal text', () => {
      const result = detectCorrectionFallback('that sounds good', collectedData);
      expect(result.detected).toBe(false);
    });
  });

  describe('detectLanguageFallback', () => {
    test('detects Spanish', () => {
      const result = detectLanguageFallback('hola, quiero reservar');
      expect(result.primary).toBe('es');
      expect(result.isCodeSwitched).toBe(false);
    });

    test('detects French', () => {
      const result = detectLanguageFallback('bonjour, je veux');
      expect(result.primary).toBe('fr');
    });

    test('detects German', () => {
      const result = detectLanguageFallback('hallo, ich möchte');
      expect(result.primary).toBe('de');
    });

    test('detects Arabic script', () => {
      const result = detectLanguageFallback('مرحبا');
      expect(result.primary).toBe('ar');
    });

    test('detects Chinese characters', () => {
      const result = detectLanguageFallback('你好世界');
      expect(result.primary).toBe('zh');
    });

    test('detects Japanese', () => {
      const result = detectLanguageFallback('こんにちは');
      expect(result.primary).toBe('ja');
    });

    test('defaults to English', () => {
      const result = detectLanguageFallback('just some regular text');
      expect(result.primary).toBe('en');
      expect(result.confidence).toBe(0.5); // CONFIDENCE_FALLBACK
    });
  });
});

// =============================================================================
// LANGUAGE UTILITIES TESTS
// =============================================================================

describe('Language Utilities', () => {
  describe('LanguageSessionCache', () => {
    test('set and get language', () => {
      const cache = new LanguageSessionCache(60000);
      cache.set('session-1', 'es');

      expect(cache.get('session-1')).toBe('es');
    });

    test('returns null for unknown session', () => {
      const cache = new LanguageSessionCache();
      expect(cache.get('unknown')).toBeNull();
    });

    test('expires after TTL', () => {
      const cache = new LanguageSessionCache(100);
      cache.set('session-1', 'fr');

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 200);
      expect(cache.get('session-1')).toBeNull();
      vi.restoreAllMocks();
    });

    test('clear removes specific session', () => {
      const cache = new LanguageSessionCache();
      cache.set('session-1', 'de');
      cache.clear('session-1');

      expect(cache.get('session-1')).toBeNull();
    });
  });

  describe('getDateFormat', () => {
    test('returns MDY for en-US', () => {
      expect(getDateFormat('en-US')).toBe('MDY');
    });

    test('returns MDY for en', () => {
      expect(getDateFormat('en')).toBe('MDY');
    });

    test('returns YMD for Chinese', () => {
      expect(getDateFormat('zh')).toBe('YMD');
    });

    test('returns YMD for Japanese', () => {
      expect(getDateFormat('ja')).toBe('YMD');
    });

    test('returns DMY for most other locales', () => {
      expect(getDateFormat('fr')).toBe('DMY');
      expect(getDateFormat('de')).toBe('DMY');
      expect(getDateFormat('es')).toBe('DMY');
    });
  });

  describe('getDecimalSeparator', () => {
    test('returns dot for English', () => {
      expect(getDecimalSeparator('en')).toBe('.');
    });

    test('returns comma for French', () => {
      expect(getDecimalSeparator('fr')).toBe(',');
    });

    test('returns dot for Chinese', () => {
      expect(getDecimalSeparator('zh')).toBe('.');
    });
  });

  describe('filterExamplesByLanguage', () => {
    const examples = [
      { input: 'book', output: 'book', language: 'en' },
      { input: 'reservar', output: 'book', language: 'es' },
      { input: 'réserver', output: 'book', language: 'fr' },
    ];

    test('filters to matching language', () => {
      const result = filterExamplesByLanguage(examples, 'es');
      expect(result.length).toBe(1);
      expect(result[0].input).toBe('reservar');
    });

    test('returns all examples when no language matches', () => {
      const result = filterExamplesByLanguage(examples, 'de');
      expect(result.length).toBe(3);
    });

    test('returns all when examples have no language tag', () => {
      const untagged = [
        { input: 'book', output: 'book' },
        { input: 'cancel', output: 'cancel' },
      ];
      const result = filterExamplesByLanguage(untagged, 'en');
      expect(result.length).toBe(2);
    });
  });

  describe('detectLanguage (LLM-based)', () => {
    test('parses LLM response with primary language', async () => {
      const layerConfig = {
        provider: createMockProvider(
          '{"primary": "es", "confidence": 0.95, "isCodeSwitched": false}',
        ),
        model: 'fast-model',
        timeoutMs: 2000,
      };

      const result = await detectLanguage('hola mundo', layerConfig);

      expect(result.primary).toBe('es');
      expect(result.confidence).toBe(0.95);
    });

    test('detects code-switching', async () => {
      const layerConfig = {
        provider: createMockProvider(
          '{"primary": "en", "secondary": "es", "isCodeSwitched": true, "confidence": 0.85}',
        ),
        model: 'fast-model',
      };

      const result = await detectLanguage('Hello, quiero reservar', layerConfig);

      expect(result.primary).toBe('en');
      expect(result.secondary).toBe('es');
      expect(result.isCodeSwitched).toBe(true);
    });

    test('falls back to regex on LLM error', async () => {
      const layerConfig = {
        provider: createMockProvider(),
        model: 'fast-model',
      };
      (layerConfig.provider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));

      const result = await detectLanguage('bonjour', layerConfig);

      expect(result.primary).toBe('fr');
    });

    test('falls back to regex on unparseable response', async () => {
      const layerConfig = {
        provider: createMockProvider('not json'),
        model: 'fast-model',
      };

      const result = await detectLanguage('hello world', layerConfig);

      expect(result.primary).toBe('en');
    });
  });
});

// =============================================================================
// METRICS TESTS
// =============================================================================

describe('Metrics', () => {
  describe('InMemoryMetricsCollector', () => {
    function makeEvent(overrides: Partial<NLUPredictionEvent> = {}): NLUPredictionEvent {
      return {
        sessionId: 'sess-1',
        timestamp: new Date(),
        task: 'intent_detection',
        input: 'test',
        language: 'en',
        modelUsed: 'fast-model',
        layerUsed: 'fast',
        prediction: 'book',
        confidence: 0.9,
        latencyMs: 100,
        ...overrides,
      };
    }

    test('records and retrieves predictions', () => {
      const collector = new InMemoryMetricsCollector();
      collector.recordPrediction(makeEvent());
      collector.recordPrediction(makeEvent({ task: 'entity_extraction' }));

      const metrics = collector.getMetrics();

      expect(metrics.totalPredictions).toBe(2);
      expect(metrics.byTask['intent_detection'].count).toBe(1);
      expect(metrics.byTask['entity_extraction'].count).toBe(1);
    });

    test('groups by model', () => {
      const collector = new InMemoryMetricsCollector();
      collector.recordPrediction(makeEvent({ modelUsed: 'model-a' }));
      collector.recordPrediction(makeEvent({ modelUsed: 'model-b' }));
      collector.recordPrediction(makeEvent({ modelUsed: 'model-a' }));

      const metrics = collector.getMetrics();

      expect(metrics.byModel['model-a'].count).toBe(2);
      expect(metrics.byModel['model-b'].count).toBe(1);
    });

    test('groups by language', () => {
      const collector = new InMemoryMetricsCollector();
      collector.recordPrediction(makeEvent({ language: 'en' }));
      collector.recordPrediction(makeEvent({ language: 'es' }));
      collector.recordPrediction(makeEvent({ language: 'en' }));

      const metrics = collector.getMetrics();

      expect(metrics.byLanguage['en'].count).toBe(2);
      expect(metrics.byLanguage['es'].count).toBe(1);
    });

    test('filters by time range', () => {
      const collector = new InMemoryMetricsCollector();
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600000);
      const twoHoursAgo = new Date(now.getTime() - 7200000);

      collector.recordPrediction(makeEvent({ timestamp: twoHoursAgo }));
      collector.recordPrediction(makeEvent({ timestamp: now }));

      const metrics = collector.getMetrics({ from: oneHourAgo, to: now });

      expect(metrics.totalPredictions).toBe(1);
    });

    test('evicts old events when max exceeded', () => {
      const collector = new InMemoryMetricsCollector(5);
      for (let i = 0; i < 10; i++) {
        collector.recordPrediction(makeEvent({ input: `msg-${i}` }));
      }

      const metrics = collector.getMetrics();
      expect(metrics.totalPredictions).toBe(5);
    });

    test('markPrediction marks the most recent matching event', () => {
      const collector = new InMemoryMetricsCollector();
      collector.recordPrediction(makeEvent({ sessionId: 'sess-1', task: 'intent_detection' }));
      collector.recordPrediction(makeEvent({ sessionId: 'sess-1', task: 'entity_extraction' }));

      collector.markPrediction('sess-1', 'intent_detection', false, 'corrected_intent');

      const events = collector.getRawEvents();
      const marked = events.find((e) => e.task === 'intent_detection');
      expect(marked?.wasCorrect).toBe(false);
      expect(marked?.correctedValue).toBe('corrected_intent');
    });

    test('calculates average confidence', () => {
      const collector = new InMemoryMetricsCollector();
      collector.recordPrediction(makeEvent({ confidence: 0.8 }));
      collector.recordPrediction(makeEvent({ confidence: 1.0 }));

      const metrics = collector.getMetrics();
      expect(metrics.byTask['intent_detection'].avgConfidence).toBeCloseTo(0.9);
    });

    test('calculates fallback rate', () => {
      const collector = new InMemoryMetricsCollector();
      collector.recordPrediction(makeEvent({ layerUsed: 'fast' }));
      collector.recordPrediction(makeEvent({ layerUsed: 'fallback' }));
      collector.recordPrediction(makeEvent({ layerUsed: 'fast' }));

      const metrics = collector.getMetrics();
      expect(metrics.byTask['intent_detection'].fallbackRate).toBeCloseTo(1 / 3);
    });

    test('clear removes all events', () => {
      const collector = new InMemoryMetricsCollector();
      collector.recordPrediction(makeEvent());
      collector.clear();

      const metrics = collector.getMetrics();
      expect(metrics.totalPredictions).toBe(0);
    });
  });

  describe('TenantScopedMetrics', () => {
    test('tracks metrics per tenant', () => {
      const tsm = new TenantScopedMetrics();
      tsm.recordForTenant('tenant-a', {
        sessionId: 's1',
        timestamp: new Date(),
        task: 'intent_detection',
        input: 'test',
        language: 'en',
        modelUsed: 'fast',
        layerUsed: 'fast',
        prediction: 'x',
        confidence: 0.9,
        latencyMs: 100,
      });
      tsm.recordForTenant('tenant-b', {
        sessionId: 's2',
        timestamp: new Date(),
        task: 'entity_extraction',
        input: 'test',
        language: 'es',
        modelUsed: 'fast',
        layerUsed: 'fast',
        prediction: 'y',
        confidence: 0.8,
        latencyMs: 200,
      });

      const metricsA = tsm.getMetricsForTenant('tenant-a');
      expect(metricsA.totalPredictions).toBe(1);
      expect(metricsA.byTask['intent_detection']).toBeDefined();

      const metricsB = tsm.getMetricsForTenant('tenant-b');
      expect(metricsB.totalPredictions).toBe(1);
    });

    test('returns empty metrics for unknown tenant', () => {
      const tsm = new TenantScopedMetrics();
      const metrics = tsm.getMetricsForTenant('unknown');
      expect(metrics.totalPredictions).toBe(0);
    });

    test('aggregates metrics across tenants', () => {
      const tsm = new TenantScopedMetrics();
      tsm.recordForTenant('t1', {
        sessionId: 's1',
        timestamp: new Date(),
        task: 'intent_detection',
        input: 'test',
        language: 'en',
        modelUsed: 'fast',
        layerUsed: 'fast',
        prediction: 'x',
        confidence: 0.9,
        latencyMs: 100,
      });
      tsm.recordForTenant('t2', {
        sessionId: 's2',
        timestamp: new Date(),
        task: 'intent_detection',
        input: 'test',
        language: 'en',
        modelUsed: 'fast',
        layerUsed: 'fast',
        prediction: 'y',
        confidence: 0.8,
        latencyMs: 200,
      });

      const aggregate = tsm.getAggregateMetrics();
      expect(aggregate.totalPredictions).toBe(2);
      expect(aggregate.byTask['intent_detection'].count).toBe(2);
    });

    test('getTenantIds returns all tracked tenants', () => {
      const tsm = new TenantScopedMetrics();
      tsm.recordForTenant('t1', {
        sessionId: 's1',
        timestamp: new Date(),
        task: 'intent_detection',
        input: 'test',
        language: 'en',
        modelUsed: 'fast',
        layerUsed: 'fast',
        prediction: 'x',
        confidence: 0.9,
        latencyMs: 100,
      });
      tsm.recordForTenant('t2', {
        sessionId: 's2',
        timestamp: new Date(),
        task: 'intent_detection',
        input: 'test',
        language: 'en',
        modelUsed: 'fast',
        layerUsed: 'fast',
        prediction: 'y',
        confidence: 0.8,
        latencyMs: 100,
      });

      expect(tsm.getTenantIds()).toEqual(expect.arrayContaining(['t1', 't2']));
    });

    test('clearTenant removes specific tenant', () => {
      const tsm = new TenantScopedMetrics();
      tsm.recordForTenant('t1', {
        sessionId: 's1',
        timestamp: new Date(),
        task: 'intent_detection',
        input: 'test',
        language: 'en',
        modelUsed: 'fast',
        layerUsed: 'fast',
        prediction: 'x',
        confidence: 0.9,
        latencyMs: 100,
      });
      tsm.clearTenant('t1');

      expect(tsm.getMetricsForTenant('t1').totalPredictions).toBe(0);
    });

    test('clearAll removes all tenants', () => {
      const tsm = new TenantScopedMetrics();
      tsm.recordForTenant('t1', {
        sessionId: 's1',
        timestamp: new Date(),
        task: 'intent_detection',
        input: 'test',
        language: 'en',
        modelUsed: 'fast',
        layerUsed: 'fast',
        prediction: 'x',
        confidence: 0.9,
        latencyMs: 100,
      });
      tsm.clearAll();

      expect(tsm.getTenantIds()).toEqual([]);
    });
  });
});

// =============================================================================
// NLU CONTEXT BUILDER TESTS
// =============================================================================

describe('NLUContextBuilder', () => {
  describe('determinePhase', () => {
    test('returns complete when flow is complete', () => {
      const phase = NLUContextBuilder.determinePhase({
        currentStep: 'done',
        collectedData: {},
        stepHistory: [],
        isComplete: true,
      } as any);
      expect(phase).toBe('complete');
    });

    test('returns digressing when in digression', () => {
      const phase = NLUContextBuilder.determinePhase({
        currentStep: 'x',
        collectedData: {},
        stepHistory: ['a'],
        inDigression: true,
      } as any);
      expect(phase).toBe('digressing');
    });

    test('returns greeting when no step history', () => {
      const phase = NLUContextBuilder.determinePhase(
        {
          currentStep: 'start',
          collectedData: {},
          stepHistory: [],
        } as any,
        'start',
      );
      expect(phase).toBe('greeting');
    });

    test('returns collecting when data has been collected', () => {
      const phase = NLUContextBuilder.determinePhase({
        currentStep: 'gather',
        collectedData: { city: 'Paris' },
        stepHistory: ['start', 'gather'],
      } as any);
      expect(phase).toBe('collecting');
    });

    test('returns collecting by default', () => {
      const phase = NLUContextBuilder.determinePhase({
        currentStep: 'step1',
        collectedData: {},
        stepHistory: ['step1'],
      } as any);
      expect(phase).toBe('collecting');
    });

    test('returns greeting when no flow state and phase is start', () => {
      const phase = NLUContextBuilder.determinePhase(undefined, 'start');
      expect(phase).toBe('greeting');
    });
  });

  describe('extractPendingQuestion', () => {
    test('extracts question from last assistant message', () => {
      const history = [
        { role: 'user' as const, content: 'hi' },
        { role: 'assistant' as const, content: 'What city would you like to visit?' },
      ];
      expect(NLUContextBuilder.extractPendingQuestion(history)).toBe(
        'What city would you like to visit?',
      );
    });

    test('returns undefined when last assistant message has no question', () => {
      const history = [{ role: 'assistant' as const, content: 'Great, I will help you.' }];
      expect(NLUContextBuilder.extractPendingQuestion(history)).toBeUndefined();
    });

    test('returns undefined for empty history', () => {
      expect(NLUContextBuilder.extractPendingQuestion([])).toBeUndefined();
    });

    test('returns undefined for undefined history', () => {
      expect(NLUContextBuilder.extractPendingQuestion(undefined)).toBeUndefined();
    });

    test('extracts last question from multi-sentence message', () => {
      const history = [
        {
          role: 'assistant' as const,
          content: 'I found some hotels. Which one do you prefer? You can choose from the list.',
        },
      ];
      // The last question should be extracted
      const result = NLUContextBuilder.extractPendingQuestion(history);
      expect(result).toContain('?');
    });
  });

  describe('inferDialogAct', () => {
    test('detects greeting', () => {
      expect(NLUContextBuilder.inferDialogAct('hello there')).toBe('greeting');
      expect(NLUContextBuilder.inferDialogAct('Hey!')).toBe('greeting');
      expect(NLUContextBuilder.inferDialogAct('Good morning')).toBe('greeting');
    });

    test('detects farewell', () => {
      expect(NLUContextBuilder.inferDialogAct('bye')).toBe('farewell');
      expect(NLUContextBuilder.inferDialogAct('thanks for your help')).toBe('farewell');
    });

    test('detects confirmation', () => {
      expect(NLUContextBuilder.inferDialogAct('yes please')).toBe('confirmation');
      expect(NLUContextBuilder.inferDialogAct('ok sounds good')).toBe('confirmation');
      expect(NLUContextBuilder.inferDialogAct('correct')).toBe('confirmation');
    });

    test('detects denial', () => {
      expect(NLUContextBuilder.inferDialogAct('no that is wrong')).toBe('denial');
      expect(NLUContextBuilder.inferDialogAct('nope')).toBe('denial');
    });

    test('detects correction', () => {
      expect(NLUContextBuilder.inferDialogAct('actually I meant London')).toBe('correction');
      expect(NLUContextBuilder.inferDialogAct('I meant something else')).toBe('correction');
    });

    test('detects complaint', () => {
      expect(NLUContextBuilder.inferDialogAct('this is terrible service')).toBe('complaint');
      expect(NLUContextBuilder.inferDialogAct('I am frustrated with this')).toBe('complaint');
    });

    test('detects question', () => {
      expect(NLUContextBuilder.inferDialogAct('what time is checkout?')).toBe('question');
      expect(NLUContextBuilder.inferDialogAct('how much does it cost?')).toBe('question');
    });

    test('detects command', () => {
      expect(NLUContextBuilder.inferDialogAct('book a room for tonight')).toBe('command');
      expect(NLUContextBuilder.inferDialogAct('cancel my reservation')).toBe('command');
      expect(NLUContextBuilder.inferDialogAct('find me a hotel')).toBe('command');
    });

    test('returns answer when pending question exists', () => {
      expect(NLUContextBuilder.inferDialogAct('Paris', 'What city?')).toBe('answer');
    });

    test('returns information as default', () => {
      expect(NLUContextBuilder.inferDialogAct('the color is blue')).toBe('information');
    });
  });

  describe('gatherIntents', () => {
    test('returns ABL intents when no dynamic intents', () => {
      const intents = NLUContextBuilder.gatherIntents({
        intents: [{ name: 'book', patterns: ['book'] }],
        categories: [],
        entities: [],
        glossary: [],
      });
      expect(intents.length).toBe(1);
      expect(intents[0].name).toBe('book');
    });

    test('merges ABL and dynamic intents', () => {
      const intents = NLUContextBuilder.gatherIntents(
        {
          intents: [{ name: 'book', patterns: ['book'] }],
          categories: [],
          entities: [],
          glossary: [],
        },
        { _dynamic_intents: [{ name: 'cancel', patterns: ['cancel'] }] },
      );
      expect(intents.length).toBe(2);
    });

    test('returns empty array when no config', () => {
      const intents = NLUContextBuilder.gatherIntents(undefined);
      expect(intents).toEqual([]);
    });
  });

  describe('buildFewShotExamples', () => {
    test('builds examples from intent definitions', () => {
      const intents = [
        { name: 'book', patterns: ['book'], examples: ['book a room', 'reserve a hotel'] },
        { name: 'cancel', patterns: ['cancel'] },
      ];
      const examples = NLUContextBuilder.buildFewShotExamples(intents);

      expect(examples.length).toBe(2);
      expect(examples[0].input).toBe('book a room');
      expect(examples[0].output).toBe('intent: book');
      expect(examples[0].intent).toBe('book');
    });

    test('returns empty array for intents with no examples', () => {
      const intents = [{ name: 'book', patterns: ['book'] }];
      const examples = NLUContextBuilder.buildFewShotExamples(intents);
      expect(examples).toEqual([]);
    });
  });

  describe('determineMissingFields', () => {
    test('returns waiting fields from flow state', () => {
      const result = NLUContextBuilder.determineMissingFields({
        waitingForInput: ['city', 'date', '_on_input_'],
      } as any);
      expect(result).toEqual(['city', 'date']);
    });

    test('returns undefined when not waiting for input', () => {
      const result = NLUContextBuilder.determineMissingFields({} as any);
      expect(result).toBeUndefined();
    });
  });
});

// =============================================================================
// NLU ENGINE TESTS
// =============================================================================

describe('NLUEngine', () => {
  describe('factory methods', () => {
    test('fromLLMClient creates engine with fast layer', () => {
      const provider = createMockProvider();
      const engine = NLUEngine.fromLLMClient(provider as any);

      expect(engine).toBeInstanceOf(NLUEngine);
    });

    test('fromAgentIR creates engine from agent IR without NLU config', () => {
      const provider = createMockProvider();
      const agentIR = {
        identity: { name: 'test', goal: 'test agent', persona: '' },
        // mode is deprecated — execution style derived from flow presence
        execution: {} as any,
      };
      const engine = NLUEngine.fromAgentIR(agentIR as any, provider as any);

      expect(engine).toBeInstanceOf(NLUEngine);
    });

    test('fromAgentIR creates engine with NLU config', () => {
      const provider = createMockProvider();
      const agentIR = {
        identity: { name: 'test', goal: 'test agent', persona: '' },
        // mode is deprecated — execution style derived from flow presence
        execution: {} as any,
        nlu: {
          models: { fast: 'fast-model', balanced: 'balanced-model' },
          intents: [{ name: 'book', patterns: ['book'] }],
          categories: [{ name: 'greeting', patterns: ['hi'] }],
          entities: [{ name: 'city', type: 'enum' as const, values: ['Paris', 'London'] }],
          glossary: [],
          evaluation: { confidenceThreshold: 0.85 },
        },
      };
      const engine = NLUEngine.fromAgentIR(agentIR as any, provider as any);

      expect(engine).toBeInstanceOf(NLUEngine);
      expect(engine.getActiveIntents().length).toBe(1);
      expect(engine.getActiveCategories().length).toBe(1);
      expect(engine.getActiveEntities().length).toBe(1);
    });
  });

  describe('dynamic registration', () => {
    test('registerIntents adds intents', () => {
      const engine = NLUEngine.fromLLMClient(createMockProvider() as any);
      engine.registerIntents([{ name: 'book', patterns: ['book'] }]);
      engine.registerIntents([{ name: 'cancel', patterns: ['cancel'] }]);

      expect(engine.getActiveIntents().length).toBe(2);
    });

    test('unregisterIntents removes specific intents', () => {
      const engine = NLUEngine.fromLLMClient(createMockProvider() as any);
      engine.registerIntents([
        { name: 'book', patterns: ['book'] },
        { name: 'cancel', patterns: ['cancel'] },
      ]);
      engine.unregisterIntents(['cancel']);

      expect(engine.getActiveIntents().length).toBe(1);
      expect(engine.getActiveIntents()[0].name).toBe('book');
    });

    test('registerCategories adds categories', () => {
      const engine = NLUEngine.fromLLMClient(createMockProvider() as any);
      engine.registerCategories([{ name: 'greeting', patterns: ['hi'] }]);

      expect(engine.getActiveCategories().length).toBe(1);
    });

    test('registerEntities adds entities', () => {
      const engine = NLUEngine.fromLLMClient(createMockProvider() as any);
      engine.registerEntities([{ name: 'city', type: 'enum', values: ['Paris'] }]);

      expect(engine.getActiveEntities().length).toBe(1);
    });
  });

  describe('detectIntent', () => {
    test('detects intent from LLM response', async () => {
      const provider = createMockProvider('{"intent": "book_hotel", "confidence": 0.92}');
      const engine = NLUEngine.fromLLMClient(provider as any);
      const ctx = createMockContext({ userMessage: 'I want to book a hotel' });
      const candidates: IntentCandidate[] = [{ name: 'book_hotel', patterns: ['book', 'hotel'] }];

      const result = await engine.detectIntent(ctx, candidates);

      expect(result.intent).toBe('book_hotel');
      expect(result.confidence).toBe(0.92);
    });

    test('falls back to regex when LLM confidence is low', async () => {
      const provider = createMockProvider('{"intent": "book_hotel", "confidence": 0.3}');
      const engine = NLUEngine.fromLLMClient(provider as any);
      const ctx = createMockContext({ userMessage: 'book a hotel' });
      const candidates: IntentCandidate[] = [{ name: 'book_hotel', patterns: ['book'] }];

      const result = await engine.detectIntent(ctx, candidates);

      // Should fall through to fallback and match keyword
      expect(result.intent).toBe('book_hotel');
      expect(result.source).toBe('fallback');
    });

    test('returns null intent when no match found', async () => {
      const provider = createMockProvider('{"intent": "none", "confidence": 0}');
      const config: NLUEngineConfig = {
        layers: { fast: { provider: provider as any, model: 'fast', timeoutMs: 2000 } },
        enableFallbacks: true,
        confidenceThreshold: 0.7,
      };
      const engine = new NLUEngine(config);
      const ctx = createMockContext({ userMessage: 'xyz unknown gibberish' });
      const candidates: IntentCandidate[] = [{ name: 'book', patterns: ['book'] }];

      const result = await engine.detectIntent(ctx, candidates);

      expect(result.intent).toBeNull();
    });

    test('uses plugin result when available', async () => {
      const pluginResult = { intent: 'plugin_intent', confidence: 0.99, source: 'plugin' as const };
      const plugin: NLUPlugin = {
        name: 'test-plugin',
        preProcess: vi.fn().mockResolvedValue(pluginResult),
      };
      const config: NLUEngineConfig = {
        layers: { fast: { provider: createMockProvider() as any, model: 'fast' } },
        plugins: [plugin],
      };
      const engine = new NLUEngine(config);
      const ctx = createMockContext();

      const result = await engine.detectIntent(ctx, []);

      expect(result.intent).toBe('plugin_intent');
      expect(result.source).toBe('plugin');
    });
  });

  describe('detectSubIntent', () => {
    test('delegates to detectIntent with converted candidates', async () => {
      const provider = createMockProvider('{"intent": "modify_dates", "confidence": 0.88}');
      const engine = NLUEngine.fromLLMClient(provider as any);
      const ctx = createMockContext({ userMessage: 'change dates' });

      const result = await engine.detectSubIntent(ctx, 'book_hotel', [
        { name: 'modify_dates', patterns: ['change dates'] },
      ]);

      expect(result.subIntent).toBe('modify_dates');
      expect(result.confidence).toBe(0.88);
    });
  });

  describe('classifyCategory', () => {
    test('classifies category from LLM', async () => {
      const provider = createMockProvider('{"category": "greeting", "confidence": 0.95}');
      const engine = NLUEngine.fromLLMClient(provider as any);
      const ctx = createMockContext({ userMessage: 'hello' });

      const result = await engine.classifyCategory(ctx, [
        { name: 'greeting', patterns: ['hello', 'hi'] },
      ]);

      expect(result.category).toBe('greeting');
      expect(result.confidence).toBe(0.95);
    });

    test('falls back to regex when LLM fails', async () => {
      const provider = createMockProvider();
      (provider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      const engine = NLUEngine.fromLLMClient(provider as any);
      const ctx = createMockContext({ userMessage: 'goodbye' });

      const result = await engine.classifyCategory(ctx, [
        { name: 'farewell', patterns: ['bye', 'goodbye'] },
      ]);

      expect(result.category).toBe('farewell');
      expect(result.source).toBe('fallback');
    });
  });

  describe('extractEntities', () => {
    test('extracts entities from LLM', async () => {
      const provider = createMockProvider('{"city": "Paris", "guests": 2}');
      const engine = NLUEngine.fromLLMClient(provider as any);
      const ctx = createMockContext({ userMessage: 'Book in Paris for 2' });

      const result = await engine.extractEntities(ctx, [
        { name: 'city', type: 'string' },
        { name: 'guests', type: 'number' },
      ]);

      expect(result.values.city).toBe('Paris');
      expect(result.values.guests).toBe(2);
      expect(result.missing).toEqual([]);
    });
  });

  describe('detectCorrection', () => {
    test('detects correction from LLM', async () => {
      const response =
        '{"detected": true, "field": "city", "newValue": "London", "confidence": 0.9}';
      const provider = createMockProvider(response);
      const engine = NLUEngine.fromLLMClient(provider as any);
      const ctx = createMockContext({ userMessage: 'actually London' });

      const result = await engine.detectCorrection(ctx, { city: 'Paris' });

      expect(result.detected).toBe(true);
      expect(result.field).toBe('city');
      expect(result.newValue).toBe('London');
      expect(result.oldValue).toBe('Paris');
    });
  });

  describe('detectDigression', () => {
    test('detects digression by delegating to detectIntent', async () => {
      const provider = createMockProvider('{"intent": "weather_query", "confidence": 0.85}');
      const engine = NLUEngine.fromLLMClient(provider as any);
      const ctx = createMockContext({ userMessage: 'what is the weather' });

      const result = await engine.detectDigression(ctx, [
        { intent: 'weather_query', keywords: ['weather'] },
      ]);

      expect(result.detected).toBe(true);
      expect(result.intent).toBe('weather_query');
    });

    test('falls back lexically using KEYWORDS when semantic classification is unavailable', async () => {
      const provider = createMockProvider();
      (provider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      const engine = NLUEngine.fromLLMClient(provider as any);
      const ctx = createMockContext({ userMessage: 'can I get the weather forecast?' });

      const result = await engine.detectDigression(ctx, [
        { intent: 'weather_query', keywords: ['weather', 'forecast'] },
      ]);

      expect(result.detected).toBe(true);
      expect(result.intent).toBe('weather_query');
      expect(result.source).toBe('fallback');
    });

    test('does not use semantic INTENT ids as lexical fallback text when KEYWORDS are absent', async () => {
      const provider = createMockProvider();
      (provider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      const engine = NLUEngine.fromLLMClient(provider as any);
      const ctx = createMockContext({ userMessage: 'help_request' });

      const result = await engine.detectDigression(ctx, [{ intent: 'help_request' }]);

      expect(result.detected).toBe(false);
      expect(result.intent).toBeUndefined();
    });
  });

  describe('detectLanguage', () => {
    test('detects language from string input', async () => {
      const provider = createMockProvider(
        '{"primary": "es", "confidence": 0.95, "isCodeSwitched": false}',
      );
      const engine = NLUEngine.fromLLMClient(provider as any);

      const result = await engine.detectLanguage('hola mundo');

      expect(result.primary).toBe('es');
    });

    test('detects language from NLUContext input', async () => {
      const provider = createMockProvider(
        '{"primary": "fr", "confidence": 0.9, "isCodeSwitched": false}',
      );
      const engine = NLUEngine.fromLLMClient(provider as any);
      const ctx = createMockContext({ userMessage: 'bonjour' });

      const result = await engine.detectLanguage(ctx);

      expect(result.primary).toBe('fr');
    });

    test('falls back to regex on LLM failure', async () => {
      const provider = createMockProvider();
      (provider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      const engine = NLUEngine.fromLLMClient(provider as any);

      const result = await engine.detectLanguage('hola');

      expect(result.primary).toBe('es');
    });
  });

  describe('analyzeInput', () => {
    test('combined analysis parses all fields', async () => {
      const combinedResponse = JSON.stringify({
        intent: { intent: 'book', confidence: 0.9 },
        category: { category: 'command', confidence: 0.85 },
        entities: { city: 'Paris' },
        correction: { detected: false },
      });
      const provider = createMockProvider(combinedResponse);
      const engine = NLUEngine.fromLLMClient(provider as any);
      const ctx = createMockContext({ userMessage: 'book in Paris' });

      const result = await engine.analyzeInput(ctx, {
        detectIntent: true,
        intents: [{ name: 'book', patterns: ['book'] }],
        classifyCategory: true,
        categories: [{ name: 'command', patterns: ['book'] }],
        extractEntities: true,
        entityFields: [{ name: 'city' }],
        detectCorrection: true,
      });

      expect(result.intent?.intent).toBe('book');
      expect(result.category?.category).toBe('command');
      expect(result.entities?.values.city).toBe('Paris');
      expect(result.correction?.detected).toBe(false);
    });

    test('falls back to individual tasks when combined fails', async () => {
      const provider = createMockProvider();
      // First call (combined) fails, subsequent calls succeed
      let callCount = 0;
      (provider.chat as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('combined failed');
        return '{"intent": "book", "confidence": 0.8}';
      });
      const engine = NLUEngine.fromLLMClient(provider as any);
      const ctx = createMockContext({ userMessage: 'book a hotel' });

      const result = await engine.analyzeInput(ctx, {
        detectIntent: true,
        intents: [{ name: 'book', patterns: ['book'] }],
      });

      // Should have fallen back and tried individual intent detection
      expect(result.intent).toBeDefined();
    });
  });

  describe('embedding index', () => {
    test('setEmbeddingIntentIndex enables embedding-based detection', async () => {
      const embeddingResult: IntentResult = {
        intent: 'book_hotel',
        confidence: 0.95,
        source: 'embedding',
      };
      const mockIndex = {
        match: vi.fn().mockResolvedValue(embeddingResult),
      };
      const provider = createMockProvider('{"intent": "none", "confidence": 0}');
      const config: NLUEngineConfig = {
        layers: { fast: { provider: provider as any, model: 'fast' } },
        embeddings: {
          provider: { embed: vi.fn(), dimension: 384, model: 'test' },
          threshold: 0.85,
        },
      };
      const engine = new NLUEngine(config);
      engine.setEmbeddingIntentIndex(mockIndex as any);

      const ctx = createMockContext({ userMessage: 'I want to book' });
      const result = await engine.detectIntent(ctx, [{ name: 'book_hotel', patterns: ['book'] }]);

      expect(result.intent).toBe('book_hotel');
      expect(result.source).toBe('embedding');
    });
  });
});
