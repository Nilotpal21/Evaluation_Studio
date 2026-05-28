/**
 * NavItem Component
 *
 * Presentational sidebar navigation item with icon, label, badge, and active state.
 * Visual only — no routing or state logic.
 */

import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';

export interface NavItemProps {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  collapsed?: boolean;
  badge?: string | number;
  onClick?: () => void;
  className?: string;
}

export function NavItem({
  icon: Icon,
  label,
  active = false,
  collapsed = false,
  badge,
  onClick,
  className,
}: NavItemProps) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={clsx(
        'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-default',
        active
          ? 'bg-accent-subtle text-accent'
          : 'text-muted hover:text-foreground hover:bg-background-muted',
        className,
      )}
    >
      <span className="shrink-0 w-5 h-5 flex items-center justify-center">
        <Icon className="w-4 h-4" />
      </span>
      {!collapsed && (
        <>
          <span className="truncate flex-1 text-left">{label}</span>
          {badge !== undefined && (
            <span
              className={clsx(
                'shrink-0 px-1.5 py-0.5 rounded-full text-xs font-medium',
                active ? 'bg-accent/20 text-accent' : 'bg-background-muted text-muted',
              )}
            >
              {badge}
            </span>
          )}
        </>
      )}
    </button>
  );
}
