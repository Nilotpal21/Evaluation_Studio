/**
 * CustomPipelinesList Component
 *
 * Fetches custom pipelines from the Studio API and renders a grid
 * of PipelineCard components. Includes create, clone, and delete actions.
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { Plus, Workflow } from 'lucide-react';
import { swrFetcher } from '../../lib/swr-config';
import { apiFetch } from '../../lib/api-client';
import { useProjectStore } from '../../store/project-store';
import { useNavigationStore } from '../../store/navigation-store';
import { usePipelineListStore } from '../../store/pipeline-list-store';
import { PipelineCard, type CustomPipelineDefinition, type PipelineHealth } from './PipelineCard';
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useListPageShellPrimaryActionHidden } from '../ui/ListPageShell';

// =============================================================================
// TYPES
// =============================================================================

interface CustomPipelinesResponse {
  pipelines: CustomPipelineDefinition[];
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

interface CustomPipelinesListProps {
  onCreatePipeline?: () => void;
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
      <div className="flex items-center gap-3 mb-3">
        <div className="h-3 w-16 bg-background-muted rounded" />
        <div className="h-3 w-24 bg-background-muted rounded" />
      </div>
      <div className="flex items-center justify-between pt-3 border-t border-default">
        <div className="h-3 w-24 bg-background-muted rounded" />
        <div className="h-4 w-4 bg-background-muted rounded" />
      </div>
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function CustomPipelinesList({ onCreatePipeline }: CustomPipelinesListProps) {
  const t = useTranslations('pipelines');
  const tCommon = useTranslations('common');
  const projectId = useProjectStore((s) => s.currentProject?.id);
  const navigate = useNavigationStore((s) => s.navigate);
  const searchQuery = usePipelineListStore((s) => s.searchQuery);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Fetch custom pipelines
  const swrKey = projectId ? `/api/pipelines?projectId=${projectId}` : null;
  const { data, error, isLoading, mutate } = useSWR<CustomPipelinesResponse>(swrKey, swrFetcher);

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

  const pipelines = data?.pipelines ?? [];

  // Filter by search query
  const filtered = useMemo(() => {
    if (!searchQuery) return pipelines;
    const q = searchQuery.toLowerCase();
    return pipelines.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q)),
    );
  }, [pipelines, searchQuery]);

  const isEmptyStateShown = pipelines.length === 0 || (filtered.length === 0 && searchQuery !== '');
  useListPageShellPrimaryActionHidden(isEmptyStateShown);

  // ─── Click handler ─────────────────────────────────────────────────────────

  const handleClick = useCallback(
    (pipelineId: string) => {
      if (projectId) {
        navigate(`/projects/${projectId}/pipelines/${pipelineId}`);
      }
    },
    [projectId, navigate],
  );

  // ─── Clone handler ─────────────────────────────────────────────────────────

  const handleClone = useCallback(
    async (pipelineId: string) => {
      try {
        await apiFetch(`/api/pipelines/${pipelineId}/clone`, { method: 'POST' });
        await mutate();
      } catch {
        // SWR will show stale data on error
      }
    },
    [mutate],
  );

  // ─── Archive handler ───────────────────────────────────────────────────────

  const handleArchive = useCallback(
    async (pipelineId: string) => {
      try {
        await apiFetch(`/api/pipelines/${pipelineId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'archived' }),
        });
        await mutate();
      } catch {
        // SWR will show stale data on error
      }
    },
    [mutate],
  );

  // ─── Delete handler ────────────────────────────────────────────────────────

  const handleDeleteConfirm = useCallback(async () => {
    if (!deletingId) return;
    setDeleteLoading(true);

    try {
      await apiFetch(`/api/pipelines/${deletingId}`, { method: 'DELETE' });
      setDeletingId(null);
      await mutate();
    } catch {
      // Keep dialog open on error
    } finally {
      setDeleteLoading(false);
    }
  }, [deletingId, mutate]);

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
        icon={<Workflow className="w-6 h-6" />}
        title="Failed to load custom pipelines"
        description={error instanceof Error ? error.message : 'An unexpected error occurred'}
      />
    );
  }

  // ─── Empty state ───────────────────────────────────────────────────────────

  if (pipelines.length === 0) {
    return (
      <EmptyState
        icon={<Workflow className="w-6 h-6" />}
        title={t('empty_custom')}
        description={t('empty_custom_description')}
        action={
          <Button icon={<Plus className="w-4 h-4" />} onClick={onCreatePipeline}>
            {t('create_pipeline')}
          </Button>
        }
      />
    );
  }

  // ─── No matches ────────────────────────────────────────────────────────────

  if (filtered.length === 0 && searchQuery) {
    return (
      <EmptyState
        icon={<Workflow className="w-6 h-6" />}
        title={t('no_matching_pipelines')}
        description={t('try_adjusting_search')}
      />
    );
  }

  // ─── Grid ──────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((pipeline) => (
          <PipelineCard
            key={pipeline._id}
            kind="custom"
            pipeline={pipeline}
            onClick={() => handleClick(pipeline._id)}
            onClone={() => handleClone(pipeline._id)}
            onArchive={() => handleArchive(pipeline._id)}
            onDelete={() => setDeletingId(pipeline._id)}
            health={healthByPipeline.get(pipeline._id)}
          />
        ))}
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={!!deletingId}
        onClose={() => setDeletingId(null)}
        onConfirm={handleDeleteConfirm}
        title={t('delete_confirm_title')}
        description={t('delete_confirm_description')}
        confirmLabel={tCommon('delete')}
        variant="danger"
        loading={deleteLoading}
      />
    </>
  );
}
