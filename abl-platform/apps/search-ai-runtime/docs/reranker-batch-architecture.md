# Reranker Batch Processing Architecture (RFC-003 Phase 2.3)

## Problem Statement

Current implementation sends one HTTP request per query to reranking providers. Under load, this creates:

- **High latency**: Network round-trip per query
- **API rate limits**: Hitting provider rate limits with many concurrent queries
- **Wasted capacity**: Multiple small requests instead of fewer large batches
- **Higher costs**: Some providers charge per API call, not per document

## Solution: Batch Processing with Request Pooling

Aggregate multiple concurrent rerank requests into batched API calls while maintaining per-query response isolation.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Query Pipeline                               │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐                 │
│  │Query1│  │Query2│  │Query3│  │Query4│  │Query5│                 │
│  └───┬──┘  └───┬──┘  └───┬──┘  └───┬──┘  └───┬──┘                 │
│      │         │         │         │         │                      │
│      └─────────┴─────────┴─────────┴─────────┘                      │
│                        │                                             │
└────────────────────────┼─────────────────────────────────────────────┘
                         │
                         ▼
         ┌───────────────────────────────┐
         │   BatchedRerankerFactory      │
         │  (Replaces RerankerFactory)   │
         └───────────┬───────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
        ▼                         ▼
┌────────────────┐       ┌────────────────┐
│  Request Queue │       │ Request Cache  │
│  (In-memory)   │       │ (Deduplication)│
└───────┬────────┘       └────────────────┘
        │
        ▼
┌────────────────────────┐
│  Batch Aggregator      │
│  - Collect for 50ms    │
│  - Max 100 requests    │
│  - Per-provider queue  │
└───────┬────────────────┘
        │
        ▼
┌────────────────────────┐
│  Batch Executor        │
│  - Create batch query  │
│  - Single HTTP call    │
│  - Timeout handling    │
└───────┬────────────────┘
        │
        ▼
┌────────────────────────┐
│ Response Distributor   │
│ - Parse batch response │
│ - Map to original reqs │
│ - Resolve promises     │
└────────────────────────┘
        │
        ▼
    Results back to
    individual queries
```

---

## Component Design

### 1. BatchedRerankerFactory

**Purpose**: Drop-in replacement for `RerankerFactory` with batching support.

**Interface**:

```typescript
interface BatchConfig {
  enabled: boolean; // Enable/disable batching
  maxBatchSize: number; // Max requests per batch (default: 100)
  maxWaitMs: number; // Max wait time to fill batch (default: 50ms)
  deduplicate: boolean; // Cache identical queries (default: true)
  deduplicationTTL: number; // Cache TTL in ms (default: 5000ms)
}

class BatchedRerankerFactory {
  constructor(config: BatchConfig);

  // Same interface as RerankerFactory
  async rerank(request: RerankRequest): Promise<RerankResponse | null>;

  // New methods
  getBatchStats(): BatchStats;
  flushBatches(): Promise<void>;
}
```

**Key Responsibilities**:

- Accept rerank requests and return promises immediately
- Queue requests in per-provider batches
- Trigger batch execution based on time or size thresholds
- Handle provider failover for batched requests

---

### 2. BatchQueue

**Purpose**: Hold pending requests until batch is ready to execute.

**Data Structure**:

```typescript
interface QueuedRequest {
  id: string; // Unique request ID
  request: RerankRequest; // Original request
  provider: string; // Target provider
  timestamp: number; // Queue entry time
  resolve: (response: RerankResponse) => void;
  reject: (error: Error) => void;
}

class BatchQueue {
  private queues: Map<string, QueuedRequest[]>; // Per-provider queues

  enqueue(provider: string, request: QueuedRequest): void;
  dequeue(provider: string, count: number): QueuedRequest[];
  size(provider: string): number;
  clear(provider: string): void;
}
```

**Behavior**:

- Separate queue per provider (Voyage, Cohere, Jina)
- FIFO ordering within each queue
- Automatic expiration for stale requests (>5s in queue)

---

### 3. BatchAggregator

**Purpose**: Decide when to execute a batch based on size and time thresholds.

**Algorithm**:

```typescript
class BatchAggregator {
  private config: BatchConfig;
  private timers: Map<string, NodeJS.Timeout>;

  async processBatch(provider: string): Promise<void> {
    const batch = this.queue.dequeue(provider, this.config.maxBatchSize);

    if (batch.length === 0) return;

    // Combine documents from all requests
    const combinedDocuments = this.combineRequests(batch);

    // Execute single batch API call
    const batchResponse = await this.executor.executeBatch(
      provider,
      batch[0].request.query, // Use first query (should be same for batch)
      combinedDocuments,
    );

    // Distribute results back to individual requests
    this.distributor.distribute(batch, batchResponse);
  }

  private combineRequests(batch: QueuedRequest[]): Document[] {
    // Flatten all documents with tracking metadata
    const combined = [];
    const offsets = [0];

    for (const req of batch) {
      combined.push(...req.request.documents);
      offsets.push(combined.length);
    }

    return { documents: combined, offsets };
  }
}
```

**Triggering Logic**:

1. **Time-based**: Flush batch after `maxWaitMs` (default: 50ms)
2. **Size-based**: Flush immediately when `maxBatchSize` reached (default: 100)
3. **On-demand**: Flush on shutdown or explicit `flushBatches()` call

---

### 4. BatchExecutor

**Purpose**: Execute the batched API call to the provider.

**Responsibilities**:

- Create batch request with combined documents
- Handle provider-specific batch formats
- Apply timeouts and retries
- Return structured batch response

**Provider-Specific Batching**:

```typescript
// Voyage API: Supports batching natively
POST /v1/rerank
{
  "model": "rerank-1",
  "query": "Python tutorial",
  "documents": ["doc1", "doc2", ..., "doc100"], // Up to 1000 docs
  "top_k": 100
}

// Cohere API: Supports batching
POST /v1/rerank
{
  "model": "rerank-english-v3.0",
  "query": "Python tutorial",
  "documents": ["doc1", "doc2", ..., "doc100"], // Up to 10K docs
  "top_n": 100
}

// Jina API: Supports batching with objects
POST /v1/rerank
{
  "model": "jina-reranker-v2-base-multilingual",
  "query": "Python tutorial",
  "documents": [
    {"index": 0, "text": "doc1"},
    {"index": 1, "text": "doc2"},
    ...
  ]
}
```

---

### 5. ResponseDistributor

**Purpose**: Map batch response back to individual requests.

**Algorithm**:

```typescript
class ResponseDistributor {
  distribute(batch: QueuedRequest[], batchResponse: RerankResponse, offsets: number[]): void {
    for (let i = 0; i < batch.length; i++) {
      const req = batch[i];
      const startIdx = offsets[i];
      const endIdx = offsets[i + 1];

      // Extract results for this specific request
      const requestResults = batchResponse.results
        .filter((result) => result.index >= startIdx && result.index < endIdx)
        .map((result) => ({
          ...result,
          index: result.index - startIdx, // Renormalize to request-local index
        }));

      // Resolve the promise with request-specific results
      req.resolve({
        results: requestResults,
        provider: batchResponse.provider,
        model: batchResponse.model,
        latencyMs: batchResponse.latencyMs,
        cost: this.calculateRequestCost(req, batchResponse.cost),
      });
    }
  }

  private calculateRequestCost(req: QueuedRequest, totalCost: number): number {
    // Prorate cost based on document count
    const totalDocs = this.getTotalDocCount(batch);
    const reqDocs = req.request.documents.length;
    return totalCost * (reqDocs / totalDocs);
  }
}
```

**Key Challenges**:

- Index mapping: Batch results use global indices, need to map to per-request indices
- Cost attribution: Split batch cost proportionally by document count
- Error handling: If batch fails, reject all promises with appropriate errors

---

### 6. RequestCache (Deduplication)

**Purpose**: Cache identical queries to avoid redundant reranking.

**Design**:

```typescript
interface CacheEntry {
  response: RerankResponse;
  timestamp: number;
  hitCount: number;
}

class RequestCache {
  private cache: Map<string, CacheEntry>;
  private ttl: number;

  get(query: string, documents: string[]): RerankResponse | null {
    const key = this.computeKey(query, documents);
    const entry = this.cache.get(key);

    if (!entry || Date.now() - entry.timestamp > this.ttl) {
      return null;
    }

    entry.hitCount++;
    return entry.response;
  }

  set(query: string, documents: string[], response: RerankResponse): void {
    const key = this.computeKey(query, documents);
    this.cache.set(key, {
      response,
      timestamp: Date.now(),
      hitCount: 0,
    });
  }

  private computeKey(query: string, documents: string[]): string {
    // Hash query + sorted document hashes for stable key
    const docHash = crypto
      .createHash('sha256')
      .update(documents.sort().join('|'))
      .digest('hex')
      .slice(0, 16);

    const queryHash = crypto.createHash('sha256').update(query).digest('hex').slice(0, 16);

    return `${queryHash}:${docHash}`;
  }
}
```

**Cache Invalidation**:

- Time-based: TTL of 5 seconds (short-lived cache for concurrent queries)
- Size-based: LRU eviction after 1000 entries
- Manual: Clear on provider failover

---

## Performance Characteristics

### Without Batching (Current)

- **Latency**: ~150ms per query (network round-trip)
- **Throughput**: ~50 queries/sec (limited by sequential processing)
- **API Calls**: 1 call per query
- **Cost**: Full cost per query

### With Batching (Optimized)

- **Latency**: 50ms (batching delay) + 150ms (single batch call) = **200ms worst case**
- **Throughput**: ~500 queries/sec (10x improvement from batching)
- **API Calls**: 1 call per 10-100 queries (90-99% reduction)
- **Cost**: Same total cost, but fewer API transactions

### Cache Hit Rate (Deduplication)

- **Typical workload**: 5-15% duplicate queries within 5s window
- **Burst scenarios**: Up to 30% duplicates (same query, different users)
- **Latency for cache hits**: ~1ms (in-memory lookup)

---

## Configuration

### Default Configuration

```typescript
const DEFAULT_BATCH_CONFIG: BatchConfig = {
  enabled: true,
  maxBatchSize: 100, // Max 100 requests per batch
  maxWaitMs: 50, // Wait up to 50ms to fill batch
  deduplicate: true, // Enable cache
  deduplicationTTL: 5000, // 5 second cache TTL
};
```

### Environment Variables

```bash
# Batching
RERANKER_BATCH_ENABLED=true
RERANKER_BATCH_SIZE=100
RERANKER_BATCH_WAIT_MS=50

# Deduplication
RERANKER_CACHE_ENABLED=true
RERANKER_CACHE_TTL_MS=5000
RERANKER_CACHE_MAX_SIZE=1000
```

---

## Metrics & Observability

### New Metrics

```typescript
interface BatchStats {
  // Batching effectiveness
  totalRequests: number;
  batchedRequests: number;
  batchCount: number;
  avgBatchSize: number;
  batchUtilization: number; // % of maxBatchSize used

  // Cache performance
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;

  // Latency breakdown
  avgBatchWaitMs: number;
  avgBatchExecutionMs: number;
  avgTotalLatencyMs: number;

  // Cost savings
  estimatedAPICalls: number; // Without batching
  actualAPICalls: number; // With batching
  callReduction: number; // % reduction
}
```

### Prometheus Metrics

```
# Batch size histogram
reranker_batch_size{provider="voyage"}

# Batch wait time histogram
reranker_batch_wait_ms{provider="voyage"}

# Cache hit rate
reranker_cache_hit_rate

# API call reduction
reranker_api_calls_saved_total{provider="voyage"}
```

---

## Migration Strategy

### Phase 1: Parallel Testing (Week 1)

- Deploy `BatchedRerankerFactory` alongside existing `RerankerFactory`
- Route 10% of traffic through batched path
- Compare latency, throughput, error rates
- Verify correctness of batch result distribution

### Phase 2: Gradual Rollout (Week 2)

- Increase to 50% traffic
- Monitor for any issues under load
- Tune batch size and wait time based on metrics

### Phase 3: Full Migration (Week 3)

- Route 100% of traffic through batched path
- Remove old `RerankerFactory` code
- Update documentation

### Rollback Plan

- Feature flag: `RERANKER_BATCH_ENABLED=false` to disable instantly
- Fallback: Old `RerankerFactory` code remains in codebase during migration
- Monitoring: Alert if batch latency exceeds 200ms P95

---

## Error Handling

### Batch-Level Errors

- **Timeout**: If batch API call times out, reject all requests in batch
- **Rate limit**: Split batch and retry smaller batches with exponential backoff
- **Provider error**: Fall back to next provider for entire batch

### Request-Level Errors

- **Invalid input**: Reject individual request without affecting batch
- **Stale request**: Remove from batch if queued >5s

### Circuit Breaker

- Track batch failure rate per provider
- Open circuit after 3 consecutive batch failures
- Fall back to next provider automatically

---

## Testing Strategy

### Unit Tests

- `BatchQueue`: Enqueue, dequeue, expiration
- `BatchAggregator`: Batch triggering logic (size, time)
- `ResponseDistributor`: Index mapping, cost attribution
- `RequestCache`: Cache hits, misses, TTL expiration

### Integration Tests

- End-to-end batch flow with mock provider
- Concurrent requests batching together
- Cache deduplication under load
- Provider failover with batching

### Load Tests

- 1000 concurrent requests → verify batching
- Measure P50, P95, P99 latency
- Verify no memory leaks from queue growth
- Test under provider rate limit conditions

---

## Open Questions

1. **Query similarity**: Should we batch requests with different queries, or only same query?
   - **Recommendation**: Same query only initially, expand later if needed

2. **Priority queuing**: Should some queries bypass batching for low latency?
   - **Recommendation**: Add `urgent: boolean` flag to skip batching

3. **Cross-provider batching**: Should we batch across providers during failover?
   - **Recommendation**: No - keep separate queues per provider

4. **Dynamic tuning**: Should batch size/wait time auto-adjust based on load?
   - **Recommendation**: Start with static config, add dynamic tuning in Phase 3

---

## Success Criteria

- ✅ **Throughput**: 10x improvement (50 → 500 queries/sec)
- ✅ **API calls**: 90% reduction under load
- ✅ **Latency**: P95 < 200ms (acceptable trade-off)
- ✅ **Cache hit rate**: >10% for typical workloads
- ✅ **Correctness**: 100% match between batched and non-batched results
- ✅ **No memory leaks**: Bounded queue growth under all conditions
