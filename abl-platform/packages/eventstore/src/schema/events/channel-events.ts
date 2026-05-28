/**
 * Channel event schemas.
 *
 * Events related to channel messages and webhook delivery.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

// ─── channel.message.received ──────────────────────────────────────────────

export const ChannelMessageReceivedDataSchema = z
  .object({
    channel_type: z.string().optional(),
    channelType: z.string().optional(),
    connection_id: z.string().optional(),
    connectionId: z.string().optional(),
    deduped: z.boolean().optional(),
    processing_duration_ms: z.number().optional(),
    processingDurationMs: z.number().optional(),
    status: z.enum(['processed', 'failed', 'duplicate']).optional(),
  })
  .passthrough();

eventRegistry.register('channel.message.received', ChannelMessageReceivedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.CHANNEL,
  containsPII: true,
  description: 'Inbound channel message received',
});

// ─── channel.message.sent ──────────────────────────────────────────────────

export const ChannelMessageSentDataSchema = z
  .object({
    channel_type: z.string().optional(),
    channelType: z.string().optional(),
    role: z.enum(['user', 'agent', 'system']).optional(),
    has_pii: z.boolean().optional(),
    hasPii: z.boolean().optional(),
  })
  .passthrough();

eventRegistry.register('channel.message.sent', ChannelMessageSentDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.CHANNEL,
  containsPII: true,
  description: 'Outbound message sent to channel',
});

// ─── channel.response.sent ─────────────────────────────────────────────────

export const ChannelResponseSentDataSchema = z
  .object({
    channel_type: z.string().optional(),
    channelType: z.string().optional(),
    delivery_id: z.string().optional(),
    deliveryId: z.string().optional(),
    provider: z.string().optional(),
    status: z.enum(['sent', 'failed']).optional(),
    latency_ms: z.number().optional(),
    latencyMs: z.number().optional(),
  })
  .passthrough();

eventRegistry.register('channel.response.sent', ChannelResponseSentDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.CHANNEL,
  containsPII: true,
  description: 'Agent response delivery result for a channel turn',
});

// ─── channel.webhook.delivered ─────────────────────────────────────────────

export const ChannelWebhookDeliveredDataSchema = z
  .object({
    subscription_id: z.string().optional(),
    subscriptionId: z.string().optional(),
    event_type: z.string().optional(),
    eventType: z.string().optional(),
    http_status: z.number().optional(),
    httpStatus: z.number().optional(),
    latency_ms: z.number().optional(),
    latencyMs: z.number().optional(),
    status: z.enum(['delivered', 'failed']).optional(),
    retry_attempt: z.number().optional(),
    retryAttempt: z.number().optional(),
  })
  .passthrough();

eventRegistry.register('channel.webhook.delivered', ChannelWebhookDeliveredDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.CHANNEL,
  containsPII: false,
  description: 'Webhook delivery attempt result',
});
