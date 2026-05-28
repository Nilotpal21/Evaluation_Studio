/**
 * Canary visual-regression baseline.
 *
 * Captures eight high-traffic Studio surfaces in BOTH light and dark themes
 * so subsequent token / hue / typography slices can compare current renders
 * against a known-good baseline. The set covers the highest-blast-radius
 * tokens (--background, --foreground, --primary, --success, --warning,
 * --error, --info) and the typography rhythm that Track 1 polish slices
 * are about to touch.
 *
 * Canary surfaces (eight):
 *   1. insights-dashboard       — KPI cards, charts, --warning / --info
 *   2. agents-list              — Agent cards, formatAgentName, --card
 *   3. agent-chat               — Chat header, bubbles, sidebar, --primary
 *   4. sessions                 — Table, formatCost, status badges
 *   5. agent-editor             — Form fields, helper text, toolbar (warning hue)
 *   6. evals                    — Tab counts, em-dash typography
 *   7. connections              — Integration cards, status pills
 *   8. insights-quality-monitor — Percent + threshold tints (--error / --warning)
 *
 * Output convention:
 *   <output>/screenshots/light/<surface>.png
 *   <output>/screenshots/dark/<surface>.png
 *
 * Lock workflow:
 *   1. Run before a slice change → store outputs as the baseline.
 *   2. Make the slice change.
 *   3. Run again after the change → diff against the baseline.
 *   4. Surfaces NOT intended to change must remain pixel-stable; surfaces
 *      that ARE intended to change get re-baselined explicitly.
 *
 * Usage:
 *   pnpm studio:video:evidence -- --scenario audit-canary-baseline
 */

import { STUDIO_SURFACES } from '../lib/studio-harness.mjs';
import {
  buildStaticAgentDsl,
  bootstrapStudioBrowserSession,
  createAgent,
  createProject,
  devLogin,
  forceTheme,
  waitForIdle,
} from '../lib/studio-chat.mjs';
import { uniqueSuffix } from '../lib/utils.mjs';

const CANARY_SURFACE_IDS = [
  'insights-dashboard',
  'agents-list',
  'agent-chat',
  'sessions',
  'agent-editor',
  'evals',
  'connections',
  'insights-quality-monitor',
];

const CANARY_THEMES = ['light', 'dark'];

export const scenario = {
  id: 'audit-canary-baseline',
  title: 'Canary visual-regression baseline',
  description:
    'Captures eight canary Studio surfaces in light + dark themes against a ' +
    'fresh disposable project so Track 1 polish slices can lock-then-change ' +
    'without introducing regressions on adjacent surfaces.',
  example: 'pnpm studio:video:evidence -- --scenario audit-canary-baseline',

  async run(context) {
    const { page, baseUrl, artifacts, log } = context;
    const email = context.options.email || 'dev@kore.ai';

    log(`Logging in as ${email}...`);
    const { accessToken, refreshToken } = await devLogin(baseUrl, {
      email,
      name: 'Canary Baseline',
    });

    let tenantId = null;
    try {
      const payloadB64 = accessToken.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'));
      tenantId = payload.tenantId || null;
    } catch {
      // ignore
    }

    const slug = `canary-baseline-${uniqueSuffix()}`;
    log(`Creating disposable project ${slug}...`);
    const project = await createProject(baseUrl, accessToken, {
      name: 'Canary Baseline',
      slug,
    });
    const projectId = project.id;

    const agentName = 'canary_baseline_agent';
    log(`Creating disposable agent ${agentName}...`);
    await createAgent(baseUrl, accessToken, projectId, {
      name: agentName,
      dslContent: buildStaticAgentDsl(agentName, 'Canary baseline fixture acknowledged.'),
    });

    log('Bootstrapping browser session...');
    await bootstrapStudioBrowserSession(page, baseUrl, {
      accessToken,
      refreshToken,
      tenantId,
      landingPath: `/projects/${encodeURIComponent(projectId)}`,
    });
    await page.waitForTimeout(6_000);
    await waitForIdle(page, 1_500);

    const results = [];

    for (const theme of CANARY_THEMES) {
      log(`--- Theme: ${theme} ---`);
      await forceTheme(page, theme);

      for (const surfaceId of CANARY_SURFACE_IDS) {
        const surface = STUDIO_SURFACES.find((s) => s.id === surfaceId);
        if (!surface) {
          log(`SKIP: surface "${surfaceId}" not registered.`);
          results.push({ id: surfaceId, theme, status: 'skipped' });
          continue;
        }

        try {
          const params = { projectId };
          if (surface.requiresAgent) params.agentName = agentName;
          const route = `${baseUrl}${surface.buildPath(params)}`;
          log(`[${theme}] Navigating ${surfaceId} -> ${surface.buildPath(params)}`);
          await page.goto(route, { waitUntil: 'domcontentloaded' });
          await surface.waitForReady({ ...context, surface, route, params });
          await page.waitForTimeout(2_500);
          await waitForIdle(page, 1_000);
          await artifacts.captureScreenshot(`${theme}/${surfaceId}.png`);
          results.push({ id: surfaceId, theme, status: 'ok' });
          log(`[${theme}] Captured ${surfaceId}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`[${theme}] FAIL ${surfaceId}: ${message}`);
          results.push({ id: surfaceId, theme, status: 'failed', reason: message });
        }
      }
    }

    const summary = {
      themes: CANARY_THEMES,
      surfaces: CANARY_SURFACE_IDS,
      total: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      results,
    };
    log(`Capture summary: ${JSON.stringify(summary, null, 2)}`);
    return { summary: `${summary.ok}/${summary.total} canary captures ok`, metadata: summary };
  },
};
