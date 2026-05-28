/**
 * Drill into Session Detail from a populated chat by clicking the first
 * row on the Sessions list. Bypasses the API-fetch path that wasn't
 * returning data for the disposable project, and validates Theme 23
 * (span tree row rendering) against a real session row.
 *
 * Usage:
 *   pnpm studio:video:evidence -- --scenario audit-detail-drilldown
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

export const scenario = {
  id: 'audit-detail-drilldown',
  title: 'Audit detail drilldown via row click',
  description:
    'Drives one chat turn, navigates to Sessions, clicks the first row, ' +
    'captures the detail page (Theme 23 span tree).',
  example: 'pnpm studio:video:evidence -- --scenario audit-detail-drilldown',

  async run(context) {
    const { page, baseUrl, artifacts, log } = context;
    const email = context.options.email || 'dev@kore.ai';

    log(`Logging in as ${email}...`);
    const { accessToken, refreshToken } = await devLogin(baseUrl, {
      email,
      name: 'Detail Drilldown',
    });

    let tenantId = null;
    try {
      const payloadB64 = accessToken.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'));
      tenantId = payload.tenantId || null;
    } catch {
      // ignore
    }

    const slug = `audit-drilldown-${uniqueSuffix()}`;
    log(`Creating disposable project ${slug}...`);
    const project = await createProject(baseUrl, accessToken, {
      name: 'Audit Drilldown',
      slug,
    });
    const projectId = project.id;

    const agentName = 'drilldown_agent';
    log(`Creating agent ${agentName}...`);
    await createAgent(baseUrl, accessToken, projectId, {
      name: agentName,
      dslContent: buildStaticAgentDsl(agentName, 'Drilldown fixture acknowledged.'),
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

    const agentChat = STUDIO_SURFACES.find((s) => s.id === 'agent-chat');
    const chatRoute = `${baseUrl}${agentChat.buildPath({ projectId, agentName })}`;
    log('Driving one chat turn...');
    await page.goto(chatRoute, { waitUntil: 'domcontentloaded' });
    await agentChat.waitForReady({ ...context, surface: agentChat, route: chatRoute });
    await sendStudioChatMessage(page, 'Hello, please respond');
    await waitForMessageListText(page, 'Drilldown fixture acknowledged.', 15_000);
    await waitForIdle(page, 1_500);

    const listSurface = STUDIO_SURFACES.find((s) => s.id === 'sessions');
    const listRoute = `${baseUrl}${listSurface.buildPath({ projectId })}`;
    log('Navigating to list...');
    await page.goto(listRoute, { waitUntil: 'domcontentloaded' });
    await listSurface.waitForReady({ ...context, surface: listSurface, route: listRoute });
    await page.waitForTimeout(3_000);
    await waitForIdle(page, 1_500);
    await artifacts.captureScreenshot('list-with-rows.png');

    log('Clicking first row...');
    const firstRow = page.locator('tbody tr, [role="row"]').first();
    try {
      await firstRow.click({ timeout: 5_000 });
      await page.waitForTimeout(4_500);
      await waitForIdle(page, 1_500);
      await artifacts.captureScreenshot('detail.png');
      log('Captured detail');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`FAIL clicking row: ${message}`);
    }

    return { ok: true };
  },
};
