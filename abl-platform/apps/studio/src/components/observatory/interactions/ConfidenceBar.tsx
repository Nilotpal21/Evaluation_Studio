/**
 * ConfidenceBar — Reusable horizontal confidence/progress bar.
 *
 * Used by:
 * - Feature B: Guardrail check confidence
 * - Plan 4 Feature F: Gather field confidence
 */

import { getIntentStyles } from '@agent-platform/design-tokens';
import type { SemanticIntent } from '@agent-platform/design-tokens';
import clsx from 'clsx';

interface ConfidenceBarProps {
  /** Value 0-1 (fractional) or 0-100 (percentage) */
  value: number;
  /** SemanticIntent for the fill color */
  intent: SemanticIntent;
  /** Show percentage label (default: true) */
  showLabel?: boolean;
  /** Additional CSS classes on the outer container */
  className?: string;
}

export function ConfidenceBar({ value, intent, showLabel = true, className }: ConfidenceBarProps) {
  // Normalize to 0-100
  const pct = value > 1 ? Math.min(value, 100) : Math.min(value * 100, 100);
  const styles = getIntentStyles(intent);

  return (
    <div className={clsx('flex items-center gap-1.5', className)}>
      <div className="flex-1 h-1.5 rounded-full bg-background-elevated overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all duration-300', styles.bg)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <span className="text-[9px] font-mono text-foreground-subtle w-8 text-right shrink-0">
          {Math.round(pct)}%
        </span>
      )}
    </div>
  );
}
