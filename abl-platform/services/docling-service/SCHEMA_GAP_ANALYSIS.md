# Schema Gap Analysis for Structured Data

**Task #19**: Review and analyze existing chunk schema for structured data
**Date**: 2026-02-23
**Status**: In Progress

## Executive Summary

The current chunk schema (`SearchChunk`, `ChunkHierarchy`, `CanonicalSchema`) is optimized for unstructured text documents (PDFs, DOCX, Markdown). It has **16 critical gaps** that prevent effective handling of structured data (JSON, CSV, Excel). This document provides a detailed field-by-field analysis of problems and required changes.

---

## 1. SearchChunk Model Analysis

### Current Schema

```typescript
interface ISearchChunk {
  _id: string;
  tenantId: string;
  indexId: string;
  documentId: string;

  // Content fields
  content: string; // ❌ PROBLEM 1
  tokenCount: number;
  chunkIndex: number; // ❌ PROBLEM 2

  // Vector storage
  vectorId: string | null;

  // Metadata
  metadata: any | null; // ❌ PROBLEM 3
  canonicalMetadata: Record<string, unknown> | null; // ❌ PROBLEM 4

  status: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
```

### Problem 1: `content` Field Design

**Current Design**:

- Single string field for embedding
- Assumes unstructured text
- No structure preservation

**Why It Fails for Structured Data**:

❌ **JSON Objects**: How to represent `{id: 123, name: "Acme", revenue: 1M}`?

- Flatten to text? → `"id: 123, name: Acme, revenue: 1000000"` (loses type information)
- JSON.stringify? → `'{"id":123,"name":"Acme","revenue":1000000}'` (not semantic)
- Template? → `"Customer Acme (ID: 123) has revenue $1,000,000"` (custom per schema)

❌ **CSV Rows**: How to represent `1,Acme Corp,1000000,San Francisco`?

- Include headers? → `"id: 1, name: Acme Corp, revenue: 1000000, city: San Francisco"`
- Template? → Need column names and types
- Which columns to include? Not all columns are embeddable (IDs shouldn't be embedded)

❌ **Nested JSON**: How to represent `{customer: {name: "Acme", contacts: [{name: "John"}]}}`?

- Flatten? → Loses hierarchy
- Full JSON? → Poor semantic search
- Extract fields? → Need JSON path

❌ **Large Fields**: `description` field with 10KB text

- Truncate? → Loses information
- Split? → Creates orphaned chunks without context

**Required Changes**:

```typescript
// Option A: Keep content as string, but structure it carefully
content: string;  // Formatted text for embedding (template-based)

// Option B: Add structured content field
structuredContent: {
  raw: any;           // Original JSON/CSV row
  template: string;   // Formatted for embedding
  fields: Record<string, any>;  // Parsed fields
} | null;

// Option C (RECOMMENDED): Separate embeddable and filterable
embeddableContent: string;       // Text fields for vector embedding
filterableMetadata: Record<string, unknown>;  // Structured fields for filtering
```

**Impact**: HIGH - Affects all chunk creation and retrieval

---

### Problem 2: `chunkIndex` Field

**Current Design**:

- Sequential index within document (0, 1, 2, ...)
- Assumes linear document structure (page 1, page 2, page 3)

**Why It Fails for Structured Data**:

❌ **Table Rows**: Row 50 of 1000 rows

- `chunkIndex: 50` → Doesn't indicate it's a table row
- No way to know total row count
- No relationship to other rows

❌ **Nested JSON**: Array element at `data.customers[5].orders[2]`

- `chunkIndex: 7` → Doesn't preserve JSON path
- Can't reconstruct parent-child relationship
- No array position information

❌ **Large Field Chunks**: Description field split into 3 chunks

- `chunkIndex: 10, 11, 12` → Which field do these belong to?
- No indication they're sub-chunks of the same field
- Can't reassemble original field

**Required Changes**:

```typescript
chunkIndex: number;              // Keep for backwards compatibility

// NEW: Structured position fields
structuredPosition: {
  type: 'row' | 'field' | 'array_element' | 'nested_object';
  rowNumber?: number;            // For CSV/tables
  columnName?: string;           // For cell-level chunks
  jsonPath?: string;             // For nested JSON (e.g., "customer.contacts[0].name")
  arrayIndex?: number;           // Position in array
  chunkOffset?: number;          // For large field sub-chunks
  totalChunks?: number;          // Total sub-chunks for this field/row
} | null;
```

**Impact**: MEDIUM - Affects chunk navigation and reconstruction

---

### Problem 3: `metadata` Field (Raw Source Metadata)

**Current Design**:

- `metadata: any | null`
- Stores raw source metadata (from Docling, connectors, etc.)
- Unstructured - no schema enforcement

**Why It Fails for Structured Data**:

❌ **No Type Information**:

```typescript
metadata: {
  revenue: '1000000'; // String or number?
  date: '2024-01-15'; // String or Date?
  active: 'true'; // String or boolean?
}
```

❌ **No Column Schema**: For CSV/tables

```typescript
metadata: {
  // Where is column type information?
  // Where are column descriptions?
  // Which columns are required vs. optional?
}
```

❌ **No JSON Schema**: For JSON objects

```typescript
metadata: {
  // No schema defining structure
  // No validation rules
  // No field descriptions
}
```

❌ **Mixing Concerns**: Contains both document metadata AND record data

```typescript
metadata: {
  // Document metadata
  extractionTimestamp: "2024-01-15",
  sourceFile: "data.json",

  // Record data (should be in content or canonicalMetadata)
  customerId: 123,
  customerName: "Acme"
}
```

**Required Changes**:

```typescript
// Keep metadata for extraction metadata only
metadata: {
  extractionEngine: 'docling' | 'llamaindex' | 'custom';
  extractionTimestamp: Date;
  sourceFile: string;
  contentType: string;
  // NO record-level data here
} | null;

// NEW: Schema metadata (for tables/objects)
schemaMetadata: {
  tableName?: string;
  tableDescription?: string;
  columns?: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
    description?: string;
    required?: boolean;
    enum?: string[];
  }>;
  jsonSchema?: object;  // JSON Schema v7
  primaryKey?: string | string[];
  foreignKeys?: Array<{
    field: string;
    referencesTable: string;
    referencesField: string;
  }>;
} | null;
```

**Impact**: MEDIUM - Affects metadata storage and querying

---

### Problem 4: `canonicalMetadata` Field

**Current Design**:

- `canonicalMetadata: Record<string, unknown> | null`
- Flat key-value structure
- Materialized via `FieldMapping` at ingestion time
- Used for query filtering (`canonical.status = "active"`)

**Why It Fails for Structured Data**:

❌ **No Nested Objects**:

```typescript
// Original JSON
{
  customer: {
    name: "Acme",
    address: {
      city: "SF",
      state: "CA"
    }
  }
}

// Current canonicalMetadata (flat) - loses structure
canonicalMetadata: {
  "customer_name": "Acme",    // Flattened with underscore
  "customer_address_city": "SF",
  "customer_address_state": "CA"
}
```

❌ **No Arrays**:

```typescript
// Original JSON
{
  customer: {
    tags: ["vip", "enterprise", "west-coast"]
  }
}

// Current canonicalMetadata - no array support
canonicalMetadata: {
  "tags": "vip,enterprise,west-coast"  // String concatenation?
  // OR
  "tag_0": "vip",
  "tag_1": "enterprise",  // Numbered keys? Not queryable
  "tag_2": "west-coast"
}
```

❌ **No Filterable vs. Embeddable Separation**:

```typescript
canonicalMetadata: {
  id: 123,                  // Should NOT be embedded
  name: "Acme Corp",        // Should be embedded + filterable
  revenue: 1000000,         // Should NOT be embedded (numeric filter only)
  description: "Long text..."  // Should be embedded, maybe not filterable
}
// All fields treated equally - inefficient
```

❌ **No Type Preservation**:

```typescript
canonicalMetadata: {
  revenue: 1000000,   // Is this a number or string?
  active: true,       // Is this boolean or string "true"?
  date: "2024-01-15"  // Is this string or Date object?
}
// Runtime type confusion
```

❌ **No Relationship Metadata**:

```typescript
canonicalMetadata: {
  customerId: 123,
  // How do we know this references customers table?
  // How do we join with related records?
}
```

**Required Changes**:

```typescript
// CRITICAL: Split into filterable and embeddable
filterableMetadata: {
  // Pure metadata filters (NOT embedded)
  id: number | string;
  customerId: number;
  status: 'active' | 'inactive';
  revenue: number;
  createdDate: Date;
  region: string;
  category: string[];  // Support arrays
  // ... other filterable fields
};

embeddableMetadata: {
  // Text fields for semantic search (embedded + maybe filterable)
  name: string;
  title: string;
  description: string;
  summary: string;
  tags: string[];
  // ... other embeddable fields
};

// NEW: Nested structure support (if needed)
structuredMetadata: {
  // Preserve nested structure for complex queries
  customer: {
    name: string;
    address: {
      city: string;
      state: string;
    };
  };
} | null;

// NEW: Relationship metadata
relationshipMetadata: {
  recordType: 'customer' | 'order' | 'product';  // Entity type
  recordId: string | number;                      // Primary key
  parentRecordId?: string | number;               // For hierarchical data
  relatedRecords?: Array<{
    type: string;
    id: string | number;
    relationship: 'one-to-many' | 'many-to-one' | 'many-to-many';
  }>;
} | null;
```

**Impact**: CRITICAL - Affects all querying, filtering, and embedding

---

### Problem 5: Missing Chunk Type Field

**Current Reality**:

- No `chunkType` field
- All chunks treated as "text" chunks
- Can't distinguish chunk granularity

**Why It Fails for Structured Data**:

❌ **Can't Distinguish Row vs. Field vs. Array Element**:

```typescript
// Is this chunk:
// A) Entire table row?
// B) Single large field from a row?
// C) Array element?
// D) Nested object?
// → NO WAY TO TELL
```

❌ **Can't Apply Different Retrieval Strategies**:

```typescript
// Row-level chunk: Return entire row
// Field-level chunk: Need to fetch parent row
// Array element: Need to fetch parent array
// → No metadata to guide retrieval
```

❌ **Can't Reconstruct Original Structure**:

```typescript
// Given chunks [A, B, C], how do we know:
// - Which are siblings (same table/array)?
// - Which are parent-child (row → field)?
// - Which are independent records?
```

**Required Changes**:

```typescript
chunkType: 'text' | 'record' | 'field' | 'array_element' | 'nested_object' | 'table_summary';

// Examples:
// 'text' = Traditional unstructured text chunk (backwards compatible)
// 'record' = Entire table row or JSON object
// 'field' = Large field split into sub-chunk
// 'array_element' = Single element from array
// 'nested_object' = Nested JSON object as separate chunk
// 'table_summary' = Table-level metadata + sample rows
```

**Impact**: HIGH - Enables structured data-aware retrieval

---

### Problem 6: Missing Record Identity

**Current Reality**:

- No unique record identifier
- Chunks linked only by `documentId` + `chunkIndex`
- Can't identify "same record" across multiple chunks

**Why It Fails for Structured Data**:

❌ **Large Fields Split into Multiple Chunks**:

```typescript
// Customer record with large description field split into 3 chunks
Chunk 1: {documentId: "doc123", chunkIndex: 0}  // Row summary
Chunk 2: {documentId: "doc123", chunkIndex: 1}  // Description part 1
Chunk 3: {documentId: "doc123", chunkIndex: 2}  // Description part 2

// How do we know chunks 1-3 represent ONE customer?
// How do we retrieve "all chunks for customer 123"?
```

❌ **Cross-Table Relationships**:

```typescript
// Customer record: {id: 123, name: "Acme"}
// Order record: {id: 456, customerId: 123}

// How do we find all orders for customer 123?
// How do we join customer and order chunks?
```

❌ **Updates and Deduplication**:

```typescript
// Same customer in two different files
// How do we detect duplicates?
// How do we update existing record vs. create new?
```

**Required Changes**:

```typescript
// NEW: Record identity
recordId: string | number | null;     // Primary key value (e.g., customer ID)
recordType: string | null;             // Entity type (e.g., "customer", "order")
tableName: string | null;              // Table/collection name
primaryKeyField: string | null;        // Which field is the primary key

// NEW: Parent-child linking for large field chunks
parentChunkId: string | null;         // For field/array chunks → points to record chunk
childChunkIds: string[] | null;       // For record chunks → points to field chunks

// Example:
// Customer record chunk:
{
  chunkId: "chunk-123-main",
  recordId: 123,
  recordType: "customer",
  tableName: "customers",
  chunkType: "record",
  parentChunkId: null,
  childChunkIds: ["chunk-123-desc-0", "chunk-123-desc-1"]
}

// Description field chunk (part 1):
{
  chunkId: "chunk-123-desc-0",
  recordId: 123,
  recordType: "customer",
  chunkType: "field",
  parentChunkId: "chunk-123-main",
  fieldPath: "description",
  chunkOffset: 0
}
```

**Impact**: CRITICAL - Enables record-level operations and relationships

---

### Problem 7: Missing Table/Collection Context

**Current Reality**:

- No table name or collection name
- All chunks from all tables mixed together
- Can't filter by table

**Why It Fails for Structured Data**:

❌ **Multi-Table Documents**:

```typescript
// Excel with 3 sheets: Customers, Orders, Products
// All rows from all sheets become chunks
// How do we query "only customer records"?
```

❌ **Multi-Collection JSON**:

```typescript
// JSON with multiple arrays:
{
  customers: [...],
  orders: [...],
  products: [...]
}
// All objects become chunks
// How do we distinguish customer from order?
```

❌ **Table-Level Metadata**:

```typescript
// Table description: "Customer master data"
// Column descriptions
// Table constraints (primary key, foreign keys)
// → No place to store this
```

**Required Changes**:

```typescript
tableName: string | null; // Table/collection/sheet name
tableDescription: string | null; // Human-readable table description
```

**Impact**: MEDIUM - Enables table-scoped queries

---

### Problem 8: Missing Field Path / JSON Path

**Current Reality**:

- No JSON path tracking
- Can't identify "which field" a chunk comes from

**Why It Fails for Structured Data**:

❌ **Nested JSON Navigation**:

```typescript
// Original: {customer: {contacts: [{name: "John", email: "john@acme.com"}]}}
// Chunk created from "john@acme.com"
// → Can't tell this came from customer.contacts[0].email
```

❌ **Large Field Identification**:

```typescript
// Row with 10 columns, one is very large
// Chunk created from large column
// → Can't tell which column
```

❌ **Query Targeting**:

```typescript
// User query: "Find customers where notes mention X"
// → Can't filter chunks to only "notes" field
```

**Required Changes**:

```typescript
fieldPath: string | null; // JSON path or column name (e.g., "customer.contacts[0].email")
fieldName: string | null; // Simple field name (e.g., "email")
```

**Impact**: MEDIUM - Enables field-specific queries

---

## 2. ChunkHierarchy Model Analysis

### Current Schema

```typescript
interface IChunkHierarchy {
  _id: string;
  tenantId: string;
  indexId: string;
  documentId: string;

  // Hierarchy structure
  parentId: string | null;
  childIds: string[];
  depth: number; // 0 = root, max 4
  nodeType: 'root' | 'internal' | 'leaf';

  // Node content
  chunkId: string | null; // Points to SearchChunk if leaf
  summary: string | null; // For internal nodes
  similarityScore: number | null;
  tokenCount: number;
  positionInParent: number;

  metadata: Record<string, unknown> | null;
}
```

### Problem 9: Node Type Limited to Text Summarization

**Current Design**:

- `nodeType: 'root' | 'internal' | 'leaf'`
- Designed for text document summarization hierarchy
- Internal nodes have LLM-generated summaries

**Why It Fails for Structured Data**:

❌ **No Semantic Node Types**:

```typescript
// For table: Need node types like:
// - 'table' (root) → contains table metadata
// - 'row_group' (internal) → group of related rows
// - 'row' (leaf) → single table row

// For JSON: Need node types like:
// - 'object' (internal) → JSON object with properties
// - 'array' (internal) → JSON array of elements
// - 'primitive' (leaf) → String/number/boolean value
```

❌ **Summary vs. Schema**:

```typescript
// Internal node "summary" for table should be:
// - Table schema (columns, types, descriptions)
// - Sample rows
// NOT LLM-generated summary of content
```

❌ **Relationship Semantics**:

```typescript
// For tables: Parent-child means:
// - Table → Row (one-to-many)
// - Row → Field (for large fields)

// For JSON: Parent-child means:
// - Object → Property
// - Array → Element

// Current model: Only generic parent-child
```

**Required Changes**:

```typescript
nodeType: 'root' | 'internal' | 'leaf' |
          'table' | 'row' | 'field' |
          'object' | 'array' | 'array_element' |
          'primitive';

// NEW: Semantic type for structured data
semanticType: 'text_section' | 'table' | 'row' | 'column' | 'cell' |
              'json_object' | 'json_array' | 'json_primitive' |
              null;

// Summary vs. Schema distinction
summary: string | null;           // For text content
schemaInfo: {
  type: 'table' | 'object' | 'array';
  name?: string;
  description?: string;
  schema?: any;                   // JSON Schema or table schema
} | null;
```

**Impact**: MEDIUM - Enables structured hierarchy navigation

---

### Problem 10: No Position Beyond Sequential

**Current Design**:

- `positionInParent: number` (0, 1, 2, ...)
- Works for linear ordering

**Why It Fails for Structured Data**:

❌ **No Row Number**:

```typescript
// Table with 1000 rows
// Row 500 has positionInParent: 499
// But user wants to query "row number 500" (1-indexed)
```

❌ **No Column Index**:

```typescript
// Table with 20 columns
// Which column is this field from?
```

❌ **No Array Index**:

```typescript
// JSON array: contacts[5]
// positionInParent: 5
// But is this contacts[5] or orders[5]?
```

**Required Changes**:

```typescript
positionInParent: number;  // Keep for backwards compatibility

// NEW: Structured position
structuredPosition: {
  rowNumber?: number;       // 1-indexed row number
  columnIndex?: number;     // 0-indexed column
  columnName?: string;      // Column name
  arrayIndex?: number;      // 0-indexed array position
  objectKey?: string;       // Object property name
} | null;
```

**Impact**: LOW - Nice to have for precise positioning

---

## 3. CanonicalSchema Model Analysis

### Current Schema

```typescript
interface ICanonicalField {
  name: string;
  label: string;
  type: string;
  description?: string;
  indexed: boolean; // Full-text indexed?
  filterable: boolean; // Can filter on this field?
  aggregatable: boolean; // Can aggregate on this field?
  enumValues?: string[];
}

interface ICanonicalSchema {
  _id: string;
  tenantId: string;
  knowledgeBaseId: string;
  version: number;
  fields: ICanonicalField[];
  status: string;
}
```

### Problem 11: No `embeddable` Flag

**Current Flags**:

- `indexed`: Full-text search indexing
- `filterable`: Can use in filters
- `aggregatable`: Can use in aggregations

**Missing Flag**:

- `embeddable`: Should this field go into vector embeddings?

**Why It Matters**:

❌ **Waste of Embedding Tokens**:

```typescript
// These should NOT be embedded:
{name: "id", type: "number", filterable: true, embeddable: false}
{name: "customerId", type: "number", filterable: true, embeddable: false}
{name: "status", type: "enum", filterable: true, embeddable: false}
{name: "createdDate", type: "date", filterable: true, embeddable: false}

// These SHOULD be embedded:
{name: "description", type: "text", filterable: false, embeddable: true}
{name: "notes", type: "text", filterable: false, embeddable: true}
{name: "title", type: "string", filterable: true, embeddable: true}  // Both!
```

❌ **No Hybrid Fields**:

```typescript
// Product name should be:
// - Filterable (exact match: name = "iPhone")
// - Embeddable (semantic: "smartphone" matches "iPhone")

// Current schema: Can't express this
{name: "productName", type: "string", filterable: true, embeddable: ???}
```

**Required Changes**:

```typescript
interface ICanonicalField {
  name: string;
  label: string;
  type: string;
  description?: string;

  // Existing flags
  indexed: boolean;
  filterable: boolean;
  aggregatable: boolean;

  // NEW: Embedding flag
  embeddable: boolean; // Should field go into vector embedding?

  // NEW: Embedding config
  embeddingConfig?: {
    weight?: number; // Relative importance in embedding (0-1)
    template?: string; // How to format for embedding
    maxLength?: number; // Max chars to embed (truncate long fields)
  };

  enumValues?: string[];
}
```

**Impact**: CRITICAL - Optimizes embedding costs and quality

---

### Problem 12: Type System Too Simple

**Current Types**:

- `type: string` (free-form)
- No standard type vocabulary
- No nested types

**Why It Fails for Structured Data**:

❌ **No Standard Types**:

```typescript
// What are valid types?
type: "string"?
type: "text"?
type: "varchar"?
type: "char"?
// → Inconsistent

type: "number"?
type: "integer"?
type: "float"?
type: "decimal"?
// → Ambiguous
```

❌ **No Array Types**:

```typescript
// How to represent string array?
type: "string[]"?
type: "array<string>"?
type: "array"?
// → No standard

// How to define array element type?
```

❌ **No Object Types**:

```typescript
// How to represent nested object?
{
  name: "address",
  type: "object",  // But what are the properties?
  properties: ???  // No field for this
}
```

❌ **No Reference Types**:

```typescript
// How to represent foreign key?
{
  name: "customerId",
  type: "number",  // Just a number, not a reference
  // How to indicate it references customers.id?
}
```

**Required Changes**:

```typescript
interface ICanonicalField {
  name: string;
  label: string;

  // NEW: Standard type system
  type:
    | 'string'
    | 'number'
    | 'boolean'
    | 'date'
    | 'datetime'
    | 'array'
    | 'object'
    | 'reference'
    | 'enum'
    | 'json';

  // For array types
  arrayElementType?: 'string' | 'number' | 'boolean' | 'object';

  // For object types
  properties?: ICanonicalField[]; // Nested fields

  // For reference types (foreign keys)
  referenceTo?: {
    table: string;
    field: string;
  };

  // For enum types
  enumValues?: string[];

  // Type constraints
  constraints?: {
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    pattern?: string; // Regex for validation
    required?: boolean;
  };

  description?: string;
  indexed: boolean;
  filterable: boolean;
  aggregatable: boolean;
  embeddable: boolean;
}
```

**Impact**: HIGH - Enables proper type handling and validation

---

### Problem 13: No Table/Collection Metadata

**Current Design**:

- `ICanonicalSchema` has `fields[]`
- But no concept of "tables" or "collections"
- All fields are flat

**Why It Fails for Structured Data**:

❌ **Multi-Table Schemas**:

```typescript
// How to represent:
// - Customers table (id, name, email)
// - Orders table (id, customerId, amount)
// - Products table (id, name, price)

// Current schema: All fields in one flat list
fields: [
  {name: "customer_id", type: "number"},
  {name: "customer_name", type: "string"},
  {name: "order_id", type: "number"},
  {name: "order_customerId", type: "number"},
  ...
]
// → Loses table boundaries
```

❌ **Table-Level Metadata**:

```typescript
// No place for:
// - Table name
// - Table description
// - Primary key definition
// - Indexes
// - Foreign key relationships
```

❌ **Cross-Table Queries**:

```typescript
// How to express:
// "Find customers with orders > $1000"
// → Need to know customers and orders are separate tables
// → Need to know they're linked by customerId
```

**Required Changes**:

```typescript
// NEW: Table-aware schema
interface ICanonicalTable {
  name: string;
  label: string;
  description?: string;

  fields: ICanonicalField[];

  primaryKey: string | string[]; // Single or composite key
  indexes?: Array<{
    name: string;
    fields: string[];
    unique?: boolean;
  }>;
  foreignKeys?: Array<{
    fields: string[];
    referencesTable: string;
    referencesFields: string[];
  }>;
}

interface ICanonicalSchema {
  _id: string;
  tenantId: string;
  knowledgeBaseId: string;
  version: number;

  // NEW: Table-based structure
  tables: ICanonicalTable[]; // Instead of flat fields[]

  // NEW: Cross-table relationships
  relationships?: Array<{
    fromTable: string;
    fromField: string;
    toTable: string;
    toField: string;
    type: 'one-to-one' | 'one-to-many' | 'many-to-many';
  }>;

  status: string;
}
```

**Impact**: HIGH - Enables multi-table structured data

---

## 4. FieldMapping Model Analysis

### Current Schema

```typescript
interface IFieldTransform {
  type: string;
  valueMap?: Record<string, string>;
  expression?: string;
  sources?: string[];
  computeExpression?: string;
  sourceFormat?: string;
  delimiter?: string;
}

interface IFieldMapping {
  _id: string;
  tenantId: string;
  canonicalSchemaId: string;
  canonicalField: string; // Target canonical field
  connectorId: string;
  sourcePath: string; // Path in source (e.g., "customer.name")
  transform: IFieldTransform;
  confidence: number;
  status: string;
  suggestedBy: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
}
```

### Problem 14: Transform Types Don't Handle Arrays

**Current Transform Types** (inferred from `IFieldTransform`):

- `direct`: Copy value as-is
- `valueMap`: Map values (enum translation)
- `expression`: Apply expression
- `sources`: Combine multiple fields
- `computeExpression`: Compute from multiple sources

**Missing Transforms**:

❌ **Array Flattening**:

```typescript
// Source: ["tag1", "tag2", "tag3"]
// Target: "tag1, tag2, tag3"
// No transform for this
```

❌ **Array Element Extraction**:

```typescript
// Source: [{name: "John"}, {name: "Jane"}]
// Target: ["John", "Jane"]
// No transform for extracting nested field from array
```

❌ **Array Filtering**:

```typescript
// Source: [{status: "active", name: "John"}, {status: "inactive", name: "Jane"}]
// Target: ["John"]  (only active)
// No transform for filtering array elements
```

❌ **Array Index Access**:

```typescript
// Source: ["primary@email.com", "secondary@email.com"]
// Target: "primary@email.com"  (first element)
// No transform for array indexing
```

**Required Changes**:

```typescript
interface IFieldTransform {
  type:
    | 'direct'
    | 'valueMap'
    | 'expression'
    | 'sources'
    | 'computeExpression'
    | 'arrayFlatten'
    | 'arrayExtract'
    | 'arrayFilter'
    | 'arrayIndex'
    | 'arrayJoin';

  // Existing
  valueMap?: Record<string, string>;
  expression?: string;
  sources?: string[];
  computeExpression?: string;
  sourceFormat?: string;
  delimiter?: string;

  // NEW: Array handling
  arrayTransform?: {
    operation: 'flatten' | 'extract' | 'filter' | 'index' | 'join';
    extractField?: string; // For nested field extraction
    filterCondition?: string; // For filtering (e.g., "status = 'active'")
    index?: number; // For array indexing (e.g., 0 for first)
    joinDelimiter?: string; // For array joining (e.g., ", ")
  };
}
```

**Impact**: MEDIUM - Enables array field mappings

---

### Problem 15: Source Path Lacks JSON Path Support

**Current Design**:

- `sourcePath: string`
- Appears to support dot notation (e.g., "customer.name")
- But no standard for array indexing

**Ambiguities**:

❌ **Array Access**:

```typescript
// How to access contacts[0].email?
sourcePath: "contacts[0].email"?  // JavaScript style
sourcePath: "contacts.0.email"?   // Dot notation
sourcePath: "contacts/0/email"?   // JSON Pointer style
```

❌ **Wildcard Access**:

```typescript
// How to access all contact emails?
sourcePath: "contacts[*].email"?
sourcePath: "contacts.*.email"?
```

❌ **Deep Nesting**:

```typescript
// customer.orders[0].items[2].name
sourcePath: ???
```

**Required Changes**:

```typescript
interface IFieldMapping {
  // ... existing fields ...

  // Clarify: Use JSONPath standard
  sourcePath: string; // JSONPath (e.g., "$.customer.contacts[0].email")

  // NEW: Optional compiled path for performance
  compiledPath?: {
    segments: Array<{
      type: 'property' | 'array' | 'wildcard';
      value: string | number;
    }>;
  };
}
```

**Impact**: LOW - Clarifies array access syntax

---

## 5. Missing Models

### Problem 16: No Table/Collection Metadata Model

**Current Reality**:

- No dedicated model for table/collection metadata
- Table info scattered across chunks
- No centralized table schema

**What's Needed**:

```typescript
interface ITableMetadata {
  _id: string;
  tenantId: string;
  indexId: string;
  documentId: string;

  // Table identity
  tableName: string;
  tableType: 'csv' | 'excel_sheet' | 'json_array' | 'database_table';

  // Description
  title?: string;
  description?: string;

  // Schema
  columns: Array<{
    name: string;
    type: string;
    description?: string;
    nullable?: boolean;
    unique?: boolean;
  }>;

  // Keys
  primaryKey?: string | string[];
  foreignKeys?: Array<{
    fields: string[];
    referencesTable: string;
    referencesFields: string[];
  }>;

  // Statistics
  rowCount: number;
  estimatedTokens: number;

  // Sample data
  sampleRows?: any[]; // First 5-10 rows for LLM context

  // Indexing strategy
  indexStrategy: 'row-level' | 'field-level' | 'hybrid';

  createdAt: Date;
  updatedAt: Date;
}
```

**Impact**: MEDIUM - Enables table-level operations

---

## Summary of Critical Gaps

### By Priority

**CRITICAL (Must Fix)**:

1. ❌ `content` field doesn't support structured data → Add `embeddableContent` + `filterableMetadata`
2. ❌ No `embeddable` flag in `CanonicalField` → Add to optimize embeddings
3. ❌ `canonicalMetadata` is flat, no type preservation → Split into `filterableMetadata` + `embeddableMetadata`
4. ❌ No `recordId` to link chunks of same record → Add `recordId`, `recordType`, `parentChunkId`

**HIGH (Should Fix)**: 5. ❌ No `chunkType` to distinguish row/field/array → Add `chunkType` enum 6. ❌ Type system too simple → Add array/object/reference types 7. ❌ No table-level metadata → Add table/collection schema fields

**MEDIUM (Nice to Have)**: 8. ❌ `chunkIndex` assumes linear structure → Add `structuredPosition` 9. ❌ No semantic node types in hierarchy → Add `semanticType` 10. ❌ No table metadata model → Create `TableMetadata` model

**LOW (Can Defer)**: 11. ❌ Position beyond sequential → Add `structuredPosition` details 12. ❌ Transform types don't handle arrays well → Add array transforms

---

## Recommendations

### Phase 1: Extend SearchChunk (Backwards Compatible)

Add new optional fields to `SearchChunk` without breaking existing code:

```typescript
interface ISearchChunk {
  // ... all existing fields (keep as-is) ...

  // NEW: Structured data support
  chunkType?: 'text' | 'record' | 'field' | 'array_element' | 'nested_object';
  recordId?: string | number;
  recordType?: string;
  tableName?: string;
  fieldPath?: string;
  parentChunkId?: string;

  filterableMetadata?: Record<string, unknown>;
  embeddableMetadata?: Record<string, unknown>;

  schemaMetadata?: {
    columns?: Array<{ name: string; type: string; description?: string }>;
    primaryKey?: string;
  };
}
```

### Phase 2: Extend CanonicalField

Add `embeddable` flag and better type system:

```typescript
interface ICanonicalField {
  // ... existing fields ...

  // NEW:
  embeddable: boolean;
  arrayElementType?: string;
  referenceTo?: { table: string; field: string };
}
```

### Phase 3: Create TableMetadata Model

New model for table-level metadata.

### Phase 4: Update Extraction Pipeline

Modify docling-service and page-processing-worker to populate new fields.

---

## Next Steps

1. ✅ **Task #18 - Research** (Completed)
2. ✅ **Task #19 - Schema Review** (Current - Completed)
3. ⏭️ **Task #20 - Design Mappings** - Concrete chunk examples for JSON/CSV/Excel
4. ⏭️ **Task #21 - Chunking Algorithm** - Large field splitting strategy
5. ⏭️ **Task #22 - Prototype** - Build and validate

---

## Conclusion

The current schema has **16 critical gaps** preventing effective structured data support. The most urgent fixes are:

1. Split `canonicalMetadata` → `filterableMetadata` + `embeddableMetadata`
2. Add `chunkType`, `recordId`, `tableName`, `fieldPath` to `SearchChunk`
3. Add `embeddable` flag to `CanonicalField`
4. Add type system for arrays, objects, references

These changes are **backwards compatible** and can be rolled out incrementally without breaking existing unstructured text pipelines.
