'use client';

/**
 * BatchConsentPanel — header with progress bar, connector list, and footer actions.
 */

import { useTranslations } from 'next-intl';
import { Shield } from 'lucide-react';
import { useBatchConsentStore } from '../../store/batch-consent-store';
import { ConsentConnectorRow } from './ConsentConnectorRow';

export interface BatchConsentPanelProps {
  onAuthorize: (requirementKey: string) => void;
  onConnectAll: () => void;
  onSkip: (requirementKey: string) => void;
  onContinue: () => void;
}

export function BatchConsentPanel({
  onAuthorize,
  onConnectAll,
  onSkip,
  onContinue,
}: BatchConsentPanelProps) {
  const t = useTranslations('auth_profiles.batch_consent');
  const connectors = useBatchConsentStore((s) => s.connectors);
  const getConnectedCount = useBatchConsentStore((s) => s.getConnectedCount);
  const getTotalCount = useBatchConsentStore((s) => s.getTotalCount);

  const connectedCount = getConnectedCount();
  const totalCount = getTotalCount();
  const allConnected = connectedCount === totalCount;
  const hasAnyPending = connectors.some(
    (c) => c.status === 'pending' || c.status === 'failed' || c.status === 'skipped',
  );

  const progressPercent = totalCount > 0 ? Math.round((connectedCount / totalCount) * 100) : 0;

  return (
    <div className="flex h-full flex-col bg-background" data-testid="batch-consent-panel">
      {/* Header */}
      <div className="border-b border-border/50 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
            <Shield className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
            <p className="text-xs text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {t('progress', {
                connected: connectedCount,
                total: totalCount,
              })}
            </span>
            <span className="text-muted-foreground">{progressPercent}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
              data-testid="consent-progress-bar"
            />
          </div>
        </div>
      </div>

      {/* Connector list */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="space-y-2">
          {connectors.map((c) => (
            <ConsentConnectorRow
              key={c.requirementKey}
              connector={c.connector}
              authProfileRef={c.authProfileRef}
              status={c.status}
              error={c.error}
              onAuthorize={() => onAuthorize(c.requirementKey)}
              onRetry={() => onAuthorize(c.requirementKey)}
              onSkip={() => onSkip(c.requirementKey)}
            />
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border/50 px-6 py-3">
        {hasAnyPending && (
          <button
            type="button"
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-default hover:bg-accent"
            onClick={onConnectAll}
            data-testid="connect-all-btn"
          >
            {t('connect_all')}
          </button>
        )}
        {!hasAnyPending && <div />}
        <button
          type="button"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-default hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={!allConnected}
          onClick={onContinue}
          data-testid="consent-continue-btn"
        >
          {t('continue')}
        </button>
      </div>
    </div>
  );
}
