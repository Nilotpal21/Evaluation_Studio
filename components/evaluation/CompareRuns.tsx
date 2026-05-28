'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { EvalCategoryDetail } from '@/lib/mock-data';
import { cn } from '@/lib/utils';

export function CompareRuns({
  runNumber,
  categories,
}: {
  runNumber: number;
  categories: EvalCategoryDetail[];
}) {
  const [open, setOpen] = useState(false);

  // Filter to categories that have a prev score
  const rows = categories.filter((c) => typeof c.prevScore === 'number');
  if (rows.length === 0) return null;

  return (
    <section className="rounded-lg border border-border-muted bg-background-subtle overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-background-muted/40 transition-colors"
      >
        <div>
          <h2 className="text-sm font-semibold">Compare to previous run</h2>
          <p className="text-xs text-foreground-muted mt-0.5">
            Run #{runNumber - 1} vs run #{runNumber}
          </p>
        </div>
        {open ? (
          <ChevronDown className="size-4 text-foreground-muted" />
        ) : (
          <ChevronRight className="size-4 text-foreground-muted" />
        )}
      </button>
      {open && (
        <div className="border-t border-border-muted animate-fade-in">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr] px-4 py-2.5 border-b border-border-muted text-[10px] uppercase tracking-wide text-foreground-meta font-medium gap-3">
            <div>Category</div>
            <div className="text-right">Run #{runNumber - 1}</div>
            <div className="text-right">Run #{runNumber}</div>
            <div className="text-right">Δ</div>
          </div>
          {rows.map((c) => {
            const delta = c.score - (c.prevScore ?? 0);
            const deltaCls =
              delta > 0 ? 'text-success' : delta < 0 ? 'text-error' : 'text-foreground-meta';
            return (
              <div
                key={c.name}
                className="grid grid-cols-[2fr_1fr_1fr_1fr] px-4 py-2.5 border-b last:border-b-0 border-border-muted text-xs gap-3 tabular-nums hover:bg-background-muted/40 transition-colors"
              >
                <div className="text-foreground">{c.name}</div>
                <div className="text-right text-foreground-muted font-mono">{c.prevScore}</div>
                <div className="text-right text-foreground font-mono">{c.score}</div>
                <div className={cn('text-right font-mono font-medium', deltaCls)}>
                  {delta > 0 ? '+' : ''}
                  {delta === 0 ? '—' : delta}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
