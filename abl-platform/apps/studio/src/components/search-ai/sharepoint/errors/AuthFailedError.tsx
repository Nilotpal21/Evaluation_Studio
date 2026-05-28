'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../../../ui/Button';
import type { ErrorComponentProps } from './error-types';

export function AuthFailedError({ error, onRetry }: ErrorComponentProps) {
  const t = useTranslations('search_ai.sharepoint.errors');
  return (
    <div className="p-4 rounded-lg border border-error/20 bg-error-subtle/30 space-y-3">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-error" />
        <h4 className="text-sm font-semibold text-foreground">{t('auth_failed_title')}</h4>
      </div>

      {error.errorCode && <p className="text-xs text-muted font-mono">{error.errorCode}</p>}
      {error.errorMessage && <p className="text-sm text-foreground">{error.errorMessage}</p>}

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-foreground">{t('auth_failed_how_to_fix')}</p>
        <ol className="text-xs text-muted space-y-1 list-decimal list-inside">
          <li>
            {error.appRegistrationName
              ? `Check the app registration "${error.appRegistrationName}" in Azure AD`
              : 'Check the app registration in Azure AD'}
          </li>
          <li>
            {error.secretCreatedDate
              ? `The client secret was created on ${error.secretCreatedDate} — verify it has not expired`
              : 'Verify the client secret has not expired'}
          </li>
          <li>Ensure the required API permissions are granted and admin consent is given</li>
        </ol>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="secondary"
          size="xs"
          onClick={() =>
            window.open('https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps', '_blank')
          }
        >
          {t('btn_open_azure_portal')}
        </Button>
        <Button variant="secondary" size="xs" onClick={() => onRetry('retry_auth')}>
          {t('btn_retry_new_secret')}
        </Button>
      </div>
    </div>
  );
}
