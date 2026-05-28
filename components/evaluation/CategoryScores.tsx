'use client';

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  TrendingUp,
  TrendingDown,
  Minus,
  Sparkles,
  Save,
} from 'lucide-react';
import type { EvalCategoryDetail } from '@/lib/mock-data';
import { cn } from '@/lib/utils';

export function CategoryScores({ categories }: { categories: EvalCategoryDetail[] }) {
  // Sort lowest-first
  const sorted = [...categories].sort((a, b) => a.score - b.score);

  return (
    <section className="rounded-lg border border-border-muted bg-background-subtle overflow-hidden">
      <header className="px-4 py-3 border-b border-border-muted">
        <h2 className="text-sm font-semibold">Performance by category</h2>
        <p className="text-xs text-foreground-muted mt-0.5">
          Sorted lowest-first · click a category to see failing examples
        </p>
      </header>
      <div className="divide-y divide-border-muted">
        {sorted.map((c) => (
          <CategoryRow key={c.name} category={c} />
        ))}
      </div>
    </section>
  );
}

function CategoryRow({ category }: { category: EvalCategoryDetail }) {
  const [open, setOpen] = useState(false);
  const TrendIco =
    category.trend === 'up' ? TrendingUp : category.trend === 'down' ? TrendingDown : Minus;
  const trendCls =
    category.trend === 'up'
      ? 'text-success'
      : category.trend === 'down'
        ? 'text-error'
        : 'text-foreground-meta';
  const barCls =
    category.score >= 90
      ? 'bg-success/70'
      : category.score >= 75
        ? 'bg-warning/70'
        : 'bg-error/70';
  const scoreCls =
    category.score >= 90
      ? 'text-success'
      : category.score >= 75
        ? 'text-warning'
        : 'text-error';

  const hasExamples = (category.failingExamples?.length ?? 0) > 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => hasExamples && setOpen((o) => !o)}
        disabled={!hasExamples}
        className={cn(
          'w-full px-4 py-3 grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 text-left',
          hasExamples ? 'hover:bg-background-muted/40 cursor-pointer' : 'cursor-default',
        )}
      >
        {hasExamples ? (
          open ? (
            <ChevronDown className="size-3.5 text-foreground-muted" />
          ) : (
            <ChevronRight className="size-3.5 text-foreground-muted" />
          )
        ) : (
          <span className="size-3.5" />
        )}

        <div className="min-w-0">
          <div className="text-sm font-medium">{category.name}</div>
          <div className="text-[11px] text-foreground-subtle mt-0.5 font-mono tabular-nums">
            {category.examplesPassed} passed · {category.examplesFailed} failed
          </div>
          <div className="mt-2 h-1 rounded-full bg-background-muted overflow-hidden max-w-md">
            <div
              className={cn('h-full', barCls)}
              style={{ width: `${category.score}%`, transition: 'width 0.6s ease-out' }}
            />
          </div>
        </div>

        <div className={cn('flex items-center gap-1 text-[11px] font-medium', trendCls)}>
          <TrendIco className="size-3" />
        </div>

        <div className={cn('text-xl font-mono tabular-nums font-semibold', scoreCls)}>
          {category.score}
        </div>
      </button>

      {open && hasExamples && (
        <div className="px-4 pb-4 pl-11 space-y-2 animate-fade-in">
          {category.failingExamples!.map((ex) => (
            <div
              key={ex.id}
              className="rounded-md border border-border-muted bg-background-muted/40 p-3 text-xs"
            >
              <div className="text-foreground font-medium mb-2">{ex.intent}</div>
              <div className="grid grid-cols-1 md:grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 mb-3">
                <div className="text-[10px] uppercase tracking-wide text-foreground-meta">
                  Expected
                </div>
                <div className="text-foreground-muted">{ex.expected}</div>
                <div className="text-[10px] uppercase tracking-wide text-foreground-meta">
                  Actual
                </div>
                <div className="text-foreground-muted">{ex.actual}</div>
                <div className="text-[10px] uppercase tracking-wide text-foreground-meta">Why</div>
                <div className="text-foreground-muted">{ex.why}</div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="h-7 px-2 rounded-md text-[11px] font-medium bg-purple/15 text-purple hover:bg-purple/20 transition-colors flex items-center gap-1"
                >
                  <Sparkles className="size-3" />
                  Discuss with Helper
                </button>
                <button
                  type="button"
                  className="h-7 px-2 rounded-md text-[11px] font-medium border border-border-muted text-foreground-muted hover:bg-background-elevated hover:text-foreground transition-colors flex items-center gap-1"
                >
                  <Save className="size-3" />
                  Add to user-defined tests
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
