'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Search } from 'lucide-react';
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { useConnectorStore } from '../../../store/connector-store';
import { EmptyState } from '../../ui/EmptyState';
import { Button } from '../../ui/Button';
import { ConnectorCatalogSearch } from './ConnectorCatalogSearch';
import { ConnectorCatalogSidebar } from './ConnectorCatalogSidebar';
import { ConnectorCatalogCard } from './ConnectorCatalogCard';
import {
  CATALOG_CATEGORIES,
  CATALOG_CONNECTORS,
  getCatalogConnectorsByCategory,
  getPopularConnectors,
  searchConnectors,
  type CatalogConnectorEntry,
  type ConnectorCatalogCategory,
} from './connector-catalog-registry';

interface ConnectorCatalogProps {
  indexId: string;
  onSourceAdded: (source?: { _id: string; name: string; sourceType: string }) => void;
  onClose: () => void;
  /** Called when user selects Web Crawler — parent transitions to web mode selector */
  onWebModeRequested: () => void;
}

const DEBOUNCE_MS = 200;

export function ConnectorCatalog({
  indexId: _indexId,
  onSourceAdded,
  onClose,
  onWebModeRequested,
}: ConnectorCatalogProps) {
  const t = useTranslations('search_ai.connector_catalog');
  const openPanel = useConnectorStore((s) => s.openPanel);

  // ─── State ──────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  // sidebarHighlight: which sidebar item is visually active (updated by scroll observer)
  // Decoupled from content rendering to prevent scroll-triggered view changes.
  const [sidebarHighlight, setSidebarHighlight] = useState<string>('all');
  const isScrollingToRef = useRef(false);

  // ─── Debounce ───────────────────────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // ─── Derived data ───────────────────────────────────────────────────────
  const allConnectors = CATALOG_CONNECTORS;
  const popularConnectors = useMemo(() => getPopularConnectors(allConnectors), [allConnectors]);

  const filteredConnectors = useMemo(() => {
    if (!debouncedQuery.trim()) return allConnectors;
    return searchConnectors(allConnectors, debouncedQuery);
  }, [allConnectors, debouncedQuery]);

  const connectorsByCategory = useMemo(
    () => getCatalogConnectorsByCategory(filteredConnectors),
    [filteredConnectors],
  );

  const categoryCounts = useMemo(() => {
    const counts = new Map<ConnectorCatalogCategory, number>();
    for (const [cat, list] of connectorsByCategory) {
      counts.set(cat, list.length);
    }
    return counts;
  }, [connectorsByCategory]);

  const isSearching = debouncedQuery.trim().length > 0;

  // ─── Scroll tracking ───────────────────────────────────────────────────
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const handleCategorySelect = useCallback((category: string) => {
    setSidebarHighlight(category);
    // Suppress observer updates while programmatic scroll is in progress
    isScrollingToRef.current = true;
    setTimeout(() => {
      isScrollingToRef.current = false;
    }, 800);

    if (category === 'all') {
      scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      const sectionId =
        category === 'popular' ? 'catalog-section-popular' : `catalog-section-${category}`;
      const el = document.getElementById(sectionId);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  // IntersectionObserver — only updates sidebar highlight, never changes content
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || isSearching) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (isScrollingToRef.current) return;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const sectionId = entry.target.id.replace('catalog-section-', '');
            setSidebarHighlight(sectionId);
            break;
          }
        }
      },
      { root: container, rootMargin: '-10% 0px -80% 0px', threshold: 0 },
    );

    const sections = container.querySelectorAll('[id^="catalog-section-"]');
    sections.forEach((section) => observer.observe(section));

    return () => observer.disconnect();
  }, [isSearching, connectorsByCategory]);

  // ─── Action handler ─────────────────────────────────────────────────────
  const handleConnectorAction = useCallback(
    (connector: CatalogConnectorEntry) => {
      switch (connector.flowType) {
        case 'enterprise_wizard':
          onClose();
          openPanel('new', { isNew: true, tab: 'connect' });
          break;
        case 'file_upload':
          onClose();
          onSourceAdded(); // no source arg = "open upload dialog"
          break;
        case 'web_modes':
          onWebModeRequested();
          break;
        case 'noop':
          // Connector not yet implemented — do nothing
          break;
        case 'config_form':
          // Future: open config form flow
          break;
      }
    },
    [onClose, onSourceAdded, onWebModeRequested, openPanel],
  );

  // ─── Section rendering ──────────────────────────────────────────────────
  const renderSectionHeader = (label: string, count: number, isFirst?: boolean) => (
    <div className={clsx('flex items-center gap-3 mb-2', isFirst ? 'mt-0' : 'mt-4')}>
      <h3 className="text-[11px] font-semibold text-muted uppercase tracking-wider whitespace-nowrap">
        {label}
      </h3>
      <div className="flex-1 border-t border-default" />
      <span className="text-[11px] text-subtle">{count}</span>
    </div>
  );

  const renderGrid = (connectors: CatalogConnectorEntry[]) => (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-2.5">
      {connectors.map((connector) => (
        <ConnectorCatalogCard
          key={connector.name}
          connector={connector}
          onAction={handleConnectorAction}
        />
      ))}
    </div>
  );

  const renderPopularSection = () => (
    <div id="catalog-section-popular">
      {renderSectionHeader(t('category_popular'), popularConnectors.length, true)}
      {renderGrid(popularConnectors)}
    </div>
  );

  const renderCategorySections = () => {
    const orderedCategories = CATALOG_CATEGORIES.filter((cat) => connectorsByCategory.has(cat.id));

    return orderedCategories.map((cat) => {
      const connectors = connectorsByCategory.get(cat.id);
      if (!connectors?.length) return null;

      return (
        <div key={cat.id} id={`catalog-section-${cat.id}`}>
          {renderSectionHeader(t(`category_${cat.id}`), connectors.length)}
          {renderGrid(connectors)}
        </div>
      );
    });
  };

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="-mx-6 -mb-6 flex h-[70vh]">
      {/* Sidebar — hidden below lg */}
      <aside className="hidden lg:block w-[200px] shrink-0 border-r border-default overflow-y-auto py-3 px-2">
        <ConnectorCatalogSidebar
          categories={CATALOG_CATEGORIES}
          categoryCounts={categoryCounts}
          totalCount={allConnectors.length}
          popularCount={popularConnectors.length}
          activeCategory={sidebarHighlight}
          onCategorySelect={handleCategorySelect}
        />
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Search bar */}
        <div className="sticky top-0 px-4 py-3 border-b border-default bg-background-elevated z-10">
          <ConnectorCatalogSearch
            value={searchQuery}
            onChange={setSearchQuery}
            resultCount={filteredConnectors.length}
            totalCount={allConnectors.length}
          />
        </div>

        {/* Scrollable grid */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-3">
          {isSearching && filteredConnectors.length === 0 && (
            <EmptyState
              icon={<Search className="w-6 h-6" />}
              title={t('empty_title')}
              description={t('empty_description')}
              action={
                <Button variant="secondary" size="sm" onClick={() => setSearchQuery('')}>
                  {t('empty_clear_search')}
                </Button>
              }
            />
          )}

          {isSearching && filteredConnectors.length > 0 && renderCategorySections()}

          {!isSearching && (
            <>
              {renderPopularSection()}
              {renderCategorySections()}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
