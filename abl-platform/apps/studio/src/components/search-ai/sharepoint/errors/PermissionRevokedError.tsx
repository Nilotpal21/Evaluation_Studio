'use client';

import { useTranslations } from 'next-intl';
import { ShieldOff } from 'lucide-react';
import { Button } from '../../../ui/Button';
import type { ErrorComponentProps } from './error-types';

export function PermissionRevokedError({ error, onReAuth, onRetry }: ErrorComponentProps) {
  const t = useTranslations('search_ai.sharepoint.errors');
  return (
    <div className="p-4 rounded-lg border border-error/20 bg-error-subtle/30 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldOff className="w-4 h-4 text-error" />
        <h4 className="text-sm font-semibold text-foreground">{t('permission_revoked_title')}</h4>
      </div>

      {error.revokedPermission && (
        <p className="text-sm text-foreground">
          Permission revoked: <span className="font-mono">{error.revokedPermission}</span>
        </p>
      )}

      {error.impactList && error.impactList.length > 0 && (
        <ul className="text-xs text-muted list-disc list-inside space-y-0.5">
          {error.impactList.map((impact, i) => (
            <li key={i}>{impact}</li>
          ))}
        </ul>
      )}

      {error.syncAutoPaused && (
        <p className="text-xs text-warning">Sync has been auto-paused to prevent data issues.</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button variant="secondary" size="xs" onClick={() => onRetry('share_with_admin')}>
          {t('btn_share_with_admin')}
        </Button>
        <Button variant="secondary" size="xs" onClick={onReAuth}>
          {t('btn_reauth')}
        </Button>
        <Button variant="danger" size="xs" onClick={() => onRetry('delete_connector')}>
          {t('btn_delete_connector')}
        </Button>
      </div>
    </div>
  );
}
