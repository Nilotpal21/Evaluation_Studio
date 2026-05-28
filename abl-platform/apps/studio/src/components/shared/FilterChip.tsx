'use client';

import { X } from 'lucide-react';
import { clsx } from 'clsx';

type FilterChipVariant = 'muted' | 'accent';

interface FilterChipProps {
  label: string;
  value: string;
  variant?: FilterChipVariant;
  onRemove?: () => void;
  removeLabel?: string;
  className?: string;
}

const CHIP_VARIANT_STYLES: Record<FilterChipVariant, string> = {
  muted: 'bg-background-muted text-foreground border border-default',
  accent: 'bg-accent-subtle text-accent border border-accent/20',
};

export function FilterChip({
  label,
  value,
  variant = 'muted',
  onRemove,
  removeLabel,
  className,
}: FilterChipProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium',
        CHIP_VARIANT_STYLES[variant],
        className,
      )}
    >
      <span className="text-muted">{label}:</span>
      <span className={variant === 'accent' ? 'text-foreground' : undefined}>{value}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? `Clear ${label} filter`}
          className={clsx(
            'ml-0.5 p-0.5 rounded-full transition-default',
            variant === 'accent' ? 'hover:bg-accent/20' : 'hover:bg-background-elevated',
          )}
        >
          <X className="w-3 h-3" />
        </button>
      ) : null}
    </span>
  );
}
