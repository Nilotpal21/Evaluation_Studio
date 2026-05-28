/**
 * ParameterEditor Component
 *
 * Reusable parameter editor extracted from SandboxConfigForm.
 * Supports CRUD for parameters with name, type, required, description,
 * default value, enum values, and object/array schemas.
 * Auto-generates a JSON Schema preview for the LLM input contract.
 *
 * Used by both HttpConfigForm (input params + output schema) and
 * SandboxConfigForm (input params + output schema).
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2, AlertCircle, Wand2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import type { ParameterDefinition, ParamType } from './shared-types';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ParameterEditorProps {
  parameters: ParameterDefinition[];
  onChange: (parameters: ParameterDefinition[]) => void;
  /** Section label — default: "Parameters" */
  label?: string;
  /** Help text below the label */
  helpText?: string;
  /** Show "Parse" button to auto-detect parameters */
  showParseButton?: boolean;
  /** Callback for "Parse" button */
  onParseFromCode?: () => void;
  /** Label for the collapsible JSON Schema preview — default: "View Generated Input Schema" */
  schemaPreviewLabel?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const PARAM_TYPE_OPTIONS: { value: ParamType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Integer' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'object', label: 'Object' },
  { value: 'array', label: 'Array' },
  { value: 'enum', label: 'Enum' },
];

/** Regex: valid JS identifier (letter, _, or $ to start; letters, digits, _, $ after) */
const PARAM_NAME_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

// ─── Exported Helpers ─────────────────────────────────────────────────────────

/** Sanitise a parameter name as the user types — allow only valid JS identifier chars */
export function sanitiseParamName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_$]/g, '');
}

/** Validate a single parameter and return error messages (empty = valid) */
export function validateParam(
  p: ParameterDefinition,
  allNames: string[],
  t?: (key: string) => string,
): string[] {
  const v = (key: string, fallback: string) => (t ? t(key) : fallback);
  const errors: string[] = [];
  if (!p.name) {
    errors.push(v('validation.name_required', 'Name is required'));
  } else if (!PARAM_NAME_RE.test(p.name)) {
    errors.push(
      v('validation.name_format', 'Name must be a valid identifier (start with letter, _, or $)'),
    );
  } else if (allNames.filter((n) => n === p.name).length > 1) {
    errors.push(v('validation.name_duplicate', 'Duplicate parameter name'));
  }
  if (!p.description.trim()) {
    errors.push(v('validation.description_required', 'Description is required for LLM context'));
  }
  if (p.type === 'enum' && (!p.enumValues || p.enumValues.filter(Boolean).length < 1)) {
    errors.push(v('validation.enum_min_values', 'Enum must have at least one value'));
  }
  if (p.type === 'object' && p.objectSchema) {
    try {
      JSON.parse(p.objectSchema);
    } catch {
      errors.push(v('validation.invalid_json', 'Invalid JSON in object schema'));
    }
  }
  return errors;
}

/**
 * Build a JSON Schema `properties` + `required` from ParameterDefinition[].
 * This is exactly what gets sent to the LLM as the tool's input_schema.
 */
export function buildJsonSchema(params: ParameterDefinition[]): object {
  const properties: Record<string, object> = {};
  const required: string[] = [];

  for (const p of params) {
    if (!p.name) continue;
    const prop: Record<string, unknown> = {};

    if (p.type === 'enum') {
      prop.type = 'string';
      prop.enum = (p.enumValues || []).filter(Boolean);
    } else if (p.type === 'object') {
      prop.type = 'object';
      if (p.objectSchema) {
        try {
          Object.assign(prop, { properties: JSON.parse(p.objectSchema) });
        } catch {
          /* skip */
        }
      }
    } else if (p.type === 'array') {
      prop.type = 'array';
      if (p.objectSchema) {
        try {
          prop.items = JSON.parse(p.objectSchema);
        } catch {
          /* skip */
        }
      }
    } else {
      prop.type = p.type; // string | number | integer | boolean
    }

    if (p.description) prop.description = p.description;
    if (p.defaultValue !== undefined && p.defaultValue !== '') {
      prop.default = coerceDefault(p.type, p.defaultValue);
    }

    properties[p.name] = prop;
    if (p.required) required.push(p.name);
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/** Coerce a default value string to its typed representation for JSON Schema */
export function coerceDefault(type: ParamType, value: string): unknown {
  if (type === 'number' || type === 'integer') return Number(value) || 0;
  if (type === 'boolean') return value === 'true';
  if (type === 'object' || type === 'array') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ParameterEditor({
  parameters,
  onChange,
  label,
  helpText,
  showParseButton = false,
  onParseFromCode,
  schemaPreviewLabel,
}: ParameterEditorProps) {
  const t = useTranslations('tools.parameter_editor');
  const resolvedLabel = label ?? t('label');
  const resolvedSchemaPreviewLabel = schemaPreviewLabel ?? t('schema_preview_label');
  const allNames = parameters.map((p) => p.name);

  // Auto-generate JSON Schema from parameters
  const jsonSchema = useMemo(
    () => (parameters.length > 0 ? buildJsonSchema(parameters) : null),
    [parameters],
  );

  // ── Parameter CRUD ──

  const addParameter = () => {
    onChange([
      ...parameters,
      { name: '', type: 'string' as ParamType, description: '', required: false },
    ]);
  };

  const removeParameter = (index: number) => {
    onChange(parameters.filter((_, i) => i !== index));
  };

  const updateParameter = (index: number, field: string, value: unknown) => {
    const updated = parameters.map((p, i) => (i === index ? { ...p, [field]: value } : p));
    onChange(updated);
  };

  // ── Enum value CRUD ──

  const addEnumValue = (paramIndex: number) => {
    const param = parameters[paramIndex];
    updateParameter(paramIndex, 'enumValues', [...(param.enumValues || []), '']);
  };

  const removeEnumValue = (paramIndex: number, valueIndex: number) => {
    const param = parameters[paramIndex];
    updateParameter(
      paramIndex,
      'enumValues',
      (param.enumValues || []).filter((_, i) => i !== valueIndex),
    );
  };

  const updateEnumValue = (paramIndex: number, valueIndex: number, value: string) => {
    const param = parameters[paramIndex];
    updateParameter(
      paramIndex,
      'enumValues',
      (param.enumValues || []).map((v, i) => (i === valueIndex ? value : v)),
    );
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <label className="block text-sm font-medium text-foreground">{resolvedLabel}</label>
        <div className="flex items-center gap-2">
          {showParseButton && onParseFromCode && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Wand2 className="w-3.5 h-3.5" />}
              onClick={onParseFromCode}
              title={t('parse_tooltip')}
            >
              {t('parse_button')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={addParameter}
          >
            {t('add_button')}
          </Button>
        </div>
      </div>
      {helpText && <p className="text-xs text-muted mb-3">{helpText}</p>}

      {/* Parameter list */}
      {parameters.length === 0 ? (
        <div className="rounded-lg border border-dashed border-default p-4 text-center">
          <p className="text-xs text-muted">{t('empty_state')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {parameters.map((param, index) => {
            const paramErrors = validateParam(param, allNames, t);
            const hasErrors =
              paramErrors.length > 0 && (param.name !== '' || param.description !== '');

            return (
              <div
                key={index}
                className={`rounded-lg border p-3 space-y-3 ${
                  hasErrors
                    ? 'border-error/40 bg-error-subtle/30'
                    : 'border-default bg-background-elevated'
                }`}
              >
                {/* Row 1: Name + Type + Required + Delete */}
                <div
                  data-testid={`parameter-row-${index}`}
                  className="flex flex-wrap items-start gap-2"
                >
                  <div className="flex-1 min-w-[12rem] basis-[16rem]">
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted font-mono text-sm select-none">
                        $
                      </span>
                      <input
                        placeholder={t('name_placeholder')}
                        value={param.name}
                        onChange={(e) =>
                          updateParameter(index, 'name', sanitiseParamName(e.target.value))
                        }
                        className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm pl-7 pr-3 py-1.5 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus font-mono"
                      />
                    </div>
                  </div>
                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
                    <select
                      value={param.type}
                      onChange={(e) => updateParameter(index, 'type', e.target.value)}
                      className="min-w-[8rem] rounded-lg border border-default bg-background-subtle text-foreground text-sm px-2 py-1.5 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                    >
                      {PARAM_TYPE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <Checkbox
                      checked={param.required}
                      onChange={(checked) => updateParameter(index, 'required', checked)}
                      label={t('required_label')}
                      className="shrink-0 whitespace-nowrap gap-1 [&>button]:mt-0"
                    />
                    <button
                      type="button"
                      onClick={() => removeParameter(index)}
                      className="shrink-0 p-1.5 text-muted hover:text-error transition-default"
                      title={t('remove_tooltip')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Row 2: Description (LLM-visible) */}
                <input
                  placeholder={t('description_placeholder')}
                  value={param.description}
                  onChange={(e) => updateParameter(index, 'description', e.target.value)}
                  className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm px-3 py-1.5 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                />

                {/* Row 3: Default value */}
                <div className="grid grid-cols-2 gap-2">
                  <input
                    placeholder={
                      param.type === 'boolean'
                        ? t('default_boolean_placeholder')
                        : param.type === 'number' || param.type === 'integer'
                          ? t('default_number_placeholder')
                          : param.type === 'object'
                            ? t('default_object_placeholder')
                            : param.type === 'array'
                              ? t('default_array_placeholder')
                              : t('default_placeholder')
                    }
                    value={param.defaultValue || ''}
                    onChange={(e) => updateParameter(index, 'defaultValue', e.target.value)}
                    className="rounded-lg border border-default bg-background-subtle text-foreground text-sm px-3 py-1.5 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus font-mono"
                  />
                  <div className="flex items-center text-xs text-muted px-1">
                    {param.name && (
                      <span className="truncate">
                        {t('code_prefix')}{' '}
                        <code className="font-mono bg-background-muted px-1 rounded">
                          ${param.name}
                        </code>
                      </span>
                    )}
                  </div>
                </div>

                {/* Enum values (conditional) */}
                {param.type === 'enum' && (
                  <div className="pl-3 border-l-2 border-accent/30 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted">
                        {t('allowed_values_label')}
                      </span>
                      <button
                        type="button"
                        onClick={() => addEnumValue(index)}
                        className="text-xs text-info hover:text-info/80 transition-default"
                      >
                        {t('add_value_button')}
                      </button>
                    </div>
                    {(param.enumValues || []).map((val, vi) => (
                      <div key={vi} className="flex items-center gap-2">
                        <input
                          placeholder={t('value_placeholder', { index: vi + 1 })}
                          value={val}
                          onChange={(e) => updateEnumValue(index, vi, e.target.value)}
                          className="flex-1 rounded-lg border border-default bg-background-subtle text-foreground text-sm px-3 py-1 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => removeEnumValue(index, vi)}
                          className="p-1 text-muted hover:text-error transition-default"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    {(!param.enumValues || param.enumValues.length === 0) && (
                      <p className="text-xs text-muted italic">{t('no_values_hint')}</p>
                    )}
                  </div>
                )}

                {/* Object / Array schema (conditional) */}
                {(param.type === 'object' || param.type === 'array') && (
                  <div className="pl-3 border-l-2 border-accent/30 space-y-1.5">
                    <span className="text-xs font-medium text-muted">
                      {param.type === 'object' ? t('object_schema_label') : t('array_schema_label')}
                    </span>
                    <textarea
                      placeholder={
                        param.type === 'object'
                          ? t('object_schema_placeholder')
                          : t('array_schema_placeholder')
                      }
                      value={param.objectSchema || ''}
                      onChange={(e) => updateParameter(index, 'objectSchema', e.target.value)}
                      rows={3}
                      className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-xs font-mono p-2 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus resize-y"
                      spellCheck={false}
                    />
                  </div>
                )}

                {/* Validation errors */}
                {hasErrors && (
                  <div className="flex items-start gap-1.5 text-xs text-error">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{paramErrors.join('. ')}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Generated JSON Schema Preview (collapsible) */}
      {jsonSchema && (
        <details className="group mt-4">
          <summary className="text-xs font-medium text-muted cursor-pointer hover:text-foreground transition-default select-none flex items-center gap-1">
            <span className="group-open:rotate-90 transition-transform inline-block">&#9654;</span>
            {resolvedSchemaPreviewLabel}
          </summary>
          <pre className="mt-1.5 rounded-lg border border-default bg-background-subtle text-foreground text-xs font-mono p-3 overflow-x-auto max-h-48 overflow-y-auto">
            {JSON.stringify(jsonSchema, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
