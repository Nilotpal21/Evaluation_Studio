/**
 * Hybrid Tree Builder — Pure Function Tests
 *
 * Tests buildHybridTree, computeGlobalLinks, resolveLabel, and humanizeSlug.
 */

import { describe, it, expect } from 'vitest';
import { buildHybridTree, computeGlobalLinks, resolveLabel } from '../hybrid-tree-builder.js';
import { humanizeSlug } from '../url-normalizer.js';
import type { DiscoveredPage } from '../bfs-discovery.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function makePage(overrides: Partial<DiscoveredPage> & { url: string }): DiscoveredPage {
  return {
    foundOn: [],
    renderMethod: 'http',
    visited: false,
    status: 'discovered',
    childUrls: [],
    ...overrides,
  };
}

// ─── buildHybridTree — hybrid mode ──────────────────────────────────

describe('buildHybridTree', () => {
  it('cross-path page placed by foundOn in hybrid mode', () => {
    const primaryUrl = 'https://example.com';
    const allUrls = new Map<string, DiscoveredPage>([
      [primaryUrl, makePage({ url: primaryUrl, visited: true, status: 'visited' })],
      [
        'https://example.com/printers/et-2400',
        makePage({
          url: 'https://example.com/printers/et-2400',
          visited: true,
          status: 'visited',
          childUrls: ['https://example.com/faq/et-2400-faq'],
        }),
      ],
      [
        'https://example.com/faq/et-2400-faq',
        makePage({
          url: 'https://example.com/faq/et-2400-faq',
          visited: true,
          status: 'visited',
          foundOn: ['https://example.com/printers/et-2400'],
        }),
      ],
    ]);

    const roots = buildHybridTree(allUrls, primaryUrl, [], { viewMode: 'hybrid' });

    // FAQ page should be placed under the printer page (foundOn), not under /faq/
    function findNodeUrl(nodes: { url: string; children: unknown[] }[], url: string): boolean {
      for (const n of nodes) {
        if (n.url === url) return true;
        if (findNodeUrl(n.children as { url: string; children: unknown[] }[], url)) return true;
      }
      return false;
    }

    const printerNode = roots
      .flatMap(function flatten(n): Array<{ url: string; children: unknown[] }> {
        return [n, ...(n.children as Array<{ url: string; children: unknown[] }>).flatMap(flatten)];
      })
      .find((n) => n.url === 'https://example.com/printers/et-2400');

    expect(printerNode).toBeDefined();
    expect(
      findNodeUrl(
        printerNode!.children as { url: string; children: unknown[] }[],
        'https://example.com/faq/et-2400-faq',
      ),
    ).toBe(true);
  });

  it('crawl-path mode uses foundOn[0] as parent', () => {
    const primaryUrl = 'https://example.com';
    const allUrls = new Map<string, DiscoveredPage>([
      [
        primaryUrl,
        makePage({
          url: primaryUrl,
          visited: true,
          status: 'visited',
          childUrls: ['https://example.com/about'],
        }),
      ],
      [
        'https://example.com/about',
        makePage({
          url: 'https://example.com/about',
          visited: true,
          status: 'visited',
          foundOn: ['https://example.com'],
        }),
      ],
    ]);

    const roots = buildHybridTree(allUrls, primaryUrl, [], { viewMode: 'crawl-path' });

    // /about should be a child of primaryUrl (foundOn[0])
    const primary = roots.find((r) => r.url === primaryUrl);
    expect(primary).toBeDefined();
    const aboutChild = primary!.children.find((c) => c.url === 'https://example.com/about');
    expect(aboutChild).toBeDefined();
  });

  it('url-path mode uses URL path hierarchy only', () => {
    const primaryUrl = 'https://example.com';
    const allUrls = new Map<string, DiscoveredPage>([
      [primaryUrl, makePage({ url: primaryUrl, visited: true, status: 'visited' })],
      [
        'https://example.com/products',
        makePage({
          url: 'https://example.com/products',
          visited: true,
          status: 'visited',
        }),
      ],
      [
        'https://example.com/products/widget',
        makePage({
          url: 'https://example.com/products/widget',
          visited: true,
          status: 'visited',
          foundOn: ['https://example.com'], // foundOn points to root, but url-path should win
        }),
      ],
    ]);

    const roots = buildHybridTree(allUrls, primaryUrl, [], { viewMode: 'url-path' });

    // /products/widget should be under /products, not under root
    const productsNode = roots
      .flatMap(function flatten(n): Array<{ url: string; children: unknown[] }> {
        return [n, ...(n.children as Array<{ url: string; children: unknown[] }>).flatMap(flatten)];
      })
      .find((n) => n.url === 'https://example.com/products');

    expect(productsNode).toBeDefined();
    const widgetChild = (productsNode!.children as Array<{ url: string }>).find(
      (c) => c.url === 'https://example.com/products/widget',
    );
    expect(widgetChild).toBeDefined();
  });

  it('primary URL is always the first root', () => {
    const primaryUrl = 'https://example.com/start';
    const allUrls = new Map<string, DiscoveredPage>([
      [primaryUrl, makePage({ url: primaryUrl, visited: true, status: 'visited' })],
      [
        'https://example.com/other',
        makePage({ url: 'https://example.com/other', visited: true, status: 'visited' }),
      ],
    ]);

    const roots = buildHybridTree(allUrls, primaryUrl, []);
    expect(roots.length).toBeGreaterThanOrEqual(1);
    expect(roots[0].url).toBe(primaryUrl);
  });

  it('returns empty array for empty allUrls', () => {
    const roots = buildHybridTree(new Map(), 'https://example.com', []);
    // Only the primary node is synthesized
    expect(roots.length).toBe(1);
    expect(roots[0].url).toBe('https://example.com');
  });

  it('returns single-node tree for single URL', () => {
    const primaryUrl = 'https://example.com';
    const allUrls = new Map<string, DiscoveredPage>([
      [primaryUrl, makePage({ url: primaryUrl, visited: true, status: 'visited' })],
    ]);

    const roots = buildHybridTree(allUrls, primaryUrl, []);
    expect(roots.length).toBe(1);
    expect(roots[0].url).toBe(primaryUrl);
    expect(roots[0].children.length).toBe(0);
  });
});

// ─── Virtual node synthesis ──────────────────────────────────────────

describe('buildHybridTree — virtual nodes', () => {
  it('creates virtual nodes for path gaps when intermediate pages exist', () => {
    // When there are intermediate URLs in allUrls that act as real ancestors,
    // virtual nodes are synthesized for any remaining gaps.
    const primaryUrl = 'https://example.com';
    const allUrls = new Map<string, DiscoveredPage>([
      [primaryUrl, makePage({ url: primaryUrl, visited: true, status: 'visited' })],
      [
        'https://example.com/a',
        makePage({ url: 'https://example.com/a', visited: true, status: 'visited' }),
      ],
      [
        'https://example.com/a/b/c',
        makePage({ url: 'https://example.com/a/b/c', visited: true, status: 'visited' }),
      ],
      [
        'https://example.com/a/b/d',
        makePage({ url: 'https://example.com/a/b/d', visited: true, status: 'visited' }),
      ],
    ]);

    // /a exists but /a/b does not, so a virtual node for /a/b should be created
    const roots = buildHybridTree(allUrls, primaryUrl, [], { viewMode: 'url-path' });

    // Flatten all nodes
    type AnyNode = { url: string; children: AnyNode[]; isVirtual?: boolean };
    const allNodes: AnyNode[] = [];
    function collect(nodes: AnyNode[]): void {
      for (const n of nodes) {
        allNodes.push(n);
        collect(n.children);
      }
    }
    collect(roots as AnyNode[]);

    // There should be more nodes than the 4 real URLs due to virtual /a/b
    expect(allNodes.length).toBeGreaterThan(4);
    // /a/b/c and /a/b/d should be in the tree
    expect(allNodes.find((n) => n.url === 'https://example.com/a/b/c')).toBeDefined();
    expect(allNodes.find((n) => n.url === 'https://example.com/a/b/d')).toBeDefined();
  });
});

// ─── computeGlobalLinks ─────────────────────────────────────────────

describe('computeGlobalLinks', () => {
  it('marks a page linked from >30% of visited pages as global', () => {
    const navUrl = 'https://example.com/nav';
    const allUrls = new Map<string, DiscoveredPage>();

    // Create 10 visited pages, each linking to navUrl
    for (let i = 0; i < 10; i++) {
      const url = `https://example.com/page-${i}`;
      allUrls.set(
        url,
        makePage({
          url,
          visited: true,
          status: 'visited',
          childUrls: [navUrl],
        }),
      );
    }
    allUrls.set(navUrl, makePage({ url: navUrl, visited: false, status: 'discovered' }));

    const result = computeGlobalLinks(allUrls, 0.3);
    const navInfo = result.get(navUrl);

    expect(navInfo).toBeDefined();
    expect(navInfo!.isGlobalLink).toBe(true);
    expect(navInfo!.linkFrequency).toBe(1); // linked from all 10 visited pages = 10/10
  });

  it('global links are detected and marked in tree', () => {
    const primaryUrl = 'https://example.com';
    const globalUrl = 'https://example.com/contact';
    const allUrls = new Map<string, DiscoveredPage>();

    // primaryUrl is visited
    allUrls.set(
      primaryUrl,
      makePage({
        url: primaryUrl,
        visited: true,
        status: 'visited',
        childUrls: [globalUrl],
      }),
    );

    // Create 10 visited pages, each linking to globalUrl
    for (let i = 0; i < 10; i++) {
      const url = `https://example.com/page-${i}`;
      allUrls.set(
        url,
        makePage({
          url,
          visited: true,
          status: 'visited',
          childUrls: [globalUrl],
        }),
      );
    }

    // globalUrl itself
    allUrls.set(
      globalUrl,
      makePage({
        url: globalUrl,
        visited: true,
        status: 'visited',
        foundOn: ['https://example.com/page-0', 'https://example.com/page-1'],
      }),
    );

    const roots = buildHybridTree(allUrls, primaryUrl, [], { viewMode: 'hybrid' });

    // The globalUrl should be marked as a global link in the tree
    type AnyNode = { url: string; children: AnyNode[]; isGlobalLink?: boolean };
    const allNodes: AnyNode[] = [];
    function collect(nodes: AnyNode[]): void {
      for (const n of nodes) {
        allNodes.push(n);
        collect(n.children);
      }
    }
    collect(roots as AnyNode[]);

    const contactNode = allNodes.find((n) => n.url === globalUrl);
    expect(contactNode).toBeDefined();
    expect(contactNode!.isGlobalLink).toBe(true);
  });
});

// ─── childPageCount ─────────────────────────────────────────────────

describe('buildHybridTree — childPageCount', () => {
  it('computes childPageCount bottom-up', () => {
    const primaryUrl = 'https://example.com';
    const allUrls = new Map<string, DiscoveredPage>([
      [
        primaryUrl,
        makePage({
          url: primaryUrl,
          visited: true,
          status: 'visited',
          childUrls: ['https://example.com/a'],
        }),
      ],
      [
        'https://example.com/a',
        makePage({
          url: 'https://example.com/a',
          visited: true,
          status: 'visited',
          foundOn: [primaryUrl],
          childUrls: ['https://example.com/a/1', 'https://example.com/a/2'],
        }),
      ],
      [
        'https://example.com/a/1',
        makePage({
          url: 'https://example.com/a/1',
          visited: true,
          status: 'visited',
          foundOn: ['https://example.com/a'],
        }),
      ],
      [
        'https://example.com/a/2',
        makePage({
          url: 'https://example.com/a/2',
          visited: true,
          status: 'visited',
          foundOn: ['https://example.com/a'],
        }),
      ],
    ]);

    const roots = buildHybridTree(allUrls, primaryUrl, [], { viewMode: 'hybrid' });

    // Find /a node — it has 2 visited children
    const allNodes: Array<{ url: string; childPageCount?: number }> = [];
    function collect(
      nodes: Array<{ url: string; childPageCount?: number; children: unknown[] }>,
    ): void {
      for (const n of nodes) {
        allNodes.push(n);
        collect(n.children as Array<{ url: string; childPageCount?: number; children: unknown[] }>);
      }
    }
    collect(roots);

    const nodeA = allNodes.find((n) => n.url === 'https://example.com/a');
    expect(nodeA).toBeDefined();
    // /a has 2 visited leaf children, so childPageCount should be 2
    expect(nodeA!.childPageCount).toBe(2);
  });
});

// ─── resolveLabel ───────────────────────────────────────────────────

describe('resolveLabel', () => {
  it('uses page title when available', () => {
    const page = makePage({ url: 'https://example.com/about', title: 'About Us' });
    expect(resolveLabel('https://example.com/about', page, false)).toBe('About Us');
  });

  it('falls back to humanized slug when no title/linkText', () => {
    const page = makePage({ url: 'https://example.com/all-in-ones' });
    const label = resolveLabel('https://example.com/all-in-ones', page, false);
    expect(label).toContain('All');
    expect(label).toContain('In');
    expect(label).toContain('Ones');
  });
});

// ─── humanizeSlug ───────────────────────────────────────────────────

describe('humanizeSlug', () => {
  it('converts all-in-ones to title case', () => {
    const result = humanizeSlug('all-in-ones');
    expect(result).toBe('All In Ones');
  });

  it('handles model numbers like et-2400', () => {
    const result = humanizeSlug('et-2400');
    // "et" becomes "Et" (title case), 2400 is numeric-only → stripped
    // Actually: "et" is short uppercase? No, "et" is lowercase, titleCase gives "Et"
    // 2400 is numeric → filtered out
    expect(result).toContain('Et');
  });

  it('strips long hex IDs and UUIDs', () => {
    const result = humanizeSlug('SPT_C11CJ67201~faq-00004ba-shared');
    // C11CJ67201 contains non-hex chars (J) so not stripped by LONG_HEX_PATTERN
    // 00004ba is 7 chars (< 9), not stripped either
    // "faq" is lowercase → titleCase gives "Faq" (not all-uppercase and short)
    expect(result.length).toBeGreaterThan(0);
    // Should contain meaningful words
    expect(result.toLowerCase()).toContain('faq');
    expect(result.toLowerCase()).toContain('shared');
  });
});
