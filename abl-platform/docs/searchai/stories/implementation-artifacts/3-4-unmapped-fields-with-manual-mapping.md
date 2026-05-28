# Story 3.4: Unmapped Fields with Search and Manual Mapping

## Status: ready-for-dev

## Story

As a SearchAI administrator,
I want to search/filter unmapped fields and manually map them to canonical fields via a dialog,
So that I can handle fields that the LLM suggestion engine missed or mapped incorrectly.

## Context

**This is an ENHANCEMENT story.** The `UnmappedFieldsSection` component (FieldsTab.tsx lines 626-744) already loads and displays unmapped fields per connector. This story:

1. Adds a **debounced search/filter input** for client-side field name filtering
2. Adds a **"Map Manually" button** per unmapped field row
3. Adds a **ManualMappingDialog** with canonical field dropdown (type-compatible) and optional alias input
4. Uses existing `createManualMapping` API function and `POST /api/search-ai/mappings` endpoint

## Acceptance Criteria

- [ ] Debounced search input (300ms) above unmapped fields list, filters by field path (client-side)
- [ ] Search placeholder: "Filter unmapped fields..."
- [ ] Each unmapped field row has a "Map Manually" button
- [ ] Clicking "Map Manually" opens ManualMappingDialog pre-filled with the selected field's path and connector
- [ ] ManualMappingDialog shows:
  - Source field path (read-only display)
  - Canonical field dropdown filtered by type compatibility (string fields see text/keyword slots, number fields see number slots, etc.)
  - Optional alias input for display name
- [ ] Dropdown shows available canonical fields as: "alias (storageField)" or just "storageField" if no alias
- [ ] Submit calls `createManualMapping({ sourcePath, canonicalField, connectorId, canonicalSchemaId })` from `api/search-ai.ts`
- [ ] After mapping: `refreshMappings()` + `refreshStats()` + success toast + close dialog + reload unmapped for that connector
- [ ] Error shown in dialog on failure
- [ ] Empty state when all fields mapped: "All fields mapped! Great work."
- [ ] Search with no results: "No fields match your search."

## Existing Code Analysis

### Current UnmappedFieldsSection (FieldsTab.tsx:626-744)

```tsx
function UnmappedFieldsSection({
  knowledgeBaseId,
  sources,
}: {
  knowledgeBaseId: string;
  sources: Array<{ _id: string; name: string; connectorType?: string }>;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [unmappedData, setUnmappedData] = useState<
    Map<string, { fields: UnmappedField[]; total: number; mapped: number }>
  >(new Map());

  // Per-connector load with getUnmappedFields()
  // Renders connector cards with field lists (max 20 shown)
}
```

**What changes:** Add search input, "Map Manually" button per row, and ManualMappingDialog.

### Existing API function (api/search-ai.ts:729-742)

```typescript
export async function createManualMapping(data: {
  sourcePath: string;
  canonicalField: string;
  connectorId: string;
  canonicalSchemaId: string;
  transform?: { type: string };
}): Promise<{ mapping: FieldMappingData }> {
  const response = await apiFetch(engineUrl('/mappings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}
```

### UnmappedField type (api/search-ai.ts)

```typescript
export interface UnmappedField {
  path: string;
  type: string;
  label?: string;
  isCustom?: boolean;
}
```

### CanonicalField type (api/search-ai.ts)

```typescript
export interface CanonicalField {
  name: string; // alias name
  label: string; // display label
  type: string;
  storageField: string;
  indexed: boolean;
  filterable: boolean;
  aggregatable: boolean;
  sortable?: boolean;
  description?: string;
  enumValues?: Record<string, unknown>;
}
```

### Schema data available in parent

The parent `FieldsTab` component has `schema` (with `schema.fields` and `schema._id`) but does not currently pass it to `UnmappedFieldsSection`. The dialog needs canonical fields for the dropdown.

## File List

| File                                                 | Action | Description                                                                  |
| ---------------------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `apps/studio/src/components/search-ai/FieldsTab.tsx` | MODIFY | Enhance UnmappedFieldsSection with search, manual mapping button, and dialog |

## Tasks

### Task 1: Pass schema data and refresh callbacks to UnmappedFieldsSection

Update the component call site (line 494) and props interface:

```tsx
{
  activeTab === 'unmapped' && sources && sources.length > 0 && schema && (
    <UnmappedFieldsSection
      knowledgeBaseId={schema.knowledgeBaseId}
      canonicalSchemaId={schema._id}
      canonicalFields={schema.fields}
      sources={sources}
      onMappingCreated={() => {
        refreshMappings();
        refreshStats();
      }}
    />
  );
}
```

Update interface:

```typescript
function UnmappedFieldsSection({
  knowledgeBaseId,
  canonicalSchemaId,
  canonicalFields,
  sources,
  onMappingCreated,
}: {
  knowledgeBaseId: string;
  canonicalSchemaId: string;
  canonicalFields: CanonicalField[];
  sources: Array<{ _id: string; name: string; connectorType?: string }>;
  onMappingCreated: () => void;
}) {
```

### Task 2: Add debounced search input

Add state and filter logic inside `UnmappedFieldsSection`:

```typescript
const [searchQuery, setSearchQuery] = useState('');
const [debouncedQuery, setDebouncedQuery] = useState('');

useEffect(() => {
  const timer = setTimeout(() => setDebouncedQuery(searchQuery), 300);
  return () => clearTimeout(timer);
}, [searchQuery]);

// Apply filter inside each connector's field list
const filterFields = (fields: UnmappedField[]) =>
  debouncedQuery
    ? fields.filter((f) => f.path.toLowerCase().includes(debouncedQuery.toLowerCase()))
    : fields;
```

Render above the connector cards:

```tsx
<Input
  placeholder="Filter unmapped fields..."
  value={searchQuery}
  onChange={(e) => setSearchQuery(e.target.value)}
  className="mb-4"
/>
```

### Task 3: Add "Map Manually" button per row

Add state for the mapping dialog:

```typescript
const [mappingTarget, setMappingTarget] = useState<{
  field: UnmappedField;
  connectorId: string;
} | null>(null);
```

Modify the field row (currently lines 708-726) to include a button:

```tsx
<div
  key={field.path}
  className="flex items-center gap-3 text-xs py-1.5 px-2 rounded hover:bg-background-muted"
>
  <span className="font-mono text-muted flex-1">{field.path}</span>
  <Badge variant="default" className="text-xs">
    {TYPE_DISPLAY[field.type] || field.type}
  </Badge>
  {field.label && <span className="text-subtle truncate max-w-[150px]">{field.label}</span>}
  {field.isCustom && (
    <Badge variant="warning" className="text-xs">
      Custom
    </Badge>
  )}
  <Button
    size="sm"
    variant="secondary"
    onClick={() => setMappingTarget({ field, connectorId: source._id })}
  >
    Map Manually
  </Button>
</div>
```

Update the per-connector rendering to use `filterFields`:

```tsx
const filtered = filterFields(data.fields);
// Render filtered instead of data.fields
// Show "No fields match your search." when filtered is empty but data.fields is not
```

### Task 4: Implement ManualMappingDialog

Add inline within `UnmappedFieldsSection` (or as a local function component):

```typescript
// Type compatibility mapping for dropdown filtering
const TYPE_COMPAT: Record<string, string[]> = {
  string: ['string', 'keyword', 'text'],
  keyword: ['string', 'keyword', 'text'],
  text: ['string', 'keyword', 'text'],
  number: ['number', 'float', 'integer'],
  float: ['number', 'float', 'integer'],
  integer: ['number', 'float', 'integer'],
  date: ['date'],
  boolean: ['boolean'],
  array: ['array'],
};

const compatibleFields = useMemo(() => {
  if (!mappingTarget) return [];
  const compatTypes = TYPE_COMPAT[mappingTarget.field.type] || [mappingTarget.field.type];
  return canonicalFields.filter((f) => compatTypes.includes(f.type));
}, [mappingTarget, canonicalFields]);
```

Dialog state and handler:

```typescript
const [selectedCanonical, setSelectedCanonical] = useState('');
const [mappingSaving, setMappingSaving] = useState(false);
const [mappingError, setMappingError] = useState<string | null>(null);

const handleCreateMapping = async () => {
  if (!mappingTarget || !selectedCanonical) return;
  setMappingSaving(true);
  setMappingError(null);
  try {
    await createManualMapping({
      sourcePath: mappingTarget.field.path,
      canonicalField: selectedCanonical,
      connectorId: mappingTarget.connectorId,
      canonicalSchemaId,
      transform: { type: 'direct' },
    });
    toast.success('Field mapped successfully');
    onMappingCreated();
    // Reload unmapped for this connector
    loadUnmapped(mappingTarget.connectorId);
    setMappingTarget(null);
    setSelectedCanonical('');
  } catch (err) {
    setMappingError(sanitizeError(err, 'Failed to create mapping'));
  } finally {
    setMappingSaving(false);
  }
};
```

Render dialog:

```tsx
<Dialog
  open={!!mappingTarget}
  onClose={() => {
    setMappingTarget(null);
    setSelectedCanonical('');
    setMappingError(null);
  }}
  title="Map Field Manually"
  maxWidth="sm"
>
  <div className="space-y-4">
    <div>
      <label className="text-sm font-medium text-foreground">Source Field</label>
      <div className="mt-1 font-mono text-sm text-muted bg-background-muted p-2 rounded">
        {mappingTarget?.field.path}
      </div>
    </div>

    <Select
      label="Canonical Field"
      options={compatibleFields.map((f) => ({
        value: f.storageField,
        label: f.label ? `${f.label} (${f.storageField})` : f.storageField,
      }))}
      value={selectedCanonical}
      onChange={(e) => setSelectedCanonical(e.target.value)}
      placeholder="Select a canonical field..."
    />

    {compatibleFields.length === 0 && mappingTarget && (
      <p className="text-xs text-warning">
        No type-compatible canonical fields available for type "{mappingTarget.field.type}".
      </p>
    )}

    {mappingError && <p className="text-sm text-error">{mappingError}</p>}

    <div className="flex gap-3 pt-2">
      <Button variant="secondary" onClick={() => setMappingTarget(null)} className="flex-1">
        Cancel
      </Button>
      <Button
        onClick={handleCreateMapping}
        loading={mappingSaving}
        disabled={!selectedCanonical}
        className="flex-1"
      >
        Map Field
      </Button>
    </div>
  </div>
</Dialog>
```

### Task 5: Update empty states

When all connectors report zero unmapped fields:

```tsx
{
  Array.from(unmappedData.values()).every((d) => d.fields.length === 0) &&
    unmappedData.size === sources.length && (
      <EmptyState
        icon={<Check className="w-6 h-6" />}
        title="All fields mapped!"
        description="Great work."
      />
    );
}
```

Per-connector "no search results" state:

```tsx
{
  filtered.length === 0 && data.fields.length > 0 && (
    <div className="mt-2 text-xs text-muted">No fields match your search.</div>
  );
}
```

### Task 6: Add required imports

Add `useEffect` to the existing React import (line 12) if not present. Add `createManualMapping` to the search-ai import block (line 28-38):

```typescript
import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  // ... existing imports ...
  createManualMapping,
} from '../../api/search-ai';
```

## Previous Story Intelligence

- `getLazyModel` mandatory in apps/search-ai — never import models directly
- Error format: `{ error: { code, message } }` for new endpoints
- `status: 'active'` in model = "confirmed" in UI, `status: 'suggested'` = "pending" in UI
- FieldMapping.canonicalField = storage field name (not alias)
- Run `npx prettier --write <files>` on ALL changed files before finishing
- Import UI from barrel: `import { Button } from '../ui/Button'`
- Framer Motion layoutId must be unique
- `connectorName` helper already exists in FieldsTab (line 149)
- POST /mappings creates with `status='active'`, `confidence=1.0`, `suggestedBy='user'`
- `createManualMapping` already exists in `api/search-ai.ts` (line 729) — do NOT recreate

## Build & Test Commands

```bash
pnpm build --filter=@agent-platform/studio
npx prettier --write apps/studio/src/components/search-ai/FieldsTab.tsx
```
