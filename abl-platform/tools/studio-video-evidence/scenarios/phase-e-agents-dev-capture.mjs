/**
 * Phase E capture scenario for UI/UX audit.
 *
 * Captures session-heavy surfaces against agents-dev proj-apple-care.
 * Each surface is captured in up to 3 states:
 *   1. Default view (no interaction)
 *   2. Dense interaction state (filters open, row selected, etc.)
 *   3. Issue-surfacing state (sort applied, scroll position, hover)
 *
 * Usage:
 *   STUDIO_URL=https://agents-dev.kore.ai pnpm studio:video:evidence -- \
 *     --scenario phase-e-agents-dev-capture \
 *     --mode existing --skip-ready-check --headed \
 *     --email dev@kore.ai --project-id proj-apple-care
 */

import { STUDIO_SURFACES } from '../lib/studio-harness.mjs';
import { waitForIdle, devLogin, bootstrapStudioBrowserSession } from '../lib/studio-chat.mjs';

/**
 * Phase E surfaces: session/trace/quality/voice analytics with real data.
 * Each entry defines the surface ID and the interaction steps for states 2 and 3.
 */
const PHASE_E_SURFACES = [
  {
    id: 'sessions',
    label: 'Sessions List',
    interactions: {
      state2: async (page, log) => {
        // Click a session row to show detail pane / or open time filter
        const timeFilter = page.locator('button:has-text("Last"), button:has-text("days")').first();
        if (await timeFilter.isVisible({ timeout: 3000 }).catch(() => false)) {
          await timeFilter.click();
          await page.waitForTimeout(1000);
          log('  State 2: Time filter dropdown opened');
        } else {
          // Try clicking the first table row
          const firstRow = page.locator('table tbody tr').first();
          if (await firstRow.isVisible({ timeout: 3000 }).catch(() => false)) {
            await firstRow.click();
            await page.waitForTimeout(2000);
            log('  State 2: First session row clicked');
          }
        }
      },
      state3: async (page, log) => {
        // Click a sort header (e.g., Messages or Duration)
        const sortHeader = page
          .locator('th:has-text("Messages"), th:has-text("Duration"), th:has-text("Traces")')
          .first();
        if (await sortHeader.isVisible({ timeout: 3000 }).catch(() => false)) {
          await sortHeader.click();
          await page.waitForTimeout(1500);
          log('  State 3: Column sort applied');
        }
      },
    },
  },
  {
    id: 'session-detail',
    label: 'Session Detail',
    // We resolve a real session ID at runtime
    resolveParams: true,
    interactions: {
      state2: async (page, log) => {
        // Click on a trace item in the traces panel
        const traceItem = page
          .locator(
            '[data-testid="trace-item"], .trace-item, [class*="trace"] [role="button"], [class*="Trace"] button',
          )
          .first();
        if (await traceItem.isVisible({ timeout: 5000 }).catch(() => false)) {
          await traceItem.click();
          await page.waitForTimeout(2000);
          log('  State 2: Trace item clicked in panel');
        } else {
          // Try clicking a tab like "Traces" or "Metadata"
          const tracesTab = page
            .locator('button:has-text("Traces"), [role="tab"]:has-text("Traces")')
            .first();
          if (await tracesTab.isVisible({ timeout: 3000 }).catch(() => false)) {
            await tracesTab.click();
            await page.waitForTimeout(2000);
            log('  State 2: Traces tab clicked');
          }
        }
      },
      state3: async (page, log) => {
        // Scroll to see more messages if available
        const messageArea = page
          .locator(
            '[data-testid="message-list"], [class*="messages"], [class*="conversation"], main',
          )
          .first();
        if (await messageArea.isVisible({ timeout: 3000 }).catch(() => false)) {
          await messageArea.evaluate((el) => el.scrollBy(0, 400));
          await page.waitForTimeout(1000);
          log('  State 3: Scrolled message area');
        }
      },
    },
  },
  {
    id: 'insights-analytics',
    label: 'Analytics Shell',
    interactions: {
      state2: async (page, log) => {
        // Click Sessions Explorer sub-tab
        const sessionsTab = page
          .locator(
            'button:has-text("Sessions"), [role="tab"]:has-text("Sessions"), a:has-text("Sessions")',
          )
          .first();
        if (await sessionsTab.isVisible({ timeout: 5000 }).catch(() => false)) {
          await sessionsTab.click();
          await page.waitForTimeout(3000);
          await waitForIdle(page, 1000);
          log('  State 2: Sessions Explorer sub-tab clicked');
        }
      },
      state3: async (page, log) => {
        // Click Traces Explorer sub-tab
        const tracesTab = page
          .locator(
            'button:has-text("Traces"), [role="tab"]:has-text("Traces"), a:has-text("Traces")',
          )
          .first();
        if (await tracesTab.isVisible({ timeout: 5000 }).catch(() => false)) {
          await tracesTab.click();
          await page.waitForTimeout(3000);
          await waitForIdle(page, 1000);
          log('  State 3: Traces Explorer sub-tab clicked');
        }
      },
    },
  },
  {
    id: 'insights-quality-monitor',
    label: 'Quality Monitor',
    interactions: {
      state2: async (page, log) => {
        // Scroll to flagged conversations table or click a tab
        const flaggedTab = page
          .locator(
            'button:has-text("Flagged"), [role="tab"]:has-text("Flagged"), a:has-text("Flagged")',
          )
          .first();
        if (await flaggedTab.isVisible({ timeout: 5000 }).catch(() => false)) {
          await flaggedTab.click();
          await page.waitForTimeout(2000);
          log('  State 2: Flagged conversations tab clicked');
        } else {
          // Scroll down to see dimension details
          await page.evaluate(() => window.scrollBy(0, 500));
          await page.waitForTimeout(1000);
          log('  State 2: Scrolled to dimension details');
        }
      },
      state3: async (page, log) => {
        // Click on a dimension detail row to expand it
        const dimensionRow = page
          .locator('[class*="dimension"], [class*="quality"] [role="button"]')
          .first();
        if (await dimensionRow.isVisible({ timeout: 3000 }).catch(() => false)) {
          await dimensionRow.click();
          await page.waitForTimeout(1500);
          log('  State 3: Dimension detail row expanded');
        } else {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(1000);
          log('  State 3: Scrolled to bottom');
        }
      },
    },
  },
  {
    id: 'insights-customer-insights',
    label: 'Customer Insights',
    interactions: {
      state2: async (page, log) => {
        // Change date range or click on a chart section
        const dateRange = page.locator('button:has-text("Last"), button:has-text("days")').first();
        if (await dateRange.isVisible({ timeout: 3000 }).catch(() => false)) {
          await dateRange.click();
          await page.waitForTimeout(1000);
          log('  State 2: Date range dropdown opened');
        }
      },
      state3: async (page, log) => {
        // Scroll to see charts/tables below KPIs
        await page.evaluate(() => window.scrollBy(0, 500));
        await page.waitForTimeout(1500);
        log('  State 3: Scrolled to chart area');
      },
    },
  },
  {
    id: 'insights-voice-analytics',
    label: 'Voice Analytics',
    interactions: {
      state2: async (page, log) => {
        // Click a different time segment
        const segment7d = page
          .locator('button:has-text("7d"), [role="radio"]:has-text("7d")')
          .first();
        if (await segment7d.isVisible({ timeout: 3000 }).catch(() => false)) {
          await segment7d.click();
          await page.waitForTimeout(2000);
          log('  State 2: 7d time segment clicked');
        }
      },
      state3: async (page, log) => {
        await page.evaluate(() => window.scrollBy(0, 400));
        await page.waitForTimeout(1000);
        log('  State 3: Scrolled voice analytics page');
      },
    },
  },
];

// Additional sub-tab surfaces to capture separately
const SUB_TAB_CAPTURES = [
  {
    surfaceId: 'insights-analytics',
    subTab: 'Sessions',
    screenshotPrefix: 'analytics-sessions-explorer',
    label: 'Analytics > Sessions Explorer',
  },
  {
    surfaceId: 'insights-analytics',
    subTab: 'Traces',
    screenshotPrefix: 'analytics-traces-explorer',
    label: 'Analytics > Traces Explorer',
  },
  {
    surfaceId: 'insights-analytics',
    subTab: 'Generations',
    screenshotPrefix: 'analytics-generations',
    label: 'Analytics > Generations',
  },
];

export const scenario = {
  id: 'phase-e-agents-dev-capture',
  title: 'Phase E: agents-dev Session-Heavy Capture',
  description:
    'Captures session/trace/quality/voice analytics surfaces against agents-dev proj-apple-care ' +
    'with real populated data. Each surface captured in 3 states: default, interaction, issue.',
  example:
    'STUDIO_URL=https://agents-dev.kore.ai pnpm studio:video:evidence -- ' +
    '--scenario phase-e-agents-dev-capture --mode existing --skip-ready-check --headed ' +
    '--email dev@kore.ai --project-id proj-apple-care',

  async run(context) {
    const { page, baseUrl, artifacts, log } = context;
    const projectId = context.options.projectId;
    const email = context.options.email || 'dev@kore.ai';

    if (!projectId) {
      throw new Error('Phase E requires --project-id. Use: --project-id proj-apple-care');
    }

    log(`Phase E capture starting against ${baseUrl}`);
    log(`Project: ${projectId}, Email: ${email}`);

    // Step 1: Authenticate
    log('Authenticating via dev-login...');
    const loginResult = await devLogin(baseUrl, { email, name: 'Developer' });
    const { accessToken, refreshToken } = loginResult;

    let tenantId = null;
    try {
      const payloadB64 = accessToken.split('.')[1];
      const decoded = Buffer.from(payloadB64, 'base64').toString('utf-8');
      const payload = JSON.parse(decoded);
      tenantId = payload.tenantId || null;
    } catch {
      log('Warning: Could not extract tenantId from JWT');
    }
    log(`Auth OK: tenantId=${tenantId}`);

    // Step 2: Bootstrap browser session
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        log(`[BROWSER error] ${msg.text().slice(0, 200)}`);
      }
    });

    const landingPath = `/projects/${encodeURIComponent(projectId)}`;
    log('Bootstrapping browser session...');
    await bootstrapStudioBrowserSession(page, baseUrl, {
      accessToken,
      refreshToken,
      tenantId,
      landingPath,
    });

    log('Waiting for full hydration...');
    await page.waitForTimeout(8000);
    await waitForIdle(page, 2000);

    // Step 3: Resolve a real session ID for session-detail capture
    let sessionId = null;
    try {
      const sessionsResponse = await fetch(
        `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/sessions?limit=5`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      const sessionsData = await sessionsResponse.json();
      const sessions = sessionsData.sessions || sessionsData.data || [];
      // Pick the session with the most messages for a rich detail view
      const sorted = sessions.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
      if (sorted.length > 0) {
        sessionId = sorted[0]._id || sorted[0].id;
        log(`Resolved session for detail: ${sessionId} (${sorted[0].messageCount || '?'} msgs)`);
      }
    } catch (err) {
      log(
        `Warning: Could not resolve session ID: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const results = [];
    let successCount = 0;
    let failCount = 0;

    async function capture(name) {
      return artifacts.captureScreenshot(`${name}.png`);
    }

    // Verification screenshot
    await capture('00-phase-e-landing');

    // Step 4: Capture each Phase E surface with 3 states
    for (const surfaceDef of PHASE_E_SURFACES) {
      const surface = STUDIO_SURFACES.find((s) => s.id === surfaceDef.id);
      if (!surface) {
        log(`SKIP: Surface "${surfaceDef.id}" not registered`);
        results.push({ id: surfaceDef.id, status: 'skipped', reason: 'not registered' });
        continue;
      }

      try {
        const params = { projectId };

        // For session-detail, inject the real session ID
        if (surfaceDef.id === 'session-detail' && sessionId) {
          params.sessionId = sessionId;
        }

        const routePath = surface.buildPath(params);
        const route = `${baseUrl}${routePath}`;
        log(`\nCapturing: ${surfaceDef.label} (${surfaceDef.id})`);
        log(`  Route: ${routePath}`);

        // Navigate to surface
        await page.goto(route, { waitUntil: 'domcontentloaded' });
        await surface.waitForReady({ ...context, surface, route, params });
        await page.waitForTimeout(4000);
        await waitForIdle(page, 1500);

        // State 1: Default view
        await capture(`${surfaceDef.id}--default`);
        log('  State 1: Default captured');

        // State 2: Interaction state
        if (surfaceDef.interactions?.state2) {
          try {
            await surfaceDef.interactions.state2(page, log);
            await capture(`${surfaceDef.id}--interaction`);
          } catch (err) {
            log(
              `  State 2 interaction failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            await capture(`${surfaceDef.id}--interaction-fallback`);
          }
        }

        // State 3: Issue-surfacing state
        if (surfaceDef.interactions?.state3) {
          try {
            // Re-navigate to reset state for some surfaces
            if (surfaceDef.id !== 'session-detail') {
              await page.goto(route, { waitUntil: 'domcontentloaded' });
              await surface.waitForReady({ ...context, surface, route, params });
              await page.waitForTimeout(3000);
              await waitForIdle(page, 1000);
            }
            await surfaceDef.interactions.state3(page, log);
            await capture(`${surfaceDef.id}--issue`);
          } catch (err) {
            log(
              `  State 3 interaction failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            await capture(`${surfaceDef.id}--issue-fallback`);
          }
        }

        results.push({ id: surfaceDef.id, status: 'ok', states: 3 });
        successCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  FAIL: ${surfaceDef.id} - ${msg}`);
        await capture(`${surfaceDef.id}--error`).catch(() => {});
        results.push({ id: surfaceDef.id, status: 'error', reason: msg });
        failCount++;
      }
    }

    // Step 5: Capture analytics sub-tab surfaces
    log('\n--- Analytics sub-tab captures ---');
    for (const subTabDef of SUB_TAB_CAPTURES) {
      const surface = STUDIO_SURFACES.find((s) => s.id === subTabDef.surfaceId);
      if (!surface) continue;

      try {
        const params = { projectId };
        const routePath = surface.buildPath(params);
        const route = `${baseUrl}${routePath}`;
        log(`\nCapturing sub-tab: ${subTabDef.label}`);

        await page.goto(route, { waitUntil: 'domcontentloaded' });
        await surface.waitForReady({ ...context, surface, route, params });
        await page.waitForTimeout(3000);
        await waitForIdle(page, 1000);

        // Click the sub-tab
        const tabLocator = page
          .locator(
            `button:has-text("${subTabDef.subTab}"), ` +
              `[role="tab"]:has-text("${subTabDef.subTab}"), ` +
              `a:has-text("${subTabDef.subTab}")`,
          )
          .first();

        if (await tabLocator.isVisible({ timeout: 5000 }).catch(() => false)) {
          await tabLocator.click();
          await page.waitForTimeout(3000);
          await waitForIdle(page, 1500);
        }

        // State 1: Sub-tab default view
        await capture(`${subTabDef.screenshotPrefix}--default`);
        log(`  Default captured for ${subTabDef.subTab}`);

        // State 2: Try to interact (filter, sort, expand)
        if (subTabDef.subTab === 'Sessions') {
          // Try to expand filters
          const filterBtn = page
            .locator('button:has-text("Filter"), button:has-text("Filters"), [aria-label="Filter"]')
            .first();
          if (await filterBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await filterBtn.click();
            await page.waitForTimeout(1500);
            await capture(`${subTabDef.screenshotPrefix}--filters-open`);
            log('  Filters open captured');
          }
        } else if (subTabDef.subTab === 'Traces') {
          // Try clicking a trace row
          const traceRow = page.locator('table tbody tr, [class*="trace-row"]').first();
          if (await traceRow.isVisible({ timeout: 3000 }).catch(() => false)) {
            await traceRow.click();
            await page.waitForTimeout(2000);
            await capture(`${subTabDef.screenshotPrefix}--row-selected`);
            log('  Row selected captured');
          }
        } else if (subTabDef.subTab === 'Generations') {
          await capture(`${subTabDef.screenshotPrefix}--default`);
          log('  Generations tab captured');
        }

        results.push({ id: subTabDef.screenshotPrefix, status: 'ok' });
        successCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  FAIL: ${subTabDef.label} - ${msg}`);
        await capture(`${subTabDef.screenshotPrefix}--error`).catch(() => {});
        results.push({ id: subTabDef.screenshotPrefix, status: 'error', reason: msg });
        failCount++;
      }
    }

    const total = PHASE_E_SURFACES.length + SUB_TAB_CAPTURES.length;
    log(`\nPhase E complete: ${successCount} ok, ${failCount} failed out of ${total} surfaces`);

    return {
      summary: `Phase E: captured ${successCount}/${total} surfaces against ${projectId} on ${baseUrl}`,
      metadata: {
        projectId,
        email,
        tenantId,
        sessionId,
        results,
        successCount,
        failCount,
      },
      assertions: [
        {
          name: 'phase-e-capture-complete',
          passed: failCount === 0,
          details: `${successCount} captured, ${failCount} failed`,
        },
      ],
      error: null,
    };
  },
};
