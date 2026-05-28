'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { LayoutGrid, Search } from 'lucide-react';
import {
  useMarketplaceStore,
  selectTemplates,
  selectMarketplaceTotal,
  selectMarketplaceLoading,
  selectMarketplaceError,
} from '@/store/marketplace-store';
import { TemplateCard } from '@/components/marketplace/TemplateCard';
import { TemplateSortControls } from '@/components/marketplace/TemplateSortControls';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';

export default function MarketplacePage() {
  const t = useTranslations('marketplace');

  const templates = useMarketplaceStore(selectTemplates);
  const total = useMarketplaceStore(selectMarketplaceTotal);
  const loading = useMarketplaceStore(selectMarketplaceLoading);
  const error = useMarketplaceStore(selectMarketplaceError);
  const page = useMarketplaceStore((s) => s.page);
  const fetchTemplates = useMarketplaceStore((s) => s.fetchTemplates);
  const fetchCategories = useMarketplaceStore((s) => s.fetchCategories);
  const setPage = useMarketplaceStore((s) => s.setPage);

  useEffect(() => {
    fetchCategories();
    fetchTemplates();
  }, [fetchCategories, fetchTemplates]);

  const totalPages = Math.ceil(total / 20);

  return (
    <div className="p-6 space-y-4">
      {/* Results header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <LayoutGrid className="w-4 h-4 text-muted" />
          {loading ? (
            <span className="text-sm text-muted">{t('search.loading')}</span>
          ) : (
            <>
              <h2 className="text-sm font-medium text-foreground">{t('sidebar.allTemplates')}</h2>
              <span className="text-xs px-2 py-0.5 rounded-full bg-background-muted text-muted font-medium tabular-nums">
                {total}
              </span>
            </>
          )}
        </div>
        <TemplateSortControls />
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-xl border border-error bg-error-subtle p-4">
          <p className="text-sm text-error">{error}</p>
          <Button variant="ghost" size="sm" onClick={fetchTemplates} className="mt-2">
            {t('errors.retry')}
          </Button>
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : templates.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4 stagger-children">
          {templates.map((tmpl) => (
            <TemplateCard key={tmpl._id} template={tmpl} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Search className="w-12 h-12 text-muted mb-4" />
          <p className="text-sm text-muted">{t('search.noResults')}</p>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-4">
          <button
            onClick={() => setPage(page - 1)}
            disabled={page <= 1}
            className="px-3 py-1.5 text-sm rounded-lg border border-default disabled:opacity-50 hover:bg-background-muted transition-default"
          >
            {t('pagination.previous')}
          </button>
          <span className="text-sm text-muted">
            {t('pagination.page', { page, total: totalPages })}
          </span>
          <button
            onClick={() => setPage(page + 1)}
            disabled={page >= totalPages}
            className="px-3 py-1.5 text-sm rounded-lg border border-default disabled:opacity-50 hover:bg-background-muted transition-default"
          >
            {t('pagination.next')}
          </button>
        </div>
      )}
    </div>
  );
}
