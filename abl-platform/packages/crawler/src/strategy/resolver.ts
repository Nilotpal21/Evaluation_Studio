/**
 * Strategy Resolver
 *
 * Maps user-facing strategies to internal crawl parameters.
 * Handles fallback, validation, and safety limits.
 */

import type { SiteProfile } from '../profiler/interfaces.js';
import type {
  UserCrawlStrategy,
  InternalCrawlStrategy,
  StrategyConfig,
  ResolvedCrawlParams,
  StrategyResolutionResult,
  StrategyMetadata,
} from './types.js';

/**
 * Strategy Resolver
 *
 * Converts user-facing strategies into internal crawl parameters.
 */
export class StrategyResolver {
  /**
   * Resolve strategy config into internal crawl parameters
   *
   * @param config - User-provided strategy configuration
   * @param profile - Site profile from profiler
   * @returns Resolution result with params, warnings, and errors
   */
  async resolve(config: StrategyConfig, profile: SiteProfile): Promise<StrategyResolutionResult> {
    const warnings: string[] = [];
    const errors: string[] = [];

    // Determine user strategy (default: smart)
    let userStrategy: UserCrawlStrategy = config.strategy ?? 'smart';

    // Backward compatibility: map old options to strategy
    if (!config.strategy && config.options) {
      userStrategy = this.mapLegacyOptionsToStrategy(config.options);

      // Also map options to limits for the resolver logic
      if (!config.limits) {
        config.limits = {
          maxPages: config.options.maxPages,
          maxDepth: config.options.maxDepth,
        };

        // For full-site strategy, provide default maxDurationMinutes if not specified
        if (userStrategy === 'full-site' && !config.limits.maxDurationMinutes) {
          config.limits.maxDurationMinutes = 120; // 2 hours default for large crawls
        }
      }

      warnings.push(
        `Legacy API detected. Mapped options to strategy='${userStrategy}'. Consider migrating to the new strategy API.`,
      );
    }

    // Validate strategy-specific requirements
    const validationResult = this.validateStrategy(userStrategy, config, profile);
    errors.push(...validationResult.errors);
    warnings.push(...validationResult.warnings);

    // If validation failed, return errors
    if (errors.length > 0) {
      return {
        params: this.getDefaultParams(),
        warnings,
        errors,
      };
    }

    // Check if fallback is needed (e.g., sitemap strategy but no sitemap)
    let appliedStrategy = userStrategy;
    let fallbackApplied = false;

    if (userStrategy === 'sitemap' && !profile.metadata.hasSitemap) {
      if (config.fallbackStrategy) {
        warnings.push(
          `No sitemap found at ${profile.domain}. Falling back to strategy='${config.fallbackStrategy}'.`,
        );
        appliedStrategy = config.fallbackStrategy;
        fallbackApplied = true;
      } else {
        errors.push(
          `Strategy 'sitemap' requires sitemap.xml, but none found at ${profile.domain}. Consider using fallbackStrategy='smart'.`,
        );
        return {
          params: this.getDefaultParams(),
          warnings,
          errors,
        };
      }
    }

    // Resolve internal parameters based on strategy and profile
    const params = this.resolveParams(appliedStrategy, config, profile, fallbackApplied);

    return {
      params,
      warnings,
      errors: [],
    };
  }

  /**
   * Map legacy options to user-facing strategy
   */
  private mapLegacyOptionsToStrategy(options: {
    maxPages?: number;
    maxDepth?: number;
    followLinks?: boolean;
  }): UserCrawlStrategy {
    const { maxPages, followLinks } = options;

    // Single page: maxPages=1 OR followLinks explicitly set to false
    if (maxPages === 1) {
      return 'single-page';
    }

    if (followLinks === false) {
      return 'single-page';
    }

    // Limited: explicit maxPages but not large (2-100)
    if (maxPages && maxPages > 1 && maxPages <= 100) {
      return 'limited';
    }

    // Full-site: very large maxPages (>100)
    if (maxPages && maxPages > 100) {
      return 'full-site';
    }

    // Default: smart (no explicit limits, or followLinks=true without maxPages)
    return 'smart';
  }

  /**
   * Validate strategy configuration
   */
  private validateStrategy(
    strategy: UserCrawlStrategy,
    config: StrategyConfig,
    profile: SiteProfile,
  ): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    switch (strategy) {
      case 'single-page':
        // No validation needed
        break;

      case 'sitemap':
        if (!profile.metadata.hasSitemap && !config.fallbackStrategy) {
          errors.push(
            `Strategy 'sitemap' requires sitemap.xml at ${profile.domain}, but none found. Add fallbackStrategy or use 'smart'.`,
          );
        }
        break;

      case 'smart':
        // Check for reasonable defaults
        if (config.limits?.maxPages && config.limits.maxPages > 10000) {
          warnings.push(
            `maxPages=${config.limits.maxPages} is very high. Consider using 'limited' strategy with smaller limit for testing first.`,
          );
        }
        break;

      case 'limited':
        // Require explicit maxPages
        if (!config.limits?.maxPages) {
          errors.push(
            `Strategy 'limited' requires limits.maxPages. Example: { strategy: 'limited', limits: { maxPages: 50 } }`,
          );
        }
        break;

      case 'full-site':
        // Require explicit safety limits
        if (!config.limits?.maxPages) {
          errors.push(
            `Strategy 'full-site' requires limits.maxPages for safety. Example: { strategy: 'full-site', limits: { maxPages: 1000, maxDurationMinutes: 60 } }`,
          );
        }
        if (!config.limits?.maxDurationMinutes) {
          errors.push(`Strategy 'full-site' requires limits.maxDurationMinutes for safety.`);
        }
        if (config.limits?.maxPages && config.limits.maxPages > 50000) {
          warnings.push(
            `maxPages=${config.limits.maxPages} is extremely high and may incur significant costs.`,
          );
        }
        break;

      default:
        errors.push(`Unknown strategy: ${strategy}`);
    }

    return { errors, warnings };
  }

  /**
   * Resolve internal crawl parameters from strategy
   */
  private resolveParams(
    strategy: UserCrawlStrategy,
    config: StrategyConfig,
    profile: SiteProfile,
    fallbackApplied: boolean,
  ): ResolvedCrawlParams {
    // Determine internal strategy based on site profile
    const internalStrategy = this.selectInternalStrategy(strategy, profile);

    // Base parameters
    const params: ResolvedCrawlParams = {
      internalStrategy,
      batchSize: this.getBatchSize(internalStrategy),
      concurrency: this.getConcurrency(internalStrategy, profile),
      jsHandling: this.getJsHandling(internalStrategy, profile),
      discovery: {
        useSitemap: false,
        followLinks: false,
        maxPages: 1,
        maxDepth: 0,
      },
      limits: {
        maxPages: 1,
        maxDurationMs: 30 * 60 * 1000, // 30 minutes default
        maxDepth: 0,
      },
      requestedStrategy: strategy,
      fallbackApplied,
      reasoning: '',
    };

    // Configure discovery and limits based on strategy
    switch (strategy) {
      case 'single-page':
        params.discovery = {
          useSitemap: false,
          followLinks: false,
          maxPages: 1,
          maxDepth: 0,
        };
        params.limits = {
          maxPages: 1,
          maxDurationMs: 10 * 60 * 1000, // 10 minutes
          maxDepth: 0,
        };
        params.reasoning = 'Single-page mode: crawl only provided URLs, no discovery.';
        break;

      case 'sitemap':
        params.discovery = {
          useSitemap: true,
          followLinks: false,
          maxPages: config.limits?.maxPages ?? 1000,
          maxDepth: 0,
        };
        params.limits = {
          maxPages: config.limits?.maxPages ?? 1000,
          maxDurationMs: (config.limits?.maxDurationMinutes ?? 30) * 60 * 1000,
          maxDepth: 0,
        };
        params.reasoning = profile.metadata.hasSitemap
          ? `Sitemap mode: using sitemap.xml from ${profile.domain}.`
          : `Sitemap fallback: sitemap not found, using ${internalStrategy} strategy.`;
        break;

      case 'smart':
        // Smart: try sitemap first, then links
        if (profile.metadata.hasSitemap) {
          params.discovery = {
            useSitemap: true,
            followLinks: true, // Fallback to links if sitemap incomplete
            maxPages: config.limits?.maxPages ?? 1000,
            maxDepth: config.limits?.maxDepth ?? 3,
          };
          params.reasoning = `Smart mode: sitemap detected, will use it with link fallback.`;
        } else {
          params.discovery = {
            useSitemap: false,
            followLinks: true,
            maxPages: config.limits?.maxPages ?? 1000,
            maxDepth: config.limits?.maxDepth ?? 3,
          };
          params.reasoning = `Smart mode: no sitemap, using link discovery up to depth ${params.discovery.maxDepth}.`;
        }
        params.limits = {
          maxPages: config.limits?.maxPages ?? 1000,
          maxDurationMs: (config.limits?.maxDurationMinutes ?? 30) * 60 * 1000,
          maxDepth: config.limits?.maxDepth ?? 3,
        };
        break;

      case 'limited':
        params.discovery = {
          useSitemap: profile.metadata.hasSitemap ?? false,
          followLinks: true,
          maxPages: config.limits!.maxPages!, // Required by validation
          maxDepth: config.limits?.maxDepth ?? 3,
        };
        params.limits = {
          maxPages: config.limits!.maxPages!,
          maxDurationMs: (config.limits?.maxDurationMinutes ?? 60) * 60 * 1000,
          maxDepth: config.limits?.maxDepth ?? 3,
        };
        params.reasoning = `Limited mode: discover up to ${params.limits.maxPages} pages using best method (sitemap=${params.discovery.useSitemap}).`;
        break;

      case 'full-site':
        params.discovery = {
          useSitemap: profile.metadata.hasSitemap ?? false,
          followLinks: true,
          maxPages: config.limits!.maxPages!, // Required by validation
          maxDepth: config.limits?.maxDepth ?? 5,
        };
        params.limits = {
          maxPages: config.limits!.maxPages!,
          maxDurationMs: config.limits!.maxDurationMinutes! * 60 * 1000, // Required
          maxDepth: config.limits?.maxDepth ?? 5,
        };
        params.reasoning = `Full-site mode: exhaustive crawl up to ${params.limits.maxPages} pages (safety limit).`;
        break;
    }

    return params;
  }

  /**
   * Select internal strategy based on site profile
   */
  private selectInternalStrategy(
    userStrategy: UserCrawlStrategy,
    profile: SiteProfile,
  ): InternalCrawlStrategy {
    // Single-page: always use bulk (simple HTTP fetch)
    if (userStrategy === 'single-page') {
      return 'bulk';
    }

    // Hybrid SSR sites: use hybrid strategy regardless of jsRequired.
    // Hybrid means content is server-rendered (visible to HTTP) but JS
    // enhances it — the 'hybrid' internal strategy fetches via HTTP and
    // selectively renders JS, which is more efficient than full browser.
    if (profile.siteType === 'hybrid') {
      return 'hybrid';
    }

    // Pure SPA or JS-required sites: need full browser rendering
    if (profile.jsRequired || profile.siteType === 'spa') {
      return 'browser';
    }

    // Default: bulk for static sites
    return 'bulk';
  }

  /**
   * Get batch size for internal strategy
   */
  private getBatchSize(strategy: InternalCrawlStrategy): number {
    switch (strategy) {
      case 'browser':
        return 1; // Browser is slow, process one at a time
      case 'bulk':
        return 50; // Bulk HTTP is fast, batch large
      case 'hybrid':
        return 10; // Hybrid is medium speed
    }
  }

  /**
   * Get concurrency level based on strategy and profile
   */
  private getConcurrency(strategy: InternalCrawlStrategy, profile: SiteProfile): number {
    // Respect rate limits
    if (profile.rateLimitDetected) {
      return Math.min(profile.maxConcurrency, 2);
    }

    switch (strategy) {
      case 'browser':
        return 1; // Browser is resource-heavy, low concurrency
      case 'bulk':
        return Math.min(profile.maxConcurrency, 10); // Bulk can be parallel
      case 'hybrid':
        return Math.min(profile.maxConcurrency, 5); // Hybrid is medium
    }
  }

  /**
   * Get JavaScript handling strategy
   */
  private getJsHandling(
    strategy: InternalCrawlStrategy,
    profile: SiteProfile,
  ): 'none' | 'static' | 'dynamic' {
    if (!profile.jsRequired) {
      return 'none';
    }

    if (strategy === 'browser') {
      return 'dynamic'; // Execute JS
    }

    if (profile.siteType === 'hybrid') {
      return 'static'; // Server-rendered, no JS execution needed
    }

    return 'none';
  }

  /**
   * Get default parameters (fallback)
   */
  private getDefaultParams(): ResolvedCrawlParams {
    return {
      internalStrategy: 'bulk',
      batchSize: 50,
      concurrency: 10,
      jsHandling: 'none',
      discovery: {
        useSitemap: false,
        followLinks: false,
        maxPages: 1,
        maxDepth: 0,
      },
      limits: {
        maxPages: 1,
        maxDurationMs: 10 * 60 * 1000,
        maxDepth: 0,
      },
      requestedStrategy: 'single-page',
      fallbackApplied: false,
      reasoning: 'Default parameters due to validation error.',
    };
  }

  /**
   * Get strategy metadata for documentation/UI
   */
  static getStrategyMetadata(): StrategyMetadata[] {
    return [
      {
        strategy: 'single-page',
        displayName: 'Single Page',
        description: 'Crawl only the provided URLs. No discovery, no following links.',
        useCases: [
          'Test a specific page',
          'Extract content from a single article',
          'Quick validation',
        ],
        costTier: 1,
        requiresLimits: false,
        defaultLimits: {
          maxPages: 1,
          maxDurationMinutes: 10,
        },
        examples: [
          {
            title: 'Extract single article',
            config: {
              strategy: 'single-page',
            },
          },
        ],
      },
      {
        strategy: 'sitemap',
        displayName: 'Sitemap',
        description:
          'Use sitemap.xml exclusively. Fails if sitemap not found (unless fallback set).',
        useCases: [
          'Documentation sites with sitemap',
          'Blogs with complete sitemap',
          'Known structured sites',
        ],
        costTier: 2,
        requiresLimits: false,
        defaultLimits: {
          maxPages: 1000,
          maxDurationMinutes: 30,
        },
        examples: [
          {
            title: 'Crawl docs site via sitemap',
            config: {
              strategy: 'sitemap',
              limits: {
                maxPages: 500,
              },
            },
          },
          {
            title: 'Sitemap with smart fallback',
            config: {
              strategy: 'sitemap',
              fallbackStrategy: 'smart',
            },
          },
        ],
      },
      {
        strategy: 'smart',
        displayName: 'Smart (Recommended)',
        description: 'Auto-detect best method. Try sitemap first, fall back to link discovery.',
        useCases: [
          'Default choice - "just crawl this site"',
          'Unknown site structure',
          'Most documentation and content sites',
        ],
        costTier: 3,
        requiresLimits: false,
        defaultLimits: {
          maxPages: 1000,
          maxDurationMinutes: 30,
          maxDepth: 3,
        },
        examples: [
          {
            title: 'Default smart crawl',
            config: {
              strategy: 'smart',
            },
          },
          {
            title: 'Smart with custom limits',
            config: {
              strategy: 'smart',
              limits: {
                maxPages: 200,
                maxDepth: 2,
              },
            },
          },
        ],
      },
      {
        strategy: 'limited',
        displayName: 'Limited Discovery',
        description: 'Discover up to N pages using best method (sitemap or links).',
        useCases: ['Sample crawl to test', 'Budget-limited crawls', 'Incremental crawling'],
        costTier: 3,
        requiresLimits: true,
        examples: [
          {
            title: 'Discover 50 pages',
            config: {
              strategy: 'limited',
              limits: {
                maxPages: 50,
              },
            },
          },
        ],
      },
      {
        strategy: 'full-site',
        displayName: 'Full Site',
        description: 'Crawl entire site exhaustively. Requires explicit safety limits.',
        useCases: [
          'Complete site archival',
          'Comprehensive documentation indexing',
          'Full knowledge base ingestion',
        ],
        costTier: 5,
        requiresLimits: true,
        examples: [
          {
            title: 'Full site crawl',
            config: {
              strategy: 'full-site',
              limits: {
                maxPages: 5000,
                maxDurationMinutes: 120,
                maxDepth: 10,
              },
            },
          },
        ],
      },
    ];
  }
}
