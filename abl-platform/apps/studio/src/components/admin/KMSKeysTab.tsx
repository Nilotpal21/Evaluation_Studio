'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Layers3,
  Loader2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { MetricCard } from '../ui/MetricCard';
import { Pagination } from '../ui/Pagination';
import { Select } from '../ui/Select';
import { rotateKMSKeys, type KMSDEKEntry, useKMSKeys } from '../../hooks/useKMS';
import { compactNumber, humanizeProvider, providerVariant } from './kms-utils';
import { KMSDEKModal } from './KMSDEKModal';

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

function statusVariant(status: KMSDEKEntry['status']): 'success' | 'warning' | 'error' | 'default' {
  switch (status) {
    case 'active':
      return 'success';
    case 'decrypt_only':
      return 'warning';
    case 'destroyed':
      return 'error';
    default:
      return 'default';
  }
}

function scopeLabel(value: string): string {
  switch (value) {
    case '_tenant':
      return 'Tenant Default';
    case '_project':
      return 'Project Default';
    default:
      return value;
  }
}

function KeyRow({ entry, onClick }: { entry: KMSDEKEntry; onClick: () => void }) {
  const t = useTranslations('admin');

  return (
    <tr
      className="cursor-pointer align-top transition-default hover:bg-background-muted"
      onClick={onClick}
    >
      <td className="px-4 py-3">
        <code className="inline-block rounded bg-background-muted px-1.5 py-0.5 text-xs text-foreground">
          {entry.dekId}
        </code>
      </td>
      <td className="px-4 py-3">
        <Badge variant={statusVariant(entry.status)} dot>
          {entry.status}
        </Badge>
      </td>
      <td className="px-4 py-3">
        <div className="space-y-1 text-sm text-foreground">
          <p>{scopeLabel(entry.projectId)}</p>
          <p className="text-xs text-muted">{scopeLabel(entry.environment)}</p>
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge variant={providerVariant(entry.wrappingProvider?.providerType)}>
          {humanizeProvider(entry.wrappingProvider?.providerType)}
        </Badge>
      </td>
      <td className="px-4 py-3">
        <p className="text-sm text-foreground">{`${entry.usageCount} / ${compactNumber(entry.maxUsageCount)}`}</p>
      </td>
    </tr>
  );
}

export function KMSKeysTab() {
  const t = useTranslations('admin');
  const [status, setStatus] = useState('');
  const [projectId, setProjectId] = useState('');
  const [environment, setEnvironment] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [rotating, setRotating] = useState(false);
  const [selectedDEK, setSelectedDEK] = useState<KMSDEKEntry | null>(null);

  const offset = (page - 1) * pageSize;
  const { keys, total, hasMore, summary, filters, isLoading, error, mutate } = useKMSKeys({
    status: status || undefined,
    projectId: projectId || undefined,
    environment: environment || undefined,
    limit: pageSize,
    offset,
  });

  const totalPages = Math.max(1, Math.ceil(Math.max(total, 1) / pageSize));
  const hasActiveFilters = Boolean(status || projectId || environment);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const handleRotate = async () => {
    try {
      setRotating(true);
      const result = await rotateKMSKeys({
        projectId: projectId || undefined,
        environment: environment || undefined,
      });
      toast.success(result?.message || t('kms.keys_rotated'));
      await mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('kms.rotate_failed'));
    } finally {
      setRotating(false);
    }
  };

  const handleReset = () => {
    setStatus('');
    setProjectId('');
    setEnvironment('');
    setPage(1);
  };

  const statusOptions = useMemo(
    () => [
      { value: '', label: t('kms.keys_status_all') },
      ...filters.statuses.map((facet) => ({
        value: facet.status,
        label: `${facet.status} (${facet.count})`,
      })),
    ],
    [filters.statuses, t],
  );

  const projectOptions = useMemo(
    () => [
      { value: '', label: t('kms.keys_project_all') },
      ...filters.projects.map((value) => ({ value, label: scopeLabel(value) })),
    ],
    [filters.projects, t],
  );

  const environmentOptions = useMemo(
    () => [
      { value: '', label: t('kms.keys_environment_all') },
      ...filters.environments.map((value) => ({ value, label: scopeLabel(value) })),
    ],
    [filters.environments, t],
  );

  const summaryCards = [
    {
      label: t('kms.active_deks'),
      value: summary.activeCount,
      context: t('kms.keys_active_context'),
      icon: <ShieldCheck className="h-4 w-4" />,
    },
    {
      label: t('kms.decrypt_only_deks'),
      value: summary.decryptOnlyCount,
      context: t('kms.keys_decrypt_only_context'),
      icon: <RotateCcw className="h-4 w-4" />,
    },
    {
      label: t('kms.keys_destroyed_total'),
      value: summary.destroyedCount,
      context: t('kms.keys_destroyed_context_short'),
      icon: <Trash2 className="h-4 w-4" />,
    },
  ];

  if (isLoading && keys.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-foreground">{t('kms.tabs.keys')}</h2>
          <p className="text-sm text-muted">{t('kms.keys_subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              icon={<RotateCcw className="h-3.5 w-3.5" />}
            >
              {t('kms.keys_reset')}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => mutate()}
            disabled={isLoading}
            icon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            {t('kms.audit_refresh')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleRotate}
            loading={rotating}
            icon={<RotateCw className="h-3.5 w-3.5" />}
          >
            {t('kms.rotate_keys')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {summaryCards.map((card) => (
          <MetricCard
            key={card.label}
            label={card.label}
            value={card.value}
            context={card.context}
            icon={card.icon}
          />
        ))}
      </div>

      <div className="grid gap-3 rounded-xl border border-default bg-background-elevated p-4 md:grid-cols-2 xl:grid-cols-4">
        <Select
          label={t('kms.col_status')}
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
          options={statusOptions}
        />
        <Select
          label={t('kms.keys_project_filter')}
          value={projectId}
          onChange={(value) => {
            setProjectId(value);
            setPage(1);
          }}
          options={projectOptions}
        />
        <Select
          label={t('kms.keys_environment_filter')}
          value={environment}
          onChange={(value) => {
            setEnvironment(value);
            setPage(1);
          }}
          options={environmentOptions}
        />
        <div className="flex items-end">
          <div className="w-full rounded-lg border border-dashed border-default bg-background-subtle px-3 py-2 text-xs text-muted">
            {hasActiveFilters ? t('kms.keys_filters_active') : t('kms.keys_filters_idle')}
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-error/30 bg-error/5 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-error" />
          <p className="text-sm text-error">{error}</p>
        </div>
      )}

      {keys.length === 0 ? (
        <EmptyState
          icon={<Layers3 className="h-6 w-6" />}
          title={t('kms.keys_empty_title')}
          description={t('kms.keys_empty_description')}
        />
      ) : (
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-xl border border-default">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-default bg-background-muted">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted">
                    {t('kms.col_key_id')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted">
                    {t('kms.col_status')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted">
                    {t('kms.col_scope')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted">
                    {t('kms.col_provider')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted">
                    {t('kms.col_usage')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {keys.map((entry) => (
                  <KeyRow key={entry._id} entry={entry} onClick={() => setSelectedDEK(entry)} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted">
              {t('kms.keys_page_summary_click_hint', {
                shown: keys.length,
                total,
              })}
            </p>
            <Pagination
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
              showPageSize
              pageSize={pageSize}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          </div>
          {!hasMore && total > 0 && page === totalPages && (
            <p className="text-xs text-muted">{t('kms.keys_end_of_results')}</p>
          )}
        </div>
      )}

      <KMSDEKModal entry={selectedDEK} onClose={() => setSelectedDEK(null)} />
    </div>
  );
}
