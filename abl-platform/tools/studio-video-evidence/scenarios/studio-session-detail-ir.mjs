import { REQUEST_TIMEOUT_MS } from '../lib/constants.mjs';
import { createStudioFixture, openStudioSurface } from '../lib/studio-harness.mjs';
import {
  apiJson,
  sendStudioChatMessage,
  waitForIdle,
  waitForMessageListText,
} from '../lib/studio-chat.mjs';
import { numberFromInput, uniqueSuffix, waitForCondition } from '../lib/utils.mjs';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function clickLabeledControl(page, label) {
  const normalizedLabel = String(label ?? '').trim();
  if (!normalizedLabel) {
    return false;
  }

  const exactPattern = new RegExp(`^${escapeRegExp(normalizedLabel)}$`, 'i');
  const loosePattern = new RegExp(`^\\s*${escapeRegExp(normalizedLabel)}\\s*$`, 'i');
  const candidates = [
    page.getByRole('tab', { name: exactPattern }).first(),
    page.getByRole('button', { name: exactPattern }).first(),
    page.locator('button, [role="tab"]').filter({ hasText: loosePattern }).first(),
    page.getByText(normalizedLabel, { exact: true }).first(),
  ];

  for (const candidate of candidates) {
    try {
      if (await candidate.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await candidate.click({ timeout: REQUEST_TIMEOUT_MS });
        return true;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return false;
}

async function listProjectSessions(baseUrl, accessToken, projectId) {
  const body = await apiJson(
    baseUrl,
    `/api/runtime/sessions?projectId=${encodeURIComponent(projectId)}&limit=100`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  const sessions = Array.isArray(body?.sessions) ? body.sessions : [];
  return sessions.filter((session) => typeof session?.id === 'string');
}

export const scenario = {
  id: 'studio-session-detail-ir',
  title: 'Studio Session Detail IR',
  description:
    'Creates a disposable Studio project and real chat session, opens the session detail page, and records proof that the IR tab loads ABL and IR JSON content.',
  example:
    'pnpm studio:video:evidence -- --scenario studio-session-detail-ir --headed --final-pause-ms 1000',
  async run(context) {
    const { artifacts, baseUrl, options, page } = context;
    const finalPauseMs = numberFromInput(options.finalPauseMs, 2_000);
    const dslScreenshotName = String(
      options.dslScreenshotName ?? 'local-session-ir-abl.png',
    ).trim();
    const irScreenshotName = String(options.irScreenshotName ?? 'local-session-ir-json.png').trim();
    const suffix = uniqueSuffix();
    const userMessage = String(
      options.userMessage ?? `Studio session detail IR proof ${suffix}`,
    ).trim();
    const fixture = await createStudioFixture(context, {
      requireProject: true,
      requireAgent: true,
      assistantReply: String(
        options.assistantReply ??
          'Acknowledged. The session detail IR proof fixture is ready for capture.',
      ).trim(),
    });

    if (!fixture.projectId || !fixture.agentName) {
      throw new Error('Session detail IR scenario requires a project and agent fixture.');
    }

    const dslVisibleText = String(
      options.dslVisibleText ?? 'Provide deterministic Studio video evidence replies',
    ).trim();
    const irVisibleText = String(options.irVisibleText ?? 'ir_version').trim();
    const responsePattern = String(options.captureResponsePattern ?? '/agent-spec').trim();
    const responseCaptures = [];
    const navigation = await openStudioSurface(context, 'agent-chat', fixture);

    await sendStudioChatMessage(page, userMessage);
    await waitForMessageListText(page, userMessage, REQUEST_TIMEOUT_MS);
    await waitForMessageListText(page, fixture.assistantReply, REQUEST_TIMEOUT_MS);
    await waitForIdle(page, 1_000);

    const session = await waitForCondition(
      async () => {
        const sessions = await listProjectSessions(baseUrl, fixture.accessToken, fixture.projectId);
        return (
          sessions.find((candidate) => Number(candidate.messageCount ?? 0) >= 2) ??
          sessions[0] ??
          false
        );
      },
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
        intervalMs: 250,
        label:
          'Timed out waiting for the Studio chat session to appear in the project session list.',
      },
    );
    const sessionRoute = `${baseUrl}/projects/${encodeURIComponent(
      fixture.projectId,
    )}/sessions/${encodeURIComponent(session.id)}`;

    const handleResponse = async (response) => {
      if (!responsePattern || !response.url().includes(responsePattern)) {
        return;
      }

      let body = null;
      try {
        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('application/json')) {
          body = await response.json();
        } else {
          body = (await response.text()).slice(0, 4_000);
        }
      } catch {
        body = '<unreadable>';
      }

      responseCaptures.push({
        url: response.url(),
        status: response.status(),
        body,
      });
    };

    page.on('response', handleResponse);
    try {
      await page.goto(sessionRoute, { waitUntil: 'domcontentloaded' });
      await page.locator('main').first().waitFor({
        state: 'visible',
        timeout: REQUEST_TIMEOUT_MS,
      });
      await waitForIdle(page, 1_000);

      const openedIrTab = await clickLabeledControl(page, options.tab ?? 'IR');
      if (!openedIrTab) {
        throw new Error('Unable to open the session detail IR tab.');
      }

      await page.getByText(dslVisibleText, { exact: false }).first().waitFor({
        state: 'visible',
        timeout: REQUEST_TIMEOUT_MS,
      });

      await waitForCondition(() => responseCaptures.length > 0, {
        timeoutMs: REQUEST_TIMEOUT_MS,
        intervalMs: 250,
        label: 'Timed out waiting for the session detail agent-spec request.',
      });

      await artifacts.captureScreenshot(dslScreenshotName);

      const openedJsonView = await clickLabeledControl(page, options.viewToggle ?? 'IR JSON');
      if (!openedJsonView) {
        throw new Error('Unable to switch the IR tab into IR JSON view.');
      }

      await page.getByText(irVisibleText, { exact: false }).first().waitFor({
        state: 'visible',
        timeout: REQUEST_TIMEOUT_MS,
      });
      await artifacts.captureScreenshot(irScreenshotName);
      await page.waitForTimeout(finalPauseMs);
    } finally {
      page.off('response', handleResponse);
    }

    return {
      summary: `Captured the local Studio session detail IR tab at ${sessionRoute}.`,
      metadata: {
        sourceRoute: navigation.route,
        route: sessionRoute,
        projectId: fixture.projectId,
        projectName: fixture.projectName ?? null,
        agentName: fixture.agentName,
        sessionId: session.id,
        userMessage,
        assistantReply: fixture.assistantReply,
        responsePattern: responsePattern || null,
        capturedResponses: responseCaptures,
      },
      assertions: [
        {
          name: 'session-detail-opened',
          passed: true,
          details: `Opened ${sessionRoute}`,
        },
        {
          name: 'abl-visible',
          passed: true,
          details: `Observed ABL text "${dslVisibleText}" in the IR tab.`,
        },
        {
          name: 'agent-spec-requested',
          passed: true,
          details: `Captured ${responseCaptures.length} ${responsePattern} response(s).`,
        },
        {
          name: 'ir-json-visible',
          passed: true,
          details: `Observed IR JSON text "${irVisibleText}" in the IR tab.`,
        },
      ],
    };
  },
};
