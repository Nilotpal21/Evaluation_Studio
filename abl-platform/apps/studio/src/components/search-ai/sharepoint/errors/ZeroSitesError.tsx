'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import type { ErrorComponentProps } from './error-types';

export function ZeroSitesError({ error, onRetry }: ErrorComponentProps) {
  const t = useTranslations('search_ai.sharepoint.errors');
  const [siteUrl, setSiteUrl] = useState('');

  return (
    <div className="p-4 rounded-lg border border-warning/20 bg-warning-subtle/30 space-y-3">
      <div className="flex items-center gap-2">
        <Search className="w-4 h-4 text-warning" />
        <h4 className="text-sm font-semibold text-foreground">{t('zero_sites_title')}</h4>
      </div>

      {error.currentPermissionScope && (
        <p className="text-xs text-muted">
          Current scope: <span className="font-mono">{error.currentPermissionScope}</span>
        </p>
      )}

      {error.possibleReasons && error.possibleReasons.length > 0 && (
        <ol className="text-xs text-muted space-y-1.5 list-decimal list-inside">
          {error.possibleReasons.map((r, i) => (
            <li key={i}>
              <span className="text-foreground">{r.reason}</span>
              <br />
              <span className="text-muted ml-4">{r.fix}</span>
            </li>
          ))}
        </ol>
      )}

      {/* Inline URL input */}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            placeholder="https://contoso.sharepoint.com/sites/"
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            aria-label={t('btn_enter_url')}
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={!siteUrl}
          onClick={() => onRetry(`check_access:${siteUrl}`)}
        >
          Check Access
        </Button>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button variant="secondary" size="xs" onClick={() => onRetry('retry_discovery')}>
          {t('btn_retry_discovery')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onRetry('upgrade_scope')}>
          {t('btn_upgrade_scope')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onRetry('enter_url')}>
          {t('btn_enter_url')}
        </Button>
      </div>
    </div>
  );
}
