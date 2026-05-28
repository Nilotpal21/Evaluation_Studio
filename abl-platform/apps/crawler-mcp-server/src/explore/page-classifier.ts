/**
 * Page Role Classifier — Hub vs. Leaf Detection
 *
 * Lightweight heuristic that analyzes a rendered page to determine whether
 * it's a hub (category listing, navigation gateway) or a leaf (content page,
 * product detail). Used by the depth prober to decide dynamically whether
 * to explore deeper or stop.
 *
 * Signals used:
 *   - Link homogeneity: ratio of same-prefix links to total links
 *   - Content density: ratio of prose text to total text
 *   - DOM repetition: links inside repeated container structures
 *   - Terminal URL cues: model numbers, SKUs, dates in last path segment
 *   - Structural markers: <article>, breadcrumbs, pagination
 */

import type { Page } from 'playwright';

// ─── Types ──────────────────────────────────────────────────────────

export type PageRole = 'hub' | 'leaf' | 'mixed';

export interface PageMetrics {
  /** Total number of <a href> links on the page */
  totalLinks: number;
  /** Links sharing the current page's path prefix */
  samePrefixLinks: number;
  /** Links inside repeated parent structures (grids, lists, card layouts) */
  linksInRepeatedContainers: number;
  /** Total visible text length */
  totalTextLength: number;
  /** Text inside prose elements (<p>, <article>, <section> with >100 chars) */
  proseTextLength: number;
  /** Whether the page has an <article> tag */
  hasArticleTag: boolean;
  /** Whether breadcrumb navigation is present */
  hasBreadcrumb: boolean;
  /** Whether pagination controls are present */
  hasPagination: boolean;
  /** Number of parent elements with 3+ similarly-structured children */
  repeatedContainerCount: number;
  /** The last segment of the current URL path */
  lastPathSegment: string;
  /** Current page URL */
  url: string;
}

// ─── Thresholds ─────────────────────────────────────────────────────

/** Minimum link count to consider a page a potential hub */
const MIN_HUB_LINKS = 5;

/** Same-prefix ratio above which the page is likely a hub */
const HUB_PREFIX_RATIO = 0.4;

/** Repeated container ratio above which the page is likely a hub */
const HUB_CONTAINER_RATIO = 0.35;

/** Prose ratio above which the page is likely a leaf */
const LEAF_PROSE_RATIO = 0.4;

/** Terminal slug pattern — model numbers, SKUs, dates, IDs */
const TERMINAL_SLUG_PATTERN = /(?:\d{3,}|[a-z]+-\d+[a-z]*|\d{4}-\d{2}|[a-f0-9]{8,})/i;

// ─── Classifier ─────────────────────────────────────────────────────

/**
 * Classify a page as hub, leaf, or mixed based on collected metrics.
 * Pure function — no browser interaction.
 */
export function classifyPage(metrics: PageMetrics): PageRole {
  const {
    totalLinks,
    samePrefixLinks,
    linksInRepeatedContainers,
    totalTextLength,
    proseTextLength,
    hasArticleTag,
    hasBreadcrumb,
    hasPagination,
    repeatedContainerCount,
    lastPathSegment,
  } = metrics;

  // ─── Leaf signals ───────────────────────────────────────────
  const proseRatio = totalTextLength > 0 ? proseTextLength / totalTextLength : 0;
  const hasTerminalSlug = TERMINAL_SLUG_PATTERN.test(lastPathSegment);

  // Strong leaf: has article tag + substantial prose
  if (hasArticleTag && proseRatio > LEAF_PROSE_RATIO) {
    return 'leaf';
  }

  // Strong leaf: terminal slug + prose-heavy
  if (hasTerminalSlug && proseRatio > 0.3) {
    return 'leaf';
  }

  // ─── Hub signals ────────────────────────────────────────────
  const samePrefixRatio = totalLinks > 0 ? samePrefixLinks / totalLinks : 0;
  const containerRatio = totalLinks > 0 ? linksInRepeatedContainers / totalLinks : 0;

  // Strong hub: many same-prefix links in repeated containers, low prose
  if (
    totalLinks >= MIN_HUB_LINKS &&
    samePrefixRatio > HUB_PREFIX_RATIO &&
    containerRatio > HUB_CONTAINER_RATIO &&
    proseRatio < 0.3
  ) {
    return 'hub';
  }

  // Hub with pagination (listing page)
  if (hasPagination && samePrefixRatio > 0.3 && totalLinks >= MIN_HUB_LINKS) {
    return 'hub';
  }

  // Hub: lots of repeated containers even without strong prefix match
  if (repeatedContainerCount >= 3 && totalLinks >= MIN_HUB_LINKS * 2 && proseRatio < 0.2) {
    return 'hub';
  }

  // ─── Mixed / ambiguous ─────────────────────────────────────
  // Has breadcrumbs (suggests hierarchy) but unclear direction
  if (hasBreadcrumb && samePrefixRatio > 0.25 && totalLinks >= MIN_HUB_LINKS) {
    return 'mixed';
  }

  // Moderate signals in both directions
  if (samePrefixRatio > 0.3 && proseRatio > 0.2) {
    return 'mixed';
  }

  // Default: too few links or too much prose → leaf
  if (totalLinks < MIN_HUB_LINKS || proseRatio > LEAF_PROSE_RATIO) {
    return 'leaf';
  }

  return 'mixed';
}

// ─── Metrics Collection ─────────────────────────────────────────────

/**
 * Collect page metrics from a rendered Playwright page.
 * Runs a single page.evaluate() call for efficiency.
 */
export async function collectPageMetrics(page: Page): Promise<PageMetrics> {
  const url = page.url();
  const pathname = new URL(url).pathname;
  const pathSegments = pathname.split('/').filter(Boolean);
  const lastPathSegment = pathSegments[pathSegments.length - 1] ?? '';
  // Use up to 3 prefix segments for same-prefix detection
  const prefixDepth = Math.min(pathSegments.length - 1, 3);
  const prefix = prefixDepth > 0 ? '/' + pathSegments.slice(0, prefixDepth).join('/') : '/';

  const rawMetrics = (await page.evaluate(
    `(function() {
      var prefix = ${JSON.stringify(prefix)};
      var origin = location.origin;

      // ─── Link analysis ───────────────────────────────────
      var allLinks = document.querySelectorAll('a[href]');
      var totalLinks = 0;
      var samePrefixLinks = 0;
      var linkElements = [];

      for (var i = 0; i < allLinks.length; i++) {
        var a = allLinks[i];
        var href = a.href;
        if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
        totalLinks++;
        try {
          var u = new URL(href);
          if (u.origin === origin && u.pathname.startsWith(prefix + '/')) {
            samePrefixLinks++;
          }
        } catch(e) {}
        linkElements.push(a);
      }

      // ─── Repeated container detection ────────────────────
      // Find parent elements that have 3+ child links with similar structure
      var containerMap = new Map();
      for (var j = 0; j < linkElements.length; j++) {
        var parent = linkElements[j].parentElement;
        // Walk up to find a meaningful container (not just <li> or <span>)
        var depth = 0;
        while (parent && depth < 3) {
          if (parent.children.length >= 3) break;
          parent = parent.parentElement;
          depth++;
        }
        if (parent) {
          if (!containerMap.has(parent)) containerMap.set(parent, 0);
          containerMap.set(parent, containerMap.get(parent) + 1);
        }
      }

      var linksInRepeatedContainers = 0;
      var repeatedContainerCount = 0;
      containerMap.forEach(function(count) {
        if (count >= 3) {
          repeatedContainerCount++;
          linksInRepeatedContainers += count;
        }
      });

      // ─── Text analysis ───────────────────────────────────
      var totalTextLength = (document.body.textContent || '').trim().length;

      var proseTextLength = 0;
      var proseEls = document.querySelectorAll('p, article, [class*="content"], [class*="description"], [class*="body"]');
      for (var k = 0; k < proseEls.length; k++) {
        var text = (proseEls[k].textContent || '').trim();
        if (text.length > 100) {
          proseTextLength += text.length;
        }
      }
      // Cap prose at total to avoid double-counting nested elements
      if (proseTextLength > totalTextLength) proseTextLength = totalTextLength;

      // ─── Structural markers ──────────────────────────────
      var hasArticleTag = document.querySelector('article') !== null;
      var hasBreadcrumb = document.querySelector('nav[aria-label*="breadcrumb" i], [class*="breadcrumb" i], [role="navigation"][class*="bread" i]') !== null;
      var hasPagination = document.querySelector('[class*="pagination" i], [aria-label*="pagination" i], nav[class*="pager" i]') !== null;
      if (!hasPagination) {
        // Check for "Next" / "Previous" link patterns
        var navLinks = document.querySelectorAll('a');
        for (var m = 0; m < navLinks.length; m++) {
          var lt = (navLinks[m].textContent || '').trim().toLowerCase();
          if (lt === 'next' || lt === 'next page' || lt === 'next ›' || lt === 'next »') {
            hasPagination = true;
            break;
          }
        }
      }

      return {
        totalLinks: totalLinks,
        samePrefixLinks: samePrefixLinks,
        linksInRepeatedContainers: linksInRepeatedContainers,
        totalTextLength: totalTextLength,
        proseTextLength: proseTextLength,
        hasArticleTag: hasArticleTag,
        hasBreadcrumb: hasBreadcrumb,
        hasPagination: hasPagination,
        repeatedContainerCount: repeatedContainerCount
      };
    })()`,
  )) as Omit<PageMetrics, 'lastPathSegment' | 'url'>;

  return {
    ...rawMetrics,
    lastPathSegment,
    url,
  };
}
