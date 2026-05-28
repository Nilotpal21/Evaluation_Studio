/**
 * WhatsApp Channel Adapter — Thin Provider Dispatcher
 *
 * Delegates all WhatsApp-specific logic to registered WhatsAppProvider
 * implementations (Meta Cloud API, Infobip, etc.). The adapter itself
 * contains no BSP-specific code — it simply resolves the correct provider
 * from the connection config and forwards each call.
 *
 * Provider resolution:
 * - Methods with a `connection` arg → reads `connection.config?.provider`
 * - Methods without connection context → defaults to `meta_cloud`
 * - `extractExternalIdentifier` / `handleWebhookVerification` → tries each
 *   registered provider (needed before connection is resolved)
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
import {
  resolveWhatsAppProvider,
  getRegisteredProviderIds,
  registerWhatsAppProvider,
} from './whatsapp-provider.js';
import { MetaCloudProvider } from './whatsapp-providers/meta-cloud-provider.js';

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'whatsapp';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: true,
    supportsStreaming: false,
    supportsMedia: true,
    supportsThreading: false,
  };

  constructor() {
    // Ensure the default provider is always available, even when the adapter
    // is instantiated outside the channel registry (e.g. in tests).
    try {
      resolveWhatsAppProvider('meta_cloud');
    } catch {
      registerWhatsAppProvider(new MetaCloudProvider());
    }
  }

  private getProvider(connection?: ResolvedConnection | null) {
    const providerId = (connection?.config?.provider as string) || 'meta_cloud';
    return resolveWhatsAppProvider(providerId);
  }

  async verifyRequest(
    headers: Record<string, string>,
    body: unknown,
    rawBody?: Buffer | string,
    connection?: ResolvedConnection | null,
  ): Promise<boolean> {
    return this.getProvider(connection).verifyRequest(headers, body, rawBody, connection);
  }

  handleWebhookVerification(
    query: Record<string, string>,
    connection?: { credentials?: Record<string, unknown> } | null,
  ): string | null {
    // Try each provider — Meta needs verification, others may not
    for (const id of getRegisteredProviderIds()) {
      const provider = resolveWhatsAppProvider(id);
      if (provider.handleWebhookVerification) {
        const result = provider.handleWebhookVerification(query, connection);
        if (result) return result;
      }
    }
    return null;
  }

  extractExternalIdentifier(body: unknown): string | null {
    // Try each registered provider — needed before connection is resolved
    for (const id of getRegisteredProviderIds()) {
      const result = resolveWhatsAppProvider(id).extractExternalIdentifier(body);
      if (result) return result;
    }
    return null;
  }

  extractEventId(body: unknown): string | null {
    // Default to meta_cloud when no connection context
    return resolveWhatsAppProvider('meta_cloud').extractEventId(body);
  }

  shouldProcess(body: unknown): boolean {
    // Default to meta_cloud when no connection context
    return resolveWhatsAppProvider('meta_cloud').shouldProcess(body);
  }

  buildNormalizedMessage(body: unknown): NormalizedIncomingMessage {
    // Default to meta_cloud when no connection context
    return resolveWhatsAppProvider('meta_cloud').buildNormalizedMessage(body);
  }

  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  async sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult> {
    return this.getProvider(connection).sendResponse(message, connection);
  }

  transformOutput(text: string, actions?: ActionSetIR, richContent?: RichContentIR): ChannelOutput {
    // Default to meta_cloud — transform doesn't have connection context
    return resolveWhatsAppProvider('meta_cloud').transformOutput(text, actions, richContent);
  }
}
