'use client';

/**
 * NoDocumentsEmpty (EM2)
 *
 * Shown when sync completes with 0 indexed documents.
 * Displays filter exclusion analysis and action buttons.
 */

import { useTranslations } from 'next-intl';
import { FileX } from 'lucide-react';
import { EmptyState } from '../../../ui/EmptyState';
import { Button } from '../../../ui/Button';

interface NoDocumentsEmptyProps {
  filterExclusions: Array<{
    filterType: string;
    excludedCount: number;
    detail: string;
  }>;
  onAdjustFilters: () => void;
  onSelectDifferentSites: () => void;
  onViewAllDiscovered: () => void;
}

export function NoDocumentsEmpty({
  filterExclusions,
  onAdjustFilters,
  onSelectDifferentSites,
  onViewAllDiscovered,
}: NoDocumentsEmptyProps) {
  const t = useTranslations('search_ai.sharepoint.empty');

  return (
    <div className="space-y-4">
      <EmptyState
        icon={<FileX className="w-6 h-6" />}
        title={t('no_docs_title')}
        description={t('no_docs_description')}
        action={
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={onAdjustFilters}>
              {t('btn_adjust_filters')}
            </Button>
            <Button variant="secondary" size="sm" onClick={onSelectDifferentSites}>
              {t('btn_select_different_sites')}
            </Button>
            <Button variant="ghost" size="sm" onClick={onViewAllDiscovered}>
              {t('btn_view_all_discovered')}
            </Button>
          </div>
        }
      />

      {filterExclusions.length > 0 && (
        <div className="px-6 space-y-2">
          <p className="text-xs text-muted">{t('no_docs_exclusion_label')}</p>
          <ul className="text-xs text-muted space-y-1 list-disc list-inside">
            {filterExclusions.map((exclusion, i) => (
              <li key={i}>
                <span className="text-foreground">{exclusion.filterType}</span>: {exclusion.detail}{' '}
                ({exclusion.excludedCount} excluded)
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">{t('no_docs_filter_note')}</p>
        </div>
      )}
    </div>
  );
}
