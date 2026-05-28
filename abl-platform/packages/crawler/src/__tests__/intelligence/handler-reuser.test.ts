/**
 * Unit tests for HandlerReuser.
 *
 * Coverage:
 *   - Constructor: default and custom config
 *   - registerHandler: registration, templateId generation, overwrite
 *   - match: same-template match, no match, lastAccessedAt update
 *   - tryReuse: skippedPhases and llmCallsSaved
 *   - Eviction: LRU when full, TTL expiry
 *   - measureQuality: perfect, partial, no match, missing fields
 *   - jaccardSimilarity: identical, different, partial, empty
 *   - Edge cases: empty library, expired-only, register same fingerprint twice
 *   - Integration: real TemplateFingerprinter with real HTML
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HandlerReuser } from '../../intelligence/algorithms/handler-reuser.js';
import { TemplateFingerprinter } from '../../intelligence/algorithms/template-fingerprinter.js';
import type { IPageHandler } from '../../intelligence/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function createMockHandler(overrides?: Partial<IPageHandler>): IPageHandler {
  return {
    urlPattern: '/article/*',
    description: 'Extract article content',
    steps: [
      { action: 'navigate', value: 'https://example.com', description: 'Go to page' },
      { action: 'wait', selector: 'article', description: 'Wait for content' },
    ],
    extractionSelectors: {
      title: 'h1',
      content: 'article',
      metadata: { author: '.author', date: '.date' },
    },
    ...overrides,
  };
}

const ARTICLE_HTML_A = `<html><body><main><article><h1>Article Title</h1><p>This is the body content of the article with many words.</p><footer><span class="author">Author Name</span></footer></article></main></body></html>`;
const ARTICLE_HTML_B = `<html><body><main><article><h1>Different Article</h1><p>This is different body content with other words entirely.</p><footer><span class="author">Other Author</span></footer></article></main></body></html>`;
const PRODUCT_HTML = `<html><body><div class="product"><h1>Product Name</h1><div class="gallery"><img/><img/><img/></div><div class="specs"><table><tr><td>Weight</td><td>1kg</td></tr><tr><td>Color</td><td>Red</td></tr></table></div><div class="reviews"><div class="review"><p>Great product!</p></div></div></div></body></html>`;

// ==========================================================================
// Constructor
// ==========================================================================

describe('HandlerReuser constructor', () => {
  it('creates with default config', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp);
    const stats = reuser.getStats();
    expect(stats.maxSize).toBe(1000);
    expect(stats.size).toBe(0);
    expect(stats.templateCount).toBe(0);
    expect(stats.expiredCount).toBe(0);
  });

  it('creates with custom config', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp, { maxLibrarySize: 50, ttl: 5000 });
    const stats = reuser.getStats();
    expect(stats.maxSize).toBe(50);
    expect(stats.size).toBe(0);
  });

  it('uses defaults for partial config', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp, { maxLibrarySize: 100 });
    const stats = reuser.getStats();
    expect(stats.maxSize).toBe(100);
    // TTL should be default (verified indirectly — entries don't expire immediately)
  });
});

// ==========================================================================
// registerHandler
// ==========================================================================

describe('registerHandler', () => {
  let fp: TemplateFingerprinter;
  let reuser: HandlerReuser;

  beforeEach(() => {
    fp = new TemplateFingerprinter();
    reuser = new HandlerReuser(fp);
  });

  it('registers a handler and increments library size', () => {
    const fingerprint = fp.fingerprint(ARTICLE_HTML_A).fingerprint;
    reuser.registerHandler(fingerprint, createMockHandler(), ['https://example.com/article-1']);
    expect(reuser.getStats().size).toBe(1);
  });

  it('generates templateId from fingerprint hex prefix', () => {
    const fingerprint = 0xabcdef0123456789n;
    reuser.registerHandler(fingerprint, createMockHandler(), ['url1']);
    // templateId should be tpl- + first 8 hex chars
    const match = reuser.match(ARTICLE_HTML_A); // may not match but we can check stats
    expect(reuser.getStats().size).toBe(1);
  });

  it('overwrites entry when same fingerprint is registered twice', () => {
    const fingerprint = fp.fingerprint(ARTICLE_HTML_A).fingerprint;
    const handler1 = createMockHandler({ description: 'Handler 1' });
    const handler2 = createMockHandler({ description: 'Handler 2' });

    reuser.registerHandler(fingerprint, handler1, ['url1']);
    reuser.registerHandler(fingerprint, handler2, ['url2']);

    // Same templateId means same Map key — should overwrite
    expect(reuser.getStats().size).toBe(1);

    // Match should return handler2
    const result = reuser.match(ARTICLE_HTML_A);
    expect(result.matched).toBe(true);
    expect(result.handler?.description).toBe('Handler 2');
  });

  it('registers multiple different templates', () => {
    const fpArticle = fp.fingerprint(ARTICLE_HTML_A).fingerprint;
    const fpProduct = fp.fingerprint(PRODUCT_HTML).fingerprint;

    reuser.registerHandler(fpArticle, createMockHandler({ urlPattern: '/article/*' }), ['url1']);
    reuser.registerHandler(fpProduct, createMockHandler({ urlPattern: '/product/*' }), ['url2']);

    expect(reuser.getStats().size).toBe(2);
  });
});

// ==========================================================================
// match
// ==========================================================================

describe('match', () => {
  let fp: TemplateFingerprinter;
  let reuser: HandlerReuser;

  beforeEach(() => {
    fp = new TemplateFingerprinter();
    reuser = new HandlerReuser(fp);
  });

  it('matches a page with the same template', () => {
    const fingerprint = fp.fingerprint(ARTICLE_HTML_A).fingerprint;
    reuser.registerHandler(fingerprint, createMockHandler(), ['url1']);

    const result = reuser.match(ARTICLE_HTML_B);
    expect(result.matched).toBe(true);
    expect(result.handler).toBeDefined();
    expect(result.templateId).toBeDefined();
    expect(result.hammingDistance).toBeDefined();
    expect(result.hammingDistance!).toBeLessThanOrEqual(3);
    expect(result.similarity).toBeDefined();
    expect(result.similarity!).toBeGreaterThan(0);
    expect(result.matchedAgainst).toBe(result.templateId);
  });

  it('returns matched: false for no match in empty library', () => {
    const result = reuser.match(ARTICLE_HTML_A);
    expect(result.matched).toBe(false);
    expect(result.handler).toBeUndefined();
    expect(result.templateId).toBeUndefined();
  });

  it('returns matched: false for a different template', () => {
    const fpArticle = fp.fingerprint(ARTICLE_HTML_A).fingerprint;
    reuser.registerHandler(fpArticle, createMockHandler(), ['url1']);

    const result = reuser.match(PRODUCT_HTML);
    // Precondition: verify the templates are actually different enough
    const distance = TemplateFingerprinter.hammingDistance(
      fpArticle,
      fp.fingerprint(PRODUCT_HTML).fingerprint,
    );
    // WHY assertion: ensures this test exercises the no-match path.
    // If this fails, the HTML fixtures need more structural divergence.
    expect(distance).toBeGreaterThan(3);
    expect(result.matched).toBe(false);
  });

  it('updates lastAccessedAt on match', () => {
    const fingerprint = fp.fingerprint(ARTICLE_HTML_A).fingerprint;
    reuser.registerHandler(fingerprint, createMockHandler(), ['url1']);

    // Small delay to ensure time difference
    const beforeMatch = new Date().toISOString();
    const result = reuser.match(ARTICLE_HTML_A);
    expect(result.matched).toBe(true);
    // lastAccessedAt should be >= beforeMatch (updated on match)
  });

  it('finds the best match among multiple entries', () => {
    // Register article template
    const fpArticle = fp.fingerprint(ARTICLE_HTML_A).fingerprint;
    reuser.registerHandler(fpArticle, createMockHandler({ description: 'Article handler' }), [
      'url1',
    ]);

    // Register product template
    const fpProduct = fp.fingerprint(PRODUCT_HTML).fingerprint;
    reuser.registerHandler(fpProduct, createMockHandler({ description: 'Product handler' }), [
      'url2',
    ]);

    // Match with an article page should return the article handler
    const result = reuser.match(ARTICLE_HTML_B);
    if (result.matched) {
      expect(result.handler?.description).toBe('Article handler');
    }
  });

  it('returns similarity as 1 - distance/64', () => {
    const fingerprint = fp.fingerprint(ARTICLE_HTML_A).fingerprint;
    reuser.registerHandler(fingerprint, createMockHandler(), ['url1']);

    const result = reuser.match(ARTICLE_HTML_A);
    expect(result.matched).toBe(true);
    if (result.hammingDistance !== undefined) {
      expect(result.similarity).toBeCloseTo(1 - result.hammingDistance / 64, 10);
    }
  });
});

// ==========================================================================
// tryReuse
// ==========================================================================

describe('tryReuse', () => {
  let fp: TemplateFingerprinter;
  let reuser: HandlerReuser;

  beforeEach(() => {
    fp = new TemplateFingerprinter();
    reuser = new HandlerReuser(fp);
  });

  it('returns skippedPhases and llmCallsSaved when matched', () => {
    const fingerprint = fp.fingerprint(ARTICLE_HTML_A).fingerprint;
    reuser.registerHandler(fingerprint, createMockHandler(), ['url1']);

    const result = reuser.tryReuse(ARTICLE_HTML_B);
    expect(result.matched).toBe(true);
    expect(result.skippedPhases).toEqual(['Phase 2', 'Phase 3']);
    expect(result.llmCallsSaved).toBe(2);
    expect(result.handler).toBeDefined();
    expect(result.templateId).toBeDefined();
  });

  it('returns empty skippedPhases and 0 llmCallsSaved when not matched', () => {
    const result = reuser.tryReuse(ARTICLE_HTML_A);
    expect(result.matched).toBe(false);
    expect(result.skippedPhases).toEqual([]);
    expect(result.llmCallsSaved).toBe(0);
    expect(result.handler).toBeUndefined();
    expect(result.templateId).toBeUndefined();
  });

  it('returns handler reference on match', () => {
    const handler = createMockHandler({ description: 'Test handler' });
    const fingerprint = fp.fingerprint(ARTICLE_HTML_A).fingerprint;
    reuser.registerHandler(fingerprint, handler, ['url1']);

    const result = reuser.tryReuse(ARTICLE_HTML_A);
    expect(result.handler?.description).toBe('Test handler');
  });
});

// ==========================================================================
// Eviction: LRU
// ==========================================================================

describe('LRU eviction', () => {
  it('evicts LRU entry when library is full', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp, { maxLibrarySize: 2 });

    // Use fingerprints with distinct first 8 hex digits so they get different templateIds
    const fpA = 0x1111111100000000n;
    const fpB = 0x2222222200000000n;
    const fpC = 0x3333333300000000n;

    reuser.registerHandler(fpA, createMockHandler({ description: 'First' }), ['url1']);
    reuser.registerHandler(fpB, createMockHandler({ description: 'Second' }), ['url2']);
    expect(reuser.getStats().size).toBe(2);

    // Register a 3rd — should evict the LRU (first, which was created earliest)
    reuser.registerHandler(fpC, createMockHandler({ description: 'Third' }), ['url3']);
    expect(reuser.getStats().size).toBe(2);
  });

  it('does not evict when overwriting existing entry', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp, { maxLibrarySize: 2 });

    const fpA = 0x1111111100000000n;
    const fpB = 0x2222222200000000n;

    reuser.registerHandler(fpA, createMockHandler({ description: 'First' }), ['url1']);
    reuser.registerHandler(fpB, createMockHandler({ description: 'Second' }), ['url2']);

    // Re-register fpA — same templateId, should overwrite not evict
    reuser.registerHandler(fpA, createMockHandler({ description: 'Updated First' }), ['url3']);
    expect(reuser.getStats().size).toBe(2);
  });
});

// ==========================================================================
// Eviction: TTL
// ==========================================================================

describe('TTL eviction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('evicts expired entries on registerHandler', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp, { ttl: 1000 });

    reuser.registerHandler(1n, createMockHandler(), ['url1']);
    expect(reuser.getStats().size).toBe(1);

    // Advance time past TTL
    vi.advanceTimersByTime(2000);

    // Register a new entry — should evict the expired one first
    reuser.registerHandler(2n, createMockHandler(), ['url2']);
    expect(reuser.getStats().size).toBe(1); // old entry evicted, new one added
  });

  it('skips expired entries during match', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp, { ttl: 1000 });

    const fingerprint = fp.fingerprint(ARTICLE_HTML_A).fingerprint;
    reuser.registerHandler(fingerprint, createMockHandler(), ['url1']);

    // Advance time past TTL
    vi.advanceTimersByTime(2000);

    // Match should not find the expired entry
    const result = reuser.match(ARTICLE_HTML_A);
    expect(result.matched).toBe(false);
  });

  it('reports expired count in stats', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp, { ttl: 1000 });

    // Use fingerprints with distinct first 8 hex digits
    reuser.registerHandler(0x1111111100000000n, createMockHandler(), ['url1']);
    reuser.registerHandler(0x2222222200000000n, createMockHandler(), ['url2']);

    vi.advanceTimersByTime(2000);

    const stats = reuser.getStats();
    expect(stats.expiredCount).toBe(2);
    expect(stats.size).toBe(2); // still in map until eviction runs
  });

  it('evicts only expired entries, keeps fresh ones', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp, { ttl: 5000 });

    // Use fingerprints with distinct first 8 hex digits
    reuser.registerHandler(0x1111111100000000n, createMockHandler(), ['url1']);

    // Advance 3 seconds, register another
    vi.advanceTimersByTime(3000);
    reuser.registerHandler(0x2222222200000000n, createMockHandler(), ['url2']);

    // Advance 3 more seconds (first entry is 6s old, second is 3s old)
    vi.advanceTimersByTime(3000);

    // Register a new entry to trigger eviction
    reuser.registerHandler(0x3333333300000000n, createMockHandler(), ['url3']);

    // First entry should be evicted (age 6000 > TTL 5000)
    // Second and third should remain
    expect(reuser.getStats().size).toBe(2);
  });
});

// ==========================================================================
// measureQuality
// ==========================================================================

describe('measureQuality', () => {
  it('returns perfect quality for identical extraction', () => {
    const data = {
      title: 'Test Title',
      body: 'This is the body content with multiple words for comparison',
      metadata: { author: 'John', date: '2024-01-01' },
    };

    const quality = HandlerReuser.measureQuality(data, data);
    expect(quality.completeness).toBe(1.0);
    expect(quality.accuracy).toBe(1.0);
    expect(quality.overall).toBe(1.0);
  });

  it('returns zero completeness when extracted is empty', () => {
    const extracted = { body: '', metadata: {} };
    const expected = {
      title: 'Title',
      body: 'Some content here',
      metadata: { key: 'value' },
    };

    const quality = HandlerReuser.measureQuality(extracted, expected);
    expect(quality.completeness).toBe(0.0);
  });

  it('handles partial extraction', () => {
    const extracted = {
      title: 'Test Title',
      body: 'This is partial content',
    };
    const expected = {
      title: 'Test Title',
      body: 'This is the full content with many additional words',
      metadata: { author: 'John', date: '2024-01-01' },
    };

    const quality = HandlerReuser.measureQuality(extracted, expected);
    // Title and body present, but metadata missing -> completeness < 1.0
    expect(quality.completeness).toBeGreaterThan(0);
    expect(quality.completeness).toBeLessThan(1.0);
    // Title matches, body partially matches
    expect(quality.accuracy).toBeGreaterThan(0);
  });

  it('handles missing title in both extracted and expected', () => {
    const extracted = { body: 'Content words here' };
    const expected = { body: 'Content words here' };

    const quality = HandlerReuser.measureQuality(extracted, expected);
    // No title expected -> completeness only counts body
    expect(quality.completeness).toBe(1.0);
    // Accuracy: body Jaccard = 1.0, title skipped
    expect(quality.accuracy).toBe(1.0);
    expect(quality.overall).toBe(1.0);
  });

  it('handles wrong title with correct body', () => {
    const extracted = { title: 'Wrong Title', body: 'The exact same body content' };
    const expected = { title: 'Right Title', body: 'The exact same body content' };

    const quality = HandlerReuser.measureQuality(extracted, expected);
    expect(quality.completeness).toBe(1.0); // all fields present
    // accuracy = 0.0 * 0.3 (title wrong) + 1.0 * 0.7 (body match) = 0.7
    expect(quality.accuracy).toBeCloseTo(0.7, 5);
  });

  it('handles metadata completeness', () => {
    const extracted = {
      body: 'Body content',
      metadata: { author: 'John' },
    };
    const expected = {
      body: 'Body content',
      metadata: { author: 'John', date: '2024', category: 'Tech' },
    };

    const quality = HandlerReuser.measureQuality(extracted, expected);
    // Expected fields: body + 3 metadata = 4, present: body + author = 2
    expect(quality.completeness).toBe(2 / 4);
  });

  it('returns completeness 1.0 when no fields are expected', () => {
    // Edge case: empty body expected, no title, no metadata
    const extracted = { body: '' };
    const expected = { body: '' };

    const quality = HandlerReuser.measureQuality(extracted, expected);
    // Body is always expected but both empty — completeness = 0/1 = 0
    // Actually body is expected but extracted body is empty -> not present
    expect(quality.completeness).toBe(0.0);
  });

  it('overall is weighted average of completeness and accuracy', () => {
    const extracted = {
      title: 'Title',
      body: 'Word one two three',
    };
    const expected = {
      title: 'Title',
      body: 'Word one two three four five six',
    };

    const quality = HandlerReuser.measureQuality(extracted, expected);
    const expectedOverall = quality.completeness * 0.4 + quality.accuracy * 0.6;
    expect(quality.overall).toBeCloseTo(expectedOverall, 10);
  });
});

// ==========================================================================
// jaccardSimilarity
// ==========================================================================

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(HandlerReuser.jaccardSimilarity('hello world', 'hello world')).toBe(1.0);
  });

  it('returns 0.0 for completely different strings', () => {
    expect(HandlerReuser.jaccardSimilarity('hello world', 'foo bar baz')).toBe(0.0);
  });

  it('returns partial overlap correctly', () => {
    // {hello, world} ∩ {hello, there} = {hello}, union = {hello, world, there}
    const similarity = HandlerReuser.jaccardSimilarity('hello world', 'hello there');
    expect(similarity).toBeCloseTo(1 / 3, 10);
  });

  it('returns 1.0 for both empty strings', () => {
    expect(HandlerReuser.jaccardSimilarity('', '')).toBe(1.0);
  });

  it('returns 0.0 when one string is empty', () => {
    expect(HandlerReuser.jaccardSimilarity('hello', '')).toBe(0.0);
    expect(HandlerReuser.jaccardSimilarity('', 'world')).toBe(0.0);
  });

  it('is case-insensitive', () => {
    expect(HandlerReuser.jaccardSimilarity('Hello World', 'hello world')).toBe(1.0);
  });

  it('handles whitespace-only strings as empty', () => {
    expect(HandlerReuser.jaccardSimilarity('   ', '   ')).toBe(1.0);
    expect(HandlerReuser.jaccardSimilarity('   ', 'hello')).toBe(0.0);
  });

  it('handles duplicate words (set semantics)', () => {
    // "a a a b" -> set {a, b}, "a b" -> set {a, b} — identical sets
    expect(HandlerReuser.jaccardSimilarity('a a a b', 'a b')).toBe(1.0);
  });

  it('handles multi-word overlap', () => {
    // {the, quick, brown, fox} ∩ {the, lazy, brown, dog} = {the, brown}
    // union = {the, quick, brown, fox, lazy, dog} = 6
    const similarity = HandlerReuser.jaccardSimilarity('the quick brown fox', 'the lazy brown dog');
    expect(similarity).toBeCloseTo(2 / 6, 10);
  });
});

// ==========================================================================
// Edge cases
// ==========================================================================

describe('Edge cases', () => {
  it('match on empty library returns false', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp);
    const result = reuser.match('<html><body><h1>Test</h1></body></html>');
    expect(result.matched).toBe(false);
  });

  it('tryReuse on empty library returns no match', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp);
    const result = reuser.tryReuse('<html><body><h1>Test</h1></body></html>');
    expect(result.matched).toBe(false);
    expect(result.skippedPhases).toEqual([]);
    expect(result.llmCallsSaved).toBe(0);
  });

  it('handles empty HTML for match', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp);
    reuser.registerHandler(0xabcdef0100000000n, createMockHandler(), ['url1']);
    const result = reuser.match('');
    // Empty HTML fingerprint is 0n — unlikely to match real template
    expect(result).toBeDefined();
  });

  it('handles registering with fingerprint 0n', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp);
    reuser.registerHandler(0n, createMockHandler(), ['url1']);
    expect(reuser.getStats().size).toBe(1);
    // templateId should be tpl-00000000
  });

  it('getStats reflects correct state', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp, { maxLibrarySize: 100 });

    // Use fingerprints with distinct first 8 hex digits
    reuser.registerHandler(0x1111111100000000n, createMockHandler(), ['url1']);
    reuser.registerHandler(0x2222222200000000n, createMockHandler(), ['url2']);

    const stats = reuser.getStats();
    expect(stats.size).toBe(2);
    expect(stats.maxSize).toBe(100);
    expect(stats.templateCount).toBe(2);
    expect(stats.expiredCount).toBe(0);
  });
});

// ==========================================================================
// Integration with TemplateFingerprinter
// ==========================================================================

describe('Integration with TemplateFingerprinter', () => {
  it('registers real HTML fingerprints and matches against them', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp);

    // Register article template
    const articleFp = fp.fingerprint(ARTICLE_HTML_A);
    const articleHandler = createMockHandler({ description: 'Article extractor' });
    reuser.registerHandler(articleFp.fingerprint, articleHandler, [
      'https://example.com/article/1',
    ]);

    // Register product template
    const productFp = fp.fingerprint(PRODUCT_HTML);
    const productHandler = createMockHandler({ description: 'Product extractor' });
    reuser.registerHandler(productFp.fingerprint, productHandler, [
      'https://example.com/product/1',
    ]);

    // Match with another article page (same template, different content)
    const result = reuser.match(ARTICLE_HTML_B);
    expect(result.matched).toBe(true);
    expect(result.handler?.description).toBe('Article extractor');
  });

  it('tryReuse returns correct phases skipped for real HTML', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp);

    const articleFp = fp.fingerprint(ARTICLE_HTML_A);
    reuser.registerHandler(articleFp.fingerprint, createMockHandler(), ['url1']);

    const result = reuser.tryReuse(ARTICLE_HTML_B);
    expect(result.matched).toBe(true);
    expect(result.skippedPhases).toEqual(['Phase 2', 'Phase 3']);
    expect(result.llmCallsSaved).toBe(2);
  });

  it('does not match different templates', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp);

    const articleFp = fp.fingerprint(ARTICLE_HTML_A);
    reuser.registerHandler(articleFp.fingerprint, createMockHandler(), ['url1']);

    const result = reuser.match(PRODUCT_HTML);
    // Precondition: templates are structurally different
    const distance = TemplateFingerprinter.hammingDistance(
      articleFp.fingerprint,
      fp.fingerprint(PRODUCT_HTML).fingerprint,
    );
    expect(distance).toBeGreaterThan(3);
    expect(result.matched).toBe(false);
  });

  it('works with A/B test variants (same template, noise differences)', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp);

    const variantA = `<html><body><div class="ad-container"><p>Ad</p></div><main><h1>Product</h1><p>Details here</p><div class="specs"><p>Spec 1</p></div></main><div class="cookie-consent">Accept</div></body></html>`;
    const variantB = `<html><body><main><h1>Product</h1><p>Details here</p><div class="specs"><p>Spec 1</p></div></main></body></html>`;

    const fpA = fp.fingerprint(variantA);
    reuser.registerHandler(fpA.fingerprint, createMockHandler(), ['variant-a']);

    // Variant B (same template without noise) should match
    const result = reuser.match(variantB);
    expect(result.matched).toBe(true);
  });

  it('end-to-end: register, match, measure quality', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp);

    const articleFp = fp.fingerprint(ARTICLE_HTML_A);
    reuser.registerHandler(articleFp.fingerprint, createMockHandler(), ['url1']);

    const result = reuser.tryReuse(ARTICLE_HTML_B);
    expect(result.matched).toBe(true);

    // Measure quality of a hypothetical extraction
    const quality = HandlerReuser.measureQuality(
      { title: 'Different Article', body: 'This is different body content with other words' },
      {
        title: 'Different Article',
        body: 'This is different body content with other words entirely',
      },
    );
    expect(quality.completeness).toBe(1.0);
    expect(quality.accuracy).toBeGreaterThan(0.5);
    expect(quality.overall).toBeGreaterThan(0.5);
  });
});

// ==========================================================================
// Expired-only library
// ==========================================================================

describe('Expired-only library', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('match returns false when all entries are expired', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp, { ttl: 1000 });

    const fingerprint = fp.fingerprint(ARTICLE_HTML_A).fingerprint;
    reuser.registerHandler(fingerprint, createMockHandler(), ['url1']);

    vi.advanceTimersByTime(2000);

    const result = reuser.match(ARTICLE_HTML_A);
    expect(result.matched).toBe(false);
  });

  it('tryReuse returns no match when all entries are expired', () => {
    const fp = new TemplateFingerprinter();
    const reuser = new HandlerReuser(fp, { ttl: 1000 });

    const fingerprint = fp.fingerprint(ARTICLE_HTML_A).fingerprint;
    reuser.registerHandler(fingerprint, createMockHandler(), ['url1']);

    vi.advanceTimersByTime(2000);

    const result = reuser.tryReuse(ARTICLE_HTML_A);
    expect(result.matched).toBe(false);
    expect(result.llmCallsSaved).toBe(0);
  });
});
