/**
 * Core abstractions for site profiling
 *
 * Enables multiple profiler implementations (fast, thorough, cached)
 * following the Dependency Inversion principle
 */

/**
 * Core abstraction for site profiling
 *
 * @interface ISiteProfiler
 * @description Enables multiple profiler implementations to be used interchangeably
 */
export interface ISiteProfiler {
  /**
   * Profile a URL and return site characteristics
   *
   * @param url - Target URL to profile
   * @param options - Optional profiling configuration
   * @returns Promise resolving to site profile
   * @throws ProfilerTimeoutError if profiling exceeds timeout
   * @throws ProfilerError if profiling fails
   */
  profile(url: string, options?: ProfileOptions): Promise<SiteProfile>;

  /**
   * Get profiler name for logging/metrics
   *
   * @returns Profiler name (e.g., "fast-profiler", "cached-profiler")
   */
  getName(): string;

  /**
   * Get profiler capabilities (e.g., can detect JS frameworks)
   *
   * @returns Profiler capabilities descriptor
   */
  getCapabilities(): ProfilerCapabilities;
}

/**
 * Configuration options for profiling
 */
export interface ProfileOptions {
  /**
   * Maximum time in milliseconds (default: 60000)
   */
  timeout?: number;

  /**
   * Check cache first (default: true)
   */
  useCache?: boolean;

  /**
   * Profiling thoroughness level
   * - 'quick': HTTP only, <5 seconds
   * - 'normal': HTTP + basic analysis, <30 seconds
   * - 'deep': Browser-based analysis, <60 seconds
   */
  thoroughness?: 'quick' | 'normal' | 'deep';

  /**
   * Run framework detection (default: true)
   */
  detectFramework?: boolean;

  /**
   * Test rate limits (default: false, adds time)
   */
  testRateLimits?: boolean;
}

/**
 * Site profile result
 */
export interface SiteProfile {
  /**
   * Domain name (e.g., "example.com")
   */
  domain: string;

  /**
   * When this profile was created
   */
  profiledAt: Date;

  /**
   * Site type classification
   * - 'static': Traditional HTML site with minimal JavaScript
   * - 'spa': Single-Page Application (React, Vue, Angular, etc.)
   * - 'hybrid': Server-Side Rendered SPA (Next.js, Nuxt, etc.)
   * - 'unknown': Unable to determine with confidence
   */
  siteType: 'static' | 'spa' | 'hybrid' | 'unknown';

  /**
   * JavaScript framework detected (if any)
   * Examples: 'react', 'vue', 'angular', 'next', 'nuxt', 'none'
   */
  framework?: string;

  /**
   * Whether JavaScript rendering is required for content
   */
  jsRequired: boolean;

  /**
   * Average number of links per page
   */
  linkDensity: number;

  /**
   * Estimated total number of pages on site
   */
  estimatedSize: number;

  /**
   * Average response time in milliseconds
   */
  avgResponseTime: number;

  /**
   * Whether rate limiting was detected
   */
  rateLimitDetected: boolean;

  /**
   * Maximum safe concurrent requests
   */
  maxConcurrency: number;

  /**
   * Confidence in this profile (0-100)
   * Higher confidence means more reliable profile
   */
  confidence: number;

  /**
   * Additional metadata
   */
  metadata: {
    /**
     * Whether robots.txt file exists
     */
    hasRobotsTxt?: boolean;

    /**
     * Whether sitemap.xml file exists
     */
    hasSitemap?: boolean;

    /**
     * HTML page size in bytes
     */
    htmlSize?: number;

    /**
     * Number of script tags found
     */
    scriptTagCount?: number;

    /**
     * Server header value
     */
    serverHeader?: string;

    /**
     * CDN provider detected
     */
    cdnProvider?: string;

    /**
     * Full platform detection result from PlatformDetector
     */
    platformResult?: import('../intelligence/algorithms/platform-detector.js').PlatformResult;

    /**
     * Platform category (e.g. 'ecommerce', 'cms', 'framework')
     */
    platformCategory?: string;

    /**
     * Known API endpoints discovered by PlatformDetector
     */
    apiEndpoints?: string[];

    /**
     * Sitemap discovery result with provenance and discovery trail
     */
    sitemapDiscovery?: SitemapDiscoveryResult;

    /**
     * Any additional custom metadata
     */
    [key: string]: any;
  };
}

/**
 * Profiler capabilities descriptor
 */
export interface ProfilerCapabilities {
  /**
   * Can detect JavaScript frameworks
   */
  canDetectFrameworks: boolean;

  /**
   * Can test for rate limits
   */
  canTestRateLimits: boolean;

  /**
   * Can estimate site size
   */
  canEstimateSize: boolean;

  /**
   * Requires browser (Playwright/Puppeteer)
   */
  requiresBrowser: boolean;

  /**
   * Average profiling duration in milliseconds
   */
  avgDurationMs: number;
}

/**
 * Custom error for profiler timeout
 */
export class ProfilerTimeoutError extends Error {
  constructor(
    public url: string,
    public timeoutMs: number,
  ) {
    super(`Profiler timed out after ${timeoutMs}ms for ${url}`);
    this.name = 'ProfilerTimeoutError';
  }
}

/**
 * General profiler error
 */
export class ProfilerError extends Error {
  constructor(
    message: string,
    public cause?: Error,
  ) {
    super(message);
    this.name = 'ProfilerError';
  }
}

// ─── Sitemap Discovery Types ─────────────────────────────────────────

/**
 * A single step in the sitemap discovery process.
 * Used to show users what the profiler checked and what it found.
 */
export interface SitemapDiscoveryStep {
  /** How we found this sitemap URL */
  source: 'default' | 'robots.txt' | 'user-provided';
  /** The sitemap URL checked */
  url: string;
  /** What happened when we checked */
  status: 'found' | 'not_found' | 'error';
  /** Number of URLs found in this sitemap (leaf sitemaps only) */
  urlCount?: number;
  /** Whether this was a sitemap index or a regular sitemap */
  type?: 'sitemap' | 'index';
}

/**
 * A resolved sitemap file with its URLs and provenance.
 * Tracks which sitemap file each URL came from.
 */
export interface SitemapFile {
  /** The sitemap file URL */
  url: string;
  /** How this sitemap was discovered */
  origin: 'default' | 'robots.txt' | 'index' | 'user-provided';
  /** Parent sitemap index URL (if resolved from an index) */
  parentUrl?: string;
  /** URLs found in this sitemap file */
  urls: Array<{ loc: string; priority?: number; lastmod?: string }>;
}

/**
 * Complete result of sitemap discovery.
 * Preserves per-file provenance and provides a flat URL list for backward compat.
 */
export interface SitemapDiscoveryResult {
  /** What we checked and what we found (for the profiling trail UI) */
  steps: SitemapDiscoveryStep[];
  /** Resolved sitemap files with their URLs */
  sitemapFiles: SitemapFile[];
  /** Total URL count across all files (after dedup) */
  totalUrls: number;
  /** Flat deduplicated URL list, sorted by priority desc / lastmod desc */
  allUrls: string[];
}
