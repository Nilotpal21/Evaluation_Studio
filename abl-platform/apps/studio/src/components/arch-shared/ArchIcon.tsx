/**
 * Arch Icon
 *
 * Abstract "A" logomark formed by two angled lines meeting at a point,
 * resembling a compass/drafting tool. Used as Arch's avatar.
 */

import { clsx } from 'clsx';

interface ArchIconProps {
  size?: number;
  className?: string;
}

export function ArchIcon({ size = 20, className }: ArchIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={clsx('text-purple', className)}
    >
      {/* Two angled lines meeting at a point — abstract "A" / compass */}
      <path d="M12 3L4 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 3L20 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {/* Crossbar */}
      <path d="M7 14H17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {/* Point glow dot */}
      <circle cx="12" cy="3" r="1.5" fill="currentColor" />
    </svg>
  );
}
