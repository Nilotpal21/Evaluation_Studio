# Output Schema Builder Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw JSON textarea for `outputSchema` with a dual-mode editor (field-by-field builder + raw JSON).

**Architecture:** A new `SchemaFieldBuilder` component handles both modes — fields mode builds JSON Schema from simple field rows, JSON mode exposes the raw textarea. `ConfigSchemaForm` detects the `outputSchema` field by name and delegates to `SchemaFieldBuilder`. The `outputSchemaMode` value is stored in the pipeline step config as a UI hint, not declared in metadata.

**Tech Stack:** React, TypeScript, next-intl, existing UI primitives (Input, Select), Vitest for unit tests.

**Spec:** `docs/superpowers/specs/2026-03-12-output-schema-builder-design.md`

---

## File Structure

| File                                                                         | Responsibility                                                                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/pipelines/SchemaFieldBuilder.tsx`                | **New** — dual-mode schema editor: field builder + JSON textarea, mode toggle, JSON Schema generation |
| `apps/studio/src/components/pipelines/__tests__/SchemaFieldBuilder.test.tsx` | **New** — unit tests for schema generation, field validation, mode switching                          |
| `apps/studio/src/components/pipelines/ConfigSchemaForm.tsx`                  | **Modify** — detect `outputSchema` field and render `SchemaFieldBuilder` instead of `JsonEditor`      |

---

## Chunk 1: SchemaFieldBuilder Component

### Task 1: Schema generation utilities and tests

**Files:**

- Create: `apps/studio/src/components/pipelines/__tests__/SchemaFieldBuilder.test.tsx`
- Create: `apps/studio/src/components/pipelines/SchemaFieldBuilder.tsx`

- [ ] **Step 1: Write tests for schema generation logic**

Create the test file with tests for the pure functions (schema generation, field validation, JSON-to-fields parsing):

```tsx
// apps/studio/src/components/pipelines/__tests__/SchemaFieldBuilder.test.tsx
import { describe, test, expect } from 'vitest';
import {
  buildJsonSchema,
  parseJsonSchemaToFields,
  isValidFieldName,
  type SchemaField,
} from '../SchemaFieldBuilder';

describe('buildJsonSchema', () => {
  test('generates schema from fields with all types', () => {
    const fields: SchemaField[] = [
      { name: 'score', type: 'number', description: 'Quality score 0-1' },
      { name: 'summary', type: 'string', description: 'Brief summary' },
      { name: 'issues', type: 'string[]', description: 'List of issues found' },
      { name: 'passed', type: 'boolean', description: '' },
    ];

    const schema = buildJsonSchema(fields);

    expect(schema).toEqual({
      type: 'object',
      properties: {
        score: { type: 'number', description: 'Quality score 0-1' },
        summary: { type: 'string', description: 'Brief summary' },
        issues: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of issues found',
        },
        passed: { type: 'boolean' },
      },
      required: ['score', 'summary', 'issues', 'passed'],
    });
  });

  test('omits description when empty', () => {
    const fields: SchemaField[] = [{ name: 'value', type: 'number', description: '' }];

    const schema = buildJsonSchema(fields);

    expect(schema.properties.value).toEqual({ type: 'number' });
    expect(schema.properties.value).not.toHaveProperty('description');
  });

  test('returns undefined for empty fields array', () => {
    expect(buildJsonSchema([])).toBeUndefined();
  });
});

describe('parseJsonSchemaToFields', () => {
  test('parses flat object schema with supported types', () => {
    const schema = {
      type: 'object',
      properties: {
        score: { type: 'number', description: 'A score' },
        name: { type: 'string' },
        ok: { type: 'boolean', description: 'Pass/fail' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
      },
      required: ['score', 'name', 'ok', 'tags'],
    };

    const result = parseJsonSchemaToFields(schema);

    expect(result).not.toBeNull();
    expect(result!.length).toBe(4);
    expect(result![0]).toEqual({ name: 'score', type: 'number', description: 'A score' });
    expect(result![1]).toEqual({ name: 'name', type: 'string', description: '' });
    expect(result![2]).toEqual({ name: 'ok', type: 'boolean', description: 'Pass/fail' });
    expect(result![3]).toEqual({ name: 'tags', type: 'string[]', description: 'Tags' });
  });

  test('returns null for schema with unsupported types', () => {
    const schema = {
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { a: { type: 'string' } } },
      },
    };

    expect(parseJsonSchemaToFields(schema)).toBeNull();
  });

  test('returns null for non-object schema', () => {
    expect(parseJsonSchemaToFields({ type: 'array' })).toBeNull();
  });

  test('returns null for null/undefined input', () => {
    expect(parseJsonSchemaToFields(null)).toBeNull();
    expect(parseJsonSchemaToFields(undefined)).toBeNull();
  });
});

describe('isValidFieldName', () => {
  test('accepts valid names', () => {
    expect(isValidFieldName('score')).toBe(true);
    expect(isValidFieldName('my_field')).toBe(true);
    expect(isValidFieldName('_private')).toBe(true);
    expect(isValidFieldName('Field1')).toBe(true);
  });

  test('rejects invalid names', () => {
    expect(isValidFieldName('')).toBe(false);
    expect(isValidFieldName('1starts_with_digit')).toBe(false);
    expect(isValidFieldName('has space')).toBe(false);
    expect(isValidFieldName('has-dash')).toBe(false);
    expect(isValidFieldName('a'.repeat(65))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/studio/src/components/pipelines/__tests__/SchemaFieldBuilder.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the exported utility functions**

Create `SchemaFieldBuilder.tsx` with the type, utility functions, and a placeholder component:

```tsx
// apps/studio/src/components/pipelines/SchemaFieldBuilder.tsx
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
  mode: 'fields' | 'json';
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
      // Unsupported type — can't represent in field builder
      return null;
    }
  }

  return fields;
}

// =============================================================================
// COMPONENT (placeholder — implemented in Task 2)
// =============================================================================

export function SchemaFieldBuilder({ value, mode, onChange, disabled }: SchemaFieldBuilderProps) {
  return <div>TODO</div>;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/studio/src/components/pipelines/__tests__/SchemaFieldBuilder.test.tsx`
Expected: All 10 tests PASS

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/SchemaFieldBuilder.tsx apps/studio/src/components/pipelines/__tests__/SchemaFieldBuilder.test.tsx
git add apps/studio/src/components/pipelines/SchemaFieldBuilder.tsx apps/studio/src/components/pipelines/__tests__/SchemaFieldBuilder.test.tsx
git commit -m "[ABLP-2] feat(studio): add schema field builder utilities with tests"
```

---

### Task 2: SchemaFieldBuilder UI component

**Files:**

- Modify: `apps/studio/src/components/pipelines/SchemaFieldBuilder.tsx`

- [ ] **Step 1: Implement the full component**

Replace the placeholder `SchemaFieldBuilder` function in `SchemaFieldBuilder.tsx` with the full implementation:

```tsx
// Replace the placeholder component with this:

export function SchemaFieldBuilder({
  value,
  mode: initialMode,
  onChange,
  disabled,
}: SchemaFieldBuilderProps) {
  // Determine initial mode: if schema exists but no mode set, default to 'json' (backward compat)
  const effectiveInitialMode =
    value != null && initialMode == null ? 'json' : (initialMode ?? 'fields');
  const [mode, setMode] = useState<'fields' | 'json'>(effectiveInitialMode);
  const [fields, setFields] = useState<SchemaField[]>(() => {
    if (effectiveInitialMode === 'fields' && value != null) {
      return parseJsonSchemaToFields(value) ?? [];
    }
    if (effectiveInitialMode === 'json') {
      return [];
    }
    return [];
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

  // --- Sync fields → parent ---
  const syncFieldsToParent = useCallback(
    (updatedFields: SchemaField[]) => {
      setFields(updatedFields);
      const schema = buildJsonSchema(updatedFields);
      onChange('outputSchema', schema);
      onChange('outputSchemaMode', 'fields');
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

  // --- Mode switching ---
  const switchToJson = useCallback(() => {
    setSwitchWarning(null);
    const schema = buildJsonSchema(fields);
    setJsonText(schema ? JSON.stringify(schema, null, 2) : '');
    setJsonError(null);
    setMode('json');
    onChange('outputSchemaMode', 'json');
  }, [fields, onChange]);

  const switchToFields = useCallback(() => {
    setSwitchWarning(null);
    // Try to parse current JSON into fields
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
      onChange('outputSchemaMode', 'fields');
      return;
    }

    const parsedFields = parseJsonSchemaToFields(parsed);
    if (parsedFields === null) {
      setSwitchWarning('This schema uses types not supported by the field builder.');
      return;
    }

    setFields(parsedFields);
    setMode('fields');
    onChange('outputSchemaMode', 'fields');
  }, [jsonText, onChange]);

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

  // --- Enter key on draft name ---
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
              ? 'bg-accent text-white'
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
              ? 'bg-accent text-white'
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
                <div className="text-sm font-mono text-foreground truncate">{field.name}</div>
              </div>
              <div className="w-20 shrink-0">
                <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-0.5">
                  Type
                </div>
                <div className="text-sm text-foreground">{field.type}</div>
              </div>
              <div className="flex-[1.5] min-w-0">
                <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-0.5">
                  Description
                </div>
                <div className="text-sm text-foreground truncate">{field.description || '—'}</div>
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
                  onChange={(e) => setDraftType(e.target.value as SchemaField['type'])}
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
                className="shrink-0 p-1.5 rounded-md bg-accent text-white hover:bg-accent/80 transition-colors"
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
            className="w-full rounded-lg border border-default bg-background-elevated px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-y min-h-[80px]"
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
```

- [ ] **Step 2: Verify build**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: Build succeeds

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/SchemaFieldBuilder.tsx
git add apps/studio/src/components/pipelines/SchemaFieldBuilder.tsx
git commit -m "[ABLP-2] feat(studio): implement SchemaFieldBuilder UI component"
```

---

### Task 3: Wire into ConfigSchemaForm

**Files:**

- Modify: `apps/studio/src/components/pipelines/ConfigSchemaForm.tsx:318-329`

- [ ] **Step 1: Add the import**

At the top of `ConfigSchemaForm.tsx`, add the import alongside the existing ones:

```tsx
import { SchemaFieldBuilder } from './SchemaFieldBuilder';
```

- [ ] **Step 2: Add outputSchema detection before the generic object handler**

In the `FieldRenderer` function, insert a new block **before** the existing `// ── Object → JSON editor ──` block (line 318). This detects `outputSchema` by name and renders `SchemaFieldBuilder`:

```tsx
// ── outputSchema → Schema field builder ──
if (field.type === 'object' && field.name === 'outputSchema') {
  return (
    <FieldWrapper label={label} description={field.description} required={field.required}>
      <SchemaFieldBuilder
        value={currentValue}
        mode={values.outputSchemaMode as 'fields' | 'json'}
        onChange={onChange}
        disabled={disabled}
      />
    </FieldWrapper>
  );
}
```

The existing generic `object` handler remains as fallback for all other object fields.

- [ ] **Step 3: Verify build**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: Build succeeds

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/studio/src/components/pipelines/__tests__/SchemaFieldBuilder.test.tsx`
Expected: All tests PASS

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/ConfigSchemaForm.tsx
git add apps/studio/src/components/pipelines/ConfigSchemaForm.tsx
git commit -m "[ABLP-2] feat(studio): wire SchemaFieldBuilder into ConfigSchemaForm for outputSchema"
```

---

## Chunk 2: Manual Verification

### Task 4: Manual UI verification

- [ ] **Step 1: Start the dev server**

Run: `pnpm dev --filter=@agent-platform/studio`

- [ ] **Step 2: Verify fields mode**

1. Open the pipeline editor, add an `LLM Evaluate` node
2. Scroll to "Output Schema" — should show Fields/JSON toggle, defaulting to Fields
3. Add a field: name=`score`, type=`number`, description=`Quality score 0-1`
4. Add a field: name=`summary`, type=`string`, description=`Brief summary`
5. Add a field: name=`issues`, type=`string[]`, description=`Issues found`
6. Verify the generated JSON Schema preview shows the correct schema
7. Try adding a duplicate name — should show error
8. Try adding invalid name (e.g. `1bad`) — should show error
9. Remove a field with the X button — verify it disappears and schema updates

- [ ] **Step 3: Verify JSON mode**

1. Click "JSON" toggle — textarea should populate with the schema built from fields
2. Edit the JSON manually
3. Click back to "Fields" — if schema is simple, fields should populate
4. Enter a complex schema with nested objects, click "Fields" — should show warning and stay in JSON mode

- [ ] **Step 4: Verify backward compatibility**

1. If any existing pipeline has an `outputSchema` set (via raw JSON previously), open it
2. It should default to JSON mode since `outputSchemaMode` is not set
3. The existing schema should display correctly in the textarea
