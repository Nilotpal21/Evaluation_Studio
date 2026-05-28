/**
 * Tabs Component
 *
 * Animated tab bar with underline indicator using Framer Motion layoutId.
 * Implements WAI-ARIA Tabs pattern with roving tabindex keyboard navigation.
 */

import { useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { springs } from '../../lib/animation';

interface Tab {
  id: string;
  label: string;
  icon?: React.ReactNode;
  count?: number;
  testid?: string;
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
  const tablistRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const tabIds = tabs.map((t) => t.id);
      const currentIndex = tabIds.indexOf(activeTab);
      let newIndex = currentIndex;

      switch (e.key) {
        case 'ArrowRight':
          newIndex = (currentIndex + 1) % tabIds.length;
          break;
        case 'ArrowLeft':
          newIndex = (currentIndex - 1 + tabIds.length) % tabIds.length;
          break;
        case 'Home':
          newIndex = 0;
          break;
        case 'End':
          newIndex = tabIds.length - 1;
          break;
        default:
          return;
      }

      e.preventDefault();
      onTabChange(tabIds[newIndex]);

      // Focus the newly selected tab button
      const tablistEl = tablistRef.current;
      if (tablistEl) {
        const buttons = tablistEl.querySelectorAll<HTMLButtonElement>('[role="tab"]');
        buttons[newIndex]?.focus();
      }
    },
    [tabs, activeTab, onTabChange],
  );

  return (
    <div
      ref={tablistRef}
      role="tablist"
      onKeyDown={handleKeyDown}
      className={clsx('flex items-center gap-1 border-b border-default', className)}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            data-testid={tab.testid}
            onClick={() => onTabChange(tab.id)}
            className={clsx(
              'relative flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-default',
              isActive ? 'text-foreground' : 'text-muted hover:text-foreground',
            )}
          >
            {tab.icon && <span className="shrink-0">{tab.icon}</span>}
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
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
