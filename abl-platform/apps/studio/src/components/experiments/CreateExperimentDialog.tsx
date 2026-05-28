/**
 * CreateExperimentDialog Component
 *
 * Modal form for creating a new A/B experiment with version selection,
 * traffic split, success metrics, and optional safety rules.
 */

'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Textarea } from '../ui/Textarea';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { Slider } from '../ui/Slider';
import { SECTION_LABEL_CLASS } from '../../lib/typography';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SafetyRuleInput {
  metric: string;
  operator: 'lt' | 'gt' | 'lte' | 'gte';
  threshold: string;
  minSampleSize: string;
  comparison: 'absolute' | 'relative_to_control';
}

interface VersionOption {
  agentName: string;
  version: string;
  label: string;
}

interface CreateExperimentDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  projectId: string;
}

function makeEmptyRule(): SafetyRuleInput {
  return {
    metric: '',
    operator: 'gt',
    threshold: '',
    minSampleSize: '100',
    comparison: 'absolute',
  };
}

// ─── Component ──────────────────────────────────────────────────────────────

export function CreateExperimentDialog({
  open,
  onClose,
  onCreated,
  projectId,
}: CreateExperimentDialogProps) {
  const t = useTranslations('experiments');
  const tc = useTranslations('common');

  const operatorOptions = useMemo(
    () => [
      { value: 'lt', label: t('operator_lt') },
      { value: 'gt', label: t('operator_gt') },
      { value: 'lte', label: t('operator_lte') },
      { value: 'gte', label: t('operator_gte') },
    ],
    [t],
  );

  const comparisonOptions = useMemo(
    () => [
      { value: 'absolute', label: t('comparison_absolute') },
      { value: 'relative_to_control', label: t('comparison_relative') },
    ],
    [t],
  );

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [controlVersion, setControlVersion] = useState('');
  const [experimentVersion, setExperimentVersion] = useState('');
  const [trafficSplit, setTrafficSplit] = useState(50);
  const [metricInput, setMetricInput] = useState('');
  const [metrics, setMetrics] = useState<string[]>([]);
  const [safetyRules, setSafetyRules] = useState<SafetyRuleInput[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Versions data
  const [versionOptions, setVersionOptions] = useState<VersionOption[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);

  // Load agent versions when dialog opens
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    async function loadVersions() {
      setLoadingVersions(true);
      try {
        const agentsRes = await apiFetch(`/api/projects/${projectId}/agents`);
        const agentsData = (await agentsRes.json()) as {
          agents?: Array<{ name: string }>;
        };
        const agents = agentsData.agents ?? [];

        const allVersions: VersionOption[] = [];
        const results = await Promise.all(
          agents.map(async (agent) => {
            try {
              const res = await apiFetch(
                `/api/projects/${projectId}/agents/${agent.name}/versions?limit=50`,
              );
              const data = (await res.json()) as {
                versions?: Array<{ version: string; status: string }>;
              };
              return {
                agentName: agent.name,
                versions: (data.versions ?? []).filter((v) => v.status !== 'deprecated'),
              };
            } catch {
              return { agentName: agent.name, versions: [] };
            }
          }),
        );

        for (const { agentName, versions } of results) {
          for (const v of versions) {
            allVersions.push({
              agentName,
              version: v.version,
              label: `${agentName}@${v.version}`,
            });
          }
        }

        if (!cancelled) {
          setVersionOptions(allVersions);
        }
      } catch (err) {
        if (!cancelled) {
          toast.error(sanitizeError(err, t('toast_error')));
        }
      } finally {
        if (!cancelled) {
          setLoadingVersions(false);
        }
      }
    }

    loadVersions();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, t]);

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      setName('');
      setDescription('');
      setControlVersion('');
      setExperimentVersion('');
      setTrafficSplit(50);
      setMetricInput('');
      setMetrics([]);
      setSafetyRules([]);
    }
  }, [open]);

  const selectOptions = useMemo(
    () => versionOptions.map((v) => ({ value: v.version, label: v.label })),
    [versionOptions],
  );

  const addMetric = useCallback(() => {
    const trimmed = metricInput.trim();
    if (trimmed && !metrics.includes(trimmed)) {
      setMetrics((prev) => [...prev, trimmed]);
      setMetricInput('');
    }
  }, [metricInput, metrics]);

  const removeMetric = useCallback((metric: string) => {
    setMetrics((prev) => prev.filter((m) => m !== metric));
  }, []);

  const addSafetyRule = useCallback(() => {
    setSafetyRules((prev) => [...prev, makeEmptyRule()]);
  }, []);

  const removeSafetyRule = useCallback((idx: number) => {
    setSafetyRules((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const updateSafetyRule = useCallback(
    (idx: number, field: keyof SafetyRuleInput, value: string) => {
      setSafetyRules((prev) =>
        prev.map((rule, i) => (i === idx ? { ...rule, [field]: value } : rule)),
      );
    },
    [],
  );

  const canSubmit =
    name.trim().length > 0 &&
    controlVersion.length > 0 &&
    experimentVersion.length > 0 &&
    metrics.length > 0 &&
    !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        controlVersion,
        experimentVersion,
        trafficSplit: trafficSplit / 100,
        successMetrics: metrics,
        safetyRules: safetyRules
          .filter((r) => r.metric.trim().length > 0)
          .map((r) => ({
            metric: r.metric.trim(),
            operator: r.operator,
            threshold: Number(r.threshold),
            minSampleSize: Number(r.minSampleSize) || 100,
            comparison: r.comparison,
          })),
      };

      const res = await apiFetch(`/api/projects/${projectId}/experiments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { success: boolean };
      if (json.success) {
        onCreated();
      }
    } catch (err) {
      toast.error(sanitizeError(err, t('toast_error')));
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    name,
    description,
    controlVersion,
    experimentVersion,
    trafficSplit,
    metrics,
    safetyRules,
    projectId,
    onCreated,
    t,
  ]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('create_title')}
      description={t('create_description')}
      maxWidth="2xl"
    >
      <div className="space-y-5">
        {/* Name */}
        <Input
          label={t('create_name')}
          placeholder={t('create_name_placeholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        {/* Description */}
        <Textarea
          label={t('create_description_field')}
          placeholder={t('create_description_placeholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />

        {/* Version selects */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Select
            label={t('create_control_version')}
            options={selectOptions}
            value={controlVersion}
            onChange={setControlVersion}
            placeholder={loadingVersions ? t('loading') : t('create_control_placeholder')}
            disabled={loadingVersions}
          />
          <Select
            label={t('create_experiment_version')}
            options={selectOptions}
            value={experimentVersion}
            onChange={setExperimentVersion}
            placeholder={loadingVersions ? t('loading') : t('create_experiment_placeholder')}
            disabled={loadingVersions}
          />
        </div>

        {/* Traffic Split */}
        <div className="space-y-1.5">
          <Slider
            label={t('create_traffic_split')}
            valueLabel={`${trafficSplit}%`}
            min={1}
            max={99}
            value={trafficSplit}
            onChange={(e) => setTrafficSplit(Number(e.target.value))}
          />
          <div className="flex justify-between text-xs text-muted">
            <span>1%</span>
            <span>99%</span>
          </div>
        </div>

        {/* Success Metrics */}
        <div className="space-y-2">
          <div className={SECTION_LABEL_CLASS}>{t('create_success_metrics')}</div>
          <div className="flex gap-2">
            <Input
              placeholder={t('create_metrics_placeholder')}
              value={metricInput}
              onChange={(e) => setMetricInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addMetric();
                }
              }}
              className="flex-1"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={addMetric}
              disabled={metricInput.trim().length === 0}
            >
              {t('create_add_metric')}
            </Button>
          </div>
          {metrics.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {metrics.map((m) => (
                <span
                  key={m}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-background-muted text-foreground rounded-lg border border-default"
                >
                  {m}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    icon={<Trash2 className="w-3 h-3" />}
                    onClick={() => removeMetric(m)}
                    aria-label={t('remove_metric_label', { metric: m })}
                  />
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Safety Rules */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className={SECTION_LABEL_CLASS}>{t('create_safety_rules')}</div>
            <Button
              size="xs"
              variant="ghost"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={addSafetyRule}
            >
              {t('create_add_rule')}
            </Button>
          </div>

          {safetyRules.map((rule, idx) => (
            <div
              key={idx}
              className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-2 items-end border border-default rounded-lg p-3 bg-background-subtle"
            >
              <Input
                label={idx === 0 ? t('create_rule_metric') : undefined}
                placeholder={t('create_rule_metric')}
                value={rule.metric}
                onChange={(e) => updateSafetyRule(idx, 'metric', e.target.value)}
              />
              <Select
                label={idx === 0 ? t('create_rule_operator') : undefined}
                options={operatorOptions}
                value={rule.operator}
                onChange={(v) => updateSafetyRule(idx, 'operator', v)}
              />
              <Input
                label={idx === 0 ? t('create_rule_threshold') : undefined}
                placeholder="0.5"
                type="number"
                value={rule.threshold}
                onChange={(e) => updateSafetyRule(idx, 'threshold', e.target.value)}
              />
              <Input
                label={idx === 0 ? t('create_rule_min_sample') : undefined}
                placeholder="100"
                type="number"
                value={rule.minSampleSize}
                onChange={(e) => updateSafetyRule(idx, 'minSampleSize', e.target.value)}
              />
              <Select
                label={idx === 0 ? t('create_rule_comparison') : undefined}
                options={comparisonOptions}
                value={rule.comparison}
                onChange={(v) => updateSafetyRule(idx, 'comparison', v)}
              />
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 className="w-3.5 h-3.5" />}
                onClick={() => removeSafetyRule(idx)}
                className="self-end"
                aria-label={t('remove_rule_label', { index: idx + 1 })}
              />
            </div>
          ))}
        </div>

        {/* Submit */}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button loading={submitting} disabled={!canSubmit} onClick={handleSubmit}>
            {submitting ? t('create_creating') : t('create_submit')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
