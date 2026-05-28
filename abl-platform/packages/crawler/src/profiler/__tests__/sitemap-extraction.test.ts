/**
 * Sitemap URL Extraction Tests
 *
 * Tests the extractSitemapUrls() method in FastProfiler.
 * Covers: simple sitemaps, sitemap indexes, priority/lastmod sorting,
 * robots.txt Sitemap: directives, provenance tracking, error handling.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import axios from 'axios';
import { FastProfiler } from '../fast-profiler.js';
import { ProfilerError, ProfilerTimeoutError } from '../interfaces.js';
import type { SitemapDiscoveryResult } from '../interfaces.js';

const mockSafeFetch = vi.hoisted(() => vi.fn());

// Mock axios
vi.mock('axios');
// Mock safeFetch (production code calls it from this subpath after ABLP-573).
vi.mock('@agent-platform/shared-kernel/security/safe-fetch', () => ({
  safeFetch: mockSafeFetch,
}));
const mockedAxios = axios as any;

describe('FastProfiler - Sitemap URL Extraction', () => {
  let profiler: FastProfiler;

  beforeEach(() => {
    profiler = new FastProfiler();
    vi.clearAllMocks();
    // Bridge production safeFetch (used by fast-profiler) to the axios
    // mock fixtures the existing tests already set up.
    mockSafeFetch.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const fn = method === 'HEAD' ? mockedAxios.head : mockedAxios.get;
      const axiosResp = await fn(String(url));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => axiosResp?.data ?? '',
      } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('simple sitemap', () => {
    test('should extract URLs from simple sitemap', async () => {
      const simpleSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
    <priority>1.0</priority>
    <lastmod>2026-02-20</lastmod>
  </url>
  <url>
    <loc>https://example.com/page1/</loc>
    <priority>0.8</priority>
    <lastmod>2026-02-19</lastmod>
  </url>
  <url>
    <loc>https://example.com/page2/</loc>
    <priority>0.6</priority>
    <lastmod>2026-02-18</lastmod>
  </url>
</urlset>`;

      mockedAxios.get.mockResolvedValueOnce({ data: simpleSitemap });

      const result = await profiler.extractSitemapUrls('https://example.com/');

      expect(result.allUrls).toHaveLength(3);
      expect(result.allUrls[0]).toBe('https://example.com/');
      expect(result.allUrls[1]).toBe('https://example.com/page1/');
      expect(result.allUrls[2]).toBe('https://example.com/page2/');
      expect(result.totalUrls).toBe(3);
    });

    test('should return discovery steps for default sitemap', async () => {
      const simpleSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
</urlset>`;

      mockedAxios.get.mockResolvedValueOnce({ data: simpleSitemap });

      const result = await profiler.extractSitemapUrls('https://example.com/');

      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toEqual({
        source: 'default',
        url: 'https://example.com/sitemap.xml',
        status: 'found',
        urlCount: 1,
        type: 'sitemap',
      });
    });

    test('should return sitemapFiles with provenance', async () => {
      const simpleSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc><priority>1.0</priority></url>
  <url><loc>https://example.com/page1/</loc><priority>0.8</priority></url>
</urlset>`;

      mockedAxios.get.mockResolvedValueOnce({ data: simpleSitemap });

      const result = await profiler.extractSitemapUrls('https://example.com/');

      expect(result.sitemapFiles).toHaveLength(1);
      expect(result.sitemapFiles[0].url).toBe('https://example.com/sitemap.xml');
      expect(result.sitemapFiles[0].origin).toBe('default');
      expect(result.sitemapFiles[0].parentUrl).toBeUndefined();
      expect(result.sitemapFiles[0].urls).toHaveLength(2);
    });

    test('should respect maxUrls limit', async () => {
      const largeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${Array.from({ length: 100 }, (_, i) => `<url><loc>https://example.com/page${i}/</loc></url>`).join('\n')}
</urlset>`;

      mockedAxios.get.mockResolvedValueOnce({ data: largeSitemap });

      const result = await profiler.extractSitemapUrls('https://example.com/', 10);

      expect(result.allUrls).toHaveLength(10);
      // totalUrls reflects actual count before limit
      expect(result.totalUrls).toBe(100);
    });

    test('should sort by priority (high to low)', async () => {
      const sitemapWithPriorities = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/low-priority/</loc>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>https://example.com/high-priority/</loc>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://example.com/medium-priority/</loc>
    <priority>0.5</priority>
  </url>
</urlset>`;

      mockedAxios.get.mockResolvedValueOnce({ data: sitemapWithPriorities });

      const result = await profiler.extractSitemapUrls('https://example.com/');

      expect(result.allUrls[0]).toBe('https://example.com/high-priority/');
      expect(result.allUrls[1]).toBe('https://example.com/medium-priority/');
      expect(result.allUrls[2]).toBe('https://example.com/low-priority/');
    });

    test('should sort by lastmod (recent first) when priorities equal', async () => {
      const sitemapWithDates = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/old/</loc>
    <priority>0.5</priority>
    <lastmod>2026-01-01</lastmod>
  </url>
  <url>
    <loc>https://example.com/recent/</loc>
    <priority>0.5</priority>
    <lastmod>2026-02-20</lastmod>
  </url>
  <url>
    <loc>https://example.com/older/</loc>
    <priority>0.5</priority>
    <lastmod>2026-01-15</lastmod>
  </url>
</urlset>`;

      mockedAxios.get.mockResolvedValueOnce({ data: sitemapWithDates });

      const result = await profiler.extractSitemapUrls('https://example.com/');

      expect(result.allUrls[0]).toBe('https://example.com/recent/');
      expect(result.allUrls[1]).toBe('https://example.com/older/');
      expect(result.allUrls[2]).toBe('https://example.com/old/');
    });

    test('should handle URLs without priority or lastmod', async () => {
      const minimalSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
  </url>
  <url>
    <loc>https://example.com/page1/</loc>
  </url>
</urlset>`;

      mockedAxios.get.mockResolvedValueOnce({ data: minimalSitemap });

      const result = await profiler.extractSitemapUrls('https://example.com/');

      expect(result.allUrls).toHaveLength(2);
      expect(result.allUrls).toContain('https://example.com/');
      expect(result.allUrls).toContain('https://example.com/page1/');
    });
  });

  describe('sitemap index', () => {
    test('should recursively fetch child sitemaps with provenance', async () => {
      const sitemapIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap1.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap2.xml</loc>
  </sitemap>
</sitemapindex>`;

      const sitemap1 = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1/</loc></url>
  <url><loc>https://example.com/page2/</loc></url>
</urlset>`;

      const sitemap2 = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page3/</loc></url>
  <url><loc>https://example.com/page4/</loc></url>
</urlset>`;

      mockedAxios.get
        .mockResolvedValueOnce({ data: sitemapIndex }) // Main sitemap
        .mockResolvedValueOnce({ data: sitemap1 }) // Child sitemap 1
        .mockResolvedValueOnce({ data: sitemap2 }); // Child sitemap 2

      const result = await profiler.extractSitemapUrls('https://example.com/');

      expect(result.allUrls).toHaveLength(4);
      expect(result.allUrls).toContain('https://example.com/page1/');
      expect(result.allUrls).toContain('https://example.com/page2/');
      expect(result.allUrls).toContain('https://example.com/page3/');
      expect(result.allUrls).toContain('https://example.com/page4/');

      // Provenance: two child sitemap files, each with origin 'index'
      expect(result.sitemapFiles).toHaveLength(2);
      expect(result.sitemapFiles[0].origin).toBe('index');
      expect(result.sitemapFiles[0].parentUrl).toBe('https://example.com/sitemap.xml');
      expect(result.sitemapFiles[1].origin).toBe('index');

      // Step shows it was an index
      expect(result.steps[0].type).toBe('index');
      expect(result.steps[0].urlCount).toBe(4);
    });

    test('should handle nested sitemap indexes', async () => {
      const mainIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/category-index.xml</loc>
  </sitemap>
</sitemapindex>`;

      const categoryIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/category-pages.xml</loc>
  </sitemap>
</sitemapindex>`;

      const pagesSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/nested-page/</loc></url>
</urlset>`;

      mockedAxios.get
        .mockResolvedValueOnce({ data: mainIndex })
        .mockResolvedValueOnce({ data: categoryIndex })
        .mockResolvedValueOnce({ data: pagesSitemap });

      const result = await profiler.extractSitemapUrls('https://example.com/');

      expect(result.allUrls).toHaveLength(1);
      expect(result.allUrls[0]).toBe('https://example.com/nested-page/');
    });

    test('should prevent infinite recursion with circular references', async () => {
      const circularIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap.xml</loc>
  </sitemap>
</sitemapindex>`;

      mockedAxios.get.mockResolvedValue({ data: circularIndex });

      const result = await profiler.extractSitemapUrls('https://example.com/');

      // Should not throw, should return empty since it detects cycle
      expect(result.allUrls).toHaveLength(0);
      expect(result.totalUrls).toBe(0);
    });

    test('should handle mixed sitemap types (index + regular)', async () => {
      const mixedSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/pages.xml</loc>
  </sitemap>
</sitemapindex>`;

      const pagesSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1/</loc><priority>0.8</priority></url>
  <url><loc>https://example.com/page2/</loc><priority>0.6</priority></url>
</urlset>`;

      mockedAxios.get
        .mockResolvedValueOnce({ data: mixedSitemap })
        .mockResolvedValueOnce({ data: pagesSitemap });

      const result = await profiler.extractSitemapUrls('https://example.com/');

      expect(result.allUrls).toHaveLength(2);
      // Should be sorted by priority
      expect(result.allUrls[0]).toBe('https://example.com/page1/');
      expect(result.allUrls[1]).toBe('https://example.com/page2/');
    });
  });

  describe('robots.txt Sitemap: directives', () => {
    test('should discover sitemaps from robots.txt directives', async () => {
      // Default /sitemap.xml fails
      mockedAxios.get.mockImplementation((url: string) => {
        if (url === 'https://example.com/sitemap.xml') {
          return Promise.reject(new Error('404 Not Found'));
        }
        if (url === 'https://example.com/custom-sitemap.xml') {
          return Promise.resolve({
            data: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/from-robots/</loc></url>
  <url><loc>https://example.com/from-robots-2/</loc></url>
</urlset>`,
          });
        }
        return Promise.reject(new Error('Not found'));
      });

      const result = await profiler.extractSitemapUrls(
        'https://example.com/',
        1000,
        5000,
        ['https://example.com/custom-sitemap.xml'], // from robots.txt
      );

      expect(result.allUrls).toHaveLength(2);
      expect(result.allUrls).toContain('https://example.com/from-robots/');
      expect(result.totalUrls).toBe(2);

      // Steps: default not_found, robots.txt found
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0]).toEqual({
        source: 'default',
        url: 'https://example.com/sitemap.xml',
        status: 'not_found',
      });
      expect(result.steps[1]).toEqual({
        source: 'robots.txt',
        url: 'https://example.com/custom-sitemap.xml',
        status: 'found',
        urlCount: 2,
        type: 'sitemap',
      });

      // Provenance
      expect(result.sitemapFiles).toHaveLength(1);
      expect(result.sitemapFiles[0].origin).toBe('robots.txt');
    });

    test('should merge URLs from default and robots.txt sitemaps', async () => {
      const defaultSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/default-page/</loc></url>
</urlset>`;

      const robotsSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/robots-page/</loc></url>
</urlset>`;

      mockedAxios.get.mockImplementation((url: string) => {
        if (url === 'https://example.com/sitemap.xml') {
          return Promise.resolve({ data: defaultSitemap });
        }
        if (url === 'https://example.com/extra-sitemap.xml') {
          return Promise.resolve({ data: robotsSitemap });
        }
        return Promise.reject(new Error('Not found'));
      });

      const result = await profiler.extractSitemapUrls('https://example.com/', 1000, 5000, [
        'https://example.com/extra-sitemap.xml',
      ]);

      expect(result.allUrls).toHaveLength(2);
      expect(result.allUrls).toContain('https://example.com/default-page/');
      expect(result.allUrls).toContain('https://example.com/robots-page/');
      expect(result.totalUrls).toBe(2);

      // Two sitemap files with different origins
      expect(result.sitemapFiles).toHaveLength(2);
      expect(result.sitemapFiles[0].origin).toBe('default');
      expect(result.sitemapFiles[1].origin).toBe('robots.txt');
    });

    test('should dedup URLs found in both default and robots.txt sitemaps', async () => {
      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/shared-page/</loc><priority>0.8</priority></url>
  <url><loc>https://example.com/unique-default/</loc></url>
</urlset>`;

      const robotsSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/shared-page/</loc><priority>0.5</priority></url>
  <url><loc>https://example.com/unique-robots/</loc></url>
</urlset>`;

      mockedAxios.get.mockImplementation((url: string) => {
        if (url === 'https://example.com/sitemap.xml') {
          return Promise.resolve({ data: sitemap });
        }
        if (url === 'https://example.com/robots-sitemap.xml') {
          return Promise.resolve({ data: robotsSitemap });
        }
        return Promise.reject(new Error('Not found'));
      });

      const result = await profiler.extractSitemapUrls('https://example.com/', 1000, 5000, [
        'https://example.com/robots-sitemap.xml',
      ]);

      // shared-page appears in both but should be deduped
      expect(result.totalUrls).toBe(3);
      expect(result.allUrls).toHaveLength(3);
      expect(result.allUrls).toContain('https://example.com/shared-page/');
      expect(result.allUrls).toContain('https://example.com/unique-default/');
      expect(result.allUrls).toContain('https://example.com/unique-robots/');
    });

    test('should skip robots.txt sitemap that was already visited via default', async () => {
      // robots.txt points to /sitemap.xml which is the same as default
      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1/</loc></url>
</urlset>`;

      mockedAxios.get.mockResolvedValue({ data: sitemap });

      const result = await profiler.extractSitemapUrls(
        'https://example.com/',
        1000,
        5000,
        ['https://example.com/sitemap.xml'], // Same as default
      );

      // Should still work, URL not fetched twice
      expect(result.allUrls).toHaveLength(1);
      expect(result.totalUrls).toBe(1);

      // Both steps should show found
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].source).toBe('default');
      expect(result.steps[0].status).toBe('found');
      expect(result.steps[1].source).toBe('robots.txt');
      expect(result.steps[1].status).toBe('found');
    });
  });

  describe('no sitemap found', () => {
    test('should return not_found step when default sitemap missing', async () => {
      mockedAxios.get.mockRejectedValue(new Error('404 Not Found'));

      const result = await profiler.extractSitemapUrls('https://example.com/');

      expect(result.allUrls).toHaveLength(0);
      expect(result.totalUrls).toBe(0);
      expect(result.sitemapFiles).toHaveLength(0);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toEqual({
        source: 'default',
        url: 'https://example.com/sitemap.xml',
        status: 'not_found',
      });
    });
  });

  describe('error handling', () => {
    test('should return not_found step on network failure (not throw)', async () => {
      mockedAxios.get.mockRejectedValueOnce(
        Object.assign(new Error('Network error'), {
          isAxiosError: true,
          message: 'Network error',
        }),
      );

      // extractSitemapUrls now gracefully handles failed sitemaps instead of throwing
      const result = await profiler.extractSitemapUrls('https://example.com/');

      expect(result.allUrls).toHaveLength(0);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].status).toBe('not_found');
    });

    test('should return not_found step on timeout (not throw)', async () => {
      const timeoutError = Object.assign(new Error('Timeout'), {
        code: 'ECONNABORTED',
      });

      mockedAxios.get.mockRejectedValueOnce(timeoutError);

      // extractSitemapUrls now gracefully handles timeout instead of throwing
      const result = await profiler.extractSitemapUrls('https://example.com/');

      expect(result.allUrls).toHaveLength(0);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].status).toBe('not_found');
    });

    test('should handle malformed XML gracefully', async () => {
      const malformedXML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
  </url>
  <url>
    <!-- Malformed: missing closing tag
    <loc>https://example.com/broken/
  </url>
</urlset>`;

      mockedAxios.get.mockResolvedValueOnce({ data: malformedXML });

      // Should not throw - cheerio handles malformed XML somewhat gracefully
      const result = await profiler.extractSitemapUrls('https://example.com/');

      // Should extract what it can
      expect(result).toBeDefined();
      expect(result.steps).toBeDefined();
    });

    test('should handle empty sitemap', async () => {
      const emptySitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`;

      mockedAxios.get.mockResolvedValueOnce({ data: emptySitemap });

      const result = await profiler.extractSitemapUrls('https://example.com/');

      expect(result.allUrls).toHaveLength(0);
      expect(result.totalUrls).toBe(0);
    });

    test('should skip child sitemaps that fail to fetch', async () => {
      const sitemapIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/good.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/bad.xml</loc>
  </sitemap>
</sitemapindex>`;

      const goodSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/good-page/</loc></url>
</urlset>`;

      mockedAxios.get
        .mockResolvedValueOnce({ data: sitemapIndex })
        .mockResolvedValueOnce({ data: goodSitemap })
        .mockRejectedValueOnce(new Error('404 Not Found'));

      const result = await profiler.extractSitemapUrls('https://example.com/');

      // Should return URLs from good sitemap, skip bad one
      expect(result.allUrls).toHaveLength(1);
      expect(result.allUrls[0]).toBe('https://example.com/good-page/');
    });

    test('should record error step for failed robots.txt sitemap', async () => {
      // Default sitemap works
      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1/</loc></url>
</urlset>`;

      mockedAxios.get.mockImplementation((url: string) => {
        if (url === 'https://example.com/sitemap.xml') {
          return Promise.resolve({ data: sitemap });
        }
        // robots.txt sitemap fails with error (not 404, actual error)
        return Promise.reject(new Error('Connection refused'));
      });

      const result = await profiler.extractSitemapUrls('https://example.com/', 1000, 5000, [
        'https://example.com/broken-sitemap.xml',
      ]);

      expect(result.allUrls).toHaveLength(1);
      expect(result.steps).toHaveLength(2);
      expect(result.steps[1]).toEqual({
        source: 'robots.txt',
        url: 'https://example.com/broken-sitemap.xml',
        status: 'error',
      });
    });
  });

  describe('custom timeout', () => {
    test('should respect custom timeout parameter', async () => {
      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
</urlset>`;

      mockedAxios.get.mockResolvedValueOnce({ data: sitemap });

      await profiler.extractSitemapUrls('https://example.com/', 100, 10000);

      // Production uses safeFetch with `signal: AbortSignal.timeout(...)`,
      // not axios's `timeout` option. Verify safeFetch saw the URL and an
      // AbortSignal that has the timeout configured.
      expect(mockSafeFetch).toHaveBeenCalledWith(
        'https://example.com/sitemap.xml',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
        expect.any(Object),
      );
    });
  });

  describe('real-world scenarios', () => {
    test('should handle docs.kore.ai-style sitemap structure', async () => {
      // Simulating docs.kore.ai sitemap structure
      const mainSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://docs.kore.ai/page-sitemap.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://docs.kore.ai/post-sitemap.xml</loc>
  </sitemap>
</sitemapindex>`;

      const pageSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://docs.kore.ai/</loc>
    <priority>1.0</priority>
    <lastmod>2026-02-20</lastmod>
  </url>
  <url>
    <loc>https://docs.kore.ai/gettingstarted/</loc>
    <priority>0.8</priority>
    <lastmod>2026-02-19</lastmod>
  </url>
</urlset>`;

      const postSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://docs.kore.ai/blog/post1/</loc>
    <priority>0.5</priority>
  </url>
</urlset>`;

      mockedAxios.get
        .mockResolvedValueOnce({ data: mainSitemap })
        .mockResolvedValueOnce({ data: pageSitemap })
        .mockResolvedValueOnce({ data: postSitemap });

      const result = await profiler.extractSitemapUrls('https://docs.kore.ai/', 100);

      expect(result.allUrls).toHaveLength(3);
      // Sorted by priority: 1.0, 0.8, 0.5
      expect(result.allUrls[0]).toBe('https://docs.kore.ai/');
      expect(result.allUrls[1]).toBe('https://docs.kore.ai/gettingstarted/');
      expect(result.allUrls[2]).toBe('https://docs.kore.ai/blog/post1/');

      // Two child sitemap files from index
      expect(result.sitemapFiles).toHaveLength(2);
      expect(result.sitemapFiles[0].url).toBe('https://docs.kore.ai/page-sitemap.xml');
      expect(result.sitemapFiles[0].origin).toBe('index');
      expect(result.sitemapFiles[1].url).toBe('https://docs.kore.ai/post-sitemap.xml');
      expect(result.sitemapFiles[1].origin).toBe('index');
    });
  });
});
