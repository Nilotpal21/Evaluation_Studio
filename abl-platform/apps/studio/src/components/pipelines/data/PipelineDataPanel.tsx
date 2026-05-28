/**
 * PipelineDataPanel Component
 *
 * Full-page Data tab that composes pipeline selection, session ID input,
 * time range, filters, query action, and the ClickHousePreviewTable.
 *
 * Used in PipelinesListPage when activeTab === 'data'.
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Search, Database } from 'lucide-react';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { FilterSelect } from '../../ui/FilterSelect';
import { Skeleton } from '../../ui/Skeleton';
import { PipelineObservabilityScopeNotice } from '../PipelineObservabilityScopeNotice';
import { DataFilterRow } from './DataFilterRow';
import { ClickHousePreviewTable } from './ClickHousePreviewTable';
import { usePreviewablePipelines } from './usePreviewablePipelines';
import { useOutputSchema } from './useOutputSchema';
import type { DataFilter } from './types';

interface PipelineDataPanelProps {
  projectId: string;
}

/** Time range presets matching the runs panel convention */
type TimeRangePreset = '1h' | '24h' | '7d';

function timeRangeFromPreset(preset: TimeRangePreset): { from: Date; to: Date } {
  const now = new Date();
  const ms: Record<TimeRangePreset, number> = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  };
  return { from: new Date(now.getTime() - ms[preset]), to: now };
}

export function PipelineDataPanel({ projectId }: PipelineDataPanelProps) {
  const t = useTranslations('pipelines');

  // Pipeline selection
  const {
    pipelines,
    meta: previewMeta,
    isLoading: pipelinesLoading,
  } = usePreviewablePipelines(projectId);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>('');

  // Filters
  const [sessionId, setSessionId] = useState('');
  const [timePreset, setTimePreset] = useState<TimeRangePreset>('24h');
  const [filters, setFilters] = useState<DataFilter[]>([]);

  // Query trigger — increment to force ClickHousePreviewTable re-render with new params
  const [queryVersion, setQueryVersion] = useState(0);

  // Schema for building filter rows
  const { schema } = useOutputSchema(selectedPipelineId || null, projectId);

  const pipelineOptions = useMemo(() => {
    const base = [{ value: '', label: t('data.select_pipeline') }];
    return [
      ...base,
      ...pipelines.map((p) => ({
        value: p.id,
        label: `${p.name} (${p.kind})`,
      })),
    ];
  }, [pipelines, t]);

  const timeOptions = useMemo(
    () => [
      { value: '1h', label: t('filters.window_1h') },
      { value: '24h', label: t('filters.window_24h') },
      { value: '7d', label: t('filters.window_7d') },
    ],
    [t],
  );

  const handleAddFilter = useCallback(() => {
    const filterableCols = schema?.columns.filter((c) => c.filterable) ?? [];
    const defaultCol = filterableCols[0]?.name ?? '';
    setFilters((prev) => [...prev, { column: defaultCol, op: '=', value: '' }]);
  }, [schema]);

  const handleUpdateFilter = useCallback((index: number, updated: DataFilter) => {
    setFilters((prev) => prev.map((f, i) => (i === index ? updated : f)));
  }, []);

  const handleRemoveFilter = useCallback((index: number) => {
    setFilters((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleQuery = useCallback(() => {
    setQueryVersion((v) => v + 1);
  }, []);

  if (pipelinesLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64 rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  // Active filters (only those with non-empty values)
  const activeFilters = filters.filter((f) => f.column && f.value);
  const timeRange = timeRangeFromPreset(timePreset);

  return (
    <div className="space-y-4">
      <PipelineObservabilityScopeNotice contract={previewMeta?.contract} surface="data" />

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <FilterSelect
          options={pipelineOptions}
          value={selectedPipelineId}
          onChange={setSelectedPipelineId}
        />
        <FilterSelect
          options={timeOptions}
          value={timePreset}
          onChange={(v) => setTimePreset(v as TimeRangePreset)}
        />
        <input
          type="text"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          placeholder={t('data.session_id_placeholder')}
          className="w-48 rounded-lg border border-default bg-background-subtle text-foreground text-sm py-1.5 px-2.5 placeholder:text-subtle transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
        />
      </div>

      {/* Column filters */}
      {selectedPipelineId && schema && (
        <div className="space-y-2">
          {filters.map((filter, idx) => (
            <DataFilterRow
              key={idx}
              filter={filter}
              columns={schema.columns}
              onChange={(updated) => handleUpdateFilter(idx, updated)}
              onRemove={() => handleRemoveFilter(idx)}
            />
          ))}
          {schema.columns.some((c) => c.filterable) && (
            <Button
              variant="ghost"
              size="xs"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={handleAddFilter}
            >
              {t('data.add_filter')}
            </Button>
          )}
        </div>
      )}

      {/* Action buttons */}
      {selectedPipelineId && (
        <div className="flex items-center gap-2">
          <Button size="sm" icon={<Search className="w-3.5 h-3.5" />} onClick={handleQuery}>
            {t('data.query_button')}
          </Button>
        </div>
      )}

      {/* Content area */}
      {!selectedPipelineId && (
        <EmptyState
          icon={<Database className="w-6 h-6" />}
          title={t('data.empty_select_pipeline_title')}
          description={t('data.empty_select_pipeline_description')}
        />
      )}

      {selectedPipelineId && queryVersion > 0 && (
        <ClickHousePreviewTable
          key={queryVersion}
          projectId={projectId}
          pipelineId={selectedPipelineId}
          sessionId={sessionId || undefined}
          timeRange={timeRange}
          filters={activeFilters}
          variant="full"
        />
      )}
    </div>
  );
}
