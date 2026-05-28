/**
 * Audit Wave 3 validation capture.
 *
 * Verifies the visible Wave 3 changes (ABLP-569):
 *
 *   - Theme 17 (formatAgentName) — Agents List card title and chat
 *     header now Title-Case the slug ("audit_static_agent" →
 *     "Audit Static Agent").
 *   - Themes 20 + 7 — Chat session sidebar promotes relative time to
 *     the primary label and pluralizes "msg / msgs".
 *
 * Sends one chat message before capturing chat so the SessionSidebar
 * has a real session row to render.
 *
 * Usage:
 *   pnpm studio:video:evidence -- --scenario audit-wave3-validation
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
  id: 'audit-wave3-validation',
  title: 'Audit Wave 3 validation',
  description:
    'Captures the Wave 3 visible changes: formatAgentName adoption ' +
    '(Agents List + chat header) and the humanized chat session sidebar ' +
    '(relative-time primary + pluralized msg counts).',
  example: 'pnpm studio:video:evidence -- --scenario audit-wave3-validation',

  async run(context) {
    const { page, baseUrl, artifacts, log } = context;
    const email = context.options.email || 'dev@kore.ai';

    log(`Logging in as ${email}...`);
    const { accessToken, refreshToken } = await devLogin(baseUrl, {
      email,
      name: 'Wave 3 Validation',
    });

    let tenantId = null;
    try {
      const payloadB64 = accessToken.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'));
      tenantId = payload.tenantId || null;
    } catch {
      // ignore
    }

    const slug = `audit-wave3-${uniqueSuffix()}`;
    log(`Creating disposable project ${slug}...`);
    const project = await createProject(baseUrl, accessToken, {
      name: 'Audit Wave 3 Validation',
      slug,
    });
    const projectId = project.id;

    const agentName = 'audit_static_agent';
    log(`Creating disposable agent ${agentName}...`);
    await createAgent(baseUrl, accessToken, projectId, {
      name: agentName,
      dslContent: buildStaticAgentDsl(agentName, 'Wave 3 fixture acknowledged.'),
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

    // 1. agents-list — AgentCard formatAgentName
    const agentsList = STUDIO_SURFACES.find((s) => s.id === 'agents-list');
    const agentsRoute = `${baseUrl}${agentsList.buildPath({ projectId })}`;
    log('Navigating to agents-list...');
    await page.goto(agentsRoute, { waitUntil: 'domcontentloaded' });
    await agentsList.waitForReady({ ...context, surface: agentsList, route: agentsRoute });
    await page.waitForTimeout(2_500);
    await waitForIdle(page, 1_000);
    await artifacts.captureScreenshot('agents-list.png');
    log('Captured agents-list');

    // 2. agent-chat — StudioChatHeader formatAgentName + SessionSidebar
    //    humanized labels (after sending one message)
    const agentChat = STUDIO_SURFACES.find((s) => s.id === 'agent-chat');
    const chatRoute = `${baseUrl}${agentChat.buildPath({ projectId, agentName })}`;
    log('Navigating to agent-chat...');
    await page.goto(chatRoute, { waitUntil: 'domcontentloaded' });
    await agentChat.waitForReady({ ...context, surface: agentChat, route: chatRoute });
    await artifacts.captureScreenshot('agent-chat-empty.png');
    log('Captured agent-chat-empty');

    log('Sending one user message to seed a session...');
    await sendStudioChatMessage(page, 'Wave 3 validation message');
    await waitForMessageListText(page, 'Wave 3 fixture acknowledged.', 15_000);
    await waitForIdle(page, 1_000);
    await artifacts.captureScreenshot('agent-chat-with-session.png');
    log('Captured agent-chat-with-session');

    return { ok: true };
  },
};
