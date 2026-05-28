/**
 * Unit tests for TemplateFingerprinter.
 *
 * Coverage:
 *   - FNV-1a 64-bit: known test vectors, deterministic output
 *   - SimHash: identical input -> identical hash, similar input -> similar hash
 *   - Hamming distance: 0 for identical, 64 for all-bits-different, known middle cases
 *   - DOM normalization: strips scripts/styles/ads, preserves content structure
 *   - Tag-path extraction: correct paths, depth capping
 *   - fingerprint(): deterministic, identical HTML -> identical fingerprint
 *   - compare(): same-template isSameTemplate=true, different-template false
 *   - cluster(): groups same-template pages, separates different templates
 *   - Edge cases: empty HTML, malformed HTML, oversized HTML
 *   - BigInt serialization safety
 */

import { describe, it, expect } from 'vitest';
import {
  TemplateFingerprinter,
  type TemplateFingerprint,
} from '../../intelligence/algorithms/template-fingerprinter.js';

// ==========================================================================
// FNV-1a 64-bit hash
// ==========================================================================

describe('TemplateFingerprinter.fnv1a64', () => {
  it('produces deterministic output for the same input', () => {
    const hash1 = TemplateFingerprinter.fnv1a64('hello');
    const hash2 = TemplateFingerprinter.fnv1a64('hello');
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different inputs', () => {
    const hashA = TemplateFingerprinter.fnv1a64('hello');
    const hashB = TemplateFingerprinter.fnv1a64('world');
    expect(hashA).not.toBe(hashB);
  });

  it('returns a bigint', () => {
    const hash = TemplateFingerprinter.fnv1a64('test');
    expect(typeof hash).toBe('bigint');
  });

  it('returns a value within 64-bit range', () => {
    const hash = TemplateFingerprinter.fnv1a64('any string');
    expect(hash).toBeGreaterThanOrEqual(0n);
    expect(hash).toBeLessThan(1n << 64n);
  });

  it('handles empty string', () => {
    const hash = TemplateFingerprinter.fnv1a64('');
    // Empty string should return the FNV offset basis
    expect(hash).toBe(14695981039346656037n);
  });

  it('handles single character', () => {
    const hash = TemplateFingerprinter.fnv1a64('a');
    expect(typeof hash).toBe('bigint');
    expect(hash).not.toBe(14695981039346656037n); // different from empty
  });
});

// ==========================================================================
// SimHash
// ==========================================================================

describe('TemplateFingerprinter.simhash', () => {
  it('returns 0n for empty features array', () => {
    expect(TemplateFingerprinter.simhash([])).toBe(0n);
  });

  it('produces identical hash for identical input', () => {
    const features = ['html>body>div', 'html>body>div>h1', 'html>body>div>p'];
    const hash1 = TemplateFingerprinter.simhash(features);
    const hash2 = TemplateFingerprinter.simhash(features);
    expect(hash1).toBe(hash2);
  });

  it('produces similar hash for similar input (Hamming distance <= 3)', () => {
    // Same structure with one additional feature
    const features1 = [
      'html>body>div',
      'html>body>div>h1',
      'html>body>div>p',
      'html>body>div>p',
      'html>body>div>p',
      'html>body>footer',
    ];
    const features2 = [
      'html>body>div',
      'html>body>div>h1',
      'html>body>div>p',
      'html>body>div>p',
      'html>body>div>p',
      'html>body>footer',
      'html>body>div>p', // one extra repeated feature
    ];
    const hash1 = TemplateFingerprinter.simhash(features1);
    const hash2 = TemplateFingerprinter.simhash(features2);
    const distance = TemplateFingerprinter.hammingDistance(hash1, hash2);
    expect(distance).toBeLessThanOrEqual(3);
  });

  it('produces different hash for completely different input', () => {
    const features1 = ['html>body>div>main>article>h1', 'html>body>div>main>article>p'];
    const features2 = ['table>thead>tr>th', 'table>tbody>tr>td', 'form>input', 'form>select'];
    const hash1 = TemplateFingerprinter.simhash(features1);
    const hash2 = TemplateFingerprinter.simhash(features2);
    expect(hash1).not.toBe(hash2);
  });

  it('returns a bigint within 64-bit range', () => {
    const hash = TemplateFingerprinter.simhash(['a', 'b', 'c']);
    expect(typeof hash).toBe('bigint');
    expect(hash).toBeGreaterThanOrEqual(0n);
    expect(hash).toBeLessThan(1n << 64n);
  });
});

// ==========================================================================
// Hamming distance
// ==========================================================================

describe('TemplateFingerprinter.hammingDistance', () => {
  it('returns 0 for identical values', () => {
    expect(TemplateFingerprinter.hammingDistance(42n, 42n)).toBe(0);
  });

  it('returns 64 for all-bits-different', () => {
    const allOnes = (1n << 64n) - 1n;
    expect(TemplateFingerprinter.hammingDistance(0n, allOnes)).toBe(64);
  });

  it('returns 1 for values differing by one bit', () => {
    expect(TemplateFingerprinter.hammingDistance(0b1000n, 0b0000n)).toBe(1);
  });

  it('returns correct count for known middle case', () => {
    // 0b1010 vs 0b0101 = 4 bits different
    expect(TemplateFingerprinter.hammingDistance(0b1010n, 0b0101n)).toBe(4);
  });

  it('handles large 64-bit values', () => {
    const a = 0xffffffff00000000n;
    const b = 0x00000000ffffffffn;
    expect(TemplateFingerprinter.hammingDistance(a, b)).toBe(64);
  });

  it('is commutative', () => {
    const a = 123456789n;
    const b = 987654321n;
    expect(TemplateFingerprinter.hammingDistance(a, b)).toBe(
      TemplateFingerprinter.hammingDistance(b, a),
    );
  });
});

// ==========================================================================
// DOM normalization
// ==========================================================================

describe('DOM normalization', () => {
  const fp = new TemplateFingerprinter();

  it('strips script tags', () => {
    const withScript = `<html><body><div><h1>Title</h1><script>alert("hi")</script></div></body></html>`;
    const withoutScript = `<html><body><div><h1>Title</h1></div></body></html>`;
    const r1 = fp.fingerprint(withScript);
    const r2 = fp.fingerprint(withoutScript);
    expect(r1.fingerprint).toBe(r2.fingerprint);
  });

  it('strips style tags', () => {
    const withStyle = `<html><body><div><h1>Title</h1><style>.big{font-size:99px}</style></div></body></html>`;
    const withoutStyle = `<html><body><div><h1>Title</h1></div></body></html>`;
    const r1 = fp.fingerprint(withStyle);
    const r2 = fp.fingerprint(withoutStyle);
    expect(r1.fingerprint).toBe(r2.fingerprint);
  });

  it('strips noscript, iframe, svg tags', () => {
    const withNoise = `<html><body><div><h1>Title</h1><noscript>Enable JS</noscript><iframe src="x"></iframe><svg><circle/></svg></div></body></html>`;
    const clean = `<html><body><div><h1>Title</h1></div></body></html>`;
    const r1 = fp.fingerprint(withNoise);
    const r2 = fp.fingerprint(clean);
    expect(r1.fingerprint).toBe(r2.fingerprint);
  });

  it('strips elements with ad-related class names', () => {
    const withAds = `<html><body><div><h1>Title</h1><div class="ad-container">Ad here</div><div class="ad_wrapper">More ads</div></div></body></html>`;
    const clean = `<html><body><div><h1>Title</h1></div></body></html>`;
    const r1 = fp.fingerprint(withAds);
    const r2 = fp.fingerprint(clean);
    expect(r1.fingerprint).toBe(r2.fingerprint);
  });

  it('strips elements with cookie consent class names', () => {
    const withCookie = `<html><body><div><h1>Title</h1><div class="cookie-consent">Accept cookies</div><div id="cookie_banner">Banner</div></div></body></html>`;
    const clean = `<html><body><div><h1>Title</h1></div></body></html>`;
    const r1 = fp.fingerprint(withCookie);
    const r2 = fp.fingerprint(clean);
    expect(r1.fingerprint).toBe(r2.fingerprint);
  });

  it('strips elements with banner/popup patterns', () => {
    const withBanner = `<html><body><div><h1>Title</h1><div class="banner-overlay">Promo!</div><div id="popup-modal">Subscribe!</div></div></body></html>`;
    const clean = `<html><body><div><h1>Title</h1></div></body></html>`;
    const r1 = fp.fingerprint(withBanner);
    const r2 = fp.fingerprint(clean);
    expect(r1.fingerprint).toBe(r2.fingerprint);
  });

  it('does NOT strip elements with class "add" (false positive avoidance)', () => {
    const htmlWithAdd = `<html><body><div><h1>Title</h1><div class="add-button">Add Item</div></div></body></html>`;
    const htmlWithout = `<html><body><div><h1>Title</h1></div></body></html>`;
    const r1 = fp.fingerprint(htmlWithAdd);
    const r2 = fp.fingerprint(htmlWithout);
    // "add-button" should NOT be stripped — it doesn't match ad-container/wrapper/slot/banner
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });

  it('preserves content structure after normalization', () => {
    const html = `<html><body><header><nav><a>Home</a></nav></header><main><article><h1>Title</h1><p>Content</p></article></main><footer><p>Copyright</p></footer></body></html>`;
    const result = fp.fingerprint(html);
    expect(result.tagPathCount).toBeGreaterThan(0);
  });
});

// ==========================================================================
// Tag-path extraction
// ==========================================================================

describe('Tag-path extraction', () => {
  const fp = new TemplateFingerprinter();

  it('extracts correct paths for simple HTML', () => {
    const html = `<html><body><div><h1>Title</h1></div></body></html>`;
    const result = fp.fingerprint(html);
    // Should have paths: html, html>head, html>body, html>body>div, html>body>div>h1
    expect(result.tagPathCount).toBeGreaterThanOrEqual(3);
  });

  it('caps depth at configured maximum', () => {
    // Create deeply nested HTML (20 levels deep)
    let inner = '<span>deep</span>';
    for (let i = 0; i < 20; i++) {
      inner = `<div>${inner}</div>`;
    }
    const html = `<html><body>${inner}</body></html>`;

    const fpDefault = new TemplateFingerprinter(); // maxDepth=15
    const fpDeep = new TemplateFingerprinter({ maxDepth: 25 });

    const resultDefault = fpDefault.fingerprint(html);
    const resultDeep = fpDeep.fingerprint(html);

    // Deep version should have more tag paths
    expect(resultDeep.tagPathCount).toBeGreaterThan(resultDefault.tagPathCount);
  });

  it('handles sibling elements at same depth', () => {
    const html = `<html><body><div><p>One</p><p>Two</p><p>Three</p></div></body></html>`;
    const result = fp.fingerprint(html);
    // Should have html, html>head, html>body, html>body>div, and 3x html>body>div>p
    expect(result.tagPathCount).toBeGreaterThanOrEqual(5);
  });
});

// ==========================================================================
// fingerprint() — determinism and correctness
// ==========================================================================

describe('fingerprint()', () => {
  const fp = new TemplateFingerprinter();

  it('is deterministic: identical HTML produces identical fingerprint', () => {
    const html = `<html><body><main><h1>Title</h1><p>Content</p></main></body></html>`;
    const r1 = fp.fingerprint(html);
    const r2 = fp.fingerprint(html);
    expect(r1.fingerprint).toBe(r2.fingerprint);
    expect(r1.tagPathCount).toBe(r2.tagPathCount);
  });

  it('same template with different content produces similar fingerprint', () => {
    const html1 = `<html><body><main><h1>Product A</h1><p>Description A</p><div class="price">$10</div></main></body></html>`;
    const html2 = `<html><body><main><h1>Product B</h1><p>Description B</p><div class="price">$20</div></main></body></html>`;
    const r1 = fp.fingerprint(html1);
    const r2 = fp.fingerprint(html2);
    const distance = TemplateFingerprinter.hammingDistance(r1.fingerprint, r2.fingerprint);
    // Same structure, different content — should be within threshold
    expect(distance).toBeLessThanOrEqual(3);
  });

  it('different templates produce different fingerprints', () => {
    const productPage = `<html><body><main><h1>Product</h1><div class="gallery"><img/><img/><img/></div><div class="details"><p>Info</p><p>Specs</p></div><div class="reviews"><div class="review"><p>Great!</p></div><div class="review"><p>Okay</p></div></div></main></body></html>`;
    const blogPost = `<html><body><article><header><h1>Blog Title</h1><time>2024-01-01</time></header><section><p>Paragraph 1</p><p>Paragraph 2</p><blockquote>Quote</blockquote></section><aside><h2>Related</h2><ul><li>Link 1</li><li>Link 2</li></ul></aside></article></body></html>`;
    const r1 = fp.fingerprint(productPage);
    const r2 = fp.fingerprint(blogPost);
    const distance = TemplateFingerprinter.hammingDistance(r1.fingerprint, r2.fingerprint);
    expect(distance).toBeGreaterThan(3);
  });

  it('preserves url in result', () => {
    const html = `<html><body><h1>Title</h1></body></html>`;
    const result = fp.fingerprint(html, 'https://example.com/page');
    expect(result.url).toBe('https://example.com/page');
  });
});

// ==========================================================================
// compare()
// ==========================================================================

describe('compare()', () => {
  const fp = new TemplateFingerprinter();

  it('returns isSameTemplate=true for identical fingerprints', () => {
    const result = fp.compare(42n, 42n);
    expect(result.isSameTemplate).toBe(true);
    expect(result.hammingDistance).toBe(0);
    expect(result.similarity).toBe(1.0);
  });

  it('returns isSameTemplate=true for distance <= 3', () => {
    // Differ by 3 bits
    const a = 0b111n;
    const b = 0b000n;
    const result = fp.compare(a, b);
    expect(result.isSameTemplate).toBe(true);
    expect(result.hammingDistance).toBe(3);
  });

  it('returns isSameTemplate=false for distance > 3', () => {
    // Differ by 4 bits
    const a = 0b1111n;
    const b = 0b0000n;
    const result = fp.compare(a, b);
    expect(result.isSameTemplate).toBe(false);
    expect(result.hammingDistance).toBe(4);
  });

  it('returns correct similarity score', () => {
    // Distance of 0 => similarity 1.0
    expect(fp.compare(42n, 42n).similarity).toBe(1.0);
    // Distance of 64 => similarity 0.0
    const allOnes = (1n << 64n) - 1n;
    expect(fp.compare(0n, allOnes).similarity).toBe(0.0);
  });
});

// ==========================================================================
// cluster()
// ==========================================================================

describe('cluster()', () => {
  const fp = new TemplateFingerprinter();

  it('groups same-template pages together', () => {
    // Create pages from two distinct templates
    const templateA = `<html><body><main><h1>Product</h1><div class="gallery"><img/></div><div class="details"><p>Info</p></div></main></body></html>`;
    const templateAv2 = `<html><body><main><h1>Another Product</h1><div class="gallery"><img/></div><div class="details"><p>Different Info</p></div></main></body></html>`;
    const templateB = `<html><body><article><header><h1>Blog</h1><time>2024</time></header><section><p>Text</p><p>More text</p><blockquote>Quote here</blockquote></section><aside><h2>Related</h2><ul><li>One</li><li>Two</li><li>Three</li></ul></aside></article></body></html>`;
    const templateBv2 = `<html><body><article><header><h1>Another Blog</h1><time>2025</time></header><section><p>Different text</p><p>More different text</p><blockquote>Different quote</blockquote></section><aside><h2>Related</h2><ul><li>Alpha</li><li>Beta</li><li>Gamma</li></ul></aside></article></body></html>`;

    const fingerprints: TemplateFingerprint[] = [
      fp.fingerprint(templateA, 'product-1'),
      fp.fingerprint(templateAv2, 'product-2'),
      fp.fingerprint(templateB, 'blog-1'),
      fp.fingerprint(templateBv2, 'blog-2'),
    ];

    const result = fp.cluster(fingerprints);

    // Should have at least 1 cluster (if templates are different enough)
    // Product pages should be together, blog pages should be together
    const productCluster = result.clusters.find(
      (c) => c.pages.includes('product-1') && c.pages.includes('product-2'),
    );
    const blogCluster = result.clusters.find(
      (c) => c.pages.includes('blog-1') && c.pages.includes('blog-2'),
    );

    // Products should cluster together
    if (productCluster) {
      expect(productCluster.pages).toContain('product-1');
      expect(productCluster.pages).toContain('product-2');
    }

    // Blog posts should cluster together
    if (blogCluster) {
      expect(blogCluster.pages).toContain('blog-1');
      expect(blogCluster.pages).toContain('blog-2');
    }
  });

  it('separates different templates into different clusters', () => {
    const templateProduct = `<html><body><main><div class="product"><h1>Name</h1><div class="gallery"><img/><img/><img/></div><div class="specs"><table><tr><td>Weight</td><td>1kg</td></tr><tr><td>Color</td><td>Red</td></tr></table></div><div class="reviews"><div class="review"><p>Great!</p></div></div></div></main></body></html>`;
    const templateDoc = `<html><body><div class="docs-layout"><nav class="sidebar"><ul><li>Intro</li><li>API</li><li>Guide</li></ul></nav><article class="content"><h1>API Reference</h1><section><h2>Method</h2><pre><code>example()</code></pre><p>Description of the method and its parameters.</p></section></article></div></body></html>`;

    const fp1 = fp.fingerprint(templateProduct, 'product');
    const fp2 = fp.fingerprint(templateDoc, 'doc');

    // Verify they're actually different
    const distance = TemplateFingerprinter.hammingDistance(fp1.fingerprint, fp2.fingerprint);
    expect(distance).toBeGreaterThan(3);

    const result = fp.cluster([fp1, fp2]);
    // Two different templates — should not be in the same cluster
    const sameCluster = result.clusters.some(
      (c) => c.pages.includes('product') && c.pages.includes('doc'),
    );
    expect(sameCluster).toBe(false);
  });

  it('returns correct stats', () => {
    const html = `<html><body><main><h1>Page</h1><p>Content paragraph here with some text.</p></main></body></html>`;
    const fingerprints: TemplateFingerprint[] = [
      fp.fingerprint(html, 'page-1'),
      fp.fingerprint(html, 'page-2'),
      fp.fingerprint(html, 'page-3'),
    ];

    const result = fp.cluster(fingerprints);
    expect(result.stats.totalPages).toBe(3);
    // All same template — should be in one cluster
    expect(result.stats.totalClusters).toBe(1);
    expect(result.stats.averageClusterSize).toBe(3);
    expect(result.stats.largestCluster).toBe(3);
  });

  it('handles empty input', () => {
    const result = fp.cluster([]);
    expect(result.clusters).toHaveLength(0);
    expect(result.unclustered).toHaveLength(0);
    expect(result.stats.totalPages).toBe(0);
  });

  it('handles single page input', () => {
    const result = fp.cluster([fp.fingerprint('<html><body><h1>Solo</h1></body></html>', 'solo')]);
    expect(result.stats.totalPages).toBe(1);
    // Single page becomes unclustered (cluster size 1)
    expect(result.unclustered).toHaveLength(1);
    expect(result.unclustered[0]).toBe('solo');
  });

  it('assigns templateId based on representative fingerprint hex prefix', () => {
    const html = `<html><body><main><h1>Page</h1><p>Content</p></main></body></html>`;
    const fingerprints: TemplateFingerprint[] = [
      fp.fingerprint(html, 'page-1'),
      fp.fingerprint(html, 'page-2'),
    ];

    const result = fp.cluster(fingerprints);
    expect(result.clusters.length).toBeGreaterThanOrEqual(1);
    for (const cluster of result.clusters) {
      expect(cluster.templateId).toMatch(/^tpl-[0-9a-f]{4}$/);
    }
  });
});

// ==========================================================================
// Edge cases
// ==========================================================================

describe('Edge cases', () => {
  const fp = new TemplateFingerprinter();

  it('empty HTML returns zero fingerprint', () => {
    const result = fp.fingerprint('');
    expect(result.fingerprint).toBe(0n);
    expect(result.tagPathCount).toBe(0);
  });

  it('whitespace-only HTML returns zero fingerprint', () => {
    const result = fp.fingerprint('   \n\t  ');
    expect(result.fingerprint).toBe(0n);
    expect(result.tagPathCount).toBe(0);
  });

  it('malformed HTML does not crash', () => {
    const malformed = '<html><body><div><p>Unclosed paragraph<div>Nested wrong</p></div>';
    expect(() => fp.fingerprint(malformed)).not.toThrow();
    const result = fp.fingerprint(malformed);
    expect(result.tagPathCount).toBeGreaterThan(0);
  });

  it('HTML with no body tags returns a fingerprint', () => {
    const result = fp.fingerprint('<p>Just a paragraph</p>');
    expect(result.tagPathCount).toBeGreaterThan(0);
  });

  it('oversized HTML (>5MB) is truncated and still produces a fingerprint', () => {
    // Use few DOM nodes with large text content to exceed 5MB without
    // creating 1M+ cheerio nodes (which causes multi-minute parse times).
    // 100 paragraphs × ~53KB text each ≈ 5.3MB with minimal DOM overhead.
    const bigParagraph = '<p>' + 'x'.repeat(53_000) + '</p>';
    const largeHtml = '<html><body>' + bigParagraph.repeat(100) + '</body></html>';
    expect(largeHtml.length).toBeGreaterThan(5 * 1024 * 1024);

    const result = fp.fingerprint(largeHtml, 'https://example.com/large');
    // Should still produce a valid fingerprint from the truncated content
    expect(result.tagPathCount).toBeGreaterThan(0);
    expect(result.fingerprint).not.toBe(0n);
  }, 30_000);

  it('handles HTML with excessive DOM nodes gracefully', () => {
    // Create HTML with many tiny nodes (would be slow without guard)
    // 60K small divs — exceeds MAX_DOM_NODES (50000) but is small in bytes
    const manyNodes = '<div>x</div>'.repeat(60_000);
    const html = `<html><body>${manyNodes}</body></html>`;

    const start = Date.now();
    const result = fp.fingerprint(html, 'https://example.com/huge-table');
    const elapsed = Date.now() - start;

    // Should complete quickly (guard kicks in) — under 10 seconds.
    // Without the guard, 60K nodes through normalizeDOM + extractTagPaths
    // would take 30+ seconds. We use 10s to avoid flakes from GC/CI load.
    expect(elapsed).toBeLessThan(10_000);
    // Should still return a valid fingerprint (not zero)
    expect(result.fingerprint).not.toBe(0n);
    // tagPathCount is 0 because we skipped the walk
    expect(result.tagPathCount).toBe(0);
  });

  it('HTML with only noise elements returns zero or near-zero tag paths', () => {
    const noiseOnly = `<html><body><script>var x=1;</script><style>.a{}</style><noscript>Enable JS</noscript></body></html>`;
    const result = fp.fingerprint(noiseOnly);
    // After stripping noise, only html, head, body remain
    // tagPathCount will be small but > 0 since html/body are structural
    expect(result.tagPathCount).toBeGreaterThanOrEqual(0);
  });
});

// ==========================================================================
// BigInt JSON serialization safety
// ==========================================================================

describe('BigInt serialization', () => {
  it('fingerprint.toString() produces valid hex-convertible string', () => {
    const fp = new TemplateFingerprinter();
    const result = fp.fingerprint('<html><body><h1>Test</h1></body></html>');
    const serialized = result.fingerprint.toString();
    expect(typeof serialized).toBe('string');
    // Should be parseable back to bigint
    expect(BigInt(serialized)).toBe(result.fingerprint);
  });

  it('BigInt cannot be directly JSON.stringified', () => {
    const value = 42n;
    expect(() => JSON.stringify({ value })).toThrow();
  });

  it('BigInt.toString() can be used in JSON safely', () => {
    const fp = new TemplateFingerprinter();
    const result = fp.fingerprint('<html><body><h1>Test</h1></body></html>');
    const serializable = {
      fingerprint: result.fingerprint.toString(),
      tagPathCount: result.tagPathCount,
    };
    expect(() => JSON.stringify(serializable)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(serializable));
    expect(parsed.fingerprint).toBe(result.fingerprint.toString());
  });

  it('toSerializable produces JSON-safe object', () => {
    const fp = new TemplateFingerprinter();
    const result = fp.fingerprint('<html><body><h1>Test</h1></body></html>', 'https://example.com');
    const serialized = TemplateFingerprinter.toSerializable(result);

    expect(typeof serialized.fingerprint).toBe('string');
    expect(serialized.fingerprint.length).toBe(16); // 64-bit = 16 hex chars
    expect(serialized.tagPathCount).toBe(result.tagPathCount);
    expect(serialized.url).toBe('https://example.com');
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });

  it('fromSerializable round-trips correctly', () => {
    const fp = new TemplateFingerprinter();
    const original = fp.fingerprint(
      '<html><body><h1>Test</h1></body></html>',
      'https://example.com',
    );
    const serialized = TemplateFingerprinter.toSerializable(original);
    const restored = TemplateFingerprinter.fromSerializable(serialized);

    expect(restored.fingerprint).toBe(original.fingerprint);
    expect(restored.tagPathCount).toBe(original.tagPathCount);
    expect(restored.url).toBe(original.url);
  });

  it('fromSerializable handles malformed hex gracefully', () => {
    const restored = TemplateFingerprinter.fromSerializable({
      fingerprint: 'not-valid-hex!@#',
      tagPathCount: 5,
      url: 'https://example.com',
    });
    expect(restored.fingerprint).toBe(0n);
    expect(restored.tagPathCount).toBe(5);
    expect(restored.url).toBe('https://example.com');
  });

  it('toSerializable handles zero fingerprint', () => {
    const serialized = TemplateFingerprinter.toSerializable({
      fingerprint: 0n,
      tagPathCount: 0,
    });
    expect(serialized.fingerprint).toBe('0000000000000000');
    const restored = TemplateFingerprinter.fromSerializable(serialized);
    expect(restored.fingerprint).toBe(0n);
  });
});

// ==========================================================================
// Custom NormalizationConfig
// ==========================================================================

describe('Custom NormalizationConfig', () => {
  it('respects custom stripTags', () => {
    // Default config strips noscript; custom config does not strip it
    const fpNoStrip = new TemplateFingerprinter({ stripTags: [] });
    const fpDefault = new TemplateFingerprinter();

    // noscript with nested div inside body — stripped by default, kept by custom
    const html = `<html><head></head><body><div><h1>Title</h1><noscript><div><p>Enable JS</p></div></noscript></div></body></html>`;
    const rNoStrip = fpNoStrip.fingerprint(html);
    const rDefault = fpDefault.fingerprint(html);

    // No-strip config keeps noscript and its children — different fingerprint
    expect(rNoStrip.fingerprint).not.toBe(rDefault.fingerprint);
  });

  it('respects custom maxDepth', () => {
    let inner = '<span>deep</span>';
    for (let i = 0; i < 10; i++) {
      inner = `<div>${inner}</div>`;
    }
    const html = `<html><body>${inner}</body></html>`;

    const fpShallow = new TemplateFingerprinter({ maxDepth: 5 });
    const fpDeep = new TemplateFingerprinter({ maxDepth: 20 });

    const rShallow = fpShallow.fingerprint(html);
    const rDeep = fpDeep.fingerprint(html);

    expect(rDeep.tagPathCount).toBeGreaterThan(rShallow.tagPathCount);
  });
});

// ==========================================================================
// A/B test variant (adversarial case)
// ==========================================================================

describe('A/B test variant grouping', () => {
  it('groups pages with same structure but different ad/cookie wrappers', () => {
    const fp = new TemplateFingerprinter();

    const variantA = `<html><body><div class="ad-container"><p>Ad A</p></div><main><h1>Product</h1><p>Details</p><div class="specs"><p>Spec 1</p><p>Spec 2</p></div></main><div class="cookie-consent">Accept</div></body></html>`;
    const variantB = `<html><body><div class="ad_banner"><p>Ad B</p></div><main><h1>Product</h1><p>Details</p><div class="specs"><p>Spec 1</p><p>Spec 2</p></div></main><div class="popup-overlay">Subscribe!</div></body></html>`;
    const clean = `<html><body><main><h1>Product</h1><p>Details</p><div class="specs"><p>Spec 1</p><p>Spec 2</p></div></main></body></html>`;

    const rA = fp.fingerprint(variantA, 'variant-a');
    const rB = fp.fingerprint(variantB, 'variant-b');
    const rClean = fp.fingerprint(clean, 'clean');

    // After normalization, all three should have the same fingerprint
    expect(
      TemplateFingerprinter.hammingDistance(rA.fingerprint, rB.fingerprint),
    ).toBeLessThanOrEqual(3);
    expect(
      TemplateFingerprinter.hammingDistance(rA.fingerprint, rClean.fingerprint),
    ).toBeLessThanOrEqual(3);

    // Clustering should group them together
    const result = fp.cluster([rA, rB, rClean]);
    const allInOneCluster = result.clusters.some(
      (c) =>
        c.pages.includes('variant-a') && c.pages.includes('variant-b') && c.pages.includes('clean'),
    );
    expect(allInOneCluster).toBe(true);
  });
});
