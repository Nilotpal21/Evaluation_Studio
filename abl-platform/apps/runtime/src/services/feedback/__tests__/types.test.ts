/**
 * Unit tests for the feedback Zod surface + action_submit normaliser.
 *
 * Covers the validation matrix the SDK handler will use at the WS entry —
 * pure validation, no IO, no platform mocks.
 */

import { describe, it, expect } from 'vitest';
import {
  FeedbackSubmitSchema,
  FEEDBACK_TEXT_MAX_LENGTH,
  isFeedbackActionId,
  isFeedbackSubmitMessage,
  normaliseActionSubmit,
  normaliseFeedbackSubmit,
} from '../types.js';

const validMessageId = '550e8400-e29b-41d4-a716-446655440000';
const validRenderId = 'render-abc';

describe('FeedbackSubmitSchema', () => {
  it('accepts a thumbs-up payload', () => {
    const parsed = FeedbackSubmitSchema.parse({
      type: 'feedback.submit',
      messageId: validMessageId,
      ratingType: 'thumbs',
      ratingValue: 1,
    });
    expect(parsed.ratingType).toBe('thumbs');
    expect(parsed.ratingValue).toBe(1);
  });

  it('accepts a thumbs-down payload with feedbackText', () => {
    const parsed = FeedbackSubmitSchema.parse({
      type: 'feedback.submit',
      messageId: validMessageId,
      ratingType: 'thumbs',
      ratingValue: 0,
      feedbackText: 'Did not answer my question.',
    });
    expect(parsed.feedbackText).toBe('Did not answer my question.');
  });

  it('accepts a star rating 1..5', () => {
    for (let n = 1; n <= 5; n += 1) {
      const parsed = FeedbackSubmitSchema.parse({
        type: 'feedback.submit',
        messageId: validMessageId,
        ratingType: 'star',
        ratingValue: n,
      });
      expect(parsed.ratingValue).toBe(n);
    }
  });

  it('accepts a text rating with non-empty feedbackText', () => {
    const parsed = FeedbackSubmitSchema.parse({
      type: 'feedback.submit',
      messageId: validMessageId,
      ratingType: 'text',
      ratingValue: 0,
      feedbackText: 'Long-form comment.',
    });
    expect(parsed.ratingType).toBe('text');
  });

  it('accepts an optional actionRenderId', () => {
    const parsed = FeedbackSubmitSchema.parse({
      type: 'feedback.submit',
      messageId: validMessageId,
      actionRenderId: validRenderId,
      ratingType: 'thumbs',
      ratingValue: 1,
    });
    expect(parsed.actionRenderId).toBe(validRenderId);
  });

  it('rejects thumbs ratingValue outside 0/1', () => {
    expect(() =>
      FeedbackSubmitSchema.parse({
        type: 'feedback.submit',
        messageId: validMessageId,
        ratingType: 'thumbs',
        ratingValue: 2,
      }),
    ).toThrow();
  });

  it('rejects star ratingValue outside 1..5', () => {
    expect(() =>
      FeedbackSubmitSchema.parse({
        type: 'feedback.submit',
        messageId: validMessageId,
        ratingType: 'star',
        ratingValue: 6,
      }),
    ).toThrow();
    expect(() =>
      FeedbackSubmitSchema.parse({
        type: 'feedback.submit',
        messageId: validMessageId,
        ratingType: 'star',
        ratingValue: 0,
      }),
    ).toThrow();
  });

  it('rejects star ratingValue with fractional component', () => {
    expect(() =>
      FeedbackSubmitSchema.parse({
        type: 'feedback.submit',
        messageId: validMessageId,
        ratingType: 'star',
        ratingValue: 3.5,
      }),
    ).toThrow();
  });

  it('rejects text rating without feedbackText', () => {
    expect(() =>
      FeedbackSubmitSchema.parse({
        type: 'feedback.submit',
        messageId: validMessageId,
        ratingType: 'text',
        ratingValue: 0,
      }),
    ).toThrow();
  });

  it('rejects feedbackText longer than the cap', () => {
    expect(() =>
      FeedbackSubmitSchema.parse({
        type: 'feedback.submit',
        messageId: validMessageId,
        ratingType: 'thumbs',
        ratingValue: 1,
        feedbackText: 'x'.repeat(FEEDBACK_TEXT_MAX_LENGTH + 1),
      }),
    ).toThrow();
  });

  it('accepts feedbackText exactly at the cap', () => {
    const parsed = FeedbackSubmitSchema.parse({
      type: 'feedback.submit',
      messageId: validMessageId,
      ratingType: 'thumbs',
      ratingValue: 0,
      feedbackText: 'x'.repeat(FEEDBACK_TEXT_MAX_LENGTH),
    });
    expect(parsed.feedbackText?.length).toBe(FEEDBACK_TEXT_MAX_LENGTH);
  });

  it('rejects an empty messageId', () => {
    expect(() =>
      FeedbackSubmitSchema.parse({
        type: 'feedback.submit',
        messageId: '',
        ratingType: 'thumbs',
        ratingValue: 1,
      }),
    ).toThrow();
  });

  it('rejects missing messageId', () => {
    expect(() =>
      FeedbackSubmitSchema.parse({
        type: 'feedback.submit',
        ratingType: 'thumbs',
        ratingValue: 1,
      }),
    ).toThrow();
  });

  it('rejects unknown ratingType', () => {
    expect(() =>
      FeedbackSubmitSchema.parse({
        type: 'feedback.submit',
        messageId: validMessageId,
        ratingType: 'emoji',
        ratingValue: 1,
      }),
    ).toThrow();
  });

  it('rejects wrong type literal', () => {
    expect(() =>
      FeedbackSubmitSchema.parse({
        type: 'feedback',
        messageId: validMessageId,
        ratingType: 'thumbs',
        ratingValue: 1,
      }),
    ).toThrow();
  });
});

describe('normaliseFeedbackSubmit', () => {
  it('zeros out ratingValue for text rating', () => {
    const submission = normaliseFeedbackSubmit({
      type: 'feedback.submit',
      messageId: validMessageId,
      ratingType: 'text',
      ratingValue: 7,
      feedbackText: 'Comment',
    });
    expect(submission.ratingValue).toBe(0);
    expect(submission.ingress).toBe('feedback_submit');
  });

  it('preserves rating data and renderId for thumbs', () => {
    const submission = normaliseFeedbackSubmit({
      type: 'feedback.submit',
      messageId: validMessageId,
      actionRenderId: validRenderId,
      ratingType: 'thumbs',
      ratingValue: 0,
      feedbackText: 'Bad answer',
    });
    expect(submission).toMatchObject({
      messageId: validMessageId,
      ratingType: 'thumbs',
      ratingValue: 0,
      feedbackText: 'Bad answer',
      actionRenderId: validRenderId,
      ingress: 'feedback_submit',
    });
  });
});

describe('normaliseActionSubmit', () => {
  it('maps value="up" to thumbs/1', () => {
    const result = normaliseActionSubmit({
      actionId: 'feedback',
      value: 'up',
      formData: { messageId: validMessageId },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submission.ratingType).toBe('thumbs');
    expect(result.submission.ratingValue).toBe(1);
    expect(result.submission.ingress).toBe('action_submit');
  });

  it('maps value="down" to thumbs/0 and carries feedbackText', () => {
    const result = normaliseActionSubmit({
      actionId: 'feedback',
      value: 'down',
      formData: { messageId: validMessageId, feedbackText: 'No.' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submission.ratingType).toBe('thumbs');
    expect(result.submission.ratingValue).toBe(0);
    expect(result.submission.feedbackText).toBe('No.');
  });

  it('maps value="3" to star/3', () => {
    const result = normaliseActionSubmit({
      actionId: 'feedback',
      value: '3',
      formData: { messageId: validMessageId },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submission.ratingType).toBe('star');
    expect(result.submission.ratingValue).toBe(3);
  });

  it('propagates renderId as actionRenderId', () => {
    const result = normaliseActionSubmit({
      actionId: 'feedback',
      value: 'up',
      formData: { messageId: validMessageId },
      renderId: validRenderId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submission.actionRenderId).toBe(validRenderId);
  });

  it('rejects missing formData', () => {
    const result = normaliseActionSubmit({
      actionId: 'feedback',
      value: 'up',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_INPUT');
  });

  it('rejects missing messageId in formData', () => {
    const result = normaliseActionSubmit({
      actionId: 'feedback',
      value: 'up',
      formData: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_INPUT');
  });

  it('rejects unknown rating values like "0" or "6"', () => {
    for (const value of ['0', '6', 'maybe']) {
      const result = normaliseActionSubmit({
        actionId: 'feedback',
        value,
        formData: { messageId: validMessageId },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects oversized feedbackText', () => {
    const result = normaliseActionSubmit({
      actionId: 'feedback',
      value: 'down',
      formData: {
        messageId: validMessageId,
        feedbackText: 'x'.repeat(FEEDBACK_TEXT_MAX_LENGTH + 1),
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_INPUT');
  });

  it('rejects non-string messageId', () => {
    const result = normaliseActionSubmit({
      actionId: 'feedback',
      value: 'up',
      formData: { messageId: 42 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_INPUT');
  });

  it('rejects non-string feedbackText', () => {
    const result = normaliseActionSubmit({
      actionId: 'feedback',
      value: 'down',
      formData: { messageId: validMessageId, feedbackText: 12 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_INPUT');
  });

  it('rejects missing value', () => {
    const result = normaliseActionSubmit({
      actionId: 'feedback',
      formData: { messageId: validMessageId },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_INPUT');
  });
});

describe('type guards', () => {
  it('isFeedbackSubmitMessage narrows correctly', () => {
    expect(isFeedbackSubmitMessage({ type: 'feedback.submit' })).toBe(true);
    expect(isFeedbackSubmitMessage({ type: 'chat_message' })).toBe(false);
    expect(isFeedbackSubmitMessage(null)).toBe(false);
    expect(isFeedbackSubmitMessage('feedback.submit')).toBe(false);
  });

  it('isFeedbackActionId identifies the feedback action id', () => {
    expect(isFeedbackActionId('feedback')).toBe(true);
    expect(isFeedbackActionId('confirm_booking')).toBe(false);
    expect(isFeedbackActionId(null)).toBe(false);
  });
});
