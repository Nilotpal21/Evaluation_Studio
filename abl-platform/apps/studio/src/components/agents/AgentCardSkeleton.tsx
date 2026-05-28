/**
 * AgentCardSkeleton — shimmer placeholder matching the enhanced 4-zone agent card.
 */

import { clsx } from 'clsx';

export function AgentCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={clsx('rounded-xl border border-default bg-background-elevated p-5', className)}>
      {/* Header: icon + name + status */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg skeleton shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="w-28 h-4 rounded skeleton mb-2" />
          <div className="flex gap-1.5">
            <div className="w-16 h-5 rounded-full skeleton" />
            <div className="w-20 h-5 rounded-full skeleton" />
          </div>
        </div>
        {/* Status dot placeholder */}
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="w-2 h-2 rounded-full skeleton" />
          <div className="w-10 h-3 rounded skeleton" />
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-default my-3" />

      {/* Description — fixed height matching real card */}
      <div className="min-h-[2.625rem] mb-3">
        <div className="w-full h-3.5 rounded skeleton mb-1.5" />
        <div className="w-3/4 h-3.5 rounded skeleton" />
      </div>

      {/* Footer: sparkline + session count + metadata */}
      <div className="flex items-center justify-between pt-3 border-t border-default">
        <div className="flex items-center gap-2">
          {/* Sparkline bars */}
          <div className="flex items-end gap-0.5">
            {[6, 10, 8, 14, 10, 6, 4].map((h, i) => (
              <div key={i} className="w-1 rounded-full skeleton" style={{ height: `${h}px` }} />
            ))}
          </div>
          <div className="w-16 h-3 rounded skeleton" />
        </div>
        <div className="flex items-center gap-3">
          <div className="w-8 h-3 rounded skeleton" />
          <div className="w-14 h-3 rounded skeleton" />
        </div>
      </div>
    </div>
  );
}

export function AgentCardSkeletonGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <AgentCardSkeleton key={i} />
      ))}
    </div>
  );
}
