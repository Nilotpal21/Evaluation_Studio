/**
 * Feedback ingestion types and Zod schemas.
 *
 * Two WS ingresses converge here:
 *  1) `feedback.submit` — the dedicated structured message.
 *  2) `action_submit` with `actionId='feedback'` — emitted by the rich-template
 *     renderer; normalised into the same shape via `normaliseActionSubmit`.
 *
 * The runtime SDK handler parses the raw incoming message with the loose
 * `SDKIncomingMessage` shape (see `sdk-handler.ts`); these schemas perform the
 * structural narrowing at the handler entry.
 */

import { z } from 'zod';

// ─── Public contract ──────────────────────────────────────────────────────

export const FEEDBACK_TEXT_MAX_LENGTH = 5000;

export const RATING_TYPES = ['thumbs', 'star', 'text'] as const;
export type RatingType = (typeof RATING_TYPES)[number];

export const FEEDBACK_INGRESS = ['feedback_submit', 'action_submit'] as const;
export type FeedbackIngress = (typeof FEEDBACK_INGRESS)[number];

export const FEEDBACK_ERROR_CODES = [
  'INVALID_INPUT',
  'INVALID_TARGET',
  'DUPLICATE_FEEDBACK',
  'STORAGE_FAILURE',
] as const;
export type FeedbackErrorCode = (typeof FEEDBACK_ERROR_CODES)[number];

// ─── feedback.submit (client → server) ────────────────────────────────────

const messageIdSchema = z.string().min(1, 'messageId is required').max(128, 'messageId too long');

const feedbackTextSchema = z
  .string()
  .max(FEEDBACK_TEXT_MAX_LENGTH, `feedbackText must be ≤ ${FEEDBACK_TEXT_MAX_LENGTH} chars`);

const actionRenderIdSchema = z.string().max(256);

const thumbsRatingSchema = z.object({
  ratingType: z.literal('thumbs'),
  ratingValue: z.union([z.literal(0), z.literal(1)]),
  feedbackText: feedbackTextSchema.optional(),
});

const starRatingSchema = z.object({
  ratingType: z.literal('star'),
  ratingValue: z.number().int().min(1).max(5),
  feedbackText: feedbackTextSchema.optional(),
});

const textRatingSchema = z.object({
  ratingType: z.literal('text'),
  // ratingValue is ignored for text ratings — accept any number; default to 0.
  ratingValue: z.number().optional(),
  feedbackText: feedbackTextSchema.min(1, 'feedbackText required for text rating'),
});

const RatingPayloadSchema = z.discriminatedUnion('ratingType', [
  thumbsRatingSchema,
  starRatingSchema,
  textRatingSchema,
]);

export const FeedbackSubmitSchema = z
  .object({
    type: z.literal('feedback.submit'),
    messageId: messageIdSchema,
    actionRenderId: actionRenderIdSchema.optional(),
  })
  .and(RatingPayloadSchema);

export type FeedbackSubmitInput = z.infer<typeof FeedbackSubmitSchema>;

// ─── Normalised internal shape ────────────────────────────────────────────

/**
 * The shape the feedback service operates on after both ingresses have been
 * normalised. Free of transport noise (no `type`, no `formData`).
 */
export interface FeedbackSubmission {
  messageId: string;
  ratingType: RatingType;
  ratingValue: number;
  feedbackText?: string;
  actionRenderId?: string;
  ingress: FeedbackIngress;
}

export function normaliseFeedbackSubmit(input: FeedbackSubmitInput): FeedbackSubmission {
  return {
    messageId: input.messageId,
    ratingType: input.ratingType,
    ratingValue: input.ratingType === 'text' ? 0 : (input.ratingValue ?? 0),
    feedbackText: input.feedbackText,
    actionRenderId: input.actionRenderId,
    ingress: 'feedback_submit',
  };
}

// ─── action_submit(actionId='feedback') normaliser ────────────────────────

/**
 * Action_submit envelope as received from the SDK handler after generic
 * validation. The feedback path expects `formData.messageId` (REQUIRED) and an
 * optional `formData.feedbackText`.
 */
export interface ActionSubmitFeedbackEnvelope {
  actionId: 'feedback';
  value?: unknown;
  formData?: unknown;
  renderId?: unknown;
}

export type NormaliseResult =
  | { ok: true; submission: FeedbackSubmission }
  | { ok: false; code: FeedbackErrorCode; message: string };

/**
 * Convert an `action_submit(actionId='feedback')` envelope into the
 * normalised `FeedbackSubmission` shape. Mirrors the value→rating mapping
 * documented in the feature spec § 2.2:
 *  - 'up'   → thumbs / 1
 *  - 'down' → thumbs / 0
 *  - '1'..'5' → star / N
 */
export function normaliseActionSubmit(envelope: ActionSubmitFeedbackEnvelope): NormaliseResult {
  const formData =
    envelope.formData && typeof envelope.formData === 'object'
      ? (envelope.formData as Record<string, unknown>)
      : undefined;
  if (!formData) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'formData with messageId is required for action_submit(feedback)',
    };
  }
  const messageId = formData.messageId;
  if (typeof messageId !== 'string' || messageId.length === 0) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'formData.messageId is required',
    };
  }
  if (messageId.length > 128) {
    return { ok: false, code: 'INVALID_INPUT', message: 'messageId too long' };
  }

  const feedbackText = formData.feedbackText;
  let normalisedText: string | undefined;
  if (feedbackText !== undefined && feedbackText !== null) {
    if (typeof feedbackText !== 'string') {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: 'feedbackText must be a string',
      };
    }
    if (feedbackText.length > FEEDBACK_TEXT_MAX_LENGTH) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: `feedbackText must be ≤ ${FEEDBACK_TEXT_MAX_LENGTH} chars`,
      };
    }
    normalisedText = feedbackText;
  }

  const rawValue = envelope.value;
  if (typeof rawValue !== 'string' || rawValue.length === 0) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'value is required for action_submit(feedback)',
    };
  }

  let ratingType: RatingType;
  let ratingValue: number;
  if (rawValue === 'up') {
    ratingType = 'thumbs';
    ratingValue = 1;
  } else if (rawValue === 'down') {
    ratingType = 'thumbs';
    ratingValue = 0;
  } else if (/^[1-5]$/.test(rawValue)) {
    ratingType = 'star';
    ratingValue = Number(rawValue);
  } else {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `Unknown feedback value: ${rawValue}`,
    };
  }

  const renderId =
    typeof envelope.renderId === 'string' && envelope.renderId.length > 0
      ? envelope.renderId
      : undefined;

  return {
    ok: true,
    submission: {
      messageId,
      ratingType,
      ratingValue,
      feedbackText: normalisedText,
      actionRenderId: renderId,
      ingress: 'action_submit',
    },
  };
}

// ─── Persistence shapes ───────────────────────────────────────────────────

/**
 * Row layout for the `abl_platform.feedback` ClickHouse table.
 *
 * `encrypted` and `key_version` columns are populated by the shared
 * ClickHouse encryption interceptor at flush time — the service writes
 * plaintext into `feedback_text` and the interceptor encrypts in place
 * (same pattern as messages). When no interceptor is configured both
 * columns remain at their default values (0 / 0).
 */
export interface FeedbackRecord {
  tenant_id: string;
  project_id: string;
  feedback_id: string;
  timestamp: Date;

  session_id: string;
  message_id: string;
  agent_name: string;
  user_id: string;
  channel: string;

  rating_type: RatingType;
  rating_value: number;
  feedback_text: string;

  has_pii: 0 | 1;

  /** Always 'websocket' for both WS ingresses (see D-13). */
  source: 'websocket' | 'email' | 'api';
  ingress_type: FeedbackIngress | '';
}

// ─── Service input / output ───────────────────────────────────────────────

export interface SubmitContext {
  tenantId: string;
  projectId: string;
  sessionId: string;
  userId: string;
  /** Channel that produced the feedback (e.g. 'web', 'sdk'). */
  channel?: string;
}

export type SubmitResult =
  | { ok: true; feedbackId: string }
  | { ok: false; code: FeedbackErrorCode; message: string };

// ─── Type guards / helpers ────────────────────────────────────────────────

export function isFeedbackSubmitMessage(value: unknown): value is { type: 'feedback.submit' } {
  return (
    !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'feedback.submit'
  );
}

export function isFeedbackActionId(value: unknown): boolean {
  return value === 'feedback';
}
