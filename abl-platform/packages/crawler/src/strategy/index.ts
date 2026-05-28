/**
 * Crawl Strategy API
 *
 * User-facing strategy system for simplified crawl configuration.
 * Replaces confusing technical parameters (maxPages, maxDepth) with
 * intent-based strategies (single-page, sitemap, smart, limited, full-site).
 */

export {
  type UserCrawlStrategy,
  type InternalCrawlStrategy,
  type StrategyConfig,
  type CrawlFilters,
  type ResolvedCrawlParams,
  type StrategyResolutionResult,
  type StrategyMetadata,
} from './types.js';

export { StrategyResolver } from './resolver.js';
