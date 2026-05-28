import { REQUEST_TIMEOUT_MS } from '../lib/constants.mjs';
import {
  apiJson,
  assertExactMessageBubbleCount,
  bootstrapStudioBrowserSession,
  loginBrowserViaDevApi,
  sendStudioChatMessage,
  waitForIdle,
  waitForMessageListText,
} from '../lib/studio-chat.mjs';
import { createStudioFixture, openStudioSurface } from '../lib/studio-harness.mjs';
import { numberFromInput, uniqueSuffix, waitForCondition } from '../lib/utils.mjs';

function sessionShortIdLocator(page) {
  return page.locator('span.font-mono');
}

async function readCurrentSessionShortId(page) {
  const locator = sessionShortIdLocator(page).first();
  const visible = await locator.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!visible) {
    return '';
  }

  return (await locator.textContent().catch(() => ''))?.trim() ?? '';
}

function readTrimmedOption(options, ...keys) {
  for (const key of keys) {
    const value = options?.[key];
    if (value == null) continue;
    const normalized = String(value).trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return '';
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

function pickNewestUnknownSession(sessions, knownSessionIds) {
  const unknownSessions = sessions.filter((session) => !knownSessionIds.has(session.id));
  if (unknownSessions.length === 0) {
    return null;
  }

  return (
    unknownSessions.find((session) => Number(session.messageCount ?? 0) > 0) ??
    unknownSessions[0] ??
    null
  );
}

function findSessionByShortId(sessions, shortId, knownSessionIds = new Set()) {
  const normalizedShortId = String(shortId ?? '').trim();
  if (!normalizedShortId) {
    return null;
  }

  return (
    sessions.find(
      (session) =>
        typeof session?.id === 'string' &&
        session.id.startsWith(normalizedShortId) &&
        !knownSessionIds.has(session.id),
    ) ?? null
  );
}

async function countRenderedMessages(page) {
  return await page
    .locator('[data-testid="message-list"] > div')
    .count()
    .catch(() => 0);
}

async function waitForTurnResponse(page, previousRenderedMessageCount) {
  await waitForCondition(
    async () => {
      const renderedCount = await countRenderedMessages(page);
      return renderedCount >= previousRenderedMessageCount + 2 ? true : false;
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 250,
      label:
        'Expected the message list to render both the new user bubble and at least one response bubble.',
    },
  );

  await page
    .locator('[data-testid="typing-indicator"]')
    .waitFor({ state: 'hidden', timeout: REQUEST_TIMEOUT_MS })
    .catch(() => {});
  await page
    .locator('[data-testid="streaming-message"]')
    .waitFor({ state: 'hidden', timeout: REQUEST_TIMEOUT_MS })
    .catch(() => {});
  await page.waitForTimeout(500);
}

function buildMultiTurnAgentDsl(agentName, assistantReplyBase) {
  const escapedReplyBase = assistantReplyBase.replaceAll('"', '\\"');
  return `
AGENT: ${agentName}
GOAL: "Provide deterministic multi-turn Studio session switch evidence replies"
PERSONA: "Regression verification agent"

FLOW:
  entry_point: initialize
  steps:
    - initialize
    - ask
    - respond

initialize:
  REASONING: false
  SET: turn_count = 0
  THEN: ask

ask:
  REASONING: false
  SET: user_message = ""
  GATHER:
    - user_message:
        type: string
        required: true
        prompt: "Continue the Studio session switch validation."
  THEN: respond

respond:
  REASONING: false
  SET: turn_count = turn_count + 1
  RESPOND: "${escapedReplyBase} turn {{turn_count}}"
  THEN: ask
`;
}

export const scenario = {
  id: 'studio-chat-session-switch-debug',
  title: 'Studio Chat Session Switch Debug',
  description:
    'Creates or reuses two Studio chat sessions, switches back to the first one, and verifies both the transcript and Debug/Traces panel restore correctly.',
  example:
    'pnpm studio:video:evidence -- --scenario studio-chat-session-switch-debug --first-message "Hello" --second-message "Switch proof" --turn-count 5',
  async run(context) {
    const { options, artifacts, page } = context;
    const suffix = uniqueSuffix();
    const turnCount = Math.max(1, numberFromInput(options.turnCount, 5));
    const firstMessageBase = String(
      options.firstMessage ?? `Studio switch-back first turn ${suffix}`,
    ).trim();
    const secondMessage = String(
      options.secondMessage ?? `Studio switch-back second turn ${suffix}`,
    ).trim();
    const firstSessionMessages = Array.from({ length: turnCount }, (_, index) => {
      if (turnCount === 1) {
        return firstMessageBase;
      }
      return `${firstMessageBase} ${index + 1}`;
    });
    const assistantReplyBase = String(
      options.assistantReply ??
        'Acknowledged. Studio session switch debug evidence completed successfully.',
    ).trim();
    const accessToken = readTrimmedOption(options, 'accessToken');
    const refreshToken = readTrimmedOption(options, 'refreshToken');
    const tenantId = readTrimmedOption(options, 'tenantId');
    const projectId = readTrimmedOption(options, 'projectId');
    const projectName = readTrimmedOption(options, 'projectName');
    const agentName = readTrimmedOption(options, 'agentName');
    const email = readTrimmedOption(options, 'email');
    const loginName = readTrimmedOption(options, 'loginName', 'name') || 'Studio Video Evidence';
    const useExistingAgent = Boolean(
      projectId && agentName && (accessToken || refreshToken || email),
    );
    const useTokenBootstrap = Boolean(projectId && agentName && (accessToken || refreshToken));

    if (
      Boolean(projectId || agentName || accessToken || refreshToken || tenantId) &&
      !useExistingAgent
    ) {
      throw new Error(
        'Existing-agent session switch capture requires --project-id, --agent-name, and either --email, --access-token, or --refresh-token.',
      );
    }

    const fixture = useExistingAgent
      ? useTokenBootstrap
        ? {
            ...(await bootstrapStudioBrowserSession(page, context.baseUrl, {
              accessToken,
              refreshToken,
              tenantId,
              landingPath: '/projects',
            })),
            agentName,
            createdAgent: false,
            createdProject: false,
            email: null,
            loginName: 'Token Bootstrap',
            projectId,
            projectName: projectName || null,
            suffix,
          }
        : {
            ...(await loginBrowserViaDevApi(page, context.baseUrl, {
              email,
              name: loginName,
              landingPath: '/projects',
            })),
            agentName,
            createdAgent: false,
            createdProject: false,
            email,
            loginName,
            projectId,
            projectName: projectName || null,
            suffix,
          }
      : await createStudioFixture(context, {
          requireProject: true,
          requireAgent: true,
          assistantReply: assistantReplyBase,
          agentDslContent: buildMultiTurnAgentDsl(
            `studio_video_evidence_agent_${suffix}`,
            assistantReplyBase,
          ),
        });

    const firstSessionAssistantReplies = useExistingAgent
      ? []
      : Array.from({ length: turnCount }, (_, index) => `${assistantReplyBase} turn ${index + 1}`);
    const knownSessionIds = new Set(
      (await listProjectSessions(context.baseUrl, fixture.accessToken, fixture.projectId)).map(
        (session) => session.id,
      ),
    );

    const navigation = await openStudioSurface(context, 'agent-chat', fixture);
    await artifacts.captureScreenshot('agent-chat-ready.png');

    for (let index = 0; index < firstSessionMessages.length; index += 1) {
      const firstMessage = firstSessionMessages[index];
      const previousRenderedMessageCount = await countRenderedMessages(page);
      await sendStudioChatMessage(page, firstMessage);
      await waitForMessageListText(page, firstMessage, REQUEST_TIMEOUT_MS);
      await assertExactMessageBubbleCount(page, firstMessage, 1, {
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (useExistingAgent) {
        await waitForTurnResponse(page, previousRenderedMessageCount);
      } else {
        await waitForMessageListText(page, firstSessionAssistantReplies[index], REQUEST_TIMEOUT_MS);
      }
    }
    await waitForIdle(page, 1_000);
    const firstSessionShortIdFromUi = await readCurrentSessionShortId(page);
    const firstSessionList = await waitForCondition(
      async () => {
        const sessions = await listProjectSessions(
          context.baseUrl,
          fixture.accessToken,
          fixture.projectId,
        );
        const firstSession =
          findSessionByShortId(sessions, firstSessionShortIdFromUi, knownSessionIds) ??
          pickNewestUnknownSession(sessions, knownSessionIds);
        return firstSession ? sessions : false;
      },
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
        label: 'Expected the first chat session to appear in the project session list.',
      },
    );
    const firstSession =
      findSessionByShortId(firstSessionList, firstSessionShortIdFromUi, knownSessionIds) ??
      pickNewestUnknownSession(firstSessionList, knownSessionIds) ??
      firstSessionList[0] ??
      null;
    if (!firstSession?.id) {
      throw new Error('Failed to resolve the first session id for the switch-back capture.');
    }
    knownSessionIds.add(firstSession.id);
    await artifacts.captureScreenshot('session-one-complete.png');

    await page
      .getByRole('button', { name: /new chat/i })
      .first()
      .click();
    await waitForIdle(page, 1_000);

    const secondSessionPreviousRenderedMessageCount = await countRenderedMessages(page);
    await sendStudioChatMessage(page, secondMessage);
    await waitForMessageListText(page, secondMessage, REQUEST_TIMEOUT_MS);
    if (useExistingAgent) {
      await waitForTurnResponse(page, secondSessionPreviousRenderedMessageCount);
    } else {
      await waitForMessageListText(page, `${assistantReplyBase} turn 1`, REQUEST_TIMEOUT_MS);
    }
    const secondSessionShortIdFromUi = await readCurrentSessionShortId(page);

    const projectSessions = await waitForCondition(
      async () => {
        const sessions = await listProjectSessions(
          context.baseUrl,
          fixture.accessToken,
          fixture.projectId,
        );
        const secondSession =
          findSessionByShortId(sessions, secondSessionShortIdFromUi, knownSessionIds) ??
          pickNewestUnknownSession(sessions, knownSessionIds);
        return secondSession ? sessions : false;
      },
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
        label: 'Expected the project session list to contain the second Studio chat session.',
      },
    );
    const secondSession =
      findSessionByShortId(projectSessions, secondSessionShortIdFromUi, knownSessionIds) ??
      pickNewestUnknownSession(projectSessions, knownSessionIds) ??
      projectSessions[0] ??
      null;
    if (!secondSession?.id) {
      throw new Error('Failed to resolve the second session id for the switch-back capture.');
    }
    knownSessionIds.add(secondSession.id);
    const priorSessionShortIds = projectSessions.map((session) => session.id.slice(0, 8));
    const firstSessionShortId = firstSessionShortIdFromUi || firstSession.id.slice(0, 8);
    if (!firstSessionShortId) {
      throw new Error(
        'Failed to resolve the first session short id from the project session list.',
      );
    }
    await artifacts.captureScreenshot('session-two-complete.png');

    await page.getByText(firstSessionShortId, { exact: true }).first().waitFor({
      state: 'visible',
      timeout: REQUEST_TIMEOUT_MS,
    });
    await page.getByText(firstSessionShortId, { exact: true }).first().click();
    const restoredSessionShortId = firstSessionShortId;

    for (const firstMessage of firstSessionMessages) {
      await waitForMessageListText(page, firstMessage, REQUEST_TIMEOUT_MS);
    }
    for (const assistantReply of firstSessionAssistantReplies) {
      await waitForMessageListText(page, assistantReply, REQUEST_TIMEOUT_MS);
    }
    await waitForCondition(
      async () => (await page.getByText(secondMessage, { exact: true }).count()) === 0,
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
        label: 'Expected the second session message to be absent after switching back.',
      },
    );
    await waitForIdle(page, 1_000);
    await artifacts.captureScreenshot('session-one-restored.png');

    await page.getByRole('button', { name: /debug/i }).first().click();
    const tracesTab = page.getByRole('button', { name: /^Traces/i }).first();
    await tracesTab.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
    await tracesTab.click();
    await waitForCondition(
      async () => (await page.getByText('No interactions recorded').count()) === 0,
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
        label: 'Expected Debug > Traces to contain recorded interactions.',
      },
    );
    await waitForCondition(
      async () => {
        return await page
          .getByText('Interactions:')
          .isVisible()
          .catch(() => false);
      },
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
        label: 'Expected the Debug > Traces header to become visible.',
      },
    );
    await artifacts.captureScreenshot('session-one-debug-traces.png');

    const finalPauseMs = numberFromInput(options.finalPauseMs, 2_000);
    await page.waitForTimeout(finalPauseMs);

    return {
      summary:
        'Recorded a Studio session switch-back flow and verified the original transcript plus Debug/Traces state restored after returning to the first session.',
      metadata: {
        surfaceId: navigation.surface.id,
        route: navigation.route,
        projectId: fixture.projectId ?? null,
        projectName: fixture.projectName ?? null,
        agentName: fixture.agentName ?? null,
        email: fixture.email,
        firstSessionMessages,
        firstSessionAssistantReplies,
        secondMessage,
        assistantReplyBase,
        authMode: useExistingAgent
          ? useTokenBootstrap
            ? 'token-bootstrap'
            : 'dev-login'
          : 'fixture',
        firstSessionId: firstSession.id,
        secondSessionId: secondSession.id,
        firstSessionShortId: restoredSessionShortId,
        priorSessionShortIds,
        turnCount,
      },
      assertions: [
        {
          name: 'surface-ready',
          passed: true,
          details: `Loaded ${navigation.surface.title} at ${navigation.route}`,
        },
        {
          name: 'first-session-restored',
          passed: true,
          details: `Switched back to session ${restoredSessionShortId} and observed ${String(turnCount)} restored message(s) from the first session.`,
        },
        {
          name: 'second-session-hidden',
          passed: true,
          details: `Confirmed the second-session message "${secondMessage}" was not present after the switch-back.`,
        },
        {
          name: 'debug-traces-visible',
          passed: true,
          details: 'Opened Debug → Traces and observed non-empty interaction content.',
        },
      ],
    };
  },
};
