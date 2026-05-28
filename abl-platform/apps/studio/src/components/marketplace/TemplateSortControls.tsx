'use client';

import { useTranslations } from 'next-intl';
import { FilterSelect } from '@/components/ui/FilterSelect';
import {
  useMarketplaceStore,
  selectSortField,
  selectSortDirection,
} from '@/store/marketplace-store';
import type { SortField, SortDirection } from '@/store/marketplace-store';
import { useMemo } from 'react';

/**
 * Combined sort control — single dropdown with field + direction pairs.
 * Options: Downloads (Most/Least), Views (Most/Least), Name (A→Z / Z→A)
 */
export function TemplateSortControls() {
  const t = useTranslations('marketplace');

  const sortField = useMarketplaceStore(selectSortField);
  const sortDirection = useMarketplaceStore(selectSortDirection);
  const setSortField = useMarketplaceStore((s) => s.setSortField);
  const setSortDirection = useMarketplaceStore((s) => s.setSortDirection);

  // Combined value encodes both field and direction
  const combinedValue = `${sortField}:${sortDirection}`;

  const options = useMemo(
    () => [
      { value: 'installCount:desc', label: `${t('sort.downloads')} (Most First)` },
      { value: 'installCount:asc', label: `${t('sort.downloads')} (Least First)` },
      { value: 'viewCount:desc', label: `${t('sort.views')} (Most First)` },
      { value: 'viewCount:asc', label: `${t('sort.views')} (Least First)` },
      { value: 'name:asc', label: `${t('sort.name')} (A → Z)` },
      { value: 'name:desc', label: `${t('sort.name')} (Z → A)` },
    ],
    [t],
  );

  const handleChange = (value: string) => {
    const [field, direction] = value.split(':') as [SortField, SortDirection];
    setSortField(field);
    setSortDirection(direction);
  };

  return <FilterSelect options={options} value={combinedValue} onChange={handleChange} />;
}
