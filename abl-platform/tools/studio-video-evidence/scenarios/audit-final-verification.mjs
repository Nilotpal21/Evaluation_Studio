/**
 * Final ABLP-569 audit verification capture against a populated local project.
 *
 * Targets `proj-retail` (Retail Commerce, tenant-dev-001) which has real
 * sessions, traces, and agents — so the Wave 5 polish themes that need
 * data (cost in session list, span tree, agent editor toolbar) actually
 * have something to show.
 *
 * Surfaces captured:
 *
 *   - sessions                 Theme 24 (Cost column with formatCost)
 *   - session-detail           Theme 23 (span tree row rendering, run
 *                              collapse if any consecutive runs exist)
 *   - agents-list              Theme 17 (formatAgentName on real slugs)
 *   - agent-editor             Theme 8  (toolbar variants, helper width)
 *   - insights-dashboard       Themes 1B, 6, 22 (date range, labels,
 *                              threshold colors with real KPI values)
 *   - insights-quality-monitor Themes 22, 1B, 6 (percentages on real
 *                              quality scores)
 *   - insights-customer-insights  Themes 1A, 6
 *
 * Usage:
 *   pnpm studio:video:evidence -- --scenario audit-final-verification \
 *     [--project-id proj-retail] [--email dev@kore.ai]
 */

import { STUDIO_SURFACES } from '../lib/studio-harness.mjs';
import { bootstrapStudioBrowserSession, devLogin, waitForIdle } from '../lib/studio-chat.mjs';

const DEFAULT_PROJECT_ID = 'proj-retail';

const SURFACE_IDS = [
  'sessions',
  'agents-list',
  'agent-editor',
  'insights-dashboard',
  'insights-quality-monitor',
  'insights-customer-insights',
];

export const scenario = {
  id: 'audit-final-verification',
  title: 'Final audit verification against populated project',
  description:
    'Captures Wave 5 polish + final-state visuals against a populated ' +
    'local project (defaults to proj-retail) so the changes that need ' +
    'real data — cost columns, span trees, percentage-scaled KPIs — ' +
    'actually have content.',
  example:
    'pnpm studio:video:evidence -- --scenario audit-final-verification --project-id proj-retail',

  async run(context) {
    const { page, baseUrl, artifacts, log } = context;
    const projectId = context.options.projectId || DEFAULT_PROJECT_ID;
    const email = context.options.email || 'dev@kore.ai';

    log(`Logging in as ${email}...`);
    const { accessToken, refreshToken } = await devLogin(baseUrl, {
      email,
      name: 'Audit Final Verification',
    });

    let tenantId = null;
    try {
      const payloadB64 = accessToken.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'));
      tenantId = payload.tenantId || null;
    } catch {
      // ignore
    }

    log(`Bootstrapping browser session for project ${projectId}...`);
    await bootstrapStudioBrowserSession(page, baseUrl, {
      accessToken,
      refreshToken,
      tenantId,
      landingPath: `/projects/${encodeURIComponent(projectId)}`,
    });

    await page.waitForTimeout(8_000);
    await waitForIdle(page, 1_500);

    // 1. Resolve a real agent name + session id from the project so the
    //    detail surfaces have populated targets. Pull them straight from
    //    the Studio API once auth is hydrated.
    let agentName = null;
    let sessionId = null;
    try {
      const agentsRes = await page.evaluate(async (pid) => {
        const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/agents`);
        if (!r.ok) return { agents: [] };
        return r.json();
      }, projectId);
      const firstAgent = agentsRes?.agents?.[0] ?? agentsRes?.[0] ?? null;
      agentName = firstAgent?.name ?? firstAgent?.agentPath ?? null;
      log(`Resolved agent: ${agentName ?? '(none)'}`);
    } catch (err) {
      log(`Failed to resolve agent: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const sessionsRes = await page.evaluate(async (pid) => {
        const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/sessions?limit=10`);
        if (!r.ok) return { sessions: [] };
        return r.json();
      }, projectId);
      const list = sessionsRes?.sessions ?? sessionsRes?.data ?? sessionsRes ?? [];
      const arr = Array.isArray(list) ? list : (list?.items ?? []);
      const richSession = arr.find((s) => (s.traceEventCount ?? 0) > 0) ?? arr[0];
      sessionId = richSession?.id ?? richSession?._id ?? null;
      log(`Resolved session: ${sessionId ?? '(none)'}`);
    } catch (err) {
      log(`Failed to resolve session: ${err instanceof Error ? err.message : String(err)}`);
    }

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
        if (surface.requiresAgent) {
          if (!agentName) {
            log(`SKIP ${surfaceId}: requires agent but none resolved.`);
            results.push({ id: surfaceId, status: 'skipped', reason: 'no agent' });
            continue;
          }
          params.agentName = agentName;
        }
        const route = `${baseUrl}${surface.buildPath(params)}`;
        log(`Navigating ${surfaceId} -> ${surface.buildPath(params)}`);
        await page.goto(route, { waitUntil: 'domcontentloaded' });
        await surface.waitForReady({ ...context, surface, route, params });
        await page.waitForTimeout(3_000);
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

    // 2. session-detail — drill-down where Theme 23 / 24 visuals live.
    if (sessionId) {
      try {
        const detailRoute = `${baseUrl}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
        log(`Navigating session-detail -> ${detailRoute}`);
        await page.goto(detailRoute, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(4_000);
        await waitForIdle(page, 1_500);
        await artifacts.captureScreenshot('session-detail.png');
        results.push({ id: 'session-detail', status: 'ok' });
        log('Captured session-detail');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`FAIL session-detail: ${message}`);
        results.push({ id: 'session-detail', status: 'failed', reason: message });
      }
    } else {
      log('SKIP session-detail: no session resolved');
      results.push({ id: 'session-detail', status: 'skipped', reason: 'no session' });
    }

    log(`Capture summary: ${JSON.stringify(results, null, 2)}`);
    return { ok: true, results };
  },
};
