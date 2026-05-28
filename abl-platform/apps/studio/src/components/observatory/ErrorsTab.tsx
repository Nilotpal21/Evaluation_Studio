/**
 * ErrorsTab Component
 *
 * Displays a filtered list of error and warning events from the Observatory trace data.
 * Shows timestamp, severity, code, message, and agent name for each event.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, XCircle, Filter } from 'lucide-react';
import { useObservatoryStore } from '../../store/observatory-store';
import { getBannerEligibleConfigurationDiagnostic } from '../../utils/configuration-trace-events';
import clsx from 'clsx';
import { formatAbsoluteTime } from './format-time';

type SeverityFilter = 'all' | 'error' | 'warning';

interface ErrorEntry {
  id: string;
  timestamp: Date;
  severity: 'error' | 'warning';
  code: string;
  message: string;
  agentName: string;
  details?: Record<string, unknown>;
}

export function ErrorsTab() {
  const events = useObservatoryStore((s) => s.events);
  const [filter, setFilter] = useState<SeverityFilter>('all');

  const errorEntries: ErrorEntry[] = useMemo(() => {
    const entries: ErrorEntry[] = [];

    for (const event of events) {
      const configurationDiagnostic = getBannerEligibleConfigurationDiagnostic(event);
      if (configurationDiagnostic) {
        entries.push({
          id: event.id,
          timestamp: event.timestamp,
          severity: configurationDiagnostic.severity,
          code: configurationDiagnostic.code,
          message: configurationDiagnostic.message,
          agentName: event.agentName || 'unknown',
          details: event.data,
        });
        continue;
      }

      if (event.type === 'error') {
        entries.push({
          id: event.id,
          timestamp: event.timestamp,
          severity: 'error',
          code: (event.data.code as string) || (event.data.errorCode as string) || 'ERR_UNKNOWN',
          message:
            (event.data.message as string) ||
            (event.data.error as string) ||
            'Unknown error occurred',
          agentName: event.agentName || 'unknown',
          details: event.data,
        });
      } else if (event.type === 'warning') {
        entries.push({
          id: event.id,
          timestamp: event.timestamp,
          severity: 'warning',
          code: (event.data.code as string) || (event.data.warningCode as string) || 'WARN',
          message:
            (event.data.message as string) || (event.data.warning as string) || 'Unknown warning',
          agentName: event.agentName || 'unknown',
          details: event.data,
        });
      } else if (event.metadata?.severity === 'error' || event.metadata?.severity === 'warn') {
        entries.push({
          id: event.id,
          timestamp: event.timestamp,
          severity: event.metadata.severity === 'error' ? 'error' : 'warning',
          code: (event.data.code as string) || event.type.toUpperCase(),
          message:
            (event.data.message as string) ||
            `${event.type} event with ${event.metadata.severity} severity`,
          agentName: event.agentName || 'unknown',
          details: event.data,
        });
      } else if (event.type === 'constraint_check' && event.data.passed === false) {
        entries.push({
          id: event.id,
          timestamp: event.timestamp,
          severity: 'warning',
          code: 'CONSTRAINT_FAIL',
          message: `Constraint failed: ${(event.data.constraint as string) || (event.data.condition as string) || 'unknown'}${event.data.message ? ` — ${event.data.message}` : ''}`,
          agentName: event.agentName || 'unknown',
          details: event.data,
        });
      } else if (
        (event.type as string) === 'tool.call.failed' ||
        (event.type as string) === 'tool_call_error' ||
        (event.type === 'tool_call' && event.data.error)
      ) {
        const toolName =
          (event.data.toolName as string) || (event.data.name as string) || 'unknown';
        entries.push({
          id: event.id,
          timestamp: event.timestamp,
          severity: 'error',
          code: 'TOOL_CALL_FAILED',
          message: `Tool "${toolName}" failed: ${(event.data.error as string) || (event.data.message as string) || 'Unknown tool error'}`,
          agentName: event.agentName || 'unknown',
          details: event.data,
        });
      }
    }

    return entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }, [events]);

  const filteredEntries = useMemo(
    () => errorEntries.filter((e) => filter === 'all' || e.severity === filter),
    [errorEntries, filter],
  );

  const errorCount = errorEntries.filter((e) => e.severity === 'error').length;
  const warningCount = errorEntries.filter((e) => e.severity === 'warning').length;

  if (errorEntries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-subtle text-sm gap-2">
        <AlertTriangle className="w-8 h-8 opacity-30" />
        <span>No errors or warnings recorded.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Summary + filter bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-default bg-background-muted">
        <div className="flex items-center gap-3 text-xs text-muted">
          {errorCount > 0 && (
            <span className="flex items-center gap-1">
              <XCircle className="w-3 h-3 text-error" />
              <span className="font-semibold text-error">{errorCount}</span> error
              {errorCount !== 1 ? 's' : ''}
            </span>
          )}
          {warningCount > 0 && (
            <span className="flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 text-warning" />
              <span className="font-semibold text-warning">{warningCount}</span> warning
              {warningCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Filter className="w-3 h-3 text-subtle" />
          {(['all', 'error', 'warning'] as const).map((level) => (
            <button
              key={level}
              onClick={() => setFilter(level)}
              className={clsx(
                'px-2 py-0.5 text-xs rounded',
                filter === level
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted hover:bg-background-elevated',
              )}
            >
              {level}
            </button>
          ))}
        </div>
      </div>

      {/* Error list */}
      <div className="flex-1 overflow-y-auto divide-y divide-default">
        {filteredEntries.map((entry) => (
          <div
            key={entry.id}
            className={clsx(
              'px-3 py-2 text-xs',
              entry.severity === 'error' && 'bg-error-subtle',
              entry.severity === 'warning' && 'bg-warning-subtle',
            )}
          >
            <div className="flex items-center gap-2 mb-1">
              {entry.severity === 'error' ? (
                <XCircle className="w-3.5 h-3.5 text-error shrink-0" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
              )}
              <span
                className={clsx(
                  'font-medium',
                  entry.severity === 'error' ? 'text-error' : 'text-warning',
                )}
              >
                {entry.code}
              </span>
              <span className="text-muted truncate flex-1">{entry.agentName}</span>
              <span className="text-subtle shrink-0">{formatAbsoluteTime(entry.timestamp)}</span>
            </div>
            <div className="text-muted pl-5 break-words">
              {entry.message.length > 200 ? `${entry.message.slice(0, 200)}...` : entry.message}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Hook to get the count of errors+warnings for use in tab badges.
 */
export function useErrorCount(): number {
  const events = useObservatoryStore((s) => s.events);
  return useMemo(() => {
    let count = 0;
    for (const event of events) {
      if (getBannerEligibleConfigurationDiagnostic(event)) {
        count++;
      } else if (event.type === 'error' || event.type === 'warning') {
        count++;
      } else if (event.metadata?.severity === 'error' || event.metadata?.severity === 'warn') {
        count++;
      } else if (event.type === 'constraint_check' && event.data.passed === false) {
        count++;
      } else if (
        (event.type as string) === 'tool.call.failed' ||
        (event.type as string) === 'tool_call_error' ||
        (event.type === 'tool_call' && event.data.error)
      ) {
        count++;
      }
    }
    return count;
  }, [events]);
}
