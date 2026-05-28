# Tree-Based Retrieval Implementation Plan

**Status:** 🚧 Planned
**Target:** Q3 2026
**Owner:** Search AI Team

---

## Overview

Use the hierarchical tree structure (built during ATLAS-KG chunking) to enable scope-aware retrieval at query time.

**Current State:**

- ✅ Tree structure built during ingestion (`tree-building-worker.ts`)
- ✅ Tree metadata stored in MongoDB (parentId, childIds, depth, summary)
- ❌ Tree data NOT in OpenSearch schema
- ❌ Tree NOT used during query processing
- ❌ No hierarchical search API

**Goal:** Navigate tree at query time to return appropriate scope (snippet vs section vs document).

---

## Use Cases

### Use Case 1: Snippet-Level Query

```
Query: "What is the API key rotation period?"
Scope: snippet (single fact)
Return: 1-2 leaf chunks
```

### Use Case 2: Section-Level Query

```
Query: "How does authentication work?"
Scope: section (multi-paragraph explanation)
Return: Parent chunk + 3-5 child chunks
```

### Use Case 3: Document-Level Query

```
Query: "What is this document about?"
Scope: document (high-level summary)
Return: Root summary + top-level section summaries
```

---

## Architecture Design

### Step 1: Initial Vector Search (Implemented ✅)

```
Query → Embedding → OpenSearch k-NN → Top 10 chunks
```

### Step 2: Tree Navigation (NOT Implemented ❌)

**For each top chunk:**

```typescript
function expandByScope(chunk: Chunk, scope: string): Chunk[] {
  switch (scope) {
    case 'snippet':
      return [chunk]; // No expansion

    case 'section':
      // Return parent + siblings
      const parent = db.findParent(chunk.parentId);
      const siblings = db.findSiblings(chunk.parentId);
      return [parent, chunk, ...siblings].slice(0, 5);

    case 'document':
      // Return root + top-level summaries
      const root = db.findRoot(chunk.documentId);
      const topLevel = db.findChildren(root.id);
      return [root, ...topLevel];
  }
}
```

### Step 3: Deduplication & Ranking

```typescript
// Remove duplicates (same chunk returned via different paths)
const unique = deduplicateByChunkId(expandedChunks);

// Re-rank by: original vector score + tree position score
const ranked = unique.map((chunk) => ({
  ...chunk,
  score: chunk.vectorScore * 0.7 + chunk.treeProximityScore * 0.3,
}));

return ranked.sort((a, b) => b.score - a.score).slice(0, 10);
```

---

## Implementation Plan

### Phase 1: Store Tree in OpenSearch (2 weeks)

**Tasks:**

1. Update OpenSearch mappings to include tree fields:
   - `parentChunkId` (keyword)
   - `childChunkIds` (keyword array)
   - `depth` (integer)
   - `summary` (text, not analyzed)
2. Backfill existing indices with tree data from MongoDB
3. Test tree queries

**Acceptance Criteria:**

- Tree fields indexed in OpenSearch
- Can query by parentId

### Phase 2: Tree Navigation Logic (1 week)

**Tasks:**

1. Implement tree expansion functions (parent, children, siblings, root)
2. Add scope classification (already exists in `scope-classification-worker.ts`)
3. Expand top-K results based on scope

**Acceptance Criteria:**

- Snippet queries return 1-2 chunks
- Section queries return 3-5 chunks (parent + children)
- Document queries return root + summaries

### Phase 3: Integration & Testing (1 week)

**Tasks:**

1. Integrate into query pipeline after vector search
2. A/B test: tree-expanded vs flat retrieval
3. Measure latency impact
4. Tune expansion parameters (max children, depth limits)

**Acceptance Criteria:**

- p95 latency < 150ms (including tree navigation)
- Recall improves by 5-10% on section/document queries
- No degradation on snippet queries

---

## OpenSearch Schema Update

**Add to mappings:**

```json
{
  "mappings": {
    "properties": {
      "tree": {
        "type": "object",
        "properties": {
          "parentChunkId": { "type": "keyword" },
          "childChunkIds": { "type": "keyword" },
          "depth": { "type": "integer" },
          "isLeaf": { "type": "boolean" },
          "summary": { "type": "text", "index": false }
        }
      }
    }
  }
}
```

---

## Performance Considerations

### Latency Impact

```
Vector search: 30ms
Tree expansion (MongoDB joins): +50ms per top-K chunk
Total: 30ms + (10 × 50ms) = 530ms (sequential)

Optimized (parallel):
Total: 30ms + 50ms = 80ms (fetch all tree data in one query)
```

**Optimization:** Batch fetch all tree data for top-K chunks in single MongoDB query.

### Storage Impact

```
Tree fields per chunk: ~100 bytes
100M chunks: 10GB additional storage
Cost: $10/month
```

---

## Related Work

- [../design/QUERY-PIPELINE-DESIGN.md](../design/QUERY-PIPELINE-DESIGN.md) - Query pipeline (hybrid search)
- [GRAPH-RETRIEVAL-API-PLAN.md](./GRAPH-RETRIEVAL-API-PLAN.md) - Combine tree + graph expansion

---

**Last Updated:** 2026-02-21
**Status:** Design phase, pending hybrid retrieval completion
