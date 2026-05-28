/**
 * StatusDot Component
 *
 * Colored dot for connection/deployment status with optional pulse animation.
 */

import { clsx } from 'clsx';

type StatusColor = 'green' | 'red' | 'yellow' | 'blue' | 'gray';

interface StatusDotProps {
  color: StatusColor;
  pulse?: boolean;
  size?: 'sm' | 'md';
  label?: string;
  className?: string;
}

const colorStyles: Record<StatusColor, string> = {
  green: 'bg-success',
  red: 'bg-error',
  yellow: 'bg-warning',
  blue: 'bg-accent',
  gray: 'bg-muted',
};

const sizeStyles = {
  sm: 'w-1.5 h-1.5',
  md: 'w-2 h-2',
};

export function StatusDot({ color, pulse, size = 'md', label, className }: StatusDotProps) {
  return (
    <span className={clsx('inline-flex items-center gap-2', className)}>
      <span className={clsx('relative rounded-full', colorStyles[color], sizeStyles[size])}>
        {pulse && (
          <span
            className={clsx(
              'absolute inset-0 rounded-full animate-ping',
              colorStyles[color],
              'opacity-50',
            )}
          />
        )}
      </span>
      {label && <span className="text-sm text-muted">{label}</span>}
    </span>
  );
}
