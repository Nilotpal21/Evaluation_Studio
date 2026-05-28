import { BookOpen } from 'lucide-react';
import type { EvalReport } from '@/lib/mock-data';

export function CitationCoverage({ report }: { report: EvalReport }) {
  return (
    <section className="rounded-lg border border-border-muted bg-background-subtle p-4 flex items-start gap-3 flex-wrap">
      <div className="size-9 rounded-md bg-background-elevated border border-border-muted flex items-center justify-center shrink-0">
        <BookOpen className="size-4 text-foreground-muted" />
      </div>
      <div className="flex-1 min-w-[280px]">
        <div className="text-sm text-foreground">
          Citation coverage:{' '}
          <span className="font-semibold tabular-nums">{report.citationCoverage}%</span> of
          member-impacting responses cited a source.
        </div>
        <div className="text-xs text-foreground-muted mt-1.5">
          Knowledge sources used most:{' '}
          {report.topUsedSources.slice(0, 3).map((s, i) => (
            <span key={s.name}>
              <span className="text-foreground">{s.name}</span>{' '}
              <span className="font-mono text-foreground-subtle">({s.uses})</span>
              {i < Math.min(report.topUsedSources.length, 3) - 1 ? ', ' : ''}
            </span>
          ))}
          .
        </div>
        <div className="text-[11px] text-foreground-subtle mt-1.5 font-mono">
          Source health: {report.sourceHealth.active} active · {report.sourceHealth.stale} stale ·{' '}
          {report.sourceHealth.deprecated} deprecated
        </div>
      </div>
    </section>
  );
}
