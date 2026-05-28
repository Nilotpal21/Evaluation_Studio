'use client';

import { useEffect } from 'react';
import { Search, ArrowLeft, FolderOpen, Bot } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Checkbox } from '../ui/Checkbox';
import { MarketplaceFilterPanel } from './MarketplaceFilterPanel';
import { useMarketplaceStore } from '../../store/marketplace-store';
import { useAuthStore } from '../../store/auth-store';

export function MarketplaceSidebar() {
  const t = useTranslations('marketplace');

  const query = useMarketplaceStore((s) => s.query);
  const setQuery = useMarketplaceStore((s) => s.setQuery);
  const selectedTypes = useMarketplaceStore((s) => s.selectedTypes);
  const toggleType = useMarketplaceStore((s) => s.toggleType);
  const selectedCategories = useMarketplaceStore((s) => s.selectedCategories);
  const toggleCategory = useMarketplaceStore((s) => s.toggleCategory);
  const clearCategoryFilters = useMarketplaceStore((s) => s.clearCategoryFilters);
  const categories = useMarketplaceStore((s) => s.categories);
  const fetchCategories = useMarketplaceStore((s) => s.fetchCategories);
  const selectedPublishers = useMarketplaceStore((s) => s.selectedPublishers);
  const togglePublisher = useMarketplaceStore((s) => s.togglePublisher);

  const templates = useMarketplaceStore((s) => s.templates);

  const tenantId = useAuthStore((s) => s.tenantId);

  // Compute counts from currently loaded templates
  const projectCount = templates.filter((t) => t.type === 'project').length;
  const agentCount = templates.filter((t) => t.type === 'agent').length;
  const platformCount = templates.filter((t) => t.publisherTenantId === 'platform').length;
  const workspaceCount = tenantId
    ? templates.filter((t) => t.publisherTenantId === tenantId).length
    : 0;

  useEffect(() => {
    void fetchCategories();
  }, [fetchCategories]);

  return (
    <aside className="w-[260px] shrink-0 border-r border-default bg-gradient-surface-sidebar flex flex-col overflow-hidden">
      {/* Search zone */}
      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-default bg-background-subtle placeholder:text-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
            placeholder={t('sidebar.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Scrollable filter area */}
      <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-4">
        {/* TYPE FILTER section */}
        <div>
          <h3 className="text-[10px] font-medium uppercase tracking-[0.07em] text-muted px-1 mb-2">
            {t('sidebar.filterByType')}
          </h3>
          <div className="space-y-1">
            <label className="flex items-center gap-2 px-1 py-1 rounded-md hover:bg-[hsl(var(--sidebar-hover))] cursor-pointer">
              <Checkbox
                checked={selectedTypes.includes('project')}
                onChange={() => toggleType('project')}
              />
              <FolderOpen className="w-4 h-4 text-muted" />
              <span className="text-sm flex-1">{t('type.project')}</span>
              <span className="text-[10px] tabular-nums text-muted">{projectCount}</span>
            </label>
            <label className="flex items-center gap-2 px-1 py-1 rounded-md hover:bg-[hsl(var(--sidebar-hover))] cursor-pointer">
              <Checkbox
                checked={selectedTypes.includes('agent')}
                onChange={() => toggleType('agent')}
              />
              <Bot className="w-4 h-4 text-muted" />
              <span className="text-sm flex-1">{t('type.agent')}</span>
              <span className="text-[10px] tabular-nums text-muted">{agentCount}</span>
            </label>
          </div>
        </div>

        {/* PUBLISHER section — show when tenantId is available (persisted in localStorage) */}
        {tenantId && (
          <div>
            <h3 className="text-[10px] font-medium uppercase tracking-[0.07em] text-muted px-1 mb-2">
              {t('sidebar.publisher')}
            </h3>
            <div className="space-y-1">
              <label className="flex items-center gap-2 px-1 py-1 rounded-md hover:bg-[hsl(var(--sidebar-hover))] cursor-pointer">
                <Checkbox
                  checked={selectedPublishers.includes('platform')}
                  onChange={() => togglePublisher('platform')}
                />
                <span className="text-sm flex-1">{t('sidebar.publisherGlobal')}</span>
                <span className="text-[10px] tabular-nums text-muted">{platformCount}</span>
              </label>
              <label className="flex items-center gap-2 px-1 py-1 rounded-md hover:bg-[hsl(var(--sidebar-hover))] cursor-pointer">
                <Checkbox
                  checked={selectedPublishers.includes(tenantId)}
                  onChange={() => togglePublisher(tenantId)}
                />
                <span className="text-sm flex-1">{t('sidebar.publisherWorkspace')}</span>
                <span className="text-[10px] tabular-nums text-muted">{workspaceCount}</span>
              </label>
            </div>
          </div>
        )}

        {/* CATEGORIES section */}
        <div>
          <div className="flex items-center justify-between px-1 mb-2">
            <h3 className="text-[10px] font-medium uppercase tracking-[0.07em] text-muted">
              {t('sidebar.categories')}
            </h3>
            {selectedCategories.length > 0 && (
              <button
                onClick={clearCategoryFilters}
                className="text-[10px] text-accent hover:underline"
              >
                {t('sidebar.clearAll')}
              </button>
            )}
          </div>
          <MarketplaceFilterPanel
            categories={categories}
            selectedCategories={selectedCategories}
            onToggle={toggleCategory}
          />
        </div>
      </nav>

      {/* Back to Studio - bottom */}
      <div className="shrink-0 border-t border-default px-3 py-3">
        <button
          onClick={() => {
            window.location.href = '/';
          }}
          className="flex items-center gap-2 w-full px-2 py-1.5 text-sm text-muted hover:text-foreground rounded-md hover:bg-[hsl(var(--sidebar-hover))] transition-default"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('sidebar.backToStudio')}
        </button>
      </div>
    </aside>
  );
}
