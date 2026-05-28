/**
 * CreateEvalSetDialog — Create or edit an eval set with matrix preview.
 */

import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { useProjectStore } from '@/store/project-store';
import { useEvalPersonas, useEvalScenarios, useEvalEvaluators } from '@/hooks/useEvalData';
import { apiFetch } from '@/lib/api-client';
import { Dialog } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Textarea } from '../../ui/Textarea';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { Toggle } from '../../ui/Toggle';
import type { EvalSet } from '@/hooks/useEvalData';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  editSet?: EvalSet | null;
}

export function CreateEvalSetDialog({ open, onClose, onCreated, editSet }: Props) {
  const t = useTranslations('evals');
  const currentProject = useProjectStore((s) => s.currentProject);
  const projectId = currentProject?.id ?? null;
  const {
    personas,
    hasMore: hasMorePersonas,
    loadMore: loadMorePersonas,
    isLoadingMore: isLoadingMorePersonas,
    total: totalPersonas,
  } = useEvalPersonas(projectId);
  const {
    scenarios,
    hasMore: hasMoreScenarios,
    loadMore: loadMoreScenarios,
    isLoadingMore: isLoadingMoreScenarios,
    total: totalScenarios,
  } = useEvalScenarios(projectId);
  const {
    evaluators,
    hasMore: hasMoreEvaluators,
    loadMore: loadMoreEvaluators,
    isLoadingMore: isLoadingMoreEvaluators,
    total: totalEvaluators,
  } = useEvalEvaluators(projectId);
  const isEdit = !!editSet;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedPersonas, setSelectedPersonas] = useState<Set<string>>(new Set());
  const [selectedScenarios, setSelectedScenarios] = useState<Set<string>>(new Set());
  const [selectedEvaluators, setSelectedEvaluators] = useState<Set<string>>(new Set());
  const [variants, setVariants] = useState(3);
  const [ciEnabled, setCiEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editSet) {
      setName(editSet.name);
      setDescription(editSet.description ?? '');
      setSelectedPersonas(new Set(editSet.personaIds));
      setSelectedScenarios(new Set(editSet.scenarioIds));
      setSelectedEvaluators(new Set(editSet.evaluatorIds));
      setVariants(editSet.variants || 3);
      setCiEnabled(editSet.ciEnabled || false);
    } else {
      resetForm();
    }
  }, [editSet, open]);

  function resetForm() {
    setName('');
    setDescription('');
    setSelectedPersonas(new Set());
    setSelectedScenarios(new Set());
    setSelectedEvaluators(new Set());
    setVariants(3);
    setCiEnabled(false);
  }

  const totalEvals = useMemo(
    () => selectedPersonas.size * selectedScenarios.size * selectedEvaluators.size * variants,
    [selectedPersonas.size, selectedScenarios.size, selectedEvaluators.size, variants],
  );

  const toggleSet = (current: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  const handleSubmit = async () => {
    if (!currentProject || !name.trim()) return;
    if (
      selectedPersonas.size === 0 ||
      selectedScenarios.size === 0 ||
      selectedEvaluators.size === 0
    ) {
      toast.error(t('eval_sets.dialog.validation_error'));
      return;
    }

    setSaving(true);
    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      personaIds: Array.from(selectedPersonas),
      scenarioIds: Array.from(selectedScenarios),
      evaluatorIds: Array.from(selectedEvaluators),
      variants,
      ciEnabled,
    };

    try {
      const url = isEdit
        ? `/api/projects/${currentProject.id}/evals/sets/${editSet!.id}`
        : `/api/projects/${currentProject.id}/evals/sets`;
      const method = isEdit ? 'PATCH' : 'POST';
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(
          data.error || data.errors?.[0]?.msg || `${isEdit ? 'Update' : 'Create'} failed`,
        );
      }
      toast.success(isEdit ? t('eval_sets.dialog.updated') : t('eval_sets.dialog.created'));
      resetForm();
      onCreated();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? t('eval_sets.dialog.edit_title') : t('eval_sets.dialog.create_title')}
      description={t('eval_sets.dialog.description')}
      maxWidth="xl"
    >
      <div className="space-y-5">
        <Input
          label={t('eval_sets.dialog.name_label')}
          placeholder={t('eval_sets.dialog.name_placeholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <Textarea
          label={t('eval_sets.dialog.description_label')}
          placeholder={t('eval_sets.dialog.description_placeholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />

        {/* Personas multi-select */}
        <MultiSelectSection
          label={t('eval_sets.dialog.personas')}
          items={personas.map((p) => ({ id: p.id, name: p.name }))}
          selected={selectedPersonas}
          onToggle={(id) => toggleSet(selectedPersonas, setSelectedPersonas, id)}
          emptyText={t('eval_sets.dialog.no_personas')}
          hasMore={hasMorePersonas}
          total={totalPersonas}
          loadMore={loadMorePersonas}
          isLoadingMore={isLoadingMorePersonas}
        />

        {/* Scenarios multi-select */}
        <MultiSelectSection
          label={t('eval_sets.dialog.scenarios')}
          items={scenarios.map((s) => ({ id: s.id, name: s.name }))}
          selected={selectedScenarios}
          onToggle={(id) => toggleSet(selectedScenarios, setSelectedScenarios, id)}
          emptyText={t('eval_sets.dialog.no_scenarios')}
          hasMore={hasMoreScenarios}
          total={totalScenarios}
          loadMore={loadMoreScenarios}
          isLoadingMore={isLoadingMoreScenarios}
        />

        {/* Evaluators multi-select */}
        <MultiSelectSection
          label={t('eval_sets.dialog.evaluators')}
          items={evaluators.map((e) => ({ id: e.id, name: e.name }))}
          selected={selectedEvaluators}
          onToggle={(id) => toggleSet(selectedEvaluators, setSelectedEvaluators, id)}
          emptyText={t('eval_sets.dialog.no_evaluators')}
          hasMore={hasMoreEvaluators}
          total={totalEvaluators}
          loadMore={loadMoreEvaluators}
          isLoadingMore={isLoadingMoreEvaluators}
        />

        {/* Variants */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            {t('eval_sets.dialog.variants')}
          </label>
          <input
            type="range"
            min={1}
            max={10}
            value={variants}
            onChange={(e) => setVariants(parseInt(e.target.value, 10))}
            className="w-full accent-accent"
          />
          <div className="flex justify-between text-xs text-muted mt-1">
            <span>1</span>
            <span className="font-medium text-foreground">{variants}</span>
            <span>10</span>
          </div>
        </div>

        {/* CI toggle */}
        <Toggle
          checked={ciEnabled}
          onChange={setCiEnabled}
          label={t('eval_sets.dialog.ci_toggle')}
        />

        {/* Matrix Preview */}
        <div className="bg-background-muted rounded-lg p-3 text-center">
          <div className="text-xs text-muted mb-1">{t('eval_sets.dialog.matrix_size')}</div>
          <div className="text-lg font-semibold text-foreground">
            {selectedPersonas.size}P × {selectedScenarios.size}S × {selectedEvaluators.size}E ×{' '}
            {variants}V
          </div>
          <div className="text-sm text-muted mt-1">
            {t('eval_sets.dialog.total_evaluations', { count: totalEvals.toLocaleString() })}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={saving} disabled={!name.trim()}>
            {isEdit ? 'Update' : 'Create'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function MultiSelectSection({
  label,
  items,
  selected,
  onToggle,
  emptyText,
  hasMore,
  total,
  loadMore,
  isLoadingMore,
}: {
  label: string;
  items: Array<{ id: string; name: string }>;
  selected: Set<string>;
  onToggle: (id: string) => void;
  emptyText: string;
  hasMore: boolean;
  total: number;
  loadMore: () => Promise<unknown>;
  isLoadingMore: boolean;
}) {
  const t = useTranslations('evals');

  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1.5">
        {label}{' '}
        <span className="text-muted font-normal">
          ({selected.size}/{total})
        </span>
      </label>
      {items.length === 0 ? (
        <p className="text-xs text-muted py-2">{emptyText}</p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto p-2 rounded-lg border border-default bg-background-subtle">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onToggle(item.id)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-default ${
                  selected.has(item.id)
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-background-muted text-muted hover:text-foreground'
                }`}
              >
                {item.name}
              </button>
            ))}
          </div>
          {hasMore && (
            <Button
              size="xs"
              variant="secondary"
              onClick={() => void loadMore()}
              loading={isLoadingMore}
              icon={<ChevronDown className="w-3 h-3" />}
            >
              {t('load_more')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
