/**
 * Progressive Disclosure Interfaces
 *
 * Defines abstractions for the progressive disclosure system.
 * Prompts users only when necessary (low confidence or new domain).
 *
 * Design Principles:
 * - Progressive Disclosure: Show complexity only when needed
 * - User Respect: Minimize interruptions
 * - Learning: Fewer prompts over time
 *
 * Skip Rules (5 reasons to skip prompting):
 * 1. High confidence (≥80%)
 * 2. User override exists
 * 3. Auto-decide enabled
 * 4. Previous success
 * 5. Saved preference
 */

import type { CrawlDecision, DecisionContext } from '../decision/interfaces.js';

/**
 * Evaluation result for prompt decision
 */
export interface PromptEvaluation {
  /** Whether to prompt the user */
  shouldPrompt: boolean;

  /** Reason for decision */
  reason: string;

  /** Which skip rule triggered (if shouldPrompt is false) */
  skipRule?:
    | 'high-confidence'
    | 'user-override'
    | 'auto-decide'
    | 'previous-success'
    | 'saved-preference';

  /** Confidence score (0-100) that influenced decision */
  confidence: number;

  /** Additional context for logging/debugging */
  metadata?: {
    hasUserOverride?: boolean;
    hasSavedPreference?: boolean;
    previousCrawlCount?: number;
    previousSuccessRate?: number;
    autoDecideEnabled?: boolean;
    [key: string]: any;
  };
}

/**
 * User settings for progressive disclosure
 */
export interface UserDisclosureSettings {
  /** User ID */
  userId: string;

  /** Tenant ID */
  tenantId: string;

  /** Auto-decide without prompting (default: false) */
  autoDecide: boolean;

  /** Minimum confidence to skip prompting (default: 80) */
  minConfidenceThreshold: number;

  /** Created timestamp */
  createdAt: Date;

  /** Updated timestamp */
  updatedAt: Date;
}

/**
 * Previous crawl outcome summary (for skip rule evaluation)
 */
export interface CrawlHistory {
  /** Domain */
  domain: string;

  /** Total crawls attempted */
  totalCrawls: number;

  /** Successful crawls */
  successfulCrawls: number;

  /** Success rate (0-1) */
  successRate: number;

  /** Most recent crawl timestamp */
  lastCrawledAt: Date;

  /** Most recent crawl success */
  lastSuccess: boolean;
}

/**
 * Prompt Evaluator Interface
 *
 * Evaluates whether to prompt user based on decision confidence,
 * user settings, and crawl history.
 */
export interface IPromptEvaluator {
  /**
   * Evaluate whether to prompt user
   *
   * Applies 5 skip rules in order:
   * 1. User override exists → skip
   * 2. High confidence (≥threshold) → skip
   * 3. Saved preference exists with auto-decide → skip
   * 4. Previous successful crawls → skip
   * 5. User auto-decide enabled → skip
   *
   * Otherwise → prompt
   */
  evaluate(decision: CrawlDecision, context: DecisionContext): Promise<PromptEvaluation>;

  /**
   * Get user disclosure settings
   */
  getUserSettings(userId: string, tenantId: string): Promise<UserDisclosureSettings | null>;

  /**
   * Get crawl history for domain
   */
  getCrawlHistory(tenantId: string, domain: string): Promise<CrawlHistory | null>;
}

/**
 * User Disclosure Settings Store Interface
 */
export interface IUserDisclosureSettingsStore {
  /**
   * Get settings for user
   */
  getSettings(userId: string, tenantId: string): Promise<UserDisclosureSettings | null>;

  /**
   * Save settings for user
   */
  saveSettings(
    settings: Omit<UserDisclosureSettings, 'createdAt' | 'updatedAt'>,
  ): Promise<UserDisclosureSettings>;

  /**
   * Update settings
   */
  updateSettings(
    userId: string,
    tenantId: string,
    updates: Partial<UserDisclosureSettings>,
  ): Promise<UserDisclosureSettings>;

  /**
   * Delete settings
   */
  deleteSettings(userId: string, tenantId: string): Promise<boolean>;
}

/**
 * Disclosure Error
 */
export class DisclosureError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'DisclosureError';
  }
}
