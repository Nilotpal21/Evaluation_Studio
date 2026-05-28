import type { ReactNode } from 'react';

interface MilestoneProps {
  status: 'done' | 'in-progress' | 'planned';
  date?: string;
  children: ReactNode;
}

const dotStyles = {
  done: 'bg-green-500',
  'in-progress': 'bg-blue-500 animate-pulse',
  planned: 'bg-gray-400',
} as const;

const textStyles = {
  done: 'text-slate-700',
  'in-progress': 'text-slate-900 font-semibold',
  planned: 'text-slate-500',
} as const;

export function Milestone({ status, date, children }: MilestoneProps) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="mt-1.5 flex flex-col items-center">
        <div className={`h-3 w-3 rounded-full ${dotStyles[status]}`} />
        <div className="w-px flex-1 bg-slate-200" />
      </div>
      <div className="flex-1 pb-4">
        {date && (
          <span className="mb-1 inline-block rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            {date}
          </span>
        )}
        <div className={textStyles[status]}>{children}</div>
      </div>
    </div>
  );
}
