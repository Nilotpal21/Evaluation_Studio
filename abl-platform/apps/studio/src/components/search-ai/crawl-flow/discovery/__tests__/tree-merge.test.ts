/**
 * Tree Merge — Pure Function Tests
 *
 * Tests treeSnapshotToUnifiedTree and toggleNodeIncluded from tree-merge.ts.
 */

import { describe, it, expect } from 'vitest';
import { treeSnapshotToUnifiedTree, toggleNodeIncluded } from '../tree-merge';
import { computeTreeStats } from '../unified-tree-types';
import type { UnifiedTreeNode } from '../unified-tree-types';

// ─── Helpers ──────────────────────────────────────────────────────────

interface BackendTreeNode {
  url: string;
  label: string;
  children: BackendTreeNode[];
  depth: number;
  visited: boolean;
  renderMethod: 'http' | 'browser' | 'unknown';
  pageRole?: 'hub' | 'leaf' | 'mixed';
  status: 'discovered' | 'visiting' | 'visited' | 'error';
  foundOn?: string[];
  discoverySource?: string;
  isGlobalLink?: boolean;
  isVirtual?: boolean;
  childPageCount?: number;
  errorMessage?: string;
}

function makeBackendNode(overrides: Partial<BackendTreeNode> & { url: string }): BackendTreeNode {
  return {
    label: 'Test Node',
    children: [],
    depth: 0,
    visited: false,
    renderMethod: 'http',
    status: 'discovered',
    ...overrides,
  };
}

function makeUnifiedNode(overrides: Partial<UnifiedTreeNode> & { id: string }): UnifiedTreeNode {
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

// ─── treeSnapshotToUnifiedTree ──────────────────────────────────────

describe('treeSnapshotToUnifiedTree', () => {
  it('maps V2 fields from backend to unified tree', () => {
    const backend: BackendTreeNode[] = [
      makeBackendNode({
        url: 'https://example.com/printers',
        label: 'Printers',
        visited: true,
        status: 'visited',
        foundOn: ['https://example.com'],
        discoverySource: 'bfs',
        isGlobalLink: false,
        isVirtual: false,
        childPageCount: 5,
      }),
    ];

    const result = treeSnapshotToUnifiedTree(backend, []);

    expect(result).toHaveLength(1);
    const node = result[0];
    expect(node.id).toBe('https://example.com/printers');
    expect(node.label).toBe('Printers');
    expect(node.status).toBe('explored'); // 'visited' maps to 'explored'
    expect(node.source).toBe('bfs-discovered');
    expect(node.foundOn).toEqual(['https://example.com']);
    expect(node.discoverySource).toBe('bfs');
    expect(node.isGlobalLink).toBe(false);
    expect(node.isVirtual).toBe(false);
    expect(node.childPageCount).toBe(5);
    expect(node.included).toBe(true); // visited → included
  });

  it('maps virtual nodes with correct source', () => {
    const backend: BackendTreeNode[] = [
      makeBackendNode({
        url: 'https://example.com/support',
        label: 'Support',
        isVirtual: true,
        status: 'discovered',
      }),
    ];

    const result = treeSnapshotToUnifiedTree(backend, []);
    expect(result[0].source).toBe('virtual');
    expect(result[0].isVirtual).toBe(true);
  });

  it('maps sitemap discovery source correctly', () => {
    const backend: BackendTreeNode[] = [
      makeBackendNode({
        url: 'https://example.com/sitemap-page',
        label: 'Sitemap Page',
        discoverySource: 'sitemap',
        status: 'visited',
        visited: true,
      }),
    ];

    const result = treeSnapshotToUnifiedTree(backend, []);
    expect(result[0].source).toBe('sitemap');
  });
});

// ─── toggleNodeIncluded ─────────────────────────────────────────────

describe('toggleNodeIncluded', () => {
  it('recursively toggles virtual folder children', () => {
    const tree: UnifiedTreeNode[] = [
      makeUnifiedNode({
        id: 'folder',
        label: 'Virtual Folder',
        isVirtual: true,
        included: false,
        children: [
          makeUnifiedNode({ id: 'child1', included: false }),
          makeUnifiedNode({ id: 'child2', included: false }),
        ],
      }),
    ];

    const result = toggleNodeIncluded(tree, 'folder', true);
    expect(result[0].included).toBe(true);
    expect(result[0].children[0].included).toBe(true);
    expect(result[0].children[1].included).toBe(true);
  });

  it('does not recursively toggle normal (non-virtual) node children', () => {
    const tree: UnifiedTreeNode[] = [
      makeUnifiedNode({
        id: 'parent',
        label: 'Normal Parent',
        isVirtual: false,
        included: false,
        children: [
          makeUnifiedNode({ id: 'child1', included: false }),
          makeUnifiedNode({ id: 'child2', included: false }),
        ],
      }),
    ];

    const result = toggleNodeIncluded(tree, 'parent', true);
    expect(result[0].included).toBe(true);
    expect(result[0].children[0].included).toBe(false);
    expect(result[0].children[1].included).toBe(false);
  });
});

// ─── computeTreeStats ───────────────────────────────────────────────

describe('computeTreeStats — no double-count', () => {
  it('does not double-count pages under virtual folders', () => {
    const tree: UnifiedTreeNode[] = [
      makeUnifiedNode({
        id: 'virtual-folder',
        label: 'Virtual',
        isVirtual: true,
        included: true,
        pageCount: 10, // Virtual folder pageCount should be ignored
        children: [
          makeUnifiedNode({
            id: 'child1',
            included: true,
            pageCount: 5,
          }),
          makeUnifiedNode({
            id: 'child2',
            included: true,
            pageCount: 5,
          }),
        ],
      }),
    ];

    const stats = computeTreeStats(tree);
    // Virtual folder's pageCount is 0 (isVirtual → skip), children contribute 5+5=10
    expect(stats.totalPages).toBe(10);
    expect(stats.includedPages).toBe(10);
    expect(stats.virtualFolders).toBe(1);
  });
});
