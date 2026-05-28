# Graph-Based Retrieval API Implementation Plan

**Status:** 🚧 Planned
**Target:** Q2 2026
**Owner:** Search AI Team

---

## Overview

Create REST API endpoint for graph-based entity search and relationship traversal using the Neo4j knowledge graph.

**Current State:**

- ✅ Neo4j graph storage (entities, relationships, co-occurrence)
- ✅ Entity extraction pipeline (regex + Compromise NER)
- ✅ Service layer API (`KnowledgeGraphService.findRelatedEntities()`)
- ✅ Queryable via Neo4j Browser (Cypher)
- ❌ No REST API endpoint
- ❌ Not integrated into query pipeline
- ❌ Graph data doesn't influence search results

**Goal:** Enable entity-centric search and relationship-based result expansion via REST API.

---

## API Design

### Endpoint 1: Graph Search

**`POST /api/search/:indexId/graph`**

Search by entity name and traverse relationships.

**Request:**

```json
{
  "entity": "Microsoft",
  "relationshipTypes": ["CO_OCCURS", "REFERENCES"],
  "maxHops": 2,
  "minWeight": 2.0,
  "limit": 20
}
```

**Response:**

```json
{
  "results": [
    {
      "entity": {
        "id": "entity-uuid-123",
        "text": "Azure",
        "type": "PRODUCT",
        "occurrenceCount": 15,
        "idf": 3.2
      },
      "relationship": {
        "type": "CO_OCCURS",
        "weight": 4.5,
        "count": 8
      },
      "path": ["Microsoft", "CO_OCCURS", "Azure"],
      "chunks": [
        {
          "chunkId": "chunk-uuid-456",
          "documentId": "doc-uuid-789",
          "content": "Microsoft Azure provides cloud services...",
          "score": 0.92
        }
      ]
    }
  ],
  "total": 18,
  "latency": {
    "graphTraversal": 45,
    "chunkLookup": 30,
    "totalMs": 75
  }
}
```

### Endpoint 2: Entity-Centric Search

**`POST /api/search/:indexId/entity-search`**

Find all documents mentioning specific entities or entity types.

**Request:**

```json
{
  "entities": ["Microsoft", "Azure"],
  "entityTypes": ["ORGANIZATION", "PRODUCT"],
  "filters": [{ "field": "doc.publishedDate", "operator": "gte", "value": "2025-01-01" }],
  "limit": 20
}
```

---

## Implementation Plan

### Phase 1: Basic Graph API (2 weeks)

**Tasks:**

1. Create `POST /api/search/:indexId/graph` endpoint
2. Implement Cypher query builder for relationship traversal
3. Integrate with existing `KnowledgeGraphService`
4. Return entity and relationship data

**Acceptance Criteria:**

- API returns related entities
- Latency < 100ms for 2-hop traversal
- Proper tenant isolation

### Phase 2: Chunk Enrichment (1 week)

**Tasks:**

1. For each related entity, fetch chunks where it appears
2. Join with MongoDB to get chunk content
3. Return chunks alongside entity data

**Acceptance Criteria:**

- API returns chunks with entity mentions
- Chunks are ranked by entity relevance

### Phase 3: Query Pipeline Integration (1 week)

**Tasks:**

1. Add graph expansion stage after vector search
2. Extract entities from top-K vector results
3. Traverse graph to find related entities
4. Fetch chunks mentioning related entities
5. Merge with vector results (boost or append)

**Acceptance Criteria:**

- Graph data influences search results
- Recall improves by 3-5%

---

## Cypher Query Examples

### Find Related Entities (2-hop)

```cypher
MATCH (e1:Entity {text: 'Microsoft', tenantId: $tenantId, indexId: $indexId})
      -[r:CO_OCCURS*1..2]-(e2:Entity)
WHERE r.weight > 2.0
RETURN DISTINCT e2.text, e2.type, AVG(r.weight) AS avgWeight
ORDER BY avgWeight DESC
LIMIT 20;
```

### Find Documents by Entity

```cypher
MATCH (e:Entity {text: 'Microsoft', tenantId: $tenantId, indexId: $indexId})
RETURN DISTINCT e.documentId, e.chunkId;
```

---

## Performance Considerations

### Graph Traversal Latency

```
1-hop: 20-30ms
2-hop: 40-60ms
3-hop: 80-150ms (not recommended for real-time)
```

**Optimization:**

- Index on `(tenantId, indexId, text)` (already exists)
- Limit traversal depth to 2 hops
- Filter by weight threshold (skip weak edges)

### Scaling

```
Entity count: 100K per index
Edge count: 500K per index
Query throughput: 100 queries/sec (single Neo4j instance)

If exceeds capacity:
- Shard by tenantId
- Read replicas for search (write to primary)
```

---

## Related Work

- [TREE-BASED-RETRIEVAL-PLAN.md](./TREE-BASED-RETRIEVAL-PLAN.md) - Combine tree + graph expansion
- [../design/QUERY-PIPELINE-DESIGN.md](../design/QUERY-PIPELINE-DESIGN.md) - Query pipeline (hybrid search, reranking)

---

**Last Updated:** 2026-02-21
**Status:** Ready for implementation after hybrid retrieval complete
