/**
 * RunMetaHeader Component
 *
 * Displays summary metadata for a run in the detail drawer:
 * status icon, pipeline name, trigger type, timing info.
 */

'use client';

import { useTranslations } from 'next-intl';
import { RunStatusIcon } from './RunStatusIcon';
import { Badge, type BadgeVariant } from '../../ui/Badge';
import type { IPipelineRunRecord } from './types';

interface RunMetaHeaderProps {
  run: IPipelineRunRecord;
}

const TRIGGER_BADGE: Record<string, BadgeVariant> = {
  kafka: 'info',
  schedule: 'accent',
  manual: 'default',
};

function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function RunMetaHeader({ run }: RunMetaHeaderProps) {
  const t = useTranslations('pipelines');

  return (
    <div className="flex flex-col gap-2 pb-4 border-b border-default mb-4">
      <div className="flex items-center gap-2">
        <RunStatusIcon status={run.status} />
        <span className="text-sm font-semibold text-foreground capitalize">{run.status}</span>
        <Badge variant={TRIGGER_BADGE[run.trigger?.type] ?? 'default'}>
          {run.trigger?.type ?? 'unknown'}
        </Badge>
      </div>
      <div className="flex items-center gap-4 text-xs text-muted">
        <span>
          {t('run_detail.started')}: {new Date(run.startedAt).toLocaleString(undefined)}
        </span>
        {run.completedAt && (
          <span>
            {t('run_detail.completed')}: {new Date(run.completedAt).toLocaleString(undefined)}
          </span>
        )}
        <span>
          {t('run_detail.duration')}: {formatDuration(run.durationMs)}
        </span>
      </div>
      {run.error && (
        <div className="text-xs text-error bg-error-subtle px-3 py-1.5 rounded">
          {run.error.message}
        </div>
      )}
    </div>
  );
}
