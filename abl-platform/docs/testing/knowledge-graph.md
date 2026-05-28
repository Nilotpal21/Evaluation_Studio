# Test Spec: Knowledge Graph

> **Feature ID**: #37
> **Status**: IN PROGRESS
> **Created**: 2026-03-22
> **Last Updated**: 2026-04-14
> **Related Feature Spec**: `docs/features/knowledge-graph.md`

---

## 1. Overview

Test specification for the Knowledge Graph feature covering entity extraction, taxonomy management, KG enrichment, graph visualization, and tenant isolation. This spec defines E2E, integration, and unit test scenarios for the SearchAI knowledge graph subsystem.

**Test Infrastructure Requirements**:

- Neo4j 5.x (Docker or testcontainers) — for taxonomy graph tests only
- MongoDB (via MongoMemoryServer for integration, real instance for E2E)
- Redis (for BullMQ job queue + permission group cache)
- SearchAI Express server running on random port
- Tenant auth context (mocked auth middleware providing `req.tenantContext`)
- RACL tests require MongoDB with `acl_document_permissions`, `acl_group_hierarchy`, and `contacts` collections

---

## 2. E2E Test Scenarios

All E2E tests interact exclusively via HTTP API. No mocks of codebase components. Real servers with full middleware chain.

### E2E-1: Taxonomy Setup and Retrieval

**Objective**: Verify end-to-end taxonomy lifecycle via REST API.

| Step | Action                                                                                  | Expected Result                                                |
| ---- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1    | POST `/api/indexes/:indexId/kg-taxonomy/setup` with valid domain config and org profile | 201 with `jobId` and `status: QUEUED`                          |
| 2    | GET `/api/indexes/:indexId/kg-taxonomy/setup/:jobId` (poll)                             | Job progresses from QUEUED to COMPLETED                        |
| 3    | GET `/api/indexes/:indexId/kg-taxonomy`                                                 | Returns taxonomy with domain, categories, products, attributes |
| 4    | PUT `/api/indexes/:indexId/kg-taxonomy` with updated taxonomy                           | 200, previous version stored in `previousVersions`             |
| 5    | DELETE `/api/indexes/:indexId/kg-taxonomy`                                              | 200, taxonomy removed                                          |
| 6    | GET `/api/indexes/:indexId/kg-taxonomy`                                                 | 404                                                            |

**Auth Context**: Tenant admin with valid `tenantId`.
**Preconditions**: Search index exists for the tenant.

### E2E-2: KG Enrichment Trigger and Status Polling

**Objective**: Verify enrichment job lifecycle via REST API.

| Step | Action                                                               | Expected Result                                               |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1    | Setup: Create index, upload documents with summaries, setup taxonomy | Index with documents and taxonomy ready                       |
| 2    | POST `/api/indexes/:indexId/kg-enrich`                               | 201 with `jobId`, `status: QUEUED`, `estimatedDocuments > 0`  |
| 3    | GET `/api/indexes/:indexId/kg-enrich/jobs/:jobId`                    | Returns job status with progress                              |
| 4    | GET `/api/indexes/:indexId/kg-enrich/jobs`                           | Returns list containing the created job                       |
| 5    | Poll until COMPLETED or FAILED                                       | Job reaches terminal state                                    |
| 6    | GET `/api/indexes/:indexId/kg-enrich/stats`                          | Returns enrichedDocuments > 0, product distribution populated |

**Auth Context**: Tenant admin.
**Preconditions**: Taxonomy setup, documents with summaries ingested.

### E2E-3: KG Statistics and Graph Visualization

**Objective**: Verify statistics and graph APIs return correct data after enrichment.

| Step | Action                                                                  | Expected Result                                                                 |
| ---- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1    | Setup: Run full enrichment pipeline                                     | Documents enriched                                                              |
| 2    | GET `/api/indexes/:indexId/kg-enrich/stats`                             | `totalDocuments > 0`, `enrichedDocuments > 0`, `productsDistribution` non-empty |
| 3    | GET `/api/indexes/:indexId/kg-enrich/entities`                          | Returns entity distribution with `attributeId`, `count`, `sampleValues`         |
| 4    | GET `/api/indexes/:indexId/kg-enrich/entities?productId=credit_card`    | Filtered entities for credit_card product only                                  |
| 5    | GET `/api/indexes/:indexId/kg-enrich/graph`                             | Returns `nodes` and `edges` arrays with taxonomy structure                      |
| 6    | GET `/api/indexes/:indexId/kg-enrich/graph?productId=credit_card`       | Filtered graph for credit_card product                                          |
| 7    | GET `/api/indexes/:indexId/kg-enrich/graph?includeEntityInstances=true` | Graph includes entity_instance nodes                                            |

**Auth Context**: Tenant admin.

### E2E-4: Classified Documents with Pagination

**Objective**: Verify paginated document listing after enrichment.

| Step | Action                                                                           | Expected Result                                   |
| ---- | -------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1    | Setup: Run enrichment for index with 10+ documents                               | Documents enriched                                |
| 2    | GET `/api/indexes/:indexId/kg-enrich/documents?page=1&limit=5`                   | 5 documents, `pagination.totalPages >= 2`         |
| 3    | GET `/api/indexes/:indexId/kg-enrich/documents?page=2&limit=5`                   | Next 5 documents, different from page 1           |
| 4    | GET `/api/indexes/:indexId/kg-enrich/documents?productId=credit_card`            | Only documents with `primaryProduct: credit_card` |
| 5    | GET `/api/indexes/:indexId/kg-enrich/documents?minConfidence=0.8`                | Only documents with confidence >= 0.8             |
| 6    | GET `/api/indexes/:indexId/kg-enrich/documents?sortBy=confidence&sortOrder=desc` | Documents sorted by confidence descending         |

**Auth Context**: Tenant admin.

### E2E-5: Tenant Isolation Across All Endpoints

**Objective**: Verify tenant A cannot access tenant B's knowledge graph data.

| Step | Action                                                          | Expected Result                              |
| ---- | --------------------------------------------------------------- | -------------------------------------------- |
| 1    | Tenant A: Setup taxonomy and run enrichment                     | Taxonomy and enriched documents for tenant A |
| 2    | Tenant B: GET `/api/indexes/:indexId-A/kg-taxonomy`             | 404 (not 403)                                |
| 3    | Tenant B: POST `/api/indexes/:indexId-A/kg-enrich`              | 404                                          |
| 4    | Tenant B: GET `/api/indexes/:indexId-A/kg-enrich/stats`         | 404                                          |
| 5    | Tenant B: GET `/api/indexes/:indexId-A/kg-enrich/graph`         | 404                                          |
| 6    | Tenant B: GET `/api/indexes/:indexId-A/kg-enrich/documents`     | 404                                          |
| 7    | Tenant B: GET `/api/indexes/:indexId-A/kg-enrich/jobs/:jobId-A` | 404 or 403                                   |

**Auth Context**: Two separate tenants with valid auth.

### E2E-6: Enrichment Without Taxonomy

**Objective**: Verify enrichment fails gracefully without taxonomy setup.

| Step | Action                                      | Expected Result                                                          |
| ---- | ------------------------------------------- | ------------------------------------------------------------------------ |
| 1    | Create index with documents                 | Index exists, no taxonomy                                                |
| 2    | POST `/api/indexes/:indexId/kg-enrich`      | 400 with `error: 'No taxonomy configured'` and `nextSteps.setupTaxonomy` |
| 3    | GET `/api/indexes/:indexId/kg-enrich/stats` | 404 with `error: 'No taxonomy configured'`                               |

**Auth Context**: Tenant admin.

### E2E-7: Re-Classification with Updated Taxonomy

**Objective**: Verify re-classification flow after taxonomy update.

| Step | Action                                                              | Expected Result                            |
| ---- | ------------------------------------------------------------------- | ------------------------------------------ |
| 1    | Setup taxonomy, enrich documents                                    | Documents classified with v1 taxonomy      |
| 2    | PUT `/api/indexes/:indexId/kg-taxonomy` with updated products       | Taxonomy v2 stored, v1 in previousVersions |
| 3    | POST `/api/indexes/:indexId/kg-enrich` with `forceReclassify: true` | New enrichment job queued                  |
| 4    | Poll until COMPLETED                                                | Documents re-classified with v2 taxonomy   |
| 5    | GET `/api/indexes/:indexId/kg-enrich/stats`                         | Product distribution reflects v2 taxonomy  |

**Auth Context**: Tenant admin.

---

## 3. Integration Test Scenarios

Integration tests test real service boundaries without mocking codebase components. External services (Neo4j, LLM) may use test doubles.

### INT-1: Entity Extraction Pipeline

**Objective**: Test entity extractor with real text processing.

| Test Case          | Input                                         | Expected Output                              |
| ------------------ | --------------------------------------------- | -------------------------------------------- |
| Regex: email       | "Contact support@example.com"                 | 1 EMAIL entity, text = "support@example.com" |
| Regex: money       | "Price: $1,234.56"                            | 1 MONEY entity                               |
| Compromise: person | "John Smith attended"                         | >= 1 PERSON entity                           |
| Compromise: org    | "Microsoft announced"                         | >= 1 ORGANIZATION entity                     |
| Hybrid: dedup      | "Contact support@example.com about Microsoft" | EMAIL + ORGANIZATION, no duplicates          |
| Empty text         | ""                                            | Empty array                                  |
| Large text         | 10K chars with 50+ entities                   | All entities extracted, no OOM               |

### INT-2: Co-Occurrence Analysis

**Objective**: Test IDF-weighted co-occurrence calculation.

| Test Case                  | Setup                                       | Expected                                         |
| -------------------------- | ------------------------------------------- | ------------------------------------------------ |
| Two entities, one chunk    | 2 entities in chunk 1                       | 1 co-occurrence with frequency=1                 |
| Two entities, three chunks | Same 2 entities in 3 chunks                 | 1 co-occurrence with frequency=3, higher weight  |
| IDF filtering              | Common entity (in all chunks) + rare entity | Common entity has low IDF, filtered by threshold |
| Empty chunks               | 0 entities                                  | No co-occurrences                                |
| Single entity per chunk    | 5 chunks, each with 1 entity                | 0 co-occurrences                                 |

### INT-3: Neo4j Client Operations

**Objective**: Test Neo4j CRUD operations with tenant isolation (requires Neo4j testcontainer or local instance).

| Test Case             | Operation                          | Expected                                                |
| --------------------- | ---------------------------------- | ------------------------------------------------------- |
| Upsert new entity     | `upsertEntity(entity)`             | Returns entity ID, entity queryable by text             |
| Upsert duplicate      | Same entity twice                  | Same ID returned, occurrenceCount=2, lastSeenAt updated |
| Batch upsert          | `upsertEntities([...5 entities])`  | Map with 5 entries (text -> id)                         |
| Create relationship   | `upsertRelationship(CO_OCCURS)`    | Relationship queryable between entities                 |
| Find related entities | `findRelatedEntities(entityId)`    | Returns connected entities with weights                 |
| Delete document graph | `deleteDocumentGraph(docId)`       | All entities for doc deleted                            |
| Delete index graph    | `deleteIndexGraph(indexId)`        | All entities for index deleted                          |
| Tenant isolation      | Query with wrong tenantId          | Returns empty results, not other tenant's data          |
| Graph stats           | `getGraphStats(tenantId, indexId)` | Correct entity/relationship counts                      |

### INT-4: Taxonomy Graph Service

**Objective**: Test taxonomy graph construction in Neo4j.

| Test Case                | Operation                                    | Expected                                   |
| ------------------------ | -------------------------------------------- | ------------------------------------------ |
| Create taxonomy          | Full domain > category > product > attribute | All nodes created with relationships       |
| Link document to product | `linkDocumentToProduct(doc, product)`        | CLASSIFIED_AS relationship with confidence |
| Batch link chunks        | 10 chunks to products                        | All CLASSIFIED_AS relationships created    |
| Upsert entity instance   | Deduplicated entity                          | documentCount incremented, not duplicated  |
| Get taxonomy structure   | `getTaxonomyGraphStructure()`                | Correct node/edge counts by type           |
| Get taxonomy stats       | `getTaxonomyStats()`                         | All counts match actual data               |
| Product exclusions       | EXCLUDES relationships                       | Products correctly marked as exclusive     |
| Delete taxonomy          | `deleteTaxonomyGraph()`                      | All taxonomy nodes for index removed       |

### INT-5: KG Enrichment Worker

**Objective**: Test enrichment worker processes documents correctly (with test LLM client).

| Test Case            | Setup                                       | Expected                                |
| -------------------- | ------------------------------------------- | --------------------------------------- |
| Single document      | 1 doc with summary and taxonomy             | Document classified, kgState = ENRICHED |
| Batch processing     | 10 docs, batchSize=5                        | All 10 processed in 2 batches           |
| Skip no-summary docs | 3 docs, 1 without summary                   | 2 enriched, 1 skipped                   |
| Force reclassify     | Already enriched docs, forceReclassify=true | All docs re-processed                   |
| LLM escalation       | Low confidence from Haiku                   | Sonnet escalation attempted             |
| Error handling       | LLM failure mid-batch                       | Partial progress saved, job retried     |

### INT-6: Graph Store Abstraction

**Objective**: Test InMemoryGraphStore implements GraphStore interface correctly.

| Test Case             | Operation          | Expected                               |
| --------------------- | ------------------ | -------------------------------------- |
| Connect/close         | Lifecycle          | Connected flag set/cleared             |
| Upsert entity         | New entity         | Returns unique ID                      |
| Find entity by text   | After upsert       | Returns matching entity                |
| Find entities by type | Multiple entities  | Filtered and sorted by occurrenceCount |
| Upsert relationship   | Two entities       | Relationship stored                    |
| Find related          | After relationship | Returns related entity with weight     |
| Delete operations     | Document/index     | Correct entities/relationships removed |
| Graph stats           | After operations   | Correct counts                         |

### INT-7: KG Configuration Status

**Objective**: Test workspace-aware LLM configuration check.

| Test Case               | Setup                          | Expected                                                    |
| ----------------------- | ------------------------------ | ----------------------------------------------------------- |
| No models configured    | Empty tenant                   | `configurationLevel: 'none'`, `requiresConfiguration: true` |
| Workspace has KG index  | Sibling index with KG taxonomy | `configurationLevel: 'workspace'`, recommendation to reuse  |
| Tenant models available | TenantModel records            | `configurationLevel: 'tenant'`, model list returned         |

### INT-8: MongoPermissionStore CRUD (ABLP-303)

**Objective**: Test MongoDB-based permission store operations.

| Test Case                 | Operation                                       | Expected                                                 |
| ------------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| Upsert user               | `upsertUser({email, source})`                   | Contact created with `sourceIdentities[]` and `acl{}`    |
| Upsert group              | `upsertGroup({groupId, parentGroups})`          | `acl_group_hierarchy` document created                   |
| Upsert document           | `upsertDocument({documentId})`                  | `acl_document_permissions` document created              |
| Set permission            | `setPermission({documentId, user})`             | User added to `allowedUsers` list                        |
| Get user groups           | `getUserGroups(tenantId, email)`                | Returns pre-computed `effectiveGroups` from contact card |
| Get flattened permissions | `getFlattenedPermissions(tenantId, documentId)` | Returns permission data from `acl_document_permissions`  |
| Tenant isolation          | Query with wrong tenantId                       | Returns empty/null                                       |

### INT-9: BFS Effective Groups Computation (ABLP-303)

**Objective**: Test transitive group closure computation.

| Test Case         | Setup                          | Expected                          |
| ----------------- | ------------------------------ | --------------------------------- |
| Linear chain      | A -> B -> C                    | effectiveGroups includes A, B, C  |
| Diamond hierarchy | A -> B, A -> C, B -> D, C -> D | D appears once in effectiveGroups |
| Cycle detection   | A -> B -> C -> A               | Terminates without infinite loop  |
| Max depth (20)    | 25-level deep chain            | Stops at depth 20                 |
| Empty groups      | User with no group memberships | Empty effectiveGroups             |
| Single group      | User in one group, no nesting  | effectiveGroups = [that group]    |

### INT-10: Permission Filter 3-Tier Resolution (ABLP-303)

**Objective**: Test JWT -> Redis -> MongoDB group resolution cascade.

| Test Case           | Setup                      | Expected                                      |
| ------------------- | -------------------------- | --------------------------------------------- |
| JWT groups (Tier 1) | Token with `groups` claim  | Groups extracted directly, no DB call         |
| Redis cache hit     | Groups pre-cached in Redis | Returns from cache, no MongoDB call           |
| MongoDB fallback    | No JWT groups, no cache    | Reads `acl.effectiveGroups` from contact card |
| Azure >200 groups   | `hasgroups: true` in JWT   | Falls through to Tier 2/3                     |
| Error fallback      | All tiers fail             | Returns empty groups (fail-closed)            |
| Public mode         | No user identity           | Public-only filter (no group resolution)      |

---

## 4. Unit Test Coverage

### Existing Unit Tests

| Suite                                       | File                                                                             | Status                       |
| ------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------- |
| KG enrichment logic                         | `apps/search-ai/src/workers/__tests__/kg-enrichment-logic.test.ts`               | PASSING                      |
| KG taxonomy profile generation              | `apps/search-ai/src/routes/__tests__/kg-taxonomy-generate-profile.test.ts`       | PASSING                      |
| Novel candidate validator                   | `apps/search-ai/src/services/__tests__/novel-candidate-validator.test.ts`        | PASSING                      |
| Job ID patterns                             | `apps/search-ai/src/workers/__tests__/job-id-patterns.test.ts`                   | PASSING                      |
| Permission filter service (RACL-updated)    | `apps/search-ai/src/__tests__/permission-filter.service.test.ts`                 | PASSING                      |
| Permission filter middleware (RACL-updated) | `apps/search-ai/src/__tests__/permission-filter.middleware.test.ts`              | PASSING                      |
| Connector permission crawl (RACL-updated)   | `apps/search-ai/src/__tests__/connector-permission-crawl-worker.test.ts`         | PASSING                      |
| Okta user sync (RACL-updated)               | `apps/search-ai/src/workers/__tests__/okta-user-sync-worker.test.ts`             | PASSING                      |
| KG enrichment integration                   | `apps/search-ai/src/__tests__/kg-enrichment-integration.test.ts`                 | PASSING                      |
| Tenant isolation integration                | `apps/search-ai/src/__tests__/integration/tenant-isolation.test.ts`              | PASSING                      |
| Permission system integration               | `apps/search-ai/src/__tests__/integration/permission-system-integration.test.ts` | CONDITIONAL (requires Neo4j) |

### Needed Unit Tests

| Suite                           | Cases                                                           | Priority |
| ------------------------------- | --------------------------------------------------------------- | -------- |
| MongoPermissionStore CRUD       | All CRUD operations, tenant isolation, edge cases               | P0       |
| BFS effective groups            | Cycle detection, max depth, diamond hierarchy                   | P0       |
| Taxonomy validation             | Invalid taxonomy structure, missing required fields             | P0       |
| EntityExtractor edge cases      | Unicode text, empty strings, very long text, special characters | P1       |
| ReferenceExtractor edge cases   | Malformed references, overlapping patterns                      | P1       |
| CoOccurrenceAnalyzer edge cases | Single entity, no chunks, max entities                          | P1       |

---

## 5. Test Data Requirements

### Seed Data

- **Tenant A**: `tenantId: 'tenant-test-a'`, valid auth token
- **Tenant B**: `tenantId: 'tenant-test-b'`, valid auth token
- **Search Index**: Pre-created index with `indexId` for each tenant
- **Documents**: 10+ documents with summaries covering:
  - Credit card documents (interest rates, fees, rewards)
  - Debit card documents (transaction limits, ATM access)
  - Loan documents (application process, collateral)
- **Taxonomy**: Banking domain with products: credit_card, debit_card, housing_loan, personal_loan
- **Organization Profile**: Test bank profile with product names and aliases

### Test Doubles

- **LLM Client**: Test double returning deterministic classification results (e.g., credit_card with confidence 0.9)
- **Neo4j**: Real Neo4j instance (Docker testcontainer) for integration tests; InMemoryGraphStore for unit tests
- **External services only**: No mocking of KnowledgeGraphService, TaxonomyGraphService, or other codebase components

---

## 6. Coverage Targets

| Layer                                  | Current | Target | Priority |
| -------------------------------------- | ------- | ------ | -------- |
| KG enrichment logic (unit)             | ~60%    | 85%    | P0       |
| Entity extraction (unit)               | ~40%    | 85%    | P1       |
| Taxonomy graph service (integration)   | 0%      | 70%    | P0       |
| MongoPermissionStore (unit)            | 0%      | 80%    | P0       |
| BFS effective groups (unit)            | 0%      | 90%    | P0       |
| Permission filter 3-tier (integration) | ~30%    | 80%    | P0       |
| KG enrichment routes (E2E)             | 0%      | 80%    | P0       |
| KG taxonomy routes (E2E)               | 0%      | 80%    | P0       |
| RACL permission routes (E2E)           | 0%      | 80%    | P0       |
| Tenant isolation (E2E)                 | ~20%    | 100%   | P0       |

---

## 7. Test Execution Strategy

### CI Pipeline

1. **Unit tests**: Run on every PR (no external dependencies)
2. **Integration tests (Neo4j)**: Run with Neo4j Docker service in CI
3. **E2E tests**: Run with full stack (MongoDB, Redis, Neo4j, SearchAI server)

### Local Development

```bash
# Unit tests only (KG enrichment, taxonomy, entity extraction)
cd apps/search-ai && pnpm test kg-enrichment-logic
cd apps/search-ai && pnpm test novel-candidate-validator
cd apps/search-ai && pnpm test job-id-patterns

# RACL permission tests
cd apps/search-ai && pnpm test permission-filter
cd apps/search-ai && pnpm test connector-permission-crawl
cd apps/search-ai && pnpm test okta-user-sync

# Integration tests (requires Neo4j for taxonomy, MongoDB for RACL)
cd apps/search-ai && pnpm test kg-enrichment-integration
cd apps/search-ai && pnpm test tenant-isolation

# E2E tests (requires full stack)
docker compose up -d neo4j redis mongodb
cd apps/search-ai && pnpm test:e2e
```

---

## 8. Risk Assessment

| Risk                              | Likelihood | Impact | Mitigation                                                             |
| --------------------------------- | ---------- | ------ | ---------------------------------------------------------------------- |
| Neo4j unavailable in CI           | Medium     | Medium | Only needed for taxonomy tests; RACL tests use MongoDB only            |
| LLM API flakiness in E2E          | High       | Medium | Deterministic test LLM client via DI, not mock                         |
| Slow enrichment tests             | High       | Medium | Small test corpus (10 docs), parallel execution                        |
| Neo4j state leakage between tests | Medium     | High   | Per-test cleanup via `deleteIndexGraph()`, unique indexIds             |
| Cross-test tenant interference    | Low        | High   | Unique tenantIds per test suite, afterAll cleanup                      |
| Pre-RACL document compat          | Medium     | High   | Backward-compat clause in permission filter; re-index to resolve       |
| MongoDB ACL index missing         | Low        | High   | Verify indexes on `acl_document_permissions` and `acl_group_hierarchy` |
