import type { ReactNode } from 'react';

interface MilestoneProps {
  status: 'done' | 'in-progress' | 'planned';
  date?: string;
  children: ReactNode;
}

const dotStyles = {
  done: 'bg-success',
  'in-progress': 'bg-accent animate-pulse',
  planned: 'bg-muted',
} as const;

const textStyles = {
  done: 'text-foreground',
  'in-progress': 'text-foreground font-semibold',
  planned: 'text-subtle',
} as const;

export function Milestone({ status, date, children }: MilestoneProps) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="mt-1.5 flex flex-col items-center">
        <div className={`h-3 w-3 rounded-full ${dotStyles[status]}`} />
        <div className="w-px flex-1 bg-background-muted" />
      </div>
      <div className="flex-1 pb-4">
        {date && (
          <span className="mb-1 inline-block rounded bg-background-muted px-2 py-0.5 text-xs font-medium text-muted">
            {date}
          </span>
        )}
        <div className={textStyles[status]}>{children}</div>
      </div>
    </div>
  );
}
