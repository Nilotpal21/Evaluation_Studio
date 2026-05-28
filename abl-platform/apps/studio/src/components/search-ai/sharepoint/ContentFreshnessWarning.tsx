'use client';

/**
 * ContentFreshnessWarning
 *
 * Conditionally rendered when last successful sync is >3 days ago.
 * Shows warning banner with time since last sync, failed attempt count, and actions.
 */

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../../ui/Button';

interface ContentFreshnessWarningProps {
  lastSuccessfulSync: string | null;
  recentFailedAttempts: number;
  scheduledInterval: string | null;
  onSyncNow: () => void;
  onViewHistory: () => void;
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

function getDaysAgo(isoDate: string): number {
  const diff = Date.now() - new Date(isoDate).getTime();
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

export function ContentFreshnessWarning({
  lastSuccessfulSync,
  recentFailedAttempts,
  scheduledInterval,
  onSyncNow,
  onViewHistory,
}: ContentFreshnessWarningProps) {
  const t = useTranslations('search_ai.sharepoint.overview');

  if (!lastSuccessfulSync) return null;

  const elapsed = Date.now() - new Date(lastSuccessfulSync).getTime();
  if (elapsed < THREE_DAYS_MS) return null;

  const daysAgo = getDaysAgo(lastSuccessfulSync);

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-warning-subtle border border-warning/20">
      <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
      <div className="flex-1 space-y-1.5">
        <p className="text-sm text-foreground">{t('freshness_warning', { days: daysAgo })}</p>
        {scheduledInterval && recentFailedAttempts > 0 && (
          <p className="text-xs text-muted">
            {t('freshness_scheduled', {
              interval: scheduledInterval,
              count: recentFailedAttempts,
            })}
          </p>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Button variant="secondary" size="xs" onClick={onSyncNow}>
            {t('sync_now')}
          </Button>
          <Button variant="ghost" size="xs" onClick={onViewHistory}>
            {t('view_sync_history')}
          </Button>
        </div>
      </div>
    </div>
  );
}
