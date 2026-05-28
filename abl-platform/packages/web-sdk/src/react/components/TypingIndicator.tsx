'use client';

/**
 * TypingIndicator — Animated dots with localized label.
 */

import React, { useEffect } from 'react';
import { useStrings } from '../strings/StringsProvider.js';
import * as styles from './sdk-styles.js';

export function TypingIndicator(): React.ReactElement {
  const strings = useStrings();

  useEffect(() => {
    styles.injectKeyframes();
  }, []);

  return React.createElement(
    'div',
    { style: styles.typingContainer, 'data-testid': 'typing-indicator' },
    React.createElement(
      'div',
      { style: styles.typingDots },
      React.createElement('span', {
        style: { ...styles.typingDot, animationDelay: '0s' },
      }),
      React.createElement('span', {
        style: { ...styles.typingDot, animationDelay: '0.16s' },
      }),
      React.createElement('span', {
        style: { ...styles.typingDot, animationDelay: '0.32s' },
      }),
    ),
    React.createElement('span', null, strings.typingIndicator),
  );
}

export function StatusIndicator({ text }: { text: string }): React.ReactElement {
  return React.createElement(
    'div',
    {
      style: styles.statusIndicatorContainer,
      'data-testid': 'status-indicator',
      role: 'status',
      'aria-live': 'polite',
    },
    text,
  );
}
