/**
 * SessionResolutionFooter — Footer bar showing session outcome.
 *
 * Rendered at the bottom of the interaction list when a
 * session_resolution event is present.
 */

import { useMemo } from 'react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import type { SemanticIntent } from '@agent-platform/design-tokens';
import clsx from 'clsx';
import { formatDuration } from './format-utils';
import type { SessionResolution } from './types';

interface SessionResolutionFooterProps {
  resolution: SessionResolution;
}

function getResolutionIntent(outcome: string): SemanticIntent {
  switch (outcome) {
    case 'completed':
    case 'resolved':
    case 'success':
      return 'success';
    case 'escalated':
    case 'timeout':
      return 'warning';
    case 'abandoned':
    case 'failed':
    case 'error':
      return 'error';
    default:
      return 'info';
  }
}

function getResolutionIcon(outcome: string): string {
  switch (outcome) {
    case 'completed':
    case 'resolved':
    case 'success':
      return '\u2713';
    case 'escalated':
      return '\u2B06';
    case 'abandoned':
    case 'failed':
    case 'error':
      return '\u2715';
    default:
      return '\u2022';
  }
}

export function SessionResolutionFooter({ resolution }: SessionResolutionFooterProps) {
  const intent = useMemo(() => getResolutionIntent(resolution.outcome), [resolution.outcome]);
  const styles = getIntentStyles(intent);
  const icon = getResolutionIcon(resolution.outcome);

  return (
    <div
      className={clsx(
        'mx-3 mt-2 mb-1 px-3 py-2 rounded-md border text-xs',
        styles.border,
        styles.bgSubtle,
      )}
    >
      <div className="flex items-center gap-2">
        <span className={clsx('font-medium', styles.text)}>
          {icon} Session {resolution.outcome}
        </span>

        {resolution.finalAgent && (
          <>
            <span className="text-foreground-subtle">&middot;</span>
            <span className="text-foreground-muted font-mono text-[10px]">
              {resolution.finalAgent}
            </span>
          </>
        )}

        {resolution.durationMs != null && (
          <>
            <span className="text-foreground-subtle">&middot;</span>
            <span className="text-foreground-muted font-mono text-[10px]">
              {formatDuration(resolution.durationMs)}
            </span>
          </>
        )}

        {resolution.reason && (
          <>
            <span className="text-foreground-subtle">&middot;</span>
            <span className="text-foreground-subtle text-[10px]">{resolution.reason}</span>
          </>
        )}
      </div>
    </div>
  );
}
