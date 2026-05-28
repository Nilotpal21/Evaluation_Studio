import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { PaginationDetector } from '../../intelligence/algorithms/pagination-detector.js';
import type { CrawlResultLink } from '../../intelligence/algorithms/types.js';

describe('PaginationDetector', () => {
  const detector = new PaginationDetector();

  // ─── Query Parameter Detection ───────────────────────────────────

  describe('query-param detection', () => {
    it('detects ?page=2 links', () => {
      const links: CrawlResultLink[] = [
        { text: '2', href: 'https://example.com/products?page=2' },
        { text: '3', href: 'https://example.com/products?page=3' },
      ];
      const result = detector.detect(
        'https://example.com/products',
        '<html><body></body></html>',
        links,
      );
      expect(result.detected).toBe(true);
      expect(result.type).toBe('query-param');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.totalPages).toBe(3);
      expect(result.allPageUrls).toBeDefined();
      expect(result.allPageUrls!.length).toBe(3);
    });

    it('sets currentPage from the URL query param', () => {
      const links: CrawlResultLink[] = [
        { text: '1', href: 'https://example.com/products?page=1' },
        { text: '3', href: 'https://example.com/products?page=3' },
      ];
      const result = detector.detect(
        'https://example.com/products?page=2',
        '<html><body></body></html>',
        links,
      );
      expect(result.detected).toBe(true);
      expect(result.currentPage).toBe(2);
    });
  });

  // ─── Path Segment Detection ──────────────────────────────────────

  describe('path-segment detection', () => {
    it('detects /page/N links', () => {
      const links: CrawlResultLink[] = [
        { text: '2', href: '/blog/page/2' },
        { text: '3', href: '/blog/page/3' },
        { text: '4', href: '/blog/page/4' },
      ];
      const result = detector.detect(
        'https://example.com/blog',
        '<html><body></body></html>',
        links,
      );
      expect(result.detected).toBe(true);
      expect(result.type).toBe('path-segment');
      expect(result.totalPages).toBe(4);
      expect(result.allPageUrls).toBeDefined();
      expect(result.allPageUrls!.length).toBe(4);
    });

    it('extracts current page from path', () => {
      const links: CrawlResultLink[] = [
        { text: '1', href: '/blog/page/1' },
        { text: '4', href: '/blog/page/4' },
      ];
      const result = detector.detect(
        'https://example.com/blog/page/3',
        '<html><body></body></html>',
        links,
      );
      expect(result.detected).toBe(true);
      expect(result.currentPage).toBe(3);
    });
  });

  // ─── rel="next" Detection ────────────────────────────────────────

  describe('rel-next detection', () => {
    it('detects <link rel="next"> in HTML head', () => {
      const html = `<html><head>
        <link rel="next" href="/blog/page/3">
      </head><body></body></html>`;
      const result = detector.detect('https://example.com/blog/page/2', html, []);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('rel-next');
      expect(result.nextUrl).toBe('https://example.com/blog/page/3');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('resolves relative rel="next" URLs', () => {
      const html = `<html><head>
        <link rel="next" href="?page=5">
      </head><body></body></html>`;
      const result = detector.detect('https://example.com/products?page=4', html, []);
      expect(result.detected).toBe(true);
      expect(result.nextUrl).toContain('page=5');
    });
  });

  // ─── DOM Pattern Detection ───────────────────────────────────────

  describe('dom-pattern detection', () => {
    it('detects .pagination class with page links', () => {
      const html = `<html><body>
        <div class="pagination">
          <a href="/items?page=1">1</a>
          <a href="/items?page=2">2</a>
          <a href="/items?page=3">3</a>
          <a href="/items?page=4">4</a>
          <a href="/items?page=5">5</a>
        </div>
      </body></html>`;
      const result = detector.detect('https://example.com/items', html, []);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('dom-pattern');
      expect(result.totalPages).toBe(5);
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('detects nav[aria-label="pagination"]', () => {
      const html = `<html><body>
        <nav aria-label="pagination">
          <a href="/items?page=1">1</a>
          <a href="/items?page=2">2</a>
          <a href="/items?page=3">3</a>
        </nav>
      </body></html>`;
      const result = detector.detect('https://example.com/items', html, []);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('dom-pattern');
    });
  });

  // ─── Item Count Text Extraction ──────────────────────────────────

  describe('item count extraction', () => {
    it('extracts "Showing 1-20 of 342 results" to compute totalPages', () => {
      const html = `<html><body>
        <p>Showing 1-20 of 342 results</p>
        <div class="pagination">
          <a href="/products?page=1">1</a>
          <a href="/products?page=2">2</a>
          <a href="/products?page=3">3</a>
        </div>
      </body></html>`;
      const result = detector.detect('https://example.com/products', html, []);
      expect(result.detected).toBe(true);
      // 342 / 20 = 17.1, ceil = 18
      expect(result.totalPages).toBe(18);
      expect(result.allPageUrls).toBeDefined();
      expect(result.allPageUrls!.length).toBe(18);
    });

    it('extracts "Displaying 21-40 of 100 items"', () => {
      const html = `<html><body>
        <p>Displaying 21-40 of 100 items</p>
        <div class="pagination">
          <a href="/list?page=1">1</a>
          <a href="/list?page=2">2</a>
        </div>
      </body></html>`;
      const result = detector.detect('https://example.com/list?page=2', html, []);
      expect(result.detected).toBe(true);
      // 100 / 20 = 5
      expect(result.totalPages).toBe(5);
    });
  });

  // ─── No Pagination ───────────────────────────────────────────────

  describe('no pagination', () => {
    it('returns detected=false for pages without pagination', () => {
      const html = `<html><body>
        <h1>Just a regular page</h1>
        <p>No pagination here.</p>
      </body></html>`;
      const links: CrawlResultLink[] = [
        { text: 'Home', href: '/' },
        { text: 'About', href: '/about' },
      ];
      const result = detector.detect('https://example.com/article', html, links);
      expect(result.detected).toBe(false);
      expect(result.type).toBe('none');
      expect(result.confidence).toBe(0);
    });
  });

  // ─── Multiple Pagination Types ───────────────────────────────────

  describe('multiple pagination types', () => {
    it('picks highest confidence when multiple patterns present', () => {
      const html = `<html><head>
        <link rel="next" href="/blog/page/3">
      </head><body>
        <div class="pagination">
          <a href="/blog/page/2">2</a>
          <a href="/blog/page/3">3</a>
        </div>
      </body></html>`;
      const links: CrawlResultLink[] = [
        { text: '2', href: '/blog/page/2' },
        { text: '3', href: '/blog/page/3' },
      ];
      const result = detector.detect('https://example.com/blog/page/1', html, links);
      expect(result.detected).toBe(true);
      // rel-next has highest confidence (0.95) so it should win
      expect(result.type).toBe('rel-next');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });
  });

  // ─── maxPages Config Cap ─────────────────────────────────────────

  describe('maxPages config', () => {
    it('caps total pages at maxPages', () => {
      const customDetector = new PaginationDetector({ maxPages: 5 });
      const links: CrawlResultLink[] = [];
      for (let i = 1; i <= 20; i++) {
        links.push({
          text: String(i),
          href: `https://example.com/products?page=${i}`,
        });
      }
      const result = customDetector.detect(
        'https://example.com/products',
        '<html><body></body></html>',
        links,
      );
      expect(result.detected).toBe(true);
      expect(result.totalPages).toBe(5);
      expect(result.allPageUrls).toBeDefined();
      expect(result.allPageUrls!.length).toBe(5);
    });

    it('caps item count totalPages at maxPages', () => {
      const customDetector = new PaginationDetector({ maxPages: 10 });
      const html = `<html><body>
        <p>Showing 1-20 of 1000 results</p>
        <div class="pagination">
          <a href="/products?page=1">1</a>
          <a href="/products?page=2">2</a>
        </div>
      </body></html>`;
      const result = customDetector.detect('https://example.com/products', html, []);
      expect(result.detected).toBe(true);
      // 1000 / 20 = 50, but capped at 10
      expect(result.totalPages).toBe(10);
    });
  });

  // ─── WithDom Parity Tests ────────────────────────────────────────

  describe('detectWithDom parity', () => {
    it('detectWithDom returns identical result to detect for the same HTML', () => {
      const html = `<html><head>
        <link rel="next" href="/blog/page/3">
      </head><body>
        <p>Showing 1-20 of 342 results</p>
        <div class="pagination">
          <a href="/blog/page/2">2</a>
          <a href="/blog/page/3">3</a>
        </div>
      </body></html>`;
      const url = 'https://example.com/blog/page/1';
      const links: CrawlResultLink[] = [
        { text: '2', href: '/blog/page/2' },
        { text: '3', href: '/blog/page/3' },
      ];

      const resultFromDetect = detector.detect(url, html, links);
      const $ = cheerio.load(html);
      const resultFromDom = detector.detectWithDom($, url, links);

      expect(resultFromDom).toEqual(resultFromDetect);
    });
  });

  // ─── Edge Cases ──────────────────────────────────────────────────

  describe('edge cases', () => {
    it('ignores page=0 in links', () => {
      const links: CrawlResultLink[] = [{ text: '0', href: 'https://example.com/products?page=0' }];
      const result = detector.detect(
        'https://example.com/products',
        '<html><body></body></html>',
        links,
      );
      expect(result.detected).toBe(false);
      expect(result.type).toBe('none');
    });

    it('ignores page=-1 in links', () => {
      const links: CrawlResultLink[] = [
        { text: '-1', href: 'https://example.com/products?page=-1' },
      ];
      const result = detector.detect(
        'https://example.com/products',
        '<html><body></body></html>',
        links,
      );
      // Negative page numbers don't match the regex (\d+ only matches positive)
      expect(result.detected).toBe(false);
    });

    it('ignores non-numeric page values in links', () => {
      const links: CrawlResultLink[] = [
        { text: 'next', href: 'https://example.com/products?page=abc' },
      ];
      const result = detector.detect(
        'https://example.com/products',
        '<html><body></body></html>',
        links,
      );
      expect(result.detected).toBe(false);
    });

    it('handles empty HTML without crashing', () => {
      const result = detector.detect('https://example.com', '', []);
      expect(result.detected).toBe(false);
      expect(result.type).toBe('none');
    });

    it('handles malformed URLs in links gracefully', () => {
      const links: CrawlResultLink[] = [{ text: '2', href: ':::invalid:::?page=2' }];
      // Should not throw
      const result = detector.detect(
        'https://example.com/products',
        '<html><body></body></html>',
        links,
      );
      // The query param regex still matches the href string
      expect(result).toBeDefined();
    });
  });
});
