/**
 * TemplateCatalogPage — Gallery page for browsing rich content templates.
 *
 * Features: category tabs, search/filter, live preview, JSON editor, DSL viewer.
 * Uses ListPageShell for layout and Tabs for category filtering.
 * Uses semantic design tokens for light/dark mode.
 */

'use client';

import React, { useState, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { ListPageShell } from '../ui/ListPageShell';
import { Tabs } from '../ui/Tabs';
import {
  templateCatalog,
  TEMPLATE_CATEGORIES,
  searchCatalog,
  getCatalogByCategory,
  type TemplateCategory,
  type TemplateCatalogEntry,
} from '../../lib/template-catalog';
import { TemplatePreview } from './TemplatePreview';
import { TemplateJsonEditor } from './TemplateJsonEditor';
import { TemplateDSLView } from './TemplateDSLView';

export function TemplateCatalogPage() {
  const t = useTranslations('templates');
  const [activeCategory, setActiveCategory] = useState<TemplateCategory | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<TemplateCatalogEntry | null>(null);
  const [jsonData, setJsonData] = useState('');

  const categoryTabs = useMemo(
    () => [
      { id: 'all', label: t('category_all') },
      ...TEMPLATE_CATEGORIES.map((cat) => ({
        id: cat,
        label: t(`category_${cat.toLowerCase()}`),
      })),
    ],
    [t],
  );

  const filteredEntries = useMemo(() => {
    let entries = activeCategory === 'all' ? templateCatalog : getCatalogByCategory(activeCategory);
    if (searchQuery.trim()) {
      const searchResults = searchCatalog(searchQuery);
      entries = entries.filter((e) => searchResults.includes(e));
    }
    return entries;
  }, [activeCategory, searchQuery]);

  const handleSelectEntry = useCallback((entry: TemplateCatalogEntry) => {
    setSelectedEntry(entry);
    setJsonData(JSON.stringify(entry.exampleJson, null, 2));
  }, []);

  const renderSupportBadges = useCallback(
    (entry: TemplateCatalogEntry) => {
      const badges = [
        t('support_badge', {
          surface: t('support_surface_web'),
          mode: t(`support_mode_${entry.webRenderMode}`),
        }),
        t('support_badge', {
          surface: t('support_surface_preview'),
          mode: t(`support_mode_${entry.studioPreviewMode}`),
        }),
        t('support_badge', {
          surface: t('support_surface_dsl'),
          mode: t(`support_mode_${entry.dslAuthoringMode}`),
        }),
      ];

      return (
        <div className="mt-2 flex flex-wrap gap-1">
          {badges.map((label) => (
            <span
              key={label}
              className="inline-flex rounded bg-background-muted px-2 py-0.5 text-[10px] text-subtle"
            >
              {label}
            </span>
          ))}
        </div>
      );
    },
    [t],
  );

  return (
    <ListPageShell
      title={t('page_title')}
      description={t('page_description')}
      searchPlaceholder={t('search_placeholder')}
      searchValue={searchQuery}
      onSearchChange={setSearchQuery}
      filterBar={
        <Tabs
          tabs={categoryTabs}
          activeTab={activeCategory}
          onTabChange={(tabId) => setActiveCategory(tabId as TemplateCategory | 'all')}
          layoutId="template-category-tabs"
          className="border-b-0"
        />
      }
    >
      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Gallery grid */}
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {filteredEntries.map((entry) => (
              <button
                key={entry.type}
                type="button"
                onClick={() => handleSelectEntry(entry)}
                aria-label={t('select_template', { name: entry.name })}
                className={`rounded-lg border p-4 text-left transition-colors ${
                  selectedEntry?.type === entry.type
                    ? 'border-border-focus bg-background-active'
                    : 'border-default bg-background hover:border-border-hover'
                }`}
              >
                <div className="text-sm font-medium text-foreground">
                  {t(`type_${entry.type}_name`)}
                </div>
                <div className="mt-1 text-xs text-muted">{t(`type_${entry.type}_description`)}</div>
                <div className="mt-2 inline-block rounded bg-background-muted px-2 py-0.5 text-[10px] text-subtle">
                  {t(`category_${entry.category.toLowerCase()}`)}
                </div>
                {renderSupportBadges(entry)}
              </button>
            ))}
          </div>
          {filteredEntries.length === 0 && (
            <div className="py-12 text-center text-sm text-muted">{t('no_results')}</div>
          )}
        </div>

        {/* Detail panel */}
        {selectedEntry && (
          <div className="relative w-96 flex-shrink-0 overflow-y-auto border-l border-default p-6">
            {/* Close button */}
            <button
              type="button"
              onClick={() => setSelectedEntry(null)}
              className="absolute right-4 top-4 rounded-lg p-1.5 text-muted hover:bg-background-muted hover:text-foreground transition-default"
              aria-label={t('close_detail_panel')}
            >
              <X className="h-4 w-4" />
            </button>

            <h2 className="text-base font-semibold text-foreground">
              {t(`type_${selectedEntry.type}_name`)}
            </h2>
            <p className="mt-1 text-xs text-muted">{t(`type_${selectedEntry.type}_description`)}</p>
            {renderSupportBadges(selectedEntry)}
            {selectedEntry.dslAuthoringMode === 'partial' && (
              <p className="mt-3 text-xs text-muted">{t('dsl_notice_partial')}</p>
            )}
            {selectedEntry.dslAuthoringMode === 'preview_only' && (
              <p className="mt-3 text-xs text-muted">{t('dsl_notice_preview_only')}</p>
            )}

            {/* Preview */}
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-medium text-muted">{t('preview_label')}</h3>
              <TemplatePreview jsonData={jsonData} />
            </div>

            {/* JSON Editor */}
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-medium text-muted">{t('json_editor_label')}</h3>
              <TemplateJsonEditor value={jsonData} onChange={setJsonData} />
            </div>

            {/* DSL Snippet */}
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-medium text-muted">{t('dsl_snippet_label')}</h3>
              <TemplateDSLView snippet={selectedEntry.dslSnippet} />
            </div>
          </div>
        )}
      </div>
    </ListPageShell>
  );
}
