# Browse SDK Sprint 1: KG Enrichment Worker Bug Fixes — High-Level Design

## What

Fix 3 critical bugs in `kg-enrichment-worker.ts` that prevent KG enrichment from working correctly:

1. **Summary field mismatch** — Worker reads `document.summary` (a crude first-chunk stub from the legacy enrichment-worker) instead of `metadata.documentSummary` (the real LLM progressive summary from page-processing-worker). For Docling-processed documents, `summary` may be null, causing them to be silently excluded from enrichment.
2. **Chunk content suboptimal** — Worker passes raw `chunk.content` to entity extraction, ignoring `chunk.metadata.progressiveSummary` which is a higher-quality, condensed representation already generated during ingestion.
3. **OpenSearch strict mapping violation** — Worker writes flat classification fields (`primaryProduct`, `secondaryProducts`, `confidence`, `department`, `category`, `kgEnriched`, `kgEnrichedAt`) plus redundant flat `tenantId`/`indexId`/`documentId` directly into the metadata object. The OpenSearch mapping uses `dynamic: 'strict'` on `metadata` — only `sys`, `doc`, and `canonical` sub-objects are allowed. These upserts throw `strict_dynamic_mapping_exception` at runtime, meaning **no classification data reaches OpenSearch**. Additionally, the spread pattern corrupts the nested `{sys, doc, canonical}` structure.

These are pure bug fixes — no new features, no new APIs, no new models.

## Architecture Approach

- **Package changed:** `apps/search-ai` only (single file: `kg-enrichment-worker.ts`)
- **No schema changes** — OpenSearch mapping, MongoDB models unchanged
- **No new dependencies**

### Data Flow (Current → Fixed)

```
CURRENT (broken):
  Document query: { summary: { $ne: null } }           ← misses Docling docs
  Classification input: document.summary                ← crude stub, not real summary
  Entity extraction input: chunk.content                ← raw text, not progressive summary
  Vector DB write: { tenantId, primaryProduct, ... }    ← FAILS: strict mapping violation
                                                          + corrupts nested structure

FIXED:
  Document query: $and: [                               ← finds ALL docs with any summary
    { $or: [                                              while preserving kgState filter
      { 'metadata.documentSummary': { $ne: null } },
      { summary: { $ne: null } }
    ]},
    { $or: [ kgState status filter ] }                    (existing logic)
  ]
  Classification input: metadata.documentSummary || summary    ← best available summary
  Entity extraction input: progressiveSummary || content       ← best available content
  Vector DB write: canonical.custom.kg = { ... }               ← stored under enabled:false
                   (preserves existing sys/doc/canonical)
```

### Query Filter Complexity Note

The current code builds the MongoDB query incrementally, adding `$or` for kgState at line 182. Since MongoDB doesn't allow two `$or` keys at the top level of a single object, the fix must restructure to use `$and` combining both `$or` conditions. This is the standard MongoDB pattern for combining multiple `$or` clauses.

### Key Integration Points

- `page-processing-worker.ts` — writes `metadata.documentSummary` (line 714) and `chunk.metadata.progressiveSummary` (line 497)
- `enrichment-worker.ts` — writes top-level `document.summary` (line 158, legacy path)
- `opensearch-mappings.ts` — `metadata.canonical.custom` has `enabled: false` (stored in `_source`, not indexed) — safe for arbitrary data. Parent `metadata.canonical` has `dynamic: 'false'` (stores unknown fields without indexing).
- `embedding-worker.ts` — also reads `document.summary` for `metadata.doc.summary` (line 352) — **out of scope** for this PR but noted

## Decisions & Tradeoffs

- **Decision 1:** Write KG classification under `metadata.canonical.custom.kg` instead of removing the vector DB write entirely.
  - **Why:** Preserves the ability to access classification data from OpenSearch `_source` for display/debugging, even though ClickHouse will be the query-time facet store (Sprint 2+). Zero cost since `enabled: false` means no indexing overhead.
  - **Alternative rejected:** Remove vector DB write entirely — loses data locality for future use.

- **Decision 2:** Use fallback chain `metadata.documentSummary || summary` rather than only reading `metadata.documentSummary`.
  - **Why:** Legacy (non-Docling) documents may only have the top-level `summary` field populated by the older enrichment-worker. We need backward compatibility.

- **Decision 3:** Use `chunk.metadata?.progressiveSummary || chunk.content` for entity extraction rather than only progressiveSummary.
  - **Why:** Not all chunks have progressive summaries (e.g., legacy ingestion, failed summarization). Raw content is a valid fallback. Empty-string progressiveSummary correctly falls back to content via `||`.

- **Decision 4:** Preserve existing nested metadata structure via deep-merge when updating vector DB records.
  - **Why:** Current code spreads `existingRecords[0]?.metadata` then overwrites with flat `tenantId`, `indexId`, `documentId` (duplicating `sys.*` fields) and KG fields, corrupting the `{sys, doc, canonical}` nesting. Fix removes redundant flat fields and writes only into `canonical.custom.kg`, using null-safe traversal at each level (`metadata?.canonical?.custom`).

- **Decision 5:** Use `$and` to combine the summary `$or` with the kgState `$or` in the MongoDB query.
  - **Why:** MongoDB does not allow two `$or` keys at the top level. The `$and` pattern is the standard solution and maintains query clarity with comments.

## Task Decomposition

| Task                                       | Package(s)     | Independent? | Est. Files |
| ------------------------------------------ | -------------- | ------------ | ---------- |
| T-1: Fix summary field read + query filter | apps/search-ai | Yes          | 1          |
| T-2: Fix chunk entity extraction input     | apps/search-ai | Yes          | 1          |
| T-3: Fix OpenSearch vector DB write        | apps/search-ai | Yes          | 1          |

All three tasks modify the SAME file (`kg-enrichment-worker.ts`) at non-overlapping line ranges. They will be implemented sequentially in a single implementer to avoid merge conflicts.

## Review Findings (3 rounds)

### Round 1 — Technical Correctness

- **FOUND:** MongoDB `$or` conflict — current code adds `$or` for kgState; adding another `$or` for summary creates key collision. Fixed by using `$and` wrapper.
- **FOUND:** Redundant flat `tenantId`/`indexId`/`documentId` at lines 410-412 duplicate `metadata.sys.*` and also violate strict mode. Must remove.
- **VERIFIED:** `canonical.custom` `enabled: false` allows arbitrary nested data — confirmed by OpenSearch docs and mapping definition.

### Round 2 — Completeness

- **VERIFIED:** `embedding-worker.ts` also reads wrong summary field but is correctly scoped out.
- **VERIFIED:** `DocumentClassifierService.classifyDocument()` accepts `summary: string` — our fallback chain always provides a string (query filter ensures at least one is non-null).
- **NOTED:** No performance impact — `$or` on `summary`/`metadata.documentSummary` adds negligible cost since the query is already filtered by indexed `tenantId` + `indexId`.

### Round 3 — Edge Cases

- **Empty string progressive summary:** `'' || chunk.content` correctly falls back. ✅
- **Both summary fields populated:** `metadata.documentSummary || summary` correctly prefers the better quality one. ✅
- **Undefined metadata on vector record:** `...undefined` is a no-op in JS; null-safe traversal (`?.`) at each level prevents runtime errors. ✅
- **Re-enrichment of same document:** `canonical.custom.kg` is idempotently overwritten. ✅
- **Document with neither summary:** Query filter excludes it (both `$or` branches fail). ✅

## Out of Scope

- Fixing `embedding-worker.ts` (also reads wrong summary field) — separate PR
- Fixing `console.error` usage in `document-classifier.service.ts` and `entity-extractor.service.ts` — code hygiene, not a bug
- Adding unit tests for the KG enrichment worker — tracked separately
- ClickHouse entity instance storage (Sprint 2)
- Any new API endpoints or models
