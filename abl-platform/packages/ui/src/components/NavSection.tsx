/**
 * NavSection Component
 *
 * Section header + item list wrapper for sidebar navigation groups.
 * Visual only — no routing or state logic.
 */

import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export interface NavSectionProps {
  title: string;
  collapsed?: boolean;
  children: ReactNode;
  className?: string;
}

export function NavSection({ title, collapsed = false, children, className }: NavSectionProps) {
  return (
    <div className={clsx('space-y-0.5', className)}>
      {!collapsed && (
        <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-subtle select-none">
          {title}
        </p>
      )}
      <div className="space-y-0.5 px-2">{children}</div>
    </div>
  );
}
