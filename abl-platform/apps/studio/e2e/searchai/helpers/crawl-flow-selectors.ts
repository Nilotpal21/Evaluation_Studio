/**
 * Crawl Flow Selectors — verified locators for the unified discovery E2E tests.
 *
 * These selectors are derived from reading actual component source code.
 * The crawl flow has ZERO data-testid attributes, so we use:
 *   - Text content (i18n strings from studio.json)
 *   - ARIA roles/labels
 *   - CSS structure (classes, tag nesting)
 *   - Icon heuristics (lucide icon → parent button)
 *
 * Source of truth:
 *   - State1UrlEntry.tsx — URL input + Go button
 *   - StrategySelector.tsx — Strategy cards
 *   - UnifiedDiscoveryPanel.tsx — Scanning/Searching/Complete phases
 *   - State2Analysis.tsx — Section checklist, sidebar trigger
 *   - AddSourceButton.tsx — Connector catalog + CrawlFlowPanel
 *
 * @e2e-real — No mocks. These match real rendered DOM.
 */

import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';
import { waitForIdle } from '../../helpers/ui';
import { env } from '../../helpers/env';

// ─── Navigation to Crawl Flow ───────────────────────────────────────────────

/** Sidebar nav item for "Knowledge Bases" (BookOpen icon, slug: search-ai) */
export function sidebarKnowledgeBases(page: Page): Locator {
  return page.locator('nav').getByText('Knowledge Bases');
}

/** A KB card on the dashboard (button with h3 for KB name) */
export function kbCard(page: Page, kbName: string): Locator {
  return page.locator('button:has(h3)', { hasText: new RegExp(kbName, 'i') });
}

/** "Connect a source" button on new KB home (SetupGuide) */
export function connectSourceButton(page: Page): Locator {
  return page.getByRole('button', { name: /connect a source/i });
}

/** "Add Source" button on Data tab */
export function addSourceButton(page: Page): Locator {
  return page.getByRole('button', { name: /add source/i });
}

/**
 * Web Crawler "Connect" button in the connector catalog dialog.
 * ConnectorCatalogCard renders: displayName ("Web Crawler") + "Connect" button.
 * We locate the card by its display name, then find its Connect button.
 */
export function webCrawlerConnectButton(page: Page): Locator {
  // Find the card container that has "Web Crawler" text, then its "Connect" button
  const card = page
    .locator('div')
    .filter({ hasText: /^Web Crawler/ })
    .first();
  return card.getByRole('button', { name: /connect/i });
}

// ─── State 1: URL Entry ─────────────────────────────────────────────────────

/** The URL input field (type="url", placeholder "https://example.com") */
export function urlInput(page: Page): Locator {
  return page.locator('input[type="url"]');
}

/** The "Go" submit button */
export function goButton(page: Page): Locator {
  return page.getByRole('button', { name: /^go$/i });
}

// ─── State 2: Strategy Selector ─────────────────────────────────────────────

/** Strategy section heading: "How would you like to discover content?" */
export function strategyHeading(page: Page): Locator {
  return page.getByText('How would you like to discover content?');
}

/** Sitemap strategy card — "Crawl Full Sitemap" */
export function strategySitemapCard(page: Page): Locator {
  return page.getByText('Crawl Full Sitemap').locator('..');
}

/** Guided Discovery strategy card — "Guided Discovery" */
export function strategyGuidedCard(page: Page): Locator {
  return page.getByText('Guided Discovery').locator('..');
}

/** "Recommended" badge on a strategy card */
export function recommendedBadge(page: Page): Locator {
  return page.getByText('Recommended');
}

/** "Selected" badge on a strategy card */
export function selectedBadge(page: Page): Locator {
  return page.getByText('Selected');
}

/** Strategy reasoning text (italic, tiny text under the card description) */
export function strategyReasoning(page: Page, partialText: string): Locator {
  return page.getByText(partialText, { exact: false });
}

// ─── State 2: Section Checklist ─────────────────────────────────────────────

/** Section filter search input */
export function sectionFilter(page: Page): Locator {
  return page.locator('input[placeholder*="Filter"]');
}

/** All section checkbox rows */
export function sectionCheckboxes(page: Page): Locator {
  return page.locator('[role="checkbox"]');
}

// ─── State 2: Sample URL Input (Guided Discovery) ──────────────────────────

/**
 * Sample URL input fields (appears after selecting Guided Discovery).
 * SampleUrlInput.tsx renders up to 3 `<input type="url">` fields.
 *
 * IMPORTANT: In State2, the base URL input from State1 is unmounted.
 * So sample URL inputs are the ONLY `input[type="url"]` on the page.
 * Scope to the "Discover more pages" section to be safe.
 */
export function sampleUrlInputs(page: Page): Locator {
  // Scope to the Discover more pages section
  const section = page.locator('div').filter({ hasText: /Discover more pages/ });
  return section.locator('input[type="url"]');
}

/** Get a specific sample URL input by index (0-based) */
export function sampleUrlInput(page: Page, index = 0): Locator {
  // In State2, the base URL input is unmounted — sample inputs start at 0
  const section = page.locator('div').filter({ hasText: /Discover more pages/ });
  return section.locator('input[type="url"]').nth(index);
}

/** Click "+ Add another example" to add a new sample URL input slot */
export function addAnotherExampleButton(page: Page): Locator {
  return page.getByText('Add another example', { exact: false });
}

/** "Start Discovery" button */
export function startDiscoveryButton(page: Page): Locator {
  return page.getByRole('button', { name: /start discovery/i });
}

// ─── Unified Discovery Panel ────────────────────────────────────────────────

/**
 * Phase label — the text indicating current discovery phase.
 * New values: "Exploring site navigation", "Exploration complete"
 * Deprecated values: "Scanning site navigation", "Searching for more pages", "Discovery complete"
 */
export function phaseLabel(page: Page, text: string): Locator {
  return page.getByText(text, { exact: false });
}

/** LED indicator — the pulsing/static dot showing active/complete state */
export function ledIndicator(page: Page): Locator {
  // The LED is a span with rounded-full + animate-pulse or bg-emerald classes
  return page.locator('span.rounded-full').first();
}

/** Activity log container — holds milestone and detail entries */
export function activityLog(page: Page): Locator {
  // DiscoveryConsole renders: <motion.div className="space-y-2"> with "Discovery Log" heading
  // Use the heading text as a stable anchor
  return page.getByText('Discovery Log', { exact: false });
}

/** "Show details" toggle link */
export function showDetailsToggle(page: Page): Locator {
  return page.getByText('Show details');
}

/** "Hide details" toggle link */
export function hideDetailsToggle(page: Page): Locator {
  return page.getByText('Hide details');
}

/** Completed phase summary (CheckCircle2 icon + summary text) */
export function completedSummary(page: Page, partialText: string): Locator {
  return page.getByText(partialText, { exact: false });
}

/** "Finish" button (shown when discovery is complete) */
export function finishButton(page: Page): Locator {
  return page.getByRole('button', { name: /finish/i });
}

/** "Close" button (X icon on the discovery panel) */
export function closeButton(page: Page): Locator {
  return page.getByRole('button', { name: /close/i });
}

/** Collapse/expand toggle for the discovery panel */
export function collapseToggle(page: Page): Locator {
  return page.getByText('Collapse discovery', { exact: false });
}

export function expandToggle(page: Page): Locator {
  return page.getByText('Expand discovery', { exact: false });
}

// ─── Sidebar Discovery Trigger ──────────────────────────────────────────────

/** "Discover more pages" sidebar link (Compass icon) */
export function discoverMoreLink(page: Page): Locator {
  return page.getByText('Discover more pages');
}

// ─── Unified Discovery Tree ────────────────────────────────────────────────

/** The unified tree container (appears after browser discovery populates it) */
export function unifiedTree(page: Page): Locator {
  return page.locator('[data-testid="unified-tree"]');
}

/** Tree header with search and action buttons */
export function unifiedTreeHeader(page: Page): Locator {
  return page.locator('[data-testid="unified-tree-header"]');
}

/** Tree search/filter input */
export function treeSearchInput(page: Page): Locator {
  return page.locator('[data-testid="tree-search-input"]');
}

/** Tree stats bar showing explored/exploring/error counts */
export function treeStatsBar(page: Page): Locator {
  return page.locator('[data-testid="tree-stats-bar"]');
}

/** Tree footer with section/page counts and Configure Crawl button */
export function unifiedTreeFooter(page: Page): Locator {
  return page.locator('[data-testid="unified-tree-footer"]');
}

/** Footer stats text (e.g. "3 sections · 42 pages") */
export function unifiedTreeFooterStats(page: Page): Locator {
  return page.locator('[data-testid="unified-tree-footer-stats"]');
}

/** "Configure Crawl" button in tree footer */
export function configureCrawlButton(page: Page): Locator {
  return page.locator('[data-testid="configure-crawl-btn"]');
}

/** Discovery panel container */
export function discoveryPanel(page: Page): Locator {
  return page.locator('[data-testid="discovery-panel"]');
}

/** Empty tree state message */
export function unifiedTreeEmpty(page: Page): Locator {
  return page.locator('[data-testid="unified-tree-empty"]');
}

/** A specific tree node row by its node ID */
export function treeNode(page: Page, nodeId: string): Locator {
  return page.locator(`[data-testid="tree-node-${nodeId}"]`);
}

/** All tree node rows */
export function allTreeNodes(page: Page): Locator {
  return page.locator('[data-testid^="tree-node-"]');
}

/** All tree nodes with a specific status */
export function treeNodesByStatus(page: Page, status: string): Locator {
  return page.locator(`[data-node-status="${status}"]`);
}

/** All included tree nodes */
export function includedTreeNodes(page: Page): Locator {
  return page.locator('[data-node-included="true"]');
}

/** Tree node label within a node row */
export function treeNodeLabel(page: Page, nodeTestId: string): Locator {
  return page.locator(`[data-testid="${nodeTestId}"] [data-testid="tree-node-label"]`);
}

/** Expand All button in tree header */
export function expandAllButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Expand All', exact: true });
}

/** Collapse All button in tree header */
export function collapseAllButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Collapse All', exact: true });
}

/** Select All button in tree header */
export function selectAllButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Select All', exact: true });
}

/** Deselect All button in tree header */
export function deselectAllButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Deselect All', exact: true });
}

/** Page count badge on a tree node */
export function treeNodePageCount(page: Page): Locator {
  return page.locator('[data-testid="tree-node-pages"]');
}

/** Explore button on a tree node (only visible on hover) */
export function treeNodeExploreButton(page: Page): Locator {
  return page.locator('[data-testid="tree-node-explore"]');
}

/** Retry button on an errored tree node */
export function treeNodeRetryButton(page: Page): Locator {
  return page.locator('[data-testid="tree-node-retry"]');
}

// ─── State 3: Configure (Rendering Mode) ───────────────────────────────────

/** Rendering mode labels */
export function renderingAdaptive(page: Page): Locator {
  return page.getByText('Adaptive');
}

export function renderingStandard(page: Page): Locator {
  return page.getByText('Standard');
}

export function renderingFullRendering(page: Page): Locator {
  return page.getByText('Full rendering');
}

// ─── Edit Samples ───────────────────────────────────────────────────────────

/** "Edit" link for sample URLs (Pencil icon) */
export function editSamplesLink(page: Page): Locator {
  return page.getByText('Edit', { exact: true });
}

// ─── Negative Regression ────────────────────────────────────────────────────

/**
 * These terms should NEVER appear in the crawl flow UI.
 * Use `expect(locator).not.toBeVisible()` for each.
 */
export const BANNED_TERMS = [
  'Browser Discovery',
  'HTTP Discovery',
  'Continue to HTTP discovery?',
  'Hybrid', // should be "Adaptive"
  'HTTP only', // should be "Standard"
  'Browser only', // should be "Full rendering"
  'Scanning site navigation', // deprecated — now "Exploring site navigation"
  'Searching for more pages', // deprecated — now part of unified exploration
  'Phase 1', // deprecated — no longer phase-numbered
  'Phase 2', // deprecated — no longer phase-numbered
] as const;

/**
 * Check that none of the banned old-terminology terms appear on the page.
 * Returns an array of terms that were found (empty = good).
 */
export async function checkBannedTerms(page: Page): Promise<string[]> {
  const found: string[] = [];
  for (const term of BANNED_TERMS) {
    const visible = await page
      .getByText(term, { exact: true })
      .first()
      .isVisible({ timeout: 1_000 })
      .catch((_e: unknown) => false);
    if (visible) found.push(term);
  }
  return found;
}

// ═════════════════════════════════════════════════════════════════════════════
// Reusable Flow Helpers — composable steps that tests chain together
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Navigate from a logged-in project context to the KB list page.
 * Clicks sidebar "Knowledge Bases" and waits for the URL to match.
 */
export async function navigateToKBList(page: Page): Promise<void> {
  await sidebarKnowledgeBases(page).click();
  await page.waitForURL(/\/search-ai/, { timeout: 15_000 });
  await waitForIdle(page);
}

/**
 * Select a KB by name from the dashboard. Throws with available KBs if not found.
 */
export async function selectKB(page: Page, kbName: string): Promise<void> {
  const card = kbCard(page, kbName);
  const cardVisible = await card.isVisible({ timeout: 10_000 }).catch((_e: unknown) => false);

  if (!cardVisible) {
    const allCards = await page.locator('button:has(h3)').allTextContents();
    throw new Error(
      `KB "${kbName}" not found. Available: ${allCards.join(', ')}. ` +
        `Set TEST_KB_NAME env var to match an existing KB.`,
    );
  }

  await card.click();
  await page.waitForURL(/\/search-ai\/[^/]+/, { timeout: 15_000 });
  await waitForIdle(page);
}

/**
 * Open the Web Crawler panel from a KB detail page.
 * Handles both new-KB ("Connect a source") and existing-KB ("Add Source") paths.
 * Returns when the URL input is visible and ready.
 */
export async function openWebCrawlerPanel(page: Page): Promise<void> {
  // Try "Connect a source" first (new KB home), then "Add Source" (Data tab)
  const connectBtn = connectSourceButton(page);
  const addBtn = addSourceButton(page);

  const hasConnect = await connectBtn.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
  const hasAdd = await addBtn.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);

  if (hasConnect) {
    await connectBtn.click();
  } else if (hasAdd) {
    await addBtn.click();
  } else {
    // Navigate to Data tab first — use role=tab to avoid matching other "Data" text on page
    await page.getByRole('tab', { name: /^Data$/i }).click();
    await page.waitForTimeout(1_000);
    await addSourceButton(page).click();
  }

  // Wait for connector catalog dialog
  await page.waitForTimeout(1_000);

  // Click "Connect" on the Web Crawler card
  const crawlerBtn = webCrawlerConnectButton(page);
  await expect(crawlerBtn).toBeVisible({ timeout: 5_000 });
  await crawlerBtn.click();

  // Wait for CrawlFlowPanel to open with URL input
  await expect(urlInput(page)).toBeVisible({ timeout: 5_000 });
}

/**
 * Full navigation: KB list → select KB → open Web Crawler panel.
 * Use this to reach the URL input in a single call.
 */
export async function navigateToCrawlFlow(page: Page, kbName: string): Promise<void> {
  await navigateToKBList(page);
  await selectKB(page, kbName);
  await openWebCrawlerPanel(page);
}

/**
 * Submit a URL and wait for profiling to complete (strategy cards visible).
 */
export async function submitUrlAndWaitForProfiling(
  page: Page,
  url: string,
  timeoutMs = 30_000,
): Promise<void> {
  const input = urlInput(page);
  await input.fill(url);
  await goButton(page).click();
  await expect(strategyHeading(page)).toBeVisible({ timeout: timeoutMs });
}

/**
 * Close the CrawlFlowPanel (SlidePanel).
 * The panel's close triggers via the SlidePanel's overlay click or Escape key.
 * After closing, waits for the panel to disappear (URL input gone).
 */
export async function closeCrawlFlowPanel(page: Page): Promise<void> {
  // Press Escape to close the SlidePanel
  await page.keyboard.press('Escape');

  // "Discovery is still running" dialog may appear with options:
  //   - "Minimize to activity bar" (button)
  //   - "Stop & save draft" (button)
  //   - "Discard" (text link, NOT a button)
  // Wait for the dialog to appear (it renders as a modal)
  const discoveryRunning = await page
    .getByText('Discovery is still running', { exact: false })
    .isVisible({ timeout: 3_000 })
    .catch((_e: unknown) => false);

  if (discoveryRunning) {
    // Click "Discard" to fully close without saving
    // Note: "Discard" may be a text link (not role=button), so use getByText
    const discardLink = page.getByText('Discard', { exact: true });
    const hasDiscard = await discardLink
      .isVisible({ timeout: 2_000 })
      .catch((_e: unknown) => false);
    if (hasDiscard) {
      await discardLink.click();
    } else {
      // Fallback: try "Stop & save draft" button
      const stopBtn = page.getByRole('button', { name: /stop.*save/i });
      const hasStop = await stopBtn.isVisible({ timeout: 2_000 }).catch((_e: unknown) => false);
      if (hasStop) await stopBtn.click();
    }
  } else {
    // Check for generic discard/close confirmation
    const genericConfirm = await page
      .getByText('discard', { exact: false })
      .isVisible({ timeout: 2_000 })
      .catch((_e: unknown) => false);
    if (genericConfirm) {
      const discardBtn = page.getByRole('button', { name: /discard|close|leave/i });
      const hasBtn = await discardBtn.isVisible({ timeout: 2_000 }).catch((_e: unknown) => false);
      if (hasBtn) await discardBtn.click();
    }
  }

  // Wait for panel to be gone (URL input hidden means panel closed)
  await page
    .locator('input[type="url"]')
    .waitFor({ state: 'hidden', timeout: 5_000 })
    .catch((_e: unknown) => {
      console.warn('[E2E] CrawlFlowPanel may not have closed cleanly');
    });
}

// ─── Screenshot Helper ──────────────────────────────────────────────────────

/**
 * Take a crawl-flow screenshot with a consistent naming scheme.
 * Saves to e2e/screenshots/unified-discovery/{scenario}-{step}.png
 *
 * Uses viewport-only (NOT fullPage) to avoid hanging on pages with
 * enormous discovery trees (docs.kore.ai can generate thousands of nodes).
 * Wrapped in a 10s timeout safety net.
 */
export async function crawlScreenshot(
  page: Page,
  scenario: string,
  step: string,
  note: string,
): Promise<void> {
  const name = `unified-discovery/${scenario}-${step}.png`;
  const path = `${env.screenshotDir}/${name}`;
  const { mkdirSync } = await import('fs');
  const { dirname } = await import('path');
  try {
    mkdirSync(dirname(path), { recursive: true });
    await Promise.race([
      page.screenshot({ path, fullPage: false }),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Screenshot timeout')), 10_000),
      ),
    ]);
    console.info(`[E2E] ${name}: ${note}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[E2E] Screenshot failed (${name}): ${msg}`);
  }
}

// ─── Network Observation ────────────────────────────────────────────────────

export interface CapturedSSE {
  url: string;
  method: string;
  timestamp: number;
}

export interface CapturedAPICall {
  url: string;
  method: string;
  status: number;
  timestamp: number;
}

/**
 * Start capturing SSE (EventSource) and API calls relevant to crawl flow.
 * Returns a handle with captured data that accumulates over time.
 *
 * Usage:
 *   const capture = startNetworkCapture(page);
 *   // ... do stuff ...
 *   const { sse, api } = capture.stop();
 */
export function startNetworkCapture(page: Page): {
  sse: CapturedSSE[];
  api: CapturedAPICall[];
  stop: () => { sse: CapturedSSE[]; api: CapturedAPICall[] };
} {
  const sse: CapturedSSE[] = [];
  const api: CapturedAPICall[] = [];

  const handler = (response: {
    url: () => string;
    request: () => { method: () => string };
    status: () => number;
  }) => {
    const url = response.url();
    const method = response.request().method();
    const status = response.status();

    // SSE endpoints typically use text/event-stream
    if (url.includes('/events') || url.includes('/sse') || url.includes('/stream')) {
      sse.push({ url, method, timestamp: Date.now() });
    }

    // Crawl-related API calls
    if (
      url.includes('/crawl') ||
      url.includes('/profile') ||
      url.includes('/discover') ||
      url.includes('/explore') ||
      url.includes('/cluster')
    ) {
      api.push({ url, method, status, timestamp: Date.now() });
    }
  };

  page.on('response', handler);

  return {
    sse,
    api,
    stop: () => {
      page.removeListener('response', handler);
      return { sse, api };
    },
  };
}
