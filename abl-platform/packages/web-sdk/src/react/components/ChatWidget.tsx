'use client';

/**
 * ChatWidget — Composes MessageList + ChatInput + TypingIndicator + StreamingMessage.
 *
 * Reads chat state from the AgentProvider context (useChat hook).
 * Wraps in SDKThemeProvider + StringsProvider when used standalone.
 *
 * This is the React ChatWidget. The Web Component ChatWidget lives at
 * the root `@agent-platform/web-sdk` entry point — different entry points,
 * no runtime conflict.
 */

import React, { useCallback, useMemo } from 'react';
import { useChat } from '../AgentProvider.js';
import { SDKThemeProvider } from '../theme/ThemeProvider.js';
import { StringsProvider } from '../strings/StringsProvider.js';
import { MessageList } from './MessageList.js';
import { ChatInput } from './ChatInput.js';
import { StatusIndicator, TypingIndicator } from './TypingIndicator.js';
import { createActionHandler } from '../../ui/action-handler.js';
import * as styles from './sdk-styles.js';
import type { SDKTheme } from '../theme/types.js';
import type { SDKStrings } from '../strings/types.js';
import type { ActionSubmitOptions, MessageMetadata } from '../../core/types.js';

type SubmitFeedback = (input: {
  messageId: string;
  ratingType: 'thumbs' | 'star' | 'text';
  ratingValue: number;
  feedbackText?: string;
  actionRenderId?: string;
}) => Promise<{ feedbackId: string }>;

export interface ChatWidgetProps {
  /** Theme overrides */
  theme?: Partial<SDKTheme>;
  /** String overrides for localization */
  strings?: Partial<SDKStrings>;
  /** Render fully wired thumbs feedback controls under each assistant message */
  enableFeedback?: boolean;
  /** Callback to upload a file and return its attachment ID */
  onUploadFile?: (file: File) => Promise<string>;
  /** Callback when "View trace" is clicked on a thought card */
  onViewTrace?: (metadata: MessageMetadata) => void;
  /** Callback when an action button/select/input is triggered */
  onAction?: (actionId: string, value?: string, options?: ActionSubmitOptions) => void;
}

export function ChatWidget({
  theme,
  strings,
  enableFeedback = false,
  onUploadFile,
  onViewTrace,
  onAction,
}: ChatWidgetProps): React.ReactElement {
  const {
    chat,
    messages,
    chatActivity,
    sendMessage,
    isConnected,
    streamingContent,
    isStreaming,
    showActivityUpdates,
  } = useChat();

  const handleSend = useCallback(
    (text: string, attachmentIds?: string[]) => {
      // sendMessage returns a Promise; fire-and-forget — errors surface via AgentProvider.
      void sendMessage(text, attachmentIds ? { attachmentIds } : undefined);
    },
    [sendMessage],
  );

  const handleAction = useMemo(() => onAction ?? createActionHandler(chat), [chat, onAction]);
  const submitFeedback = useCallback<SubmitFeedback>(
    (input) =>
      chat
        ? chat.submitFeedback(input)
        : Promise.reject(
            Object.assign(new Error('Chat client not initialized'), {
              code: 'NOT_CONNECTED',
            }),
          ),
    [chat],
  );

  const content = React.createElement(
    'div',
    { style: styles.chatContainer, 'data-testid': 'chat-widget' },
    React.createElement(MessageList, {
      messages,
      streamingContent,
      isStreaming,
      showActivityUpdates,
      onAction: handleAction,
      submitFeedback,
      enableFeedback,
      onViewTrace,
    }),
    chatActivity.kind === 'typing' ? React.createElement(TypingIndicator, null) : null,
    chatActivity.kind === 'status'
      ? React.createElement(StatusIndicator, { text: chatActivity.message })
      : null,
    React.createElement(ChatInput, {
      onSend: handleSend,
      onUploadFile,
      disabled: !isConnected,
    }),
  );

  // Wrap in theme + strings providers
  return React.createElement(
    SDKThemeProvider,
    { theme },
    React.createElement(StringsProvider, { strings }, content),
  );
}
