/**
 * Sidebar Component
 *
 * Collapsible sidebar with sections and animated width transition.
 */

import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { springs } from '../tokens/index.js';

interface SidebarSection {
  items: SidebarItem[];
}

interface SidebarItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  badge?: React.ReactNode;
}

interface SidebarProps {
  sections: SidebarSection[];
  activeId: string;
  onSelect: (id: string) => void;
  collapsed?: boolean;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export function Sidebar({
  sections,
  activeId,
  onSelect,
  collapsed,
  header,
  footer,
  className,
}: SidebarProps) {
  return (
    <motion.aside
      animate={{ width: collapsed ? 64 : 240 }}
      transition={springs.gentle}
      className={clsx(
        'h-full flex flex-col bg-background-subtle border-r border-default overflow-hidden shrink-0',
        className,
      )}
    >
      {/* Header */}
      {header && <div className="px-3 py-3 border-b border-default shrink-0">{header}</div>}

      {/* Nav sections */}
      <nav className="flex-1 overflow-y-auto py-2">
        {sections.map((section, si) => (
          <div key={si}>
            {si > 0 && <div className="my-2 mx-3 h-px bg-border-muted" />}
            <div className="space-y-0.5 px-2">
              {section.items.map((item) => {
                const isActive = item.id === activeId;
                return (
                  <button
                    key={item.id}
                    onClick={() => onSelect(item.id)}
                    className={clsx(
                      'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-default',
                      isActive
                        ? 'bg-accent-subtle text-accent'
                        : 'text-muted hover:text-foreground hover:bg-background-muted',
                    )}
                  >
                    <span className="shrink-0 w-5 h-5 flex items-center justify-center">
                      {item.icon}
                    </span>
                    {!collapsed && (
                      <>
                        <span className="truncate flex-1 text-left">{item.label}</span>
                        {item.badge && <span className="shrink-0">{item.badge}</span>}
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      {footer && <div className="px-3 py-3 border-t border-default shrink-0">{footer}</div>}
    </motion.aside>
  );
}
