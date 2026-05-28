/**
 * StepBadge — Colored type label badge for interaction steps.
 *
 * Renders a small uppercase badge (e.g., "LLM CALL", "TOOL CALL")
 * colored by the step's SemanticIntent from design tokens.
 */

import { getBadgeIntentStyles } from '@agent-platform/design-tokens';
import clsx from 'clsx';
import { STEP_CONFIG } from './constants';
import type { InteractionStepType } from './types';

interface StepBadgeProps {
  type: InteractionStepType;
  className?: string;
}

export function StepBadge({ type, className }: StepBadgeProps) {
  const config = STEP_CONFIG[type];
  const styles = getBadgeIntentStyles(config.intent);

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5',
        'text-[9px] font-semibold uppercase tracking-wide leading-none',
        styles.badge,
        className,
      )}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full shrink-0', styles.dot)} />
      {config.label}
    </span>
  );
}
