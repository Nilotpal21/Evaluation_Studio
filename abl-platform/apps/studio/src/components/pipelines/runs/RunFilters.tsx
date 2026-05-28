/**
 * RunFilters Component
 *
 * Filter controls for the Recent Runs panel: Type, Pipeline, Status, Time window.
 * Bound to the pipeline-runs-store.
 */

'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { FilterSelect } from '../../ui/FilterSelect';
import { useRunsStore } from '../../../store/pipeline-runs-store';

export function RunFilters() {
  const t = useTranslations('pipelines');
  const typeFilter = useRunsStore((s) => s.typeFilter);
  const setTypeFilter = useRunsStore((s) => s.setTypeFilter);
  const statusFilter = useRunsStore((s) => s.statusFilter);
  const setStatusFilter = useRunsStore((s) => s.setStatusFilter);
  const timeWindow = useRunsStore((s) => s.timeWindow);
  const setTimeWindow = useRunsStore((s) => s.setTimeWindow);

  const typeOptions = useMemo(
    () => [
      { value: 'all', label: t('filters.type_all') },
      { value: 'builtin', label: t('filters.type_builtin') },
      { value: 'custom', label: t('filters.type_custom') },
    ],
    [t],
  );

  const statusOptions = useMemo(
    () => [
      { value: 'all', label: t('filters.status_all') },
      { value: 'pending', label: 'Pending' },
      { value: 'running', label: 'Running' },
      { value: 'completed', label: 'Completed' },
      { value: 'failed', label: 'Failed' },
      { value: 'cancelled', label: 'Cancelled' },
    ],
    [t],
  );

  const windowOptions = useMemo(
    () => [
      { value: '1h', label: t('filters.window_1h') },
      { value: '24h', label: t('filters.window_24h') },
      { value: '7d', label: t('filters.window_7d') },
    ],
    [t],
  );

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <FilterSelect
        options={typeOptions}
        value={typeFilter}
        onChange={(v) => setTypeFilter(v as typeof typeFilter)}
      />
      <FilterSelect
        options={statusOptions}
        value={statusFilter}
        onChange={(v) => setStatusFilter(v as typeof statusFilter)}
      />
      <FilterSelect
        options={windowOptions}
        value={timeWindow}
        onChange={(v) => setTimeWindow(v as typeof timeWindow)}
      />
    </div>
  );
}
