# JSON Tabular - Array of Flat Objects

**Applies To:** JSON arrays of flat objects (table-like structure)
**Strategy:** Treat as CSV table (metadata-only chunking + ClickHouse storage)
**Worker:** `structured-data-ingestion-worker.ts`

---

## Overview

Tabular JSON is a JSON array containing flat objects with a uniform schema — essentially a table represented in JSON format. This is treated identically to CSV files, using the **metadata-only chunking strategy** for 99.9% chunk reduction.

**Architecture:**

```
JSON Array → Detect Tabular → Convert to Table → CSV Pipeline
     ↓              ↓                ↓                ↓
 Uniform schema  Depth ≤ 2     Extract rows    Same as CSV
                                                 (see guide 02)
```

**Key Decision:** If JSON is tabular, route to CSV-like processing. If nested, route to hierarchical processing (guide 03).

---

## When to Use Tabular vs Nested

### Decision Algorithm

```typescript
function isTabular(data: any): boolean {
  // Must be an array
  if (!Array.isArray(data)) return false;

  // Must have at least one element
  if (data.length === 0) return false;

  // All elements must be objects
  if (!data.every((item) => typeof item === 'object' && item !== null)) {
    return false;
  }

  // Check schema uniformity (all objects have same keys)
  const firstKeys = Object.keys(data[0]).sort();
  const schemaUniform = data.every((item) => {
    const keys = Object.keys(item).sort();
    return JSON.stringify(keys) === JSON.stringify(firstKeys);
  });

  if (!schemaUniform) return false;

  // Check max depth (≤2 for tabular)
  const maxDepth = Math.max(...data.map((item) => getObjectDepth(item)));
  if (maxDepth > 2) return false;

  return true;
}
```

### Tabular JSON Examples (THIS GUIDE)

```json
[
  { "id": 1, "name": "Alice", "email": "alice@example.com", "age": 30 },
  { "id": 2, "name": "Bob", "email": "bob@example.com", "age": 25 },
  { "id": 3, "name": "Charlie", "email": "charlie@example.com", "age": 35 }
]
```

**Characteristics:**

- ✅ Top-level is array
- ✅ All elements are objects
- ✅ Uniform schema (same keys)
- ✅ Flat structure (depth ≤ 2)

```json
[
  {
    "orderId": "ORD-001",
    "customer": "Alice",
    "items": 3,
    "total": 99.99,
    "status": "completed"
  },
  {
    "orderId": "ORD-002",
    "customer": "Bob",
    "items": 1,
    "total": 49.99,
    "status": "pending"
  }
]
```

**Characteristics:**

- ✅ Array of objects
- ✅ Uniform keys across all objects
- ✅ Simple values (no nested objects or arrays)

### Nested JSON Examples (SEE GUIDE 03)

```json
{
  "users": [
    {
      "id": 1,
      "name": "Alice",
      "address": {
        "city": "San Francisco",
        "coordinates": { "lat": 37.7749, "lon": -122.4194 }
      }
    }
  ]
}
```

**Why NOT tabular:**

- ❌ Top-level is object (not array)
- ❌ Contains nested objects (`address.coordinates`)
- ❌ Depth > 2

```json
[
  {
    "id": 1,
    "name": "Alice",
    "orders": [
      { "id": "ORD-001", "total": 99.99 },
      { "id": "ORD-002", "total": 49.99 }
    ]
  },
  {
    "id": 2,
    "name": "Bob",
    "orders": [{ "id": "ORD-003", "total": 149.99 }]
  }
]
```

**Why NOT tabular:**

- ❌ Contains nested arrays (`orders`)
- ❌ Depth > 2 (id → orders → order object)
- ❌ Schema not flat

---

## Pipeline Overview

**Tabular JSON uses the exact same pipeline as CSV** (see [CSV Guide](./02-structured-csv.md)).

```
┌─────────────────┐
│ 1. Parse JSON   │ → Parse array, extract objects as rows
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. Convert      │ → Convert JSON objects to table rows
│    to Table     │   (headers = object keys, rows = values)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 3-8. CSV        │ → Follow CSV pipeline exactly:
│     Pipeline    │   - Schema analysis
└─────────────────┘   - Metadata chunking
                      - ClickHouse storage
                      - Embedding
                      - Query routing
```

**For detailed pipeline documentation, see:** [CSV Tables Guide](./02-structured-csv.md)

---

## Stage 1: JSON Parsing

**Process:**

1. **Parse JSON File**

   ```typescript
   const jsonData = JSON.parse(fileBuffer.toString('utf-8'));
   ```

2. **Validate Tabular Structure**

   ```typescript
   if (!isTabular(jsonData)) {
     throw new Error('JSON is not tabular. Use nested JSON processing instead.');
   }
   ```

3. **Extract Headers and Rows**

   ```typescript
   const headers = Object.keys(jsonData[0]);
   const rows = jsonData.map((obj) => headers.map((key) => obj[key]));

   // Example:
   // Input:
   // [
   //   { "id": 1, "name": "Alice", "age": 30 },
   //   { "id": 2, "name": "Bob", "age": 25 }
   // ]
   //
   // Output:
   // headers = ["id", "name", "age"]
   // rows = [
   //   [1, "Alice", 30],
   //   [2, "Bob", 25]
   // ]
   ```

4. **Create ParsedTable**
   ```typescript
   const parsedTable: ParsedTable = {
     headers,
     rows,
     format: 'json', // Marks as JSON origin (but processed like CSV)
   };
   ```

---

## Stage 2-8: CSV Pipeline

**After JSON → Table conversion, processing is identical to CSV:**

- **Schema Analysis**: Type detection, FK detection, statistics (see CSV guide, Stage 1)
- **Metadata Chunking**: 1 metadata chunk per table, no row chunks (see CSV guide, Stage 3.2)
- **ClickHouse Storage**: All rows stored in `structured_data` table (see CSV guide, Stage 3.3)
- **Embedding**: Embed metadata chunk for table discovery (see CSV guide, Stage 4)
- **Query Routing**: Text-to-SQL + table discovery (see CSV guide, Stage 5)

**For complete details, see:** [CSV Tables Guide](./02-structured-csv.md)

---

## Examples

### Example 1: Users Table (100 objects)

**Input:** `users.json`

```json
[
  {
    "id": 1,
    "username": "alice123",
    "email": "alice@example.com",
    "role": "admin",
    "active": true,
    "created": "2023-01-15"
  },
  {
    "id": 2,
    "username": "bob456",
    "email": "bob@example.com",
    "role": "user",
    "active": true,
    "created": "2023-02-20"
  },
  ...
]
```

**Processing:**

1. **Parse**: Detect tabular structure ✅
2. **Convert**: Extract headers + rows
   - Headers: `["id", "username", "email", "role", "active", "created"]`
   - Rows: 100 objects → 100 row arrays
3. **Schema Analysis**:
   - `id`: integer, primary key candidate
   - `username`: string, unique
   - `email`: string, embeddable
   - `role`: enum (2 unique values: admin, user)
   - `active`: boolean
   - `created`: date
4. **Chunking**: 1 metadata chunk (100% savings vs 100 chunks)
5. **Storage**:
   - MongoDB: 1 SearchChunk (~2 KB)
   - ClickHouse: 100 rows (~20 KB), 1 metadata row
6. **Embedding**: 1 embedding (~$0.001)

**Total Cost:** ~$0.001 (vs $5 for naive 100-chunk approach)

**Query Examples:**

```typescript
// Text-to-SQL query
"Find all admin users created in January 2023"

// Generated SQL:
SELECT *
FROM structured_data
WHERE tenant_id = ? AND index_id = ? AND table_id = ?
  AND JSON_EXTRACT(row_data, '$.role') = 'admin'
  AND JSON_EXTRACT(row_data, '$.created') BETWEEN '2023-01-01' AND '2023-01-31'

// Execution: 15ms
```

---

### Example 2: Products Table (5K objects)

**Input:** `products.json`

```json
[
  {
    "productId": "PROD-001",
    "name": "Laptop",
    "category": "Electronics",
    "price": 999.99,
    "stock": 50,
    "inStock": true
  },
  {
    "productId": "PROD-002",
    "name": "Mouse",
    "category": "Accessories",
    "price": 29.99,
    "stock": 200,
    "inStock": true
  },
  ...
]
```

**Processing:**

- Rows: 5,000
- Chunks: 1 metadata chunk
- Storage: ~1 MB (ClickHouse compressed)
- Cost: ~$0.001
- Time: 2 seconds

**Query Examples:**

```typescript
// Semantic search
"Find all laptops under $1000"
→ Table discovery finds products table
→ Text-to-SQL: WHERE category = 'Electronics' AND price < 1000
→ Returns: 23 results in 25ms
```

---

### Example 3: Transactions Table (50K objects)

**Input:** `transactions.json`

```json
[
  {
    "txId": "TX-001",
    "userId": 42,
    "amount": 99.99,
    "type": "purchase",
    "timestamp": "2023-01-15T10:30:00Z"
  },
  ...
]
```

**Processing:**

- Rows: 50,000
- Chunks: 1 metadata chunk (vs 50,000 for naive approach)
- Storage: ~5 MB
- Cost: ~$0.001 (vs $25 for naive)
- **Savings:** 99.996%

**Query Examples:**

```typescript
// Aggregation query
"What's the total transaction volume by type?"

// Generated SQL:
SELECT
  JSON_EXTRACT(row_data, '$.type') as type,
  SUM(CAST(JSON_EXTRACT(row_data, '$.amount') AS Float64)) as total
FROM structured_data
WHERE tenant_id = ? AND index_id = ? AND table_id = ?
GROUP BY type

// Results (18ms):
// - purchase: $2,456,789.50
// - refund: $23,456.12
```

---

## Performance Characteristics

**Same as CSV** (see [CSV Tables Guide](./02-structured-csv.md), Performance section)

| Dataset Size     | Chunks Created | Embedding Cost | Processing Time | Query Time |
| ---------------- | -------------- | -------------- | --------------- | ---------- |
| **100 objects**  | 1              | $0.001         | 0.5s            | <20ms      |
| **1K objects**   | 1              | $0.001         | 0.8s            | <20ms      |
| **10K objects**  | 1              | $0.001         | 1.5s            | <30ms      |
| **100K objects** | 1              | $0.001         | 4s              | <50ms      |

---

## Configuration

**Same as CSV** (see [CSV Tables Guide](./02-structured-csv.md), Configuration section)

```typescript
{
  chunking: {
    strategy: 'metadata-only',  // Always metadata-only
    sampleRowCount: 20
  },
  foreignKeys: {
    autoDetect: true,
    minMatchRate: 0.9,
    maxSamples: 1000
  },
  textToSQL: {
    enabled: true,
    maxQueryTimeSeconds: 10,
    allowJoins: true
  }
}
```

---

## Differences from CSV

### JSON-Specific Considerations

| Aspect               | CSV                              | JSON Tabular                         |
| -------------------- | -------------------------------- | ------------------------------------ |
| **Parsing**          | CSV parser (delimiter detection) | JSON.parse()                         |
| **Headers**          | First row or manual              | Object keys from first element       |
| **Type Hints**       | None (infer from values)         | JSON types (string, number, boolean) |
| **Null Values**      | Empty string vs NULL ambiguous   | Explicit null in JSON                |
| **Boolean Values**   | String "true"/"false"            | Native true/false                    |
| **Arrays in Values** | Not supported                    | Supported (but makes it non-tabular) |
| **Nested Objects**   | Not supported                    | Supported (but makes it non-tabular) |

### Type Detection Benefits

JSON provides native type information, making schema detection more accurate:

```json
// CSV (ambiguous):
"id","active","price"
"1","true","99.99"
// Is "true" a boolean or string? Is "1" an integer or string?

// JSON (explicit types):
{ "id": 1, "active": true, "price": 99.99 }
// Types are clear: integer, boolean, number
```

**Result:** JSON tabular has 100% type detection confidence (vs 80-95% for CSV).

---

## Troubleshooting

### Issue: JSON Not Detected as Tabular

**Problem:** JSON array processed as nested, not tabular.

**Solution:**

1. **Check depth**: All objects must be flat (no nested objects/arrays)
2. **Check schema uniformity**: All objects must have same keys
3. **Check element types**: All elements must be objects (not primitives)
4. **Manual override**: Flatten nested objects before ingestion

### Issue: Type Detection Incorrect

**Problem:** JSON boolean stored as string.

**Solution:**

- JSON should have correct types natively
- If from external API, validate JSON structure
- Check if API returns strings instead of booleans

### All Other Issues

**See:** [CSV Tables Guide - Troubleshooting](./02-structured-csv.md#troubleshooting)

All CSV troubleshooting applies to JSON tabular:

- Foreign key detection
- Text-to-SQL issues
- Query performance
- Table discovery

---

## Related Documentation

- [CSV Tables Guide](./02-structured-csv.md) - **PRIMARY REFERENCE** for complete pipeline details
- [JSON Nested Guide](./03-structured-json-nested.md) - For nested/hierarchical JSON
- [Excel Guide](./05-structured-excel.md) - Multi-sheet Excel (similar pattern)
- [Architecture Overview](./10-architecture-overview.md) - Full system architecture

---

## Key Takeaways

**1. Tabular JSON = CSV in JSON Format**

- Treated identically to CSV after parsing
- Same metadata-only chunking strategy
- Same 99.9% chunk reduction

**2. Detection is Automatic**

- Ingestion worker auto-detects tabular vs nested
- No manual configuration needed
- Falls back to nested processing if not tabular

**3. JSON Has Type Advantages**

- Native boolean, number, null types
- 100% type detection confidence
- No ambiguity (unlike CSV strings)

**4. All CSV Benefits Apply**

- Metadata-only chunking (1 chunk per table)
- ClickHouse storage (fast SQL queries)
- Text-to-SQL query generation
- Foreign key detection

**5. When in Doubt, Flatten**

- If JSON has nested objects, consider flattening
- Flattened JSON processed as tabular (faster, cheaper)
- Nested JSON processed as hierarchical (more flexible)

---

## Example: Choosing Between Nested and Tabular

**Original JSON (nested):**

```json
[
  {
    "id": 1,
    "name": "Alice",
    "address": { "city": "SF", "state": "CA" }
  },
  {
    "id": 2,
    "name": "Bob",
    "address": { "city": "NY", "state": "NY" }
  }
]
```

**Problem:** Depth = 3 (root → object → address → field), not tabular.

**Solution 1: Flatten (recommended for tables)**

```json
[
  { "id": 1, "name": "Alice", "city": "SF", "state": "CA" },
  { "id": 2, "name": "Bob", "city": "NY", "state": "NY" }
]
```

**Result:** Tabular processing (faster, cheaper, easier to query)

**Solution 2: Keep Nested (if complex structure needed)**

```json
// Keep as-is, will use nested processing
```

**Result:** Nested processing (path-based queries, slower, more flexible)

**Recommendation:** **Flatten when possible.** Tabular processing is simpler, faster, and cheaper for table-like data.

---

**Next:** [Excel Guide](./05-structured-excel.md) →
