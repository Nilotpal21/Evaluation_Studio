/**
 * AG-UI (Agent-UI Protocol) Channel Adapter
 *
 * Produces AG-UI SSE event sequences for frontend agent UIs.
 * This adapter transforms ActionSetIR into a sequence of AG-UI events
 * (TEXT_MESSAGE_START/CONTENT/END + TOOL_CALL_START/ARGS/END).
 *
 * AG-UI is consumed by SSE clients (React, Next.js agent frontends)
 * that render interactive components based on structured events.
 *
 * This adapter does not send messages over a network — it produces
 * structured event payloads that the SSE transport layer delivers.
 */

import crypto from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import type { ActionSetIR, RichContentIR } from '@abl/compiler';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelOutput,
  ChannelType,
  InboundJobPayload,
  NormalizedIncomingMessage,
  NormalizedOutgoingMessage,
  ResolvedConnection,
  SendResult,
} from '../types.js';

const log = createLogger('ag-ui-adapter');

// =============================================================================
// AG-UI EVENT TYPES
// =============================================================================

interface AgUiEvent {
  type: string;
  data: unknown;
}

function parseAgUiPayload(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
}

// =============================================================================
// ADAPTER
// =============================================================================

export class AgUiAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'ag_ui';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: false,
    supportsStreaming: true,
    supportsMedia: true,
    supportsThreading: true,
  };

  /** AG-UI does not receive HTTP webhooks. */
  async verifyRequest(): Promise<boolean> {
    return true;
  }

  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  /**
   * AG-UI does not send via network — events are delivered through SSE transport.
   * This throws to prevent misuse.
   */
  async sendResponse(
    _message: NormalizedOutgoingMessage,
    _connection: ResolvedConnection,
  ): Promise<SendResult> {
    throw new Error('AgUiAdapter does not support direct sendResponse. Use SSE event stream.');
  }

  /**
   * Transform text + ActionSetIR into AG-UI event sequence.
   *
   * Produces:
   * - TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT → TEXT_MESSAGE_END (for text)
   * - TOOL_CALL_START → TOOL_CALL_ARGS → TOOL_CALL_END (for each action element)
   */
  transformOutput(text: string, actions?: ActionSetIR, richContent?: RichContentIR): ChannelOutput {
    const events: AgUiEvent[] = [];

    if (richContent?.ag_ui) {
      events.push({
        type: 'RICH_CONTENT',
        data: {
          channel: 'ag_ui',
          payload: parseAgUiPayload(richContent.ag_ui),
        },
      });
    } else if (richContent && Object.keys(richContent).length > 0) {
      events.push({
        type: 'RICH_CONTENT',
        data: {
          channel: 'generic',
          payload: richContent,
        },
      });
    }

    // Text message events
    if (text) {
      events.push({
        type: 'TEXT_MESSAGE_START',
        data: { messageId: crypto.randomUUID() },
      });
      events.push({
        type: 'TEXT_MESSAGE_CONTENT',
        data: { content: text },
      });
      events.push({
        type: 'TEXT_MESSAGE_END',
        data: {},
      });
    }

    // Action elements as tool calls
    if (actions && actions.elements.length > 0) {
      for (const el of actions.elements) {
        const toolCallId = `action_${el.id}`;

        events.push({
          type: 'TOOL_CALL_START',
          data: {
            toolCallId,
            toolName: `ui_${el.type}`,
          },
        });

        events.push({
          type: 'TOOL_CALL_ARGS',
          data: {
            toolCallId,
            args: JSON.stringify({
              id: el.id,
              type: el.type,
              label: el.label,
              value: el.value,
              options: el.options,
              placeholder: el.placeholder,
              required: el.required,
            }),
          },
        });

        events.push({
          type: 'TOOL_CALL_END',
          data: { toolCallId },
        });
      }
    }

    if (events.length === 0) {
      return { kind: 'text', text: text || '' };
    }

    return { kind: 'ag_ui_events', events };
  }
}
