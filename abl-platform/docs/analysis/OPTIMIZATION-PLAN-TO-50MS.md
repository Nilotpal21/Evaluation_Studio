# Optimization Plan: Non-Embedding Time to 50ms

**Current State**: 111ms average (30-249ms range)  
**Goal**: 50ms (55% reduction)  
**Gap to Close**: 61ms

---

## Current Breakdown (REAL MEASURED)

```
Component              Current Time    Goal      Reduction Needed
─────────────────────────────────────────────────────────────────
OpenSearch Query       55ms (49%)      25ms      -30ms (55%)
Question→Parent        19ms (17%)      0ms       -19ms (100%)
HTTP/Other Overhead    32ms (29%)      20ms      -12ms (38%)
DSL Building           6ms (5%)        5ms       -1ms (17%)
─────────────────────────────────────────────────────────────────
TOTAL                  111ms           50ms      -61ms (55%)
```

---

## Optimization #1: Cache Collection Name Resolution ⭐⭐⭐

### Problem

**Current**: MongoDB query on EVERY request to resolve indexId → OpenSearch collection name.

**Code Location**: `query-pipeline.ts:2163-2190`

```typescript
// Called on EVERY query
const collectionName = await this.resolveCollectionName(query.indexId);

private async resolveCollectionName(indexId: string): Promise<string> {
  // Step 1: MongoDB query to SearchIndex
  const searchIndex = await SearchIndex.findOne({ _id: indexId })
    .select('activeVectorIndex')
    .lean();

  // Step 2: If not found, MongoDB query to IndexRegistry
  const entry = await IndexRegistry.findOne({
    appId: indexId,
    status: 'active',
  })
}
```

**Cost**:

- MongoDB query: 5-15ms (network + query)
- Called on EVERY query
- Completely cacheable (collection name rarely changes)

### Solution

Add in-memory LRU cache with 5-minute TTL:

```typescript
import { LRUCache } from 'lru-cache';

// Add to QueryPipeline class
private collectionNameCache = new LRUCache<string, string>({
  max: 500,  // Cache 500 KBs
  ttl: 1000 * 60 * 5,  // 5 minute TTL
  updateAgeOnGet: true,
});

private async resolveCollectionName(indexId: string): Promise<string> {
  // Check cache first
  const cached = this.collectionNameCache.get(indexId);
  if (cached) {
    return cached;
  }

  // Cache miss - do the expensive lookup
  const collectionName = await this.resolveCollectionNameFromDB(indexId);
  this.collectionNameCache.set(indexId, collectionName);
  return collectionName;
}

private async resolveCollectionNameFromDB(indexId: string): Promise<string> {
  // Existing MongoDB query logic
  // ...
}
```

**Expected Savings**: **10-15ms** (90% cache hit rate)

**Effort**: 30 minutes

**Risk**: Low (cache invalidation on index updates needed)

---

## Optimization #2: Disable Question→Parent Resolution ⭐⭐⭐

### Problem

**Current**: Every query does 2-pass processing:

1. Main search (returns questions + content)
2. Bulk fetch parent chunks from OpenSearch (19ms average)
3. Merge pass to replace questions with parents

**Cost**: 19ms average (0-43ms range)

**Code Location**: `query-pipeline.ts:2314-2397`

```typescript
// Called on EVERY query, even when no questions exist
results = await this.resolveQuestionsToParents(results, collectionName);
```

### Solution Options

#### Option A: Disable Question Vectors Entirely (Recommended)

**Pros**:

- **Saves 19ms** (100% of question→parent time)
- **Saves ~30ms** in OpenSearch (no need to query question vectors)
- Simpler search results
- No dedup complexity

**Cons**:

- Slightly lower recall for question-style queries
- One-time reindex needed (remove question vectors)

**Implementation**:

```typescript
// In ingestion pipeline - stop generating question vectors
const ENABLE_QUESTION_VECTORS = false; // Feature flag

if (ENABLE_QUESTION_VECTORS) {
  // Generate and index question vectors
}
```

**Expected Savings**: **19ms + 30ms OpenSearch** = **49ms total**

---

#### Option B: Skip Resolution When No Questions Detected

**Pros**:

- No behavior change for existing data
- Still gets savings when no questions match

**Cons**:

- Only saves time when no questions matched (60% of queries)
- Still pays 19ms on 40% of queries

**Implementation**:

```typescript
// Check if ANY result has a question before doing bulk fetch
const hasQuestions = results.some((r) => (r.metadata as any)?.sys?.questionId);
if (!hasQuestions) {
  return results; // Early return - skip bulk fetch
}
// ... rest of logic
```

**Expected Savings**: **11ms average** (60% of queries have no questions)

---

**Recommendation**: **Option A** - Disable question vectors entirely. They add 49ms with marginal recall benefit.

---

## Optimization #3: Reduce OpenSearch Query Time ⭐⭐

### Problem

**Current**: OpenSearch queries take 38-102ms (average 55ms).

**Target**: 25ms

**Components**:

1. Network latency: 2-5ms (localhost)
2. OpenSearch internal execution: 20-30ms (from `response.body.took`)
3. Result deserialization: 5-10ms

### Sub-Optimization 3A: Use Bulk Multi-Get for Hybrid RRF

**Problem**: Hybrid queries run 2 separate OpenSearch queries + client-side RRF fusion.

**Current Flow**:

```typescript
// Execute kNN and BM25 separately
const [knnResult, bm25Result] = await Promise.all([
  this.vectorStore.executeQuery(collectionName, knnDsl), // 50ms
  this.vectorStore.executeQuery(collectionName, bm25Dsl), // 45ms
]);
// Total: 50ms (parallel) + fusion overhead
```

**Cost**: 94ms average for hybrid (vs 54ms for semantic)

**Solution**: Use OpenSearch native hybrid search instead of client-side RRF.

**Code Location**: `query-pipeline.ts:1043-1212`

**Expected Savings**: **20-30ms** for hybrid queries (40% faster)

**Effort**: 2-3 days (requires OpenSearch 2.11+ and testing)

---

### Sub-Optimization 3B: Reduce OpenSearch `size` Parameter

**Problem**: Over-fetching due to question→parent dedup buffer.

**Current**:

```typescript
const QUESTION_DEDUP_BUFFER = 5;
const baseLimit = query.topK ?? 20;
const dslBody = await this.hybridSearchBuilder.buildQueryFromResolution(..., {
  limit: baseLimit + QUESTION_DEDUP_BUFFER,  // Fetches 25 instead of 20
});
```

**If question vectors are disabled**: Remove the +5 buffer entirely.

**Expected Savings**: **2-5ms** (smaller result set to deserialize)

---

### Sub-Optimization 3C: Optimize OpenSearch Mappings

**Current Mappings**: Check if `_source` includes unnecessary fields.

**Solution**: Use `_source` filtering to fetch only needed fields:

```typescript
const dslBody = {
  query: { ... },
  size: baseLimit,
  _source: [
    'content',
    'embedding',  // Only needed for reranking
    'metadata.sys',
    'metadata.doc',
    // Exclude large fields like 'metadata.raw'
  ],
};
```

**Expected Savings**: **3-8ms** (less data over network + faster JSON parse)

---

## Optimization #4: Reduce HTTP/Overhead ⭐

### Problem

**Current**: 32ms overhead (HTTP request/response + JSON serialization)

**Components**:

1. Express middleware chain: 5-10ms
2. JSON serialization: 3-5ms
3. Network: 2-5ms
4. Metrics/logging: 5-10ms

### Sub-Optimization 4A: Lazy Metrics Writing

**Problem**: Synchronous ClickHouse write on every request.

**Current**:

```typescript
// At end of request
await queryMetricsStore.recordQuery({...});  // Blocks response
```

**Solution**: Fire-and-forget with background queue.

```typescript
// Non-blocking
queryMetricsStore.recordQueryAsync({...});  // Returns immediately

// Background worker flushes every 1s
```

**Expected Savings**: **5-10ms**

---

### Sub-Optimization 4B: Stream Response

**Problem**: Buffering full result set before sending response.

**Solution**: Stream results as they're processed (minimal benefit for small result sets).

**Expected Savings**: **2-5ms**

---

## Optimization #5: DSL Building Optimization ⭐

### Problem

**Current**: 6ms average for DSL building (3-22ms range).

**Analysis**: Q1 took 22ms (cold start), others 3-8ms.

### Solution: Pre-compile DSL Templates

**Current**: Builds DSL object from scratch every time.

**Solution**: Use template objects and shallow-copy with spread operator.

```typescript
// Pre-compiled templates
const SEMANTIC_QUERY_TEMPLATE = {
  knn: {
    vector: {
      field: 'embedding',
      k: 20,
      // ... other static fields
    },
  },
};

// Fast path
const dslBody = {
  ...SEMANTIC_QUERY_TEMPLATE,
  knn: {
    ...SEMANTIC_QUERY_TEMPLATE.knn,
    vector: {
      ...SEMANTIC_QUERY_TEMPLATE.knn.vector,
      vector: precomputedEmbedding, // Only dynamic field
      k: query.topK,
    },
  },
};
```

**Expected Savings**: **2-4ms**

---

## Optimization Summary Table

| Optimization                    | Current | Target | Savings     | Effort  | Priority |
| ------------------------------- | ------- | ------ | ----------- | ------- | -------- |
| **1. Cache collection name**    | 10-15ms | 0ms    | **10-15ms** | 30min   | ⭐⭐⭐   |
| **2. Disable question vectors** | 49ms    | 0ms    | **49ms**    | 1 day   | ⭐⭐⭐   |
| **3A. Native hybrid search**    | 94ms    | 65ms   | **29ms**    | 3 days  | ⭐⭐     |
| **3B. Remove dedup buffer**     | 2-5ms   | 0ms    | **3ms**     | 10min   | ⭐       |
| **3C. Optimize \_source**       | 3-8ms   | 0ms    | **5ms**     | 1 hour  | ⭐⭐     |
| **4A. Async metrics**           | 5-10ms  | 0ms    | **8ms**     | 2 hours | ⭐⭐     |
| **4B. Stream response**         | 2-5ms   | 0ms    | **3ms**     | 4 hours | ⭐       |
| **5. DSL templates**            | 6ms     | 3ms    | **3ms**     | 2 hours | ⭐       |
| **TOTAL SAVINGS**               |         |        | **110ms**   |         |          |

---

## Implementation Phases

### Phase 1: Quick Wins (1 day, 28ms savings)

1. ✅ **Cache collection name** (30 min) → **-12ms**
2. ✅ **Remove dedup buffer** (10 min) → **-3ms**
3. ✅ **Async metrics** (2 hours) → **-8ms**
4. ✅ **Optimize \_source** (1 hour) → **-5ms**

**Result after Phase 1**: 111ms → **83ms** (25% improvement)

---

### Phase 2: Major Impact (1 day, 49ms savings)

5. ✅ **Disable question vectors** (1 day) → **-49ms**

**Result after Phase 2**: 83ms → **34ms** ✅ **GOAL ACHIEVED!**

---

### Phase 3: Polish (4 days, 35ms savings)

6. ⏳ **Native hybrid search** (3 days) → **-29ms**
7. ⏳ **Stream response** (4 hours) → **-3ms**
8. ⏳ **DSL templates** (2 hours) → **-3ms**

**Result after Phase 3**: 34ms → **<5ms** 🚀

---

## Code Changes Required

### 1. Collection Name Cache

**File**: `apps/search-ai-runtime/src/services/query/query-pipeline.ts`

**Add to imports**:

```typescript
import { LRUCache } from 'lru-cache';
```

**Add to class**:

```typescript
private collectionNameCache = new LRUCache<string, string>({
  max: 500,
  ttl: 1000 * 60 * 5,
  updateAgeOnGet: true,
});
```

**Wrap existing method**:

```typescript
private async resolveCollectionName(indexId: string): Promise<string> {
  const cached = this.collectionNameCache.get(indexId);
  if (cached) return cached;

  const name = await this.resolveCollectionNameUncached(indexId);
  this.collectionNameCache.set(indexId, name);
  return name;
}

private async resolveCollectionNameUncached(indexId: string): Promise<string> {
  // Move existing resolveCollectionName logic here
}
```

---

### 2. Disable Question Vectors

**File**: `packages/search-ai-internal/src/chunking/question-generator.ts`

**Add feature flag**:

```typescript
const ENABLE_QUESTION_VECTORS = process.env.ENABLE_QUESTION_VECTORS === 'true';

export async function generateQuestions(chunk: Chunk): Promise<Question[]> {
  if (!ENABLE_QUESTION_VECTORS) {
    return []; // Skip question generation
  }
  // ... existing logic
}
```

**File**: `apps/search-ai-runtime/src/services/query/query-pipeline.ts`

**Skip resolution when disabled**:

```typescript
// After search execution
if (process.env.ENABLE_QUESTION_VECTORS === 'true') {
  results = await this.resolveQuestionsToParents(results, collectionName);
}
```

---

### 3. Optimize \_source

**File**: `apps/search-ai-runtime/src/services/hybrid-search/hybrid-search-builder.ts`

**Add to DSL**:

```typescript
const dslBody = {
  query: { ... },
  size: limit,
  _source: {
    includes: [
      'content',
      'metadata.sys.*',
      'metadata.doc.*',
    ],
    excludes: [
      'metadata.raw',
      'metadata.debug',
    ],
  },
};
```

---

### 4. Async Metrics

**File**: `apps/search-ai-runtime/src/services/metrics/query-metrics.ts`

**Add async method**:

```typescript
private metricsQueue: QueryMetrics[] = [];
private flushInterval: NodeJS.Timeout;

constructor() {
  // Flush every 1 second
  this.flushInterval = setInterval(() => this.flush(), 1000);
}

recordQueryAsync(metrics: QueryMetrics): void {
  this.metricsQueue.push(metrics);
  if (this.metricsQueue.length > 100) {
    this.flush();  // Flush early if queue is large
  }
}

private async flush(): Promise<void> {
  if (this.metricsQueue.length === 0) return;

  const batch = this.metricsQueue.splice(0, this.metricsQueue.length);
  try {
    await clickhouse.insert({ table: 'search_queries', values: batch });
  } catch (error) {
    logger.error('Failed to flush metrics', error);
  }
}
```

**In query-pipeline.ts**:

```typescript
// Change from await to fire-and-forget
queryMetricsStore.recordQueryAsync(metrics);
```

---

## Verification Plan

### Test Harness

**Before Changes**:

```bash
npx tsx tools/unique-queries-benchmark.ts
# Record baseline: 111ms average non-embedding time
```

**After Each Phase**:

```bash
npx tsx tools/unique-queries-benchmark.ts
# Verify improvement and no regressions
```

### Success Criteria

- [ ] Phase 1: Non-embedding time ≤ 85ms
- [ ] Phase 2: Non-embedding time ≤ 50ms ✅ **GOAL**
- [ ] Phase 3: Non-embedding time ≤ 10ms 🚀

### Regression Tests

- [ ] All 20 queries return same result count
- [ ] Relevance scores remain within 5% of baseline
- [ ] No increase in error rate
- [ ] Memory usage stable

---

## Risk Assessment

### High Risk (Requires Careful Testing)

1. **Disable question vectors** - Affects recall, needs A/B test
2. **Native hybrid search** - OpenSearch 2.11+ dependency

### Medium Risk

1. **Collection name cache** - Need cache invalidation strategy
2. **Async metrics** - Risk of data loss if process crashes

### Low Risk

1. **Optimize \_source** - Pure performance win
2. **Remove dedup buffer** - Only needed with question vectors
3. **DSL templates** - Pure refactor

---

## Rollout Strategy

### Phase 1 (Safe, Fast Wins)

1. Deploy with feature flags OFF
2. Test in staging for 1 day
3. Deploy to prod
4. Monitor for 1 day
5. If stable → Phase 2

### Phase 2 (Question Vectors)

1. Add feature flag: `ENABLE_QUESTION_VECTORS=false`
2. Deploy to 10% of traffic (canary)
3. Monitor recall metrics for 2 days
4. If acceptable → 50% traffic
5. If acceptable → 100% traffic
6. Run reindex job to remove question vectors

### Phase 3 (Polish)

1. Implement native hybrid search
2. Test extensively in staging
3. Deploy with feature flag
4. Gradual rollout

---

## Monitoring

### Key Metrics

```typescript
// Add to every query response
{
  latency: {
    embeddingMs: 350,
    opensearchMs: 25,      // Target < 25ms
    questionParentMs: 0,   // Target 0ms
    dslBuildMs: 3,         // Target < 5ms
    overheadMs: 20,        // Target < 20ms
    totalNonEmbedding: 48, // Target < 50ms ✅
  }
}
```

### Alerts

- Alert if `totalNonEmbedding > 75ms` for 5 minutes
- Alert if `opensearchMs > 40ms` for 5 minutes
- Alert if cache hit rate < 80%

---

## Expected Final State

### After All Optimizations

```
Component              Current    After Phase 2    After Phase 3
─────────────────────────────────────────────────────────────────
OpenSearch Query       55ms       25ms             15ms
Question→Parent        19ms       0ms ✅           0ms ✅
HTTP/Other             32ms       15ms             5ms
DSL Building           6ms        3ms              2ms
─────────────────────────────────────────────────────────────────
TOTAL                  111ms      43ms ✅          22ms 🚀
```

**Goal: 50ms** → **Achieved in Phase 2** ✅

**Stretch Goal: <25ms** → **Achieved in Phase 3** 🚀

---

## Summary

**Current non-embedding time**: 111ms  
**Goal**: 50ms  
**Path to achieve**:

1. Phase 1 (Quick wins): 111ms → 83ms
2. Phase 2 (Disable questions): 83ms → **34ms** ✅ **GOAL ACHIEVED**
3. Phase 3 (Polish): 34ms → 5ms 🚀

**Total effort**: 6 days  
**Biggest impact**: Disabling question vectors (**-49ms**, 44% of total)  
**Quick wins**: Collection cache + \_source optimization (**-17ms**, 1.5 hours)
