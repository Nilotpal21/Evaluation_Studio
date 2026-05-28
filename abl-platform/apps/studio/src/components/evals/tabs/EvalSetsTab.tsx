/**
 * EvalSetsTab — Card grid of eval sets with matrix preview.
 *
 * Shows dimension string (P×S×E×V), denormalized entity names,
 * total evaluations count, and Run button.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Plus, Layers, Trash2, Pencil, Play } from 'lucide-react';
import { toast } from 'sonner';
import { useProjectStore } from '@/store/project-store';
import { useEvalsStore } from '@/store/evals-store';
import { useEvalSets, type EvalSet } from '@/hooks/useEvalData';
import { apiFetch } from '@/lib/api-client';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { EmptyState } from '../../ui/EmptyState';
import { SkeletonCard } from '../../ui/Skeleton';
import { CreateEvalSetDialog } from '../dialogs/CreateEvalSetDialog';

export function EvalSetsTab() {
  const t = useTranslations('evals');
  const currentProject = useProjectStore((s) => s.currentProject);
  const { sets, isLoading, refresh, hasMore, loadMore, isLoadingMore, total } = useEvalSets(
    currentProject?.id ?? null,
  );
  const [showCreate, setShowCreate] = useState(false);
  const [editSet, setEditSet] = useState<EvalSet | null>(null);

  const handleDelete = async (set: EvalSet) => {
    if (!currentProject) return;
    if (!window.confirm(t('eval_sets.delete_confirm', { name: set.name }))) return;
    try {
      const res = await apiFetch(`/api/projects/${currentProject.id}/evals/sets/${set.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || data.errors?.[0]?.msg || 'Delete failed');
      }
      toast.success(t('eval_sets.deleted', { name: set.name }));
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (sets.length === 0) {
    return (
      <>
        <EmptyState
          icon={<Layers className="w-6 h-6" />}
          title={t('eval_sets.empty_title')}
          description={t('eval_sets.empty_description')}
          action={
            <Button onClick={() => setShowCreate(true)} icon={<Plus className="w-4 h-4" />}>
              {t('eval_sets.create')}
            </Button>
          }
        />
        <CreateEvalSetDialog
          open={showCreate}
          onClose={() => setShowCreate(false)}
          onCreated={refresh}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted">{t('showing_count', { shown: sets.length, total })}</p>
        <Button
          size="sm"
          onClick={() => setShowCreate(true)}
          icon={<Plus className="w-3.5 h-3.5" />}
        >
          {t('eval_sets.create')}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {sets.map((set) => (
          <EvalSetCard
            key={set.id}
            set={set}
            onEdit={() => setEditSet(set)}
            onDelete={() => handleDelete(set)}
            projectId={currentProject?.id ?? ''}
          />
        ))}
      </div>

      {hasMore && (
        <div className="flex justify-center mt-4">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void loadMore()}
            loading={isLoadingMore}
            icon={<ChevronDown className="w-3.5 h-3.5" />}
          >
            {t('load_more')}
          </Button>
        </div>
      )}

      <CreateEvalSetDialog
        open={showCreate || !!editSet}
        onClose={() => {
          setShowCreate(false);
          setEditSet(null);
        }}
        onCreated={refresh}
        editSet={editSet}
      />
    </>
  );
}

function EvalSetCard({
  set,
  onEdit,
  onDelete,
  projectId,
}: {
  set: EvalSet;
  onEdit: () => void;
  onDelete: () => void;
  projectId: string;
}) {
  const t = useTranslations('evals');
  const p = set.personaIds.length;
  const s = set.scenarioIds.length;
  const e = set.evaluatorIds.length;
  const v = set.variants || 1;
  const totalEvals = p * s * e * v;
  const dimensionStr = `${p}P × ${s}S × ${e}E × ${v}V`;

  const [isRunning, setIsRunning] = useState(false);

  const handleRun = async () => {
    if (isRunning) return;
    setIsRunning(true);
    try {
      // Create a run
      const res = await apiFetch(`/api/projects/${projectId}/evals/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evalSetId: set.id, triggerSource: 'manual' }),
      });
      const createData = await res.json();
      if (!res.ok)
        throw new Error(createData.error || createData.errors?.[0]?.msg || 'Failed to create run');

      // Start the run
      const startRes = await apiFetch(
        `/api/projects/${projectId}/evals/runs/${createData.run.id}/start`,
        { method: 'POST' },
      );
      const startData = await startRes.json();
      if (!startRes.ok)
        throw new Error(startData.error || startData.errors?.[0]?.msg || 'Failed to start run');
      toast.success(t('eval_sets.run_started'));
      useEvalsStore.getState().setSelectedRunId(createData.run.id);
      useEvalsStore.getState().setActiveTab('runs');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  };

  const nameChips = (
    names: Record<string, string> | undefined,
    variant: 'accent' | 'info' | 'purple',
  ) => {
    if (!names) return null;
    return Object.values(names)
      .slice(0, 3)
      .map((n) => (
        <Badge key={n} variant={variant} className="text-xs">
          {n}
        </Badge>
      ));
  };

  return (
    <div className="border border-default rounded-xl p-4 bg-background-elevated hover:border-subtle transition-default group">
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground truncate">{set.name}</h3>
          {set.description && (
            <p className="text-xs text-muted truncate mt-0.5">{set.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-default">
            <button
              onClick={onEdit}
              className="p-1 text-muted hover:text-foreground rounded transition-default"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onDelete}
              className="p-1 text-muted hover:text-error rounded transition-default"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
          <Button
            size="xs"
            onClick={handleRun}
            loading={isRunning}
            disabled={isRunning}
            icon={<Play className="w-3 h-3" />}
          >
            {t('eval_sets.run')}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-3">
        <Badge variant="default">{dimensionStr}</Badge>
        <span className="text-xs text-muted">
          {t('eval_sets.evaluations', { count: totalEvals.toLocaleString() })}
        </span>
      </div>

      <div className="flex flex-wrap gap-1 mb-2">
        {nameChips(set._personaNames, 'accent')}
        {nameChips(set._scenarioNames, 'info')}
        {nameChips(set._evaluatorNames, 'purple')}
      </div>

      {set.ciEnabled && (
        <Badge variant="success" className="mt-1">
          {t('eval_sets.ci_enabled')}
        </Badge>
      )}

      <div className="text-xs text-subtle mt-2 pt-2 border-t border-default">
        {new Date(set.createdAt).toLocaleDateString()}
      </div>
    </div>
  );
}
