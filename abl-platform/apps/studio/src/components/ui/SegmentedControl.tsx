/**
 * SegmentedControl Component
 *
 * iOS-style segmented control for switching between views.
 * Features smooth sliding indicator and clean pill design.
 * Implements WAI-ARIA tablist pattern with keyboard navigation.
 */

import { ReactNode, useId, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';

export interface SegmentOption {
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: string | number;
}

interface SegmentedControlProps {
  options: SegmentOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  /** Accessible label for the tablist */
  ariaLabel?: string;
}

export function SegmentedControl({
  options,
  value,
  onChange,
  className = '',
  size = 'md',
  ariaLabel = 'View selector',
}: SegmentedControlProps) {
  const instanceId = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  const sizeClasses = {
    sm: 'text-xs py-1.5 px-3',
    md: 'text-sm py-2 px-4',
    lg: 'text-base py-2.5 px-5',
  };

  const containerSizeClasses = {
    sm: 'p-1',
    md: 'p-1',
    lg: 'p-1.5',
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIndex = options.findIndex((o) => o.id === value);
      let nextIndex: number | null = null;

      switch (e.key) {
        case 'ArrowRight':
          nextIndex = (currentIndex + 1) % options.length;
          break;
        case 'ArrowLeft':
          nextIndex = (currentIndex - 1 + options.length) % options.length;
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = options.length - 1;
          break;
        default:
          return;
      }

      e.preventDefault();
      onChange(options[nextIndex].id);

      // Focus the newly active tab button
      const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      buttons?.[nextIndex]?.focus();
    },
    [options, value, onChange],
  );

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-1 bg-background-muted rounded-lg ${containerSizeClasses[size]} ${className}`}
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => {
        const isActive = option.id === value;

        return (
          <button
            key={option.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(option.id)}
            className={`
              relative flex items-center gap-2 ${sizeClasses[size]}
              rounded-md font-medium transition-colors duration-200
              ${isActive ? 'text-foreground' : 'text-muted hover:text-foreground'}
            `}
          >
            {/* Sliding background indicator */}
            {isActive && (
              <motion.div
                layoutId={`segmented-control-${instanceId}`}
                className="absolute inset-0 bg-background-elevated border border-default shadow-sm rounded-md"
                transition={{
                  type: 'spring',
                  stiffness: 500,
                  damping: 35,
                }}
              />
            )}

            {/* Content */}
            <span className="relative z-10 flex items-center gap-2">
              {option.icon && <span className={isActive ? 'text-accent' : ''}>{option.icon}</span>}
              <span>{option.label}</span>
              {option.badge !== undefined && (
                <span
                  className={`
                    inline-flex items-center justify-center min-w-5 h-5
                    px-1 rounded-full text-xs font-semibold
                    ${
                      isActive
                        ? 'bg-accent text-accent-foreground'
                        : 'bg-background-muted text-muted'
                    }
                  `}
                >
                  {option.badge}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
