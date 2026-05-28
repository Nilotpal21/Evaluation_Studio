'use client';

/**
 * SearchInput Component
 *
 * Text input with 300 ms debounce and optional metadata/fulltext mode toggle.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SearchMode = 'fulltext' | 'metadata';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  /** Show the fulltext / metadata mode toggle */
  showModeToggle?: boolean;
  mode?: SearchMode;
  onModeChange?: (mode: SearchMode) => void;
  /** Debounce delay in ms (default 300) */
  debounceMs?: number;
  className?: string;
  id?: string;
}

// ---------------------------------------------------------------------------
// Hook: useDebounce
// ---------------------------------------------------------------------------

function useDebounce(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  showModeToggle = false,
  mode = 'fulltext',
  onModeChange,
  debounceMs = 300,
  className,
  id,
}: SearchInputProps) {
  const t = useTranslations('observability');
  const resolvedPlaceholder = placeholder ?? t('search.placeholder');
  const resolvedId =
    id ??
    (label
      ? label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
      : undefined);
  const [localValue, setLocalValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounced = useDebounce(localValue, debounceMs);
  const isFirstMount = useRef(true);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Fire onChange when debounced value settles (skip initial mount)
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    onChangeRef.current(debounced);
  }, [debounced]);

  // Sync external value changes
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const clear = useCallback(() => {
    setLocalValue('');
    onChange('');
    inputRef.current?.focus();
  }, [onChange]);

  const controls = (
    <div className="flex items-center gap-2">
      <div className="relative flex-1 min-w-0">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground-subtle pointer-events-none" />
        <input
          id={resolvedId}
          ref={inputRef}
          type="text"
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          placeholder={resolvedPlaceholder}
          className={clsx(
            'w-full rounded-lg border border-default bg-background text-foreground',
            'text-sm py-1.5 pl-8 pr-8 placeholder:text-foreground-subtle',
            'transition-default focus:outline-none focus:border-[hsl(var(--border-focus))] focus:ring-1 focus:ring-[hsl(var(--border-focus))]',
          )}
        />
        {localValue && (
          <button
            onClick={clear}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted hover:text-foreground transition-default"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Mode toggle */}
      {showModeToggle && onModeChange && (
        <div className="flex items-center rounded-lg border border-default bg-background-subtle p-0.5 shrink-0">
          <button
            onClick={() => onModeChange('fulltext')}
            className={clsx(
              'px-2 py-1 text-xs font-medium rounded-md transition-default',
              mode === 'fulltext'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted hover:text-foreground',
            )}
          >
            {t('search.fulltext')}
          </button>
          <button
            onClick={() => onModeChange('metadata')}
            className={clsx(
              'px-2 py-1 text-xs font-medium rounded-md transition-default',
              mode === 'metadata'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted hover:text-foreground',
            )}
          >
            {t('search.metadata')}
          </button>
        </div>
      )}
    </div>
  );

  if (label) {
    return (
      <div className={clsx('space-y-1.5', className)}>
        <label htmlFor={resolvedId} className="block text-sm font-medium text-foreground">
          {label}
        </label>
        {controls}
      </div>
    );
  }

  return <div className={className}>{controls}</div>;
}
