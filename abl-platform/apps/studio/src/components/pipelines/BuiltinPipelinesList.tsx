/**
 * BuiltinPipelinesList Component
 *
 * Fetches builtin pipeline configs from the runtime API via proxy
 * and renders a grid of PipelineCard components.
 * Filters by search query from the pipeline list store.
 */

'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { Cpu } from 'lucide-react';
import { swrFetcher } from '../../lib/swr-config';
import { useProjectStore } from '../../store/project-store';
import { useNavigationStore } from '../../store/navigation-store';
import { usePipelineListStore } from '../../store/pipeline-list-store';
import { PipelineCard, type BuiltinPipelineSummary, type PipelineHealth } from './PipelineCard';
import { EmptyState } from '../ui/EmptyState';

// =============================================================================
// TYPES
// =============================================================================

interface PipelineConfigListResponse {
  success: boolean;
  data: BuiltinPipelineSummary[];
}

interface HealthByPipelineEntry {
  pipelineId: string;
  total: number;
  completed: number;
  failed: number;
  running: number;
  successRate: number;
  avgDurationMs: number;
}

interface PipelineHealthResponse {
  success: boolean;
  data: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    cancelled: number;
    successRate: number;
    avgDurationMs: number;
    byPipeline: HealthByPipelineEntry[];
  };
}

// =============================================================================
// SKELETON
// =============================================================================

const SKELETON_COUNT = 6;

function PipelineCardSkeleton() {
  return (
    <div className="rounded-xl border border-default bg-background-elevated p-4 animate-pulse">
      <div className="flex items-start justify-between mb-2">
        <div className="h-5 w-2/3 bg-background-muted rounded" />
        <div className="h-5 w-16 bg-background-muted rounded-full" />
      </div>
      <div className="h-4 w-full bg-background-muted rounded mb-1.5" />
      <div className="h-4 w-3/4 bg-background-muted rounded mb-3" />
      <div className="flex items-center justify-between pt-3 border-t border-default">
        <div className="h-3 w-20 bg-background-muted rounded" />
        <div className="h-3 w-28 bg-background-muted rounded" />
      </div>
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function BuiltinPipelinesList() {
  const t = useTranslations('pipelines');
  const projectId = useProjectStore((s) => s.currentProject?.id);
  const navigate = useNavigationStore((s) => s.navigate);
  const searchQuery = usePipelineListStore((s) => s.searchQuery);

  // Fetch builtin pipeline configs from runtime API via proxy
  const { data, error, isLoading } = useSWR<PipelineConfigListResponse>(
    projectId ? `/api/projects/${projectId}/pipeline-config` : null,
    swrFetcher,
  );

  // Fetch health summary once for all cards (avoids N+1)
  const { data: healthData } = useSWR<PipelineHealthResponse>(
    projectId
      ? `/api/runtime/projects/${projectId}/pipeline-observability/runs/health?window=24h`
      : null,
    swrFetcher,
  );

  const healthByPipeline = useMemo(() => {
    const map = new Map<string, PipelineHealth>();
    for (const entry of healthData?.data?.byPipeline ?? []) {
      map.set(entry.pipelineId, {
        total: entry.total,
        failed: entry.failed,
        successRate: entry.successRate,
      });
    }
    return map;
  }, [healthData]);

  const pipelines = data?.data ?? [];

  // Filter by search query
  const filtered = useMemo(() => {
    if (!searchQuery) return pipelines;
    const q = searchQuery.toLowerCase();
    return pipelines.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    );
  }, [pipelines, searchQuery]);

  // Click handler: navigate to builtin config page
  const handleClick = (pipelineType: string) => {
    if (projectId) {
      navigate(`/projects/${projectId}/pipelines/${pipelineType}`);
    }
  };

  // ─── Loading ───────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: SKELETON_COUNT }, (_, i) => (
          <PipelineCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  // ─── Error ─────────────────────────────────────────────────────────────────

  if (error) {
    return (
      <EmptyState
        icon={<Cpu className="w-6 h-6" />}
        title="Failed to load pipelines"
        description={error instanceof Error ? error.message : 'An unexpected error occurred'}
      />
    );
  }

  // ─── Empty / No matches ────────────────────────────────────────────────────

  if (filtered.length === 0) {
    return (
      <EmptyState
        icon={<Cpu className="w-6 h-6" />}
        title={searchQuery ? t('no_matching_pipelines') : 'No builtin pipelines configured'}
        description={searchQuery ? t('try_adjusting_search') : undefined}
      />
    );
  }

  // ─── Grid ──────────────────────────────────────────────────────────────────

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {filtered.map((pipeline) => (
        <PipelineCard
          key={pipeline.pipelineType}
          kind="builtin"
          pipeline={pipeline}
          onClick={() => handleClick(pipeline.pipelineType)}
          health={healthByPipeline.get(pipeline.pipelineType)}
        />
      ))}
    </div>
  );
}
