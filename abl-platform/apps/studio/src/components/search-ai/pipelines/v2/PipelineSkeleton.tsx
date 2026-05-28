/**
 * PipelineSkeleton — Shimmer skeleton shown during pipeline load/switch.
 *
 * Matches the V2 editor layout: top bar → canvas area + right detail panel (420px).
 * No left sidebar — the V2 layout uses swim-lane headers on the canvas.
 */

import { Skeleton } from '../../../ui/Skeleton';

export function PipelineSkeleton() {
  return (
    <div className="flex h-full flex-col">
      {/* Top bar skeleton — pipeline selector + toolbar */}
      <div className="flex items-center justify-between border-b border-default px-4 py-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-7 w-40 rounded-md" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-8 w-28 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
        </div>
      </div>

      {/* Body: Canvas (flex-1) + Detail Panel (420px) */}
      <div className="flex flex-1 overflow-hidden">
        {/* Canvas area — centered DAG-like skeleton */}
        <div className="relative flex flex-1 items-center justify-center bg-background-muted">
          <div className="flex items-center gap-8">
            {/* Ingress node skeleton */}
            <div className="animate-pulse">
              <Skeleton className="h-16 w-[180px] rounded-lg" />
            </div>

            {/* Flow lanes — two rows of stage cards */}
            <div className="flex flex-col gap-10">
              {/* Top lane */}
              <div className="space-y-1">
                <Skeleton className="h-4 w-28" />
                <div className="flex items-center gap-6">
                  <Skeleton className="h-16 w-[200px] rounded-lg" />
                  <Skeleton className="h-16 w-[200px] rounded-lg" />
                  <Skeleton className="h-16 w-[200px] rounded-lg" />
                </div>
              </div>
              {/* Bottom lane */}
              <div className="space-y-1">
                <Skeleton className="h-4 w-24" />
                <div className="flex items-center gap-6">
                  <Skeleton className="h-16 w-[200px] rounded-lg" />
                  <Skeleton className="h-16 w-[200px] rounded-lg" />
                </div>
              </div>
            </div>

            {/* Shared output nodes */}
            <div className="flex items-center gap-6">
              <Skeleton className="h-16 w-[200px] rounded-lg" />
              <Skeleton className="h-16 w-[200px] rounded-lg" />
              <Skeleton className="h-14 w-[160px] rounded-lg" />
            </div>
          </div>
        </div>

        {/* Right detail panel skeleton — 420px */}
        <div className="flex h-full w-[420px] shrink-0 flex-col border-l border-default bg-background-elevated">
          <div className="border-b border-default px-4 py-3">
            <Skeleton className="h-5 w-32" />
          </div>
          <div className="flex flex-1 flex-col items-center justify-center px-6">
            <Skeleton className="mb-3 h-8 w-8 rounded-full" />
            <Skeleton className="mb-1 h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
      </div>
    </div>
  );
}
