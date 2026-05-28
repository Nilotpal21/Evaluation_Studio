/**
 * TokenExpirySection Component
 *
 * Shows token expiry status, countdown, and renewal action.
 */

import { useTranslations } from 'next-intl';
import { Clock, AlertTriangle } from 'lucide-react';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import type { SecurityOverview } from '../../../../hooks/useSecurityOverview';

interface TokenExpirySectionProps {
  tokenStatus: SecurityOverview['tokenStatus'];
  onRenew?: () => void;
}

export function TokenExpirySection({ tokenStatus, onRenew }: TokenExpirySectionProps) {
  const t = useTranslations('search_ai.sharepoint.security');

  const isWarning = !tokenStatus.isExpired && tokenStatus.daysRemaining <= 7;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
        <Clock className="w-4 h-4 text-muted" />
        {t('token_title')}
      </h3>
      <div className="p-3 rounded-lg bg-background-subtle space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-foreground">{t('token_status_label')}</span>
          {tokenStatus.isExpired ? (
            <Badge variant="error">{t('token_expired')}</Badge>
          ) : isWarning ? (
            <Badge variant="warning">
              {t('token_expiring_soon', { days: tokenStatus.daysRemaining })}
            </Badge>
          ) : (
            <Badge variant="success">{t('token_valid')}</Badge>
          )}
        </div>
        {tokenStatus.expiresAt && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted">{t('token_expires_at')}</span>
            <span className="text-xs text-muted">
              {new Date(tokenStatus.expiresAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
        )}
        {(tokenStatus.isExpired || isWarning) && (
          <div className="flex items-center gap-2 pt-1">
            <AlertTriangle className="w-3.5 h-3.5 text-warning" />
            <span className="text-xs text-warning">{t('token_renewal_notice')}</span>
            {onRenew && (
              <Button variant="secondary" size="xs" onClick={onRenew}>
                {t('token_renew')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
