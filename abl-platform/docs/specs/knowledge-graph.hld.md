# High-Level Design: Knowledge Graph

> **Feature ID**: #37
> **Status**: APPROVED (updated post-ABLP-303)
> **Author**: SearchAI Team
> **Created**: 2026-03-22
> **Updated**: 2026-04-14
> **Related**: `docs/features/knowledge-graph.md`, `docs/testing/knowledge-graph.md`

---

## 1. Executive Summary

The Knowledge Graph (KG) subsystem adds graph-based knowledge representation to SearchAI's vector search pipeline. It extracts entities and relationships from ingested documents, builds a domain-aware taxonomy graph in Neo4j, and enables product-scoped disambiguation. The system operates as a background enrichment layer that augments existing search without disrupting the core ingestion pipeline.

---

## 2. Architecture Overview

```
                                    SearchAI Architecture with Knowledge Graph
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                          API Layer                                           │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌───────────────────────┐              │
│  │  kg-taxonomy.ts      │  │  kg-enrichment.ts    │  │  search-routes.ts     │              │
│  │  (CRUD + Setup)      │  │  (Trigger + Status)  │  │  (Query + Retrieve)   │              │
│  └──────────┬───────────┘  └──────────┬───────────┘  └───────────┬───────────┘              │
│             │                         │                           │                           │
├─────────────┼─────────────────────────┼───────────────────────────┼───────────────────────────┤
│             │              Service Layer                          │                           │
│  ┌──────────▼───────────┐  ┌──────────▼───────────┐  ┌──────────▼───────────┐              │
│  │ TaxonomyLoaderService│  │ DocumentClassifier   │  │ KnowledgeGraphService│              │
│  │ OrgProfileGenerator  │  │ EntityExtractor      │  │ TaxonomyGraphService │              │
│  │ CustomDomainGenerator│  │ EntityExtractorSvc   │  │ (Neo4j + InMemory)   │              │
│  └──────────┬───────────┘  └──────────┬───────────┘  └──────────┬───────────┘              │
│             │                         │                           │                           │
├─────────────┼─────────────────────────┼───────────────────────────┼───────────────────────────┤
│             │              Worker Layer (BullMQ)                  │                           │
│  ┌──────────▼───────────┐  ┌──────────▼───────────┐              │                           │
│  │ taxonomy-setup-worker│  │ kg-enrichment-worker │              │                           │
│  └──────────┬───────────┘  └──────────┬───────────┘              │                           │
│             │                         │                           │                           │
├─────────────┼─────────────────────────┼───────────────────────────┼───────────────────────────┤
│             │              Storage Layer                          │                           │
│  ┌──────────▼──────┐  ┌──────▼──────┐  ┌────────▼─────┐  ┌─────▼──────┐                    │
│  │   MongoDB        │  │   Neo4j     │  │  Vector DB   │  │   Redis    │                    │
│  │ - Taxonomy       │  │ - Entities  │  │ - Embeddings │  │ - BullMQ   │                    │
│  │ - Domains        │  │ - Taxonomy  │  │ - Metadata   │  │ - Queues   │                    │
│  │ - Documents      │  │ - Relations │  │              │  │            │                    │
│  └─────────────────┘  └─────────────┘  └──────────────┘  └────────────┘                    │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Key Components

1. **API Layer**: Express routes for taxonomy management and enrichment operations
2. **Service Layer**: Business logic for taxonomy loading, document classification, entity extraction
3. **Worker Layer**: BullMQ workers for async background processing
4. **Storage Layer**: MongoDB (metadata), Neo4j (graph), Vector DB (embeddings), Redis (queues)

---

## 3. Architectural Concerns

### 3.1 Tenant Isolation

**Approach**: Property-based isolation in Neo4j with query-level enforcement.

- All Neo4j nodes include `tenantId` and `indexId` properties
- All Cypher queries filter by `tenantId` in MATCH clauses
- MongoDB models use `tenantIsolationPlugin` for automatic filtering
- API routes verify `req.tenantContext.tenantId` matches resource ownership
- Cross-tenant access returns 404 (not 403) to avoid leaking resource existence

**Alternative Considered**: Separate Neo4j databases per tenant.
**Rejected**: Operational overhead of managing hundreds of databases; property-based isolation with indexed lookups provides adequate security with better resource utilization.

### 3.2 Data Consistency

**Approach**: Eventual consistency between MongoDB and Neo4j with idempotent operations.

- Taxonomy stored in both MongoDB (source of truth) and Neo4j (graph traversal)
- Entity extraction uses MERGE (upsert) operations for idempotency
- KG enrichment worker is re-runnable (forceReclassify flag)
- Document kgState tracks enrichment status (NOT_ENRICHED, ENRICHED, SKIPPED)
- Taxonomy versioning preserves history in MongoDB `previousVersions` array

**Risk**: MongoDB and Neo4j could become inconsistent if one write succeeds and the other fails.
**Mitigation**: Enrichment jobs retry with exponential backoff (3 attempts). Admin can re-trigger enrichment.

### 3.3 Scalability

**Approach**: Horizontal scaling via BullMQ workers with batch processing.

- Enrichment processes documents in configurable batches (default: 50)
- Multiple workers can process different indexes concurrently
- Neo4j batch writes (1000 entities/sec throughput)
- Co-occurrence analysis bounded by chunk window size
- Entity deduplication via MERGE prevents unbounded graph growth

**Scaling Limits**:

- Single Neo4j instance: ~100M nodes, ~500M relationships
- Beyond this: Neo4j Fabric for graph sharding or separate databases per large tenant
- Co-occurrence: O(n^2) per document mitigated by entity count cap per chunk

### 3.4 Performance

**Approach**: Separation of ingestion and enrichment paths for zero-impact on search latency.

- Entity extraction runs in background workers (not in search path)
- Taxonomy lookup from Neo4j is 5-10ms (indexed)
- Enrichment adds no latency to existing ingestion pipeline (parallel step)
- LLM classification uses Haiku-first strategy (~500ms) with Sonnet escalation (~1.5s)
- Batch processing amortizes Neo4j connection overhead

### 3.5 Security

**Identified Issues**:

1. **Cypher injection**: `upsertRelationship()` uses string interpolation for relationship type. Must validate against allow-list: `['CO_OCCURS', 'REFERENCES', 'HAS_CATEGORY', 'HAS_PRODUCT', 'HAS_ATTRIBUTE', 'CLASSIFIED_AS', 'INSTANCE_OF', 'FOUND_IN_PRODUCT', 'EXTRACTED_FROM_DOCUMENT', 'EXCLUDES']`
2. **Neo4j credentials**: Stored in environment variables (acceptable for server-side)
3. **LLM credential isolation**: Per-index LLM client resolution prevents cross-tenant credential leakage
4. **Job access control**: Job status endpoint verifies tenant ownership of job data

### 3.6 Observability

**Current State**: Mixed logging (console.log in routes, workerLog in workers).

**Target**:

- All routes should use `createLogger('kg-enrichment')` / `createLogger('kg-taxonomy')`
- BullMQ job progress reported as percentage
- KG statistics API provides runtime observability
- Neo4j graph stats for capacity monitoring

**Gaps**:

- No distributed tracing (TraceEvent) integration
- No alerting on enrichment failures
- No Neo4j health check endpoint

### 3.7 Error Handling

**Strategy**: Graceful degradation with clear error messages.

| Failure Mode          | Behavior                                                     |
| --------------------- | ------------------------------------------------------------ |
| Neo4j down            | Service initialization fails; enrichment jobs fail and retry |
| LLM timeout           | Haiku -> Sonnet escalation; if both fail, document skipped   |
| Invalid taxonomy      | 400 response with validation errors                          |
| Missing taxonomy      | 400 with `nextSteps` pointing to setup API                   |
| Partial batch failure | Progress saved; job continues with remaining documents       |
| Redis down            | BullMQ queue operations fail; jobs not processed             |

### 3.8 Backward Compatibility

**Approach**: Knowledge graph is opt-in and additive.

- `KNOWLEDGE_GRAPH_ENABLED=false` by default
- Existing ingestion pipeline unchanged (KG enrichment is a separate step)
- No changes to search query API (graph-augmented retrieval is Phase 3)
- MongoDB schema additions are backward-compatible (new fields, not modifications)
- Documents work fine without KG enrichment (kgState field is optional)

### 3.9 Deployment

**Infrastructure Requirements**:

- Neo4j 5.x (Docker or managed service)
- Redis (existing, shared with other BullMQ workers)
- MongoDB (existing, new collections added)

**Docker Compose Addition**:

```yaml
neo4j:
  image: neo4j:5.29
  ports:
    - '7474:7474' # Browser
    - '7687:7687' # Bolt
  environment:
    NEO4J_AUTH: neo4j/password
  volumes:
    - neo4j_data:/data
```

**Helm Chart**: Requires Neo4j subchart or external Neo4j service URL in values.

### 3.10 Data Migration

**Taxonomy Updates**: Incremental re-classification (not full re-ingestion).

- New taxonomy version stored alongside previous versions
- Admin triggers re-classification for affected documents
- Cost: 33 min for 100K chunks vs 52 days for full re-ingestion

**Graph Data Lifecycle**:

- Index deletion should cascade to Neo4j graph deletion (`deleteIndexGraph()`)
- Document deletion should remove document-specific entities (`deleteDocumentGraph()`)
- Currently: No automatic cleanup on index/document deletion (known gap)

### 3.11 Cost Optimization

| Operation                 | Cost                 | Optimization                                             |
| ------------------------- | -------------------- | -------------------------------------------------------- |
| Taxonomy setup (LLM)      | $0.75/index          | One-time cost; reuse across re-ingestion                 |
| Document classification   | $0.0002/doc (Haiku)  | Reuses existing summaries (zero extra ingestion cost)    |
| Entity extraction         | $0/chunk (regex+NLP) | Free; LLM fallback only for low-confidence cases         |
| Neo4j hosting             | $0.10/GB/month       | Shared instance across tenants; property-based isolation |
| Full enrichment (1K docs) | ~$1.15               | 10x cheaper than per-chunk LLM classification            |

### 3.12 Compliance

- **Data minimization**: Entities store only text, type, and occurrence metadata
- **Tenant data deletion**: `deleteIndexGraph()` and `deleteTaxonomyGraph()` for right-to-erasure
- **Audit trail**: Taxonomy versioning preserves change history
- **No PII in graph**: Entity types include PERSON but text is extracted from already-ingested content (same PII posture as source documents)

---

## 4. Design Alternatives

### Alternative A: MongoDB-Only Graph (No Neo4j)

**Description**: Store entities and relationships in MongoDB using adjacency list pattern.

**Pros**:

- No additional infrastructure (Neo4j)
- Simpler deployment
- Single database for all data

**Cons**:

- Poor graph traversal performance (multiple round-trips)
- No native graph algorithms (shortest path, community detection)
- Complex queries for multi-hop relationships
- Would require significant custom code for graph operations

**Verdict**: REJECTED. Graph traversal is the core value proposition; MongoDB's document model is not suited for relationship-heavy queries.

### Alternative B: Embedded Graph (e.g., GraphologyJS)

**Description**: Use an in-process JavaScript graph library instead of Neo4j.

**Pros**:

- No external dependency
- Zero latency for graph operations (in-memory)
- Simple deployment

**Cons**:

- Memory-bound: Large graphs (100K+ entities) exhaust process memory
- No persistence: Graph lost on process restart
- No concurrent access from multiple workers
- No Cypher query language

**Verdict**: REJECTED. Production scale requires persistent, distributed graph storage. InMemoryGraphStore exists for testing only.

### Alternative C: Neo4j with Database-per-Tenant Isolation

**Description**: Create separate Neo4j databases for each tenant.

**Pros**:

- Strongest isolation guarantee
- Per-tenant resource limits
- Simpler Cypher queries (no tenantId filter)

**Cons**:

- Operational complexity: 100+ databases to manage
- Connection pool overhead: Separate driver per database
- Neo4j Community Edition: Single database only
- Backup/restore complexity

**Verdict**: REJECTED. Property-based isolation with indexed lookups provides adequate security. Database-per-tenant only justified for regulated industries with strict data segregation requirements.

---

## 5. Data Flow Diagrams

### Taxonomy Setup Flow

```
Admin API Request
       │
       ▼
POST /kg-taxonomy/setup
       │
       ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Validate     │────>│ Enqueue Job  │────>│ BullMQ Queue │
│ (index,auth) │     │ (taxonomy-   │     │ (taxonomy-   │
│              │     │  setup)      │     │  setup)      │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                  │
                                                  ▼
                                          ┌──────────────┐
                                          │ Taxonomy     │
                                          │ Setup Worker │
                                          └──────┬───────┘
                                                  │
                              ┌────────────────────┼────────────────────┐
                              ▼                    ▼                    ▼
                      ┌──────────────┐     ┌──────────────┐    ┌──────────────┐
                      │ Load Domain  │     │ Generate Org │    │ Parse with   │
                      │ Definitions  │     │ Profile (LLM)│    │ LLM (Sonnet) │
                      └──────┬───────┘     └──────┬───────┘    └──────┬───────┘
                              │                    │                    │
                              └────────────────────┼────────────────────┘
                                                   ▼
                              ┌────────────────────────────────────────────┐
                              │          Store Taxonomy                     │
                              │  ┌──────────────┐  ┌──────────────┐        │
                              │  │   MongoDB     │  │    Neo4j     │        │
                              │  │ (KGTaxonomy) │  │ (Graph nodes)│        │
                              │  └──────────────┘  └──────────────┘        │
                              └────────────────────────────────────────────┘
```

### KG Enrichment Flow

```
Admin API Request
       │
       ▼
POST /kg-enrich
       │
       ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Validate     │────>│ Count Docs   │────>│ Enqueue Job  │
│ (taxonomy    │     │ to Process   │     │ (kg-enrich)  │
│  exists)     │     │              │     │              │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                  │
                                                  ▼
                                          ┌──────────────────┐
                                          │ KG Enrichment    │
                                          │ Worker           │
                                          └──────┬───────────┘
                                                  │
                              For each document batch:
                              ┌────────────────────┼────────────────────┐
                              ▼                    ▼                    ▼
                      ┌──────────────┐     ┌──────────────┐    ┌──────────────┐
                      │ Classify Doc │     │ Extract      │    │ Store in     │
                      │ (LLM-based)  │     │ Entities     │    │ Neo4j +      │
                      │ Haiku/Sonnet │     │ (regex+NLP)  │    │ Vector DB    │
                      └──────────────┘     └──────────────┘    └──────────────┘
                              │                    │                    │
                              ▼                    ▼                    ▼
                      ┌──────────────┐     ┌──────────────┐    ┌──────────────┐
                      │ Update Doc   │     │ Update Chunk │    │ Link to      │
                      │ classification│    │ metadata     │    │ Products     │
                      │ in MongoDB   │     │ in MongoDB   │    │ in Neo4j     │
                      └──────────────┘     └──────────────┘    └──────────────┘
```

---

## 6. Component Inventory

### Taxonomy & Enrichment Components

| Component                   | Location                                                                 | Responsibility                             |
| --------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| `TaxonomyGraphService`      | `apps/search-ai/src/services/knowledge-graph/taxonomy-graph.service.ts`  | Taxonomy graph CRUD in Neo4j               |
| `ClickHouseEntityStore`     | `apps/search-ai/src/services/knowledge-graph/clickhouse-entity-store.ts` | ClickHouse-backed entity analytics storage |
| `EntityExtractorService`    | `apps/search-ai/src/services/entity-extractor.service.ts`                | Hybrid extraction: regex + LLM             |
| `DocumentClassifierService` | `apps/search-ai/src/services/document-classifier.service.ts`             | LLM-based document classification          |
| `TaxonomyLoaderService`     | `apps/search-ai/src/services/taxonomy-loader.service.ts`                 | Loads domain definitions from JSON         |
| `OrgProfileGenerator`       | `apps/search-ai/src/services/org-profile-generator.service.ts`           | Generates org profiles via LLM             |
| `CustomDomainGenerator`     | `apps/search-ai/src/services/custom-domain-generator.service.ts`         | Generates custom domain taxonomies         |
| `KGModelAssessment`         | `apps/search-ai/src/services/kg-model-assessment.ts`                     | Assesses tenant model capabilities for KG  |
| `GraphStore` interface      | `apps/search-ai/src/stores/graph-store.ts`                               | Abstract graph store + InMemoryGraphStore  |
| `kg-enrichment.ts`          | `apps/search-ai/src/routes/kg-enrichment.ts`                             | REST API for enrichment operations         |
| `kg-taxonomy.ts`            | `apps/search-ai/src/routes/kg-taxonomy.ts`                               | REST API for taxonomy management           |
| `kg-enrichment-worker.ts`   | `apps/search-ai/src/workers/kg-enrichment-worker.ts`                     | BullMQ worker for background enrichment    |
| `taxonomy-setup-worker.ts`  | `apps/search-ai/src/workers/taxonomy-setup-worker.ts`                    | BullMQ worker for taxonomy setup           |
| `KnowledgeGraphDomain`      | `packages/database/src/models/knowledge-graph-domain.model.ts`           | MongoDB model for custom domains           |
| `KnowledgeGraphTaxonomy`    | `packages/database/src/models/knowledge-graph-taxonomy.model.ts`         | MongoDB model for index taxonomy           |
| `kg.repository.ts`          | `apps/search-ai/src/repos/kg.repository.ts`                              | Repository layer for KG data access        |

### RACL Permission Components (added ABLP-303)

| Component                    | Location                                                                           | Responsibility                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `MongoPermissionStore`       | `packages/search-ai-internal/src/permissions/mongo-permission-store.ts`            | Drop-in replacement for PermissionGraphService (MongoDB-based) |
| `effective-groups-compute`   | `packages/search-ai-internal/src/permissions/effective-groups-compute.ts`          | BFS pre-computation of transitive group closure                |
| `AclDocumentPermissions`     | `packages/database/src/models/acl-document-permissions.model.ts`                   | Per-document permission data (replaces Neo4j Document nodes)   |
| `AclGroupHierarchy`          | `packages/database/src/models/acl-group-hierarchy.model.ts`                        | Group tree structure (replaces Neo4j Group + MEMBER_OF)        |
| `PermissionFilterService`    | `apps/search-ai-runtime/src/services/query/permission-filter-service.ts`           | 3-tier group resolution (JWT -> Redis -> MongoDB)              |
| `PermissionFilterMiddleware` | `apps/search-ai-runtime/src/middleware/permission-filter.middleware.ts`            | Request-level permission context injection                     |
| `DocumentPermissionResolver` | `apps/search-ai/src/services/document-permissions/document-permission-resolver.ts` | Reads permissions for embedding worker                         |
| `shared.ts`                  | `apps/search-ai/src/workers/shared.ts`                                             | Common worker utilities (Redis, error handling, logging)       |

### Removed Components

| Component (deleted)     | Former Location                                                         | Reason                                    |
| ----------------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| `KnowledgeGraphService` | `apps/search-ai/src/services/knowledge-graph/index.ts`                  | Functionality split into other services   |
| `Neo4jClient`           | `apps/search-ai/src/services/knowledge-graph/neo4j-client.ts`           | RACL moved to MongoDB                     |
| `EntityExtractor`       | `apps/search-ai/src/services/knowledge-graph/entity-extractor.ts`       | Replaced by `entity-extractor.service.ts` |
| `ReferenceExtractor`    | `apps/search-ai/src/services/knowledge-graph/reference-extractor.ts`    | Removed                                   |
| `CoOccurrenceAnalyzer`  | `apps/search-ai/src/services/knowledge-graph/co-occurrence-analyzer.ts` | Removed                                   |

---

## 7. Decision Log

| ID   | Decision                                  | Rationale                                                                                        | Date       |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------- |
| D-1  | Neo4j for graph storage                   | Native graph traversal, Cypher query language, production-proven                                 | 2026-02-25 |
| D-2  | Property-based tenant isolation           | Lower operational overhead vs database-per-tenant                                                | 2026-02-25 |
| D-3  | Separate enrichment jobs (not inline)     | Zero impact on ingestion latency (50s vs 50s+5min)                                               | 2026-02-25 |
| D-4  | Manual trigger for enrichment             | Admin controls when KG enrichment runs; not automatic                                            | 2026-02-25 |
| D-5  | Hybrid LLM strategy (Haiku+Sonnet)        | 10x cost reduction with quality escalation                                                       | 2026-02-25 |
| D-6  | Document-level classification (not chunk) | 1 LLM call per doc vs 10 per doc (chunk-level)                                                   | 2026-02-25 |
| D-7  | Reuse existing summaries                  | Zero additional ingestion cost for classification input                                          | 2026-02-25 |
| D-8  | MongoDB + Neo4j dual storage              | MongoDB for fast metadata access, Neo4j for graph traversal                                      | 2026-02-25 |
| D-9  | Compromise NLP for entity extraction      | Free, JS-native, adequate accuracy for initial phase                                             | 2026-02-25 |
| D-10 | InMemoryGraphStore for testing            | Enables unit tests without Neo4j dependency                                                      | 2026-03-22 |
| D-11 | RACL: Neo4j -> MongoDB migration          | 10-20x faster permission resolution (1-3ms vs 20-50ms), removes Neo4j dependency for permissions | 2026-04-14 |
| D-12 | BFS pre-computation at sync time          | Eliminates expensive MEMBER_OF\*1..20 traversal at query time                                    | 2026-04-14 |
| D-13 | 3-tier group resolution (JWT/Redis/Mongo) | JWT groups claim avoids all DB calls; Redis cache avoids MongoDB; graceful fallback              | 2026-04-14 |
| D-14 | Fail-closed permission default            | Security: no permissions record -> restricted, not public                                        | 2026-04-14 |

---

## 8. Open Items

| ID   | Item                                                  | Priority | Owner         | Status                                    |
| ---- | ----------------------------------------------------- | -------- | ------------- | ----------------------------------------- |
| O-1  | Implement graph-based retrieval API (Phase 4)         | P0       | SearchAI Team | NOT STARTED                               |
| O-2  | Fix Cypher injection in taxonomy graph operations     | P0       | SearchAI Team | OPEN (scoped to TaxonomyGraphService now) |
| O-3  | Migrate routes from console.log to createLogger       | P1       | SearchAI Team | OPEN                                      |
| O-4  | Add automatic graph cleanup on index deletion         | P1       | SearchAI Team | OPEN                                      |
| O-5  | ~~Share Neo4j connection pool between services~~      | P2       | SearchAI Team | RESOLVED — RACL no longer uses Neo4j      |
| O-6  | Add distributed tracing (TraceEvent) to KG operations | P2       | SearchAI Team | OPEN                                      |
| O-7  | Add Neo4j health check endpoint                       | P2       | SearchAI Team | OPEN (lower priority post-RACL migration) |
| O-8  | Cross-tenant job status should return 404, not 403    | P1       | SearchAI Team | OPEN                                      |
| O-9  | Unit tests for MongoPermissionStore                   | P0       | SearchAI Team | OPEN (ABLP-303 gap)                       |
| O-10 | Unit tests for BFS effective groups computation       | P0       | SearchAI Team | OPEN (ABLP-303 gap)                       |
| O-11 | Remove pre-RACL backward compat clause after re-index | P1       | SearchAI Team | OPEN (added ABLP-303)                     |

---

## 9. Post-Implementation Notes (ABLP-303)

### Deviations from Original HLD

1. **RACL migrated from Neo4j to MongoDB**: The original HLD described all permission data stored in Neo4j. ABLP-303 replaced this with MongoDB collections (`acl_document_permissions`, `acl_group_hierarchy`) and BFS pre-computation on contact cards.
2. **Several original components deleted**: `KnowledgeGraphService`, `Neo4jClient`, `EntityExtractor`, `ReferenceExtractor`, `CoOccurrenceAnalyzer` no longer exist at their original paths. Entity extraction was refactored to `entity-extractor.service.ts`.
3. **Permission filter service rewritten**: Query-time permission resolution now uses a 3-tier strategy (JWT -> Redis -> MongoDB) instead of Neo4j graph traversal.
4. **Fail-closed permission default**: Document permission resolver changed from fail-open (`publicEverywhere: true`) to fail-closed (`publicEverywhere: false`). Non-RACL sources are explicitly stamped at index time.
5. **Backward compatibility clause**: The permission filter includes a temporary clause for pre-RACL documents without a `permissions` field. This should be removed after a full re-index.
6. **Worker shared utilities**: A new `shared.ts` module was added for common BullMQ worker setup (Redis connection, error handling, logging).
7. **Server initialization simplified**: SearchAI and SearchAI-Runtime servers no longer initialize Neo4j connections for permission operations.
