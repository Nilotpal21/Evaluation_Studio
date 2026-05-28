'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Checkbox } from '../ui/Checkbox';

interface MarketplaceFilterPanelProps {
  categories: Array<{ name: string; count: number }>;
  selectedCategories: string[];
  onToggle: (category: string) => void;
}

const MAX_VISIBLE = 5;

export function MarketplaceFilterPanel({
  categories,
  selectedCategories,
  onToggle,
}: MarketplaceFilterPanelProps) {
  const t = useTranslations('marketplace');
  const [showAll, setShowAll] = useState(false);

  if (categories.length === 0) return null;

  const visibleCategories = showAll ? categories : categories.slice(0, MAX_VISIBLE);

  return (
    <div className="space-y-1">
      {visibleCategories.map((cat) => {
        // Attempt to use translated name; fall back to raw name
        const displayName = t(`categories.${cat.name}`, { defaultValue: cat.name });

        return (
          <label
            key={cat.name}
            className="flex items-center gap-2 px-1 py-1 rounded-md hover:bg-[hsl(var(--sidebar-hover))] cursor-pointer"
          >
            <Checkbox
              checked={selectedCategories.includes(cat.name)}
              onChange={() => onToggle(cat.name)}
            />
            <span className="text-sm flex-1 truncate">{displayName}</span>
            <span className="text-[10px] tabular-nums text-muted">{cat.count}</span>
          </label>
        );
      })}
      {categories.length > MAX_VISIBLE && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="px-1 py-1 text-xs text-accent hover:underline"
        >
          {showAll ? t('sidebar.showLess') : t('sidebar.showMore')}
        </button>
      )}
    </div>
  );
}
