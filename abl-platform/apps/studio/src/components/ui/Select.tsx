/**
 * Select Component
 *
 * Built on @radix-ui/react-select for full keyboard navigation,
 * focus management, and screen reader support.
 */

'use client';

import * as RadixSelect from '@radix-ui/react-select';
import { ChevronDown, Check } from 'lucide-react';
import { clsx } from 'clsx';

interface SelectOption {
  value: string;
  label: string;
  testid?: string;
}

interface SelectProps {
  label?: string;
  options: SelectOption[];
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  optional?: boolean;
  className?: string;
  id?: string;
  testid?: string;
}

// Radix Select.Item throws on value="". Remap empty strings to a sentinel
// internally so callers can keep using '' for "none/all/default" options.
const EMPTY_SENTINEL = '__empty__';

// Radix Select content portals to document.body, so it must sit above modal
// layers when a Select is rendered inside a Dialog or SlidePanel.
export const SELECT_CONTENT_LAYER_CLASS = 'z-[101]';

export const Select = ({
  label,
  options,
  value,
  onChange,
  placeholder = 'Select...',
  error,
  disabled,
  required,
  optional,
  className,
  id,
  testid,
}: SelectProps) => {
  const selectId = id || label?.toLowerCase().replace(/\s+/g, '-');

  // Remap empty-string option values to the sentinel
  const safeOptions = options.map((opt) =>
    opt.value === '' ? { ...opt, value: EMPTY_SENTINEL } : opt,
  );

  // Map the controlled value to sentinel when empty.
  // If there is no option with value '', treat '' as "no selection" so the
  // placeholder is shown instead of a blank trigger.
  const hasEmptyOption = options.some((opt) => opt.value === '');
  const safeValue =
    value === '' ? (hasEmptyOption ? EMPTY_SENTINEL : undefined) : value || undefined;

  const handleChange = (v: string) => {
    // Map sentinel back to empty string for the caller
    onChange?.(v === EMPTY_SENTINEL ? '' : v);
  };

  return (
    <div className={clsx('space-y-1.5', className)}>
      {label && (
        <label htmlFor={selectId} className="block text-sm font-medium text-foreground">
          {label}
          {required ? (
            <span aria-hidden className="ml-1 text-[11px] font-semibold text-error">
              *
            </span>
          ) : optional ? (
            <span aria-hidden className="ml-1 text-[11px] font-normal text-muted">
              (Optional)
            </span>
          ) : null}
        </label>
      )}
      <RadixSelect.Root value={safeValue} onValueChange={handleChange} disabled={disabled}>
        <RadixSelect.Trigger
          id={selectId}
          aria-required={required || undefined}
          data-testid={testid}
          className={clsx(
            'w-full relative flex items-center justify-between rounded-lg border bg-background text-foreground',
            'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
            'text-sm py-2 pl-3 pr-8 text-left',
            error ? 'border-error' : 'border-default',
            disabled && 'opacity-50 cursor-not-allowed',
          )}
        >
          <RadixSelect.Value placeholder={placeholder} />
          <RadixSelect.Icon className="absolute right-2.5 top-1/2 -translate-y-1/2">
            <ChevronDown className="w-4 h-4 text-muted" />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>

        <RadixSelect.Portal>
          <RadixSelect.Content
            className={clsx(
              `${SELECT_CONTENT_LAYER_CLASS} min-w-[var(--radix-select-trigger-width)] overflow-hidden`,
              'rounded-xl border border-default bg-background-elevated shadow-xl',
              'animate-fade-in-scale',
            )}
            position="popper"
            sideOffset={4}
          >
            <RadixSelect.Viewport className="p-1 max-h-60">
              {safeOptions.map((opt) => (
                <RadixSelect.Item
                  key={opt.value}
                  value={opt.value}
                  data-testid={opt.testid}
                  className={clsx(
                    'flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-default text-left cursor-pointer',
                    'text-foreground-muted outline-none',
                    'data-[highlighted]:bg-background-muted data-[highlighted]:text-foreground',
                    'data-[state=checked]:text-foreground data-[state=checked]:font-medium',
                  )}
                >
                  <span className="w-4 shrink-0">
                    <RadixSelect.ItemIndicator>
                      <Check className="w-3.5 h-3.5 text-foreground" />
                    </RadixSelect.ItemIndicator>
                  </span>
                  <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
};

Select.displayName = 'Select';
