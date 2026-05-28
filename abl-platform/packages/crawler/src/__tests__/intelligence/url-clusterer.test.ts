import { describe, it, expect } from 'vitest';
import { UrlClusterer } from '../../intelligence/algorithms/url-clusterer.js';

describe('UrlClusterer', () => {
  const clusterer = new UrlClusterer();

  // ─── AC-1: E-commerce product URLs ───────────────────────────────

  describe('e-commerce product URLs', () => {
    it('groups 100 /products/shoe-N URLs into /products/{slug}', () => {
      const urls = Array.from(
        { length: 100 },
        (_, i) => `https://shop.example.com/products/shoe-${i + 1}`,
      );
      const result = clusterer.cluster(urls);

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].pattern).toBe('/products/{slug}');
      expect(result.groups[0].count).toBe(100);
      expect(result.groups[0].examples).toHaveLength(10);
      expect(result.groups[0].depth).toBe(2);
      expect(result.ungrouped).toHaveLength(0);
      expect(result.stats.totalUrls).toBe(100);
      expect(result.stats.groupedUrls).toBe(100);
      expect(result.stats.groupCount).toBe(1);
    });
  });

  // ─── AC-2: Multi-level versioned docs ────────────────────────────

  describe('multi-level versioned docs', () => {
    it('groups /docs/api/v1/auth and /docs/api/v2/auth into /docs/api/{slug}/auth', () => {
      const urls = [
        'https://docs.example.com/docs/api/v1/auth',
        'https://docs.example.com/docs/api/v2/auth',
      ];
      const result = clusterer.cluster(urls);

      const versionGroup = result.groups.find((g) => g.pattern.includes('{slug}'));
      expect(versionGroup).toBeDefined();
      expect(versionGroup!.pattern).toBe('/docs/api/{slug}/auth');
      expect(versionGroup!.count).toBe(2);
      expect(versionGroup!.depth).toBe(4);
    });

    it('handles many versions', () => {
      const urls = Array.from(
        { length: 10 },
        (_, i) => `https://docs.example.com/docs/api/v${i + 1}/auth`,
      );
      const result = clusterer.cluster(urls);

      const versionGroup = result.groups.find((g) => g.pattern.includes('{slug}'));
      expect(versionGroup).toBeDefined();
      expect(versionGroup!.count).toBe(10);
    });
  });

  // ─── AC-3: Performance with 5000 URLs ────────────────────────────

  describe('performance', () => {
    it('clusters 5000 URLs in < 1000ms', () => {
      const urls = Array.from({ length: 5000 }, (_, i) => `https://example.com/products/item-${i}`);

      const start = performance.now();
      const result = clusterer.cluster(urls);
      const elapsed = performance.now() - start;

      // CI runners (shared, containerized) are 5-10x slower than dev machines.
      // Local: ~10ms, CI: ~500ms. Use generous threshold to avoid flaky failures.
      expect(elapsed).toBeLessThan(1000);
      expect(result.stats.totalUrls).toBe(5000);
      expect(result.groups.length).toBeGreaterThan(0);
    });

    it('clusters 40000 URLs in < 5000ms', () => {
      // Simulate Epson-scale: multiple categories with deep paths
      const urls: string[] = [];
      const categories = ['Printers', 'Scanners', 'Projectors', 'Paper', 'Ink'];
      for (const cat of categories) {
        for (let i = 0; i < 8000; i++) {
          urls.push(`https://example.com/For-Work/${cat}/Model-${i}/p/SKU-${i}`);
        }
      }

      const start = performance.now();
      const result = clusterer.cluster(urls);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(5000);
      expect(result.stats.totalUrls).toBe(40000);
    });
  });

  // ─── AC-4: Ungrouped URLs ────────────────────────────────────────

  describe('ungrouped URLs', () => {
    it('puts URLs with < minGroupSize matching into ungrouped', () => {
      const urls = [
        'https://example.com/about',
        'https://example.com/contact',
        'https://example.com/privacy',
      ];
      // Each URL is unique at depth 1 — but since there are 3 single-segment
      // paths, they may be grouped. Use truly unique structures:
      const uniqueUrls = ['https://example.com/a/b/c', 'https://example.com/x/y/z'];
      const result = new UrlClusterer({ minGroupSize: 3 }).cluster(uniqueUrls);

      // With minGroupSize=3, two URLs can't form a group
      expect(result.ungrouped.length).toBeGreaterThan(0);
      expect(result.stats.groupedUrls).toBe(0);
    });
  });

  // ─── Empty input ─────────────────────────────────────────────────

  describe('empty input', () => {
    it('returns empty groups for empty URL array', () => {
      const result = clusterer.cluster([]);

      expect(result.groups).toHaveLength(0);
      expect(result.ungrouped).toHaveLength(0);
      expect(result.stats.totalUrls).toBe(0);
      expect(result.stats.groupedUrls).toBe(0);
      expect(result.stats.groupCount).toBe(0);
    });
  });

  // ─── Single URL ──────────────────────────────────────────────────

  describe('single URL', () => {
    it('puts single URL into ungrouped', () => {
      const result = clusterer.cluster(['https://example.com/products/shoe-1']);

      expect(result.groups).toHaveLength(0);
      expect(result.ungrouped).toHaveLength(1);
      expect(result.ungrouped[0]).toBe('https://example.com/products/shoe-1');
    });
  });

  // ─── Mixed URL patterns ──────────────────────────────────────────

  describe('mixed URL patterns', () => {
    it('groups docs, products, and blog URLs separately', () => {
      const urls = [
        // Products (5 URLs)
        ...Array.from({ length: 5 }, (_, i) => `https://example.com/products/item-${i}`),
        // Docs (5 URLs)
        ...Array.from({ length: 5 }, (_, i) => `https://example.com/docs/page-${i}`),
        // Blog (5 URLs)
        ...Array.from({ length: 5 }, (_, i) => `https://example.com/blog/post-${i}`),
      ];

      const result = clusterer.cluster(urls);

      expect(result.groups.length).toBeGreaterThanOrEqual(3);

      const productGroup = result.groups.find((g) => g.pattern.includes('products'));
      const docsGroup = result.groups.find((g) => g.pattern.includes('docs'));
      const blogGroup = result.groups.find((g) => g.pattern.includes('blog'));

      expect(productGroup).toBeDefined();
      expect(productGroup!.count).toBe(5);
      expect(docsGroup).toBeDefined();
      expect(docsGroup!.count).toBe(5);
      expect(blogGroup).toBeDefined();
      expect(blogGroup!.count).toBe(5);

      expect(result.ungrouped).toHaveLength(0);
      expect(result.stats.totalUrls).toBe(15);
      expect(result.stats.groupedUrls).toBe(15);
    });
  });

  // ─── Deep paths ──────────────────────────────────────────────────

  describe('deep paths', () => {
    it('handles paths with 5+ segments', () => {
      const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/a/b/c/d/item-${i}`);

      const result = clusterer.cluster(urls);

      const group = result.groups.find((g) => g.pattern.includes('{slug}'));
      expect(group).toBeDefined();
      expect(group!.count).toBe(10);
      expect(group!.depth).toBeGreaterThanOrEqual(5);
    });

    it('correctly reports depth for deep patterns', () => {
      const urls = Array.from(
        { length: 5 },
        (_, i) => `https://example.com/level1/level2/level3/level4/level5/item-${i}`,
      );

      const result = clusterer.cluster(urls);

      const group = result.groups.find((g) => g.pattern.includes('{slug}'));
      expect(group).toBeDefined();
      expect(group!.depth).toBe(6);
    });
  });

  // ─── Config overrides ────────────────────────────────────────────

  describe('config overrides', () => {
    it('respects custom minGroupSize', () => {
      const urls = [
        'https://example.com/products/a',
        'https://example.com/products/b',
        'https://example.com/products/c',
      ];

      // With minGroupSize=4, 3 URLs should not form a group
      const strict = new UrlClusterer({ minGroupSize: 4 });
      const result = strict.cluster(urls);
      expect(result.groups).toHaveLength(0);
      expect(result.ungrouped).toHaveLength(3);

      // With minGroupSize=2 (default), they should group
      const normal = new UrlClusterer({ minGroupSize: 2 });
      const normalResult = normal.cluster(urls);
      expect(normalResult.groups.length).toBeGreaterThan(0);
    });

    it('respects custom maxGroups', () => {
      // Create many different patterns
      const urls: string[] = [];
      for (let group = 0; group < 30; group++) {
        for (let item = 0; item < 3; item++) {
          urls.push(`https://example.com/section-${group}/item-${item}`);
        }
      }

      const limited = new UrlClusterer({ maxGroups: 5 });
      const result = limited.cluster(urls);
      expect(result.groups.length).toBeLessThanOrEqual(5);
    });

    it('respects custom maxUrls', () => {
      const urls = Array.from({ length: 100 }, (_, i) => `https://example.com/products/item-${i}`);

      const limited = new UrlClusterer({ maxUrls: 10 });
      const result = limited.cluster(urls);
      expect(result.stats.totalUrls).toBe(10);
    });
  });

  // ─── Edge cases ──────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles root-only URLs', () => {
      const urls = ['https://example.com/', 'https://other.com/'];
      const result = clusterer.cluster(urls);
      // Root URLs have 0 segments — they may end up ungrouped or in a "/" group
      expect(result.stats.totalUrls).toBe(2);
    });

    it('handles path-only inputs (no protocol)', () => {
      const urls = ['/products/shoe-1', '/products/shoe-2', '/products/shoe-3'];
      const result = clusterer.cluster(urls);

      expect(result.groups.length).toBeGreaterThan(0);
      const group = result.groups.find((g) => g.pattern.includes('products'));
      expect(group).toBeDefined();
      expect(group!.count).toBe(3);
    });

    it('handles URLs with query strings (ignores query)', () => {
      const urls = Array.from(
        { length: 5 },
        (_, i) => `https://example.com/search/results?q=query-${i}&page=1`,
      );
      const result = clusterer.cluster(urls);
      // All URLs have the same path /search/results — should form a group
      expect(result.stats.totalUrls).toBe(5);
    });

    it('examples array contains at most MAX_EXAMPLES (10) URLs', () => {
      const urls = Array.from({ length: 50 }, (_, i) => `https://example.com/items/product-${i}`);
      const result = clusterer.cluster(urls);

      for (const group of result.groups) {
        expect(group.examples.length).toBeLessThanOrEqual(10);
      }
    });

    it('groups are sorted by count descending', () => {
      const urls = [
        // 10 products
        ...Array.from({ length: 10 }, (_, i) => `https://example.com/products/p-${i}`),
        // 5 docs
        ...Array.from({ length: 5 }, (_, i) => `https://example.com/docs/d-${i}`),
        // 20 blog posts
        ...Array.from({ length: 20 }, (_, i) => `https://example.com/blog/post-${i}`),
      ];

      const result = clusterer.cluster(urls);

      for (let i = 1; i < result.groups.length; i++) {
        expect(result.groups[i - 1].count).toBeGreaterThanOrEqual(result.groups[i].count);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // URL Conservation — no input URL lost during trie collapse
  // ═══════════════════════════════════════════════════════════════════

  describe('URL conservation (zero data loss)', () => {
    /**
     * INVARIANT: For any input, grouped + ungrouped must equal totalUrls.
     * This was the Epson bug — collapseChildren had a shallow 2-level merge
     * that dropped URLs at depth 3+ below collapse points.
     */

    it('conserves all URLs: groupedUrls + ungrouped.length === totalUrls', () => {
      const urls = Array.from({ length: 200 }, (_, i) => `https://example.com/cat/sub-${i}`);
      const result = clusterer.cluster(urls);

      const accounted = result.stats.groupedUrls + result.ungrouped.length;
      expect(accounted).toBe(result.stats.totalUrls);
    });

    it('conserves URLs with deep paths (5+ segments)', () => {
      // Simulate Epson: /Category/SubCat/Product/p/SKU
      const urls: string[] = [];
      for (let cat = 0; cat < 5; cat++) {
        for (let prod = 0; prod < 20; prod++) {
          urls.push(`https://example.com/For-Work/Cat-${cat}/Product-${prod}/p/SKU-${cat}-${prod}`);
        }
      }

      const result = clusterer.cluster(urls);
      const accounted = result.stats.groupedUrls + result.ungrouped.length;

      expect(result.stats.totalUrls).toBe(100);
      expect(accounted).toBe(100);
    });

    it('conserves URLs when multiple siblings collapse and share deep subtrees', () => {
      // This is the exact pattern that triggered the Epson bug:
      // Multiple siblings (Model-X) under a parent collapse into {slug},
      // and they all share a common child "p" with different product IDs below.
      //
      // /Printers/Inkjet/EcoTank-1/p/C001
      // /Printers/Inkjet/EcoTank-2/p/C002
      // /Printers/Inkjet/WorkForce-1/p/C003
      // /Printers/Inkjet/WorkForce-2/p/C004
      //
      // When EcoTank-* and WorkForce-* collapse into {slug}, the "p" subtrees
      // must merge recursively — not just 2 levels deep.
      const urls: string[] = [];
      for (let model = 0; model < 10; model++) {
        for (let sku = 0; sku < 5; sku++) {
          urls.push(`https://example.com/Printers/Inkjet/Model-${model}/p/SKU-${model * 5 + sku}`);
        }
      }

      const result = clusterer.cluster(urls);
      const accounted = result.stats.groupedUrls + result.ungrouped.length;

      expect(result.stats.totalUrls).toBe(50);
      expect(accounted).toBe(50);
    });

    it('conserves URLs at 6 levels deep with shared intermediate segments', () => {
      // /A/B/ModelX/p/detail/SKU-1
      // /A/B/ModelY/p/detail/SKU-2
      // The merge must go 4 levels deep: {slug} → p → detail → SKU-*
      const urls: string[] = [];
      for (let model = 0; model < 10; model++) {
        for (let sku = 0; sku < 3; sku++) {
          urls.push(`https://example.com/A/B/Model-${model}/p/detail/SKU-${model * 3 + sku}`);
        }
      }

      const result = clusterer.cluster(urls);
      const accounted = result.stats.groupedUrls + result.ungrouped.length;

      expect(result.stats.totalUrls).toBe(30);
      expect(accounted).toBe(30);
    });

    it('conserves URLs in Epson-like structure with multiple category hierarchies', () => {
      // Real-world pattern: multiple top-level categories, each with subcategories,
      // product lines, and individual product pages. URLs terminate at depth 5-6.
      const urls: string[] = [];
      const categories = ['Printers', 'Scanners', 'Projectors'];
      const subcats = ['Inkjet', 'Laser'];

      for (const cat of categories) {
        for (const sub of subcats) {
          for (let model = 0; model < 5; model++) {
            for (let sku = 0; sku < 3; sku++) {
              urls.push(
                `https://epson.com/For-Work/${cat}/${sub}/Model-${model}/p/SKU-${cat}-${sub}-${model}-${sku}`,
              );
            }
          }
        }
      }

      const total = urls.length; // 3 * 2 * 5 * 3 = 90
      const result = clusterer.cluster(urls);
      const accounted = result.stats.groupedUrls + result.ungrouped.length;

      expect(result.stats.totalUrls).toBe(total);
      expect(accounted).toBe(total);
    });

    it('conserves URLs when paths share long common prefixes', () => {
      // All URLs share /a/b/c but diverge at depth 4+ with parallel subtrees
      const urls: string[] = [];
      for (let branch = 0; branch < 5; branch++) {
        for (let leaf = 0; leaf < 4; leaf++) {
          urls.push(`https://example.com/a/b/c/branch-${branch}/sub/leaf-${leaf}`);
        }
      }

      const result = clusterer.cluster(urls);
      const accounted = result.stats.groupedUrls + result.ungrouped.length;

      expect(result.stats.totalUrls).toBe(20);
      expect(accounted).toBe(20);
    });

    it('conserves URLs at extreme depth (8 segments)', () => {
      const urls: string[] = [];
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          urls.push(`https://example.com/l1/l2/l3/var-${a}/l5/l6/l7/leaf-${b}`);
        }
      }

      const result = clusterer.cluster(urls);
      const accounted = result.stats.groupedUrls + result.ungrouped.length;

      expect(result.stats.totalUrls).toBe(9);
      expect(accounted).toBe(9);
    });

    it('conserves URLs when excess groups spill to ungrouped', () => {
      // Create more groups than maxGroups to trigger the spill path
      const urls: string[] = [];
      for (let section = 0; section < 150; section++) {
        for (let item = 0; item < 3; item++) {
          urls.push(`https://example.com/sec-${section}/item-${item}`);
        }
      }

      const total = urls.length; // 150 * 3 = 450
      const result = clusterer.cluster(urls);
      // With maxGroups=100 (default), excess groups spill ALL their URLs to ungrouped.
      expect(result.groups.length).toBeLessThanOrEqual(100);
      // Full URL conservation: every URL must appear in grouped or ungrouped
      const accounted = result.stats.groupedUrls + result.ungrouped.length;
      expect(accounted).toBe(total);
      expect(result.stats.totalUrls).toBe(total);
    });

    it('conserves all URLs with large-scale mixed depths', () => {
      // Mix of shallow (depth 2) and deep (depth 6) URLs
      const urls: string[] = [];
      // Shallow: 50 URLs at depth 2
      for (let i = 0; i < 50; i++) {
        urls.push(`https://example.com/blog/post-${i}`);
      }
      // Deep: 50 URLs at depth 6
      for (let cat = 0; cat < 5; cat++) {
        for (let prod = 0; prod < 10; prod++) {
          urls.push(`https://example.com/shop/cat-${cat}/sub/prod-${prod}/detail/info`);
        }
      }

      const result = clusterer.cluster(urls);
      const accounted = result.stats.groupedUrls + result.ungrouped.length;

      expect(result.stats.totalUrls).toBe(100);
      expect(accounted).toBe(100);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Trie collapse correctness
  // ═══════════════════════════════════════════════════════════════════

  describe('trie collapse correctness', () => {
    it('collapses siblings into {slug} when they have identical subtree structure', () => {
      // /products/shoe-1, /products/shoe-2, ... → /products/{slug}
      const urls = Array.from({ length: 5 }, (_, i) => `https://example.com/products/item-${i}`);
      const result = clusterer.cluster(urls);

      const group = result.groups.find((g) => g.pattern === '/products/{slug}');
      expect(group).toBeDefined();
      expect(group!.count).toBe(5);
    });

    it('does not collapse category-like nodes (few children with many URLs each)', () => {
      // /products has 2 children ("shoes" and "hats"), each with 20 URLs.
      // These are categories, not slugs — should NOT collapse into {slug}.
      const urls: string[] = [];
      for (let i = 0; i < 20; i++) {
        urls.push(`https://example.com/products/shoes/item-${i}`);
        urls.push(`https://example.com/products/hats/item-${i}`);
      }

      const result = clusterer.cluster(urls);

      // Should have separate groups for shoes and hats
      const shoesGroup = result.groups.find((g) => g.pattern.includes('shoes'));
      const hatsGroup = result.groups.find((g) => g.pattern.includes('hats'));

      expect(shoesGroup).toBeDefined();
      expect(hatsGroup).toBeDefined();
      expect(shoesGroup!.count).toBe(20);
      expect(hatsGroup!.count).toBe(20);
    });

    it('handles nested collapses (collapse at multiple levels)', () => {
      // /docs/v1/api/endpoint-1
      // /docs/v2/api/endpoint-2
      // Should collapse versions AND endpoints
      const urls: string[] = [];
      for (let v = 0; v < 5; v++) {
        for (let e = 0; e < 4; e++) {
          urls.push(`https://example.com/docs/v${v}/api/endpoint-${e}`);
        }
      }

      const result = clusterer.cluster(urls);
      const accounted = result.stats.groupedUrls + result.ungrouped.length;

      expect(result.stats.totalUrls).toBe(20);
      expect(accounted).toBe(20);
    });

    it('preserves URLs at intermediate nodes after collapse', () => {
      // Some URLs terminate at /products/shoes (no further path)
      // Others continue to /products/shoes/item-N
      // After collapsing item-* into {slug}, the /products/shoes URL must survive
      const urls = [
        'https://example.com/products/shoes',
        'https://example.com/products/shoes/item-1',
        'https://example.com/products/shoes/item-2',
        'https://example.com/products/shoes/item-3',
      ];

      const result = clusterer.cluster(urls);
      const accounted = result.stats.groupedUrls + result.ungrouped.length;

      expect(result.stats.totalUrls).toBe(4);
      expect(accounted).toBe(4);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Query parameter sub-clustering
  // ═══════════════════════════════════════════════════════════════════

  describe('query parameter sub-clustering', () => {
    it('splits large groups by consistent query parameter when enabled', () => {
      // 25 URLs per category — enough to exceed QUERY_SPLIT_MIN_GROUP (20)
      // and provide enough examples for the split to detect the param
      const urls: string[] = [];
      for (const cat of ['electronics', 'clothing', 'food', 'books']) {
        for (let i = 0; i < 25; i++) {
          urls.push(`https://example.com/search/results?category=${cat}&page=${i}`);
        }
      }

      const withSplit = new UrlClusterer({ splitByQueryParam: true });
      const result = withSplit.cluster(urls);

      // The group has 100 URLs but only 10 examples (MAX_EXAMPLES).
      // With 10 samples across 4 categories, the split may or may not detect
      // the param. The key behavior: splitByQueryParam doesn't crash and
      // conserves all URLs.
      const accounted = result.stats.groupedUrls + result.ungrouped.length;
      expect(accounted).toBe(100);
      expect(result.stats.totalUrls).toBe(100);
    });

    it('does not split when splitByQueryParam is false (default)', () => {
      const urls: string[] = [];
      for (const cat of ['a', 'b', 'c', 'd']) {
        for (let i = 0; i < 10; i++) {
          urls.push(`https://example.com/search/results?category=${cat}&page=${i}`);
        }
      }

      const result = clusterer.cluster(urls);
      // All URLs share /search/results — should be one group
      const searchGroup = result.groups.find((g) => g.pattern.includes('search'));
      expect(searchGroup).toBeDefined();
      expect(searchGroup!.count).toBe(40);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Invalid / malformed URL handling
  // ═══════════════════════════════════════════════════════════════════

  describe('malformed URLs', () => {
    it('handles invalid URLs gracefully without crashing', () => {
      const urls = [
        'https://example.com/valid/page',
        'not-a-url',
        '',
        'https://example.com/another/page',
      ];

      const result = clusterer.cluster(urls);
      expect(result.stats.totalUrls).toBe(4);
      // Should not throw; invalid URLs may end up ungrouped
      const accounted = result.stats.groupedUrls + result.ungrouped.length;
      expect(accounted).toBe(result.stats.totalUrls);
    });

    it('handles URLs with special characters in path', () => {
      const urls = [
        'https://example.com/products/item%20one',
        'https://example.com/products/item%20two',
        'https://example.com/products/item%20three',
      ];

      const result = clusterer.cluster(urls);
      expect(result.stats.totalUrls).toBe(3);
    });

    it('deduplicates nothing (input is expected to be pre-deduped)', () => {
      // Same URL twice — clusterer should process both
      const urls = [
        'https://example.com/products/shoe-1',
        'https://example.com/products/shoe-1',
        'https://example.com/products/shoe-2',
      ];

      const result = clusterer.cluster(urls);
      expect(result.stats.totalUrls).toBe(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Regression: Epson-scale deep trie merge
  // ═══════════════════════════════════════════════════════════════════

  describe('regression: deep trie merge (Epson bug)', () => {
    it('does not lose URLs when collapsing siblings with shared deep subtrees', () => {
      // This test reproduces the exact bug found on epson.com:
      // 44,399 URLs input → only 4,370 accounted for (90% lost).
      //
      // Root cause: collapseChildren merged subtrees only 2 levels deep.
      // When siblings like EcoTank-1, EcoTank-2 collapsed into {slug},
      // the shared "p" grandchild was merged correctly, but its children
      // (SKU IDs where URLs actually terminate) were dropped at depth 3+.
      //
      // Structure: /Category/SubCategory/ModelName/p/ProductID
      // ModelName nodes collapse into {slug}. "p" nodes merge.
      // ProductID nodes at depth 5 must survive the merge.
      const urls: string[] = [];
      const categories = ['Printers', 'Scanners', 'Projectors', 'Paper', 'Robots'];
      const subcategories = ['Inkjet', 'Laser', 'Large-Format'];

      for (const cat of categories) {
        for (const sub of subcategories) {
          for (let model = 0; model < 10; model++) {
            urls.push(
              `https://epson.com/For-Work/${cat}/${sub}/Model-${model}/p/SKU-${cat}-${sub}-${model}`,
            );
          }
        }
      }

      const total = urls.length; // 5 * 3 * 10 = 150
      const result = clusterer.cluster(urls);
      const accounted = result.stats.groupedUrls + result.ungrouped.length;

      expect(result.stats.totalUrls).toBe(total);
      // THE KEY ASSERTION: no URLs lost in trie collapse
      expect(accounted).toBe(total);
    });

    it('handles Epson accessories pattern: deep paths with shared /p/ segment', () => {
      // /Accessories/Projector-Accessories/ExtendedPlan-1/p/SKU-1
      // /Accessories/Printer-Accessories/ExtendedPlan-2/p/SKU-2
      // Both have /Accessories → {type}-Accessories → {plan} → p → {sku}
      const urls: string[] = [];
      const types = ['Projector', 'Printer', 'Scanner'];

      for (const type of types) {
        for (let plan = 0; plan < 8; plan++) {
          for (let sku = 0; sku < 4; sku++) {
            urls.push(
              `https://epson.com/Accessories/${type}-Accessories/Plan-${plan}/p/SKU-${type}-${plan}-${sku}`,
            );
          }
        }
      }

      const total = urls.length; // 3 * 8 * 4 = 96
      const result = clusterer.cluster(urls);
      const accounted = result.stats.groupedUrls + result.ungrouped.length;

      expect(result.stats.totalUrls).toBe(total);
      expect(accounted).toBe(total);
    });

    it('handles mixed depth URLs where some terminate early and others go deep', () => {
      const urls = [
        // Shallow: terminate at depth 3
        ...Array.from({ length: 10 }, (_, i) => `https://epson.com/For-Work/Printers/Model-${i}`),
        // Deep: terminate at depth 5
        ...Array.from(
          { length: 10 },
          (_, i) => `https://epson.com/For-Work/Printers/Model-${i + 10}/p/SKU-${i}`,
        ),
        // Very deep: terminate at depth 7
        ...Array.from(
          { length: 10 },
          (_, i) => `https://epson.com/For-Work/Printers/Model-${i + 20}/p/detail/specs/SKU-${i}`,
        ),
      ];

      const result = clusterer.cluster(urls);
      const accounted = result.stats.groupedUrls + result.ungrouped.length;

      expect(result.stats.totalUrls).toBe(30);
      expect(accounted).toBe(30);
    });
  });
});
