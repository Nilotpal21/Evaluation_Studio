'use client';

import type { ReactNode } from 'react';
import { clsx } from 'clsx';

interface ToggleChipProps {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}

export function ToggleChip({ active, onClick, children, disabled }: ToggleChipProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'px-3 py-1.5 rounded border text-xs font-medium transition-colors focus-ring',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
        active
          ? 'bg-accent text-accent-foreground border-accent'
          : 'border-default text-muted hover:border-border-focus',
      )}
    >
      {children}
    </button>
  );
}
