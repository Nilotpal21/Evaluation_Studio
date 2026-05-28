/**
 * Pagination Detector — finds pagination patterns on crawled pages
 * and generates URLs for all pages.
 *
 * Paginated listing pages (e-commerce products, blog archives) currently
 * discover only page 1. This detector finds pagination patterns and
 * generates URLs for all pages.
 *
 * Zero LLM calls — pure heuristic + DOM inspection via cheerio.
 *
 * Detection strategies (in priority order):
 * 1. rel="next" link tags — highest confidence (spec-defined)
 * 2. Query parameter patterns (?page=N) — common and reliable
 * 3. Path segment patterns (/page/N) — WordPress-style
 * 4. DOM patterns (.pagination class with page links) — fallback
 * 5. Item count text ("Showing 1-20 of 342") — estimate total pages
 */

import * as cheerio from 'cheerio';
import { createLogger } from '../../logger.js';
import type { CrawlResultLink } from './types.js';

const log = createLogger('pagination-detector');

/** Result of pagination detection on a single page */
export interface PaginationResult {
  detected: boolean;
  type: 'query-param' | 'path-segment' | 'rel-next' | 'dom-pattern' | 'none';
  pattern?: string;
  currentPage?: number;
  totalPages?: number;
  nextUrl?: string;
  allPageUrls?: string[];
  confidence: number; // 0.0–1.0
}

/** Configuration for the pagination detector */
export interface PaginationDetectorConfig {
  maxPages: number; // default 100
}

// WHY 100: Reasonable upper bound to prevent generating thousands of URLs
// for sites with enormous pagination. Can be overridden per-crawl.
const DEFAULT_MAX_PAGES = 100;

/** Regex to match query parameter pagination: ?page=N or &page=N */
const QUERY_PAGE_REGEX = /[?&]page=(\d+)/i;

/** Regex to match path segment pagination: /page/N or /page/N/ */
const PATH_PAGE_REGEX = /\/page\/(\d+)\/?$/i;

/**
 * Regex to extract item count text like:
 * - "Showing 1-20 of 342 results"
 * - "Showing 1 - 20 of 342"
 * - "1–20 of 342 results"
 * - "Displaying 21-40 of 342 items"
 *
 * Captures: start, end, total
 */
const ITEM_COUNT_REGEX = /(?:showing|displaying)?\s*(\d+)\s*[-–]\s*(\d+)\s*(?:of|\/)\s*(\d+)/i;

/**
 * Pagination Detector — inspects links and HTML to find pagination patterns,
 * then generates URLs for all pages when the pattern and total are known.
 */
export class PaginationDetector {
  private readonly maxPages: number;

  constructor(config?: Partial<PaginationDetectorConfig>) {
    this.maxPages = config?.maxPages ?? DEFAULT_MAX_PAGES;
  }

  /**
   * Detect pagination pattern on a page.
   *
   * Inspects the page's links and HTML for pagination signals,
   * returning the best match with generated page URLs when possible.
   */
  detect(url: string, html: string, links: CrawlResultLink[]): PaginationResult {
    const $ = cheerio.load(html);
    return this._detectInternal($, url, links);
  }

  /**
   * Detect pagination pattern using a pre-parsed cheerio DOM.
   * Use this when the caller has already parsed HTML with cheerio
   * to avoid redundant parsing.
   */
  detectWithDom($: cheerio.CheerioAPI, url: string, links: CrawlResultLink[]): PaginationResult {
    return this._detectInternal($, url, links);
  }

  /**
   * Shared implementation for detect() and detectWithDom().
   * All detection logic lives here.
   */
  private _detectInternal(
    $: cheerio.CheerioAPI,
    url: string,
    links: CrawlResultLink[],
  ): PaginationResult {
    const candidates: PaginationResult[] = [];

    // Strategy 1: rel="next" link (highest confidence)
    const relNext = this.detectRelNext(url, $);
    if (relNext.detected) candidates.push(relNext);

    // Strategy 2: Query parameter ?page=N
    const queryParam = this.detectQueryParam(url, links);
    if (queryParam.detected) candidates.push(queryParam);

    // Strategy 3: Path segment /page/N
    const pathSegment = this.detectPathSegment(url, links);
    if (pathSegment.detected) candidates.push(pathSegment);

    // Strategy 4: DOM .pagination class
    const domPattern = this.detectDomPattern(url, $);
    if (domPattern.detected) candidates.push(domPattern);

    if (candidates.length === 0) {
      log.debug('No pagination detected', { url });
      return {
        detected: false,
        type: 'none',
        confidence: 0,
      };
    }

    // Pick highest confidence candidate
    candidates.sort((a, b) => b.confidence - a.confidence);
    const best = candidates[0];

    // Enrich with item count text when it provides better total page info.
    // Item count text like "Showing 1-20 of 342" is more accurate than
    // counting visible page links (which may only show the first few).
    const itemCount = this.extractItemCount($);
    if (itemCount !== undefined) {
      const itemTotalPages = Math.min(itemCount.totalPages, this.maxPages);
      if (best.totalPages === undefined || itemTotalPages > best.totalPages) {
        best.totalPages = itemTotalPages;
        best.allPageUrls = this.generatePageUrls(url, best.type, best.pattern, best.totalPages);
      }
    }

    log.debug('Pagination detected', {
      url,
      type: best.type,
      confidence: best.confidence,
      totalPages: best.totalPages,
      pageUrlCount: best.allPageUrls?.length,
    });

    return best;
  }

  /**
   * Detect rel="next" link in HTML head.
   * Highest confidence because it's a W3C-specified pagination hint.
   */
  private detectRelNext(url: string, $: cheerio.CheerioAPI): PaginationResult {
    const nextLink = $('link[rel="next"]').attr('href');

    if (!nextLink) {
      return { detected: false, type: 'none', confidence: 0 };
    }

    const resolvedUrl = this.resolveUrl(nextLink, url);
    if (!resolvedUrl) {
      return { detected: false, type: 'none', confidence: 0 };
    }

    // Try to extract current page from the current URL
    const currentPage = this.extractPageNumber(url);

    return {
      detected: true,
      type: 'rel-next',
      pattern: 'rel="next"',
      currentPage: currentPage ?? 1,
      nextUrl: resolvedUrl,
      confidence: 0.95,
    };
  }

  /**
   * Detect query parameter pagination pattern (?page=N).
   * Scans links for ?page= parameters and extracts the pattern.
   */
  private detectQueryParam(url: string, links: CrawlResultLink[]): PaginationResult {
    const pageNumbers: number[] = [];
    let patternBase: string | undefined;

    for (const link of links) {
      const match = QUERY_PAGE_REGEX.exec(link.href);
      if (match) {
        const pageNum = parseInt(match[1], 10);
        if (pageNum > 0 && pageNum <= this.maxPages) {
          pageNumbers.push(pageNum);
          if (!patternBase) {
            // Extract the base URL pattern (everything before ?page=)
            patternBase = link.href.replace(QUERY_PAGE_REGEX, '');
          }
        }
      }
    }

    if (pageNumbers.length === 0) {
      return { detected: false, type: 'none', confidence: 0 };
    }

    const currentPage = this.extractPageNumber(url) ?? 1;
    const maxFoundPage = Math.max(...pageNumbers);
    const totalPages = Math.min(maxFoundPage, this.maxPages);

    // Resolve patternBase relative to the page URL
    const resolvedBase = this.resolveUrl(patternBase ?? url, url) ?? url;

    const pattern = `${this.getPatternTemplate(resolvedBase)}?page={N}`;
    const allPageUrls = this.generatePageUrls(url, 'query-param', pattern, totalPages);

    // Build next URL
    const nextPage = currentPage + 1;
    const nextUrl =
      nextPage <= totalPages ? this.buildQueryParamUrl(resolvedBase, nextPage) : undefined;

    // WHY 0.85: Query params are reliable but less authoritative than rel="next"
    return {
      detected: true,
      type: 'query-param',
      pattern,
      currentPage,
      totalPages,
      nextUrl,
      allPageUrls,
      confidence: 0.85,
    };
  }

  /**
   * Detect path segment pagination pattern (/page/N).
   * Common in WordPress and similar CMS platforms.
   */
  private detectPathSegment(url: string, links: CrawlResultLink[]): PaginationResult {
    const pageNumbers: number[] = [];

    for (const link of links) {
      const resolved = this.resolveUrl(link.href, url);
      if (!resolved) continue;

      const match = PATH_PAGE_REGEX.exec(resolved);
      if (match) {
        const pageNum = parseInt(match[1], 10);
        if (pageNum > 0 && pageNum <= this.maxPages) {
          pageNumbers.push(pageNum);
        }
      }
    }

    if (pageNumbers.length === 0) {
      return { detected: false, type: 'none', confidence: 0 };
    }

    const currentPage = this.extractPageNumberFromPath(url) ?? 1;
    const maxFoundPage = Math.max(...pageNumbers);
    const totalPages = Math.min(maxFoundPage, this.maxPages);

    // Build base URL by removing /page/N from the URL
    const baseUrl = url.replace(PATH_PAGE_REGEX, '');
    const pattern = `${baseUrl}/page/{N}`;

    const allPageUrls = this.generatePageUrls(url, 'path-segment', pattern, totalPages);

    const nextPage = currentPage + 1;
    const nextUrl = nextPage <= totalPages ? `${baseUrl}/page/${nextPage}` : undefined;

    // WHY 0.8: Path segments are reliable for WordPress-style sites
    return {
      detected: true,
      type: 'path-segment',
      pattern,
      currentPage,
      totalPages,
      nextUrl,
      allPageUrls,
      confidence: 0.8,
    };
  }

  /**
   * Detect DOM pagination pattern (.pagination class with numbered links).
   * Fallback when other methods don't match.
   */
  private detectDomPattern(url: string, $: cheerio.CheerioAPI): PaginationResult {
    const paginationEl = $('.pagination, [class*="pagination"], nav[aria-label="pagination"]');

    if (paginationEl.length === 0) {
      return { detected: false, type: 'none', confidence: 0 };
    }

    // Extract page links from pagination container
    const pageNumbers: number[] = [];
    const pageLinks: Array<{ page: number; href: string }> = [];

    paginationEl.find('a[href]').each((_i, el) => {
      const href = $(el).attr('href') ?? '';
      const text = $(el).text().trim();
      const pageNum = parseInt(text, 10);

      if (!isNaN(pageNum) && pageNum > 0 && pageNum <= this.maxPages) {
        pageNumbers.push(pageNum);
        const resolved = this.resolveUrl(href, url);
        if (resolved) {
          pageLinks.push({ page: pageNum, href: resolved });
        }
      }
    });

    if (pageNumbers.length === 0) {
      return { detected: false, type: 'none', confidence: 0 };
    }

    const currentPage = this.extractPageNumber(url) ?? 1;
    const maxFoundPage = Math.max(...pageNumbers);
    const totalPages = Math.min(maxFoundPage, this.maxPages);

    // Determine the underlying pattern from the first page link
    let detectedType: PaginationResult['type'] = 'dom-pattern';
    let pattern: string | undefined;

    if (pageLinks.length > 0) {
      const firstLink = pageLinks[0].href;
      if (QUERY_PAGE_REGEX.test(firstLink)) {
        pattern = `${this.getPatternTemplate(firstLink.replace(QUERY_PAGE_REGEX, ''))}?page={N}`;
      } else if (PATH_PAGE_REGEX.test(firstLink)) {
        pattern = `${firstLink.replace(PATH_PAGE_REGEX, '')}/page/{N}`;
      }
    }

    // Build allPageUrls from discovered links
    const allPageUrls = pageLinks.sort((a, b) => a.page - b.page).map((pl) => pl.href);

    const nextPage = currentPage + 1;
    const nextLink = pageLinks.find((pl) => pl.page === nextPage);
    const nextUrl = nextLink?.href;

    // WHY 0.7: DOM pattern is a fallback — less reliable than explicit pagination markers
    return {
      detected: true,
      type: detectedType,
      pattern,
      currentPage,
      totalPages,
      nextUrl,
      allPageUrls: allPageUrls.length > 0 ? allPageUrls : undefined,
      confidence: 0.7,
    };
  }

  /**
   * Extract item count information from page text.
   * Looks for patterns like "Showing 1-20 of 342 results".
   *
   * Returns estimated total pages based on items per page.
   */
  private extractItemCount(
    $: cheerio.CheerioAPI,
  ): { start: number; end: number; total: number; totalPages: number } | undefined {
    const bodyText = $.text();

    const match = ITEM_COUNT_REGEX.exec(bodyText);
    if (!match) return undefined;

    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    const total = parseInt(match[3], 10);

    if (isNaN(start) || isNaN(end) || isNaN(total)) return undefined;
    if (start <= 0 || end <= 0 || total <= 0) return undefined;
    if (end < start || total < end) return undefined;

    const perPage = end - start + 1;
    if (perPage <= 0) return undefined;

    const totalPages = Math.ceil(total / perPage);

    return { start, end, total, totalPages };
  }

  /**
   * Generate all page URLs for a detected pagination pattern.
   */
  private generatePageUrls(
    baseUrl: string,
    type: PaginationResult['type'],
    pattern: string | undefined,
    totalPages: number,
  ): string[] {
    const cappedTotal = Math.min(totalPages, this.maxPages);
    const urls: string[] = [];

    if (!pattern) return urls;

    for (let page = 1; page <= cappedTotal; page++) {
      if (type === 'query-param') {
        const base = this.getBaseFromPattern(pattern);
        urls.push(this.buildQueryParamUrl(base, page));
      } else if (type === 'path-segment') {
        const base = pattern.replace('/page/{N}', '');
        urls.push(`${base}/page/${page}`);
      } else {
        // For other types, try simple replacement
        urls.push(pattern.replace('{N}', String(page)));
      }
    }

    return urls;
  }

  /**
   * Extract a page number from a URL using either query param or path segment patterns.
   */
  private extractPageNumber(url: string): number | undefined {
    const queryMatch = QUERY_PAGE_REGEX.exec(url);
    if (queryMatch) {
      const num = parseInt(queryMatch[1], 10);
      return num > 0 ? num : undefined;
    }

    return this.extractPageNumberFromPath(url);
  }

  /**
   * Extract page number from path segment pattern (/page/N).
   */
  private extractPageNumberFromPath(url: string): number | undefined {
    const match = PATH_PAGE_REGEX.exec(url);
    if (match) {
      const num = parseInt(match[1], 10);
      return num > 0 ? num : undefined;
    }
    return undefined;
  }

  /**
   * Resolve a potentially relative URL against a base URL.
   * Returns undefined if the URL is invalid.
   */
  private resolveUrl(href: string, base: string): string | undefined {
    try {
      return new URL(href, base).href;
    } catch {
      return undefined;
    }
  }

  /**
   * Get the base URL pattern template (removes query string).
   */
  private getPatternTemplate(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return url;
    }
  }

  /**
   * Build a query parameter URL for a specific page number.
   */
  private buildQueryParamUrl(base: string, page: number): string {
    try {
      const parsed = new URL(base);
      parsed.searchParams.set('page', String(page));
      return parsed.href;
    } catch {
      // Fallback for non-parseable URLs
      const separator = base.includes('?') ? '&' : '?';
      return `${base}${separator}page=${page}`;
    }
  }

  /**
   * Extract the base URL from a pattern template like "https://example.com/products?page={N}".
   */
  private getBaseFromPattern(pattern: string): string {
    // Remove ?page={N} or &page={N} suffix
    return pattern.replace(/[?&]page=\{N\}$/, '');
  }
}
