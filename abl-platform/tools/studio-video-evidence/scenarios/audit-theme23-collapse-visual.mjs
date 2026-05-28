/**
 * Theme 23 visual validation: capture the AgentExecutionTree run-collapse
 * by intercepting the session-traces API and injecting 5 consecutive
 * constraint_check events. The collapse logic in
 * `apps/studio/src/lib/buildAgentTree.ts::collapseConsecutive` groups
 * runs of 2+ matching `COLLAPSIBLE_TYPES` into a single "constraints (N)"
 * row — this scenario forces that condition to render.
 *
 * Why intercept rather than seed real data: producing real consecutive
 * constraint_check trace events requires an LLM-backed agent with multiple
 * input guardrails that all evaluate per turn. That's a runtime fixture
 * problem far outside the scope of validating the rendering behavior. The
 * intercept approach exercises the same render path the audit observed.
 *
 * Usage:
 *   pnpm studio:video:evidence -- --scenario audit-theme23-collapse-visual
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

function buildSyntheticTraceEvents(sessionId) {
  const baseTime = new Date('2026-04-26T10:00:00Z').getTime();
  const traceId = `trace-${sessionId}`;
  const events = [];

  let id = 1;
  const push = (type, data, offsetMs, durationMs = 8) => {
    events.push({
      id: `evt-${id}`,
      type,
      timestamp: new Date(baseTime + offsetMs).toISOString(),
      durationMs,
      traceId,
      spanId: `span-${id}`,
      parentSpanId: null,
      sessionId,
      agentName: 'theme23_demo_agent',
      data,
    });
    id += 1;
  };

  // user_input opens a turn
  push('user_input', { content: 'Show me products under $50' }, 0, 0);
  // 5 consecutive constraint_check passes — the audit's "× N pass" pattern
  for (let i = 0; i < 5; i += 1) {
    push(
      'constraint_check',
      {
        agentName: 'theme23_demo_agent',
        kind: 'input',
        guardrailName: ['scope', 'pii', 'safety', 'topic', 'budget'][i],
        passed: true,
        message: 'pass',
      },
      40 + i * 12,
      6,
    );
  }
  // an agent response so the tree has trailing context
  push('agent_response', { content: 'Sure, here are products under $50.' }, 130, 0);

  return events;
}

export const scenario = {
  id: 'audit-theme23-collapse-visual',
  title: 'Theme 23 collapse visual capture',
  description:
    'Intercepts the session-traces API to inject 5 consecutive ' +
    'constraint_check events so the AgentExecutionTree collapse logic ' +
    'renders the "constraints (5) ✓" row that the audit reported.',
  example: 'pnpm studio:video:evidence -- --scenario audit-theme23-collapse-visual',

  async run(context) {
    const { page, baseUrl, artifacts, log } = context;
    const email = context.options.email || 'dev@kore.ai';

    log(`Logging in as ${email}...`);
    const { accessToken, refreshToken } = await devLogin(baseUrl, {
      email,
      name: 'Theme 23 Collapse Visual',
    });

    let tenantId = null;
    try {
      const payloadB64 = accessToken.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'));
      tenantId = payload.tenantId || null;
    } catch {
      // ignore
    }

    const slug = `audit-theme23-${uniqueSuffix()}`;
    log(`Creating disposable project ${slug}...`);
    const project = await createProject(baseUrl, accessToken, {
      name: 'Audit Theme 23 Collapse',
      slug,
    });
    const projectId = project.id;

    const agentName = 'theme23_demo_agent';
    log(`Creating agent ${agentName}...`);
    await createAgent(baseUrl, accessToken, projectId, {
      name: agentName,
      dslContent: buildStaticAgentDsl(agentName, 'Theme 23 fixture acknowledged.'),
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

    // Drive one chat turn to seed a real session.
    const agentChat = STUDIO_SURFACES.find((s) => s.id === 'agent-chat');
    const chatRoute = `${baseUrl}${agentChat.buildPath({ projectId, agentName })}`;
    log('Driving one chat turn...');
    await page.goto(chatRoute, { waitUntil: 'domcontentloaded' });
    await agentChat.waitForReady({ ...context, surface: agentChat, route: chatRoute });
    await sendStudioChatMessage(page, 'Show me products under $50');
    await waitForMessageListText(page, 'Theme 23 fixture acknowledged.', 15_000);
    await waitForIdle(page, 1_500);

    // Navigate to Sessions list, click the first row, get into Session Detail.
    const sessionsSurface = STUDIO_SURFACES.find((s) => s.id === 'sessions');
    const listRoute = `${baseUrl}${sessionsSurface.buildPath({ projectId })}`;
    log('Navigating to sessions list...');
    await page.goto(listRoute, { waitUntil: 'domcontentloaded' });
    await sessionsSurface.waitForReady({
      ...context,
      surface: sessionsSurface,
      route: listRoute,
    });
    await page.waitForTimeout(3_000);
    await waitForIdle(page, 1_500);

    // Read the first session id from the URL after clicking the first row.
    log('Clicking first session row...');
    const firstRow = page.locator('tbody tr, [role="row"]').first();
    await firstRow.click({ timeout: 5_000 });
    await page.waitForURL(/\/sessions\/[a-z0-9-]+/i, { timeout: 10_000 });
    const url = page.url();
    const matched = url.match(/\/sessions\/([a-z0-9-]+)/i);
    const sessionId = matched ? matched[1] : null;
    log(`On session-detail for ${sessionId}`);

    // Set up the route interceptor and reload so the synthetic traces hit
    // the AgentExecutionTree on first paint.
    if (sessionId) {
      const synthetic = buildSyntheticTraceEvents(sessionId);
      // Studio fetches traces via /api/runtime/sessions/:id/traces?projectId=...
      // and the runtime returns { success, total, offset, limit, traces, _meta }.
      await page.route('**/api/runtime/sessions/**/traces**', async (route) => {
        try {
          if (!route.request().url().includes(sessionId)) {
            await route.continue();
            return;
          }
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' },
            body: JSON.stringify({
              success: true,
              total: synthetic.length,
              offset: 0,
              limit: synthetic.length,
              traces: synthetic,
              _meta: {
                source: 'memory',
                event_count: synthetic.length,
                is_truncated: false,
              },
            }),
          });
          log(`Intercepted traces request — returning ${synthetic.length} synthetic events`);
        } catch (err) {
          log(`Intercept error: ${err instanceof Error ? err.message : String(err)}`);
          await route.continue();
        }
      });

      log('Reloading session-detail with intercepted traces...');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5_000);
      await waitForIdle(page, 1_500);

      await artifacts.captureScreenshot('session-detail-overview.png');
      log('Captured overview');

      // Click into the Traces tab where SpanTree (with the Theme 23
      // collapse logic) renders.
      log('Clicking Traces tab...');
      const tracesTab = page
        .getByRole('tab', { name: /^Traces$/i })
        .or(page.locator('button', { hasText: /^Traces\s*\d*$/ }))
        .first();
      try {
        await tracesTab.click({ timeout: 5_000 });
        await page.waitForTimeout(3_000);
        await waitForIdle(page, 1_500);
        await artifacts.captureScreenshot('session-detail-traces-tab.png');
        log('Captured traces tab');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`FAIL clicking Traces tab: ${message}`);
      }
    } else {
      log('FAIL: could not resolve session id from URL');
    }

    return { ok: true };
  },
};
