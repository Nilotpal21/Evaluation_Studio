/**
 * HTTP Async Channel Adapter
 *
 * Minimal adapter for the HTTP Async channel.
 * - verifyRequest() → always true (auth via API key middleware)
 * - parseIncoming() → converts job payload to NormalizedIncomingMessage
 * - sendResponse() → throws (delivery is handled by the delivery worker/queue)
 */

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

export class HttpAsyncAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'http_async';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: true,
    supportsStreaming: false,
    supportsMedia: false,
    supportsThreading: true,
  };

  /**
   * HTTP Async uses API key auth via Express middleware.
   * No additional request verification needed.
   */
  async verifyRequest(_headers: Record<string, string>, _body: unknown): Promise<boolean> {
    return true;
  }

  /**
   * Parse an inbound job payload into a normalized message.
   */
  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  /**
   * HTTP Async does not send responses directly.
   * Responses are delivered via the webhook delivery queue/worker.
   */
  async sendResponse(
    _message: NormalizedOutgoingMessage,
    _connection: ResolvedConnection,
  ): Promise<SendResult> {
    throw new Error(
      'HttpAsyncAdapter does not support direct sendResponse. Use the webhook delivery queue.',
    );
  }

  /** Pass structured payloads through — no platform-specific transform needed. */
  transformOutput(text: string, actions?: ActionSetIR, richContent?: RichContentIR): ChannelOutput {
    const hasActions = Array.isArray(actions?.elements) && actions.elements.length > 0;
    const hasRichContent = richContent !== undefined && Object.keys(richContent).length > 0;

    if (!hasActions && !hasRichContent) {
      return { kind: 'text', text };
    }

    return {
      kind: 'structured_payload',
      text,
      ...(hasActions ? { actions } : {}),
      ...(hasRichContent ? { richContent } : {}),
    };
  }
}
