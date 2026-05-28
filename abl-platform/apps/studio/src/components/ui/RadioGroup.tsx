/**
 * RadioGroup Component
 *
 * Built on @radix-ui/react-radio-group for full keyboard navigation,
 * focus management, and screen reader support.
 */

'use client';

import * as RadixRadioGroup from '@radix-ui/react-radio-group';
import { clsx } from 'clsx';

interface RadioOption {
  value: string;
  label: string;
  description?: string;
}

interface RadioGroupProps {
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  name?: string;
  direction?: 'horizontal' | 'vertical';
  disabled?: boolean;
  className?: string;
}

export function RadioGroup({
  options,
  value,
  onChange,
  label,
  name,
  direction = 'horizontal',
  disabled,
  className,
}: RadioGroupProps) {
  return (
    <div className={clsx('space-y-1.5', className)}>
      {label && <span className="block text-sm font-medium text-foreground">{label}</span>}
      <RadixRadioGroup.Root
        value={value}
        onValueChange={onChange}
        name={name}
        disabled={disabled}
        orientation={direction}
        className={clsx(
          'flex gap-4',
          direction === 'vertical' ? 'flex-col gap-2.5' : 'flex-row items-center',
        )}
      >
        {options.map((opt) => (
          <label
            key={opt.value}
            className={clsx(
              'flex items-start gap-2.5 cursor-pointer select-none',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            <RadixRadioGroup.Item
              value={opt.value}
              className={clsx(
                'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-default',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1',
                'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
                'data-[state=unchecked]:border-default data-[state=unchecked]:bg-background-subtle data-[state=unchecked]:hover:border-accent',
              )}
            >
              <RadixRadioGroup.Indicator className="flex items-center justify-center">
                <span className="block h-1.5 w-1.5 rounded-full bg-accent-foreground" />
              </RadixRadioGroup.Indicator>
            </RadixRadioGroup.Item>
            <div>
              <span className="text-sm text-foreground">{opt.label}</span>
              {opt.description && <p className="text-xs text-muted mt-0.5">{opt.description}</p>}
            </div>
          </label>
        ))}
      </RadixRadioGroup.Root>
    </div>
  );
}
