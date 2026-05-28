'use client';

import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Tooltip, TooltipProvider } from '@/components/ui/Tooltip';
import { getHealthVisualTone } from '@/lib/arch-ai/health-score';
import { cn } from '@/lib/utils';

export interface ProjectHealthData {
  totalAgents: number;
  passing: number;
  warnings: number;
  errors: number;
  healthPercent?: number;
  passedChecks?: number;
  totalChecks?: number;
  projectWarnings?: number;
  projectErrors?: number;
  overall: string;
  topIssue: string | null;
}

interface ProjectHealthBarProps extends ProjectHealthData {
  isLoading?: boolean;
}

export function ProjectHealthBar({
  totalAgents,
  passing,
  warnings,
  errors,
  healthPercent,
  passedChecks,
  totalChecks,
  projectWarnings = 0,
  projectErrors = 0,
  overall,
  topIssue,
  isLoading,
}: ProjectHealthBarProps) {
  const t = useTranslations('arch_in_project');

  if (isLoading) {
    return (
      <div className="animate-pulse rounded-xl border border-border bg-background-muted p-3">
        <div className="mb-2 h-3 w-24 rounded bg-background-subtle skeleton" />
        <div className="h-1.5 w-full rounded-full bg-background-subtle skeleton" />
      </div>
    );
  }

  if (totalAgents === 0) return null;

  const pct = healthPercent ?? (totalAgents > 0 ? Math.round((passing / totalAgents) * 100) : 0);
  const scoreSummary =
    passedChecks != null && totalChecks != null
      ? t('health_checks_passed', { passed: passedChecks, total: totalChecks })
      : t('health_agents_clean', { passing, total: totalAgents });
  const tone = getHealthVisualTone(overall, pct, { success: 90, warning: 70 });
  const projectSummary =
    projectErrors > 0
      ? t('health_project_errors', { count: projectErrors })
      : projectWarnings > 0
        ? t('health_project_warnings', { count: projectWarnings })
        : null;

  return (
    <div className="rounded-xl border border-border bg-background-muted p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-foreground-muted">Health</span>
          <TooltipProvider>
            <Tooltip content={t('health_score_tooltip')} side="top">
              <button
                type="button"
                className="rounded p-0.5 text-foreground-muted transition-colors hover:text-foreground"
                aria-label={t('health_score_label')}
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </TooltipProvider>
        </div>
        <span
          className={cn(
            'text-xs font-bold',
            tone === 'success'
              ? 'text-success'
              : tone === 'warning'
                ? 'text-warning'
                : 'text-error',
          )}
        >
          {pct}%
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-background-subtle">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : 'bg-error',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-foreground-muted">{scoreSummary}</p>
      {projectSummary && <p className="mt-1 text-xs text-warning">{projectSummary}</p>}
      {topIssue && <p className="mt-2 truncate text-xs text-warning">{topIssue}</p>}
    </div>
  );
}
