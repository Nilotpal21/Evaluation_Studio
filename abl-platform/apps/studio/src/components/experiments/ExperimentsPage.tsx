/**
 * ExperimentsPage Component
 *
 * Lists A/B experiments for the current project with status filter tabs.
 * Renders a table of experiments with inline status badges and a creation dialog.
 */

'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { FlaskConical, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useNavigationStore } from '../../store/navigation-store';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';
import { ListPageShell } from '../ui/ListPageShell';
import { EmptyState } from '../ui/EmptyState';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Tabs } from '../ui/Tabs';
import { Skeleton } from '../ui/Skeleton';
import { DataTable, type Column } from '../ui/DataTable';
import { CreateExperimentDialog } from './CreateExperimentDialog';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Experiment {
  _id: string;
  name: string;
  status: 'draft' | 'running' | 'stopped' | 'completed';
  controlVersion: string;
  experimentVersion: string;
  trafficSplit: number;
  controlAssignments: number;
  experimentAssignments: number;
  createdAt: string;
}

type StatusFilter = 'all' | 'draft' | 'running' | 'stopped' | 'completed';

const STATUS_BADGE_VARIANT: Record<string, BadgeVariant> = {
  running: 'success',
  draft: 'default',
  stopped: 'error',
  completed: 'info',
};

// ─── Component ──────────────────────────────────────────────────────────────

export function ExperimentsPage() {
  const t = useTranslations('experiments');
  const { projectId, navigate } = useNavigationStore();
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [showCreate, setShowCreate] = useState(false);

  const STATUS_TABS = useMemo(
    () => [
      { id: 'all', label: t('status_all') },
      { id: 'draft', label: t('status_draft') },
      { id: 'running', label: t('status_running') },
      { id: 'stopped', label: t('status_stopped') },
      { id: 'completed', label: t('status_completed') },
    ],
    [t],
  );

  const loadExperiments = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const query = statusFilter !== 'all' ? `?status=${statusFilter}` : '';
      const res = await apiFetch(`/api/projects/${projectId}/experiments${query}`);
      const json = (await res.json()) as { success: boolean; data?: Experiment[] };
      if (json.success && json.data) {
        setExperiments(json.data);
      }
    } catch (err) {
      toast.error(sanitizeError(err, t('toast_error')));
    } finally {
      setIsLoading(false);
    }
  }, [projectId, statusFilter, t]);

  useEffect(() => {
    loadExperiments();
  }, [loadExperiments]);

  const handleCreated = useCallback(() => {
    setShowCreate(false);
    toast.success(t('toast_created'));
    loadExperiments();
  }, [loadExperiments, t]);

  const handleRowClick = useCallback(
    (id: string) => {
      if (!projectId) return;
      navigate(`/projects/${projectId}/experiments/${id}`);
    },
    [projectId, navigate],
  );
  const columns: Column<Experiment>[] = [
    {
      key: 'name',
      label: t('col_name'),
      render: (experiment) => (
        <span className="font-medium text-foreground">{experiment.name}</span>
      ),
      sortable: true,
      sortValue: (experiment) => experiment.name,
    },
    {
      key: 'status',
      label: t('col_status'),
      render: (experiment) => (
        <Badge
          variant={STATUS_BADGE_VARIANT[experiment.status] ?? 'default'}
          dot
          pulse={experiment.status === 'running'}
        >
          {t(`status_${experiment.status}`)}
        </Badge>
      ),
      sortable: true,
      sortValue: (experiment) => experiment.status,
    },
    {
      key: 'control',
      label: t('col_control'),
      render: (experiment) => (
        <span className="text-muted font-mono text-xs">{experiment.controlVersion}</span>
      ),
      sortable: true,
      sortValue: (experiment) => experiment.controlVersion,
    },
    {
      key: 'traffic',
      label: t('col_traffic'),
      render: (experiment) => (
        <span className="text-muted">{Math.round(experiment.trafficSplit * 100)}%</span>
      ),
      sortable: true,
      sortValue: (experiment) => experiment.trafficSplit,
    },
    {
      key: 'assignments',
      label: t('col_assignments'),
      render: (experiment) => (
        <span className="text-muted">
          {experiment.controlAssignments} / {experiment.experimentAssignments}
        </span>
      ),
      sortable: true,
      sortValue: (experiment) => experiment.controlAssignments + experiment.experimentAssignments,
    },
    {
      key: 'created',
      label: t('col_created'),
      render: (experiment) => (
        <span className="text-muted">
          {new Date(experiment.createdAt).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
        </span>
      ),
      sortable: true,
      sortValue: (experiment) => new Date(experiment.createdAt).getTime(),
    },
  ];

  if (!projectId) {
    return (
      <ListPageShell title={t('title')}>
        <div className="mt-8">
          <EmptyState
            icon={<FlaskConical className="w-6 h-6" />}
            title={t('no_project')}
            description={t('no_project_description')}
          />
        </div>
      </ListPageShell>
    );
  }

  return (
    <>
      <ListPageShell
        title={t('title')}
        description={t('description')}
        primaryAction={
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => setShowCreate(true)}>
            {t('new_experiment')}
          </Button>
        }
      >
        <Tabs
          tabs={STATUS_TABS}
          activeTab={statusFilter}
          onTabChange={(id) => setStatusFilter(id as StatusFilter)}
          layoutId="experiments-status-tabs"
        />

        <div className="mt-6">
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          ) : experiments.length === 0 ? (
            <EmptyState
              icon={<FlaskConical className="w-6 h-6" />}
              title={t('no_experiments')}
              description={t('no_experiments_description')}
              action={
                <Button icon={<Plus className="w-4 h-4" />} onClick={() => setShowCreate(true)}>
                  {t('new_experiment')}
                </Button>
              }
            />
          ) : (
            <div className="border border-default rounded-xl overflow-hidden">
              <DataTable
                columns={columns}
                data={experiments}
                keyExtractor={(experiment) => experiment._id}
                onRowClick={(experiment) => handleRowClick(experiment._id)}
              />
            </div>
          )}
        </div>
      </ListPageShell>

      <CreateExperimentDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={handleCreated}
        projectId={projectId}
      />
    </>
  );
}
