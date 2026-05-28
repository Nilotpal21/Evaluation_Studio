# Entity-Centric Search Implementation Plan

**Status:** 🚧 Planned
**Target:** Q3 2026
**Owner:** Search AI Team

---

## Overview

Enable search by entity name or entity type, leveraging the knowledge graph to find all documents mentioning specific entities or their relationships.

**Current State:**

- ✅ Entities extracted and stored in Neo4j
- ✅ Can query entities via Neo4j Browser
- ❌ No REST API for entity search

**Goal:** Search by entity ("find all documents about Microsoft") with automatic relationship expansion.

---

## Use Cases

### Use Case 1: Find Documents by Entity

```
Query: "Show me all documents about Microsoft"
Returns: Documents where Microsoft is mentioned
```

### Use Case 2: Find Related Entities

```
Query: "What products are related to Microsoft Azure?"
Returns: Entities with CO_OCCURS relationships to Azure
```

### Use Case 3: Entity Timeline

```
Query: "How has Microsoft been mentioned over time?"
Returns: Entity occurrences grouped by date
```

---

## API Design

**`GET /api/search/:indexId/entities`**

List entities in index.

**`GET /api/search/:indexId/entities/:entityId/documents`**

Find all documents mentioning an entity.

**`POST /api/search/:indexId/entity-query`**

Search documents by entity criteria.

---

## Implementation Plan

### Phase 1: Basic Entity Search (2 weeks)

**Tasks:**

1. Create entity list API
2. Create document lookup by entity
3. Integrate with existing graph service

### Phase 2: Relationship Expansion (1 week)

**Tasks:**

1. Expand search to related entities (1-hop)
2. Weight results by entity IDF and co-occurrence weight

### Phase 3: Integration with Main Search (1 week)

**Tasks:**

1. Add entity filters to vector search
2. Boost results with high-IDF entities
3. Display entity tags in search results

---

**Last Updated:** 2026-02-21
**Status:** Early design phase
