# Sprint 7: Admin Review UX — Detailed Plan

**Branch:** `feature/browse-sdk-admin-ux`
**Depends on:** Sprints 1-6 (all complete)
**Estimated duration:** 3 weeks

## Goal

Give admins a UI to review, approve, merge, and manage discovered attributes — closing the human-in-the-loop for the Browse SDK's attribute lifecycle.

## Task Decomposition

| Task                          | Package(s)  | Independent? | Est. Files | Est. Days |
| ----------------------------- | ----------- | ------------ | ---------- | --------- |
| **T-1**: Attribute Admin API  | `search-ai` | Yes          | 4-5        | 2d        |
| **T-2**: Studio Proxy + Hooks | `studio`    | No (T-1)     | 5-6        | 1d        |
| **T-3**: Attribute Manager UI | `studio`    | No (T-2)     | 6-8        | 3d        |
| **T-4**: SDK Preview Widget   | `studio`    | No (T-2)     | 3-4        | 2d        |
| **T-5**: Merge Workflow UI    | `studio`    | No (T-3)     | 3-4        | 2d        |
| **T-6**: Bulk Actions         | `studio`    | No (T-3)     | 2-3        | 1d        |

## T-1: Attribute Admin API (`search-ai`)

New Express router at `apps/search-ai/src/routes/attributes.ts`:

| Method | Path                                | Purpose                                                     |
| ------ | ----------------------------------- | ----------------------------------------------------------- |
| GET    | `/:indexId/attributes`              | List all attributes (filterable by tier, product, dataType) |
| GET    | `/:indexId/attributes/:attributeId` | Get single attribute detail                                 |
| PATCH  | `/:indexId/attributes/:attributeId` | Update tier, displayName, aliases, definition               |
| POST   | `/:indexId/attributes/bulk`         | Bulk tier changes (approve all safe, dismiss resolved)      |
| GET    | `/:indexId/attributes/review-queue` | Review queue — novel/beta attrs needing admin attention     |
| POST   | `/:indexId/attributes/merge`        | Merge two attributes (alias resolution)                     |
| GET    | `/:indexId/attributes/stats`        | Dashboard stats (counts by tier, recent promotions)         |

Patterns: `tenantId` from `req.tenantContext`, Zod validation, `getLazyModel<IAttributeRegistry>('AttributeRegistry')`, `createLogger('attributes-router')`.

## T-2: Studio Proxy + Hooks (`studio`)

- Next.js proxy routes at `apps/studio/src/app/api/search-ai/indexes/[id]/attributes/`
- API functions in `apps/studio/src/api/search-ai.ts` using `engineUrl('/indexes/${indexId}/attributes/...')`
- SWR hooks in new `apps/studio/src/hooks/useAttributes.ts`:
  - `useAttributes(indexId, filters)` — paginated list
  - `useAttributeDetail(indexId, attributeId)`
  - `useReviewQueue(indexId)` — novel/beta needing attention
  - `useAttributeStats(indexId)` — dashboard counters

## T-3: Attribute Manager UI (`studio`)

New sub-section under Intelligence (4 touch points: `VALID_SUB_SECTIONS`, `renderContent()`, `IntelligenceSubNav`, `IntelligenceHub`).

Components:

- `AttributesCard.tsx` — Hub card showing counts by tier (reuse `IntelligenceCard`)
- `AttributeManagerSection.tsx` — Main view: Review Queue | All Attributes | Stats
- `AttributeTable.tsx` — Sortable table (reuse `DataTable`) with tier badges, filters
- `AttributeDetailPanel.tsx` — Slide-out: edit displayName, aliases, definition, change tier
- `AttributeTierBadge.tsx` — Color-coded badge per tier

Reusing: `DataTable`, `FilterSelect`, `Pagination`, `Badge`, `ConfirmDialog`, `ListPageShell`

## T-4: SDK Preview Widget (`studio`)

- `BrowseSDKPreview.tsx` — Embedded preview of taxonomy + facets
- Fetches `/browse/taxonomy?include_beta=true` and `/browse/facets`
- Toggle: "Show beta attributes"
- Rendered as slide-out from Attribute Manager

## T-5: Merge Workflow UI (`studio`)

- `AttributeMergeDialog.tsx` — Side-by-side comparison
- Shows: names, aliases, document counts, data types, product scopes
- Actions: Merge (pick primary), Keep Both, Discard One

## T-6: Bulk Actions (`studio`)

- Checkbox selection on `AttributeTable` rows
- Bulk action bar: "Approve Selected", "Discard Selected", "Change Tier"
- `ConfirmDialog` with count summary

## Execution Order

```
T-1 (API) → T-2 (Proxy+Hooks) → T-3 (Manager UI) ──┬── T-5 (Merge)
                                  T-4 (Preview) ◄────┘── T-6 (Bulk)
```

## Out of Scope

- Real-time WebSocket notifications
- Audit log UI (attribute change history)
- Role-based access control for attribute management
- Custom tier creation beyond 5 predefined tiers

## UX Decision Pending

Three placement options under evaluation (see mockups in `docs/mockups/`):

- Option A: Attributes as 6th Intelligence sub-section
- Option B: Nested inside KG tab as 3rd view toggle
- Option C: Hybrid — Hub card + KG integration + Home alerts
