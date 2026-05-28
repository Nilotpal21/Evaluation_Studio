/**
 * Sitemap Merge — Pure Function Tests
 *
 * Tests previewSitemapMerge, mergeSitemapUrlsIntoTree, matchesExclusionPattern.
 */

import { describe, it, expect } from 'vitest';
import {
  previewSitemapMerge,
  mergeSitemapUrlsIntoTree,
  matchesExclusionPattern,
} from '../sitemap-merge';
import type { UnifiedTreeNode } from '../unified-tree-types';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeNode(overrides: Partial<UnifiedTreeNode> & { id: string }): UnifiedTreeNode {
  return {
    label: 'Test',
    url: '',
    depth: 0,
    children: [],
    status: 'explored',
    source: 'bfs-discovered',
    included: false,
    ...overrides,
  };
}

// ─── matchesExclusionPattern ────────────────────────────────────────

describe('matchesExclusionPattern', () => {
  it('matches common exclusion paths', () => {
    expect(matchesExclusionPattern('/login')).toBe(true);
    expect(matchesExclusionPattern('/cart')).toBe(true);
    expect(matchesExclusionPattern('/api/v1/users')).toBe(true);
    expect(matchesExclusionPattern('/admin')).toBe(true);
    expect(matchesExclusionPattern('/checkout/confirm')).toBe(true);
    expect(matchesExclusionPattern('/account/settings')).toBe(true);
  });

  it('does not match normal content paths', () => {
    expect(matchesExclusionPattern('/about')).toBe(false);
    expect(matchesExclusionPattern('/products/widget')).toBe(false);
    expect(matchesExclusionPattern('/blog/post-1')).toBe(false);
  });
});

// ─── previewSitemapMerge ────────────────────────────────────────────

describe('previewSitemapMerge', () => {
  it('reports correct overlap count', () => {
    const tree: UnifiedTreeNode[] = [
      makeNode({
        id: 'existing',
        url: 'https://example.com/about',
      }),
    ];

    const sitemapUrls = [
      'https://example.com/about', // overlap
      'https://example.com/blog', // new
      'https://example.com/contact', // new
    ];

    const preview = previewSitemapMerge(tree, sitemapUrls);
    expect(preview.totalSitemapUrls).toBe(3);
    expect(preview.overlapUrls).toBe(1);
    expect(preview.newUrls).toBe(2);
  });

  it('groups URLs by top-level path segment', () => {
    const tree: UnifiedTreeNode[] = [];

    const sitemapUrls = [
      'https://example.com/blog/post-1',
      'https://example.com/blog/post-2',
      'https://example.com/docs/intro',
    ];

    const preview = previewSitemapMerge(tree, sitemapUrls);
    expect(preview.pathGroups.length).toBeGreaterThanOrEqual(2);
    const blogGroup = preview.pathGroups.find((g) => g.path === '/blog');
    expect(blogGroup).toBeDefined();
    expect(blogGroup!.count).toBe(2);
  });
});

// ─── mergeSitemapUrlsIntoTree ───────────────────────────────────────

describe('mergeSitemapUrlsIntoTree', () => {
  it('skips URLs already in tree (dedup)', () => {
    const tree: UnifiedTreeNode[] = [
      makeNode({
        id: 'existing',
        url: 'https://example.com/about',
      }),
    ];

    const result = mergeSitemapUrlsIntoTree(
      tree,
      ['https://example.com/about', 'https://example.com/new-page'],
      'https://example.com',
    );

    // Collect all URLs in result tree
    const allUrls: string[] = [];
    function collectUrls(nodes: UnifiedTreeNode[]): void {
      for (const n of nodes) {
        if (n.url) allUrls.push(n.url);
        collectUrls(n.children);
      }
    }
    collectUrls(result);

    // /about should appear only once (not duplicated)
    const aboutCount = allUrls.filter((u) => u === 'https://example.com/about').length;
    expect(aboutCount).toBe(1);
    // /new-page should be added
    expect(allUrls).toContain('https://example.com/new-page');
  });

  it('returns tree unchanged for empty sitemap input', () => {
    const tree: UnifiedTreeNode[] = [
      makeNode({
        id: 'node1',
        url: 'https://example.com/page',
      }),
    ];

    const result = mergeSitemapUrlsIntoTree(tree, [], 'https://example.com');
    // Tree should be structurally equivalent (deep clone but same data)
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://example.com/page');
  });

  it('adds new sitemap URLs with correct source', () => {
    const tree: UnifiedTreeNode[] = [];
    const sitemapUrls = [
      'https://example.com/docs/intro',
      'https://example.com/docs/getting-started',
    ];

    const result = mergeSitemapUrlsIntoTree(tree, sitemapUrls, 'https://example.com');

    // Flatten all nodes
    const allNodes: UnifiedTreeNode[] = [];
    function collect(nodes: UnifiedTreeNode[]): void {
      for (const n of nodes) {
        allNodes.push(n);
        collect(n.children);
      }
    }
    collect(result);

    // Find the actual page nodes (not virtual folders)
    const sitemapNodes = allNodes.filter((n) => n.source === 'sitemap' && !n.isVirtual);
    expect(sitemapNodes.length).toBe(2);
    expect(sitemapNodes[0].discoverySource).toBe('sitemap');
    expect(sitemapNodes[1].discoverySource).toBe('sitemap');
  });
});
