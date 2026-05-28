'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { SlidePanel } from '../ui/SlidePanel';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { Input } from '../ui/Input';
import { Textarea } from '../ui/Textarea';
import type {
  GovernancePolicyItem,
  GovernancePolicyRule,
  CreatePolicyBody,
  UpdatePolicyBody,
  RuleOperator,
  RuleSeverity,
} from '../../lib/governance-contracts';
import { GOVERNANCE_PIPELINE_TYPES, GOVERNANCE_METRICS } from '../../lib/governance-contracts';

const OPERATOR_OPTIONS: { value: RuleOperator; label: string }[] = [
  { value: 'gte', label: '>= At least' },
  { value: 'gt', label: '> Greater than' },
  { value: 'lte', label: '<= At most' },
  { value: 'lt', label: '< Less than' },
  { value: 'eq', label: '= Equals' },
];

const SEVERITY_OPTIONS: { value: RuleSeverity; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
];

function toTitleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const PIPELINE_OPTIONS = GOVERNANCE_PIPELINE_TYPES.map((pt) => ({
  value: pt,
  label: toTitleCase(pt),
}));

interface GovernancePolicyEditorProps {
  open: boolean;
  onClose: () => void;
  initial?: GovernancePolicyItem | null;
  onSave: (body: CreatePolicyBody | UpdatePolicyBody) => Promise<void>;
}

function emptyRule(): GovernancePolicyRule {
  return {
    pipelineType: 'quality_evaluation',
    metric: GOVERNANCE_METRICS['quality_evaluation'][0],
    operator: 'gte',
    threshold: 0.7,
    severity: 'warning',
  };
}

export function GovernancePolicyEditor({
  open,
  onClose,
  initial,
  onSave,
}: GovernancePolicyEditorProps) {
  const t = useTranslations('governance');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [status, setStatus] = useState<'enabled' | 'disabled'>(initial?.status ?? 'enabled');
  const [rules, setRules] = useState<GovernancePolicyRule[]>(
    initial?.rules?.length ? initial.rules : [emptyRule()],
  );
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = t('policy.error.name_required');
    if (rules.length === 0) errs.rules = t('policy.error.rules_required');
    rules.forEach((r, i) => {
      if (!r.metric) errs[`rule_${i}_metric`] = t('policy.error.metric_required');
      if (isNaN(r.threshold)) errs[`rule_${i}_threshold`] = t('policy.error.threshold_invalid');
    });
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const body = initial
        ? ({
            name: name.trim(),
            description: description.trim() || undefined,
            status,
            rules,
            version: initial.version,
          } satisfies UpdatePolicyBody)
        : ({
            name: name.trim(),
            description: description.trim() || undefined,
            status,
            rules,
          } satisfies CreatePolicyBody);
      await onSave(body);
      toast.success(initial ? t('policy.updated') : t('policy.created'));
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('policy.save_failed'));
    } finally {
      setSaving(false);
    }
  };

  const updateRule = (index: number, patch: Partial<GovernancePolicyRule>) => {
    setRules((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      // Reset metric when pipeline type changes
      if (patch.pipelineType) {
        const metrics = GOVERNANCE_METRICS[patch.pipelineType as keyof typeof GOVERNANCE_METRICS];
        next[index].metric = metrics?.[0] ?? '';
      }
      return next;
    });
  };

  const removeRule = (index: number) => {
    setRules((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <SlidePanel
      open={open}
      onClose={onClose}
      title={initial ? t('policy.edit_title') : t('policy.create_title')}
      description={t('policy.editor_description')}
      width="xl"
    >
      <div className="flex flex-col gap-5 pb-6">
        {/* Name */}
        <Input
          label={t('policy.field.name')}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('policy.field.name_placeholder')}
          error={errors.name}
        />

        {/* Description */}
        <Textarea
          label={t('policy.field.description')}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('policy.field.description_placeholder')}
        />

        {/* Status */}
        <div>
          <label className="mb-1 block text-sm font-medium">{t('policy.field.status')}</label>
          <Select
            options={[
              { value: 'enabled', label: t('policy.status.enabled') },
              { value: 'disabled', label: t('policy.status.disabled') },
            ]}
            value={status}
            onChange={(v) => setStatus(v as 'enabled' | 'disabled')}
          />
        </div>

        {/* Rules */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium">{t('policy.field.rules')}</label>
            <Button
              variant="ghost"
              size="xs"
              icon={<Plus className="w-3 h-3" />}
              onClick={() => setRules((prev) => [...prev, emptyRule()])}
            >
              {t('policy.add_rule')}
            </Button>
          </div>

          {errors.rules && <p className="mb-2 text-xs text-error">{errors.rules}</p>}

          <div className="space-y-3">
            {rules.map((rule, i) => {
              const metricOptions = (
                GOVERNANCE_METRICS[rule.pipelineType as keyof typeof GOVERNANCE_METRICS] ?? []
              ).map((m) => ({ value: m, label: toTitleCase(m) }));

              return (
                <div
                  key={i}
                  className="rounded-lg border border-default bg-background-muted p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted">
                      {t('policy.rule_n', { n: i + 1 })}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      icon={<Trash2 className="w-3.5 h-3.5" />}
                      onClick={() => removeRule(i)}
                      aria-label={`Remove rule ${i + 1}`}
                    />
                  </div>

                  <div className="space-y-2">
                    {/* Row 1: Pipeline Type + Metric */}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block text-xs text-muted">
                          {t('policy.rule.pipeline_type')}
                        </label>
                        <Select
                          options={PIPELINE_OPTIONS}
                          value={rule.pipelineType}
                          onChange={(v) => updateRule(i, { pipelineType: v })}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted">
                          {t('policy.rule.metric')}
                        </label>
                        <Select
                          options={metricOptions}
                          value={rule.metric}
                          onChange={(v) => updateRule(i, { metric: v })}
                        />
                        {errors[`rule_${i}_metric`] && (
                          <p className="mt-1 text-xs text-error">{errors[`rule_${i}_metric`]}</p>
                        )}
                      </div>
                    </div>

                    {/* Row 2: Operator + Threshold + Severity */}
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="mb-1 block text-xs text-muted">
                          {t('policy.rule.operator')}
                        </label>
                        <Select
                          options={OPERATOR_OPTIONS}
                          value={rule.operator}
                          onChange={(v) => updateRule(i, { operator: v as RuleOperator })}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted">
                          {t('policy.rule.threshold')}
                        </label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          max="1"
                          placeholder="0.0 – 1.0"
                          value={rule.threshold}
                          onChange={(e) => updateRule(i, { threshold: parseFloat(e.target.value) })}
                          error={errors[`rule_${i}_threshold`]}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted">
                          {t('policy.rule.severity')}
                        </label>
                        <Select
                          options={SEVERITY_OPTIONS}
                          value={rule.severity}
                          onChange={(v) => updateRule(i, { severity: v as RuleSeverity })}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleSubmit} loading={saving}>
            {initial ? t('action.save') : t('action.create')}
          </Button>
        </div>
      </div>
    </SlidePanel>
  );
}
