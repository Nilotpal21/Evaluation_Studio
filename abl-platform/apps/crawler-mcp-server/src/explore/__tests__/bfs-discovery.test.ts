/**
 * BFS Discovery Engine — Integration Tests
 *
 * Tests the BFS engine with a mock Playwright Page and BrowserPool.
 * No vi.mock of internal modules — only the external Playwright Page
 * is mocked via dependency injection (BrowserPool returns mock pages).
 *
 * The mock Page returns minimal/empty data from evaluate() calls so
 * internal modules (nav-extractor, breadcrumb-extractor, page-classifier,
 * navigation-explorer) run without errors but produce empty results.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'playwright';
import type { BrowserPool } from '../../browser/pool.js';
import {
  runBfsDiscovery,
  type BfsDiscoveryConfig,
  type BfsProgressEvent,
} from '../bfs-discovery.js';

// ─── Mock Page Factory ───────────────────────────────────────────────

/**
 * Creates a mock Playwright Page that satisfies all page method calls
 * made by the BFS engine and its internal module dependencies.
 *
 * Key behaviors:
 * - goto() resolves successfully, updates internal URL
 * - url() returns the last navigated URL
 * - evaluate() returns empty/minimal data (arrays, objects, strings)
 * - $$eval() returns empty arrays
 * - title() returns a page title
 * - route() accepts handlers without error
 * - waitForTimeout() resolves immediately
 */
function createMockPage(options?: {
  /** URL the page starts at */
  initialUrl?: string;
  /** If set, goto() rejects with this error for matching URLs */
  errorUrls?: Set<string>;
  /** Links to return from extractPageLinks (via evaluate calls) */
  links?: Array<{ href: string; text: string }>;
}): Page {
  let currentUrl = options?.initialUrl ?? 'about:blank';
  const errorUrls = options?.errorUrls ?? new Set();
  const links = options?.links ?? [];

  const mockPage = {
    goto: vi.fn(async (url: string) => {
      if (errorUrls.has(url)) {
        throw new Error(`Navigation failed: net::ERR_CONNECTION_REFUSED for ${url}`);
      }
      currentUrl = url;
      return { status: () => 200, ok: () => true };
    }),

    url: vi.fn(() => currentUrl),

    title: vi.fn(async () => 'Mock Page Title'),

    evaluate: vi.fn(async (script: string | ((...args: unknown[]) => unknown)) => {
      // String-based evaluate calls from various internal modules.
      // Return reasonable empty/minimal data based on script content patterns.
      if (typeof script === 'string') {
        // page-classifier collectPageMetrics
        if (script.includes('querySelectorAll') && script.includes('totalLinks')) {
          return {
            totalLinks: links.length,
            samePrefixLinks: 0,
            linksInRepeatedContainers: 0,
            visibleTextLength: 5000,
            proseTextLength: 3000,
            hasArticleTag: false,
            hasBreadcrumb: false,
            hasPagination: false,
            terminalCues: 0,
          };
        }
        // detectRenderMethod
        if (script.includes('__REACT_DEVTOOLS_GLOBAL_HOOK__')) {
          return 'http';
        }
        // dom-region-classifier classifyDomRegions
        if (script.includes('getBoundingClientRect') || script.includes('RawDomElement')) {
          return [];
        }
        // breadcrumb-extractor - schema.org structured data
        if (script.includes('BreadcrumbList') || script.includes('breadcrumb')) {
          return [];
        }
        // navigation-explorer extractPageLinks
        if (script.includes('a[href]') && script.includes('href')) {
          return links.map((l) => ({ href: l.href, text: l.text }));
        }
        // navigation-explorer link count
        if (script.includes('a[href]') && script.includes('.length')) {
          return links.length;
        }
        // navigation-explorer expandable candidates
        if (script.includes('aria-expanded') || script.includes('ExpandableCandidate')) {
          return [];
        }
        // navigation-explorer dismissOverlays scroll
        if (script.includes('Promise') && script.includes('scrollBy')) {
          return undefined;
        }
        // navigation-explorer region assignment
        if (script.includes('contains')) {
          return [];
        }
        // Default: return empty result
        return undefined;
      }
      // Function-based evaluate (not commonly used by our modules)
      return undefined;
    }),

    $$eval: vi.fn(async () => []),

    $eval: vi.fn(async () => ''),

    waitForTimeout: vi.fn(async () => undefined),

    waitForLoadState: vi.fn(async () => undefined),

    waitForSelector: vi.fn(async () => null),

    route: vi.fn(async () => undefined),

    unroute: vi.fn(async () => undefined),

    isClosed: vi.fn(() => false),

    close: vi.fn(async () => undefined),

    // Needed by navigation-explorer hover()
    hover: vi.fn(async () => undefined),

    // Needed by some extractors
    $: vi.fn(async () => null),
    $$: vi.fn(async () => []),

    // Locator support (if needed)
    locator: vi.fn(() => ({
      count: vi.fn(async () => 0),
      first: vi.fn(() => ({
        click: vi.fn(async () => undefined),
        isVisible: vi.fn(async () => false),
      })),
    })),
  } as unknown as Page;

  return mockPage;
}

// ─── Mock BrowserPool Factory ────────────────────────────────────────

function createMockBrowserPool(page: Page): BrowserPool {
  return {
    getPage: vi.fn(async () => page),
    closeSession: vi.fn(async () => undefined),
    initialize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as BrowserPool;
}

// ─── Default Config ──────────────────────────────────────────────────

function makeConfig(overrides?: Partial<BfsDiscoveryConfig>): BfsDiscoveryConfig {
  return {
    discoveryId: 'test-discovery-001',
    primaryUrl: 'https://example.com',
    sampleUrls: [],
    maxDepth: 3,
    pageTimeout: 5000,
    maxAllLinks: 100,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('runBfsDiscovery', () => {
  let events: BfsProgressEvent[];

  beforeEach(() => {
    events = [];
  });

  const collectEvents = (event: BfsProgressEvent): void => {
    events.push(event);
  };

  it('completes with a single primary URL and emits phase events in order', async () => {
    const mockPage = createMockPage({
      initialUrl: 'https://example.com',
    });
    const pool = createMockBrowserPool(mockPage);
    const config = makeConfig();

    const result = await runBfsDiscovery(config, pool, collectEvents, () => false);

    // Verify result structure
    expect(result.discoveryId).toBe('test-discovery-001');
    expect(result.domain).toBe('example.com');
    expect(result.stats.totalUrls).toBeGreaterThanOrEqual(1);
    expect(result.stats.stoppedBy).toBe('exhausted');

    // Verify phase events emitted in order: 0, 1a, 1b, 2, 3
    const phaseEvents = events.filter((e) => e.type === 'phase') as Array<{
      type: 'phase';
      phase: number | string;
    }>;
    expect(phaseEvents.length).toBe(5);
    expect(phaseEvents.map((e) => e.phase)).toEqual([0, '1a', '1b', 2, 3]);

    // Verify completion event emitted with tree
    const completeEvents = events.filter((e) => e.type === 'complete');
    expect(completeEvents.length).toBe(1);
    const completeEvent = completeEvents[0] as { type: 'complete'; tree: unknown[] };
    expect(completeEvent.tree).toBeDefined();
    expect(Array.isArray(completeEvent.tree)).toBe(true);

    // Verify tree-snapshot events emitted at phase transitions
    const snapshotEvents = events.filter((e) => e.type === 'tree-snapshot');
    expect(snapshotEvents.length).toBeGreaterThanOrEqual(1);

    // Verify no old event types emitted
    const oldEventTypes = events.filter(
      (e) => e.type === 'page-visit' || e.type === 'url-discovered' || e.type === 'tree-update',
    );
    expect(oldEventTypes.length).toBe(0);

    // Verify browser pool was used
    expect(pool.getPage).toHaveBeenCalledOnce();
    expect(pool.closeSession).toHaveBeenCalledOnce();
  });

  it('stops early when shouldStop returns true', async () => {
    const mockPage = createMockPage({ initialUrl: 'https://example.com' });
    const pool = createMockBrowserPool(mockPage);
    const config = makeConfig();

    // Stop after first phase
    let callCount = 0;
    const shouldStop = (): boolean => {
      callCount++;
      // Allow phase 0 to complete, then stop
      return callCount > 2;
    };

    const result = await runBfsDiscovery(config, pool, collectEvents, shouldStop);

    expect(result.stats.stoppedBy).toBe('user-stop');

    // Should have fewer phases than a full run
    const phaseEvents = events.filter((e) => e.type === 'phase');
    expect(phaseEvents.length).toBeLessThanOrEqual(5);

    // Completion event still emitted
    const completeEvents = events.filter((e) => e.type === 'complete');
    expect(completeEvents.length).toBe(1);
  });

  it('handles page navigation errors gracefully', async () => {
    const errorUrls = new Set(['https://example.com']);
    const mockPage = createMockPage({
      initialUrl: 'about:blank',
      errorUrls,
    });
    const pool = createMockBrowserPool(mockPage);
    const config = makeConfig();

    const result = await runBfsDiscovery(config, pool, collectEvents, () => false);

    // Engine should complete even though primary URL navigation failed
    expect(result.discoveryId).toBe('test-discovery-001');

    // Phase 0 failure emits activity events with level 'warn', not type 'error'.
    // The engine continues to Phase 1a with seeds, so failure is non-fatal.
    const warnEvents = events.filter(
      (e) => e.type === 'activity' && 'level' in e && e.level === 'warn',
    );
    expect(warnEvents.length).toBeGreaterThanOrEqual(1);

    // Completion event still emitted
    const completeEvents = events.filter((e) => e.type === 'complete');
    expect(completeEvents.length).toBe(1);
  });

  it('deduplicates discovered URLs via normalizer', async () => {
    // Provide links that normalize to the same URL
    const links = [
      { href: 'https://example.com/page?utm_source=google', text: 'Page with tracking' },
      { href: 'https://example.com/page?utm_campaign=spring', text: 'Same page diff tracking' },
      { href: 'https://EXAMPLE.COM/page', text: 'Same page uppercase' },
      { href: 'https://example.com/other', text: 'Different page' },
    ];

    const mockPage = createMockPage({
      initialUrl: 'https://example.com',
      links,
    });
    const pool = createMockBrowserPool(mockPage);
    const config = makeConfig();

    const result = await runBfsDiscovery(config, pool, collectEvents, () => false);

    // All three "page" URLs should normalize to the same URL
    // So we should have: primary + /page + /other = 3 unique URLs
    // (The primary URL https://example.com/ is always present)
    const discoveredUrls = [...result.discoveredUrls.keys()];
    const pageUrls = discoveredUrls.filter((u) => u.includes('/page'));
    expect(pageUrls.length).toBe(1); // Deduplicated to single /page URL

    const otherUrls = discoveredUrls.filter((u) => u.includes('/other'));
    expect(otherUrls.length).toBe(1);
  });

  it('respects maxAllLinks cap', async () => {
    // Return many links from the primary page
    const links = Array.from({ length: 50 }, (_, i) => ({
      href: `https://example.com/page-${i}`,
      text: `Page ${i}`,
    }));

    const mockPage = createMockPage({
      initialUrl: 'https://example.com',
      links,
    });
    const pool = createMockBrowserPool(mockPage);
    const config = makeConfig({ maxAllLinks: 10 });

    const result = await runBfsDiscovery(config, pool, collectEvents, () => false);

    // Should not exceed maxAllLinks
    expect(result.stats.totalUrls).toBeLessThanOrEqual(10);
  });

  it('processes sample URLs in phase 1a', async () => {
    const mockPage = createMockPage({ initialUrl: 'https://example.com' });
    const pool = createMockBrowserPool(mockPage);
    const config = makeConfig({
      sampleUrls: ['https://example.com/products', 'https://example.com/support'],
    });

    const result = await runBfsDiscovery(config, pool, collectEvents, () => false);

    // Sample URLs should have been visited
    expect(result.stats.totalVisited).toBeGreaterThanOrEqual(3); // primary + 2 samples

    // Phase 1a event should be present
    const phase1aEvents = events.filter(
      (e) => e.type === 'phase' && (e as { phase: number | string }).phase === '1a',
    );
    expect(phase1aEvents.length).toBe(1);
  });

  it('filters out cross-domain links', async () => {
    const links = [
      { href: 'https://example.com/internal', text: 'Internal' },
      { href: 'https://other-domain.com/external', text: 'External' },
      { href: 'https://cdn.example.com/asset', text: 'CDN subdomain' },
    ];

    const mockPage = createMockPage({
      initialUrl: 'https://example.com',
      links,
    });
    const pool = createMockBrowserPool(mockPage);
    const config = makeConfig();

    const result = await runBfsDiscovery(config, pool, collectEvents, () => false);

    const discoveredUrls = [...result.discoveredUrls.keys()];
    // Only same-domain links should be discovered
    expect(discoveredUrls.some((u) => u.includes('other-domain.com'))).toBe(false);
    expect(discoveredUrls.some((u) => u.includes('cdn.example.com'))).toBe(false);
    expect(discoveredUrls.some((u) => u.includes('example.com/internal'))).toBe(true);
  });
});
