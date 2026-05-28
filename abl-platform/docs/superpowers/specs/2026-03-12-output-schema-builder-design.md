# Output Schema Builder — Design Spec

## Goal

Replace the raw JSON textarea for the `outputSchema` field in the LLM Evaluate node config with a dual-mode editor: a field-by-field builder (default) and a raw JSON fallback.

## Context

The LLM Evaluate node uses `outputSchema` (a JSON Schema object) to instruct the LLM on the expected response shape. Currently, users must write raw JSON Schema — error-prone and unfriendly. Most evaluation schemas are flat objects with simple field types, so a visual builder covers the common case while JSON mode handles edge cases.

## Data Model

### No service-side changes

`config.outputSchema` remains a pure JSON Schema object. The `llm-evaluate.service.ts` consumes it unchanged. Ajv validation and strict retry logic are unaffected.

### New config value: `outputSchemaMode`

A sibling value alongside `outputSchema` in the step's `config` object:

```typescript
config.outputSchemaMode: 'fields' | 'json'
```

Purpose: tells the UI which editor mode to render when the config is loaded. Stored in the pipeline step config in MongoDB. Not consumed by the service — purely a UI hint.

This value is **not** declared in activity metadata or seed data. The `SchemaFieldBuilder` component reads it from `values.outputSchemaMode` and writes it via `onChange('outputSchemaMode', mode)` — the same mechanism all config fields use. It is invisible to `ConfigSchemaForm`'s normal field rendering because it has no corresponding `ConfigField` entry.

Default: `'fields'` when `outputSchemaMode` is absent or undefined.

### No metadata or seed data changes

`activity-metadata.ts` and `node-type-definitions.json` are unchanged. The `outputSchemaMode` value lives only in the saved pipeline step config, managed entirely by the UI component.

## UI Design

### Location

The schema builder replaces the current `object` type rendering for the `outputSchema` field in `ConfigSchemaForm.tsx`. It is a new component: `SchemaFieldBuilder.tsx`.

In `ConfigSchemaForm`, detect the field by name (`field.name === 'outputSchema'`) in `FieldRenderer` and render `SchemaFieldBuilder` instead of `JsonEditor`. Pass `values` and `onChange` so the component can read/write both `outputSchema` and `outputSchemaMode`.

The `strict` field (also `group: 'schema'`) remains a standalone toggle rendered normally by `FieldRenderer`. It is not affected by this change.

### Mode Toggle

A segmented button at the top of the output schema section:

```
[Fields] [JSON]
```

- **Fields** (default): visual field-by-field builder
- **JSON**: raw textarea (current `JsonEditor` behavior)

### Fields Mode

Each field is a horizontal row with:

| Element     | Input type        | Notes                                              |
| ----------- | ----------------- | -------------------------------------------------- |
| Name        | text input (mono) | Validated: `/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/`       |
| Type        | dropdown          | Options: `string`, `number`, `boolean`, `string[]` |
| Description | text input        | Optional — omitted from schema property when empty |
| Remove      | icon button (X)   | Deletes the row                                    |

Below the existing fields, a dashed-border "add" row with the same inputs plus a "+" button.

Below all fields, a **read-only JSON Schema preview** showing the generated schema. This lets users verify what the LLM will see in its system prompt.

All defined fields are included in the JSON Schema's `required` array. No reordering in V1 — fields appear in insertion order.

### JSON Mode

The existing `JsonEditor` textarea — raw JSON Schema input with parse validation on blur.

### Mode Switching

**Fields to JSON:** Populate the textarea with the generated JSON Schema from the builder fields. Set `outputSchemaMode` to `'json'`.

**JSON to Fields:** Parse the JSON Schema. If it represents a flat object with only supported types (`string`, `number`, `boolean`, `array` with `items.type === 'string'`), populate the builder rows and set `outputSchemaMode` to `'fields'`. Otherwise, show an inline warning: "This schema uses types not supported by the field builder." and don't switch.

## Generated JSON Schema Format

Given fields:

| Name    | Type     | Description          |
| ------- | -------- | -------------------- |
| score   | number   | Quality score 0-1    |
| summary | string   | Brief summary        |
| issues  | string[] | List of issues found |
| passed  | boolean  |                      |

Generates:

```json
{
  "type": "object",
  "properties": {
    "score": { "type": "number", "description": "Quality score 0-1" },
    "summary": { "type": "string", "description": "Brief summary" },
    "issues": {
      "type": "array",
      "items": { "type": "string" },
      "description": "List of issues found"
    },
    "passed": { "type": "boolean" }
  },
  "required": ["score", "summary", "issues", "passed"]
}
```

Note: `passed` has no `description` key because the user left it empty.

## File Changes

| File                                                          | Change                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/pipelines/SchemaFieldBuilder.tsx` | **New** — dual-mode schema editor component                                                 |
| `apps/studio/src/components/pipelines/ConfigSchemaForm.tsx`   | Detect `outputSchema` field by name and render `SchemaFieldBuilder` instead of `JsonEditor` |

## What Does NOT Change

- `llm-evaluate.service.ts` — consumes `outputSchema` as-is
- Ajv validation / strict retry loop
- ClickHouse schema or storage
- `expression-evaluator.ts` / template resolution
- `activity-metadata.ts` — no new fields
- `node-type-definitions.json` — no new fields
- Any other node type's config rendering

## Edge Cases

- **Empty builder**: no fields defined = `outputSchema` is `undefined` (not set). `outputSchemaMode` stays `'fields'` — on next load the UI shows an empty field builder.
- **Duplicate field names**: validate on add — reject if name already exists (case-sensitive).
- **Field name validation**: must match `/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/`. Input is trimmed before validation.
- **Switching to fields from complex JSON**: warn inline and stay in JSON mode if unsupported types are detected.
- **Existing pipelines with `outputSchema` but no `outputSchemaMode`**: default to `'json'` mode (backward compatible — existing schemas were entered as JSON).
- **i18n**: all user-facing strings (toggle labels, warning messages, placeholders) use translation keys under the `pipelines` namespace via `useTranslations('pipelines')`.
