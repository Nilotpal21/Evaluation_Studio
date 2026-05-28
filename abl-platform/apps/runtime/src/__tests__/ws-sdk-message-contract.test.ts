/**
 * Regression tests for the WebSocket SDK message contract.
 *
 * Verifies that every message type the SDK handler can emit is:
 *   1. Representable in the typed ServerMessage union
 *   2. Constructable via the ServerMessages factory
 *   3. Round-trippable through serializeServerMessage → JSON.parse
 *
 * Also tests parseClientMessage for known SDK client message types.
 */
import { describe, it, expect } from 'vitest';
import { ServerMessages, serializeServerMessage, parseClientMessage } from '../websocket/events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a ServerMessage through serialize → JSON.parse and assert type field */
function roundTrip(msg: ReturnType<(typeof ServerMessages)[keyof typeof ServerMessages]>) {
  const json = serializeServerMessage(msg);
  expect(typeof json).toBe('string');
  const parsed = JSON.parse(json);
  expect(parsed).toHaveProperty('type');
  return parsed;
}

// ---------------------------------------------------------------------------
// SDK session lifecycle messages
// ---------------------------------------------------------------------------
describe('SDK session lifecycle messages', () => {
  it('session_start includes sessionId, projectId, and permissions', () => {
    const msg = ServerMessages.sessionStart('sid-1', 'proj-1', { chat: true, voice: false });
    const parsed = roundTrip(msg);
    expect(parsed).toEqual({
      type: 'session_start',
      sessionId: 'sid-1',
      projectId: 'proj-1',
      permissions: { chat: true, voice: false },
    });
  });

  it('session_start includes optional traceId', () => {
    const msg = ServerMessages.sessionStart('sid-1', 'proj-1', { chat: true, voice: true }, 'tr-1');
    const parsed = roundTrip(msg);
    expect(parsed.traceId).toBe('tr-1');
  });

  it('session_ended carries sessionId', () => {
    const parsed = roundTrip(ServerMessages.sessionEnded('sid-1'));
    expect(parsed).toEqual({ type: 'session_ended', sessionId: 'sid-1' });
  });
});

// ---------------------------------------------------------------------------
// SDK action delivery
// ---------------------------------------------------------------------------
describe('SDK action delivery', () => {
  it('action carries sessionId and ConstructAction', () => {
    const action = { type: 'continue' as const };
    const parsed = roundTrip(ServerMessages.action('sid-1', action));
    expect(parsed).toEqual({
      type: 'action',
      sessionId: 'sid-1',
      action: { type: 'continue' },
    });
  });
});

// ---------------------------------------------------------------------------
// Voice messages
// ---------------------------------------------------------------------------
describe('Voice messages', () => {
  it('voice_token carries token and identity', () => {
    const parsed = roundTrip(ServerMessages.voiceToken('tok-1', 'ident-1'));
    expect(parsed).toEqual({ type: 'voice_token', token: 'tok-1', identity: 'ident-1' });
  });

  it('voice_error carries message', () => {
    const parsed = roundTrip(ServerMessages.voiceError('something broke'));
    expect(parsed).toEqual({ type: 'voice_error', message: 'something broke' });
  });

  it('voice_started carries sessionId and voiceMode', () => {
    const parsed = roundTrip(ServerMessages.voiceStarted('sid-1', 'realtime'));
    expect(parsed).toEqual({ type: 'voice_started', sessionId: 'sid-1', voiceMode: 'realtime' });
  });

  it('voice_started carries optional voice capabilities', () => {
    const parsed = roundTrip(
      ServerMessages.voiceStarted('sid-1', 'realtime', {
        localBargeIn: true,
        remoteTypedInterrupt: true,
        dtmf: false,
        returnToParent: true,
        activeAgentSync: false,
      }),
    );
    expect(parsed).toEqual({
      type: 'voice_started',
      sessionId: 'sid-1',
      voiceMode: 'realtime',
      capabilities: {
        localBargeIn: true,
        remoteTypedInterrupt: true,
        dtmf: false,
        returnToParent: true,
        activeAgentSync: false,
      },
    });
  });

  it('voice_stopped carries sessionId', () => {
    const parsed = roundTrip(ServerMessages.voiceStopped('sid-1'));
    expect(parsed).toEqual({ type: 'voice_stopped', sessionId: 'sid-1' });
  });

  it('voice_barge_in_ack has no payload beyond type', () => {
    const parsed = roundTrip(ServerMessages.voiceBargeInAck());
    expect(parsed).toEqual({ type: 'voice_barge_in_ack' });
  });

  it('voice_realtime_audio carries audio and format', () => {
    const parsed = roundTrip(ServerMessages.voiceRealtimeAudio('base64data', 'pcm'));
    expect(parsed).toEqual({
      type: 'voice_realtime_audio',
      audio: 'base64data',
      format: 'pcm',
    });
  });

  it('voice_realtime_transcript carries text, isFinal, and role', () => {
    const parsed = roundTrip(ServerMessages.voiceRealtimeTranscript('hello world', true, 'user'));
    expect(parsed).toEqual({
      type: 'voice_realtime_transcript',
      text: 'hello world',
      isFinal: true,
      role: 'user',
    });
  });
});

// ---------------------------------------------------------------------------
// Auth preflight and message queuing
// ---------------------------------------------------------------------------
describe('Auth preflight messages', () => {
  it('message_queued carries sessionId, reason, and code', () => {
    const parsed = roundTrip(ServerMessages.messageQueued('sid-1', 'awaiting consent'));
    expect(parsed).toEqual({
      type: 'message_queued',
      sessionId: 'sid-1',
      reason: 'awaiting consent',
      code: 'AUTH_PREFLIGHT_REQUIRED',
    });
  });
});

// ---------------------------------------------------------------------------
// Streaming response messages (used by cross-pod delivery)
// ---------------------------------------------------------------------------
describe('Response streaming messages', () => {
  it('response_start carries sessionId and messageId', () => {
    const parsed = roundTrip(ServerMessages.responseStart('sid-1', 'msg-1'));
    expect(parsed).toEqual({
      type: 'response_start',
      sessionId: 'sid-1',
      messageId: 'msg-1',
    });
  });

  it('response_start can carry executionId', () => {
    const parsed = roundTrip(ServerMessages.responseStart('sid-1', 'msg-1', 'exec-1'));
    expect(parsed).toEqual({
      type: 'response_start',
      sessionId: 'sid-1',
      messageId: 'msg-1',
      executionId: 'exec-1',
    });
  });

  it('response_chunk carries chunk text', () => {
    const parsed = roundTrip(ServerMessages.responseChunk('sid-1', 'msg-1', 'hello'));
    expect(parsed).toEqual({
      type: 'response_chunk',
      sessionId: 'sid-1',
      messageId: 'msg-1',
      chunk: 'hello',
    });
  });

  it('response_end carries fullText', () => {
    const parsed = roundTrip(ServerMessages.responseEnd('sid-1', 'msg-1', 'full response'));
    expect(parsed).toEqual({
      type: 'response_end',
      sessionId: 'sid-1',
      messageId: 'msg-1',
      fullText: 'full response',
    });
  });

  it('response_end can carry executionId', () => {
    const parsed = roundTrip(
      ServerMessages.responseEnd(
        'sid-1',
        'msg-1',
        'full response',
        undefined,
        undefined,
        undefined,
        'exec-1',
      ),
    );
    expect(parsed).toEqual({
      type: 'response_end',
      sessionId: 'sid-1',
      messageId: 'msg-1',
      fullText: 'full response',
      executionId: 'exec-1',
    });
  });

  it('response_end can carry provenance metadata', () => {
    const parsed = roundTrip(
      ServerMessages.responseEnd(
        'sid-1',
        'msg-1',
        'full response',
        undefined,
        undefined,
        undefined,
        'exec-1',
        {
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'llm',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        },
      ),
    );
    expect(parsed).toEqual({
      type: 'response_end',
      sessionId: 'sid-1',
      messageId: 'msg-1',
      fullText: 'full response',
      executionId: 'exec-1',
      metadata: {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'llm',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Error messages (including code extension)
// ---------------------------------------------------------------------------
describe('Error messages', () => {
  it('error carries message', () => {
    const parsed = roundTrip(ServerMessages.error('something failed'));
    expect(parsed).toEqual({ type: 'error', message: 'something failed' });
  });

  it('error with optional code carries code in wire format', () => {
    const parsed = roundTrip(ServerMessages.error('Deployment is retired', 410));
    expect(parsed).toEqual({ type: 'error', message: 'Deployment is retired', code: 410 });
  });

  it('error without code does not include code key', () => {
    const parsed = roundTrip(ServerMessages.error('plain error'));
    expect(Object.keys(parsed)).not.toContain('code');
  });

  it('error with retryAfterMs carries retryAfterMs in wire format', () => {
    const parsed = roundTrip(ServerMessages.error('Rate limited', undefined, 5000));
    expect(parsed).toEqual({ type: 'error', message: 'Rate limited', retryAfterMs: 5000 });
  });

  it('error with code and retryAfterMs carries both', () => {
    const parsed = roundTrip(ServerMessages.error('Rate limited', 429, 3000));
    expect(parsed).toEqual({
      type: 'error',
      message: 'Rate limited',
      code: 429,
      retryAfterMs: 3000,
    });
  });

  it('error without retryAfterMs does not include retryAfterMs key', () => {
    const parsed = roundTrip(ServerMessages.error('plain error'));
    expect(Object.keys(parsed)).not.toContain('retryAfterMs');
  });
});

// ---------------------------------------------------------------------------
// serializeServerMessage contract
// ---------------------------------------------------------------------------
describe('serializeServerMessage', () => {
  it('produces valid JSON for every factory output', () => {
    const messages = [
      ServerMessages.sessionStart('s', 'p', { chat: true, voice: false }),
      ServerMessages.sessionEnded('s'),
      ServerMessages.action('s', { type: 'continue' }),
      ServerMessages.voiceToken('t', 'i'),
      ServerMessages.voiceError('err'),
      ServerMessages.voiceStarted('s', 'realtime'),
      ServerMessages.voiceStarted('s', 'realtime', {
        localBargeIn: true,
        remoteTypedInterrupt: true,
        dtmf: false,
        returnToParent: true,
        activeAgentSync: false,
      }),
      ServerMessages.voiceStopped('s'),
      ServerMessages.voiceBargeInAck(),
      ServerMessages.voiceRealtimeAudio('a', 'f'),
      ServerMessages.voiceRealtimeTranscript('t', false, 'assistant'),
      ServerMessages.messageQueued('s', 'reason'),
      ServerMessages.error('err'),
      ServerMessages.error('err', 500),
      ServerMessages.responseStart('s', 'm'),
      ServerMessages.responseChunk('s', 'm', 'c'),
      ServerMessages.responseEnd('s', 'm', 'full'),
      ServerMessages.typingStart('s'),
      ServerMessages.info('msg', true),
    ];

    for (const msg of messages) {
      const json = serializeServerMessage(msg);
      expect(() => JSON.parse(json)).not.toThrow();
      const parsed = JSON.parse(json);
      expect(parsed).toHaveProperty('type');
      expect(typeof parsed.type).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// parseClientMessage — SDK client message types
// ---------------------------------------------------------------------------
describe('parseClientMessage', () => {
  it('parses send_message with sessionId and text', () => {
    const msg = parseClientMessage(
      JSON.stringify({ type: 'send_message', sessionId: 's1', text: 'hello' }),
    );
    expect(msg).toEqual({ type: 'send_message', sessionId: 's1', text: 'hello' });
  });

  it('parses send_message with attachmentIds', () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: 'send_message',
        sessionId: 's1',
        text: 'hello',
        attachmentIds: ['a1', 'a2'],
      }),
    );
    expect(msg).toEqual({
      type: 'send_message',
      sessionId: 's1',
      text: 'hello',
      attachmentIds: ['a1', 'a2'],
    });
  });

  it('parses action_submit with structured form data and render correlation', () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: 'action_submit',
        sessionId: 's1',
        actionId: 'a1',
        value: 'v1',
        formData: { ticketId: 'T-123', approved: true },
        renderId: 'render-1',
      }),
    );
    expect(msg).toEqual({
      type: 'action_submit',
      sessionId: 's1',
      actionId: 'a1',
      value: 'v1',
      formData: { ticketId: 'T-123', approved: true },
      renderId: 'render-1',
    });
  });

  it('rejects action_submit when formData is not an object envelope', () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: 'action_submit',
        sessionId: 's1',
        actionId: 'a1',
        formData: ['not', 'an', 'object'],
      }),
    );
    expect(msg).toBeNull();
  });

  it('rejects action_submit when formData has unsafe keys', () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: 'action_submit',
        sessionId: 's1',
        actionId: 'a1',
        formData: { constructor: 'polluted' },
      }),
    );
    expect(msg).toBeNull();
  });

  it('rejects action_submit when formData exceeds nested depth limits', () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: 'action_submit',
        sessionId: 's1',
        actionId: 'a1',
        formData: { a: { b: { c: { d: { e: { f: 'too deep' } } } } } },
      }),
    );
    expect(msg).toBeNull();
  });

  it('rejects action_submit when formData is oversized', () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: 'action_submit',
        sessionId: 's1',
        actionId: 'a1',
        formData: { notes: 'x'.repeat(20_000) },
      }),
    );
    expect(msg).toBeNull();
  });

  it('parses consent_satisfy with sessionId and authProfileRef', () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: 'consent_satisfy',
        sessionId: 's1',
        authProfileRef: 'profile1',
      }),
    );
    expect(msg).toEqual({
      type: 'consent_satisfy',
      sessionId: 's1',
      authProfileRef: 'profile1',
    });
  });

  it('parses auth_response', () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: 'auth_response',
        toolCallId: 'tc1',
        status: 'completed',
      }),
    );
    expect(msg).toEqual({
      type: 'auth_response',
      toolCallId: 'tc1',
      status: 'completed',
    });
  });

  it('returns null for invalid JSON', () => {
    expect(parseClientMessage('not json')).toBeNull();
  });

  it('returns null for missing type', () => {
    expect(parseClientMessage(JSON.stringify({ sessionId: 's1' }))).toBeNull();
  });

  it('returns null for unknown type', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'unknown_type' }))).toBeNull();
  });

  it('returns null for send_message missing required fields', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'send_message', sessionId: 's1' })),
    ).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'send_message', text: 'hello' }))).toBeNull();
  });
});
