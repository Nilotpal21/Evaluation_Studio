import { describe, expect, it } from 'vitest';
import {
  buildV1Envelope,
  buildV1ErrorEnvelope,
} from '../../../services/agent-assist/envelope-builder.js';

describe('buildV1Envelope', () => {
  it('produces the V1 response shape Kore.ai Agent Assist parses today', () => {
    const envelope = buildV1Envelope({
      messageId: 'msg_abc',
      sessionId: 's-1',
      runId: 'r-1',
      appId: 'aa-abc',
      sessionReference: 'conv-1',
      userReference: 'user-1',
      userId: 'u-1',
      source: 'AIS-AA',
      outputText: 'here is a reply',
    });
    expect(envelope).toEqual({
      messageId: 'msg_abc',
      output: [{ type: 'text', content: 'here is a reply' }],
      sessionInfo: {
        sessionId: 's-1',
        runId: 'r-1',
        status: 'completed',
        sessionReference: 'conv-1',
        userReference: 'user-1',
        userId: 'u-1',
        appId: 'aa-abc',
        source: 'AIS-AA',
      },
    });
  });

  it('includes metadata when callers provided any', () => {
    const envelope = buildV1Envelope({
      messageId: 'msg',
      sessionId: 's',
      runId: 'r',
      appId: 'aa-1',
      outputText: 'x',
      metadata: { conversationId: 'c' },
    });
    expect(envelope.metadata).toEqual({ conversationId: 'c' });
  });

  it('adds structured output fields without changing the legacy text block contract', () => {
    const envelope = buildV1Envelope({
      messageId: 'msg',
      sessionId: 's',
      runId: 'r',
      appId: 'aa-1',
      outputText: '',
      richContent: { markdown: '**Choose**' },
      actions: { elements: [{ id: 'choose', type: 'button', label: 'Choose' }] },
      voiceConfig: { plain_text: 'Choose.' },
      contentEnvelope: {
        version: 2,
        format: 'message_envelope',
        text: '',
        richContent: { markdown: '**Choose**' },
        actions: { elements: [{ id: 'choose', type: 'button', label: 'Choose' }] },
        voiceConfig: { plain_text: 'Choose.' },
      },
    });

    expect(envelope.output[0]).toMatchObject({
      type: 'text',
      content: '',
      richContent: { markdown: '**Choose**' },
      actions: { elements: [{ id: 'choose', type: 'button', label: 'Choose' }] },
      voiceConfig: { plain_text: 'Choose.' },
      contentEnvelope: {
        version: 2,
        format: 'message_envelope',
        richContent: { markdown: '**Choose**' },
      },
    });
  });

  it('omits metadata when the metadata object is empty', () => {
    const envelope = buildV1Envelope({
      messageId: 'msg',
      sessionId: 's',
      runId: 'r',
      appId: 'aa-1',
      outputText: 'x',
      metadata: {},
    });
    expect(envelope.metadata).toBeUndefined();
  });
});

describe('buildV1ErrorEnvelope', () => {
  it('sets sessionInfo.status = "error" per the V1 runtime-error contract', () => {
    const envelope = buildV1ErrorEnvelope({
      messageId: 'msg',
      sessionId: 's',
      runId: 'r',
      appId: 'aa-1',
      outputText: 'something went wrong (sanitized)',
    });
    expect(envelope.sessionInfo.status).toBe('error');
    expect(envelope.output[0]).toEqual({
      type: 'text',
      content: 'something went wrong (sanitized)',
    });
  });
});
