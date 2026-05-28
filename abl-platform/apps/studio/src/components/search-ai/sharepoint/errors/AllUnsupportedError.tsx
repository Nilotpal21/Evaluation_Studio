'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileX } from 'lucide-react';
import { Button } from '../../../ui/Button';
import type { ErrorComponentProps } from './error-types';

export function AllUnsupportedError({ error, onRetry, onNavigateToTab }: ErrorComponentProps) {
  const t = useTranslations('search_ai.sharepoint.errors');
  const [showAllTypes, setShowAllTypes] = useState(false);

  const discovered = error.discoveredFileTypes ?? [];
  const supported = error.supportedFileTypes ?? [];
  const displayTypes = showAllTypes ? discovered : discovered.slice(0, 5);

  return (
    <div className="p-4 rounded-lg border border-warning/20 bg-warning-subtle/30 space-y-3">
      <div className="flex items-center gap-2">
        <FileX className="w-4 h-4 text-warning" />
        <h4 className="text-sm font-semibold text-foreground">{t('all_unsupported_title')}</h4>
      </div>

      <p className="text-sm text-foreground">
        {error.totalDiscoveredFiles ?? 0} files discovered, but none match supported file types.
      </p>

      {discovered.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted">Discovered types:</p>
          <div className="flex flex-wrap gap-1">
            {displayTypes.map((type) => (
              <span
                key={type}
                className="px-1.5 py-0.5 text-xs bg-background-muted rounded font-mono"
              >
                {type}
              </span>
            ))}
            {!showAllTypes && discovered.length > 5 && (
              <button
                onClick={() => setShowAllTypes(true)}
                className="text-xs text-accent hover:underline"
              >
                +{discovered.length - 5} more
              </button>
            )}
          </div>
        </div>
      )}

      {supported.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted">Supported types:</p>
          <div className="flex flex-wrap gap-1">
            {supported.map((type) => (
              <span
                key={type}
                className="px-1.5 py-0.5 text-xs bg-success-subtle text-success rounded font-mono"
              >
                {type}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button variant="secondary" size="xs" onClick={() => onNavigateToTab('scope-filters')}>
          {t('btn_select_different_sites')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onRetry('upload_files')}>
          {t('btn_upload_files')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onRetry('cancel_setup')}>
          {t('btn_cancel_setup')}
        </Button>
      </div>
    </div>
  );
}
