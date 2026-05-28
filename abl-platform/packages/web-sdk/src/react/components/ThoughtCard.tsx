'use client';

/**
 * ThoughtCard — Collapsible thought/reasoning card.
 *
 * Shows tool name, expandable reasoning content, and optional "View trace" link.
 */

import React, { useEffect } from 'react';
import { ThoughtIcon, ExpandIcon, CollapseIcon } from './icons.js';
import { useStrings } from '../strings/StringsProvider.js';
import * as styles from './sdk-styles.js';
import type { MessageMetadata } from '../../core/types.js';

interface ThoughtCardProps {
  /** Thought/reasoning content */
  content: string;
  /** Tool name label */
  toolLabel?: string;
  /** Whether the card body is expanded */
  isExpanded: boolean;
  /** Whether the agent is currently thinking (shows animated icon) */
  isThinking?: boolean;
  /** Toggle expand/collapse */
  onToggle: () => void;
  /** Optional callback to view trace details */
  onViewTrace?: (metadata: MessageMetadata) => void;
  /** Message metadata (passed to onViewTrace) */
  metadata?: MessageMetadata;
}

export function ThoughtCard({
  content,
  toolLabel,
  isExpanded,
  isThinking,
  onToggle,
  onViewTrace,
  metadata,
}: ThoughtCardProps): React.ReactElement {
  const strings = useStrings();

  useEffect(() => {
    styles.injectKeyframes();
  }, []);

  const headerChildren = [
    React.createElement(ThoughtIcon, {
      key: 'icon',
      style: isThinking ? { animation: 'sdk-blink 1s step-end infinite' } : undefined,
    }),
    React.createElement(
      'span',
      { key: 'label' },
      toolLabel ?? (isThinking ? strings.thinking : strings.expandThought),
    ),
    React.createElement(
      'span',
      { key: 'toggle', style: { marginLeft: 'auto' } },
      isExpanded ? React.createElement(CollapseIcon, null) : React.createElement(ExpandIcon, null),
    ),
  ];

  const bodyChildren: React.ReactNode[] = [];

  if (isExpanded) {
    bodyChildren.push(
      React.createElement('div', { key: 'body', style: styles.thoughtCardBody }, content),
    );

    if (onViewTrace && metadata) {
      bodyChildren.push(
        React.createElement(
          'div',
          { key: 'footer', style: styles.thoughtCardFooter },
          React.createElement(
            'button',
            {
              type: 'button',
              style: styles.viewTraceLink,
              onClick: () => onViewTrace(metadata),
            },
            strings.viewTrace,
          ),
        ),
      );
    }
  }

  return React.createElement(
    'div',
    { style: styles.thoughtCard, 'data-testid': 'thought-card' },
    React.createElement(
      'div',
      {
        style: styles.thoughtCardHeader,
        onClick: onToggle,
        role: 'button',
        tabIndex: 0,
        'aria-expanded': isExpanded,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        },
      },
      ...headerChildren,
    ),
    ...bodyChildren,
  );
}
