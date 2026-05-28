/**
 * Message event schemas.
 *
 * Events related to user messages and agent responses on the core execution path.
 * Distinct from channel-events.ts which covers external channel integrations.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

// ─── message.user.received ────────────────────────────────────────────────

export const MessageUserReceivedDataSchema = z
  .object({
    content_length: z.number().optional(),
    contentLength: z.number().optional(),
    channel: z.string().optional(),
    has_attachments: z.boolean().optional(),
    hasAttachments: z.boolean().optional(),
    attachment_count: z.number().optional(),
    attachmentCount: z.number().optional(),
  })
  .passthrough();

export type MessageUserReceivedData = z.infer<typeof MessageUserReceivedDataSchema>;

eventRegistry.register('message.user.received', MessageUserReceivedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.MESSAGE,
  containsPII: true,
  description: 'User message received for processing',
});

// ─── message.agent.sent ───────────────────────────────────────────────────

export const MessageAgentSentDataSchema = z
  .object({
    content_length: z.number().optional(),
    contentLength: z.number().optional(),
    channel: z.string().optional(),
    has_rich_content: z.boolean().optional(),
    hasRichContent: z.boolean().optional(),
    duration_ms: z.number().optional(),
    durationMs: z.number().optional(),
  })
  .passthrough();

export type MessageAgentSentData = z.infer<typeof MessageAgentSentDataSchema>;

eventRegistry.register('message.agent.sent', MessageAgentSentDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.MESSAGE,
  containsPII: true,
  description: 'Agent response delivered to user',
});
