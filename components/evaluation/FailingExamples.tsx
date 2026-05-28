import { Sparkles, Save } from 'lucide-react';
import type { EvalCategoryDetail } from '@/lib/mock-data';

export function FailingExamples({ categories }: { categories: EvalCategoryDetail[] }) {
  // Collect all failing examples, sorted by category score (lowest first)
  const all = [...categories]
    .sort((a, b) => a.score - b.score)
    .flatMap((c) =>
      (c.failingExamples ?? []).map((ex) => ({ ...ex, categoryName: c.name, categoryScore: c.score })),
    );

  if (all.length === 0) return null;

  return (
    <section className="rounded-lg border border-border-muted bg-background-subtle overflow-hidden">
      <header className="px-4 py-3 border-b border-border-muted">
        <h2 className="text-sm font-semibold">Top failing examples</h2>
        <p className="text-xs text-foreground-muted mt-0.5">
          Cases where the app&apos;s response didn&apos;t meet the evaluation criteria
        </p>
      </header>
      <div className="divide-y divide-border-muted">
        {all.slice(0, 5).map((ex) => (
          <div key={ex.id} className="px-4 py-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium">
                {ex.categoryName}
              </span>
              <span className="text-foreground-subtle">·</span>
              <span className="text-[10px] font-mono text-foreground-subtle">
                score {ex.categoryScore}
              </span>
            </div>
            <div className="text-sm font-medium mb-3">{ex.intent}</div>
            <div className="grid grid-cols-1 md:grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs mb-3">
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
                className="h-7 px-2.5 rounded-md text-[11px] font-medium bg-purple/15 text-purple hover:bg-purple/20 transition-colors flex items-center gap-1"
              >
                <Sparkles className="size-3" />
                Discuss with Helper
              </button>
              <button
                type="button"
                className="h-7 px-2.5 rounded-md text-[11px] font-medium border border-border-muted text-foreground-muted hover:bg-background-elevated hover:text-foreground transition-colors flex items-center gap-1"
              >
                <Save className="size-3" />
                Add to user-defined tests
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
