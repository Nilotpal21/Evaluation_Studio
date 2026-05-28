# ADR-003: ClickHouse for Structured Data

**Status:** Accepted
**Date:** 2025-Q4
**Deciders:** Platform Architecture Team
**Tags:** structured-data, analytics, storage

---

## Context

The search-ai platform needs to store and query tabular data (CSV, JSON arrays, Excel) efficiently. Requirements:

1. Store 100K-1M+ rows per table
2. Support SQL queries (SELECT, WHERE, JOIN, GROUP BY, aggregations)
3. Sub-second query latency for analytical queries
4. Cost-effective storage (columnar compression)
5. Integrate with semantic search (discovery via embeddings → query via SQL)

**Data types:**

- CSV files (sales data, logs, transactions)
- JSON tabular (flat arrays of objects)
- Excel spreadsheets (multiple sheets)

**Query patterns:**

- Semantic discovery: "Find sales data for Q4 2024" → discovers table via metadata chunk embedding
- SQL execution: "SELECT SUM(revenue) FROM sales_q4 WHERE region = 'US'" → runs on actual data

---

## Decision

Use **ClickHouse** (columnar OLAP database) for structured data storage and querying.

**Architecture:**

```
Semantic Search (MongoDB + embeddings)
   ↓ Discovers relevant table
   ↓
Text-to-SQL (LLM generates SQL)
   ↓
ClickHouse (executes SQL on actual data)
   ↓
Results returned to user
```

**Storage strategy:**

- **Metadata chunk** in MongoDB (1 per table) with embedding for semantic discovery
- **Full dataset** in ClickHouse (all rows) for SQL querying
- **Path index** in ClickHouse (for nested JSON field discovery)

---

## Rationale

### Why ClickHouse Over Alternatives?

#### Comparison Matrix

| Feature          | ClickHouse                 | PostgreSQL          | MongoDB             | Elasticsearch       | DuckDB                     |
| ---------------- | -------------------------- | ------------------- | ------------------- | ------------------- | -------------------------- |
| **Query Speed**  | ⭐⭐⭐⭐⭐ 10-100× faster  | ⭐⭐⭐ Baseline     | ⭐⭐ No SQL         | ⭐⭐ No SQL         | ⭐⭐⭐⭐ Fast (in-process) |
| **Compression**  | ⭐⭐⭐⭐⭐ 10:1 ratio      | ⭐⭐ 2-3:1          | ⭐⭐ 2:1            | ⭐⭐⭐ 3-4:1        | ⭐⭐⭐⭐ 5-8:1             |
| **Aggregations** | ⭐⭐⭐⭐⭐ Optimized       | ⭐⭐⭐ Good         | ⭐⭐ Limited        | ⭐⭐ Limited        | ⭐⭐⭐⭐ Good              |
| **SQL Support**  | ⭐⭐⭐⭐⭐ Full ANSI SQL   | ⭐⭐⭐⭐⭐ Full     | ❌ No SQL           | ❌ No SQL           | ⭐⭐⭐⭐ Good              |
| **Deployment**   | ⭐⭐⭐⭐ Standalone server | ⭐⭐⭐⭐ Standalone | ⭐⭐⭐⭐ Standalone | ⭐⭐⭐⭐ Standalone | ⭐⭐⭐⭐⭐ Embedded        |
| **Cost**         | ✅ Open-source             | ✅ Open-source      | ✅ Open-source      | ✅ Open-source      | ✅ Open-source             |

#### Key Advantages

**1. Columnar Storage = 10× Compression**

Row format (PostgreSQL):

```
Row 1: [id=1, name="Alice", age=25, city="NYC", revenue=1000]
Row 2: [id=2, name="Bob", age=30, city="LA", revenue=2000]
...
```

**Problem:** Reading `SUM(revenue)` reads entire rows (wasteful)

Column format (ClickHouse):

```
id:      [1, 2, 3, ...]
name:    ["Alice", "Bob", "Charlie", ...]
revenue: [1000, 2000, 3000, ...]  ← Only this column read
```

**Benefit:** 10× less I/O for analytical queries

**Compression:**

- Revenue column: `[1000, 2000, 3000, ...]` → Delta encoding → `[1000, +1000, +1000, ...]` → 90% smaller
- 1M rows × 100 bytes = 100MB (uncompressed)
- ClickHouse: 10MB compressed (10:1 ratio)
- PostgreSQL: 50MB compressed (2:1 ratio)

**Savings:** $5/month per table (storage cost)

**2. 10-100× Faster Analytical Queries**

**Benchmark (1M rows, 20 columns):**

```sql
SELECT region, SUM(revenue), AVG(quantity)
FROM sales
WHERE date >= '2024-01-01'
GROUP BY region
```

| Database       | Query Time           |
| -------------- | -------------------- |
| **ClickHouse** | 45ms                 |
| **PostgreSQL** | 2,500ms (55× slower) |
| **MongoDB**    | N/A (no SQL)         |

**Why so fast?**

- Columnar storage → Only read 3 columns (region, revenue, quantity), not all 20
- Vectorized execution → SIMD instructions process 1000s of rows per CPU cycle
- Skip indexes → Skip entire data blocks that don't match WHERE clause

**3. Native SQL Support**

**Problem with MongoDB/Elasticsearch:** No native SQL

```javascript
// MongoDB aggregation pipeline (hard to generate from natural language)
db.sales.aggregate([
  { $match: { date: { $gte: ISODate('2024-01-01') } } },
  { $group: { _id: '$region', revenue: { $sum: '$revenue' }, qty: { $avg: '$quantity' } } },
]);
```

**ClickHouse:** Standard SQL (easy for LLM to generate)

```sql
SELECT region, SUM(revenue), AVG(quantity)
FROM sales
WHERE date >= '2024-01-01'
GROUP BY region
```

**4. Built for OLAP (Analytics)**

ClickHouse optimizations:

- Pre-aggregation (materialized views)
- Approximate queries (`quantile`, `uniq` functions)
- Partitioning (automatic time-series partitioning)
- Distributed queries (sharding, though not used yet)

**5. Integration with Existing Stack**

- **Docker/K8s friendly:** Single binary, no JVM
- **Node.js client:** `@clickhouse/client` (official, well-maintained)
- **Backup/restore:** Simple SQL dumps or `clickhouse-backup` tool

---

### Why NOT Alternatives?

#### Alternative 1: PostgreSQL

**Pros:**

- ✅ ACID transactions (but not needed for read-only analytics)
- ✅ Mature ecosystem
- ✅ Team familiarity

**Cons:**

- ❌ 10-100× slower for analytical queries
- ❌ 5× larger storage footprint (row-based)
- ❌ Poor performance on 1M+ row aggregations

**Why rejected:** Performance gap too large for analytical workloads. PostgreSQL excels at OLTP (transactional), not OLAP (analytical).

---

#### Alternative 2: DuckDB (Embedded OLAP)

**Pros:**

- ✅ Similar performance to ClickHouse
- ✅ Embedded (no separate server)
- ✅ Simple deployment

**Cons:**

- ❌ **No multi-tenant isolation**: Single process = shared memory = cross-tenant risk
- ❌ **No horizontal scaling**: Embedded = single machine limit
- ❌ **File-based storage**: Complex backup/restore in distributed environment

**Why rejected:** Lack of multi-tenant isolation is a deal-breaker. Would need separate DuckDB instance per tenant (operational nightmare, see ADR-002).

---

#### Alternative 3: Keep Everything in MongoDB

**Pros:**

- ✅ Simpler architecture (one database)
- ✅ Aggregation framework exists

**Cons:**

- ❌ **No SQL**: Can't use standard SQL query language
- ❌ **Aggregation pipeline complexity**: Hard for LLM to generate correct pipelines
- ❌ **Poor performance**: 10× slower than ClickHouse for aggregations
- ❌ **Storage overhead**: BSON is less efficient than columnar compression

**Why rejected:** MongoDB is a document store, not an analytics database. Using it for 1M-row analytics is like using a screwdriver as a hammer.

---

## Consequences

### Positive

- ✅ **10-100× faster queries** for analytical workloads (45ms vs 2,500ms)
- ✅ **10× compression** (10MB vs 100MB per 1M rows)
- ✅ **Standard SQL** (easy for LLM text-to-SQL generation)
- ✅ **Cost savings:** $5/month per table (storage), $50/month (fewer query resources)
- ✅ **Scalability:** Handles 100M+ rows per table (PostgreSQL struggles at 10M)

### Negative

- ❌ **Additional service dependency:** ClickHouse adds operational complexity
- ❌ **Learning curve:** Team needs to learn ClickHouse-specific optimizations
- ❌ **No transactions:** ClickHouse is eventually consistent (but fine for read-only analytics)

### Neutral

- ⚪ **Backup complexity:** Need separate backup strategy for ClickHouse (vs unified MongoDB backup)

---

## Implementation

### Table Schema

```sql
-- apps/search-ai-runtime/src/clickhouse/schema.sql
CREATE TABLE IF NOT EXISTS search_data (
  tenant_id String,
  index_id String,
  table_id String,
  row_data String,  -- JSON (schema-flexible)
  created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
PARTITION BY (tenant_id, index_id)
ORDER BY (tenant_id, index_id, table_id, created_at)
SETTINGS index_granularity = 8192
```

### Query Pattern

```typescript
// 1. Semantic discovery (MongoDB + embeddings)
const tables = await semanticSearch('sales data for Q4 2024');
// Returns: { tableId: "sales_q4", tableName: "Q4 Sales", ... }

// 2. Text-to-SQL (LLM generates SQL)
const sql = await generateSQL("What's the total revenue by region?", schema);
// Returns: "SELECT region, SUM(revenue) FROM sales_q4 GROUP BY region"

// 3. Execute on ClickHouse
const results = await clickhouse.query({
  query: sql,
  query_params: { tenant_id: tenantId, table_id: tableId },
});
```

### Performance Tuning

```sql
-- Materialized view for common aggregations (pre-computed)
CREATE MATERIALIZED VIEW sales_by_region_mv
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, region, created_at)
AS SELECT
  tenant_id,
  region,
  sum(revenue) as total_revenue,
  count() as order_count
FROM search_data
WHERE table_id = 'sales'
GROUP BY tenant_id, region, created_at
```

---

## Cost Analysis

**Scenario:** 100 tables, 1M rows each, 20 columns average

| Database       | Storage Cost           | Query Cost     | Total/Month |
| -------------- | ---------------------- | -------------- | ----------- |
| **ClickHouse** | $10 (100GB compressed) | $20 (CPU)      | **$30**     |
| **PostgreSQL** | $50 (500GB)            | $80 (high CPU) | **$130**    |
| **MongoDB**    | $60 (600GB BSON)       | N/A            | **$60**     |

**Savings:** $100/month vs PostgreSQL, $30/month vs MongoDB

---

## Related Decisions

- **ADR-005: Two-Phase Ingestion** — Analyze → Finalize flow populates ClickHouse
- **ADR-002: Shared Indices** — ClickHouse uses same property-based tenant isolation

---

## Future Considerations

**When to revisit:**

1. **DuckDB matures with multi-tenant support:** Re-evaluate embedded option
2. **ClickHouse Cloud pricing:** Consider managed service vs self-hosted
3. **100M+ rows per table:** Consider distributed ClickHouse cluster

---

**References:**

- Implementation: `apps/search-ai-runtime/src/clickhouse/`
- Documentation: `apps/search-ai/docs/chunking/06-json-storage-architecture.md`
- Benchmarks: `apps/search-ai/docs/chunking/13-benchmarking-and-quality.md`

**Last Updated:** 2026-02-24
