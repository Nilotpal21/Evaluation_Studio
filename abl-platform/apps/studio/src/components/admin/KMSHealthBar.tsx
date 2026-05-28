'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { useKMSHealth } from '../../hooks/useKMS';
import { humanizeProvider } from './kms-utils';

export function KMSHealthBar() {
  const t = useTranslations('admin');
  const { health, isLoading, mutate } = useKMSHealth();

  if (isLoading && !health) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border-muted bg-background-muted px-4 py-2.5 mb-5">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground-subtle" />
        <span className="text-sm text-foreground-subtle">Loading health status…</span>
      </div>
    );
  }

  if (!health) {
    return null;
  }

  const isHealthy = health.healthy;
  const barBg = isHealthy ? 'bg-success-subtle' : 'bg-error-subtle';
  const barBorder = isHealthy ? 'border-success/20' : 'border-error/20';
  const dotColor = isHealthy
    ? 'bg-success shadow-[0_0_8px_hsl(var(--success)/0.5)]'
    : 'bg-error shadow-[0_0_8px_hsl(var(--error)/0.5)]';

  return (
    <div className="space-y-2 mb-5">
      <div
        className={`flex items-center justify-between flex-wrap gap-3 rounded-lg border ${barBorder} ${barBg} px-4 py-2.5`}
      >
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className={`h-2 w-2 rounded-full ${dotColor}`} />
          <span className="text-sm font-semibold text-foreground">
            {isHealthy ? t('kms.health_bar_healthy') : t('kms.health_bar_unhealthy')}
          </span>
          <Badge variant={isHealthy ? 'default' : 'error'}>
            {humanizeProvider(health.provider)}
          </Badge>
          <Badge variant="default">{health.failurePolicy ?? '--'}</Badge>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <span className="text-xs text-foreground-subtle">
            {t('kms.health_bar_deks')}{' '}
            <strong className="text-foreground-muted">{health.deks?.active ?? 0}</strong>{' '}
            {t('kms.health_bar_active')} ·{' '}
            <strong className="text-foreground-muted">{health.deks?.decryptOnly ?? 0}</strong>{' '}
            {t('kms.health_bar_decrypt_only')}
          </span>
          {health.providerHealth?.latencyMs != null && (
            <span className="text-xs text-foreground-subtle">
              {t('kms.health_bar_latency')}{' '}
              <strong className="text-foreground-muted">{health.providerHealth.latencyMs}ms</strong>
            </span>
          )}
          {health.providerHealth?.cryptoVerified !== undefined && (
            <Badge variant={health.providerHealth.cryptoVerified ? 'success' : 'error'}>
              {health.providerHealth.cryptoVerified
                ? t('kms.health_bar_crypto_ok')
                : t('kms.health_bar_crypto_fail')}
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => mutate()}
            icon={<RefreshCw className="h-3 w-3" />}
            className="h-6 px-2"
          />
        </div>
      </div>

      {health.migration?.migrationActive && !health.migration.dekMigrationComplete && (
        <div className="flex items-center gap-3 rounded-lg border border-warning/20 bg-warning-subtle px-4 py-2.5">
          <AlertTriangle className="h-3.5 w-3.5 text-warning flex-shrink-0" />
          <span className="text-xs text-foreground-muted">
            {t('kms.health_bar_migration_active')}
          </span>
          <Badge variant="warning">{t('kms.health_bar_migration_incomplete')}</Badge>
          {health.migration.driftedDekCount > 0 && (
            <span className="text-xs text-warning">
              {t('kms.health_bar_migration_drifted', {
                count: health.migration.driftedDekCount,
              })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
