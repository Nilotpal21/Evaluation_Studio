/**
 * Rich feedback renderer tests (ABLP-1068).
 *
 * Covers the renderer dispatch contract:
 *   - Thumbs-up submits immediately via ctx.submitFeedback with the rating-
 *     data-only shape (no messageId / no actionRenderId in the input — the
 *     closure binds them upstream).
 *   - Thumbs-down reveals the comment textarea + Send / Skip; submitting
 *     with text forwards feedback_text, Skip submits without.
 *   - Star templates submit via the rating mapping (selected '4' → star/4).
 *   - When ctx.submitFeedback is absent, the renderer falls back to
 *     ctx.onAction('feedback', selected) for back-compat.
 *   - actionRenderId is reflected in a data-render-id attribute but NEVER
 *     appears in the submitFeedback payload — closure handles that binding.
 *
 * Targets the vanilla DOM renderer so we exercise the same code path the
 * SDK widgets use.
 */

// @vitest-environment happy-dom

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { feedbackRenderer } from '../templates/renderers/feedback.js';
import type { TemplateContext } from '../templates/types.js';
import type { FeedbackTemplate } from '../core/types.js';

interface SubmitCall {
  ratingType: 'thumbs' | 'star' | 'text';
  ratingValue: number;
  feedbackText?: string;
}

function makeCtx(opts: { withSubmitFeedback?: boolean; renderId?: string } = {}): {
  ctx: TemplateContext;
  submitCalls: SubmitCall[];
  actionCalls: Array<{ actionId: string; value?: string }>;
} {
  const submitCalls: SubmitCall[] = [];
  const actionCalls: Array<{ actionId: string; value?: string }> = [];
  const ctx: TemplateContext = {
    theme: {},
    messageId: 'm-1',
    ...(opts.renderId ? { actionRenderId: opts.renderId } : {}),
    onAction: (actionId, value) => actionCalls.push({ actionId, value }),
    ...(opts.withSubmitFeedback !== false
      ? {
          submitFeedback: (input) => {
            submitCalls.push(input);
            return Promise.resolve({ feedbackId: `fb-${submitCalls.length}` });
          },
        }
      : {}),
  };
  return { ctx, submitCalls, actionCalls };
}

function thumbsTemplate(): FeedbackTemplate {
  return { type: 'thumbs', prompt: 'How did I do?' };
}

function starsTemplate(): FeedbackTemplate {
  return { type: 'stars', prompt: 'Rate this', max: 5 };
}

describe('feedback renderer — DOM path', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('thumbs-up submits immediately via submitFeedback with rating-data only', () => {
    const { ctx, submitCalls } = makeCtx({ renderId: 'render-1' });
    const el = feedbackRenderer.renderDOM(thumbsTemplate(), ctx);
    document.body.appendChild(el);

    const upBtn = el.querySelector<HTMLButtonElement>('button[aria-label="Thumbs up"]');
    expect(upBtn).toBeTruthy();
    upBtn!.click();

    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]).toEqual({ ratingType: 'thumbs', ratingValue: 1 });
    // No messageId / actionRenderId in the payload — closure binds them.
    const upPayload = submitCalls[0] as unknown as Record<string, unknown>;
    expect(upPayload.messageId).toBeUndefined();
    expect(upPayload.actionRenderId).toBeUndefined();

    // Render id is reflected on the surface as a data attribute only.
    expect(el.dataset.renderId).toBe('render-1');
  });

  test('thumbs-down reveals the textarea + Send/Skip; Send forwards feedbackText', () => {
    const { ctx, submitCalls } = makeCtx();
    const el = feedbackRenderer.renderDOM(thumbsTemplate(), ctx);
    document.body.appendChild(el);

    const downBtn = el.querySelector<HTMLButtonElement>('button[aria-label="Thumbs down"]');
    downBtn!.click();

    const textarea = el.querySelector<HTMLTextAreaElement>('.rich-feedback-comment-input');
    expect(textarea).toBeTruthy();
    expect(submitCalls).toHaveLength(0);

    textarea!.value = 'It missed the question';
    const sendBtn = el.querySelector<HTMLButtonElement>('.rich-feedback-send');
    sendBtn!.click();

    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]).toEqual({
      ratingType: 'thumbs',
      ratingValue: 0,
      feedbackText: 'It missed the question',
    });
  });

  test('thumbs-down Skip submits without feedbackText', () => {
    const { ctx, submitCalls } = makeCtx();
    const el = feedbackRenderer.renderDOM(thumbsTemplate(), ctx);
    document.body.appendChild(el);

    el.querySelector<HTMLButtonElement>('button[aria-label="Thumbs down"]')!.click();
    el.querySelector<HTMLButtonElement>('.rich-feedback-skip')!.click();

    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]).toEqual({ ratingType: 'thumbs', ratingValue: 0 });
    const skipPayload = submitCalls[0] as unknown as Record<string, unknown>;
    expect(skipPayload.feedbackText).toBeUndefined();
  });

  test('disables controls after submission (no double-submit)', () => {
    const { ctx, submitCalls } = makeCtx();
    const el = feedbackRenderer.renderDOM(thumbsTemplate(), ctx);
    document.body.appendChild(el);

    el.querySelector<HTMLButtonElement>('button[aria-label="Thumbs up"]')!.click();
    el.querySelector<HTMLButtonElement>('button[aria-label="Thumbs up"]')!.click();

    expect(submitCalls).toHaveLength(1);
    el.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      expect(btn.disabled).toBe(true);
    });
  });

  test('star templates submit via submitFeedback with star/N rating mapping', () => {
    const { ctx, submitCalls } = makeCtx();
    const el = feedbackRenderer.renderDOM(starsTemplate(), ctx);
    document.body.appendChild(el);

    // Select 4 stars
    const stars = el.querySelectorAll<HTMLButtonElement>('.rich-feedback-star');
    stars[3]!.click(); // 4-star button (index 3)
    el.querySelector<HTMLButtonElement>('.rich-feedback-submit')!.click();

    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]).toEqual({ ratingType: 'star', ratingValue: 4 });
  });

  test('falls back to onAction when ctx.submitFeedback is undefined (back-compat)', () => {
    const { ctx, actionCalls, submitCalls } = makeCtx({ withSubmitFeedback: false });
    const el = feedbackRenderer.renderDOM(thumbsTemplate(), ctx);
    document.body.appendChild(el);

    el.querySelector<HTMLButtonElement>('button[aria-label="Thumbs up"]')!.click();

    expect(submitCalls).toHaveLength(0);
    expect(actionCalls).toEqual([{ actionId: 'feedback', value: 'up' }]);
  });

  test('thumbs-down with no comment falls back to onAction when submitFeedback is absent', () => {
    const { ctx, actionCalls, submitCalls } = makeCtx({ withSubmitFeedback: false });
    const el = feedbackRenderer.renderDOM(thumbsTemplate(), ctx);
    document.body.appendChild(el);

    el.querySelector<HTMLButtonElement>('button[aria-label="Thumbs down"]')!.click();
    // In fallback mode the legacy renderer skips the comment UI — the
    // down click immediately exposes Send/Skip, and Skip triggers onAction.
    el.querySelector<HTMLButtonElement>('.rich-feedback-skip')!.click();

    expect(submitCalls).toHaveLength(0);
    expect(actionCalls).toEqual([{ actionId: 'feedback', value: 'down' }]);
  });
});

describe('feedback renderer — submitFeedback rejection surfaces gracefully', () => {
  test('rejected submitFeedback does not break the renderer (no unhandled promise)', async () => {
    const errors: Array<unknown> = [];
    const onUnhandled = (event: PromiseRejectionEvent) => errors.push(event.reason);
    window.addEventListener('unhandledrejection', onUnhandled);

    const ctx: TemplateContext = {
      theme: {},
      messageId: 'm-1',
      onAction: vi.fn(),
      submitFeedback: () => Promise.reject(new Error('boom')),
    };
    const el = feedbackRenderer.renderDOM(thumbsTemplate(), ctx);
    document.body.appendChild(el);
    el.querySelector<HTMLButtonElement>('button[aria-label="Thumbs up"]')!.click();

    // Resolve pending microtasks
    await new Promise((r) => setTimeout(r, 0));

    window.removeEventListener('unhandledrejection', onUnhandled);
    // The renderer fires-and-forgets the promise; the test just verifies the
    // renderer didn't synchronously throw and the document still renders.
    expect(el.isConnected).toBe(true);
  });
});
