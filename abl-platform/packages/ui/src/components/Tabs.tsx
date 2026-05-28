/**
 * Tabs Component
 *
 * Animated tab bar with underline indicator using Framer Motion layoutId.
 */

import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { springs } from '../tokens/index.js';

interface Tab {
  id: string;
  label: string;
  icon?: React.ReactNode;
  count?: number;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  layoutId?: string;
  className?: string;
}

export function Tabs({
  tabs,
  activeTab,
  onTabChange,
  layoutId = 'tab-indicator',
  className,
}: TabsProps) {
  return (
    <div className={clsx('flex items-center gap-1 border-b border-default', className)}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={clsx(
              'relative flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-default',
              isActive ? 'text-foreground' : 'text-muted hover:text-foreground',
            )}
          >
            {tab.icon && <span className="shrink-0">{tab.icon}</span>}
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={clsx(
                  'ml-1 px-1.5 py-0.5 rounded-full text-xs',
                  isActive ? 'bg-accent-subtle text-accent' : 'bg-background-muted text-muted',
                )}
              >
                {tab.count}
              </span>
            )}
            {isActive && (
              <motion.div
                layoutId={layoutId}
                className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent rounded-full"
                transition={springs.snappy}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
