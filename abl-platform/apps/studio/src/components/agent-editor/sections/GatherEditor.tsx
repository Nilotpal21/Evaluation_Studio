'use client';

/**
 * GatherEditor -- section editor for gather field definitions.
 *
 * Renders a list of field cards with expandable validation/extraction details,
 * plus add/remove controls. No accordion wrapper.
 */

import React, { useState, useCallback, useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import { AlertTriangle, List, Plus, X, ChevronDown, ChevronRight } from 'lucide-react';
import { Toggle } from '../../ui/Toggle';
import { Select } from '../../ui/Select';
import clsx from 'clsx';
import type { SectionEditorProps, GatherFieldData } from '../types';
import { SectionHeader } from './SectionHeader';

// =============================================================================
// CONSTANTS
// =============================================================================

const TYPE_BADGE_COLORS: Record<string, string> = {
  string: 'bg-accent/10 text-accent',
  number: 'bg-info/10 text-info',
  boolean: 'bg-warning/10 text-warning',
  date: 'bg-success/10 text-success',
  enum: 'bg-info/10 text-info',
};

const FIELD_TYPE_OPTIONS = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'boolean' },
  { value: 'date', label: 'date' },
  { value: 'enum', label: 'enum' },
] as const;

const PII_TYPE_OPTIONS = [
  { value: '', label: '(none)' },
  { value: 'email', label: 'email' },
  { value: 'phone', label: 'phone' },
  { value: 'ssn', label: 'ssn' },
  { value: 'credit_card', label: 'credit_card' },
  { value: 'address', label: 'address' },
  { value: 'name', label: 'name' },
  { value: 'custom', label: 'custom' },
] as const;

const ADVANCED_SEMANTICS_LABELS: Record<string, string> = {
  format: 'format',
  components: 'components',
  unit: 'unit',
  convert_to: 'convert_to',
  locale: 'locale',
  kore_entity_type: 'kore_entity_type',
  enum_set: 'enum_set',
};

function pruneSemantics(
  semantics: GatherFieldData['semantics'],
): GatherFieldData['semantics'] | undefined {
  if (!semantics) {
    return undefined;
  }

  const entries = Object.entries(semantics).filter(([, value]) => {
    if (value === undefined) {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return true;
  });

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries) as GatherFieldData['semantics'];
}

function formatSemanticsValue(value: string | string[]): string {
  return Array.isArray(value) ? value.join(', ') : value;
}

// =============================================================================
// FIELD GROUP
// =============================================================================

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-3 border-b border-default/50">
      <dt className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-1.5">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

// =============================================================================
// ENUM TAG INPUT
// =============================================================================

interface EnumTagInputProps {
  values: string[];
  onChange: (values: string[]) => void;
  readOnly?: boolean;
}

function EnumTagInput({ values, onChange, readOnly }: EnumTagInputProps) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const addValue = useCallback(
    (raw: string) => {
      const v = raw.trim();
      if (!v || values.includes(v)) return;
      onChange([...values, v]);
      setInputValue('');
    },
    [values, onChange],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addValue(inputValue);
      } else if (e.key === 'Backspace' && !inputValue && values.length > 0) {
        onChange(values.slice(0, -1));
      }
    },
    [inputValue, values, onChange, addValue],
  );

  const removeValue = useCallback(
    (idx: number) => {
      onChange(values.filter((_, i) => i !== idx));
    },
    [values, onChange],
  );

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 min-h-[36px] rounded-md border border-default bg-transparent px-2 py-1.5 cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {values.map((val, idx) => (
        <span
          key={idx}
          className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-accent/10 text-accent border border-accent/20 font-medium"
        >
          {val}
          {!readOnly && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeValue(idx);
              }}
              className="hover:text-error transition-fast"
              aria-label={`Remove ${val}`}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => addValue(inputValue)}
          placeholder={values.length === 0 ? 'Type a value and press Enter' : ''}
          className="flex-1 min-w-[100px] text-sm text-foreground bg-transparent placeholder:text-foreground-subtle focus:outline-none appearance-none"
        />
      )}
    </div>
  );
}

// =============================================================================
// FIELD CARD
// =============================================================================

interface FieldCardProps {
  field: GatherFieldData;
  index: number;
  onChange: (index: number, field: GatherFieldData) => void;
  onRemove: (index: number) => void;
  readOnly?: boolean;
  lookupTableNames: string[];
}

function FieldCard({
  field,
  index,
  onChange,
  onRemove,
  readOnly,
  lookupTableNames,
}: FieldCardProps) {
  const [expanded, setExpanded] = useState(false);
  const typeBadgeColor = TYPE_BADGE_COLORS[field.type] ?? 'bg-background text-foreground-muted';
  const showPiiType = field.sensitive || Boolean(field.piiType);
  const visibleSemanticsEntries = Object.entries(field.semantics ?? {}).filter(([key, value]) => {
    if (key === 'lookup') {
      return false;
    }
    if (key === 'enum_set' && field.type === 'enum') {
      return false;
    }
    if (value === undefined) {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return true;
  }) as Array<[string, string | string[]]>;

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleNameChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      onChange(index, { ...field, name: e.target.value });
    },
    [index, field, onChange],
  );

  const handleTypeChange = useCallback(
    (value: string) => {
      const nextField: GatherFieldData = { ...field, type: value };
      if (value !== 'enum' && field.semantics?.enum_set) {
        nextField.semantics = pruneSemantics({
          ...field.semantics,
          enum_set: undefined,
        });
      }
      onChange(index, nextField);
    },
    [index, field, onChange],
  );

  const handleRequiredChange = useCallback(
    (checked: boolean) => {
      onChange(index, { ...field, required: checked });
    },
    [index, field, onChange],
  );

  const handlePromptChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      onChange(index, { ...field, prompt: e.target.value });
    },
    [index, field, onChange],
  );

  const handleInferChange = useCallback(
    (checked: boolean) => {
      onChange(index, { ...field, infer: checked });
    },
    [index, field, onChange],
  );

  return (
    <div className="rounded-lg border border-default bg-background-muted overflow-hidden shadow-sm">
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={handleToggle}
          className="shrink-0 text-foreground-muted hover:text-foreground transition-fast"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>

        {/* Name */}
        {readOnly ? (
          <span className="font-mono text-sm font-medium text-foreground truncate">
            {field.name}
          </span>
        ) : (
          <input
            type="text"
            value={field.name}
            onChange={handleNameChange}
            placeholder="field_name"
            className="flex-1 font-mono text-sm font-medium text-foreground bg-transparent placeholder:text-foreground-subtle focus:outline-none min-w-0"
          />
        )}

        {/* Type badge */}
        <span
          className={clsx(
            'inline-flex items-center text-xs px-1.5 py-0.5 rounded font-medium shrink-0',
            typeBadgeColor,
          )}
        >
          {field.type}
        </span>

        {/* Required tag */}
        {field.required && (
          <span className="text-xs text-error font-semibold uppercase shrink-0">Required</span>
        )}

        {/* Sensitive badge */}
        {field.sensitive && (
          <span className="text-xs text-warning font-semibold uppercase shrink-0">Sensitive</span>
        )}

        {/* Prompt preview */}
        {!expanded && field.prompt && (
          <span className="text-xs text-foreground-muted truncate ml-1 hidden sm:inline">
            {field.prompt}
          </span>
        )}

        {/* Remove button */}
        {!readOnly && (
          <button
            type="button"
            onClick={() => onRemove(index)}
            className="ml-auto p-0.5 rounded hover:bg-error/10 hover:text-error transition-fast shrink-0"
            aria-label={`Remove field ${field.name}`}
          >
            <X className="w-3.5 h-3.5 text-foreground-muted hover:text-error" />
          </button>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-default pt-3">
          {/* Type + Required row */}
          <div className="grid grid-cols-2 gap-3">
            <FieldGroup label="Type">
              <Select
                options={FIELD_TYPE_OPTIONS as unknown as { value: string; label: string }[]}
                value={field.type}
                onChange={handleTypeChange}
                disabled={readOnly}
              />
            </FieldGroup>

            <FieldGroup label="Required">
              <Toggle
                checked={field.required}
                onChange={handleRequiredChange}
                disabled={readOnly}
                label={field.required ? 'Yes' : 'No'}
              />
            </FieldGroup>
          </div>

          {/* Prompt */}
          <FieldGroup label="Prompt">
            <textarea
              value={field.prompt}
              onChange={handlePromptChange}
              readOnly={readOnly}
              rows={2}
              placeholder="How should the agent ask for this field?"
              className="w-full text-sm text-foreground bg-transparent placeholder:text-foreground-subtle focus:outline-none resize-y"
            />
          </FieldGroup>

          {/* Enum values (tag input) */}
          {field.type === 'enum' && (
            <FieldGroup label="Enum Values">
              <EnumTagInput
                values={field.options ?? []}
                onChange={(options) =>
                  onChange(index, {
                    ...field,
                    options,
                    semantics: field.semantics?.enum_set
                      ? pruneSemantics({
                          ...field.semantics,
                          enum_set: options.length > 0 ? options : undefined,
                        })
                      : field.semantics,
                  })
                }
                readOnly={readOnly}
              />
            </FieldGroup>
          )}

          {/* Lookup table reference */}
          {field.type === 'string' && lookupTableNames.length > 0 && (
            <FieldGroup label="Lookup Table">
              <Select
                options={[
                  { value: '', label: '(none)' },
                  ...lookupTableNames.map((name) => ({ value: name, label: name })),
                ]}
                value={field.lookupTable ?? ''}
                onChange={(v) =>
                  onChange(index, {
                    ...field,
                    lookupTable: v || undefined,
                    semantics: pruneSemantics({
                      ...(field.semantics ?? {}),
                      lookup: v || undefined,
                    }),
                  })
                }
                disabled={readOnly}
              />
              <span className="text-xs text-foreground-muted">
                Manage tables in Project Settings &gt; Runtime Config
              </span>
            </FieldGroup>
          )}

          {/* Validation rules */}
          {field.validation && (
            <FieldGroup label="Validation">
              <div className="space-y-1 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-foreground-muted">Type:</span>
                  <span className="font-mono text-foreground">{field.validation.type}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-foreground-muted">Rule:</span>
                  <span className="font-mono text-foreground">{field.validation.rule}</span>
                </div>
                {field.validation.errorMessage && (
                  <div className="flex items-center gap-2">
                    <span className="text-foreground-muted">Error:</span>
                    <span className="text-foreground">{field.validation.errorMessage}</span>
                  </div>
                )}
              </div>
            </FieldGroup>
          )}

          {/* Extraction hints */}
          {field.extractionHints && field.extractionHints.length > 0 && (
            <FieldGroup label="Extraction Hints">
              <div className="flex flex-wrap gap-1.5">
                {field.extractionHints.map((hint, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-background border border-default"
                  >
                    {hint}
                  </span>
                ))}
              </div>
            </FieldGroup>
          )}

          {/* Infer toggle */}
          <FieldGroup label="Infer from Context">
            <Toggle
              checked={field.infer ?? false}
              onChange={handleInferChange}
              disabled={readOnly}
              label={field.infer ? 'Enabled' : 'Disabled'}
            />
          </FieldGroup>

          {/* Sensitive toggle */}
          <FieldGroup label="Sensitive (PII)">
            <Toggle
              checked={field.sensitive ?? false}
              onChange={(checked) => onChange(index, { ...field, sensitive: checked })}
              disabled={readOnly}
              label={field.sensitive ? 'Enabled' : 'Disabled'}
            />
          </FieldGroup>

          {showPiiType && (
            <FieldGroup label="PII Type Hint">
              <Select
                options={PII_TYPE_OPTIONS as unknown as { value: string; label: string }[]}
                value={field.piiType ?? ''}
                onChange={(value) =>
                  onChange(index, {
                    ...field,
                    piiType: (value || undefined) as GatherFieldData['piiType'],
                  })
                }
                disabled={readOnly}
              />
              <span className="text-xs text-foreground-muted">
                Helps the redactor preserve the right shape when masking sensitive values.
              </span>
            </FieldGroup>
          )}

          {/* Sensitive display mode */}
          {field.sensitive && (
            <FieldGroup label="Display Mode">
              <Select
                options={[
                  { value: 'redact', label: 'Redact ([REDACTED])' },
                  { value: 'mask', label: 'Mask (***7890)' },
                  { value: 'replace', label: 'Replace ([PHONE])' },
                ]}
                value={field.sensitiveDisplay ?? 'redact'}
                onChange={(v) =>
                  onChange(index, {
                    ...field,
                    sensitiveDisplay: v as 'redact' | 'mask' | 'replace',
                  })
                }
                disabled={readOnly}
              />
            </FieldGroup>
          )}

          {visibleSemanticsEntries.length > 0 && (
            <FieldGroup label="Advanced Semantics">
              <div className="space-y-1 text-xs">
                {visibleSemanticsEntries.map(([key, value]) => (
                  <div key={key} className="flex items-start gap-2">
                    <span className="text-foreground-muted">
                      {ADVANCED_SEMANTICS_LABELS[key] ?? key}:
                    </span>
                    <span className="font-mono text-foreground break-words">
                      {formatSemanticsValue(value)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-foreground-muted">
                Preserved on save. Edit in ABL to change advanced semantics.
              </p>
            </FieldGroup>
          )}

          {/* Mask config */}
          {field.sensitive && field.sensitiveDisplay === 'mask' && (
            <FieldGroup label="Mask Config">
              <div className="flex items-center gap-3 text-sm">
                <label className="flex items-center gap-1.5">
                  <span className="text-xs text-foreground-muted">Show first:</span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={field.maskConfig?.showFirst ?? 0}
                    onChange={(e) =>
                      onChange(index, {
                        ...field,
                        maskConfig: {
                          showFirst: parseInt(e.target.value) || 0,
                          showLast: field.maskConfig?.showLast ?? 4,
                          char: field.maskConfig?.char ?? '*',
                        },
                      })
                    }
                    disabled={readOnly}
                    className="w-14 rounded border border-default bg-transparent px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-border-focus"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="text-xs text-foreground-muted">Show last:</span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={field.maskConfig?.showLast ?? 4}
                    onChange={(e) =>
                      onChange(index, {
                        ...field,
                        maskConfig: {
                          showFirst: field.maskConfig?.showFirst ?? 0,
                          showLast: parseInt(e.target.value) || 0,
                          char: field.maskConfig?.char ?? '*',
                        },
                      })
                    }
                    disabled={readOnly}
                    className="w-14 rounded border border-default bg-transparent px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-border-focus"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="text-xs text-foreground-muted">Char:</span>
                  <input
                    type="text"
                    maxLength={1}
                    value={field.maskConfig?.char ?? '*'}
                    onChange={(e) =>
                      onChange(index, {
                        ...field,
                        maskConfig: {
                          showFirst: field.maskConfig?.showFirst ?? 0,
                          showLast: field.maskConfig?.showLast ?? 4,
                          char: e.target.value || '*',
                        },
                      })
                    }
                    disabled={readOnly}
                    className="w-10 rounded border border-default bg-transparent px-2 py-1 text-sm text-foreground text-center focus:outline-none focus:ring-1 focus:ring-border-focus"
                  />
                </label>
              </div>
            </FieldGroup>
          )}

          {/* Transient toggle */}
          {field.sensitive && (
            <FieldGroup label="Transient (auto-cleanup)">
              <Toggle
                checked={field.transient ?? false}
                onChange={(checked) => onChange(index, { ...field, transient: checked })}
                disabled={readOnly}
                label={field.transient ? 'Enabled — clears after gather completes' : 'Disabled'}
              />
            </FieldGroup>
          )}

          {/* Extraction pattern */}
          <FieldGroup label="Extraction Pattern (regex)">
            <div className="space-y-2">
              <input
                type="text"
                value={field.extractionPattern ?? ''}
                onChange={(e) =>
                  onChange(index, {
                    ...field,
                    extractionPattern: e.target.value || undefined,
                  })
                }
                readOnly={readOnly}
                placeholder="e.g. POL-\\d{6}-[A-Z]{2}"
                className="w-full font-mono text-sm text-foreground bg-transparent border border-default rounded-md px-3 py-1.5 placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus"
              />
              {field.extractionPattern && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-foreground-muted">Capture group:</span>
                  <input
                    type="number"
                    min={0}
                    max={9}
                    value={field.extractionGroup ?? 0}
                    onChange={(e) =>
                      onChange(index, {
                        ...field,
                        extractionGroup: parseInt(e.target.value) || 0,
                      })
                    }
                    disabled={readOnly}
                    className="w-14 rounded border border-default bg-transparent px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-border-focus"
                  />
                  <span className="text-xs text-foreground-muted">0 = full match</span>
                </div>
              )}
            </div>
          </FieldGroup>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function GatherEditor({
  data,
  onChange,
  readOnly,
  onArchClick,
  lookupTableNames = [],
  compatibilityWarnings = [],
  onOpenDsl,
}: SectionEditorProps<'gather'> & {
  lookupTableNames?: string[];
  compatibilityWarnings?: string[];
  onOpenDsl?: () => void;
}) {
  const fieldCount = data.length;
  const hasCompatibilityWarnings = compatibilityWarnings.length > 0;

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleFieldChange = useCallback(
    (index: number, field: GatherFieldData) => {
      const updated = [...data];
      updated[index] = field;
      onChange(updated);
    },
    [data, onChange],
  );

  const handleRemoveField = useCallback(
    (index: number) => {
      onChange(data.filter((_, i) => i !== index));
    },
    [data, onChange],
  );

  const handleAddField = useCallback(() => {
    onChange([...data, { name: '', prompt: '', type: 'string', required: false }]);
  }, [data, onChange]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="p-4 space-y-3 overflow-y-auto h-full">
      <SectionHeader onArchClick={onArchClick} />
      {hasCompatibilityWarnings && (
        <div className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-warning">
                This GATHER definition is read-only in the visual editor
              </p>
              <p className="mt-1 text-xs text-warning/90">
                Some gather metadata is not preserved by the visual editor yet. Use the ABL editor
                for gather changes until full round-trip support lands.
              </p>
              <ul className="mt-2 space-y-0.5">
                {compatibilityWarnings.slice(0, 4).map((warning) => (
                  <li key={warning} className="text-xs text-warning/80 break-words">
                    {warning}
                  </li>
                ))}
              </ul>
              {compatibilityWarnings.length > 4 && (
                <p className="mt-1 text-xs text-warning/80">
                  +{compatibilityWarnings.length - 4} more incompatible metadata entries
                </p>
              )}
              {onOpenDsl && (
                <button
                  type="button"
                  onClick={onOpenDsl}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-warning/10 px-3 py-1.5 text-xs font-medium text-warning hover:bg-warning/20 transition-default"
                >
                  Open ABL Editor
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Field count header */}
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
          {fieldCount} field{fieldCount !== 1 ? 's' : ''} defined
        </h4>
      </div>

      {/* Field list */}
      {fieldCount > 0 ? (
        <>
          <div className="space-y-2 stagger-children">
            {data.map((field, index) => (
              <FieldCard
                key={index}
                field={field}
                index={index}
                onChange={handleFieldChange}
                onRemove={handleRemoveField}
                readOnly={readOnly}
                lookupTableNames={lookupTableNames}
              />
            ))}
          </div>
          {/* Add field button */}
          {!readOnly && (
            <button
              type="button"
              onClick={handleAddField}
              className={clsx(
                'w-full flex items-center justify-center gap-2 py-2.5 rounded-lg',
                'border border-dashed border-default text-foreground-muted',
                'hover:border-accent hover:text-accent transition-fast',
                'text-sm font-medium',
              )}
            >
              <Plus className="w-4 h-4" />
              Add Field
            </button>
          )}
        </>
      ) : (
        /* Empty state */
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <List className="w-8 h-8 text-foreground-muted/40 mb-3" />
          <p className="text-sm text-foreground-muted">No fields defined</p>
          <p className="text-xs text-foreground-subtle mt-1">
            Gather fields define what information the agent collects from the user
          </p>
          {!readOnly && (
            <button
              type="button"
              onClick={handleAddField}
              className="inline-flex items-center gap-1.5 mt-4 px-3 py-1.5 rounded-md text-xs font-medium text-accent border border-accent/30 hover:bg-accent-subtle transition-default"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Field
            </button>
          )}
        </div>
      )}
    </div>
  );
}
