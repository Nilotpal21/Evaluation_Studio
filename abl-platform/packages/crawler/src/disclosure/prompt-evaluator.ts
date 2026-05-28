/**
 * Prompt Evaluator - Progressive Disclosure Logic
 *
 * Evaluates whether to prompt user based on:
 * - Decision confidence
 * - User settings (autoDecide)
 * - Crawl history (previous success)
 * - Saved preferences
 * - User overrides
 *
 * Design Principles:
 * - Progressive Disclosure: Prompt only when necessary
 * - 5 Skip Rules: Clear reasons to skip prompting
 * - Learning: Fewer prompts over time
 */

import type {
  IPromptEvaluator,
  IUserDisclosureSettingsStore,
  PromptEvaluation,
  UserDisclosureSettings,
  CrawlHistory,
} from './interfaces.js';
import type {
  CrawlDecision,
  DecisionContext,
  IPatternLearner,
  IUserPreferenceStore,
} from '../decision/interfaces.js';
import { DisclosureError } from './interfaces.js';

/**
 * Prompt Evaluator Options
 */
export interface PromptEvaluatorOptions {
  /** User disclosure settings store (optional) */
  userSettingsStore?: IUserDisclosureSettingsStore;

  /** Pattern learner for crawl history (optional) */
  patternLearner?: IPatternLearner;

  /** User preference store (optional) */
  userPreferenceStore?: IUserPreferenceStore;

  /** Default confidence threshold for high-confidence skip rule (default: 80) */
  defaultConfidenceThreshold?: number;

  /** Minimum success rate for previous-success skip rule (default: 0.8) */
  minSuccessRate?: number;

  /** Minimum crawl count for previous-success skip rule (default: 2) */
  minCrawlCount?: number;
}

/**
 * Prompt Evaluator
 *
 * Implements 5 skip rules in priority order:
 * 1. User override exists → skip (confidence = 100)
 * 2. High confidence (≥80%) → skip
 * 3. Saved preference with auto-decide → skip
 * 4. Previous successful crawls → skip
 * 5. User auto-decide enabled → skip
 */
export class PromptEvaluator implements IPromptEvaluator {
  private readonly userSettingsStore?: IUserDisclosureSettingsStore;
  private readonly patternLearner?: IPatternLearner;
  private readonly userPreferenceStore?: IUserPreferenceStore;
  private readonly defaultConfidenceThreshold: number;
  private readonly minSuccessRate: number;
  private readonly minCrawlCount: number;

  constructor(options: PromptEvaluatorOptions = {}) {
    this.userSettingsStore = options.userSettingsStore;
    this.patternLearner = options.patternLearner;
    this.userPreferenceStore = options.userPreferenceStore;
    this.defaultConfidenceThreshold = options.defaultConfidenceThreshold ?? 80;
    this.minSuccessRate = options.minSuccessRate ?? 0.8;
    this.minCrawlCount = options.minCrawlCount ?? 2;
  }

  /**
   * Evaluate whether to prompt user
   *
   * Applies skip rules in priority order
   */
  async evaluate(decision: CrawlDecision, context: DecisionContext): Promise<PromptEvaluation> {
    try {
      const metadata: PromptEvaluation['metadata'] = {};

      // Skip Rule 1: User Override Exists
      if (decision.source === 'user-override' || context.userOverride) {
        return {
          shouldPrompt: false,
          reason: 'User explicitly selected strategy for this crawl',
          skipRule: 'user-override',
          confidence: 100,
          metadata: {
            hasUserOverride: true,
          },
        };
      }

      // Get user settings for threshold and auto-decide
      let userSettings: UserDisclosureSettings | null = null;
      if (context.userId && this.userSettingsStore) {
        userSettings = await this.userSettingsStore.getSettings(context.userId, context.tenantId);
        metadata.autoDecideEnabled = userSettings?.autoDecide ?? false;
      }

      const confidenceThreshold =
        userSettings?.minConfidenceThreshold ?? this.defaultConfidenceThreshold;

      // Skip Rule 2: High Confidence
      if (decision.confidence >= confidenceThreshold) {
        return {
          shouldPrompt: false,
          reason: `Decision confidence (${decision.confidence}%) exceeds threshold (${confidenceThreshold}%)`,
          skipRule: 'high-confidence',
          confidence: decision.confidence,
          metadata,
        };
      }

      // Skip Rule 3: Saved Preference with Auto-Decide
      if (context.userId && this.userPreferenceStore) {
        const domain = this.extractDomain(context.url);
        const preference = await this.userPreferenceStore.getPreference(
          context.userId,
          context.tenantId,
          domain,
        );

        if (preference && preference.autoDecide) {
          metadata.hasSavedPreference = true;
          return {
            shouldPrompt: false,
            reason: `User has saved preference for ${preference.domainPattern} with auto-decide enabled`,
            skipRule: 'saved-preference',
            confidence: decision.confidence,
            metadata,
          };
        }

        metadata.hasSavedPreference = !!preference;
      }

      // Skip Rule 4: Previous Successful Crawls
      const history = await this.getCrawlHistory(context.tenantId, context.url);
      if (history) {
        metadata.previousCrawlCount = history.totalCrawls;
        metadata.previousSuccessRate = history.successRate;

        if (
          history.totalCrawls >= this.minCrawlCount &&
          history.successRate >= this.minSuccessRate
        ) {
          return {
            shouldPrompt: false,
            reason: `Domain previously crawled successfully (${history.successfulCrawls}/${history.totalCrawls} success, ${(history.successRate * 100).toFixed(0)}% rate)`,
            skipRule: 'previous-success',
            confidence: decision.confidence,
            metadata,
          };
        }
      }

      // Skip Rule 5: User Auto-Decide Enabled
      if (userSettings?.autoDecide) {
        return {
          shouldPrompt: false,
          reason: 'User has enabled "auto-decide" for all crawls',
          skipRule: 'auto-decide',
          confidence: decision.confidence,
          metadata,
        };
      }

      // No skip rule triggered → prompt user
      return {
        shouldPrompt: true,
        reason: `Low confidence (${decision.confidence}%) and no skip rules triggered`,
        confidence: decision.confidence,
        metadata,
      };
    } catch (error) {
      throw new DisclosureError(
        `Failed to evaluate prompt decision: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'EVALUATION_FAILED',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get user disclosure settings
   */
  async getUserSettings(userId: string, tenantId: string): Promise<UserDisclosureSettings | null> {
    if (!this.userSettingsStore) {
      return null;
    }

    try {
      return await this.userSettingsStore.getSettings(userId, tenantId);
    } catch (error) {
      throw new DisclosureError(
        `Failed to get user settings: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'GET_SETTINGS_FAILED',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get crawl history for domain
   */
  async getCrawlHistory(tenantId: string, domain: string): Promise<CrawlHistory | null> {
    if (!this.patternLearner) {
      return null;
    }

    try {
      const normalizedDomain = this.extractDomain(domain);
      const pattern = await this.patternLearner.getPattern(tenantId, normalizedDomain);

      if (!pattern) {
        return null;
      }

      return {
        domain: normalizedDomain,
        totalCrawls: pattern.totalCount,
        successfulCrawls: pattern.successCount,
        successRate: pattern.successRate,
        lastCrawledAt: pattern.lastValidatedAt,
        lastSuccess: pattern.successRate > 0, // Simplified
      };
    } catch (error) {
      throw new DisclosureError(
        `Failed to get crawl history: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'GET_HISTORY_FAILED',
        error instanceof Error ? error : undefined,
      );
    }
  }

  // ========================================
  // Private Helpers
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
