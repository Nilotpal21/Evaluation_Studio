# Reranker Batch Performance Tuning Guide (RFC-003 Phase 2.4)

## Overview

The batched reranker automatically adjusts configuration based on observed workload patterns to optimize throughput, latency, and cost.

## Performance Characteristics

### Workload Classification

| Workload     | Requests/Sec | Batch Size | Wait Time | Cache Size | TTL |
| ------------ | ------------ | ---------- | --------- | ---------- | --- |
| **Idle**     | < 5          | 25         | 20ms      | 250        | 3s  |
| **Low**      | 5-25         | 50         | 30ms      | 500        | 5s  |
| **Moderate** | 25-75        | 100        | 50ms      | 1000       | 5s  |
| **High**     | 75-150       | 150        | 60ms      | 2000       | 7s  |
| **Peak**     | > 150        | 200        | 75ms      | 5000       | 10s |

### Tuning Principles

1. **High Traffic → Larger Batches**
   - When utilization > 80%: Increase `maxBatchSize` by 1.5x
   - Benefits: Higher throughput, better API call reduction
   - Trade-off: Slightly higher latency (+10-20ms)

2. **Low Traffic → Smaller Batches, Shorter Wait**
   - When utilization < 30%: Decrease `maxBatchSize` and `maxWaitMs` by 30%
   - Benefits: Lower latency (-20%), faster responses
   - Trade-off: Lower API call reduction

3. **High Cache Hit Rate → Larger Cache**
   - When hit rate > 60%: Double `cacheMaxSize` (up to 5000)
   - Benefits: Even higher hit rate, fewer API calls
   - Trade-off: Higher memory usage (~2MB per 1000 entries)

4. **Low Cache Hit Rate → Smaller Cache**
   - When hit rate < 10%: Halve `cacheMaxSize` and `deduplicationTTL`
   - Benefits: Lower memory overhead
   - Trade-off: Minimal impact (cache wasn't helping anyway)

5. **High Wait Time → Shorter Timeout**
   - When avgWaitMs > 80ms and utilization < 50%: Reduce `maxWaitMs` by 30%
   - Benefits: Lower latency (-30%), faster responses
   - Trade-off: Smaller batch sizes, fewer API call savings

## Configuration Parameters

### `maxBatchSize` (default: 100)

Number of requests pooled into a single API call.

**When to increase:**

- High traffic (> 100 req/s)
- High batch utilization (> 80%)
- Want maximum API call reduction

**When to decrease:**

- Low traffic (< 20 req/s)
- Latency is too high
- Memory pressure

**Limits:**

- Min: 25 (ensure some batching benefit)
- Max: 200 (provider API limits, memory)

### `maxWaitMs` (default: 50ms)

Maximum time to wait for batch to fill before executing.

**When to increase:**

- Very bursty traffic (want to catch more requests)
- Latency is not critical
- Want higher batch sizes

**When to decrease:**

- Low latency requirements (< 100ms total)
- Low traffic (batches rarely fill)
- Users complaining about slow responses

**Limits:**

- Min: 20ms (balance batching vs latency)
- Max: 100ms (never wait too long)

### `cacheMaxSize` (default: 1000)

Maximum number of cached request/response pairs.

**When to increase:**

- High cache hit rate (> 60%)
- Repetitive query patterns
- Memory is available (~2MB per 1000 entries)

**When to decrease:**

- Low cache hit rate (< 10%)
- Memory pressure
- Queries are always unique

**Limits:**

- Min: 250 (minimum benefit)
- Max: 5000 (memory limit ~10MB)

### `deduplicationTTL` (default: 5000ms)

How long to cache responses before expiring.

**When to increase:**

- High cache hit rate
- Queries repeat over longer periods
- Want more API call reduction

**When to decrease:**

- Results change frequently
- Low cache hit rate
- Memory pressure

**Limits:**

- Min: 2000ms (too short to be useful)
- Max: 10000ms (results may become stale)

### `maxRequestAgeMs` (default: 5000ms)

Maximum time a request can wait in queue before being rejected.

**When to decrease:**

- Strict latency requirements
- Want to fail fast

**When to increase:**

- During high traffic spikes
- Want to process all requests (even if slow)

**Limits:**

- Min: 3000ms
- Max: 10000ms

## Monitoring Metrics

### Key Performance Indicators

1. **Call Reduction** (target: > 80%)
   - Formula: `1 - (actualAPICalls / estimatedAPICalls)`
   - Measures API cost savings from batching

2. **Batch Utilization** (target: 40-80%)
   - Formula: `avgBatchSize / maxBatchSize`
   - Too low: Increase `maxWaitMs` or decrease `maxBatchSize`
   - Too high: Increase `maxBatchSize`

3. **Average Batch Wait Time** (target: < 60ms)
   - Time requests spend in queue before batch executes
   - Too high: Decrease `maxWaitMs` or increase `maxBatchSize`

4. **Cache Hit Rate** (target: > 20%)
   - Formula: `cacheHits / (cacheHits + cacheMisses)`
   - Below 10%: Consider disabling cache or reducing size
   - Above 60%: Increase cache size

5. **Stalled Requests** (target: 0)
   - Requests waiting > `maxRequestAgeMs`
   - If > 0: Increase `maxRequestAgeMs` or add more capacity

## Tuning Workflow

### 1. Observe (5-10 minutes)

Monitor batch statistics to understand workload:

```typescript
const stats = batchedRerankerFactory.getBatchStats();
console.log({
  requestsPerSec: stats.totalRequests / observationWindowSec,
  batchUtilization: stats.batchUtilization,
  cacheHitRate: stats.cacheHitRate,
  avgWaitMs: stats.avgBatchWaitMs,
  callReduction: stats.callReduction,
});
```

### 2. Analyze

Use the performance tuner to get recommendations:

```typescript
const tuner = new BatchPerformanceTuner();
tuner.recordStats(stats);

// Wait for observation window (5 minutes)
setTimeout(() => {
  const recommendations = tuner.getTuningRecommendations(currentConfig);
  console.log(recommendations);
}, 300000);
```

### 3. Apply

Apply high-priority recommendations:

```typescript
const tunedConfig = tuner.applyRecommendations(currentConfig, recommendations);
```

### 4. Measure

Compare before/after metrics over 10 minutes:

- Throughput improvement
- Latency impact
- Cost reduction
- Error rate

### 5. Iterate

Repeat every 1-2 hours during high traffic, daily during stable periods.

## Common Scenarios

### Scenario 1: High Traffic Spike (100 → 500 req/s)

**Symptoms:**

- Batch utilization > 90%
- Stalled requests increasing
- High latency

**Solution:**

```typescript
config = {
  maxBatchSize: 200, // Increase capacity
  maxWaitMs: 75, // Allow larger batches
  cacheMaxSize: 5000, // More deduplication
  maxRequestAgeMs: 7000, // Tolerate longer waits
};
```

**Expected Results:**

- Call reduction: 85% → 95%
- Latency: +20ms (acceptable during spike)
- Throughput: 500 req/s sustained

### Scenario 2: Low Latency Required (< 100ms total)

**Symptoms:**

- Users complaining about slow responses
- Average wait time > 50ms

**Solution:**

```typescript
config = {
  maxBatchSize: 50, // Smaller batches execute faster
  maxWaitMs: 20, // Minimal wait
  cacheMaxSize: 1000, // Standard cache
  deduplicationTTL: 5000,
};
```

**Expected Results:**

- Latency: 150ms → 80ms (70ms improvement)
- Call reduction: 90% → 70% (still good savings)

### Scenario 3: Repetitive Queries (High Cache Potential)

**Symptoms:**

- Cache hit rate > 60%
- Same queries repeated frequently

**Solution:**

```typescript
config = {
  maxBatchSize: 100,
  maxWaitMs: 50,
  cacheMaxSize: 5000, // Large cache
  deduplicationTTL: 10000, // Long TTL
};
```

**Expected Results:**

- Cache hit rate: 60% → 80%
- API calls: Further 50% reduction from cache
- Total savings: 95% API call reduction

### Scenario 4: Unique Queries (Low Cache Value)

**Symptoms:**

- Cache hit rate < 5%
- Queries are always different

**Solution:**

```typescript
config = {
  maxBatchSize: 100,
  maxWaitMs: 50,
  deduplicate: false, // Disable cache
  cacheMaxSize: 0,
  deduplicationTTL: 0,
};
```

**Expected Results:**

- Memory savings: ~5MB freed
- No performance impact (cache wasn't helping)
- Simpler system, less overhead

## Troubleshooting

### Problem: Low Call Reduction (< 50%)

**Possible Causes:**

- Batch size too small for traffic
- Wait time too short (batches execute before filling)
- Traffic is too bursty/irregular

**Solutions:**

1. Increase `maxBatchSize` by 50%
2. Increase `maxWaitMs` to 60-75ms
3. Enable caching if repetitive queries
4. Check if traffic is actually batching-friendly (concurrent requests?)

### Problem: High Latency (> 200ms)

**Possible Causes:**

- Wait time too long
- Batch execution is slow (provider latency)
- Queues are backing up

**Solutions:**

1. Decrease `maxWaitMs` to 30ms
2. Check provider latency (should be < 150ms)
3. Increase `maxBatchSize` to drain queues faster
4. Monitor `stalledRequests` - if > 0, system is overloaded

### Problem: Stalled Requests

**Causes:**

- Traffic exceeds capacity
- Batch execution is too slow
- Requests timing out in queue

**Solutions:**

1. Increase `maxRequestAgeMs` (short-term)
2. Increase `maxBatchSize` to process more per batch
3. Add more reranker provider capacity
4. Consider horizontal scaling (multiple runtime instances)

## Best Practices

1. **Start with defaults** - Only tune after observing real workload
2. **Change one parameter at a time** - Easier to understand impact
3. **Observe for 5-10 minutes** - Short-term spikes don't represent steady state
4. **Prioritize correctness over performance** - Never compromise tenant isolation for speed
5. **Monitor continuously** - Workload changes over time
6. **Document changes** - Track what was changed and why
7. **Have rollback plan** - Keep previous config, can revert instantly

## Performance Testing

### Load Test Scenarios

1. **Steady Load** (100 req/s for 10 minutes)
   - Validates stable performance
   - Measures sustained throughput

2. **Burst Load** (0 → 500 req/s spike for 30 seconds)
   - Tests queue capacity
   - Measures latency under stress

3. **Repetitive Queries** (Same 10 queries repeated)
   - Validates cache effectiveness
   - Measures maximum call reduction

4. **Unique Queries** (Random queries, no repeats)
   - Tests worst-case performance
   - Validates no cache overhead

### Metrics to Collect

- p50, p95, p99 latency
- Throughput (req/s)
- API call reduction (%)
- Cache hit rate (%)
- Error rate (%)
- Memory usage (MB)
- CPU usage (%)

## Summary

| Optimize For           | Configuration Strategy                                            |
| ---------------------- | ----------------------------------------------------------------- |
| **Maximum Throughput** | Large batch size (150-200), longer wait (60-75ms), large cache    |
| **Minimum Latency**    | Small batch size (25-50), short wait (20-30ms), standard cache    |
| **Cost Reduction**     | Maximum batch size (200), enable caching, longer TTL              |
| **Memory Efficiency**  | Smaller cache (500-1000), shorter TTL (3-5s), moderate batch size |

**Remember**: The "best" configuration depends on your specific workload. Monitor, analyze, tune, and iterate!
