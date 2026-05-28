'use client';

/**
 * StreamingMessage — Displays animated streaming text with a blinking cursor.
 */

import React, { useEffect } from 'react';
import { MarkdownContent } from './MarkdownContent.js';
import * as styles from './sdk-styles.js';

interface StreamingMessageProps {
  /** Current accumulated content */
  content: string;
  /** Whether streaming is still in progress */
  isStreaming: boolean;
}

export function StreamingMessage({
  content,
  isStreaming,
}: StreamingMessageProps): React.ReactElement {
  useEffect(() => {
    styles.injectKeyframes();
  }, []);

  return React.createElement(
    'div',
    { style: styles.streamingContainer, 'data-testid': 'streaming-message' },
    React.createElement(MarkdownContent, { content }),
    isStreaming ? React.createElement('span', { style: styles.streamingCursor }) : null,
  );
}
