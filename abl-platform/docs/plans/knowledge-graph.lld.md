# Knowledge Graph -- Low-Level Design

**Feature Spec**: `docs/features/knowledge-graph.md`
**HLD**: `docs/specs/knowledge-graph.hld.md`
**Testing Guide**: `docs/testing/knowledge-graph.md`
**Status**: DONE (core + ABLP-303 RACL migration)

---

## Implementation Structure

### Services

| File                                                                     | Purpose                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/services/knowledge-graph/taxonomy-graph.service.ts`  | Neo4j graph operations: create taxonomy (batched Cypher), link documents/chunks to products, batch entity upserts (dedup by attributeId+normalizedValue), get stats, get graph structure for visualization, cascade delete |
| `apps/search-ai/src/services/knowledge-graph/clickhouse-entity-store.ts` | ClickHouse-backed entity analytics storage                                                                                                                                                                                 |
| `apps/search-ai/src/services/taxonomy-loader.service.ts`                 | Loads domain definitions from JSON files in `data/domains/` directory                                                                                                                                                      |
| `apps/search-ai/src/services/document-classifier.service.ts`             | LLM-based document classification: builds prompts from taxonomy, calls Haiku, escalates to Sonnet on low confidence                                                                                                        |
| `apps/search-ai/src/services/entity-extractor.service.ts`                | Hybrid extraction: regex patterns for simple types (dates, numbers, IDs), LLM for complex types. Exports `NovelCandidate` type for discovered entities not in taxonomy.                                                    |
| `apps/search-ai/src/services/kg-model-assessment.ts`                     | Assesses tenant model capabilities for KG operations; recommends best model. Exports `assessKGCapabilities()` and `recommendModelForKG()`.                                                                                 |
| `apps/search-ai/src/services/org-profile-generator.service.ts`           | Generates organization profiles via LLM for taxonomy setup context                                                                                                                                                         |
| `apps/search-ai/src/services/custom-domain-generator.service.ts`         | Generates custom domain taxonomies from org profile + sample documents                                                                                                                                                     |

### Routes

| File                                         | Endpoints                                                                                                                                                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/routes/kg-taxonomy.ts`   | GET /:indexId/kg-configuration-status, POST /:indexId/kg-configure-model, POST /:indexId/kg-taxonomy/setup, GET /:indexId/kg-taxonomy, PUT /:indexId/kg-taxonomy, DELETE /:indexId/kg-taxonomy, GET /:indexId/kg-taxonomy/setup/:jobId |
| `apps/search-ai/src/routes/kg-enrichment.ts` | POST /:indexId/kg-enrich, GET /:indexId/kg-enrich/jobs/:jobId, GET /:indexId/kg-enrich/jobs, GET /:indexId/kg-enrich/stats, GET /:indexId/kg-enrich/documents, GET /:indexId/kg-enrich/entities, GET /:indexId/kg-enrich/graph         |

### Workers

| File                                                  | Queue            | Purpose                                                      |
| ----------------------------------------------------- | ---------------- | ------------------------------------------------------------ |
| `apps/search-ai/src/workers/kg-enrichment-worker.ts`  | `kg-enrichment`  | Batch classification + entity extraction for an entire index |
| `apps/search-ai/src/workers/taxonomy-setup-worker.ts` | `taxonomy-setup` | Async taxonomy creation from domain definitions              |

### Scripts

| File                                                      | Purpose                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/search-ai/src/scripts/backfill-entity-instances.ts` | Migration script to backfill entity instances for existing classified documents |

---

## TaxonomyGraphService Detail

The `TaxonomyGraphService` class manages the full Neo4j lifecycle:

### Initialization

- `connect()`: Creates Neo4j driver with configurable pool size (default 100). Calls `createConstraintsAndIndexes()` to ensure uniqueness constraints on all node types and indexes on frequently queried properties.
- `close()`: Closes driver connection.

### Graph CRUD

- `createTaxonomyGraph()`: Single transaction that creates Domain, Categories (batched UNWIND), Products (batched UNWIND with category linking), Attributes (batched UNWIND), Attribute-Product links, and Product exclusion relationships.
- `deleteTaxonomyGraph()`: Deletes in dependency order to avoid constraint violations: EntityInstance -> Document -> Chunk -> Attribute -> Product -> Category -> Domain.

### Classification

- `linkDocumentToProduct()`: MERGE Document node, MATCH Product, create CLASSIFIED_AS relationship with confidence and timestamp.
- `batchLinkChunksToProducts()`: Batch version for chunk-level classification.

### Entity Management

- `upsertEntityInstance()`: MERGE by (tenantId, indexId, id) where id = `attributeId:normalizedValue`. ON CREATE sets initial values; ON MATCH increments documentCount and updates lastSeenAt.
- `batchUpsertEntityInstances()`: UNWIND-based batch version for efficiency.
- `getTopEntityInstancesByProduct()`: Returns top entities by documentCount for a product.

### Visualization

- `getTaxonomyGraphStructure()`: Returns nodes and edges for full taxonomy tree with deduplication via `seenNodes` set.
- `getTaxonomyStats()`: Parallel subqueries for counts of each node type.

---

## KG Enrichment Worker Detail

The `kg-enrichment-worker.ts` processes entire indexes in batches:

1. **Load taxonomy**: Fetch `KnowledgeGraphTaxonomy` for the index.
2. **Load documents**: Query `SearchDocument` with existing summaries, optionally filtered by `uploadedAfter`.
3. **Classify documents**: For each document batch (configurable `batchSize`, default 50):
   - Call `DocumentClassifierService` with document summary + taxonomy products
   - Haiku primary model; Sonnet escalation if confidence < 0.8
   - Update `SearchDocument.kgClassification` in MongoDB
   - Create CLASSIFIED_AS relationship in Neo4j
4. **Extract entities**: For each classified document:
   - Load applicable attributes from taxonomy based on product type
   - Run hybrid extraction: regex patterns first, LLM fallback for complex types
   - Upsert EntityInstance nodes in Neo4j (dedup)
   - Store in ClickHouse entity store
5. **Update progress**: `job.updateProgress()` at each batch boundary.

Concurrency controlled via `p-limit`.

---

## Known Gaps

1. **TaxonomyGraphService**: Zero test coverage for all Neo4j operations.
2. **DocumentClassifierService**: Zero test coverage for classification logic and model escalation.
3. **EntityExtractorService**: Zero test coverage for hybrid extraction.
4. **No E2E route tests**: Taxonomy and enrichment API endpoints have no E2E coverage.
5. **Batch entity loop**: `batchLinkChunksToProducts` iterates with individual `tx.run()` calls inside a write transaction instead of using UNWIND, which may be slow for large batches.
6. **MongoPermissionStore**: No dedicated unit tests for CRUD operations (added ABLP-303).
7. **BFS effective groups**: No dedicated unit tests for cycle detection, max depth, diamond hierarchy (added ABLP-303).
8. ~~**No tenant isolation tests**~~: RESOLVED — Tenant isolation integration tests added.

---

## ABLP-303 Implementation (Apr 2026)

ABLP-303 added the RACL (Role-Aware Content Labeling) migration from Neo4j to MongoDB. See `docs/plans/ABLP-303-neo4j-to-mongo-racl-tasks.md` for the full task breakdown.

### Files Added

| File                                                                      | Purpose                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------- |
| `packages/database/src/models/acl-document-permissions.model.ts`          | Per-document permission data (MongoDB)         |
| `packages/database/src/models/acl-group-hierarchy.model.ts`               | Group tree structure (MongoDB)                 |
| `packages/search-ai-internal/src/permissions/mongo-permission-store.ts`   | Drop-in replacement for PermissionGraphService |
| `packages/search-ai-internal/src/permissions/effective-groups-compute.ts` | BFS transitive group closure pre-computation   |
| `apps/search-ai/src/workers/shared.ts`                                    | Common BullMQ worker utilities                 |

### Files Modified (41 total)

- All IdP sync workers (Azure AD, Okta, Google): Rewritten for MongoDB
- SharePoint permission crawler: Rewritten for MongoDB
- Document permission resolver: Reads from MongoDB; fail-closed default
- Permission filter service (runtime): 3-tier resolution
- Permission filter middleware (runtime): Contact-based auth support
- SearchAI/SearchAI-Runtime server init: Neo4j removed from permission path
- Embedding worker: Stamps `publicEverywhere` for non-RACL sources
- Contact model: Extended with `sourceIdentities[]` and `acl{}`
