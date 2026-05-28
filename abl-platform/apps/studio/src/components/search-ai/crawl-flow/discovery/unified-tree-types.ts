/**
 * Unified Tree Types — single tree model for discovery.
 *
 * Replaces the disconnected DiscoveryTreeNode[] + CrawlSection[] with one
 * UnifiedTreeNode[] where tree nodes ARE sections.
 */

/** Exploration status of a tree node */
export type UnifiedNodeStatus =
  | 'unexplored' // Nav node found, not yet explored
  | 'auto-matched' // URL pattern matches sample URLs, queued for auto-explore
  | 'exploring' // Currently being HTTP-explored (loading)
  | 'explored' // Explored, page count known
  | 'error'; // Exploration failed (timeout, MCP down)

/** How this node was discovered */
export type UnifiedNodeSource =
  | 'nav-header'
  | 'nav-footer'
  | 'nav-mega-menu'
  | 'sitemap'
  | 'http-explored'
  | 'bfs-discovered'
  | 'virtual';

/** A single node in the unified discovery tree */
export interface UnifiedTreeNode {
  /** Stable identifier — hash of URL or label path for no-href nodes */
  id: string;
  /** Human-readable display name */
  label: string;
  /** Navigable URL. Empty string for no-href nav items (mega-menu triggers) */
  url: string;
  /** Depth in the tree (0 = root) */
  depth: number;
  /** Child nodes */
  children: UnifiedTreeNode[];
  /** Exploration status */
  status: UnifiedNodeStatus;
  /** Number of pages found under this node (set after exploration) */
  pageCount?: number;
  /** Individual pages discovered under this node */
  pages?: Array<{ url: string; title: string }>;
  /** How this node was originally discovered */
  source: UnifiedNodeSource;
  /** Whether this node is included in crawl scope (user toggle) */
  included: boolean;
  /** If auto-matched, the sample URL pattern that matched */
  matchedPattern?: string;
  /** Timestamp of when exploration completed */
  exploredAt?: number;
  /** Error message if status is 'error' */
  errorMessage?: string;
  /** Active explore ID (for SSE connection tracking) */
  exploreId?: string;
  /** Rendering method detected by BFS engine */
  renderMethod?: 'http' | 'browser' | 'unknown';
  /** Whether BFS engine visited this URL */
  visited?: boolean;
  /** URLs where this node was discovered from */
  foundOn?: string[];
  /** Discovery source identifier (e.g., 'bfs', 'sitemap', 'nav') */
  discoverySource?: string;
  /** Whether this link appears across many pages (global nav/footer) */
  isGlobalLink?: boolean;
  /** Whether this is a synthetic folder node (not a real page) */
  isVirtual?: boolean;
  /** Number of child pages under this node */
  childPageCount?: number;
  /** How many pages link to this URL */
  linkFrequency?: number;
  /** Role of this page in the site structure */
  pageRole?: 'hub' | 'leaf' | 'mixed';
}

/** Stats computed from a unified tree */
export interface UnifiedTreeStats {
  totalNodes: number;
  exploredNodes: number;
  autoMatchedNodes: number;
  unexploredNodes: number;
  includedNodes: number;
  totalPages: number;
  includedPages: number;
  exploringNodes: number;
  errorNodes: number;
  virtualFolders: number;
  sitemapPages: number;
  exploredPages: number;
}

/**
 * Compute aggregate stats from a unified tree.
 */
export function computeTreeStats(roots: UnifiedTreeNode[]): UnifiedTreeStats {
  const stats: UnifiedTreeStats = {
    totalNodes: 0,
    exploredNodes: 0,
    autoMatchedNodes: 0,
    unexploredNodes: 0,
    includedNodes: 0,
    totalPages: 0,
    includedPages: 0,
    exploringNodes: 0,
    errorNodes: 0,
    virtualFolders: 0,
    sitemapPages: 0,
    exploredPages: 0,
  };

  function walk(nodes: UnifiedTreeNode[]): void {
    for (const node of nodes) {
      stats.totalNodes++;
      if (node.isVirtual) {
        stats.virtualFolders++;
      }
      if (node.status === 'explored') stats.exploredNodes++;
      if (node.status === 'auto-matched') stats.autoMatchedNodes++;
      if (node.status === 'unexplored') stats.unexploredNodes++;
      if (node.status === 'exploring') stats.exploringNodes++;
      if (node.status === 'error') stats.errorNodes++;

      // Only count pages for non-virtual nodes to avoid double-counting
      const nodePages = node.isVirtual ? 0 : (node.pageCount ?? 0);
      stats.totalPages += nodePages;
      if (node.included) {
        stats.includedNodes++;
        stats.includedPages += nodePages;
      }

      // Track source-specific page counts
      if (node.source === 'sitemap') {
        stats.sitemapPages += nodePages;
      }
      if (node.status === 'explored' && node.source !== 'sitemap') {
        stats.exploredPages += nodePages;
      }

      walk(node.children);
    }
  }

  walk(roots);
  return stats;
}

/**
 * Generate a stable ID for a tree node.
 *
 * Uses URL for nodes with URLs, or a label-based path for no-href nodes.
 * The ID must be deterministic so the same node gets the same ID across
 * tree rebuilds (e.g., when merging sitemap results).
 */
export function generateNodeId(url: string, label: string, parentId?: string): string {
  if (url) return `node-${simpleHash(url)}`;
  // No-href nodes: use parent path + label
  const path = parentId ? `${parentId}/${label}` : label;
  return `node-${simpleHash(path)}`;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(36);
}
