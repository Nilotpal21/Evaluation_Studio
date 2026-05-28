# Lookup Field Type in Gather Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `lookup` as a gather field type in Studio's agent editor, with inline configuration for all three lookup sources (inline, API, collection).

**Architecture:** Extend the existing GatherEditor field card to render a `LookupConfigPanel` when `type === 'lookup'`. The panel uses a `SegmentedControl` to switch between source-specific config forms. Data flows through `GatherFieldData` → `serializeGatherToABL` → DSL, and IR → `parseGather` → `GatherFieldData` for hydration.

**Tech Stack:** React, Zustand, existing UI components (SegmentedControl, Toggle, Select, EnumTagInput pattern)

**Spec:** `docs/superpowers/specs/2026-03-24-lookup-field-type-gather-editor-design.md`

---

### Task 1: Extend GatherFieldData with lookup fields

**Files:**

- Modify: `apps/studio/src/store/agent-detail-store.ts:93-116` (GatherFieldData interface)

- [ ] **Step 1: Add lookup fields to GatherFieldData**

Add these fields after the existing `options?: string[]` field at line 107:

```ts
  // Lookup-specific fields (only used when type === 'lookup')
  lookupSource?: 'inline' | 'api' | 'collection';
  lookupValues?: string[];
  lookupEndpoint?: string;
  lookupField?: string;
  lookupTimeoutMs?: number;
  lookupHeaders?: Record<string, string>;
  lookupTableName?: string;
  lookupCaseSensitive?: boolean;
  lookupFuzzyMatch?: boolean;
  lookupFuzzyThreshold?: number;
```

- [ ] **Step 2: Verify build**

Run: `pnpm build --filter=studio`
Expected: Clean build, no type errors

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/store/agent-detail-store.ts
git add apps/studio/src/store/agent-detail-store.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(studio): add lookup fields to GatherFieldData interface
EOF
)"
```

---

### Task 2: Add lookup type to GatherEditor constants and badge

**Files:**

- Modify: `apps/studio/src/components/agent-editor/sections/GatherEditor.tsx:22-36` (constants)

- [ ] **Step 1: Add lookup to TYPE_BADGE_COLORS**

At line 27, add the `lookup` entry:

```ts
const TYPE_BADGE_COLORS: Record<string, string> = {
  string: 'bg-accent/10 text-accent',
  number: 'bg-info/10 text-info',
  boolean: 'bg-warning/10 text-warning',
  date: 'bg-success/10 text-success',
  enum: 'bg-info/10 text-info',
  lookup: 'bg-accent/10 text-accent',
};
```

- [ ] **Step 2: Add lookup to FIELD_TYPE_OPTIONS**

At line 30, add the `lookup` option:

```ts
const FIELD_TYPE_OPTIONS = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'boolean' },
  { value: 'date', label: 'date' },
  { value: 'enum', label: 'enum' },
  { value: 'lookup', label: 'lookup' },
] as const;
```

- [ ] **Step 3: Verify build**

Run: `pnpm build --filter=studio`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/components/agent-editor/sections/GatherEditor.tsx
git add apps/studio/src/components/agent-editor/sections/GatherEditor.tsx
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(studio): add lookup type to gather field type options and badge colors
EOF
)"
```

---

### Task 3: Build LookupConfigPanel component

**Files:**

- Modify: `apps/studio/src/components/agent-editor/sections/GatherEditor.tsx`

This is the main UI work. Add three sub-components between the `EnumTagInput` and `FieldCard` sections (around line 135):

- [ ] **Step 1: Add imports**

Add `SegmentedControl` import and `Upload` icon at the top of the file:

```ts
import { SegmentedControl } from '../../ui/SegmentedControl';
import { List, Plus, X, ChevronDown, ChevronRight, Upload } from 'lucide-react';
```

- [ ] **Step 2: Add LOOKUP_SOURCE_OPTIONS constant**

After the `FIELD_TYPE_OPTIONS` constant:

```ts
const LOOKUP_SOURCE_OPTIONS = [
  { id: 'inline', label: 'Inline' },
  { id: 'api', label: 'API' },
  { id: 'collection', label: 'Collection' },
];
```

- [ ] **Step 3: Create HeaderKeyValueEditor component**

Add this after the `EnumTagInput` component (around line 135). This handles the key-value header rows for API source:

```tsx
interface HeaderKeyValueEditorProps {
  headers: Record<string, string>;
  onChange: (headers: Record<string, string>) => void;
  readOnly?: boolean;
}

function HeaderKeyValueEditor({ headers, onChange, readOnly }: HeaderKeyValueEditorProps) {
  const entries = Object.entries(headers);

  const handleAdd = useCallback(() => {
    onChange({ ...headers, '': '' });
  }, [headers, onChange]);

  const handleRemove = useCallback(
    (key: string) => {
      const next = { ...headers };
      delete next[key];
      onChange(next);
    },
    [headers, onChange],
  );

  const handleChange = useCallback(
    (oldKey: string, newKey: string, value: string) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (k === oldKey) {
          next[newKey] = value;
        } else {
          next[k] = v;
        }
      }
      onChange(next);
    },
    [headers, onChange],
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
          Headers
        </span>
        {!readOnly && (
          <button
            type="button"
            onClick={handleAdd}
            className="text-xs text-accent hover:text-accent/80 transition-fast font-medium"
          >
            + Add
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-foreground-subtle italic">No headers configured</p>
      ) : (
        <div className="space-y-1.5">
          {entries.map(([key, value], idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                type="text"
                value={key}
                onChange={(e) => handleChange(key, e.target.value, value)}
                placeholder="Header-Name"
                readOnly={readOnly}
                className="flex-1 font-mono text-xs text-foreground bg-transparent border border-default rounded px-2 py-1 placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus"
              />
              <span className="text-foreground-muted text-xs">:</span>
              <input
                type="text"
                value={value}
                onChange={(e) => handleChange(key, key, e.target.value)}
                placeholder="value"
                readOnly={readOnly}
                className="flex-1 font-mono text-xs text-foreground bg-transparent border border-default rounded px-2 py-1 placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus"
              />
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => handleRemove(key)}
                  className="p-0.5 rounded hover:bg-error/10 hover:text-error transition-fast"
                  aria-label={`Remove header ${key}`}
                >
                  <X className="w-3 h-3 text-foreground-muted" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create LookupConfigPanel component**

Add this after `HeaderKeyValueEditor`. This is the main panel that renders source-specific config:

```tsx
interface LookupConfigPanelProps {
  field: GatherFieldData;
  index: number;
  onChange: (index: number, field: GatherFieldData) => void;
  readOnly?: boolean;
}

function LookupConfigPanel({ field, index, onChange, readOnly }: LookupConfigPanelProps) {
  const source = field.lookupSource ?? 'inline';

  const handleSourceChange = useCallback(
    (value: string) => {
      onChange(index, { ...field, lookupSource: value as 'inline' | 'api' | 'collection' });
    },
    [index, field, onChange],
  );

  return (
    <div className="border-l-[3px] border-accent/30 bg-accent/[0.02] px-3 py-3 space-y-3">
      <div className="text-xs font-semibold text-accent uppercase tracking-wider">
        Lookup Configuration
      </div>

      {/* Source segmented control */}
      <SegmentedControl
        options={LOOKUP_SOURCE_OPTIONS}
        value={source}
        onChange={handleSourceChange}
        size="sm"
        ariaLabel="Lookup source type"
      />

      {/* Source-specific config */}
      {source === 'inline' && (
        <FieldGroup label="Values">
          <EnumTagInput
            values={field.lookupValues ?? []}
            onChange={(lookupValues) => onChange(index, { ...field, lookupValues })}
            readOnly={readOnly}
          />
        </FieldGroup>
      )}

      {source === 'api' && (
        <div className="space-y-3">
          <FieldGroup label="Endpoint URL">
            <input
              type="text"
              value={field.lookupEndpoint ?? ''}
              onChange={(e) =>
                onChange(index, { ...field, lookupEndpoint: e.target.value || undefined })
              }
              readOnly={readOnly}
              placeholder="https://api.example.com/lookup"
              className="w-full text-sm text-foreground bg-transparent border border-default rounded-md px-3 py-1.5 placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus"
            />
          </FieldGroup>
          <div className="grid grid-cols-2 gap-3">
            <FieldGroup label="Response Field">
              <input
                type="text"
                value={field.lookupField ?? ''}
                onChange={(e) =>
                  onChange(index, { ...field, lookupField: e.target.value || undefined })
                }
                readOnly={readOnly}
                placeholder="product_name"
                className="w-full text-sm text-foreground bg-transparent border border-default rounded-md px-3 py-1.5 placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus"
              />
            </FieldGroup>
            <FieldGroup label="Timeout (ms)">
              <input
                type="number"
                value={field.lookupTimeoutMs ?? 5000}
                onChange={(e) =>
                  onChange(index, {
                    ...field,
                    lookupTimeoutMs: parseInt(e.target.value, 10) || undefined,
                  })
                }
                readOnly={readOnly}
                min={100}
                max={30000}
                className="w-full text-sm text-foreground bg-transparent border border-default rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-border-focus"
              />
            </FieldGroup>
          </div>
          <HeaderKeyValueEditor
            headers={field.lookupHeaders ?? {}}
            onChange={(lookupHeaders) => onChange(index, { ...field, lookupHeaders })}
            readOnly={readOnly}
          />
        </div>
      )}

      {source === 'collection' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <FieldGroup label="Table Name">
              <input
                type="text"
                value={field.lookupTableName ?? ''}
                onChange={(e) =>
                  onChange(index, { ...field, lookupTableName: e.target.value || undefined })
                }
                readOnly={readOnly}
                placeholder="employees"
                className="w-full text-sm text-foreground bg-transparent border border-default rounded-md px-3 py-1.5 placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus"
              />
            </FieldGroup>
            <FieldGroup label="Match Field">
              <input
                type="text"
                value={field.lookupField ?? ''}
                onChange={(e) =>
                  onChange(index, { ...field, lookupField: e.target.value || undefined })
                }
                readOnly={readOnly}
                placeholder="name"
                className="w-full text-sm text-foreground bg-transparent border border-default rounded-md px-3 py-1.5 placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus"
              />
            </FieldGroup>
          </div>
          <FieldGroup label="Upload Data">
            <div className="border-2 border-dashed border-default rounded-lg p-4 text-center">
              <Upload className="w-5 h-5 text-foreground-muted mx-auto mb-1" />
              <p className="text-xs text-foreground-muted">Drop CSV or JSON file here</p>
              <p className="text-xs text-foreground-subtle mt-0.5">Max 1MB</p>
              <input
                type="file"
                accept=".csv,.json"
                disabled={readOnly}
                className="mt-2 text-xs text-foreground file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-accent file:text-accent-foreground hover:file:opacity-90"
              />
            </div>
          </FieldGroup>
        </div>
      )}

      {/* Shared matching controls */}
      <div className="flex items-center gap-4 pt-2 border-t border-default/50">
        <label className="flex items-center gap-2 text-xs text-foreground-muted">
          <Toggle
            checked={field.lookupCaseSensitive ?? false}
            onChange={(checked) => onChange(index, { ...field, lookupCaseSensitive: checked })}
            disabled={readOnly}
          />
          Case Sensitive
        </label>
        <label className="flex items-center gap-2 text-xs text-foreground-muted">
          <Toggle
            checked={field.lookupFuzzyMatch ?? false}
            onChange={(checked) => onChange(index, { ...field, lookupFuzzyMatch: checked })}
            disabled={readOnly}
          />
          Fuzzy Match
        </label>
        {field.lookupFuzzyMatch && (
          <label className="flex items-center gap-2 text-xs text-foreground-muted">
            Threshold:
            <input
              type="number"
              value={field.lookupFuzzyThreshold ?? 0.85}
              onChange={(e) =>
                onChange(index, {
                  ...field,
                  lookupFuzzyThreshold: parseFloat(e.target.value) || 0.85,
                })
              }
              readOnly={readOnly}
              min={0}
              max={1}
              step={0.05}
              className="w-16 text-sm text-foreground bg-transparent border border-default rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-border-focus"
            />
          </label>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire LookupConfigPanel into FieldCard**

In the `FieldCard` component, after the enum values block (around line 309), add:

```tsx
{
  /* Lookup configuration panel */
}
{
  field.type === 'lookup' && (
    <LookupConfigPanel field={field} index={index} onChange={onChange} readOnly={readOnly} />
  );
}
```

- [ ] **Step 6: Verify build**

Run: `pnpm build --filter=studio`
Expected: Clean build

- [ ] **Step 7: Commit**

```bash
npx prettier --write apps/studio/src/components/agent-editor/sections/GatherEditor.tsx
git add apps/studio/src/components/agent-editor/sections/GatherEditor.tsx
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(studio): add LookupConfigPanel with inline/api/collection sources in GatherEditor
EOF
)"
```

---

### Task 4: Hydrate lookup fields from IR in agent-detail-store

**Files:**

- Modify: `apps/studio/src/store/agent-detail-store.ts:415-445` (parseGather function)

- [ ] **Step 1: Update parseGather to accept IR lookup tables and populate lookup fields**

Replace the `parseGather` function. The key change is: pass `ir.lookup_tables` in, check each field's `semantics.lookup`, and populate the `lookup*` fields from the matching table.

```ts
function parseGather(ir: any): GatherFieldData[] {
  const fields = ir.gather?.fields ?? [];
  const lookupTables: Record<string, any> = ir.lookup_tables ?? {};

  return fields.map((f: any) => {
    const base: GatherFieldData = {
      name: f.name,
      prompt: f.prompt ?? '',
      type: f.type ?? 'string',
      required: f.required ?? false,
      defaultValue: f.default,
      validation: f.validation
        ? {
            type: f.validation.type,
            rule: f.validation.rule,
            errorMessage: f.validation.error_message,
          }
        : undefined,
      extractionHints: f.extraction_hints,
      infer: f.infer,
      options: f.enum_values,
      sensitive: f.sensitive,
      sensitiveDisplay: f.sensitive_display,
      maskConfig: f.mask_config
        ? {
            showFirst: f.mask_config.show_first,
            showLast: f.mask_config.show_last,
            char: f.mask_config.char,
          }
        : undefined,
      transient: f.transient,
      extractionPattern: f.extraction_pattern,
      extractionGroup: f.extraction_group,
    };

    // Hydrate lookup fields from IR lookup_tables
    const lookupName = f.semantics?.lookup;
    if (lookupName && lookupTables[lookupName]) {
      const table = lookupTables[lookupName];
      base.type = 'lookup';
      base.lookupSource = table.source;
      base.lookupValues = table.values;
      base.lookupEndpoint = table.endpoint;
      base.lookupField = table.field;
      base.lookupTimeoutMs = table.timeout_ms;
      base.lookupHeaders = table.headers;
      base.lookupTableName = table.table_name;
      base.lookupCaseSensitive = table.case_sensitive;
      base.lookupFuzzyMatch = table.fuzzy_match;
      base.lookupFuzzyThreshold = table.fuzzy_threshold;
    }

    return base;
  });
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build --filter=studio`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/store/agent-detail-store.ts
git add apps/studio/src/store/agent-detail-store.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(studio): hydrate lookup fields from IR lookup_tables in parseGather
EOF
)"
```

---

### Task 5: Serialize lookup fields to DSL in abl-serializers

**Files:**

- Modify: `apps/studio/src/lib/abl-serializers.ts:148-200` (serializeGatherToABL function)

- [ ] **Step 1: Add serializeLookupTablesToABL helper**

Add this helper function before `serializeGatherToABL`:

```ts
function serializeLookupTableEntry(fieldName: string, f: GatherFieldData): string {
  const tableName =
    f.lookupSource === 'collection' && f.lookupTableName ? f.lookupTableName : fieldName;
  const source = f.lookupSource ?? 'inline';

  let block = `  ${tableName}:\n    source: ${source}`;

  if (source === 'inline' && f.lookupValues && f.lookupValues.length > 0) {
    block += `\n    values: [${f.lookupValues.join(', ')}]`;
  }

  if (source === 'api') {
    if (f.lookupEndpoint) block += `\n    endpoint: ${inlineQuote(f.lookupEndpoint)}`;
    if (f.lookupField) block += `\n    field: ${f.lookupField}`;
    if (f.lookupTimeoutMs) block += `\n    timeout_ms: ${f.lookupTimeoutMs}`;
    if (f.lookupHeaders && Object.keys(f.lookupHeaders).length > 0) {
      block += '\n    headers:';
      for (const [k, v] of Object.entries(f.lookupHeaders)) {
        block += `\n      ${k}: ${inlineQuote(v)}`;
      }
    }
  }

  if (source === 'collection') {
    if (f.lookupTableName) block += `\n    table_name: ${f.lookupTableName}`;
    if (f.lookupField) block += `\n    field: ${f.lookupField}`;
  }

  block += `\n    case_sensitive: ${f.lookupCaseSensitive ?? false}`;
  block += `\n    fuzzy_match: ${f.lookupFuzzyMatch ?? false}`;
  if (f.lookupFuzzyMatch) {
    block += `\n    fuzzy_threshold: ${f.lookupFuzzyThreshold ?? 0.85}`;
  }

  return block;
}
```

- [ ] **Step 2: Update serializeGatherToABL to emit LOOKUP_TABLES section**

Replace the existing `serializeGatherToABL` function:

```ts
export function serializeGatherToABL(data: GatherFieldData[]): SectionEdit[] {
  if (data.length === 0) {
    return [{ section: 'GATHER', content: null }];
  }

  const lookupFields = data.filter((f) => f.type === 'lookup');

  const fields = data
    .map((f) => {
      // For lookup fields, emit the original type as 'string' in DSL
      // (the lookup table + semantics handle the validation)
      const dslType = f.type === 'lookup' ? 'string' : f.type;
      let line = `  - ${f.name}: ${f.required ? 'required' : 'optional'}`;
      if (dslType && dslType !== 'string') {
        line += ` (${dslType})`;
      }
      if (f.prompt) {
        line += `\n    prompt: ${inlineQuote(f.prompt)}`;
      }
      // Emit semantics.lookup reference for lookup fields
      if (f.type === 'lookup') {
        const tableName =
          f.lookupSource === 'collection' && f.lookupTableName ? f.lookupTableName : f.name;
        line += `\n    semantics:\n      lookup: ${tableName}`;
      }
      if (f.validation) {
        line += `\n    validate: ${f.validation.rule}`;
        if (f.validation.errorMessage) {
          line += `\n    on_fail: ${inlineQuote(f.validation.errorMessage)}`;
        }
      }
      if (f.extractionHints && f.extractionHints.length > 0) {
        line += `\n    hints: [${f.extractionHints.map(inlineQuote).join(', ')}]`;
      }
      if (f.infer) {
        line += '\n    infer: true';
      }
      if (f.options && f.options.length > 0 && f.type === 'enum') {
        line += `\n    options: [${f.options.join(', ')}]`;
      }
      if (f.sensitive) {
        line += '\n    sensitive: true';
        if (f.sensitiveDisplay) {
          line += `\n    sensitive_display: ${f.sensitiveDisplay}`;
        }
        if (f.sensitiveDisplay === 'mask' && f.maskConfig) {
          line += `\n    mask_config:`;
          line += `\n      show_first: ${f.maskConfig.showFirst}`;
          line += `\n      show_last: ${f.maskConfig.showLast}`;
          line += `\n      char: ${inlineQuote(f.maskConfig.char)}`;
        }
        if (f.transient) {
          line += '\n    transient: true';
        }
      }
      if (f.extractionPattern) {
        line += `\n    extraction_pattern: ${inlineQuote(f.extractionPattern)}`;
        if (f.extractionGroup && f.extractionGroup > 0) {
          line += `\n    extraction_group: ${f.extractionGroup}`;
        }
      }
      return line;
    })
    .join('\n');

  const edits: SectionEdit[] = [{ section: 'GATHER', content: `GATHER:\n${fields}` }];

  // Emit LOOKUP_TABLES section if any lookup fields exist
  if (lookupFields.length > 0) {
    const tables = lookupFields.map((f) => serializeLookupTableEntry(f.name, f)).join('\n');
    edits.push({ section: 'LOOKUP_TABLES', content: `LOOKUP_TABLES:\n${tables}` });
  }

  return edits;
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm build --filter=studio`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/lib/abl-serializers.ts
git add apps/studio/src/lib/abl-serializers.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(studio): serialize lookup gather fields to LOOKUP_TABLES DSL section
EOF
)"
```

---

### Task 6: Manual smoke test

**Files:** None (testing only)

- [ ] **Step 1: Start Studio dev server**

Run: `pnpm dev --filter=studio`

- [ ] **Step 2: Open agent editor and navigate to Gather section**

Open an agent in Studio, go to the Gather Fields section.

- [ ] **Step 3: Add a new field, set type to "lookup"**

Verify:

- "lookup" appears in the type dropdown
- Badge shows "lookup" with purple accent color
- Lookup Configuration panel appears with segmented control

- [ ] **Step 4: Test Inline source**

- Default source should be "Inline"
- Tag input should allow adding/removing values
- Case Sensitive and Fuzzy Match toggles should work
- Fuzzy Threshold input appears only when Fuzzy Match is on

- [ ] **Step 5: Test API source**

- Switch to "API" segment
- Endpoint URL, Response Field, Timeout fields should be editable
- Headers section: click "+ Add", fill in key/value, verify remove works

- [ ] **Step 6: Test Collection source**

- Switch to "Collection" segment
- Table Name and Match Field inputs should be editable
- File upload zone should be visible

- [ ] **Step 7: Test save round-trip**

- Add a lookup field with inline values, save the agent
- Reload the page
- Verify the field loads back with type "lookup" and the inline values preserved

- [ ] **Step 8: Verify DSL output**

- Open the DSL editor overlay (Code button in header)
- Verify the saved DSL contains a `LOOKUP_TABLES:` block with the correct table entry
- Verify the gather field has `semantics: lookup: <table_name>`
