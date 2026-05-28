# Hierarchical Tree Extraction for Structured Data - Design Document

## Executive Summary

This document outlines the design for hierarchical tree representation and path-based querying for structured data formats (JSON, CSV, XML) in the ATLAS search platform.

**Current State:**

- ✅ JSON objects stored as monolithic chunks (good for semantic search, poor for path-based queries)
- ✅ CSV tables stored with metadata-only chunking (queryable via text-to-SQL)
- ❌ No XML support
- ❌ No path-based querying for nested structures

**Proposed Solution:**

- Hybrid approach: Store full objects + create path index for queryability
- Leverage existing ClickHouse infrastructure for path-based analytics
- Minimal MongoDB schema changes

---

## 1. Requirements Analysis

### 1.1 JSON Requirements

- [x] Nested structure preservation (already implemented)
- [ ] JSON path indexing for queryability (e.g., `users[0].name`)
- [ ] Array element handling with path-based access
- [x] Object-based chunking (already implemented)
- [ ] Support for querying by path

### 1.2 CSV Requirements

- [x] Table-aware extraction with column types (already implemented)
- [x] Row-based chunking with metadata (already implemented)
- [x] Support for relational queries via text-to-SQL (already implemented)
- [x] Header detection and preservation (already implemented)

### 1.3 XML Requirements

- [ ] Element hierarchy preservation
- [ ] Attribute handling
- [ ] Parent-child relationships
- [ ] XPath-like querying support
- [ ] Structure-aware chunking by element boundaries

### 1.4 Common Requirements

- [ ] Hierarchical tree representation in database
- [ ] Parent-child relationships for nested structures
- [ ] Path-based querying and filtering
- [x] Structure-preserving chunking strategies (partial)
- [ ] Search/retrieval across hierarchy levels

---

## 2. Architectural Options

### Option A: MongoDB Native JSON Queries

**Approach:** Store JSON in MongoDB SearchChunk.content field, use `$` operator for path queries

**Pros:**

- Zero schema changes
- Native MongoDB JSON query support
- Fast for simple path queries

**Cons:**

- Limited analytics capabilities
- No aggregation across paths
- Poor performance for complex path patterns
- Not suitable for large-scale analytics

**Verdict:** ❌ Not recommended - doesn't scale for analytics use cases

---

### Option B: Flatten Everything to Relational

**Approach:** Convert all JSON/XML to table format, store in ClickHouse

**Pros:**

- Consistent query interface (SQL for everything)
- Excellent analytics performance
- Leverages existing text-to-SQL infrastructure

**Cons:**

- Loses semantic meaning of nested structures
- Complex schema inference for arbitrary JSON
- Cannot represent recursive structures
- Difficult to reconstruct original object

**Verdict:** ❌ Not recommended - loses structure semantics

---

### Option C: Hybrid - Full Object + Path Index (RECOMMENDED)

**Approach:**

1. Store full JSON/XML objects as chunks (semantic search via embeddings)
2. Create separate path index in ClickHouse for analytics queries
3. Route queries: semantic → vector search, path-based → ClickHouse path index

**Pros:**

- Best of both worlds: semantic search + structured queries
- Leverages existing infrastructure
- Scalable for analytics
- Preserves original structure
- Supports both retrieval patterns

**Cons:**

- Dual storage (acceptable tradeoff)
- Requires query routing logic
- More complex implementation

**Verdict:** ✅ RECOMMENDED

---

## 3. Detailed Design (Option C)

### 3.1 Storage Architecture

```
┌─────────────────────────────────────────────────────────┐
│ MongoDB: SearchChunk Collection                          │
│ - Full JSON/XML objects as chunks                       │
│ - Embedded for semantic search                          │
│ - Used for result retrieval                             │
└─────────────────────────────────────────────────────────┘
                      ▲
                      │ Object retrieval
                      │
┌─────────────────────────────────────────────────────────┐
│ Query Router                                             │
│ - Detects path-based queries (users[0].name)            │
│ - Detects semantic queries (find user profiles)         │
│ - Routes to appropriate backend                         │
└─────────────────────────────────────────────────────────┘
      │                                      │
      │ Semantic query                       │ Path query
      ▼                                      ▼
┌──────────────────┐              ┌──────────────────────┐
│ Vector Search    │              │ ClickHouse Path Index│
│ (embeddings)     │              │ (structured queries) │
└──────────────────┘              └──────────────────────┘
```

### 3.2 ClickHouse Path Index Schema

```sql
CREATE TABLE json_path_index (
    -- Isolation
    tenant_id String,
    index_id String,

    -- Object identity
    object_id String,         -- Maps to MongoDB chunk documentId
    object_type String,       -- 'json', 'xml'

    -- Path information
    path String,              -- JSON path: 'users[0].name'
    path_normalized String,   -- Normalized: 'users[].name' (for pattern matching)
    depth UInt8,              -- Nesting depth

    -- Value information
    value_type Enum8('string', 'number', 'boolean', 'null', 'object', 'array'),
    value_string Nullable(String),
    value_number Nullable(Float64),
    value_boolean Nullable(UInt8),

    -- Parent-child relationships
    parent_path Nullable(String),

    -- Search optimization
    path_tokens Array(String),  -- Tokenized path for search

    -- Metadata
    created_at DateTime DEFAULT now()
)
ENGINE = MergeTree()
PARTITION BY (tenant_id, toYYYYMM(created_at))
ORDER BY (tenant_id, index_id, object_id, path)
SETTINGS index_granularity = 8192;

-- Index for path pattern matching
CREATE INDEX idx_path_pattern ON json_path_index (path_normalized) TYPE minmax GRANULARITY 4;

-- Index for value search
CREATE INDEX idx_value_string ON json_path_index (value_string) TYPE bloom_filter() GRANULARITY 1;
```

### 3.3 Path Extraction Algorithm

```typescript
interface PathIndexEntry {
  tenantId: string;
  indexId: string;
  objectId: string;
  objectType: 'json' | 'xml';
  path: string;
  pathNormalized: string;
  depth: number;
  valueType: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
  valueString?: string;
  valueNumber?: number;
  valueBoolean?: boolean;
  parentPath?: string;
  pathTokens: string[];
}

class PathExtractor {
  /**
   * Extract all paths from a JSON object
   */
  extractPathsFromJSON(obj: any, basePath: string = ''): PathIndexEntry[] {
    const entries: PathIndexEntry[] = [];
    this.extractRecursive(obj, basePath, entries, 0, null);
    return entries;
  }

  private extractRecursive(
    value: any,
    path: string,
    entries: PathIndexEntry[],
    depth: number,
    parentPath: string | null,
  ): void {
    const valueType = this.inferValueType(value);

    // Create entry for this path
    entries.push({
      path,
      pathNormalized: this.normalizePath(path),
      depth,
      valueType,
      parentPath,
      pathTokens: this.tokenizePath(path),
      ...this.extractValue(value, valueType),
    });

    // Recurse for objects and arrays
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        value.forEach((item, idx) => {
          this.extractRecursive(item, `${path}[${idx}]`, entries, depth + 1, path);
        });
      } else {
        Object.keys(value).forEach((key) => {
          const childPath = path ? `${path}.${key}` : key;
          this.extractRecursive(value[key], childPath, entries, depth + 1, path);
        });
      }
    }
  }

  private normalizePath(path: string): string {
    // Replace array indices with [] for pattern matching
    return path.replace(/\[\d+\]/g, '[]');
  }

  private tokenizePath(path: string): string[] {
    // Split path into searchable tokens
    return path.split(/[\.\[\]]+/).filter(Boolean);
  }
}
```

### 3.4 Query Routing Logic

```typescript
interface QueryIntent {
  type: 'semantic' | 'path' | 'hybrid';
  pathPatterns?: string[];
  semanticQuery?: string;
  confidence: number;
}

class HierarchicalQueryRouter {
  analyzeIntent(query: string): QueryIntent {
    // Detect path-based queries
    const pathPatterns = this.extractPathPatterns(query);

    // Examples of path queries:
    // - "users[0].name" → path query
    // - "all user names" → semantic query (users[].name)
    // - "find users with age > 25" → hybrid (path filter + semantic)

    if (pathPatterns.length > 0 && this.hasExactPath(query)) {
      return {
        type: 'path',
        pathPatterns,
        confidence: 0.9,
      };
    }

    if (pathPatterns.length > 0 && this.hasSemanticIntent(query)) {
      return {
        type: 'hybrid',
        pathPatterns,
        semanticQuery: this.extractSemanticPart(query),
        confidence: 0.7,
      };
    }

    return {
      type: 'semantic',
      semanticQuery: query,
      confidence: 0.8,
    };
  }

  private extractPathPatterns(query: string): string[] {
    // Regex for JSON path patterns: word.word, word[n], word[].word
    const pathRegex = /\b([a-zA-Z_]\w*(?:\[\d*\])?(?:\.[a-zA-Z_]\w*(?:\[\d*\])?)*)/g;
    return [...query.matchAll(pathRegex)].map((m) => m[1]);
  }
}
```

### 3.5 XML Support

XML will be converted to a JSON-like structure for uniform handling:

```xml
<users>
  <user id="1">
    <name>Alice</name>
    <email>alice@example.com</email>
  </user>
</users>
```

→ Converted to path index:

```
users.user[0]@id = "1"
users.user[0].name = "Alice"
users.user[0].email = "alice@example.com"
```

---

## 4. Implementation Plan

### Phase 1: Path Index Infrastructure (Week 1)

1. ✅ Create ClickHouse path index table schema
2. ✅ Implement PathExtractor service
3. ✅ Write tests for path extraction from JSON
4. ✅ Integrate with structured-data-ingestion-worker

### Phase 2: Query Routing (Week 2)

1. Enhance HierarchicalQueryRouter to detect path queries
2. Implement path-based query execution against ClickHouse
3. Implement hybrid query execution (semantic + path filter)
4. Write integration tests

### Phase 3: XML Support (Week 3)

1. Implement XML parser
2. Implement XML-to-path converter
3. Create XML chunking strategy
4. Write tests for XML ingestion

### Phase 4: API Integration (Week 4)

1. Add path-based query endpoints
2. Update search API to support path filters
3. Update UI to display hierarchical results
4. Performance testing and optimization

---

## 5. Query Examples

### Example 1: Exact Path Query

```
Query: "users[0].name"
Intent: path
Execution:
  SELECT value_string
  FROM json_path_index
  WHERE path = 'users[0].name'
    AND tenant_id = 'tenant-123'
    AND index_id = 'index-123'
```

### Example 2: Pattern Path Query

```
Query: "all user names"
Intent: hybrid
Execution:
  1. Convert to path pattern: users[].name
  2. Query ClickHouse:
     SELECT object_id, value_string
     FROM json_path_index
     WHERE path_normalized = 'users[].name'
  3. Retrieve full objects from MongoDB
  4. Rank by semantic relevance
```

### Example 3: Path Filter + Semantic

```
Query: "find users with age > 25 who are developers"
Intent: hybrid
Execution:
  1. Path filter: users[].age > 25 (ClickHouse)
  2. Get matching object_ids
  3. Semantic search on those objects: "developers"
  4. Return ranked results
```

---

## 6. Performance Considerations

### 6.1 Storage Overhead

- **MongoDB**: Full objects (same as current)
- **ClickHouse**: ~10-20 path entries per object on average
- **Estimate**: 1KB object → 10KB path index (10x overhead, acceptable for analytics)

### 6.2 Query Performance

- **Path queries**: Sub-second for millions of objects (ClickHouse MergeTree)
- **Semantic queries**: Unchanged (vector search)
- **Hybrid queries**: Combined latency (100-300ms typical)

### 6.3 Ingestion Performance

- **Path extraction**: 10-50ms per object (depends on depth)
- **ClickHouse insert**: Batched writes (1000s of paths/sec)
- **Overall impact**: +15-20% ingestion time (acceptable)

---

## 7. Migration Strategy

### 7.1 Backward Compatibility

- Existing JSON chunks continue to work for semantic search
- Path index is additive - no breaking changes
- Gradual rollout: new ingestions get path index, old ones remain

### 7.2 Backfill Strategy

- Background job to process existing JSON chunks
- Extract paths and populate ClickHouse index
- Rate-limited to avoid resource contention

---

## 8. Alternatives Considered

### 8.1 Elasticsearch Nested Objects

**Rejected because:**

- Requires adding Elasticsearch to stack
- Not as performant as ClickHouse for analytics
- More complex ops burden

### 8.2 PostgreSQL JSONB

**Rejected because:**

- Limited to MongoDB + Postgres (complexity)
- Not as scalable as ClickHouse
- No existing infrastructure

### 8.3 GraphQL-style Object Graph

**Rejected because:**

- Overkill for path-based queries
- Requires graph database (Neo4j, etc.)
- Not aligned with current architecture

---

## 9. Success Metrics

- ✅ Path-based queries return results in <100ms (p95)
- ✅ Support 10+ levels of nesting
- ✅ Support arrays with 1000+ elements
- ✅ 95%+ query intent classification accuracy
- ✅ Ingestion performance within 20% of current baseline

---

## 10. Open Questions

1. **How to handle extremely deep nesting (20+ levels)?**
   - Answer: Set configurable depth limit (default: 15 levels), truncate beyond

2. **How to handle very large arrays (10k+ elements)?**
   - Answer: Sample large arrays (store first 100, last 100, random 100), mark as sampled

3. **How to handle schema evolution (JSON structure changes over time)?**
   - Answer: Path index is schemaless - new paths are automatically indexed

4. **Security: prevent path-based data leakage across tenants?**
   - Answer: All queries include tenant_id + index_id filters (existing isolation)

---

## 11. References

- [ClickHouse MergeTree Documentation](https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/mergetree)
- [MongoDB JSON Queries](https://www.mongodb.com/docs/manual/reference/operator/query/)
- [JSON Path Specification](https://goessner.net/articles/JsonPath/)
- [XPath for XML](https://www.w3.org/TR/xpath/)
