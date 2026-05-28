/**
 * RunStatusIcon Component
 *
 * Maps pipeline run status to a Lucide icon + semantic colour token.
 */

'use client';

import { CheckCircle, XCircle, Loader, MinusCircle } from 'lucide-react';
import { clsx } from 'clsx';

type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

interface RunStatusIconProps {
  status: RunStatus;
  className?: string;
}

const statusConfig: Record<RunStatus, { icon: typeof CheckCircle; color: string; spin?: boolean }> =
  {
    completed: { icon: CheckCircle, color: 'text-success' },
    failed: { icon: XCircle, color: 'text-error' },
    running: { icon: Loader, color: 'text-warning', spin: true },
    pending: { icon: Loader, color: 'text-warning', spin: true },
    cancelled: { icon: MinusCircle, color: 'text-muted' },
  };

export function RunStatusIcon({ status, className }: RunStatusIconProps) {
  const config = statusConfig[status] ?? statusConfig.pending;
  const Icon = config.icon;

  return (
    <Icon
      className={clsx('w-4 h-4', config.color, config.spin && 'animate-spin', className)}
      aria-label={status}
    />
  );
}
