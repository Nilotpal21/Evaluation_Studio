# Knowledge Graph Scaling Fixes — Low-Level Design

## Task T-1: UNWIND Batching in TaxonomyGraphService

### Files to Modify

- `apps/search-ai/src/services/knowledge-graph/taxonomy-graph.service.ts` — all changes in this task

### Function Signatures

#### New: `batchUpsertEntityInstances`

```typescript
async batchUpsertEntityInstances(params: {
  tenantId: string;
  indexId: string;
  entities: Array<{
    id: string;
    attributeId: string;
    rawValue: string;
    normalizedValue: string | number | boolean;
    productId: string;
  }>;
}): Promise<void>
```

Behavior: Opens ONE session, runs a single UNWIND query that MERGEs all entity instances, links to Attribute and Product nodes. Closes session. Existing `upsertEntityInstance()` remains for single-entity callers.

#### Modified: `createTaxonomyGraph`

Same signature. Internals change from loop-based `tx.run()` per node to three UNWIND queries:

1. `UNWIND $categories AS cat MATCH (d:Domain ...) MERGE (c:Category ...) MERGE (d)-[:HAS_CATEGORY]->(c)`
2. `UNWIND $products AS prod MATCH (c:Category ...) MERGE (p:Product ...) MERGE (c)-[:HAS_PRODUCT]->(p)`
3. `UNWIND $attributes AS attr MERGE (a:Attribute ...) SET ...` + separate UNWIND for attribute-product links

#### Modified: `getTaxonomyStats`

Same signature. Cypher changes from unconnected OPTIONAL MATCHes to:

```cypher
CALL { MATCH (d:Domain {tenantId: $tenantId, indexId: $indexId}) RETURN count(d) AS domainCount }
CALL { MATCH (c:Category {tenantId: $tenantId, indexId: $indexId}) RETURN count(c) AS categoryCount }
CALL { MATCH (p:Product {tenantId: $tenantId, indexId: $indexId}) RETURN count(p) AS productCount }
CALL { MATCH (a:Attribute {tenantId: $tenantId, indexId: $indexId}) RETURN count(a) AS attributeCount }
CALL { MATCH (ch:Chunk {tenantId: $tenantId, indexId: $indexId}) RETURN count(ch) AS chunkCount }
CALL { MATCH (e:EntityInstance {tenantId: $tenantId, indexId: $indexId}) RETURN count(e) AS entityInstanceCount }
CALL { MATCH ()-[r:CLASSIFIED_AS]->() WHERE r.confidence IS NOT NULL RETURN count(r) AS classificationCount }
RETURN domainCount, categoryCount, productCount, attributeCount, chunkCount, entityInstanceCount, classificationCount
```

#### Modified: `deleteTaxonomyGraph`

Same signature. Changes from label-less `MATCH (n {tenantId, indexId}) DETACH DELETE n` to label-specific deletes:

```cypher
MATCH (e:EntityInstance {tenantId: $tenantId, indexId: $indexId}) DETACH DELETE e
MATCH (d:Document {tenantId: $tenantId, indexId: $indexId}) DETACH DELETE d
MATCH (ch:Chunk {tenantId: $tenantId, indexId: $indexId}) DETACH DELETE ch
MATCH (a:Attribute {tenantId: $tenantId, indexId: $indexId}) DETACH DELETE a
MATCH (p:Product {tenantId: $tenantId, indexId: $indexId}) DETACH DELETE p
MATCH (c:Category {tenantId: $tenantId, indexId: $indexId}) DETACH DELETE c
MATCH (d2:Domain {tenantId: $tenantId, indexId: $indexId}) DETACH DELETE d2
```

Order matters: delete leaf nodes first (EntityInstance, Document, Chunk), then inner nodes (Attribute, Product), then root (Category, Domain). Each uses its label's composite index.

### Subtasks (execution order)

1. **ST-1.1**: Add `batchUpsertEntityInstances()` method with UNWIND query
2. **ST-1.2**: Refactor `createTaxonomyGraph()` internals to use UNWIND per node type
3. **ST-1.3**: Rewrite `getTaxonomyStats()` with CALL subqueries
4. **ST-1.4**: Rewrite `deleteTaxonomyGraph()` with label-specific deletes

### Acceptance Criteria

- AC-1.1: `batchUpsertEntityInstances` with 100 entities opens exactly 1 Neo4j session (not 100)
  - Verify: Code review — single `getSession()` call, single `session.run()` with UNWIND
- AC-1.2: `createTaxonomyGraph` with 50 products sends ≤5 Cypher statements per transaction (was 50+)
  - Verify: Code review — count `tx.run()` calls (should be: 1 domain + 1 categories UNWIND + 1 products UNWIND + 1 attributes UNWIND + 1 attribute-links UNWIND + optional exclusions UNWIND = ~6 max)
- AC-1.3: `getTaxonomyStats` uses CALL subqueries, no Cartesian product
  - Verify: Code review — no unconnected OPTIONAL MATCH clauses
- AC-1.4: `deleteTaxonomyGraph` uses label-specific queries
  - Verify: Code review — each DELETE targets a specific label
- AC-1.5: All existing methods (`upsertEntityInstance`, `linkDocumentToProduct`, etc.) still work unchanged
  - Verify: `pnpm build --filter=search-ai` passes

---

## Task T-2: p-limit + Batch Entity Upserts in Worker

### Files to Modify

- `apps/search-ai/src/workers/kg-enrichment-worker.ts` — all changes in this task

### Dependencies

- Requires T-1's `batchUpsertEntityInstances()` to exist

### Function Signatures

#### Modified: `processDocumentBatch`

Same signature. Two internal changes:

1. Wrap `batch.map(...)` with `p-limit(5)` to cap concurrency at 5 documents at a time
2. After chunk loop, call `taxonomyGraph.batchUpsertEntityInstances()` once per document (replacing per-entity `upsertEntityInstance()` calls)

### Subtasks (execution order)

1. **ST-2.1**: Add `p-limit` import (install if not already in workspace)
2. **ST-2.2**: Wrap `Promise.all(batch.map(...))` with p-limit concurrency limiter
3. **ST-2.3**: Refactor entity upsert loop to collect entities, then call `batchUpsertEntityInstances()` once per document

### Acceptance Criteria

- AC-2.1: At most 5 documents process concurrently within a batch
  - Verify: Code review — `p-limit(5)` wraps the mapper function
- AC-2.2: Entity upserts use batch method (1 session per document, not 1 per entity)
  - Verify: Code review — `batchUpsertEntityInstances()` called once after chunk loop, old per-entity `upsertEntityInstance()` call removed
- AC-2.3: `pnpm build --filter=search-ai` passes
  - Verify: `pnpm build --filter=search-ai`

---

## Task T-3: Cap previousVersions in Model

### Files to Modify

- `packages/database/src/models/knowledge-graph-taxonomy.model.ts` — add pre-save hook

### Subtasks

1. **ST-3.1**: Add Mongoose `pre('save')` hook that slices `previousVersions` to last 10 entries

### Code

```typescript
KnowledgeGraphTaxonomySchema.pre('save', function (next) {
  if (this.previousVersions && this.previousVersions.length > 10) {
    this.previousVersions = this.previousVersions.slice(-10);
  }
  next();
});
```

### Acceptance Criteria

- AC-3.1: Documents with >10 previousVersions get trimmed to 10 on save
  - Verify: `pnpm build --filter=database` passes
- AC-3.2: The most recent 10 versions are preserved (slice from end, not beginning)
  - Verify: Code review — `slice(-10)` not `slice(0, 10)`
