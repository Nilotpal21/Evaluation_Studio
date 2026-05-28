'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../lib/cn';

interface TabItem {
  id: string;
  label: string;
  content: React.ReactNode;
}

interface TabsProps {
  tabs: TabItem[];
  defaultValue?: string;
  className?: string;
}

export function Tabs({ tabs, defaultValue, className }: TabsProps) {
  const defaultTab = defaultValue ?? tabs[0]?.id;

  return (
    <TabsPrimitive.Root defaultValue={defaultTab} className={cn('w-full', className)}>
      <TabsPrimitive.List className={cn('flex items-center gap-1 border-b border-border', 'mb-4')}>
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.id}
            value={tab.id}
            className={cn(
              'relative px-4 py-2 text-sm font-medium transition-colors',
              'text-foreground-muted',
              'hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              'data-[state=active]:text-foreground',
              // Active indicator bar
              'after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-[2px]',
              'after:bg-transparent data-[state=active]:after:bg-accent',
              'after:transition-colors',
            )}
          >
            {tab.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>

      {tabs.map((tab) => (
        <TabsPrimitive.Content key={tab.id} value={tab.id} className="focus-visible:outline-none">
          {tab.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
