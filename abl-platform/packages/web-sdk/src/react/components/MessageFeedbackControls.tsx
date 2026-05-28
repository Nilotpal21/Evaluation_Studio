'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useStrings } from '../strings/StringsProvider.js';
import * as styles from './sdk-styles.js';

const DEFAULT_COMMENT_MAX_LENGTH = 500;

export type MessageFeedbackSubmit = (input: {
  messageId: string;
  ratingType: 'thumbs';
  ratingValue: 0 | 1;
  feedbackText?: string;
}) => Promise<{ feedbackId: string }>;

export interface MessageFeedbackControlsProps {
  messageId: string;
  submitFeedback: MessageFeedbackSubmit;
  disabled?: boolean;
  commentMaxLength?: number;
}

type FeedbackRating = 'up' | 'down';

type FeedbackState =
  | { status: 'idle' }
  | { status: 'commenting'; rating: 'down' }
  | { status: 'pending'; rating: FeedbackRating; comment?: string }
  | { status: 'sent'; rating: FeedbackRating; comment?: string; feedbackId: string }
  | { status: 'failed'; rating: FeedbackRating; comment?: string; error: string };

function formatFeedbackError(err: unknown, fallbackMessage: string): string {
  const code = (err as { code?: string } | undefined)?.code;
  switch (code) {
    case 'NOT_CONNECTED':
      return 'Reconnect to send feedback';
    case 'INVALID_TARGET':
      return "This message can't be rated yet";
    case 'DUPLICATE_FEEDBACK':
      return 'Already submitted';
    case 'INVALID_INPUT':
      return 'Comment too long';
    case 'STORAGE_FAILURE':
      return 'Server error - try again';
    case 'FEEDBACK_TIMEOUT':
      return 'Server did not respond';
    case 'FEEDBACK_PENDING':
      return 'Feedback in flight';
    default:
      return fallbackMessage;
  }
}

export function MessageFeedbackControls({
  messageId,
  submitFeedback,
  disabled = false,
  commentMaxLength = DEFAULT_COMMENT_MAX_LENGTH,
}: MessageFeedbackControlsProps): React.ReactElement {
  const strings = useStrings();
  const [state, setState] = useState<FeedbackState>({ status: 'idle' });
  const [comment, setComment] = useState('');

  useEffect(() => {
    setState({ status: 'idle' });
    setComment('');
  }, [messageId]);

  const submit = useCallback(
    async (rating: FeedbackRating, rawComment?: string) => {
      const trimmed = rawComment?.trim();
      setState({
        status: 'pending',
        rating,
        ...(trimmed ? { comment: trimmed } : {}),
      });
      try {
        const { feedbackId } = await submitFeedback({
          messageId,
          ratingType: 'thumbs',
          ratingValue: rating === 'up' ? 1 : 0,
          ...(trimmed ? { feedbackText: trimmed } : {}),
        });
        setState({
          status: 'sent',
          rating,
          feedbackId,
          ...(trimmed ? { comment: trimmed } : {}),
        });
      } catch (err) {
        setState({
          status: 'failed',
          rating,
          error: formatFeedbackError(err, strings.feedbackErrorDefault),
          ...(trimmed ? { comment: trimmed } : {}),
        });
      }
    },
    [messageId, strings.feedbackErrorDefault, submitFeedback],
  );

  const isPending = state.status === 'pending';
  const isSent = state.status === 'sent';
  const upActive = 'rating' in state && state.rating === 'up';
  const downActive = 'rating' in state && state.rating === 'down';
  const controlsDisabled = disabled || isPending || isSent;
  const showComment = state.status === 'commenting';

  return React.createElement(
    'div',
    { style: styles.messageFeedbackContainer, 'data-testid': 'message-feedback-controls' },
    React.createElement(
      'div',
      { style: styles.messageFeedbackRow },
      React.createElement(
        'button',
        {
          type: 'button',
          style: {
            ...styles.messageFeedbackButton,
            ...(upActive ? styles.messageFeedbackUpButton : {}),
            ...(isSent && upActive ? styles.messageFeedbackSentButton : {}),
          },
          disabled: controlsDisabled,
          'aria-pressed': upActive,
          'aria-label': strings.feedbackThumbsUp,
          title: strings.feedbackThumbsUp,
          onClick: () => void submit('up'),
        },
        '👍',
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          style: {
            ...styles.messageFeedbackButton,
            ...(downActive ? styles.messageFeedbackDownButton : {}),
            ...(isSent && downActive ? styles.messageFeedbackSentButton : {}),
          },
          disabled: disabled || isPending || isSent,
          'aria-pressed': downActive,
          'aria-label': strings.feedbackThumbsDown,
          title: strings.feedbackThumbsDown,
          onClick: () => {
            setState({ status: 'commenting', rating: 'down' });
          },
        },
        '👎',
      ),
      isSent
        ? React.createElement(
            'span',
            { style: styles.messageFeedbackStatus },
            state.rating === 'up' ? strings.feedbackThanks : strings.feedbackRecorded,
          )
        : null,
      state.status === 'failed'
        ? React.createElement(
            'span',
            { style: styles.messageFeedbackErrorStatus },
            state.error || strings.feedbackErrorDefault,
          )
        : null,
    ),
    showComment
      ? React.createElement(
          'div',
          { style: styles.messageFeedbackCommentBox },
          React.createElement('textarea', {
            style: styles.messageFeedbackTextarea,
            value: comment,
            maxLength: commentMaxLength,
            rows: 2,
            autoFocus: true,
            placeholder: strings.feedbackCommentPlaceholder,
            'aria-label': strings.feedbackCommentPlaceholder,
            onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
              setComment(e.target.value.slice(0, commentMaxLength)),
          }),
          React.createElement(
            'div',
            { style: styles.messageFeedbackCommentActions },
            React.createElement(
              'span',
              { style: styles.messageFeedbackCounter },
              `${comment.length}/${commentMaxLength}`,
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                style: styles.messageFeedbackGhostButton,
                onClick: () => void submit('down'),
              },
              strings.feedbackSkip,
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                style: styles.messageFeedbackPrimaryButton,
                onClick: () => void submit('down', comment),
              },
              strings.feedbackSend,
            ),
          ),
        )
      : null,
  );
}
