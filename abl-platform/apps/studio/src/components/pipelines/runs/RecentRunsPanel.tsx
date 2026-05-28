/**
 * RecentRunsPanel Component
 *
 * Main component for the Runs tab. Composes HealthStrip, RunFilters,
 * RunsTable, and RunDetailDrawer. Auto-polls every 5s.
 */

'use client';

import useSWR from 'swr';
import type { PipelineObservabilityResponseMeta } from '@agent-platform/shared';
import { swrFetcher } from '../../../lib/swr-config';
import { useRunsStore } from '../../../store/pipeline-runs-store';
import { PipelineObservabilityScopeNotice } from '../PipelineObservabilityScopeNotice';
import { HealthStrip } from './HealthStrip';
import { RunFilters } from './RunFilters';
import { RunsTable } from './RunsTable';
import { RunDetailDrawer } from './RunDetailDrawer';
import type { RunSummary } from './types';

interface RecentRunsPanelProps {
  projectId: string;
  pipelineIdOverride?: string;
}

interface RunsListResponse {
  meta?: PipelineObservabilityResponseMeta;
  data: RunSummary[];
  pagination: { total: number; limit: number; offset: number; hasMore: boolean };
}

/** Round to the nearest minute so the SWR key stays stable between polls. */
function windowToSince(window: string): string {
  const ms: Record<string, number> = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  };
  const MINUTE = 60_000;
  const now = Math.floor(Date.now() / MINUTE) * MINUTE;
  return new Date(now - (ms[window] ?? ms['24h'])).toISOString();
}

function buildRunsListKey(opts: {
  projectId: string;
  typeFilter: string;
  pipelineId: string | null;
  statusFilter: string;
  timeWindow: string;
}): string {
  const params = new URLSearchParams();
  if (opts.typeFilter !== 'all') params.set('type', opts.typeFilter);
  if (opts.pipelineId) params.set('pipelineId', opts.pipelineId);
  if (opts.statusFilter !== 'all') params.set('status', opts.statusFilter);
  params.set('since', windowToSince(opts.timeWindow));
  params.set('limit', '50');
  params.set('offset', '0');
  return `/api/runtime/projects/${opts.projectId}/pipeline-observability/runs?${params.toString()}`;
}

export function RecentRunsPanel({ projectId, pipelineIdOverride }: RecentRunsPanelProps) {
  const typeFilter = useRunsStore((s) => s.typeFilter);
  const pipelineFilter = useRunsStore((s) => s.pipelineFilter);
  const statusFilter = useRunsStore((s) => s.statusFilter);
  const timeWindow = useRunsStore((s) => s.timeWindow);
  const openRun = useRunsStore((s) => s.openRun);

  const effectivePipeline = pipelineIdOverride ?? pipelineFilter;

  const key = buildRunsListKey({
    projectId,
    typeFilter,
    pipelineId: effectivePipeline,
    statusFilter,
    timeWindow,
  });

  const { data, mutate, isLoading } = useSWR<RunsListResponse>(key, swrFetcher, {
    refreshInterval: 5000,
    revalidateOnFocus: true,
  });

  return (
    <div className="space-y-4">
      <PipelineObservabilityScopeNotice contract={data?.meta?.contract} surface="runs" />
      <HealthStrip
        projectId={projectId}
        window={timeWindow}
        pipelineId={effectivePipeline ?? undefined}
      />
      <RunFilters />
      <RunsTable
        data={data?.data}
        loading={isLoading}
        onRowClick={openRun}
        onRefresh={() => {
          mutate();
        }}
      />
      <RunDetailDrawer projectId={projectId} />
    </div>
  );
}
