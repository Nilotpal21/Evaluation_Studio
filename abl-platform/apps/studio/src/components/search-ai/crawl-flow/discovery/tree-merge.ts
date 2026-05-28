/**
 * Tree Merge — converts NavNode[] and UrlGroup[] into UnifiedTreeNode[].
 *
 * Pure functions. No React imports. No side effects.
 */

import type { NavNode } from '../types';
import type { UnifiedTreeNode, UnifiedNodeSource, UnifiedNodeStatus } from './unified-tree-types';
import { generateNodeId } from './unified-tree-types';

// Re-export for convenience
export type { UnifiedTreeNode } from './unified-tree-types';

/**
 * Convert NavNode[] from browser discovery into UnifiedTreeNode[].
 *
 * Maps NavNode.source to UnifiedNodeSource:
 *   'header'       → 'nav-header'
 *   'footer'       → 'nav-footer'
 *   'mega-menu'    → 'nav-mega-menu'
 *   'sitemap-page' → 'sitemap'
 */
export function navNodesToTree(nodes: NavNode[], baseUrl: string): UnifiedTreeNode[] {
  const sourceMap: Record<string, UnifiedNodeSource> = {
    header: 'nav-header',
    footer: 'nav-footer',
    'mega-menu': 'nav-mega-menu',
    'sitemap-page': 'sitemap',
  };

  function convert(navNode: NavNode, depth: number, parentId?: string): UnifiedTreeNode {
    const url = navNode.href ?? '';
    const id = generateNodeId(url, navNode.label, parentId);
    const children = navNode.children.map((child) => convert(child, depth + 1, id));

    return {
      id,
      label: navNode.label,
      url,
      depth,
      children,
      status: 'unexplored',
      source: sourceMap[navNode.source] ?? 'nav-header',
      included: false,
    };
  }

  return nodes.map((node) => convert(node, 0));
}

/**
 * URL group from cluster-urls response.
 * Mirrors the shape returned by POST /cluster-urls.
 */
interface UrlGroup {
  pattern: string;
  name: string;
  urls: Array<{ url: string; title?: string }>;
}

/**
 * Merge sitemap URL groups into an existing tree.
 *
 * For each URL group:
 * 1. Parse each URL's path segments
 * 2. Try to find a matching branch in the tree by path prefix
 * 3. If found: insert pages as children, mark node as explored with sitemap source
 * 4. If not found: create a new root-level branch from URL path structure
 *
 * Returns a new tree (immutable — does not mutate input).
 */
export function mergeSitemapGroups(
  tree: UnifiedTreeNode[],
  groups: UrlGroup[],
  baseUrl: string,
): UnifiedTreeNode[] {
  // Deep clone to avoid mutation
  const result = structuredClone(tree);

  for (const group of groups) {
    if (!group.urls || group.urls.length === 0) continue;

    // Try to find an existing branch that matches the URL pattern
    const sampleUrl = group.urls[0].url;
    const matchingNode = findNodeByUrlPrefix(result, sampleUrl, baseUrl);

    if (matchingNode) {
      // Insert pages into the matching branch
      matchingNode.status = 'explored';
      matchingNode.source = 'sitemap';
      matchingNode.pageCount = group.urls.length;
      matchingNode.pages = group.urls.map((u) => ({
        url: u.url,
        title: u.title ?? extractLastSegment(u.url),
      }));
      matchingNode.included = true;
      matchingNode.exploredAt = Date.now();
    } else {
      // Create a new root-level branch from the URL pattern
      const branchNode = createBranchFromPattern(group, baseUrl);
      result.push(branchNode);
    }
  }

  return result;
}

/**
 * Find a node in the tree whose URL is a prefix of the target URL.
 *
 * Walks depth-first, returns the deepest matching ancestor.
 */
function findNodeByUrlPrefix(
  roots: UnifiedTreeNode[],
  targetUrl: string,
  _baseUrl: string,
): UnifiedTreeNode | null {
  const targetPath = extractPath(targetUrl);
  let bestMatch: UnifiedTreeNode | null = null;
  let bestMatchLength = 0;

  function walk(nodes: UnifiedTreeNode[]): void {
    for (const node of nodes) {
      if (node.url) {
        const nodePath = extractPath(node.url);
        if (
          (targetPath === nodePath || targetPath.startsWith(nodePath + '/')) &&
          nodePath.length > bestMatchLength
        ) {
          bestMatch = node;
          bestMatchLength = nodePath.length;
        }
      }
      walk(node.children);
    }
  }

  walk(roots);
  return bestMatch;
}

function extractPath(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase().replace(/\/$/, '');
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

function extractLastSegment(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    return (
      last
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim() || url
    );
  } catch {
    return url;
  }
}

/**
 * Create a root-level branch from a URL group pattern.
 *
 * E.g., pattern "/global/{slug}" → node "Global" with children for each page.
 */
function createBranchFromPattern(group: UrlGroup, _baseUrl: string): UnifiedTreeNode {
  const branchId = generateNodeId('', group.name);
  const children: UnifiedTreeNode[] = group.urls.map((u) => ({
    id: generateNodeId(u.url, u.title ?? ''),
    label: u.title ?? extractLastSegment(u.url),
    url: u.url,
    depth: 1,
    children: [],
    status: 'explored' as const,
    source: 'sitemap' as const,
    included: true,
    pageCount: 1,
  }));

  return {
    id: branchId,
    label: group.name,
    url: '', // Pattern, not a concrete URL
    depth: 0,
    children,
    status: 'explored',
    source: 'sitemap',
    included: true,
    pageCount: group.urls.length,
    pages: group.urls.map((u) => ({
      url: u.url,
      title: u.title ?? extractLastSegment(u.url),
    })),
    exploredAt: Date.now(),
  };
}

/**
 * Update a tree node with exploration results from POST /discover/node.
 *
 * Finds the node by ID, updates its status to 'explored', adds pages.
 * Returns a new tree (immutable).
 */
export function mergeExploreResult(
  tree: UnifiedTreeNode[],
  nodeId: string,
  pages: Array<{ url: string; title: string }>,
): UnifiedTreeNode[] {
  return tree.map(function updateNode(node): UnifiedTreeNode {
    if (node.id === nodeId) {
      return {
        ...node,
        status: 'explored',
        pageCount: pages.length,
        pages,
        exploredAt: Date.now(),
        exploreId: undefined, // Clear the explore ID
      };
    }
    if (node.children.length > 0) {
      return { ...node, children: node.children.map(updateNode) };
    }
    return node;
  });
}

/**
 * Mark a node's status to 'exploring' with an exploreId.
 *
 * Returns a new tree (immutable).
 */
export function markNodeExploring(
  tree: UnifiedTreeNode[],
  nodeId: string,
  exploreId: string,
): UnifiedTreeNode[] {
  return tree.map(function updateNode(node): UnifiedTreeNode {
    if (node.id === nodeId) {
      return { ...node, status: 'exploring', exploreId };
    }
    if (node.children.length > 0) {
      return { ...node, children: node.children.map(updateNode) };
    }
    return node;
  });
}

/**
 * Mark a node as errored.
 *
 * Returns a new tree (immutable).
 */
export function markNodeError(
  tree: UnifiedTreeNode[],
  nodeId: string,
  errorMessage: string,
): UnifiedTreeNode[] {
  return tree.map(function updateNode(node): UnifiedTreeNode {
    if (node.id === nodeId) {
      return {
        ...node,
        status: 'error',
        errorMessage,
        exploreId: undefined,
      };
    }
    if (node.children.length > 0) {
      return { ...node, children: node.children.map(updateNode) };
    }
    return node;
  });
}

/**
 * Mark nodes matching sample URL patterns as 'auto-matched'.
 *
 * Pattern matching: a node matches if any sample URL's path starts with
 * the node's URL path. E.g., node URL "/Support/Printers" matches sample
 * "https://epson.com/Support/Printers/All-In-Ones/ET-2850/s/SPT_123".
 *
 * Only matches nodes with non-empty URLs and status 'unexplored'.
 *
 * Returns a new tree (immutable).
 */
export function autoMatchNodes(tree: UnifiedTreeNode[], sampleUrls: string[]): UnifiedTreeNode[] {
  const samplePaths = sampleUrls.map((u) => extractPath(u));

  return tree.map(function matchNode(node): UnifiedTreeNode {
    let newNode = node;

    if (node.url && node.status === 'unexplored') {
      const nodePath = extractPath(node.url);
      const matchingSample = samplePaths.find(
        (sp) => sp === nodePath || sp.startsWith(nodePath + '/'),
      );
      if (matchingSample) {
        const matchUrl = sampleUrls[samplePaths.indexOf(matchingSample)];
        newNode = {
          ...node,
          status: 'auto-matched',
          included: true,
          matchedPattern: matchUrl,
        };
      }
    }

    if (node.children.length > 0) {
      const newChildren = node.children.map(matchNode);
      if (newChildren !== node.children) {
        return { ...(newNode === node ? node : newNode), children: newChildren };
      }
    }

    return newNode;
  });
}

/**
 * Toggle the `included` flag on a node (and optionally its subtree).
 *
 * Returns a new tree (immutable).
 */
export function toggleNodeIncluded(
  tree: UnifiedTreeNode[],
  nodeId: string,
  included: boolean,
  recursive: boolean = false,
): UnifiedTreeNode[] {
  return tree.map(function updateNode(node): UnifiedTreeNode {
    if (node.id === nodeId) {
      // Virtual folders always toggle recursively (G-2)
      const effectiveRecursive = recursive || node.isVirtual === true;
      if (effectiveRecursive) {
        return setSubtreeIncluded(node, included);
      }
      return { ...node, included };
    }
    if (node.children.length > 0) {
      return { ...node, children: node.children.map(updateNode) };
    }
    return node;
  });
}

function setSubtreeIncluded(node: UnifiedTreeNode, included: boolean): UnifiedTreeNode {
  return {
    ...node,
    included,
    children: node.children.map((child) => setSubtreeIncluded(child, included)),
  };
}

/**
 * Find a node by ID in the tree.
 */
export function findNodeById(roots: UnifiedTreeNode[], nodeId: string): UnifiedTreeNode | null {
  for (const node of roots) {
    if (node.id === nodeId) return node;
    const found = findNodeById(node.children, nodeId);
    if (found) return found;
  }
  return null;
}

/**
 * Flatten the tree into an array of all nodes.
 */
export function flattenUnifiedTree(roots: UnifiedTreeNode[]): UnifiedTreeNode[] {
  const result: UnifiedTreeNode[] = [];
  function walk(nodes: UnifiedTreeNode[]): void {
    for (const node of nodes) {
      result.push(node);
      walk(node.children);
    }
  }
  walk(roots);
  return result;
}

// ─── BFS Tree Snapshot Conversion ───────────────────────────────────

/** Tree node shape from the backend BFS tree-snapshot SSE event */
interface BackendTreeNode {
  url: string;
  label: string;
  children: BackendTreeNode[];
  depth: number;
  visited: boolean;
  renderMethod: 'http' | 'browser' | 'unknown';
  pageRole?: 'hub' | 'leaf' | 'mixed';
  status: 'discovered' | 'visiting' | 'visited' | 'error';
  /** V2 fields */
  foundOn?: string[];
  discoverySource?: string;
  isGlobalLink?: boolean;
  isVirtual?: boolean;
  childPageCount?: number;
  linkFrequency?: number;
  errorMessage?: string;
}

/**
 * Convert backend BFS tree snapshot nodes to frontend UnifiedTreeNode[].
 *
 * Status mapping:
 *   'visited'    → 'explored'
 *   'visiting'   → 'exploring'
 *   'discovered' → 'unexplored'
 *   'error'      → 'error'
 *
 * Auto-match: if any sampleUrl path starts with the node's URL path,
 * set status to 'auto-matched' and included = true.
 *
 * Node ID = URL (not simpleHash) for stable identity across snapshots.
 */
export function treeSnapshotToUnifiedTree(
  backendTree: BackendTreeNode[],
  sampleUrls: string[],
): UnifiedTreeNode[] {
  const samplePaths = sampleUrls.map((u) => extractPath(u));

  const statusMap: Record<string, UnifiedNodeStatus> = {
    visited: 'explored',
    visiting: 'exploring',
    discovered: 'unexplored',
    error: 'error',
  };

  function convert(node: BackendTreeNode): UnifiedTreeNode {
    const children = node.children.map(convert);
    const nodePath = extractPath(node.url);
    let status = statusMap[node.status] ?? 'unexplored';
    let included = node.visited || node.status === 'visiting';
    let matchedPattern: string | undefined;

    // Auto-match against sample URLs for unexplored nodes
    if (status === 'unexplored' && node.url) {
      const matchIdx = samplePaths.findIndex(
        (sp) => sp === nodePath || sp.startsWith(nodePath + '/'),
      );
      if (matchIdx >= 0) {
        status = 'auto-matched';
        included = true;
        matchedPattern = sampleUrls[matchIdx];
      }
    }

    // Determine source: virtual nodes → 'virtual', sitemap → 'sitemap', default → 'bfs-discovered'
    const source: UnifiedNodeSource = node.isVirtual
      ? 'virtual'
      : node.discoverySource === 'sitemap'
        ? 'sitemap'
        : 'bfs-discovered';

    return {
      id: node.url,
      label: node.label,
      url: node.url,
      depth: node.depth,
      children,
      status,
      source,
      included,
      visited: node.visited,
      renderMethod: node.renderMethod,
      matchedPattern,
      foundOn: node.foundOn,
      discoverySource: node.discoverySource,
      isGlobalLink: node.isGlobalLink ?? false,
      isVirtual: node.isVirtual ?? false,
      childPageCount: node.childPageCount,
      linkFrequency: node.linkFrequency,
      pageRole: node.pageRole,
      errorMessage: node.errorMessage,
    };
  }

  const converted = backendTree.map(convert);
  return groupOrphanNodes(converted);
}

/**
 * Bulk toggle the `included` flag on multiple nodes by ID.
 *
 * Uses a Set for O(1) lookup. Returns a new tree (immutable).
 */
export function bulkToggleIncluded(
  tree: UnifiedTreeNode[],
  nodeIds: string[],
  included: boolean,
): UnifiedTreeNode[] {
  const idSet = new Set(nodeIds);

  return tree.map(function updateNode(node): UnifiedTreeNode {
    const newNode = idSet.has(node.id) ? { ...node, included } : node;
    if (node.children.length > 0) {
      const newChildren = node.children.map(updateNode);
      return newNode === node
        ? { ...node, children: newChildren }
        : { ...newNode, children: newChildren };
    }
    return newNode;
  });
}

// ─── Orphan Node Grouping ───────────────────────────────────────────

/** ID for the synthetic "Other Pages" group */
export const OTHER_PAGES_GROUP_ID = '__other-pages__';

/**
 * Group orphan root nodes (non-primary, no shared URL-path prefix with
 * the primary subtree) into a single "Other Pages" collector node.
 *
 * Rules:
 * - The first root with children is treated as the primary subtree.
 * - All other root-level leaf nodes (no children) are orphans.
 * - Root-level nodes WITH children stay as separate roots (they formed
 *   their own subtree in the tree builder, e.g., virtual path groups).
 * - If ≤2 orphans exist, don't bother grouping — leave them as roots.
 * - Orphans are sorted alphabetically by label inside the group.
 */
export function groupOrphanNodes(roots: UnifiedTreeNode[]): UnifiedTreeNode[] {
  if (roots.length <= 1) return roots;

  // Find primary root (first root with children, or first root)
  const primaryIdx = roots.findIndex((r) => r.children.length > 0);
  const primary = primaryIdx >= 0 ? roots[primaryIdx] : roots[0];

  const kept: UnifiedTreeNode[] = [];
  const orphans: UnifiedTreeNode[] = [];

  for (const root of roots) {
    if (root === primary) {
      kept.push(root);
    } else if (root.children.length > 0) {
      // Root-level subtrees stay as separate roots
      kept.push(root);
    } else {
      orphans.push(root);
    }
  }

  // Don't create group for very few orphans
  if (orphans.length <= 2) {
    return [...kept, ...orphans];
  }

  // Sort orphans alphabetically
  orphans.sort((a, b) => a.label.localeCompare(b.label));

  const otherPagesGroup: UnifiedTreeNode = {
    id: OTHER_PAGES_GROUP_ID,
    label: 'Other Pages',
    url: '',
    depth: 0,
    children: orphans.map((o) => ({ ...o, depth: 1 })),
    status: 'unexplored',
    source: 'virtual',
    included: false,
    isVirtual: true,
  };

  return [...kept, otherPagesGroup];
}
