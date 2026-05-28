/**
 * FastProfiler tests
 *
 * Tests site type detection, framework detection, and profiling logic
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import axios from 'axios';
import { FastProfiler } from '../../profiler/fast-profiler.js';
import { ProfilerTimeoutError, ProfilerError } from '../../profiler/interfaces.js';

const mockSafeFetch = vi.hoisted(() => vi.fn());

// Mock axios
vi.mock('axios');
vi.mock('@agent-platform/shared-kernel/security/safe-fetch', () => ({
  safeFetch: mockSafeFetch,
}));
const mockedAxios = vi.mocked(axios);

describe('FastProfiler', () => {
  let profiler: FastProfiler;

  beforeEach(() => {
    profiler = new FastProfiler();
    vi.clearAllMocks();
    mockSafeFetch.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'HEAD') {
        await mockedAxios.head(String(url));
        return new Response(null, { status: 200, statusText: 'OK' });
      }
      const response = await mockedAxios.get(String(url));
      return new Response(
        typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
        {
          status: response.status ?? 200,
          statusText: response.statusText ?? 'OK',
        },
      );
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getName() and getCapabilities()', () => {
    test('returns correct name', () => {
      expect(profiler.getName()).toBe('fast-profiler');
    });

    test('returns correct capabilities', () => {
      const caps = profiler.getCapabilities();
      expect(caps.canDetectFrameworks).toBe(true);
      expect(caps.canTestRateLimits).toBe(false);
      expect(caps.canEstimateSize).toBe(true);
      expect(caps.requiresBrowser).toBe(false);
      expect(caps.avgDurationMs).toBe(3000);
    });
  });

  describe('Static HTML Detection', () => {
    test('detects static HTML site correctly', async () => {
      // Mock: example.com returns static HTML
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://example.com') {
          return Promise.resolve({
            data: `
              <!DOCTYPE html>
              <html>
                <head><title>Example Domain</title></head>
                <body>
                  <header>Header</header>
                  <nav><a href="/page1">Page 1</a><a href="/page2">Page 2</a></nav>
                  <article>Main content here with lots of text...</article>
                  <footer>Footer</footer>
                </body>
              </html>
            `,
          });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const profile = await profiler.profile('https://example.com');

      expect(profile.siteType).toBe('static');
      expect(profile.jsRequired).toBe(false);
      expect(profile.framework).toBeUndefined();
      expect(profile.confidence).toBeGreaterThanOrEqual(80);
      expect(profile.domain).toBe('example.com');
    });

    test('calculates link density for static site', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://example.com') {
          return Promise.resolve({
            data: `
              <html>
                <body>
                  <nav>
                    <a href="/page1">Page 1</a>
                    <a href="/page2">Page 2</a>
                    <a href="/page3">Page 3</a>
                    <a href="https://external.com">External</a>
                  </nav>
                </body>
              </html>
            `,
          });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const profile = await profiler.profile('https://example.com');

      expect(profile.linkDensity).toBe(3); // 3 internal links
      expect(profile.estimatedSize).toBeGreaterThan(0);
    });
  });

  describe('SPA Detection', () => {
    test('detects React SPA correctly', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://spa.example') {
          return Promise.resolve({
            data: `
              <!DOCTYPE html>
              <html>
                <body>
                  <div id="root" data-reactroot></div>
                  <script src="bundle.js"></script>
                </body>
              </html>
            `,
          });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const profile = await profiler.profile('https://spa.example');

      expect(profile.siteType).toBe('spa');
      expect(profile.jsRequired).toBe(true);
      expect(profile.framework).toBe('react');
      expect(profile.confidence).toBeGreaterThanOrEqual(85);
    });

    test('detects Vue SPA correctly', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://vue.example') {
          return Promise.resolve({
            data: `
              <!DOCTYPE html>
              <html>
                <body>
                  <div id="app" data-v-></div>
                </body>
              </html>
            `,
          });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const profile = await profiler.profile('https://vue.example');

      expect(profile.siteType).toBe('spa');
      expect(profile.framework).toBe('vue');
    });

    test('detects Angular SPA correctly', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://ng.example') {
          return Promise.resolve({
            data: `
              <!DOCTYPE html>
              <html>
                <body>
                  <app-root ng-version="15.0.0"></app-root>
                </body>
              </html>
            `,
          });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const profile = await profiler.profile('https://ng.example');

      expect(profile.siteType).toBe('spa');
      expect(profile.framework).toBe('angular');
    });
  });

  describe('Hybrid (SSR) Detection', () => {
    test('detects Next.js SSR site correctly', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://nextjs.example') {
          return Promise.resolve({
            data: `
              <!DOCTYPE html>
              <html>
                <body>
                  <div id="__next">
                    <h1>Server Rendered Content</h1>
                    <article>Lots of content here that was rendered on the server...</article>
                  </div>
                  <script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>
                </body>
              </html>
            `,
          });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const profile = await profiler.profile('https://nextjs.example');

      expect(profile.siteType).toBe('hybrid');
      expect(profile.jsRequired).toBe(false); // Content is server-rendered
      expect(profile.framework).toBe('nextjs');
    });

    test('detects Nuxt SSR site correctly', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://nuxt.example') {
          return Promise.resolve({
            data: `
              <!DOCTYPE html>
              <html>
                <body>
                  <div id="app" data-v-abc>
                    <h1>Nuxt Server Side Rendered</h1>
                    <p>Content is here in HTML...</p>
                  </div>
                  <script>window.__NUXT__={}</script>
                </body>
              </html>
            `,
          });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const profile = await profiler.profile('https://nuxt.example');

      expect(profile.siteType).toBe('hybrid');
      expect(profile.framework).toBe('nuxt');
    });
  });

  describe('Timeout Handling', () => {
    test('surfaces safeFetch SSRF blocks from target URL fetches', async () => {
      mockSafeFetch.mockRejectedValue(new Error('HTTP target blocked by SSRF protection'));

      await expect(profiler.profile('http://169.254.169.254/')).rejects.toThrow(/SSRF protection/);
    });

    test('throws ProfilerTimeoutError on timeout', async () => {
      mockedAxios.get.mockRejectedValue({
        code: 'ETIMEDOUT',
        message: 'Timeout',
        isAxiosError: true,
      });

      await expect(profiler.profile('https://slow.example', { timeout: 1000 })).rejects.toThrow(
        ProfilerTimeoutError,
      );
    });

    test('throws ProfilerTimeoutError on connection abort', async () => {
      mockedAxios.get.mockRejectedValue({
        code: 'ECONNABORTED',
        message: 'Connection aborted',
        isAxiosError: true,
      });

      await expect(profiler.profile('https://slow.example', { timeout: 1000 })).rejects.toThrow(
        ProfilerTimeoutError,
      );
    });
  });

  describe('Confidence Scoring', () => {
    test('high confidence for clear signals', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://clear.example') {
          return Promise.resolve({
            data: `
              <!DOCTYPE html>
              <html>
                <body>
                  <article>Content</article>
                  <nav><a href="/p1">P1</a><a href="/p2">P2</a></nav>
                </body>
              </html>
            `,
          });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const profile = await profiler.profile('https://clear.example');
      expect(profile.confidence).toBeGreaterThanOrEqual(85);
    });

    test('lower confidence for ambiguous signals', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://ambiguous.example') {
          return Promise.resolve({
            data: `<!DOCTYPE html><html><body><div>Minimal content</div></body></html>`,
          });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const profile = await profiler.profile('https://ambiguous.example');
      expect(profile.siteType).toBe('unknown');
      expect(profile.confidence).toBeLessThan(70);
    });
  });

  describe('Sitemap Detection', () => {
    test('detects sitemap and uses it for size estimation', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://example.com') {
          return Promise.resolve({ data: '<html><body>Content</body></html>' });
        }
        if (url === 'https://example.com/sitemap.xml') {
          return Promise.resolve({
            data: `
              <?xml version="1.0"?>
              <urlset>
                <url><loc>https://example.com/page1</loc></url>
                <url><loc>https://example.com/page2</loc></url>
                <url><loc>https://example.com/page3</loc></url>
              </urlset>
            `,
          });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockImplementation((url) => {
        if (url === 'https://example.com/sitemap.xml') {
          return Promise.resolve({ status: 200 });
        }
        throw new Error('Not found');
      });

      const profile = await profiler.profile('https://example.com');

      expect(profile.metadata.hasSitemap).toBe(true);
      expect(profile.estimatedSize).toBe(3);
    });

    test('falls back to link estimation without sitemap', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://example.com') {
          return Promise.resolve({
            data: `
              <html><body>
                <a href="/1">1</a><a href="/2">2</a>
                <a href="/3">3</a><a href="/4">4</a>
                <a href="/5">5</a>
              </body></html>
            `,
          });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const profile = await profiler.profile('https://example.com');

      expect(profile.metadata.hasSitemap).toBe(false);
      expect(profile.estimatedSize).toBeGreaterThan(5); // level1 + level2 + level3
    });
  });

  describe('Robots.txt Detection', () => {
    test('detects robots.txt presence', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://example.com') {
          return Promise.resolve({ data: '<html><body>Content</body></html>' });
        }
        if (url === 'https://example.com/robots.txt') {
          return Promise.resolve({ data: 'User-agent: *\nAllow: /' });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const profile = await profiler.profile('https://example.com');

      expect(profile.metadata.hasRobotsTxt).toBe(true);
    });

    test('handles missing robots.txt', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://example.com') {
          return Promise.resolve({ data: '<html><body>Content</body></html>' });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const profile = await profiler.profile('https://example.com');

      expect(profile.metadata.hasRobotsTxt).toBe(false);
    });
  });

  describe('Sitemap Discovery in Profile', () => {
    test('profile includes sitemapDiscovery with steps and files', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://example.com') {
          return Promise.resolve({ data: '<html><body>Content</body></html>' });
        }
        if (url === 'https://example.com/robots.txt') {
          return Promise.resolve({ data: 'User-agent: *\nAllow: /' });
        }
        if (url === 'https://example.com/sitemap.xml') {
          return Promise.resolve({
            data: `<?xml version="1.0"?>
              <urlset>
                <url><loc>https://example.com/page1</loc></url>
                <url><loc>https://example.com/page2</loc></url>
              </urlset>`,
          });
        }
        throw new Error('Not found');
      });

      const profile = await profiler.profile('https://example.com');

      expect(profile.metadata.sitemapDiscovery).toBeDefined();
      expect(profile.metadata.sitemapDiscovery!.totalUrls).toBe(2);
      expect(profile.metadata.sitemapDiscovery!.allUrls).toHaveLength(2);
      expect(profile.metadata.sitemapDiscovery!.steps.length).toBeGreaterThanOrEqual(1);
      expect(profile.metadata.sitemapDiscovery!.sitemapFiles).toHaveLength(1);
    });

    test('profile discovers sitemaps from robots.txt Sitemap: directives', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://example.com') {
          return Promise.resolve({ data: '<html><body>Content</body></html>' });
        }
        if (url === 'https://example.com/robots.txt') {
          return Promise.resolve({
            data: 'User-agent: *\nAllow: /\nSitemap: https://example.com/custom-map.xml',
          });
        }
        if (url === 'https://example.com/sitemap.xml') {
          throw new Error('Not found');
        }
        if (url === 'https://example.com/custom-map.xml') {
          return Promise.resolve({
            data: `<?xml version="1.0"?>
              <urlset>
                <url><loc>https://example.com/robots-page</loc></url>
              </urlset>`,
          });
        }
        throw new Error('Not found');
      });

      const profile = await profiler.profile('https://example.com');

      expect(profile.metadata.hasSitemap).toBe(true);
      expect(profile.estimatedSize).toBe(1);
      expect(profile.metadata.sitemapDiscovery).toBeDefined();
      expect(profile.metadata.sitemapDiscovery!.totalUrls).toBe(1);
      expect(profile.metadata.sitemapDiscovery!.sitemapFiles).toHaveLength(1);
      expect(profile.metadata.sitemapDiscovery!.sitemapFiles[0].origin).toBe('robots.txt');

      // Steps should show default not_found, robots.txt found
      const steps = profile.metadata.sitemapDiscovery!.steps;
      expect(steps.find((s) => s.source === 'default')?.status).toBe('not_found');
      expect(steps.find((s) => s.source === 'robots.txt')?.status).toBe('found');
    });

    test('profile handles no sitemaps anywhere gracefully', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://example.com') {
          return Promise.resolve({ data: '<html><body>Content</body></html>' });
        }
        throw new Error('Not found');
      });

      const profile = await profiler.profile('https://example.com');

      expect(profile.metadata.hasSitemap).toBe(false);
      expect(profile.metadata.sitemapDiscovery).toBeDefined();
      expect(profile.metadata.sitemapDiscovery!.totalUrls).toBe(0);
      expect(profile.metadata.sitemapDiscovery!.allUrls).toHaveLength(0);
    });
  });

  describe('Metadata', () => {
    test('includes HTML size and script count', async () => {
      const htmlContent = '<html><body><script></script><script></script>Content</body></html>';
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://example.com') {
          return Promise.resolve({ data: htmlContent });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const profile = await profiler.profile('https://example.com');

      expect(profile.metadata.htmlSize).toBe(htmlContent.length);
      expect(profile.metadata.scriptTagCount).toBe(2);
    });
  });

  describe('Performance', () => {
    test('completes profiling within reasonable time', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://example.com') {
          return Promise.resolve({ data: '<html><body>Content</body></html>' });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const startTime = Date.now();
      await profiler.profile('https://example.com');
      const elapsed = Date.now() - startTime;

      // Should be very fast with mocked HTTP
      expect(elapsed).toBeLessThan(1000);
    });

    test('avgResponseTime reflects profiling duration', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://example.com') {
          // Add small delay to simulate network timing
          return new Promise((resolve) =>
            setTimeout(() => resolve({ data: '<html><body>Content</body></html>' }), 5),
          );
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const profile = await profiler.profile('https://example.com');

      expect(profile.avgResponseTime).toBeGreaterThan(0);
      expect(profile.avgResponseTime).toBeLessThan(10000);
    });
  });

  describe('Error Handling', () => {
    test('throws ProfilerError on network failure', async () => {
      mockedAxios.get.mockRejectedValue({
        isAxiosError: true,
        message: 'Network error',
        code: 'ECONNREFUSED',
      });

      await expect(profiler.profile('https://unreachable.example')).rejects.toThrow(ProfilerError);
    });

    test('includes cause in ProfilerError', async () => {
      const originalError = new Error('DNS lookup failed');
      mockedAxios.get.mockRejectedValue({
        isAxiosError: true,
        message: 'DNS lookup failed',
        code: 'ENOTFOUND',
      });

      try {
        await profiler.profile('https://invalid.example');
        throw new Error('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProfilerError);
        if (error instanceof ProfilerError) {
          expect(error.message).toContain('Failed to profile');
        }
      }
    });
  });

  describe('Options Handling', () => {
    test('respects custom timeout', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

      mockedAxios.get.mockImplementation((url) => {
        return Promise.resolve({ data: '<html></html>' });
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      await profiler.profile('https://example.com', { timeout: 5000 });

      expect(timeoutSpy).toHaveBeenCalledWith(5000);
    });

    test('skips framework detection when disabled', async () => {
      mockedAxios.get.mockImplementation((url) => {
        if (url === 'https://example.com') {
          return Promise.resolve({
            data: '<html><body><div id="__next">Content</div></body></html>',
          });
        }
        throw new Error('Not found');
      });

      mockedAxios.head.mockRejectedValue(new Error('Not found'));

      const profile = await profiler.profile('https://example.com', {
        detectFramework: false,
      });

      expect(profile.framework).toBeUndefined();
    });
  });
});
