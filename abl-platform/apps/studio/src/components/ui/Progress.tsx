/**
 * Progress Component
 *
 * Simple progress bar component for displaying completion percentage.
 */

import * as React from 'react';

interface ProgressProps {
  value: number; // 0-100
  className?: string;
  indicatorClassName?: string;
}

export function Progress({ value, className = '', indicatorClassName = '' }: ProgressProps) {
  const clampedValue = Math.min(100, Math.max(0, value));

  return (
    <div
      className={`relative h-2 w-full overflow-hidden rounded-full bg-background-muted ${className}`}
    >
      <div
        className={`h-full bg-accent transition-all duration-300 ease-in-out ${indicatorClassName}`}
        style={{ width: `${clampedValue}%` }}
      />
    </div>
  );
}
