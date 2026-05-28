/**
 * Badge Component
 *
 * Color-coded pill badges for status, counts, etc.
 *
 * `appearance` controls how the variant color is rendered:
 *   - 'subtle'   (default) — pale tinted background + saturated text.
 *                Visually loud; ideal for hero status pills.
 *   - 'outlined' — transparent background + colored border + colored text.
 *                Quieter; ideal for status indicators in dense tables
 *                or rows where the subtle fill would over-power.
 */

import { clsx } from 'clsx';

export type BadgeVariant =
  | 'default'
  | 'accent'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'purple';

export type BadgeAppearance = 'subtle' | 'outlined';

interface BadgeProps {
  variant?: BadgeVariant;
  appearance?: BadgeAppearance;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
  size?: string;
  /** Pulse animation on the dot — use for in-progress statuses */
  pulse?: boolean;
  testid?: string;
}

const subtleStyles: Record<BadgeVariant, string> = {
  default: 'bg-background-muted text-muted',
  accent: 'bg-accent-subtle text-accent',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  error: 'bg-error-subtle text-error',
  info: 'bg-info-subtle text-info',
  purple: 'bg-purple-subtle text-purple',
};

const outlinedStyles: Record<BadgeVariant, string> = {
  default: 'border border-default text-muted',
  accent: 'border border-accent text-accent',
  success: 'border border-success text-success',
  warning: 'border border-warning text-warning',
  error: 'border border-error text-error',
  info: 'border border-info text-info',
  purple: 'border border-purple text-purple',
};

export function Badge({
  variant = 'default',
  appearance = 'subtle',
  children,
  className,
  dot,
  pulse,
  testid,
}: BadgeProps) {
  const variantStyles = appearance === 'outlined' ? outlinedStyles : subtleStyles;
  return (
    <span
      data-testid={testid}
      className={clsx(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium',
        variantStyles[variant],
        className,
      )}
    >
      {dot && (
        <span
          className={clsx('w-1.5 h-1.5 rounded-full bg-current', {
            'animate-badge-pulse': pulse,
          })}
        />
      )}
      {children}
    </span>
  );
}
