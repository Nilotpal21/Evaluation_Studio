'use client';

/**
 * ConsentConnectorRow — renders a single connector in the batch consent panel.
 *
 * 5 states: pending, authorizing, connected, failed, skipped
 */

import { useTranslations } from 'next-intl';
import { Loader2, Check, X, AlertCircle, SkipForward } from 'lucide-react';
import type { ConnectorConsentStatus } from '../../store/batch-consent-store';

export interface ConsentConnectorRowProps {
  connector: string;
  authProfileRef: string;
  status: ConnectorConsentStatus;
  error?: string;
  onAuthorize: () => void;
  onRetry: () => void;
  onSkip: () => void;
}

export function ConsentConnectorRow({
  connector,
  status,
  error,
  onAuthorize,
  onRetry,
  onSkip,
}: ConsentConnectorRowProps) {
  const t = useTranslations('auth_profiles.batch_consent');

  return (
    <div
      className="flex items-center justify-between rounded-lg border border-border/50 bg-card/50 px-4 py-3"
      data-testid={`consent-row-${connector}`}
      data-status={status}
    >
      <div className="flex items-center gap-3">
        <StatusIcon status={status} />
        <div>
          <p className="text-sm font-medium text-foreground">{connector}</p>
          {status === 'failed' && error && <p className="text-xs text-destructive">{error}</p>}
          {status === 'authorizing' && (
            <p className="text-xs text-muted-foreground">{t('authorizing')}</p>
          )}
          {status === 'connected' && <p className="text-xs text-success">{t('connected')}</p>}
          {status === 'skipped' && <p className="text-xs text-muted-foreground">{t('skipped')}</p>}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {status === 'pending' && (
          <>
            <button
              type="button"
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-default hover:bg-primary/90"
              onClick={onAuthorize}
            >
              {t('authorize')}
            </button>
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-default hover:bg-accent"
              onClick={onSkip}
            >
              {t('skip')}
            </button>
          </>
        )}
        {(status === 'failed' || status === 'skipped') && (
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-default hover:bg-primary/90"
            onClick={onRetry}
          >
            {status === 'skipped' ? t('authorize') : t('retry')}
          </button>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: ConnectorConsentStatus }) {
  switch (status) {
    case 'pending':
      return (
        <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-muted-foreground/30">
          <div className="h-2 w-2 rounded-full bg-muted-foreground/30" />
        </div>
      );
    case 'authorizing':
      return <Loader2 className="h-5 w-5 animate-spin text-primary" />;
    case 'connected':
      return (
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-success">
          <Check className="h-3.5 w-3.5 text-success-foreground" />
        </div>
      );
    case 'failed':
      return (
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-destructive">
          <X className="h-3.5 w-3.5 text-white" />
        </div>
      );
    case 'skipped':
      return <SkipForward className="h-5 w-5 text-muted-foreground" />;
  }
}
