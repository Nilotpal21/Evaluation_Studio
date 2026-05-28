# Structured Data Extraction Research

**Task #18**: Research hierarchical structured data extraction approaches
**Date**: 2026-02-23
**Status**: In Progress

## Executive Summary

Research into extracting and indexing structured data (JSON, CSV, Excel) for semantic search reveals significant gaps in our current chunk schema. The existing system is designed for unstructured text documents and lacks primitives for hierarchical relationships, table semantics, and filterable vs. embeddable field separation.

## Current System Analysis

### Existing Schema Components

#### 1. SearchChunk Model

```typescript
interface ISearchChunk {
  _id: string;
  tenantId: string;
  indexId: string;
  documentId: string;
  content: string; // Full chunk text for embedding
  tokenCount: number;
  chunkIndex: number; // Position in document
  vectorId: string | null; // External vector store ID
  metadata: any | null; // Raw source metadata
  canonicalMetadata: Record<string, unknown> | null; // Materialized via field mappings
  status: string;
}
```

**Problems for Structured Data**:

- ❌ `content` assumes unstructured text - doesn't handle JSON objects, table rows
- ❌ `canonicalMetadata` is flat - can't represent nested JSON hierarchies
- ❌ No distinction between filterable-only vs. embeddable fields
- ❌ No table schema metadata (column names, types, descriptions)
- ❌ No JSON path or hierarchical position
- ❌ No support for array elements or repeated fields

#### 2. ChunkHierarchy Model

```typescript
interface IChunkHierarchy {
  parentId: string | null;
  childIds: string[];
  depth: number;
  nodeType: 'root' | 'internal' | 'leaf';
  chunkId: string | null; // Points to SearchChunk if leaf
  summary: string | null; // For internal nodes
  similarityScore: number | null;
}
```

**Strengths**:

- ✅ Already supports parent-child relationships
- ✅ Max depth 4, max children 10 (good for balanced trees)
- ✅ Internal node summaries (could be table/object summaries)

**Gaps for Structured Data**:

- ❌ Designed for text summarization, not structured data relationships
- ❌ No semantic type (table, row, object, array, field)
- ❌ Missing positional context (row number, column index, JSON path)
- ❌ No cross-document relationships (table joins, foreign keys)

#### 3. CanonicalSchema + FieldMapping

```typescript
interface ICanonicalField {
  name: string;
  type: string;
  indexed: boolean; // For full-text search
  filterable: boolean; // For faceted filtering
  aggregatable: boolean; // For aggregations
}

interface IFieldMapping {
  canonicalField: string;
  sourcePath: string; // Path in source schema
  transform: IFieldTransform;
}
```

**Strengths**:

- ✅ Already has indexed/filterable/aggregatable flags
- ✅ Transform system for mapping source to canonical
- ✅ Supports source path (could be JSON path)

**Gaps**:

- ❌ No embeddable flag (which fields go into vectors?)
- ❌ Transform types don't handle arrays or nested objects
- ❌ No table schema representation
- ❌ No support for repeated fields or array elements

### Key Problems Identified

1. **No Structured Data Primitives**
   - Current system: unstructured text chunks
   - Need: JSON object chunks, table row chunks, array element chunks

2. **Flat Metadata**
   - Current: `canonicalMetadata: Record<string, unknown>`
   - Need: Nested objects, arrays, JSON paths

3. **No Filterable vs. Embeddable Separation**
   - Current: All fields in `canonicalMetadata` (assumed filterable)
   - Need: Separate `filterableMetadata` and `embeddableContent`

4. **No Table/Schema Awareness**
   - Current: No concept of tables, rows, columns
   - Need: Table metadata (name, description, column schemas)

5. **Large Content Field Problem**
   - Current: `content` field for embedding (single string)
   - Need: Chunking strategy for large fields within records

6. **No Cross-Record Relationships**
   - Current: Chunks are independent
   - Need: Table joins, foreign keys, related records

## Industry Survey

### LlamaIndex Approach

LlamaIndex has specialized loaders for structured data:

**JSON Loader**:

```python
from llama_index import JSONReader

# Approach 1: Flatten to text
reader = JSONReader()
docs = reader.load_data(Path('data.json'))
# Result: Each JSON object becomes a text document

# Approach 2: Structured extraction
from llama_index.indices.struct_store import SQLStructStoreIndex
index = SQLStructStoreIndex.from_documents(docs, sql_database=db)
# Result: Stores in SQL, queries via text-to-SQL
```

**Insights**:

- ✅ Flatten complex JSON to text for vector search
- ✅ Preserve structure in separate SQL store for filtering
- ✅ Hybrid retrieval: vector search + SQL filters
- ❌ Loses nested structure in vector search
- ❌ Requires maintaining two stores (vectors + SQL)

**CSV/Table Loader**:

```python
from llama_index import PandasCSVReader

reader = PandasCSVReader(pandas_config={"header": 0})
docs = reader.load_data(Path('data.csv'))
# Result: Each row becomes a document
```

**Insights**:

- ✅ Row-level granularity (entire row as one chunk)
- ✅ Column metadata in document metadata
- ❌ No semantic grouping by table
- ❌ No handling of large cell content

### LangChain Approach

**JSON Document Loader**:

```python
from langchain.document_loaders import JSONLoader

# Option 1: Extract specific JSON paths
loader = JSONLoader(
    file_path='data.json',
    jq_schema='.messages[].content',  # Extract nested field
    text_content=False
)

# Option 2: Flatten entire object
loader = JSONLoader(file_path='data.json', jq_schema='.')
docs = loader.load()
```

**Insights**:

- ✅ Uses JQ for flexible JSON path extraction
- ✅ Can extract nested fields
- ❌ Still flattens to text
- ❌ Doesn't preserve object structure for filtering

**CSV Loader**:

```python
from langchain.document_loaders.csv_loader import CSVLoader

loader = CSVLoader(file_path='data.csv', csv_args={'delimiter': ','})
docs = loader.load()
# Result: Each row -> one Document
```

**Insights**:

- ✅ Simple row-level chunking
- ❌ No table-level metadata
- ❌ No column type inference

### Pandas AI / PandasAI

**Table-Aware Semantic Search**:

```python
from pandasai import SmartDataframe

df = pd.read_csv('sales.csv')
sdf = SmartDataframe(df, config={"llm": llm})

# Natural language query
result = sdf.chat("What were total sales in Q3?")
# Converts to SQL/Pandas, executes, returns result
```

**Insights**:

- ✅ Preserves table structure
- ✅ Text-to-code generation (SQL/Pandas)
- ✅ Column type inference
- ❌ Requires LLM per query (expensive)
- ❌ Not vector-based retrieval

### Vanna AI

**Text-to-SQL with Semantic Layer**:

```python
from vanna import Vanna

vn = Vanna(config={'api_key': 'your-key'})
vn.connect_to_sqlite('my_database.sqlite')

# Train on table schemas
vn.train(ddl="CREATE TABLE customers (id INT, name TEXT, ...)")

# Query with natural language
sql = vn.generate_sql("Show top customers by revenue")
results = vn.run_sql(sql)
```

**Insights**:

- ✅ Preserves full SQL schema
- ✅ Semantic layer over structured data
- ✅ Handles joins and aggregations
- ❌ Requires SQL database
- ❌ Not suitable for semi-structured JSON

### Weaviate Structured Data Approach

**Multi-Vector with References**:

```python
{
  "class": "Customer",
  "properties": {
    "name": "Acme Corp",  # Filterable
    "description": "...",  # Embeddable
    "revenue": 1000000,   # Filterable
  },
  "vectorizer": "text2vec-openai",  # Only "description" vectorized
  "references": [
    {"beacon": "weaviate://localhost/Order/123"}
  ]
}
```

**Insights**:

- ✅ Separate filterable and embeddable fields
- ✅ Cross-object references (like foreign keys)
- ✅ Schema-aware (each class has defined properties)
- ✅ Hybrid search (vector + filters)
- ❌ Requires defining classes upfront
- ❌ Not suitable for dynamic JSON schemas

### Pinecone Sparse-Dense Approach

**Hybrid Index (Dense + Sparse)**:

```python
# Dense vectors for semantic search
dense_vector = model.encode("customer data...")

# Sparse vectors for exact keyword match
sparse_vector = bm25_encoder.encode_documents(["Acme Corp", "ID:12345"])

index.upsert([{
    'id': 'customer-123',
    'values': dense_vector,  # 1536-dim OpenAI embedding
    'sparse_values': sparse_vector,  # BM25 sparse vector
    'metadata': {
        'name': 'Acme Corp',  # Filterable
        'revenue': 1000000,    # Filterable
    }
}])

# Hybrid query (semantic + keyword + filter)
results = index.query(
    vector=query_dense,
    sparse_vector=query_sparse,
    filter={'revenue': {'$gte': 500000}},
    top_k=10
)
```

**Insights**:

- ✅ Hybrid retrieval (semantic + keyword + filters)
- ✅ Metadata for filtering (separate from vectors)
- ✅ Efficient for tabular data
- ❌ Flat metadata (no nested objects)
- ❌ No hierarchical relationships

## Key Findings

### 1. Retrieval Patterns for Structured Data

**Row-Level Retrieval** (Most common):

- Use case: "Find customers with high revenue"
- Chunk granularity: Entire row
- Embedding: Concatenate all text columns
- Filtering: Numeric/categorical columns

**Cell-Level Retrieval** (For large fields):

- Use case: "Find rows where description mentions X"
- Chunk granularity: Individual cells (for large text fields)
- Embedding: Single field value
- Linking: Row ID to reconstruct full record

**Hierarchical Retrieval** (For nested JSON):

- Use case: "Find products where reviews mention quality"
- Chunk granularity: Nested objects
- Embedding: Object subtree as text
- Linking: JSON path to preserve hierarchy

**Table-Level Retrieval** (For multi-table queries):

- Use case: "Find all data about customer X"
- Chunk granularity: Cross-table
- Embedding: Table description + sample rows
- Linking: Foreign key relationships

### 2. Filterable vs. Embeddable Field Separation

**Critical Insight**: Not all fields should go into embeddings

**Filterable-Only Fields**:

- IDs, keys, foreign keys
- Numeric values (revenue, age, count)
- Enums/categories (status, type, region)
- Dates/timestamps
- Booleans (isActive, hasDiscount)

**Embeddable Fields**:

- Text descriptions
- Comments/notes
- Names/titles (for semantic matching)
- Content fields (articles, reviews)

**Hybrid Fields** (Both):

- Product names (filter + semantic)
- Category names
- Short text fields with semantic value

### 3. Large Content Field Problem

**Scenario**: JSON record with 10KB "description" field

**Options**:

A. **Truncate** (Simplest)

- ✅ Fast, no extra chunks
- ❌ Loses information
- ❌ Poor retrieval for long content

B. **Chunk + Link** (Recommended)

- ✅ Preserves all content
- ✅ Maintains context via parent ID
- ❌ More chunks (storage cost)
- ❌ Requires multi-hop retrieval

C. **Summarize + Chunk** (Hybrid)

- ✅ Summary in parent record (fast retrieval)
- ✅ Full content in child chunks (precision)
- ❌ LLM cost for summarization
- ❌ Two-stage retrieval

**Recommendation**: Chunk + Link with overlap

```typescript
// Parent chunk (row/record)
{
  chunkId: "customer-123-main",
  content: "Acme Corp (ID: 12345) - Summary: Technology company...",
  filterableMetadata: {
    id: 12345,
    name: "Acme Corp",
    revenue: 1000000,
    status: "active"
  },
  embeddableMetadata: {
    summary: "Technology company...",
    industry: "Software"
  },
  chunkType: "record",
  recordId: "12345"
}

// Child chunk (large field)
{
  chunkId: "customer-123-description-0",
  content: "Acme Corp is a leading technology company specializing in...",
  parentChunkId: "customer-123-main",
  filterableMetadata: {
    id: 12345,  // Inherited
    fieldName: "description"
  },
  chunkType: "field",
  recordId: "12345",
  fieldPath: "description",
  chunkOffset: 0
}
```

## Recommendations

### 1. Schema Extensions

Add structured data support to SearchChunk:

```typescript
interface ISearchChunk {
  // ... existing fields ...

  // NEW: Structured data support
  chunkType: 'text' | 'record' | 'field' | 'array_element' | 'nested_object';
  recordId: string | null; // Unique record identifier (row ID, JSON object ID)
  parentChunkId: string | null; // For field/array chunks
  tableName: string | null; // Table or collection name
  fieldPath: string | null; // JSON path or column name
  rowNumber: number | null; // For CSV/table rows
  chunkOffset: number | null; // For large field chunking

  // NEW: Separate filterable and embeddable metadata
  filterableMetadata: Record<string, unknown> | null; // Pure filters (IDs, numbers, enums)
  embeddableMetadata: Record<string, unknown> | null; // Goes into embedding

  // NEW: Schema metadata (for tables/objects)
  schemaMetadata: {
    columns?: Array<{ name: string; type: string; description?: string }>;
    jsonSchema?: object;
    primaryKey?: string;
    foreignKeys?: Array<{ field: string; references: string }>;
  } | null;
}
```

### 2. Extraction Strategies by Format

#### JSON Strategy

**Approach: Hierarchical with Path Preservation**

```typescript
{
  "customer": {
    "id": 12345,
    "name": "Acme Corp",
    "contacts": [
      {"name": "John", "email": "john@acme.com"},
      {"name": "Jane", "email": "jane@acme.com"}
    ],
    "notes": "Very long notes field with 5000 characters..."
  }
}
```

**Chunking**:

1. Root object → one chunk (if small)
2. Large fields → separate chunks with `fieldPath`
3. Arrays → iterate elements, each gets `arrayIndex`
4. Nested objects → preserve `jsonPath`

**Result**:

```
Chunk 1 (record): customer (id=12345, name=Acme Corp)
Chunk 2 (array_element): customer.contacts[0] (John)
Chunk 3 (array_element): customer.contacts[1] (Jane)
Chunk 4 (field): customer.notes (chunk 0-2000 chars)
Chunk 5 (field): customer.notes (chunk 2000-4000 chars with overlap)
```

#### CSV/Table Strategy

**Approach: Row-Level with Column Schema**

```csv
id,name,revenue,description
1,Acme Corp,1000000,"Very long description..."
2,Beta Inc,500000,"Another long description..."
```

**Chunking**:

1. Each row → one chunk (if description < 1000 chars)
2. Large cells → separate chunks linked to row
3. Table schema → stored once in first chunk or separate metadata

**Result**:

```
Chunk 1 (record): Row 1 (id=1, name=Acme Corp, revenue=1000000)
  filterableMetadata: {id: 1, revenue: 1000000}
  embeddableMetadata: {name: "Acme Corp", description: "..."}

Chunk 2 (record): Row 2 (id=2, name=Beta Inc, revenue=500000)
  filterableMetadata: {id: 2, revenue: 500000}
  embeddableMetadata: {name: "Beta Inc", description: "..."}
```

#### Excel Strategy

**Approach: Multi-Sheet with Sheet Context**

```
Sheet 1: Customers (100 rows, 10 columns)
Sheet 2: Orders (500 rows, 8 columns)
```

**Chunking**:

1. Each sheet treated as separate table
2. Sheet name in `tableName` field
3. Same row-level chunking as CSV
4. Cross-sheet references via `foreignKeys`

### 3. Embedding Strategy

**What Gets Embedded**:

- Text fields (descriptions, notes, comments)
- Names/titles (for semantic matching)
- Short text enums (for semantic categories)
- Concatenation of relevant fields

**What Stays Filterable-Only**:

- IDs and keys
- Pure numeric values
- Dates/timestamps
- Booleans
- Internal codes

**Embedding Format** (for row-level chunks):

```
Table: Customers
Name: Acme Corp
Industry: Software
Description: Leading technology company specializing in...
Notes: Customer since 2020. Very satisfied with service...
```

### 4. Chunking Thresholds

```typescript
const CHUNKING_THRESHOLDS = {
  MAX_RECORD_TOKENS: 1000, // Max tokens for entire record
  MAX_FIELD_TOKENS: 500, // Max tokens for single field before chunking
  CHUNK_SIZE: 800, // Target chunk size for large fields
  CHUNK_OVERLAP: 200, // Overlap between consecutive field chunks
  MIN_CHUNK_SIZE: 100, // Don't create tiny chunks
  INLINE_THRESHOLD: 200, // Inline fields smaller than this
};
```

### 5. Retrieval Quality Considerations

**For Exact Matches** (IDs, status, etc.):

- Use `filterableMetadata` filters, not vector search
- Example: `{filterableMetadata.status: "active"}`

**For Semantic Queries** (descriptions, etc.):

- Vector search on `content` field
- Boost with `embeddableMetadata` fields

**For Hybrid Queries**:

- Combine filters + vector search
- Example: "Find active customers with high satisfaction" → filter status=active + vector search on reviews

**For Hierarchical Queries** (find parent given child):

- Use `parentChunkId` to traverse up
- Use `ChunkHierarchy` for tree traversal

**For Large Result Sets** (table scan):

- Don't embed entire tables
- Use table summary chunk + sample rows
- Link to full rows via `recordId`

## Next Steps

1. ✅ **Task #18 - Research** (Current)
2. ⏭️ **Task #19 - Review Schema** - Detailed analysis of gaps
3. ⏭️ **Task #20 - Design Mappings** - Concrete schema for JSON/CSV/Excel
4. ⏭️ **Task #21 - Chunking Strategy** - Algorithm for large content
5. ⏭️ **Task #22 - Prototype** - Build and validate

## References

- LlamaIndex Structured Data: https://docs.llamaindex.ai/en/stable/module_guides/loading/connector/modules/
- LangChain JSONLoader: https://python.langchain.com/docs/integrations/document_loaders/json
- Weaviate Hybrid Search: https://weaviate.io/developers/weaviate/search/hybrid
- Pinecone Sparse-Dense: https://docs.pinecone.io/guides/data/understanding-hybrid-search
- PandasAI: https://pandas-ai.com/
- Vanna AI: https://vanna.ai/
