'use client';

import Link from 'next/link';
import {
  Bot,
  ArrowUpRight,
  TrendingUp,
  TrendingDown,
  Minus,
  GitPullRequestArrow,
  type LucideIcon,
} from 'lucide-react';
import {
  apps,
  projectAppMap,
  getEvalReport,
  getProjectById,
} from '@/lib/mock-data';
import { useActiveProjectId } from '@/lib/persona';
import { Footer } from '@/components/shell/Footer';
import { cn } from '@/lib/utils';

export default function EvaluationsPage() {
  const activeProjectId = useActiveProjectId();
  const project = getProjectById(activeProjectId);
  const projectApps = apps.filter((a) => projectAppMap[a.id] === activeProjectId);

  const tenantAvg =
    projectApps.length === 0
      ? 0
      : Math.round(
          projectApps.reduce((sum, a) => sum + a.evaluationScore, 0) /
            projectApps.length,
        );

  return (
    <div className="space-y-5">
      <header className="pb-4 border-b border-border-muted">
        <h1 className="text-2xl font-semibold tracking-tight">Evaluations</h1>
        <p className="text-xs text-foreground-muted mt-1.5">
          {projectApps.length} apps in {project?.name ?? 'this project'} · average score{' '}
          <span className="font-mono tabular-nums text-foreground">{tenantAvg}</span> · click any
          app for the full report.
        </p>
      </header>

      <section className="rounded-lg border border-border-muted bg-background-subtle overflow-hidden">
        <div className="grid grid-cols-[2fr_1fr_1fr_max-content_max-content] items-center gap-3 px-4 py-2.5 border-b border-border-muted text-[10px] uppercase tracking-wide text-foreground-meta font-medium">
          <div>App</div>
          <div className="text-right">Score</div>
          <div className="text-right">Trend</div>
          <div className="text-right">Sources</div>
          <div></div>
        </div>

        {projectApps.length === 0 && (
          <p className="px-4 py-12 text-xs text-foreground-muted text-center">
            No apps in this project yet. Upload an SOP to generate one.
          </p>
        )}

        {projectApps.map((a) => {
          const report = getEvalReport(a.id);
          const TrendIco: LucideIcon =
            a.evaluationTrend === 'up'
              ? TrendingUp
              : a.evaluationTrend === 'down'
                ? TrendingDown
                : Minus;
          const trendCls =
            a.evaluationTrend === 'up'
              ? 'text-success'
              : a.evaluationTrend === 'down'
                ? 'text-error'
                : 'text-foreground-meta';
          const scoreCls =
            a.evaluationScore >= 90
              ? 'bg-success-subtle text-success'
              : a.evaluationScore >= 75
                ? 'bg-warning-subtle text-warning'
                : 'bg-error-subtle text-error';

          const totalTests =
            report.sources.preBuiltScenarios.count +
            report.sources.sopDerived.count +
            report.sources.userDefined.count;

          return (
            <Link
              key={a.id}
              href={`/apps/${a.id}/evaluation`}
              className="grid grid-cols-[2fr_1fr_1fr_max-content_max-content] items-center gap-3 px-4 py-3 border-b last:border-b-0 border-border-muted hover:bg-background-muted/40 transition-colors group"
            >
              <div className="flex items-start gap-2.5 min-w-0">
                <div className="size-7 rounded-md bg-background-elevated border border-border-muted flex items-center justify-center shrink-0">
                  <Bot className="size-3.5 text-foreground-muted group-hover:text-foreground transition-colors" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-mono truncate">{a.name}</div>
                  <div className="text-[11px] text-foreground-subtle mt-0.5 font-mono">
                    Run #{report.runNumber} · {report.ranAgo}
                  </div>
                </div>
              </div>

              <div className="text-right">
                <span
                  className={cn(
                    'inline-flex items-center px-1.5 py-0.5 rounded text-sm font-medium tabular-nums font-mono',
                    scoreCls,
                  )}
                >
                  {a.evaluationScore}
                </span>
              </div>

              <div className="text-right">
                <span className={cn('inline-flex items-center gap-1 text-xs font-medium', trendCls)}>
                  <TrendIco className="size-3" />
                  {a.evaluationDelta > 0 ? '+' : ''}
                  {a.evaluationDelta.toFixed(1)}
                </span>
              </div>

              <div className="text-right text-[11px] text-foreground-subtle font-mono tabular-nums">
                {totalTests} tests
              </div>

              <div className="flex items-center gap-1 text-foreground-subtle group-hover:text-foreground-muted transition-colors">
                <GitPullRequestArrow className="size-3.5" />
                <ArrowUpRight className="size-3" />
              </div>
            </Link>
          );
        })}
      </section>

      <Footer />
    </div>
  );
}
