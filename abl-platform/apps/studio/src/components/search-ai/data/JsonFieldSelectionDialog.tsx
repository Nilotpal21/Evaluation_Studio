/**
 * JSON Field Selection Dialog
 *
 * Shown after a JSON file upload when no field configuration exists yet.
 * All fields are shown in a single flat list (no section segregation).
 * Auto-suggest runs automatically — fields arrive pre-mapped from the backend.
 *
 * Layout per row:
 *   Field | Type | Sample Values | Field Mapping (dropdown) | Match % | Embeddings (checkbox)
 *
 * Flow: FileUploadDialog detects JSON → schema preview API → this dialog →
 *       user toggles fields → save → pending docs get processed.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Sparkles, Info, ChevronDown, Search } from 'lucide-react';
import { clsx } from 'clsx';
import { sanitizeError } from '@/lib/sanitize-error';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Checkbox';
import {
  saveJsonFieldConfig,
  type JsonFieldPreview,
  type JsonSchemaPreviewResponse,
  type CanonicalFieldOption,
} from '../../../api/search-ai';

// ─── Types ──────────────────────────────────────────────────────────────────

interface JsonFieldSelectionDialogProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  /** Schema preview data returned from the preview API */
  previewData: JsonSchemaPreviewResponse;
  /** Called after config is saved — triggers refresh / continues upload flow */
  onSaved: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Vibrant badge colors matching the approved wireframe design
function fieldTypeBadgeColor(type: string): string {
  switch (type) {
    case 'string':
      return 'bg-purple/12 text-purple'; // purple
    case 'number':
      return 'bg-success/12 text-success'; // green
    case 'boolean':
      return 'bg-warning/12 text-warning'; // yellow
    case 'date':
      return 'bg-info/12 text-info'; // blue
    case 'array':
      return 'bg-info/12 text-info'; // blue
    default:
      return 'bg-background-muted text-muted';
  }
}

function confidenceBadgeStyle(confidence: number): string {
  if (confidence >= 0.8) return 'bg-success/12 text-success'; // green
  if (confidence >= 0.5) return 'bg-warning/12 text-warning'; // yellow
  return 'bg-error/12 text-error'; // red
}

// ─── Component ──────────────────────────────────────────────────────────────

export function JsonFieldSelectionDialog({
  open,
  onClose,
  indexId,
  previewData,
  onSaved,
}: JsonFieldSelectionDialogProps) {
  const t = useTranslations('search_ai.json_field_selection');

  // Detect which fields are NEW (not in existing config)
  const newFieldPaths = useMemo(() => {
    if (!previewData.hasExistingConfig || !previewData.existingConfig) return new Set<string>();
    const existingPaths = new Set(previewData.existingConfig.fields.map((f) => f.fieldPath));
    return new Set(
      previewData.fields.filter((f) => !existingPaths.has(f.fieldPath)).map((f) => f.fieldPath),
    );
  }, [previewData]);

  const isUpdate = previewData.hasExistingConfig && newFieldPaths.size > 0;

  // All fields selected by default
  const [selections, setSelections] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    if (previewData.hasExistingConfig && previewData.existingConfig) {
      for (const f of previewData.existingConfig.fields) {
        initial[f.fieldPath] = f.selected;
      }
      for (const field of previewData.fields) {
        if (!(field.fieldPath in initial)) {
          initial[field.fieldPath] = field.suggested;
        }
      }
    } else {
      // First time — all selected by default
      for (const field of previewData.fields) {
        initial[field.fieldPath] = true;
      }
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);

  // Mapping overrides: restore user's previous choices from saved config,
  // so existing fields keep their mappings when new fields are detected.
  // Prefer canonicalMapping (final resolved), fall back to mappingOverride (manual only).
  const [mappingOverrides, setMappingOverrides] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    if (previewData.hasExistingConfig && previewData.existingConfig) {
      for (const f of previewData.existingConfig.fields) {
        const saved = f.canonicalMapping || f.mappingOverride;
        if (saved) {
          initial[f.fieldPath] = saved;
        }
      }
    }
    return initial;
  });

  const canonicalFieldOptions = useMemo(
    () => previewData.availableCanonicalFields ?? [],
    [previewData.availableCanonicalFields],
  );

  /** Get effective mapping for a field (override or original suggestion) */
  const getEffectiveMapping = useCallback(
    (field: JsonFieldPreview) => {
      const override = mappingOverrides[field.fieldPath];
      if (override) {
        const option = canonicalFieldOptions.find((o) => o.value === override);
        return {
          canonicalField: override,
          confidence: 1.0, // Manual selection = 100%
          displayLabel: option?.label ?? override,
          reasoning: 'Manually selected by user',
        };
      }
      return field.suggestedMapping ?? null;
    },
    [mappingOverrides, canonicalFieldOptions],
  );

  const handleMappingChange = useCallback((fieldPath: string, canonicalField: string) => {
    setMappingOverrides((prev) => ({ ...prev, [fieldPath]: canonicalField }));
  }, []);

  const selectedCount = useMemo(
    () => Object.values(selections).filter(Boolean).length,
    [selections],
  );

  const toggleField = useCallback((fieldPath: string) => {
    setSelections((prev) => ({ ...prev, [fieldPath]: !prev[fieldPath] }));
  }, []);

  const selectAllSuggested = useCallback(() => {
    setSelections((prev) => {
      const next = { ...prev };
      for (const field of previewData.fields) {
        next[field.fieldPath] = field.suggested;
      }
      return next;
    });
  }, [previewData.fields]);

  const handleSave = useCallback(async () => {
    if (selectedCount === 0) {
      toast.error(t('error_none_selected'));
      return;
    }

    setSaving(true);
    try {
      const fields = previewData.fields.map((f) => {
        const effective = getEffectiveMapping(f);
        return {
          fieldPath: f.fieldPath,
          fieldType: f.fieldType,
          selected: !!selections[f.fieldPath],
          sampleValues: f.sampleValues,
          maxLength: f.maxLength,
          mappingOverride: mappingOverrides[f.fieldPath] || undefined,
          // Persist the final resolved mapping (auto-suggest or manual) so
          // that on the next upload, existing fields retain their mapping.
          canonicalMapping: effective?.canonicalField || undefined,
        };
      });

      await saveJsonFieldConfig(indexId, {
        fields,
        autoSuggestApplied: true,
      });

      toast.success(t('toast_saved', { count: selectedCount }));
      onSaved();
    } catch (err: unknown) {
      toast.error(sanitizeError(err, t('error_save_failed')));
    } finally {
      setSaving(false);
    }
  }, [
    indexId,
    previewData.fields,
    selections,
    selectedCount,
    mappingOverrides,
    getEffectiveMapping,
    t,
    onSaved,
  ]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isUpdate ? t('title_update') : t('title')}
      maxWidth="4xl"
    >
      <div className="space-y-4">
        {/* Description */}
        <p className="text-sm text-muted">
          {isUpdate ? t('description_update', { count: newFieldPaths.size }) : t('description')}
        </p>

        {/* Stats bar */}
        <div className="flex items-center justify-between text-xs text-muted">
          <span>
            {t('stats', {
              total: previewData.fields.length,
              records: previewData.recordCount,
            })}
          </span>
          <button
            type="button"
            onClick={selectAllSuggested}
            className="flex items-center gap-1 text-accent hover:underline"
          >
            <Sparkles className="w-3 h-3" />
            {t('auto_suggest')}
          </button>
        </div>

        {/* Single flat field table — no section segregation */}
        <FieldTable
          fields={previewData.fields}
          selections={selections}
          onToggle={toggleField}
          newFieldPaths={newFieldPaths}
          canonicalFieldOptions={canonicalFieldOptions}
          getEffectiveMapping={getEffectiveMapping}
          onMappingChange={handleMappingChange}
        />

        {/* Info note */}
        <div className="flex items-start gap-2 rounded-lg bg-background-subtle border border-default p-3">
          <Info className="w-4 h-4 text-muted shrink-0 mt-0.5" />
          <p className="text-xs text-muted">{t('info_note')}</p>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between pt-2">
          <span className="text-sm text-muted">
            {t('selected_count', { count: selectedCount })}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
              {t('button_cancel')}
            </Button>
            <Button size="sm" onClick={handleSave} loading={saving} disabled={selectedCount === 0}>
              {t('button_save')}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ─── Field Table ────────────────────────────────────────────────────────────

function FieldTable({
  fields,
  selections,
  onToggle,
  newFieldPaths,
  canonicalFieldOptions,
  getEffectiveMapping,
  onMappingChange,
}: {
  fields: JsonFieldPreview[];
  selections: Record<string, boolean>;
  onToggle: (fieldPath: string) => void;
  newFieldPaths: Set<string>;
  canonicalFieldOptions: CanonicalFieldOption[];
  getEffectiveMapping: (field: JsonFieldPreview) => {
    canonicalField: string;
    confidence: number;
    displayLabel: string;
    reasoning: string;
  } | null;
  onMappingChange: (fieldPath: string, canonicalField: string) => void;
}) {
  const t = useTranslations('search_ai.json_field_selection');

  return (
    <div className="rounded-lg border border-default overflow-hidden">
      {/* Column headers: Field | Type | Samples | Field Mapping | Match | Embeddings */}
      <div className="grid grid-cols-[1fr_56px_1fr_160px_48px_80px] gap-2 px-4 py-2 bg-background-subtle border-b border-default text-xs font-medium text-muted uppercase tracking-wider">
        <span>{t('col_field')}</span>
        <span>{t('col_type')}</span>
        <span>{t('col_sample')}</span>
        <span>{t('col_mapping')}</span>
        <span className="text-center">{t('col_match')}</span>
        <span className="text-center">{t('col_embeddings')}</span>
      </div>
      <div className="max-h-[240px] overflow-y-auto divide-y divide-default">
        {fields.map((field) => (
          <FieldRow
            key={field.fieldPath}
            field={field}
            selected={!!selections[field.fieldPath]}
            onToggle={() => onToggle(field.fieldPath)}
            isNew={newFieldPaths.has(field.fieldPath)}
            mapping={getEffectiveMapping(field)}
            canonicalFieldOptions={canonicalFieldOptions}
            onMappingChange={(val) => onMappingChange(field.fieldPath, val)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Compact Mapping Dropdown ──────────────────────────────────────────────

function MappingDropdown({
  mapping,
  canonicalFieldOptions,
  onMappingChange,
  disabled,
}: {
  mapping: {
    canonicalField: string;
    confidence: number;
    displayLabel: string;
    reasoning: string;
  } | null;
  canonicalFieldOptions: CanonicalFieldOption[];
  onMappingChange: (value: string) => void;
  disabled?: boolean;
}) {
  const currentValue = mapping?.canonicalField ?? '';
  const displayLabel = mapping?.displayLabel ?? 'Select…';
  const isMatched = mapping != null && mapping.confidence >= 0.8;

  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Group canonical fields
  const groups = useMemo(
    () => [
      {
        key: 'core',
        label: 'Core',
        items: canonicalFieldOptions.filter((o) => o.group === 'core'),
      },
      {
        key: 'common',
        label: 'Common',
        items: canonicalFieldOptions.filter((o) => o.group === 'common'),
      },
      {
        key: 'custom',
        label: 'Custom',
        items: canonicalFieldOptions.filter((o) => o.group === 'custom'),
      },
    ],
    [canonicalFieldOptions],
  );

  // Filter items by search
  const filteredGroups = useMemo(() => {
    const q = search.toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter((item) => !q || item.label.toLowerCase().includes(q)),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, search]);

  // Close on outside click
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

  // Close on Escape
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

  // Focus search on open
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleSelect = useCallback(
    (value: string) => {
      onMappingChange(value);
      setIsOpen(false);
      setSearch('');
    },
    [onMappingChange],
  );

  return (
    <div ref={wrapperRef} className="relative">
      {/* Trigger button */}
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
          isMatched
            ? 'border-success/40 bg-success/5 text-success'
            : mapping
              ? 'border-default bg-background-subtle text-foreground hover:border-foreground/20'
              : 'border-default bg-background-subtle text-muted hover:border-foreground/20',
        )}
        title={mapping?.reasoning ?? ''}
      >
        <span className="truncate">{displayLabel}</span>
        <ChevronDown className="w-3 h-3 opacity-40 shrink-0 ml-1" />
      </button>

      {/* Floating dropdown */}
      {isOpen && (
        <div
          className={clsx(
            'absolute z-50 mt-1 w-56 rounded-lg border border-default',
            'bg-background-elevated shadow-xl overflow-hidden',
          )}
          style={{ left: 0 }}
        >
          {/* Search */}
          <div className="p-1.5 border-b border-default">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted" />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="Search fields…"
                className="w-full bg-background-subtle border border-default rounded-md pl-6 pr-2 py-1 text-xs text-foreground placeholder:text-muted outline-none focus:border-accent"
              />
            </div>
          </div>

          {/* Items — ~5 visible with scroll */}
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
                  const isActive = opt.value === currentValue;
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
                      {isActive && <span className="text-purple text-[10px]">✓</span>}
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

// ─── Field Row ──────────────────────────────────────────────────────────────

function FieldRow({
  field,
  selected,
  onToggle,
  isNew,
  mapping,
  canonicalFieldOptions,
  onMappingChange,
}: {
  field: JsonFieldPreview;
  selected: boolean;
  onToggle: () => void;
  isNew: boolean;
  mapping: {
    canonicalField: string;
    confidence: number;
    displayLabel: string;
    reasoning: string;
  } | null;
  canonicalFieldOptions: CanonicalFieldOption[];
  onMappingChange: (value: string) => void;
}) {
  const pct = mapping ? Math.round(mapping.confidence * 100) : 0;

  return (
    <div
      className={clsx(
        'grid grid-cols-[1fr_56px_1fr_160px_48px_80px] gap-2 px-4 py-2.5 items-center cursor-pointer transition-default',
        selected ? 'hover:bg-background-subtle' : 'opacity-35 hover:opacity-55',
        isNew && 'ring-1 ring-inset ring-warning/40',
      )}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      {/* Field name + hint */}
      <div className="min-w-0">
        <span className="text-sm text-foreground font-mono truncate block">
          {field.fieldPath}
          {isNew && (
            <span className="ml-2 text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-warning/10 text-warning">
              new
            </span>
          )}
        </span>
        {field.suggestReason && <span className="text-xs text-muted">{field.suggestReason}</span>}
      </div>

      {/* Type badge */}
      <span
        className={clsx(
          'inline-flex items-center justify-center text-xs font-medium px-2 py-0.5 rounded-full',
          fieldTypeBadgeColor(field.fieldType),
        )}
      >
        {field.fieldType}
      </span>

      {/* Sample values */}
      <div className="text-xs text-muted truncate">
        {field.sampleValues.length > 0 ? field.sampleValues.slice(0, 3).join(', ') : '—'}
      </div>

      {/* Mapping dropdown — stop propagation so clicking doesn't toggle checkbox */}
      <div
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <MappingDropdown
          mapping={mapping}
          canonicalFieldOptions={canonicalFieldOptions}
          onMappingChange={onMappingChange}
          disabled={!selected}
        />
      </div>

      {/* Confidence badge */}
      <div className="flex justify-center">
        {mapping ? (
          <span
            className={clsx(
              'inline-flex items-center justify-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full tabular-nums',
              confidenceBadgeStyle(mapping.confidence),
            )}
          >
            {pct}%
          </span>
        ) : (
          <span className="text-[10px] text-muted">—</span>
        )}
      </div>

      {/* Embeddings checkbox — rightmost */}
      <div className="flex justify-center" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={selected} onChange={onToggle} />
      </div>
    </div>
  );
}
