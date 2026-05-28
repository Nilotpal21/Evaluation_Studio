# Browse SDK Sprint 1 — Change Manifest

This file tracks what each implementer did, why, and what to expect.
Read this when fixing tests or reviewing code after context loss.

## T-1: Fix summary field read + query filter

**File:** `apps/search-ai/src/workers/kg-enrichment-worker.ts`

### What changed

1. **Lines 167-202 (query filter):** Replaced `summary: { $ne: null }` with a `$and` combining:
   - `$or` for summary: checks both `metadata.documentSummary` and `summary`
   - `$or` for kgState: existing status filter (unchanged logic)
   - When `forceReclassify=true`: only the summary `$or` applies (no status filter)

2. **Lines 319-322 (classification input):** Changed from `document.summary` to:
   ```typescript
   const documentSummary = (document.metadata?.documentSummary as string) || document.summary || '';
   ```

### Why

- Docling-processed documents store their LLM progressive summary at `metadata.documentSummary`, not the top-level `summary` field
- Top-level `summary` is a crude first-chunk stub from the legacy enrichment-worker
- The old query filter `summary: { $ne: null }` silently excluded Docling docs
- MongoDB doesn't allow two `$or` at the same object level, hence `$and` wrapper

### Non-obvious decisions

- Empty string fallback (`|| ''`) ensures `DocumentClassifierService.classifyDocument()` always gets a string, never null/undefined
- The `$and` wraps even the `forceReclassify` path (as a single-element array) for consistency

---

## T-2: Fix chunk entity extraction input

**File:** `apps/search-ai/src/workers/kg-enrichment-worker.ts`

### What changed

**Lines 387-389:** Added fallback chain before entity extraction:

```typescript
const extractionInput = (chunk.metadata?.progressiveSummary as string) || chunk.content;
```

### Why

- `chunk.metadata.progressiveSummary` is a condensed, higher-quality version of the chunk content already generated during ingestion
- Raw `chunk.content` is a valid fallback for legacy chunks without progressive summaries
- Empty-string progressive summary correctly falls back via `||`

---

## T-3: Fix OpenSearch vector DB write

**File:** `apps/search-ai/src/workers/kg-enrichment-worker.ts`

### What changed

**Lines 424-455:** Replaced flat metadata writes with deep-merge pattern:

**Removed:**

- Flat `tenantId`, `indexId`, `documentId` (redundant — already in `metadata.sys.*`)
- Flat `primaryProduct`, `secondaryProducts`, `confidence`, `department`, `category` (violate `dynamic: 'strict'`)
- Flat `kgEnriched`, `kgEnrichedAt` (violate `dynamic: 'strict'`)

**Added:**

- Deep-merge preserving `metadata.sys`, `metadata.doc`, `metadata.canonical` structure
- Classification data under `metadata.canonical.custom.kg` (enabled:false — stored in `_source` but not indexed)
- Null-safe defaults at each nesting level (`|| {}`)

### Why

- OpenSearch `metadata` uses `dynamic: 'strict'` — only `sys`, `doc`, `canonical` sub-objects allowed
- The old flat writes caused `strict_dynamic_mapping_exception` at runtime
- The old spread pattern (`...existingRecords[0]?.metadata, tenantId: ...`) corrupted nesting
- `canonical.custom` has `enabled: false` — accepts arbitrary nested data without indexing
- ClickHouse will be the query-time facet store (Sprint 2+); OpenSearch storage is for display/debugging

### Test expectations

- Build passes: ✅ (verified `pnpm build --filter=@agent-platform/search-ai`)
- No runtime `strict_dynamic_mapping_exception` when enrichment runs
- Classification data accessible via `GET _source.metadata.canonical.custom.kg.*`
