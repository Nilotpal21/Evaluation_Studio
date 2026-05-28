# Knowledge Graph Scaling Fixes — Change Manifest

This file tracks what each implementer did, why, and what to expect.
Read this when fixing tests or reviewing code after context loss.

### T-3: Cap previousVersions in KnowledgeGraphTaxonomy Model

**Files changed:**

- `apps/search-ai/src/services/taxonomy-loader.service.ts` — added post-update trim of `previousVersions` array in `saveTaxonomy()`

**Functions modified:**

- `saveTaxonomy(taxonomyDoc): Promise<string>` — after the existing `findOneAndUpdate` upsert, added a guard that checks if `previousVersions.length > 10` and, if so, issues a follow-up `updateOne` with `$push: { previousVersions: { $each: [], $slice: -10 } }` to keep only the 10 most recent snapshots.
- Key logic: uses MongoDB `$slice: -10` (negative = keep last N) so the most recent versions are retained. The cap constant `MAX_PREVIOUS_VERSIONS = 10` is defined locally at the call site.

**Tests:**

- No new tests added (no test file in scope for this subtask).

**Gotchas:**

- `saveTaxonomy()` uses `findOneAndUpdate` — Mongoose pre-save hooks do NOT fire, which is why `$slice` is applied as a separate `updateOne` rather than a middleware hook.
- The trim is a separate write. In the rare race where two concurrent saves both exceed the cap, both will trim — this is safe since `$slice` is idempotent.
- Each version snapshot is 50-100KB; without this cap, the document would hit MongoDB's 16MB BSON limit after ~50-160 updates.

### T-1: UNWIND Batching in TaxonomyGraphService

**Files changed:**

- `apps/search-ai/src/services/knowledge-graph/taxonomy-graph.service.ts` — refactored 4 methods to use UNWIND batching and CALL subqueries

**Functions added/modified:**

- `batchUpsertEntityInstances(params): Promise<void>` — NEW method. Accepts array of entities and uses single UNWIND Cypher query instead of one-per-entity round trips. Same MERGE/ON CREATE/ON MATCH semantics as `upsertEntityInstance()`.
- `createTaxonomyGraph(tenantId, indexId, taxonomy): Promise<void>` — MODIFIED. Replaced 4 for-loops (categories, products, attributes, exclusions) with UNWIND-based batched queries. Attribute-product links collected via `flatMap` and sent as single UNWIND. All still within one `session.executeWrite()` transaction.
- `getTaxonomyStats(tenantId, indexId): Promise<stats>` — MODIFIED. Replaced Cartesian-product query (OPTIONAL MATCH chains) with 7 independent CALL subqueries. Fixes exponential row blowup. Classification count subquery now filters by tenant/index via Document label.
- `deleteTaxonomyGraph(tenantId, indexId): Promise<void>` — MODIFIED. Replaced single label-less MATCH with 7 label-specific DETACH DELETE statements inside one `executeWrite` transaction. Deletes leaf nodes first (EntityInstance, Document, Chunk) then inner (Attribute, Product, Category) then root (Domain).

**Tests:**

- No new tests (no test file in scope for this subtask).

**Gotchas:**

- `getTaxonomyStats` CALL subqueries require Neo4j v5+ (confirmed from docker-compose.yml).
- `batchUpsertEntityInstances` serializes `normalizedValue` objects to JSON strings for Neo4j compatibility (same pattern as existing `upsertEntityInstance`).
- `deleteTaxonomyGraph` delete order matters: leaf-first prevents orphaned relationships during the transaction.
- The old `getTaxonomyStats` query had a cross-tenant bug: `CLASSIFIED_AS` relationships were counted globally (no tenant/index filter). Fixed by scoping through `Document` nodes with tenant/index properties.
- Existing methods `upsertEntityInstance`, `createEntityInstance`, `batchCreateEntityInstances`, `batchLinkChunksToProducts` are UNCHANGED.

### T-2: p-limit Concurrency + Batch Entity Upserts in Worker

**Files changed:**

- `apps/search-ai/src/workers/kg-enrichment-worker.ts` — added p-limit(5) concurrency cap to `processDocumentBatch()` and replaced per-entity Neo4j upserts with single batch call

**Dependencies added:**

- `p-limit@7.3.0` to `apps/search-ai/package.json` (ESM-compatible)

**Functions modified:**

- `processDocumentBatch(batch, taxonomy, ...): Promise<void>` — Two changes:
  1. Wrapped `Promise.all(batch.map(...))` with `pLimit(5)` to cap concurrent document processing at 5 (was unbounded, causing Neo4j/LLM connection exhaustion on large batches).
  2. Replaced individual `taxonomyGraph.upsertEntityInstance()` calls inside the entity dedup loop with a single `taxonomyGraph.batchUpsertEntityInstances()` call after the chunk for-loop. Entities are collected into `entitiesToUpsert` array from the existing `entityInstancesMap`.

**Tests:**

- No new tests (no test file in scope for this subtask).
- Build verification: `pnpm build --filter=@agent-platform/search-ai` passes with zero type errors.

**Gotchas:**

- `entityInstancesMap` is still populated inside the chunk/entity loop (needed for the MongoDB document update at the end). Only the Neo4j upsert was moved out of the loop.
- The batch upsert maps `entityInstanceId` → `id`, `type` → `attributeId` to match the `batchUpsertEntityInstances` parameter shape.
- `stats.neo4jLinksCreated` is now incremented by `entitiesToUpsert.length` once (instead of `++` per entity), preserving the same total count.
- p-limit v7.x is pure ESM — compatible with search-ai's ESM module system.
