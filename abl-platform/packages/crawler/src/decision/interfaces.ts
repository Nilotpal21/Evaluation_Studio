/**
 * Decision Engine Interfaces
 *
 * Defines abstractions for the autonomous decision-making system.
 * Decides crawl strategy based on site profile, learned patterns,
 * user preferences, and tenant policies.
 *
 * Design Principles:
 * - Interface Segregation: Focused interfaces for each concern
 * - Dependency Inversion: Depend on abstractions, not implementations
 * - Single Responsibility: Each interface has one clear purpose
 *
 * Decision Hierarchy (highest to lowest precedence):
 * 1. User Override (explicit choice for this crawl)
 * 2. User Preference (saved preference for domain)
 * 3. Tenant Policy (organization-level rules)
 * 4. Learned Pattern (historical success data)
 * 5. Default (profile-based heuristics)
 */

import type { SiteProfile } from '../profiler/interfaces.js';

/**
 * Crawl strategy type
 */
export type CrawlStrategy = 'browser' | 'bulk' | 'hybrid';

/**
 * Crawl Decision - Output of decision engine
 */
export interface CrawlDecision {
  /** Recommended crawl strategy */
  strategy: CrawlStrategy;

  /** Recommended batch size for bulk crawl */
  batchSize: number;

  /** Recommended concurrency level */
  concurrency: number;

  /** JavaScript handling strategy */
  jsHandling: 'none' | 'static' | 'dynamic';

  /** Wait time for JS to execute (ms) */
  waitForJs?: number;

  /** Confidence in this decision (0-100) */
  confidence: number;

  /** Human-readable explanation of decision */
  reasoning: string;

  /** Source of this decision (for debugging/transparency) */
  source:
    | 'user-override'
    | 'user-preference'
    | 'tenant-policy'
    | 'learned-pattern'
    | 'profile-heuristic'
    | 'default';

  /** Alternative strategies with their expected outcomes */
  alternatives?: Alternative[];

  /** Metadata for decision tracking */
  metadata?: {
    profileConfidence?: number;
    patternSuccessRate?: number;
    estimatedDuration?: number;
    estimatedCost?: number;
    [key: string]: any;
  };
}

/**
 * Alternative strategy option
 */
export interface Alternative {
  /** Alternative strategy */
  strategy: CrawlStrategy;

  /** Alternative batch size */
  batchSize: number;

  /** Alternative concurrency */
  concurrency: number;

  /** Why this alternative might be better */
  reasoning: string;

  /** Expected outcomes */
  expectedOutcome: {
    estimatedDuration: number; // milliseconds
    estimatedThroughput: number; // pages/second
    reliability: number; // 0-100%
  };
}

/**
 * Decision Context - Input to decision engine
 */
export interface DecisionContext {
  /** URL or domain being crawled */
  url: string;

  /** Tenant ID for multi-tenancy */
  tenantId: string;

  /** User ID (optional, for user preferences) */
  userId?: string;

  /** Site profile from profiler */
  profile: SiteProfile;

  /** User override (highest precedence) */
  userOverride?: Partial<CrawlDecision>;

  /** Estimated number of URLs to crawl */
  estimatedUrlCount?: number;

  /** User's auto-decide preference */
  autoDecide?: boolean;

  /** Previous crawl history for this domain (if any) */
  previousCrawl?: {
    strategy: CrawlStrategy;
    success: boolean;
    duration: number;
    throughput: number;
  };
}

/**
 * User Preference - Saved user choice for domain
 */
export interface UserPreference {
  /** Unique ID */
  id: string;

  /** User ID */
  userId: string;

  /** Tenant ID */
  tenantId: string;

  /** Domain pattern (exact or wildcard) */
  domainPattern: string;

  /** Preferred strategy */
  strategy: CrawlStrategy;

  /** Preferred batch size */
  batchSize?: number;

  /** Preferred concurrency */
  concurrency?: number;

  /** Auto-decide without prompting */
  autoDecide: boolean;

  /** Usage tracking */
  useCount: number;
  lastUsed: Date;

  /** Timestamps */
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Tenant Policy - Organization-level rules
 */
export interface TenantPolicy {
  /** Unique ID */
  id: string;

  /** Tenant ID */
  tenantId: string;

  /** Domain pattern (exact or wildcard) */
  domainPattern: string;

  /** Allowed strategies */
  allowedStrategies: CrawlStrategy[];

  /** Resource limits */
  limits: {
    maxBatchSize: number;
    maxConcurrency: number;
    maxMemoryMB: number;
    maxDurationMinutes: number;
  };

  /** Compliance flags */
  compliance?: {
    respectRobotsTxt: boolean;
    maxRequestsPerSecond: number;
    userAgent: string;
  };

  /** Admin who created this policy */
  createdBy: string;

  /** Timestamps */
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Learned Pattern - Historical success data
 */
export interface LearnedPattern {
  /** Unique ID */
  id: string;

  /** Tenant ID */
  tenantId: string;

  /** Domain (normalized) */
  domain: string;

  /** Site type from profile */
  siteType: 'static' | 'spa' | 'hybrid' | 'unknown';

  /** Optimal strategy discovered */
  optimalStrategy: CrawlStrategy;

  /** Optimal batch size discovered */
  optimalBatchSize: number;

  /** Optimal concurrency discovered */
  optimalConcurrency: number;

  /** Confidence in this pattern (0-100) */
  confidence: number;

  /** Number of successful crawls with this pattern */
  successCount: number;

  /** Total number of crawls attempted */
  totalCount: number;

  /** Success rate (successCount / totalCount) */
  successRate: number;

  /** Performance metrics */
  metrics: {
    avgDuration: number; // milliseconds
    avgThroughput: number; // pages/second
    avgMemoryMB: number;
  };

  /** When pattern was learned */
  firstSeenAt: Date;

  /** When pattern was last validated */
  lastValidatedAt: Date;

  /** Timestamps */
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Outcome - Result of a crawl for learning
 */
export interface CrawlOutcome {
  /** Tenant ID */
  tenantId: string;

  /** Domain crawled */
  domain: string;

  /** Strategy used */
  strategy: CrawlStrategy;

  /** Batch size used */
  batchSize: number;

  /** Concurrency used */
  concurrency: number;

  /** Whether crawl succeeded */
  success: boolean;

  /** Number of URLs crawled */
  urlsCrawled: number;

  /** Duration in milliseconds */
  duration: number;

  /** Throughput (pages/second) */
  throughput: number;

  /** Memory used (MB) */
  memoryUsedMB?: number;

  /** Error message if failed */
  error?: string;

  /** Timestamp */
  completedAt: Date;
}

/**
 * IDecisionEngine - Core decision-making interface
 */
export interface IDecisionEngine {
  /**
   * Make a crawl decision based on context
   * Implements hierarchy: user override → user pref → tenant policy → learned → default
   */
  decide(context: DecisionContext): Promise<CrawlDecision>;

  /**
   * Record a crawl outcome for learning
   * Updates learned patterns based on success/failure
   */
  recordOutcome(outcome: CrawlOutcome): Promise<void>;

  /**
   * Get decision explanation (for transparency)
   * Returns detailed reasoning for a given decision
   */
  explain(decision: CrawlDecision): string;
}

/**
 * IUserPreferenceStore - Storage for user preferences
 */
export interface IUserPreferenceStore {
  /**
   * Get user preference for a domain
   * Supports exact match and wildcard patterns
   */
  getPreference(userId: string, tenantId: string, domain: string): Promise<UserPreference | null>;

  /**
   * Save user preference
   */
  savePreference(
    preference: Omit<UserPreference, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<UserPreference>;

  /**
   * Delete user preference
   */
  deletePreference(id: string): Promise<boolean>;

  /**
   * List all preferences for a user
   */
  listPreferences(userId: string, tenantId: string): Promise<UserPreference[]>;

  /**
   * Update usage stats (useCount, lastUsed)
   */
  trackUsage(id: string): Promise<void>;
}

/**
 * ITenantPolicyStore - Storage for tenant policies
 */
export interface ITenantPolicyStore {
  /**
   * Get tenant policy for a domain
   * Supports exact match and wildcard patterns
   */
  getPolicy(tenantId: string, domain: string): Promise<TenantPolicy | null>;

  /**
   * Create tenant policy
   */
  createPolicy(policy: Omit<TenantPolicy, 'id' | 'createdAt' | 'updatedAt'>): Promise<TenantPolicy>;

  /**
   * Update tenant policy
   */
  updatePolicy(id: string, updates: Partial<TenantPolicy>): Promise<TenantPolicy>;

  /**
   * Delete tenant policy
   */
  deletePolicy(id: string): Promise<boolean>;

  /**
   * List all policies for a tenant
   */
  listPolicies(tenantId: string): Promise<TenantPolicy[]>;
}

/**
 * IPatternLearner - Learning system for patterns
 */
export interface IPatternLearner {
  /**
   * Learn from a crawl outcome
   * Updates or creates learned pattern
   */
  learn(outcome: CrawlOutcome, profile: SiteProfile): Promise<LearnedPattern>;

  /**
   * Get learned pattern for a domain
   */
  getPattern(tenantId: string, domain: string): Promise<LearnedPattern | null>;

  /**
   * List all learned patterns for a tenant
   */
  listPatterns(
    tenantId: string,
    filters?: {
      minConfidence?: number;
      minSuccessRate?: number;
      siteType?: string;
    },
  ): Promise<LearnedPattern[]>;

  /**
   * Decay old patterns (reduce confidence over time)
   * Should be run periodically
   */
  decayPatterns(tenantId: string, maxAge: number): Promise<number>;
}

/**
 * Decision Engine Error
 */
export class DecisionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'DecisionError';
  }
}
