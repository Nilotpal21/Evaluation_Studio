/**
 * Tree to Sections — converts UnifiedTreeNode[] to CrawlSection[].
 *
 * Called when user clicks "Configure Crawl" in the tree footer.
 * Walks the tree, collects all included + explored nodes, generates
 * CrawlSection objects compatible with State 3 Configure flow.
 */

import type { CrawlSection } from '../types';
import type { UnifiedTreeNode } from './unified-tree-types';
import { generateNodeId } from './unified-tree-types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find the longest common URL prefix from an array of URLs (G-12).
 *
 * Extracts pathnames, splits by '/', finds longest common prefix segments.
 * Returns the common prefix as a path string (e.g., "/support/printers").
 */
export function findCommonUrlPrefix(urls: string[]): string {
  if (urls.length === 0) return '/*';

  const pathSegments = urls.map((u) => {
    try {
      return new URL(u).pathname.split('/').filter(Boolean);
    } catch {
      return u.split('/').filter(Boolean);
    }
  });

  if (pathSegments.length === 0) return '/*';

  const first = pathSegments[0];
  let commonLength = first.length;

  for (let i = 1; i < pathSegments.length; i++) {
    const segments = pathSegments[i];
    const maxLen = Math.min(commonLength, segments.length);
    let j = 0;
    while (j < maxLen && first[j] === segments[j]) j++;
    commonLength = j;
    if (commonLength === 0) break;
  }

  if (commonLength === 0) return '/*';
  return '/' + first.slice(0, commonLength).join('/') + '/*';
}

/**
 * Aggregate a virtual folder node (G-3, G-4).
 *
 * Recursively collects all descendant pages, determines render strategy
 * (browser if any child uses browser), and derives pattern from common URL prefix.
 */
export function aggregateVirtualFolder(node: UnifiedTreeNode): {
  pages: Array<{ url: string; title: string }>;
  pageCount: number;
  pattern: string;
  strategy: 'http' | 'browser';
} {
  const pages: Array<{ url: string; title: string }> = [];
  let usesBrowser = false;

  function collectDescendants(n: UnifiedTreeNode): void {
    // Collect pages from non-virtual leaf nodes
    if (!n.isVirtual && n.pages && n.pages.length > 0) {
      pages.push(...n.pages);
    } else if (!n.isVirtual && n.url) {
      // Leaf node without explicit pages — the node itself is a page
      pages.push({ url: n.url, title: n.label });
    }
    if (n.renderMethod === 'browser') usesBrowser = true;
    for (const child of n.children) {
      collectDescendants(child);
    }
  }

  for (const child of node.children) {
    collectDescendants(child);
  }

  const urls = pages.map((p) => p.url);
  const pattern = node.url ? derivePattern(node.url) : findCommonUrlPrefix(urls);

  return {
    pages,
    pageCount: pages.length,
    pattern,
    strategy: usesBrowser ? 'browser' : 'http',
  };
}

// ─── Main Conversion ─────────────────────────────────────────────────────────

/**
 * Convert included tree nodes to CrawlSection[].
 *
 * Rules:
 * 1. Only nodes with `included: true` AND `status: 'explored'` become sections
 * 2. Virtual folders with `included: true` aggregate all descendant pages (G-3, G-4)
 * 3. Sitemap nodes with `included: true` are included even without 'explored' status
 * 4. Nodes with `included: true` AND `status: 'unexplored'` are warned (no page data)
 * 5. If a parent and child are both included, the child becomes its own section
 *    (more specific scope wins — both are kept as separate sections)
 * 6. Section pattern derived from child URLs (G-12)
 * 7. Assigns stable sectionId based on node content, not index (G-10)
 */
export function treeToSections(tree: UnifiedTreeNode[]): {
  sections: CrawlSection[];
  warnings: string[];
} {
  const sections: CrawlSection[] = [];
  const warnings: string[] = [];

  function walk(nodes: UnifiedTreeNode[]): void {
    for (const node of nodes) {
      if (node.included) {
        if (node.isVirtual) {
          // G-3/G-4: Virtual folders aggregate descendant pages
          const agg = aggregateVirtualFolder(node);
          if (agg.pageCount > 0) {
            sections.push(virtualFolderToSection(node, agg));
          }
          // Don't walk children — already aggregated
          continue;
        } else if (node.source === 'sitemap') {
          // Sitemap nodes are included even without 'explored' status
          sections.push(nodeToSection(node));
        } else if (node.status === 'explored' && (node.pageCount ?? 0) > 0) {
          sections.push(nodeToSection(node));
        } else if (node.status === 'unexplored' || node.status === 'auto-matched') {
          warnings.push(
            `"${node.label}" is selected but hasn't been explored yet — it won't be included in the crawl`,
          );
        } else if (node.status === 'error') {
          warnings.push(
            `"${node.label}" had an exploration error — it won't be included in the crawl`,
          );
        }
      }
      // Always walk children — a child may be included even if parent isn't
      walk(node.children);
    }
  }

  walk(tree);
  return { sections, warnings };
}

/**
 * Create a CrawlSection from a regular tree node.
 * Uses content-based stable sectionId (G-10).
 */
function nodeToSection(node: UnifiedTreeNode): CrawlSection {
  const pattern = node.url
    ? derivePattern(node.url)
    : `/${node.label.toLowerCase().replace(/\s+/g, '-')}/*`;

  // G-10: Stable sectionId based on node content, not array index
  const sectionId = `sec-${generateNodeId(node.url || node.label, node.label)}`;

  return {
    sectionId,
    pattern,
    name: node.label,
    pageCount: node.pageCount ?? 0,
    examples: (node.pages ?? []).slice(0, 5).map((p) => p.url),
    included: true,
    estimatedTime: estimateCrawlTime(node.pageCount ?? 0),
    warnings: [],
    depth: node.depth,
    source: node.source === 'sitemap' ? 'sitemap' : 'explored',
    pages: node.pages,
    // 'unknown' and undefined both default to 'http' (safest crawl mode)
    strategy: node.renderMethod === 'browser' ? 'browser' : 'http',
  };
}

/**
 * Create a CrawlSection from a virtual folder's aggregated data.
 */
function virtualFolderToSection(
  node: UnifiedTreeNode,
  agg: ReturnType<typeof aggregateVirtualFolder>,
): CrawlSection {
  // G-10: Stable sectionId
  const sectionId = `sec-${generateNodeId(node.url || node.label, node.label)}`;

  return {
    sectionId,
    pattern: agg.pattern,
    name: node.label,
    pageCount: agg.pageCount,
    examples: agg.pages.slice(0, 5).map((p) => p.url),
    included: true,
    estimatedTime: estimateCrawlTime(agg.pageCount),
    warnings: [],
    depth: node.depth,
    source: 'explored',
    pages: agg.pages,
    strategy: agg.strategy,
  };
}

/**
 * Derive a crawl URL pattern from a node URL.
 *
 * E.g., "https://epson.com/Support/Printers/All-In-Ones" → "/Support/Printers/All-In-Ones/*"
 */
function derivePattern(url: string): string {
  try {
    const pathname = new URL(url).pathname.replace(/\/$/, '');
    return `${pathname}/*`;
  } catch {
    return `${url}/*`;
  }
}

function estimateCrawlTime(pageCount: number): string {
  if (pageCount <= 10) return '< 1 min';
  if (pageCount <= 50) return '1-3 min';
  if (pageCount <= 200) return '3-10 min';
  return '10+ min';
}
