# Retrieval Improvements Checklist

**Purpose:** Systematic guide for optimizing retrieval quality and performance
**Status:** Production
**Last Updated:** 2026-02-23

---

## Overview

This checklist covers retrieval optimizations across all document types. Use it to diagnose quality issues, improve accuracy, and tune performance.

**Retrieval Types:**

1. **Semantic Search** - Vector similarity (documents, metadata chunks)
2. **Keyword Search** - BM25, full-text (exact term matching)
3. **Hybrid Search** - Fusion of semantic + keyword
4. **Text-to-SQL** - Natural language → SQL (structured data)
5. **Path-Based** - Hierarchical queries (nested JSON)

---

## Quick Diagnosis

### Problem: Poor Retrieval Quality

**Symptoms:**

- Relevant chunks not in top 10 results
- Irrelevant chunks ranking high
- User queries returning empty results
- Wrong table selected for SQL queries

**Diagnosis Steps:**

1. **Check Query Type Detection**

   ```typescript
   const classification = await queryRouter.classifyQuery(query, tables);
   console.log('Query type:', classification.queryType);
   // Should be: 'semantic', 'sql', 'multi_table', or 'hybrid'
   ```

2. **Inspect Embeddings**

   ```typescript
   const chunk = await SearchChunk.findOne({ _id: chunkId, tenantId, indexId });
   console.log('Has embedding:', !!chunk.embedding);
   console.log('Embedding dimensions:', chunk.embedding?.length);
   console.log('Embedding model:', chunk.embeddingModel);
   ```

3. **Test Direct SQL**

   ```sql
   -- For structured data, test SQL directly
   SELECT * FROM structured_data
   WHERE tenant_id = ? AND index_id = ? AND table_id = ?
   LIMIT 10;
   ```

4. **Check Metadata Quality**
   ```typescript
   const metadata = JSON.parse(chunk.content);
   console.log('Has description:', !!metadata.description);
   console.log('Has sample rows:', metadata.sampleRows?.length);
   console.log('Has statistics:', !!metadata.statistics);
   ```

---

## Checklist: Semantic Search

### ✅ 1. Embedding Quality

**Check:**

- [ ] All chunks have embeddings (`embedding` field not null)
- [ ] Embedding dimensions match expected (3072 for text-embedding-3-large, 1024 for Cohere)
- [ ] Embedding model is consistent across index
- [ ] Embeddings generated from full context (content + summaries + visual insights)

**Fix Poor Embeddings:**

```typescript
// Regenerate embeddings with better context
const embeddingText = [
  chunk.metadata.progressiveSummary, // Context from previous pages
  chunk.content, // Main content
  chunk.metadata.visualAnalysis?.visualInsights, // Visual context
  chunk.questions?.map((q) => q.question).join('\n'), // Generated questions
]
  .filter(Boolean)
  .join('\n\n');

const embedding = await embeddingProvider.embed(embeddingText);
```

**Verify:**

```typescript
// Check embedding coverage
const totalChunks = await SearchChunk.countDocuments({ tenantId, indexId });
const withEmbeddings = await SearchChunk.countDocuments({
  tenantId,
  indexId,
  embedding: { $exists: true, $ne: null },
});

console.log(`Embedding coverage: ${((withEmbeddings / totalChunks) * 100).toFixed(1)}%`);
// Should be 100%
```

---

### ✅ 2. Chunk Size & Boundaries

**Check:**

- [ ] Chunk size between 128-1024 tokens (target: 512)
- [ ] No mid-sentence splits (sentence-aligned chunking)
- [ ] Tables extracted as separate chunks
- [ ] Code blocks kept intact

**Measure Chunk Quality:**

```typescript
const chunks = await SearchChunk.find({ tenantId, indexId, documentId });
const stats = {
  avgTokens: chunks.reduce((sum, c) => sum + (c.tokenCount || 0), 0) / chunks.length,
  minTokens: Math.min(...chunks.map((c) => c.tokenCount || 0)),
  maxTokens: Math.max(...chunks.map((c) => c.tokenCount || 0)),
  totalChunks: chunks.length,
};

console.log('Chunk stats:', stats);
// avgTokens should be 400-600, maxTokens < 1024
```

**Fix Poor Boundaries:**

- Re-run chunking with `sentenceAlignment: true`
- Increase `minChunkSize` to avoid tiny chunks
- Decrease `maxChunkSize` to avoid oversized chunks

---

### ✅ 3. Progressive Summarization

**Check:**

- [ ] Progressive summaries enabled for documents
- [ ] Each chunk has `metadata.progressiveSummary`
- [ ] Summaries include context from previous pages
- [ ] Summaries are embedded alongside content

**Verify:**

```typescript
const chunks = await SearchChunk.find({
  tenantId,
  indexId,
  chunkType: 'page',
}).limit(10);

const withSummaries = chunks.filter((c) => c.metadata?.progressiveSummary);
console.log(`Summary coverage: ${withSummaries.length}/${chunks.length}`);
// Should be high (skip only first page)
```

**Enable:**

```typescript
// In index LLM config
{
  useCases: {
    summarization: {
      enabled: true,
      model: 'gpt-4o-mini',
      maxTokens: 300
    }
  }
}
```

---

### ✅ 4. Vision Enrichment (Images)

**Check:**

- [ ] Vision enabled for documents with images
- [ ] Visual analysis stored in `metadata.visualAnalysis`
- [ ] Visual insights embedded alongside text
- [ ] Images described in searchable language

**Verify:**

```typescript
const chunks = await SearchChunk.find({
  tenantId,
  indexId,
  'metadata.hasImages': true,
});

const withVision = chunks.filter((c) => c.metadata?.visualAnalysis?.visualInsights);
console.log(`Vision coverage: ${withVision.length}/${chunks.length} chunks with images`);
```

**Enable:**

```typescript
{
  useCases: {
    vision: {
      enabled: true,
      model: 'gpt-4o',  // or 'claude-3.5-sonnet'
      maxTokens: 500
    }
  }
}
```

---

### ✅ 5. Question Synthesis

**Check:**

- [ ] Questions generated for each chunk
- [ ] Questions stored in `ChunkQuestion` collection
- [ ] Questions embedded alongside chunk content
- [ ] 3-5 questions per chunk

**Verify:**

```typescript
const chunkCount = await SearchChunk.countDocuments({ tenantId, indexId });
const questionCount = await ChunkQuestion.countDocuments({ tenantId, indexId });

console.log(`Questions per chunk: ${(questionCount / chunkCount).toFixed(1)}`);
// Should be 3-5
```

**Enable:**

```typescript
{
  useCases: {
    questionSynthesis: {
      enabled: true,
      model: 'gpt-4o-mini',
      questionsPerChunk: 5
    }
  }
}
```

---

### ✅ 6. Vector Search Configuration

**Check:**

- [ ] MongoDB Atlas Vector Search index created
- [ ] Index configured for embedding dimensions
- [ ] Similarity metric: cosine (default)
- [ ] numCandidates ≥ 10 × limit (for accurate results)

**Atlas Vector Search Index:**

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 3072,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "tenantId"
    },
    {
      "type": "filter",
      "path": "indexId"
    }
  ]
}
```

**Query Configuration:**

```typescript
const results = await vectorSearch({
  vector: queryEmbedding,
  index: 'vector_index',
  path: 'embedding',
  filter: { tenantId, indexId },
  limit: 10,
  numCandidates: 100, // 10x limit for accuracy
});
```

---

## Checklist: Keyword Search (BM25)

### ✅ 1. Text Indexes

**Check:**

- [ ] MongoDB text index on `content` field
- [ ] ClickHouse full-text index on `searchable_text`
- [ ] Indexes cover all searchable fields

**Create Indexes:**

```typescript
// MongoDB
SearchChunk.collection.createIndex(
  {
    content: 'text',
    'metadata.displayName': 'text',
    'metadata.description': 'text',
  },
  {
    weights: {
      content: 10,
      'metadata.displayName': 5,
      'metadata.description': 3,
    },
  },
);
```

```sql
-- ClickHouse
CREATE INDEX searchable_text_idx ON table_metadata (searchable_text)
TYPE tokenbf_v1(10240, 3, 0) GRANULARITY 4;
```

---

### ✅ 2. Term Matching

**Check:**

- [ ] Exact term matching works (case-insensitive)
- [ ] Stemming applied (run → running → ran)
- [ ] Stop words removed (the, a, an)

**Test:**

```typescript
const results = await SearchChunk.find({
  tenantId,
  indexId,
  $text: { $search: 'authentication' },
}).sort({ score: { $meta: 'textScore' } });

console.log(`Found ${results.length} chunks for "authentication"`);
```

---

### ✅ 3. Phrase Matching

**Check:**

- [ ] Exact phrase matching with quotes
- [ ] Proximity search (words near each other)

**Test:**

```typescript
// Exact phrase
const results = await SearchChunk.find({
  tenantId,
  indexId,
  $text: { $search: '"user authentication flow"' },
});
```

---

## Checklist: Hybrid Search

### ✅ 1. Fusion Strategy

**Check:**

- [ ] Semantic search results retrieved
- [ ] Keyword search results retrieved
- [ ] Results fused with score normalization
- [ ] Duplicate removal

**Reciprocal Rank Fusion (RRF):**

```typescript
function fuseResults(
  semanticResults: SearchResult[],
  keywordResults: SearchResult[],
  k: number = 60, // RRF constant
): SearchResult[] {
  const scoreMap = new Map<string, number>();

  // Add semantic scores
  semanticResults.forEach((result, rank) => {
    const id = String(result._id);
    scoreMap.set(id, (scoreMap.get(id) || 0) + 1 / (k + rank + 1));
  });

  // Add keyword scores
  keywordResults.forEach((result, rank) => {
    const id = String(result._id);
    scoreMap.set(id, (scoreMap.get(id) || 0) + 1 / (k + rank + 1));
  });

  // Sort by fused score
  return Array.from(scoreMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, score }));
}
```

---

### ✅ 2. Reranking

**Check:**

- [ ] Reranking model applied to top results
- [ ] Cross-encoder used (better than bi-encoder)
- [ ] Query-document pairs scored

**Reranking with Cohere:**

```typescript
import { CohereClient } from 'cohere-ai';

const cohere = new CohereClient({ token: process.env.COHERE_API_KEY });

const reranked = await cohere.rerank({
  model: 'rerank-english-v3.0',
  query: userQuery,
  documents: results.map((r) => r.content),
  topN: 10,
});

const rerankedResults = reranked.results.map((r) => results[r.index]);
```

---

## Checklist: Text-to-SQL

### ✅ 1. Schema Quality

**Check:**

- [ ] Table descriptions present and accurate
- [ ] Column descriptions present for embeddable columns
- [ ] Sample rows representative of data
- [ ] Statistics calculated (min, max, avg, cardinality)

**Improve Schema:**

```typescript
// During ingestion, add rich descriptions
{
  tableName: 'orders',
  description: 'Customer order records with product details, pricing, and status tracking',
  columns: [
    {
      name: 'order_total',
      type: 'decimal',
      description: 'Total order amount in USD including tax and shipping',
      isEmbeddable: true,
      isFilterable: true
    },
    {
      name: 'status',
      type: 'enum',
      description: 'Order status: pending, processing, shipped, delivered, cancelled',
      enumValues: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
      isEmbeddable: true,
      isFilterable: true
    }
  ]
}
```

---

### ✅ 2. SQL Generation Quality

**Check:**

- [ ] Generated SQL is valid
- [ ] Tenant isolation enforced in WHERE clause
- [ ] JOINs use correct foreign keys
- [ ] Aggregations use correct functions
- [ ] Date/time filtering correct

**Test SQL Generation:**

```typescript
const textToSQL = new TextToSQLService(llmProvider);

const sql = await textToSQL.generateSQL({
  query: 'Show me total sales by product category last month',
  tables: [ordersSchema, productsSchema],
  tenantId,
  indexId,
});

console.log('Generated SQL:', sql);

// Validate manually:
// 1. Has tenant_id and index_id filters?
// 2. Uses correct JOIN keys?
// 3. Date range correct?
```

---

### ✅ 3. Query Validation

**Check:**

- [ ] No dangerous operations (DROP, DELETE, TRUNCATE)
- [ ] No table creation or schema changes
- [ ] Query timeout enforced (10s default)
- [ ] Row limit enforced (1000 default)

**Security Validation:**

```typescript
function validateSQL(sql: string): void {
  const forbidden = ['DROP', 'DELETE', 'TRUNCATE', 'ALTER', 'CREATE', 'INSERT', 'UPDATE'];
  const upper = sql.toUpperCase();

  for (const keyword of forbidden) {
    if (upper.includes(keyword)) {
      throw new Error(`Forbidden SQL keyword: ${keyword}`);
    }
  }

  // Ensure tenant isolation
  if (!upper.includes('TENANT_ID =')) {
    throw new Error('Missing tenant isolation in WHERE clause');
  }
}
```

---

### ✅ 4. Table Discovery

**Check:**

- [ ] Keyword matching on table names
- [ ] Description matching
- [ ] Foreign key awareness (related tables)
- [ ] Relevance scoring

**Improve Discovery:**

```typescript
// Add keywords to table metadata
{
  tableName: 'orders',
  displayName: 'Order History',
  description: 'Customer purchases, transactions, sales records, invoices',
  keywords: ['order', 'purchase', 'transaction', 'sale', 'invoice', 'payment'],
  searchableText: 'orders order history customer purchases transactions sales records invoices'
}
```

---

## Checklist: Path-Based Queries (Nested JSON)

### ✅ 1. Path Index Coverage

**Check:**

- [ ] All nested JSON objects have paths extracted
- [ ] Path index table populated in ClickHouse
- [ ] Path normalization correct (array indices → `[]`)
- [ ] Parent-child relationships tracked

**Verify:**

```sql
-- Check path coverage
SELECT
  object_id,
  COUNT(*) as path_count,
  MAX(depth) as max_depth
FROM json_path_index
WHERE tenant_id = ? AND index_id = ?
GROUP BY object_id;

-- Should have many paths per object (10-200+)
```

---

### ✅ 2. Path Query Performance

**Check:**

- [ ] Exact path queries <10ms
- [ ] Pattern queries <30ms
- [ ] Keyword queries <50ms
- [ ] Indexes on `path_normalized` and `path_tokens`

**Optimize:**

```sql
-- Create indexes
CREATE INDEX path_normalized_idx ON json_path_index (tenant_id, index_id, path_normalized, object_id);
CREATE INDEX path_tokens_idx ON json_path_index (tenant_id, index_id, path_tokens);
```

---

### ✅ 3. Path Query Patterns

**Check:**

- [ ] Exact path queries work (`profile.email`)
- [ ] Wildcard patterns work (`%.email`)
- [ ] Array patterns work (`users[].name`)
- [ ] Value filters work (`WHERE value_number > 100`)

**Test Patterns:**

```typescript
// Exact
queryPathsByPattern(tenantId, indexId, 'profile.email', 100);

// Wildcard
queryPathsByPattern(tenantId, indexId, '%.email', 100);

// Array
queryPathsByPattern(tenantId, indexId, 'users[].name', 100);

// Value filter
queryPathsByValue(tenantId, indexId, 'price', '>', 100);
```

---

## Performance Tuning

### ✅ Vector Search Performance

**Target:** <100ms for top 10 results

**Optimize:**

1. **Increase `numCandidates`** (accuracy vs speed tradeoff)

   ```typescript
   {
     numCandidates: 100;
   } // Fast but less accurate
   {
     numCandidates: 500;
   } // Slower but more accurate
   ```

2. **Use pre-filtering** (filter → vector search)

   ```typescript
   // Good: Filter first, then vector search
   const results = await vectorSearch({
     filter: { tenantId, indexId, chunkType: 'page' },
     vector: queryEmbedding,
     limit: 10,
   });
   ```

3. **Batch queries** (multiple queries in parallel)
   ```typescript
   const [semanticResults, keywordResults] = await Promise.all([
     vectorSearch(query),
     textSearch(query),
   ]);
   ```

---

### ✅ SQL Query Performance

**Target:** <50ms for single table, <200ms for 2-table JOIN

**Optimize:**

1. **Add WHERE filters early**

   ```sql
   -- Good: Filter before JOIN
   SELECT * FROM orders o
   WHERE o.tenant_id = ? AND o.created_at > '2023-01-01'
   INNER JOIN users u ON o.user_id = u.id
   ```

2. **Use LIMIT**

   ```sql
   SELECT * FROM orders
   WHERE tenant_id = ? AND index_id = ?
   LIMIT 1000;
   ```

3. **Index frequently filtered columns**
   ```sql
   CREATE INDEX status_idx ON structured_data (tenant_id, index_id, table_id, JSON_EXTRACT(row_data, '$.status'));
   ```

---

### ✅ Caching Strategy

**Check:**

- [ ] Frequent queries cached (Redis)
- [ ] Cache keys include tenant + index
- [ ] TTL set appropriately (5-60 minutes)
- [ ] Cache invalidation on data changes

**Implement:**

```typescript
async function cachedVectorSearch(query: string, tenantId: string, indexId: string) {
  const cacheKey = `search:${tenantId}:${indexId}:${hash(query)}`;

  // Check cache
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Execute search
  const results = await vectorSearch(query, tenantId, indexId);

  // Cache results (5 minute TTL)
  await redis.set(cacheKey, JSON.stringify(results), 'EX', 300);

  return results;
}
```

---

## Quality Metrics

### ✅ Track Retrieval Quality

**Metrics to Monitor:**

| Metric                         | Target | Notes                                 |
| ------------------------------ | ------ | ------------------------------------- |
| **Precision@10**               | >0.8   | % of top 10 results that are relevant |
| **Recall@10**                  | >0.6   | % of relevant docs in top 10          |
| **MRR (Mean Reciprocal Rank)** | >0.7   | Average rank of first relevant result |
| **Query Latency (p95)**        | <100ms | 95th percentile response time         |
| **Cache Hit Rate**             | >70%   | % of queries served from cache        |
| **Empty Result Rate**          | <5%    | % of queries with 0 results           |

**Measure:**

```typescript
interface RetrievalMetrics {
  query: string;
  resultsCount: number;
  latencyMs: number;
  topResults: Array<{ chunkId: string; score: number }>;
  cacheHit: boolean;
}

async function logRetrievalMetrics(query: string, results: SearchResult[], latency: number) {
  await db.collection('retrieval_metrics').insertOne({
    query,
    resultsCount: results.length,
    latencyMs: latency,
    topResults: results.slice(0, 10).map((r) => ({ chunkId: r._id, score: r.score })),
    timestamp: new Date(),
  });
}
```

---

## Troubleshooting

### Issue: Query Returns No Results

**Diagnosis:**

1. Check if documents/chunks exist for tenant/index
2. Verify embeddings generated
3. Test with simpler query
4. Check for typos in table names (for SQL)

**Fix:**

- Re-run embedding worker if embeddings missing
- Check index LLM config (summarization, vision enabled?)
- Verify vector search index created in MongoDB Atlas

---

### Issue: Irrelevant Results Ranking High

**Diagnosis:**

1. Check chunk quality (too large? mid-sentence splits?)
2. Check if progressive summaries present
3. Test with hybrid search (semantic + keyword)

**Fix:**

- Re-chunk with smaller target size (512 tokens)
- Enable progressive summarization
- Use reranking model to improve top results

---

### Issue: Slow Query Performance

**Diagnosis:**

1. Check query latency breakdown (vector search, SQL, reranking)
2. Check `numCandidates` setting (too high?)
3. Check for missing indexes

**Fix:**

- Reduce `numCandidates` for faster vector search
- Add ClickHouse indexes for frequently filtered columns
- Enable caching for repeated queries

---

## Related Documentation

- [Documents Guide](./01-documents-pdf-docx.md) - Chunking strategy for documents
- [CSV Guide](./02-structured-csv.md) - Text-to-SQL optimization
- [JSON Nested Guide](./03-structured-json-nested.md) - Path-based queries
- [Architecture Overview](./10-architecture-overview.md) - System architecture

---

## Summary

**Retrieval quality comes from:**

1. ✅ **High-quality embeddings** (full context, summaries, visual insights)
2. ✅ **Optimal chunk size** (512 tokens, sentence-aligned)
3. ✅ **Rich metadata** (descriptions, sample rows, statistics)
4. ✅ **Hybrid search** (semantic + keyword fusion)
5. ✅ **Reranking** (cross-encoder for top results)
6. ✅ **Query routing** (detect intent, route to best strategy)

**Performance comes from:**

1. ✅ **Efficient indexes** (vector, text, ClickHouse)
2. ✅ **Caching** (Redis, content-addressed)
3. ✅ **Batching** (parallel queries, bulk operations)
4. ✅ **Filtering** (tenant isolation at query level)

**Monitor quality continuously** with metrics and user feedback.

---

**End of Documentation** 🎉
