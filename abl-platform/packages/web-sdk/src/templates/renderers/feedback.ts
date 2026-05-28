/**
 * Feedback Template Renderer
 *
 * Renders a feedback prompt with thumbs, stars, or numeric scale options.
 *
 * Submission path priority (ABLP-1068):
 *   1) `ctx.submitFeedback({ ratingType, ratingValue, feedbackText? })`
 *      when the threading site provided a callback. This sends a structured
 *      `feedback.submit` and short-circuits the agent loop.
 *   2) `ctx.onAction('feedback', selectedValue)` as a back-compat fallback
 *      for older consumers that have not threaded `submitFeedback`. The
 *      runtime treats `actionId='feedback'` action_submits identically to
 *      `feedback.submit`, so behaviour is equivalent at the runtime.
 *
 * Thumbs-down reveals an optional free-text textarea (≤ 5000 chars) with
 * Send + Skip buttons. All submissions disable controls on success.
 */

import React from 'react';
import type { Message, FeedbackTemplate } from '../../core/types.js';
import type { TemplateRenderer, TemplateContext } from '../types.js';
import { defaultRegistry } from '../registry.js';
import { getString } from '../utils/strings.js';

/** Default max for stars and scale */
const DEFAULT_MAX = 5;

/** Hard cap to prevent unbounded DOM element creation */
const MAX_ALLOWED = 20;

/** Mirrors the runtime cap; both ends enforce it independently. */
const FEEDBACK_TEXT_MAX_LENGTH = 5000;

// ─── Submission helpers ──────────────────────────────────────────────────

type RatingType = 'thumbs' | 'star' | 'text';

interface RatingPayload {
  ratingType: RatingType;
  ratingValue: number;
  feedbackText?: string;
}

/**
 * Map the renderer's selected string value to the structured rating payload
 * the feedback service expects. Returns undefined for unknown / missing values.
 */
function toRatingPayload(
  templateType: FeedbackTemplate['type'],
  selected: string | null,
  feedbackText?: string,
): RatingPayload | undefined {
  if (!selected) return undefined;
  if (templateType === 'thumbs') {
    if (selected !== 'up' && selected !== 'down') return undefined;
    return {
      ratingType: 'thumbs',
      ratingValue: selected === 'up' ? 1 : 0,
      ...(feedbackText ? { feedbackText } : {}),
    };
  }
  const n = Number(selected);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ALLOWED) return undefined;
  // Both 'stars' and 'scale' templates map onto the runtime's 'star' rating
  // type (the runtime treats them identically — 1..N integer scale).
  return {
    ratingType: 'star',
    ratingValue: n,
    ...(feedbackText ? { feedbackText } : {}),
  };
}

/**
 * Dispatch a submission through whichever path the threading site provided.
 * Always falls back to the generic `onAction('feedback', selected)` when
 * `ctx.submitFeedback` is absent so older consumers keep working.
 *
 * Promise rejections from `ctx.submitFeedback` are swallowed (logged) so the
 * renderer's fire-and-forget submit doesn't produce unhandled rejections.
 * Consumers that want to react to ack failures should subscribe to the
 * ChatClient `feedbackAck` event upstream.
 */
function dispatch(
  ctx: TemplateContext,
  templateType: FeedbackTemplate['type'],
  selected: string,
  feedbackText?: string,
): void {
  if (ctx.submitFeedback) {
    const payload = toRatingPayload(templateType, selected, feedbackText);
    if (payload) {
      ctx.submitFeedback(payload).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[feedback-renderer] submitFeedback rejected:', err);
      });
      return;
    }
  }
  ctx.onAction('feedback', selected);
}

// ---------------------------------------------------------------------------
// React component (needs state for selection + comment UX)
// ---------------------------------------------------------------------------

function FeedbackComponent(props: {
  data: FeedbackTemplate;
  ctx: TemplateContext;
}): React.ReactElement {
  const { data, ctx } = props;
  const [selected, setSelected] = React.useState<string | null>(null);
  const [commentText, setCommentText] = React.useState('');
  const [submitted, setSubmitted] = React.useState(false);
  const max = Math.min(data.max ?? DEFAULT_MAX, MAX_ALLOWED);

  const showCommentUi = data.type === 'thumbs' && selected === 'down' && !submitted;

  const handleSelect = (value: string) => {
    if (submitted) return;
    setSelected(value);
    // Non-down thumbs: submit immediately (no comment needed).
    if (data.type === 'thumbs' && value === 'up') {
      setSubmitted(true);
      void dispatch(ctx, data.type, value);
    }
  };

  const handleSubmit = (withComment: boolean) => {
    if (!selected || submitted) return;
    const text = withComment ? commentText.trim() : '';
    setSubmitted(true);
    void dispatch(ctx, data.type, selected, text.length > 0 ? text : undefined);
  };

  let options: React.ReactElement;

  if (data.type === 'thumbs') {
    options = React.createElement(
      'div',
      {
        className: 'rich-feedback-options',
        role: 'radiogroup',
        'aria-label': data.prompt,
        ...(ctx.actionRenderId ? { 'data-render-id': ctx.actionRenderId } : {}),
      },
      React.createElement(
        'button',
        {
          className: `rich-feedback-option ${selected === 'up' ? 'rich-feedback-selected' : ''}`,
          role: 'radio',
          'aria-checked': selected === 'up',
          'aria-label': getString('feedback.thumbsUp'),
          disabled: submitted,
          onClick: () => handleSelect('up'),
        },
        '👍',
      ),
      React.createElement(
        'button',
        {
          className: `rich-feedback-option ${selected === 'down' ? 'rich-feedback-selected' : ''}`,
          role: 'radio',
          'aria-checked': selected === 'down',
          'aria-label': getString('feedback.thumbsDown'),
          disabled: submitted,
          onClick: () => handleSelect('down'),
        },
        '👎',
      ),
    );
  } else if (data.type === 'stars') {
    const stars = Array.from({ length: max }, (_, i) => i + 1);
    options = React.createElement(
      'div',
      {
        className: 'rich-feedback-options',
        role: 'radiogroup',
        'aria-label': data.prompt,
        ...(ctx.actionRenderId ? { 'data-render-id': ctx.actionRenderId } : {}),
      },
      ...stars.map((n) =>
        React.createElement(
          'button',
          {
            key: n,
            className: `rich-feedback-option rich-feedback-star ${selected !== null && n <= Number(selected) ? 'rich-feedback-selected' : ''}`,
            role: 'radio',
            'aria-checked': selected === String(n),
            'aria-label': `${n} star${n > 1 ? 's' : ''}`,
            disabled: submitted,
            onClick: () => handleSelect(String(n)),
          },
          '★',
        ),
      ),
    );
  } else {
    // scale
    const nums = Array.from({ length: max }, (_, i) => i + 1);
    options = React.createElement(
      'div',
      {
        className: 'rich-feedback-options',
        role: 'radiogroup',
        'aria-label': data.prompt,
        ...(ctx.actionRenderId ? { 'data-render-id': ctx.actionRenderId } : {}),
      },
      ...nums.map((n) =>
        React.createElement(
          'button',
          {
            key: n,
            className: `rich-feedback-option rich-feedback-scale ${selected === String(n) ? 'rich-feedback-selected' : ''}`,
            role: 'radio',
            'aria-checked': selected === String(n),
            'aria-label': String(n),
            disabled: submitted,
            onClick: () => handleSelect(String(n)),
          },
          String(n),
        ),
      ),
    );
  }

  // Thumbs-down comment UI: reveal a textarea + Send/Skip after a down vote.
  const commentUi = showCommentUi
    ? React.createElement(
        'div',
        { className: 'rich-feedback-comment' },
        React.createElement('textarea', {
          className: 'rich-feedback-comment-input',
          maxLength: FEEDBACK_TEXT_MAX_LENGTH,
          placeholder: getString('feedback.commentPlaceholder'),
          'aria-label': getString('feedback.commentPlaceholder'),
          value: commentText,
          onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setCommentText(e.target.value),
        }),
        React.createElement(
          'div',
          { className: 'rich-feedback-comment-actions' },
          React.createElement(
            'button',
            {
              className: 'rich-btn rich-btn-secondary rich-feedback-skip',
              disabled: submitted,
              onClick: () => handleSubmit(false),
            },
            getString('feedback.skip'),
          ),
          React.createElement(
            'button',
            {
              className: 'rich-btn rich-btn-primary rich-feedback-send',
              disabled: submitted,
              onClick: () => handleSubmit(true),
            },
            getString('feedback.send'),
          ),
        ),
      )
    : null;

  // Star / scale templates keep the legacy single Submit button for parity.
  const submitButton =
    data.type !== 'thumbs'
      ? React.createElement(
          'button',
          {
            className: 'rich-btn rich-btn-primary rich-feedback-submit',
            disabled: !selected || submitted,
            onClick: () => handleSubmit(false),
          },
          getString('feedback.submit'),
        )
      : null;

  return React.createElement(
    'div',
    { className: 'rich-feedback', 'aria-label': getString('feedback.label') },
    React.createElement('div', { className: 'rich-feedback-prompt' }, data.prompt),
    options,
    commentUi,
    submitButton,
  );
}

// ---------------------------------------------------------------------------
// DOM renderer (vanilla — used by ChatWidget / UnifiedWidget / renderRichMessage)
// ---------------------------------------------------------------------------

function renderFeedbackDOM(data: FeedbackTemplate, ctx: TemplateContext): HTMLElement {
  const max = Math.min(data.max ?? DEFAULT_MAX, MAX_ALLOWED);
  let selected: string | null = null;
  let isSubmitted = false;

  const container = document.createElement('div');
  container.className = 'rich-feedback';
  container.setAttribute('aria-label', getString('feedback.label'));
  if (ctx.actionRenderId) {
    container.dataset.renderId = ctx.actionRenderId;
  }

  const prompt = document.createElement('div');
  prompt.className = 'rich-feedback-prompt';
  prompt.textContent = data.prompt;
  container.appendChild(prompt);

  const optionsGroup = document.createElement('div');
  optionsGroup.className = 'rich-feedback-options';
  optionsGroup.setAttribute('role', 'radiogroup');
  optionsGroup.setAttribute('aria-label', data.prompt);

  // Comment UI placeholder (created lazily on thumbs-down).
  let commentBlock: HTMLDivElement | null = null;
  let commentInput: HTMLTextAreaElement | null = null;

  function disableAllButtons() {
    const allBtns = container.querySelectorAll<HTMLButtonElement>('button');
    allBtns.forEach((btn) => {
      btn.disabled = true;
    });
  }

  function submit(text?: string) {
    if (!selected || isSubmitted) return;
    isSubmitted = true;
    disableAllButtons();
    const trimmed = text?.trim();
    void dispatch(ctx, data.type, selected, trimmed && trimmed.length > 0 ? trimmed : undefined);
  }

  function showCommentUi() {
    if (commentBlock) return;
    commentBlock = document.createElement('div');
    commentBlock.className = 'rich-feedback-comment';
    commentInput = document.createElement('textarea');
    commentInput.className = 'rich-feedback-comment-input';
    commentInput.maxLength = FEEDBACK_TEXT_MAX_LENGTH;
    commentInput.placeholder = getString('feedback.commentPlaceholder');
    commentInput.setAttribute('aria-label', getString('feedback.commentPlaceholder'));
    commentBlock.appendChild(commentInput);
    const actions = document.createElement('div');
    actions.className = 'rich-feedback-comment-actions';
    const skipBtn = document.createElement('button');
    skipBtn.className = 'rich-btn rich-btn-secondary rich-feedback-skip';
    skipBtn.textContent = getString('feedback.skip');
    skipBtn.addEventListener('click', () => submit());
    actions.appendChild(skipBtn);
    const sendBtn = document.createElement('button');
    sendBtn.className = 'rich-btn rich-btn-primary rich-feedback-send';
    sendBtn.textContent = getString('feedback.send');
    sendBtn.addEventListener('click', () => submit(commentInput?.value));
    actions.appendChild(sendBtn);
    commentBlock.appendChild(actions);
    container.appendChild(commentBlock);
    commentInput.focus();
  }

  const updateSelection = (value: string) => {
    if (isSubmitted) return;
    selected = value;

    // Update visual state
    const allBtns = optionsGroup.querySelectorAll<HTMLButtonElement>('.rich-feedback-option');

    if (data.type === 'stars') {
      const numValue = Number(value);
      allBtns.forEach((btn, i) => {
        const isSelected = i + 1 <= numValue;
        btn.classList.toggle('rich-feedback-selected', isSelected);
        btn.setAttribute('aria-checked', String(btn.dataset.value === value));
      });
    } else {
      allBtns.forEach((btn) => {
        const isSelected = btn.dataset.value === value;
        btn.classList.toggle('rich-feedback-selected', isSelected);
        btn.setAttribute('aria-checked', String(isSelected));
      });
    }

    if (data.type === 'thumbs' && value === 'up') {
      // Immediate submit for positive feedback.
      submit();
      return;
    }
    if (data.type === 'thumbs' && value === 'down') {
      showCommentUi();
      return;
    }
    // Non-thumbs templates need the legacy Submit button to fire.
    if (submitBtn) submitBtn.disabled = false;
  };

  if (data.type === 'thumbs') {
    for (const val of ['up', 'down']) {
      const btn = document.createElement('button');
      btn.className = 'rich-feedback-option';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.setAttribute(
        'aria-label',
        val === 'up' ? getString('feedback.thumbsUp') : getString('feedback.thumbsDown'),
      );
      btn.dataset.value = val;
      btn.textContent = val === 'up' ? '👍' : '👎';
      btn.addEventListener('click', () => updateSelection(val));
      optionsGroup.appendChild(btn);
    }
  } else if (data.type === 'stars') {
    for (let i = 1; i <= max; i++) {
      const btn = document.createElement('button');
      btn.className = 'rich-feedback-option rich-feedback-star';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.setAttribute('aria-label', `${i} star${i > 1 ? 's' : ''}`);
      btn.dataset.value = String(i);
      btn.textContent = '★';
      btn.addEventListener('click', () => updateSelection(String(i)));
      optionsGroup.appendChild(btn);
    }
  } else {
    // scale
    for (let i = 1; i <= max; i++) {
      const btn = document.createElement('button');
      btn.className = 'rich-feedback-option rich-feedback-scale';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.setAttribute('aria-label', String(i));
      btn.dataset.value = String(i);
      btn.textContent = String(i);
      btn.addEventListener('click', () => updateSelection(String(i)));
      optionsGroup.appendChild(btn);
    }
  }

  container.appendChild(optionsGroup);

  // Non-thumbs templates keep the legacy submit button at the bottom.
  const submitBtn: HTMLButtonElement | null =
    data.type === 'thumbs' ? null : document.createElement('button');
  if (submitBtn) {
    submitBtn.className = 'rich-btn rich-btn-primary rich-feedback-submit';
    submitBtn.textContent = getString('feedback.submit');
    submitBtn.disabled = true;
    submitBtn.addEventListener('click', () => submit());
    container.appendChild(submitBtn);
  }

  return container;
}

// ---------------------------------------------------------------------------
// Renderer registration
// ---------------------------------------------------------------------------

const feedbackRenderer: TemplateRenderer<FeedbackTemplate> = {
  type: 'feedback',

  extract(message: Message): FeedbackTemplate | undefined {
    return message.richContent?.feedback;
  },

  render(data: FeedbackTemplate, ctx: TemplateContext): React.ReactElement {
    return React.createElement(FeedbackComponent, { data, ctx });
  },

  renderDOM(data: FeedbackTemplate, ctx: TemplateContext): HTMLElement {
    return renderFeedbackDOM(data, ctx);
  },
};

defaultRegistry.register(feedbackRenderer);

export { feedbackRenderer };
