# Sprint 7: Admin Review UX — Detailed Design

**Branch:** `feature/browse-sdk-admin-ux`
**Status:** UX Design Complete, Ready for HLD
**Last Updated:** 2026-03-20

---

## 1. UX Decisions Made

| Decision            | Choice                                                              | Rationale                                                                              |
| ------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Attribute placement | **Option B**: Nested inside KG tab as 3rd view toggle               | KG owns taxonomy → attributes → facets hierarchy; keeps Intelligence sub-nav at 6 tabs |
| SDK Preview trigger | **KB-level header button** (not inside Attributes view)             | Preview shows full search+browse experience — a KB concern, not attribute-specific     |
| SDK Preview target  | **New browser tab** (not slide-out panel)                           | Full search bar + taxonomy + facets + document results can't fit in 420px panel        |
| SDK Preview layout  | **Hybrid A+B**: E-commerce sidebar + enhanced search + auto-suggest | Combines familiar Amazon/Best Buy browsing with Algolia-style search-first UX          |

### Mockups Produced

| File                                                 | Purpose                                        | Status                           |
| ---------------------------------------------------- | ---------------------------------------------- | -------------------------------- |
| `docs/mockups/option-b-nested-in-kg.html`            | Attribute Manager in KG tab (chosen direction) | ✅ Reviewed, zero findings       |
| `docs/mockups/sdk-preview-layout-final.html`         | SDK Preview page (hybrid layout)               | ✅ Generated                     |
| `docs/mockups/option-a-intelligence-subsection.html` | Alternative: 6th sub-section                   | ✅ Reviewed (not chosen)         |
| `docs/mockups/option-c-hybrid.html`                  | Alternative: 3-surface hybrid                  | ✅ Reviewed (not chosen)         |
| `docs/mockups/sdk-preview-layout-a.html`             | SDK layout exploration: E-commerce             | ✅ Generated (merged into final) |
| `docs/mockups/sdk-preview-layout-b.html`             | SDK layout exploration: Search-first           | ✅ Generated (merged into final) |
| `docs/mockups/sdk-preview-layout-c.html`             | SDK layout exploration: Dual-panel             | ✅ Generated (not chosen)        |

---

## 2. Attribute Manager (KG Tab Integration)

### 2.1 Navigation Flow

```
KB Detail Page
├── Home
├── Data
├── Intelligence
│   ├── Overview (Hub) ← KG card shows "7 novel attributes pending review"
│   ├── Pipeline
│   ├── Fields
│   ├── Vocabulary
│   ├── Knowledge Graph ← ATTRIBUTES LIVE HERE
│   │   ├── [Graph] toggle — existing graph visualization
│   │   ├── [Statistics] toggle — existing KG stats
│   │   └── [Attributes] toggle — NEW: attribute management (amber "7" badge)
│   └── LLM Models
└── Search & Test
```

### 2.2 KG View Toggle

The existing KG tab has a 2-way toggle (Graph | Statistics). Sprint 7 adds a 3rd:

```
┌─────────────────────────────────────────────────────────┐
│  [🔗 Graph]  [📊 Statistics]  [💎 Attributes (7)]      │
└─────────────────────────────────────────────────────────┘
```

- Icons: `network` (Graph), `bar-chart-3` (Statistics), `diamond` (Attributes)
- Container: `bg-background-muted rounded-lg p-1` (4px padding)
- Active: `bg-accent text-accent-foreground shadow-sm rounded-md`
- Badge on Attributes: amber count of novel attributes pending review

### 2.3 Attributes View (when toggle active)

#### Tier Stat Cards Row

```
┌──────────┬──────────┬──────────┬──────────┬──────────┐
│    18    │    12    │     5    │     7    │     3    │
│ Permanent│ Approved │   Beta   │  Novel   │Discarded │
│  (green) │  (cyan)  │ (purple) │ (amber)  │  (muted) │
└──────────┴──────────┴──────────┴──────────┴──────────┘
```

#### Inner Navigation

```
[ Review Queue (7) ]  [ All Attributes ]  [ Stats & Activity ]
```

#### Filter Bar

```
🔍 Search attributes...   [All Tiers ▾]  [All Products ▾]  [All Types ▾]
```

Note: "Preview SDK" button has moved to KB header (see Section 3).

#### Attribute Table (DataTable)

| ☐   | Attribute                | Product      | Tier     | Type    | Docs | Confidence | Discovered |
| --- | ------------------------ | ------------ | -------- | ------- | ---- | ---------- | ---------- |
| ☐   | interest_rate_type       | Mortgages    | 🟡 Novel | Enum    | 324  | ████░ 0.92 | 2h ago     |
| ☐   | overdraft_protection     | Checking     | 🟡 Novel | Boolean | 187  | ████░ 0.88 | 3h ago     |
| ☐   | reward_points_multiplier | Credit Cards | 🟡 Novel | Number  | 256  | ███░░ 0.85 | 5h ago     |

- Click row → opens detail panel (slide-out, 420px)
- Checkbox → enables bulk action bar

#### Detail Panel (Slide-out, 420px)

Sections:

1. **Tier** — 5 selectable pill options (Novel, Beta, Approved, Permanent, Discarded)
2. **Display Name** — editable text input
3. **Product Scope** — dropdown (Mortgages, Checking, etc.)
4. **Data Type** — dropdown (Enum, String, Number, Boolean, Date)
5. **Aliases** — tag list with × remove (e.g., `rate_type`, `mortgage_rate_type`)
6. **Definition** — editable textarea
7. **Discovery Stats** — 2×2 grid (Documents, Confidence, Distinct Values, Last Seen)
8. **Interaction Stats** — 2×2 grid (Filter Uses 7d, Click Rate)

Footer: [Cancel] [Discard] [Approve]

### 2.4 Merge Workflow (T-5)

`AttributeMergeDialog.tsx` — Modal dialog triggered from review queue.

```
┌─────────────────────────────────────────────────────────┐
│  Merge Attributes                                    ✕  │
├──────────────────────┬──────────────────────────────────┤
│  SOURCE              │  TARGET                          │
│  interest_rate_type  │  rate_type                       │
│  ──────────────────  │  ──────────────────               │
│  Product: Mortgages  │  Product: Mortgages              │
│  Type: Enum          │  Type: Enum                      │
│  Docs: 324           │  Docs: 156                       │
│  Aliases: 3          │  Aliases: 1                      │
│  Confidence: 0.92    │  Confidence: 0.78                │
├──────────────────────┴──────────────────────────────────┤
│  After merge:                                           │
│  Primary: interest_rate_type                            │
│  All aliases: rate_type, mortgage_rate_type, ...        │
│  Combined docs: ~480 (deduplicated)                     │
├─────────────────────────────────────────────────────────┤
│  [Keep Both]         [Discard Source]    [✓ Merge]      │
└─────────────────────────────────────────────────────────┘
```

### 2.5 Bulk Actions (T-6)

When checkboxes are selected, a bulk action bar appears above the table:

```
┌─────────────────────────────────────────────────────────┐
│  3 selected    [Approve Selected] [Discard] [Change Tier ▾]  │
└─────────────────────────────────────────────────────────┘
```

Each action triggers `ConfirmDialog` with count summary before executing.

### 2.6 KG Hub Card Update

The KG card on the Intelligence Overview hub shows attribute attention:

```
┌────────────────────────────────────┐
│ [🔗] Knowledge Graph        🟡    │ ← attention dot (amber)
│                                    │
│  1              7                  │
│  Configured KBs  Pending Review    │
│                                    │
│  ⚠ 7 novel attributes pending     │ ← attention message
│                                    │
│  Taxonomy-based knowledge graph... │
│  [Configure Graph]                 │ ← secondary button
└────────────────────────────────────┘
```

Clicking this card navigates to Intelligence > KG and auto-activates the Attributes toggle.

---

## 3. SDK Preview Page (New Tab)

### 3.1 Entry Point

**KB Header** — a secondary button between the spacer and settings gear:

```
← Banking Support KB   Sources: 12   Docs: 3,847   ● Active   [👁 Preview SDK ↗]  ⚙
```

- Button: `<a>` tag with `target="_blank"`
- Icon: `eye` (14px) + `external-link` (12px, 60% opacity)
- Style: secondary button (bg-background-muted, border, rounded-lg)
- URL: `/projects/:projectId/search-ai/:kbId/browse-preview`
- Always includes `?include_beta=true` for admin view

### 3.2 Page Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ ⚠ Admin Preview — This is how end-users see the Browse SDK         │
│                              [Show beta attributes: ON]  ← Studio  │
├─────────────────────────────────────────────────────────────────────┤
│ 📖 Banking Support KB     🔍 [Search banking products...]  3,847   │
│              [All] [Checking] [Savings] [Credit Cards✓] [Mortgages]│
├─────────┬───────────────────────────────────────────────────────────┤
│ SIDEBAR │ RESULTS                                                   │
│ (280px) │                                                           │
│         │ All > Banking > Credit Cards                              │
│ Categor.│                                                           │
│ Banking │ 412 documents                    Sort: Most Recent ▾  ≡ ⊞│
│  ├ Check│                                                           │
│  ├ Sav  │ Credit Cards × | Annual Fee: $0 × | Clear all            │
│  ├ CC ◄─│                                                           │
│  ├ Mort │ ┌─────────────────────────────────────────────────────┐  │
│  └ Inv  │ │ Chase Freedom Unlimited® Card Details    SharePoint │  │
│         │ │ Earn unlimited 1.5% cash back on every purchase...  │  │
│ Filter  │ │ [Annual Fee: $0] [Rewards: 1.5x] [Intro APR: 0%]  │  │
│ ────────│ │ Updated 2 days ago              View Document ↗     │  │
│ Interest│ └─────────────────────────────────────────────────────┘  │
│  ☐ Fixed│                                                           │
│  ☐ ARM  │ ┌─────────────────────────────────────────────────────┐  │
│  ☐ Hybr │ │ Citi Double Cash Back Features           SharePoint │  │
│ Annual  │ │ Earn 2% on every purchase — 1% when you buy...      │  │
│  ☑ $0   │ │ [Annual Fee: $0] [Rewards: 2%] [FX Fee: 3% 🟣BETA]│  │
│  ☐ <$100│ │ Updated 3 days ago              View Document ↗     │  │
│ FX Fee  │ └─────────────────────────────────────────────────────┘  │
│ 🟣 BETA │                                                           │
│  ☐ 0%   │ Showing 1-20 of 412    « 1 [2] 3 ... 21 »              │
│  ☐ 1-3% │                                                           │
└─────────┴───────────────────────────────────────────────────────────┘
```

### 3.3 Component Breakdown

#### 3.3.1 Admin Banner (sticky, 40px)

- Background: `warning-subtle` with `border-bottom`
- Left: `shield-alert` icon + "Admin Preview — This is how end-users will see the Browse SDK"
- Right: Beta toggle switch (ON by default, purple when on) + "Back to Studio" link with `arrow-left` icon
- When beta toggle is OFF: all BETA-badged facets and attribute tags on documents are hidden
- When ON: they appear with purple badge

#### 3.3.2 Header Section

- Background: `background-subtle`
- Top row: KB name (`book-open` icon + "Banking Support KB") | document count
- Center: Search bar (500px, 44px, centered)
  - `search` icon left, clear `x` on right (when text present)
  - Focus: `border-color: var(--border-focus)`
- Bottom: Category quick-filter pills (synced with taxonomy tree)
  - Active: `bg-accent text-accent-foreground rounded-full`
  - Inactive: `bg-background-muted text-foreground-muted border rounded-full`

#### 3.3.3 Auto-Suggest Dropdown

Appears below search bar on focus/typing. Max 5 suggestions, max 1 beta.

| Icon       | Suggestion                       | Type Label       |
| ---------- | -------------------------------- | ---------------- |
| 🔍 search  | "credit card low interest"       | Search           |
| 💎 diamond | "Credit Limit"                   | Attribute (info) |
| 💎 diamond | "Annual Fee"                     | Attribute (info) |
| 🔍 search  | "cash back rewards"              | Search           |
| 💎 diamond | "Foreign Transaction Fee" 🟣BETA | Attribute (info) |

Styling:

- Container: `bg-background-elevated border border-border rounded-lg shadow-sm z-50`
- Items: `padding: 10px 14px; hover: bg-background-muted`
- Attribute type: `info` color label. Beta: additional purple pill badge.
- Debounce: 300ms after last keystroke

#### 3.3.4 Breadcrumb Trail

- Path: "All > Banking > Credit Cards"
- Separators: `chevron-right` (12px)
- Each segment clickable → updates taxonomy + facets + results

#### 3.3.5 Left Sidebar (280px)

**Taxonomy Tree** (top):

- Section title: "Categories" (11px, uppercase, tracking)
- Root: "Banking" with `building-2` icon
- Children indented 16px, showing doc count
- Active item: `bg-accent-subtle border-l-2 border-accent`
- Syncs bidirectionally with category pills

**Facets** (below, separated by border):

- Section title: "Filter by" + "Clear all" link when filters active
- Collapsible groups with `chevron-down/right` toggle

Facet groups:

1. **Interest Rate Type** — Fixed (234), ARM (67), Hybrid (23), "Show all 5 ▾"
2. **Annual Fee** — $0 (412) ✓, Under $100 (298), $100-$500 (187)
3. **Credit Limit** — collapsed
4. **Rewards Type** — Cash Back (234), Points (156), Miles (89)
5. **Foreign Transaction Fee** 🟣BETA — 0% (198), 1-3% (156), 3%+ (58)
6. **Contactless Payment** 🟣BETA — Yes (324), No (89)

Rules (from design doc):

- Max 8 visible facets (configurable)
- Max 3 beta facets at a time
- Values with 0 docs: HIDDEN (zero dead-ends)
- Min 2 distinct values required
- Counts show within current result set (not global)

#### 3.3.6 Results Area

**Results header**: "412 documents" + sort dropdown (Most Recent/Most Relevant/Name A-Z) + view toggle (list/grid)

**Active filter chips**: Removable chips for active facets + category + search query. "Clear all" link.

**Document cards** (list view):

```
┌─────────────────────────────────────────────────────────┐
│ Chase Freedom Unlimited® Card Details        SharePoint │
│ Earn unlimited 1.5% cash back on every purchase. No     │
│ annual fee. 0% intro APR for 15 months on purchases...  │
│                                                         │
│ [Annual Fee: $0] [Rewards: 1.5x Cash Back] [APR: 0%]   │
│ Updated 2 days ago                   View Document ↗    │
└─────────────────────────────────────────────────────────┘
```

Card anatomy:

- Border: `1px solid var(--border)`, `border-radius: 8px`, hover: border brightens
- Title: 14px, font-weight 500
- Source badge: `bg-background-muted` pill (SharePoint, Confluence)
- Summary: 13px, muted, 2-line clamp
- Attribute tags:
  - Matched/filtered: `bg-success-subtle text-success` (e.g., Annual Fee: $0 when $0 filter active)
  - Normal: `bg-info-subtle text-info`
  - Beta: `bg-purple-subtle text-purple` with "BETA" label
- Footer: timestamp (muted) + "View Document ↗" link (info color)

**Pagination**: "Showing 1-20 of 412" + page numbers

### 3.4 Data Flow

```
SDK Preview Page
│
├── GET /browse/taxonomy?include_beta=true
│   └── Returns: taxonomy tree + attribute metadata overlay
│
├── GET /browse/facets?attribute={name}&product={product}&limit=50
│   └── Returns: distinct values with counts for each facet
│
├── [On facet click] GET /browse/facets/{attributeType}/documents?value={v}
│   └── Returns: document IDs matching facet value
│
├── [On search] POST /search (existing search API)
│   └── Returns: ranked results with doc IDs
│
├── [Post-search] POST /browse/facet-counts { documentIds: [...] }
│   └── Returns: facet distribution within search results
│
└── [On document click] → opens source URL in new tab
```

### 3.5 Mode Behavior

| State                          | Search Bar | Facets                                  | Results Sorted By |
| ------------------------------ | ---------- | --------------------------------------- | ----------------- |
| **Browse-first** (no query)    | Empty      | Global counts                           | Most Recent       |
| **Search-first** (query typed) | Has text   | Post-search counts (within results)     | Relevance         |
| **Synced** (query + facets)    | Has text   | Counts within filtered+searched results | Relevance         |

### 3.6 Beta Toggle Behavior

| Element                          | Toggle ON                | Toggle OFF      |
| -------------------------------- | ------------------------ | --------------- |
| Beta-badged facet groups         | Visible with 🟣BETA pill | Hidden entirely |
| Beta attribute tags on documents | Shown with purple badge  | Hidden          |
| Beta auto-suggestion             | Shown (max 1)            | Hidden          |
| Tier 1+2 facets/attributes       | Always shown             | Always shown    |

---

## 4. API Specification (T-1)

### 4.1 Routes

All routes under `/api/indexes/:indexId/attributes/`.
All require `tenantId` from `req.tenantContext`.

```
GET    /:indexId/attributes
       Query: ?tier=novel&product=Mortgages&dataType=Enum&page=1&limit=20&search=rate
       Response: { data: AttributeRegistry[], total: number, page: number, limit: number }

GET    /:indexId/attributes/review-queue
       Response: { mergeConflicts: [], placementReview: [], typeConflicts: [], total: number }

GET    /:indexId/attributes/stats
       Response: { byTier: { permanent: 18, approved: 12, ... }, recentPromotions: [], recentDemotions: [] }

GET    /:indexId/attributes/:id
       Param: :id = MongoDB _id (globally unique, avoids compound key in URL)
       Response: { data: AttributeRegistry }

PATCH  /:indexId/attributes/:id
       Param: :id = MongoDB _id
       Body: { tier?, displayName?, aliases?, definition?, productScope? }
       Response: { data: AttributeRegistry }
       Note: When tier changes, sets discoverySource='admin_manual' to protect from auto-promotion cron override

POST   /:indexId/attributes/bulk
       Body: { action: 'approve'|'discard'|'changeTier', attributeIds: string[], targetTier?: string }
       Response: { updated: number, errors: [] }

POST   /:indexId/attributes/merge
       Body: { sourceId: string, targetId: string, primaryId: string }
       Response: { data: AttributeRegistry, clickhouseMutationPending: boolean }
       Note: Updates entity_instances attribute_type via ALTER TABLE mutation (async). facet_interactions NOT updated (historical accuracy).
```

### 4.2 Validation (Zod)

```typescript
const listQuerySchema = z.object({
  tier: z.enum(['permanent', 'approved', 'beta', 'novel', 'discarded']).optional(),
  product: z.string().min(1).max(256).optional(),
  dataType: z.enum(['string', 'number', 'boolean', 'date', 'enum']).optional(),
  search: z.string().max(256).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const updateSchema = z.object({
  tier: z.enum(['permanent', 'approved', 'beta', 'novel', 'discarded']).optional(),
  displayName: z.string().min(1).max(256).optional(),
  aliases: z.array(z.string().min(1).max(256)).max(20).optional(),
  definition: z.string().max(2000).optional(),
  productScope: z.string().min(1).max(256).optional(),
});

const bulkSchema = z.object({
  action: z.enum(['approve', 'discard', 'changeTier']),
  attributeIds: z.array(z.string().min(1)).min(1).max(100),
  targetTier: z.enum(['permanent', 'approved', 'beta', 'novel', 'discarded']).optional(),
});

const mergeSchema = z.object({
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  primaryId: z.string().min(1),
});
```

### 4.3 Auto-Promoter Guard (T-1 scope)

When an admin changes a tier via PATCH, the endpoint sets `discoverySource: 'admin_manual'`. Two additional changes are needed to prevent the 5 AM auto-promotion cron from overriding admin decisions:

**File 1: `apps/search-ai/src/services/reconciliation/auto-promoter.ts`**

Add early return at the top of `evaluatePromotion()` (before the existing `discarded` check):

```typescript
// Admin-set tiers are never auto-promoted/demoted
if (attr.discoverySource === 'admin_manual') {
  return {
    attributeId: attr.attributeId,
    productScope: attr.productScope,
    action: 'keep',
    reason: 'admin_manual_override',
  };
}
```

**File 2: `apps/search-ai/src/scheduler/index.ts`**

Add `discoverySource` filter to the auto-promotion query (currently `{ tier: { $in: ['beta', 'approved'] } }`):

```typescript
// Exclude admin-managed attributes from automated evaluation
{ tenantId, indexId, tier: { $in: ['beta', 'approved'] }, discoverySource: { $ne: 'admin_manual' } }
```

---

## 5. Studio Proxy + Hooks (T-2)

### 5.1 Proxy Routes

```
apps/studio/src/app/api/search-ai/indexes/[id]/attributes/
├── route.ts              — GET (list), POST (not used yet)
├── review-queue/route.ts — GET
├── stats/route.ts        — GET
├── bulk/route.ts         — POST
├── merge/route.ts        — POST
└── [id]/route.ts           — GET, PATCH (by MongoDB _id)
```

### 5.2 API Functions

In `apps/studio/src/api/search-ai.ts`:

```typescript
// List attributes with filters
export async function getAttributes(indexId: string, filters?: AttributeFilters);
// Get single attribute
export async function getAttributeDetail(
  indexId: string,
  attributeId: string,
  productScope?: string,
);
// Update attribute
export async function updateAttribute(indexId: string, attributeId: string, data: AttributeUpdate);
// Get review queue
export async function getReviewQueue(indexId: string);
// Get stats
export async function getAttributeStats(indexId: string);
// Bulk action
export async function bulkAttributeAction(indexId: string, action: BulkAction);
// Merge
export async function mergeAttributes(indexId: string, merge: MergeRequest);
```

All use `engineUrl('/indexes/${indexId}/attributes/...')`.

### 5.3 Browse Runtime Proxy Routes (for SDK Preview)

The SDK Preview page calls existing browse endpoints on search-ai-runtime (port 3114). Studio needs proxy routes to reach them:

```
apps/studio/src/app/api/search-ai-runtime/search/[indexId]/browse/
├── taxonomy/route.ts      — GET (proxies /browse/taxonomy?include_beta=true)
├── facets/route.ts        — GET (proxies /browse/facets?attribute=...&product=...)
├── facet-counts/route.ts  — POST (proxies /browse/facet-counts { documentIds })
├── facet-documents/[attributeType]/route.ts — GET (proxies /browse/facets/:type/documents)
└── interactions/route.ts  — POST (proxies /browse/interactions { events })
```

All use `proxyToSearchRuntime()` (same pattern as existing search proxy routes).

### 5.4 Browse API Functions

In `apps/studio/src/api/search-ai.ts`:

```typescript
export async function getBrowseTaxonomy(indexId: string, includeBeta?: boolean);
export async function getBrowseFacets(indexId: string, attribute: string, product?: string);
export async function postBrowseFacetCounts(indexId: string, documentIds: string[]);
export async function getBrowseFacetDocuments(
  indexId: string,
  attributeType: string,
  value: string,
);
export async function postBrowseInteraction(indexId: string, events: InteractionEvent[]);
```

All use `runtimeUrl('/search/${indexId}/browse/...')`.

### 5.5 SWR Hooks

In `apps/studio/src/hooks/useAttributes.ts`:

```typescript
export function useAttributes(indexId: string, filters?: AttributeFilters);
// → SWR key: ['/attributes', indexId, filters]
// → Returns: { data, total, isLoading, error, mutate }

export function useAttributeDetail(indexId: string, attributeId: string, productScope?: string);
// → Returns: { data, isLoading, error, mutate }

export function useReviewQueue(indexId: string);
// → 30s refresh interval (matches NeedsAttentionCard pattern)
// → Returns: { mergeConflicts, placementReview, typeConflicts, total }

export function useAttributeStats(indexId: string);
// → Returns: { byTier, recentPromotions, recentDemotions }
```

---

## 6. Component Architecture (T-3, T-4, T-5, T-6)

### 6.1 New Components

```
apps/studio/src/components/search-ai/
├── intelligence/
│   └── cards/
│       └── KnowledgeGraphCard.tsx    ← MODIFY: add attention for attributes
├── attributes/                       ← NEW DIRECTORY
│   ├── AttributeManagerSection.tsx   ← Main view (inner tabs + content)
│   ├── AttributeTable.tsx            ← DataTable wrapper with attribute columns
│   ├── AttributeDetailPanel.tsx      ← Slide-out edit panel
│   ├── AttributeTierBadge.tsx        ← Colored tier badge component
│   ├── AttributeMergeDialog.tsx      ← T-5: merge workflow modal
│   └── AttributeBulkBar.tsx          ← T-6: bulk action bar
├── KnowledgeGraphTab.tsx             ← MODIFY: add 3rd toggle
└── browse-preview/                   ← NEW DIRECTORY (T-4)
    ├── BrowsePreviewPage.tsx         ← Full-page preview (new tab target)
    ├── BrowsePreviewHeader.tsx       ← Admin banner + search + category pills
    ├── BrowsePreviewSidebar.tsx      ← Taxonomy tree + facets
    ├── BrowsePreviewResults.tsx      ← Document cards + pagination
    ├── BrowseAutoSuggest.tsx         ← Search suggestion dropdown
    └── BrowseDocumentCard.tsx        ← Individual result card
```

### 6.2 Modified Files

```
apps/studio/src/components/search-ai/KnowledgeGraphTab.tsx
  ← Add 3rd toggle button "Attributes" with diamond icon + badge
  ← Render AttributeManagerSection when attributes toggle active

apps/studio/src/components/search-ai/intelligence/cards/KnowledgeGraphCard.tsx
  ← Add attention state when review queue > 0
  ← Add "Pending Review" stat
  ← Navigate to KG + auto-activate Attributes toggle on click

apps/studio/src/store/navigation-store.ts
  ← Add kgView state: 'graph' | 'statistics' | 'attributes'

apps/studio/src/api/search-ai.ts
  ← Add 7 new API functions for attributes

apps/studio/src/app/api/search-ai/indexes/[id]/attributes/
  ← 6 new proxy route files
```

### 6.3 New Route

```
apps/studio/src/app/projects/[projectId]/search-ai/[kbId]/browse-preview/
  └── page.tsx    ← SDK Preview full page (T-4)
```

---

## 7. Tier Badge Color System

| Tier      | Background         | Text               | Badge dot |
| --------- | ------------------ | ------------------ | --------- |
| permanent | `success-subtle`   | `success`          | —         |
| approved  | `info-subtle`      | `info`             | —         |
| beta      | `purple-subtle`    | `purple`           | —         |
| novel     | `warning-subtle`   | `warning`          | —         |
| discarded | `background-muted` | `foreground-muted` | —         |

---

## 8. Execution Plan

### Dependencies

```
T-1 (Attribute Admin API)
 └── T-2 (Studio Proxy + Hooks)
      ├── T-3 (Attribute Manager UI)
      │    ├── T-5 (Merge Workflow)
      │    └── T-6 (Bulk Actions)
      └── T-4 (SDK Preview Page)
```

### Implementation Order

1. **T-1** — API routes (independent, search-ai package only)
2. **T-2** — Proxy + hooks (depends on T-1, studio package only)
3. **T-3 + T-4** — Can run in parallel after T-2 (different component directories)
4. **T-5 + T-6** — Can run in parallel after T-3

### Estimated Timeline

| Task                         | Est. Days | Parallel?  |
| ---------------------------- | --------- | ---------- |
| T-1: Attribute Admin API     | 2d        | —          |
| T-2: Studio Proxy + Hooks    | 1d        | —          |
| T-3: Attribute Manager UI    | 3d        | ∥ with T-4 |
| T-4: SDK Preview Page        | 3d        | ∥ with T-3 |
| T-5: Merge Workflow          | 2d        | ∥ with T-6 |
| T-6: Bulk Actions            | 1d        | ∥ with T-5 |
| **Total (with parallelism)** | **~8d**   |            |

---

## 9. Out of Scope

- Real-time WebSocket notifications for attribute changes
- Audit log UI (attribute change history)
- Role-based access control for attribute management
- Custom tier creation beyond 5 predefined tiers
- NL → facet decomposition (LLM query parsing) — Sprint 8+
- Client-side SDK package (React/JS embeddable) — Sprint 8+
- Auto-suggestion service (backend) — Sprint 8+
- Interaction tracking (impressions/clicks → ClickHouse) — Sprint 6 (already built)
- Document detail API (full document view) — Sprint 8+

---

## 10. Open Questions

1. **Document click behavior**: In SDK Preview, clicking "View Document ↗" — should it open the document's source URL (SharePoint/Confluence link) or a document detail page within the preview?
   - **Recommendation**: Source URL for now. Document detail page is Sprint 8+.

2. **SDK Preview auth**: Does the preview page need its own auth token, or does it reuse the Studio session?
   - **Recommendation**: Reuse Studio session. The preview is a Studio page, not an external widget.

3. **Facet count accuracy**: In browse-first mode (no search query), should facet counts be global or scoped to the selected category?
   - **Recommendation**: Scoped to selected category (ClickHouse WHERE product_type = ...).

4. **Search integration**: The SDK Preview search bar — does it call the existing search API or a new browse-specific search endpoint?
   - **Recommendation**: Existing search API with post-search facet counts via `/browse/facet-counts`.
