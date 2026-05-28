'use client';

import { clsx } from 'clsx';
import * as RadixCheckbox from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import { useId } from 'react';

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled,
  className,
}: CheckboxProps) {
  const id = useId();

  return (
    <div className={clsx('flex items-start gap-2.5', className)}>
      <RadixCheckbox.Root
        id={id}
        checked={checked}
        onCheckedChange={(val) => onChange(val === true)}
        disabled={disabled}
        className={clsx(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-default mt-0.5',
          disabled && 'opacity-50 cursor-not-allowed',
          checked
            ? 'bg-accent border-accent'
            : 'bg-background-subtle border-default hover:border-accent',
        )}
      >
        <RadixCheckbox.Indicator>
          <Check className="h-3 w-3 text-accent-foreground" strokeWidth={3} />
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      {(label || description) && (
        <label
          htmlFor={id}
          className={clsx('cursor-pointer', disabled && 'opacity-50 cursor-not-allowed')}
        >
          {label && <span className="text-sm text-foreground">{label}</span>}
          {description && <p className="text-xs text-muted mt-0.5">{description}</p>}
        </label>
      )}
    </div>
  );
}
