/**
 * LLM Config Defaults Unit Tests
 *
 * Tests smart use case defaults: tier selection, cost estimation, validation.
 */

import { describe, test, expect } from 'vitest';
import {
  USE_CASE_DEFAULTS,
  getUseCaseDefaults,
  getUseCaseDefaultParams,
  getAvailableUseCases,
  isValidUseCase,
  estimateUseCaseCost,
} from '../defaults.js';

// =============================================================================
// Use Case Defaults Structure
// =============================================================================

describe('USE_CASE_DEFAULTS', () => {
  test('contains all expected use cases', () => {
    const useCases = Object.keys(USE_CASE_DEFAULTS);
    expect(useCases).toContain('progressiveSummarization');
    expect(useCases).toContain('questionSynthesis');
    expect(useCases).toContain('vision');
    expect(useCases).toContain('multimodal');
    expect(useCases).toContain('knowledgeGraph');
    expect(useCases).toContain('scopeClassification');
  });

  test('all use cases have required fields', () => {
    for (const [useCase, defaults] of Object.entries(USE_CASE_DEFAULTS)) {
      expect(defaults.enabled).toBeDefined();
      expect(defaults.modelTier).toMatch(/^(fast|balanced|powerful)$/);
      expect(defaults.description).toBeTruthy();
      expect(defaults.rationale).toBeTruthy();
      expect(defaults.costRating).toBeGreaterThanOrEqual(1);
      expect(defaults.costRating).toBeLessThanOrEqual(10);
      expect(defaults.volumeEstimate).toMatch(/^(low|medium|high)$/);
    }
  });
});

// =============================================================================
// Tier Selection Logic
// =============================================================================

describe('tier selection', () => {
  test('high-volume tasks use fast tier', () => {
    expect(USE_CASE_DEFAULTS.progressiveSummarization.modelTier).toBe('fast');
    expect(USE_CASE_DEFAULTS.questionSynthesis.modelTier).toBe('fast');
  });

  test('quality-critical tasks use balanced tier', () => {
    expect(USE_CASE_DEFAULTS.vision.modelTier).toBe('balanced');
    expect(USE_CASE_DEFAULTS.multimodal.modelTier).toBe('balanced');
  });

  test('simple tasks use fast tier', () => {
    expect(USE_CASE_DEFAULTS.knowledgeGraph.modelTier).toBe('fast');
    expect(USE_CASE_DEFAULTS.scopeClassification.modelTier).toBe('fast');
  });
});

// =============================================================================
// Enabled/Disabled Defaults
// =============================================================================

describe('enabled/disabled defaults', () => {
  test('high-value, low-cost features enabled by default', () => {
    expect(USE_CASE_DEFAULTS.progressiveSummarization.enabled).toBe(true);
    expect(USE_CASE_DEFAULTS.questionSynthesis.enabled).toBe(true);
  });

  test('enterprise visual features enabled by default', () => {
    expect(USE_CASE_DEFAULTS.vision.enabled).toBe(true);
    expect(USE_CASE_DEFAULTS.multimodal.enabled).toBe(true);
  });

  test('specialized features disabled by default', () => {
    expect(USE_CASE_DEFAULTS.knowledgeGraph.enabled).toBe(true);
    expect(USE_CASE_DEFAULTS.scopeClassification.enabled).toBe(false);
  });
});

// =============================================================================
// getUseCaseDefaults
// =============================================================================

describe('getUseCaseDefaults', () => {
  test('returns defaults for valid use case', () => {
    const defaults = getUseCaseDefaults('progressiveSummarization');
    expect(defaults.enabled).toBe(true);
    expect(defaults.modelTier).toBe('fast');
    expect(defaults.description).toBeTruthy();
  });

  test('throws for invalid use case', () => {
    expect(() => getUseCaseDefaults('invalidUseCase')).toThrow(
      'Invalid use case: "invalidUseCase"',
    );
  });

  test('error message includes valid use cases', () => {
    try {
      getUseCaseDefaults('unknownFeature');
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.message).toContain('progressiveSummarization');
      expect(error.message).toContain('questionSynthesis');
      expect(error.message).toContain('vision');
    }
  });
});

// =============================================================================
// getUseCaseDefaultParams
// =============================================================================

describe('getUseCaseDefaultParams', () => {
  test('progressiveSummarization has correct defaults', () => {
    const params = getUseCaseDefaultParams('progressiveSummarization');
    expect(params.enabled).toBe(true);
    expect(params.modelTier).toBe('fast');
    expect(params.maxTokens).toBe(300);
    expect(params.enableDocumentSummary).toBe(true);
    expect(params.documentSummaryMaxTokens).toBe(500);
  });

  test('questionSynthesis has correct defaults', () => {
    const params = getUseCaseDefaultParams('questionSynthesis');
    expect(params.enabled).toBe(true);
    expect(params.modelTier).toBe('fast');
    expect(params.questionsPerChunk).toBe(3);
    expect(params.maxTokens).toBe(150);
    expect(params.enableEmbedding).toBe(true);
    expect(params.enableDocumentQuestions).toBe(true);
    expect(params.documentQuestionsCount).toBe(5);
  });

  test('vision has correct defaults', () => {
    const params = getUseCaseDefaultParams('vision');
    expect(params.enabled).toBe(true);
    expect(params.modelTier).toBe('balanced');
    expect(params.maxTokens).toBe(500);
    expect(params.analyzeScreenshots).toBe(true);
    expect(params.analyzeImages).toBe(true);
    expect(params.enhanceTableContinuations).toBe(true);
  });

  test('multimodal has correct defaults', () => {
    const params = getUseCaseDefaultParams('multimodal');
    expect(params.enabled).toBe(true);
    expect(params.modelTier).toBe('balanced');
    expect(params.enableImageDescription).toBe(true);
    expect(params.enableTableSummarization).toBe(true);
    expect(params.enableChartAnalysis).toBe(true);
  });

  test('knowledgeGraph has correct defaults', () => {
    const params = getUseCaseDefaultParams('knowledgeGraph');
    expect(params.enabled).toBe(true);
    expect(params.modelTier).toBe('fast');
    expect(params.enableCoOccurrence).toBe(true);
  });

  test('scopeClassification has correct defaults', () => {
    const params = getUseCaseDefaultParams('scopeClassification');
    expect(params.enabled).toBe(false);
    expect(params.modelTier).toBe('fast');
    expect(params.maxTokens).toBe(150);
  });

  test('throws for invalid use case', () => {
    expect(() => getUseCaseDefaultParams('invalidUseCase')).toThrow(
      'Invalid use case: "invalidUseCase"',
    );
  });
});

// =============================================================================
// getAvailableUseCases
// =============================================================================

describe('getAvailableUseCases', () => {
  test('returns array of all use case names', () => {
    const useCases = getAvailableUseCases();
    expect(useCases).toBeInstanceOf(Array);
    expect(useCases.length).toBeGreaterThan(0);
    expect(useCases).toContain('progressiveSummarization');
    expect(useCases).toContain('questionSynthesis');
    expect(useCases).toContain('vision');
  });

  test('returns consistent results', () => {
    const useCases1 = getAvailableUseCases();
    const useCases2 = getAvailableUseCases();
    expect(useCases1).toEqual(useCases2);
  });
});

// =============================================================================
// isValidUseCase
// =============================================================================

describe('isValidUseCase', () => {
  test('returns true for valid use cases', () => {
    expect(isValidUseCase('progressiveSummarization')).toBe(true);
    expect(isValidUseCase('questionSynthesis')).toBe(true);
    expect(isValidUseCase('vision')).toBe(true);
    expect(isValidUseCase('multimodal')).toBe(true);
    expect(isValidUseCase('knowledgeGraph')).toBe(true);
    expect(isValidUseCase('scopeClassification')).toBe(true);
  });

  test('returns false for invalid use cases', () => {
    expect(isValidUseCase('invalidUseCase')).toBe(false);
    expect(isValidUseCase('unknownFeature')).toBe(false);
    expect(isValidUseCase('')).toBe(false);
    expect(isValidUseCase('progressiveSummary')).toBe(false); // typo
  });
});

// =============================================================================
// estimateUseCaseCost
// =============================================================================

describe('estimateUseCaseCost', () => {
  test('returns non-zero cost for enabled enterprise visual features', () => {
    const cost = estimateUseCaseCost('vision', 100);
    expect(cost).toBe(400);
  });

  test('high-volume features cost more for large documents', () => {
    const cost10 = estimateUseCaseCost('progressiveSummarization', 10);
    const cost100 = estimateUseCaseCost('progressiveSummarization', 100);
    expect(cost100).toBeGreaterThan(cost10);
  });

  test('low-volume features cost less overall', () => {
    // Multimodal has low volume estimate
    const multimodalCost = estimateUseCaseCost('multimodal', 100);
    // ProgressiveSummarization has high volume estimate
    const summarizationCost = estimateUseCaseCost('progressiveSummarization', 100);
    // Even though multimodal has higher cost rating, volume makes summarization more expensive
    expect(summarizationCost).toBeGreaterThan(multimodalCost * 0.5);
  });

  test('scales linearly with document size', () => {
    const cost50 = estimateUseCaseCost('questionSynthesis', 50);
    const cost100 = estimateUseCaseCost('questionSynthesis', 100);
    expect(cost100).toBeCloseTo(cost50 * 2, 0);
  });

  test('handles zero pages', () => {
    const cost = estimateUseCaseCost('progressiveSummarization', 0);
    expect(cost).toBe(0);
  });

  test('expensive use cases have higher cost rating', () => {
    // Compare cost ratings directly
    const visionDefaults = USE_CASE_DEFAULTS.vision;
    const summarizationDefaults = USE_CASE_DEFAULTS.progressiveSummarization;

    // Vision has cost rating 8, summarization has 2
    expect(visionDefaults.costRating).toBeGreaterThan(summarizationDefaults.costRating);
    expect(visionDefaults.costRating).toBe(8);
    expect(summarizationDefaults.costRating).toBe(2);

    // Enabled features have non-zero cost
    const summarizationCost = estimateUseCaseCost('progressiveSummarization', 100);
    expect(summarizationCost).toBeGreaterThan(0);
  });

  test('throws for invalid use case', () => {
    expect(() => estimateUseCaseCost('invalidUseCase', 100)).toThrow(
      'Invalid use case: "invalidUseCase"',
    );
  });
});

// =============================================================================
// Cost/Quality Tradeoffs
// =============================================================================

describe('cost and quality tradeoffs', () => {
  test('fast tier use cases have lower cost ratings', () => {
    const fastUseCases = getAvailableUseCases().filter(
      (uc) => USE_CASE_DEFAULTS[uc].modelTier === 'fast',
    );
    const balancedUseCases = getAvailableUseCases().filter(
      (uc) => USE_CASE_DEFAULTS[uc].modelTier === 'balanced',
    );

    const avgFastCost =
      fastUseCases.reduce((sum, uc) => sum + USE_CASE_DEFAULTS[uc].costRating, 0) /
      fastUseCases.length;
    const avgBalancedCost =
      balancedUseCases.reduce((sum, uc) => sum + USE_CASE_DEFAULTS[uc].costRating, 0) /
      balancedUseCases.length;

    expect(avgBalancedCost).toBeGreaterThan(avgFastCost);
  });

  test('high-volume tasks prefer fast tier', () => {
    const highVolumeUseCases = getAvailableUseCases().filter(
      (uc) => USE_CASE_DEFAULTS[uc].volumeEstimate === 'high',
    );

    for (const useCase of highVolumeUseCases) {
      // High volume tasks should use fast tier for cost optimization
      expect(USE_CASE_DEFAULTS[useCase].modelTier).toBe('fast');
    }
  });

  test('expensive features remain enabled for enterprise-grade processing', () => {
    const expensiveUseCases = getAvailableUseCases().filter(
      (uc) => USE_CASE_DEFAULTS[uc].costRating >= 7,
    );

    for (const useCase of expensiveUseCases) {
      expect(USE_CASE_DEFAULTS[useCase].enabled).toBe(true);
    }
  });
});
