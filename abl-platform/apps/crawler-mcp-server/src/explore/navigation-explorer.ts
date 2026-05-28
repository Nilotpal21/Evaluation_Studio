/**
 * Navigation Explorer — Playwright-based JS Navigation Discovery
 *
 * Renders a page with full JavaScript execution, then systematically
 * expands interactive elements (accordions, collapsibles, tabs, dropdowns)
 * to discover links hidden behind JS walls.
 *
 * Generic algorithm — not site-specific. Uses heuristics to find expandable
 * elements: ARIA attributes, CSS patterns, hidden siblings, expand indicators.
 *
 * Returns all <a href> links found in the rendered + expanded DOM.
 */

import type { Page } from 'playwright';
import {
  classifyDomRegions,
  REGION_CLICK_PRIORITY,
  type DomRegion,
  type DomRegionRole,
} from './dom-region-classifier.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface NavigationExploreConfig {
  /** Seed URL to explore */
  url: string;
  /** Max levels of expandable nesting to traverse (default 4) */
  maxDepth: number;
  /** Max total clicks before stopping (default 300) */
  maxExpansions: number;
  /** Optional CSS selectors for expandable elements (power-user hint) */
  expandableSelectors?: string[];
  /** @deprecated Use sampleUrls for multi-pattern scoring instead */
  linkFilter?: string;
  /** Sample URLs for pattern scoring — replaces linkFilter */
  sampleUrls?: string[];
  /** Per-operation timeout in ms (default 3000) */
  timeout: number;
}

export interface ExploreProgress {
  phase: 'rendering' | 'retrying' | 'exploring' | 'done' | 'error';
  expandablesFound: number;
  expandablesClicked: number;
  linksFound: number;
  currentElement?: string;
  depth: number;
  /** Tree of what was expanded (for UI display) */
  tree: ExpandableNode[];
}

export interface ExpandableNode {
  label: string;
  selector: string;
  depth: number;
  linksRevealed: number;
  children: ExpandableNode[];
}

export interface ExploreResult {
  /** All <a href> links found in the rendered + expanded DOM */
  links: DiscoveredLink[];
  /** The expandable tree that was explored */
  tree: ExpandableNode[];
  /** Statistics */
  stats: {
    totalClicks: number;
    totalLinks: number;
    totalExpandables: number;
    durationMs: number;
    /** Click budget allocation by region role */
    clicksByRegion?: Record<string, number>;
  };
  /** DOM regions detected on the page */
  regions?: DomRegion[];
}

export interface DiscoveredLink {
  href: string;
  text: string;
  /** CSS selector path to the link's parent expandable (if any) */
  context?: string;
  /** Which DOM region this link was found in */
  region?: DomRegionRole;
}

export type ProgressCallback = (progress: ExploreProgress) => void;
export type StopSignal = () => boolean;

// ─── Constants ──────────────────────────────────────────────────────

/** Default expandable selectors — covers most common patterns */
const DEFAULT_EXPANDABLE_SELECTORS = [
  '[aria-expanded="false"]',
  'details:not([open]) > summary',
  '[data-toggle="collapse"]:not(.show)',
  '[data-bs-toggle="collapse"]:not(.show)',
  '[role="tab"][aria-selected="false"]',
];

/** Wait this long after click for DOM to settle */
const DOM_SETTLE_MS = 600;

/** Max time to wait for new content after a click */
const MUTATION_TIMEOUT_MS = 2000;

// ─── Main Explorer ──────────────────────────────────────────────────

/**
 * Explore a page's navigation by rendering it with Playwright and
 * systematically clicking expandable elements to reveal hidden links.
 */
export async function exploreNavigation(
  page: Page,
  config: NavigationExploreConfig,
  onProgress?: ProgressCallback,
  shouldStop?: StopSignal,
): Promise<ExploreResult> {
  const startTime = Date.now();
  const allLinks = new Map<string, DiscoveredLink>();
  const tree: ExpandableNode[] = [];
  let totalClicks = 0;
  const clicksByRegion: Record<string, number> = {};

  const progress: ExploreProgress = {
    phase: 'rendering',
    expandablesFound: 0,
    expandablesClicked: 0,
    linksFound: 0,
    depth: 0,
    tree,
  };

  // Step 1: Navigate and render with progressive retry
  onProgress?.(progress);

  await navigateWithRetry(page, config.url, config.timeout, progress, onProgress);

  // Dismiss common overlays (cookie banners, modals)
  await dismissOverlays(page);

  // Step 2: Classify DOM regions for content-first clicking
  let regions: DomRegion[] = [];
  try {
    regions = await classifyDomRegions(page);
  } catch {
    // Classification failure is non-fatal — fall back to DOM-order clicking
  }

  // Step 3: Extract initial links from rendered DOM (no filtering — return all)
  const initialLinks = await extractPageLinks(page);
  // Assign region to initial links via DOM containment check
  if (regions.length > 0) {
    await assignRegionsToLinks(page, initialLinks, regions);
  }
  for (const link of initialLinks) {
    allLinks.set(link.href, link);
  }

  progress.phase = 'exploring';
  progress.linksFound = allLinks.size;
  onProgress?.(progress);

  // Step 4: Find and click expandable elements — content regions first
  await exploreExpandables(
    page,
    config,
    allLinks,
    tree,
    0,
    progress,
    onProgress,
    shouldStop,
    () => totalClicks,
    () => {
      totalClicks++;
    },
    regions,
    clicksByRegion,
  );

  progress.phase = 'done';
  progress.linksFound = allLinks.size;
  onProgress?.(progress);

  return {
    links: [...allLinks.values()],
    tree,
    stats: {
      totalClicks,
      totalLinks: allLinks.size,
      totalExpandables: progress.expandablesFound,
      durationMs: Date.now() - startTime,
      clicksByRegion,
    },
    regions,
  };
}

// ─── Progressive Navigation ─────────────────────────────────────────

/** Wait strategies in order of strictness (fastest site → heaviest site) */
const NAVIGATION_STRATEGIES: Array<{
  waitUntil: 'networkidle' | 'domcontentloaded' | 'commit';
  timeoutMultiplier: number;
  hydrationMs: number;
  label: string;
}> = [
  { waitUntil: 'networkidle', timeoutMultiplier: 5, hydrationMs: 0, label: 'standard' },
  { waitUntil: 'domcontentloaded', timeoutMultiplier: 10, hydrationMs: 2000, label: 'relaxed' },
  { waitUntil: 'commit', timeoutMultiplier: 15, hydrationMs: 3000, label: 'minimal' },
];

/**
 * Navigate to a URL with progressive retry.
 *
 * Tries networkidle first (fast sites), then domcontentloaded (medium),
 * then commit (heavy/slow sites). Notifies the user via progress callback
 * on each retry so the UI can show "Page is slow — retrying...".
 */
export async function navigateWithRetry(
  page: Page,
  url: string,
  baseTimeout: number,
  progress: ExploreProgress,
  onProgress?: ProgressCallback,
): Promise<void> {
  for (let i = 0; i < NAVIGATION_STRATEGIES.length; i++) {
    const strategy = NAVIGATION_STRATEGIES[i];
    const timeout = baseTimeout * strategy.timeoutMultiplier;

    try {
      await page.goto(url, {
        waitUntil: strategy.waitUntil,
        timeout,
      });

      // Wait for JS frameworks to hydrate dynamic content
      if (strategy.hydrationMs > 0) {
        await page.waitForTimeout(strategy.hydrationMs);
      }

      return; // Success
    } catch (err: unknown) {
      const isTimeout =
        err instanceof Error &&
        (err.message.includes('Timeout') || err.message.includes('timeout'));

      if (!isTimeout || i === NAVIGATION_STRATEGIES.length - 1) {
        // Not a timeout error, or last retry — propagate
        throw err;
      }

      // Notify user about retry with concrete values
      const nextStrategy = NAVIGATION_STRATEGIES[i + 1];
      const timedOutAfterSec = Math.round(timeout / 1000);
      const nextTimeoutSec = Math.round((baseTimeout * nextStrategy.timeoutMultiplier) / 1000);
      progress.phase = 'retrying';
      progress.currentElement =
        `Timed out after ${timedOutAfterSec}s waiting for ${strategy.waitUntil}` +
        ` — retrying with ${nextStrategy.waitUntil} (${nextTimeoutSec}s timeout)`;
      onProgress?.(progress);

      // Reset phase for the retry
      progress.phase = 'rendering';
    }
  }
}

// ─── Recursive Expansion ────────────────────────────────────────────

async function exploreExpandables(
  page: Page,
  config: NavigationExploreConfig,
  allLinks: Map<string, DiscoveredLink>,
  parentTree: ExpandableNode[],
  depth: number,
  progress: ExploreProgress,
  onProgress?: ProgressCallback,
  shouldStop?: StopSignal,
  getClicks?: () => number,
  addClick?: () => void,
  regions?: DomRegion[],
  clicksByRegion?: Record<string, number>,
): Promise<void> {
  if (depth >= config.maxDepth) return;
  if (shouldStop?.()) return;
  if ((getClicks?.() ?? 0) >= config.maxExpansions) return;

  // Find expandable elements at current state
  const expandables = await findExpandables(page, config.expandableSelectors);
  progress.expandablesFound += expandables.length;
  progress.depth = depth;

  // Sort expandables by region priority: content-main first, footer last
  const sorted: RegionAnnotatedExpandable[] =
    regions && regions.length > 0
      ? await sortExpandablesByRegion(page, expandables, regions)
      : expandables.map((e) => ({ ...e, regionRole: 'unknown' as DomRegionRole }));

  for (const expandable of sorted) {
    if (shouldStop?.()) return;
    if ((getClicks?.() ?? 0) >= config.maxExpansions) return;

    // Get link count before click
    const linkCountBefore = await countLinks(page);

    // Click the expandable
    progress.currentElement = expandable.label;
    progress.expandablesClicked++;
    onProgress?.(progress);

    const clicked = await safeClick(page, expandable.selector, config.timeout);
    if (!clicked) continue;
    addClick?.();

    // Track clicks by region
    if (clicksByRegion) {
      const regionRole = expandable.regionRole ?? 'unknown';
      clicksByRegion[regionRole] = (clicksByRegion[regionRole] ?? 0) + 1;
    }

    // Wait for DOM to settle
    await waitForDomSettle(page);

    // Count links after click
    const linkCountAfter = await countLinks(page);
    const newLinkCount = linkCountAfter - linkCountBefore;

    // Extract newly appeared links (no filtering — return all)
    if (newLinkCount > 0) {
      const currentLinks = await extractPageLinks(page);
      let revealed = 0;
      for (const link of currentLinks) {
        if (!allLinks.has(link.href)) {
          allLinks.set(link.href, {
            ...link,
            context: expandable.label,
            region: expandable.regionRole,
          });
          revealed++;
        }
      }

      const node: ExpandableNode = {
        label: expandable.label,
        selector: expandable.selector,
        depth,
        linksRevealed: revealed,
        children: [],
      };
      parentTree.push(node);

      progress.linksFound = allLinks.size;
      onProgress?.(progress);

      // Check for sub-expandables within the expanded region
      await exploreExpandables(
        page,
        config,
        allLinks,
        node.children,
        depth + 1,
        progress,
        onProgress,
        shouldStop,
        getClicks,
        addClick,
        regions,
        clicksByRegion,
      );
    } else {
      // Click revealed no new links — check if it revealed new expandables
      const subExpandables = await findExpandables(page, config.expandableSelectors);
      const newExpandableCount = subExpandables.length - expandables.length;
      if (newExpandableCount > 0) {
        const node: ExpandableNode = {
          label: expandable.label,
          selector: expandable.selector,
          depth,
          linksRevealed: 0,
          children: [],
        };
        parentTree.push(node);

        // Recurse into newly revealed expandables
        await exploreExpandables(
          page,
          config,
          allLinks,
          node.children,
          depth + 1,
          progress,
          onProgress,
          shouldStop,
          getClicks,
          addClick,
          regions,
          clicksByRegion,
        );
      }
    }
  }
}

// ─── Element Finding ────────────────────────────────────────────────

interface ExpandableCandidate {
  selector: string;
  label: string;
}

/** Expandable with its containing DOM region determined via page.evaluate containment check */
interface RegionAnnotatedExpandable extends ExpandableCandidate {
  regionRole: DomRegionRole;
}

/**
 * Find expandable elements in the current DOM state.
 * Uses multiple strategies: standard ARIA, CSS patterns, and heuristics.
 */
async function findExpandables(
  page: Page,
  customSelectors?: string[],
): Promise<ExpandableCandidate[]> {
  // Use string-based evaluate to avoid esbuild/tsx __name injection.
  // tsx wraps function declarations with __name() which doesn't exist in browser.
  const allSelectors = [...DEFAULT_EXPANDABLE_SELECTORS, ...(customSelectors ?? [])];
  const script = `(function(selectors) {
    var candidates = [];
    var seen = new Set();

    function uniqueSelector(el) {
      if (el.id) return '#' + CSS.escape(el.id);
      var parts = [];
      var cur = el;
      while (cur && cur !== document.body) {
        var parent = cur.parentElement;
        if (!parent) break;
        var siblings = Array.from(parent.children);
        var index = siblings.indexOf(cur);
        parts.unshift(cur.tagName.toLowerCase() + ':nth-child(' + (index + 1) + ')');
        cur = parent;
      }
      return parts.join(' > ');
    }

    function getLabel(el) {
      var text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
      return text.length > 80 ? text.slice(0, 77) + '...' : text;
    }

    // Strategy 1: Standard ARIA/HTML selectors
    for (var i = 0; i < selectors.length; i++) {
      try {
        document.querySelectorAll(selectors[i]).forEach(function(el) {
          if (seen.has(el)) return;
          var rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          seen.add(el);
          candidates.push({ selector: uniqueSelector(el), label: getLabel(el) });
        });
      } catch(e) {}
    }

    // Strategy 2: Heuristic — visible elements with hidden next siblings
    var clickSels = 'h2, h3, h4, h5, [role="button"], button, ' +
      '[class*="accordion"], [class*="collaps"], [class*="expand"], ' +
      '[class*="toggle"], [class*="panel-head"], [class*="category"], ' +
      '[class*="series"], [class*="nav-item"], [class*="menu-item"], ' +
      '[class*="trigger"], [class*="header"]';

    document.querySelectorAll(clickSels).forEach(function(el) {
      if (seen.has(el)) return;
      if (el.tagName === 'A') return;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      var next = el.nextElementSibling;
      if (next) {
        var style = window.getComputedStyle(next);
        var isHidden = style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.maxHeight === '0px' ||
          style.height === '0px' ||
          (style.overflow === 'hidden' && next.scrollHeight > next.clientHeight + 5);
        if (isHidden) {
          seen.add(el);
          candidates.push({ selector: uniqueSelector(el), label: getLabel(el) });
          return;
        }
      }

      var text = el.textContent || '';
      var hasIndicator = el.querySelector(
        '[class*="arrow"], [class*="chevron"], [class*="caret"], [class*="icon-expand"]'
      ) !== null;
      var hasTextIndicator = /[▼▶►◀◁▽△+−]/.test(text);
      var hasAriaExpanded = el.getAttribute('aria-expanded') === 'false';

      if ((hasIndicator || hasTextIndicator || hasAriaExpanded) && text.trim().length < 100) {
        seen.add(el);
        candidates.push({ selector: uniqueSelector(el), label: getLabel(el) });
      }
    });

    return candidates;
  })(${JSON.stringify(allSelectors)})`;

  return page.evaluate(script) as Promise<ExpandableCandidate[]>;
}

// ─── Region-First Sorting ────────────────────────────────────────────

/**
 * Assign each expandable to its containing DOM region and sort by click priority.
 * Uses page.evaluate to check DOM containment (regionEl.contains(expandableEl))
 * since CSS selector strings alone can't determine parent-child relationships
 * when ID-based selectors are involved.
 *
 * Sort order: content-main (0) → nav-sidebar (1) → aside (2) → unknown (3) → nav-header (4) → footer (5).
 * Within the same region, DOM order is preserved (stable sort).
 */
async function sortExpandablesByRegion(
  page: Page,
  expandables: ExpandableCandidate[],
  regions: DomRegion[],
): Promise<RegionAnnotatedExpandable[]> {
  const regionSelectors = regions.map((r) => r.selector);
  const regionRoles = regions.map((r) => r.role);
  const expandableSelectors = expandables.map((e) => e.selector);

  const script = `(function() {
    var regionSelectors = ${JSON.stringify(regionSelectors)};
    var expandableSelectors = ${JSON.stringify(expandableSelectors)};
    var results = [];

    var regionEls = regionSelectors.map(function(sel) {
      try { return document.querySelector(sel); } catch(e) { return null; }
    });

    for (var i = 0; i < expandableSelectors.length; i++) {
      var expEl;
      try { expEl = document.querySelector(expandableSelectors[i]); } catch(e) { expEl = null; }
      var regionIdx = -1;
      if (expEl) {
        for (var j = 0; j < regionEls.length; j++) {
          if (regionEls[j] && regionEls[j].contains(expEl)) {
            regionIdx = j;
            break;
          }
        }
      }
      results.push(regionIdx);
    }
    return results;
  })()`;

  const assignments = (await page.evaluate(script)) as number[];

  const annotated: RegionAnnotatedExpandable[] = expandables.map((exp, i) => ({
    ...exp,
    regionRole: assignments[i] >= 0 ? regionRoles[assignments[i]] : ('unknown' as DomRegionRole),
  }));

  // Stable sort by REGION_CLICK_PRIORITY — preserves DOM order within same region
  annotated.sort((a, b) => {
    const pa = REGION_CLICK_PRIORITY[a.regionRole] ?? REGION_CLICK_PRIORITY['unknown'];
    const pb = REGION_CLICK_PRIORITY[b.regionRole] ?? REGION_CLICK_PRIORITY['unknown'];
    return pa - pb;
  });

  return annotated;
}

/**
 * Assign region roles to discovered links by checking DOM containment.
 * Mutates the links in-place for efficiency (called on large link arrays).
 */
async function assignRegionsToLinks(
  page: Page,
  links: DiscoveredLink[],
  regions: DomRegion[],
): Promise<void> {
  if (links.length === 0 || regions.length === 0) return;

  const regionSelectors = regions.map((r) => r.selector);
  const regionRoles = regions.map((r) => r.role);

  // Build a lookup of href → region index via page.evaluate
  const script = `(function() {
    var regionSelectors = ${JSON.stringify(regionSelectors)};
    var regionEls = regionSelectors.map(function(sel) {
      try { return document.querySelector(sel); } catch(e) { return null; }
    });

    var results = {};
    document.querySelectorAll('a[href]').forEach(function(a) {
      var href = a.href;
      if (!href || results[href] !== undefined) return;
      for (var j = 0; j < regionEls.length; j++) {
        if (regionEls[j] && regionEls[j].contains(a)) {
          results[href] = j;
          return;
        }
      }
      results[href] = -1;
    });
    return results;
  })()`;

  const hrefToRegionIdx = (await page.evaluate(script)) as Record<string, number>;

  for (const link of links) {
    const idx = hrefToRegionIdx[link.href];
    if (idx !== undefined && idx >= 0) {
      link.region = regionRoles[idx];
    }
  }
}

// ─── Link Extraction ────────────────────────────────────────────────

/**
 * Extract all <a href> links from the current DOM state.
 */
export async function extractPageLinks(page: Page): Promise<DiscoveredLink[]> {
  const raw = (await page.evaluate(`(function() {
    var links = [];
    document.querySelectorAll('a[href]').forEach(function(a) {
      var href = a.href;
      if (!href) return;
      if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:'))
        return;
      var text = (a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
      links.push({ href: href, text: text });
    });
    return links;
  })()`)) as Array<{ href: string; text: string }>;

  // Deduplicate by href — return ALL links (scoring done in search-ai, not here)
  const seen = new Set<string>();
  const result: DiscoveredLink[] = [];

  for (const link of raw) {
    if (seen.has(link.href)) continue;
    seen.add(link.href);
    result.push(link);
  }

  return result;
}

/**
 * Count links currently in the DOM (fast, no extraction).
 */
async function countLinks(page: Page): Promise<number> {
  return page.evaluate('document.querySelectorAll("a[href]").length') as Promise<number>;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Safely click an element. Returns false if the click fails.
 */
async function safeClick(page: Page, selector: string, timeout: number): Promise<boolean> {
  try {
    await page.click(selector, { timeout, force: false });
    return true;
  } catch {
    // Element may have been removed, obscured, or not clickable
    return false;
  }
}

/**
 * Wait for DOM to settle after a click (mutation observer based).
 */
async function waitForDomSettle(page: Page): Promise<void> {
  try {
    await page.evaluate(`new Promise(function(resolve) {
      var settleMs = ${DOM_SETTLE_MS};
      var timeoutMs = ${MUTATION_TIMEOUT_MS};
      var timer;
      var maxTimer = setTimeout(resolve, timeoutMs);
      var observer = new MutationObserver(function() {
        clearTimeout(timer);
        timer = setTimeout(function() {
          observer.disconnect();
          clearTimeout(maxTimer);
          resolve();
        }, settleMs);
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      timer = setTimeout(function() {
        observer.disconnect();
        clearTimeout(maxTimer);
        resolve();
      }, settleMs);
    })`);
  } catch {
    // Fallback: simple delay
    await new Promise((resolve) => setTimeout(resolve, DOM_SETTLE_MS));
  }
}

/**
 * Dismiss common page overlays that might block interaction.
 * (cookie banners, modal dialogs, etc.)
 */
export async function dismissOverlays(page: Page): Promise<void> {
  const dismissSelectors = [
    // Cookie banners
    'button[class*="cookie" i][class*="accept" i]',
    'button[class*="cookie" i][class*="close" i]',
    'button[id*="cookie" i][class*="accept" i]',
    '[class*="cookie-banner" i] button',
    '[class*="consent" i] button[class*="accept" i]',
    // Generic close/dismiss
    '[class*="modal"] button[class*="close" i]',
    '[class*="overlay"] button[class*="close" i]',
    '[class*="popup"] button[class*="close" i]',
    'button[aria-label="Close" i]',
    'button[aria-label="Dismiss" i]',
  ];

  for (const selector of dismissSelectors) {
    try {
      const btn = await page.$(selector);
      if (btn) {
        const visible = await btn.isVisible();
        if (visible) {
          await btn.click({ timeout: 1000 });
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    } catch {
      // ignore — overlay dismissal is best-effort
    }
  }
}
