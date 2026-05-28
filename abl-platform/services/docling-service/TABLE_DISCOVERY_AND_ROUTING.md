# Table Discovery and Routing Design

**Date**: 2026-02-23
**Problem**: How to identify the right table(s) to search when there are 100+ tables per index
**Requirements**: Tenant isolation, index-level isolation, semantic table discovery

## Problem Statement

### Scenario

**Context**: Enterprise customer with 100+ tables ingested across multiple indexes

```
Tenant: "acme-corp"
├─ Index: "customer-data"
│  ├─ customers (10k rows)
│  ├─ customer_interactions (50k rows)
│  ├─ customer_segments (100 rows)
│  ├─ customer_feedback (25k rows)
│  └─ customer_contracts (5k rows)
│
├─ Index: "sales-data"
│  ├─ orders (100k rows)
│  ├─ order_items (500k rows)
│  ├─ products (1k rows)
│  ├─ sales_reps (200 rows)
│  └─ sales_targets (500 rows)
│
└─ Index: "financial-data"
   ├─ invoices (75k rows)
   ├─ payments (80k rows)
   ├─ transactions (200k rows)
   └─ revenue_by_region (12 rows)
```

**User Query**: "What's the total revenue for active customers in Q1 2024?"

**Challenges**:

1. **Table Discovery**: Which table(s) contain relevant data?
   - Could be `customers` + `orders` + `revenue_by_region`
   - Could be just `revenue_by_region` with customer segment filter
   - Could be `invoices` or `payments` aggregated

2. **Tenant Isolation**: Must only search tables belonging to `acme-corp`
   - Never leak table names from other tenants
   - Never access data from other tenants

3. **Index-Level Isolation**: Query is scoped to one index (or cross-index if permitted)
   - User specifies index in API call: `/api/indexes/:indexId/query`
   - Only tables in that index are searchable

4. **Semantic Matching**: Table names might not match query terms
   - User says "revenue", table is named `financial_summary`
   - User says "customers", table is named `accounts`

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    USER QUERY                                    │
│  "What's the total revenue for active customers in Q1 2024?"   │
│                                                                  │
│  Request: POST /api/indexes/:indexId/query                      │
│  Headers: { tenantId: "acme-corp" }                             │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ↓
         ┌─────────────────────────────┐
         │   TENANT & INDEX FILTER     │
         │  - Verify tenant access     │
         │  - Load index metadata      │
         │  - Get table list for index │
         └─────────────┬───────────────┘
                       │
                       ↓
         ┌─────────────────────────────┐
         │   TABLE DISCOVERY ENGINE    │
         │  - Parse query entities     │
         │  - Semantic search on       │
         │    table metadata           │
         │  - Rank candidate tables    │
         └─────────────┬───────────────┘
                       │
                       ↓
         ┌─────────────────────────────┐
         │   TABLE SELECTOR (LLM)      │
         │  - Evaluate each candidate  │
         │  - Check schema relevance   │
         │  - Select 1-3 tables        │
         └─────────────┬───────────────┘
                       │
                       ↓
         ┌─────────────────────────────┐
         │   TEXT-TO-SQL GENERATOR     │
         │  - Generate SQL for         │
         │    selected tables          │
         │  - Include JOINs if needed  │
         └─────────────┬───────────────┘
                       │
                       ↓
         ┌─────────────────────────────┐
         │   SQL EXECUTION             │
         │  (ClickHouse with tenant    │
         │   and index filters)        │
         └─────────────────────────────┘
```

---

## Component 1: Table Metadata Index

### Schema

**ClickHouse Table**: `table_metadata`

```sql
CREATE TABLE table_metadata (
  -- Identity
  table_id UUID DEFAULT generateUUIDv4(),
  table_name String,
  display_name String,  -- User-friendly name

  -- Isolation
  tenant_id String,
  index_id String,

  -- Schema
  columns Array(String),
  column_types Array(String),
  primary_key String,
  row_count UInt64,

  -- Descriptions (for semantic search)
  table_description String,  -- Auto-generated or user-provided
  column_descriptions Map(String, String),

  -- Statistics (for query planning)
  statistics String,  -- JSON: { col1: { min, max, avg }, col2: { values: [...] } }

  -- Sample data (for LLM context)
  sample_rows String,  -- JSON array of 5-10 representative rows

  -- Relationships
  foreign_keys Array(String),  -- JSON: [{ sourceColumn, targetTable, targetColumn }]

  -- Searchability
  searchable_text String,  -- Concatenated: table_name + description + column_names

  -- Timestamps
  created_at DateTime DEFAULT now(),
  updated_at DateTime DEFAULT now()
)
ENGINE = MergeTree()
ORDER BY (tenant_id, index_id, table_name);
```

**MongoDB Collection**: `table_metadata_embeddings`

```typescript
interface ITableMetadataEmbedding {
  _id: ObjectId;

  // Identity
  tableId: string;
  tableName: string;

  // Isolation
  tenantId: string;
  indexId: string;

  // Embedding
  embedding: number[]; // 1536-dim vector from table description + schema

  // Metadata for filtering
  metadata: {
    rowCount: number;
    columnCount: number;
    hasTextColumns: boolean;
    hasNumericColumns: boolean;
    primaryKey: string;
    tableType: 'fact' | 'dimension' | 'lookup' | 'transactional';
  };

  // Full context (for LLM)
  fullContext: {
    tableDescription: string;
    columns: Array<{
      name: string;
      type: string;
      description: string;
    }>;
    sampleRows: any[];
    statistics: Record<string, any>;
  };
}
```

### Indexing Strategy

**When to Index**:

- Immediately after table ingestion (Phase 2 of two-phase API)
- When table schema changes
- When user updates table/column descriptions

---

## What Content Gets Searched?

**IMPORTANT**: Table discovery searches **table metadata**, NOT the actual row data.

### Content Included in Search

| Component               | Example                                                     | Used For                  |
| ----------------------- | ----------------------------------------------------------- | ------------------------- |
| **Table Name**          | `customers`, `orders`, `revenue_by_region`                  | Keyword + semantic search |
| **Table Description**   | "Customer records with company info and contacts"           | Semantic search           |
| **Column Names**        | `customer_id`, `revenue`, `status`, `created_at`            | Keyword + semantic search |
| **Column Types**        | `string`, `number`, `date`, `boolean`                       | Query type classification |
| **Column Descriptions** | "Annual revenue in USD", "Account status"                   | Semantic search           |
| **Sample Rows**         | 5-10 representative rows (JSON)                             | LLM context + examples    |
| **Statistics**          | Row count, min/max/avg, value distributions                 | Query planning + ranking  |
| **Foreign Keys**        | `{ sourceColumn: "customer_id", targetTable: "customers" }` | Join detection            |

### Example: Embedding for `customers` Table

**Table**: `customers` (100,000 rows)

**What gets embedded** (~500-1000 characters):

```
Table: customers
Description: Customer records with company information and contact details

Columns:
- id (number): Unique customer identifier
- name (string): Company name
- revenue (number): Annual revenue in USD
- status (string): Account status (active/inactive/trial)
- description (string): Detailed company profile and business overview
- created_at (date): Customer onboarding date

Sample data:
[
  { id: 1, name: "Acme Corp", revenue: 1000000, status: "active", description: "Leading AI company in enterprise software...", created_at: "2023-01-15" },
  { id: 2, name: "Beta Inc", revenue: 500000, status: "trial", description: "SaaS startup in fintech sector...", created_at: "2024-03-20" },
  { id: 3, name: "Gamma LLC", revenue: 2500000, status: "active", description: "Manufacturing company specializing in...", created_at: "2022-06-10" },
  { id: 4, name: "Delta Corp", revenue: 150000, status: "inactive", description: "Consulting firm focused on...", created_at: "2021-11-03" },
  { id: 5, name: "Epsilon Inc", revenue: 750000, status: "active", description: "E-commerce platform for...", created_at: "2023-08-22" }
]

Statistics:
- Row count: 100000
- Revenue: min=0, max=5000000, avg=250000
- Status distribution: active(80%), inactive(15%), trial(5%)
- Primary key: id
- Foreign keys: 0
```

**What does NOT get embedded**: The other 99,995 rows of actual customer data.

### Why This Works

**User Query**: "Find AI companies with revenue over $1M"

**Search Process**:

1. **Semantic Search** on embedded metadata:
   - Query embedding: `"Find AI companies with revenue over $1M"`
   - Matches `customers` table because:
     - ✅ Sample row has "AI company" in description field
     - ✅ Has `revenue` column (numeric type)
     - ✅ Table description mentions "company information"

2. **Keyword Search** on table/column names:
   - Keyword "revenue" → matches column name `revenue`
   - Keyword "companies" → matches table description "company information"

3. **LLM Selection**:
   - Sees sample rows contain company descriptions
   - Sees `revenue` column with numeric data
   - Selects `customers` table as most relevant

4. **SQL Generation**:
   - Generated SQL queries the FULL 100k rows:
     ```sql
     SELECT * FROM customers
     WHERE tenant_id = 'acme-corp'
       AND index_id = 'idx123'
       AND revenue > 1000000
       AND description ILIKE '%AI%'
     ```

**Key Insight**: We search metadata to find the right TABLE, then query ClickHouse to get the actual DATA.

---

**What to Embed**:

```typescript
async function generateTableEmbedding(table: TableSchema): Promise<string> {
  // Build rich context for embedding
  const embeddingText = `
Table: ${table.tableName}
Description: ${table.description || `Table containing ${table.tableName} data`}

Columns:
${table.columns.map((col) => `- ${col.name} (${col.type}): ${col.description || 'No description'}`).join('\n')}

Sample data:
${JSON.stringify(table.sampleRows.slice(0, 5), null, 2)}

Statistics:
- Row count: ${table.rowCount}
- Primary key: ${table.primaryKey}
- Relationships: ${table.foreignKeys.length} foreign keys
`.trim();

  return embeddingText;
}

// Generate embedding
const embeddingText = await generateTableEmbedding(tableSchema);
const embedding = await embeddingService.embed(embeddingText);

// Store in MongoDB
await tableMetadataEmbeddings.insertOne({
  tableId: tableSchema.tableId,
  tableName: tableSchema.tableName,
  tenantId: tableSchema.tenantId,
  indexId: tableSchema.indexId,
  embedding,
  metadata: {
    rowCount: tableSchema.rowCount,
    columnCount: tableSchema.columns.length,
    hasTextColumns: tableSchema.columns.some((c) => c.type === 'string' && c.avgLength > 100),
    hasNumericColumns: tableSchema.columns.some((c) =>
      ['number', 'decimal', 'integer'].includes(c.type),
    ),
    primaryKey: tableSchema.primaryKey,
    tableType: classifyTableType(tableSchema),
  },
  fullContext: {
    tableDescription: tableSchema.description,
    columns: tableSchema.columns,
    sampleRows: tableSchema.sampleRows,
    statistics: tableSchema.statistics,
  },
});
```

---

## Component 2: Table Discovery Engine

### Algorithm

```typescript
async function discoverTables(
  query: string,
  tenantId: string,
  indexId: string,
): Promise<TableCandidate[]> {
  // Step 1: Tenant & Index Isolation - CRITICAL
  const isolationFilter = {
    tenantId,
    indexId,
  };

  // Step 2: Semantic Search on Table Metadata
  const queryEmbedding = await embeddingService.embed(query);

  const semanticCandidates = await vectorSearch({
    collection: 'table_metadata_embeddings',
    vector: queryEmbedding,
    filter: isolationFilter, // NEVER search across tenants/indexes
    topK: 10,
    minScore: 0.5,
  });

  // Step 3: Keyword Matching (fallback)
  // Extracts keywords from query: "revenue", "customers", "Q1", "2024", "active"
  const keywords = extractKeywords(query);

  // Searches ONLY the table_metadata table in ClickHouse (NOT the actual data tables)
  // This query looks at:
  //   - table_name column (e.g., "customers", "orders")
  //   - table_description column (e.g., "Customer records with company info")
  //   - columns array (e.g., ["id", "name", "revenue", "status"])
  const keywordCandidates = await clickhouse.query({
    query: `
      SELECT
        table_id,
        table_name,
        table_description,
        columns,
        row_count,
        statistics
      FROM table_metadata  -- Metadata table, NOT the actual data tables
      WHERE tenant_id = {tenantId:String}
        AND index_id = {indexId:String}
        AND (
          table_name ILIKE {keyword:String}           -- e.g., "customers" matches "customer%"
          OR table_description ILIKE {keyword:String}  -- e.g., "revenue" in description
          OR has(columns, {keyword:String})            -- e.g., "revenue" in column names array
        )
      LIMIT 20
    `,
    query_params: {
      tenantId,
      indexId,
      keyword: `%${keywords.join('%')}%`,
    },
  });

  // Step 4: Merge and Rank Candidates
  const allCandidates = mergeCandidates(semanticCandidates, keywordCandidates);

  // Step 5: Rank by relevance
  const rankedCandidates = rankCandidates(allCandidates, query);

  return rankedCandidates.slice(0, 5); // Top 5 candidates
}
```

### Ranking Algorithm

```typescript
function rankCandidates(candidates: TableCandidate[], query: string): TableCandidate[] {
  const keywords = extractKeywords(query);

  return candidates
    .map((candidate) => {
      let score = candidate.semanticScore || 0;

      // Boost: Table name exact match
      if (keywords.some((k) => candidate.tableName.toLowerCase().includes(k.toLowerCase()))) {
        score += 0.3;
      }

      // Boost: Column name match
      const matchingColumns = candidate.columns.filter((col) =>
        keywords.some((k) => col.toLowerCase().includes(k.toLowerCase())),
      );
      score += matchingColumns.length * 0.1;

      // Boost: Description match
      if (keywords.some((k) => candidate.description?.toLowerCase().includes(k.toLowerCase()))) {
        score += 0.2;
      }

      // Boost: Has relevant column types
      if (query.match(/total|sum|average|count|revenue|sales/i)) {
        // Likely needs numeric columns
        if (candidate.metadata.hasNumericColumns) {
          score += 0.15;
        }
      }

      if (query.match(/find|search|like|similar|about/i)) {
        // Likely needs text columns
        if (candidate.metadata.hasTextColumns) {
          score += 0.15;
        }
      }

      // Penalty: Very large tables (might be wrong granularity)
      if (candidate.metadata.rowCount > 1000000) {
        score -= 0.1;
      }

      return { ...candidate, finalScore: score };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}
```

---

## Component 3: Table Selector (LLM-Based)

### Purpose

After discovery returns 5 candidates, use LLM to select the 1-3 most relevant tables and explain why.

### Implementation

```typescript
async function selectTables(query: string, candidates: TableCandidate[]): Promise<TableSelection> {
  const prompt = `
You are a database expert. Given a user query and candidate tables, select the 1-3 most relevant tables.

User Query: "${query}"

Candidate Tables:
${candidates
  .map(
    (c, i) => `
${i + 1}. Table: ${c.tableName}
   Description: ${c.description || 'No description'}
   Columns: ${c.columns.join(', ')}
   Row Count: ${c.rowCount}
   Sample Row: ${JSON.stringify(c.sampleRows[0], null, 2)}
`,
  )
  .join('\n')}

Task:
1. Analyze which table(s) contain the data needed to answer the query
2. Consider if multiple tables need to be joined
3. Select 1-3 tables (prefer fewer if possible)

Respond with JSON:
{
  "selectedTables": [
    {
      "tableName": "table1",
      "reasoning": "This table contains revenue and customer data",
      "requiredColumns": ["customer_id", "revenue", "status", "date"],
      "estimatedRelevance": 0.95
    }
  ],
  "needsJoin": false,
  "joinStrategy": null  // or { type: "INNER JOIN", on: "table1.id = table2.customer_id" }
}
`;

  const response = await llm.complete({
    prompt,
    model: 'gpt-4',
    responseFormat: { type: 'json_object' },
  });

  return JSON.parse(response.text);
}
```

---

## Component 4: Tenant & Index Isolation Enforcement

### API Layer

```typescript
// API Route: Query structured data
router.post('/api/indexes/:indexId/query', async (req, res) => {
  // Step 1: Authentication & Tenant Resolution
  const tenantId = req.tenantContext.tenantId; // From auth middleware
  const indexId = req.params.indexId;

  // Step 2: Authorization - Verify tenant owns this index
  const index = await indexStore.findOne({
    _id: indexId,
    tenantId, // CRITICAL: Must match tenant
  });

  if (!index) {
    return res.status(404).json({
      error: {
        code: 'INDEX_NOT_FOUND',
        message: 'Index not found', // Don't leak existence to wrong tenant
      },
    });
  }

  // Step 3: Verify index access permissions
  if (!req.tenantContext.hasPermission('index:query')) {
    return res.status(403).json({
      error: {
        code: 'INSUFFICIENT_PERMISSIONS',
        message: 'You do not have permission to query this index',
      },
    });
  }

  // Step 4: Execute query with isolation filters
  const result = await queryService.execute({
    query: req.body.query,
    tenantId, // ALWAYS pass tenant
    indexId, // ALWAYS pass index
    options: req.body.options,
  });

  return res.json(result);
});
```

### Query Service Layer

```typescript
class StructuredQueryService {
  async execute(params: {
    query: string;
    tenantId: string;
    indexId: string;
    options?: QueryOptions;
  }): Promise<QueryResult> {
    const { query, tenantId, indexId, options } = params;

    // Step 1: Discover tables (with isolation)
    const candidates = await this.discoverTables(query, tenantId, indexId);

    if (candidates.length === 0) {
      return {
        success: false,
        error: {
          code: 'NO_TABLES_FOUND',
          message: 'No relevant tables found for this query',
        },
      };
    }

    // Step 2: Select best table(s)
    const selection = await this.selectTables(query, candidates);

    // Step 3: Generate SQL
    const { sql, explanation } = await this.generateSQL(query, selection.selectedTables);

    // Step 4: Add tenant & index isolation to SQL
    const isolatedSQL = this.addIsolationFilters(sql, tenantId, indexId);

    // Step 5: Execute with isolation
    const results = await this.executeSQL(isolatedSQL, tenantId, indexId);

    return {
      success: true,
      results,
      metadata: {
        tablesUsed: selection.selectedTables.map((t) => t.tableName),
        sql: isolatedSQL,
        explanation,
      },
    };
  }

  private addIsolationFilters(sql: string, tenantId: string, indexId: string): string {
    // Parse SQL and inject tenant/index filters
    // This is a safety layer - table names should already be scoped

    // Example transformation:
    // Before: SELECT * FROM customers WHERE status = 'active'
    // After:  SELECT * FROM customers WHERE tenant_id = 'acme-corp' AND index_id = 'idx123' AND status = 'active'

    return injectWhereClause(sql, {
      tenant_id: tenantId,
      index_id: indexId,
    });
  }

  private async executeSQL(sql: string, tenantId: string, indexId: string): Promise<any[]> {
    // Final safety check: Validate SQL doesn't reference other tenants/indexes
    this.validateSQLIsolation(sql, tenantId, indexId);

    // Execute query
    const result = await this.clickhouse.query({
      query: sql,
      query_params: { tenantId, indexId },
    });

    return result.data;
  }

  private validateSQLIsolation(sql: string, tenantId: string, indexId: string): void {
    // Check that SQL includes tenant_id and index_id filters
    if (!sql.includes('tenant_id') || !sql.includes('index_id')) {
      throw new Error('SECURITY_VIOLATION: SQL missing tenant/index isolation filters');
    }

    // Check for suspicious patterns (UNION, subqueries without isolation)
    if (sql.match(/UNION|JOIN.*WHERE(?!.*tenant_id)/i)) {
      throw new Error('SECURITY_VIOLATION: Potentially unsafe SQL detected');
    }
  }
}
```

---

## Component 5: Cross-Index Queries (Optional)

### Use Case

**Scenario**: User wants to query across multiple indexes

```
Query: "Show me customers with recent orders"

Indexes:
├─ customer-data (has customers table)
└─ sales-data (has orders table)
```

### Design Decision

**Recommendation**: **Disallow cross-index queries by default**

**Reasons**:

1. ✅ **Security**: Simplifies isolation logic
2. ✅ **Performance**: Avoids complex distributed joins
3. ✅ **UX**: Forces users to think about data organization

**Alternative**: If cross-index is needed, require explicit permission:

```typescript
router.post('/api/tenants/:tenantId/query', async (req, res) => {
  const tenantId = req.params.tenantId;

  // Verify user has cross-index query permission
  if (!req.tenantContext.hasPermission('tenant:query_cross_index')) {
    return res.status(403).json({ error: 'Cross-index queries not permitted' });
  }

  // Get all indexes for this tenant
  const indexes = await indexStore.find({ tenantId });

  // Discover tables across all indexes
  const allCandidates = await Promise.all(
    indexes.map((idx) => discoverTables(req.body.query, tenantId, idx._id)),
  );

  // ... rest of query logic
});
```

---

## Security Checklist

Every query execution must satisfy ALL of these:

- [x] **Tenant isolation at API layer**: Route verifies `indexId` belongs to `tenantId`
- [x] **Tenant isolation at discovery**: Vector search filtered by `{ tenantId, indexId }`
- [x] **Tenant isolation at SQL generation**: Generated SQL includes `WHERE tenant_id = ? AND index_id = ?`
- [x] **Tenant isolation at execution**: ClickHouse query uses parameterized tenant/index filters
- [x] **Authorization check**: User has `index:query` permission
- [x] **SQL injection prevention**: All user inputs sanitized, parameterized queries only
- [x] **No table name leakage**: 404 (not 403) for indexes that don't exist or belong to other tenants
- [x] **Audit logging**: Every query logged with tenantId, indexId, userId, timestamp

---

## Performance Optimizations

### 1. Table Metadata Caching

```typescript
class TableMetadataCache {
  private cache: Map<string, TableMetadata[]> = new Map();
  private ttl = 5 * 60 * 1000; // 5 minutes

  async getTablesForIndex(tenantId: string, indexId: string): Promise<TableMetadata[]> {
    const cacheKey = `${tenantId}:${indexId}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Cache miss - fetch from ClickHouse
    const tables = await this.fetchTablesFromDB(tenantId, indexId);
    this.cache.set(cacheKey, tables);

    // Auto-expire
    setTimeout(() => this.cache.delete(cacheKey), this.ttl);

    return tables;
  }
}
```

### 2. Pre-computed Table Relevance

**Approach**: Pre-compute common query patterns

```typescript
// At ingestion time, compute "likely query types" for each table
const tableProfile = {
  tableName: 'customers',
  likelyQueries: ['customer search', 'customer list', 'customer details', 'customer analytics'],
  queryTypes: {
    semantic: 0.8, // Good for semantic search (has text fields)
    aggregation: 0.6, // Good for aggregations (has numeric fields)
    filtering: 0.9, // Good for filtering (has categorical fields)
  },
};

// Use this to boost ranking
if (queryType === 'aggregation' && table.queryTypes.aggregation > 0.7) {
  score += 0.2;
}
```

### 3. Index-Level Table Count Limits

**Recommendation**: Limit tables per index to 200 for optimal discovery performance

```typescript
// During ingestion
if ((await getTableCount(tenantId, indexId)) >= 200) {
  return {
    success: false,
    error: {
      code: 'TABLE_LIMIT_EXCEEDED',
      message:
        'Index has reached maximum table count (200). Please create a new index or remove unused tables.',
    },
  };
}
```

---

## Testing Strategy

### Test Case 1: Single Tenant, Single Index, Multiple Tables

```typescript
describe('Table Discovery - Single Index', () => {
  it('should discover correct table for revenue query', async () => {
    // Setup
    const tenantId = 'acme-corp';
    const indexId = 'sales-data';

    await ingestTable({
      tenantId,
      indexId,
      tableName: 'orders',
      schema: { columns: ['order_id', 'customer_id', 'amount', 'date'] },
      data: [...],
    });

    await ingestTable({
      tenantId,
      indexId,
      tableName: 'products',
      schema: { columns: ['product_id', 'name', 'price'] },
      data: [...],
    });

    // Execute
    const result = await queryService.execute({
      query: 'What is the total revenue in Q1 2024?',
      tenantId,
      indexId,
    });

    // Assert
    expect(result.success).toBe(true);
    expect(result.metadata.tablesUsed).toEqual(['orders']);
    expect(result.metadata.sql).toContain('SUM(amount)');
    expect(result.metadata.sql).toContain('tenant_id = ');
    expect(result.metadata.sql).toContain('index_id = ');
  });
});
```

### Test Case 2: Tenant Isolation

```typescript
describe('Table Discovery - Tenant Isolation', () => {
  it('should NOT discover tables from other tenants', async () => {
    // Setup: Two tenants with same table names
    await ingestTable({
      tenantId: 'acme-corp',
      indexId: 'idx1',
      tableName: 'customers',
      data: [{ id: 1, name: 'Acme Customer' }],
    });

    await ingestTable({
      tenantId: 'beta-inc',
      indexId: 'idx2',
      tableName: 'customers',
      data: [{ id: 2, name: 'Beta Customer' }],
    });

    // Execute: Acme queries
    const result = await queryService.execute({
      query: 'List all customers',
      tenantId: 'acme-corp',
      indexId: 'idx1',
    });

    // Assert: Only Acme's data returned
    expect(result.results).toHaveLength(1);
    expect(result.results[0].name).toBe('Acme Customer');
    expect(result.results[0].name).not.toBe('Beta Customer');
  });
});
```

### Test Case 3: Index Isolation

```typescript
describe('Table Discovery - Index Isolation', () => {
  it('should NOT discover tables from other indexes in same tenant', async () => {
    const tenantId = 'acme-corp';

    // Setup: Same tenant, different indexes
    await ingestTable({
      tenantId,
      indexId: 'customer-data',
      tableName: 'customers',
      data: [...],
    });

    await ingestTable({
      tenantId,
      indexId: 'sales-data',
      tableName: 'orders',
      data: [...],
    });

    // Execute: Query customer-data index
    const result = await queryService.execute({
      query: 'Show me all orders',  // "orders" is in sales-data, not customer-data
      tenantId,
      indexId: 'customer-data',  // Querying customer-data index
    });

    // Assert: No tables found
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('NO_TABLES_FOUND');
  });
});
```

---

## Summary

### Problems Solved

1. ✅ **Table discovery at scale**: Semantic + keyword search on table metadata
2. ✅ **Tenant isolation**: Multi-layer enforcement (API, discovery, SQL, execution)
3. ✅ **Index-level isolation**: Queries scoped to single index by default
4. ✅ **Semantic matching**: Handles mismatches between query terms and table names
5. ✅ **LLM-assisted selection**: Intelligent table selection with reasoning

### Key Design Principles

| Principle                  | Implementation                                                      |
| -------------------------- | ------------------------------------------------------------------- |
| **Isolation First**        | TenantId + IndexId filter at every layer (API, cache, DB)           |
| **Fail Secure**            | 404 on missing resources (don't leak existence)                     |
| **Explicit Over Implicit** | No cross-index queries unless explicitly permitted                  |
| **Defense in Depth**       | Multiple isolation checks (API + discovery + SQL generation + exec) |
| **Auditability**           | Every query logged with full context                                |

### Next Steps

1. Implement table metadata indexing during ingestion
2. Build discovery engine with semantic + keyword search
3. Implement LLM-based table selector
4. Add tenant/index isolation enforcement
5. Write comprehensive security tests
6. Benchmark performance with 100+ tables
