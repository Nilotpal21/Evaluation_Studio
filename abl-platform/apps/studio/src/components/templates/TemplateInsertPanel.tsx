/**
 * TemplateInsertPanel — Slide-over panel for rich content template browsing and insertion.
 *
 * Triggered by the /rich-template command. Uses navigation store (not window.history.pushState).
 * Built on SlidePanel (Radix Dialog) for accessibility: focus trap, Escape key, ARIA.
 */

'use client';

import React, { useState, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { SlidePanel } from '../ui/SlidePanel';
import {
  templateCatalog,
  TEMPLATE_CATEGORIES,
  searchCatalog,
  getCatalogByCategory,
  isTemplateInsertable,
  type TemplateCategory,
  type TemplateCatalogEntry,
} from '../../lib/template-catalog';

export interface TemplateInsertPanelProps {
  open: boolean;
  onClose: () => void;
  onInsert: (dslSnippet: string) => void;
}

export function TemplateInsertPanel({ open, onClose, onInsert }: TemplateInsertPanelProps) {
  const t = useTranslations('templates');
  const [activeCategory, setActiveCategory] = useState<TemplateCategory | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredEntries = useMemo(() => {
    let entries = activeCategory === 'all' ? templateCatalog : getCatalogByCategory(activeCategory);
    if (searchQuery.trim()) {
      const searchResults = searchCatalog(searchQuery);
      entries = entries.filter((e) => searchResults.includes(e));
    }
    return entries;
  }, [activeCategory, searchQuery]);

  const handleInsert = useCallback(
    (entry: TemplateCatalogEntry) => {
      if (!isTemplateInsertable(entry)) {
        return;
      }
      onInsert(entry.dslSnippet);
      onClose();
    },
    [onInsert, onClose],
  );

  return (
    <SlidePanel open={open} onClose={onClose} title={t('insert_panel_title')} width="sm">
      {/* Search */}
      <div className="border-b border-default px-4 py-2">
        <input
          type="text"
          placeholder={t('search_placeholder')}
          aria-label={t('search_placeholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full rounded border border-default bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-border-focus focus:outline-none"
        />
      </div>

      {/* Category pills */}
      <div className="flex flex-wrap gap-1 border-b border-default px-4 py-2">
        <button
          type="button"
          onClick={() => setActiveCategory('all')}
          className={`rounded-full px-2.5 py-1 text-[10px] font-medium ${
            activeCategory === 'all'
              ? 'bg-background-active text-foreground'
              : 'text-muted hover:bg-background-hover'
          }`}
        >
          {t('category_all')}
        </button>
        {TEMPLATE_CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setActiveCategory(cat)}
            className={`rounded-full px-2.5 py-1 text-[10px] font-medium ${
              activeCategory === cat
                ? 'bg-background-active text-foreground'
                : 'text-muted hover:bg-background-hover'
            }`}
          >
            {t(`category_${cat.toLowerCase()}`)}
          </button>
        ))}
      </div>

      {/* Template list */}
      <div className="p-4">
        {filteredEntries.map((entry) => {
          const insertable = isTemplateInsertable(entry);
          const authoringStatus =
            entry.dslAuthoringMode === 'partial'
              ? t('insert_status_partial')
              : entry.dslAuthoringMode === 'preview_only'
                ? t('insert_status_preview_only')
                : t('insert_status_supported');

          return (
            <button
              key={entry.type}
              type="button"
              onClick={() => handleInsert(entry)}
              aria-label={t('select_template', { name: entry.name })}
              disabled={!insertable}
              className={`mb-2 w-full rounded-lg border p-3 text-left transition-colors ${
                insertable
                  ? 'border-default hover:border-border-hover hover:bg-background-hover'
                  : 'border-default/70 bg-background-subtle text-muted opacity-80'
              }`}
            >
              <div className="text-sm font-medium text-foreground">
                {t(`type_${entry.type}_name`)}
              </div>
              <div className="mt-0.5 text-xs text-muted">{t(`type_${entry.type}_description`)}</div>
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="inline-flex rounded bg-background-muted px-2 py-0.5 text-[10px] text-subtle">
                  {t('support_badge', {
                    surface: t('support_surface_dsl'),
                    mode: t(`support_mode_${entry.dslAuthoringMode}`),
                  })}
                </span>
              </div>
              <div className="mt-2 text-[11px] text-muted">{authoringStatus}</div>
            </button>
          );
        })}
        {filteredEntries.length === 0 && (
          <div className="py-8 text-center text-xs text-muted">{t('no_results')}</div>
        )}
      </div>
    </SlidePanel>
  );
}
