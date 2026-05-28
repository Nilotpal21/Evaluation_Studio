/**
 * BrowsePreviewHeader
 *
 * Admin banner + search bar + category pills + beta toggle for Browse SDK preview.
 */

'use client';

import { Eye, Info } from 'lucide-react';
import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import { Toggle } from '../../ui/Toggle';
import { Badge } from '../../ui/Badge';
import { BrowseAutoSuggest } from './BrowseAutoSuggest';

interface CategoryPill {
  id: string;
  name: string;
  active: boolean;
}

interface BrowsePreviewHeaderProps {
  kbName: string;
  documentCount: number;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSearch: (query: string) => void;
  categories: CategoryPill[];
  onCategoryClick: (categoryId: string) => void;
  includeBeta: boolean;
  onToggleBeta: () => void;
  suggestions?: Array<{ text: string; category?: string }>;
  isSearching?: boolean;
}

export function BrowsePreviewHeader({
  kbName,
  documentCount,
  searchQuery,
  onSearchChange,
  onSearch,
  categories,
  onCategoryClick,
  includeBeta,
  onToggleBeta,
  suggestions = [],
  isSearching = false,
}: BrowsePreviewHeaderProps) {
  const t = useTranslations('search_ai.browse');
  return (
    <header className="border-b border-default bg-background">
      {/* Admin banner */}
      <div className="bg-accent-subtle border-b border-accent/20">
        <div className="max-w-screen-2xl mx-auto px-6 py-2 flex items-center gap-2">
          <Eye className="w-4 h-4 text-accent" />
          <span className="text-xs font-medium text-accent">{t('sdk_preview')}</span>
          <span className="text-xs text-accent/70">{t('sdk_preview_description')}</span>
          <div className="ml-auto flex items-center gap-3">
            <Badge variant="default">
              {t('document_count', { count: documentCount.toLocaleString() })}
            </Badge>
            <Toggle
              checked={includeBeta}
              onChange={onToggleBeta}
              label={t('show_beta')}
              description={t('include_beta_description')}
            />
          </div>
        </div>
      </div>

      {/* Search bar + KB name */}
      <div className="max-w-screen-2xl mx-auto px-6 py-4">
        <div className="flex items-center gap-4 mb-3">
          <h1 className="text-lg font-semibold text-foreground">{kbName}</h1>
          <Info className="w-4 h-4 text-subtle" />
        </div>

        <div className="flex items-center gap-3">
          <BrowseAutoSuggest
            value={searchQuery}
            onChange={onSearchChange}
            onSearch={onSearch}
            suggestions={suggestions}
            isLoading={isSearching}
            placeholder={t('search_placeholder', { name: kbName })}
          />
        </div>
      </div>

      {/* Category pills */}
      {categories.length > 0 && (
        <div className="max-w-screen-2xl mx-auto px-6 pb-3">
          <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide">
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => onCategoryClick(cat.id)}
                className={clsx(
                  'shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-default',
                  cat.active
                    ? 'bg-accent text-accent-foreground border-accent'
                    : 'bg-background-muted text-muted border-default hover:bg-background-elevated hover:text-foreground',
                )}
              >
                {cat.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}
