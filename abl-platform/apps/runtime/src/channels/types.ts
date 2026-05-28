/**
 * Channel Types & Interfaces
 *
 * Shared types for the channel integration layer.
 * All channel adapters (HTTP Async, Slack, WhatsApp, VXML) implement ChannelAdapter.
 */

import type { ActionSetIR, RichContentIR } from '@abl/compiler';
import type { InteractionContextInput } from '@agent-platform/shared-kernel';
import type { ActionEvent } from '../services/channels/action-event.js';
import type { ResponseMessageMetadata } from '../services/channel/response-provenance.js';

// =============================================================================
// CHANNEL TYPES
// =============================================================================

export type ChannelType =
  // Async/webhook channels
  | 'http_async'
  | 'slack'
  | 'line'
  | 'whatsapp'
  | 'messenger'
  | 'instagram'
  | 'twilio_sms'
  | 'zendesk'
  | 'voice_vxml'
  | 'email'
  | 'msteams'
  | 'korevg'
  | 'audiocodes'
  | 'voice_pipeline'
  | 'telegram'
  | 'genesys'
  | 'ai4w'
  // Realtime channels
  | 'web_debug'
  | 'web_chat'
  | 'sdk_websocket'
  | 'api'
  | 'ag_ui'
  | 'voice'
  | 'voice_twilio'
  | 'voice_livekit'
  | 'voice_realtime'
  | 'http'
  // Protocol channels
  | 'a2a';

export type WebhookEventType =
  | 'agent.response'
  | 'agent.status'
  | 'agent.attachment'
  | 'session.completed'
  | 'session.escalated'
  | 'delivery.failed';

// =============================================================================
// NORMALIZED MESSAGES
// =============================================================================

export interface NormalizedIncomingMessage {
  /** Unique message ID from external system (or generated) */
  externalMessageId: string;
  /** External session/conversation key */
  externalSessionKey: string;
  /** Message text content */
  text: string;
  /** Channel-specific metadata */
  metadata?: Record<string, unknown>;
  /** Canonical per-turn interaction context extracted at ingress. */
  interactionContext?: InteractionContextInput;
  /** Timestamp of the original message */
  timestamp: Date;
  /** Normalized action event from interactive callbacks (buttons, selects, etc.) */
  actionEvent?: ActionEvent;
}

export interface NormalizedOutgoingMessage {
  /** Runtime session ID */
  sessionId: string;
  /** Response text */
  text: string;
  /** Event type for webhook delivery */
  eventType: WebhookEventType;
  /** Canonical provenance metadata for the customer-visible response payload */
  responseMetadata?: ResponseMessageMetadata;
  /** Additional data attached to the response */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// SEND RESULT
// =============================================================================

export interface SendResult {
  success: boolean;
  deliveryId?: string;
  error?: string;
  /** Adapter-specific metadata (e.g. signed headers for async callback delivery) */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// CHANNEL CREDENTIALS & CONFIG
// =============================================================================

export interface ChannelCredentials {
  [key: string]: unknown;
}

export interface ChannelCapabilities {
  supportsAsync: boolean;
  supportsStreaming: boolean;
  supportsMedia: boolean;
  supportsThreading: boolean;
}

// =============================================================================
// RESOLVED CONNECTION
// =============================================================================

export interface ResolvedConnection {
  id: string;
  tenantId: string;
  projectId: string;
  agentId: string | null;
  deploymentId?: string | null;
  environment?: string | null;
  channelType: ChannelType;
  externalIdentifier: string;
  credentials: ChannelCredentials | null;
  config: Record<string, unknown>;
  status: string;
}

// =============================================================================
// ASYNC JOB PAYLOADS
// =============================================================================

export interface InboundJobPayload {
  connectionId: string;
  tenantId: string;
  projectId: string;
  agentId: string | null;
  deploymentId?: string | null;
  environment?: string | null;
  channelType: ChannelType;
  message: NormalizedIncomingMessage;
  subscriptionId: string;
  idempotencyKey: string;
  traceId?: string;
}

export interface DeliveryJobPayload {
  deliveryId: string;
  subscriptionId: string;
  tenantId: string;
  eventType: WebhookEventType;
  payload: string;
  traceId?: string;
}

// =============================================================================
// CHANNEL OUTPUT (platform-native message formats)
// =============================================================================

/** WhatsApp Cloud API template message payload */
export interface WhatsAppTemplatePayload {
  name: string;
  language: { code: string };
  components?: Array<{
    type: 'header' | 'body' | 'button';
    parameters?: Array<{
      type: 'text' | 'image' | 'video' | 'document' | 'payload' | 'coupon_code';
      text?: string;
      image?: { link?: string; id?: string };
      video?: { link?: string; id?: string };
      document?: { link?: string; id?: string; filename?: string };
      payload?: string;
      coupon_code?: string;
    }>;
    sub_type?: 'quick_reply' | 'url';
    index?: number;
  }>;
}

/** Discriminated union for platform-native outbound message formats */
export type ChannelOutput =
  | { kind: 'text'; text: string }
  | { kind: 'slack_blocks'; blocks: unknown[]; text: string }
  | { kind: 'line_quick_reply'; text: string; quickReply: { items: unknown[] } }
  | { kind: 'adaptive_card'; card: unknown; text: string }
  | { kind: 'whatsapp_interactive'; interactive: unknown; text: string }
  | { kind: 'whatsapp_template'; template: WhatsAppTemplatePayload; text: string }
  | { kind: 'messenger_template'; message: unknown; text: string }
  | { kind: 'instagram_template'; message: unknown; text: string }
  | { kind: 'structured_payload'; text: string; actions?: ActionSetIR; richContent?: RichContentIR }
  | {
      kind: 'zendesk_actions';
      content: { type: string; text: string; actions: unknown[] };
      text: string;
    }
  | { kind: 'telegram_keyboard'; text: string; replyMarkup: unknown }
  | { kind: 'ag_ui_events'; events: Array<{ type: string; data: unknown }> };

// =============================================================================
// CHANNEL ADAPTER INTERFACE
// =============================================================================

export interface ChannelAdapter {
  readonly channelType: ChannelType;
  readonly capabilities: ChannelCapabilities;

  /**
   * Verify an inbound request (signature validation, etc.).
   * HTTP Async uses API key auth via middleware, so this returns true.
   * Channels like Slack need `connection` to access per-connection signing secrets.
   */
  verifyRequest(
    headers: Record<string, string>,
    body: unknown,
    rawBody?: Buffer | string,
    connection?: ResolvedConnection | null,
    webhookUrl?: string,
  ): Promise<boolean>;

  /**
   * Parse an inbound job payload into a normalized message.
   */
  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage;

  /**
   * Send a response back through the channel.
   * For async channels, this enqueues to the delivery queue rather than sending directly.
   */
  sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult>;

  /**
   * Transform plain text + optional ActionSetIR into platform-native output.
   * Adapters that support rich interactive messages override this to produce
   * Block Kit (Slack), Adaptive Cards (Teams), interactive messages (WhatsApp),
   * templates (Messenger), or AG-UI events.
   * Returns plain text fallback when not implemented.
   */
  transformOutput?(text: string, actions?: ActionSetIR, richContent?: RichContentIR): ChannelOutput;

  /**
   * Send a "typing" indicator to the channel.
   * Optional — only implement for channels that support it.
   * Called before LLM execution begins. Failures must not block message processing.
   */
  sendTypingIndicator?(
    connection: ResolvedConnection,
    externalSessionKey: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}

// Re-export ActionEvent for convenience
export type { ActionEvent } from '../services/channels/action-event.js';
