'use client';

import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from '../../ui/Input';

interface ConnectorCatalogSearchProps {
  value: string;
  onChange: (value: string) => void;
  resultCount: number;
  totalCount: number;
}

export function ConnectorCatalogSearch({
  value,
  onChange,
  resultCount,
  totalCount,
}: ConnectorCatalogSearchProps) {
  const t = useTranslations('search_ai.connector_catalog');

  const countLabel = value.trim()
    ? t('search_result_count', { count: resultCount })
    : t('search_total_count', { count: totalCount });

  return (
    <div className="space-y-1.5">
      <Input
        icon={<Search className="w-4 h-4" />}
        placeholder={t('search_placeholder')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="text-xs text-muted">{countLabel}</p>
    </div>
  );
}
