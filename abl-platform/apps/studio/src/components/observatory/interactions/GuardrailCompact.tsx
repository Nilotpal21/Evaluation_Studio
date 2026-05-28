/**
 * GuardrailCompact — Single-line compact guardrail format.
 *
 * Used when all checks pass.
 * Example: "Input: PII Check ✓ · Injection Check ✓ · Policy Check ✓"
 */

import { getIntentStyles } from '@agent-platform/design-tokens';
import { Shield } from 'lucide-react';
import clsx from 'clsx';
import { FlowStepContextLine } from './FlowStepContextLine';
import type { InteractionStep } from './types';

interface GuardrailCompactProps {
  step: InteractionStep;
  variant: 'input' | 'output';
}

export function GuardrailCompact({ step, variant }: GuardrailCompactProps) {
  const styles = getIntentStyles('success');

  // Extract check names from events
  const checkNames: string[] = [];
  for (const event of step.events) {
    const name = String(
      event.data.checkType ?? event.data.guardName ?? event.data.name ?? event.type,
    ).replace(/^guardrail_/, '');
    if (name && !checkNames.includes(name)) {
      checkNames.push(name);
    }
  }

  // Fallback to step data
  if (checkNames.length === 0 && step.data.checkType) {
    checkNames.push(String(step.data.checkType));
  }

  const label = variant === 'input' ? 'Input' : 'Output';

  return (
    <div
      className={clsx(
        'rounded-md border px-2.5 py-1.5 text-[10px]',
        styles.border,
        styles.bgSubtle,
      )}
    >
      <div className="flex items-center gap-1.5">
        <Shield className={clsx('w-3 h-3 shrink-0', styles.text)} />
        <span className={clsx('font-medium shrink-0', styles.text)}>{label}:</span>
        <span className="text-foreground-muted">
          {checkNames.length > 0
            ? checkNames.map((name) => `${formatCheckName(name)} ✓`).join(' · ')
            : 'All checks passed ✓'}
        </span>
      </div>
      <FlowStepContextLine step={step} className="mt-1" />
    </div>
  );
}

function formatCheckName(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/Pii/g, 'PII');
}
