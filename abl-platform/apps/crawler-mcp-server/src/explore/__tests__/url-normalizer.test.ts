/**
 * URL Normalizer — Pure Function Tests
 *
 * Tests all 4 exported functions from url-normalizer.ts:
 * normalizeUrl, isSameDomain, extractDomain, urlToLabel
 */

import { describe, it, expect } from 'vitest';
import { normalizeUrl, isSameDomain, extractDomain, urlToLabel } from '../url-normalizer.js';

// ─── normalizeUrl ────────────────────────────────────────────────────

describe('normalizeUrl', () => {
  const cases: Array<[string, string, string]> = [
    ['lowercases hostname', 'https://EXAMPLE.COM/Path', 'https://example.com/Path'],
    ['removes fragment', 'https://example.com/page#section', 'https://example.com/page'],
    ['removes trailing slash', 'https://example.com/path/', 'https://example.com/path'],
    ['strips root trailing slash', 'https://example.com/', 'https://example.com'],
    ['strips utm_source', 'https://example.com/page?utm_source=google', 'https://example.com/page'],
    ['strips utm_medium', 'https://example.com/page?utm_medium=cpc', 'https://example.com/page'],
    [
      'strips utm_campaign',
      'https://example.com/page?utm_campaign=spring',
      'https://example.com/page',
    ],
    [
      'strips utm_content',
      'https://example.com/page?utm_content=header',
      'https://example.com/page',
    ],
    ['strips utm_term', 'https://example.com/page?utm_term=printers', 'https://example.com/page'],
    ['strips fbclid', 'https://example.com/page?fbclid=abc123', 'https://example.com/page'],
    ['strips gclid', 'https://example.com/page?gclid=xyz789', 'https://example.com/page'],
    ['strips msclkid', 'https://example.com/page?msclkid=ms123', 'https://example.com/page'],
    ['strips dclid', 'https://example.com/page?dclid=dc456', 'https://example.com/page'],
    ['strips twclid', 'https://example.com/page?twclid=tw789', 'https://example.com/page'],
    ['strips ref', 'https://example.com/page?ref=homepage', 'https://example.com/page'],
    [
      'keeps non-tracking params',
      'https://example.com/page?category=printers&page=2',
      'https://example.com/page?category=printers&page=2',
    ],
    [
      'sorts query params',
      'https://example.com/page?z=1&a=2&m=3',
      'https://example.com/page?a=2&m=3&z=1',
    ],
    [
      'strips tracking but keeps others sorted',
      'https://example.com/page?utm_source=x&b=2&a=1',
      'https://example.com/page?a=1&b=2',
    ],
    ['strips www prefix', 'https://www.example.com/path', 'https://example.com/path'],
    [
      'strips www with tracking params',
      'https://www.epson.com/printers?utm_source=google',
      'https://epson.com/printers',
    ],
    ['strips www from root URL', 'https://www.example.com/', 'https://example.com'],
    ['adds https protocol', 'example.com/path', 'https://example.com/path'],
    ['handles http protocol', 'http://example.com/path', 'http://example.com/path'],
    [
      'combined: www + trailing slash + fragment + tracking',
      'https://WWW.EXAMPLE.COM/path/?utm_source=x#top',
      'https://example.com/path',
    ],
    ['passthrough on invalid URL', 'not a url %%%', 'not a url %%%'],
    ['handles URL with port', 'https://example.com:8080/path', 'https://example.com:8080/path'],
  ];

  it.each(cases)('%s', (_desc, input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it('produces identical output for URLs differing only by tracking params', () => {
    const a = normalizeUrl('https://epson.com/printers?utm_source=google&page=1');
    const b = normalizeUrl('https://epson.com/printers?utm_campaign=spring&page=1');
    expect(a).toBe(b);
  });

  it('produces different output for URLs with different meaningful params', () => {
    const a = normalizeUrl('https://epson.com/printers?page=1');
    const b = normalizeUrl('https://epson.com/printers?page=2');
    expect(a).not.toBe(b);
  });

  it('strips multiple tracking params at once', () => {
    const result = normalizeUrl(
      'https://example.com/page?utm_source=g&utm_medium=cpc&utm_campaign=spring&fbclid=abc&keep=yes',
    );
    expect(result).toBe('https://example.com/page?keep=yes');
  });

  it('handles URL with no path', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
  });
});

// ─── isSameDomain ────────────────────────────────────────────────────

describe('isSameDomain', () => {
  it('returns true for same domain', () => {
    expect(isSameDomain('https://epson.com/printers', 'https://epson.com/scanners')).toBe(true);
  });

  it('returns true regardless of case', () => {
    expect(isSameDomain('https://EPSON.COM/printers', 'https://epson.com/scanners')).toBe(true);
  });

  it('returns false for different domains', () => {
    expect(isSameDomain('https://epson.com/printers', 'https://canon.com/printers')).toBe(false);
  });

  it('returns true for www vs non-www (same domain)', () => {
    expect(isSameDomain('https://www.epson.com/printers', 'https://epson.com/scanners')).toBe(true);
  });

  it('returns true for non-www vs www (same domain)', () => {
    expect(isSameDomain('https://epson.com/printers', 'https://www.epson.com/scanners')).toBe(true);
  });

  it('returns false for subdomain vs root', () => {
    expect(isSameDomain('https://support.epson.com/page', 'https://epson.com/page')).toBe(false);
  });

  it('returns false for invalid URLs', () => {
    expect(isSameDomain('not-a-url', 'https://epson.com')).toBe(false);
  });

  it('returns false when both URLs are invalid', () => {
    expect(isSameDomain('not-a-url', 'also-not-a-url')).toBe(false);
  });

  it('returns true for same domain with different paths and ports', () => {
    expect(isSameDomain('https://example.com:443/path-a', 'https://example.com:443/path-b')).toBe(
      true,
    );
  });

  it('returns true for same domain with different protocols', () => {
    expect(isSameDomain('http://example.com/path', 'https://example.com/other')).toBe(true);
  });
});

// ─── extractDomain ───────────────────────────────────────────────────

describe('extractDomain', () => {
  it('extracts domain from full URL', () => {
    expect(extractDomain('https://www.epson.com/path')).toBe('epson.com');
  });

  it('strips www prefix', () => {
    expect(extractDomain('https://www.example.com')).toBe('example.com');
  });

  it('handles URL without www', () => {
    expect(extractDomain('https://example.com')).toBe('example.com');
  });

  it('handles bare domain input', () => {
    expect(extractDomain('example.com')).toBe('example.com');
  });

  it('handles subdomain', () => {
    expect(extractDomain('https://support.epson.com/page')).toBe('support.epson.com');
  });

  it('lowercases the domain', () => {
    expect(extractDomain('https://WWW.EXAMPLE.COM')).toBe('example.com');
  });

  it('handles domain with port', () => {
    expect(extractDomain('https://example.com:8080/path')).toBe('example.com');
  });
});

// ─── urlToLabel ──────────────────────────────────────────────────────

describe('urlToLabel', () => {
  it('returns last path segment', () => {
    expect(urlToLabel('https://epson.com/Support/Printers/All-In-Ones')).toBe('All-In-Ones');
  });

  it('decodes URI components', () => {
    expect(urlToLabel('https://example.com/path/%E4%B8%AD%E6%96%87')).toContain('中文');
  });

  it('returns "/" for root URL', () => {
    expect(urlToLabel('https://example.com/')).toBe('/');
  });

  it('returns input on invalid URL', () => {
    expect(urlToLabel('not-a-url')).toBe('not-a-url');
  });

  it('returns last segment when path has trailing slash', () => {
    // URL constructor keeps trailing slash in pathname, so filter(Boolean) handles it
    expect(urlToLabel('https://example.com/support/printers/')).toBe('printers');
  });

  it('handles single path segment', () => {
    expect(urlToLabel('https://example.com/about')).toBe('about');
  });

  it('handles encoded spaces', () => {
    expect(urlToLabel('https://example.com/my%20page')).toBe('my page');
  });
});
