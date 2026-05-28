/**
 * Discovery Chain — 5-step fallback chain for sitemapless URL discovery.
 *
 * When a site has no sitemap.xml, the chain tries increasingly broad
 * strategies to find crawlable URLs:
 *
 * 1. Platform API (Shopify /products.json, WordPress /wp-json/...)
 * 2. Footer mining (footer links + common sitemap page paths)
 * 3. Nav-BFS (follow <nav> links up to 10 section pages)
 * 4. CDX bootstrap (web.archive.org historical URLs)
 * 5. Entry page links (all same-hostname links from homepage)
 *
 * All HTTP goes through HttpAdapter (SSRF protected).
 * Stops early when minUrls reached. Caps total at maxUrls.
 */

import * as cheerio from 'cheerio';
import { createLogger } from '../../logger.js';
import type { HttpAdapter } from './http-adapter.js';

const log = createLogger('discovery-chain');

/** Audit trail entry for a single discovery step */
export interface DiscoveryStep {
  method: 'platform-api' | 'footer-mining' | 'nav-bfs' | 'cdx' | 'entry-links';
  urlsFound: number;
  duration: number;
  details?: string;
}

/** Result of running the full discovery chain */
export interface DiscoveryResult {
  urls: string[];
  /** Which step produced the most URLs */
  method: string;
  /** Audit trail of all steps tried */
  steps: DiscoveryStep[];
  stats: {
    totalSteps: number;
    totalDuration: number;
    urlsPerStep: Record<string, number>;
  };
}

/** Configuration for the discovery chain */
export interface DiscoveryChainConfig {
  /** Minimum URLs to stop early (default 20) */
  minUrls: number;
  /** Maximum total URLs to return (default 5000) */
  maxUrls: number;
  /** Timeout per step in ms (default 10000) */
  stepTimeout: number;
  /** Enable CDX bootstrap step (default true) */
  enableCdx: boolean;
  /** CDX-specific timeout in ms (default 10000) */
  cdxTimeout: number;
}

const DEFAULT_CONFIG: DiscoveryChainConfig = {
  minUrls: 20,
  maxUrls: 5000,
  stepTimeout: 10_000,
  enableCdx: true,
  cdxTimeout: 10_000,
};

/** Common sitemap-like page paths to probe during footer mining */
const SITEMAP_PAGE_PATHS = ['/site-map', '/sitemap', '/all-products', '/pages'];

/**
 * 5-step fallback chain for discovering URLs on sites without sitemaps.
 *
 * All HTTP requests go through the injected HttpAdapter for SSRF protection.
 */
export class DiscoveryChain {
  private readonly config: DiscoveryChainConfig;

  constructor(
    private readonly adapter: HttpAdapter,
    config?: Partial<DiscoveryChainConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run the full fallback chain to discover URLs for a site.
   *
   * Stops early when minUrls is reached. Returns deduplicated URLs
   * capped at maxUrls.
   */
  async discover(
    baseUrl: string,
    options?: { platform?: string; apiEndpoints?: string[] },
  ): Promise<DiscoveryResult> {
    const allUrls = new Set<string>();
    const steps: DiscoveryStep[] = [];

    let hostname: string;
    try {
      hostname = new URL(baseUrl).hostname;
    } catch {
      log.error('Invalid base URL', { baseUrl });
      return this.buildResult(allUrls, steps);
    }

    // Step 1: Platform API (A10-d) — only if API endpoints provided
    if (options?.apiEndpoints?.length) {
      const step = await this.stepPlatformApi(baseUrl, hostname, options.apiEndpoints, allUrls);
      steps.push(step);
      if (allUrls.size >= this.config.minUrls) {
        return this.buildResult(allUrls, steps);
      }
    }

    // Fetch entry page once — reused by steps 2, 3, and 5
    const entryResult = await this.adapter.fetch(baseUrl);
    let $entry: cheerio.CheerioAPI | undefined;

    if (entryResult.success && entryResult.crawlResult) {
      $entry = cheerio.load(entryResult.crawlResult.html);

      // Step 2: Footer mining (A10-f)
      const step = await this.stepFooterMining(baseUrl, hostname, $entry, allUrls);
      steps.push(step);
      if (allUrls.size >= this.config.minUrls) {
        return this.buildResult(allUrls, steps);
      }

      // Step 3: Nav-BFS (A10-b)
      const navStep = await this.stepNavBfs(hostname, $entry, allUrls);
      steps.push(navStep);
      if (allUrls.size >= this.config.minUrls) {
        return this.buildResult(allUrls, steps);
      }
    }

    // Step 4: CDX bootstrap (A10-c)
    if (this.config.enableCdx) {
      const cdxStep = await this.stepCdx(hostname, allUrls);
      steps.push(cdxStep);
    }

    // Step 5: Entry page links (fallback) — use all same-hostname links from entry page
    if (allUrls.size < this.config.minUrls && entryResult.success && entryResult.crawlResult) {
      const prevSize = allUrls.size;
      const start = Date.now();
      for (const link of entryResult.crawlResult.links) {
        if (this.isSameHostname(link.href, hostname)) {
          allUrls.add(link.href);
        }
      }
      steps.push({
        method: 'entry-links',
        urlsFound: allUrls.size - prevSize,
        duration: Date.now() - start,
      });
    }

    return this.buildResult(allUrls, steps);
  }

  // ─── Step Implementations ─────────────────────────────────────────

  /**
   * Step 1: Platform API discovery.
   * Fetches known API endpoints and extracts product/post URLs from JSON.
   */
  private async stepPlatformApi(
    baseUrl: string,
    hostname: string,
    apiEndpoints: string[],
    allUrls: Set<string>,
  ): Promise<DiscoveryStep> {
    const start = Date.now();
    const prevSize = allUrls.size;

    for (const endpoint of apiEndpoints) {
      let apiUrl: string;
      try {
        apiUrl = new URL(endpoint, baseUrl).toString();
      } catch {
        log.warn('Invalid API endpoint URL', { endpoint, baseUrl });
        continue;
      }

      const result = await this.adapter.fetch(apiUrl);
      if (result.success && result.crawlResult) {
        const urls = this.extractUrlsFromApiResponse(result.crawlResult.html, hostname, baseUrl);
        for (const u of urls) {
          allUrls.add(u);
        }
      }
    }

    return {
      method: 'platform-api',
      urlsFound: allUrls.size - prevSize,
      duration: Date.now() - start,
    };
  }

  /**
   * Step 2: Footer mining.
   * Extracts links from <footer>, then probes common sitemap page paths.
   */
  private async stepFooterMining(
    baseUrl: string,
    hostname: string,
    $: cheerio.CheerioAPI,
    allUrls: Set<string>,
  ): Promise<DiscoveryStep> {
    const start = Date.now();
    const prevSize = allUrls.size;

    // Extract footer links
    const footerLinks = this.extractFooterLinks($, hostname);
    for (const u of footerLinks) {
      allUrls.add(u);
    }

    // Try common sitemap page paths
    for (const path of SITEMAP_PAGE_PATHS) {
      let sitemapUrl: string;
      try {
        sitemapUrl = new URL(path, baseUrl).toString();
      } catch {
        continue;
      }

      const pageResult = await this.adapter.fetch(sitemapUrl);
      if (pageResult.success && pageResult.crawlResult) {
        for (const link of pageResult.crawlResult.links) {
          if (this.isSameHostname(link.href, hostname)) {
            allUrls.add(link.href);
          }
        }
      }
    }

    return {
      method: 'footer-mining',
      urlsFound: allUrls.size - prevSize,
      duration: Date.now() - start,
    };
  }

  /**
   * Step 3: Nav-BFS.
   * Extracts <nav> links from entry page, follows up to 10 section pages.
   */
  private async stepNavBfs(
    hostname: string,
    $: cheerio.CheerioAPI,
    allUrls: Set<string>,
  ): Promise<DiscoveryStep> {
    const start = Date.now();
    const prevSize = allUrls.size;

    const navLinks = this.extractNavLinks($, hostname);
    const toFollow = navLinks.slice(0, 10);

    for (const navUrl of toFollow) {
      const sectionResult = await this.adapter.fetch(navUrl);
      if (sectionResult.success && sectionResult.crawlResult) {
        for (const link of sectionResult.crawlResult.links) {
          if (this.isSameHostname(link.href, hostname)) {
            allUrls.add(link.href);
          }
        }
      }
    }

    return {
      method: 'nav-bfs',
      urlsFound: allUrls.size - prevSize,
      duration: Date.now() - start,
    };
  }

  /**
   * Step 4: CDX bootstrap.
   * Fetches historical URLs from web.archive.org's CDX API.
   */
  private async stepCdx(hostname: string, allUrls: Set<string>): Promise<DiscoveryStep> {
    const start = Date.now();
    const prevSize = allUrls.size;

    try {
      const cdxUrls = await this.fetchCdxUrls(hostname);
      for (const u of cdxUrls) {
        allUrls.add(u);
      }
      return {
        method: 'cdx',
        urlsFound: allUrls.size - prevSize,
        duration: Date.now() - start,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('CDX step failed', { hostname, error: message });
      return {
        method: 'cdx',
        urlsFound: 0,
        duration: Date.now() - start,
        details: 'timeout or unavailable',
      };
    }
  }

  // ─── Helper Methods ───────────────────────────────────────────────

  /**
   * Extract links from <footer> elements, filtered to same hostname.
   */
  private extractFooterLinks($: cheerio.CheerioAPI, hostname: string): string[] {
    const urls: string[] = [];
    $('footer a[href]').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      try {
        const absoluteUrl = new URL(href, `https://${hostname}`).toString();
        if (this.isSameHostname(absoluteUrl, hostname)) {
          urls.push(absoluteUrl);
        }
      } catch {
        // Skip malformed URLs
      }
    });
    return urls;
  }

  /**
   * Extract links from <nav> elements, filtered to same hostname, deduplicated.
   */
  private extractNavLinks($: cheerio.CheerioAPI, hostname: string): string[] {
    const seen = new Set<string>();
    const urls: string[] = [];
    $('nav a[href]').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      try {
        const absoluteUrl = new URL(href, `https://${hostname}`).toString();
        if (this.isSameHostname(absoluteUrl, hostname) && !seen.has(absoluteUrl)) {
          seen.add(absoluteUrl);
          urls.push(absoluteUrl);
        }
      } catch {
        // Skip malformed URLs
      }
    });
    return urls;
  }

  /**
   * Fetch historical URLs from the CDX API (web.archive.org).
   *
   * CDX response format: JSON array of arrays
   * [["urlkey","timestamp","original",...], ...]
   * First row is headers, rest are data. Extract index 2 (original URL).
   */
  private async fetchCdxUrls(hostname: string): Promise<string[]> {
    const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${hostname}/*&output=json&collapse=urlkey&limit=500`;
    const result = await this.adapter.fetch(cdxUrl);

    if (!result.success || !result.crawlResult) {
      return [];
    }

    let rows: unknown;
    try {
      rows = JSON.parse(result.crawlResult.html);
    } catch {
      log.warn('CDX response is not valid JSON', { hostname });
      return [];
    }

    if (!Array.isArray(rows) || rows.length < 2) {
      return [];
    }

    const urls: string[] = [];
    // Skip header row (index 0), extract original URL (index 2) from each data row
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (Array.isArray(row) && typeof row[2] === 'string') {
        const originalUrl = row[2];
        // Filter to same hostname
        if (this.isSameHostname(originalUrl, hostname)) {
          urls.push(originalUrl);
        }
      }
    }

    return urls;
  }

  /**
   * Extract product/post URLs from a JSON API response.
   *
   * Supports:
   * - Shopify /products.json: { products: [{ handle }] } → /products/${handle}
   * - WordPress /wp-json/wp/v2/posts: [{ link }]
   * - Generic: any array of objects with `link`, `url`, or `href` fields
   */
  private extractUrlsFromApiResponse(
    responseBody: string,
    hostname: string,
    baseUrl: string,
  ): string[] {
    let data: unknown;
    try {
      data = JSON.parse(responseBody);
    } catch {
      log.warn('API response is not valid JSON', { hostname });
      return [];
    }

    const urls: string[] = [];

    // Shopify pattern: { products: [{ handle: "product-slug" }] }
    if (this.isObject(data) && Array.isArray((data as Record<string, unknown>).products)) {
      const products = (data as Record<string, unknown>).products as unknown[];
      for (const product of products) {
        if (this.isObject(product)) {
          const handle = (product as Record<string, unknown>).handle;
          if (typeof handle === 'string') {
            try {
              const productUrl = new URL(`/products/${handle}`, baseUrl).toString();
              if (this.isSameHostname(productUrl, hostname)) {
                urls.push(productUrl);
              }
            } catch {
              // Skip malformed
            }
          }
        }
      }
      return urls;
    }

    // WordPress pattern: [{ link: "https://..." }]
    if (Array.isArray(data)) {
      for (const item of data) {
        if (!this.isObject(item)) continue;
        const record = item as Record<string, unknown>;
        // Try link, url, href fields
        for (const field of ['link', 'url', 'href']) {
          const value = record[field];
          if (typeof value === 'string') {
            try {
              const absoluteUrl = new URL(value, baseUrl).toString();
              if (this.isSameHostname(absoluteUrl, hostname)) {
                urls.push(absoluteUrl);
              }
            } catch {
              // Skip malformed
            }
            break; // Only use first matching field per item
          }
        }
      }
      return urls;
    }

    return urls;
  }

  /**
   * Build the final DiscoveryResult from collected URLs and steps.
   */
  private buildResult(allUrls: Set<string>, steps: DiscoveryStep[]): DiscoveryResult {
    // Cap at maxUrls
    const urlArray = Array.from(allUrls).slice(0, this.config.maxUrls);

    // Determine which step found the most URLs
    let bestMethod = 'none';
    let bestCount = 0;
    const urlsPerStep: Record<string, number> = {};
    let totalDuration = 0;

    for (const step of steps) {
      urlsPerStep[step.method] = step.urlsFound;
      totalDuration += step.duration;
      if (step.urlsFound > bestCount) {
        bestCount = step.urlsFound;
        bestMethod = step.method;
      }
    }

    log.info('Discovery chain complete', {
      totalUrls: urlArray.length,
      bestMethod,
      stepsRun: steps.length,
      totalDuration,
    });

    return {
      urls: urlArray,
      method: bestMethod,
      steps,
      stats: {
        totalSteps: steps.length,
        totalDuration,
        urlsPerStep,
      },
    };
  }

  /**
   * Check if a URL belongs to the same hostname.
   */
  private isSameHostname(url: string, hostname: string): boolean {
    try {
      return new URL(url).hostname === hostname;
    } catch {
      return false;
    }
  }

  /**
   * Type guard for plain objects.
   */
  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
