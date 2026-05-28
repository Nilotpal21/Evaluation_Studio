import { describe, it, expect } from 'vitest';
import type { DiscoveryTreeNode, TreeRenderConfig } from '../../types';
import {
  formatDisplayName,
  formatUrlForDisplay,
  findNode,
  walkTree,
  flattenTree,
  countNodes,
  upsertNode,
  updateTree,
  computeVisibleNodes,
  getNodeActions,
  computeSubtreeCounts,
  AUTO_COLLAPSE_THRESHOLD,
} from '../tree-utils';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeNode(overrides: Partial<DiscoveryTreeNode> & { url: string }): DiscoveryTreeNode {
  return {
    displayName: overrides.displayName ?? 'Node',
    pathSegment: overrides.pathSegment ?? 'node',
    url: overrides.url,
    source: overrides.source ?? 'seed',
    state: overrides.state ?? 'discovered',
    children: overrides.children ?? [],
    depth: overrides.depth ?? 0,
    confidence: overrides.confidence ?? 'projected',
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<TreeRenderConfig>): TreeRenderConfig {
  return {
    threshold: overrides?.threshold ?? AUTO_COLLAPSE_THRESHOLD,
    mode: overrides?.mode ?? 'auto',
    manuallyExpanded: overrides?.manuallyExpanded ?? new Set(),
    manuallyCollapsed: overrides?.manuallyCollapsed ?? new Set(),
  };
}

// ─── formatDisplayName ────────────────────────────────────────────────

describe('formatDisplayName', () => {
  it('converts hyphens to title case', () => {
    expect(formatDisplayName('my-cool-page')).toBe('My Cool Page');
  });

  it('converts underscores to title case', () => {
    expect(formatDisplayName('user_settings')).toBe('User Settings');
  });

  it('returns empty string for empty input', () => {
    expect(formatDisplayName('')).toBe('');
  });

  it('handles single word', () => {
    expect(formatDisplayName('about')).toBe('About');
  });

  it('handles URL-encoded characters (passed as decoded segment)', () => {
    expect(formatDisplayName('hello-world')).toBe('Hello World');
  });

  it('trims surrounding whitespace', () => {
    expect(formatDisplayName('  docs  ')).toBe('Docs');
  });
});

// ─── formatUrlForDisplay ──────────────────────────────────────────────

describe('formatUrlForDisplay', () => {
  it('strips protocol and host, returns pathname', () => {
    expect(formatUrlForDisplay('https://example.com/docs/api')).toBe('/docs/api');
  });

  it('preserves query string', () => {
    expect(formatUrlForDisplay('https://example.com/search?q=test')).toBe('/search?q=test');
  });

  it('returns pathname with port (port is in host, stripped)', () => {
    expect(formatUrlForDisplay('http://localhost:3000/api/v1')).toBe('/api/v1');
  });

  it('returns root slash for domain-only URL', () => {
    expect(formatUrlForDisplay('https://example.com')).toBe('/');
  });

  it('returns raw string for invalid URL', () => {
    expect(formatUrlForDisplay('not-a-url')).toBe('not-a-url');
  });
});

// ─── findNode ─────────────────────────────────────────────────────────

describe('findNode', () => {
  it('finds a root-level node by URL', () => {
    const root = makeNode({ url: 'https://example.com/about' });
    const found = findNode([root], 'https://example.com/about');
    expect(found).toBe(root);
  });

  it('finds a deeply nested node', () => {
    const leaf = makeNode({
      url: 'https://example.com/a/b/c',
      pathSegment: 'c',
      depth: 2,
    });
    const mid = makeNode({
      url: 'https://example.com/a/b',
      pathSegment: 'b',
      depth: 1,
      children: [leaf],
    });
    const root = makeNode({
      url: 'https://example.com/a',
      pathSegment: 'a',
      children: [mid],
    });
    const found = findNode([root], 'https://example.com/a/b/c');
    expect(found).toBe(leaf);
  });

  it('returns null when URL is not in tree', () => {
    const root = makeNode({ url: 'https://example.com/about' });
    expect(findNode([root], 'https://example.com/missing')).toBeNull();
  });

  it('returns null for empty tree', () => {
    expect(findNode([], 'https://example.com')).toBeNull();
  });
});

// ─── walkTree ─────────────────────────────────────────────────────────

describe('walkTree', () => {
  it('visits all nodes depth-first', () => {
    const child1 = makeNode({
      url: 'https://e.com/a/1',
      displayName: 'C1',
      depth: 1,
    });
    const child2 = makeNode({
      url: 'https://e.com/a/2',
      displayName: 'C2',
      depth: 1,
    });
    const root = makeNode({
      url: 'https://e.com/a',
      displayName: 'R',
      children: [child1, child2],
    });

    const visited: Array<{ name: string; depth: number }> = [];
    walkTree([root], (node, depth) => visited.push({ name: node.displayName, depth }));

    expect(visited).toEqual([
      { name: 'R', depth: 0 },
      { name: 'C1', depth: 1 },
      { name: 'C2', depth: 1 },
    ]);
  });

  it('handles empty roots', () => {
    const visited: string[] = [];
    walkTree([], (node) => visited.push(node.displayName));
    expect(visited).toEqual([]);
  });

  it('visits nested children at correct depths', () => {
    const grandchild = makeNode({
      url: 'https://e.com/a/b/c',
      displayName: 'GC',
      depth: 2,
    });
    const child = makeNode({
      url: 'https://e.com/a/b',
      displayName: 'C',
      depth: 1,
      children: [grandchild],
    });
    const root = makeNode({
      url: 'https://e.com/a',
      displayName: 'R',
      children: [child],
    });

    const depths: number[] = [];
    walkTree([root], (_node, depth) => depths.push(depth));
    expect(depths).toEqual([0, 1, 2]);
  });
});

// ─── flattenTree ──────────────────────────────────────────────────────

describe('flattenTree', () => {
  it('returns all nodes in a flat array', () => {
    const child = makeNode({
      url: 'https://e.com/a/b',
      displayName: 'B',
      depth: 1,
    });
    const root = makeNode({
      url: 'https://e.com/a',
      displayName: 'A',
      children: [child],
    });

    const flat = flattenTree([root]);
    expect(flat).toHaveLength(2);
    expect(flat[0].displayName).toBe('A');
    expect(flat[1].displayName).toBe('B');
  });

  it('returns empty array for empty tree', () => {
    expect(flattenTree([])).toEqual([]);
  });

  it('preserves order across multiple roots', () => {
    const r1 = makeNode({ url: 'https://e.com/x', displayName: 'X' });
    const r2 = makeNode({ url: 'https://e.com/y', displayName: 'Y' });
    const flat = flattenTree([r1, r2]);
    expect(flat.map((n) => n.displayName)).toEqual(['X', 'Y']);
  });
});

// ─── countNodes ───────────────────────────────────────────────────────

describe('countNodes', () => {
  it('counts a single root', () => {
    const root = makeNode({ url: 'https://e.com' });
    expect(countNodes([root])).toBe(1);
  });

  it('counts nested children', () => {
    const gc = makeNode({ url: 'https://e.com/a/b/c', depth: 2 });
    const child = makeNode({
      url: 'https://e.com/a/b',
      depth: 1,
      children: [gc],
    });
    const root = makeNode({
      url: 'https://e.com/a',
      children: [child],
    });
    expect(countNodes([root])).toBe(3);
  });

  it('returns 0 for empty tree', () => {
    expect(countNodes([])).toBe(0);
  });

  it('counts multiple roots with children', () => {
    const c1 = makeNode({ url: 'https://e.com/a/1', depth: 1 });
    const r1 = makeNode({
      url: 'https://e.com/a',
      children: [c1],
    });
    const r2 = makeNode({ url: 'https://e.com/b' });
    expect(countNodes([r1, r2])).toBe(3);
  });
});

// ─── upsertNode ───────────────────────────────────────────────────────

describe('upsertNode', () => {
  it('inserts a new node into empty roots', () => {
    const roots: DiscoveryTreeNode[] = [];
    const node = upsertNode(roots, 'https://example.com/docs', {
      state: 'visiting',
    });

    expect(node.pathSegment).toBe('docs');
    expect(node.state).toBe('visiting');
    expect(node.url).toBe('https://example.com/docs');
  });

  it('updates an existing node', () => {
    const roots: DiscoveryTreeNode[] = [];
    upsertNode(roots, 'https://example.com/docs', { state: 'discovered' });
    const updated = upsertNode(roots, 'https://example.com/docs', {
      state: 'visited',
      confidence: 'verified',
    });

    expect(updated.state).toBe('visited');
    expect(updated.confidence).toBe('verified');
    // Should not duplicate
    expect(flattenTree(roots).filter((n) => n.pathSegment === 'docs')).toHaveLength(1);
  });

  it('creates intermediate nodes for deep paths', () => {
    const roots: DiscoveryTreeNode[] = [];
    const node = upsertNode(roots, 'https://example.com/a/b/c', {
      state: 'visiting',
    });

    expect(node.pathSegment).toBe('c');
    expect(node.state).toBe('visiting');
    // Intermediate 'a' should exist
    expect(roots[0].pathSegment).toBe('a');
    expect(roots[0].children[0].pathSegment).toBe('b');
    expect(roots[0].children[0].children[0].pathSegment).toBe('c');
  });

  it('handles root URL (no path segments)', () => {
    const roots: DiscoveryTreeNode[] = [];
    const node = upsertNode(roots, 'https://example.com/', {
      state: 'visited',
    });

    expect(node.pathSegment).toBe('/');
    expect(node.displayName).toBe('example.com');
    expect(node.state).toBe('visited');
  });

  it('handles invalid URL by creating root-level node', () => {
    const roots: DiscoveryTreeNode[] = [];
    const node = upsertNode(roots, 'not-a-url', { state: 'discovered' });

    expect(node.url).toBe('not-a-url');
    expect(roots).toHaveLength(1);
  });
});

// ─── updateTree ───────────────────────────────────────────────────────

describe('updateTree', () => {
  it('marks currentUrl as visiting', () => {
    const roots: DiscoveryTreeNode[] = [];
    updateTree(roots, { currentUrl: 'https://example.com/page' });

    const node = findNode(roots, 'https://example.com/page');
    expect(node).not.toBeNull();
    expect(node?.state).toBe('visiting');
  });

  it('marks previous visiting URL as visited', () => {
    const roots: DiscoveryTreeNode[] = [];
    upsertNode(roots, 'https://example.com/old', { state: 'visiting' });

    updateTree(roots, { currentUrl: 'https://example.com/new' }, 'https://example.com/old');

    const oldNode = findNode(roots, 'https://example.com/old');
    expect(oldNode?.state).toBe('visited');
    expect(oldNode?.confidence).toBe('verified');

    const newNode = findNode(roots, 'https://example.com/new');
    expect(newNode?.state).toBe('visiting');
  });

  it('adds discovered links as nodes', () => {
    const roots: DiscoveryTreeNode[] = [];
    updateTree(roots, {
      currentUrl: 'https://example.com/hub',
      discoveredOnPage: [
        { href: 'https://example.com/hub/link1', text: 'Link 1', confidence: 'verified' },
        { href: 'https://example.com/hub/link2', text: 'Link 2', confidence: 'projected' },
      ],
    });

    const hub = findNode(roots, 'https://example.com/hub');
    expect(hub?.linkCount).toBe(2);

    const link1 = findNode(roots, 'https://example.com/hub/link1');
    expect(link1).not.toBeNull();
    expect(link1?.confidence).toBe('verified');

    const link2 = findNode(roots, 'https://example.com/hub/link2');
    expect(link2?.confidence).toBe('projected');
  });

  it('adds siblings as discovered nodes', () => {
    const roots: DiscoveryTreeNode[] = [];
    updateTree(roots, {
      currentUrl: 'https://example.com/page',
      siblings: [{ href: 'https://example.com/sibling1', text: 'Sib 1' }],
    });

    const sib = findNode(roots, 'https://example.com/sibling1');
    expect(sib).not.toBeNull();
    expect(sib?.source).toBe('sibling');
    expect(sib?.state).toBe('discovered');
  });

  it('sets currentRole on visiting node', () => {
    const roots: DiscoveryTreeNode[] = [];
    updateTree(roots, {
      currentUrl: 'https://example.com/hub',
      currentRole: 'hub',
    });

    const node = findNode(roots, 'https://example.com/hub');
    expect(node?.role).toBe('hub');
  });
});

// ─── computeVisibleNodes ──────────────────────────────────────────────

describe('computeVisibleNodes', () => {
  it('returns all nodes when below threshold', () => {
    const root = makeNode({
      url: 'https://e.com/a',
      children: [makeNode({ url: 'https://e.com/a/b', depth: 1 })],
    });
    const config = makeConfig({ threshold: 30 });

    const result = computeVisibleNodes([root], config);
    expect(result.visibleRoots).toEqual([root]);
    expect(result.collapsedCount).toBe(0);
  });

  it('returns all nodes in expanded mode regardless of count', () => {
    // Build a tree with >30 nodes
    const children = Array.from({ length: 35 }, (_, i) =>
      makeNode({ url: `https://e.com/n${i}`, displayName: `N${i}`, depth: 1 }),
    );
    const root = makeNode({
      url: 'https://e.com',
      children,
    });
    const config = makeConfig({ threshold: 10, mode: 'expanded' });

    const result = computeVisibleNodes([root], config);
    expect(result.collapsedCount).toBe(0);
    expect(countNodes(result.visibleRoots)).toBe(36); // root + 35 children
  });

  it('collapses to depth 2 in collapsed-2 mode', () => {
    const grandchild = makeNode({
      url: 'https://e.com/a/b/c',
      pathSegment: 'c',
      depth: 2,
      children: [
        makeNode({
          url: 'https://e.com/a/b/c/d',
          pathSegment: 'd',
          depth: 3,
        }),
      ],
    });
    const child = makeNode({
      url: 'https://e.com/a/b',
      pathSegment: 'b',
      depth: 1,
      children: [grandchild],
    });
    const root = makeNode({
      url: 'https://e.com/a',
      pathSegment: 'a',
      depth: 0,
      children: [child],
    });

    // Force above threshold so collapsed-2 applies
    const config = makeConfig({ threshold: 1, mode: 'collapsed-2' });
    const result = computeVisibleNodes([root], config);

    // depth 2 node (grandchild) should have its children cut
    const visibleGrandchild = result.visibleRoots[0].children[0].children[0];
    expect(visibleGrandchild.children).toHaveLength(0);
    expect(result.collapsedCount).toBe(1); // the great-grandchild is collapsed
  });

  it('auto-collapses deep branches with many children when above threshold', () => {
    // Create a tree node at depth 2 with >3 children, all non-active
    const deepChildren = Array.from({ length: 5 }, (_, i) =>
      makeNode({
        url: `https://e.com/a/b/c${i}`,
        pathSegment: `c${i}`,
        depth: 3,
        state: 'discovered',
      }),
    );
    const deepNode = makeNode({
      url: 'https://e.com/a/b',
      pathSegment: 'b',
      depth: 2,
      state: 'discovered',
      children: deepChildren,
    });
    const child = makeNode({
      url: 'https://e.com/a',
      pathSegment: 'a',
      depth: 1,
      children: [deepNode],
    });
    const root = makeNode({
      url: 'https://e.com',
      pathSegment: '/',
      depth: 0,
      children: [child],
    });

    const config = makeConfig({ threshold: 1, mode: 'auto' });
    const result = computeVisibleNodes([root], config);

    // The deep node (depth 2, >3 children, no active) should be collapsed
    const visibleDeep = result.visibleRoots[0].children[0].children[0];
    expect(visibleDeep.children).toHaveLength(0);
    expect(result.collapsedCount).toBe(5);
  });
});

// ─── getNodeActions ───────────────────────────────────────────────────

describe('getNodeActions', () => {
  it('returns explore + add + skip for discovered-projected node', () => {
    const node = makeNode({
      url: 'https://e.com/page',
      state: 'discovered',
      confidence: 'projected',
    });
    const actions = getNodeActions(node);

    expect(actions).toHaveLength(3);
    expect(actions[0].label).toBe('tree_visit_discover');
    expect(actions[0].action).toBe('explore-branch');
    expect(actions[0].availability).toBe('running');
    expect(actions[1].label).toBe('tree_add_scope');
    expect(actions[1].availability).toBe('always');
    expect(actions[2].label).toBe('tree_skip');
    expect(actions[2].availability).toBe('always');
  });

  it('returns go-deeper + add + skip for discovered-verified node', () => {
    const node = makeNode({
      url: 'https://e.com/page',
      state: 'discovered',
      confidence: 'verified',
    });
    const actions = getNodeActions(node);

    expect(actions).toHaveLength(3);
    expect(actions[0].label).toBe('tree_go_deeper');
    expect(actions[0].action).toBe('explore-branch');
    expect(actions[0].availability).toBe('running');
    expect(actions[1].availability).toBe('always');
    expect(actions[2].availability).toBe('always');
  });

  it('returns go-deeper + add-children for visited node', () => {
    const node = makeNode({
      url: 'https://e.com/page',
      state: 'visited',
    });
    const actions = getNodeActions(node);

    expect(actions).toHaveLength(2);
    expect(actions[0].label).toBe('tree_go_deeper');
    expect(actions[0].availability).toBe('running');
    expect(actions[1].label).toBe('tree_add_children');
    expect(actions[1].action).toBe('add-children-to-scope');
    expect(actions[1].availability).toBe('always');
  });

  it('returns stop for visiting node', () => {
    const node = makeNode({
      url: 'https://e.com/page',
      state: 'visiting',
    });
    const actions = getNodeActions(node);

    expect(actions).toHaveLength(1);
    expect(actions[0].label).toBe('tree_stop');
    expect(actions[0].action).toBe('stop');
    expect(actions[0].variant).toBe('danger');
    expect(actions[0].availability).toBe('running');
  });

  it('returns undo-skip + explore for skipped node', () => {
    const node = makeNode({
      url: 'https://e.com/page',
      state: 'skipped',
    });
    const actions = getNodeActions(node);

    expect(actions).toHaveLength(2);
    expect(actions[0].label).toBe('tree_undo_skip');
    expect(actions[0].action).toBe('undo-skip');
    expect(actions[0].availability).toBe('always');
    expect(actions[1].label).toBe('tree_visit_discover');
    expect(actions[1].availability).toBe('running');
  });

  it('returns skip for queued node', () => {
    const node = makeNode({
      url: 'https://e.com/page',
      state: 'queued',
    });
    const actions = getNodeActions(node);

    expect(actions).toHaveLength(1);
    expect(actions[0].label).toBe('tree_skip');
    expect(actions[0].action).toBe('skip-branch');
    expect(actions[0].variant).toBe('danger');
    expect(actions[0].availability).toBe('always');
  });

  it('returns retry + skip for failed node', () => {
    const node = makeNode({
      url: 'https://e.com/page',
      state: 'failed',
    });
    const actions = getNodeActions(node);

    expect(actions).toHaveLength(2);
    expect(actions[0].label).toBe('tree_retry');
    expect(actions[0].action).toBe('explore-branch');
    expect(actions[0].availability).toBe('running');
    expect(actions[1].label).toBe('tree_skip');
    expect(actions[1].variant).toBe('danger');
    expect(actions[1].availability).toBe('always');
  });
});

// ─── computeSubtreeCounts ─────────────────────────────────────────────

describe('computeSubtreeCounts', () => {
  it('returns empty map for empty tree', () => {
    const result = computeSubtreeCounts([]);
    expect(result.size).toBe(0);
  });

  it('returns count 1 for single leaf node', () => {
    const node = makeNode({ url: 'https://e.com/page' });
    const result = computeSubtreeCounts([node]);
    expect(result.get('https://e.com/page')).toBe(1);
  });

  it('returns count 0 for single skipped node', () => {
    const node = makeNode({ url: 'https://e.com/page', state: 'skipped' });
    const result = computeSubtreeCounts([node]);
    expect(result.get('https://e.com/page')).toBe(0);
  });

  it('computes parent count as sum of children + 1', () => {
    const child1 = makeNode({ url: 'https://e.com/a', depth: 1 });
    const child2 = makeNode({ url: 'https://e.com/b', depth: 1 });
    const root = makeNode({
      url: 'https://e.com',
      depth: 0,
      children: [child1, child2],
    });

    const result = computeSubtreeCounts([root]);
    expect(result.get('https://e.com/a')).toBe(1);
    expect(result.get('https://e.com/b')).toBe(1);
    expect(result.get('https://e.com')).toBe(3); // 1 + 1 + 1
  });

  it('skipped nodes contribute 0 to parent count', () => {
    const activeChild = makeNode({ url: 'https://e.com/a', depth: 1 });
    const skippedChild = makeNode({ url: 'https://e.com/b', depth: 1, state: 'skipped' });
    const root = makeNode({
      url: 'https://e.com',
      depth: 0,
      children: [activeChild, skippedChild],
    });

    const result = computeSubtreeCounts([root]);
    expect(result.get('https://e.com/b')).toBe(0);
    expect(result.get('https://e.com')).toBe(2); // 1 (self) + 1 (active) + 0 (skipped)
  });

  it('handles deeply nested tree correctly', () => {
    const leaf = makeNode({ url: 'https://e.com/a/b/c', depth: 3 });
    const mid = makeNode({ url: 'https://e.com/a/b', depth: 2, children: [leaf] });
    const child = makeNode({ url: 'https://e.com/a', depth: 1, children: [mid] });
    const root = makeNode({ url: 'https://e.com', depth: 0, children: [child] });

    const result = computeSubtreeCounts([root]);
    expect(result.get('https://e.com/a/b/c')).toBe(1);
    expect(result.get('https://e.com/a/b')).toBe(2);
    expect(result.get('https://e.com/a')).toBe(3);
    expect(result.get('https://e.com')).toBe(4);
  });

  it('handles multiple roots', () => {
    const root1 = makeNode({
      url: 'https://a.com',
      children: [makeNode({ url: 'https://a.com/x' })],
    });
    const root2 = makeNode({ url: 'https://b.com' });

    const result = computeSubtreeCounts([root1, root2]);
    expect(result.get('https://a.com')).toBe(2);
    expect(result.get('https://a.com/x')).toBe(1);
    expect(result.get('https://b.com')).toBe(1);
  });

  it('handles 10K nodes in < 50ms', () => {
    // Build a wide tree: 1 root with 10K children
    const children: DiscoveryTreeNode[] = [];
    for (let i = 0; i < 10000; i++) {
      children.push(makeNode({ url: `https://e.com/page-${i}`, depth: 1 }));
    }
    const root = makeNode({ url: 'https://e.com', depth: 0, children });

    const start = performance.now();
    const result = computeSubtreeCounts([root]);
    const elapsed = performance.now() - start;

    expect(result.get('https://e.com')).toBe(10001);
    expect(elapsed).toBeLessThan(200);
  });
});
