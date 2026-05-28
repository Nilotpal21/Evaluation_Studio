/**
 * RetryBadge — Retry step visualization.
 *
 * Design spec Section 11.1. Shows: attempt count, backoff duration,
 * outcome, and full tool I/O for the retry.
 */

import { useState } from 'react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import { ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import type { InteractionStep } from './types';

interface RetryBadgeProps {
  step: InteractionStep;
}

export function RetryBadge({ step }: RetryBadgeProps) {
  const [showDetails, setShowDetails] = useState(false);
  const styles = getIntentStyles('warning');

  const attempt = step.data.attempt ?? '?';
  const maxRetries = step.data.maxRetries ?? '?';
  const backoffMs = Number(step.data.backoffMs ?? 0);
  const succeeded = step.events.some((e) => e.data.status === 'success' || e.data.result != null);

  return (
    <div
      className={clsx('rounded-md border text-xs overflow-hidden', styles.border, styles.bgSubtle)}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className={clsx('font-semibold', styles.text)}>
          RETRY {String(attempt)}/{String(maxRetries)}
        </span>
        {backoffMs > 0 && (
          <span className="text-foreground-subtle font-mono">
            backoff: {backoffMs < 1000 ? `${backoffMs}ms` : `${(backoffMs / 1000).toFixed(1)}s`}
          </span>
        )}
        <span className="text-foreground-subtle">→</span>
        <span className={clsx('font-medium', succeeded ? 'text-success' : 'text-error')}>
          {succeeded ? 'success on retry' : 'still failing'}
        </span>

        <div className="flex-1" />

        <button
          onClick={() => setShowDetails(!showDetails)}
          className="text-foreground-muted hover:text-foreground"
        >
          {showDetails ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
      </div>

      {/* Expanded details */}
      {showDetails && step.events.length > 0 && (
        <div className="px-3 pb-2 space-y-1">
          {step.events.map((event) => (
            <div
              key={event.id}
              className="bg-background-elevated rounded p-1.5 text-[9px] font-mono text-foreground-subtle max-h-24 overflow-y-auto"
            >
              {JSON.stringify(event.data, null, 2)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
