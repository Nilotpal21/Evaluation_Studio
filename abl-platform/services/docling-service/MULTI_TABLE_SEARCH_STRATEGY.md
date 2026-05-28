# Multi-Table Search Strategy

**Date**: 2026-02-23
**Problem**: When multiple tables qualify for a user query, how do we finalize which tables to search and how do we return results?

## Problem Statement

### Scenario

**User Query**: "Find technology companies with revenue over $1M"

**Table Discovery Results**:

- `customers` (confidence: 0.95) - Has company descriptions + revenue
- `accounts` (confidence: 0.85) - Has company info + financial data
- `companies` (confidence: 0.80) - Has company names + industry tags
- `revenue_summary` (confidence: 0.75) - Aggregated revenue by company
- `sales_pipeline` (confidence: 0.60) - Has company references + deal values

**Questions**:

1. Do we search **all** 5 tables?
2. Do we search only the **top 1-2** tables?
3. Do we let the **LLM decide** which tables to use?
4. How do we **merge results** from multiple tables?
5. How do we **deduplicate** if the same record appears in multiple tables?

---

## Strategy: LLM-Based Table Selection

### Approach

After discovery returns ranked candidates, use **LLM to intelligently select 1-3 tables** based on:

- Query requirements
- Table schemas
- Join relationships
- Data completeness

**Key Insight**: Don't blindly search all candidates. Let the LLM reason about which tables actually answer the query.

---

## Selection Algorithm

```typescript
async function selectAndSearchTables(
  query: string,
  candidates: TableCandidate[],
): Promise<SearchResult> {
  // Step 1: LLM selects relevant tables (1-3 max)
  const selection = await selectTablesWithLLM(query, candidates.slice(0, 5)); // Top 5 candidates

  // Step 2: Based on selection, choose search strategy
  if (selection.selectedTables.length === 1) {
    // Single table: Simple case
    return await searchSingleTable(selection.selectedTables[0], query);
  } else if (selection.needsJoin) {
    // Multiple tables with join relationship
    return await searchWithJoin(selection.selectedTables, query, selection.joinStrategy);
  } else {
    // Multiple independent tables
    return await searchMultipleTables(selection.selectedTables, query);
  }
}
```

---

## Case 1: Single Table Selection (Most Common)

### LLM Decision

```typescript
async function selectTablesWithLLM(
  query: string,
  candidates: TableCandidate[],
): Promise<TableSelection> {
  const prompt = `
You are a database expert. Given a user query and candidate tables, select the 1-3 most relevant tables.

User Query: "${query}"

Candidate Tables:
${candidates
  .map(
    (c, i) => `
${i + 1}. Table: ${c.tableName} (confidence: ${c.finalScore.toFixed(2)})
   Description: ${c.description}
   Columns: ${c.columns.join(', ')}
   Row Count: ${c.rowCount}
   Sample Row: ${JSON.stringify(c.sampleRows[0], null, 2)}
`,
  )
  .join('\n')}

Task:
1. Analyze which table(s) contain the data needed to answer the query
2. Prefer SINGLE table if possible (simpler, faster)
3. Only select multiple tables if:
   - Query explicitly requests data from different entities (e.g., "customers with their orders")
   - Single table doesn't have all required data
   - Tables need to be joined (foreign key relationship exists)

Respond with JSON:
{
  "selectedTables": [
    {
      "tableName": "customers",
      "reasoning": "Has company descriptions for 'technology' semantic search AND revenue column for '>$1M' filter",
      "requiredColumns": ["name", "description", "revenue", "status"],
      "estimatedRelevance": 0.95,
      "canAnswerQueryAlone": true
    }
  ],
  "needsJoin": false,
  "joinStrategy": null,
  "queryStrategy": "single_table"  // "single_table" | "join" | "union"
}
`;

  const response = await llm.complete({
    prompt,
    model: 'gpt-4o',
    responseFormat: { type: 'json_object' },
  });

  return JSON.parse(response.text);
}
```

### Example Result

**User Query**: "Find technology companies with revenue over $1M"

**LLM Selection**:

```json
{
  "selectedTables": [
    {
      "tableName": "customers",
      "reasoning": "Has company descriptions for 'technology' semantic search AND revenue column for '>$1M' filter. No need for other tables.",
      "requiredColumns": ["name", "description", "revenue", "status"],
      "estimatedRelevance": 0.95,
      "canAnswerQueryAlone": true
    }
  ],
  "needsJoin": false,
  "queryStrategy": "single_table"
}
```

### Execution

```typescript
async function searchSingleTable(table: SelectedTable, query: string): Promise<SearchResult> {
  // Generate SQL for single table
  const { sql } = await generateSQL(query, [table]);

  // Execute on ClickHouse
  const results = await clickhouse.query({
    query: sql,
    query_params: { tenantId, indexId },
  });

  return {
    strategy: 'single_table',
    tables: [table.tableName],
    results: results.data,
    explanation: table.reasoning,
  };
}
```

**SQL Generated**:

```sql
SELECT name, description, revenue, status
FROM customers
WHERE tenant_id = 'acme-corp'
  AND index_id = 'idx123'
  AND revenue > 1000000
  AND description ILIKE '%technology%'
ORDER BY revenue DESC
LIMIT 100
```

**Result**: Simple, fast, single-table query.

---

## Case 2: Multi-Table Join (Related Data)

### Scenario

**User Query**: "Show me customers with their recent orders"

**LLM Selection**:

```json
{
  "selectedTables": [
    {
      "tableName": "customers",
      "reasoning": "Contains customer information (name, status, contact details)",
      "requiredColumns": ["id", "name", "status", "email"]
    },
    {
      "tableName": "orders",
      "reasoning": "Contains order data (order date, amount, items)",
      "requiredColumns": ["order_id", "customer_id", "order_date", "amount"]
    }
  ],
  "needsJoin": true,
  "joinStrategy": {
    "type": "INNER JOIN",
    "leftTable": "customers",
    "rightTable": "orders",
    "on": "customers.id = orders.customer_id",
    "reasoning": "Foreign key relationship detected: orders.customer_id → customers.id"
  },
  "queryStrategy": "join"
}
```

### Execution

```typescript
async function searchWithJoin(
  tables: SelectedTable[],
  query: string,
  joinStrategy: JoinStrategy,
): Promise<SearchResult> {
  // Generate SQL with JOIN
  const { sql } = await generateJoinSQL(query, tables, joinStrategy);

  // Execute on ClickHouse
  const results = await clickhouse.query({
    query: sql,
    query_params: { tenantId, indexId },
  });

  return {
    strategy: 'join',
    tables: tables.map((t) => t.tableName),
    results: results.data,
    explanation: `Joined ${tables[0].tableName} with ${tables[1].tableName} on ${joinStrategy.on}`,
  };
}
```

**SQL Generated**:

```sql
SELECT
  c.id AS customer_id,
  c.name AS customer_name,
  c.status AS customer_status,
  o.order_id,
  o.order_date,
  o.amount
FROM customers c
INNER JOIN orders o ON c.id = o.customer_id
WHERE c.tenant_id = 'acme-corp'
  AND c.index_id = 'idx123'
  AND o.tenant_id = 'acme-corp'
  AND o.index_id = 'idx123'
  AND o.order_date >= '2024-01-01'  -- "recent" interpreted as 2024
ORDER BY o.order_date DESC
LIMIT 100
```

**Result**: Joined results with customer + order data.

---

## Case 3: Multi-Table Union (Independent Searches)

### Scenario

**User Query**: "Find all mentions of 'Project Alpha'"

**Tables**: `projects`, `tasks`, `documents`, `comments`

**LLM Selection**:

```json
{
  "selectedTables": [
    {
      "tableName": "projects",
      "reasoning": "Has project names and descriptions"
    },
    {
      "tableName": "tasks",
      "reasoning": "Has task descriptions that may reference projects"
    },
    {
      "tableName": "documents",
      "reasoning": "Has document content that may mention projects"
    }
  ],
  "needsJoin": false,
  "queryStrategy": "union"
}
```

### Execution

```typescript
async function searchMultipleTables(tables: SelectedTable[], query: string): Promise<SearchResult> {
  // Search each table independently in parallel
  const searchPromises = tables.map((table) => searchSingleTable(table, query));

  const results = await Promise.all(searchPromises);

  // Merge results
  const mergedResults = mergeAndRankResults(results, query);

  return {
    strategy: 'union',
    tables: tables.map((t) => t.tableName),
    results: mergedResults,
    explanation: `Searched ${tables.length} tables independently and merged results`,
  };
}

function mergeAndRankResults(results: SearchResult[], query: string): MergedResult[] {
  const allResults: MergedResult[] = [];

  for (const result of results) {
    for (const row of result.results) {
      allResults.push({
        ...row,
        sourceTable: result.tables[0],
        relevanceScore: calculateRelevance(row, query),
      });
    }
  }

  // Sort by relevance
  return allResults.sort((a, b) => b.relevanceScore - a.relevanceScore);
}
```

**Execution Plan**:

1. Query `projects` table: `SELECT * FROM projects WHERE ... ILIKE '%Project Alpha%'`
2. Query `tasks` table: `SELECT * FROM tasks WHERE ... ILIKE '%Project Alpha%'`
3. Query `documents` table: `SELECT * FROM documents WHERE ... ILIKE '%Project Alpha%'`
4. Merge results, deduplicate, rank by relevance

**Result Format**:

```json
{
  "strategy": "union",
  "tables": ["projects", "tasks", "documents"],
  "results": [
    {
      "sourceTable": "projects",
      "name": "Project Alpha",
      "description": "...",
      "relevanceScore": 0.95
    },
    {
      "sourceTable": "tasks",
      "taskName": "Alpha Integration",
      "description": "Part of Project Alpha...",
      "relevanceScore": 0.88
    },
    {
      "sourceTable": "documents",
      "docTitle": "Project Alpha Requirements",
      "content": "...",
      "relevanceScore": 0.85
    }
  ],
  "totalResults": 42,
  "resultBreakdown": {
    "projects": 5,
    "tasks": 18,
    "documents": 19
  }
}
```

---

## Decision Tree

```
User Query
    ↓
Discovery Engine (returns 5 candidates)
    ↓
LLM Table Selector
    ↓
┌───────────────────────────────────────────────────────────┐
│ Can query be answered by single table?                    │
├───────────────────────────────────────────────────────────┤
│                                                            │
│  YES (80% of cases)                                       │
│    └→ Single Table Search                                 │
│       └→ Generate SQL for 1 table                         │
│       └→ Execute on ClickHouse                            │
│       └→ Return results                                   │
│                                                            │
│  NO - Multiple tables needed                              │
│    ├→ Do tables have foreign key relationship?           │
│    │                                                       │
│    │  YES → Join Search                                   │
│    │    └→ Generate SQL with JOIN                         │
│    │    └→ Execute single query with join                 │
│    │    └→ Return joined results                          │
│    │                                                       │
│    │  NO → Union Search                                   │
│    │    └→ Search each table independently (parallel)     │
│    │    └→ Merge results                                  │
│    │    └→ Rank by relevance                              │
│    │    └→ Deduplicate if needed                          │
│    │    └→ Return merged results                          │
│                                                            │
└───────────────────────────────────────────────────────────┘
```

---

## Performance Considerations

### Single Table (Fastest)

```
Query Latency:
- Table selection: 1-2s (LLM)
- SQL generation: 500ms (LLM)
- SQL execution: 50-200ms (ClickHouse)
- Total: ~2-3s
```

### Join (Medium)

```
Query Latency:
- Table selection: 1-2s (LLM)
- SQL generation: 1s (LLM, more complex)
- SQL execution: 100-500ms (ClickHouse join)
- Total: ~3-4s
```

### Union (Slowest)

```
Query Latency:
- Table selection: 1-2s (LLM)
- SQL generation: 500ms × 3 tables = 1.5s (parallel)
- SQL execution: 200ms × 3 tables = 600ms (parallel)
- Merge & rank: 100ms
- Total: ~4-5s
```

### Optimization: Limit Multi-Table Searches

**Rule**: LLM should select **maximum 3 tables**. More than 3 usually indicates:

- Query is too broad
- Table discovery needs refinement
- User should narrow their query

---

## Deduplication Strategy

### Problem

If multiple tables reference the same entity (e.g., customer appears in `customers` AND `accounts`), avoid returning duplicates.

### Solution: Entity Resolution

```typescript
function deduplicateResults(results: MergedResult[], tables: SelectedTable[]): MergedResult[] {
  // Strategy: Group by primary key + table if possible
  const seenEntities = new Map<string, MergedResult>();

  for (const result of results) {
    // Generate entity key
    const entityKey = generateEntityKey(result);

    // If we've seen this entity before, keep the one with higher relevance
    if (seenEntities.has(entityKey)) {
      const existing = seenEntities.get(entityKey)!;
      if (result.relevanceScore > existing.relevanceScore) {
        seenEntities.set(entityKey, result);
      }
    } else {
      seenEntities.set(entityKey, result);
    }
  }

  return Array.from(seenEntities.values());
}

function generateEntityKey(result: MergedResult): string {
  // Try to identify entity by common fields
  if (result.id) return `${result.sourceTable}:${result.id}`;
  if (result.customer_id) return `customer:${result.customer_id}`;
  if (result.order_id) return `order:${result.order_id}`;

  // Fallback: use combination of identifying fields
  const identifiers = [result.name, result.email, result.phone].filter(Boolean);
  if (identifiers.length > 0) {
    return `entity:${identifiers.join('|')}`;
  }

  // Last resort: consider each row unique
  return `${result.sourceTable}:${Math.random()}`;
}
```

---

## User Experience

### Result Presentation

**Option 1: Grouped by Table** (for union searches)

```json
{
  "query": "Find all mentions of Project Alpha",
  "strategy": "union",
  "results": {
    "projects": [
      { "name": "Project Alpha", "status": "active", ... }
    ],
    "tasks": [
      { "taskName": "Alpha Integration", ... },
      { "taskName": "Alpha Testing", ... }
    ],
    "documents": [
      { "docTitle": "Project Alpha Requirements", ... }
    ]
  },
  "totalResults": 42
}
```

**Option 2: Flat List** (ranked by relevance)

```json
{
  "query": "Find all mentions of Project Alpha",
  "strategy": "union",
  "results": [
    { "sourceTable": "projects", "name": "Project Alpha", "relevanceScore": 0.95 },
    { "sourceTable": "tasks", "taskName": "Alpha Integration", "relevanceScore": 0.88 },
    { "sourceTable": "documents", "docTitle": "Alpha Requirements", "relevanceScore": 0.85 }
  ],
  "totalResults": 42
}
```

**Recommendation**: Use **flat list** for simplicity. Include `sourceTable` field so UI can display table badges.

---

## Summary

### Multi-Table Search Strategy

| Scenario                        | Strategy     | Execution                  | Typical Latency |
| ------------------------------- | ------------ | -------------------------- | --------------- |
| **Single table sufficient**     | Single Table | 1 SQL query                | ~2-3s           |
| **Tables have FK relationship** | Join         | 1 SQL query with JOIN      | ~3-4s           |
| **Multiple independent tables** | Union        | N parallel queries + merge | ~4-5s           |

### Key Decisions

1. ✅ **LLM selects tables** (not blind search of all candidates)
2. ✅ **Prefer single table** (80% of queries)
3. ✅ **Maximum 3 tables** (performance + complexity limit)
4. ✅ **Parallel execution** (for union searches)
5. ✅ **Deduplication** (entity resolution)
6. ✅ **Flat result list** (simpler UX)

### Result Format

```typescript
interface MultiTableSearchResult {
  query: string;
  strategy: 'single_table' | 'join' | 'union';
  tables: string[];
  results: Array<{
    sourceTable: string;
    relevanceScore: number;
    [key: string]: any; // Table-specific fields
  }>;
  totalResults: number;
  executionTimeMs: number;
  explanation: string;
}
```

This approach balances **accuracy** (LLM-guided table selection), **performance** (parallel execution, deduplication), and **user experience** (clear source attribution, ranked results).
