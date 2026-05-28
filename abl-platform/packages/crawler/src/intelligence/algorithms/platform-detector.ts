/**
 * Platform Detector — identifies the CMS, framework, or ecommerce platform
 * powering a website using multi-signal pattern matching.
 *
 * Zero LLM calls — pure heuristic matching against a database of 12+ platform
 * signal patterns (meta tags, script sources, CSS selectors, HTTP headers,
 * cookies, HTML comments, and API endpoint probing).
 *
 * Confidence scoring: max(matched_confidences) — single highest signal wins.
 * Rationale: a single high-confidence signal (e.g., x-shopify-stage header = 0.99)
 * is sufficient. Multiple weak signals don't compound.
 *
 * CRITICAL: NO html.includes('react') or html.includes('vue') — ONLY DOM
 * selector checks. This prevents false positives from page text content.
 */

import * as cheerio from 'cheerio';
import { createLogger } from '../../logger.js';
import type { HttpAdapter } from './http-adapter.js';

const log = createLogger('platform-detector');

// ─── Public Types ────────────────────────────────────────────────────────────

export interface PlatformSignal {
  type: 'meta-tag' | 'script-src' | 'html-comment' | 'selector' | 'header' | 'cookie' | 'api-probe';
  pattern: string; // what matched
  confidence: number; // 0.0–1.0
}

export interface PlatformResult {
  platform?: string; // e.g., 'shopify', 'wordpress', 'nextjs', 'react'
  category: 'ecommerce' | 'cms' | 'framework' | 'static-gen' | 'unknown';
  confidence: number; // 0.0–1.0
  signals: PlatformSignal[];
  apiEndpoints?: string[]; // discovered API URLs (for A10-d shortcut)
}

export interface PlatformDetectorConfig {
  minConfidence: number; // default 0.3
  enableApiProbing: boolean; // default true
  apiProbeTimeout: number; // default 5000ms
}

// ─── Internal Types ──────────────────────────────────────────────────────────

interface PlatformPatternSignal {
  type: 'meta-tag' | 'script-src' | 'html-comment' | 'selector' | 'header' | 'cookie';
  pattern?: string | RegExp; // substring match or regex
  query?: string; // CSS selector (for type='selector')
  match?: { name?: string; content?: string | RegExp }; // for meta-tag
  key?: string; // for header/cookie
  confidence: number;
}

interface PlatformPattern {
  category: 'ecommerce' | 'cms' | 'framework' | 'static-gen';
  signals: PlatformPatternSignal[];
  apiEndpoints?: string[];
  inherits?: string; // e.g., WooCommerce inherits WordPress
}

// ─── Platform Pattern Database ───────────────────────────────────────────────

const PLATFORM_PATTERNS: Record<string, PlatformPattern> = {
  shopify: {
    category: 'ecommerce',
    signals: [
      { type: 'script-src', pattern: 'cdn.shopify.com', confidence: 0.95 },
      { type: 'meta-tag', match: { name: 'shopify-checkout-api-token' }, confidence: 0.99 },
      { type: 'html-comment', pattern: 'Shopify', confidence: 0.7 },
      { type: 'header', key: 'x-shopify-stage', confidence: 0.99 },
      { type: 'cookie', pattern: '_shopify_', confidence: 0.9 },
      { type: 'selector', query: 'link[href*="cdn.shopify.com"]', confidence: 0.95 },
    ],
    apiEndpoints: ['/products.json', '/collections.json'],
  },
  wordpress: {
    category: 'cms',
    signals: [
      { type: 'meta-tag', match: { name: 'generator', content: /WordPress/i }, confidence: 0.99 },
      { type: 'html-comment', pattern: '<!-- wp-', confidence: 0.9 },
      { type: 'script-src', pattern: 'wp-content', confidence: 0.85 },
      { type: 'script-src', pattern: 'wp-includes', confidence: 0.85 },
      { type: 'selector', query: 'link[href*="wp-content"]', confidence: 0.9 },
      { type: 'header', key: 'x-powered-by', pattern: /WordPress/i, confidence: 0.8 },
    ],
    apiEndpoints: ['/wp-json/wp/v2/posts?per_page=100', '/wp-json/wp/v2/pages?per_page=100'],
  },
  woocommerce: {
    category: 'ecommerce',
    signals: [
      { type: 'selector', query: '.woocommerce', confidence: 0.9 },
      { type: 'script-src', pattern: 'woocommerce', confidence: 0.85 },
      { type: 'selector', query: '[class*="wc-"]', confidence: 0.7 },
    ],
    apiEndpoints: ['/wp-json/wc/v3/products'],
    inherits: 'wordpress',
  },
  magento: {
    category: 'ecommerce',
    signals: [
      { type: 'cookie', pattern: 'PHPSESSID', confidence: 0.3 },
      { type: 'selector', query: 'script[src*="mage/"]', confidence: 0.9 },
      { type: 'html-comment', pattern: 'Magento', confidence: 0.8 },
      { type: 'header', key: 'x-magento-vary', confidence: 0.99 },
    ],
    apiEndpoints: ['/rest/V1/products?searchCriteria[pageSize]=50'],
  },
  nextjs: {
    category: 'framework',
    signals: [
      { type: 'selector', query: '#__next', confidence: 0.95 },
      { type: 'selector', query: 'script#__NEXT_DATA__', confidence: 0.99 },
      { type: 'header', key: 'x-nextjs-cache', confidence: 0.95 },
    ],
    apiEndpoints: [],
  },
  nuxt: {
    category: 'framework',
    signals: [
      { type: 'selector', query: '#__nuxt', confidence: 0.95 },
      { type: 'selector', query: 'script:contains("__NUXT__")', confidence: 0.99 },
    ],
  },
  gatsby: {
    category: 'static-gen',
    signals: [
      { type: 'selector', query: '#___gatsby', confidence: 0.95 },
      { type: 'selector', query: 'script[src*="/page-data/"]', confidence: 0.9 },
    ],
    apiEndpoints: [],
  },
  react: {
    category: 'framework',
    signals: [
      { type: 'selector', query: '[data-reactroot]', confidence: 0.95 },
      { type: 'selector', query: '[data-reactid]', confidence: 0.9 },
      // NOTE: NO html.includes('react') — known false positive. Only check DOM attributes.
    ],
  },
  vue: {
    category: 'framework',
    signals: [
      { type: 'selector', query: '[data-v-]', confidence: 0.9 },
      { type: 'selector', query: '#app[data-server-rendered]', confidence: 0.85 },
      // NOTE: NO html.includes('vue') — known false positive.
    ],
  },
  angular: {
    category: 'framework',
    signals: [
      { type: 'selector', query: '[ng-version]', confidence: 0.95 },
      { type: 'selector', query: 'app-root', confidence: 0.8 },
    ],
  },
  squarespace: {
    category: 'cms',
    signals: [
      { type: 'html-comment', pattern: 'Squarespace', confidence: 0.95 },
      { type: 'script-src', pattern: 'squarespace.com', confidence: 0.9 },
    ],
  },
  wix: {
    category: 'cms',
    signals: [
      { type: 'meta-tag', match: { name: 'generator', content: /Wix/i }, confidence: 0.99 },
      { type: 'script-src', pattern: 'static.wixstatic.com', confidence: 0.95 },
    ],
  },
};

const DEFAULT_CONFIG: PlatformDetectorConfig = {
  minConfidence: 0.3,
  enableApiProbing: true,
  apiProbeTimeout: 5000,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract HTML comments from raw HTML string.
 * Returns an array of comment content strings.
 */
function extractHtmlComments(html: string): string[] {
  const comments: string[] = [];
  const regex = /<!--([\s\S]*?)-->/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    comments.push(match[1]);
  }
  return comments;
}

// ─── PlatformDetector Class ──────────────────────────────────────────────────

/**
 * Detects the CMS, framework, or ecommerce platform powering a website
 * using multi-signal pattern matching against a database of 12+ platforms.
 *
 * Three detection modes:
 * - detect(html, $?) — sync, HTML signal matching only
 * - detectWithContext(html, context, $?) — sync, adds HTTP header + cookie checking
 * - probeApis(baseUrl, adapter) — async, hits known API endpoints via HttpAdapter
 */
export class PlatformDetector {
  private readonly config: PlatformDetectorConfig;

  constructor(config?: Partial<PlatformDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Detect platform from HTML + optional cheerio DOM.
   * Checks meta-tags, script-src, html-comments, and CSS selectors.
   */
  detect(html: string, $?: cheerio.CheerioAPI): PlatformResult {
    return this.detectWithContext(html, {}, $);
  }

  /**
   * Detect platform with additional HTTP context (headers, cookies).
   * Checks all HTML signals plus header and cookie signals.
   */
  detectWithContext(
    html: string,
    context: { headers?: Record<string, string>; cookies?: string[] },
    $?: cheerio.CheerioAPI,
  ): PlatformResult {
    const safeHtml = html ?? '';
    const dom = $ ?? cheerio.load(safeHtml);
    const comments = extractHtmlComments(safeHtml);
    const headers = context.headers ?? {};
    const cookies = context.cookies ?? [];

    // Collect all signals per platform
    const platformMatches: Record<string, { confidence: number; signals: PlatformSignal[] }> = {};

    for (const [platformName, pattern] of Object.entries(PLATFORM_PATTERNS)) {
      const signals = this.matchSignals(dom, safeHtml, comments, headers, cookies, pattern.signals);
      if (signals.length > 0) {
        const maxConfidence = Math.max(...signals.map((s) => s.confidence));
        platformMatches[platformName] = { confidence: maxConfidence, signals };
      }
    }

    // Handle inheritance: if a child platform (e.g., woocommerce) matches AND its
    // parent (wordpress) also matches, prefer the child (more specific).
    // Remove parent from candidates when child overrides it.
    for (const [platformName, pattern] of Object.entries(PLATFORM_PATTERNS)) {
      if (pattern.inherits && platformMatches[platformName] && platformMatches[pattern.inherits]) {
        delete platformMatches[pattern.inherits];
      }
    }

    // Pick the platform with the highest confidence
    let bestPlatform: string | undefined;
    let bestConfidence = 0;
    let bestSignals: PlatformSignal[] = [];

    for (const [platformName, match] of Object.entries(platformMatches)) {
      if (match.confidence > bestConfidence) {
        bestPlatform = platformName;
        bestConfidence = match.confidence;
        bestSignals = match.signals;
      }
    }

    // Apply minConfidence threshold
    if (bestConfidence < this.config.minConfidence) {
      bestPlatform = undefined;
      bestConfidence = 0;
      bestSignals = [];
    }

    const category = bestPlatform ? PLATFORM_PATTERNS[bestPlatform].category : ('unknown' as const);
    const apiEndpoints = bestPlatform ? PLATFORM_PATTERNS[bestPlatform].apiEndpoints : undefined;

    log.debug('Platform detection complete', {
      platform: bestPlatform ?? 'unknown',
      category,
      confidence: bestConfidence,
      signalCount: bestSignals.length,
    });

    return {
      platform: bestPlatform,
      category,
      confidence: bestConfidence,
      signals: bestSignals,
      apiEndpoints,
    };
  }

  /**
   * Probe known API endpoints to detect platform (A2-b).
   * Requires HTTP access via HttpAdapter (SSRF protected).
   */
  async probeApis(baseUrl: string, adapter: HttpAdapter): Promise<PlatformResult> {
    const allSignals: PlatformSignal[] = [];
    let bestPlatform: string | undefined;
    let bestConfidence = 0;

    for (const [platformName, pattern] of Object.entries(PLATFORM_PATTERNS)) {
      if (!pattern.apiEndpoints || pattern.apiEndpoints.length === 0) continue;

      for (const endpoint of pattern.apiEndpoints) {
        const probeUrl = new URL(endpoint, baseUrl).toString();
        try {
          const result = await adapter.fetch(probeUrl);
          if (result.success && result.crawlResult) {
            // Check if the response is valid JSON
            const responseBody = result.crawlResult.html;
            try {
              JSON.parse(responseBody);
              // Valid JSON response from a known API endpoint — strong signal
              const signal: PlatformSignal = {
                type: 'api-probe',
                pattern: endpoint,
                confidence: 0.95,
              };
              allSignals.push(signal);
              if (signal.confidence > bestConfidence) {
                bestPlatform = platformName;
                bestConfidence = signal.confidence;
              }
            } catch {
              // Response is not JSON — not a valid API response, skip
            }
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          log.debug('API probe failed', { probeUrl, error: message });
        }
      }
    }

    if (bestConfidence < this.config.minConfidence) {
      bestPlatform = undefined;
      bestConfidence = 0;
    }

    const category = bestPlatform ? PLATFORM_PATTERNS[bestPlatform].category : ('unknown' as const);
    const apiEndpoints = bestPlatform ? PLATFORM_PATTERNS[bestPlatform].apiEndpoints : undefined;

    log.debug('API probing complete', {
      platform: bestPlatform ?? 'unknown',
      confidence: bestConfidence,
      probeCount: allSignals.length,
    });

    return {
      platform: bestPlatform,
      category,
      confidence: bestConfidence,
      signals: allSignals,
      apiEndpoints,
    };
  }

  // ─── Private Signal Matching ─────────────────────────────────────────────

  /**
   * Match a platform's signal definitions against the page content and context.
   * Returns only the signals that matched.
   */
  private matchSignals(
    $: cheerio.CheerioAPI,
    html: string,
    comments: string[],
    headers: Record<string, string>,
    cookies: string[],
    signalDefs: PlatformPatternSignal[],
  ): PlatformSignal[] {
    const matched: PlatformSignal[] = [];

    for (const signal of signalDefs) {
      const result = this.matchSingleSignal($, html, comments, headers, cookies, signal);
      if (result) {
        matched.push(result);
      }
    }

    return matched;
  }

  /**
   * Match a single signal definition against the page.
   * Returns a PlatformSignal if matched, undefined otherwise.
   */
  private matchSingleSignal(
    $: cheerio.CheerioAPI,
    html: string,
    comments: string[],
    headers: Record<string, string>,
    cookies: string[],
    signal: PlatformPatternSignal,
  ): PlatformSignal | undefined {
    switch (signal.type) {
      case 'meta-tag':
        return this.matchMetaTag($, signal);
      case 'script-src':
        return this.matchScriptSrc($, signal);
      case 'html-comment':
        return this.matchHtmlComment(comments, signal);
      case 'selector':
        return this.matchSelector($, signal);
      case 'header':
        return this.matchHeader(headers, signal);
      case 'cookie':
        return this.matchCookie(cookies, signal);
      default:
        return undefined;
    }
  }

  private matchMetaTag(
    $: cheerio.CheerioAPI,
    signal: PlatformPatternSignal,
  ): PlatformSignal | undefined {
    if (!signal.match) return undefined;

    const { name, content } = signal.match;

    // Find meta tags matching the criteria
    let found = false;
    let matchedPattern = '';

    $('meta').each((_i, el) => {
      if (found) return;

      const metaName = $(el).attr('name');
      const metaContent = $(el).attr('content');

      if (name && metaName?.toLowerCase() !== name.toLowerCase()) return;

      if (content === undefined) {
        // Just check the name exists
        if (name && metaName) {
          found = true;
          matchedPattern = `meta[name="${metaName}"]`;
        }
      } else if (typeof content === 'string') {
        if (metaContent?.includes(content)) {
          found = true;
          matchedPattern = `meta[name="${metaName}"] content="${metaContent}"`;
        }
      } else if (content instanceof RegExp) {
        if (metaContent && content.test(metaContent)) {
          found = true;
          matchedPattern = `meta[name="${metaName}"] content="${metaContent}"`;
        }
      }
    });

    if (!found) return undefined;

    return {
      type: 'meta-tag',
      pattern: matchedPattern,
      confidence: signal.confidence,
    };
  }

  private matchScriptSrc(
    $: cheerio.CheerioAPI,
    signal: PlatformPatternSignal,
  ): PlatformSignal | undefined {
    if (!signal.pattern || typeof signal.pattern !== 'string') return undefined;

    const pat = signal.pattern;
    let found = false;
    $('script[src]').each((_i, el) => {
      if (found) return;
      const src = $(el).attr('src');
      if (src && src.includes(pat)) {
        found = true;
      }
    });

    if (!found) return undefined;

    return {
      type: 'script-src',
      pattern: pat,
      confidence: signal.confidence,
    };
  }

  private matchHtmlComment(
    comments: string[],
    signal: PlatformPatternSignal,
  ): PlatformSignal | undefined {
    if (!signal.pattern || typeof signal.pattern !== 'string') return undefined;

    const pat = signal.pattern;
    const found = comments.some((c) => c.includes(pat));
    if (!found) return undefined;

    return {
      type: 'html-comment',
      pattern: pat,
      confidence: signal.confidence,
    };
  }

  private matchSelector(
    $: cheerio.CheerioAPI,
    signal: PlatformPatternSignal,
  ): PlatformSignal | undefined {
    if (!signal.query) return undefined;

    // cheerio :contains() pseudo-selector works for text content matching
    const count = $(signal.query).length;
    if (count === 0) return undefined;

    return {
      type: 'selector',
      pattern: signal.query,
      confidence: signal.confidence,
    };
  }

  private matchHeader(
    headers: Record<string, string>,
    signal: PlatformPatternSignal,
  ): PlatformSignal | undefined {
    if (!signal.key) return undefined;

    // Headers are case-insensitive — normalize to lowercase
    const normalizedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      normalizedHeaders[key.toLowerCase()] = value;
    }

    const headerValue = normalizedHeaders[signal.key.toLowerCase()];
    if (headerValue === undefined) return undefined;

    // If pattern is specified, check it matches the value
    if (signal.pattern !== undefined) {
      if (typeof signal.pattern === 'string') {
        if (!headerValue.includes(signal.pattern)) return undefined;
      } else {
        if (!signal.pattern.test(headerValue)) return undefined;
      }
    }

    return {
      type: 'header',
      pattern: `${signal.key}: ${headerValue}`,
      confidence: signal.confidence,
    };
  }

  private matchCookie(
    cookies: string[],
    signal: PlatformPatternSignal,
  ): PlatformSignal | undefined {
    if (!signal.pattern || typeof signal.pattern !== 'string') return undefined;

    const pat = signal.pattern;
    const found = cookies.some((c) => c.includes(pat));
    if (!found) return undefined;

    return {
      type: 'cookie',
      pattern: pat,
      confidence: signal.confidence,
    };
  }
}
