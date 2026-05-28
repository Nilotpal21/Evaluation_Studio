import { REQUEST_TIMEOUT_MS } from '../lib/constants.mjs';
import { createStudioFixture } from '../lib/studio-harness.mjs';
import {
  openStudioAgentChat,
  sendStudioChatMessage,
  waitForIdle,
  waitForMessageListText,
} from '../lib/studio-chat.mjs';
import { numberFromInput, uniqueSuffix, waitForCondition } from '../lib/utils.mjs';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createSyntheticAgent(agentName) {
  return {
    id: agentName,
    name: agentName,
    type: 'agent',
    mode: 'reasoning',
    toolCount: 0,
    gatherFieldCount: 0,
    isSupervisor: false,
    dsl: `AGENT: ${agentName}\nGOAL: "Synthetic websocket evidence agent"\n`,
    ir: {},
  };
}

function makeTraceEvent(sessionId, agentName, type, data, timestampOffsetMs = 0) {
  const timestamp = new Date(Date.now() + timestampOffsetMs).toISOString();
  const suffix = uniqueSuffix().replace(/[^a-z0-9]+/gi, '');
  return {
    id: `evt_${suffix}`,
    sessionId,
    traceId: `trace_${suffix}`,
    spanId: `span_${suffix}`,
    type,
    timestamp,
    agentName,
    data,
  };
}

async function clickLabeledControl(page, label, { first = false } = {}) {
  const normalizedLabel = String(label ?? '').trim();
  if (!normalizedLabel) {
    return false;
  }

  const exactPattern = new RegExp(`^${escapeRegExp(normalizedLabel)}$`, 'i');
  const loosePattern = new RegExp(`^\\s*${escapeRegExp(normalizedLabel)}\\s*$`, 'i');
  const candidates = [
    first
      ? page.getByRole('button', { name: exactPattern }).first()
      : page.getByRole('button', { name: exactPattern }).last(),
    first
      ? page.getByRole('tab', { name: exactPattern }).first()
      : page.getByRole('tab', { name: exactPattern }).last(),
    first
      ? page.locator('button, [role="tab"]').filter({ hasText: loosePattern }).first()
      : page.locator('button, [role="tab"]').filter({ hasText: loosePattern }).last(),
    first
      ? page.getByText(normalizedLabel, { exact: true }).first()
      : page.getByText(normalizedLabel, { exact: true }).last(),
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

async function openDebugTab(page, label) {
  await page.getByRole('button', { name: /debug/i }).first().click({
    timeout: REQUEST_TIMEOUT_MS,
  });

  const opened = await clickLabeledControl(page, label, { first: true });
  if (!opened) {
    throw new Error(`Unable to open debug tab "${label}".`);
  }
}

async function installSyntheticWebSocket(page, issue, agentName) {
  const sessionId = `synthetic-session-${uniqueSuffix()}`;
  let turnIndex = 0;

  await page.routeWebSocket(/\/ws$/, (ws) => {
    ws.onMessage((raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      if (message.type === 'load_agent' || message.type === 'load_agent_with_context') {
        ws.send(
          JSON.stringify({
            type: 'agent_loaded',
            sessionId,
            agent: createSyntheticAgent(agentName),
          }),
        );
        return;
      }

      if (message.type !== 'send_message') {
        return;
      }

      turnIndex += 1;
      const text = String(message.text ?? '');
      const responseMessageId = `synthetic-response-${turnIndex}`;

      const sendTrace = (type, data, delayMs = 0) => {
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              type: 'trace_event',
              sessionId,
              event: makeTraceEvent(sessionId, agentName, type, data, delayMs),
            }),
          );
        }, delayMs);
      };

      if (issue === 'ABLP-517') {
        sendTrace('user_message', { content: text, role: 'user' }, 20);
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              type: 'trace_event',
              sessionId,
              event: makeTraceEvent(sessionId, agentName, 'error', {}, 30),
            }),
          );
        }, 60);
        setTimeout(() => {
          ws.send(
            JSON.stringify({ type: 'response_start', sessionId, messageId: responseMessageId }),
          );
        }, 120);
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              type: 'response_end',
              sessionId,
              messageId: responseMessageId,
              fullText: 'Tool execution succeeded after the transient runtime error.',
            }),
          );
        }, 220);
        return;
      }

      if (issue === 'ABLP-523') {
        sendTrace('user_message', { content: text, role: 'user' }, 20);
        sendTrace(
          'tool_call',
          {
            tool: 'crm_lookup',
            toolName: 'crm_lookup',
            input: { customerId: 'cust-123' },
            result: { name: 'Alice' },
            success: true,
            latencyMs: 94,
            url: 'https://internal.example.test/crm',
            method: 'GET',
          },
          80,
        );
        sendTrace(
          'tool_call',
          {
            tool: 'balance_lookup',
            toolName: 'balance_lookup',
            input: { accountId: 'acc-987' },
            result: { balance: 42 },
            success: true,
            latencyMs: 101,
            url: 'https://internal.example.test/balance',
            method: 'GET',
          },
          120,
        );
        sendTrace('agent_response', { contentLength: 24 }, 180);
        setTimeout(() => {
          ws.send(
            JSON.stringify({ type: 'response_start', sessionId, messageId: responseMessageId }),
          );
        }, 200);
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              type: 'response_end',
              sessionId,
              messageId: responseMessageId,
              fullText: 'Parallel tools completed.',
            }),
          );
        }, 260);
        return;
      }

      if (issue === 'ABLP-525') {
        sendTrace('user_message', { content: text, role: 'user' }, 20);
        sendTrace(
          'llm_call',
          {
            model: 'synthetic-observability-model',
            usage: { inputTokens: 84, outputTokens: 16 },
            rawRequest: { messages: [{ role: 'user', content: text }] },
            rawResponse: { content: `Response for ${text}` },
          },
          60,
        );
        sendTrace('agent_response', { contentLength: 18 }, 120);
        setTimeout(() => {
          ws.send(
            JSON.stringify({ type: 'response_start', sessionId, messageId: responseMessageId }),
          );
        }, 140);
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              type: 'response_end',
              sessionId,
              messageId: responseMessageId,
              fullText: `Response for ${text}`,
            }),
          );
        }, 220);
      }
    });
  });

  return { sessionId };
}

async function runAblp517(context, fixture) {
  const { artifacts, baseUrl, page } = context;
  const agentName = fixture.agentName;
  const userMessage = 'Run the failing tool once.';

  await installSyntheticWebSocket(page, 'ABLP-517', agentName);
  await openStudioAgentChat(page, baseUrl, {
    projectId: fixture.projectId,
    agentName,
  });
  await sendStudioChatMessage(page, userMessage);
  await waitForMessageListText(page, 'Tool execution succeeded after the transient runtime error.');
  await waitForIdle(page, 600);
  await waitForCondition(
    async () => {
      const errorBubbleCount = await page.getByTestId('error-message').count();
      const genericErrorTextCount = await page
        .getByTestId('message-list')
        .getByText(/An error occurred/i)
        .count();
      return errorBubbleCount === 0 && genericErrorTextCount === 0;
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 200,
      label:
        'Timed out waiting for the transient trace error to stay out of the Studio transcript.',
    },
  );
  await artifacts.captureScreenshot('ablp-517-no-error-bubble-after-success.png');

  const errorBubbleCount = await page.getByTestId('error-message').count();
  const genericErrorTextCount = await page
    .getByTestId('message-list')
    .getByText(/An error occurred/i)
    .count();

  return {
    summary:
      'ABLP-517: Studio keeps transient trace_event errors in observability only and renders just the successful assistant reply when the turn ultimately succeeds.',
    metadata: {
      issue: 'ABLP-517',
      projectId: fixture.projectId,
      agentName,
      userMessage,
      errorBubbleCount,
      genericErrorTextCount,
    },
    assertions: [
      {
        name: 'no-generic-error-bubble-after-success',
        passed: true,
        details:
          'The synthetic trace_event error stayed out of the transcript while the successful assistant reply rendered normally.',
      },
    ],
  };
}

async function runAblp523(context, fixture) {
  const { artifacts, baseUrl, page } = context;
  const agentName = fixture.agentName;
  const userMessage = 'Run both lookups in parallel.';

  await installSyntheticWebSocket(page, 'ABLP-523', agentName);
  await openStudioAgentChat(page, baseUrl, {
    projectId: fixture.projectId,
    agentName,
  });
  await openDebugTab(page, 'Traces');
  await sendStudioChatMessage(page, userMessage);
  await waitForCondition(
    async () =>
      (await page.getByText('crm_lookup', { exact: false }).count()) > 0 &&
      (await page.getByText('balance_lookup', { exact: false }).count()) > 0,
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 200,
      label: 'Timed out waiting for both parallel tool cards to render.',
    },
  );
  await waitForIdle(page, 600);
  await artifacts.captureScreenshot('ablp-523-parallel-tool-cards.png');

  const visibleBalanceToolCount = await page.getByText('balance_lookup', { exact: false }).count();
  const visibleCrmToolCount = await page.getByText('crm_lookup', { exact: false }).count();
  const detailButtonCount = await page
    .getByRole('button', { name: /^Details$/i })
    .count()
    .catch(() => 0);

  return {
    summary:
      'ABLP-523: the Interactions surface renders crm_lookup and balance_lookup as separate visible child tool cards within the same step.',
    metadata: {
      issue: 'ABLP-523',
      projectId: fixture.projectId,
      agentName,
      userMessage,
      visibleCrmToolCount,
      visibleBalanceToolCount,
      detailButtonCount,
    },
    assertions: [
      {
        name: 'parallel-tool-cards-visible',
        passed: visibleBalanceToolCount > 0 && visibleCrmToolCount > 0,
        details:
          'Both crm_lookup and balance_lookup render directly in the Interactions card without relying on the raw event drawer.',
      },
      {
        name: 'multiple-tool-detail-toggles',
        passed: detailButtonCount >= 2,
        details:
          'Each visible tool card exposes its own Details control, confirming the renderer produced multiple child cards instead of one collapsed card.',
      },
    ],
  };
}

async function runAblp525(context, fixture) {
  const { artifacts, baseUrl, page } = context;
  const agentName = fixture.agentName;
  const firstMessage = 'start turn one';
  const secondMessage = 'start turn two';

  await installSyntheticWebSocket(page, 'ABLP-525', agentName);
  await openStudioAgentChat(page, baseUrl, {
    projectId: fixture.projectId,
    agentName,
  });
  await openDebugTab(page, 'Traces');
  await sendStudioChatMessage(page, firstMessage);
  await page.getByText(`Response for ${firstMessage}`, { exact: false }).first().waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await sendStudioChatMessage(page, secondMessage);
  await page.getByText(`Response for ${secondMessage}`, { exact: false }).first().waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
  await waitForCondition(
    async () =>
      (await page
        .getByRole('button', { name: /Interaction 2 with/i })
        .first()
        .getAttribute('aria-expanded')
        .catch(() => null)) === 'true',
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 200,
      label: 'Timed out waiting for the latest interaction to auto-expand.',
    },
  );
  await waitForIdle(page, 600);
  await artifacts.captureScreenshot('ablp-525-auto-progressing-interactions.png');

  return {
    summary:
      'ABLP-525: the current Interactions tab auto-expands to the latest turn as the user keeps chatting, so the stalled auto-progress regression is not reproducing locally.',
    metadata: {
      issue: 'ABLP-525',
      projectId: fixture.projectId,
      agentName,
      firstMessage,
      secondMessage,
    },
    assertions: [
      {
        name: 'latest-interaction-auto-expanded',
        passed: true,
        details:
          'Interaction 2 auto-expanded without any manual click after the second synthetic turn arrived.',
      },
    ],
  };
}

export const scenario = {
  id: 'ablp-ws-observability',
  title: 'ABLP WebSocket Observability Evidence',
  description:
    'Runs deterministic synthetic-websocket evidence flows for the Studio transcript and observability regressions by passing --issue <key>.',
  example: 'pnpm studio:video:evidence -- --scenario ablp-ws-observability --issue ABLP-517',
  async run(context) {
    const { options, page } = context;
    const issue = String(options.issue ?? '')
      .trim()
      .toUpperCase();
    if (!issue) {
      throw new Error('ablp-ws-observability requires --issue <ABLP-key>.');
    }

    const finalPauseMs = numberFromInput(options.finalPauseMs, 1200);
    const fixture = await createStudioFixture(context, {
      requireProject: true,
      requireAgent: true,
    });

    if (!fixture.projectId || !fixture.agentName) {
      throw new Error('ablp-ws-observability requires a project and agent fixture.');
    }

    let result;
    switch (issue) {
      case 'ABLP-517':
        result = await runAblp517(context, fixture);
        break;
      case 'ABLP-523':
        result = await runAblp523(context, fixture);
        break;
      case 'ABLP-525':
        result = await runAblp525(context, fixture);
        break;
      default:
        throw new Error(`ablp-ws-observability does not support issue ${issue}.`);
    }

    await waitForIdle(page, 400);
    await page.waitForTimeout(finalPauseMs);
    return result;
  },
};
