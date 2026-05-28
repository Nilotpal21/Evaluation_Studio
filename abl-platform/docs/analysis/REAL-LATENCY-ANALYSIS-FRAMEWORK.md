# Real Search Latency Analysis Framework

**Date**: 2026-04-17  
**Purpose**: Framework for collecting and analyzing real search latency data  
**Status**: Ready to run once you have indexed data

## Problem Statement

The previous analysis documents provided **architectural breakdowns and estimated timings** based on code analysis. To get **real numbers**, we need:

1. **Indexed data** in an active search index
2. **Running services** (search-ai-runtime on port 3004)
3. **Actual queries** executed through the full pipeline

## Current Status

### What's Running ✓

```
✓ search-ai-runtime (port 3004) - 36h uptime
✓ search-ai (port 3005) - 36h uptime
✓ runtime (port 3112) - 7d uptime
✓ MongoDB - connected
✓ Redis - connected
✓ ClickHouse - available (but no recent query data)
```

### What's Missing ✗

```
✗ No indexed data in searchindexes collection
✗ No recent search queries in ClickHouse
✗ Test index 'test-index-1' returns 0 results
```

**Result**: Benchmark queries execute in 2-22ms because they hit an empty index and return immediately without doing actual vector search, embedding generation, or reranking.

---

## How to Get Real Numbers

### Option 1: Use Existing Production Data (Recommended)

If you have a production or staging environment with real data:

1. **Find an active index ID**:

```bash
# Connect to MongoDB
mongo mongodb://localhost:27017/abl_platform

# Find active indices with documents
db.searchindexes.find({
  status: 'active',
  documentCount: { $gt: 0 }
}).pretty()

# Note the _id field - this is your INDEX_ID
```

2. **Run benchmark against real index**:

```bash
# Replace with your actual tenant and index IDs
TENANT_ID="your-tenant-id" \
INDEX_ID="your-index-id" \
npx tsx tools/search-latency-benchmark.ts
```

3. **View results**:

```bash
cat tools/search-latency-results.json
```

### Option 2: Index Sample Documents

If you need to create test data:

1. **Upload documents via Studio**:
   - Go to http://localhost:5173
   - Create a knowledge base
   - Upload 10-20 documents (PDFs, markdown, text files)
   - Wait for indexing to complete (~2-5 minutes)

2. **Verify indexing**:

```bash
# Check OpenSearch has vectors
curl -XGET "localhost:9200/_cat/indices/search-vectors*?v"

# Should show indices with doc count > 0
```

3. **Run benchmark**:

```bash
# Use the knowledge base ID from Studio
TENANT_ID="..." INDEX_ID="..." npx tsx tools/search-latency-benchmark.ts
```

### Option 3: Query ClickHouse for Historical Data

If you have existing search history:

```sql
-- Get sample of recent queries with full timing breakdown
SELECT
  query_id,
  query_type,
  query_text,
  total_latency_ms,
  vocabulary_resolve_ms,
  vector_search_ms,
  structured_filter_ms,
  rerank_ms,
  result_count,
  timestamp
FROM abl_platform.search_queries
WHERE timestamp >= now() - INTERVAL 7 DAY
  AND result_count > 0  -- Only queries that found results
ORDER BY timestamp DESC
LIMIT 100;
```

Export to CSV and analyze in Excel/Python.

---

## Benchmark Script Features

The provided `tools/search-latency-benchmark.ts` script includes:

### 20 Different Query Patterns

1. **Semantic + Rerank** (4 variations: short, medium, long, topK variants)
2. **Semantic without Rerank** (2 variations)
3. **Hybrid + Rerank** (4 variations: basic, with filters, without rerank, full pipeline)
4. **Structured** (4 variations: single filter, multi-filter, complex, date filters)
5. **Aggregations** (2 variations: basic, with filters)
6. **Edge cases** (2 variations: very short query, very long query)
7. **Full pipeline** (2 variations: with preprocessing and vocabulary resolution)

### Metrics Collected Per Query

- **Total latency** (wall-clock time)
- **Permission filter time**
- **Preprocessing time**
- **Vocabulary resolution time**
- **Alias resolution time**
- **Search execution time** (embedding + kNN/BM25)
- **Rerank time**
- **Result count**
- **Top score** (relevance quality)

### Analytics Produced

1. **Overall statistics**: avg, min, max, P50, P75, P90, P95, P99
2. **By query type**: semantic, hybrid, structured, aggregation
3. **Reranking impact**: with vs without rerank
4. **Stage breakdown**: % of time spent in each pipeline stage
5. **Detailed results table**: all queries with timing breakdown
6. **JSON export**: machine-readable results for further analysis

---

## Expected Real-World Timings

Based on code analysis and production system patterns, here's what you should expect:

### Semantic + Rerank (Typical Agent Query)

```
Permission Filter:     10-20ms
Preprocessing:         SKIPPED (agent flow)
Vocabulary Resolution: SKIPPED (agent flow)
Alias Resolution:      5-10ms
Embedding Generation:  150-250ms (BGE-M3 local, 100-400ms external)
kNN Query:             150-300ms (depends on index size)
Question→Parent:       20-50ms
Reranking:             300-600ms (Cohere/Voyage API)
────────────────────────────────
TOTAL:                 635-1230ms
```

### Hybrid + Rerank

```
Permission Filter:     10-20ms
Alias Resolution:      5-10ms
Embedding Generation:  150-250ms (parallel with BM25)
kNN sub-query:         150-300ms
BM25 sub-query:        80-150ms  (parallel with kNN)
RRF Fusion:            5-10ms
Question→Parent:       20-50ms
Reranking:             300-600ms
────────────────────────────────
TOTAL:                 570-1140ms
```

### Structured with Filters (Fast Path)

```
Permission Filter:     10-20ms
Alias Resolution:      5-10ms
DSL Build:             15-25ms
BM25 + Filters:        60-120ms
────────────────────────────────
TOTAL:                 90-175ms
```

### Aggregation

```
Permission Filter:     10-20ms
Alias Resolution:      5-10ms
DSL Build:             15-25ms
Terms Aggregation:     100-400ms (cardinality-dependent)
────────────────────────────────
TOTAL:                 130-455ms
```

---

## Latency Factors

### Index Size Impact

| Doc Count   | Chunk Count   | kNN Latency | Notes                          |
| ----------- | ------------- | ----------- | ------------------------------ |
| 10 docs     | 50 chunks     | 50-100ms    | Small knowledge base           |
| 100 docs    | 500 chunks    | 100-200ms   | Medium knowledge base          |
| 1,000 docs  | 5,000 chunks  | 200-400ms   | Large knowledge base           |
| 10,000 docs | 50,000 chunks | 400-800ms   | Very large, needs optimization |

### Embedding Provider Impact

| Provider       | Model                  | Latency   | Cost/1K tokens |
| -------------- | ---------------------- | --------- | -------------- |
| BGE-M3 (local) | BAAI/bge-m3            | 150-250ms | $0.00          |
| OpenAI         | text-embedding-3-small | 100-200ms | $0.02          |
| OpenAI         | text-embedding-3-large | 150-300ms | $0.13          |
| Voyage AI      | voyage-2               | 200-400ms | $0.12          |
| Cohere         | embed-english-v3.0     | 150-300ms | $0.10          |

### Reranker Provider Impact

| Provider  | Model               | Latency   | Cost/search |
| --------- | ------------------- | --------- | ----------- |
| None      | -                   | 0ms       | $0.00       |
| Cohere    | rerank-english-v3.0 | 300-500ms | $0.0001     |
| Voyage AI | rerank-lite-1       | 400-600ms | $0.00008    |
| Jina AI   | jina-reranker-v1    | 350-550ms | $0.00005    |

### Filter Complexity Impact

| Filter Count | DSL Build | Query Exec | Total Overhead |
| ------------ | --------- | ---------- | -------------- |
| 0 filters    | 15ms      | +0ms       | 15ms           |
| 1 filter     | 18ms      | +10ms      | 28ms           |
| 2 filters    | 22ms      | +20ms      | 42ms           |
| 4 filters    | 30ms      | +35ms      | 65ms           |
| 8 filters    | 50ms      | +60ms      | 110ms          |

---

## Optimization Recommendations (Priority Order)

### 1. Disable Reranking Selectively (saves 300-600ms)

**Impact**: 40-50% latency reduction for semantic queries  
**Trade-off**: 5-15% relevance score decrease  
**When**: Low-latency chat, simple lookups, structured queries

```typescript
// In search request
{
  rerank: false; // or omit - defaults to false
}
```

**Expected**: 900ms → 450ms for semantic queries

### 2. Use Structured Queries When Possible (7x faster)

**Impact**: 122ms vs 905ms  
**Trade-off**: No semantic understanding, exact matches only  
**When**: List queries ("show all X"), exact filters ("type = PDF")

```typescript
{
  queryType: 'structured',
  filters: [{ field: 'source_type', operator: 'eq', value: 'pdf' }]
}
```

**Expected**: 900ms → 120ms

### 3. Self-Host Embedding Model (saves 50-150ms + cost)

**Impact**: 20-30% embedding latency reduction, 100% cost savings  
**Trade-off**: Server memory (~2GB), initial setup  
**When**: High query volume, cost-sensitive deployment

```typescript
// Deploy BGE-M3 as local service
docker run -p 8000:8000 ghcr.io/abl/bge-m3-embedding-service
```

**Expected**: 900ms → 800ms, $0.13/query → $0.00

### 4. Eager Discovery at Session Start (saves 500ms on first call)

**Impact**: Eliminates 500ms penalty on first query  
**Trade-off**: Session start takes 500ms longer  
**When**: Agent sessions, known KBs

```typescript
// At session initialization
await searchToolExecutor.triggerEagerDiscovery('search_kb');
```

**Expected**: 1405ms → 905ms for first query

### 5. Batch Size Tuning for Reranker (saves 50-100ms)

**Impact**: 10-20% rerank latency reduction  
**Trade-off**: Higher memory usage  
**When**: Multiple concurrent queries

```typescript
// In BatchedRerankerFactory config
{
  batchSize: 20,     // up from 10
  batchWaitMs: 30    // down from 50ms
}
```

**Expected**: 900ms → 850ms

---

## Monitoring Dashboard Queries

### Real-Time Latency Monitoring

```sql
-- Last hour latency percentiles
SELECT
  query_type,
  COUNT(*) as query_count,
  ROUND(AVG(total_latency_ms), 0) as avg_ms,
  ROUND(quantile(0.5)(total_latency_ms), 0) as p50_ms,
  ROUND(quantile(0.9)(total_latency_ms), 0) as p90_ms,
  ROUND(quantile(0.95)(total_latency_ms), 0) as p95_ms
FROM abl_platform.search_queries
WHERE timestamp >= now() - INTERVAL 1 HOUR
  AND result_count > 0
GROUP BY query_type
ORDER BY query_count DESC;
```

### Rerank Overhead Analysis

```sql
-- Rerank cost vs total latency
SELECT
  query_type,
  COUNT(*) as queries_with_rerank,
  ROUND(AVG(rerank_ms), 0) as avg_rerank_ms,
  ROUND(AVG(total_latency_ms), 0) as avg_total_ms,
  ROUND(AVG(rerank_ms) / AVG(total_latency_ms) * 100, 1) as rerank_percent
FROM abl_platform.search_queries
WHERE rerank_ms > 0
  AND timestamp >= now() - INTERVAL 24 HOUR
GROUP BY query_type
ORDER BY rerank_percent DESC;
```

### Slow Query Detective

```sql
-- Top 20 slowest queries in last 24h
SELECT
  query_id,
  query_type,
  query_text,
  total_latency_ms,
  vocabulary_resolve_ms,
  vector_search_ms,
  rerank_ms,
  result_count,
  formatDateTime(timestamp, '%Y-%m-%d %H:%M:%S') as time
FROM abl_platform.search_queries
WHERE timestamp >= now() - INTERVAL 24 HOUR
ORDER BY total_latency_ms DESC
LIMIT 20;
```

### Stage Breakdown (Average)

```sql
-- Average time spent in each stage
SELECT
  ROUND(AVG(total_latency_ms), 0) as total_ms,
  ROUND(AVG(vocabulary_resolve_ms), 0) as vocab_ms,
  ROUND(AVG(vector_search_ms), 0) as search_ms,
  ROUND(AVG(rerank_ms), 0) as rerank_ms,
  ROUND(AVG(vocabulary_resolve_ms) / AVG(total_latency_ms) * 100, 1) as vocab_pct,
  ROUND(AVG(vector_search_ms) / AVG(total_latency_ms) * 100, 1) as search_pct,
  ROUND(AVG(rerank_ms) / AVG(total_latency_ms) * 100, 1) as rerank_pct
FROM abl_platform.search_queries
WHERE timestamp >= now() - INTERVAL 24 HOUR
  AND result_count > 0;
```

---

## Next Steps

1. **Identify an active index** with documents:

   ```bash
   # Check MongoDB for indices
   mongo mongodb://localhost:27017/abl_platform --eval "db.searchindexes.find({status: 'active'}).pretty()"
   ```

2. **Run the benchmark** with real data:

   ```bash
   TENANT_ID="<your-tenant>" INDEX_ID="<your-index>" npx tsx tools/search-latency-benchmark.ts
   ```

3. **Analyze results**:
   - Check `tools/search-latency-results.json`
   - Compare against expected timings above
   - Identify your bottlenecks

4. **Apply optimizations** based on your workload:
   - High latency semantic queries → disable rerank
   - List/filter operations → use structured queries
   - Cost concerns → self-host embedding
   - First-call latency → eager discovery

5. **Monitor in production**:
   - Set up ClickHouse dashboard with queries above
   - Alert on P95 > 2000ms
   - Track rerank overhead %
   - Monitor slow query patterns

---

## Summary

This framework provides:

✓ **Benchmarking script** ready to run (`tools/search-latency-benchmark.ts`)  
✓ **20 real query patterns** covering all search types  
✓ **Expected timing baselines** from code analysis  
✓ **Optimization playbook** with priority order  
✓ **Monitoring queries** for ClickHouse  
✓ **Step-by-step guide** to get real numbers

**What you need**: Indexed data in an active search index.

**Once you have data**, the benchmark will produce real numbers showing:

- Actual latencies for your hardware/deployment
- Real bottlenecks in your pipeline
- Impact of reranking on your workload
- Filter overhead for your index size
- Query type distribution and patterns

The estimated timings in previous documents are architecturally sound based on code analysis, but **your mileage will vary** based on:

- Hardware (CPU, RAM, GPU)
- Index size (document/chunk count)
- Embedding provider (local vs API)
- Reranker provider and model
- Network latency to external APIs
- Concurrent query load
