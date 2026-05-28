/**
 * HealthStrip Component
 *
 * Horizontal summary bar showing aggregate run health metrics.
 * SWR-fetches from /api/runtime/projects/{projectId}/pipeline-observability/runs/health.
 */

'use client';

import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { swrFetcher } from '../../../lib/swr-config';
import { Skeleton } from '../../ui/Skeleton';
import type { RunTimeWindow } from '../../../store/pipeline-runs-store';

interface HealthData {
  total: number;
  completed: number;
  failed: number;
  running: number;
  cancelled: number;
  successRate: number;
  avgDurationMs: number;
}

interface HealthStripProps {
  projectId: string;
  window: RunTimeWindow;
  pipelineId?: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

const WINDOW_LABELS: Record<RunTimeWindow, string> = {
  '1h': '1h',
  '24h': '24h',
  '7d': '7d',
};

export function HealthStrip({ projectId, window: timeWindow, pipelineId }: HealthStripProps) {
  const t = useTranslations('pipelines');
  const healthKey = `/api/runtime/projects/${projectId}/pipeline-observability/runs/health?window=${timeWindow}${pipelineId ? `&pipelineId=${pipelineId}` : ''}`;
  const { data, isLoading } = useSWR<{ success: boolean; data: HealthData }>(
    healthKey,
    swrFetcher,
    { refreshInterval: 10_000, revalidateOnFocus: true },
  );

  if (isLoading || !data?.data) {
    return <Skeleton className="h-8 w-full rounded-lg" />;
  }

  const health = data.data;

  return (
    <div className="flex items-center gap-4 px-4 py-2 rounded-lg bg-background-muted text-sm text-muted">
      <span className="font-medium text-foreground">
        {t('health_strip.last_24h', { window: WINDOW_LABELS[timeWindow] })}
      </span>
      <span>{t('health_strip.total', { n: health.total })}</span>
      <span className="text-success">{t('health_strip.completed', { n: health.completed })}</span>
      <span className="text-error">{t('health_strip.failed', { n: health.failed })}</span>
      <span className="text-warning">{t('health_strip.running', { n: health.running })}</span>
      <span>{t('health_strip.avg_duration', { ms: formatDuration(health.avgDurationMs) })}</span>
    </div>
  );
}
