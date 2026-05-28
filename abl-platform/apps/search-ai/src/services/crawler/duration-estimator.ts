/**
 * Crawl Duration Estimator
 *
 * Estimates how long a crawl will take based on strategy, site size,
 * and historical performance metrics.
 */

export type CrawlStrategy = 'browser' | 'bulk' | 'hybrid';

export interface DurationEstimate {
  min: number;
  max: number;
  unit: 'seconds' | 'minutes';
  formatted: string; // e.g., "2-3 minutes" or "30-45 seconds"
}

/**
 * Rate estimates (pages per second) for each strategy
 * These are conservative estimates based on typical performance
 */
const STRATEGY_RATES: Record<CrawlStrategy, number> = {
  browser: 2, // Slower due to browser overhead and JS execution
  bulk: 10, // Fast HTTP requests with connection pooling
  hybrid: 5, // Mix of both approaches
};

/**
 * Overhead per crawl job (startup, queue processing, etc.)
 */
const BASE_OVERHEAD_SECONDS = 5;

/**
 * Estimate crawl duration based on strategy and estimated page count
 */
export function estimateCrawlDuration(
  strategy: CrawlStrategy,
  estimatedPages: number,
  options?: {
    avgResponseTime?: number; // milliseconds
    hasJavaScript?: boolean;
    hasSitemap?: boolean;
  },
): DurationEstimate {
  // Get base rate for strategy
  let rate = STRATEGY_RATES[strategy];

  // Adjust rate based on site characteristics
  if (options?.avgResponseTime) {
    // Slower sites reduce crawl rate
    if (options.avgResponseTime > 2000) {
      rate *= 0.5; // 50% slower
    } else if (options.avgResponseTime > 1000) {
      rate *= 0.75; // 25% slower
    }
  }

  if (options?.hasJavaScript && strategy === 'browser') {
    // JS-heavy sites are slower to process
    rate *= 0.8;
  }

  if (options?.hasSitemap) {
    // Sitemaps make crawling more efficient (faster URL discovery)
    rate *= 1.2;
  }

  // Calculate base time in seconds
  const baseSeconds = estimatedPages / rate;
  const totalSeconds = baseSeconds + BASE_OVERHEAD_SECONDS;

  // Add 20% variance for min/max range
  const min = Math.floor(totalSeconds * 0.8);
  const max = Math.ceil(totalSeconds * 1.2);

  // Format based on duration
  if (totalSeconds < 60) {
    return {
      min,
      max,
      unit: 'seconds',
      formatted: `${min}-${max} seconds`,
    };
  } else {
    const minMinutes = Math.floor(min / 60);
    const maxMinutes = Math.ceil(max / 60);
    return {
      min: minMinutes,
      max: maxMinutes,
      unit: 'minutes',
      formatted: `${minMinutes}-${maxMinutes} minutes`,
    };
  }
}

/**
 * Get a human-readable explanation of what affects duration
 */
export function getDurationFactors(
  strategy: CrawlStrategy,
  estimatedPages: number,
  options?: {
    avgResponseTime?: number;
    hasJavaScript?: boolean;
    hasSitemap?: boolean;
  },
): string[] {
  const factors: string[] = [];

  factors.push(`${estimatedPages} estimated pages to crawl`);
  factors.push(`${strategy} strategy (${STRATEGY_RATES[strategy]} pages/sec base rate)`);

  if (options?.avgResponseTime) {
    if (options.avgResponseTime > 2000) {
      factors.push('Site has slow response times (2x slower)');
    } else if (options.avgResponseTime > 1000) {
      factors.push('Site has moderate response times (1.5x slower)');
    }
  }

  if (options?.hasJavaScript && strategy === 'browser') {
    factors.push('JavaScript execution required (20% slower)');
  }

  if (options?.hasSitemap) {
    factors.push('Sitemap available (20% faster)');
  }

  return factors;
}
