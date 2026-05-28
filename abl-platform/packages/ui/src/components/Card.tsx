/**
 * Card Component
 *
 * Clickable card with hover animation.
 */

import { clsx } from 'clsx';

interface CardProps {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  hoverable?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

const paddingStyles = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

export function Card({
  children,
  onClick,
  className,
  hoverable = true,
  padding = 'md',
}: CardProps) {
  const Component = onClick ? 'button' : 'div';

  return (
    <Component
      onClick={onClick}
      className={clsx(
        'rounded-xl border border-default bg-background-elevated text-left',
        paddingStyles[padding],
        hoverable && 'card-hover cursor-pointer',
        onClick && 'w-full',
        className,
      )}
    >
      {children}
    </Component>
  );
}
