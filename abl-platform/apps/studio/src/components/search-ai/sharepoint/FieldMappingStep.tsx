'use client';

/**
 * FieldMappingStep Component
 *
 * Pre-sync field mapping wizard step for enterprise connectors.
 * Displays fields from connector-type-templates (and optional schema introspection)
 * with auto-suggested canonical mappings.
 *
 * Users can:
 * - Select which fields to sync
 * - Toggle which fields to include in embedding
 * - Override the auto-suggested canonical field mapping
 *
 * Same patterns as JsonFieldSelectionDialog but rendered as a wizard step (not a dialog).
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Search, ChevronDown, Sparkles, Info, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { sanitizeError } from '@/lib/sanitize-error';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Checkbox';
import { Badge } from '../../ui/Badge';
import {
  getConnectorFieldPreview,
  saveConnectorFieldConfig,
  type ConnectorFieldPreviewItem,
  type ConnectorFieldPreviewResponse,
  type CanonicalFieldOption,
} from '../../../api/search-ai';

// ─── Props ────────────────────────────────────────────────────────────────

interface FieldMappingStepProps {
  indexId: string;
  connectorId: string;
  onSaved: () => void;
  onBack: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fieldTypeBadgeColor(type: string): string {
  switch (type) {
    case 'string':
      return 'bg-purple/12 text-purple';
    case 'number':
      return 'bg-success/12 text-success';
    case 'boolean':
      return 'bg-warning/12 text-warning';
    case 'date':
      return 'bg-info/12 text-info';
    case 'array':
      return 'bg-info/12 text-info';
    default:
      return 'bg-background-muted text-muted';
  }
}

function confidenceBadgeStyle(confidence: number): string {
  if (confidence >= 0.8) return 'bg-success/12 text-success';
  if (confidence >= 0.5) return 'bg-warning/12 text-warning';
  return 'bg-error/12 text-error';
}

// ─── Component ────────────────────────────────────────────────────────────

export function FieldMappingStep({ indexId, connectorId, onSaved, onBack }: FieldMappingStepProps) {
  const t = useTranslations('search_ai.sharepoint');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewData, setPreviewData] = useState<ConnectorFieldPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Per-field state
  const [selections, setSelections] = useState<Record<string, boolean>>({});
  const [embeddings, setEmbeddings] = useState<Record<string, boolean>>({});
  const [mappingOverrides, setMappingOverrides] = useState<Record<string, string>>({});

  // Search/filter
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  // Load field preview on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        const data = await getConnectorFieldPreview(indexId, connectorId);
        if (cancelled) return;
        setPreviewData(data);

        // Initialize selections from existing config or auto-suggest
        const sel: Record<string, boolean> = {};
        const emb: Record<string, boolean> = {};
        const overrides: Record<string, string> = {};

        if (data.existingConfig?.fields?.length) {
          for (const f of data.existingConfig.fields) {
            sel[f.sourcePath] = f.selected;
            emb[f.sourcePath] = f.includeInEmbedding;
            if (f.canonicalMapping) overrides[f.sourcePath] = f.canonicalMapping;
          }
        } else {
          for (const f of data.fields) {
            sel[f.sourcePath] = true;
            emb[f.sourcePath] = f.suggestedForEmbedding;
          }
        }

        setSelections(sel);
        setEmbeddings(emb);
        setMappingOverrides(overrides);
      } catch (err: unknown) {
        if (!cancelled) setError(sanitizeError(err, 'Failed to load field preview'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [indexId, connectorId]);

  const canonicalFieldOptions = useMemo(
    () => previewData?.availableCanonicalFields ?? [],
    [previewData],
  );

  const getEffectiveMapping = useCallback(
    (field: ConnectorFieldPreviewItem) => {
      const override = mappingOverrides[field.sourcePath];
      if (override) {
        const option = canonicalFieldOptions.find((o) => o.value === override);
        return {
          canonicalField: override,
          confidence: 1.0,
          displayLabel: option?.label ?? override,
          reasoning: 'Manually selected',
        };
      }
      return field.suggestedMapping ?? null;
    },
    [mappingOverrides, canonicalFieldOptions],
  );

  // Filtered fields
  const filteredFields = useMemo(() => {
    if (!previewData) return [];
    return previewData.fields.filter((f) => {
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!f.sourcePath.toLowerCase().includes(q) && !f.displayName.toLowerCase().includes(q))
          return false;
      }
      if (typeFilter !== 'all' && f.fieldType !== typeFilter) return false;
      return true;
    });
  }, [previewData, searchQuery, typeFilter]);

  // Stats
  const selectedCount = useMemo(
    () => Object.values(selections).filter(Boolean).length,
    [selections],
  );
  const embeddingCount = useMemo(
    () => Object.entries(embeddings).filter(([path, val]) => val && selections[path]).length,
    [embeddings, selections],
  );
  const needsReviewCount = useMemo(() => {
    if (!previewData) return 0;
    return previewData.fields.filter((f) => {
      const m = getEffectiveMapping(f);
      return m && m.confidence < 0.8 && m.confidence >= 0.4;
    }).length;
  }, [previewData, getEffectiveMapping]);

  const toggleField = useCallback((path: string) => {
    setSelections((prev) => ({ ...prev, [path]: !prev[path] }));
  }, []);

  const toggleEmbedding = useCallback((path: string) => {
    setEmbeddings((prev) => ({ ...prev, [path]: !prev[path] }));
  }, []);

  const handleMappingChange = useCallback((path: string, value: string) => {
    setMappingOverrides((prev) => ({ ...prev, [path]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!previewData || selectedCount === 0) return;
    setSaving(true);
    try {
      const fields = previewData.fields.map((f) => {
        const effective = getEffectiveMapping(f);
        return {
          sourcePath: f.sourcePath,
          displayName: f.displayName,
          fieldType: f.fieldType,
          selected: !!selections[f.sourcePath],
          includeInEmbedding: !!embeddings[f.sourcePath] && !!selections[f.sourcePath],
          canonicalMapping: effective?.canonicalField ?? null,
          confidence: effective?.confidence ?? 0,
          mappingSource: mappingOverrides[f.sourcePath]
            ? 'user'
            : f.source === 'introspection'
              ? 'introspection'
              : effective?.confidence && effective.confidence >= 0.8
                ? 'rule'
                : effective?.confidence && effective.confidence >= 0.4
                  ? 'llm'
                  : 'fallback',
          sampleValues: f.sampleValues,
        };
      });

      await saveConnectorFieldConfig(indexId, connectorId, {
        fields,
        autoSuggestApplied: true,
      });

      toast.success(`Field mapping saved — ${selectedCount} fields selected`);
      onSaved();
    } catch (err: unknown) {
      toast.error(sanitizeError(err, 'Failed to save field config'));
    } finally {
      setSaving(false);
    }
  }, [
    previewData,
    selections,
    embeddings,
    mappingOverrides,
    getEffectiveMapping,
    selectedCount,
    indexId,
    connectorId,
    onSaved,
  ]);

  // ─── Loading / Error states ─────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <Loader2 className="w-6 h-6 text-accent animate-spin" />
        <span className="text-sm text-muted">Loading field preview...</span>
      </div>
    );
  }

  if (error || !previewData) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <span className="text-sm text-error">{error ?? 'Failed to load field preview'}</span>
        <Button variant="secondary" size="sm" onClick={onBack}>
          Back
        </Button>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {/* Info card */}
        <div className="rounded-xl border border-success/20 bg-gradient-surface-accent p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground mb-1">
            <Sparkles className="w-4 h-4 text-info" />
            Configure Field Mapping
          </div>
          <p className="text-xs text-muted leading-relaxed">
            Select which fields to sync and map them to your knowledge base schema. Fields marked
            for <strong className="text-info">embedding</strong> will be included in vector search.
            Fields mapped to <strong className="text-purple">canonical fields</strong> become
            filterable metadata. You can adjust mappings after the first sync.
          </p>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-3">
          <div className="rounded-lg border border-default bg-background-subtle p-3">
            <div className="text-lg font-bold text-purple">{previewData.fields.length}</div>
            <div className="text-[11px] text-muted">Detected Fields</div>
          </div>
          <div className="rounded-lg border border-default bg-background-subtle p-3">
            <div className="text-lg font-bold text-success">
              {
                previewData.fields.filter((f) => {
                  const m = getEffectiveMapping(f);
                  return m && m.confidence >= 0.8;
                }).length
              }
            </div>
            <div className="text-[11px] text-muted">Auto-Mapped</div>
          </div>
          <div className="rounded-lg border border-default bg-background-subtle p-3">
            <div className="text-lg font-bold text-warning">{needsReviewCount}</div>
            <div className="text-[11px] text-muted">Needs Review</div>
          </div>
          <div className="rounded-lg border border-default bg-background-subtle p-3">
            <div className="text-lg font-bold text-info">{embeddingCount}</div>
            <div className="text-[11px] text-muted">For Embedding</div>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-[260px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search fields..."
              className="w-full rounded-lg border border-default bg-background-subtle pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted outline-none focus:border-accent"
            />
          </div>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-lg border border-default bg-background-subtle px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-accent appearance-none pr-6"
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%236b7280' viewBox='0 0 16 16'%3e%3cpath d='M8 11L3 6h10z'/%3e%3c/svg%3e\")",
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 6px center',
            }}
          >
            <option value="all">All Types</option>
            <option value="string">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="boolean">Boolean</option>
            <option value="array">Array</option>
          </select>
        </div>

        {/* Field table */}
        <div className="rounded-lg border border-default overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-[28px_minmax(120px,2fr)_52px_minmax(80px,1fr)_150px_48px_48px] gap-2 px-3 py-2 bg-background-subtle border-b border-default text-[10px] font-semibold text-muted uppercase tracking-wider">
            <span></span>
            <span>Source Field</span>
            <span>Type</span>
            <span>Sample Values</span>
            <span>Map To</span>
            <span className="text-center">Match</span>
            <span className="text-center">Embed</span>
          </div>

          {/* Rows */}
          <div className="max-h-[340px] overflow-y-auto divide-y divide-default">
            {filteredFields.map((field) => {
              const selected = !!selections[field.sourcePath];
              const embed = !!embeddings[field.sourcePath];
              const mapping = getEffectiveMapping(field);
              const pct = mapping ? Math.round(mapping.confidence * 100) : 0;
              const isReview = mapping && mapping.confidence < 0.8 && mapping.confidence >= 0.4;

              return (
                <div
                  key={field.sourcePath}
                  className={clsx(
                    'grid grid-cols-[28px_minmax(120px,2fr)_52px_minmax(80px,1fr)_150px_48px_48px] gap-2 px-3 py-2.5 items-center transition-default',
                    selected
                      ? isReview
                        ? 'bg-warning/5 hover:bg-warning/8'
                        : 'hover:bg-background-subtle'
                      : 'opacity-35 hover:opacity-55',
                  )}
                >
                  {/* Select checkbox */}
                  <Checkbox checked={selected} onChange={() => toggleField(field.sourcePath)} />

                  {/* Field name */}
                  <div className="min-w-0">
                    <span className="text-sm text-foreground font-medium truncate block">
                      {field.displayName}
                    </span>
                    <span className="text-[10px] text-muted truncate block">
                      {field.sourcePath}
                    </span>
                  </div>

                  {/* Type badge */}
                  <span
                    className={clsx(
                      'inline-flex items-center justify-center text-[10px] font-semibold px-1.5 py-0.5 rounded',
                      fieldTypeBadgeColor(field.fieldType),
                    )}
                  >
                    {field.fieldType === 'string'
                      ? 'Text'
                      : field.fieldType === 'number'
                        ? 'Num'
                        : field.fieldType === 'boolean'
                          ? 'Bool'
                          : field.fieldType === 'date'
                            ? 'Date'
                            : field.fieldType}
                  </span>

                  {/* Sample values */}
                  <div className="text-[11px] text-muted truncate">
                    {field.sampleValues.length > 0
                      ? field.sampleValues.slice(0, 3).join(', ')
                      : '—'}
                  </div>

                  {/* Mapping dropdown */}
                  <div
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <MappingSelect
                      value={mapping?.canonicalField ?? ''}
                      label={mapping?.displayLabel ?? '— Not mapped —'}
                      confidence={mapping?.confidence ?? 0}
                      options={canonicalFieldOptions}
                      onChange={(val) => handleMappingChange(field.sourcePath, val)}
                      disabled={!selected}
                    />
                  </div>

                  {/* Confidence */}
                  <div className="flex justify-center">
                    {mapping ? (
                      <span
                        className={clsx(
                          'inline-flex items-center justify-center text-[10px] font-semibold px-1 py-0.5 rounded tabular-nums',
                          confidenceBadgeStyle(mapping.confidence),
                        )}
                      >
                        {pct}%
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted">—</span>
                    )}
                  </div>

                  {/* Embedding checkbox */}
                  <div className="flex justify-center">
                    <Checkbox
                      checked={selected && embed}
                      onChange={() => toggleEmbedding(field.sourcePath)}
                      disabled={!selected}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Info note */}
        <div className="flex items-start gap-2 rounded-lg bg-info/5 border border-info/20 p-3">
          <Info className="w-4 h-4 text-info shrink-0 mt-0.5" />
          <p className="text-xs text-muted leading-relaxed">
            Fields are pre-populated from connector templates. After the first sync completes, any
            additional fields discovered in the actual data will appear in the{' '}
            <strong className="text-foreground">Fields</strong> tab for review.
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-default px-6 py-3 flex items-center justify-between">
        <div className="text-xs text-muted flex items-center gap-3">
          <span>
            <strong className="text-foreground">{selectedCount}</strong> of{' '}
            {previewData.fields.length} fields
          </span>
          <span className="text-default">·</span>
          <span>
            <strong className="text-foreground">{embeddingCount}</strong> for embedding
          </span>
          {needsReviewCount > 0 && (
            <>
              <span className="text-default">·</span>
              <span className="text-warning">{needsReviewCount} need review</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onBack} disabled={saving}>
            Back
          </Button>
          <Button size="sm" onClick={handleSave} loading={saving} disabled={selectedCount === 0}>
            Save &amp; Continue
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Mapping Select (simplified dropdown) ─────────────────────────────────

function MappingSelect({
  value,
  label,
  confidence,
  options,
  onChange,
  disabled,
}: {
  value: string;
  label: string;
  confidence: number;
  options: CanonicalFieldOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isHighConfidence = confidence >= 0.8;

  const groups = useMemo(
    () => [
      { key: 'core', label: 'Core', items: options.filter((o) => o.group === 'core') },
      { key: 'common', label: 'Common', items: options.filter((o) => o.group === 'common') },
      { key: 'custom', label: 'Custom', items: options.filter((o) => o.group === 'custom') },
    ],
    [options],
  );

  const filteredGroups = useMemo(() => {
    const q = search.toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter((item) => !q || item.label.toLowerCase().includes(q)),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, search]);

  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleSelect = useCallback(
    (val: string) => {
      onChange(val);
      setIsOpen(false);
      setSearch('');
    },
    [onChange],
  );

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className={clsx(
          'flex items-center justify-between w-full rounded-md border px-2 py-1.5 text-[11px] transition-default cursor-pointer',
          disabled && 'opacity-40 pointer-events-none',
          isHighConfidence
            ? 'border-success/40 bg-success/5 text-success'
            : value
              ? 'border-default bg-background-subtle text-foreground hover:border-foreground/20'
              : 'border-default bg-background-subtle text-muted hover:border-foreground/20',
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="w-3 h-3 opacity-40 shrink-0 ml-1" />
      </button>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-52 rounded-lg border border-default bg-background-elevated shadow-xl overflow-hidden">
          <div className="p-1.5 border-b border-default">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted" />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="Search fields..."
                className="w-full bg-background-subtle border border-default rounded-md pl-6 pr-2 py-1 text-xs text-foreground placeholder:text-muted outline-none focus:border-accent"
              />
            </div>
          </div>
          <div className="max-h-[160px] overflow-y-auto py-1">
            {filteredGroups.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted text-center">No matching fields</div>
            )}
            {filteredGroups.map((group) => (
              <div key={group.key}>
                <div className="px-2.5 pt-2 pb-0.5 text-[9px] font-bold uppercase tracking-wider text-muted">
                  {group.label} ({group.items.length})
                </div>
                {group.items.map((opt) => {
                  const isActive = opt.value === value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSelect(opt.value);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className={clsx(
                        'flex items-center justify-between w-full px-2.5 py-1.5 text-[11px] transition-colors',
                        isActive
                          ? 'bg-purple/10 text-purple'
                          : 'text-foreground hover:bg-background-muted',
                      )}
                    >
                      <span>{opt.label}</span>
                      {isActive && <span className="text-purple text-[10px]">&#10003;</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
