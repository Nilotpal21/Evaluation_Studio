/**
 * Template Registry Types
 *
 * Defines the interface for pluggable rich content template renderers.
 */

import type { ActionSubmitOptions, Message } from '../core/types.js';

/**
 * Context passed to every template renderer at render time.
 */
export interface TemplateContext {
  /** Theme overrides — empty record for Phase 1 */
  theme: Record<string, string>;
  /** Callback invoked when the user interacts with an action element */
  onAction: (
    actionId: string,
    value?: string,
    options?: ActionSubmitOptions & { label?: string },
  ) => void;
  /** ID of the message being rendered */
  messageId: string;
  /**
   * Runtime-issued correlation id for the current rendered action surface.
   * Template renderers that own their own buttons/forms should echo this on submit.
   */
  actionRenderId?: string;
  /**
   * Feedback submission callback (ABLP-1068). When present, the rich-feedback
   * renderer prefers this over `onAction('feedback', ...)` so the runtime
   * receives a structured `feedback.submit` (or the action_submit
   * short-circuit path) instead of a generic action.
   *
   * Input is rating-data only — `messageId` and `actionRenderId` are bound
   * by the closure at the threading site (RichContent / MessageList /
   * vanilla mounter), which is where the owning component connects the
   * renderer to the active ChatClient and the message being rated.
   *
   * Renderers SHOULD fall back to `ctx.onAction('feedback', ...)` when this
   * callback is undefined so older consumers keep working.
   */
  submitFeedback?: (input: {
    ratingType: 'thumbs' | 'star' | 'text';
    ratingValue: number;
    feedbackText?: string;
  }) => Promise<{ feedbackId: string }>;
}

/**
 * A pluggable renderer for a specific rich content type.
 *
 * @typeParam T - The data shape this renderer extracts from a Message.
 */
export interface TemplateRenderer<T = unknown> {
  /** Unique type identifier for this renderer (e.g. 'markdown', 'carousel') */
  type: string;
  /**
   * Extract renderable data from a message.
   * Return `undefined` if this renderer does not apply to the message.
   */
  extract(message: Message): T | undefined;
  /**
   * Render the extracted data as a React element.
   */
  render(data: T, ctx: TemplateContext): React.ReactElement;
  /**
   * Render the extracted data as a DOM element (for non-React consumers).
   */
  renderDOM(data: T, ctx: TemplateContext): HTMLElement;
}
