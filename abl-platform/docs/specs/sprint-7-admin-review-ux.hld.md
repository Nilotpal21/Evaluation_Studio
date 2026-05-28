# Sprint 7: Admin Review UX — High-Level Design

## What

Build the admin interface for managing dynamically discovered attributes and previewing the Browse SDK. This is Layer 5 of the Browse SDK — the human-in-the-loop that lets admins review novel attributes, promote/demote tiers, merge duplicates, and preview how end-users will experience taxonomy-based faceted navigation. Layers 0-4 (ClickHouse storage, browse API, discovery, reconciliation, beta SDK) are already implemented in Sprints 1-6.

## Architecture Approach

### Packages That Change

| Package          | What Changes                                                                                               | New Files | Modified Files                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| `apps/search-ai` | 7 attribute admin API routes + auto-promoter guard + tests                                                 | 2         | 3 (server.ts, auto-promoter.ts, scheduler/index.ts)                                 |
| `apps/studio`    | 11 proxy routes (6 attribute + 5 browse), SWR hooks, API functions, 12 new UI components, 1 new page route | ~30       | 5 (KnowledgeGraphTab, KnowledgeGraphCard, navigation-store, search-ai.ts, KBHeader) |

### Data Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│ STUDIO (apps/studio, port 5173)                                         │
│                                                                          │
│  KBHeader ──["Preview SDK ↗"]──→ /projects/:pid/search-ai/:kbId/       │
│                                   browse-preview (new browser tab)       │
│                                                                          │
│  KnowledgeGraphTab                                                       │
│    [Graph] [Statistics] [Attributes] ← NEW 3rd toggle                   │
│         │                    │                                           │
│         │      AttributeManagerSection                                   │
│         │        ├── useAttributes(indexId)                               │
│         │        ├── useReviewQueue(indexId)                              │
│         │        ├── useAttributeStats(indexId)                           │
│         │        └── useAttributeDetail(indexId, attrId)                  │
│         │                    │                                           │
│         │      SWR hooks call Studio proxy routes                        │
│         ▼                    ▼                                           │
│  /api/search-ai/indexes/[id]/attributes/* (Next.js API proxy routes)    │
└──────────────┬───────────────────────────────────────────────────────────┘
               │ proxyToSearchEngine()
               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ SEARCH-AI ENGINE (apps/search-ai, port 3113)                            │
│                                                                          │
│  NEW: /api/indexes/:indexId/attributes/*  (7 routes)                    │
│    ├── GET    /                    → list + filter + paginate            │
│    ├── GET    /review-queue        → merge conflicts, type conflicts     │
│    ├── GET    /stats               → tier distribution                   │
│    ├── GET    /:id                  → single attribute detail (by _id)   │
│    ├── PATCH  /:id                 → update tier/name/aliases (by _id)   │
│    ├── POST   /bulk                → bulk approve/discard/changeTier     │
│    └── POST   /merge               → merge two attributes               │
│                    │                                                     │
│                    ▼                                                     │
│  AttributeRegistry (MongoDB, searchaicontent db)  ← EXISTS              │
│  AttributeMergeEvent (MongoDB, audit trail)       ← EXISTS              │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│ SDK PREVIEW PAGE (new browser tab, Studio session auth)                  │
│                                                                          │
│  BrowsePreviewPage                                                       │
│    ├── BrowsePreviewHeader (admin banner + search bar + category pills)  │
│    ├── BrowsePreviewSidebar (taxonomy tree + facet checkboxes)           │
│    ├── BrowsePreviewResults (document cards + pagination)                │
│    └── BrowseAutoSuggest (search suggestion dropdown)                   │
│                    │                                                     │
│         runtimeUrl('/search/{indexId}/browse/...')                        │
│                    ▼                                                     │
│  NEW: /api/search-ai-runtime/search/[indexId]/browse/* (5 proxy routes)  │
│    └── proxyToSearchRuntime() ─────────────────────────────────┐         │
│                                                                 │         │
└─────────────────────────────────────────────────────────────────┼─────────┘
                                                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  SEARCH-AI-RUNTIME (port 3114) ← EXISTING browse endpoints              │
│    ├── GET  /browse/taxonomy?include_beta=true                           │
│    ├── GET  /browse/facets                                               │
│    ├── GET  /browse/facets/:type/documents                               │
│    ├── POST /browse/facet-counts                                         │
│    └── POST /browse/interactions                                         │
│                    │                                                     │
│                    ▼                                                     │
│  ClickHouse: entity_instances + facet_interactions  ← EXISTS             │
└──────────────────────────────────────────────────────────────────────────┘
```

### Key Integration Points

1. **Admin routes → search-ai engine (port 3113)**: Attribute CRUD routes are admin/management operations, so they belong in the engine alongside other index management routes. They mount at `/api/indexes/:indexId/attributes/` following the existing pattern (`app.use('/api/indexes', attributesRouter)`).

2. **SDK Preview → search-ai-runtime (port 3114)**: The preview page consumes the _same_ browse API that end-users will use. Studio has `proxyToSearchRuntime()` but currently only proxies search paths (`/search/[indexId]/query`, `/suggest`, etc.). Sprint 7 must add 5 new runtime proxy routes for browse endpoints under `apps/studio/src/app/api/search-ai-runtime/search/[indexId]/browse/`. Preview client code uses `runtimeUrl()` to call these.

3. **KG toggle → navigation store**: The 3rd "Attributes" toggle requires `kgView` state in the navigation store (not local `useState`) because the KG Hub Card on the Intelligence Overview must be able to auto-navigate to `KG > Attributes` toggle on click. Local state would be unreachable from the card component.

4. **KBHeader → "Preview SDK" button**: Added inline in the `ml-auto` flex area between the Badge and Settings button. Opens new tab via `<a target="_blank">`.

5. **SDK Preview search-first mode**: Uses the EXISTING search proxy route at `/api/search-ai-runtime/search/[indexId]/query` (already built). No new proxy needed for search — only for browse endpoints.

6. **Review queue definitions**: The `/review-queue` endpoint identifies items via MongoDB queries:
   - _Merge conflicts_: attributes with same `attributeId` across different `productScope` values where names diverge
   - _Placement review_: `tier: 'novel'` with `documentCount >= promotionDocCountMin` and `confidence >= promotionConfidenceMin` (ready for admin decision)
   - _Type conflicts_: attributes with same `attributeId` but different `dataType` across product scopes

## API Availability Verification

### What EXISTS (Sprints 1-6, verified in codebase)

| Component                   | File                                                                        | Status                                        |
| --------------------------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| AttributeRegistry model     | `packages/database/src/models/attribute-registry.model.ts`                  | ✅ 20+ fields, tier system, compound indexes  |
| AttributeMergeEvent model   | `packages/database/src/models/attribute-merge-event.model.ts`               | ✅ Audit trail for merges                     |
| Browse router (4 endpoints) | `apps/search-ai-runtime/src/routes/browse.ts`                               | ✅ taxonomy, facets, facet-counts, facet-docs |
| FacetQueryService           | `apps/search-ai-runtime/src/services/browse/facet-query.service.ts`         | ✅ ClickHouse queries                         |
| FacetDisplayRulesService    | `apps/search-ai-runtime/src/services/browse/facet-display-rules.service.ts` | ✅ Max 8, 3 beta budget                       |
| Interaction tracking        | `apps/search-ai-runtime/src/routes/interactions.ts`                         | ✅ POST endpoint + BufferedWriter             |
| InteractionAggregator       | `apps/search-ai/src/services/reconciliation/interaction-aggregator.ts`      | ✅ ClickHouse stats                           |
| Auto-promotion cron         | `apps/search-ai/src/scheduler/index.ts`                                     | ✅ Daily 5 AM                                 |
| Reconciliation service      | `apps/search-ai/src/services/reconciliation/reconciliation.service.ts`      | ✅ Embedding + clustering                     |
| entity_instances table      | `packages/database/src/clickhouse-schemas/init.ts`                          | ✅ ReplacingMergeTree                         |
| facet_interactions table    | Same file                                                                   | ✅ TTL 730 days                               |

### What MUST BE BUILT (Sprint 7)

| Component                                | Package   | Why It Doesn't Exist                        |
| ---------------------------------------- | --------- | ------------------------------------------- |
| Attribute admin routes (7)               | search-ai | Admin CRUD was planned for Sprint 7         |
| Studio attribute proxy routes (6)        | studio    | No proxy routes for attributes exist        |
| Studio browse runtime proxy routes (5)   | studio    | No proxy routes for browse endpoints exist  |
| SWR hooks (4)                            | studio    | No attribute hooks exist                    |
| API client functions (7)                 | studio    | No attribute functions in search-ai.ts      |
| KG "Attributes" toggle                   | studio    | KnowledgeGraphTab only has Graph/Statistics |
| AttributeManagerSection + components (6) | studio    | No attributes/ directory exists             |
| BrowsePreviewPage + components (6)       | studio    | No browse-preview/ directory exists         |
| SDK Preview route                        | studio    | No browse-preview page.tsx exists           |

### What DOES NOT Need Building (correct by design)

- ❌ No new ClickHouse tables — entity_instances and facet_interactions already exist
- ❌ No new MongoDB models — AttributeRegistry and AttributeMergeEvent already exist
- ❌ No new browse backend endpoints — SDK Preview uses existing runtime endpoints (but needs new Studio proxy routes to reach them)
- ❌ No new workers/crons — reconciliation and auto-promotion already run daily
- ✅ Navigation store needs `kgView` field — for KG Hub Card → Attributes toggle auto-navigation

## Decisions & Tradeoffs

- **Decision 1**: Admin routes in search-ai engine (3113) not search-ai-runtime (3114) — because admin CRUD is a management operation (like vocabulary, schemas, mappings), not a query-time operation. Runtime stays read-only.

- **Decision 2**: SDK Preview as Next.js app router page (not navigation store) — because it opens in a new browser tab and needs its own full page layout, not the KB detail shell. This is the ONE place we use Next.js file-based routing for SearchAI.

- **Decision 3 (REVISED)**: KG toggle uses `kgView` in navigation store — the KG Hub Card on Intelligence Overview must auto-navigate to `KG > Attributes` on click. Local `useState` would be unreachable from the card. The navigation store already manages `tab` and `subSection`; adding `kgView: 'graph' | 'statistics' | 'attributes'` is consistent.

- **Decision 4**: No `doc-filter` endpoint needed — the SDK Preview's browse-first mode uses `/browse/facets/:type/documents` for facet-based document retrieval and the existing search API for search-first mode. The design doc's "doc-filter" reference maps to the existing facet-documents endpoint.

- **Decision 5**: Express route ordering for attributes — static routes (`/review-queue`, `/stats`, `/bulk`, `/merge`) MUST be registered before the parameterized `/:id` route to prevent Express from capturing "review-queue" as an ID.

- **Decision 6**: Preview SDK button hardcoded in KBHeader (not via `actions` prop) — the button is always present for all KBs. Adding a generic `actions` slot would be over-engineering for a single button that's tightly coupled to the KB context.

- **Decision 7**: Route params use MongoDB `_id` (not business `attributeId`) — the AttributeRegistry model has both `_id` (globally unique) and `attributeId` (e.g., "interest_rate") which requires `productScope` for uniqueness. Using `_id` as the route param avoids compound key complexity in URLs.

- **Decision 8**: Admin tier overrides are protected via `discoverySource: 'admin_manual'` — When an admin changes a tier, the PATCH endpoint sets `discoverySource: 'admin_manual'`. Two changes needed: (a) `auto-promoter.ts` → `evaluatePromotion()` adds early return when `attr.discoverySource === 'admin_manual'`, (b) `scheduler/index.ts` → auto-promotion query adds `discoverySource: { $ne: 'admin_manual' }` filter to the `.find()` call (currently queries `{ tier: { $in: ['beta', 'approved'] } }` with no discoverySource filter). Both files in T-1 scope.

- **Decision 9**: Merge operations update ClickHouse `attribute_type` — When two attributes merge (e.g., `rate_type` → `interest_rate_type`), the merge endpoint must also run an `ALTER TABLE ... UPDATE attribute_type = '{target}' WHERE attribute_type = '{source}'` mutation on the `entity_instances` table (ReplicatedReplacingMergeTree — safe for mutations). `facet_interactions` is NOT updated (preserves historical interaction accuracy). The merge response returns immediately with `clickhouseMutationPending: true`; mutation progress can be monitored via `system.mutations`.

## Reusable Services (from Sprints 1-6)

Sprint 7 routes should **reuse** these existing services rather than rebuilding:

| Service                                             | File                                                | Reuse in Sprint 7                                                                |
| --------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `InteractionAggregator.aggregateInteractions()`     | `services/reconciliation/interaction-aggregator.ts` | `GET /attributes/stats` calls this for per-attribute interaction data            |
| `AttributeMergeEvent` model (`admin_manual` method) | `models/attribute-merge-event.model.ts`             | `POST /attributes/merge` creates events with `mergeMethod: 'admin_manual'`       |
| `FacetDisplayRulesService.selectFacets()`           | `services/browse/facet-display-rules.service.ts`    | SDK Preview uses this for budget-constrained facet selection (built but unwired) |
| `validateNovelCandidate()`                          | `services/novel-candidate-validator.ts`             | Future admin-created attributes can use the same quality gates                   |

## Task Decomposition

| Task                      | Package(s) | Independent? | Est. Files | Description                                                                                           |
| ------------------------- | ---------- | ------------ | ---------- | ----------------------------------------------------------------------------------------------------- |
| T-1: Attribute Admin API  | search-ai  | Yes          | 4          | 7 REST routes, Zod validation, auth + tenant isolation, auto-promoter guard + scheduler filter, tests |
| T-2: Studio Proxy + Hooks | studio     | No (T-1)     | 15         | 6 attribute proxy + 5 browse proxy routes, 7+5 API functions, 4 SWR hooks                             |
| T-3: Attribute Manager UI | studio     | No (T-2)     | 7          | KG toggle, tier cards, table, detail panel, tier badge                                                |
| T-4: SDK Preview Page     | studio     | No (T-2)     | 8          | Full-page preview, taxonomy sidebar, search, results, page route                                      |
| T-5: Merge Workflow       | studio     | No (T-3)     | 1          | Side-by-side comparison modal                                                                         |
| T-6: Bulk Actions         | studio     | No (T-3)     | 1          | Checkbox selection + action bar                                                                       |

### Execution Order

```
T-1 (Attribute Admin API, search-ai)
 └── T-2 (Studio Proxy + Hooks, studio)
      ├── T-3 (Attribute Manager UI, studio)  ── parallel ──  T-4 (SDK Preview, studio)
      │    ├── T-5 (Merge Workflow, studio)
      │    └── T-6 (Bulk Actions, studio)
```

**Parallelism**: T-3 and T-4 can run in parallel (different component directories, zero file overlap). T-5 and T-6 can run in parallel after T-3 (T-5 uses AttributeMergeDialog, T-6 uses AttributeBulkBar — no overlap).

## Out of Scope

- NL → facet decomposition (LLM query parsing) — Sprint 8+
- Client-side React SDK package (npm embeddable) — Sprint 8+
- Auto-suggestion backend service — Sprint 8+
- Document detail API (full document view with presigned URLs) — Sprint 8+
- Real-time WebSocket notifications for attribute changes
- Audit log UI (attribute change history)
- Role-based access control for attribute management
- Custom tier creation beyond 5 predefined tiers
