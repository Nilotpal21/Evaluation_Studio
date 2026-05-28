/**
 * Populated-state capture scenario for UI/UX audit Phase D.
 *
 * Captures P0 surfaces against a known-populated project (proj-saludsa-production)
 * and detail pages with real entity data.
 *
 * Usage:
 *   pnpm studio:video:evidence -- --scenario populated-state-capture --email dev@kore.ai --project-id proj-saludsa-production
 */

import { STUDIO_SURFACES } from '../lib/studio-harness.mjs';
import { waitForIdle, devLogin, bootstrapStudioBrowserSession } from '../lib/studio-chat.mjs';

// --- Surface IDs to capture (list-level P0 + detail-level new) ---
const P0_POPULATED_SURFACE_IDS = [
  'project-home',
  'agents-list',
  'agent-editor',
  'sessions',
  'deployments',
  'workflows',
  'tools',
  'search-ai',
  'evals',
  'inbox',
  'insights-dashboard',
  'insights-analytics',
  'insights-billing',
  'insights-agent-performance',
  'insights-quality-monitor',
  'insights-customer-insights',
  'insights-voice-analytics',
  'settings-members',
  'settings-api-keys',
  'settings-models',
  'settings-runtime-config',
  'settings-config-vars',
  'settings-auth-profiles',
];

const DETAIL_SURFACE_IDS = [
  'session-detail',
  'agent-detail-overview',
  'tool-detail',
  'workflow-detail',
  'deployment-channel-detail',
];

export const scenario = {
  id: 'populated-state-capture',
  title: 'Populated State Capture',
  description:
    'Captures Studio surfaces against a populated project for Phase D UI/UX audit. ' +
    'Uses bootstrapStudioBrowserSession to properly pre-seed auth and tenant state.',
  example:
    'pnpm studio:video:evidence -- --scenario populated-state-capture --email dev@kore.ai --project-id proj-saludsa-production',

  async run(context) {
    const { page, baseUrl, artifacts, log } = context;
    const projectId = context.options.projectId;
    const email = context.options.email || 'dev@kore.ai';

    if (!projectId) {
      throw new Error(
        'This scenario requires --project-id. Use: --project-id proj-saludsa-production',
      );
    }

    // Step 1: Get auth tokens via dev-login API
    log(`Logging in as ${email}...`);
    const loginResult = await devLogin(baseUrl, { email, name: 'Developer' });
    const { accessToken, refreshToken } = loginResult;

    // Extract tenantId from JWT
    let tenantId = null;
    try {
      const payloadB64 = accessToken.split('.')[1];
      const decoded = Buffer.from(payloadB64, 'base64').toString('utf-8');
      const payload = JSON.parse(decoded);
      tenantId = payload.tenantId || null;
    } catch {
      log('Warning: Could not extract tenantId from JWT');
    }
    log(`Auth: tenantId=${tenantId}, userId=${loginResult.user?.id}`);

    // Step 2: Bootstrap browser session with proper tenant state
    // Capture browser console to debug auth/project loading issues
    page.on('console', (msg) => {
      if (
        msg.type() === 'error' ||
        msg.text().includes('[AUTH]') ||
        msg.text().includes('project')
      ) {
        log(`[BROWSER ${msg.type()}] ${msg.text()}`);
      }
    });
    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('/api/projects') || url.includes('/api/auth')) {
        log(`[NET ${response.status()}] ${response.url().replace(baseUrl, '')}`);
      }
    });

    const landingPath = `/projects/${encodeURIComponent(projectId)}`;
    log(`Bootstrapping browser session for project ${projectId}...`);
    await bootstrapStudioBrowserSession(page, baseUrl, {
      accessToken,
      refreshToken,
      tenantId,
      landingPath,
    });

    // Step 3: Wait for full hydration (auth + project load + data load)
    log('Waiting for full hydration...');
    await page.waitForTimeout(8_000);
    await waitForIdle(page, 2_000);

    // Check auth state from browser
    const authState = await page.evaluate(() => {
      try {
        const stored = window.localStorage.getItem('kore-auth-storage');
        return { stored, url: window.location.href };
      } catch {
        return { error: 'failed to read localStorage' };
      }
    });
    log(`Browser auth state: ${JSON.stringify(authState)}`);

    // Take a verification screenshot of the landing page
    const results = [];

    async function capture(name) {
      return artifacts.captureScreenshot(`${name}.png`);
    }

    await capture('00-landing-verification');

    // Step 4: Capture each P0 surface
    let successCount = 0;
    let failCount = 0;

    for (const surfaceId of P0_POPULATED_SURFACE_IDS) {
      const surface = STUDIO_SURFACES.find((s) => s.id === surfaceId);
      if (!surface) {
        log(`SKIP: Surface "${surfaceId}" not registered in harness.`);
        results.push({ id: surfaceId, status: 'skipped', reason: 'not registered' });
        continue;
      }

      try {
        const params = { projectId };
        if (surface.requiresAgent) {
          params.agentName = 'broker_entry_gateway';
        }

        const routePath = surface.buildPath(params);
        const route = `${baseUrl}${routePath}`;
        log(`Navigating: ${surfaceId} -> ${routePath}`);

        await page.goto(route, { waitUntil: 'domcontentloaded' });
        await surface.waitForReady({ ...context, surface, route, params });

        // Extra wait for data hydration on populated surfaces
        await page.waitForTimeout(3_000);
        await waitForIdle(page, 1_000);

        await capture(`${surfaceId}-populated`);
        results.push({ id: surfaceId, status: 'ok' });
        successCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  FAIL: ${surfaceId} - ${msg}`);
        await capture(`${surfaceId}-error`).catch(() => {});
        results.push({ id: surfaceId, status: 'error', reason: msg });
        failCount++;
      }
    }

    // Step 5: Capture detail surfaces
    for (const surfaceId of DETAIL_SURFACE_IDS) {
      const surface = STUDIO_SURFACES.find((s) => s.id === surfaceId);
      if (!surface) {
        log(`SKIP: Detail surface "${surfaceId}" not registered in harness.`);
        results.push({ id: surfaceId, status: 'skipped', reason: 'not registered' });
        continue;
      }

      try {
        const params = { projectId };
        if (surface.requiresAgent) {
          params.agentName = 'broker_entry_gateway';
        }

        const routePath = surface.buildPath(params);
        const route = `${baseUrl}${routePath}`;
        log(`Navigating detail: ${surfaceId} -> ${routePath}`);

        await page.goto(route, { waitUntil: 'domcontentloaded' });
        await surface.waitForReady({ ...context, surface, route, params });

        await page.waitForTimeout(3_000);
        await waitForIdle(page, 1_000);

        await capture(`${surfaceId}-populated`);
        results.push({ id: surfaceId, status: 'ok' });
        successCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  FAIL: ${surfaceId} - ${msg}`);
        await capture(`${surfaceId}-error`).catch(() => {});
        results.push({ id: surfaceId, status: 'error', reason: msg });
        failCount++;
      }
    }

    const total = P0_POPULATED_SURFACE_IDS.length + DETAIL_SURFACE_IDS.length;
    log(
      `\nDone: ${successCount} ok, ${failCount} failed, ${total - successCount - failCount} skipped`,
    );

    return {
      summary: `Captured ${successCount}/${total} surfaces against populated project ${projectId}`,
      metadata: {
        projectId,
        email,
        tenantId,
        results,
        successCount,
        failCount,
      },
      assertions: [
        {
          name: 'populated-capture-complete',
          passed: failCount === 0,
          details: `${successCount} captured, ${failCount} failed`,
        },
      ],
      error: null,
    };
  },
};
