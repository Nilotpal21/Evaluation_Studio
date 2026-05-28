/**
 * Question Generator tests
 *
 * Tests the user-friendly question generation including:
 * - Strategy question generation
 * - Batch size question generation
 * - JavaScript handling question generation
 * - Concurrency question generation
 * - Priority ordering
 * - Max questions limit
 * - Clear, non-technical language
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { QuestionGenerator } from '../../disclosure/question-generator.js';
import type { PromptQuestion } from '../../disclosure/question-generator.js';
import type { CrawlDecision, DecisionContext } from '../../decision/interfaces.js';
import type { SiteProfile } from '../../profiler/interfaces.js';

// ========================================
// Test Fixtures
// ========================================

const createProfile = (overrides: Partial<SiteProfile> = {}): SiteProfile => ({
  domain: 'example.com',
  profiledAt: new Date(),
  siteType: 'static',
  jsRequired: false,
  linkDensity: 10,
  estimatedSize: 100,
  avgResponseTime: 200,
  rateLimitDetected: false,
  maxConcurrency: 10,
  confidence: 85,
  metadata: {},
  ...overrides,
});

const createDecision = (overrides: Partial<CrawlDecision> = {}): CrawlDecision => ({
  strategy: 'bulk',
  batchSize: 50,
  concurrency: 10,
  jsHandling: 'none',
  confidence: 70,
  reasoning: 'Test decision',
  source: 'profile-heuristic',
  alternatives: [
    {
      strategy: 'bulk',
      batchSize: 50,
      concurrency: 10,
      reasoning: 'Bulk alternative',
      expectedOutcome: {
        estimatedDuration: 30000,
        estimatedThroughput: 3.0,
        reliability: 80,
      },
    },
    {
      strategy: 'browser',
      batchSize: 1,
      concurrency: 1,
      reasoning: 'Browser alternative',
      expectedOutcome: {
        estimatedDuration: 120000,
        estimatedThroughput: 0.5,
        reliability: 95,
      },
    },
    {
      strategy: 'hybrid',
      batchSize: 10,
      concurrency: 5,
      reasoning: 'Hybrid alternative',
      expectedOutcome: {
        estimatedDuration: 60000,
        estimatedThroughput: 1.5,
        reliability: 85,
      },
    },
  ],
  ...overrides,
});

const createContext = (overrides: Partial<DecisionContext> = {}): DecisionContext => ({
  url: 'https://example.com',
  tenantId: 'tenant-123',
  profile: createProfile(),
  ...overrides,
});

// ========================================
// Tests
// ========================================

describe('QuestionGenerator', () => {
  describe('Construction', () => {
    test('creates with default options', () => {
      const generator = new QuestionGenerator();
      expect(generator).toBeDefined();
    });

    test('creates with custom options', () => {
      const generator = new QuestionGenerator({
        maxQuestions: 2,
        strategyConfidenceThreshold: 80,
        includeOutcomeEstimates: false,
      });
      expect(generator).toBeDefined();
    });
  });

  describe('Strategy Question', () => {
    test('generates strategy question when confidence < 70', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 65 });
      const context = createContext({ profile: createProfile() });

      const questions = generator.generate(decision, context);

      const strategyQ = questions.find((q) => q.id === 'strategy');
      expect(strategyQ).toBeDefined();
      expect(strategyQ?.type).toBe('choice');
      expect(strategyQ?.question).toContain('crawl this website');
      expect(strategyQ?.priority).toBe(100); // Highest priority
    });

    test('does not generate strategy question when confidence >= 70', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 75 });
      const context = createContext();

      const questions = generator.generate(decision, context);

      const strategyQ = questions.find((q) => q.id === 'strategy');
      expect(strategyQ).toBeUndefined();
    });

    test('respects custom confidence threshold', () => {
      const generator = new QuestionGenerator({
        strategyConfidenceThreshold: 80,
      });
      const decision = createDecision({ confidence: 75 });
      const context = createContext();

      const questions = generator.generate(decision, context);

      const strategyQ = questions.find((q) => q.id === 'strategy');
      expect(strategyQ).toBeDefined(); // 75 < 80
    });

    test('includes auto option as recommended', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 65 });
      const context = createContext();

      const questions = generator.generate(decision, context);

      const strategyQ = questions.find((q) => q.id === 'strategy');
      const autoOption = strategyQ?.options?.find((o) => o.value === 'auto');

      expect(autoOption).toBeDefined();
      expect(autoOption?.recommended).toBe(true);
      expect(autoOption?.label).toContain('Recommended');
    });

    test('includes bulk, browser, and hybrid options', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 65 });
      const context = createContext();

      const questions = generator.generate(decision, context);

      const strategyQ = questions.find((q) => q.id === 'strategy');
      const values = strategyQ?.options?.map((o) => o.value) ?? [];

      expect(values).toContain('auto');
      expect(values).toContain('bulk');
      expect(values).toContain('browser');
      expect(values).toContain('hybrid');
    });

    test('includes expected outcome estimates', () => {
      const generator = new QuestionGenerator({ includeOutcomeEstimates: true });
      const decision = createDecision({ confidence: 65 });
      const context = createContext();

      const questions = generator.generate(decision, context);

      const strategyQ = questions.find((q) => q.id === 'strategy');
      const bulkOption = strategyQ?.options?.find((o) => o.value === 'bulk');

      expect(bulkOption?.expectedOutcome).toBeDefined();
      expect(bulkOption?.expectedOutcome?.speed).toBeDefined();
      expect(bulkOption?.expectedOutcome?.reliability).toBeDefined();
    });

    test('excludes outcome estimates when disabled', () => {
      const generator = new QuestionGenerator({ includeOutcomeEstimates: false });
      const decision = createDecision({ confidence: 65 });
      const context = createContext();

      const questions = generator.generate(decision, context);

      const strategyQ = questions.find((q) => q.id === 'strategy');
      const bulkOption = strategyQ?.options?.find((o) => o.value === 'bulk');

      expect(bulkOption?.expectedOutcome).toBeUndefined();
    });

    test('builds context with site characteristics', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 65 });
      const profile = createProfile({
        siteType: 'spa',
        estimatedSize: 250,
        avgResponseTime: 500,
      });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const strategyQ = questions.find((q) => q.id === 'strategy');

      expect(strategyQ?.context).toContain('Single Page Application');
      expect(strategyQ?.context).toContain('250 pages');
    });

    test('mentions rate limiting in context', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 65 });
      const profile = createProfile({ rateLimitDetected: true });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const strategyQ = questions.find((q) => q.id === 'strategy');

      expect(strategyQ?.context).toContain('Rate limiting');
    });

    test('uses clear, non-technical language', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 65 });
      const context = createContext();

      const questions = generator.generate(decision, context);

      const strategyQ = questions.find((q) => q.id === 'strategy');

      // Check for technical jargon
      const text = (strategyQ?.question + strategyQ?.context).toLowerCase();
      expect(text).not.toContain('heuristic');
      expect(text).not.toContain('algorithm');
      expect(text).not.toContain('concurrent');

      // Check for friendly language
      expect(strategyQ?.question).toMatch(/how|what|should/i);
    });
  });

  describe('Batch Size Question', () => {
    test('generates batch size question when rate limits detected', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 }); // High confidence
      const profile = createProfile({ rateLimitDetected: true });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const batchSizeQ = questions.find((q) => q.id === 'batchSize');
      expect(batchSizeQ).toBeDefined();
      expect(batchSizeQ?.type).toBe('range');
      expect(batchSizeQ?.question).toContain('pages');
      expect(batchSizeQ?.priority).toBe(60);
    });

    test('generates batch size question for large sites', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({ estimatedSize: 1000 });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const batchSizeQ = questions.find((q) => q.id === 'batchSize');
      expect(batchSizeQ).toBeDefined();
      expect(batchSizeQ?.context).toContain('1000 pages');
    });

    test('does not generate batch size question for small sites without rate limits', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({
        estimatedSize: 50,
        rateLimitDetected: false,
      });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const batchSizeQ = questions.find((q) => q.id === 'batchSize');
      expect(batchSizeQ).toBeUndefined();
    });

    test('uses smaller range when rate limits detected', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({ rateLimitDetected: true });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const batchSizeQ = questions.find((q) => q.id === 'batchSize');
      expect(batchSizeQ?.range?.min).toBe(5);
      expect(batchSizeQ?.range?.max).toBe(50);
    });

    test('uses larger range when no rate limits', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({
        estimatedSize: 1000,
        rateLimitDetected: false,
      });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const batchSizeQ = questions.find((q) => q.id === 'batchSize');
      expect(batchSizeQ?.range?.min).toBe(10);
      expect(batchSizeQ?.range?.max).toBe(100);
    });

    test('includes recommendation in context', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85, batchSize: 50 });
      const profile = createProfile({ estimatedSize: 1000 });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const batchSizeQ = questions.find((q) => q.id === 'batchSize');
      expect(batchSizeQ?.context).toContain('50 pages');
      expect(batchSizeQ?.context).toContain('recommendation');
    });

    test('sets default value to decision batch size', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85, batchSize: 75 });
      const profile = createProfile({ estimatedSize: 1000 });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const batchSizeQ = questions.find((q) => q.id === 'batchSize');
      expect(batchSizeQ?.defaultValue).toBe(75);
    });
  });

  describe('JavaScript Question', () => {
    test('generates JS question for hybrid sites', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({ siteType: 'hybrid' });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const jsQ = questions.find((q) => q.id === 'jsHandling');
      expect(jsQ).toBeDefined();
      expect(jsQ?.type).toBe('choice');
      expect(jsQ?.question).toContain('JavaScript');
      expect(jsQ?.priority).toBe(80);
    });

    test('generates JS question for unknown sites', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({ siteType: 'unknown' });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const jsQ = questions.find((q) => q.id === 'jsHandling');
      expect(jsQ).toBeDefined();
    });

    test('does not generate JS question for static sites', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({ siteType: 'static' });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const jsQ = questions.find((q) => q.id === 'jsHandling');
      expect(jsQ).toBeUndefined();
    });

    test('does not generate JS question for SPAs', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({ siteType: 'spa' });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const jsQ = questions.find((q) => q.id === 'jsHandling');
      expect(jsQ).toBeUndefined();
    });

    test('includes all JS handling options', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({ siteType: 'hybrid' });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const jsQ = questions.find((q) => q.id === 'jsHandling');
      const values = jsQ?.options?.map((o) => o.value) ?? [];

      expect(values).toContain('auto');
      expect(values).toContain('none');
      expect(values).toContain('static');
      expect(values).toContain('dynamic');
    });

    test('recommends auto option', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({ siteType: 'hybrid' });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const jsQ = questions.find((q) => q.id === 'jsHandling');
      const autoOption = jsQ?.options?.find((o) => o.value === 'auto');

      expect(autoOption?.recommended).toBe(true);
    });

    test('explains trade-offs for each option', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({ siteType: 'hybrid' });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const jsQ = questions.find((q) => q.id === 'jsHandling');

      jsQ?.options?.forEach((option) => {
        expect(option.description).toBeTruthy();
        expect(option.description.length).toBeGreaterThan(10);
      });
    });
  });

  describe('Concurrency Question', () => {
    test('generates concurrency question when rate limits detected', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({ rateLimitDetected: true });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const concurrencyQ = questions.find((q) => q.id === 'concurrency');
      expect(concurrencyQ).toBeDefined();
      expect(concurrencyQ?.type).toBe('range');
      expect(concurrencyQ?.priority).toBe(40);
    });

    test('generates concurrency question for slow responses', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({ avgResponseTime: 3000 });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const concurrencyQ = questions.find((q) => q.id === 'concurrency');
      expect(concurrencyQ).toBeDefined();
      expect(concurrencyQ?.context).toContain('3000ms');
    });

    test('does not generate concurrency question for fast sites without rate limits', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({
        avgResponseTime: 200,
        rateLimitDetected: false,
      });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const concurrencyQ = questions.find((q) => q.id === 'concurrency');
      expect(concurrencyQ).toBeUndefined();
    });

    test('uses lower range when rate limits detected', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({ rateLimitDetected: true });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const concurrencyQ = questions.find((q) => q.id === 'concurrency');
      expect(concurrencyQ?.range?.min).toBe(1);
      expect(concurrencyQ?.range?.max).toBe(5);
    });

    test('uses higher range when no rate limits', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({
        avgResponseTime: 3000,
        rateLimitDetected: false,
      });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      const concurrencyQ = questions.find((q) => q.id === 'concurrency');
      expect(concurrencyQ?.range?.min).toBe(2);
      expect(concurrencyQ?.range?.max).toBe(20);
    });
  });

  describe('Priority and Limiting', () => {
    test('orders questions by priority', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 60 }); // Low confidence
      const profile = createProfile({
        siteType: 'hybrid',
        estimatedSize: 1000,
        rateLimitDetected: true,
        avgResponseTime: 3000,
      });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      // Should be ordered: strategy (100) > jsHandling (80) > batchSize (60) > concurrency (40)
      if (questions.length >= 2) {
        expect(questions[0].priority).toBeGreaterThanOrEqual(questions[1].priority);
      }
      if (questions.length >= 3) {
        expect(questions[1].priority).toBeGreaterThanOrEqual(questions[2].priority);
      }
      if (questions.length >= 4) {
        expect(questions[2].priority).toBeGreaterThanOrEqual(questions[3].priority);
      }
    });

    test('limits questions to max (default 4)', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 60 });
      const profile = createProfile({
        siteType: 'hybrid',
        estimatedSize: 1000,
        rateLimitDetected: true,
        avgResponseTime: 3000,
      });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      expect(questions.length).toBeLessThanOrEqual(4);
    });

    test('respects custom max questions', () => {
      const generator = new QuestionGenerator({ maxQuestions: 2 });
      const decision = createDecision({ confidence: 60 });
      const profile = createProfile({
        siteType: 'hybrid',
        estimatedSize: 1000,
        rateLimitDetected: true,
      });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      expect(questions.length).toBeLessThanOrEqual(2);
    });

    test('returns highest priority questions when limiting', () => {
      const generator = new QuestionGenerator({ maxQuestions: 2 });
      const decision = createDecision({ confidence: 60 });
      const profile = createProfile({
        siteType: 'hybrid',
        estimatedSize: 1000,
        rateLimitDetected: true,
      });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      // Should get strategy (100) and jsHandling (80)
      const ids = questions.map((q) => q.id);
      expect(ids).toContain('strategy');
    });
  });

  describe('Duration Formatting', () => {
    test('formats milliseconds', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({
        confidence: 60,
        alternatives: [
          {
            strategy: 'browser',
            batchSize: 1,
            concurrency: 1,
            reasoning: 'Test',
            expectedOutcome: {
              estimatedDuration: 500,
              estimatedThroughput: 1,
              reliability: 90,
            },
          },
        ],
      });
      const context = createContext();

      const questions = generator.generate(decision, context);

      const strategyQ = questions.find((q) => q.id === 'strategy');
      const browserOption = strategyQ?.options?.find((o) => o.value === 'browser');

      expect(browserOption?.expectedOutcome?.duration).toContain('ms');
    });

    test('formats seconds', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({
        confidence: 60,
        alternatives: [
          {
            strategy: 'browser',
            batchSize: 1,
            concurrency: 1,
            reasoning: 'Test',
            expectedOutcome: {
              estimatedDuration: 45000, // 45 seconds
              estimatedThroughput: 1,
              reliability: 90,
            },
          },
        ],
      });
      const context = createContext();

      const questions = generator.generate(decision, context);

      const strategyQ = questions.find((q) => q.id === 'strategy');
      const browserOption = strategyQ?.options?.find((o) => o.value === 'browser');

      expect(browserOption?.expectedOutcome?.duration).toContain('second');
      expect(browserOption?.expectedOutcome?.duration).toContain('45');
    });

    test('formats minutes', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({
        confidence: 60,
        alternatives: [
          {
            strategy: 'browser',
            batchSize: 1,
            concurrency: 1,
            reasoning: 'Test',
            expectedOutcome: {
              estimatedDuration: 120000, // 2 minutes
              estimatedThroughput: 1,
              reliability: 90,
            },
          },
        ],
      });
      const context = createContext();

      const questions = generator.generate(decision, context);

      const strategyQ = questions.find((q) => q.id === 'strategy');
      const browserOption = strategyQ?.options?.find((o) => o.value === 'browser');

      expect(browserOption?.expectedOutcome?.duration).toContain('minute');
      expect(browserOption?.expectedOutcome?.duration).toContain('2');
    });
  });

  describe('Edge Cases', () => {
    test('handles profile with zero estimated size', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 60 });
      const profile = createProfile({ estimatedSize: 0 });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      // Should still generate strategy question
      const strategyQ = questions.find((q) => q.id === 'strategy');
      expect(strategyQ).toBeDefined();
    });

    test('handles profile with no alternatives', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({
        confidence: 60,
        alternatives: undefined,
      });
      const context = createContext();

      const questions = generator.generate(decision, context);

      const strategyQ = questions.find((q) => q.id === 'strategy');
      expect(strategyQ).toBeDefined();
      expect(strategyQ?.options?.length).toBeGreaterThan(0);
    });

    test('handles empty alternatives array', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({
        confidence: 60,
        alternatives: [],
      });
      const context = createContext();

      const questions = generator.generate(decision, context);

      const strategyQ = questions.find((q) => q.id === 'strategy');
      expect(strategyQ).toBeDefined();
    });

    test('generates no questions when confidence high and no issues', () => {
      const generator = new QuestionGenerator();
      const decision = createDecision({ confidence: 85 });
      const profile = createProfile({
        siteType: 'static',
        estimatedSize: 100,
        rateLimitDetected: false,
        avgResponseTime: 200,
      });
      const context = createContext({ profile });

      const questions = generator.generate(decision, context);

      expect(questions).toHaveLength(0);
    });
  });
});
