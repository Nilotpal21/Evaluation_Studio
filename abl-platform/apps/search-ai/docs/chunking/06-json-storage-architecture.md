# JSON Storage Architecture & Chunk Schema

**Version:** 1.0
**Last Updated:** 2026-02-24
**Status:** Production

---

## Overview

This document answers the critical question: **"Where is JSON data actually stored?"**

JSON data in ATLAS Search uses a **hybrid storage architecture** with different strategies based on JSON structure:

- **Nested JSON:** SearchChunk in MongoDB + Embedding + Path index in ClickHouse
- **Tabular JSON:** Metadata chunk in MongoDB + Full data in ClickHouse (no row chunks)

**This is NOT a vector database** — it's a hybrid architecture using MongoDB (document store), MongoDB Atlas Vector Search (vector index), and ClickHouse (column store).

---

## Storage Architecture Decision Tree

```
┌─────────────────────────────┐
│ JSON File Uploaded          │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│ Is JSON tabular?            │
│ (array of flat objects)     │
└──────────┬──────────────────┘
           │
      ┌────┴────┐
     YES       NO
      │         │
      ▼         ▼
┌──────────┐ ┌──────────────┐
│ Tabular  │ │ Nested       │
│ Storage  │ │ Storage      │
└──────────┘ └──────────────┘
      │              │
      ▼              ▼
MongoDB:          MongoDB:
- 1 metadata      - 1-N chunks
  chunk             (full objects)
                  - Embedding per
ClickHouse:         chunk
- All rows
- Table           ClickHouse:
  metadata        - All paths
                    extracted
```

---

## Storage Architecture 1: Tabular JSON

**Applies To:** JSON arrays of flat objects (table-like structure)

### Detection Criteria

```typescript
function isTabular(data: any): boolean {
  // 1. Must be an array
  if (!Array.isArray(data)) return false;

  // 2. All elements must be objects
  if (!data.every((item) => typeof item === 'object' && item !== null)) {
    return false;
  }

  // 3. Schema must be uniform (all objects have same keys)
  const firstKeys = Object.keys(data[0]).sort();
  const schemaUniform = data.every((item) => {
    const keys = Object.keys(item).sort();
    return JSON.stringify(keys) === JSON.stringify(firstKeys);
  });

  if (!schemaUniform) return false;

  // 4. Max depth ≤ 2 (flat objects only)
  const maxDepth = Math.max(...data.map((item) => getObjectDepth(item)));
  return maxDepth <= 2;
}
```

### Storage Layout

#### MongoDB: SearchChunk Collection

**ONE metadata chunk per table** (not one chunk per row!)

```typescript
{
  _id: "chunk-uuid-001",
  tenantId: "tenant-123",
  indexId: "index-456",
  documentId: "table-789",  // tableId used as documentId
  sourceId: "table-789",    // tableId
  chunkIndex: 0,
  chunkType: "table_metadata",
  status: "pending",        // → "embedded" after embedding

  // Content: JSON-stringified metadata chunk
  content: JSON.stringify({
    tableName: "users",
    displayName: "User Records",
    description: "Customer user accounts with profile data",
    schema: {
      columns: [
        { name: "id", type: "integer", description: "User ID" },
        { name: "name", type: "string", description: "Full name" },
        { name: "email", type: "string", description: "Email address" },
        { name: "created_at", type: "datetime", description: "Account creation date" }
      ],
      primaryKey: "id"
    },
    sampleRows: [
      { id: 1, name: "Alice Johnson", email: "alice@example.com", created_at: "2024-01-15" },
      { id: 2, name: "Bob Smith", email: "bob@example.com", created_at: "2024-01-20" },
      // ... 8-18 more representative samples
    ],
    statistics: {
      totalRows: 100000,
      columnCount: 4,
      uniqueValues: { id: 100000, name: 99500, email: 100000 }
    }
  }),

  contentPreview: "Table: users (100000 rows, 4 columns)",

  metadata: {
    tableId: "table-789",
    tableName: "users",
    displayName: "User Records",
    rowCount: 100000,
    columnCount: 4,
    primaryKey: "id",
    sampleRowCount: 20,
    chunkingStrategy: "metadata-only",
    savingsPercent: 99.999  // 100K rows → 1 chunk = 99.999% reduction
  },

  embedding: [0.123, -0.456, ...],  // 1024 or 3072 dimensions
  tokenCount: 450,
  vectorId: "vector-001",  // Atlas Vector Search ID

  createdAt: "2024-02-24T10:00:00Z",
  updatedAt: "2024-02-24T10:05:00Z"
}
```

**Key Points:**

- ✅ ONE chunk per table (not per row)
- ✅ `content` field stores JSON-stringified metadata (schema + samples)
- ✅ `chunkType: "table_metadata"` distinguishes from document chunks
- ✅ All standard SearchChunk fields present (tenantId, indexId, etc.)
- ❌ NO row-level chunks created (99.999% chunk reduction)

#### ClickHouse: structured_data Table

**All rows stored here** (not in MongoDB!)

```sql
CREATE TABLE structured_data (
  tenant_id String,
  index_id String,
  table_id String,
  row_id String,
  row_data String,  -- JSON-stringified row
  created_at DateTime,
  updated_at DateTime
) ENGINE = MergeTree()
ORDER BY (tenant_id, index_id, table_id, row_id);
```

**Example Rows:**

```sql
INSERT INTO structured_data VALUES
('tenant-123', 'index-456', 'table-789', 'row-1', '{"id":1,"name":"Alice Johnson","email":"alice@example.com","created_at":"2024-01-15"}', now(), now()),
('tenant-123', 'index-456', 'table-789', 'row-2', '{"id":2,"name":"Bob Smith","email":"bob@example.com","created_at":"2024-01-20"}', now(), now()),
-- ... 99,998 more rows
```

**Key Points:**

- ✅ All 100K rows stored in ClickHouse (column-oriented, compressed)
- ✅ Fast SQL queries (<100ms for filtered selects)
- ✅ Supports JOINs across tables
- ✅ Tenant isolation enforced in WHERE clauses

#### ClickHouse: table_metadata Table

**Metadata for table discovery**

```sql
CREATE TABLE table_metadata (
  table_id String,
  table_name String,
  display_name String,
  tenant_id String,
  index_id String,
  columns String,  -- JSON array of column names
  column_types String,  -- JSON array of types
  primary_key String,
  row_count UInt64,
  table_description String,
  column_descriptions String,  -- JSON map
  statistics String,  -- JSON object
  sample_rows String,  -- JSON array
  foreign_keys String,  -- JSON array
  searchable_text String,  -- For text search
  created_at DateTime,
  updated_at DateTime
) ENGINE = MergeTree()
ORDER BY (tenant_id, index_id, table_id);
```

**Example:**

```sql
INSERT INTO table_metadata VALUES (
  'table-789',
  'users',
  'User Records',
  'tenant-123',
  'index-456',
  '["id","name","email","created_at"]',
  '["integer","string","string","datetime"]',
  'id',
  100000,
  'Customer user accounts with profile data',
  '{"id":"User ID","name":"Full name","email":"Email address","created_at":"Account creation date"}',
  '{"uniqueValues":{"id":100000,"name":99500,"email":100000}}',
  '[{"id":1,"name":"Alice Johnson",...}, ...]',
  '[]',
  'users User Records Customer user accounts id name email created_at',
  now(),
  now()
);
```

### Embedding Generation (Tabular JSON)

**What is embedded:** Metadata chunk content only (not individual rows)

**Embedding Input:**

```typescript
const embeddingText = [
  metadataChunk.tableName, // "users"
  metadataChunk.displayName, // "User Records"
  metadataChunk.description, // "Customer user accounts..."
  ...metadataChunk.schema.columns.map(
    (c) => `${c.name}: ${c.description}`, // "id: User ID", "name: Full name"
  ),
  JSON.stringify(metadataChunk.sampleRows.slice(0, 5)), // First 5 samples
].join('\n\n');

const embedding = await embeddingProvider.embed(embeddingText);
```

**Result:** 1024 or 3072-dimensional vector stored in `SearchChunk.embedding`

**Purpose:** Semantic table discovery

- User query: "find user email addresses"
- Vector search finds metadata chunk with high similarity
- System generates SQL: `SELECT email FROM structured_data WHERE table_id = 'table-789'`
- Query executes against ClickHouse data

### Retrieval Flow (Tabular JSON)

```
User Query: "show users from California with age > 30"
     │
     ▼
Query Router → Classifies as "SQL query"
     │
     ▼
Table Discovery (Semantic Search on Metadata Chunks)
     │
     ├─ Embed query: [0.789, -0.123, ...]
     ├─ Vector search MongoDB SearchChunk (chunkType: "table_metadata")
     ├─ Find top match: "users" table
     │
     ▼
Text-to-SQL Service
     │
     ├─ Input: query + table schema from metadata chunk
     ├─ Generate SQL:
     │    SELECT * FROM structured_data
     │    WHERE tenant_id = 'tenant-123'
     │      AND index_id = 'index-456'
     │      AND table_id = 'table-789'
     │      AND JSON_EXTRACT(row_data, '$.state') = 'CA'
     │      AND CAST(JSON_EXTRACT(row_data, '$.age') AS Int32) > 30
     │
     ▼
ClickHouse Execution → Returns actual rows (not chunks!)
     │
     ▼
Return results to user
```

---

## Storage Architecture 2: Nested JSON

**Applies To:** Deeply nested JSON objects, API responses, configurations

### Detection Criteria

**NOT tabular** if any of:

- Not an array
- Array elements are not objects
- Schema is not uniform
- Max depth > 2

### Storage Layout

#### MongoDB: SearchChunk Collection

**One or more chunks per JSON object** (depending on size)

**Case 1: Small Nested JSON (< 8000 tokens) → Single Chunk**

```typescript
{
  _id: "chunk-uuid-002",
  tenantId: "tenant-123",
  indexId: "index-456",
  documentId: "json-doc-890",  // Unique per JSON file/object
  sourceId: "json-doc-890",
  chunkIndex: 0,
  chunkType: "json_object",
  status: "pending",

  // Content: Full JSON object as string
  content: JSON.stringify({
    userId: "user-456",
    profile: {
      name: "Alice Johnson",
      email: "alice@example.com",
      address: {
        street: "123 Main St",
        city: "San Francisco",
        state: "CA",
        coordinates: { lat: 37.7749, lon: -122.4194 }
      }
    },
    orders: [
      { id: "order-1", total: 99.99, status: "completed" },
      { id: "order-2", total: 149.99, status: "pending" }
    ],
    metadata: {
      createdAt: "2024-01-15T10:00:00Z",
      lastLogin: "2024-02-24T08:30:00Z"
    }
  }),

  contentPreview: "User profile: Alice Johnson (user-456)",

  metadata: {
    objectId: "json-doc-890",
    objectType: "user_profile",
    topLevelKeys: ["userId", "profile", "orders", "metadata"],
    depth: 4,
    chunkingStrategy: "single",
    totalTokens: 450
  },

  embedding: [0.234, -0.567, ...],  // Full object embedded
  tokenCount: 450,
  vectorId: "vector-002",

  createdAt: "2024-02-24T10:00:00Z",
  updatedAt: "2024-02-24T10:05:00Z"
}
```

**Case 2: Large Nested JSON (> 8000 tokens with overflow fields) → Multiple Chunks**

**Metadata Chunk:**

```typescript
{
  _id: "chunk-uuid-003",
  chunkIndex: 0,
  chunkType: "json_object",

  // Content: Object with large fields truncated
  content: JSON.stringify({
    apiId: "api-789",
    name: "Product Catalog API",
    version: "2.0",
    description: "[OVERFLOW - see chunk 1]",  // Large field truncated
    endpoints: { /* full structure */ },
    schema: { /* full structure */ }
  }),

  metadata: {
    chunkingStrategy: "overflow",
    overflowFields: ["description"]
  },

  embedding: [0.345, -0.678, ...]
}
```

**Overflow Chunk:**

```typescript
{
  _id: "chunk-uuid-004",
  chunkIndex: 1,
  chunkType: "json_field_overflow",

  // Content: Text from overflow field (sentence-aligned)
  content: "The Product Catalog API provides comprehensive access to our entire product database. It supports advanced filtering, full-text search, pagination, and real-time inventory updates. The API is RESTful and returns JSON responses...",

  metadata: {
    fieldPath: "description",
    parentChunkId: "chunk-uuid-003",
    overflowChunkIndex: 0
  },

  embedding: [0.456, -0.789, ...]
}
```

**Key Points:**

- ✅ Small objects: 1 chunk (entire object)
- ✅ Large objects: 1 metadata chunk + N overflow chunks
- ✅ Each chunk gets its own embedding
- ✅ `chunkType` distinguishes object vs overflow

#### ClickHouse: json_path_index Table

**All paths extracted for hierarchical queries**

```sql
CREATE TABLE json_path_index (
  tenant_id String,
  index_id String,
  object_id String,
  path String,                    -- Original path: users[0].profile.email
  path_normalized String,         -- Normalized: users[].profile.email
  path_tokens Array(String),      -- ['users', 'profile', 'email']
  depth UInt8,                    -- Nesting level: 3
  value_type String,              -- 'string', 'number', 'boolean', 'object', 'array'
  value_text String,              -- For string/number values
  value_number Float64,           -- For numeric values (nullable)
  parent_path String,             -- users[].profile
  has_children Boolean,           -- Does this path have nested fields?
  created_at DateTime
) ENGINE = MergeTree()
ORDER BY (tenant_id, index_id, object_id, path_normalized);
```

**Example Paths (from user profile JSON):**

```sql
INSERT INTO json_path_index VALUES
('tenant-123', 'index-456', 'json-doc-890', 'userId', 'userId', ['userId'], 1, 'string', 'user-456', NULL, '', false, now()),
('tenant-123', 'index-456', 'json-doc-890', 'profile.name', 'profile.name', ['profile','name'], 2, 'string', 'Alice Johnson', NULL, 'profile', false, now()),
('tenant-123', 'index-456', 'json-doc-890', 'profile.email', 'profile.email', ['profile','email'], 2, 'string', 'alice@example.com', NULL, 'profile', false, now()),
('tenant-123', 'index-456', 'json-doc-890', 'profile.address.city', 'profile.address.city', ['profile','address','city'], 3, 'string', 'San Francisco', NULL, 'profile.address', false, now()),
('tenant-123', 'index-456', 'json-doc-890', 'profile.address.coordinates.lat', 'profile.address.coordinates.lat', ['profile','address','coordinates','lat'], 4, 'number', '37.7749', 37.7749, 'profile.address.coordinates', false, now()),
('tenant-123', 'index-456', 'json-doc-890', 'orders[0].id', 'orders[].id', ['orders','id'], 2, 'string', 'order-1', NULL, 'orders', false, now()),
('tenant-123', 'index-456', 'json-doc-890', 'orders[0].total', 'orders[].total', ['orders','total'], 2, 'number', '99.99', 99.99, 'orders', false, now());
-- ... all paths extracted
```

**Key Points:**

- ✅ Every field in JSON becomes a path entry
- ✅ Array indices normalized (`users[0]` → `users[]`)
- ✅ Enables path-based queries
- ✅ Value indexed for filtering

### Embedding Generation (Nested JSON)

**What is embedded:** Full JSON object + all paths (for single chunk)

**Embedding Input:**

```typescript
const embeddingText = [
  JSON.stringify(jsonObject, null, 2), // Full object
  '--- Paths ---',
  ...extractedPaths.map((p) => `${p.path}: ${p.value_text}`),
].join('\n');

const embedding = await embeddingProvider.embed(embeddingText);
```

**For overflow chunks:** Only the specific field content is embedded.

### Retrieval Flow (Nested JSON)

**Semantic Query:**

```
User Query: "find users in San Francisco"
     │
     ▼
Query Router → Classifies as "semantic"
     │
     ▼
Vector Search MongoDB SearchChunk
     │
     ├─ Embed query: [0.890, -0.234, ...]
     ├─ Search chunkType: "json_object"
     ├─ Find top matches (cosine similarity)
     │
     ▼
Return matched chunks (full JSON objects)
```

**Path-Based Query:**

```
User Query: "users with orders[].total > 100"
     │
     ▼
Query Router → Classifies as "path_query"
     │
     ▼
Path Query Service → Query ClickHouse json_path_index
     │
     ├─ SELECT object_id FROM json_path_index
     │   WHERE tenant_id = ? AND index_id = ?
     │     AND path_normalized = 'orders[].total'
     │     AND value_number > 100
     │
     ▼
Fetch SearchChunk by object_id from MongoDB
     │
     ▼
Return matched objects
```

---

## Chunk Schema Reference

### SearchChunk Schema (MongoDB)

```typescript
interface ISearchChunk {
  _id: string; // UUID v7
  tenantId: string; // Tenant identifier (REQUIRED)
  indexId: string; // Index identifier (REQUIRED)
  documentId: string; // Document/table/object ID
  sourceId: string; // Original source ID
  chunkIndex: number; // Position within document (0-based)
  chunkType: string; // 'table_metadata' | 'json_object' | 'json_field_overflow' | 'page' | ...
  status: string; // 'pending' | 'embedded' | 'failed'

  content: string; // Actual content (text or JSON string)
  contentPreview: string; // Short preview for UI
  tokenCount: number; // Token count for this chunk

  embedding: number[] | null; // Vector embedding (1024 or 3072 dims)
  vectorId: string | null; // Atlas Vector Search ID

  metadata: any; // Format-specific metadata
  canonicalMetadata: any | null; // Normalized metadata

  createdAt: Date;
  updatedAt: Date;
  _v: number; // Version
}
```

### Metadata Structure (Tabular JSON)

```typescript
{
  tableId: string;
  tableName: string;
  displayName: string;
  rowCount: number;
  columnCount: number;
  primaryKey: string;
  sampleRowCount: number;
  chunkingStrategy: 'metadata-only';
  savingsPercent: number; // 99.9% typical
}
```

### Metadata Structure (Nested JSON)

```typescript
{
  objectId: string;
  objectType?: string;
  topLevelKeys: string[];
  depth: number;
  chunkingStrategy: 'single' | 'overflow';
  totalTokens: number;
  overflowFields?: string[];      // If chunking strategy = 'overflow'
}
```

---

## Storage Comparison

| Aspect               | Tabular JSON                     | Nested JSON                      |
| -------------------- | -------------------------------- | -------------------------------- |
| **MongoDB Chunks**   | 1 metadata chunk per table       | 1-N chunks per object            |
| **ClickHouse Data**  | All rows in `structured_data`    | Paths in `json_path_index`       |
| **Embedding**        | Metadata only (schema + samples) | Full object (+paths)             |
| **Chunk Reduction**  | 99.999% (100K rows → 1 chunk)    | Variable (depends on size)       |
| **Query Strategy**   | Text-to-SQL → ClickHouse         | Semantic search or path queries  |
| **Typical Use Case** | Large tables (CSV-like data)     | API responses, configs, profiles |

---

## Fields Used for Embedding Generation

### Summary Table

| JSON Type             | Embedded Fields                   | Source                            | Storage Location    |
| --------------------- | --------------------------------- | --------------------------------- | ------------------- |
| **Tabular**           | Table metadata                    | `content` field of metadata chunk | MongoDB SearchChunk |
| **Nested (single)**   | Full JSON object                  | `content` field                   | MongoDB SearchChunk |
| **Nested (overflow)** | Per chunk: metadata or field text | `content` field of each chunk     | MongoDB SearchChunk |

### Detailed Breakdown

#### Tabular JSON Embedding

**Input:**

```typescript
const embeddingText = [
  metadataChunk.tableName,
  metadataChunk.displayName,
  metadataChunk.description,
  ...metadataChunk.schema.columns.map((c) => `${c.name}: ${c.description}`),
  JSON.stringify(metadataChunk.sampleRows.slice(0, 5)),
].join('\n\n');
```

**Example:**

```
users
User Records
Customer user accounts with profile data

id: User ID
name: Full name
email: Email address
created_at: Account creation date

[{"id":1,"name":"Alice Johnson","email":"alice@example.com"},...]
```

**Result:** Single embedding for entire table (not per row)

#### Nested JSON Embedding (Single Chunk)

**Input:**

```typescript
const embeddingText = [
  JSON.stringify(jsonObject, null, 2),
  '--- Extracted Paths ---',
  ...extractedPaths.map((p) => `${p.path}: ${p.value_text}`),
].join('\n');
```

**Example:**

```json
{
  "userId": "user-456",
  "profile": {
    "name": "Alice Johnson",
    "email": "alice@example.com",
    "address": {
      "city": "San Francisco"
    }
  }
}
--- Extracted Paths ---
userId: user-456
profile.name: Alice Johnson
profile.email: alice@example.com
profile.address.city: San Francisco
```

**Result:** Single embedding for entire object + paths

#### Nested JSON Embedding (Overflow)

**Metadata Chunk Input:**

```typescript
const embeddingText = JSON.stringify(objectWithoutOverflowFields, null, 2);
```

**Overflow Chunk Input:**

```typescript
const embeddingText = overflowFieldTextContent;
// Example: Long description field, sentence-aligned chunks
```

**Result:** Separate embeddings for metadata chunk and each overflow chunk

---

## Vector Search vs ClickHouse

**Common Misconception:** "JSON is stored in a vector database"

**Reality:** Hybrid architecture

### What is NOT a Vector Database

- MongoDB is a **document store** (stores JSON documents)
- MongoDB Atlas Vector Search is a **vector index** (built on top of MongoDB)
- ClickHouse is a **column-oriented database** (for analytics)

### What Actually Happens

1. **MongoDB SearchChunk collection:**
   - Stores chunk content (text or JSON string)
   - Stores embedding vector (1024 or 3072 floats)
   - Indexed by tenantId + indexId

2. **MongoDB Atlas Vector Search:**
   - Builds vector index on `embedding` field
   - Enables fast cosine similarity search
   - Returns matching chunk IDs

3. **ClickHouse:**
   - Stores actual data rows (for tabular JSON)
   - Stores path index (for nested JSON)
   - Executes SQL queries, path queries

### Query Flow

**Semantic Query:**

```
User Query
  → Embed query (LLM/embedding service)
  → Vector search (MongoDB Atlas Vector Search on SearchChunk.embedding)
  → Retrieve chunks (MongoDB SearchChunk.content)
  → Return results
```

**SQL Query (Tabular):**

```
User Query
  → Classify as SQL (query router)
  → Semantic search for table (MongoDB Atlas Vector Search)
  → Generate SQL (text-to-SQL with table schema)
  → Execute SQL (ClickHouse structured_data table)
  → Return rows (not chunks!)
```

**Path Query (Nested):**

```
User Query
  → Parse path pattern (e.g., "users[].email")
  → Query path index (ClickHouse json_path_index)
  → Get matching object IDs
  → Fetch chunks (MongoDB SearchChunk)
  → Return full objects
```

---

## Security & Tenant Isolation

**CRITICAL:** Every query MUST include tenant + index filters

### Correct (Secure)

```typescript
// ✅ CORRECT: DB-level filtering
const chunks = await SearchChunk.find({
  _id: { $in: chunkIds },
  tenantId,
  indexId,
});
```

### Incorrect (Security Violation)

```typescript
// ❌ WRONG: No tenant filter (timing side-channel)
const chunks = await SearchChunk.find({ _id: { $in: chunkIds } });
if (chunks[0]?.tenantId !== tenantId) {
  throw new Error('Unauthorized');
}
```

**See:** [Tenant Isolation Guide](./11-security-tenant-isolation.md)

---

## Performance Characteristics

### MongoDB Queries

| Operation                 | Latency | Notes               |
| ------------------------- | ------- | ------------------- |
| Find chunk by ID + tenant | <10ms   | Indexed lookup      |
| Vector search (top 10)    | <100ms  | Atlas Vector Search |
| Bulk fetch chunks         | <50ms   | Batch retrieval     |

### ClickHouse Queries

| Operation            | Latency | Notes               |
| -------------------- | ------- | ------------------- |
| Single table SELECT  | <50ms   | 10K-100K rows       |
| 2-table JOIN         | <100ms  | With filters        |
| Path query (exact)   | <30ms   | Indexed path lookup |
| Path query (pattern) | <100ms  | Wildcard matching   |

### Storage Efficiency

| Scenario              | Naive Approach | Optimized (Metadata-Only)  | Savings          |
| --------------------- | -------------- | -------------------------- | ---------------- |
| 100K row CSV          | 100K chunks    | 1 chunk                    | 99.999%          |
| 10K JSON objects      | 10K chunks     | 10K chunks                 | 0% (but smaller) |
| Large JSON (overflow) | 1 giant chunk  | 1 metadata + N text chunks | Better quality   |

---

## Troubleshooting

### Issue: Can't find JSON data

**Symptoms:** Query returns no results for known data

**Diagnosis:**

1. Check if JSON was detected as tabular or nested
2. For tabular: Query ClickHouse `structured_data` table
3. For nested: Query MongoDB SearchChunk with `chunkType: 'json_object'`

**Solution:**

```typescript
// Check chunk type
const chunk = await SearchChunk.findOne({
  documentId: jsonDocId,
  tenantId,
  indexId,
});

console.log('Chunk type:', chunk.chunkType);
// 'table_metadata' → data in ClickHouse
// 'json_object' → data in MongoDB chunk.content
```

### Issue: Embedding not generated

**Symptoms:** `SearchChunk.embedding` is null

**Diagnosis:**

1. Check chunk status (`pending` vs `embedded`)
2. Check embedding worker logs
3. Verify embedding job was enqueued

**Solution:**

```typescript
// Check status
const chunks = await SearchChunk.find({
  tenantId,
  indexId,
  status: 'pending',
});

console.log(`${chunks.length} chunks still pending embedding`);

// Manually trigger embedding
const embeddingQueue = createQueue('embedding');
await embeddingQueue.add('embed-retry', {
  indexId,
  documentId,
  chunkIds: chunks.map((c) => String(c._id)),
  tenantId,
});
```

### Issue: Path queries not working

**Symptoms:** Path-based query returns no results

**Diagnosis:**

1. Check if path index populated in ClickHouse
2. Verify path normalization (array indices → `[]`)
3. Check tenant + index filters

**Solution:**

```sql
-- Check path index
SELECT COUNT(*), path_normalized
FROM json_path_index
WHERE tenant_id = 'tenant-123'
  AND index_id = 'index-456'
  AND object_id = 'json-doc-890'
GROUP BY path_normalized
ORDER BY COUNT(*) DESC;

-- Should show all extracted paths
```

---

## Related Documentation

- [JSON Nested Guide](./03-structured-json-nested.md) - Hierarchical processing details
- [JSON Tabular Guide](./04-structured-json-tabular.md) - Table processing details
- [CSV Guide](./02-structured-csv.md) - Similar metadata-only strategy
- [Tenant Isolation](./11-security-tenant-isolation.md) - Security patterns
- [Retrieval Checklist](./20-retrieval-checklist.md) - Query optimization

---

## Summary

**Storage Model:**

- ✅ **MongoDB SearchChunk:** Stores all chunk content + embeddings
- ✅ **MongoDB Atlas Vector Search:** Vector index for semantic search
- ✅ **ClickHouse:** Stores actual data (tabular) or path index (nested)

**NOT a vector database** — it's a hybrid architecture optimized for both semantic search and analytical queries.

**Tabular JSON:** 99.999% chunk reduction (1 metadata chunk, all data in ClickHouse)

**Nested JSON:** Full object semantic search + path-based queries

**Embeddings:** Generated from metadata (tabular) or full objects (nested), stored in `SearchChunk.embedding` field

---

**Next:** [Language Support Matrix](./12-language-support-matrix.md) →
