/**
 * Input Component
 *
 * Text input with label + error state.
 */

import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { clsx } from 'clsx';
import { Eye, EyeOff } from 'lucide-react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  icon?: React.ReactNode;
  optional?: boolean;
  /**
   * When the field is `type="password"`, render an eye/eye-off button inside the
   * input's trailing slot so users can verify what they typed before submitting.
   * Ignored for non-password inputs.
   */
  showToggle?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, icon, className, id, required, optional, showToggle, type, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');
    const [revealed, setRevealed] = useState(false);
    const isPassword = type === 'password';
    const toggleEnabled = Boolean(showToggle && isPassword);
    const effectiveType = toggleEnabled && revealed ? 'text' : type;

    let paddingClasses: string;
    if (icon && toggleEnabled) {
      paddingClasses = 'pl-9 pr-10';
    } else if (icon) {
      paddingClasses = 'pl-9 pr-3';
    } else if (toggleEnabled) {
      paddingClasses = 'pl-3 pr-10';
    } else {
      paddingClasses = 'px-3';
    }

    return (
      <div className="space-y-1.5">
        {label && (
          <label htmlFor={inputId} className="block text-sm font-medium text-foreground">
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
        <div className="relative">
          {icon && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">{icon}</span>
          )}
          <input
            ref={ref}
            id={inputId}
            type={effectiveType}
            className={clsx(
              'w-full rounded-lg border bg-background-subtle text-foreground placeholder:text-subtle',
              'transition-default focus:outline-none focus:ring-1',
              'text-sm py-2',
              paddingClasses,
              // Error state wins over focus so the red border stays visible
              // while the user is fixing the value — without this, focus-ring
              // styles override border-error and the field looks healthy.
              error
                ? 'border-error focus:border-error focus:ring-error'
                : 'border-default focus:border-border-focus focus:ring-border-focus',
              className,
            )}
            required={required}
            {...props}
          />
          {toggleEnabled && (
            <button
              type="button"
              onClick={() => setRevealed((v) => !v)}
              aria-label={revealed ? 'Hide value' : 'Show value'}
              aria-pressed={revealed}
              tabIndex={-1}
              className="absolute right-2 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded text-muted hover:text-foreground focus:outline-none focus:ring-1 focus:ring-border-focus transition-default"
            >
              {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          )}
        </div>
        {error && <p className="text-xs text-error">{error}</p>}
      </div>
    );
  },
);

Input.displayName = 'Input';
