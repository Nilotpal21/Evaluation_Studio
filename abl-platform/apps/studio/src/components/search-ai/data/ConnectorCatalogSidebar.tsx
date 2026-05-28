'use client';

import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import type { CatalogCategoryDef, ConnectorCatalogCategory } from './connector-catalog-registry';

interface ConnectorCatalogSidebarProps {
  categories: CatalogCategoryDef[];
  categoryCounts: Map<ConnectorCatalogCategory, number>;
  totalCount: number;
  popularCount: number;
  activeCategory: string; // 'all' | 'popular' | category id
  onCategorySelect: (category: string) => void;
}

export function ConnectorCatalogSidebar({
  categories,
  categoryCounts,
  totalCount,
  popularCount,
  activeCategory,
  onCategorySelect,
}: ConnectorCatalogSidebarProps) {
  const t = useTranslations('search_ai.connector_catalog');

  const items: { id: string; label: string; count: number }[] = [
    { id: 'all', label: t('category_all'), count: totalCount },
    { id: 'popular', label: t('category_popular'), count: popularCount },
    ...categories.map((cat) => ({
      id: cat.id,
      label: t(`category_${cat.id}`),
      count: categoryCounts.get(cat.id) ?? 0,
    })),
  ];

  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((item) => {
        const isActive = activeCategory === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onCategorySelect(item.id)}
            className={clsx(
              'flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors',
              isActive
                ? 'bg-background-elevated text-foreground font-medium'
                : 'text-muted hover:text-foreground hover:bg-background-subtle',
            )}
          >
            <span className="truncate">{item.label}</span>
            <span className="ml-2 text-xs text-subtle shrink-0">{item.count}</span>
          </button>
        );
      })}
    </nav>
  );
}
