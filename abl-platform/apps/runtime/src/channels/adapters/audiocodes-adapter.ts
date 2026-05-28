/**
 * AudioCodes VoiceAI Connect Channel Adapter
 *
 * Implements the AudioCodes Bot API (HTTP mode) for voice calls.
 * AudioCodes sends call events via HTTP POST webhooks. Bot responses
 * are delivered asynchronously over a per-conversation WebSocket.
 *
 * Webhook routes: apps/runtime/src/routes/channel-audiocodes.ts
 * WebSocket manager: apps/runtime/src/channels/audiocodes/ws-manager.ts
 */

import { createLogger } from '@abl/compiler/platform';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelType,
  ChannelOutput,
  InboundJobPayload,
  NormalizedIncomingMessage,
  NormalizedOutgoingMessage,
  ResolvedConnection,
  SendResult,
} from '../types.js';
import { coerceSessionMetadata, mergeSessionMetadata } from '../../services/session-metadata.js';

const log = createLogger('audiocodes-adapter');

// ---------------------------------------------------------------------------
// AudioCodes payload types
// ---------------------------------------------------------------------------

export interface AudioCodesActivity {
  id?: string;
  timestamp?: string;
  type: 'message' | 'event';
  name?: string;
  text?: string;
  value?: unknown;
  parameters?: Record<string, unknown>;
  activityParams?: Record<string, unknown>;
  sessionParams?: Record<string, unknown>;
}

export interface AudioCodesActivitiesPayload {
  conversation: string;
  activities: AudioCodesActivity[];
}

export interface AudioCodesConversationRequest {
  conversation: string;
  bot?: string;
  capabilities?: string[];
}

export interface AudioCodesDisconnectPayload {
  conversation: string;
  reason?: string;
  reasonCode?: string;
  sipHeaders?: Array<{ name: string; value: string }>;
}

export interface AudioCodesChannelConfig {
  inboundAuthToken?: string;
  language?: string;
  voiceName?: string;
  bargeIn?: boolean;
  userNoInputTimeoutMs?: number;
  userNoInputRetries?: number;
  expiresSeconds?: number;
  welcomeMessage?: string;
}

// ---------------------------------------------------------------------------
// Outbound activity builders
// ---------------------------------------------------------------------------

export function buildMessageActivity(
  text: string,
  sessionParams?: Record<string, unknown>,
): AudioCodesActivity {
  const activity: AudioCodesActivity = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'message',
    text,
  };
  if (sessionParams) {
    activity.sessionParams = sessionParams;
  }
  return activity;
}

export function buildHangupActivity(reason?: string): AudioCodesActivity {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'event',
    name: 'hangup',
    ...(reason ? { activityParams: { hangupReason: reason } } : {}),
  };
}

export function buildConfigActivity(sessionParams: Record<string, unknown>): AudioCodesActivity {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'event',
    name: 'config',
    sessionParams,
  };
}

export function buildTransferActivity(
  transferTarget: string,
  reason?: string,
  sipHeaders?: Array<{ name: string; value: string }>,
): AudioCodesActivity {
  const activityParams: Record<string, unknown> = { transferTarget };
  if (reason) activityParams.handoverReason = reason;
  if (sipHeaders) activityParams.transferSipHeaders = sipHeaders;
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'event',
    name: 'transfer',
    activityParams,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AudioCodesAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'audiocodes';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: false,
    supportsStreaming: false,
    supportsMedia: false,
    supportsThreading: false,
  };

  async verifyRequest(
    _headers: Record<string, string>,
    _body: unknown,
    _rawBody?: Buffer | string,
    _connection?: ResolvedConnection | null,
  ): Promise<boolean> {
    // Token verification is handled directly in the route handler (like VXML)
    return true;
  }

  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  async sendResponse(
    _message: NormalizedOutgoingMessage,
    _connection: ResolvedConnection,
  ): Promise<SendResult> {
    // Responses are delivered via WebSocket (ws-manager), not through this method
    return { success: true };
  }

  transformOutput(text: string): ChannelOutput {
    return { kind: 'text', text };
  }

  // -------------------------------------------------------------------------
  // AudioCodes-specific helpers (called by the route handler)
  // -------------------------------------------------------------------------

  buildNormalizedMessage(
    conversationId: string,
    activities: AudioCodesActivity[],
  ): NormalizedIncomingMessage {
    let text = '';
    let eventName: string | undefined;
    const metadata: Record<string, unknown> = { conversationId };
    let sessionMetadata: Record<string, unknown> | undefined;

    for (const activity of activities) {
      const activitySessionMetadata = mergeSessionMetadata(
        coerceSessionMetadata(activity.sessionParams?.sessionMetadata),
        mergeSessionMetadata(
          coerceSessionMetadata(activity.parameters?.sessionMetadata),
          coerceSessionMetadata(activity.activityParams?.sessionMetadata),
        ),
      );
      sessionMetadata = mergeSessionMetadata(sessionMetadata, activitySessionMetadata);

      if (activity.type === 'message' && activity.text) {
        text = activity.text;
      } else if (activity.type === 'event') {
        eventName = activity.name;

        if (activity.name === 'start') {
          const params = activity.parameters || {};
          metadata.caller = params.caller;
          metadata.callee = params.callee;
          metadata.callerHost = params.callerHost;
          metadata.calleeHost = params.calleeHost;
          metadata.sipHeaders = params.sipHeaders;
          metadata.isNewCall = true;
        } else if (activity.name === 'DTMF') {
          const dtmfValue = activity.value as string;
          text = dtmfValue || '';
          metadata.isDtmf = true;
        } else if (activity.name === 'noInput') {
          metadata.isNoInput = true;
        }
      }
    }

    if (eventName) {
      metadata.eventName = eventName;
    }

    if (sessionMetadata) {
      metadata.sessionMetadata = sessionMetadata;
    }

    return {
      externalMessageId: `ac-${conversationId}-${Date.now()}`,
      externalSessionKey: `audiocodes:${conversationId}`,
      text,
      metadata,
      timestamp: new Date(),
    };
  }
}
