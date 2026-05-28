'use client';

/**
 * ErrorMessage — Severity-styled error/warning display.
 */

import React from 'react';
import { ErrorIcon } from './icons.js';
import { useStrings } from '../strings/StringsProvider.js';
import * as styles from './sdk-styles.js';

interface ErrorMessageProps {
  /** Error/warning message content */
  content: string;
  /** Severity level */
  severity?: 'warning' | 'error';
}

export function ErrorMessage({
  content,
  severity = 'error',
}: ErrorMessageProps): React.ReactElement {
  const strings = useStrings();

  const isWarning = severity === 'warning';
  const colorVar = isWarning ? 'var(--sdk-warning, #f59e0b)' : 'var(--sdk-error, #ef4444)';

  const title = isWarning ? strings.warningTitle : strings.errorTitle;

  return React.createElement(
    'div',
    {
      style: {
        ...styles.errorMessage,
        backgroundColor: isWarning ? 'rgba(245, 158, 11, 0.08)' : 'rgba(239, 68, 68, 0.08)',
        border: `1px solid ${colorVar}`,
      },
      'data-testid': 'error-message',
      role: 'alert',
    },
    React.createElement(ErrorIcon, { style: { color: colorVar, flexShrink: 0, marginTop: '2px' } }),
    React.createElement(
      'div',
      null,
      React.createElement(
        'div',
        { style: { fontWeight: 600, color: colorVar, marginBottom: '2px' } },
        title,
      ),
      React.createElement('div', null, content),
    ),
  );
}
