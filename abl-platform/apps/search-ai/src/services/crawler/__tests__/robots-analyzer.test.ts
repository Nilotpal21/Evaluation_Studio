import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { analyzeRobotsTxt } from '../robots-analyzer.js';

/**
 * Tests for robots-analyzer.
 *
 * Mocks the global `fetch` since it's an external HTTP call (not a platform component).
 */

const SAMPLE_ROBOTS_TXT = `
User-agent: *
Crawl-delay: 5
Disallow: /private/
Disallow: /admin/
Disallow: /tmp/

Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap-news.xml
`.trim();

const EMPTY_ROBOTS_TXT = '';

const MINIMAL_ROBOTS_TXT = `
User-agent: *
Allow: /
`.trim();

// Save the original fetch before each test
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetchResponse(body: string, status = 200, headers: Record<string, string> = {}): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: vi.fn().mockResolvedValue(body),
    body: null,
  }) as unknown as typeof globalThis.fetch;
}

function mockFetchError(error: Error): void {
  globalThis.fetch = vi.fn().mockRejectedValue(error) as unknown as typeof globalThis.fetch;
}

describe('analyzeRobotsTxt', () => {
  it('parses robots.txt with Crawl-delay and Disallow rules', async () => {
    mockFetchResponse(SAMPLE_ROBOTS_TXT);

    const result = await analyzeRobotsTxt('https://example.com/some/page');

    expect(result.found).toBe(true);
    expect(result.crawlDelay).toBe(5);
    expect(result.disallowedPaths).toContain('/private/');
    expect(result.disallowedPaths).toContain('/admin/');
    expect(result.disallowedPaths).toContain('/tmp/');
    expect(result.sitemapUrls).toContain('https://example.com/sitemap.xml');
    expect(result.sitemapUrls).toContain('https://example.com/sitemap-news.xml');
    expect(result.userAgent).toBe('*');
    expect(result.rawContent).toBeDefined();
  });

  it('returns found: false on 404', async () => {
    mockFetchResponse('Not Found', 404);

    const result = await analyzeRobotsTxt('https://example.com/page');

    expect(result.found).toBe(false);
    expect(result.crawlDelay).toBeNull();
    expect(result.disallowedPaths).toHaveLength(0);
    expect(result.sitemapUrls).toHaveLength(0);
  });

  it('returns found: true with empty arrays for empty robots.txt', async () => {
    mockFetchResponse(EMPTY_ROBOTS_TXT);

    const result = await analyzeRobotsTxt('https://example.com/page');

    expect(result.found).toBe(true);
    expect(result.disallowedPaths).toHaveLength(0);
    expect(result.crawlDelay).toBeNull();
    expect(result.sitemapUrls).toHaveLength(0);
  });

  it('extracts Crawl-delay correctly', async () => {
    const content = `User-agent: *\nCrawl-delay: 10\nDisallow: /secret/`;
    mockFetchResponse(content);

    const result = await analyzeRobotsTxt('https://example.com/');

    expect(result.crawlDelay).toBe(10);
  });

  it('extracts sitemap URLs correctly', async () => {
    const content = `User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap1.xml\nSitemap: https://example.com/sitemap2.xml`;
    mockFetchResponse(content);

    const result = await analyzeRobotsTxt('https://example.com/');

    expect(result.sitemapUrls).toHaveLength(2);
    expect(result.sitemapUrls).toContain('https://example.com/sitemap1.xml');
    expect(result.sitemapUrls).toContain('https://example.com/sitemap2.xml');
  });

  it('handles fetch timeout gracefully', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetchError(abortError);

    const result = await analyzeRobotsTxt('https://slow-site.com/page');

    expect(result.found).toBe(false);
    expect(result.crawlDelay).toBeNull();
    expect(result.disallowedPaths).toHaveLength(0);
  });

  it('handles network errors gracefully', async () => {
    mockFetchError(new Error('ECONNREFUSED'));

    const result = await analyzeRobotsTxt('https://unreachable.com/page');

    expect(result.found).toBe(false);
  });

  it('handles invalid URL input', async () => {
    const result = await analyzeRobotsTxt('not-a-url');

    expect(result.found).toBe(false);
  });

  it('constructs robots.txt URL from the origin', async () => {
    mockFetchResponse(MINIMAL_ROBOTS_TXT);

    await analyzeRobotsTxt('https://example.com/deep/nested/page?query=1');

    const fetchCall = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const calledUrl = fetchCall.mock.calls[0][0];
    expect(calledUrl).toBe('https://example.com/robots.txt');
  });

  it('truncates rawContent to 2KB', async () => {
    const longContent = 'User-agent: *\n' + 'Disallow: /path\n'.repeat(500);
    mockFetchResponse(longContent);

    const result = await analyzeRobotsTxt('https://example.com/');

    expect(result.found).toBe(true);
    expect(result.rawContent).toBeDefined();
    expect(result.rawContent!.length).toBeLessThanOrEqual(2048);
  });
});
