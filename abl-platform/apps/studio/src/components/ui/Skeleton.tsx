/**
 * Skeleton Components
 *
 * Shimmer loading placeholders for better perceived performance.
 * Inspired by Linear and Vercel's loading states.
 */

import clsx from 'clsx';

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return <div className={clsx('skeleton', className)} />;
}

// Pre-built skeleton variants
export function SkeletonText({ className, lines = 1 }: SkeletonProps & { lines?: number }) {
  return (
    <div className={clsx('space-y-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={clsx('h-4', i === lines - 1 && lines > 1 ? 'w-3/4' : 'w-full')}
        />
      ))}
    </div>
  );
}

export function SkeletonAvatar({
  className,
  size = 'md',
}: SkeletonProps & { size?: 'sm' | 'md' | 'lg' }) {
  const sizes = {
    sm: 'w-6 h-6',
    md: 'w-8 h-8',
    lg: 'w-12 h-12',
  };

  return <Skeleton className={clsx('rounded-full', sizes[size], className)} />;
}

export function SkeletonButton({ className }: SkeletonProps) {
  return <Skeleton className={clsx('h-9 w-24 rounded-lg', className)} />;
}

export function SkeletonCard({ className }: SkeletonProps) {
  return (
    <div className={clsx('p-4 rounded-lg bg-background-muted border border-default', className)}>
      <div className="flex items-center gap-3 mb-4">
        <SkeletonAvatar />
        <div className="flex-1">
          <Skeleton className="h-4 w-32 mb-2" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <SkeletonText lines={3} />
    </div>
  );
}

export function SkeletonTable({
  className,
  rows = 5,
  cols = 4,
}: SkeletonProps & { rows?: number; cols?: number }) {
  const columns = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };

  return (
    <div className={clsx('space-y-2', className)}>
      <div className="grid gap-3" style={columns}>
        {Array.from({ length: cols }).map((_, col) => (
          <Skeleton key={`header-${col}`} className="h-4 rounded" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, row) => (
          <div key={`row-${row}`} className="grid gap-3" style={columns}>
            {Array.from({ length: cols }).map((_, col) => (
              <Skeleton key={`cell-${row}-${col}`} className="h-8 rounded" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkeletonFormSection({
  className,
  sections = 2,
}: SkeletonProps & { sections?: number }) {
  return (
    <div className={clsx('space-y-6', className)}>
      {Array.from({ length: sections }).map((_, section) => (
        <div key={section} className="space-y-3">
          <Skeleton className="h-5 w-40 rounded" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ))}
    </div>
  );
}

// Skeleton for the app navigator
export function SkeletonAppNavigator({ className }: SkeletonProps) {
  return (
    <div className={clsx('p-3 space-y-3', className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-4 rounded" />
      </div>

      {/* Search */}
      <Skeleton className="h-8 w-full rounded-lg" />

      {/* App items */}
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="space-y-1">
            <div className="flex items-center gap-2 p-2">
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-4 flex-1" />
            </div>
            {i === 1 && (
              <div className="ml-6 space-y-1">
                {[1, 2].map((j) => (
                  <div key={j} className="flex items-center gap-2 p-1.5">
                    <Skeleton className="h-3.5 w-3.5" />
                    <Skeleton className="h-3.5 w-24" />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Skeleton for the graph view
export function SkeletonGraph({ className }: SkeletonProps) {
  return (
    <div className={clsx('relative w-full h-full flex items-center justify-center', className)}>
      {/* Fake nodes */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex items-center gap-16">
          {/* Entry node */}
          <Skeleton className="w-14 h-14 rounded-full" />

          {/* Step nodes */}
          <div className="space-y-4">
            <Skeleton className="w-32 h-16 rounded-lg" />
            <Skeleton className="w-32 h-16 rounded-lg" />
          </div>

          {/* Decision node */}
          <div className="rotate-45">
            <Skeleton className="w-16 h-16 rounded-lg" />
          </div>

          {/* More step nodes */}
          <div className="space-y-4">
            <Skeleton className="w-32 h-16 rounded-lg" />
            <Skeleton className="w-32 h-16 rounded-lg" />
          </div>

          {/* Exit node */}
          <Skeleton className="w-14 h-14 rounded-full" />
        </div>
      </div>

      {/* Fake edges (lines) */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-30">
        <line
          x1="15%"
          y1="50%"
          x2="30%"
          y2="40%"
          stroke="currentColor"
          strokeWidth="2"
          className="text-muted"
        />
        <line
          x1="15%"
          y1="50%"
          x2="30%"
          y2="60%"
          stroke="currentColor"
          strokeWidth="2"
          className="text-muted"
        />
        <line
          x1="38%"
          y1="40%"
          x2="50%"
          y2="50%"
          stroke="currentColor"
          strokeWidth="2"
          className="text-muted"
        />
        <line
          x1="38%"
          y1="60%"
          x2="50%"
          y2="50%"
          stroke="currentColor"
          strokeWidth="2"
          className="text-muted"
        />
        <line
          x1="58%"
          y1="50%"
          x2="70%"
          y2="40%"
          stroke="currentColor"
          strokeWidth="2"
          className="text-muted"
        />
        <line
          x1="58%"
          y1="50%"
          x2="70%"
          y2="60%"
          stroke="currentColor"
          strokeWidth="2"
          className="text-muted"
        />
        <line
          x1="78%"
          y1="40%"
          x2="85%"
          y2="50%"
          stroke="currentColor"
          strokeWidth="2"
          className="text-muted"
        />
        <line
          x1="78%"
          y1="60%"
          x2="85%"
          y2="50%"
          stroke="currentColor"
          strokeWidth="2"
          className="text-muted"
        />
      </svg>
    </div>
  );
}

// Skeleton for debug tabs
export function SkeletonDebugTabs({ className }: SkeletonProps) {
  return (
    <div className={clsx('', className)}>
      {/* Tab bar */}
      <div className="flex gap-1 p-2 border-b border-default">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-7 w-20 rounded-md" />
        ))}
      </div>

      {/* Content */}
      <div className="p-3 space-y-3">
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
    </div>
  );
}

// Skeleton for chat messages — subtle rounded bubbles
export function SkeletonChat({ className }: SkeletonProps) {
  return (
    <div className={clsx('space-y-5 px-2 py-6', className)}>
      {/* User bubble */}
      <div className="flex justify-end">
        <Skeleton className="h-10 w-44 rounded-2xl rounded-tr-md" />
      </div>

      {/* Assistant bubble */}
      <div className="flex justify-start">
        <div className="space-y-2">
          <Skeleton className="h-4 w-56 rounded-full" />
          <Skeleton className="h-4 w-40 rounded-full" />
        </div>
      </div>

      {/* User bubble */}
      <div className="flex justify-end">
        <Skeleton className="h-10 w-32 rounded-2xl rounded-tr-md" />
      </div>

      {/* Typing indicator */}
      <div className="flex justify-start">
        <div className="flex items-center gap-1.5 px-4 py-3 rounded-2xl bg-background-muted">
          <div
            className="w-1.5 h-1.5 rounded-full bg-foreground-subtle/40 skeleton-pulse"
            style={{ animationDelay: '0ms' }}
          />
          <div
            className="w-1.5 h-1.5 rounded-full bg-foreground-subtle/40 skeleton-pulse"
            style={{ animationDelay: '150ms' }}
          />
          <div
            className="w-1.5 h-1.5 rounded-full bg-foreground-subtle/40 skeleton-pulse"
            style={{ animationDelay: '300ms' }}
          />
        </div>
      </div>
    </div>
  );
}

export default Skeleton;
