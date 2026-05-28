import { describe, expect, it } from 'vitest';

import {
  buildCustomerContinuityStatusPayload,
  normalizeCustomerContinuityText,
  resolveCustomerContinuityDelivery,
} from '../../channels/customer-continuity.js';
import { CHANNEL_MANIFEST } from '../../channels/manifest.js';
import type { ChannelType } from '../../channels/types.js';

describe('customer continuity contract', () => {
  it('maps channel delivery to customer-continuity consumption modes', () => {
    expect(resolveCustomerContinuityDelivery('http_async')).toEqual({
      mode: 'status_event',
      eventType: 'agent.status',
    });
    expect(resolveCustomerContinuityDelivery('slack')).toEqual({ mode: 'stream_text' });
    expect(resolveCustomerContinuityDelivery('line')).toEqual({ mode: 'typing_indicator' });
    expect(resolveCustomerContinuityDelivery('api')).toEqual({ mode: 'final_response_only' });
  });

  it('keeps continuity delivery aligned with every channel manifest row', () => {
    for (const [channelType, manifest] of Object.entries(CHANNEL_MANIFEST)) {
      const delivery = resolveCustomerContinuityDelivery(channelType as ChannelType);

      if (channelType === 'http_async') {
        expect(delivery).toEqual({ mode: 'status_event', eventType: 'agent.status' });
        continue;
      }

      if (manifest.supportsStreaming) {
        expect(delivery).toEqual({ mode: 'stream_text' });
        continue;
      }

      if (manifest.supportsTypingIndicator) {
        expect(delivery).toEqual({ mode: 'typing_indicator' });
        continue;
      }

      expect(delivery).toEqual({ mode: 'final_response_only' });
    }
  });

  it('keeps natural bridge language and replaces implementation language', () => {
    expect(normalizeCustomerContinuityText('Pulling that up now...')).toBe(
      "I'm pulling that up now.",
    );
    expect(normalizeCustomerContinuityText('Pulling that up now')).toBe("I'm pulling that up now.");
    expect(normalizeCustomerContinuityText('I will call the get_order tool now.')).toBe(
      'Let me check that for you.',
    );
    expect(normalizeCustomerContinuityText('ok')).toBe('Let me check that for you.');
  });

  it('builds customer-visible status payloads with continuity metadata', () => {
    const payload = buildCustomerContinuityStatusPayload({
      channelType: 'http_async',
      kind: 'pre_action_bridge',
      rawText: 'Let me check the latest details.',
      messageId: 'msg-1',
      sessionKey: 'thread-1',
      sessionId: 'session-1',
      isNewSession: false,
      source: 'runtime_topology',
    });

    expect(payload).toMatchObject({
      message_id: 'msg-1',
      session_key: 'thread-1',
      event: 'agent.status',
      status: 'in_progress',
      message: 'Let me check the latest details.',
      response: 'Let me check the latest details.',
      trace_context: {
        session_id: 'session-1',
        delivery: 'status_event',
      },
      session_id: 'session-1',
      is_new_session: false,
      metadata: {
        status_kind: 'continuity',
        continuity_kind: 'pre_action_bridge',
        visibility: 'customer_visible',
        source: 'runtime_topology',
      },
    });
  });

  it('preserves non-bridge continuity kinds for channel consumers', () => {
    const payload = buildCustomerContinuityStatusPayload({
      channelType: 'http_async',
      kind: 'long_running_status',
      rawText: 'Still checking the carrier response.',
      messageId: 'msg-2',
      sessionKey: 'thread-1',
      sessionId: 'session-1',
      isNewSession: false,
    });

    expect(payload).toMatchObject({
      event: 'agent.status',
      message: "I'm still checking the carrier response.",
      metadata: {
        status_kind: 'continuity',
        continuity_kind: 'long_running_status',
        visibility: 'customer_visible',
        source: 'agent_authored',
      },
    });
  });

  it('does not build status payloads for channels that consume continuity another way', () => {
    expect(
      buildCustomerContinuityStatusPayload({
        channelType: 'slack',
        kind: 'pre_action_bridge',
        rawText: 'Checking now.',
        messageId: 'msg-1',
        sessionKey: 'thread-1',
        sessionId: 'session-1',
        isNewSession: false,
      }),
    ).toBeNull();
  });

  it('does not synthesize text status payloads for typing-only or final-response channels', () => {
    for (const channelType of ['line', 'telegram', 'api', 'voice_vxml'] as const) {
      expect(
        buildCustomerContinuityStatusPayload({
          channelType,
          kind: 'long_running_status',
          rawText: 'Still checking that.',
          messageId: 'msg-1',
          sessionKey: 'thread-1',
          sessionId: 'session-1',
          isNewSession: false,
        }),
      ).toBeNull();
    }
  });
});
