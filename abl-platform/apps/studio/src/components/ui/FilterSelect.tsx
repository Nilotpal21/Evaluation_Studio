/**
 * FilterSelect Component
 *
 * Compact dropdown for toolbar/filter bars. Replaces native <select>
 * with a custom styled popover that matches the design system.
 * Uses a portal to escape overflow-hidden clipping on parent containers.
 */

'use client';

import { useState, useRef, useEffect, useCallback, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';
import { clsx } from 'clsx';

interface FilterOption {
  value: string;
  label: string;
}

interface FilterSelectProps {
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function FilterSelect({ options, value, onChange, className }: FilterSelectProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});

  const selectedLabel = options.find((o) => o.value === value)?.label ?? value;

  const handleSelect = useCallback(
    (val: string) => {
      onChange(val);
      setOpen(false);
    },
    [onChange],
  );

  // Position the portal menu beneath the trigger button
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      zIndex: 9999,
    });
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      const clickedTrigger = containerRef.current?.contains(target);
      const clickedMenu = menuRef.current?.contains(target);

      if (!clickedTrigger && !clickedMenu) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [open]);

  // Close on scroll (parent containers may shift the trigger position)
  useEffect(() => {
    if (!open) return;
    function onScroll() {
      setOpen(false);
    }
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [open]);

  const menu =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={menuRef}
            style={menuStyle}
            className={clsx(
              'min-w-[10rem] w-max',
              'rounded-xl border border-default bg-background-elevated shadow-xl',
              'p-1 animate-fade-in-scale bg-noise',
            )}
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleSelect(opt.value)}
                className={clsx(
                  'w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-default text-left',
                  opt.value === value
                    ? 'bg-background-muted text-foreground font-medium'
                    : 'text-foreground-muted hover:bg-background-muted hover:text-foreground',
                )}
              >
                <span className="w-4 shrink-0">
                  {opt.value === value && <Check className="w-3.5 h-3.5 text-foreground" />}
                </span>
                <span>{opt.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={clsx('relative shrink-0', className)} ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((p) => !p)}
        className={clsx(
          'flex items-center gap-1.5 px-2.5 py-2 text-sm font-medium whitespace-nowrap',
          'bg-background border border-default rounded-lg',
          'text-foreground hover:bg-background-muted transition-default',
          'focus:outline-none focus:ring-1 focus:ring-border-focus',
        )}
      >
        <span>{selectedLabel}</span>
        <ChevronDown
          className={clsx(
            'w-4 h-4 text-foreground-muted transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {menu}
    </div>
  );
}
