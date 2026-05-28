/**
 * Feedback event schemas.
 *
 * Events related to user feedback and ratings on agent responses.
 * Aligned with industry standard (LangSmith, Langfuse, Braintrust).
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

// ─── feedback.submitted ───────────────────────────────────────────────────

export const FeedbackSubmittedDataSchema = z
  .object({
    rating_type: z.enum(['thumbs', 'star', 'text']).optional(),
    ratingType: z.enum(['thumbs', 'star', 'text']).optional(),
    rating_value: z.number().optional(),
    ratingValue: z.number().optional(),
    target_message_id: z.string().optional(),
    targetMessageId: z.string().optional(),
    feedback_text: z.string().optional(),
    feedbackText: z.string().optional(),
  })
  .passthrough();

export type FeedbackSubmittedData = z.infer<typeof FeedbackSubmittedDataSchema>;

eventRegistry.register('feedback.submitted', FeedbackSubmittedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.FEEDBACK,
  containsPII: true, // Feedback text may contain PII
  description: 'User submitted feedback on an agent response',
});
