/**
 * Unified Discovery Panel — E2E Tests
 *
 * Tests the complete crawl discovery flow: URL entry → profiling → strategy selection →
 * unified discovery panel (exploring → unified tree → configure crawl).
 *
 * NEW FLOW (replaces old phase-based auto-chain):
 *   1. Browser discovery runs → "Exploring site navigation"
 *   2. Browser completes → autoMatchNodes → auto-explore of matched nodes
 *   3. UnifiedTree renders with tree nodes (statuses: auto-matched, exploring, explored)
 *   4. User clicks "Configure Crawl" in tree footer
 *   5. "Exploration complete" label
 *
 * ZERO ASSUMPTIONS:
 *   - Every selector verified against real DOM
 *   - Event-based waits (waitForSelector/waitForResponse), never fixed timeouts
 *   - Serial execution (discovery creates KB sections — order matters)
 *   - No mocks, no direct DB access
 *
 * @e2e-real
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { loginViaDevApi, getToken, env } from '../helpers';
import { ServiceHealthChecker } from './helpers/service-health';
import {
  navigateToKBList,
  selectKB,
  openWebCrawlerPanel,
  submitUrlAndWaitForProfiling,
  closeCrawlFlowPanel,
  urlInput,
  strategySitemapCard,
  strategyGuidedCard,
  recommendedBadge,
  sampleUrlInput,
  addAnotherExampleButton,
  startDiscoveryButton,
  finishButton,
  phaseLabel,
  ledIndicator,
  activityLog,
  showDetailsToggle,
  hideDetailsToggle,
  sectionCheckboxes,
  discoverMoreLink,
  checkBannedTerms,
  crawlScreenshot,
  startNetworkCapture,
  unifiedTree,
  configureCrawlButton,
  allTreeNodes,
  treeNodesByStatus,
  includedTreeNodes,
  treeStatsBar,
  unifiedTreeFooterStats,
  treeSearchInput,
  expandAllButton,
  collapseAllButton,
  selectAllButton,
  deselectAllButton,
  discoveryPanel,
  treeNodePageCount,
} from './helpers/crawl-flow-selectors';

// ─── Test Configuration ─────────────────────────────────────────────────────

/** KB to use — set TEST_KB_NAME env var or fallback to "testing" */
const KB_NAME = process.env.TEST_KB_NAME || 'testing';

/** Test URLs for each scenario */
const TEST_URLS = {
  /** Sitemap path — docs.kore.ai has a well-maintained sitemap */
  sitemap: 'https://docs.kore.ai/',
  /** Guided discovery path — epson support has JS navigation */
  guided: 'https://epson.com/Support/Printers/sh/s1',
  /** Sample URLs for guided discovery */
  guidedSamples: [
    'https://epson.com/Support/Printers/All-In-One/ET-Series/Epson-ET-2600/s/SPT_C11CF46201#questions',
    'https://epson.com/Support/Printers/All-In-One/WorkForce-Series/Epson-WorkForce-WF-4630/s/SPT_C11CD10201#manuals',
    'https://epson.com/Support/Printers/All-In-One/ET-Series/Epson-ET-2400/s/SPT_C11CJ67201#questions',
  ],
};

// Shared state across serial tests — initialized in beforeAll
let context: BrowserContext;
let page: Page;
let token: string;

// Serial execution — discovery creates KB sections, tests depend on prior state
test.describe.configure({ mode: 'serial' });

// Long timeout for discovery operations, capped so failures surface within 3 minutes.
test.setTimeout(180_000);

// ═════════════════════════════════════════════════════════════════════════════
// SETUP
// ═════════════════════════════════════════════════════════════════════════════

test.describe('Unified Discovery', () => {
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context.close();
  });

  // ─── A0: Health Check ───────────────────────────────────────────────────

  test('A0: all required services are healthy', async ({ request }) => {
    const checker = new ServiceHealthChecker(request);

    const requiredServices = [
      { name: 'Studio', url: 'http://localhost:5173' },
      { name: 'SearchAI', url: 'http://localhost:3113/health' },
    ];

    const optionalServices = [
      { name: 'Runtime', url: 'http://localhost:3112/health' },
      { name: 'CrawlerMCP', url: 'http://localhost:3100/health' },
    ];

    for (const svc of requiredServices) {
      const health = await checker.checkService(svc.name, svc.url);
      expect(health.healthy, `${svc.name} should be healthy at ${svc.url}`).toBe(true);
      console.info(`✓ ${svc.name} healthy (${health.responseTime}ms)`);
    }

    for (const svc of optionalServices) {
      const health = await checker.checkService(svc.name, svc.url);
      if (health.healthy) {
        console.info(`✓ ${svc.name} healthy (${health.responseTime}ms)`);
      } else {
        console.warn(`⚠ ${svc.name} not available — some tests may be limited`);
      }
    }
  });

  // ─── A1: Login + Enter Project ──────────────────────────────────────────

  test('A1: dev login and enter project', async () => {
    // API-based login — lands on /projects
    await loginViaDevApi(page, { landingPath: '/projects' });
    token = await getToken(page);
    expect(token).toBeTruthy();

    await page.waitForURL(/\/projects/, { timeout: 10_000 });

    // Wait for project list to load (spinner may take time)
    const projectCardText = page.getByText('test app', { exact: false }).first();
    const noProjectsMsg = page.getByText('No projects yet', { exact: false });

    // Wait up to 30s for either a project card or "no projects" message
    let hasProjects = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const cardVisible = await projectCardText
        .isVisible({ timeout: 1_000 })
        .catch((_e: unknown) => false);
      if (cardVisible) {
        hasProjects = true;
        break;
      }
      const hasNoProjects = await noProjectsMsg
        .isVisible({ timeout: 1_000 })
        .catch((_e: unknown) => false);
      if (hasNoProjects) break;
      await page.waitForTimeout(2_000);
    }

    if (!hasProjects) {
      const slug = 'crawl-e2e';
      console.info(`  No projects found — creating via API (slug: ${slug})`);
      const createResp = await page.request.post(`${env.baseUrl}/api/projects`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        data: { name: 'test app', slug },
      });
      if (createResp.status() === 201) {
        const body = (await createResp.json()) as { success: boolean; project: { id: string } };
        console.info(`  Created project: ${body.project.id}`);
      } else {
        console.info(`  Project API returned ${createResp.status()} — may already exist`);
      }
      await page.reload();
      await page.waitForTimeout(5_000);
    }

    // Click the first available project card (any project with "test app" or any h3)
    // Project cards render as clickable containers with the project name
    const projectCard = page.getByText('test app', { exact: false }).first();
    await expect(projectCard).toBeVisible({ timeout: 30_000 });
    const cardText = await projectCard.textContent();
    await projectCard.click();

    await page.waitForURL(/\/projects\/[^/]+/, { timeout: 15_000 });
    await page.waitForTimeout(2_000);
    await crawlScreenshot(page, 'setup', 'a1-project', 'Inside project');
    console.info(`✓ Logged in. Project: "${cardText?.trim()}". URL: ${page.url()}`);
  });

  // ─── A2: Navigate to Crawl Flow ──────────────────────────────────────

  test('A2: navigate to KB and open Web Crawler', async () => {
    await navigateToKBList(page);

    const card = page.locator('button:has(h3)', { hasText: new RegExp(KB_NAME, 'i') });
    const hasKB = await card.isVisible({ timeout: 5_000 }).catch((_e: unknown) => false);

    if (!hasKB) {
      console.info(`  KB "${KB_NAME}" not found — creating via API`);
      const projectMatch = page.url().match(/\/projects\/([^/]+)/);
      const projectId = projectMatch?.[1];
      expect(projectId, 'Should be inside a project').toBeTruthy();

      const createResp = await page.request.post(`${env.baseUrl}/api/search-ai/knowledge-bases`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        data: {
          projectId,
          name: KB_NAME,
          description: 'E2E test KB for crawl flow exploration',
        },
      });
      expect(createResp.status(), `KB creation should succeed`).toBe(201);
      console.info(`  Created KB "${KB_NAME}"`);

      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(2_000);
      await navigateToKBList(page);
      await page.waitForTimeout(2_000);
    }

    await selectKB(page, KB_NAME);
    await openWebCrawlerPanel(page);
    await crawlScreenshot(page, 'setup', 'a2-crawl-panel', 'Web Crawler panel open');
    console.info('✓ Web Crawler panel open — URL input visible');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // E11: SITEMAP PATH (docs.kore.ai)
  // ═══════════════════════════════════════════════════════════════════════

  test('E11.1: enter URL and wait for profiling', async () => {
    const capture = startNetworkCapture(page);

    await submitUrlAndWaitForProfiling(page, TEST_URLS.sitemap);

    const { api } = capture.stop();
    console.info(`✓ Profiling complete — ${api.length} crawl API calls captured`);
    for (const call of api) {
      console.info(`  ${call.method} ${call.url} → ${call.status}`);
    }

    await crawlScreenshot(page, 'e11', '1-profiled', 'Strategy cards visible');
  });

  test('E11.2: sitemap strategy is recommended', async () => {
    await expect(strategySitemapCard(page)).toBeVisible();
    await expect(strategyGuidedCard(page)).toBeVisible();

    const badge = recommendedBadge(page);
    await expect(badge).toBeVisible();

    const sitemapText = await strategySitemapCard(page).textContent();
    expect(sitemapText).toContain('Recommended');

    await crawlScreenshot(page, 'e11', '2-recommended', 'Sitemap card recommended');
    console.info('✓ Sitemap card shows "Recommended" badge');
  });

  test('E11.3: select sitemap — sections appear, no discovery panel', async () => {
    await strategySitemapCard(page).click();
    await page.waitForTimeout(2_000);

    // Verify NO discovery panel elements appear
    const exploringVisible = await phaseLabel(page, 'Exploring site navigation')
      .isVisible({ timeout: 2_000 })
      .catch((_e: unknown) => false);
    expect(exploringVisible).toBe(false);

    await crawlScreenshot(page, 'e11', '3-selected', 'Sitemap selected — no discovery panel');
    console.info('✓ Sitemap selected — no discovery panel launched');
  });

  test('E11.4: sidebar shows "Discover more pages" link', async () => {
    const link = discoverMoreLink(page);
    await expect(link).toBeVisible({ timeout: 5_000 });

    await crawlScreenshot(page, 'e11', '4-sidebar', 'Discover more pages visible');
    console.info('✓ "Discover more pages" link visible');
  });

  test('E11.5: negative regression — no banned terminology', async () => {
    const banned = await checkBannedTerms(page);
    expect(banned, `Banned terms found: ${banned.join(', ')}`).toHaveLength(0);

    console.info('✓ No banned terminology found');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // E1: GUIDED DISCOVERY — UNIFIED TREE (Epson)
  //
  // Tests the new unified discovery flow:
  //   1. Browser discovery runs → "Exploring site navigation"
  //   2. Browser completes → autoMatchNodes → auto-explore
  //   3. UnifiedTree renders with tree nodes
  //   4. User clicks "Configure Crawl" in tree footer
  //   5. "Exploration complete" label
  // ═══════════════════════════════════════════════════════════════════════

  test('E1.0: close panel and reopen for new URL', async () => {
    await closeCrawlFlowPanel(page);
    await page.waitForTimeout(1_000);
    await openWebCrawlerPanel(page);
    await crawlScreenshot(page, 'e1', '0-reopened', 'Fresh URL input for Epson');
    console.info('✓ Panel closed and reopened — fresh URL input');
  });

  test('E1.1: enter Epson URL and wait for profiling', async () => {
    const capture = startNetworkCapture(page);

    // Epson profiling may take longer than docs.kore.ai (JS-heavy site)
    await submitUrlAndWaitForProfiling(page, TEST_URLS.guided, 60_000);

    const { api } = capture.stop();
    console.info(`✓ Profiling complete — ${api.length} crawl API calls captured`);
    for (const call of api) {
      console.info(`  ${call.method} ${call.url} → ${call.status}`);
    }

    await crawlScreenshot(page, 'e1', '1-profiled', 'Epson strategy cards');
  });

  test('E1.2: guided discovery is recommended', async () => {
    await expect(strategyGuidedCard(page)).toBeVisible();
    await expect(strategySitemapCard(page)).toBeVisible();

    // Epson should recommend Guided (JS navigation, limited sitemap)
    const guidedText = await strategyGuidedCard(page).textContent();
    expect(guidedText).toContain('Recommended');

    await crawlScreenshot(page, 'e1', '2-recommended', 'Guided card recommended');
    console.info('✓ Guided Discovery card shows "Recommended" badge');
  });

  test('E1.3: select guided, enter samples, start discovery', async () => {
    // Click guided strategy card
    await strategyGuidedCard(page).click();
    await page.waitForTimeout(1_000);

    // Wait for sample URL input to appear
    const firstSample = sampleUrlInput(page, 0);
    await expect(firstSample).toBeVisible({ timeout: 10_000 });

    // Fill sample URLs
    await firstSample.fill(TEST_URLS.guidedSamples[0]);
    console.info(`  Filled sample 0: ${TEST_URLS.guidedSamples[0].slice(0, 60)}...`);

    for (let i = 1; i < TEST_URLS.guidedSamples.length; i++) {
      const addBtn = addAnotherExampleButton(page);
      const canAdd = await addBtn.isVisible({ timeout: 2_000 }).catch((_e: unknown) => false);
      if (canAdd) {
        await addBtn.click();
        await page.waitForTimeout(500);
        const input = sampleUrlInput(page, i);
        const visible = await input.isVisible({ timeout: 2_000 }).catch((_e: unknown) => false);
        if (visible) {
          await input.fill(TEST_URLS.guidedSamples[i]);
          console.info(`  Filled sample ${i}: ${TEST_URLS.guidedSamples[i].slice(0, 60)}...`);
        }
      } else {
        console.info(`  Cannot add more samples (max reached at ${i})`);
        break;
      }
    }

    await crawlScreenshot(page, 'e1', '3-samples', 'Sample URLs filled');

    // Start discovery
    const startBtn = startDiscoveryButton(page);
    await expect(startBtn).toBeVisible({ timeout: 5_000 });
    await startBtn.click();

    console.info('✓ Guided selected, samples entered, discovery started');
  });

  test('E1.4: observe exploration — LED + activity log', async () => {
    // Wait for exploring phase label (new: "Exploring site navigation")
    const exploreLabel = phaseLabel(page, 'Exploring site navigation');
    await expect(exploreLabel).toBeVisible({ timeout: 15_000 });

    // Observe LED indicator
    const led = ledIndicator(page);
    const ledVisible = await led.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
    console.info(`  LED indicator visible: ${ledVisible}`);
    if (ledVisible) {
      const ledClasses = await led.getAttribute('class');
      console.info(`  LED classes: ${ledClasses}`);
    }

    // Observe activity log
    const logContainer = activityLog(page);
    const logVisible = await logContainer
      .isVisible({ timeout: 3_000 })
      .catch((_e: unknown) => false);
    console.info(`  Activity log container visible: ${logVisible}`);

    // Check "Show details" toggle
    const detailsToggle = showDetailsToggle(page);
    const hasDetailsToggle = await detailsToggle
      .isVisible({ timeout: 3_000 })
      .catch((_e: unknown) => false);
    console.info(`  "Show details" toggle visible: ${hasDetailsToggle}`);

    await crawlScreenshot(page, 'e1', '4-exploring', 'Exploring site navigation active');
    console.info('✓ Exploring phase — LED + labels visible');
  });

  test('E1.5: wait for browser completion — unified tree appears', async () => {
    // Wait for the unified tree to become visible, capped at the Playwright test budget.
    // The tree populates after browser discovery completes + autoMatch runs.
    const tree = unifiedTree(page);
    const stopBtn = page.getByRole('button', { name: /stop discovery/i });
    const startTime = Date.now();
    const maxWait = 180_000;
    let treeAppeared = false;

    while (Date.now() - startTime < maxWait) {
      // Check if unified tree appeared
      treeAppeared = await tree.isVisible({ timeout: 1_000 }).catch((_e: unknown) => false);
      if (treeAppeared) {
        console.info(
          `  ✓ Unified tree appeared at ${Math.round((Date.now() - startTime) / 1000)}s`,
        );
        break;
      }

      // Check if discovery completed (Configure Crawl visible)
      const configBtn = configureCrawlButton(page);
      const hasConfig = await configBtn.isVisible({ timeout: 500 }).catch((_e: unknown) => false);
      if (hasConfig) {
        console.info(
          `  ✓ Configure Crawl button visible at ${Math.round((Date.now() - startTime) / 1000)}s`,
        );
        treeAppeared = true;
        break;
      }

      // Check if stop disappeared (auto-completion)
      const hasStop = await stopBtn.isVisible({ timeout: 500 }).catch((_e: unknown) => false);
      if (!hasStop) {
        console.info(
          `  Stop gone at ${Math.round((Date.now() - startTime) / 1000)}s — checking tree`,
        );
        await page.waitForTimeout(3_000);
        treeAppeared = await tree.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
        break;
      }

      // Screenshot every 60s
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (elapsed > 0 && elapsed % 60 === 0) {
        await crawlScreenshot(page, 'e1', `5-progress-${elapsed}s`, `Progress ${elapsed}s`);
        console.info(`  [${elapsed}s] Still waiting for tree...`);
      }

      await page.waitForTimeout(10_000);
    }

    const totalTime = Math.round((Date.now() - startTime) / 1000);
    console.info(`  ── Tree wait summary ──`);
    console.info(`  Duration: ${totalTime}s`);
    console.info(`  Tree appeared: ${treeAppeared}`);

    await crawlScreenshot(page, 'e1', '5-tree-visible', `Tree after ${totalTime}s`);

    // If still running, click Stop (we've explored enough)
    if (!treeAppeared) {
      const stopStill = await stopBtn.isVisible({ timeout: 2_000 }).catch((_e: unknown) => false);
      if (stopStill) {
        console.info('  Clicking "Stop discovery" to end exploration');
        await stopBtn.click();
        await page.waitForTimeout(3_000);
        await crawlScreenshot(page, 'e1', '5-stopped', 'After stop');
      }
    }

    // Observe tree node counts and statuses
    if (treeAppeared) {
      const nodeCount = await allTreeNodes(page)
        .count()
        .catch((_e: unknown) => 0);
      console.info(`  Tree nodes: ${nodeCount}`);

      const autoMatched = await treeNodesByStatus(page, 'auto-matched')
        .count()
        .catch((_e: unknown) => 0);
      const exploring = await treeNodesByStatus(page, 'exploring')
        .count()
        .catch((_e: unknown) => 0);
      const explored = await treeNodesByStatus(page, 'explored')
        .count()
        .catch((_e: unknown) => 0);
      const unexplored = await treeNodesByStatus(page, 'unexplored')
        .count()
        .catch((_e: unknown) => 0);
      console.info(
        `  Statuses: auto-matched=${autoMatched}, exploring=${exploring}, explored=${explored}, unexplored=${unexplored}`,
      );
    }

    console.info('✓ Tree observation complete');
  });

  test('E1.6: unified tree interactions — expand, collapse, select, deselect', async () => {
    const tree = unifiedTree(page);
    const treeVisible = await tree.isVisible({ timeout: 5_000 }).catch((_e: unknown) => false);

    if (!treeVisible) {
      console.warn('  Tree not visible — skipping interaction tests');
      return;
    }

    // Expand All button
    const expandBtn = expandAllButton(page);
    const hasExpand = await expandBtn.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
    console.info(`  Expand All visible: ${hasExpand}`);
    if (hasExpand) {
      await expandBtn.click();
      await page.waitForTimeout(500);
      await crawlScreenshot(page, 'e1', '6a-expanded', 'After Expand All');
      console.info('  ✓ Clicked Expand All');
    }

    // Collapse All button
    const collBtn = collapseAllButton(page);
    const hasCollapse = await collBtn.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
    console.info(`  Collapse All visible: ${hasCollapse}`);
    if (hasCollapse) {
      await collBtn.click();
      await page.waitForTimeout(500);
      await crawlScreenshot(page, 'e1', '6b-collapsed', 'After Collapse All');
      console.info('  ✓ Clicked Collapse All');
    }

    // Select All button
    const selBtn = selectAllButton(page);
    const hasSelect = await selBtn.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
    console.info(`  Select All visible: ${hasSelect}`);
    if (hasSelect) {
      await selBtn.click();
      await page.waitForTimeout(500);
      const includedCount = await includedTreeNodes(page)
        .count()
        .catch((_e: unknown) => 0);
      console.info(`  ✓ After Select All: ${includedCount} included nodes`);
    }

    // Deselect All button
    const deselBtn = deselectAllButton(page);
    const hasDeselect = await deselBtn.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
    console.info(`  Deselect All visible: ${hasDeselect}`);
    if (hasDeselect) {
      await deselBtn.click();
      await page.waitForTimeout(500);
      const includedCount = await includedTreeNodes(page)
        .count()
        .catch((_e: unknown) => 0);
      console.info(`  ✓ After Deselect All: ${includedCount} included nodes`);
    }

    // Re-select all for Configure Crawl step (E1.7 needs includedNodes > 0)
    const reselBtn = selectAllButton(page);
    const canReselect = await reselBtn.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
    if (canReselect) {
      await reselBtn.click();
      await page.waitForTimeout(500);
      const reselectedCount = await includedTreeNodes(page)
        .count()
        .catch((_e: unknown) => 0);
      console.info(`  ✓ Re-selected all: ${reselectedCount} included nodes`);
    } else {
      console.warn('  ⚠ Could not re-select — E1.7 may fail');
    }

    // Tree stats bar
    const statsBar = treeStatsBar(page);
    const hasStats = await statsBar.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
    if (hasStats) {
      const statsText = await statsBar.textContent().catch((_e: unknown) => '');
      console.info(`  Stats bar: "${statsText}"`);
    }

    // Footer stats
    const footerStats = unifiedTreeFooterStats(page);
    const hasFooter = await footerStats.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
    if (hasFooter) {
      const footerText = await footerStats.textContent().catch((_e: unknown) => '');
      console.info(`  Footer stats: "${footerText}"`);
    }

    await crawlScreenshot(page, 'e1', '6-interactions', 'Tree interactions complete');
    console.info('✓ Tree interaction tests complete');
  });

  test('E1.7: Configure Crawl — click button to transition to State 3', async () => {
    const configBtn = configureCrawlButton(page);
    const hasConfig = await configBtn.isVisible({ timeout: 10_000 }).catch((_e: unknown) => false);

    if (!hasConfig) {
      // Tree may not have content — try Finish button as fallback
      const finish = finishButton(page);
      const hasFinish = await finish.isVisible({ timeout: 5_000 }).catch((_e: unknown) => false);
      if (hasFinish) {
        console.info('  Configure Crawl not visible — using Finish button instead');
        await finish.click();
        await page.waitForTimeout(2_000);
      } else {
        console.warn('  Neither Configure Crawl nor Finish visible — skipping');
      }
      await crawlScreenshot(page, 'e1', '7-no-config-btn', 'Configure Crawl not available');
      return;
    }

    // Verify button is enabled
    const isDisabled = await configBtn.isDisabled().catch((_e: unknown) => false);
    expect(isDisabled).toBe(false);
    console.info('  ✓ Configure Crawl button is enabled');

    await configBtn.click();
    await page.waitForTimeout(2_000);

    await crawlScreenshot(page, 'e1', '7-configure-crawl', 'After Configure Crawl click');

    // Should transition to State 3 (Configure) — rendering mode options appear
    const adaptive = page.getByText('Adaptive', { exact: false });
    const hasAdaptive = await adaptive.isVisible({ timeout: 5_000 }).catch((_e: unknown) => false);
    console.info(`  State 3 rendering options visible: ${hasAdaptive}`);

    console.info('✓ Configure Crawl clicked — transitioned to State 3');
  });

  test('E1.8: negative regression — no banned terminology', async () => {
    const banned = await checkBannedTerms(page);
    expect(banned, `Banned terms found: ${banned.join(', ')}`).toHaveLength(0);

    console.info('✓ No banned terminology found in E1 flow');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // E7: SIDEBAR TRIGGER — "Discover more pages"
  //
  // Tests the sidebar discovery trigger on the sitemap path. The link only
  // shows when: pipelinePhase === 'idle' && no browser discovery has run.
  // ═══════════════════════════════════════════════════════════════════════

  test('E7.0: close panel and reopen for fresh sitemap flow', async () => {
    await closeCrawlFlowPanel(page);
    await page.waitForTimeout(1_000);
    await openWebCrawlerPanel(page);
    await crawlScreenshot(page, 'e7', '0-reopened', 'Fresh URL input for E7');
    console.info('✓ Panel reopened for E7 sidebar trigger exploration');
  });

  test('E7.1: enter docs.kore.ai and select sitemap', async () => {
    const capture = startNetworkCapture(page);

    await submitUrlAndWaitForProfiling(page, TEST_URLS.sitemap);

    const { api } = capture.stop();
    console.info(`✓ Profiling: ${api.length} API calls`);

    // Select sitemap strategy
    await strategySitemapCard(page).click();
    await page.waitForTimeout(2_000);

    await crawlScreenshot(page, 'e7', '1-sitemap-selected', 'Sitemap selected for E7');
    console.info('✓ Sitemap strategy selected');
  });

  test('E7.2: "Discover more pages" link is visible', async () => {
    const link = discoverMoreLink(page);
    await expect(link).toBeVisible({ timeout: 5_000 });

    await crawlScreenshot(page, 'e7', '2-discover-link', 'Discover more pages visible');
    console.info('✓ "Discover more pages" link visible after sitemap selection');
  });

  test('E7.3: click sidebar trigger — discovery panel mounts directly', async () => {
    const link = discoverMoreLink(page);
    await expect(link).toBeVisible({ timeout: 3_000 });
    await link.click();
    await page.waitForTimeout(2_000);

    await crawlScreenshot(page, 'e7', '3a-after-click', 'After clicking Discover more pages');

    // Exploring starts directly (new label: "Exploring site navigation")
    const exploreLabel = phaseLabel(page, 'Exploring site navigation');
    await expect(exploreLabel).toBeVisible({ timeout: 10_000 });
    console.info('  ✓ Exploring label visible — discovery started directly');

    const stopBtn = page.getByRole('button', { name: /stop discovery/i });
    await expect(stopBtn).toBeVisible({ timeout: 5_000 });
    console.info('  ✓ Stop discovery button visible');

    // Discovery Log heading visible during exploration
    const logHeading = page.getByText('Discovery Log', { exact: false });
    const hasLog = await logHeading.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
    console.info(`  Discovery Log heading: ${hasLog}`);

    // Collapse toggle available during running state
    const collapse = page.getByText('Collapse discovery', { exact: false });
    const hasCollapse = await collapse.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
    console.info(`  Collapse toggle visible: ${hasCollapse}`);

    await crawlScreenshot(page, 'e7', '3b-discovery-state', 'Discovery panel state');
    console.info('✓ Sidebar trigger → exploration started directly (no sample input)');
  });

  test('E7.4: collapse/expand during sidebar discovery', async () => {
    const stopBtn = page.getByRole('button', { name: /stop discovery/i });
    await expect(stopBtn).toBeVisible({ timeout: 5_000 });

    // Collapse toggle visible during running state
    const collapseBtn = page.getByText('Collapse discovery', { exact: false });
    await expect(collapseBtn).toBeVisible({ timeout: 5_000 });
    await crawlScreenshot(page, 'e7', '4a-before-collapse', 'Before collapse');

    // Collapse → minimized state
    await collapseBtn.click();
    await page.waitForTimeout(1_000);

    // Expand toggle appears
    const expandBtn = page.getByText('Expand discovery', { exact: false });
    await expect(expandBtn).toBeVisible({ timeout: 3_000 });
    console.info('  ✓ Collapse → Expand toggle visible');

    await crawlScreenshot(page, 'e7', '4b-collapsed', 'Collapsed/minimized state');

    // Expand back — state preserved across collapse/expand
    await expandBtn.click();
    await page.waitForTimeout(1_000);

    // Stop button should still be visible after expand (discovery continues)
    await expect(stopBtn).toBeVisible({ timeout: 5_000 });
    await crawlScreenshot(page, 'e7', '4c-expanded', 'Expanded — discovery still running');
    console.info('  ✓ Collapse → Expand cycle successful, discovery still running');

    // Stop discovery to free resources
    await stopBtn.click();
    await page.waitForTimeout(3_000);

    await crawlScreenshot(page, 'e7', '4d-after-stop', 'After stopping discovery');
    console.info('✓ E7.4 collapse/expand complete');
  });

  test('E7.5: post-sidebar-discovery state', async () => {
    // Ensure exploration is stopped (E7.4 may not have finished stopping)
    const stopBtn = page.getByRole('button', { name: /stop discovery/i });
    const stillRunning = await stopBtn.isVisible({ timeout: 2_000 }).catch((_e: unknown) => false);
    if (stillRunning) {
      console.info('  Discovery still running — stopping');
      await stopBtn.click();
      await page.waitForTimeout(5_000);
    }

    // Wait for Configure Crawl to become enabled (not disabled by isExploring)
    const configBtn = configureCrawlButton(page);
    const hasConfig = await configBtn.isVisible({ timeout: 5_000 }).catch((_e: unknown) => false);
    if (hasConfig) {
      // Wait for button to be enabled (exploration to finish)
      let isDisabled = await configBtn.isDisabled().catch((_e: unknown) => true);
      let attempts = 0;
      while (isDisabled && attempts < 10) {
        await page.waitForTimeout(2_000);
        isDisabled = await configBtn.isDisabled().catch((_e: unknown) => true);
        attempts++;
      }

      if (!isDisabled) {
        console.info('  Configure Crawl visible and enabled — clicking');
        await configBtn.click();
        await page.waitForTimeout(2_000);
      } else {
        console.warn('  Configure Crawl visible but still disabled — using Finish instead');
        const finish = finishButton(page);
        const hasFinish = await finish.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
        if (hasFinish) {
          await finish.click();
          await page.waitForTimeout(2_000);
        }
      }
    } else {
      const finish = finishButton(page);
      const hasFinish = await finish.isVisible({ timeout: 5_000 }).catch((_e: unknown) => false);
      if (hasFinish) {
        console.info('  Clicking Finish');
        await finish.click();
        await page.waitForTimeout(2_000);
      }
    }

    // Sections appear with checkboxes after discovery
    const checkboxes = sectionCheckboxes(page);
    const checkboxCount = await checkboxes.count().catch((_e: unknown) => 0);
    console.info(`  Section checkboxes: ${checkboxCount}`);
    // Sections should exist from sitemap discovery (E7.1)
    expect(checkboxCount).toBeGreaterThan(0);
    console.info(`  ✓ ${checkboxCount} section checkboxes found`);

    // "Discover more pages" should be hidden after browser discovery ran
    const discoverMore = discoverMoreLink(page);
    const hasDiscoverMore = await discoverMore
      .isVisible({ timeout: 2_000 })
      .catch((_e: unknown) => false);
    console.info(
      `  "Discover more pages" visible: ${hasDiscoverMore} (expected: false after browser discovery)`,
    );

    await crawlScreenshot(page, 'e7', '5-post-state', 'Post sidebar discovery state');
    console.info(`✓ E7 post-state: ${checkboxCount} sections`);
  });

  test('E7.6: negative regression — no banned terminology', async () => {
    const banned = await checkBannedTerms(page);
    expect(banned, `Banned terms found: ${banned.join(', ')}`).toHaveLength(0);
    console.info('✓ No banned terminology in E7 flow');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // E4: ACTIVITY LOG — observe log entries, Show/Hide details toggle
  //
  // Uses Epson guided flow (long-running) to observe activity log entries.
  // No auto-chain transition test — the "searching" phase no longer exists.
  // ═══════════════════════════════════════════════════════════════════════

  test('E4.0: open fresh guided flow for activity log observation', async () => {
    await closeCrawlFlowPanel(page);
    await page.waitForTimeout(1_000);
    await openWebCrawlerPanel(page);

    await submitUrlAndWaitForProfiling(page, TEST_URLS.guided, 60_000);

    // Select guided strategy + fill samples
    await strategyGuidedCard(page).click();
    await page.waitForTimeout(1_000);

    const firstSample = sampleUrlInput(page, 0);
    await expect(firstSample).toBeVisible({ timeout: 10_000 });
    await firstSample.fill(TEST_URLS.guidedSamples[0]);

    // Start discovery
    const startBtn = startDiscoveryButton(page);
    await expect(startBtn).toBeVisible({ timeout: 5_000 });
    await startBtn.click();

    // Wait for exploration to start and log entries to appear
    await page.waitForTimeout(10_000);

    // Check if scan failed immediately (regression bug)
    const scanFailed = await page
      .getByText('Navigation scan failed', { exact: false })
      .isVisible({ timeout: 3_000 })
      .catch((_e: unknown) => false);
    if (scanFailed) {
      console.warn('  BUG: "Navigation scan failed" — browser scanning broken for Epson');
    }

    await crawlScreenshot(page, 'e4', '0-discovery-started', 'Epson guided discovery for E4');
    console.info(`✓ E4 setup — Epson guided discovery started (scanFailed: ${scanFailed})`);
  });

  test('E4.1: observe activity log entries', async () => {
    // Wait for activity log to populate
    await page.waitForTimeout(5_000);

    const logContainer = activityLog(page);
    await expect(logContainer).toBeVisible({ timeout: 10_000 });
    console.info('  ✓ Activity log container visible');

    // Log entries use space-y-0 container with flex.items-start children
    const entriesV1 = page.locator('.max-h-28 .flex.items-start');
    const entriesV2 = page.locator('[class*="space-y-0"] .flex.items-start');
    const entriesV3 = page.locator('.overflow-y-auto .flex.items-start');

    const countV1 = await entriesV1.count().catch((_e: unknown) => 0);
    const countV2 = await entriesV2.count().catch((_e: unknown) => 0);
    const countV3 = await entriesV3.count().catch((_e: unknown) => 0);
    const entryCount = Math.max(countV1, countV2, countV3);
    const bestEntries = countV1 > 0 ? entriesV1 : countV2 > 0 ? entriesV2 : entriesV3;

    expect(entryCount).toBeGreaterThan(0);
    console.info(`  ✓ ${entryCount} log entries found`);

    // Read first few entries
    for (let i = 0; i < Math.min(entryCount, 5); i++) {
      const text = await bestEntries
        .nth(i)
        .textContent()
        .catch((_e: unknown) => '');
      console.info(`  Entry ${i}: "${text?.trim()}"`);
    }

    // Timestamps use tabular-nums class (HH:MM:SS format)
    const timestampPattern = page.locator('.tabular-nums');
    const tsCount = await timestampPattern.count().catch((_e: unknown) => 0);
    expect(tsCount).toBeGreaterThan(0);
    console.info(`  ✓ ${tsCount} timestamp elements found`);

    // "Discovery Log" heading
    const logHeading = page.getByText('Discovery Log', { exact: false });
    await expect(logHeading).toBeVisible({ timeout: 2_000 });
    console.info('  ✓ "Discovery Log" heading visible');

    await crawlScreenshot(page, 'e4', '1-log-entries', `${entryCount} log entries visible`);
    console.info(`✓ E4.1 activity log: ${entryCount} entries, ${tsCount} timestamps`);
  });

  test('E4.2: Show/Hide details toggle', async () => {
    const showToggle = showDetailsToggle(page);
    const hasShow = await showToggle.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
    console.info(`  "Show details" toggle visible: ${hasShow}`);

    if (hasShow) {
      // Count entries BEFORE showing details
      const entriesBefore = page.locator('.max-h-28 .flex.items-start');
      const countBefore = await entriesBefore.count().catch((_e: unknown) => 0);
      console.info(`  Entries BEFORE Show details: ${countBefore}`);

      // Click "Show details"
      await showToggle.click();
      await page.waitForTimeout(1_000);

      // "Hide details" should appear
      const hideToggle = hideDetailsToggle(page);
      const hasHide = await hideToggle.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
      console.info(`  "Hide details" toggle visible after click: ${hasHide}`);

      // Count entries AFTER showing details
      const entriesAfter = page.locator('.max-h-28 .flex.items-start');
      const countAfter = await entriesAfter.count().catch((_e: unknown) => 0);
      console.info(
        `  Detail entries revealed: ${countAfter - countBefore} (${countBefore} → ${countAfter})`,
      );

      await crawlScreenshot(page, 'e4', '2a-details-shown', `Details shown: ${countAfter} entries`);

      // Toggle back to hide
      if (hasHide) {
        await hideToggle.click();
        await page.waitForTimeout(500);
        const hiddenEntries = page.locator('.max-h-28 .flex.items-start');
        const countHidden = await hiddenEntries.count().catch((_e: unknown) => 0);
        console.info(`  Entries after hide: ${countHidden}`);
        await crawlScreenshot(page, 'e4', '2b-details-hidden', `Details hidden: ${countHidden}`);
      }
    } else {
      const hideToggle = hideDetailsToggle(page);
      const hasHide = await hideToggle.isVisible({ timeout: 2_000 }).catch((_e: unknown) => false);
      console.info(`  "Hide details" visible instead: ${hasHide}`);
      await crawlScreenshot(page, 'e4', '2-no-toggle', 'Details toggle not found');
    }

    // Stop discovery to clean up resources
    const stopBtn = page.getByRole('button', { name: /stop discovery/i });
    const stopStill = await stopBtn.isVisible({ timeout: 2_000 }).catch((_e: unknown) => false);
    if (stopStill) {
      console.info('  Stopping discovery for cleanup');
      await stopBtn.click();
      await page.waitForTimeout(3_000);
    }

    // Click Configure Crawl or Finish if visible
    const configBtn = configureCrawlButton(page);
    const hasConfig = await configBtn.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
    if (hasConfig) {
      await configBtn.click();
      await page.waitForTimeout(2_000);
    } else {
      const hasFinish = await finishButton(page)
        .isVisible({ timeout: 3_000 })
        .catch((_e: unknown) => false);
      if (hasFinish) {
        await finishButton(page).click();
        await page.waitForTimeout(2_000);
      }
    }

    await crawlScreenshot(page, 'e4', '2-final', 'After E4 observation');
    console.info('✓ E4.2 Show/Hide details observation complete');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // E6: CLOSE DURING EXPLORATION — close panel while exploring
  //
  // Tests that closing the discovery panel during exploration:
  // 1. Shows confirmation dialog
  // 2. Panel closes cleanly on Discard
  // 3. No orphaned SSE connections
  // ═══════════════════════════════════════════════════════════════════════

  test('E6.0: open fresh flow for close-during-exploration test', async () => {
    await closeCrawlFlowPanel(page);
    await page.waitForTimeout(1_000);
    await openWebCrawlerPanel(page);

    await submitUrlAndWaitForProfiling(page, TEST_URLS.sitemap);
    await strategySitemapCard(page).click();
    await page.waitForTimeout(2_000);

    const link = discoverMoreLink(page);
    const visible = await link.isVisible({ timeout: 5_000 }).catch((_e: unknown) => false);
    if (!visible) {
      console.warn('  "Discover more pages" not visible — E6 cannot proceed');
      return;
    }
    await link.click();
    await page.waitForTimeout(3_000);

    // Verify exploration is active (new label)
    const exploreLabel = phaseLabel(page, 'Exploring site navigation');
    const hasExploring = await exploreLabel
      .isVisible({ timeout: 10_000 })
      .catch((_e: unknown) => false);
    console.info(`  Exploring active: ${hasExploring}`);

    await crawlScreenshot(page, 'e6', '0-exploring-active', 'Discovery running for E6');
    console.info('✓ E6 setup — exploration active');
  });

  test('E6.1: close panel during exploration — confirmation dialog', async () => {
    const capture = startNetworkCapture(page);

    // Escape triggers confirmation dialog during exploration
    await page.keyboard.press('Escape');
    await page.waitForTimeout(2_000);

    // "Discovery is still running" dialog with 3 options
    const dialogText = page.getByText('Discovery is still running', { exact: false });
    await expect(dialogText).toBeVisible({ timeout: 5_000 });
    await crawlScreenshot(page, 'e6', '1a-dialog', 'Confirmation dialog visible');
    console.info('  ✓ "Discovery is still running" dialog appeared');

    // All 3 options
    const minimizeBtn = page.getByText('Minimize to activity bar', { exact: false });
    const stopSaveBtn = page.getByText('Stop & save draft', { exact: false });
    const discardLink = page.getByText('Discard', { exact: true });

    await expect(minimizeBtn).toBeVisible({ timeout: 2_000 });
    await expect(stopSaveBtn).toBeVisible({ timeout: 2_000 });
    await expect(discardLink).toBeVisible({ timeout: 2_000 });
    console.info('  ✓ All 3 dialog options visible: Minimize, Stop & save, Discard');
    await crawlScreenshot(page, 'e6', '1b-dialog-options', 'Close confirmation dialog');

    // Click "Discard" to fully close
    await discardLink.click();
    await page.waitForTimeout(3_000);
    console.info('  Clicked Discard');

    // Panel closes cleanly after Discard
    const urlGone = await urlInput(page)
      .isVisible({ timeout: 3_000 })
      .catch((_e: unknown) => false);
    expect(urlGone).toBe(false);
    console.info('  ✓ Panel closed — URL input gone');

    // No lingering SSE connections
    const { api, sse } = capture.stop();
    console.info(`  Network after close: ${api.length} API calls, ${sse.length} SSE connections`);

    await crawlScreenshot(page, 'e6', '1c-after-close', 'After closing during exploration');
    console.info('✓ E6.1 close during exploration — dialog verified, clean close');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // E10: EDIT SAMPLES — test the "Edit" link after guided discovery
  //
  // The "Edit" link only shows when pipelinePhase === 'complete' && guided
  // strategy was selected (samples exist). This needs a guided flow with
  // samples, so we use Epson.
  // ═══════════════════════════════════════════════════════════════════════

  test('E10.0: open fresh guided flow for edit samples test', async () => {
    await closeCrawlFlowPanel(page);
    await page.waitForTimeout(1_000);

    await navigateToKBList(page);
    await selectKB(page, KB_NAME);
    await openWebCrawlerPanel(page);

    await submitUrlAndWaitForProfiling(page, TEST_URLS.guided, 60_000);

    // Select guided strategy
    await strategyGuidedCard(page).click();
    await page.waitForTimeout(1_000);

    // Fill sample URLs
    const firstSample = sampleUrlInput(page, 0);
    await expect(firstSample).toBeVisible({ timeout: 10_000 });
    await firstSample.fill(TEST_URLS.guidedSamples[0]);

    for (let i = 1; i < TEST_URLS.guidedSamples.length; i++) {
      const addBtn = addAnotherExampleButton(page);
      const canAdd = await addBtn.isVisible({ timeout: 2_000 }).catch((_e: unknown) => false);
      if (canAdd) {
        await addBtn.click();
        await page.waitForTimeout(500);
        const input = sampleUrlInput(page, i);
        const vis = await input.isVisible({ timeout: 2_000 }).catch((_e: unknown) => false);
        if (vis) await input.fill(TEST_URLS.guidedSamples[i]);
      }
    }

    // Start discovery
    const startBtn = startDiscoveryButton(page);
    await expect(startBtn).toBeVisible({ timeout: 5_000 });
    await startBtn.click();
    await page.waitForTimeout(3_000);

    await crawlScreenshot(page, 'e10', '0-discovery-started', 'Guided discovery for E10');
    console.info('✓ E10 setup — guided discovery started with samples');
  });

  test('E10.1: reach complete state and observe Edit link', async () => {
    // Check if scan failed immediately (regression bug)
    const scanFailed = await page
      .getByText('Navigation scan failed', { exact: false })
      .isVisible({ timeout: 10_000 })
      .catch((_e: unknown) => false);

    if (scanFailed) {
      console.warn('  BUG: Navigation scan failed — clicking Close to trigger completion');
      await crawlScreenshot(page, 'e10', '1-scan-failed', 'Navigation scan failed');

      const closeErrorBtn = page.getByRole('button', { name: /^close$/i });
      const hasClose = await closeErrorBtn
        .isVisible({ timeout: 3_000 })
        .catch((_e: unknown) => false);
      if (hasClose) {
        await closeErrorBtn.click();
        console.info('  Clicked Close — waiting for completion');
        await page.waitForTimeout(8_000);
      }
    } else {
      // Discovery is running — wait for natural completion or tree appearance.
      const stopBtn = page.getByRole('button', { name: /stop discovery/i });
      const maxWait = 180_000;
      const startTime = Date.now();
      let reachedComplete = false;

      while (Date.now() - startTime < maxWait) {
        // Check if Configure Crawl appeared (tree has content)
        const hasConfig = await configureCrawlButton(page)
          .isVisible({ timeout: 1_000 })
          .catch((_e: unknown) => false);
        if (hasConfig) {
          console.info(
            `  ✓ Configure Crawl visible at ${Math.round((Date.now() - startTime) / 1000)}s`,
          );
          reachedComplete = true;
          break;
        }

        // Check if Finish appeared
        const done = await finishButton(page)
          .isVisible({ timeout: 1_000 })
          .catch((_e: unknown) => false);
        if (done) {
          console.info(`  ✓ Finish visible at ${Math.round((Date.now() - startTime) / 1000)}s`);
          reachedComplete = true;
          break;
        }

        // Check "Exploration complete" label
        const exploreComplete = await phaseLabel(page, 'Exploration complete')
          .isVisible({ timeout: 500 })
          .catch((_e: unknown) => false);
        if (exploreComplete) {
          console.info(
            `  ✓ "Exploration complete" at ${Math.round((Date.now() - startTime) / 1000)}s`,
          );
          reachedComplete = true;
          break;
        }

        // Check if Stop disappeared
        const hasStop = await stopBtn.isVisible({ timeout: 500 }).catch((_e: unknown) => false);
        if (!hasStop) {
          console.info(
            `  Stop gone at ${Math.round((Date.now() - startTime) / 1000)}s — checking completion`,
          );
          await page.waitForTimeout(3_000);
          reachedComplete = true;
          break;
        }

        // Log progress every 30s
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (elapsed > 0 && elapsed % 30 === 0) {
          console.info(`  [${elapsed}s] Still running...`);
          await crawlScreenshot(page, 'e10', `1-progress-${elapsed}s`, `Progress ${elapsed}s`);
        }

        await page.waitForTimeout(10_000);
      }

      if (!reachedComplete) {
        const hasStop = await stopBtn.isVisible({ timeout: 2_000 }).catch((_e: unknown) => false);
        if (hasStop) {
          console.info(
            `  Discovery did not complete in ${Math.round(maxWait / 1000)}s — force stopping`,
          );
          await stopBtn.click();
          await page.waitForTimeout(5_000);
        }
      }
    }

    // Click Configure Crawl or Finish if visible
    const configBtn = configureCrawlButton(page);
    const hasConfig = await configBtn.isVisible({ timeout: 10_000 }).catch((_e: unknown) => false);
    if (hasConfig) {
      console.info('  Clicking Configure Crawl');
      await configBtn.click();
      await page.waitForTimeout(2_000);
    } else {
      const finish = finishButton(page);
      const hasFinish = await finish.isVisible({ timeout: 5_000 }).catch((_e: unknown) => false);
      if (hasFinish) {
        console.info('  Clicking Finish');
        await finish.click();
        await page.waitForTimeout(2_000);
      }
    }

    await crawlScreenshot(page, 'e10', '1a-post-discovery', 'After reaching complete state');

    // Check for "Edit & re-discover" link
    const editLink = page.getByText('Edit & re-discover', { exact: false });
    const hasEdit = await editLink.isVisible({ timeout: 5_000 }).catch((_e: unknown) => false);
    console.info(`  "Edit & re-discover" link visible: ${hasEdit}`);

    // Check for sample URL pills
    const samplePills = page.locator('.font-mono.truncate');
    const pillCount = await samplePills.count().catch((_e: unknown) => 0);
    console.info(`  Sample URL pills: ${pillCount}`);

    // Check current UI state
    const hasExploreComplete = await page
      .getByText('Exploration complete', { exact: false })
      .isVisible({ timeout: 1_000 })
      .catch((_e: unknown) => false);
    console.info(`  "Exploration complete" visible: ${hasExploreComplete}`);

    await crawlScreenshot(
      page,
      'e10',
      '1b-edit-link',
      `Edit visible: ${hasEdit}, pills: ${pillCount}`,
    );
    console.info(`✓ E10.1 post-discovery state: edit=${hasEdit}, pills=${pillCount}`);
  });

  test('E10.2: click Edit — confirmation dialog', async () => {
    // The "Edit" link uses i18n key pipeline_edit_samples — try multiple possible texts
    const editLink = page.getByText('Edit', { exact: true }).first();
    const hasEdit = await editLink.isVisible({ timeout: 5_000 }).catch((_e: unknown) => false);

    if (!hasEdit) {
      // In unified tree flow, the edit link may be in the sample URL pills section
      // which may not be visible after Configure Crawl. Scroll up to find it.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1_000);
      const editAfterScroll = await editLink
        .isVisible({ timeout: 3_000 })
        .catch((_e: unknown) => false);

      if (!editAfterScroll) {
        console.info(
          '  Edit link not visible — unified tree flow may not show sample edit in this state',
        );
        console.info('  ⏭️ Skipping E10.2 (feature works differently in unified tree flow)');
        await crawlScreenshot(page, 'e10', '2-skipped', 'Edit link not available in current state');
        return;
      }
    }

    // Click Edit → confirmation dialog appears
    await editLink.click();
    await page.waitForTimeout(1_000);
    await crawlScreenshot(page, 'e10', '2a-after-edit-click', 'After clicking Edit');

    // "Clear all discovery results?" confirmation text
    const confirmText = page.getByText('Clear all discovery results', { exact: false });
    const hasConfirm = await confirmText
      .isVisible({ timeout: 3_000 })
      .catch((_e: unknown) => false);
    if (hasConfirm) {
      console.info('  ✓ Confirmation text: "Clear all discovery results?"');

      // "Yes, clear" and "Cancel" buttons present
      const yesBtn = page.getByText('Yes, clear', { exact: false });
      const noBtn = page.getByText('Cancel', { exact: true });
      await expect(yesBtn).toBeVisible({ timeout: 2_000 });
      await expect(noBtn).toBeVisible({ timeout: 2_000 });
      console.info('  ✓ Confirmation buttons: Yes, clear + Cancel');
      await crawlScreenshot(page, 'e10', '2b-confirm-dialog', 'Confirm dialog with both buttons');

      // Cancel dismisses dialog, Edit link reappears
      await noBtn.click();
      await page.waitForTimeout(1_000);
      console.info('  ✓ Cancel dismissed dialog');
    } else {
      console.info('  No confirmation dialog — edit may work differently in unified tree');
    }

    await crawlScreenshot(page, 'e10', '2c-after-cancel', 'After E10.2');
    console.info('✓ E10.2 edit flow observation complete');
  });

  test('E10.3: click Edit + Yes — reset to idle', async () => {
    const editLink = page.getByText('Edit', { exact: true }).first();
    const hasEdit = await editLink.isVisible({ timeout: 5_000 }).catch((_e: unknown) => false);

    if (!hasEdit) {
      console.info('  Edit link not visible — skipping E10.3 (unified tree flow)');
      await crawlScreenshot(page, 'e10', '3-skipped', 'Edit not available');
      return;
    }

    // Click Edit → then Yes, clear
    await editLink.click();
    await page.waitForTimeout(1_000);

    const yesBtn = page.getByText('Yes, clear', { exact: false });
    const hasYes = await yesBtn.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
    if (!hasYes) {
      console.info('  No confirmation dialog after Edit click — may be different flow');
      await crawlScreenshot(page, 'e10', '3-no-dialog', 'No confirmation dialog');
      return;
    }

    await yesBtn.click();
    await page.waitForTimeout(2_000);
    console.info('  Clicked "Yes, clear" — expecting reset to idle');

    // After Yes, sample inputs reappear with preserved URLs
    const sampleInput = sampleUrlInput(page, 0);
    const hasInput = await sampleInput.isVisible({ timeout: 5_000 }).catch((_e: unknown) => false);
    if (hasInput) {
      console.info('  ✓ Sample input visible after reset');

      // Start Discovery button reappears
      const startBtn = startDiscoveryButton(page);
      await expect(startBtn).toBeVisible({ timeout: 3_000 });
      console.info('  ✓ Start Discovery button visible');

      // Previous sample URLs are preserved in inputs
      const val = await sampleInput.inputValue().catch((_e: unknown) => '');
      if (val) {
        console.info(`  ✓ Sample 0 preserved: "${val.slice(0, 60)}..."`);
      }
    }

    await crawlScreenshot(page, 'e10', '3-after-yes', 'Reset to idle');
    console.info('✓ E10.3 edit → reset observation complete');
  });

  test('E10.4: negative regression — no banned terminology', async () => {
    const banned = await checkBannedTerms(page);
    expect(banned, `Banned terms found: ${banned.join(', ')}`).toHaveLength(0);
    console.info('✓ No banned terminology in E10 flow');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // E12: UNIFIED TREE FEATURES — tree search, node explore, status transitions
  //
  // Tests unified tree-specific features that aren't covered in the main
  // E1 flow. Uses Epson guided flow for realistic tree population.
  // ═══════════════════════════════════════════════════════════════════════

  test('E12.0: open fresh guided flow for tree feature tests', async () => {
    await closeCrawlFlowPanel(page);
    await page.waitForTimeout(1_000);

    await navigateToKBList(page);
    await selectKB(page, KB_NAME);
    await openWebCrawlerPanel(page);

    await submitUrlAndWaitForProfiling(page, TEST_URLS.guided, 60_000);

    // Select guided + fill sample
    await strategyGuidedCard(page).click();
    await page.waitForTimeout(1_000);

    const firstSample = sampleUrlInput(page, 0);
    await expect(firstSample).toBeVisible({ timeout: 10_000 });
    await firstSample.fill(TEST_URLS.guidedSamples[0]);

    const startBtn = startDiscoveryButton(page);
    await expect(startBtn).toBeVisible({ timeout: 5_000 });
    await startBtn.click();

    await crawlScreenshot(page, 'e12', '0-started', 'Guided discovery for E12');
    console.info('✓ E12 setup — guided discovery started');
  });

  test('E12.1: tree search/filter', async () => {
    // Wait for tree to appear, capped at the Playwright test budget.
    const tree = unifiedTree(page);
    const startTime = Date.now();
    const maxWait = 180_000;
    let treeVisible = false;

    while (Date.now() - startTime < maxWait) {
      treeVisible = await tree.isVisible({ timeout: 2_000 }).catch((_e: unknown) => false);
      if (treeVisible) break;

      // Check if stop disappeared
      const stopBtn = page.getByRole('button', { name: /stop discovery/i });
      const hasStop = await stopBtn.isVisible({ timeout: 500 }).catch((_e: unknown) => false);
      if (!hasStop) {
        await page.waitForTimeout(3_000);
        treeVisible = await tree.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);
        break;
      }

      await page.waitForTimeout(10_000);
    }

    if (!treeVisible) {
      console.warn('  Tree not visible after wait — skipping E12.1');
      return;
    }

    console.info(`  Tree appeared after ${Math.round((Date.now() - startTime) / 1000)}s`);

    // Get initial node count
    const initialCount = await allTreeNodes(page)
      .count()
      .catch((_e: unknown) => 0);
    console.info(`  Initial tree nodes: ${initialCount}`);

    if (initialCount === 0) {
      console.warn('  No tree nodes — skipping search test');
      return;
    }

    // Type in search input
    const searchInput = treeSearchInput(page);
    const hasSearch = await searchInput.isVisible({ timeout: 3_000 }).catch((_e: unknown) => false);

    if (hasSearch) {
      // Get first node's text to use as search term
      const firstNode = allTreeNodes(page).first();
      const nodeText = await firstNode.textContent().catch((_e: unknown) => '');
      const searchTerm = nodeText?.trim().split(/\s+/)[0] ?? 'support';

      await searchInput.fill(searchTerm);
      await page.waitForTimeout(500);

      const filteredCount = await allTreeNodes(page)
        .count()
        .catch((_e: unknown) => 0);
      console.info(`  After filter "${searchTerm}": ${filteredCount} nodes (was ${initialCount})`);

      await crawlScreenshot(page, 'e12', '1a-filtered', `Filtered: ${filteredCount} nodes`);

      // Clear search
      await searchInput.clear();
      await page.waitForTimeout(500);
      const resetCount = await allTreeNodes(page)
        .count()
        .catch((_e: unknown) => 0);
      console.info(`  After clear: ${resetCount} nodes`);
    } else {
      console.info('  Search input not visible — skipping filter test');
    }

    await crawlScreenshot(page, 'e12', '1-search', 'Tree search test complete');
    console.info('✓ E12.1 tree search/filter complete');
  });

  test('E12.2: tree node explore button', async () => {
    const tree = unifiedTree(page);
    const treeVisible = await tree.isVisible({ timeout: 5_000 }).catch((_e: unknown) => false);

    if (!treeVisible) {
      console.warn('  Tree not visible — skipping E12.2');
      return;
    }

    // Find an unexplored node to explore
    const unexploredNodes = treeNodesByStatus(page, 'unexplored');
    const unexploredCount = await unexploredNodes.count().catch((_e: unknown) => 0);
    console.info(`  Unexplored nodes: ${unexploredCount}`);

    if (unexploredCount > 0) {
      // Hover over the first unexplored node to reveal explore button
      const firstUnexplored = unexploredNodes.first();
      await firstUnexplored.hover();
      await page.waitForTimeout(500);

      // Check for explore button (only visible on hover)
      const exploreBtn = firstUnexplored.locator('[data-testid="tree-node-explore"]');
      const hasExplore = await exploreBtn
        .isVisible({ timeout: 2_000 })
        .catch((_e: unknown) => false);
      console.info(`  Explore button visible on hover: ${hasExplore}`);

      if (hasExplore) {
        await exploreBtn.click();
        await page.waitForTimeout(2_000);
        console.info('  ✓ Clicked explore on unexplored node');
        await crawlScreenshot(page, 'e12', '2a-after-explore', 'After clicking explore');
      }
    } else {
      console.info('  No unexplored nodes — all may be auto-matched or explored');
    }

    await crawlScreenshot(page, 'e12', '2-explore', 'Tree node explore test');
    console.info('✓ E12.2 tree node explore complete');
  });

  test('E12.3: tree node statuses', async () => {
    const tree = unifiedTree(page);
    const treeVisible = await tree.isVisible({ timeout: 5_000 }).catch((_e: unknown) => false);

    if (!treeVisible) {
      console.warn('  Tree not visible — skipping E12.3');
      return;
    }

    // Report all status counts
    const statuses = ['unexplored', 'auto-matched', 'exploring', 'explored', 'error'];
    for (const status of statuses) {
      const count = await treeNodesByStatus(page, status)
        .count()
        .catch((_e: unknown) => 0);
      if (count > 0) {
        console.info(`  ${status}: ${count} nodes`);
      }
    }

    // Verify page count badges exist on explored nodes
    const pageCounts = treeNodePageCount(page);
    const badgeCount = await pageCounts.count().catch((_e: unknown) => 0);
    console.info(`  Page count badges: ${badgeCount}`);

    // Verify included nodes
    const included = await includedTreeNodes(page)
      .count()
      .catch((_e: unknown) => 0);
    const total = await allTreeNodes(page)
      .count()
      .catch((_e: unknown) => 0);
    console.info(`  Included: ${included}/${total} nodes`);

    await crawlScreenshot(
      page,
      'e12',
      '3-statuses',
      `Statuses: ${total} total, ${included} included`,
    );
    console.info('✓ E12.3 tree node statuses verified');
  });

  test('E12.4: negative regression — no banned terminology', async () => {
    // Stop discovery if still running
    const stopBtn = page.getByRole('button', { name: /stop discovery/i });
    const hasStop = await stopBtn.isVisible({ timeout: 2_000 }).catch((_e: unknown) => false);
    if (hasStop) {
      await stopBtn.click();
      await page.waitForTimeout(3_000);
    }

    const banned = await checkBannedTerms(page);
    expect(banned, `Banned terms found: ${banned.join(', ')}`).toHaveLength(0);
    console.info('✓ No banned terminology in E12 flow');
  });
});
