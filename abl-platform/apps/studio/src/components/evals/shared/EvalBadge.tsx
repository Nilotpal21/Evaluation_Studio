/**
 * EvalBadge — Score badge with color coding.
 *
 * Maps numeric scores (1-5) to color variants:
 *   1-2: error (red), 2-3: warning (orange), 3-4: accent (blue), 4-5: success (green)
 */

import { Badge, type BadgeVariant } from '../../ui/Badge';

interface EvalBadgeProps {
  score: number;
  label?: string;
  className?: string;
}

function scoreVariant(score: number): BadgeVariant {
  if (score >= 4) return 'success';
  if (score >= 3) return 'accent';
  if (score >= 2) return 'warning';
  return 'error';
}

export function EvalBadge({ score, label, className }: EvalBadgeProps) {
  return (
    <Badge variant={scoreVariant(score)} className={className}>
      {label ?? score.toFixed(1)}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, BadgeVariant> = {
    pending: 'default',
    running: 'accent',
    completed: 'success',
    failed: 'error',
    cancelled: 'warning',
  };
  return (
    <Badge variant={variants[status] ?? 'default'} dot>
      {status}
    </Badge>
  );
}
