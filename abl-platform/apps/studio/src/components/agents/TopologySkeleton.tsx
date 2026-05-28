/**
 * TopologySkeleton — shimmer placeholder for the topology mini-map.
 * Matches the polished container: bg-background-muted, no border.
 */

import { clsx } from 'clsx';

export function TopologySkeleton({ className }: { className?: string }) {
  return (
    <div className={clsx('rounded-xl border-0 bg-gradient-surface-sidebar p-6', className)}>
      <div className="flex items-center justify-center gap-8 h-[100px]">
        {/* Supervisor node */}
        <div className="flex flex-col items-center gap-2">
          <div className="w-24 h-8 rounded-full skeleton" />
        </div>

        {/* Connection lines */}
        <div className="flex flex-col gap-3">
          <div className="w-16 h-[1.5px] skeleton" />
          <div className="w-16 h-[1.5px] skeleton" />
          <div className="w-16 h-[1.5px] skeleton" />
        </div>

        {/* Child nodes */}
        <div className="flex flex-col gap-3">
          <div className="w-20 h-7 rounded-full skeleton" />
          <div className="w-20 h-7 rounded-full skeleton" />
          <div className="w-20 h-7 rounded-full skeleton" />
        </div>
      </div>
    </div>
  );
}
