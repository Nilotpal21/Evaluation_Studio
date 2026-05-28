/**
 * Coverage Utilities — Category analysis and gap detection.
 *
 * Pure functions for building coverage analysis from discovery data.
 */

import type {
  CoverageAnalysis,
  CrawlSection,
  DiscoveredCategory,
  DiscoveryTreeNode,
  NavExtractionResult,
  DiscoveryObjective,
} from '../types';
import { flattenTree } from './tree-utils';
import type { DiscoveredUrlSet } from './url-set';

/**
 * Build a coverage analysis from discovery state.
 *
 * Compares explored branches against nav structure to identify gaps.
 */
export function buildCoverageAnalysis(
  urlSet: DiscoveredUrlSet,
  tree: DiscoveryTreeNode[],
  nav: NavExtractionResult | null,
  objectives: DiscoveryObjective[],
  sitemapSectionCount?: number,
): CoverageAnalysis {
  const allNodes = flattenTree(tree);
  const urls = urlSet.toArray();

  // Group URLs by their top-level path segment (category)
  const categoryMap = new Map<string, { verified: number; projected: number; urls: string[] }>();
  for (const url of urls) {
    const category = url.group ?? deriveCategoryLabel(url.href);
    const entry = categoryMap.get(category) ?? { verified: 0, projected: 0, urls: [] };
    if (url.confidence === 'verified') entry.verified++;
    else entry.projected++;
    entry.urls.push(url.href);
    categoryMap.set(category, entry);
  }

  const categories: DiscoveredCategory[] = [...categoryMap.entries()].map(([label, data]) => {
    const total = data.verified + data.projected;
    return {
      label,
      pattern: label.toLowerCase().replace(/\s+/g, '-'),
      urlCount: total,
      confidence: assessCategoryConfidence(data.verified, data.projected, total),
      explored: data.verified > 0,
      matchedObjectives: objectives
        .filter((obj) => data.urls.some((u) => u.toLowerCase().includes(obj.query.toLowerCase())))
        .map((o) => o.id),
    };
  });

  // Identify nav categories not yet explored
  const exploredLabels = new Set(
    categories.filter((c) => c.explored).map((c) => c.label.toLowerCase()),
  );
  const unexploredNavCategories: string[] = [];
  if (nav) {
    for (const navNode of nav.nodes) {
      if (!exploredLabels.has(navNode.label.toLowerCase())) {
        unexploredNavCategories.push(navNode.label);
      }
    }
  }

  const totalVerified = allNodes.filter((n) => n.confidence === 'verified').length;
  const totalProjected = allNodes.filter((n) => n.confidence === 'projected').length;
  const navTotal = nav ? nav.nodes.length : (sitemapSectionCount ?? 0);
  const navCoverageRatio = navTotal > 0 ? exploredLabels.size / navTotal : 1;

  return {
    categories: categories.sort((a, b) => b.urlCount - a.urlCount),
    unexploredNavCategories,
    totalDiscovered: urls.length,
    totalVerified,
    totalProjected,
    navCoverageRatio,
  };
}

/**
 * Assess confidence for a category based on verified vs projected counts.
 * Returns a continuous 0-1 score.
 */
export function assessCategoryConfidence(
  verified: number,
  projected: number,
  total: number,
): number {
  if (total === 0) return 0;
  // Verified URLs weight more heavily
  return Math.min(1, (verified * 1.0 + projected * 0.3) / total);
}

/**
 * Derive a human-readable category label from a URL.
 * Uses the first meaningful path segment.
 */
export function deriveCategoryLabel(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const first = segments[0];
    if (!first) return 'Root';
    return first.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return 'Unknown';
  }
}

/**
 * Merge new discovery results into existing URL set and tree.
 */
export function mergeDiscoveryResults(
  urlSet: DiscoveredUrlSet,
  newResults: Array<{
    href: string;
    text: string;
    confidence: 'verified' | 'projected' | 'inferred';
    depth: number;
  }>,
  _tree: DiscoveryTreeNode[],
): { newCount: number; upgradedCount: number } {
  let newCount = 0;
  let upgradedCount = 0;

  for (const result of newResults) {
    const existed = urlSet.has(result.href);
    const added = urlSet.add(result);

    if (added) {
      newCount++;
    } else if (existed) {
      // Check if confidence was upgraded
      const entry = urlSet.get(result.href);
      if (entry && entry.confidence !== result.confidence) {
        upgradedCount++;
      }
    }
  }

  return { newCount, upgradedCount };
}

/**
 * Should we suggest more discovery based on current state?
 * Signal-based — no static caps.
 */
export function shouldSuggestMoreDiscovery(context: {
  navCoverageRatio: number;
  totalDiscovered: number;
  consecutiveLowYieldPages: number;
  objectivesMet: boolean;
}): boolean {
  // High nav coverage + objectives met = enough
  if (context.navCoverageRatio > 0.8 && context.objectivesMet) return false;

  // Very few discoveries = still worth exploring
  if (context.totalDiscovered < 20) return true;

  // Low nav coverage = suggest more
  if (context.navCoverageRatio < 0.5) return true;

  // Yield stalled = probably not worth continuing
  if (context.consecutiveLowYieldPages > 5) return false;

  return true;
}

/** Maximum number of preview URLs to select */
export const MAX_PREVIEW_URLS = 3;

/**
 * Pick 2-3 representative URLs from included sections for extraction preview.
 *
 * Selection heuristics:
 * - One URL per section (max MAX_PREVIEW_URLS)
 * - Prefer deepest paths (leaf content, not hub/index pages)
 * - Skip sections with no available pages
 */
export function pickPreviewUrls(
  sections: CrawlSection[],
): Array<{ sectionId: string; url: string }> {
  const included = sections.filter((s) => s.included);
  const result: Array<{ sectionId: string; url: string }> = [];

  for (const section of included) {
    if (result.length >= MAX_PREVIEW_URLS) break;

    // Gather candidate URLs from pages or examples
    const candidates: string[] = [];
    if (section.pages && section.pages.length > 0) {
      candidates.push(...section.pages.map((p) => p.url));
    } else if (section.examples && section.examples.length > 0) {
      candidates.push(...section.examples);
    }

    if (candidates.length === 0) continue;

    // Prefer the deepest path (most segments = most likely leaf content)
    const sorted = [...candidates].sort((a, b) => {
      const segA = pathSegmentCount(a);
      const segB = pathSegmentCount(b);
      return segB - segA;
    });

    result.push({ sectionId: section.sectionId ?? section.pattern, url: sorted[0] });
  }

  return result;
}

/** Count path segments in a URL for depth comparison */
function pathSegmentCount(url: string): number {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).length;
  } catch {
    return 0;
  }
}
