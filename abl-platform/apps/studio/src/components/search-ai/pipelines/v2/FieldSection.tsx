/**
 * FieldSection — Collapsible section for field categories.
 *
 * Shows a header with title, selection count badge, and
 * chevron toggle. Children render when expanded.
 */

'use client';

import { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '../../../ui/Badge';

// =============================================================================
// TYPES
// =============================================================================

export interface FieldSectionProps {
  title: string;
  count: { selected: number; total: number };
  defaultOpen?: boolean;
  children: React.ReactNode;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function FieldSection({ title, count, defaultOpen = false, children }: FieldSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  const handleToggle = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  return (
    <div className="border-b border-default">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center justify-between px-4 py-2.5 hover:bg-background-muted transition-default"
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-foreground-muted" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-foreground-muted" />
          )}
          <span className="text-xs font-semibold text-foreground">{title}</span>
        </div>
        <Badge variant="default" className="text-[10px]">
          {count.selected}/{count.total}
        </Badge>
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}
