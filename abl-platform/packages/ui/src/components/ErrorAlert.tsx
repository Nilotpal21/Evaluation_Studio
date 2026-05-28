'use client';

import { clsx } from 'clsx';
import { XCircle } from 'lucide-react';

interface ErrorAlertProps {
  error: string | string[];
  onDismiss?: () => void;
  className?: string;
}

/**
 * Displays one or more error messages.
 * Single string → inline text. Array → bullet list.
 */
export function ErrorAlert({ error, onDismiss, className }: ErrorAlertProps) {
  const messages = Array.isArray(error) ? error : [error];
  if (messages.length === 0) return null;

  return (
    <div
      role="alert"
      className={clsx(
        'flex items-start gap-2 rounded-lg border border-error/20 bg-error-subtle p-3 text-sm text-error',
        className,
      )}
    >
      <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        {messages.length === 1 ? (
          <span>{messages[0]}</span>
        ) : (
          <ul className="list-disc pl-4 space-y-0.5">
            {messages.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 p-0.5 rounded hover:bg-error/10 transition-fast"
          aria-label="Dismiss"
        >
          <XCircle className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
