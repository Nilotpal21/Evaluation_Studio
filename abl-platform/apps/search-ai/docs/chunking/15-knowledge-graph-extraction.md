# Knowledge Graph Extraction

**Platform Capability:** Cross-document entity linking and relationship discovery
**Worker:** `knowledge-graph-worker.ts`
**Status:** ✅ Fully Implemented (Phase 3)
**Cost:** ~$0.00002/chunk (using compromise NER)
**Last Updated:** 2026-02-24

---

## Table of Contents

- [Overview](#overview)
- [Design Rationale & Architecture Decisions](#design-rationale--architecture-decisions)
- [When to Enable Knowledge Graph](#when-to-enable-knowledge-graph)
- [Architecture](#architecture)
- [Implementation Deep Dive](#implementation-deep-dive)
- [Entity Extraction](#entity-extraction)
- [Reference Extraction](#reference-extraction)
- [Co-Occurrence Analysis](#co-occurrence-analysis)
- [Neo4j Graph Storage](#neo4j-graph-storage)
- [Integration with Platform](#integration-with-platform)
- [Querying the Knowledge Graph](#querying-the-knowledge-graph)
- [Configuration](#configuration)
- [Performance Characteristics](#performance-characteristics)
- [Performance Optimization Guide](#performance-optimization-guide)
- [Testing Strategy](#testing-strategy)
- [Use Cases](#use-cases)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Operational Runbook](#operational-runbook)

---

## Overview

The knowledge graph feature automatically extracts entities, references, and relationships from documents to build a queryable graph database in Neo4j. This enables:

- **Cross-document entity linking** — Connect "John Smith" mentions across all documents
- **Relationship discovery** — Find which entities co-occur frequently (IDF-weighted)
- **Reference resolution** — Track "See Contract #45821" → actual contract
- **Entity-centric retrieval** — "Show all documents mentioning Microsoft and Google together"
- **Graph analytics** — Entity importance (IDF scores), relationship strength, clustering

### Key Differentiators

Unlike traditional semantic search (which finds similar text), knowledge graphs enable:

- **Structured queries** — "Which organizations are mentioned with John Smith?"
- **Relationship traversal** — "Find entities 2 hops away from Entity X"
- **Temporal analysis** — Track when entities first/last appeared
- **Importance ranking** — IDF scores identify rare/significant entities
- **Cross-document reasoning** — "Are Contract #123 and Exhibit A mentioned in the same documents?"

### Processing Flow

```
Document Upload
    ↓
Chunking (Stage 2-4)
    ↓
Enrichment (Stage 5)
    ↓
┌─────────────────────────────┐
│ Knowledge Graph Extraction  │  ← You are here
│ (Stage 6 - Parallel)        │
└─────────────────────────────┘
    ↓
- Entity Extraction (NER + regex)
- Reference Extraction (contract/exhibit patterns)
- Co-Occurrence Analysis (IDF weighting)
- Neo4j Storage (entities + relationships)
    ↓
Embedding (Stage 7 - Parallel)
    ↓
Indexed
```

Runs **in parallel** with embedding generation for optimal throughput.

---

## Design Rationale & Architecture Decisions

This section documents the key architectural decisions behind the knowledge graph implementation, including trade-offs, alternatives considered, and why specific technologies and approaches were chosen.

### ADR-001: Why Neo4j Over Other Graph Databases?

**Decision:** Use Neo4j as the graph database backend for the knowledge graph.

**Context:**
We evaluated multiple graph database options for storing and querying entity relationships:

- **Neo4j** (property graph, Cypher query language)
- **ArangoDB** (multi-model: graph, document, K/V)
- **TigerGraph** (native parallel graph database)
- **Amazon Neptune** (managed AWS service, Gremlin/SPARQL)
- **OrientDB** (multi-model graph/document)

**Rationale:**

| Criterion                | Neo4j Score | Why Neo4j Wins                                                                                                                             |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Query Language**       | ⭐⭐⭐⭐⭐  | Cypher is highly readable, pattern-matching focused, and optimized for graph traversals. Easier to maintain than Gremlin.                  |
| **Performance**          | ⭐⭐⭐⭐    | Index-free adjacency provides O(1) relationship traversal. Excellent for hop-based queries (2-3 hops typical in knowledge graphs).         |
| **Developer Experience** | ⭐⭐⭐⭐⭐  | Mature Node.js driver (`neo4j-driver`), active community, extensive documentation, Neo4j Browser for debugging.                            |
| **Tenant Isolation**     | ⭐⭐⭐⭐    | Property-based filtering on `tenantId` + `indexId` with constraints ensures no cross-tenant leakage.                                       |
| **Deployment**           | ⭐⭐⭐⭐    | Docker-based deployment, Helm charts available, runs on K8s without special orchestration.                                                 |
| **Cost**                 | ⭐⭐⭐      | Open-source Community Edition free, but Enterprise (clustering) requires licensing. Neptune would be cheaper at scale for managed service. |
| **Scalability**          | ⭐⭐⭐      | Single-instance scales to 100M+ nodes. Clustering requires Enterprise. TigerGraph would win for >1B nodes.                                 |

**Trade-offs:**

- **Chosen:** Neo4j Community Edition for simplicity, strong query language, and developer productivity.
- **Rejected:** ArangoDB (multi-model complexity not needed), TigerGraph (overkill for our scale), Neptune (AWS lock-in).

**Future Consideration:** If entity count exceeds 100M nodes or multi-region deployment is needed, re-evaluate TigerGraph or Neptune.

---

### ADR-002: Why Compromise NLP vs. LLM-Based Entity Extraction?

**Decision:** Use **compromise NLP** (JavaScript NLP library) for semantic entity extraction instead of LLM-based extraction.

**Context:**
Entity extraction options:

1. **Regex only** — Fast, deterministic, structured entities only
2. **Compromise NLP** — JavaScript library, ~80% accuracy, no API calls
3. **spaCy (Python NER)** — 85-90% accuracy, requires Python bridge
4. **Stanford NER (Java)** — Academic gold standard, heavyweight
5. **LLM-based (GPT-4o-mini/Claude)** — 95%+ accuracy, $0.001/chunk cost

**Rationale:**

| Criterion              | Compromise                    | LLM-based                         |
| ---------------------- | ----------------------------- | --------------------------------- |
| **Cost**               | $0.00002/chunk (compute only) | $0.001/chunk (50× more expensive) |
| **Latency**            | 3-6ms/chunk                   | 200-500ms/chunk (API round-trip)  |
| **Accuracy**           | 80-85% (English)              | 95%+                              |
| **Offline**            | ✅ Runs locally               | ❌ Requires external API          |
| **Throughput**         | 60 chunks/sec (3 workers)     | 2-5 chunks/sec (rate limits)      |
| **Tenant Isolation**   | ✅ No data leaves platform    | ⚠️ Data sent to third party       |
| **Privacy/Compliance** | ✅ PCI/GDPR compliant         | ⚠️ May violate data residency     |

**Trade-offs:**

- **Chosen:** Compromise NLP for cost, latency, privacy, and throughput.
- **Accepted:** Lower accuracy (80% vs. 95%) is acceptable because:
  - **False negatives** (missed entities) reduce graph density but don't break functionality.
  - **False positives** (incorrect entities) are filtered by confidence thresholds and co-occurrence IDF weighting.
  - Users care more about **relationship discovery** (which entities co-occur) than perfect entity extraction.

**Hybrid Approach:** We combine regex (100% precision for structured entities like emails, URLs, dates) with compromise (80% recall for semantic entities like people, organizations). This achieves ~85% F1 score at <10% the cost of LLM-based extraction.

**Future Consideration:** For customers with strict accuracy requirements, add an **optional LLM-based extraction mode** (opt-in, per-index configuration).

---

### ADR-003: Why IDF Weighting for Co-Occurrence?

**Decision:** Use **IDF (Inverse Document Frequency) weighting** to calculate co-occurrence relationship strengths, not raw frequency.

**Context:**
Co-occurrence scoring options:

1. **Raw frequency** — Count how many times two entities appear together
2. **TF-IDF** — Term frequency × IDF (standard text retrieval)
3. **IDF-weighted co-occurrence** — `max(IDF_entity1, IDF_entity2) × frequency`
4. **PMI (Pointwise Mutual Information)** — `log(P(e1, e2) / (P(e1) × P(e2)))`
5. **NPMI (Normalized PMI)** — PMI normalized to [-1, 1]

**Rationale:**

**Problem with raw frequency:**

```
"the" and "is" co-occur 10,000 times → high score but meaningless
"Satya Nadella" and "OpenAI" co-occur 5 times → low score but highly significant
```

**Solution: IDF weighting rewards rare entity pairs:**

```
IDF("the") = log((1000 + 1) / (1000 + 1)) ≈ 0.0  (common → low weight)
IDF("Satya Nadella") = log((1000 + 1) / (5 + 1)) ≈ 5.3  (rare → high weight)

Weight("the", "is") = max(0.0, 0.0) × 10,000 = 0  (filtered out)
Weight("Satya", "OpenAI") = max(5.3, 4.2) × 5 = 26.5  (kept)
```

**Why `max(IDF1, IDF2)` instead of average?**

- A **rare entity co-occurring with a common entity** is still notable.
- Example: "Microsoft" (common, IDF=0.8) + "Satya Nadella" (rare, IDF=5.3) → weight = 5.3 × frequency.
- Using average would dilute the signal: (0.8 + 5.3) / 2 = 3.05.

**Why not PMI?**

- **PMI requires normalization** to avoid bias toward rare entity pairs that co-occur only once.
- **IDF + frequency is simpler** and provides intuitive tuning via `minIdfThreshold`.

**Trade-offs:**

- **Chosen:** IDF-weighted co-occurrence for simplicity, interpretability, and effective noise filtering.
- **Accepted:** May miss some low-frequency but semantically meaningful co-occurrences (e.g., entities appearing only once together).

**Tuning:** The `minIdfThreshold` parameter (default: 1.5) controls precision/recall:

- **Low threshold (0.5):** High recall, more edges, denser graph, more noise.
- **High threshold (3.0):** High precision, fewer edges, sparse graph, less noise.

---

### ADR-004: Why Batch Processing vs. Stream Processing?

**Decision:** Process knowledge graph extraction in **batches per document** (not per-chunk streaming).

**Context:**
Processing options:

1. **Per-chunk streaming** — Extract entities and create graph nodes immediately after each chunk
2. **Per-document batching** — Collect all chunks for a document, then process together
3. **Per-index batching** — Collect all chunks for an entire index, then build full graph

**Rationale:**

**Co-occurrence requires document-level context:**

- IDF calculation needs **total chunk count** (`N`) and **document frequency per entity** (`df`).
- Streaming per-chunk would require:
  - Maintaining running IDF statistics (complex state management).
  - Re-calculating co-occurrence weights after every chunk (expensive).
  - Creating edges prematurely (before all entities are discovered).

**Batch processing benefits:**

```
Document with 50 chunks:
  1. Extract entities from all 50 chunks (parallelizable)
  2. Calculate IDF across 50 chunks (one pass)
  3. Calculate co-occurrence weights (one pass over entity pairs)
  4. Create Neo4j edges in bulk (batched writes)
```

**Performance:**

- **Batching:** 50 chunks → 1 IDF calculation + 1 bulk Neo4j write = ~500ms
- **Streaming:** 50 chunks → 50 IDF updates + 50 Neo4j writes = ~5000ms

**Trade-offs:**

- **Chosen:** Per-document batching for correctness, simplicity, and performance.
- **Accepted:** Knowledge graph is not available until **entire document is processed** (not real-time).
- **Mitigated:** Entities are still extracted per-chunk and stored in `SearchChunk.metadata.entities` immediately (accessible before graph is complete).

**Future Consideration:** For real-time applications, implement **incremental IDF updates** with approximate co-occurrence scores (accept lower accuracy for lower latency).

---

### ADR-005: Why Property-Based Tenant Isolation in Neo4j?

**Decision:** Enforce tenant isolation using **properties** (`tenantId`, `indexId`) on all nodes and relationships, not separate databases.

**Context:**
Tenant isolation options:

1. **Separate Neo4j databases per tenant** — Physical isolation
2. **Separate graphs per tenant (same DB)** — Logical isolation via labels
3. **Property-based filtering** — `tenantId` property on all nodes/edges

**Rationale:**

**Separate databases:**

- **Pros:** Complete physical isolation, no cross-tenant query risk.
- **Cons:**
  - **Scalability:** Neo4j Community Edition supports only 1 database. Enterprise supports multiple, but each database has overhead (memory, connections).
  - **Operational complexity:** 100 tenants = 100 databases = 100× connection pools, backups, monitoring.
  - **Cross-tenant analytics impossible:** Cannot compare entity distributions across tenants (useful for platform-level insights).

**Property-based filtering:**

- **Pros:**
  - **Scalable:** Single database, shared connection pool, unified backup.
  - **Flexible:** Supports both tenant-scoped and platform-wide queries (with filters).
  - **Simpler ops:** One database to monitor, backup, scale.
- **Cons:**
  - **Security risk:** Requires **discipline** to always include `tenantId` filter in queries.
  - **Performance:** Property filtering is slower than separate databases (but indexes mitigate this).

**Mitigation of security risk:**

1. **Unique constraint** enforces `tenantId` + `indexId` + `type` + `text` uniqueness → prevents accidental cross-tenant node matches.
2. **Indexes** on `(tenantId, indexId)` → fast tenant-scoped queries.
3. **Code review rule:** All Cypher queries MUST include `tenantId` and `indexId` filters (enforced in PR reviews).
4. **Automated testing:** Every graph query has an **authorization test** verifying cross-tenant access returns empty results.

**Example:**

```cypher
// ❌ BAD: No tenant filter (security risk)
MATCH (e:Entity {text: 'Microsoft'})
RETURN e

// ✅ GOOD: Tenant + index scoped
MATCH (e:Entity {
  text: 'Microsoft',
  tenantId: $tenantId,
  indexId: $indexId
})
RETURN e
```

**Trade-offs:**

- **Chosen:** Property-based isolation for scalability and operational simplicity.
- **Accepted:** Requires developer discipline and rigorous testing.
- **Enforced:** See `apps/search-ai/docs/chunking/11-security-tenant-isolation.md` for platform-wide isolation patterns.

---

## When to Enable Knowledge Graph

### ✅ Enable for These Use Cases

| Use Case                         | Why Knowledge Graph Helps                            | Example Query                                           |
| -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| **Legal Document Management**    | Track contracts, exhibits, sections across documents | "Find all exhibits referenced in Contract #45821"       |
| **Research & Literature Review** | Link authors, organizations, studies                 | "Which organizations collaborate with MIT?"             |
| **Compliance & Audit**           | Track entity mentions for regulatory compliance      | "Show all documents mentioning Entity X in 2024"        |
| **CRM & Sales Intelligence**     | Link people, companies, products                     | "Which contacts are associated with Microsoft deals?"   |
| **Technical Documentation**      | Track API references, component dependencies         | "Which components reference the Authentication module?" |
| **Investigative Analysis**       | Discover hidden connections between entities         | "Find entities that co-occur with suspicious actors"    |

### ❌ Skip Knowledge Graph If

- **Short-lived documents** — Graph overhead not justified for temporary content
- **No cross-document linking needs** — Pure semantic search is sufficient
- **Unstructured chat/email** — Few extractable structured entities
- **Cost-sensitive** — Adds ~$0.00002/chunk + Neo4j infrastructure cost
- **Low entity density** — Documents with few named entities/references

### Hybrid Approach

Enable knowledge graph for **specific indexes** while disabling for others:

```typescript
// Enable for legal contracts index
await SearchIndex.findByIdAndUpdate(legalIndexId, {
  'llmConfig.useCases.knowledgeGraph.enabled': true,
  'llmConfig.useCases.knowledgeGraph.enableCoOccurrence': true,
});

// Disable for chat messages index
await SearchIndex.findByIdAndUpdate(chatIndexId, {
  'llmConfig.useCases.knowledgeGraph.enabled': false,
});
```

---

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                      Knowledge Graph Service                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐ │
│  │ Entity Extractor │  │Reference Extractor│  │ Co-Occurrence │ │
│  │  - Regex         │  │  - Contract refs  │  │   Analyzer    │ │
│  │  - Compromise    │  │  - Exhibit refs   │  │  - IDF calc   │ │
│  │  - Hybrid        │  │  - Section refs   │  │  - Weighting  │ │
│  └──────────────────┘  └──────────────────┘  └───────────────┘ │
│           ↓                      ↓                     ↓          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Neo4j Client (Graph Storage)                │   │
│  │  - Entity nodes (PERSON, ORG, LOCATION, etc.)           │   │
│  │  - REFERENCES relationships (explicit)                   │   │
│  │  - CO_OCCURS relationships (IDF-weighted)                │   │
│  │  - Tenant isolation (tenantId on all nodes/edges)       │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────────┐
│                         Neo4j Database                           │
│  Connection: neo4j://localhost:7687                             │
│  Max Pool Size: 100 (for 11-worker production load)             │
├─────────────────────────────────────────────────────────────────┤
│  Nodes:                                                          │
│    Entity {id, text, type, tenantId, indexId, documentId,       │
│             chunkId, firstSeenAt, lastSeenAt,                   │
│             occurrenceCount, idf}                               │
│                                                                   │
│  Relationships:                                                  │
│    REFERENCES {type, tenantId, indexId, weight, count,          │
│                metadata: {referenceType, identifier}}           │
│    CO_OCCURS {type, tenantId, indexId, weight, count,           │
│               metadata: {frequency, chunkIds, idf scores}}      │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Chunk Text
    ↓
[Entity Extraction]
    ↓
- Regex: emails, URLs, dates, money, phone
- Compromise NLP: people, orgs, locations
- Hybrid: combine + deduplicate
    ↓
Extracted Entities: [{text, type, start, end, confidence}]
    ↓
[Reference Extraction]
    ↓
Regex patterns for:
- Contract #X, Exhibit A, Section 3.2
- Figure 5, Table A-1, Appendix B
    ↓
Extracted References: [{text, type, identifier}]
    ↓
[Neo4j Upsert Entities]
    ↓
- MERGE on (tenantId, indexId, type, text)
- Increment occurrenceCount on match
- Store documentId, chunkId, timestamps
    ↓
[Create REFERENCES Relationships]
    ↓
For each reference:
  - Find target entity in Neo4j
  - Create REFERENCES edge (weight=1.0)
    ↓
[Co-Occurrence Analysis] (if enabled)
    ↓
- Calculate IDF for each entity
- Find entity pairs in same chunks
- Weight = max(idf1, idf2) * frequency
- Filter by minIdfThreshold (default: 1.5)
    ↓
[Create CO_OCCURS Relationships]
    ↓
For each co-occurrence above threshold:
  - Create CO_OCCURS edge (weight=IDF-weighted)
    ↓
[Update Chunk Metadata]
    ↓
SearchChunk.metadata:
  - entities: [{text, type, start, end, confidence}]
  - references: [{text, type, identifier}]
  - entityIds: [neo4j_id_1, neo4j_id_2, ...]
    ↓
[Update Document Metadata]
    ↓
SearchDocument.metadata.knowledgeGraph:
  - totalEntities, totalReferences, totalRelationships
  - processedAt
```

---

## Implementation Deep Dive

This section provides a code-level walkthrough of the knowledge graph implementation, showing how the pieces fit together.

### Class Structure & Dependencies

```typescript
// Main service orchestrator
KnowledgeGraphService
  ├── config: SearchAIConfig['knowledgeGraph']
  ├── neo4jClient: Neo4jClient                    // Graph database operations
  ├── entityExtractor: EntityExtractor            // Entity extraction
  ├── referenceExtractor: ReferenceExtractor      // Reference extraction
  └── coOccurrenceAnalyzer: CoOccurrenceAnalyzer  // Co-occurrence analysis

// Worker (BullMQ job processor)
knowledge-graph-worker.ts
  ├── Processes KnowledgeGraphJobData
  ├── Resolves per-index LLM config
  ├── Creates KnowledgeGraphService instance
  └── Batch processes all chunks for a document
```

**Files:**

- `apps/search-ai/src/services/knowledge-graph/index.ts` — Main service (447 lines)
- `apps/search-ai/src/workers/knowledge-graph-worker.ts` — Worker (205 lines)
- `apps/search-ai/src/services/knowledge-graph/entity-extractor.ts` — Entity extraction (323 lines)
- `apps/search-ai/src/services/knowledge-graph/reference-extractor.ts` — Reference patterns
- `apps/search-ai/src/services/knowledge-graph/co-occurrence-analyzer.ts` — IDF calculation
- `apps/search-ai/src/services/knowledge-graph/neo4j-client.ts` — Neo4j operations

---

### Sequence Diagram: Document Processing

```
┌───────────┐    ┌───────────────┐    ┌──────────────────┐    ┌────────────┐    ┌─────────┐
│ BullMQ    │    │ Worker        │    │ KG Service       │    │ Extractors │    │ Neo4j   │
│ Queue     │    │               │    │                  │    │            │    │         │
└─────┬─────┘    └───────┬───────┘    └────────┬─────────┘    └──────┬─────┘    └────┬────┘
      │                  │                     │                     │               │
      │ 1. Dequeue job   │                     │                     │               │
      │─────────────────>│                     │                     │               │
      │                  │                     │                     │               │
      │                  │ 2. Resolve config   │                     │               │
      │                  │────────────────────>│                     │               │
      │                  │   (per-index LLM config)                  │               │
      │                  │<────────────────────│                     │               │
      │                  │                     │                     │               │
      │                  │ 3. initialize()     │                     │               │
      │                  │────────────────────>│                     │               │
      │                  │                     │ 4. connect()        │               │
      │                  │                     │─────────────────────────────────────>│
      │                  │                     │<─────────────────────────────────────│
      │                  │<────────────────────│                     │               │
      │                  │                     │                     │               │
      │                  │ 5. Load chunks (MongoDB)                  │               │
      │                  │                     │                     │               │
      │                  │ 6. batchProcess()   │                     │               │
      │                  │────────────────────>│                     │               │
      │                  │                     │                     │               │
      │                  │                     │ 7. For each chunk:  │               │
      │                  │                     │─────────────────────>               │
      │                  │                     │    extract(text)                    │
      │                  │                     │<─────────────────────               │
      │                  │                     │  entities[], references[]           │
      │                  │                     │                     │               │
      │                  │                     │ 8. upsertEntities() │               │
      │                  │                     │─────────────────────────────────────>│
      │                  │                     │   MERGE entities                    │
      │                  │                     │<─────────────────────────────────────│
      │                  │                     │   entityIdMap                       │
      │                  │                     │                     │               │
      │                  │                     │ 9. Create REFERENCES edges          │
      │                  │                     │─────────────────────────────────────>│
      │                  │                     │<─────────────────────────────────────│
      │                  │                     │                     │               │
      │                  │                     │ 10. calculateIDF()  │               │
      │                  │                     │────────────────────>│               │
      │                  │                     │<────────────────────│               │
      │                  │                     │                     │               │
      │                  │                     │ 11. calculateWeights()              │
      │                  │                     │────────────────────>│               │
      │                  │                     │<────────────────────│               │
      │                  │                     │   CoOccurrence[]                    │
      │                  │                     │                     │               │
      │                  │                     │ 12. Create CO_OCCURS edges          │
      │                  │                     │─────────────────────────────────────>│
      │                  │                     │<─────────────────────────────────────│
      │                  │                     │                     │               │
      │                  │                     │ 13. batchUpdateIDF()                │
      │                  │                     │─────────────────────────────────────>│
      │                  │                     │<─────────────────────────────────────│
      │                  │<────────────────────│                     │               │
      │                  │   results[]         │                     │               │
      │                  │                     │                     │               │
      │                  │ 14. Update chunk metadata (MongoDB)       │               │
      │                  │                     │                     │               │
      │                  │ 15. Update document metadata (MongoDB)    │               │
      │                  │                     │                     │               │
      │ 16. Job complete │                     │                     │               │
      │<─────────────────│                     │                     │               │
```

---

### Code Walkthrough: Worker Entry Point

**File:** `apps/search-ai/src/workers/knowledge-graph-worker.ts:35-169`

```typescript
async function processKnowledgeGraphJob(job: Job<KnowledgeGraphJobData>): Promise<void> {
  const { indexId, documentId, chunkIds, tenantId } = job.data;

  // 1. Resolve per-index configuration
  //    - llmConfig.useCases.knowledgeGraph.enabled (boolean)
  //    - llmConfig.useCases.knowledgeGraph.enableCoOccurrence (boolean)
  const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);

  // 2. Check if knowledge graph is enabled for this index
  if (!llmConfig.useCases.knowledgeGraph.enabled) {
    workerLog('knowledge-graph', `Knowledge graph disabled for index ${indexId}, skipping`);
    return; // Early exit
  }

  // 3. Merge per-index config with global infrastructure config
  const globalConfig = getConfig();
  const service = new KnowledgeGraphService({
    ...globalConfig.knowledgeGraph, // Neo4j URI, credentials, pool size
    enableCoOccurrence: llmConfig.useCases.knowledgeGraph.enableCoOccurrence,
  });
  await service.initialize(); // Connect to Neo4j, create constraints/indexes

  // 4. Load chunks from MongoDB within tenant context
  await withTenantContext({ tenantId }, async () => {
    const chunks = await SearchChunk.find({
      _id: { $in: chunkIds },
      documentId,
      tenantId, // ← Tenant isolation at DB query level
      indexId,
    }).lean();

    // 5. Batch process all chunks (entities + co-occurrence)
    const results = await service.batchProcess({
      chunks: chunks.map((chunk) => ({
        tenantId,
        indexId,
        documentId,
        chunkId: chunk._id.toString(),
        text: chunk.content,
        timestamp: chunk.createdAt,
      })),
      enableCoOccurrence: globalConfig.knowledgeGraph.enableCoOccurrence,
      minIdfThreshold: globalConfig.knowledgeGraph.minIdfThreshold,
    });

    // 6. Update MongoDB with extracted metadata
    for (let i = 0; i < chunks.length; i++) {
      await SearchChunk.findByIdAndUpdate(chunks[i]._id, {
        $set: {
          'metadata.entities': results[i].entities,
          'metadata.references': results[i].references,
          'metadata.entityIds': results[i].entityIds,
        },
      });
    }

    // 7. Update document-level stats
    await SearchDocument.findByIdAndUpdate(documentId, {
      $set: {
        'metadata.knowledgeGraph': {
          totalEntities: results.reduce((sum, r) => sum + r.entities.length, 0),
          totalReferences: results.reduce((sum, r) => sum + r.references.length, 0),
          totalRelationships: results.reduce((sum, r) => sum + r.relationshipCount, 0),
          processedAt: new Date(),
        },
      },
    });
  });
}
```

**Key Observations:**

1. **Configuration layering:** Global infrastructure (Neo4j connection) + per-index features (enabled, co-occurrence).
2. **Early exit:** If knowledge graph disabled for index, skip processing entirely (no wasted Neo4j connections).
3. **Tenant context:** All MongoDB queries include `tenantId` filter (enforced by `withTenantContext`).
4. **Batch processing:** All chunks processed together for correct IDF calculation.
5. **Metadata propagation:** Entities stored on chunks (for immediate access), stats stored on document (for dashboards).

---

### Code Walkthrough: Batch Processing

**File:** `apps/search-ai/src/services/knowledge-graph/index.ts:207-287`

```typescript
async batchProcess(options: BatchProcessOptions): Promise<KnowledgeGraphResult[]> {
  const { chunks, enableCoOccurrence, minIdfThreshold } = options;

  // 1. Reset co-occurrence analyzer (stateful, one batch at a time)
  this.coOccurrenceAnalyzer.reset();

  // 2. Process each chunk: extract entities/references, upsert to Neo4j
  const results: KnowledgeGraphResult[] = [];
  for (const chunk of chunks) {
    const result = await this.processChunk(chunk); // Entities + REFERENCES edges
    results.push(result);

    // 3. Update co-occurrence analyzer with entities from this chunk
    if (enableCoOccurrence) {
      this.coOccurrenceAnalyzer.updateEntityStats(
        chunk.chunkId,
        result.entities.map((e) => ({ text: e.text, type: e.type })),
      );
    }
  }

  // 4. Calculate IDF and co-occurrence weights across all chunks
  if (enableCoOccurrence && chunks.length > 0) {
    this.coOccurrenceAnalyzer.calculateWeights(); // IDF + weight calculation

    const coOccurrences = this.coOccurrenceAnalyzer
      .getCoOccurrencesAboveThreshold(minIdfThreshold);

    // 5. Create CO_OCCURS edges in Neo4j
    const { tenantId, indexId } = chunks[0];
    for (const coOcc of coOccurrences) {
      const entity1 = await this.neo4jClient.findEntityByText(tenantId, indexId, coOcc.entity1);
      const entity2 = await this.neo4jClient.findEntityByText(tenantId, indexId, coOcc.entity2);

      if (entity1 && entity2) {
        await this.neo4jClient.upsertRelationship({
          fromEntityId: entity1.id,
          toEntityId: entity2.id,
          type: 'CO_OCCURS',
          tenantId,
          indexId,
          weight: coOcc.weight, // IDF-weighted
          count: coOcc.frequency,
          metadata: {
            frequency: coOcc.frequency,
            chunkIds: coOcc.chunkIds,
            entity1Idf: entity1.idf,
            entity2Idf: entity2.idf,
          },
        });
      }
    }

    // 6. Update IDF scores for all entities in Neo4j
    const idfScores = new Map<string, number>();
    const entityStats = this.coOccurrenceAnalyzer.getAllEntityStats('idf');
    for (const stats of entityStats) {
      idfScores.set(stats.text, stats.idf);
    }
    await this.neo4jClient.batchUpdateIDF(tenantId, indexId, idfScores);
  }

  return results;
}
```

**Key Observations:**

1. **Stateful analyzer:** `CoOccurrenceAnalyzer` accumulates entity stats across chunks, then calculates IDF in one pass.
2. **Two-phase edge creation:** REFERENCES edges created per-chunk (explicit), CO_OCCURS edges created after batch (calculated).
3. **Threshold filtering:** Only co-occurrences above `minIdfThreshold` become graph edges (reduces graph density).
4. **Bulk IDF update:** Single Neo4j transaction to update IDF scores for all entities (efficient).

---

### Code Walkthrough: Entity Extraction (Hybrid Mode)

**File:** `apps/search-ai/src/services/knowledge-graph/entity-extractor.ts:238-271`

```typescript
private extractHybrid(text: string): ExtractedEntity[] {
  // 1. Extract with both methods
  const regexEntities = this.extractRegex(text);      // Emails, URLs, dates, money, phone
  const compromiseEntities = this.extractCompromise(text); // People, orgs, locations

  // 2. Start with regex results (100% precision)
  const merged = [...regexEntities];

  // 3. Build deduplication sets
  const seen = new Set(
    regexEntities.map((e) => `${e.type}:${e.start}:${e.end}:${e.text.toLowerCase()}`)
  );
  const textBasedSeen = new Set(
    regexEntities.map((e) => `${e.type}:${e.text.toLowerCase()}`)
  );

  // 4. Add compromise entities if not duplicates
  for (const entity of compromiseEntities) {
    const key = `${entity.type}:${entity.start}:${entity.end}:${entity.text.toLowerCase()}`;
    const textKey = `${entity.type}:${entity.text.toLowerCase()}`;

    // Check for position overlap with existing entities
    const hasOverlap = merged.some(
      (existing) =>
        existing.start <= entity.end &&
        existing.end >= entity.start &&
        this.calculateOverlap(existing, entity) > 0.9
    );

    // Skip if duplicate (position-based, text-based, or overlap-based)
    if (!seen.has(key) && !textBasedSeen.has(textKey) && !hasOverlap) {
      seen.add(key);
      textBasedSeen.add(textKey);
      merged.push({ ...entity, method: 'hybrid' });
    }
  }

  return merged.sort((a, b) => a.start - b.start);
}
```

**Deduplication Strategy:**

1. **Position-based:** Same text at same position → duplicate
2. **Text-based:** Same entity text (case-insensitive) → duplicate (prevents "Microsoft" at positions 10 and 200 from being added twice)
3. **Overlap-based:** >90% character overlap → duplicate (prevents "Dr. Smith" and "Smith" from both being kept)

**Why this matters:**

- Compromise might extract "john@example.com" as PERSON (incorrect).
- Regex extracts "john@example.com" as EMAIL (correct).
- Hybrid deduplication keeps regex result, discards compromise result.

---

### Code Walkthrough: Neo4j Upsert with Tenant Isolation

**File:** `apps/search-ai/src/services/knowledge-graph/neo4j-client.ts:173-210`

```typescript
async upsertEntity(entity: Omit<EntityNode, 'id' | 'occurrenceCount'>): Promise<string> {
  const session = this.getSession();

  try {
    const result = await session.run(
      `
      MERGE (e:Entity {
        tenantId: $tenantId,
        indexId: $indexId,
        type: $type,
        text: $text
      })
      ON CREATE SET
        e.id = randomUUID(),
        e.documentId = $documentId,
        e.chunkId = $chunkId,
        e.firstSeenAt = datetime($firstSeenAt),
        e.lastSeenAt = datetime($lastSeenAt),
        e.occurrenceCount = 1,
        e.idf = $idf
      ON MATCH SET
        e.lastSeenAt = datetime($lastSeenAt),
        e.occurrenceCount = e.occurrenceCount + 1,
        e.idf = COALESCE($idf, e.idf)
      RETURN e.id AS id
      `,
      {
        tenantId: entity.tenantId,
        indexId: entity.indexId,
        type: entity.type,
        text: entity.text,
        documentId: entity.documentId,
        chunkId: entity.chunkId,
        firstSeenAt: entity.firstSeenAt.toISOString(),
        lastSeenAt: entity.lastSeenAt.toISOString(),
        idf: entity.idf ?? null,
      },
    );

    return result.records[0].get('id');
  } finally {
    await session.close();
  }
}
```

**Tenant Isolation Enforcement:**

1. **MERGE key includes tenantId:** `MERGE (e:Entity { tenantId: $tenantId, indexId: $indexId, type: $type, text: $text })`
2. **Unique constraint** on `(tenantId, indexId, type, text)` prevents cross-tenant matches.
3. **No possibility of cross-tenant entity merging:** Two tenants with entity "Microsoft" will create separate nodes.

**Idempotency:**

- `ON CREATE SET`: First time entity is seen → initialize all fields.
- `ON MATCH SET`: Entity already exists → increment `occurrenceCount`, update `lastSeenAt`.
- Safe to replay: Running the same upsert twice won't create duplicates.

---

### Error Handling & Recovery

**Worker-level error handling:**

```typescript
try {
  // Process knowledge graph
  await service.batchProcess({ ... });
} catch (error) {
  // 1. Update document status to ERROR
  await SearchDocument.findByIdAndUpdate(documentId, {
    status: DocumentStatus.ERROR,
    processingError: `Knowledge graph extraction failed: ${error.message}`,
  });

  // 2. Throw error (BullMQ will retry per queue config)
  throw error;
}
```

**Retry strategy (configured in BullMQ):**

```typescript
// Default retry config
{
  attempts: 3,               // Retry up to 3 times
  backoff: {
    type: 'exponential',
    delay: 1000,             // 1s, 2s, 4s backoff
  },
}
```

**Neo4j connection errors:**

- If Neo4j is down, `neo4jClient.connect()` throws → worker fails → retries after backoff.
- If connection pool exhausted, queries queue (not fail) → eventual consistency.

**Partial failures:**

- If entity extraction succeeds but Neo4j upsert fails → document marked ERROR, chunk metadata still contains entities (partial success).
- If co-occurrence calculation fails → REFERENCES edges still created (graceful degradation).

---

## Entity Extraction

### Entity Types Supported

| Type           | Description               | Extraction Method  | Examples                         |
| -------------- | ------------------------- | ------------------ | -------------------------------- |
| `PERSON`       | People names              | Compromise NLP     | "John Smith", "Dr. Jane Doe"     |
| `ORGANIZATION` | Companies, institutions   | Compromise NLP     | "Microsoft", "MIT", "FDA"        |
| `LOCATION`     | Places, cities, countries | Compromise NLP     | "San Francisco", "United States" |
| `DATE`         | Dates, timestamps         | Regex + Compromise | "2024-03-15", "March 20, 2024"   |
| `MONEY`        | Currency amounts          | Regex              | "$1,234.56", "€500.00", "£1,000" |
| `EMAIL`        | Email addresses           | Regex              | "john@example.com"               |
| `URL`          | Web URLs                  | Regex              | "https://example.com/page"       |
| `PHONE`        | Phone numbers             | Regex              | "(555) 123-4567", "555-987-6543" |
| `PRODUCT`      | Product names             | Compromise NLP     | Product mentions                 |
| `EVENT`        | Events                    | Compromise NLP     | "2024 Conference"                |
| `OTHER`        | Unclassified              | Fallback           | Miscellaneous entities           |

### Extraction Methods

#### 1. Regex Extraction (`entityExtractionMethod: 'regex'`)

**Pros:**

- Fast (~0.1ms per chunk)
- Deterministic (confidence = 1.0)
- No dependencies (pure JavaScript)
- Excellent for structured entities (email, URL, date, money, phone)

**Cons:**

- Misses semantic entities (people, organizations, locations)
- No context understanding
- Pattern-based only

**Use When:**

- Documents have mostly structured entities (forms, contracts, invoices)
- Need high precision for specific entity types
- Cost/performance is critical

#### 2. Compromise NLP (`entityExtractionMethod: 'compromise'`)

**Pros:**

- Extracts semantic entities (people, organizations, locations)
- Context-aware (understands "Dr. Smith" vs "Smith Street")
- Lightweight NLP library (no external API calls)
- ~80-90% accuracy on English text

**Cons:**

- Slower (~2-5ms per chunk)
- Lower confidence for ambiguous names
- English-focused (limited multilingual support)
- Misses structured entities (emails, URLs)

**Use When:**

- Documents contain many people/organization names
- Need cross-document person/company linking
- Acceptable to miss some structured entities

#### 3. Hybrid Extraction (`entityExtractionMethod: 'hybrid'`) **[RECOMMENDED]**

**Pros:**

- Best of both worlds: structured (regex) + semantic (Compromise)
- Automatic deduplication (text + position-based)
- High recall (~95% entity coverage)
- Production-ready (~3-6ms per chunk)

**Cons:**

- Slightly slower than individual methods
- May extract duplicates if not properly deduplicated

**Use When:**

- Need comprehensive entity extraction
- Documents mix structured and unstructured content
- Production use (recommended default)

### Extraction Algorithm (Hybrid)

```typescript
// 1. Extract with regex (structured entities)
const regexEntities = extractRegex(text);
// Returns: emails, URLs, dates, money, phone numbers

// 2. Extract with Compromise (semantic entities)
const compromiseEntities = extractCompromise(text);
// Returns: people, organizations, locations, dates, money

// 3. Merge and deduplicate
const merged = [...regexEntities];
const seen = new Set();

for (const entity of compromiseEntities) {
  // Skip if exact match (position + text)
  const key = `${entity.type}:${entity.start}:${entity.end}:${entity.text.toLowerCase()}`;
  if (seen.has(key)) continue;

  // Skip if text-based duplicate (same entity, different position)
  const textKey = `${entity.type}:${entity.text.toLowerCase()}`;
  if (textBasedSeen.has(textKey)) continue;

  // Skip if >90% overlap with existing entity
  const hasOverlap = merged.some((existing) => calculateOverlap(existing, entity) > 0.9);
  if (hasOverlap) continue;

  merged.push(entity);
}

return merged.sort((a, b) => a.start - b.start);
```

### Entity Confidence Scores

| Method                        | Confidence      | Meaning                                 |
| ----------------------------- | --------------- | --------------------------------------- |
| Regex                         | 1.0             | Deterministic pattern match             |
| Compromise NLP - Email/URL    | 0.9             | High confidence (also regex detectable) |
| Compromise NLP - Money        | 0.85            | High confidence (numeric pattern)       |
| Compromise NLP - Person       | 0.8             | Good confidence (proper noun)           |
| Compromise NLP - Location     | 0.75            | Moderate (can be ambiguous)             |
| Compromise NLP - Organization | 0.7             | Moderate (can be common words)          |
| Hybrid                        | Method-specific | Inherits from extraction method         |

Lower confidence doesn't mean incorrect — it reflects extraction certainty, not accuracy.

---

## Reference Extraction

References are explicit mentions of other documents, sections, or exhibits. Unlike entities (which can be implicit), references use specific patterns like "See Contract #123" or "Exhibit A".

### Reference Types Supported

| Type         | Pattern Examples                           | Cross-Document?    |
| ------------ | ------------------------------------------ | ------------------ |
| `CONTRACT`   | "Contract #45821", "Agreement No. ABC-123" | ✅ Yes             |
| `EXHIBIT`    | "Exhibit A", "Exhibit B-1", "Ex. 5"        | ✅ Yes             |
| `APPENDIX`   | "Appendix A", "Appendix 1", "App. B"       | ✅ Yes             |
| `SECTION`    | "Section 3.2", "§ 5.1.3", "Sec. 14"        | ❌ No (within-doc) |
| `CLAUSE`     | "Clause 14", "Clause 5(b)", "Cl. 3"        | ❌ No              |
| `PARAGRAPH`  | "Paragraph 5", "Para. 3.2"                 | ❌ No              |
| `ARTICLE`    | "Article 3", "Article IV", "Art. 2"        | ❌ No              |
| `FIGURE`     | "Figure 5", "Fig. 3.2"                     | ❌ No              |
| `TABLE`      | "Table 3", "Table A-1", "Tbl. 5"           | ❌ No              |
| `SCHEDULE`   | "Schedule A", "Schedule 1", "Sch. B"       | ✅ Yes             |
| `ANNEX`      | "Annex A", "Annex 1"                       | ✅ Yes             |
| `ATTACHMENT` | "Attachment A", "Attachment 1"             | ✅ Yes             |
| `DOCUMENT`   | "Document #123", "Doc. No. 456"            | ✅ Yes             |

### Cross-Document References

References marked "Cross-Document: Yes" typically point to **other documents** and create valuable graph links. For example:

```
Document A: "See Contract #45821, Exhibit B for pricing details."
                    ↓               ↓
          REFERENCES edges in Neo4j
                    ↓               ↓
Document B (Contract #45821) + Document C (Exhibit B)
```

### Extraction Algorithm

```typescript
// Regex patterns for all reference types
const REFERENCE_PATTERNS = [
  {
    pattern: /\b(?:Contract|Agreement)\s+(?:No\.?|#|Number)\s*([A-Z0-9-]+)\b/gi,
    type: 'CONTRACT',
    extractId: (match) => match[1], // "45821" from "Contract #45821"
  },
  {
    pattern: /\b(?:Exhibit|Ex\.)\s+([A-Z0-9-]+)\b/gi,
    type: 'EXHIBIT',
    extractId: (match) => match[1], // "A" from "Exhibit A"
  },
  // ... more patterns
];

// Extract all references
for (const { pattern, type, extractId } of REFERENCE_PATTERNS) {
  let match;
  while ((match = pattern.exec(text)) !== null) {
    references.push({
      text: match[0], // "Contract #45821"
      type, // 'CONTRACT'
      identifier: extractId(match), // "45821"
      start: match.index,
      end: match.index + match[0].length,
      normalized: text.trim().toLowerCase(),
    });
  }
}
```

### Reference → Entity Linking

When a reference is extracted, the system attempts to link it to an existing entity in Neo4j:

```typescript
// 1. Extract reference: "See Contract #45821"
const reference = {
  text: 'Contract #45821',
  type: 'CONTRACT',
  identifier: '45821',
};

// 2. Find matching entity in current chunk
const matchingEntity = entities.find((e) => e.text.toLowerCase() === reference.text.toLowerCase());

if (matchingEntity) {
  // 3. Find target entity in Neo4j (may be in another document)
  const targetEntity = await neo4jClient.findEntityByText(tenantId, indexId, reference.text);

  if (targetEntity) {
    // 4. Create REFERENCES relationship
    await neo4jClient.upsertRelationship({
      fromEntityId: matchingEntity.id,
      toEntityId: targetEntity.id,
      type: 'REFERENCES',
      tenantId,
      indexId,
      weight: 1.0,
      count: 1,
      metadata: {
        referenceType: reference.type, // 'CONTRACT'
        identifier: reference.identifier, // '45821'
      },
    });
  }
}
```

This creates a directed edge in the graph: `Entity(in Doc A) -[REFERENCES]-> Entity(in Doc B)`

---

## Co-Occurrence Analysis

Co-occurrence analysis finds entities that appear together frequently and assigns them weighted relationships based on **Inverse Document Frequency (IDF)**.

### Why IDF Weighting?

Simple frequency counting is misleading:

- "Microsoft and the" co-occur 1000 times → not meaningful (common words)
- "Microsoft and OpenAI" co-occur 10 times → meaningful (both rare)

**IDF solution:** Weight co-occurrences by entity rarity:

```
IDF(entity) = log((N + 1) / (df + 1))
  where N = total chunks, df = chunks containing entity

Weight(entity1, entity2) = max(IDF(entity1), IDF(entity2)) × frequency
```

**Why max() instead of average?**

A rare entity co-occurring with a common one is still notable. Example:

- "Satya Nadella and Microsoft" → max(IDF(Satya), IDF(Microsoft)) × frequency
- Even if "Microsoft" is common (low IDF), "Satya Nadella" is rare (high IDF)
- The relationship is weighted by the rarer entity

### Co-Occurrence Algorithm

```typescript
// 1. Process all chunks in a document batch
for (const chunk of chunks) {
  // Extract entities per chunk
  const entities = extractEntities(chunk.text);

  // Update entity statistics
  coOccurrenceAnalyzer.updateEntityStats(chunk.id, entities);
  // Tracks: documentFrequency, totalOccurrences per entity
}

// 2. Calculate IDF scores for all entities
coOccurrenceAnalyzer.calculateIDF();
// IDF = log((totalChunks + 1) / (documentFrequency + 1))

// 3. Calculate co-occurrence weights
coOccurrenceAnalyzer.calculateWeights();
// For each entity pair that co-occurs:
//   weight = max(idf1, idf2) × frequency

// 4. Filter by minimum IDF threshold (default: 1.5)
const significantCoOccurrences =
  coOccurrenceAnalyzer.getCoOccurrencesAboveThreshold(minIdfThreshold);

// 5. Create CO_OCCURS relationships in Neo4j
for (const coOcc of significantCoOccurrences) {
  await neo4jClient.upsertRelationship({
    fromEntityId: entity1.id,
    toEntityId: entity2.id,
    type: 'CO_OCCURS',
    tenantId,
    indexId,
    weight: coOcc.weight, // IDF-weighted
    count: coOcc.frequency,
    metadata: {
      frequency: coOcc.frequency,
      chunkIds: coOcc.chunkIds,
      entity1Idf: entity1.idf,
      entity2Idf: entity2.idf,
    },
  });
}
```

### IDF Threshold Tuning

**`minIdfThreshold`** controls which co-occurrences become graph edges:

| Threshold  | Effect                                        | Use Case                          |
| ---------- | --------------------------------------------- | --------------------------------- |
| **0.0**    | All co-occurrences (includes common entities) | Dense graph, exploratory analysis |
| **1.0**    | Moderate filtering                            | Balanced precision/recall         |
| **1.5** ⭐ | Recommended default                           | Production use                    |
| **2.0**    | Aggressive filtering                          | High precision, sparse graph      |
| **3.0+**   | Only extremely rare entity pairs              | Very sparse, niche analysis       |

**Calculation Example:**

```
Scenario: 1000 chunks total

Entity A appears in 10 chunks:
  IDF(A) = log((1000 + 1) / (10 + 1)) = log(91) ≈ 4.51

Entity B appears in 500 chunks (common):
  IDF(B) = log((1000 + 1) / (500 + 1)) = log(2) ≈ 0.69

Co-occurrence weight = max(4.51, 0.69) × frequency
                     = 4.51 × 5 (they co-occur 5 times)
                     = 22.55

Since 22.55 > minIdfThreshold (1.5), this co-occurrence is stored.
```

### Co-Occurrence Metadata

Each `CO_OCCURS` relationship stores:

```typescript
{
  fromEntityId: 'uuid-1',
  toEntityId: 'uuid-2',
  type: 'CO_OCCURS',
  weight: 22.55,           // IDF-weighted strength
  count: 5,                // Raw frequency (appeared together 5 times)
  metadata: {
    frequency: 5,
    chunkIds: ['chunk1', 'chunk2', 'chunk3', 'chunk4', 'chunk5'],
    entity1Idf: 4.51,
    entity2Idf: 0.69,
  },
}
```

This enables queries like:

- "Which entities co-occur most strongly with X?" (order by weight)
- "How many times did X and Y appear together?" (count)
- "In which chunks did X and Y co-occur?" (metadata.chunkIds)

---

## Neo4j Graph Storage

### Node Schema: Entity

```cypher
CREATE (e:Entity {
  id: 'uuid-generated-by-neo4j',        // Unique entity ID
  text: 'Microsoft',                     // Entity text (normalized)
  type: 'ORGANIZATION',                  // Entity type
  tenantId: 'tenant-123',                // Tenant isolation
  indexId: 'index-456',                  // Index scope
  documentId: 'doc-789',                 // Document where first seen
  chunkId: 'chunk-abc',                  // Chunk where first seen
  firstSeenAt: datetime('2024-03-15T10:00:00Z'),
  lastSeenAt: datetime('2024-03-20T15:30:00Z'),
  occurrenceCount: 42,                   // Total mentions across all chunks
  idf: 2.31                              // Inverse Document Frequency score
})
```

**Uniqueness Constraint:**

```cypher
CREATE CONSTRAINT entity_unique IF NOT EXISTS
FOR (e:Entity)
REQUIRE (e.tenantId, e.indexId, e.type, e.text) IS UNIQUE
```

This ensures:

- Same entity text = same node (deduplication)
- "Microsoft" as ORGANIZATION ≠ "Microsoft" as PRODUCT (different types)
- Tenant isolation enforced at constraint level

### Relationship Schemas

#### 1. REFERENCES (Explicit)

```cypher
(fromEntity:Entity)-[:REFERENCES {
  tenantId: 'tenant-123',
  indexId: 'index-456',
  weight: 1.0,                           // Always 1.0 for explicit references
  count: 3,                              // Number of times referenced
  metadata: {
    referenceType: 'CONTRACT',           // CONTRACT, EXHIBIT, etc.
    identifier: '45821'                  // Extracted identifier
  }
}]->(toEntity:Entity)
```

**Meaning:** "fromEntity explicitly references toEntity"

Example: Document A mentions "See Contract #45821" → creates edge from Entity(Contract #45821 in Doc A) to Entity(Contract #45821 in Doc B)

#### 2. CO_OCCURS (Implicit)

```cypher
(entity1:Entity)-[:CO_OCCURS {
  tenantId: 'tenant-123',
  indexId: 'index-456',
  weight: 22.55,                         // IDF-weighted strength
  count: 5,                              // Raw frequency
  metadata: {
    frequency: 5,
    chunkIds: ['chunk1', 'chunk2', ...],
    entity1Idf: 4.51,
    entity2Idf: 0.69
  }
}]->(entity2:Entity)
```

**Meaning:** "entity1 and entity2 appear together frequently across multiple chunks"

Example: "Microsoft" and "OpenAI" co-occur in 5 chunks → weighted by max(IDF(Microsoft), IDF(OpenAI)) × 5

### Indexes for Performance

```cypher
-- Fast lookup by entity ID
CREATE INDEX entity_id_idx IF NOT EXISTS
FOR (e:Entity) ON (e.id)

-- Tenant isolation queries
CREATE INDEX entity_tenant_idx IF NOT EXISTS
FOR (e:Entity) ON (e.tenantId, e.indexId)

-- Entity type filtering
CREATE INDEX entity_type_idx IF NOT EXISTS
FOR (e:Entity) ON (e.type)
```

### Tenant Isolation Enforcement

**All queries include tenantId + indexId filters:**

```cypher
// ❌ BAD: No tenant filter (leaks data across tenants)
MATCH (e:Entity {text: 'Microsoft'})
RETURN e

// ✅ GOOD: Tenant + index scoped
MATCH (e:Entity {
  text: 'Microsoft',
  tenantId: $tenantId,
  indexId: $indexId
})
RETURN e
```

**Relationships also enforce tenant isolation:**

```cypher
// ✅ Relationship query with tenant filter
MATCH (e:Entity {id: $entityId, tenantId: $tenantId, indexId: $indexId})
      -[r {tenantId: $tenantId, indexId: $indexId}]->
      (related:Entity)
RETURN related
```

This prevents cross-tenant graph traversal even if relationship IDs are guessed.

---

## Integration with Platform

This section explains how the knowledge graph feature integrates with the broader Search AI platform.

### Worker Pipeline Integration

The knowledge graph worker runs in **Stage 6** of the document processing pipeline:

```
Stage 1: Document Upload (document-upload.ts route)
   ↓
Stage 2: Docling Extraction (docling-extraction-worker)
   ↓
Stage 3: Page Processing / Chunking (page-processing-worker)
   ↓
Stage 4: Auto-Mapping (auto-mapping-worker) [for structured data]
   ↓
Stage 5: Enrichment (enrichment-worker) — progressive summarization, Q&A synthesis
   ↓
┌─────────────────────────────────────────────────────────────┐
│ Stage 6: Parallel Processing (both workers run concurrently)│
│  ┌─────────────────────────────┐  ┌────────────────────────┐│
│  │ knowledge-graph-worker      │  │ embedding-worker       ││
│  │ - Entity extraction         │  │ - Generate embeddings  ││
│  │ - Co-occurrence analysis    │  │ - Store in OpenSearch  ││
│  │ - Neo4j storage             │  │                        ││
│  └─────────────────────────────┘  └────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
   ↓
Stage 7: Indexing Complete (document status = INDEXED)
```

**BullMQ Job Flow:**

```typescript
// After enrichment completes, enrichment-worker dispatches TWO jobs:

// Job 1: Knowledge graph (if enabled for index)
if (llmConfig.useCases.knowledgeGraph.enabled) {
  await knowledgeGraphQueue.add('extract-kg', {
    tenantId,
    indexId,
    documentId,
    chunkIds: allChunkIds,
  });
}

// Job 2: Embedding (always)
await embeddingQueue.add('generate-embeddings', {
  tenantId,
  indexId,
  documentId,
  chunkIds: allChunkIds,
});

// Both jobs run in parallel, no dependency between them
```

**Why parallel processing?**

- **No data dependency:** Embeddings don't need entity extraction results, and vice versa.
- **Throughput optimization:** Processing 1000 chunks takes ~60 seconds for KG + ~120 seconds for embeddings. Parallel = 120s total (vs 180s sequential).
- **Failure isolation:** If knowledge graph fails, embedding still succeeds → document is searchable.

---

### Configuration Resolution

Knowledge graph configuration is resolved in **layers**:

```typescript
// Layer 1: Global infrastructure config (search-ai/config)
const globalConfig = {
  knowledgeGraph: {
    enabled: true, // Feature flag (infra-level)
    uri: 'neo4j://localhost:7687',
    username: 'neo4j',
    password: '***',
    neo4jMaxPoolSize: 100,
    entityExtractionMethod: 'hybrid', // Default extraction method
    enableCoOccurrence: true, // Default co-occurrence flag
    minIdfThreshold: 1.5, // Default threshold
  },
};

// Layer 2: Per-index LLM config (MongoDB: SearchIndex.llmConfig)
const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);
//  llmConfig.useCases.knowledgeGraph = {
//    enabled: true,                         // Can override per index
//    enableCoOccurrence: false,             // Can disable co-occurrence per index
//  }

// Layer 3: Merged config (used by service)
const finalConfig = {
  ...globalConfig.knowledgeGraph,
  enableCoOccurrence: llmConfig.useCases.knowledgeGraph.enableCoOccurrence,
};
```

**Configuration hierarchy:**

1. **Global config** — Infrastructure settings (Neo4j connection, pool size, extraction method).
2. **Per-index config** — Feature flags (`enabled`, `enableCoOccurrence`) can be toggled per index.
3. **Runtime resolution** — Worker merges both configs before processing.

**Example use case:**

```typescript
// Enable KG for legal documents index (high entity density)
await SearchIndex.findByIdAndUpdate(legalIndexId, {
  'llmConfig.useCases.knowledgeGraph.enabled': true,
  'llmConfig.useCases.knowledgeGraph.enableCoOccurrence': true,
});

// Disable KG for chat messages index (low entity value)
await SearchIndex.findByIdAndUpdate(chatIndexId, {
  'llmConfig.useCases.knowledgeGraph.enabled': false,
});
```

---

### Tenant Context Propagation

Tenant context flows through the entire pipeline:

```
1. REST API Request
   ↓
   Authorization middleware extracts tenantId from JWT
   ↓
2. Document Upload
   ↓
   SearchDocument created with tenantId field
   ↓
3. BullMQ Job Data
   ↓
   KnowledgeGraphJobData includes tenantId
   ↓
4. Worker Processing
   ↓
   withTenantContext({ tenantId }, async () => {
     // All MongoDB queries scoped to tenant
     // All Neo4j queries include tenantId filter
   })
   ↓
5. Neo4j Nodes/Edges
   ↓
   All entities have tenantId property
   All relationships have tenantId property
```

**Enforcement points:**

- **MongoDB:** `withTenantContext()` sets tenant filter on all queries.
- **Neo4j:** Every `MERGE`/`MATCH` query includes `tenantId: $tenantId` filter.
- **Unique constraints:** `(tenantId, indexId, type, text)` prevents cross-tenant entity merging.

---

### Data Model Integration

Knowledge graph metadata is stored at **two levels**:

**1. Chunk-level metadata (SearchChunk.metadata):**

```typescript
{
  entities: [
    { text: 'Microsoft', type: 'ORGANIZATION', start: 10, end: 19, confidence: 0.8 },
    { text: 'john@example.com', type: 'EMAIL', start: 45, end: 62, confidence: 1.0 },
  ],
  references: [
    { text: 'Contract #45821', type: 'CONTRACT', identifier: '45821' },
  ],
  entityIds: ['neo4j-uuid-1', 'neo4j-uuid-2'], // Neo4j node IDs
}
```

**Use:** Quick entity lookup without Neo4j query (e.g., display entities in search results).

**2. Document-level metadata (SearchDocument.metadata.knowledgeGraph):**

```typescript
{
  totalEntities: 142,
  totalReferences: 23,
  totalRelationships: 89,
  processedAt: '2026-02-24T10:30:00Z',
}
```

**Use:** Document processing status, analytics dashboards.

**3. Neo4j graph (Entity nodes + relationships):**

- **Cross-document queries:** Find all documents mentioning Entity X.
- **Relationship traversal:** Find entities 2 hops away from Entity Y.
- **Graph analytics:** Entity importance (IDF), relationship clustering.

---

### Service Dependencies

The knowledge graph feature depends on:

| Service/Component       | Dependency Type     | Purpose                            |
| ----------------------- | ------------------- | ---------------------------------- |
| **Neo4j**               | External (TCP)      | Graph storage and querying         |
| **MongoDB**             | External (TCP)      | Chunk/document metadata storage    |
| **Redis**               | External (TCP)      | BullMQ job queue                   |
| **LLM Config Resolver** | Internal (function) | Per-index configuration resolution |
| **compromise NLP**      | Dependency (npm)    | Entity extraction (semantic)       |
| **BullMQ**              | Dependency (npm)    | Job queue and worker orchestration |

**Startup dependencies:**

```typescript
// Server startup sequence (apps/search-ai/src/server.ts)
1. await connectMongoDB()              // Required for all operations
2. await connectRedis()                // Required for BullMQ
3. await connectNeo4j()                // Optional (only if KG enabled)
4. startWorkers()                      // Includes knowledge-graph-worker
   ↓
   knowledge-graph-worker.initialize() → neo4jClient.connect()
```

**Graceful degradation:**

- If Neo4j is down at startup → worker initialization fails → worker not started → KG jobs remain queued.
- If Neo4j goes down during processing → job fails → retries after backoff → eventually moves to DLQ (dead letter queue).

---

### API Integration (Future)

**Current state:** Knowledge graph is a **backend-only feature**. No REST API endpoints yet.

**Planned REST API endpoints** (see "What's Next?" section):

```
GET /api/search-ai/:indexId/knowledge-graph/entities/:entityText/related
GET /api/search-ai/:indexId/knowledge-graph/entities/:entityText/traverse
GET /api/search-ai/:indexId/knowledge-graph/entities
GET /api/search-ai/:indexId/knowledge-graph/stats
GET /api/search-ai/:indexId/knowledge-graph/visual
```

**Integration with Studio UI (future):**

- **Entity Explorer:** Interactive graph visualization (D3.js).
- **Search Results Enhancement:** Show related entities alongside search results.
- **Document Viewer:** Highlight entities inline, click to explore relationships.

---

### Monitoring & Observability

**Key metrics to monitor:**

| Metric                                | Purpose                       | Alert Threshold                   |
| ------------------------------------- | ----------------------------- | --------------------------------- |
| `knowledge_graph_jobs_completed`      | Throughput (jobs/min)         | < 10/min (low throughput)         |
| `knowledge_graph_jobs_failed`         | Error rate                    | > 5% (high failure rate)          |
| `knowledge_graph_processing_duration` | Latency (ms/chunk)            | > 500ms (performance degradation) |
| `neo4j_connection_pool_active`        | Resource usage                | > 90 (pool exhaustion)            |
| `neo4j_connection_pool_idle`          | Resource waste                | < 10 (under-provisioned)          |
| `knowledge_graph_entity_count`        | Graph size (per tenant/index) | > 10M (consider scaling)          |

**Logs to search for:**

```bash
# Knowledge graph processing logs
grep "Knowledge graph" logs/search-ai.log

# Neo4j connection errors
grep "Neo4j driver not initialized" logs/search-ai.log

# Co-occurrence analysis logs
grep "Co-occurrence" logs/search-ai.log
```

**Distributed tracing:**

- Each job has a trace ID propagated through the pipeline.
- Neo4j queries include trace ID in comments for correlation.

---

## Querying the Knowledge Graph

### Service Methods

#### 1. Find Related Entities

```typescript
const relatedEntities = await knowledgeGraphService.findRelatedEntities(
  tenantId,
  indexId,
  'Microsoft', // Entity text
  'CO_OCCURS', // Relationship type (optional, defaults to all)
  20, // Limit (default: 20)
);

// Returns:
[
  {
    entity: {
      id: 'uuid-1',
      text: 'OpenAI',
      type: 'ORGANIZATION',
      occurrenceCount: 15,
      idf: 3.2,
      // ...
    },
    weight: 22.55, // Relationship strength
    relationshipType: 'CO_OCCURS',
  },
  {
    entity: {
      id: 'uuid-2',
      text: 'Google',
      type: 'ORGANIZATION',
      occurrenceCount: 45,
      idf: 1.8,
    },
    weight: 18.3,
    relationshipType: 'CO_OCCURS',
  },
  // ...
];
```

#### 2. Get Graph Statistics

```typescript
const stats = await knowledgeGraphService.getGraphStats(tenantId, indexId);

// Returns:
{
  entityCount: 1523,
  relationshipCount: 4891,
  entityTypes: {
    PERSON: 245,
    ORGANIZATION: 189,
    LOCATION: 98,
    EMAIL: 456,
    URL: 123,
    DATE: 234,
    MONEY: 78,
    PHONE: 45,
    CONTRACT: 34,
    EXHIBIT: 21,
  },
  coOccurrenceStats: {
    totalCoOccurrences: 3245,
    avgWeight: 12.4,
  },
}
```

#### 3. Direct Neo4j Queries (Advanced)

```typescript
const neo4jClient = knowledgeGraphService.getClient();

// Custom Cypher query
const result = await neo4jClient.getSession().run(
  `
  MATCH (e:Entity {tenantId: $tenantId, indexId: $indexId})
  WHERE e.type = 'PERSON'
  RETURN e.text, e.occurrenceCount, e.idf
  ORDER BY e.idf DESC
  LIMIT 10
`,
  { tenantId, indexId },
);

// Top 10 most significant people (highest IDF = rarest mentions)
```

### Cypher Query Examples

#### Find Entities 2 Hops Away

```cypher
MATCH (start:Entity {
  text: 'Microsoft',
  tenantId: $tenantId,
  indexId: $indexId
})-[r1]->(hop1:Entity)-[r2]->(hop2:Entity)
WHERE r1.tenantId = $tenantId
  AND r1.indexId = $indexId
  AND r2.tenantId = $tenantId
  AND r2.indexId = $indexId
RETURN hop2.text, hop2.type, r1.weight + r2.weight AS totalWeight
ORDER BY totalWeight DESC
LIMIT 20
```

#### Find Common Co-Occurrences Between Two Entities

```cypher
MATCH (e1:Entity {text: 'Microsoft', tenantId: $tenantId, indexId: $indexId})
      -[r1:CO_OCCURS {tenantId: $tenantId, indexId: $indexId}]->
      (common:Entity)
      <-[r2:CO_OCCURS {tenantId: $tenantId, indexId: $indexId}]-
      (e2:Entity {text: 'Google', tenantId: $tenantId, indexId: $indexId})
RETURN common.text, common.type, r1.weight + r2.weight AS totalWeight
ORDER BY totalWeight DESC
LIMIT 10
```

#### Find All Cross-Document References

```cypher
MATCH (e1:Entity)-[r:REFERENCES {tenantId: $tenantId, indexId: $indexId}]->(e2:Entity)
WHERE e1.documentId <> e2.documentId  // Different documents
RETURN e1.documentId, e1.text, e2.documentId, e2.text, r.metadata.referenceType
```

#### Entity Clustering by Co-Occurrence

```cypher
// Find clusters of entities that co-occur frequently
MATCH (e:Entity {tenantId: $tenantId, indexId: $indexId})
      -[r:CO_OCCURS {tenantId: $tenantId, indexId: $indexId}]-
      (related:Entity)
WHERE r.weight > 10.0  // High-weight relationships only
WITH e, collect({entity: related.text, weight: r.weight}) AS cluster
WHERE size(cluster) >= 3  // At least 3 related entities
RETURN e.text, e.type, cluster
ORDER BY size(cluster) DESC
LIMIT 20
```

---

## Configuration

### Global Configuration (Infrastructure)

**Environment Variables:**

```bash
# Enable knowledge graph feature
KNOWLEDGE_GRAPH_ENABLED=true

# Neo4j connection
KNOWLEDGE_GRAPH_URI=neo4j://localhost:7687
KNOWLEDGE_GRAPH_USERNAME=neo4j
KNOWLEDGE_GRAPH_PASSWORD=your-secure-password
KNOWLEDGE_GRAPH_DATABASE=neo4j

# Connection pool size (100 recommended for 11-worker production load)
KNOWLEDGE_GRAPH_NEO4J_MAX_POOL_SIZE=100

# Entity extraction method (regex | compromise | hybrid)
KNOWLEDGE_GRAPH_ENTITY_EXTRACTION_METHOD=hybrid

# Co-occurrence analysis
KNOWLEDGE_GRAPH_ENABLE_CO_OCCURRENCE=true
KNOWLEDGE_GRAPH_CO_OCCURRENCE_WINDOW=5  # Chunks within N distance
KNOWLEDGE_GRAPH_MIN_IDF_THRESHOLD=1.5   # Minimum IDF for co-occurrence edges
```

**Config File:**

```typescript
// apps/search-ai/src/config/index.ts
export const config = {
  knowledgeGraph: {
    enabled: process.env.KNOWLEDGE_GRAPH_ENABLED === 'true',
    uri: process.env.KNOWLEDGE_GRAPH_URI || 'neo4j://localhost:7687',
    username: process.env.KNOWLEDGE_GRAPH_USERNAME || 'neo4j',
    password: process.env.KNOWLEDGE_GRAPH_PASSWORD || 'password',
    database: process.env.KNOWLEDGE_GRAPH_DATABASE || 'neo4j',
    neo4jMaxPoolSize: parseInt(process.env.KNOWLEDGE_GRAPH_NEO4J_MAX_POOL_SIZE || '100'),
    entityExtractionMethod: process.env.KNOWLEDGE_GRAPH_ENTITY_EXTRACTION_METHOD || 'hybrid',
    enableCoOccurrence: process.env.KNOWLEDGE_GRAPH_ENABLE_CO_OCCURRENCE !== 'false',
    coOccurrenceWindow: parseInt(process.env.KNOWLEDGE_GRAPH_CO_OCCURRENCE_WINDOW || '5'),
    minIdfThreshold: parseFloat(process.env.KNOWLEDGE_GRAPH_MIN_IDF_THRESHOLD || '1.5'),
  },
};
```

### Per-Index Configuration (Feature Flags)

Each index can independently enable/disable knowledge graph:

```typescript
// Enable knowledge graph for a specific index
await SearchIndex.findByIdAndUpdate(indexId, {
  'llmConfig.useCases.knowledgeGraph.enabled': true,
  'llmConfig.useCases.knowledgeGraph.enableCoOccurrence': true,
});

// Query per-index config
const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);

if (llmConfig.useCases.knowledgeGraph.enabled) {
  // Process knowledge graph
  await knowledgeGraphService.processChunk({
    tenantId,
    indexId,
    documentId,
    chunkId,
    text: chunk.content,
  });
}
```

**Schema:**

```typescript
// packages/database/src/models/search-index.model.ts
llmConfig: {
  useCases: {
    knowledgeGraph: {
      enabled: boolean;              // Enable knowledge graph extraction
      enableCoOccurrence: boolean;   // Enable co-occurrence analysis
    },
  },
}
```

This allows:

- **Legal docs index:** Knowledge graph enabled (track contract references)
- **Chat index:** Knowledge graph disabled (no cross-document linking needs)
- **Research index:** Knowledge graph enabled with co-occurrence (find research collaborations)

---

## Performance Characteristics

### Latency per Chunk

| Operation                          | Time                  | Notes                                     |
| ---------------------------------- | --------------------- | ----------------------------------------- |
| **Entity Extraction (regex)**      | ~0.1ms                | Fast, structured entities only            |
| **Entity Extraction (compromise)** | ~2-5ms                | Semantic entities (people, orgs)          |
| **Entity Extraction (hybrid)**     | ~3-6ms                | Recommended default                       |
| **Reference Extraction**           | ~0.2ms                | Regex-based patterns                      |
| **Neo4j Entity Upsert**            | ~2-10ms               | Depends on network + pool availability    |
| **Neo4j Relationship Creation**    | ~1-5ms per edge       | Batched for efficiency                    |
| **Co-Occurrence Analysis**         | ~10-50ms per document | Batch processing, calculated once per doc |
| **Total (per chunk)**              | ~15-80ms              | Varies by entity density + co-occurrence  |

### Throughput

**Worker Concurrency:** 3 (default)

```
Throughput = 3 workers × (1000ms / 50ms avg latency) = ~60 chunks/second
           = ~3,600 chunks/minute
           = ~216,000 chunks/hour
```

**Bottleneck:** Neo4j connection pool (100 connections for 11 workers total)

### Cost Breakdown

| Component                  | Cost per Chunk      | Notes                                       |
| -------------------------- | ------------------- | ------------------------------------------- |
| **Entity Extraction**      | Free                | Compromise NLP (local, no API)              |
| **Reference Extraction**   | Free                | Regex-based                                 |
| **Co-Occurrence Analysis** | Free                | In-memory calculation                       |
| **Neo4j Storage**          | ~$0.00002           | Network + storage cost (varies by provider) |
| **Total**                  | **~$0.00002/chunk** | ~50× cheaper than LLM-based extraction      |

**Cost Comparison:**

- **Knowledge Graph:** $0.00002/chunk (compromise NLP)
- **LLM Entity Extraction (GPT-4o-mini):** $0.001/chunk (~50× more expensive)
- **Semantic Search (BGE-M3):** $0.000001/chunk (50× cheaper, but no graph)

### Scaling Considerations

**Neo4j Connection Pool:**

- 100 connections recommended for 11 workers (search-ai production load)
- Each worker makes ~2-5 concurrent Neo4j calls per chunk
- Connection pool exhaustion → queuing latency (monitor Neo4j metrics)

**Batch Processing:**

- Co-occurrence analysis batches all chunks in a document (reduces round-trips)
- IDF calculation happens once per batch (not per chunk)
- Graph updates use transactions (atomic, ACID-compliant)

**Memory Usage:**

- Co-occurrence analyzer: ~1-5MB per 1000 chunks (entity stats + co-occurrence map)
- Reset after batch completion (no memory leak)

---

## Performance Optimization Guide

This section provides actionable guidance for optimizing knowledge graph performance based on profiling and production experience.

### Profiling Knowledge Graph Processing

**Identifying Bottlenecks:**

```typescript
// Enable detailed timing logs
const startTime = Date.now();

const entities = entityExtractor.extract(text);
console.log(`Entity extraction: ${Date.now() - startTime}ms`);

const entityIds = await neo4jClient.upsertEntities(entityNodes);
console.log(`Neo4j upsert: ${Date.now() - startTime}ms`);

const coOccurrences = coOccurrenceAnalyzer.getCoOccurrencesAboveThreshold(threshold);
console.log(`Co-occurrence calculation: ${Date.now() - startTime}ms`);
```

**Common bottlenecks (ordered by impact):**

1. **Neo4j connection pool exhaustion** → 80% of slowdowns
2. **Co-occurrence analysis for large documents** → 15% of slowdowns
3. **Entity extraction (compromise NLP)** → 5% of slowdowns

---

### Optimization 1: Neo4j Connection Pool Tuning

**Problem:** Connection pool exhausted → queries queue → latency increases.

**Diagnosis:**

```typescript
// Check active/idle connections
const poolStats = await neo4jClient.getPoolStats();
console.log(`Active: ${poolStats.active}, Idle: ${poolStats.idle}, Max: ${poolStats.max}`);

// If active ≈ max and idle ≈ 0 → pool exhausted
```

**Solution: Increase pool size:**

```bash
# Default: 100 connections (for 11 workers total)
KNOWLEDGE_GRAPH_NEO4J_MAX_POOL_SIZE=200

# Formula: maxPoolSize = (workers × concurrency × calls_per_chunk) + buffer
# Example: (3 workers × 3 concurrency × 5 calls) + 50 buffer = 95 → round to 100
```

**Trade-offs:**

- **Higher pool size:** Lower latency, more memory per connection (~2MB).
- **Lower pool size:** Higher latency, less memory usage.

**Recommended:**

- **Development:** 50 connections (1 worker)
- **Production:** 100-200 connections (3-5 workers)

---

### Optimization 2: Batch Size Tuning

**Problem:** Processing documents with 1000+ chunks → co-occurrence analysis becomes expensive.

**Diagnosis:**

```typescript
const chunkCount = chunks.length;
if (chunkCount > 500) {
  console.warn(`Large document: ${chunkCount} chunks, consider batching`);
}
```

**Solution: Process in sub-batches:**

```typescript
// Instead of processing all 1000 chunks at once:
const BATCH_SIZE = 200; // Tune based on memory/latency tradeoffs

for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
  const batch = chunks.slice(i, i + BATCH_SIZE);
  await service.batchProcess({ chunks: batch, ... });
}
```

**Trade-offs:**

- **Smaller batches (100-200 chunks):** Lower memory, faster per-batch, but less accurate IDF (fewer samples).
- **Larger batches (500-1000 chunks):** Higher memory, slower per-batch, but more accurate IDF (more samples).

**Recommended:** 200 chunks per batch (balances memory and IDF accuracy).

---

### Optimization 3: Disable Co-Occurrence for Low-Value Indexes

**Problem:** Co-occurrence adds ~30-50ms per document but may not be useful for all indexes.

**Diagnosis:**

```typescript
// Check if co-occurrence edges are actually used
const stats = await knowledgeGraphService.getGraphStats(tenantId, indexId);
console.log(`CO_OCCURS edges: ${stats.relationshipCount - stats.referenceCount}`);

// If CO_OCCURS count is low or never queried → consider disabling
```

**Solution: Disable per-index:**

```typescript
await SearchIndex.findByIdAndUpdate(indexId, {
  'llmConfig.useCases.knowledgeGraph.enabled': true,
  'llmConfig.useCases.knowledgeGraph.enableCoOccurrence': false, // Disable
});
```

**When to disable:**

- **Chat/email indexes:** Low entity density, co-occurrence not meaningful.
- **Short documents (<10 chunks):** Not enough samples for IDF calculation.
- **Real-time requirements:** Need lowest possible latency.

**When to keep enabled:**

- **Legal/research documents:** High entity density, relationship discovery is valuable.
- **Large documents (>50 chunks):** Enough samples for meaningful IDF scores.

---

### Optimization 4: IDF Threshold Tuning

**Problem:** Too many co-occurrence edges → graph becomes dense → slow traversals.

**Diagnosis:**

```cypher
// Count co-occurrence edges per entity
MATCH (e:Entity {tenantId: $tenantId, indexId: $indexId})
OPTIONAL MATCH (e)-[r:CO_OCCURS]->()
RETURN e.text, count(r) AS edgeCount
ORDER BY edgeCount DESC
LIMIT 20

// If top entities have 100+ edges → threshold too low
```

**Solution: Increase threshold:**

```bash
# Default: 1.5 (moderate filtering)
KNOWLEDGE_GRAPH_MIN_IDF_THRESHOLD=2.5  # Aggressive filtering

# Result: Fewer edges, sparser graph, faster traversals
```

**Guidelines:**

- **Dense graph (10+ edges/entity avg):** Increase threshold to 2.0-3.0
- **Sparse graph (<3 edges/entity avg):** Decrease threshold to 1.0-1.5
- **Target:** 5-10 edges per entity (optimal for traversal performance)

---

### Optimization 5: Entity Extraction Method Selection

**Problem:** Compromise NLP adds 2-5ms per chunk but may not be needed for structured documents.

**Diagnosis:**

```typescript
// Compare entity types extracted
const entities = entityExtractor.extract(sampleText);
const typeDistribution = entityExtractor.getTypeDistribution(entities);

console.log(typeDistribution);
// { EMAIL: 45, URL: 23, DATE: 12, PERSON: 2, ORGANIZATION: 1 }

// If semantic entities (PERSON, ORG, LOCATION) < 10% → use regex only
```

**Solution: Switch to regex-only:**

```bash
KNOWLEDGE_GRAPH_ENTITY_EXTRACTION_METHOD=regex  # ~0.1ms per chunk (20x faster)
```

**When to use each method:**

- **regex:** Structured documents (forms, invoices, logs) with few semantic entities
- **compromise:** Unstructured documents (contracts, articles) with many people/organizations
- **hybrid:** Mixed documents (default, recommended)

---

### Optimization 6: Neo4j Query Optimization

**Problem:** Slow graph traversals (>1000ms for 2-hop queries).

**Diagnosis:**

```cypher
// Explain query to see execution plan
EXPLAIN MATCH (e:Entity {tenantId: $tenantId, indexId: $indexId})
        -[r1:CO_OCCURS]->()-[r2:CO_OCCURS]->()
RETURN count(*)

// Look for:
// - Missing indexes (NodeByLabelScan instead of NodeIndexSeek)
// - Cartesian products (high db hits)
```

**Solution: Add indexes (should be automatic):**

```cypher
// Verify indexes exist
SHOW INDEXES

// Expected:
// - entity_unique (constraint)
// - entity_id_idx
// - entity_tenant_idx
// - entity_type_idx

// If missing, create:
CREATE INDEX entity_tenant_idx IF NOT EXISTS
FOR (e:Entity) ON (e.tenantId, e.indexId)
```

**Solution: Limit traversal depth:**

```cypher
// ❌ BAD: Unbounded traversal (exponential complexity)
MATCH (e:Entity {id: $entityId})-[*]->(related:Entity)
RETURN related

// ✅ GOOD: Limit depth to 2 hops (polynomial complexity)
MATCH (e:Entity {id: $entityId})-[*1..2]->(related:Entity)
RETURN related
LIMIT 100
```

---

### Optimization 7: Memory Management for Large Batches

**Problem:** Co-occurrence analyzer consumes 100MB+ memory for documents with 5000+ chunks.

**Diagnosis:**

```typescript
const memBefore = process.memoryUsage().heapUsed / 1024 / 1024;
await service.batchProcess({ chunks: largeChunkSet, ... });
const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;

console.log(`Memory used: ${memAfter - memBefore}MB`);
// If > 200MB → consider sub-batching
```

**Solution: Reset analyzer between sub-batches:**

```typescript
const BATCH_SIZE = 200;

for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
  const batch = chunks.slice(i, i + BATCH_SIZE);
  await service.batchProcess({ chunks: batch, ... });

  // Force garbage collection (if --expose-gc flag)
  if (global.gc) {
    global.gc();
  }
}
```

**Alternative: Streaming IDF calculation:**

```typescript
// Instead of loading all entities in memory:
// Calculate IDF incrementally (future enhancement)
```

---

### Performance Benchmarking Results

**Test Setup:**

- **Hardware:** 4 vCPU, 16GB RAM
- **Neo4j:** Community Edition, 8GB heap
- **Workers:** 3 concurrent (knowledge-graph-worker)

**Results:**

| Document Size      | Chunks | Entities | Relationships | Time (seconds) | Throughput (chunks/s) |
| ------------------ | ------ | -------- | ------------- | -------------- | --------------------- |
| Small (10 pages)   | 50     | 120      | 45            | 2.5s           | 20                    |
| Medium (100 pages) | 500    | 1,200    | 450           | 18s            | 28                    |
| Large (1000 pages) | 5,000  | 12,000   | 4,500         | 240s           | 21                    |
| XL (10000 pages)   | 50,000 | 120,000  | 45,000        | 3,200s         | 16                    |

**Observations:**

- Throughput decreases for XL documents due to Neo4j write contention.
- Co-occurrence analysis is O(n²) for entity pairs → dominates at large scale.

**Recommendations:**

- **<1000 chunks:** Use default settings (full co-occurrence)
- **1000-5000 chunks:** Use sub-batching (200 chunks per batch)
- **>5000 chunks:** Consider disabling co-occurrence or using sampling (extract co-occurrences from random 500-chunk sample)

---

### Monitoring & Alerting

**Key metrics to track:**

```typescript
// Custom Prometheus metrics
knowledge_graph_processing_duration_ms (histogram)
  labels: { indexId, documentId, phase: 'entity_extraction' | 'neo4j_upsert' | 'co_occurrence' }

knowledge_graph_entity_count (gauge)
  labels: { tenantId, indexId }

knowledge_graph_relationship_count (gauge)
  labels: { tenantId, indexId, type: 'REFERENCES' | 'CO_OCCURS' }

neo4j_connection_pool_active (gauge)
neo4j_connection_pool_idle (gauge)
neo4j_query_duration_ms (histogram)
```

**Alert thresholds:**

- `knowledge_graph_processing_duration_ms` > 500ms (p95) → investigate bottleneck
- `neo4j_connection_pool_active` / `neo4j_connection_pool_max` > 0.9 → increase pool size
- `knowledge_graph_entity_count` > 10M → consider sharding or archival

---

## Testing Strategy

This section documents testing approaches for the knowledge graph feature.

### Unit Tests

**Coverage areas:**

1. **Entity Extraction** — Regex, compromise, hybrid methods
2. **Reference Extraction** — Pattern matching for all reference types
3. **Co-Occurrence Analysis** — IDF calculation, weight calculation, threshold filtering
4. **Neo4j Client** — Upsert logic, relationship creation (with test container)

**Example: Entity Extraction Test**

```typescript
// apps/search-ai/src/__tests__/knowledge-graph.test.ts

describe('EntityExtractor', () => {
  describe('hybrid mode', () => {
    it('should extract and deduplicate entities from mixed content', () => {
      const text = `
        Contact John Smith at john@example.com or call (555) 123-4567.
        Microsoft announced a $1,234.56 investment on March 15, 2024.
        Visit https://example.com for details.
      `;

      const extractor = new EntityExtractor('hybrid');
      const entities = extractor.extract(text);

      // Verify structured entities (regex)
      expect(entities).toContainEqual(
        expect.objectContaining({ text: 'john@example.com', type: 'EMAIL', method: 'hybrid' }),
      );
      expect(entities).toContainEqual(
        expect.objectContaining({ text: '(555) 123-4567', type: 'PHONE', method: 'hybrid' }),
      );
      expect(entities).toContainEqual(
        expect.objectContaining({ text: '$1,234.56', type: 'MONEY', method: 'hybrid' }),
      );
      expect(entities).toContainEqual(
        expect.objectContaining({ text: 'https://example.com', type: 'URL', method: 'hybrid' }),
      );

      // Verify semantic entities (compromise)
      expect(entities).toContainEqual(
        expect.objectContaining({ text: 'John Smith', type: 'PERSON', method: 'hybrid' }),
      );
      expect(entities).toContainEqual(
        expect.objectContaining({ text: 'Microsoft', type: 'ORGANIZATION', method: 'hybrid' }),
      );

      // Verify no duplicates (john@example.com should not be extracted as PERSON)
      const emailEntities = entities.filter((e) => e.text === 'john@example.com');
      expect(emailEntities).toHaveLength(1);
      expect(emailEntities[0].type).toBe('EMAIL');
    });
  });
});
```

**Running tests:**

```bash
cd apps/search-ai
pnpm test knowledge-graph
```

---

### Integration Tests

**Coverage areas:**

1. **End-to-end worker processing** — Job dispatch → entity extraction → Neo4j storage → chunk metadata update
2. **Tenant isolation** — Verify no cross-tenant data leakage
3. **Configuration resolution** — Per-index config overrides global config
4. **Error handling** — Neo4j connection failures, malformed chunks

**Example: Tenant Isolation Test**

```typescript
describe('Knowledge Graph Tenant Isolation', () => {
  it('should not leak entities across tenants', async () => {
    // Create entities for tenant A
    await processKnowledgeGraphJob({
      tenantId: 'tenant-a',
      indexId: 'index-1',
      documentId: 'doc-a',
      chunkIds: ['chunk-a-1'],
      chunks: [{ content: 'Microsoft announced a deal.' }],
    });

    // Create entities for tenant B (same entity text)
    await processKnowledgeGraphJob({
      tenantId: 'tenant-b',
      indexId: 'index-2',
      documentId: 'doc-b',
      chunkIds: ['chunk-b-1'],
      chunks: [{ content: 'Microsoft announced a deal.' }],
    });

    // Query tenant A's entities
    const entitiesA = await neo4jClient.findEntities('tenant-a', 'index-1');
    expect(entitiesA).toHaveLength(1);
    expect(entitiesA[0].text).toBe('Microsoft');

    // Query tenant B's entities
    const entitiesB = await neo4jClient.findEntities('tenant-b', 'index-2');
    expect(entitiesB).toHaveLength(1);
    expect(entitiesB[0].text).toBe('Microsoft');

    // Verify separate nodes (different IDs)
    expect(entitiesA[0].id).not.toBe(entitiesB[0].id);

    // Query tenant A with tenant B's entity ID → should return empty
    const crossTenantResult = await neo4jClient.findEntityById(
      'tenant-a',
      'index-1',
      entitiesB[0].id,
    );
    expect(crossTenantResult).toBeNull();
  });
});
```

---

### Load Tests

**Scenario:** Process 10,000 documents concurrently with 3 workers.

**Test setup:**

```typescript
// load-test.ts
import { Queue } from 'bullmq';

const queue = new Queue('knowledge-graph');

// Enqueue 10,000 jobs
for (let i = 0; i < 10_000; i++) {
  await queue.add('extract-kg', {
    tenantId: 'load-test',
    indexId: 'index-1',
    documentId: `doc-${i}`,
    chunkIds: [`chunk-${i}-1`, `chunk-${i}-2`],
  });
}

// Monitor throughput
const startTime = Date.now();
let completed = 0;

queue.on('completed', () => {
  completed++;
  if (completed % 1000 === 0) {
    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`Completed: ${completed}, Throughput: ${completed / elapsed} jobs/sec`);
  }
});
```

**Expected results:**

- **Throughput:** 15-20 jobs/sec (3 workers × 5-7 jobs/sec per worker)
- **Neo4j connection pool:** 70-90% utilized (not exhausted)
- **Memory:** Stable (<2GB heap growth over 10K jobs)

---

## Use Cases

### 1. Legal Document Management

**Scenario:** Law firm with 10,000 contracts, exhibits, and legal memos.

**Problem:** Lawyers need to find all documents referencing "Contract #45821" or "Exhibit A" to assess legal dependencies.

**Solution with Knowledge Graph:**

```typescript
// Find all documents mentioning "Contract #45821"
const relatedDocs = await findRelatedEntities(
  tenantId,
  legalIndexId,
  'Contract #45821',
  'REFERENCES',
  100,
);

// Result: All exhibits, appendices, memos that reference this contract
// Sorted by relationship strength (number of references)
```

**Value:**

- No manual cross-referencing needed
- Find hidden dependencies (Exhibit A → Contract B → Memo C)
- Compliance tracking (which contracts reference outdated clauses)

### 2. Research & Literature Review

**Scenario:** Academic platform with 50,000 research papers.

**Problem:** Researchers want to find collaboration networks (which authors/institutions co-publish).

**Solution with Knowledge Graph:**

```cypher
// Find all organizations that co-author with "MIT"
MATCH (mit:Entity {text: 'MIT', type: 'ORGANIZATION', tenantId: $tenantId})
      -[r:CO_OCCURS {tenantId: $tenantId}]->
      (org:Entity {type: 'ORGANIZATION'})
WHERE r.weight > 5.0  // Frequent collaborations only
RETURN org.text, r.weight, r.count
ORDER BY r.weight DESC
LIMIT 20
```

**Value:**

- Discover research collaborations automatically
- Identify influential authors (high IDF = rare, significant)
- Track research trends over time (firstSeenAt, lastSeenAt)

### 3. CRM & Sales Intelligence

**Scenario:** Sales team with 100,000 emails, meeting notes, contracts.

**Problem:** Sales reps need to find all contacts associated with "Microsoft deals" to prioritize outreach.

**Solution with Knowledge Graph:**

```cypher
// Find all people mentioned alongside "Microsoft"
MATCH (msft:Entity {text: 'Microsoft', type: 'ORGANIZATION', tenantId: $tenantId})
      -[r:CO_OCCURS {tenantId: $tenantId}]->
      (person:Entity {type: 'PERSON'})
WHERE r.weight > 3.0
RETURN person.text, person.documentId, r.weight
ORDER BY r.weight DESC
```

**Value:**

- Automatic contact discovery (no manual tagging)
- Relationship strength scoring (frequent co-mentions = strong relationship)
- Cross-document linking (meeting notes → contracts → emails)

### 4. Compliance & Audit

**Scenario:** Financial institution with 1M documents under regulatory audit.

**Problem:** Auditors need to find all mentions of "Entity X" in 2023-2024 for compliance review.

**Solution with Knowledge Graph:**

```cypher
// Find all documents mentioning "Acme Corp" in 2024
MATCH (e:Entity {text: 'Acme Corp', tenantId: $tenantId})
WHERE e.firstSeenAt >= datetime('2024-01-01T00:00:00Z')
  AND e.firstSeenAt < datetime('2025-01-01T00:00:00Z')
RETURN e.documentId, e.chunkId, e.occurrenceCount, e.firstSeenAt
```

**Value:**

- Temporal analysis (when entity first/last appeared)
- Complete audit trail (all mentions across documents)
- Compliance reporting (entity occurrence counts)

### 5. Technical Documentation

**Scenario:** Software platform with 5,000 API docs, integration guides, changelogs.

**Problem:** Engineers need to find all components that depend on "Authentication module" for impact analysis.

**Solution with Knowledge Graph:**

```cypher
// Find all components that reference "Authentication"
MATCH (auth:Entity {text: 'Authentication', tenantId: $tenantId})
      <-[r:REFERENCES {tenantId: $tenantId}]-
      (component:Entity)
RETURN component.text, component.type, component.documentId
```

**Value:**

- Dependency tracking (which components reference which APIs)
- Impact analysis (breaking changes affect which systems)
- Documentation completeness (find undocumented references)

---

## Limitations

### Entity Extraction Limitations

| Limitation          | Impact                                                        | Mitigation                                                    |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| **English-centric** | Compromise NLP optimized for English                          | Use regex-only for non-English, or integrate multilingual NER |
| **Ambiguous names** | "Apple" = company or fruit?                                   | Confidence scores help; context from surrounding text         |
| **Abbreviations**   | "MS" = Microsoft or Mississippi?                              | Expand abbreviations in preprocessing step                    |
| **Misspellings**    | "Microsof" not recognized                                     | Spell correction in preprocessing service                     |
| **Complex names**   | "State of California Department of Justice" → partial matches | Custom regex patterns per domain                              |

### Reference Extraction Limitations

| Limitation                | Impact                                        | Mitigation                                        |
| ------------------------- | --------------------------------------------- | ------------------------------------------------- |
| **Non-standard formats**  | "Refer to doc ABC (see page 5)" → missed      | Expand regex patterns for domain-specific formats |
| **Contextual references** | "The aforementioned contract" → no identifier | Requires coreference resolution (advanced NLP)    |
| **Language-specific**     | Only English patterns currently supported     | Add patterns for other languages                  |

### Co-Occurrence Limitations

| Limitation                   | Impact                                            | Mitigation                                        |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| **Correlation ≠ Causation**  | Entities co-occur but not related                 | Filter by IDF threshold (removes noise)           |
| **Long documents**           | Entities in different sections may not be related | Use chunk-based co-occurrence (not document-wide) |
| **Common entities dominate** | "The" and "is" co-occur with everything           | IDF weighting filters common entities             |

### Neo4j Limitations

| Limitation             | Impact                                  | Mitigation                                  |
| ---------------------- | --------------------------------------- | ------------------------------------------- |
| **Memory-bound**       | Large graphs (>10M nodes) need sharding | Use pagination, limit query depth           |
| **Write latency**      | High insert rate can bottleneck         | Batch writes, increase connection pool      |
| **Query optimization** | Complex traversals can be slow          | Use indexes, limit hop depth, cache results |

### Current API Gaps

⚠️ **No REST API endpoints yet** — Knowledge graph can only be queried via service methods (not exposed to Studio/external clients). See [Task #52](#enhancement-task-52) for planned API endpoints.

---

## Troubleshooting

### Issue: Knowledge Graph Not Extracting Entities

**Symptoms:**

- `SearchChunk.metadata.entities` is empty
- `SearchDocument.metadata.knowledgeGraph` is undefined

**Diagnostics:**

```typescript
// 1. Check if knowledge graph is enabled globally
const config = getConfig();
console.log(config.knowledgeGraph.enabled); // Should be true

// 2. Check if knowledge graph is enabled for this index
const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);
console.log(llmConfig.useCases.knowledgeGraph.enabled); // Should be true

// 3. Check worker logs
// Search for "Knowledge graph disabled for index" warnings
```

**Fixes:**

- Enable globally: `KNOWLEDGE_GRAPH_ENABLED=true`
- Enable per-index: `llmConfig.useCases.knowledgeGraph.enabled = true`
- Verify Neo4j connection: `await neo4jClient.connect()` should succeed

### Issue: Neo4j Connection Errors

**Symptoms:**

- Worker fails with "Neo4j driver not initialized"
- Connection timeout errors

**Diagnostics:**

```bash
# 1. Verify Neo4j is running
docker ps | grep neo4j
# Should show neo4j container running on port 7687

# 2. Test connection
curl http://localhost:7474  # Neo4j browser (HTTP)
# Should return HTML page

# 3. Check credentials
echo $KNOWLEDGE_GRAPH_URI
echo $KNOWLEDGE_GRAPH_USERNAME
echo $KNOWLEDGE_GRAPH_PASSWORD
```

**Fixes:**

- Start Neo4j: `docker-compose up neo4j -d`
- Verify credentials match `docker-compose.yml`
- Check network firewall rules (allow port 7687)

### Issue: Co-Occurrence Analysis Not Creating Relationships

**Symptoms:**

- Entities extracted correctly
- No `CO_OCCURS` relationships in Neo4j
- `totalRelationships = 0` in graph stats

**Diagnostics:**

```typescript
// 1. Check if co-occurrence is enabled
const config = getConfig();
console.log(config.knowledgeGraph.enableCoOccurrence); // Should be true

const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);
console.log(llmConfig.useCases.knowledgeGraph.enableCoOccurrence); // Should be true

// 2. Check IDF threshold
console.log(config.knowledgeGraph.minIdfThreshold); // Default: 1.5

// 3. Check co-occurrence analyzer stats
const stats = coOccurrenceAnalyzer.getStats();
console.log(stats.totalCoOccurrences); // Should be > 0
console.log(stats.avgIDF); // Should be > 0
```

**Fixes:**

- Enable co-occurrence: `KNOWLEDGE_GRAPH_ENABLE_CO_OCCURRENCE=true`
- Lower IDF threshold: `KNOWLEDGE_GRAPH_MIN_IDF_THRESHOLD=0.5` (more permissive)
- Verify entity extraction is working (check `metadata.entities` first)

### Issue: Slow Knowledge Graph Processing

**Symptoms:**

- Knowledge graph worker taking >1 minute per chunk
- Neo4j connection pool exhausted warnings

**Diagnostics:**

```typescript
// 1. Check worker concurrency
const concurrency = 3; // Default
console.log(`Running ${concurrency} concurrent jobs`);

// 2. Check Neo4j connection pool size
const config = getConfig();
console.log(config.knowledgeGraph.neo4jMaxPoolSize); // Should be 100 for production

// 3. Check Neo4j query performance
// Run EXPLAIN on slow queries in Neo4j browser
```

**Fixes:**

- Increase Neo4j pool size: `KNOWLEDGE_GRAPH_NEO4J_MAX_POOL_SIZE=200`
- Reduce worker concurrency: `createKnowledgeGraphWorker(2)` instead of 3
- Add Neo4j indexes (should be created automatically):
  ```cypher
  SHOW INDEXES
  // Verify entity_id_idx, entity_tenant_idx, entity_type_idx exist
  ```

### Issue: Cross-Tenant Data Leakage

**Symptoms:**

- User sees entities from other tenants
- Graph traversal returns wrong tenant's data

**Diagnostics:**

```cypher
// 1. Check if tenant isolation is enforced in queries
MATCH (e:Entity)
WHERE e.id = $entityId
RETURN e

// ❌ BAD: No tenantId filter (returns any tenant's entity)

// 2. Verify relationship tenant filters
MATCH (e:Entity)-[r]->(related:Entity)
WHERE e.id = $entityId
RETURN related

// ❌ BAD: Relationship has no tenantId filter
```

**Fixes:**

- **Always include tenantId + indexId in queries:**
  ```cypher
  MATCH (e:Entity {id: $entityId, tenantId: $tenantId, indexId: $indexId})
  RETURN e
  ```
- **Filter relationships by tenant:**
  ```cypher
  MATCH (e:Entity {id: $entityId, tenantId: $tenantId, indexId: $indexId})
        -[r {tenantId: $tenantId, indexId: $indexId}]->
        (related:Entity)
  RETURN related
  ```
- Audit all Neo4j queries for tenant isolation compliance

---

## Operational Runbook

This section provides operational procedures for managing the knowledge graph in production.

### Deployment Checklist

**Before deploying knowledge graph to production:**

- [ ] **Neo4j infrastructure provisioned**
  - [ ] Neo4j 5.x instance running (Community or Enterprise)
  - [ ] 8GB+ heap allocated (`NEO4J_dbms_memory_heap_max__size=8G`)
  - [ ] Persistent storage configured (volume mount for `/data`)
  - [ ] Backup strategy in place

- [ ] **Environment variables configured**
  - [ ] `KNOWLEDGE_GRAPH_ENABLED=true`
  - [ ] `KNOWLEDGE_GRAPH_URI=neo4j://neo4j:7687`
  - [ ] `KNOWLEDGE_GRAPH_USERNAME` and `KNOWLEDGE_GRAPH_PASSWORD` set (from secrets)
  - [ ] `KNOWLEDGE_GRAPH_NEO4J_MAX_POOL_SIZE=100` (or tuned based on worker count)

- [ ] **Monitoring enabled**
  - [ ] Neo4j metrics exported to Prometheus (`neo4j_metrics_*`)
  - [ ] Custom knowledge graph metrics enabled (`knowledge_graph_*`)
  - [ ] Grafana dashboard imported (if available)
  - [ ] Alerts configured for pool exhaustion, high latency

- [ ] **Per-index configuration reviewed**
  - [ ] Knowledge graph enabled only for relevant indexes (legal docs, research papers, etc.)
  - [ ] Co-occurrence disabled for low-value indexes (chat, email)
  - [ ] IDF threshold tuned per index

- [ ] **Testing completed**
  - [ ] Tenant isolation tested (cross-tenant query returns empty)
  - [ ] Load test passed (10K jobs, <5% failure rate)
  - [ ] Backup/restore verified

---

### Backup & Restore

#### Backup Procedure

**Neo4j backup (cold backup — requires Neo4j shutdown):**

```bash
# 1. Stop Neo4j
docker-compose stop neo4j

# 2. Backup data directory
tar -czf neo4j-backup-$(date +%Y%m%d).tar.gz /var/lib/neo4j/data

# 3. Upload to S3 (or other backup storage)
aws s3 cp neo4j-backup-$(date +%Y%m%d).tar.gz s3://backups/neo4j/

# 4. Restart Neo4j
docker-compose start neo4j
```

**Neo4j backup (hot backup — requires Enterprise Edition):**

```bash
# Use neo4j-admin backup (no downtime)
neo4j-admin database backup \
  --database=neo4j \
  --to-path=/backups/neo4j-$(date +%Y%m%d) \
  --verbose

# Upload to S3
tar -czf neo4j-backup-$(date +%Y%m%d).tar.gz /backups/neo4j-$(date +%Y%m%d)
aws s3 cp neo4j-backup-$(date +%Y%m%d).tar.gz s3://backups/neo4j/
```

**MongoDB backup (chunk/document metadata):**

```bash
# Backup SearchChunk and SearchDocument collections
mongodump --uri="mongodb://localhost:27017" \
  --db=agent-platform \
  --collection=searchchunks \
  --out=/backups/mongo-$(date +%Y%m%d)

mongodump --uri="mongodb://localhost:27017" \
  --db=agent-platform \
  --collection=searchdocuments \
  --out=/backups/mongo-$(date +%Y%m%d)
```

**Backup schedule:**

- **Daily:** Neo4j data directory (automated via cron)
- **Weekly:** Full MongoDB dump (includes all search-ai collections)
- **Retention:** 30 days (daily), 1 year (weekly)

---

#### Restore Procedure

**Neo4j restore:**

```bash
# 1. Stop Neo4j
docker-compose stop neo4j

# 2. Download backup from S3
aws s3 cp s3://backups/neo4j/neo4j-backup-20260224.tar.gz .

# 3. Extract to data directory
tar -xzf neo4j-backup-20260224.tar.gz -C /var/lib/neo4j/data

# 4. Restart Neo4j
docker-compose start neo4j

# 5. Verify connectivity
docker exec neo4j cypher-shell -u neo4j -p password "MATCH (n:Entity) RETURN count(n) AS entityCount"
```

**MongoDB restore:**

```bash
# Restore SearchChunk and SearchDocument collections
mongorestore --uri="mongodb://localhost:27017" \
  --db=agent-platform \
  --dir=/backups/mongo-20260224
```

**RTO/RPO:**

- **Recovery Time Objective (RTO):** 30 minutes (time to restore from backup)
- **Recovery Point Objective (RPO):** 24 hours (daily backups)

---

### Disaster Recovery Scenarios

#### Scenario 1: Neo4j Database Corruption

**Symptoms:**

- Neo4j fails to start
- Cypher queries fail with "database is in inconsistent state"

**Recovery:**

1. Stop Neo4j: `docker-compose stop neo4j`
2. Attempt repair: `neo4j-admin database check neo4j --verbose`
3. If repair fails, restore from latest backup (see Restore Procedure)
4. Verify entity count matches expected: `MATCH (n:Entity) RETURN count(n)`

**Post-recovery:**

- Re-process documents created/updated since backup timestamp
- Verify no data loss by checking document `metadata.knowledgeGraph.processedAt` timestamps

---

#### Scenario 2: Neo4j Connection Pool Exhaustion

**Symptoms:**

- Knowledge graph jobs stuck in "active" state
- Logs show "Connection pool exhausted" warnings

**Immediate mitigation:**

1. Increase pool size: `KNOWLEDGE_GRAPH_NEO4J_MAX_POOL_SIZE=200`
2. Restart search-ai service to apply new config
3. Monitor active connections: `neo4j_connection_pool_active` metric

**Root cause analysis:**

- Check worker concurrency: `createKnowledgeGraphWorker(3)` → reduce to 2 if pool exhaustion persists
- Check Neo4j heap size: Increase from 8GB to 16GB if memory-bound
- Check for long-running queries: `SHOW TRANSACTIONS` in Neo4j browser

---

#### Scenario 3: Cross-Tenant Data Leakage (Security Incident)

**Symptoms:**

- User reports seeing entities from another tenant
- Security audit reveals cross-tenant query

**Immediate response:**

1. **Disable knowledge graph globally:** `KNOWLEDGE_GRAPH_ENABLED=false`
2. **Stop all workers:** Prevent further processing
3. **Audit Neo4j queries:** Review all Cypher queries in codebase for missing `tenantId` filters
4. **Identify affected tenants:** Query for entities without `tenantId` property or misconfigured queries

**Remediation:**

1. Fix query to include `tenantId` filter
2. Deploy fix
3. Delete leaked entities:
   ```cypher
   // Find entities without tenant filter (if any)
   MATCH (e:Entity)
   WHERE NOT e.tenantId IS NOT NULL
   DELETE e
   ```
4. Re-enable knowledge graph: `KNOWLEDGE_GRAPH_ENABLED=true`
5. Re-process affected documents

**Post-incident:**

- Add automated test for tenant isolation (see Testing Strategy section)
- Implement code review rule: All Neo4j queries must include `tenantId` filter
- Add pre-commit hook to detect queries without `tenantId`

---

### Scaling Operations

#### Vertical Scaling (Single Instance)

**When to scale up:**

- Neo4j heap usage consistently >80%
- Connection pool exhaustion even after increasing pool size
- Entity count >10M nodes

**Scaling procedure:**

1. Increase Neo4j heap: `NEO4J_dbms_memory_heap_max__size=16G` (from 8G)
2. Increase connection pool: `KNOWLEDGE_GRAPH_NEO4J_MAX_POOL_SIZE=200` (from 100)
3. Monitor memory usage: `neo4j_memory_heap_used_bytes` metric

**Limits:**

- **Max heap:** 32GB (Community Edition)
- **Max nodes:** ~100M (single instance)

---

#### Horizontal Scaling (Clustering — Enterprise Only)

**When to scale out:**

- Entity count >100M nodes
- Query throughput exceeds single instance capacity
- High availability required (production SLA)

**Scaling procedure (requires Neo4j Enterprise):**

1. Deploy Neo4j Causal Cluster (3-5 nodes)
2. Configure read replicas for query load distribution
3. Update connection URI to cluster endpoint: `neo4j://cluster-endpoint:7687`
4. Enable load balancing in driver config:
   ```typescript
   neo4j.driver(uri, auth, {
     maxConnectionPoolSize: 200,
     loadBalancingStrategy: 'LEAST_CONNECTED',
   });
   ```

**Cost:**

- Neo4j Enterprise license required (~$10K-$50K/year depending on scale)
- Additional infrastructure (3-5 instances instead of 1)

---

### Monitoring Dashboards

**Key metrics for Grafana dashboard:**

#### Worker Health Panel

```promql
# Jobs completed per minute
rate(knowledge_graph_jobs_completed_total[1m])

# Jobs failed per minute
rate(knowledge_graph_jobs_failed_total[1m])

# Job processing duration (p50, p95, p99)
histogram_quantile(0.95, knowledge_graph_processing_duration_ms_bucket)
```

#### Neo4j Health Panel

```promql
# Connection pool utilization
neo4j_connection_pool_active / neo4j_connection_pool_max

# Heap memory usage
neo4j_memory_heap_used_bytes / neo4j_memory_heap_max_bytes

# Query duration (p95)
histogram_quantile(0.95, neo4j_query_duration_ms_bucket)
```

#### Graph Size Panel

```promql
# Entity count per tenant/index
sum(knowledge_graph_entity_count) by (tenantId, indexId)

# Relationship count per tenant/index
sum(knowledge_graph_relationship_count) by (tenantId, indexId, type)
```

---

### Alerting Rules

**Critical alerts:**

```yaml
# Neo4j connection pool exhaustion
alert: KnowledgeGraphPoolExhausted
expr: neo4j_connection_pool_active / neo4j_connection_pool_max > 0.95
for: 5m
severity: critical
summary: "Neo4j connection pool >95% utilized"
action: "Increase KNOWLEDGE_GRAPH_NEO4J_MAX_POOL_SIZE or reduce worker concurrency"

# High job failure rate
alert: KnowledgeGraphHighFailureRate
expr: rate(knowledge_graph_jobs_failed_total[5m]) / rate(knowledge_graph_jobs_total[5m]) > 0.1
for: 10m
severity: critical
summary: ">10% of knowledge graph jobs failing"
action: "Check Neo4j connectivity, review worker logs"

# Slow processing
alert: KnowledgeGraphSlowProcessing
expr: histogram_quantile(0.95, knowledge_graph_processing_duration_ms_bucket) > 1000
for: 15m
severity: warning
summary: "P95 processing duration >1000ms"
action: "Check Neo4j query performance, consider optimization"
```

**Warning alerts:**

```yaml
# Graph size approaching limit
alert: KnowledgeGraphLargeGraph
expr: knowledge_graph_entity_count > 50000000
for: 1h
severity: warning
summary: "Entity count >50M (approaching 100M limit)"
action: "Consider archival, sharding, or upgrading to Enterprise for clustering"

# High memory usage
alert: Neo4jHighMemoryUsage
expr: neo4j_memory_heap_used_bytes / neo4j_memory_heap_max_bytes > 0.85
for: 30m
severity: warning
summary: "Neo4j heap usage >85%"
action: "Consider increasing heap size or archiving old data"
```

---

### Maintenance Tasks

**Weekly:**

- Review failed jobs in BullMQ dashboard
- Check Neo4j logs for warnings/errors
- Verify backup success (check S3 bucket)

**Monthly:**

- Analyze graph size growth trends
- Review and optimize slow queries (using `EXPLAIN`)
- Archive old entities (if TTL policy exists)

**Quarterly:**

- Load test with production-scale data
- Review and update IDF thresholds per index
- Capacity planning (estimate growth for next 6 months)

---

### Runbook: Rebuilding Knowledge Graph for an Index

**Use case:** Schema change, major bug fix, or index reset.

**Procedure:**

```bash
# 1. Delete all entities and relationships for the index
cypher-shell -u neo4j -p password <<EOF
MATCH (e:Entity {tenantId: $TENANT_ID, indexId: $INDEX_ID})
DETACH DELETE e;
EOF

# 2. Reset document metadata (optional)
mongo <<EOF
use agent-platform
db.searchdocuments.updateMany(
  { tenantId: "$TENANT_ID", indexId: "$INDEX_ID" },
  { \$unset: { "metadata.knowledgeGraph": "" } }
);
db.searchchunks.updateMany(
  { tenantId: "$TENANT_ID", indexId: "$INDEX_ID" },
  { \$unset: { "metadata.entities": "", "metadata.references": "", "metadata.entityIds": "" } }
);
EOF

# 3. Re-enqueue all documents for knowledge graph processing
node scripts/reprocess-knowledge-graph.js --tenantId=$TENANT_ID --indexId=$INDEX_ID

# 4. Monitor progress
watch -n 10 'mongo --eval "db.searchdocuments.count({ tenantId: \"$TENANT_ID\", indexId: \"$INDEX_ID\", \"metadata.knowledgeGraph\": { \$exists: true } })"'
```

**Duration:** ~1 hour per 10,000 documents (depends on worker concurrency).

---

## What's Next?

### Planned Enhancements (Task #52)

The knowledge graph backend is fully implemented, but **no REST API endpoints** exist yet to expose it to Studio or external clients. Planned additions:

#### 1. REST API Endpoints

```typescript
// GET /api/search-ai/:indexId/knowledge-graph/entities/:entityText/related
// Find related entities for a given entity
{
  entityText: 'Microsoft',
  relationshipType?: 'CO_OCCURS' | 'REFERENCES' | 'all',
  limit?: 20,
}

// GET /api/search-ai/:indexId/knowledge-graph/entities/:entityText/traverse
// Graph traversal with depth limits
{
  entityText: 'Microsoft',
  maxDepth: 2,
  relationshipTypes?: ['CO_OCCURS', 'REFERENCES'],
  limit?: 50,
}

// GET /api/search-ai/:indexId/knowledge-graph/entities
// Search entities by type, text pattern, IDF range
{
  type?: 'PERSON' | 'ORGANIZATION' | ...,
  textPattern?: 'micro*',  // Wildcard search
  minIdf?: 2.0,
  maxIdf?: 5.0,
  limit?: 100,
}

// GET /api/search-ai/:indexId/knowledge-graph/stats
// Get graph statistics (entity count, relationship count, type distribution)
{
  entityCount: 1523,
  relationshipCount: 4891,
  entityTypes: { ... },
  coOccurrenceStats: { ... },
}

// GET /api/search-ai/:indexId/knowledge-graph/visual
// Get graph data for UI rendering (nodes + edges in D3.js format)
{
  entityText?: 'Microsoft',  // Optional: center graph on entity
  maxNodes?: 100,
  maxDepth?: 2,
}
```

#### 2. Studio UI Integration

- **Entity Explorer:** Interactive graph visualization (D3.js force-directed layout)
- **Entity Search:** Find entities by type, text, IDF score
- **Relationship Browser:** Show all relationships for selected entity
- **Cross-Document Navigator:** Jump between related documents
- **Graph Analytics Dashboard:** Entity type distribution, top entities by IDF, relationship density

#### 3. Advanced Features

- **Temporal Analysis:** "Show entity mentions over time" (line chart)
- **Community Detection:** Identify entity clusters (Louvain algorithm)
- **Path Finding:** "Find shortest path between Entity A and Entity B"
- **Graph Embeddings:** Node2Vec for entity similarity beyond co-occurrence
- **Multi-hop Recommendations:** "Users who viewed Entity X also viewed..."

---

## References

### Files

| File                                                                    | Purpose                                        |
| ----------------------------------------------------------------------- | ---------------------------------------------- |
| `apps/search-ai/src/workers/knowledge-graph-worker.ts`                  | Worker entry point                             |
| `apps/search-ai/src/services/knowledge-graph/index.ts`                  | Main service orchestration                     |
| `apps/search-ai/src/services/knowledge-graph/entity-extractor.ts`       | Entity extraction (regex, compromise, hybrid)  |
| `apps/search-ai/src/services/knowledge-graph/reference-extractor.ts`    | Reference extraction (contract, exhibit, etc.) |
| `apps/search-ai/src/services/knowledge-graph/co-occurrence-analyzer.ts` | Co-occurrence analysis with IDF weighting      |
| `apps/search-ai/src/services/knowledge-graph/neo4j-client.ts`           | Neo4j database client                          |
| `apps/search-ai/src/__tests__/knowledge-graph.test.ts`                  | Unit tests                                     |
| `apps/search-ai/src/config/index.ts`                                    | Configuration schema                           |

### Related Documentation

- [Worker Pipeline Overview](./14-worker-pipeline-detailed.md) — Knowledge graph worker in context
- [Architecture Overview](./10-architecture-overview.md) — System-wide architecture
- [Embedding Generation](./TBD-18-embedding-generation-guide.md) — Parallel stage 7 (not yet documented)

### External Resources

- [Neo4j Cypher Query Language](https://neo4j.com/docs/cypher-manual/current/) — Official Cypher reference
- [Compromise NLP](https://github.com/spencermountain/compromise) — JavaScript NLP library
- [IDF (Inverse Document Frequency)](https://en.wikipedia.org/wiki/Tf%E2%80%93idf) — TF-IDF algorithm

---

**Documentation Status:** ✅ Complete
**Last Verified:** 2026-02-24
**Next Review:** 2026-Q2 (after API endpoints added)
