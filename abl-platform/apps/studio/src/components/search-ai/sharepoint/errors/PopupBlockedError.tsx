'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../../../ui/Button';
import type { ErrorComponentProps } from './error-types';

export function PopupBlockedError({ error, onRetry }: ErrorComponentProps) {
  const t = useTranslations('search_ai.sharepoint.errors');
  return (
    <div className="p-4 rounded-lg border border-warning/20 bg-warning-subtle/30 space-y-3">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-warning" />
        <h4 className="text-sm font-semibold text-foreground">{t('popup_blocked_title')}</h4>
      </div>

      <p className="text-sm text-foreground">
        {error.popupBlockReason ??
          'The browser blocked the sign-in popup. This is common with strict popup blocker settings.'}
      </p>

      <ol className="text-xs text-muted space-y-1 list-decimal list-inside">
        <li>Allow popups for this site in your browser settings</li>
        <li>Try disabling popup blocker extensions temporarily</li>
        <li>Use Device Code authentication as an alternative</li>
      </ol>

      <div className="flex items-center gap-2 pt-1">
        <Button variant="secondary" size="xs" onClick={() => onRetry('switch_device_code')}>
          {t('btn_switch_device_code')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onRetry('try_again')}>
          {t('btn_try_again')}
        </Button>
      </div>
    </div>
  );
}
