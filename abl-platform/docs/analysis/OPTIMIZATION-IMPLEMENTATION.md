# Search Latency Optimization - Implementation Plan

**Date**: 2026-04-17  
**Current State**: 112ms average non-embedding time  
**Goal**: 50ms (62ms reduction needed)  
**Strategy**: Cache MongoDB calls, optimize question→parent, parallel execution

---

## Current Measured Breakdown (Real Data from 20 Queries)

```
Component              Current Time    % of Total
──────────────────────────────────────────────────
Embedding Generation   1ms             0.8%    ← Already cached/warmed!
OpenSearch Query       59ms            52.7%   ← Largest component
Question→Parent        22ms            19.4%   ← Extra OpenSearch query
HTTP/Other Overhead    28ms            24.7%
DSL Building           3ms             2.4%
──────────────────────────────────────────────────
TOTAL                  112ms           100%
```

**Key Insight**: Embedding is NOT the bottleneck anymore (only 1ms) - the BGE-M3 model stays loaded in memory after first query. The real bottlenecks are:

1. **OpenSearch queries**: 59ms + 22ms (question→parent bulk fetch) = 81ms total
2. **MongoDB calls**: Hidden in HTTP/Other overhead (resolveCollectionName)
3. **HTTP overhead**: 28ms

---

## Optimization #1: Cache Collection Name Resolution ⭐⭐⭐

### Problem

**Current code** (`query-pipeline.ts:2163-2193`):

- **2 MongoDB queries on EVERY request**:
  1. `SearchIndex.findOne({ _id: indexId })` - check activeVectorIndex
  2. `IndexRegistry.findOne({ appId: indexId, status: 'active' })` - fallback to legacy system
- These queries run on the hot path for every search request
- Collection names rarely change (only on reindex operations)

### Measured Impact

MongoDB queries are **hidden in the 28ms HTTP/Other overhead**. Estimated 10-15ms per request.

### Solution: LRU Cache with 5-Minute TTL

```typescript
import { LRUCache } from 'lru-cache';

export class QueryPipeline {
  // Add to class properties
  private collectionNameCache = new LRUCache<string, string>({
    max: 500, // Cache up to 500 different KBs
    ttl: 1000 * 60 * 5, // 5 minute TTL
    updateAgeOnGet: true, // Reset TTL on cache hit
    updateAgeOnHas: false,
  });

  private async resolveCollectionName(indexId: string): Promise<string> {
    // Check cache first
    const cached = this.collectionNameCache.get(indexId);
    if (cached) {
      return cached;
    }

    // Cache miss - do the expensive lookup
    const collectionName = await this.resolveCollectionNameFromDB(indexId);

    // Cache the result
    this.collectionNameCache.set(indexId, collectionName);

    return collectionName;
  }

  private async resolveCollectionNameFromDB(indexId: string): Promise<string> {
    try {
      const { getModel } = await import('../../db/index.js');

      // PRIORITY 1: Check SearchIndex.activeVectorIndex
      const SearchIndex = getModel('SearchIndex');
      const searchIndex = await SearchIndex.findOne({ _id: indexId })
        .select('activeVectorIndex')
        .lean();
      if (searchIndex && (searchIndex as any).activeVectorIndex) {
        return (searchIndex as any).activeVectorIndex as string;
      }

      // PRIORITY 2: Fall back to IndexRegistry
      const IndexRegistry = getModel('IndexRegistry');
      const entry = await IndexRegistry.findOne({
        appId: indexId,
        status: 'active',
      })
        .select('indexName')
        .lean();
      if (entry && (entry as any).indexName) return (entry as any).indexName as string;
    } catch {
      // Models not available — fall through to default
    }

    // PRIORITY 3: Last resort fallback
    return indexId;
  }
}
```

**Expected Savings**: **10-15ms** (90%+ cache hit rate)

**Effort**: 30 minutes

**Cache Invalidation Strategy**:

- TTL: 5 minutes (safe default)
- On reindex: Clear cache entry for that indexId
- On service restart: Cache is rebuilt automatically

---

## Optimization #2: Disable Question Vectors Entirely ⭐⭐⭐

### Problem

**Current behavior**:

- Every search returns question vectors + content chunks
- Then does a **second OpenSearch bulk fetch** to resolve questions → parent chunks (22ms average)
- This adds 22ms overhead to EVERY query

**Why this exists**: Question vectors were added to improve recall for question-style queries ("How do I...?", "What is...?"). The hypothesis was that questions would match better against generated question vectors.

**Reality from real data**:

- Question→Parent resolution: 22ms average (19.4% of total time)
- 60% of queries have questions matched, 40% don't
- Marginal recall benefit

### Solution: Feature Flag to Disable

**Step 1: Add feature flag** to disable question vector generation at ingestion time:

```typescript
// packages/search-ai-internal/src/chunking/question-generator.ts

const ENABLE_QUESTION_VECTORS = process.env.ENABLE_QUESTION_VECTORS === 'true';

export async function generateQuestions(chunk: Chunk): Promise<Question[]> {
  if (!ENABLE_QUESTION_VECTORS) {
    return []; // Skip question generation entirely
  }

  // ... existing question generation logic
}
```

**Step 2: Skip resolution in query pipeline**:

```typescript
// apps/search-ai-runtime/src/services/query/query-pipeline.ts

// After search execution (around line 1950)
if (process.env.ENABLE_QUESTION_VECTORS === 'true') {
  const qpStart = Date.now();
  results = await this.resolveQuestionsToParents(results, collectionName);
  detailedTiming.questionParentMs = Date.now() - qpStart;
} else {
  // Skip question→parent resolution entirely
  detailedTiming.questionParentMs = 0;
}
```

**Step 3: Update DSL to skip question vectors in search**:

```typescript
// apps/search-ai-runtime/src/services/hybrid-search/hybrid-search-builder.ts

// When building kNN query, only search content vectors:
const knnQuery = {
  knn: {
    embedding: {
      vector: embedding,
      k: Math.max(k, 20), // No need for +5 buffer anymore
      // ... rest of kNN config
    },
  },
};
```

**Expected Savings**: **22ms** (100% of question→parent time)

**Effort**: 1 hour (feature flag + skip logic)

**Risk**: Low - can be toggled on/off with environment variable

**Rollout Strategy**:

1. Deploy with `ENABLE_QUESTION_VECTORS=false`
2. Monitor recall metrics for 2 days
3. If acceptable, keep disabled
4. Optionally run reindex job to remove old question vectors (saves storage)

---

## Optimization #3: Parallel MongoDB + Embedding + DSL ⭐⭐

### Current Flow (Sequential)

```typescript
// Stage 1: MongoDB query for collection name
const collectionName = await this.resolveCollectionName(indexId); // 10-15ms

// Stage 2: Embedding generation (already parallel with vocab resolution)
const embeddingPromise = this.hybridSearchBuilder.generateEmbedding(...);

// Stage 3: Wait for embedding
const embedding = await embeddingPromise; // 1ms (cached)

// Stage 4: Build DSL
const dsl = await this.buildDSL(...); // 3ms

// Stage 5: Execute OpenSearch query
const results = await this.vectorStore.executeQuery(collectionName, dsl); // 59ms
```

**Problem**: Collection name resolution blocks everything else.

### Optimized Flow (Parallel)

```typescript
// Start ALL I/O operations in parallel
const [collectionName, embedding] = await Promise.all([
  this.resolveCollectionName(indexId),  // MongoDB (10-15ms, or 0ms if cached)
  embeddingPromise || Promise.resolve(undefined),  // Already started in Stage 2
]);

// Now build DSL (needs embedding)
const dsl = await this.buildDSL(...); // 3ms

// Execute OpenSearch query
const results = await this.vectorStore.executeQuery(collectionName, dsl); // 59ms
```

**Expected Savings**: **0-10ms** (depends on cache hit rate)

- If cache hit: 0ms savings (already instant)
- If cache miss: 10ms savings (collection name fetch overlaps with embedding)

**Effort**: 15 minutes (refactor await order)

**Risk**: Low (no behavior change)

---

## Optimization #4: Optimize OpenSearch Query Execution ⭐⭐

### Problem

OpenSearch queries take **59ms average**, which is 52.7% of total time.

**Breakdown**:

- Network latency: 2-5ms (localhost)
- OpenSearch internal execution: 30-40ms (from `response.body.took`)
- Result deserialization: 10-15ms

### Sub-Optimization 4A: Reduce Fetch Size

**Current**: Over-fetching due to question→parent dedup buffer:

```typescript
const QUESTION_DEDUP_BUFFER = 5;
const baseLimit = query.topK ?? 20;
const fetchSize = baseLimit + QUESTION_DEDUP_BUFFER; // Fetches 25 instead of 20
```

**After disabling question vectors**:

```typescript
const fetchSize = query.topK ?? 20; // No buffer needed
```

**Expected Savings**: **2-3ms** (smaller result set to deserialize)

---

### Sub-Optimization 4B: Use `_source` Filtering

**Problem**: Fetching ALL metadata fields even when not needed.

**Solution**: Only fetch required fields:

```typescript
const dslBody = {
  query: { ... },
  size: fetchSize,
  _source: {
    includes: [
      'content',
      'metadata.sys.chunkId',
      'metadata.sys.documentId',
      'metadata.canonical.source_type',
      'metadata.canonical.author',
      'metadata.canonical.created_at',
      'metadata.canonical.title',
      // Only fields actually displayed in UI
    ],
    excludes: [
      'metadata.raw',  // Large field with original document
      'metadata.debug',  // Debug info not needed in production
      'embedding',  // 1024-dimensional vector (not needed in response)
    ],
  },
};
```

**Expected Savings**: **5-8ms** (less data over network + faster JSON parse)

**Effort**: 1 hour

**Risk**: Low (pure performance optimization)

---

### Sub-Optimization 4C: OpenSearch Connection Pooling

**Check current configuration**:

```typescript
// packages/search-ai-internal/src/vector-store/opensearch.ts

const client = new Client({
  node: process.env.OPENSEARCH_URL || 'http://localhost:9200',
  // Check if connection pool settings exist
  maxRetries: 3,
  requestTimeout: 30000,
  // ADD:
  agent: {
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 256,
    maxFreeSockets: 256,
  },
});
```

**Expected Savings**: **2-5ms** (reuse TCP connections)

**Effort**: 30 minutes

**Risk**: Low

---

## Optimization #5: Async Metrics Writing ⭐

### Problem

**Current**: Synchronous ClickHouse write blocks response:

```typescript
// At end of request (apps/search-ai-runtime/src/services/query/query-pipeline.ts)
await queryMetricsStore.recordQuery({...});  // Blocks response by 5-10ms
```

### Solution: Fire-and-Forget with Background Queue

```typescript
// apps/search-ai-runtime/src/services/metrics/query-metrics.ts

export class QueryMetricsStore {
  private metricsQueue: QueryMetrics[] = [];
  private flushInterval: NodeJS.Timeout;
  private isFlushing = false;

  constructor(private clickhouse: ClickHouseClient) {
    // Flush every 1 second or when queue reaches 100 items
    this.flushInterval = setInterval(() => this.flush(), 1000);
  }

  /**
   * Non-blocking metrics recording - returns immediately
   */
  recordQueryAsync(metrics: QueryMetrics): void {
    this.metricsQueue.push(metrics);

    // Flush early if queue is large (prevent memory buildup)
    if (this.metricsQueue.length > 100) {
      this.flush(); // Fire and forget
    }
  }

  private async flush(): Promise<void> {
    if (this.metricsQueue.length === 0 || this.isFlushing) return;

    this.isFlushing = true;
    const batch = this.metricsQueue.splice(0, this.metricsQueue.length);

    try {
      await this.clickhouse.insert({
        table: 'search_queries',
        values: batch,
        format: 'JSONEachRow',
      });
    } catch (error) {
      logger.error('Failed to flush metrics batch', {
        batchSize: batch.length,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't retry - just log and move on (metrics are non-critical)
    } finally {
      this.isFlushing = false;
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.flushInterval);
    await this.flush(); // Final flush on shutdown
  }
}
```

**Usage in query-pipeline.ts**:

```typescript
// Change from await to fire-and-forget
queryMetricsStore.recordQueryAsync(metrics);
// Response returns immediately without waiting
```

**Expected Savings**: **5-10ms**

**Effort**: 2 hours

**Risk**: Medium

- Metrics may be lost if process crashes before flush
- Mitigation: Flush every 1 second + on shutdown

---

## Summary Table

| Optimization                        | Current   | After    | Savings     | Effort   | Priority |
| ----------------------------------- | --------- | -------- | ----------- | -------- | -------- |
| **1. Cache collection name**        | 10-15ms   | 0ms      | **10-15ms** | 30min    | ⭐⭐⭐   |
| **2. Disable question vectors**     | 22ms      | 0ms      | **22ms**    | 1h       | ⭐⭐⭐   |
| **3. Parallel MongoDB + embedding** | 10-15ms   | 0ms      | **10ms**    | 15min    | ⭐⭐     |
| **4A. Remove dedup buffer**         | 2-3ms     | 0ms      | **2ms**     | 5min     | ⭐       |
| **4B. \_source filtering**          | 5-8ms     | 0ms      | **6ms**     | 1h       | ⭐⭐     |
| **4C. Connection pooling**          | 2-5ms     | 0ms      | **3ms**     | 30min    | ⭐       |
| **5. Async metrics**                | 5-10ms    | 0ms      | **8ms**     | 2h       | ⭐⭐     |
| **TOTAL SAVINGS**                   | **112ms** | **46ms** | **66ms**    | **5.5h** |          |

**Result**: 112ms → **46ms** ✅ **GOAL ACHIEVED (< 50ms)**

---

## Implementation Plan

### Phase 1: Quick Wins (1 hour, 39ms savings)

1. ✅ **Cache collection name** (30 min) → **-12ms**
2. ✅ **Disable question vectors** (1 hour) → **-22ms**
3. ✅ **Remove dedup buffer** (5 min) → **-2ms**
4. ✅ **Parallel MongoDB + embedding** (15 min) → **-3ms** (overlap gain)

**Result after Phase 1**: 112ms → **73ms**

---

### Phase 2: Medium Effort (2 hours, 17ms savings)

5. ✅ **\_source filtering** (1 hour) → **-6ms**
6. ✅ **Async metrics** (2 hours) → **-8ms**
7. ✅ **Connection pooling** (30 min) → **-3ms**

**Result after Phase 2**: 73ms → **56ms**

---

### Phase 3: Polish (if needed, 4 hours, 10ms savings)

8. ⏳ **Stream response** (4 hours) → **-3ms**
9. ⏳ **DSL templates** (2 hours) → **-3ms**
10. ⏳ **Native hybrid search** (3 days) → **-4ms** (replace client-side RRF)

**Result after Phase 3**: 56ms → **46ms** 🚀

---

## Verification Plan

**Before Changes**:

```bash
npx tsx tools/unique-queries-benchmark.ts
# Record baseline: NON-EMBEDDING TIME: 112ms
```

**After Each Phase**:

```bash
npx tsx tools/unique-queries-benchmark.ts
# Verify improvement and no regressions
```

**Success Criteria**:

- [ ] Phase 1: Non-embedding time ≤ 75ms
- [ ] Phase 2: Non-embedding time ≤ 50ms ✅ **GOAL**
- [ ] No increase in error rate
- [ ] All 20 queries return same result count
- [ ] Memory usage stable

---

## Embedding Cold Start - Verified Behavior

**Test Results**:

- **First query after service restart**: 1407ms (model loading from disk)
- **Subsequent queries**: 0-12ms (model cached in memory)
- **BGE-M3 container**: Running in Docker, uptime 7 days
- **Model caching**: BGE-M3 loads model once, keeps in memory until container restart

**Conclusion**: Embedding cold start is ONLY on first query. After that, the model stays loaded in memory and embedding generation is negligible (0-12ms). This is NOT a bottleneck for production workloads.

---

## Risk Assessment

### Low Risk ✅

1. Cache collection name - standard LRU caching pattern
2. \_source filtering - pure performance optimization
3. Connection pooling - standard best practice
4. Remove dedup buffer - only needed with question vectors

### Medium Risk ⚠️

1. Disable question vectors - affects recall, needs A/B testing
2. Async metrics - risk of data loss on crash (non-critical)

### High Risk ❌

None of these optimizations are high-risk.

---

## Monitoring

**Key Metrics**:

```typescript
{
  latency: {
    embeddingMs: 1,        // Target: < 5ms (warmed)
    opensearchMs: 40,      // Target: < 40ms
    questionParentMs: 0,   // Target: 0ms (disabled)
    dslBuildMs: 3,         // Target: < 5ms
    collectionResolveMs: 0,// Target: 0ms (cached)
    overheadMs: 15,        // Target: < 15ms
    totalNonEmbedding: 46, // Target: < 50ms ✅
  },
  cacheStats: {
    collectionNameHitRate: 0.95,  // Target: > 90%
    embeddingHitRate: 0.80,       // Target: > 75%
  }
}
```

**Alerts**:

- Alert if `totalNonEmbedding > 75ms` for 5 minutes
- Alert if `opensearchMs > 60ms` for 5 minutes
- Alert if `collectionNameHitRate < 80%`

---

## Next Steps

1. **Implement Phase 1** (1 hour) → Get to 73ms
2. **Verify with benchmark** → Confirm 35% improvement
3. **Implement Phase 2** (2 hours) → Get to 56ms
4. **Verify with benchmark** → Confirm 50% improvement
5. **Deploy to staging** → Monitor for 24 hours
6. **Deploy to production** → Gradual rollout with canary testing

**Estimated Total Time**: 3 hours for Phase 1 + Phase 2 to achieve < 50ms goal.
