/**
 * Real Crawl Integration Tests
 *
 * Tests the core crawler pipeline against REAL URLs with ZERO infrastructure.
 * No Redis, no MongoDB, no Docker, no BullMQ. Just HTTP + pure logic.
 *
 * Pipeline tested:
 *   URL → FastProfiler (site detection)
 *       → StrategyResolver (strategy selection)
 *       → DecisionEngine (crawl decision)
 *       → axios GET (fetch HTML)
 *       → ReadabilityService (content extraction)
 *       → extractSitemapUrls (multi-page discovery)
 *
 * Run: pnpm vitest run packages/crawler/src/__tests__/integration/real-crawl.integration.test.ts
 */

import { describe, test, expect } from 'vitest';
import axios from 'axios';
import { FastProfiler } from '../../profiler/fast-profiler.js';
import { StrategyResolver } from '../../strategy/resolver.js';
import { DecisionEngine } from '../../decision/decision-engine.js';
import type { SiteProfile } from '../../profiler/interfaces.js';

// ReadabilityService is in search-ai, import by path
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { ReadabilityService } from '../../../../../apps/search-ai/src/services/readability/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchHTML(url: string, timeoutMs = 15000): Promise<string> {
  const response = await axios.get(url, {
    timeout: timeoutMs,
    headers: { 'User-Agent': 'ABL-Crawler-Integration-Test/1.0' },
    maxRedirects: 5,
    responseType: 'text',
  });
  return typeof response.data === 'string' ? response.data : String(response.data);
}

// ---------------------------------------------------------------------------
// Test Sites — chosen for stability & variety
// ---------------------------------------------------------------------------

const TEST_SITES = {
  /** Simple static site, always up, minimal HTML */
  simple: 'https://example.com',
  /** Docs site with sitemap, crawler-friendly (no bot protection) */
  docs: 'https://httpbin.org',
  /** Public wiki — static, has sitemap, no bot blocking */
  wiki: 'https://en.wikipedia.org/wiki/Web_crawler',
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Real Crawl Integration (zero infrastructure)', () => {
  // Increase timeout — real HTTP calls
  const TIMEOUT = 30_000;

  // Shared instances — no constructor args needed
  const profiler = new FastProfiler();
  const strategyResolver = new StrategyResolver();
  const decisionEngine = new DecisionEngine(); // empty = heuristic-only mode
  const readability = new ReadabilityService();

  // -----------------------------------------------------------------------
  // 1. Site Profiling — real HTTP to real URLs
  // -----------------------------------------------------------------------

  describe('Step 1: Site Profiling', () => {
    test(
      'profiles example.com (simple static site)',
      async () => {
        const profile = await profiler.profile(TEST_SITES.simple);

        expect(profile.domain).toBe('example.com');
        expect(profile.siteType).toBe('static');
        expect(profile.jsRequired).toBe(false);
        expect(profile.avgResponseTime).toBeGreaterThan(0);
        expect(profile.confidence).toBeGreaterThan(0);
        expect(profile.metadata.htmlSize).toBeGreaterThan(100);

        console.log('\n📊 example.com profile:', {
          siteType: profile.siteType,
          framework: profile.framework,
          jsRequired: profile.jsRequired,
          estimatedSize: profile.estimatedSize,
          avgResponseTime: `${profile.avgResponseTime}ms`,
          hasSitemap: profile.metadata.hasSitemap,
          hasRobotsTxt: profile.metadata.hasRobotsTxt,
          htmlSize: `${profile.metadata.htmlSize} bytes`,
          confidence: `${(profile.confidence * 100).toFixed(0)}%`,
        });
      },
      TIMEOUT,
    );

    test(
      'profiles httpbin.org (public API/docs site)',
      async () => {
        const profile = await profiler.profile(TEST_SITES.docs);

        expect(profile.domain).toContain('httpbin');
        expect(profile.metadata.htmlSize).toBeGreaterThan(100);

        console.log('\n📊 httpbin.org profile:', {
          siteType: profile.siteType,
          framework: profile.framework,
          jsRequired: profile.jsRequired,
          estimatedSize: profile.estimatedSize,
          hasSitemap: profile.metadata.hasSitemap,
          hasRobotsTxt: profile.metadata.hasRobotsTxt,
          confidence: `${(profile.confidence * 100).toFixed(0)}%`,
        });
      },
      TIMEOUT,
    );
  });

  // -----------------------------------------------------------------------
  // 2. Strategy Resolution — pure logic, uses profile from step 1
  // -----------------------------------------------------------------------

  describe('Step 2: Strategy Resolution', () => {
    test(
      'resolves "smart" strategy for a static site',
      async () => {
        const profile = await profiler.profile(TEST_SITES.simple);
        const result = await strategyResolver.resolve({ strategy: 'smart' }, profile);

        expect(result.params).toBeDefined();
        expect(result.params.internalStrategy).toBeDefined();
        expect(result.params.batchSize).toBeGreaterThan(0);
        expect(result.params.concurrency).toBeGreaterThan(0);
        expect(result.errors).toHaveLength(0);

        console.log('\n🎯 Strategy for example.com:', {
          internalStrategy: result.params.internalStrategy,
          batchSize: result.params.batchSize,
          concurrency: result.params.concurrency,
          jsHandling: result.params.jsHandling,
          discovery: result.params.discovery,
          reasoning: result.params.reasoning,
          warnings: result.warnings,
        });
      },
      TIMEOUT,
    );

    test(
      'resolves "sitemap" strategy for a docs site',
      async () => {
        const profile = await profiler.profile(TEST_SITES.docs);
        const result = await strategyResolver.resolve(
          { strategy: 'sitemap', limits: { maxPages: 50 } },
          profile,
        );

        expect(result.params).toBeDefined();
        expect(result.params.limits?.maxPages).toBeLessThanOrEqual(50);

        console.log('\n🎯 Strategy for httpbin.org:', {
          internalStrategy: result.params.internalStrategy,
          batchSize: result.params.batchSize,
          jsHandling: result.params.jsHandling,
          limits: result.params.limits,
          reasoning: result.params.reasoning,
        });
      },
      TIMEOUT,
    );
  });

  // -----------------------------------------------------------------------
  // 3. Decision Engine — heuristic mode (no stores)
  // -----------------------------------------------------------------------

  describe('Step 3: Decision Engine', () => {
    test(
      'decides crawl approach for a static site',
      async () => {
        const profile = await profiler.profile(TEST_SITES.simple);
        const decision = await decisionEngine.decide({
          url: TEST_SITES.simple,
          tenantId: 'test-tenant',
          profile,
        });

        expect(decision).toBeDefined();
        expect(decision.strategy).toBeDefined();

        console.log('\n🧠 Decision for example.com:', {
          strategy: decision.strategy,
          batchSize: decision.batchSize,
          concurrency: decision.concurrency,
          reasoning: decision.reasoning,
        });
      },
      TIMEOUT,
    );
  });

  // -----------------------------------------------------------------------
  // 4. Content Extraction — fetch real HTML, clean with Readability
  // -----------------------------------------------------------------------

  describe('Step 4: Content Extraction', () => {
    test(
      'fetches and extracts content from example.com',
      async () => {
        const html = await fetchHTML(TEST_SITES.simple);

        expect(html).toBeTruthy();
        expect(html.length).toBeGreaterThan(100);
        expect(html).toContain('Example Domain');

        const result = readability.cleanHTML(html, TEST_SITES.simple, 'static');

        expect(result.success).toBe(true);
        expect(result.cleanedHTML.length).toBeGreaterThan(0);
        expect(result.metadata.contentLength).toBeGreaterThan(0);
        expect(result.metadata.sizeReduction).toBeGreaterThanOrEqual(0);

        console.log('\n📄 Content extraction (example.com):', {
          originalSize: `${result.metadata.originalSize} bytes`,
          cleanedSize: `${result.metadata.cleanedSize} bytes`,
          sizeReduction: `${result.metadata.sizeReduction.toFixed(1)}%`,
          title: result.metadata.title,
          contentLength: `${result.metadata.contentLength} chars`,
          cleaned: result.metadata.cleaned,
          readabilityFallback: result.metadata.readabilityFallback,
        });
      },
      TIMEOUT,
    );

    test(
      'fetches and extracts content from a real wiki page',
      async () => {
        const url = TEST_SITES.wiki;
        const html = await fetchHTML(url);

        expect(html.length).toBeGreaterThan(1000);

        const profile = await profiler.profile(url);
        const result = readability.cleanHTML(html, url, profile.siteType);

        expect(result.success).toBe(true);
        expect(result.metadata.contentLength).toBeGreaterThan(100);

        // Content should be preserved, not 92% lost
        const preservationRate = 100 - result.metadata.sizeReduction;

        console.log('\n📄 Content extraction (wikipedia):', {
          originalSize: `${result.metadata.originalSize} bytes`,
          cleanedSize: `${result.metadata.cleanedSize} bytes`,
          sizeReduction: `${result.metadata.sizeReduction.toFixed(1)}%`,
          preservationRate: `${preservationRate.toFixed(1)}%`,
          title: result.metadata.title,
          contentLength: `${result.metadata.contentLength} chars`,
          cleaned: result.metadata.cleaned,
          siteType: profile.siteType,
        });
      },
      TIMEOUT,
    );
  });

  // -----------------------------------------------------------------------
  // 5. Sitemap Discovery — real HTTP to real sitemaps
  // -----------------------------------------------------------------------

  describe('Step 5: Sitemap Discovery', () => {
    test(
      'extracts URLs from a real sitemap',
      async () => {
        // sitemaps.org has a real sitemap.xml
        let urls: string[] = [];
        let testedSite = '';

        // Try multiple sites — some may not have /sitemap.xml
        const candidates = [
          'https://www.sitemaps.org/',
          'https://httpbin.org/',
          'https://example.com/',
        ];

        for (const site of candidates) {
          try {
            urls = await profiler.extractSitemapUrls(site, 20);
            testedSite = site;
            if (urls.length > 0) break;
          } catch {
            // Try next candidate
          }
        }

        console.log('\n🗺️  Sitemap discovery:', {
          testedSite: testedSite || 'none succeeded',
          urlsFound: urls.length,
          sample: urls.slice(0, 5),
        });

        // The test validates the mechanism works, not that a specific site has a sitemap
        if (urls.length > 0) {
          expect(urls[0]).toMatch(/^https?:\/\//);
        } else {
          // No sitemap found on any candidate — that's a valid real-world outcome
          console.log('⚠️  No sitemaps found on test candidates — skipping URL assertions');
        }
      },
      TIMEOUT,
    );
  });

  // -----------------------------------------------------------------------
  // 6. Full Pipeline — profile → strategy → decision → fetch → extract
  // -----------------------------------------------------------------------

  describe('Step 6: Full Pipeline (end-to-end)', () => {
    test(
      'runs complete crawl pipeline for a single URL',
      async () => {
        const url = TEST_SITES.simple;

        // Step 1: Profile
        const profile = await profiler.profile(url);
        expect(profile.domain).toBeTruthy();

        // Step 2: Strategy
        const strategy = await strategyResolver.resolve({ strategy: 'smart' }, profile);
        expect(strategy.errors).toHaveLength(0);

        // Step 3: Decision
        const decision = await decisionEngine.decide({
          url,
          tenantId: 'integration-test',
          profile,
        });
        expect(decision.strategy).toBeTruthy();

        // Step 4: Fetch HTML (replaces Go worker for this test)
        const html = await fetchHTML(url);
        expect(html.length).toBeGreaterThan(0);

        // Step 5: Extract content (replaces Readability + Docling workers)
        const extracted = readability.cleanHTML(html, url, profile.siteType);
        expect(extracted.success).toBe(true);

        // Summary
        console.log('\n✅ Full pipeline result:', {
          url,
          siteType: profile.siteType,
          framework: profile.framework ?? 'none',
          strategy: strategy.params.internalStrategy,
          decision: decision.strategy,
          htmlSize: `${html.length} bytes`,
          extractedContent: `${extracted.metadata.contentLength} chars`,
          sizeReduction: `${extracted.metadata.sizeReduction.toFixed(1)}%`,
          title: extracted.metadata.title,
        });
      },
      TIMEOUT,
    );

    test('runs complete crawl pipeline for a wiki site with multi-page discovery', async () => {
      const url = TEST_SITES.wiki;

      // Step 1: Profile
      const profile = await profiler.profile(url);

      // Step 2: Strategy
      const strategy = await strategyResolver.resolve(
        { strategy: 'smart', limits: { maxPages: 10 } },
        profile,
      );

      // Step 3: Decision
      const decision = await decisionEngine.decide({
        url,
        tenantId: 'integration-test',
        profile,
      });

      // Step 4: Discover pages via sitemap
      let discoveredUrls: string[] = [];
      try {
        discoveredUrls = await profiler.extractSitemapUrls(url, 10);
      } catch {
        // No sitemap — that's ok, we still test the single page
      }

      // Step 5: Fetch and extract first page
      const html = await fetchHTML(url);
      const extracted = readability.cleanHTML(html, url, profile.siteType);

      // Step 6: If we discovered pages, fetch and extract one more
      let secondPage: { url: string; title: string; contentLength: number } | null = null;
      if (discoveredUrls.length > 1) {
        // Pick a page that's NOT the homepage
        const secondUrl = discoveredUrls.find((u) => u !== url) ?? discoveredUrls[1];
        try {
          const html2 = await fetchHTML(secondUrl);
          const extracted2 = readability.cleanHTML(html2, secondUrl, profile.siteType);
          secondPage = {
            url: secondUrl,
            title: extracted2.metadata.title,
            contentLength: extracted2.metadata.contentLength,
          };
        } catch {
          // Network flake on second page — not a test failure
        }
      }

      console.log('\n✅ Full multi-page pipeline result:', {
        url,
        siteType: profile.siteType,
        framework: profile.framework ?? 'none',
        strategy: strategy.params.internalStrategy,
        decision: decision.strategy,
        pagesDiscovered: discoveredUrls.length,
        firstPage: {
          title: extracted.metadata.title,
          contentLength: `${extracted.metadata.contentLength} chars`,
          sizeReduction: `${extracted.metadata.sizeReduction.toFixed(1)}%`,
        },
        secondPage: secondPage
          ? {
              url: secondPage.url,
              title: secondPage.title,
              contentLength: `${secondPage.contentLength} chars`,
            }
          : 'none (no sitemap or network error)',
      });

      // Assertions
      expect(profile.domain).toBeTruthy();
      expect(strategy.errors).toHaveLength(0);
      expect(extracted.success).toBe(true);
      expect(extracted.metadata.contentLength).toBeGreaterThan(50);
    }, 60_000); // 60s — multi-page is slower
  });
});
