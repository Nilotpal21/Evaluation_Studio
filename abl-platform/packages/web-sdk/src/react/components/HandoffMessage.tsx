'use client';

/**
 * HandoffMessage — Agent routing indicator.
 *
 * Displays "Routing from <A> to <B>" using the strings provider.
 */

import React, { useState } from 'react';
import { HandoffIcon } from './icons.js';
import { useStrings } from '../strings/StringsProvider.js';
import * as styles from './sdk-styles.js';

interface HandoffMessageProps {
  /** Source agent name */
  fromAgent?: string;
  /** Target agent name */
  toAgent?: string;
}

export function HandoffMessage({ fromAgent, toAgent }: HandoffMessageProps): React.ReactElement {
  const strings = useStrings();
  const [expanded, setExpanded] = useState(false);

  const text = strings.handoffMessage
    .replace('{from}', fromAgent ?? '?')
    .replace('{to}', toAgent ?? '?');

  const summary = strings.handoffSummary
    .replace('{from}', fromAgent ?? '?')
    .replace('{to}', toAgent ?? '?');

  return React.createElement(
    'div',
    { style: styles.handoffMessage, 'data-testid': 'handoff-message' },
    React.createElement(
      'button',
      {
        type: 'button',
        style: styles.handoffMessageButton,
        onClick: () => setExpanded((current) => !current),
        'aria-expanded': expanded,
      },
      React.createElement(HandoffIcon, null),
      React.createElement('span', null, summary),
      React.createElement(
        'span',
        { style: styles.handoffMessageChevron },
        expanded ? strings.handoffHideDetails : strings.handoffShowDetails,
      ),
    ),
    expanded ? React.createElement('div', { style: styles.handoffMessageDetail }, text) : null,
  );
}
