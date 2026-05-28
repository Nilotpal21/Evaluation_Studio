/**
 * Wave 5 verification capture WITH populated session/trace/cost data.
 *
 * Creates a disposable project + agent (the same flow Wave 3 used so the
 * project picker hydrates correctly), drives 3 chat turns so the Sessions
 * list and Session Detail surfaces have real rows + cost/trace data, then
 * captures the surfaces that need that data:
 *
 *   - sessions          Theme 24 — Cost column with formatCost output
 *   - session-detail    Theme 23 — span tree row rendering
 *   - agent-editor      Theme 8  — toolbar variants, helper-text width
 *   - agents-list       Theme 17 — formatAgentName Title-Case
 *
 * Usage:
 *   pnpm studio:video:evidence -- --scenario audit-wave5-with-data
 */

import { STUDIO_SURFACES } from '../lib/studio-harness.mjs';
import {
  buildStaticAgentDsl,
  bootstrapStudioBrowserSession,
  createAgent,
  createProject,
  devLogin,
  sendStudioChatMessage,
  waitForIdle,
  waitForMessageListText,
} from '../lib/studio-chat.mjs';
import { uniqueSuffix } from '../lib/utils.mjs';

const TURN_PROMPTS = [
  'What products do you carry?',
  'Tell me about returns policy.',
  'Connect me to a human supervisor.',
];

export const scenario = {
  id: 'audit-wave5-with-data',
  title: 'Wave 5 verification with populated chat data',
  description:
    'Drives multiple chat turns through a disposable agent so Sessions ' +
    'list / Session Detail / Agent Editor surfaces have real cost, trace, ' +
    'and span data to validate Wave 5 polish themes.',
  example: 'pnpm studio:video:evidence -- --scenario audit-wave5-with-data',

  async run(context) {
    const { page, baseUrl, artifacts, log } = context;
    const email = context.options.email || 'dev@kore.ai';

    log(`Logging in as ${email}...`);
    const { accessToken, refreshToken } = await devLogin(baseUrl, {
      email,
      name: 'Wave 5 Verification',
    });

    let tenantId = null;
    try {
      const payloadB64 = accessToken.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'));
      tenantId = payload.tenantId || null;
    } catch {
      // ignore
    }

    const slug = `audit-wave5-${uniqueSuffix()}`;
    log(`Creating disposable project ${slug}...`);
    const project = await createProject(baseUrl, accessToken, {
      name: 'Audit Wave 5 With Data',
      slug,
    });
    const projectId = project.id;

    const agentName = 'wave5_retail_agent';
    log(`Creating disposable agent ${agentName}...`);
    await createAgent(baseUrl, accessToken, projectId, {
      name: agentName,
      dslContent: buildStaticAgentDsl(agentName, 'Wave 5 fixture acknowledged.'),
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

    // Drive chat turns to populate session + cost + trace data.
    const agentChat = STUDIO_SURFACES.find((s) => s.id === 'agent-chat');
    const chatRoute = `${baseUrl}${agentChat.buildPath({ projectId, agentName })}`;
    for (let i = 0; i < TURN_PROMPTS.length; i += 1) {
      log(`Driving chat turn ${i + 1}/${TURN_PROMPTS.length} on a fresh session...`);
      await page.goto(chatRoute, { waitUntil: 'domcontentloaded' });
      await agentChat.waitForReady({ ...context, surface: agentChat, route: chatRoute });
      await sendStudioChatMessage(page, TURN_PROMPTS[i]);
      await waitForMessageListText(page, 'Wave 5 fixture acknowledged.', 15_000);
      await waitForIdle(page, 1_000);
      // Click "New Chat" so the next turn opens a fresh session, not the
      // current one. Falls through silently if the button is missing.
      const newChat = page.getByRole('button', { name: /new chat/i }).first();
      try {
        await newChat.click({ timeout: 2_000 });
        await page.waitForTimeout(1_500);
      } catch {
        // continue — the next page.goto will navigate anyway
      }
    }

    const results = [];

    async function captureSurface(surfaceId, params, fileName) {
      const surface = STUDIO_SURFACES.find((s) => s.id === surfaceId);
      if (!surface) {
        log(`SKIP: surface "${surfaceId}" not registered.`);
        results.push({ id: surfaceId, status: 'skipped' });
        return;
      }
      try {
        const route = `${baseUrl}${surface.buildPath(params)}`;
        log(`Navigating ${surfaceId} -> ${surface.buildPath(params)}`);
        await page.goto(route, { waitUntil: 'domcontentloaded' });
        await surface.waitForReady({ ...context, surface, route, params });
        await page.waitForTimeout(3_500);
        await waitForIdle(page, 1_500);
        await artifacts.captureScreenshot(`${fileName}.png`);
        results.push({ id: surfaceId, status: 'ok' });
        log(`Captured ${fileName}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`FAIL ${surfaceId}: ${message}`);
        results.push({ id: surfaceId, status: 'failed', reason: message });
      }
    }

    await captureSurface('sessions', { projectId }, 'sessions');
    await captureSurface('agents-list', { projectId }, 'agents-list');
    await captureSurface('agent-editor', { projectId, agentName }, 'agent-editor');

    // session-detail — drill into the most recent session via the API to
    // grab a real session id for this run.
    try {
      const sessionsList = await page.evaluate(async (pid) => {
        const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/sessions?limit=10`);
        if (!r.ok) return null;
        return r.json();
      }, projectId);
      const arr =
        sessionsList?.sessions ??
        sessionsList?.data ??
        (Array.isArray(sessionsList) ? sessionsList : null);
      const session = Array.isArray(arr) ? arr[0] : null;
      const sessionId = session?.id ?? session?._id ?? null;
      if (sessionId) {
        log(`Drilling into session-detail for ${sessionId}...`);
        const detailRoute = `${baseUrl}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
        await page.goto(detailRoute, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(4_500);
        await waitForIdle(page, 1_500);
        await artifacts.captureScreenshot('session-detail.png');
        results.push({ id: 'session-detail', status: 'ok' });
        log('Captured session-detail');
      } else {
        log('SKIP session-detail: no session id resolved');
        results.push({ id: 'session-detail', status: 'skipped', reason: 'no session' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`FAIL session-detail: ${message}`);
      results.push({ id: 'session-detail', status: 'failed', reason: message });
    }

    log(`Capture summary: ${JSON.stringify(results, null, 2)}`);
    return { ok: true, results };
  },
};
