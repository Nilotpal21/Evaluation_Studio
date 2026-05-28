/**
 * Breadcrumb Extractor — Extract navigation breadcrumbs from rendered pages
 *
 * Three extraction strategies in priority order:
 *   1. Schema.org structured data (BreadcrumbList itemtype)
 *   2. ARIA-labelled breadcrumb navigation
 *   3. Heuristic: ol/ul with sequential links matching ascending depth pattern
 *
 * Breadcrumbs are the most reliable source of hub URLs because they contain
 * the REAL page URLs (including suffixes like /sh/s1 on Epson) — truncating
 * sample URL paths often produces 404s.
 */

import type { Page } from 'playwright';

// ─── Types ──────────────────────────────────────────────────────────

export interface Breadcrumb {
  /** Display text for this breadcrumb level */
  text: string;
  /** Full URL — the real hub URL with correct format */
  href: string;
  /** Depth in the breadcrumb chain (0 = shallowest/root) */
  depth: number;
}

export interface BreadcrumbResult {
  /** Ordered breadcrumbs from shallowest (root) to deepest (current page) */
  crumbs: Breadcrumb[];
  /** Which extraction strategy succeeded */
  strategy: 'schema-org' | 'aria-nav' | 'css-class' | 'heuristic' | 'separator' | 'none';
}

// ─── Main Entry Point ───────────────────────────────────────────────

/**
 * Extract breadcrumb navigation from a rendered page.
 *
 * Tries structured data first (most reliable), then ARIA, then heuristic.
 * Returns the first strategy that produces results.
 */
export async function extractBreadcrumbs(page: Page): Promise<BreadcrumbResult> {
  const pageUrl = page.url();
  const origin = new URL(pageUrl).origin;

  // Strategy 1: Schema.org BreadcrumbList
  const schemaResult = await extractSchemaOrgBreadcrumbs(page, origin);
  if (schemaResult.length > 0) {
    return { crumbs: schemaResult, strategy: 'schema-org' };
  }

  // Strategy 2: ARIA breadcrumb navigation
  const ariaResult = await extractAriaBreadcrumbs(page, origin);
  if (ariaResult.length > 0) {
    return { crumbs: ariaResult, strategy: 'aria-nav' };
  }

  // Strategy 3: CSS class-based — class*="breadcrumb" on links or container
  // Handles sites like Epson where individual <a> tags have class="breadcrumb"
  const cssResult = await extractCssClassBreadcrumbs(page, origin);
  if (cssResult.length > 0) {
    return { crumbs: cssResult, strategy: 'css-class' };
  }

  // Strategy 4: Heuristic — ol/ul with ascending-depth links
  const heuristicResult = await extractHeuristicBreadcrumbs(page, origin);
  if (heuristicResult.length > 0) {
    return { crumbs: heuristicResult, strategy: 'heuristic' };
  }

  // Strategy 4: Separator-based — links separated by / > › in a compact container
  // Handles sites like Epson where breadcrumbs are plain <a> tags in a div
  const separatorResult = await extractSeparatorBreadcrumbs(page, origin);
  if (separatorResult.length > 0) {
    return { crumbs: separatorResult, strategy: 'separator' };
  }

  return { crumbs: [], strategy: 'none' };
}

// ─── Strategy 1: Schema.org ─────────────────────────────────────────

async function extractSchemaOrgBreadcrumbs(page: Page, origin: string): Promise<Breadcrumb[]> {
  const raw = (await page.evaluate(`(function() {
    var results = [];

    // Method A: Microdata — [itemtype*="BreadcrumbList"]
    var lists = document.querySelectorAll('[itemtype*="BreadcrumbList"]');
    for (var i = 0; i < lists.length; i++) {
      var items = lists[i].querySelectorAll('[itemprop="itemListElement"]');
      for (var j = 0; j < items.length; j++) {
        var nameEl = items[j].querySelector('[itemprop="name"]');
        var linkEl = items[j].querySelector('[itemprop="item"]');
        var posEl = items[j].querySelector('[itemprop="position"]');
        var text = nameEl ? (nameEl.textContent || '').trim() : '';
        var href = '';
        if (linkEl) {
          href = linkEl.href || linkEl.getAttribute('href') || linkEl.getAttribute('content') || '';
        }
        // Some sites put href on the itemListElement itself
        if (!href) {
          var aTag = items[j].querySelector('a[href]');
          if (aTag) href = aTag.href;
        }
        var pos = posEl ? parseInt(posEl.getAttribute('content') || posEl.textContent || '0', 10) : j;
        if (text) {
          results.push({ text: text, href: href, position: pos });
        }
      }
      if (results.length > 0) break;
    }

    // Method B: JSON-LD — <script type="application/ld+json"> with BreadcrumbList
    if (results.length === 0) {
      var scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (var s = 0; s < scripts.length; s++) {
        try {
          var data = JSON.parse(scripts[s].textContent || '');
          var items2 = null;
          if (data['@type'] === 'BreadcrumbList') {
            items2 = data.itemListElement;
          } else if (Array.isArray(data)) {
            for (var d = 0; d < data.length; d++) {
              if (data[d]['@type'] === 'BreadcrumbList') {
                items2 = data[d].itemListElement;
                break;
              }
            }
          } else if (data['@graph']) {
            for (var g = 0; g < data['@graph'].length; g++) {
              if (data['@graph'][g]['@type'] === 'BreadcrumbList') {
                items2 = data['@graph'][g].itemListElement;
                break;
              }
            }
          }
          if (items2 && items2.length > 0) {
            for (var k = 0; k < items2.length; k++) {
              var item = items2[k];
              var name = item.name || (item.item && item.item.name) || '';
              var url = '';
              if (typeof item.item === 'string') url = item.item;
              else if (item.item && item.item['@id']) url = item.item['@id'];
              else if (item.item && item.item.url) url = item.item.url;
              var position = item.position || k;
              if (name) {
                results.push({ text: name, href: url, position: position });
              }
            }
            break;
          }
        } catch(e) {}
      }
    }

    // Sort by position
    results.sort(function(a, b) { return a.position - b.position; });
    return results;
  })()`)) as Array<{ text: string; href: string; position: number }>;

  return resolveAndFilter(raw, origin);
}

// ─── Strategy 2: ARIA Navigation ────────────────────────────────────

async function extractAriaBreadcrumbs(page: Page, origin: string): Promise<Breadcrumb[]> {
  const raw = (await page.evaluate(`(function() {
    var results = [];
    var navs = document.querySelectorAll(
      'nav[aria-label*="breadcrumb" i], nav[aria-label*="Breadcrumb" i], ' +
      '[role="navigation"][aria-label*="breadcrumb" i], ' +
      'nav.breadcrumb, nav.breadcrumbs, [class*="breadcrumb" i] nav'
    );

    for (var i = 0; i < navs.length; i++) {
      var links = navs[i].querySelectorAll('a[href]');
      for (var j = 0; j < links.length; j++) {
        var text = (links[j].textContent || '').trim();
        var href = links[j].href || '';
        if (text && href) {
          results.push({ text: text, href: href, position: j });
        }
      }

      // Also check for a non-link final item (current page text)
      var allItems = navs[i].querySelectorAll('li, span, a');
      var lastItem = allItems[allItems.length - 1];
      if (lastItem && !lastItem.href) {
        var lastText = (lastItem.textContent || '').trim();
        if (lastText && results.length > 0 && results[results.length - 1].text !== lastText) {
          results.push({ text: lastText, href: location.href, position: results.length });
        }
      }

      if (results.length > 0) break;
    }

    return results;
  })()`)) as Array<{ text: string; href: string; position: number }>;

  return resolveAndFilter(raw, origin);
}

// ─── Strategy 3: CSS Class-Based ────────────────────────────────────

/**
 * Find breadcrumbs by CSS class names containing "breadcrumb".
 * Handles two patterns:
 *   A) Individual <a> tags with class="breadcrumb" (Epson pattern)
 *   B) Container with class*="breadcrumb" containing <a> tags
 */
async function extractCssClassBreadcrumbs(page: Page, origin: string): Promise<Breadcrumb[]> {
  const raw = (await page.evaluate(`(function() {
    var results = [];

    // Pattern A: Links with class*="breadcrumb"
    var bcLinks = document.querySelectorAll('a[class*="breadcrumb" i]');
    if (bcLinks.length >= 2) {
      for (var i = 0; i < bcLinks.length; i++) {
        var a = bcLinks[i];
        var text = (a.textContent || '').trim();
        var href = a.href || '';
        if (text && href) {
          results.push({ text: text, href: href, position: i });
        }
      }

      // Check for a non-link final item (current page)
      // Look for the next sibling text node or non-link element after the last breadcrumb link
      if (bcLinks.length > 0) {
        var lastBc = bcLinks[bcLinks.length - 1];
        var parent = lastBc.parentElement;
        if (parent) {
          var nodes = parent.childNodes;
          var foundLast = false;
          var trailingText = '';
          for (var n = 0; n < nodes.length; n++) {
            if (nodes[n] === lastBc) { foundLast = true; continue; }
            if (foundLast) {
              if (nodes[n].nodeType === 3) {
                trailingText += nodes[n].textContent;
              } else if (nodes[n].nodeType === 1 && !nodes[n].href) {
                trailingText += (nodes[n].textContent || '');
              }
            }
          }
          trailingText = trailingText.replace(/[/\\\\>\\u203A\\u00BB\\s]+/g, ' ').trim();
          if (trailingText.length > 0 && trailingText.length < 80) {
            results.push({
              text: trailingText,
              href: location.href,
              position: results.length
            });
          }
        }
      }

      if (results.length >= 2) return results;
    }

    // Pattern B: Container with class*="breadcrumb" containing links
    results = [];
    var containers = document.querySelectorAll(
      '[class*="breadcrumb" i]:not(a):not(script):not(style)'
    );
    for (var c = 0; c < containers.length; c++) {
      var el = containers[c];
      var links = el.querySelectorAll('a[href]');
      if (links.length < 2) continue;

      var items = [];
      for (var j = 0; j < links.length; j++) {
        var linkText = (links[j].textContent || '').trim();
        var linkHref = links[j].href || '';
        if (linkText && linkHref) {
          items.push({ text: linkText, href: linkHref, position: j });
        }
      }

      // Check for non-link trailing text (current page)
      var containerText = (el.textContent || '').trim();
      if (links.length > 0) {
        var lastLink = links[links.length - 1];
        var lastLinkText = (lastLink.textContent || '').trim();
        var afterIdx = containerText.lastIndexOf(lastLinkText);
        if (afterIdx >= 0) {
          var after = containerText.substring(afterIdx + lastLinkText.length)
            .replace(/[/\\\\>\\u203A\\u00BB\\s]+/g, ' ').trim();
          if (after.length > 0 && after.length < 80) {
            items.push({ text: after, href: location.href, position: items.length });
          }
        }
      }

      if (items.length >= 2 && items.length > results.length) {
        results = items;
      }
    }

    return results;
  })()`)) as Array<{ text: string; href: string; position: number }>;

  return resolveAndFilter(raw, origin);
}

// ─── Strategy 4: Heuristic ──────────────────────────────────────────

async function extractHeuristicBreadcrumbs(page: Page, origin: string): Promise<Breadcrumb[]> {
  const raw = (await page.evaluate(`(function() {
    // Look for ol/ul elements that contain a sequence of links with ascending path depth
    var candidates = document.querySelectorAll('ol, ul');
    var bestResult = [];

    for (var i = 0; i < candidates.length; i++) {
      var list = candidates[i];
      // Skip if too many items (not a breadcrumb)
      var listItems = list.querySelectorAll(':scope > li');
      if (listItems.length < 2 || listItems.length > 12) continue;

      // Skip if parent is nav-header, footer, sidebar (breadcrumbs are in content area)
      var parent = list.parentElement;
      var skip = false;
      while (parent && parent !== document.body) {
        var cls = (parent.className || '').toLowerCase();
        var role = (parent.getAttribute('role') || '').toLowerCase();
        if (role === 'navigation' && !/breadcrumb/i.test(parent.getAttribute('aria-label') || '')) {
          // Navigation that's not breadcrumb — likely header/sidebar nav
          if (cls.includes('header') || cls.includes('footer') || cls.includes('sidebar')) {
            skip = true;
            break;
          }
        }
        if (cls.includes('footer') || cls.includes('header-nav') || cls.includes('main-nav')) {
          skip = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (skip) continue;

      var links = [];
      var prevDepth = -1;
      var ascending = true;

      for (var j = 0; j < listItems.length; j++) {
        var a = listItems[j].querySelector('a[href]');
        if (a) {
          try {
            var u = new URL(a.href);
            var depth = u.pathname.split('/').filter(Boolean).length;
            if (prevDepth >= 0 && depth <= prevDepth) ascending = false;
            prevDepth = depth;
            links.push({
              text: (a.textContent || '').trim(),
              href: a.href,
              position: j,
              depth: depth
            });
          } catch(e) {}
        } else {
          // Last item might be current page (no link)
          var text = (listItems[j].textContent || '').trim();
          if (text && j === listItems.length - 1) {
            links.push({
              text: text,
              href: location.href,
              position: j,
              depth: location.pathname.split('/').filter(Boolean).length
            });
          }
        }
      }

      // Must have ascending depth (or at least non-decreasing) and ≥2 items
      if (links.length >= 2 && ascending && links.length > bestResult.length) {
        bestResult = links;
      }
    }

    return bestResult;
  })()`)) as Array<{ text: string; href: string; position: number }>;

  return resolveAndFilter(raw, origin);
}

// ─── Strategy 4: Separator-Based ────────────────────────────────────

/**
 * Find breadcrumbs by looking for a compact container with sequential links
 * separated by / > › characters. Handles sites like Epson where breadcrumbs
 * are plain <a> tags in a <div> without semantic markup.
 *
 * Pattern: "Support / Printers / All-In-Ones / ET Series / Epson ET-7700"
 * where "Support", "Printers", "All-In-Ones", "ET Series" are <a> tags.
 */
async function extractSeparatorBreadcrumbs(page: Page, origin: string): Promise<Breadcrumb[]> {
  const raw = (await page.evaluate(`(function() {
    // Find containers that have 2+ links with separator text between them
    // Breadcrumb containers are typically compact (short text, few children)
    var candidates = document.querySelectorAll('div, span, p, nav, section');
    var bestResult = [];

    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];

      // Skip large containers (breadcrumbs are compact)
      var text = (el.textContent || '').trim();
      if (text.length > 500 || text.length < 5) continue;

      // Must contain separator characters
      if (!/[/›>»·]/.test(text)) continue;

      // Get direct child links and text nodes
      var links = el.querySelectorAll(':scope a[href]');
      if (links.length < 2 || links.length > 10) continue;

      // Check that links are separated by / > › and in ascending depth order
      var items = [];
      var prevDepth = -1;
      var ascending = true;
      var allSameOrigin = true;

      for (var j = 0; j < links.length; j++) {
        var a = links[j];
        var linkText = (a.textContent || '').trim();
        var href = a.href || '';
        if (!linkText || !href || linkText.length > 80) continue;

        try {
          var u = new URL(href);
          if (u.origin !== location.origin) { allSameOrigin = false; continue; }
          var depth = u.pathname.split('/').filter(Boolean).length;
          if (prevDepth >= 0 && depth < prevDepth) ascending = false;
          prevDepth = depth;
          items.push({ text: linkText, href: href, position: j, depth: depth });
        } catch(e) {}
      }

      // Must be same-origin, ascending depth, and 2+ items
      if (!allSameOrigin || !ascending || items.length < 2) continue;

      // Check separator: text between links should contain / > › etc.
      // Extract the full text and verify separators between link texts
      var hasSeparator = false;
      for (var k = 0; k < items.length - 1; k++) {
        var between = text.substring(
          text.indexOf(items[k].text) + items[k].text.length,
          text.indexOf(items[k + 1].text)
        ).trim();
        if (/^[/›>»·\\-|]+$/.test(between) || /^\\s*[/›>»·]\\s*$/.test(between)) {
          hasSeparator = true;
        }
      }

      // Also check for the last item being non-link text (current page)
      var lastLink = links[links.length - 1];
      var afterLast = '';
      var node = lastLink.nextSibling;
      while (node) {
        if (node.nodeType === 3) afterLast += node.textContent;
        else if (node.nodeType === 1 && !node.href) afterLast += (node.textContent || '');
        node = node.nextSibling;
      }
      afterLast = afterLast.replace(/[/›>»·\\s]/g, '').trim();
      if (afterLast.length > 0 && afterLast.length < 80) {
        // There's non-link text after the last link — likely current page
        items.push({
          text: afterLast,
          href: location.href,
          position: items.length,
          depth: location.pathname.split('/').filter(Boolean).length
        });
      }

      if (hasSeparator && items.length > bestResult.length) {
        bestResult = items;
      }
    }

    return bestResult;
  })()`)) as Array<{ text: string; href: string; position: number }>;

  return resolveAndFilter(raw, origin);
}

// ─── Shared Helpers ─────────────────────────────────────────────────

/**
 * Resolve relative URLs and filter to same-origin.
 * Assigns depth based on position in the chain.
 */
function resolveAndFilter(
  raw: Array<{ text: string; href: string; position: number }>,
  origin: string,
): Breadcrumb[] {
  const crumbs: Breadcrumb[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    let href = item.href;

    // Resolve relative URLs
    if (href && !href.startsWith('http')) {
      try {
        href = new URL(href, origin).toString();
      } catch {
        continue;
      }
    }

    // Skip empty or non-http
    if (!href || (!href.startsWith('http://') && !href.startsWith('https://'))) {
      continue;
    }

    // Keep only same-origin breadcrumbs
    try {
      if (new URL(href).origin !== origin) continue;
    } catch {
      continue;
    }

    crumbs.push({
      text: item.text,
      href,
      depth: i,
    });
  }

  return crumbs;
}
