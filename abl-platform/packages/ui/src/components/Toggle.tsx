/**
 * Toggle Component
 *
 * Accessible switch toggle using role="switch" with aria-checked.
 * Uses useId() for proper label association and semantic color tokens.
 */

'use client';

import { useId } from 'react';
import { clsx } from 'clsx';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  className,
}: ToggleProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-desc`;

  const hasLabel = Boolean(label);
  const hasDescription = Boolean(description);

  return (
    <div
      className={clsx(
        'flex items-start gap-3',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
        className,
      )}
    >
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={hasLabel ? labelId : undefined}
        aria-describedby={hasDescription ? descriptionId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative inline-flex h-5 w-9 items-center rounded-full transition-default shrink-0 mt-0.5',
          'outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
          checked ? 'bg-accent' : 'bg-background-elevated border border-default',
        )}
      >
        <span
          className={clsx(
            'inline-block h-3.5 w-3.5 rounded-full bg-foreground shadow-sm transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-[3px]',
          )}
        />
      </button>
      {(hasLabel || hasDescription) && (
        <label
          htmlFor={id}
          className={clsx('select-none', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}
        >
          {hasLabel && (
            <span id={labelId} className="text-sm font-medium text-foreground">
              {label}
            </span>
          )}
          {hasDescription && (
            <p id={descriptionId} className="text-xs text-muted mt-0.5">
              {description}
            </p>
          )}
        </label>
      )}
    </div>
  );
}
