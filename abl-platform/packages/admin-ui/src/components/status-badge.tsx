import { statusIntent, getBadgeIntentStyles } from '@agent-platform/design-tokens';
import { cn } from '../lib/cn';

export type StatusBadgeVariant =
  | 'healthy'
  | 'degraded'
  | 'down'
  | 'unknown'
  | 'active'
  | 'suspended'
  | 'archived'
  | 'open'
  | 'closed'
  | 'half-open';

function getVariantStyles(status: StatusBadgeVariant): { badge: string; dot: string } {
  return getBadgeIntentStyles(statusIntent(status));
}

const defaultLabels: Record<StatusBadgeVariant, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Unknown',
  active: 'Active',
  suspended: 'Suspended',
  archived: 'Archived',
  open: 'Open',
  closed: 'Closed',
  'half-open': 'Half-Open',
};

interface StatusBadgeProps {
  status: StatusBadgeVariant;
  label?: string;
  className?: string;
}

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  const styles = getVariantStyles(status);
  const displayLabel = label ?? defaultLabels[status];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        styles.badge,
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', styles.dot)} />
      {displayLabel}
    </span>
  );
}
