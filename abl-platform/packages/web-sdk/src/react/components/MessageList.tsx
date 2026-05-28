'use client';

/**
 * MessageList — Role-based message dispatch renderer.
 *
 * Renders user bubbles, assistant bubbles with markdown + rich content + actions,
 * thought cards, handoff messages, and error messages.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { ActionSubmitOptions, Message, MessageMetadata } from '../../core/types.js';
import { CitationList } from './CitationList.js';
import { MarkdownContent } from './MarkdownContent.js';
import { RichContent } from './RichContent.js';
import { ThoughtCard } from './ThoughtCard.js';
import { HandoffMessage } from './HandoffMessage.js';
import { ErrorMessage } from './ErrorMessage.js';
import { StreamingMessage } from './StreamingMessage.js';
import { MessageFeedbackControls } from './MessageFeedbackControls.js';
import * as styles from './sdk-styles.js';

const noopActionHandler = (): void => {};

type SubmitFeedback = (input: {
  messageId: string;
  ratingType: 'thumbs' | 'star' | 'text';
  ratingValue: number;
  feedbackText?: string;
  actionRenderId?: string;
}) => Promise<{ feedbackId: string }>;

type RichFeedbackInput = {
  ratingType: 'thumbs' | 'star' | 'text';
  ratingValue: number;
  feedbackText?: string;
};

export interface MessageListProps {
  /** Array of messages to render */
  messages: Message[];
  /** Current streaming content (shown below committed messages) */
  streamingContent?: string;
  /** Whether a response is currently streaming */
  isStreaming?: boolean;
  /** Whether channel/session activity updates should be shown */
  showActivityUpdates?: boolean;
  /** Callback when an action button/select/input is triggered */
  onAction?: (actionId: string, value?: string, options?: ActionSubmitOptions) => void;
  /** Callback when a rich feedback template submits a rating */
  submitFeedback?: SubmitFeedback;
  /** Render thumbs feedback controls under each assistant message */
  enableFeedback?: boolean;
  /** Callback when "View trace" is clicked on a thought card */
  onViewTrace?: (metadata: MessageMetadata) => void;
  /** Custom thought card renderer (overrides default ThoughtCard) */
  renderThoughtCard?: (message: Message) => React.ReactNode;
}

/**
 * Tracks expanded state for thought cards by message ID.
 * Uses a bounded Map via the message list length.
 */
function useExpandedMap() {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const toggle = useCallback((id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const isExpanded = useCallback((id: string) => expandedIds[id] === true, [expandedIds]);

  return { toggle, isExpanded };
}

export function MessageList({
  messages,
  streamingContent,
  isStreaming,
  showActivityUpdates = true,
  onAction,
  submitFeedback,
  enableFeedback = false,
  onViewTrace,
  renderThoughtCard,
}: MessageListProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const { toggle, isExpanded } = useExpandedMap();

  // Auto-scroll to bottom on new messages or streaming
  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, streamingContent]);

  const renderMessage = (msg: Message): React.ReactNode => {
    // Thought role → ThoughtCard
    if (msg.role === 'thought') {
      if (!showActivityUpdates) {
        return null;
      }
      if (renderThoughtCard) return renderThoughtCard(msg);
      return React.createElement(ThoughtCard, {
        key: msg.id,
        content: msg.content,
        toolLabel: msg.metadata?.toolName,
        isExpanded: isExpanded(msg.id),
        onToggle: () => toggle(msg.id),
        onViewTrace,
        metadata: msg.metadata,
      });
    }

    // System role — check for error
    if (msg.role === 'system') {
      if (msg.metadata?.errorCode || msg.metadata?.severity) {
        return React.createElement(ErrorMessage, {
          key: msg.id,
          content: msg.content,
          severity: msg.metadata?.severity ?? 'error',
        });
      }

      // Handoff message
      if (msg.metadata?.handoffFrom || msg.metadata?.handoffTo) {
        if (!showActivityUpdates) {
          return null;
        }
        return React.createElement(HandoffMessage, {
          key: msg.id,
          fromAgent: msg.metadata?.handoffFrom as string | undefined,
          toAgent: msg.metadata?.handoffTo as string | undefined,
        });
      }

      // Generic system message
      return React.createElement('div', { key: msg.id, style: styles.systemMessage }, msg.content);
    }

    // User role
    if (msg.role === 'user') {
      return React.createElement('div', { key: msg.id, style: styles.userBubble }, msg.content);
    }

    // Assistant role — markdown + structured output
    const actionHandler = onAction ?? noopActionHandler;
    // Pass citations to MarkdownContent — it injects pills AFTER markdown
    // rendering (so they don't get HTML-escaped by the markdown escaper).
    const children: React.ReactNode[] = [
      React.createElement(MarkdownContent, {
        key: 'md',
        content: msg.content,
        citations: msg.citations,
      }),
    ];

    if (msg.richContent || msg.actions) {
      const renderId = msg.actions?.renderId;
      children.push(
        React.createElement(RichContent, {
          key: 'rich',
          message: msg,
          onAction: actionHandler,
          ...(submitFeedback
            ? {
                submitFeedback: (input: RichFeedbackInput) =>
                  submitFeedback({
                    messageId: msg.id,
                    ...input,
                    ...(renderId ? { actionRenderId: renderId } : {}),
                  }),
              }
            : {}),
        }),
      );
    }

    if (msg.citations?.length) {
      children.push(
        React.createElement(CitationList, { key: 'citations', citations: msg.citations }),
      );
    }

    if (enableFeedback && submitFeedback && !msg.richContent?.feedback) {
      children.push(
        React.createElement(MessageFeedbackControls, {
          key: 'message-feedback',
          messageId: msg.id,
          submitFeedback,
        }),
      );
    }

    return React.createElement('div', { key: msg.id, style: styles.assistantBubble }, ...children);
  };

  return React.createElement(
    'div',
    { ref: containerRef, style: styles.messageListContainer, 'data-testid': 'message-list' },
    messages.map(renderMessage),
    streamingContent || isStreaming
      ? React.createElement(StreamingMessage, {
          key: '__streaming__',
          content: streamingContent ?? '',
          isStreaming: isStreaming ?? false,
        })
      : null,
  );
}
