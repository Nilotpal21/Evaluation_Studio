# Browse SDK Integration Fixes — High-Level Design (v2, post-review)

## What

Fix 5 blocking backend↔frontend shape mismatches that prevent the Browse SDK preview from functioning. The backend services are correctly built; the frontend components are well-structured. They were never integrated — response shapes don't match, interaction schemas are incompatible, and one service is built but unwired.

## Architecture Approach

### Current State (Broken)

```
Frontend                          Backend
─────────────────                 ─────────────────
TaxonomyNode[]  ←── MISMATCH ──→ {domain, categories[], products[], attributes[]}
{facets: [...]}  ←── MISMATCH ──→ single FacetResult
{documents: [...]} ←── MISMATCH ──→ {documentIds: string[]}
search/browse/facet_click ── 400 ──→ impression/click/filter/expand/remove
handleSearch()  ── STUB ──→        (no call made)
```

### Target State (Fixed)

```
Frontend                              Backend
─────────────────                     ─────────────────
transformTaxonomyToTree() ←── OK ──→  taxonomy + documentCounts
N calls per applicable attr ←── OK ──→ single FacetResult
hydrate via /query+docIds   ←── OK ──→ {documentIds: string[]}
click/filter/search/browse  ←── OK ──→ extended VALID_INTERACTION_TYPES
executeQuery() + dedup      ←── OK ──→ POST /:indexId/query
```

## Task Decomposition

### T-1: Backend — Extend taxonomy endpoint with documentCounts (search-ai-runtime)

- **Add new method** `getDocumentCountsByProduct(tenantId, indexId)` on `FacetQueryService` (NOT raw ClickHouse in route handler — follows existing delegation pattern)
- Query: `SELECT product_type, uniqExact(document_id) FROM entity_instances FINAL WHERE tenant_id=? AND index_id=? GROUP BY product_type`
- In browse.ts taxonomy handler: call `facetQueryService.getDocumentCountsByProduct()` in parallel with taxonomy fetch
- Add `documentCounts: Record<string, number>` to taxonomy response JSON (keyed by product name/id)
- Fail-open: if ClickHouse unavailable, return empty `{}`
- **Files:** `facet-query.service.ts` (new method), `browse.ts` (add to response)

### T-2: Backend — Extend interaction schema (search-ai-runtime)

- Add `'search'` and `'browse'` to `VALID_INTERACTION_TYPES` array
- Make ALL event-specific fields optional: `attributeType.optional()`, `productType.optional()`, `facetValue.optional()`
  - Rationale: category browse has no product; search has no attribute; keeping all required creates impossible constraints
- Add optional `categoryId: z.string().max(256).optional()`
- Update `FacetInteractionEvent` interface in `interaction-writer.ts`: make `attributeType`, `productType`, `facetValue` optional (`string | undefined`)
- Update `InteractionType` type alias to include `'search' | 'browse'`
- Update writer mapping (line ~94): use `event.productType ?? ''` to write empty string to ClickHouse (non-nullable LowCardinality column)
- Update `interactionBatchSchema` to include the new event schema
- **Files:** `interactions.ts` (schema), `interaction-writer.ts` (interface + mapping), `types.ts` (if InteractionType defined there)

### T-3: Frontend — Taxonomy transformer + state management (studio)

- Add `BackendTaxonomyResponse` interface matching ACTUAL backend shape:
  ```ts
  { taxonomy: { domain?, categories[], products[], attributes[] },
    attributeMetadata: Record<string, {...}>,
    documentCounts: Record<string, number> }
  ```
- **Store raw taxonomy data** alongside tree: `rawTaxonomy` state for products[]/attributes[] (T-4 needs this for the category→product→attribute join)
- Add `transformTaxonomyToTree()`: categories as parents, products as children via `categoryId` join, documentCounts from response
- Category documentCount = sum of children product counts
- Update `fetchTaxonomy` to use transformer AND store raw data
- **Files:** `BrowsePreviewPage.tsx` (state, interfaces, transformer, effect)

### T-4: Frontend — Facet flow fix (studio)

- **Category→Product→Attribute join** (CRITICAL path):
  1. User selects a category → find `rawTaxonomy.products.filter(p => p.categoryId === selectedCategoryId)`
  2. Collect matching product IDs into a Set
  3. Filter `rawTaxonomy.attributes.filter(a => a.applicableTo.some(pid => productIdSet.has(pid)))`
  4. Cross-reference with `attributeMetadata` for display names and tier filtering
  5. Pick top 8 attributes (by count from attributeMetadata or alphabetical)
- Make **parallel** `getBrowseFacets(indexId, attrName, productName)` calls for each selected attribute
- Fix response handling: each call returns single `FacetResult = {attributeType, values[], total}` — NOT `{facets: [...]}`
- Combine all results into `FacetGroup[]` for sidebar
- **Note:** Facet values are globally scoped (not filtered to search results). This is a known limitation for MVP.
- **Files:** `BrowsePreviewPage.tsx` (new useEffect for facet fetching, remove old broken fetchFacets)

### T-5: Frontend — Document hydration via /query (studio)

- **Extend `executeQuery` type signature** in `search-ai.ts`: add `documentIds?: string[]` to the query parameter type
- Replace `FacetDocumentsResponse` with actual shape: `{documentIds: string[], total: number, truncated: boolean}`
- After getting IDs from facet selection: call `executeQuery(indexId, {query: "*", documentIds, topK: 50})` — DO NOT pass `queryType: 'structured'` because the `/structured` endpoint requires `filters` and does NOT accept `documentIds`. The default `/query` endpoint handles `documentIds` correctly via the unified pipeline. The wildcard query `"*"` will trigger auto-classification but this is acceptable overhead since the result is scoped by documentIds.
- Deduplicate results by `documentId` (keep highest score per document)
- Map `SearchAIResult` → `BrowseDocument`:
  - `id` ← `r.documentId`
  - `title` ← `r.metadata?.title ?? r.source?.sourceName`
  - `summary` ← `r.content` (best chunk)
  - `source` ← `r.source?.sourceName`
  - `sourceUrl` ← `r.source?.reference`
  - `attributes` ← `[]` (cannot populate tier info from SearchResult — known gap)
  - `updatedAt` ← `r.metadata?.updatedAt ?? new Date().toISOString()`
- **Files:** `search-ai.ts` (extend type), `BrowsePreviewPage.tsx` (document fetching effect)

### T-6: Frontend — Wire handleSearch to /query (studio)

- Replace stub with real `executeQuery()` call: `{query, topK: 20}` (NO queryType — let pipeline auto-classify for real search queries)
- Dedup chunks by documentId, map to `BrowseDocument[]`
- After getting results: extract unique documentIds, then call `postBrowseFacetCounts(indexId, documentIds)` to get which attributes have data
- **Post-search facet display:** facet-counts returns `{attributeType, productType, count}[]` — this tells sidebar WHICH facets have data, but NOT their values. For MVP: show attribute names with counts as badges. Full facet values would require additional per-attribute calls (known limitation).
- **Files:** `BrowsePreviewPage.tsx` (handleSearch callback)

### T-7: Frontend — Fix interaction events (studio)

- Map frontend event types to backend:
  - `facet_click` → `'click'` (exists in backend enum)
  - `search` → `'search'` (added in T-2)
  - `browse` → `'browse'` (added in T-2)
- Pass `productType` when available from the sidebar selection context:
  - Category-level browse: omit `productType` (now optional after T-2)
  - Product-level browse: include `productType` from selected product
  - Facet click within product: include `productType`
  - Search: omit `productType` (not in context yet)
- Pass `categoryId` for browse events
- **Note:** Frontend currently only tracks `selectedCategory`, not `selectedProduct`. For MVP, `productType` will be omitted. When T-3 adds product-level tracking in the tree, this can be populated.
- **Files:** `BrowsePreviewPage.tsx` (event handlers)

### T-8: Frontend — Remove dead projectId prop (studio)

- Remove `projectId` from `BrowsePreviewPageProps`
- Update route page to not pass it
- **Files:** `BrowsePreviewPage.tsx`, `browse-preview/page.tsx`

## Dependency Graph

```
T-1 (backend taxonomy counts) ──┐
T-2 (backend interactions)  ────┼──→ T-3 (frontend taxonomy + raw state)
                                │         │
                                │         ▼
                                │    T-4 (frontend facet flow)
                                │         │
                                │         ▼
                                │    T-5 (frontend doc hydration)
                                │         │
                                │         ▼
                                │    T-6 (frontend search)
                                │         │
                                │         ▼
                                └──→ T-7 (frontend interactions)
                                          │
                                          ▼
                                     T-8 (cleanup)
```

**Parallel group A:** T-1, T-2 (backend, separate files, no overlap)
**Sequential:** T-3 → T-4 → T-5 → T-6 → T-7 → T-8 (each depends on prior)

## Decisions & Tradeoffs

| #   | Decision                 | Chose                                                                                          | Over                                 | Because                                                                |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| 1   | Facet selection          | Frontend picks applicable attrs via category→product→attribute join + N parallel calls (max 8) | Server-side FacetDisplayRulesService | MVP scope; FacetDisplayRulesService wiring is Sprint 9                 |
| 2   | Document hydration       | /query with documentIds + queryType:structured + client dedup                                  | New document-level endpoint          | Reuses existing pipeline. structured skips LLM/embedding waste         |
| 3   | Interaction schema       | All event fields optional + extend enum                                                        | Discriminated union                  | Simpler for MVP; union is correct long-term but over-engineered now    |
| 4   | documentCount source     | New FacetQueryService method + ClickHouse GROUP BY product_type                                | Skip counts                          | Counts are critical UX; delegating to service follows existing pattern |
| 5   | Search results           | /query directly + dedup                                                                        | New document-search endpoint         | Zero backend work. Client dedup is 10 lines                            |
| 6   | Post-search faceting     | facet-counts (attribute+count only) + attribute name badges                                    | Full facet values scoped to results  | Full scoping needs documentIds param on /browse/facets — Sprint 9      |
| 7   | Raw taxonomy storage     | Keep raw products[]/attributes[] in state alongside tree                                       | Re-fetch on category select          | Avoids duplicate API call; data already in memory                      |
| 8   | ClickHouse null handling | `event.productType ?? ''` for non-nullable column                                              | ALTER TABLE to make nullable         | Simpler; empty string is a valid sentinel; no DDL migration needed     |

## Known Limitations (MVP)

- Facet values after search are globally scoped, not filtered to search results
- `BrowseDocument.attributes` with tier info cannot be populated from SearchResult.metadata
- No product-level selection tracking (only category) — productType omitted from most interactions
- FacetDisplayRulesService (budget-based facet selection) not wired — all applicable attrs shown

## Out of Scope

- Wiring FacetDisplayRulesService to a server endpoint (Sprint 9)
- collapseByDocument option in query pipeline (Sprint 9)
- documentIds filter on GET /browse/facets for scoped post-search faceting (Sprint 9)
- BrowseAutoSuggest backend (skipped per user decision)
- Product-level navigation state and interaction tracking (Sprint 9)
