/**
 * User-Facing Crawl Strategy API
 *
 * Provides a simple, intent-based API for users to specify what they want to crawl,
 * without needing to understand technical implementation details.
 *
 * Design Principles:
 * - User Intent: Strategies express WHAT the user wants, not HOW to do it
 * - Progressive Disclosure: Simple default, advanced options when needed
 * - Safety First: Built-in limits to prevent accidental huge crawls
 * - Backward Compatible: Old API continues to work
 */

/**
 * User-facing crawl strategy
 *
 * These are intent-based strategies that map to internal implementation strategies.
 */
export type UserCrawlStrategy =
  | 'single-page' // Crawl only the provided URLs, no discovery
  | 'sitemap' // Use sitemap.xml exclusively (error if not found)
  | 'smart' // Auto-detect best method (sitemap → links → single)
  | 'limited' // Discover N pages using best method
  | 'full-site'; // Crawl entire site (requires explicit safety limits)

/**
 * Internal implementation strategy
 *
 * These are technical strategies used by the crawler engine.
 * Users should not need to know about these.
 */
export type InternalCrawlStrategy = 'browser' | 'bulk' | 'hybrid';

/**
 * Crawl filters for URL and content filtering
 */
export interface CrawlFilters {
  /** URL path glob patterns to include (e.g., ["/docs/*", "/api/*"]) */
  includePaths?: string[];
  /** URL path glob patterns to exclude (e.g., ["/blog/*", "/changelog"]) */
  excludePaths?: string[];
  /** Content keywords — at least one must appear in page content */
  contentKeywords?: string[];
}

/**
 * Strategy configuration from user
 */
export interface StrategyConfig {
  /**
   * User-facing strategy name
   *
   * Defaults to 'smart' if not provided.
   */
  strategy?: UserCrawlStrategy;

  /**
   * Safety limits (required for 'full-site', optional for others)
   */
  limits?: {
    /**
     * Maximum pages to crawl
     *
     * - single-page: ignored (always 1 page per URL)
     * - sitemap: limits sitemap entries processed
     * - smart: default 1000 if not specified
     * - limited: required, no default
     * - full-site: required, no default
     */
    maxPages?: number;

    /**
     * Maximum crawl duration in minutes
     *
     * Defaults: smart=30, limited=60, full-site=required
     */
    maxDurationMinutes?: number;

    /**
     * Maximum depth for link following
     *
     * Only applies to strategies that follow links.
     * Defaults: smart=3, limited=3, full-site=5
     */
    maxDepth?: number;
  };

  /**
   * Fallback strategy if primary strategy fails
   *
   * Example: strategy='sitemap' + fallback='smart' → try sitemap first, use smart discovery if no sitemap
   * Default: no fallback, fail explicitly
   */
  fallbackStrategy?: UserCrawlStrategy;

  /**
   * Legacy: Old API compatibility
   *
   * @deprecated Use 'strategy' and 'limits' instead
   */
  options?: {
    maxPages?: number;
    maxDepth?: number;
    followLinks?: boolean;
    extractMetadata?: boolean;
  };

  /**
   * URL and content filters
   */
  filters?: CrawlFilters;
}

/**
 * Internal crawl parameters resolved from strategy
 */
export interface ResolvedCrawlParams {
  /**
   * Internal implementation strategy
   */
  internalStrategy: InternalCrawlStrategy;

  /**
   * Batch size for bulk processing
   */
  batchSize: number;

  /**
   * Concurrency level
   */
  concurrency: number;

  /**
   * JavaScript handling
   */
  jsHandling: 'none' | 'static' | 'dynamic';

  /**
   * Discovery method
   */
  discovery: {
    /**
     * Use sitemap.xml
     */
    useSitemap: boolean;

    /**
     * Follow links in HTML
     */
    followLinks: boolean;

    /**
     * Maximum pages to discover
     */
    maxPages: number;

    /**
     * Maximum depth for link following
     */
    maxDepth: number;
  };

  /**
   * Safety limits
   */
  limits: {
    /**
     * Maximum pages (hard limit)
     */
    maxPages: number;

    /**
     * Maximum duration in milliseconds
     */
    maxDurationMs: number;

    /**
     * Maximum depth
     */
    maxDepth: number;
  };

  /**
   * User-facing strategy that was requested
   */
  requestedStrategy: UserCrawlStrategy;

  /**
   * Whether fallback was applied
   */
  fallbackApplied: boolean;

  /**
   * Reasoning for the internal strategy choice
   */
  reasoning: string;
}

/**
 * Strategy resolution result
 */
export interface StrategyResolutionResult {
  /**
   * Resolved crawl parameters
   */
  params: ResolvedCrawlParams;

  /**
   * Warnings (e.g., missing sitemap, high page count)
   */
  warnings: string[];

  /**
   * Validation errors (blocking)
   */
  errors: string[];
}

/**
 * Strategy metadata for documentation/UI
 */
export interface StrategyMetadata {
  /**
   * Strategy name
   */
  strategy: UserCrawlStrategy;

  /**
   * User-friendly display name
   */
  displayName: string;

  /**
   * Short description
   */
  description: string;

  /**
   * Use cases
   */
  useCases: string[];

  /**
   * Typical cost tier (1-5, higher = more expensive)
   */
  costTier: number;

  /**
   * Whether safety limits are required
   */
  requiresLimits: boolean;

  /**
   * Default limits
   */
  defaultLimits?: {
    maxPages?: number;
    maxDurationMinutes?: number;
    maxDepth?: number;
  };

  /**
   * Examples
   */
  examples: Array<{
    title: string;
    config: StrategyConfig;
  }>;
}
