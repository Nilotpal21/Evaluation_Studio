'use client';

import clsx from 'clsx';

function Shimmer({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse bg-surface-2 rounded', className)} />;
}

export function TableSkeleton({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-4">
      <div className="flex gap-4 mb-4">
        {Array.from({ length: cols }, (_, i) => (
          <Shimmer key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-4">
          {Array.from({ length: cols }, (_, j) => (
            <Shimmer key={j} className="h-8 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function TreeSkeleton({ depth = 3 }: { depth?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: depth }, (_, i) => (
        <div key={i} style={{ paddingLeft: i * 20 }} className="flex items-center gap-2">
          <Shimmer className="w-4 h-4 rounded-full" />
          <Shimmer className="h-6 flex-1 max-w-[200px]" />
          <Shimmer className="h-4 w-16" />
          <Shimmer className="h-4 w-12" />
        </div>
      ))}
    </div>
  );
}

export function NodeDetailSkeleton() {
  return (
    <div className="p-4 space-y-4">
      <Shimmer className="h-6 w-48" />
      <div className="grid grid-cols-4 gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i}>
            <Shimmer className="h-3 w-12 mb-1" />
            <Shimmer className="h-5 w-16" />
          </div>
        ))}
      </div>
      <Shimmer className="h-8 w-full" />
      <Shimmer className="h-32 w-full" />
    </div>
  );
}

export function InlineSkeleton({ width = 'w-24' }: { width?: string }) {
  return <Shimmer className={clsx('h-4 inline-block', width)} />;
}
