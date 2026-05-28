# Story 3.3+3.7: Suggested Mappings Visual Enhancement + Bulk Action Bar

## Status: ready-for-dev

## Story

As a SearchAI administrator,
I want suggested mappings grouped by confidence tier with color-coded rows and a sticky bulk action bar for high-confidence suggestions,
So that I can quickly review and accept batches of high-quality suggestions without clicking through each one individually.

**This combines original stories 3.3 (Suggested Mappings visual enhancement) and 3.7 (Bulk Action Bar).**

## Context

**This is an ENHANCEMENT story.** The Suggested tab in `FieldsTab.tsx` (lines 426-490) already renders suggested mappings grouped by connector with individual accept/reject buttons. This story:

1. Re-groups suggestions by **confidence tier** instead of connector (High >= 0.8, Medium 0.5-0.79, Low < 0.5)
2. Adds **color-coded row backgrounds** per tier
3. Enhances the confidence badge to show **score + label**
4. Adds **expandable rows** with transform details and connector info
5. Adds a **sticky bulk action bar** when high-confidence suggestions exist
6. Keeps existing individual accept/reject actions intact

## Acceptance Criteria

- [ ] Suggested mappings grouped by confidence tier: High (>= 0.8) first, Medium (0.5-0.79), Low (< 0.5)
- [ ] Tier section headers: "High Confidence (N)", "Medium Confidence (N)", "Low Confidence (N)"
- [ ] High-confidence rows: `bg-success-subtle border-l-2 border-success`
- [ ] Medium-confidence rows: `bg-warning-subtle border-l-2 border-warning`
- [ ] Low-confidence rows: default background (no special styling)
- [ ] Confidence badge shows score + label (e.g., "0.92 High")
- [ ] Rows are expandable — collapsed shows source -> canonical + confidence; expanded shows transform type, connector name, transform details
- [ ] Sticky bulk action bar appears when high-confidence suggestions exist
- [ ] Bulk bar text: "Accept All High-Confidence (N)" with primary button
- [ ] Bulk action calls `bulkActionMappings('confirm', mappingIds)` from `api/search-ai.ts`
- [ ] After bulk confirm: `refreshMappings()` + `refreshStats()` + success toast with count
- [ ] Bulk bar hides when no high-confidence suggestions remain
- [ ] Individual accept/reject buttons still work per row
- [ ] Empty state: "All suggestions reviewed! Check 'Unmapped Fields' for any remaining fields."

## Existing Code Analysis

### Current Suggested Tab (FieldsTab.tsx:426-490)

```tsx
{activeTab === 'suggested' && (
  <div>
    {suggestedMappings.length === 0 ? (
      <EmptyState ... />
    ) : (
      <div className="rounded-xl border ...">
        {Array.from(suggestionsByConnector.entries()).map(([connectorId, suggestions]) => (
          <div key={connectorId} className="p-4 space-y-3">
            <div className="text-xs font-medium text-muted">{connectorName(connectorId)}</div>
            {suggestions.map((m) => (
              // Flat row: sourcePath -> canonicalField + badges + accept/reject buttons
            ))}
          </div>
        ))}
      </div>
    )}
  </div>
)}
```

**What changes:** Replace `suggestionsByConnector` grouping with confidence-tier grouping. Enhance row styling. Add bulk bar.

### Existing API function (api/search-ai.ts:717-727)

```typescript
export async function bulkActionMappings(
  action: 'confirm' | 'reject',
  mappingIds: string[],
): Promise<{ success: boolean; processedCount: number }> {
  const response = await apiFetch(engineUrl('/mappings/bulk-action'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, mappingIds }),
  });
  return handleResponse(response);
}
```

### Existing helpers reused

- `confidenceVariant(c: number)` — already returns 'success' | 'warning' | 'error' (line 85)
- `connectorName(connectorId)` — already exists (line 149)
- `TRANSFORM_DISPLAY` — already maps transform types to labels (line 70)
- `handleConfirmMapping` / `handleRejectMapping` — keep for individual actions (lines 252-276)

### FieldMappingData type (api/search-ai.ts)

```typescript
export interface FieldMappingData {
  _id: string;
  canonicalField: string; // storage field name
  connectorId: string;
  sourcePath: string;
  transform: FieldMappingTransform;
  confidence: number;
  status: string; // 'suggested' | 'active'
  aliasName?: string | null;
  aliasLabel?: string | null;
}
```

## File List

| File                                                 | Action | Description                                               |
| ---------------------------------------------------- | ------ | --------------------------------------------------------- |
| `apps/studio/src/components/search-ai/FieldsTab.tsx` | MODIFY | Replace suggested tab panel with tiered layout + bulk bar |
| `apps/studio/src/api/search-ai.ts`                   | NONE   | `bulkActionMappings` already exists — no changes needed   |

## Tasks

### Task 1: Add confidence tier grouping

Replace the `suggestionsByConnector` memo (lines 138-146) with a confidence-tier memo. Keep the connector memo if used elsewhere, but add:

```typescript
const CONFIDENCE_TIERS = [
  { key: 'high', label: 'High Confidence', min: 0.8, max: 1.0 },
  { key: 'medium', label: 'Medium Confidence', min: 0.5, max: 0.8 },
  { key: 'low', label: 'Low Confidence', min: 0, max: 0.5 },
] as const;

const suggestionsByTier = useMemo(() => {
  const tiers = CONFIDENCE_TIERS.map((tier) => ({
    ...tier,
    items: suggestedMappings
      .filter(
        (m) => m.confidence >= tier.min && m.confidence < (tier.key === 'high' ? 1.01 : tier.max),
      )
      .sort((a, b) => b.confidence - a.confidence),
  }));
  return tiers.filter((t) => t.items.length > 0);
}, [suggestedMappings]);

const highConfidenceIds = useMemo(
  () => suggestedMappings.filter((m) => m.confidence >= 0.8).map((m) => m._id),
  [suggestedMappings],
);
```

### Task 2: Add tier row styling helper

```typescript
const tierRowClass = (tierKey: string): string => {
  switch (tierKey) {
    case 'high':
      return 'bg-success-subtle border-l-2 border-success';
    case 'medium':
      return 'bg-warning-subtle border-l-2 border-warning';
    default:
      return '';
  }
};

const confidenceLabel = (c: number): string => {
  if (c >= 0.8) return 'High';
  if (c >= 0.5) return 'Medium';
  return 'Low';
};
```

### Task 3: Add expandable suggestion row

Add local state for expanded rows:

```typescript
const [expandedSuggestions, setExpandedSuggestions] = useState<Set<string>>(new Set());

const toggleExpanded = useCallback((id: string) => {
  setExpandedSuggestions((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}, []);
```

Each suggestion row renders as:

```tsx
<div
  key={m._id}
  className={`p-3 rounded-lg border border-default cursor-pointer ${tierRowClass(tier.key)}`}
  onClick={() => toggleExpanded(m._id)}
>
  {/* Collapsed: source -> canonical + confidence badge + actions */}
  <div className="flex items-start gap-3">
    <div className="flex-1 min-w-0 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted">{m.sourcePath}</span>
        <span className="text-muted">-></span>
        <span className="font-medium text-foreground">
          {m.aliasLabel || m.aliasName || m.canonicalField}
        </span>
      </div>
      <Badge variant={confidenceVariant(m.confidence)} className="text-xs mt-1">
        {m.confidence.toFixed(2)} {confidenceLabel(m.confidence)}
      </Badge>
    </div>
    <div className="flex gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
      <button onClick={() => handleConfirmMapping(m._id)} className="p-1.5 text-success ..." title="Accept">
        <Check className="w-4 h-4" />
      </button>
      <button onClick={() => handleRejectMapping(m._id)} className="p-1.5 text-error ..." title="Reject">
        <X className="w-4 h-4" />
      </button>
    </div>
  </div>

  {/* Expanded: transform + connector details */}
  {expandedSuggestions.has(m._id) && (
    <div className="mt-2 pt-2 border-t border-default text-xs text-muted space-y-1">
      <div>Connector: {connectorName(m.connectorId)}</div>
      <div>Transform: {TRANSFORM_DISPLAY[m.transform.type] || m.transform.type}</div>
      {m.transform.type !== 'direct' && (
        <div className="font-mono text-xs bg-background-muted p-1.5 rounded">
          {JSON.stringify(m.transform, null, 2)}
        </div>
      )}
    </div>
  )}
</div>
```

### Task 4: Add sticky bulk action bar

Add bulk confirm handler:

```typescript
const [bulkConfirming, setBulkConfirming] = useState(false);

const handleBulkConfirmHigh = useCallback(async () => {
  if (highConfidenceIds.length === 0) return;
  setBulkConfirming(true);
  try {
    const result = await bulkActionMappings('confirm', highConfidenceIds);
    refreshMappings();
    refreshStats();
    toast.success(`Accepted ${result.processedCount} high-confidence mappings`);
  } catch (err) {
    toast.error(sanitizeError(err, 'Bulk confirm failed'));
  } finally {
    setBulkConfirming(false);
  }
}, [highConfidenceIds, refreshMappings, refreshStats]);
```

Render the bar at the top of the suggested tab, before the tier groups:

```tsx
{
  highConfidenceIds.length > 0 && (
    <div className="sticky top-0 z-10 flex items-center justify-between p-3 rounded-lg border border-success bg-success-subtle mb-4">
      <span className="text-sm font-medium text-foreground">
        {highConfidenceIds.length} high-confidence suggestion
        {highConfidenceIds.length !== 1 ? 's' : ''} ready
      </span>
      <Button size="sm" onClick={handleBulkConfirmHigh} loading={bulkConfirming}>
        Accept All High-Confidence ({highConfidenceIds.length})
      </Button>
    </div>
  );
}
```

### Task 5: Replace suggested tab content

Replace the entire `{activeTab === 'suggested' && (...)}` block (lines 426-490) with the new structure:

```tsx
{activeTab === 'suggested' && (
  <div>
    {suggestedMappings.length === 0 ? (
      <EmptyState
        icon={<Check className="w-6 h-6" />}
        title="All suggestions reviewed!"
        description="Check 'Unmapped Fields' for any remaining fields."
      />
    ) : (
      <div className="space-y-4">
        {/* Bulk action bar */}
        {highConfidenceIds.length > 0 && (
          <div className="sticky top-0 z-10 ...">...</div>
        )}

        {/* Tier groups */}
        {suggestionsByTier.map((tier) => (
          <div key={tier.key}>
            <h4 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
              {tier.label} ({tier.items.length})
            </h4>
            <div className="space-y-2">
              {tier.items.map((m) => (
                /* Expandable suggestion row from Task 3 */
              ))}
            </div>
          </div>
        ))}
      </div>
    )}
  </div>
)}
```

### Task 6: Import `bulkActionMappings`

Add to the existing import block (line 28-38):

```typescript
import {
  // ... existing imports ...
  bulkActionMappings,
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
- POST /bulk-action accepts `{action: 'confirm'|'reject', mappingIds: string[]}`
- `bulkActionMappings` already exists in `api/search-ai.ts` (line 717) — do NOT recreate

## Build & Test Commands

```bash
pnpm build --filter=@agent-platform/studio
npx prettier --write apps/studio/src/components/search-ai/FieldsTab.tsx
```
