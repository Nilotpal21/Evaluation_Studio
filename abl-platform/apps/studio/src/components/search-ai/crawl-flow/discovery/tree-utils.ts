/**
 * Tree Utilities — Discovery tree building and rendering.
 *
 * Pure functions for managing the DiscoveryTreeNode hierarchy.
 * No React imports — these are used by DiscoveryPanel and DiscoveryTree.
 */

import type { DiscoveryTreeNode, TreeRenderConfig, TreeBreadcrumb, NodeAction } from '../types';
import { normalizeDiscoveryUrl } from './url-set';

// ─── Display Formatting ─────────────────────────────────────────────

/**
 * Convert a URL path segment to a human-readable display name.
 * "my-cool-page" → "My Cool Page"
 * "user_settings" → "User Settings"
 */
export function formatDisplayName(segment: string): string {
  if (!segment) return '';
  return segment
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Format a URL for display (pathname only, no origin).
 */
export function formatUrlForDisplay(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

// ─── Tree Operations ────────────────────────────────────────────────

/**
 * Find a node in the tree by URL.
 */
export function findNode(roots: DiscoveryTreeNode[], url: string): DiscoveryTreeNode | null {
  const normalized = normalizeDiscoveryUrl(url);

  function search(nodes: DiscoveryTreeNode[]): DiscoveryTreeNode | null {
    for (const node of nodes) {
      if (normalizeDiscoveryUrl(node.url) === normalized) return node;
      const found = search(node.children);
      if (found) return found;
    }
    return null;
  }

  return search(roots);
}

/**
 * Depth-first traversal of the tree.
 */
export function walkTree(
  roots: DiscoveryTreeNode[],
  callback: (node: DiscoveryTreeNode, depth: number) => void,
): void {
  function walk(nodes: DiscoveryTreeNode[], depth: number): void {
    for (const node of nodes) {
      callback(node, depth);
      walk(node.children, depth + 1);
    }
  }
  walk(roots, 0);
}

/**
 * Flatten tree into a single array of all nodes.
 */
export function flattenTree(roots: DiscoveryTreeNode[]): DiscoveryTreeNode[] {
  const result: DiscoveryTreeNode[] = [];
  walkTree(roots, (node) => result.push(node));
  return result;
}

/**
 * Count total nodes in the tree.
 */
export function countNodes(roots: DiscoveryTreeNode[]): number {
  let count = 0;
  walkTree(roots, () => count++);
  return count;
}

/**
 * Find or create a node at the given URL path.
 * Builds intermediate nodes for missing path segments.
 */
export function upsertNode(
  roots: DiscoveryTreeNode[],
  url: string,
  updates: Partial<Omit<DiscoveryTreeNode, 'children' | 'pathSegment' | 'url'>>,
): DiscoveryTreeNode {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Invalid URL — create a root-level node
    const node: DiscoveryTreeNode = {
      displayName: formatDisplayName(url),
      pathSegment: url,
      url,
      source: 'seed',
      state: 'discovered',
      children: [],
      depth: 0,
      confidence: 'projected',
      ...updates,
    };
    roots.push(node);
    return node;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    // Root URL — find or create root node
    const existing = roots.find((r) => normalizeDiscoveryUrl(r.url) === normalizeDiscoveryUrl(url));
    if (existing) {
      Object.assign(existing, updates);
      return existing;
    }
    const node: DiscoveryTreeNode = {
      displayName: parsed.hostname,
      pathSegment: '/',
      url,
      source: 'seed',
      state: 'discovered',
      children: [],
      depth: 0,
      confidence: 'projected',
      ...updates,
    };
    roots.push(node);
    return node;
  }

  // Walk/create path segments
  let currentNodes = roots;
  let currentUrl = parsed.origin;
  let node: DiscoveryTreeNode | undefined;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    currentUrl += `/${seg}`;
    const isLast = i === segments.length - 1;

    const existing = currentNodes.find((n) => n.pathSegment === seg);
    if (existing) {
      if (isLast) {
        Object.assign(existing, updates);
        return existing;
      }
      currentNodes = existing.children;
      node = existing;
    } else {
      const newNode: DiscoveryTreeNode = {
        displayName: formatDisplayName(seg),
        pathSegment: seg,
        url: isLast ? url : currentUrl,
        source: isLast ? (updates.source ?? 'projected') : 'projected',
        state: isLast ? (updates.state ?? 'discovered') : 'discovered',
        children: [],
        depth: i,
        confidence: isLast ? (updates.confidence ?? 'projected') : 'projected',
        ...(isLast ? updates : {}),
      };
      currentNodes.push(newNode);
      if (isLast) return newNode;
      currentNodes = newNode.children;
      node = newNode;
    }
  }

  return node!;
}

/**
 * Update tree from a depth-prober progress event.
 *
 * Handles: marking current URL as visiting, adding discovered URLs,
 * updating previous visiting URL to visited state.
 */
export function updateTree(
  roots: DiscoveryTreeNode[],
  progress: {
    currentUrl?: string;
    discoveredOnPage?: Array<{ href: string; text: string; confidence: string }>;
    currentRole?: string;
    siblings?: Array<{ href: string; text: string }>;
  },
  prevVisitingUrl?: string,
): void {
  // Mark previous visiting URL as visited
  if (prevVisitingUrl) {
    const prev = findNode(roots, prevVisitingUrl);
    if (prev && prev.state === 'visiting') {
      prev.state = 'visited';
      prev.confidence = 'verified';
    }
  }

  // Mark current URL as visiting
  if (progress.currentUrl) {
    const current = upsertNode(roots, progress.currentUrl, {
      state: 'visiting',
      source: 'visited-hub',
      role: progress.currentRole as 'hub' | 'leaf' | 'mixed' | undefined,
    });

    // Add discovered links as children
    if (progress.discoveredOnPage) {
      current.linkCount = progress.discoveredOnPage.length;
      for (const link of progress.discoveredOnPage) {
        upsertNode(roots, link.href, {
          displayName: link.text || formatDisplayName(extractSegment(link.href)),
          source: 'sibling',
          state: 'discovered',
          confidence: link.confidence === 'verified' ? 'verified' : 'projected',
        });
      }
    }

    // Add siblings
    if (progress.siblings) {
      for (const sib of progress.siblings) {
        upsertNode(roots, sib.href, {
          displayName: sib.text || formatDisplayName(extractSegment(sib.href)),
          source: 'sibling',
          state: 'discovered',
          confidence: 'projected',
        });
      }
    }
  }
}

// ─── Auto-Collapse (D1) ─────────────────────────────────────────────

/** Default threshold for auto-collapse */
export const AUTO_COLLAPSE_THRESHOLD = 30;

/**
 * Compute which nodes should be visible based on the threshold
 * and user overrides (manually expanded/collapsed).
 *
 * When total nodes > threshold, auto-collapses deep branches
 * and returns a breadcrumb trail for navigation.
 */
export function computeVisibleNodes(
  roots: DiscoveryTreeNode[],
  config: TreeRenderConfig,
): {
  visibleRoots: DiscoveryTreeNode[];
  collapsedCount: number;
  breadcrumbs: TreeBreadcrumb[];
} {
  const totalNodes = countNodes(roots);

  if (config.mode === 'expanded' || totalNodes <= config.threshold) {
    // Show everything
    return {
      visibleRoots: roots,
      collapsedCount: 0,
      breadcrumbs: [],
    };
  }

  if (config.mode === 'collapsed-2') {
    // Show only first 2 levels
    const visible = roots.map((r) => collapseToDepth(r, 2, config));
    const visibleCount = countNodes(visible);
    return {
      visibleRoots: visible,
      collapsedCount: totalNodes - visibleCount,
      breadcrumbs: [],
    };
  }

  // Auto mode: collapse branches adaptively
  const visible = roots.map((r) => autoCollapse(r, config, totalNodes));
  const visibleCount = countNodes(visible);

  return {
    visibleRoots: visible,
    collapsedCount: totalNodes - visibleCount,
    breadcrumbs: buildBreadcrumbTrail(roots),
  };
}

function collapseToDepth(
  node: DiscoveryTreeNode,
  maxDepth: number,
  config: TreeRenderConfig,
): DiscoveryTreeNode {
  if (config.manuallyExpanded.has(node.url)) {
    return {
      ...node,
      children: node.children.map((c) => collapseToDepth(c, maxDepth, config)),
    };
  }

  if (node.depth >= maxDepth && !config.manuallyExpanded.has(node.url)) {
    return { ...node, children: [] };
  }

  return {
    ...node,
    children: node.children.map((c) => collapseToDepth(c, maxDepth, config)),
  };
}

function autoCollapse(
  node: DiscoveryTreeNode,
  config: TreeRenderConfig,
  totalNodes: number,
): DiscoveryTreeNode {
  // Respect manual overrides
  if (config.manuallyCollapsed.has(node.url)) {
    return { ...node, children: [] };
  }
  if (config.manuallyExpanded.has(node.url)) {
    return {
      ...node,
      children: node.children.map((c) => autoCollapse(c, config, totalNodes)),
    };
  }

  // Auto-collapse: keep active (visiting) branches open,
  // collapse deep branches with many children
  const hasActiveChild = node.children.some(
    (c) => c.state === 'visiting' || hasActiveDescendant(c),
  );

  if (!hasActiveChild && node.depth >= 2 && node.children.length > 3) {
    return { ...node, children: [] };
  }

  return {
    ...node,
    children: node.children.map((c) => autoCollapse(c, config, totalNodes)),
  };
}

function hasActiveDescendant(node: DiscoveryTreeNode): boolean {
  if (node.state === 'visiting') return true;
  return node.children.some(hasActiveDescendant);
}

function buildBreadcrumbTrail(roots: DiscoveryTreeNode[]): TreeBreadcrumb[] {
  const trail: TreeBreadcrumb[] = [];

  function findActive(nodes: DiscoveryTreeNode[]): void {
    for (const node of nodes) {
      if (node.state === 'visiting' || hasActiveDescendant(node)) {
        trail.push({ label: node.displayName, url: node.url, depth: node.depth });
        findActive(node.children);
        return;
      }
    }
  }

  findActive(roots);
  return trail;
}

// ─── Node Actions (D4) ──────────────────────────────────────────────

/**
 * Get available actions for a tree node based on its state.
 * Returns state-specific action verbs per D4 design decision.
 */
export function getNodeActions(node: DiscoveryTreeNode): NodeAction[] {
  switch (node.state) {
    case 'discovered':
      if (node.confidence === 'projected') {
        return [
          {
            label: 'tree_visit_discover',
            icon: 'compass',
            action: 'explore-branch',
            variant: 'primary',
            availability: 'running',
          },
          {
            label: 'tree_add_scope',
            icon: 'plus',
            action: 'add-to-scope',
            variant: 'secondary',
            availability: 'always',
          },
          {
            label: 'tree_skip',
            icon: 'x',
            action: 'skip-branch',
            variant: 'danger',
            availability: 'always',
          },
        ];
      }
      return [
        {
          label: 'tree_go_deeper',
          icon: 'arrow-down',
          action: 'explore-branch',
          variant: 'primary',
          availability: 'running',
        },
        {
          label: 'tree_add_scope',
          icon: 'plus',
          action: 'add-to-scope',
          variant: 'secondary',
          availability: 'always',
        },
        {
          label: 'tree_skip',
          icon: 'x',
          action: 'skip-branch',
          variant: 'danger',
          availability: 'always',
        },
      ];

    case 'visited':
      return [
        {
          label: 'tree_go_deeper',
          icon: 'arrow-down',
          action: 'explore-branch',
          variant: 'primary',
          availability: 'running',
        },
        {
          label: 'tree_add_children',
          icon: 'plus',
          action: 'add-children-to-scope',
          variant: 'secondary',
          availability: 'always',
        },
      ];

    case 'visiting':
      return [
        {
          label: 'tree_stop',
          icon: 'square',
          action: 'stop',
          variant: 'danger',
          availability: 'running',
        },
      ];

    case 'queued':
      return [
        {
          label: 'tree_skip',
          icon: 'x',
          action: 'skip-branch',
          variant: 'danger',
          availability: 'always',
        },
      ];

    case 'skipped':
      return [
        {
          label: 'tree_undo_skip',
          icon: 'undo',
          action: 'undo-skip',
          variant: 'secondary',
          availability: 'always',
        },
        {
          label: 'tree_visit_discover',
          icon: 'compass',
          action: 'explore-branch',
          variant: 'primary',
          availability: 'running',
        },
      ];

    case 'failed':
      return [
        {
          label: 'tree_retry',
          icon: 'refresh',
          action: 'explore-branch',
          variant: 'primary',
          availability: 'running',
        },
        {
          label: 'tree_skip',
          icon: 'x',
          action: 'skip-branch',
          variant: 'danger',
          availability: 'always',
        },
      ];

    default:
      return [];
  }
}

// ─── Subtree Counts ──────────────────────────────────────────────────

/**
 * Post-order traversal: compute recursive page counts per node.
 *
 * A node counts as 1 page if its state is not 'skipped'.
 * Its subtree count = own count + sum of children subtree counts.
 *
 * Returns Map<node.url, subtreeCount> for O(1) lookup.
 */
export function computeSubtreeCounts(roots: DiscoveryTreeNode[]): Map<string, number> {
  const counts = new Map<string, number>();

  function visit(node: DiscoveryTreeNode): number {
    let childSum = 0;
    for (const child of node.children) {
      childSum += visit(child);
    }
    const ownCount = node.state !== 'skipped' ? 1 : 0;
    const total = ownCount + childSum;
    counts.set(node.url, total);
    return total;
  }

  for (const root of roots) {
    visit(root);
  }

  return counts;
}

// ─── Helpers ────────────────────────────────────────────────────────

function extractSegment(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? '';
  } catch {
    return url;
  }
}
