'use client';

import { useState, useCallback, useMemo } from 'react';
import { Plus, X } from 'lucide-react';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';

// =============================================================================
// TYPES
// =============================================================================

export interface SchemaField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'string[]';
  description: string;
}

export interface SchemaFieldBuilderProps {
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
}

const FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

const FIELD_TYPE_OPTIONS = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'boolean' },
  { value: 'string[]', label: 'string[]' },
];

// =============================================================================
// PURE FUNCTIONS (exported for testing)
// =============================================================================

export function isValidFieldName(name: string): boolean {
  return FIELD_NAME_RE.test(name);
}

export function buildJsonSchema(fields: SchemaField[]): Record<string, unknown> | undefined {
  if (fields.length === 0) return undefined;

  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const field of fields) {
    const prop: Record<string, unknown> = {};

    if (field.type === 'string[]') {
      prop.type = 'array';
      prop.items = { type: 'string' };
    } else {
      prop.type = field.type;
    }

    if (field.description.trim()) {
      prop.description = field.description.trim();
    }

    properties[field.name] = prop;
    required.push(field.name);
  }

  return { type: 'object', properties, required };
}

export function parseJsonSchemaToFields(schema: unknown): SchemaField[] | null {
  if (schema == null || typeof schema !== 'object') return null;

  const s = schema as Record<string, unknown>;
  if (s.type !== 'object' || !s.properties || typeof s.properties !== 'object') {
    return null;
  }

  const props = s.properties as Record<string, Record<string, unknown>>;
  const fields: SchemaField[] = [];

  for (const [name, prop] of Object.entries(props)) {
    if (prop.type === 'string') {
      fields.push({ name, type: 'string', description: String(prop.description ?? '') });
    } else if (prop.type === 'number') {
      fields.push({ name, type: 'number', description: String(prop.description ?? '') });
    } else if (prop.type === 'boolean') {
      fields.push({ name, type: 'boolean', description: String(prop.description ?? '') });
    } else if (
      prop.type === 'array' &&
      prop.items &&
      typeof prop.items === 'object' &&
      (prop.items as Record<string, unknown>).type === 'string'
    ) {
      fields.push({ name, type: 'string[]', description: String(prop.description ?? '') });
    } else {
      return null;
    }
  }

  return fields;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function SchemaFieldBuilder({ value, onChange, disabled }: SchemaFieldBuilderProps) {
  // Derive initial mode from schema value:
  // - No schema → fields mode (empty builder)
  // - Schema parseable to flat fields → fields mode
  // - Schema not parseable → json mode (complex/hand-written schema)
  const [mode, setMode] = useState<'fields' | 'json'>(() => {
    if (value == null) return 'fields';
    return parseJsonSchemaToFields(value) !== null ? 'fields' : 'json';
  });
  const [fields, setFields] = useState<SchemaField[]>(() => {
    if (value == null) return [];
    return parseJsonSchemaToFields(value) ?? [];
  });
  const [switchWarning, setSwitchWarning] = useState<string | null>(null);

  // --- Draft row state ---
  const [draftName, setDraftName] = useState('');
  const [draftType, setDraftType] = useState<SchemaField['type']>('string');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);

  // --- JSON text state (for JSON mode) ---
  const [jsonText, setJsonText] = useState(() => {
    if (value == null) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '';
    }
  });
  const [jsonError, setJsonError] = useState<string | null>(null);

  // --- Generated schema preview ---
  const generatedSchema = useMemo(() => buildJsonSchema(fields), [fields]);
  const previewText = useMemo(
    () => (generatedSchema ? JSON.stringify(generatedSchema, null, 2) : ''),
    [generatedSchema],
  );

  // --- Sync fields → parent (single onChange call — no race condition) ---
  const syncFieldsToParent = useCallback(
    (updatedFields: SchemaField[]) => {
      setFields(updatedFields);
      const schema = buildJsonSchema(updatedFields);
      onChange('outputSchema', schema);
    },
    [onChange],
  );

  // --- Add field ---
  const addField = useCallback(() => {
    const trimmedName = draftName.trim();
    setDraftError(null);

    if (!trimmedName) {
      setDraftError('Name is required');
      return;
    }
    if (!isValidFieldName(trimmedName)) {
      setDraftError('Letters, digits, underscores only. Must start with letter or underscore.');
      return;
    }
    if (fields.some((f) => f.name === trimmedName)) {
      setDraftError('Field name already exists');
      return;
    }

    const newField: SchemaField = {
      name: trimmedName,
      type: draftType,
      description: draftDesc.trim(),
    };
    syncFieldsToParent([...fields, newField]);
    setDraftName('');
    setDraftType('string');
    setDraftDesc('');
  }, [draftName, draftType, draftDesc, fields, syncFieldsToParent]);

  // --- Remove field ---
  const removeField = useCallback(
    (index: number) => {
      syncFieldsToParent(fields.filter((_, i) => i !== index));
    },
    [fields, syncFieldsToParent],
  );

  // --- Update existing field ---
  const updateField = useCallback(
    (index: number, key: keyof SchemaField, val: string) => {
      const updated = fields.map((f, i) => (i === index ? { ...f, [key]: val } : f));
      syncFieldsToParent(updated);
    },
    [fields, syncFieldsToParent],
  );

  // --- Mode switching ---
  const switchToJson = useCallback(() => {
    setSwitchWarning(null);
    const schema = buildJsonSchema(fields);
    setJsonText(schema ? JSON.stringify(schema, null, 2) : '');
    setJsonError(null);
    setMode('json');
  }, [fields]);

  const switchToFields = useCallback(() => {
    setSwitchWarning(null);

    let parsed: unknown;
    try {
      parsed = jsonText.trim() ? JSON.parse(jsonText) : null;
    } catch {
      setSwitchWarning('Current JSON is not valid. Fix it before switching to fields mode.');
      return;
    }

    if (parsed == null) {
      setFields([]);
      setMode('fields');
      return;
    }

    const parsedFields = parseJsonSchemaToFields(parsed);
    if (parsedFields === null) {
      setSwitchWarning('This schema uses types not supported by the field builder.');
      return;
    }

    setFields(parsedFields);
    setMode('fields');
  }, [jsonText]);

  // --- JSON mode blur handler ---
  const handleJsonBlur = useCallback(() => {
    if (!jsonText.trim()) {
      setJsonError(null);
      onChange('outputSchema', undefined);
      return;
    }
    try {
      const parsed = JSON.parse(jsonText);
      setJsonError(null);
      onChange('outputSchema', parsed);
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  }, [jsonText, onChange]);

  // --- Enter key on draft inputs ---
  const handleDraftKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addField();
      }
    },
    [addField],
  );

  return (
    <div className="space-y-3">
      {/* Mode toggle */}
      <div className="flex rounded-md border border-default overflow-hidden w-fit">
        <button
          type="button"
          className={`px-3 py-1 text-xs font-medium transition-colors ${
            mode === 'fields'
              ? 'bg-accent text-accent-foreground'
              : 'bg-background-elevated text-foreground-muted hover:text-foreground'
          }`}
          onClick={() => mode !== 'fields' && switchToFields()}
          disabled={disabled}
        >
          Fields
        </button>
        <button
          type="button"
          className={`px-3 py-1 text-xs font-medium border-l border-default transition-colors ${
            mode === 'json'
              ? 'bg-accent text-accent-foreground'
              : 'bg-background-elevated text-foreground-muted hover:text-foreground'
          }`}
          onClick={() => mode !== 'json' && switchToJson()}
          disabled={disabled}
        >
          JSON
        </button>
      </div>

      {switchWarning && <p className="text-xs text-warning">{switchWarning}</p>}

      {/* ── Fields mode ── */}
      {mode === 'fields' && (
        <div className="space-y-2">
          {/* Existing field rows */}
          {fields.map((field, i) => (
            <div
              key={`${field.name}-${i}`}
              className="flex gap-2 items-center px-3 py-2 rounded-lg border border-default bg-background-elevated/50"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-0.5">
                  Name
                </div>
                {disabled ? (
                  <div className="text-sm font-mono text-foreground truncate">{field.name}</div>
                ) : (
                  <Input
                    type="text"
                    value={field.name}
                    onChange={(e) => updateField(i, 'name', e.target.value)}
                    className="!text-xs !font-mono"
                  />
                )}
              </div>
              <div className="w-24 shrink-0">
                <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-0.5">
                  Type
                </div>
                {disabled ? (
                  <div className="text-sm text-foreground">{field.type}</div>
                ) : (
                  <Select
                    options={FIELD_TYPE_OPTIONS}
                    value={field.type}
                    onChange={(val) => updateField(i, 'type', val)}
                    className="!text-xs"
                  />
                )}
              </div>
              <div className="flex-[1.5] min-w-0">
                <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-0.5">
                  Description
                </div>
                {disabled ? (
                  <div className="text-sm text-foreground truncate">
                    {field.description || '\u2014'}
                  </div>
                ) : (
                  <Input
                    type="text"
                    value={field.description}
                    onChange={(e) => updateField(i, 'description', e.target.value)}
                    placeholder="Optional description"
                    className="!text-xs"
                  />
                )}
              </div>
              {!disabled && (
                <button
                  type="button"
                  className="shrink-0 p-1 text-foreground-muted hover:text-error transition-colors"
                  onClick={() => removeField(i)}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}

          {/* Add field row */}
          {!disabled && (
            <div className="flex gap-2 items-end px-3 py-2 rounded-lg border border-dashed border-default bg-background/50">
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-0.5">
                  Name
                </div>
                <Input
                  type="text"
                  value={draftName}
                  onChange={(e) => {
                    setDraftName(e.target.value);
                    setDraftError(null);
                  }}
                  onKeyDown={handleDraftKeyDown}
                  placeholder="field_name"
                  className="!text-xs !font-mono"
                />
              </div>
              <div className="w-24 shrink-0">
                <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-0.5">
                  Type
                </div>
                <Select
                  options={FIELD_TYPE_OPTIONS}
                  value={draftType}
                  onChange={(val) => setDraftType(val as SchemaField['type'])}
                  className="!text-xs"
                />
              </div>
              <div className="flex-[1.5] min-w-0">
                <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-0.5">
                  Description
                </div>
                <Input
                  type="text"
                  value={draftDesc}
                  onChange={(e) => setDraftDesc(e.target.value)}
                  onKeyDown={handleDraftKeyDown}
                  placeholder="Optional description"
                  className="!text-xs"
                />
              </div>
              <button
                type="button"
                className="shrink-0 p-1.5 rounded-md bg-accent text-accent-foreground hover:bg-accent/80 transition-colors"
                onClick={addField}
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {draftError && <p className="text-[10px] text-error">{draftError}</p>}

          {/* Generated schema preview */}
          {previewText && (
            <div className="mt-2 px-3 py-2 rounded-md bg-background border border-default">
              <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">
                Generated JSON Schema
              </div>
              <pre className="text-[11px] font-mono text-accent whitespace-pre-wrap m-0">
                {previewText}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* ── JSON mode ── */}
      {mode === 'json' && (
        <div className="space-y-1">
          <textarea
            className="w-full rounded-lg border border-default bg-background-elevated px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-border-focus resize-y min-h-[80px]"
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            onBlur={handleJsonBlur}
            disabled={disabled}
            placeholder="Enter JSON Schema..."
            rows={6}
          />
          {jsonError && <p className="text-[10px] text-error">{jsonError}</p>}
        </div>
      )}
    </div>
  );
}
