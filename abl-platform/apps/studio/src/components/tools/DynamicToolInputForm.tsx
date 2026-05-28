/**
 * DynamicToolInputForm Component
 *
 * Auto-generates form inputs from JSON Schema for tool testing.
 * Supports: string, number, integer, boolean, enum, object, array types.
 * Provides validation and user-friendly UX.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2, Copy, Check } from 'lucide-react';
import { Select } from '../ui/Select';
import { Checkbox } from '../ui/Checkbox';

interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

interface JsonSchemaProperty {
  type: string | string[];
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

interface DynamicToolInputFormProps {
  schema: JsonSchema;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  onCopySchema?: () => void;
}

export function DynamicToolInputForm({
  schema,
  values,
  onChange,
  onCopySchema,
}: DynamicToolInputFormProps) {
  const t = useTranslations('tools.dynamic_form');
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (onCopySchema) {
      onCopySchema();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return <div className="text-center py-6 text-sm text-muted">{t('no_parameters')}</div>;
  }

  const requiredFields = new Set(schema.required || []);

  return (
    <div className="space-y-4">
      {/* Header with Copy Schema button */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted uppercase tracking-wide">
          {t('tool_inputs_label')}
        </span>
        {onCopySchema && (
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted hover:text-foreground transition-default rounded hover:bg-background-muted"
            title={t('copy_schema')}
          >
            {copied ? (
              <>
                <Check className="w-3 h-3" />
                {t('copied')}
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                {t('copy_schema')}
              </>
            )}
          </button>
        )}
      </div>

      {/* Dynamic form fields */}
      {Object.entries(schema.properties).map(([fieldName, fieldSchema]) => (
        <SchemaField
          key={fieldName}
          name={fieldName}
          schema={fieldSchema}
          value={values[fieldName]}
          required={requiredFields.has(fieldName)}
          onChange={(value) => onChange({ ...values, [fieldName]: value })}
        />
      ))}
    </div>
  );
}

// =============================================================================
// Schema Field - Recursive field renderer
// =============================================================================

interface SchemaFieldProps {
  name: string;
  schema: JsonSchemaProperty;
  value: unknown;
  required: boolean;
  onChange: (value: unknown) => void;
  path?: string;
}

type NumericSchemaType = 'number' | 'integer';

function formatNumericInputValue(
  value: unknown,
  defaultValue: unknown,
  includeDefaultWhenUnset: boolean,
): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  if (!includeDefaultWhenUnset) {
    return '';
  }

  if (typeof defaultValue === 'number' && Number.isFinite(defaultValue)) {
    return String(defaultValue);
  }

  return '';
}

function parseNumericDraft(rawValue: string, numericType: NumericSchemaType): number | null {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return null;
  }

  if (numericType === 'integer') {
    if (!/^-?\d+$/.test(trimmed)) {
      return null;
    }

    const parsed = Number.parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  if (!/^-?(?:\d+|\d*\.\d+|\d+\.)$/.test(trimmed)) {
    return null;
  }

  const parsed = Number.parseFloat(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

interface NumericSchemaFieldProps {
  name: string;
  schema: JsonSchemaProperty;
  value: unknown;
  required: boolean;
  onChange: (value: unknown) => void;
  fieldPath: string;
}

function NumericSchemaField({
  name,
  schema,
  value,
  required,
  onChange,
  fieldPath,
}: NumericSchemaFieldProps) {
  const t = useTranslations('tools.dynamic_form');
  const numericType = (
    Array.isArray(schema.type) ? schema.type[0] : schema.type
  ) as NumericSchemaType;
  const [draftValue, setDraftValue] = useState(() =>
    formatNumericInputValue(value, schema.default, true),
  );
  const [isEditing, setIsEditing] = useState(false);
  const [hasUserEdited, setHasUserEdited] = useState(value !== undefined);

  useEffect(() => {
    setDraftValue(formatNumericInputValue(value, schema.default, true));
    setHasUserEdited(value !== undefined);
    setIsEditing(false);
  }, [fieldPath, schema.default]);

  useEffect(() => {
    if (isEditing) {
      return;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      setDraftValue(String(value));
      return;
    }

    if (!hasUserEdited) {
      setDraftValue(formatNumericInputValue(undefined, schema.default, true));
      return;
    }

    setDraftValue('');
  }, [value, schema.default, isEditing, hasUserEdited]);

  const handleChange = (nextDraft: string) => {
    setHasUserEdited(true);
    setDraftValue(nextDraft);

    const parsed = parseNumericDraft(nextDraft, numericType);
    if (!nextDraft.trim()) {
      onChange(undefined);
      return;
    }

    if (parsed !== null) {
      onChange(parsed);
    }
  };

  const handleBlur = () => {
    setIsEditing(false);

    if (!draftValue.trim()) {
      setDraftValue('');
      onChange(undefined);
      return;
    }

    const parsed = parseNumericDraft(draftValue, numericType);
    if (parsed === null) {
      if (hasUserEdited) {
        setDraftValue('');
        onChange(undefined);
        return;
      }

      setDraftValue(formatNumericInputValue(undefined, schema.default, true));
      return;
    }

    setDraftValue(String(parsed));
    onChange(parsed);
  };

  const displayValue = draftValue;

  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1.5">
        {name}
        {required && <span className="text-error ml-1">*</span>}
      </label>
      {schema.description && <p className="text-xs text-muted mb-1.5">{schema.description}</p>}
      <input
        type="text"
        inputMode={numericType === 'integer' ? 'numeric' : 'decimal'}
        value={displayValue}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => setIsEditing(true)}
        onBlur={handleBlur}
        required={required}
        className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm px-3 py-2 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
        placeholder={schema.default !== undefined ? String(schema.default) : undefined}
        aria-describedby={
          schema.minimum !== undefined || schema.maximum !== undefined
            ? `${name}-numeric-range`
            : undefined
        }
      />
      {(schema.minimum !== undefined || schema.maximum !== undefined) && (
        <p id={`${name}-numeric-range`} className="text-xs text-muted mt-1">
          {schema.minimum !== undefined && schema.maximum !== undefined
            ? t('range', { min: schema.minimum, max: schema.maximum })
            : schema.minimum !== undefined
              ? t('min_value', { min: schema.minimum })
              : t('max_value', { max: schema.maximum! })}
        </p>
      )}
    </div>
  );
}

function SchemaField({ name, schema, value, required, onChange, path = '' }: SchemaFieldProps) {
  const t = useTranslations('tools.dynamic_form');
  const fieldPath = path ? `${path}.${name}` : name;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  // Enum (select dropdown)
  if (schema.enum && schema.enum.length > 0) {
    return (
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">
          {name}
          {required && <span className="text-error ml-1">*</span>}
        </label>
        {schema.description && <p className="text-xs text-muted mb-1.5">{schema.description}</p>}
        <Select
          value={(value as string) || (schema.default as string) || ''}
          onChange={onChange}
          placeholder={!required ? t('select_placeholder') : undefined}
          options={[
            ...(!required ? [{ value: '', label: t('select_placeholder') }] : []),
            ...schema.enum.map((option) => ({ value: option, label: option })),
          ]}
        />
      </div>
    );
  }

  // Boolean (checkbox)
  if (type === 'boolean') {
    return (
      <Checkbox
        checked={(value as boolean) ?? (schema.default as boolean) ?? false}
        onChange={(checked) => onChange(checked)}
        label={`${name}${required ? ' *' : ''}`}
        description={schema.description}
      />
    );
  }

  // Number or Integer
  if (type === 'number' || type === 'integer') {
    return (
      <NumericSchemaField
        name={name}
        schema={schema}
        value={value}
        required={required}
        onChange={onChange}
        fieldPath={fieldPath}
      />
    );
  }

  // Array
  if (type === 'array' && schema.items) {
    const arrayValue = (value as unknown[]) || [];
    return (
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">
          {name}
          {required && <span className="text-error ml-1">*</span>}
        </label>
        {schema.description && <p className="text-xs text-muted mb-1.5">{schema.description}</p>}
        <div className="space-y-2 pl-4 border-l-2 border-accent/30">
          {arrayValue.map((item, index) => (
            <div key={index} className="flex items-start gap-2">
              <div className="flex-1">
                <SchemaField
                  name={`Item ${index + 1}`}
                  schema={schema.items!}
                  value={item}
                  required={false}
                  onChange={(newValue) => {
                    const newArray = [...arrayValue];
                    newArray[index] = newValue;
                    onChange(newArray);
                  }}
                  path={fieldPath}
                />
              </div>
              <button
                onClick={() => {
                  const newArray = arrayValue.filter((_, i) => i !== index);
                  onChange(newArray);
                }}
                className="p-1.5 text-muted hover:text-error rounded transition-default mt-7"
                title={t('remove_item')}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <button
            onClick={() => {
              const defaultValue = getDefaultValue(schema.items!);
              onChange([...arrayValue, defaultValue]);
            }}
            className="flex items-center gap-1.5 text-xs text-info hover:text-info/80 transition-default"
          >
            <Plus className="w-3 h-3" />
            {t('add_item')}
          </button>
        </div>
      </div>
    );
  }

  // Object (nested fields)
  if (type === 'object' && schema.properties) {
    const objValue = (value as Record<string, unknown>) || {};
    const requiredFields = new Set(schema.required || []);
    return (
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">
          {name}
          {required && <span className="text-error ml-1">*</span>}
        </label>
        {schema.description && <p className="text-xs text-muted mb-1.5">{schema.description}</p>}
        <div className="space-y-3 pl-4 border-l-2 border-accent/30">
          {Object.entries(schema.properties).map(([propName, propSchema]) => (
            <SchemaField
              key={propName}
              name={propName}
              schema={propSchema}
              value={objValue[propName]}
              required={requiredFields.has(propName)}
              onChange={(newValue) => {
                onChange({ ...objValue, [propName]: newValue });
              }}
              path={fieldPath}
            />
          ))}
        </div>
      </div>
    );
  }

  // String (default)
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1.5">
        {name}
        {required && <span className="text-error ml-1">*</span>}
      </label>
      {schema.description && <p className="text-xs text-muted mb-1.5">{schema.description}</p>}
      <input
        type="text"
        value={(value as string) ?? (schema.default as string) ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        minLength={schema.minLength}
        maxLength={schema.maxLength}
        pattern={schema.pattern}
        required={required}
        className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm px-3 py-2 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
        placeholder={schema.default !== undefined ? String(schema.default) : undefined}
      />
      {(schema.minLength !== undefined || schema.maxLength !== undefined) && (
        <p className="text-xs text-muted mt-1">
          {schema.minLength !== undefined && schema.maxLength !== undefined
            ? t('length_range', { min: schema.minLength, max: schema.maxLength })
            : schema.minLength !== undefined
              ? t('min_length', { min: schema.minLength })
              : t('max_length', { max: schema.maxLength! })}
        </p>
      )}
    </div>
  );
}

// Helper to get default value for a schema type
function getDefaultValue(schema: JsonSchemaProperty): unknown {
  if (schema.default !== undefined) return schema.default;

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return null;
  }
}
