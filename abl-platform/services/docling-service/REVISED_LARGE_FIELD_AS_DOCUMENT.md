# Revised Approach: Treat Large Fields as Documents

**Date**: 2026-02-23
**Insight**: Large text fields should be treated as mini-documents, not as structured data requiring parent-child relationships

## Problem with Parent-Child Approach

**Current Design** (from RELATIONSHIP_GRAPH_LOGIC.md):

```
Customer record with large "notes" field (5000 chars):
├─ Main record chunk (id, name, status, revenue)
│  └─ childChunkIds: [chunk_field_0, chunk_field_1, chunk_field_2]
├─ Field chunk 0 (notes, chars 0-3200)
│  └─ parentChunkId: main_chunk
├─ Field chunk 1 (notes, chars 3000-6200, with overlap)
│  └─ parentChunkId: main_chunk
└─ Field chunk 2 (notes, chars 6000-8000)
   └─ parentChunkId: main_chunk

Problem:
- Arbitrary 800-token chunks with 200-token overlap
- Breaks semantic boundaries (mid-sentence, mid-paragraph)
- Complex parent-child relationship management
- Different from how we chunk documents
```

**Issues**:

1. ❌ **Inconsistent chunking**: Document chunks respect semantic boundaries, field chunks don't
2. ❌ **Complex relationships**: Need parent-child tracking, reconstruction logic
3. ❌ **Poor retrieval**: Arbitrary splits hurt semantic search quality
4. ❌ **Duplicate logic**: Can't reuse existing document chunkers (markdown-chunker, semantic-splitter)

---

## Revised Approach: Large Fields as Documents

### Core Principle

**"A 5000-char notes field IS a document, not structured data."**

Treat it the same way we treat a 5000-char markdown file:

- Chunk semantically (respect paragraphs, sentences)
- Each chunk is independent
- Store structured fields separately (in ClickHouse)
- Link via recordId (not parent-child relationships)

---

## Revised Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  INGESTION: CSV with large "notes" field                       │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Step 1: Classify fields                                       │
│    ├─ Structured: id, name, status, revenue                    │
│    └─ Document: notes (5000 chars)                             │
│                                                                 │
│  Step 2: Store structured data                                 │
│    ClickHouse Table: customers                                     │
│    ┌────┬──────────┬────────┬─────────┬──────────────┐        │
│    │ id │ name     │ status │ revenue │ notes_doc_id │        │
│    ├────┼──────────┼────────┼─────────┼──────────────┤        │
│    │ 1  │ Acme     │ active │ 1000000 │ doc_notes_1  │        │
│    │ 2  │ Beta Inc │ active │ 500000  │ doc_notes_2  │        │
│    └────┴──────────┴────────┴─────────┴──────────────┘        │
│                                                                 │
│  Step 3: Extract large text fields as documents                │
│    notes[record_1] → Document "doc_notes_1"                    │
│    │                                                            │
│    └─ Process through document pipeline:                       │
│       ├─ Markdown chunker (if markdown-formatted)              │
│       ├─ Semantic splitter (if plain text)                     │
│       └─ Respect paragraphs, sentences, semantic boundaries    │
│                                                                 │
│  Step 4: Create document chunks (NOT field chunks)             │
│    Chunk 1: "Customer onboarded in Q1 2020..."                 │
│    Chunk 2: "Recent interactions show high satisfaction..."    │
│    Chunk 3: "Future expansion plans include..."                │
│                                                                 │
│    Each chunk:                                                 │
│    {                                                            │
│      chunkType: "text",  // NOT "field"!                       │
│      documentId: "doc_notes_1",                                │
│      sourceRecordId: 1,  // Link back to ClickHouse record         │
│      sourceTable: "customers",                                 │
│      sourceField: "notes",                                     │
│      content: "...",                                            │
│      // No parentChunkId, no childChunkIds                     │
│    }                                                            │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

---

## Detailed Flow

### Step 1: Field Classification

During schema analysis, classify fields by **nature**, not just size:

```typescript
interface FieldClassification {
  name: string;
  dataType: 'structured' | 'document';
  storageStrategy: 'clickhouse' | 'document_chunks' | 'both';
}

function classifyField(column: ColumnSchema): FieldClassification {
  // Document fields: long text with semantic structure
  if (column.type === 'string' && column.isEmbeddable) {
    const avgLength = estimateAvgLength(column);

    if (avgLength > 1000) {
      // > 250 tokens
      return {
        name: column.name,
        dataType: 'document',
        storageStrategy: 'document_chunks', // Treat as document
      };
    } else if (avgLength > 100) {
      // 25-250 tokens
      return {
        name: column.name,
        dataType: 'document',
        storageStrategy: 'both', // Store in ClickHouse + create chunks
      };
    }
  }

  // Structured fields: everything else
  return {
    name: column.name,
    dataType: 'structured',
    storageStrategy: 'clickhouse', // Just store in ClickHouse
  };
}
```

**Classification Examples**:

| Field       | Type   | Avg Length | Data Type  | Storage Strategy           |
| ----------- | ------ | ---------- | ---------- | -------------------------- |
| id          | number | N/A        | structured | clickhouse                 |
| name        | string | 20         | structured | clickhouse                 |
| status      | enum   | 10         | structured | clickhouse                 |
| revenue     | number | N/A        | structured | clickhouse                 |
| description | string | 200        | document   | both (ClickHouse + chunks) |
| notes       | string | 5000       | document   | document_chunks            |
| address     | string | 50         | structured | clickhouse                 |
| email       | string | 30         | structured | clickhouse                 |

### Step 2: Store Structured Data in ClickHouse

**All structured fields + reference to document fields**:

```typescript
// For each row
const structuredFields = extractStructuredFields(row, fieldClassifications);
const documentFields = extractDocumentFields(row, fieldClassifications);

// Insert into ClickHouse
await clickhouse.exec(
  `
  INSERT INTO customers (id, name, status, revenue, notes_doc_id)
  VALUES (?, ?, ?, ?, ?)
`,
  [
    row.id,
    row.name,
    row.status,
    row.revenue,
    `doc_notes_${row.id}`, // Reference to document chunks
  ],
);
```

**Result**:

```sql
SELECT * FROM customers;

| id | name     | status | revenue | notes_doc_id  |
|----|----------|--------|---------|---------------|
| 1  | Acme     | active | 1000000 | doc_notes_1   |
| 2  | Beta Inc | active | 500000  | doc_notes_2   |
```

### Step 3: Extract Document Fields

**Treat as mini-documents**:

```typescript
async function extractDocumentField(
  fieldValue: string,
  recordId: string | number,
  tableName: string,
  fieldName: string,
): Promise<DocumentToChunk> {
  // Create a virtual document
  return {
    documentId: `doc_${tableName}_${fieldName}_${recordId}`,
    content: fieldValue,
    metadata: {
      sourceTable: tableName,
      sourceField: fieldName,
      sourceRecordId: recordId,
    },
    format: detectFormat(fieldValue), // 'markdown', 'plain', 'html'
  };
}
```

**Example**:

```typescript
// Customer 1's notes field (5000 chars)
const notesDoc = {
  documentId: 'doc_customers_notes_1',
  content: `
# Customer Onboarding Notes

## Q1 2020
Customer onboarded in January 2020. Initial contact was through trade show.
Key decision makers: CTO (Jane Smith), VP Engineering (Bob Lee).

## Engagement History
- Jan 2020: Initial demo, positive feedback
- Mar 2020: Pilot program with 10 users
- Jun 2020: Expanded to 100 users
- Sep 2020: Full rollout (500 users)

## Recent Activity
Q4 2024 check-in showed high satisfaction (NPS: 85). Customer expressed interest
in expanding to APAC region in 2025. Budget approved for additional licenses.

## Future Plans
- Q1 2025: APAC expansion (200 additional users)
- Q2 2025: Enterprise tier upgrade
- Potential upsell: Advanced analytics module
  `,
  metadata: {
    sourceTable: 'customers',
    sourceField: 'notes',
    sourceRecordId: 1,
  },
  format: 'markdown',
};
```

### Step 4: Chunk Using Document Pipeline

**Reuse existing document chunkers**:

```typescript
async function chunkDocumentField(
  doc: DocumentToChunk,
  options: ChunkingOptions,
): Promise<ISearchChunk[]> {
  // Determine chunker based on format
  let chunker: DocumentChunker;

  if (doc.format === 'markdown') {
    chunker = new MarkdownChunker({
      maxChunkSize: 1024,
      preserveStructure: true,
    });
  } else if (doc.format === 'plain') {
    chunker = new SemanticChunker({
      maxChunkSize: 1024,
      respectSentences: true,
      respectParagraphs: true,
    });
  } else {
    chunker = new SimpleTextChunker({
      maxChunkSize: 1024,
      overlap: 200,
    });
  }

  // Chunk the document
  const textChunks = await chunker.chunk(doc.content);

  // Convert to SearchChunk format
  return textChunks.map((textChunk, index) => ({
    _id: new ObjectId(),
    tenantId: '<to-be-set>',
    indexId: '<to-be-set>',
    documentId: doc.documentId,

    // Key: chunkType is "text", not "field"
    chunkType: 'text',

    // Link back to source record
    sourceRecordId: doc.metadata.sourceRecordId,
    sourceTable: doc.metadata.sourceTable,
    sourceField: doc.metadata.sourceField,

    // No parent-child relationships!
    parentChunkId: null,
    childChunkIds: [],

    // Content from document chunker
    content: textChunk.text,
    contentHash: hashContent(textChunk.text),
    tokenCount: textChunk.tokenCount,

    // Metadata for retrieval
    filterableMetadata: {
      // Inherit structured fields from the record
      customerId: doc.metadata.sourceRecordId,
      // Can join with ClickHouse to get: name, status, revenue
    },
    embeddableMetadata: null, // Content already in 'content' field

    chunkIndex: index,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
}
```

**Result Chunks**:

```typescript
// Chunk 1: Onboarding section
{
  documentId: "doc_customers_notes_1",
  chunkType: "text",
  sourceRecordId: 1,
  sourceTable: "customers",
  sourceField: "notes",
  content: `# Customer Onboarding Notes

## Q1 2020
Customer onboarded in January 2020. Initial contact was through trade show.
Key decision makers: CTO (Jane Smith), VP Engineering (Bob Lee).`,
  chunkIndex: 0
}

// Chunk 2: Engagement history
{
  documentId: "doc_customers_notes_1",
  chunkType: "text",
  sourceRecordId: 1,
  sourceTable: "customers",
  sourceField: "notes",
  content: `## Engagement History
- Jan 2020: Initial demo, positive feedback
- Mar 2020: Pilot program with 10 users
- Jun 2020: Expanded to 100 users
- Sep 2020: Full rollout (500 users)`,
  chunkIndex: 1
}

// Chunk 3: Recent activity
{
  documentId: "doc_customers_notes_1",
  chunkType: "text",
  sourceRecordId: 1,
  sourceTable: "customers",
  sourceField: "notes",
  content: `## Recent Activity
Q4 2024 check-in showed high satisfaction (NPS: 85). Customer expressed interest
in expanding to APAC region in 2025. Budget approved for additional licenses.`,
  chunkIndex: 2
}

// Chunk 4: Future plans
{
  documentId: "doc_customers_notes_1",
  chunkType: "text",
  sourceRecordId: 1,
  sourceTable: "customers",
  sourceField: "notes",
  content: `## Future Plans
- Q1 2025: APAC expansion (200 additional users)
- Q2 2025: Enterprise tier upgrade
- Potential upsell: Advanced analytics module`,
  chunkIndex: 3
}
```

**Key Differences from Parent-Child Approach**:

- ✅ **Semantic boundaries respected**: Chunks split at markdown headers, not arbitrary token counts
- ✅ **Independent chunks**: No parent-child relationships needed
- ✅ **Consistent with documents**: Uses same chunking logic as PDF/DOCX
- ✅ **Better retrieval**: Each chunk is semantically coherent

---

## Retrieval Patterns

### Pattern 1: Semantic Search on Document Fields

**Query**: "Find customers with APAC expansion plans"

**Execution**:

```typescript
// Step 1: Vector search on text chunks
const vectorResults = await vectorStore.search({
  embedding: await embed('APAC expansion plans'),
  filter: {
    sourceTable: 'customers',
    sourceField: 'notes',
  },
  topK: 20,
});

// Step 2: Extract sourceRecordIds
const customerIds = [...new Set(vectorResults.map((r) => r.sourceRecordId))];

// Step 3: Fetch full records from ClickHouse
const customers = await clickhouse.all(`
  SELECT * FROM customers
  WHERE id IN (${customerIds.join(',')})
`);

// Step 4: Return combined results
return customers.map((customer) => ({
  ...customer,
  matchedChunks: vectorResults.filter((r) => r.sourceRecordId === customer.id),
}));
```

**Result**:

```json
[
  {
    "id": 1,
    "name": "Acme Corp",
    "status": "active",
    "revenue": 1000000,
    "matchedChunks": [
      {
        "content": "## Future Plans\n- Q1 2025: APAC expansion (200 additional users)...",
        "score": 0.92
      }
    ]
  }
]
```

### Pattern 2: Hybrid Query (Structured Filter + Semantic)

**Query**: "Find active customers with revenue > $500k interested in AI"

**Execution**:

```typescript
// Step 1: SQL filter for structured criteria
const customerIds = await clickhouse.all(`
  SELECT id FROM customers
  WHERE status = 'active' AND revenue > 500000
`);

// Step 2: Vector search on text chunks (filtered by customerIds)
const vectorResults = await vectorStore.search({
  embedding: await embed('interested in AI'),
  filter: {
    sourceTable: 'customers',
    sourceRecordId: { $in: customerIds.map((c) => c.id) },
  },
  topK: 10,
});

// Step 3: Fetch full records
const results = await clickhouse.all(`
  SELECT * FROM customers
  WHERE id IN (${vectorResults.map((r) => r.sourceRecordId).join(',')})
`);
```

### Pattern 3: Reconstruct Full Document Field

**Query**: "Get full notes for customer 1"

**Execution**:

```typescript
// Step 1: Find all chunks for this document field
const chunks = await db.searchChunks
  .find({
    sourceTable: 'customers',
    sourceField: 'notes',
    sourceRecordId: 1,
  })
  .sort({ chunkIndex: 1 })
  .toArray();

// Step 2: Concatenate (no overlap removal needed - semantic chunks don't overlap)
const fullNotes = chunks.map((c) => c.content).join('\n\n');

return fullNotes;
```

**Much Simpler** than parent-child reconstruction:

- No overlap removal needed (semantic chunks don't have artificial overlap)
- No complex parent-child traversal
- Just sort by `chunkIndex` and concatenate

---

## Comparison: Parent-Child vs Document Approach

| Aspect                | Parent-Child Approach              | Document Approach                         |
| --------------------- | ---------------------------------- | ----------------------------------------- |
| **Chunking**          | Arbitrary 800 tokens + 200 overlap | Semantic (paragraphs, sections)           |
| **Relationships**     | Complex parent-child tracking      | Simple: link via sourceRecordId           |
| **Chunker**           | Custom field chunker               | Reuse markdown-chunker, semantic-splitter |
| **Retrieval quality** | Poor (breaks sentences)            | Good (respects semantics)                 |
| **Reconstruction**    | Complex (overlap removal)          | Simple (concatenate by index)             |
| **Consistency**       | Different from document pipeline   | Same as document pipeline                 |
| **Code complexity**   | High (relationship management)     | Low (standard document flow)              |

---

## Implementation Changes

### Updated SearchChunk Schema

**Remove parent-child fields, add document source fields**:

```typescript
interface ISearchChunk {
  // ... existing fields ...

  // Remove these (no longer needed):
  // parentChunkId: ObjectId | null;
  // childChunkIds: ObjectId[];
  // chunkOffset: number | null;  // Not needed for semantic chunks

  // Add these instead:
  sourceRecordId: string | number | null; // Link to ClickHouse record
  sourceTable: string | null; // Table name in ClickHouse
  sourceField: string | null; // Field name (e.g., "notes")

  // chunkType is just "text" (not "field")
  chunkType: 'text' | 'record' | 'table_schema';
}
```

### Updated Relationship Graph

**No more parent-child relationships!**

Only two types remain:

1. **Foreign Key**: Cross-table joins (e.g., orders → customers)
2. **Same-Record**: NOT NEEDED anymore (we can query by sourceRecordId)

```typescript
// Old: Need same-record relationships to find all chunks of a record
db.chunkRelationships.find({
  relationType: 'same_record',
  sourceRecordId: 12345,
});

// New: Direct query on sourceRecordId (no relationships needed)
db.searchChunks.find({
  sourceTable: 'customers',
  sourceRecordId: 12345,
});
```

### Simplified Ingestion Pipeline

**Before** (6 steps):

1. Parse file
2. Analyze schema
3. Generate chunks (record + field chunks)
4. Build relationship graph (parent-child + foreign keys + same-record)
5. Generate embeddings
6. Store

**After** (5 steps):

1. Parse file
2. Analyze schema
3. Split into structured data (ClickHouse) + document fields
4. Chunk document fields using document pipeline
5. Generate embeddings and store

**One step removed**: No relationship graph building for parent-child/same-record!

---

## Migration Path

### Phase 1: Support Both Approaches

Keep parent-child logic for backward compatibility, add document approach:

```typescript
async function generateChunksForRow(
  row: Record<string, any>,
  schema: TableSchema,
  options: ChunkingOptions,
): Promise<ISearchChunk[]> {
  const chunks: ISearchChunk[] = [];

  // Classify fields
  const { structured, documentFields } = classifyRowFields(row, schema);

  // Option 1: Document approach (new, recommended)
  if (options.useDocumentApproach) {
    for (const fieldName of documentFields) {
      const docChunks = await chunkAsDocument(row[fieldName], row.id, schema.tableName, fieldName);
      chunks.push(...docChunks);
    }
  }
  // Option 2: Parent-child approach (old, for backward compatibility)
  else {
    const mainChunk = createRecordChunk(row, structured);
    chunks.push(mainChunk);

    for (const fieldName of largeFields) {
      const fieldChunks = chunkLargeField(row[fieldName], mainChunk._id);
      chunks.push(...fieldChunks);
    }
  }

  return chunks;
}
```

### Phase 2: Default to Document Approach

Make document approach default, keep parent-child as opt-in:

```typescript
const options = {
  useDocumentApproach: true, // Default
  useLegacyFieldChunking: false,
};
```

### Phase 3: Remove Parent-Child Logic

After migration, remove:

- `parentChunkId`, `childChunkIds` fields
- `chunkOffset` field
- Parent-child relationship creation
- Same-record relationship creation
- Overlap removal logic in reconstruction

---

## Summary

### Key Changes

1. ✅ **Large text fields are documents**, not structured data
2. ✅ **Reuse document chunking pipeline** (markdown-chunker, semantic-splitter)
3. ✅ **No parent-child relationships** needed
4. ✅ **Link via sourceRecordId** (simple, clean)
5. ✅ **Better retrieval quality** (respects semantic boundaries)
6. ✅ **Consistent with document pipeline**

### What This Means

**Before**:

```
Customer record with large "notes":
├─ Record chunk (id, name, status)
│  └─ childChunkIds: [field_0, field_1, field_2]  ← Complex!
├─ Field chunk 0 (arbitrary 800 tokens)
├─ Field chunk 1 (arbitrary 800 tokens)
└─ Field chunk 2 (rest)
```

**After**:

```
Customer record with large "notes":
├─ ClickHouse row: (id=1, name="Acme", status="active", notes_doc_id="doc_notes_1")
└─ Document chunks (notes field → treated as document):
   ├─ Chunk 0: "# Onboarding Notes\n## Q1 2020..."
   ├─ Chunk 1: "## Engagement History..."
   ├─ Chunk 2: "## Recent Activity..."
   └─ Chunk 3: "## Future Plans..."

   Each chunk links back via sourceRecordId=1
```

### Benefits

| Benefit                 | Impact                                              |
| ----------------------- | --------------------------------------------------- |
| **Code simplification** | Remove 500+ lines of parent-child logic             |
| **Better chunking**     | Respects semantic boundaries (paragraphs, sections) |
| **Consistency**         | Same chunking logic for all text content            |
| **Easier retrieval**    | Simple query by sourceRecordId                      |
| **Better UX**           | Users see coherent chunks, not mid-sentence breaks  |

### Next Steps

1. Update STRUCTURED_DATA_INGESTION_DESIGN.md to use document approach
2. Remove parent-child logic from RELATIONSHIP_GRAPH_LOGIC.md
3. Update sub-tasks to reflect simplified approach
4. Implement document field extraction in ingestion pipeline
