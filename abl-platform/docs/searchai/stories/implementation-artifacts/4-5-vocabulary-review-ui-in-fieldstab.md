# Story 4.5: Vocabulary Review UI in FieldsTab

## Status: ready-for-dev

## Story

As a SearchAI administrator,
I want to review auto-generated vocabulary terms for each canonical field directly from the My Fields tab,
So that I can approve, reject, or inspect the terms that the LLM will use during query resolution.

## Context

**This is a BROWNFIELD enhancement to `FieldsTab.tsx` (1205 lines).**

The existing My Fields tab (lines 500-525) shows confirmed mappings in a DataTable with columns: Source Field, Canonical Field, Confidence, and Actions (Edit + Remove). This story adds a "Review Vocabulary" button to the actions column that opens a dialog showing generated vocabulary terms for that field's alias name (fieldRef).

The vocabulary data is served by Story 4.6 API endpoints already implemented in `apps/search-ai/src/routes/vocabulary.ts`:

- `GET /api/indexes/:indexId/vocabulary/:fieldRef` -- returns `{ entries, total, fieldRef }`
- `POST /api/indexes/:indexId/vocabulary/review` -- accepts `{ action, termIds }`, returns `{ success, updatedCount }`

## Acceptance Criteria

- [ ] "Review Vocabulary" icon button (BookOpen) appears in the My Fields actions column, after Edit and before Remove
- [ ] Button only renders when the mapping has an `aliasName` (i.e., the canonical field has a vocabulary-eligible alias)
- [ ] Clicking opens `VocabularyReviewDialog` with field's alias name as `fieldRef`
- [ ] Dialog fetches terms via SWR from `GET /api/search-ai/indexes/:indexId/vocabulary/:fieldRef`
- [ ] Terms grouped by `generatedBy` source: "Auto-Generated" (purple badge) and "Manual" (info badge)
- [ ] Each term row shows: checkbox, term text, aliases (comma-separated), confidence badge, enabled status toggle
- [ ] Confidence badge uses same color scheme as FieldsTab: success >= 0.8, warning >= 0.5, error < 0.5
- [ ] Sticky action bar appears when one or more terms are selected: "Approve Selected" and "Reject Selected" buttons
- [ ] Approve calls `POST /api/search-ai/indexes/:indexId/vocabulary/review` with `{ action: 'approve', termIds }`
- [ ] Reject calls the same endpoint with `{ action: 'reject', termIds }`
- [ ] After review action completes, SWR cache is mutated to refresh the list
- [ ] Loading state shown while fetching terms
- [ ] Empty state when no vocabulary terms exist for the field
- [ ] Error state when API call fails
- [ ] Dialog has `maxWidth="lg"` to accommodate the term table

## Verified Component Signatures

### Dialog (components/ui/Dialog.tsx)

```typescript
interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '4xl' | '5xl';
}
```

### Badge (components/ui/Badge.tsx)

```typescript
type BadgeVariant = 'default' | 'accent' | 'success' | 'warning' | 'error' | 'info' | 'purple';
interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
}
```

### DataTable (components/ui/DataTable.tsx)

```typescript
interface Column<T> {
  key: string;
  label: string;
  render: (row: T, index: number) => React.ReactNode;
  sortable?: boolean;
  sortValue?: (row: T) => string | number;
  width?: string;
}
interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor?: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  className?: string;
}
```

### Button (components/ui/Button.tsx)

```typescript
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
}
```

### EmptyState (components/ui/EmptyState.tsx)

```typescript
interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}
```

## File List

| File                                                                                      | Action | Description                                            |
| ----------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------ |
| `apps/studio/src/api/search-ai.ts`                                                        | MODIFY | Add `getVocabularyByFieldRef`, `reviewVocabularyTerms` |
| `apps/studio/src/components/search-ai/VocabularyReviewDialog.tsx`                         | CREATE | New dialog component for vocabulary term review        |
| `apps/studio/src/components/search-ai/FieldsTab.tsx`                                      | MODIFY | Add BookOpen button to My Fields actions column        |
| `apps/studio/src/app/api/search-ai/indexes/[id]/vocabulary/[entryId]/route.ts`            | MODIFY | Add GET handler for vocabulary-by-fieldRef proxy       |
| `apps/studio/src/app/api/search-ai/indexes/[id]/vocabulary/review/route.ts`               | CREATE | POST proxy for vocabulary review endpoint              |
| `docs/searchai/stories/implementation-artifacts/4-5-vocabulary-review-ui-in-fieldstab.md` | CREATE | This story file                                        |

## API Response Shapes

### GET /:indexId/vocabulary/:fieldRef

```json
{
  "entries": [
    {
      "id": "entry_1710...",
      "term": "critical",
      "aliases": ["urgent", "blocker"],
      "description": "High-priority items",
      "fieldRef": "priority_level",
      "capabilities": {
        "canFilter": true,
        "canDisplay": true,
        "canAggregate": false,
        "canSort": false
      },
      "enabled": true,
      "confidence": 0.92,
      "generatedBy": "auto",
      "usageCount": 5,
      "lastUsed": "2026-03-12T...",
      "createdAt": "2026-03-10T...",
      "updatedAt": "2026-03-10T..."
    }
  ],
  "total": 12,
  "fieldRef": "priority_level"
}
```

### POST /:indexId/vocabulary/review

```json
// Request
{ "action": "approve", "termIds": ["entry_1710...", "entry_1711..."] }

// Response
{ "success": true, "action": "approve", "updatedCount": 2, "updatedIds": ["entry_1710...", "entry_1711..."] }
```

## Tasks

1. Add `getVocabularyByFieldRef(indexId, fieldRef)` and `reviewVocabularyTerms(indexId, action, termIds)` to `apps/studio/src/api/search-ai.ts`
2. Add GET handler to `apps/studio/src/app/api/search-ai/indexes/[id]/vocabulary/[entryId]/route.ts` for proxy
3. Create `apps/studio/src/app/api/search-ai/indexes/[id]/vocabulary/review/route.ts` POST proxy
4. Create `VocabularyReviewDialog.tsx` with grouped terms, checkboxes, bulk action bar
5. Add BookOpen icon button to My Fields actions column in `FieldsTab.tsx`
6. Run `pnpm build --filter=@agent-platform/studio` and fix any type errors
7. Run `npx prettier --write` on all changed files

## Previous Story Intelligence

- Story 3.1 established the tabbed layout and DataTable pattern in FieldsTab.tsx
- Story 3.5/3.6 added the Edit Mapping Dialog pattern (lines 680-836) -- follow same Dialog + state pattern
- Story 4.6 implemented the backend vocabulary routes used by this story
- The `VocabularyEntry` interface already exists in `search-ai.ts` (line 919) -- reuse it
- The confidence badge helpers (`confidenceVariant`, `confidenceLabel`) at lines 89-99 should be reused
- Existing `engineUrl()` helper builds `/api/search-ai${path}` URLs
- Next.js proxy routes follow the pattern in `apps/studio/src/app/api/search-ai/indexes/[id]/vocabulary/` folder
