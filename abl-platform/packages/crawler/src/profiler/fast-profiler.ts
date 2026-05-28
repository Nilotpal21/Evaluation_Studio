/**
 * Fast Profiler - HTTP-only site profiling
 *
 * Optimized for speed (<10 seconds typical)
 * Uses only HTTP requests, no browser automation
 *
 * Responsibilities (Single Responsibility Principle):
 * - Fetch HTML via HTTP
 * - Detect site type from HTML analysis
 * - Estimate size from sitemap/robots.txt
 * - Calculate basic metrics
 */

import { createLogger } from '../logger.js';

import * as cheerio from 'cheerio';
import { safeFetch } from '@agent-platform/shared-kernel/security/safe-fetch';
import {
  ISiteProfiler,
  SiteProfile,
  ProfileOptions,
  ProfilerCapabilities,
  ProfilerTimeoutError,
  ProfilerError,
  SitemapDiscoveryResult,
  SitemapDiscoveryStep,
  SitemapFile,
} from './interfaces.js';
import {
  PlatformDetector,
  type PlatformResult,
} from '../intelligence/algorithms/platform-detector.js';

type SiteType = 'static' | 'spa' | 'hybrid' | 'unknown';

const log = createLogger('fast-profiler');

export class FastProfiler implements ISiteProfiler {
  private readonly userAgent = 'ABL-Crawler-Profiler/1.0';
  private readonly defaultTimeout = 10000;
  private lastPlatformResult: PlatformResult | undefined;

  getName(): string {
    return 'fast-profiler';
  }

  getCapabilities(): ProfilerCapabilities {
    return {
      canDetectFrameworks: true,
      canTestRateLimits: false, // Too slow for fast mode
      canEstimateSize: true,
      requiresBrowser: false,
      avgDurationMs: 3000,
    };
  }

  /**
   * Discover all sitemap URLs for a site, including robots.txt Sitemap: directives.
   *
   * This is the single authoritative entry point for sitemap discovery. It:
   * 1. Fetches robots.txt and parses Sitemap: directives
   * 2. Combines robots.txt sitemaps with any extra URLs (e.g., user-provided)
   * 3. Delegates to extractSitemapUrls for /sitemap.xml + additional sitemaps
   *
   * Use this instead of calling extractSitemapUrls directly — extractSitemapUrls
   * does NOT fetch robots.txt on its own and will miss robots.txt-only sitemaps.
   *
   * @param url - Base URL of the site (e.g., https://www.epson.com/)
   * @param maxUrls - Maximum number of URLs to return (default: 1000)
   * @param timeout - Timeout per sitemap fetch in ms (default: 5000)
   * @param extraSitemapUrls - Additional sitemap URLs to check, e.g., user-provided (default: [])
   * @returns Structured discovery result with steps, files, and flat URL list
   */
  async discoverSitemapUrls(
    url: string,
    maxUrls: number = 1000,
    timeout: number = 5000,
    extraSitemapUrls: string[] = [],
  ): Promise<SitemapDiscoveryResult> {
    // 1. Fetch robots.txt and parse Sitemap: directives
    const robotsTxt = await this.fetchRobotsTxt(url);
    const robotsSitemapUrls = robotsTxt ? this.parseSitemapDirectives(robotsTxt) : [];

    // 2. Run extractSitemapUrls with robots.txt sitemaps (labeled 'robots.txt')
    const result = await this.extractSitemapUrls(url, maxUrls, timeout, robotsSitemapUrls);

    // 3. Process user-provided sitemaps separately (labeled 'user-provided')
    if (extraSitemapUrls.length > 0) {
      const visited = new Set(result.sitemapFiles.map((f) => f.url));
      for (const extraUrl of extraSitemapUrls) {
        if (visited.has(extraUrl)) {
          // Already discovered via /sitemap.xml or robots.txt — skip but tag step
          const existing = result.sitemapFiles.filter(
            (f) => f.url === extraUrl || f.parentUrl === extraUrl,
          );
          const urlCount = existing.reduce((sum, f) => sum + f.urls.length, 0);
          result.steps.push({
            source: 'user-provided',
            url: extraUrl,
            status: 'found',
            urlCount,
            type: existing.length > 1 ? 'index' : 'sitemap',
          });
          continue;
        }

        try {
          const files = await this.fetchSitemapFiles(extraUrl, 'user-provided', timeout, visited);
          if (files.length > 0) {
            const totalUrls = files.reduce((sum, f) => sum + f.urls.length, 0);
            const isIndex = files.length > 1 || files.some((f) => f.origin === 'index');
            result.steps.push({
              source: 'user-provided',
              url: extraUrl,
              status: 'found',
              urlCount: totalUrls,
              type: isIndex ? 'index' : 'sitemap',
            });
            result.sitemapFiles.push(...files);

            // Add new URLs to allUrls (dedup against existing)
            const existingUrls = new Set(result.allUrls);
            for (const file of files) {
              for (const entry of file.urls) {
                if (!existingUrls.has(entry.loc)) {
                  result.allUrls.push(entry.loc);
                  existingUrls.add(entry.loc);
                }
              }
            }
            result.totalUrls = result.allUrls.length;
          } else {
            result.steps.push({
              source: 'user-provided',
              url: extraUrl,
              status: 'not_found',
            });
          }
        } catch {
          result.steps.push({
            source: 'user-provided',
            url: extraUrl,
            status: 'error',
          });
        }
      }
    }

    return result;
  }

  async profile(url: string, options: ProfileOptions = {}): Promise<SiteProfile> {
    const timeout = options.timeout || this.defaultTimeout;
    const startTime = Date.now();

    try {
      // Run HTML + robots.txt fetches in parallel for speed.
      // We fetch robots.txt here so profile() can report hasRobotsTxt accurately,
      // then pass parsed directives to extractSitemapUrls for full discovery.
      const [html, robotsTxt] = await Promise.all([
        this.fetchHTML(url, timeout),
        this.fetchRobotsTxt(url),
      ]);

      // Parse robots.txt for Sitemap: directives
      const robotsSitemapUrls = robotsTxt ? this.parseSitemapDirectives(robotsTxt) : [];

      // Run sitemap discovery with both default /sitemap.xml and robots.txt sitemaps
      const sitemapDiscovery = await this.extractSitemapUrls(
        url,
        100_000, // Return all URLs so cluster-urls doesn't need to re-fetch sitemaps
        10_000,
        robotsSitemapUrls,
      ).catch(
        () =>
          ({
            steps: [],
            sitemapFiles: [],
            totalUrls: 0,
            allUrls: [],
          }) as SitemapDiscoveryResult,
      );

      const sitemapExists = sitemapDiscovery.totalUrls > 0;

      const $ = cheerio.load(html);
      const domain = new URL(url).hostname;

      // Detect site characteristics
      const siteType = this.detectSiteType($, html);
      const framework =
        options.detectFramework !== false ? this.detectFramework($, html) : undefined;
      const linkDensity = this.calculateLinkDensity($, domain);
      const estimatedSize = sitemapExists
        ? sitemapDiscovery.totalUrls
        : this.estimateSizeFromLinks($, linkDensity);

      const profile: SiteProfile = {
        domain,
        profiledAt: new Date(),
        siteType,
        framework,
        jsRequired: siteType === 'spa',
        linkDensity,
        estimatedSize,
        avgResponseTime: Date.now() - startTime,
        rateLimitDetected: false, // Fast mode doesn't test this
        maxConcurrency: 10, // Default, not tested in fast mode
        confidence: this.calculateConfidence(siteType, framework, linkDensity),
        metadata: {
          hasRobotsTxt: robotsTxt !== null,
          hasSitemap: sitemapExists,
          htmlSize: html.length,
          scriptTagCount: $('script').length,
          platformResult: this.lastPlatformResult,
          platformCategory: this.lastPlatformResult?.category,
          apiEndpoints: this.lastPlatformResult?.apiEndpoints,
          sitemapDiscovery,
        },
      };

      return profile;
    } catch (error) {
      if (Date.now() - startTime >= timeout) {
        throw new ProfilerTimeoutError(url, timeout);
      }

      if (error instanceof ProfilerTimeoutError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new ProfilerError(`Failed to profile ${url}: ${message}`, error as Error);
    }
  }

  /**
   * Parse Sitemap: directives from robots.txt content.
   * Simple line-by-line parsing — keeps the profiler self-contained
   * (no dependency on robots-analyzer.ts in apps/search-ai).
   */
  private parseSitemapDirectives(robotsTxtContent: string): string[] {
    const sitemapUrls: string[] = [];
    for (const line of robotsTxtContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().startsWith('sitemap:')) {
        const url = trimmed.substring('sitemap:'.length).trim();
        if (url) {
          sitemapUrls.push(url);
        }
      }
    }
    return sitemapUrls;
  }

  /**
   * Detect site type from HTML structure
   *
   * Rules:
   * - Hybrid: SSR framework markers (Next.js, Nuxt) + content
   * - SPA: React/Vue/Angular root + minimal HTML content
   * - Static: Semantic HTML, minimal JS
   * - Unknown: Ambiguous signals
   */
  private detectSiteType($: cheerio.CheerioAPI, html: string): SiteType {
    const bodyText = $('body').text().trim();
    const hasContentInHTML = bodyText.length > 100; // Lowered threshold for SSR detection
    const scriptTags = $('script').length;
    const hasSemanticHTML = $('article, section, nav, header, footer').length > 0;

    // Check for SSR framework markers first (priority)
    const hasNextData = html.includes('__NEXT_DATA__') || $('#__next').length > 0;
    const hasNuxtData = html.includes('__NUXT__');
    const hasSSRFramework = hasNextData || hasNuxtData;

    // Hybrid if SSR framework + (content OR semantic HTML)
    if (hasSSRFramework && (hasContentInHTML || hasSemanticHTML)) {
      return 'hybrid'; // SSR/SSG
    }

    // Check for SPA framework markers
    const hasReactRoot = $('#root, [data-reactroot], [data-reactid]').length > 0;
    const hasVueApp = $('#app, [data-v-]').length > 0;
    const hasAngularApp = $('[ng-app], [ng-version]').length > 0;
    const hasSPAFramework = hasReactRoot || hasVueApp || hasAngularApp;

    // SPA without SSR
    if (hasSPAFramework && !hasContentInHTML) {
      return 'spa';
    }

    // Static HTML - has semantic elements and minimal scripts
    if (hasSemanticHTML && scriptTags < 5) {
      return 'static';
    }

    // If has content but minimal framework markers, likely static
    if (hasContentInHTML && !hasSPAFramework && scriptTags < 10) {
      return 'static';
    }

    return 'unknown';
  }

  /**
   * Detect JavaScript framework / platform from HTML using PlatformDetector.
   *
   * Replaces the legacy string-matching approach with multi-signal pattern
   * matching that avoids false positives (e.g., html.includes('react')).
   */
  private detectFramework($: cheerio.CheerioAPI, html: string): string | undefined {
    const detector = new PlatformDetector();
    const result = detector.detect(html, $);
    // Store full result for profile() to attach to SiteProfile.metadata
    this.lastPlatformResult = result;
    return result.platform;
  }

  /**
   * Calculate link density (internal links per page)
   */
  private calculateLinkDensity($: cheerio.CheerioAPI, domain: string): number {
    let internalLinks = 0;

    $('a[href]').each((_, elem) => {
      const href = $(elem).attr('href');
      if (!href) return;

      // Count as internal if:
      // 1. Starts with / (relative)
      // 2. Contains domain name
      // 3. Doesn't start with http (relative)
      if (
        href.startsWith('/') ||
        href.includes(domain) ||
        (!href.startsWith('http') && !href.startsWith('//'))
      ) {
        internalLinks++;
      }
    });

    return internalLinks;
  }

  /**
   * Estimate site size from link analysis
   */
  private estimateSizeFromLinks($: cheerio.CheerioAPI, linkDensity: number): number {
    // Heuristic: Assume 3 levels of navigation, diminishing returns
    const level1 = 1; // Current page
    const level2 = linkDensity;
    const level3 = linkDensity * 0.5; // Assume 50% unique links at level 3

    return Math.ceil(level1 + level2 + level3);
  }

  /**
   * Calculate confidence score
   */
  private calculateConfidence(
    siteType: SiteType,
    framework: string | undefined,
    linkDensity: number,
  ): number {
    let confidence = 50;

    // Strong signal: known site type
    if (siteType !== 'unknown') confidence += 30;

    // Framework detected adds certainty
    if (framework !== undefined) confidence += 20;

    // Links indicate explorable site
    if (linkDensity > 0) confidence += 10;

    // Bonus for static sites with good link structure
    if (siteType === 'static' && linkDensity > 1) confidence += 5;

    return Math.min(confidence, 95);
  }

  /**
   * Fetch HTML via HTTP
   */
  private async fetchHTML(url: string, timeout: number): Promise<string> {
    try {
      return await this.fetchText(url, timeout);
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        throw new ProfilerTimeoutError(url, timeout);
      }

      if (error instanceof Error) {
        throw new ProfilerError(`Failed to fetch ${url}: ${error.message}`, error);
      }
      throw error;
    }
  }

  /**
   * Fetch robots.txt
   */
  private async fetchRobotsTxt(url: string): Promise<string | null> {
    try {
      const robotsUrl = new URL('/robots.txt', url).toString();
      return await this.fetchText(robotsUrl, 3000);
    } catch {
      return null;
    }
  }

  /**
   * Extract URLs from sitemaps with full discovery provenance.
   *
   * Checks the default /sitemap.xml and any additional sitemap URLs (e.g., from robots.txt).
   * Handles both regular sitemaps and sitemap indexes (recursive resolution).
   * Returns a structured result preserving per-file provenance and a flat URL list for compat.
   *
   * @param url - Base URL of the site (e.g., https://docs.kore.ai/)
   * @param maxUrls - Maximum number of URLs to return in allUrls (default: 1000)
   * @param timeout - Timeout per sitemap fetch in milliseconds (default: 5000)
   * @param additionalSitemapUrls - Extra sitemap URLs discovered from robots.txt (default: [])
   * @returns Structured discovery result with steps, files, and flat URL list
   */
  async extractSitemapUrls(
    url: string,
    maxUrls: number = 1000,
    timeout: number = 5000,
    additionalSitemapUrls: string[] = [],
  ): Promise<SitemapDiscoveryResult> {
    const steps: SitemapDiscoveryStep[] = [];
    const allSitemapFiles: SitemapFile[] = [];
    const visited = new Set<string>();

    try {
      // 1. Try the default /sitemap.xml
      const defaultSitemapUrl = new URL('/sitemap.xml', url).toString();
      try {
        const files = await this.fetchSitemapFiles(defaultSitemapUrl, 'default', timeout, visited);
        if (files.length > 0) {
          const totalFromDefault = files.reduce((sum, f) => sum + f.urls.length, 0);
          const isIndex = files.length > 1 || files.some((f) => f.origin === 'index');
          steps.push({
            source: 'default',
            url: defaultSitemapUrl,
            status: 'found',
            urlCount: totalFromDefault,
            type: isIndex ? 'index' : 'sitemap',
          });
          allSitemapFiles.push(...files);
        } else {
          steps.push({
            source: 'default',
            url: defaultSitemapUrl,
            status: 'not_found',
          });
        }
      } catch {
        steps.push({
          source: 'default',
          url: defaultSitemapUrl,
          status: 'not_found',
        });
      }

      // 2. Try robots.txt Sitemap: directives (skip if already visited via default)
      for (const robotsSitemapUrl of additionalSitemapUrls) {
        if (visited.has(robotsSitemapUrl)) {
          // Already fetched as part of default /sitemap.xml — skip but log step
          const existingFiles = allSitemapFiles.filter(
            (f) => f.url === robotsSitemapUrl || f.parentUrl === robotsSitemapUrl,
          );
          const urlCount = existingFiles.reduce((sum, f) => sum + f.urls.length, 0);
          steps.push({
            source: 'robots.txt',
            url: robotsSitemapUrl,
            status: 'found',
            urlCount,
            type: existingFiles.length > 1 ? 'index' : 'sitemap',
          });
          continue;
        }

        try {
          const files = await this.fetchSitemapFiles(
            robotsSitemapUrl,
            'robots.txt',
            timeout,
            visited,
          );
          if (files.length > 0) {
            const totalFromRobots = files.reduce((sum, f) => sum + f.urls.length, 0);
            const isIndex = files.length > 1 || files.some((f) => f.origin === 'index');
            steps.push({
              source: 'robots.txt',
              url: robotsSitemapUrl,
              status: 'found',
              urlCount: totalFromRobots,
              type: isIndex ? 'index' : 'sitemap',
            });
            allSitemapFiles.push(...files);
          } else {
            steps.push({
              source: 'robots.txt',
              url: robotsSitemapUrl,
              status: 'not_found',
            });
          }
        } catch {
          steps.push({
            source: 'robots.txt',
            url: robotsSitemapUrl,
            status: 'error',
          });
        }
      }

      // 3. Collect all URLs, dedup by loc, sort
      const urlMap = new Map<
        string,
        { loc: string; priority?: number; lastmod?: string; sitemapFile: string }
      >();
      for (const file of allSitemapFiles) {
        for (const entry of file.urls) {
          if (!urlMap.has(entry.loc)) {
            urlMap.set(entry.loc, { ...entry, sitemapFile: file.url });
          }
        }
      }

      const sortedEntries = Array.from(urlMap.values()).sort((a, b) => {
        if (a.priority !== b.priority) {
          return (b.priority || 0) - (a.priority || 0);
        }
        if (a.lastmod && b.lastmod) {
          return new Date(b.lastmod).getTime() - new Date(a.lastmod).getTime();
        }
        if (a.lastmod && !b.lastmod) return -1;
        if (!a.lastmod && b.lastmod) return 1;
        return 0;
      });

      const allUrls = sortedEntries.slice(0, maxUrls).map((e) => e.loc);

      return {
        steps,
        sitemapFiles: allSitemapFiles,
        totalUrls: urlMap.size,
        allUrls,
      };
    } catch (error) {
      if (error instanceof ProfilerTimeoutError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ProfilerError(`Failed to extract sitemap URLs: ${message}`, error as Error);
    }
  }

  /**
   * Fetch and resolve a sitemap URL into SitemapFile[] with provenance.
   * Handles both regular sitemaps and sitemap indexes (recursive resolution).
   *
   * @param sitemapUrl - The sitemap URL to fetch
   * @param origin - How this sitemap was discovered ('default' | 'robots.txt' | 'index')
   * @param timeout - Timeout per fetch in milliseconds
   * @param visited - Set of already-visited URLs (cycle protection)
   * @param parentUrl - Parent sitemap index URL (for child sitemaps)
   * @returns Array of SitemapFile entries with provenance
   * @private
   */
  private async fetchSitemapFiles(
    sitemapUrl: string,
    origin: SitemapFile['origin'],
    timeout: number,
    visited: Set<string>,
    parentUrl?: string,
  ): Promise<SitemapFile[]> {
    // Prevent infinite recursion
    if (visited.has(sitemapUrl)) {
      return [];
    }
    visited.add(sitemapUrl);

    try {
      const sitemapXml = await this.fetchText(sitemapUrl, timeout);
      const $ = cheerio.load(sitemapXml, { xmlMode: true });

      // Check if this is a sitemap index (contains <sitemapindex>)
      const isSitemapIndex = $('sitemapindex').length > 0;

      if (isSitemapIndex) {
        // Recursively fetch child sitemaps
        const childSitemapUrls: string[] = [];
        $('sitemap loc').each((_, elem) => {
          const childUrl = $(elem).text().trim();
          if (childUrl) {
            childSitemapUrls.push(childUrl);
          }
        });

        // Fetch all child sitemaps in parallel (with limit to avoid overwhelming)
        const MAX_PARALLEL_SITEMAPS = 5;
        const results: SitemapFile[] = [];

        for (let i = 0; i < childSitemapUrls.length; i += MAX_PARALLEL_SITEMAPS) {
          const batch = childSitemapUrls.slice(i, i + MAX_PARALLEL_SITEMAPS);
          const batchResults = await Promise.all(
            batch.map((childUrl) =>
              this.fetchSitemapFiles(childUrl, 'index', timeout, visited, sitemapUrl).catch(
                (err: unknown) => {
                  log.warn('Failed to fetch child sitemap', {
                    url: childUrl,
                    error: err instanceof Error ? err.message : String(err),
                  });
                  return [] as SitemapFile[];
                },
              ),
            ),
          );
          results.push(...batchResults.flat());
        }

        return results;
      }

      // Regular sitemap: extract <url> entries
      const urls: Array<{ loc: string; priority?: number; lastmod?: string }> = [];

      $('url').each((_, elem) => {
        const loc = $(elem).find('loc').text().trim();
        if (!loc) return;

        const priorityText = $(elem).find('priority').text().trim();
        const priority = priorityText ? parseFloat(priorityText) : undefined;

        const lastmod = $(elem).find('lastmod').text().trim() || undefined;

        urls.push({ loc, priority, lastmod });
      });

      return [
        {
          url: sitemapUrl,
          origin,
          parentUrl,
          urls,
        },
      ];
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        throw new ProfilerTimeoutError(sitemapUrl, timeout);
      }

      if (error instanceof Error) {
        throw new ProfilerError(`Failed to fetch sitemap ${sitemapUrl}: ${error.message}`, error);
      }

      throw error;
    }
  }

  private async fetchText(url: string, timeout: number): Promise<string> {
    const response = await safeFetch(
      url,
      {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent },
        signal: AbortSignal.timeout(timeout),
      },
      { maxRedirects: 5 },
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.text();
  }
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      ((error as { code?: unknown }).code === 'ECONNABORTED' ||
        (error as { code?: unknown }).code === 'ETIMEDOUT')
    );
  }
  const code = (error as Error & { code?: unknown }).code;
  return (
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT'
  );
}
