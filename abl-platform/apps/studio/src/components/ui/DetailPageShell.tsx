'use client';

import { type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { clsx } from 'clsx';
import { Tabs } from './Tabs';

interface TabDef {
  id: string;
  label: string;
}

interface DetailPageShellProps {
  title: string;
  /** When true, suppresses the h1 title row — use when the AppShell header already shows the title. */
  hideTitle?: boolean;
  description?: string;
  backTo?: { label: string; onClick: () => void };
  actions?: ReactNode;
  tabs?: TabDef[];
  activeTab?: string;
  onTabChange?: (tabId: string) => void;
  tabsLayoutId?: string;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  className?: string;
  children: ReactNode;
}

const maxWidthClasses = {
  sm: 'max-w-2xl',
  md: 'max-w-4xl',
  lg: 'max-w-5xl',
  xl: 'max-w-6xl',
  full: 'max-w-full',
};

export function DetailPageShell({
  title,
  hideTitle = false,
  description,
  backTo,
  actions,
  tabs,
  activeTab,
  onTabChange,
  tabsLayoutId,
  maxWidth = 'lg',
  className,
  children,
}: DetailPageShellProps) {
  return (
    <div className={clsx('h-full overflow-y-auto', className)}>
      <div className={clsx('mx-auto px-6 py-6', maxWidthClasses[maxWidth])}>
        {/* Header row — hidden when AppShell content header already displays the title */}
        {!hideTitle && (
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              {backTo && (
                <button
                  onClick={backTo.onClick}
                  className="flex items-center gap-1.5 text-sm text-muted hover:text-foreground transition-default shrink-0"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span className="hidden sm:inline">{backTo.label}</span>
                </button>
              )}
              <div className="min-w-0">
                <h1 className="text-2xl font-semibold text-foreground truncate tracking-tight">
                  {title}
                </h1>
                {description && <p className="mt-1 text-sm text-muted">{description}</p>}
              </div>
            </div>
            {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
          </div>
        )}

        {/* Tab bar */}
        {tabs && onTabChange && activeTab && (
          <div className="mt-4">
            <Tabs
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={onTabChange}
              layoutId={tabsLayoutId}
            />
          </div>
        )}

        {/* Content */}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}
