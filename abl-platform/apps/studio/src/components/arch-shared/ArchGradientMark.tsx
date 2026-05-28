'use client';

/**
 * ArchGradientMark — standardised Arch identity mark.
 *
 * Clean neutral background. Gradient applied to the "A" strokes only.
 * Gradient: indigo-400 → violet-500 (subtle, modern, not primary-saturated).
 *
 * Sizes:
 *   xs  — compact header / chat avatar (28×28, icon 13)
 *   sm  — chat avatar (28×28, icon 13)
 *   md  — entry hero (40×40, icon 20)
 *   lg  — loading screen (48×48, icon 24)
 */

import { clsx } from 'clsx';

type ArchGradientMarkSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_CONFIG: Record<ArchGradientMarkSize, { container: string; icon: number }> = {
  xs: { container: 'h-7 w-7 rounded-xl', icon: 13 },
  sm: { container: 'h-7 w-7 rounded-xl', icon: 13 },
  md: { container: 'h-10 w-10 rounded-xl', icon: 20 },
  lg: { container: 'h-12 w-12 rounded-2xl', icon: 24 },
};

interface ArchGradientMarkProps {
  size?: ArchGradientMarkSize;
  className?: string;
}

export function ArchGradientMark({ size = 'md', className }: ArchGradientMarkProps) {
  const { container, icon } = SIZE_CONFIG[size];
  const gradId = 'arch-stroke-grad';

  return (
    <div
      className={clsx(
        'flex shrink-0 items-center justify-center',
        'bg-purple/10 border border-purple/20',
        container,
        className,
      )}
    >
      <svg width={icon} height={icon} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            {/* indigo-400 → violet-500 — intentional brand palette */}
            <stop offset="0%" stopColor="#818cf8" />
            <stop offset="100%" stopColor="#8b5cf6" />
          </linearGradient>
        </defs>
        <path d="M12 3L4 21" stroke={`url(#${gradId})`} strokeWidth="2" strokeLinecap="round" />
        <path d="M12 3L20 21" stroke={`url(#${gradId})`} strokeWidth="2" strokeLinecap="round" />
        <path d="M7 14H17" stroke={`url(#${gradId})`} strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="3" r="1.5" fill={`url(#${gradId})`} />
      </svg>
    </div>
  );
}
