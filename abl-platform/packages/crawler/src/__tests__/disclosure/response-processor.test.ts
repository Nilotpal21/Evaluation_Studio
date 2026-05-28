/**
 * Tests for ResponseProcessor
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ResponseProcessor,
  type QuestionResponse,
  type ResponseApplicationResult,
} from '../../disclosure/response-processor.js';
import type { PromptQuestion } from '../../disclosure/question-generator.js';
import type { CrawlDecision, DecisionContext } from '../../decision/interfaces.js';
import type { IUserPreferenceStore } from '../../decision/interfaces.js';
import type { SiteProfile } from '../../profiler/interfaces.js';

// ========================================
// Test Fixtures
// ========================================

function createMockDecision(): CrawlDecision {
  return {
    strategy: 'bulk',
    batchSize: 20,
    concurrency: 5,
    jsHandling: 'none',
    timeout: 30000,
    retryStrategy: {
      maxRetries: 3,
      backoffMs: 1000,
    },
    confidence: 75,
    reasoning: 'Initial decision based on profile',
    alternatives: [],
    source: 'decision-engine',
  };
}

function createMockContext(): DecisionContext {
  return {
    url: 'https://example.com',
    profile: {
      domain: 'example.com',
      siteType: 'static',
      estimatedSize: 100,
      avgResponseTime: 200,
      hasRobotsTxt: true,
      hasSitemap: false,
      rateLimitDetected: false,
      crawlableScore: 85,
      profiledAt: new Date(),
    } as SiteProfile,
    userId: 'user123',
    tenantId: 'tenant123',
  };
}

function createStrategyQuestion(): PromptQuestion {
  return {
    id: 'strategy',
    type: 'choice',
    question: 'How should we crawl this website?',
    context: 'This appears to be mostly static HTML.',
    options: [
      {
        value: 'auto',
        label: 'Let the system decide (Recommended)',
        description: "We'll choose the best approach automatically.",
        recommended: true,
      },
      {
        value: 'bulk',
        label: 'Fast Bulk Crawl',
        description: 'Use our high-speed crawler.',
      },
      {
        value: 'browser',
        label: 'Browser-Based Crawl',
        description: 'Use a real browser.',
      },
    ],
    defaultValue: 'auto',
    priority: 100,
  };
}

function createBatchSizeQuestion(): PromptQuestion {
  return {
    id: 'batchSize',
    type: 'range',
    question: 'How many pages should we process at once?',
    context: "We'll crawl approximately 100 pages.",
    range: { min: 10, max: 100, step: 5 },
    defaultValue: 20,
    priority: 60,
  };
}

function createJsHandlingQuestion(): PromptQuestion {
  return {
    id: 'jsHandling',
    type: 'choice',
    question: 'How should we handle JavaScript?',
    context: 'This site has both static and dynamic content.',
    options: [
      {
        value: 'auto',
        label: 'Auto (Recommended)',
        description: "We'll decide",
        recommended: true,
      },
      { value: 'none', label: 'Skip JavaScript', description: 'Faster' },
      { value: 'static', label: 'Basic JavaScript', description: 'Moderate' },
      { value: 'dynamic', label: 'Full JavaScript', description: 'Slowest' },
    ],
    defaultValue: 'auto',
    priority: 80,
  };
}

function createConcurrencyQuestion(): PromptQuestion {
  return {
    id: 'concurrency',
    type: 'range',
    question: 'How many pages should we fetch at the same time?',
    context: 'Our recommendation: 5 concurrent requests.',
    range: { min: 1, max: 20, step: 1 },
    defaultValue: 5,
    priority: 40,
  };
}

function createMockUserPreferenceStore(): IUserPreferenceStore {
  const savedPreferences = new Map<string, any>();

  return {
    async getPreference(userId: string, tenantId: string, domain: string) {
      const key = `${userId}:${tenantId}:${domain}`;
      const pref = savedPreferences.get(key);
      return pref || null;
    },

    async savePreference(preference: any) {
      const key = `${preference.userId}:${preference.tenantId}:${preference.domainPattern}`;
      savedPreferences.set(key, {
        id: 'mock-id',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...preference,
      });
      return savedPreferences.get(key);
    },

    async deletePreference(id: string) {
      return true;
    },

    async listPreferences(userId: string, tenantId: string) {
      return [];
    },

    async trackUsage(id: string) {},

    // Expose for testing
    _getAll: () => savedPreferences,
  } as IUserPreferenceStore & { _getAll: () => Map<string, any> };
}

// ========================================
// Tests: Basic Response Application
// ========================================

describe('ResponseProcessor - Basic Application', () => {
  let processor: ResponseProcessor;
  let decision: CrawlDecision;
  let context: DecisionContext;

  beforeEach(() => {
    processor = new ResponseProcessor();
    decision = createMockDecision();
    context = createMockContext();
  });

  it('should apply strategy response (non-auto)', async () => {
    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [{ questionId: 'strategy', value: 'browser' }];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(true);
    expect(result.updatedDecision).toBeDefined();
    expect(result.updatedDecision!.strategy).toBe('browser');
    expect(result.updatedDecision!.source).toBe('user-override');
    expect(result.updatedDecision!.confidence).toBe(100);
  });

  it('should keep current strategy when user chooses "auto"', async () => {
    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [{ questionId: 'strategy', value: 'auto' }];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(true);
    expect(result.updatedDecision!.strategy).toBe('bulk'); // Original strategy preserved
    expect(result.updatedDecision!.source).toBe('user-override');
    expect(result.updatedDecision!.confidence).toBe(100);
  });

  it('should apply batch size response', async () => {
    const questions = [createBatchSizeQuestion()];
    const responses: QuestionResponse[] = [{ questionId: 'batchSize', value: 50 }];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(true);
    expect(result.updatedDecision!.batchSize).toBe(50);
    expect(result.updatedDecision!.source).toBe('user-override');
    expect(result.updatedDecision!.confidence).toBe(100);
  });

  it('should apply JavaScript handling response', async () => {
    const questions = [createJsHandlingQuestion()];
    const responses: QuestionResponse[] = [{ questionId: 'jsHandling', value: 'dynamic' }];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(true);
    expect(result.updatedDecision!.jsHandling).toBe('dynamic');
  });

  it('should apply concurrency response', async () => {
    const questions = [createConcurrencyQuestion()];
    const responses: QuestionResponse[] = [{ questionId: 'concurrency', value: 10 }];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(true);
    expect(result.updatedDecision!.concurrency).toBe(10);
  });

  it('should apply multiple responses', async () => {
    const questions = [
      createStrategyQuestion(),
      createBatchSizeQuestion(),
      createConcurrencyQuestion(),
    ];
    const responses: QuestionResponse[] = [
      { questionId: 'strategy', value: 'browser' },
      { questionId: 'batchSize', value: 30 },
      { questionId: 'concurrency', value: 3 },
    ];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(true);
    expect(result.updatedDecision!.strategy).toBe('browser');
    expect(result.updatedDecision!.batchSize).toBe(30);
    expect(result.updatedDecision!.concurrency).toBe(3);
    expect(result.updatedDecision!.confidence).toBe(100);
  });

  it('should include reasoning text in updated decision', async () => {
    const questions = [createStrategyQuestion(), createBatchSizeQuestion()];
    const responses: QuestionResponse[] = [
      { questionId: 'strategy', value: 'browser' },
      { questionId: 'batchSize', value: 30 },
    ];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(true);
    expect(result.updatedDecision!.reasoning).toContain('User-confirmed configuration');
    expect(result.updatedDecision!.reasoning).toContain('Strategy: browser');
    expect(result.updatedDecision!.reasoning).toContain('Batch size: 30 pages');
  });
});

// ========================================
// Tests: Response Validation
// ========================================

describe('ResponseProcessor - Validation', () => {
  let processor: ResponseProcessor;
  let decision: CrawlDecision;
  let context: DecisionContext;

  beforeEach(() => {
    processor = new ResponseProcessor({ validateResponses: true });
    decision = createMockDecision();
    context = createMockContext();
  });

  it('should reject invalid choice value', async () => {
    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [{ questionId: 'strategy', value: 'invalid-strategy' }];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('INVALID_RESPONSE');
    expect(result.error!.message).toContain('Invalid choice');
  });

  it('should reject wrong type for choice question', async () => {
    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [{ questionId: 'strategy', value: 123 as any }];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('INVALID_RESPONSE');
    expect(result.error!.message).toContain('Expected string value');
  });

  it('should reject out-of-range value', async () => {
    const questions = [createBatchSizeQuestion()];
    const responses: QuestionResponse[] = [
      { questionId: 'batchSize', value: 150 }, // Max is 100
    ];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('INVALID_RESPONSE');
    expect(result.error!.message).toContain('out of range');
  });

  it('should reject value not aligned with step', async () => {
    const questions = [createBatchSizeQuestion()]; // Step is 5
    const responses: QuestionResponse[] = [
      { questionId: 'batchSize', value: 23 }, // Not divisible by 5 from min
    ];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('INVALID_RESPONSE');
    expect(result.error!.message).toContain('does not align with step');
  });

  it('should reject wrong type for range question', async () => {
    const questions = [createBatchSizeQuestion()];
    const responses: QuestionResponse[] = [
      { questionId: 'batchSize', value: 'not-a-number' as any },
    ];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('INVALID_RESPONSE');
    expect(result.error!.message).toContain('Expected number value');
  });

  it('should reject response for unknown question', async () => {
    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [{ questionId: 'unknown-question', value: 'test' }];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('QUESTION_NOT_FOUND');
    expect(result.error!.questionId).toBe('unknown-question');
  });

  it('should reject empty questions array', async () => {
    const questions: PromptQuestion[] = [];
    const responses: QuestionResponse[] = [{ questionId: 'strategy', value: 'browser' }];

    await expect(processor.applyResponses(decision, questions, responses, context)).rejects.toThrow(
      'Questions array cannot be empty',
    );
  });

  it('should reject empty responses array', async () => {
    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [];

    await expect(processor.applyResponses(decision, questions, responses, context)).rejects.toThrow(
      'Responses array cannot be empty',
    );
  });
});

// ========================================
// Tests: Validation Disabled
// ========================================

describe('ResponseProcessor - Validation Disabled', () => {
  let processor: ResponseProcessor;
  let decision: CrawlDecision;
  let context: DecisionContext;

  beforeEach(() => {
    processor = new ResponseProcessor({ validateResponses: false });
    decision = createMockDecision();
    context = createMockContext();
  });

  it('should apply response without validation when disabled', async () => {
    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [{ questionId: 'strategy', value: 'browser' }];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(true);
    expect(result.updatedDecision!.strategy).toBe('browser');
  });

  it('should still fail on question not found even with validation disabled', async () => {
    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [{ questionId: 'unknown', value: 'test' }];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(false);
  });
});

// ========================================
// Tests: Preference Persistence
// ========================================

describe('ResponseProcessor - Preference Persistence', () => {
  let processor: ResponseProcessor;
  let decision: CrawlDecision;
  let context: DecisionContext;
  let mockStore: IUserPreferenceStore & { _getAll: () => Map<string, Record<string, any>> };

  beforeEach(() => {
    mockStore = createMockUserPreferenceStore();
    processor = new ResponseProcessor({ userPreferenceStore: mockStore });
    decision = createMockDecision();
    context = createMockContext();
  });

  it('should save preference when saveAsPreference is true', async () => {
    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [
      { questionId: 'strategy', value: 'browser', saveAsPreference: true },
    ];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(true);
    expect(result.preferencesSaved).toEqual(['strategy']);

    // Verify saved
    const saved = await mockStore.getPreference('user123', 'tenant123', 'example.com');
    expect(saved).toMatchObject({ strategy: 'browser' });
  });

  it('should not save preference when saveAsPreference is false', async () => {
    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [
      { questionId: 'strategy', value: 'browser', saveAsPreference: false },
    ];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(true);
    expect(result.preferencesSaved).toBeUndefined();

    const saved = await mockStore.getPreference('user123', 'tenant123', 'example.com');
    expect(saved).toBeNull();
  });

  it('should not save preference when saveAsPreference is undefined', async () => {
    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [{ questionId: 'strategy', value: 'browser' }];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(true);
    expect(result.preferencesSaved).toBeUndefined();
  });

  it('should save multiple preferences', async () => {
    const questions = [
      createStrategyQuestion(),
      createBatchSizeQuestion(),
      createConcurrencyQuestion(),
    ];
    const responses: QuestionResponse[] = [
      { questionId: 'strategy', value: 'browser', saveAsPreference: true },
      { questionId: 'batchSize', value: 30, saveAsPreference: true },
      { questionId: 'concurrency', value: 3, saveAsPreference: true },
    ];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(true);
    expect(result.preferencesSaved).toEqual(['strategy', 'batchSize', 'concurrency']);

    const saved = await mockStore.getPreference('user123', 'tenant123', 'example.com');
    expect(saved).toMatchObject({
      strategy: 'browser',
      batchSize: 30,
      concurrency: 3,
    });
  });

  it('should save some preferences if only some requested', async () => {
    const questions = [createStrategyQuestion(), createBatchSizeQuestion()];
    const responses: QuestionResponse[] = [
      { questionId: 'strategy', value: 'browser', saveAsPreference: true },
      { questionId: 'batchSize', value: 30, saveAsPreference: false },
    ];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(true);
    expect(result.preferencesSaved).toEqual(['strategy']);

    const saved = await mockStore.getPreference('user123', 'tenant123', 'example.com');
    expect(saved).toMatchObject({ strategy: 'browser' });
  });

  it('should not save preferences when no store provided', async () => {
    const processorNoStore = new ResponseProcessor();
    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [
      { questionId: 'strategy', value: 'browser', saveAsPreference: true },
    ];

    const result = await processorNoStore.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(true);
    expect(result.preferencesSaved).toBeUndefined();
  });

  it('should not save preferences when no userId in context', async () => {
    const contextNoUser = { ...context, userId: undefined };
    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [
      { questionId: 'strategy', value: 'browser', saveAsPreference: true },
    ];

    const result = await processor.applyResponses(decision, questions, responses, contextNoUser);

    expect(result.success).toBe(true);
    expect(result.preferencesSaved).toBeUndefined();
  });

  it('should not fail entire operation if preference save fails', async () => {
    const failingStore: IUserPreferenceStore = {
      async getPreference() {
        return null;
      },
      async savePreference() {
        throw new Error('Store failure');
      },
      async deletePreference() {},
    };

    const processorWithFailingStore = new ResponseProcessor({ userPreferenceStore: failingStore });
    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [
      { questionId: 'strategy', value: 'browser', saveAsPreference: true },
    ];

    const result = await processorWithFailingStore.applyResponses(
      decision,
      questions,
      responses,
      context,
    );

    // Should succeed despite store failure
    expect(result.success).toBe(true);
    expect(result.updatedDecision!.strategy).toBe('browser');
  });
});

// ========================================
// Tests: Partial Updates
// ========================================

describe('ResponseProcessor - Partial Updates', () => {
  let processor: ResponseProcessor;
  let decision: CrawlDecision;
  let context: DecisionContext;

  beforeEach(() => {
    processor = new ResponseProcessor({ allowPartialUpdates: true, validateResponses: true });
    decision = createMockDecision();
    context = createMockContext();
  });

  it('should allow partial updates when enabled', async () => {
    const questions = [createStrategyQuestion(), createBatchSizeQuestion()];
    const responses: QuestionResponse[] = [
      { questionId: 'strategy', value: 'browser' }, // Valid
      { questionId: 'batchSize', value: 999 }, // Invalid (out of range)
    ];

    const result = await processor.applyResponses(decision, questions, responses, context);

    // With partial updates, this should succeed
    expect(result.success).toBe(true);
    expect(result.updatedDecision!.strategy).toBe('browser');
  });

  it('should not allow partial updates when disabled', async () => {
    const processorNoPartial = new ResponseProcessor({
      allowPartialUpdates: false,
      validateResponses: true,
    });

    const questions = [createStrategyQuestion(), createBatchSizeQuestion()];
    const responses: QuestionResponse[] = [
      { questionId: 'strategy', value: 'browser' },
      { questionId: 'batchSize', value: 999 }, // Invalid
    ];

    const result = await processorNoPartial.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ========================================
// Tests: Edge Cases
// ========================================

describe('ResponseProcessor - Edge Cases', () => {
  let processor: ResponseProcessor;
  let decision: CrawlDecision;
  let context: DecisionContext;

  beforeEach(() => {
    processor = new ResponseProcessor();
    decision = createMockDecision();
    context = createMockContext();
  });

  it('should handle malformed URL in context gracefully', async () => {
    const contextBadUrl = {
      ...context,
      url: 'not-a-url', // Malformed URL
    };

    const mockStore = createMockUserPreferenceStore();
    const processorWithStore = new ResponseProcessor({ userPreferenceStore: mockStore });

    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [
      { questionId: 'strategy', value: 'browser', saveAsPreference: true },
    ];

    const result = await processorWithStore.applyResponses(
      decision,
      questions,
      responses,
      contextBadUrl,
    );

    // Should succeed, just won't save preference
    expect(result.success).toBe(true);
    expect(result.preferencesSaved).toBeUndefined();
  });

  it('should handle response with all fields set to auto/defaults', async () => {
    const questions = [createStrategyQuestion(), createJsHandlingQuestion()];
    const responses: QuestionResponse[] = [
      { questionId: 'strategy', value: 'auto' },
      { questionId: 'jsHandling', value: 'auto' },
    ];

    const result = await processor.applyResponses(decision, questions, responses, context);

    expect(result.success).toBe(true);
    // Original values preserved
    expect(result.updatedDecision!.strategy).toBe('bulk');
    expect(result.updatedDecision!.jsHandling).toBe('none');
  });

  it('should not modify original decision object', async () => {
    const originalDecision = createMockDecision();
    const originalStrategy = originalDecision.strategy;
    const originalConfidence = originalDecision.confidence;

    const questions = [createStrategyQuestion()];
    const responses: QuestionResponse[] = [{ questionId: 'strategy', value: 'browser' }];

    await processor.applyResponses(originalDecision, questions, responses, context);

    // Original should be unchanged
    expect(originalDecision.strategy).toBe(originalStrategy);
    expect(originalDecision.confidence).toBe(originalConfidence);
  });
});
