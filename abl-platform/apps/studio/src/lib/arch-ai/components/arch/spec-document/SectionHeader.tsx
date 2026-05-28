'use client';

import { useState } from 'react';
import { ChevronRight, Lock } from 'lucide-react';
import { clsx } from 'clsx';

interface SectionHeaderProps {
  title: string;
  status: 'empty' | 'draft' | 'complete';
  locked?: boolean;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

const STATUS_COLORS: Record<SectionHeaderProps['status'], string> = {
  empty: 'bg-foreground-muted/30',
  draft: 'bg-warning',
  complete: 'bg-success',
};

export function SectionHeader({
  title,
  status,
  locked,
  defaultExpanded = false,
  children,
}: SectionHeaderProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="border-b border-border/40">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-background-muted/50"
      >
        <ChevronRight
          className={clsx(
            'h-3.5 w-3.5 text-foreground-muted transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className={clsx('ml-1 h-2 w-2 rounded-full', STATUS_COLORS[status])} />
        {locked && <Lock className="ml-auto h-3 w-3 text-foreground-muted/50" />}
      </button>
      {expanded && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}
