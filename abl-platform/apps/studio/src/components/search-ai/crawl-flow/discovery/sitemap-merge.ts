/**
 * Sitemap Merge — preview and merge sitemap URLs into a UnifiedTreeNode[].
 *
 * Pure functions. No React imports. No side effects.
 */

import type { UnifiedTreeNode } from './unified-tree-types';
import { generateNodeId } from './unified-tree-types';

/** Common URL patterns to auto-exclude at sitemap import */
export const EXCLUSION_PATTERNS = [
  /^\/(login|logout|signin|signout|register|signup)\b/i,
  /^\/(cart|checkout|basket|order)\b/i,
  /^\/api\//i,
  /^\/(admin|dashboard|cms)\b/i,
  /^\/(account|profile|settings|preferences)\b/i,
  /^\/(search|results)\b/i,
];

export interface SitemapMergePreview {
  totalSitemapUrls: number;
  newUrls: number;
  overlapUrls: number;
  excludedUrls: number;
  pathGroups: Array<{ path: string; count: number }>;
}

/**
 * Check whether a URL pathname matches any exclusion pattern.
 */
export function matchesExclusionPattern(urlPath: string): boolean {
  return EXCLUSION_PATTERNS.some((p) => p.test(urlPath));
}

/**
 * Collect all URLs already present in a tree into a Set.
 */
function collectExistingUrls(nodes: UnifiedTreeNode[]): Set<string> {
  const urls = new Set<string>();
  function walk(list: UnifiedTreeNode[]): void {
    for (const n of list) {
      if (n.url) urls.add(n.url);
      walk(n.children);
    }
  }
  walk(nodes);
  return urls;
}

/**
 * Preview the effect of merging sitemap URLs into the tree
 * without actually performing the merge.
 */
export function previewSitemapMerge(
  tree: UnifiedTreeNode[],
  sitemapUrls: string[],
): SitemapMergePreview {
  const existingUrls = collectExistingUrls(tree);

  let overlapUrls = 0;
  let excludedUrls = 0;
  const pathGroupMap = new Map<string, number>();

  for (const url of sitemapUrls) {
    if (existingUrls.has(url)) {
      overlapUrls++;
      continue;
    }
    try {
      const pathname = new URL(url).pathname;
      if (matchesExclusionPattern(pathname)) excludedUrls++;
      const topLevel = '/' + (pathname.split('/').filter(Boolean)[0] ?? '');
      pathGroupMap.set(topLevel, (pathGroupMap.get(topLevel) ?? 0) + 1);
    } catch {
      /* skip invalid URLs */
    }
  }

  const pathGroups = Array.from(pathGroupMap.entries())
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalSitemapUrls: sitemapUrls.length,
    newUrls: sitemapUrls.length - overlapUrls,
    overlapUrls,
    excludedUrls,
    pathGroups,
  };
}

/**
 * Derive a human-readable label from the last path segment of a URL.
 */
function labelFromUrl(url: string): string {
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
 * Find or create intermediate folder nodes for a given URL path.
 *
 * Returns the parent node under which the leaf node should be inserted.
 * Creates virtual folder nodes along the path as needed.
 */
function findOrCreateParent(
  roots: UnifiedTreeNode[],
  pathname: string,
  baseUrl: string,
): { parent: UnifiedTreeNode[]; depth: number } {
  const segments = pathname.split('/').filter(Boolean);

  // Only the leaf is the actual page — walk up to its parent folder
  if (segments.length <= 1) {
    return { parent: roots, depth: 0 };
  }

  let current = roots;
  let depth = 0;

  // Walk path segments except the last one (the page itself)
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const folderPath = '/' + segments.slice(0, i + 1).join('/');
    const folderUrl = baseUrl + folderPath;
    const folderId = generateNodeId(folderUrl, segment);

    let folder = current.find((n) => n.id === folderId);
    if (!folder) {
      folder = {
        id: folderId,
        label: segment.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        url: folderUrl,
        depth: i,
        children: [],
        status: 'unexplored',
        source: 'virtual',
        included: true,
        isVirtual: true,
      };
      current.push(folder);
    }
    current = folder.children;
    depth = i + 1;
  }

  return { parent: current, depth };
}

/**
 * Merge sitemap URLs into an existing tree.
 *
 * For each sitemap URL not already in the tree:
 * - Creates a new UnifiedTreeNode with source='sitemap'
 * - Inserts it under the appropriate virtual folder based on URL path
 * - Sets included=false for URLs matching exclusion patterns
 *
 * Returns a new tree array (immutable — does not mutate input).
 */
export function mergeSitemapUrlsIntoTree(
  tree: UnifiedTreeNode[],
  sitemapUrls: string[],
  baseUrl: string,
): UnifiedTreeNode[] {
  const result = structuredClone(tree);
  const existingUrls = collectExistingUrls(result);

  for (const url of sitemapUrls) {
    if (existingUrls.has(url)) continue;

    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      continue;
    }

    const excluded = matchesExclusionPattern(pathname);
    const label = labelFromUrl(url);
    const nodeId = generateNodeId(url, label);

    const { parent, depth } = findOrCreateParent(result, pathname, baseUrl);

    const node: UnifiedTreeNode = {
      id: nodeId,
      label,
      url,
      depth,
      children: [],
      status: 'explored',
      pageCount: 1,
      source: 'sitemap',
      discoverySource: 'sitemap',
      included: !excluded,
      exploredAt: Date.now(),
    };

    parent.push(node);
    existingUrls.add(url);
  }

  // Update virtual folder page counts
  updateVirtualFolderCounts(result);

  return result;
}

/**
 * Recursively update virtual folder childPageCount and pageCount.
 */
function updateVirtualFolderCounts(nodes: UnifiedTreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.isVirtual) {
      const childCount = updateVirtualFolderCounts(node.children);
      node.childPageCount = childCount;
      node.pageCount = childCount;
      total += childCount;
    } else {
      total += node.pageCount ?? 1;
      if (node.children.length > 0) {
        updateVirtualFolderCounts(node.children);
      }
    }
  }
  return total;
}
