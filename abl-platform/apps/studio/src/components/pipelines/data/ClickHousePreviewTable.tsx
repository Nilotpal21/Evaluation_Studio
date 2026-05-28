/**
 * ClickHousePreviewTable Component
 *
 * Renders a paginated table of ClickHouse query results for a pipeline's
 * output data. Supports two variants:
 * - 'full': used in the Data tab with full filter context
 * - 'drawer': used inside RunDetailDrawer, pre-filtered to a specific run
 *
 * Fetches data via POST /api/runtime/projects/:projectId/pipeline-observability/data/query.
 * Handles pagination with "Load more" and maps backend error codes to
 * user-friendly empty states / toasts.
 */

'use client';

import { useState, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Database, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { EmptyState } from '../../ui/EmptyState';
import { useOutputSchema } from './useOutputSchema';
import { useRunsStore } from '../../../store/pipeline-runs-store';
import { apiFetch } from '../../../lib/api-client';
import type { DataFilter, PipelineDataQueryResponse } from './types';

const PAGE_SIZE = 50;
const CUSTOM_DIMENSIONS_COLUMN = 'custom_dimensions';

interface ClickHousePreviewTableProps {
  projectId: string;
  pipelineId: string;
  runId?: string;
  sessionId?: string;
  timeRange?: { from: Date; to: Date };
  filters?: DataFilter[];
  variant?: 'full' | 'drawer';
}

/** Map backend error codes to i18n keys for user-facing messages */
function getErrorMessageKey(code: string): string {
  switch (code) {
    case 'NO_OUTPUT_TABLE':
      return 'data.error_no_output_table';
    case 'NOT_FOUND':
      return 'data.error_not_found';
    case 'VALIDATION_ERROR':
      return 'data.error_validation';
    case 'INVALID_FILTER':
    case 'INVALID_COLUMN':
    case 'INVALID_TABLE':
      return 'data.error_invalid_query';
    case 'RATE_LIMITED':
      return 'data.error_rate_limited';
    case 'QUERY_TIMEOUT':
      return 'data.error_query_timeout';
    case 'SCAN_LIMIT':
      return 'data.error_scan_limit';
    default:
      return 'data.error_generic';
  }
}

function parseCustomDimensions(value: unknown): Record<string, number> {
  let parsed = value;
  if (typeof value === 'string') {
    if (!value.trim()) return {};
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out: Record<string, number> = {};
  for (const [key, rawScore] of Object.entries(parsed as Record<string, unknown>)) {
    const score = Number(rawScore);
    if (key && Number.isFinite(score)) {
      out[key] = score;
    }
  }
  return out;
}

export function expandCustomDimensionRows(
  rows: Record<string, unknown>[],
  columns: string[],
): { rows: Record<string, unknown>[]; columns: string[] } {
  const customKeys = new Set<string>();
  const expandedRows = rows.map((row) => {
    const customDimensions = parseCustomDimensions(row[CUSTOM_DIMENSIONS_COLUMN]);
    for (const key of Object.keys(customDimensions)) {
      customKeys.add(key);
    }
    return { ...row, ...customDimensions };
  });

  if (customKeys.size === 0) {
    return { rows, columns };
  }

  const displayColumns = columns.filter((col) => col !== CUSTOM_DIMENSIONS_COLUMN);
  const insertionIndex = Math.max(
    displayColumns.indexOf('instruction_following'),
    displayColumns.indexOf('professionalism'),
    displayColumns.indexOf('accuracy'),
    displayColumns.indexOf('helpfulness'),
    displayColumns.indexOf('overall_score'),
  );
  const customColumns = Array.from(customKeys).filter((key) => !displayColumns.includes(key));

  if (insertionIndex === -1) {
    return { rows: expandedRows, columns: [...displayColumns, ...customColumns] };
  }

  return {
    rows: expandedRows,
    columns: [
      ...displayColumns.slice(0, insertionIndex + 1),
      ...customColumns,
      ...displayColumns.slice(insertionIndex + 1),
    ],
  };
}

export function ClickHousePreviewTable({
  projectId,
  pipelineId,
  runId,
  sessionId,
  timeRange,
  filters = [],
  variant = 'full',
}: ClickHousePreviewTableProps) {
  const t = useTranslations('pipelines');
  const openRun = useRunsStore((s) => s.openRun);
  const { schema, isLoading: schemaLoading } = useOutputSchema(pipelineId, projectId);

  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [queried, setQueried] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const offsetRef = useRef(0);

  const effectiveTimeRange = timeRange ?? {
    from: new Date(Date.now() - 24 * 60 * 60 * 1000),
    to: new Date(),
  };

  const fetchData = useCallback(
    async (offset: number, append: boolean) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setErrorCode(null);
      }

      try {
        const body = {
          pipelineId,
          ...(sessionId ? { sessionId } : {}),
          ...(runId ? { runId } : {}),
          timeRange: {
            from: effectiveTimeRange.from.toISOString(),
            to: effectiveTimeRange.to.toISOString(),
          },
          filters,
          limit: PAGE_SIZE,
          offset,
        };

        const response = await apiFetch(
          `/api/runtime/projects/${projectId}/pipeline-observability/data/query`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );

        const text = await response.text();
        let parsed: PipelineDataQueryResponse;
        try {
          parsed = JSON.parse(text);
        } catch {
          toast.error(t('data.error_generic'));
          return;
        }

        if (!response.ok) {
          const respBody = parsed as unknown as {
            success: boolean;
            error?: { code: string; message: string };
          };
          const code = respBody?.error?.code ?? 'UNKNOWN';
          setErrorCode(code);
          toast.error(t(getErrorMessageKey(code)));
          return;
        }

        const { rows: newRows, columns: newColumns } = expandCustomDimensionRows(
          parsed.data?.rows ?? [],
          parsed.data?.columns ?? [],
        );

        if (append) {
          setRows((prev) => [...prev, ...newRows]);
          setColumns((prev) => Array.from(new Set([...prev, ...newColumns])));
        } else {
          setRows(newRows);
          setColumns(newColumns);
        }

        setHasMore(parsed.pagination?.hasMore ?? false);
        setTotal(parsed.pagination?.total ?? 0);
        offsetRef.current = offset + newRows.length;
        setQueried(true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(message);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [pipelineId, projectId, runId, sessionId, effectiveTimeRange, filters, t],
  );

  const handleQuery = useCallback(() => {
    offsetRef.current = 0;
    fetchData(0, false);
  }, [fetchData]);

  const handleLoadMore = useCallback(() => {
    fetchData(offsetRef.current, true);
  }, [fetchData]);

  // Auto-query on mount — parent controls when to show this component
  const autoQueried = useRef(false);
  if (!autoQueried.current && !queried && !loading) {
    autoQueried.current = true;
    // Schedule after render to avoid setState-during-render
    setTimeout(() => handleQuery(), 0);
  }

  if (schemaLoading) {
    return (
      <div className="space-y-3 p-2">
        <Skeleton className="h-8 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }

  if (errorCode === 'NO_OUTPUT_TABLE') {
    return (
      <EmptyState
        icon={<Database className="w-6 h-6" />}
        title={t('data.empty_no_output_table_title')}
        description={t('data.empty_no_output_table_description')}
      />
    );
  }

  if (errorCode === 'NOT_FOUND') {
    return (
      <EmptyState
        icon={<AlertCircle className="w-6 h-6" />}
        title={t('data.empty_not_found_title')}
        description={t('data.empty_not_found_description')}
      />
    );
  }

  if (errorCode) {
    return (
      <EmptyState
        icon={<AlertCircle className="w-6 h-6" />}
        title={t('data.empty_error_title')}
        description={t(getErrorMessageKey(errorCode))}
        action={
          <Button variant="secondary" size="sm" onClick={handleQuery}>
            {t('data.retry')}
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      {/* Row count — shown after query completes */}
      {queried && !loading && (
        <span className="text-xs text-muted">{t('data.row_count', { count: total })}</span>
      )}

      {/* Loading state */}
      {loading && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full rounded-lg" />
          <Skeleton className="h-6 w-full rounded-lg" />
          <Skeleton className="h-6 w-full rounded-lg" />
          <Skeleton className="h-6 w-full rounded-lg" />
        </div>
      )}

      {/* No rows empty state */}
      {queried && !loading && rows.length === 0 && !errorCode && (
        <EmptyState
          icon={<Database className="w-6 h-6" />}
          title={t('data.empty_no_rows_title')}
          description={t('data.empty_no_rows_description')}
        />
      )}

      {/* Data table */}
      {!loading && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-default">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-default bg-background-muted">
                {columns.map((col) => (
                  <th
                    key={col}
                    className="px-3 py-2 text-left text-xs font-medium text-muted whitespace-nowrap"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  className="border-b border-default last:border-b-0 hover:bg-background-muted transition-default"
                >
                  {columns.map((col) => {
                    const cellValue = row[col];
                    const isRunIdColumn = col === 'run_id' || col === 'runId';
                    const cellStr =
                      cellValue === null || cellValue === undefined ? '' : String(cellValue);

                    // In full variant, run_id cells are clickable to open the run drawer
                    if (isRunIdColumn && variant === 'full' && cellStr) {
                      return (
                        <td key={col} className="px-3 py-2 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => openRun(cellStr)}
                            className="text-accent hover:underline cursor-pointer text-left"
                          >
                            {cellStr}
                          </button>
                        </td>
                      );
                    }

                    return (
                      <td
                        key={col}
                        className="px-3 py-2 whitespace-nowrap text-foreground max-w-xs truncate"
                        title={cellStr}
                      >
                        {cellStr}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Load more */}
      {hasMore && !loading && (
        <div className="flex justify-center pt-2">
          <Button variant="secondary" size="sm" onClick={handleLoadMore} loading={loadingMore}>
            {t('data.load_more')}
          </Button>
        </div>
      )}
    </div>
  );
}
