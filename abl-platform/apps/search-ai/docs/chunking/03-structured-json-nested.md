# JSON Nested - Hierarchical Path Extraction

**Applies To:** Nested JSON objects, deeply nested configurations, API responses
**Strategy:** Full object chunking + hierarchical path extraction
**Worker:** `structured-data-ingestion-worker.ts`

---

## Overview

Nested JSON chunking handles complex, hierarchical JSON objects with deep nesting (API responses, config files, user profiles, etc.). Unlike tabular JSON (arrays of flat objects), nested JSON preserves the full object structure while enabling path-based queries.

**Key Features:**

- Full object semantic search (entire JSON embedded as one chunk)
- Path-based queries (`users[0].profile.email`)
- Parent-child relationship tracking
- Deep nesting support (up to 15 levels)
- Array element sampling (for large arrays with 1000+ elements)

**Architecture:**

```
Nested JSON → Parse → Full Object Chunk → Extract Paths → ClickHouse Path Index
      ↓          ↓            ↓                  ↓                  ↓
  Complex     Validate   Store in MongoDB   Generate PathEntry   Enable path
  structure              as SearchChunk     records for every   queries
                                            field in hierarchy
```

---

## When to Use Nested vs Tabular

### Decision Tree

```
┌──────────────────────────┐
│ Is JSON an array of      │
│ flat objects?            │
└─────────┬────────────────┘
          │
     ┌────┴────┐
    YES       NO
     │         │
     ▼         ▼
┌─────────┐ ┌──────────────┐
│ Tabular │ │ Nested       │
│ (04)    │ │ (THIS GUIDE) │
└─────────┘ └──────────────┘
```

### Nested JSON Examples

```json
// User Profile (nested object)
{
  "userId": "user-123",
  "profile": {
    "name": "Alice Johnson",
    "email": "alice@example.com",
    "address": {
      "street": "123 Main St",
      "city": "San Francisco",
      "state": "CA",
      "coordinates": {
        "lat": 37.7749,
        "lon": -122.4194
      }
    }
  },
  "orders": [
    { "id": "order-1", "total": 99.99 },
    { "id": "order-2", "total": 149.99 }
  ]
}
```

```json
// API Response (nested arrays and objects)
{
  "data": {
    "users": [
      {
        "id": 1,
        "name": "Alice",
        "posts": [
          {
            "id": 101,
            "title": "Hello World",
            "comments": [{ "id": 1001, "text": "Great post!" }]
          }
        ]
      }
    ]
  }
}
```

```json
// Configuration File (deeply nested)
{
  "database": {
    "primary": {
      "host": "db.example.com",
      "port": 5432,
      "credentials": {
        "username": "admin",
        "passwordRef": "secret/db-pass"
      }
    },
    "replicas": [
      { "host": "db-replica-1.example.com", "port": 5432 },
      { "host": "db-replica-2.example.com", "port": 5432 }
    ]
  }
}
```

### Tabular JSON Examples (NOT nested - see Guide 04)

```json
// Array of flat objects (treat as CSV)
[
  { "id": 1, "name": "Alice", "email": "alice@example.com" },
  { "id": 2, "name": "Bob", "email": "bob@example.com" },
  { "id": 3, "name": "Charlie", "email": "charlie@example.com" }
]
```

**Rule of Thumb:**

- **Nested:** Object depth > 2, contains nested objects/arrays, not uniform structure
- **Tabular:** Array of objects, depth ≤ 2, uniform schema across all objects

---

## Pipeline Stages

```
┌─────────────────┐
│ 1. Parse JSON   │ → Validate JSON, detect structure type
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. Create Chunk │ → Store full object as SearchChunk in MongoDB
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 3. Extract      │ → Recursively traverse object, extract all paths
│    Paths        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 4. Index Paths  │ → Store path entries in ClickHouse path_index table
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 5. Embed        │ → Generate embedding for full object text
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 6. Query        │ → Semantic search (full object) OR path-based query
└─────────────────┘
```

---

## Stage 1: JSON Parsing

**Worker:** `structured-data-ingestion-worker.ts`

**Process:**

1. **Parse JSON File**

   ```typescript
   const jsonData = JSON.parse(fileBuffer.toString('utf-8'));
   ```

2. **Detect Structure Type**

   ```typescript
   function isTabular(data: any): boolean {
     // Check if top-level is an array
     if (!Array.isArray(data)) return false;

     // Check if all elements are flat objects (depth <= 2)
     return data.every((item) => {
       if (typeof item !== 'object' || item === null) return false;

       // Check depth
       const depth = getMaxDepth(item);
       return depth <= 2;
     });
   }

   if (isTabular(jsonData)) {
     // Route to tabular processing (see guide 04)
   } else {
     // Route to nested processing (THIS GUIDE)
   }
   ```

3. **Validate JSON**
   - Check for circular references
   - Validate max depth (default: 15 levels)
   - Check size limits (default: 10MB per object)

---

## Stage 2: Full Object Chunk Creation

**Purpose:** Store entire JSON object as a single searchable chunk for semantic search.

**Process:**

1. **Generate Object ID**

   ```typescript
   const objectId = generateUniqueId(); // UUID or hash
   ```

2. **Prepare Chunk Content**

   ```typescript
   // Option 1: Store as pretty-printed JSON
   const content = JSON.stringify(jsonData, null, 2);

   // Option 2: Store as flattened text (better for embedding)
   const content = flattenJSONToText(jsonData);
   // Example output:
   // "userId: user-123
   //  profile name: Alice Johnson
   //  profile email: alice@example.com
   //  profile address street: 123 Main St
   //  profile address city: San Francisco
   //  ..."
   ```

3. **Create SearchChunk**
   ```typescript
   const chunk = await SearchChunk.create({
     tenantId,
     indexId,
     documentId: objectId,
     sourceId: objectId,
     chunkIndex: 0,
     chunkType: 'json_nested',
     content: content, // Full JSON text
     contentPreview: generatePreview(jsonData, 200), // First 200 chars
     status: ChunkStatus.PENDING,
     metadata: {
       objectId,
       objectType: 'json',
       maxDepth: calculateDepth(jsonData),
       totalPaths: countPaths(jsonData),
       objectKeys: Object.keys(jsonData),
       dataSize: Buffer.byteLength(content, 'utf-8'),
     },
   });
   ```

**Example:**

**Input JSON:**

```json
{
  "userId": "user-123",
  "profile": {
    "name": "Alice Johnson",
    "email": "alice@example.com"
  }
}
```

**SearchChunk Created:**

```typescript
{
  tenantId: 'tenant-123',
  indexId: 'index-123',
  documentId: 'obj-abc123',
  chunkType: 'json_nested',
  content: `{
  "userId": "user-123",
  "profile": {
    "name": "Alice Johnson",
    "email": "alice@example.com"
  }
}`,
  contentPreview: 'userId: user-123, profile: {name: Alice Johnson, email: alice@example.com}',
  metadata: {
    objectId: 'obj-abc123',
    objectType: 'json',
    maxDepth: 2,
    totalPaths: 4,
    objectKeys: ['userId', 'profile'],
    dataSize: 156
  }
}
```

---

## Stage 3: Hierarchical Path Extraction

**Service:** `PathExtractor`

**Purpose:** Extract every path in the JSON hierarchy for path-based queries.

### Algorithm

```typescript
class PathExtractor {
  extractPathsFromJSON(obj: any, tenantId: string, indexId: string, objectId: string) {
    const entries: PathIndexEntry[] = [];

    this.extractRecursive(
      obj,
      '',        // basePath
      entries,
      0,         // depth
      null,      // parentPath
      tenantId,
      indexId,
      objectId
    );

    return { entries, statistics: {...} };
  }

  private extractRecursive(
    value: any,
    path: string,
    entries: PathIndexEntry[],
    depth: number,
    parentPath: string | null,
    tenantId: string,
    indexId: string,
    objectId: string
  ) {
    // Stop at max depth (default: 15)
    if (depth > this.config.maxDepth) return;

    const valueType = this.inferValueType(value);

    // Create entry for this path
    entries.push({
      tenantId,
      indexId,
      objectId,
      path,
      pathNormalized: this.normalizePath(path),  // users[0].name → users[].name
      depth,
      valueType,
      parentPath,
      pathTokens: this.tokenizePath(path),       // ['users', 'name']
      ...this.extractValue(value, valueType)     // Type-specific value storage
    });

    // Recurse for objects
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        this.extractArray(value, path, entries, depth, tenantId, indexId, objectId);
      } else {
        this.extractObject(value, path, entries, depth, tenantId, indexId, objectId);
      }
    }
  }

  private extractObject(obj: any, basePath: string, entries: PathIndexEntry[], depth: number, ...) {
    for (const [key, value] of Object.entries(obj)) {
      const newPath = basePath ? `${basePath}.${key}` : key;
      this.extractRecursive(value, newPath, entries, depth + 1, basePath, ...);
    }
  }

  private extractArray(arr: any[], basePath: string, entries: PathIndexEntry[], depth: number, ...) {
    // Sample large arrays (>1000 elements)
    const sampled = this.sampleArray(arr);

    for (let i = 0; i < sampled.length; i++) {
      const newPath = `${basePath}[${i}]`;
      this.extractRecursive(sampled[i], newPath, entries, depth + 1, basePath, ...);
    }
  }
}
```

### Path Normalization

**Purpose:** Convert specific array indices to patterns for matching.

```typescript
function normalizePath(path: string): string {
  // users[0].name → users[].name
  // orders[5].items[2].price → orders[].items[].price
  return path.replace(/\[\d+\]/g, '[]');
}
```

**Examples:**

- `profile.name` → `profile.name` (no change)
- `users[0].email` → `users[].email`
- `orders[0].items[0].price` → `orders[].items[].price`
- `config.database.replicas[2].host` → `config.database.replicas[].host`

### Path Tokenization

**Purpose:** Break paths into searchable keywords.

```typescript
function tokenizePath(path: string): string[] {
  // users[0].profile.name → ['users', 'profile', 'name']
  return path
    .replace(/\[\d+\]/g, '') // Remove array indices
    .split('.') // Split by dot
    .filter(Boolean); // Remove empty strings
}
```

### Value Extraction

**Purpose:** Store typed values for efficient querying.

```typescript
interface PathIndexEntry {
  path: string;
  pathNormalized: string;
  valueType: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
  valueString?: string; // For string values
  valueNumber?: number; // For number values
  valueBoolean?: boolean; // For boolean values
  // No value stored for 'object' or 'array' (only structure)
}
```

**Examples:**

```json
{
  "name": "Alice",
  "age": 30,
  "active": true,
  "address": { "city": "SF" },
  "tags": ["user", "premium"]
}
```

**Path Entries Created:**

| path           | pathNormalized | valueType | valueString | valueNumber | valueBoolean |
| -------------- | -------------- | --------- | ----------- | ----------- | ------------ |
| `name`         | `name`         | string    | "Alice"     | null        | null         |
| `age`          | `age`          | number    | null        | 30          | null         |
| `active`       | `active`       | boolean   | null        | null        | true         |
| `address`      | `address`      | object    | null        | null        | null         |
| `address.city` | `address.city` | string    | "SF"        | null        | null         |
| `tags`         | `tags`         | array     | null        | null        | null         |
| `tags[0]`      | `tags[]`       | string    | "user"      | null        | null         |
| `tags[1]`      | `tags[]`       | string    | "premium"   | null        | null         |

---

## Stage 4: ClickHouse Path Index

**Table Schema:**

```sql
CREATE TABLE IF NOT EXISTS json_path_index (
  -- Isolation
  tenant_id String,
  index_id String,

  -- Object identity
  object_id String,
  object_type Enum8('json' = 1, 'xml' = 2),

  -- Path information
  path String,
  path_normalized String,
  depth UInt8,

  -- Value information (typed columns)
  value_type Enum8('string' = 1, 'number' = 2, 'boolean' = 3, 'null' = 4, 'object' = 5, 'array' = 6),
  value_string Nullable(String),
  value_number Nullable(Float64),
  value_boolean Nullable(UInt8),

  -- Parent-child relationships
  parent_path Nullable(String),

  -- Search optimization
  path_tokens Array(String),

  created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (tenant_id, index_id, path_normalized, object_id);
```

**Indexing Strategy:**

- **Primary index:** `(tenant_id, index_id, path_normalized, object_id)`
  - Fast path pattern queries: "Find all `users[].email` across all objects"
- **Secondary index:** `path_tokens` (Array index)
  - Fast keyword queries: "Find all paths containing 'email'"

**Bulk Insert:**

```typescript
const chClient = new StructuredDataClickHouseClient();
await chClient.insertPathEntries(pathEntries);
// Inserts 1000s of entries in <100ms
```

---

## Stage 5: Embedding

**Worker:** `embedding-worker.ts`

**Process:**

1. **Prepare Embedding Text**

   ```typescript
   // Flatten JSON to human-readable text
   const embeddingText = flattenJSONToText(jsonData);

   // Example:
   // "userId: user-123
   //  profile name: Alice Johnson
   //  profile email: alice@example.com
   //  profile address street: 123 Main St
   //  profile address city: San Francisco
   //  orders[0] id: order-1
   //  orders[0] total: 99.99
   //  orders[1] id: order-2
   //  orders[1] total: 149.99"
   ```

2. **Generate Embedding**

   ```typescript
   const embedding = await embeddingProvider.embed(embeddingText);
   // OpenAI text-embedding-3-large: 3072 dimensions
   ```

3. **Store Embedding**
   ```typescript
   await SearchChunk.findOneAndUpdate(
     { _id: chunk._id, tenantId, indexId },
     {
       embedding: embedding.vector,
       embeddingModel: embedding.model,
       status: ChunkStatus.COMPLETED,
     },
   );
   ```

---

## Stage 6: Query Patterns

### Pattern 1: Semantic Search (Full Object)

**Use Case:** "Find all user profiles mentioning San Francisco"

**Query:**

```typescript
const results = await semanticSearch({
  query: 'user profiles in San Francisco',
  tenantId,
  indexId,
  filters: { chunkType: 'json_nested' },
  limit: 10,
});
```

**How It Works:**

1. Embed query text
2. Vector search on SearchChunk embeddings
3. Return matching JSON objects
4. Rank by semantic similarity

### Pattern 2: Path-Based Query (Exact Path)

**Use Case:** "Get the email address from user profile"

**Query:**

```typescript
const results = await clickhouse.queryPathsByPattern(
  tenantId,
  indexId,
  'profile.email', // Exact path
  100,
);

// Results:
[
  {
    objectId: 'obj-abc123',
    path: 'profile.email',
    valueType: 'string',
    valueString: 'alice@example.com',
  },
];
```

### Pattern 3: Path Pattern Query (Wildcard)

**Use Case:** "Find all email addresses in the object (at any nesting level)"

**Query:**

```typescript
const results = await clickhouse.queryPathsByPattern(
  tenantId,
  indexId,
  '%.email', // SQL LIKE pattern
  100,
);

// Results:
[
  { path: 'profile.email', valueString: 'alice@example.com' },
  { path: 'profile.preferences.notifications.email', valueBoolean: true },
  { path: 'orders[0].customer.email', valueString: 'alice@example.com' },
];
```

### Pattern 4: Array Element Query

**Use Case:** "Get all order totals"

**Query:**

```typescript
const results = await clickhouse.queryPathsByPattern(
  tenantId,
  indexId,
  'orders[].total', // Normalized pattern matches all array elements
  100,
);

// Results:
[
  { path: 'orders[0].total', valueNumber: 99.99 },
  { path: 'orders[1].total', valueNumber: 149.99 },
];
```

### Pattern 5: Value Filter Query

**Use Case:** "Find all paths where value > 100"

**Query:**

```sql
SELECT object_id, path, value_number
FROM json_path_index
WHERE tenant_id = ?
  AND index_id = ?
  AND value_type = 'number'
  AND value_number > 100
ORDER BY value_number DESC
LIMIT 100
```

### Pattern 6: Keyword Search in Paths

**Use Case:** "Find all paths containing 'address'"

**Query:**

```typescript
const results = await clickhouse.queryPathsByKeyword(
  tenantId,
  indexId,
  'address', // Keyword
  100,
);

// Uses path_tokens array index
// Finds: 'profile.address.street', 'profile.address.city', etc.
```

---

## Configuration

### Path Extraction Config

```typescript
interface PathExtractionConfig {
  maxDepth: number; // Default: 15 (stop at 15 levels deep)
  maxArraySize: number; // Default: 1000 (sample larger arrays)
  maxStringLength: number; // Default: 1000 (truncate longer strings)
  sampleLargeArrays: boolean; // Default: true
}
```

### Default Settings

```typescript
{
  maxDepth: 15,              // Handles most real-world JSON
  maxArraySize: 1000,        // Index first 1000 array elements
  maxStringLength: 1000,     // Truncate long text values
  sampleLargeArrays: true    // Evenly sample large arrays
}
```

**Performance Considerations:**

- **maxDepth = 15**: Adequate for 99% of real-world JSON
- **maxArraySize = 1000**: Balance between coverage and performance
- **Sampling strategy**: Evenly spaced elements (every Nth element)

---

## Examples

### Example 1: User Profile (Depth 4)

**Input:**

```json
{
  "userId": "user-123",
  "profile": {
    "name": "Alice Johnson",
    "email": "alice@example.com",
    "address": {
      "street": "123 Main St",
      "city": "San Francisco",
      "state": "CA",
      "coordinates": {
        "lat": 37.7749,
        "lon": -122.4194
      }
    }
  },
  "preferences": {
    "notifications": { "email": true, "sms": false }
  }
}
```

**Processing:**

- **Paths extracted:** 14
- **Max depth:** 4
- **Chunk created:** 1 (full object)
- **Embedding cost:** ~$0.001
- **Processing time:** 50ms

**Path Index Sample:**
| path | pathNormalized | valueType | value |
|------|----------------|-----------|-------|
| `userId` | `userId` | string | "user-123" |
| `profile.name` | `profile.name` | string | "Alice Johnson" |
| `profile.email` | `profile.email` | string | "alice@example.com" |
| `profile.address.city` | `profile.address.city` | string | "San Francisco" |
| `profile.address.coordinates.lat` | `profile.address.coordinates.lat` | number | 37.7749 |
| `preferences.notifications.email` | `preferences.notifications.email` | boolean | true |

**Query Examples:**

**Q1:** "Find user's city"

```typescript
queryPathsByPattern(tenantId, indexId, 'profile.address.city', 1);
// Returns: "San Francisco"
```

**Q2:** "Find all email-related fields"

```typescript
queryPathsByPattern(tenantId, indexId, '%.email', 10);
// Returns:
// - profile.email: "alice@example.com"
// - preferences.notifications.email: true
```

**Q3:** "Find all boolean preferences"

```sql
SELECT path, value_boolean
FROM json_path_index
WHERE tenant_id = ? AND index_id = ?
  AND path_normalized LIKE 'preferences.notifications.%'
  AND value_type = 'boolean'
// Returns:
// - preferences.notifications.email: true
// - preferences.notifications.sms: false
```

---

### Example 2: API Response (Depth 5, Arrays)

**Input:**

```json
{
  "data": {
    "users": [
      {
        "id": 1,
        "name": "Alice",
        "posts": [
          {
            "id": 101,
            "title": "Hello World",
            "comments": [
              { "id": 1001, "author": "Bob", "text": "Great post!" },
              { "id": 1002, "author": "Charlie", "text": "Thanks for sharing!" }
            ]
          },
          {
            "id": 102,
            "title": "JSON Tips",
            "comments": [{ "id": 1003, "author": "Dave", "text": "Very helpful!" }]
          }
        ]
      },
      {
        "id": 2,
        "name": "Bob",
        "posts": [
          {
            "id": 201,
            "title": "API Design",
            "comments": []
          }
        ]
      }
    ]
  }
}
```

**Processing:**

- **Paths extracted:** 47
- **Max depth:** 5
- **Chunk created:** 1
- **Embedding cost:** ~$0.002
- **Processing time:** 120ms

**Query Examples:**

**Q1:** "Find all post titles"

```typescript
queryPathsByPattern(tenantId, indexId, 'data.users[].posts[].title', 100);
// Returns:
// - data.users[0].posts[0].title: "Hello World"
// - data.users[0].posts[1].title: "JSON Tips"
// - data.users[1].posts[0].title: "API Design"
```

**Q2:** "Find all comment authors"

```typescript
queryPathsByPattern(tenantId, indexId, 'data.users[].posts[].comments[].author', 100);
// Returns: ["Bob", "Charlie", "Dave"]
```

**Q3:** "Find all users with posts"

```sql
SELECT DISTINCT object_id, path, value_string
FROM json_path_index
WHERE tenant_id = ? AND index_id = ?
  AND path_normalized = 'data.users[].name'
// Returns: ["Alice", "Bob"]
```

---

### Example 3: Configuration File (Depth 4, Mixed Types)

**Input:**

```json
{
  "database": {
    "primary": {
      "host": "db.example.com",
      "port": 5432,
      "ssl": true,
      "credentials": {
        "username": "admin",
        "passwordRef": "secret/db-pass"
      }
    },
    "replicas": [
      { "host": "db-replica-1.example.com", "port": 5432, "weight": 1.0 },
      { "host": "db-replica-2.example.com", "port": 5432, "weight": 0.8 }
    ]
  },
  "cache": {
    "redis": {
      "host": "cache.example.com",
      "port": 6379,
      "ttl": 3600
    }
  }
}
```

**Processing:**

- **Paths extracted:** 19
- **Max depth:** 4
- **Chunk created:** 1
- **Embedding cost:** ~$0.001
- **Processing time:** 80ms

**Query Examples:**

**Q1:** "Find all hosts"

```typescript
queryPathsByKeyword(tenantId, indexId, 'host', 100);
// Returns:
// - database.primary.host: "db.example.com"
// - database.replicas[0].host: "db-replica-1.example.com"
// - database.replicas[1].host: "db-replica-2.example.com"
// - cache.redis.host: "cache.example.com"
```

**Q2:** "Find all port numbers"

```sql
SELECT path, value_number
FROM json_path_index
WHERE tenant_id = ? AND index_id = ?
  AND path_tokens CONTAINS 'port'
  AND value_type = 'number'
// Returns:
// - database.primary.port: 5432
// - database.replicas[0].port: 5432
// - database.replicas[1].port: 5432
// - cache.redis.port: 6379
```

**Q3:** "Find database credentials location"

```typescript
queryPathsByPattern(tenantId, indexId, 'database.%.credentials.%', 100);
// Returns:
// - database.primary.credentials.username: "admin"
// - database.primary.credentials.passwordRef: "secret/db-pass"
```

---

## Performance Characteristics

### Path Extraction

| Object Complexity           | Paths Extracted | Extraction Time | Notes               |
| --------------------------- | --------------- | --------------- | ------------------- |
| **Simple (depth 2)**        | 5-10            | 10ms            | User profiles       |
| **Medium (depth 4)**        | 20-50           | 50ms            | API responses       |
| **Complex (depth 6)**       | 100-200         | 150ms           | Config files        |
| **Very complex (depth 10)** | 500+            | 300ms           | Rare, deeply nested |

### Query Performance

| Query Type          | Latency | Notes                                 |
| ------------------- | ------- | ------------------------------------- |
| **Exact path**      | <10ms   | `profile.email`                       |
| **Path pattern**    | <20ms   | `users[].email` (matches 100 objects) |
| **Keyword search**  | <30ms   | Find all paths with 'address'         |
| **Value filter**    | <50ms   | Find all numbers > 100                |
| **Semantic search** | <100ms  | Vector search + reranking             |

### Storage

| Object Complexity | Paths | MongoDB Chunk | ClickHouse Paths | Total Storage |
| ----------------- | ----- | ------------- | ---------------- | ------------- |
| **Simple**        | 10    | 1 KB          | 2 KB             | 3 KB          |
| **Medium**        | 50    | 5 KB          | 10 KB            | 15 KB         |
| **Complex**       | 200   | 20 KB         | 40 KB            | 60 KB         |

**Storage Efficiency:**

- **MongoDB**: Stores full object once (compressed)
- **ClickHouse**: Stores paths once per object (columnar compression)
- **Total overhead**: ~3x object size (acceptable for query capabilities)

---

## Troubleshooting

### Issue: Max Depth Exceeded

**Problem:** JSON object has depth > 15, paths truncated.

**Solution:**

1. Increase `maxDepth` config (up to 25)
2. Flatten JSON structure if possible
3. Check for circular references (infinite depth)

### Issue: Array Too Large (>1000 elements)

**Problem:** Array with 10K+ elements, only first 1000 indexed.

**Solution:**

1. Increase `maxArraySize` config (caution: performance impact)
2. Enable `sampleLargeArrays` for even sampling
3. Consider aggregating array data before ingestion

### Issue: Path Query Returns No Results

**Problem:** Known path exists but query returns empty.

**Solution:**

1. **Check path syntax:** Use dot notation (`profile.email`, not `profile['email']`)
2. **Check array indices:** Use `[]` for patterns (`users[].email`, not `users[0].email`)
3. **Check tenant/index isolation:** Verify correct tenantId and indexId
4. **Check value type:** Filter by correct `value_type` if querying by value

### Issue: Semantic Search Not Finding Object

**Problem:** Object exists but doesn't appear in semantic search results.

**Solution:**

1. **Check embedding status:** Verify chunk has `status: COMPLETED`
2. **Check query relevance:** Try more specific query terms
3. **Check filters:** Ensure `chunkType: 'json_nested'` filter applied
4. **Try path-based query:** If you know exact path, use path query instead

### Issue: Slow Path Queries

**Problem:** Path queries taking >100ms.

**Solution:**

1. **Add path_normalized index:** Ensure ClickHouse index exists
2. **Limit result set:** Use LIMIT to reduce result size
3. **Use exact paths:** Avoid wildcard patterns when possible
4. **Check tenant cardinality:** Many tenants may slow down queries

---

## Related Documentation

- [CSV Tables Guide](./02-structured-csv.md) - For flat tabular data
- [JSON Tabular Guide](./04-structured-json-tabular.md) - For JSON arrays of flat objects
- [Architecture Overview](./10-architecture-overview.md) - Full system architecture
- [Retrieval Checklist](./20-retrieval-checklist.md) - Optimization guide

---

## Key Takeaways

**1. Full Object + Paths = Best of Both Worlds**

- Semantic search on full object for discovery
- Path-based queries for precise field access
- No need to choose between approaches

**2. Path Normalization Enables Pattern Matching**

- `users[0].email` → `users[].email`
- Single pattern matches all array elements
- Simplifies querying across collections

**3. ClickHouse Path Index is Fast**

- Sub-10ms queries for exact paths
- Sub-30ms for pattern matching
- Columnar storage + indexing = efficient

**4. Deep Nesting is Supported (15 levels)**

- Handles 99% of real-world JSON
- Graceful truncation for extreme cases
- Parent-child relationships preserved

**5. Large Arrays Handled Intelligently**

- Sample first 1000 elements (configurable)
- Even sampling for representative coverage
- Prevents index bloat

---

**Next:** [JSON Tabular Guide](./04-structured-json-tabular.md) →
