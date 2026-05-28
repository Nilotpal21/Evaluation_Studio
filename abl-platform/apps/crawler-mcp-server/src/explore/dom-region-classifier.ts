/**
 * DOM Region Classifier
 *
 * Classifies a page's DOM into semantic regions (content, nav, sidebar, footer)
 * using landmark elements and spatial heuristics. Returns regions sorted by
 * click priority (content-main first).
 *
 * Architecture: pure classification function + thin page.evaluate bridge.
 * Unlike api-interceptor.ts which uses an attach/detach lifecycle pattern
 * (for ongoing interception), this is a one-shot classify call — no handle needed.
 */

import type { Page } from 'playwright';

// ─── Types ──────────────────────────────────────────────────────────

/** A classified region of the page DOM */
export interface DomRegion {
  /** CSS selector for the region root element */
  selector: string;
  /** Semantic role of this region */
  role: DomRegionRole;
  /** How the role was determined */
  source: 'landmark' | 'spatial' | 'heuristic';
  /** Number of expandable elements within this region */
  expandableCount: number;
  /** Number of <a href> links within this region */
  linkCount: number;
  /** Bounding rect as % of viewport (for spatial classification) */
  viewportArea: number;
}

export type DomRegionRole =
  | 'content-main'
  | 'nav-header'
  | 'nav-sidebar'
  | 'footer'
  | 'aside'
  | 'unknown';

/** Raw element data extracted from page.evaluate — input to the pure classifier */
export interface RawDomElement {
  /** CSS selector for this element */
  selector: string;
  /** Tag name (lowercase) */
  tagName: string;
  /** ARIA role attribute if present */
  role: string | null;
  /** Bounding rect */
  rect: { top: number; left: number; width: number; height: number };
  /** Viewport dimensions at time of extraction */
  viewport: { width: number; height: number };
  /** Number of expandable elements within this element */
  expandableCount: number;
  /** Number of <a href> links within this element */
  linkCount: number;
}

// ─── Constants ──────────────────────────────────────────────────────

/** Priority order for region-first clicking (lower = higher priority) */
export const REGION_CLICK_PRIORITY: Record<DomRegionRole, number> = {
  'content-main': 0,
  'nav-sidebar': 1,
  aside: 2,
  unknown: 3,
  'nav-header': 4,
  footer: 5,
};

/** Spatial fallback: elements in the top N pixels are likely header/nav */
const HEADER_HEIGHT_PX = 80;

/** Spatial fallback: elements occupying the left N% of viewport are likely sidebar */
const SIDEBAR_WIDTH_PCT = 25;

/** Spatial fallback: elements in the bottom N pixels are likely footer */
const FOOTER_HEIGHT_PX = 80;

/** Maximum DOM elements to scan (performance guard for large DOMs) */
const MAX_DOM_ELEMENTS_SCAN = 5000;

// ─── Pure Classification Function ───────────────────────────────────

/**
 * Classify raw DOM elements into semantic regions.
 * Pure function — no Playwright dependency, fully testable with synthetic data.
 */
export function classifyRegions(rawElements: RawDomElement[]): DomRegion[] {
  const regions: DomRegion[] = [];

  for (const el of rawElements) {
    const viewportArea =
      el.viewport.width > 0 && el.viewport.height > 0
        ? ((el.rect.width * el.rect.height) / (el.viewport.width * el.viewport.height)) * 100
        : 0;

    const classified = classifySingleElement(el, viewportArea);
    if (classified) {
      regions.push(classified);
    }
  }

  // Sort by click priority (content-main first)
  regions.sort((a, b) => REGION_CLICK_PRIORITY[a.role] - REGION_CLICK_PRIORITY[b.role]);

  return regions;
}

/**
 * Classify a single element into a DomRegion.
 * Returns null if the element is too small to be a meaningful region.
 */
function classifySingleElement(el: RawDomElement, viewportArea: number): DomRegion | null {
  // Skip tiny elements (< 1% of viewport)
  if (viewportArea < 1) return null;

  const role = classifyRole(el);
  const source = role.source;

  return {
    selector: el.selector,
    role: role.role,
    source,
    expandableCount: el.expandableCount,
    linkCount: el.linkCount,
    viewportArea: Math.round(viewportArea * 100) / 100,
  };
}

/**
 * Determine the semantic role of an element.
 * Priority: landmark HTML/ARIA > spatial heuristics.
 */
function classifyRole(el: RawDomElement): { role: DomRegionRole; source: DomRegion['source'] } {
  // Strategy 1: Landmark elements (semantic HTML + ARIA roles)
  const landmarkRole = classifyByLandmark(el);
  if (landmarkRole) return { role: landmarkRole, source: 'landmark' };

  // Strategy 2: Spatial heuristics based on position
  const spatialRole = classifyBySpatial(el);
  if (spatialRole) return { role: spatialRole, source: 'spatial' };

  return { role: 'unknown', source: 'heuristic' };
}

/** Classify by semantic HTML tags and ARIA roles */
function classifyByLandmark(el: RawDomElement): DomRegionRole | null {
  // <main> or [role="main"]
  if (el.tagName === 'main' || el.role === 'main') return 'content-main';

  // <nav> or [role="navigation"]
  if (el.tagName === 'nav' || el.role === 'navigation') {
    // Distinguish header nav from sidebar nav by position
    if (el.rect.top < HEADER_HEIGHT_PX && el.rect.width > el.viewport.width * 0.5) {
      return 'nav-header';
    }
    if (
      el.rect.left < el.viewport.width * (SIDEBAR_WIDTH_PCT / 100) &&
      el.rect.height > el.viewport.height * 0.3
    ) {
      return 'nav-sidebar';
    }
    // Default nav is header
    return 'nav-header';
  }

  // <aside> or [role="complementary"]
  if (el.tagName === 'aside' || el.role === 'complementary') return 'aside';

  // <header> (only page-level, not section headers)
  if (el.tagName === 'header' && el.rect.top < HEADER_HEIGHT_PX) return 'nav-header';

  // <footer> or [role="contentinfo"]
  if (el.tagName === 'footer' || el.role === 'contentinfo') return 'footer';

  return null;
}

/** Classify by spatial position on viewport */
function classifyBySpatial(el: RawDomElement): DomRegionRole | null {
  const { rect, viewport } = el;
  const areaPercent =
    viewport.width > 0 && viewport.height > 0
      ? ((rect.width * rect.height) / (viewport.width * viewport.height)) * 100
      : 0;

  // Top of viewport → likely header/nav
  if (rect.top < HEADER_HEIGHT_PX && rect.width > viewport.width * 0.5) {
    return 'nav-header';
  }

  // Left side, tall → likely sidebar
  if (
    rect.left < viewport.width * (SIDEBAR_WIDTH_PCT / 100) &&
    rect.width < viewport.width * 0.35 &&
    rect.height > viewport.height * 0.3
  ) {
    return 'nav-sidebar';
  }

  // Bottom of viewport → likely footer
  if (
    rect.top + rect.height > viewport.height - FOOTER_HEIGHT_PX &&
    rect.width > viewport.width * 0.5
  ) {
    return 'footer';
  }

  // Large center area → likely content
  if (
    rect.left >= viewport.width * (SIDEBAR_WIDTH_PCT / 100) * 0.5 &&
    rect.top >= HEADER_HEIGHT_PX * 0.5 &&
    areaPercent > 20
  ) {
    // Only classify as content if it occupies a meaningful portion
    return 'content-main';
  }

  return null;
}

// ─── Playwright Bridge ──────────────────────────────────────────────

/**
 * Extract DOM region data from the page and classify it.
 * Uses string-based page.evaluate IIFE to avoid tsx __name injection issues
 * (same pattern as findExpandables in navigation-explorer.ts).
 */
export async function classifyDomRegions(page: Page): Promise<DomRegion[]> {
  const script = `(function() {
    var MAX_SCAN = ${MAX_DOM_ELEMENTS_SCAN};
    var LANDMARK_SELECTORS = [
      'main', '[role="main"]',
      'nav', '[role="navigation"]',
      'aside', '[role="complementary"]',
      'header', 'footer', '[role="contentinfo"]'
    ];

    var EXPANDABLE_SELECTORS = [
      '[aria-expanded="false"]',
      'details:not([open]) > summary',
      '[data-toggle="collapse"]:not(.show)',
      '[data-bs-toggle="collapse"]:not(.show)',
      '[role="tab"][aria-selected="false"]'
    ];

    var seen = new Set();
    var results = [];
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;

    function uniqueSelector(el) {
      if (el.id) return '#' + CSS.escape(el.id);
      var parts = [];
      var cur = el;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        var parent = cur.parentElement;
        if (!parent) break;
        var siblings = Array.from(parent.children);
        var index = siblings.indexOf(cur);
        parts.unshift(cur.tagName.toLowerCase() + ':nth-child(' + (index + 1) + ')');
        cur = parent;
      }
      return parts.join(' > ');
    }

    function countExpandables(el) {
      var count = 0;
      for (var i = 0; i < EXPANDABLE_SELECTORS.length; i++) {
        try { count += el.querySelectorAll(EXPANDABLE_SELECTORS[i]).length; } catch(e) {}
      }
      return count;
    }

    function countLinks(el) {
      return el.querySelectorAll('a[href]').length;
    }

    // Collect landmark elements
    var scanned = 0;
    for (var i = 0; i < LANDMARK_SELECTORS.length && scanned < MAX_SCAN; i++) {
      try {
        var els = document.querySelectorAll(LANDMARK_SELECTORS[i]);
        for (var j = 0; j < els.length && scanned < MAX_SCAN; j++) {
          var el = els[j];
          if (seen.has(el)) continue;
          seen.add(el);
          scanned++;

          var rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;

          results.push({
            selector: uniqueSelector(el),
            tagName: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
            viewport: { width: vw, height: vh },
            expandableCount: countExpandables(el),
            linkCount: countLinks(el)
          });
        }
      } catch(e) {}
    }

    return results;
  })()`;

  const rawElements = (await page.evaluate(script)) as RawDomElement[];
  return classifyRegions(rawElements);
}
