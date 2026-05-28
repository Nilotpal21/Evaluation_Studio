'use client';

import { useState, type MouseEvent } from 'react';
import { Check, Copy } from 'lucide-react';

const COPY_FEEDBACK_MS = 1500;

export function formatSessionIdForDisplay(sessionId?: string | null, prefix = 's-'): string {
  if (!sessionId || sessionId.length === 0) {
    return '--';
  }

  return sessionId.startsWith(prefix) ? sessionId : `${prefix}${sessionId}`;
}

interface SessionIdDisplayProps {
  sessionId?: string | null;
  prefix?: string;
  copyLabel: string;
  copiedLabel?: string;
  copyValue?: string | null;
  copyable?: boolean;
  className?: string;
  valueClassName?: string;
  copyButtonClassName?: string;
  iconClassName?: string;
}

export function SessionIdDisplay({
  sessionId,
  prefix = 's-',
  copyLabel,
  copiedLabel = copyLabel,
  copyValue,
  copyable = true,
  className,
  valueClassName,
  copyButtonClassName,
  iconClassName,
}: SessionIdDisplayProps) {
  const [copied, setCopied] = useState(false);
  const displayId = formatSessionIdForDisplay(sessionId, prefix);
  const copyText = copyValue ?? sessionId ?? undefined;
  const canCopy = copyable && Boolean(copyText);

  const handleCopy = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!copyText || !navigator.clipboard?.writeText) {
      return;
    }

    void navigator.clipboard
      .writeText(copyText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
      })
      .catch(() => {
        setCopied(false);
      });
  };

  return (
    <span className={joinClasses('inline-flex min-w-0 max-w-full items-center gap-1.5', className)}>
      {copyable ? (
        <button
          type="button"
          onClick={handleCopy}
          disabled={!canCopy}
          aria-label={copyLabel}
          title={displayId}
          className={joinClasses(
            'min-w-0 text-left',
            canCopy ? 'cursor-copy' : 'cursor-default',
            !canCopy && 'disabled:opacity-100',
          )}
        >
          <span
            className={joinClasses(
              'block truncate font-mono text-xs text-foreground',
              valueClassName,
            )}
          >
            {displayId}
          </span>
        </button>
      ) : (
        <span
          className={joinClasses(
            'block min-w-0 truncate font-mono text-xs text-foreground',
            valueClassName,
          )}
          title={displayId}
        >
          {displayId}
        </span>
      )}
      {canCopy && (
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copyLabel}
          title={copied ? copiedLabel : copyLabel}
          className={joinClasses(
            'shrink-0 rounded p-0.5 text-muted transition-colors hover:text-foreground',
            copyButtonClassName,
          )}
        >
          {copied ? (
            <Check className={joinClasses('h-3 w-3 text-success', iconClassName)} />
          ) : (
            <Copy className={joinClasses('h-3 w-3', iconClassName)} />
          )}
        </button>
      )}
    </span>
  );
}

function joinClasses(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
