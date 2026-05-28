/**
 * EmbeddingFieldsDrawer — Side drawer for configuring which canonical
 * fields contribute to embedding vectors.
 *
 * 420px drawer sliding from the right. Uses mock data (no backend API
 * exists yet — Gap G-4). Save writes to local state only.
 */

'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { X, RotateCcw, AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '../../../ui/Button';
import { Badge } from '../../../ui/Badge';
import { usePipelineStore } from '../../../../store/pipeline-store';
import { CurrentlyEmbeddingSection } from './CurrentlyEmbeddingSection';
import { FieldSection } from './FieldSection';
import { FieldItem } from './FieldItem';
import type { EmbeddingField } from './FieldItem';

// =============================================================================
// MOCK DATA (Gap G-4 — no backend API)
// =============================================================================

const MOCK_CORE_FIELDS: EmbeddingField[] = [
  {
    name: 'title',
    category: 'core',
    embeddable: true,
    sources: [{ name: 'All Sources', confidence: 95, enabled: true }],
  },
  {
    name: 'description',
    category: 'core',
    embeddable: true,
    sources: [{ name: 'All Sources', confidence: 90, enabled: true }],
  },
  { name: 'author', category: 'core', embeddable: false, sources: [] },
  { name: 'created_date', category: 'core', embeddable: false, sources: [] },
  { name: 'modified_date', category: 'core', embeddable: false, sources: [] },
  { name: 'content_type', category: 'core', embeddable: false, sources: [] },
  { name: 'language', category: 'core', embeddable: false, sources: [] },
  { name: 'source_url', category: 'core', embeddable: false, sources: [] },
  { name: 'file_size', category: 'core', embeddable: false, sources: [] },
  { name: 'page_count', category: 'core', embeddable: false, sources: [] },
  { name: 'word_count', category: 'core', embeddable: false, sources: [] },
  {
    name: 'summary',
    category: 'core',
    embeddable: true,
    sources: [{ name: 'All Sources', confidence: 85, enabled: false }],
  },
];

const MOCK_COMMON_FIELDS: EmbeddingField[] = [
  { name: 'category', category: 'common', embeddable: false, sources: [] },
  {
    name: 'tags',
    category: 'common',
    embeddable: true,
    sources: [{ name: 'Salesforce', confidence: 80, enabled: true }],
  },
  { name: 'department', category: 'common', embeddable: false, sources: [] },
  {
    name: 'product',
    category: 'common',
    embeddable: true,
    sources: [{ name: 'Jira', confidence: 75, enabled: true }],
  },
  { name: 'version', category: 'common', embeddable: false, sources: [] },
  { name: 'status', category: 'common', embeddable: false, sources: [] },
  { name: 'priority', category: 'common', embeddable: false, sources: [] },
  { name: 'assignee', category: 'common', embeddable: false, sources: [] },
  { name: 'resolution', category: 'common', embeddable: false, sources: [] },
];

const MOCK_CUSTOM_FIELDS: EmbeddingField[] = [
  {
    name: 'custom_field_1',
    category: 'custom',
    embeddable: true,
    sources: [{ name: 'Custom Connector', confidence: 70, enabled: true }],
  },
  { name: 'custom_field_2', category: 'custom', embeddable: false, sources: [] },
];

function buildDefaultFields(): EmbeddingField[] {
  return [...MOCK_CORE_FIELDS, ...MOCK_COMMON_FIELDS, ...MOCK_CUSTOM_FIELDS].map((f) => ({
    ...f,
    sources: f.sources.map((s) => ({ ...s })),
  }));
}

// =============================================================================
// COMPONENT
// =============================================================================

export function EmbeddingFieldsDrawer() {
  const t = useTranslations('search_ai.pipeline');
  const activePanelType = usePipelineStore((s) => s.activePanelType);
  const closePanel = usePipelineStore((s) => s.closePanel);

  const isOpen = activePanelType === 'embedding-fields';

  // Local draft state for the fields — initialized from mock defaults
  const [fields, setFields] = useState<EmbeddingField[]>(buildDefaultFields);
  const [overrides, setOverrides] = useState<Set<string>>(new Set());

  // Snapshot of initial state for dirty detection
  const initialFieldsRef = useRef<EmbeddingField[]>(buildDefaultFields());

  // Reset local state when drawer opens
  useEffect(() => {
    if (isOpen) {
      const defaults = buildDefaultFields();
      setFields(defaults);
      setOverrides(new Set());
      initialFieldsRef.current = defaults;
    }
  }, [isOpen]);

  // Derived data
  const embeddableFields = useMemo(
    () => fields.filter((f) => f.embeddable).map((f) => ({ name: f.name, category: f.category })),
    [fields],
  );

  const coreFields = useMemo(() => fields.filter((f) => f.category === 'core'), [fields]);
  const commonFields = useMemo(() => fields.filter((f) => f.category === 'common'), [fields]);
  const customFields = useMemo(() => fields.filter((f) => f.category === 'custom'), [fields]);

  const coreSelected = useMemo(() => coreFields.filter((f) => f.embeddable).length, [coreFields]);
  const commonSelected = useMemo(
    () => commonFields.filter((f) => f.embeddable).length,
    [commonFields],
  );
  const customSelected = useMemo(
    () => customFields.filter((f) => f.embeddable).length,
    [customFields],
  );

  const isDirty = useMemo(() => {
    return JSON.stringify(fields) !== JSON.stringify(initialFieldsRef.current);
  }, [fields]);

  // Handlers
  const handleFieldToggle = useCallback((fieldName: string, embeddable: boolean) => {
    setFields((prev) => prev.map((f) => (f.name === fieldName ? { ...f, embeddable } : f)));
    setOverrides((prev) => new Set(prev).add(fieldName));
  }, []);

  const handleSourceToggle = useCallback(
    (fieldName: string, sourceName: string, enabled: boolean) => {
      setFields((prev) =>
        prev.map((f) =>
          f.name === fieldName
            ? {
                ...f,
                sources: f.sources.map((s) => (s.name === sourceName ? { ...s, enabled } : s)),
              }
            : f,
        ),
      );
      setOverrides((prev) => new Set(prev).add(fieldName));
    },
    [],
  );

  const handleRemoveField = useCallback((fieldName: string) => {
    setFields((prev) => prev.map((f) => (f.name === fieldName ? { ...f, embeddable: false } : f)));
    setOverrides((prev) => new Set(prev).add(fieldName));
  }, []);

  const handleResetAll = useCallback(() => {
    const defaults = buildDefaultFields();
    setFields(defaults);
    setOverrides(new Set());
  }, []);

  const handleSave = useCallback(() => {
    // No backend API exists (Gap G-4) — log to console for development
    // eslint-disable-next-line no-console
    console.log('[EmbeddingFieldsDrawer] Save — local state only:', {
      embeddableFields: fields.filter((f) => f.embeddable).map((f) => f.name),
      overrides: [...overrides],
    });
    closePanel();
  }, [fields, overrides, closePanel]);

  const handleCancel = useCallback(() => {
    if (isDirty) {
      // eslint-disable-next-line no-restricted-globals -- simple browser confirm for dirty discard
      const confirmed = confirm(t('v2_ef_discard_confirm'));
      if (!confirmed) return;
    }
    closePanel();
  }, [isDirty, closePanel, t]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Don't close if a dialog is open
        if (document.querySelector('[role="dialog"]')) return;
        handleCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleCancel]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-background/40"
        onClick={handleCancel}
        aria-hidden="true"
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 z-50 flex h-full w-[420px] flex-col border-l border-default bg-background shadow-lg animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-default px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{t('v2_ef_title')}</h2>
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-md p-1 hover:bg-background-muted transition-default"
            aria-label={t('v2_ef_cancel')}
          >
            <X className="h-4 w-4 text-foreground-muted" />
          </button>
        </div>

        {/* Actions bar */}
        <div className="flex items-center justify-between border-b border-default px-4 py-2">
          <Button
            variant="ghost"
            size="xs"
            icon={<RotateCcw className="h-3 w-3" />}
            onClick={handleResetAll}
          >
            {t('v2_ef_reset_all')}
          </Button>
          {overrides.size > 0 && (
            <Badge variant="accent" className="text-[10px]">
              {t('v2_ef_overrides', { count: overrides.size })}
            </Badge>
          )}
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* Currently Embedding (pinned) */}
          <CurrentlyEmbeddingSection fields={embeddableFields} onRemove={handleRemoveField} t={t} />

          {/* Available Fields divider */}
          <div className="px-4 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
              {t('v2_ef_available_fields')}
            </span>
          </div>

          {/* Core Fields */}
          <FieldSection
            title={t('v2_ef_core_fields')}
            count={{ selected: coreSelected, total: coreFields.length }}
            defaultOpen
          >
            {coreFields.map((field) => (
              <FieldItem
                key={field.name}
                field={field}
                isOverridden={overrides.has(field.name)}
                onToggle={(embeddable) => handleFieldToggle(field.name, embeddable)}
                onSourceToggle={(sourceName, enabled) =>
                  handleSourceToggle(field.name, sourceName, enabled)
                }
                t={t}
              />
            ))}
          </FieldSection>

          {/* Common Fields */}
          <FieldSection
            title={t('v2_ef_common_fields')}
            count={{ selected: commonSelected, total: commonFields.length }}
          >
            {commonFields.map((field) => (
              <FieldItem
                key={field.name}
                field={field}
                isOverridden={overrides.has(field.name)}
                onToggle={(embeddable) => handleFieldToggle(field.name, embeddable)}
                onSourceToggle={(sourceName, enabled) =>
                  handleSourceToggle(field.name, sourceName, enabled)
                }
                t={t}
              />
            ))}
          </FieldSection>

          {/* Custom Fields */}
          <FieldSection
            title={t('v2_ef_custom_fields')}
            count={{ selected: customSelected, total: customFields.length }}
          >
            {customFields.map((field) => (
              <FieldItem
                key={field.name}
                field={field}
                isOverridden={overrides.has(field.name)}
                onToggle={(embeddable) => handleFieldToggle(field.name, embeddable)}
                onSourceToggle={(sourceName, enabled) =>
                  handleSourceToggle(field.name, sourceName, enabled)
                }
                t={t}
              />
            ))}
          </FieldSection>

          {/* Info note */}
          <div className="px-4 py-3">
            <p className="text-[11px] text-foreground-muted italic">{t('v2_ef_info_note')}</p>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-default px-4 py-3 space-y-2">
          {isDirty && (
            <div className="flex items-start gap-2 rounded-md bg-warning-subtle px-3 py-2">
              <AlertTriangle className="h-3.5 w-3.5 text-warning mt-0.5 shrink-0" />
              <span className="text-[11px] text-warning">{t('v2_ef_reindex_warning')}</span>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={handleCancel}>
              {t('v2_ef_cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={handleSave} disabled={!isDirty}>
              {t('v2_ef_save')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
