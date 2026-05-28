/**
 * ProviderSelect Component
 *
 * Custom dropdown for selecting an LLM provider, showing provider icons
 * and names. Used in credentials forms and settings pages.
 */

'use client';

import { useState, useEffect, useRef } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { clsx } from 'clsx';
import { getProviderIcon } from '../icons/ProviderIcons';

export interface ProviderOption {
  value: string;
  label: string;
  description?: string;
}

interface ProviderSelectProps {
  providers: ProviderOption[];
  value: string;
  onChange: (value: string) => void;
  id?: string;
  label?: string;
  /** Use larger icon + show descriptions in trigger and items */
  size?: 'sm' | 'lg';
}

export function ProviderSelect({
  providers,
  value,
  onChange,
  id,
  label,
  size = 'sm',
}: ProviderSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const selected = providers.find((p) => p.value === value);
  const SelectedIcon = getProviderIcon(value);
  const isLg = size === 'lg';
  const iconCls = isLg ? 'w-5 h-5' : 'w-4 h-4';

  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-foreground">
          {label}
        </label>
      )}
      <div className="relative" ref={ref}>
        {/* Trigger */}
        <button
          id={id}
          type="button"
          onClick={() => setOpen(!open)}
          className={clsx(
            'w-full flex items-center justify-between rounded-lg border text-sm transition-default cursor-pointer',
            isLg ? 'bg-background-elevated py-2.5 px-3' : 'bg-background-subtle py-2 px-3',
            open
              ? 'border-border-focus ring-1 ring-border-focus'
              : 'border-default hover:border-border-focus/50',
          )}
        >
          <div className="flex items-center gap-2.5">
            <SelectedIcon className={clsx(iconCls, 'shrink-0')} />
            <div className="text-left">
              <span className="font-medium text-foreground">{selected?.label ?? value}</span>
              {isLg && selected?.description && (
                <span className="ml-2 text-xs text-muted">{selected.description}</span>
              )}
            </div>
          </div>
          <ChevronDown
            className={clsx('w-4 h-4 text-muted transition-default', open && 'rotate-180')}
          />
        </button>

        {/* Dropdown list */}
        {open && (
          <div className="absolute z-50 mt-1 w-full rounded-xl border border-default bg-background-elevated shadow-xl overflow-hidden animate-fade-in-scale">
            <div className="max-h-64 overflow-y-auto py-1">
              {providers.map((provider) => {
                const isActive = provider.value === value;
                const Icon = getProviderIcon(provider.value);
                return (
                  <button
                    key={provider.value}
                    type="button"
                    onClick={() => {
                      onChange(provider.value);
                      setOpen(false);
                    }}
                    className={clsx(
                      'w-full flex items-center gap-2.5 px-3 text-left transition-fast',
                      isLg ? 'py-2.5' : 'py-2',
                      isActive ? 'bg-background-muted' : 'hover:bg-background-muted',
                    )}
                  >
                    <Icon className={clsx(iconCls, 'shrink-0')} />
                    <div className="flex-1 min-w-0">
                      <span
                        className={clsx(
                          'text-sm font-medium',
                          isActive ? 'text-foreground' : 'text-foreground',
                        )}
                      >
                        {provider.label}
                      </span>
                      {isLg && provider.description && (
                        <span className="ml-2 text-xs text-muted">{provider.description}</span>
                      )}
                    </div>
                    {isActive && <Check className="w-3.5 h-3.5 text-foreground shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
