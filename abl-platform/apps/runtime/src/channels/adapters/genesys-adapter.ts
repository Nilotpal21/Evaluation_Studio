/**
 * Genesys Bot Connector Channel Adapter
 *
 * Adapter for Genesys CX Bot Connector integration. Like VXML, this is a
 * synchronous webhook channel — Genesys sends customer messages via HTTP POST
 * and expects the bot's response in the same request.
 *
 * The synchronous route (channel-genesys.ts) calls the Genesys-specific methods
 * directly; the standard sendResponse() satisfies the interface but is unused.
 */

import type { ActionSetIR } from '@abl/compiler';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelType,
  InboundJobPayload,
  NormalizedIncomingMessage,
  NormalizedOutgoingMessage,
  ResolvedConnection,
  SendResult,
} from '../types.js';
import { requireNormalizedActionEvent } from '../../services/channels/action-event-validation.js';
import { coerceSessionMetadata } from '../../services/session-metadata.js';

// ---------------------------------------------------------------------------
// Genesys Bot Connector request/response types
// ---------------------------------------------------------------------------

export interface GenesysInputMessage {
  type: 'Text' | 'Structured' | string;
  text?: string;
  buttonResponse?: {
    payload?: string;
  };
}

export interface GenesysWebhookRequest {
  genesysConversationId: string;
  inputMessage: GenesysInputMessage;
  channelSource?: string;
  sessionMetadata?: Record<string, unknown> | string;
}

export interface GenesysReplyMessage {
  type: 'Text' | 'Structured';
  text: string;
  content?: Array<{
    contentType: 'QuickReply';
    quickReply: { text: string; payload: string };
  }>;
}

export interface GenesysResponse {
  replymessages: GenesysReplyMessage[];
  botState: 'MOREDATA' | 'COMPLETE';
  intent: string;
  endOfTask: boolean;
}

// ---------------------------------------------------------------------------
// Constants (matching koreserver config)
// ---------------------------------------------------------------------------

const TALK_TO_BOT_INTENT = 'Default Kore VA Intent';

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GenesysAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'genesys';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: false,
    supportsStreaming: false,
    supportsMedia: false,
    supportsThreading: false,
  };

  // -------------------------------------------------------------------------
  // ChannelAdapter interface — mostly unused for the sync path
  // -------------------------------------------------------------------------

  async verifyRequest(): Promise<boolean> {
    // Auth is handled in the route via bearer token comparison.
    return true;
  }

  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  async sendResponse(
    _message: NormalizedOutgoingMessage,
    _connection: ResolvedConnection,
  ): Promise<SendResult> {
    // Genesys responses are returned synchronously from the route handler —
    // this method is never called but satisfies the adapter interface.
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Genesys-specific helpers (called directly by the sync route)
  // -------------------------------------------------------------------------

  /**
   * Build a NormalizedIncomingMessage from the raw Genesys webhook body.
   */
  buildNormalizedMessage(body: GenesysWebhookRequest): NormalizedIncomingMessage {
    const conversationId = body.genesysConversationId;
    const inputMessage = body.inputMessage;
    const sessionMetadata = coerceSessionMetadata(body.sessionMetadata);

    let text = '';
    let actionEvent: NormalizedIncomingMessage['actionEvent'];

    if (inputMessage.type === 'Structured' && inputMessage.buttonResponse?.payload) {
      text = inputMessage.buttonResponse.payload;
      // actionId is set to the echoed payload, not the original button id.
      // Genesys QuickReply only carries a single `payload` field — there is no
      // way to round-trip both id and value. Koreserver behaves identically
      // (channels/genesys.js:74-75 reads buttonResponse.payload as-is).
      actionEvent = requireNormalizedActionEvent({
        actionId: inputMessage.buttonResponse.payload,
        value: inputMessage.buttonResponse.payload,
        source: 'genesys',
      });
    } else {
      text = inputMessage.text || '';
    }

    return {
      externalMessageId: `${conversationId}-${Date.now()}`,
      externalSessionKey: `genesys:${conversationId}`,
      text,
      metadata: {
        genesysConversationId: conversationId,
        channelSource: body.channelSource,
        originalMessage: body.inputMessage,
        ...(sessionMetadata ? { sessionMetadata } : {}),
      },
      timestamp: new Date(),
      actionEvent,
    };
  }

  /**
   * Build a Genesys Bot Connector response from the runtime's text output.
   */
  buildGenesysResponse(responseText: string, actions?: ActionSetIR): GenesysResponse {
    const replymessages: GenesysReplyMessage[] = [];

    // Transform ActionSetIR button elements into Genesys Structured messages
    const buttons = actions?.elements?.filter((el) => el.type === 'button') ?? [];
    if (buttons.length > 0) {
      replymessages.push({
        type: 'Structured',
        text: responseText,
        content: buttons.map((btn) => ({
          contentType: 'QuickReply' as const,
          // Genesys QuickReply carries a single payload string — no separate
          // id/value fields. We prefer value; fall back to id. On round-trip,
          // actionId will match this payload (see buildNormalizedMessage).
          quickReply: {
            text: btn.label,
            payload: btn.value ?? btn.id,
          },
        })),
      });
    } else {
      replymessages.push({ type: 'Text', text: responseText });
    }

    return {
      replymessages,
      botState: 'MOREDATA',
      intent: TALK_TO_BOT_INTENT,
      endOfTask: false,
    };
  }
}
