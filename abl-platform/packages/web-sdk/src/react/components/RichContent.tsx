/**
 * RichContent React Dispatcher
 *
 * Renders all matched template renderers for a message using the default registry.
 * Emits `template:action` custom events on document for label-aware consumers.
 */

import React from 'react';
import type { ActionSubmitOptions, Message } from '../../core/types.js';
import { defaultRegistry } from '../../templates/index.js';
import type { TemplateContext } from '../../templates/types.js';

export interface RichContentProps {
  message: Message;
  onAction: (actionId: string, value?: string, options?: ActionSubmitOptions) => void;
  theme?: Record<string, string>;
  /**
   * Feedback submission callback (ABLP-1068). When provided, templates that
   * support feedback (the rich-feedback renderer) submit via this callback
   * instead of `onAction('feedback', ...)`. The owning component is
   * responsible for binding `messageId` + `actionRenderId` in the closure —
   * RichContent stays pure (no hooks, no SDK coupling).
   */
  submitFeedback?: (input: {
    ratingType: 'thumbs' | 'star' | 'text';
    ratingValue: number;
    feedbackText?: string;
  }) => Promise<{ feedbackId: string }>;
}

export function RichContent({
  message,
  onAction,
  theme,
  submitFeedback,
}: RichContentProps): React.ReactElement | null {
  const matches = defaultRegistry.match(message);
  if (matches.length === 0) return null;

  const ctx: TemplateContext = {
    theme: theme ?? {},
    messageId: message.id,
    actionRenderId: message.actions?.renderId,
    ...(submitFeedback ? { submitFeedback } : {}),
    onAction: (
      actionId: string,
      value?: string,
      actionOptions?: ActionSubmitOptions & { label?: string },
    ) => {
      const { label, ...submitOptions } = actionOptions ?? {};
      if (Object.keys(submitOptions).length > 0) {
        onAction(actionId, value, submitOptions);
      } else {
        onAction(actionId, value);
      }
      document.dispatchEvent(
        new CustomEvent('template:action', {
          detail: { actionId, value, label, messageId: message.id },
        }),
      );
    },
  };

  return React.createElement(
    'div',
    { className: 'rich-content' },
    matches.map(({ renderer, data }, i) => {
      try {
        return React.createElement(
          'div',
          { key: `${renderer.type}-${i}` },
          renderer.render(data, ctx),
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[rich-content] renderer "${renderer.type}" failed:`, err);
        return null;
      }
    }),
  );
}
