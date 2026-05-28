'use client';

import { useTranslations } from 'next-intl';
import { KeyRound } from 'lucide-react';
import { Button } from '../../../ui/Button';
import type { ErrorComponentProps } from './error-types';

export function TokenExpiredError({ error, onReAuth }: ErrorComponentProps) {
  const t = useTranslations('search_ai.sharepoint.errors');
  return (
    <div className="p-4 rounded-lg border border-warning/20 bg-warning-subtle/30 space-y-3">
      <div className="flex items-center gap-2">
        <KeyRound className="w-4 h-4 text-warning" />
        <h4 className="text-sm font-semibold text-foreground">{t('token_expired_title')}</h4>
      </div>

      <p className="text-sm text-foreground">
        {t('token_expired_description', {
          days: error.daysUntilExpiry ?? 0,
          date: error.tokenExpiryDate ?? '',
        })}
      </p>

      {error.refreshErrorCode && (
        <p className="text-xs text-muted">
          Auto-refresh failed: {error.refreshErrorCode}
          {error.lastRefreshAttempt && ` (last attempt: ${error.lastRefreshAttempt})`}
        </p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button variant="primary" size="xs" onClick={onReAuth}>
          {t('btn_reauth')}
        </Button>
      </div>
    </div>
  );
}
