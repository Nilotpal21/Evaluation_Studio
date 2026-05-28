/**
 * EvaluatorsTab — Card grid of eval evaluators.
 *
 * Displays evaluator cards with type, category, judge model, rubric preview,
 * and bias mitigation status badge.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  Plus,
  Eye,
  Trash2,
  Pencil,
  Brain,
  Code,
  GitBranch,
  UserCheck,
  Shield,
} from 'lucide-react';
import { toast } from 'sonner';
import { useProjectStore } from '@/store/project-store';
import { useEvalEvaluators, type EvalEvaluator } from '@/hooks/useEvalData';
import { apiFetch } from '@/lib/api-client';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { EmptyState } from '../../ui/EmptyState';
import { SkeletonCard } from '../../ui/Skeleton';
import { CreateEvaluatorDialog } from '../dialogs/CreateEvaluatorDialog';

const TYPE_ICONS: Record<string, React.ReactNode> = {
  llm_judge: <Brain className="w-4 h-4" />,
  code_scorer: <Code className="w-4 h-4" />,
  trajectory: <GitBranch className="w-4 h-4" />,
  human_review: <UserCheck className="w-4 h-4" />,
};

export function EvaluatorsTab() {
  const t = useTranslations('evals');
  const currentProject = useProjectStore((s) => s.currentProject);
  const { evaluators, isLoading, refresh, updateOne, hasMore, loadMore, isLoadingMore, total } =
    useEvalEvaluators(currentProject?.id ?? null);
  const [showCreate, setShowCreate] = useState(false);
  const [editEvaluator, setEditEvaluator] = useState<EvalEvaluator | null>(null);

  const handleDelete = async (evaluator: EvalEvaluator) => {
    if (!currentProject) return;
    if (!window.confirm(t('evaluators.delete_confirm', { name: evaluator.name }))) return;
    try {
      const res = await apiFetch(
        `/api/projects/${currentProject.id}/evals/evaluators/${evaluator.id}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || data.errors?.[0]?.msg || 'Delete failed');
      }
      toast.success(t('evaluators.deleted', { name: evaluator.name }));
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (evaluators.length === 0) {
    return (
      <>
        <EmptyState
          icon={<Eye className="w-6 h-6" />}
          title={t('evaluators.empty_title')}
          description={t('evaluators.empty_description')}
          action={
            <Button onClick={() => setShowCreate(true)} icon={<Plus className="w-4 h-4" />}>
              {t('evaluators.create')}
            </Button>
          }
        />
        <CreateEvaluatorDialog
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
          {t('showing_count', { shown: evaluators.length, total })}
        </p>
        <Button
          size="sm"
          onClick={() => setShowCreate(true)}
          icon={<Plus className="w-3.5 h-3.5" />}
        >
          {t('evaluators.create')}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {evaluators.map((evaluator) => (
          <EvaluatorCard
            key={evaluator.id}
            evaluator={evaluator}
            onEdit={() => setEditEvaluator(evaluator)}
            onDelete={() => handleDelete(evaluator)}
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

      <CreateEvaluatorDialog
        open={showCreate || !!editEvaluator}
        onClose={() => {
          setShowCreate(false);
          setEditEvaluator(null);
        }}
        onCreated={refresh}
        onSaved={updateOne}
        editEvaluator={editEvaluator}
      />
    </>
  );
}

function EvaluatorCard({
  evaluator,
  onEdit,
  onDelete,
}: {
  evaluator: EvalEvaluator;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('evals');
  const isBiasMitigated =
    evaluator.biasSettings?.positionSwapEnabled && evaluator.biasSettings?.blindEvaluation;

  return (
    <div className="border border-default rounded-xl p-4 bg-background-elevated hover:border-subtle transition-default group">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-background-muted flex items-center justify-center shrink-0 text-muted">
            {TYPE_ICONS[evaluator.type] ?? <Eye className="w-4 h-4" />}
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground truncate">{evaluator.name}</h3>
            {evaluator.description && (
              <p className="text-xs text-muted truncate">{evaluator.description}</p>
            )}
          </div>
        </div>
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
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3">
        <Badge variant="accent">
          {t(`evaluators.type.${evaluator.type}` as Parameters<typeof t>[0])}
        </Badge>
        <Badge variant="default">{evaluator.category}</Badge>
        {evaluator.scoringRubric && (
          <Badge variant="info">{evaluator.scoringRubric.scaleType}</Badge>
        )}
        {evaluator.isBuiltIn && <Badge variant="accent">{t('evaluators.builtin')}</Badge>}
      </div>

      {isBiasMitigated && (
        <div className="flex items-center gap-1.5 text-xs text-accent mb-2">
          <Shield className="w-3 h-3" />
          <span>{t('evaluators.bias_mitigated')}</span>
        </div>
      )}

      {evaluator.judgeModel && (
        <div className="text-xs text-subtle truncate">
          {t('evaluators.model_label', { model: evaluator.judgeModel })}
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-subtle mt-2 pt-2 border-t border-default">
        <span>v{evaluator.version}</span>
        <span>{new Date(evaluator.createdAt).toLocaleDateString()}</span>
      </div>
    </div>
  );
}
