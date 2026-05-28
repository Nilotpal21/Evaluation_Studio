import { REQUEST_TIMEOUT_MS } from '../lib/constants.mjs';
import {
  assertExactMessageBubbleCount,
  sampleExactMessageBubbleCount,
  sendStudioChatMessage,
  waitForIdle,
  waitForMessageListText,
} from '../lib/studio-chat.mjs';
import { createStudioFixture, openStudioSurface } from '../lib/studio-harness.mjs';
import { boolFromInput, numberFromInput, uniqueSuffix } from '../lib/utils.mjs';

export const scenario = {
  id: 'studio-chat-single-turn',
  title: 'Studio Chat Single Turn',
  description:
    'Creates a disposable Studio project and static-response agent, starts a new chat session, records the turn, and verifies the user message stays single-copy during the live response.',
  example:
    'pnpm studio:video:evidence -- --scenario studio-chat-single-turn --user-message "Hello" --assistant-reply "Hi there"',
  async run(context) {
    const { options, page, artifacts } = context;

    const suffix = uniqueSuffix();
    const userMessage = String(
      options.userMessage ?? `Studio video evidence single-turn ${suffix}`,
    ).trim();
    const assistantReply = String(
      options.assistantReply ??
        'Acknowledged. The Studio chat single-turn video evidence completed successfully.',
    ).trim();
    const assertSingleUserBubble = boolFromInput(options.assertSingleUserBubble, true);
    const sampleCount = numberFromInput(options.sampleCount, 12);
    const sampleIntervalMs = numberFromInput(options.sampleIntervalMs, 250);
    const finalPauseMs = numberFromInput(options.finalPauseMs, 2_000);
    const fixture = await createStudioFixture(context, {
      requireProject: true,
      requireAgent: true,
      assistantReply,
    });
    await openStudioSurface(context, 'agent-chat', fixture);
    await artifacts.captureScreenshot('chat-ready.png');

    await sendStudioChatMessage(page, userMessage);

    const assertions = [];
    if (assertSingleUserBubble) {
      await assertExactMessageBubbleCount(page, userMessage, 1, {
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      const samples = await sampleExactMessageBubbleCount(page, userMessage, 1, {
        sampleCount,
        intervalMs: sampleIntervalMs,
      });
      assertions.push({
        name: 'single-user-bubble',
        passed: true,
        details: `Observed user bubble samples: ${samples.join(', ')}`,
      });
    }

    await waitForMessageListText(page, assistantReply, REQUEST_TIMEOUT_MS);
    assertions.push({
      name: 'assistant-reply-visible',
      passed: true,
      details: `Observed assistant reply: ${assistantReply}`,
    });

    await waitForIdle(page, 1_000);
    await artifacts.captureScreenshot('chat-complete.png');
    await page.waitForTimeout(finalPauseMs);

    return {
      summary:
        'Recorded a disposable Studio chat turn and verified the user message remained single-copy during the assistant response.',
      metadata: {
        email: fixture.email,
        projectId: fixture.projectId,
        projectName: fixture.projectName,
        agentName: fixture.agentName,
        userMessage,
        assistantReply,
      },
      assertions,
    };
  },
};
