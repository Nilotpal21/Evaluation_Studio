/**
 * VariableResolution — Template variable resolution trail.
 *
 * Design spec Section 10.2.3. Shows how {{variable}} patterns
 * in DSL resolved to actual runtime values with source attribution.
 */

import { useMemo } from 'react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import clsx from 'clsx';
import type { InteractionStep } from './types';

interface VariableEntry {
  variable: string;
  resolvedValue: string;
  source: string;
}

interface VariableResolutionProps {
  step: InteractionStep;
}

export function VariableResolution({ step }: VariableResolutionProps) {
  const styles = getIntentStyles('warning');

  const variables = useMemo(() => extractVariables(step), [step]);

  if (variables.length === 0) return null;

  return (
    <div
      className={clsx('rounded-md border text-xs overflow-hidden', styles.border, styles.bgSubtle)}
    >
      <div className="px-3 py-1.5 border-b border-border-muted">
        <span className={clsx('font-medium', styles.text)}>Variable Resolution</span>
      </div>

      <div className="px-3 py-1.5 space-y-1">
        {variables.map((v) => (
          <div key={v.variable} className="flex items-baseline gap-2 font-mono text-[10px]">
            <span className="text-warning shrink-0">{`{{${v.variable}}}`}</span>
            <span className="text-foreground-subtle">→</span>
            <span className="text-foreground truncate">{`"${v.resolvedValue}"`}</span>
            <span className="text-foreground-subtle opacity-60 shrink-0 ml-auto">{v.source}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function extractVariables(step: InteractionStep): VariableEntry[] {
  const entries: VariableEntry[] = [];

  // Check step data for variable resolutions
  const resolutions = step.data.variableResolutions as
    | Record<string, { value: unknown; source?: string }>
    | undefined;

  if (resolutions) {
    for (const [variable, info] of Object.entries(resolutions)) {
      entries.push({
        variable,
        resolvedValue: String(info.value ?? ''),
        source: info.source ?? 'context',
      });
    }
    return entries;
  }

  // Fallback: check individual events
  for (const event of step.events) {
    const vars = event.data.variableResolutions as
      | Record<string, { value: unknown; source?: string }>
      | undefined;
    if (vars) {
      for (const [variable, info] of Object.entries(vars)) {
        if (!entries.some((e) => e.variable === variable)) {
          entries.push({
            variable,
            resolvedValue: String(info.value ?? ''),
            source: info.source ?? 'context',
          });
        }
      }
    }
  }

  return entries;
}
