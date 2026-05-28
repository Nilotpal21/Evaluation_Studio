# Story 3.1: FieldsTab Tabbed Layout and My Fields Table

## Status: ready-for-dev

## Story

As a SearchAI administrator,
I want FieldsTab organized into three tabs with badge counts, and the "My Fields" tab showing confirmed mappings in a sortable table with edit/remove actions,
So that I can navigate between field states and manage confirmed mappings efficiently.

**This combines original stories 3.1 (tab shell) and 3.2 (My Fields section).**

## Context

**This is an ENHANCEMENT story.** `FieldsTab.tsx` (770 lines) already exists with 3 scrollable sections. This story:

1. Converts the scrollable layout to a **tabbed layout** using the existing `Tabs` component
2. Refactors the "My Fields" section from expandable canonical fields into a **sortable DataTable** with mapping-centric rows
3. Adds a **tab-stats SWR hook** for live badge counts (depends on Story 3.8 backend)
4. Adds **Remove** action for confirmed mappings

## Acceptance Criteria

- [ ] FieldsTab uses `Tabs` component with 3 tabs: "My Fields (N)", "Suggested (N)", "Unmapped (N)"
- [ ] Tab counts fetched via SWR from `GET /api/mappings/tab-stats?knowledgeBaseId={id}` (Story 3.8)
- [ ] "Suggested" tab is active by default (most actionable)
- [ ] Tab switching shows/hides corresponding section content
- [ ] My Fields section uses `DataTable` with sortable columns: Source Field, Canonical Field, Confidence, Actions
- [ ] Source Field column shows `sourcePath` in mono font
- [ ] Canonical Field column shows alias label as primary text, storageField in muted mono: `"Last Updated (updated_at)"`
- [ ] Confidence column shows color-coded badge (success ≥0.8, warning ≥0.5, error <0.5)
- [ ] Actions column has Edit and Remove icon buttons
- [ ] Edit button opens the existing field edit dialog (already implemented)
- [ ] Remove button shows `ConfirmDialog` → calls `DELETE /api/mappings/:id` → refreshes data + toast
- [ ] Empty state: "No mapped fields yet. Review suggestions in the 'Suggested' tab."
- [ ] Keyboard navigable tabs (left/right arrows via Tabs component built-in)

## Existing Code Analysis

### Current FieldsTab Structure (FieldsTab.tsx)

```
<div className="space-y-8">
  {/* Section 1: My Fields — expandable canonical field rows */}
  <div>...</div>                              ← REPLACE with DataTable

  {/* Section 2: Suggested Mappings */}
  {suggestedMappings.length > 0 && <div>...</div>}  ← WRAP in tab panel

  {/* Section 3: Unmapped Fields */}
  {sources && <UnmappedFieldsSection />}      ← WRAP in tab panel

  {/* Add/Edit Field Dialog */}
  <Dialog>...</Dialog>                         ← KEEP (shared across tabs)
</div>
```

### Tabs Component API (components/ui/Tabs.tsx)

```typescript
interface Tab {
  id: string;
  label: string;
  icon?: React.ReactNode;
  count?: number;  // ← Already supports badge counts
}

<Tabs
  tabs={tabs}
  activeTab={activeTab}
  onTabChange={setActiveTab}
  layoutId="fields-tabs"
/>
```

### DataTable Component API (components/ui/DataTable.tsx)

```typescript
interface Column<T> {
  key: string;
  label: string;
  render: (row: T, index: number) => React.ReactNode;
  sortable?: boolean;
  sortValue?: (row: T) => string | number;
  width?: string;
}

<DataTable<FieldMappingData>
  columns={myFieldsColumns}
  data={confirmedMappings}
  keyExtractor={(m) => m._id}
  emptyMessage="No mapped fields yet."
/>
```

### Existing data fetching (FieldsTab.tsx:93-101)

```typescript
const { data: schemaData, mutate: mutateSchema } = useSWR<{ schema: CanonicalSchemaData }>(
  `/api/search-ai/schemas/${schemaLookupId}`,
);
const schema = schemaData?.schema ?? null;
const schemaId = schema?._id ?? null;
const { mappings, refresh: refreshMappings } = useSearchAIMappings(schemaId);
```

### Existing API functions (api/search-ai.ts)

```typescript
export async function confirmMapping(mappingId: string): Promise<{ mapping: FieldMappingData }>;
export async function rejectMapping(mappingId: string): Promise<{ mapping: FieldMappingData }>;
// NOTE: No deleteMapping function exists yet — need to add
```

### FieldMappingData type (api/search-ai.ts:122-141)

```typescript
export interface FieldMappingData {
  _id: string;
  tenantId: string;
  canonicalSchemaId: string;
  canonicalField: string; // storage field name
  connectorId: string;
  sourcePath: string;
  transform: FieldMappingTransform;
  confidence: number;
  status: string; // 'suggested' | 'confirmed' | 'active'
  suggestedBy: string;
  reviewedBy: string | null;
  aliasName?: string | null; // enriched by backend
  aliasLabel?: string | null; // enriched by backend
}
```

### ConfirmDialog Component (components/ui/ConfirmDialog.tsx)

Already exists for destructive action confirmation. Use for Remove action.

## File List

| File                                                 | Action | Description                                               |
| ---------------------------------------------------- | ------ | --------------------------------------------------------- |
| `apps/studio/src/components/search-ai/FieldsTab.tsx` | MODIFY | Convert to tabbed layout, refactor My Fields to DataTable |
| `apps/studio/src/hooks/useFieldsTabStats.ts`         | CREATE | SWR hook for tab badge counts                             |
| `apps/studio/src/api/search-ai.ts`                   | MODIFY | Add `deleteMapping()` function                            |

## Tasks

### Task 1: Create useFieldsTabStats hook

Create `apps/studio/src/hooks/useFieldsTabStats.ts`:

```typescript
import useSWR from 'swr';

interface TabStats {
  confirmedCount: number;
  suggestedCount: number;
  unmappedCount: number;
  totalFields: number;
}

export function useFieldsTabStats(knowledgeBaseId: string | undefined) {
  const key = knowledgeBaseId
    ? `/api/search-ai/mappings/tab-stats?knowledgeBaseId=${knowledgeBaseId}`
    : null;
  const { data, error, isLoading, mutate } = useSWR<TabStats>(key);

  return {
    stats: data ?? { confirmedCount: 0, suggestedCount: 0, unmappedCount: 0, totalFields: 0 },
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}
```

### Task 2: Add deleteMapping to API client

Add to `apps/studio/src/api/search-ai.ts` after `rejectMapping`:

```typescript
export async function deleteMapping(mappingId: string): Promise<void> {
  const response = await apiFetch(engineUrl(`/mappings/${mappingId}`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error?.message || body.error || 'Failed to delete mapping');
  }
}
```

**NOTE:** Verify DELETE endpoint exists in mappings.ts. If not, the backend needs it added (coordinate with Story 3.8 developer or add it here).

### Task 3: Refactor FieldsTab to tabbed layout

Replace the scrollable section layout with tabs. The key structural change:

**Before (current):**

```tsx
<div className="space-y-8">
  <div>{/* My Fields section */}</div>
  {suggestedMappings.length > 0 && <div>{/* Suggested section */}</div>}
  {sources && <UnmappedFieldsSection />}
  <Dialog>{/* Edit dialog */}</Dialog>
</div>
```

**After (new):**

```tsx
<div className="space-y-6">
  <Tabs
    tabs={[
      { id: 'suggested', label: 'Suggested', count: stats.suggestedCount },
      { id: 'my-fields', label: 'My Fields', count: stats.confirmedCount },
      { id: 'unmapped', label: 'Unmapped', count: stats.unmappedCount },
    ]}
    activeTab={activeTab}
    onTabChange={setActiveTab}
    layoutId="fields-tab-indicator"
  />

  {activeTab === 'my-fields' && (
    <MyFieldsSection
      mappings={confirmedMappings}
      onEdit={openEditField}
      onRemove={handleRemoveMapping}
      connectorName={connectorName}
    />
  )}

  {activeTab === 'suggested' && (
    <div>{/* Existing suggested mappings content — unchanged for now (Wave 2) */}</div>
  )}

  {activeTab === 'unmapped' && sources && schema && (
    <UnmappedFieldsSection knowledgeBaseId={schema.knowledgeBaseId} sources={sources} />
  )}

  <Dialog>{/* Edit dialog — shared across tabs, unchanged */}</Dialog>
</div>
```

**State additions:**

```typescript
const [activeTab, setActiveTab] = useState('suggested'); // Default to Suggested
const { stats, refresh: refreshStats } = useFieldsTabStats(knowledgeBaseId);
```

### Task 4: Implement MyFieldsSection with DataTable

Extract My Fields into a focused component (can be inline or separate function in same file):

```tsx
function MyFieldsSection({
  mappings,
  onEdit,
  onRemove,
  connectorName,
}: {
  mappings: FieldMappingData[];
  onEdit: (field: CanonicalField) => void; // Opens existing edit dialog
  onRemove: (mapping: FieldMappingData) => void;
  connectorName: (id: string) => string;
}) {
  const columns: Column<FieldMappingData>[] = [
    {
      key: 'sourcePath',
      label: 'Source Field',
      sortable: true,
      sortValue: (m) => m.sourcePath,
      render: (m) => (
        <div>
          <span className="font-mono text-xs">{m.sourcePath}</span>
          <div className="text-xs text-subtle">{connectorName(m.connectorId)}</div>
        </div>
      ),
    },
    {
      key: 'canonicalField',
      label: 'Canonical Field',
      sortable: true,
      sortValue: (m) => m.aliasLabel || m.canonicalField,
      render: (m) => (
        <div>
          <span className="font-medium">{m.aliasLabel || m.aliasName || m.canonicalField}</span>
          {m.aliasLabel && (
            <span className="ml-1.5 text-xs text-muted font-mono">({m.canonicalField})</span>
          )}
        </div>
      ),
    },
    {
      key: 'confidence',
      label: 'Confidence',
      sortable: true,
      sortValue: (m) => m.confidence,
      render: (m) => (
        <Badge variant={confidenceVariant(m.confidence)} className="text-xs">
          {Math.round(m.confidence * 100)}%
        </Badge>
      ),
      width: '100px',
    },
    {
      key: 'actions',
      label: '',
      render: (m) => (
        <div className="flex gap-1">
          <button
            onClick={() => onEdit(m)}
            className="p-1.5 text-muted hover:text-foreground rounded-lg transition-default"
            title="Edit"
          >
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onRemove(m)}
            className="p-1.5 text-muted hover:text-error rounded-lg transition-default"
            title="Remove"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ),
      width: '80px',
    },
  ];

  if (mappings.length === 0) {
    return (
      <EmptyState
        icon={<Check className="w-6 h-6" />}
        title="No mapped fields yet"
        description="Review suggestions in the 'Suggested' tab to start mapping fields."
      />
    );
  }

  return <DataTable columns={columns} data={mappings} keyExtractor={(m) => m._id} />;
}
```

### Task 5: Implement Remove mapping action

Add to FieldsTab:

```typescript
const [removingMapping, setRemovingMapping] = useState<FieldMappingData | null>(null);

const handleRemoveMapping = useCallback(async () => {
  if (!removingMapping) return;
  try {
    await deleteMapping(removingMapping._id);
    refreshMappings();
    refreshStats();
    toast.success('Mapping removed');
  } catch (err) {
    toast.error(sanitizeError(err, 'Failed to remove mapping'));
  } finally {
    setRemovingMapping(null);
  }
}, [removingMapping, refreshMappings, refreshStats]);
```

Add ConfirmDialog in render:

```tsx
<ConfirmDialog
  open={!!removingMapping}
  onClose={() => setRemovingMapping(null)}
  onConfirm={handleRemoveMapping}
  title="Remove Field Mapping"
  description={`Remove mapping for "${removingMapping?.sourcePath}" → "${removingMapping?.aliasLabel || removingMapping?.canonicalField}"? This cannot be undone.`}
  confirmLabel="Remove"
  variant="destructive"
/>
```

## Previous Story Intelligence

- **FieldsTab.tsx already exists (770 lines)** — do NOT rewrite from scratch. Modify the existing component structure.
- **Tabs component already supports `count` prop** — no need to extend it.
- **DataTable has built-in sorting** — use `sortable: true` + `sortValue` on columns.
- **SWR pattern**: Follow `useSearchAIMappings` hook pattern for the new `useFieldsTabStats` hook.
- **Import UI from barrel**: `import { Button } from '../ui/Button'` not direct paths.
- **Framer Motion `layoutId`**: Use unique layoutId (`"fields-tab-indicator"`) to avoid conflicts with DetailPageShell's tab indicator.
- **`status: 'active'`** in model = "confirmed" in UI. `status: 'suggested'` = "pending" in UI. Don't confuse these.
- **Edit action**: The current edit dialog edits canonical field properties (name, label, type, capabilities, enums). For the My Fields table, "Edit" on a mapping row should find the corresponding canonical field and open the same dialog. Use `schema.fields.find(f => f.storageField === mapping.canonicalField)` to resolve.
- **`connectorName` helper already exists** in FieldsTab — reuse it.
- **Run `npx prettier --write <files>` on ALL changed files before finishing.** lint-staged WILL silently revert your work if files aren't formatted.

## Build & Test Commands

```bash
# Studio uses Next.js — no explicit build step needed for dev, but verify:
pnpm build --filter=@agent-platform/studio
npx prettier --write apps/studio/src/components/search-ai/FieldsTab.tsx apps/studio/src/hooks/useFieldsTabStats.ts apps/studio/src/api/search-ai.ts
```
