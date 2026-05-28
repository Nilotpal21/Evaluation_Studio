/**
 * ScenariosTab — Table view of eval scenarios.
 *
 * Displays scenarios in a DataTable with category, difficulty, agent path,
 * tags, and max turns. Supports create, edit, delete.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Plus, Route, Trash2, Pencil, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { useProjectStore } from '@/store/project-store';
import { useEvalScenarios, type EvalScenario } from '@/hooks/useEvalData';
import { apiFetch } from '@/lib/api-client';
import { normalizeGeneratedScenario } from '@/lib/eval-generation-normalizers';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { EmptyState } from '../../ui/EmptyState';
import { DataTable, type Column } from '../../ui/DataTable';
import { CreateScenarioDialog } from '../dialogs/CreateScenarioDialog';

const DIFFICULTY_VARIANT: Record<string, 'success' | 'warning' | 'error'> = {
  easy: 'success',
  medium: 'warning',
  hard: 'error',
};

export function ScenariosTab() {
  const t = useTranslations('evals');
  const currentProject = useProjectStore((s) => s.currentProject);
  const { scenarios, isLoading, refresh, hasMore, loadMore, isLoadingMore, total } =
    useEvalScenarios(currentProject?.id ?? null);
  const [showCreate, setShowCreate] = useState(false);
  const [editScenario, setEditScenario] = useState<EvalScenario | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleGenerate = async () => {
    if (!currentProject || isGenerating) return;
    setIsGenerating(true);
    try {
      const genRes = await apiFetch(`/api/projects/${currentProject.id}/evals/generate/scenarios`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 3 }),
      });
      const genData = await genRes.json();
      if (!genRes.ok)
        throw new Error(genData.error || genData.errors?.[0]?.msg || 'Generation failed');

      let saved = 0;
      for (const s of genData.scenarios ?? []) {
        const scenario = normalizeGeneratedScenario(s);
        const saveRes = await apiFetch(`/api/projects/${currentProject.id}/evals/scenarios`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...scenario,
          }),
        });
        if (saveRes.ok) saved++;
      }
      toast.success(t('scenarios.generate_success', { count: saved }));
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDelete = async (scenario: EvalScenario) => {
    if (!currentProject) return;
    if (!window.confirm(t('scenarios.delete_confirm', { name: scenario.name }))) return;
    try {
      const res = await apiFetch(
        `/api/projects/${currentProject.id}/evals/scenarios/${scenario.id}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || data.errors?.[0]?.msg || 'Delete failed');
      }
      toast.success(t('scenarios.deleted', { name: scenario.name }));
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const columns: Column<EvalScenario>[] = [
    {
      key: 'name',
      label: t('scenarios.column.name'),
      sortable: true,
      sortValue: (r) => r.name,
      width: 'w-1/3',
      render: (row) => (
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground truncate">{row.name}</div>
          {row.description && (
            <div className="text-xs text-muted truncate mt-0.5">{row.description}</div>
          )}
        </div>
      ),
    },
    {
      key: 'category',
      label: t('scenarios.column.category'),
      sortable: true,
      sortValue: (r) => r.category,
      render: (row) => <Badge variant="accent">{row.category}</Badge>,
    },
    {
      key: 'difficulty',
      label: t('scenarios.column.difficulty'),
      sortable: true,
      sortValue: (r) => r.difficulty,
      render: (row) => (
        <Badge variant={DIFFICULTY_VARIANT[row.difficulty] ?? 'default'}>{row.difficulty}</Badge>
      ),
    },
    {
      key: 'agentPath',
      label: t('scenarios.column.agent_path'),
      render: (row) =>
        row.agentPath && row.agentPath.length > 0 ? (
          <div className="flex items-center gap-1 text-xs text-muted">
            {row.agentPath.map((agent, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-subtle">→</span>}
                <span className="px-1.5 py-0.5 rounded bg-background-muted">{agent}</span>
              </span>
            ))}
          </div>
        ) : (
          <span className="text-xs text-subtle">{t('scenarios.empty_agent_path')}</span>
        ),
    },
    {
      key: 'maxTurns',
      label: t('scenarios.column.max_turns'),
      sortable: true,
      sortValue: (r) => r.maxTurns,
      render: (row) => <span className="text-sm text-muted">{row.maxTurns}</span>,
    },
    {
      key: 'actions',
      label: '',
      width: 'w-20',
      render: (row) => (
        <div className="flex items-center gap-1 justify-end">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setEditScenario(row);
            }}
            className="p-1 text-muted hover:text-foreground rounded transition-default"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDelete(row);
            }}
            className="p-1 text-muted hover:text-error rounded transition-default"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ),
    },
  ];

  if (isLoading) {
    return <div className="text-sm text-muted py-12 text-center">{t('scenarios.loading')}</div>;
  }

  if (scenarios.length === 0) {
    return (
      <>
        <EmptyState
          icon={<Route className="w-6 h-6" />}
          title={t('scenarios.empty_title')}
          description={t('scenarios.empty_description')}
          action={
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={handleGenerate}
                loading={isGenerating}
                disabled={isGenerating}
                icon={<Sparkles className="w-4 h-4" />}
              >
                {t('scenarios.generate')}
              </Button>
              <Button onClick={() => setShowCreate(true)} icon={<Plus className="w-4 h-4" />}>
                {t('scenarios.create')}
              </Button>
            </div>
          }
        />
        <CreateScenarioDialog
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
        <p className="text-sm text-muted">
          {t('showing_count', { shown: scenarios.length, total })}
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={handleGenerate}
            loading={isGenerating}
            disabled={isGenerating}
            icon={<Sparkles className="w-3.5 h-3.5" />}
          >
            {t('scenarios.generate')}
          </Button>
          <Button
            size="sm"
            onClick={() => setShowCreate(true)}
            icon={<Plus className="w-3.5 h-3.5" />}
          >
            {t('scenarios.create')}
          </Button>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={scenarios}
        keyExtractor={(s) => s.id}
        onRowClick={(s) => setEditScenario(s)}
      />

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

      <CreateScenarioDialog
        open={showCreate || !!editScenario}
        onClose={() => {
          setShowCreate(false);
          setEditScenario(null);
        }}
        onCreated={refresh}
        editScenario={editScenario}
      />
    </>
  );
}
