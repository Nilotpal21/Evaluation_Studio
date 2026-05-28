/**
 * BFS Discovery Engine — Core orchestrator for site discovery
 *
 * Runs a multi-phase BFS discovery:
 *   Phase 0: Extract site navigation skeleton from primary URL
 *   Phase 1a: Visit seed/sample URLs — extract breadcrumbs, links, classify
 *   Phase 1b: Visit direct children of seeds (depth-1 expansion)
 *   Phase 2: Climb breadcrumb ancestors (shallowest first), fallback to URL path truncation
 *   Phase 3: BFS depth-1 expansion with yield tracking, sorted depth-first
 *
 * Each phase emits progress events via the onEvent callback for SSE streaming.
 * The engine checks for user commands (stop, explore-branch, etc.) between every page visit.
 */

import type { Page } from 'playwright';
import type { BrowserPool } from '../browser/pool.js';
import type { NavNode, NavExtractionResult } from './nav-extractor.js';
import type { Breadcrumb, BreadcrumbResult } from './breadcrumb-extractor.js';
import type { ExploreProgress, DiscoveredLink } from './navigation-explorer.js';
import type { PageRole } from './page-classifier.js';
import type { ApiInterceptorHandle } from './api-interceptor.js';
import type { Intervention } from './command-queue.js';

import { extractSiteNavigation } from './nav-extractor.js';
import { extractBreadcrumbs } from './breadcrumb-extractor.js';
import { navigateWithRetry, extractPageLinks, dismissOverlays } from './navigation-explorer.js';
import { classifyPage, collectPageMetrics } from './page-classifier.js';
import { createYieldTracker, trackPageVisit, shouldContinue } from './yield-tracker.js';
import { getNextCommand } from './command-queue.js';
import { attachApiInterceptor } from './api-interceptor.js';
import { normalizeUrl, isSameDomain, extractDomain, urlToLabel } from './url-normalizer.js';
import { buildHybridTree } from './hybrid-tree-builder.js';

// ─── Constants ──────────────────────────────────────────────────────

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_PAGE_TIMEOUT = 15_000;
const DEFAULT_MAX_ALL_LINKS = 50_000;
const PROGRESS_THROTTLE_MS = 300;
const MAX_EXPLORE_ALL_URLS = 20;
const PHASE_1B_MAX_PER_SEED = 50;
const OVERALL_TIMEOUT_MS = 10 * 60 * 1000;

// ─── Configuration ──────────────────────────────────────────────────

export interface BfsDiscoveryConfig {
  discoveryId: string;
  primaryUrl: string;
  sampleUrls: string[];
  /** Maximum BFS depth (default 8) */
  maxDepth: number;
  /** Per-page navigation timeout in ms (default 15000) */
  pageTimeout: number;
  /** Maximum total discovered URLs before stopping (default 50000) */
  maxAllLinks: number;
}

// ─── Progress Event Types ───────────────────────────────────────────

export type BfsProgressEvent =
  | BfsPhaseEvent
  | BfsTreeSnapshotEvent
  | BfsProgressCounterEvent
  | BfsActivityLogEvent
  | BfsCompleteEvent
  | BfsErrorEvent;

export interface BfsPhaseEvent {
  type: 'phase';
  phase: 0 | '1a' | '1b' | 2 | 3;
  label: string;
  timestamp: number;
}

export interface BfsTreeSnapshotEvent {
  type: 'tree-snapshot';
  tree: TreeNode[];
  totalUrls: number;
  totalVisited: number;
  timestamp: number;
  discoveredPages?: Array<[string, DiscoveredPage]>;
}

export interface BfsProgressCounterEvent {
  type: 'progress';
  totalUrls: number;
  totalVisited: number;
  timestamp: number;
}

export interface BfsActivityLogEvent {
  type: 'activity';
  message: string;
  level: 'info' | 'warn' | 'detail';
  timestamp: number;
}

export interface BfsCompleteEvent {
  type: 'complete';
  totalUrls: number;
  totalVisited: number;
  totalPhasesRun: number;
  durationMs: number;
  stoppedBy: 'exhausted' | 'user-stop' | 'yield-limit' | 'url-cap' | 'timeout';
  tree: TreeNode[];
  timestamp: number;
}

export interface BfsErrorEvent {
  type: 'error';
  message: string;
  phase?: string;
  timestamp: number;
}

// ─── Result Types ───────────────────────────────────────────────────

export interface BfsDiscoveryResult {
  discoveryId: string;
  domain: string;
  discoveredUrls: Map<string, DiscoveredPage>;
  treeHierarchy: TreeNode[];
  navStructure: NavNode[];
  breadcrumbChains: Array<{ sourceUrl: string; crumbs: Breadcrumb[]; strategy: string }>;
  stats: {
    totalUrls: number;
    totalVisited: number;
    totalPhases: number;
    durationMs: number;
    stoppedBy: 'exhausted' | 'user-stop' | 'yield-limit' | 'url-cap' | 'timeout';
  };
}

export interface DiscoveredPage {
  url: string;
  foundOn: string[];
  renderMethod: 'http' | 'browser' | 'unknown';
  visited: boolean;
  status: 'discovered' | 'visiting' | 'visited' | 'error';
  childUrls: string[];
  title?: string;
  pageRole?: PageRole;
  errorMessage?: string;
  discoverySource?:
    | 'primary'
    | 'seed'
    | 'nav'
    | 'breadcrumb-climb'
    | 'bfs'
    | 'user-command'
    | 'sitemap';
  linkText?: string;
  breadcrumbLabel?: string;
  discoveredAt?: number;
  linkFrequency?: number;
  isGlobalLink?: boolean;
}

export interface TreeNode {
  url: string;
  label: string;
  children: TreeNode[];
  depth: number;
  visited: boolean;
  renderMethod: 'http' | 'browser' | 'unknown';
  pageRole?: 'hub' | 'leaf' | 'mixed';
  status: 'discovered' | 'visiting' | 'visited' | 'error';
}

// ─── Dummy progress for navigateWithRetry ────────────────────────────

function makeDummyProgress(): ExploreProgress {
  return {
    phase: 'rendering',
    expandablesFound: 0,
    expandablesClicked: 0,
    linksFound: 0,
    depth: 0,
    tree: [],
  };
}

// ─── Render Method Detection ─────────────────────────────────────────

/**
 * Detect whether a page requires browser rendering or can be fetched via HTTP.
 * Uses string-based page.evaluate to avoid tsx __name injection gotcha.
 */
async function detectRenderMethod(page: Page): Promise<'http' | 'browser' | 'unknown'> {
  try {
    const result = (await page.evaluate(`(function() {
      // Check for React
      if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot]') || document.querySelector('#__next')) {
        return 'browser';
      }
      // Check for Angular
      if (window.ng || document.querySelector('[ng-app]') || document.querySelector('[ng-version]')) {
        return 'browser';
      }
      // Check for Vue
      if (window.__VUE__ || document.querySelector('[data-v-]') || document.querySelector('#__nuxt')) {
        return 'browser';
      }
      // Check for Next.js
      if (window.__NEXT_DATA__ || document.querySelector('#__next')) {
        return 'browser';
      }
      // Check for Nuxt
      if (window.__NUXT__ || document.querySelector('#__nuxt')) {
        return 'browser';
      }
      // SPA shell detection: body has very little text but many scripts
      var bodyText = (document.body.innerText || '').trim();
      var scripts = document.querySelectorAll('script[src]');
      if (bodyText.length < 200 && scripts.length > 5) {
        return 'browser';
      }
      // Check for noscript content indicating JS dependency
      var noscript = document.querySelector('noscript');
      if (noscript && noscript.textContent && noscript.textContent.length > 50) {
        return 'browser';
      }
      // If page has substantial content, likely works with HTTP
      if (bodyText.length > 1000) {
        return 'http';
      }
      return 'unknown';
    })()`)) as string;

    if (result === 'http' || result === 'browser') return result;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ─── Visit Page Helper ───────────────────────────────────────────────

/**
 * Visit a single page: navigate, extract links, breadcrumbs, classify role,
 * detect render method. Updates allUrls map and emits events.
 * Errors are caught and mark the page as 'error' without crashing the engine.
 */
async function visitPage(
  page: Page,
  url: string,
  allUrls: Map<string, DiscoveredPage>,
  baseUrl: string,
  pageTimeout: number,
  maxAllLinks: number,
  _onEvent: (event: BfsProgressEvent) => void,
  breadcrumbChains: Array<{ sourceUrl: string; crumbs: Breadcrumb[]; strategy: string }>,
): Promise<{
  links: DiscoveredLink[];
  newLinks: number;
  role: PageRole | undefined;
}> {
  const normalized = normalizeUrl(url);

  // Mark as visiting — but do NOT set visited=true yet.
  // visited=true is set only after successful navigation (below).
  // Setting it prematurely means error pages are permanently skipped
  // in subsequent BFS phases (they check `if (record.visited) continue`).
  const existing = allUrls.get(normalized);
  if (existing) {
    existing.status = 'visiting';
  }

  try {
    // Navigate
    const dummyProgress = makeDummyProgress();
    await navigateWithRetry(page, url, pageTimeout, dummyProgress);

    // Dismiss overlays
    try {
      await dismissOverlays(page);
    } catch {
      // Best-effort — overlay dismiss failure should not kill page visit
    }

    // Extract links — resilient to context destruction from client-side navigations
    let links: DiscoveredLink[] = [];
    try {
      links = await extractPageLinks(page);
    } catch {
      // Context destroyed — continue with empty links rather than failing the page
    }

    // Extract breadcrumbs — retry once after 500ms settle if first attempt fails.
    // JS-heavy sites (e.g. Epson) can destroy the Playwright execution context
    // mid-evaluate, causing all 5 breadcrumb strategies to throw. A short settle
    // delay lets the page stabilize before the retry.
    let breadcrumbResult: BreadcrumbResult | undefined;
    try {
      breadcrumbResult = await extractBreadcrumbs(page);
    } catch {
      // First attempt failed — wait for page to settle and retry
      try {
        await page.waitForTimeout(500);
        breadcrumbResult = await extractBreadcrumbs(page);
      } catch {
        // Both attempts failed — log a warning for diagnostics
        _onEvent({
          type: 'activity',
          message: `Breadcrumb extraction failed for ${normalized} after retry`,
          level: 'warn',
          timestamp: Date.now(),
        });
      }
    }
    if (breadcrumbResult && breadcrumbResult.crumbs.length > 0) {
      breadcrumbChains.push({
        sourceUrl: normalized,
        crumbs: breadcrumbResult.crumbs,
        strategy: breadcrumbResult.strategy,
      });
    }

    // Classify page role
    let role: PageRole | undefined;
    try {
      const metrics = await collectPageMetrics(page);
      role = classifyPage(metrics);
    } catch {
      // Classification is best-effort
    }

    // Detect render method
    let renderMethod: 'http' | 'browser' | 'unknown' = 'unknown';
    try {
      renderMethod = await detectRenderMethod(page);
    } catch {
      // Best-effort — default 'unknown' already set
    }

    // Get page title
    let title: string | undefined;
    try {
      title = await page.title();
    } catch {
      // Best-effort
    }

    // Register discovered links
    let newLinks = 0;
    const childUrls: string[] = [];

    for (const link of links) {
      if (!isSameDomain(link.href, baseUrl)) continue;

      const normalizedHref = normalizeUrl(link.href);
      childUrls.push(normalizedHref);

      if (!allUrls.has(normalizedHref)) {
        if (allUrls.size >= maxAllLinks) break;

        allUrls.set(normalizedHref, {
          url: normalizedHref,
          foundOn: [normalized],
          renderMethod: 'unknown',
          visited: false,
          status: 'discovered',
          childUrls: [],
          title: link.text || undefined,
          linkText: link.text || undefined,
          discoveredAt: Date.now(),
        });
        newLinks++;
      } else {
        const existingPage = allUrls.get(normalizedHref);
        if (existingPage && !existingPage.foundOn.includes(normalized)) {
          existingPage.foundOn.push(normalized);
        }
      }
    }

    // Update the visited page record
    const pageRecord = allUrls.get(normalized);
    if (pageRecord) {
      pageRecord.status = 'visited';
      pageRecord.visited = true;
      pageRecord.renderMethod = renderMethod;
      pageRecord.pageRole = role;
      pageRecord.title = title ?? pageRecord.title;
      pageRecord.childUrls = childUrls;
    } else {
      allUrls.set(normalized, {
        url: normalized,
        foundOn: [],
        renderMethod,
        visited: true,
        status: 'visited',
        childUrls,
        title,
        pageRole: role,
      });
    }

    return { links, newLinks, role };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Mark page as error — keep visited=false so the page can be retried
    // in subsequent BFS phases or via user "Explore Branch" / "Retry".
    const pageRecord = allUrls.get(normalized);
    if (pageRecord) {
      pageRecord.status = 'error';
      pageRecord.visited = false;
      pageRecord.errorMessage = errorMessage;
    }

    return { links: [], newLinks: 0, role: undefined };
  }
}

// ─── Tree Building Utilities ─────────────────────────────────────────

/**
 * Extract lowercase pathname from a URL, stripping trailing slash (except root "/").
 */
function getPathname(url: string): string {
  try {
    const parsed = new URL(url);
    let pathname = parsed.pathname.toLowerCase();
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    return pathname;
  } catch {
    return '/';
  }
}

/**
 * Compute the path depth of a URL (number of non-empty path segments).
 */
function getPathDepth(url: string): number {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Find the closest ancestor URL for a given pathname using O(d) Map lookup.
 * Walks from longest prefix down to "/" checking the pathToUrlMap.
 * Returns the normalized URL of the ancestor, or null if none found.
 */
function findClosestAncestor(pathname: string, pathToUrlMap: Map<string, string>): string | null {
  const segments = pathname.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const prefix = i === 0 ? '/' : '/' + segments.slice(0, i).join('/');
    const match = pathToUrlMap.get(prefix);
    if (match !== undefined) {
      return match;
    }
  }
  return null;
}

/**
 * Build a tree hierarchy from the flat URL map.
 * Uses O(d) pathname Map lookups instead of O(n) linear scans.
 * Sorts URLs by depth (shallowest first), enriches TreeNode with
 * visited/renderMethod/pageRole/status from DiscoveredPage.
 * Orphans attach to root (never become spurious roots).
 */
function buildTree(allUrls: Map<string, DiscoveredPage>, primaryUrl: string): TreeNode[] {
  const normalizedPrimary = normalizeUrl(primaryUrl);
  const urls = [...allUrls.keys()];

  // Build pathToUrlMap: Map<pathname, normalizedUrl>
  const pathToUrlMap = new Map<string, string>();
  for (const url of urls) {
    const pathname = getPathname(url);
    // First URL for a given pathname wins
    if (!pathToUrlMap.has(pathname)) {
      pathToUrlMap.set(pathname, url);
    }
  }

  // Sort by path depth (shallowest first)
  urls.sort((a, b) => getPathDepth(a) - getPathDepth(b));

  // Build tree nodes with enriched data
  const nodeMap = new Map<string, TreeNode>();

  for (const url of urls) {
    const depth = getPathDepth(url);
    const page = allUrls.get(url);
    const label = page?.title || urlToLabel(url);
    const node: TreeNode = {
      url,
      label,
      children: [],
      depth,
      visited: page?.visited ?? false,
      renderMethod: page?.renderMethod ?? 'unknown',
      pageRole: page?.pageRole,
      status: page?.status ?? 'discovered',
    };
    nodeMap.set(url, node);
  }

  // Build hierarchy — primary URL is always root
  const roots: TreeNode[] = [];
  let rootNode: TreeNode | undefined;

  for (const url of urls) {
    const node = nodeMap.get(url);
    if (!node) continue;

    if (url === normalizedPrimary) {
      roots.unshift(node);
      rootNode = node;
      continue;
    }

    const pathname = getPathname(url);
    const ancestorUrl = findClosestAncestor(pathname, pathToUrlMap);
    if (ancestorUrl && ancestorUrl !== url && nodeMap.has(ancestorUrl)) {
      const ancestor = nodeMap.get(ancestorUrl);
      if (ancestor) {
        ancestor.children.push(node);
      }
    } else if (rootNode) {
      // Orphans attach to root, never become spurious roots
      rootNode.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

// ─── Command Queue Checking ──────────────────────────────────────────

/**
 * Process pending commands from the command queue.
 * Returns true if discovery should stop.
 */
function processCommands(
  discoveryId: string,
  allUrls: Map<string, DiscoveredPage>,
  baseUrl: string,
  maxAllLinks: number,
  onEvent: (event: BfsProgressEvent) => void,
): { shouldStop: boolean; exploreBranchUrls: string[] } {
  let shouldStop = false;
  const exploreBranchUrls: string[] = [];

  let command: Intervention | undefined;
  while ((command = getNextCommand(discoveryId))) {
    switch (command.type) {
      case 'stop':
        shouldStop = true;
        onEvent({
          type: 'activity',
          message: 'User requested stop',
          level: 'info',
          timestamp: Date.now(),
        });
        break;

      case 'explore-branch':
        if (command.payload?.url) {
          exploreBranchUrls.push(command.payload.url);
          onEvent({
            type: 'activity',
            message: `User requested exploration of branch: ${command.payload.url}`,
            level: 'info',
            timestamp: Date.now(),
          });
        }
        break;

      case 'explore-all':
        if (command.payload?.urls) {
          const urlsToAdd = command.payload.urls.slice(0, MAX_EXPLORE_ALL_URLS);
          for (const url of urlsToAdd) {
            const normalized = normalizeUrl(url);
            if (
              !allUrls.has(normalized) &&
              isSameDomain(url, baseUrl) &&
              allUrls.size < maxAllLinks
            ) {
              allUrls.set(normalized, {
                url: normalized,
                foundOn: [],
                renderMethod: 'unknown',
                visited: false,
                status: 'discovered',
                childUrls: [],
                discoverySource: 'user-command',
                discoveredAt: Date.now(),
              });
            }
          }
          onEvent({
            type: 'activity',
            message: `User requested exploration of ${urlsToAdd.length} URLs`,
            level: 'info',
            timestamp: Date.now(),
          });
        }
        break;

      case 'skip-branch':
        if (command.payload?.url) {
          const normalizedSkip = normalizeUrl(command.payload.url);
          const pageRecord = allUrls.get(normalizedSkip);
          if (pageRecord) {
            pageRecord.status = 'visited'; // Mark as visited so it gets skipped
            pageRecord.visited = true;
          }
          onEvent({
            type: 'activity',
            message: `Skipping branch: ${command.payload.url}`,
            level: 'info',
            timestamp: Date.now(),
          });
        }
        break;

      default:
        // Unknown command type — ignore
        break;
    }
  }

  return { shouldStop, exploreBranchUrls };
}

// ─── Main Orchestrator ───────────────────────────────────────────────

/**
 * Run a BFS discovery starting from the primary URL.
 *
 * Orchestrates Phases 0→1a→1b→2→3, emitting progress events via onEvent.
 * Checks shouldStop() and the command queue between every page visit.
 *
 * @param config - Discovery configuration
 * @param browserPool - Browser pool for Playwright page management
 * @param onEvent - Callback for SSE progress events
 * @param shouldStop - Function that returns true if discovery should abort
 * @returns Discovery result with all URLs, tree, and stats
 */
export async function runBfsDiscovery(
  config: BfsDiscoveryConfig,
  browserPool: BrowserPool,
  onEvent: (event: BfsProgressEvent) => void,
  shouldStop: () => boolean,
): Promise<BfsDiscoveryResult> {
  const {
    discoveryId,
    primaryUrl,
    sampleUrls,
    maxDepth = DEFAULT_MAX_DEPTH,
    pageTimeout = DEFAULT_PAGE_TIMEOUT,
    maxAllLinks = DEFAULT_MAX_ALL_LINKS,
  } = config;

  const domain = extractDomain(primaryUrl);
  const startTime = Date.now();
  let phasesRun = 0;
  let stoppedBy: 'exhausted' | 'user-stop' | 'yield-limit' | 'url-cap' | 'timeout' = 'exhausted';

  // ─── Internal State ──────────────────────────────────────────
  const allUrls = new Map<string, DiscoveredPage>();
  const breadcrumbChains: Array<{ sourceUrl: string; crumbs: Breadcrumb[]; strategy: string }> = [];
  let navStructure: NavNode[] = [];
  let visitedCount = 0;
  let lastProgressTime = 0;
  let snapshotInterval: ReturnType<typeof setInterval> | null = null;
  let lastSnapshotUrlCount = 0;

  const TREE_SNAPSHOT_INTERVAL_MS = 5_000;
  const MAX_TIMER_SNAPSHOT_URLS = 10_000;

  // Register primary URL
  const normalizedPrimary = normalizeUrl(primaryUrl);
  allUrls.set(normalizedPrimary, {
    url: normalizedPrimary,
    foundOn: [],
    renderMethod: 'unknown',
    visited: false,
    status: 'discovered',
    childUrls: [],
    discoverySource: 'primary',
    discoveredAt: Date.now(),
  });

  // ─── Helper: emit full tree snapshot ────────────────────────
  function emitTreeSnapshot(): void {
    const tree = buildHybridTree(allUrls, primaryUrl, breadcrumbChains);
    lastSnapshotUrlCount = allUrls.size;
    const discoveredPages: Array<[string, DiscoveredPage]> = Array.from(allUrls.entries());
    onEvent({
      type: 'tree-snapshot',
      tree,
      totalUrls: allUrls.size,
      totalVisited: visitedCount,
      timestamp: Date.now(),
      discoveredPages,
    });
  }

  // ─── Helper: emit throttled progress counters ───────────────
  function emitProgress(): void {
    const now = Date.now();
    if (now - lastProgressTime < PROGRESS_THROTTLE_MS) return;
    lastProgressTime = now;
    onEvent({
      type: 'progress',
      totalUrls: allUrls.size,
      totalVisited: visitedCount,
      timestamp: now,
    });
  }

  // ─── Helper: clear snapshot timer ───────────────────────────
  function clearSnapshotTimer(): void {
    if (snapshotInterval !== null) {
      clearInterval(snapshotInterval);
      snapshotInterval = null;
    }
  }

  // Emit initial tree snapshot
  emitTreeSnapshot();

  // ─── Helper: check stop conditions ───────────────────────────
  function checkStop(): { stopped: boolean; exploreBranchUrls: string[] } {
    if (shouldStop()) {
      stoppedBy = 'user-stop';
      clearSnapshotTimer();
      return { stopped: true, exploreBranchUrls: [] };
    }
    const cmdResult = processCommands(discoveryId, allUrls, primaryUrl, maxAllLinks, onEvent);
    if (cmdResult.shouldStop) {
      stoppedBy = 'user-stop';
      clearSnapshotTimer();
      return { stopped: true, exploreBranchUrls: [] };
    }
    if (Date.now() - startTime > OVERALL_TIMEOUT_MS) {
      stoppedBy = 'timeout';
      clearSnapshotTimer();
      onEvent({
        type: 'activity',
        message: 'Discovery timeout reached (10 minutes)',
        level: 'info',
        timestamp: Date.now(),
      });
      return { stopped: true, exploreBranchUrls: [] };
    }
    if (allUrls.size >= maxAllLinks) {
      stoppedBy = 'url-cap';
      clearSnapshotTimer();
      return { stopped: true, exploreBranchUrls: [] };
    }
    return { stopped: false, exploreBranchUrls: cmdResult.exploreBranchUrls ?? [] };
  }

  // ─── Helper: visit and track ─────────────────────────────────
  async function visitAndTrack(
    page: Page,
    url: string,
  ): Promise<{
    links: DiscoveredLink[];
    newLinks: number;
    role: PageRole | undefined;
  }> {
    const result = await visitPage(
      page,
      url,
      allUrls,
      primaryUrl,
      pageTimeout,
      maxAllLinks,
      onEvent,
      breadcrumbChains,
    );
    visitedCount++;
    emitProgress();
    return result;
  }

  // ─── Get browser page ────────────────────────────────────────
  const sessionId = `bfs-${discoveryId}`;
  const page = await browserPool.getPage(sessionId);
  let apiInterceptor: ApiInterceptorHandle | undefined;

  try {
    // Attach API interceptor
    try {
      apiInterceptor = await attachApiInterceptor(page, domain);
    } catch {
      // API interception is best-effort
      onEvent({
        type: 'activity',
        message: 'API interceptor could not be attached — continuing without it',
        level: 'warn',
        timestamp: Date.now(),
      });
    }

    // ════════════════════════════════════════════════════════════
    // Phase 0: Nav extraction from primary URL
    // ════════════════════════════════════════════════════════════
    onEvent({
      type: 'phase',
      phase: 0,
      label: 'Extracting site navigation',
      timestamp: Date.now(),
    });
    phasesRun++;

    try {
      // Navigate to primary URL
      onEvent({
        type: 'activity',
        message: 'Loading primary page...',
        level: 'info',
        timestamp: Date.now(),
      });
      const dummyProgress = makeDummyProgress();
      // B-3: Heartbeat during Phase 0 navigation so the UI doesn't appear frozen.
      // navigateWithRetry can take 15-75s (or more with retries), and without
      // heartbeat events the SSE stream goes silent — user thinks it's stuck.
      const heartbeatInterval = setInterval(() => {
        onEvent({
          type: 'activity',
          message: 'Waiting for page to load...',
          level: 'info',
          timestamp: Date.now(),
        });
      }, 3000);
      try {
        await navigateWithRetry(page, primaryUrl, pageTimeout, dummyProgress);
      } finally {
        clearInterval(heartbeatInterval);
      }
      await dismissOverlays(page);

      onEvent({
        type: 'activity',
        message: 'Analyzing page structure...',
        level: 'info',
        timestamp: Date.now(),
      });

      // Extract navigation
      let navResult: NavExtractionResult | undefined;
      try {
        navResult = await extractSiteNavigation(page, primaryUrl);
        navStructure = navResult.nodes;
        onEvent({
          type: 'activity',
          message: `Nav extraction: found ${navResult.nodes.length} nodes from ${navResult.source}`,
          level: 'info',
          timestamp: Date.now(),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent({
          type: 'activity',
          message: `Nav extraction failed: ${msg}`,
          level: 'warn',
          timestamp: Date.now(),
        });
      }

      // Extract links from primary page — resilient to context destruction
      // (epson.com and other JS-heavy sites trigger client-side navigations
      //  that destroy the Playwright execution context mid-evaluate)
      let primaryLinks: DiscoveredLink[] = [];
      let renderMethod: 'http' | 'browser' | 'unknown' = 'unknown';
      let primaryTitle: string | undefined;
      try {
        primaryLinks = await extractPageLinks(page);
        onEvent({
          type: 'activity',
          message: `Found ${primaryLinks.length} navigation links`,
          level: 'info',
          timestamp: Date.now(),
        });
      } catch (linkErr: unknown) {
        const msg = linkErr instanceof Error ? linkErr.message : String(linkErr);
        onEvent({
          type: 'activity',
          message: `Link extraction failed (will continue): ${msg}`,
          level: 'warn',
          timestamp: Date.now(),
        });
      }
      try {
        renderMethod = await detectRenderMethod(page);
      } catch {
        // Best-effort — default 'unknown' already set
      }
      try {
        primaryTitle = await page.title();
      } catch {
        // Best-effort
      }

      // Register links from primary page
      const primaryChildUrls: string[] = [];
      for (const link of primaryLinks) {
        if (!isSameDomain(link.href, primaryUrl)) continue;
        const normalizedHref = normalizeUrl(link.href);
        primaryChildUrls.push(normalizedHref);

        if (!allUrls.has(normalizedHref)) {
          if (allUrls.size >= maxAllLinks) break;

          allUrls.set(normalizedHref, {
            url: normalizedHref,
            foundOn: [normalizedPrimary],
            renderMethod: 'unknown',
            visited: false,
            status: 'discovered',
            childUrls: [],
            title: link.text || undefined,
            discoverySource: 'nav',
            linkText: link.text || undefined,
            discoveredAt: Date.now(),
          });
        }
      }

      // Mark primary as visited
      const primaryRecord = allUrls.get(normalizedPrimary);
      if (primaryRecord) {
        primaryRecord.status = 'visited';
        primaryRecord.visited = true;
        primaryRecord.renderMethod = renderMethod;
        primaryRecord.title = primaryTitle;
        primaryRecord.childUrls = primaryChildUrls;
      }
      visitedCount++;

      // Also extract breadcrumbs from primary — with retry (B-4)
      let primaryBcResult: BreadcrumbResult | undefined;
      try {
        primaryBcResult = await extractBreadcrumbs(page);
      } catch {
        try {
          await page.waitForTimeout(500);
          primaryBcResult = await extractBreadcrumbs(page);
        } catch {
          onEvent({
            type: 'activity',
            message: `Breadcrumb extraction failed for primary page after retry`,
            level: 'warn',
            timestamp: Date.now(),
          });
        }
      }
      if (primaryBcResult && primaryBcResult.crumbs.length > 0) {
        breadcrumbChains.push({
          sourceUrl: normalizedPrimary,
          crumbs: primaryBcResult.crumbs,
          strategy: primaryBcResult.strategy,
        });
      }
      onEvent({
        type: 'activity',
        message: `Extracted ${breadcrumbChains.length} breadcrumb chains`,
        level: 'info',
        timestamp: Date.now(),
      });

      // Classify primary page
      try {
        const metrics = await collectPageMetrics(page);
        const role = classifyPage(metrics);
        if (primaryRecord) primaryRecord.pageRole = role;
      } catch {
        // Best-effort
      }

      onEvent({
        type: 'activity',
        message: `Page requires ${renderMethod === 'browser' ? 'JavaScript' : 'HTTP only'}`,
        level: 'info',
        timestamp: Date.now(),
      });

      emitTreeSnapshot();

      onEvent({
        type: 'activity',
        message: `Phase 0 complete: ${allUrls.size} URLs discovered from primary page`,
        level: 'info',
        timestamp: Date.now(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Phase 0 failure is NOT fatal — seed URLs (Phase 1a) can still proceed
      onEvent({
        type: 'activity',
        message: `Phase 0 primary page failed (continuing with seeds): ${msg}`,
        level: 'warn',
        timestamp: Date.now(),
      });
    }

    // Start periodic tree snapshot timer after Phase 0
    snapshotInterval = setInterval(() => {
      // Size guard: skip timer snapshots for very large URL sets
      if (allUrls.size > MAX_TIMER_SNAPSHOT_URLS) return;
      // Skip if allUrls.size hasn't changed since last snapshot
      if (allUrls.size === lastSnapshotUrlCount) return;
      emitTreeSnapshot();
    }, TREE_SNAPSHOT_INTERVAL_MS);

    // Emit a snapshot right after Phase 0 completion
    emitTreeSnapshot();

    {
      const checkResult = checkStop();
      if (checkResult.stopped) {
        return buildResult();
      }
    }

    // ════════════════════════════════════════════════════════════
    // Phase 1a: Visit seed/sample URLs
    // ════════════════════════════════════════════════════════════
    onEvent({
      type: 'phase',
      phase: '1a',
      label: 'Visiting seed URLs',
      timestamp: Date.now(),
    });
    phasesRun++;

    const seedUrls = sampleUrls
      .map((u) => normalizeUrl(u))
      .filter((u) => isSameDomain(u, primaryUrl) && u !== normalizedPrimary);

    for (const seedUrl of seedUrls) {
      {
        const checkResult = checkStop();
        if (checkResult.stopped) break;
      }

      // Register seed if not already known
      if (!allUrls.has(seedUrl)) {
        allUrls.set(seedUrl, {
          url: seedUrl,
          foundOn: [],
          renderMethod: 'unknown',
          visited: false,
          status: 'discovered',
          childUrls: [],
          discoverySource: 'seed',
          discoveredAt: Date.now(),
        });
      }

      const record = allUrls.get(seedUrl);
      if (record && record.visited) continue;

      await visitAndTrack(page, seedUrl);
    }

    emitTreeSnapshot();

    onEvent({
      type: 'activity',
      message: `Phase 1a complete: visited ${seedUrls.length} seed URLs, ${allUrls.size} total discovered`,
      level: 'info',
      timestamp: Date.now(),
    });

    {
      const checkResult = checkStop();
      if (checkResult.stopped) {
        return buildResult();
      }
    }

    // ════════════════════════════════════════════════════════════
    // Phase 1b: Visit children of seeds (depth-1 expansion)
    // ════════════════════════════════════════════════════════════
    onEvent({
      type: 'phase',
      phase: '1b',
      label: 'Expanding seed children',
      timestamp: Date.now(),
    });
    phasesRun++;

    // Collect child URLs from visited seeds
    const seedChildUrls = new Set<string>();
    for (const seedUrl of [normalizedPrimary, ...seedUrls]) {
      const record = allUrls.get(seedUrl);
      if (record?.childUrls) {
        for (const childUrl of record.childUrls) {
          const childRecord = allUrls.get(childUrl);
          if (childRecord && !childRecord.visited) {
            seedChildUrls.add(childUrl);
          }
        }
      }
    }

    let seedBudget = 0;
    for (const childUrl of seedChildUrls) {
      if (seedBudget >= PHASE_1B_MAX_PER_SEED) {
        onEvent({
          type: 'activity',
          message: `Phase 1b budget reached for seed (${PHASE_1B_MAX_PER_SEED} URLs)`,
          level: 'info',
          timestamp: Date.now(),
        });
        break;
      }
      const checkResult = checkStop();
      if (checkResult.stopped) break;
      // Phase 1b has a visit queue concept — enqueue explore-branch URLs
      if (checkResult.exploreBranchUrls.length > 0) {
        for (const branchUrl of checkResult.exploreBranchUrls) {
          const normalizedBranch = normalizeUrl(branchUrl);
          if (!allUrls.has(normalizedBranch) && isSameDomain(branchUrl, primaryUrl)) {
            allUrls.set(normalizedBranch, {
              url: normalizedBranch,
              foundOn: [],
              renderMethod: 'unknown',
              visited: false,
              status: 'discovered',
              childUrls: [],
              discoverySource: 'user-command',
              discoveredAt: Date.now(),
            });
            seedChildUrls.add(normalizedBranch);
          }
        }
      }

      const record = allUrls.get(childUrl);
      if (record && record.visited) continue;

      await visitAndTrack(page, childUrl);
      seedBudget++;
    }

    emitTreeSnapshot();

    onEvent({
      type: 'activity',
      message: `Phase 1b complete: expanded ${seedChildUrls.size} seed children, ${allUrls.size} total discovered`,
      level: 'info',
      timestamp: Date.now(),
    });

    {
      const checkResult = checkStop();
      if (checkResult.stopped) {
        return buildResult();
      }
    }

    // ════════════════════════════════════════════════════════════
    // Phase 2: Climb breadcrumb ancestors + URL path truncation
    // ════════════════════════════════════════════════════════════
    onEvent({
      type: 'phase',
      phase: 2,
      label: 'Climbing breadcrumb ancestors',
      timestamp: Date.now(),
    });
    phasesRun++;

    // Collect ancestor URLs from breadcrumbs (shallowest first)
    const ancestorUrls = new Set<string>();
    for (const chain of breadcrumbChains) {
      // Breadcrumbs are ordered shallowest to deepest
      for (const crumb of chain.crumbs) {
        const normalized = normalizeUrl(crumb.href);
        if (isSameDomain(normalized, primaryUrl) && !allUrls.get(normalized)?.visited) {
          ancestorUrls.add(normalized);
        }
      }
    }

    // Fallback: URL path truncation for visited pages without breadcrumbs
    if (ancestorUrls.size === 0) {
      onEvent({
        type: 'activity',
        message: 'No breadcrumb ancestors found — falling back to URL path truncation',
        level: 'detail',
        timestamp: Date.now(),
      });

      for (const [url, record] of allUrls) {
        if (!record.visited) continue;
        try {
          const parsed = new URL(url);
          const segments = parsed.pathname.split('/').filter(Boolean);
          // Generate parent paths by removing segments from the end
          for (let i = segments.length - 1; i > 0; i--) {
            const parentPath = '/' + segments.slice(0, i).join('/');
            const parentUrl = normalizeUrl(parsed.origin + parentPath);
            if (
              isSameDomain(parentUrl, primaryUrl) &&
              !allUrls.get(parentUrl)?.visited &&
              parentUrl !== normalizedPrimary
            ) {
              ancestorUrls.add(parentUrl);
            }
          }
        } catch {
          // URL parsing failed — skip
        }
      }
    }

    // Sort ancestors by depth (shallowest first)
    const sortedAncestors = [...ancestorUrls].sort((a, b) => {
      return getPathDepth(a) - getPathDepth(b);
    });

    for (const ancestorUrl of sortedAncestors) {
      {
        const checkResult = checkStop();
        if (checkResult.stopped) break;
      }

      // Register if not known
      if (!allUrls.has(ancestorUrl)) {
        allUrls.set(ancestorUrl, {
          url: ancestorUrl,
          foundOn: [],
          renderMethod: 'unknown',
          visited: false,
          status: 'discovered',
          childUrls: [],
          discoverySource: 'breadcrumb-climb',
          discoveredAt: Date.now(),
        });
      }

      const record = allUrls.get(ancestorUrl);
      if (record && record.visited) continue;

      await visitAndTrack(page, ancestorUrl);
    }

    emitTreeSnapshot();

    onEvent({
      type: 'activity',
      message: `Phase 2 complete: climbed ${sortedAncestors.length} ancestors, ${allUrls.size} total discovered`,
      level: 'info',
      timestamp: Date.now(),
    });

    {
      const checkResult = checkStop();
      if (checkResult.stopped) {
        return buildResult();
      }
    }

    // ════════════════════════════════════════════════════════════
    // Phase 3: BFS depth-1 expansion with yield tracking
    // ════════════════════════════════════════════════════════════
    onEvent({
      type: 'phase',
      phase: 3,
      label: 'BFS depth-1 expansion with yield tracking',
      timestamp: Date.now(),
    });
    phasesRun++;

    const yieldTracker = createYieldTracker();

    // Collect unvisited URLs that are children of visited hubs
    // Sort by depth (shallowest first) for better cross-prefix coverage
    let bfsQueue: string[] = [];
    const bfsQueueSet = new Set<string>();

    for (const [, record] of allUrls) {
      if (!record.visited) continue;
      if (record.pageRole !== 'hub' && record.pageRole !== 'mixed') continue;

      for (const childUrl of record.childUrls) {
        const childRecord = allUrls.get(childUrl);
        if (childRecord && !childRecord.visited && !bfsQueueSet.has(childUrl)) {
          bfsQueue.push(childUrl);
          bfsQueueSet.add(childUrl);
        }
      }
    }

    // Also add any unvisited discovered URLs
    for (const [url, record] of allUrls) {
      if (!record.visited && !bfsQueueSet.has(url)) {
        bfsQueue.push(url);
        bfsQueueSet.add(url);
      }
    }

    // Sort by depth (shallowest first) to interleave prefixes
    bfsQueue.sort((a, b) => getPathDepth(a) - getPathDepth(b));

    // Deduplicate (already deduped via Set, but sort may have reordered)
    bfsQueue = [...new Set(bfsQueue)];

    let bfsIndex = 0;
    while (bfsIndex < bfsQueue.length) {
      const checkResult = checkStop();
      if (checkResult.stopped) break;
      // Phase 3 has an active visit queue — enqueue explore-branch URLs
      if (checkResult.exploreBranchUrls.length > 0) {
        for (const branchUrl of checkResult.exploreBranchUrls) {
          const normalizedBranch = normalizeUrl(branchUrl);
          if (!bfsQueueSet.has(normalizedBranch)) {
            bfsQueue.unshift(normalizedBranch);
            bfsQueueSet.add(normalizedBranch);
            if (!allUrls.has(normalizedBranch) && isSameDomain(branchUrl, primaryUrl)) {
              allUrls.set(normalizedBranch, {
                url: normalizedBranch,
                foundOn: [],
                renderMethod: 'unknown',
                visited: false,
                status: 'discovered',
                childUrls: [],
                discoverySource: 'user-command',
                discoveredAt: Date.now(),
              });
            }
          }
        }
        // Reset index since we unshifted
        bfsIndex = 0;
      }

      const url = bfsQueue[bfsIndex++];
      const record = allUrls.get(url);
      if (record && record.visited) continue;

      // Check depth limit
      const depth = getPathDepth(url);
      if (depth > maxDepth) continue;

      const result = await visitAndTrack(page, url);

      // Track yield
      trackPageVisit(yieldTracker, result.newLinks);
      const yieldDecision = shouldContinue(yieldTracker);

      if (!yieldDecision.continue) {
        stoppedBy = 'yield-limit';
        clearSnapshotTimer();
        onEvent({
          type: 'activity',
          message: `Yield tracking stopped: ${yieldDecision.reason}`,
          level: 'info',
          timestamp: Date.now(),
        });
        break;
      }

      // If this page is a hub, add its unvisited children to the queue
      if (result.role === 'hub' || result.role === 'mixed') {
        const pageRecord = allUrls.get(normalizeUrl(url));
        if (pageRecord) {
          for (const childUrl of pageRecord.childUrls) {
            const childRecord = allUrls.get(childUrl);
            if (childRecord && !childRecord.visited && !bfsQueueSet.has(childUrl)) {
              const childDepth = getPathDepth(childUrl);
              if (childDepth <= maxDepth) {
                bfsQueue.push(childUrl);
                bfsQueueSet.add(childUrl);
              }
            }
          }
        }
      }
    }

    clearSnapshotTimer();

    onEvent({
      type: 'activity',
      message: `Phase 3 complete: BFS visited ${visitedCount} pages total, ${allUrls.size} URLs discovered`,
      level: 'info',
      timestamp: Date.now(),
    });

    return buildResult();
  } catch (err: unknown) {
    clearSnapshotTimer();
    throw err;
  } finally {
    clearSnapshotTimer();

    // Detach API interceptor
    if (apiInterceptor) {
      await apiInterceptor.detach().catch(() => {
        // Detach failure is non-fatal — page may already be closed
      });
    }

    // Cleanup browser session
    await browserPool.closeSession(sessionId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent({
        type: 'activity',
        message: `Session cleanup failed: ${msg}`,
        level: 'warn',
        timestamp: Date.now(),
      });
    });
  }

  // ─── Result Builder ────────────────────────────────────────────
  function buildResult(): BfsDiscoveryResult {
    clearSnapshotTimer();
    const durationMs = Date.now() - startTime;
    const treeHierarchy = buildHybridTree(allUrls, primaryUrl, breadcrumbChains);

    onEvent({
      type: 'complete',
      totalUrls: allUrls.size,
      totalVisited: visitedCount,
      totalPhasesRun: phasesRun,
      durationMs,
      stoppedBy,
      tree: treeHierarchy,
      timestamp: Date.now(),
    });

    return {
      discoveryId,
      domain,
      discoveredUrls: allUrls,
      treeHierarchy,
      navStructure,
      breadcrumbChains,
      stats: {
        totalUrls: allUrls.size,
        totalVisited: visitedCount,
        totalPhases: phasesRun,
        durationMs,
        stoppedBy,
      },
    };
  }
}
