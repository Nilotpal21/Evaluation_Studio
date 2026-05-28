# LLD: Knowledge Graph Implementation Plan

> **Feature ID**: #37
> **Status**: APPROVED
> **Created**: 2026-03-22
> **Related**:
>
> - Feature Spec: `docs/features/knowledge-graph.md`
> - Test Spec: `docs/testing/knowledge-graph.md`
> - HLD: `docs/specs/knowledge-graph.hld.md`

---

## Executive Summary

This implementation plan covers the remaining work for the Knowledge Graph feature. Phases 1-3 (Entity Graph, Taxonomy, KG Enrichment) are already implemented. This plan focuses on:

1. **P0 Bug Fixes** - Security and correctness issues in existing code
2. **P0 Observability** - Logging and monitoring gaps
3. **P1 Graph Retrieval API** - The next major feature (Phase 4)
4. **P1 Testing** - E2E and integration test coverage
5. **P2 Hardening** - Connection pooling, cleanup, tracing

---

## Phase 1: Security and Correctness Fixes (1-2 days)

### Objective

Fix P0 security and correctness issues identified in feature spec and HLD audit.

### Tasks

#### 1.1 Fix Cypher Injection in upsertRelationship

**File**: `apps/search-ai/src/services/knowledge-graph/neo4j-client.ts`

**Problem**: Line ~294 uses string interpolation `${relationship.type}` in Cypher query.

**Fix**:

```typescript
const ALLOWED_RELATIONSHIP_TYPES = new Set([
  'CO_OCCURS',
  'REFERENCES',
  'HAS_CATEGORY',
  'HAS_PRODUCT',
  'HAS_ATTRIBUTE',
  'CLASSIFIED_AS',
  'INSTANCE_OF',
  'FOUND_IN_PRODUCT',
  'EXTRACTED_FROM_DOCUMENT',
  'EXCLUDES',
]);

async upsertRelationship(relationship: RelationshipEdge): Promise<void> {
  if (!ALLOWED_RELATIONSHIP_TYPES.has(relationship.type)) {
    throw new Error(`Invalid relationship type: ${relationship.type}`);
  }
  // ... existing code with validated type
}
```

**Exit Criteria**:

- [ ] `ALLOWED_RELATIONSHIP_TYPES` constant defined
- [ ] Validation before Cypher query execution
- [ ] Unit test for invalid relationship type rejection
- [ ] Existing tests still pass

#### 1.2 Fix Cross-Tenant Job Status Response Code

**File**: `apps/search-ai/src/routes/kg-enrichment.ts`

**Problem**: Line ~242 returns 403 for cross-tenant job access. Should return 404.

**Fix**: Change `res.status(403)` to `res.status(404)` with generic "Job not found" message.

**Exit Criteria**:

- [ ] 404 returned for cross-tenant job access
- [ ] Error message does not leak job existence

#### 1.3 Add Neo4j Graph Cleanup on Index Deletion

**File**: `apps/search-ai/src/routes/` (index deletion route) or event handler

**Problem**: When a search index is deleted, Neo4j graph data is not cleaned up.

**Fix**: Add cleanup call to `deleteIndexGraph()` and `deleteTaxonomyGraph()` in index deletion flow.

**Exit Criteria**:

- [ ] Index deletion triggers Neo4j cleanup
- [ ] Both entity graph and taxonomy graph removed
- [ ] Cleanup failure does not block index deletion (log error, continue)

---

## Phase 2: Observability Fixes (1 day)

### Objective

Bring KG routes into compliance with platform logging standards.

### Tasks

#### 2.1 Migrate kg-enrichment.ts to createLogger

**File**: `apps/search-ai/src/routes/kg-enrichment.ts`

**Problem**: Uses `console.log`/`console.error` instead of `createLogger`.

**Fix**: Replace all `console.log('[kg-enrichment]', ...)` with `logger.info(...)` and `console.error(...)` with `logger.error(...)`.

**Exit Criteria**:

- [ ] No `console.log` or `console.error` remaining
- [ ] All log calls use `createLogger('kg-enrichment')`
- [ ] Error logs include structured context `{ indexId, tenantId, jobId }`

#### 2.2 Remove `any` Types in Routes

**Files**: `apps/search-ai/src/routes/kg-enrichment.ts`

**Problem**: Multiple `any` types for query objects and aggregation pipelines.

**Fix**: Define proper TypeScript interfaces for:

- Document query filters
- Aggregation pipeline stages
- Response payloads

**Exit Criteria**:

- [ ] No `any` casts in route files
- [ ] Types compile without errors
- [ ] `pnpm build --filter=search-ai` passes

---

## Phase 3: Graph Retrieval API (5-7 days)

### Objective

Implement REST API for graph-augmented search (FR-26, FR-27, FR-28 from feature spec).

### Tasks

#### 3.1 Design Graph Retrieval Endpoint

**New File**: `apps/search-ai/src/routes/kg-search.ts`

**Endpoint**: `POST /api/indexes/:indexId/kg-search`

**Request Body**:

```typescript
interface KGSearchRequest {
  query: string;
  productScope?: string; // Filter by product
  entityTypes?: string[]; // Filter by entity types
  minConfidence?: number; // Min classification confidence
  limit?: number; // Max results (default: 20)
  includeGraph?: boolean; // Include entity graph in response
  graphDepth?: number; // Hops for graph traversal (default: 1)
}
```

**Response**:

```typescript
interface KGSearchResponse {
  results: Array<{
    documentId: string;
    title: string;
    summary: string;
    score: number; // Combined vector + graph score
    classification: {
      primaryProduct: string;
      confidence: number;
    };
    entities: Array<{
      text: string;
      type: string;
      relevance: number;
    }>;
  }>;
  graph?: {
    // If includeGraph=true
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  disambiguation?: {
    detectedProduct: string;
    confidence: number;
    impossibleQuery: boolean;
    reason?: string;
  };
}
```

**Exit Criteria**:

- [ ] Endpoint registered and accessible
- [ ] Request validation with Zod schema
- [ ] Tenant isolation enforced
- [ ] Response matches schema

#### 3.2 Implement Query Disambiguation

**New File**: `apps/search-ai/src/services/knowledge-graph/query-disambiguator.ts`

**Logic**:

1. Extract entities from query text (reuse EntityExtractor)
2. Look up extracted entities in taxonomy graph
3. Determine product scope from entity-product relationships
4. Check attribute applicability (e.g., "interest rate" applicable to credit_card but not debit_card)
5. Return disambiguation result with confidence

**Exit Criteria**:

- [ ] Detects product scope from query entities
- [ ] Identifies impossible queries (attribute not applicable to product)
- [ ] Returns confidence score
- [ ] Works with taxonomy graph data

#### 3.3 Implement Graph-Augmented Scoring

**New File**: `apps/search-ai/src/services/knowledge-graph/graph-scorer.ts`

**Logic**:

1. For each vector search result, look up document classification
2. Boost score if document's product scope matches query's detected scope
3. Boost score based on entity overlap (query entities present in document)
4. Apply configurable weight: `finalScore = vectorScore * (1 - graphWeight) + graphScore * graphWeight`

**Exit Criteria**:

- [ ] Scoring function takes vector results + graph context
- [ ] Configurable graph weight parameter
- [ ] Product match boost applied
- [ ] Entity overlap boost applied

#### 3.4 Implement Entity-Centric Search

**Enhancement to existing search or new endpoint**

**Logic**:

1. Accept entity text as search input
2. Look up entity in Neo4j
3. Find all documents containing that entity
4. Return documents sorted by entity relevance (IDF, co-occurrence weight)

**Exit Criteria**:

- [ ] Entity lookup returns matching documents
- [ ] Results sorted by relevance
- [ ] Tenant isolation maintained
- [ ] Pagination support

#### 3.5 Wire Graph Search into Existing Search Pipeline

**File**: `apps/search-ai/src/routes/search-routes.ts` (or equivalent)

**Logic**: Add optional graph enrichment to existing search endpoint

- If `KNOWLEDGE_GRAPH_ENABLED=true` and index has taxonomy
- Run query disambiguation
- Apply graph-augmented scoring to vector results
- Return graph context in response

**Exit Criteria**:

- [ ] Existing search behavior unchanged when KG disabled
- [ ] Graph enrichment applied when KG enabled
- [ ] Latency overhead <= 50ms
- [ ] Feature flag controls activation

---

## Phase 4: Test Implementation (3-5 days)

### Objective

Implement E2E and integration tests defined in test spec.

### Tasks

#### 4.1 E2E Test Infrastructure

**New File**: `apps/search-ai/src/__tests__/e2e/kg-e2e-setup.ts`

- Start SearchAI Express server on random port
- Configure Neo4j testcontainer or local instance
- Create test tenant auth context
- Seed test data (index, documents with summaries)
- Cleanup after tests

**Exit Criteria**:

- [ ] Server starts and stops cleanly
- [ ] Neo4j connection established
- [ ] Test data seeded and cleaned up

#### 4.2 E2E Tests: Taxonomy Lifecycle (E2E-1)

**New File**: `apps/search-ai/src/__tests__/e2e/kg-taxonomy.e2e.test.ts`

**Exit Criteria**:

- [ ] All 6 steps from E2E-1 pass
- [ ] No mocks of codebase components

#### 4.3 E2E Tests: Enrichment Flow (E2E-2)

**New File**: `apps/search-ai/src/__tests__/e2e/kg-enrichment.e2e.test.ts`

**Exit Criteria**:

- [ ] All 6 steps from E2E-2 pass
- [ ] Job polling works correctly
- [ ] Statistics populated after enrichment

#### 4.4 E2E Tests: Tenant Isolation (E2E-5)

**New File**: `apps/search-ai/src/__tests__/e2e/kg-tenant-isolation.e2e.test.ts`

**Exit Criteria**:

- [ ] All 7 steps from E2E-5 pass
- [ ] Cross-tenant access returns 404

#### 4.5 Integration Tests: Neo4j Client (INT-3)

**New File**: `apps/search-ai/src/__tests__/integration/neo4j-client.integration.test.ts`

**Exit Criteria**:

- [ ] All 9 test cases from INT-3 pass
- [ ] Requires real Neo4j instance (Docker)

#### 4.6 Integration Tests: Taxonomy Graph (INT-4)

**New File**: `apps/search-ai/src/__tests__/integration/taxonomy-graph.integration.test.ts`

**Exit Criteria**:

- [ ] All 8 test cases from INT-4 pass
- [ ] Requires real Neo4j instance

---

## Phase 5: Hardening (2-3 days)

### Objective

Address P2 technical debt and improve operational robustness.

### Tasks

#### 5.1 Share Neo4j Connection Pool

**Problem**: `KnowledgeGraphService` and `TaxonomyGraphService` each create separate Neo4j drivers.

**Fix**: Create a `Neo4jConnectionManager` singleton that provides a shared driver.

```typescript
// apps/search-ai/src/services/knowledge-graph/connection-manager.ts
class Neo4jConnectionManager {
  private static instance: Neo4jConnectionManager;
  private driver: Driver | null = null;

  static getInstance(): Neo4jConnectionManager { ... }
  async getDriver(): Promise<Driver> { ... }
  async close(): Promise<void> { ... }
}
```

**Exit Criteria**:

- [ ] Single Neo4j driver shared across services
- [ ] Connection pool size configurable
- [ ] Graceful shutdown closes driver

#### 5.2 Add Distributed Tracing

**Files**: Service layer files

**Fix**: Add `TraceEvent` emission for key KG operations:

- Taxonomy setup start/complete
- Enrichment batch start/complete
- Entity extraction per document
- Neo4j query latency

**Exit Criteria**:

- [ ] TraceEvents emitted for taxonomy setup
- [ ] TraceEvents emitted for enrichment
- [ ] Events include tenantId, indexId, operation duration

#### 5.3 Add Neo4j Health Check

**File**: `apps/search-ai/src/routes/health.ts` (or new route)

**Endpoint**: `GET /api/health/neo4j`

**Response**: `{ status: 'healthy' | 'unhealthy', latencyMs: number }`

**Exit Criteria**:

- [ ] Health check endpoint returns Neo4j status
- [ ] Includes connection latency
- [ ] Does not leak credentials

#### 5.4 Add Graph Pagination

**File**: `apps/search-ai/src/routes/kg-enrichment.ts` (graph endpoint)

**Problem**: Graph visualization endpoint returns all nodes/edges.

**Fix**: Add `limit` and `offset` query parameters. Default limit of 500 nodes.

**Exit Criteria**:

- [ ] Pagination parameters accepted
- [ ] Default limit prevents unbounded responses
- [ ] Total count returned for UI pagination

---

## Implementation Schedule

| Phase                        | Duration | Dependencies | Priority |
| ---------------------------- | -------- | ------------ | -------- |
| Phase 1: Security Fixes      | 1-2 days | None         | P0       |
| Phase 2: Observability       | 1 day    | None         | P0       |
| Phase 3: Graph Retrieval API | 5-7 days | Phases 1-2   | P1       |
| Phase 4: Test Implementation | 3-5 days | Phases 1-3   | P1       |
| Phase 5: Hardening           | 2-3 days | Phases 1-4   | P2       |

**Total Estimated Duration**: 12-18 days

---

## Wiring Checklist

Each phase must verify these integration points:

- [ ] Routes registered in `apps/search-ai/src/server.ts`
- [ ] Worker registered in `apps/search-ai/src/workers/index.ts`
- [ ] Models exported from `packages/database/src/models/index.ts`
- [ ] Config schema updated in `apps/search-ai/src/config/index.ts`
- [ ] Zod validation schemas using `z.string().min(1)` for IDs (not `.cuid()`)
- [ ] Error responses use `{ success: false, error: { code, message } }` format
- [ ] All queries include `tenantId` in filter
- [ ] Logger used instead of console.log
- [ ] Types compile: `pnpm build --filter=search-ai`

---

## Risk Register

| Risk                                        | Likelihood | Impact | Mitigation                                                     |
| ------------------------------------------- | ---------- | ------ | -------------------------------------------------------------- |
| Neo4j performance at scale (100K+ entities) | Medium     | High   | Benchmark with realistic data before GA                        |
| LLM cost overrun for large indexes          | Low        | Medium | Haiku-first strategy, cost caps per index                      |
| Query disambiguation false positives        | Medium     | Medium | Configurable confidence threshold, fallback to unscoped search |
| Neo4j downtime during enrichment            | Low        | High   | Job retry with backoff, enrichment is background-only          |
| Graph retrieval adding search latency       | Medium     | High   | Feature flag, latency monitoring, async graph enrichment       |

---

## Success Metrics

| Metric                          | Target           | Measurement                              |
| ------------------------------- | ---------------- | ---------------------------------------- |
| Product disambiguation accuracy | >= 91%           | Manual evaluation on banking test corpus |
| Entity extraction precision     | >= 85%           | Precision/recall on labeled test set     |
| False relationship prevention   | >= 95%           | Comparison with baseline (no KG)         |
| Search latency with graph       | <= 50ms overhead | P99 latency measurement                  |
| E2E test coverage               | >= 80%           | Coverage report for KG routes            |
| Tenant isolation                | 100%             | Automated cross-tenant tests             |
