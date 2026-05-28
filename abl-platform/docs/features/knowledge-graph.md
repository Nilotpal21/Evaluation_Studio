# Feature Spec: Knowledge Graph

> **Feature ID**: #37
> **Status**: ALPHA
> **Owner**: SearchAI Team
> **Created**: 2026-02-25
> **Updated**: 2026-04-14

---

## 1. Problem Statement

SearchAI's vector-based semantic search returns results based on embedding similarity alone. This leads to three critical failure modes:

1. **Product disambiguation failure**: Queries like "interest rate on credit cards" vs "interest rate on debit cards" return mixed results because embeddings cannot distinguish product-scoped attributes. Documents about credit cards are incorrectly linked to debit card entities.
2. **False entity relationships**: Without domain-aware graph structure, entities co-occurring in the same corpus are linked regardless of whether the relationship is meaningful. "Priority P1" means different things in Sales, Support, and Engineering contexts.
3. **No cross-document navigation**: Users cannot traverse relationships between entities across documents (e.g., "find all contracts referencing Exhibit A" or "show all documents mentioning Microsoft and its subsidiaries").

**Impact**: Enterprise customers with large document corpora (10K+ documents) report 30-40% irrelevant results in product-scoped queries. Banks, insurance companies, and healthcare organizations cannot safely deploy SearchAI for regulated product documentation where disambiguation is mandatory.

---

## 2. Solution Overview

A **domain-aware knowledge graph** that:

- Extracts entities and relationships from documents during ingestion using hybrid methods (regex + NLP + LLM)
- Stores taxonomy graph structure in Neo4j with strict tenant isolation
- Classifies documents and chunks by product scope using taxonomy-driven LLM classification
- Enables graph-augmented search with entity-centric queries and relationship-based ranking
- Supports taxonomy-driven disambiguation via configurable domain definitions
- Stores connector permission data (RACL) in MongoDB, replacing the former Neo4j-based permission graph

The system operates in two layers:

- **Layer 1 (Entity Graph)**: Generic entity extraction (PERSON, ORG, LOCATION, etc.) with co-occurrence analysis and IDF-weighted relationship scoring
- **Layer 2 (Taxonomy Graph)**: Domain-specific taxonomy (Domain > Category > Product > Attribute) with chunk classification, scoped entity extraction, and impossible query detection

> **ABLP-303 (Apr 2026)**: The connector RACL (Role-Aware Content Labeling) subsystem was migrated from Neo4j to MongoDB. User/group sync, document permissions, and query-time permission filtering now use MongoDB collections (`contacts`, `acl_group_hierarchy`, `acl_document_permissions`) with BFS pre-computed effective groups. Neo4j remains in use for the taxonomy graph only.

---

## 3. Scope

### In Scope

- Entity extraction from document chunks (regex, Compromise NLP, hybrid modes)
- Cross-document reference extraction (contracts, exhibits, sections, appendices, etc.)
- Co-occurrence analysis with IDF-weighted relationship scoring
- Neo4j graph storage with tenant isolation (all nodes include `tenantId`)
- Taxonomy graph: Domain > Category > Product > Attribute hierarchy
- Document-level and chunk-level product scope classification (LLM-based)
- Scoped entity extraction (only attributes applicable to document's product type)
- KG enrichment worker (BullMQ job) for background processing
- REST API for taxonomy management (CRUD)
- REST API for KG enrichment (trigger, status, stats)
- REST API for graph visualization (nodes/edges)
- Organization profile and custom domain generation (LLM-based)
- Taxonomy versioning with rollback support
- MongoDB models: `KnowledgeGraphDomain`, `KnowledgeGraphTaxonomy`

### Out of Scope (Phase 2/3)

- Graph-based retrieval API (`POST /api/search/:indexId/graph`) — planned Phase 3
- Entity-centric search ("find all docs mentioning Microsoft") — planned Phase 3
- Relationship-based ranking (boost results connected to query entities) — planned Phase 3
- LLM-based entity extraction (higher quality, more types) — planned Phase 2
- Entity resolution (merge duplicates: "Microsoft" = "Microsoft Corp") — planned Phase 2
- Cross-index entity linking — planned Phase 2
- Temporal graph analysis (entity evolution over time) — planned Phase 3
- Studio UI for knowledge graph visualization — future

---

## 4. User Stories

### US-1: Tenant Admin Sets Up Taxonomy

**As** a tenant admin, **I want to** configure a domain taxonomy for my search index **so that** documents are classified by product scope and search results are disambiguated.

**Acceptance Criteria**:

- POST `/api/indexes/:indexId/kg-taxonomy/setup` creates taxonomy from domain definitions + organization profile
- Taxonomy stored in MongoDB (`KnowledgeGraphTaxonomy`) and Neo4j
- One taxonomy per index (unique constraint on `tenantId` + `indexId`)
- Taxonomy versioning with history preserved in `previousVersions`
- Supports built-in domains and custom LLM-generated domains

### US-2: Tenant Admin Triggers KG Enrichment

**As** a tenant admin, **I want to** trigger knowledge graph enrichment for my index **so that** all documents are classified and entity-extracted.

**Acceptance Criteria**:

- POST `/api/indexes/:indexId/kg-enrich` triggers background enrichment job
- Only processes documents with summaries (reuses existing ingestion output)
- Supports `forceReclassify`, `retrySkipped`, `batchSize`, `uploadedAfter` options
- Job status polling via GET `/api/indexes/:indexId/kg-enrich/jobs/:jobId`
- Progress tracking with estimated completion time

### US-3: Search User Gets Disambiguated Results

**As** a search user, **I want to** query "interest rate on credit cards" and get only credit card results **so that** I don't see irrelevant debit card or loan documents.

**Acceptance Criteria**:

- Documents classified with `primaryProduct` and `secondaryProducts` with confidence scores
- Classification stored in `SearchDocument.classification.productScope`
- Configurable confidence threshold per index (default 0.7)
- Impossible query detection blocks nonsensical queries (e.g., "interest rate on debit cards" when interest rate is not applicable to debit cards)

### US-4: Admin Views KG Statistics

**As** a tenant admin, **I want to** view knowledge graph statistics **so that** I can monitor enrichment progress and data quality.

**Acceptance Criteria**:

- GET `/api/indexes/:indexId/kg-enrich/stats` returns: total/enriched/pending/skipped documents, product distribution, department distribution, average confidence, taxonomy version
- GET `/api/indexes/:indexId/kg-enrich/entities` returns entity distribution with sample values
- GET `/api/indexes/:indexId/kg-enrich/graph` returns graph structure for visualization (nodes/edges with filtering)

### US-5: Developer Queries Entity Relationships

**As** a developer, **I want to** find entities related to a given entity via graph traversal **so that** I can build entity-centric features.

**Acceptance Criteria**:

- `KnowledgeGraphService.findRelatedEntities(tenantId, indexId, entityText, relationshipType, limit)` returns related entities with weights
- `KnowledgeGraphService.getGraphStats(tenantId, indexId)` returns entity count, relationship count, type distribution
- Graph traversal respects tenant isolation (all queries include `tenantId`)

### US-6: Admin Updates Taxonomy

**As** a tenant admin, **I want to** update the taxonomy when business requirements change **so that** document classification reflects the new product structure.

**Acceptance Criteria**:

- PUT `/api/indexes/:indexId/kg-taxonomy` updates taxonomy and creates version history
- Previous version stored in `previousVersions` array
- Re-classification can be triggered separately via POST `/api/indexes/:indexId/kg-enrich` with `forceReclassify: true`

---

## 5. Functional Requirements

| ID    | Requirement                                                               | Priority | Status      |
| ----- | ------------------------------------------------------------------------- | -------- | ----------- |
| FR-1  | Entity extraction via regex patterns (EMAIL, URL, DATE, MONEY, PHONE)     | P0       | DONE        |
| FR-2  | Entity extraction via Compromise NLP (PERSON, ORGANIZATION, LOCATION)     | P0       | DONE        |
| FR-3  | Hybrid entity extraction combining regex + NLP with deduplication         | P0       | DONE        |
| FR-4  | Cross-document reference extraction (contracts, exhibits, sections, etc.) | P0       | DONE        |
| FR-5  | Co-occurrence analysis with IDF weighting                                 | P0       | DONE        |
| FR-6  | Neo4j graph storage with tenant isolation                                 | P0       | DONE        |
| FR-7  | Unique entity constraint (tenantId, indexId, type, text)                  | P0       | DONE        |
| FR-8  | Batch entity upsert and relationship upsert                               | P0       | DONE        |
| FR-9  | Graph store abstraction (interface + InMemoryGraphStore for testing)      | P1       | DONE        |
| FR-10 | Taxonomy graph: Domain > Category > Product > Attribute hierarchy         | P0       | DONE        |
| FR-11 | Taxonomy setup API (POST `/indexes/:indexId/kg-taxonomy/setup`)           | P0       | DONE        |
| FR-12 | Taxonomy CRUD APIs (GET, PUT, DELETE)                                     | P0       | DONE        |
| FR-13 | KG enrichment worker (BullMQ background job)                              | P0       | DONE        |
| FR-14 | Document-level product scope classification (LLM-based)                   | P0       | DONE        |
| FR-15 | Scoped entity extraction (product-applicable attributes only)             | P0       | DONE        |
| FR-16 | Hybrid LLM strategy: Haiku primary, Sonnet escalation if confidence < 0.8 | P1       | DONE        |
| FR-17 | KG enrichment trigger API with filtering and options                      | P0       | DONE        |
| FR-18 | Job status polling API                                                    | P0       | DONE        |
| FR-19 | KG statistics API (enrichment progress, product distribution)             | P0       | DONE        |
| FR-20 | Entity distribution API                                                   | P1       | DONE        |
| FR-21 | Graph visualization API (nodes/edges)                                     | P1       | DONE        |
| FR-22 | Organization profile generation (LLM-based)                               | P1       | DONE        |
| FR-23 | Custom domain generation (LLM-based)                                      | P1       | DONE        |
| FR-24 | Taxonomy versioning with rollback                                         | P1       | DONE        |
| FR-25 | KG configuration status check (workspace-aware model recommendations)     | P1       | DONE        |
| FR-26 | Graph-based retrieval API for search queries                              | P0       | NOT STARTED |
| FR-27 | Entity-centric search                                                     | P1       | NOT STARTED |
| FR-28 | Relationship-based search ranking                                         | P1       | NOT STARTED |
| FR-29 | Entity resolution (merge duplicates)                                      | P2       | NOT STARTED |
| FR-30 | Cross-index entity linking                                                | P2       | NOT STARTED |

---

## 6. Non-Functional Requirements

| ID     | Requirement                        | Target                             | Status            |
| ------ | ---------------------------------- | ---------------------------------- | ----------------- |
| NFR-1  | Entity extraction throughput       | >= 200 chunks/sec (compromise)     | MET               |
| NFR-2  | Neo4j batch write throughput       | >= 1000 entities/sec               | MET               |
| NFR-3  | Neo4j taxonomy lookup latency      | <= 10ms                            | MET               |
| NFR-4  | Document classification latency    | <= 500ms (Haiku), <= 2s (Sonnet)   | MET               |
| NFR-5  | Query-time disambiguation overhead | <= 50ms                            | PENDING (Phase 3) |
| NFR-6  | KG enrichment pipeline latency     | +500-1000ms per document           | MET               |
| NFR-7  | Tenant isolation                   | All Neo4j queries include tenantId | MET               |
| NFR-8  | Cost per 1K documents              | <= $1.50 (hybrid LLM)              | MET ($1.15)       |
| NFR-9  | Taxonomy setup cost                | <= $1.00 one-time                  | MET ($0.75)       |
| NFR-10 | Neo4j connection pool              | Configurable max pool size         | MET               |
| NFR-11 | Enrichment job resilience          | 3 retries with exponential backoff | MET               |
| NFR-12 | Co-occurrence memory               | O(n^2) mitigated by chunking       | MET               |

---

## 7. Data Model

### Neo4j Nodes

| Node Label       | Key Properties                                                                                 | Unique Constraint                 |
| ---------------- | ---------------------------------------------------------------------------------------------- | --------------------------------- |
| `Entity`         | `id`, `text`, `type`, `tenantId`, `indexId`, `documentId`, `chunkId`, `occurrenceCount`, `idf` | `(tenantId, indexId, type, text)` |
| `Domain`         | `id`, `name`, `version`, `tenantId`, `indexId`                                                 | `(tenantId, indexId, id)`         |
| `Category`       | `id`, `name`, `department`, `tenantId`, `indexId`                                              | `(tenantId, indexId, id)`         |
| `Product`        | `id`, `name`, `department`, `subDepartment`, `disambiguationKeywords`, `tenantId`, `indexId`   | `(tenantId, indexId, id)`         |
| `Attribute`      | `id`, `name`, `dataType`, `applicableTo`, `notApplicableTo`, `tenantId`, `indexId`             | `(tenantId, indexId, id)`         |
| `Chunk`          | `id`, `documentId`, `tenantId`, `indexId`                                                      | `(tenantId, indexId, id)`         |
| `Document`       | `id`, `tenantId`, `indexId`                                                                    | N/A                               |
| `EntityInstance` | `id`, `attributeId`, `value`, `normalizedValue`, `documentCount`, `tenantId`, `indexId`        | `(tenantId, indexId, id)`         |

### Neo4j Relationships

| Type                      | From           | To        | Properties                                                              |
| ------------------------- | -------------- | --------- | ----------------------------------------------------------------------- |
| `CO_OCCURS`               | Entity         | Entity    | `weight`, `count`, `tenantId`, `indexId`, `metadata`                    |
| `REFERENCES`              | Entity         | Entity    | `weight`, `count`, `tenantId`, `indexId`, `referenceType`, `identifier` |
| `HAS_CATEGORY`            | Domain         | Category  | N/A                                                                     |
| `HAS_PRODUCT`             | Category       | Product   | N/A                                                                     |
| `HAS_ATTRIBUTE`           | Product        | Attribute | N/A                                                                     |
| `CLASSIFIED_AS`           | Chunk/Document | Product   | `confidence`, `classifiedAt`                                            |
| `INSTANCE_OF`             | EntityInstance | Attribute | N/A (Neo4j stored: entity→attr; API graph response: attr→entity)        |
| `FOUND_IN_PRODUCT`        | EntityInstance | Product   | N/A (Neo4j stored: entity→product; API graph response: product→entity)  |
| `EXTRACTED_FROM_DOCUMENT` | EntityInstance | Document  | N/A                                                                     |
| `EXCLUDES`                | Product        | Product   | `reasoning`                                                             |

### MongoDB Models

| Collection                 | Key Fields                                                                                                                                                        | Indexes                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge_graph_domains`  | `_id`, `tenantId`, `name`, `version`, `industry`, `categories`, `products`, `attributes`, `departmentBoundaries`, `createdBy`                                     | `(tenantId, name)` UNIQUE, `(tenantId, createdAt)`                                                                                        |
| `knowledge_graph_taxonomy` | `_id`, `tenantId`, `indexId`, `taxonomy`, `version`, `domains`, `previousVersions`                                                                                | `(tenantId, indexId)` UNIQUE                                                                                                              |
| `acl_document_permissions` | `_id`, `tenantId`, `documentId`, `source`, `allowedUsers[]`, `allowedGroups[]`, `allowedDomains[]`, `publicInDomain`, `publicEverywhere`, `lastPermissionCrawlAt` | `(tenantId, documentId)` UNIQUE                                                                                                           |
| `acl_group_hierarchy`      | `_id`, `tenantId`, `groupId`, `source`, `displayName`, `email`, `parentGroups[]`, `childGroups[]`, `directMemberEmails[]`, `lastSyncAt`                           | `(tenantId, groupId)` UNIQUE, `(tenantId, source)`                                                                                        |
| `contacts` (extended)      | `sourceIdentities[]` (source, sourceUserId, blindIndex, displayName), `acl{}` (effectiveGroups, directGroups, domain, effectiveGroupsComputedAt)                  | `(tenantId, sourceIdentities.source, sourceIdentities.sourceUserId)`, `(tenantId, sourceIdentities.blindIndex)`, `(tenantId, acl.domain)` |

> **Note**: The `acl_document_permissions`, `acl_group_hierarchy`, and `contacts` extensions were added by ABLP-303 to replace Neo4j-based RACL. These collections serve the connector permission system, not the taxonomy graph.

---

## 8. API Surface

### Taxonomy Management

| Method | Path                                 | Description                             |
| ------ | ------------------------------------ | --------------------------------------- |
| GET    | `/:indexId/kg-configuration-status`  | Check workspace-aware LLM config status |
| POST   | `/:indexId/kg-configure-model`       | Configure LLM model for KG use case     |
| POST   | `/:indexId/kg-taxonomy/setup`        | One-time taxonomy setup                 |
| GET    | `/:indexId/kg-taxonomy`              | Get current taxonomy                    |
| PUT    | `/:indexId/kg-taxonomy`              | Update taxonomy                         |
| DELETE | `/:indexId/kg-taxonomy`              | Delete taxonomy                         |
| GET    | `/:indexId/kg-taxonomy/setup/:jobId` | Get setup job status                    |

### KG Enrichment

| Method | Path                              | Description                           |
| ------ | --------------------------------- | ------------------------------------- |
| POST   | `/:indexId/kg-enrich`             | Trigger enrichment for an index       |
| GET    | `/:indexId/kg-enrich/jobs/:jobId` | Get job status                        |
| GET    | `/:indexId/kg-enrich/jobs`        | List enrichment jobs                  |
| GET    | `/:indexId/kg-enrich/stats`       | Get KG statistics                     |
| GET    | `/:indexId/kg-enrich/documents`   | Get classified documents (paginated)  |
| GET    | `/:indexId/kg-enrich/entities`    | Get entity distribution               |
| GET    | `/:indexId/kg-enrich/graph`       | Get graph structure for visualization |

### Service Layer — Taxonomy (Neo4j)

| Method                           | Class                  | Description                   |
| -------------------------------- | ---------------------- | ----------------------------- |
| `createTaxonomyGraph(...)`       | `TaxonomyGraphService` | Build taxonomy in Neo4j       |
| `linkDocumentToProduct(...)`     | `TaxonomyGraphService` | Classify document by product  |
| `getTaxonomyGraphStructure(...)` | `TaxonomyGraphService` | Graph visualization data      |
| `getTaxonomyStats(...)`          | `TaxonomyGraphService` | Taxonomy statistics           |
| `deleteTaxonomyGraph(...)`       | `TaxonomyGraphService` | Cleanup for taxonomy deletion |

### Service Layer — RACL Permissions (MongoDB, added ABLP-303)

| Method                           | Class                     | Description                                                     |
| -------------------------------- | ------------------------- | --------------------------------------------------------------- |
| `upsertUser(input)`              | `MongoPermissionStore`    | Find/create contact by email blindIndex, upsert identities      |
| `upsertGroup(input)`             | `MongoPermissionStore`    | Upsert `acl_group_hierarchy` document                           |
| `upsertDocument(input)`          | `MongoPermissionStore`    | Upsert `acl_document_permissions`                               |
| `setPermission(input)`           | `MongoPermissionStore`    | Add user/group to document's allowed lists                      |
| `getUserGroups(tenantId, email)` | `MongoPermissionStore`    | Read pre-computed `acl.effectiveGroups` from contact card       |
| `getFlattenedPermissions(...)`   | `MongoPermissionStore`    | Read `acl_document_permissions` (replaces Neo4j 4-match Cypher) |
| `computeEffectiveGroups(...)`    | BFS compute service       | Pre-compute transitive group closure with cycle detection       |
| `buildPermissionFilter(...)`     | `PermissionFilterService` | 3-tier resolution (JWT -> Redis -> MongoDB) for OpenSearch      |

> **Note**: `KnowledgeGraphService` (formerly in `services/knowledge-graph/index.ts`) was removed. Entity extraction now lives in `entity-extractor.service.ts`. The original `neo4j-client.ts`, `entity-extractor.ts`, `reference-extractor.ts`, and `co-occurrence-analyzer.ts` have been deleted.

---

## 9. Pipeline Integration

The knowledge graph integrates into the existing SearchAI ingestion pipeline:

```
ingest -> extract -> canonical-map -> enrich -> [knowledge-graph + embedding] -> indexed
```

**Phase 1 (Entity Graph)**: Runs as a post-enrichment worker:

- Extracts entities and references per chunk
- Builds co-occurrence relationships
- Stores in Neo4j with tenant isolation

**Phase 3 (KG Enrichment)**: Runs as a separate manual-trigger job:

- Phase 0: Prerequisites (index created, documents uploaded)
- Phase 1: Taxonomy setup (one-time per index, 2-5 seconds)
- Phase 2: Document ingestion (existing pipeline, unchanged)
- Phase 3: KG enrichment (admin trigger, 60-90 min for 1K docs)
- Phase 4: Taxonomy update (admin trigger, 2-5 seconds)
- Phase 5: Re-classification (admin trigger, 30-45 min for 100K chunks)

**RACL Permission Pipeline (ABLP-303)**: Runs as part of connector sync + embedding:

- IdP sync workers (Azure AD, Okta, Google) write user/group data to MongoDB contact cards + `acl_group_hierarchy`
- BFS pre-computes `acl.effectiveGroups` on contact cards at sync time
- SharePoint permission crawler writes `acl_document_permissions` to MongoDB
- Embedding worker reads `acl_document_permissions` to stamp `permissions` on OpenSearch chunks
- Query-time `PermissionFilterService` resolves groups via 3-tier (JWT -> Redis -> MongoDB) and constructs OpenSearch bool filter

---

## 10. Configuration

### Environment Variables

| Variable                                   | Description                         | Default                  | Notes                         |
| ------------------------------------------ | ----------------------------------- | ------------------------ | ----------------------------- |
| `KNOWLEDGE_GRAPH_ENABLED`                  | Enable knowledge graph              | `false`                  |                               |
| `NEO4J_URI`                                | Neo4j connection URI                | `neo4j://localhost:7687` | Still used for taxonomy graph |
| `NEO4J_USERNAME`                           | Neo4j username                      | `neo4j`                  |                               |
| `NEO4J_PASSWORD`                           | Neo4j password                      | `password`               |                               |
| `NEO4J_DATABASE`                           | Neo4j database name                 | `neo4j`                  |                               |
| `KNOWLEDGE_GRAPH_ENTITY_EXTRACTION_METHOD` | Extraction method                   | `hybrid`                 |                               |
| `KNOWLEDGE_GRAPH_ENABLE_COOCCURRENCE`      | Enable co-occurrence analysis       | `true`                   |                               |
| `KNOWLEDGE_GRAPH_COOCCURRENCE_WINDOW`      | Co-occurrence window size           | `5`                      |                               |
| `KNOWLEDGE_GRAPH_MIN_IDF_THRESHOLD`        | Minimum IDF for co-occurrence edges | `1.5`                    |                               |

> **ABLP-303**: RACL no longer requires Neo4j. Connector permission data is now stored in MongoDB via `MongoPermissionStore`. The SearchAI and SearchAI-Runtime servers no longer initialize Neo4j connections for permission operations. Neo4j is only required when `KNOWLEDGE_GRAPH_ENABLED=true` for taxonomy graph features.

---

## 11. Security Considerations

- **Tenant isolation (taxonomy)**: All Neo4j nodes and relationships include `tenantId` property. All queries filter by `tenantId`.
- **Tenant isolation (RACL)**: MongoDB `acl_document_permissions` and `acl_group_hierarchy` use `tenantIsolationPlugin` for automatic filtering. Contact ACL data scoped by `tenantId`.
- **Index isolation**: Graph data is scoped to `(tenantId, indexId)`. Cross-index queries are not possible.
- **Auth**: Routes require `req.tenantContext` (tenant auth middleware). Job data includes `tenantId` for verification.
- **Cross-tenant protection**: Job status endpoint verifies `jobData.tenantId === tenantId` before returning results.
- **Neo4j credentials**: Stored in environment variables, not in database.
- **LLM credential isolation**: Per-index LLM client resolution ensures no cross-tenant credential sharing.
- **RACL fail-closed (ABLP-303)**: Document permission resolver defaults to `publicEverywhere: false` when no `AclDocumentPermissions` record exists. Non-RACL sources (file uploads, web crawls, disabled connectors) are explicitly stamped `publicEverywhere: true` at index time.
- **KNOWN RISK - Cypher injection**: `TaxonomyGraphService` relationship operations should validate relationship types against an allow-list before query execution.

---

## 12. Performance Characteristics

| Operation                        | Latency     | Throughput        | Cost        |
| -------------------------------- | ----------- | ----------------- | ----------- |
| Entity extraction (regex)        | < 1ms/chunk | 500+ chunks/sec   | $0          |
| Entity extraction (compromise)   | ~5ms/chunk  | 200 chunks/sec    | $0          |
| Entity extraction (hybrid)       | ~5ms/chunk  | 200 chunks/sec    | $0          |
| Neo4j entity upsert (batch)      | ~1ms/entity | 1000 entities/sec | N/A         |
| Document classification (Haiku)  | ~500ms/doc  | 2 docs/sec        | $0.0002/doc |
| Document classification (Sonnet) | ~1.5s/doc   | 0.7 docs/sec      | $0.001/doc  |
| Taxonomy lookup (Neo4j)          | 5-10ms      | N/A               | N/A         |
| Graph stats query                | 10-50ms     | N/A               | N/A         |
| Full index enrichment (1K docs)  | 60-90 min   | N/A               | ~$1.15      |

---

## 13. Error Handling

| Error                      | Handling Strategy                                                          |
| -------------------------- | -------------------------------------------------------------------------- |
| Neo4j connection failure   | `ConfigurationError` thrown, prevents service initialization               |
| Neo4j timeout              | Session-level timeout (30s), job retries with exponential backoff          |
| LLM classification failure | Sonnet escalation for low confidence; skip document if both fail           |
| Missing taxonomy           | 400 response with `nextSteps` pointing to setup API                        |
| Missing summary            | Document skipped during enrichment (requires prior ingestion)              |
| Co-occurrence OOM          | Window size limits entity pairs; chunking mitigates O(n^2)                 |
| Duplicate entity           | MERGE operation (upsert) prevents duplicates; occurrence count incremented |

---

## 14. Observability

- **Logging**: `console.log`/`console.error` in routes (ISSUE: should use `createLogger`) and `workerLog`/`workerError` in workers
- **Job tracking**: BullMQ job state tracking (QUEUED, PROCESSING, COMPLETED, FAILED, SKIPPED)
- **Progress**: Job progress percentage updated during processing
- **Stats API**: Enrichment statistics (document counts, product distribution, confidence) available via REST
- **Neo4j monitoring**: Graph statistics (entity count, relationship count, type distribution) available via service layer and REST API

---

## 15. Testing Strategy

### Existing Tests

- **KG enrichment integration**: `apps/search-ai/src/__tests__/kg-enrichment-integration.test.ts` — enrichment flow
- **KG enrichment logic**: `apps/search-ai/src/workers/__tests__/kg-enrichment-logic.test.ts` — worker logic
- **KG taxonomy profile**: `apps/search-ai/src/routes/__tests__/kg-taxonomy-generate-profile.test.ts` — profile generation
- **Novel candidate validator**: `apps/search-ai/src/services/__tests__/novel-candidate-validator.test.ts` — entity validation
- **Job ID patterns**: `apps/search-ai/src/workers/__tests__/job-id-patterns.test.ts` — job ID format
- **Tenant isolation**: `apps/search-ai/src/__tests__/integration/tenant-isolation.test.ts` — cross-tenant isolation
- **Permission filter service**: `apps/search-ai/src/__tests__/permission-filter.service.test.ts` — permission filter logic (updated for RACL)
- **Permission filter middleware**: `apps/search-ai/src/__tests__/permission-filter.middleware.test.ts` — middleware (updated for RACL)
- **Connector permission crawl**: `apps/search-ai/src/__tests__/connector-permission-crawl-worker.test.ts` — crawl worker (updated for RACL)
- **Okta user sync**: `apps/search-ai/src/workers/__tests__/okta-user-sync-worker.test.ts` — Okta sync (updated for RACL)
- **Permission system integration**: `apps/search-ai/src/__tests__/integration/permission-system-integration.test.ts` — full permission flow

### Gaps

- No E2E tests exercising the full HTTP API (taxonomy setup -> enrichment -> stats)
- No tests for graph visualization API
- No tests for taxonomy versioning/rollback
- No tests for workspace-aware configuration status
- No tests for entity distribution API
- No unit tests for `MongoPermissionStore` CRUD operations
- No unit tests for BFS effective groups computation edge cases
- No load/stress tests for large corpora

---

## 16. Dependencies

| Dependency                           | Type     | Purpose                                                |
| ------------------------------------ | -------- | ------------------------------------------------------ |
| `neo4j-driver`                       | npm      | Neo4j graph database client (taxonomy graph only)      |
| `compromise`                         | npm      | NLP-based entity extraction                            |
| `bullmq`                             | npm      | Background job processing                              |
| `@agent-platform/llm`                | internal | LLM client for classification                          |
| `@agent-platform/search-ai-sdk`      | internal | SearchAI SDK (errors, types)                           |
| `@agent-platform/search-ai-internal` | internal | Vector store provider + MongoPermissionStore (RACL)    |
| `@agent-platform/database`           | internal | MongoDB models (incl. ACL collections from ABLP-303)   |
| Neo4j 5.x                            | infra    | Graph database (taxonomy graph only post-ABLP-303)     |
| Redis                                | infra    | BullMQ job queue + permission cache (group membership) |
| MongoDB                              | infra    | Document metadata + RACL permissions storage           |

---

## 17. Known Issues

1. **Routes use `console.log`/`console.error`**: Should use `createLogger('kg-enrichment')` per code standards. Only `kg-taxonomy.ts` uses the logger correctly.
2. **`any` types in routes**: `kg-enrichment.ts` uses `any` for query objects and pipeline stages instead of proper typing.
3. **No pagination on graph endpoint**: Graph visualization API returns all nodes/edges; could be problematic for large taxonomies.
4. **Cross-tenant 403 instead of 404**: Job status endpoint returns 403 for cross-tenant access instead of 404 (leaks job existence).
5. **No cleanup on index deletion**: When a search index is deleted, the corresponding Neo4j graph data may not be cleaned up.
6. **Cypher injection risk**: Taxonomy graph relationship operations should validate relationship types against an allow-list.
7. **Pre-RACL backward compat clause**: The permission filter includes a backward-compatibility clause matching documents where `permissions` field does not exist. This should be removed after all documents are re-indexed with permission metadata.
8. ~~**Neo4j connection not pooled across services**~~: MITIGATED by ABLP-303 — RACL no longer uses Neo4j. Only `TaxonomyGraphService` maintains a Neo4j connection now.

---

## 18. Implementation Status

| Phase    | Description                               | Status      | Completion      |
| -------- | ----------------------------------------- | ----------- | --------------- |
| Phase 1  | Entity Graph (extraction + Neo4j storage) | DONE        | Feb 2026        |
| Phase 2  | Domain-Aware Taxonomy                     | DONE        | Feb-Mar 2026    |
| Phase 3  | KG Enrichment Worker                      | DONE        | Mar 2026        |
| ABLP-303 | RACL Migration: Neo4j -> MongoDB          | DONE        | Apr 2026        |
| Phase 4  | Graph Retrieval API                       | NOT STARTED | Planned Q2 2026 |
| Phase 5  | Entity Resolution + Cross-Index           | NOT STARTED | Planned Q3 2026 |

### ABLP-303: RACL Migration Details (Apr 2026)

| Component                                | Status | Description                                                       |
| ---------------------------------------- | ------ | ----------------------------------------------------------------- |
| `AclDocumentPermissions` model           | DONE   | New MongoDB model replacing Neo4j Document + HAS_PERMISSION nodes |
| `AclGroupHierarchy` model                | DONE   | New MongoDB model replacing Neo4j Group + MEMBER_OF edges         |
| Contact model ACL extension              | DONE   | `sourceIdentities[]` + `acl{}` fields on existing Contact model   |
| `MongoPermissionStore`                   | DONE   | Drop-in replacement for `PermissionGraphService`                  |
| BFS effective groups computation         | DONE   | Pre-computed group closure replaces Neo4j `MEMBER_OF*1..20`       |
| Azure AD user/group sync workers         | DONE   | Rewritten for MongoDB contact cards + group hierarchy             |
| Okta user/group sync workers             | DONE   | Rewritten for MongoDB                                             |
| Google user/group sync workers           | DONE   | Rewritten for MongoDB                                             |
| SharePoint permission crawler            | DONE   | Rewritten for MongoDB `acl_document_permissions`                  |
| Document permission resolver             | DONE   | Reads from MongoDB instead of Neo4j; fail-closed default          |
| 3-tier permission filter (runtime)       | DONE   | JWT -> Redis -> MongoDB replaces Neo4j traversal                  |
| Permission filter backward compat        | DONE   | Handles pre-RACL documents without `permissions` field            |
| `publicEverywhere` stamping for non-RACL | DONE   | File uploads / web crawls / disabled connectors stamped correctly |
| SearchAI/Runtime server init cleanup     | DONE   | Neo4j no longer initialized for permission operations             |

**Overall Feature Status**: ALPHA — Core ingestion pipeline and RACL permission system functional. Graph-augmented retrieval not yet implemented.
