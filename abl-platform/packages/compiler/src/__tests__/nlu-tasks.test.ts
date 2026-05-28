/**
 * NLU Tasks Tests
 *
 * Tests for: intent-detector, entity-extractor, category-classifier,
 * correction-detector, digression-detector, sub-intent-detector,
 * language-detector, combined-analyzer.
 *
 * All LLM providers are mocked. Focus is on logic, pipeline step creation,
 * fallback behavior, and result shaping.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  createIntentSteps,
  DEFAULT_INTENT_RESULT,
  buildTemplateVars,
  createEntitySteps,
  DEFAULT_ENTITY_RESULT,
  createCategorySteps,
  DEFAULT_CATEGORY_RESULT,
  createCorrectionSteps,
  DEFAULT_CORRECTION_RESULT,
  detectDigression,
  DEFAULT_DIGRESSION_RESULT,
  detectSubIntent,
  detectLanguageFromContext,
  analyzeInputCombined,
} from '../platform/nlu/tasks/index.js';
import { ModelRouter } from '../platform/nlu/model-router.js';
import { NLUTaskPipeline } from '../platform/nlu/pipeline.js';
import { NLUPluginPipeline } from '../platform/nlu/plugins.js';
import type {
  NLUContext,
  NLUEngineConfig,
  IntentResult,
  CategoryResult,
  EntityResult,
  CorrectionResult,
  IntentCandidate,
  SubIntentCandidate,
  DigressionCandidate,
  CategoryDefinition,
  EntityField,
  AnalyzeOptions,
} from '../platform/nlu/types.js';
import type { CombinedAnalyzerDeps } from '../platform/nlu/tasks/combined-analyzer.js';

// =============================================================================
// MOCK LLM PROVIDER
// =============================================================================

function createMockLLMProvider(chatResponse?: string, opts?: { withExtractJson?: boolean }) {
  const provider: Record<string, unknown> = {
    chat: vi.fn().mockResolvedValue(chatResponse ?? '{"intent": "none", "confidence": 0}'),
    chatWithTools: vi.fn().mockResolvedValue({ text: '', toolCalls: [] }),
    streamChat: vi.fn(),
  };
  if (opts?.withExtractJson) {
    provider.extractJson = vi.fn().mockResolvedValue({});
  }
  return provider;
}

// =============================================================================
// MOCK NLU CONTEXT
// =============================================================================

function createMockContext(overrides: Partial<NLUContext> = {}): NLUContext {
  return {
    userMessage: 'I want to book a hotel',
    conversationHistory: [],
    turnNumber: 1,
    conversationPhase: 'collecting',
    agentGoal: 'Hotel booking assistant',
    collectedData: {},
    ...overrides,
  };
}

// =============================================================================
// MOCK ENGINE CONFIG
// =============================================================================

function createMockEngineConfig(
  chatResponse?: string,
  opts?: { withExtractJson?: boolean },
): NLUEngineConfig {
  return {
    layers: {
      fast: {
        provider: createMockLLMProvider(chatResponse, opts) as any,
        model: 'fast-model',
        timeoutMs: 2000,
      },
    },
    enableFallbacks: true,
    confidenceThreshold: 0.7,
  };
}

function createMockEngineConfigWithBalanced(
  fastResponse?: string,
  balancedResponse?: string,
): NLUEngineConfig {
  return {
    layers: {
      fast: {
        provider: createMockLLMProvider(fastResponse) as any,
        model: 'fast-model',
        timeoutMs: 2000,
      },
      balanced: {
        provider: createMockLLMProvider(balancedResponse) as any,
        model: 'balanced-model',
        timeoutMs: 5000,
      },
    },
    enableFallbacks: true,
    confidenceThreshold: 0.7,
  };
}

// =============================================================================
// INTENT DETECTOR TESTS
// =============================================================================

describe('Intent Detector (createIntentSteps)', () => {
  const candidates: IntentCandidate[] = [
    { name: 'book_hotel', patterns: ['book', 'reserve', 'hotel'] },
    { name: 'cancel_booking', patterns: ['cancel', 'remove'] },
  ];

  test('creates steps with fast LLM and fallback when no balanced layer', () => {
    const config = createMockEngineConfig();
    const router = new ModelRouter(config);
    const steps = createIntentSteps(router);

    expect(steps.length).toBe(2); // fast LLM + regex fallback
    expect(steps[0].name).toBe('intent_fast_llm');
    expect(steps[0].layer).toBe('fast');
    expect(steps[1].name).toBe('intent_regex_fallback');
    expect(steps[1].layer).toBe('fallback');
  });

  test('creates steps with fast, balanced, and fallback layers', () => {
    const config = createMockEngineConfigWithBalanced();
    const router = new ModelRouter(config);
    const steps = createIntentSteps(router);

    // intent_detection maps to 'fast' by default, so fast is primary, balanced is fallback
    expect(steps.length).toBe(3);
    expect(steps[0].name).toBe('intent_fast_llm');
    expect(steps[1].name).toBe('intent_balanced_llm');
    expect(steps[2].name).toBe('intent_regex_fallback');
  });

  test('creates embedding step when index is provided', () => {
    const config = createMockEngineConfig();
    const router = new ModelRouter(config);
    const mockIndex = {
      match: vi
        .fn()
        .mockResolvedValue({ intent: 'book_hotel', confidence: 0.95, source: 'embedding' }),
    };
    const steps = createIntentSteps(router, mockIndex as any);

    expect(steps.length).toBe(3); // embedding + fast LLM + fallback
    expect(steps[0].name).toBe('intent_embedding');
    expect(steps[0].layer).toBe('embedding');
  });

  test('embedding step returns result above threshold', async () => {
    const config = createMockEngineConfig();
    const router = new ModelRouter(config);
    const mockIndex = {
      match: vi
        .fn()
        .mockResolvedValue({ intent: 'book_hotel', confidence: 0.95, source: 'embedding' }),
    };
    const steps = createIntentSteps(router, mockIndex as any, 0.85);
    const ctx = createMockContext();
    const result = await steps[0].execute(ctx, candidates);

    expect(result).not.toBeNull();
    expect(result!.intent).toBe('book_hotel');
    expect(result!.confidence).toBe(0.95);
  });

  test('embedding step returns null below threshold', async () => {
    const config = createMockEngineConfig();
    const router = new ModelRouter(config);
    const mockIndex = {
      match: vi
        .fn()
        .mockResolvedValue({ intent: 'book_hotel', confidence: 0.5, source: 'embedding' }),
    };
    const steps = createIntentSteps(router, mockIndex as any, 0.85);
    const ctx = createMockContext();
    const result = await steps[0].execute(ctx, candidates);

    expect(result).toBeNull();
  });

  test('fast LLM step parses valid JSON response', async () => {
    const config = createMockEngineConfig('{"intent": "book_hotel", "confidence": 0.92}');
    const router = new ModelRouter(config);
    const steps = createIntentSteps(router);
    const ctx = createMockContext();
    const result = await steps[0].execute(ctx, candidates);

    expect(result).not.toBeNull();
    expect(result!.intent).toBe('book_hotel');
    expect(result!.confidence).toBe(0.92);
    expect(result!.source).toBe('fast');
  });

  test('fast LLM step returns null on "none" intent', async () => {
    const config = createMockEngineConfig('{"intent": "none", "confidence": 0.1}');
    const router = new ModelRouter(config);
    const steps = createIntentSteps(router);
    const ctx = createMockContext();
    const result = await steps[0].execute(ctx, candidates);

    expect(result).not.toBeNull();
    expect(result!.intent).toBeNull();
    expect(result!.confidence).toBe(0.1);
  });

  test('fast LLM step returns null on provider error', async () => {
    const config = createMockEngineConfig();
    (config.layers.fast.provider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('timeout'),
    );
    const router = new ModelRouter(config);
    const steps = createIntentSteps(router);
    const ctx = createMockContext();
    const result = await steps[0].execute(ctx, candidates);

    expect(result).toBeNull();
  });

  test('regex fallback matches keyword in message', async () => {
    const config = createMockEngineConfig();
    const router = new ModelRouter(config);
    const steps = createIntentSteps(router);
    const ctx = createMockContext({ userMessage: 'please cancel my reservation' });
    // The last step is the regex fallback
    const fallbackStep = steps[steps.length - 1];
    const result = await fallbackStep.execute(ctx, candidates);

    expect(result).not.toBeNull();
    expect(result!.intent).toBe('cancel_booking');
    expect(result!.source).toBe('fallback');
  });

  test('regex fallback returns null intent when no match', async () => {
    const config = createMockEngineConfig();
    const router = new ModelRouter(config);
    const steps = createIntentSteps(router);
    const ctx = createMockContext({ userMessage: 'what is the weather today' });
    const fallbackStep = steps[steps.length - 1];
    const result = await fallbackStep.execute(ctx, candidates);

    expect(result).not.toBeNull();
    expect(result!.intent).toBeNull();
    expect(result!.confidence).toBe(0);
  });

  test('no fallback steps when fallback is disabled', () => {
    const config = createMockEngineConfig();
    config.enableFallbacks = false;
    const router = new ModelRouter(config);
    const steps = createIntentSteps(router);

    expect(steps.length).toBe(1); // only fast LLM
    expect(steps[0].name).toBe('intent_fast_llm');
  });

  test('LLM step handles JSON wrapped in markdown code block', async () => {
    const config = createMockEngineConfig(
      '```json\n{"intent": "book_hotel", "confidence": 0.88}\n```',
    );
    const router = new ModelRouter(config);
    const steps = createIntentSteps(router);
    const ctx = createMockContext();
    const result = await steps[0].execute(ctx, candidates);

    expect(result!.intent).toBe('book_hotel');
    expect(result!.confidence).toBe(0.88);
  });
});

// =============================================================================
// BUILD TEMPLATE VARS TESTS
// =============================================================================

describe('buildTemplateVars', () => {
  test('includes core context fields', () => {
    const ctx = createMockContext({
      agentGoal: 'Hotel booking',
      agentDomain: 'hospitality',
      detectedLanguage: 'en',
      conversationPhase: 'collecting',
      pendingQuestion: 'What city?',
      missingFields: ['city', 'date'],
      glossary: ['check-in', 'check-out'],
    });

    const vars = buildTemplateVars(ctx);

    expect(vars.agentGoal).toBe('Hotel booking');
    expect(vars.agentDomain).toBe('hospitality');
    expect(vars.language).toBe('en');
    expect(vars.conversationPhase).toBe('collecting');
    expect(vars.pendingQuestion).toBe('What city?');
    expect(vars.missingFields).toBe('city, date');
    expect(vars.glossary).toBe('check-in, check-out');
  });

  test('merges extra variables', () => {
    const ctx = createMockContext();
    const vars = buildTemplateVars(ctx, { intents: 'book, cancel', custom: 42 });

    expect(vars.intents).toBe('book, cancel');
    expect(vars.custom).toBe(42);
  });

  test('uses sessionLanguage when detectedLanguage is not set', () => {
    const ctx = createMockContext({ sessionLanguage: 'fr' });
    const vars = buildTemplateVars(ctx);

    expect(vars.language).toBe('fr');
  });

  test('collectedData is serialized as JSON string', () => {
    const ctx = createMockContext({ collectedData: { city: 'Paris', guests: 2 } });
    const vars = buildTemplateVars(ctx);

    const parsed = JSON.parse(vars.collectedData as string);
    expect(parsed.city).toBe('Paris');
    expect(parsed.guests).toBe(2);
  });
});

// =============================================================================
// ENTITY EXTRACTOR TESTS
// =============================================================================

describe('Entity Extractor (createEntitySteps)', () => {
  const fields: EntityField[] = [
    { name: 'city', type: 'string', prompt: 'Which city?' },
    { name: 'guests', type: 'number' },
  ];

  test('creates steps with fast LLM and pattern fallback', () => {
    const config = createMockEngineConfig();
    const router = new ModelRouter(config);
    const steps = createEntitySteps(router);

    expect(steps.length).toBe(2); // fast LLM + pattern fallback
    expect(steps[0].name).toBe('entity_fast_llm');
    expect(steps[1].name).toBe('entity_pattern_fallback');
  });

  test('fast LLM step extracts entities from chat response', async () => {
    const config = createMockEngineConfig('{"city": "Paris", "guests": 2}');
    const router = new ModelRouter(config);
    const steps = createEntitySteps(router);
    const ctx = createMockContext({ userMessage: 'Book a hotel in Paris for 2 guests' });
    const result = await steps[0].execute(ctx, fields);

    expect(result).not.toBeNull();
    expect(result!.values.city).toBe('Paris');
    expect(result!.values.guests).toBe(2);
    expect(result!.missing).toEqual([]);
  });

  test('fast LLM step filters out null values and reports missing', async () => {
    const config = createMockEngineConfig('{"city": "London", "guests": null}');
    const router = new ModelRouter(config);
    const steps = createEntitySteps(router);
    const ctx = createMockContext({ userMessage: 'Book a hotel in London' });
    const result = await steps[0].execute(ctx, fields);

    expect(result).not.toBeNull();
    expect(result!.values.city).toBe('London');
    expect(result!.values.guests).toBeUndefined();
    expect(result!.missing).toContain('guests');
  });

  test('fast LLM step uses extractJson when available', async () => {
    const config = createMockEngineConfig(undefined, { withExtractJson: true });
    (config.layers.fast.provider.extractJson as ReturnType<typeof vi.fn>).mockResolvedValue({
      city: 'Tokyo',
      guests: 3,
    });
    const router = new ModelRouter(config);
    const steps = createEntitySteps(router);
    const ctx = createMockContext({ userMessage: 'Book in Tokyo for 3' });
    const result = await steps[0].execute(ctx, fields);

    expect(result).not.toBeNull();
    expect(result!.values.city).toBe('Tokyo');
    expect(result!.values.guests).toBe(3);
    expect(config.layers.fast.provider.extractJson).toHaveBeenCalled();
  });

  test('fast LLM step returns null on error', async () => {
    const config = createMockEngineConfig();
    (config.layers.fast.provider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('fail'),
    );
    const router = new ModelRouter(config);
    const steps = createEntitySteps(router);
    const ctx = createMockContext();
    const result = await steps[0].execute(ctx, fields);

    expect(result).toBeNull();
  });

  test('filters "null" string values the same as null', async () => {
    const config = createMockEngineConfig('{"city": "Berlin", "guests": "null"}');
    const router = new ModelRouter(config);
    const steps = createEntitySteps(router);
    const ctx = createMockContext({ userMessage: 'Book in Berlin' });
    const result = await steps[0].execute(ctx, fields);

    expect(result!.values.city).toBe('Berlin');
    expect(result!.values.guests).toBeUndefined();
    expect(result!.missing).toContain('guests');
  });

  test('DEFAULT_ENTITY_RESULT has correct shape', () => {
    expect(DEFAULT_ENTITY_RESULT).toEqual({
      values: {},
      missing: [],
      confidence: {},
      source: 'fallback',
    });
  });
});

// =============================================================================
// CATEGORY CLASSIFIER TESTS
// =============================================================================

describe('Category Classifier (createCategorySteps)', () => {
  const categories: CategoryDefinition[] = [
    { name: 'greeting', patterns: ['hello', 'hi', 'hey'] },
    { name: 'farewell', patterns: ['bye', 'goodbye'] },
    { name: 'complaint', patterns: ['frustrated', 'angry', 'terrible'] },
  ];

  test('creates steps with fast LLM and regex fallback', () => {
    const config = createMockEngineConfig();
    const router = new ModelRouter(config);
    const steps = createCategorySteps(router);

    expect(steps.length).toBe(2);
    expect(steps[0].name).toBe('category_fast_llm');
    expect(steps[1].name).toBe('category_regex_fallback');
  });

  test('fast LLM step classifies category from valid response', async () => {
    const config = createMockEngineConfig('{"category": "greeting", "confidence": 0.95}');
    const router = new ModelRouter(config);
    const steps = createCategorySteps(router);
    const ctx = createMockContext({ userMessage: 'Hello there!' });
    const result = await steps[0].execute(ctx, categories);

    expect(result).not.toBeNull();
    expect(result!.category).toBe('greeting');
    expect(result!.confidence).toBe(0.95);
  });

  test('fast LLM step returns null for "none" category', async () => {
    const config = createMockEngineConfig('{"category": "none", "confidence": 0.3}');
    const router = new ModelRouter(config);
    const steps = createCategorySteps(router);
    const ctx = createMockContext({ userMessage: 'random text' });
    const result = await steps[0].execute(ctx, categories);

    expect(result).toBeNull();
  });

  test('regex fallback matches keyword', async () => {
    const config = createMockEngineConfig();
    const router = new ModelRouter(config);
    const steps = createCategorySteps(router);
    const ctx = createMockContext({ userMessage: 'goodbye everyone' });
    const fallbackStep = steps[steps.length - 1];
    const result = await fallbackStep.execute(ctx, categories);

    expect(result).not.toBeNull();
    expect(result!.category).toBe('farewell');
    expect(result!.source).toBe('fallback');
  });

  test('regex fallback returns null category when no pattern matches', async () => {
    const config = createMockEngineConfig();
    const router = new ModelRouter(config);
    const steps = createCategorySteps(router);
    const ctx = createMockContext({ userMessage: 'what is the time' });
    const fallbackStep = steps[steps.length - 1];
    const result = await fallbackStep.execute(ctx, categories);

    expect(result).not.toBeNull();
    expect(result!.category).toBeNull();
  });

  test('DEFAULT_CATEGORY_RESULT has correct shape', () => {
    expect(DEFAULT_CATEGORY_RESULT).toEqual({
      category: null,
      confidence: 0,
      source: 'fallback',
    });
  });
});

// =============================================================================
// CORRECTION DETECTOR TESTS
// =============================================================================

describe('Correction Detector (createCorrectionSteps)', () => {
  const collectedData = { city: 'Paris', guests: 2 };

  test('creates steps with fast LLM and regex fallback', () => {
    const config = createMockEngineConfig();
    const router = new ModelRouter(config);
    const steps = createCorrectionSteps(router);

    expect(steps.length).toBe(2);
    expect(steps[0].name).toBe('correction_fast_llm');
    expect(steps[1].name).toBe('correction_regex_fallback');
  });

  test('fast LLM detects correction with field and new value', async () => {
    const response = '{"detected": true, "field": "city", "newValue": "London", "confidence": 0.9}';
    const config = createMockEngineConfig(response);
    const router = new ModelRouter(config);
    const steps = createCorrectionSteps(router);
    const ctx = createMockContext({ userMessage: 'Actually, I meant London' });
    const result = await steps[0].execute(ctx, collectedData);

    expect(result).not.toBeNull();
    expect(result!.detected).toBe(true);
    expect(result!.field).toBe('city');
    expect(result!.newValue).toBe('London');
    expect(result!.oldValue).toBe('Paris');
    expect(result!.confidence).toBe(0.9);
  });

  test('fast LLM detects no correction', async () => {
    const response = '{"detected": false, "confidence": 0.1}';
    const config = createMockEngineConfig(response);
    const router = new ModelRouter(config);
    const steps = createCorrectionSteps(router);
    const ctx = createMockContext({ userMessage: 'That sounds good' });
    const result = await steps[0].execute(ctx, collectedData);

    expect(result).not.toBeNull();
    expect(result!.detected).toBe(false);
  });

  test('fast LLM returns null on error', async () => {
    const config = createMockEngineConfig();
    (config.layers.fast.provider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('fail'),
    );
    const router = new ModelRouter(config);
    const steps = createCorrectionSteps(router);
    const ctx = createMockContext();
    const result = await steps[0].execute(ctx, collectedData);

    expect(result).toBeNull();
  });

  test('DEFAULT_CORRECTION_RESULT has correct shape', () => {
    expect(DEFAULT_CORRECTION_RESULT).toEqual({
      detected: false,
      confidence: 0,
      source: 'fallback',
    });
  });
});

// =============================================================================
// DIGRESSION DETECTOR TESTS
// =============================================================================

describe('Digression Detector (detectDigression)', () => {
  const digressions: DigressionCandidate[] = [
    { intent: 'weather_query', keywords: ['weather', 'forecast', 'temperature'] },
    { intent: 'restaurant_search', keywords: ['restaurant', 'food', 'eat'] },
  ];

  function createIntentPipeline(intentResult: IntentResult): NLUTaskPipeline<IntentResult> {
    const plugins = new NLUPluginPipeline([]);
    const steps = [
      {
        name: 'mock_step',
        layer: 'fast',
        execute: vi.fn().mockResolvedValue(intentResult),
      },
    ];
    return new NLUTaskPipeline<IntentResult>(
      'intent_detection',
      steps,
      DEFAULT_INTENT_RESULT,
      plugins,
      0.7,
    );
  }

  test('detects digression when intent matches', async () => {
    const pipeline = createIntentPipeline({
      intent: 'weather_query',
      confidence: 0.85,
      source: 'fast',
    });
    const ctx = createMockContext({ userMessage: 'What is the weather like?' });

    const result = await detectDigression(ctx, digressions, pipeline);

    expect(result.detected).toBe(true);
    expect(result.intent).toBe('weather_query');
    expect(result.confidence).toBe(0.85);
  });

  test('passes KEYWORDS to intent detection while preserving the semantic INTENT id', async () => {
    const execute = vi.fn().mockResolvedValue({
      intent: 'help_request',
      confidence: 0.9,
      source: 'fallback',
    } satisfies IntentResult);
    const pipeline = { execute } as unknown as NLUTaskPipeline<IntentResult>;
    const ctx = createMockContext({ userMessage: 'help please' });

    await detectDigression(
      ctx,
      [{ intent: 'help_request', keywords: ['help', 'support'] }],
      pipeline,
    );

    expect(execute).toHaveBeenCalledWith(ctx, [
      { name: 'help_request', patterns: ['help', 'support'] },
    ]);
  });

  test('does not synthesize lexical patterns from semantic INTENT ids when KEYWORDS are absent', async () => {
    const execute = vi.fn().mockResolvedValue({
      intent: null,
      confidence: 0,
      source: 'fallback',
    } satisfies IntentResult);
    const pipeline = { execute } as unknown as NLUTaskPipeline<IntentResult>;
    const ctx = createMockContext({ userMessage: 'help_request' });

    await detectDigression(ctx, [{ intent: 'help_request' }], pipeline);

    expect(execute).toHaveBeenCalledWith(ctx, [{ name: 'help_request', patterns: [] }]);
  });

  test('does not detect digression when intent is null', async () => {
    const pipeline = createIntentPipeline({ intent: null, confidence: 0, source: 'fallback' });
    const ctx = createMockContext({ userMessage: 'Book my hotel please' });

    const result = await detectDigression(ctx, digressions, pipeline);

    expect(result.detected).toBe(false);
    expect(result.intent).toBeUndefined();
  });

  test('DEFAULT_DIGRESSION_RESULT has correct shape', () => {
    expect(DEFAULT_DIGRESSION_RESULT).toEqual({
      detected: false,
      confidence: 0,
      source: 'fallback',
    });
  });
});

// =============================================================================
// SUB-INTENT DETECTOR TESTS
// =============================================================================

describe('Sub-Intent Detector (detectSubIntent)', () => {
  const subIntents: SubIntentCandidate[] = [
    { name: 'modify_dates', patterns: ['change dates', 'different dates'] },
    { name: 'add_guest', patterns: ['add guest', 'extra person'] },
  ];

  function createIntentPipeline(intentResult: IntentResult): NLUTaskPipeline<IntentResult> {
    const plugins = new NLUPluginPipeline([]);
    const steps = [
      {
        name: 'mock_step',
        layer: 'fast',
        execute: vi.fn().mockResolvedValue(intentResult),
      },
    ];
    return new NLUTaskPipeline<IntentResult>(
      'intent_detection',
      steps,
      DEFAULT_INTENT_RESULT,
      plugins,
      0.7,
    );
  }

  test('detects sub-intent', async () => {
    const pipeline = createIntentPipeline({
      intent: 'modify_dates',
      confidence: 0.88,
      source: 'fast',
    });
    const ctx = createMockContext({ userMessage: 'I want to change dates' });

    const result = await detectSubIntent(ctx, subIntents, pipeline);

    expect(result.subIntent).toBe('modify_dates');
    expect(result.confidence).toBe(0.88);
  });

  test('returns null subIntent when no match', async () => {
    const pipeline = createIntentPipeline({ intent: null, confidence: 0, source: 'fallback' });
    const ctx = createMockContext({ userMessage: 'never mind' });

    const result = await detectSubIntent(ctx, subIntents, pipeline);

    expect(result.subIntent).toBeNull();
    expect(result.confidence).toBe(0);
  });

  test('converts SubIntentCandidate patterns to IntentCandidate', async () => {
    // A sub-intent with no patterns should use the name as the pattern
    const noPatterns: SubIntentCandidate[] = [{ name: 'help' }];
    const pipeline = createIntentPipeline({ intent: 'help', confidence: 0.7, source: 'fallback' });
    const ctx = createMockContext({ userMessage: 'help' });

    const result = await detectSubIntent(ctx, noPatterns, pipeline);

    expect(result.subIntent).toBe('help');
  });
});

// =============================================================================
// LANGUAGE DETECTOR TESTS
// =============================================================================

describe('Language Detector (detectLanguageFromContext)', () => {
  test('detects language via LLM', async () => {
    const config = createMockEngineConfig(
      '{"primary": "es", "confidence": 0.95, "isCodeSwitched": false}',
    );
    const router = new ModelRouter(config);
    const ctx = createMockContext({ userMessage: 'Hola, quiero reservar un hotel' });

    const result = await detectLanguageFromContext(ctx, router);

    expect(result.primary).toBe('es');
    expect(result.confidence).toBe(0.95);
    expect(result.isCodeSwitched).toBe(false);
  });

  test('falls back to regex when LLM fails', async () => {
    const config = createMockEngineConfig();
    (config.layers.fast.provider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('timeout'),
    );
    const router = new ModelRouter(config);
    const ctx = createMockContext({ userMessage: 'Bonjour, je veux réserver' });

    const result = await detectLanguageFromContext(ctx, router);

    // French should be detected by regex fallback
    expect(result.primary).toBe('fr');
    expect(result.isCodeSwitched).toBe(false);
  });

  test('defaults to English when no language detected', async () => {
    const config = createMockEngineConfig();
    (config.layers.fast.provider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('timeout'),
    );
    const router = new ModelRouter(config);
    const ctx = createMockContext({ userMessage: 'regular english text with no special words' });

    const result = await detectLanguageFromContext(ctx, router);

    expect(result.primary).toBe('en');
  });
});

// =============================================================================
// COMBINED ANALYZER TESTS
// =============================================================================

describe('Combined Analyzer (analyzeInputCombined)', () => {
  function createMockDeps(combinedResponse?: string, shouldFail?: boolean): CombinedAnalyzerDeps {
    const provider = createMockLLMProvider(combinedResponse);
    if (shouldFail) {
      provider.chat.mockRejectedValue(new Error('LLM error'));
    }
    const config: NLUEngineConfig = {
      layers: {
        fast: {
          provider,
          model: 'fast-model',
          timeoutMs: 5000,
        },
      },
      enableFallbacks: true,
      confidenceThreshold: 0.7,
    };
    const router = new ModelRouter(config);
    const plugins = new NLUPluginPipeline([]);

    const intentResult: IntentResult = {
      intent: 'book_hotel',
      confidence: 0.85,
      source: 'fallback',
    };
    const categoryResult: CategoryResult = {
      category: 'command',
      confidence: 0.8,
      source: 'fallback',
    };
    const entityResult: EntityResult = {
      values: { city: 'Paris' },
      missing: ['date'],
      confidence: { city: 0.8 },
      source: 'fallback',
    };
    const correctionResult: CorrectionResult = {
      detected: false,
      confidence: 0,
      source: 'fallback',
    };

    return {
      router,
      intentPipeline: new NLUTaskPipeline(
        'intent_detection',
        [{ name: 'mock', layer: 'fallback', execute: vi.fn().mockResolvedValue(intentResult) }],
        DEFAULT_INTENT_RESULT,
        plugins,
        0.7,
      ),
      categoryPipeline: new NLUTaskPipeline(
        'category_classification',
        [{ name: 'mock', layer: 'fallback', execute: vi.fn().mockResolvedValue(categoryResult) }],
        DEFAULT_CATEGORY_RESULT,
        plugins,
        0.7,
      ),
      entityPipeline: new NLUTaskPipeline(
        'entity_extraction',
        [{ name: 'mock', layer: 'fallback', execute: vi.fn().mockResolvedValue(entityResult) }],
        DEFAULT_ENTITY_RESULT,
        plugins,
        0.7,
      ),
      correctionPipeline: new NLUTaskPipeline(
        'correction_detection',
        [{ name: 'mock', layer: 'fallback', execute: vi.fn().mockResolvedValue(correctionResult) }],
        DEFAULT_CORRECTION_RESULT,
        plugins,
        0.7,
      ),
      detectLanguage: vi
        .fn()
        .mockResolvedValue({ primary: 'en', isCodeSwitched: false, confidence: 0.9 }),
    };
  }

  test('parses combined LLM response with intent and category', async () => {
    const combinedResponse = JSON.stringify({
      intent: { intent: 'book_hotel', confidence: 0.9 },
      category: { category: 'command', confidence: 0.85 },
    });
    const deps = createMockDeps(combinedResponse);
    const ctx = createMockContext({ userMessage: 'Book a hotel in Paris' });
    const options: AnalyzeOptions = {
      detectIntent: true,
      intents: [{ name: 'book_hotel', patterns: ['book', 'hotel'] }],
      classifyCategory: true,
      categories: [{ name: 'command', patterns: ['book', 'reserve'] }],
    };

    const result = await analyzeInputCombined(ctx, options, deps);

    expect(result.intent?.intent).toBe('book_hotel');
    expect(result.intent?.confidence).toBe(0.9);
    expect(result.category?.category).toBe('command');
    expect(result.category?.confidence).toBe(0.85);
  });

  test('parses combined response with entities', async () => {
    const combinedResponse = JSON.stringify({
      entities: { city: 'Paris', date: null },
    });
    const deps = createMockDeps(combinedResponse);
    const ctx = createMockContext({ userMessage: 'Book a hotel in Paris' });
    const options: AnalyzeOptions = {
      extractEntities: true,
      entityFields: [{ name: 'city' }, { name: 'date' }],
    };

    const result = await analyzeInputCombined(ctx, options, deps);

    expect(result.entities?.values.city).toBe('Paris');
    expect(result.entities?.missing).toContain('date');
  });

  test('parses combined response with correction', async () => {
    const combinedResponse = JSON.stringify({
      correction: { detected: true, field: 'city', newValue: 'London' },
    });
    const deps = createMockDeps(combinedResponse);
    const ctx = createMockContext({ userMessage: 'Actually London' });
    const options: AnalyzeOptions = { detectCorrection: true };

    const result = await analyzeInputCombined(ctx, options, deps);

    expect(result.correction?.detected).toBe(true);
    expect(result.correction?.field).toBe('city');
    expect(result.correction?.newValue).toBe('London');
  });

  test('handles "none" intent by setting null', async () => {
    const combinedResponse = JSON.stringify({
      intent: { intent: 'none', confidence: 0.3 },
    });
    const deps = createMockDeps(combinedResponse);
    const ctx = createMockContext({ userMessage: 'hmm' });
    const options: AnalyzeOptions = {
      detectIntent: true,
      intents: [{ name: 'book', patterns: ['book'] }],
    };

    const result = await analyzeInputCombined(ctx, options, deps);

    expect(result.intent?.intent).toBeNull();
  });

  test('falls back to individual pipelines when combined LLM fails', async () => {
    const deps = createMockDeps(undefined, true);
    const ctx = createMockContext({ userMessage: 'Book a hotel in Paris' });
    const options: AnalyzeOptions = {
      detectIntent: true,
      intents: [{ name: 'book_hotel', patterns: ['book'] }],
      classifyCategory: true,
      categories: [{ name: 'command', patterns: ['book'] }],
      extractEntities: true,
      entityFields: [{ name: 'city' }],
      detectCorrection: true,
      collectedData: { city: 'London' },
      detectLanguage: true,
    };

    const result = await analyzeInputCombined(ctx, options, deps);

    // Should have results from individual pipelines
    expect(result.intent).toBeDefined();
    expect(result.intent?.intent).toBe('book_hotel');
    expect(result.category).toBeDefined();
    expect(result.entities).toBeDefined();
    expect(result.correction).toBeDefined();
    expect(result.language).toBeDefined();
    expect(result.language?.primary).toBe('en');
  });

  test('only runs requested tasks', async () => {
    const deps = createMockDeps(undefined, true);
    const ctx = createMockContext({ userMessage: 'Hello' });
    const options: AnalyzeOptions = {
      detectIntent: false,
      detectLanguage: true,
    };

    const result = await analyzeInputCombined(ctx, options, deps);

    expect(result.intent).toBeUndefined();
    expect(result.category).toBeUndefined();
    expect(result.entities).toBeUndefined();
    expect(result.language).toBeDefined();
  });

  test('returns empty result when no tasks are requested and LLM returns no parse', async () => {
    const deps = createMockDeps('not valid json');
    const ctx = createMockContext();
    const options: AnalyzeOptions = {};

    const result = await analyzeInputCombined(ctx, options, deps);

    expect(result).toEqual({});
  });
});

// =============================================================================
// DEFAULT RESULT CONSTANTS
// =============================================================================

describe('Default Result Constants', () => {
  test('DEFAULT_INTENT_RESULT shape', () => {
    expect(DEFAULT_INTENT_RESULT).toEqual({ intent: null, confidence: 0, source: 'fallback' });
  });

  test('DEFAULT_ENTITY_RESULT shape', () => {
    expect(DEFAULT_ENTITY_RESULT).toEqual({
      values: {},
      missing: [],
      confidence: {},
      source: 'fallback',
    });
  });

  test('DEFAULT_CATEGORY_RESULT shape', () => {
    expect(DEFAULT_CATEGORY_RESULT).toEqual({ category: null, confidence: 0, source: 'fallback' });
  });

  test('DEFAULT_CORRECTION_RESULT shape', () => {
    expect(DEFAULT_CORRECTION_RESULT).toEqual({
      detected: false,
      confidence: 0,
      source: 'fallback',
    });
  });

  test('DEFAULT_DIGRESSION_RESULT shape', () => {
    expect(DEFAULT_DIGRESSION_RESULT).toEqual({
      detected: false,
      confidence: 0,
      source: 'fallback',
    });
  });
});
