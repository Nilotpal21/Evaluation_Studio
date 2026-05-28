'use client';

/**
 * ScopePreviewPanel
 *
 * Right panel of the Scope+Filters split-pane. Shows preview data:
 * summary counts, diff, sample documents, excluded documents, exclusion summary.
 */

import { useTranslations } from 'next-intl';
import { Loader2, Undo2, RotateCcw } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import type { FilterPreviewData } from '../../../hooks/useFilterPreview';

interface ScopePreviewPanelProps {
  preview: FilterPreviewData | null;
  isLoading: boolean;
  onUndo: () => void;
  onReset: () => void;
  canUndo: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function ScopePreviewPanel({
  preview,
  isLoading,
  onUndo,
  onReset,
  canUndo,
}: ScopePreviewPanelProps) {
  const t = useTranslations('search_ai.sharepoint.scopeFilters');

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted gap-3 p-6">
        <Loader2 className="w-6 h-6 animate-spin" />
        <p className="text-sm">{t('preview_loading')}</p>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="flex items-center justify-center h-full text-muted p-6">
        <p className="text-sm">{t('preview_no_data')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 overflow-y-auto">
      {/* Header with undo/reset */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">{t('preview_title')}</h4>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={onUndo}
            disabled={!canUndo}
            aria-label={t('preview_undo')}
          >
            <Undo2 className="w-3.5 h-3.5" />
            {t('preview_undo')}
          </Button>
          <Button variant="ghost" size="xs" onClick={onReset} aria-label={t('preview_reset')}>
            <RotateCcw className="w-3.5 h-3.5" />
            {t('preview_reset')}
          </Button>
        </div>
      </div>

      {/* Summary counts */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg bg-background-subtle border border-default p-3 text-center">
          <p className="text-lg font-bold text-foreground">{preview.matchCount}</p>
          <p className="text-xs text-muted">
            {t('preview_match_count', { count: preview.matchCount })}
          </p>
        </div>
        <div className="rounded-lg bg-background-subtle border border-default p-3 text-center">
          <p className="text-lg font-bold text-foreground">{preview.excludedCount}</p>
          <p className="text-xs text-muted">
            {t('preview_excluded_count', { count: preview.excludedCount })}
          </p>
        </div>
        <div className="rounded-lg bg-background-subtle border border-default p-3 text-center">
          <p className="text-lg font-bold text-foreground">~{preview.estimatedSyncMinutes}m</p>
          <p className="text-xs text-muted">
            {t('preview_estimated_time', { minutes: preview.estimatedSyncMinutes })}
          </p>
        </div>
      </div>

      {/* Diff */}
      {preview.diff && (
        <div className="flex gap-2">
          {preview.diff.newlyIncluded > 0 && (
            <Badge variant="success">
              {t('preview_newly_included', { count: preview.diff.newlyIncluded })}
            </Badge>
          )}
          {preview.diff.newlyExcluded > 0 && (
            <Badge variant="warning">
              {t('preview_newly_excluded', { count: preview.diff.newlyExcluded })}
            </Badge>
          )}
        </div>
      )}

      {/* Sample documents */}
      {preview.sampleDocuments && preview.sampleDocuments.length > 0 && (
        <div>
          <h5 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
            {t('preview_sample_title')}
          </h5>
          <div className="space-y-1">
            {preview.sampleDocuments.map((doc, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-xs px-2 py-1.5 rounded bg-background-subtle"
              >
                <span className="text-foreground truncate">{doc.name}</span>
                <span className="text-muted shrink-0 ml-2">
                  {doc.type} &middot; {formatBytes(doc.sizeBytes)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Excluded documents */}
      {preview.excludedDocuments && preview.excludedDocuments.length > 0 && (
        <div>
          <h5 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
            {t('preview_excluded_title')}
          </h5>
          <div className="space-y-1">
            {preview.excludedDocuments.map((doc, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-xs px-2 py-1.5 rounded bg-background-subtle"
              >
                <span className="text-foreground truncate">{doc.name}</span>
                <span className="text-error shrink-0 ml-2">{doc.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Exclusion summary */}
      {preview.exclusionSummary && preview.exclusionSummary.length > 0 && (
        <div className="space-y-1">
          {preview.exclusionSummary.map((item, i) => (
            <div key={i} className="flex items-center justify-between text-xs text-muted px-2 py-1">
              <span>{item.category}</span>
              <span>{item.count}</span>
            </div>
          ))}
        </div>
      )}

      {/* OData filter (collapsible) */}
      {preview.generatedODataFilter && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted hover:text-foreground">
            OData Filter
          </summary>
          <pre className="mt-1 p-2 bg-background-muted rounded text-xs text-muted font-mono overflow-x-auto">
            {preview.generatedODataFilter}
          </pre>
        </details>
      )}
    </div>
  );
}
