# Lookup Field Type in Gather Editor

**Date:** 2026-03-24
**Status:** Approved
**Branch:** KI0326/feature/enum

## Problem

Studio has no way to create or edit lookup tables in the agent editor. Lookup tables can only be defined via DSL (`LOOKUP_TABLES:` block) or in project-level Runtime Config settings. When a user wants a gather field validated against a lookup table, they must leave the agent editor, switch to DSL, and manually write the configuration.

## Decision

Add `lookup` as a field type in the Gather Editor's type dropdown. When selected, the field card expands to show an inline Lookup Configuration panel with a segmented control to switch between three source types.

### Approach: Inline Definition

The full lookup table configuration lives inside the gather field card (not a reference to a separate table). This keeps the editing experience self-contained with no context switching.

## Design

### Field Type Dropdown

Add `lookup` to `FIELD_TYPE_OPTIONS` in `GatherEditor.tsx`:

```ts
const FIELD_TYPE_OPTIONS = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'boolean' },
  { value: 'date', label: 'date' },
  { value: 'enum', label: 'enum' },
  { value: 'lookup', label: 'lookup' },
];
```

### Lookup Configuration Panel

Rendered conditionally when `field.type === 'lookup'`. Positioned below the standard field inputs (name, type, prompt, required) with a purple left-border accent to visually distinguish it.

#### Segmented Control (Source Selection)

Three segments: **Inline** | **API** | **Collection**. Switching the segment changes the source-specific fields below.

#### Source: Inline

- **Values**: Tag input (reuse the `EnumTagInput` component pattern already in GatherEditor). Type a value, press Enter or comma to add. Backspace removes the last tag. Duplicate prevention built in.

#### Source: API

- **Endpoint URL**: Text input for the lookup API endpoint
- **Response Field**: Text input for the field name to extract from the API response
- **Timeout (ms)**: Number input (min: 100, max: 30000, default: 5000)
- **Headers**: Key-value list with add/remove. Each row shows `key : value` with a delete button. "+ Add" link to append a new row.

#### Source: Collection

- **Table Name**: Text input for the MongoDB collection table name
- **Match Field**: Text input for the field to match against (default: "name")
- **Upload Data**: File upload zone accepting `.csv` or `.json` (max 1MB). Shows upload status with entry count on success. Uses the existing `/api/projects/:projectId/lookup-tables/:tableName/upload` endpoint.

#### Shared Controls (all sources)

Bottom bar with:

- **Case Sensitive** toggle (default: off)
- **Fuzzy Match** toggle (default: off)
- **Fuzzy Threshold** number input (shown only when fuzzy is on, default: 0.85, range: 0-1, step: 0.05)

### Data Model

Extend `GatherFieldData` in `apps/studio/src/components/agent-editor/types.ts`:

```ts
export interface GatherFieldData {
  // ... existing fields ...

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
}
```

### Serialization

`serializeGatherToABL` in `apps/studio/src/lib/abl-serializers.ts` currently returns only `{ section: 'GATHER', content: ... }`. For lookup fields, it must also emit a `LOOKUP_TABLES:` section edit.

Changes to `serializeGatherToABL`:

1. Scan gather fields for any with `type === 'lookup'`
2. For each lookup field, generate a `LOOKUP_TABLES:` DSL entry:
   - Table name = `field.name` (inline/api) or `field.lookupTableName` (collection)
   - Emit source-specific properties (values, endpoint, headers block, table_name, field, etc.)
   - Emit matching config (case_sensitive, fuzzy_match, fuzzy_threshold)
3. On the gather field line, emit `semantics.lookup: <table_name>` so the compiler wires the reference
4. Return both `{ section: 'GATHER', content: ... }` and `{ section: 'LOOKUP_TABLES', content: ... }`

`useEditorSave.ts` does not need changes — it already calls `serializeGatherToABL` and spreads the result into the edits array, so the extra `LOOKUP_TABLES` section edit will be included automatically.

### Hydration (IR -> Editor Store)

`agent-detail-store.ts` loads agent IR into the editor sections. For lookup fields, it must reverse-map IR lookup tables back into `GatherFieldData`:

1. When building the `gather` section data, check if the gather field has `semantics.lookup` set
2. If so, find the matching entry in `ir.lookup_tables[semantics.lookup]`
3. Populate the `lookup*` fields on `GatherFieldData` from the lookup table IR:
   - `lookupSource` = `table.source`
   - `lookupValues` = `table.values` (inline)
   - `lookupEndpoint` = `table.endpoint` (api)
   - `lookupField` = `table.field` (api/collection)
   - `lookupTimeoutMs` = `table.timeout_ms` (api)
   - `lookupHeaders` = `table.headers` (api)
   - `lookupTableName` = `table.table_name` (collection)
   - `lookupCaseSensitive` = `table.case_sensitive`
   - `lookupFuzzyMatch` = `table.fuzzy_match`
   - `lookupFuzzyThreshold` = `table.fuzzy_threshold`
4. Set `field.type = 'lookup'` so the GatherEditor renders the lookup config panel

### Visual Design

- Lookup config panel uses a purple left-border (`border-left: 3px solid accent`) matching the existing field card style
- Segmented control uses the `SegmentedControl` UI component (already exists in `apps/studio/src/components/ui/SegmentedControl.tsx`)
- Tag input reuses the `EnumTagInput` pattern from the same file
- Header key-value editor follows the same row pattern as the existing RuntimeConfigTab lookup table editor
- File upload zone follows the existing RuntimeConfigTab collection upload pattern

### Badge Color

Add `lookup` to `TYPE_BADGE_COLORS`:

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

## Files to Modify

| File                                                                | Change                                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/studio/src/components/agent-editor/sections/GatherEditor.tsx` | Add `lookup` type, `LookupConfigPanel` component, header key-value editor        |
| `apps/studio/src/components/agent-editor/types.ts`                  | Extend `GatherFieldData` with lookup fields                                      |
| `apps/studio/src/store/agent-detail-store.ts`                       | Map IR lookup tables to `GatherFieldData` lookup fields on load                  |
| `apps/studio/src/lib/abl-serializers.ts`                            | Extend `serializeGatherToABL` to emit `LOOKUP_TABLES:` section for lookup fields |

## No Backend Changes

All backend work is already complete on this branch:

- Parser: handles `LOOKUP_TABLES:` with `headers:` blocks
- Compiler: compiles lookup tables to IR, generates enum validation
- IR Schema: `LookupTableIR.headers`, `GatherField.enum_values`
- Runtime: lookup resolver with LRU cache, fuzzy match, header passthrough
- Runtime: LLM prompt injection of lookup values

## Wireframes

Mockups saved to `.superpowers/brainstorm/6218-1774349839/`:

- `lookup-field-approaches.html` — Inline vs Reference comparison
- `lookup-all-sources.html` — All 3 source types detailed wireframes
