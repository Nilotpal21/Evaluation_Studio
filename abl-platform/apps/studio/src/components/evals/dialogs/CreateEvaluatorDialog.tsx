/**
 * CreateEvaluatorDialog — Create or edit an evaluator with rubric builder and bias settings.
 */

import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useProjectStore } from '@/store/project-store';
import { useProjectModelOptions } from '@/hooks/useProjectModelOptions';
import { apiFetch } from '@/lib/api-client';
import { Dialog } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Textarea } from '../../ui/Textarea';
import { Select } from '../../ui/Select';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Checkbox';
import { RubricBuilder, DEFAULT_1_5_POINTS, type RubricPoint } from '../shared/RubricBuilder';
import { BiasSettingsPanel, type BiasSettings } from '../shared/BiasSettingsPanel';
import type { EvalEvaluator } from '@/hooks/useEvalData';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  onSaved?: (updated: EvalEvaluator) => void;
  editEvaluator?: EvalEvaluator | null;
}

const DEFAULT_BIAS: BiasSettings = {
  positionSwapEnabled: true,
  blindEvaluation: true,
  crossModelJudge: false,
  evidenceFirstMode: true,
};

export function CreateEvaluatorDialog({ open, onClose, onCreated, onSaved, editEvaluator }: Props) {
  const t = useTranslations('evals');
  const currentProject = useProjectStore((s) => s.currentProject);
  const isEdit = !!editEvaluator;

  const {
    options: projectModelOptions,
    allOptions: allModelOptions,
    unavailableOptions,
    isLoading: isLoadingModels,
    error: modelError,
  } = useProjectModelOptions(currentProject?.id);

  // Name of the project-default model shown when no judgeModel is selected.
  const defaultModelName = useMemo(() => {
    for (const o of allModelOptions) {
      if (o.isDefault) return o.name;
    }
    return null;
  }, [allModelOptions]);

  const EVALUATOR_TYPES = [
    { value: 'llm_judge', label: t('evaluators.type.llm_judge') },
    { value: 'code_scorer', label: t('evaluators.type.code_scorer') },
    { value: 'trajectory', label: t('evaluators.type.trajectory') },
    { value: 'human_review', label: t('evaluators.type.human_review') },
  ];
  const CATEGORIES = [
    { value: 'quality', label: t('evaluators.category.quality') },
    { value: 'safety', label: t('evaluators.category.safety') },
    { value: 'efficiency', label: t('evaluators.category.efficiency') },
    { value: 'empathy', label: t('evaluators.category.empathy') },
    { value: 'tool_correctness', label: t('evaluators.category.tool_correctness') },
    { value: 'custom', label: t('evaluators.category.custom') },
  ];

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('llm_judge');
  const [category, setCategory] = useState('quality');
  const [judgeModel, setJudgeModel] = useState('');
  const [judgePrompt, setJudgePrompt] = useState('');
  const [chainOfThought, setChainOfThought] = useState(true);
  const [temperature, setTemperature] = useState('0');
  const [scaleType, setScaleType] = useState<'1-5' | 'pass-fail'>('1-5');
  const [rubricPoints, setRubricPoints] = useState<RubricPoint[]>(DEFAULT_1_5_POINTS);
  const [biasSettings, setBiasSettings] = useState<BiasSettings>(DEFAULT_BIAS);
  const [saving, setSaving] = useState(false);

  const selectedUnavailableModel = useMemo(() => {
    if (!judgeModel) return undefined;
    return unavailableOptions.find((option) => option.value === judgeModel);
  }, [judgeModel, unavailableOptions]);

  const judgeModelOptions = useMemo<{ value: string; label: string }[]>(() => {
    const opts: { value: string; label: string }[] = projectModelOptions.map((o) => ({
      value: o.value,
      label: o.label,
    }));
    if (judgeModel && !opts.some((option) => option.value === judgeModel)) {
      opts.push({
        value: judgeModel,
        label: selectedUnavailableModel
          ? t('evaluators.dialog.model_no_credentials', { name: selectedUnavailableModel.name })
          : t('evaluators.dialog.model_not_in_project', { model: judgeModel }),
      });
    }
    return opts;
  }, [judgeModel, projectModelOptions, selectedUnavailableModel, t]);

  useEffect(() => {
    if (editEvaluator) {
      setName(editEvaluator.name);
      setDescription(editEvaluator.description ?? '');
      setType(editEvaluator.type);
      setCategory(editEvaluator.category);
      setJudgeModel(editEvaluator.judgeModel ?? '');
      setJudgePrompt(editEvaluator.judgePrompt ?? '');
      setTemperature(String(editEvaluator.temperature ?? 0));
      if (editEvaluator.scoringRubric) {
        setScaleType(editEvaluator.scoringRubric.scaleType as '1-5' | 'pass-fail');
        setRubricPoints(editEvaluator.scoringRubric.points);
      }
      if (editEvaluator.biasSettings) {
        setBiasSettings(editEvaluator.biasSettings);
      }
    } else {
      resetForm();
    }
  }, [editEvaluator, open]);

  function resetForm() {
    setName('');
    setDescription('');
    setType('llm_judge');
    setCategory('quality');
    setJudgeModel('');
    setJudgePrompt('');
    setChainOfThought(true);
    setTemperature('0');
    setScaleType('1-5');
    setRubricPoints(DEFAULT_1_5_POINTS);
    setBiasSettings(DEFAULT_BIAS);
  }

  const handleSubmit = async () => {
    if (!currentProject || !name.trim()) return;
    setSaving(true);

    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      type,
      category,
      judgeModel: type === 'llm_judge' ? judgeModel : undefined,
      judgePrompt: type === 'llm_judge' ? judgePrompt.trim() || undefined : undefined,
      chainOfThought,
      temperature: parseFloat(temperature) || 0,
      scoringRubric: { scaleType, points: rubricPoints },
      biasSettings,
    };

    try {
      const url = isEdit
        ? `/api/projects/${currentProject.id}/evals/evaluators/${editEvaluator!.id}`
        : `/api/projects/${currentProject.id}/evals/evaluators`;
      const method = isEdit ? 'PATCH' : 'POST';
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data.error || data.errors?.[0]?.msg || `${isEdit ? 'Update' : 'Create'} failed`,
        );
      }
      toast.success(isEdit ? t('evaluators.dialog.updated') : t('evaluators.dialog.created'));
      // Optimistically update the SWR cache with the response body so the
      // judge model change is visible immediately on re-open.
      if (isEdit && data.evaluator && onSaved) {
        onSaved(data.evaluator as EvalEvaluator);
      }
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
      title={isEdit ? t('evaluators.dialog.edit_title') : t('evaluators.dialog.create_title')}
      description={t('evaluators.dialog.description')}
      maxWidth="xl"
    >
      <div className="space-y-5">
        <Input
          label={t('evaluators.dialog.name_label')}
          placeholder={t('evaluators.dialog.name_placeholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <Textarea
          label={t('evaluators.dialog.description_label')}
          placeholder={t('evaluators.dialog.description_placeholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />

        <div className="grid grid-cols-2 gap-4">
          <Select
            label={t('evaluators.dialog.type_label')}
            options={EVALUATOR_TYPES}
            value={type}
            onChange={setType}
          />
          <Select
            label={t('evaluators.dialog.category_label')}
            options={CATEGORIES}
            value={category}
            onChange={setCategory}
          />
        </div>

        {type === 'llm_judge' && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Select
                  label={t('evaluators.dialog.judge_model_label')}
                  options={judgeModelOptions}
                  value={judgeModel}
                  onChange={setJudgeModel}
                  disabled={isLoadingModels}
                />
                {!judgeModel && defaultModelName && (
                  <p className="text-xs text-muted mt-1">
                    {t('evaluators.dialog.model_default_hint', { model: defaultModelName })}
                  </p>
                )}
              </div>
              <Input
                label={t('evaluators.dialog.temperature_label')}
                type="number"
                placeholder="0"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </div>

            <Textarea
              label={t('evaluators.dialog.judge_prompt_label')}
              placeholder={t('evaluators.dialog.judge_prompt_placeholder')}
              value={judgePrompt}
              onChange={(e) => setJudgePrompt(e.target.value)}
              rows={4}
            />

            <Checkbox
              checked={chainOfThought}
              onChange={setChainOfThought}
              label={t('evaluators.dialog.chain_of_thought')}
            />
          </>
        )}

        <div className="border-t border-default pt-4">
          <RubricBuilder
            scaleType={scaleType}
            points={rubricPoints}
            onChange={setRubricPoints}
            onScaleTypeChange={setScaleType}
          />
        </div>

        {type === 'llm_judge' && (
          <div className="border-t border-default pt-4">
            <BiasSettingsPanel settings={biasSettings} onChange={setBiasSettings} />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            {t('evaluators.dialog.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            loading={saving}
            disabled={!name.trim() || (type === 'llm_judge' && !judgeModel)}
          >
            {isEdit ? t('evaluators.dialog.update') : t('evaluators.dialog.create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
