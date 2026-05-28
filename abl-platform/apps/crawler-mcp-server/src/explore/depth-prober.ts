/**
 * Depth Prober — Breadcrumb-Guided Multi-Page Exploration
 *
 * Algorithm (per design doc §24):
 *
 * **Phase 1: Visit Sample URL** (the one known-good URL)
 *   - Visit sample page, extract breadcrumbs (real hub URLs)
 *   - Extract all links from sample page
 *
 * **Phase 2: Climb Breadcrumbs** (shallowest first)
 *   - Visit each breadcrumb hub page
 *   - Discover sibling categories/items at each level
 *   - Adaptive: stop exploring a level when yield drops
 *
 * **Phase 3: Seed Exploration** (only if breadcrumbs didn't give hierarchy)
 *   - Diminishing returns: track new-links-per-click rate
 *   - Stop when marginal yield drops below threshold — no static caps
 *
 * **Phase 4: Fallback** (if no breadcrumbs found)
 *   - Try truncated parent paths from sample URL
 *   - Follow redirects to find real hub URLs
 *
 * **Phase 5: Projection** (continuous)
 *   - Links on visited hub pages = verified
 *   - Unvisited siblings from hub pages = projected
 *
 * Key design principles:
 *   - No static caps — auto mode derives limits dynamically
 *   - Sample URL is the anchor — it's guaranteed to work
 *   - Breadcrumbs are the navigation truth — contain real hub URLs
 *   - User transparency at every step — stream what's being discovered
 */

import type { Page } from 'playwright';
import type { BrowserPool } from '../browser/pool.js';
import {
  createYieldTracker,
  trackPageVisit,
  shouldContinue as yieldShouldContinue,
  pickSampleCount,
} from './yield-tracker.js';
import {
  exploreNavigation,
  navigateWithRetry,
  extractPageLinks,
  dismissOverlays,
  type NavigationExploreConfig,
  type ExploreResult,
  type DiscoveredLink,
  type ExploreProgress,
} from './navigation-explorer.js';
import { attachApiInterceptor, type ApiInterceptionResult } from './api-interceptor.js';
import { collectPageMetrics, classifyPage, type PageRole } from './page-classifier.js';
import { extractBreadcrumbs, type Breadcrumb } from './breadcrumb-extractor.js';
import {
  extractSiteNavigation,
  breadcrumbsToNavNodes,
  mergeNavTrees,
  type NavExtractionResult,
} from './nav-extractor.js';
import { getNextCommand, type Intervention } from './command-queue.js';
import { createLogger } from '../logger.js';

const log = createLogger('depth-prober');

/** Max URLs queued by a single explore-all command (design doc §6.6, I-6) */
const MAX_EXPLORE_ALL_URLS = 20;

/** Max entries in the allLinks map to prevent unbounded memory growth */
const MAX_ALL_LINKS = 50_000;

/** Max entries in mergeApiResults arrays */
const MAX_API_CALLS = 500;
const MAX_API_PATTERNS = 100;

/** Derive a readable label from a URL path — last segment, decoded */
function urlToLabel(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || path);
  } catch {
    return url;
  }
}

// ─── Types ──────────────────────────────────────────────────────────

export interface DepthProbeConfig {
  /** Seed URL to start exploration from */
  url: string;
  /** Max total pages the prober can visit (default 20) */
  maxPageVisits: number;
  /** Max depth levels to probe (default 5, 0 = auto) */
  maxDepth: number;
  /** Number of siblings to sample per group (default 2) */
  sampleSize: number;
  /** Whether depth probing is enabled (default true) */
  enabled: boolean;
  /** Per-page exploration config passed to exploreNavigation */
  exploreConfig: Omit<NavigationExploreConfig, 'url'>;
  /** Total timeout for the entire depth probe in ms (default 300000) */
  totalTimeout: number;
  /** Exploration ID — used for command queue lookups */
  exploreId?: string;
  /** URLs visited in prior iterations — pre-populate visitedUrls Set to skip re-visits */
  previouslyVisitedUrls?: string[];
}

export interface DepthProbeProgress {
  phase:
    | 'nav-extracting'
    | 'visiting-sample'
    | 'climbing-breadcrumbs'
    | 'seed-explore'
    | 'probing'
    | 'grouping'
    | 'projecting'
    | 'complete'
    | 'error';
  /** Seed exploration progress (forwarded from exploreNavigation) */
  seedProgress?: ExploreProgress;
  /** Breadcrumbs discovered from sample pages */
  breadcrumbs?: Breadcrumb[];
  /** Which breadcrumb extraction strategy worked */
  breadcrumbStrategy?: string;
  /** Number of sibling groups found */
  groupCount?: number;
  /** Current depth level being probed */
  currentDepth?: number;
  /** Current group being probed */
  currentGroup?: string;
  /** Sample URL currently being visited */
  currentSample?: string;
  /** Human-readable description of current action */
  currentAction?: string;
  /** Pages visited so far */
  pagesVisited: number;
  /** Total page budget */
  pageBudget: number;
  /** Total links discovered (verified) */
  verifiedLinks: number;
  /** Total URLs projected from templates */
  projectedUrls: number;
  /** New links found per page visit (for diminishing returns) */
  yieldPerPage?: number[];

  // ── Enriched fields (optional, backward-compatible) ──

  /** The URL currently being visited (full URL, not display string) */
  currentUrl?: string;
  /** Links discovered on the current page visit */
  discoveredOnPage?: Array<{ href: string; text: string; confidence: UrlConfidence }>;
  /** Page role classification of the current page */
  currentRole?: PageRole;
  /** Sibling nodes at the current level */
  siblings?: Array<{ href: string; text: string }>;
  /** Next URLs queued for exploration (top 3) */
  nextTargets?: Array<{ url: string; reason: string }>;
  /** Yield trend from YieldTracker */
  yieldTrend?: 'productive' | 'declining' | 'stalled';
  /** Navigation extraction result (emitted once during nav-extracting phase) */
  navResult?: NavExtractionResult;

  // ── Reason data for explainability (Phase 3.1) ──

  /** Structured data for auto-add reason display */
  autoAddReason?: { matchCount: number; pattern: string; verifiedCount: number };
  /** Structured data for yield reason display */
  yieldReason?: { trend: string; currentRate: number; peakRate: number };
  /** Structured data for last skip reason display */
  lastSkipReason?: { skipType: string; normalizedUrl: string };
  /** Present when resuming from prior iterations */
  resumedFrom?: { previousUrlCount: number; iterationCount: number };
}

/** Confidence tier for discovered URLs */
export type UrlConfidence = 'verified' | 'projected' | 'inferred';

export interface DepthProbeLink {
  href: string;
  text: string;
  /** How the URL was discovered */
  confidence: UrlConfidence;
  /** Depth level where this URL was found */
  depth: number;
  /** The group/category this URL belongs to */
  group?: string;
  /** Page role classification of the source page */
  sourceRole?: PageRole;
}

export interface SiblingGroup {
  /** Shared path prefix for this group */
  prefix: string;
  /** Human-readable label derived from prefix */
  label: string;
  /** All links in this group */
  links: DiscoveredLink[];
  /** Depth level where this group was discovered */
  depth: number;
}

export interface DepthProbeResult {
  /** All discovered links with confidence tiers */
  links: DepthProbeLink[];
  /** The seed page exploration result */
  seedResult: ExploreResult;
  /** Breadcrumbs discovered during probing */
  breadcrumbs?: Breadcrumb[];
  /** API interception results from seed + probed pages */
  apiInterception?: ApiInterceptionResult;
  /** Navigation extraction result (header/footer/mega-menu/sitemap-page) */
  navExtraction?: NavExtractionResult;
  /** Statistics */
  stats: {
    pagesVisited: number;
    maxDepthReached: number;
    verifiedLinks: number;
    projectedLinks: number;
    totalLinks: number;
    groupsFound: number;
    groupsProbed: number;
    durationMs: number;
    /** Classification results per visited page */
    pageRoles: Array<{ url: string; role: PageRole; depth: number }>;
  };
}

export type DepthProbeProgressCallback = (progress: DepthProbeProgress) => void;
export type StopSignal = () => boolean;

// ─── Constants ──────────────────────────────────────────────────────

/** Per-page navigation timeout (ms) */
const PAGE_NAV_TIMEOUT = 15_000;

/** Minimum links in a sibling group to be worth probing */
const MIN_GROUP_SIZE = 3;

/**
 * Diminishing returns threshold: stop seed exploration when
 * the last N clicks each yield fewer than this many new links.
 * This replaces the old static click cap (SEED_FAST_SCAN_MAX_EXPANSIONS).
 */
const DIMINISHING_RETURNS_WINDOW = 5;
const DIMINISHING_RETURNS_MIN_YIELD = 1;

/** Minimum visited siblings needed at a depth to enable projection */
const MIN_VISITED_FOR_PROJECTION = 1;

/** Maximum projected URLs to generate per unvisited hub (prevent blow-up) */
const MAX_PROJECTED_PER_HUB = 200;

// ─── Hub Yield Tracking ──────────────────────────────────────────────

/** Stats for a visited hub page — used for projection */
interface HubYield {
  /** URL of the hub page */
  url: string;
  /** Breadcrumb depth where this hub sits */
  depth: number;
  /** How many same-site links the hub page contained */
  linkCount: number;
  /** The links found on this hub page */
  links: DiscoveredLink[];
  /** Page role classification */
  role: PageRole;
  /** Which breadcrumb group this hub belongs to (parent breadcrumb text) */
  parentGroup?: string;
}

// ─── Main Entry Point ───────────────────────────────────────────────

/**
 * Run breadcrumb-guided depth probing starting from a seed URL.
 *
 * If sample URLs are provided, visits sample pages first to extract
 * breadcrumbs, then climbs the breadcrumb chain to discover hub pages.
 * Falls back to seed exploration with diminishing returns detection
 * when no breadcrumbs are found.
 */
export async function probeDepth(
  browserPool: BrowserPool,
  config: DepthProbeConfig,
  onProgress?: DepthProbeProgressCallback,
  shouldStop?: StopSignal,
): Promise<DepthProbeResult> {
  const startTime = Date.now();
  const allLinks = new Map<string, DepthProbeLink>();
  let pagesVisited = 0;
  const pageRoles: Array<{ url: string; role: PageRole; depth: number }> = [];
  let maxDepthReached = 0;
  let groupsFound = 0;
  let groupsProbed = 0;
  const visitedUrls = new Set<string>(config.previouslyVisitedUrls ?? []);
  const yieldPerPage: number[] = [];
  let allBreadcrumbs: Breadcrumb[] = [];
  const breadcrumbChains: Breadcrumb[][] = [];
  const yieldTracker = createYieldTracker();

  // Log resume context if resuming from prior iterations
  if (config.previouslyVisitedUrls && config.previouslyVisitedUrls.length > 0) {
    log.info('Resumed with previously visited URLs', {
      count: config.previouslyVisitedUrls.length,
    });
  }
  /** Track per-hub yields for Phase 5 projection */
  const hubYields: HubYield[] = [];

  // Aggregate API interception results
  const aggregatedApiResult: ApiInterceptionResult = {
    calls: [],
    patterns: [],
    totalIntercepted: 0,
    structuredCount: 0,
  };

  const progress: DepthProbeProgress = {
    phase: 'visiting-sample',
    pagesVisited: 0,
    pageBudget: config.maxPageVisits,
    verifiedLinks: 0,
    projectedUrls: 0,
    yieldPerPage: [],
    resumedFrom:
      config.previouslyVisitedUrls && config.previouslyVisitedUrls.length > 0
        ? {
            previousUrlCount: config.previouslyVisitedUrls.length,
            iterationCount: 0,
          }
        : undefined,
  };

  const isTimedOut = () => Date.now() - startTime > config.totalTimeout;
  const isStopped = () => (shouldStop?.() ?? false) || isTimedOut();
  const hasBudget = () => pagesVisited < config.maxPageVisits && !isStopped();

  const sampleUrls = config.exploreConfig.sampleUrls ?? [];
  const hasSamples = sampleUrls.length > 0;
  const seedOrigin = new URL(config.url).origin;

  const addLinks = (
    links: DiscoveredLink[],
    depth: number,
    confidence: UrlConfidence,
    group?: string,
  ) => {
    let newCount = 0;
    for (const link of links) {
      const normalized = normalizeUrl(link.href);
      if (!allLinks.has(normalized)) {
        if (allLinks.size >= MAX_ALL_LINKS) break;
        allLinks.set(normalized, {
          href: link.href,
          text: link.text,
          confidence,
          depth,
          group,
        });
        newCount++;
      } else {
        // Track last duplicate skip for explainability
        progress.lastSkipReason = { skipType: 'duplicate', normalizedUrl: normalized };
      }
    }
    return newCount;
  };

  const emitProgress = (enrichment?: {
    currentUrl?: string;
    discoveredOnPage?: Array<{ href: string; text: string; confidence: UrlConfidence }>;
    currentRole?: PageRole;
    siblings?: Array<{ href: string; text: string }>;
    nextTargets?: Array<{ url: string; reason: string }>;
  }) => {
    progress.pagesVisited = pagesVisited;
    progress.verifiedLinks = countByConfidence(allLinks, 'verified');
    progress.projectedUrls = allLinks.size - progress.verifiedLinks;
    progress.yieldPerPage = yieldPerPage;

    // Enriched fields
    if (enrichment) {
      progress.currentUrl = enrichment.currentUrl;
      progress.discoveredOnPage = enrichment.discoveredOnPage;
      progress.currentRole = enrichment.currentRole;
      progress.siblings = enrichment.siblings;
      progress.nextTargets = enrichment.nextTargets;
    }

    // Yield trend from tracker
    const yieldDecision = yieldShouldContinue(yieldTracker);
    progress.yieldTrend = yieldDecision.trend;

    // Populate yield reason data for explainability
    if (yieldTracker.yieldPerPage.length > 0) {
      const lastRate = yieldTracker.yieldPerPage[yieldTracker.yieldPerPage.length - 1];
      progress.yieldReason = {
        trend: yieldDecision.trend,
        currentRate: lastRate,
        peakRate: yieldTracker.peakYield,
      };
    }

    onProgress?.(progress);
  };

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 0: Nav Extraction — extract site navigation skeleton
  // ═══════════════════════════════════════════════════════════════════

  let navExtractionResult: NavExtractionResult | undefined;
  if (!isStopped()) {
    progress.phase = 'nav-extracting';
    progress.currentAction = 'Extracting site navigation structure';
    emitProgress();

    const navSessionId = `nav-extract-${Date.now()}`;
    try {
      const page = await browserPool.getPage(navSessionId);
      try {
        await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        navExtractionResult = await extractSiteNavigation(page, config.url);

        progress.navResult = navExtractionResult;
        emitProgress();
      } finally {
        await browserPool.closeSession(navSessionId).catch((closeErr: unknown) => {
          const closeMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
          log.warn('Failed to close nav session', { error: closeMsg });
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Non-fatal — nav extraction failure shouldn't block depth probing
      log.warn('Nav extraction failed (non-fatal)', { error: message });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Command queue helper — check between page visits
  // ═══════════════════════════════════════════════════════════════════

  const checkCommandQueue = (): Intervention | undefined => {
    if (!config.exploreId) return undefined;
    return getNextCommand(config.exploreId);
  };

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 1: Visit sample URLs → extract breadcrumbs
  // ═══════════════════════════════════════════════════════════════════

  let seedResult: ExploreResult | undefined;

  if (hasSamples && hasBudget()) {
    progress.phase = 'visiting-sample';

    for (const sampleUrl of sampleUrls) {
      if (!hasBudget()) break;

      // Check for stop during sample phase
      const sampleCmd = checkCommandQueue();
      if (sampleCmd?.type === 'stop') {
        log.info('Stop command received during sample phase', { exploreId: config.exploreId });
        break;
      }

      let resolvedUrl: string;
      try {
        resolvedUrl = new URL(sampleUrl, seedOrigin).toString();
      } catch {
        continue;
      }
      if (new URL(resolvedUrl).origin !== seedOrigin) continue;

      const normalized = normalizeUrl(resolvedUrl);
      if (visitedUrls.has(normalized)) continue;

      progress.currentSample = resolvedUrl;
      progress.currentAction = `Visiting sample page to extract breadcrumbs`;
      emitProgress();

      const result = await visitPageWithBreadcrumbs(
        browserPool,
        resolvedUrl,
        seedOrigin,
        visitedUrls,
        pageRoles,
        0,
        aggregatedApiResult,
      );

      if (result !== null) {
        pagesVisited++;
        const newLinks = addLinks(result.links, 0, 'verified');
        yieldPerPage.push(newLinks);
        trackPageVisit(yieldTracker, newLinks);

        // Merge breadcrumbs from all samples
        if (result.breadcrumbs.crumbs.length > 0) {
          breadcrumbChains.push(result.breadcrumbs.crumbs);
          const existingHrefs = new Set(allBreadcrumbs.map((b) => b.href));
          for (const crumb of result.breadcrumbs.crumbs) {
            if (!existingHrefs.has(crumb.href)) {
              allBreadcrumbs.push(crumb);
            }
          }
          progress.breadcrumbs = allBreadcrumbs;
          progress.breadcrumbStrategy = result.breadcrumbs.strategy;
        }

        emitProgress({
          currentUrl: resolvedUrl,
          discoveredOnPage: result.links.map((l) => ({
            href: l.href,
            text: l.text,
            confidence: 'verified' as const,
          })),
          currentRole: result.role,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 2: Climb breadcrumbs (shallowest first)
  // ═══════════════════════════════════════════════════════════════════

  if (allBreadcrumbs.length > 0 && hasBudget()) {
    progress.phase = 'climbing-breadcrumbs';

    // Dynamic queue — shallowest first, new crumbs pushed and re-sorted
    const pendingCrumbs: Breadcrumb[] = [...allBreadcrumbs].sort((a, b) => a.depth - b.depth);
    const skippedUrls = new Set<string>();
    let shouldStop = false;

    while (pendingCrumbs.length > 0 && !shouldStop) {
      const crumb = pendingCrumbs.shift()!;

      if (!hasBudget()) break;
      if (config.maxDepth > 0 && crumb.depth > config.maxDepth) break;

      // Drain all pending commands before each page visit
      let cmd: Intervention | undefined;
      let skipCurrentCrumb = false;
      while (!shouldStop && (cmd = checkCommandQueue()) !== undefined) {
        log.info('Processing command', {
          exploreId: config.exploreId,
          type: cmd.type,
          url: cmd.payload?.url,
        });

        switch (cmd.type) {
          case 'stop':
            shouldStop = true;
            break;

          case 'skip-branch':
            if (cmd.payload?.url) {
              skippedUrls.add(normalizeUrl(cmd.payload.url));
              if (normalizeUrl(cmd.payload.url) === normalizeUrl(crumb.href)) {
                skipCurrentCrumb = true;
              }
            }
            break;

          case 'explore-branch':
            if (cmd.payload?.url) {
              pendingCrumbs.unshift({
                href: cmd.payload.url,
                text: urlToLabel(cmd.payload.url),
                depth: crumb.depth,
              });
            }
            break;

          case 'add-sample':
            if (cmd.payload?.url) {
              pendingCrumbs.push({
                href: cmd.payload.url,
                text: urlToLabel(cmd.payload.url),
                depth: 0,
              });
            }
            break;

          case 'explore-all':
            if (cmd.payload?.urls) {
              const urls = cmd.payload.urls
                .filter((u) => !visitedUrls.has(normalizeUrl(u)))
                .slice(0, MAX_EXPLORE_ALL_URLS);
              for (const url of urls) {
                pendingCrumbs.unshift({
                  href: url,
                  text: urlToLabel(url),
                  depth: crumb.depth,
                });
              }
              log.info('explore-all queued URLs', {
                exploreId: config.exploreId,
                queued: urls.length,
                total: cmd.payload.urls.length,
              });
            }
            break;

          case 'undo-skip':
            if (cmd.payload?.url) {
              skippedUrls.delete(normalizeUrl(cmd.payload.url));
              pendingCrumbs.push({
                href: cmd.payload.url,
                text: urlToLabel(cmd.payload.url),
                depth: crumb.depth,
              });
            }
            break;
        }
      }
      if (shouldStop) break;
      if (skipCurrentCrumb) continue;

      // Check skipped URLs (with normalized comparison)
      if (skippedUrls.has(normalizeUrl(crumb.href))) {
        progress.lastSkipReason = {
          skipType: 'user-skipped',
          normalizedUrl: normalizeUrl(crumb.href),
        };
        continue;
      }

      const normalized = normalizeUrl(crumb.href);
      if (visitedUrls.has(normalized)) {
        progress.lastSkipReason = { skipType: 'visited', normalizedUrl: normalized };
        continue;
      }

      // Skip the seed URL if it appears in breadcrumbs
      if (normalizeUrl(config.url) === normalized) continue;

      progress.currentAction = `Visiting breadcrumb hub: ${crumb.text}`;
      progress.currentSample = crumb.href;
      progress.currentDepth = crumb.depth;
      progress.currentGroup = crumb.text;
      emitProgress();

      const hubResult = await visitPageWithBreadcrumbs(
        browserPool,
        crumb.href,
        seedOrigin,
        visitedUrls,
        pageRoles,
        crumb.depth,
        aggregatedApiResult,
      );

      if (hubResult !== null) {
        pagesVisited++;
        groupsProbed++;
        if (crumb.depth > maxDepthReached) maxDepthReached = crumb.depth;

        const newLinks = addLinks(hubResult.links, crumb.depth, 'verified', crumb.text);
        yieldPerPage.push(newLinks);
        trackPageVisit(yieldTracker, newLinks);

        // Record hub yield for projection
        hubYields.push({
          url: crumb.href,
          depth: crumb.depth,
          linkCount: hubResult.links.length,
          links: hubResult.links,
          role: hubResult.role,
          parentGroup: crumb.text,
        });

        // Merge any new breadcrumbs found on hub pages
        if (hubResult.breadcrumbs.crumbs.length > 0) {
          breadcrumbChains.push(hubResult.breadcrumbs.crumbs);
          const existingHrefs = new Set(allBreadcrumbs.map((b) => b.href));
          for (const newCrumb of hubResult.breadcrumbs.crumbs) {
            if (!existingHrefs.has(newCrumb.href)) {
              allBreadcrumbs.push(newCrumb);
              pendingCrumbs.push(newCrumb);
            }
          }
          // Re-sort after adding new crumbs
          pendingCrumbs.sort((a, b) => a.depth - b.depth);
          progress.breadcrumbs = allBreadcrumbs;
        }

        emitProgress({
          currentUrl: crumb.href,
          discoveredOnPage: hubResult.links.map((l) => ({
            href: l.href,
            text: l.text,
            confidence: 'verified' as const,
          })),
          currentRole: hubResult.role,
        });

        // Hub pages often have sibling links — visit a few to discover more
        if (hubResult.role === 'hub' && hasBudget()) {
          const hubSiblings = hubResult.links.filter((l) => {
            const norm = normalizeUrl(l.href);
            return !visitedUrls.has(norm) && !allLinks.has(norm);
          });

          // Pick diverse samples from hub's links for deeper exploration
          const adaptiveSampleCount = pickSampleCount({ linkCount: hubSiblings.length });
          const samplesToVisit = pickDiverseSamples(
            hubSiblings,
            Math.max(adaptiveSampleCount, config.sampleSize),
            visitedUrls,
          );

          for (const sample of samplesToVisit) {
            if (!hasBudget()) break;

            progress.currentAction = `Exploring sibling from ${crumb.text}: ${sample.text}`;
            progress.currentSample = sample.href;
            emitProgress();

            const sibResult = await visitPageWithBreadcrumbs(
              browserPool,
              sample.href,
              seedOrigin,
              visitedUrls,
              pageRoles,
              crumb.depth + 1,
              aggregatedApiResult,
            );

            if (sibResult !== null) {
              pagesVisited++;
              if (crumb.depth + 1 > maxDepthReached) maxDepthReached = crumb.depth + 1;

              const newSibLinks = addLinks(
                sibResult.links,
                crumb.depth + 1,
                'verified',
                crumb.text,
              );
              yieldPerPage.push(newSibLinks);
              trackPageVisit(yieldTracker, newSibLinks);

              // Record sibling hub yield for projection
              hubYields.push({
                url: sample.href,
                depth: crumb.depth + 1,
                linkCount: sibResult.links.length,
                links: sibResult.links,
                role: sibResult.role,
                parentGroup: crumb.text,
              });

              emitProgress({
                currentUrl: sample.href,
                discoveredOnPage: sibResult.links.map((l) => ({
                  href: l.href,
                  text: l.text,
                  confidence: 'verified' as const,
                })),
                currentRole: sibResult.role,
                siblings: hubResult.links
                  .filter((l) => normalizeUrl(l.href) !== normalizeUrl(sample.href))
                  .slice(0, 10)
                  .map((l) => ({ href: l.href, text: l.text })),
              });
            }
          }
        }
      }
    }

    // Project: links found on visited hub pages that we didn't visit directly
    const hubLinksForProjection = [...allLinks.values()].filter(
      (l) => l.confidence === 'verified' && !visitedUrls.has(normalizeUrl(l.href)),
    );
    groupsFound = new Set(hubLinksForProjection.map((l) => l.group).filter(Boolean)).size;
  }

  // ─── Merge breadcrumb hierarchy into nav extraction result ─────────
  if (breadcrumbChains.length > 0 && navExtractionResult) {
    const breadcrumbNavNodes = breadcrumbsToNavNodes(breadcrumbChains, new URL(config.url).origin);
    if (breadcrumbNavNodes.length > 0) {
      mergeNavTrees(navExtractionResult.nodes, breadcrumbNavNodes);
      // Re-emit updated nav result so frontend gets the enriched tree
      progress.navResult = navExtractionResult;
      emitProgress();
      log.info('Merged breadcrumb hierarchy into nav tree', {
        breadcrumbNodes: breadcrumbNavNodes.length,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 3: Seed exploration (with diminishing returns detection)
  // Only if breadcrumbs didn't give us hierarchy, or no samples
  // ═══════════════════════════════════════════════════════════════════

  const breadcrumbsGaveHierarchy = allBreadcrumbs.length >= 2;

  if (!breadcrumbsGaveHierarchy && hasBudget()) {
    progress.phase = 'seed-explore';
    progress.currentAction = 'Exploring seed page for navigation links';
    emitProgress();

    const seedSessionId = `depth-probe-seed-${Date.now()}`;

    try {
      const seedPage = await browserPool.getPage(seedSessionId);
      const parsedUrl = new URL(config.url);
      const seedInterceptor = await attachApiInterceptor(seedPage, parsedUrl.hostname);

      // Track click yield for diminishing returns detection
      let recentClickYields: number[] = [];

      const seedExploreConfig = {
        ...config.exploreConfig,
        url: config.url,
      };

      seedResult = await exploreNavigation(
        seedPage,
        seedExploreConfig,
        (seedProgress) => {
          progress.seedProgress = seedProgress;

          // Track yield for diminishing returns
          if (seedProgress.expandablesClicked > 0) {
            const currentYield =
              seedProgress.linksFound / Math.max(1, seedProgress.expandablesClicked);
            recentClickYields.push(currentYield);
            // Keep only the last window
            if (recentClickYields.length > DIMINISHING_RETURNS_WINDOW) {
              recentClickYields = recentClickYields.slice(-DIMINISHING_RETURNS_WINDOW);
            }
          }

          emitProgress();
        },
        () => {
          if (isStopped()) return true;

          // Diminishing returns detection: if last N clicks each produced
          // fewer than threshold new links, stop early
          if (recentClickYields.length >= DIMINISHING_RETURNS_WINDOW) {
            const allBelowThreshold = recentClickYields
              .slice(-DIMINISHING_RETURNS_WINDOW)
              .every((y) => y < DIMINISHING_RETURNS_MIN_YIELD);
            if (allBelowThreshold) return true;
          }

          return false;
        },
      );

      // Collect API results from seed
      const seedApiResult = seedInterceptor.getResult();
      await seedInterceptor.detach();
      mergeApiResults(aggregatedApiResult, seedApiResult);

      pagesVisited++;
      visitedUrls.add(normalizeUrl(config.url));

      const newLinks = addLinks(seedResult.links, 0, 'verified');
      yieldPerPage.push(newLinks);
      trackPageVisit(yieldTracker, newLinks);

      // Also extract breadcrumbs from seed page (may help with fallback)
      const seedBreadcrumbs = await extractBreadcrumbs(seedPage);
      if (seedBreadcrumbs.crumbs.length > 0 && allBreadcrumbs.length === 0) {
        allBreadcrumbs = seedBreadcrumbs.crumbs;
        progress.breadcrumbs = allBreadcrumbs;
        progress.breadcrumbStrategy = seedBreadcrumbs.strategy;
      }

      emitProgress({
        currentUrl: config.url,
        discoveredOnPage: seedResult.links.map((l) => ({
          href: l.href,
          text: l.text,
          confidence: 'verified' as const,
        })),
      });
    } finally {
      await browserPool.closeSession(seedSessionId).catch((closeErr: unknown) => {
        log.warn('Seed session close failed', {
          sessionId: seedSessionId,
          error: closeErr instanceof Error ? closeErr.message : String(closeErr),
        });
      });
    }
  }

  // Build a minimal seedResult if we didn't do seed exploration
  if (!seedResult) {
    seedResult = {
      links: [...allLinks.values()].map((l) => ({ href: l.href, text: l.text })),
      tree: [],
      stats: { totalClicks: 0, totalLinks: allLinks.size, totalExpandables: 0, durationMs: 0 },
    };
  }

  // If depth probing is disabled, return what we have
  if (!config.enabled) {
    progress.phase = 'complete';
    emitProgress();
    return buildResult(
      allLinks,
      seedResult,
      aggregatedApiResult,
      allBreadcrumbs,
      {
        pagesVisited,
        maxDepthReached: 0,
        groupsFound: 0,
        groupsProbed: 0,
        pageRoles,
        durationMs: Date.now() - startTime,
      },
      navExtractionResult,
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 4: Fallback — truncated paths with redirect following
  // Only if breadcrumbs produced nothing and we have sample URLs
  // ═══════════════════════════════════════════════════════════════════

  if (!breadcrumbsGaveHierarchy && hasSamples && hasBudget()) {
    progress.phase = 'probing';
    progress.currentAction = 'Trying intermediate paths from sample URLs (fallback)';
    emitProgress();

    const fallbackTargets = buildFallbackTargets(sampleUrls, config.url, seedOrigin);

    for (const target of fallbackTargets) {
      if (!hasBudget()) break;

      const normalized = normalizeUrl(target.url);
      if (visitedUrls.has(normalized)) continue;

      progress.currentSample = target.url;
      progress.currentDepth = target.depth;
      progress.currentGroup = target.label;
      progress.currentAction = `Trying fallback path: ${target.label}`;
      emitProgress();

      // Use visitAndExtractLinks which follows redirects via navigateWithRetry
      const pageLinks = await visitAndExtractLinks(
        browserPool,
        target.url,
        seedOrigin,
        visitedUrls,
        pageRoles,
        target.depth,
        aggregatedApiResult,
      );

      if (pageLinks !== null) {
        pagesVisited++;
        groupsProbed++;

        if (target.depth > maxDepthReached) maxDepthReached = target.depth;

        const newLinks = addLinks(pageLinks, target.depth, 'verified', target.label);
        yieldPerPage.push(newLinks);
        trackPageVisit(yieldTracker, newLinks);
        emitProgress({ currentUrl: target.url });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 4b: Exploratory strategy (no samples at all)
  // Group seed page links and sample from each group
  // ═══════════════════════════════════════════════════════════════════

  if (!hasSamples && !breadcrumbsGaveHierarchy && hasBudget()) {
    progress.phase = 'grouping';

    const sameSiteLinks = seedResult.links.filter((l) => {
      try {
        return new URL(l.href).origin === seedOrigin;
      } catch {
        return false;
      }
    });

    const groups = groupSiblings(sameSiteLinks, config.url, 0);
    groupsFound = groups.length;
    progress.groupCount = groupsFound;
    emitProgress();

    const sortedGroups = [...groups].sort((a, b) => b.links.length - a.links.length);

    for (const group of sortedGroups) {
      if (!hasBudget()) break;
      if (group.links.length < MIN_GROUP_SIZE) continue;

      progress.phase = 'probing';
      progress.currentDepth = 1;
      progress.currentGroup = group.label;
      progress.currentAction = `Exploring group: ${group.label} (${group.links.length} links)`;
      // Populate auto-add reason data for explainability
      progress.autoAddReason = {
        matchCount: group.links.length,
        pattern: group.prefix,
        verifiedCount: group.links.filter((l) => visitedUrls.has(normalizeUrl(l.href))).length,
      };
      emitProgress();

      const adaptiveGroupSampleCount = pickSampleCount({ linkCount: group.links.length });
      const samples = pickDiverseSamples(
        group.links,
        Math.max(adaptiveGroupSampleCount, config.sampleSize),
        visitedUrls,
      );
      if (samples.length === 0) continue;

      groupsProbed++;

      for (const sample of samples) {
        if (!hasBudget()) break;

        const sampleUrl = sample.href;
        const normalized = normalizeUrl(sampleUrl);
        if (visitedUrls.has(normalized)) continue;

        progress.currentSample = sampleUrl;
        emitProgress();

        const pageLinks = await visitAndExtractLinks(
          browserPool,
          sampleUrl,
          seedOrigin,
          visitedUrls,
          pageRoles,
          1,
          aggregatedApiResult,
        );

        if (pageLinks !== null) {
          pagesVisited++;
          maxDepthReached = Math.max(maxDepthReached, 1);

          const newLinks = addLinks(pageLinks, 1, 'verified', group.label);
          yieldPerPage.push(newLinks);
          trackPageVisit(yieldTracker, newLinks);
          emitProgress({ currentUrl: sampleUrl });
        }
      }

      // Project unvisited siblings from this group
      for (const sibling of group.links) {
        const sibNorm = normalizeUrl(sibling.href);
        if (!allLinks.has(sibNorm)) {
          allLinks.set(sibNorm, {
            href: sibling.href,
            text: sibling.text,
            confidence: 'projected',
            depth: 0,
            group: group.label,
          });
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 5: Projection — extrapolate from visited hubs to unvisited siblings
  // ═══════════════════════════════════════════════════════════════════

  progress.phase = 'projecting';
  progress.currentAction = 'Projecting URL patterns from discovered hubs';
  emitProgress();

  const projectedCount = projectFromHubYields(hubYields, allLinks, visitedUrls, seedOrigin);

  if (projectedCount > 0) {
    // Update groups count to include projection sources
    const projectedGroups = new Set(
      [...allLinks.values()]
        .filter((l) => l.confidence === 'projected')
        .map((l) => l.group)
        .filter(Boolean),
    );
    groupsFound = Math.max(groupsFound, projectedGroups.size);
  }

  emitProgress();

  // ─── Final: Collect results ─────────────────────────────────
  progress.phase = 'complete';
  progress.currentAction = undefined;
  emitProgress();

  return buildResult(
    allLinks,
    seedResult,
    aggregatedApiResult,
    allBreadcrumbs,
    {
      pagesVisited,
      maxDepthReached,
      groupsFound,
      groupsProbed,
      pageRoles,
      durationMs: Date.now() - startTime,
    },
    navExtractionResult,
  );
}

// ─── Page Visit with Breadcrumb Extraction ──────────────────────────

interface PageVisitResult {
  links: DiscoveredLink[];
  breadcrumbs: { crumbs: Breadcrumb[]; strategy: string };
  role: PageRole;
}

/**
 * Visit a page, extract links AND breadcrumbs, classify the page.
 * This is the primary visit function for the breadcrumb-climb strategy.
 */
async function visitPageWithBreadcrumbs(
  browserPool: BrowserPool,
  url: string,
  origin: string,
  visitedUrls: Set<string>,
  pageRoles: Array<{ url: string; role: PageRole; depth: number }>,
  depth: number,
  aggregatedApiResult: ApiInterceptionResult,
): Promise<PageVisitResult | null> {
  const sessionId = `depth-probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const normalized = normalizeUrl(url);

  try {
    const page = await browserPool.getPage(sessionId);
    const hostname = new URL(url).hostname;
    const interceptor = await attachApiInterceptor(page, hostname);

    const navProgress: ExploreProgress = {
      phase: 'rendering',
      expandablesFound: 0,
      expandablesClicked: 0,
      linksFound: 0,
      depth: 0,
      tree: [],
    };

    await navigateWithRetry(page, url, PAGE_NAV_TIMEOUT, navProgress);
    await dismissOverlays(page);
    visitedUrls.add(normalized);

    // Extract breadcrumbs FIRST — this is the key new capability
    const breadcrumbResult = await extractBreadcrumbs(page);

    // Classify the page
    const metrics = await collectPageMetrics(page);
    const role = classifyPage(metrics);
    pageRoles.push({ url, role, depth });

    // Extract links
    const pageLinks = await extractPageLinks(page);

    // Collect API interception
    const apiResult = interceptor.getResult();
    await interceptor.detach();
    mergeApiResults(aggregatedApiResult, apiResult);

    // Filter to same-site links
    const sameSiteLinks = pageLinks.filter((l) => {
      try {
        return new URL(l.href).origin === origin;
      } catch {
        return false;
      }
    });

    return {
      links: sameSiteLinks,
      breadcrumbs: breadcrumbResult,
      role,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Use structured approach — this will be caught by the logger in production
    log.warn('visitPageWithBreadcrumbs failed', { url, error: message });
    return null;
  } finally {
    await browserPool.closeSession(sessionId).catch((closeErr: unknown) => {
      log.warn('Session close failed', {
        sessionId,
        error: closeErr instanceof Error ? closeErr.message : String(closeErr),
      });
    });
  }
}

// ─── Page Visit Helper (without breadcrumbs — for fallback) ─────────

/**
 * Visit a URL, extract same-site links, classify the page, and collect API patterns.
 * Returns null if the page fails to load.
 */
async function visitAndExtractLinks(
  browserPool: BrowserPool,
  url: string,
  origin: string,
  visitedUrls: Set<string>,
  pageRoles: Array<{ url: string; role: PageRole; depth: number }>,
  depth: number,
  aggregatedApiResult: ApiInterceptionResult,
): Promise<DiscoveredLink[] | null> {
  const sessionId = `depth-probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const normalized = normalizeUrl(url);

  try {
    const page = await browserPool.getPage(sessionId);
    const hostname = new URL(url).hostname;
    const interceptor = await attachApiInterceptor(page, hostname);

    const navProgress: ExploreProgress = {
      phase: 'rendering',
      expandablesFound: 0,
      expandablesClicked: 0,
      linksFound: 0,
      depth: 0,
      tree: [],
    };

    await navigateWithRetry(page, url, PAGE_NAV_TIMEOUT, navProgress);
    await dismissOverlays(page);
    visitedUrls.add(normalized);

    // Classify the page
    const metrics = await collectPageMetrics(page);
    const role = classifyPage(metrics);
    pageRoles.push({ url, role, depth });

    // Extract links
    const pageLinks = await extractPageLinks(page);

    // Collect API interception
    const apiResult = interceptor.getResult();
    await interceptor.detach();
    mergeApiResults(aggregatedApiResult, apiResult);

    // Filter to same-site links
    return pageLinks.filter((l) => {
      try {
        return new URL(l.href).origin === origin;
      } catch {
        return false;
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('visitAndExtractLinks failed', { url, error: message });
    return null;
  } finally {
    await browserPool.closeSession(sessionId).catch((closeErr: unknown) => {
      log.warn('Session close failed', {
        sessionId,
        error: closeErr instanceof Error ? closeErr.message : String(closeErr),
      });
    });
  }
}

// ─── Fallback Probe Targets ─────────────────────────────────────────

interface ProbeTarget {
  /** URL to visit */
  url: string;
  /** Human-readable label */
  label: string;
  /** Depth level in the hierarchy */
  depth: number;
}

/**
 * Build fallback probe targets by truncating sample URL paths.
 * Used only when breadcrumb extraction fails.
 *
 * NOTE: These truncated paths may 404 (e.g., Epson uses /sh/s1 suffixes).
 * visitAndExtractLinks handles 404s gracefully by returning null.
 */
function buildFallbackTargets(
  sampleUrls: string[],
  seedUrl: string,
  seedOrigin: string,
): ProbeTarget[] {
  const seedSegments = new URL(seedUrl).pathname.split('/').filter(Boolean);
  const targets = new Map<string, ProbeTarget>();

  for (const sampleUrl of sampleUrls) {
    let parsed: URL;
    try {
      parsed = new URL(sampleUrl, seedOrigin);
    } catch {
      continue;
    }
    if (parsed.origin !== seedOrigin) continue;

    const segments = parsed.pathname.split('/').filter(Boolean);

    // Find common prefix with seed URL
    let commonLen = 0;
    for (let i = 0; i < Math.min(seedSegments.length, segments.length); i++) {
      if (segments[i] === seedSegments[i]) commonLen++;
      else break;
    }

    // Generate intermediate paths beyond the common prefix
    for (let i = commonLen + 1; i <= segments.length; i++) {
      const intermediatePath = '/' + segments.slice(0, i).join('/');
      const intermediateUrl = `${seedOrigin}${intermediatePath}`;
      const depth = i - commonLen;
      const label = segments[i - 1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

      if (!targets.has(intermediateUrl)) {
        targets.set(intermediateUrl, { url: intermediateUrl, label, depth });
      }
    }
  }

  // Sort by depth (shallowest first) — visit hubs before leaves
  return [...targets.values()].sort((a, b) => a.depth - b.depth);
}

// ─── Sibling Grouping (exploratory strategy) ─────────────────────────

/**
 * Group links by shared path prefix with the parent URL.
 * Used only when no sample URLs are provided.
 */
function groupSiblings(links: DiscoveredLink[], parentUrl: string, depth: number): SiblingGroup[] {
  const parentOrigin = new URL(parentUrl).origin;
  const parentPath = new URL(parentUrl).pathname;
  const parentSegments = parentPath.split('/').filter(Boolean);

  const groups = new Map<string, DiscoveredLink[]>();

  for (const link of links) {
    let linkUrl: URL;
    try {
      linkUrl = new URL(link.href);
    } catch {
      continue;
    }

    if (linkUrl.origin !== parentOrigin) continue;

    const segments = linkUrl.pathname.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    if (linkUrl.pathname === parentPath) continue;

    // Find longest common prefix with parent
    let commonLen = 0;
    const maxCheck = Math.min(parentSegments.length, segments.length);
    for (let i = 0; i < maxCheck; i++) {
      if (segments[i] === parentSegments[i]) commonLen++;
      else break;
    }

    if (commonLen === 0) continue;

    const prefixKey = '/' + segments.slice(0, commonLen).join('/') + '/*';

    if (!groups.has(prefixKey)) {
      groups.set(prefixKey, []);
    }
    groups.get(prefixKey)!.push(link);
  }

  const result: SiblingGroup[] = [];
  for (const [prefix, groupLinks] of groups) {
    if (groupLinks.length < 2) continue;

    const prefixSegments = prefix.replace(/\/\*$/, '').split('/').filter(Boolean);
    const label =
      prefixSegments.length > 0
        ? prefixSegments[prefixSegments.length - 1]
            .replace(/-/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase())
        : 'Root';

    result.push({ prefix, label, links: groupLinks, depth });
  }

  return result;
}

// ─── Sample Selection ───────────────────────────────────────────────

function pickDiverseSamples(
  links: DiscoveredLink[],
  k: number,
  visitedUrls: Set<string>,
): DiscoveredLink[] {
  const available = links.filter((l) => !visitedUrls.has(normalizeUrl(l.href)));
  if (available.length === 0) return [];

  const sorted = [...available].sort((a, b) => a.href.localeCompare(b.href));
  if (sorted.length <= k) return sorted;

  const samples: DiscoveredLink[] = [];
  const step = sorted.length / k;
  for (let i = 0; i < k; i++) {
    const idx = Math.min(Math.floor(i * step), sorted.length - 1);
    samples.push(sorted[idx]);
  }

  return samples;
}

// ─── URL Pattern Projection ──────────────────────────────────────────

/**
 * Project URLs from visited hub pages to unvisited sibling hubs.
 *
 * Algorithm:
 * 1. Group visited hubs by depth level
 * 2. For each depth, extract URL templates from verified child links
 * 3. Find unvisited links at the same depth (sibling hubs we didn't visit)
 * 4. For each unvisited sibling, generate projected URLs by applying
 *    the template with the sibling's path segment
 *
 * Example: if we visited "All-In-Ones" hub and found 50 product links
 * matching /Support/Printers/All-In-Ones/*, and we know "Single-Function"
 * is a sibling hub we didn't visit, project ~50 links under
 * /Support/Printers/Single-Function/*.
 *
 * Returns the number of projected URLs added.
 */
function projectFromHubYields(
  hubYields: HubYield[],
  allLinks: Map<string, DepthProbeLink>,
  visitedUrls: Set<string>,
  origin: string,
): number {
  if (hubYields.length < MIN_VISITED_FOR_PROJECTION) return 0;

  let totalProjected = 0;

  // Strategy 1: Template-based sibling projection
  // For each visited hub, find links on that hub that point to unvisited pages.
  // Those unvisited pages are candidates — if we visited a few siblings and
  // they had sub-links, project that unvisited siblings have similar sub-links.

  // Group hubs by depth to find sibling patterns
  const hubsByDepth = new Map<number, HubYield[]>();
  for (const hub of hubYields) {
    const existing = hubsByDepth.get(hub.depth) ?? [];
    existing.push(hub);
    hubsByDepth.set(hub.depth, existing);
  }

  for (const [depth, hubs] of hubsByDepth) {
    // For hubs at this depth, collect the child links we found
    // (links on hub pages that go to the next depth level)
    const childLinksByHub = new Map<string, DiscoveredLink[]>();

    for (const hub of hubs) {
      const hubPath = safePathname(hub.url);
      if (!hubPath) continue;

      // Child links = links on this hub page that extend the hub's path
      const children = hub.links.filter((l) => {
        const lPath = safePathname(l.href);
        return lPath && lPath.startsWith(hubPath) && lPath !== hubPath;
      });

      if (children.length > 0) {
        childLinksByHub.set(hub.url, children);
      }
    }

    // If we visited hubs at this depth and they had children,
    // compute average child count for projection
    if (childLinksByHub.size === 0) continue;

    let totalChildren = 0;
    for (const children of childLinksByHub.values()) {
      totalChildren += children.length;
    }
    const avgChildCount = Math.ceil(totalChildren / childLinksByHub.size);

    // Now find unvisited links at this same depth that look like sibling hubs.
    // These are links we discovered (verified) but never visited as hubs.
    const visitedHubUrls = new Set(hubs.map((h) => normalizeUrl(h.url)));

    // Look at the parent level for sibling links
    // A sibling hub is a link from a parent hub that is at this depth but wasn't visited
    const parentHubs = hubsByDepth.get(depth - 1) ?? [];
    const siblingCandidates: DiscoveredLink[] = [];

    for (const parentHub of parentHubs) {
      for (const link of parentHub.links) {
        const linkNorm = normalizeUrl(link.href);
        if (visitedHubUrls.has(linkNorm)) continue;
        if (visitedUrls.has(linkNorm)) continue;

        // Check this is a same-origin link
        try {
          if (new URL(link.href).origin !== origin) continue;
        } catch {
          continue;
        }

        siblingCandidates.push(link);
      }
    }

    if (siblingCandidates.length === 0) continue;

    // Extract URL templates from visited hub children
    const templates = extractUrlTemplates([...childLinksByHub.values()].flat(), origin);

    // For each unvisited sibling, generate projected child URLs
    for (const sibling of siblingCandidates) {
      const siblingPath = safePathname(sibling.href);
      if (!siblingPath) continue;

      const siblingSegments = siblingPath.split('/').filter(Boolean);
      const siblingSlug = siblingSegments[siblingSegments.length - 1];

      let projectedForThisSibling = 0;

      if (templates.length > 0) {
        // Apply templates: replace the hub segment with the sibling segment
        for (const template of templates) {
          if (projectedForThisSibling >= MAX_PROJECTED_PER_HUB) break;

          const projectedUrl = template.apply(siblingSlug, origin);
          if (!projectedUrl) continue;

          const projNorm = normalizeUrl(projectedUrl);
          if (allLinks.has(projNorm)) continue;

          allLinks.set(projNorm, {
            href: projectedUrl,
            text: `${sibling.text} (projected)`,
            confidence: 'projected',
            depth: depth + 1,
            group: sibling.text,
          });
          projectedForThisSibling++;
          totalProjected++;
        }
      } else {
        // No templates extractable — use count-based projection.
        // Mark the sibling hub itself as projected with estimated child count.
        const sibNorm = normalizeUrl(sibling.href);
        if (!allLinks.has(sibNorm)) {
          allLinks.set(sibNorm, {
            href: sibling.href,
            text: sibling.text,
            confidence: 'projected',
            depth,
            group: sibling.text,
          });
          totalProjected++;
        }
      }
    }

    // Strategy 2: Within-hub projection
    // If a visited hub had many links but we only verified some at the next level,
    // project the unvisited ones
    for (const hub of hubs) {
      for (const link of hub.links) {
        const linkNorm = normalizeUrl(link.href);
        if (allLinks.has(linkNorm)) continue;
        if (visitedUrls.has(linkNorm)) continue;

        try {
          if (new URL(link.href).origin !== origin) continue;
        } catch {
          continue;
        }

        // This link was on a visited hub page — we saw the <a> tag so it's real,
        // but since we're tracking it as from a hub we didn't fully explore downstream,
        // mark it as projected (it's a real URL, but its children are unknown)
        allLinks.set(linkNorm, {
          href: link.href,
          text: link.text,
          confidence: 'projected',
          depth: depth + 1,
          group: hub.parentGroup,
        });
        totalProjected++;
      }
    }
  }

  return totalProjected;
}

/**
 * Extract URL templates from a set of links.
 *
 * Finds the common path structure and identifies variable segments.
 * Returns templates that can be applied with different slug values.
 */
function extractUrlTemplates(links: DiscoveredLink[], origin: string): UrlTemplate[] {
  if (links.length < 2) return [];

  // Parse all links into path segments
  const parsed: { segments: string[]; href: string }[] = [];
  for (const link of links) {
    try {
      const u = new URL(link.href);
      if (u.origin !== origin) continue;
      parsed.push({
        segments: u.pathname.split('/').filter(Boolean),
        href: link.href,
      });
    } catch {
      continue;
    }
  }

  if (parsed.length < 2) return [];

  // Group by segment count (links with same structure)
  const byLength = new Map<number, typeof parsed>();
  for (const p of parsed) {
    const existing = byLength.get(p.segments.length) ?? [];
    existing.push(p);
    byLength.set(p.segments.length, existing);
  }

  const templates: UrlTemplate[] = [];

  for (const [, group] of byLength) {
    if (group.length < 2) continue;

    const segCount = group[0].segments.length;
    const variablePositions: number[] = [];
    const fixedSegments: (string | null)[] = [];

    // Find which positions vary across the group
    for (let i = 0; i < segCount; i++) {
      const values = new Set(group.map((p) => p.segments[i]));
      if (values.size === 1) {
        const [value] = values;
        fixedSegments.push(value);
      } else {
        fixedSegments.push(null);
        variablePositions.push(i);
      }
    }

    // We want templates where exactly one position varies at a known hub level
    if (variablePositions.length === 1) {
      templates.push({
        fixedSegments,
        variablePosition: variablePositions[0],
        segmentCount: segCount,
        apply(slug: string, appliedOrigin: string): string | null {
          const segments = [...fixedSegments];
          segments[variablePositions[0]] = slug;
          if (segments.some((s) => s === null)) return null;
          return `${appliedOrigin}/${segments.join('/')}`;
        },
      });
    }
  }

  return templates;
}

interface UrlTemplate {
  fixedSegments: (string | null)[];
  variablePosition: number;
  segmentCount: number;
  apply(slug: string, origin: string): string | null;
}

/** Safely get pathname from a URL string */
function safePathname(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    u.searchParams.sort();
    return u.toString();
  } catch {
    return url;
  }
}

function mergeApiResults(target: ApiInterceptionResult, source: ApiInterceptionResult): void {
  const callsRemaining = MAX_API_CALLS - target.calls.length;
  if (callsRemaining > 0) target.calls.push(...source.calls.slice(0, callsRemaining));
  const patternsRemaining = MAX_API_PATTERNS - target.patterns.length;
  if (patternsRemaining > 0) target.patterns.push(...source.patterns.slice(0, patternsRemaining));
  target.totalIntercepted += source.totalIntercepted;
  target.structuredCount += source.structuredCount;
}

function countByConfidence(
  allLinks: Map<string, DepthProbeLink>,
  confidence: UrlConfidence,
): number {
  let count = 0;
  for (const link of allLinks.values()) {
    if (link.confidence === confidence) count++;
  }
  return count;
}

function buildResult(
  allLinks: Map<string, DepthProbeLink>,
  seedResult: ExploreResult,
  apiInterception: ApiInterceptionResult,
  breadcrumbs: Breadcrumb[],
  stats: {
    pagesVisited: number;
    maxDepthReached: number;
    groupsFound: number;
    groupsProbed: number;
    pageRoles: Array<{ url: string; role: PageRole; depth: number }>;
    durationMs: number;
  },
  navExtraction?: NavExtractionResult,
): DepthProbeResult {
  const links = [...allLinks.values()];
  const verified = links.filter((l) => l.confidence === 'verified').length;
  const projected = links.filter((l) => l.confidence !== 'verified').length;

  return {
    links,
    seedResult,
    breadcrumbs: breadcrumbs.length > 0 ? breadcrumbs : undefined,
    apiInterception:
      apiInterception.patterns.length > 0 || apiInterception.structuredCount > 0
        ? apiInterception
        : undefined,
    navExtraction,
    stats: {
      ...stats,
      verifiedLinks: verified,
      projectedLinks: projected,
      totalLinks: links.length,
    },
  };
}
