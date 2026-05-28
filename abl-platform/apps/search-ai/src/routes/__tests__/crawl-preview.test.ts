/**
 * Crawl Preview — Pure Logic Tests
 *
 * Tests the exported pure functions from crawl-preview.ts.
 * No mocking needed — these are stateless input → output functions.
 */

import { describe, it, expect } from 'vitest';
import {
  checkOriginMatch,
  computeWordCount,
  computeImageCount,
  detectJsRendering,
  truncateHtml,
  generateExcerpt,
  classifyPreviewError,
} from '../crawl-preview.js';
import { ValidationError } from '@agent-platform/shared-kernel';

describe('crawl-preview pure logic', () => {
  // ─── Origin Match ───────────────────────────────────────────────────────

  describe('checkOriginMatch', () => {
    it('returns true for same origin', () => {
      expect(checkOriginMatch('https://example.com/page', 'https://example.com')).toBe(true);
    });

    it('returns true for same origin with different paths', () => {
      expect(checkOriginMatch('https://example.com/docs/page', 'https://example.com/other')).toBe(
        true,
      );
    });

    it('returns false for different domains', () => {
      expect(checkOriginMatch('https://evil.com/page', 'https://example.com')).toBe(false);
    });

    it('returns false for different protocols', () => {
      expect(checkOriginMatch('http://example.com/page', 'https://example.com')).toBe(false);
    });

    it('returns false for different ports', () => {
      expect(checkOriginMatch('https://example.com:8080/page', 'https://example.com')).toBe(false);
    });

    it('returns false for subdomain mismatch', () => {
      expect(checkOriginMatch('https://sub.example.com/page', 'https://example.com')).toBe(false);
    });

    it('returns false for invalid URLs', () => {
      expect(checkOriginMatch('not-a-url', 'https://example.com')).toBe(false);
    });
  });

  // ─── Word Count ─────────────────────────────────────────────────────────

  describe('computeWordCount', () => {
    it('counts words in simple text', () => {
      expect(computeWordCount('hello world')).toBe(2);
    });

    it('handles multiple whitespace', () => {
      expect(computeWordCount('hello   world   foo')).toBe(3);
    });

    it('returns 0 for empty string', () => {
      expect(computeWordCount('')).toBe(0);
    });

    it('returns 0 for whitespace-only string', () => {
      expect(computeWordCount('   \t\n  ')).toBe(0);
    });

    it('counts hyphenated words as one', () => {
      expect(computeWordCount('well-known fact')).toBe(2);
    });
  });

  // ─── Image Count ────────────────────────────────────────────────────────

  describe('computeImageCount', () => {
    it('counts img tags', () => {
      expect(computeImageCount('<img src="a.jpg"><img src="b.png">')).toBe(2);
    });

    it('handles self-closing img tags', () => {
      expect(computeImageCount('<img src="a.jpg" />')).toBe(1);
    });

    it('is case-insensitive', () => {
      expect(computeImageCount('<IMG src="a.jpg"><Img src="b.png">')).toBe(2);
    });

    it('returns 0 when no images', () => {
      expect(computeImageCount('<p>Hello</p>')).toBe(0);
    });

    it('returns 0 for empty HTML', () => {
      expect(computeImageCount('')).toBe(0);
    });
  });

  // ─── JS Rendering Detection ─────────────────────────────────────────────

  describe('detectJsRendering', () => {
    it('returns true when text is short but HTML is large', () => {
      expect(detectJsRendering(50, 15_000)).toBe(true);
    });

    it('returns false when text is long enough', () => {
      expect(detectJsRendering(200, 15_000)).toBe(false);
    });

    it('returns false when HTML is small', () => {
      expect(detectJsRendering(50, 5_000)).toBe(false);
    });

    it('boundary: exactly 100 chars text does not trigger', () => {
      expect(detectJsRendering(100, 15_000)).toBe(false);
    });

    it('boundary: exactly 10000 bytes HTML does not trigger', () => {
      expect(detectJsRendering(50, 10_000)).toBe(false);
    });
  });

  // ─── HTML Truncation ────────────────────────────────────────────────────

  describe('truncateHtml', () => {
    it('does not truncate short HTML', () => {
      const html = '<p>Hello</p>';
      expect(truncateHtml(html, 50_000)).toBe(html);
    });

    it('truncates to max length', () => {
      const html = 'a'.repeat(60_000);
      const result = truncateHtml(html, 50_000);
      expect(result.length).toBe(50_000);
    });
  });

  // ─── Excerpt Generation ─────────────────────────────────────────────────

  describe('generateExcerpt', () => {
    it('returns full text if under limit', () => {
      expect(generateExcerpt('Short text')).toBe('Short text');
    });

    it('truncates long text with ellipsis', () => {
      const longText = 'word '.repeat(100);
      const result = generateExcerpt(longText, 50);
      expect(result.length).toBeLessThanOrEqual(52); // 50 + ellipsis char
      expect(result.endsWith('…')).toBe(true);
    });

    it('trims whitespace', () => {
      expect(generateExcerpt('  hello world  ')).toBe('hello world');
    });

    it('handles empty string', () => {
      expect(generateExcerpt('')).toBe('');
    });
  });

  // ─── Error Classification ───────────────────────────────────────────

  describe('classifyPreviewError', () => {
    it('classifies ValidationError as 400 VALIDATION_ERROR', () => {
      const result = classifyPreviewError(new ValidationError('SSRF blocked'));
      expect(result.status).toBe(400);
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.message).not.toContain('SSRF'); // sanitized
    });

    it('classifies timeout errors as 504 TIMEOUT', () => {
      const result = classifyPreviewError(new Error('Request timeout after 10s'));
      expect(result.status).toBe(504);
      expect(result.code).toBe('TIMEOUT');
    });

    it('classifies generic errors as 500 INTERNAL_ERROR', () => {
      const result = classifyPreviewError(new Error('Something unexpected'));
      expect(result.status).toBe(500);
      expect(result.code).toBe('INTERNAL_ERROR');
    });

    it('classifies non-Error thrown values as 500', () => {
      const result = classifyPreviewError('string error');
      expect(result.status).toBe(500);
      expect(result.code).toBe('INTERNAL_ERROR');
    });

    it('does not leak internal details in message', () => {
      const result = classifyPreviewError(new ValidationError('Private IP 10.0.0.1 blocked'));
      expect(result.message).not.toContain('10.0.0.1');
      expect(result.message).toBe('This URL cannot be previewed for security reasons');
    });
  });
});
