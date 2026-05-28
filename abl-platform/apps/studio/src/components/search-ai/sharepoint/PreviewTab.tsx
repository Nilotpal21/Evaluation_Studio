'use client';

/**
 * PreviewTab
 *
 * Dry-run summary of what WOULD be synced before approval.
 * Shows: 4 summary stats, sample documents, skipped documents,
 * content type breakdown, and navigation buttons.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { DataTable, type Column } from '../../ui/DataTable';
import { runPreview, type PreviewData } from '../../../api/search-ai';
import { ContentTypeBreakdown } from './ContentTypeBreakdown';

interface PreviewTabProps {
  indexId: string;
  connectorId: string;
  onNavigateToFilters: () => void;
  onNavigateToApprove: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

const MAX_SAMPLE_DOCS = 25;
const MAX_SKIPPED_DOCS = 10;

export function PreviewTab({
  connectorId,
  onNavigateToFilters,
  onNavigateToApprove,
}: PreviewTabProps) {
  const t = useTranslations('search_ai.sharepoint.preview');

  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadPreview() {
      setIsLoading(true);
      setError(null);
      try {
        const data = await runPreview(connectorId);
        if (!cancelled) setPreview(data);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    loadPreview();
    return () => {
      cancelled = true;
    };
  }, [connectorId]);

  // Sample docs columns
  const sampleColumns: Column<{ name: string; type: string; sizeBytes: number }>[] = useMemo(
    () => [
      {
        key: 'name',
        label: t('col_name'),
        render: (row) => <span className="text-foreground truncate">{row.name}</span>,
      },
      {
        key: 'type',
        label: t('col_type'),
        render: (row) => <Badge variant="info">{row.type}</Badge>,
      },
      {
        key: 'size',
        label: t('col_size'),
        render: (row) => <span className="text-muted">{formatBytes(row.sizeBytes)}</span>,
      },
    ],
    [t],
  );

  const skippedColumns: Column<{ name: string; reason: string }>[] = useMemo(
    () => [
      {
        key: 'name',
        label: t('col_name'),
        render: (row) => <span className="text-foreground truncate">{row.name}</span>,
      },
      {
        key: 'reason',
        label: t('col_reason'),
        render: (row) => <span className="text-error">{row.reason}</span>,
      },
    ],
    [t],
  );

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted">
        <Loader2 className="w-6 h-6 animate-spin" />
        <p className="text-sm">{t('loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted">
        <AlertTriangle className="w-6 h-6 text-error" />
        <p className="text-sm">{t('error')}</p>
        <p className="text-xs">{error}</p>
      </div>
    );
  }

  if (!preview) return null;

  const timeRange = preview.timeRange;
  const timeRangeStr = timeRange
    ? [timeRange.earliest, timeRange.latest].filter(Boolean).join(' — ')
    : '—';

  return (
    <div className="p-6 space-y-6">
      {/* Title */}
      <h3 className="text-base font-semibold text-foreground">{t('title')}</h3>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border border-default bg-background-subtle p-3 text-center">
          <p className="text-xl font-bold text-foreground">{preview.matchCount.toLocaleString()}</p>
          <p className="text-xs text-muted">{t('doc_count_label')}</p>
        </div>
        <div className="rounded-lg border border-default bg-background-subtle p-3 text-center">
          <p className="text-xl font-bold text-foreground">
            {preview.excludedCount.toLocaleString()}
          </p>
          <p className="text-xs text-muted">{t('skip_count_label')}</p>
        </div>
        <div className="rounded-lg border border-default bg-background-subtle p-3 text-center">
          <p className="text-xl font-bold text-foreground">
            {formatBytes(preview.estimatedSizeBytes)}
          </p>
          <p className="text-xs text-muted">{t('estimated_size_label')}</p>
        </div>
        <div className="rounded-lg border border-default bg-background-subtle p-3 text-center">
          <p className="text-sm font-medium text-foreground">{timeRangeStr}</p>
          <p className="text-xs text-muted">{t('time_range_label')}</p>
        </div>
      </div>

      {/* Filter changes */}
      {preview.hasPreviousPreview && preview.filterChanges && preview.filterChanges.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
            {t('filter_changes')}
          </h4>
          <div className="space-y-1">
            {preview.filterChanges.map((change, i) => (
              <div key={i} className="text-xs text-muted flex items-center gap-2">
                <span className="text-foreground">{change.description}</span>
                <Badge variant="info">{change.impact}</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sample Documents */}
      <div>
        <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
          {t('sample_docs_title')}
        </h4>
        {preview.sampleDocuments.length > 0 ? (
          <DataTable
            columns={sampleColumns}
            data={preview.sampleDocuments.slice(0, MAX_SAMPLE_DOCS)}
            keyExtractor={(row) => row.name}
          />
        ) : (
          <p className="text-xs text-muted">{t('sample_docs_empty')}</p>
        )}
      </div>

      {/* Skipped Documents */}
      <div>
        <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
          {t('skipped_docs_title')}
        </h4>
        {preview.skippedDocuments.length > 0 ? (
          <DataTable
            columns={skippedColumns}
            data={preview.skippedDocuments.slice(0, MAX_SKIPPED_DOCS)}
            keyExtractor={(row) => row.name}
          />
        ) : (
          <p className="text-xs text-muted">{t('skipped_docs_empty')}</p>
        )}
      </div>

      {/* Content Type Breakdown */}
      {preview.contentTypeBreakdown && preview.contentTypeBreakdown.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
            {t('content_breakdown_title')}
          </h4>
          <ContentTypeBreakdown data={preview.contentTypeBreakdown} />
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between pt-4 border-t border-default">
        <Button variant="secondary" onClick={onNavigateToFilters}>
          {t('btn_adjust_filters')}
        </Button>
        <Button onClick={onNavigateToApprove}>{t('btn_approve_sync')}</Button>
      </div>
    </div>
  );
}
