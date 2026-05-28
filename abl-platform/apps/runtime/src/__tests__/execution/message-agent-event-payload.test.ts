import { describe, expect, test } from 'vitest';
import { buildMessageAgentPayload } from '../../services/event-bus/message-event-payload.js';

describe('message.agent event payload', () => {
  test('preserves structured assistant output and response metadata', () => {
    const responseMetadata = {
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1 as const,
        kind: 'llm' as const,
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    };
    const richContent = { markdown: '**Payment cards**' };
    const actions = {
      elements: [{ type: 'button', id: 'card_9876', label: 'Platinum Rewards' }],
    };
    const voiceConfig = { plain_text: 'Payment cards.' };

    const payload = buildMessageAgentPayload({
      messageId: 'message-1',
      messageIndex: 4,
      result: {
        response: 'Payment cards.',
        action: { type: 'continue' },
        richContent,
        actions,
        voiceConfig,
        responseMetadata,
      },
    });

    expect(payload).toMatchObject({
      messageId: 'message-1',
      content: 'Payment cards.',
      messageIndex: 4,
      structuredContent: {
        richContent,
        actions,
        voiceConfig,
      },
      contentEnvelope: {
        version: 2,
        format: 'message_envelope',
        text: 'Payment cards.',
        richContent,
        actions,
        voiceConfig,
      },
      responseMetadata,
    });
  });
});
