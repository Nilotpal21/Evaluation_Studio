/**
 * ExperimentDetail Component
 *
 * Detail view for a single A/B experiment showing configuration,
 * results, safety rules, and action buttons based on current status.
 */

'use client';

import { useState, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Play, Square, CheckCircle2, Trash2, RefreshCw } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';
import { DetailPageShell } from '../ui/DetailPageShell';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { SkeletonTable } from '../ui/Skeleton';
import { DataTable, type Column } from '../ui/DataTable';
import { MetricCard } from '../ui/MetricCard';
import { Section } from '../ui/Section';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SignificanceResult {
  metric: string;
  controlMean: number;
  experimentMean: number;
  pValue: number;
  significant: boolean;
  lift: number;
}

interface ExperimentResults {
  controlSampleSize: number;
  experimentSampleSize: number;
  significance: SignificanceResult[];
  sampleSizeAdequate: boolean;
  computedAt: string;
}

interface SafetyRule {
  metric: string;
  operator: 'lt' | 'gt' | 'lte' | 'gte';
  threshold: number;
  minSampleSize: number;
  comparison: 'absolute' | 'relative_to_control';
}

interface BreachDetail {
  metric: string;
  value: number;
  controlValue: number | null;
  threshold: number;
  comparison: string;
  checkedAt: string;
}

interface Experiment {
  _id: string;
  name: string;
  description?: string;
  status: 'draft' | 'running' | 'stopped' | 'completed';
  controlVersion: string;
  experimentVersion: string;
  trafficSplit: number;
  successMetrics: string[];
  safetyRules: SafetyRule[];
  channels: string[];
  controlAssignments: number;
  experimentAssignments: number;
  results: ExperimentResults | null;
  breachDetail: BreachDetail | null;
  stoppedReason: string | null;
  startedAt?: string;
  stoppedAt?: string;
  createdAt: string;
}

const STATUS_BADGE_VARIANT: Record<string, BadgeVariant> = {
  running: 'success',
  draft: 'default',
  stopped: 'error',
  completed: 'info',
};

// ─── Component ──────────────────────────────────────────────────────────────

export function ExperimentDetail() {
  const t = useTranslations('experiments');
  const { projectId, subPage: experimentId, navigate } = useNavigationStore();
  const [experiment, setExperiment] = useState<Experiment | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<'delete' | 'stop' | 'complete' | null>(null);
  const [computingResults, setComputingResults] = useState(false);

  const loadExperiment = useCallback(async () => {
    if (!projectId || !experimentId) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/experiments/${experimentId}`);
      const json = (await res.json()) as { success: boolean; data?: Experiment };
      if (json.success && json.data) {
        setExperiment(json.data);
      }
    } catch (err) {
      toast.error(sanitizeError(err, t('toast_error')));
    } finally {
      setIsLoading(false);
    }
  }, [projectId, experimentId, t]);

  useEffect(() => {
    loadExperiment();
  }, [loadExperiment]);

  const handleAction = useCallback(
    async (action: 'start' | 'stop' | 'complete' | 'delete') => {
      if (!projectId || !experimentId) return;
      setActionLoading(action);
      try {
        const method = action === 'delete' ? 'DELETE' : 'POST';
        const url =
          action === 'delete'
            ? `/api/projects/${projectId}/experiments/${experimentId}`
            : `/api/projects/${projectId}/experiments/${experimentId}/${action}`;

        const res = await apiFetch(url, { method });
        const json = (await res.json()) as { success: boolean };

        if (json.success) {
          const toastKey =
            `toast_${action === 'start' ? 'started' : action === 'stop' ? 'stopped' : action === 'complete' ? 'completed' : 'deleted'}` as const;
          toast.success(t(toastKey));

          if (action === 'delete') {
            navigate(`/projects/${projectId}/experiments`);
          } else {
            await loadExperiment();
          }
        }
      } catch (err) {
        toast.error(sanitizeError(err, t('toast_error')));
      } finally {
        setActionLoading(null);
        setConfirmAction(null);
      }
    },
    [projectId, experimentId, navigate, loadExperiment, t],
  );

  const handleComputeResults = useCallback(async () => {
    if (!projectId || !experimentId) return;
    setComputingResults(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/experiments/${experimentId}/results`, {
        method: 'POST',
      });
      const json = (await res.json()) as { success: boolean };
      if (json.success) {
        toast.success(t('toast_results_computed'));
        await loadExperiment();
      }
    } catch (err) {
      toast.error(sanitizeError(err, t('toast_error')));
    } finally {
      setComputingResults(false);
    }
  }, [projectId, experimentId, loadExperiment, t]);
  const significanceColumns: Column<SignificanceResult>[] = [
    {
      key: 'metric',
      label: t('detail_metric'),
      render: (sig) => <span className="font-medium text-foreground">{sig.metric}</span>,
    },
    {
      key: 'controlMean',
      label: t('detail_control_mean'),
      render: (sig) => <span className="text-muted font-mono">{sig.controlMean.toFixed(4)}</span>,
      sortable: true,
      sortValue: (sig) => sig.controlMean,
    },
    {
      key: 'experimentMean',
      label: t('detail_experiment_mean'),
      render: (sig) => (
        <span className="text-muted font-mono">{sig.experimentMean.toFixed(4)}</span>
      ),
      sortable: true,
      sortValue: (sig) => sig.experimentMean,
    },
    {
      key: 'pValue',
      label: t('detail_p_value'),
      render: (sig) => <span className="text-muted font-mono">{sig.pValue.toFixed(4)}</span>,
      sortable: true,
      sortValue: (sig) => sig.pValue,
    },
    {
      key: 'lift',
      label: t('detail_lift'),
      render: (sig) => <span className="text-muted">{(sig.lift * 100).toFixed(1)}%</span>,
      sortable: true,
      sortValue: (sig) => sig.lift,
    },
    {
      key: 'significant',
      label: t('detail_significant'),
      render: (sig) => (
        <Badge variant={sig.significant ? 'success' : 'default'}>
          {sig.significant ? t('detail_yes') : t('detail_no')}
        </Badge>
      ),
      sortable: true,
      sortValue: (sig) => (sig.significant ? 1 : 0),
    },
  ];
  const safetyRuleColumns: Column<SafetyRule>[] = [
    {
      key: 'metric',
      label: t('detail_safety_metric'),
      render: (rule) => <span className="font-medium text-foreground">{rule.metric}</span>,
    },
    {
      key: 'operator',
      label: t('detail_safety_operator'),
      render: (rule) => <span className="text-muted">{t(`operator_${rule.operator}`)}</span>,
      sortable: true,
      sortValue: (rule) => rule.operator,
    },
    {
      key: 'threshold',
      label: t('detail_safety_threshold'),
      render: (rule) => <span className="text-muted font-mono">{rule.threshold}</span>,
      sortable: true,
      sortValue: (rule) => rule.threshold,
    },
    {
      key: 'minSample',
      label: t('detail_safety_min_sample'),
      render: (rule) => <span className="text-muted">{rule.minSampleSize}</span>,
      sortable: true,
      sortValue: (rule) => rule.minSampleSize,
    },
    {
      key: 'comparison',
      label: t('detail_safety_comparison'),
      render: (rule) => <span className="text-muted">{t(`comparison_${rule.comparison}`)}</span>,
      sortable: true,
      sortValue: (rule) => rule.comparison,
    },
    {
      key: 'status',
      label: t('detail_safety_status'),
      render: (rule) => {
        const breached = experiment?.breachDetail?.metric === rule.metric;
        return breached ? (
          <Badge variant="error">{t('detail_breach')}</Badge>
        ) : (
          <Badge variant="success">{t('detail_pass')}</Badge>
        );
      },
    },
  ];

  if (isLoading || !experiment) {
    return (
      <DetailPageShell
        title={t('loading')}
        backTo={{
          label: t('detail_back'),
          onClick: () => navigate(`/projects/${projectId}/experiments`),
        }}
      >
        <SkeletonTable rows={4} cols={3} />
      </DetailPageShell>
    );
  }

  const status = experiment.status;

  return (
    <>
      <DetailPageShell
        title={experiment.name}
        backTo={{
          label: t('detail_back'),
          onClick: () => navigate(`/projects/${projectId}/experiments`),
        }}
        actions={
          <div className="flex items-center gap-2">
            <Badge
              variant={STATUS_BADGE_VARIANT[status] ?? 'default'}
              dot
              pulse={status === 'running'}
            >
              {t(`status_${status}`)}
            </Badge>
            {status === 'draft' && (
              <>
                <Button
                  size="sm"
                  icon={<Play className="w-3.5 h-3.5" />}
                  loading={actionLoading === 'start'}
                  disabled={actionLoading !== null}
                  onClick={() => handleAction('start')}
                >
                  {actionLoading === 'start' ? t('action_starting') : t('action_start')}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Trash2 className="w-3.5 h-3.5" />}
                  loading={actionLoading === 'delete'}
                  disabled={actionLoading !== null}
                  onClick={() => setConfirmAction('delete')}
                >
                  {t('action_delete')}
                </Button>
              </>
            )}
            {status === 'running' && (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Square className="w-3.5 h-3.5" />}
                  loading={actionLoading === 'stop'}
                  disabled={actionLoading !== null}
                  onClick={() => setConfirmAction('stop')}
                >
                  {t('action_stop')}
                </Button>
                <Button
                  size="sm"
                  icon={<CheckCircle2 className="w-3.5 h-3.5" />}
                  loading={actionLoading === 'complete'}
                  disabled={actionLoading !== null}
                  onClick={() => setConfirmAction('complete')}
                >
                  {t('action_complete')}
                </Button>
              </>
            )}
          </div>
        }
      >
        {/* Description */}
        {experiment.description && (
          <p className="text-sm text-muted mb-6">{experiment.description}</p>
        )}

        <Section title={t('detail_config')} className="mb-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ConfigItem
              label={t('detail_control_version')}
              value={experiment.controlVersion}
              mono
            />
            <ConfigItem
              label={t('detail_experiment_version')}
              value={experiment.experimentVersion}
              mono
            />
            <ConfigItem
              label={t('detail_traffic_split')}
              value={`${Math.round(experiment.trafficSplit * 100)}% experiment / ${Math.round((1 - experiment.trafficSplit) * 100)}% control`}
            />
            <ConfigItem
              label={t('detail_channels')}
              value={
                experiment.channels.length > 0
                  ? experiment.channels.join(', ')
                  : t('detail_no_channels')
              }
            />
            <ConfigItem
              label={t('detail_success_metrics')}
              value={experiment.successMetrics.join(', ')}
            />
            {experiment.startedAt && (
              <ConfigItem
                label={t('detail_started_at')}
                value={new Date(experiment.startedAt).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              />
            )}
            {experiment.stoppedAt && (
              <ConfigItem
                label={t('detail_stopped_at')}
                value={new Date(experiment.stoppedAt).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              />
            )}
            {experiment.stoppedReason && (
              <ConfigItem
                label={t('detail_stopped_reason')}
                value={t(`stopped_reason_${experiment.stoppedReason}`)}
              />
            )}
          </div>

          {/* Assignment counts */}
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <MetricCard label={t('detail_control_n')} value={experiment.controlAssignments} />
            <MetricCard label={t('detail_experiment_n')} value={experiment.experimentAssignments} />
          </div>
        </Section>

        <Section
          title={t('detail_results')}
          className="mb-8"
          actions={
            status === 'running' || status === 'stopped' || status === 'completed' ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<RefreshCw className="w-3.5 h-3.5" />}
                loading={computingResults}
                disabled={computingResults}
                onClick={handleComputeResults}
              >
                {computingResults ? t('detail_computing') : t('detail_compute_results')}
              </Button>
            ) : undefined
          }
        >
          {experiment.results ? (
            <div>
              <div className="flex gap-6 mb-4 text-sm">
                <div>
                  <span className="text-muted">{t('detail_sample_size')}: </span>
                  <span className="font-medium text-foreground">
                    {experiment.results.controlSampleSize} /{' '}
                    {experiment.results.experimentSampleSize}
                  </span>
                </div>
                <Badge variant={experiment.results.sampleSizeAdequate ? 'success' : 'warning'}>
                  {experiment.results.sampleSizeAdequate
                    ? t('detail_adequate')
                    : t('detail_insufficient')}
                </Badge>
              </div>

              {experiment.results.significance.length > 0 ? (
                <div className="border border-default rounded-xl overflow-hidden">
                  <DataTable
                    columns={significanceColumns}
                    data={experiment.results.significance}
                    keyExtractor={(sig) => sig.metric}
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted">{t('detail_no_results')}</p>
          )}
        </Section>

        <Section title={t('detail_safety')} className="mb-8">
          {experiment.safetyRules.length > 0 ? (
            <div className="border border-default rounded-xl overflow-hidden">
              <DataTable
                columns={safetyRuleColumns}
                data={experiment.safetyRules}
                keyExtractor={(rule) =>
                  `${rule.metric}-${rule.operator}-${rule.threshold}-${rule.minSampleSize}`
                }
              />
            </div>
          ) : (
            <p className="text-sm text-muted">{t('detail_no_safety_rules')}</p>
          )}
        </Section>
      </DetailPageShell>

      {/* Confirm dialogs */}
      <ConfirmDialog
        open={confirmAction === 'delete'}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => handleAction('delete')}
        title={t('confirm_delete_title')}
        description={t('confirm_delete_description')}
        variant="danger"
        loading={actionLoading === 'delete'}
      />
      <ConfirmDialog
        open={confirmAction === 'stop'}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => handleAction('stop')}
        title={t('confirm_stop_title')}
        description={t('confirm_stop_description')}
        variant="danger"
        loading={actionLoading === 'stop'}
      />
      <ConfirmDialog
        open={confirmAction === 'complete'}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => handleAction('complete')}
        title={t('confirm_complete_title')}
        description={t('confirm_complete_description')}
        variant="primary"
        loading={actionLoading === 'complete'}
      />
    </>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function ConfigItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-default bg-background-subtle px-4 py-3">
      <dt className="text-xs text-muted mb-1">{label}</dt>
      <dd className={`text-sm text-foreground ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
