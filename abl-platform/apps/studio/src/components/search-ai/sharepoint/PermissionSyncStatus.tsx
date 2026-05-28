'use client';

/**
 * PermissionSyncStatus
 *
 * Permission sync section showing coverage ratio, staleness warning,
 * last/next crawl times, and Crawl Now / Set Schedule actions.
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Shield } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { Tooltip } from '../../ui/Tooltip';
import type { ConnectorDetail } from '../../../hooks/useConnector';
import type { OverviewData } from '../../../hooks/useConnectorOverview';
import { apiFetch, handleResponse } from '../../../lib/api-client';

interface PermissionSyncStatusProps {
  connectorId: string;
  indexId: string;
  permissionConfig: ConnectorDetail['permissionConfig'];
  permissionSync: OverviewData['permissionSync'] | null;
  isLoading: boolean;
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function PermissionSyncStatus({
  connectorId,
  permissionConfig,
  permissionSync,
  isLoading,
}: PermissionSyncStatusProps) {
  const t = useTranslations('search_ai.sharepoint.permission_sync');
  const [crawlLoading, setCrawlLoading] = useState(false);

  const handleCrawlNow = useCallback(async () => {
    setCrawlLoading(true);
    try {
      const response = await apiFetch(
        `/api/search-ai/connectors/${connectorId}/permissions/crawl`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
      );
      await handleResponse(response);
    } finally {
      setCrawlLoading(false);
    }
  }, [connectorId]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
          <Shield className="w-4 h-4 text-muted" />
          {t('title')}
        </h3>
        <p className="text-xs text-muted">{t('checking')}</p>
      </div>
    );
  }

  const isDisabled = permissionConfig.mode === 'disabled';

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
        <Shield className="w-4 h-4 text-muted" />
        {t('title')}
      </h3>

      {/* Mode */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted">{t('mode_label')}</span>
        <Badge variant={isDisabled ? 'default' : 'success'}>
          {isDisabled ? t('mode_disabled') : t('mode_enabled')}
        </Badge>
      </div>

      {isDisabled ? null : (
        <>
          {/* Last crawled */}
          {permissionConfig.lastCrawlAt && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">{t('last_crawled')}</span>
              <span className="text-foreground">
                {formatRelativeTime(permissionConfig.lastCrawlAt)}
              </span>
            </div>
          )}

          {/* Coverage */}
          {permissionSync && (
            <div className="text-sm">
              <p className="text-foreground">
                {t('coverage', {
                  mapped: permissionSync.coverageMapped,
                  total: permissionSync.coverageTotal,
                })}
              </p>
            </div>
          )}

          {/* Staleness warning */}
          {permissionSync?.stalenessWarning && (
            <div className="flex items-center gap-2 text-xs text-warning">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>{t('staleness_warning')}</span>
            </div>
          )}

          {/* Next crawl */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">{t('next_crawl')}</span>
            <span className="text-foreground">
              {permissionSync?.nextCrawl
                ? new Date(permissionSync.nextCrawl).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : t('not_scheduled')}
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="secondary"
              size="xs"
              onClick={handleCrawlNow}
              loading={crawlLoading}
              disabled={permissionConfig.crawlInProgress}
            >
              {permissionConfig.crawlInProgress ? t('crawling') : t('btn_crawl_now')}
            </Button>
            <Tooltip content={t('schedule_not_available')}>
              <span>
                <Button variant="ghost" size="xs" disabled>
                  {t('btn_set_schedule')}
                </Button>
              </span>
            </Tooltip>
          </div>

          {/* Permission note */}
          <p className="text-xs text-muted">{t('permission_note')}</p>
        </>
      )}
    </div>
  );
}
