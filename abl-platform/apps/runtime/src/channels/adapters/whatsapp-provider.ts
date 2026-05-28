/**
 * WhatsApp Provider Interface & Factory
 *
 * Defines the contract that all WhatsApp BSP providers must implement.
 * Uses a strategy pattern so WhatsAppAdapter can delegate to provider-specific
 * implementations (Meta Cloud API, Infobip, etc.) without coupling to any one BSP.
 */

import type { ActionSetIR, RichContentIR } from '@abl/compiler';
import type {
  ChannelOutput,
  NormalizedIncomingMessage,
  NormalizedOutgoingMessage,
  ResolvedConnection,
  SendResult,
} from '../types.js';

export interface WhatsAppProvider {
  readonly providerId: string;

  verifyRequest(
    headers: Record<string, string>,
    body: unknown,
    rawBody?: Buffer | string,
    connection?: ResolvedConnection | null,
  ): Promise<boolean>;

  handleWebhookVerification?(
    query: Record<string, string>,
    connection?: { credentials?: Record<string, unknown> } | null,
  ): string | null;

  extractExternalIdentifier(body: unknown): string | null;
  extractEventId(body: unknown): string | null;
  shouldProcess(body: unknown): boolean;
  buildNormalizedMessage(body: unknown): NormalizedIncomingMessage;

  sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult>;

  transformOutput(text: string, actions?: ActionSetIR, richContent?: RichContentIR): ChannelOutput;
}

const providers = new Map<string, WhatsAppProvider>();

const MAX_PROVIDERS = 10;

export function registerWhatsAppProvider(provider: WhatsAppProvider): void {
  if (providers.size >= MAX_PROVIDERS) {
    throw new Error(`WhatsApp provider registry full (max ${MAX_PROVIDERS})`);
  }
  providers.set(provider.providerId, provider);
}

export function resolveWhatsAppProvider(providerId?: string): WhatsAppProvider {
  const id = providerId || 'meta_cloud';
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(`Unknown WhatsApp provider: ${id}`);
  }
  return provider;
}

export function getRegisteredProviderIds(): string[] {
  return Array.from(providers.keys());
}
