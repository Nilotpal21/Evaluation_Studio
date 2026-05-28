import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HttpAdapter, HttpFetchResult } from '../../intelligence/algorithms/http-adapter.js';
import type { CrawlResultLink } from '../../intelligence/algorithms/types.js';
import { DiscoveryChain } from '../../intelligence/algorithms/discovery-chain.js';

/**
 * Create a mock HttpAdapter with a configurable fetch function.
 * All tests use this — no real HTTP calls.
 */
function createMockAdapter(fetchFn: (url: string) => Promise<HttpFetchResult>): HttpAdapter {
  return { fetch: vi.fn(fetchFn) } as unknown as HttpAdapter;
}

/** Helper: build a successful HttpFetchResult with HTML content */
function successResult(url: string, html: string, links: CrawlResultLink[] = []): HttpFetchResult {
  return {
    success: true,
    crawlResult: {
      url,
      statusCode: 200,
      title: 'Page',
      html,
      text: '',
      links,
      metadata: {},
      crawledAt: new Date().toISOString(),
      duration: 50,
      success: true,
      contentLength: html.length,
      contentType: 'text/html',
      depth: 0,
    },
    statusCode: 200,
    duration: 50,
  };
}

/** Helper: build a failed HttpFetchResult */
function failResult(): HttpFetchResult {
  return {
    success: false,
    error: 'HTTP 404',
    statusCode: 404,
    duration: 20,
  };
}

describe('DiscoveryChain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Step 1: Platform API ─────────────────────────────────────────

  describe('platform API discovery', () => {
    it('extracts product URLs from Shopify /products.json response', async () => {
      const shopifyJson = JSON.stringify({
        products: [{ handle: 'blue-widget' }, { handle: 'red-widget' }, { handle: 'green-widget' }],
      });

      const adapter = createMockAdapter(async (url) => {
        if (url.includes('/products.json')) {
          return successResult(url, shopifyJson);
        }
        return failResult();
      });

      const chain = new DiscoveryChain(adapter, { minUrls: 1 });
      const result = await chain.discover('https://shop.example.com', {
        apiEndpoints: ['/products.json'],
      });

      expect(result.urls).toContain('https://shop.example.com/products/blue-widget');
      expect(result.urls).toContain('https://shop.example.com/products/red-widget');
      expect(result.urls).toContain('https://shop.example.com/products/green-widget');
      expect(result.urls).toHaveLength(3);

      const apiStep = result.steps.find((s) => s.method === 'platform-api');
      expect(apiStep).toBeDefined();
      expect(apiStep?.urlsFound).toBe(3);
    });

    it('extracts post URLs from WordPress /wp-json response', async () => {
      const wpJson = JSON.stringify([
        { link: 'https://blog.example.com/hello-world' },
        { link: 'https://blog.example.com/second-post' },
      ]);

      const adapter = createMockAdapter(async (url) => {
        if (url.includes('/wp-json')) {
          return successResult(url, wpJson);
        }
        return failResult();
      });

      const chain = new DiscoveryChain(adapter, { minUrls: 1 });
      const result = await chain.discover('https://blog.example.com', {
        apiEndpoints: ['/wp-json/wp/v2/posts'],
      });

      expect(result.urls).toContain('https://blog.example.com/hello-world');
      expect(result.urls).toContain('https://blog.example.com/second-post');
      expect(result.urls).toHaveLength(2);
    });

    it('handles malformed JSON in API response gracefully', async () => {
      const adapter = createMockAdapter(async (url) => {
        if (url.includes('/products.json')) {
          return successResult(url, 'not valid json {{{');
        }
        // Entry page with no links
        return successResult(url, '<html><body>Empty</body></html>');
      });

      const chain = new DiscoveryChain(adapter);
      const result = await chain.discover('https://shop.example.com', {
        apiEndpoints: ['/products.json'],
      });

      // Should not crash, just find 0 from API step
      const apiStep = result.steps.find((s) => s.method === 'platform-api');
      expect(apiStep).toBeDefined();
      expect(apiStep?.urlsFound).toBe(0);
    });
  });

  // ─── Step 2: Footer Mining ────────────────────────────────────────

  describe('footer mining', () => {
    it('extracts links from footer and sitemap page', async () => {
      const entryHtml = `<html><body>
        <footer>
          <a href="/about">About</a>
          <a href="/site-map">Site Map</a>
        </footer>
      </body></html>`;

      const sitemapHtml = '<html><body>Sitemap page</body></html>';
      const sitemapLinks: CrawlResultLink[] = [
        { text: 'Product A', href: 'https://example.com/product-a' },
        { text: 'Product B', href: 'https://example.com/product-b' },
        { text: 'External', href: 'https://other.com/page' },
      ];

      const adapter = createMockAdapter(async (url) => {
        if (url === 'https://example.com') {
          return successResult(url, entryHtml);
        }
        if (url.includes('/site-map')) {
          return successResult(url, sitemapHtml, sitemapLinks);
        }
        return failResult();
      });

      const chain = new DiscoveryChain(adapter, { minUrls: 1, enableCdx: false });
      const result = await chain.discover('https://example.com');

      expect(result.urls).toContain('https://example.com/product-a');
      expect(result.urls).toContain('https://example.com/product-b');
      // External link should be filtered out
      expect(result.urls).not.toContain('https://other.com/page');

      const footerStep = result.steps.find((s) => s.method === 'footer-mining');
      expect(footerStep).toBeDefined();
    });

    it('continues to next step when /site-map returns 404', async () => {
      const entryHtml = `<html><body>
        <nav><a href="/products">Products</a></nav>
        <footer><a href="/contact">Contact</a></footer>
      </body></html>`;

      const productLinks: CrawlResultLink[] = [
        { text: 'Item 1', href: 'https://example.com/item-1' },
      ];

      const adapter = createMockAdapter(async (url) => {
        if (url === 'https://example.com') {
          return successResult(url, entryHtml);
        }
        if (url.includes('/products')) {
          return successResult(url, '<html><body>Products</body></html>', productLinks);
        }
        return failResult();
      });

      const chain = new DiscoveryChain(adapter, { minUrls: 100, enableCdx: false });
      const result = await chain.discover('https://example.com');

      // Should still have nav-bfs step
      const navStep = result.steps.find((s) => s.method === 'nav-bfs');
      expect(navStep).toBeDefined();
      expect(result.urls).toContain('https://example.com/item-1');
    });
  });

  // ─── Step 3: Nav-BFS ─────────────────────────────────────────────

  describe('nav-BFS', () => {
    it('follows nav links and collects URLs from section pages', async () => {
      const entryHtml = `<html><body>
        <nav>
          <a href="/category-a">Category A</a>
          <a href="/category-b">Category B</a>
        </nav>
      </body></html>`;

      const catALinks: CrawlResultLink[] = [
        { text: 'Item 1', href: 'https://example.com/item-1' },
        { text: 'Item 2', href: 'https://example.com/item-2' },
      ];
      const catBLinks: CrawlResultLink[] = [
        { text: 'Item 3', href: 'https://example.com/item-3' },
        { text: 'External', href: 'https://other.com/nope' },
      ];

      const adapter = createMockAdapter(async (url) => {
        if (url === 'https://example.com') {
          return successResult(url, entryHtml);
        }
        if (url.includes('/category-a')) {
          return successResult(url, '<html></html>', catALinks);
        }
        if (url.includes('/category-b')) {
          return successResult(url, '<html></html>', catBLinks);
        }
        return failResult();
      });

      const chain = new DiscoveryChain(adapter, { minUrls: 100, enableCdx: false });
      const result = await chain.discover('https://example.com');

      expect(result.urls).toContain('https://example.com/item-1');
      expect(result.urls).toContain('https://example.com/item-2');
      expect(result.urls).toContain('https://example.com/item-3');
      expect(result.urls).not.toContain('https://other.com/nope');

      const navStep = result.steps.find((s) => s.method === 'nav-bfs');
      expect(navStep).toBeDefined();
      expect(navStep!.urlsFound).toBeGreaterThanOrEqual(3);
    });

    it('caps section pages at 10', async () => {
      // Create 15 nav links
      const navLinks = Array.from(
        { length: 15 },
        (_, i) => `<a href="/section-${i}">Section ${i}</a>`,
      ).join('');
      const entryHtml = `<html><body><nav>${navLinks}</nav></body></html>`;

      const fetchCalls: string[] = [];
      const adapter = createMockAdapter(async (url) => {
        fetchCalls.push(url);
        if (url === 'https://example.com') {
          return successResult(url, entryHtml);
        }
        return successResult(url, '<html></html>', [
          { text: 'Link', href: `https://example.com/from-${url.split('/').pop()}` },
        ]);
      });

      const chain = new DiscoveryChain(adapter, { minUrls: 100, enableCdx: false });
      await chain.discover('https://example.com');

      // Entry page + 4 sitemap probes + 10 nav sections = 15
      // Should NOT have fetched all 15 nav sections
      const sectionFetches = fetchCalls.filter((u) => u.includes('/section-'));
      expect(sectionFetches).toHaveLength(10);
    });
  });

  // ─── Step 4: CDX Bootstrap ────────────────────────────────────────

  describe('CDX bootstrap', () => {
    it('extracts URLs from CDX JSON array response', async () => {
      const cdxJson = JSON.stringify([
        ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
        ['com,example)/', '20230101', 'https://example.com/', 'text/html', '200', 'ABC', '1234'],
        [
          'com,example)/about',
          '20230102',
          'https://example.com/about',
          'text/html',
          '200',
          'DEF',
          '5678',
        ],
        [
          'com,example)/products',
          '20230103',
          'https://example.com/products',
          'text/html',
          '200',
          'GHI',
          '9012',
        ],
      ]);

      const adapter = createMockAdapter(async (url) => {
        if (url.includes('web.archive.org/cdx')) {
          return successResult(url, cdxJson);
        }
        // Entry page with no useful content
        return successResult(url, '<html><body>Nothing</body></html>');
      });

      const chain = new DiscoveryChain(adapter, { minUrls: 100 });
      const result = await chain.discover('https://example.com');

      expect(result.urls).toContain('https://example.com/');
      expect(result.urls).toContain('https://example.com/about');
      expect(result.urls).toContain('https://example.com/products');

      const cdxStep = result.steps.find((s) => s.method === 'cdx');
      expect(cdxStep).toBeDefined();
      expect(cdxStep!.urlsFound).toBe(3);
    });

    it('handles CDX timeout gracefully — step skipped, other steps work', async () => {
      const adapter = createMockAdapter(async (url) => {
        if (url.includes('web.archive.org/cdx')) {
          throw new Error('Request timeout');
        }
        const links: CrawlResultLink[] = [{ text: 'Page', href: 'https://example.com/from-entry' }];
        return successResult(
          url,
          '<html><body><footer><a href="/footer-link">FL</a></footer></body></html>',
          links,
        );
      });

      const chain = new DiscoveryChain(adapter, { minUrls: 100 });
      const result = await chain.discover('https://example.com');

      // CDX step should be recorded with 0 URLs and details
      const cdxStep = result.steps.find((s) => s.method === 'cdx');
      expect(cdxStep).toBeDefined();
      expect(cdxStep!.urlsFound).toBe(0);
      expect(cdxStep!.details).toContain('timeout or unavailable');

      // Other steps should still produce URLs
      expect(result.steps.length).toBeGreaterThan(1);
    });

    it('skips CDX when enableCdx is false', async () => {
      const adapter = createMockAdapter(async (url) => {
        return successResult(url, '<html><body>No content</body></html>');
      });

      const chain = new DiscoveryChain(adapter, { enableCdx: false });
      const result = await chain.discover('https://example.com');

      const cdxStep = result.steps.find((s) => s.method === 'cdx');
      expect(cdxStep).toBeUndefined();
    });
  });

  // ─── Early Stop ───────────────────────────────────────────────────

  describe('early stop', () => {
    it('stops after platform API when >= minUrls found', async () => {
      const products = Array.from({ length: 50 }, (_, i) => ({ handle: `product-${i}` }));
      const shopifyJson = JSON.stringify({ products });

      const fetchCalls: string[] = [];
      const adapter = createMockAdapter(async (url) => {
        fetchCalls.push(url);
        if (url.includes('/products.json')) {
          return successResult(url, shopifyJson);
        }
        return failResult();
      });

      const chain = new DiscoveryChain(adapter, { minUrls: 20 });
      const result = await chain.discover('https://shop.example.com', {
        apiEndpoints: ['/products.json'],
      });

      expect(result.urls.length).toBe(50);
      // Should only have platform-api step — no footer, nav, cdx, entry
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].method).toBe('platform-api');

      // Should not have fetched entry page or any other URLs
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]).toContain('/products.json');
    });
  });

  // ─── Empty Site ───────────────────────────────────────────────────

  describe('empty site', () => {
    it('returns empty URLs and records all steps when nothing found', async () => {
      const adapter = createMockAdapter(async () => {
        return successResult('https://empty.example.com', '<html><body></body></html>');
      });

      const chain = new DiscoveryChain(adapter, { enableCdx: false });
      const result = await chain.discover('https://empty.example.com');

      expect(result.urls).toHaveLength(0);
      expect(result.steps.length).toBeGreaterThan(0);
      expect(result.method).toBe('none');

      // All steps should report 0 URLs
      for (const step of result.steps) {
        expect(step.urlsFound).toBe(0);
      }
    });
  });

  // ─── Entry Page Links Fallback ────────────────────────────────────

  describe('entry page links fallback', () => {
    it('uses entry page links when all other steps find nothing', async () => {
      const entryLinks: CrawlResultLink[] = [
        { text: 'Page A', href: 'https://example.com/page-a' },
        { text: 'Page B', href: 'https://example.com/page-b' },
        { text: 'External', href: 'https://other.com/ext' },
      ];

      const adapter = createMockAdapter(async (url) => {
        if (url === 'https://example.com') {
          return successResult(url, '<html><body>Main page</body></html>', entryLinks);
        }
        return failResult();
      });

      const chain = new DiscoveryChain(adapter, { minUrls: 100, enableCdx: false });
      const result = await chain.discover('https://example.com');

      expect(result.urls).toContain('https://example.com/page-a');
      expect(result.urls).toContain('https://example.com/page-b');
      expect(result.urls).not.toContain('https://other.com/ext');

      const entryStep = result.steps.find((s) => s.method === 'entry-links');
      expect(entryStep).toBeDefined();
      expect(entryStep!.urlsFound).toBe(2);
    });
  });

  // ─── Hostname Filtering ──────────────────────────────────────────

  describe('hostname filtering', () => {
    it('filters all URLs to same hostname across all steps', async () => {
      const entryHtml = `<html><body>
        <nav><a href="/local">Local</a></nav>
        <footer><a href="https://other.com/ext">External</a></footer>
      </body></html>`;

      const navLinks: CrawlResultLink[] = [
        { text: 'Same', href: 'https://example.com/same' },
        { text: 'Diff', href: 'https://different.com/page' },
      ];

      const adapter = createMockAdapter(async (url) => {
        if (url === 'https://example.com') {
          return successResult(url, entryHtml);
        }
        if (url.includes('/local')) {
          return successResult(url, '<html></html>', navLinks);
        }
        return failResult();
      });

      const chain = new DiscoveryChain(adapter, { minUrls: 100, enableCdx: false });
      const result = await chain.discover('https://example.com');

      // Every URL in result should be same hostname
      for (const url of result.urls) {
        expect(new URL(url).hostname).toBe('example.com');
      }
    });
  });

  // ─── Config Overrides ─────────────────────────────────────────────

  describe('config overrides', () => {
    it('respects custom minUrls and maxUrls', async () => {
      // Generate 100 links on entry page
      const links: CrawlResultLink[] = Array.from({ length: 100 }, (_, i) => ({
        text: `Link ${i}`,
        href: `https://example.com/page-${i}`,
      }));

      const adapter = createMockAdapter(async (url) => {
        if (url === 'https://example.com') {
          return successResult(url, '<html><body>Entry</body></html>', links);
        }
        return failResult();
      });

      const chain = new DiscoveryChain(adapter, {
        minUrls: 5,
        maxUrls: 10,
        enableCdx: false,
      });
      const result = await chain.discover('https://example.com');

      // Should have capped at maxUrls=10
      expect(result.urls.length).toBeLessThanOrEqual(10);
    });
  });

  // ─── URL Deduplication ────────────────────────────────────────────

  describe('URL deduplication', () => {
    it('deduplicates URLs across multiple steps', async () => {
      const sharedUrl = 'https://example.com/shared';

      const entryHtml = `<html><body>
        <nav><a href="/section">Section</a></nav>
        <footer><a href="${sharedUrl}">Shared</a></footer>
      </body></html>`;

      const sectionLinks: CrawlResultLink[] = [
        { text: 'Shared', href: sharedUrl },
        { text: 'Unique', href: 'https://example.com/unique' },
      ];

      const entryLinks: CrawlResultLink[] = [
        { text: 'Shared', href: sharedUrl },
        { text: 'Entry Only', href: 'https://example.com/entry-only' },
      ];

      const adapter = createMockAdapter(async (url) => {
        if (url === 'https://example.com') {
          return successResult(url, entryHtml, entryLinks);
        }
        if (url.includes('/section')) {
          return successResult(url, '<html></html>', sectionLinks);
        }
        return failResult();
      });

      const chain = new DiscoveryChain(adapter, { minUrls: 100, enableCdx: false });
      const result = await chain.discover('https://example.com');

      // sharedUrl should appear exactly once
      const sharedCount = result.urls.filter((u) => u === sharedUrl).length;
      expect(sharedCount).toBe(1);
    });
  });

  // ─── Stats and Audit Trail ────────────────────────────────────────

  describe('stats and audit trail', () => {
    it('records correct stats with urlsPerStep', async () => {
      const entryHtml = `<html><body>
        <nav><a href="/section">Section</a></nav>
      </body></html>`;

      const sectionLinks: CrawlResultLink[] = [
        { text: 'A', href: 'https://example.com/a' },
        { text: 'B', href: 'https://example.com/b' },
      ];

      const adapter = createMockAdapter(async (url) => {
        if (url === 'https://example.com') {
          return successResult(url, entryHtml);
        }
        if (url.includes('/section')) {
          return successResult(url, '<html></html>', sectionLinks);
        }
        return failResult();
      });

      const chain = new DiscoveryChain(adapter, { minUrls: 100, enableCdx: false });
      const result = await chain.discover('https://example.com');

      expect(result.stats.totalSteps).toBe(result.steps.length);
      expect(result.stats.totalDuration).toBeGreaterThanOrEqual(0);
      expect(typeof result.stats.urlsPerStep).toBe('object');

      // method should reflect best step
      expect(typeof result.method).toBe('string');
    });
  });

  // ─── Invalid Base URL ─────────────────────────────────────────────

  describe('invalid base URL', () => {
    it('returns empty result for invalid URL', async () => {
      const adapter = createMockAdapter(async () => failResult());

      const chain = new DiscoveryChain(adapter);
      const result = await chain.discover('not a valid url');

      expect(result.urls).toHaveLength(0);
      expect(result.steps).toHaveLength(0);
      expect(result.method).toBe('none');
    });
  });

  // ─── Entry Page Fetch Failure ─────────────────────────────────────

  describe('entry page fetch failure', () => {
    it('skips footer/nav/entry steps when entry page fails', async () => {
      const cdxJson = JSON.stringify([
        ['urlkey', 'timestamp', 'original'],
        ['com,example)/', '20230101', 'https://example.com/archived'],
      ]);

      const adapter = createMockAdapter(async (url) => {
        if (url.includes('web.archive.org/cdx')) {
          return successResult(url, cdxJson);
        }
        return failResult();
      });

      const chain = new DiscoveryChain(adapter, { enableCdx: true });
      const result = await chain.discover('https://example.com');

      // Should still have CDX step
      const cdxStep = result.steps.find((s) => s.method === 'cdx');
      expect(cdxStep).toBeDefined();
      expect(result.urls).toContain('https://example.com/archived');

      // No footer-mining, nav-bfs, or entry-links steps
      expect(result.steps.find((s) => s.method === 'footer-mining')).toBeUndefined();
      expect(result.steps.find((s) => s.method === 'nav-bfs')).toBeUndefined();
      expect(result.steps.find((s) => s.method === 'entry-links')).toBeUndefined();
    });
  });
});
