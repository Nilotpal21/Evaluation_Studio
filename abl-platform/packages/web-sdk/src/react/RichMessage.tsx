/**
 * RichMessage - React component for rendering rich content messages
 *
 * @deprecated Use MarkdownContent + RichContent + ActionHandler from
 * `@agent-platform/web-sdk/react` instead. This component delegates to
 * MarkdownContent internally for backwards compatibility.
 *
 * Renders a Message's richContent (markdown, HTML, carousel) and actions
 * (buttons, selects, inputs) with action callbacks wired to the ChatClient.
 */

import React, { useRef, useEffect } from 'react';
import type { Message } from '../core/types.js';
import type { ChatClient } from '../chat/ChatClient.js';
import { hasRichContent, renderRichMessage } from '../ui/rich-renderer.js';
import { createActionHandler } from '../ui/action-handler.js';

interface RichMessageProps {
  message: Message;
  chat: ChatClient | null;
  className?: string;
}

/**
 * Renders a message with rich content (markdown, HTML, carousel, actions).
 * Falls back to plain text if no rich content is present.
 *
 * @deprecated Use MarkdownContent + RichContent + ActionHandler from
 * `@agent-platform/web-sdk/react` instead. This wrapper is kept for
 * backwards compatibility and delegates to the DOM-based renderer.
 *
 * @example
 * const { messages, chat } = useChat();
 * return messages.map(msg => (
 *   <RichMessage key={msg.id} message={msg} chat={chat} />
 * ));
 */
export function RichMessage({ message, chat, className }: RichMessageProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Clear previous content
    el.innerHTML = '';

    if (message.role === 'assistant' && hasRichContent(message)) {
      const renderId = message.actions?.renderId;
      renderRichMessage(el, message, {
        onAction: createActionHandler(chat),
        submitFeedback: (input) =>
          chat
            ? chat.submitFeedback({
                messageId: message.id,
                ...input,
                ...(renderId ? { actionRenderId: renderId } : {}),
              })
            : Promise.reject(
                Object.assign(new Error('Chat client not initialized'), {
                  code: 'NOT_CONNECTED',
                }),
              ),
      });
    } else {
      el.textContent = message.content;
    }
  }, [message, chat]);

  const baseClass = `message ${message.role}`;
  const richClass = message.role === 'assistant' && hasRichContent(message) ? ' rich' : '';
  const extraClass = className ? ` ${className}` : '';

  return React.createElement('div', {
    ref: containerRef,
    className: `${baseClass}${richClass}${extraClass}`,
    'data-id': message.id,
  });
}
