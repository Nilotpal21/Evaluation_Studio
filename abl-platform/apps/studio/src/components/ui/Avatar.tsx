/**
 * Avatar Component
 *
 * User/team avatar with initials fallback.
 */

import { clsx } from 'clsx';

interface AvatarProps {
  src?: string | null;
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeStyles = {
  sm: 'w-6 h-6 text-xs',
  md: 'w-8 h-8 text-sm',
  lg: 'w-10 h-10 text-base',
};

export function Avatar({ src, name, size = 'md', className }: AvatarProps) {
  const initials = name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={clsx('rounded-full object-cover', sizeStyles[size], className)}
      />
    );
  }

  return (
    <div
      className={clsx(
        'rounded-full bg-accent flex items-center justify-center text-accent-foreground font-medium',
        sizeStyles[size],
        className,
      )}
    >
      {initials}
    </div>
  );
}
