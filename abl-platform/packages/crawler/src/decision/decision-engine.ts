/**
 * Decision Engine - Core autonomous decision-making implementation
 *
 * Implements the 5-level decision hierarchy:
 * 1. User Override (highest precedence)
 * 2. User Preference
 * 3. Tenant Policy
 * 4. Learned Pattern
 * 5. Profile Heuristic (default)
 *
 * Design Principles:
 * - Single Responsibility: Each method handles one level of hierarchy
 * - Strategy Pattern: Each decision source is a separate method
 * - Open/Closed: Easy to add new hierarchy levels or decision factors
 * - Dependency Injection: External stores injected via constructor
 */

import { createLogger } from '../logger.js';

import type {
  CrawlStrategy,
  CrawlDecision,
  Alternative,
  DecisionContext,
  CrawlOutcome,
  IDecisionEngine,
  IUserPreferenceStore,
  ITenantPolicyStore,
  IPatternLearner,
} from './interfaces.js';
import type { SiteProfile } from '../profiler/interfaces.js';
import { DecisionError } from './interfaces.js';

/**
 * Decision Engine Options
 */
export interface DecisionEngineOptions {
  /** User preference store (optional) */
  userPreferenceStore?: IUserPreferenceStore;

  /** Tenant policy store (optional) */
  tenantPolicyStore?: ITenantPolicyStore;

  /** Pattern learner (optional) */
  patternLearner?: IPatternLearner;

  /** Default batch sizes per strategy */
  defaultBatchSizes?: {
    browser: number;
    bulk: number;
    hybrid: number;
  };

  /** Default concurrency per strategy */
  defaultConcurrency?: {
    browser: number;
    bulk: number;
    hybrid: number;
  };
}

/**
 * DecisionEngine - Autonomous crawl strategy selection
 *
 * Makes intelligent decisions based on:
 * - Site profile characteristics
 * - Historical performance data
 * - User preferences
 * - Tenant policies
 * - Previous crawl outcomes
 */
const log = createLogger('decision-engine');

export class DecisionEngine implements IDecisionEngine {
  private readonly userPreferenceStore?: IUserPreferenceStore;
  private readonly tenantPolicyStore?: ITenantPolicyStore;
  private readonly patternLearner?: IPatternLearner;

  private readonly defaultBatchSizes: Record<CrawlStrategy, number>;
  private readonly defaultConcurrency: Record<CrawlStrategy, number>;

  constructor(options: DecisionEngineOptions = {}) {
    this.userPreferenceStore = options.userPreferenceStore;
    this.tenantPolicyStore = options.tenantPolicyStore;
    this.patternLearner = options.patternLearner;

    this.defaultBatchSizes = {
      browser: options.defaultBatchSizes?.browser ?? 1,
      bulk: options.defaultBatchSizes?.bulk ?? 50,
      hybrid: options.defaultBatchSizes?.hybrid ?? 10,
    };

    this.defaultConcurrency = {
      browser: options.defaultConcurrency?.browser ?? 1,
      bulk: options.defaultConcurrency?.bulk ?? 10,
      hybrid: options.defaultConcurrency?.hybrid ?? 5,
    };
  }

  /**
   * Make a crawl decision based on context
   * Implements hierarchy: user override → user pref → tenant policy → learned → default
   */
  async decide(context: DecisionContext): Promise<CrawlDecision> {
    try {
      // Level 1: User Override (highest precedence)
      if (context.userOverride) {
        return this.applyUserOverride(context);
      }

      // Level 2: User Preference
      if (context.userId && this.userPreferenceStore) {
        const preference = await this.userPreferenceStore.getPreference(
          context.userId,
          context.tenantId,
          this.extractDomain(context.url),
        );

        if (preference && preference.autoDecide) {
          return this.applyUserPreference(context, preference);
        }
      }

      // Level 3: Tenant Policy
      if (this.tenantPolicyStore) {
        const policy = await this.tenantPolicyStore.getPolicy(
          context.tenantId,
          this.extractDomain(context.url),
        );

        if (policy) {
          return this.applyTenantPolicy(context, policy);
        }
      }

      // Level 4: Learned Pattern
      if (this.patternLearner) {
        const pattern = await this.patternLearner.getPattern(
          context.tenantId,
          this.extractDomain(context.url),
        );

        if (pattern && pattern.confidence >= 70 && pattern.successRate >= 0.8) {
          return this.applyLearnedPattern(context, pattern);
        }
      }

      // Level 5: Profile Heuristic (default)
      return this.applyProfileHeuristic(context);
    } catch (error) {
      throw new DecisionError(
        'Failed to make crawl decision',
        'DECISION_FAILED',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Record a crawl outcome for learning
   * Updates learned patterns based on success/failure
   */
  async recordOutcome(outcome: CrawlOutcome): Promise<void> {
    if (!this.patternLearner) {
      return;
    }

    try {
      // For learning, we need the profile - in production this would be fetched
      // For now, we construct a minimal profile from outcome data
      const profile: SiteProfile = {
        domain: outcome.domain,
        profiledAt: new Date(),
        siteType: 'unknown',
        jsRequired: outcome.strategy === 'browser',
        linkDensity: 0,
        estimatedSize: outcome.urlsCrawled,
        avgResponseTime: outcome.duration / Math.max(outcome.urlsCrawled, 1),
        rateLimitDetected: false,
        maxConcurrency: outcome.concurrency,
        confidence: 50,
        metadata: {},
      };

      await this.patternLearner.learn(outcome, profile);
    } catch (error) {
      // Log but don't throw - learning failures shouldn't break the caller
      log.error('Failed to record outcome', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get decision explanation (for transparency)
   * Returns detailed reasoning for a given decision
   */
  explain(decision: CrawlDecision): string {
    const parts: string[] = [];

    // Header with strategy and source
    parts.push(`Decision: ${decision.strategy.toUpperCase()} strategy`);
    parts.push(`Source: ${decision.source}`);
    parts.push(`Confidence: ${decision.confidence}%`);
    parts.push('');

    // Reasoning
    parts.push(`Reasoning: ${decision.reasoning}`);
    parts.push('');

    // Parameters
    parts.push('Parameters:');
    parts.push(`  - Batch Size: ${decision.batchSize}`);
    parts.push(`  - Concurrency: ${decision.concurrency}`);
    parts.push(`  - JS Handling: ${decision.jsHandling}`);
    if (decision.waitForJs) {
      parts.push(`  - Wait for JS: ${decision.waitForJs}ms`);
    }
    parts.push('');

    // Alternatives
    if (decision.alternatives && decision.alternatives.length > 0) {
      parts.push('Alternatives:');
      decision.alternatives.forEach((alt, idx) => {
        parts.push(`  ${idx + 1}. ${alt.strategy.toUpperCase()}`);
        parts.push(`     ${alt.reasoning}`);
        parts.push(`     Duration: ~${alt.expectedOutcome.estimatedDuration}ms`);
        parts.push(`     Throughput: ~${alt.expectedOutcome.estimatedThroughput} pages/sec`);
        parts.push(`     Reliability: ${alt.expectedOutcome.reliability}%`);
      });
    }

    return parts.join('\n');
  }

  // ========================================
  // Private: Hierarchy Level Implementations
  // ========================================

  /**
   * Level 1: Apply user override
   */
  private applyUserOverride(context: DecisionContext): CrawlDecision {
    const override = context.userOverride!;
    const strategy = override.strategy ?? this.selectStrategy(context.profile);
    const batchSize = override.batchSize ?? this.calculateBatchSize(strategy, context.profile);
    const concurrency =
      override.concurrency ?? this.calculateConcurrency(strategy, context.profile);
    const jsHandling = this.determineJsHandling(strategy, context.profile);

    return {
      strategy,
      batchSize,
      concurrency,
      jsHandling,
      waitForJs: jsHandling === 'dynamic' ? 2000 : undefined,
      confidence: 100, // User override is always 100% confident
      reasoning: 'User explicitly selected this strategy for this crawl',
      source: 'user-override',
      alternatives: this.generateAlternatives(strategy, context.profile),
    };
  }

  /**
   * Level 2: Apply user preference
   */
  private async applyUserPreference(
    context: DecisionContext,
    preference: any,
  ): Promise<CrawlDecision> {
    const strategy = preference.strategy;
    const batchSize = preference.batchSize ?? this.calculateBatchSize(strategy, context.profile);
    const concurrency =
      preference.concurrency ?? this.calculateConcurrency(strategy, context.profile);
    const jsHandling = this.determineJsHandling(strategy, context.profile);

    // Track usage
    if (this.userPreferenceStore && preference.id) {
      await this.userPreferenceStore.trackUsage(preference.id);
    }

    return {
      strategy,
      batchSize,
      concurrency,
      jsHandling,
      waitForJs: jsHandling === 'dynamic' ? 2000 : undefined,
      confidence: 90,
      reasoning: `User's saved preference for this domain (used ${preference.useCount} times)`,
      source: 'user-preference',
      alternatives: this.generateAlternatives(strategy, context.profile),
      metadata: {
        profileConfidence: context.profile.confidence,
        preferenceUseCount: preference.useCount,
      },
    };
  }

  /**
   * Level 3: Apply tenant policy
   */
  private applyTenantPolicy(context: DecisionContext, policy: any): CrawlDecision {
    const strategy = this.selectStrategyWithPolicy(context.profile, policy);
    let batchSize = this.calculateBatchSize(strategy, context.profile);
    let concurrency = this.calculateConcurrency(strategy, context.profile);
    const jsHandling = this.determineJsHandling(strategy, context.profile);

    // Apply policy limits
    batchSize = Math.min(batchSize, policy.limits.maxBatchSize);
    concurrency = Math.min(concurrency, policy.limits.maxConcurrency);

    return {
      strategy,
      batchSize,
      concurrency,
      jsHandling,
      waitForJs: jsHandling === 'dynamic' ? 2000 : undefined,
      confidence: 80,
      reasoning: `Selected based on organization policy for ${policy.domainPattern}`,
      source: 'tenant-policy',
      alternatives: this.generateAlternativesWithPolicy(strategy, context.profile, policy),
      metadata: {
        profileConfidence: context.profile.confidence,
        policyId: policy.id,
      },
    };
  }

  /**
   * Level 4: Apply learned pattern
   */
  private applyLearnedPattern(context: DecisionContext, pattern: any): CrawlDecision {
    const strategy = pattern.optimalStrategy;
    const batchSize = pattern.optimalBatchSize;
    const concurrency = pattern.optimalConcurrency;
    const jsHandling = this.determineJsHandling(strategy, context.profile);

    return {
      strategy,
      batchSize,
      concurrency,
      jsHandling,
      waitForJs: jsHandling === 'dynamic' ? 2000 : undefined,
      confidence: pattern.confidence,
      reasoning: `Learned from ${pattern.successCount} successful crawls (${(pattern.successRate * 100).toFixed(0)}% success rate)`,
      source: 'learned-pattern',
      alternatives: this.generateAlternatives(strategy, context.profile),
      metadata: {
        profileConfidence: context.profile.confidence,
        patternSuccessRate: pattern.successRate,
        patternSuccessCount: pattern.successCount,
        avgDuration: pattern.metrics.avgDuration,
        avgThroughput: pattern.metrics.avgThroughput,
      },
    };
  }

  /**
   * Level 5: Apply profile heuristic (default)
   */
  private applyProfileHeuristic(context: DecisionContext): CrawlDecision {
    const strategy = this.selectStrategy(context.profile);
    const batchSize = this.calculateBatchSize(strategy, context.profile);
    const concurrency = this.calculateConcurrency(strategy, context.profile);
    const jsHandling = this.determineJsHandling(strategy, context.profile);

    let reasoning = this.generateProfileReasoning(context.profile, strategy);

    // Consider previous crawl history
    if (context.previousCrawl) {
      if (!context.previousCrawl.success) {
        reasoning += ` Previous ${context.previousCrawl.strategy} crawl failed - trying different approach.`;
      } else if (context.previousCrawl.throughput < 1.0) {
        reasoning += ` Previous crawl had low throughput (${context.previousCrawl.throughput.toFixed(2)} pages/sec).`;
      }
    }

    return {
      strategy,
      batchSize,
      concurrency,
      jsHandling,
      waitForJs: jsHandling === 'dynamic' ? 2000 : undefined,
      confidence: context.profile.confidence,
      reasoning,
      source: 'profile-heuristic',
      alternatives: this.generateAlternatives(strategy, context.profile),
      metadata: {
        profileConfidence: context.profile.confidence,
      },
    };
  }

  // ========================================
  // Private: Strategy Selection Logic
  // ========================================

  /**
   * Select optimal strategy based on site profile
   *
   * This strategy is used by the frontend to recommend Sitemap vs Guided Discovery.
   * The mapping is: bulk → sitemap recommended, browser → guided discovery recommended.
   *
   * Discovery strategy depends ONLY on sitemap quality — not on siteType or jsRequired.
   * siteType/jsRequired affect the rendering mode (how to fetch pages), which is a
   * separate concern configured on the Configure step.
   */
  private selectStrategy(profile: SiteProfile): CrawlStrategy {
    const hasSitemap = profile.metadata.hasSitemap === true;
    const sitemapSize = hasSitemap ? profile.estimatedSize : 0;

    // Rich sitemap (50+ pages) → recommend sitemap as URL source
    if (sitemapSize > 50) return 'bulk';

    // Thin sitemap (1-50 pages) → sitemap exists but coverage uncertain
    if (sitemapSize > 0) return 'hybrid';

    // No sitemap → guided discovery is the only option
    return 'browser';
  }

  /**
   * Select strategy constrained by tenant policy
   */
  private selectStrategyWithPolicy(profile: SiteProfile, policy: any): CrawlStrategy {
    const preferred = this.selectStrategy(profile);

    // If preferred strategy is allowed, use it
    if (policy.allowedStrategies.includes(preferred)) {
      return preferred;
    }

    // Otherwise, pick the first allowed strategy that makes sense
    if (profile.jsRequired || profile.siteType === 'spa') {
      // Need browser or hybrid
      if (policy.allowedStrategies.includes('browser')) return 'browser';
      if (policy.allowedStrategies.includes('hybrid')) return 'hybrid';
    }

    // Fallback to first allowed strategy
    return policy.allowedStrategies[0] as CrawlStrategy;
  }

  // ========================================
  // Private: Parameter Calculation
  // ========================================

  /**
   * Calculate optimal batch size for strategy and profile
   */
  private calculateBatchSize(strategy: CrawlStrategy, profile: SiteProfile): number {
    const base = this.defaultBatchSizes[strategy];

    if (strategy === 'bulk') {
      // Adjust based on site size
      if (profile.estimatedSize > 1000) return 100;
      if (profile.estimatedSize > 100) return 50;
      return 25;
    }

    if (strategy === 'hybrid') {
      // Smaller batches for hybrid
      if (profile.estimatedSize > 500) return 20;
      if (profile.estimatedSize > 100) return 10;
      return 5;
    }

    // Browser: always small batches
    return base;
  }

  /**
   * Calculate optimal concurrency for strategy and profile
   */
  private calculateConcurrency(strategy: CrawlStrategy, profile: SiteProfile): number {
    let concurrency = this.defaultConcurrency[strategy];

    // Apply all constraints cumulatively

    // Respect rate limits (highest priority)
    if (profile.rateLimitDetected) {
      concurrency = Math.min(concurrency, 2);
    }

    // Adjust for slow response times
    if (profile.avgResponseTime > 3000) {
      concurrency = Math.min(concurrency, 5);
    }

    // Use profile's max concurrency if available
    if (profile.maxConcurrency > 0) {
      concurrency = Math.min(concurrency, profile.maxConcurrency);
    }

    return concurrency;
  }

  /**
   * Determine JavaScript handling strategy
   */
  private determineJsHandling(
    strategy: CrawlStrategy,
    profile: SiteProfile,
  ): 'none' | 'static' | 'dynamic' {
    if (strategy === 'browser') {
      return profile.siteType === 'spa' ? 'dynamic' : 'static';
    }

    if (strategy === 'hybrid') {
      return profile.jsRequired ? 'static' : 'none';
    }

    return 'none';
  }

  // ========================================
  // Private: Alternative Generation
  // ========================================

  /**
   * Generate alternative strategies
   */
  private generateAlternatives(
    selectedStrategy: CrawlStrategy,
    profile: SiteProfile,
  ): Alternative[] {
    const alternatives: Alternative[] = [];
    const strategies: CrawlStrategy[] = ['browser', 'bulk', 'hybrid'];

    for (const strategy of strategies) {
      if (strategy === selectedStrategy) continue;

      const batchSize = this.calculateBatchSize(strategy, profile);
      const concurrency = this.calculateConcurrency(strategy, profile);
      const reasoning = this.generateAlternativeReasoning(strategy, profile);
      const expectedOutcome = this.estimateOutcome(strategy, batchSize, concurrency, profile);

      alternatives.push({
        strategy,
        batchSize,
        concurrency,
        reasoning,
        expectedOutcome,
      });
    }

    return alternatives;
  }

  /**
   * Generate alternatives constrained by policy
   */
  private generateAlternativesWithPolicy(
    selectedStrategy: CrawlStrategy,
    profile: SiteProfile,
    policy: any,
  ): Alternative[] {
    const alternatives: Alternative[] = [];

    for (const strategy of policy.allowedStrategies) {
      if (strategy === selectedStrategy) continue;

      let batchSize = this.calculateBatchSize(strategy, profile);
      let concurrency = this.calculateConcurrency(strategy, profile);

      // Apply policy limits
      batchSize = Math.min(batchSize, policy.limits.maxBatchSize);
      concurrency = Math.min(concurrency, policy.limits.maxConcurrency);

      const reasoning = this.generateAlternativeReasoning(strategy, profile);
      const expectedOutcome = this.estimateOutcome(strategy, batchSize, concurrency, profile);

      alternatives.push({
        strategy,
        batchSize,
        concurrency,
        reasoning,
        expectedOutcome,
      });
    }

    return alternatives;
  }

  /**
   * Estimate outcome for a strategy
   */
  private estimateOutcome(
    strategy: CrawlStrategy,
    batchSize: number,
    concurrency: number,
    profile: SiteProfile,
  ): Alternative['expectedOutcome'] {
    const urlCount = profile.estimatedSize || 100;
    const avgResponseTime = profile.avgResponseTime || 500;

    // Estimate throughput (pages/sec)
    let throughput = concurrency / (avgResponseTime / 1000);
    if (strategy === 'browser') {
      throughput *= 0.5; // Browser is slower
    } else if (strategy === 'bulk') {
      throughput *= 1.5; // Bulk is faster
    }

    // Estimate duration (ms)
    const estimatedDuration = (urlCount / throughput) * 1000;

    // Estimate reliability based on strategy and site type
    let reliability = 70;
    if (strategy === 'browser' && profile.jsRequired) reliability = 90;
    if (strategy === 'bulk' && profile.siteType === 'static') reliability = 95;
    if (strategy === 'hybrid') reliability = 85;

    return {
      estimatedDuration: Math.round(estimatedDuration),
      estimatedThroughput: Math.round(throughput * 100) / 100,
      reliability,
    };
  }

  // ========================================
  // Private: Reasoning Generation
  // ========================================

  /**
   * Generate reasoning text for profile-based decision
   */
  private generateProfileReasoning(profile: SiteProfile, strategy: CrawlStrategy): string {
    const parts: string[] = [];
    const hasSitemap = profile.metadata.hasSitemap === true;
    const sitemapSize = hasSitemap ? profile.estimatedSize : 0;

    // Reasoning reflects sitemap quality — the sole signal for discovery strategy
    if (strategy === 'bulk') {
      parts.push(`Sitemap found with ${sitemapSize} pages`);
    } else if (strategy === 'hybrid') {
      parts.push(`Sitemap found with ${sitemapSize} pages - coverage may be limited`);
    } else {
      parts.push('No sitemap found - browser discovery needed to find pages');
    }

    if (profile.rateLimitDetected) {
      parts.push('Rate limiting detected - conservative concurrency');
    }

    return parts.join('. ');
  }

  /**
   * Generate reasoning for alternative strategy
   */
  private generateAlternativeReasoning(strategy: CrawlStrategy, profile: SiteProfile): string {
    if (strategy === 'browser') {
      return 'More reliable but slower - ensures all JavaScript content is captured';
    }

    if (strategy === 'bulk') {
      return 'Faster and more efficient - suitable if JavaScript is not critical';
    }

    if (strategy === 'hybrid') {
      return 'Balanced approach - combines speed of bulk with reliability of browser';
    }

    return 'Alternative strategy';
  }

  // ========================================
  // Private: Helpers
  // ========================================

  /**
   * Extract domain from URL
   */
  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }
}
