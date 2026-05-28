/**
 * RunsTable Component
 *
 * Table of pipeline run summaries. Each row shows status icon, pipeline name,
 * trigger badge, started time (relative), and duration.
 */

'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw, ListX } from 'lucide-react';
import { clsx } from 'clsx';
import { RunStatusIcon } from './RunStatusIcon';
import { Badge, type BadgeVariant } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import type { RunSummary } from './types';

interface RunsTableProps {
  data?: RunSummary[];
  loading: boolean;
  onRowClick: (runId: string) => void;
  onRefresh: () => void;
}

const TRIGGER_BADGE_VARIANT: Record<string, BadgeVariant> = {
  kafka: 'info',
  schedule: 'accent',
  manual: 'default',
};

function formatRelativeTime(date: Date | string): string {
  const now = Date.now();
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffMs = now - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${diffDay}d ago`;
}

function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function kindSuffix(kind: string): string {
  if (kind === 'builtin') return ' (B)';
  if (kind === 'custom') return ' (C)';
  return '';
}

export function RunsTable({ data, loading, onRowClick, onRefresh }: RunsTableProps) {
  const t = useTranslations('pipelines');

  const handleRowClick = useCallback(
    (runId: string) => {
      onRowClick(runId);
    },
    [onRowClick],
  );

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <EmptyState
        icon={<ListX className="w-6 h-6" />}
        title={t('empty_no_runs')}
        description={t('empty_no_runs_hint')}
      />
    );
  }

  return (
    <div>
      <div className="flex justify-end mb-2">
        <Button variant="ghost" size="xs" onClick={() => onRefresh()}>
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-default text-left text-muted">
              <th className="py-2 px-3 font-medium w-8">{t('runs_table.status')}</th>
              <th className="py-2 px-3 font-medium">{t('runs_table.pipeline')}</th>
              <th className="py-2 px-3 font-medium">{t('runs_table.trigger')}</th>
              <th className="py-2 px-3 font-medium">{t('runs_table.started')}</th>
              <th className="py-2 px-3 font-medium">{t('runs_table.duration')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((run) => (
              <tr
                key={run.runId}
                onClick={() => handleRowClick(run.runId)}
                className={clsx(
                  'border-b border-default cursor-pointer transition-default',
                  'hover:bg-background-muted',
                )}
              >
                <td className="py-2.5 px-3">
                  <RunStatusIcon status={run.status} />
                </td>
                <td className="py-2.5 px-3 text-foreground font-medium">
                  {run.pipelineName}
                  <span className="text-muted text-xs ml-1">{kindSuffix(run.pipelineKind)}</span>
                </td>
                <td className="py-2.5 px-3">
                  <Badge variant={TRIGGER_BADGE_VARIANT[run.trigger?.type] ?? 'default'}>
                    {run.trigger?.type ?? 'unknown'}
                  </Badge>
                </td>
                <td className="py-2.5 px-3 text-muted">{formatRelativeTime(run.startedAt)}</td>
                <td className="py-2.5 px-3 text-muted">{formatDuration(run.durationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
