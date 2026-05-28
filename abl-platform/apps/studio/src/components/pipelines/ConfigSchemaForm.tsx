/**
 * ConfigSchemaForm Component
 *
 * Dynamic form renderer that takes a ConfigField[] array (from pipeline
 * definition configSchema) and renders the appropriate input for each field type.
 *
 * Supports: string, number, boolean, enum, string[], object[], and object fields.
 * Groups fields into basic (default) and advanced (collapsible) sections.
 * Handles showWhen conditional visibility and model dropdown for LLM fields.
 */

'use client';

import { useState, useCallback, useMemo, lazy, Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, X, ChevronRight, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import useSWR from 'swr';
import { swrFetcher } from '../../lib/swr-config';
import { Input } from '../ui/Input';

// Lazy-load ExpressionEditor to keep Monaco out of the initial bundle.
const ExpressionEditor = lazy(() =>
  import('./ExpressionEditor').then((m) => ({ default: m.ExpressionEditor })),
);
import { Select } from '../ui/Select';
import { SearchableSelect } from '../ui/SearchableSelect';
import { Toggle } from '../ui/Toggle';
import type { ConfigField, ConfigFieldOption } from '@agent-platform/pipeline-engine';
import { SchemaFieldBuilder } from './SchemaFieldBuilder';
import { useMongoCollections, useClickHouseTables } from '../../hooks/useAnalyticsQuery';
import { formatModelOptionLabel } from '../../lib/model-display';

const CUSTOM_PIPELINE_RESULTS_TABLE = 'abl_platform.custom_pipeline_results';
const CUSTOM_PIPELINE_RESULTS_COLLECTION = 'custom_pipeline_results';

// =============================================================================
// TYPES
// =============================================================================

export interface ConfigSchemaFormProps {
  fields: ConfigField[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
  projectId?: string | null;
  /** ID of the node being configured — forwarded to ExpressionEditor for upstream-node autocomplete. */
  currentNodeId?: string | null;
  onExpressionFocus?: (fieldName: string, insert: (text: string) => void) => void;
}

interface ModelOption {
  value: string;
  label: string;
}

// =============================================================================
// HELPERS
// =============================================================================

function humanizeFieldName(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getFieldLabel(field: ConfigField): string {
  return field.label || humanizeFieldName(field.name);
}

function getInfoFieldDescription(field: ConfigField): string {
  if (field.name === '__destination_clickhouse_hint') {
    return `Leave Table empty to use ${CUSTOM_PIPELINE_RESULTS_TABLE}. Enter an existing database.table only when you want this node to write to a custom ClickHouse table.`;
  }
  if (field.name === '__preview_unsupported_mongo') {
    return `Leave Collection empty to use ${CUSTOM_PIPELINE_RESULTS_COLLECTION}. Enter an existing collection name only when you want this node to write to a custom MongoDB collection. Preview is not supported because the Observability Preview tab reads from ClickHouse only.`;
  }
  return field.description;
}

function getInfoFieldIntent(field: ConfigField): NonNullable<ConfigField['intent']> {
  if (field.intent) return field.intent;
  if (field.name.includes('unsupported')) return 'warning';
  return 'info';
}

function isInfoField(field: ConfigField): boolean {
  return field.type === 'info' || field.name.startsWith('__');
}

function getFieldPlaceholder(
  field: ConfigField,
  values: Record<string, unknown>,
): string | undefined {
  if (field.placeholder) return field.placeholder;
  if (field.name === 'table' && values.destination === 'clickhouse') {
    return `Default: ${CUSTOM_PIPELINE_RESULTS_TABLE}`;
  }
  if (field.name === 'table' && values.destination === 'mongodb') {
    return `Default: ${CUSTOM_PIPELINE_RESULTS_COLLECTION}`;
  }
  if (field.default != null) return `Default: ${field.default}`;
  return undefined;
}

function getFieldDescription(field: ConfigField, values: Record<string, unknown>): string {
  if (field.name === 'table' && values.destination === 'clickhouse') {
    return `Leave empty to use ${CUSTOM_PIPELINE_RESULTS_TABLE}, or enter an existing database.table for a custom ClickHouse table.`;
  }
  if ((field.name === 'table' || field.name === 'collection') && values.destination === 'mongodb') {
    return `Leave empty to use ${CUSTOM_PIPELINE_RESULTS_COLLECTION}, or enter an existing collection name for a custom MongoDB collection.`;
  }
  return field.description;
}

/** Check if a field's showWhen condition is met */
function isFieldVisible(field: ConfigField, values: Record<string, unknown>): boolean {
  if (!field.showWhen) return true;
  const currentVal = values[field.showWhen.field];
  const expected = field.showWhen.equals;
  if (Array.isArray(expected)) {
    return expected.includes(String(currentVal));
  }
  return String(currentVal) === String(expected);
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ConfigSchemaForm({
  fields,
  values,
  onChange,
  disabled,
  projectId,
  currentNodeId,
  onExpressionFocus,
}: ConfigSchemaFormProps) {
  const t = useTranslations('pipelines');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Split fields into basic and advanced groups
  const { basicFields, advancedFields } = useMemo(() => {
    const basic: ConfigField[] = [];
    const advanced: ConfigField[] = [];
    for (const field of fields) {
      if (field.group === 'advanced') {
        advanced.push(field);
      } else {
        basic.push(field);
      }
    }
    return { basicFields: basic, advancedFields: advanced };
  }, [fields]);

  if (fields.length === 0) {
    return (
      <p className="text-sm text-muted py-4">
        {t('config_section_parameters')} — no configurable parameters.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {/* Basic fields */}
      {basicFields.map((field) => (
        <FieldRenderer
          key={field.name}
          field={field}
          values={values}
          onChange={onChange}
          disabled={disabled}
          currentNodeId={currentNodeId}
          onExpressionFocus={onExpressionFocus}
          projectId={projectId}
        />
      ))}

      {/* Advanced fields (collapsible) */}
      {advancedFields.length > 0 && (
        <div className="pt-1">
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs font-medium text-foreground-muted hover:text-foreground transition-colors w-full"
            onClick={() => setAdvancedOpen(!advancedOpen)}
          >
            <ChevronRight
              className={clsx(
                'w-3.5 h-3.5 transition-transform duration-150',
                advancedOpen && 'rotate-90',
              )}
            />
            Advanced ({advancedFields.length})
          </button>

          {advancedOpen && (
            <div className="mt-3 space-y-5">
              {advancedFields.map((field) => (
                <FieldRenderer
                  key={field.name}
                  field={field}
                  values={values}
                  onChange={onChange}
                  disabled={disabled}
                  currentNodeId={currentNodeId}
                  onExpressionFocus={onExpressionFocus}
                  projectId={projectId}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// FIELD RENDERER
// =============================================================================

interface FieldRendererProps {
  field: ConfigField;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
  currentNodeId?: string | null;
  onExpressionFocus?: (fieldName: string, insert: (text: string) => void) => void;
  projectId?: string | null;
}

function FieldRenderer({
  field,
  values,
  onChange,
  disabled,
  currentNodeId,
  onExpressionFocus,
  projectId,
}: FieldRendererProps) {
  const currentValue = values[field.name] ?? field.default;
  const label = getFieldLabel(field);

  // Check showWhen visibility
  if (!isFieldVisible(field, values)) {
    return null;
  }

  // ── Info → non-interactive inline banner ──
  if (isInfoField(field)) {
    const intent = getInfoFieldIntent(field);
    const styles: Record<string, string> = {
      info: 'bg-info-subtle border-l-2 border-info text-foreground',
      warning: 'bg-warning-subtle border-l-2 border-warning text-foreground',
      success: 'bg-success-subtle border-l-2 border-success text-foreground',
      error: 'bg-error-subtle border-l-2 border-error text-foreground',
    };
    return (
      <div className={clsx('px-3 py-2 rounded-sm text-xs', styles[intent])} role="note">
        {getInfoFieldDescription(field)}
      </div>
    );
  }

  // ── Boolean → Toggle ──
  if (field.type === 'boolean') {
    return (
      <div key={field.name} className="space-y-1">
        <Toggle
          checked={Boolean(currentValue)}
          onChange={(checked) => onChange(field.name, checked)}
          label={label + (field.required ? ' *' : '')}
          description={getFieldDescription(field, values)}
          disabled={disabled}
        />
      </div>
    );
  }

  // Enum with pre-resolved inline options (e.g. metric-tables / metric-columns).
  // The schema endpoint expands these server-side so no extra fetch is needed.
  // Each option carries a description rendered as a subscript under the
  // dropdown so non-technical users can tell options apart.
  if (field.type === 'enum' && (field.options || field.optionsByDependency)) {
    const dep = field.optionsByDependency;
    const parentValue = dep ? String(values[dep.field] ?? '') : '';
    const resolvedOptions: ConfigFieldOption[] = dep
      ? (dep.options[parentValue] ?? [])
      : (field.options ?? []);

    const selectedValue = String(currentValue ?? '');
    let subscript = getFieldDescription(field, values);
    for (const opt of resolvedOptions) {
      if (opt.value === selectedValue && opt.description) {
        subscript = opt.description;
        break;
      }
    }

    return (
      <FieldWrapper label={label} description={subscript} required={field.required}>
        <Select
          options={resolvedOptions.map((o) => ({ value: o.value, label: o.label }))}
          value={selectedValue}
          onChange={(v) => {
            onChange(field.name, v);
            if (field.resetFields) {
              for (const f of field.resetFields) {
                onChange(f, undefined);
              }
            }
          }}
          disabled={disabled || resolvedOptions.length === 0}
          placeholder={
            dep && resolvedOptions.length === 0
              ? `Select ${humanizeFieldName(dep.field).toLowerCase()} first`
              : 'Select...'
          }
        />
      </FieldWrapper>
    );
  }

  // MongoDB collection picker - matches by dynamicOptions OR by field name
  //    (name-based fallback works even when dynamicOptions is absent from older
  //    MongoDB-stored node definitions that predate the field being added to
  //    the Mongoose schema)
  if (
    field.type === 'enum' &&
    (field.dynamicOptions === 'mongo-collections' ||
      (field.name === 'collection' && String(values.database ?? '') === 'mongodb'))
  ) {
    return (
      <DynamicMongoCollectionSelect
        field={field}
        currentValue={currentValue}
        onChange={onChange}
        disabled={disabled}
        values={values}
        projectId={projectId}
      />
    );
  }

  // ── ClickHouse table picker — matches by dynamicOptions OR by field name
  if (
    field.type === 'enum' &&
    (field.dynamicOptions === 'clickhouse-tables' ||
      (field.name === 'table' && String(values.database ?? '') === 'clickhouse'))
  ) {
    return (
      <DynamicClickHouseTableSelect
        field={field}
        currentValue={currentValue}
        onChange={onChange}
        disabled={disabled}
        values={values}
        projectId={projectId}
      />
    );
  }

  // ── Enum → Select dropdown ──
  if (field.type === 'enum' && field.values) {
    const options = field.values.map((v) => ({
      value: v,
      label: v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    }));
    const handleEnumChange = (v: string) => {
      onChange(field.name, v);
      // Clear dependent fields when this value changes (e.g. database switch clears query/table/collection)
      if (field.resetFields) {
        for (const f of field.resetFields) {
          onChange(f, undefined);
        }
      }
      // Special case: when database changes to mongodb, pre-fill query with `{}` since
      // collection auto-fill needs server response. ClickHouse query waits until the
      // table is selected (then auto-fill from DynamicClickHouseTableSelect fires).
      if (field.name === 'database' && v === 'mongodb') {
        onChange('query', '{}');
      }
    };
    return (
      <FieldWrapper
        label={label}
        description={getFieldDescription(field, values)}
        required={field.required}
      >
        <Select
          options={options}
          value={String(currentValue ?? '')}
          onChange={handleEnumChange}
          disabled={disabled}
        />
      </FieldWrapper>
    );
  }

  // ── Number → number Input ──
  if (field.type === 'number') {
    return (
      <FieldWrapper
        label={label}
        description={getFieldDescription(field, values)}
        required={field.required}
      >
        <Input
          type="number"
          value={currentValue != null ? String(currentValue) : ''}
          onChange={(e) => {
            const raw = e.target.value;
            onChange(field.name, raw === '' ? undefined : Number(raw));
          }}
          min={field.validation?.min}
          max={field.validation?.max}
          step={field.validation?.max != null && field.validation.max <= 1 ? 0.01 : 1}
          disabled={disabled}
          placeholder={getFieldPlaceholder(field, values)}
        />
      </FieldWrapper>
    );
  }

  // ── String: special-case "model" → searchable dropdown ──
  if (field.type === 'string' && field.name === 'model') {
    return (
      <FieldWrapper
        label={label}
        description={getFieldDescription(field, values)}
        required={field.required}
      >
        <ModelSelect
          value={String(currentValue ?? '')}
          onChange={(val) => onChange(field.name, val || undefined)}
          disabled={disabled}
        />
      </FieldWrapper>
    );
  }

  // ── String: multiline + expressionAware → ExpressionEditor (Monaco) ──
  if (field.type === 'string' && field.multiline && field.expressionAware) {
    return (
      <FieldWrapper
        label={label}
        description={getFieldDescription(field, values)}
        required={field.required}
      >
        <Suspense
          fallback={
            <div className="h-[176px] rounded-md border border-input bg-background-muted animate-pulse" />
          }
        >
          <ExpressionEditor
            value={String(currentValue ?? '')}
            onChange={(val: string) => onChange(field.name, val)}
            disabled={disabled}
            currentNodeId={currentNodeId ?? undefined}
            rows={8}
            onFocus={(insert) => onExpressionFocus?.(field.name, insert)}
          />
        </Suspense>
        <SuggestionChips field={field} onChange={onChange} disabled={disabled} values={values} />
      </FieldWrapper>
    );
  }

  // ── String: multiline → textarea ──
  if (field.type === 'string' && field.multiline) {
    return (
      <FieldWrapper
        label={label}
        description={getFieldDescription(field, values)}
        required={field.required}
      >
        <textarea
          className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          value={String(currentValue ?? '')}
          onChange={(e) => onChange(field.name, e.target.value)}
          disabled={disabled}
          rows={6}
          placeholder={getFieldPlaceholder(field, values)}
        />
        <SuggestionChips field={field} onChange={onChange} disabled={disabled} values={values} />
      </FieldWrapper>
    );
  }

  // ── String → text Input ──
  if (field.type === 'string') {
    return (
      <FieldWrapper
        label={label}
        description={getFieldDescription(field, values)}
        required={field.required}
      >
        <Input
          type="text"
          value={String(currentValue ?? '')}
          onChange={(e) => onChange(field.name, e.target.value)}
          disabled={disabled}
          placeholder={getFieldPlaceholder(field, values)}
        />
        <SuggestionChips field={field} onChange={onChange} disabled={disabled} values={values} />
      </FieldWrapper>
    );
  }

  // ── string[] → tag list editor (with optional predefined values) ──
  if (field.type === 'string[]' || (field.type === 'array' && !field.items)) {
    const items = Array.isArray(currentValue) ? (currentValue as string[]) : [];
    return (
      <FieldWrapper
        label={label}
        description={getFieldDescription(field, values)}
        required={field.required}
      >
        <StringArrayEditor
          items={items}
          onChange={(newItems) => onChange(field.name, newItems)}
          disabled={disabled}
          placeholder={field.placeholder}
          allowedValues={field.values}
        />
      </FieldWrapper>
    );
  }

  // ── object[] with itemSchema → structured list editor ──
  if (
    field.type === 'object[]' ||
    (field.type === 'array' && field.items && 'properties' in field.items)
  ) {
    const items = Array.isArray(currentValue) ? (currentValue as Record<string, unknown>[]) : [];
    const properties =
      field.items && 'properties' in field.items ? field.items.properties : undefined;
    return (
      <FieldWrapper
        label={label}
        description={getFieldDescription(field, values)}
        required={field.required}
      >
        <ObjectArrayEditor
          items={items}
          onChange={(newItems) => onChange(field.name, newItems)}
          properties={properties}
          disabled={disabled}
        />
      </FieldWrapper>
    );
  }

  // ── outputSchema → Schema field builder ──
  if (field.type === 'object' && field.name === 'outputSchema') {
    return (
      <FieldWrapper
        label={label}
        description={getFieldDescription(field, values)}
        required={field.required}
      >
        <SchemaFieldBuilder value={currentValue} onChange={onChange} disabled={disabled} />
      </FieldWrapper>
    );
  }

  // ── Object → JSON editor ──
  if (field.type === 'object') {
    return (
      <FieldWrapper
        label={label}
        description={getFieldDescription(field, values)}
        required={field.required}
      >
        <JsonEditor
          value={currentValue}
          onChange={(val) => onChange(field.name, val)}
          disabled={disabled}
        />
      </FieldWrapper>
    );
  }

  return null;
}

// =============================================================================
// FIELD WRAPPER
// =============================================================================

interface FieldWrapperProps {
  label: string;
  description: string;
  required: boolean;
  children: React.ReactNode;
}

function FieldWrapper({ label, description, required, children }: FieldWrapperProps) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-foreground">
        {label}
        {required && <span className="text-error ml-0.5">*</span>}
      </label>
      {children}
      {description && <p className="text-xs text-muted">{description}</p>}
    </div>
  );
}

// =============================================================================
// MODEL SELECT
// =============================================================================

interface ModelSelectProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

function ModelSelect({ value, onChange, disabled }: ModelSelectProps) {
  // Always fetch tenant-level models — the single source of truth for LLM configs
  const { data: tenantModelsData } = useSWR<{
    models: Array<{
      id: string;
      modelId: string;
      displayName: string;
      provider: string;
      isActive: boolean;
    }>;
  }>('/api/tenant-models', swrFetcher);

  const activeModels = useMemo(
    () => (tenantModelsData?.models ?? []).filter((m) => m.isActive),
    [tenantModelsData],
  );

  // Options use tenant model id (unique) as value to avoid duplicate keys
  // when multiple configs share the same modelId
  const options = useMemo<ModelOption[]>(
    () =>
      activeModels.map((m) => ({
        value: m.id,
        label: formatModelOptionLabel(m),
      })),
    [activeModels],
  );

  // Map saved modelId to the tenant model id for the dropdown selection
  const selectedId = useMemo(() => {
    if (!value) return '';
    const match = activeModels.find((m) => m.modelId === value);
    return match?.id ?? '';
  }, [value, activeModels]);

  // Map tenant model id back to modelId when user selects
  const handleChange = useCallback(
    (id: string) => {
      const match = activeModels.find((m) => m.id === id);
      onChange(match?.modelId ?? id);
    },
    [activeModels, onChange],
  );

  if (options.length === 0) {
    return (
      <Input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="e.g. claude-sonnet-4-20250514"
      />
    );
  }

  return (
    <SearchableSelect
      options={options}
      value={selectedId}
      onChange={handleChange}
      disabled={disabled}
      placeholder="Select model..."
    />
  );
}

// =============================================================================
// STRING ARRAY EDITOR
// =============================================================================

interface StringArrayEditorProps {
  items: string[];
  onChange: (items: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  /** When provided, show a dropdown of allowed values instead of free-text input */
  allowedValues?: string[];
}

function StringArrayEditor({
  items,
  onChange,
  disabled,
  placeholder,
  allowedValues,
}: StringArrayEditorProps) {
  const [draft, setDraft] = useState('');

  const addItem = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed || items.includes(trimmed)) return;
    onChange([...items, trimmed]);
    setDraft('');
  }, [draft, items, onChange]);

  const removeItem = useCallback(
    (index: number) => {
      onChange(items.filter((_, i) => i !== index));
    },
    [items, onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addItem();
      }
    },
    [addItem],
  );

  // Available options not yet selected
  const availableOptions = useMemo(
    () => (allowedValues ? allowedValues.filter((v) => !items.includes(v)) : []),
    [allowedValues, items],
  );

  return (
    <div className="space-y-2">
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <span
              key={`${item}-${i}`}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-background-muted text-foreground border border-default"
            >
              {item}
              {!disabled && (
                <button
                  type="button"
                  className="p-0 text-muted hover:text-foreground transition-colors"
                  onClick={() => removeItem(i)}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {!disabled &&
        (allowedValues && allowedValues.length > 0 ? (
          // Dropdown mode: select from predefined values
          availableOptions.length > 0 && (
            <div className="flex gap-1.5">
              <Select
                options={availableOptions.map((v) => ({ value: v, label: v }))}
                value={undefined}
                placeholder={placeholder || 'Select...'}
                onChange={(v) => {
                  if (v) {
                    onChange([...items, v]);
                  }
                }}
                className="flex-1 !text-xs"
              />
            </div>
          )
        ) : (
          // Free-text mode
          <div className="flex gap-1.5">
            <Input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder || 'Type and press Enter'}
              className="flex-1 !text-xs"
            />
            <button
              type="button"
              className="shrink-0 p-1.5 rounded-md border border-default bg-background-elevated text-foreground-muted hover:text-foreground hover:bg-background-muted transition-colors"
              onClick={addItem}
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
    </div>
  );
}

// =============================================================================
// OBJECT ARRAY EDITOR (e.g., taxonomy: [{category, intents}])
// =============================================================================

interface ObjectArrayEditorProps {
  items: Record<string, unknown>[];
  onChange: (items: Record<string, unknown>[]) => void;
  properties?: Record<string, ConfigField>;
  disabled?: boolean;
}

function getObjectProperties(field: ConfigField): Record<string, ConfigField> | undefined {
  if (field.type !== 'object' || !field.items || !('properties' in field.items)) return undefined;
  return field.items.properties as Record<string, ConfigField>;
}

function getDefaultConfigValue(key: string, field: ConfigField): unknown {
  if (field.default != null) return field.default;
  if (field.type === 'string[]' || field.type === 'array') return [];

  const objectProperties = getObjectProperties(field);
  if (objectProperties) {
    const defaults: Record<string, unknown> = {};
    for (const [nestedKey, nestedField] of Object.entries(objectProperties)) {
      if (nestedField.default != null) {
        defaults[nestedKey] = nestedField.default;
      } else if (key === 'scale' && nestedKey === 'min') {
        defaults[nestedKey] = 1;
      } else if (key === 'scale' && nestedKey === 'max') {
        defaults[nestedKey] = 5;
      } else {
        defaults[nestedKey] = nestedField.type === 'number' ? undefined : '';
      }
    }
    return defaults;
  }

  return '';
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScaleObject(value: unknown): Record<string, unknown> {
  if (isRecordValue(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return { min: 1, max: value };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const range = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/);
    if (range) {
      return {
        min: Number(range[1]),
        max: Number(range[2]),
      };
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return { min: 1, max: numeric };
  }
  return {};
}

function ObjectArrayEditor({ items, onChange, properties, disabled }: ObjectArrayEditorProps) {
  const propEntries = useMemo(() => {
    if (!properties) return [];
    return Object.entries(properties);
  }, [properties]);

  const addItem = useCallback(() => {
    const newItem: Record<string, unknown> = {};
    for (const [key, fieldDef] of propEntries) {
      newItem[key] = getDefaultConfigValue(key, fieldDef);
    }
    onChange([...items, newItem]);
  }, [items, onChange, propEntries]);

  const removeItem = useCallback(
    (index: number) => {
      onChange(items.filter((_, i) => i !== index));
    },
    [items, onChange],
  );

  const updateItem = useCallback(
    (index: number, key: string, value: unknown) => {
      const updated = items.map((item, i) => (i === index ? { ...item, [key]: value } : item));
      onChange(updated);
    },
    [items, onChange],
  );

  // If no properties defined, fall back to JSON editor
  if (propEntries.length === 0) {
    return (
      <JsonEditor
        value={items}
        onChange={(val) => onChange(Array.isArray(val) ? val : [])}
        disabled={disabled}
      />
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div
          key={i}
          className="rounded-lg border border-default bg-background-elevated/50 p-3 space-y-2.5"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground-muted uppercase tracking-wider">
              #{i + 1}
            </span>
            {!disabled && (
              <button
                type="button"
                className="p-0.5 text-muted hover:text-error transition-colors"
                onClick={() => removeItem(i)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {propEntries.map(([key, fieldDef]) => {
            const fieldLabel = fieldDef.label || humanizeFieldName(key);
            const fieldValue = item[key];

            // Nested object[] sub-field → recursive ObjectArrayEditor
            if (fieldDef.type === 'array' && fieldDef.items && 'properties' in fieldDef.items) {
              const nestedItems = Array.isArray(fieldValue)
                ? (fieldValue as Record<string, unknown>[])
                : [];
              return (
                <div key={key} className="space-y-1">
                  <label className="block text-xs font-medium text-foreground">
                    {fieldLabel}
                    {fieldDef.required && <span className="text-error ml-0.5">*</span>}
                  </label>
                  <ObjectArrayEditor
                    items={nestedItems}
                    onChange={(newArr) => updateItem(i, key, newArr)}
                    properties={fieldDef.items.properties as Record<string, ConfigField>}
                    disabled={disabled}
                  />
                </div>
              );
            }

            // string[] sub-field → inline tag editor
            if (fieldDef.type === 'string[]' || fieldDef.type === 'array') {
              const arrVal = Array.isArray(fieldValue) ? (fieldValue as string[]) : [];
              return (
                <div key={key} className="space-y-1">
                  <label className="block text-xs font-medium text-foreground">
                    {fieldLabel}
                    {fieldDef.required && <span className="text-error ml-0.5">*</span>}
                  </label>
                  <StringArrayEditor
                    items={arrVal}
                    onChange={(newArr) => updateItem(i, key, newArr)}
                    disabled={disabled}
                    placeholder={fieldDef.placeholder}
                  />
                </div>
              );
            }

            const objectProperties = getObjectProperties(fieldDef);
            if (objectProperties) {
              const objectValue =
                key === 'scale'
                  ? parseScaleObject(fieldValue)
                  : isRecordValue(fieldValue)
                    ? fieldValue
                    : {};
              return (
                <div key={key} className="space-y-2">
                  <label className="block text-xs font-medium text-foreground">
                    {fieldLabel}
                    {fieldDef.required && <span className="text-error ml-0.5">*</span>}
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-md border border-default bg-background/40 p-2">
                    {Object.entries(objectProperties).map(([nestedKey, nestedField]) => {
                      const nestedLabel = nestedField.label || humanizeFieldName(nestedKey);
                      const nestedValue =
                        objectValue[nestedKey] ??
                        getDefaultConfigValue(nestedKey, nestedField) ??
                        '';

                      return (
                        <div key={nestedKey} className="space-y-1">
                          <label className="block text-[11px] font-medium text-foreground-muted">
                            {nestedLabel}
                            {nestedField.required && <span className="text-error ml-0.5">*</span>}
                          </label>
                          <Input
                            type={nestedField.type === 'number' ? 'number' : 'text'}
                            value={nestedValue != null ? String(nestedValue) : ''}
                            onChange={(e) => {
                              const raw = e.target.value;
                              updateItem(i, key, {
                                ...objectValue,
                                [nestedKey]:
                                  nestedField.type === 'number'
                                    ? raw === ''
                                      ? undefined
                                      : Number(raw)
                                    : raw,
                              });
                            }}
                            min={nestedField.validation?.min}
                            max={nestedField.validation?.max}
                            step={
                              nestedField.validation?.max != null && nestedField.validation.max <= 1
                                ? 0.01
                                : 1
                            }
                            disabled={disabled}
                            placeholder={nestedField.placeholder}
                            className="!text-xs"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            }

            // Default: string input
            return (
              <div key={key} className="space-y-1">
                <label className="block text-xs font-medium text-foreground">
                  {fieldLabel}
                  {fieldDef.required && <span className="text-error ml-0.5">*</span>}
                </label>
                <Input
                  type="text"
                  value={String(fieldValue ?? '')}
                  onChange={(e) => updateItem(i, key, e.target.value)}
                  disabled={disabled}
                  placeholder={fieldDef.placeholder}
                  className="!text-xs"
                />
              </div>
            );
          })}
        </div>
      ))}

      {!disabled && (
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs font-medium text-info hover:text-info/80 transition-colors"
          onClick={addItem}
        >
          <Plus className="w-3.5 h-3.5" />
          Add entry
        </button>
      )}
    </div>
  );
}

// =============================================================================
// DYNAMIC MONGO COLLECTION SELECT
// =============================================================================

interface DynamicMongoCollectionSelectProps {
  field: ConfigField;
  currentValue: unknown;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
  values: Record<string, unknown>;
  projectId?: string | null;
}

function DynamicMongoCollectionSelect({
  field,
  currentValue,
  onChange,
  disabled,
  values,
  projectId,
}: DynamicMongoCollectionSelectProps) {
  const label = getFieldLabel(field);
  const { collections, isLoading } = useMongoCollections(projectId ?? null);

  // Fall back to static values from seed data if server returns nothing
  const staticFallback = (field.values ?? []).map((v) => ({ value: v, label: v }));
  const dynamicOptions = collections.map((c) => ({ value: c.name, label: c.name }));
  const options = dynamicOptions.length > 0 ? dynamicOptions : staticFallback;

  const handleChange = (v: string) => {
    onChange(field.name, v);
    // Auto-fill the query field when collection changes, if it is empty or
    // still matches a known default (i.e. the user hasn't customised it yet).
    const currentQuery = String(values.query ?? '');
    const knownDefaults = collections.map((c) => c.defaultQuery).filter(Boolean);
    if (!currentQuery || knownDefaults.includes(currentQuery)) {
      const selected = collections.find((c) => c.name === v);
      if (selected?.defaultQuery) {
        onChange('query', selected.defaultQuery);
      }
    }
  };

  return (
    <FieldWrapper
      label={label}
      description={getFieldDescription(field, values)}
      required={field.required}
    >
      <Select
        options={options}
        value={String(currentValue ?? '')}
        onChange={handleChange}
        disabled={disabled || isLoading}
        placeholder={isLoading ? 'Loading collections…' : 'Select a collection'}
      />
    </FieldWrapper>
  );
}

// =============================================================================
// DYNAMIC CLICKHOUSE TABLE SELECT
// =============================================================================

interface DynamicClickHouseTableSelectProps {
  field: ConfigField;
  currentValue: unknown;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
  values: Record<string, unknown>;
  projectId?: string | null;
}

function DynamicClickHouseTableSelect({
  field,
  currentValue,
  onChange,
  disabled,
  values,
  projectId,
}: DynamicClickHouseTableSelectProps) {
  const label = getFieldLabel(field);
  const { tables, isLoading } = useClickHouseTables(projectId ?? null);

  // Fall back to static values from seed data if server returns nothing
  const staticFallback = (field.values ?? []).map((v) => ({ value: v, label: v }));
  const dynamicOptions = tables.map((t) => ({ value: t.name, label: t.name }));
  const options = dynamicOptions.length > 0 ? dynamicOptions : staticFallback;

  const handleChange = (v: string) => {
    onChange(field.name, v);
    // Auto-fill the query field when table changes, if it is empty or
    // still matches a known default (i.e. the user hasn't customised it yet).
    const currentQuery = String(values.query ?? '');
    const knownDefaults = tables.map((t) => t.defaultQuery).filter(Boolean);
    if (!currentQuery || knownDefaults.includes(currentQuery)) {
      const selected = tables.find((t) => t.name === v);
      if (selected?.defaultQuery) {
        onChange('query', selected.defaultQuery);
      }
    }
  };

  return (
    <FieldWrapper
      label={label}
      description={getFieldDescription(field, values)}
      required={field.required}
    >
      <Select
        options={options}
        value={String(currentValue ?? '')}
        onChange={handleChange}
        disabled={disabled || isLoading}
        placeholder={isLoading ? 'Loading tables…' : 'Select a table'}
      />
    </FieldWrapper>
  );
}

// =============================================================================
// JSON EDITOR
// =============================================================================

interface JsonEditorProps {
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}

function JsonEditor({ value, onChange, disabled }: JsonEditorProps) {
  const [text, setText] = useState(() => {
    if (value == null) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  });
  const [error, setError] = useState<string | null>(null);

  const handleBlur = useCallback(() => {
    if (!text.trim()) {
      setError(null);
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      setError(null);
      onChange(parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  }, [text, onChange]);

  return (
    <div className="space-y-1">
      <textarea
        className="w-full rounded-lg border border-default bg-background-elevated px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-border-focus resize-y min-h-[80px]"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleBlur}
        disabled={disabled}
        placeholder="Enter JSON..."
        rows={4}
      />
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}

// =============================================================================
// SUGGESTION CHIPS
// =============================================================================

interface SuggestionChipsProps {
  field: ConfigField;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
  values: Record<string, unknown>;
}

function SuggestionChips({ field, onChange, disabled, values }: SuggestionChipsProps) {
  if (!field.suggestions || field.suggestions.length === 0) return null;
  const visible = field.suggestions.filter((s) => {
    if (!s.showWhen) return true;
    const actual = String(values[s.showWhen.field] ?? '');
    const expected = s.showWhen.equals;
    return Array.isArray(expected) ? expected.includes(actual) : actual === String(expected);
  });
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {visible.map((s, i) => (
        <button
          key={`${i}-${s.label}`}
          type="button"
          disabled={disabled}
          onClick={() => onChange(field.name, s.value)}
          className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-background-muted border border-default text-foreground-muted hover:text-foreground hover:bg-background-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
