# BullMQ Flows Production Guide for SearchAI

**Date:** 2026-03-04
**Status:** Living Document
**Audience:** Backend Engineers, SRE, Platform Team
**Related:** RFC-004 (Pluggable Pipelines), RFC-005 (Job Tracking), RFC-006 (Flows Integration)

---

## Table of Contents

1. [Purpose](#purpose)
2. [How BullMQ Flows Work Internally](#how-bullmq-flows-work-internally)
3. [Known Issues & Bugs](#known-issues--bugs)
4. [Scaling Challenges: Heavy I/O](#scaling-challenges-heavy-io)
5. [Scaling Challenges: CPU-Intensive](#scaling-challenges-cpu-intensive)
6. [Redis Constraints](#redis-constraints)
7. [Distributed Environment Challenges](#distributed-environment-challenges)
8. [SearchAI-Specific Configuration](#searchai-specific-configuration)
9. [Anti-Patterns](#anti-patterns)
10. [Production Checklist](#production-checklist)
11. [Monitoring & Alerting](#monitoring--alerting)
12. [Troubleshooting Runbook](#troubleshooting-runbook)

---

## Purpose

This guide documents known production challenges, scaling constraints, and recommended configurations for running BullMQ Flows in SearchAI's distributed pipeline. It supplements the RFCs with operational knowledge gathered from BullMQ's issue tracker, production deployments, and SearchAI's specific workload characteristics.

**SearchAI Pipeline Workload:**

```
Upload → Ingestion → Extraction → Page Processing → Canonical Map →
Enrichment → [KG | Multimodal | Embedding] → Cleanup
```

- 20+ queues, 17+ worker types
- Mix of CPU-intensive (extraction) and I/O-bound (LLM calls, embedding)
- Target: 10K–100K documents/day
- Multi-tenant with per-tenant LLM rate limits

---

## How BullMQ Flows Work Internally

### Architecture: Shared Queues + Parent Tracking

BullMQ Flows use **existing shared queues** for all flow instances. Each document's flow creates regular jobs in shared queues, with Redis metadata tracking parent-child relationships.

```
1000 documents → 1000 flow parents in Redis
              → All create jobs in SAME "enrichment-queue"
              → Redis tracks parent-child via parentKey
              → Workers process jobs without knowing about flows
```

### Flow Lifecycle

```
1. FlowProducer.add(flow)
   → Creates parent job in Redis (status: waiting-children)
   → Creates child jobs in their respective queues
   → Each child stores parentKey metadata

2. Worker picks up child job from shared queue
   → Processes job (business logic unchanged)
   → Marks job complete

3. BullMQ internal hook on child completion
   → Checks child's parentKey
   → Notifies parent: "child X completed"
   → Checks: all children done?
     → YES: Creates next stage jobs OR marks parent complete
     → NO: Continues waiting

4. Flow completes when all stages finish
```

### Key Insight: Workers Are Flow-Unaware

Workers process jobs from shared queues without any knowledge of flows. The flow orchestration is entirely in BullMQ's Redis Lua scripts. Worker code does not change when introducing flows.

### Queue Naming: Shared, Not Per-Flow

```
✅ CORRECT: All flows share the same queues
  Queue: "search-enrichment"
  ├── job-1 (doc-A, parent: flow-001)
  ├── job-2 (doc-B, parent: flow-002)
  └── job-3 (doc-C, parent: flow-003)

❌ WRONG: Separate queues per flow (don't do this)
  Queue: "search-enrichment-doc-A"
  Queue: "search-enrichment-doc-B"
```

### PipelineFlowBuilder Pattern

Callers do NOT manually construct nested flow structures. A builder reads pipeline definitions from the database and generates the flow tree automatically:

```typescript
// Caller code (simple)
const pipeline = await PipelineDefinition.findOne({ indexId });
const flowJobId = await flowBuilder.buildFlow(pipeline, { documentId, tenantId });

// Builder internally generates:
{
  name: 'doc-A-pipeline',
  queueName: 'search-extraction',
  data: { documentId, pipelineId, pipelineVersion },
  children: [
    { name: 'enrichment', queueName: 'search-enrichment', children: [...] }
  ]
}
```

---

## Known Issues & Bugs

### CRITICAL: Parent Stuck in `waiting-children` Forever

**The #1 most reported issue with BullMQ Flows.**

When a child job fails, by default the parent does NOT fail or continue. It waits forever for the failed child to succeed.

**GitHub Issues:** #3362, #3122, #2464, #800

**Root Cause:** BullMQ requires explicit configuration of child failure behavior. The default behavior (no option set) means the parent waits indefinitely.

**MANDATORY: Set one of these on every child job:**

```typescript
// Option A: Fail the entire flow if any child fails (RECOMMENDED for SearchAI)
childOpts: {
  failParentOnFailure: true;
}

// Option B: Continue the flow even if this child fails
childOpts: {
  ignoreDependencyOnFailure: true;
}

// Option C: Remove the dependency (parent stops waiting for this child)
childOpts: {
  removeDependencyOnFailure: true;
}

// ❌ DEFAULT (no option): Parent waits FOREVER
```

**SearchAI recommendation:** Use `failParentOnFailure: true` on all pipeline children. A failed extraction means embedding is pointless — fail the whole flow, track the error in JobExecution, and let the user retry.

---

### CRITICAL: FlowProducer.add() Fails Silently

**GitHub Issue:** #3851 (OPEN, March 2026)

`FlowProducer.add()` does not throw when Redis operations fail (e.g., during managed Redis READONLY maintenance windows). Jobs appear created but never actually exist.

**Impact:** Zombie flows — system believes pipeline started, but no jobs exist.

**Mitigation:**

```typescript
async function safeAddFlow(
  flowProducer: FlowProducer,
  flow: FlowJob,
  parentQueueName: string,
): Promise<JobNode> {
  const result = await flowProducer.add(flow);

  // Verify the parent job actually exists in Redis
  const parentQueue = new Queue(parentQueueName, { connection });
  const job = await parentQueue.getJob(result.job.id);

  if (!job) {
    throw new Error(
      `Flow creation failed silently for ${flow.name}. ` + 'Redis may be in READONLY mode.',
    );
  }

  return result;
}
```

---

### HIGH: Stalled Jobs Don't Fail Parents

**GitHub Issue:** #2464 (Fixed in v5.7.2)

When a child job stalls (lock expires because event loop was blocked), the parent is NOT notified — even with `failParentOnFailure: true`.

**Impact:** Flow permanently stuck. Stalled child retried, but parent never learns.

**Mitigation:**

- Ensure BullMQ version >= 5.7.2
- Set `lockDuration` longer than expected job duration (see per-worker settings below)
- Use `maxStalledCount: 2` to mark job failed after 2 stalls instead of infinite retries

---

### HIGH: Duplicate Flow Race Condition

**GitHub Issue:** #1099 (OPEN since Feb 2022)

When adding a flow with the same `jobId` as an existing flow, a race condition creates inconsistent Redis state.

**Mitigation:** Deduplicate before creating flows:

```typescript
// Check MongoDB contentHash before creating flow
const existing = await SearchDocument.findOne({ indexId, contentHash });
if (existing && existing.status !== 'error') {
  return; // Already processing or processed
}
```

---

### MEDIUM: Flow Cleanup Keys Accumulate

**GitHub Issue:** #1572

Flow `*:processed` tracking keys in Redis accumulate unboundedly. `removeOnComplete` on the parent does NOT cascade to children or internal tracking keys.

**Mitigation:** Set `removeOnComplete` and `removeOnFail` on **every** child job individually:

```typescript
const FLOW_CHILD_DEFAULTS = {
  failParentOnFailure: true,
  removeOnComplete: { age: 3600, count: 200 }, // 1 hour or 200 jobs
  removeOnFail: { age: 86400, count: 1000 }, // 24 hours or 1000 jobs
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};
```

---

### MEDIUM: No Deduplication for Flow Parents

**GitHub Issue:** #3761 (OPEN, Feb 2026)

Deduplication was removed from flow parent jobs. The same logical flow can be enqueued multiple times.

**Mitigation:** Application-level deduplication using MongoDB `contentHash` or Redis `SET NX`:

```typescript
const lockKey = `flow-dedup:${indexId}:${contentHash}`;
const acquired = await redis.set(lockKey, '1', 'NX', 'EX', 3600);
if (!acquired) {
  logger.info(`Flow already in progress for ${contentHash}`);
  return;
}
```

---

## Scaling Challenges: Heavy I/O

### No Built-in Backpressure

BullMQ has **no mechanism to limit queue depth**. Jobs accumulate without bound when downstream services are slow.

**Scenario:**

```
User uploads 10,000 documents at once
→ FlowProducer creates 10,000 flows
→ 10,000 extraction jobs in queue
→ Docling service handles 5 concurrent
→ 9,995 jobs waiting in Redis
→ Redis memory grows linearly with queue depth
```

**Mitigation: Application-level backpressure**

```typescript
const MAX_QUEUE_DEPTH: Record<string, number> = {
  'search-extraction': 500,
  'search-enrichment': 1000,
  'search-embedding': 500,
  'search-knowledge-graph': 200,
};

async function checkBackpressure(queueName: string): Promise<void> {
  const queue = new Queue(queueName, { connection });
  const waitingCount = await queue.getWaitingCount();
  const maxDepth = MAX_QUEUE_DEPTH[queueName] ?? 500;

  if (waitingCount > maxDepth) {
    throw new BackpressureError(
      `Queue ${queueName} depth ${waitingCount} exceeds limit ${maxDepth}`,
      { retryAfterMs: 30_000 },
    );
  }
}
```

---

### Rate Limiting Is NOT Flow-Aware

BullMQ rate limiting is per-queue, global across all workers:

```typescript
limiter: { max: 10, duration: 60000 }  // 10 jobs per minute for entire queue
```

This cannot differentiate by tenant, API key, or flow instance.

**SearchAI Impact:** LLM rate limits are per-API-key, per-tenant:

```
Tenant A: Gemini API → 60 RPM
Tenant B: OpenAI API → 100 RPM
```

**Recommendation:** Keep the existing application-level rate limiting pattern (already implemented in multimodal-worker and visual-enrichment-worker). Do not rely on BullMQ limiter for per-tenant rate control.

---

### Connection Pool Exhaustion

Every BullMQ class consumes at least one Redis connection. Workers create an additional blocking connection.

**Per-pod connection estimate:**

```
20 queue producers         × 1 = 20 connections
20 workers                 × 2 = 40 connections (blocking + regular)
1 FlowProducer             × 1 = 1 connection
QueueEvents listeners      × 1 = ~5 connections
────────────────────────────────────────────────
Total per pod:               ~66 Redis connections

With 10 pods:  660 connections
With 50 pods:  3,300 connections
```

**Mitigation:**

- Share ioredis connections across Queue instances (SearchAI already does this via `getRedisConnection()`)
- Ensure FlowProducer shares the same connection
- Monitor Redis connection count: `INFO clients`
- AWS ElastiCache/MemoryDB: Check connection limits for your instance type

---

## Scaling Challenges: CPU-Intensive

### Event Loop Blocking → Stalled Jobs → Duplicate Processing

When CPU-intensive work blocks the Node.js event loop, BullMQ cannot renew the job lock. The job is marked stalled and re-queued — potentially running on **two workers simultaneously**.

**SearchAI Risk Assessment:**

| Worker             | CPU Intensity                    | Stall Risk | Lock Duration Needed |
| ------------------ | -------------------------------- | ---------- | -------------------- |
| docling-extraction | LOW (I/O to Docling service)     | LOW        | 10 min (large PDFs)  |
| page-processing    | MEDIUM (text/table extraction)   | MEDIUM     | 2 min                |
| enrichment         | LOW (LLM API calls)              | LOW        | 2 min                |
| kg-enrichment      | MEDIUM (Neo4j writes)            | MEDIUM     | 5 min                |
| knowledge-graph    | MEDIUM (Neo4j writes)            | MEDIUM     | 5 min                |
| embedding          | LOW (API calls)                  | LOW        | 3 min                |
| tree-building      | HIGH (hierarchical construction) | HIGH       | 5 min                |
| multimodal         | LOW (vision API calls)           | LOW        | 3 min                |

---

### Worker Thread Memory Leak

**GitHub Issue:** #2610 (OPEN, unresolved)

Using `useWorkerThreads: true` with file-path workers causes continuous memory growth until OOM (~4 hours to exhaust 8GB).

**Recommendation:** Do NOT use `useWorkerThreads: true`. Use function-reference workers (current SearchAI pattern) or child-process sandboxing:

```typescript
// ✅ SAFE: Function reference (current SearchAI pattern)
const worker = new Worker('queue', async (job) => {
  /* ... */
});

// ✅ SAFE: Child process sandbox (for CPU-heavy work)
const worker = new Worker('queue', '/path/to/processor.js', {
  useWorkerThreads: false, // Use child process, NOT worker threads
});

// ❌ DANGEROUS: Worker threads (memory leak)
const worker = new Worker('queue', '/path/to/processor.js', {
  useWorkerThreads: true, // Memory leak! Issue #2610
});
```

---

## Redis Constraints

### Single-Thread Bottleneck

BullMQ uses Lua scripts for atomic operations. Redis executes Lua on a single thread, serializing all queue operations.

**Per-document Lua script load:**

```
FlowProducer.add()         → 1 complex Lua script (creates parent + all children)
Worker picks up job        → 1 Lua script × 8 stages
Worker completes job       → 1 Lua script × 8 stages (parent notification)
Flow progression           → 1 Lua script per stage transition
────────────────────────────────────────────────────────────────
Total: ~25 Lua script executions per document
```

**At 100 docs/minute:** ~2,500 Lua executions/minute (well within limits)
**At 1,000 docs/minute:** ~25,000 Lua executions/minute (monitor carefully)
**Bottleneck threshold:** ~10K-15K Lua scripts/second on typical Redis

**Monitoring:** Watch `instantaneous_ops_per_sec` and `used_cpu_sys` in Redis INFO.

---

### Redis Cluster Does NOT Help BullMQ Performance

All operations for a single queue must hit the **same hash slot** on the **same node**. Flows are worse because all queues in a flow must share the same prefix.

```
❌ Redis Cluster for BullMQ performance
✅ Redis Cluster for memory distribution across independent queues
✅ Single large Redis instance (or replica set for HA) is better
```

**Recommendation:** Use a single Redis instance with sufficient memory. Add Redis Sentinel for high availability.

---

### Redis Memory Management

**Required configuration:**

```redis
# MANDATORY: Never evict BullMQ keys
maxmemory-policy noeviction

# Recommended: Enable AOF for durability
appendonly yes
appendfsync everysec
```

**Memory sizing:**

```
Per job: ~1-5 KB (varies with payload size)
Per queue event stream: ~200 bytes × maxLen entries

SearchAI estimate:
  20 queues × 10K docs/day × 8 stages = 1.6M jobs/day
  At ~2 KB/job with cleanup after 24h = ~3.2 GB peak
  Event streams: 20 × 1000 × 200 = ~4 MB

  Recommended minimum: 8 GB Redis
  With headroom: 16 GB Redis
```

**Event stream trimming:**

```typescript
// Set maxLen on every queue to prevent unbounded growth
const queue = new Queue(name, {
  connection: getRedisConnection(),
  streams: { events: { maxLen: 1000 } },
});
```

---

### DragonflyDB Compatibility Issues

DragonflyDB is marketed as a multi-threaded Redis alternative but has known issues with BullMQ:

- **Lua script undeclared key issues** (Issues #3760, #2463)
- **OOM during Lua execution** with large queues (Issue #3834)
- **`getStateV2` performance** (Issue #3764) — LPOS saturates CPU

**Recommendation:** Use standard Redis or AWS MemoryDB for production. Evaluate DragonflyDB only if Redis memory is the bottleneck and only after testing with SearchAI's workload.

---

## Distributed Environment Challenges

### Graceful Shutdown with Flows

**Problem:** Kubernetes pod termination can leave flow parents stuck.

```
SIGTERM received
→ worker.close() waits for active jobs
→ Long-running job (Docling: 5 min) exceeds terminationGracePeriodSeconds
→ SIGKILL sent
→ Job goes stale → eventually stalled → re-queued
→ Flow parent may get stuck
```

**BullMQ Limitation:** No AbortSignal support for in-flight jobs (Issues #3017, #632, both OPEN).

**Mitigation:**

```typescript
const SHUTDOWN_TIMEOUT_MS = 120_000; // 2 minutes

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, starting graceful shutdown`);

  // 1. Pause all workers (stop picking up new jobs)
  await Promise.all(allWorkers.map((w) => w.pause()));

  // 2. Wait for active jobs with timeout
  const closePromises = allWorkers.map((w) => w.close());

  await Promise.race([
    Promise.all(closePromises),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);

  logger.info('Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

**Kubernetes configuration:**

```yaml
spec:
  terminationGracePeriodSeconds: 180 # 3 minutes (match longest worker)
```

---

### Pod Autoscaling Interaction

- Scale-down can kill pods with active flow jobs
- KEDA can scale on queue depth but does not understand flow dependencies
- Scale-up creates connection surges to Redis

**Recommendations:**

- Configure `PodDisruptionBudget` to allow graceful shutdown
- Use KEDA `ScaledJob` for batch-style workers
- Rate-limit scale-up events to prevent Redis connection spikes

---

## SearchAI-Specific Configuration

### Current Worker Configuration (Baseline)

From `apps/search-ai/src/workers/shared.ts` and `apps/search-ai/src/workers/index.ts`:

| Worker               | Concurrency | Rate Limit      | Retry        | Notes                 |
| -------------------- | ----------- | --------------- | ------------ | --------------------- |
| ingestion            | 0.6× base   | —               | 3× / 5s exp  | Source scanning       |
| extraction           | 1× base     | —               | 3× / 5s exp  | Text extraction       |
| docling-extraction   | 1× base     | —               | 3× / 5s exp  | PDF via Docling       |
| page-processing      | 0.8× base   | —               | 3× / 5s exp  | Page-level processing |
| canonical-mapper     | 1× base     | —               | 3× / 5s exp  | Metadata mapping      |
| noise-detection      | 3 fixed     | —               | 3× / 5s exp  | Content filtering     |
| visual-enrichment    | 0.6× base   | 10/60s          | 3× / 5s exp  | Vision API            |
| enrichment           | 1× base     | —               | 2× / 10s exp | Entity extraction     |
| kg-enrichment        | 0.5× base   | —               | 2× / 10s exp | Neo4j intensive       |
| knowledge-graph      | 0.5× base   | —               | 2× / 10s exp | Neo4j writes          |
| multimodal           | 0.4× base   | 60/min (config) | 2× / 10s exp | Vision API            |
| embedding            | 0.6× base   | —               | 2× / 10s exp | Embedding API         |
| tree-building        | 1 dynamic   | —               | 3× / 5s exp  | LLM intensive         |
| question-synthesis   | 1 dynamic   | —               | 3× / 5s exp  | LLM intensive         |
| scope-classification | 1 dynamic   | —               | 3× / 5s exp  | LLM intensive         |

**Base concurrency:** `INGESTION_MAX_CONCURRENT_JOBS` env var (default: 5)

---

### Recommended Per-Worker Lock Duration

The current `createWorkerOptions` does not set `lockDuration` (defaults to BullMQ's 30s). This is too short for several workers.

**Recommended settings when using flows:**

```typescript
function getWorkerLockSettings(stage: string): { lockDuration: number; stalledInterval: number } {
  switch (stage) {
    // CPU/long-running stages
    case 'search-docling-extraction':
      return { lockDuration: 600_000, stalledInterval: 300_000 }; // 10 min / 5 min
    case 'search-knowledge-graph':
    case 'search-kg-enrichment':
    case 'search-tree-building':
      return { lockDuration: 300_000, stalledInterval: 150_000 }; // 5 min / 2.5 min

    // I/O-bound LLM stages
    case 'search-enrichment':
    case 'search-question-synthesis':
    case 'search-scope-classification':
      return { lockDuration: 120_000, stalledInterval: 60_000 }; // 2 min / 1 min

    // Embedding/multimodal (batch API calls)
    case 'search-embedding':
    case 'search-multimodal':
    case 'search-visual-enrichment':
      return { lockDuration: 180_000, stalledInterval: 90_000 }; // 3 min / 1.5 min

    // Fast stages
    default:
      return { lockDuration: 60_000, stalledInterval: 30_000 }; // 1 min / 30s
  }
}
```

---

### Flow Child Job Defaults

Every child job in a flow MUST have these options:

```typescript
export const FLOW_CHILD_DEFAULTS: JobsOptions = {
  // CRITICAL: Define failure behavior (without this, parent waits forever)
  failParentOnFailure: true,

  // CRITICAL: Prevent Redis memory accumulation
  removeOnComplete: { age: 3600, count: 200 },
  removeOnFail: { age: 86400, count: 1000 },

  // Retry with exponential backoff
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};
```

---

### Circuit Breaker for Flow Failures

Implement a circuit breaker that falls back to legacy (non-flow) pipeline when flows are failing:

```typescript
class FlowCircuitBreaker {
  private failureCount = 0;
  private lastFailure: Date | null = null;
  private readonly threshold = 3;
  private readonly windowMs = 5 * 60 * 1000; // 5 minutes

  async executeWithFallback<T>(flowFn: () => Promise<T>, legacyFn: () => Promise<T>): Promise<T> {
    if (this.isOpen()) {
      logger.warn('Flow circuit breaker OPEN, using legacy pipeline');
      return legacyFn();
    }

    try {
      const result = await flowFn();
      this.reset();
      return result;
    } catch (error) {
      this.recordFailure();
      logger.error('Flow failed, falling back to legacy', {
        error: error instanceof Error ? error.message : String(error),
        failureCount: this.failureCount,
      });
      return legacyFn();
    }
  }

  private isOpen(): boolean {
    if (this.failureCount >= this.threshold && this.lastFailure) {
      return Date.now() - this.lastFailure.getTime() < this.windowMs;
    }
    return false;
  }

  private recordFailure(): void {
    this.failureCount++;
    this.lastFailure = new Date();
  }

  private reset(): void {
    this.failureCount = 0;
    this.lastFailure = null;
  }
}
```

---

## Anti-Patterns

| Anti-Pattern                                         | Problem                                            | Solution                                        |
| ---------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| Not setting child failure options                    | Parent stuck in `waiting-children` forever         | Always set `failParentOnFailure` on every child |
| `removeOnComplete` only on parent                    | Children accumulate in Redis                       | Set on every child individually                 |
| Large job payloads in `job.data`                     | Redis memory bloat                                 | Store data in MongoDB, pass IDs in job data     |
| Calling `getState()` frequently                      | O(N) CPU on queue size                             | Use events or `QueueEvents` instead             |
| Not configuring `maxmemory-policy: noeviction`       | Silent queue corruption — Redis evicts BullMQ keys | Set in Redis config (MANDATORY)                 |
| Using `useWorkerThreads: true`                       | Memory leak (Issue #2610)                          | Use function references or child processes      |
| Default `lockDuration` (30s) for long jobs           | Stalled jobs → duplicate processing                | Per-worker lock duration                        |
| Adding jobs inside event handlers                    | Events can be lost; jobs may not be created        | Add child jobs inside processor functions       |
| No error handlers on workers/queues                  | Unhandled errors crash the process                 | Always attach `.on('error', handler)`           |
| Relying on BullMQ limiter for per-tenant rate limits | Limiter is global per-queue, not per-tenant        | Application-level rate limiting                 |
| Using Redis Cluster for BullMQ performance           | No benefit — all ops serialize on same hash slot   | Single Redis instance                           |
| Not validating `FlowProducer.add()` result           | Zombie flows during Redis maintenance              | Verify parent job exists after add              |

---

## Production Checklist

### Before Deploying Flows

- [ ] BullMQ version >= 5.7.2 (stalled job parent notification fix)
- [ ] `failParentOnFailure: true` on every child job
- [ ] `removeOnComplete` and `removeOnFail` on every child job
- [ ] Per-worker `lockDuration` set (not default 30s)
- [ ] `maxStalledCount: 2` on all workers
- [ ] Event stream `maxLen` set on all queues
- [ ] Redis `maxmemory-policy` = `noeviction`
- [ ] FlowProducer.add() wrapped with validation
- [ ] Circuit breaker implemented with legacy fallback
- [ ] Backpressure checks before adding flows
- [ ] Graceful shutdown handler with timeout
- [ ] Kubernetes `terminationGracePeriodSeconds` >= 180s
- [ ] Application-level deduplication before flow creation
- [ ] Redis memory sized for peak load (see sizing guide above)

### Monitoring Setup

- [ ] Queue depth per state (waiting, active, waiting-children, failed)
- [ ] Flow parent completion rate and duration
- [ ] Stalled job rate per worker type
- [ ] Redis memory usage and key count
- [ ] Redis `instantaneous_ops_per_sec`
- [ ] Worker connection count per pod
- [ ] Flow vs legacy pipeline usage split

---

## Monitoring & Alerting

### Key Metrics

```yaml
# Queue health
searchai_queue_depth{queue, state}          # waiting, active, delayed, failed
searchai_queue_waiting_children_count       # Flow parents waiting

# Flow health
searchai_flow_created_total{pipeline}       # Flows created
searchai_flow_completed_total{pipeline}     # Flows completed
searchai_flow_failed_total{pipeline}        # Flows failed
searchai_flow_duration_seconds{pipeline}    # Flow completion time

# Worker health
searchai_job_duration_seconds{stage}        # Per-stage duration
searchai_job_stalled_total{stage}           # Stalled job count
searchai_worker_connections{pod}            # Redis connections per pod

# Redis health
redis_memory_used_bytes                     # Redis memory
redis_connected_clients                     # Connection count
redis_instantaneous_ops_per_sec             # Operations throughput
redis_used_cpu_sys                          # CPU usage (Lua scripts)
```

### Alert Rules

```yaml
alerts:
  - name: FlowParentStuck
    condition: searchai_queue_waiting_children_count > 100
    for: 10m
    severity: critical
    description: 'Flow parents stuck in waiting-children state'

  - name: QueueBacklog
    condition: searchai_queue_depth{state="waiting"} > 1000
    for: 5m
    severity: warning
    description: 'Queue backlog exceeding threshold'

  - name: HighStallRate
    condition: rate(searchai_job_stalled_total[5m]) > 0.1
    severity: warning
    description: 'Jobs stalling — check lockDuration and worker CPU'

  - name: RedisMemoryHigh
    condition: redis_memory_used_bytes / redis_maxmemory > 0.85
    severity: critical
    description: 'Redis memory above 85% — risk of OOM'

  - name: FlowFailureSpike
    condition: rate(searchai_flow_failed_total[5m]) > 0.05
    severity: warning
    description: 'Flow failure rate above 5%'

  - name: RedisSlowLog
    condition: redis_slowlog_length > 10
    for: 5m
    severity: warning
    description: 'Redis slow queries detected — check Lua script load'
```

---

## Troubleshooting Runbook

### Problem: Flow Parents Stuck in `waiting-children`

**Symptoms:** Flows not completing, `waiting-children` count growing

**Diagnosis:**

```bash
# Check waiting-children count
redis-cli ZCARD bull:<queue>:waiting-children

# Inspect a stuck parent
redis-cli HGETALL bull:<queue>:<parentJobId>

# Check if children exist
redis-cli SMEMBERS bull:<queue>:<parentJobId>:dependencies
```

**Resolution:**

1. Check if children failed without `failParentOnFailure` set
2. Check BullMQ version (>= 5.7.2 for stall fix)
3. Manually move stuck parents: `await job.moveToFailed(new Error('manual'), 'manual')`
4. Verify `lockDuration` is sufficient for long-running workers

---

### Problem: Redis Memory Growing Unboundedly

**Symptoms:** Redis memory increasing over days/weeks

**Diagnosis:**

```bash
# Check key count by pattern
redis-cli --scan --pattern 'bull:*:processed' | wc -l
redis-cli --scan --pattern 'bull:*:events' | wc -l

# Check largest keys
redis-cli --bigkeys

# Memory usage of specific key
redis-cli MEMORY USAGE bull:<queue>:events
```

**Resolution:**

1. Verify `removeOnComplete` and `removeOnFail` set on all child jobs
2. Trim event streams: `await queue.trimEvents(1000)`
3. Clean up orphaned flow keys
4. Check for `*:processed` key accumulation (Issue #1572)

---

### Problem: Jobs Processing Twice (Stall-Related)

**Symptoms:** Duplicate entries in MongoDB, double LLM charges

**Diagnosis:**

```bash
# Check stalled job events
redis-cli XRANGE bull:<queue>:events - + COUNT 100
# Look for 'stalled' events
```

**Resolution:**

1. Increase `lockDuration` for the affected worker
2. Decrease `stalledInterval` (check more frequently)
3. Reduce worker concurrency if CPU-bound
4. Consider sandboxed processors for CPU-intensive work
5. Add idempotency checks in worker (MongoDB `contentHash`)

---

### Problem: FlowProducer.add() Returns but Jobs Don't Exist

**Symptoms:** API returns flow ID but no jobs appear in queues

**Diagnosis:**

```bash
# Check if Redis was in READONLY mode
redis-cli INFO replication
# Look for role:slave or readonly

# Check if job exists
redis-cli EXISTS bull:<queue>:<jobId>
```

**Resolution:**

1. Implement FlowProducer validation wrapper (see Known Issues section)
2. Check managed Redis maintenance windows
3. Add alerting on flow creation validation failures

---

## References

### BullMQ Documentation

- [BullMQ Flows Guide](https://docs.bullmq.io/guide/flows)
- [BullMQ Best Practices](https://docs.bullmq.io/guide/going-to-production)

### GitHub Issues Referenced

**Verified OPEN as of 2026-03-04:**

| Issue | Title                             | Status   | Last Activity | Severity | Notes                                                                                             |
| ----- | --------------------------------- | -------- | ------------- | -------- | ------------------------------------------------------------------------------------------------- |
| #3851 | FlowProducer.add() fails silently | **OPEN** | 2026-03-04    | CRITICAL | Fresh — no fix yet. Must wrap with validation                                                     |
| #3761 | No deduplication for flow parents | **OPEN** | 2026-02-20    | MEDIUM   | Assigned to `roggervalf`, fix expected in weeks                                                   |
| #2610 | Worker thread memory leak         | **OPEN** | 2024-06-15    | HIGH     | Stale 21 months, no assignee. Don't use `useWorkerThreads: true`                                  |
| #3017 | AbortSignal for graceful shutdown | **OPEN** | 2025-07-07    | MEDIUM   | Feature request, 3 thumbs up                                                                      |
| #632  | Stop/abort a running job          | **OPEN** | 2026-01-19    | MEDIUM   | Open since Jul 2021 (4.5 years), 19 thumbs up. Won't be fixed soon — implement own shutdown logic |
| #1099 | Duplicate flow race condition     | **OPEN** | 2022-02-25    | LOW      | Stale 4 years, abandoned. Must deduplicate at application level                                   |

**Key Implications:**

- **#3851** (silent failure): No upstream fix coming soon — validation wrapper is mandatory
- **#2610** (memory leak): Stale with no assignee — treat `useWorkerThreads: true` as permanently broken
- **#632** (abort job): 4.5 years open with strong demand — BullMQ won't add this. Own graceful shutdown required
- **#3761** (deduplication): Only issue being actively worked on — may be fixed upstream soon
- **#1099** (duplicate flow): Abandoned — application-level deduplication via MongoDB `contentHash` is the only path

**Previously FIXED issues (verified):**

- #3362, #3122, #2464, #800: Parent stuck in waiting-children (FIXED in various versions, requires >= v5.7.2)
- #1572: Flow processed keys accumulation (documented workaround: set removeOnComplete on every child)
- #3087: Event stream memory growth (workaround: set streams.events.maxLen)
- #3834: Redis/DragonflyDB OOM during Lua execution (DragonflyDB-specific)

### SearchAI RFCs

- RFC-004: Pluggable Pipeline Architecture
- RFC-005: Job Tracking Architecture
- RFC-006: Job Tracking + BullMQ Flows Integration

### SearchAI Source Files

- `apps/search-ai/src/workers/shared.ts` — Redis connection, worker options
- `apps/search-ai/src/workers/index.ts` — Worker initialization, concurrency
- `apps/search-ai/src/queues/index.ts` — Queue creation
- `packages/search-ai-sdk/src/constants.ts` — Queue name constants
- `apps/search-ai/src/config/index.ts` — Configuration schema

---

## Changelog

| Date       | Changes                                                                                                    | Author        |
| ---------- | ---------------------------------------------------------------------------------------------------------- | ------------- |
| 2026-03-04 | Initial document — known issues, scaling challenges, configuration guide                                   | Platform Team |
| 2026-03-04 | Verified all 6 open GitHub issues still OPEN. Added status table with last-activity dates and implications | Platform Team |

---

**END OF DOCUMENT**
