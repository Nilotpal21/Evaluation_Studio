/**
 * Audit Wave 1+2 validation capture.
 *
 * Captures the surfaces touched by the ABLP-569 audit Wave 1 and Wave 2
 * commits so the visual changes can be reviewed without spinning up the
 * harness once per surface. Single stack-up, fresh disposable project.
 *
 * Surfaces captured:
 *   - integrations          Theme 5a (page header)
 *   - insights-dashboard    Themes 1B, 6 (date range, KPI labels)
 *   - insights-quality-monitor   Themes 1B, 6, 22 (date range, labels, percent + threshold)
 *   - insights-customer-insights Themes 1A, 6 (date range, labels)
 *   - insights-agent-performance Themes 1B, 6 (date range, labels)
 *   - insights-billing      Themes 1B, 6 (date range with localized labels)
 *   - insights-voice-analytics   Themes 1A, 6, 12 (voice preset, labels, em-dash)
 *   - insights-analytics    Theme 19 (default 7d range)
 *   - evals                 Theme 10 (em-dash artifact in step descriptions)
 *
 * Usage:
 *   pnpm studio:video:evidence -- --scenario audit-wave1-2-validation
 */

import { STUDIO_SURFACES } from '../lib/studio-harness.mjs';
import {
  buildStaticAgentDsl,
  bootstrapStudioBrowserSession,
  createAgent,
  createProject,
  devLogin,
  waitForIdle,
} from '../lib/studio-chat.mjs';
import { uniqueSuffix } from '../lib/utils.mjs';

const SURFACE_IDS = [
  'connections',
  'insights-dashboard',
  'insights-quality-monitor',
  'insights-customer-insights',
  'insights-agent-performance',
  'insights-billing',
  'insights-voice-analytics',
  'insights-analytics',
  'evals',
];

export const scenario = {
  id: 'audit-wave1-2-validation',
  title: 'Audit Wave 1+2 validation',
  description:
    'Captures Studio Insights / Integrations / Evals against a disposable project ' +
    'so the ABLP-569 Wave 1 and Wave 2 visual changes can be eyeballed in one batch.',
  example: 'pnpm studio:video:evidence -- --scenario audit-wave1-2-validation',

  async run(context) {
    const { page, baseUrl, artifacts, log } = context;
    const email = context.options.email || 'dev@kore.ai';

    log(`Logging in as ${email}...`);
    const loginResult = await devLogin(baseUrl, {
      email,
      name: 'Audit Validation',
    });
    const { accessToken, refreshToken } = loginResult;

    let tenantId = null;
    try {
      const payloadB64 = accessToken.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'));
      tenantId = payload.tenantId || null;
    } catch {
      log('Warning: could not extract tenantId from JWT');
    }

    const slug = `audit-wave1-2-${uniqueSuffix()}`;
    log(`Creating disposable project ${slug}...`);
    const project = await createProject(baseUrl, accessToken, {
      name: 'Audit Wave 1-2 Validation',
      slug,
    });
    const projectId = project.id;

    log(`Creating disposable static-reply agent in ${projectId}...`);
    await createAgent(baseUrl, accessToken, projectId, {
      name: 'audit_static_agent',
      dslContent: buildStaticAgentDsl('audit_static_agent', 'Audit fixture acknowledged.'),
    });

    log(`Bootstrapping browser session for project ${projectId}...`);
    await bootstrapStudioBrowserSession(page, baseUrl, {
      accessToken,
      refreshToken,
      tenantId,
      landingPath: `/projects/${encodeURIComponent(projectId)}`,
    });

    await page.waitForTimeout(6_000);
    await waitForIdle(page, 1_500);

    const results = [];

    for (const surfaceId of SURFACE_IDS) {
      const surface = STUDIO_SURFACES.find((s) => s.id === surfaceId);
      if (!surface) {
        log(`SKIP: surface "${surfaceId}" not registered.`);
        results.push({ id: surfaceId, status: 'skipped' });
        continue;
      }

      try {
        const params = { projectId };
        if (surface.requiresAgent) params.agentName = 'audit_static_agent';
        const route = `${baseUrl}${surface.buildPath(params)}`;
        log(`Navigating ${surfaceId} -> ${surface.buildPath(params)}`);
        await page.goto(route, { waitUntil: 'domcontentloaded' });
        await surface.waitForReady({ ...context, surface, route, params });
        await page.waitForTimeout(2_500);
        await waitForIdle(page, 1_000);
        await artifacts.captureScreenshot(`${surfaceId}.png`);
        results.push({ id: surfaceId, status: 'ok' });
        log(`Captured ${surfaceId}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`FAIL ${surfaceId}: ${message}`);
        results.push({ id: surfaceId, status: 'failed', reason: message });
      }
    }

    log(`Capture summary: ${JSON.stringify(results, null, 2)}`);
    return { results };
  },
};
