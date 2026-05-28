/**
 * SimHash-based template fingerprinter for grouping pages by DOM structure.
 *
 * Algorithm:
 * 1. Parse HTML with cheerio
 * 2. DOM normalization (strip noise elements: scripts, styles, ads, cookies)
 * 3. Extract ordered tag-path sequence via depth-first pre-order walk
 * 4. Compute 64-bit SimHash over tag-path features
 * 5. Hamming distance <= 3 = same template
 *
 * Zero LLM calls — pure heuristic.
 */

import * as cheerio from 'cheerio';
import { createLogger } from '../../logger.js';

const log = createLogger('template-fingerprinter');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** FNV-1a offset basis for 64-bit hash */
const FNV_OFFSET_BASIS = 14695981039346656037n;

/** FNV-1a prime for 64-bit hash */
const FNV_PRIME = 1099511628211n;

/** Mask for 64-bit unsigned value */
const MASK_64 = (1n << 64n) - 1n;

/**
 * Maximum Hamming distance to consider two fingerprints as the same template.
 * WHY 3: empirically, same-template pages with different content differ by 1-3 bits
 * in the SimHash. At 4+ bits the DOM structure is meaningfully different.
 */
const SAME_TEMPLATE_THRESHOLD = 3;

/**
 * Maximum DOM depth for tag-path extraction.
 * WHY 15: deeper nesting is usually repeated content (e.g., nested list items,
 * comment threads), not structural template elements. Capping at 15 captures
 * the page layout while ignoring content-driven nesting.
 */
const MAX_TAG_PATH_DEPTH = 15;

/**
 * Maximum HTML size to process (5 MB).
 * WHY 5MB: larger pages are typically data dumps or minified bundles,
 * not meaningful template content. Truncating prevents memory issues.
 */
const MAX_HTML_SIZE = 5 * 1024 * 1024;

/**
 * Maximum number of tag paths to feed into SimHash.
 * WHY 10000: a page with 10K DOM elements is already very large (e.g., complex dashboards).
 * Capping prevents O(n) SimHash from becoming slow on pathological pages (e.g., a
 * 50K-row data table rendered as individual DOM elements).
 */
const MAX_TAG_PATHS = 10000;

/**
 * Maximum number of DOM nodes to process after cheerio.load().
 * WHY 50000: cheerio.load() cost is proportional to node count, not byte size.
 * A 5MB HTML of tiny tags (e.g., `<td>` data tables) can create 1M+ nodes that
 * pass the MAX_HTML_SIZE check but cause multi-minute normalizeDOM/extractTagPaths.
 * 50K nodes covers complex dashboards; beyond that we fall back to a size-based fingerprint.
 */
const MAX_DOM_NODES = 50000;

/** Tags to strip during DOM normalization */
const DEFAULT_STRIP_TAGS = ['script', 'style', 'noscript', 'iframe', 'svg'];

/**
 * Class/ID patterns to strip during DOM normalization.
 * WHY specific patterns instead of generic \bad\b: generic "ad" matches "add",
 * "loading-ad-hoc", "made-in-canada". Targeting container/wrapper/slot/banner
 * suffixes hits real ad elements with near-zero false positives.
 */
const DEFAULT_STRIP_CLASS_PATTERNS: RegExp[] = [
  /ad[-_]?(?:container|wrapper|slot|banner)/i,
  /cookie[-_]?(?:consent|banner|notice)/i,
  /banner[-_]?(?:overlay|wrapper)/i,
  /popup[-_]?(?:overlay|modal)/i,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of fingerprinting a single page */
export interface TemplateFingerprint {
  fingerprint: bigint; // 64-bit SimHash
  tagPathCount: number; // number of tag paths extracted
  url?: string; // optional URL for tracking
}

/** A cluster of same-template pages */
export interface TemplateCluster {
  templateId: string; // generated ID (e.g., "tpl-{first-4-hex-of-fingerprint}")
  representativeFingerprint: bigint; // member with minimum total Hamming distance to all others (centroid)
  // WHY not median: hash values have no meaningful median. Min-total-Hamming selects the most central member.
  pages: string[]; // URLs or identifiers
  size: number;
}

/** Result of comparing two fingerprints */
export interface TemplateMatchResult {
  isSameTemplate: boolean;
  hammingDistance: number; // 0-64
  similarity: number; // 0.0-1.0 (1 - distance/64)
}

/** Clustering result */
export interface ClusteringResult {
  clusters: TemplateCluster[];
  unclustered: string[]; // pages that didn't match any cluster
  stats: {
    totalPages: number;
    totalClusters: number;
    averageClusterSize: number;
    largestCluster: number;
  };
}

/** Elements to strip during DOM normalization */
export interface NormalizationConfig {
  stripTags: string[]; // default: ['script', 'style', 'noscript', 'iframe', 'svg']
  stripClassPatterns: RegExp[]; // default: ad/cookie/banner/popup patterns
  // WHY specific patterns: generic \bad\b matches "add", "loading-ad-hoc".
  // Targeting container/wrapper suffixes hits real ad elements.
  maxDepth: number; // default: 15 — ignore deeply nested elements
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * SimHash-based template fingerprinter.
 *
 * Zero LLM calls — pure heuristic.
 */
export class TemplateFingerprinter {
  private readonly config: NormalizationConfig;

  constructor(config?: Partial<NormalizationConfig>) {
    this.config = {
      stripTags: config?.stripTags ?? DEFAULT_STRIP_TAGS,
      stripClassPatterns: config?.stripClassPatterns ?? DEFAULT_STRIP_CLASS_PATTERNS,
      maxDepth: config?.maxDepth ?? MAX_TAG_PATH_DEPTH,
    };
  }

  /**
   * Fingerprint a single HTML page.
   *
   * Edge cases:
   * - Empty/whitespace HTML returns zero fingerprint
   * - Malformed HTML is handled gracefully by cheerio's error tolerance
   * - HTML > 5MB is truncated with a warning log
   */
  fingerprint(html: string, url?: string): TemplateFingerprint {
    if (!html || html.trim().length === 0) {
      return { fingerprint: 0n, tagPathCount: 0, url };
    }

    let processedHtml = html;
    if (processedHtml.length > MAX_HTML_SIZE) {
      log.warn('HTML exceeds 5MB, truncating for fingerprinting', {
        url: url ?? 'unknown',
        originalSize: processedHtml.length,
        truncatedTo: MAX_HTML_SIZE,
      });
      processedHtml = processedHtml.slice(0, MAX_HTML_SIZE);
    }

    const $ = cheerio.load(processedHtml);

    // Guard against pathological HTML with excessive DOM nodes.
    // cheerio.load() is proportional to node count, not byte size.
    // A 5MB HTML of tiny tags creates 1M+ nodes → multi-minute parse.
    const nodeCount = $('*').length;
    if (nodeCount > MAX_DOM_NODES) {
      log.warn('DOM node count exceeds MAX_DOM_NODES, returning size-based fingerprint', {
        url: url ?? 'unknown',
        nodeCount,
        maxNodes: MAX_DOM_NODES,
      });
      // Return a deterministic fingerprint based on node count + truncated HTML hash
      // This is less accurate but prevents O(N) operations on huge DOMs
      const fallbackFeature = `node-count:${nodeCount}:html-len:${processedHtml.length}`;
      return {
        fingerprint: TemplateFingerprinter.simhash([fallbackFeature]),
        tagPathCount: 0,
        url,
      };
    }

    this.normalizeDOM($);
    let tagPaths = this.extractTagPaths($);

    // Cap tag paths to prevent slow SimHash on pathological pages
    if (tagPaths.length > MAX_TAG_PATHS) {
      log.warn('Tag paths exceed MAX_TAG_PATHS, truncating for fingerprinting', {
        url: url ?? 'unknown',
        tagPathCount: tagPaths.length,
        truncatedTo: MAX_TAG_PATHS,
      });
      tagPaths = tagPaths.slice(0, MAX_TAG_PATHS);
    }

    return {
      fingerprint: TemplateFingerprinter.simhash(tagPaths),
      tagPathCount: tagPaths.length,
      url,
    };
  }

  /** Compare two fingerprints */
  compare(a: bigint, b: bigint): TemplateMatchResult {
    const distance = TemplateFingerprinter.hammingDistance(a, b);
    return {
      isSameTemplate: distance <= SAME_TEMPLATE_THRESHOLD,
      hammingDistance: distance,
      similarity: 1 - distance / 64,
    };
  }

  /**
   * Cluster multiple fingerprints by template similarity.
   *
   * Uses single-linkage clustering with Hamming distance threshold <= 3.
   *
   * Known limitation: Single-linkage clustering is susceptible to chain effects —
   * two dissimilar pages can end up in the same cluster via intermediate pages
   * that are similar to each. For POC validation on 50-100 pages this is acceptable.
   * Production implementation should consider centroid-linkage or DBSCAN with
   * Hamming distance metric.
   */
  cluster(fingerprints: TemplateFingerprint[]): ClusteringResult {
    const clusters: Array<{
      members: TemplateFingerprint[];
    }> = [];
    const assigned = new Set<number>();

    // Sort for deterministic ordering
    const sorted = fingerprints.map((fp, idx) => ({ fp, idx }));
    sorted.sort((a, b) => {
      if (a.fp.fingerprint < b.fp.fingerprint) return -1;
      if (a.fp.fingerprint > b.fp.fingerprint) return 1;
      return 0;
    });

    for (const { fp, idx } of sorted) {
      if (assigned.has(idx)) continue;

      // Find nearest cluster where any member has Hamming distance <= threshold
      let bestCluster: number | null = null;
      let bestDistance = SAME_TEMPLATE_THRESHOLD + 1;

      for (let ci = 0; ci < clusters.length; ci++) {
        for (const member of clusters[ci].members) {
          const dist = TemplateFingerprinter.hammingDistance(fp.fingerprint, member.fingerprint);
          if (dist <= SAME_TEMPLATE_THRESHOLD && dist < bestDistance) {
            bestCluster = ci;
            bestDistance = dist;
            break; // single-linkage: one match suffices
          }
        }
      }

      if (bestCluster !== null) {
        clusters[bestCluster].members.push(fp);
      } else {
        clusters.push({ members: [fp] });
      }
      assigned.add(idx);
    }

    // Build result clusters
    const resultClusters: TemplateCluster[] = clusters.map((c) => {
      // Representative = member with minimum total Hamming distance to all others (centroid)
      const representative = this.findCentroid(c.members);
      const hexPrefix = representative.fingerprint.toString(16).padStart(16, '0').slice(0, 4);

      return {
        templateId: `tpl-${hexPrefix}`,
        representativeFingerprint: representative.fingerprint,
        pages: c.members.map((m) => m.url ?? `fingerprint-${m.fingerprint.toString(16)}`),
        size: c.members.length,
      };
    });

    // Pages in clusters of size 1 that have no URL are "unclustered"
    // But per spec, unclustered = pages that didn't match any cluster
    // With single-linkage, every page ends up in some cluster (possibly size 1)
    // We treat size-1 clusters as unclustered
    const unclustered: string[] = [];
    const finalClusters: TemplateCluster[] = [];

    for (const cluster of resultClusters) {
      if (cluster.size === 1) {
        unclustered.push(cluster.pages[0]);
      } else {
        finalClusters.push(cluster);
      }
    }

    const totalPages = fingerprints.length;
    const totalClusters = finalClusters.length;
    const avgSize =
      totalClusters > 0 ? finalClusters.reduce((sum, c) => sum + c.size, 0) / totalClusters : 0;
    const largestCluster = finalClusters.reduce((max, c) => Math.max(max, c.size), 0);

    return {
      clusters: finalClusters,
      unclustered,
      stats: {
        totalPages,
        totalClusters,
        averageClusterSize: avgSize,
        largestCluster,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Static utility methods
  // -------------------------------------------------------------------------

  /**
   * Compute Hamming distance between two 64-bit values.
   * Uses Brian Kernighan's popcount algorithm on XOR result.
   */
  static hammingDistance(a: bigint, b: bigint): number {
    let x = a ^ b;
    let count = 0;
    while (x) {
      count++;
      x &= x - 1n; // clear lowest set bit
    }
    return count;
  }

  /**
   * Compute 64-bit SimHash from an array of feature strings.
   *
   * WHY SimHash: locality-sensitive hash — similar inputs produce similar hashes.
   * Two pages with the same template but different content will share most
   * tag-path features, producing hashes that differ by only a few bits.
   */
  static simhash(features: string[]): bigint {
    if (features.length === 0) return 0n;

    // Initialize 64-element weight vector
    const V = new Array<number>(64).fill(0);

    for (const feature of features) {
      const hash = TemplateFingerprinter.fnv1a64(feature);

      for (let i = 0; i < 64; i++) {
        if ((hash >> BigInt(i)) & 1n) {
          V[i] += 1;
        } else {
          V[i] -= 1;
        }
      }
    }

    // Convert weight vector to final hash
    let result = 0n;
    for (let i = 0; i < 64; i++) {
      if (V[i] > 0) {
        result |= 1n << BigInt(i);
      }
    }

    return result;
  }

  /**
   * FNV-1a 64-bit hash.
   *
   * WHY FNV-1a: simple, fast, well-distributed for string hashing.
   * No crypto overhead needed for template fingerprinting.
   */
  static fnv1a64(input: string): bigint {
    let hash = FNV_OFFSET_BASIS;
    for (let i = 0; i < input.length; i++) {
      const charCode = input.charCodeAt(i);
      // Handle multi-byte: process each byte of UTF-16 code unit
      hash = hash ^ BigInt(charCode & 0xff);
      hash = (hash * FNV_PRIME) & MASK_64;
      if (charCode > 0xff) {
        hash = hash ^ BigInt((charCode >> 8) & 0xff);
        hash = (hash * FNV_PRIME) & MASK_64;
      }
    }
    return hash;
  }

  // -------------------------------------------------------------------------
  // Private methods
  // -------------------------------------------------------------------------

  /**
   * Normalize DOM by stripping noise elements.
   * WHY: ads, cookies, A/B test wrappers change DOM but not template.
   */
  private normalizeDOM($: cheerio.CheerioAPI): void {
    // Strip noise tags
    for (const tag of this.config.stripTags) {
      $(tag).remove();
    }

    // Strip elements with ad/cookie/banner class or id patterns
    // WHY $('*').each: no targeted selector for arbitrary class patterns. O(N*P) cost
    // is acceptable for POC; production should use targeted selectors for performance.
    $('*').each((_index, element) => {
      if (element.type !== 'tag') return;

      const el = $(element);
      const className = el.attr('class') ?? '';
      const id = el.attr('id') ?? '';

      for (const pattern of this.config.stripClassPatterns) {
        // WHY reset lastIndex: defense against callers passing /g flag patterns,
        // which would make .test() stateful and alternate true/false
        pattern.lastIndex = 0;
        if (pattern.test(className) || pattern.test(id)) {
          el.remove();
          return; // element removed, stop checking patterns
        }
      }
    });

    // Collapse whitespace-only text nodes
    // WHY: whitespace differences between same-template pages (e.g., minified vs pretty-printed)
    // would generate different tag-path counts, causing false negatives in template matching
    $('*')
      .contents()
      .filter((_i, node) => node.type === 'text' && !$(node).text().trim())
      .remove();
  }

  /**
   * Extract tag paths via depth-first pre-order walk.
   * Each element emits its full ancestor path: "html>body>div>main>h1"
   * Depth capped at config.maxDepth.
   */
  private extractTagPaths($: cheerio.CheerioAPI): string[] {
    const paths: string[] = [];

    const walkElement = (el: ReturnType<typeof $>, ancestors: string[], depth: number): void => {
      el.contents().each((_i, node) => {
        if (depth > this.config.maxDepth) return;

        if (node.type === 'tag') {
          const tagName = 'tagName' in node ? String(node.tagName).toLowerCase() : '';
          const currentPath = [...ancestors, tagName];
          paths.push(currentPath.join('>'));
          walkElement($(node), currentPath, depth + 1);
        }
      });
    };

    walkElement($.root(), [], 0);
    return paths;
  }

  /**
   * Find the centroid member: the one with minimum total Hamming distance to all others.
   * WHY not median: hash values have no meaningful median. Min-total-Hamming
   * selects the most central member.
   */
  private findCentroid(members: TemplateFingerprint[]): TemplateFingerprint {
    if (members.length === 1) return members[0];

    let bestMember = members[0];
    let bestTotalDistance = Number.MAX_SAFE_INTEGER;

    for (const candidate of members) {
      let totalDistance = 0;
      for (const other of members) {
        totalDistance += TemplateFingerprinter.hammingDistance(
          candidate.fingerprint,
          other.fingerprint,
        );
      }
      if (totalDistance < bestTotalDistance) {
        bestTotalDistance = totalDistance;
        bestMember = candidate;
      }
    }

    return bestMember;
  }

  // -------------------------------------------------------------------------
  // Serialization helpers
  // -------------------------------------------------------------------------

  /**
   * Convert a TemplateFingerprint to a JSON-safe object.
   *
   * WHY: BigInt cannot be JSON.stringify'd (throws TypeError). This helper
   * converts the fingerprint to a hex string for storage/transport.
   * Use `fromSerializable()` to reconstruct.
   */
  static toSerializable(fp: TemplateFingerprint): {
    fingerprint: string;
    tagPathCount: number;
    url?: string;
  } {
    return {
      fingerprint: fp.fingerprint.toString(16).padStart(16, '0'),
      tagPathCount: fp.tagPathCount,
      url: fp.url,
    };
  }

  /**
   * Reconstruct a TemplateFingerprint from a serialized object.
   *
   * WHY try-catch: the fingerprint string comes from external storage (DB, JSON files).
   * Malformed hex strings would throw SyntaxError from BigInt constructor.
   * Returning zero fingerprint on error is safe — it just won't match any template.
   */
  static fromSerializable(obj: {
    fingerprint: string;
    tagPathCount: number;
    url?: string;
  }): TemplateFingerprint {
    let fp: bigint;
    try {
      fp = BigInt('0x' + obj.fingerprint);
    } catch {
      log.warn('Invalid fingerprint hex string in fromSerializable, defaulting to 0', {
        fingerprint: obj.fingerprint,
      });
      fp = 0n;
    }
    return {
      fingerprint: fp,
      tagPathCount: obj.tagPathCount,
      url: obj.url,
    };
  }
}
