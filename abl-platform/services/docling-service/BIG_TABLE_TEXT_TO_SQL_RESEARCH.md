# Big Table Problem & Text-to-SQL Research

**Date**: 2026-02-23
**Problem**: Storing each row as a chunk doesn't scale and doesn't support SQL-like queries

## Problem Statement

### Current Approach Issues

**Scenario**: 100,000 row customer table

**Current design**:

- Create 100,000 record chunks (one per row)
- Generate 100,000 embeddings
- Store 100,000 vectors

**Problems**:

1. **Cost Explosion**:
   - Embedding tokens: 100k rows × 100 tokens/row = 10M tokens
   - Cost: $1.00 for embeddings alone
   - Storage: 100k chunks × 15 KB = 1.5 GB

2. **Wrong Query Pattern**:
   - User query: "What's the average revenue of active customers?"
   - Expected: SQL aggregation → single result
   - Current: Vector search → returns 20 similar rows → user has to aggregate client-side

3. **Semantic Search Mismatch**:
   - Vector search returns "similar" rows
   - Not suitable for: filtering, aggregations, counts, sums, averages, grouping

4. **Retrieval Quality**:
   - User: "Show me customers with revenue > $1M"
   - Vector search: Irrelevant - need exact filter
   - Better: SQL `WHERE revenue > 1000000`

### The Core Insight

**Structured data (tables) requires SQL-like querying, not vector similarity search.**

For tables, users want:

- **Aggregations**: "What's the total revenue?"
- **Filtering**: "Show active customers"
- **Grouping**: "Revenue by region"
- **Joins**: "Orders for each customer"
- **Sorting**: "Top 10 by revenue"

Vector search is only useful for **unstructured text fields** within tables (descriptions, notes, reviews).

---

## Solution: Hybrid Approach

### Strategy 1: Table-Level Semantic Search + SQL Execution

**Do NOT chunk every row. Instead**:

1. **Table Metadata Chunk** (semantic understanding)
   - Table description (auto-generated from table name + columns)
   - Sample rows (10-20 representative rows)
   - Column schemas with descriptions
   - Statistics (min, max, avg, count per column)

2. **Representative Row Chunks** (for semantic fields only)
   - Only chunk rows with long text fields (descriptions, notes, comments)
   - Skip rows with only numeric/categorical data

3. **Full Data Store** (for SQL queries)
   - Store full table in ClickHouse (already part of platform infrastructure)
   - Execute SQL queries at runtime

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     USER QUERY                               │
│  "Show me customers in the technology sector with revenue   │
│   over $1M, ordered by revenue descending"                  │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ↓
         ┌─────────────────────────────┐
         │   QUERY ANALYZER (LLM)      │
         │  - Detect query type        │
         │  - Extract filters          │
         │  - Detect aggregations      │
         └─────────────┬───────────────┘
                       │
                       ↓
           ┌───────────────────────────┐
           │  Query Type Decision       │
           └─────┬─────────────┬────────┘
                 │             │
        Semantic │             │ Structured
        (fuzzy)  │             │ (exact)
                 │             │
    ┌────────────▼───────┐    │
    │  VECTOR SEARCH     │    │
    │  (descriptions,    │    │
    │   notes fields)    │    │
    └────────────────────┘    │
                              │
                   ┌──────────▼────────────┐
                   │  TEXT-TO-SQL          │
                   │  - Generate SQL       │
                   │  - Validate query     │
                   └──────────┬────────────┘
                              │
                   ┌──────────▼────────────┐
                   │  SQL EXECUTION        │
                   │  (ClickHouse)         │
                   └──────────┬────────────┘
                              │
                   ┌──────────▼────────────┐
                   │  RESULT FORMATTING    │
                   │  - Tabular results    │
                   │  - Aggregations       │
                   │  - Charts/viz data    │
                   └───────────────────────┘
```

---

## Text-to-SQL Research

### Industry Solutions

#### 1. Vanna AI (Open Source)

**Approach**: Retrieval-Augmented Generation (RAG) for SQL

```python
from vanna import Vanna

vn = Vanna()

# Step 1: Train on schema
vn.train(ddl="CREATE TABLE customers (id INT, name TEXT, revenue DECIMAL, status TEXT)")
vn.train(ddl="CREATE TABLE orders (order_id INT, customer_id INT, amount DECIMAL)")

# Step 2: Train on example queries (few-shot learning)
vn.train(question="Show me total revenue", sql="SELECT SUM(revenue) FROM customers")
vn.train(question="Top 10 customers", sql="SELECT * FROM customers ORDER BY revenue DESC LIMIT 10")

# Step 3: Generate SQL from natural language
sql = vn.generate_sql("What's the average revenue of active customers?")
# Output: SELECT AVG(revenue) FROM customers WHERE status = 'active'

# Step 4: Execute
results = vn.run_sql(sql)
```

**Pros**:

- ✅ Open source
- ✅ Works with any SQL database
- ✅ RAG approach (retrieves relevant DDL + examples before generation)
- ✅ Self-correcting (if query fails, generates again)

**Cons**:

- ❌ Requires training data (DDL + example queries)
- ❌ LLM call per query (latency + cost)
- ❌ Can generate incorrect SQL (needs validation)

#### 2. LangChain SQL Agent

**Approach**: LLM agent with SQL toolkit

```python
from langchain.agents import create_sql_agent
from langchain.sql_database import SQLDatabase

db = SQLDatabase.from_uri("sqlite:///customers.db")

agent = create_sql_agent(
    llm=ChatOpenAI(model="gpt-4"),
    db=db,
    verbose=True
)

result = agent.run("What is the total revenue of customers in California?")
```

**Workflow**:

1. Agent inspects schema: `PRAGMA table_info(customers)`
2. Generates SQL: `SELECT SUM(revenue) FROM customers WHERE state = 'California'`
3. Executes query
4. Returns natural language result: "The total revenue is $12.5M"

**Pros**:

- ✅ Schema introspection (no manual training)
- ✅ Multi-step reasoning (can do complex queries)
- ✅ Error recovery (retries on SQL errors)

**Cons**:

- ❌ Multiple LLM calls (expensive)
- ❌ Latency (3-10 seconds per query)
- ❌ Non-deterministic (same query might generate different SQL)

#### 3. Defog SQLCoder (Fine-Tuned Model)

**Approach**: Fine-tuned open-source model specifically for text-to-SQL

```python
from transformers import AutoTokenizer, AutoModelForCausalLM

tokenizer = AutoTokenizer.from_pretrained("defog/sqlcoder-7b")
model = AutoModelForCausalLM.from_pretrained("defog/sqlcoder-7b")

prompt = f"""
### Task
Generate a SQL query to answer the question.

### Database Schema
CREATE TABLE customers (
  id INT PRIMARY KEY,
  name TEXT,
  revenue DECIMAL,
  status TEXT,
  region TEXT
);

### Question
What is the average revenue of active customers in the US West region?

### SQL
"""

inputs = tokenizer(prompt, return_tensors="pt")
outputs = model.generate(**inputs)
sql = tokenizer.decode(outputs[0])
# Output: SELECT AVG(revenue) FROM customers WHERE status = 'active' AND region = 'US West'
```

**Pros**:

- ✅ Fast inference (< 1 second)
- ✅ No API costs (self-hosted)
- ✅ Deterministic (same query → same SQL)
- ✅ High accuracy (90%+ on Spider benchmark)

**Cons**:

- ❌ Requires GPU for inference
- ❌ 7B parameter model (large memory footprint)
- ❌ Needs schema in prompt (can't introspect)

#### 4. OpenAI GPT-4 with Function Calling

**Approach**: Use GPT-4's function calling for structured SQL generation

```typescript
const response = await openai.chat.completions.create({
  model: 'gpt-4',
  messages: [
    {
      role: 'system',
      content: `You are a SQL expert. Generate SQL queries for the given database schema.

      Database Schema:
      - customers: id (INT), name (TEXT), revenue (DECIMAL), status (TEXT)
      - orders: order_id (INT), customer_id (INT), amount (DECIMAL)`,
    },
    {
      role: 'user',
      content: "What's the average revenue of active customers?",
    },
  ],
  functions: [
    {
      name: 'execute_sql',
      description: 'Execute a SQL query on the database',
      parameters: {
        type: 'object',
        properties: {
          sql: {
            type: 'string',
            description: 'The SQL query to execute',
          },
          explanation: {
            type: 'string',
            description: 'Explanation of what the query does',
          },
        },
        required: ['sql'],
      },
    },
  ],
  function_call: { name: 'execute_sql' },
});

const functionCall = response.choices[0].message.function_call;
const args = JSON.parse(functionCall.arguments);
// args.sql = "SELECT AVG(revenue) FROM customers WHERE status = 'active'"
```

**Pros**:

- ✅ Structured output (validated SQL)
- ✅ Explanation included
- ✅ High accuracy (GPT-4 quality)

**Cons**:

- ❌ API costs ($0.03 per 1k input tokens, $0.06 per 1k output)
- ❌ Latency (2-5 seconds)

---

## Recommended Approach for Our Platform

### Hybrid Storage Architecture

**For Each Table**:

1. **Full Data Store** (ClickHouse)
   - Store complete table data
   - Enable SQL queries
   - Fast aggregations, filters, joins
   - No embedding cost
   - Already part of platform infrastructure (no new dependencies)

2. **Semantic Index** (Vector Store)
   - Table metadata chunk:

     ```typescript
     {
       chunkType: "table_schema",
       tableName: "customers",
       content: "Table: customers\nDescription: Customer records with company information\nColumns: id (unique identifier), name (company name), revenue (annual revenue in USD), status (account status: active/inactive), description (detailed company profile), notes (customer relationship notes)\nSample data: 10 representative rows...",
       schemaMetadata: {
         columns: [...],
         primaryKey: "id",
         rowCount: 100000,
         statistics: {
           revenue: { min: 0, max: 5000000, avg: 250000 },
           status: { values: ["active", "inactive"], distribution: {"active": 0.8, "inactive": 0.2} }
         }
       }
     }
     ```

   - Representative text chunks (only for long text fields):
     ```typescript
     // Only create these for rows with substantial text content
     {
       chunkType: "record",
       recordId: 12345,
       tableName: "customers",
       content: "Table: customers\nName: Acme Corp\nDescription: Leading technology company specializing in AI-powered enterprise solutions...\nNotes: Long-term partner since 2020. Strong relationship with CTO...",
       filterableMetadata: { id: 12345, status: "active", revenue: 1000000 },
       embeddableMetadata: {
         name: "Acme Corp",
         description: "...",
         notes: "..."
       }
     }
     ```

3. **Relationship Graph**
   - Foreign key relationships (as before)
   - For cross-table joins

### Query Routing Logic

```typescript
async function routeQuery(query: string, tableSchemas: TableSchema[]): Promise<QueryPlan> {
  // Step 1: Classify query using LLM
  const classification = await classifyQuery(query, tableSchemas);

  // Step 2: Route based on classification
  if (classification.type === 'semantic') {
    // Example: "Find customers in the AI/ML industry"
    return {
      strategy: 'vector_search',
      targetFields: ['description', 'notes'],
      filters: classification.filters,
    };
  } else if (classification.type === 'structured') {
    // Example: "Show me total revenue by region"
    return {
      strategy: 'text_to_sql',
      sqlGeneration: true,
      targetTables: classification.tables,
    };
  } else if (classification.type === 'hybrid') {
    // Example: "Find AI companies with revenue > $1M"
    return {
      strategy: 'hybrid',
      vectorSearch: {
        query: 'AI companies',
        targetFields: ['description'],
      },
      sqlFilter: 'revenue > 1000000',
      combination: 'vector_results_filtered_by_sql',
    };
  }
}

async function classifyQuery(query: string, schemas: TableSchema[]): Promise<QueryClassification> {
  const prompt = `
Classify this database query into one of three types:
1. semantic: Requires understanding text meaning (e.g., "find tech companies", "customers interested in AI")
2. structured: Requires SQL operations (e.g., "total revenue", "top 10 by sales", "count active users")
3. hybrid: Requires both semantic search and SQL filtering

Query: "${query}"

Available tables:
${schemas.map((s) => `- ${s.tableName}: ${s.columns.map((c) => c.name).join(', ')}`).join('\n')}

Respond with JSON:
{
  "type": "semantic" | "structured" | "hybrid",
  "reasoning": "...",
  "targetTables": ["table1", "table2"],
  "semanticFields": ["description", "notes"],  // For semantic queries
  "filters": {...},  // For structured queries
  "aggregations": [...]  // For structured queries
}
`;

  const response = await llm.complete(prompt);
  return JSON.parse(response.text);
}
```

### Text-to-SQL Implementation

```typescript
async function generateSQL(
  query: string,
  schema: TableSchema[],
): Promise<{ sql: string; explanation: string }> {
  // Build schema context
  const schemaDDL = schema
    .map(
      (table) => `
CREATE TABLE ${table.tableName} (
  ${table.columns.map((col) => `${col.name} ${col.type.toUpperCase()}`).join(',\n  ')}
);
-- Row count: ${table.rowCount}
-- Description: ${table.description || 'N/A'}
`,
    )
    .join('\n');

  // Few-shot examples (retrieved from RAG)
  const examples = await retrieveRelevantExamples(query);

  const prompt = `
You are an expert SQL query generator. Generate a SQL query to answer the user's question.

Database Schema:
${schemaDDL}

${
  examples.length > 0
    ? `
Example Queries:
${examples.map((ex) => `Q: ${ex.question}\nSQL: ${ex.sql}`).join('\n\n')}
`
    : ''
}

User Question: ${query}

Requirements:
- Use standard SQL syntax (compatible with ClickHouse)
- Include proper JOINs for multi-table queries
- Use appropriate aggregation functions (SUM, AVG, COUNT, etc.)
- Add ORDER BY and LIMIT when relevant
- Validate column names against schema

Generate the SQL query and explain what it does.

Response format:
{
  "sql": "SELECT ...",
  "explanation": "This query ...",
  "targetTables": ["table1", "table2"]
}
`;

  const response = await llm.complete(prompt);
  return JSON.parse(response.text);
}

async function executeSQL(sql: string, clickhouse: ClickHouseClient): Promise<QueryResult> {
  // Step 1: Validate SQL (prevent SQL injection, check table names exist)
  validateSQL(sql);

  // Step 2: Execute query
  const results = await clickhouse.query({ query: sql }).then((res) => res.json());

  // Step 3: Format results
  return {
    rows: results.data,
    columns: Object.keys(results.data[0] || {}),
    rowCount: results.data.length,
    executionTimeMs: results.statistics?.elapsed,
  };
}
```

---

## Storage Cost Comparison

### Scenario: 100,000 row customer table

| Approach                  | Chunks Created | Embedding Tokens | Embedding Cost | Storage                               | Query Time           |
| ------------------------- | -------------- | ---------------- | -------------- | ------------------------------------- | -------------------- |
| **Current (All Rows)**    | 100,000        | 10M              | $1.00          | 1.5 GB                                | Fast (vector)        |
| **Table Metadata Only**   | 1              | 1,000            | $0.0001        | 15 KB                                 | Slow (LLM per query) |
| **Smart Sampling**        | 100            | 100K             | $0.01          | 1.5 MB                                | Fast (hybrid)        |
| **ClickHouse + Metadata** | 1 + 100        | 100K             | $0.01          | 50 MB (ClickHouse) + 1.5 MB (vectors) | Fast (SQL)           |

**Recommended**: ClickHouse + Metadata

- ✅ 100x cost reduction for embeddings
- ✅ 30x storage reduction
- ✅ Fast SQL queries (< 100ms for aggregations)
- ✅ Semantic search still available (for text fields)

---

## Implementation Plan

### Phase 1: ClickHouse Integration

**Setup**:

```typescript
import { createClient } from '@clickhouse/client';

const clickhouse = createClient({
  url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER || 'default',
  password: process.env.CLICKHOUSE_PASSWORD,
  database: process.env.CLICKHOUSE_DATABASE || 'default',
});

// Create table from CSV
await clickhouse.exec({
  query: `
    CREATE TABLE IF NOT EXISTS customers (
      id UInt64,
      name String,
      revenue Decimal64(2),
      status String
    ) ENGINE = MergeTree()
    ORDER BY id
  `,
});

// Insert data from CSV
await clickhouse.insert({
  table: 'customers',
  values: customerData,
  format: 'JSONEachRow',
});

// Query
const result = await clickhouse.query({
  query: 'SELECT AVG(revenue) FROM customers WHERE status = {status:String}',
  query_params: { status: 'active' },
});
```

**Storage Strategy**:

- **All tables** use ClickHouse (already part of platform infrastructure)
- **MergeTree engine** for standard tables (fast inserts + queries)
- **ReplacingMergeTree** for deduplication if needed
- **Distributed tables** for sharding across cluster nodes (already configured)

### Phase 2: Query Router

```typescript
async function handleQuery(userQuery: string, indexId: string): Promise<QueryResponse> {
  // Step 1: Get table schemas for this index
  const schemas = await getTableSchemas(indexId);

  // Step 2: Classify query
  const classification = await classifyQuery(userQuery, schemas);

  // Step 3: Route to appropriate handler
  if (classification.type === 'structured') {
    // Generate SQL
    const { sql, explanation } = await generateSQL(userQuery, schemas);

    // Execute SQL
    const results = await executeSQL(sql, getClickHouse(indexId));

    return {
      type: 'sql',
      sql,
      explanation,
      results,
    };
  } else if (classification.type === 'semantic') {
    // Vector search on text fields
    const vectorResults = await vectorSearch(userQuery, classification.semanticFields);

    return {
      type: 'semantic',
      results: vectorResults,
    };
  } else {
    // Hybrid: Vector search → extract IDs → SQL filter
    const vectorResults = await vectorSearch(userQuery, classification.semanticFields);
    const recordIds = vectorResults.map((r) => r.recordId);

    const sql = `
      SELECT * FROM ${classification.targetTables[0]}
      WHERE id IN (${recordIds.join(',')})
      AND ${classification.filters}
      ORDER BY revenue DESC
    `;

    const results = await executeSQL(sql, getClickHouse(indexId));

    return {
      type: 'hybrid',
      results,
    };
  }
}
```

### Phase 3: Smart Chunking Strategy

**Rules**:

1. **Always create**: Table metadata chunk (1 per table)
2. **Conditionally create**: Row chunks for records with long text
3. **Never create**: Chunks for purely numeric/categorical rows

```typescript
async function smartChunkTable(table: ParsedTable, schema: TableSchema): Promise<ISearchChunk[]> {
  const chunks: ISearchChunk[] = [];

  // Step 1: Create table metadata chunk
  chunks.push(createTableMetadataChunk(table, schema));

  // Step 2: Filter rows needing semantic search
  const textColumns = schema.columns.filter((c) => c.isEmbeddable);

  if (textColumns.length === 0) {
    // No text columns → no row chunks needed
    console.log(`Table ${table.name} has no text fields - skipping row chunking`);
    return chunks;
  }

  // Step 3: Sample rows with substantial text content
  const textRows = table.rows.filter((row) => {
    const totalTextLength = textColumns
      .map((col) => {
        const colIndex = table.headers.indexOf(col.name);
        const value = row[colIndex];
        return typeof value === 'string' ? value.length : 0;
      })
      .reduce((sum, len) => sum + len, 0);

    return totalTextLength > 100; // Only chunk rows with > 100 chars of text
  });

  console.log(
    `Table ${table.name}: ${table.rows.length} total rows, ${textRows.length} rows with text content`,
  );

  // Step 4: Chunk text rows
  for (const row of textRows) {
    const rowChunks = await generateRowChunks(row, schema);
    chunks.push(...rowChunks);
  }

  return chunks;
}
```

---

## Summary

### Problems with Current Approach

1. ❌ **Cost**: Embedding every row is expensive
2. ❌ **Wrong abstraction**: Vector search for structured data is mismatched
3. ❌ **Missing aggregations**: Can't do SQL-like queries (SUM, AVG, GROUP BY)
4. ❌ **Scale**: 100k rows → 100k chunks (storage explosion)

### Recommended Solution

1. ✅ **ClickHouse for data**: Store full table, enable SQL queries (already in infrastructure)
2. ✅ **Vector search for text**: Only semantic fields (descriptions, notes)
3. ✅ **Text-to-SQL**: LLM generates SQL from natural language
4. ✅ **Hybrid queries**: Combine vector search + SQL filters
5. ✅ **Smart chunking**: Only chunk rows with text content

### Cost Comparison (100k row table)

| Metric         | Current | Recommended | Savings |
| -------------- | ------- | ----------- | ------- |
| Embedding cost | $1.00   | $0.01       | **99%** |
| Storage        | 1.5 GB  | 50 MB       | **97%** |
| Query latency  | 200ms   | 50ms (SQL)  | **75%** |

### Next Steps

1. Integrate with existing ClickHouse infrastructure
2. Implement query classifier
3. Build text-to-SQL generator
4. Test on realistic datasets (10k, 100k, 1M rows)
5. Benchmark query performance
