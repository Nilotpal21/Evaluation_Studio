/**
 * URL Clusterer — groups URLs by path pattern similarity using a trie-based
 * approach with segment frequency analysis.
 *
 * Zero LLM calls — pure algorithmic.
 *
 * Algorithm:
 * 1. Parse each URL into path segments
 * 2. Build a trie of path segments
 * 3. Collapse high-fanout nodes into `{slug}` wildcards
 * 4. Group URLs by their resulting pattern
 * 5. Sort groups by count descending
 *
 * NOTE: UrlGroup is the CANONICAL type definition.
 * T-9 routes and T-7b studio types import from here.
 */

import { createLogger } from '../../logger.js';

const log = createLogger('url-clusterer');

// ─── Public Types ────────────────────────────────────────────────

export interface UrlGroup {
  pattern: string; // e.g., "/docs/{slug}"
  count: number;
  examples: string[]; // first 10 URLs
  depth: number; // path segment depth
}

export interface UrlClusterConfig {
  minGroupSize: number; // default 2
  maxGroups: number; // default 100
  maxUrls: number; // default 100_000 — practical upper bound for selection; crawl-time cap is separate
  /** When true, large groups (>20 URLs) are sub-clustered by consistent query parameter values. Default false. */
  splitByQueryParam?: boolean;
}

export interface UrlClusterResult {
  groups: UrlGroup[];
  ungrouped: string[];
  stats: { totalUrls: number; groupedUrls: number; groupCount: number };
}

// ─── Defaults ────────────────────────────────────────────────────

const DEFAULT_CONFIG: UrlClusterConfig = {
  minGroupSize: 2,
  maxGroups: 100,
  maxUrls: 100_000,
};

/** Maximum number of examples stored per group */
const MAX_EXAMPLES = 10;

/**
 * When a node has many URLs under each child (avg > this threshold),
 * the children are likely category names (e.g., /products/, /docs/)
 * rather than slugs (e.g., /shoe-1/, /shoe-2/). Only collapse when
 * the average URL count per child is below this.
 *
 * WHY: Without this, a small number of category children with identical
 * subtree structure get incorrectly collapsed into {slug}.
 */
const MAX_AVG_URLS_FOR_SLUG = 2;

// ─── Trie Data Structure ─────────────────────────────────────────

interface TrieNode {
  /** Segment value at this node (literal or '{slug}') */
  segment: string;
  /** Child nodes keyed by segment value */
  children: Map<string, TrieNode>;
  /** URLs that terminate at this node */
  urls: string[];
}

function createTrieNode(segment: string): TrieNode {
  return { segment, children: new Map(), urls: [] };
}

// ─── Implementation ──────────────────────────────────────────────

export class UrlClusterer {
  private readonly config: UrlClusterConfig;

  constructor(config?: Partial<UrlClusterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Cluster a list of URLs by path pattern similarity.
   *
   * Steps:
   * 1. Parse URLs into path segments
   * 2. Build a trie of all path segments
   * 3. Collapse high-fanout trie nodes into {slug} wildcards
   * 4. Walk the trie to extract groups
   * 5. Separate ungrouped URLs (groups smaller than minGroupSize)
   * 6. Sort by count descending, cap at maxGroups
   */
  cluster(urls: string[]): UrlClusterResult {
    if (urls.length === 0) {
      return {
        groups: [],
        ungrouped: [],
        stats: { totalUrls: 0, groupedUrls: 0, groupCount: 0 },
      };
    }

    // Cap input to maxUrls
    const inputUrls = urls.slice(0, this.config.maxUrls);

    // Step 1: Parse URLs into path segments
    const parsed = this.parseUrls(inputUrls);

    // Step 2: Build trie
    const root = this.buildTrie(parsed);

    // Step 3: Collapse high-fanout nodes
    this.collapseTrie(root);

    // Step 4: Walk trie to extract pattern → URL mappings
    const patternMap = new Map<string, string[]>();
    this.walkTrie(root, [], patternMap);

    // Step 5: Build groups and separate ungrouped
    // Keep a pattern → full URL list lookup so we can recover ALL URLs
    // when capping groups (not just the MAX_EXAMPLES stored on each group).
    const patternToAllUrls = new Map<string, string[]>();
    const groups: UrlGroup[] = [];
    const ungrouped: string[] = [];

    for (const [pattern, patternUrls] of patternMap) {
      if (patternUrls.length >= this.config.minGroupSize) {
        const depth = pattern === '/' ? 0 : pattern.split('/').filter(Boolean).length;
        patternToAllUrls.set(pattern, patternUrls);
        groups.push({
          pattern,
          count: patternUrls.length,
          examples: patternUrls.slice(0, MAX_EXAMPLES),
          depth,
        });
      } else {
        ungrouped.push(...patternUrls);
      }
    }

    // Step 6 (optional): Sub-cluster large groups by query parameter
    if (this.config.splitByQueryParam) {
      this.splitGroupsByQueryParam(groups, ungrouped);
    }

    // Step 7: Sort by count descending, then cap at maxGroups
    groups.sort((a, b) => b.count - a.count);

    // If we have more groups than allowed, move ALL URLs from excess groups
    // to ungrouped — not just the MAX_EXAMPLES stored on the group.
    if (groups.length > this.config.maxGroups) {
      const excess = groups.splice(this.config.maxGroups);
      for (const group of excess) {
        const allUrls = patternToAllUrls.get(group.pattern);
        if (allUrls) {
          ungrouped.push(...allUrls);
        } else {
          // Fallback for split-generated groups (pattern includes ?param=value)
          ungrouped.push(...group.examples);
        }
      }
    }

    const groupedUrls = groups.reduce((sum, g) => sum + g.count, 0);

    log.debug('Clustering complete', {
      totalUrls: inputUrls.length,
      groupedUrls,
      groupCount: groups.length,
      ungroupedCount: ungrouped.length,
    });

    return {
      groups,
      ungrouped,
      stats: {
        totalUrls: inputUrls.length,
        groupedUrls,
        groupCount: groups.length,
      },
    };
  }

  /**
   * Parse URLs into path segments.
   * Returns array of { url, segments } pairs.
   */
  private parseUrls(urls: string[]): Array<{ url: string; segments: string[] }> {
    const results: Array<{ url: string; segments: string[] }> = [];

    for (const url of urls) {
      try {
        // Handle both absolute URLs and path-only inputs
        let pathname: string;
        if (url.startsWith('http://') || url.startsWith('https://')) {
          const parsed = new URL(url);
          pathname = parsed.pathname;
        } else {
          pathname = url.startsWith('/') ? url : '/' + url;
        }

        const segments = pathname.split('/').filter((s) => s.length > 0);

        results.push({ url, segments });
      } catch {
        // Invalid URL — treat as ungroupable
        log.warn('Failed to parse URL', { url });
        results.push({ url, segments: [] });
      }
    }

    return results;
  }

  /**
   * Build a trie from parsed URL segments.
   * Each leaf stores the original URL.
   */
  private buildTrie(parsed: Array<{ url: string; segments: string[] }>): TrieNode {
    const root = createTrieNode('');

    for (const { url, segments } of parsed) {
      let current = root;

      if (segments.length === 0) {
        // Root path URL
        current.urls.push(url);
        continue;
      }

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        let child = current.children.get(seg);
        if (!child) {
          child = createTrieNode(seg);
          current.children.set(seg, child);
        }
        current = child;
      }

      current.urls.push(url);
    }

    return root;
  }

  /**
   * Collapse high-fanout trie nodes into {slug} wildcards.
   *
   * A node is "high-fanout" when it has more children than minGroupSize
   * AND all children are leaf-like (most URLs terminate at them or they
   * share the same subtree structure).
   *
   * Strategy: At each level, if a node has multiple children where each
   * child is a leaf (has URLs but no further meaningful children), collapse
   * them all into a single {slug} node.
   */
  private collapseTrie(node: TrieNode): void {
    if (node.children.size === 0) return;

    // First, recursively collapse children
    for (const child of node.children.values()) {
      this.collapseTrie(child);
    }

    // Check if children should be collapsed into {slug}
    if (node.children.size >= this.config.minGroupSize) {
      // Analyze children: group them by their subtree structure
      const structureGroups = this.groupBySubtreeStructure(node);

      for (const [, children] of structureGroups) {
        if (children.length >= this.config.minGroupSize) {
          // Check if these children look like slugs vs categories.
          // Categories (products, docs, blog) each have many URLs beneath them.
          // Slugs (shoe-1, shoe-2) each have ~1 URL.
          const totalUrlsUnder = children.reduce((sum, seg) => {
            const child = node.children.get(seg);
            return sum + (child ? this.countUrls(child) : 0);
          }, 0);
          const avgUrlsPerChild = totalUrlsUnder / children.length;

          if (avgUrlsPerChild <= MAX_AVG_URLS_FOR_SLUG) {
            this.collapseChildren(node, children);
          }
        }
      }
    }
  }

  /**
   * Count total URLs in a subtree (recursive).
   */
  private countUrls(node: TrieNode): number {
    let count = node.urls.length;
    for (const child of node.children.values()) {
      count += this.countUrls(child);
    }
    return count;
  }

  /**
   * Group children by their subtree structure.
   * Children with the same set of grandchild keys are structurally similar.
   * Returns Map<structureKey, childSegments[]>.
   */
  private groupBySubtreeStructure(node: TrieNode): Map<string, string[]> {
    const groups = new Map<string, string[]>();

    for (const [segment, child] of node.children) {
      const structureKey = this.getStructureKey(child);
      const group = groups.get(structureKey);
      if (group) {
        group.push(segment);
      } else {
        groups.set(structureKey, [segment]);
      }
    }

    return groups;
  }

  /**
   * Get a structural key for a trie node based on its children's patterns.
   * Leaf nodes (no children, has URLs) → "LEAF"
   * Nodes with children → sorted child keys joined (recursive structure)
   */
  private getStructureKey(node: TrieNode): string {
    if (node.children.size === 0) {
      return 'LEAF';
    }

    // For non-leaf nodes, the structure is defined by the child segment names
    // that are shared (not slug-like themselves)
    const childKeys = Array.from(node.children.keys()).sort();
    const subStructures = childKeys.map((key) => {
      const child = node.children.get(key);
      if (!child) return key;
      return key + ':' + this.getStructureKey(child);
    });

    return subStructures.join(',');
  }

  /**
   * Recursively merge all URLs and children from `source` into `target`.
   * Ensures no URLs are lost at any depth during trie collapse.
   */
  private mergeTrieNodes(target: TrieNode, source: TrieNode): void {
    target.urls.push(...source.urls);
    for (const [key, sourceChild] of source.children) {
      const existing = target.children.get(key);
      if (existing) {
        this.mergeTrieNodes(existing, sourceChild);
      } else {
        target.children.set(key, sourceChild);
      }
    }
  }

  /**
   * Collapse the specified children of a node into a single {slug} node.
   * Merges all URLs and subtrees from the collapsed children.
   */
  private collapseChildren(parent: TrieNode, childSegments: string[]): void {
    // Create the {slug} wildcard node
    const slugNode = createTrieNode('{slug}');

    for (const segment of childSegments) {
      const child = parent.children.get(segment);
      if (!child) continue;

      // Recursively merge the entire subtree into the slug node
      this.mergeTrieNodes(slugNode, child);

      // Remove the original child
      parent.children.delete(segment);
    }

    // Add the {slug} node
    parent.children.set('{slug}', slugNode);
  }

  // ─── Query-Parameter Sub-Clustering ─────────────────────────────

  /** Minimum group size to consider for query-parameter splitting */
  private static readonly QUERY_SPLIT_MIN_GROUP = 20;
  /** A param key must appear in >50% of group URLs to be "consistent" */
  private static readonly QUERY_PARAM_COVERAGE = 0.5;
  /** A consistent param must have >3 distinct values to be worth splitting on */
  private static readonly QUERY_PARAM_MIN_DISTINCT = 3;

  /**
   * Post-process groups: for large groups, check if a consistent query
   * parameter key exists and sub-cluster by its value.
   *
   * Mutates the `groups` array in place — removes the original group
   * and inserts sub-groups.
   */
  private splitGroupsByQueryParam(groups: UrlGroup[], ungrouped: string[]): void {
    // Iterate backwards so splicing doesn't shift indices
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      if (group.count <= UrlClusterer.QUERY_SPLIT_MIN_GROUP) continue;

      // We need all URLs in the group to analyze query params.
      // We only have `examples` (up to MAX_EXAMPLES), so we analyze those.
      // For accurate results, we use the full URL list from the examples.
      const splitParam = this.findConsistentQueryParam(group.examples, group.count);
      if (!splitParam) continue;

      // Sub-cluster the examples by the param value
      const subGroups = new Map<string, string[]>();
      const noParam: string[] = [];

      for (const url of group.examples) {
        const paramValue = this.extractQueryParam(url, splitParam);
        if (paramValue !== null) {
          const bucket = subGroups.get(paramValue);
          if (bucket) {
            bucket.push(url);
          } else {
            subGroups.set(paramValue, [url]);
          }
        } else {
          noParam.push(url);
        }
      }

      // Only proceed if we actually get meaningful sub-groups
      if (subGroups.size < 2) continue;

      // Replace the original group with sub-groups
      const newGroups: UrlGroup[] = [];
      const pendingUngrouped: string[] = [];
      for (const [paramValue, urls] of subGroups) {
        if (urls.length >= this.config.minGroupSize) {
          newGroups.push({
            pattern: `${group.pattern}?${splitParam}=${paramValue}`,
            count: urls.length,
            examples: urls.slice(0, MAX_EXAMPLES),
            depth: group.depth,
          });
        } else {
          pendingUngrouped.push(...urls);
        }
      }

      if (newGroups.length > 0) {
        // Split succeeded — commit ungrouped leftovers and replace original group
        ungrouped.push(...pendingUngrouped);
        ungrouped.push(...noParam);
        groups.splice(i, 1, ...newGroups);

        log.debug('Split group by query param', {
          originalPattern: group.pattern,
          splitParam,
          subGroups: newGroups.length,
        });
      }
      // If no viable sub-groups, keep the original group intact — don't
      // push examples to ungrouped (that would double-count URLs).
    }
  }

  /**
   * Find a query parameter key that is "consistent" across a group's URLs.
   * Consistent = appears in >50% of URLs with >3 distinct values.
   *
   * Returns the param key, or null if none qualifies.
   */
  private findConsistentQueryParam(examples: string[], totalCount: number): string | null {
    // Count param key occurrences and distinct values across examples
    const paramStats = new Map<string, { count: number; values: Set<string> }>();

    for (const url of examples) {
      const params = this.extractAllQueryParams(url);
      for (const [key, value] of params) {
        const stat = paramStats.get(key);
        if (stat) {
          stat.count++;
          stat.values.add(value);
        } else {
          paramStats.set(key, { count: 1, values: new Set([value]) });
        }
      }
    }

    // We use examples as a sample of the full group. Scale coverage check
    // against the examples count, not totalCount, since we only have examples.
    const sampleSize = examples.length;
    const coverageThreshold = sampleSize * UrlClusterer.QUERY_PARAM_COVERAGE;

    let bestParam: string | null = null;
    let bestDistinct = 0;

    for (const [key, stat] of paramStats) {
      if (
        stat.count >= coverageThreshold &&
        stat.values.size >= UrlClusterer.QUERY_PARAM_MIN_DISTINCT
      ) {
        // Prefer the param with the most distinct values
        if (stat.values.size > bestDistinct) {
          bestDistinct = stat.values.size;
          bestParam = key;
        }
      }
    }

    return bestParam;
  }

  /**
   * Extract a specific query parameter value from a URL.
   */
  private extractQueryParam(url: string, paramKey: string): string | null {
    try {
      const parsed = new URL(
        url.startsWith('http')
          ? url
          : `https://example.com${url.startsWith('/') ? url : '/' + url}`,
      );
      return parsed.searchParams.get(paramKey);
    } catch {
      return null;
    }
  }

  /**
   * Extract all query parameter key-value pairs from a URL.
   */
  private extractAllQueryParams(url: string): Array<[string, string]> {
    try {
      const parsed = new URL(
        url.startsWith('http')
          ? url
          : `https://example.com${url.startsWith('/') ? url : '/' + url}`,
      );
      const params: Array<[string, string]> = [];
      parsed.searchParams.forEach((value, key) => {
        params.push([key, value]);
      });
      return params;
    } catch {
      return [];
    }
  }

  /**
   * Walk the trie to extract pattern → URL[] mappings.
   * Patterns are built from the path of segments to each node with URLs.
   */
  private walkTrie(node: TrieNode, pathSegments: string[], result: Map<string, string[]>): void {
    // If this node has URLs, record the pattern
    if (node.urls.length > 0) {
      const pattern = pathSegments.length === 0 ? '/' : '/' + pathSegments.join('/');
      const existing = result.get(pattern);
      if (existing) {
        existing.push(...node.urls);
      } else {
        result.set(pattern, [...node.urls]);
      }
    }

    // Recurse into children
    for (const [, child] of node.children) {
      this.walkTrie(child, [...pathSegments, child.segment], result);
    }
  }
}
