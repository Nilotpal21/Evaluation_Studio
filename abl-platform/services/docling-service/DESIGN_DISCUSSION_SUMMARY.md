# Structured Data Design Discussion Summary

**Date**: 2026-02-23
**Purpose**: Capture key design decisions and discussions from structured data ingestion and search design

---

## Key Design Documents Created

1. **CHUNK_SCHEMA_MAPPING.md** - Field classification and schema mapping
2. **STRUCTURED_DATA_INGESTION_DESIGN.md** - Complete ingestion pipeline
3. **TWO_PHASE_INGESTION_API.md** - Analyze + finalize workflow
4. **RELATIONSHIP_GRAPH_LOGIC.md** - Foreign key detection logic
5. **BIG_TABLE_TEXT_TO_SQL_RESEARCH.md** - Text-to-SQL approach for tables
6. **REVISED_LARGE_FIELD_AS_DOCUMENT.md** - Large text fields as documents
7. **TABLE_DISCOVERY_AND_ROUTING.md** - Table discovery for 100+ tables
8. **METADATA_GENERATION.md** - Automatic table metadata generation
9. **MULTI_TABLE_SEARCH_STRATEGY.md** - Multi-table search handling

---

## Critical Design Decisions

### 1. Use ClickHouse Instead of DuckDB

**Decision**: Replace DuckDB with existing ClickHouse infrastructure for structured data storage.

**Rationale**:

- ✅ Already deployed in platform (no new dependencies)
- ✅ Distributed and scalable
- ✅ Column-oriented for fast analytics
- ✅ Better fit for existing architecture

**Impact**:

- All design documents updated to reference ClickHouse
- MergeTree engine for standard tables
- Distributed tables for sharding
- Task #27 updated to "ClickHouse integration"

**Documents**: BIG_TABLE_TEXT_TO_SQL_RESEARCH.md, REVISED_LARGE_FIELD_AS_DOCUMENT.md

---

### 2. Make LLM Generation Optional for Metadata

**Decision**: LLM-based table/column descriptions are optional, controlled by index-level configuration.

**Configuration Pattern** (follows existing chunking config):

```typescript
{
  chunkingConfig: {
    enableLLM: true,  // Master switch
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini'
  },
  structuredDataConfig: {
    enableLLMMetadataGeneration: true  // Optional override
  }
}
```

**Precedence**: `structuredDataConfig` → `chunkingConfig` → default

**Two Generation Paths**:

| Aspect                  | LLM Enabled                                   | LLM Disabled                      |
| ----------------------- | --------------------------------------------- | --------------------------------- |
| **Table descriptions**  | Natural language, contextual (~$0.0001/table) | Heuristic-based, formulaic (free) |
| **Column descriptions** | Semantic for unknown columns                  | Pattern matching + fallback       |
| **Cost (100 tables)**   | $0.10                                         | $0.01                             |
| **Time (100 tables)**   | ~7 minutes                                    | ~2 minutes                        |
| **Search quality**      | Excellent                                     | Good                              |
| **Privacy**             | Sends sample data to LLM                      | No external calls                 |

**Heuristic Fallbacks**:

- Table name humanization: `order_items` → "Order Items"
- Column pattern matching: `created_at` → "Creation timestamp"
- Generic descriptions: `user_agent` → "User Agent (text)"

**Recommendation**:

- **Use LLM**: Production indexes, user-facing search, diverse schemas
- **Skip LLM**: Testing, internal tools, privacy-sensitive data, cost optimization

**Documents**: METADATA_GENERATION.md

---

### 3. Table Discovery: What Content Gets Searched

**Question**: "On which content do we do semantic + keyword search?"

**Answer**: We search **table metadata**, NOT actual row data.

**Content Indexed**:

| Component               | Example                                 | Used For             |
| ----------------------- | --------------------------------------- | -------------------- |
| **Table Name**          | `customers`, `orders`                   | Keyword + semantic   |
| **Table Description**   | "Customer records with company info..." | Semantic             |
| **Column Names**        | `customer_id`, `revenue`, `status`      | Keyword + semantic   |
| **Column Types**        | `string`, `number`, `date`              | Query classification |
| **Column Descriptions** | "Annual revenue in USD"                 | Semantic             |
| **Sample Rows**         | 5-10 representative rows (JSON)         | LLM context          |
| **Statistics**          | Min/max/avg, distributions              | Ranking              |
| **Foreign Keys**        | `{ sourceColumn, targetTable }`         | Join detection       |

**Example**:

- **Table**: `customers` with 100,000 rows
- **What gets embedded**: ~500-1000 char summary (table name + description + column info + 5 sample rows + stats)
- **What does NOT get embedded**: The other 99,995 rows

**Key Insight**: We search metadata to find the right **TABLE**, then query ClickHouse to get the actual **DATA**.

**Documents**: TABLE_DISCOVERY_AND_ROUTING.md (added "What Content Gets Searched?" section)

---

### 4. Multi-Table Search Strategy

**Question**: "Multiple tables can qualify for searching, how do we finalize the table or do we perform search on all qualified tables?"

**Answer**: LLM-based intelligent table selection, not blind search of all candidates.

**Three Strategies**:

#### Strategy 1: Single Table (80% of cases, fastest)

- LLM selects 1 most relevant table
- Generate SQL for single table
- Execute on ClickHouse
- **Latency**: ~2-3s

**Example**: "Find technology companies with revenue over $1M"

- Discovery returns: `customers`, `accounts`, `companies`, `revenue_summary`, `sales_pipeline`
- LLM selects: `customers` (has descriptions + revenue column)
- Execute: 1 SQL query on `customers` table

#### Strategy 2: Join Search (tables with FK relationships)

- LLM identifies join requirement
- Generate SQL with INNER/LEFT JOIN
- Execute single joined query
- **Latency**: ~3-4s

**Example**: "Show me customers with their recent orders"

- LLM selects: `customers` + `orders`
- Join: `customers.id = orders.customer_id`
- Execute: 1 SQL query with JOIN

#### Strategy 3: Union Search (independent tables)

- Search each table in parallel
- Merge and rank results by relevance
- Deduplicate entities
- **Latency**: ~4-5s

**Example**: "Find all mentions of 'Project Alpha'"

- LLM selects: `projects`, `tasks`, `documents`
- Execute: 3 parallel SQL queries
- Merge: Combine results, rank by relevance, deduplicate

**Key Decisions**:

1. ✅ LLM selects tables (not blind search)
2. ✅ Prefer single table (simpler, faster)
3. ✅ Maximum 3 tables limit (performance)
4. ✅ Parallel execution (union searches)
5. ✅ Entity resolution (deduplication)
6. ✅ Flat result list with `sourceTable` attribution

**Result Format**:

```typescript
interface MultiTableSearchResult {
  query: string;
  strategy: 'single_table' | 'join' | 'union';
  tables: string[];
  results: Array<{
    sourceTable: string;
    relevanceScore: number;
    [key: string]: any;
  }>;
  totalResults: number;
  executionTimeMs: number;
  explanation: string;
}
```

**Documents**: MULTI_TABLE_SEARCH_STRATEGY.md

---

### 5. Metadata Generation Process

**Question**: "How do we generate this table metadata?"

**Answer**: Automated 6-step pipeline during Phase 1 (analyze) of two-phase ingestion API.

**Pipeline**:

```
1. Schema Analysis (500ms)
   - Infer column types (integer, number, string, enum, date, boolean)
   - Detect primary key (pattern matching + uniqueness check)
   - Calculate null percentages

2. Statistics Calculation (200ms)
   - Numeric: min, max, avg, percentiles
   - Categorical: value distributions (active: 80%, inactive: 15%, trial: 5%)
   - String: average length

3. Sample Row Selection (50ms)
   - Stratified sampling (5-10 rows representing all categories)
   - Diversity across categorical columns

4. Description Generation (3s or 15ms)
   - WITH LLM: Natural language table/column descriptions
   - WITHOUT LLM: Heuristic-based + generic fallbacks

5. Embedding Creation (500ms)
   - Combine: table name + description + columns + sample rows
   - Generate 1536-dim vector

6. Storage (100ms)
   - ClickHouse: table_metadata table (~5 KB)
   - MongoDB: embeddings collection (~10 KB)
```

**Cost & Time**:

| Metric             | LLM Enabled   | LLM Disabled   |
| ------------------ | ------------- | -------------- |
| **Per table**      | $0.001, ~4s   | $0.0001, ~1.3s |
| **Per 100 tables** | $0.10, ~7 min | $0.01, ~2 min  |

**User Override**: After automatic generation, users can customize descriptions in the review step (between Phase 1 and Phase 2).

**Documents**: METADATA_GENERATION.md

---

### 6. Large Text Fields as Documents (Not Parent-Child)

**Decision**: Treat large text fields (>1000 chars) as mini-documents, not as structured data with parent-child relationships.

**Old Approach** (rejected):

- Main record chunk + field chunks with `parentChunkId`/`childChunkIds`
- Arbitrary 800-token splits with 200-token overlap
- Breaks semantic boundaries (mid-sentence, mid-paragraph)
- Complex relationship management

**New Approach** (approved):

- Large text fields processed through document pipeline
- Use existing chunkers (markdown-chunker, semantic-splitter)
- Link via `sourceRecordId`, `sourceTable`, `sourceField` (NOT parent-child)
- Semantically coherent chunks (respects paragraphs, sections)

**Benefits**:

- ✅ Code simplification: Remove 500+ lines of parent-child logic
- ✅ Better chunking: Respects semantic boundaries
- ✅ Consistency: Same chunking logic for all text
- ✅ Easier retrieval: Simple query by sourceRecordId
- ✅ Better UX: Coherent chunks, not mid-sentence breaks

**Example**:

```typescript
// Large field (5000 chars) → ClickHouse row + document chunks
ClickHouse row: { id: 1, name: "Acme", notes_doc_id: "doc_notes_1" }
Document chunks: [
  { chunkType: "text", sourceRecordId: 1, content: "# Onboarding Notes..." },
  { chunkType: "text", sourceRecordId: 1, content: "## Recent Activity..." }
]
```

**Documents**: REVISED_LARGE_FIELD_AS_DOCUMENT.md

---

### 7. Big Table Problem: Don't Chunk Every Row

**Decision**: Store full table in ClickHouse + use text-to-SQL for queries. DON'T chunk every row.

**Problem with Row-by-Row Chunking**:

- 100k rows → 100k chunks → $1.00 embedding cost + 1.5 GB storage
- Wrong query pattern: Vector search returns "similar" rows, not aggregations
- Can't do SQL operations: SUM, AVG, GROUP BY, COUNT

**Solution**:

1. **ClickHouse for data**: Store full table, enable SQL queries
2. **Vector search for text**: Only semantic fields (descriptions, notes)
3. **Text-to-SQL**: LLM generates SQL from natural language
4. **Hybrid queries**: Combine vector search + SQL filters
5. **Smart chunking**: Only chunk rows with text content (>100 chars)

**Cost Comparison** (100k row table):

| Metric             | Current | Recommended | Savings |
| ------------------ | ------- | ----------- | ------- |
| **Embedding cost** | $1.00   | $0.01       | 99%     |
| **Storage**        | 1.5 GB  | 50 MB       | 97%     |
| **Query latency**  | 200ms   | 50ms (SQL)  | 75%     |

**Documents**: BIG_TABLE_TEXT_TO_SQL_RESEARCH.md

---

### 8. Table Discovery for 100+ Tables

**Decision**: Semantic + keyword search on table metadata with multi-layer tenant/index isolation.

**Components**:

1. **Table Metadata Index**
   - ClickHouse: `table_metadata` table (schema, stats, sample rows)
   - MongoDB: `table_metadata_embeddings` collection (1536-dim vectors)
   - Indexed by: (tenantId, indexId, tableName)

2. **Discovery Engine**
   - Semantic search: Vector search on embeddings
   - Keyword search: SQL ILIKE on table/column names
   - Ranking: Combine scores with boost factors

3. **LLM Table Selector**
   - Evaluates top 5 candidates
   - Selects 1-3 most relevant tables
   - Provides reasoning for selection

4. **Multi-Layer Isolation**
   - API Layer: Verify tenant owns index (404 if not)
   - Discovery Layer: Filter vector search by `{ tenantId, indexId }`
   - SQL Generation: Inject `WHERE tenant_id = ? AND index_id = ?`
   - Execution Layer: Final validation before query

5. **Performance Optimizations**
   - 5-minute metadata cache
   - Pre-computed table relevance scores
   - 200 table limit per index (recommended)

**Security Checklist**:

- [x] Tenant isolation at API layer
- [x] Tenant isolation at discovery layer
- [x] Tenant isolation at SQL generation
- [x] Tenant isolation at execution
- [x] Authorization checks
- [x] SQL injection prevention
- [x] No information leakage
- [x] Audit logging

**Documents**: TABLE_DISCOVERY_AND_ROUTING.md

---

### 9. Two-Phase Ingestion API

**Decision**: Phase 1 analyzes and generates metadata, Phase 2 finalizes after user review.

**Phase 1: Analyze** (no chunks created)

```
POST /api/v1/indexes/:indexId/ingest/analyze
Response: {
  analysisId: "analysis_abc123",
  tables: [{ tableName, columns, sampleData, foreignKeys }],
  recommendations: [{ type: 'warning', message }],
  estimatedCosts: {
    totalChunks: 2500,
    embeddingTokens: 1200000,
    estimatedEmbeddingCost: "$0.12"
  }
}
```

**User Review**: Approve/edit metadata, add custom descriptions

**Phase 2: Finalize** (creates chunks + stores data)

```
POST /api/v1/indexes/:indexId/ingest/finalize
{
  analysisId: "analysis_abc123",
  overrides: {
    tables: {
      customers: {
        description: "Custom description",
        columns: { revenue: "Custom column description" }
      }
    }
  }
}
```

**Benefits**:

- ✅ User reviews before expensive ingestion
- ✅ Catches errors early (foreign key detection, schema issues)
- ✅ Cost estimation before committing
- ✅ Allows custom descriptions for better search

**Documents**: TWO_PHASE_INGESTION_API.md

---

## Implementation Roadmap

### Phase 1: Core Infrastructure (Tasks #27, #24)

- ClickHouse integration for structured data storage
- Two-phase ingestion API (analyze + finalize)
- Table metadata generation (with optional LLM)
- Metadata storage (ClickHouse + MongoDB)

### Phase 2: Relationship Detection (Task #25)

- Foreign key detection (naming convention + value overlap)
- False positive prevention (type matching, cardinality checks)
- Relationship graph storage

### Phase 3: Query Infrastructure (Tasks #26, #29, #30)

- Table discovery engine (semantic + keyword)
- LLM table selector
- Text-to-SQL generator
- Multi-table search strategies (single, join, union)
- Query router (semantic vs SQL vs hybrid)

### Phase 4: Smart Chunking (Task #28)

- Document approach for large text fields
- Smart row chunking (only text-heavy rows)
- Integration with existing document chunkers

### Phase 5: Testing & Optimization (Task #22)

- Security tests (tenant/index isolation)
- Performance tests (100+ tables, 100k+ rows)
- Search quality validation
- Cost optimization

---

## Key Metrics

### Ingestion Costs

| Scenario                       | LLM ON   | LLM OFF  |
| ------------------------------ | -------- | -------- |
| **100 tables, 100k rows each** |          |          |
| Metadata generation            | $10      | $1       |
| Text field embeddings          | $100     | $100     |
| **Total**                      | **$110** | **$101** |
| **Time**                       | ~7 hours | ~6 hours |

### Query Performance

| Query Type           | Latency | Components                                                          |
| -------------------- | ------- | ------------------------------------------------------------------- |
| **Single table**     | ~2-3s   | Discovery (1s) + SQL gen (500ms) + Execution (50-200ms)             |
| **Join (2 tables)**  | ~3-4s   | Discovery (1s) + SQL gen (1s) + Execution (100-500ms)               |
| **Union (3 tables)** | ~4-5s   | Discovery (1s) + SQL gen (1.5s) + Execution (600ms) + Merge (100ms) |

### Cost Savings

| Optimization              | Before      | After       | Savings |
| ------------------------- | ----------- | ----------- | ------- |
| **Don't chunk every row** | $1.00/table | $0.01/table | 99%     |
| **LLM optional metadata** | $0.10/index | $0.01/index | 90%     |
| **Smart chunking**        | 100k chunks | 1k chunks   | 99%     |

---

## Open Questions & Future Work

### 1. Cross-Index Queries

- **Current**: Disallowed by default (security + performance)
- **Future**: Optional with explicit permission (`tenant:query_cross_index`)

### 2. Incremental Updates

- **Current**: Full table re-ingestion
- **Future**: Incremental row updates, metadata refresh

### 3. Column-Level Permissions

- **Current**: Table-level access control
- **Future**: Hide sensitive columns per user role

### 4. Query Caching

- **Current**: No caching
- **Future**: Cache SQL results for repeated queries (5-minute TTL)

### 5. Table Recommendations

- **Current**: User manually adds tables
- **Future**: Suggest related tables during ingestion

---

## References

All design documents are in: `/services/docling-service/`

**Key Files**:

- `CHUNK_SCHEMA_MAPPING.md` - Field classification matrix
- `BIG_TABLE_TEXT_TO_SQL_RESEARCH.md` - Text-to-SQL approach
- `TABLE_DISCOVERY_AND_ROUTING.md` - Table discovery design
- `METADATA_GENERATION.md` - Metadata generation pipeline
- `MULTI_TABLE_SEARCH_STRATEGY.md` - Multi-table search strategies
- `TWO_PHASE_INGESTION_API.md` - Analyze + finalize workflow
- `REVISED_LARGE_FIELD_AS_DOCUMENT.md` - Document approach for large fields
- `RELATIONSHIP_GRAPH_LOGIC.md` - Foreign key detection logic

**Related Issues**:

- Task #15: Design and implement hierarchical tree extraction
- Task #24: Implement two-phase ingestion API
- Task #25: Implement foreign key detection
- Task #26: Research and implement text-to-SQL
- Task #27: Integrate with ClickHouse infrastructure
- Task #28: Implement smart chunking strategy
- Task #29: Implement query router
- Task #30: Design and implement table discovery

**Last Updated**: 2026-02-23
