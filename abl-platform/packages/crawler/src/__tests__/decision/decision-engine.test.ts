/**
 * Decision Engine Core tests
 *
 * Tests the autonomous decision-making system including:
 * - 5-level hierarchy resolution
 * - Strategy selection logic
 * - Batch size and concurrency calculation
 * - Alternative generation
 * - Confidence scoring
 * - Reasoning generation
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { DecisionEngine } from '../../decision/decision-engine.js';
import type {
  DecisionContext,
  IUserPreferenceStore,
  ITenantPolicyStore,
  IPatternLearner,
  UserPreference,
  TenantPolicy,
  LearnedPattern,
  CrawlOutcome,
} from '../../decision/interfaces.js';
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

const createContext = (
  profile: SiteProfile,
  overrides: Partial<DecisionContext> = {},
): DecisionContext => ({
  url: 'https://example.com',
  tenantId: 'tenant-123',
  profile,
  ...overrides,
});

// ========================================
// Mock Stores
// ========================================

const createMockUserPreferenceStore = (): IUserPreferenceStore => ({
  getPreference: vi.fn().mockResolvedValue(null),
  savePreference: vi.fn().mockResolvedValue({} as UserPreference),
  deletePreference: vi.fn().mockResolvedValue(false),
  listPreferences: vi.fn().mockResolvedValue([]),
  trackUsage: vi.fn().mockResolvedValue(undefined),
});

const createMockTenantPolicyStore = (): ITenantPolicyStore => ({
  getPolicy: vi.fn().mockResolvedValue(null),
  createPolicy: vi.fn().mockResolvedValue({} as TenantPolicy),
  updatePolicy: vi.fn().mockResolvedValue({} as TenantPolicy),
  deletePolicy: vi.fn().mockResolvedValue(false),
  listPolicies: vi.fn().mockResolvedValue([]),
});

const createMockPatternLearner = (): IPatternLearner => ({
  learn: vi.fn().mockResolvedValue({} as LearnedPattern),
  getPattern: vi.fn().mockResolvedValue(null),
  listPatterns: vi.fn().mockResolvedValue([]),
  decayPatterns: vi.fn().mockResolvedValue(0),
});

// ========================================
// Tests
// ========================================

describe('DecisionEngine', () => {
  describe('Level 5: Profile Heuristic (Default) — Sitemap-based strategy', () => {
    test('selects bulk for rich sitemap (>50 pages)', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        estimatedSize: 200,
        metadata: { hasSitemap: true },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('bulk');
      expect(decision.source).toBe('profile-heuristic');
      expect(decision.reasoning).toContain('Sitemap found with 200 pages');
    });

    test('selects hybrid for thin sitemap (1-50 pages)', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        estimatedSize: 30,
        metadata: { hasSitemap: true },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('hybrid');
      expect(decision.source).toBe('profile-heuristic');
      expect(decision.reasoning).toContain('coverage may be limited');
    });

    test('selects browser when no sitemap exists', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        estimatedSize: 100,
        metadata: { hasSitemap: false },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('browser');
      expect(decision.source).toBe('profile-heuristic');
      expect(decision.reasoning).toContain('No sitemap found');
    });

    test('selects browser when metadata.hasSitemap is missing', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        estimatedSize: 500,
        metadata: {},
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('browser');
      expect(decision.reasoning).toContain('No sitemap found');
    });

    test('strategy is independent of siteType — SPA with rich sitemap gets bulk', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        siteType: 'spa',
        jsRequired: true,
        estimatedSize: 200,
        metadata: { hasSitemap: true },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('bulk');
    });

    test('strategy is independent of siteType — static site without sitemap gets browser', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        siteType: 'static',
        jsRequired: false,
        estimatedSize: 100,
        metadata: { hasSitemap: false },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('browser');
    });

    test('boundary: exactly 50 pages → hybrid (not bulk)', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        estimatedSize: 50,
        metadata: { hasSitemap: true },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('hybrid');
    });

    test('boundary: 51 pages → bulk', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        estimatedSize: 51,
        metadata: { hasSitemap: true },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('bulk');
    });

    test('adjusts batch size based on site size (bulk strategy)', async () => {
      const engine = new DecisionEngine();

      // Medium site (bulk)
      const mediumProfile = createProfile({
        estimatedSize: 500,
        metadata: { hasSitemap: true },
      });
      const mediumDecision = await engine.decide(createContext(mediumProfile));
      expect(mediumDecision.strategy).toBe('bulk');
      expect(mediumDecision.batchSize).toBe(50);

      // Large site (bulk)
      const largeProfile = createProfile({
        estimatedSize: 5000,
        metadata: { hasSitemap: true },
      });
      const largeDecision = await engine.decide(createContext(largeProfile));
      expect(largeDecision.strategy).toBe('bulk');
      expect(largeDecision.batchSize).toBe(100);
    });

    test('reduces concurrency when rate limiting detected', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        estimatedSize: 200,
        metadata: { hasSitemap: true },
        rateLimitDetected: true,
        maxConcurrency: 10,
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.concurrency).toBeLessThanOrEqual(2);
      expect(decision.reasoning).toContain('Rate limiting');
    });

    test('respects profile max concurrency', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        estimatedSize: 200,
        metadata: { hasSitemap: true },
        maxConcurrency: 3,
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.concurrency).toBeLessThanOrEqual(3);
    });

    test('adjusts concurrency for slow response times', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        estimatedSize: 200,
        metadata: { hasSitemap: true },
        avgResponseTime: 5000,
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.concurrency).toBeLessThanOrEqual(5);
    });

    test('considers previous crawl failure', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        estimatedSize: 200,
        metadata: { hasSitemap: true },
      });
      const context = createContext(profile, {
        previousCrawl: {
          strategy: 'bulk',
          success: false,
          duration: 10000,
          throughput: 0.5,
        },
      });

      const decision = await engine.decide(context);

      expect(decision.reasoning).toContain('Previous');
      expect(decision.reasoning).toContain('failed');
    });

    test('considers previous low throughput', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        estimatedSize: 200,
        metadata: { hasSitemap: true },
      });
      const context = createContext(profile, {
        previousCrawl: {
          strategy: 'bulk',
          success: true,
          duration: 30000,
          throughput: 0.8,
        },
      });

      const decision = await engine.decide(context);

      expect(decision.reasoning).toContain('throughput');
    });
  });

  describe('Level 4: Learned Pattern', () => {
    test('applies learned pattern when confidence is high', async () => {
      const patternLearner = createMockPatternLearner();
      const learnedPattern: LearnedPattern = {
        id: 'pattern-1',
        tenantId: 'tenant-123',
        domain: 'example.com',
        siteType: 'static',
        optimalStrategy: 'bulk',
        optimalBatchSize: 75,
        optimalConcurrency: 15,
        confidence: 92,
        successCount: 18,
        totalCount: 20,
        successRate: 0.9,
        metrics: {
          avgDuration: 25000,
          avgThroughput: 3.0,
          avgMemoryMB: 150,
        },
        firstSeenAt: new Date(),
        lastValidatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(patternLearner.getPattern).mockResolvedValue(learnedPattern);

      const engine = new DecisionEngine({ patternLearner });
      const profile = createProfile({ siteType: 'static' });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('bulk');
      expect(decision.batchSize).toBe(75);
      expect(decision.concurrency).toBe(15);
      expect(decision.source).toBe('learned-pattern');
      expect(decision.confidence).toBe(92);
      expect(decision.reasoning).toContain('Learned from');
      expect(decision.reasoning).toContain('18 successful');
      expect(decision.reasoning).toContain('90%');
      expect(decision.metadata?.patternSuccessRate).toBe(0.9);
      expect(decision.metadata?.avgThroughput).toBe(3.0);
    });

    test('ignores learned pattern with low confidence', async () => {
      const patternLearner = createMockPatternLearner();
      const learnedPattern: LearnedPattern = {
        id: 'pattern-1',
        tenantId: 'tenant-123',
        domain: 'example.com',
        siteType: 'static',
        optimalStrategy: 'bulk',
        optimalBatchSize: 75,
        optimalConcurrency: 15,
        confidence: 60, // Below 70 threshold
        successCount: 5,
        totalCount: 10,
        successRate: 0.5,
        metrics: {
          avgDuration: 25000,
          avgThroughput: 2.0,
          avgMemoryMB: 150,
        },
        firstSeenAt: new Date(),
        lastValidatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(patternLearner.getPattern).mockResolvedValue(learnedPattern);

      const engine = new DecisionEngine({ patternLearner });
      const profile = createProfile({ siteType: 'static' });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      // Should fall back to profile heuristic
      expect(decision.source).toBe('profile-heuristic');
    });

    test('ignores learned pattern with low success rate', async () => {
      const patternLearner = createMockPatternLearner();
      const learnedPattern: LearnedPattern = {
        id: 'pattern-1',
        tenantId: 'tenant-123',
        domain: 'example.com',
        siteType: 'static',
        optimalStrategy: 'bulk',
        optimalBatchSize: 75,
        optimalConcurrency: 15,
        confidence: 85,
        successCount: 7,
        totalCount: 10,
        successRate: 0.7, // Below 0.8 threshold
        metrics: {
          avgDuration: 25000,
          avgThroughput: 2.5,
          avgMemoryMB: 150,
        },
        firstSeenAt: new Date(),
        lastValidatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(patternLearner.getPattern).mockResolvedValue(learnedPattern);

      const engine = new DecisionEngine({ patternLearner });
      const profile = createProfile({ siteType: 'static' });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      // Should fall back to profile heuristic
      expect(decision.source).toBe('profile-heuristic');
    });
  });

  describe('Level 3: Tenant Policy', () => {
    test('applies tenant policy with limits', async () => {
      const tenantPolicyStore = createMockTenantPolicyStore();
      const policy: TenantPolicy = {
        id: 'policy-1',
        tenantId: 'tenant-123',
        domainPattern: '*.example.com',
        allowedStrategies: ['bulk', 'hybrid'],
        limits: {
          maxBatchSize: 30,
          maxConcurrency: 5,
          maxMemoryMB: 512,
          maxDurationMinutes: 30,
        },
        createdBy: 'admin',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(tenantPolicyStore.getPolicy).mockResolvedValue(policy);

      const engine = new DecisionEngine({ tenantPolicyStore });
      const profile = createProfile({
        estimatedSize: 5000,
        metadata: { hasSitemap: true },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('bulk');
      expect(decision.batchSize).toBeLessThanOrEqual(30);
      expect(decision.concurrency).toBeLessThanOrEqual(5);
      expect(decision.source).toBe('tenant-policy');
      expect(decision.confidence).toBe(80);
      expect(decision.reasoning).toContain('organization policy');
      expect(decision.metadata?.policyId).toBe('policy-1');
    });

    test('respects allowed strategies in policy', async () => {
      const tenantPolicyStore = createMockTenantPolicyStore();
      const policy: TenantPolicy = {
        id: 'policy-1',
        tenantId: 'tenant-123',
        domainPattern: 'example.com',
        allowedStrategies: ['browser'], // Only browser allowed
        limits: {
          maxBatchSize: 10,
          maxConcurrency: 2,
          maxMemoryMB: 256,
          maxDurationMinutes: 15,
        },
        createdBy: 'admin',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(tenantPolicyStore.getPolicy).mockResolvedValue(policy);

      const engine = new DecisionEngine({ tenantPolicyStore });
      // No sitemap → selectStrategy returns 'browser', which matches allowed
      const profile = createProfile({
        estimatedSize: 100,
        metadata: { hasSitemap: false },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('browser');
      expect(decision.source).toBe('tenant-policy');
    });

    test('selects fallback strategy when preferred is not allowed', async () => {
      const tenantPolicyStore = createMockTenantPolicyStore();
      const policy: TenantPolicy = {
        id: 'policy-1',
        tenantId: 'tenant-123',
        domainPattern: 'example.com',
        allowedStrategies: ['hybrid'], // bulk not allowed
        limits: {
          maxBatchSize: 20,
          maxConcurrency: 5,
          maxMemoryMB: 512,
          maxDurationMinutes: 30,
        },
        createdBy: 'admin',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(tenantPolicyStore.getPolicy).mockResolvedValue(policy);

      const engine = new DecisionEngine({ tenantPolicyStore });
      // Rich sitemap → selectStrategy returns 'bulk', but policy only allows hybrid
      const profile = createProfile({
        siteType: 'spa',
        jsRequired: true,
        estimatedSize: 200,
        metadata: { hasSitemap: true },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('hybrid'); // Falls back to allowed strategy
      expect(decision.source).toBe('tenant-policy');
    });

    test('generates alternatives within policy constraints', async () => {
      const tenantPolicyStore = createMockTenantPolicyStore();
      const policy: TenantPolicy = {
        id: 'policy-1',
        tenantId: 'tenant-123',
        domainPattern: 'example.com',
        allowedStrategies: ['bulk', 'hybrid'],
        limits: {
          maxBatchSize: 40,
          maxConcurrency: 8,
          maxMemoryMB: 512,
          maxDurationMinutes: 30,
        },
        createdBy: 'admin',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(tenantPolicyStore.getPolicy).mockResolvedValue(policy);

      const engine = new DecisionEngine({ tenantPolicyStore });
      // Rich sitemap → bulk selected, only hybrid as alternative (browser not allowed)
      const profile = createProfile({
        estimatedSize: 200,
        metadata: { hasSitemap: true },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('bulk');
      expect(decision.alternatives).toBeDefined();
      expect(decision.alternatives?.length).toBe(1); // Only hybrid (browser not allowed)
      expect(decision.alternatives?.[0].strategy).toBe('hybrid');
      expect(decision.alternatives?.[0].batchSize).toBeLessThanOrEqual(40);
      expect(decision.alternatives?.[0].concurrency).toBeLessThanOrEqual(8);
    });
  });

  describe('Level 2: User Preference', () => {
    test('applies user preference when autoDecide is true', async () => {
      const userPreferenceStore = createMockUserPreferenceStore();
      const preference: UserPreference = {
        id: 'pref-1',
        userId: 'user-456',
        tenantId: 'tenant-123',
        domainPattern: 'example.com',
        strategy: 'hybrid',
        batchSize: 15,
        concurrency: 3,
        autoDecide: true,
        useCount: 5,
        lastUsed: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(userPreferenceStore.getPreference).mockResolvedValue(preference);

      const engine = new DecisionEngine({ userPreferenceStore });
      const profile = createProfile({ siteType: 'static' });
      const context = createContext(profile, { userId: 'user-456' });

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('hybrid');
      expect(decision.batchSize).toBe(15);
      expect(decision.concurrency).toBe(3);
      expect(decision.source).toBe('user-preference');
      expect(decision.confidence).toBe(90);
      expect(decision.reasoning).toContain('saved preference');
      expect(decision.reasoning).toContain('5 times');
      expect(decision.metadata?.preferenceUseCount).toBe(5);

      // Verify trackUsage was called
      expect(userPreferenceStore.trackUsage).toHaveBeenCalledWith('pref-1');
    });

    test('ignores user preference when autoDecide is false', async () => {
      const userPreferenceStore = createMockUserPreferenceStore();
      const preference: UserPreference = {
        id: 'pref-1',
        userId: 'user-456',
        tenantId: 'tenant-123',
        domainPattern: 'example.com',
        strategy: 'hybrid',
        autoDecide: false, // Should be ignored
        useCount: 5,
        lastUsed: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(userPreferenceStore.getPreference).mockResolvedValue(preference);

      const engine = new DecisionEngine({ userPreferenceStore });
      const profile = createProfile({ siteType: 'static' });
      const context = createContext(profile, { userId: 'user-456' });

      const decision = await engine.decide(context);

      // Should skip to next level (tenant policy or profile heuristic)
      expect(decision.source).not.toBe('user-preference');
    });

    test('skips user preference when userId not provided', async () => {
      const userPreferenceStore = createMockUserPreferenceStore();

      const engine = new DecisionEngine({ userPreferenceStore });
      const profile = createProfile({ siteType: 'static' });
      const context = createContext(profile); // No userId

      const decision = await engine.decide(context);

      expect(decision.source).not.toBe('user-preference');
      expect(userPreferenceStore.getPreference).not.toHaveBeenCalled();
    });

    test('uses default batch/concurrency when preference omits them', async () => {
      const userPreferenceStore = createMockUserPreferenceStore();
      const preference: UserPreference = {
        id: 'pref-1',
        userId: 'user-456',
        tenantId: 'tenant-123',
        domainPattern: 'example.com',
        strategy: 'bulk',
        // batchSize and concurrency omitted
        autoDecide: true,
        useCount: 2,
        lastUsed: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(userPreferenceStore.getPreference).mockResolvedValue(preference);

      const engine = new DecisionEngine({ userPreferenceStore });
      const profile = createProfile({ siteType: 'static', estimatedSize: 500 });
      const context = createContext(profile, { userId: 'user-456' });

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('bulk');
      expect(decision.batchSize).toBeGreaterThan(0); // Calculated from defaults
      expect(decision.concurrency).toBeGreaterThan(0); // Calculated from defaults
    });
  });

  describe('Level 1: User Override', () => {
    test('applies user override with complete settings', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({ siteType: 'static' });
      const context = createContext(profile, {
        userOverride: {
          strategy: 'browser',
          batchSize: 3,
          concurrency: 2,
          jsHandling: 'dynamic',
          waitForJs: 3000,
          confidence: 100,
          reasoning: 'User knows best',
          source: 'user-override',
        },
      });

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('browser');
      expect(decision.batchSize).toBe(3);
      expect(decision.concurrency).toBe(2);
      expect(decision.source).toBe('user-override');
      expect(decision.confidence).toBe(100);
      expect(decision.reasoning).toContain('explicitly selected');
    });

    test('applies user override with partial settings', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({ siteType: 'static', estimatedSize: 500 });
      const context = createContext(profile, {
        userOverride: {
          strategy: 'hybrid',
          // batchSize and concurrency will be calculated
        },
      });

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('hybrid');
      expect(decision.batchSize).toBeGreaterThan(0);
      expect(decision.concurrency).toBeGreaterThan(0);
      expect(decision.source).toBe('user-override');
      expect(decision.confidence).toBe(100);
    });

    test('user override takes precedence over all other sources', async () => {
      const userPreferenceStore = createMockUserPreferenceStore();
      const tenantPolicyStore = createMockTenantPolicyStore();
      const patternLearner = createMockPatternLearner();

      // Set up all stores to return data
      vi.mocked(userPreferenceStore.getPreference).mockResolvedValue({
        strategy: 'bulk',
        autoDecide: true,
      } as UserPreference);

      vi.mocked(tenantPolicyStore.getPolicy).mockResolvedValue({
        allowedStrategies: ['bulk'],
      } as TenantPolicy);

      vi.mocked(patternLearner.getPattern).mockResolvedValue({
        optimalStrategy: 'bulk',
        confidence: 95,
        successRate: 0.95,
      } as LearnedPattern);

      const engine = new DecisionEngine({
        userPreferenceStore,
        tenantPolicyStore,
        patternLearner,
      });

      const profile = createProfile({ siteType: 'static' });
      const context = createContext(profile, {
        userId: 'user-456',
        userOverride: {
          strategy: 'browser', // Different from all other sources
        },
      });

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('browser');
      expect(decision.source).toBe('user-override');

      // Verify other stores were not called
      expect(userPreferenceStore.getPreference).not.toHaveBeenCalled();
      expect(tenantPolicyStore.getPolicy).not.toHaveBeenCalled();
      expect(patternLearner.getPattern).not.toHaveBeenCalled();
    });
  });

  describe('Alternative Generation', () => {
    test('generates alternatives for different strategies', async () => {
      const engine = new DecisionEngine();
      // Rich sitemap → bulk selected → alternatives should be browser and hybrid
      const profile = createProfile({
        estimatedSize: 200,
        metadata: { hasSitemap: true },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.strategy).toBe('bulk');
      expect(decision.alternatives).toBeDefined();
      expect(decision.alternatives?.length).toBeGreaterThan(0);

      const strategies = decision.alternatives?.map((alt) => alt.strategy) ?? [];
      expect(strategies).toContain('browser');
      expect(strategies).toContain('hybrid');
      expect(strategies).not.toContain(decision.strategy);
    });

    test('alternatives include reasoning and expected outcomes', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        estimatedSize: 200,
        metadata: { hasSitemap: true },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);

      expect(decision.alternatives).toBeDefined();
      decision.alternatives?.forEach((alt) => {
        expect(alt.reasoning).toBeDefined();
        expect(alt.reasoning.length).toBeGreaterThan(0);
        expect(alt.expectedOutcome).toBeDefined();
        expect(alt.expectedOutcome.estimatedDuration).toBeGreaterThan(0);
        expect(alt.expectedOutcome.estimatedThroughput).toBeGreaterThan(0);
        expect(alt.expectedOutcome.reliability).toBeGreaterThanOrEqual(0);
        expect(alt.expectedOutcome.reliability).toBeLessThanOrEqual(100);
      });
    });

    test('browser alternative has lower throughput than bulk', async () => {
      const engine = new DecisionEngine();
      // Use browser-selected scenario — no sitemap
      const profile = createProfile({
        estimatedSize: 100,
        metadata: { hasSitemap: false },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);
      expect(decision.strategy).toBe('browser');

      const bulkAlt = decision.alternatives?.find((alt) => alt.strategy === 'bulk');

      if (bulkAlt) {
        expect(bulkAlt.reasoning).toContain('efficient');
      }
    });
  });

  describe('recordOutcome', () => {
    test('records successful outcome', async () => {
      const patternLearner = createMockPatternLearner();
      const engine = new DecisionEngine({ patternLearner });

      const outcome: CrawlOutcome = {
        tenantId: 'tenant-123',
        domain: 'example.com',
        strategy: 'bulk',
        batchSize: 50,
        concurrency: 10,
        success: true,
        urlsCrawled: 100,
        duration: 30000,
        throughput: 3.33,
        memoryUsedMB: 200,
        completedAt: new Date(),
      };

      await engine.recordOutcome(outcome);

      expect(patternLearner.learn).toHaveBeenCalledWith(
        outcome,
        expect.objectContaining({
          domain: 'example.com',
        }),
      );
    });

    test('records failed outcome', async () => {
      const patternLearner = createMockPatternLearner();
      const engine = new DecisionEngine({ patternLearner });

      const outcome: CrawlOutcome = {
        tenantId: 'tenant-123',
        domain: 'example.com',
        strategy: 'browser',
        batchSize: 1,
        concurrency: 1,
        success: false,
        urlsCrawled: 5,
        duration: 10000,
        throughput: 0.5,
        error: 'Navigation timeout',
        completedAt: new Date(),
      };

      await engine.recordOutcome(outcome);

      expect(patternLearner.learn).toHaveBeenCalled();
    });

    test('handles missing pattern learner gracefully', async () => {
      const engine = new DecisionEngine(); // No pattern learner

      const outcome: CrawlOutcome = {
        tenantId: 'tenant-123',
        domain: 'example.com',
        strategy: 'bulk',
        batchSize: 50,
        concurrency: 10,
        success: true,
        urlsCrawled: 100,
        duration: 30000,
        throughput: 3.33,
        completedAt: new Date(),
      };

      await expect(engine.recordOutcome(outcome)).resolves.toBeUndefined();
    });

    test('handles learning errors gracefully', async () => {
      const patternLearner = createMockPatternLearner();
      vi.mocked(patternLearner.learn).mockRejectedValue(new Error('Learning failed'));

      const engine = new DecisionEngine({ patternLearner });

      const outcome: CrawlOutcome = {
        tenantId: 'tenant-123',
        domain: 'example.com',
        strategy: 'bulk',
        batchSize: 50,
        concurrency: 10,
        success: true,
        urlsCrawled: 100,
        duration: 30000,
        throughput: 3.33,
        completedAt: new Date(),
      };

      // Should not throw even if learning fails
      await expect(engine.recordOutcome(outcome)).resolves.toBeUndefined();
    });
  });

  describe('explain', () => {
    test('generates detailed explanation', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        estimatedSize: 200,
        metadata: { hasSitemap: true },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);
      const explanation = engine.explain(decision);

      expect(explanation).toContain('Decision:');
      expect(explanation).toContain('BULK');
      expect(explanation).toContain('Source:');
      expect(explanation).toContain('profile-heuristic');
      expect(explanation).toContain('Confidence:');
      expect(explanation).toContain('Reasoning:');
      expect(explanation).toContain('Parameters:');
      expect(explanation).toContain('Batch Size:');
      expect(explanation).toContain('Concurrency:');
      expect(explanation).toContain('JS Handling:');
    });

    test('includes alternatives in explanation', async () => {
      const engine = new DecisionEngine();
      const profile = createProfile({
        estimatedSize: 200,
        metadata: { hasSitemap: true },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);
      const explanation = engine.explain(decision);

      expect(explanation).toContain('Alternatives:');
      expect(explanation).toContain('BROWSER');
      expect(explanation).toContain('HYBRID');
      expect(explanation).toContain('Duration:');
      expect(explanation).toContain('Throughput:');
      expect(explanation).toContain('Reliability:');
    });

    test('includes waitForJs when applicable', async () => {
      const engine = new DecisionEngine();
      // SPA with no sitemap → browser strategy → dynamic JS handling
      const profile = createProfile({
        siteType: 'spa',
        jsRequired: true,
        estimatedSize: 100,
        metadata: { hasSitemap: false },
      });
      const context = createContext(profile);

      const decision = await engine.decide(context);
      expect(decision.strategy).toBe('browser');
      const explanation = engine.explain(decision);

      expect(explanation).toContain('Wait for JS:');
      expect(explanation).toContain('2000ms');
    });
  });

  describe('Error Handling', () => {
    test('throws DecisionError on failure', async () => {
      const userPreferenceStore = createMockUserPreferenceStore();
      vi.mocked(userPreferenceStore.getPreference).mockRejectedValue(new Error('Database error'));

      const engine = new DecisionEngine({ userPreferenceStore });
      const profile = createProfile({ siteType: 'static' });
      const context = createContext(profile, { userId: 'user-456' });

      await expect(engine.decide(context)).rejects.toThrow('Failed to make crawl decision');
    });

    test('includes original error as cause', async () => {
      const tenantPolicyStore = createMockTenantPolicyStore();
      const originalError = new Error('Network timeout');
      vi.mocked(tenantPolicyStore.getPolicy).mockRejectedValue(originalError);

      const engine = new DecisionEngine({ tenantPolicyStore });
      const profile = createProfile({ siteType: 'static' });
      const context = createContext(profile);

      try {
        await engine.decide(context);
      } catch (error: any) {
        expect(error.code).toBe('DECISION_FAILED');
        expect(error.cause).toBe(originalError);
      }
    });
  });
});
