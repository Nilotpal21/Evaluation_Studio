/**
 * Reindex Confirm Dialog
 *
 * Shows after publishing a pipeline when changes require reindexing.
 * Displays change summary and cost/duration estimates.
 * User can confirm (trigger reindex) or dismiss (skip for now).
 */

import { useEffect, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, X, RefreshCw, Loader2 } from 'lucide-react';
import { usePipelineStore } from '../../../store/pipeline-store';

export function ReindexConfirmDialog() {
  const { reindexPending, reindexLoading, reindexError, confirmReindex, dismissReindex } =
    usePipelineStore();
  const t = useTranslations('search_ai.pipeline');
  const dialogRef = useRef<HTMLDivElement>(null);

  const handleDismiss = useCallback(() => {
    if (!reindexLoading) dismissReindex();
  }, [reindexLoading, dismissReindex]);

  // ESC key handler
  useEffect(() => {
    if (!reindexPending) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleDismiss();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [reindexPending, handleDismiss]);

  // Focus trap: focus dialog on mount
  useEffect(() => {
    if (reindexPending && dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [reindexPending]);

  if (!reindexPending) return null;

  const { summary, changeSet } = reindexPending;

  const changeDescriptions: string[] = [];
  if (changeSet.routingChanged) changeDescriptions.push(t('reindex_change_routing'));
  if (changeSet.preChunkChanges > 0)
    changeDescriptions.push(t('reindex_change_pre_chunk', { count: changeSet.preChunkChanges }));
  if (changeSet.postChunkChanges > 0)
    changeDescriptions.push(t('reindex_change_post_chunk', { count: changeSet.postChunkChanges }));
  if (changeSet.embeddingChanged) changeDescriptions.push(t('reindex_change_embedding'));

  const totalItems = summary.totalDocuments + summary.totalChunks;

  return (
    // Backdrop: click to dismiss (keyboard handled via document-level ESC listener)
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onClick={handleDismiss}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reindex-dialog-title"
        tabIndex={-1}
        className="w-full max-w-md rounded-lg border border-default bg-elevated shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-default px-4 py-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            <h3 id="reindex-dialog-title" className="text-sm font-semibold text-foreground">
              {t('reindex_title')}
            </h3>
          </div>
          <button
            onClick={dismissReindex}
            disabled={reindexLoading}
            className="rounded p-1 text-muted hover:bg-background-muted hover:text-foreground disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="space-y-4 px-4 py-4">
          {totalItems === 0 ? (
            <div className="rounded-md border border-accent/20 bg-accent/5 px-3 py-3">
              <p className="text-sm font-medium text-foreground">
                {t('reindex_no_documents_title')}
              </p>
              <p className="mt-1 text-xs text-muted">{t('reindex_no_documents_description')}</p>
            </div>
          ) : (
            <p className="text-sm text-muted">
              {t('reindex_description', { count: totalItems.toLocaleString() })}
            </p>
          )}

          {/* Changes list */}
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-subtle">
              {t('reindex_changes_heading')}
            </p>
            <ul className="space-y-1">
              {changeDescriptions.map((desc, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-muted">
                  <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warning" />
                  {desc}
                </li>
              ))}
            </ul>
          </div>

          {/* Estimates */}
          <div className="grid grid-cols-3 gap-3 rounded-md border border-muted bg-background-muted/50 p-3">
            <div>
              <p className="text-xs text-subtle">{t('reindex_documents')}</p>
              <p className="text-sm font-medium text-foreground">
                {summary.totalDocuments.toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-xs text-subtle">{t('reindex_chunks')}</p>
              <p className="text-sm font-medium text-foreground">
                {summary.totalChunks.toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-xs text-subtle">{t('reindex_est_duration')}</p>
              <p className="text-sm font-medium text-foreground">
                ~{summary.estimatedDurationMin} min
              </p>
            </div>
          </div>

          {summary.estimatedCostUsd > 0 && (
            <p className="text-xs text-subtle">
              {t('reindex_est_cost', { cost: summary.estimatedCostUsd.toFixed(2) })}
            </p>
          )}

          {reindexError && (
            <p className="rounded border border-error bg-error-subtle px-3 py-2 text-sm text-error">
              {reindexError}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-default px-4 py-3">
          <button
            onClick={dismissReindex}
            disabled={reindexLoading}
            className="rounded-md px-3 py-1.5 text-sm text-muted hover:bg-background-muted hover:text-foreground disabled:opacity-50"
          >
            {t('reindex_skip')}
          </button>
          <button
            onClick={confirmReindex}
            disabled={reindexLoading}
            className="flex items-center gap-1.5 rounded-md bg-warning px-3 py-1.5 text-sm font-medium text-warning-foreground hover:bg-warning/90 disabled:opacity-50"
          >
            {reindexLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {reindexLoading ? t('reindex_starting') : t('reindex_start')}
          </button>
        </div>
      </div>
    </div>
  );
}
