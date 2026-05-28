/**
 * SearchableSelect Component
 *
 * A dropdown with built-in text search for filtering large option lists.
 * Uses a popover with an input field and scrollable filtered results.
 */

'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { clsx } from 'clsx';

interface SearchableSelectOption {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  label?: string;
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  error?: string;
}

export function SearchableSelect({
  label,
  options,
  value,
  onChange,
  disabled,
  placeholder = 'Select...',
  error,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedLabel = options.find((o) => o.value === value)?.label ?? placeholder;

  const filtered = search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  const handleSelect = useCallback(
    (val: string) => {
      onChange(val);
      setOpen(false);
      setSearch('');
    },
    [onChange],
  );

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  // Focus search input when opened
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const selectId = label?.toLowerCase().replace(/\s+/g, '-');

  return (
    <div className="space-y-1.5" ref={containerRef}>
      {label && (
        <label htmlFor={selectId} className="block text-sm font-medium text-foreground">
          {label}
        </label>
      )}
      <div className="relative">
        <button
          type="button"
          id={selectId}
          disabled={disabled}
          onClick={() => !disabled && setOpen((p) => !p)}
          className={clsx(
            'w-full flex items-center justify-between rounded-lg border bg-background text-foreground',
            'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
            'text-sm py-2 pl-3 pr-8 text-left',
            error ? 'border-error' : 'border-default',
            disabled && 'opacity-50 cursor-not-allowed',
          )}
        >
          <span className={clsx(!value && 'text-subtle')}>{selectedLabel}</span>
          <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
        </button>

        {open && (
          <div className="absolute z-50 mt-1 w-full rounded-xl border border-default bg-background-elevated shadow-xl animate-fade-in-scale">
            <div className="flex items-center gap-2 border-b border-default px-3 py-2">
              <Search className="w-3.5 h-3.5 text-muted shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full bg-transparent text-sm text-foreground placeholder:text-subtle focus:outline-none"
              />
            </div>
            <div className="max-h-48 overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted">No results</p>
              ) : (
                filtered.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleSelect(opt.value)}
                    className={clsx(
                      'w-full text-left px-3 py-1.5 text-sm transition-default',
                      opt.value === value
                        ? 'bg-background-muted text-foreground font-medium'
                        : 'text-foreground-muted hover:bg-background-muted hover:text-foreground',
                    )}
                  >
                    {opt.label}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
