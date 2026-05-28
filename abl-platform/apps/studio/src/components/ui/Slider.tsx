'use client';

import { forwardRef, type InputHTMLAttributes } from 'react';
import { clsx } from 'clsx';

interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
  valueLabel?: string;
}

export const Slider = forwardRef<HTMLInputElement, SliderProps>(
  ({ label, valueLabel, className, id, ...props }, ref) => {
    const sliderId = id ?? (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div className="space-y-1.5">
        {(label || valueLabel) && (
          <div className="flex items-center justify-between gap-3">
            {label && (
              <label htmlFor={sliderId} className="block text-sm font-medium text-foreground">
                {label}
              </label>
            )}
            {valueLabel && <span className="text-sm font-medium text-muted">{valueLabel}</span>}
          </div>
        )}
        <input
          ref={ref}
          id={sliderId}
          type="range"
          className={clsx(
            'w-full cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
          {...props}
        />
      </div>
    );
  },
);

Slider.displayName = 'Slider';
