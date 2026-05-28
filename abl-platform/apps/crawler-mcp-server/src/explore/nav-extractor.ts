/**
 * Nav Extractor — Extract site navigation skeleton from header, footer,
 * mega-menus, and sitemap pages.
 *
 * Runs before depth probing to pre-populate the discovery tree with
 * the site's navigation structure. This gives the user immediate
 * visibility into top-level categories before any pages are visited.
 */

import type { Page } from 'playwright';
import { createLogger } from '../logger.js';
import type { Breadcrumb } from './breadcrumb-extractor.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface NavNode {
  label: string;
  href?: string;
  depth: number;
  children: NavNode[];
  source: 'header' | 'footer' | 'mega-menu' | 'sitemap-page' | 'breadcrumb';
  estimatedChildren?: number;
}

/** Shape returned from browser $$eval — plain serializable object */
interface RawNavNode {
  label: string;
  href: string;
  depth: number;
  children: RawNavNode[];
}

export interface NavExtractionResult {
  nodes: NavNode[];
  source: string;
  extractionTimeMs: number;
}

const logger = createLogger('nav-extractor');

// ─── Constants ──────────────────────────────────────────────────────

/** CSS selectors for navigation regions */
const NAV_SELECTORS = [
  'header nav',
  'nav[role="navigation"]',
  'header [role="navigation"]',
  'nav',
  '#main-nav',
  '#primary-nav',
  '.main-nav',
  '.primary-nav',
  '.navigation',
];

const FOOTER_SELECTORS = ['footer nav', 'footer [role="navigation"]', 'footer'];

/** Sitemap page URL variants to try */
const SITEMAP_PATHS = ['/sitemap', '/site-map', '/sitemap.html', '/sitemap.htm'];

/** Maximum label length for nav links */
const MAX_LABEL_LENGTH = 100;

/** Maximum links to extract from a single nav region */
const MAX_LINKS_PER_REGION = 200;

/** Maximum breadcrumb merge nodes to prevent unbounded tree growth */
const MAX_BREADCRUMB_MERGE_NODES = 500;

/** Maximum time to wait for mega-menu reveal (ms) */
const MEGA_MENU_HOVER_TIMEOUT = 1500;

/** Maximum top-level items to hover for mega-menu extraction */
const MAX_MEGA_MENU_ITEMS = 15;

// ─── Main Orchestrator ──────────────────────────────────────────────

/**
 * Extract the site's navigation skeleton from the current page.
 * Tries header nav, footer nav, mega-menus, and sitemap pages.
 */
export async function extractSiteNavigation(
  page: Page,
  baseUrl: string,
): Promise<NavExtractionResult> {
  const startTime = Date.now();
  const allNodes: NavNode[] = [];
  const sources: string[] = [];

  const origin = new URL(baseUrl).origin;

  // 1. Extract header navigation regions
  try {
    const headerNodes = await extractNavRegions(page, NAV_SELECTORS, 'header', origin);
    if (headerNodes.length > 0) {
      allNodes.push(...headerNodes);
      sources.push('header');
      logger.info('Extracted header navigation', { count: headerNodes.length });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Header nav extraction failed', { error: message });
  }

  // 2. Extract footer navigation
  try {
    const footerNodes = await extractNavRegions(page, FOOTER_SELECTORS, 'footer', origin);
    if (footerNodes.length > 0) {
      allNodes.push(...footerNodes);
      sources.push('footer');
      logger.info('Extracted footer navigation', { count: footerNodes.length });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Footer nav extraction failed', { error: message });
  }

  // 3. Try mega-menu extraction (hover-reveal)
  try {
    const megaMenuNodes = await extractMegaMenu(page, origin);
    if (megaMenuNodes.length > 0) {
      // Merge mega-menu children into existing header nodes if labels match
      mergeMegaMenuNodes(allNodes, megaMenuNodes);
      sources.push('mega-menu');
      logger.info('Extracted mega-menu items', { count: megaMenuNodes.length });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Mega-menu extraction failed', { error: message });
  }

  // 4. Try sitemap page
  try {
    const sitemapNodes = await trySitemapPage(page, baseUrl, origin);
    if (sitemapNodes.length > 0) {
      allNodes.push(...sitemapNodes);
      sources.push('sitemap-page');
      logger.info('Extracted sitemap page links', { count: sitemapNodes.length });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Sitemap page extraction failed', { error: message });
  }

  // Deduplicate by href
  const deduped = deduplicateNodes(allNodes);

  const extractionTimeMs = Date.now() - startTime;
  logger.info('Nav extraction complete', {
    totalNodes: deduped.length,
    sources: sources.join(', '),
    extractionTimeMs,
  });

  return {
    nodes: deduped,
    source: sources.join('+') || 'none',
    extractionTimeMs,
  };
}

// ─── Region Extraction ──────────────────────────────────────────────

/**
 * Extract links from navigation regions matched by CSS selectors.
 */
async function extractNavRegions(
  page: Page,
  selectors: string[],
  source: 'header' | 'footer',
  origin: string,
): Promise<NavNode[]> {
  const nodes: NavNode[] = [];

  for (const selector of selectors) {
    const regionLinks = await extractNavRegion(page, selector, source, origin);
    if (regionLinks.length > 0) {
      nodes.push(...regionLinks);
      // First successful selector is usually the most specific
      break;
    }
  }

  return nodes;
}

/**
 * Extract links from a single nav region identified by a CSS selector.
 *
 * Uses a recursive DOM walker that preserves `<ul>/<li>` nesting as
 * parent-child NavNode trees. Falls back to flat `<a>` extraction
 * when no list structure is found inside the container.
 */
export async function extractNavRegion(
  page: Page,
  selector: string,
  source: 'header' | 'footer',
  origin: string,
): Promise<NavNode[]> {
  const rawTree = await page.$$eval(
    selector,
    (containers, maxLinks) => {
      let linkCount = 0;

      interface RawNavNode {
        label: string;
        href: string;
        depth: number;
        children: RawNavNode[];
      }

      function walkList(ul: Element, depth: number): RawNavNode[] {
        const nodes: RawNavNode[] = [];
        const items = ul.querySelectorAll(':scope > li');

        for (const li of Array.from(items)) {
          if (linkCount >= maxLinks) break;

          // Find the anchor in this <li> — direct child or wrapped in span/div
          const anchor = li.querySelector(
            ':scope > a[href], :scope > span > a[href], :scope > div > a[href]',
          );
          if (!anchor) continue;

          const label = (anchor.textContent ?? '').trim();
          const href = anchor.getAttribute('href') ?? '';
          if (!label || label.length > 100) continue;

          linkCount++;

          // Check for nested <ul>/<ol> — these are child nav items
          const nestedList = li.querySelector(
            ':scope > ul, :scope > ol, :scope > div > ul, :scope > div > ol',
          );
          const children = nestedList ? walkList(nestedList, depth + 1) : [];

          nodes.push({ label, href, depth, children });
        }
        return nodes;
      }

      const allNodes: RawNavNode[] = [];

      for (const container of Array.from(containers)) {
        // Find top-level <ul> or <ol> inside this nav region
        const topLists = container.querySelectorAll(
          ':scope > ul, :scope > ol, :scope > div > ul, :scope > div > ol',
        );

        if (topLists.length > 0) {
          // Walk list structure recursively
          for (const list of Array.from(topLists)) {
            if (linkCount >= maxLinks) break;
            allNodes.push(...walkList(list, 0));
          }
        } else {
          // Fallback: no list structure — extract flat <a> tags
          const anchors = container.querySelectorAll('a[href]');
          for (const a of Array.from(anchors)) {
            if (linkCount >= maxLinks) break;
            const label = (a.textContent ?? '').trim();
            const href = a.getAttribute('href') ?? '';
            if (!label || label.length > 100) continue;
            linkCount++;
            allNodes.push({ label, href, depth: 0, children: [] });
          }
        }
      }

      return allNodes;
    },
    MAX_LINKS_PER_REGION,
  );

  return rawTreeToNavNodes(rawTree, source, origin);
}

/**
 * Convert RawNavNode[] (plain serializable objects from $$eval) to NavNode[].
 *
 * Resolves hrefs, propagates source to all children, and sets estimatedChildren.
 */
function rawTreeToNavNodes(
  rawNodes: RawNavNode[],
  source: NavNode['source'],
  origin: string,
): NavNode[] {
  function convert(raw: RawNavNode): NavNode | null {
    const href = resolveHref(raw.href, origin);
    const children = raw.children.map(convert).filter((n): n is NavNode => n !== null);

    // Keep nodes even without href if they have children (category labels)
    if (!href && children.length === 0) return null;

    return {
      label: raw.label,
      href: href ?? undefined,
      depth: raw.depth,
      children,
      source,
      estimatedChildren: children.length > 0 ? children.length : 0,
    };
  }

  return rawNodes.map(convert).filter((n): n is NavNode => n !== null);
}

// ─── Mega-Menu Extraction ───────────────────────────────────────────

/**
 * Hover over top-level nav items to reveal dropdown/mega-menu content,
 * then collect child links.
 */
export async function extractMegaMenu(page: Page, origin: string): Promise<NavNode[]> {
  // Find top-level nav items that might have dropdowns
  const topItems = await page.$$eval(
    'header nav > ul > li > a, header nav > div > ul > li > a, nav[role="navigation"] > ul > li > a',
    (anchors, max) => {
      return anchors.slice(0, max).map((a) => {
        return {
          label: (a.textContent ?? '').trim(),
          href: a.getAttribute('href') ?? '',
          selector: buildSelector(a),
        };

        function buildSelector(el: Element): string {
          if (el.id) return `#${el.id}`;
          const parent = el.parentElement;
          if (!parent) return el.tagName.toLowerCase();
          const siblings = Array.from(parent.children);
          const idx = siblings.indexOf(el);
          const parentSel = parent.id ? `#${parent.id}` : parent.tagName.toLowerCase();
          return `${parentSel} > :nth-child(${idx + 1})`;
        }
      });
    },
    MAX_MEGA_MENU_ITEMS,
  );

  const megaNodes: NavNode[] = [];

  for (const item of topItems) {
    if (!item.label) continue;

    try {
      // Hover to reveal dropdown
      const el = await page.$(item.selector);
      if (!el) continue;

      await el.hover();
      // Wait briefly for dropdown to appear
      await page.waitForTimeout(MEGA_MENU_HOVER_TIMEOUT);

      // Look for newly visible links near the hovered element
      const childLinks = await page.$$eval(
        `${item.selector} ~ ul a[href], ${item.selector} + div a[href], ${item.selector} + ul a[href]`,
        (anchors) => {
          return anchors
            .filter((a) => {
              const rect = a.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            })
            .slice(0, 50)
            .map((a) => ({
              label: (a.textContent ?? '').trim(),
              href: a.getAttribute('href') ?? '',
            }));
        },
      );

      if (childLinks.length > 0) {
        const children: NavNode[] = [];
        for (const child of childLinks) {
          if (!child.label || child.label.length > 100) continue;
          const href = resolveHref(child.href, origin);
          if (!href) continue;
          children.push({
            label: child.label,
            href,
            depth: 1,
            children: [],
            source: 'mega-menu',
          });
        }

        const parentHref = resolveHref(item.href, origin);
        megaNodes.push({
          label: item.label,
          href: parentHref ?? undefined,
          depth: 0,
          children,
          source: 'mega-menu',
          estimatedChildren: children.length,
        });
      }
    } catch {
      // Hover failed for this item — continue with next
    }
  }

  // Move mouse away to close any open menus
  try {
    await page.mouse.move(0, 0);
  } catch {
    // Best effort
  }

  return megaNodes;
}

// ─── Sitemap Page Extraction ────────────────────────────────────────

/**
 * Try navigating to common sitemap page URLs and extracting links.
 */
export async function trySitemapPage(
  page: Page,
  baseUrl: string,
  origin: string,
): Promise<NavNode[]> {
  const currentUrl = page.url();

  for (const path of SITEMAP_PATHS) {
    const sitemapUrl = `${origin}${path}`;
    try {
      const response = await page.goto(sitemapUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 10_000,
      });

      if (!response || response.status() >= 400) continue;

      // Check if the page has a reasonable number of links (sitemap pages usually have many)
      const links = await page.$$eval(
        'a[href]',
        (anchors, max) => {
          return anchors.slice(0, max).map((a) => ({
            label: (a.textContent ?? '').trim(),
            href: a.getAttribute('href') ?? '',
          }));
        },
        MAX_LINKS_PER_REGION,
      );

      // Heuristic: sitemap pages typically have >10 links
      if (links.length < 10) continue;

      const nodes: NavNode[] = [];
      for (const link of links) {
        if (!link.label || link.label.length > 100) continue;
        const href = resolveHref(link.href, origin);
        if (!href) continue;

        nodes.push({
          label: link.label,
          href,
          depth: 0,
          children: [],
          source: 'sitemap-page',
        });
      }

      if (nodes.length > 0) {
        // Navigate back to original page
        try {
          await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
        } catch {
          // Best effort restoration
        }
        return nodes;
      }
    } catch {
      // This sitemap path didn't work — try next
    }
  }

  // Navigate back to original page if we left it
  if (page.url() !== currentUrl) {
    try {
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    } catch {
      // Best effort
    }
  }

  return [];
}

// ─── Breadcrumb-to-Tree Integration ──────────────────────────────────

/**
 * Convert breadcrumb chains from multiple page visits into NavNode trees.
 *
 * Each chain [Home, Products, Printers] becomes nested NavNodes.
 * Multiple chains sharing labels at the same depth are merged
 * (e.g., two chains with "Products" at depth 1 merge into one node
 * with combined children).
 */
export function breadcrumbsToNavNodes(chains: Breadcrumb[][], origin: string): NavNode[] {
  const roots: NavNode[] = [];
  let totalNodes = 0;

  for (const chain of chains) {
    if (chain.length === 0) continue;
    let currentLevel = roots;

    for (let i = 0; i < chain.length; i++) {
      if (totalNodes >= MAX_BREADCRUMB_MERGE_NODES) break;

      const crumb = chain[i];
      const label = crumb.text.trim();
      if (!label || label.length > MAX_LABEL_LENGTH) continue;

      const href = resolveHref(crumb.href, origin) ?? undefined;

      // Find existing node at this level with the same label (case-insensitive)
      const existing = currentLevel.find((n) => n.label.toLowerCase() === label.toLowerCase());

      if (existing) {
        // Update href if the existing node doesn't have one
        if (!existing.href && href) {
          existing.href = href;
        }
        currentLevel = existing.children;
      } else {
        const node: NavNode = {
          label,
          href,
          depth: i,
          children: [],
          source: 'breadcrumb',
          estimatedChildren: 0,
        };
        currentLevel.push(node);
        totalNodes++;
        currentLevel = node.children;
      }
    }
  }

  // Update estimatedChildren counts
  function updateCounts(nodes: NavNode[]): void {
    for (const node of nodes) {
      node.estimatedChildren = node.children.length;
      updateCounts(node.children);
    }
  }
  updateCounts(roots);

  return roots;
}

/**
 * Merge source NavNode[] into target NavNode[] by case-insensitive label matching.
 *
 * - Matching nodes: merge children recursively, update href if missing
 * - Non-matching nodes: append to target
 *
 * Mutates the target array in-place.
 */
export function mergeNavTrees(target: NavNode[], source: NavNode[]): void {
  for (const srcNode of source) {
    const match = target.find((t) => t.label.toLowerCase() === srcNode.label.toLowerCase());
    if (match) {
      // Update href if the target node is missing one
      if (!match.href && srcNode.href) {
        match.href = srcNode.href;
      }
      // Recursively merge children
      mergeNavTrees(match.children, srcNode.children);
      match.estimatedChildren = match.children.length;
    } else {
      target.push(srcNode);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Resolve a potentially relative href to an absolute URL within the same origin */
function resolveHref(href: string, origin: string): string | null {
  if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('mailto:')) {
    return null;
  }

  try {
    const resolved = new URL(href, origin);
    // Only keep same-origin links
    if (resolved.origin !== origin) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/** Merge mega-menu children into existing nav nodes when labels match */
function mergeMegaMenuNodes(existing: NavNode[], megaNodes: NavNode[]): void {
  for (const mega of megaNodes) {
    const match = existing.find(
      (n) => n.label.toLowerCase() === mega.label.toLowerCase() && n.source === 'header',
    );
    if (match && mega.children.length > 0) {
      // Merge children into existing header node
      match.children.push(...mega.children);
      match.estimatedChildren = match.children.length;
    } else {
      // No match — add as new top-level node
      existing.push(mega);
    }
  }
}

/** Deduplicate nav nodes by href+source, keeping the first occurrence */
function deduplicateNodes(nodes: NavNode[]): NavNode[] {
  const seen = new Set<string>();
  const result: NavNode[] = [];

  for (const node of nodes) {
    const key = (node.href ?? node.label) + ':' + node.source;
    if (seen.has(key)) continue;
    seen.add(key);

    // Recursively deduplicate children
    if (node.children.length > 0) {
      node.children = deduplicateNodes(node.children);
    }

    result.push(node);
  }

  return result;
}
