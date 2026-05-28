/**
 * useSessionHealth Hook
 *
 * Derives session health (errors/warnings) from observatory events.
 * Same data source as ErrorsTab, but returns a summary for banner display.
 */

import { useMemo } from 'react';
import { useObservatoryStore } from '../store/observatory-store';
import { getBannerEligibleConfigurationDiagnostic } from '../utils/configuration-trace-events';

export interface SessionIssue {
  severity: 'error' | 'warning';
  message: string;
}

export interface SessionHealth {
  errors: number;
  warnings: number;
  issues: SessionIssue[];
  hasIssues: boolean;
}

export function useSessionHealth(): SessionHealth {
  const events = useObservatoryStore((s) => s.events);

  return useMemo(() => {
    const issues: SessionIssue[] = [];

    for (const event of events) {
      const source = typeof event.data?.source === 'string' ? event.data.source : undefined;
      if (source === 'session_health') {
        if (event.type === 'error') {
          const message =
            typeof event.data?.message === 'string'
              ? event.data.message
              : typeof event.data?.error === 'string'
                ? event.data.error
                : 'Unknown error occurred';
          issues.push({ severity: 'error', message });
        } else if (event.type === 'warning') {
          const message =
            typeof event.data?.message === 'string'
              ? event.data.message
              : typeof event.data?.warning === 'string'
                ? event.data.warning
                : 'Unknown warning';
          issues.push({ severity: 'warning', message });
        } else if (event.metadata?.severity === 'error' || event.metadata?.severity === 'warn') {
          const message =
            typeof event.data?.message === 'string'
              ? event.data.message
              : `${event.type} event with ${event.metadata.severity} severity`;
          issues.push({
            severity: event.metadata.severity === 'error' ? 'error' : 'warning',
            message,
          });
        } else if (event.type === 'constraint_check' && event.data.passed === false) {
          const constraint =
            typeof event.data?.constraint === 'string'
              ? event.data.constraint
              : typeof event.data?.condition === 'string'
                ? event.data.condition
                : 'unknown';
          const suffix = typeof event.data?.message === 'string' ? ` — ${event.data.message}` : '';
          issues.push({
            severity: 'warning',
            message: `Constraint failed: ${constraint}${suffix}`,
          });
        }
        continue;
      }

      const diagnostic = getBannerEligibleConfigurationDiagnostic(event);
      if (diagnostic) {
        issues.push({
          severity: diagnostic.severity,
          message: diagnostic.message,
        });
      }
    }

    const errors = issues.filter((i) => i.severity === 'error').length;
    const warnings = issues.filter((i) => i.severity === 'warning').length;

    return {
      errors,
      warnings,
      issues,
      hasIssues: issues.length > 0,
    };
  }, [events]);
}
