/**
 * Hybrid Tree Builder — Pure-function module for building discovery trees
 *
 * Supports three view modes:
 * - hybrid: breadcrumb → foundOn → URL-path fallback
 * - crawl-path: foundOn[0] only
 * - url-path: URL-path hierarchy only
 *
 * O(n) single-pass algorithm with virtual node insertion for path gaps.
 */

import type { DiscoveredPage, TreeNode } from './bfs-discovery.js';
import { humanizeSlug, normalizeUrl } from './url-normalizer.js';

// ─── Types ──────────────────────────────────────────────────────────

export type TreeViewMode = 'hybrid' | 'crawl-path' | 'url-path';

export interface HybridTreeOptions {
  viewMode: TreeViewMode;
  /** Fraction of visited pages a link must appear on to be considered global. Default 0.3 (30%) */
  globalLinkThreshold?: number;
}

export interface GlobalLinkInfo {
  linkFrequency: number;
  isGlobalLink: boolean;
}

/** Extended TreeNode with V2 fields that may not yet be in the base interface */
type ExtendedTreeNode = TreeNode & {
  foundOn?: string[];
  discoverySource?: string;
  isGlobalLink?: boolean;
  isVirtual?: boolean;
  childPageCount?: number;
  linkFrequency?: number;
  errorMessage?: string;
};

// ─── Synthetic foundOn values to ignore when selecting parents ──────

const SYNTHETIC_FOUND_ON = new Set(['seed', 'breadcrumb-climb', 'nav-extraction', 'sitemap']);

// ─── Content Dedup ──────────────────────────────────────────────────

/**
 * Deduplicate URLs that share the same pathname but differ only in query params,
 * when they have identical labels (title or linkText). This handles cases like
 * FAQ pages linked with different category params (`?faq_cat=X` vs `?faq_cat=Y`)
 * that are actually the same content.
 *
 * Returns a new Map with duplicates removed. The first-seen URL is kept as canonical.
 * foundOn arrays from duplicates are merged into the canonical entry.
 */
export function deduplicateByPath(
  allUrls: Map<string, DiscoveredPage>,
): Map<string, DiscoveredPage> {
  // Group URLs by pathname (ignoring query string)
  const byPath = new Map<string, Array<{ url: string; page: DiscoveredPage }>>();

  for (const [url, page] of allUrls) {
    try {
      const parsed = new URL(url);
      // Only dedup URLs that HAVE query params — no-query URLs are always unique
      if (!parsed.search) {
        continue;
      }
      const pathKey = `${parsed.origin}${parsed.pathname}`;
      if (!byPath.has(pathKey)) {
        byPath.set(pathKey, []);
      }
      byPath.get(pathKey)!.push({ url, page });
    } catch {
      // Invalid URL — skip dedup
    }
  }

  // Find duplicates: same pathname + same label (title or linkText)
  const urlsToRemove = new Set<string>();
  const foundOnToMerge = new Map<string, string[]>(); // canonical URL -> additional foundOn

  for (const [, entries] of byPath) {
    if (entries.length <= 1) continue;

    // Sub-group by label (title ?? linkText ?? '')
    const byLabel = new Map<string, typeof entries>();
    for (const entry of entries) {
      const label =
        entry.page.title?.trim() ||
        (
          (entry.page as unknown as Record<string, unknown>).linkText as string | undefined
        )?.trim() ||
        '';
      // Don't dedup if we have no label to compare — they might be different content
      if (!label) continue;
      if (!byLabel.has(label)) {
        byLabel.set(label, []);
      }
      byLabel.get(label)!.push(entry);
    }

    for (const [, sameLabel] of byLabel) {
      if (sameLabel.length <= 1) continue;
      // Keep the first one (earliest discovered), remove the rest
      const canonical = sameLabel[0];
      for (let i = 1; i < sameLabel.length; i++) {
        urlsToRemove.add(sameLabel[i].url);
        // Merge foundOn from duplicate into canonical
        const extraFoundOn = sameLabel[i].page.foundOn ?? [];
        if (extraFoundOn.length > 0) {
          if (!foundOnToMerge.has(canonical.url)) {
            foundOnToMerge.set(canonical.url, []);
          }
          foundOnToMerge.get(canonical.url)!.push(...extraFoundOn);
        }
      }
    }
  }

  if (urlsToRemove.size === 0) return allUrls;

  // Build deduplicated map
  const result = new Map<string, DiscoveredPage>();
  for (const [url, page] of allUrls) {
    if (urlsToRemove.has(url)) continue;
    const extraFoundOn = foundOnToMerge.get(url);
    if (extraFoundOn) {
      // Merge foundOn, dedup
      const mergedFoundOn = [...new Set([...(page.foundOn ?? []), ...extraFoundOn])];
      result.set(url, { ...page, foundOn: mergedFoundOn });
    } else {
      result.set(url, page);
    }
  }
  return result;
}

// ─── Main Entry Point ───────────────────────────────────────────────

export function buildHybridTree(
  allUrls: Map<string, DiscoveredPage>,
  primaryUrl: string,
  breadcrumbChains: Array<{
    sourceUrl: string;
    crumbs: Array<{ text: string; href: string }>;
  }>,
  options?: HybridTreeOptions,
): TreeNode[] {
  const viewMode = options?.viewMode ?? 'hybrid';
  const threshold = options?.globalLinkThreshold ?? 0.3;

  // Normalize primaryUrl to match allUrls keys (which are always normalized).
  // Raw primaryUrl may have www prefix, trailing slash, etc. that differ from the key.
  const normalizedPrimary = normalizeUrl(primaryUrl);

  // Deduplicate URLs with same path but different query params and identical labels
  const dedupedUrls = deduplicateByPath(allUrls);

  // 1. PRE-COMPUTE — use dedupedUrls for all downstream processing
  const totalVisited = countVisited(dedupedUrls);
  const globalLinks = computeGlobalLinks(dedupedUrls, threshold, normalizedPrimary);
  const breadcrumbParentMap = buildBreadcrumbParentMap(breadcrumbChains);

  // 2. SELECT PARENTS — O(n)
  const parentMap = new Map<string, string>();
  const parentSource = new Map<string, 'breadcrumb' | 'foundOn' | 'url-path'>();
  for (const [url, page] of dedupedUrls) {
    if (url === normalizedPrimary) continue;
    const result = selectParent(url, page, globalLinks, dedupedUrls, breadcrumbParentMap, viewMode);
    if (result) {
      parentMap.set(url, result.parent);
      parentSource.set(url, result.source);
    }
  }

  // 3. DETECT VIRTUAL NODES — O(n)
  const virtualNodes = detectVirtualNodes(dedupedUrls, parentMap, parentSource, normalizedPrimary);

  // Add virtual nodes to parentMap
  for (const [vUrl, vParent] of virtualNodes) {
    if (!parentMap.has(vUrl)) {
      parentMap.set(vUrl, vParent);
    }
    // Re-parent children that should go through the virtual node
    reparentThroughVirtual(vUrl, parentMap, dedupedUrls, virtualNodes);
  }

  // 4. BUILD NODE MAP — O(n)
  const nodeMap = new Map<string, ExtendedTreeNode>();

  for (const [url, page] of dedupedUrls) {
    const globalInfo = globalLinks.get(url);
    const isGlobal = globalInfo?.isGlobalLink ?? false;
    const freq = globalInfo?.linkFrequency ?? 0;
    nodeMap.set(url, buildNode(url, page, false, isGlobal, freq, 0));
  }

  for (const [vUrl] of virtualNodes) {
    if (!nodeMap.has(vUrl)) {
      nodeMap.set(vUrl, buildNode(vUrl, undefined, true, false, 0, 0));
    }
  }

  // Ensure primary URL node exists
  if (!nodeMap.has(normalizedPrimary)) {
    nodeMap.set(normalizedPrimary, buildNode(normalizedPrimary, undefined, false, false, 0, 0));
  }

  // 5. ASSEMBLE TREE — O(n)
  for (const [childUrl, parentUrl] of parentMap) {
    const parentNode = nodeMap.get(parentUrl);
    const childNode = nodeMap.get(childUrl);
    if (parentNode && childNode) {
      parentNode.children.push(childNode);
    }
  }

  // Collect roots: URLs not in parentMap
  const roots: ExtendedTreeNode[] = [];
  const primaryNode = nodeMap.get(normalizedPrimary);
  if (primaryNode) {
    roots.push(primaryNode);
  }
  for (const [url] of nodeMap) {
    if (url !== normalizedPrimary && !parentMap.has(url)) {
      const node = nodeMap.get(url);
      if (node) {
        roots.push(node);
      }
    }
  }

  // Set depths
  for (const root of roots) {
    setDepths(root, 0);
  }

  // 6. COMPUTE childPageCount — O(n) bottom-up
  for (const root of roots) {
    computeChildPageCount(root);
  }

  return roots as TreeNode[];
}

// ─── Global Link Detection ──────────────────────────────────────────

/**
 * Minimum visited pages before global link detection activates.
 * With 1–2 visited pages, every link found on them appears at 50–100% frequency,
 * which would incorrectly classify ALL links as global. Require ≥3 visited pages
 * so that "appears on >30% of pages" is meaningful.
 */
const MIN_VISITED_FOR_GLOBAL_LINKS = 3;

export function computeGlobalLinks(
  allUrls: Map<string, DiscoveredPage>,
  threshold?: number,
  primaryUrl?: string,
): Map<string, GlobalLinkInfo> {
  const effectiveThreshold = threshold ?? 0.3;
  const totalVisited = countVisited(allUrls);
  const linkAppearanceCount = new Map<string, number>();

  // Count how many visited pages have each URL in their childUrls
  for (const [, page] of allUrls) {
    if (!page.visited) continue;
    const seen = new Set<string>();
    for (const childUrl of page.childUrls) {
      if (!seen.has(childUrl)) {
        seen.add(childUrl);
        linkAppearanceCount.set(childUrl, (linkAppearanceCount.get(childUrl) ?? 0) + 1);
      }
    }
  }

  const result = new Map<string, GlobalLinkInfo>();
  for (const [url] of allUrls) {
    const count = linkAppearanceCount.get(url) ?? 0;
    const frequency = totalVisited > 0 ? count / totalVisited : 0;

    // Never classify the primary URL as a global link — it is always a valid parent.
    // Also require minimum visited pages for meaningful frequency statistics.
    const isGlobal =
      url !== primaryUrl &&
      totalVisited >= MIN_VISITED_FOR_GLOBAL_LINKS &&
      frequency > effectiveThreshold;

    result.set(url, {
      linkFrequency: frequency,
      isGlobalLink: isGlobal,
    });
  }

  return result;
}

// ─── Label Resolution ───────────────────────────────────────────────

export function resolveLabel(
  url: string,
  page: DiscoveredPage | undefined,
  isVirtual: boolean,
): string {
  // 1. page title
  if (page?.title && page.title.trim().length > 0) {
    return page.title.trim();
  }

  // 2. breadcrumbLabel (V2 field, may not exist)
  const breadcrumbLabel = (page as Record<string, unknown> | undefined)?.breadcrumbLabel;
  if (typeof breadcrumbLabel === 'string' && breadcrumbLabel.trim().length > 0) {
    return breadcrumbLabel.trim();
  }

  // 3. linkText (V2 field, may not exist)
  const linkText = (page as Record<string, unknown> | undefined)?.linkText;
  if (typeof linkText === 'string' && linkText.trim().length > 0) {
    return linkText.trim();
  }

  // 4. humanizeSlug of last path segment — but only if it produces a meaningful label.
  //    Short slugs (1-2 chars like "s1") are not useful; prefer hostname for those.
  const lastSegment = getLastPathSegment(url);
  if (lastSegment) {
    const humanized = humanizeSlug(lastSegment);
    if (humanized.length > 2) {
      return humanized;
    }
  }

  // 5. Last raw path segment — only if it's meaningful (>2 chars)
  if (lastSegment && lastSegment.length > 2) {
    return lastSegment;
  }

  // Fallback: domain or URL — preferred for short/meaningless slugs and root URLs
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ─── Parent Selection ───────────────────────────────────────────────

function selectParent(
  url: string,
  page: DiscoveredPage,
  globalLinks: Map<string, GlobalLinkInfo>,
  allUrls: Map<string, DiscoveredPage>,
  breadcrumbParentMap: Map<string, string>,
  viewMode: TreeViewMode,
): { parent: string; source: 'breadcrumb' | 'foundOn' | 'url-path' } | null {
  switch (viewMode) {
    case 'hybrid':
      return selectParentHybrid(url, page, globalLinks, allUrls, breadcrumbParentMap);
    case 'crawl-path':
      return selectParentCrawlPath(page);
    case 'url-path':
      return selectParentUrlPath(url, allUrls);
  }
}

function selectParentHybrid(
  url: string,
  page: DiscoveredPage,
  globalLinks: Map<string, GlobalLinkInfo>,
  allUrls: Map<string, DiscoveredPage>,
  breadcrumbParentMap: Map<string, string>,
): { parent: string; source: 'breadcrumb' | 'foundOn' | 'url-path' } | null {
  // 1. Breadcrumb parent
  const bcParent = breadcrumbParentMap.get(url);
  if (bcParent && allUrls.has(bcParent)) {
    return { parent: bcParent, source: 'breadcrumb' };
  }

  // 2. foundOn — filter out global links and synthetic entries, pick closest by URL-path distance
  const realFoundOn = (page.foundOn ?? []).filter(
    (fo) => !SYNTHETIC_FOUND_ON.has(fo) && !globalLinks.get(fo)?.isGlobalLink && allUrls.has(fo),
  );
  if (realFoundOn.length > 0) {
    const closest = pickClosestByPathDistance(url, realFoundOn);
    if (closest) {
      return { parent: closest, source: 'foundOn' };
    }
  }

  // 3. URL-path ancestor
  const ancestor = findUrlPathAncestor(url, allUrls);
  if (ancestor) {
    return { parent: ancestor, source: 'url-path' };
  }

  // 4. null (root)
  return null;
}

function selectParentCrawlPath(page: DiscoveredPage): { parent: string; source: 'foundOn' } | null {
  const firstFoundOn = (page.foundOn ?? []).find((fo) => !SYNTHETIC_FOUND_ON.has(fo));
  if (firstFoundOn) {
    return { parent: firstFoundOn, source: 'foundOn' };
  }
  return null;
}

function selectParentUrlPath(
  url: string,
  allUrls: Map<string, DiscoveredPage>,
): { parent: string; source: 'url-path' } | null {
  const ancestor = findUrlPathAncestor(url, allUrls);
  if (ancestor) {
    return { parent: ancestor, source: 'url-path' };
  }
  return null;
}

// ─── Breadcrumb Parent Map ──────────────────────────────────────────

function buildBreadcrumbParentMap(
  breadcrumbChains: Array<{
    sourceUrl: string;
    crumbs: Array<{ text: string; href: string }>;
  }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const chain of breadcrumbChains) {
    const crumbs = chain.crumbs;
    for (let i = 1; i < crumbs.length; i++) {
      const child = crumbs[i].href;
      const parent = crumbs[i - 1].href;
      // Only set if not already set (first breadcrumb chain wins)
      if (!map.has(child)) {
        map.set(child, parent);
      }
    }
  }
  return map;
}

// ─── Virtual Node Detection ─────────────────────────────────────────

function detectVirtualNodes(
  allUrls: Map<string, DiscoveredPage>,
  parentMap: Map<string, string>,
  parentSource: Map<string, 'breadcrumb' | 'foundOn' | 'url-path'>,
  primaryUrl: string,
): Map<string, string> {
  const virtualNodes = new Map<string, string>();
  const allKnownUrls = new Set(allUrls.keys());

  for (const [url] of allUrls) {
    const source = parentSource.get(url);
    // Create virtuals for url-path parented nodes or unparented non-primary nodes
    if (source === 'url-path' || (!parentMap.has(url) && url !== primaryUrl)) {
      const gaps = findPathGaps(url, allKnownUrls, virtualNodes);
      for (const [gapUrl, gapParent] of gaps) {
        virtualNodes.set(gapUrl, gapParent);
        allKnownUrls.add(gapUrl);
      }
    }
  }

  return virtualNodes;
}

function findPathGaps(
  url: string,
  knownUrls: Set<string>,
  existingVirtuals: Map<string, string>,
): Array<[string, string]> {
  const gaps: Array<[string, string]> = [];
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length <= 1) return gaps;

    // Walk upward from one level above current
    for (let i = segments.length - 1; i >= 1; i--) {
      const ancestorPath = '/' + segments.slice(0, i).join('/');
      const ancestorUrl = `${parsed.origin}${ancestorPath}`;

      if (knownUrls.has(ancestorUrl) || existingVirtuals.has(ancestorUrl)) {
        break; // Found a real or already-virtual ancestor, stop
      }

      // This is a gap — find its parent
      const parentPath = i > 1 ? '/' + segments.slice(0, i - 1).join('/') : '/';
      const parentUrl = parentPath === '/' ? `${parsed.origin}/` : `${parsed.origin}${parentPath}`;

      // Strip trailing slash for consistency with normalizeUrl output.
      // Root URLs (origin/) and path URLs (origin/path/) both normalize to no trailing slash.
      const normalizedParent = parentUrl.endsWith('/') ? parentUrl.slice(0, -1) : parentUrl;

      gaps.push([ancestorUrl, normalizedParent]);
    }
  } catch {
    // Invalid URL, skip
  }
  return gaps;
}

function reparentThroughVirtual(
  virtualUrl: string,
  parentMap: Map<string, string>,
  allUrls: Map<string, DiscoveredPage>,
  virtualNodes: Map<string, string>,
): void {
  // Check if any children of the virtual node's parent should be reparented
  // through this virtual node (if the child's URL is under the virtual's path)
  try {
    const virtualParsed = new URL(virtualUrl);
    const virtualPath = virtualParsed.pathname;

    for (const [childUrl, currentParent] of parentMap) {
      try {
        const childParsed = new URL(childUrl);
        if (childParsed.origin !== virtualParsed.origin) continue;
        if (childUrl === virtualUrl) continue;

        // If child's path starts with virtual's path and current parent is virtual's parent
        const vParent = virtualNodes.get(virtualUrl) ?? parentMap.get(virtualUrl);
        if (childParsed.pathname.startsWith(virtualPath + '/') && currentParent === vParent) {
          parentMap.set(childUrl, virtualUrl);
        }
      } catch {
        // skip invalid URLs
      }
    }
  } catch {
    // skip invalid virtual URL
  }
}

// ─── URL Path Helpers ───────────────────────────────────────────────

function findUrlPathAncestor(url: string, allUrls: Map<string, DiscoveredPage>): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);

    // Walk upward from one segment shorter to root
    for (let i = segments.length - 1; i >= 1; i--) {
      const ancestorPath = '/' + segments.slice(0, i).join('/');
      const ancestorUrl = `${parsed.origin}${ancestorPath}`;
      if (allUrls.has(ancestorUrl)) {
        return ancestorUrl;
      }
    }

    // Check root
    const rootUrl = `${parsed.origin}/`;
    if (allUrls.has(rootUrl)) return rootUrl;
    const rootUrlNoSlash = parsed.origin;
    if (allUrls.has(rootUrlNoSlash)) return rootUrlNoSlash;
  } catch {
    // Invalid URL
  }
  return null;
}

function pickClosestByPathDistance(targetUrl: string, candidates: string[]): string | null {
  if (candidates.length === 0) return null;

  try {
    const targetSegments = new URL(targetUrl).pathname.split('/').filter(Boolean);

    let best: string | null = null;
    let bestShared = -1;

    for (const candidate of candidates) {
      try {
        const candidateSegments = new URL(candidate).pathname.split('/').filter(Boolean);
        let shared = 0;
        const minLen = Math.min(targetSegments.length, candidateSegments.length);
        for (let i = 0; i < minLen; i++) {
          if (targetSegments[i] === candidateSegments[i]) {
            shared++;
          } else {
            break;
          }
        }
        if (shared > bestShared) {
          bestShared = shared;
          best = candidate;
        }
      } catch {
        // skip invalid candidate
      }
    }

    return best;
  } catch {
    return candidates[0] ?? null;
  }
}

function getLastPathSegment(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const segments = path.split('/').filter(Boolean);
    return segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]) : null;
  } catch {
    return null;
  }
}

// ─── Node Building ──────────────────────────────────────────────────

function buildNode(
  url: string,
  page: DiscoveredPage | undefined,
  isVirtual: boolean,
  isGlobal: boolean,
  linkFrequency: number,
  depth: number,
): ExtendedTreeNode {
  const label = resolveLabel(url, page, isVirtual);

  const baseNode: TreeNode = {
    url,
    label,
    children: [],
    depth,
    visited: page?.visited ?? false,
    renderMethod: page?.renderMethod ?? 'unknown',
    pageRole: page?.pageRole,
    status: page?.status ?? 'discovered',
  };

  return {
    ...baseNode,
    foundOn: page?.foundOn,
    discoverySource: (page as Record<string, unknown> | undefined)?.discoverySource as
      | string
      | undefined,
    isGlobalLink: isGlobal,
    isVirtual,
    childPageCount: 0,
    linkFrequency,
    errorMessage: page?.errorMessage,
  } as ExtendedTreeNode;
}

// ─── Tree Utilities ─────────────────────────────────────────────────

function setDepths(node: ExtendedTreeNode, depth: number): void {
  node.depth = depth;
  for (const child of node.children) {
    setDepths(child as ExtendedTreeNode, depth + 1);
  }
}

function computeChildPageCount(node: ExtendedTreeNode): number {
  if (node.children.length === 0) {
    node.childPageCount = 0;
    return node.visited ? 1 : 0;
  }

  let totalLeafPages = 0;
  for (const child of node.children) {
    totalLeafPages += computeChildPageCount(child as ExtendedTreeNode);
  }

  node.childPageCount = totalLeafPages;
  return totalLeafPages + (node.visited ? 1 : 0);
}

function countVisited(allUrls: Map<string, DiscoveredPage>): number {
  let count = 0;
  for (const [, page] of allUrls) {
    if (page.visited) count++;
  }
  return count;
}
