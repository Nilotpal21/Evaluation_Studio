/**
 * Tree to Sections — Pure Function Tests
 *
 * Tests treeToSections from tree-to-sections.ts.
 */

import { describe, it, expect } from 'vitest';
import { treeToSections } from '../tree-to-sections';
import type { UnifiedTreeNode } from '../unified-tree-types';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeNode(overrides: Partial<UnifiedTreeNode> & { id: string }): UnifiedTreeNode {
  return {
    label: 'Test Node',
    url: '',
    depth: 0,
    children: [],
    status: 'explored',
    source: 'bfs-discovered',
    included: false,
    ...overrides,
  };
}

// ─── treeToSections ─────────────────────────────────────────────────

describe('treeToSections', () => {
  it('virtual folder produces aggregated section with descendant pages (G-3/G-4)', () => {
    const tree: UnifiedTreeNode[] = [
      makeNode({
        id: 'virtual-folder',
        label: 'Support',
        url: 'https://example.com/support',
        isVirtual: true,
        included: true,
        children: [
          makeNode({
            id: 'child1',
            label: 'FAQ',
            url: 'https://example.com/support/faq',
            included: true,
            status: 'explored',
            pageCount: 2,
            pages: [
              { url: 'https://example.com/support/faq/1', title: 'FAQ 1' },
              { url: 'https://example.com/support/faq/2', title: 'FAQ 2' },
            ],
          }),
          makeNode({
            id: 'child2',
            label: 'Contact',
            url: 'https://example.com/support/contact',
            included: true,
            status: 'explored',
            pageCount: 1,
            pages: [{ url: 'https://example.com/support/contact/us', title: 'Contact Us' }],
          }),
        ],
      }),
    ];

    const { sections, warnings } = treeToSections(tree);
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe('Support');
    expect(sections[0].pageCount).toBe(3);
    expect(warnings).toHaveLength(0);
  });

  it('virtual folder with no pages produces no section', () => {
    const tree: UnifiedTreeNode[] = [
      makeNode({
        id: 'empty-virtual',
        label: 'Empty',
        isVirtual: true,
        included: true,
        children: [],
      }),
    ];

    const { sections } = treeToSections(tree);
    expect(sections).toHaveLength(0);
  });

  it('extracts common prefix pattern from child URLs (G-12)', () => {
    const tree: UnifiedTreeNode[] = [
      makeNode({
        id: 'virtual-products',
        label: 'Products',
        url: 'https://example.com/products',
        isVirtual: true,
        included: true,
        children: [
          makeNode({
            id: 'p1',
            label: 'Widget A',
            url: 'https://example.com/products/widget-a',
            included: true,
            status: 'explored',
            pageCount: 1,
            pages: [{ url: 'https://example.com/products/widget-a', title: 'Widget A' }],
          }),
          makeNode({
            id: 'p2',
            label: 'Widget B',
            url: 'https://example.com/products/widget-b',
            included: true,
            status: 'explored',
            pageCount: 1,
            pages: [{ url: 'https://example.com/products/widget-b', title: 'Widget B' }],
          }),
        ],
      }),
    ];

    const { sections } = treeToSections(tree);
    expect(sections).toHaveLength(1);
    // Pattern should be derived from common prefix: /products/*
    expect(sections[0].pattern).toContain('/products');
  });

  it('produces stable sectionId across calls (G-10)', () => {
    const tree: UnifiedTreeNode[] = [
      makeNode({
        id: 'node1',
        label: 'About',
        url: 'https://example.com/about',
        included: true,
        status: 'explored',
        pageCount: 3,
        pages: [
          { url: 'https://example.com/about/team', title: 'Team' },
          { url: 'https://example.com/about/mission', title: 'Mission' },
          { url: 'https://example.com/about/history', title: 'History' },
        ],
      }),
    ];

    const { sections: first } = treeToSections(tree);
    const { sections: second } = treeToSections(tree);

    expect(first[0].sectionId).toBeDefined();
    expect(first[0].sectionId).toBe(second[0].sectionId);
  });

  it('normal explored node becomes a section', () => {
    const tree: UnifiedTreeNode[] = [
      makeNode({
        id: 'blog',
        label: 'Blog',
        url: 'https://example.com/blog',
        included: true,
        status: 'explored',
        source: 'bfs-discovered',
        pageCount: 5,
        pages: [
          { url: 'https://example.com/blog/post-1', title: 'Post 1' },
          { url: 'https://example.com/blog/post-2', title: 'Post 2' },
          { url: 'https://example.com/blog/post-3', title: 'Post 3' },
          { url: 'https://example.com/blog/post-4', title: 'Post 4' },
          { url: 'https://example.com/blog/post-5', title: 'Post 5' },
        ],
      }),
    ];

    const { sections } = treeToSections(tree);
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe('Blog');
    expect(sections[0].pageCount).toBe(5);
    expect(sections[0].source).toBe('explored');
  });

  it('sitemap node included in sections', () => {
    const tree: UnifiedTreeNode[] = [
      makeNode({
        id: 'sitemap-node',
        label: 'Docs',
        url: 'https://example.com/docs',
        included: true,
        status: 'unexplored', // sitemap nodes are included even without explored status
        source: 'sitemap',
        pageCount: 10,
        pages: [{ url: 'https://example.com/docs/intro', title: 'Intro' }],
      }),
    ];

    const { sections } = treeToSections(tree);
    expect(sections).toHaveLength(1);
    expect(sections[0].source).toBe('sitemap');
  });

  it('unexplored non-sitemap node is skipped with warning', () => {
    const tree: UnifiedTreeNode[] = [
      makeNode({
        id: 'unexplored',
        label: 'Unexplored Node',
        url: 'https://example.com/unexplored',
        included: true,
        status: 'unexplored',
        source: 'bfs-discovered',
      }),
    ];

    const { sections, warnings } = treeToSections(tree);
    expect(sections).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('Unexplored Node');
  });

  it('mixed sources are tracked in sections', () => {
    const tree: UnifiedTreeNode[] = [
      makeNode({
        id: 'bfs-section',
        label: 'BFS Section',
        url: 'https://example.com/bfs',
        included: true,
        status: 'explored',
        source: 'bfs-discovered',
        pageCount: 3,
        pages: [{ url: 'https://example.com/bfs/1', title: 'Page 1' }],
      }),
      makeNode({
        id: 'sitemap-section',
        label: 'Sitemap Section',
        url: 'https://example.com/sitemap',
        included: true,
        source: 'sitemap',
        pageCount: 5,
        pages: [{ url: 'https://example.com/sitemap/1', title: 'SM Page 1' }],
      }),
    ];

    const { sections } = treeToSections(tree);
    expect(sections).toHaveLength(2);
    const sources = sections.map((s) => s.source);
    expect(sources).toContain('explored');
    expect(sources).toContain('sitemap');
  });
});
