/**
 * LLM Config Validation Schemas Unit Tests
 *
 * Tests Zod validation schemas for LLM configuration.
 */

import { describe, test, expect } from 'vitest';
import {
  LLMConfigSchema,
  ProgressiveSummarizationConfigSchema,
  QuestionSynthesisConfigSchema,
  VisionConfigSchema,
  MultimodalConfigSchema,
  KnowledgeGraphConfigSchema,
  ScopeClassificationConfigSchema,
} from '../index-schemas.js';

// =============================================================================
// LLMConfigSchema - Top Level
// =============================================================================

describe('LLMConfigSchema', () => {
  test('accepts valid full config', () => {
    const config = {
      enabled: true,
      useCases: {
        progressiveSummarization: {
          enabled: true,
          modelTier: 'fast',
          maxTokens: 300,
        },
        vision: {
          enabled: true,
          modelTier: 'balanced',
          maxTokens: 500,
        },
      },
    };

    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test('accepts empty config', () => {
    const config = {};
    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test('accepts only enabled flag', () => {
    const config = { enabled: false };
    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test('accepts only useCases', () => {
    const config = {
      useCases: {
        progressiveSummarization: {
          maxTokens: 400,
        },
      },
    };
    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test('rejects invalid enabled type', () => {
    const config = { enabled: 'yes' };
    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// ProgressiveSummarizationConfigSchema
// =============================================================================

describe('ProgressiveSummarizationConfigSchema', () => {
  test('accepts valid config', () => {
    const config = {
      enabled: true,
      modelTier: 'fast',
      maxTokens: 300,
      enableDocumentSummary: true,
      documentSummaryMaxTokens: 500,
    };

    const result = ProgressiveSummarizationConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test('accepts partial config', () => {
    const config = { maxTokens: 400 };
    const result = ProgressiveSummarizationConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test('accepts all valid model tiers', () => {
    const tiers = ['fast', 'balanced', 'powerful'];
    for (const tier of tiers) {
      const config = { modelTier: tier };
      const result = ProgressiveSummarizationConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    }
  });

  test('rejects invalid model tier', () => {
    const config = { modelTier: 'super-fast' };
    const result = ProgressiveSummarizationConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test('rejects maxTokens below minimum', () => {
    const config = { maxTokens: 30 };
    const result = ProgressiveSummarizationConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test('rejects maxTokens above maximum', () => {
    const config = { maxTokens: 1500 };
    const result = ProgressiveSummarizationConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test('accepts maxTokens at boundaries', () => {
    expect(ProgressiveSummarizationConfigSchema.safeParse({ maxTokens: 50 }).success).toBe(true);
    expect(ProgressiveSummarizationConfigSchema.safeParse({ maxTokens: 1000 }).success).toBe(true);
  });

  test('rejects non-integer maxTokens', () => {
    const config = { maxTokens: 300.5 };
    const result = ProgressiveSummarizationConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test('rejects documentSummaryMaxTokens out of range', () => {
    expect(
      ProgressiveSummarizationConfigSchema.safeParse({ documentSummaryMaxTokens: 50 }).success,
    ).toBe(false);
    expect(
      ProgressiveSummarizationConfigSchema.safeParse({ documentSummaryMaxTokens: 2500 }).success,
    ).toBe(false);
  });
});

// =============================================================================
// QuestionSynthesisConfigSchema
// =============================================================================

describe('QuestionSynthesisConfigSchema', () => {
  test('accepts valid config', () => {
    const config = {
      enabled: true,
      modelTier: 'fast',
      questionsPerChunk: 3,
      maxTokens: 150,
      enableEmbedding: true,
      enableDocumentQuestions: true,
      documentQuestionsCount: 5,
    };

    const result = QuestionSynthesisConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test('rejects questionsPerChunk below minimum', () => {
    const config = { questionsPerChunk: 0 };
    const result = QuestionSynthesisConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test('rejects questionsPerChunk above maximum', () => {
    const config = { questionsPerChunk: 15 };
    const result = QuestionSynthesisConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test('accepts questionsPerChunk at boundaries', () => {
    expect(QuestionSynthesisConfigSchema.safeParse({ questionsPerChunk: 1 }).success).toBe(true);
    expect(QuestionSynthesisConfigSchema.safeParse({ questionsPerChunk: 10 }).success).toBe(true);
  });

  test('rejects documentQuestionsCount out of range', () => {
    expect(QuestionSynthesisConfigSchema.safeParse({ documentQuestionsCount: 0 }).success).toBe(
      false,
    );
    expect(QuestionSynthesisConfigSchema.safeParse({ documentQuestionsCount: 25 }).success).toBe(
      false,
    );
  });

  test('accepts documentQuestionsCount at boundaries', () => {
    expect(QuestionSynthesisConfigSchema.safeParse({ documentQuestionsCount: 1 }).success).toBe(
      true,
    );
    expect(QuestionSynthesisConfigSchema.safeParse({ documentQuestionsCount: 20 }).success).toBe(
      true,
    );
  });
});

// =============================================================================
// VisionConfigSchema
// =============================================================================

describe('VisionConfigSchema', () => {
  test('accepts valid config', () => {
    const config = {
      enabled: true,
      modelTier: 'balanced',
      maxTokens: 500,
      analyzeScreenshots: true,
      analyzeImages: true,
      enhanceTableContinuations: true,
    };

    const result = VisionConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test('rejects maxTokens below minimum', () => {
    const config = { maxTokens: 50 };
    const result = VisionConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test('rejects maxTokens above maximum', () => {
    const config = { maxTokens: 2000 };
    const result = VisionConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test('accepts maxTokens at boundaries', () => {
    expect(VisionConfigSchema.safeParse({ maxTokens: 100 }).success).toBe(true);
    expect(VisionConfigSchema.safeParse({ maxTokens: 1500 }).success).toBe(true);
  });

  test('accepts boolean flags', () => {
    const config = {
      analyzeScreenshots: false,
      analyzeImages: true,
      enhanceTableContinuations: false,
    };
    const result = VisionConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// MultimodalConfigSchema
// =============================================================================

describe('MultimodalConfigSchema', () => {
  test('accepts valid config', () => {
    const config = {
      enabled: true,
      modelTier: 'balanced',
      enableImageDescription: true,
      enableTableSummarization: true,
      enableChartAnalysis: true,
    };

    const result = MultimodalConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test('accepts partial boolean flags', () => {
    const config = {
      enableImageDescription: false,
      enableChartAnalysis: true,
    };
    const result = MultimodalConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test('rejects invalid boolean types', () => {
    const config = { enableImageDescription: 'yes' };
    const result = MultimodalConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// KnowledgeGraphConfigSchema
// =============================================================================

describe('KnowledgeGraphConfigSchema', () => {
  test('accepts valid config', () => {
    const config = {
      enabled: true,
      modelTier: 'fast',
      enableCoOccurrence: true,
    };

    const result = KnowledgeGraphConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test('accepts without enableCoOccurrence', () => {
    const config = {
      enabled: true,
      modelTier: 'fast',
    };
    const result = KnowledgeGraphConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// ScopeClassificationConfigSchema
// =============================================================================

describe('ScopeClassificationConfigSchema', () => {
  test('accepts valid config', () => {
    const config = {
      enabled: true,
      modelTier: 'fast',
      maxTokens: 50,
    };

    const result = ScopeClassificationConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test('rejects maxTokens below minimum', () => {
    const config = { maxTokens: 10 };
    const result = ScopeClassificationConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test('rejects maxTokens above maximum', () => {
    const config = { maxTokens: 300 };
    const result = ScopeClassificationConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test('accepts maxTokens at boundaries', () => {
    expect(ScopeClassificationConfigSchema.safeParse({ maxTokens: 20 }).success).toBe(true);
    expect(ScopeClassificationConfigSchema.safeParse({ maxTokens: 200 }).success).toBe(true);
  });
});

// =============================================================================
// Integration: Full LLM Config
// =============================================================================

describe('full LLM config validation', () => {
  test('accepts realistic user configuration', () => {
    const config = {
      enabled: true,
      useCases: {
        progressiveSummarization: {
          enabled: true,
          modelTier: 'fast',
          maxTokens: 350,
        },
        questionSynthesis: {
          enabled: true,
          modelTier: 'fast',
          questionsPerChunk: 5,
        },
        vision: {
          enabled: true,
          modelTier: 'balanced',
          analyzeScreenshots: true,
        },
        knowledgeGraph: {
          enabled: true,
          modelTier: 'fast',
        },
      },
    };

    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test('rejects if any use case has invalid config', () => {
    const config = {
      useCases: {
        progressiveSummarization: {
          modelTier: 'fast',
          maxTokens: 300,
        },
        vision: {
          modelTier: 'super-powerful', // Invalid tier
        },
      },
    };

    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test('accepts config with some use cases omitted', () => {
    const config = {
      useCases: {
        vision: {
          enabled: true,
          modelTier: 'balanced',
        },
      },
    };

    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test('provides helpful error messages', () => {
    const config = {
      useCases: {
        progressiveSummarization: {
          maxTokens: 5000, // Too high
        },
        questionSynthesis: {
          questionsPerChunk: 15, // Too high
        },
      },
    };

    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.length).toBeGreaterThan(0);
      // Check that errors reference the correct paths
      const paths = result.error.errors.map((e) => e.path.join('.'));
      expect(paths.some((p) => p.includes('progressiveSummarization'))).toBe(true);
      expect(paths.some((p) => p.includes('questionSynthesis'))).toBe(true);
    }
  });
});
