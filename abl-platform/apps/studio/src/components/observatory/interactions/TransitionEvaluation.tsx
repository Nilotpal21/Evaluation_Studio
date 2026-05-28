/**
 * TransitionEvaluation — Transition condition evaluation display.
 *
 * Design spec Section 10.2.4. Shows each condition that was evaluated
 * for flow step transitions with TRUE/FALSE results and runtime values.
 */

import { useMemo } from 'react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import clsx from 'clsx';
import type { InteractionStep } from './types';

interface ConditionResult {
  expression: string;
  result: boolean;
  runtimeValue?: string;
  note?: string;
}

interface TransitionEvaluationProps {
  step: InteractionStep;
}

export function TransitionEvaluation({ step }: TransitionEvaluationProps) {
  const styles = getIntentStyles('warning');

  const { conditions, fromStep, toStep, outcome } = useMemo(() => extractConditions(step), [step]);

  if (conditions.length === 0) return null;

  return (
    <div
      className={clsx('rounded-md border text-xs overflow-hidden', styles.border, styles.bgSubtle)}
    >
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-border-muted">
        <span className="text-foreground-subtle">→ Evaluating: </span>
        <span className="text-foreground font-medium">
          {fromStep || '?'} → {toStep || '?'}
        </span>
      </div>

      {/* Condition rows */}
      <div className="px-3 py-1.5 space-y-1">
        {conditions.map((cond, i) => (
          <div key={i} className="flex items-center gap-2 font-mono text-[10px]">
            <span className="text-foreground-muted flex-1 truncate">{cond.expression}</span>
            <span
              className={clsx(
                'font-semibold shrink-0 px-1.5 py-0.5 rounded text-[9px]',
                cond.result ? 'bg-success/[0.12] text-success' : 'bg-error/[0.12] text-error',
              )}
            >
              {cond.result ? 'TRUE' : 'FALSE'}
            </span>
            {cond.runtimeValue ? (
              <span className="text-foreground-subtle truncate max-w-32">{cond.runtimeValue}</span>
            ) : null}
            {cond.note ? (
              <span className="text-foreground-subtle opacity-60 italic">{cond.note}</span>
            ) : null}
          </div>
        ))}
      </div>

      {/* Outcome */}
      {outcome ? (
        <div className="px-3 py-1.5 border-t border-border-muted text-[10px] text-foreground-subtle">
          → {outcome}
        </div>
      ) : null}
    </div>
  );
}

function extractConditions(step: InteractionStep): {
  conditions: ConditionResult[];
  fromStep: string;
  toStep: string;
  outcome: string;
} {
  const fromStep = String(step.data.fromStep ?? step.data.previousStep ?? '');
  const toStep = String(step.data.toStep ?? step.data.nextStep ?? step.data.step ?? '');
  const conditions: ConditionResult[] = [];

  // Check step data for conditions
  const rawConditions = step.data.conditions as
    | Array<{ expression: string; result: boolean; value?: unknown; note?: string }>
    | undefined;

  if (rawConditions) {
    for (const cond of rawConditions) {
      conditions.push({
        expression: cond.expression,
        result: cond.result,
        runtimeValue: cond.value != null ? String(cond.value) : undefined,
        note: cond.note,
      });
    }
  }

  // Fallback: check events
  if (conditions.length === 0) {
    for (const event of step.events) {
      const eventConds = event.data.conditions as
        | Array<{ expression: string; result: boolean; value?: unknown; note?: string }>
        | undefined;
      if (eventConds) {
        for (const cond of eventConds) {
          conditions.push({
            expression: cond.expression,
            result: cond.result,
            runtimeValue: cond.value != null ? String(cond.value) : undefined,
            note: cond.note,
          });
        }
      }
    }
  }

  const allTrue = conditions.length > 0 && conditions.every((c) => c.result);
  const outcome = toStep
    ? allTrue
      ? `Advance to ${toStep} (required fields satisfied)`
      : `Waiting for conditions (${conditions.filter((c) => !c.result).length} unmet)`
    : '';

  return { conditions, fromStep, toStep, outcome };
}
