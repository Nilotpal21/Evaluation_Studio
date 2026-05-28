'use client';

import { useTranslations } from 'next-intl';
import { Clock } from 'lucide-react';
import { Button } from '../../../ui/Button';
import type { ErrorComponentProps } from './error-types';

export function DiscoveryTimeoutError({ error, onRetry }: ErrorComponentProps) {
  const t = useTranslations('search_ai.sharepoint.errors');
  return (
    <div className="p-4 rounded-lg border border-warning/20 bg-warning-subtle/30 space-y-3">
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-warning" />
        <h4 className="text-sm font-semibold text-foreground">{t('discovery_timeout_title')}</h4>
      </div>

      <p className="text-sm text-foreground">
        {t('discovery_timeout_description', {
          sitesDiscovered: error.sitesDiscovered ?? 0,
        })}
      </p>

      {(error.sitesProfiled !== undefined || error.drivesFound !== undefined) && (
        <div className="flex items-center gap-4 text-xs text-muted">
          {error.sitesProfiled !== undefined && <span>{error.sitesProfiled} sites profiled</span>}
          {error.drivesFound !== undefined && <span>{error.drivesFound} drives found</span>}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button variant="secondary" size="xs" onClick={() => onRetry('keep_partial')}>
          {t('btn_keep_partial')}
        </Button>
        <Button variant="secondary" size="xs" onClick={() => onRetry('retry_discovery')}>
          {t('btn_retry_discovery')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onRetry('reduce_scope')}>
          {t('btn_reduce_scope')}
        </Button>
      </div>
    </div>
  );
}
