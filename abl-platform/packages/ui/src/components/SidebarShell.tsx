/**
 * SidebarShell Component
 *
 * Collapsible sidebar container with animated width transition.
 * Handles the 240px ↔ 56px animated width via Framer Motion.
 * Visual only — no routing or state logic.
 */

'use client';

import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { springs } from '../tokens/index.js';

export interface SidebarShellProps {
  collapsed: boolean;
  onCollapseToggle: () => void;
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SidebarShell({
  collapsed,
  onCollapseToggle,
  header,
  footer,
  children,
  className,
}: SidebarShellProps) {
  const CollapseIcon = collapsed ? ChevronsRight : ChevronsLeft;

  return (
    <motion.aside
      animate={{ width: collapsed ? 56 : 240 }}
      transition={springs.gentle}
      className={clsx(
        'h-full flex flex-col bg-background-subtle border-r border-default overflow-hidden shrink-0',
        className,
      )}
    >
      {/* Header slot */}
      {header && <div className="px-3 py-3 border-b border-default shrink-0">{header}</div>}

      {/* Main nav area */}
      <nav className="flex-1 overflow-y-auto py-2 space-y-4">{children}</nav>

      {/* Footer slot + collapse toggle */}
      <div className="border-t border-default shrink-0">
        {footer && <div className="px-3 py-2">{footer}</div>}
        <div className="px-3 py-2">
          <button
            onClick={onCollapseToggle}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="w-full flex items-center justify-center p-2 rounded-lg text-muted hover:text-foreground hover:bg-background-muted transition-default"
          >
            <CollapseIcon className="w-4 h-4 shrink-0" />
            {!collapsed && <span className="ml-2 text-sm truncate">Collapse</span>}
          </button>
        </div>
      </div>
    </motion.aside>
  );
}
