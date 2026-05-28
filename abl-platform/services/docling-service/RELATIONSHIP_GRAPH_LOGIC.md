# Relationship Graph Building - Logic and Decision Tree

**Date**: 2026-02-23
**Purpose**: Detailed explanation of relationship detection logic with examples

## Overview

Relationship graph building creates three types of relationships:

1. **Parent-Child**: Field chunks → parent record chunk (for large fields)
2. **Foreign Key**: Record A → Record B (cross-table joins)
3. **Same-Record**: All chunks belonging to same recordId (sibling chunks)

---

## Stage 1: Parent-Child Relationships

**Purpose**: Link large field chunks back to their parent record chunk.

### When Created

A parent-child relationship is created when:

- A row has a field exceeding `MAX_FIELD_TOKENS` (500 tokens)
- That field is chunked into multiple `field` chunks
- Each field chunk gets `parentChunkId` pointing to the main record chunk

### Example Scenario

**Input**: Customer record with large `notes` field

```json
{
  "id": 12345,
  "name": "Acme Corp",
  "status": "active",
  "notes": "<5000 character detailed notes about customer history...>"
}
```

**Chunking Decision Tree**:

```
1. Estimate tokens in embeddable fields:
   - name: "Acme Corp" → 2 tokens
   - notes: "<5000 chars>" → 1250 tokens
   - Total: 1252 tokens

2. Check if total > MAX_RECORD_TOKENS (1000):
   → Yes, exceeds limit

3. Identify large fields:
   - notes: 1250 tokens > MAX_FIELD_TOKENS (500)
   → notes is a "large field"

4. Create chunks:
   - Main record chunk (without notes):
     {
       chunkId: "chunk_main",
       content: "Table: customers\nName: Acme Corp",
       filterableMetadata: {id: 12345, status: "active"},
       embeddableMetadata: {name: "Acme Corp"},
       childChunkIds: ["chunk_field_0", "chunk_field_1", "chunk_field_2"]
     }

   - Field chunk 0 (notes, chars 0-3200):
     {
       chunkId: "chunk_field_0",
       content: "<first 3200 chars of notes>",
       parentChunkId: "chunk_main",
       fieldName: "notes",
       chunkOffset: 0,
       filterableMetadata: {id: 12345, fieldName: "notes"}
     }

   - Field chunk 1 (notes, chars 3000-6200, 200 overlap):
     {
       chunkId: "chunk_field_1",
       content: "<chars 3000-6200 with 200 overlap>",
       parentChunkId: "chunk_main",
       fieldName: "notes",
       chunkOffset: 3000,
       filterableMetadata: {id: 12345, fieldName: "notes"}
     }

   - ... more chunks as needed

5. Create parent-child relationships:
   - Relationship 1:
     {
       relationType: "parent_child",
       sourceChunkId: "chunk_main",
       targetChunkId: "chunk_field_0",
       sourceRecordId: 12345,
       targetRecordId: 12345,
       depth: 1,
       pathFromRoot: ["chunk_main", "chunk_field_0"]
     }

   - Relationship 2:
     {
       relationType: "parent_child",
       sourceChunkId: "chunk_main",
       targetChunkId: "chunk_field_1",
       ...
     }
```

### Logical Decisions

| Condition                                         | Action                            | Reasoning                               |
| ------------------------------------------------- | --------------------------------- | --------------------------------------- |
| Field < `MAX_FIELD_TOKENS`                        | Inline in main chunk              | No overhead, simple retrieval           |
| Field > `MAX_FIELD_TOKENS`                        | Create field chunks               | Prevents exceeding embedding limits     |
| All fields inline AND total < `MAX_RECORD_TOKENS` | Single chunk only                 | Optimal case, no relationships needed   |
| Any field chunked                                 | Create parent-child relationships | Enables reconstruction during retrieval |

### Retrieval Use Case

**Query**: "Get customer 12345 with full notes"

**Execution**:

1. Find main chunk: `{recordId: 12345, chunkType: "record"}`
2. Check `childChunkIds`: ["chunk_field_0", "chunk_field_1", "chunk_field_2"]
3. Fetch all child chunks in parallel
4. Sort by `chunkOffset`: [0, 3000, 6000]
5. Concatenate, removing overlap:
   - chunk_field_0: chars 0-3200
   - chunk_field_1: chars 3000-6200 → take chars 3200-6200 (remove 200 overlap)
   - chunk_field_2: chars 6000-8000 → take chars 6200-8000
6. Reconstruct: `notes = chunk0 + chunk1[200:] + chunk2[200:]`

---

## Stage 2: Foreign Key Relationships

**Purpose**: Link records across tables for cross-table queries.

### Detection Method 1: Naming Convention

**Rule**: Column ending with `_id` or `_ID` likely references another table's primary key.

**Algorithm**:

```typescript
function detectByNaming(sourceColumn: string, tables: TableSchema[]): ForeignKey | null {
  // Extract base name: "customer_id" → "customer"
  const match = sourceColumn.match(/^(.+)_id$/i);
  if (!match) return null;

  const baseName = match[1]; // "customer"

  // Try pluralization: "customer" → "customers"
  const pluralName = pluralize(baseName); // "customers"

  // Find table with matching name
  const targetTable = tables.find((t) => t.tableName.toLowerCase() === pluralName.toLowerCase());

  if (targetTable && targetTable.primaryKey) {
    return {
      sourceField: sourceColumn,
      targetTable: targetTable.tableName,
      targetField: targetTable.primaryKey,
      confidence: 0.8,
      detectionMethod: 'naming_convention',
    };
  }

  return null;
}
```

**Example**:

Tables:

- `customers` (primary key: `id`)
- `orders` (columns: `order_id`, `customer_id`, `amount`)

Detection:

1. Check column `customer_id` in `orders` table
2. Extract base name: "customer"
3. Pluralize: "customers"
4. Find table: `customers` table exists
5. Check primary key: `id` exists
6. **Detected**: `orders.customer_id` → `customers.id` (confidence: 0.8)

### Detection Method 2: Value Overlap

**Rule**: If 70%+ of column values exist in another table's primary key, likely a foreign key.

**Algorithm**:

```typescript
function detectByValueOverlap(
  sourceColumn: ColumnSchema,
  targetColumn: ColumnSchema,
  sourceData: any[],
  targetData: any[],
): ForeignKey | null {
  // Extract all values (non-null)
  const sourceValues = new Set(
    sourceData.map((row) => row[sourceColumn.name]).filter((v) => v !== null),
  );

  const targetValues = new Set(
    targetData.map((row) => row[targetColumn.name]).filter((v) => v !== null),
  );

  // Count matches
  let matchCount = 0;
  for (const value of sourceValues) {
    if (targetValues.has(value)) {
      matchCount++;
    }
  }

  // Calculate overlap percentage
  const overlapPct = matchCount / sourceValues.size;

  if (overlapPct >= 0.7) {
    // 70% threshold
    return {
      sourceField: sourceColumn.name,
      targetTable: '<target-table-name>',
      targetField: targetColumn.name,
      confidence: overlapPct,
      detectionMethod: 'value_overlap',
    };
  }

  return null;
}
```

**Example**:

Tables:

- `customers`: `[{id: 1}, {id: 2}, {id: 3}, {id: 4}, {id: 5}]`
- `orders`: `[{order_id: 101, cust_ref: 1}, {order_id: 102, cust_ref: 2}, {order_id: 103, cust_ref: 1}, {order_id: 104, cust_ref: 3}]`

Detection:

1. Check column `cust_ref` in `orders` table
2. Source values: `{1, 2, 3}` (3 unique values)
3. Target values (customers.id): `{1, 2, 3, 4, 5}`
4. Match count: 3 (all source values exist in target)
5. Overlap: 3/3 = 100%
6. **Detected**: `orders.cust_ref` → `customers.id` (confidence: 1.0)

### False Positive Prevention

**Problem**: Coincidental overlap (e.g., `year` column matches customer IDs by accident)

**Solutions**:

1. **Type matching**: Source and target must have same type

   ```typescript
   if (sourceColumn.type !== targetColumn.type) {
     return null; // Don't detect FK between different types
   }
   ```

2. **Cardinality check**: Foreign key should have lower cardinality than primary key

   ```typescript
   const sourceUnique = new Set(sourceData.map((r) => r[sourceColumn.name])).size;
   const targetUnique = new Set(targetData.map((r) => r[targetColumn.name])).size;

   if (sourceUnique >= targetUnique * 0.9) {
     // Source has almost as many unique values as target - unlikely FK
     return null;
   }
   ```

3. **Naming hint bonus**: If column name contains target table name, boost confidence

   ```typescript
   if (sourceColumn.name.toLowerCase().includes(targetTable.tableName.toLowerCase())) {
     confidence += 0.1; // Boost confidence
   }
   ```

4. **Sample validation**: Check a sample of 10 random values

   ```typescript
   const sample = sampleRandomValues(sourceData, sourceColumn.name, 10);
   const validCount = sample.filter((v) => targetValues.has(v)).length;

   if (validCount < 7) {
     // Less than 70% of sample matches
     return null;
   }
   ```

### Example: Preventing False Positives

**Scenario**: Orders table has `year` column, Customers table has `id` column

```
orders:
  [{order_id: 1, year: 2023}, {order_id: 2, year: 2024}, ...]

customers:
  [{id: 2023, name: "Old Corp"}, {id: 2024, name: "New Inc"}, ...]
```

**Detection Attempt**:

1. Column `year` has values: `{2023, 2024}`
2. Column `id` has values: `{2023, 2024, 2025, 2026, ...}`
3. Overlap: 2/2 = 100%
4. **But**: Check cardinality:
   - Source unique: 2 (only 2 years)
   - Target unique: 10,000 (10k customers)
   - Cardinality ratio: 2/10000 = 0.0002 (way too low)
5. **Rejected**: Cardinality too low for foreign key

### Relationship Storage

**Foreign Key Relationship Structure**:

```typescript
{
  _id: ObjectId("..."),
  relationType: "foreign_key",

  // Chunk references
  sourceChunkId: ObjectId("orders_row_5"),      // Order chunk
  targetChunkId: ObjectId("customers_row_12345"), // Customer chunk

  // Record identifiers (denormalized for fast lookup)
  sourceRecordId: 105,           // order_id
  targetRecordId: 12345,         // customer_id
  sourceTableName: "orders",
  targetTableName: "customers",

  // Foreign key metadata
  foreignKeyField: "customer_id",
  foreignKeyValue: 12345,        // Actual value in orders.customer_id

  // Traversal
  depth: 1,
  pathFromRoot: [ObjectId("orders_row_5"), ObjectId("customers_row_12345")]
}
```

### Retrieval Use Case

**Query**: "Find all orders for customer 'Acme Corp'"

**Execution**:

1. Find customer by name (semantic search):
   - Query: "Acme Corp"
   - Result: `{recordId: 12345, tableName: "customers"}`

2. Find foreign key relationships:

   ```typescript
   db.chunkRelationships.find({
     relationType: 'foreign_key',
     targetTableName: 'customers',
     targetRecordId: 12345,
   });
   ```

   - Result: 5 relationships (5 orders reference this customer)

3. Fetch source chunks (orders):

   ```typescript
   const orderChunkIds = relationships.map((r) => r.sourceChunkId);
   const orderChunks = db.searchChunks.find({
     _id: { $in: orderChunkIds },
   });
   ```

4. Return: Customer Acme Corp has 5 orders

---

## Stage 3: Same-Record Relationships

**Purpose**: Link all chunks belonging to the same record (sibling chunks).

### When Created

A same-record relationship is created when:

- A record has multiple chunks (main + field chunks)
- All chunks share the same `recordId`
- Used for retrieving "all chunks of record X"

### Example Scenario

**Input**: Customer record with 2 large fields

```json
{
  "id": 12345,
  "name": "Acme Corp",
  "description": "<2000 char description>", // Large field 1
  "history": "<3000 char history>" // Large field 2
}
```

**Chunks Created**:

1. Main chunk: `chunk_main` (id, name)
2. Field chunk 1: `chunk_desc_0` (description, part 1)
3. Field chunk 2: `chunk_desc_1` (description, part 2)
4. Field chunk 3: `chunk_hist_0` (history, part 1)
5. Field chunk 4: `chunk_hist_1` (history, part 2)
6. Field chunk 5: `chunk_hist_2` (history, part 3)

**Same-Record Relationships**:

```typescript
// Link main → description chunks
{
  relationType: "same_record",
  sourceChunkId: "chunk_main",
  targetChunkId: "chunk_desc_0",
  sourceRecordId: 12345,
  targetRecordId: 12345,
  depth: 0  // Siblings (same level)
}

{
  relationType: "same_record",
  sourceChunkId: "chunk_main",
  targetChunkId: "chunk_desc_1",
  ...
}

// Link main → history chunks
{
  relationType: "same_record",
  sourceChunkId: "chunk_main",
  targetChunkId: "chunk_hist_0",
  ...
}

... (3 more for history chunks)
```

### Retrieval Use Case

**Query**: "Get all chunks for record 12345"

**Execution**:

1. Find main chunk:

   ```typescript
   const mainChunk = db.searchChunks.findOne({
     recordId: 12345,
     chunkType: 'record',
   });
   ```

2. Find all sibling chunks:

   ```typescript
   const siblings = db.chunkRelationships.find({
     relationType: 'same_record',
     sourceRecordId: 12345,
   });
   ```

3. Fetch all chunks:

   ```typescript
   const allChunkIds = [mainChunk._id, ...siblings.map((s) => s.targetChunkId)];
   const allChunks = db.searchChunks.find({ _id: { $in: allChunkIds } });
   ```

4. Group by field:
   - Main: `chunk_main`
   - Description: `[chunk_desc_0, chunk_desc_1]`
   - History: `[chunk_hist_0, chunk_hist_1, chunk_hist_2]`

5. Reconstruct each field by concatenating chunks

---

## Decision Tree Summary

```
Input: Row data + Schema analysis
│
├─ Step 1: Estimate total embeddable tokens
│   │
│   ├─ If total < MAX_RECORD_TOKENS (1000):
│   │   → Create single chunk
│   │   → No relationships needed
│   │   → DONE
│   │
│   └─ If total >= MAX_RECORD_TOKENS:
│       → Continue to Step 2
│
├─ Step 2: Identify large fields
│   │
│   └─ For each embeddable field:
│       │
│       ├─ If field < MAX_FIELD_TOKENS (500):
│           → Include in main chunk
│       │
│       └─ If field >= MAX_FIELD_TOKENS:
│           → Mark as "large field"
│           → Continue to Step 3
│
├─ Step 3: Create chunks
│   │
│   ├─ Create main chunk (without large fields)
│   │
│   └─ For each large field:
│       │
│       ├─ Split field into chunks (CHUNK_SIZE=800, OVERLAP=200)
│       │
│       └─ Set parentChunkId on each field chunk
│           → This creates parent-child relationships (Stage 1)
│
├─ Step 4: Detect foreign keys (if multiple tables)
│   │
│   ├─ Method 1: Naming convention
│   │   └─ For each column ending with "_id":
│   │       ├─ Extract base name
│   │       ├─ Pluralize
│   │       ├─ Find matching table
│   │       └─ If found → Create FK relationship (Stage 2)
│   │
│   └─ Method 2: Value overlap
│       └─ For each column pair:
│           ├─ Calculate overlap percentage
│           ├─ If overlap >= 70% AND passes validation:
│           └─ Create FK relationship (Stage 2)
│
└─ Step 5: Create same-record relationships (Stage 3)
    │
    └─ For each record with multiple chunks:
        └─ Create same_record relationship linking all chunks
```

---

## Complexity Analysis

| Operation                    | Time Complexity | Space Complexity | Notes                                           |
| ---------------------------- | --------------- | ---------------- | ----------------------------------------------- |
| **Parent-child creation**    | O(C)            | O(C)             | C = number of chunks per record (typically 1-5) |
| **FK detection (naming)**    | O(T × M)        | O(1)             | T = tables, M = columns per table               |
| **FK detection (overlap)**   | O(T² × M × N)   | O(N)             | N = sample size (typically 10-100 rows)         |
| **FK relationship creation** | O(R₁ × R₂)      | O(R₁ × R₂)       | R₁, R₂ = row counts of two tables               |
| **Same-record creation**     | O(C)            | O(C)             | C = total chunks                                |

**Optimization**: FK overlap detection uses sample data (10-100 rows) instead of full table scan.

---

## Summary

**Three Relationship Types**:

1. **Parent-Child**: Chunk hierarchy for large fields
   - **When**: Field > 500 tokens
   - **Purpose**: Reconstruct full record
   - **Query**: O(1) parent lookup, O(K) children lookup

2. **Foreign Key**: Cross-table joins
   - **When**: Column references another table's PK
   - **Purpose**: Join queries ("Find all orders for customer X")
   - **Query**: O(M) where M = number of related records

3. **Same-Record**: Sibling chunks of same record
   - **When**: Record has multiple chunks
   - **Purpose**: Fetch all data for a record
   - **Query**: O(K) where K = number of chunks

**Key Insights**:

- ✅ Relationships are pre-computed during ingestion (one-time cost)
- ✅ Retrieval is fast (indexed lookups, no runtime joins)
- ✅ Foreign key detection has multiple validation steps to prevent false positives
- ✅ All relationships are bidirectional (can traverse in either direction)
