'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../../../ui/Button';
import type { ErrorComponentProps } from './error-types';

export function SyncFailureError({ error, onRetry }: ErrorComponentProps) {
  const t = useTranslations('search_ai.sharepoint.errors');
  return (
    <div className="p-4 rounded-lg border border-error/20 bg-error-subtle/30 space-y-3">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-error" />
        <h4 className="text-sm font-semibold text-foreground">{t('sync_failed_title')}</h4>
      </div>

      <p className="text-sm text-foreground">
        {t('sync_failed_docs_processed', {
          processed: error.docsProcessed ?? 0,
          total: error.docsTotal ?? 0,
        })}
      </p>

      {error.errorCode && (
        <p className="text-xs text-muted font-mono">
          {error.errorCode}: {error.errorMessage}
        </p>
      )}

      {error.checkpointSaved && error.resumeFromDoc !== undefined && (
        <p className="text-xs text-success">
          {t('sync_failed_checkpoint', { processed: error.resumeFromDoc })}
        </p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button variant="secondary" size="xs" onClick={() => onRetry('resume_sync')}>
          {t('btn_resume_sync')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onRetry('reduce_scope')}>
          {t('btn_reduce_scope')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onRetry('keep_partial')}>
          {t('btn_keep_partial')}
        </Button>
      </div>
    </div>
  );
}
