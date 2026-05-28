/**
 * SessionHealthBanner Component
 *
 * Dismissible banner that shows error/warning counts from observatory events.
 * Displayed above the message list in ChatPanel.
 */

import { useState, useEffect, useRef } from 'react';
import { AlertTriangle, XCircle, ChevronDown, X } from 'lucide-react';
import clsx from 'clsx';
import { useSessionHealth } from '../../hooks/useSessionHealth';

export function SessionHealthBanner() {
  const { errors, warnings, issues, hasIssues } = useSessionHealth();
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const prevCountRef = useRef(0);

  // Reset dismissed state when issues count changes (up or down)
  useEffect(() => {
    if (issues.length !== prevCountRef.current) {
      prevCountRef.current = issues.length;
      if (issues.length > 0) {
        setDismissed(false);
      }
    }
  }, [issues.length]);

  if (!hasIssues || dismissed) {
    return null;
  }

  const hasErrors = errors > 0;
  const bgClass = hasErrors ? 'bg-error-subtle border-error' : 'bg-warning-subtle border-warning';
  const textClass = hasErrors ? 'text-error' : 'text-warning';

  const summaryParts: string[] = [];
  if (errors > 0) {
    summaryParts.push(`${errors} error${errors !== 1 ? 's' : ''}`);
  }
  if (warnings > 0) {
    summaryParts.push(`${warnings} warning${warnings !== 1 ? 's' : ''}`);
  }
  const summary = `${summaryParts.join(', ')} found during this session`;

  const handleDismiss = () => {
    setDismissed(true);
    setExpanded(false);
  };

  return (
    <div className={clsx('flex-shrink-0 border-b', bgClass)}>
      <div className="px-6 py-2.5">
        {/* Summary row */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className={clsx(
              'flex items-center gap-2 flex-1 text-sm font-medium text-left',
              textClass,
            )}
          >
            {hasErrors ? (
              <XCircle className="w-4 h-4 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            )}
            <span>{summary}</span>
            <ChevronDown
              className={clsx(
                'w-3.5 h-3.5 shrink-0 transition-transform duration-200',
                expanded && 'rotate-180',
              )}
            />
          </button>
          <button
            onClick={handleDismiss}
            className={clsx('p-1 rounded hover:bg-foreground/10 transition-colors', textClass)}
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Expanded issue list */}
        {expanded && (
          <ul className="mt-2 space-y-1 pl-6">
            {issues.map((issue) => (
              <li
                key={`${issue.severity}-${issue.message.slice(0, 50)}`}
                className={clsx('flex items-start gap-2 text-xs', textClass)}
              >
                {issue.severity === 'error' ? (
                  <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                )}
                <span className="break-words">
                  {issue.message.length > 300 ? `${issue.message.slice(0, 300)}...` : issue.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
