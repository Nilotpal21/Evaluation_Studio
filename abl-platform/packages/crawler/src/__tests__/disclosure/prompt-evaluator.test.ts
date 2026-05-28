/**
 * Prompt Evaluator tests
 *
 * Tests the progressive disclosure logic including:
 * - 5 skip rules (user override, high confidence, saved preference, previous success, auto-decide)
 * - Priority order of skip rules
 * - Edge cases and error handling
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { PromptEvaluator } from '../../disclosure/prompt-evaluator.js';
import type {
  IUserDisclosureSettingsStore,
  UserDisclosureSettings,
} from '../../disclosure/interfaces.js';
import type {
  CrawlDecision,
  DecisionContext,
  IPatternLearner,
  IUserPreferenceStore,
  UserPreference,
  LearnedPattern,
} from '../../decision/interfaces.js';
import type { SiteProfile } from '../../profiler/interfaces.js';

// ========================================
// Test Fixtures
// ========================================

const createProfile = (): SiteProfile => ({
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
});

const createDecision = (overrides: Partial<CrawlDecision> = {}): CrawlDecision => ({
  strategy: 'bulk',
  batchSize: 50,
  concurrency: 10,
  jsHandling: 'none',
  confidence: 70,
  reasoning: 'Test decision',
  source: 'profile-heuristic',
  ...overrides,
});

const createContext = (overrides: Partial<DecisionContext> = {}): DecisionContext => ({
  url: 'https://example.com',
  tenantId: 'tenant-123',
  profile: createProfile(),
  ...overrides,
});

// ========================================
// Mock Stores
// ========================================

const createMockUserSettingsStore = (): IUserDisclosureSettingsStore => ({
  getSettings: vi.fn().mockResolvedValue(null),
  saveSettings: vi.fn().mockResolvedValue({} as UserDisclosureSettings),
  updateSettings: vi.fn().mockResolvedValue({} as UserDisclosureSettings),
  deleteSettings: vi.fn().mockResolvedValue(false),
});

const createMockPatternLearner = (): IPatternLearner => ({
  learn: vi.fn().mockResolvedValue({} as LearnedPattern),
  getPattern: vi.fn().mockResolvedValue(null),
  listPatterns: vi.fn().mockResolvedValue([]),
  decayPatterns: vi.fn().mockResolvedValue(0),
});

const createMockUserPreferenceStore = (): IUserPreferenceStore => ({
  getPreference: vi.fn().mockResolvedValue(null),
  savePreference: vi.fn().mockResolvedValue({} as UserPreference),
  deletePreference: vi.fn().mockResolvedValue(false),
  listPreferences: vi.fn().mockResolvedValue([]),
  trackUsage: vi.fn().mockResolvedValue(undefined),
});

// ========================================
// Tests
// ========================================

describe('PromptEvaluator', () => {
  describe('Construction', () => {
    test('creates with default options', () => {
      const evaluator = new PromptEvaluator();
      expect(evaluator).toBeDefined();
    });

    test('creates with stores', () => {
      const evaluator = new PromptEvaluator({
        userSettingsStore: createMockUserSettingsStore(),
        patternLearner: createMockPatternLearner(),
        userPreferenceStore: createMockUserPreferenceStore(),
      });
      expect(evaluator).toBeDefined();
    });

    test('creates with custom thresholds', () => {
      const evaluator = new PromptEvaluator({
        defaultConfidenceThreshold: 90,
        minSuccessRate: 0.9,
        minCrawlCount: 5,
      });
      expect(evaluator).toBeDefined();
    });
  });

  describe('Skip Rule 1: User Override', () => {
    test('skips when decision source is user-override', async () => {
      const evaluator = new PromptEvaluator();
      const decision = createDecision({
        source: 'user-override',
        confidence: 100,
      });
      const context = createContext();

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(false);
      expect(result.skipRule).toBe('user-override');
      expect(result.confidence).toBe(100);
      expect(result.reason).toContain('explicitly selected');
      expect(result.metadata?.hasUserOverride).toBe(true);
    });

    test('skips when context has userOverride', async () => {
      const evaluator = new PromptEvaluator();
      const decision = createDecision({ confidence: 50 }); // Low confidence
      const context = createContext({
        userOverride: { strategy: 'browser' },
      });

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(false);
      expect(result.skipRule).toBe('user-override');
    });

    test('user override has highest priority', async () => {
      // Even with all other conditions, user override wins
      const userSettingsStore = createMockUserSettingsStore();
      vi.mocked(userSettingsStore.getSettings).mockResolvedValue({
        userId: 'user-456',
        tenantId: 'tenant-123',
        autoDecide: true,
        minConfidenceThreshold: 80,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const evaluator = new PromptEvaluator({ userSettingsStore });
      const decision = createDecision({
        source: 'user-override',
        confidence: 50, // Low confidence
      });
      const context = createContext({ userId: 'user-456' });

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(false);
      expect(result.skipRule).toBe('user-override');
    });
  });

  describe('Skip Rule 2: High Confidence', () => {
    test('skips when confidence >= 80 (default threshold)', async () => {
      const evaluator = new PromptEvaluator();
      const decision = createDecision({ confidence: 85 });
      const context = createContext();

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(false);
      expect(result.skipRule).toBe('high-confidence');
      expect(result.confidence).toBe(85);
      expect(result.reason).toContain('exceeds threshold');
    });

    test('skips at exactly 80% confidence', async () => {
      const evaluator = new PromptEvaluator();
      const decision = createDecision({ confidence: 80 });
      const context = createContext();

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(false);
      expect(result.skipRule).toBe('high-confidence');
    });

    test('does not skip at 79% confidence', async () => {
      const evaluator = new PromptEvaluator();
      const decision = createDecision({ confidence: 79 });
      const context = createContext();

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(true);
      expect(result.skipRule).toBeUndefined();
    });

    test('respects custom confidence threshold', async () => {
      const evaluator = new PromptEvaluator({
        defaultConfidenceThreshold: 90,
      });
      const decision = createDecision({ confidence: 85 });
      const context = createContext();

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(true); // 85 < 90
    });

    test('respects user-specific confidence threshold', async () => {
      const userSettingsStore = createMockUserSettingsStore();
      vi.mocked(userSettingsStore.getSettings).mockResolvedValue({
        userId: 'user-456',
        tenantId: 'tenant-123',
        autoDecide: false,
        minConfidenceThreshold: 95, // User wants higher threshold
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const evaluator = new PromptEvaluator({ userSettingsStore });
      const decision = createDecision({ confidence: 90 });
      const context = createContext({ userId: 'user-456' });

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(true); // 90 < 95
    });
  });

  describe('Skip Rule 3: Saved Preference with Auto-Decide', () => {
    test('skips when user has saved preference with autoDecide=true', async () => {
      const userPreferenceStore = createMockUserPreferenceStore();
      vi.mocked(userPreferenceStore.getPreference).mockResolvedValue({
        id: 'pref-123',
        userId: 'user-456',
        tenantId: 'tenant-123',
        domainPattern: 'example.com',
        strategy: 'bulk',
        autoDecide: true,
        useCount: 5,
        lastUsed: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const evaluator = new PromptEvaluator({ userPreferenceStore });
      const decision = createDecision({ confidence: 70 });
      const context = createContext({ userId: 'user-456' });

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(false);
      expect(result.skipRule).toBe('saved-preference');
      expect(result.metadata?.hasSavedPreference).toBe(true);
      expect(result.reason).toContain('saved preference');
      expect(result.reason).toContain('auto-decide enabled');
    });

    test('does not skip when preference has autoDecide=false', async () => {
      const userPreferenceStore = createMockUserPreferenceStore();
      vi.mocked(userPreferenceStore.getPreference).mockResolvedValue({
        id: 'pref-123',
        userId: 'user-456',
        tenantId: 'tenant-123',
        domainPattern: 'example.com',
        strategy: 'bulk',
        autoDecide: false, // Needs user confirmation
        useCount: 5,
        lastUsed: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const evaluator = new PromptEvaluator({ userPreferenceStore });
      const decision = createDecision({ confidence: 70 });
      const context = createContext({ userId: 'user-456' });

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(true);
      expect(result.metadata?.hasSavedPreference).toBe(true);
    });

    test('does not skip when no preference exists', async () => {
      const userPreferenceStore = createMockUserPreferenceStore();
      vi.mocked(userPreferenceStore.getPreference).mockResolvedValue(null);

      const evaluator = new PromptEvaluator({ userPreferenceStore });
      const decision = createDecision({ confidence: 70 });
      const context = createContext({ userId: 'user-456' });

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(true);
      expect(result.metadata?.hasSavedPreference).toBe(false);
    });

    test('skips when no userId provided', async () => {
      const userPreferenceStore = createMockUserPreferenceStore();

      const evaluator = new PromptEvaluator({ userPreferenceStore });
      const decision = createDecision({ confidence: 70 });
      const context = createContext(); // No userId

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(true);
      expect(userPreferenceStore.getPreference).not.toHaveBeenCalled();
    });
  });

  describe('Skip Rule 4: Previous Successful Crawls', () => {
    test('skips when domain has successful crawl history', async () => {
      const patternLearner = createMockPatternLearner();
      vi.mocked(patternLearner.getPattern).mockResolvedValue({
        id: 'pattern-123',
        tenantId: 'tenant-123',
        domain: 'example.com',
        siteType: 'static',
        optimalStrategy: 'bulk',
        optimalBatchSize: 50,
        optimalConcurrency: 10,
        confidence: 90,
        successCount: 8,
        totalCount: 10,
        successRate: 0.8,
        metrics: {
          avgDuration: 25000,
          avgThroughput: 2.0,
          avgMemoryMB: 150,
        },
        firstSeenAt: new Date(),
        lastValidatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const evaluator = new PromptEvaluator({ patternLearner });
      const decision = createDecision({ confidence: 70 });
      const context = createContext();

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(false);
      expect(result.skipRule).toBe('previous-success');
      expect(result.metadata?.previousCrawlCount).toBe(10);
      expect(result.metadata?.previousSuccessRate).toBe(0.8);
      expect(result.reason).toContain('previously crawled successfully');
      expect(result.reason).toContain('8/10');
    });

    test('does not skip when success rate too low', async () => {
      const patternLearner = createMockPatternLearner();
      vi.mocked(patternLearner.getPattern).mockResolvedValue({
        id: 'pattern-123',
        tenantId: 'tenant-123',
        domain: 'example.com',
        siteType: 'static',
        optimalStrategy: 'bulk',
        optimalBatchSize: 50,
        optimalConcurrency: 10,
        confidence: 70,
        successCount: 5,
        totalCount: 10,
        successRate: 0.5, // Below 0.8 threshold
        metrics: {
          avgDuration: 25000,
          avgThroughput: 2.0,
          avgMemoryMB: 150,
        },
        firstSeenAt: new Date(),
        lastValidatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const evaluator = new PromptEvaluator({ patternLearner });
      const decision = createDecision({ confidence: 70 });
      const context = createContext();

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(true);
      expect(result.metadata?.previousSuccessRate).toBe(0.5);
    });

    test('does not skip when crawl count too low', async () => {
      const patternLearner = createMockPatternLearner();
      vi.mocked(patternLearner.getPattern).mockResolvedValue({
        id: 'pattern-123',
        tenantId: 'tenant-123',
        domain: 'example.com',
        siteType: 'static',
        optimalStrategy: 'bulk',
        optimalBatchSize: 50,
        optimalConcurrency: 10,
        confidence: 70,
        successCount: 1,
        totalCount: 1, // Below 2 threshold
        successRate: 1.0,
        metrics: {
          avgDuration: 25000,
          avgThroughput: 2.0,
          avgMemoryMB: 150,
        },
        firstSeenAt: new Date(),
        lastValidatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const evaluator = new PromptEvaluator({ patternLearner });
      const decision = createDecision({ confidence: 70 });
      const context = createContext();

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(true);
      expect(result.metadata?.previousCrawlCount).toBe(1);
    });

    test('respects custom success rate threshold', async () => {
      const patternLearner = createMockPatternLearner();
      vi.mocked(patternLearner.getPattern).mockResolvedValue({
        successCount: 8,
        totalCount: 10,
        successRate: 0.8,
      } as LearnedPattern);

      const evaluator = new PromptEvaluator({
        patternLearner,
        minSuccessRate: 0.9, // Higher threshold
      });
      const decision = createDecision({ confidence: 70 });
      const context = createContext();

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(true); // 0.8 < 0.9
    });

    test('respects custom crawl count threshold', async () => {
      const patternLearner = createMockPatternLearner();
      vi.mocked(patternLearner.getPattern).mockResolvedValue({
        successCount: 5,
        totalCount: 5,
        successRate: 1.0,
      } as LearnedPattern);

      const evaluator = new PromptEvaluator({
        patternLearner,
        minCrawlCount: 10, // Higher threshold
      });
      const decision = createDecision({ confidence: 70 });
      const context = createContext();

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(true); // 5 < 10
    });

    test('does not skip when no history exists', async () => {
      const patternLearner = createMockPatternLearner();
      vi.mocked(patternLearner.getPattern).mockResolvedValue(null);

      const evaluator = new PromptEvaluator({ patternLearner });
      const decision = createDecision({ confidence: 70 });
      const context = createContext();

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(true);
      expect(result.metadata?.previousCrawlCount).toBeUndefined();
    });
  });

  describe('Skip Rule 5: User Auto-Decide Enabled', () => {
    test('skips when user has autoDecide enabled', async () => {
      const userSettingsStore = createMockUserSettingsStore();
      vi.mocked(userSettingsStore.getSettings).mockResolvedValue({
        userId: 'user-456',
        tenantId: 'tenant-123',
        autoDecide: true,
        minConfidenceThreshold: 80,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const evaluator = new PromptEvaluator({ userSettingsStore });
      const decision = createDecision({ confidence: 70 });
      const context = createContext({ userId: 'user-456' });

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(false);
      expect(result.skipRule).toBe('auto-decide');
      expect(result.reason).toContain('auto-decide');
      expect(result.metadata?.autoDecideEnabled).toBe(true);
    });

    test('does not skip when autoDecide is false', async () => {
      const userSettingsStore = createMockUserSettingsStore();
      vi.mocked(userSettingsStore.getSettings).mockResolvedValue({
        userId: 'user-456',
        tenantId: 'tenant-123',
        autoDecide: false,
        minConfidenceThreshold: 80,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const evaluator = new PromptEvaluator({ userSettingsStore });
      const decision = createDecision({ confidence: 70 });
      const context = createContext({ userId: 'user-456' });

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(true);
      expect(result.metadata?.autoDecideEnabled).toBe(false);
    });

    test('does not skip when no user settings exist', async () => {
      const userSettingsStore = createMockUserSettingsStore();
      vi.mocked(userSettingsStore.getSettings).mockResolvedValue(null);

      const evaluator = new PromptEvaluator({ userSettingsStore });
      const decision = createDecision({ confidence: 70 });
      const context = createContext({ userId: 'user-456' });

      const result = await evaluator.evaluate(decision, context);

      expect(result.shouldPrompt).toBe(true);
      expect(result.metadata?.autoDecideEnabled).toBe(false);
    });
  });

  describe('Priority Order', () => {
    test('user override beats high confidence', async () => {
      const evaluator = new PromptEvaluator();
      const decision = createDecision({
        source: 'user-override',
        confidence: 100, // High confidence
      });
      const context = createContext();

      const result = await evaluator.evaluate(decision, context);

      expect(result.skipRule).toBe('user-override'); // Not high-confidence
    });

    test('high confidence beats saved preference', async () => {
      const userPreferenceStore = createMockUserPreferenceStore();
      vi.mocked(userPreferenceStore.getPreference).mockResolvedValue({
        autoDecide: true,
      } as UserPreference);

      const evaluator = new PromptEvaluator({ userPreferenceStore });
      const decision = createDecision({ confidence: 85 }); // High
      const context = createContext({ userId: 'user-456' });

      const result = await evaluator.evaluate(decision, context);

      expect(result.skipRule).toBe('high-confidence'); // Not saved-preference
    });

    test('saved preference beats previous success', async () => {
      const userPreferenceStore = createMockUserPreferenceStore();
      const patternLearner = createMockPatternLearner();

      vi.mocked(userPreferenceStore.getPreference).mockResolvedValue({
        autoDecide: true,
      } as UserPreference);

      vi.mocked(patternLearner.getPattern).mockResolvedValue({
        successCount: 10,
        totalCount: 10,
        successRate: 1.0,
      } as LearnedPattern);

      const evaluator = new PromptEvaluator({ userPreferenceStore, patternLearner });
      const decision = createDecision({ confidence: 70 });
      const context = createContext({ userId: 'user-456' });

      const result = await evaluator.evaluate(decision, context);

      expect(result.skipRule).toBe('saved-preference'); // Not previous-success
    });

    test('previous success beats auto-decide', async () => {
      const userSettingsStore = createMockUserSettingsStore();
      const patternLearner = createMockPatternLearner();

      vi.mocked(userSettingsStore.getSettings).mockResolvedValue({
        autoDecide: true, // Would trigger skip rule 5
      } as UserDisclosureSettings);

      vi.mocked(patternLearner.getPattern).mockResolvedValue({
        successCount: 10,
        totalCount: 10,
        successRate: 1.0,
      } as LearnedPattern);

      const evaluator = new PromptEvaluator({ userSettingsStore, patternLearner });
      const decision = createDecision({ confidence: 70 });
      const context = createContext({ userId: 'user-456' });

      const result = await evaluator.evaluate(decision, context);

      expect(result.skipRule).toBe('previous-success'); // Not auto-decide
    });
  });

  describe('Error Handling', () => {
    test('throws DisclosureError on settings store error', async () => {
      const userSettingsStore = createMockUserSettingsStore();
      vi.mocked(userSettingsStore.getSettings).mockRejectedValue(new Error('Database error'));

      const evaluator = new PromptEvaluator({ userSettingsStore });
      const decision = createDecision({ confidence: 70 });
      const context = createContext({ userId: 'user-456' });

      await expect(evaluator.evaluate(decision, context)).rejects.toThrow(
        'Failed to evaluate prompt decision',
      );
    });

    test('throws DisclosureError on pattern learner error', async () => {
      const patternLearner = createMockPatternLearner();
      vi.mocked(patternLearner.getPattern).mockRejectedValue(new Error('Database error'));

      const evaluator = new PromptEvaluator({ patternLearner });
      const decision = createDecision({ confidence: 70 });
      const context = createContext();

      await expect(evaluator.evaluate(decision, context)).rejects.toThrow(
        'Failed to evaluate prompt decision',
      );
    });
  });

  describe('getUserSettings()', () => {
    test('returns settings when available', async () => {
      const userSettingsStore = createMockUserSettingsStore();
      const mockSettings: UserDisclosureSettings = {
        userId: 'user-456',
        tenantId: 'tenant-123',
        autoDecide: true,
        minConfidenceThreshold: 90,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      vi.mocked(userSettingsStore.getSettings).mockResolvedValue(mockSettings);

      const evaluator = new PromptEvaluator({ userSettingsStore });
      const result = await evaluator.getUserSettings('user-456', 'tenant-123');

      expect(result).toEqual(mockSettings);
    });

    test('returns null when no store configured', async () => {
      const evaluator = new PromptEvaluator();
      const result = await evaluator.getUserSettings('user-456', 'tenant-123');

      expect(result).toBeNull();
    });

    test('throws DisclosureError on store error', async () => {
      const userSettingsStore = createMockUserSettingsStore();
      vi.mocked(userSettingsStore.getSettings).mockRejectedValue(new Error('Database error'));

      const evaluator = new PromptEvaluator({ userSettingsStore });

      await expect(evaluator.getUserSettings('user-456', 'tenant-123')).rejects.toThrow(
        'Failed to get user settings',
      );
    });
  });

  describe('getCrawlHistory()', () => {
    test('returns history when available', async () => {
      const patternLearner = createMockPatternLearner();
      vi.mocked(patternLearner.getPattern).mockResolvedValue({
        domain: 'example.com',
        successCount: 8,
        totalCount: 10,
        successRate: 0.8,
        lastValidatedAt: new Date('2024-01-15'),
      } as LearnedPattern);

      const evaluator = new PromptEvaluator({ patternLearner });
      const result = await evaluator.getCrawlHistory('tenant-123', 'https://example.com');

      expect(result).toBeDefined();
      expect(result?.domain).toBe('example.com');
      expect(result?.totalCrawls).toBe(10);
      expect(result?.successfulCrawls).toBe(8);
      expect(result?.successRate).toBe(0.8);
    });

    test('returns null when no pattern exists', async () => {
      const patternLearner = createMockPatternLearner();
      vi.mocked(patternLearner.getPattern).mockResolvedValue(null);

      const evaluator = new PromptEvaluator({ patternLearner });
      const result = await evaluator.getCrawlHistory('tenant-123', 'example.com');

      expect(result).toBeNull();
    });

    test('returns null when no pattern learner configured', async () => {
      const evaluator = new PromptEvaluator();
      const result = await evaluator.getCrawlHistory('tenant-123', 'example.com');

      expect(result).toBeNull();
    });

    test('throws DisclosureError on pattern learner error', async () => {
      const patternLearner = createMockPatternLearner();
      vi.mocked(patternLearner.getPattern).mockRejectedValue(new Error('Database error'));

      const evaluator = new PromptEvaluator({ patternLearner });

      await expect(evaluator.getCrawlHistory('tenant-123', 'example.com')).rejects.toThrow(
        'Failed to get crawl history',
      );
    });
  });
});
