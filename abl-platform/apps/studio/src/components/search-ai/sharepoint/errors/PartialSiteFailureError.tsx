'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle } from 'lucide-react';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import type { ErrorComponentProps } from './error-types';

export function PartialSiteFailureError({ error, onRetry }: ErrorComponentProps) {
  const t = useTranslations('search_ai.sharepoint.errors');
  const sites = error.siteStatuses ?? [];
  const failedCount = sites.filter((s) => s.status === 'failed').length;
  const totalCount = sites.length;

  return (
    <div className="p-4 rounded-lg border border-warning/20 bg-warning-subtle/30 space-y-3">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-warning" />
        <h4 className="text-sm font-semibold text-foreground">{t('partial_failure_title')}</h4>
      </div>

      <p className="text-sm text-foreground">
        {t('partial_failure_description', { failedCount, totalCount })}
      </p>

      {/* Per-site list */}
      <div className="space-y-1.5">
        {sites.map((site) => (
          <div
            key={site.siteName}
            className="flex items-center justify-between text-xs py-1.5 border-b border-default last:border-0"
          >
            <div className="flex items-center gap-2">
              {site.status === 'ok' ? (
                <CheckCircle className="w-3.5 h-3.5 text-success" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-error" />
              )}
              <span className="text-foreground">{site.siteName}</span>
              <Badge variant={site.status === 'ok' ? 'success' : 'error'}>
                {site.status === 'ok' ? 'OK' : 'FAIL'}
              </Badge>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-muted">
                {site.docsSynced}/{site.docsTotal}
              </span>
              {site.status === 'failed' && site.errorReason && (
                <span className="text-error truncate max-w-[200px]">{site.errorReason}</span>
              )}
              {site.status === 'failed' && (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="xs" onClick={() => onRetry('request_access')}>
                    {t('btn_request_access')}
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => onRetry('remove_from_scope')}>
                    {t('btn_remove_from_scope')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Global actions */}
      <div className="flex items-center gap-2 pt-1">
        <Button variant="secondary" size="xs" onClick={() => onRetry('retry_failed_sites')}>
          {t('btn_retry_failed')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onRetry('accept_partial')}>
          {t('btn_accept_partial')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onRetry('rerun_full_sync')}>
          {t('btn_rerun_full')}
        </Button>
      </div>
    </div>
  );
}
